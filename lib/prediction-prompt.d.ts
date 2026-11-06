/**
 * 官方输入预测对齐（切片 1）的请求文本与消息面构造：
 * 固定 prompt_version=5 原文 + JSON schema 文本要求，并在父消息快照末尾追加一次预测 user 消息。
 *
 * 为什么独立成模块：提示词是「取证原文」，解析契约（schema）与脱敏投影是两件正交的事，
 * 放进生成路径会让逐字文本被后续逻辑改动而无人察觉；这里只做纯数据与纯函数，便于逐字核对。
 * @module dsh-foresight/prediction-prompt
 */
import type { Message } from '@deepseek-ai/dsh-llm';
/**
 * 提示词/schema/解析语义的配方版本：上述任一项语义变化时手工 +1（非用户配置项）。
 *
 * 为什么要有它：缓存与结果都按「同一配方」才可比。逐字文本或解析口径悄悄变了却沿用旧版本号，
 * 会让旧结果被误判为同一契约下的有效输出。改文本 ⇒ 必须同时改这里。
 */
export declare const PREDICTION_RECIPE_VERSION = 1;
/**
 * 官方已取证的 prompt_version=5 原文（4 段，段间空行），逐字，不得改写、不得增删标点。
 *
 * 逐字来源：`docs/官方输入预测-技术方案.md` 第 157-163 行（代码块内），
 * 经 `sed -n` + `od -c` 逐字节核对为纯 ASCII、无智能标点、无行尾空白，故此处以字符串字面量原样承载。
 */
export declare const PREDICTION_PROMPT_V5 = "This is an app-generated request for a suggested next user message. The user did not write this message.\n\nYour suggestion will appear in the user's empty message composer. They can accept it, edit it, or ignore it; it will not be sent automatically.\n\nPredict the single message this user is most likely to type next from the visible conversation. Use the whole conversation to understand their current intent and the latest exchange. Choose the action and specific object that best continue that intent, rather than a generally useful follow-up. Express its core naturally in the user's voice, keeping the requirements needed to retain its meaning. Choose the strongest grounded move even if several continuations are possible; uncertainty about exact wording or incidental details is not a reason to return null. Use null only when the conversation offers no grounded next move at all.\n\nSet suggestion to exactly one natural user message, one line, at most 240 characters, or null. No alternatives or explanation.";
/**
 * 追加的 JSON schema 要求，逐字（单段整句，无换行）。
 *
 * 逐字来源：同文档第 169 行。注意这只是**文本约束**——本轮未捕获官方线上最终字符串，
 * 故本地仍需按同一 schema 自行解析校验，不能当服务端 structured output 强制。
 */
export declare const PREDICTION_SCHEMA_INSTRUCTION = "Return only JSON matching this schema: {\"type\":\"object\",\"properties\":{\"suggestion\":{\"type\":[\"string\",\"null\"]}},\"required\":[\"suggestion\"],\"additionalProperties\":false}.";
/**
 * 本次请求追加的完整文本：提示词 + 空行 + schema 要求。
 *
 * 为什么用空行分隔：官方形态是「提示词正文」与「附加约束」两段，直接拼接会让末句与
 * schema 指令黏成一句，改变模型看到的段落边界。
 * @returns 追加到父消息面末尾的 user 文本。
 */
export declare function predictionRequestText(): string;
/**
 * 复制父消息面 + 文本脱敏 + 末尾追加**一条** user 文本消息（内容 = `predictionRequestText()`）。
 *
 * 为什么不改入参：快照可能被父会话或其它并发切片共享，原地改写会让「一次预测请求」的局部
 * 修改泄漏到父日志与其它读者；这里逐条浅复制消息、块数组按需复制、文本块按需复制。
 *
 * 注意（规范 §4.1 第 134 行）：真实用户输入与系统/工具来源的文本按同一套正则脱敏，
 * 因为它们在本次请求里都会被外发；本模块不负责区分口吻来源，也不宣称正则覆盖全部秘密。
 * 附件或未知块无法正确投影时应由上游明确失败，这里不做删块也不做判定。
 * @param messages - fork 得到的有效消息面快照。
 * @returns 新的消息数组（末位是本次预测请求 user 消息）；入参数组与元素均未被修改。
 */
export declare function appendPredictionRequest(messages: readonly Message[]): Message[];
