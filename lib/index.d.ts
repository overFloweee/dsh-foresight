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
import type { Config as GenerateConfig } from './generate.js';
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
declare const ConfigSchema: z<Schemastery.ObjectS<NoInfer<{
    /** LLM 下一条建议开关（默认开）；关闭后每回合不再调用建议模型。 */
    llmEnabled: z<boolean, boolean, "volatile-defined">;
    /**
     * 每回合回顾开关（默认开）。回合完成后，用这一回合自己的材料生成一行「这轮做了
     * 什么」显示在回复末尾；关闭后不再生成，已生成的回顾保留。
     */
    recapEnabled: z<boolean, boolean, "volatile-defined">;
    /** 是否启用历史前缀补全。 */
    historyEnabled: z<boolean, boolean, "volatile-defined">;
    /** 是否跨会话搜索历史（false = 仅当前会话）。 */
    historyCrossSession: z<boolean, boolean, "volatile-defined">;
    /** 历史补全最多参考的历史条目数（0 = 不限）。 */
    historyMaxEntries: z<number, number, "volatile-defined">;
    /** 草稿至少输入多少字符才触发历史补全。 */
    historyMinChars: z<number, number, "volatile-defined">;
    /** 幽灵显示时允许 → 逐词采纳。 */
    wordAccept: z<boolean, boolean, "volatile-defined">;
    /** 采纳建议的输入框快捷键（默认 Tab）。 */
    acceptKey: z<string, string, "volatile-defined">;
    /**
     * client → host 的热度管理操作队列（JSON 字符串）。
     *
     * 0.1.7 的 `SettingsForms.write()` 只接受 volatile 路径（`isVolatilePath`
     * 校验，非 volatile 直接抛错），所以这个反向通道字段本身也必须标 volatile。
     * 消费后立即写回空串：清空既是「已消费」信号，也防陈旧操作在重启后重放
     * （如陈旧的 clear 把新数据清掉）。操作幂等，host 不依赖 rev 去重。
     */
    _ops: z<string, string, "volatile-defined">;
    /**
     * host → client 的实时推送载荷（JSON 字符串），同上必须标 volatile 才能写入。
     * 结构与 0.1.5 时代完全一致（见 settings.ts 的 `GhostPushPayload`），故 client
     * 侧的解析与 `*SessionId` 归属守卫无需改动——变的只是字段载体。
     */
    _push: z<string, string, "volatile-defined">;
    /**
     * 最终框架化用户提示的最大 UTF-8 字节数。4096 是「装得下一轮中文对话」的量级，
     * 但 3 轮真实对话实测要 8～9 KB（中文 1 字 = 3 字节）⇒ 默认抬到 16384，让
     * `maxRecentTurns: 3` 真的装得下；调小它会把窗口裁回 1～2 轮。
     */
    maxInputBytes: z<number, number, "defined">;
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
    maxOutputTokens: z<number, number, "defined">;
    /** 辅助请求端到端截止时间（毫秒）。 */
    timeoutMs: z<number, number, "defined">;
    /**
     * 转录尾部保留的最近完成回合数（默认 3）。实测：只给 1 轮时模型 4/4 次给不出
     * 建议（界面什么都不显示），给 2～3 轮才稳定给出——它需要看到跨轮的模式。
     * 轮数受 `maxInputBytes` 约束，调大轮数时记得同步抬字节预算。
     */
    maxRecentTurns: z<number, number, "defined">;
    /** 转录字符预算（与 `maxInputBytes` 配套：3 轮中文对话约 3 千字符，留足余量）。 */
    maxTranscriptChars: z<number, number, "defined">;
    /** 建议可见字符上限。 */
    maxSuggestionChars: z<number, number, "defined">;
    /**
     * 显式路由对（**迁移期兼容字段**）。预测主链路的候选资格判据是「父会话有请求头」
     * （`session.requestHeader()`），路由继承自预测 fork 自己的请求头（规范 §4.2），
     * 不再要求这里配置；这两个字段只保留给仍在使用旧建议路径的 profile。
     * `z.string().default('')` 而非 `min(1)`：留空表示「继承」，若必填会把插件逼成
     * 「不填就不能启动」。
     */
    provider: z<string, string, "defined">;
    model: z<string, string, "defined">;
    /**
     * 预测请求的推理档覆盖。**留空 = 继承父会话档**（规范 §4.2）：预测 fork 的请求头
     * 自带父会话的 provider/model/reasoningEffort，这里只在用户显式配置时才覆盖。
     * 实际生效档 = 本字段非空 ? 本字段 : 父会话档 —— parent / configured 只是来源
     * 之别，不要求两者不同（这正是官方的 `parentReasoningEffort` /
     * `configuredReasoningEffort` 两个字段的语义）。已显式写 `max` / `low` 的旧配置
     * 原样保留，不需要迁移动作。
     */
    reasoningEffort: z<string, string, "defined">;
    /**
     * 每回合回顾（recap）的一行字符上限。默认 80：一两句话把结论/状态/缺口说清，够了——
     * 回顾是「这轮之后什么变了」的提示，不是摘要；正文可以回看。超了由 `recap.ts`
     * 按标点就近断句后硬截。
     */
    recapMaxChars: z<number, number, "defined">;
    /**
     * 回顾的材料预算（单次发送给回顾模型的字符数）。回顾只看**本回合**：用户消息、
     * 助手结论、工具调用摘要，12000 字符足够装下一个长回合（含工具参数），超出时
     * `recap.ts` 保头保尾、中间省略。
     */
    recapSourceChars: z<number, number, "defined">;
    /**
     * 回顾调用超时（毫秒）。回顾是锦上添花的单次辅助调用，不占建议链路的 60s 预算；
     * 默认 30s 仍未返回就放弃（前端只是少一行回顾）。
     */
    recapTimeoutMs: z<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    /** LLM 下一条建议开关（默认开）；关闭后每回合不再调用建议模型。 */
    llmEnabled: z<boolean, boolean, "volatile-defined">;
    /**
     * 每回合回顾开关（默认开）。回合完成后，用这一回合自己的材料生成一行「这轮做了
     * 什么」显示在回复末尾；关闭后不再生成，已生成的回顾保留。
     */
    recapEnabled: z<boolean, boolean, "volatile-defined">;
    /** 是否启用历史前缀补全。 */
    historyEnabled: z<boolean, boolean, "volatile-defined">;
    /** 是否跨会话搜索历史（false = 仅当前会话）。 */
    historyCrossSession: z<boolean, boolean, "volatile-defined">;
    /** 历史补全最多参考的历史条目数（0 = 不限）。 */
    historyMaxEntries: z<number, number, "volatile-defined">;
    /** 草稿至少输入多少字符才触发历史补全。 */
    historyMinChars: z<number, number, "volatile-defined">;
    /** 幽灵显示时允许 → 逐词采纳。 */
    wordAccept: z<boolean, boolean, "volatile-defined">;
    /** 采纳建议的输入框快捷键（默认 Tab）。 */
    acceptKey: z<string, string, "volatile-defined">;
    /**
     * client → host 的热度管理操作队列（JSON 字符串）。
     *
     * 0.1.7 的 `SettingsForms.write()` 只接受 volatile 路径（`isVolatilePath`
     * 校验，非 volatile 直接抛错），所以这个反向通道字段本身也必须标 volatile。
     * 消费后立即写回空串：清空既是「已消费」信号，也防陈旧操作在重启后重放
     * （如陈旧的 clear 把新数据清掉）。操作幂等，host 不依赖 rev 去重。
     */
    _ops: z<string, string, "volatile-defined">;
    /**
     * host → client 的实时推送载荷（JSON 字符串），同上必须标 volatile 才能写入。
     * 结构与 0.1.5 时代完全一致（见 settings.ts 的 `GhostPushPayload`），故 client
     * 侧的解析与 `*SessionId` 归属守卫无需改动——变的只是字段载体。
     */
    _push: z<string, string, "volatile-defined">;
    /**
     * 最终框架化用户提示的最大 UTF-8 字节数。4096 是「装得下一轮中文对话」的量级，
     * 但 3 轮真实对话实测要 8～9 KB（中文 1 字 = 3 字节）⇒ 默认抬到 16384，让
     * `maxRecentTurns: 3` 真的装得下；调小它会把窗口裁回 1～2 轮。
     */
    maxInputBytes: z<number, number, "defined">;
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
    maxOutputTokens: z<number, number, "defined">;
    /** 辅助请求端到端截止时间（毫秒）。 */
    timeoutMs: z<number, number, "defined">;
    /**
     * 转录尾部保留的最近完成回合数（默认 3）。实测：只给 1 轮时模型 4/4 次给不出
     * 建议（界面什么都不显示），给 2～3 轮才稳定给出——它需要看到跨轮的模式。
     * 轮数受 `maxInputBytes` 约束，调大轮数时记得同步抬字节预算。
     */
    maxRecentTurns: z<number, number, "defined">;
    /** 转录字符预算（与 `maxInputBytes` 配套：3 轮中文对话约 3 千字符，留足余量）。 */
    maxTranscriptChars: z<number, number, "defined">;
    /** 建议可见字符上限。 */
    maxSuggestionChars: z<number, number, "defined">;
    /**
     * 显式路由对（**迁移期兼容字段**）。预测主链路的候选资格判据是「父会话有请求头」
     * （`session.requestHeader()`），路由继承自预测 fork 自己的请求头（规范 §4.2），
     * 不再要求这里配置；这两个字段只保留给仍在使用旧建议路径的 profile。
     * `z.string().default('')` 而非 `min(1)`：留空表示「继承」，若必填会把插件逼成
     * 「不填就不能启动」。
     */
    provider: z<string, string, "defined">;
    model: z<string, string, "defined">;
    /**
     * 预测请求的推理档覆盖。**留空 = 继承父会话档**（规范 §4.2）：预测 fork 的请求头
     * 自带父会话的 provider/model/reasoningEffort，这里只在用户显式配置时才覆盖。
     * 实际生效档 = 本字段非空 ? 本字段 : 父会话档 —— parent / configured 只是来源
     * 之别，不要求两者不同（这正是官方的 `parentReasoningEffort` /
     * `configuredReasoningEffort` 两个字段的语义）。已显式写 `max` / `low` 的旧配置
     * 原样保留，不需要迁移动作。
     */
    reasoningEffort: z<string, string, "defined">;
    /**
     * 每回合回顾（recap）的一行字符上限。默认 80：一两句话把结论/状态/缺口说清，够了——
     * 回顾是「这轮之后什么变了」的提示，不是摘要；正文可以回看。超了由 `recap.ts`
     * 按标点就近断句后硬截。
     */
    recapMaxChars: z<number, number, "defined">;
    /**
     * 回顾的材料预算（单次发送给回顾模型的字符数）。回顾只看**本回合**：用户消息、
     * 助手结论、工具调用摘要，12000 字符足够装下一个长回合（含工具参数），超出时
     * `recap.ts` 保头保尾、中间省略。
     */
    recapSourceChars: z<number, number, "defined">;
    /**
     * 回顾调用超时（毫秒）。回顾是锦上添花的单次辅助调用，不占建议链路的 60s 预算；
     * 默认 30s 仍未返回就放弃（前端只是少一行回顾）。
     */
    recapTimeoutMs: z<number, number, "defined">;
}>>, "plain">;
export declare const Config: z<Schemastery.TypeS<typeof ConfigSchema>, PluginConfigValues>;
/** 所需服务：LLM 路由 + 会话存储。 */
export declare const inject: string[];
/** 插件名（与 manifest 的包名一致；条目 id 仍是 `dsh-foresight`）。 */
export declare const name = "dsh-foresight";
/**
 * 挂载插件：监听完成回合、按会话生成建议、注册投影单元，并把配置暴露
 * 到 WebUI 设置页（settings 命名空间，live 生效）。
 * @param ctx - 提供 LLM 与会话服务的 cordis 上下文。
 * @param config - 必填的有界生成策略。
 */
export declare function apply(ctx: Context, config: GenerateConfig): void;
export {};
