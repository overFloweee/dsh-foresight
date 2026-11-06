/**
 * 官方输入预测对齐（切片 1：生成接入）。
 *
 * 主链路（与 `docs/官方输入预测-技术方案.md` §1/§3/§4 对应）：
 *   读源投影 → 短作用域内 fork 父会话（含端点 endSeq）→ 继承有效消息面与父路由
 *   → 追加官方 v5 提示词 → 单次 `ctx.llm.stream()` → 本地解析 `{suggestion: string|null}`
 *   → finally 释放作用域与子会话身份。
 *
 * 与既有 `generate.ts` 建议路径的关键差别（旧路径保持不动，供历史行为使用）：
 *   - 不做转录拼装、不做轮数/字符裁剪、不用插件自带 system 提示词；
 *   - 不重试（规范 §4.2：默认一次调用，格式错误/null/超时都不自动重试）；
 *   - 请求细节不写入父会话日志，只作为一次请求载荷与返回值；
 *   - 解析按官方语义：合法字符串仅 trim，多行或超过 240 字符保留原文，不截断、不判失败。
 *
 * 本模块不触发、不缓存、不推送：触发与传输在切片 2 接入。手工调用入口是
 * `runPrediction`，`PredictionFlight` 提供「同键复用」的同步登记语义。
 * @module dsh-foresight/prediction
 */

import type { Context } from '@deepseek-ai/cordis';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import type {
  FinishReason,
  GenerateOptions,
  Message,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import { deadline } from '@deepseek-ai/dsh-timeout';
import { appendPredictionRequest } from './prediction-prompt.js';
import type { PredictionSourceRead } from './prediction-source.js';

/** 预测请求的截止错误码；与旧建议路径的 `SUGGEST_GHOST_TIMEOUT` 分开，便于归因。 */
export const PREDICTION_TIMEOUT_CODE = 'SUGGEST_GHOST_PREDICTION_TIMEOUT';

/** 预测分支的会话 id 前缀：用于把插件自己创建的分支从事件入口排除（规范 §3.2）。 */
const PREDICTION_CHILD_PREFIX = 'dsh-foresight/prediction/';

/** 触发来源：live = 父回合完成事件；catch_up = 打开/重连后的状态 pull。 */
export type PredictionTrigger = 'live' | 'catch_up';

/** 预测结束态。`abstained` 是模型明确说「没有下一步」，不是失败。 */
export type PredictionOutcome = 'suggested' | 'abstained' | 'failed' | 'cancelled';

/**
 * 失败/取消的具体原因。区分粒度按规范 §5 的结果表：
 * 空正文 / 非 JSON / 形状不符 / 工具调用 / 非正常结束 / 传输失败 / 超时 /
 * 路由不可用 / fork 失败 / 资格不足 / 生成期间源身份变化。
 */
export type PredictionFailureReason =
  | 'empty_body'
  | 'invalid_json'
  | 'schema_mismatch'
  | 'tool_call'
  | 'abnormal_finish'
  | 'transport'
  | 'timeout'
  | 'route_unavailable'
  | 'fork_failed'
  | 'ineligible'
  | 'stale_source';

/** 一次预测的完整结果；失败也返回结果对象，不抛异常（取消记 `cancelled`）。 */
export interface PredictionResult {
  readonly requestId: string;
  readonly sessionId: string;
  readonly turn: number | null;
  readonly endSeq: number | null;
  readonly trigger: PredictionTrigger;
  readonly outcome: PredictionOutcome;
  /** 仅 `suggested` 有值；`abstained`/失败/取消均为 null。 */
  readonly suggestion: string | null;
  readonly reason?: PredictionFailureReason;
  readonly provider?: string;
  readonly model?: string;
  /** 实际生效的推理档：显式覆盖优先，否则父请求头里的档位，都没有则该字段缺席。 */
  readonly reasoningEffort?: string;
  /** 失败诊断：结束原因 + 正文长度 + 开头片段。只用于事后定位，不参与判定。 */
  readonly detail?: string;
  readonly durationMs: number;
}

/** 本地解析结果（规范 §5 结果表的输入侧）。 */
export type ParsedPredictionOutput =
  | { readonly kind: 'suggested'; readonly text: string }
  | { readonly kind: 'abstained' }
  | { readonly kind: 'failed'; readonly reason: PredictionFailureReason };

/**
 * 解析模型输出。按官方语义：外层 JSON 必须是 `{"suggestion": string|null}` 且无多余字段
 * （对应 schema 的 `additionalProperties:false`）；合法字符串**只做 trim**，空串视为
 * `null`（abstained）；换行与长度都不在这里处理。
 */
export function parsePredictionOutput(text: string): ParsedPredictionOutput {
  const body = text.trim();
  if (body.length === 0) return { kind: 'failed', reason: 'empty_body' };
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    return { kind: 'failed', reason: 'invalid_json' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'failed', reason: 'schema_mismatch' };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const first = entries[0];
  if (entries.length !== 1 || first === undefined || first[0] !== 'suggestion') {
    return { kind: 'failed', reason: 'schema_mismatch' };
  }
  const suggestion = first[1];
  if (suggestion === null) return { kind: 'abstained' };
  if (typeof suggestion !== 'string') return { kind: 'failed', reason: 'schema_mismatch' };
  const trimmed = suggestion.trim();
  if (trimmed.length === 0) return { kind: 'abstained' };
  return { kind: 'suggested', text: trimmed };
}

/** 预测分支的 session id；随机后缀保证同一源回合的多次请求互不撞名。 */
export function predictionChildIdOf(sessionId: string, turn: number, endSeq: number): string {
  const nonce = Math.random().toString(36).slice(2, 10);
  return `${PREDICTION_CHILD_PREFIX}${sessionId}/${String(turn)}/${String(endSeq)}/${nonce}`;
}

const predictionChildren = new Set<string>();

/** 事件入口用：该会话是否本插件预测分支（分支的 turn/end 不得再次触发预测）。 */
export function isPredictionChildSession(sessionId: string): boolean {
  return predictionChildren.has(sessionId);
}

/** 诊断与测试用：在途预测分支数量。 */
export function livePredictionChildCount(): number {
  return predictionChildren.size;
}

/** `PredictionFlight.startOrReuse` 的返回值。 */
export interface PredictionFlightStart {
  readonly reused: boolean;
  readonly result: Promise<PredictionResult>;
}

/**
 * 同键请求登记表（规范 §3.1 表格：已有在途 → 复用，不新建 fork 或 LLM 调用）。
 *
 * `startOrReuse` 是**同步**方法：登记发生在任何 `await` 之前，因此 live 与 catch_up
 * 谁先到达谁生成，另一路复用同一次模型调用。终态缓存属于切片 2（传输层），本类只
 * 负责在途去重。
 */
export class PredictionFlight {
  private readonly inFlight = new Map<string, Promise<PredictionResult>>();

  startOrReuse(key: string, start: () => Promise<PredictionResult>): PredictionFlightStart {
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return { reused: true, result: existing };
    const result = start();
    // 只有仍属于本次登记的 promise 才清理，避免键被新请求接手后被旧回调误删。
    const tracked = result.finally(() => {
      if (this.inFlight.get(key) === tracked) this.inFlight.delete(key);
    });
    this.inFlight.set(key, tracked);
    return { reused: false, result: tracked };
  }

  /**
   * 撤销一次登记（规范 §3.3）：作废（新回合开始/开关关闭/配置变更/会话销毁）与
   * 采纳消费时调用。被撤销的 flight 不得再被复用——否则「关掉预测再打开」会对同一
   * 源回合复用那条已取消的旧流，旧流结束时又把 `cancelled` 写成可命中的终态缓存，
   * 于是模型调用次数永远是 1、重新开启后一直没有建议（独立复核反例 #5）。
   * 旧 promise 的 finally 仍会执行，但 `inFlight.get(key) === tracked` 已不成立，
   * 不会误删后来接手的新登记。
   */
  forget(key: string): void {
    this.inFlight.delete(key);
  }

  /** 诊断与测试用：在途请求数量。 */
  get size(): number {
    return this.inFlight.size;
  }
}

/** 父请求头里的路由字段（跨代结构视图：只读我们真正用到的三个字段）。 */
interface PredictionRouteView {
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly reasoningEffort?: unknown;
}

interface PredictionForkView {
  readonly id: string;
  deriveMessages(): readonly Message[];
  requestHeader(): { readonly config?: PredictionRouteView } | undefined;
}

interface ForkCapableSessionsView {
  fork(source: Session, boundary?: unknown, childSessionId?: string): PredictionForkView;
}

interface ForkScopeView {
  readonly ctx: Context;
  dispose(): Promise<void>;
}

/** `runPrediction` 的入参。 */
export interface PredictionRunOptions {
  readonly session: Session;
  /** 由 `installPredictionSource(ctx).read(session)` 得到的合格源身份。 */
  readonly source: PredictionSourceRead;
  readonly trigger: PredictionTrigger;
  readonly signal: AbortSignal;
  readonly maxOutputTokens: number;
  /** 本次请求的总等待预算（规范 §4.2：复用 timeoutMs，但语义是整次预测的预算）。 */
  readonly timeoutMs: number;
  /** 显式推理档覆盖；空串或未设 = 继承父请求头档位，父值也缺则交给 provider 默认。 */
  readonly reasoningEffort?: string;
  /** 生成后复核源身份仍然合格（规范 §3.1 第 75 行）；返回 false 记为 stale_source。 */
  readonly revalidate?: (() => boolean) | undefined;
}

interface ResultBase {
  readonly requestId: string;
  readonly sessionId: string;
  readonly turn: number | null;
  readonly endSeq: number | null;
  readonly trigger: PredictionTrigger;
}

interface RouteInfo {
  readonly provider?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
}

/** 路由字段按「有值才出现」的方式写入结果，避免把 undefined 混进可选字段。 */
function routeInfo(input: { provider?: string; model?: string; reasoningEffort?: string }): RouteInfo {
  const out: { provider?: string; model?: string; reasoningEffort?: string } = {};
  if (input.provider !== undefined && input.provider.length > 0) out.provider = input.provider;
  if (input.model !== undefined && input.model.length > 0) out.model = input.model;
  if (input.reasoningEffort !== undefined && input.reasoningEffort.length > 0) {
    out.reasoningEffort = input.reasoningEffort;
  }
  return out;
}

function failedResult(
  base: ResultBase,
  reason: PredictionFailureReason,
  startedAt: number,
  route: RouteInfo = {},
  detail?: string,
): PredictionResult {
  return {
    ...base,
    outcome: 'failed',
    suggestion: null,
    reason,
    ...route,
    ...(detail === undefined || detail.length === 0 ? {} : { detail }),
    durationMs: Date.now() - startedAt,
  };
}

/**
 * 失败诊断串：只留定位所需的最小信息——结束原因、正文长度、正文开头 160 字符。
 * `abnormal_finish` 这类失败事后只剩一个字符串，没有它就无法区分「模型跑题写长了」
 * 「输出被预算截断」与「返回了别的形状」。
 */
function outputDetail(finish: FinishReason, text: string): string {
  const head = text.slice(0, 160).replace(/\s+/g, ' ');
  return `finish=${finish.kind} chars=${String(text.length)} head=${JSON.stringify(head)}`;
}

function cancelledResult(base: ResultBase, startedAt: number, route: RouteInfo = {}): PredictionResult {
  return {
    ...base,
    outcome: 'cancelled',
    suggestion: null,
    ...route,
    durationMs: Date.now() - startedAt,
  };
}

function abstainedResult(base: ResultBase, startedAt: number, route: RouteInfo = {}): PredictionResult {
  return {
    ...base,
    outcome: 'abstained',
    suggestion: null,
    ...route,
    durationMs: Date.now() - startedAt,
  };
}

function suggestedResult(
  base: ResultBase,
  text: string,
  startedAt: number,
  route: RouteInfo = {},
): PredictionResult {
  return {
    ...base,
    outcome: 'suggested',
    suggestion: text,
    ...route,
    durationMs: Date.now() - startedAt,
  };
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 结束原因 → 失败原因。`stop` 之外的正常结束都不是成功文本（规范 §4.3）：
 * max-tokens 记 abnormal_finish，tool-calls 记 tool_call，error/aborted 记 transport
 * （外部取消由调用方在 catch 里先判成 cancelled）。
 */
function finishFailureOf(finish: FinishReason): PredictionFailureReason | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined;
    case 'tool-calls':
      return 'tool_call';
    case 'max-tokens':
      return 'abnormal_finish';
    case 'error':
    case 'aborted':
      return 'transport';
    /* v8 ignore next 2 -- FinishReason 是封闭五元联合，默认分支不可达 */
    default:
      return 'abnormal_finish';
  }
}

/** 短作用域：fork 归它所有，dispose 时子会话从 live store 移除（父会话不受影响）。 */
function createForkScope(ctx: Context): ForkScopeView {
  const factory = ctx as unknown as { plugin(callback: () => void): ForkScopeView };
  return factory.plugin(() => {});
}

type AssembledBlock = ReturnType<BlockAssembler['blocks']>[number];

function isTextBlock(block: AssembledBlock): block is Extract<AssembledBlock, { type: 'text' }> {
  return block.type === 'text';
}

/**
 * 执行一次预测（切片 1 的生成接入）。所有失败路径都返回结果对象，不抛异常；
 * 唯一必须保证的是资源释放：fork 成功与否都在 finally 里 dispose 并移除子会话身份。
 */
export async function runPrediction(
  ctx: Context,
  options: PredictionRunOptions,
): Promise<PredictionResult> {
  const startedAt = Date.now();
  const { session, source, trigger } = options;
  const childId = predictionChildIdOf(session.id, source.turn, source.endSeq);
  const base: ResultBase = {
    requestId: childId,
    sessionId: session.id,
    turn: source.turn,
    endSeq: source.endSeq,
    trigger,
  };
  // 防御：绝不基于我们自己的分支再生成（事件入口已有同源过滤，这里是第二道）。
  if (isPredictionChildSession(session.id)) return failedResult(base, 'ineligible', startedAt);

  predictionChildren.add(childId);
  let scope: ForkScopeView | undefined;
  try {
    scope = createForkScope(ctx);
    const sessions = (scope.ctx as unknown as { sessions?: ForkCapableSessionsView }).sessions;
    if (sessions === undefined || typeof sessions.fork !== 'function') {
      return failedResult(base, 'fork_failed', startedAt);
    }
    let fork: PredictionForkView;
    try {
      fork = sessions.fork(session, source.endSeq, childId);
    } catch {
      // 父会话不存在/边界失效/子 id 撞名：记录具体失败，不新建无历史会话替代。
      return failedResult(base, 'fork_failed', startedAt);
    }
    const route = fork.requestHeader()?.config;
    const provider = textOf(route?.provider);
    const model = textOf(route?.model);
    const override = options.reasoningEffort?.trim() ?? '';
    const inherited = textOf(route?.reasoningEffort).trim();
    const reasoningEffort = override.length > 0 ? override : inherited;
    if (provider.length === 0 || model.length === 0) {
      return failedResult(base, 'route_unavailable', startedAt, routeInfo({ reasoningEffort }));
    }

    const messages = appendPredictionRequest(fork.deriveMessages());
    // 每次预测一个截止时间：timeoutMs 是整次预测的预算，不是三次重试的总和。
    using callDeadline = deadline(options.signal, options.timeoutMs, PREDICTION_TIMEOUT_CODE);
    const llmOptions: GenerateOptions = {
      provider,
      model,
      // 空串 = 字段缺席：内核据此回落到 provider 默认档。
      ...(reasoningEffort.length === 0 ? {} : { reasoningEffort: reasoningEffort as ReasoningEffortId }),
      messages,
      // 不接工具面：保留历史调用/结果（在消息面里）与禁止新工具执行是两件事。
      tools: [],
      maxTokens: options.maxOutputTokens,
      sessionId: fork.id as GenerateOptions['sessionId'],
      signal: callDeadline.signal,
    };

    const info = routeInfo({ provider, model, reasoningEffort });
    let finish: FinishReason;
    let blocks: readonly AssembledBlock[];
    try {
      const assembler = new BlockAssembler();
      for await (const chunk of ctx.llm.stream(llmOptions)) {
        callDeadline.signal.throwIfAborted();
        assembler.push(chunk);
      }
      callDeadline.signal.throwIfAborted();
      finish = assembler.finish;
      blocks = assembler.blocks();
    } catch {
      if (options.signal.aborted) return cancelledResult(base, startedAt, info);
      if (callDeadline.signal.aborted) return failedResult(base, 'timeout', startedAt, info);
      return failedResult(base, 'transport', startedAt, info);
    }

    // JSON 是单条文本，多个文本块直接相接，不插空格。诊断也要用它，故先算出来。
    const text = blocks.filter(isTextBlock).map(block => block.text).join('');
    const detail = outputDetail(finish, text);
    const finishFailure = finishFailureOf(finish);
    if (finishFailure !== undefined) {
      return failedResult(base, finishFailure, startedAt, info, detail);
    }
    if (blocks.some(block => block.type === 'tool-call')) {
      return failedResult(base, 'tool_call', startedAt, info, detail);
    }
    const parsed = parsePredictionOutput(text);
    if (parsed.kind === 'failed') {
      return failedResult(base, parsed.reason, startedAt, info, detail);
    }
    // 生成期间源身份变化：不使用变动后的历史补偿旧请求。
    if (options.revalidate !== undefined && !options.revalidate()) {
      return failedResult(base, 'stale_source', startedAt, info);
    }
    if (parsed.kind === 'abstained') return abstainedResult(base, startedAt, info);
    return suggestedResult(base, parsed.text, startedAt, info);
  } finally {
    if (scope !== undefined) {
      try {
        await scope.dispose();
      } catch {
        // 释放失败不改变预测结果；宿主会在会话 disposed 时自行清理登记。
      }
    }
    // 作用域释放完成后才移除身份：disposed 期间产生的事件同样受过滤。
    predictionChildren.delete(childId);
  }
}
