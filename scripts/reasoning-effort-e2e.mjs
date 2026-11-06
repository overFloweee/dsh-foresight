// 推理档端到端：验证「建议请求实际发出的 options」里的 reasoningEffort。
//
// 测的是编译产物（src 内部用 .js 推导导入，strip-types 无法直接加载），
// 用法：pnpm build && node scripts/reasoning-effort-e2e.mjs
//
// 覆盖三件事：
//   ① Config schema 的默认值是空串 = 继承父会话档（用户不写任何配置时也不覆盖）；
//   ② 该默认档会随逐请求 options 发出（不是只存在于配置里）；
//   ③ 空串 = 不发送该字段（沿用 provider 默认档），且非法类型在 resolveConfig 被拒。
//
// llm.stream 用桩：只捕获 options 并吐一段合法文本流，不碰网络。
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { Config } from '../lib/index.js';
import { generateSuggestion, resolveConfig } from '../lib/generate.js';

// 从 Config schema 取默认值：手抄一份会在改出厂默认时静默过期
// （2026-10-13 实际踩过两次：默认档先从 low 改成 max、再由预测分支改成「空串=继承父会话档」，
//  两次都是脚本先断言旧默认值而失败——改默认值时同步改这里）。
// 只取普通字段：`.volatile()` 字段在解析结果里是 Volatile 包装对象，回灌给 Config() 会报
// `$.llmEnabled expected boolean but got [object Object]`。
const resolvedDefaults = Config({});
const STRATEGY_DEFAULTS = {
  maxInputBytes: resolvedDefaults.maxInputBytes,
  maxOutputTokens: resolvedDefaults.maxOutputTokens,
  timeoutMs: resolvedDefaults.timeoutMs,
  maxRecentTurns: resolvedDefaults.maxRecentTurns,
  maxTranscriptChars: resolvedDefaults.maxTranscriptChars,
  maxSuggestionChars: resolvedDefaults.maxSuggestionChars,
  reasoningEffort: resolvedDefaults.reasoningEffort,
};

/** 造一个真实会话：一个已完成回合 + 一条用户消息。 */
function makeSession(root, id = 'session-a') {
  const session = root.sessions.create(id, { meta: { cwd: process.cwd() } });
  session.append('turn/start', { turn: 1 });
  session.append('user/message', {
    content: [{ type: 'text', text: '部署服务' }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  return session;
}

/** 桩 host：捕获 options，返回一段合法文本流（block-start → text-delta → block-end → finish）。 */
function makeCtx(captured) {
  return {
    logger: { debug() {}, info() {}, warn() {} },
    llm: {
      async *stream(options) {
        captured.push(options);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: '查一下日志' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '查一下日志' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  };
}

async function run(config) {
  const root = new Context();
  new SessionStore(root);
  const session = makeSession(root);
  const captured = [];
  const suggestion = await generateSuggestion(
    makeCtx(captured),
    resolveConfig(config),
    session,
    1,
    new AbortController().signal,
  );
  assert.equal(captured.length, 1, '应恰好发出一次建议请求');
  return { options: captured[0], suggestion };
}

// —— ① schema 默认值 = 空串（继承父会话档）——
const parsedDefault = Config({ ...STRATEGY_DEFAULTS });
assert.equal(parsedDefault.reasoningEffort, '', 'Config schema 默认推理档应为空串（继承父会话档）');

// 用「schema 解析结果」直接跑生成：默认=继承，请求里**不带**该字段（内核按父档/provider 解析）。
{
  const routed = { ...parsedDefault, provider: 'demo-gateway', model: 'deepseek/deepseek-flash' };
  const { options, suggestion } = await run(routed);
  assert.equal('reasoningEffort' in options, false, '默认（继承父会话档）时不应发送 reasoningEffort');
  assert.equal(options.maxTokens, STRATEGY_DEFAULTS.maxOutputTokens, '输出预算随 schema 默认（2048）');
  assert.equal(suggestion?.text, '查一下日志', '正常文本流应产出建议');
}

// —— ② 显式档位原样透传（不被硬编码、也不被继承逻辑吞掉）——
{
  const { options } = await run({
    ...STRATEGY_DEFAULTS,
    provider: 'demo-gateway',
    model: 'deepseek/deepseek-flash',
    reasoningEffort: 'high',
  });
  assert.equal(options.reasoningEffort, 'high', '显式档位应原样透传');
}

// —— ③ 空串 / 未配置 = 不发送该字段（沿用 provider 默认档）——
// `STRATEGY_DEFAULTS` 现在自带 schema 默认档；「未配置」分支要真的把键删掉才算未配置。
const WITHOUT_EFFORT = { ...STRATEGY_DEFAULTS };
delete WITHOUT_EFFORT.reasoningEffort;
for (const [label, value] of [['空串', ''], ['未配置', undefined]]) {
  const config = {
    ...(value === undefined ? WITHOUT_EFFORT : STRATEGY_DEFAULTS),
    provider: 'demo-gateway',
    model: 'deepseek/deepseek-flash',
    ...(value === undefined ? {} : { reasoningEffort: value }),
  };
  const { options } = await run(config);
  assert.equal('reasoningEffort' in options, false, `${label} = 字段缺席（交给内核按 provider 默认档解析）`);
}

// —— ④ 非法类型在配置期就拒（不泄漏到内核的档位校验）——
assert.throws(
  () => resolveConfig({ ...STRATEGY_DEFAULTS, reasoningEffort: 123 }),
  /reasoningEffort must be a string/,
  '非字符串推理档应在 resolveConfig 被拒',
);

console.log('reasoning-effort e2e: ok（默认继承=缺席 / 显式透传 / 空串缺席 / 非法拒绝）');
