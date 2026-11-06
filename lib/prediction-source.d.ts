/**
 * `dsh-foresight/prediction-source` 投影单元：预测的「源回合身份」。
 *
 * 官方输入预测要求「最新回合已 completed」这条资格判据来自可回放的会话状态，
 * 而不是 client 的 idle 状态或 `session.seq`（后者是下一事件序号，不是回合结束
 * 事件）。因此本单元只从原生事件派生 `{turn, endSeq, endKind}`：`turn/start`
 * 立刻作废上一回合（清空 endSeq/endKind），只有同回合的 `turn/end` 才写入结束
 * 序号与结束原因。host-only：不进 client 投影表、不提供 wire view，避免把纯资格
 * 信息广播到界面。
 *
 * 契约要点：
 *  - `applyPredictionSource` 是纯同步 fold，状态是 plain JSON（可持久化缓存），
 *    无关事件必须返回同一引用（`Object.is` 让下游零工作）；
 *  - 读取只走 `registry.stateOf()`（0.2.0-rc.2 的非废弃 host 读取接口），其返回值
 *    是 live 引用：只读取字段后返回新对象，绝不就地修改；
 *  - 能力缺失一律降级为 `PredictionSourceUnavailable`，`read` 从不抛错。
 * @module dsh-foresight/prediction-source
 */
import { z } from 'zod';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
/** 本单元在 `ctx.sessionProjections` 里的键。host-only，不出现在 client 投影表。 */
export declare const PREDICTION_PROJECTION_KEY = "dsh-foresight/prediction-source";
/** 源回合身份：`turn` 为当前回合；`endSeq`/`endKind` 只在同回合结束事件时写入。 */
export interface PredictionSourceState {
    readonly turn: number | null;
    readonly endSeq: number | null;
    readonly endKind: string | null;
}
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionStateMap {
        /**
         * host-only 的源回合身份。只并入 host fold-state 表（`SessionProjectionStateMap`），
         * 不并入 client 的 `SessionProjectionMap` —— 它没有 wire view，不参与广播。
         */
        'dsh-foresight/prediction-source': PredictionSourceState;
    }
}
/**
 * 状态校验 schema：严格形状（只认这三个字段），三字段必填、值允许 null。
 * 它同时是 `stateSchema`（校验持久化缓存能否作为 fold 的种子）与运行期读取时的
 * 形状参考 —— 缓存里的旧行若不合形，内核会丢弃并重放日志，而不是折叠出垃圾。
 */
export declare const predictionSourceSchema: z.ZodType<PredictionSourceState>;
/**
 * 空日志初值：三字段全 null（不能生成）。
 * 0.1.2 起内核调用 `init(header, inheritedEventCount)`，旧代不传参；本单元的状态
 * 完全由事件派生，与 header／继承前缀无关，因此签名保持零参，忽略两代差异。
 */
export declare function initPredictionSource(): PredictionSourceState;
/**
 * 纯 fold：只认 `turn/start` 与「同当前回合」的 `turn/end`，其余（含属于别的回合的
 * `turn/end`）原状态不变且返回同一引用。
 * 载荷不合形的同类事件同样按「无关」处理：宁可暂时判不合格，也不写一个猜出来的回合号。
 */
export declare function applyPredictionSource(state: PredictionSourceState, event: {
    type: string;
    seq: number;
    data?: unknown;
}): PredictionSourceState;
/** 合格源身份：`sessionId` 定位请求目标，`turn`/`endSeq` 是 fork 包含式边界。 */
export type PredictionSourceRead = {
    kind: 'ok';
    sessionId: string;
    turn: number;
    endSeq: number;
};
/**
 * 不可用状态。四种原因对应四种可诊断的缺失，调用方按此记录
 * `source_state_unavailable` 并等待服务/状态变化后重新对账，不回退到旧推送。
 */
export type PredictionSourceUnavailable = {
    kind: 'unavailable';
    reason: 'service_absent' | 'capability_absent' | 'unit_absent' | 'ineligible';
};
/** 读取入口：`registered` 仅用于诊断（注册是否真的落地）。 */
export interface PredictionSourceAccess {
    /**
     * 单元与 registry 是否都已就绪（诊断用）。注册经 `ctx.inject` 异步落地：install
     * 返回后的同一同步块里它仍为 false；作用域卸载后回到 false。判定源资格请以
     * `read` 的结果为准。
     */
    readonly registered: boolean;
    read(session: Session): PredictionSourceRead | PredictionSourceUnavailable;
}
/**
 * 经 `ctx.inject(['sessionProjections'], ...)` 安装：注册 host-only 单元，并返回
 * 读取入口。服务永不就绪（或代际形状再变）时返回降级 access —— `read` 恒为
 * `service_absent`，绝不绕过 Cordis 注入约束直接摸 `ctx.sessionProjections`。
 */
export declare function installPredictionSource(ctx: Context): PredictionSourceAccess;
/** 请求键的字段集：源身份 + 配方版本 + 有效生成配置身份（不含任何凭据）。 */
export interface PredictionRequestKeyParts {
    sessionId: string;
    turn: number;
    endSeq: number;
    recipeVersion: number;
    provider: string;
    model: string;
    reasoningEffort: string;
    maxOutputTokens: number;
    timeoutMs: number;
}
/**
 * 稳定、确定性、不含凭据的请求键：live 触发与 catch_up 触发共用同一个键，
 * 于是语义去重由 host 侧一处保证（先后到达的触发复用同一记录，不重复调模型）。
 * 字段顺序固定为签名顺序，数字统一 `String()`，保证同一份输入恒得同一个键。
 */
export declare function predictionRequestKey(parts: PredictionRequestKeyParts): string;
