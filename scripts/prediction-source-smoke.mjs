// 源回合身份投影（`src/prediction-source.ts`）冒烟：真实 SessionStore + 真实 SessionProjectionRegistry。
//
// 用法：pnpm build && node scripts/prediction-source-smoke.mjs
//
// 覆盖：
//   ① 后注册也能折叠已有历史（晚安装 → stateOf 物化到当前游标）；
//   ② 资格判据：只有「最新回合 completed」合格，in-progress / cancelled / failed 都不合格；
//   ③ 新回合开始立即使上一回合失去资格，迟到/乱序的旧回合 turn/end 不能把它加回来；
//   ④ fold 的引用约定：无关事件返回同一引用（Object.is），且不就地修改 live 状态；
//   ⑤ stateSchema 严格形状；请求键含字段分隔符且对任一字段变化敏感。
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import {
  PREDICTION_PROJECTION_KEY,
  applyPredictionSource,
  initPredictionSource,
  installPredictionSource,
  predictionRequestKey,
  predictionSourceSchema,
} from '../lib/prediction-source.js';

const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

const root = new Context();
new SessionStore(root);
new SessionProjectionRegistry(root);

const session = root.sessions.create('source-smoke-a', { meta: { cwd: process.cwd() } });
session.append('turn/start', { turn: 1 });
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

// ① 先有历史、后安装：晚注册必须能看到已有回合
const access = installPredictionSource(root);
for (let attempt = 0; attempt < 50 && !access.registered; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 10));
}
await check('① 安装后 registered=true（register 被真实 registry 接受）', () => {
  assert.equal(access.registered, true);
});
const endSeq1 = session.snapshotEvents().findLast(event => event.type === 'turn/end').seq;
await check('① 后注册折叠已有历史：completed 回合可读', () => {
  assert.deepEqual(access.read(session), {
    kind: 'ok',
    sessionId: session.id,
    turn: 1,
    endSeq: endSeq1,
  });
});

// ③ 新回合开始 ⇒ 上一回合立即失去资格
session.append('turn/start', { turn: 2 });
await check('③ 新回合开始 ⇒ ineligible', () => {
  assert.deepEqual(access.read(session), { kind: 'unavailable', reason: 'ineligible' });
});
// 旧回合的迟到 turn/end 不能把资格加回来
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
await check('③ 迟到/乱序的旧回合 turn/end 不加回资格', () => {
  assert.deepEqual(access.read(session), { kind: 'unavailable', reason: 'ineligible' });
});

// ② cancelled / failed 都不合格
session.append('turn/end', { turn: 2, reason: { kind: 'cancelled' } });
await check('② cancelled 不合格', () => {
  assert.deepEqual(access.read(session), { kind: 'unavailable', reason: 'ineligible' });
});
session.append('turn/start', { turn: 3 });
session.append('turn/end', { turn: 3, reason: { kind: 'failed' } });
await check('② failed 不合格', () => {
  assert.deepEqual(access.read(session), { kind: 'unavailable', reason: 'ineligible' });
});

// 回流：再开一个 completed 回合 ⇒ 重新合格，且 endSeq 是新的
session.append('turn/start', { turn: 4 });
session.append('turn/end', { turn: 4, reason: { kind: 'completed' } });
const endSeq4 = session.snapshotEvents().findLast(event => event.type === 'turn/end').seq;
await check('② 新 completed 回合重新合格且 endSeq 更新', () => {
  assert.deepEqual(access.read(session), { kind: 'ok', sessionId: session.id, turn: 4, endSeq: endSeq4 });
});

// ④ fold 引用约定（纯函数层，不经 registry）
await check('④ 无关事件返回同一引用', () => {
  const state = initPredictionSource();
  assert.equal(applyPredictionSource(state, { type: 'user/message', seq: 7, data: {} }), state);
  assert.equal(applyPredictionSource(state, { type: 'turn/end', seq: 8, data: { turn: 9, reason: { kind: 'completed' } } }), state);
  assert.equal(applyPredictionSource(state, { type: 'turn/start', seq: 9, data: {} }), state);
});
await check('④ 相关事件返回新对象且不改就地状态', () => {
  const state = initPredictionSource();
  const running = applyPredictionSource(state, { type: 'turn/start', seq: 3, data: { turn: 2 } });
  assert.deepEqual(state, { turn: null, endSeq: null, endKind: null });
  assert.deepEqual(running, { turn: 2, endSeq: null, endKind: null });
  const done = applyPredictionSource(running, { type: 'turn/end', seq: 4, data: { turn: 2, reason: { kind: 'completed' } } });
  assert.deepEqual(done, { turn: 2, endSeq: 4, endKind: 'completed' });
});

// ⑤ schema 与请求键
await check('⑤ stateSchema 是严格形状', () => {
  assert.equal(predictionSourceSchema.safeParse(initPredictionSource()).success, true);
  assert.equal(predictionSourceSchema.safeParse({ turn: 1, endSeq: 2, endKind: 'completed' }).success, true);
  assert.equal(predictionSourceSchema.safeParse({ turn: 1, endSeq: 2, endKind: 'completed', extra: 1 }).success, false);
  assert.equal(predictionSourceSchema.safeParse({ turn: 1, endSeq: null }).success, false);
});
await check('⑤ 请求键确定、含分隔符、字段变化即变键', () => {
  const parts = {
    sessionId: 'session-a',
    turn: 1,
    endSeq: 2,
    recipeVersion: 1,
    provider: 'demo-gateway',
    model: 'deepseek/deepseek-flash',
    reasoningEffort: 'max',
    maxOutputTokens: 2048,
    timeoutMs: 60000,
  };
  const key = predictionRequestKey(parts);
  assert.equal(key, predictionRequestKey({ ...parts }));
  assert.ok(key.includes('\u0000'));
  assert.notEqual(key, predictionRequestKey({ ...parts, endSeq: 3 }));
  assert.notEqual(key, predictionRequestKey({ ...parts, reasoningEffort: 'low' }));
  assert.notEqual(key, predictionRequestKey({ ...parts, maxOutputTokens: 512 }));
  // 相邻字段拼接歧义：'a'+'b' 与 'ab'+'' 必须得到不同键
  assert.notEqual(
    predictionRequestKey({ ...parts, provider: 'a', model: 'b' }),
    predictionRequestKey({ ...parts, provider: 'ab', model: '' }),
  );
});

// 能力缺失（无 registry 的 ctx）⇒ 降级不抛错
await check('降级：没有 sessionProjections 时 read 返回 service_absent 而不是抛错', async () => {
  const bare = new Context();
  new SessionStore(bare);
  const bareSession = bare.sessions.create('source-smoke-bare', { meta: { cwd: process.cwd() } });
  const bareAccess = installPredictionSource(bare);
  for (let attempt = 0; attempt < 50 && !bareAccess.registered; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(bareAccess.registered, false);
  assert.deepEqual(bareAccess.read(bareSession), { kind: 'unavailable', reason: 'service_absent' });
});

const failed = checks.filter(item => !item.ok);
console.log(JSON.stringify({ key: PREDICTION_PROJECTION_KEY, total: checks.length, failed: failed.length, checks }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
