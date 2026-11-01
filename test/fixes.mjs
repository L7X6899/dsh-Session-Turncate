import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'truncate-fix-'));
process.env.DSH_HOME = tmp;

const mod = await import('../lib/index.js');
const { __test, apply } = mod;
const { truncateSession, hasOpenCompaction } = __test;

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

/** Minimal session double with append-time surface bookkeeping. */
function makeSession(seeds) {
  const events = [];
  const nodes = [];
  let seq = 0;
  const session = {
    id: 'sess-fix',
    surface: { nodes, replaceGeneration: 0, contentGeneration: 0 },
    get seq() {
      return seq;
    },
    eventAt: (n) => events.find((e) => e.seq === n),
    append(type, data, opts) {
      const event = { seq: seq++, type, data };
      events.push(event);
      const op = opts?.surfaceOp;
      if (op === 'append') nodes.push(event.seq);
      else if (op && op.op === 'replace') {
        const startIdx = nodes.indexOf(op.startSeq);
        const endIdx = nodes.indexOf(op.endSeq);
        if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) throw new Error('invalid replace range');
        for (const covered of nodes.slice(startIdx, endIdx + 1)) {
          if (!opts.sourceEventSeqs?.includes(covered)) throw new Error(`sourceEventSeqs missing ${covered}`);
        }
        if (startIdx === 0 && events[op.startSeq]?.type === 'system/message') throw new Error('system head rewrite');
        nodes.splice(startIdx, endIdx - startIdx + 1, event.seq);
      }
      return event;
    },
    all: events,
  };
  for (const seed of seeds) {
    const op = seed.surfaceOp === undefined ? 'append' : seed.surfaceOp;
    session.append(seed.type, seed.data, op === undefined ? undefined : { surfaceOp: op, sourceEventSeqs: Array.isArray(op) ? undefined : [] });
  }
  return session;
}

const USER = (text) => ({ id: `m-${Math.random()}`, role: 'user', content: [{ type: 'text', text }] });
const ctx = { logger: { info() {}, warn() {} } };

/* 1. lifecycle always carries an explicit `turn` key (null outside a turn). */
const s1 = makeSession([
  { type: 'system/message', data: { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }] } } },
  { type: 'user/message', data: USER('a') },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] } } },
  { type: 'user/message', data: USER('b') },
]);
const r1 = truncateSession(ctx, s1, { keepRecentNodes: 0, turn: undefined, label: 't' });
check('1 cut happened', r1 !== null, true);
const startEvent = s1.all.find((e) => e.type === 'compaction/start');
check('1 start has turn key', Object.prototype.hasOwnProperty.call(startEvent.data, 'turn'), true);
check('1 turn is null outside a turn', startEvent.data.turn, null);
const endEvent = s1.all.find((e) => e.type === 'compaction/end');
check('1 end has turn key', Object.prototype.hasOwnProperty.call(endEvent.data, 'turn'), true);
check('1 end turn is null', endEvent.data.turn, null);
check('1 end carries no error', endEvent.data.error, undefined);

/* 2. a second consecutive cut only leaves system + fresh checkpoint. */
const r2 = truncateSession(ctx, s1, { keepRecentNodes: 0, turn: 2, label: 't2' });
check('2 second cut happened', r2 !== null, true);
const headType = s1.eventAt(s1.surface.nodes[0])?.type;
check('2 system kept', headType, 'system/message');
check('2 surface size', s1.surface.nodes.length, 2);
check('2 tail is checkpoint', s1.eventAt(s1.surface.nodes[1])?.data?.source?.kind, 'compact-checkpoint');

/* 3. keepRecentNodes larger than the surface is clamped, never negative. */
const s3 = makeSession([
  { type: 'user/message', data: USER('x') },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'y' }] } } },
]);
check('3 huge keep keeps everything', truncateSession(ctx, s3, { keepRecentNodes: 2 ** 33, turn: 1 }), null);
check('3 surface untouched', s3.surface.nodes.length, 2);

/* 4. interleaved compaction ids stay detected (no false "closed"). */
const s4 = makeSession([{ type: 'user/message', data: USER('z') }]);
s4.append('compaction/start', { compactionId: 'A', turn: 1 });
s4.append('compaction/start', { compactionId: 'B', turn: 1 });
s4.append('compaction/end', { compactionId: 'A', turn: 1 });
check('4 B still open', hasOpenCompaction(s4), true);
check('4 refuses to interleave', truncateSession(ctx, s4, { keepRecentNodes: 0, turn: 1 }), null);
s4.append('compaction/end', { compactionId: 'B', turn: 1 });
check('4 nothing open', hasOpenCompaction(s4), false);

/* 5. plain prose is not a control line; a slashed line is. */
const ctx2 = { handlers: {}, on(e, f) { this.handlers[e] = f; }, commands: { register: (d) => d }, webServer: { register: () => () => {} }, effect(f) { const produced = f(); if (produced && typeof produced.next === 'function') produced.next(); }, logger: { warn() {} } };
apply(ctx2, {});
const preStep = ctx2.handlers['agent/pre-step'];
const plain = await preStep(
  { agent: { session: makeSession([{ type: 'user/message', data: USER('cut the file at line 20') }]) }, messages: [{ role: 'user', content: [{ type: 'text', text: 'cut the file at line 20' }] }], turn: 1, step: 1 },
  async () => ({ kind: 'enter', messages: [] }),
);
check('5 prose ignored', plain.messages.length, 0);
const slashed = await preStep(
  { agent: { session: makeSession([{ type: 'user/message', data: USER('/truncate on 3') }]) }, messages: [{ role: 'user', content: [{ type: 'text', text: '/truncate on 3' }] }], turn: 2, step: 1 },
  async () => ({ kind: 'enter', messages: [] }),
);
check('5 slashed handled', slashed.messages.length, 1);
const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'session-truncate.json'), 'utf8'));
const anyEntry = Object.values(saved.sessions).find((e) => e.hours === 3);
check('5 hours stored on the session', anyEntry?.hours, 3);

/* 6. bad hour tokens are rejected instead of silently coerced. */
const bad = await preStep(
  { agent: { session: makeSession([{ type: 'user/message', data: USER('/truncate on 0x4') }]) }, messages: [{ role: 'user', content: [{ type: 'text', text: '/truncate on 0x4' }] }], turn: 3, step: 1 },
  async () => ({ kind: 'enter', messages: [] }),
);
check('6 error receipt', bad.messages[0]?.content?.[0]?.text?.includes('小时数无效'), true);

/* 7. mid-turn `now` is skipped (surface already owns this turn's output). */
const midTurn = await preStep(
  { agent: { session: makeSession([{ type: 'user/message', data: USER('/truncate now') }]) }, messages: [{ role: 'user', content: [{ type: 'text', text: '/truncate now' }] }], turn: 4, step: 2 },
  async () => ({ kind: 'enter', messages: [] }),
);
check('7 no receipt mid-turn', midTurn.messages.length, 0);

console.log(`(temp state kept at ${tmp})`);
console.log(fails.length === 0 ? '\nALL PASS' : `\nFAILED: ${fails.join(', ')}`);
process.exitCode = fails.length === 0 ? 0 : 1;