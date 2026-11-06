/**
 * 每回合回顾（session recap）：一个已完成回合结束后，用**这一回合自己的材料**
 * 生成一行「这轮之后什么变了」（结论 / 现在的状态 / 还差什么），显示在回复末尾
 * （turnTail 槽）；没有变化的回合由模型回哨兵，静默不显示。
 *
 * 与建议主链路（prediction.ts 的 fork + 官方提示词）的区别在输入：
 * 建议看的是「最近几轮对话，猜用户下一句」，回顾只看「这一轮发生了什么」——
 * 用户消息（问的是什么）、助手最终答复（结论是什么）、本回合的工具调用（真做了
 * 什么）。工具调用是回顾的核心证据：只读答复容易写出「他说他要做 X」而不是
 * 「X 已经改完了」。
 *
 * 回顾是**变化量的取舍**，不是过程摘要：问句写在材料末尾（「这一轮之后，什么
 * 变了？」），system 提示词保持用户定稿的三段不动；输出形状由 `fitRecap` 兜底
 * （剥元叙述、按标点断到 `maxChars` 内、无变化返回 `no_change`）。
 *
 * 有界：材料按字符预算截断（单条 user/助手/工具各一条上限 + 总预算），
 * 单次调用、不重试、可中止。失败静默（无回顾行），不阻塞任何主链路。
 * @module dsh-foresight/recap
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { TranscriptPair } from './transcript.js';
/** 回顾请求的截止错误码；与建议/预测分开，便于归因。 */
export declare const RECAP_TIMEOUT_CODE = "SUGGEST_GHOST_RECAP_TIMEOUT";
/** 生成回顾所需的最小配置面（从插件 Config 的 recap* 字段取）。 */
export interface RecapConfig {
    /** 最终一行回顾的字符上限（超出即截断）。 */
    readonly maxChars: number;
    /** 发给模型的材料总字符预算。 */
    readonly sourceChars: number;
    /** 单次调用超时（毫秒）。 */
    readonly timeoutMs: number;
    /** 输出令牌上限。 */
    readonly maxTokens: number;
    /** 显式路由；留空 = 继承会话请求头。 */
    readonly provider: string;
    readonly model: string;
    /** 留空 = 不发送该字段（provider 默认档）。 */
    readonly reasoningEffort: string;
}
/** 回顾失败的归因（只用于日志，不呈现给用户）。 */
export type RecapFailureReason = 'route_unavailable' | 'no_material' | 'empty_body' | 'tool_call' | 'abnormal_finish' | 'transport' | 'timeout' | 'cancelled';
/** 一回合的材料：模型看到的就是这段文本。 */
export interface RecapMaterial {
    /** 已框架化的用户提示（直接作为单条 user message 发送）。 */
    readonly framed: string;
    /** 本回合的材料统计（落盘展示 + 日志）。 */
    readonly turns: number;
    readonly toolCalls: number;
    /** 用于推断语言的角色-文本对（user/assistant）。 */
    readonly pairs: readonly TranscriptPair[];
}
/** 生成成功的结果。 */
export interface RecapSuccess {
    readonly kind: 'ok';
    /** 已清洗、已按 maxChars 截断的一行回顾。 */
    readonly text: string;
    /** 本回合工具调用数（落盘供展示/诊断）。 */
    readonly toolCalls: number;
}
/** 生成失败的终态。 */
export interface RecapFailure {
    readonly kind: 'failed';
    readonly reason: RecapFailureReason;
    /** 附加诊断（finish 种类、字符数等）。 */
    readonly detail?: string;
}
/**
 * 本回合没有变化：模型按材料里的约定回了哨兵。
 *
 * 不是失败——是「这一轮没有值得写下来的变化」，调用方应当静默跳过（不落库、
 * 不推送、不显示），这也正是「没变化的回合不显示回顾」的实现点。
 */
export interface RecapNoChange {
    readonly kind: 'no_change';
}
export type RecapResult = RecapSuccess | RecapNoChange | RecapFailure;
/**
 * 取指定回合（默认取最后一个已完成回合）的材料。
 *
 * 只扫一遍事件流：`turn/start` 切桶，`user/message`、`assistant/message`、
 * `tool/call`、`tool/result` 落桶。回合号对不上（例如事件流已被压缩、只剩结束
 * 事件）时退回「最后一个桶」——有材料总比没有强。
 * @param session - 目标会话。
 * @param turn - 期望的回合号；0 = 取最后一个已完成回合。
 * @param sourceChars - 材料总字符预算（超出按「助手答复 → 工具 → 用户」优先级裁）。
 */
export declare function buildRecapMaterial(session: Session, turn: number, sourceChars: number): RecapMaterial | undefined;
/**
 * 回顾的 system 提示词（用户 m00832 定稿，逐字照抄，不要自作主张加规则）。
 *
 * 只保留三段：角色与读者、最高要求。长度由 `generateRecap` 的 `clip()` 按
 * `recapMaxChars` 硬截断保证；输出语言跟随材料本身的会话语言（不做提示词约束）。
 * @param maxChars - 一行输出的字符上限（现由代码截断，提示词不再声明）。
 * @param language - 输出语言（现由材料自身带出，提示词不再声明）。
 */
export declare function recapSystemPrompt(maxChars: number, language: string): string;
/** 清洗模型输出：单行化、剥掉常见包装（引号/背引号/列表符/recap 前缀）。 */
export declare function cleanRecap(text: string): string;
/** 识别「这一轮没有变化」的回应（去空白与标点后比对，容忍模型多写句号）。 */
export declare function isNoChange(text: string): boolean;
/**
 * 剥掉开头的元叙述（「回顾这一轮：…」「这一轮把…」）。
 *
 * 主语应该是「变化」而不是「这场对话」，所以「回顾 / 总结 / 这一轮 / 本轮 …」
 * 这类开头逐层剥掉，最多三层。时间词（这一轮/本轮/本回合…）可直接剥；「回顾」
 * 「总结」这类词只有在后面紧跟标点/空白或再接一个时间词时才剥，否则「回顾开关」
 * 这种正常名词会被误伤。
 */
export declare function stripMetaOpening(text: string): string;
/**
 * 把模型输出整形到「一句、不超过 maxChars 个字」。
 *
 * 顺序：剥元叙述 → 够短就直接用 → 超长按标点就近断（保不住才硬截，按码点不劈
 * 代理对）→ 去句尾悬空标点。宁可短一句完整的，也不要长一句断掉的——这行字是
 * 提示，正文可以回看。
 */
export declare function fitRecap(text: string, maxChars: number): string;
/**
 * 材料末尾的「结论问题」：把注意力从「复述这一轮」扭到「这一轮之后什么变了」。
 *
 * 用户定稿的 system 提示词保持逐字不动，问句放在材料这一侧——这是①优化的落点：
 * 同样的提示词，问「解决了什么」得到摘要，问「变化了什么」得到变化量。
 * @param language - 会话语言（由材料推断；目前只区分英文与其它）。
 * @param maxChars - 一行回顾的字数上限（写进指令，降低超长概率）。
 */
export declare function recapQuestion(language: string, maxChars: number): string;
/**
 * 为一个已完成回合生成回顾。
 *
 * 单次调用、不重试（回顾是锦上添花，不值得为它翻倍计费）；可中止。
 * 材料为空（本回合没有可读事件）时直接返回失败，不发请求。
 * @param ctx - 宿主上下文（提供 `llm` 服务）。
 * @param config - 有界生成配置。
 * @param session - 父会话。
 * @param turn - 刚完成的回合号（0 = 自动取最后一个）。
 * @param signal - 外部中止信号（新回合开始/卸载/会话销毁）。
 */
export declare function generateRecap(ctx: Context, config: RecapConfig, session: Session, turn: number, signal: AbortSignal): Promise<RecapResult>;
