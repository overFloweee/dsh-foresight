// 切片 2（生命周期与传输）端到端：触发、缓存/在途复用、作废、consume、协议 v2 对账。
//
// 测的是编译产物（src 内部用 .js 说明符，strip-types 无法直接加载）。
// 用法：pnpm build && node scripts/prediction-slice2-e2e.mjs
//
// 真实部分：cordis Context、SessionStore、SessionProjectionRegistry、插件 `apply()`、
// 会话事件流、fork 与清理。桩只替换两处外部面——`llm.stream`（不联网）与
// `settings`（内存文档，替代 settings 存储）——因此不落盘、不依赖桌面宿主。
//
// 覆盖：
//   ① live 触发：completed 回合生成建议，经 `_push` 协议 v2 下发（protocol/route/prediction）；
//   ② 模型调用形态：路由继承父请求头、tools=[] 且无 toolHistory、末位消息=预测请求文本；
//   ③ catch_up：终态缓存命中不重复调模型，nonce 原样回带；
//   ④ 在途复用：同键第二次请求记 in_flight_reused、不新增模型调用，nonce 保留到终态；
//   ⑤ turn/start 作废旧回合结果：stale_source + 建议清空；
//   ⑥ 自激守卫：预测请求文本不进历史环，子会话清理干净；
//   ⑦ consume：采纳回执清空建议且不再重新生成；
//   ⑧ llmEnabled 关闭：作废并推送 ineligible(llm_disabled)；
//   ⑨ 失败路径：tool-call 结束 ⇒ failed/tool_call 且错误摘要随载荷下发；
//   ⑩ 启动对账：v2 载荷不恢复建议，v1（无 protocol）载荷仍恢复；
//   ⑪ `_ops` 消费回执 opsAck；⑫ 条件清空不吞新批次（复核反例 #1）；
//   ⑬ 作废后同键不得复用已取消的旧流、旧结果不得成为终态缓存（复核反例 #5）。
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { apply } from '../lib/index.js';
import { EMPTY_PUSH, SUGGEST_GHOST_NAMESPACE as NS } from '../lib/settings.js';
import { livePredictionChildCount } from '../lib/prediction.js';

const SUGGESTED_TEXT = '下一条建议：先看灰度面板';
const SUGGESTED_JSON = JSON.stringify({ suggestion: SUGGESTED_TEXT });

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

/**
 * 未捕获异常 / 未处理 rejection 收集。
 *
 * 2026-10-19 桌面宿主真实崩溃（crash-…-host.log：`cannot get required service
 * "sessions" in inactive context`，栈在 `pushState → statePushOf →
 * currentSuggestionFor`）就是「插件卸载后，在途预测的迟到结果继续推送」。
 * Node 默认把 unhandledRejection 当致命错误退出，与宿主 `host exited with 1`
 * 同形；这里先接管，让回归断言能指出漏闸门的链路，而不是把测试进程带走。
 */
const unhandled = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push(reason);
});
process.on('uncaughtException', (error) => {
  unhandled.push(error);
});

/** 轮询真实信号（事件驱动，不用固定 sleep 等结果）；超时返回 undefined。 */
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

/** 内存 settings 服务：describe/update 与宿主同形，`_push`/`_ops` 就是文档字段。 */
class SettingsStub extends Service {
  constructor(ctx, value = {}) {
    super(ctx, 'settings');
    this.value = { ...value };
    this.updates = [];
    this.rev = 0;
    this.describes = 0;
    // 复核反例 #1 的时序复现：把「清空 `_ops`」那次写入挂起，期间写入新批次。
    this.holdOpsClear = false;
    this.pendingClears = 0;
    this.clearGates = [];
    /** 让条件清空**持续失败**（模拟 revision 竞争一直存在：另一个页面在写同一个文档）。
     * 真机表现：`_ops` 一直不清、revision 只涨不落、client 的待确认集合长期送不出去。 */
    this.failOpsClear = false;
    /** 条件清空的尝试次数（host 主动发起写入的口径，不看成功与否）。 */
    this.clearAttempts = 0;
  }
  async describe() {
    this.describes += 1;
    // revision 必须回带：宿主用 describe 拿到的 revision 做条件写。
    return [{ ns: NS, value: { ...this.value }, revision: this.rev }];
  }
  async update(ns, patch, expected) {
    const isOpsClear = patch !== null && typeof patch === 'object' && patch._ops === EMPTY_PUSH;
    if (isOpsClear) this.clearAttempts += 1;
    if (this.failOpsClear && isOpsClear) {
      // 注意**不改** `this.rev`：真实场景里那次并发写入改的是别的字段，`_ops` 载荷
      // 原样保留——于是 host 下一拍仍看到「已消费但未清空」的同一载荷，必须重试。
      const error = new Error('settings revision mismatch (simulated concurrent write)');
      error.name = 'SettingsRevisionMismatch';
      throw error;
    }
    if (this.holdOpsClear && isOpsClear) {
      this.pendingClears += 1;
      await new Promise((resolve) => this.clearGates.push(resolve));
      this.pendingClears -= 1;
    }
    // 条件写：与真实 settings 服务同形（revision 不匹配 ⇒ 拒绝本次写入）。
    if (typeof expected === 'number' && expected !== this.rev) {
      const error = new Error(`settings revision mismatch (expected ${expected}, actual ${this.rev})`);
      error.name = 'SettingsRevisionMismatch';
      throw error;
    }
    this.rev += 1;
    this.updates.push({ ns, patch, expected });
    if (patch !== null && typeof patch === 'object') this.value = { ...this.value, ...patch };
  }
  releaseClears() {
    const gates = this.clearGates;
    this.clearGates = [];
    for (const gate of gates) gate();
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
  /** host 真正推上来的载荷（区别于文档初值：初值不是一次推送）。 */
  get pushes() {
    return this.updates
      .filter((update) => update.patch !== null && typeof update.patch === 'object' && '_push' in update.patch)
      .map((update) => {
        try {
          return JSON.parse(update.patch._push);
        } catch {
          return null;
        }
      });
  }
  setDoc(patch) {
    this.rev += 1; // 视作一次 client 写入（真实客户端经 mutate，同样抬 revision）
    this.value = { ...this.value, ...patch };
  }
  setOps(ops, rev) {
    this.setDoc({ _ops: JSON.stringify({ rev, ops }) });
  }
}

/** 桩 llm 服务：记录每次 stream 的 options；`pending` 可挂起（测在途复用）。 */
class LlmStub extends Service {
  constructor(ctx) {
    super(ctx, 'llm');
    this.calls = [];
    this.behavior = 'text';
    this.gates = [];
  }
  async *stream(options) {
    this.calls.push(options);
    if (this.behavior === 'pending') {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      this.gates.push(release);
      await gate;
    }
    const chunks = this.behavior === 'tool' ? toolChunks() : okChunks(SUGGESTED_JSON);
    for (const chunk of chunks) yield chunk;
  }
  releaseAll() {
    const gates = this.gates;
    this.gates = [];
    for (const release of gates) release();
  }
  /** 只释放**最早**挂起的那次调用（复现「旧请求先结束、新请求仍在途」的时序）。 */
  releaseFirst() {
    const release = this.gates.shift();
    if (release !== undefined) release();
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
  // 回顾（recap）是独立链路：本文件断言的 llm.calls 数量全是预测调用，关闭回顾
  // 才能让「一次回合=一次模型调用」这个判据保持成立（回顾另有 recap-e2e 覆盖）。
  recapEnabled: false,
  historyEnabled: true,
  historyCrossSession: false,
  historyMaxEntries: 50,
  historyMinChars: 1,
  wordAccept: true,
  acceptKey: 'Tab',
  _ops: 'null',
  _push: EMPTY_PUSH,
};

/** 起一套宿主：真 Context + 真 store/registry + 桩 llm/settings + 插件 apply()。 */
/** storageDomain 桩：存取都在内存（不落盘），只为兑现「域可用」这一支。
 *
 * 必要性：`setupHotnessPersistence` 的 `whenReady` 只在 `ctx.inject(['storageDomain'])`
 * 的回调里兑现（`src/hotness-store.ts:157-191`），宿主没有该服务时**永不兑现**；
 * 而 `src/index.ts:469-471` 的启动对账推送 `await persistence.whenReady` 之后才发，
 * 于是没有它就没有启动推送（⑩ 实测：pushes 为空）。 */
class StorageDomainStub extends Service {
  constructor(ctx) {
    super(ctx, 'storageDomain');
  }
  async open() {
    const rows = [];
    return {
      table: () => ({
        entries: () => rows.map((record, index) => [String(index), record]),
        put: async (_key, record) => { rows.push(record); },
        delete: async () => {},
      }),
      close: async () => {},
    };
  }
}

function harness(initialDoc = {}) {
  const root = new Context();
  new SessionStore(root);
  new SessionProjectionRegistry(root);
  new StorageDomainStub(root);
  const settings = new SettingsStub(root, initialDoc);
  const llm = new LlmStub(root);
  // 必须挂在 **root** 上：cordis 的 emit 只向祖先冒泡，会话事件由 session 自己的
  // ctx 向上发到 root；挂在 `root.plugin(...)` 的子 fiber 上会永远收不到
  // `session/event`（实测：live 触发不动作，只有 `_ops` 泵能工作）。
  apply(root, CONFIG);
  return { root, settings, llm, fiber: null };
}

/** 造父会话：一个已完成回合，带 request/header 路由（可指定 effort）。 */
function makeParent(root, id, options = {}) {
  const meta = { cwd: process.cwd(), ...(options.origin === undefined ? {} : { origin: options.origin }) };
  const session = root.sessions.create(id, { meta });
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('request/header', {
    header: {
      config: {
        provider: options.provider ?? 'demo-gateway',
        model: options.model ?? 'deepseek/deepseek-flash',
        ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
      },
      tools: [{ name: 'probe_read', description: '读取记录', parameters: { type: 'object' } }],
    },
    reason: 'initial',
  });
  session.append('user/message', createUserMessage({ content: text('部署服务'), source: { kind: 'user' } }), {
    surfaceOp: 'append',
  });
  session.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: text('先按 1% 灰度，错误率超 1% 回滚。'),
        source: { kind: 'model', provider: options.provider ?? 'demo-gateway', model: options.model ?? 'deepseek/deepseek-flash' },
      }),
      stream: [],
    },
    { surfaceOp: 'append' },
  );
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  return session;
}

/** 追加一个完整回合（用户消息 + 助手回复 + turn/end completed）。 */
function appendTurn(session, turn, prompt, reply) {
  session.append('turn/start', { turn });
  session.append('step/start', { turn, step: 1 });
  session.append('user/message', createUserMessage({ content: text(prompt), source: { kind: 'user' } }), {
    surfaceOp: 'append',
  });
  session.append(
    'assistant/message',
    {
      turn,
      step: 1,
      message: createAssistantMessage({
        content: text(reply),
        source: { kind: 'model', provider: 'demo-gateway', model: 'deepseek/deepseek-flash' },
      }),
      stream: [],
    },
    { surfaceOp: 'append' },
  );
  session.append('step/end', { turn, step: 1 });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
}

const settled = (settings, turn) =>
  waitFor(() =>
    settings.push?.prediction?.outcome === 'suggested' && settings.push.prediction.sourceTurn === turn
      ? settings.push
      : undefined,
  );

/**
 * 等到插件真正接好线再驱动事件：`_ops` 泵的第一拍 `describe()` 证明 settings 注入
 * 回调已执行（`settingsSvc` 已就位、泵已起表）。此前创建会话会让 turn/end 领先于
 * 注入回调，推送无处可写——实测症状是「live 触发整个不发生」。
 */
async function ready(settings) {
  // 用一次真实 pull 往返证明**泵已经在消费 `_ops`**：`describes>0` 不够——启动对账
  // （seedPersistedSuggestion）也会 describe，可能在第一拍之前就把计数抬起来；那样
  // 后续的配置变更会发生在首拍之前，被「首次观测」吞掉（实测踩到）。
  settings.setOps([{ op: 'pull', sessionId: 'readiness-probe', nonce: 'ready-1', id: 'ready' }], 0);
  const ok = await waitFor(() => (settings.push?.nonce === 'ready-1' ? true : undefined), 6000);
  if (ok === undefined) {
    console.log('   DIAG-ready', JSON.stringify({
      describes: settings.describes,
      rev: settings.rev,
      doc: settings.value,
      updates: settings.updates.slice(-6),
    }));
  }
  assert.ok(ok, 'settings/_ops 泵未应答（inject 回调或泵未起表）');
  // 让同一批微任务里的其余注入回调（sessionProjections 单元注册）落地。
  await sleep(50);
}

const fibers = [];
async function disposeAll() {
  for (const fiber of fibers.splice(0)) {
    try {
      await fiber.dispose();
    } catch {
      /* 清理失败不改变断言结论 */
    }
  }
}

// ---------- ① ～ ⑦ live 触发、缓存与在途复用、作废、consume ----------
{
  const { root, settings, llm, fiber } = harness();
  fibers.push(fiber);
  await ready(settings);
  const parent = makeParent(root, 'session-slice2-a', { reasoningEffort: 'max' });

  await check('① live 触发：completed 回合生成建议并下发 v2 载荷', async () => {
    const push = await settled(settings, 1);
    assert.ok(push !== undefined, '未等到 suggested');
    assert.equal(push.protocol, 2, '协议版本必须是 2');
    assert.equal(push.suggestion?.text, SUGGESTED_TEXT);
    assert.equal(push.suggestionSessionId, parent.id);
    assert.equal(push.prediction.sessionId, parent.id);
    assert.equal(push.prediction.sourceTurn, 1);
    assert.equal(push.prediction.outcome, 'suggested');
    assert.equal(typeof push.prediction.requestKey, 'string');
    assert.equal(push.route.provider, 'demo-gateway');
    assert.equal(push.route.model, 'deepseek/deepseek-flash');
    assert.equal(push.route.source, 'inherited', '未配置预测档时必须继承父会话档');
    assert.equal(push.route.effectiveEffort, 'max');
  });

  await check('② 模型调用形态：继承父路由、tools=[]、末位消息=预测请求文本', async () => {
    assert.equal(llm.calls.length, 1);
    const options = llm.calls[0];
    assert.equal(options.provider, 'demo-gateway');
    assert.equal(options.model, 'deepseek/deepseek-flash');
    assert.equal(options.reasoningEffort, 'max');
    assert.deepEqual(options.tools, []);
    assert.equal(options.toolHistory, undefined, '不得传 toolHistory');
    const last = options.messages.at(-1);
    const lastText = (last.content ?? []).map((block) => block.text).join('');
    assert.ok(lastText.includes('This is an app-generated request for a suggested next user message'));
    assert.ok(lastText.includes('Return only JSON matching this schema'));
    assert.equal(options.sessionId.startsWith('dsh-foresight/prediction/'), true);
  });

  await check('③ catch_up 复用终态缓存：不重复调模型，nonce 原样回带', async () => {
    const key = settings.push.prediction.requestKey;
    settings.setOps([{ op: 'pull', sessionId: parent.id, requestPrediction: true, nonce: 'nonce-1', id: 'op-1' }], 1);
    const push = await waitFor(() => (settings.push?.prediction?.nonce === 'nonce-1' ? settings.push : undefined));
    assert.ok(push !== undefined, '未等到 nonce 回执');
    assert.equal(llm.calls.length, 1, '终态缓存命中不得再调模型');
    assert.equal(push.prediction.requestKey, key);
    assert.equal(push.suggestion?.text, SUGGESTED_TEXT);
  });

  await check('④ 在途复用：同键第二次请求记 in_flight_reused，只调一次模型', async () => {
    llm.behavior = 'pending';
    appendTurn(parent, 2, '继续', '好');
    const started = await waitFor(() =>
      settings.push?.prediction?.outcome === 'started' && settings.push.prediction.sourceTurn === 2
        ? settings.push
        : undefined,
    );
    assert.ok(started !== undefined, '未等到第二回合的 started');
    const callsBefore = llm.calls.length;
    settings.setOps([{ op: 'pull', sessionId: parent.id, requestPrediction: true, nonce: 'nonce-2', id: 'op-2' }], 2);
    const reused = await waitFor(() =>
      settings.push?.prediction?.outcome === 'in_flight_reused' ? settings.push : undefined,
    );
    assert.ok(reused !== undefined, '未等到 in_flight_reused');
    assert.equal(llm.calls.length, callsBefore, '在途复用不得新增模型调用');
    llm.behavior = 'text';
    llm.releaseAll();
    const done = await settled(settings, 2);
    assert.ok(done !== undefined, '未等到第二回合 suggested');
    assert.equal(done.prediction.nonce, 'nonce-2', 'nonce 必须保留到终态推送');
    assert.equal(done.suggestion?.text, SUGGESTED_TEXT);
  });

  await check('⑤ turn/start 作废旧结果：stale_source + 建议清空', async () => {
    parent.append('turn/start', { turn: 3 });
    const stale = await waitFor(() =>
      settings.push?.prediction?.outcome === 'stale_source' && settings.push.prediction.sourceTurn === 2
        ? settings.push
        : undefined,
    );
    assert.ok(stale !== undefined, '未等到 stale_source');
    assert.equal(stale.suggestion, null, '作废后不得继续显示旧建议');
  });

  await check('⑥ 自激守卫：预测请求文本不进历史环，子会话清理干净', async () => {
    assert.equal(livePredictionChildCount(), 0, '预测子会话必须已释放');
    appendTurn(parent, 3, '再看延迟', 'P99 已回落');
    const push3 = await settled(settings, 3);
    assert.ok(push3 !== undefined, '未等到第三回合 suggested');
    settings.setOps([{ op: 'pull', sessionId: parent.id, nonce: 'nonce-3', id: 'op-3' }], 3);
    const pull = await waitFor(() => (settings.push?.prediction?.nonce === 'nonce-3' ? settings.push : undefined));
    assert.ok(pull !== undefined, '未等到 pull 应答');
    const history = Array.isArray(pull.history) ? pull.history : [];
    assert.equal(
      history.some((entry) => String(entry).includes('app-generated request')),
      false,
      '预测请求文本不得进入历史环',
    );
  });

  await check('⑦ consume：采纳回执清空建议且不再重新生成', async () => {
    const key = settings.push.prediction.requestKey;
    const callsBefore = llm.calls.length;
    settings.setOps([{ op: 'consume', sessionId: parent.id, requestKey: key, id: 'op-4' }], 4);
    const consumed = await waitFor(() =>
      settings.push?.prediction?.outcome === 'consumed' ? settings.push : undefined,
    );
    assert.ok(consumed !== undefined, '未等到 consumed');
    assert.equal(consumed.suggestion, null);
    settings.setOps([{ op: 'pull', sessionId: parent.id, requestPrediction: true, nonce: 'nonce-4', id: 'op-5' }], 5);
    const after = await waitFor(() => (settings.push?.prediction?.nonce === 'nonce-4' ? settings.push : undefined));
    assert.ok(after !== undefined, '未等到 consume 后的 pull 应答');
    assert.equal(llm.calls.length, callsBefore, 'consume 是终态，不得重新生成');
    assert.equal(after.suggestion, null);
  });
}

// ---------- ⑧ 配置身份变化 ----------
{
  const { root, settings, fiber } = harness();
  fibers.push(fiber);
  await ready(settings);
  makeParent(root, 'session-slice2-b', { reasoningEffort: 'max' });

  await check('⑧ llmEnabled 关闭：作废并推送 ineligible(llm_disabled)', async () => {
    const first = await settled(settings, 1);
    assert.ok(first !== undefined, '未等到首个 suggested');
    settings.setDoc({ llmEnabled: false });
    const push = await waitFor(
      () =>
        settings.push?.prediction?.outcome === 'ineligible' && settings.push.prediction.reason === 'llm_disabled'
          ? settings.push
          : undefined,
      6000,
    );
    if (push === undefined) {
      console.log('   DIAG⑧', JSON.stringify({
        describes: settings.describes,
        llmEnabled: settings.value.llmEnabled,
        pushes: settings.pushes.slice(-8).map((p) => ({
          outcome: p?.prediction?.outcome,
          reason: p?.prediction?.reason,
          protocol: p?.protocol,
        })),
      }));
    }
    assert.ok(push !== undefined, '未等到 ineligible(llm_disabled)');
    assert.equal(push.suggestion, null);
  });
}

// ---------- ⑨ 失败路径 ----------
{
  const { root, settings, llm, fiber } = harness();
  fibers.push(fiber);
  llm.behavior = 'tool';
  await ready(settings);
  makeParent(root, 'session-slice2-c', { reasoningEffort: 'max' });

  await check('⑨ tool-call 结束 ⇒ failed/tool_call 且错误摘要随载荷下发', async () => {
    const push = await waitFor(() =>
      settings.push?.prediction?.outcome === 'failed' ? settings.push : undefined,
    );
    assert.ok(push !== undefined, '未等到 failed');
    assert.equal(push.prediction.reason, 'tool_call');
    assert.equal(push.suggestion, null);
    assert.equal(typeof push.error, 'string', '失败必须带可见错误摘要');
    assert.ok(push.error.includes('tool_call'), `error=${push.error}`);
  });
}

// ---------- ⑪～⑬ `_ops` 投递与作废边界（独立复核反例 #1 / #5） ----------
{
  const { root, settings, llm, fiber } = harness();
  fibers.push(fiber);
  const parent = makeParent(root, 'session-boundary');
  await ready(settings);

  await check('⑪ 消费回执：本批 pull/consume 的操作 id 随推送回带（opsAck）', async () => {
    settings.setOps([{ op: 'pull', sessionId: parent.id, nonce: 'ack-nonce', id: 'op-ack-1' }], 100);
    const acked = await waitFor(() =>
      settings.pushes.find((push) => Array.isArray(push?.opsAck) && push.opsAck.includes('op-ack-1')),
    );
    assert.ok(acked !== undefined, 'pull 的 id 必须随一次推送回带（opsAck）');
    assert.equal(acked.nonce, 'ack-nonce', '同一拍还要回带 nonce');
    const key = acked.prediction?.requestKey;
    assert.equal(typeof key, 'string', 'pull 应答必须带预测记录（含 requestKey）');
    settings.setOps([{ op: 'consume', sessionId: parent.id, requestKey: key, id: 'op-ack-2' }], 101);
    const acked2 = await waitFor(() =>
      settings.pushes.find((push) => Array.isArray(push?.opsAck) && push.opsAck.includes('op-ack-2')),
    );
    assert.ok(acked2 !== undefined, 'consume 的 id 也必须被确认');
  });

  await check('⑫ 反例 #1：消费期间写入的新批次不会被旧清空吞掉（条件清空）', async () => {
    // 让「清空 `_ops`」的那次写入挂起 ⇒ 复现复核者的时序：旧清空在途、期间 client 写新批次。
    settings.holdOpsClear = true;
    settings.setOps([{ op: 'pull', sessionId: parent.id, nonce: 'cas-1', id: 'op-cas-1' }], 200);
    const held = await waitFor(() => (settings.pendingClears > 0 ? true : undefined), 5000);
    assert.ok(held === true, '未观察到挂起的清空写入（反例前提不成立）');
    settings.setOps([{ op: 'pull', sessionId: parent.id, nonce: 'cas-2', id: 'op-cas-2' }], 201);
    settings.holdOpsClear = false;
    settings.releaseClears();
    const answered = await waitFor(() => (settings.push?.nonce === 'cas-2' ? settings.push : undefined), 6000);
    assert.ok(answered !== undefined, '新批次必须仍被消费并应答（被旧清空吞掉即失败）');
    assert.equal(
      settings.updates.some((u) => u.patch?._ops === EMPTY_PUSH && typeof u.expected === 'number'),
      true,
      '清空必须是带 expectedRevision 的条件写',
    );
  });

  await check('⑬ 反例 #5：作废后同键请求不得复用已取消的旧流、也不得留下可命中缓存', async () => {
    llm.behavior = 'pending';
    appendTurn(parent, 2, '继续', '好');
    const started = await waitFor(() =>
      settings.push?.prediction?.outcome === 'started' && settings.push.prediction.sourceTurn === 2
        ? settings.push
        : undefined,
    );
    assert.ok(started !== undefined, '未等到回合 2 的 started');
    const callsAfterStart = llm.calls.length;
    settings.setDoc({ llmEnabled: false });
    const disabled = await waitFor(() =>
      settings.push?.prediction?.outcome === 'ineligible' ? settings.push : undefined,
    );
    assert.ok(disabled !== undefined, '关闭预测必须作废并推送 ineligible');
    settings.setDoc({ llmEnabled: true });
    await waitFor(() =>
      settings.push?.prediction?.outcome === 'stale_source' ? settings.push : undefined,
      5000,
    );
    settings.setOps([{ op: 'pull', sessionId: parent.id, requestPrediction: true, nonce: 'reopen-1', id: 'op-reopen' }], 300);
    const restarted = await waitFor(() => (llm.calls.length > callsAfterStart ? true : undefined), 6000);
    assert.ok(restarted === true, '重新开启后必须重新发起模型调用（复用已取消的旧流即失败）');
    llm.behavior = 'text';
    llm.releaseAll();
    const done = await settled(settings, 2);
    assert.ok(done !== undefined, '重新开启后必须能产出 suggested（旧 cancelled 不得成为终态缓存）');
  });

  await check('⑭ 反例 #6：旧请求的回调不得删掉新请求的取消句柄', async () => {
    llm.behavior = 'pending';
    appendTurn(parent, 3, '第三次', '好');
    const startedOld = await waitFor(() =>
      settings.push?.prediction?.outcome === 'started' && settings.push.prediction.sourceTurn === 3
        ? settings.push
        : undefined,
    );
    assert.ok(startedOld !== undefined, '未等到回合 3 的 started（旧请求）');
    const oldCall = llm.calls.length - 1;

    // 关闭 → 重新开启 → 同源 catch_up：同一个 requestKey 的**第二个**在途请求。
    settings.setDoc({ llmEnabled: false });
    await waitFor(() => (settings.push?.prediction?.outcome === 'ineligible' ? settings.push : undefined));
    settings.setDoc({ llmEnabled: true });
    await waitFor(() => (settings.push?.prediction?.outcome === 'stale_source' ? settings.push : undefined), 5000);
    settings.setOps(
      [{ op: 'pull', sessionId: parent.id, requestPrediction: true, nonce: 'reopen-6', id: 'op-reopen-6' }],
      500,
    );
    const restarted = await waitFor(() => (llm.calls.length > oldCall + 1 ? true : undefined), 6000);
    assert.ok(restarted === true, '未发起同键的新请求');
    const newCall = llm.calls.length - 1;
    assert.equal(llm.calls[oldCall].signal.aborted, true, '旧请求应已因关闭预测而被中止');
    assert.equal(llm.calls[newCall].signal.aborted, false, '新请求此时应在途');

    // 只释放**旧**请求：它的回调必须只清理自己的句柄，不能删掉新请求的 controller。
    llm.releaseFirst();
    await sleep(50);
    // 父会话开始新回合 ⇒ 作废并 abort 当前在途请求（也就是新请求）。
    appendTurn(parent, 4, '第四次', '嗯');
    await sleep(50);
    assert.equal(
      llm.calls[newCall].signal.aborted,
      true,
      '新请求必须仍受取消控制（旧回调删掉它的句柄即失败）',
    );
    llm.behavior = 'text';
    llm.releaseAll();
  });
}

// ---------- ⑮～⑯ 粘性回执与清空重试（真机 2026-10-14 实测的两个卡点） ----------
{
  await check('⑮ 粘性 opsAck：清空一直失败时，后续每一拍推送都带着未确认的操作 id', async () => {
    const { root, settings } = harness();
    settings.failOpsClear = true; // 清空持续失败 ⇒ `_ops` 里两条 id 都还在
    makeParent(root, 'session-ack');
    await ready(settings);

    // 第一拍：一条 pull。回执必须送达（client 靠它把操作移出待确认集合）。
    settings.setOps(
      [{ op: 'pull', sessionId: 'session-ack', nonce: 'ack-1', id: 'op-1' }],
      1,
    );
    const first = await waitFor(
      () => settings.pushes.find((push) => push?.opsAck?.includes('op-1')) ?? undefined,
      6000,
    );
    assert.ok(first !== undefined, '第一拍 pull 的回执必须送达');

    // 第二拍：client 把**未确认项合并**后整批重写（真实 client 的行为），新 id 与旧 id 同批。
    settings.setOps(
      [
        { op: 'pull', sessionId: 'session-ack', nonce: 'ack-1', id: 'op-1' },
        { op: 'pull', sessionId: 'session-ack', nonce: 'ack-2', id: 'op-2' },
      ],
      2,
    );
    const second = await waitFor(
      () => settings.pushes.find((push) => push?.opsAck?.includes('op-2')) ?? undefined,
      6000,
    );
    assert.ok(second !== undefined, '第二拍 pull 的回执必须送达');
    assert.ok(
      second.opsAck.includes('op-1'),
      '旧回执必须**粘住**：只挂一拍就丢的话，那拍推送若被去重/写失败跳过，client 永远确认不了',
    );
    assert.ok(second.opsAck.includes('op-2'), '新回执必须同拍带上');
  });

  await check('⑯ 清空重试：条件清空失败后，载荷不变也会再试并最终清空 `_ops`', async () => {
    const { root, settings } = harness();
    settings.failOpsClear = true;
    makeParent(root, 'session-clear');
    await ready(settings);
    settings.setOps(
      [{ op: 'pull', sessionId: 'session-clear', nonce: 'clear-1', id: 'clear-op' }],
      1,
    );
    await waitFor(() => (settings.push?.nonce === 'clear-1' ? true : undefined), 6000);

    // 载荷自那以后没变化 ⇒ 不会再走 consume 分支，只有 else 分支的重试能救它。
    const retried = await waitFor(() => (settings.clearAttempts >= 2 ? true : undefined), 8000);
    assert.ok(
      retried === true,
      `清空失败后必须重试（实测尝试次数 ${settings.clearAttempts}；真机上这里不重试就是 \`_ops\` 一直积压）`,
    );
    assert.notEqual(
      settings.value._ops,
      EMPTY_PUSH,
      '失败期间 `_ops` 必须原样保留：清空失败不能把未消费批次吞掉',
    );

    settings.failOpsClear = false; // 竞争消失（另一个页面写完了）
    const cleared = await waitFor(() => (settings.value._ops === EMPTY_PUSH ? true : undefined), 8000);
    assert.ok(cleared === true, '竞争消失后必须把 `_ops` 清空');
  });
}

// ---------- ⑩ 启动对账（协议 v2 不恢复、v1 仍恢复） ----------
{
  await check('⑩ 启动对账：v1 载荷恢复旧建议、v2 载荷不恢复', async () => {
    // 盘上载荷的真实形状：`suggestion` 是**结构化对象**（`parsePersistedPush` 校验
    // turn/baseSeq/text/truncated/acceptKey），不是字符串。
    const legacySuggestion = { version: 1, turn: 1, baseSeq: 4, text: '旧建议', truncated: false, acceptKey: 'Tab' };
    const modernSuggestion = { version: 1, turn: 1, baseSeq: 4, text: '不该恢复', truncated: false, acceptKey: 'Tab' };
    const legacy = harness({
      _push: JSON.stringify({ suggestion: legacySuggestion, suggestionSessionId: 'session-legacy' }),
    });
    // 恢复出来的建议要能通过 `suggestionIsCurrent`（turn 必须等于该会话最后一个
    // completed 回合），所以这里给会话补一个真实的 turn 1。
    makeParent(legacy.root, 'session-legacy');
    const restored = await waitFor(
      () => legacy.settings.pushes.find((push) => push?.suggestion?.text === '旧建议'),
      5000,
    );
    if (restored === undefined) {
      const legacySession = legacy.root.sessions.get('session-legacy');
      console.log('   DIAG⑩', JSON.stringify({
        pushes: legacy.settings.pushes,
        seq: legacySession?.seq,
        doc: legacy.settings.value,
      }));
    }
    assert.ok(restored !== undefined, 'v1（无 protocol）载荷应恢复旧建议');

    const modern = harness({
      _push: JSON.stringify({ protocol: 2, suggestion: modernSuggestion, suggestionSessionId: 'session-modern' }),
    });
    makeParent(modern.root, 'session-modern');
    const startPushes = await waitFor(
      () => (modern.settings.pushes.length > 0 ? modern.settings.pushes : undefined),
      5000,
    );
    assert.ok(startPushes !== undefined, 'v2 启动对账仍必须推一次（epoch 是「宿主换人」的唯一信号）');
    assert.equal(
      startPushes.some((push) => push?.suggestion?.text === '不该恢复'),
      false,
      'v2 载荷必须按规范 §6 不恢复',
    );
    assert.equal(
      startPushes.every((push) => push?.protocol === 2 && push.suggestion === null),
      true,
      'v2 启动推送不得携带建议',
    );
  });
}


// ---------- ⑰ 子代理守卫：`origin: 'subagent'` 的会话不触发预测 ----------
{
  await check('⑰ 子代理会话不触发预测（origin: subagent），主会话照旧', async () => {
    const h = harness({});
    await ready(h.settings);
    makeParent(h.root, 'session-guard-main');
    const triggered = await waitFor(() => (h.llm.calls.length > 0 ? true : undefined), 5000);
    assert.ok(triggered === true, '对照组：主会话回合完成必须触发预测');
    const before = h.llm.calls.length;

    makeParent(h.root, 'sub-guard', { origin: 'subagent' });
    await sleep(400);
    assert.equal(
      h.llm.calls.length,
      before,
      '子代理会话不得触发预测：否则每个子代理回合都白烧一次全文 fork + 模型调用',
    );
    assert.equal(
      h.settings.pushes.some((push) => push?.prediction?.sessionId === 'sub-guard'),
      false,
      '子代理会话不得留下预测记录（连 ineligible 之类的噪声也不推）',
    );
  });
}

await check('⑯ 卸载竞态：在途预测的迟到结果不得崩进程、不得继续推送', async () => {
  // 真实时序：热重载/禁用插件 → `apply` 的 cleanup 中止在途 controller；
  // 但 `ctx.llm.stream` 的异步生成器可能在**中止之后**才把结果交回 `.then`，
  // 旧代码在那里无条件 `pushState()` → `statePushOf()` → `currentSuggestionFor()`
  // 读 `ctx.sessions`，而上下文已 inactive ⇒ 抛错 ⇒ 宿主进程退出
  // （2026-10-19 在真实宿主上发生过一次）。
  //
  // 这里必须把「会话 + 插件」挂在同一个子 fiber 上：`root` 本身没有 dispose，
  // 而且子 fiber 的事件才能冒泡到插件（会话挂在插件所在 ctx 上）。
  const root = new Context();
  let scope;
  let settings;
  let llm;
  const fiber = root.plugin((ctx) => {
    scope = ctx;
    new SessionStore(ctx);
    new SessionProjectionRegistry(ctx);
    new StorageDomainStub(ctx);
    settings = new SettingsStub(ctx, {});
    llm = new LlmStub(ctx);
    apply(ctx, CONFIG);
  });
  // cordis 的 plugin 组装是异步的：等服务先落地再握手。
  const mounted = await waitFor(() => (settings === undefined ? undefined : true), 3000);
  assert.ok(mounted === true, '子 fiber 上的插件应已挂载（settings 服务可读）');
  await ready(settings);
  llm.behavior = 'pending';
  makeParent(scope, 'session-dispose-race', {});
  const inFlight = await waitFor(() => (llm.calls.length > 0 ? true : undefined), 3000);
  assert.ok(inFlight === true, '预测调用应已发出（确认存在在途请求）');

  const pushesBefore = settings.updates.length;
  await Promise.race([fiber.dispose(), sleep(3000)]);
  llm.releaseAll(); // 迟到的模型结果落地（旧代码在这里崩）
  await sleep(200);

  assert.deepEqual(
    unhandled.map((error) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error))),
    [],
    '卸载竞态不得产生未捕获异常',
  );
  // 第二道判据：即使不崩，也不许把过期的终态推送出去（否则 client 会收到
  // 上一个插件实例的载荷，出现「删了插件还残留幽灵/回顾」）。
  assert.equal(
    settings.updates.length,
    pushesBefore,
    'teardown 之后不得再写 `_push`（迟到的预测结果没有闸门）',
  );
});

await disposeAll();

const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) {
  console.log(`${entry.ok ? '✅' : '❌'} ${entry.name}`);
  if (!entry.ok) console.log(`   ${entry.error}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`);
process.exit(failed.length === 0 ? 0 : 1);
