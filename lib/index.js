/**
 * dsh-session-truncate — host half.
 *
 * Per-session, time-based context truncation for DeepSeek Harness.
 *
 * Motivation: one Session can be long-lived (an IM bridge keeps feeding the
 * same session from a phone). Unrelated tasks then share one context and
 * contaminate each other. This plugin gives a session a switch: once it is
 * enabled, the first turn that starts more than `hours` after the previous cut
 * drops the whole older conversation — without asking a model for a summary.
 *
 * How the drop is represented (durable log, not a hack):
 *
 *   compaction/start      { compactionId, turn }
 *   compaction/summary    { …, summary:[{type:'text'}], shadowedRange, shadowedSeqs, shadowedTokenCount }
 *   user/message          checkpoint over `surfaceOp:{op:'replace',startSeq,endSeq}`,
 *                         `sourceEventSeqs` covering every shadowed surface node
 *   compaction/end        { compactionId, turn }
 *
 * That is exactly the transaction shape the built-in compaction backends write,
 * so: the model receives only the checkpoint, the Chat transcript renders the
 * "compacted" fold card instead of losing rows, and billion-context/ACP keeps
 * working on the new surface.
 *
 * Surface safety rules honoured (see @deepseek-ai/dsh-session validation):
 *   - node 0 holding a system/message is never part of the replacement;
 *   - both replacement boundaries are tool-pairing balanced;
 *   - sourceEventSeqs covers every shadowed surface node, all earlier than the
 *     checkpoint's own seq.
 *
 * State: `$DSH_HOME/session-truncate.json` (default `~/.dsh/session-truncate.json`),
 * a flat map keyed by Session id so the switch survives restarts.
 *
 * Controls:
 *   - slash command `/truncate …` (works for every composed human-command adapter);
 *   - the same command typed as a message (`/truncate on 4`) for bridges that
 *     prompt the session directly instead of going through the command registry.
 *
 * @module dsh-session-truncate
 */

import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'session-turncate';
export const inject = ['commands', 'webServer', 'sessions', 'agents'];

const STATE_FILE_NAME = 'session-truncate.json';
const STATE_SCHEMA_VERSION = 1;

const DEFAULT_HOURS = 4;
const MIN_HOURS = 0;
const MAX_HOURS = 24;

/** Panel HTTP endpoint (client -> host). */
const API_PATH = '/session-turncate/api';

/** Framing that turns the replacement message into established background. */
const CHECKPOINT_PREAMBLE = [
  '这是一条按时间策略自动生成的上下文分界说明。',
  '更早的对话已经整段移除（未生成摘要），请不要假设、复原或复述被移除的内容。',
  '请只依据这条说明之后的消息处理当前任务。',
].join('');

const HOURS_PATTERN = /^\d+(?:\.\d+)?$/;

/** A control line must start with one of these to be read out of message text. */
const MESSAGE_CONTROL_PREFIX = /^\s*[\/!／]/u;

const CONTROL_PATTERN = /^\s*[\/!／]?\s*(?:truncate|截断|cut)(?=\s|$|[^\p{L}\p{N}_])\s*(.*)$/iu;

/* ------------------------------------------------------------------ state -- */

function resolveStatePath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh');
  return join(home, STATE_FILE_NAME);
}

/**
 * Read the profile state. A corrupt file is copied aside as `.corrupt` before
 * the table is reset, so a half-written file never silently erases every switch.
 */
function readState(ctx) {
  const target = resolveStatePath();
  let raw;
  try {
    raw = readFileSync(target, 'utf8');
  } catch {
    return { version: STATE_SCHEMA_VERSION, sessions: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)) {
      return { version: STATE_SCHEMA_VERSION, sessions: parsed.sessions };
    }
  } catch {
    /* fall through to the quarantine below */
  }
  try {
    copyFileSync(target, `${target}.corrupt`);
  } catch {
    /* best effort: the unreadable original stays untouched */
  }
  ctx?.logger?.warn?.(`session-turncate: ${target} is unreadable; reset (original kept as .corrupt)`);
  return { version: STATE_SCHEMA_VERSION, sessions: {} };
}

/** Persist atomically: a crash mid-write must never truncate the table. */
function writeState(ctx, state) {
  const target = resolveStatePath();
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ version: STATE_SCHEMA_VERSION, sessions: state.sessions }, null, 2), 'utf8');
    renameSync(tmp, target);
    return true;
  } catch (error) {
    ctx.logger?.warn?.(`session-turncate: failed to save ${target}: ${error?.message ?? error}`);
    return false;
  }
}

function normalizeHours(value, fallback) {
  const hours = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(hours) || hours < MIN_HOURS) return fallback;
  return Math.min(hours, MAX_HOURS);
}

function normalizeKeep(value) {
  const keep = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(keep) || keep < 0) return 0;
  return keep;
}

function ensureEntry(state, config, sessionId) {
  const existing = state.sessions[sessionId];
  if (existing && typeof existing === 'object') {
    existing.enabled = existing.enabled === true;
    existing.hours = normalizeHours(existing.hours, normalizeHours(config?.hours, DEFAULT_HOURS));
    existing.keepRecentNodes = normalizeKeep(existing.keepRecentNodes ?? config?.keepRecentNodes);
    if (typeof existing.lastActiveMs !== 'number' || !Number.isFinite(existing.lastActiveMs)) {
      existing.lastActiveMs = typeof existing.anchorMs === 'number' && Number.isFinite(existing.anchorMs) ? existing.anchorMs : null;
    }
    delete existing.anchorMs;
    if (typeof existing.lastCutMs !== 'number' || !Number.isFinite(existing.lastCutMs)) existing.lastCutMs = null;
    if (typeof existing.cutCount !== 'number' || !Number.isInteger(existing.cutCount)) existing.cutCount = 0;
    existing.pendingCut = existing.pendingCut === true;
    return existing;
  }
  const entry = {
    enabled: config?.enabledByDefault === true,
    hours: normalizeHours(config?.hours, DEFAULT_HOURS),
    keepRecentNodes: normalizeKeep(config?.keepRecentNodes),
    lastActiveMs: null,
    lastCutMs: null,
    cutCount: 0,
    pendingCut: false,
  };
  state.sessions[sessionId] = entry;
  return entry;
}

/* ---------------------------------------------------------------- surface -- */

/** How one surface event changes the in-progress tool-call count. */
function eventDelta(event) {
  if (event.type === 'assistant/message') {
    const content = event.data?.message?.content;
    return Array.isArray(content) ? content.filter((block) => block && block.type === 'tool-call').length : 0;
  }
  if (event.type === 'tool/result') return -1;
  return 0;
}

/**
 * Cut balance for the current surface: `cuts[i]` is the balance immediately
 * before surface node i, `cuts[i+1]` the balance immediately after it.
 */
function balanceCuts(session) {
  const nodes = [...session.surface.nodes];
  const cuts = [true];
  let open = 0;
  for (const seq of nodes) {
    const event = session.eventAt(seq);
    if (event === undefined || event.seq !== seq) throw new Error(`surface seq ${seq} has no matching session event`);
    open += eventDelta(event);
    if (open < 0) throw new Error(`surface seq ${seq} holds a tool/result without a matching tool-call`);
    cuts.push(open === 0);
  }
  return { nodes, cuts };
}

function approximateTokens(session, seqs) {
  let chars = 0;
  for (const seq of seqs) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    try {
      chars += JSON.stringify(event.data).length;
    } catch {
      /* unserializable payload contributes nothing */
    }
  }
  return Math.max(0, Math.round(chars / 2.5));
}

/**
 * The turn currently open in the log: its number and the seq of its
 * `turn/start`. Surface nodes at or after that seq belong to the running turn.
 * @returns {{turn: number|null, seq: number}|null}
 */
function openTurnStart(session) {
  let depth = 0;
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    if (event.type === 'turn/end') depth += 1;
    else if (event.type === 'turn/start') {
      if (depth > 0) depth -= 1;
      else return { turn: typeof event.data?.turn === 'number' ? event.data.turn : null, seq };
    }
  }
  return null;
}

/**
 * Whether a compaction transaction is still open (a `compaction/start` with no
 * closing `compaction/end`). A second transaction must never interleave with it.
 */
function hasOpenCompaction(session) {
  const open = new Set();
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    if (event.type === 'compaction/start') open.add(event.data?.compactionId);
    else if (event.type === 'compaction/end') open.delete(event.data?.compactionId);
  }
  return open.size > 0;
}

/**
 * Drop the older conversation of one session and record the boundary.
 * @returns {{shadowed:number, tokens:number, summarySeq:number}|null} null when
 *   there is nothing safe to drop.
 */
function truncateSession(ctx, session, { keepRecentNodes, turn, label }) {
  if (hasOpenCompaction(session)) return null;
  const { nodes, cuts } = balanceCuts(session);
  if (nodes.length === 0) return null;

  const running = openTurnStart(session);
  const head = session.eventAt(nodes[0]);
  const firstIdx = head?.type === 'system/message' ? 1 : 0;
  let lastAllowed = nodes.length - 1 - Math.max(0, Math.trunc(Number(keepRecentNodes) || 0));
  if (running !== null) {
    /* Never drop anything the running turn has already produced. */
    let lastBeforeTurn = -1;
    for (let i = 0; i <= lastAllowed; i += 1) if (nodes[i] < running.seq) lastBeforeTurn = i;
    lastAllowed = lastBeforeTurn;
  }
  if (lastAllowed < firstIdx) return null;
  if (cuts[firstIdx] !== true) return null;

  let endIdx = -1;
  for (let i = firstIdx; i <= lastAllowed; i += 1) {
    if (cuts[i + 1] === true) endIdx = i;
  }
  if (endIdx < firstIdx) return null;

  const start = nodes[firstIdx];
  const end = nodes[endIdx];
  const shadowedSeqs = nodes.slice(firstIdx, endIdx + 1);
  if (shadowedSeqs.length === 0) return null;

  const tokens = approximateTokens(session, shadowedSeqs);
  const now = Date.now();
  const when = new Date(now).toLocaleString('zh-CN', { hour12: false });
  const summaryText = `⏱ 定时上下文截断：${when} 之前的 ${shadowedSeqs.length} 条历史记录已按时间策略移除（约 ${tokens} tokens），未生成摘要。`;
  const checkpointText = `${CHECKPOINT_PREAMBLE}\n\n[已截断 ${shadowedSeqs.length} 条历史记录，约 ${tokens} tokens，截断时间 ${when}${label ? `，触发：${label}` : ''}]`;

  const compactionId = randomUUID();
  const resolvedTurn = typeof turn === 'number' ? turn : running?.turn ?? null;
  /* The key must exist and be null-or-count: the format validator re-reads it
     on load and rejects an absent key (undefined is not null). */
  const lifecycle = { compactionId, turn: resolvedTurn ?? null };

  const startEvent = session.append('compaction/start', lifecycle);
  let summarySeq = -1;
  let failure = null;
  try {
    const summaryEvent = session.append('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: summaryText }],
      shadowedRange: { start, end },
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount: tokens,
      provider: 'session-truncate',
      model: 'time-truncation',
    });
    summarySeq = summaryEvent.seq;
    session.append(
      'user/message',
      {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: checkpointText }],
        source: { kind: 'compact-checkpoint', compactionId },
      },
      {
        surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
        sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
      },
    );
  } catch (error) {
    failure = error;
  }
  if (failure === null) {
    session.append('compaction/end', lifecycle);
  } else {
    try {
      session.append('compaction/end', { ...lifecycle, error: `${failure?.name ?? 'Error'}: ${failure?.message ?? failure}` });
    } catch (closeError) {
      ctx.logger?.warn?.(`session-turncate: could not close compaction ${compactionId}: ${closeError?.message ?? closeError}`);
    }
    ctx.logger?.warn?.(`session-turncate: truncation failed in session ${session.id}: ${failure?.message ?? failure}`);
    return null;
  }

  ctx.logger?.info?.(
    `session-turncate: dropped ${shadowedSeqs.length} surface nodes (seqs ${start}-${end}, ~${tokens} tokens) in session ${session.id}`,
  );
  return { shadowed: shadowedSeqs.length, tokens, summarySeq };
}

/* --------------------------------------------------------------- controls -- */

/**
 * Extract the payload of a truncation control line, or null when the text is
 * not one. Bridges that prompt the session directly never see the command
 * registry, so the same line is also recognized as message text.
 * @param {string} text - one message's plain text.
 * @returns {string|null}
 */
function controlPayload(text) {
  const match = CONTROL_PATTERN.exec(text);
  return match === null ? null : match[1] ?? '';
}

function parseControl(raw) {
  const text = String(raw ?? '').trim();
  if (text.length === 0) return { kind: 'status' };
  const [head, ...rest] = text.split(/\s+/u);
  const verb = head.toLowerCase();
  const arg = rest.join(' ').trim();
  if (verb === 'on' || verb === 'enable' || verb === '开' || verb === '开启') {
    return { kind: 'on', hours: arg.length === 0 ? null : HOURS_PATTERN.test(arg) ? Number(arg) : arg };
  }
  if (verb === 'off' || verb === 'disable' || verb === '关' || verb === '关闭') return { kind: 'off' };
  if (verb === 'now' || verb === '立即' || verb === 'now!') return { kind: 'now' };
  if (verb === 'status' || verb === '状态') return { kind: 'status' };
  return { kind: 'unknown', text };
}

const SAVE_FAILED = { kind: 'error', text: '状态写入失败（磁盘不可写？），本次操作未生效。' };

function formatStamp(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function describeEntry(entry) {
  const state = entry.enabled ? '已开启' : '已关闭';
  const idle = typeof entry.lastActiveMs === 'number' && Number.isFinite(entry.lastActiveMs) ? entry.lastActiveMs : null;
  const armed = entry.enabled && entry.hours > 0;
  const whenReady = idle === null || !armed
    ? '（等下一次输入后开始计时）'
    : formatStamp(idle + entry.hours * 3_600_000);
  const queued = entry.pendingCut === true ? ' · 已排队：下一次输入时立即截断' : '';
  return `${state} · 间隔 ${entry.hours} 小时 · 下次截断不早于 ${whenReady}${queued} · 已截断 ${entry.cutCount} 次`;
}

function applyControl(ctx, config, session, raw, { turn } = {}) {
  const control = parseControl(raw);
  const state = readState(ctx);
  const entry = ensureEntry(state, config, session.id);

  switch (control.kind) {
    case 'on': {
      if (control.hours !== null && (!Number.isFinite(control.hours) || control.hours < MIN_HOURS)) {
        return { kind: 'error', text: `小时数无效：${String(control.hours)}（需 ${MIN_HOURS}–${MAX_HOURS}）` };
      }
      entry.enabled = true;
      if (control.hours !== null) entry.hours = normalizeHours(control.hours, DEFAULT_HOURS);
      entry.lastActiveMs = Date.now();
      entry.pendingCut = false;
      if (!writeState(ctx, state)) return SAVE_FAILED;
      return { kind: 'success', text: `已开启定时截断：每 ${entry.hours} 小时把更早的上下文整段丢弃（无摘要）。` };
    }
    case 'off': {
      entry.enabled = false;
      entry.lastActiveMs = null;
      entry.pendingCut = false;
      if (!writeState(ctx, state)) return SAVE_FAILED;
      return { kind: 'success', text: '已关闭定时截断。' };
    }
    case 'now': {
      const result = truncateSession(ctx, session, {
        keepRecentNodes: entry.keepRecentNodes,
        turn,
        label: '手动立即截断',
      });
      if (result === null) return { kind: 'success', text: '没有可安全截断的历史。' };
      entry.lastActiveMs = Date.now();
      entry.lastCutMs = entry.lastActiveMs;
      entry.pendingCut = false;
      entry.cutCount += 1;
      if (!writeState(ctx, state)) return SAVE_FAILED;
      return { kind: 'success', text: `已截断 ${result.shadowed} 条历史记录（约 ${result.tokens} tokens）。`, sourceEventSeq: result.summarySeq };
    }
    case 'status':
      return { kind: 'success', text: describeEntry(entry) };
    default:
      return { kind: 'error', text: '用法：/truncate [on [小时] | off | now | status]' };
  }
}

/* ----------------------------------------------------------------- policy -- */

/**
 * Run the time policy for one session.
 * @returns {string|null} a human-readable note when a cut happened, else null.
 */
function maybeAutoTruncate(ctx, config, agent, turn) {
  const session = agent?.session;
  if (session === undefined || session === null) return null;
  const state = readState(ctx);
  const entry = ensureEntry(state, config, session.id);
  const now = Date.now();
  const lastActiveMs = typeof entry.lastActiveMs === 'number' && Number.isFinite(entry.lastActiveMs) ? entry.lastActiveMs : null;

  /* A panel request that could not reach a live session is queued here and
     drained on the next step, where the session is guaranteed to exist. */
  if (entry.pendingCut === true) {
    entry.pendingCut = false;
    entry.lastActiveMs = now;
    entry.lastCutMs = now;
    const queued = truncateSession(ctx, session, {
      keepRecentNodes: entry.keepRecentNodes,
      turn,
      label: '排队立即截断',
    });
    if (queued !== null) entry.cutCount += 1;
    writeState(ctx, state);
    if (queued === null) return '已执行排队的截断：当前没有可安全截断的历史。';
    return `已按排队请求截断 ${queued.shadowed} 条更早的对话，约 ${queued.tokens} tokens，未生成摘要。`;
  }

  /* The idle clock is persisted at most once a minute: writing on every step
     would hammer the state file during a chatty bridge. */
  const minuteBucket = Math.floor(now / 60_000);
  const bucketChanged = lastActiveMs === null || Math.floor(lastActiveMs / 60_000) !== minuteBucket;
  entry.lastActiveMs = now;
  const persistIdle = () => {
    if (bucketChanged) writeState(ctx, state);
  };

  if (!entry.enabled || entry.hours <= 0) {
    persistIdle();
    return null;
  }
  if (lastActiveMs === null || now - lastActiveMs < entry.hours * 3_600_000) {
    persistIdle();
    return null;
  }

  const result = truncateSession(ctx, session, {
    keepRecentNodes: entry.keepRecentNodes,
    turn,
    label: `空闲 ${entry.hours}h`,
  });
  entry.lastCutMs = now;
  if (result !== null) entry.cutCount += 1;
  writeState(ctx, state);
  if (result === null) return null;
  return `已按空闲策略（无输入超过 ${entry.hours} 小时）截断 ${result.shadowed} 条更早的对话，约 ${result.tokens} tokens，未生成摘要。`;
}

/* -------------------------------------------------------------------- api -- */

function stateSnapshot(entry) {
  const lastActiveMs = typeof entry.lastActiveMs === 'number' && Number.isFinite(entry.lastActiveMs) ? entry.lastActiveMs : null;
  const hours = typeof entry.hours === 'number' && Number.isFinite(entry.hours) ? entry.hours : 0;
  return {
    enabled: entry.enabled === true,
    hours: entry.hours,
    lastActiveMs,
    nextCutMs: lastActiveMs === null || hours <= 0 ? null : lastActiveMs + hours * 3_600_000,
    pendingCut: entry.pendingCut === true,
    lastCutMs: typeof entry.lastCutMs === 'number' ? entry.lastCutMs : null,
    cutCount: Number.isInteger(entry.cutCount) ? entry.cutCount : 0,
  };
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** Same-origin or loopback only: the endpoint flips a switch per session. */
function requestAllowed(req) {
  if (isLoopback(req?.socket?.remoteAddress)) return true;
  const origin = req?.headers?.origin;
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return true;
  if (origin.startsWith('app://')) return true;
  try {
    return new URL(origin).host === req?.headers?.host;
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64_000) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/** Resolve a live Session for the panel: sessions.get first, agents as fallback. */
async function liveSession(ctx, sessionId) {
  try {
    if (typeof ctx.sessions?.get === 'function') {
      const got = ctx.sessions.get(sessionId);
      const session = got !== null && typeof got?.then === 'function' ? await got : got;
      if (session !== null && typeof session === 'object') return session;
    }
  } catch { /* fall through to the agent scan */ }
  try {
    if (typeof ctx.sessions?.list === 'function') {
      const listed = ctx.sessions.list();
      const snapshot = listed !== null && typeof listed?.then === 'function' ? await listed : listed;
      for (const candidate of Array.isArray(snapshot) ? snapshot : []) {
        if (candidate?.id === sessionId) return candidate;
        if (candidate?.session?.id === sessionId) return candidate.session;
      }
    }
  } catch { /* fall through to the agent scan */ }
  try {
    const agents = typeof ctx.agents?.list === 'function' ? ctx.agents.list() : [];
    for (const agent of Array.isArray(agents) ? agents : []) {
      if (agent?.session?.id === sessionId) return agent.session;
    }
  } catch { /* no live session after all */ }
  return null;
}

/**
 * Panel API. `status` reads one session entry, `set` writes the switch and the
 * hour budget, `cut` truncates immediately.
 */
async function handleApi(ctx, config, req, res) {
  if (!requestAllowed(req)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }
  const body = req.method === 'POST' ? await readJsonBody(req) : {};
  if (body === null) {
    sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON。' });
    return;
  }
  const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : null;
  if (sessionId === null) {
    sendJson(res, 400, { ok: false, error: '缺少 sessionId。' });
    return;
  }
  const op = typeof body.op === 'string' && body.op !== '' ? body.op : 'status';

  if (op === 'status') {
    const entry = ensureEntry(readState(ctx), config, sessionId);
    sendJson(res, 200, { ok: true, state: stateSnapshot(entry) });
    return;
  }

  if (op === 'set') {
    const state = readState(ctx);
    const entry = ensureEntry(state, config, sessionId);
    if (typeof body.enabled === 'boolean') entry.enabled = body.enabled;
    if (body.hours !== undefined && body.hours !== null) {
      const hours = Number(body.hours);
      if (!Number.isFinite(hours) || hours < MIN_HOURS || hours > MAX_HOURS) {
        sendJson(res, 400, { ok: false, error: `小时数必须在 ${MIN_HOURS} 到 ${MAX_HOURS} 之间。` });
        return;
      }
      entry.hours = hours;
    }
    entry.lastActiveMs = Date.now();
    if (!writeState(ctx, state)) {
      sendJson(res, 500, { ok: false, error: '状态写入失败，本次修改未保存。' });
      return;
    }
    sendJson(res, 200, { ok: true, state: stateSnapshot(entry) });
    return;
  }

  if (op === 'cut') {
    const session = await liveSession(ctx, sessionId);
    if (session === null) {
      const queuedState = readState(ctx);
      const queuedEntry = ensureEntry(queuedState, config, sessionId);
      queuedEntry.pendingCut = true;
      if (!writeState(ctx, queuedState)) {
        sendJson(res, 500, { ok: false, error: '状态写入失败，排队请求未保存。' });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        queued: true,
        message: '该会话当前不在内存中，已排队：下一次有输入时会立即截断。',
        state: stateSnapshot(queuedEntry),
      });
      return;
    }
    let outcome;
    try {
      outcome = applyControl(ctx, config, session, 'now', { turn: undefined });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: `截断失败：${error?.message ?? error}` });
      return;
    }
    const entry = ensureEntry(readState(ctx), config, sessionId);
    const failed = outcome?.kind === 'error';
    sendJson(res, 200, {
      ok: !failed,
      message: outcome?.text ?? '',
      ...(failed ? { error: outcome.text } : {}),
      state: stateSnapshot(entry),
    });
    return;
  }

  sendJson(res, 400, { ok: false, error: `未知操作：${op}` });
}

/* ---------------------------------------------------------------- plugin -- */

/** Test-only surface helpers (no runtime effect). */
export const __test = { balanceCuts, truncateSession, parseControl, controlPayload, normalizeHours, hasOpenCompaction, openTurnStart, handleApi, stateSnapshot };

export function apply(ctx, config) {
  const pluginConfig = { ...(config ?? {}) };

  ctx.effect(function* () {
    yield () => {};
    yield ctx.commands.register({
      definitionId: 'session-turncate',
      name: 'truncate',
      description: '按空闲时间截断当前会话的旧上下文（/truncate on 4 | off | now | status）',
      input: { hint: 'on [小时] | off | now | status' },
      handler: (invocation) => {
        const agent = invocation.agent;
        const session = agent?.session;
        if (session === undefined || session === null) return { kind: 'error', text: '当前没有可操作的会话。' };
        try {
          return applyControl(ctx, pluginConfig, session, invocation.rawInput, { turn: undefined });
        } catch (error) {
          return { kind: 'error', text: `截断失败：${error?.message ?? error}` };
        }
      },
    });
  }, 'session-turncate lifecycle');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: API_PATH,
    handler: (req, res) => handleApi(ctx, pluginConfig, req, res).catch((error) => {
      ctx.logger?.warn?.(`session-turncate: api failed: ${error?.message ?? error}`);
      try {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      } catch { /* the response is already gone */ }
    }),
  }), 'session-turncate api');

  ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
    /* A turn is only safely cut at its first step: from step 2 on, the running
       turn already owns surface nodes. Adapters that omit `step` are treated as
       first-step so the feature still works there. */
    const firstStep = step === undefined || step === 1;
    let receipt;
    if (!signal?.aborted) {
      /* Message-typed control, for bridges that prompt the session directly.
         A leading `/`, `／` or `!` is required, so ordinary prose such as
         "cut the file at line 20" never flips the switch. */
      try {
        for (const message of Array.isArray(messages) ? messages : []) {
          if (message?.role !== 'user') continue;
          const blocks = Array.isArray(message.content) ? message.content : [];
          const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
          if (!MESSAGE_CONTROL_PREFIX.test(text)) continue;
          const payload = controlPayload(text);
          if (payload === null) continue;
          if (parseControl(payload).kind === 'now' && !firstStep) continue;
          const session = agent?.session;
          if (session === undefined || session === null) continue;
          const outcome = applyControl(ctx, pluginConfig, session, payload, { turn });
          if (outcome !== undefined && typeof outcome.text === 'string') receipt = outcome.text;
        }
      } catch (error) {
        ctx.logger?.warn?.(`session-turncate: control failed: ${error?.message ?? error}`);
      }
      /* Only the turn's first step: the running turn has no surfaced output to lose yet. */
      if (firstStep) {
        try {
          const note = maybeAutoTruncate(ctx, pluginConfig, agent, turn);
          if (typeof note === 'string') receipt = note;
        } catch (error) {
          ctx.logger?.warn?.(`session-turncate: time policy failed: ${error?.message ?? error}`);
        }
      }
    }
    const decision = await next();
    if (receipt === undefined || decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
    return {
      ...decision,
      messages: [
        ...decision.messages,
        {
          id: randomUUID(),
          role: 'user',
          content: [
            {
              type: 'text',
              text: `[session-turncate 回执] ${receipt}\n（插件注入的执行结果。请在本回复开头用一两句话把结果告知用户。）`,
            },
          ],
          source: { kind: 'plugin-note', name: 'session-turncate' },
        },
      ],
    };
  });
}