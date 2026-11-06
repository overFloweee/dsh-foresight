// 回合回顾（recap）端到端：宿主在 completed 回合后单独调一次模型，生成一行
// 「这一轮做了什么」，按会话+回合落盘并随 `_push.recaps` 下发；开关能关掉整条链路。
//
// 用法：pnpm build && node scripts/recap-e2e.mjs
//
// 真实部分：cordis Context、SessionStore、SessionProjectionRegistry、插件 `apply()`、
// 会话事件流、storage 栈（E 段）。桩只替换外部面：`llm.stream`（不联网）、
// `settings`（内存文档）。
//
// 覆盖：
//   A. live 链路：completed 回合 → 恰好一次回顾调用 → `_push.recaps` 携带该回合回顾；
//   B. 材料形态：消息含用户诉求 / 助手结论 / 工具调用 / 工具错误，且末尾带「这轮之后
//      什么变了」的问句与 80 字上限（① 优化的落点）；
//   C. 失败归因：route_unavailable / transport / empty_body / tool_call，且不落库；
//   D. 开关：recapEnabled=false ⇒ 不调用模型、载荷里没有回顾内容；
//   E. 持久化：真实 storage 栈下 put → flush → 关闭 → 重新装配后 list 恢复；
//   F. 形状整形：超长按标点断句压到上限、元叙述开头被剥、哨兵「无变化」⇒ no_change；
//   G. 没有变化的回合：线路不产生任何回顾推送（不显示）。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context, Service } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { Storage } from '@deepseek-ai/dsh-storage';
import * as storageJson from '@deepseek-ai/dsh-storage-json';
import * as storageDomain from '@deepseek-ai/dsh-storage-domain';
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { apply } from '../lib/index.js';
import { generateRecap } from '../lib/recap.js';
import { setupRecapStore } from '../lib/recap-store.js';
import { EMPTY_PUSH, SUGGEST_GHOST_NAMESPACE as NS } from '../lib/settings.js';

const RECAP_TEXT = '开关已加上，构建通过，还有1条测试失败';
const SUGGESTION_JSON = JSON.stringify({ suggestion: '下一条建议：先看灰度面板' });
const isRecapRequest = (options) => typeof options.system === 'string' && options.system.includes('recap');

const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > until) return undefined;
    await sleep(15);
  }
}

const text = (value) => [{ type: 'text', text: value }];
const okChunks = (value) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: value },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'finish', reason: { kind: 'stop' } },
];
const toolChunks = () => [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'probe_read', arguments: '{}' } },
  { type: 'finish', reason: { kind: 'stop' } },
];

/** 桩 llm：记录 stream 参数；`behavior` 决定吐什么（text / empty / tool / throw）。 */
class LlmStub extends Service {
  constructor(ctx) {
    super(ctx, 'llm');
    this.calls = [];
    this.behavior = 'text';
    /** text 行为下回顾请求的正文（各段可改成超长/哨兵/带元词，用于整形断言）。 */
    this.recapText = RECAP_TEXT;
  }
  async *stream(options) {
    this.calls.push(options);
    if (this.behavior === 'throw') throw new Error('llm exploded');
    // 'text' 时按提示词分流：回顾要散文，预测要严格 JSON（否则预测会判 invalid_json）。
    const value = this.behavior === 'empty' ? '' : (isRecapRequest(options) ? this.recapText : SUGGESTION_JSON);
    const chunks = this.behavior === 'tool' ? toolChunks() : okChunks(value);
    for (const chunk of chunks) yield chunk;
  }
}

/** 内存 settings：describe/update 与宿主同形，`_push`/`_ops` 就是文档字段。 */
class SettingsStub extends Service {
  constructor(ctx, value = {}) {
    super(ctx, 'settings');
    this.value = { ...value };
    this.updates = [];
    this.rev = 0;
  }
  async describe() {
    return [{ ns: NS, value: { ...this.value }, revision: this.rev }];
  }
  async update(ns, patch, expected) {
    if (typeof expected === 'number' && expected !== this.rev) {
      const error = new Error('settings revision mismatch');
      error.name = 'SettingsRevisionMismatch';
      throw error;
    }
    this.rev += 1;
    this.updates.push({ ns, patch, expected });
    if (patch !== null && typeof patch === 'object') this.value = { ...this.value, ...patch };
  }
  setDoc(patch) {
    this.value = { ...this.value, ...patch };
    this.rev += 1;
  }
  /** 模拟用户/对端写 `_ops`：`rev` 是客户端已确认的文档 revision。 */
  setOps(ops, rev) {
    this.setDoc({ _ops: JSON.stringify({ rev, ops }) });
  }
  get push() {
    const raw = this.value._push;
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  get pushes() {
    return this.updates
      .filter((update) => update.patch !== null && typeof update.patch === 'object' && '_push' in update.patch)
      .map((update) => {
        try {
          return JSON.parse(update.patch._push);
        } catch {
          return null;
        }
      })
      .filter((payload) => payload !== null);
  }
}

/** storageDomain 桩：内存表，只为兑现 `whenReady`（宿主域可用这一支）。 */
class StorageDomainStub extends Service {
  constructor(ctx) {
    super(ctx, 'storageDomain');
  }
  async open() {
    const rows = new Map();
    return {
      table: () => ({
        entries: () => [...rows.entries()],
        put: async (key, record) => { rows.set(key, record); },
        delete: async (key) => { rows.delete(key); },
      }),
      close: async () => {},
    };
  }
}

const CONFIG = {
  maxInputBytes: 16384,
  maxOutputTokens: 512,
  timeoutMs: 30000,
  maxRecentTurns: 3,
  maxTranscriptChars: 24000,
  maxSuggestionChars: 240,
  provider: '',
  model: '',
  reasoningEffort: '',
  llmEnabled: true,
  recapEnabled: true,
  historyEnabled: true,
  historyCrossSession: false,
  historyMaxEntries: 50,
  historyMinChars: 1,
  wordAccept: true,
  acceptKey: 'Tab',
  _ops: 'null',
  _push: EMPTY_PUSH,
};

function harness(overrides = {}) {
  const root = new Context();
  if (root.logger === undefined) root.logger = console;
  new SessionStore(root);
  new SessionProjectionRegistry(root);
  new StorageDomainStub(root);
  const settings = new SettingsStub(root);
  const llm = new LlmStub(root);
  apply(root, { ...CONFIG, ...overrides });
  return { root, settings, llm };
}

/**
 * 等到插件真正接好线再驱动事件（照抄 prediction-slice2-e2e 的 ready）：`_ops` 泵的
 * 一次真实 pull 往返证明 settings 注入回调已执行。此前创建会话会让 turn/end 领先于
 * 注入回调，推送无处可写——实测症状是「live 触发整个不发生」。
 */
async function ready(settings) {
  settings.setOps([{ op: 'pull', sessionId: 'readiness-probe', nonce: 'ready-1', id: 'ready' }], 0);
  const ok = await waitFor(() => (settings.push?.nonce === 'ready-1' ? true : undefined), 6000);
  assert.ok(ok, 'settings/_ops 泵未应答（inject 回调或泵未起表）');
  // 让同一批微任务里的其余注入回调（sessionProjections 单元注册）落地。
  await sleep(50);
}

/** 造一个带工具调用的已完成回合（1 个成功工具 + 1 个失败工具）。 */
function makeTurn(root, id, options = {}) {
  const session = root.sessions.create(id, { meta: { cwd: process.cwd(), ...(options.origin === undefined ? {} : { origin: options.origin }) } });
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  if (options.route !== false) {
    session.append('request/header', {
      header: { config: { provider: 'demo-gateway', model: 'deepseek/deepseek-flash' }, tools: [{ name: 'probe_read' }] },
      reason: 'initial',
    });
  }
  session.append('user/message', createUserMessage({ content: text('把设置页的回顾开关补上'), source: { kind: 'user' } }), { surfaceOp: 'append' });
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: text('先看设置卡片的字段定义。'),
      source: { kind: 'model', provider: 'demo-gateway', model: 'deepseek/deepseek-flash' },
    }),
    stream: [],
  }, { surfaceOp: 'append' });
  session.append('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'shell', arguments: JSON.stringify({ command: 'pnpm build' }) });
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: 'call-1', content: text('build ok'), isError: false }),
  }, { surfaceOp: 'append' });
  session.append('tool/call', { turn: 1, step: 1, callId: 'call-2', name: 'shell', arguments: JSON.stringify({ command: 'pnpm test' }) });
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: 'call-2', content: text('1 failed'), isError: true }),
    error: { name: 'ToolError', code: 'E_FAIL', reason: 'tests failed: 1 of 12' },
  }, { surfaceOp: 'append' });
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: text('开关加好了，构建通过，测试还有 1 条失败。'),
      source: { kind: 'model', provider: 'demo-gateway', model: 'deepseek/deepseek-flash' },
    }),
    stream: [],
  }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  return session;
}

// ── A / B：live 链路 + 材料形态 ────────────────────────────────
await check('A① completed 回合后恰好一次回顾调用，随 `_push.recaps` 下发', async () => {
  const { root, settings, llm } = harness();
  await ready(settings);
  makeTurn(root, 'recap-live');
  const payload = await waitFor(() => {
    const push = settings.push;
    return push?.recapsSessionId === 'recap-live' && Array.isArray(push.recaps) && push.recaps.length > 0 ? push : undefined;
  });
  assert.ok(payload, '没有收到携带回顾的推送');
  assert.equal(payload.recaps.length, 1);
  assert.equal(payload.recaps[0].turn, 1);
  assert.equal(payload.recaps[0].text, RECAP_TEXT);
  assert.equal(llm.calls.filter(isRecapRequest).length, 1, '回顾链路应只调用一次模型');
});

await check('A② 回顾材料的消息形态：用户诉求 / 助手结论 / 工具调用 / 工具错误', async () => {
  const { root, settings, llm } = harness();
  await ready(settings);
  makeTurn(root, 'recap-material');
  await waitFor(() => settings.push?.recaps?.length > 0 ? true : undefined);
  const options = llm.calls.find(isRecapRequest);
  assert.ok(options, '没有回顾调用');
  const body = options.messages.at(-1).content.map((block) => block.text ?? '').join('');
  assert.match(body, /\[This turn — what the user asked for\]/);
  assert.match(body, /把设置页的回顾开关补上/);
  assert.match(body, /\[What the assistant concluded\]/);
  assert.match(body, /开关加好了，构建通过，测试还有 1 条失败。/);
  assert.match(body, /\[Tool calls this turn \(2\)\]/);
  assert.match(body, /pnpm build/);
  assert.match(body, /\[Tool errors this turn\]/);
  assert.match(body, /tests failed: 1 of 12/);
  // ① 优化的落点：问句在材料末尾，问的是「这一轮之后什么变了」，不是「做了什么」。
  assert.match(body, /\[这一轮的结论\]/);
  assert.match(body, /这一轮之后，什么变了/);
  assert.match(body, /不超过 80 个字/);
  assert.match(body, /只回复：无/);
  assert.equal(options.provider, 'demo-gateway');
  assert.equal(options.model, 'deepseek/deepseek-flash');
  assert.equal(options.tools, undefined, '回顾请求不带工具');
  assert.match(options.system, /recap/);
  // 提示词由用户 m00832 定稿为三段：角色/读者 + 最高要求。回归锁只认这两句，
  // 多出来的规则说明有人又往提示词里塞了东西（用户要求「下面的都删掉」）。
  assert.match(options.system, /逻辑清晰说人话/);
  assert.match(options.system, /一次性就能够听明白/);
  assert.equal(options.system.trim().split('\n\n').length, 2, '提示词应只剩两段（角色/读者 + 最高要求）');
});

// ── C：失败归因（直接调 generateRecap，验证不落库）─────────────
const recapConfig = {
  maxChars: 80,
  sourceChars: 12000,
  timeoutMs: 30000,
  maxTokens: 512,
  provider: '',
  model: '',
  reasoningEffort: '',
};

await check('C① 无请求头 ⇒ route_unavailable（不调用模型）', async () => {
  const { root, llm } = harness();
  const session = makeTurn(root, 'recap-route', { route: false });
  const result = await generateRecap(root, recapConfig, session, 1, new AbortController().signal);
  assert.equal(result.kind, 'failed');
  assert.equal(result.reason, 'route_unavailable');
  assert.equal(llm.calls.length, 0);
});

await check('C② 传输异常 ⇒ transport', async () => {
  const { root, llm } = harness();
  llm.behavior = 'throw';
  const session = makeTurn(root, 'recap-transport');
  const result = await generateRecap(root, recapConfig, session, 1, new AbortController().signal);
  assert.equal(result.kind, 'failed');
  assert.equal(result.reason, 'transport');
});

await check('C③ 空正文 ⇒ empty_body', async () => {
  const { root, llm } = harness();
  llm.behavior = 'empty';
  const session = makeTurn(root, 'recap-empty');
  const result = await generateRecap(root, recapConfig, session, 1, new AbortController().signal);
  assert.equal(result.kind, 'failed');
  assert.equal(result.reason, 'empty_body');
});

await check('C④ 工具调用结束 ⇒ tool_call', async () => {
  const { root, llm } = harness();
  llm.behavior = 'tool';
  const session = makeTurn(root, 'recap-tool');
  const result = await generateRecap(root, recapConfig, session, 1, new AbortController().signal);
  assert.equal(result.kind, 'failed');
  assert.equal(result.reason, 'tool_call');
});

// ── F：② 形状整形（超长/元词/哨兵）────────────────────────────
await check('F① 超长回顾按标点就近断句，压到 80 字内', async () => {
  const { root, llm } = harness();
  llm.recapText = '这一轮把回顾开关加进了设置页，构建通过，测试还有一条失败，另外还要刷新页面确认位置，顺手清理了临时文件，同时确认了重启之后回顾还在，再把设置页的文案同步成英文，最后看一眼效果';
  const session = makeTurn(root, 'recap-long');
  const result = await generateRecap(root, recapConfig, session, 1, new AbortController().signal);
  assert.equal(result.kind, 'ok');
  assert.equal(result.text, '把回顾开关加进了设置页，构建通过，测试还有一条失败，另外还要刷新页面确认位置，顺手清理了临时文件，同时确认了重启之后回顾还在，再把设置页的文案同步成英文', '应剥掉「这一轮」并在 80 字内按逗号断句');
  assert.ok(result.text.length <= 80);
});

await check('F② 元叙述开头被剥掉（回顾这一轮：…）', async () => {
  const { root, llm } = harness();
  llm.recapText = '回顾这一轮：翻页已生效，往上能一直翻到头';
  const session = makeTurn(root, 'recap-meta');
  const result = await generateRecap(root, recapConfig, session, 1, new AbortController().signal);
  assert.equal(result.kind, 'ok');
  assert.equal(result.text, '翻页已生效，往上能一直翻到头');
});

await check('F③ 哨兵「无变化」⇒ no_change（不落库、不显示）', async () => {
  for (const reply of ['无', '无变化。', 'none']) {
    const { root, llm } = harness();
    llm.recapText = reply;
    const session = makeTurn(root, `recap-none-${reply.length}`);
    const result = await generateRecap(root, recapConfig, session, 1, new AbortController().signal);
    assert.equal(result.kind, 'no_change', `「${reply}」应判为无变化`);
  }
});

// ── D：开关关闭 = 整条链路静默 ────────────────────────────────
await check('D recapEnabled=false ⇒ 不生成、不调用、载荷无回顾内容', async () => {
  const { root, settings, llm } = harness({ recapEnabled: false });
  await ready(settings);
  makeTurn(root, 'recap-off');
  const suggested = await waitFor(() => {
    const push = settings.pushes.find((payload) => payload.prediction?.outcome === 'suggested');
    return suggestedCandidate(push);
  });
  assert.ok(
    suggested,
    `预测链路应照常工作（calls=${llm.calls.length} pushes=${JSON.stringify(settings.pushes.map((p) => ({
      outcome: p.prediction?.outcome,
      error: p.error,
      recaps: Array.isArray(p.recaps) ? p.recaps.length : p.recaps,
    })))}）`,
  );
  assert.equal(llm.calls.length, 1, '只有预测那一次调用');
  assert.equal(settings.pushes.some((payload) => Array.isArray(payload.recaps) && payload.recaps.length > 0), false);
});

function suggestedCandidate(push) {
  return push?.prediction?.outcome === 'suggested' ? push : undefined;
}

// ── G：没有变化的回合不显示 ───────────────────────────────────
await check('G 回顾正文是哨兵 ⇒ 线路不产生任何回顾推送', async () => {
  const { root, settings, llm } = harness();
  await ready(settings);
  llm.recapText = '无变化';
  makeTurn(root, 'recap-quiet');
  // 等预测链路先跑完，确认它的推送已经到达（避免把「还没跑完」误当成「没回顾」）。
  const suggested = await waitFor(() => suggestedCandidate(settings.push));
  assert.ok(suggested, `预测链路应照常工作（calls=${llm.calls.length}）`);
  await sleep(100);
  assert.equal(
    settings.pushes.some((payload) => Array.isArray(payload.recaps) && payload.recaps.length > 0),
    false,
    '无变化的回合不应推送回顾',
  );
});

// ── E：持久化（真实 storage 栈，两个「进程」）──────────────────
await check('E 回顾落盘 → 重新装配后 list 恢复', async () => {
  const mediumRoot = mkdtempSync(join(tmpdir(), 'dsh-recap-e2e-'));
  const root = new Context();
  if (root.logger === undefined) root.logger = console;
  new Storage(root);
  storageJson.apply(root, { root: mediumRoot });
  await storageDomain.apply(root, { backend: 'json' });
  const mediumFile = join(mediumRoot, 'suggest_ghost_recap.json');
  const record = { sessionId: 's1', turn: 1, text: RECAP_TEXT, at: 1_700_000_000_000, toolCalls: 2 };
  {
    const store = setupRecapStore(root);
    await store.whenReady;
    assert.equal(store.has('s1', 1), false);
    store.put(record);
    await store.flush();
    await store.close();
    const medium = JSON.parse(readFileSync(mediumFile, 'utf8'));
    assert.equal(medium.unit.name, 'suggest_ghost_recap');
    assert.equal(medium.unit.version, 1);
    const rows = Object.values(medium.tables.entries);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sessionId, 's1');
    assert.equal(rows[0].text, RECAP_TEXT);
  }
  {
    const store = setupRecapStore(root);
    await store.whenReady;
    assert.equal(store.has('s1', 1), true);
    assert.deepEqual(store.list('s1'), [{ turn: 1, text: RECAP_TEXT }]);
    assert.equal(store.list('other'), null);
    await store.close();
  }
  console.log('✅ e2e：回顾落盘与恢复正确', mediumFile);
});

const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) {
  if (entry.ok) console.log(`✅ ${entry.name}`);
  else console.log(`❌ ${entry.name}\n   ${entry.error}`);
}
console.log(`${checks.length - failed.length}/${checks.length} 项通过`);
// 宿主侧的定时器（`_ops` 泵、落盘去抖）会一直挂住事件循环，显式退出。
process.exit(failed.length > 0 ? 1 : 0);
