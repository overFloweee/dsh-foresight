/**
 * 结构契约类型 —— ↑/↓ 召回所需的最小面。
 *
 * 全部是结构类型，只 `import type`、不 import 官方运行时的值：一旦有值导入，打包器会内联一份
 * 重复运行时（两份 cordis、两份 React），插件会以难以排查的方式失效（构建脚本会检查产物里没有
 * `@deepseek-ai/`）。字段逐个对着已安装的 DSH 类型定义核过。
 */

/** 客户端根上下文的最小面：只声明真正用到的成员。 */
export interface RecallContextLike {
  /** 注册一个随插件卸载一起清理的副作用。 */
  effect(callback: () => unknown, label?: string): unknown
  slots: SlotsServiceLike
  /** 按 key 读服务。 */
  get?(key: string): unknown
}

/** sessions 服务的最小面。 */
export interface SessionsServiceLike {
  /**
   * 取某个会话的上下文（服务在该作用域里各有一份）。
   *
   * 召回用它找 `conversation` 服务，再调 `loadOlder()` 拉更早的历史页。
   * 0.2.x 实测存在；万一上游拿掉，召回退化成「只翻已加载的窗口」，不会炸。
   */
  scope?(sessionId: string): SessionScopeLike | undefined
}

/** 会话作用域上下文的最小面：只用来按 key 取服务。 */
export interface SessionScopeLike {
  get?(key: string): unknown
}

/**
 * 一个 slot 条目的注册选项。
 *
 * `id` 的语义（官方原文）：用自己的新 id 是「加在旁边」，复用已占用的 id 是「替换掉它」，
 * 所以永远用新 id。
 */
export interface SlotEntryOptions {
  /** 目标 slot 键（必填）。 */
  name: string
  /** 本条目在该 slot 里的 cell key。 */
  id?: string
  /** 在条目之间的升序位置，默认 0。 */
  order?: number
}

/**
 * slots 服务的最小面。
 *
 * `component` 收 `(props: never) => unknown` 而不是 `unknown`：后者会让传入的箭头函数拿不到
 * 上下文类型，`props` 变成隐式 `any`，`strict` 下直接报错。
 */
export interface SlotsServiceLike {
  /** 等某个 slot 被声明后再执行注册；返回幂等 disposer。 */
  inject(key: string, callback: () => unknown): () => void
  /** 往已声明的 slot 注册条目；返回 disposer。 */
  register(options: SlotEntryOptions, component: (props: never) => unknown): () => void
}

/** 快照选择器 hook：`useChat((snapshot) => value)`。 */
export type SnapshotSelectorHook<Snapshot> = <Result>(
  select: (snapshot: Snapshot) => Result,
  isEqual?: (a: Result, b: Result) => boolean,
) => Result

/** Chat 目标快照（只取兼容投影里的节点数组）。 */
export interface ChatSnapshotLike {
  readonly legacy: {
    readonly nodes: readonly unknown[]
  }
}

/** 已发布的输入机状态（只取草稿与相位）。 */
export interface InputStateLike {
  /** 编辑器文档的纯文本投影。 */
  readonly draft: string
  /** 相位；只有 `plain` 时草稿才可安全改写。 */
  readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting'
}

/** 会话作用域 slot 组件可用的公开输入动作。 */
export interface InputActionsLike {
  /** 整体替换草稿。 */
  setDraft(text: string): void
}

/**
 * `conversation.input.overlay` 列表项组件收到的 props。
 *
 * 会话标准 props（`sessionId` / `useChat` / `useInput` / `inputActions`）由 slot 运行时注入；
 * `loadOlder` 是本插件自己塞进来的能力（见 `register.ts`），用来在翻到最早一条时请宿主再加载一页历史。
 */
export interface OverlaySlotProps {
  readonly sessionId?: string | undefined
  readonly useChat?: SnapshotSelectorHook<ChatSnapshotLike> | undefined
  readonly useInput?: SnapshotSelectorHook<InputStateLike> | undefined
  readonly inputActions?: InputActionsLike | undefined
  readonly loadOlder?: LoadOlderFn | undefined
}

/**
 * 请宿主为某个会话加载更早一页历史。
 *
 * @param sessionId - 目标会话。
 * @returns 是否真的发起了加载（`false` = 当前宿主拿不到 `conversation.loadOlder`）。
 */
export type LoadOlderFn = (sessionId: string) => Promise<boolean>
