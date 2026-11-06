/**
 * dsh-foresight client 端：双模式幽灵输入——
 * 1. 历史补全（草稿非空）：从当前会话历史找前缀匹配，幽灵显示剩余部分，Tab 采纳；
 * 2. LLM 预测（草稿为空）：读取 `suggestGhost` 会话投影，幽灵显示下一条建议，Tab 采纳。
 * 纯 DOM overlay 渲染（不依赖官方 setGhost 能力），零核心改动。
 *
 * 编译说明：本文件以单文件 CommonJS 打包进 __ModuleLoader__.load，
 * 运行时零依赖（所有 @deepseek-ai 引用均为 type-only）。
 *
 * rc.7 兼容性说明：DSH rc.7 的 client runner 把插件 apply 包进
 * `dynamicCordisContext` 严格门控 Proxy——`ctx` 只暴露 `ctx.on / ctx.provide /
 * ctx.effect` 等 verbs 与 `inject` 数组声明的服务，**不再提供 `ctx.inject(...)`
 * 延迟注入方法**（rc.6 遗留写法；rc.7 下访问未声明的 `ctx.inject` 会触发
 * rejectGuard 抛错、导致整个 client 插件加载失败）。本文件已改为 rc.7 写法：
 * 所需服务通过模块级 `inject` 数组声明（fiber 激活门控），apply 内直接用
 * `ctx.get(name)` 读取；设置卡片依赖的 `slots` / `settingsScope` 为可选服务，
 * 用 `ctx.get()` 可选读取，缺失时不注册卡片、不阻塞幽灵逻辑。
 *
 * 0.1.7 兼容性：`settingsScope` 服务已随 settings.yaml 体系移除。取数改为
 * `ctx.get('remote')?.settings.describe()`，写入改为 `mutate(ns, ops)`，变更通知
 * 订阅内核转发的 `settings/document-updated` 事件（**无轮询**）；设置卡片所需的
 * scope 最小面由本文件的 `remoteSettingsScope()` 适配器提供，卡片本体无需改动。
 *
 * **注意：remote 一律经 `ctx.get('remote')` 取，绝不读 `ctx.remote` 属性**，且
 * `inject` 必须同时声明 `remote.settings`（cordis reflect 把嵌套属性读拼成
 * `remote.settings` 子服务名）。详见下方 `remoteOf()`。
 * @module dsh-foresight/client
 */

import type {} from '@deepseek-ai/dsh-client-ui-conversation';
import type { Context } from '@deepseek-ai/cordis';
import type { SuggestGhostProjection, SuggestGhostSuggested } from '../domain.ts';
import { commonPrefixLength, extractHistory, historySuggestion, normalizeForMatch, stripCommandPrefix } from './history.ts';
import { nextAcceptChunk } from './chunk.ts';
import { keyCodeOf } from './keyspec.ts';
import { applyRecaps, clearRecaps, RecapLine } from './recap.tsx';
import { SuggestGhostCard } from './settings-card.tsx';
import type { PluginSettingsScope } from './settings-scope.ts';
import type { LocaleFaceLike } from './useGhostT.ts';

/**
 * 宿主可观察快照的最小结构视图。不从 @deepseek-ai/dsh-client-runtime 导入：
 * 该包是 0.1.1 内核特有，0.1.2 已把快照存储拆到 dsh-client-store，这里只用到
 * getSnapshot / subscribe 两个成员，本地声明即可切断这条跨代漂移的类型依赖。
 */
interface ObservableSnapshot<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

/**
 * 宿主会话列表快照的最小结构视图（只用到 `byId`）。
 *
 * 0.2.x 的 `SessionListState` 顶层只有 `ids` / `byId` / `phase` /
 * `projectionsBySession`，**没有 `current`**：当前会话建模为被 `mainView` 源
 * 保有的那一行，host 的 workspace / layout / session 包都用该判据推导 main。
 * `retainedBy` 只记正数计数，无引用的源键缺席，故必须 `?? 0`。
 */
interface SessionListSnapshotLike {
  byId: Record<string, { id: string; retainedBy?: Record<string, number | undefined> }>;
}

/** 当前（主视图）会话 id；没有会话打开时为 undefined。 */
const currentSessionIdOf = (snapshot: SessionListSnapshotLike): string | undefined =>
  Object.values(snapshot.byId).find((row) => (row.retainedBy?.mainView ?? 0) > 0)?.id;

/**
 * 宿主 `ctx.remote` 的最小结构视图（只用到 `settings.describe` / `settings.mutate`）。
 *
 * 不从 `@deepseek-ai/dsh-client-runtime` 导入：0.1.1 内核特有、0.1.2 已拆走，
 * 0.1.7 换成了 `dsh-api-remotes`。声明本地最小面，让 client 端保持零内核导入
 * （lib/client.js 实测不 import 任何内核包），跨代无关。
 */
interface RemoteLike {
  /**
   * 订阅内核转发到 client 的宿主事件（返回 disposer）。
   * `settings/document-updated` 在 dsh-api-remotes 的转发白名单内（mode: 'emit'），
   * 内核设置页即用它驱动 `SettingsDescribeMirror` 重载。0.1.7+ 可用；更早的代次
   * 没有该服务，故按可选读取（旧宿主退化为首读一次 + 渲染兜底）。
   */
  $on?(event: string, listener: (...args: unknown[]) => void): () => void;
  settings?: {
    /**
     * 读设置文档。返回的是 **RPC 信封** `{ ok, value }`，真正的
     * `{ writable, hasDocument, namespaces }` 在 `value` 里——不是顶层。
     */
    describe(options?: { redactSecrets?: boolean }): Promise<unknown>;
    /**
     * 写设置。**三个参数都必填**——少传 `expectedRevision` 会被 client api 拒绝：
     * `settings/mutate expected 3 argument(s), got 2`（该参数是乐观并发控制，
     * 传当前 revision；不匹配则整批失败，避免覆盖他人改动）。
     */
    mutate(ns: string, ops: readonly SettingsPathOpLike[], expectedRevision: number): Promise<unknown>;
  };
}

/** `remote.settings.mutate` 的路径操作（与内核 `SettingsPathOp` 同构）。 */
type SettingsPathOpLike =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] };

/** 设置文档：一个命名空间条目（`writable` 是文档级字段，不在条目上）。 */
interface SettingsDoc {
  writable?: boolean;
  hasDocument?: boolean;
  namespaces?: Array<{ ns: string; value?: unknown; revision?: number }>;
}

/**
 * 解包 `describe()` 的返回值，**不假设层数**。
 *
 * 实测踩过的坑：typert 的 RPC 响应形如
 * `{ type:'server-response', result:{ ok:true, value:{ writable, namespaces } } }`，
 * 而 client 侧的 `remote.settings.describe()` 到底返回「已解一层的文档」还是
 * 「完整 RPC 信封」取决于调用侧是否已被 transport 解包——两种都见过。按固定
 * 层数写（`described.value.namespaces` 或 `described.result.value.namespaces`）
 * 都会在另一种形状下恒为 undefined，且**静默失败**：入口直接 return，`settings`
 * 永远停在初值，表现为「插件加载了但幽灵文本从不出���」。
 *
 * 故这里逐层下探到真正带 `namespaces` 的那一层为止，两种形状都能用。
 */
function unwrapSettingsDoc(response: unknown): SettingsDoc | undefined {
  let node: unknown = response;
  // 上限 4 层：足以覆盖 {doc} / {value:doc} / {result:{value:doc}} 三种形态，
  // 又不至于在异常结构里自旋。
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof node !== 'object' || node === null) return undefined;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.namespaces)) return record as SettingsDoc;
    if (record.ok === true) { node = record.value; continue; } // RPC 信封（成功）
    if ('result' in record) { node = record.result; continue; } // server-response
    if ('value' in record) { node = record.value; continue; }
    return undefined;
  }
  return undefined;
}

/** 投影键（与 host 端 PROJECTION_KEY 一致）。 */
const PROJECTION_KEY = 'suggestGhost';
/** 幽灵文本的 DOM 标记，用于定位/清理。 */
const OVERLAY_ID = 'dsh-foresight-overlay';
/** 默认采纳快捷键（与 host 默认一致）。 */
const DEFAULT_ACCEPT_KEY = 'Tab';
/** settings 命名空间（与 host 端一致）。 */
const SETTINGS_NAMESPACE = 'dsh-foresight';
/**
 * `settings.section` 的 section id（导航标识）。
 *
 * 必须用**宿主没有的 id**：新 id 会在设置导航里并排新增一页；复用宿主已用的
 * id（如 `general` / `models` / `plugins`）会顶掉那一页。取 `dsh-foresight`
 * 与本插件命名空间一致，便于排查。
 */
const SETTINGS_SECTION_ID = 'dsh-foresight';
/** 设置页导航文案（跟随宿主界面语言；无 locale 服务时回退中文）。 */
const SECTION_LABELS = { zh: '输入预测', en: 'Input prediction' } as const;
/** 未获应答的 pull 最多重试次数（host 可能回一份不含历史的载荷；上限防自旋）。 */
const PULL_MAX_ATTEMPTS = 5;
/** pull 重试的基础退避（毫秒），第 n 次退避 = 基础值 × 2^n。 */
const PULL_RETRY_BASE_MS = 200;
/**
 * 未被 host 确认的 `_ops` 操作最多连续补投几次（见 `scheduleOpsRetry`）。
 *
 * 采纳后用户不会再操作，`consume` 只落本地就等于「host 永远不知道这条被用过了」：
 * 刷新或另一个页面会重新显示同一条建议。故失败/未确认都要自动补投；上限防自旋，
 * revision 变化（CAS 冲突的原因消失）会重置计数。
 */
const OPS_MAX_ATTEMPTS = 3;
/** `_ops` 补投的基础退避（毫秒）：比 host 的 700ms 轮询略长，避免无谓重复写。 */
const OPS_RETRY_BASE_MS = 900;
/** `_ops` 补投退避的上限（毫秒）。 */
const OPS_RETRY_MAX_MS = 5000;
/**
 * 快速补投预算用尽后的**低频**补投间隔（毫秒）。
 *
 * 早先的实现到达 `OPS_MAX_ATTEMPTS` 就彻底放弃：若 CAS 冲突恰好持续到预算用完，
 * 那条 `consume` 会永远留在 `pendingOps` 里——共享 settings 文档的另一个页面/会话
 * 一直有写入时，revision 会持续前进，本页面的待确认集合再也送不出去（真机实测：
 * 采纳后 `_ops` 一直不被清）。低频重试让「迟早会成功」不依赖运气，代价是每 30s
 * 一次写入尝试（成功即停）。
 */
const OPS_RETRY_IDLE_MS = 30_000;
/** 按会话缓存的会话数上限（`_push` 是全局槽，见 perSession 注释）。 */
const PER_SESSION_CACHE_CAP = 32;


/** 插件名（与 manifest 的包名一致）。 */
const name = 'dsh-foresight';
/** 所需服务：会话 face + 输入机 face（幽灵必需，rc.7 fiber 激活门控）。
 *
 * `remote` 与 `remote.settings` **都必须声明**，且 `remote.settings` 才是关键：
 * 0.1.7 的 cordis reflect 在读嵌套属性时把键拼成 `` `${associate}.${prop}` ``（见
 * cordis `lib/index.js` 的 `internal/get` 路径），也就是 `ctx.get('remote').settings`
 * 实际查询的是名为 `remote.settings` 的子服务。未声明就读会抛
 * `cannot get property "remote.settings" without inject`，整个 client fiber 失败，
 * Web 启动报 `dsh-foresight: failed` 并挡住界面。内核
 * `@deepseek-ai/dsh-client-ui-settings` 的 provider 用的正是
 * `inject = ["remote", "remote.settings"]`，本插件照同一写法。
 *
 * `slots` 现在**必须**声明：设置页以 `settings.section` 槽位注册，而 section 的
 * 宿主（`@deepseek-ai/dsh-client-ui-settings-plugins` 等）自己就是
 * `inject = ["slots", "locale"]` —— `slots` 是它们提供的服务，不声明就读不到。
 * `locale` 同样需要（注册本插件的字典 + 解析 nav 文案）。二者都由
 * `package.json` 的 `dsh.client.inject` 声明了对应宿主模块，故实际可达。
 * 缺失时的后果已由「不声明 → `ctx.get('slots')` 为 undefined → 跳过设置页」
 * 退化为「声明 → 宿主若不提供则 park 整个插件」，二者不可兼得；因为
 * `dsh-client-ui-settings` 已是 manifest 依赖，park 风险为零，故选择声明。 */
const inject = ['conversation', 'sessions', 'remote', 'remote.settings', 'slots', 'locale'];

/** composer 的双代选择器：≤0.1.1 是 textarea，0.1.2 起是 Lexical contenteditable
 * （`data-composer-input` 标记，属 data-input-scroll 容器）。 */
const COMPOSER_SELECTOR = '[data-input-scroll] textarea, [data-input-scroll] [data-composer-input]';

/** 元素是否为会话输入框（textarea 或 composer contenteditable，均须位于 data-input-scroll 内）。 */
function isComposerElement(el: Element | null): boolean {
  if (el === null) return false;
  const composer = el.closest('[data-input-scroll]') !== null
    && (el.matches('textarea') || (el instanceof HTMLElement && el.isContentEditable));
  return composer;
}

/** 事件目标是否为会话输入框。 */
function isComposerTarget(target: EventTarget | null): boolean {
  return target instanceof Element && isComposerElement(target);
}

/** 光标是否位于输入框文本末尾：textarea 用 selectionStart/End，contenteditable 用 Selection API。 */
function caretAtComposerEnd(el: HTMLElement): boolean {
  if (el instanceof HTMLTextAreaElement) {
    return el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
  }
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0 || !selection.isCollapsed) return false;
  if (el.textContent === '') return true; // 空编辑器：光标必然在末尾（LLM 模式场景）
  const range = selection.getRangeAt(0);
  // 编辑器最后一个文本节点末尾
  let last: Node | null = el.lastChild;
  while (last !== null && last.lastChild !== null) last = last.lastChild;
  if (range.endContainer === last) {
    return range.endOffset === (last.textContent?.length ?? 0);
  }
  // 或光标落在编辑器最后一个子节点之后（Lexical 常见形态）
  return range.endContainer === el && range.endOffset === el.childNodes.length;
}

/** 快捷键匹配：修饰键 + 主键（主键表见 keyspec.ts），如 Tab、Alt+S、Ctrl+Enter。
 * 修复：字母/数字主键此前按 event.code === 'S' 匹配，实际 code 是 'KeyS'，
 * 导致单字符 spec 永远无法命中；现统一经 keyCodeOf 映射。 */
function parseAcceptKey(spec: string): ((event: KeyboardEvent) => boolean) | undefined {
  const parts = spec.split('+').map(p => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const mods = new Set(parts.slice(0, -1));
  const keyCode = keyCodeOf(spec);
  if (keyCode === undefined) return undefined;
  return (event) => event.code === keyCode
    && event.altKey === mods.has('alt')
    && event.ctrlKey === mods.has('ctrl')
    && event.metaKey === mods.has('meta')
    && event.shiftKey === mods.has('shift');
}

/** 按键规格里不适合直接展示的部分 → 键帽上的短写。 */
const KEY_LABELS: Readonly<Record<string, string>> = {
  Slash: '/', Backslash: '\\', Enter: '↵', Space: 'Space', Backquote: '`', Right: '→', Left: '←', Up: '↑', Down: '↓',
};
/** 把按键规格（如 `Tab`、`Alt+Slash`）转成键帽上显示的文字。 */
function acceptKeyLabel(spec: string): string {
  return spec.split('+').map((part) => KEY_LABELS[part] ?? part).join(' ');
}
/** 当前应显示的幽灵内容：LLM 建议（完整文本）或历史补全（已输入前缀 + 剩余后缀）。 */
type GhostContent =
  | { kind: 'llm'; text: string; acceptKey: string }
  | { kind: 'history'; prefix: string; suffix: string; full: string };

/**
 * `_push.prediction`（协议 v2）：宿主对该会话预测状态的权威记录。
 *
 * 字段按 host schema（`src/settings.ts` 的 `GhostPushPayload.prediction`）宽容解析：
 * `outcome` 保持 string，只有 `'suggested'` 允许出幽灵；可空字段缺失一律收敛为
 * null。client 只消费四处——`sessionId`（归属守卫）、`outcome`（显示门槛）、
 * `requestKey`（采纳后 consume）、`nonce`（catch_up 确认回执）。
 */
interface PredictionPush {
  /** 稳定请求键（sessionId + 源身份 + 生成配置身份）：采纳消费按它定位记录。 */
  readonly requestKey: string;
  /** 记录所属父会话（归属守卫）。 */
  readonly sessionId: string;
  readonly sourceTurn: number | null;
  readonly sourceEndSeq: number | null;
  /** 终态 suggested/abstained/failed/cancelled/consumed；过程态 started/in_flight/… */
  readonly outcome: string;
  readonly reason: string | null;
  /** host 侧本次请求的可见标识（随记录回带）。 */
  readonly requestId: string | null;
  /** catch_up 的确认回执：与本代次待确认 nonce 同值即清 pending。 */
  readonly nonce: string | null;
  readonly generatedAt: number | null;
}

/** `_push.route`（协议 v2）：预测实际使用的路由与推理档；仅诊断/卡片展示用。 */
interface RoutePush {
  readonly provider: string | null;
  readonly model: string | null;
  readonly parentEffort: string | null;
  readonly configuredEffort: string | null;
  readonly effectiveEffort: string | null;
  readonly source: 'inherited' | 'configured' | 'unavailable';
}

/**
 * `_push` 载荷（v1 字段 + v2 可选字段 `protocol` / `prediction` / `route`）。
 *
 * 全部按 unknown 收：本层只负责「拿得到就拿」，字段级类型收敛交给
 * {@link parsePrediction} / {@link parseRoute}。缺字段 = v1 语义降级（旧宿主照样
 * 可用），任何一个畸形字段都不得让整份载荷解析抛错。
 */
interface GhostPushPayload {
  protocol?: unknown;
  epoch?: unknown;
  suggestion?: unknown;
  suggestionSessionId?: unknown;
  hot?: unknown;
  total?: unknown;
  history?: unknown;
  historySessionId?: unknown;
  error?: unknown;
  prediction?: unknown;
  route?: unknown;
  /** 顶层确认凭证（host 原样回带；`prediction` 为 null 时也有）。 */
  nonce?: unknown;
  /** `_ops` 回执：host 本轮消费掉的 pull/consume 操作 id（可能缺失或空数组）。 */
  opsAck?: unknown;
  /** 本会话的回合回顾集合（`[{turn, text}]`，按回合升序）；缺席 = 不携带。 */
  recaps?: unknown;
  /** `recaps` 的归属会话；缺席 = 本次推送不携带回顾。 */
  recapsSessionId?: unknown;
}

/** 解析 `_push.prediction`：非对象 / 缺 `requestKey`|`sessionId` 视为「无记录」（null）。 */
function parsePrediction(raw: unknown): PredictionPush | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.requestKey !== 'string' || typeof r.sessionId !== 'string') return null;
  return {
    requestKey: r.requestKey,
    sessionId: r.sessionId,
    sourceTurn: typeof r.sourceTurn === 'number' ? r.sourceTurn : null,
    sourceEndSeq: typeof r.sourceEndSeq === 'number' ? r.sourceEndSeq : null,
    outcome: typeof r.outcome === 'string' ? r.outcome : '',
    reason: typeof r.reason === 'string' ? r.reason : null,
    requestId: typeof r.requestId === 'string' ? r.requestId : null,
    nonce: typeof r.nonce === 'string' ? r.nonce : null,
    generatedAt: typeof r.generatedAt === 'number' ? r.generatedAt : null,
  };
}

/** 解析 `_push.route`：非对象视为缺失（null）；字符串字段缺失收敛为 null。 */
function parseRoute(raw: unknown): RoutePush | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const source = r.source;
  return {
    provider: str(r.provider),
    model: str(r.model),
    parentEffort: str(r.parentEffort),
    configuredEffort: str(r.configuredEffort),
    effectiveEffort: str(r.effectiveEffort),
    // 0.2.x 的 host 多一个 'unavailable'（父路由不可调用）；未知取值按不可用处理。
    source: source === 'inherited' || source === 'configured' ? source : 'unavailable',
  };
}

/**
 * 模型建议的官方采纳键：**无修饰键**的 Tab / ArrowRight / Enter 三键等价，一律整条
 * 采纳。历史补全不走这里（只认配置键/默认 Tab，见 onKeyDown）。
 */
function isPlainLlmAcceptKey(event: KeyboardEvent): boolean {
  return !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    && (event.code === 'Tab' || event.code === 'ArrowRight' || event.code === 'Enter');
}

/** 生成 pull / consume 的操作标识（nonce 与操作 id 同源：时间戳 + 随机串）。 */
function newOpToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 幽灵文本 overlay 管理器：在输入框（textarea / Lexical contenteditable）上
 * 创建/更新/移除灰色覆盖层。
 *
 * ## 定位契约（实测结论，勿凭直觉改符号）
 *
 * 宿主 composer 的 DOM 是**两层**，滚动发生在编辑器**外面**：
 *
 * ```
 * div[data-input-scroll]   .scroll  overflow-y:auto; max-height:336px  ← 滚动容器
 * └─ div .grow             position:relative                            ← offsetParent
 *    ├─ div[data-composer-input]                                        ← 编辑器，overflow:visible，scrollTop 恒 0
 *    └─ div[data-composer-placeholder]
 * ```
 *
 * overlay 被追加到 `.grow` 内，而 `.grow` 是滚动容器的**子节点**——也就是说
 * overlay 处在「被滚动的内容」坐标系中，滚动时与正文**一起**位移。因此
 * **不需要、也不能做滚动补偿**（这是最容易写错的一处）：
 *
 * 实测（`.grow` 上放探针，`max-height:336px`，草稿 30 行）：
 * | scrollTop | 正文 top | `offsetTop+pad` 公式 | 再减 scrollTop |
 * |---|---|---|---|
 * | 0   | 304 | 304 ✅ | 304 ✅ |
 * | 120 | 184 | 184 ✅ | 64 ❌  |
 * | 384 | -80 | -80 ✅ | -464 ❌ |
 *
 * 结论：**只用 `offsetTop + padding`**（`offsetTop` 相对 offsetParent，与滚动
 * 无关）。幽灵已随内容滚动，再减一次是**双重补偿**，会产生 `-scrollTop` 的漂移
 * ——草稿越长越明显，正是「滚动后幽灵压在别的文字上」的成因。
 * 回归测试见 `scripts/ghost-geom-smoke.mjs`。
 *
 * ## 重叠防护
 *
 * 显示前做一次几何自检（见 {@link verify}）：幽灵若未落在编辑器内容原点上
 * （宿主 DOM 结构变化导致坐标系假设失效），宁可不显示，也不糊在正文上。
 */
class GhostOverlay {
  private readonly el: HTMLDivElement;
  private composer: HTMLElement | null = null;
  /**
   * 滚动容器（`[data-input-scroll]`）。
   *
   * 定位**不用**它（overlay 随内容自动滚动），保留它只为了挂 `scroll` 监听：
   * 滚动会使内容相对视口位移，需要触发一次重对齐与自检。
   */
  private scroller: HTMLElement | null = null;
  private readonly onScroll: () => void;
  private readonly onResize: () => void;
  private readonly styleTag: HTMLStyleElement;
  /** 尺寸变化观察者：composer 自动增高/附件行出现/字体回流都会改变内容起点。 */
  private resizeObserver: ResizeObserver | null = null;
  /** 正在显示的内容（供 ResizeObserver 回调重对齐后重新自检）。 */
  private current: GhostContent | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = OVERLAY_ID;
    // 纯装饰节点：对辅助技术整体隐藏。幽灵文本不是输入框里的真实内容，读屏不该
    // 把它当作用户已输入的文字（官方 placeholder 同理，不参与可访问性树）。
    this.el.setAttribute('aria-hidden', 'true');
    this.el.style.cssText = [
      'position:absolute',
      'pointer-events:none',
      'white-space:pre-wrap',
      'word-break:break-word',
      // 不设 overflow:hidden：它会贴着盒子边界裁掉 text-shadow 光晕（明显切割感）；
      // 换行安全已由 pre-wrap + break-word 保证，盒子高度自适应无需纵向裁剪。
      // 颜色与泛光由下方样式表按建议来源（data-kind）决定，不写在内联样式里。
      'z-index:1',
      // 初值：不绘制。用 display（而非旧版的 visibility）——见下方 show()/hide()
      // 与类注释，display 让节点彻底退出渲染，避免任何过渡期双绘。
      'display:none',
    ].join(';');
    this.onScroll = () => this.alignAndVerify();
    this.onResize = () => this.alignAndVerify();
    // 幽灵激活时隐藏原生 placeholder（二者同位置，避免重叠）。
    // 状态标记打在**我们自己的 overlay 节点**上（data-shown），经 body:has() 关联
    // 占位元素——React/Lexical 重渲染会剥掉编辑器上的外来类（实测发生过），而
    // overlay 是插件私有节点不受影响，且与 DOM 顺序、textarea/contenteditable
    // 形态无关。规则覆盖两代 composer：
    //  - textarea：原生 ::placeholder 伪元素；
    //  - contenteditable（0.1.2 Lexical）：placeholder 是 `.grow` 内的兄弟节点，
    //    带 `data-composer-placeholder` 稳定属性钩子。
    //
    // 实测要点：宿主的 placeholder 节点**仅在 `showPlaceholder` 为真时渲染**
    // （草稿非空时不渲染，实测 `querySelectorAll` 计数为 0），所以选择器在
    // 「草稿非空」这一历史补全场景下本就无处命中；真正需要它的是 LLM 建议场景
    // （草稿为空、占位文案在场）。因此三条规则都给上，任一条命中即可：
    //
    // **用 display:none / visibility:hidden，而不是旧版的 opacity:0**：opacity
    // 虽不脱离布局、但仍是绘制的一部分，且过渡期里占位与幽灵会同帧可见。旧实现
    // 只在 `[data-composer-placeholder]` 上写 opacity:0，一旦该节点尚未挂载或
    // 结构变化，规则就静默空转——这正是「幽灵叠在占位文案上」的第二个来源。
    // `[data-composer-input]` 的 `data-placeholder` 属性是宿主渲染即带的（与本
    // 插件无关），作为兜底钩子，不依赖节点的增删时机。
    this.styleTag = document.createElement('style');
    this.styleTag.dataset.pluginCss = 'dsh-foresight';
    this.styleTag.textContent = [
      // ── 幽灵文本的外观 ──
      //
      // 基色对齐官方 composer placeholder 的色阶（label-caption，全透明度），而非更重的
      // label-secondary：保证「幽灵」比正文明显更淡。贴身 1px + 8px 的同色泛光把它和原生
      // placeholder 区分开，提示这是「可采纳的建议」；同色晕不改变色相，暗/亮主题通用。
      '#dsh-foresight-overlay{color:var(--dsw-alias-label-caption,#9aa0a6);text-shadow:0 0 1px currentColor,0 0 8px currentColor}',
      // 模型预测的建议在基色上只带一点蓝灰（混入 22% 的主题品牌色），历史补全保持基色。
      // 只改颜色，泛光、字重、布局都沿用基础规则。不认 color-mix 的 WebView 会丢弃这条声明，
      // 自然退回基色，不需要另写兜底色（纯色兜底在浅/深主题下无法同时合适）。
      '#dsh-foresight-overlay[data-kind="llm"]{color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#6b8cff) 22%,var(--dsw-alias-label-caption,#9aa0a6))}',
      // 采纳键提示：跟随文字颜色的小键帽，只占文字行内的一小块，不参与对齐自检。
      '#dsh-foresight-overlay .fsr-ghost-key{display:inline-block;box-sizing:border-box;height:16px;margin-left:8px;padding:0 6px;border:1px solid currentColor;border-radius:5px;font-family:inherit;font-size:10px;font-weight:500;line-height:14px;vertical-align:1px;opacity:.85;text-shadow:none}',
      // ── 让位规则：幽灵**正在显示**时，placeholder 必须让位 ──
      //
      // 判据同时要求 `data-shown="1"` **且** overlay 未被 `display:none` 隐藏。
      // 只写 `data-shown` 不够：`hide()` / 自检失败路径会把 display 置回 none，
      // 若此时仍据 `data-shown` 或「节点存在」去隐藏 placeholder，就会出现
      // 「幽灵没显示、占位文案也没了」——草稿清空后输入框一片空白（实测过）。
      // 反过来只据「节点存在」同样错：节点在首次 show 后就常驻 DOM 不移除。
      //
      // `:not([style*="display: none"])` 读的是内联 style（本插件唯一写 display
      // 的地方），故与自身写入的状态严格同步，无属性时序竞态。
      'body:has(#dsh-foresight-overlay[data-shown="1"]:not([style*="display: none"])) [data-composer-placeholder]{display:none!important}',
      'body:has(#dsh-foresight-overlay[data-shown="1"]:not([style*="display: none"])) textarea::placeholder{visibility:hidden!important}',
      // 兜底：编辑器自带 data-placeholder 属性的伪元素（部分宿主形态）以及
      // 依赖 `[data-placeholder]` 出文案的 ::before/::after 实现。
      'body:has(#dsh-foresight-overlay[data-shown="1"]:not([style*="display: none"])) [data-composer-input][data-placeholder]::before{content:none!important}',
      'body:has(#dsh-foresight-overlay[data-shown="1"]:not([style*="display: none"])) [data-composer-input][data-placeholder]::after{content:none!important}',
    ].join('\n');
    if (typeof document !== 'undefined') document.head.appendChild(this.styleTag);
  }

  /** 当前绑定的输入框（未绑定时为 null）。 */
  get currentTextarea(): HTMLElement | null {
    return this.composer;
  }

  /** 绑定到当前输入框（若变化则重建对齐）。 */
  private attach(composer: HTMLElement): void {
    const parent = composer.parentElement;
    // 早退条件必须同时看「引用没变」**和**「我们的节点还挂在同一个父节点下」：
    // React 重建 composer 的父节点（`.grow`）时会连带丢掉这个外来子节点——
    // 它不认识我们的 overlay。旧实现只比 composer 引用，引用恰好没变时就早退，
    // 于是 overlay 永久留在文档之外：内容算得出来、DOM 里却查不到节点，页面刷新
    // 才恢复（真机实测：切换会话几轮后幽灵消失，`#dsh-foresight-overlay`
    // 查询为 null，而诊断标记仍写着 projection:llm）。
    if (this.composer === composer && this.el.isConnected && this.el.parentElement === parent) return;
    this.detach();
    this.composer = composer;
    // 滚动容器：只为挂 scroll 监听（定位不用它，见类注释的实测表格）。
    this.scroller = composer.closest<HTMLElement>('[data-input-scroll]');
    // 挂载点：`.grow` 是宿主显式 `position:relative` 的 offsetParent，且位于滚动
    // 容器内部——overlay 放这里才能随内容一起滚动。**不再改写宿主样式**（旧实现
    // 在 static 时强写 relative，会污染宿主布局，且对已经是 relative 的 .grow
    // 毫无作用）。
    if (parent !== null) parent.appendChild(this.el);
    composer.addEventListener('scroll', this.onScroll, { passive: true });
    this.scroller?.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('resize', this.onResize);
    // 尺寸变化（自动增高、附件行、字体回流）也会移动内容起点，必须重对齐。
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(composer);
      if (this.scroller !== null) this.resizeObserver.observe(this.scroller);
      if (parent !== null) this.resizeObserver.observe(parent);
    }
    this.alignAndVerify();
  }

  private detach(): void {
    if (this.composer !== null) {
      this.composer.removeEventListener('scroll', this.onScroll);
      this.composer = null;
    }
    if (this.scroller !== null) {
      this.scroller.removeEventListener('scroll', this.onScroll);
      this.scroller = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.current = null;
    this.el.dataset.shown = '0';
    this.el.style.display = 'none';
    window.removeEventListener('resize', this.onResize);
    this.el.remove();
  }

  /**
   * 对齐 overlay 到输入框内容区（含 padding 起点）。
   *
   * ## 为什么**不做**滚动补偿（实测结论，勿回退）
   *
   * overlay 挂在 `.grow` 上，而 `.grow` 是滚动容器 `[data-input-scroll]` 的**子
   * 节点**——即 overlay 位于「被滚动的内容」坐标系里。滚动容器滚动时 `.grow`
   * 整体一起位移（实测 `scrollTop=120` 时 `.grow` 的 rect.top 同步上移 120），
   * 因此 overlay **自动跟随内容滚动，无需任何 scrollTop 项**。
   *
   * 实测反证（`.grow` 上的探针元素，`scrollTop=120`）：
   *  - `rect 差 - scrollTop` → 幽灵落在 `64`，正文在 `184`：**漂移 `-scrollTop`**；
   *  - `rect 差 + scrollTop` → 幽灵恒定不动，漂移 `+scrollTop`；
   *  - `offsetTop + paddingTop`（**本实现**）→ 与正文逐像素重合（5 个滚动位置全对）。
   *
   * 另注：rect 差在这里恒为 0（`.grow` 与编辑器一起移动、同点），用它会把真实的
   * 内容偏移丢掉；`offsetTop/offsetLeft` 相对 `offsetParent`，与滚动无关，才是
   * 「内容坐标系」里的正确坐标。
   */
  private align(): void {
    const ta = this.composer;
    if (ta === null) return;
    const style = getComputedStyle(ta);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padTop = parseFloat(style.paddingTop) || 0;
    const padRight = parseFloat(style.paddingRight) || 0;
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    // 内容起点 = 编辑器在 offsetParent（.grow）内的偏移 + border + padding。
    // offsetTop/offsetLeft 与滚动无关，正是「内容坐标系」里的正确坐标。
    this.el.style.left = `${ta.offsetLeft + borderLeft + padLeft}px`;
    this.el.style.top = `${ta.offsetTop + borderTop + padTop}px`;
    // 宽度：编辑器内容宽 = clientWidth - 左右 padding（border-box 下 clientWidth
    // 已含 padding、不含 border）。
    const width = ta.clientWidth - padLeft - padRight;
    this.el.style.width = `${width > 0 ? width : ta.clientWidth}px`;
    // 继承输入区字体与行高，保证幽灵文本视觉一致。
    this.el.style.fontFamily = style.fontFamily;
    this.el.style.fontSize = style.fontSize;
    this.el.style.lineHeight = style.lineHeight;
    this.el.style.fontWeight = style.fontWeight;
    this.el.style.letterSpacing = style.letterSpacing;
    this.el.style.boxSizing = 'border-box';
  }

  /**
   * 对齐后做几何自检：定位明显失真时宁可不显示，也绝不糊在正文上。
   *
   * ## 判据（依据实测，不是推测）
   *
   * overlay 是 `.grow` 的子节点，随内容一起滚动——所以「幽灵跑到滚动视口外」是
   * **正常且正确**的（正文也一起滚出去了，被滚动容器裁掉）。因此**不能**用
   * 「必须落在滚动视口内」当判据：实测 `scrollTop=384` 时幽灵与正文同在
   * `top=-80`，两者都被裁掉，这是正确的。
   *
   * 真正要防的是**定位失真**：overlay 没有落在编辑器内容原点上（例如宿主要
   * 在 `.grow` 与编辑器之间插入带 padding/border 的新层，或 `.grow` 不再是
   * offsetParent）。此时幽灵会浮在别的内容上——就是用户报告的重叠。
   *
   * 判据：幽灵左上角与「编辑器在 offsetParent 内的内容原点」之差必须在一个
   * 行高量级内。偏差超过一行，说明坐标系假设已被宿主破坏，放弃显示。
   */
  private verify(): boolean {
    const ta = this.composer;
    if (ta === null) return false;
    const host = this.el.offsetParent;
    if (!(host instanceof HTMLElement)) return false;
    // 调用方已保证此刻元素是 `display:block`（见 alignAndVerify），此处 rect 可信。
    const ghostRect = this.el.getBoundingClientRect();
    // 期望位置：编辑器内容原点在视口中的坐标。
    const expectedTop = ta.getBoundingClientRect().top
      + (parseFloat(getComputedStyle(ta).paddingTop) || 0);
    // 实际位置与期望位置之差；一行高度（约 24px）以内的偏差无害，超过即失真。
    const drift = Math.abs(ghostRect.top - expectedTop);
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight);
    const tolerance = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 24;
    if (drift > tolerance) return false;
    // 水平方向同理：允许一个字宽量级的偏差。
    const expectedLeft = ta.getBoundingClientRect().left
      + (parseFloat(getComputedStyle(ta).paddingLeft) || 0);
    if (Math.abs(ghostRect.left - expectedLeft) > tolerance) return false;
    // host 必须仍包含编辑器（否则 overlay 挂在了不相干的层上）。
    return host.contains(ta) || host === ta.parentElement;
  }

  /**
   * 对齐 + 自检；自检失败则隐藏（保持 current 以便下次事件重试）。
   *
   * ## 两条顺序约束（都踩过坑，勿调换）
   *
   * 1. **必须先 `display:block` 再测量**：`getBoundingClientRect()` 对
   *    `display:none` 的元素恒返回全 0，先测量会把每次首帧都判为「空矩形 →
   *    不可显示」，`display` 永远停在 `none`——表现为幽灵彻底不出现。
   *
   * 2. **必须在显示之前就 `data-shown="1"`**：placeholder 的隐藏规则
   *    （`body:has(#…[data-shown="1"]) [data-composer-placeholder]{display:none}`）
   *    挂在 `data-shown` 上。若先 `display:block` 再标 `data-shown`，中间就存在
   *    一个「幽灵已可见、placeholder 还没隐藏」的窗口——两者同原点，直接重叠
   *    （实测：该窗口内 placeholder 的 computed display 仍是 block）。
   *
   * 注意两者是**不同元素上的两个开关**，互不冲突：
   *  - `data-shown` 打在 overlay 自身（控制 placeholder 是否让位）；
   *  - `display` 打在 overlay 自身（控制幽灵是否绘制）。
   * 因此正确顺序是：**先标 `data-shown` 让位 → 再 `display:block` → 测量自检
   * → 不合格则把两者一起回退**。
   */
  private alignAndVerify(): void {
    if (this.current === null) return;
    this.align();
    // ① 先让 placeholder 让位（此时幽灵尚未绘制，不会出现双绘窗口）。
    this.el.dataset.shown = '1';
    // ② 再让它参与布局，否则下一步的 rect 测量恒为 0。
    this.el.style.display = 'block';
    if (!this.verify()) {
      // ③ 自检不合格：两个开关一起回退，避免「幽灵不画但 placeholder 已让位」
      //    造成占位文案凭空消失。
      this.el.style.display = 'none';
      this.el.dataset.shown = '0';
      return;
    }
  }

  /** 显示幽灵内容（对齐由滚动/尺寸事件持续维护）；隐藏 placeholder 避免重叠。 */
  show(content: GhostContent): void {
    this.el.textContent = '';
    this.el.dataset.kind = content.kind;
    if (content.kind === 'llm') {
      this.el.textContent = content.text;
    } else {
      // 历史补全：已输入前缀用透明占位（宽度自然对齐），剩余部分灰色显示。
      const prefix = document.createElement('span');
      prefix.style.visibility = 'hidden';
      prefix.textContent = content.prefix;
      const suffix = document.createElement('span');
      suffix.textContent = content.suffix;
      this.el.append(prefix, suffix);
    }
    const key = document.createElement('span');
    key.className = 'fsr-ghost-key';
    key.textContent = acceptKeyLabel(content.kind === 'llm' ? content.acceptKey : DEFAULT_ACCEPT_KEY);
    this.el.append(key);
    this.current = content;
    // 先按当前几何定位，再由自检决定是否真的绘制（防止第一帧就糊在正文上）。
    this.alignAndVerify();
  }

  hide(): void {
    this.current = null;
    this.el.style.display = 'none';
    this.el.textContent = '';
    this.el.dataset.shown = '0';
  }

  /**
   * 幽灵当前是否**真的**挂在文档里并处于绘制态。
   *
   * 供 render 的「内容没变化就早退」判断使用：React 重建 composer 的父节点时会把
   * 我们的私有节点一并丢掉（见 attach() 注释），而 `shown` 指纹里还留着同一份
   * 内容——只看指纹就会早退，节点的补挂永远不会发生。真机表现：切走再切回同一条
   * 建议，幽灵再也不出现（诊断标记却仍是 `projection:llm`）。
   */
  isShowing(): boolean {
    return this.el.isConnected && this.el.dataset.shown === '1' && this.el.style.display !== 'none';
  }

  dispose(): void {
    this.detach();
    this.styleTag.remove();
  }
}

/** 浏览器插件主体。 */
/**
 * 取 `remote` 服务（读 `remote.settings` 用）。
 *
 * **必须走 `ctx.get('remote')`，不能读 `ctx.remote` 属性。** 0.1.7 的 client runner
 * 用 `dynamicCordisContext` 把插件 ctx 换成严格门控 Proxy：任何非动词属性读取都走
 * `readService(prop, true)`，未在插件 `inject` 里声明就抛
 * `cannot get property "remote" without inject`，整个 client fiber 失败。
 *
 * 且 `inject` 里**必须同时声明 `remote.settings`**：cordis reflect 读嵌套属性时把键
 * 拼成 `remote.settings` 这个独立子服务名，未声明即抛
 * `cannot get property "remote.settings" without inject`（这正是本插件此前
 * `dsh-foresight: failed` 的真实原因）。
 */
const remoteOf = (ctx: Context): RemoteLike | undefined => ctx.get('remote') as RemoteLike | undefined;

/**
 * 设置 scope 的快照**信封**（卡片按此形状读取：`snap.status` / `snap.value` /
 * `snap.writable`）。见 `remoteSettingsScope()` 的说明。
 */
export interface ScopeSnapshot {
  /** `loading` = 尚未从 host 取到；`ready` = 已取到；`unavailable` = 命名空间缺失。 */
  readonly status: 'loading' | 'ready' | 'unavailable';
  /** 命名空间当前解析值（含 `_push` / `_ops` 两个 JSON 字段）。 */
  readonly value: Record<string, unknown>;
  /** host 是否允许写入（旧宿主缺省视为可写）。 */
  readonly writable: boolean;
}

/**
 * 设置页的导航文案。
 *
 * 宿主每次投影 `settings.section` 的 `label` 时都会重读这个 thunk，所以语言
 * 切换后无需重新注册 section。locale 服务缺失（旧宿主组合）时回退中文，与
 * useGhostT 的降级行为一致。
 * @param locale - 宿主 locale 服务；可为 undefined。
 */
const sectionLabel = (locale: LocaleFaceLike | undefined): string => {
  const active = locale === undefined ? 'zh' : locale.getSnapshot().active;
  return active === 'en' ? SECTION_LABELS.en : SECTION_LABELS.zh;
};

function applyInner(ctx: Context): void {
  // rc.7：所需核心服务已由 `inject` 声明，fiber 激活门控保证可用；ctx.get 可选读取。
  applyBody(ctx);
}

/** applyInner 的主体（原函数体）。 */
function applyBody(ctx: Context): void {
  const sessions = ctx.get('sessions');
  if (sessions === undefined) return;
  const overlay = new GhostOverlay();
  let lastSessionId: string | undefined;
  let bound: {
    session: ObservableSnapshot<unknown>;
    input: { state: ObservableSnapshot<{ draft: string }>; setDraft: (text: string) => void };
    projectionFace: ObservableSnapshot<unknown>;
  } | null = null;
  let shown: { key: string; content: GhostContent } | null = null;
  /** IME 组词进行中（compositionstart~end 之间）：组合预览文本与幽灵后缀
   * 会叠在同一位置，必须抑制幽灵显示（Cursor/VSCode 同款处理）。 */
  let composing = false;
  /** 上一帧的数据源（'push' | 'cache'）：只读地写进 DOM data 属性，
   * `scripts/isolation-smoke.mjs` 把它当读数打印（排查「跨会话覆盖」用）。 */
  let lastSourceLabel = 'none';
  /**
   * 按会话缓存最近一次收到的建议/历史环。
   *
   * host 的 `_push` 是**单个全局字段**：两个会话都在用时，谁最后结束回合谁覆盖；
   * 切回旧会话时那个槽里装的已经是别人的载荷（或为空），本会话自己那条只能在
   * 下一次 pull 应答里回来。缓存让「切回来」这一拍就画出幽灵，权威值仍由 host
   * 的 pull 应答校正（带 history 的载荷视为对该会话的对账答复）。
   */
  /** 按会话缓存条目：建议 / 历史环 / 预测记录（协议 v2，见 perSession 注释）。 */
  interface PerSessionEntry {
    suggestion: {
      turn: number; baseSeq: number; text: string; truncated: boolean; acceptKey: string;
    } | null;
    history: readonly string[];
    /** 协议 v2：该会话最近一次预测记录（null = host 明确表示无记录）。 */
    prediction: PredictionPush | null;
    /** 协议 v2：该会话预测的路由信息（诊断/卡片展示用）。 */
    route: RoutePush | null;
  }
  const perSession = new Map<string, PerSessionEntry>();
  /**
   * 写入按会话缓存（含 LRU 上限：长时间开着页面不无限增长）。
   * @param sessionId - 该条目所属会话。
   * @param suggestion - 该会话的建议；null = host 明确表示它没有有效建议。
   * @param history - 该会话的历史环；省略 = 本次载荷不携带，保留旧值。
   * @param prediction - 该会话的预测记录（协议 v2）；省略 = 本次载荷不携带，保留旧值。
   * @param route - 该会话预测的路由信息；省略 = 本次载荷不携带，保留旧值。
   */
  const cachePut = (
    sessionId: string,
    suggestion: {
      turn: number; baseSeq: number; text: string; truncated: boolean; acceptKey: string;
    } | null | undefined,
    history?: readonly string[],
    prediction?: PredictionPush | null,
    route?: RoutePush | null,
  ): void => {
    const prev = perSession.get(sessionId);
    // 先删再写：`Map.set` 对已存在的键**不移动顺序**，不删的话被反复更新的
    // 热会话会一直排在最前，淘汰时先扔掉最近用过的那个（FIFO 而非 LRU）。
    perSession.delete(sessionId);
    perSession.set(sessionId, {
      // 省略（undefined）= 本次载荷不携带该字段，保留旧值；`null` 是**权威的**
      // 「该会话没有」，必须覆盖（与 history 的省略语义一致）。
      suggestion: suggestion === undefined ? (prev?.suggestion ?? null) : suggestion,
      history: history ?? prev?.history ?? [],
      prediction: prediction === undefined ? (prev?.prediction ?? null) : prediction,
      route: route === undefined ? (prev?.route ?? null) : route,
    });
    while (perSession.size > PER_SESSION_CACHE_CAP) {
      const oldest = perSession.keys().next().value;
      if (oldest === undefined) break;
      perSession.delete(oldest);
    }
  };
  /** 读缓存并刷新其 LRU 位置（读不到的会话保持不插入）。 */
  const cacheGet = (sessionId: string): PerSessionEntry | undefined => {
    const cached = perSession.get(sessionId);
    if (cached === undefined) return undefined;
    perSession.delete(sessionId);
    perSession.set(sessionId, cached);
    return cached;
  };

  /** live 设置值（来自 dsh-foresight 命名空间；缺失时用默认）。 */
  let settings: {
    historyEnabled: boolean;
    historyCrossSession: boolean;
    historyMaxEntries: number;
    historyMinChars: number;
    /** 幽灵显示时允许 → 逐词采纳（Tab 始终整条采纳；**逐词只服务历史补全**，
     * 模型建议一律整条采纳，见 onKeyDown）。 */
    wordAccept: boolean;
    /** 预测开关（命名空间 live 值 `llmEnabled`）：关闭时不出模型建议、不发 catch_up。 */
    llmEnabled: boolean;
    /** `_push` 协议版本；缺失 = 旧宿主，按 v1 处理（v2 起启用预测显示门槛）。 */
    protocol: number;
    /** host 实时推送：最近一条预测记录（协议 v2；归属守卫看它自带的 `sessionId`）。 */
    prediction: PredictionPush | null;
    /** host 实时推送：预测路由信息（协议 v2；诊断/卡片展示用）。 */
    route: RoutePush | null;
    /** host 实时推送：本会话待确认的 catch_up 凭证（协议 v2 顶层字段）。只按
     * `prediction.nonce` 判回执会让「无记录」的 pull 应答永远挂起。 */
    nonce: string | null;
    /** host 实时推送：最新 LLM 建议（rev 递增识别新值）。 */
    suggestion: {
      turn: number;
      baseSeq: number;
      text: string;
      truncated: boolean;
      acceptKey: string;
    } | null;
    /** host 实时推送：跨会话热度快照。 */
    hot: readonly { text: string; count: number }[] | null;
    /** host 实时推送：当前会话的最近用户输入文本（时间序，历史补全文本源）。 */
    history: readonly string[];
    /** history 所属会话；与当前会话不符时不做会话内补全（退化为纯热度候选）。 */
    historySessionId: string | null;
    /** 建议所属会话；与当前会话不符时隐藏 LLM 建议。 */
    suggestionSessionId: string | null;
  } = {
    historyEnabled: true,
    historyCrossSession: false,
    historyMaxEntries: 50,
    historyMinChars: 1,
    wordAccept: true,
    llmEnabled: true,
    protocol: 1,
    prediction: null,
    route: null,
    nonce: null,
    suggestion: null,
    hot: null,
    history: [],
    historySessionId: null,
    suggestionSessionId: null,
  };

  /** 解析当前会话绑定（会话切换时重建）。 */
  const resolve = (): void => {
    const id = currentSessionIdOf(sessions.list.getSnapshot());
    if (id === undefined) {
      bound = null;
      lastSessionId = undefined;
      return;
    }
    if (id === lastSessionId && bound !== null) return;
    const actx = sessions.scope(id);
    if (actx === undefined) return; // 会话未就绪：不推进 lastSessionId，下次列表事件重试
    const session = sessions.sessionOf(actx);
    if (session === undefined) return;
    const conversation = actx.get('conversation');
    if (conversation === undefined) return;
    const input = conversation.input.for(actx);
    if (input === undefined) return;
    lastSessionId = id;
    bound = {
      session: session as unknown as ObservableSnapshot<unknown>,
      input: input as unknown as { state: ObservableSnapshot<{ draft: string }>; setDraft: (text: string) => void },
      projectionFace: session.projections.faceOf(PROJECTION_KEY),
    };
    // 绑定成功即拉取该会话的权威状态（历史环 + 建议）：这是「会话就绪」的
    // 唯一出口，冷启动、切会话、会话晚就绪三条路径在这里汇合成一次请求，
    // 不再依赖 effect 初始化的那一拍（那时会话常常尚未就绪，请求会落空）。
    // **每次会话变化都要拉**：`_push` 只有一格，切回来时它装的是别的会话的
    // 载荷，不重拉就只能靠按会话缓存显示旧值（缓存不保证见过该会话的最新值）。
    if (id !== lastPulledSessionId) {
      lastPulledSessionId = id;
      pullHistory(id);
    }
  };

  /**
   * 当前会话在协议 v2 下的预测记录（`_push` 实时值优先，退回按会话缓存）。
   *
   * 归属判据是记录自带的 `sessionId`，不看 `suggestionSessionId`——`_push` 只有
   * 一格，两个会话同时在用时里面装的可能是别人的记录。
   * @param sessionId - 目标会话。
   */
  const predictionFor = (sessionId: string): PredictionPush | null =>
    settings.prediction !== null && settings.prediction.sessionId === sessionId
      ? settings.prediction
      : (cacheGet(sessionId)?.prediction ?? null);

  /** 计算当前应显示的幽灵内容（null = 不显示）。 */
  const ghostContent = (): GhostContent | null => {
    if (bound === null) return null;
    if (composing) return null; // IME 组词中：组合预览与幽灵后缀重叠，抑制显示
    // 0.1.2 会话快照只余 lifecycle 字段；本插件用到的仅剩 `running`。
    const snapshot = bound.session.getSnapshot() as { running: boolean };
    const draft = bound.input.state.getSnapshot().draft;
    const currentId = currentSessionIdOf(sessions.list.getSnapshot()) ?? '';

    // 数据源：host 的 `_push`（全局槽）+ **按会话缓存**。`_push` 按
    // `suggestionSessionId` / `historySessionId` 做归属守卫：槽里装的不是本会话
    // 的载荷时，本会话自己那条从缓存取（切会话时 host 会按会话补推，见 resolve）。
    const cached = cacheGet(currentId);
    const suggestion = settings.suggestionSessionId === currentId
      ? settings.suggestion
      : (cached?.suggestion ?? null);
    const history = settings.historySessionId === currentId
      ? settings.history
      : (cached?.history ?? []);
    lastSourceLabel = (settings.suggestionSessionId === currentId || settings.historySessionId === currentId)
      ? 'push'
      : 'cache';

    // 模式 1：草稿非空 → 历史前缀补全（打分制：新近度为主、频次/热度为辅）。
    if (settings.historyEnabled && draft.trim() !== '') {
      // 草稿是斜杠命令整行时（如 `/later +3m 我重新部署了…`），用命令名之后
      // 的「内容」部分去匹配历史。`/later` `recordInput:false`，历史里只有
      // 到点注入的内容部分；保留时间参数只会让所有候选 startsWith 失败。
      // 非命令整行（普通用户消息）时 stripCommandPrefix 原样返回 draft。
      const contentDraft = stripCommandPrefix(draft);
      if (contentDraft.trim() === '') return null;
      // 数据源：本会话历史环（`_push` 的 history，归属守卫 + 按会话缓存）。
      // C：全局热度频次始终参与打分（host 无条件推送）；「跨会话搜索」开关
      // 只决定是否把其他会话的高频文本并入候选列表。
      const hot = settings.hot;
      const hotCounts = hot !== null && hot.length > 0
        ? new Map(hot.map(h => [normalizeForMatch(h.text), h.count] as const))
        : undefined;
      const full = historySuggestion(history, contentDraft, {
        minChars: settings.historyMinChars,
        maxEntries: settings.historyMaxEntries,
        hotCounts,
        extraCandidates: settings.historyCrossSession ? hot ?? undefined : undefined,
      });
      if (full === undefined) return null; // 无候选（前缀超限/低于阈值等），本帧不显示
      // 渲染按「原始草稿 + 候选」公共前缀对齐（宽度/空白差异时仍正确）；
      // 对斜杠命令场景，prefix=draft 让幽灵对齐到已输入字符（含命令前缀），
      // suffix 从 contentDraft 与 full 的归一化匹配段截尾——见 historySuggestion。
      const common = commonPrefixLength(contentDraft, full);
      return { kind: 'history', prefix: draft, suffix: full.slice(common), full };
    }

    // 模式 2：草稿为空 → LLM 建议（`_push` 的实时值 / 按会话缓存）。
    // 过期判据：agent 运行中隐藏（回合未结束，建议必然属于上一回合）。
    // 真实草稿非空时**一概**不出模型幽灵（与采纳路径同一判据）：历史开关关闭时
    // 上面的历史分支不接管，草稿非空就会直接掉进这里，模型文本会盖在用户已输入的
    // 内容上（模型建议只面向空草稿）。
    if (draft !== '') return null;
    if (!settings.llmEnabled) return null; // 预测开关（协议 v2 的 live 值）
    if (suggestion === null) return null;
    if (snapshot.running) return null;
    // 协议 v2 显示门槛：只有 host **明确**说 `outcome:'suggested'`、且记录归属本
    // 会话，才出幽灵。abstained（明确无建议）/ consumed / failed / cancelled /
    // stale_source / ineligible 一律不显示；in_flight / started /
    // in_flight_reused / cache_hit 是过程态或复用态，文本由随后的终态承载，本帧
    // 不出幽灵文本。
    // 协议 v1（旧宿主，载荷无 `protocol`）不设门槛：沿用「归属 + 未运行 + 草稿
    // 为空」三个既有守卫，旧宿主行为逐字不变。
    if (settings.protocol >= 2) {
      // 连接对账门槛：首次连接 / `connection/reset` / epoch 换代之后，`_push` 里
      // 可能还是上一个进程写下的残留记录，只有当前连接已被 host 确认
      // （`modelConfirmed`）才允许显示；见该变量注释。
      if (!modelConfirmed) return null;
      const prediction = predictionFor(currentId);
      if (prediction === null || prediction.sessionId !== currentId
        || prediction.outcome !== 'suggested') return null;
      // 本代次已采纳过：清空草稿也不复活（见 consumedKeys 注释）。
      if (isConsumed(currentId, prediction.requestKey)) return null;
    }
    return { kind: 'llm', text: suggestion.text, acceptKey: suggestion.acceptKey };
  };

  /** 缓存的上一次输入框查询结果（React 可能重建节点；isConnected 校验兜底）。 */
  let cachedComposer: HTMLElement | null = null;

  /** 渲染幽灵 overlay。 */
  // 「内容已算出、但输入框还没挂上」时的补偿渲染。
  //
  // 会话切换由 React 异步提交：投影值通知 / 设置推送可能**先于** composer 挂载到达，
  // 而这两条通道此后不再响（投影只在值变化时通知一次）。早先在这两条路径上直接
  // return，幽灵就一直不出现——真机实测：切回一条已有建议的会话后，必须敲一下键盘
  // （触发草稿变化）才会画出来。这里只做**有上限**的补渲染（8 × 150ms ≈ 1.2s），
  // 不是轮询；真正画出来即清零。
  let composerRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let composerRetries = 0;
  const retryRenderSoon = (): void => {
    if (composerRetryTimer !== null || composerRetries >= 8) return;
    composerRetries += 1;
    composerRetryTimer = setTimeout(() => {
      composerRetryTimer = null;
      render();
    }, 150);
  };

  const render = (): void => {
    resolve();
    retryPendingPull();
    maybeRequestCatchUp(); // 资格恢复后补问一次 catch_up（协议 v2，见其注释）
    const content = ghostContent();
    document.body.dataset.sgSource = `${lastSourceLabel}:${content === null ? 'none' : content.kind}`;
    if (content === null) {
      if (shown !== null) {
        overlay.hide();
        shown = null;
      }
      return;
    }
    // 内容指纹：LLM 用文本，历史用 prefix+suffix。
    const key = content.kind === 'llm'
      ? `llm:${content.text}`
      : `hist:${content.prefix}|${content.suffix}`;
    // 早退必须同时满足「内容没变」**和**「节点确实还在画」：宿主重渲染会把我们的
    // 节点丢掉，只比指纹会让幽灵永久消失（详见 GhostOverlay.isShowing 注释）。
    if (shown !== null && shown.key === key && overlay.isShowing()) return; // 无变化
    // 复用已绑定的输入框；仅当缓存失效（React 重建/首次）时才查询 DOM。
    // 双代选择器：textarea（≤0.1.1）或 contenteditable（0.1.2 Lexical）。
    const attached = overlay.currentTextarea;
    let composer = attached !== null && attached.isConnected
      ? attached
      : cachedComposer !== null && cachedComposer.isConnected
        ? cachedComposer
        : document.querySelector<HTMLElement>(COMPOSER_SELECTOR);
    if (composer === null) {
      retryRenderSoon(); // 输入框尚未挂载，等待下次通知或补偿渲染
      return;
    }
    // ── 非编辑器形态一律不出幽灵 ────────────────────────────────────────────
    // 宿主在无工作区/会话不可写时会把 composer 换成「选择一个工作区开始」这类
    // **触发器按钮**：源码里 `editor: workspaceTrigger ? null : editor`，编辑器
    // 根本不挂载，而 placeholder 文案（"选择一个工作区开始"）是该控件**唯一的
    // 可见文字**。COMPOSER_SELECTOR 只看 `[data-composer-input]` 属性、不看可编辑
    // 性，所以裸查询会在这种形态上照样命中；若此时出幽灵，我的让位规则就会把那句
    // 提示藏掉 → 输入框变成一块没有文字的空框，表现为「输入框消失了」。
    // 复用事件路径已有的 `isComposerElement` 判据（textarea 或 isContentEditable），
    // 两条路径对「什么算输入框」的定义必须一致，否则又会出现「事件侧不认、渲染侧
    // 却挂」的错配。
    if (!isComposerElement(composer)) {
      // 已经显示中的要收掉，并把指纹清空，否则回到可编辑形态时会被
      // 「key 未变化」早退挡住，幽灵再也不出现。
      if (shown !== null) {
        overlay.hide();
        shown = null;
      }
      retryRenderSoon(); // 也许只是过渡态（触发器按钮 → 编辑器），补偿渲染再试
      return;
    }
    cachedComposer = composer;
    overlay.attach(composer);
    overlay.show(content);
    shown = { key, content };
    composerRetries = 0; // 画出来了，补偿计数清零
  };

  // 读取/订阅设置命名空间（可选服务；缺失时保持默认并继续幽灵逻辑）。
  // 注意：必须放在 render 等函数定义之后，否则同步调用 applySettings 会触发
  // const 函数声明前的 TDZ（原 rc.6 版靠 ctx.inject 的异步延迟规避，rc.7 下
  // 需要显式保证顺序）。
  /**
   * `_ops` 反向通道的写面（经 `remote.settings.mutate` 请求 host 推送历史环 /
   * 消费预测记录）。
   *
   * 0.1.7 里 `settingsScope.set` 已随 settings.yaml 体系退役；改写 volatile
   * 配置字段走 `remote.settings.mutate(ns, [{op:'set', path:['_ops'], value}])`。
   * mutate 失败（后端未就绪/命名空间暂不可见）时返回 false，调用方按未送达处理。
   *
   * ## 合并 + 确认（协议 v2 的反向通道）
   *
   * 每次写整槽会把上一批**还没被 host 消费**的操作整批覆盖掉（host 清空 `_ops`
   * 与客户端覆盖是同一类丢失），所以本页把 `pull` / `consume` 操作按 id 收进
   * {@link pendingOps}，每次 flush 写出「当前全部待确认 + 本次新操作」；只有下面
   * 的确认判据命中才移除（见 applySettings 里的 opsAck 处理）：
   *  - `_push.opsAck` 带该 id（host 明确回执）；
   *  - `pull`：`_push.nonce` 等于本次请求的 nonce（既有回执）；
   *  - `consume`：`_push.prediction` 是该 requestKey 的 `consumed` 终态。
   * host **清空 `_ops`** 或写失败都**不算**确认——重试时保留同一批操作与同一批 id。
   * 热度管理类操作（pin/delete/add/clear）仍是「写一次即弃」，不进待确认集合。
   */
  const pendingOps = new Map<string, Record<string, unknown>>();
  const writeOps = (payload: string): Promise<boolean> => {
    const svc = remoteOf(ctx)?.settings;
    if (svc === undefined) {
      return Promise.resolve(false);
    }
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return Promise.resolve(false);
    }
    // 本次新操作：pull / consume 进待确认集合（顺带补唯一操作 id），其余（热度
    // 管理）只参与这一次 flush，写出去即弃——它们失败可以被下一次用户操作重放。
    const fresh: Record<string, unknown>[] = [];
    for (const raw of Array.isArray(envelope.ops) ? envelope.ops : []) {
      if (typeof raw !== 'object' || raw === null) continue;
      const op = raw as Record<string, unknown>;
      if (op.op !== 'pull' && op.op !== 'consume') {
        fresh.push(op);
        continue;
      }
      // 同一 id 的重发是原地更新（Map 保留首次插入顺序）：重发不改变批内容顺序，
      // host 侧「载荷字符串判重」才有意义。
      const id = typeof op.id === 'string' && op.id !== '' ? op.id : newOpToken();
      op.id = id;
      pendingOps.set(id, op);
    }
    // 合并：待确认的在前（保持 host 首次见到的顺序），本次新操作在后。
    const ops = [...pendingOps.values(), ...fresh];
    if (ops.length === 0) return Promise.resolve(false);
    envelope.ops = ops;
    // **三个参数都必填**：client api 对 `settings/mutate` 校验实参个数，少传
    // `expectedRevision` 会被直接拒绝（`expected 3 argument(s), got 2`），写入根本
    // 不会发生——旧版本这几行就这么静默失败过。revision 用最近一次 describe 拿到
    // 的值；不匹配时整批失败（避免覆盖他人改动），随后的文档变更事件会刷新
    // revision，pull 的退避重试会带着新值再来一次。
    const expected = settingsRevision < 0 ? 0 : settingsRevision;
    // 每次请求带一个随机 nonce：宿主对 `_ops` 按**载荷字符串**判重（700ms 轮询，
    // 同一请求不能重复消费）。页面刷新后 pullRev 从 0 重数，同一会话会发出与上次
    // 逐字相同的请求，宿主把它当"无变化"丢掉——真机踩到过（pull 已写进文档、宿主
    // 永不应答）。nonce 让每次请求都独一无二；宿主侧 schema 是普通 z.object，
    // 多出的键会被忽略。
    envelope.nonce = newOpToken();
    const framed = JSON.stringify(envelope);
    return svc
      .mutate(SETTINGS_NAMESPACE, [{ op: 'set', path: ['_ops'], value: framed }], expected)
      .then(() => {
        // 写成功只代表「投出去了」：待确认项要等 `opsAck` / nonce / consumed 终态
        // 才算确认，仍未被确认就按退避再投一次（与失败同一条有界路径）。
        opsDeliveryFailed = false;
        if (pendingOps.size > 0) scheduleOpsRetry();
        return true;
      })
      .catch(() => {
        // CAS 冲突或连接抖动：这一批必须自己再投，不能等用户的下一次操作。
        opsDeliveryFailed = true;
        scheduleOpsRetry();
        return false;
      });
  };
  let pullRev = 0;
  /** 最近一次 `describe()` 读到的本命名空间 revision（`mutate` 的 CAS 参数）。 */
  let settingsRevision = -1;
  /**
   * 是否已成功读到过一份设置载荷。`describe()` 是异步的，会话绑定可能先发生；
   * 在它回来之前 `settings` 还是默认值（`llmEnabled` 默认 true），据默认值就附带
   * catch_up 会在用户其实关了开关时白跑一次模型。
   */
  let settingsLoaded = false;
  /**
   * 「当前连接已被 host 对账」：协议 v2 的模型建议只有在它为真时才允许显示。
   *
   * `_push` 是 volatile 字段，值会留在 profile 文档里：首次连接 / `connection/reset`
   * / 宿主换代（`epoch` 变化）之后，describe 读到的可能仍是**上一个进程**写下的
   * `outcome:'suggested'` 记录——拿它显示等于给用户看一份当前 host 从未确认过的
   * 建议（复核者复现的 P1）。故显示门槛与真正的「对账」绑定，两条证据任一成立：
   *  - 订阅之后到达的**新**实时推送（事件驱动读取且 `_push` 内容确实变了）：这是
   *    host 此刻的产物，不是磁盘残留；
   *  - 带本次 pull `nonce` 的应答（`_push.nonce` 原样回带）：我们问过，host 答了。
   * 历史前缀补全走的是按会话缓存的 history，不受此门槛影响。
   * `connection/reset` 与宿主换代把它归零，由随后的推送 / 应答重新建立。
   */
  let modelConfirmed = false;
  let lastPulledSessionId: string | undefined;
  /**
   * 尚未确认收到应答的 pull（见 retryPendingPull）；null = 无待确认请求。
   *
   * 协议 v2 起同一条 pull 可顺带要求 host 跑一次「官方输入预测」（catch_up）：
   * `requestPrediction` + `nonce` / `id` 一旦发出就必须在**重发时原样复用**——host
   * 按 `nonce` 回执（`_push.prediction.nonce`）、按 `id` 判重，换了标识会让同一次
   * 「打开会话」fork 两次。
   */
  let pendingPull: {
    sessionId: string;
    attempts: number;
    /** 这条 pull 是否附带 catch_up 预测请求（协议 v2）。 */
    requestPrediction: boolean;
    /** 预测请求的关联标识（host 原样回带）；未附带预测时为 null。 */
    nonce: string | null;
    /** `_ops` 操作 id（与 nonce 同源，供 host 判重/追踪）。 */
    id: string | null;
  } | null = null;
  /**
   * catch_up 的「待补问」标记（官方语义 §3.1）：草稿非空 / 页面隐藏 / 回合进行中
   * 时只同步状态，资格恢复后再补问一次预测。
   *
   * 问过即落，只有重新掉进不合格态才会再次置位——否则每次重渲染都会去 fork 一次
   * 模型（`src/index.ts` 的 live 触发已经负责每个新回合，client 只补「打开会话 /
   * 重连 / 从不可用态恢复」这三种对账）。
   */
  let catchUpArmed = true;
  /**
   * 本连接代次内**已采纳**的预测记录键，按会话分组。
   *
   * 采纳后草稿被填满，用户再清空草稿时 host 的 `outcome:'consumed'` 未必已经推
   * 到——本地必须先自证「这条已经用过了」，否则幽灵会在清空草稿的瞬间复活。
   */
  const consumedKeys = new Map<string, Set<string>>();
  /** 每条记录最多记这么多键（FIFO 淘汰：长会话里已消费记录不无界增长）。 */
  const CONSUMED_KEYS_CAP = 32;
  /** 该预测记录是否已在本地被采纳过。 */
  const isConsumed = (sessionId: string, requestKey: string): boolean =>
    consumedKeys.get(sessionId)?.has(requestKey) === true;
  /** 记下「这条预测记录已采纳」（草稿清空也不复活，见 consumedKeys 注释）。 */
  const markConsumed = (sessionId: string, requestKey: string): void => {
    const set = consumedKeys.get(sessionId) ?? new Set<string>();
    set.add(requestKey);
    while (set.size > CONSUMED_KEYS_CAP) {
      const oldest = set.values().next().value;
      if (oldest === undefined) break;
      set.delete(oldest);
    }
    consumedKeys.set(sessionId, set);
  };
  /**
   * 是否见过 host 的真实载荷（`_push` 非空）。兼容判据：老宿主的载荷不带
   * `epoch`，此时「有值 → 空值」的跳变就是「换了个没有内存状态的宿主」。
   */
  let hadPush = false;
  /** 最近一次载荷里的宿主实例标识（见 `GhostPushPayload.epoch`）；undefined = 尚未见过。 */
  let hostEpoch: string | undefined;
  /** 待确认 pull 的退避定时器（仅在有 pendingPull 时存在）。 */
  let pullRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 未被确认的 `_ops` 操作（`pendingOps` 非空）的补投定时器。 */
  let opsRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** 当前 revision 代次里已连续补投几次（revision 变化时清零）。 */
  let opsRetryAttempts = 0;
  /**
   * 最近一次 `_ops` 写入是否**失败**（CAS 冲突 / 连接抖动）。
   *
   * revision 前进只在自己写入失败过时才触发立即补投：client 自己的写入同样会让
   * revision 前进并回调 applySettings，若只看「revision 变了」就会写成自我循环
   * （写 → 通知 → 再写 → …，实测直接把进程写崩）。
   */
  let opsDeliveryFailed = false;
  /**
   * catch_up 的触发条件（协议 v2）：为**当前主会话**拉状态时才有资格顺带要预测。
   *
   * 与显示门槛同源，但不要求「已经显示了幽灵」——恰恰相反，拉取的目的就是让它
   * 出现。五条逐字对应官方语义：草稿为空、非 IME 组词、会话未运行（回合进行中
   * 的预测必然立刻过期）、预测开关开启、会话可见（页面隐藏时不无谓 fork）。
   * @param sessionId - 本次 pull 的目标会话（必须就是当前主会话）。
   */
  const canRequestPrediction = (sessionId: string): boolean => {
    if (!settingsLoaded) return false; // 还没读到真实开关值，不据默认值 fork 模型
    if (!settings.llmEnabled) return false;
    if (composing) return false;
    if (bound === null || lastSessionId !== sessionId) return false;
    if (bound.input.state.getSnapshot().draft !== '') return false;
    if ((bound.session.getSnapshot() as { running: boolean }).running) return false;
    return document.visibilityState !== 'hidden';
  };

  /**
   * 发一条 pull（或按原样重发同一条待确认 pull）。
   *
   * 重发路径必须复用 pending 里的 `nonce` / `id`：改了标识 host 会当成另一次预测
   * 请求再 fork 一次（`_ops` 按载荷字符串判重，见 writeOps）。
   * @param pending - 待确认的 pull 记录；首次发送时补上缺失的操作 id（重发复用）。
   */
  const sendPull = (pending: {
    sessionId: string;
    requestPrediction: boolean;
    nonce: string | null;
    id: string | null;
  }): void => {
    pullRev += 1;
    // 操作 id 与预测 nonce 分开：**每条** pull 都要有 id（`_ops` 的确认键，
    // 见 pendingOps），nonce 只在附带 catch_up 时有意义。
    if (pending.id === null) pending.id = newOpToken();
    const op: Record<string, unknown> = {
      op: 'pull',
      sessionId: pending.sessionId,
      id: pending.id,
    };
    if (pending.requestPrediction) {
      op.requestPrediction = true;
      op.nonce = pending.nonce;
    }
    void writeOps(JSON.stringify({ rev: pullRev, ops: [op] }));
    schedulePullRetry(); // 未被应答时按退避重试（见 retryPendingPull）
  };

  /**
   * 告诉 host「这条预测记录已被采纳」（协议 v2）。
   *
   * 采纳本身只写本地草稿、**绝不发送**；这条 consume 是唯一的事后通知，走既有的
   * `_ops` 批写通道。写失败不影响本地判定（markConsumed 已先落）。
   * @param sessionId - 记录所属会话。
   * @param requestKey - 被采纳记录的稳定请求键。
   */
  const consumePrediction = (sessionId: string, requestKey: string): void => {
    pullRev += 1;
    void writeOps(JSON.stringify({
      rev: pullRev,
      ops: [{ op: 'consume', sessionId, requestKey, id: newOpToken() }],
    }));
  };

  /**
   * 宿主换人 / 连接重置时清掉预测相关的按会话状态：已消费集合 + 待确认请求（按会话
   * 的预测/路由缓存由调用方随 `perSession.clear()` 一起清）。
   *
   * 待确认 pull **无条件**清掉（不再只看 `requestPrediction`）：宿主已换代，上一代
   * 次的 nonce / 操作 id 不可能再被认领；留着它既挡不住显示（`modelConfirmed` 已
   * 归零），还会让 `pullHistory` 的「同一目标已有待确认请求」判据挡住换代后的重新
   * 对账。清掉后由调用方立刻重发一条（新 nonce / 新 id）。
   */
  const resetPredictionState = (): void => {
    consumedKeys.clear();
    catchUpArmed = true; // 新宿主：重新按资格补问一次
    pendingPull = null;
    if (pullRetryTimer !== null) {
      clearTimeout(pullRetryTimer);
      pullRetryTimer = null;
    }
    // 上一代宿主的操作 id / requestKey 在新宿主里不可能再被认领：留着只会永远
    // 补投不成功。换代后的对账由调用方重新发一条 pull 完成。
    pendingOps.clear();
    if (opsRetryTimer !== null) {
      clearTimeout(opsRetryTimer);
      opsRetryTimer = null;
    }
    opsRetryAttempts = 0;
    opsDeliveryFailed = false;
  };

  /**
   * 请求 host 推送某会话的权威状态（历史环 + 建议 + 热度）——这也是 host 侧的
   * **对账请求**：本页打开后该会话收到过什么，只有 host 说了算。
   *
   * 因此判据是「本次页面生命周期内是否已为本会话请求过」（lastPulledSessionId，
   * 由 resolve 在会话变化时置位），而**不能**拿本地残留的
   * `settings.historySessionId` 当「已经有了」的证据：
   * 那份数据可能来自上一个进程，而 host 这次可能因为「会话尚未进店」而整个跳过
   * 了启动对账推送（见 index.ts），此时若据此跳过请求，就再也没有对账机会了。
   *
   * 若写入抢跑在 host 的 `_ops` 监听注册之前，host 启动对账会补消费这条遗留
   * 请求（consumeOps 的遗留补跑），不会丢。
   *
   * 协议 v2：满足 {@link canRequestPrediction} 时同一条 pull 顺带携带
   * `requestPrediction:true` + `nonce` / `id`，host 据此为该会话跑一次 catch_up
   * 预测，结果经 `_push.prediction` 回来（`nonce` 原样回带，作回执）。
   */
  const pullHistory = (sessionId: string): void => {
    const wantPrediction = canRequestPrediction(sessionId);
    // 同一目标已有待确认请求：不重复排队。它要么已经在要预测，要么现在也不必
    // 要（`wantPrediction` 为假）——两种情况都只续上退避重试，`nonce` / `id`
    // 原样保留（换标识 = host 侧多 fork 一次）。
    if (pendingPull !== null && pendingPull.sessionId === sessionId
      && (pendingPull.requestPrediction || !wantPrediction)) {
      schedulePullRetry();
      return;
    }
    const token = wantPrediction ? newOpToken() : null;
    pendingPull = {
      sessionId,
      attempts: 0,
      requestPrediction: wantPrediction,
      nonce: token,
      // 操作 id 与预测 nonce 分开：即使这条 pull 不带预测，也要有稳定的 `_ops`
      // 操作 id，host 才能在 `opsAck` 里确认它（见 pendingOps）。
      id: newOpToken(),
    };
    sendPull(pendingPull);
  };

  /**
   * 资格恢复后的补问（协议 v2，官方语义 §3.1）：合格 + 尚未补问 + 本会话没有
   * 值得保留的终态记录时，发一次带 `requestPrediction` 的 pull。
   *
   * 本会话已有终态记录（suggested / abstained / consumed / failed / …）时不补问：
   * 那说明「这个源回合已经有结论」，重复补问只会让 host 对同一源重复跑模型；新回合
   * 的预测由 host 的 live 触发负责（`src/index.ts` 的回合完成事件）。
   * `stale_source` / `ineligible` 是「当时源不可用」，host 状态变化后值得重查。
   */
  const maybeRequestCatchUp = (): void => {
    // 目标就是当前绑定（可见）的主会话：未绑定时无从判断可见性，等下次渲染。
    const currentId = lastSessionId;
    if (currentId === undefined) return;
    if (!canRequestPrediction(currentId)) {
      catchUpArmed = true; // 不合格：只同步状态，等资格恢复后再补问
      return;
    }
    if (!catchUpArmed) return;
    if (pendingPull !== null && pendingPull.sessionId === currentId) return; // 已有待确认请求
    const existing = predictionFor(currentId);
    if (existing !== null && existing.outcome !== 'stale_source' && existing.outcome !== 'ineligible') return;
    catchUpArmed = false; // 问过即落（见 catchUpArmed 注释）
    pullHistory(currentId);
  };

  /**
   * 未得到应答的 pull 重试：host 可能因「会话尚未进店 / 环尚不可得」而只回了一
   * 份不含历史的载荷，而请求本身已被消费（`_ops` 被清空）——没有重试就再没有
   * 对账机会。用退避定时器驱动（render 不保证还会被触发），上限
   * {@link PULL_MAX_ATTEMPTS} 次后放弃，避免会话真的不存在时自旋。
   */
  const retryPendingPull = (): void => {
    const pending = pendingPull;
    if (pending === null) return;
    // 只有当前仍绑定该会话时才值得重试（切走后由新会话的 pull 接管）。
    if (lastSessionId !== pending.sessionId) {
      pendingPull = null;
      return;
    }
    if (settings.historySessionId === pending.sessionId) {
      pendingPull = null; // 已收到该会话的权威状态，对账完成
      return;
    }
    if (pending.attempts >= PULL_MAX_ATTEMPTS) {
      pendingPull = null;
      return;
    }
    pending.attempts += 1;
    // 重发复用同一 nonce/id（sendPull 从 pending 取），host 不会把它当新请求。
    sendPull(pending);
  };

  /** 为待确认的 pull 排下一次退避重试（已存在定时器时不重复排）。 */
  const schedulePullRetry = (): void => {
    if (pendingPull === null || pullRetryTimer !== null) return;
    const delay = PULL_RETRY_BASE_MS * 2 ** pendingPull.attempts;
    pullRetryTimer = setTimeout(() => {
      pullRetryTimer = null;
      retryPendingPull();
    }, delay);
  };
  /**
   * 把**当前全部待确认的 `_ops` 操作**整批再投一次（没有新操作时 fresh 为空）。
   *
   * 与 pull 的退避重试分开：pull 的确认判据是「收到了该会话的权威状态」，而 `_ops`
   * 的确认判据是 `opsAck` / nonce 回执 / `consumed` 终态（见 applySettings）。重投
   * 复用 `pendingOps` 里同一批操作与同一批 id（host 按 id 判重、按 nonce 回执）。
   */
  const retryPendingOps = (): void => {
    if (pendingOps.size === 0) return;
    void writeOps(JSON.stringify({ rev: (pullRev += 1), ops: [] }));
  };

  /**
   * 为待确认的 `_ops` 操作排一次补投（已有定时器时不重复排）。
   *
   * 预算内用指数退避抢时间；预算用尽后**不放弃**，降到 `OPS_RETRY_IDLE_MS` 的低频
   * 重试（见该常量的注释：持续 CAS 冲突时早先的「放弃」会让 consume 永远送不出去）。
   * revision 前进（`applySettings`）会把计数归零，重新回到快速档。
   */
  const scheduleOpsRetry = (): void => {
    if (pendingOps.size === 0 || opsRetryTimer !== null) return;
    const delay = opsRetryAttempts >= OPS_MAX_ATTEMPTS
      ? OPS_RETRY_IDLE_MS
      : Math.min(OPS_RETRY_BASE_MS * 2 ** opsRetryAttempts, OPS_RETRY_MAX_MS);
    opsRetryAttempts += 1;
    opsRetryTimer = setTimeout(() => {
      opsRetryTimer = null;
      retryPendingOps();
    }, delay);
  };
  /**
   * 读取本插件的 settings 命名空间并订阅变更。
   *
   * 0.1.7 变更：`settingsScope` 服务已从内核移除（随 settings.yaml 体系一起
   * 退役），本插件的命名空间改由 `ctx.remote.settings` 读写：
   *  - 读：`remote.settings.describe()` → 解包 RPC 信封 → 按 ns 找 `namespaces[]`；
   *  - 变更：`remote.$on('settings/document-updated')` —— 该事件在内核的转发
   *    白名单里（dsh-api-remotes 的 `API_REMOTE_FORWARDED_EVENTS`，mode: 'emit'），
   *    内核自己的设置页也是这么订阅的（见 dsh-client-ui-settings 的
   *    `SettingsDescribeMirror`）。**无轮询**：host 推 `_push` 必然改 revision，
   *    于是事件只在真实推送时到达。
   *
   * 载荷结构与 0.1.5 时代完全一致（`_push` / `_ops` 仍是 JSON 字符串），故下面
   * 的解析与 `*SessionId` 归属守卫逐字保留。
   */
  const remote = remoteOf(ctx);
  if (remote?.settings !== undefined) {
    let describeInFlight = false;
    /**
     * 在途 describe 期间又收到通知：结束后必须**再读一次**，不得直接丢。
     *
     * 一次在途读取拿到的是「它被发出时」的文档状态；期间到达的作废（`stale_source`）
     * 或新结果若不安排重读，就会因为这一次在途读取被**永久错过**——之后没有事件再来，
     * 幽灵会一直停在旧内容上（复核者复现的 P1）。
     */
    let describePending = false;
    /** 待重读是否由实时事件触发（重读时据此判断能否作为「已被 host 对账」的证据）。 */
    let describePendingLive = false;
    /** 插件已卸载：不再重排读取（见下面的 finally）。 */
    let settingsDisposed = false;
    /**
     * 最近一次读到的 `_push` 原始字符串。
     *
     * 用来区分「host 真的推了一份新载荷」与「同一份载荷被重读一遍」（自己写 `_ops`、
     * 其他命名空间的写入都会触发 document-updated）：只有前者能算对账证据
     * （见 modelConfirmed），后者也不值得把整份状态重算一遍。
     */
    let lastRawPush: string | null = null;
    /**
     * @param live - 本次读取是否由实时事件（`settings/document-updated`）触发；首次
     * 读盘为 false。只有实时读取才可能成为「host 已对账」的证据，见 modelConfirmed。
     */
    const applySettings = (live: boolean): void => {
      if (settingsDisposed) return;
      if (describeInFlight) {
        // 不丢通知：置待重读标记，finally 之后按**最新**文档再读一次。
        describePending = true;
        if (live) describePendingLive = true;
        return;
      }
      describeInFlight = true;
      void (async () => {
        try {
          const described = await remote.settings!.describe();
          if (settingsDisposed) return;
          const list = unwrapSettingsDoc(described)?.namespaces ?? [];
          const entry = list.find((row) => row.ns === SETTINGS_NAMESPACE);
          if (entry === undefined) return;
          const v = (entry.value ?? {}) as Record<string, unknown>;
          // `_push` 原始字符串：内容没变的重读（例如自己写 `_ops` 触发的文档事件）
          // 既不是 host 的新推送，也不需要重算一遍状态。
          const rawPush = typeof v._push === 'string' && v._push !== '' ? v._push : null;
          const pushChanged = rawPush !== lastRawPush;
          // revision 未变说明没人改过（事件可能因其他命名空间的写入而到达）；
          // `_push` 变了则必须处理——它不是本地写出来的，只能是 host 推的新载荷。
          const rev = typeof entry.revision === 'number' ? entry.revision : 0;
          if (rev === settingsRevision && !pushChanged) return;
          const revisionAdvanced = rev !== settingsRevision;
          settingsRevision = rev;
          lastRawPush = rawPush;
          if (revisionAdvanced && pendingOps.size > 0 && opsDeliveryFailed) {
            // 别人改过文档，而**我们上一次写入是失败的**：CAS 冲突的原因已经消失
            // （复核反例：采纳时撞上另一写入方，之后用户不再操作）。立刻补投一次，
            // 不等任何用户动作。只看 revision 变化会写成自我循环——自己写成功也会
            // 让 revision 前进。
            opsRetryAttempts = 0;
            retryPendingOps();
          }
          // 解析 `_push`：v1 字段 + v2 可选字段（`protocol` / `prediction` / `route`）。
          // 缺 v2 字段 = 旧宿主，按 v1 语义降级（不抛错、不启用预测门槛）。
          let pushed: GhostPushPayload | null = null;
          if (rawPush !== null) {
            try {
              // 断言成声明的载荷形状（写 `as typeof pushed` 会让断言类型跟着
              // 当前收窄结果走，此处 pushed 恰为 null，后续字段全变 never）。
              pushed = JSON.parse(rawPush) as GhostPushPayload;
            } catch {
              pushed = null;
            }
          }
          settings = {
            historyEnabled: typeof v.historyEnabled === 'boolean' ? v.historyEnabled : true,
            historyCrossSession: typeof v.historyCrossSession === 'boolean' ? v.historyCrossSession : false,
            historyMaxEntries: typeof v.historyMaxEntries === 'number' ? v.historyMaxEntries : 50,
            historyMinChars: typeof v.historyMinChars === 'number' ? v.historyMinChars : 1,
            wordAccept: typeof v.wordAccept === 'boolean' ? v.wordAccept : true,
            // 预测开关（协议 v2 的 live 值；缺字段 = 旧宿主，默认开启，与 host 默认一致）。
            llmEnabled: typeof v.llmEnabled === 'boolean' ? v.llmEnabled : true,
            // 缺 `protocol` 的载荷 = 旧宿主，按 v1 处理：不启用 prediction 显示门槛，
            // 免得把旧宿主仍然有效的建议整条挡掉（见 ghostContent 的模式 2）。
            protocol: typeof pushed?.protocol === 'number' ? pushed.protocol : 1,
            // 预测记录：null 既是「载荷没带」也是「host 明说本会话无记录」，两者
            // 在本会话的判定上同义（无记录 → 不出幽灵），故不做区分。
            prediction: parsePrediction(pushed?.prediction),
            route: parseRoute(pushed?.route),
            nonce: typeof pushed?.nonce === 'string' ? pushed.nonce : null,
            suggestion: pushed?.suggestion === null || pushed?.suggestion === undefined
              ? null
              : (pushed.suggestion as typeof settings.suggestion),
            hot: pushed?.hot === null || pushed?.hot === undefined
              ? null
              : (pushed.hot as typeof settings.hot),
            // history 省略 = host 本次推送不携带历史（保留现值）。启动对账推送正是
            // 这种形态：它只负责恢复建议，历史留给紧随其后的 pull 应答，此时若把
            // 本地历史清成 [] 会把「切回会话仍有历史」的体验一起清掉。
            history: Array.isArray(pushed?.history)
              ? (pushed?.history as unknown[]).filter((t): t is string => typeof t === 'string')
              : settings.history,
            historySessionId: Array.isArray(pushed?.history)
              ? (typeof pushed?.historySessionId === 'string' ? pushed.historySessionId : null)
              : settings.historySessionId,
            suggestionSessionId: typeof pushed?.suggestionSessionId === 'string' ? pushed.suggestionSessionId : null,
          };
          settingsLoaded = true; // 已读到真实开关值，此后才允许附带 catch_up
          // 回合回顾（recap）：`recapsSessionId` 出现即表示「这是该会话的完整回顾
          // 集合」（空数组 = 明确清空）；两个字段都缺席 = 本次推送不携带，保留
          // 已有内容（与 history 同一种省略语义）。渲染由 turnTail 槽里的
          // `RecapLine` 订阅本模块的 store 完成，与幽灵 overlay 完全解耦。
          const pushedRecapsSessionId = typeof pushed?.recapsSessionId === 'string' ? pushed.recapsSessionId : null;
          if (pushedRecapsSessionId !== null) applyRecaps(pushedRecapsSessionId, pushed?.recaps);
          // catch_up 的确认回执判据（要在下面 hostChanged 清 pendingPull **之前**
          // 取，否则换代那一拍永远认不出应答）：host 把本代次请求的 `nonce` 原样回带
          // （abstain / failed 也会带）。
          const nonceMatched = pendingPull !== null && pendingPull.nonce !== null
            && (settings.nonce === pendingPull.nonce
              || (settings.prediction !== null && settings.prediction.nonce === pendingPull.nonce));
          // 宿主换人（插件重载 / 进程重启）⇒ 按会话缓存全部作废。
          //
          // 信号一（权威）：载荷里的 `epoch`。`_push` 是 volatile 字段，值会留在
          // profile 文档里，所以新宿主写第一份载荷之前，client 读到的仍是旧实例
          // 的内容——epoch 一变就说明这份数据的作者已经死了。
          // 信号二（兼容旧宿主，无 epoch）：`_push` 从有值退回空值，同样是「换了
          // 个没有内存状态的宿主」。
          //
          // 两者都要清缓存并**强制补拉一次当前会话**：`resolve()` 的「会话没变就
          // 不重拉」会让这份陈旧值一直显示下去（切走再切回才自愈）。
          const epoch = typeof pushed?.epoch === 'string' ? pushed.epoch : undefined;
          const hostChanged = (epoch !== undefined && hostEpoch !== undefined && epoch !== hostEpoch)
            || (pushed === null && hadPush);
          if (epoch !== undefined) hostEpoch = epoch;
          hadPush = pushed !== null;
          if (hostChanged) {
            perSession.clear(); // 含协议 v2 的按会话预测 / 路由缓存
            resetPredictionState(); // 已消费集合 + 待确认请求（nonce / 操作 id 一并作废）
            clearRecaps(); // 回合回顾随宿主换代一起作废（新宿主会按 pull 应答重发）
            lastPulledSessionId = undefined;
            // 换代 ⇒「已被 host 对账」的资格归零，由随后的推送 / pull 应答重建
            // （见 modelConfirmed）。上面的 pullHistory 会带新 nonce 重新问一次。
            modelConfirmed = false;
            if (lastSessionId !== undefined) pullHistory(lastSessionId);
          }
          // 对账证据：本次读取是带 nonce 的应答，或是订阅之后到达的**新**实时载荷
          // （`live && pushChanged`：自己写 `_ops` 触发的同内容重读不算）。
          if (nonceMatched || (live && pushChanged)) modelConfirmed = true;
          // ── 反向通道的确认（见 pendingOps / writeOps）────────────────────────
          // 只有确认命中才从待确认集合移除：host 清空 `_ops`、写失败都不算，
          // 否则「写新批次把旧批次丢了」会让操作永久失联。
          const acked = new Set<string>();
          if (Array.isArray(pushed?.opsAck)) {
            for (const id of pushed.opsAck) if (typeof id === 'string' && id !== '') acked.add(id);
          }
          if (nonceMatched) {
            // 既有判据：`pull` 的 nonce 被回带 ⇒ 这条 pull 已被消费。
            if (pendingPull !== null && pendingPull.id !== null) acked.add(pendingPull.id);
            pendingPull = null;
            if (pullRetryTimer !== null) {
              clearTimeout(pullRetryTimer);
              pullRetryTimer = null;
            }
          }
          if (settings.prediction !== null && settings.prediction.outcome === 'consumed') {
            // `consume` 的等价判据：host 已把该 requestKey 推到 consumed 终态。
            for (const [id, op] of pendingOps) {
              if (op.op === 'consume' && op.requestKey === settings.prediction.requestKey) acked.add(id);
            }
          }
          for (const id of acked) pendingOps.delete(id);
          // 按会话存档（`_push` 只有一格，不留档就只剩最后结束回合那条）。
          if (settings.suggestionSessionId !== null) {
            cachePut(settings.suggestionSessionId, settings.suggestion);
          }
          // 协议 v2：预测记录 / 路由也按会话存档。记录自带 `sessionId`，与建议槽
          // 的归属无关（`_push` 只有一格，别的会话那条也会被推上来）。
          // **只存已对账的载荷**：未确认的磁盘残留存进去，会在切回该会话时被当作
          // 有效记录复活（见 modelConfirmed）。
          if (modelConfirmed && settings.prediction !== null) {
            cachePut(settings.prediction.sessionId, undefined, undefined, settings.prediction, settings.route);
          }
          // 带 history 的载荷 = host 对某个会话的**对账答复**（pull 应答 / 回合结束
          // 推送都带）：它同时权威地决定了该会话有没有有效建议——载荷里那条建议若
          // 不属于它，说明它没有（host 会把「仍被追踪的别的会话那条」原样带上），
          // 此时必须显式清掉缓存，否则切回该会话会显示过期文本。
          if (Array.isArray(pushed?.history) && settings.historySessionId !== null) {
            const sid = settings.historySessionId;
            // 协议 v2 同理：对账答复也权威地决定该会话有没有预测记录——记录若不
            // 属于它（或 host 没带），必须显式清掉，否则切回来会按旧记录出幽灵。
            // 未对账的载荷（`undefined`）不写预测：保留旧值，别把残留记录洗成
            // 「有效记录」。
            const prediction = modelConfirmed
              ? (settings.prediction !== null && settings.prediction.sessionId === sid
                ? settings.prediction
                : null)
              : undefined;
            cachePut(sid, settings.suggestionSessionId === sid ? settings.suggestion : null, settings.history,
              prediction, settings.route);
          }
          render();
        } catch {
          // describe 失败（网络抖动/后端未就绪）时保留现值，等下一个事件或重连。
        } finally {
          describeInFlight = false;
          // 在途期间到达的通知必须补读一次，否则 host 的作废 / 新结果会因为这一次
          // 在途读取被永久错过（见 describePending）。卸载后不再重排。
          const again = describePending && !settingsDisposed;
          const againLive = describePendingLive;
          describePending = false;
          describePendingLive = false;
          if (again) applySettings(againLive);
        }
      })();
    };
    // 首读一次（事件只推增量），此后由内核转发的事件驱动——无轮询。
    // `connection/reset` 后需重新首读：那之前的订阅与缓存都可能已失效。连接已经
    // 换代 ⇒「已被 host 对账」的资格一并作废：先隐藏模型幽灵（不等 describe 回来）
    // 并清掉按会话预测缓存，再重新 pull 一次；`_push` 里那份数据可能来自上一个
    // 进程，重读本身**不**构成确认（故这里用 applySettings(false)）。
    const offUpdated = remote.$on?.('settings/document-updated', () => applySettings(true));
    const offReset = ctx.on('connection/reset', () => {
      modelConfirmed = false;
      perSession.clear();
      resetPredictionState();
      clearRecaps(); // 连接换代：回顾同样可能来自上一个进程，清掉等新宿主重发
      lastPulledSessionId = undefined;
      render(); // 立即隐藏模型幽灵（显示的只是上一代次的数据）
      if (lastSessionId !== undefined) pullHistory(lastSessionId);
      applySettings(false); // 重读一次，等 host 的新推送 / 带 nonce 的应答再放行
    });
    ctx.effect(() => () => {
      settingsDisposed = true;
      describePending = false;
      offUpdated?.();
      offReset();
    });
    applySettings(false);
  }

  /**
   * 采纳按键：模型建议按官方语义由**无修饰键的 Tab / ArrowRight / Enter**三键整条
   * 采纳（与配置键无关）；历史补全仍按配置键（默认 Tab）整条采纳，幽灵显示时裸
   * 右方向键 → 逐词采纳（逐词只服务历史）。
   */
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    if (shown === null) return;
    // 焦点必须在会话输入框内（textarea 或 0.1.2 contenteditable composer）。
    const focused = document.activeElement;
    if (!(focused instanceof HTMLTextAreaElement)
      && !(focused instanceof HTMLElement && focused.isContentEditable)) return;
    if (!isComposerTarget(focused)) return;
    const content = shown.content;
    // 模型建议（协议 v2）：官方语义是「无修饰键的 Tab / ArrowRight / Enter 三键
    // 等价、一律整条采纳」——不看配置的 acceptKey，也不走逐词（见下面的分支）。
    const llmPlainAccept = content.kind === 'llm' && isPlainLlmAcceptKey(event);
    const acceptKey = content.kind === 'llm' ? content.acceptKey : DEFAULT_ACCEPT_KEY;
    const matcher = parseAcceptKey(acceptKey);
    if (llmPlainAccept || (matcher !== undefined && matcher(event))) {
      if (content.kind === 'llm') {
        // 动草稿前**重新核对**（事件可能在渲染之后才到，中间隔着一次会话切换 /
        // 草稿变化 / 建议失效）：幽灵确实还画着、草稿为空、会话归属未变、焦点仍
        // 在本 composer、且这不是 IME 的确认键。任一不成立就原样放行这个按键。
        if (!isPlainLlmAcceptKey(event)) return;
        if (event.isComposing || event.keyCode === 229) return; // IME 确认键优先
        if (shown === null || shown.content !== content || !overlay.isShowing()) return;
        if (bound === null || lastSessionId === undefined) return;
        // 归属判据用**已绑定**的会话（`resolve()` 成功时置位，切换会话时同步更新）：
        // 它同时是 `predictionFor` 的查询键，记录自带的 `sessionId` 必须与之一致。
        const currentId = lastSessionId;
        if (bound.input.state.getSnapshot().draft !== '') return;
        // 协议 v2：还要确认 host **此刻**仍说这条是 `suggested`，且本连接代次里没
        // 消费过。协议 v1（旧宿主，载荷无 `protocol`）没有预测记录可核，沿用旧的
        // 「归属 + 草稿为空 + 未运行」守卫（旧行为逐字不变）。
        let requestKey: string | null = null;
        if (settings.protocol >= 2) {
          const prediction = predictionFor(currentId);
          if (prediction === null || prediction.sessionId !== currentId
            || prediction.outcome !== 'suggested'
            || isConsumed(currentId, prediction.requestKey)) return;
          requestKey = prediction.requestKey;
        }
        event.preventDefault();
        event.stopPropagation();
        // 整条采纳：只写宿主草稿，**绝不发送**（consume 是事后单独发的通知）。
        bound.input.setDraft(content.text);
        if (requestKey !== null) {
          markConsumed(currentId, requestKey);
          consumePrediction(currentId, requestKey);
        }
        overlay.hide();
        shown = null;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (bound !== null) {
        // 历史补全：若草稿是斜杠命令整行（如 `/later +3m 我`），`full` 是历史
        // 里的「内容」部分（命令 `recordInput:false`，不含命令名+参数）。
        // 此时采纳必须把命令前缀一并回填，否则用户命令意图被破坏——只剩
        // 内容部分，需要重新键入 `/later +3m ` 才能执行。
        const draftNow = bound.input.state.getSnapshot().draft;
        const contentDraft = stripCommandPrefix(draftNow);
        // 命令整行：contentDraft 是「内容部分」，它不包含命令名+参数。
        // 还原时把 draftNow 头部到 contentDraft 之前的那段（含命令名、
        // 时间参数、以及它们之间的空白）一并保留，再接 content.full。
        const head = contentDraft === ''
          ? draftNow
          : draftNow.slice(0, draftNow.length - contentDraft.length);
        const tailJoiner = head.endsWith(' ') || head === '' ? '' : ' ';
        bound.input.setDraft(`${head}${tailJoiner}${content.full}`);
      }
      overlay.hide();
      shown = null;
      return;
    }
    // 模型建议不走逐词（官方语义是整条采纳，已在上面处理并 return）；下面的
    // 逐词路径**只服务历史补全**，历史那一轨的语义因此完全不变。
    if (content.kind !== 'history') return;
    // 逐词采纳：裸右方向键、光标位于草稿末尾时每次前进一个分词片段。
    // 其余情况一律不拦截（保留浏览器光标移动/焦点行为）；草稿与建议原文
    // 字面分歧（归一化等价但字符不同）时也不劫持，避免拼接出重复片段。
    // 历史补全下若草稿是斜杠命令整行（如 `/later +3m 我`），命令名+参数段
    // 不在候选 `full` 里，要用剥前缀后的 contentDraft 做前缀匹配；采纳后
    // 把命令前缀段（含时间参数）一并保留，避免命令意图被破坏。
    if (settings.wordAccept
      && event.code === 'ArrowRight'
      && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const ta = focused;
      const draftNow = bound !== null ? bound.input.state.getSnapshot().draft : '';
      const full = content.full;
      // 光标必须在草稿末尾：textarea 用 selectionStart/End，contenteditable
      // 用 Selection API（caretAtComposerEnd 统一两代）。
      if (!caretAtComposerEnd(ta)) return;
      const matchBase = stripCommandPrefix(draftNow);
      if (!full.startsWith(matchBase) || matchBase.length >= full.length) return;
      const chunk = nextAcceptChunk(full.slice(matchBase.length));
      if (chunk === '') return;
      event.preventDefault();
      event.stopPropagation();
      let accepted: string;
      if (content.kind === 'history') {
        // 命令整行：draftNow 头部到 matchBase 之前是命令前缀段（含时间参数），
        // 需要随逐词采纳保留。
        const head = matchBase === ''
          ? draftNow
          : draftNow.slice(0, draftNow.length - matchBase.length);
        const tailJoiner = head.endsWith(' ') || head === '' ? '' : ' ';
        accepted = `${head}${tailJoiner}${matchBase}${chunk}`;
      } else {
        accepted = draftNow + chunk;
      }
      if (bound !== null) bound.input.setDraft(accepted);
      if (accepted === full || (content.kind === 'history'
        && accepted.endsWith(full))) {
        overlay.hide();
        shown = null;
      }
    }
  };

  ctx.effect(() => {
      // 订阅：会话列表（切换信号）、会话快照、输入草稿、投影值。
    let unsubs: Array<() => void> = [];
    let deferredRenders: Array<ReturnType<typeof setTimeout>> = [];
    const scheduleDeferredRenders = (): void => {
      for (const t of deferredRenders) clearTimeout(t);
      // React 提交会话视图晚于 list store 更新：rebind 时 composer 可能尚未
      // 挂载，show() 会找不到编辑器；错峰补渲染覆盖这个竞态（幽灵显示后
      // 幂等，重复渲染无副作用）。
      deferredRenders = [60, 300, 900].map((ms) => setTimeout(render, ms));
    };
    const rebind = (): void => {
      for (const un of unsubs) un();
      unsubs = [];
      resolve();
      if (bound !== null) {
        unsubs.push(
          bound.session.subscribe(render),
          bound.input.state.subscribe(render),
          bound.projectionFace.subscribe(render),
        );
      }
      scheduleDeferredRenders();
    };
    rebind();
    render(); // 初始渲染：不依赖订阅触发（修复：会话打开即检查幽灵）
    // 历史环的拉取在 resolve() 绑定成功处统一发起（冷启动经上面的 rebind），
    // 这里不再补发——旧的「初始化时拉一次」在会话尚未就绪时必然落空。
    const onList = (): void => {
      // 会话切换（mainView 保有者变化）→ 重绑订阅（resolve 内即发起 pull）；否则仅渲染。
      const id = currentSessionIdOf(sessions.list.getSnapshot());
      if (id !== lastSessionId) rebind();
      render();
    };
    const unList = sessions.list.subscribe(onList);
    // IME 组词抑制：捕获监听（编辑器内组合事件会冒泡到 window）。组词开始
    // 立即隐藏幽灵；结束（候选上屏）后按已提交草稿重新渲染。
    const onCompositionStart = (): void => {
      composing = true;
      render();
    };
    const onCompositionEnd = (): void => {
      composing = false;
      render();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('compositionstart', onCompositionStart, true);
    window.addEventListener('compositionend', onCompositionEnd, true);
    return () => {
      unList();
      for (const un of unsubs) un();
      for (const t of deferredRenders) clearTimeout(t);
      if (composerRetryTimer !== null) clearTimeout(composerRetryTimer);
      composerRetryTimer = null;
      if (pullRetryTimer !== null) clearTimeout(pullRetryTimer);
      pullRetryTimer = null;
      if (opsRetryTimer !== null) clearTimeout(opsRetryTimer);
      opsRetryTimer = null;
      pendingPull = null;
      consumedKeys.clear(); // 协议 v2：已消费集合随订阅一起作废（重挂后重新对账）
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('compositionstart', onCompositionStart, true);
      window.removeEventListener('compositionend', onCompositionEnd, true);
      overlay.dispose();
    };
  }, 'dsh-foresight: composer ghost render');

  // 设置界面：往 `settings.section` 注册一个**独立设置页**。
  //
  // 槽位名必须是宿主真实存在的那个：`settings.section`（`kind: 'list'`、
  // `scope: 'root'`，每个 list entry 一页设置）。注册项靠 `id` 作导航标识、
  // `order` 定位置、`label` 出导航文案。
  //
  // **不要用 `settings.plugin.item`**：那个名字在 DSH 0.1.7-rc.2 与 0.2.0-rc.2
  // 里都不存在（全仓 grep 零命中）。往不存在的槽位注册不会报错，只是永远没人
  // 消费——表现为「服务都拿到了、注册也执行了、界面就是不画」，极难排查。
  // 宿主实际提供的相关槽位是 `settings.section` / `settings.plugins` /
  // `settings.plugins.tab` / `settings.general.item`。
  //
  // `label` 传 thunk：宿主每次投影都会重读，语言切换后无需重新注册。文案走本文件
  // 的 SECTION_LABELS + locale 快照（`sectionLabel()`），不依赖 locale/ 资源文件
  // ——`settings.section` 的 `label` 是普通函数，不是内核 locale 目录查找。

  const locale = ctx.get('locale') as LocaleFaceLike | undefined;

  // 插件详情页卡片（0.1.7+ / 0.2.0+）：configForms 表单 + `plugins.bundle.config` 卡片。
  // 寻址键是条目 id（`cordis.patch.yml` 的 `id: dsh-foresight`），不是 settings namespace。
  // 注意：configForms 不在顶层 inject，用嵌套 ctx.inject 按需等待（与 later 插件一致）。
  // 必须在提前返回之前注册，否则 remote.settings 缺失时卡片不会显示。
  const ENTRY_ID = 'dsh-foresight';
  // 必须用 ctx.slots（不是 ctx.get('slots')），两者在 0.2.0 中是不同的对象。
  // later 插件直接用 ctx.slots.inject / ctx.slots.register 才能正确注册到宿主。
  // key 必须是**插件包名**（dsh-foresight）：宿主按
  // `ledger.bundles.has(pkg.name)` 判断是否渲染配置区，
  // key 不匹配 → configured=false → 卡片静默不渲染。
  // 寻址键（entryId）只用于 configForms.get()，与此无关。
  if ((ctx as any).slots !== undefined) {
    ctx.inject(['configForms'], () => {
      const forms = ctx.get('configForms') as any;
      if (forms === undefined || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') return;
      const formScope = forms.get(ENTRY_ID);
      ctx.effect(
        () =>
          forms.whileServed([ENTRY_ID], () =>
            (ctx as any).slots.inject('plugins.bundle.config', () =>
              (ctx as any).slots.register({
                name: 'plugins.bundle.config',
                key: 'dsh-foresight',
                locale: 'dsh-foresight',
                inject: () => ({ scope: formScope, locale, surface: 'detail' as const }),
              }, SuggestGhostCard),
            ),
          ),
        'dsh-foresight: plugins-page card',
      );
    });
  }

  // 回合回顾（recap）槽位：回复末尾的一行「这一轮做了什么」。宿主在回合完成
  // 后生成、经 `_push.recaps` 下发；这里注册到 `conversation.chat.turnTail`
  // （ownerProps `{turn, seq, openFile}`，standardProps 含 `sessionId`），渲染
  // 位置＝助手最终文本之后、copy/fork 动作行之前。
  // **必须放在下面 `remote.settings` 的提前返回之前**：该槽与设置服务无关，
  // 放在那之后会在「设置服务不可用 / 未开启设置页」时一起消失。
  // 用自有 id：不顶掉宿主已有的 deliverables / plan / schedule 条目。
  if ((ctx as any).slots !== undefined) {
    const disposeRecapTail = (ctx as any).slots.inject('conversation.chat.turnTail', () =>
      (ctx as any).slots.register({
        name: 'conversation.chat.turnTail',
        id: 'dsh-foresight-recap',
        order: 10,
      }, RecapLine),
    );
    if (typeof disposeRecapTail === 'function') {
      ctx.effect(() => () => {
        try {
          disposeRecapTail();
        } catch {
          // 槽位已随宿主卸载：忽略。
        }
      });
    }
  }

  // 设置对话框中的设置页：默认不显示，由插件详情页的开关控制。
  // 开关状态存储在 localStorage 中，key 为 'dsh-foresight:show-settings-section'。
  const remoteForCard = remoteOf(ctx);
  if ((ctx as any).slots === undefined || remoteForCard?.settings === undefined) return;

  const SHOW_SETTINGS_KEY = 'dsh-foresight:show-settings-section';
  const showSettingsSection = typeof localStorage !== 'undefined' && localStorage.getItem(SHOW_SETTINGS_KEY) === 'true';

  if (!showSettingsSection) return;

  // scope **只建一次**并挂在注册表上：
  //  - 在 `inject` 里现建会让每次渲染都换一个新 scope（新的事件订阅 + 空快照），
  //    卡片拿到的永远是 `status: 'loading'`；
  //  - 生命周期由槽位 disposer 负责（卸载时退订），与卡片的订阅互不干扰。
  const cardScope = remoteSettingsScope(remoteForCard, SETTINGS_NAMESPACE);
  const disposeSection = (ctx as any).slots.inject('settings.section', () => (ctx as any).slots.register({
    name: 'settings.section',
    // 自有 id：用宿主没有的 id 才会「并排新增一页」，复用宿主 id 会顶掉那一页。
    id: SETTINGS_SECTION_ID,
    order: 40,
    label: () => sectionLabel(locale),
    // 卡片只依赖 scope 的 get/subscribe/set 三个成员（见 settings-card.tsx 的
    // PluginSettingsScope），这里用 remote.settings 适配出同形状的最小面：
    // 0.1.7 已无 settingsScope 服务，而卡片逻辑（读快照 / 订阅变更 / 写字段）
    // 与代次无关，不必改卡片本体。
    inject: () => ({ scope: cardScope, locale, surface: 'settings' as const }),
  }, SuggestGhostCard));
  if (typeof disposeSection === 'function') {
    ctx.effect(() => () => {
      disposeSection();
      cardScope.dispose();
    });
  }
}

/**
 * 把 `remote.settings` 适配成设置卡片要用的 scope 最小面（store 形状：
 * getSnapshot / subscribe / set）。
 *
 * 这是 0.1.7 的替代品：旧 `settingsScope.bind({namespace})` 返回的对象直接给
 * `SuggestGhostCard`。**形状以卡片的实际调用为准**（settings-card.tsx）：
 *  - getSnapshot：返回 {@link ScopeSnapshot} **信封**（`status` / `value` /
 *    `writable`），引用稳定——卡片拿它当 `useState` 初值，返回新对象会每次订阅
 *    都重渲染；
 *  - subscribe：内核转发 `settings/document-updated` 事件即通知（回调不传参，
 *    调用方重读快照）；
 *  - set：经 `mutate` 写单个 volatile 字段，返回 Promise 供卡片 `await`。
 *
 * ⚠️ **信封而非裸值**：卡片读的是 `snap.status` / `snap.value` / `snap.writable`，
 * 直接返回 `entry.value` 会让 `status` 恒 undefined、`writable` 恒 falsy——表现为
 * 设置页所有控件虽渲染但显示「当前部署不可写（内存模式）」、保存必然失败。
 * 两边都标注成 `Record<string, unknown>`（索引签名把两种形状都吞了），所以
 * TypeScript 不会替你发现这个错配，改动此处务必对照卡片源码。
 */
function remoteSettingsScope(
  remote: RemoteLike,
  ns: string,
): PluginSettingsScope<ScopeSnapshot> {
  // 快照引用稳定：只在 describe 真正拿到新 revision 时整体替换。
  let snapshot: ScopeSnapshot = { status: 'loading', value: {}, writable: false };
  let revision = -1;
  const listeners: Array<() => void> = [];
  let disposed = false;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // 单个订阅者抛错不牵连其余（与内核 store 的订阅语义一致）。
      }
    }
  };

  const readValue = (): void => {
    void (async () => {
      if (disposed) return;
      try {
        const described = await remote.settings?.describe();
        const doc = unwrapSettingsDoc(described);
        const entry = (doc?.namespaces ?? []).find((row) => row.ns === ns);
        if (entry === undefined) return;
        const rev = typeof entry.revision === 'number' ? entry.revision : 0;
        if (rev === revision) return;
        revision = rev;
        snapshot = {
          status: 'ready',
          value: (entry.value ?? {}) as Record<string, unknown>,
          // `writable` 是 describe() 的**外层**字段（整个设置文档可否写），
          // 不是命名空间条目的字段。缺省视为可写（旧宿主不带该字段）。
          writable: doc?.writable !== false,
        };
        notify();
      } catch {
        // 后端未就绪时保留现值，等下一个事件或调用方重试。
      }
    })();
  };

  // 启动即读一次（卡片 mount 时就能拿到真值，不必等首个事件）。
  readValue();
  // 此后由内核转发的设置变更事件驱动——**无轮询**。`$on` 返回的 disposer 归
  // `dispose()` 管（scope 与订阅者是多对一：单个订阅者退订不销毁 scope）。
  const offUpdated = remote.$on?.('settings/document-updated', () => readValue());

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.push(listener);
      // 退订**只移除这一个监听者**，绝不销毁 scope 本身。
      //
      // 踩过的坑：这里原本在退订时销毁了 scope（停掉其变更订阅），结果 React 卸载卡片时
      // （StrictMode 的挂载→卸载→再挂载、或用户切走设置页）scope 会永久失效，
      // `getSnapshot()` 永远停在 `status: 'loading'`、初始空值上——表现为所有控件
      // 都渲染成「当前部署不可写（内存模式）」且不显示任何真实取值。
      // scope 与订阅者是多对一关系，退订一个订阅者无权销毁它。
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    set: (key, next) => {
      const svc = remote.settings;
      if (svc === undefined) return Promise.resolve();
      // `expectedRevision` 必填：用最近一次 describe 拿到的 revision。
      // revision 尚未取到（仍为 -1）时先用 0；host 会以不匹配拒绝，宿主随后
      // 推来的事件会带回真值，用户重试即可，不会静默写坏数据。
      const expected = revision < 0 ? 0 : revision;
      return svc.mutate(ns, [{ op: 'set', path: [key], value: next }], expected)
        .then(() => {
          readValue();
        })
        .catch(() => {
          // 写入失败（revision 冲突/后端未就绪）：宿主随后推来的事件会带回真值。
        });
    },
    dispose: () => {
      disposed = true;
      offUpdated?.();
      listeners.length = 0;
    },
  };
}

function apply(ctx: Context): void {
  applyInner(ctx);
}

export { apply, inject, name };
