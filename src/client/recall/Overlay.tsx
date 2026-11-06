/**
 * ↑/↓ 召回本会话历史提示词 —— `conversation.input.overlay` 列表项组件。
 *
 * 行为（就这些，没有别的）：
 * - **↑**：草稿为空时进入浏览，回填最近一条已发送的提示词；继续 ↑ 往更早翻。
 * - **↓**：往更近翻；越过最新一条时，恢复你进入浏览前正在打的草稿。
 * - 一旦你手动编辑草稿，或提交开始，浏览立即退出（已回填的内容留在输入框里，
 *   也就是终端里「召回后直接改」的手感）。
 *
 * 三个设计要点：
 *
 * 1. **历史是「本会话」的，而且是白送的**。本组件挂在
 *    `conversation.input.overlay`，这个 slot 的 scope 是 `session`，
 *    所以 `useChat` 读到的就是当前会话的快照。切开会话时 slot 条目连同
 *    作用域一起换掉，我们不用自己监听会话切换。
 *
 * 2. **键盘拦截严格限域**。事件必须来自「本组件所在的那张 composer 卡片
 *    内部、且是 contentEditable 的元素」。这样只影响输入框，不会抢走
 *    侧边栏、弹窗、斜杠菜单的方向键。同时避开 IME 组字期（中文输入法
 *    正在选字时按 ↑/↓ 是在选候选词）与任何修饰键组合（含 Shift —— 那是
 *    编辑器在选中文本）。判定规则本身住在 `core/keyGate.ts`，可单测。
 *
 * 3. **只在草稿为空时接管 ↑**。草稿非空时斜杠菜单 / @引用菜单正在用
 *    ↑/↓ 选条目，抢过来会打架；而且这也符合终端的直觉。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { atEarliest, extractHistory, rebaseCursor, step } from './recall.js'
import type { Navigation } from './recall.js'
import { gateKey } from './keyGate.js'
import type { ChatSnapshotLike, InputActionsLike, InputStateLike, LoadOlderFn, OverlaySlotProps } from './types.js'

/** 官方输入框卡片上的锚点属性（宿主 `InputBar` 挂在卡片 div 上）。 */
const COMPOSER_CARD_ATTR = 'data-composer-card'

/**
 * 降级时从锚点往上找几层祖先。
 *
 * 锚点 div 就在卡片内部（overlay 的定义是「渲染在 composer 卡片里的浮动条目」），
 * 实测卡片在锚点上方 2~3 层。给到 6 层足够够到，又不会一路找到 `body` 把限域放开。
 */
const FALLBACK_SCOPE_DEPTH = 6

/** 降级提示只打一次，别每次按键都刷控制台。 */
let warnedMissingCard = false

/**
 * 找出「本次按键被允许作用的那张 composer 卡片」。
 *
 * 正常路径是官方属性 `[data-composer-card]`（官方自己的点外关闭与 toast 定位也用它，
 * 属于事实契约）。但它是**内部 DOM 契约**：上游一旦改名或改结构，`closest` 就返回
 * null —— 旧实现此时直接 return，表现为「↑/↓ 突然没反应」，没有任何报错。
 *
 * 所以这里降级：从 overlay 锚点往上找几层，够到一张包含可编辑区的祖先容器就继续
 * 接管（限域仍在，只是判据从属性变成祖先范围；走到 `body` 就停手 —— 那等于放开限域），
 * 并把这次降级**说出来** —— 一次 `console.warn`，不静默。
 *
 * 两道闸的关系：`scripts/probe-host.mjs`（`pnpm run probe:host`）扫宿主产物里这个属性的存在性（第一道）；这里的降级是第二道 —— 第一道没拦住时，功能降级而不是归零。
 *
 * @param anchor - overlay 列表项的锚点元素。
 * @returns 作用域容器；正常与降级都找不到时返回 null（调用方不接管）。
 */
function composerScope(anchor: HTMLElement): HTMLElement | null {
  const card = anchor.closest(`[${COMPOSER_CARD_ATTR}]`)
  if (card instanceof HTMLElement) return card

  if (!warnedMissingCard) {
    warnedMissingCard = true
    console.warn(
      `[dsh-foresight] 宿主输入框卡片上找不到 [${COMPOSER_CARD_ATTR}]，` +
        '召回已降级为「锚点祖先范围内接管」。请更新 scripts/probe-host.mjs 的 DOM 契约清单，' +
        '并把新属性补进 src/client/recall/Overlay.tsx。',
    )
  }

  let el: HTMLElement | null = anchor.parentElement
  for (let depth = 0; depth < FALLBACK_SCOPE_DEPTH && el !== null; depth += 1) {
    // 绝不把 body / html 当作用域：overlay 若被 portal 到页根，一路向上就会走到
    // body —— 那等于把限域放开成「页面上任何可编辑区」，比不接管更糟。
    if (el === document.body || el === document.documentElement) break
    // 可编辑区的形态不止一种（contenteditable="" / "true" / "plaintext-only"），
    // 所以只排除显式的 "false"。
    if (el.querySelector('[contenteditable]:not([contenteditable="false"])') !== null) return el
    el = el.parentElement
  }
  return null
}

/** 浏览中的位置角标：浮在 composer 卡片右上角，不可交互、不挡点击。 */
const pillStyle: CSSProperties = {
  position: 'absolute',
  top: 6,
  right: 12,
  zIndex: 6,
  pointerEvents: 'none',
  userSelect: 'none',
  whiteSpace: 'nowrap',
  fontSize: 12,
  lineHeight: '16px',
  padding: '2px 8px',
  borderRadius: 999,
  background: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.18))',
  color: 'var(--dsw-alias-label-secondary, inherit)',
}

/**
 * 安装键盘监听。抽成独立函数是为了让组件体保持短。
 *
 * 用**捕获阶段**（`true`）监听 `document`：编辑器的默认行为（以及可能存在的
 * 其他监听）在冒泡阶段就可能把光标移走，捕获阶段先下手才能可靠接管。
 *
 * @param anchor - composer 卡片内的锚点 ref。
 * @param latest - 每次提交后更新的「最新值」盒子（layout effect 里同步）。
 * @param nav - 浏览游标。
 * @param bump - 触发重渲染（刷新位置角标）。
 * @param requestOlder - 请宿主再加载一页更早的历史（翻到最早一条时用）。
 */
function useArrowKeys(
  anchor: { readonly current: HTMLDivElement | null },
  latest: {
    readonly current: {
      history: readonly string[]
      phase: string | undefined
      draft: string
      inputActions: InputActionsLike | undefined
      loadOlder: LoadOlderFn | undefined
    }
  },
  nav: { readonly current: Navigation },
  bump: () => void,
  requestOlder: () => void,
): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      // 先按 key 短路：绝大多数按键不是方向键，不该为此付 DOM 查询的钱。
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return

      const node = anchor.current
      if (node === null) return

      // 限域：事件目标必须落在本组件所在的 composer 卡片内，且是可编辑元素。
      const target = event.target
      const scope = composerScope(node)
      const verdict = gateKey(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          isComposing: event.isComposing,
          keyCode: event.keyCode,
        },
        {
          editable: target instanceof HTMLElement && target.isContentEditable,
          inComposerScope: scope !== null && target instanceof Node && scope.contains(target),
          phase: latest.current.phase,
          hasInputActions: latest.current.inputActions !== undefined,
        },
      )
      if (!verdict.takeOver) return

      const { history, draft, inputActions } = latest.current
      // gateKey 已经保证这两条成立；这里显式再判一次是为了收窄类型，
      // 顺便把「拿不到就别改」写成判断而不是 `!`。
      if (inputActions === undefined || latest.current.phase !== 'plain') return

      // 已加载窗口的最早一条：再往上就没有数据了，先请宿主拉一页更早的历史。
      // 按键必须在这里吃掉 —— 否则默认行为会把光标移到行首，看起来像「没反应」。
      // 加载回来后由组件里的 rebase effect 改写游标并写草稿（见 RecallOverlay）。
      //
      // 注意这里**不能**再要求草稿为空：浏览到最早一条时，草稿里放着的正是
      // history[0] 那条提示词，非空。要求草稿为空会让翻页永远不触发。
      // 空历史同样排除（that 是「这个会话还没有提示词」，↑ 该留给编辑器）。
      if (
        event.key === 'ArrowUp' &&
        history.length > 0 &&
        atEarliest(nav.current, history.length)
      ) {
        requestOlder()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      const result = step(event.key as 'ArrowUp' | 'ArrowDown', nav.current, history, draft)
      if (!result.handled) return

      if (result.next !== undefined) {
        nav.current.selfWrite = true
        inputActions.setDraft(result.next)
      }
      event.preventDefault()
      event.stopPropagation()
      bump()
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [anchor, latest, nav, bump, requestOlder])
}

/** 连续多少页「加载了但没有新提示词」才判定到底：工具调用极密的会话，一页 500 条
 * 消息里可能只有工具输出，过早判定会让人明明还能往前翻却停住。 */
const EMPTY_PAGE_LIMIT = 3

/** 翻页状态：宿主一次只给一页，翻页期间要防重入、并记住「旧游标」等加载后改写。 */
interface PagingState {
  /** 正在等宿主返回一页。 */
  loading: boolean
  /** 已确认没有更早的了（连续多页没有新数据）。 */
  exhausted: boolean
  /** 发起翻页时的游标与历史长度；加载回来据此改写游标。 */
  pending: { index: number; length: number } | null
  /** 连续「加载了但提示词没变多」的页数（用于判定到底，见 EMPTY_PAGE_LIMIT）。 */
  emptyPages: number
  /** 上一次看到的历史长度（用于识别「变长了」→ 解除 exhausted）。 */
  lastLength: number
  /** 宿主答应了但历史迟迟不变时的兜底定时器。 */
  timer: ReturnType<typeof setTimeout> | undefined
}

/** overlay 列表项：常态是空锚点，浏览中多渲染一个位置角标。 */
export function RecallOverlay(props: OverlaySlotProps): ReactElement {
  const { useChat, useInput, inputActions, loadOlder, sessionId } = props

  // 数据源。选择器返回的数组引用稳定时不触发重渲染。
  const nodes = useChat?.((snapshot: ChatSnapshotLike) => snapshot.legacy.nodes)
  const phase = useInput?.((snapshot: InputStateLike) => snapshot.phase)
  const draft = useInput?.((snapshot: InputStateLike) => snapshot.draft)

  const history = useMemo(() => (nodes === undefined ? [] : extractHistory(nodes)), [nodes])

  const anchor = useRef<HTMLDivElement | null>(null)
  const nav = useRef<Navigation>({ index: null, backup: '', selfWrite: false })
  const [, setTick] = useState(0)
  // bump 必须引用稳定：它进了 useArrowKeys 的依赖数组，每次渲染换新函数
  // 会导致键盘监听被反复卸载/重装。
  const bump = useCallback((): void => setTick((tick) => tick + 1), [])

  // 事件回调里要读的最新值。每次提交后同步一次。
  //
  // 放在 layout effect 而不是渲染期直接赋值：渲染期写 ref 在 React 18 的并发
  // 渲染下可能留下**被丢弃那一版**的值 —— 极端情况下一次按键用的是过期草稿。
  // layout effect 在提交后、浏览器绘制前跑，按键事件只会更晚到达。
  const latest = useRef({ history: history as readonly string[], phase, draft: draft ?? '', inputActions, loadOlder })
  useLayoutEffect(() => {
    latest.current = { history, phase, draft: draft ?? '', inputActions, loadOlder }
  })

  /** 退出浏览并清空游标（不还草稿）。 */
  const exitBrowse = useCallback((): void => {
    if (nav.current.index === null) return
    nav.current.index = null
    nav.current.backup = ''
    bump()
  }, [bump])

  const paging = useRef<PagingState>({
    loading: false,
    exhausted: false,
    pending: null,
    emptyPages: 0,
    lastLength: 0,
    timer: undefined,
  })

  /** 请宿主再加载一页更早的历史；翻页期间与到底之后都不重复发。 */
  const requestOlder = useCallback((): void => {
    const state = paging.current
    if (state.loading || state.pending !== null || state.exhausted) return
    const load = latest.current.loadOlder
    if (load === undefined) return // 宿主拿不到 conversation.loadOlder：退回旧行为（只翻已加载的窗口）
    state.loading = true
    state.pending = { index: nav.current.index ?? 0, length: latest.current.history.length }
    bump()
    void load(sessionId ?? '')
      .catch(() => false)
      .then((started) => {
        if (!started) {
          state.pending = null
          state.loading = false
          state.exhausted = true
          bump()
          return
        }
        // 宿主答应了，但快照是异步回来的：给 2s 兜底，历史没变长就记一次空页，
        // 连续空页达到上限才判定到底（见 EMPTY_PAGE_LIMIT）。
        state.timer = setTimeout(() => {
          if (state.pending === null) return
          state.pending = null
          state.loading = false
          state.emptyPages += 1
          if (state.emptyPages >= EMPTY_PAGE_LIMIT) state.exhausted = true
          bump()
        }, 2000)
      })
  }, [bump, sessionId])

  // 历史变长 = 宿主把更早的一页递过来了：把游标挪到「旧位置再往前一条」。
  useEffect(() => {
    const state = paging.current
    if (state.pending !== null && state.pending.length !== history.length) {
      const rebased = rebaseCursor(state.pending.index, state.pending.length, history.length)
      if (state.timer !== undefined) {
        clearTimeout(state.timer)
        state.timer = undefined
      }
      state.pending = null
      state.loading = false
      state.emptyPages = 0
      const entry = rebased === null ? undefined : history[rebased]
      if (rebased === null || entry === undefined) {
        state.exhausted = true
      } else {
        nav.current.index = rebased
        nav.current.selfWrite = true
        inputActions?.setDraft(entry)
      }
      bump()
    }
    if (history.length > state.lastLength) state.exhausted = false
    state.lastLength = history.length
  }, [history, inputActions, bump])

  // 切开会话：游标与翻页状态一律作废（历史本身随 session 作用域的 useChat 自动切换）。
  useEffect(() => {
    exitBrowse()
    const state = paging.current
    if (state.timer !== undefined) clearTimeout(state.timer)
    paging.current = { loading: false, exhausted: false, pending: null, emptyPages: 0, lastLength: 0, timer: undefined }
  }, [sessionId, exitBrowse])

  // 卸载：别把兜底定时器留在后台。
  useEffect(
    () => () => {
      const timer = paging.current.timer
      if (timer !== undefined) clearTimeout(timer)
    },
    [],
  )

  // 草稿变了但不是我写的 → 用户开始编辑，退出浏览（已回填的内容留着）。
  useEffect(() => {
    if (nav.current.selfWrite) {
      nav.current.selfWrite = false
      return
    }
    exitBrowse()
  }, [draft, exitBrowse])

  // 提交开始（相位离开 plain）→ 退出浏览。
  useEffect(() => {
    if (phase !== undefined && phase !== 'plain') exitBrowse()
  }, [phase, exitBrowse])

  useArrowKeys(anchor, latest, nav, bump, requestOlder)

  const index = nav.current.index
  const loading = paging.current.loading
  const label =
    index === null
      ? loading
        ? '↑↓ …'
        : null
      : `↑↓ ${index + 1}/${history.length}${loading ? ' …' : ''}`
  return (
    <div ref={anchor}>
      {label === null ? null : <div style={pillStyle}>{label}</div>}
    </div>
  )
}
