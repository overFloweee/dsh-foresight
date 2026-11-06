/**
 * 回合回顾（recap）的 client 端：把 host 经 `_push.recaps` 推来的「本会话每回合
 * 一行回顾」按会话缓存，并渲染成回复末尾的一行。
 *
 * 数据流：host 在 `turn/end`（completed）后单独调一次辅助模型，生成一行「这一轮
 * 做了什么」，按 `sessionId + turn` 落盘（`src/recap-store.ts`），随后随 `_push`
 * 的 `recaps` 字段把**当前会话的完整回顾集合**下发。本模块只做展示：
 *  - `applyRecaps()`：收载荷（`[{turn, text}]`，按回合升序）并替换该会话的集合；
 *  - `clearRecaps()`：宿主换代 / 连接重置时作废（与按会话预测缓存同一时机）；
 *  - `RecapLine`：注册到 `conversation.chat.turnTail` 槽的条目，用
 *    `useSyncExternalStore` 订阅 store，只渲染「本节目的回合」那一条。
 *
 * 为什么走 turnTail 槽而不是写会话事件：插件不允许 append 新 type 的会话事件
 * （未知事件必须带 `ignorable` 标记才能被重开，live append 设不了该标记），而
 * turnTail 正是「已完成回合的动作行之前」的官方扩展点。
 * @module dsh-foresight/client/recap
 */

import { useSyncExternalStore, type ReactElement } from 'react';

/** 一条回顾（与 host `recap-store.ts` 的 `RecapEntry` 同形，仅展示所需字段）。 */
interface RecapEntry {
  readonly turn: number;
  readonly text: string;
}

/** 按会话缓存的回顾集合（`_push` 只有一格，切会话时保留各自的）。 */
const recapsBySession = new Map<string, readonly RecapEntry[]>();

/** 订阅者（turnTail 里的 `RecapLine` 实例）。 */
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // 单个订阅者抛错不牵连其余（与内核 store 的订阅语义一致）。
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 用 host 下发的载荷替换某会话的回顾集合。
 *
 * 宽容解析：只保留 `{turn: 非负整数, text: 非空字符串}` 的条目——畸形字段整条
 * 丢弃而不是让整份载荷失效（与 `parsePrediction` / `parseRoute` 同一种口径）。
 * 内容未变时不通知订阅者（避免每次 `_push` 都触发一次无意义重渲染）。
 * @param sessionId - 归属会话。
 * @param raw - 原始 `recaps` 字段（unknown）。
 */
export function applyRecaps(sessionId: string, raw: unknown): void {
  const next: RecapEntry[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const turn = (item as { turn?: unknown }).turn;
      const text = (item as { text?: unknown }).text;
      if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) continue;
      if (typeof text !== 'string' || text === '') continue;
      next.push({ turn, text });
    }
  }
  next.sort((a, b) => a.turn - b.turn);
  const previous = recapsBySession.get(sessionId);
  const unchanged = previous !== undefined
    && previous.length === next.length
    && previous.every((entry, i) => entry.turn === next[i]?.turn && entry.text === next[i]?.text);
  if (unchanged) return;
  if (next.length === 0) recapsBySession.delete(sessionId);
  else recapsBySession.set(sessionId, next);
  notify();
}

/** 作废全部会话的回顾（宿主换代 / 连接重置）。 */
export function clearRecaps(): void {
  if (recapsBySession.size === 0) return;
  recapsBySession.clear();
  notify();
}

/**
 * 某会话某回合的回顾文本。
 * @param sessionId - 会话 id。
 * @param turn - 回合号。
 * @returns 回顾文本；该回合没有回顾时为 null。
 */
export function recapTextFor(sessionId: string, turn: number): string | null {
  const entries = recapsBySession.get(sessionId);
  if (entries === undefined) return null;
  for (const entry of entries) {
    if (entry.turn === turn) return entry.text;
  }
  return null;
}

/**
 * turnTail 条目：渲染一行 dim/italic 的回顾。
 *
 * 入参由槽位合并：ownerProps `{turn: TurnLocation, seq, openFile}` + standardProps
 * （含 `sessionId`）。`turn` 缺失（非回合节点）或该回合没有回顾时返回 null——
 * 槽位条目返回 null 不占位，因此普通回合不会多出空行。
 * @param props - 槽位 props。
 */
export function RecapLine(props: {
  readonly turn?: { readonly turn?: number } | null;
  readonly sessionId?: string;
}): ReactElement | null {
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : null;
  const turnNumber = typeof props.turn?.turn === 'number' ? props.turn.turn : null;
  const text = useSyncExternalStore(
    subscribe,
    () => (sessionId === null || turnNumber === null ? null : recapTextFor(sessionId, turnNumber)),
    () => null,
  );
  if (text === null) return null;
  return (
    <div className="fsr-recap" data-recap-turn={turnNumber ?? undefined} title={text}>
      <span className="fsr-recap-mark" aria-hidden="true">🐳：</span>
      <span className="fsr-recap-text">{text}</span>
    </div>
  );
}
