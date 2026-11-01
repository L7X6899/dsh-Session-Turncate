/**
 * Local harness for dsh-session-turncate surface logic.
 * Simulates only the slice of Session the plugin touches: an event log, a
 * surface fold honouring `surfaceOp: replace`, and the append validations from
 * @deepseek-ai/dsh-session that matter for a compaction checkpoint.
 */
import { __test } from '../lib/index.js';

const { balanceCuts, truncateSession, parseControl, controlPayload, hasOpenCompaction, openTurnStart } = __test;

function makeSession(seed) {
  const log = [];
  const nodes = [];
  const session = {
    id: 'sess-1',
    get seq() {
      return log.length;
    },
    surface: {
      get nodes() {
        return nodes;
      },
    },
    eventAt(seq) {
      return log[seq];
    },
    append(type, data, opts) {
      const event = { type, seq: log.length, time: Date.now(), data: JSON.parse(JSON.stringify(data)) };
      if (opts?.surfaceOp !== undefined) event.surfaceOp = opts.surfaceOp;
      if (opts?.sourceEventSeqs !== undefined) event.sourceEventSeqs = opts.sourceEventSeqs;
      log.push(event);
      if (event.surfaceOp === 'append') nodes.push(event.seq);
      else if (event.surfaceOp && typeof event.surfaceOp === 'object') {
        const { startSeq, endSeq } = event.surfaceOp;
        const startIdx = nodes.indexOf(startSeq);
        const endIdx = nodes.indexOf(endSeq);
        if (startIdx < 0 || endIdx < 0) throw new Error(`replace range not in surface: ${startSeq}-${endSeq}`);
        if (startIdx > endIdx) throw new Error('start after end');
        const shadowed = nodes.slice(startIdx, endIdx + 1);
        const sources = new Set(event.sourceEventSeqs ?? []);
        for (const seq of shadowed) if (!sources.has(seq)) throw new Error(`sourceEventSeqs missing ${seq}`);
        for (const seq of sources) if (seq >= event.seq) throw new Error(`source seq ${seq} not earlier than ${event.seq}`);
        nodes.splice(startIdx, endIdx - startIdx + 1, event.seq);
      }
      return event;
    },
  };
  for (const item of seed) {
    const op = item.surfaceOp && item.surfaceOp.op === 'append' ? 'append' : item.surfaceOp;
    const event = session.append(item.type, item.data, op ? { surfaceOp: op, sourceEventSeqs: item.sourceEventSeqs } : undefined);
    event.data = item.data;
  }
  return session;
}

const msg = (role, text) => ({ role, content: [{ type: 'text', text }] });

function user(text) {
  return { type: 'user/message', data: { id: `u${Math.random()}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'test' } }, surfaceOp: { op: 'append' } };
}

function assistant(text, tools = []) {
  return {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `a${Math.random()}`,
        role: 'assistant',
        content: [...(text ? [{ type: 'text', text }] : []), ...tools.map((name) => ({ type: 'tool-call', id: `c${name}`, name, arguments: {} }))],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    },
    surfaceOp: { op: 'append' },
  };
}

function toolResult(callName) {
  return {
    type: 'tool/result',
    data: { turn: 1, step: 1, message: { id: `r${Math.random()}`, role: 'tool', content: [{ type: 'text', text: 'out' }], isError: false }, callId: `c${callName}`, name: callName },
    surfaceOp: { op: 'append' },
  };
}

function system(text) {
  return { type: 'system/message', data: { message: { id: 'sys', role: 'system', content: [{ type: 'text', text }], source: { kind: 'harness' } } }, surfaceOp: { op: 'append' } };
}

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `\n  expected ${e}\n  actual   ${a}`}`);
}

const ctx = { logger: { info() {}, warn() {} } };

/* 1. plain conversation, no tools: system + 4 messages -> system + checkpoint */
{
  const session = makeSession([
    system('You are helpful.'),
    user('task A: hello'),
    assistant('reply A'),
    user('task B: world'),
    assistant('reply B'),
  ]);
  const before = session.surface.nodes.length;
  check('1 balance before truncation', balanceCuts(session).cuts, [true, true, true, true, true, true]);
  const result = truncateSession(ctx, session, { keepRecentNodes: 0, turn: 7, label: 'test' });
  check('1 dropped 4 nodes', result?.shadowed, 4);
  check('1 surface keeps system + checkpoint', session.surface.nodes.length, before - 3);
  const checkpoint = session.eventAt(session.surface.nodes[1]);
  check('1 checkpoint is user/message', checkpoint.type, 'user/message');
  check('1 checkpoint source kind', checkpoint.data.source.kind, 'compact-checkpoint');
  check('1 compaction lifecycle closed', session.eventAt(session.seq - 1).type, 'compaction/end');
}

/* 2. assistant with two tool calls + two results: still balanced, cut works */
{
  const session = makeSession([
    system('sys'),
    user('run tools'),
    assistant('', ['a', 'b']),
    toolResult('a'),
    toolResult('b'),
    assistant('done'),
    user('next task'),
  ]);
  check('2 cuts', balanceCuts(session).cuts, [true, true, true, false, false, true, true, true]);
  const result = truncateSession(ctx, session, { keepRecentNodes: 0, turn: 3 });
  check('2 drops all 6', result?.shadowed, 6);
  check('2 surface is system + checkpoint', session.surface.nodes.length, 2);
}

/* 3. unbalanced tail (dangling tool call) must not be cut; earlier span may be */
{
  const session = makeSession([
    system('sys'),
    user('first'),
    assistant('ok'),
    user('second'),
    assistant('', ['x']),
  ]);
  const cuts = balanceCuts(session).cuts;
  check('3 dangling call leaves last cut open', cuts[cuts.length - 1], false);
  check('3 keepRecentNodes=3 -> cut only first user', truncateSession(ctx, session, { keepRecentNodes: 3, turn: 2 })?.shadowed, 1);
}

/* 4. keepRecentNodes leaves the tail alone */
{
  const session = makeSession([system('sys'), user('a'), assistant('a1'), user('b'), assistant('b1')]);
  const result = truncateSession(ctx, session, { keepRecentNodes: 2, turn: 4 });
  check('4 drops middle only', result?.shadowed, 2);
  check('4 surface shape', session.surface.nodes.length, 4);
}

/* 5. nothing but system -> null */
{
  const session = makeSession([system('sys')]);
  check('5 no-op', truncateSession(ctx, session, { keepRecentNodes: 0, turn: 1 }), null);
}

/* 6. no system head -> node 0 is cuttable */
{
  const session = makeSession([user('a'), assistant('a1')]);
  const result = truncateSession(ctx, session, { keepRecentNodes: 0, turn: 1 });
  check('6 cuts from node 0', result?.shadowed, 2);
  check('6 surface is a single checkpoint', session.surface.nodes.length, 1);
}

/* 7. control line parsing (slash command and message-typed bridge input) */
{
  check('7 on with hours', parseControl('on 4'), { kind: 'on', hours: 4 });
  check('7 on without hours', parseControl('开'), { kind: 'on', hours: null });
  check('7 off', parseControl('off'), { kind: 'off' });
  check('7 now', parseControl('now'), { kind: 'now' });
  check('7 status is the empty default', parseControl(''), { kind: 'status' });
  check('7 unknown verb', parseControl('foo'), { kind: 'unknown', text: 'foo' });
  check('7 payload /truncate on 6', controlPayload('/truncate on 6'), 'on 6');
  check('7 payload 截断 off', controlPayload('截断 off'), 'off');
  check('7 payload refunds plain prose', controlPayload('hello /truncate'), null);
  check('7 payload bare command', controlPayload('/truncate'), '');
}

/* 8. an open compaction transaction blocks a second one */
{
  const session = makeSession([system('sys'), user('a'), assistant('a1')]);
  session.append('compaction/start', { compactionId: 'c1', turn: 1 });
  check('8 hasOpenCompaction', hasOpenCompaction(session), true);
  check('8 blocked while compacting', truncateSession(ctx, session, { keepRecentNodes: 0, turn: 1 }), null);
}

/* 9. the running turn's own surfaced output is never dropped */
{
  const session = makeSession([system('sys'), user('old'), assistant('old reply')]);
  session.append('turn/start', { turn: 2 });
  session.append('user/message', { id: 'u-new', role: 'user', content: [{ type: 'text', text: 'current task' }], source: { kind: 'test' } }, { surfaceOp: 'append' });
  check('9 open turn', openTurnStart(session)?.turn, 2);
  const result = truncateSession(ctx, session, { keepRecentNodes: 0, turn: 2 });
  check('9 drops history only', result?.shadowed, 2);
  check('9 keeps current turn node', session.surface.nodes.length, 3);
  const last = session.eventAt(session.surface.nodes[2]);
  check('9 last node is current input', last.data.content?.[0]?.text, 'current task');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);