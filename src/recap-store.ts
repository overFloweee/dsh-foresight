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
import {
  defineDomain,
  domainTable,
  type Domain,
  type DomainFacility,
  type KvTable,
} from '@deepseek-ai/dsh-storage-domain';
import z from 'zod';

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

/** 单条回顾文本的存储上限：生成侧按用户配置截断（默认 400），留足余量。 */
const RECAP_TEXT_MAX_CHARS = 1_200;
/** 每会话保留的回顾条数上限。 */
const SESSION_RECAP_CAP = 50;
/** 全表条数上限（防长驻进程/大量会话无界增长）。 */
const TABLE_CAP = 400;

/** 域声明：名字须匹配 UNIT_NAME_RE（小写字母开头的 [a-z0-9_]）。 */
const recapDomainSpec = defineDomain({
  name: 'suggest_ghost_recap',
  version: 1,
  tables: { entries: domainTable(
    z.object({
      sessionId: z.string().min(1),
      turn: z.number().int().nonnegative(),
      text: z.string().min(1).max(RECAP_TEXT_MAX_CHARS),
      at: z.number().int().nonnegative(),
      toolCalls: z.number().int().nonnegative().optional(),
    }),
  ) },
});

type RecapDomain = Domain<typeof recapDomainSpec>;
type EntriesTable = KvTable<string, RecapRecord>;

/** 存储键：`sessionId + \u0000 + turn`（同一会话同一回合至多一条）。 */
function keyOf(sessionId: string, turn: number): string {
  return `${sessionId}\u0000${turn}`;
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
export function setupRecapStore(ctx: Context): RecapStore {
  /** 内存表：sessionId → 按回合升序的记录数组（list 时直接映射）。 */
  const bySession = new Map<string, RecapRecord[]>();
  /** 列表缓存：避免每次推送都重建数组（`_push` 指纹按引用无关、按内容比对）。 */
  const listCache = new Map<string, readonly RecapEntry[]>();
  /** 脏标记：key → 待写记录（null = 待删除）。 */
  const dirty = new Map<string, RecapRecord | null>();
  let entries: EntriesTable | null = null;
  let domain: RecapDomain | null = null;
  let ready = false;
  let settleReady: () => void = () => {};
  const whenReady = new Promise<void>((resolve) => {
    settleReady = resolve;
  });

  const invalidate = (sessionId: string): void => {
    listCache.delete(sessionId);
  };

  /** 淘汰某会话超出上限的旧记录（同时标脏删除）。 */
  const pruneSession = (sessionId: string): void => {
    const rows = bySession.get(sessionId);
    if (rows === undefined) return;
    while (rows.length > SESSION_RECAP_CAP) {
      const dropped = rows.shift();
      if (dropped !== undefined) dirty.set(keyOf(sessionId, dropped.turn), null);
    }
    invalidate(sessionId);
  };

  /** 全表容量淘汰：按写入时间最旧的会话整段淘汰（保留最近写入的 TABLE_CAP 条）。 */
  const pruneGlobal = (): void => {
    let total = 0;
    for (const rows of bySession.values()) total += rows.length;
    if (total <= TABLE_CAP) return;
    // 全局按 at 排序取最旧——条数有界（几千），每次 put 排序可以接受。
    const flat: Array<{ readonly sessionId: string; readonly record: RecapRecord }> = [];
    for (const [sessionId, rows] of bySession) {
      for (const record of rows) flat.push({ sessionId, record });
    }
    flat.sort((a, b) => a.record.at - b.record.at);
    const excess = flat.length - TABLE_CAP;
    for (let index = 0; index < excess; index += 1) {
      const victim = flat[index];
      if (victim === undefined) break;
      const rows = bySession.get(victim.sessionId);
      if (rows === undefined) continue;
      const at = rows.findIndex(record => record.turn === victim.record.turn);
      if (at >= 0) rows.splice(at, 1);
      if (rows.length === 0) bySession.delete(victim.sessionId);
      dirty.set(keyOf(victim.sessionId, victim.record.turn), null);
      invalidate(victim.sessionId);
    }
  };

  const insert = (record: RecapRecord): void => {
    const rows = bySession.get(record.sessionId) ?? [];
    const at = rows.findIndex(row => row.turn === record.turn);
    if (at >= 0) rows[at] = record;
    else {
      rows.push(record);
      rows.sort((a, b) => a.turn - b.turn);
    }
    bySession.set(record.sessionId, rows);
    invalidate(record.sessionId);
    pruneSession(record.sessionId);
    pruneGlobal();
  };

  const flush = async (): Promise<void> => {
    const table = entries;
    if (table === null || !ready || dirty.size === 0) return;
    const batch = [...dirty];
    dirty.clear();
    const results = await Promise.allSettled(batch.map(([key, record]) =>
      record === null ? table.delete(key) : table.put(key, record)));
    for (const result of results) {
      if (result.status === 'rejected') {
        ctx.logger.warn(`dsh-foresight: recap persist write failed: ${String(result.reason)}`);
      }
    }
  };

  const close = async (): Promise<void> => {
    try {
      await flush();
    } finally {
      const closing = domain;
      domain = null;
      entries = null;
      ready = false;
      try {
        await closing?.close();
      } catch (error) {
        ctx.logger.warn(`dsh-foresight: recap domain close failed: ${String(error)}`);
      }
    }
  };

  ctx.inject(['storageDomain'], (sctx) => {
    void (async () => {
      try {
        const facility = (sctx as { storageDomain?: DomainFacility }).storageDomain;
        if (facility === undefined) {
          settleReady();
          return;
        }
        const opened = await facility.open(recapDomainSpec);
        const table = opened.table('entries');
        // 恢复：按会话分组、回合升序，套用与 live 相同的容量淘汰。
        const records = [...table.entries()]
          .map(([, record]) => record)
          .sort((a, b) => a.at - b.at);
        for (const record of records) insert(record);
        // 恢复期间淘汰掉的记录同样需要落盘删除（insert 只标了内存与脏标记）。
        entries = table;
        domain = opened;
        ready = true;
        ctx.logger.info(
          `dsh-foresight: recap persistence ready (${records.length} records restored across ${bySession.size} sessions)`,
        );
        ctx.effect(() => () => void close());
        void flush();
        settleReady();
      } catch (error) {
        ctx.logger.warn(`dsh-foresight: recap persistence unavailable, staying in-memory: ${String(error)}`);
        settleReady();
      }
    })();
  });

  return {
    whenReady,
    list(sessionId: string): readonly RecapEntry[] | null {
      const cached = listCache.get(sessionId);
      if (cached !== undefined) return cached;
      const rows = bySession.get(sessionId);
      if (rows === undefined || rows.length === 0) return null;
      const projected: readonly RecapEntry[] = rows.map(row => ({ turn: row.turn, text: row.text }));
      listCache.set(sessionId, projected);
      return projected;
    },
    has(sessionId: string, turn: number): boolean {
      const rows = bySession.get(sessionId);
      if (rows === undefined) return false;
      return rows.some(row => row.turn === turn);
    },
    put(record: RecapRecord): void {
      insert(record);
      dirty.set(keyOf(record.sessionId, record.turn), record);
      pruneSession(record.sessionId);
      // pruneSession 可能又产生删除脏标记；确保被删键不在脏表里残留旧写。
      void flush();
    },
    flush,
    close,
  };
}
