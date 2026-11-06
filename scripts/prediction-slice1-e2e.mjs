// 切片 1（生成接入）端到端：`runPrediction` 的 fork、消息面、路由继承、解析与清理。
//
// 测的是编译产物（src 内部用 .js 说明符，strip-types 无法直接加载）。
// 用法：pnpm build && node scripts/prediction-slice1-e2e.mjs
//
// llm.stream 用桩：只捕获 options 并吐预置流，不碰网络、不落盘、不写父会话日志。
// 真实部分：cordis Context、SessionStore、Session.append/deriveMessages/requestHeader、
// 短作用域 fork 与 dispose —— 只把模型那一段换成桩。
//
// 覆盖：
//   ① 请求 options：provider/model/reasoningEffort 继承父请求头、tools=[]、无 toolHistory、
//      消息面 = fork 继承 + 末尾一条预测请求消息；
//   ② 含端点 boundary：旧 endSeq 的 fork 不含之后新增的消息；
//   ③ 清理：调用后子会话从 live store 移除、在途身份移除、父会话事件逐字不变；
//   ④ 解析：suggested / abstained / empty_body / invalid_json / schema_mismatch；
//   ⑤ 官方语义：多行与超 240 字符保留原文，不首行化、不截断；
//   ⑥ 结束原因：tool-call ⇒ tool_call，max-tokens ⇒ abnormal_finish；
//   ⑦ 失败路径：无请求头 ⇒ route_unavailable，外部取消 ⇒ cancelled，超预算 ⇒ timeout；
//   ⑧ 同键登记：PredictionFlight 第二个请求复用第一个、结束后登记清空。
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  PREDICTION_PROMPT_V5,
  PREDICTION_SCHEMA_INSTRUCTION,
  predictionRequestText,
} from '../lib/prediction-prompt.js';
import {
  PredictionFlight,
  livePredictionChildCount,
  parsePredictionOutput,
  runPrediction,
} from '../lib/prediction.js';

const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
const text = value => [{ type: 'text', text: value }];
const textChunks = value => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: value },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'finish', reason: { kind: 'stop' } },
];

/** 造父会话：一个已完成回合，带 request/header（可指定是否给路由）。 */
function makeParent(root, id, options = {}) {
  const session = root.sessions.create(id, { meta: { cwd: process.cwd() } });
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  if (options.route !== false) {
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
  }
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

function lastEndSeq(session) {
  const events = session.snapshotEvents();
  const last = events.findLast(event => event.type === 'turn/end');
  assert.ok(last !== undefined, '父会话缺少 turn/end');
  return last.seq;
}

/** 桩 ctx：plugin 走真实 cordis（fork 归作用域所有），llm.stream 是桩。 */
function makeCtx(root, handler) {
  return {
    plugin: callback => root.plugin(callback),
    logger: { debug() {}, info() {}, warn() {} },
    llm: { stream: handler },
  };
}

const root = new Context();
new SessionStore(root);

// ---------- ① ② ③ 请求形态、含端点边界、清理 ----------
{
  const parent = makeParent(root, 'session-slice1-basic', { reasoningEffort: 'max' });
  const endSeq = lastEndSeq(parent);
  const captured = [];
  const before = JSON.stringify(parent.snapshotEvents());
  const ctx = makeCtx(root, async function* stream(options) {
    captured.push(options);
    yield* textChunks('{"suggestion":"查一下发布日志"}');
  });
  const result = await runPrediction(ctx, {
    session: parent,
    source: { kind: 'ok', sessionId: parent.id, turn: 1, endSeq },
    trigger: 'live',
    signal: new AbortController().signal,
    maxOutputTokens: 512,
    timeoutMs: 5000,
  });
  const options = captured[0];
  await check('① 路由完整继承父请求头', () => {
    assert.equal(options.provider, 'demo-gateway');
    assert.equal(options.model, 'deepseek/deepseek-flash');
    assert.equal(options.reasoningEffort, 'max');
  });
  await check('① tools 是空数组且不传 toolHistory', () => {
    assert.deepEqual(options.tools, []);
    assert.equal('toolHistory' in options, false);
  });
  await check('① 消息面 = 继承 +1，末位是预测请求消息', () => {
    const inherited = parent.deriveMessages().length;
    assert.equal(options.messages.length, inherited + 1);
    const last = options.messages.at(-1);
    assert.equal(last.role, 'user');
    assert.deepEqual(last.content, [{ type: 'text', text: predictionRequestText() }]);
    assert.equal(predictionRequestText(), `${PREDICTION_PROMPT_V5}\n\n${PREDICTION_SCHEMA_INSTRUCTION}`);
  });
  await check('① 结果按 suggested 返回并带源身份', () => {
    assert.equal(result.outcome, 'suggested');
    assert.equal(result.suggestion, '查一下发布日志');
    assert.equal(result.turn, 1);
    assert.equal(result.endSeq, endSeq);
    assert.equal(result.provider, 'demo-gateway');
    assert.equal(result.reasoningEffort, 'max');
  });
  await check('③ 子会话已从 live store 移除且在途身份清空', () => {
    assert.equal(root.sessions.get(result.requestId), undefined);
    assert.equal(livePredictionChildCount(), 0);
  });
  await check('③ 父会话事件逐字未变', () => {
    assert.equal(JSON.stringify(parent.snapshotEvents()), before);
  });
  // ② 旧 endSeq 的 fork 不含之后新增的消息
  parent.append('turn/start', { turn: 2 });
  parent.append('user/message', createUserMessage({ content: text('这是新回合'), source: { kind: 'user' } }), {
    surfaceOp: 'append',
  });
  const again = await runPrediction(ctx, {
    session: parent,
    source: { kind: 'ok', sessionId: parent.id, turn: 1, endSeq },
    trigger: 'catch_up',
    signal: new AbortController().signal,
    maxOutputTokens: 512,
    timeoutMs: 5000,
  });
  await check('② 旧 endSeq 的 fork 不含之后新增的消息', () => {
    assert.equal(again.outcome, 'suggested');
    assert.equal(captured[1].messages.length, options.messages.length);
  });
  await check('① 显式推理档覆盖父档位', async () => {
    await runPrediction(ctx, {
      session: parent,
      source: { kind: 'ok', sessionId: parent.id, turn: 1, endSeq },
      trigger: 'live',
      signal: new AbortController().signal,
      maxOutputTokens: 512,
      timeoutMs: 5000,
      reasoningEffort: 'high',
    });
    assert.equal(captured[2].reasoningEffort, 'high');
  });
}

// ---------- ④ ⑤ 解析语义 ----------
{
  await check('④ 空正文 ⇒ empty_body', () => {
    assert.deepEqual(parsePredictionOutput('   \n '), { kind: 'failed', reason: 'empty_body' });
  });
  await check('④ 非 JSON ⇒ invalid_json', () => {
    assert.deepEqual(parsePredictionOutput('查一下'), { kind: 'failed', reason: 'invalid_json' });
  });
  await check('④ 多余字段 ⇒ schema_mismatch', () => {
    assert.deepEqual(parsePredictionOutput('{"suggestion":"a","note":"b"}'), {
      kind: 'failed',
      reason: 'schema_mismatch',
    });
  });
  await check('④ 类型不符 ⇒ schema_mismatch', () => {
    assert.deepEqual(parsePredictionOutput('{"suggestion":42}'), { kind: 'failed', reason: 'schema_mismatch' });
  });
  await check('④ null ⇒ abstained；空串 ≡ null', () => {
    assert.deepEqual(parsePredictionOutput('{"suggestion":null}'), { kind: 'abstained' });
    assert.deepEqual(parsePredictionOutput('{"suggestion":"  "}'), { kind: 'abstained' });
  });
  await check('⑤ 多行与超 240 字符保留原文', () => {
    const long = `第一行\n第二行\n${'很长的建议'.repeat(60)}`;
    const parsed = parsePredictionOutput(JSON.stringify({ suggestion: long }));
    assert.equal(parsed.kind, 'suggested');
    assert.equal(parsed.text, long);
    assert.ok(parsed.text.includes('\n'));
    assert.ok(parsed.text.length > 240);
  });
  await check('④⑤ 端到端：abstained 与多行建议', async () => {
    const parent = makeParent(root, 'session-slice1-parse');
    const endSeq = lastEndSeq(parent);
    const cases = [
      ['{"suggestion":null}', 'abstained', null],
      ['{"suggestion":"查日志\\n并回滚"}', 'suggested', '查日志\n并回滚'],
    ];
    for (const [payload, outcome, suggestion] of cases) {
      const ctx = makeCtx(root, async function* stream() {
        yield* textChunks(payload);
      });
      const result = await runPrediction(ctx, {
        session: parent,
        source: { kind: 'ok', sessionId: parent.id, turn: 1, endSeq },
        trigger: 'live',
        signal: new AbortController().signal,
        maxOutputTokens: 512,
        timeoutMs: 5000,
      });
      assert.equal(result.outcome, outcome);
      assert.equal(result.suggestion, suggestion);
    }
  });
}

// ---------- ⑥ 结束原因 ----------
{
  const parent = makeParent(root, 'session-slice1-finish');
  const endSeq = lastEndSeq(parent);
  const runWith = async chunks =>
    runPrediction(makeCtx(root, async function* stream() {
      yield* chunks;
    }), {
      session: parent,
      source: { kind: 'ok', sessionId: parent.id, turn: 1, endSeq },
      trigger: 'live',
      signal: new AbortController().signal,
      maxOutputTokens: 512,
      timeoutMs: 5000,
    });
  await check('⑥ 出现 tool-call ⇒ tool_call', async () => {
    const result = await runWith([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: 'probe_read', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.reason, 'tool_call');
  });
  await check('⑥ max-tokens ⇒ abnormal_finish', async () => {
    const result = await runWith([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '{"suggestion":"a"}' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]);
    assert.equal(result.reason, 'abnormal_finish');
  });
}

// ---------- ⑦ 失败路径 ----------
{
  const noRoute = makeParent(root, 'session-slice1-noroute', { route: false });
  const endSeq = lastEndSeq(noRoute);
  const ctx = makeCtx(root, async function* stream() {
    throw new Error('不应被调用');
  });
  const result = await runPrediction(ctx, {
    session: noRoute,
    source: { kind: 'ok', sessionId: noRoute.id, turn: 1, endSeq },
    trigger: 'live',
    signal: new AbortController().signal,
    maxOutputTokens: 512,
    timeoutMs: 5000,
  });
  await check('⑦ 无请求头 ⇒ route_unavailable，且未调用模型', () => {
    assert.equal(result.outcome, 'failed');
    assert.equal(result.reason, 'route_unavailable');
  });

  const parent = makeParent(root, 'session-slice1-abort');
  const seg = lastEndSeq(parent);
  const controller = new AbortController();
  const cancelled = await runPrediction(
    makeCtx(root, async function* stream(options) {
      controller.abort(new Error('用户切换会话'));
      throw options.signal.reason;
    }),
    {
      session: parent,
      source: { kind: 'ok', sessionId: parent.id, turn: 1, endSeq: seg },
      trigger: 'live',
      signal: controller.signal,
      maxOutputTokens: 512,
      timeoutMs: 5000,
    },
  );
  await check('⑦ 外部取消 ⇒ cancelled（不是 failed）', () => {
    assert.equal(cancelled.outcome, 'cancelled');
    assert.equal(cancelled.suggestion, null);
  });

  const timedOut = await runPrediction(
    makeCtx(root, async function* stream(options) {
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
      yield* textChunks('{"suggestion":"永不返回"}');
    }),
    {
      session: parent,
      source: { kind: 'ok', sessionId: parent.id, turn: 1, endSeq: seg },
      trigger: 'live',
      signal: new AbortController().signal,
      maxOutputTokens: 512,
      timeoutMs: 30,
    },
  );
  await check('⑦ 超预算 ⇒ timeout（错误码 SUGGEST_GHOST_PREDICTION_TIMEOUT）', () => {
    assert.equal(timedOut.outcome, 'failed');
    assert.equal(timedOut.reason, 'timeout');
  });
}

// ---------- ⑧ 同键登记 ----------
{
  const parent = makeParent(root, 'session-slice1-flight');
  const endSeq = lastEndSeq(parent);
  let calls = 0;
  const flight = new PredictionFlight();
  const start = () =>
    runPrediction(
      makeCtx(root, async function* stream() {
        calls += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
        yield* textChunks('{"suggestion":"复用同一次调用"}');
      }),
      {
        session: parent,
        source: { kind: 'ok', sessionId: parent.id, turn: 1, endSeq },
        trigger: 'live',
        signal: new AbortController().signal,
        maxOutputTokens: 512,
        timeoutMs: 5000,
      },
    );
  const first = flight.startOrReuse('k', start);
  const second = flight.startOrReuse('k', start);
  const [a, b] = await Promise.all([first.result, second.result]);
  await check('⑧ 第二个请求复用第一个，只调用一次模型', () => {
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(calls, 1);
    assert.equal(a.suggestion, b.suggestion);
  });
  await check('⑧ 结算后登记清空', () => {
    assert.equal(flight.size, 0);
  });
}

// 根 Context 不提供 dispose（脚本进程结束即回收）；作用域级的释放已在用例内断言。
const failed = checks.filter(item => !item.ok);
console.log(JSON.stringify({ total: checks.length, failed: failed.length, checks }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
