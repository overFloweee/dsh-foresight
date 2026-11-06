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
var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { deadline } from '@deepseek-ai/dsh-timeout';
import { sessionEvents } from './coldstart.js';
import { redactSecrets } from './sanitize.js';
import { suggestionLanguage } from './transcript.js';
/** 回顾请求的截止错误码；与建议/预测分开，便于归因。 */
export const RECAP_TIMEOUT_CODE = 'SUGGEST_GHOST_RECAP_TIMEOUT';
/** 单条材料的截断上限（字符）。 */
const USER_CLIP = 300;
const ASSISTANT_CLIP = 1_500;
const TOOL_ARG_CLIP = 180;
/** 最多列出多少条工具调用（其余只计数）。 */
const TOOL_LIST_CAP = 24;
/** 按「码点」截断（不劈裂代理对），超出追加省略号。 */
function clip(text, max) {
    if (text.length <= max)
        return text;
    const points = Array.from(text);
    if (points.length <= max)
        return text;
    return `${points.slice(0, max).join('')}…`;
}
/** 单行化：换行/连续空白压成一个空格，去掉首尾空白。 */
function oneLine(text) {
    return text.replace(/\s+/g, ' ').trim();
}
/** 从消息事件取纯文本（只认 text 块）。 */
function messageText(data) {
    const message = data;
    const content = message?.message?.content;
    if (!Array.isArray(content))
        return '';
    let out = '';
    for (const block of content) {
        const b = block;
        if (b?.type === 'text' && typeof b.text === 'string')
            out += b.text;
    }
    return out;
}
/** 取用户消息文本（只收真人输入，注入上下文与超长横幅跳过）。 */
function userText(data) {
    const raw = data;
    const kind = raw?.source?.kind;
    if (typeof kind === 'string' && kind !== 'user')
        return '';
    if (!Array.isArray(raw?.content))
        return '';
    let out = '';
    for (const block of raw.content) {
        const b = block;
        if (b?.type === 'text' && typeof b.text === 'string')
            out += b.text;
    }
    const text = out.trim();
    if (text.length === 0 || text.startsWith('<system-reminder>'))
        return '';
    return text;
}
/** 从工具参数里挑出最能代表「做了什么」的字段（路径/命令/查询）。 */
function toolTarget(name, args) {
    const raw = args.trim();
    if (raw.length === 0)
        return name;
    try {
        const parsed = JSON.parse(raw);
        const pick = (key) => {
            const value = parsed[key];
            return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
        };
        const target = pick('file_path') ?? pick('path') ?? pick('command') ?? pick('pattern')
            ?? pick('query') ?? pick('url') ?? pick('description') ?? pick('prompt');
        if (target !== undefined)
            return `${name}: ${oneLine(clip(target, TOOL_ARG_CLIP))}`;
    }
    catch {
        // 非 JSON 参数（老日志）：原样截断即可。
    }
    return `${name}: ${oneLine(clip(redactSecrets(raw), TOOL_ARG_CLIP))}`;
}
function newBucket() {
    return { user: [], assistant: [], tools: [], toolErrors: [] };
}
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
export function buildRecapMaterial(session, turn, sourceChars) {
    const events = sessionEvents(session);
    let current = newBucket();
    let currentTurn = 0;
    let picked;
    const commit = () => {
        if (currentTurn > 0 && (current.user.length > 0 || current.assistant.length > 0 || current.tools.length > 0)) {
            picked = { turn: currentTurn, bucket: current };
        }
        current = newBucket();
    };
    for (const event of events) {
        if (event.type === 'turn/start') {
            commit();
            const data = event.data;
            currentTurn = typeof data.turn === 'number' ? data.turn : currentTurn + 1;
            continue;
        }
        if (event.type === 'turn/end')
            continue;
        if (event.type === 'user/message') {
            const text = userText(event.data);
            if (text.length > 0)
                current.user.push(text);
            continue;
        }
        if (event.type === 'assistant/message') {
            const text = messageText(event.data);
            if (text.trim().length > 0)
                current.assistant.push(text);
            continue;
        }
        if (event.type === 'tool/call') {
            const data = event.data;
            if (typeof data.name === 'string') {
                current.tools.push(toolTarget(data.name, typeof data.arguments === 'string' ? data.arguments : ''));
            }
            continue;
        }
        if (event.type === 'tool/result') {
            const data = event.data;
            const reason = data.error?.reason;
            if (typeof reason === 'string' && reason.length > 0)
                current.toolErrors.push(oneLine(clip(reason, 200)));
        }
    }
    commit();
    const chosen = picked;
    if (chosen === undefined)
        return undefined;
    // 期望回合对不上时仍用最后一个桶（事件流被压缩/迁移时的兜底）。
    if (turn > 0 && chosen.turn !== turn) {
        // 不视为失败：最后一轮就是刚刚结束的那一轮。
    }
    const bucket = chosen.bucket;
    const pairs = [
        ...bucket.user.map((text) => ({ role: 'user', text: redactSecrets(text) })),
        ...bucket.assistant.map((text) => ({ role: 'assistant', text: redactSecrets(text) })),
    ];
    const sections = [];
    const asks = bucket.user
        .map(text => `- ${oneLine(clip(redactSecrets(text), USER_CLIP))}`)
        .join('\n');
    if (asks.length > 0)
        sections.push(`[This turn — what the user asked for]\n${asks}`);
    // 助手答复取最后一条为主（结论），更早的只留开头一句（过程）。
    const primary = bucket.assistant.length > 0 ? bucket.assistant[bucket.assistant.length - 1] ?? '' : '';
    if (primary.length > 0) {
        sections.push(`[What the assistant concluded]\n${oneLine(clip(redactSecrets(primary), ASSISTANT_CLIP))}`);
    }
    const earlier = bucket.assistant.slice(0, -1)
        .map(text => `- ${oneLine(clip(redactSecrets(text), 200))}`)
        .filter(text => text !== '- ')
        .join('\n');
    if (earlier.length > 0)
        sections.push(`[Earlier narration in the same turn]\n${earlier}`);
    const listed = bucket.tools.slice(0, TOOL_LIST_CAP).map(line => `- ${line}`).join('\n');
    if (listed.length > 0) {
        sections.push(`[Tool calls this turn (${bucket.tools.length})]\n${listed}`);
    }
    if (bucket.toolErrors.length > 0) {
        sections.push(`[Tool errors this turn]\n${bucket.toolErrors.slice(0, 8).map(line => `- ${line}`).join('\n')}`);
    }
    let framed = sections.join('\n\n');
    if (framed.length === 0)
        return undefined;
    if (framed.length > sourceChars) {
        // 超预算：保头（用户诉求）+ 保尾（工具与结论），中间省略。
        const head = clip(framed, Math.floor(sourceChars * 0.4));
        const tail = framed.slice(framed.length - Math.floor(sourceChars * 0.55));
        framed = `${head}\n…\n${tail}`;
    }
    return { framed, turns: bucket.user.length, toolCalls: bucket.tools.length, pairs };
}
/**
 * 回顾的 system 提示词（用户 m00832 定稿，逐字照抄，不要自作主张加规则）。
 *
 * 只保留三段：角色与读者、最高要求。长度由 `generateRecap` 的 `clip()` 按
 * `recapMaxChars` 硬截断保证；输出语言跟随材料本身的会话语言（不做提示词约束）。
 * @param maxChars - 一行输出的字符上限（现由代码截断，提示词不再声明）。
 * @param language - 输出语言（现由材料自身带出，提示词不再声明）。
 */
export function recapSystemPrompt(maxChars, language) {
    void maxChars;
    void language;
    return [
        '你在为一个编码助手的界面写一行「回合回顾」（recap）：刚执行完的这一轮，用一段话说清。',
        '读者是刚看完这轮执行的人，他不看实现细节，只想听懂：这一轮解决了什么、现在是什么状态、还差什么。',
        '',
        '最高要求：逻辑清晰说人话，要解释给用户一次性就能够听明白。做不到这点，这行字就是废的。',
    ].join('\n');
}
/** 清洗模型输出：单行化、剥掉常见包装（引号/背引号/列表符/recap 前缀）。 */
export function cleanRecap(text) {
    let out = text.replace(/\r/g, '\n').trim();
    // 去掉 markdown 代码块围栏（模型偶尔会整段包起来）。
    out = out.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '');
    out = out.replace(/^[-*•]\s+/, '');
    out = out.replace(/^(recap|回顾|summary|摘要)\s*[:：]\s*/i, '');
    out = oneLine(out);
    const wrapped = /^(["“'`])(.*)\1$/s.exec(out);
    if (wrapped !== null && wrapped[2] !== undefined)
        out = wrapped[2].trim();
    return out;
}
/** 「这一轮没有变化」的哨兵集合（材料里的问题约定模型回这些词）。 */
const NO_CHANGE_TOKENS = new Set([
    '无',
    '无变化',
    '没有变化',
    '没有任何变化',
    '无新变化',
    '没有新变化',
    '无内容',
    'none',
    'nochange',
    'n/a',
    '-',
]);
/** 识别「这一轮没有变化」的回应（去空白与标点后比对，容忍模型多写句号）。 */
export function isNoChange(text) {
    const normalized = text.replace(/[\s。.！!？?，,；;：:、]+/gu, '').toLowerCase();
    return normalized.length > 0 && NO_CHANGE_TOKENS.has(normalized);
}
/**
 * 剥掉开头的元叙述（「回顾这一轮：…」「这一轮把…」）。
 *
 * 主语应该是「变化」而不是「这场对话」，所以「回顾 / 总结 / 这一轮 / 本轮 …」
 * 这类开头逐层剥掉，最多三层。时间词（这一轮/本轮/本回合…）可直接剥；「回顾」
 * 「总结」这类词只有在后面紧跟标点/空白或再接一个时间词时才剥，否则「回顾开关」
 * 这种正常名词会被误伤。
 */
export function stripMetaOpening(text) {
    let out = text.trim();
    for (let i = 0; i < 3; i += 1) {
        const temporal = /^(?:这一轮|这一回合|本回合|这个回合|本轮)(?:[：:，,。、]\s*|\s+)?/u.exec(out);
        const verdict = temporal === null
            ? /^(?:回顾|总结|摘要|小结)(?:[：:，,。、]\s*|\s+|(?=这一轮|这一回合|本回合|这个回合|本轮))/u.exec(out)
            : temporal;
        if (verdict === null)
            break;
        out = out.slice(verdict[0].length).trim();
    }
    return out;
}
/** 去掉句尾悬空的连接标点（截断/剥词之后的收尾）。 */
function trimDangling(text) {
    return text.replace(/[，,、；;：:\s]+$/u, '').trim();
}
/**
 * 把模型输出整形到「一句、不超过 maxChars 个字」。
 *
 * 顺序：剥元叙述 → 够短就直接用 → 超长按标点就近断（保不住才硬截，按码点不劈
 * 代理对）→ 去句尾悬空标点。宁可短一句完整的，也不要长一句断掉的——这行字是
 * 提示，正文可以回看。
 */
export function fitRecap(text, maxChars) {
    const trimmed = trimDangling(stripMetaOpening(text));
    if (trimmed.length <= maxChars)
        return trimmed;
    const points = Array.from(trimmed);
    const floor = Math.max(4, Math.floor(maxChars * 0.4));
    for (let i = Math.min(points.length, maxChars); i > floor; i -= 1) {
        const ch = points[i - 1];
        if (ch === '。' || ch === '！' || ch === '？' || ch === '；' || ch === '，'
            || ch === '.' || ch === '!' || ch === '?' || ch === ';' || ch === ',' || ch === '、') {
            return trimDangling(points.slice(0, i).join(''));
        }
    }
    return trimDangling(points.slice(0, maxChars).join(''));
}
/**
 * 材料末尾的「结论问题」：把注意力从「复述这一轮」扭到「这一轮之后什么变了」。
 *
 * 用户定稿的 system 提示词保持逐字不动，问句放在材料这一侧——这是①优化的落点：
 * 同样的提示词，问「解决了什么」得到摘要，问「变化了什么」得到变化量。
 * @param language - 会话语言（由材料推断；目前只区分英文与其它）。
 * @param maxChars - 一行回顾的字数上限（写进指令，降低超长概率）。
 */
export function recapQuestion(language, maxChars) {
    if (language === 'English') {
        return [
            '[Conclusion of this turn]',
            'Answer in one or two sentences: after this turn, what changed? What does the reader need to know now?',
            '- Only the outcome, the current state, or what is still missing. No process, no restating the question, no leading "recap / this turn / we / summary".',
            `- At most ${maxChars} characters.`,
            '- If nothing new came out of this turn (no new conclusion, state change, or follow-up), reply only: none',
        ].join('\n');
    }
    return [
        '[这一轮的结论]',
        '用一两句话回答：这一轮之后，什么变了？读者现在需要知道什么？',
        '- 只写结果、现在的状态、或还差什么；不写过程，不复述问题，不用「回顾 / 这一轮 / 我们 / 总结」开头。',
        `- 不超过 ${maxChars} 个字。`,
        '- 如果这一轮没有带来新的结论、新的状态变化或新的待办，只回复：无',
    ].join('\n');
}
/** 深度冻结（与 generate.ts 的 deepFreeze 同义；此处最小实现，避免跨模块耦合）。 */
function freeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value))
            freeze(child);
    }
    return value;
}
/** 解析路由：显式配置优先，否则继承会话最近一次请求头。 */
function routeOf(session, config) {
    if (config.provider.length > 0 && config.model.length > 0) {
        return { provider: config.provider, model: config.model };
    }
    const route = session.requestHeader()?.config;
    if (route !== undefined && route.provider.length > 0 && route.model.length > 0) {
        return { provider: route.provider, model: route.model };
    }
    return undefined;
}
/** 终止原因 → 失败归因。 */
function failureOf(finish) {
    switch (finish.kind) {
        case 'stop':
            return undefined;
        case 'error':
        case 'aborted':
            return { reason: 'transport', detail: finish.failure.message };
        case 'max-tokens':
            return { reason: 'abnormal_finish', detail: 'finish=max-tokens' };
        case 'tool-calls':
            return { reason: 'tool_call', detail: 'finish=tool-calls' };
        default:
            return { reason: 'abnormal_finish', detail: `finish=${String(finish.kind)}` };
    }
}
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
export async function generateRecap(ctx, config, session, turn, signal) {
    const env_1 = { stack: [], error: void 0, hasError: false };
    try {
        if (signal.aborted)
            return { kind: 'failed', reason: 'cancelled' };
        const startedAt = Date.now();
        const material = buildRecapMaterial(session, turn, config.sourceChars);
        if (material === undefined)
            return { kind: 'failed', reason: 'no_material' };
        const route = routeOf(session, config);
        if (route === undefined) {
            return { kind: 'failed', reason: 'route_unavailable', detail: 'no request route to inherit' };
        }
        const language = suggestionLanguage(material.pairs);
        const system = recapSystemPrompt(config.maxChars, language);
        const framed = `${material.framed}\n\n${recapQuestion(language, config.maxChars)}`;
        const reasoningEffort = config.reasoningEffort.length > 0
            ? config.reasoningEffort
            : undefined;
        const messages = [createUserMessage({
                content: [{ type: 'text', text: framed }],
                source: { kind: 'user' },
            })];
        const callDeadline = __addDisposableResource(env_1, deadline(signal, config.timeoutMs, RECAP_TIMEOUT_CODE), false);
        const options = freeze({
            provider: route.provider,
            model: route.model,
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            messages,
            system,
            maxTokens: config.maxTokens,
            sessionId: session.id,
            signal: callDeadline.signal,
        });
        try {
            callDeadline.signal.throwIfAborted();
            const assembler = new BlockAssembler();
            for await (const chunk of ctx.llm.stream(options)) {
                callDeadline.signal.throwIfAborted();
                assembler.push(chunk);
            }
            callDeadline.signal.throwIfAborted();
            const terminal = failureOf(assembler.finish);
            if (terminal !== undefined)
                return { kind: 'failed', ...terminal };
            const blocks = assembler.blocks();
            if (blocks.some(block => block.type === 'tool-call')) {
                return { kind: 'failed', reason: 'tool_call', detail: 'text expected' };
            }
            const raw = blocks
                .filter((block) => block.type === 'text')
                .map(block => block.text)
                .join(' ');
            const cleaned = cleanRecap(raw);
            if (cleaned.length === 0)
                return { kind: 'failed', reason: 'empty_body' };
            // 没有变化的回合不写回顾：模型按材料里的约定回哨兵，这里静默跳过。
            if (isNoChange(cleaned))
                return { kind: 'no_change' };
            const text = fitRecap(cleaned, config.maxChars);
            if (text.length === 0)
                return { kind: 'failed', reason: 'empty_body' };
            ctx.logger.debug?.(`dsh-foresight: recap ready in ${Date.now() - startedAt}ms `
                + `(turn ${material.turns > 0 ? turn : '?'}, ${material.toolCalls} tool calls, ${text.length}/${config.maxChars} chars)`);
            return { kind: 'ok', text, toolCalls: material.toolCalls };
        }
        catch (error) {
            if (signal.aborted || callDeadline.signal.aborted) {
                return {
                    kind: 'failed',
                    reason: signal.aborted ? 'cancelled' : 'timeout',
                    detail: error instanceof Error ? error.message : String(error),
                };
            }
            return { kind: 'failed', reason: 'transport', detail: error instanceof Error ? error.message : String(error) };
        }
    }
    catch (e_1) {
        env_1.error = e_1;
        env_1.hasError = true;
    }
    finally {
        __disposeResources(env_1);
    }
}
