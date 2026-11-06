/**
 * `gateKey` 的测试 —— 「这次按键要不要接管」的全部规则。
 *
 * 这些规则以前散在 `Overlay.tsx` 的 keydown 回调里、混着 DOM 读取，只能靠真机
 * 手点。抽成纯函数后这里逐条钉住：**每条规则挡住时返回的是哪个 reason** ——
 * 只看 `takeOver === false` 分不出「规则挡住了」和「压根没跑」。
 *
 * 跑：`pnpm test`（先 `pnpm build`，测试跑的是 `lib/logic.js` 产物）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gateKey } from '../lib/recall-logic.js'

/** 一次「理想的」方向键：空草稿、plain 相位、目标在 composer 卡片内且可编辑。 */
const stroke = (over = {}) => ({
  key: 'ArrowUp',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  keyCode: 38,
  ...over,
})

/** 理想的现场：可编辑、在作用域内、相位 plain、inputActions 可用。 */
const env = (over = {}) => ({
  editable: true,
  inComposerScope: true,
  phase: 'plain',
  hasInputActions: true,
  ...over,
})

test('gateKey：理想情况下接管', () => {
  assert.deepEqual(gateKey(stroke(), env()), { takeOver: true, reason: 'ok' })
  assert.deepEqual(gateKey(stroke({ key: 'ArrowDown', keyCode: 40 }), env()), { takeOver: true, reason: 'ok' })
})

test('gateKey：非方向键不接管', () => {
  assert.deepEqual(gateKey(stroke({ key: 'a', keyCode: 65 }), env()), { takeOver: false, reason: 'not-arrow' })
})

test('gateKey：任何修饰键都不接管（Ctrl / Meta / Alt / Shift）', () => {
  for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
    assert.deepEqual(gateKey(stroke({ [mod]: true }), env()), { takeOver: false, reason: 'modifier' }, `${mod} 应被挡住`)
  }
})

test('gateKey：Shift+↑ 不接管（留给编辑器选中文本）', () => {
  // 这条是补上的：旧实现只挡 Ctrl/Meta/Alt，Shift+↑ 会被抢走，选区扩不动。
  assert.equal(gateKey(stroke({ shiftKey: true }), env()).takeOver, false)
})

test('gateKey：IME 组字期不接管（isComposing 或 keyCode 229）', () => {
  assert.deepEqual(gateKey(stroke({ isComposing: true }), env()), { takeOver: false, reason: 'composing' })
  assert.deepEqual(gateKey(stroke({ keyCode: 229 }), env()), { takeOver: false, reason: 'composing' })
})

test('gateKey：目标不可编辑不接管', () => {
  assert.deepEqual(gateKey(stroke(), env({ editable: false })), { takeOver: false, reason: 'not-editable' })
})

test('gateKey：事件不在本 composer 卡片内不接管（限域）', () => {
  assert.deepEqual(gateKey(stroke(), env({ inComposerScope: false })), { takeOver: false, reason: 'out-of-scope' })
})

test('gateKey：拿不到 inputActions 不接管', () => {
  assert.deepEqual(gateKey(stroke(), env({ hasInputActions: false })), { takeOver: false, reason: 'no-input-actions' })
})

test('gateKey：相位不是 plain 不接管（提交中/裁决中改写草稿会被拒绝或丢失）', () => {
  for (const phase of ['submitting', 'pending', '', undefined]) {
    assert.deepEqual(gateKey(stroke(), env({ phase })), { takeOver: false, reason: 'phase' }, `相位 ${String(phase)} 应被挡住`)
  }
})

test('gateKey：判定顺序稳定 —— 方向键与修饰键先于 DOM 事实', () => {
  // 组合最坏情况：全都成立时，先被 key 挡住，而不是被 DOM 事实挡住。
  // 顺序即优先级，改顺序会让这里的 reason 变化 —— 那是有意的信号。
  const bad = { editable: false, inComposerScope: false, phase: 'pending', hasInputActions: false }
  assert.equal(gateKey(stroke({ key: 'Enter' }), bad).reason, 'not-arrow')
  assert.equal(gateKey(stroke({ ctrlKey: true }), bad).reason, 'modifier')
  assert.equal(gateKey(stroke({ isComposing: true }), bad).reason, 'composing')
  assert.equal(gateKey(stroke(), bad).reason, 'not-editable')
  assert.equal(gateKey(stroke(), { ...bad, editable: true }).reason, 'out-of-scope')
  assert.equal(gateKey(stroke(), { ...bad, editable: true, inComposerScope: true }).reason, 'no-input-actions')
  assert.equal(gateKey(stroke(), { ...bad, editable: true, inComposerScope: true, hasInputActions: true }).reason, 'phase')
})
