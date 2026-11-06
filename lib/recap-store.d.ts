/**
 * 回顾（recap）持久化：每回合生成的一行回顾按 `sessionId + turn` 落到宿主
 * `storageDomain`（与热度表同一模式、同一 backend），重启后打开旧会话仍能看到
 * 历史回合的回顾——这是「会话里的东西」而不是「本次进程的临时提示」。
 *
 * 有界：每会话最多保留 `SESSION_RECAP_CAP` 条（旧的按回合淘汰）、全表最多
 * `TABLE_CAP` 条（按写入时间淘汰最旧）。回顾是显示用文本，没有热度那种累计语义，
 * 因此写路径直接覆盖、不需要合并恢复。
 *
 * 写合并在内存标脏，flush 时机：回合结束 + 卸载兜底；fail-soft（写失败只告警）。
 * 宿主未挂 `storageDomain` 时静默降级为纯内存。
 * @module dsh-foresight/recap-store
 */
import type { Context } from '@deepseek-ai/cordis';
/** 一条持久化回顾。 */
export interface RecapRecord {
    /** 所属会话。 */
    readonly sessionId: string;
    /** 所属回合号（同一会话内唯一）。 */
    readonly turn: number;
    /** 一行回顾文本（已清洗、已截断）。 */
    readonly text: string;
    /** 写入时间（毫秒时间戳；全表淘汰用）。 */
    readonly at: number;
    /** 该回合工具调用数（展示/诊断用，可选）。 */
    readonly toolCalls?: number;
}
/** 推给 client 的单条回顾（只带显示必需字段）。 */
export interface RecapEntry {
    readonly turn: number;
    readonly text: string;
}
/** 持久化句柄：`list` 给推送组装用，`flush` 给回合结束/卸载用。 */
export interface RecapStore {
    /** 恢复阶段结束信号（domain open 完成或降级）——消费方据此再补推一次。 */
    readonly whenReady: Promise<void>;
    /**
     * 某会话全部回顾（按回合升序）；无回顾返回 `null`（与「没携带」区分）。
     * 结果引用稳定，供 `_push` 指纹比对。
     */
    list(sessionId: string): readonly RecapEntry[] | null;
    /** 该会话该回合是否已有回顾（防重复生成）。 */
    has(sessionId: string, turn: number): boolean;
    /** 写入/覆盖一条回顾（同步入内存 + 标脏 + 淘汰）。 */
    put(record: RecapRecord): void;
    /** 排空脏标记到存储（fail-soft）。 */
    flush(): Promise<void>;
    /** 卸载兜底：最终 flush 再关闭 domain。 */
    close(): Promise<void>;
}
/**
 * 装配回顾存储并经 storageDomain 恢复历史记录。
 * @param ctx - 宿主上下文。
 */
export declare function setupRecapStore(ctx: Context): RecapStore;
