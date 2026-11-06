/**
 * 功能面 A：↑/↓ 召回本会话历史提示词。
 *
 * 往 `conversation.input.overlay`（**session 作用域**的 list slot）注册一个
 * 常驻列表项，由它接管输入框里的 ↑/↓。行为细节见 `Overlay.tsx`。
 *
 * 为什么「本会话」是白送的：slot 的 scope 是 `session`，切会话时 slot 条目
 * 连同作用域一起换掉，组件读到的快照自动就是新会话的 —— 所以这里不需要
 * 会话切换监听、历史缓存、跨会话隔离或任何持久化。
 */
import { createElement } from 'react'
import { RecallOverlay } from './Overlay.js'
import type { LoadOlderFn, SlotsServiceLike } from './types.js'

/** 本条目在 overlay 列表里的 id（不复用官方已占用的 id）。 */
export const RECALL_ENTRY_ID = 'foresight-recall'

/** 本功能面依附的 slot。 */
const OVERLAY_SLOT = 'conversation.input.overlay'

/**
 * 注册 ↑/↓ 召回功能面。
 *
 * @param slots - slot 服务。
 * @param effect - 把 disposer 挂到插件 fiber 上的登记函数。
 * @param getLoadOlder - 取「请宿主加载更早一页」的能力；宿主拿不到时返回 `undefined`，
 *   召回退化成「只翻已加载的窗口」，与旧版本行为一致。
 */
export function registerRecall(
  slots: SlotsServiceLike,
  effect: (cb: () => unknown, label?: string) => unknown,
  getLoadOlder: () => LoadOlderFn | undefined = () => undefined,
): void {
  effect(
    () =>
      slots.inject(OVERLAY_SLOT, () =>
        slots.register({ name: OVERLAY_SLOT, id: RECALL_ENTRY_ID, order: 80 }, (props) =>
          // 每次渲染重新取：服务可能晚于注册才就绪（`ctx.inject` 回调是异步的）。
          createElement(RecallOverlay, { ...(props as object), loadOlder: getLoadOlder() } as never),
        ),
      ),
    'foresight: recall overlay',
  )
}
