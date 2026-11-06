/**
 * 「这次按键要不要接管」的判定 —— 纯逻辑，Node 里可直接测。
 *
 * ## 为什么把它从组件里抽出来
 *
 * 接管条件原来散在 `client/recall/Overlay.tsx` 的 keydown 回调里，而回调里
 * 混着 DOM 读取（`closest` / `isContentEditable`），所以 `node --test` 一条都
 * 测不到 —— 只能靠真机点。抽出来之后：
 *
 * - 本函数只吃「事实」（按键事实 + 现场事实），不碰 DOM、不 import React；
 * - 组件只负责把 DOM 事实读出来喂进来、以及执行 `setDraft`。
 *
 * ## 每条规则都是一次踩坑
 *
 * | 规则 | 为什么 |
 * |---|---|
 * | 只认 `ArrowUp` / `ArrowDown` | 其它键不归插件管 |
 * | 带 `Ctrl` / `Meta` / `Alt` 不接管 | 别的插件/系统在用（如 Alt+↑ 逐轮跳转） |
 * | 带 `Shift` 不接管 | Shift+↑/↓ 是编辑器**选中文本**，抢过来会破坏选区 |
 * | IME 组字期（`isComposing` / `keyCode 229`）不接管 | 中文输入法正在用 ↑/↓ 选候选词 |
 * | 目标必须可编辑 | 侧边栏、弹窗、菜单里的方向键照旧 |
 * | 目标必须在**本插件所在的 composer 卡片**内 | 限域：别的输入框（对话框等）不受影响 |
 * | 相位必须是 `plain` | 提交中/裁决中改写草稿会被拒绝或丢失 |
 * | `inputActions` 必须在 | 拿不到 `setDraft` 就什么都做不了 |
 *
 * ## 返回值里为什么带 reason
 *
 * 这个插件吃过「静默失效」的亏（宿主换类名 → 排版悄悄退回）。接管被拒时
 * 带上原因，出问题时能一眼区分「规则挡住了」和「规则没跑」—— 单元测试也靠它
 * 断言「是哪一条规则挡的」，而不是只看一个 false。
 */

/** 一次方向键按键的**事实**（从 `KeyboardEvent` 里取，不含 DOM 查询）。 */
export interface KeyStroke {
  /** `KeyboardEvent.key`。 */
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  /** `KeyboardEvent.isComposing`：Safari 在提交键的 keydown 上会清掉它，所以要配合 keyCode 229。 */
  readonly isComposing: boolean
  /** 兼容用：部分输入法在组字期把 keyCode 记成 229。 */
  readonly keyCode: number
}

/** 接管时必须成立的**现场条件**（由组件读 DOM / 快照后喂进来）。 */
export interface KeyGateEnv {
  /** 事件目标自身可编辑。 */
  readonly editable: boolean
  /** 事件发生在**本插件所在的那张 composer 卡片**内部。 */
  readonly inComposerScope: boolean
  /** 输入相位；只有 `'plain'` 时草稿可安全改写。 */
  readonly phase: string | undefined
  /** `inputActions`（`setDraft` 的来源）可用。 */
  readonly hasInputActions: boolean
}

/** 判定结果。`reason` 是稳定字符串，测试与排查都按它来。 */
export interface KeyVerdict {
  /** 是否接管这次按键（调用方据此 `preventDefault` 并写草稿）。 */
  readonly takeOver: boolean
  /** 判定依据：接管时是 `'ok'`，拒绝时是被哪一条挡住的。 */
  readonly reason: KeyGateReason
}

/** 拒绝原因（稳定枚举，用于测试断言与排查）。 */
export type KeyGateReason =
  | 'ok'
  | 'not-arrow'
  | 'modifier'
  | 'composing'
  | 'not-editable'
  | 'out-of-scope'
  | 'phase'
  | 'no-input-actions'

/**
 * 判定一次方向键能否被召回接管。
 *
 * @param stroke - 按键事实。
 * @param env - 现场事实。
 * @returns 是否接管，以及依据。
 */
export function gateKey(stroke: KeyStroke, env: KeyGateEnv): KeyVerdict {
  if (stroke.key !== 'ArrowUp' && stroke.key !== 'ArrowDown') return { takeOver: false, reason: 'not-arrow' }
  if (stroke.ctrlKey || stroke.metaKey || stroke.altKey || stroke.shiftKey) return { takeOver: false, reason: 'modifier' }
  if (stroke.isComposing || stroke.keyCode === 229) return { takeOver: false, reason: 'composing' }
  if (!env.editable) return { takeOver: false, reason: 'not-editable' }
  if (!env.inComposerScope) return { takeOver: false, reason: 'out-of-scope' }
  if (!env.hasInputActions) return { takeOver: false, reason: 'no-input-actions' }
  if (env.phase !== 'plain') return { takeOver: false, reason: 'phase' }
  return { takeOver: true, reason: 'ok' }
}
