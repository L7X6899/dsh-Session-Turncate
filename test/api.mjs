/**
 * Panel API + idle policy harness for dsh-Session-Turncate.
 * Run: node test/test-api.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turncate-api-'));
process.env.DSH_HOME = tmp;

const mod = await import('../lib/index.js');
const { apply, __test } = mod;
const { handleApi } = __test;

let pass = 0;
const fails = [];
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`PASS ${label}`);
  } else {
    fails.push(label);
    console.log(`FAIL ${label} expected ${JSON.stringify(expected)} actual ${JSON.stringify(actual)}`);
  }
}

const SURFACE = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result']);
const USER = (text) => ({ id: `u-${text}-${Math.random().toString(36).slice(2, 8)}`, role: 'user', content: [{ type: 'text', text }] });

function makeSession(seed, id = 'sess-api') {
  const events = new Map();
  const nodes = [];
  let seq = 0;
  const session = {
    id,
    get seq() { return seq; },
    surface: { nodes, replaceGeneration: 0, contentGeneration: 0 },
    eventAt: (value) => events.get(value),
    append(type, data, opts) {
      seq += 1;
      const event = { seq, type, data, ...(opts ?? {}) };
      events.set(seq, event);
      if (!SURFACE.has(type)) {
        if (opts?.surfaceOp !== undefined) throw new Error(`${type} cannot carry surfaceOp`);
        return event;
      }
      const op = opts?.surfaceOp ?? 'append';
      if (op === 'append') {
        nodes.push(seq);
        return event;
      }
      if (op.op !== 'replace') throw new Error('bad op');
      const startIdx = nodes.indexOf(op.startSeq);
      const endIdx = nodes.indexOf(op.endSeq);
      if (startIdx < 0 || endIdx < startIdx) throw new Error('bad range');
      const shadowed = nodes.slice(startIdx, endIdx + 1);
      if (startIdx === 0 && events.get(nodes[0])?.type === 'system/message') throw new Error('system head rewrite');
      const refs = opts?.sourceEventSeqs;
      if (!Array.isArray(refs)) throw new Error('missing sourceEventSeqs');
      for (const ref of shadowed) if (!refs.includes(ref)) throw new Error(`missing shadowed ${ref}`);
      nodes.splice(startIdx, endIdx - startIdx + 1, seq);
      session.surface.replaceGeneration += 1;
      session.surface.contentGeneration += 1;
      return event;
    },
  };
  for (const item of seed ?? []) session.append(item.type, item.data, item.surfaceOp === undefined ? undefined : { surfaceOp: item.surfaceOp });
  return session;
}

function makeCtx(extra = {}) {
  const handlers = {};
  const routes = [];
  const ctx = {
    handlers,
    routes,
    on(event, fn) { handlers[event] = fn; },
    commands: { register: (def) => def },
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    effect(factory) {
      const produced = factory();
      if (produced && typeof produced.next === 'function') produced.next();
    },
    logger: { warn() {} },
    ...extra,
  };
  return ctx;
}

function makeTransport(payload, options = {}) {
  const method = options.method ?? 'POST';
  const handlers = {};
  const req = {
    method,
    socket: { remoteAddress: options.remote ?? '127.0.0.1' },
    headers: options.origin === undefined ? { host: 'localhost:59260' } : { host: 'localhost:59260', origin: options.origin },
    on(event, fn) { (handlers[event] ??= []).push(fn); },
    destroy() {},
  };
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key] = value; },
    end(text) { this.body = text === undefined || text === null ? null : JSON.parse(text); },
  };
  return {
    req,
    res,
    async run(ctx, config) {
      const running = handleApi(ctx, config, req, res);
      await new Promise((resolve) => setImmediate(resolve));
      if (method === 'POST') {
        const chunk = Buffer.from(JSON.stringify(payload ?? {}));
        for (const fn of handlers.data ?? []) fn(chunk);
        for (const fn of handlers.end ?? []) fn();
      }
      await running;
      return res;
    },
  };
}

const stateFile = path.join(tmp, 'session-truncate.json');
function readDisk() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return { sessions: {} }; }
}

const ctx = makeCtx();
apply(ctx, {});
check('0 route registered', ctx.routes.length, 1);
check('0 route path', ctx.routes[0]?.path, '/session-turncate/api');

/* ---------------------------------------------------------------- status -- */
let res = await makeTransport({ op: 'status', sessionId: 'sess-api' }).run(ctx, {});
check('1 status code', res.statusCode, 200);
check('1 status enabled', res.body?.state?.enabled, false);
check('1 status hours', res.body?.state?.hours, 4);
check('1 status lastCutMs', res.body?.state?.lastCutMs, null);
check('1 status cutCount', res.body?.state?.cutCount, 0);
check('1 status nextCutMs', res.body?.state?.nextCutMs, null);
check('1 status pendingCut', res.body?.state?.pendingCut, false);
check('1 status is not persisted', readDisk().sessions?.['sess-api'], undefined);

/* ------------------------------------------------------------------- set -- */
res = await makeTransport({ op: 'set', sessionId: 'sess-api', enabled: true, hours: 6 }).run(ctx, {});
check('2 set code', res.statusCode, 200);
check('2 set enabled', res.body?.state?.enabled, true);
check('2 set hours', res.body?.state?.hours, 6);
const afterSet = readDisk().sessions?.['sess-api'];
check('2 disk enabled', afterSet?.enabled, true);
check('2 disk hours', afterSet?.hours, 6);
check('2 disk idle clock', typeof afterSet?.lastActiveMs, 'number');

/* ------------------------------------------------------------- hour guards -- */
res = await makeTransport({ op: 'set', sessionId: 'sess-api', hours: 25 }).run(ctx, {});
check('3 over max rejected', res.statusCode, 400);
check('3 over max keeps old value', readDisk().sessions?.['sess-api']?.hours, 6);

res = await makeTransport({ op: 'set', sessionId: 'sess-api', hours: -1 }).run(ctx, {});
check('3 negative rejected', res.statusCode, 400);

res = await makeTransport({ op: 'set', sessionId: 'sess-api', hours: 0 }).run(ctx, {});
check('3 zero accepted', res.statusCode, 200);
check('3 zero stored', readDisk().sessions?.['sess-api']?.hours, 0);

/* --------------------------------------------------------------- guards -- */
res = await makeTransport({ op: 'status' }).run(ctx, {});
check('4 missing sessionId', res.statusCode, 400);

res = await makeTransport({ op: 'nope', sessionId: 'sess-api' }).run(ctx, {});
check('4 unknown op', res.statusCode, 400);

res = await makeTransport({ op: 'status', sessionId: 'sess-api' }, { remote: '10.1.2.3', origin: 'http://evil.example' }).run(ctx, {});
check('5 cross-origin blocked', res.statusCode, 403);

res = await makeTransport({ op: 'status', sessionId: 'sess-api' }, { remote: '10.1.2.3', origin: 'http://localhost:59260' }).run(ctx, {});
check('5 same-origin allowed', res.statusCode, 200);

/* ------------------------------------------------------------------- cut -- */
res = await makeTransport({ op: 'cut', sessionId: 'sess-api' }).run(ctx, {});
check('6 cut without live session queues', res.statusCode, 200);
check('6 queued flag', res.body?.queued, true);
check('6 queued message', typeof res.body?.message === 'string' && res.body.message.includes('排队'), true);
check('6 pendingCut persisted', readDisk().sessions?.['sess-api']?.pendingCut, true);

const liveSession = makeSession(
  [
    { type: 'system/message', data: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }] } },
    { type: 'user/message', data: USER('one') },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'two' }] } } },
    { type: 'user/message', data: USER('three') },
    { type: 'assistant/message', data: { turn: 2, step: 1, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'four' }] } } },
    { type: 'user/message', data: USER('five') },
  ],
  'sess-live',
);
const ctxLive = makeCtx({ sessions: { get: (id) => (id === 'sess-live' ? liveSession : undefined) } });
apply(ctxLive, {});
res = await makeTransport({ op: 'cut', sessionId: 'sess-live' }).run(ctxLive, {});
check('7 cut ok', res.statusCode, 200);
check('7 cut body ok', res.body?.ok, true);
check('7 cut shrank surface', liveSession.surface.nodes.length, 2);
check('7 cut counted', res.body?.state?.cutCount, 1);

/* ---------------------------------------------------------- idle policy -- */
const idleState = (hours, lastActiveMs) => ({
  version: 1,
  sessions: { 'sess-live': { enabled: true, hours, keepRecentNodes: 0, lastActiveMs, lastCutMs: null, cutCount: 0 } },
});
fs.writeFileSync(stateFile, JSON.stringify(idleState(1, Date.now() - 2 * 3600_000)), 'utf8');

const preStep = ctxLive.handlers['agent/pre-step'];
const liveAgent = { session: makeSession(
  [
    { type: 'system/message', data: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }] } },
    { type: 'user/message', data: USER('alpha') },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'beta' }] } } },
    { type: 'user/message', data: USER('gamma') },
  ],
  'sess-live',
) };
const idleDecision = await preStep(
  { agent: liveAgent, messages: [], turn: 2, step: 1 },
  async () => ({ kind: 'enter', messages: [] }),
);
check('8 idle cut announced', idleDecision.messages.length, 1);
check('8 idle cut wording', idleDecision.messages[0].content[0].text.includes('空闲'), true);
check('8 idle cut shrank', liveAgent.session.surface.nodes.length, 2);
check('8 idle cut persisted', readDisk().sessions?.['sess-live']?.cutCount, 1);

fs.writeFileSync(stateFile, JSON.stringify(idleState(1, Date.now() - 5 * 60_000)), 'utf8');
const freshAgent = { session: makeSession(
  [
    { type: 'system/message', data: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }] } },
    { type: 'user/message', data: USER('delta') },
  ],
  'sess-live',
) };
const freshDecision = await preStep(
  { agent: freshAgent, messages: [], turn: 3, step: 1 },
  async () => ({ kind: 'enter', messages: [] }),
);
check('9 recent activity keeps context', freshDecision.messages.length, 0);
check('9 context intact', freshAgent.session.surface.nodes.length, 2);

fs.writeFileSync(stateFile, JSON.stringify(idleState(0, Date.now() - 9 * 3600_000)), 'utf8');
const zeroAgent = { session: makeSession(
  [
    { type: 'system/message', data: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }] } },
    { type: 'user/message', data: USER('epsilon') },
  ],
  'sess-live',
) };
const zeroDecision = await preStep(
  { agent: zeroAgent, messages: [], turn: 4, step: 1 },
  async () => ({ kind: 'enter', messages: [] }),
);
check('10 zero hours disables auto cut', zeroDecision.messages.length, 0);
check('10 context intact', zeroAgent.session.surface.nodes.length, 2);

console.log(fails.length === 0 ? '\nALL PASS' : `\nFAILURES: ${fails.join(', ')}`);
console.log(`(temp state kept at ${stateFile})`);
if (fails.length > 0) process.exitCode = 1;