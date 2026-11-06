/**
 * `dsh-foresight` 的 settings 传输形状与配置合并。
 *
 * ## 0.1.7 的机制变化
 *
 * 内核移除了 `settings.yaml` 体系：`SettingsProvider.register()` 与
 * `SettingsScope<T>` 都不复存在，`ctx.settings` 变为 `SettingsForms`。命名空间
 * 不再由插件注册——内核把**插件自己的 Config schema**（其中 `.volatile()` 的
 * 字段）投影成 WebUI 表单，ns 即 Loader 条目 id（`dsh-foresight`）。所以：
 *
 *  - 用户可调项声明在 `index.ts` 的 `Config` 里（见那里的 `EditableFields`）；
 *  - host 写入经 `ctx.settings.update(ns, patch)`；
 *  - client 读取经 `ctx.remote.settings.describe()`；
 *  - 变更通知经 `settings/document-updated(ns, revision)` 事件。
 *
 * 本文件因此只保留两件事：`_push` / `_ops` 两个 JSON 载荷的**传输形状**，
 * 以及把 live 值合并回生成配置。schema 本身在 `Config` 里。
 * @module dsh-foresight/settings
 */

import type { SettingsNamespace } from '@deepseek-ai/dsh-settings';
import type { FlatConfig } from './generate.js';

/**
 * 命名空间名：等于 Loader 条目 id（见 cordis.patch.yml 的 `- id: dsh-foresight`）。
 * 不用官方 `settingsNamespace()` helper——它在 DSH 0.1.2 内核已被删除，运行时
 * 导入会让本模块链接失败；该 helper 仅是校验后原样返回同样的字符串。
 */
export const SUGGEST_GHOST_NAMESPACE = 'dsh-foresight' as SettingsNamespace;

/** `_push` / `_ops` 的空载荷（JSON 字符串的 null 表示）。 */
export const EMPTY_PUSH = 'null';

/**
 * host → client 推送载荷（`_push` 字段的 JSON 形态）。
 *
 * 跨会话单份载荷 + `*SessionId` 归属字段：client 据此只在同会话显示建议 /
 * 使用历史环。0.1.7 里字段载体从 `SettingsScope` 换成 volatile 配置字段，
 * **载荷结构不变**，故 client 的守卫逻辑也无需改动。
 */
export interface GhostPushPayload {
  /** 递增标识新值。 */
  readonly rev: number;
  /**
   * `_ops` 消费回执（规范 §6）：host 本次消费掉的 `pull`/`consume` 操作 id 列表。
   * client 据此把对应操作从待确认集合移除；缺省或空数组 = 本次没有可确认的操作。
   * 它不是「清空 `_ops`」的信号——host 用条件写清队列，client 不能依赖它。
   */
  readonly opsAck?: readonly string[];
  /**
   * 载荷协议版本（规范 §6）：本版为 2。v1 载荷无此字段，client 缺字段时按旧
   * 语义降级；v2 只**新增**字段，既有字段（suggestion/hot/history/…）语义不变。
   */
  readonly protocol?: 2;
  /** 本会话待确认的 catch_up 凭证（原样回带）。顶层字段：`prediction` 为 null
   * 时（该会话暂无记录）也能让 client 清掉 pending，否则它只能一直重发。 */
  readonly nonce?: string | null;
  /**
   * 宿主实例标识：每次插件挂载生成一个新值。
   *
   * `_push` 是 volatile 字段，**值会留在 profile 文档里**（只有「等于默认值」的
   * 字段才被剔除），所以宿主重启/插件重载后 client 读到的仍是上一个实例写的
   * 载荷——只看内容分不出「这份数据来自已经死掉的进程」。载荷带 epoch，client
   * 一见变化就清掉按会话缓存并重拉，避免显示上一个进程的建议。
   */
  readonly epoch?: string;
  /** 最新 LLM 建议；null = 无建议。 */
  readonly suggestion: {
    readonly turn: number;
    readonly baseSeq: number;
    readonly text: string;
    readonly truncated: boolean;
    readonly acceptKey: string;
  } | null;
  /** 建议所属会话（null = 无有效建议）。 */
  readonly suggestionSessionId: string | null;
  /** 跨会话热度快照（top-K）。 */
  readonly hot: readonly { text: string; count: number; pinned?: boolean }[] | null;
  /** 热表总条目数（管理面板「共 N 条」展示）。 */
  readonly total: number;
  /** 本会话历史环；缺省表示不携带（client 保留现值）。 */
  readonly history?: readonly string[];
  /** history 所属会话。 */
  readonly historySessionId?: string;
  /** 最近一次生成失败的摘要（可诊断）。 */
  readonly error?: string;
  /**
   * 预测记录（`protocol: 2` 新增）。整份对象缺省 = 本会话没有预测记录（区别于
   * `outcome: 'abstained'`——后者是模型明确认为没有下一条建议，不是失败）。
   * 记录始终携带父 sessionId 与源身份，作废/清空时不会退化成 `null` 而丢失
   * 「该清哪个会话」的信息（规范 §6）。
   */
  readonly prediction?: {
    /** 稳定请求键：sessionId + sourceTurn + sourceEndSeq + recipeVersion + 生成配置身份。 */
    readonly requestKey: string;
    readonly sessionId: string;
    readonly sourceTurn: number | null;
    readonly sourceEndSeq: number | null;
    /**
     * 终态：suggested/abstained/failed/cancelled/consumed；
     * 过程态：started/in_flight_reused/cache_hit/ineligible/stale_source。
     */
    readonly outcome: string;
    /** 失败细分原因（suggested/abstained 时为 null）。 */
    readonly reason: string | null;
    /** 本次请求的可见标识（写入者：host；供采纳消费与遥测关联）。 */
    readonly requestId: string | null;
    /** catch_up 的确认回执：client 见到自己发出的 nonce 即清 pending。 */
    readonly nonce: string | null;
    readonly generatedAt: number | null;
    /**
     * 发起时刻与耗时（ms）。真机验收时用来区分「慢」和「失败」——只看 `generatedAt`
     * 无法判断一个 `superseded`/`stale_source` 记录上一次实际跑了多久。
     */
    readonly startedAt?: number | null;
    readonly durationMs?: number | null;
  } | null;
  /**
   * 预测实际使用的路由与推理档（`protocol: 2` 新增）：parent = 父会话请求头、
   * configured = 插件显式配置、effective = 实际生效。用于卡片展示「预测继承父
   * 会话模型；父路由不可调用时预测不可用」。
   */
  readonly route?: {
    readonly provider: string | null;
    readonly model: string | null;
    readonly parentEffort: string | null;
    readonly configuredEffort: string | null;
    readonly effectiveEffort: string | null;
    readonly source: 'inherited' | 'configured' | 'unavailable';
  } | null;
}

/** `_push` / `_ops` 在 settings 里的传输形状（两个 JSON 字符串）。 */
export interface SuggestGhostSettings {
  /** host → client 的实时推送载荷（见 `GhostPushPayload`）。 */
  _push: string;
  /** client → host 的热度管理操作队列（见 `parseHotnessOps`）。 */
  _ops: string;
}

/**
 * 把 live 值合并回生成配置：路由对为空串时回退到插件配置的继承语义
 * （不显式传 provider/model → generateSuggestion 继承主请求路由）。
 */
export function effectiveConfig(plugin: FlatConfig, live: FlatConfig): FlatConfig {
  const liveProvider = live.provider ?? '';
  const liveModel = live.model ?? '';
  const route = liveProvider.trim() !== '' && liveModel.trim() !== ''
    ? { provider: liveProvider.trim(), model: liveModel.trim() }
    : ((plugin.provider ?? '').trim() !== '' && (plugin.model ?? '').trim() !== ''
      ? { provider: plugin.provider, model: plugin.model }
      : {});
  return {
    ...plugin,
    ...live,
    ...route,
  };
}
