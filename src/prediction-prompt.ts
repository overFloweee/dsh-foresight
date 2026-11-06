/**
 * 官方输入预测对齐（切片 1）的请求文本与消息面构造：
 * 固定 prompt_version=5 原文 + JSON schema 文本要求，并在父消息快照末尾追加一次预测 user 消息。
 *
 * 为什么独立成模块：提示词是「取证原文」，解析契约（schema）与脱敏投影是两件正交的事，
 * 放进生成路径会让逐字文本被后续逻辑改动而无人察觉；这里只做纯数据与纯函数，便于逐字核对。
 * @module dsh-foresight/prediction-prompt
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Message } from '@deepseek-ai/dsh-llm';
import { redactSecrets } from './sanitize.js';

/**
 * 提示词/schema/解析语义的配方版本：上述任一项语义变化时手工 +1（非用户配置项）。
 *
 * 为什么要有它：缓存与结果都按「同一配方」才可比。逐字文本或解析口径悄悄变了却沿用旧版本号，
 * 会让旧结果被误判为同一契约下的有效输出。改文本 ⇒ 必须同时改这里。
 */
export const PREDICTION_RECIPE_VERSION = 1;

/**
 * 官方已取证的 prompt_version=5 原文（4 段，段间空行），逐字，不得改写、不得增删标点。
 *
 * 逐字来源：`docs/官方输入预测-技术方案.md` 第 157-163 行（代码块内），
 * 经 `sed -n` + `od -c` 逐字节核对为纯 ASCII、无智能标点、无行尾空白，故此处以字符串字面量原样承载。
 */
export const PREDICTION_PROMPT_V5 = `This is an app-generated request for a suggested next user message. The user did not write this message.

Your suggestion will appear in the user's empty message composer. They can accept it, edit it, or ignore it; it will not be sent automatically.

Predict the single message this user is most likely to type next from the visible conversation. Use the whole conversation to understand their current intent and the latest exchange. Choose the action and specific object that best continue that intent, rather than a generally useful follow-up. Express its core naturally in the user's voice, keeping the requirements needed to retain its meaning. Choose the strongest grounded move even if several continuations are possible; uncertainty about exact wording or incidental details is not a reason to return null. Use null only when the conversation offers no grounded next move at all.

Set suggestion to exactly one natural user message, one line, at most 240 characters, or null. No alternatives or explanation.`;

/**
 * 追加的 JSON schema 要求，逐字（单段整句，无换行）。
 *
 * 逐字来源：同文档第 169 行。注意这只是**文本约束**——本轮未捕获官方线上最终字符串，
 * 故本地仍需按同一 schema 自行解析校验，不能当服务端 structured output 强制。
 */
export const PREDICTION_SCHEMA_INSTRUCTION =
  'Return only JSON matching this schema: {"type":"object","properties":{"suggestion":{"type":["string","null"]}},"required":["suggestion"],"additionalProperties":false}.';

/**
 * 本次请求追加的完整文本：提示词 + 空行 + schema 要求。
 *
 * 为什么用空行分隔：官方形态是「提示词正文」与「附加约束」两段，直接拼接会让末句与
 * schema 指令黏成一句，改变模型看到的段落边界。
 * @returns 追加到父消息面末尾的 user 文本。
 */
export function predictionRequestText(): string {
  return `${PREDICTION_PROMPT_V5}\n\n${PREDICTION_SCHEMA_INSTRUCTION}`;
}

/** `content` 可能是字符串或块数组的最小结构形状：只声明本模块真正读写的字段。 */
interface ContentShape {
  readonly content?: unknown;
}

/** 仅取 `text` 字段的块形状：避免为每种已知块类型各写一条分支。 */
interface TextCarrier {
  readonly text?: unknown;
}

/**
 * 递归到 `content` 为块数组时，只对本层 `type === 'text'` 的块的 `text` 脱敏。
 *
 * 为什么只脱敏 text 块：tool-call / tool-result 块的 id、名称、参数结构是父消息与工具调用的
 * 关联骨架，改写它们会破坏后续投影与因果链（规范 §4.1 第 134 行）。
 * 未知块类型与附件块一律原样透传——本模块的职责是「不破坏」，是否可正确投影由上游判定，
 * 不在这里偷偷删块后宣称完整继承。
 * 为什么可以原样返回：入参消息来自会话日志，可能已被 `deepFreeze`；这里只读不写，
 * 仅在实际改动了文本时才构造新对象。
 * @param block - 单个内容块（未知类型视为不透明）。
 * @returns 脱敏后的块；无需改动时返回传入的同一引用。
 */
function redactBlock(block: unknown): unknown {
  // 只认「对象 + type 为字符串 + text 为字符串」这一种可安全改写的形状；
  // `type` 必须严格等于 'text'，reasoning / tool-call 等其他带 text 的块不动。
  if (typeof block !== 'object' || block === null) return block;
  const candidate = block as ContentShape & TextCarrier & { readonly type?: unknown };
  if (candidate.type !== 'text' || typeof candidate.text !== 'string') return block;
  const redacted = redactSecrets(candidate.text);
  // 复制块并只替换 text：保留块上可能存在的其它字段（如未来的扩展标记）。
  return redacted === candidate.text ? block : { ...candidate, text: redacted };
}

/**
 * 复制一条消息，并对其文本内容脱敏（字符串 content 整体脱敏；块数组只脱敏 text 块）。
 * @param message - 父消息面中的一条消息。
 * @returns 浅复制的消息；无可脱敏文本时内容保持原引用。
 */
function redactMessageText(message: Message): Message {
  const { content } = message as Message & ContentShape;
  if (typeof content === 'string') {
    // 兼容字符串形态的 content：类型上 Message 只声明块数组，但运行时新旧内核都有可能出现，
    // 按字符串处理总比按索引遍历一个字符串更安全。
    const redacted = redactSecrets(content);
    return redacted === content ? message : { ...message, content: redacted } as unknown as Message;
  }
  if (!Array.isArray(content)) return message;
  // 先判定是否真有块被改写：无改动时返回原消息，避免无谓地重建整条消息面。
  const blocks = content as ReadonlyArray<unknown>;
  const redactedBlocks = blocks.map(redactBlock);
  if (redactedBlocks.every((block, index) => block === blocks[index])) return message;
  return { ...message, content: redactedBlocks } as unknown as Message;
}

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
export function appendPredictionRequest(messages: readonly Message[]): Message[] {
  // 追加消息的 source 只用于构造一次性请求载荷（不落会话日志），故取 5 代内核都存在且与
  // `src/generate.ts` 第 426-429 行同形的 `{ kind: 'user' }`。
  const request: Message = createUserMessage({
    content: [{ type: 'text', text: predictionRequestText() }],
    source: { kind: 'user' },
  });
  return [...messages.map(redactMessageText), request];
}
