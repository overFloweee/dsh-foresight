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
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { deadline } from '@deepseek-ai/dsh-timeout';
import { appendPredictionRequest } from './prediction-prompt.js';
/** 预测请求的截止错误码；与旧建议路径的 `SUGGEST_GHOST_TIMEOUT` 分开，便于归因。 */
export const PREDICTION_TIMEOUT_CODE = 'SUGGEST_GHOST_PREDICTION_TIMEOUT';
/** 预测分支的会话 id 前缀：用于把插件自己创建的分支从事件入口排除（规范 §3.2）。 */
const PREDICTION_CHILD_PREFIX = 'dsh-foresight/prediction/';
/**
 * 解析模型输出。按官方语义：外层 JSON 必须是 `{"suggestion": string|null}` 且无多余字段
 * （对应 schema 的 `additionalProperties:false`）；合法字符串**只做 trim**，空串视为
 * `null`（abstained）；换行与长度都不在这里处理。
 */
export function parsePredictionOutput(text) {
    const body = text.trim();
    if (body.length === 0)
        return { kind: 'failed', reason: 'empty_body' };
    let value;
    try {
        value = JSON.parse(body);
    }
    catch {
        return { kind: 'failed', reason: 'invalid_json' };
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { kind: 'failed', reason: 'schema_mismatch' };
    }
    const entries = Object.entries(value);
    const first = entries[0];
    if (entries.length !== 1 || first === undefined || first[0] !== 'suggestion') {
        return { kind: 'failed', reason: 'schema_mismatch' };
    }
    const suggestion = first[1];
    if (suggestion === null)
        return { kind: 'abstained' };
    if (typeof suggestion !== 'string')
        return { kind: 'failed', reason: 'schema_mismatch' };
    const trimmed = suggestion.trim();
    if (trimmed.length === 0)
        return { kind: 'abstained' };
    return { kind: 'suggested', text: trimmed };
}
/** 预测分支的 session id；随机后缀保证同一源回合的多次请求互不撞名。 */
export function predictionChildIdOf(sessionId, turn, endSeq) {
    const nonce = Math.random().toString(36).slice(2, 10);
    return `${PREDICTION_CHILD_PREFIX}${sessionId}/${String(turn)}/${String(endSeq)}/${nonce}`;
}
const predictionChildren = new Set();
/** 事件入口用：该会话是否本插件预测分支（分支的 turn/end 不得再次触发预测）。 */
export function isPredictionChildSession(sessionId) {
    return predictionChildren.has(sessionId);
}
/** 诊断与测试用：在途预测分支数量。 */
export function livePredictionChildCount() {
    return predictionChildren.size;
}
/**
 * 同键请求登记表（规范 §3.1 表格：已有在途 → 复用，不新建 fork 或 LLM 调用）。
 *
 * `startOrReuse` 是**同步**方法：登记发生在任何 `await` 之前，因此 live 与 catch_up
 * 谁先到达谁生成，另一路复用同一次模型调用。终态缓存属于切片 2（传输层），本类只
 * 负责在途去重。
 */
export class PredictionFlight {
    inFlight = new Map();
    startOrReuse(key, start) {
        const existing = this.inFlight.get(key);
        if (existing !== undefined)
            return { reused: true, result: existing };
        const result = start();
        // 只有仍属于本次登记的 promise 才清理，避免键被新请求接手后被旧回调误删。
        const tracked = result.finally(() => {
            if (this.inFlight.get(key) === tracked)
                this.inFlight.delete(key);
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
    forget(key) {
        this.inFlight.delete(key);
    }
    /** 诊断与测试用：在途请求数量。 */
    get size() {
        return this.inFlight.size;
    }
}
/** 路由字段按「有值才出现」的方式写入结果，避免把 undefined 混进可选字段。 */
function routeInfo(input) {
    const out = {};
    if (input.provider !== undefined && input.provider.length > 0)
        out.provider = input.provider;
    if (input.model !== undefined && input.model.length > 0)
        out.model = input.model;
    if (input.reasoningEffort !== undefined && input.reasoningEffort.length > 0) {
        out.reasoningEffort = input.reasoningEffort;
    }
    return out;
}
function failedResult(base, reason, startedAt, route = {}, detail) {
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
function outputDetail(finish, text) {
    const head = text.slice(0, 160).replace(/\s+/g, ' ');
    return `finish=${finish.kind} chars=${String(text.length)} head=${JSON.stringify(head)}`;
}
function cancelledResult(base, startedAt, route = {}) {
    return {
        ...base,
        outcome: 'cancelled',
        suggestion: null,
        ...route,
        durationMs: Date.now() - startedAt,
    };
}
function abstainedResult(base, startedAt, route = {}) {
    return {
        ...base,
        outcome: 'abstained',
        suggestion: null,
        ...route,
        durationMs: Date.now() - startedAt,
    };
}
function suggestedResult(base, text, startedAt, route = {}) {
    return {
        ...base,
        outcome: 'suggested',
        suggestion: text,
        ...route,
        durationMs: Date.now() - startedAt,
    };
}
function textOf(value) {
    return typeof value === 'string' ? value : '';
}
/**
 * 结束原因 → 失败原因。`stop` 之外的正常结束都不是成功文本（规范 §4.3）：
 * max-tokens 记 abnormal_finish，tool-calls 记 tool_call，error/aborted 记 transport
 * （外部取消由调用方在 catch 里先判成 cancelled）。
 */
function finishFailureOf(finish) {
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
function createForkScope(ctx) {
    const factory = ctx;
    return factory.plugin(() => { });
}
function isTextBlock(block) {
    return block.type === 'text';
}
/**
 * 执行一次预测（切片 1 的生成接入）。所有失败路径都返回结果对象，不抛异常；
 * 唯一必须保证的是资源释放：fork 成功与否都在 finally 里 dispose 并移除子会话身份。
 */
export async function runPrediction(ctx, options) {
    const startedAt = Date.now();
    const { session, source, trigger } = options;
    const childId = predictionChildIdOf(session.id, source.turn, source.endSeq);
    const base = {
        requestId: childId,
        sessionId: session.id,
        turn: source.turn,
        endSeq: source.endSeq,
        trigger,
    };
    // 防御：绝不基于我们自己的分支再生成（事件入口已有同源过滤，这里是第二道）。
    if (isPredictionChildSession(session.id))
        return failedResult(base, 'ineligible', startedAt);
    predictionChildren.add(childId);
    let scope;
    try {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            scope = createForkScope(ctx);
            const sessions = scope.ctx.sessions;
            if (sessions === undefined || typeof sessions.fork !== 'function') {
                return failedResult(base, 'fork_failed', startedAt);
            }
            let fork;
            try {
                fork = sessions.fork(session, source.endSeq, childId);
            }
            catch {
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
            const callDeadline = __addDisposableResource(env_1, deadline(options.signal, options.timeoutMs, PREDICTION_TIMEOUT_CODE), false);
            const llmOptions = {
                provider,
                model,
                // 空串 = 字段缺席：内核据此回落到 provider 默认档。
                ...(reasoningEffort.length === 0 ? {} : { reasoningEffort: reasoningEffort }),
                messages,
                // 不接工具面：保留历史调用/结果（在消息面里）与禁止新工具执行是两件事。
                tools: [],
                maxTokens: options.maxOutputTokens,
                sessionId: fork.id,
                signal: callDeadline.signal,
            };
            const info = routeInfo({ provider, model, reasoningEffort });
            let finish;
            let blocks;
            try {
                const assembler = new BlockAssembler();
                for await (const chunk of ctx.llm.stream(llmOptions)) {
                    callDeadline.signal.throwIfAborted();
                    assembler.push(chunk);
                }
                callDeadline.signal.throwIfAborted();
                finish = assembler.finish;
                blocks = assembler.blocks();
            }
            catch {
                if (options.signal.aborted)
                    return cancelledResult(base, startedAt, info);
                if (callDeadline.signal.aborted)
                    return failedResult(base, 'timeout', startedAt, info);
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
            if (parsed.kind === 'abstained')
                return abstainedResult(base, startedAt, info);
            return suggestedResult(base, parsed.text, startedAt, info);
        }
        catch (e_1) {
            env_1.error = e_1;
            env_1.hasError = true;
        }
        finally {
            __disposeResources(env_1);
        }
    }
    finally {
        if (scope !== undefined) {
            try {
                await scope.dispose();
            }
            catch {
                // 释放失败不改变预测结果；宿主会在会话 disposed 时自行清理登记。
            }
        }
        // 作用域释放完成后才移除身份：disposed 期间产生的事件同样受过滤。
        predictionChildren.delete(childId);
    }
}
