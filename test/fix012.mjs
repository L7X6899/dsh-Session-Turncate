import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turncate-fix012-'));
process.env.DSH_HOME = tmp;

const mod = await import('../lib/index.js');
const { apply } = mod;

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

const USER = (text) => ({ id: `u-${text}`, role: 'user', content: [{ type: 'text', text }] });

function makeSession(id, nodes) {
  const events = [];
  let seq = 0;
  const surfaceNodes = [];
  const session = {
    id,
    get seq() { return seq; },
    surface: { get nodes() { return surfaceNodes; }, replaceGeneration: 0, contentGeneration: 0 },
    eventAt(target) { return events.find((event) => event.seq === target); },
    append(type, data, opts) {
      seq += 1;
      const event = { seq, type, data };
      events.push(event);
      if (['system/message', 'user/message', 'assistant/message', 'tool/result'].includes(type)) {
        const op = typeof opts === 'string' ? opts : opts?.surfaceOp;
        if (typeof op === 'string') {
          surfaceNodes.push(seq);
        } else if (op?.op === 'replace') {
          const start = surfaceNodes.indexOf(op.startSeq);
          const end = surfaceNodes.indexOf(op.endSeq);
          if (start < 0 || end < start) throw new Error('bad replace range');
          const refs = Array.isArray(opts?.sourceEventSeqs) ? opts.sourceEventSeqs : [];
          for (const shadowed of surfaceNodes.slice(start, end + 1)) {
            if (!refs.includes(shadowed)) throw new Error(`missing sourceEventSeq ${shadowed}`);
          }
          surfaceNodes.splice(start, end - start + 1, seq);
        }
      }
      return event;
    },
  };
  for (const node of nodes) session.append(node.type, node.data, 'append');
  return session;
}

const cmds = [];
const handlers = {};
const ctx = {
  on(event, fn) { handlers[event] = fn; },
  commands: { register: (def) => { cmds.push(def); return def; } },
  webServer: { register: () => () => {} },
  effect(factory) {
    const produced = factory();
    if (produced && typeof produced.next === 'function') {
      for (let step = produced.next(); !step.done; step = produced.next());
    }
  },
  logger: { warn() {}, info() {} },
};
apply(ctx, {});

const command = cmds[0];
check('0 command registered', command?.name, 'truncate');
const run = (session, rawInput) => command.handler({ agent: { session }, rawInput, signal: undefined });

/* ---- A. status with no clock yet (the Invalid Date bug) ---- */
const plain = makeSession('sess-fix', [
  { type: 'system/message', data: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }] } },
  { type: 'user/message', data: USER('hello') },
]);

let out = run(plain, ' status');
check('A status kind', out.kind, 'success');
check('A no Invalid Date', out.text.includes('Invalid Date'), false);
check('A pending clock wording', out.text.includes('等下一次输入后开始计时'), true);

/* ---- B. /truncate on writes lastActiveMs, never anchorMs ---- */
out = run(plain, ' on 5');
check('B on ok', out.kind, 'success');
let disk = JSON.parse(fs.readFileSync(path.join(tmp, 'session-truncate.json'), 'utf8'));
const entry = disk.sessions['sess-fix'];
check('B anchorMs removed', 'anchorMs' in entry, false);
check('B lastActiveMs numeric', typeof entry.lastActiveMs === 'number' && Number.isFinite(entry.lastActiveMs), true);
check('B hours stored', entry.hours, 5);

out = run(plain, ' status');
check('B status no Invalid Date', out.text.includes('Invalid Date'), false);
check('B status shows real date', /下次截断不早于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(out.text), true);

/* ---- C. a queued cut drains on the next step ---- */
const busy = makeSession('sess-fix', [
  { type: 'system/message', data: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }] } },
  { type: 'user/message', data: USER('one') },
  { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'two' }] } } },
  { type: 'user/message', data: USER('three') },
  { type: 'assistant/message', data: { turn: 2, step: 1, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'four' }] } } },
]);

disk = JSON.parse(fs.readFileSync(path.join(tmp, 'session-truncate.json'), 'utf8'));
disk.sessions['sess-fix'].pendingCut = true;
fs.writeFileSync(path.join(tmp, 'session-truncate.json'), JSON.stringify(disk));

const decision = await handlers['agent/pre-step'](
  { agent: { session: busy }, messages: [{ role: 'user', content: [{ type: 'text', text: 'next task' }] }], turn: 3, step: 1, signal: undefined },
  async () => ({ kind: 'enter', messages: [] }),
);
const receipt = decision.messages?.[0];
check('C receipt present', typeof receipt?.content?.[0]?.text, 'string');
check('C receipt mentions queue', String(receipt?.content?.[0]?.text ?? '').includes('排队'), true);
check('C surface shrunk', busy.surface.nodes.length, 2);
check('C last node is checkpoint', busy.eventAt(busy.surface.nodes[1])?.data?.source?.kind, 'compact-checkpoint');

disk = JSON.parse(fs.readFileSync(path.join(tmp, 'session-truncate.json'), 'utf8'));
check('C pendingCut cleared', disk.sessions['sess-fix'].pendingCut, false);
check('C cut counted', disk.sessions['sess-fix'].cutCount, 1);

console.log(fails.length === 0 ? '\nALL PASS' : `\nFAILURES: ${fails.join(', ')}`);
console.log(`(temp state kept at ${tmp})`);
check_count();
function check_count() {
  console.log(`total ${pass} passed, ${fails.length} failed`);
}