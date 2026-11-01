import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'truncate-test-'));
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

function makeCtx() {
  const handlers = {};
  const ctx = {
    handlers,
    on(event, fn) {
      handlers[event] = fn;
    },
    commands: { register: (def) => def },
    webServer: { register: () => () => {} },
    effect(factory) {
      const produced = factory();
      if (produced && typeof produced.next === 'function') produced.next();
    },
    logger: { warn() {} },
  };
  return ctx;
}

const ctx = makeCtx();
apply(ctx, {});
const preStep = ctx.handlers['agent/pre-step'];
check('10 handler registered', typeof preStep, 'function');

const session = { id: 'sess-1', surface: { nodes: [] }, seq: 0, eventAt: () => undefined, append: () => ({}) };
const agent = { session };

const decision = await preStep(
  { agent, messages: [{ role: 'user', content: [{ type: 'text', text: '/truncate on 4' }] }], turn: 1, step: 1, signal: undefined },
  async () => ({ kind: 'enter', messages: [] }),
);
check('10 receipt appended', Array.isArray(decision.messages) ? decision.messages.length : -1, 1);
const receipt = decision.messages?.[0];
check('10 receipt role', receipt?.role, 'user');
check('10 receipt source', receipt?.source, { kind: 'plugin-note', name: 'session-turncate' });
check('10 receipt mentions hours', typeof receipt?.content?.[0]?.text === 'string' && receipt.content[0].text.includes('4 小时'), true);

const stateFile = path.join(tmp, 'session-truncate.json');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
check('10 persisted enabled', state.sessions['sess-1']?.enabled, true);
check('10 persisted hours', state.sessions['sess-1']?.hours, 4);

const quiet = await preStep(
  { agent, messages: [{ role: 'user', content: [{ type: 'text', text: '你好，随便聊聊' }] }], turn: 2, step: 1, signal: undefined },
  async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '你好，随便聊聊' }] }] }),
);
check('10 no receipt for plain text', quiet.messages, [{ role: 'user', content: [{ type: 'text', text: '你好，随便聊聊' }] }]);
check('10 decision passthrough', quiet.kind, 'enter');

const aborted = await preStep(
  { agent, messages: [{ role: 'user', content: [{ type: 'text', text: '/truncate off' }] }], turn: 3, step: 1, signal: { aborted: true } },
  async () => ({ kind: 'enter', messages: [] }),
);
check('10 aborted skips control', aborted.messages.length, 0);
check('10 aborted keeps enabled', JSON.parse(fs.readFileSync(stateFile, 'utf8')).sessions['sess-1']?.enabled, true);

// 临时测试目录按硬闸要求不删除，保留在 os.tmpdir() 下供复查。
console.log(`(temp state kept at ${stateFile})`);
console.log(fails.length === 0 ? '\nALL PASS' : `\nFAILED: ${fails.join(', ')}`);
process.exitCode = fails.length === 0 ? 0 : 1;