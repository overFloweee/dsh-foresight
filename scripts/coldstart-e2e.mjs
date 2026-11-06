// 冷启动端到端：真实 cordis Context + 真实 dsh-session + 插件真实 host 端，
// 跑通「跑到某回合 → 停机 → 重启 → client 冷启动 pull」的完整对账链路。
// 测的是编译产物（src 内部用 .js 推导导入，strip-types 无法直接加载），先
// pnpm build 再跑。用法：node scripts/coldstart-e2e.mjs
//
// 2026-10-14 修复（独立复核第 6 项）：
//  1) settings 服务（0.2.0-rc.2）不再有 `register()`——插件读 `describe()`、
//     写 `update(ns, patch, expectedRevision?)`。旧脚本拦截 `root.settings.register`
//     且把 `@deepseek-ai/dsh-settings` 的 default export（SettingsForms）当成
//     SettingsProvider 继承，导致 `root.settings` 根本没被提供：整支 e2e 在启动
//     阶段就 `TypeError: Cannot read properties of undefined (reading 'register')`，
//     冷启动用例一条都没跑过。
//  2) 这里用与宿主同形的内存 settings 服务（describe / update+CAS / 文档落介质）：
//     真实 SettingsForms 还依赖 configEditor + profileContext 两个服务，本脚本
//     不复刻它们；文档持久性、重启对账、pull 应答都是真实链路。
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { apply as applyHost } from '../lib/index.js';

const NS = 'dsh-foresight';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询直到条件成立（真机是异步对账，固定 sleep 会漏）。 */
async function waitFor(probe, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false && value !== null) return value;
    if (Date.now() > deadline) return undefined;
    await sleep(10);
  }
}

/**
 * 停掉一个「进程实例」。cordis 4 的根 Context 上没有 `Symbol.asyncDispose`（实测
 * `typeof root[Symbol.asyncDispose] === 'undefined'`），旧脚本那句 `await
 * root[Symbol.asyncDispose]?.()` 是空操作：`ctx.effect` 的 cleanup 从不执行，
 * `_ops` 泵的 700ms 计时器一直重排，整支脚本跑完也退不出（要靠外部 kill）。
 * 真正的钩子是根 fiber：`await root.fiber.dispose()` 会执行 effect cleanup、
 * 停掉泵与所有在途预测。这里统一走这个入口。
 */
async function shutdown(root) {
  await root.fiber?.dispose?.();
  await sleep(20);
}

/**
 * 一个跨「进程」存活的 settings 介质：模拟 settings.yaml 的持久性。
 * 重启 = 丢掉插件 fiber 与内存状态，但保留这份文档与 revision。
 */
function makeMedium(initial = {}) {
  let document = structuredClone(initial);
  let revision = 1;
  return {
    get document() {
      return structuredClone(document);
    },
    /**
     * 与宿主同形的 settings 服务：`describe()` 回带 revision，`update()` 支持
     * 条件写（revision 不匹配 ⇒ 拒绝，等价 `SettingsRevisionMismatch`）。
     * 写入落到介质上（真实 provider 由 storage 承担）。
     */
    service(ctx) {
      return class MediumSettings extends Service {
        constructor() {
          super(ctx, 'settings');
        }
        describe() {
          // 真实 settings 服务的 `describe()` 是**同步**的（dsh-settings 0.2.0-rc.2
          // 的类型面如此声明）；写成 async 会让 `root.settings.describe().find(...)`
          // 静默拿到 undefined（本脚本第一版就踩了）。
          return Object.entries(document).map(([ns, value]) => ({
            ns,
            value: structuredClone(value),
            revision,
            autoGenerate: false,
            schema: null,
            applies: 'live',
          }));
        }
        async update(ns, patch, expectedRevision) {
          if (typeof expectedRevision === 'number' && expectedRevision !== revision) {
            const error = new Error(`settings revision mismatch (expected ${expectedRevision}, actual ${revision})`);
            error.name = 'SettingsRevisionMismatch';
            throw error;
          }
          revision += 1;
          if (patch !== null && typeof patch === 'object') {
            document = { ...document, [ns]: { ...(document[ns] ?? {}), ...structuredClone(patch) } };
          }
        }
      };
    },
  };
}

/**
 * storageDomain 桩：存取都在内存（不落盘），只为兑现「域可用」这一支。
 *
 * 必要性：`setupHotnessPersistence` 的 `whenReady` 只在 `ctx.inject(['storageDomain'])`
 * 的回调里兑现（`src/hotness-store.ts:157-191`），宿主没有该服务时**永不兑现**；
 * 而启动对账推送 `await persistence.whenReady` 之后才发，于是没有它就没有启动推送
 * （`prediction-slice2-e2e` 的 ⑩ 实测：pushes 为空）。
 */
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

/** 造一个最小会话：给定已完成回合与用户消息。 */
function makeSession(store, id, { turns, userTexts }) {
  const session = store.create(id, { meta: { cwd: process.cwd() } });
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn });
    const text = userTexts[turn - 1];
    if (text !== undefined) {
      session.append('user/message', {
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }, { surfaceOp: 'append' });
    }
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
  }
  return session;
}

/** 读本命名空间在 settings **文档**里的值（client 侧的读法）。 */
function docOf(root) {
  const row = root.settings.describe().find?.((entry) => entry.ns === NS);
  const value = row?.value;
  return value !== null && typeof value === 'object' ? value : undefined;
}

/** 读 host 推给 client 的 `_push`。 */
function pushed(root) {
  const raw = docOf(root)?._push;
  return typeof raw === 'string' && raw !== '' ? JSON.parse(raw) : null;
}

/** 装配一个「进程」：真实 Context + sessions + settings 服务 + 本插件 host 端。 */
async function bootProcess(medium, seed = {}) {
  const root = new Context();
  new SessionStore(root);
  new StorageDomainStub(root);
  root.plugin(medium.service(root));
  await sleep(20);
  const sessions = root.sessions;
  const session = makeSession(sessions, seed.sessionId ?? 'session-a', {
    turns: seed.turns ?? 2,
    userTexts: seed.userTexts ?? ['第一句', '第二句'],
  });
  applyHost(root, {
    maxInputBytes: 4096,
    maxOutputTokens: 512,
    timeoutMs: 1000,
    maxTranscriptChars: 12000,
    maxSuggestionChars: 240,
  });
  // 等**宿主本次进程**的启动对账推送落地：盘上本来就可能有上一进程写的 `_push`
  // （夹具即是），靠「有 `_push`」会立即通过、读到的是旧载荷。`epoch` 只由本进程的
  // 推送写入，是唯一可靠的「这一份是本次进程推的」标志。
  const ready = await waitFor(() => (typeof pushed(root)?.epoch === 'string' ? true : undefined), 3000);
  assert.ok(ready === true, '启动后应推送一份 `_push`（settings 注入/对账未完成）');
  return { root, session, sessions };
}

const SESSION = 'session-a';

// —— 1. 首次启动：无建议、无已知会话 → 只推热度；历史由 pull 按需取 ——
{
  const medium = makeMedium();
  const { root } = await bootProcess(medium, { sessionId: SESSION, turns: 2, userTexts: ['第一句', '第二句'] });
  const p = pushed(root);
  assert.ok(p !== null, '启动后应推送一份状态');
  assert.equal(p.suggestion, null, '首次启动无建议');
  assert.equal(p.protocol, 2, '冷启动推送已带协议版本 2');
  // 首次启动 host 不知道「当前会话」（盘上没有建议可归属），历史留给 client 的
  // pull 应答——这正是 pull 存在且必须被应答的意义，见第 5 节。
  assert.equal(p.historySessionId, undefined, '首次启动不猜当前会话');
  await shutdown(root);
}

// —— 2. 模拟「停机前的进程」：磁盘上留有一条属于回合 2 的 v1 建议 ——
{
  const persistedPush = JSON.stringify({
    rev: 9,
    suggestion: { version: 1, turn: 2, baseSeq: 3, text: '跑一下测试', truncated: false, acceptKey: 'Tab' },
    suggestionSessionId: SESSION,
    hot: null,
    total: 0,
    history: ['第一句', '第二句'],
    historySessionId: SESSION,
  });
  const medium = makeMedium({ [NS]: { _push: persistedPush, _ops: 'null' } });
  const { root } = await bootProcess(medium, { sessionId: SESSION, turns: 2, userTexts: ['第一句', '第二句'] });

  // 重启对账的核心断言：会话已进店且回合归属正确 → v1 建议被**恢复**而非清空。
  const p = pushed(root);
  assert.ok(p !== null, '重启后应推送对账状态');
  assert.ok(p.suggestion !== null, '重启后上一轮 v1 建议应被恢复（旧链路的兼容路径）');
  assert.equal(p.suggestion.text, '跑一下测试');
  assert.equal(p.suggestion.turn, 2);
  assert.equal(p.suggestionSessionId, SESSION);
  assert.deepEqual(p.history, ['第一句', '第二句'], '历史同样立即可用，无需等新回合');
  await shutdown(root);
}

// —— 3. 建议陈旧（会话在停机期间又推进了回合）→ 应作废 ——
{
  const persistedPush = JSON.stringify({
    rev: 9,
    suggestion: { version: 1, turn: 1, baseSeq: 1, text: '这条已经过期', truncated: false, acceptKey: 'Tab' },
    suggestionSessionId: SESSION,
    hot: null,
    total: 0,
  });
  const medium = makeMedium({ [NS]: { _push: persistedPush, _ops: 'null' } });
  const { root } = await bootProcess(medium, { sessionId: SESSION, turns: 3, userTexts: ['一', '二', '三'] });
  const p = pushed(root);
  assert.equal(p.suggestion, null, '回合已推进到 3，回合 1 的建议必须作废');
  assert.equal(p.historySessionId, SESSION, '历史不受建议作废影响');
  await shutdown(root);
}

// —— 4. 会话尚未进店（持久化懒恢复未发生）→ 不猜测、不覆盖盘上值 ——
{
  const persistedPush = JSON.stringify({
    rev: 9,
    suggestion: { version: 1, turn: 2, baseSeq: 3, text: '等会话进店后再判', truncated: false, acceptKey: 'Tab' },
    suggestionSessionId: 'session-not-restored-yet',
    hot: null,
    total: 0,
  });
  const medium = makeMedium({ [NS]: { _push: persistedPush, _ops: 'null' } });
  // 注意：本进程只创建了 SESSION，**没有**创建 session-not-restored-yet。
  const { root } = await bootProcess(medium, { sessionId: SESSION, turns: 1, userTexts: ['一'] });
  const raw = docOf(root)?._push;
  assert.ok(typeof raw === 'string' && raw !== 'null', '会话未进店时不得清盘');
  const kept = JSON.parse(raw);
  assert.equal(kept.suggestion?.text, '等会话进店后再判', '盘上建议原样保留，留给该会话进店后的 pull 对账');
  await shutdown(root);
}

// —— 5. pull 应答：客户端请求某会话权威状态（含会话不存在时的兜底）——
{
  const medium = makeMedium();
  const { root } = await bootProcess(medium, { sessionId: SESSION, turns: 2, userTexts: ['甲', '乙'] });

  // 模拟 client 写入 pull 请求
  await root.settings.update(NS, {
    _ops: JSON.stringify({ rev: 1, ops: [{ op: 'pull', sessionId: SESSION, id: 'cold-1' }] }),
  });
  const answered = await waitFor(() => (pushed(root)?.historySessionId === SESSION ? true : undefined), 3000);
  assert.ok(answered === true, 'pull 应被应答（含该会话历史）');
  assert.deepEqual(pushed(root).history, ['甲', '乙']);
  const cleared = await waitFor(() => (docOf(root)?._ops === 'null' ? true : undefined), 3000);
  assert.ok(cleared === true, 'pull 消费后应清空 `_ops`');
  assert.ok(
    pushed(root).opsAck === undefined || pushed(root).opsAck.includes('cold-1'),
    '若回执仍在同一次推送里，必须包含 pull 的操作 id',
  );

  // 会话不存在：仍应答应（不能静默丢弃），只是省略 history
  await root.settings.update(NS, {
    _ops: JSON.stringify({ rev: 2, ops: [{ op: 'pull', sessionId: 'no-such-session', id: 'cold-2' }] }),
  });
  const consumed2 = await waitFor(() => (docOf(root)?._ops === 'null' ? true : undefined), 3000);
  assert.ok(consumed2 === true, '未知会话的 pull 也应被消费');
  assert.notEqual(pushed(root).historySessionId, 'no-such-session', '未知会话不应谎报历史归属');
  await shutdown(root);
}

// —— 6. v2 载荷：host 不得把上一进程的预测当成本进程的有效记录恢复 ——
// 客户端那一半（首次连接/reset 后先隐藏、以 pull 确认建立有效性）由
// `scripts/prediction-client-guards-e2e.mjs` 覆盖：host 不恢复 ≠ client 不显示。
{
  const persistedPush = JSON.stringify({
    rev: 9,
    protocol: 2,
    suggestion: { version: 1, turn: 2, baseSeq: 4, text: '上一进程的旧幽灵', truncated: false, acceptKey: 'Tab' },
    suggestionSessionId: SESSION,
    hot: null,
    total: 0,
    prediction: {
      requestKey: 'stale-key',
      sessionId: SESSION,
      sourceTurn: 2,
      sourceEndSeq: 4,
      outcome: 'suggested',
      requestId: 'stale-request',
      nonce: null,
      generatedAt: 1,
    },
  });
  const medium = makeMedium({ [NS]: { _push: persistedPush, _ops: 'null' } });
  const { root } = await bootProcess(medium, { sessionId: SESSION, turns: 2, userTexts: ['第一句', '第二句'] });
  const p = pushed(root);
  assert.equal(p.protocol, 2, '重启后 host 仍以 v2 协议推送');
  assert.equal(p.suggestion, null, 'v2 旧建议不得被恢复（预测由源投影 + pull 补抓重建）');
  assert.equal(p.prediction, null, 'v2 旧预测记录不得被恢复');
  await shutdown(root);
}

console.log('✅ coldstart e2e：重启对账(v1 恢复) / 陈旧作废 / 懒恢复不覆盖 / pull 应答与清空 / v2 不恢复 全部通过');
