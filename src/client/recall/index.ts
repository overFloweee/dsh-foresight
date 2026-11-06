/**
 * ↑/↓ 召回的浏览器入口：往 `conversation.input.overlay` 注册一个常驻条目，接管输入框里的 ↑/↓。
 * 行为细节见 `Overlay.tsx`，按键判定见 `keyGate.ts`。
 *
 * 只用 `slots` 和 `sessions` 两个服务，二者都已在合并入口的 `inject` 里声明，这里一律用
 * `ctx.get` 读取，不使用 `ctx.inject` 软依赖：严格门控的宿主会在读取未声明的 `ctx.inject`
 * 时直接抛错。
 */
import { registerRecall } from './register.js'
import type { LoadOlderFn, RecallContextLike, SessionsServiceLike } from './types.js'

/** 召回需要的客户端服务。 */
export const inject = ['slots', 'sessions']

/**
 * 造一个「请宿主再加载一页更早历史」的能力。
 *
 * `loadOlder()` 挂在**会话作用域**的 `conversation` 服务上，而客户端根上下文只有 `sessions`，
 * 所以按键时再按 `sessionId` 取会话作用域里的 `conversation`。任意一层缺席（旧宿主、服务未就绪）
 * 都返回 `undefined`，召回自然退回「只翻已加载的窗口」。
 *
 * @param ctx - 客户端根上下文。
 * @returns 每次调用都重新取的服务提供者（服务可能晚于注册才就绪）。
 */
function createLoadOlderProvider(ctx: RecallContextLike): () => LoadOlderFn | undefined {
  return () => {
    const sessions = ctx.get?.('sessions') as SessionsServiceLike | undefined
    if (sessions?.scope === undefined) return undefined
    return async (sessionId: string): Promise<boolean> => {
      const scoped = sessions.scope?.(sessionId)
      const conversation = scoped?.get?.('conversation') as { loadOlder?: () => Promise<unknown> } | undefined
      if (conversation?.loadOlder === undefined) return false
      await conversation.loadOlder()
      return true
    }
  }
}

/**
 * 激活 ↑/↓ 召回。
 *
 * @param ctx - 客户端根上下文。
 */
export function applyRecall(ctx: RecallContextLike): void {
  const effect = (callback: () => unknown, label?: string): unknown => ctx.effect(callback, label)
  registerRecall(ctx.slots, effect, createLoadOlderProvider(ctx))
}
