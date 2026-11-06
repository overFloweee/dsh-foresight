/**
 * 纯逻辑层 —— 不 import React、不碰 DOM。
 *
 * 本插件的全部行为都收敛在这两个函数里：`extractHistory` 决定「历史是什么」，
 * `step` 决定「一次方向键该怎么动游标、该写什么草稿」。UI 层（`client/recall/Overlay.tsx`）
 * 只负责把它们接到键盘事件与 `setDraft` 上。
 *
 * 这样拆的两个好处：可以脱离浏览器用 `node --test` 直接测；
 * 构建测试产物时不会把 React 拖进来。
 *
 * **本文件零依赖**：连类型都不从别处 import。它只解析「`legacy.nodes` 里长什么
 * 样」，所以描述那个形状的类型就该定义在这里，而不是放到 client 层再反向引用。
 */

/** 内容块：只需要认出文本块（`{ type: 'text', text: string }`）。 */
interface ContentBlockLike {
  readonly type: unknown
  readonly text?: unknown
}

/**
 * 会话里一条已定稿的人类消息。
 *
 * `user` = 常规用户消息；`steering` = 回合运行中插入的用户消息。
 */
interface PromptMessageLike {
  readonly kind: 'user' | 'steering'
  readonly content: readonly ContentBlockLike[]
}

/** 最多保留多少条历史（超出丢弃最早的）。本会话内 200 条够用了。 */
export const HISTORY_LIMIT = 200

/**
 * 浏览游标。放在 ref 而不是 state 里，因为箭头可能连按，
 * 事件回调里必须读到**最新**的值，不能读到那次渲染的闭包快照。
 */
export interface Navigation {
  /** 当前浏览到的历史下标；`null` 表示没在浏览。 */
  index: number | null
  /** 进入浏览前的草稿，越过最新一条时原样还给你。 */
  backup: string
  /** 一次性标记：下一次 draft 变化是我自己写进去的，别当成「用户开始编辑」。 */
  selfWrite: boolean
}

/** {@link step} 的返回值。 */
export interface StepResult {
  /** 是否接管这次按键。为假时调用方不要动事件。 */
  handled: boolean
  /** 要写入的草稿；`undefined` 表示只动游标、不改草稿（例如已翻到最早一条）。 */
  next?: string
}

/**
 * 从会话节点里提取用户提示词历史（时间正序）。
 *
 * 只认 `kind === 'user' | 'steering'` 的节点，把其中所有文本块拼起来；
 * 空白消息丢掉；**只去掉相邻重复**（连发两条一样的没必要占两格，
 * 但隔了几轮再发一次仍然应该各占一格）。
 *
 * @param nodes - `useChat` 快照里的 `legacy.nodes`。
 * @returns 正序的历史数组，最多 {@link HISTORY_LIMIT} 条。
 */
export function extractHistory(nodes: readonly unknown[]): string[] {
  const out: string[] = []
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue
    const kind = (node as { kind?: unknown }).kind
    if (kind !== 'user' && kind !== 'steering') continue
    const message = node as PromptMessageLike
    if (!Array.isArray(message.content)) continue
    let text = ''
    for (const block of message.content) {
      if (typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string') {
        text += block.text
      }
    }
    text = text.trim()
    if (text === '') continue
    if (out.length > 0 && out[out.length - 1] === text) continue
    out.push(text)
  }
  return out.length > HISTORY_LIMIT ? out.slice(-HISTORY_LIMIT) : out
}

/**
 * 处理一次方向键事件。
 *
 * 「是否接管 / 怎么移动游标 / 写什么草稿」都在这里决定；副作用（写草稿、
 * 阻止默认行为）由调用方做。`nav` 是**原地修改**的。
 *
 * 接管规则：
 * - `↑` 只在草稿为空时接管 —— 草稿非空时斜杠菜单 / @引用菜单正在用 ↑/↓
 *   选条目，抢过来会打架，而且「空输入框按 ↑ 翻历史」也符合终端直觉。
 * - `↓` 只在已经处于浏览中时接管 —— 否则把 ↓ 留给编辑器移动光标。
 *
 * @param key - `'ArrowUp'` 或 `'ArrowDown'`。
 * @param nav - 浏览游标，原地修改。
 * @param history - 历史数组，正序（最早的在前）。
 * @param draft - 当前草稿。
 * @returns 是否接管，以及要写入的草稿。
 */
export function step(
  key: 'ArrowUp' | 'ArrowDown',
  nav: Navigation,
  history: readonly string[],
  draft: string,
): StepResult {
  // 历史可能在浏览过程中被截短（比如会话被截断），先钳制游标，避免越界读。
  if (nav.index !== null && nav.index >= history.length) {
    nav.index = null
    nav.backup = ''
  }

  if (key === 'ArrowUp') {
    if (nav.index === null) {
      if (draft.trim() !== '' || history.length === 0) return { handled: false }
      nav.index = history.length - 1
      nav.backup = draft
      const entry = history[nav.index]
      return entry === undefined ? { handled: false } : { handled: true, next: entry }
    }
    // 已在最早一条：吃掉按键（否则默认行为会把光标移到行首），但不再写草稿。
    if (nav.index === 0) return { handled: true }
    nav.index -= 1
    const entry = history[nav.index]
    return entry === undefined ? { handled: false } : { handled: true, next: entry }
  }

  // ArrowDown：只有已经在浏览中才接管。
  if (nav.index === null) return { handled: false }
  const last = history.length - 1
  if (nav.index < last) {
    nav.index += 1
    const entry = history[nav.index]
    return entry === undefined ? { handled: false } : { handled: true, next: entry }
  }
  // 越过最新一条：原样还回进入浏览前的草稿，并退出浏览。
  const restored = nav.backup
  nav.index = null
  nav.backup = ''
  return { handled: true, next: restored }
}

/**
 * 游标是否卡在「已加载历史的最早一条」。
 *
 * 命中时再按 ↑ 已经没有更早的条目可去，只能请宿主再加载一页历史
 * （`conversation.loadOlder()`）。历史为空且没在浏览时也算命中：此时
 * 连一条都没加载出来，按键同样应该先去要数据，而不是被编辑器吃掉。
 *
 * @param nav - 浏览游标。
 * @param historyLength - 当前已加载的历史条数。
 * @returns 是否需要向宿主请求更早的历史。
 */
export function atEarliest(nav: Navigation, historyLength: number): boolean {
  if (nav.index === null) return historyLength === 0
  return nav.index === 0
}

/**
 * 宿主加载更早一页之后，把游标挪到「旧位置再往前一条」。
 *
 * 历史是**往前插**的：新加载的条目插在数组头部，旧下标整体后移
 * `shift = nextLength - previousLength`。用户按 ↑ 的意图是再看一条更早的，
 * 所以落点是 `previousIndex + shift - 1`。
 *
 * 返回 `null` 表示「没有更早的可翻了」：长度没增长（没有更多页，或被
 * `HISTORY_LIMIT` 截断），或参数不合法。调用方据此把该会话标记为到底，
 * 别在每次按键都重复请求。
 *
 * @param previousIndex - 加载前的游标下标。
 * @param previousLength - 加载前的历史条数。
 * @param nextLength - 加载后的历史条数。
 * @returns 新游标；无法前进时返回 `null`。
 */
export function rebaseCursor(previousIndex: number, previousLength: number, nextLength: number): number | null {
  if (previousIndex < 0 || previousLength < 0) return null
  const shift = nextLength - previousLength
  if (shift <= 0) return null
  const next = previousIndex + shift - 1
  if (next < 0) return 0
  return next > nextLength - 1 ? nextLength - 1 : next
}
