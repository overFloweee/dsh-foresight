/**
 * dsh-foresight host 端：监听已完成回合，有界生成下一条建议，经
 * `dsh-foresight/state` 会话事件 + `suggestGhost` 投影实时推给 client。
 * 零核心改动，纯插件挂载。
 *
 * 0.1.7 适配：内核移除了 `settings.yaml` 体系，本插件的
 *  - **用户可调项** → `Config` 里的 `.volatile()` 字段（内核把插件 Config 投影成
 *    WebUI 表单，ns = Loader 条目 id = `dsh-foresight`）；
 *  - **热数据（建议/热度/历史环）** → ignorable 会话事件 + 投影 fold
 *    （取代已不存在的 settings `_push`）。
 *
 * 冷启动语义见 ./coldstart.ts：历史环按需从会话日志物化、建议按「回合是否仍是
 * 最后一个已完成回合」语义校验，因此重启后打开页面即可用，无需等新回合。
 * @module dsh-foresight
 */

import z from '@deepseek-ai/schemastery';
import type { Volatile } from '@deepseek-ai/cosmokit';
import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-session-projection';
import {
  appendToRing,
  HISTORY_PUSH_CAP,
  nextTrackedSuggestion,
  parsePersistedPush,
  seedRingFromLog,
  SUGGESTION_CACHE_CAP,
  suggestionFieldsFor,
  suggestionIsCurrent,
  userTextOfEvent,
} from './coldstart.js';
import { SUGGEST_EVENT } from './domain.js';
import type { HotnessOp, SuggestGhostHotEntry, SuggestGhostSuggested } from './domain.js';
import { flattenConfig, resolveConfig } from './generate.js';
import type { Config as GenerateConfig, FlatConfig, ResolvedPluginConfig } from './generate.js';
import { sessionEvents } from './generate.js';
import { parseHotnessOps, setupHotnessPersistence } from './hotness-store.js';
import { isPredictionChildSession, PredictionFlight, runPrediction } from './prediction.js';
import type {
  PredictionFailureReason,
  PredictionOutcome,
  PredictionResult,
  PredictionTrigger,
} from './prediction.js';
import { PREDICTION_RECIPE_VERSION } from './prediction-prompt.js';
import { installPredictionSource, predictionRequestKey } from './prediction-source.js';
import { generateRecap } from './recap.js';
import type { RecapConfig } from './recap.js';
import { setupRecapStore } from './recap-store.js';
import type { RecapEntry } from './recap-store.js';
import { applySuggestGhostProjection, initSuggestGhostProjection, suggestGhostSchema } from './projection.js';
import { EMPTY_PUSH, effectiveConfig, SUGGEST_GHOST_NAMESPACE } from './settings.js';
import { PROJECTION_KEY } from './domain.js';
import type { SuggestGhostProjection } from './domain.js';

/**
 * 策略参数：只在插件 Config（`cordis.patch.yml`）里声明，不进 WebUI 表单。
 * 刻意不标 `.volatile()` —— 0.1.7 的 `SettingsForms` 只把 volatile 字段渲染成
 * 表单项（`volatileForm()`），未标的字段留在 profile 文档里由用户手改。
 */
const StrategyFields = {
  /**
   * 最终框架化用户提示的最大 UTF-8 字节数。4096 是「装得下一轮中文对话」的量级，
   * 但 3 轮真实对话实测要 8～9 KB（中文 1 字 = 3 字节）⇒ 默认抬到 16384，让
   * `maxRecentTurns: 3` 真的装得下；调小它会把窗口裁回 1～2 轮。
   */
  maxInputBytes: z.natural().min(1).default(16_384),
  /**
   * 建议生成输出令牌上限。**必须给推理档留出预算**：实测 `reasoningEffort: max`
   * 在真实 3 轮转录上烧掉 1049 个 reasoning token（512 档时 512/512 被 reasoning
   * 吃光，`finish_reason: length`，正文为空）。
   *
   * 默认 8192：长会话（工具史多、回合长）里模型会先写长文本再给 JSON，2048 档实测
   * 被写满 ⇒ `finish.kind === 'max-tokens'` ⇒ 预测判 `abnormal_finish` 失败、界面
   * 什么都不显示（真机失败耗时 15～18 秒，正好等于生成满 2048 token）。同一会话在
   * 8192 档 4.9 秒返回 `suggested`。
   */
  maxOutputTokens: z.natural().min(1).default(8192),
  /** 辅助请求端到端截止时间（毫秒）。 */
  timeoutMs: z.natural().min(1).default(60_000),
  /**
   * 转录尾部保留的最近完成回合数（默认 3）。实测：只给 1 轮时模型 4/4 次给不出
   * 建议（界面什么都不显示），给 2～3 轮才稳定给出——它需要看到跨轮的模式。
   * 轮数受 `maxInputBytes` 约束，调大轮数时记得同步抬字节预算。
   */
  maxRecentTurns: z.natural().min(1).default(3),
  /** 转录字符预算（与 `maxInputBytes` 配套：3 轮中文对话约 3 千字符，留足余量）。 */
  maxTranscriptChars: z.natural().min(1).default(24_000),
  /** 建议可见字符上限。 */
  maxSuggestionChars: z.natural().min(1).default(240),
  /**
   * 显式路由对（**迁移期兼容字段**）。预测主链路的候选资格判据是「父会话有请求头」
   * （`session.requestHeader()`），路由继承自预测 fork 自己的请求头（规范 §4.2），
   * 不再要求这里配置；这两个字段只保留给仍在使用旧建议路径的 profile。
   * `z.string().default('')` 而非 `min(1)`：留空表示「继承」，若必填会把插件逼成
   * 「不填就不能启动」。
   */
  provider: z.string().default(''),
  model: z.string().default(''),
  /**
   * 预测请求的推理档覆盖。**留空 = 继承父会话档**（规范 §4.2）：预测 fork 的请求头
   * 自带父会话的 provider/model/reasoningEffort，这里只在用户显式配置时才覆盖。
   * 实际生效档 = 本字段非空 ? 本字段 : 父会话档 —— parent / configured 只是来源
   * 之别，不要求两者不同（这正是官方的 `parentReasoningEffort` /
   * `configuredReasoningEffort` 两个字段的语义）。已显式写 `max` / `low` 的旧配置
   * 原样保留，不需要迁移动作。
   */
  reasoningEffort: z.string().default(''),
  /**
   * 每回合回顾（recap）的一行字符上限。默认 80：一两句话把结论/状态/缺口说清，够了——
   * 回顾是「这轮之后什么变了」的提示，不是摘要；正文可以回看。超了由 `recap.ts`
   * 按标点就近断句后硬截。
   */
  recapMaxChars: z.natural().min(1).default(80),
  /**
   * 回顾的材料预算（单次发送给回顾模型的字符数）。回顾只看**本回合**：用户消息、
   * 助手结论、工具调用摘要，12000 字符足够装下一个长回合（含工具参数），超出时
   * `recap.ts` 保头保尾、中间省略。
   */
  recapSourceChars: z.natural().min(200).default(12_000),
  /**
   * 回顾调用超时（毫秒）。回顾是锦上添花的单次辅助调用，不占建议链路的 60s 预算；
   * 默认 30s 仍未返回就放弃（前端只是少一行回顾）。
   */
  recapTimeoutMs: z.natural().min(1).default(30_000),
};

/**
 * 用户可调项：逐字段标 `.volatile()`。0.1.7 让字段出现在 WebUI 设置页的开关
 * 就是它 —— `dsh-settings` 的 `volatileForm()` 递归下探、只收 `meta.volatile`
 * 的节点（`Config` 这层对象本身不能标：标了会让整棵子树都变成表单，策略参数
 * 一并暴露；也不能把 `z.object({...}).volatile().dict` 摊平再 spread ——
 * 摊平会丢掉每个字段自己的 `meta`，实测直接导致整张表单不可见）。
 *
 * 语义与 `dsh-client-ui-theme` 的 `preference` / `fontSize` 完全一致：解析后拿到的
 * 不是裸值而是一个**引用**（cosmokit 的 `Volatile<T>`），读值必须走 `.get()`。
 * 内核写盘时用同一判据 `isVolatilePath()` 把这些字段从 profile 文档里剔除，
 * 所以它们只活在 Loader 条目的内存 config 里，不污染手改的补丁文件。
 *
 * 这些字段**取代** 0.1.5/0.1.2 时代的 `dsh-foresight` settings 命名空间：
 * 0.1.7 删除了 `ctx.settings.register()`，命名空间不再由插件注册，而是内核把
 * 插件自己的 Config schema 投影成表单（ns = Loader 条目 id = `dsh-foresight`）。
 *
 * **依赖下限是 `@deepseek-ai/schemastery@^3.18.3`，不是 `^3.18.1`。**
 * `.volatile()` 是 3.18.3 才加入 schemastery 的；3.18.1 / 3.18.2 上调用它得到
 * `TypeError: ....volatile is not a function`。这**不是运行期异常，而是模块求值
 * 期的硬失败**——整个插件条目加载不了，0.1.7 会在 Web 启动时报
 * `1 entry did not activate` 并挡住界面。所以 peer 范围必须卡在 3.18.3 起，
 * 放宽到 `^3.18.1` 会让 pnpm 解析出旧版并直接炸掉。
 */
const EditableFields = {
  /** LLM 下一条建议开关（默认开）；关闭后每回合不再调用建议模型。 */
  llmEnabled: z.boolean().default(true).volatile(),
  /**
   * 每回合回顾开关（默认开）。回合完成后，用这一回合自己的材料生成一行「这轮做了
   * 什么」显示在回复末尾；关闭后不再生成，已生成的回顾保留。
   */
  recapEnabled: z.boolean().default(true).volatile(),
  /** 是否启用历史前缀补全。 */
  historyEnabled: z.boolean().default(true).volatile(),
  /** 是否跨会话搜索历史（false = 仅当前会话）。 */
  historyCrossSession: z.boolean().default(false).volatile(),
  /** 历史补全最多参考的历史条目数（0 = 不限）。 */
  historyMaxEntries: z.natural().min(0).default(50).volatile(),
  /** 草稿至少输入多少字符才触发历史补全。 */
  historyMinChars: z.natural().min(1).default(1).volatile(),
  /** 幽灵显示时允许 → 逐词采纳。 */
  wordAccept: z.boolean().default(true).volatile(),
  /** 采纳建议的输入框快捷键（默认 Tab）。 */
  acceptKey: z.string().min(1).default('Tab').volatile(),
  /**
   * client → host 的热度管理操作队列（JSON 字符串）。
   *
   * 0.1.7 的 `SettingsForms.write()` 只接受 volatile 路径（`isVolatilePath`
   * 校验，非 volatile 直接抛错），所以这个反向通道字段本身也必须标 volatile。
   * 消费后立即写回空串：清空既是「已消费」信号，也防陈旧操作在重启后重放
   * （如陈旧的 clear 把新数据清掉）。操作幂等，host 不依赖 rev 去重。
   */
  _ops: z.string().default(EMPTY_PUSH).volatile(),
  /**
   * host → client 的实时推送载荷（JSON 字符串），同上必须标 volatile 才能写入。
   * 结构与 0.1.5 时代完全一致（见 settings.ts 的 `GhostPushPayload`），故 client
   * 侧的解析与 `*SessionId` 归属守卫无需改动——变的只是字段载体。
   */
  _push: z.string().default(EMPTY_PUSH).volatile(),
};

/**
 * `Config` 解析后的取值形状。
 *
 * 显式标注的原因：两个字段组用 spread 组合时，TS 推断出的类型引用了
 * `.pnpm/...` 下的具体路径，`.d.ts` 产物无法命名（TS2742 要求可命名的标注）。
 * 标注成这个接口既让产物可命名，也让 Config 的输入/输出类型对上层可见。
 *
 * **可调项的类型是 `Volatile<T>` 而不是裸值。** `.volatile()` 把 schema 的
 * Mode 提升为 `'volatile'`，`SchemaOutput` 随之把输出映射成 `Volatile<T | undefined>`
 * （`@deepseek-ai/schemastery` 的 `SchemaOutput` / `SetRequired`）。所以这里必须
 * 逐字段写 `Volatile<...>`——否则 `z<PluginConfigValues>` 的标注与实际推断不符，
 * 报 `Type 'Volatile<boolean>' is not assignable to type 'boolean'`。
 * 读值一律走 `flattenConfig()` 的 `readVolatile()`，拿到的才是裸值。
 */
export interface PluginConfigValues {
  maxInputBytes: number;
  maxOutputTokens: number;
  timeoutMs: number;
  maxRecentTurns: number;
  maxTranscriptChars: number;
  maxSuggestionChars: number;
  recapMaxChars: number;
  recapSourceChars: number;
  recapTimeoutMs: number;
  provider: string;
  model: string;
  llmEnabled: Volatile<boolean>;
  recapEnabled: Volatile<boolean>;
  historyEnabled: Volatile<boolean>;
  historyCrossSession: Volatile<boolean>;
  historyMaxEntries: Volatile<number>;
  historyMinChars: Volatile<number>;
  wordAccept: Volatile<boolean>;
  acceptKey: Volatile<string>;
  _ops: Volatile<string>;
  _push: Volatile<string>;
}

/**
 * 配置 schema（cordis 插件约定，config catalog 会原样粘贴声明）。
 *
 * 标注必须写成 `z<输入, 输出>` 两参形式，不能用 `z<PluginConfigValues>` 单参：
 * `.volatile()` 字段的**输入**是裸值、**输出**是 `Volatile<T>`（见 `ObjectS` /
 * `ObjectT`），单参标注会让两侧都被当成 `Volatile<T>`，`default()` 的入参随之
 * 对不上而报 TS2322。输入形状用 `Schemastery.TypeS<typeof ConfigSchema>` 取回。
 */
const ConfigSchema = z.object({
  ...StrategyFields,
  ...EditableFields,
});

export const Config: z<Schemastery.TypeS<typeof ConfigSchema>, PluginConfigValues> = ConfigSchema;

/** 所需服务：LLM 路由 + 会话存储。 */
export const inject = ['llm', 'sessions'];

/** 插件名（与 manifest 的包名一致；条目 id 仍是 `dsh-foresight`）。 */
export const name = 'dsh-foresight';

/**
 * 每会话生成状态：防重入、可中止。
 *
 * 预测主链路（`_push` v2）的**语义去重**不在本结构里：它按稳定请求键登记在
 * `PredictionFlight`（在途复用）与 `predictionRecords`（终态缓存）上，键由
 * sessionId + sourceTurn + sourceEndSeq + recipeVersion + 生成配置身份拼成。
 * 这里只留会话级的在途句柄与「最近一次终态来源回合」，供作废与诊断使用。
 */
interface SessionState {
  /** 最近一次**终态**预测（或旧建议）对应的回合号。 */
  lastSuggestedTurn: number;
  /** 在途预测请求；新回合 / 关闭开关 / 配置变更 / 卸载会中止它。 */
  prediction: { readonly key: string; readonly controller: AbortController } | undefined;
}

/** 从会话日志恢复已建议的最新回合号。 */
function lastSuggestedTurnInLog(session: Session): number {
  let last = 0;
  // 跨代读取：0.1.2 起没有 `session.events`（见 generate.sessionEvents）。
  for (const event of sessionEvents(session)) {
    if (event.type === SUGGEST_EVENT && typeof event.data.turn === 'number') {
      last = Math.max(last, event.data.turn);
    }
  }
  return last;
}

/**
 * 挂载插件：监听完成回合、按会话生成建议、注册投影单元，并把配置暴露
 * 到 WebUI 设置页（settings 命名空间，live 生效）。
 * @param ctx - 提供 LLM 与会话服务的 cordis 上下文。
 * @param config - 必填的有界生成策略。
 */
export function apply(ctx: Context, config: GenerateConfig): void {
  const resolved = resolveConfig(config);
  const states = new WeakMap<Session, SessionState>();
  const tracked = new Set<SessionState>();
  // 全局跨会话热度表（增量，随 user/message 事件累积），并经 storageDomain
  // 持久化频次（宿主未挂 storageDomain 时自动降级为纯内存）。
  const { hotness, persistence } = setupHotnessPersistence(ctx);
  // 预测主链路的数据源：host-only 投影单元折叠原生回合事件，给出「最后一个已完成
  // 回合」的结束序号（非废弃接口；旧的三件套读取 API 一律不用）。
  const predictionSource = installPredictionSource(ctx);

  // 读取生成配置的 live 值：Config 里的 volatile 引用（用户可调项）优先，
  // 未覆盖的字段回退到 schema 默认值。状态经 `_push` volatile 字段推给 client
  // （0.1.7 移除了 settings.yaml：字段载体从 SettingsScope 换成 volatile 配置
  // 字段，载荷结构不变）。
  let liveSettings: FlatConfig = flattenConfig(resolved);
  let settingsSvc: { update: (ns: unknown, patch: object) => Promise<void> } | null = null;
  /**
   * 卸载竞态闸门：settle 之后的异步回调（预测/回顾生成、settings 轮询尾巴）
   * 可能晚于 dispose 落地。此时插件上下文已经 inactive，`ctx.sessions` 这类
   * 必需服务会抛 "cannot get required service ... in inactive context"；
   * 旧版本没拦，直接把宿主进程带崩（调用链：
   * pushState → statePushOf → currentSuggestionFor）。
   */
  let disposed = false;

  // 每回合回顾（recap）：回合完成后的**单次**辅助调用，输入只取这一回合自己的
  // 材料（用户诉求 / 助手结论 / 工具调用），产出按 `sessionId + turn` 持久化，
  // 随 `_push` 的 `recaps` 字段下发，由 client 的 turnTail 槽渲染在回复末尾。
  // 与预测主链路完全解耦：它不碰 fork/投影，失败也只是少一行回顾。
  const recapStore = setupRecapStore(ctx);
  /** 在途回顾（按会话）：同回合复用，不同回合取代旧的；卸载/销毁时中止。 */
  const recapFlights = new Map<string, { readonly turn: number; readonly controller: AbortController }>();
  /** 从当前 live 配置组装回顾调用参数（`recap*` 在 schema 里有默认值）。 */
  const recapConfigOf = (): RecapConfig => ({
    maxChars: resolved.recapMaxChars ?? 80,
    sourceChars: resolved.recapSourceChars ?? 12_000,
    timeoutMs: resolved.recapTimeoutMs ?? 30_000,
    maxTokens: resolved.maxOutputTokens,
    provider: liveSettings.provider ?? '',
    model: liveSettings.model ?? '',
    reasoningEffort: liveSettings.reasoningEffort ?? '',
  });

  /**
   * 触发某会话某回合的回顾生成。
   *
   * 触发条件与预测一致：只对 `completed` 回合、排除预测子会话与 subagent 会话、
   * 开关打开、该回合尚未生成过。失败静默（debug 日志），不影响任何主链路。
   * @param session - 刚完成回合的会话。
   * @param turn - 该回合号。
   */
  const requestRecap = (session: Session, turn: number): void => {
    if (effective().recapEnabled === false) return;
    if (isPredictionChildSession(session.id)) return;
    if (session.header.origin === 'subagent') return;
    if (turn <= 0) return;
    if (recapStore.has(session.id, turn)) return;
    const previous = recapFlights.get(session.id);
    if (previous !== undefined) {
      if (previous.turn === turn) return; // 同回合在途：复用
      previous.controller.abort();
      recapFlights.delete(session.id);
    }
    const controller = new AbortController();
    recapFlights.set(session.id, { turn, controller });
    const config = recapConfigOf();
    void generateRecap(ctx, config, session, turn, controller.signal)
      .then((result) => {
        const active = recapFlights.get(session.id);
        if (active !== undefined && active.controller === controller) recapFlights.delete(session.id);
        if (controller.signal.aborted) return;
        // 没有变化的回合：不落库、不推送，也就不显示（用户要求「没变化就别显示了」）。
        if (result.kind === 'no_change') {
          ctx.logger.debug?.(`dsh-foresight: recap skipped (turn ${turn}): no change`);
          return;
        }
        if (result.kind !== 'ok') {
          ctx.logger.debug?.(`dsh-foresight: recap skipped (turn ${turn}): ${result.reason}${result.detail === undefined ? '' : ` [${result.detail}]`}`);
          return;
        }
        recapStore.put({
          sessionId: session.id,
          turn,
          text: result.text,
          at: Date.now(),
          toolCalls: result.toolCalls,
        });
        ctx.logger.info(`dsh-foresight: recap ready (session ${session.id}, turn ${turn}, ${result.text.length} chars)`);
        // 只推「本会话」的权威状态：回顾是会话级显示状态，随下一次 pull/推送一起
        // 到达 client 的 turnTail 槽。
        pushState(session.id);
      })
      .catch((error: unknown) => {
        const active = recapFlights.get(session.id);
        if (active !== undefined && active.controller === controller) recapFlights.delete(session.id);
        ctx.logger.warn?.(`dsh-foresight: recap failed: ${String(error)}`);
      });
  };

  /**
   * `_ops` 的最后一次已消费载荷。volatile 字段是**稳定引用**：cosmokit 的
   * `createVolatile()` 返回一个冻结对象，内核 `updateVolatile()` 原地写入它的
   * 当前值 —— 引用身份不变、值会变。因此写盘后 `resolved._ops.get()` 立刻是
   * 新值，载荷字符串比对就是语义判重（同值重写不重复消费）。
   */
  // 初值刻意用「不可能出现的哨兵」而不是 EMPTY_PUSH：`_ops` 是 volatile 字段且
  // **会落盘**，插件实例创建时 loader 已把持久值填进 volatile 引用——用 EMPTY_PUSH
  // 当初值时，启动前 client 抢跑写入的那条遗留 pull 与引用现值相同，泵会判成
  // 「无变化」永不消费（真机症状：pull 写进文档后 90s 无人应答）。哨兵让第一拍
  // 必定消费一次文档现值；`'null'`/空载荷解析成空 ops，天然是 no-op。
  let lastOpsPayload = '__suggest-ghost-never-consumed__';
  /**
   * `_ops` 轮询周期（毫秒）。宿主收不到 `settings/document-updated`（内核只在 settings
   * 服务的 owner 上下文 emit，cordis 事件沿发射上下文上行，兄弟/子上下文都收不到），
   * 所以反向通道只能靠定时读文档。读文档 = 一次 `describe()`，内核会为每个命名空间算
   * revision（schema.toJSON + stringify），因此空闲时退避到 `OPS_POLL_IDLE_MS`。
   */
  const OPS_POLL_MS = 700;
  /** 连续多少拍没消费到东西后进入空闲档（档位见 `schedule()`）。 */
  const OPS_POLL_IDLE_TICKS = 6;
  /**
   * 条件清空失败后的重试节流（毫秒）。取轮询周期的两倍：既不放过 revision 竞争，
   * 也不会每拍都往 settings 写一次。
   */
  const OPS_CLEAR_RETRY_MS = 1400;
  /** 取当前 `_ops` 的载荷字符串（读 volatile 引用；裸值形态则直接用）。 */
  const readOps = (): string => {
    const ref = (resolved as { _ops?: unknown })._ops;
    const payload = typeof ref === 'object' && ref !== null && typeof (ref as { get?: unknown }).get === 'function'
      ? (ref as { get: () => unknown }).get()
      : ref;
    return typeof payload === 'string' ? payload : EMPTY_PUSH;
  };
  /** 取持久化的 `_push` 载荷字符串（同上，读 volatile 引用）。 */
  const readPush = (): string => {
    const ref = (resolved as { _push?: unknown })._push;
    const payload = typeof ref === 'object' && ref !== null && typeof (ref as { get?: unknown }).get === 'function'
      ? (ref as { get: () => unknown }).get()
      : ref;
    return typeof payload === 'string' ? payload : EMPTY_PUSH;
  };
  /**
   * `_ops` 反向通道的轮询泵。
   *
   * 为什么不是事件：内核里 `settings/document-updated` 只在 settings 服务自己的
   * owner 上下文上 emit（`dsh-settings/lib/index.js` 的 `describe()`），而内核中
   * **所有**消费者都是 client 半区的 `ctx.remote.$on(...)`（该事件在
   * `dsh-api-remotes` 的转发白名单里）。宿主插件用 `ctx.on(...)` 收不到它 ——
   * 实测：client 写入 `_ops` 成功、profile 文档里出现该字段，宿主却从不消费。
   * volatile 引用在写入后立即是新值，所以轮询这个引用是可靠且代际无关的通道。
   *
   * 定时器挂在 {@link Context.effect} 上：随插件卸载自动停表，不会跨重载累积
   * （profile 改动会重载插件，裸 `setInterval` 会越积越多）。
   * @param svc - settings 服务（清空 `_ops` 时用）。
   */
  /** 把 `settings.describe()` 的结果归一成「条目描述符数组」。
   *
   * 宿主服务的 `describe()` 直接返回**数组**（`dsh-settings/lib/index.js:414`，
   * 字段 `{ns, value, schema, ...}`）；client 侧经 RPC 拿到的是被信封包过的
   * `{namespaces: [...]}` 形状。两种都要认——只认后者的实现在真机上永远读不到
   * 文档值（`_ops` 永不消费、启动恢复永远为空，真机踩到过）。 */
  const unwrapSettingsDocument = (
    described: unknown,
  ): readonly { ns?: unknown; value?: unknown }[] | undefined => {
    let node: unknown = described;
    for (let depth = 0; depth < 5; depth += 1) {
      if (Array.isArray(node)) return node as readonly { ns?: unknown; value?: unknown }[];
      if (node === null || typeof node !== 'object') return undefined;
      const record = node as { namespaces?: unknown; value?: unknown; result?: unknown; ns?: unknown };
      if (Array.isArray(record.namespaces)) {
        return record.namespaces as readonly { ns?: unknown; value?: unknown }[];
      }
      if (record.ns !== undefined) return undefined; // 已经是描述符，别往它的 value 里钻
      node = record.value ?? record.result;
    }
    return undefined;
  };
  /** 读本命名空间在 settings **文档**里的条目：值 + revision（条件写要用 revision）。 */
  const readSettingsEntry = async (
    svc: { describe?: () => Promise<unknown> },
  ): Promise<{ readonly value: Record<string, unknown>; readonly revision: number | undefined } | undefined> => {
    const describe = svc.describe;
    if (typeof describe !== 'function') return undefined;
    const rows = unwrapSettingsDocument(await describe.call(svc)) ?? [];
    const entry = rows.find((row) => row?.ns === SUGGEST_GHOST_NAMESPACE);
    const value = entry?.value;
    if (value === null || typeof value !== 'object') return undefined;
    return {
      value: value as Record<string, unknown>,
      revision: typeof (entry as { revision?: unknown } | undefined)?.revision === 'number'
        ? (entry as { revision: number }).revision
        : undefined,
    };
  };
  /** 读本命名空间在 settings **文档**里的值（轮询泵与 `_ops` 条件清除共用）。 */
  const readSettingsDocument = async (
    svc: { describe?: () => Promise<unknown> },
  ): Promise<Record<string, unknown> | undefined> => (await readSettingsEntry(svc))?.value;
  /**
   * 消费完一批 `_ops` 后**条件清空**队列（独立复核反例 #1 的最小修复）。
   *
   * 旧实现无条件写 `'null'`：client 在 host「消费—清空」之间写入的新批次（例如采纳
   * 时的 `consume`）会被整批清掉——页面本地隐藏了建议，重连或别的页面仍能看到未消费
   * 的旧建议，采纳与热度操作也可能丢。这里先重读文档：只有 `_ops` 仍等于**刚消费的
   * 那个载荷**时才清；否则保留，留给下一拍消费（`lastOpsPayload` 与之不等，必定消费）。
   */
  const clearOpsIfUnchanged = (
    svc: {
      describe?: () => Promise<unknown>;
      update: (ns: unknown, patch: object, expectedRevision?: number) => Promise<void>;
    },
    consumed: string,
  ): void => {
    void (async () => {
      try {
        const entry = await readSettingsEntry(svc);
        const current = typeof entry?.value._ops === 'string' && entry.value._ops !== ''
          ? entry.value._ops
          : readOps();
        if (current !== consumed) return; // 消费期间 client 写了新批次：不清
        // **带上 describe 拿到的 revision**：存储层会拒绝「期间被别人改过」的写入
        // （`SettingsRevisionMismatch`）。这是反例 #1 唯一能真正闭环的一层——只在
        // 写之前重读文档仍有一个窗口：client 恰好在这两步之间写入，清空照样落地。
        await svc.update(SUGGEST_GHOST_NAMESPACE, { _ops: EMPTY_PUSH }, entry?.revision);
      } catch (error) {
        // revision 冲突是**预期路径**（新批次留给下一拍消费），不是故障。
        ctx.logger.info(`dsh-foresight: _ops not cleared this round: ${String(error)}`);
      }
    })();
  };
  const startOpsPump = (svc: { update: (ns: unknown, patch: object) => Promise<void> }): void => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    /** 读本命名空间在 settings **文档**里的值。
     *
     * volatile 引用只在插件实例创建时被 loader 填过一次：之后经 settings 服务
     * 写入文档的值**不会**回写引用（真机实测 2026-10-12：client 写入 `_ops`
     * 后 `resolved._ops.get()` 始终是旧值，WebUI 保存 `llmEnabled: false` 后
     * 引用里也还是 true）。所以反向通道与实时配置都必须读文档——与 WebUI 同源。
     * 实现与 `_ops` 条件清除共用（`readSettingsDocument`）。 */
    const readDocumentValue = (): Promise<Record<string, unknown> | undefined> =>
      readSettingsDocument(svc as { describe?: () => Promise<unknown> });
    const tick = (): void => {
      timer = null;
      if (settingsSvc === null) {
        // 服务还没就绪也要继续排下一拍：这里如果直接 return，泵就永久停摆
        // （旧实现在这句上踩过：`_ops` 再也没被消费）。
        schedule();
        return;
      }
      if (inFlight) {
        schedule();
        return;
      }
      inFlight = true;
      void (async () => {
        try {
          const doc = await readDocumentValue();
          // 实时配置：文档里的可写字段覆盖进来（去掉两个 JSON 通道字段）。
          if (doc !== undefined) {
            const { _push: _ignoredPush, _ops: _ignoredOps, ...writable } = doc;
            syncLiveSettings({ ...flattenConfig(resolved), ...writable });
          } else {
            syncLiveSettings(flattenConfig(resolved));
          }
          const payload = typeof doc?._ops === 'string' && doc._ops !== '' ? doc._ops : readOps();
          pruneOpsAck(payload);
          if (payload !== lastOpsPayload) {
            lastOpsPayload = payload;
            idleTicks = 0;
            pendingClear = payload === EMPTY_PUSH || payload === '' ? null : payload;
            // 0.5.0 起 parseHotnessOps 返回 { ops, locale }（locale 是上游 client
            // 捎带的 UI 语言，我们没接；只取 ops 以保持本仓库 consumeOps 的签名）。
            consumeOps(parseHotnessOps(payload).ops, svc, payload);
          } else {
            idleTicks += 1;
            // **清空重试**：上一次条件清空可能输给 revision 竞争（client 恰好在
            // 「重读—写入」之间又写了新批次），此后载荷不再变化、不会再走 consume
            // 分支，于是 `_ops` 一直挂着没人再消费的旧批次——真机 2026-10-14 实测：
            // `_ops` 积到 18 条、revision 只涨不落，采纳/补抓全被卡在待确认状态。
            // 这里按保守节流补一次条件清空（同一个 `consumed` 载荷，带 revision 写）。
            if (pendingClear !== null && payload !== EMPTY_PUSH && payload !== '') {
              if (Date.now() - lastClearAttemptAt >= OPS_CLEAR_RETRY_MS) {
                lastClearAttemptAt = Date.now();
                clearOpsIfUnchanged(svc, pendingClear);
              }
            } else {
              pendingClear = null;
            }
          }
        } catch (error) {
          ctx.logger.warn?.(`dsh-foresight: _ops pump failed: ${String(error)}`);
        } finally {
          inFlight = false;
          schedule();
        }
      })();
    };
    let idleTicks = 0;
    /** 上一批已消费但**尚未确认清空**的 `_ops` 载荷（清空重试的比对基准）。 */
    let pendingClear: string | null = null;
    let lastClearAttemptAt = 0;
    /**
     * 卸载标志：`tick` 的 `finally` 会在异步工作结束后重新排表，若那一刻插件已被
     * 卸载（effect 清理只清掉**当前**那个 timer，而 tick 进来时就把 `timer` 置空了），
     * 就会在卸载后排出新的一拍——定时器永远活着、每 2.1s 空跑一次 settings 读取。
     * e2e 实测：coldstart 脚本在所有断言通过后**进程不退出**，就是这个尾巴。
     */
    let pumpDisposed = false;
    const schedule = (): void => {
      if (pumpDisposed || timer !== null) return;
      // 有动静就保持 700ms 的响应速度；长时间没动静退到 3 倍周期，避免白烧 CPU。
      const delay = idleTicks >= OPS_POLL_IDLE_TICKS ? OPS_POLL_MS * 3 : OPS_POLL_MS;
      timer = setTimeout(tick, delay);
    };
    try {
      ctx.effect(() => {
        schedule();
        return () => {
          pumpDisposed = true;
          if (timer !== null) clearTimeout(timer);
          timer = null;
        };
      }, 'suggest-ghost-local: _ops pump');
    } catch (error) {
      ctx.logger.warn?.(`dsh-foresight: could not start the _ops pump: ${String(error)}`);
    }
  };
  ctx.inject(['settings'], (settingsCtx) => {
    try {
      const svc = (settingsCtx as { settings?: { update: (ns: unknown, patch: object) => Promise<void> } }).settings;
      if (svc === undefined) return;
      settingsSvc = svc;
      // **先起泵**：它是反向通道（`_ops`）唯一的驱动。放在注入回调的最后一句时，
      // 中途任何一次同步抛错（都被下面的 catch 吞掉）都会让泵永不启动，而症状
      // 只是「client 的 pull 永不应答」——静默且极难定位（真机踩到过）。
      startOpsPump(svc);
      liveSettings = flattenConfig(resolved);
      // 启动时从持久化的 `_push` 恢复最后一条建议。`_push` 是建议（不可重建的
      // LLM 输出）唯一的持久载体：不恢复就只剩内存态，宿主重启即丢；而且下面
      // 那次启动对账推送会把文件里的旧建议一并覆盖掉。（实测 2026-10-12：
      // **不能读插件的 volatile 引用**——内核不把持久值喂回 volatile 字段，
      // 启动时 `resolved._push.get()` 仍是 schema 默认值；真值只在 settings
      // 文档里，必须经 `describe()` 读回。）
      const seedPersistedSuggestion = async (): Promise<void> => {
        let payload = readPush();
        const describe = (svc as { describe?: () => Promise<unknown> }).describe;
        if (typeof describe === 'function') {
          try {
            const rows = unwrapSettingsDocument(await describe.call(svc)) ?? [];
            const entry = rows.find((row) => row?.ns === SUGGEST_GHOST_NAMESPACE);
            const value = (entry?.value as { _push?: unknown } | null | undefined)?._push;
            if (typeof value === 'string' && value !== '') payload = value;
          } catch {
            // 读不到就退回 volatile 引用（某些代际可能把值喂回引用）。
          }
        }
        // `_push` v2（规范 §6）：盘上载荷**不再**被当作有效预测恢复——预测由源
        // 投影 + pull 的 catch_up 重建。只有 v1（旧建议路径）才回读恢复，避免把上
        // 一进程的旧幽灵当成本进程的有效建议；冷启动对账推送照旧。
        let protocol = 1;
        try {
          const parsed = JSON.parse(payload) as { protocol?: unknown };
          if (typeof parsed.protocol === 'number') protocol = parsed.protocol;
        } catch {
          // 坏载荷：parsePersistedPush 会给出空结果，按 v1 语义处理即可。
        }
        const persisted = parsePersistedPush(payload);
        if (protocol < 2 && persisted.suggestion !== null && persisted.sessionId !== null) {
          trackSuggestion(persisted.sessionId, persisted.suggestion);
        }
      };
      // 重启/重载对账：`_push` 是建议（不可重建的 LLM 输出）唯一的持久载体，
      // 而且它**确实会落盘**（volatile 字段值写在 profile 文档里，跨进程留存——
      // 实测确认；早前注释写反了）。所以下面先把它读回来恢复建议，再做启动推送，
      // 否则那次推送会把文件里的旧建议覆盖成空载荷。
      //
      // client 冷启动的 pull 若抢跑在本注入之前，那次写入不能被漏掉：泵从
      // **文档**读 `_ops`（不是 volatile 引用，见 readDocumentValue），所以启动时
      // 文档里的遗留请求会在第一拍（≤700ms）被消费并应答。
      // 热度恢复是异步的（storageDomain.open）：恢复完成后补推一次快照，修正
      // 恢复窗口内已推送的不完整热度。目标会话取自追踪的建议会话。
      // 先恢复持久化的建议，再做启动对账推送——顺序反了会把文件里的旧建议
      // 覆盖成空载荷。
      void (async () => {
        await seedPersistedSuggestion();
        await persistence.whenReady;
        // 回顾存储同样是异步恢复的：等它就绪再推，否则恢复窗口内的启动推送
        // 会漏掉已落盘的回顾（client 会以为这些回合没有回顾）。
        await recapStore.whenReady;
        if (settingsSvc === null || disposed) return;
        // 启动对账**总要推一次**：即便当前没有追踪的会话（新进程必然如此），
        // 载荷里的 `epoch` 也是 client 发现「宿主换人了」的唯一信号——它据此清掉
        // 跨进程残留的按会话缓存并重拉（否则一直显示上一个进程的建议）。
        try {
          pushToClient(statePushOf(lastSuggestionSession));
        } catch (cause) {
          // 恢复窗口内被卸载：同上，丢这一拍即可。
          ctx.logger.debug?.(`dsh-foresight: startup push skipped (disposed): ${String(cause)}`);
        }
      })();
      // `_ops` 反向通道：client 经 `ctx.remote.settings.mutate(ns, ops, revision)`
      // 写入 volatile 字段。宿主收不到内核的 `settings/document-updated`（见
      // startOpsPump 的注释），改由轮询该引用驱动；下面这个监听器保留作兼容
      // ——若某个内核代际把事件送进宿主作用域，它比轮询更快。两者都比对载荷
      // 字符串，不会重复消费。
      ctx.on('settings/document-updated', (ns: string) => {
        if (ns !== SUGGEST_GHOST_NAMESPACE) return;
        syncLiveSettings(flattenConfig(resolved));
        const payload = readOps();
        if (payload === lastOpsPayload) return; // 无变化
        lastOpsPayload = payload;
        // 同上方轮询路径：0.5.0 的 parseHotnessOps 返回 { ops, locale }。
        consumeOps(parseHotnessOps(payload).ops, svc, payload);
      });
      ctx.logger.info('dsh-foresight: settings wired (volatile config, ns=dsh-foresight)');
    } catch (error) {
      ctx.logger.warn(`dsh-foresight: settings wiring failed: ${String(error)}`);
    }
  });
  const effective = (): FlatConfig => effectiveConfig(flattenConfig(resolved), liveSettings);

  // —— 每会话历史环：最近用户消息文本（时间序），供 client 历史前缀补全 ——
  // 0.1.2 起会话快照不再向插件暴露对话 nodes；历史文本改由 host 侧维护并经
  // `_push` 推送。host 本就逐事件扫 user/message 做热度记账，顺带成环零新增
  // 扫描。环是会话日志的按需物化缓存：pull 时未命中就从日志现种（日志持久化，
  // apply 时必然已在内存），「播种时机」与竞态窗口一并消失；会话活跃期间由
  // session/event 增量维护。筛选语义与 client extractHistory 对齐：只收
  // source.kind === 'user' 的文本块，跳过系统注入与超长文本，相邻重复只计
  // 一次。环容量 = HISTORY_PUSH_CAP × 2（推送窗口的两倍，硬上限防泄漏）。
  const historyRings = new Map<string, string[]>();
  /** 取会话历史环：缓存未命中且会话存活时从日志物化（幂等，每会话至多一次）。 */
  const ringFor = (sessionId: string): string[] | undefined => {
    const cached = historyRings.get(sessionId);
    if (cached !== undefined) return cached;
    const session = ctx.sessions.get(sessionId as SessionId);
    if (session === undefined) return undefined; // 会话不存在（已销毁）：无法回答
    const seed = seedRingFromLog(session);
    historyRings.set(sessionId, seed);
    return seed;
  };
  const ringPush = (sessionId: string, text: string): void => {
    // 先物化（未命中则从日志现种）：环是日志的缓存，绝不能凭空从单条文本起建
    // ——否则该会话的历史前缀会丢掉此前的所有轮次。
    const ring = ringFor(sessionId);
    if (ring === undefined) return; // 会话不存在（已销毁）：无环可维护
    appendToRing(ring, text);
  };

  /**
   * 每会话建议表（`sessionId -> 建议`），有界保留最近 {@link SUGGESTION_CACHE_CAP}
   * 个会话。
   *
   * **为什么不能是单槽。** 早先只用 `lastSuggestion` / `lastSuggestionSession` 两个
   * 变量存「最后一个产生建议的会话」，于是同时活跃的多个会话会互相覆盖：host 推的
   * `suggestionSessionId` 永远是最后结束回合的那个，client 端的会话归属守卫
   * （index.ts 的 `stale` 判据）就把其余会话的建议全部隐藏——表现为「插件没生效」。
   * 改为按会话索引后，pull 应答能取回**所问会话**自己的建议，多开互不干扰。
   *
   * 仍然保留「最近一次建议」作为跨会话兜底（见 {@link lastSuggestionOf}），供
   * 尚未 pull 的页面显示（切回时立即可见）。
   */
  const suggestionBySession = new Map<string, SuggestGhostSuggested>();
  /** 最近一次产出的建议及其会话（跨会话兜底用；勿用于判定本会话有效性）。 */
  let lastSuggestion: SuggestGhostSuggested | null = null;
  let lastSuggestionSession: string | null = null;

  /** 取某会话当前语义有效的建议（null = 无）。判据从「时间」换成「语义」：
   * 建议对应的回合是否仍是该会话最后一个已完成回合——不是就作废（防止
   * 重启后把旧回合的建议当新建议显示）。这是 `_push` 里建议状态的唯一
   * 权威来源：启动时从盘上回读、pull 时校验后重推，都走这里。
   */
  const currentSuggestionFor = (sessionId: string): SuggestGhostSuggested | null => {
    const session = ctx.sessions.get(sessionId as SessionId);
    // 本会话自己的建议优先；没有则回落到最近一次建议（仅当它正属于本会话）。
    const own = suggestionBySession.get(sessionId)
      ?? (lastSuggestionSession === sessionId ? lastSuggestion : null);
    if (own === null) return null;
    return suggestionIsCurrent(own, session) ? own : null;
  };

  /**
   * 跨会话兜底：最近一次产出的建议（可能属于别的会话，client 会按归属隐藏）。
   */
  const lastSuggestionOf = (): { suggestion: SuggestGhostSuggested | null; sessionId: string | null } =>
    lastSuggestion === null || lastSuggestionSession === null
      ? { suggestion: null, sessionId: null }
      : { suggestion: lastSuggestion, sessionId: lastSuggestionSession };

  /**
   * 更新追踪状态——建议的产出与作废只发生在生成路径，所以追踪也
   * 只在这里更新（载荷推送不改它，见 pushToClient）。
   */
  function trackSuggestion(sessionId: string, suggestion: SuggestGhostSuggested | null): void {
    if (suggestion === null) suggestionBySession.delete(sessionId);
    else {
      suggestionBySession.set(sessionId, suggestion);
      // 有界：超容量时逐出最久未更新的会话（Map 保持插入序）。
      while (suggestionBySession.size > SUGGESTION_CACHE_CAP) {
        const oldest = suggestionBySession.keys().next();
        if (oldest.done === true) break;
        suggestionBySession.delete(oldest.value);
      }
    }
    // 「最近一次」槽位保持原有语义：产出即占位；清空只在本会话时清。
    const next = nextTrackedSuggestion(
      { suggestion: lastSuggestion, sessionId: lastSuggestionSession },
      sessionId,
      suggestion,
    );
    lastSuggestion = next.suggestion;
    lastSuggestionSession = next.sessionId;
  }

  /** `_push` v2 的预测记录字段（与 settings.ts 的 `GhostPushPayload` 对齐）。 */
  interface PredictionFields {
    readonly requestKey: string;
    readonly sessionId: string;
    readonly sourceTurn: number | null;
    readonly sourceEndSeq: number | null;
    readonly outcome: string;
    readonly reason: string | null;
    readonly requestId: string | null;
    readonly nonce: string | null;
    readonly generatedAt: number | null;
    /**
     * 发起时刻与耗时（ms）。真机验收要靠它区分「慢」和「失败」：只记
     * `generatedAt` 时，一个 `superseded` 记录看不出上一次到底跑了多久。
     */
    readonly startedAt: number | null;
    readonly durationMs: number | null;
  }

  /** 预测路由展示字段（设置页/诊断用）。 */
  interface RouteFields {
    readonly provider: string | null;
    readonly model: string | null;
    readonly parentEffort: string | null;
    readonly configuredEffort: string | null;
    readonly effectiveEffort: string | null;
    readonly source: 'inherited' | 'configured' | 'unavailable';
  }

  /** 预测记录：语义去重的终态缓存单位（键 = 稳定请求键）。 */
  interface PredictionRecord {
    readonly requestKey: string;
    readonly sessionId: string;
    readonly sourceTurn: number;
    readonly sourceEndSeq: number;
    /** 终态或过程态（过程态只用于推送，不参与「已有终态则命中缓存」判定）。 */
    readonly outcome: PredictionOutcome | 'started' | 'in_flight_reused' | 'cache_hit' | 'ineligible' | 'stale_source' | 'consumed';
    readonly reason: string | null;
    readonly requestId: string | null;
    readonly generatedAt: number;
    /** 发起时刻与耗时（仅诊断/验收展示，可选——过程态记录可能还没有耗时）。 */
    readonly startedAt?: number | null;
    readonly durationMs?: number | null;
    /**
     * 记录世代号（所有权）。在途回调只在「当前记录的世代仍等于自己登记时的世代」
     * 时回写；作废与采纳消费会递增世代，等于撤销旧请求的回写权（复核反例 #5）。
     */
    readonly generation: number;
    /**
     * 是否可参与「同键命中缓存、不重复调模型」的去重：`suggested`/`abstained`/
     * 真实失败为 true；`cancelled`、作废通知（stale_source/ineligible）与过程态
     * （started/in_flight_reused）为 false——否则重新开启预测后会一直命中作废记录。
     */
    readonly cacheable: boolean;
  }

  /**
   * 每会话最近一次预测记录（有界）。**终态缓存**：同键再次触发只回推缓存，不重复
   * 调模型；源身份（turn/endSeq）换代即自然失配，无需显式清除。
   */
  const predictionRecords = new Map<string, PredictionRecord>();
  /** catch_up 的确认凭证（client 的 nonce）：随应答载荷回带，终态后丢弃。 */
  const pendingNonces = new Map<string, string | null>();
  /** 同键在途复用登记（`PredictionFlight.startOrReuse` 是同步方法）。 */
  const predictions = new PredictionFlight();
  /**
   * 记录世代号：每次「所有权变更」递增（新请求登记、作废、采纳消费）。在途回调只
   * 在自己的世代仍是当前记录时才回写——只比较 requestKey 会让被取消的旧流覆盖新
   * 记录、并把 `cancelled` 变成可命中的终态缓存（复核反例 #5）。
   */
  let predictionGeneration = 0;
  const nextPredictionGeneration = (): number => {
    predictionGeneration += 1;
    return predictionGeneration;
  };
  /** 按会话的在途取消句柄（作废触发器用；随请求起落增删，天然有界）。 */
  const inFlightPredictions = new Map<
    string,
    { readonly key: string; readonly controller: AbortController; readonly generation: number }
  >();

  /**
   * 释放某次请求的在途取消句柄——**必须同时匹配 requestKey 与世代号**。
   *
   * 同键重新生成时，新请求会覆盖 Map 里的句柄；旧请求的回调若只比较 key，就会把
   * **新请求**的 controller 删掉（复核反例 #6：旧回调先结束 → 新回合作废时找不到
   * 句柄，新模型流仍在跑，失去取消控制）。世代号在每次作废/消费后递增，天然把
   * 「同一个 key 的两次请求」区分开。
   */
  const releaseInFlight = (sessionId: string, key: string, generation: number): void => {
    const handle = inFlightPredictions.get(sessionId);
    if (handle !== undefined && handle.key === key && handle.generation === generation) {
      inFlightPredictions.delete(sessionId);
    }
  };

  const recordPrediction = (record: PredictionRecord | null, sessionId: string): void => {
    if (record === null) predictionRecords.delete(sessionId);
    else {
      predictionRecords.set(sessionId, record);
      while (predictionRecords.size > SUGGESTION_CACHE_CAP) {
        const oldest = predictionRecords.keys().next();
        if (oldest.done === true) break;
        predictionRecords.delete(oldest.value);
      }
    }
  };

  /** 取某会话的预测记录字段（无记录 = null；client 据此区分「无记录」与「明确无建议」）。 */
  const predictionFieldsOf = (sessionId: string | null): PredictionFields | null => {
    if (sessionId === null) return null;
    const record = predictionRecords.get(sessionId);
    if (record === undefined) return null;
    const nonce = pendingNonces.get(sessionId);
    return {
      requestKey: record.requestKey,
      sessionId: record.sessionId,
      sourceTurn: record.sourceTurn,
      sourceEndSeq: record.sourceEndSeq,
      outcome: record.outcome,
      reason: record.reason,
      requestId: record.requestId,
      nonce: nonce === undefined ? null : nonce,
      generatedAt: record.generatedAt,
      startedAt: record.startedAt ?? null,
      durationMs: record.durationMs ?? null,
    };
  };

  /** 父会话请求头里的路由字段（跨代结构视图；与 prediction.ts 同策略）。 */
  const routeOfSession = (session: Session | undefined): {
    provider: string | null;
    model: string | null;
    parentEffort: string | null;
  } => {
    const header = (session as unknown as {
      requestHeader?: () => { readonly config?: { readonly provider?: unknown; readonly model?: unknown; readonly reasoningEffort?: unknown } } | undefined;
    } | undefined)?.requestHeader?.();
    const config = header?.config;
    const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
    return {
      provider: text(config?.provider),
      model: text(config?.model),
      parentEffort: text(config?.reasoningEffort),
    };
  };

  /**
   * 预测路由展示字段：`source` 三态 —— inherited（只继承父档）、configured（插件
   * 显式覆盖了推理档）、unavailable（父会话没有可继承的请求头 ⇒ 预测不可调用，
   * 明确报原因，**不换模型**）。
   */
  const routeFieldsOf = (sessionId: string | null): RouteFields | null => {
    if (sessionId === null) return null;
    const session = ctx.sessions.get(sessionId as SessionId);
    const parent = routeOfSession(session);
    const configured = (effective().reasoningEffort ?? '').trim();
    const configuredEffort = configured === '' ? null : configured;
    if (parent.provider === null || parent.model === null) {
      return {
        provider: parent.provider,
        model: parent.model,
        parentEffort: parent.parentEffort,
        configuredEffort,
        effectiveEffort: configuredEffort ?? parent.parentEffort,
        source: 'unavailable',
      };
    }
    return {
      provider: parent.provider,
      model: parent.model,
      parentEffort: parent.parentEffort,
      configuredEffort,
      effectiveEffort: configuredEffort ?? parent.parentEffort,
      source: configuredEffort === null ? 'inherited' : 'configured',
    };
  };

  /** 推给 client 的 `_push` 载荷（结构化形态；写盘前序列化）。 */
  interface ClientPush {
    /** 最新 LLM 建议；null = 清空当前建议。 */
    readonly suggestion: SuggestGhostSuggested | null;
    /** 建议所属会话（client 据此只在同会话显示建议）。 */
    readonly suggestionSessionId: string | null;
    /** 跨会话热度快照。 */
    readonly hot: readonly SuggestGhostHotEntry[] | null;
    /** 热表总条目数（管理面板「共 N 条」展示；快照只是 top-K）。 */
    readonly total: number;
    /** 历史环推送：最近用户消息文本（时间序）；null = 不携带（保留 client 现值）。 */
    readonly history: readonly string[] | null;
    /** history 所属会话；null 同步 history 为 null。 */
    readonly historySessionId: string | null;
    /** 本次生成失败的摘要（可诊断；成功/无错误时缺省）。 */
    readonly error?: string;
    /** 预测记录（`protocol: 2`）；null/缺省 = 本会话没有记录。 */
    readonly prediction?: PredictionFields | null;
    /** 本会话待确认的 catch_up 凭证（顶层回带；`prediction` 为 null 时也存在）。 */
    readonly nonce?: string | null;
    /** 预测路由与推理档（`protocol: 2`）。 */
    readonly route?: RouteFields | null;
    /** `_ops` 消费回执（`protocol: 2`）：本批已消费的 `pull`/`consume` 操作 id。 */
    readonly opsAck?: readonly string[];
    /**
     * 本会话的回合回顾（按回合升序）；`null` = 该会话没有回顾（client 清空显示）。
     * 与 `recapsSessionId` 同时出现或同时缺席——缺席表示「本次推送不携带」。
     */
    readonly recaps?: readonly RecapEntry[] | null;
    /** `recaps` 所属会话（client 据此只在同会话渲染）。 */
    readonly recapsSessionId?: string | null;
  }

  const fingerprintOf = (p: ClientPush): string => {
    const sug = p.suggestion === null
      ? '\u2205'
      : `${p.suggestion.turn}:${p.suggestion.text}:${p.suggestion.truncated}:${p.suggestion.acceptKey}`;
    const hotKey = p.hot === null || p.hot.length === 0
      ? '\u2205'
      : p.hot.map(h => `${h.text}\u00d7${h.count}${h.pinned === true ? '!p' : ''}`).join('|');
    const historyKey = p.history === null || p.history.length === 0 || p.historySessionId === null
      ? '\u2205'
      : `${p.historySessionId}#${p.history.length}:${p.history[p.history.length - 1] ?? ''}`;
    // v2：指纹必须覆盖「会影响显示」的全部内容——目标身份（requestKey/sessionId）、
    // outcome、非空 reason、requestId/nonce。只比 outcome 会让两条不同来源的记录
    // 被判成同一份载荷而漏推（规范 §6）。
    const prediction = p.prediction;
    const predictionKey = prediction === undefined || prediction === null
      ? '\u2205'
      : `${prediction.requestKey}\u00a7${prediction.sessionId}\u00a7${prediction.outcome}\u00a7${prediction.reason ?? ''}\u00a7${prediction.requestId ?? ''}\u00a7${prediction.nonce ?? ''}`;
    const route = p.route;
    const routeKey = route === undefined || route === null
      ? '\u2205'
      : `${route.source}\u00a7${route.provider ?? ''}\u00a7${route.model ?? ''}\u00a7${route.parentEffort ?? ''}\u00a7${route.configuredEffort ?? ''}\u00a7${route.effectiveEffort ?? ''}`;
    // `<ACK>` 必须进指纹：回执只出现在那一拍，若被去重吞掉 client 的待确认集合
    // 就只能靠 nonce/记录状态推断，操作会反复重写。
    const ackKey = p.opsAck === undefined || p.opsAck.length === 0 ? '\u2205' : p.opsAck.join(',');
    // recap：会话身份 + 每条的回合号与文本进指纹（文本一变就必须重推）。
    const recapsKey = p.recapsSessionId === undefined || p.recapsSessionId === null
      ? '\u2205'
      : `${p.recapsSessionId}#${(p.recaps ?? []).length}:${(p.recaps ?? []).map(r => `${r.turn}:${r.text}`).join('\u00a6')}`;
    return `${sug}<HOT>${hotKey}<T>${p.total}<HIST>${historyKey}<ERR>${p.error ?? ''}<PRED>${predictionKey}<ROUTE>${routeKey}<NONCE>${p.nonce ?? ''}<ACK>${ackKey}<RECAP>${recapsKey}`;
  };
  /**
   * 经 `_push` volatile 字段把最新建议+热度+历史推给 client。
   *
   * 0.1.7 里字段载体从 `SettingsScope` 换成 `SettingsForms` 的 volatile 配置
   * 字段（`ctx.settings.update(ns, patch)`），**载荷结构不变**，故 client 侧的
   * 解析与 `*SessionId` 归属守卫都无需改动。
   *
   * 幂等优化：payload 与上次完全一致时直接跳过——避免重复写 + client 端
   * JSON 解析/重渲染。`history: null` 表示本次推送不携带历史（client 保留
   * 现值）——pull/turn-end 想更新历史时才携带。
   *
   * 尾写合并：`settings.update` 是异步的；同一时刻连续多次 push 会排成多次
   * 顺序写入。这里把最新载荷挂起，在途写入完成后只补写**最新一份**。
   */
  let pushRev = 0;
  /**
   * 本实例的标识：每次挂载都不同。载荷里带上它，client 才能分辨「这份 `_push`
   * 是新宿主写的还是上一个进程留下的」——`_push` 的值跨进程留存（volatile 字段
   * 只在等于默认值时才被剔除），插件重载后 client 会照旧读到旧载荷。
   */
  const instanceEpoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let lastPushFingerprint: string | null = null;
  let pushInFlight: Promise<void> | null = null;
  let pendingPushPayload: string | null = null;
  /**
   * `_ops` 消费回执（见 `consumeOps`）：**粘性**保留，直到 client 的 `_ops` 载荷
   * 里不再出现这些 id（自己清掉、或换来新一批）。
   *
   * 早先的实现只把回执挂在「紧接着的那一次推送」上：那一拍若没送出去（写盘失败、
   * 或推送被指纹去重跳过），回执就永久消失，client 的待确认集合靠 30s 低频补投硬撑
   * （真机 2026-10-14 实测：`_ops` 里积了 18 条操作、`opsAck` 一帧都没有）。粘性回执
   * 让每一次推送都携带它，client 任何一次 reads 都能确认——代价是载荷里多几个短 id。
   */
  let stickyOpsAck: readonly string[] = [];
  /** 回执条数上限：client 一次能塞进 `_ops` 的操作远小于这个数，只防无界增长。 */
  const OPS_ACK_CAP = 64;
  const rememberOpsAck = (ids: readonly string[]): void => {
    if (ids.length === 0) return;
    const merged = [...stickyOpsAck];
    for (const id of ids) if (!merged.includes(id)) merged.push(id);
    stickyOpsAck = merged.length > OPS_ACK_CAP ? merged.slice(merged.length - OPS_ACK_CAP) : merged;
  };
  /**
   * 丢掉 client 已不再持有的回执：`_ops` 载荷里找不到该 id，说明它已被确认并移除
   * （或整批被清空）。不这样做的话，回执会永久累积、每次推送都拖着历史。
   */
  const pruneOpsAck = (payload: string | null): void => {
    if (stickyOpsAck.length === 0) return;
    if (payload === null || payload === '' || payload === EMPTY_PUSH) {
      stickyOpsAck = [];
      return;
    }
    stickyOpsAck = stickyOpsAck.filter((id) => payload.includes(id));
  };
  const pushToClient = (input: ClientPush): void => {
    if (disposed || settingsSvc === null) return;
    const ack = input.opsAck ?? (stickyOpsAck.length > 0 ? stickyOpsAck : undefined);
    const p: ClientPush = ack === undefined ? input : { ...input, opsAck: ack };
    const fingerprint = fingerprintOf(p);
    if (lastPushFingerprint === fingerprint) return; // 无变化，跳过写盘
    lastPushFingerprint = fingerprint;
    pushRev += 1;
    // 注意：这里**不**改 lastSuggestion/lastSuggestionSession。载荷里的
    // `suggestion: null` 有两种含义——「本会话没有建议」（如 pull 一个没有建议
    // 的会话）与「建议被作废」。若在这里按载荷清空追踪状态，pull 一次别的会话
    // 就会把仍在有效期的那条建议弄丢。追踪状态只在真正产出/作废建议的地方更新
    // （handleTurnEnd 的生成结果与启动对账）。
    const payload = {
      rev: pushRev,
      epoch: instanceEpoch,
      /** 载荷协议版本（规范 §6）：v2 只新增字段，既有字段语义不变。 */
      protocol: 2 as const,
      suggestion: p.suggestion === null ? null : {
        turn: p.suggestion.turn,
        baseSeq: p.suggestion.baseSeq,
        text: p.suggestion.text,
        truncated: p.suggestion.truncated,
        acceptKey: p.suggestion.acceptKey,
      },
      suggestionSessionId: p.suggestionSessionId,
      hot: p.hot !== null && p.hot.length > 0 ? [...p.hot] : null,
      total: p.total,
      ...(p.history !== null && p.historySessionId !== null
        ? { history: [...p.history], historySessionId: p.historySessionId }
        : {}),
      // 预测记录**始终携带**（null 表示本会话没有记录）：作废/清空时若省略字段，
      // client 无法区分「没有记录」与「这一拍没变」，会保留过期幽灵（规范 §6）。
      prediction: p.prediction === undefined ? null : p.prediction,
      ...(p.route !== undefined && p.route !== null ? { route: p.route } : {}),
      // 顶层 nonce（待确认的 catch_up 凭证）：`prediction` 为 null 时也要回带，否则
      // client 的 pending 永远等不到回执（只按 `prediction.nonce` 判会挂死，e2e 实测）。
      nonce: p.nonce ?? null,
      // `_ops` 消费回执：非空才带（空数组与缺省同义），避免每次推送都撑大载荷。
      ...(p.opsAck !== undefined && p.opsAck.length > 0 ? { opsAck: [...p.opsAck] } : {}),
      // 回合回顾：`recapsSessionId` 出现即表示「这是该会话的完整回顾集合」（可能为空
      // 数组 = 明确清空）；两个字段都缺席 = 本次推送不携带（client 保留现值）。
      ...(p.recapsSessionId !== undefined && p.recapsSessionId !== null
        ? {
          recaps: (p.recaps ?? []).map(entry => ({ turn: entry.turn, text: entry.text })),
          recapsSessionId: p.recapsSessionId,
        }
        : {}),
      ...(p.error !== undefined ? { error: p.error } : {}),
    };
    // 合并缓冲：若已有在途写入，只更新「最新待写」；flush 在途完成后补写。
    pendingPushPayload = JSON.stringify(payload);
    flushPush();
  };
  /** 尾写合并：把挂起的最新载荷写入；写入期间再来新载荷则在完成后续写。 */
  const flushPush = (): void => {
    if (settingsSvc === null || pushInFlight !== null) return;
    const payload = pendingPushPayload;
    pendingPushPayload = null;
    if (payload === null) return;
    pushInFlight = settingsSvc.update(SUGGEST_GHOST_NAMESPACE, { _push: payload })
      .catch((error: unknown) => {
        ctx.logger.warn(`dsh-foresight: push to client failed: ${String(error)}`);
      })
      .finally(() => {
        pushInFlight = null;
        if (pendingPushPayload !== null) flushPush(); // 写入期间又有新载荷 → 续写最新
      });
  };

  /**
   * 组装某会话的**当前权威状态**并推给 client：历史环按需从日志物化（ringFor，
   * 无播种时机概念）、建议经语义校验（currentSuggestionFor）、热度取热表现照。
   * 启动对账、pull 应答、热度恢复补推三条路径共用这一份组装逻辑——它们此前
   * 各写各的，是冷启动竞态的根源。
   *
   * 建议字段的跨会话语义：本会话的建议按校验结果推（有效原样 / 陈旧清掉）；
   * 其他会话的有效建议原样保留——client 端按会话归属守卫隐藏，切回时仍在
   * 有效期，推 null 反而会把切回后的建议弄丢。
   * @param sessionId - 目标会话；null 表示无特定会话（仅刷新热度，历史不携带）。
   */
  const statePushOf = (sessionId: string | null): ClientPush => {
    const ring = sessionId === null ? undefined : ringFor(sessionId);
    // 建议字段：本会话按语义校验取用；不属于本会话但仍被追踪的那条原样带上
    // （client 按会话归属守卫隐藏，切回时立即可用）。
    const fields = suggestionFieldsFor(
      { suggestion: lastSuggestion, sessionId: lastSuggestionSession },
      sessionId,
      sessionId === null ? null : currentSuggestionFor(sessionId),
      sessionId === null ? true : ctx.sessions.get(sessionId as SessionId) !== undefined,
    );
    return {
      suggestion: fields.suggestion,
      suggestionSessionId: fields.sessionId,
      hot: hotness.snapshot(liveSettings.historyMaxEntries),
      total: hotness.size,
      history: ring === undefined ? null : ring.slice(-HISTORY_PUSH_CAP),
      historySessionId: ring === undefined ? null : sessionId,
      // v2：预测记录与路由随每一份状态应答同行——pull 应答、启动对账、终态推送
      // 共用这一处组装，避免多条路径各写各的（冷启动竞态的历史教训）。
      prediction: predictionFieldsOf(sessionId),
      route: routeFieldsOf(sessionId),
      // 顶层 nonce：`prediction` 为 null（该会话暂无记录）时，client 仍要能凭它清
      // pending；只挂在记录里会让「无记录」的 pull 应答永远不被确认（e2e 实测）。
      nonce: sessionId === null ? null : pendingNonces.get(sessionId) ?? null,
      // 回合回顾（recap）：会话级权威状态的一部分——pull 应答/启动对账/回顾生成
      // 完成三条路径共用这一处组装。`null` 会显式下发「该会话没有回顾」。
      recaps: sessionId === null ? null : recapStore.list(sessionId),
      recapsSessionId: sessionId,
    };
  };

  /**
   * `_ops` 消费器（watch 触发与启动遗留补消费共用）：pull 走统一的状态组装应答，
   * 其余操作交热表层应用（幂等），最后 flush 并清空队列。
   * @param ops - 已解析的操作批；空数组直接返回（不写盘）。
   * @param svc - settings 写面，用于消费后清空 `_ops`。
   */
  const consumeOps = (
    ops: readonly HotnessOp[],
    svc: { describe?: () => Promise<unknown>; update: (ns: unknown, patch: object) => Promise<void> },
    consumed: string,
  ): void => {
    if (ops.length === 0) return;
    // 本批 `pull`/`consume` 的操作 id：登记进**粘性**回执集合（`stickyOpsAck`），
    // 之后每一次推送都携带，直到 client 自己把这些 id 从 `_ops` 里去掉。
    const ackIds = ops
      .filter((op) => (op.op === 'pull' || op.op === 'consume') && typeof op.id === 'string' && op.id !== '')
      .map((op) => (op as { id: string }).id);
    rememberOpsAck(ackIds);
    for (const op of ops) {
      if (op.op === 'pull') {
        // client 的确认凭证（nonce）**必须先登记再应答**：应答这一拍自己就要把它
        // 带回去，client 见到同值才清 pending。顺序反了（先推送再登记）的表现是
        // 「pull 应答永远不带 nonce」——client 的 pending 挂死（e2e 实测抓到）。
        const nonce = op.nonce ?? null;
        if (nonce !== null) pendingNonces.set(op.sessionId, nonce);
        // 无论历史环可不可得都应答：环缺失（会话尚未进店/已销毁）时 statePushOf
        // 会省略 history（client 保留现值），但热度、预测记录与对账后的建议照常
        // 送达——静默丢弃会让 client 永远等不到这一轮对账。
        try {
          pushToClient(statePushOf(op.sessionId));
        } catch (cause) {
          ctx.logger.debug?.(`dsh-foresight: pull push skipped (disposed): ${String(cause)}`);
        }
        // 预测主链路 catch_up（规范 §3.1/§3.3）：**只有 client 明确请求**才补抓，
        // 且由 client 保证前提（会话可见、服务就绪、草稿为空、非运行/非 IME）。
        // 缺省 pull 只同步状态，绝不隐式触发模型。
        if (op.requestPrediction === true) {
          const session = ctx.sessions.get(op.sessionId as SessionId);
          if (session !== undefined) requestPrediction(session, 'catch_up', nonce);
          else pendingNonces.delete(op.sessionId);
        } else if (nonce !== null) {
          // 纯状态同步：应答已回带 nonce，这一拍之后它不该再出现在后续推送里。
          pendingNonces.delete(op.sessionId);
        }
        continue;
      }
      if (op.op === 'consume') {
        // 采纳后消费：记录不再可显示（草稿清空也不复活），并立即回推一次权威状态。
        consumePrediction(op.sessionId, op.requestKey);
      }
    }
    const changed = persistence.applyOps(ops);
    if (changed > 0) ctx.logger.info(`dsh-foresight: hotness ops applied (${changed} changed)`);
    void persistence.flush();
    // 消费完成：**条件**清空队列（无条件写 `'null'` 会清掉 client 期间写入的新批次）。
    // 回执不在这里丢弃：`stickyOpsAck` 会一直带到 client 自己清掉 `_ops`（pruneOpsAck）。
    clearOpsIfUnchanged(svc, consumed);
  };

  /** 取（或惰性创建）会话状态。`lastSuggestedTurn` 从日志恢复，只作诊断。 */
  const stateOf = (session: Session): SessionState => {
    let state = states.get(session);
    if (state === undefined) {
      state = { lastSuggestedTurn: lastSuggestedTurnInLog(session), prediction: undefined };
      states.set(session, state);
      tracked.add(state);
    }
    return state;
  };

  /** 权威状态推送：历史环 + 热度 + 预测记录 + 路由（可选附带失败摘要）。 */
  const pushState = (sessionId: string | null, error?: string): void => {
    if (disposed) return;
    let state;
    try {
      state = statePushOf(sessionId);
    } catch (cause) {
      // 卸载竞态（见 `disposed` 的注释）：上下文已 inactive，别再把异常甩进
      // 宿主的未捕获链路——静默丢弃这一拍即可，重启后启动对账会重建状态。
      ctx.logger.debug?.(`dsh-foresight: state push skipped (disposed): ${String(cause)}`);
      return;
    }
    pushToClient({ ...state, ...(error === undefined ? {} : { error }) });
  };

  /**
   * 作废某会话的预测（规范 §3.3 的触发器：新回合开始、预测开关关闭、生成配置
   * 变更、会话销毁）。中止在途、丢终态缓存、清建议，并推一拍让 client 立刻撤下
   * 幽灵；记录本身保留身份与来源，只把 outcome 改成 stale_source / ineligible，
   * 使 client 能区分「被上游作废」与「本来就没有建议」。
   */
  const invalidatePrediction = (
    sessionId: string,
    reason: 'superseded' | 'config_changed' | 'llm_disabled' | 'session_gone',
  ): void => {
    const inFlight = inFlightPredictions.get(sessionId);
    inFlight?.controller.abort();
    // 撤销同键在途登记（复核反例 #5）：不撤销的话，「关掉预测再打开」会对同一源
    // 回合复用那条已取消的旧流（`startOrReuse` 命中旧 promise），而旧流的回写又会
    // 把 `cancelled` 写成终态缓存。
    if (inFlight !== undefined) predictions.forget(inFlight.key);
    inFlightPredictions.delete(sessionId);
    const previous = predictionRecords.get(sessionId);
    trackSuggestion(sessionId, null);
    pendingNonces.delete(sessionId);
    if (reason === 'session_gone') {
      recordPrediction(null, sessionId);
      return;
    }
    recordPrediction(previous === undefined ? null : {
      ...previous,
      outcome: reason === 'llm_disabled' ? 'ineligible' : 'stale_source',
      reason,
      generatedAt: Date.now(),
      // 作废即撤销所有权并让记录**不可命中缓存**（世代递增也让旧在途回调的回写失效）。
      generation: nextPredictionGeneration(),
      cacheable: false,
    }, sessionId);
    pushState(sessionId);
  };

  /**
   * 生成配置身份：路由、推理档、预算、开关任何一个变了，缓存的终态与在途请求都
   * 必须作废（规范 §3.3）——否则会静默沿用旧模型/旧预算的结果。字段顺序固定。
   */
  const configIdentityOf = (settings: FlatConfig): string => [
    settings.provider ?? '',
    settings.model ?? '',
    (settings.reasoningEffort ?? '').trim(),
    String(settings.maxOutputTokens),
    String(settings.timeoutMs),
    settings.llmEnabled === false ? 'off' : 'on',
  ].join('\u0000');

  /** 配置/开关变化：作废全部会话的预测（含在途）并各推一拍。 */
  const invalidateAllPredictions = (reason: 'config_changed' | 'llm_disabled'): void => {
    const ids = new Set<string>([...predictionRecords.keys(), ...inFlightPredictions.keys()]);
    for (const id of ids) invalidatePrediction(id, reason);
    // 没有任何记录也要推一拍：client 可能还显示着它自己缓存的那条幽灵。
    if (ids.size === 0) pushState(lastSuggestionSession);
  };

  /** 更新 live 配置；身份变化即作废预测（轮询泵与兼容事件路径共用）。 */
  const syncLiveSettings = (next: FlatConfig): void => {
    // 比较基准是**当前 live 配置**而不是一个 null 哨兵：首拍前文档里的配置就可能已经
    // 与启动配置不同（用户早已关闭预测），哨兵写法会把这次差异当成「首次观测」吞掉，
    // 于是继续沿用启动配置的缓存与在途（e2e 实测：llmEnabled 关闭后不作废）。
    const previous = liveSettings;
    liveSettings = next;
    if (configIdentityOf(next) === configIdentityOf(previous)) return;
    invalidateAllPredictions(next.llmEnabled === false ? 'llm_disabled' : 'config_changed');
  };

  /** 采纳后消费：记录不再可显示（草稿清空也不复活），并立即回推权威状态。 */  const consumePrediction = (sessionId: string, requestKey: string): void => {
    const record = predictionRecords.get(sessionId);
    // 键不匹配 = 陈旧 client 的重复消费请求（或记录已换代）：无副作用地忽略。
    if (record === undefined || record.requestKey !== requestKey) return;
    const inFlight = inFlightPredictions.get(sessionId);
    inFlight?.controller.abort();
    if (inFlight !== undefined) predictions.forget(inFlight.key);
    inFlightPredictions.delete(sessionId);
    trackSuggestion(sessionId, null);
    // 消费是终态：同一源回合不再重生成（`cacheable: true`），但世代递增以撤销任何
    // 仍在途的旧请求的回写权。
    recordPrediction({
      ...record,
      outcome: 'consumed',
      reason: 'adopted',
      generatedAt: Date.now(),
      generation: nextPredictionGeneration(),
      cacheable: true,
    }, sessionId);
    pendingNonces.delete(sessionId);
    pushState(sessionId);
  };

  /**
   * **预测主链路统一入口**（规范 §3.1）：live（回合结束）与 catch_up（打开会话/
   * 重连后 pull）走同一份登记—去重—请求—缓存逻辑，区别只有 `trigger`。
   *
   * 顺序是硬约束：登记（读源 + 算键 + 查缓存 + 查在途）必须在**第一个 await 之前
   * 同步完成**，否则同一源的两路触发会各起一次模型请求。
   */
  const requestPrediction = (session: Session, trigger: PredictionTrigger, nonce: string | null): void => {
    // 自激守卫（第一道）：预测子会话的任何事件都不得再触发预测。
    if (isPredictionChildSession(session.id)) return;
    // 自激守卫（第二道）：子代理会话不是用户的对话。为它的回合做预测要付与主会话
    // 相同的代价（一次全文 fork + 一次模型调用），建议却几乎没人看——实测 30 小时内
    // 56 个子代理会话会白烧同样数量的满上下文调用。只排除显式 `origin: 'subagent'`；
    // 普通用户 fork 保持现状（规范 §3.1：不因存在 parentSession 就排除）。
    if (session.header.origin === 'subagent') return;
    const settings = effective();
    if (settings.llmEnabled === false) {
      invalidatePrediction(session.id, 'llm_disabled');
      return;
    }
    const source = predictionSource.read(session);
    if (source.kind !== 'ok') {
      // 源不可用：不回退到旧推送、不扫描日志，只记录可诊断的状态等下一拍对账。
      recordPrediction({
        requestKey: `unavailable\u0000${session.id}\u0000${source.reason}`,
        sessionId: session.id,
        sourceTurn: -1,
        sourceEndSeq: -1,
        outcome: source.reason === 'ineligible' ? 'ineligible' : 'stale_source',
        reason: source.reason,
        requestId: null,
        generatedAt: Date.now(),
        generation: nextPredictionGeneration(),
        cacheable: false,
      }, session.id);
      pushState(session.id);
      return;
    }
    const parent = routeOfSession(session);
    if (parent.provider === null || parent.model === null) {
      // 父路由不可用：明确报原因、**不换模型**（规范 §4.2），历史补全照旧可用。
      recordPrediction({
        requestKey: `route_unavailable\u0000${session.id}\u0000${source.turn}\u0000${source.endSeq}`,
        sessionId: session.id,
        sourceTurn: source.turn,
        sourceEndSeq: source.endSeq,
        outcome: 'failed',
        reason: 'route_unavailable',
        requestId: null,
        generatedAt: Date.now(),
        generation: nextPredictionGeneration(),
        cacheable: false,
      }, session.id);
      pushState(session.id, 'prediction unavailable: the parent session has no request route to inherit');
      return;
    }
    const configuredEffort = (settings.reasoningEffort ?? '').trim();
    const key = predictionRequestKey({
      sessionId: session.id,
      turn: source.turn,
      endSeq: source.endSeq,
      recipeVersion: PREDICTION_RECIPE_VERSION,
      provider: parent.provider,
      model: parent.model,
      reasoningEffort: configuredEffort,
      maxOutputTokens: settings.maxOutputTokens,
      timeoutMs: settings.timeoutMs,
    });
    const cached = predictionRecords.get(session.id);
    // 只有**可缓存**的终态才参与去重：`cancelled` 与作废通知（stale_source/ineligible）
    // 一律不命中，否则「关掉预测再打开 / 换回合再回来」会一直复用那条作废记录、
    // 永远不再请求（复核反例 #5）。
    if (cached !== undefined && cached.requestKey === key && cached.cacheable === true) {
      // 终态缓存命中（含 catch_up 晚到的情况）：不重复调模型，只回推记录。
      pushState(session.id);
      return;
    }
    /** 本次登记的世代号（只在真正新建 flight 时递增，见下）。 */
    let generation = 0;
    /** 本次预测的发起时刻（诊断/验收用；复用分支不重置）。 */
    let startedAtMs = 0;
    const flight = predictions.startOrReuse(key, () => {
      generation = nextPredictionGeneration();
      startedAtMs = Date.now();
      const controller = new AbortController();
      inFlightPredictions.set(session.id, { key, controller, generation });
      return runPrediction(ctx, {
        session,
        source,
        trigger,
        signal: controller.signal,
        maxOutputTokens: settings.maxOutputTokens,
        timeoutMs: settings.timeoutMs,
        reasoningEffort: configuredEffort,
        // 生成期间源身份必须不变：变了就不用这份历史补偿旧请求（规范 §4.1）。
        revalidate: () => {
          const again = predictionSource.read(session);
          return again.kind === 'ok' && again.turn === source.turn && again.endSeq === source.endSeq;
        },
      });
    });
    const previous = predictionRecords.get(session.id);
    if (flight.reused) {
      // 在途复用：不新建 fork、不新建模型调用；只记过程态并回推（带 nonce 回执）。
      recordPrediction({
        requestKey: key,
        sessionId: session.id,
        sourceTurn: source.turn,
        sourceEndSeq: source.endSeq,
        outcome: 'in_flight_reused',
        reason: null,
        requestId: previous?.requestId ?? null,
        generatedAt: Date.now(),
        startedAt: previous?.startedAt ?? null,
        durationMs: previous?.durationMs ?? null,
        // 复用**不得**改写所有权：沿用当前记录的世代（没有记录时新开一个），
        // 否则那条真正在跑的请求回来时会被自己判成过期而丢弃。
        generation: previous?.generation ?? nextPredictionGeneration(),
        cacheable: false,
      }, session.id);
      pushState(session.id);
      return;
    }
    recordPrediction({
      requestKey: key,
      sessionId: session.id,
      sourceTurn: source.turn,
      sourceEndSeq: source.endSeq,
      outcome: 'started',
      reason: null,
      requestId: null,
      generatedAt: Date.now(),
      startedAt: startedAtMs,
      durationMs: null,
      generation,
      cacheable: false,
    }, session.id);
    pushState(session.id);
    void flight.result.then(
      (result: PredictionResult) => {
        releaseInFlight(session.id, key, generation);
        stateOf(session).lastSuggestedTurn = source.turn;
        // 在途期间记录已被作废、被消费或被新请求接手：丢弃本次结果，绝不覆盖新
        // 记录（世代比对覆盖了「同键但所有权已转移」的情况，复核反例 #5）。
        const current = predictionRecords.get(session.id);
        if (current !== undefined && current.generation !== generation) return;
        const suggestion: SuggestGhostSuggested | null =
          result.outcome === 'suggested' && result.suggestion !== null
            ? {
                version: 1,
                turn: source.turn,
                baseSeq: source.endSeq,
                // 合法输出按官方语义**只 trim**：多行与超 240 字符一律保留原文，
                // 不判失败、不首行化、不截断（240 只写在提示词里，规范 §5）。
                text: result.suggestion,
                truncated: false,
                acceptKey: effective().acceptKey ?? 'Tab',
              }
            : null;
        trackSuggestion(session.id, suggestion);
        recordPrediction({
          requestKey: key,
          sessionId: session.id,
          sourceTurn: source.turn,
          sourceEndSeq: source.endSeq,
          outcome: result.outcome,
          reason: result.reason ?? null,
          requestId: result.requestId,
          generatedAt: Date.now(),
          startedAt: startedAtMs,
          // 耗时优先用生成层回报的值（它含 fork/装配/消费的完整窗口），缺失时兜底本地计时。
          durationMs: typeof result.durationMs === 'number' ? result.durationMs : Date.now() - startedAtMs,
          generation,
          // 外部取消是「本次没跑完」，不是终态结论：不得命中缓存，否则重新开启
          // 预测后会一直复用它而不再请求。
          cacheable: result.outcome !== 'cancelled',
        }, session.id);
        pushState(
          session.id,
          result.outcome === 'failed' && result.reason !== undefined
            ? `prediction failed: ${result.reason}${
                result.detail === undefined || result.detail.length === 0
                  ? ''
                  : ` [${result.detail}]`
              }`
            : undefined,
        );
        if (result.outcome !== 'cancelled') {
          // nonce 必须**随这一拍终态推送**回去再清：client 靠「推送里出现同一 nonce」
          // 清 pending。先清后推会让终态推送丢掉确认凭证（e2e 实测抓到）。
          pendingNonces.delete(session.id);
        }
      },
      (error: unknown) => {
        releaseInFlight(session.id, key, generation);
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn(`dsh-foresight: prediction failed: ${message}`);
        const current = predictionRecords.get(session.id);
        if (current !== undefined && current.generation !== generation) return;
        trackSuggestion(session.id, null);
        recordPrediction({
          requestKey: key,
          sessionId: session.id,
          sourceTurn: source.turn,
          sourceEndSeq: source.endSeq,
          outcome: 'failed',
          reason: 'transport',
          requestId: null,
          generation,
          cacheable: true,
          generatedAt: Date.now(),
          startedAt: startedAtMs > 0 ? startedAtMs : null,
          durationMs: startedAtMs > 0 ? Date.now() - startedAtMs : null,
        }, session.id);
        // 同终态分支：nonce 随这一拍推送回带，再清（client 凭它清 pending）。
        pushState(session.id, message.slice(0, 300));
        pendingNonces.delete(session.id);
      },
    );
  };

  ctx.on('session/event', (session, event) => {
    // 预测子会话的事件**完全排除**：它的 user/message 是预测请求文本，绝不能进
    // 历史环、热度表，也不能再次触发预测（自激守卫第一道；runPrediction 内另有
    // 第二道同源过滤）。
    if (isPredictionChildSession(session.id)) return;
    // 回合边界是热表持久化的天然写点：本回合累计的 user/message 频次合并落盘
    // （fail-soft，未就绪/无脏标记时空转；卸载另有 close 兜底）。
    if (event.type === 'turn/end') void persistence.flush();
    // 传会话 id：同会话相邻重复的用户消息只计一次热度（对齐 extractHistory 的去重语义）。
    hotness.consume(event, session.id);
    const userText = userTextOfEvent(event);
    // ringPush 会先按需物化（含本事件之前的日志），无需任何「首见播种」步骤。
    if (userText !== null) ringPush(session.id, userText);
    // 新回合开始 = 预测作废触发器（规范 §3.3）：上一回合不再是「最后一个已完成
    // 回合」，在途请求中止、缓存自然失配、幽灵撤下。于是晚到的旧回合结束事件也
    // 拿不到候选资格——源投影的 endSeq 已经指向新回合。
    if (event.type === 'turn/start') {
      invalidatePrediction(session.id, 'superseded');
      return;
    }
    if (event.type === 'turn/end' && event.data.reason.kind === 'completed') {
      requestPrediction(session, 'live', null);
      // 回顾（recap）与预测并行：预测负责「下一句说什么」，回顾负责「这一轮做了
      // 什么」。两者的材料来源、路由与失败语义都独立，互不阻塞。
      requestRecap(session, event.data.turn);
    }
  });

  // 会话销毁：清记录、在途与凭证（client 列表里该会话已消失，无需推送）。
  ctx.on('session/disposed', (session: Session) => {
    invalidatePrediction(session.id, 'session_gone');
    const recap = recapFlights.get(session.id);
    recap?.controller.abort();
    recapFlights.delete(session.id);
  });

  // 插件卸载时中止所有在途生成与预测。
  ctx.effect(() => () => {
    disposed = true;
    for (const state of tracked) state.prediction?.controller.abort();
    for (const inFlight of inFlightPredictions.values()) inFlight.controller.abort();
    inFlightPredictions.clear();
    for (const flight of recapFlights.values()) flight.controller.abort();
    recapFlights.clear();
  });

  // `suggestGhost` 投影单元：last-wins fold。仅当投影注册表已组合时激活
  // （headless 组装不受影响）。
  //
  // 跨代注册：0.1.2 改了单元形状——`schema` → `stateSchema`，顶层 `view` 挪进
  // `wire.view`（payload schema 随之改名 `wire.viewSchema`），`init` 额外接收
  // (header, inheritedEventCount)（本插件的无参 init 天然兼容）。两代形状在
  // 对方的类型里都不可见，按 0.1.2 独有的 `cachedSnapshot` 方法探测代际后
  // 分别构造；类型层以宽松结构视图对接，运行时行为两代各自验证。
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    const registry = (projectionCtx as unknown as {
      sessionProjections?: {
        register: (definition: Record<string, unknown>) => () => void;
        cachedSnapshot?: unknown;
      };
    }).sessionProjections;
    if (registry === undefined) return;
    const is02 = typeof registry.cachedSnapshot === 'function';
    const fold = {
      key: PROJECTION_KEY,
      init: initSuggestGhostProjection,
      apply: applySuggestGhostProjection,
      stateVersion: 2,
    };
    if (is02) {
      registry.register({
        ...fold,
        stateSchema: suggestGhostSchema,
        wire: {
          viewSchema: suggestGhostSchema,
          view: (state: SuggestGhostProjection) => state,
        },
      });
    } else {
      registry.register({
        ...fold,
        schema: suggestGhostSchema,
        view: (state: SuggestGhostProjection) => state,
      });
    }
  });
}
