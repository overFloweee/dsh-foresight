/**
 * dsh-foresight 浏览器端入口：把两个功能面挂在同一个客户端插件上。
 *
 * - 预测（`./index.ts`）：输入预测、历史补全、回合回顾、设置卡片。
 * - ↑/↓ 召回（`./recall`）：草稿为空时按 ↑/↓ 翻本会话发过的提示词。
 *
 * 两边各自 try/catch：一边加载失败只丢它自己的功能，不拖垮另一边。
 * `inject` 取两边的并集；服务缺失在客户端是硬依赖（整个插件 pending），所以只声明真正必需的。
 * @module dsh-foresight/client/main
 */
import type { Context } from '@deepseek-ai/cordis';
import { apply as applyPrediction, inject as predictionInject } from './index.ts';
import { applyRecall, inject as recallInject } from './recall/index.ts';
import type { RecallContextLike } from './recall/types.ts';

/** 插件名：与 manifest 的包名一致。 */
export const name = 'dsh-foresight';

/** 两个功能面所需客户端服务的并集（去重、保持声明顺序）。 */
export const inject: string[] = [...new Set([...predictionInject, ...recallInject])];

/** 取一个可用的 warn 通道；上下文没有 logger 时静默。 */
function warnOf(ctx: Context): (message: string) => void {
  const logger = (ctx as unknown as { logger?: { warn?: (message: string) => void } }).logger;
  return (message) => {
    try {
      logger?.warn?.(message);
    } catch {
      // 日志通道本身失败时不再向外抛。
    }
  };
}

/**
 * 激活两个功能面。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: Context): void {
  const warn = warnOf(ctx);
  try {
    applyPrediction(ctx);
  } catch (error) {
    warn(`dsh-foresight: prediction failed to mount: ${String(error)}`);
  }
  try {
    applyRecall(ctx as unknown as RecallContextLike);
  } catch (error) {
    warn(`dsh-foresight: recall failed to mount: ${String(error)}`);
  }
}
