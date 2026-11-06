/**
 * 纯逻辑统一出口 —— 只给**单元测试**用。
 *
 * | 文件 | 负责 |
 * |---|---|
 * | `recall.ts` | 召回的行为：历史怎么提取、一次方向键怎么动游标 |
 * | `keyGate.ts` | 一次按键要不要接管（修饰键 / IME / 限域 / 相位） |
 *
 * 这里只做 re-export，构建成 `lib/recall-logic.js`（普通 ESM）后 `node --test` 可以直接跑，
 * 不需要浏览器、React 或 cordis。浏览器半区是 CJS 且依赖 `window`，Node 里没法直接 import，
 * 让测试去 import 它会把 React 和整棵 DOM 逻辑都拖进来，所以单独一个入口。
 */
export { HISTORY_LIMIT, atEarliest, extractHistory, rebaseCursor, step } from './recall.js'
export type { Navigation, StepResult } from './recall.js'
export { gateKey } from './keyGate.js'
export type { KeyGateEnv, KeyGateReason, KeyStroke, KeyVerdict } from './keyGate.js'
