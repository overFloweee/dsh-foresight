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
import type { Session } from '@deepseek-ai/dsh-session';
import type { PredictionSourceRead } from './prediction-source.js';
/** 预测请求的截止错误码；与旧建议路径的 `SUGGEST_GHOST_TIMEOUT` 分开，便于归因。 */
export declare const PREDICTION_TIMEOUT_CODE = "SUGGEST_GHOST_PREDICTION_TIMEOUT";
/** 触发来源：live = 父回合完成事件；catch_up = 打开/重连后的状态 pull。 */
export type PredictionTrigger = 'live' | 'catch_up';
/** 预测结束态。`abstained` 是模型明确说「没有下一步」，不是失败。 */
export type PredictionOutcome = 'suggested' | 'abstained' | 'failed' | 'cancelled';
/**
 * 失败/取消的具体原因。区分粒度按规范 §5 的结果表：
 * 空正文 / 非 JSON / 形状不符 / 工具调用 / 非正常结束 / 传输失败 / 超时 /
 * 路由不可用 / fork 失败 / 资格不足 / 生成期间源身份变化。
 */
export type PredictionFailureReason = 'empty_body' | 'invalid_json' | 'schema_mismatch' | 'tool_call' | 'abnormal_finish' | 'transport' | 'timeout' | 'route_unavailable' | 'fork_failed' | 'ineligible' | 'stale_source';
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
export type ParsedPredictionOutput = {
    readonly kind: 'suggested';
    readonly text: string;
} | {
    readonly kind: 'abstained';
} | {
    readonly kind: 'failed';
    readonly reason: PredictionFailureReason;
};
/**
 * 解析模型输出。按官方语义：外层 JSON 必须是 `{"suggestion": string|null}` 且无多余字段
 * （对应 schema 的 `additionalProperties:false`）；合法字符串**只做 trim**，空串视为
 * `null`（abstained）；换行与长度都不在这里处理。
 */
export declare function parsePredictionOutput(text: string): ParsedPredictionOutput;
/** 预测分支的 session id；随机后缀保证同一源回合的多次请求互不撞名。 */
export declare function predictionChildIdOf(sessionId: string, turn: number, endSeq: number): string;
/** 事件入口用：该会话是否本插件预测分支（分支的 turn/end 不得再次触发预测）。 */
export declare function isPredictionChildSession(sessionId: string): boolean;
/** 诊断与测试用：在途预测分支数量。 */
export declare function livePredictionChildCount(): number;
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
export declare class PredictionFlight {
    private readonly inFlight;
    startOrReuse(key: string, start: () => Promise<PredictionResult>): PredictionFlightStart;
    /**
     * 撤销一次登记（规范 §3.3）：作废（新回合开始/开关关闭/配置变更/会话销毁）与
     * 采纳消费时调用。被撤销的 flight 不得再被复用——否则「关掉预测再打开」会对同一
     * 源回合复用那条已取消的旧流，旧流结束时又把 `cancelled` 写成可命中的终态缓存，
     * 于是模型调用次数永远是 1、重新开启后一直没有建议（独立复核反例 #5）。
     * 旧 promise 的 finally 仍会执行，但 `inFlight.get(key) === tracked` 已不成立，
     * 不会误删后来接手的新登记。
     */
    forget(key: string): void;
    /** 诊断与测试用：在途请求数量。 */
    get size(): number;
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
/**
 * 执行一次预测（切片 1 的生成接入）。所有失败路径都返回结果对象，不抛异常；
 * 唯一必须保证的是资源释放：fork 成功与否都在 finally 里 dispose 并移除子会话身份。
 */
export declare function runPrediction(ctx: Context, options: PredictionRunOptions): Promise<PredictionResult>;
