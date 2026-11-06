/**
 * `extractHistory` / `step` / `atEarliest` / `rebaseCursor` 的测试 —— 本插件的
 * 全部逻辑都在这几个纯函数里，UI 层只是把它们接到键盘事件和 `setDraft` 上。
 * `atEarliest` + `rebaseCursor` 服务「翻到窗口最早时再向宿主拉一页」：
 * 前者判断该不该要，后者在历史变长后把游标挪回原来的位置。
 *
 * 跑：`pnpm test`（先 `pnpm build`，测试直接跑 `lib/logic.js` 产物，
 * 顺带验证构建真的可用）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { atEarliest, extractHistory, rebaseCursor, step } from '../lib/recall-logic.js'

/** 造一条用户消息节点。 */
const user = (...blocks) => ({ kind: 'user', content: blocks })
/** 造一条文本块。 */
const text = (t) => ({ type: 'text', text: t })
/** 造一条 steering 消息节点。 */
const steering = (...blocks) => ({ kind: 'steering', content: blocks })

/** 新建一个未浏览的游标。 */
const fresh = () => ({ index: null, backup: '', selfWrite: false })

test('extractHistory：只收 user / steering，忽略其它节点', () => {
  const nodes = [
    user(text('第一条')),
    { kind: 'assistant', content: [text('助手的话不该进来')] },
    steering(text('运行中插的话')),
    { kind: 'tool-result', content: [text('工具输出也不该进来')] },
    user(text('第二条')),
    'not-an-object',
    null,
  ]
  assert.deepEqual(extractHistory(nodes), ['第一条', '运行中插的话', '第二条'])
})

test('extractHistory：拼接一条消息里的多个文本块', () => {
  assert.deepEqual(extractHistory([user(text('前半'), text('后半'))]), ['前半后半'])
})

test('extractHistory：丢掉空白消息', () => {
  assert.deepEqual(
    extractHistory([user(text('  ')), user(text('有内容')), user({ type: 'image' })]),
    ['有内容'],
  )
})

test('extractHistory：只去掉相邻重复，隔开的不去重', () => {
  assert.deepEqual(
    extractHistory([user(text('a')), user(text('a')), user(text('b')), user(text('a'))]),
    ['a', 'b', 'a'],
  )
})

test('extractHistory：内容是坏数据时不炸', () => {
  assert.deepEqual(extractHistory([user(), { kind: 'user' }, { kind: 'user', content: 'oops' }]), [])
})

test('extractHistory：超过上限时保留最近的 200 条', () => {
  const nodes = Array.from({ length: 250 }, (_, i) => user(text(`m${i}`)))
  const out = extractHistory(nodes)
  assert.equal(out.length, 200)
  assert.equal(out[0], 'm50')
  assert.equal(out.at(-1), 'm249')
})

test('step：草稿为空时 ↑ 进入浏览，回填最近一条', () => {
  const nav = fresh()
  const out = step('ArrowUp', nav, ['旧', '新'], '')
  assert.deepEqual(out, { handled: true, next: '新' })
  assert.equal(nav.index, 1)
  assert.equal(nav.backup, '')
})

test('step：连续 ↑ 逐条往更早翻，到最早一条后停住但不放行按键', () => {
  const nav = fresh()
  const history = ['第一条', '第二条', '第三条']
  assert.equal(step('ArrowUp', nav, history, '').next, '第三条')
  assert.equal(step('ArrowUp', nav, history, '').next, '第二条')
  assert.equal(step('ArrowUp', nav, history, '').next, '第一条')
  // 已在最早一条：吃掉按键（阻止默认行为会把光标移到行首），但不再写草稿。
  assert.deepEqual(step('ArrowUp', nav, history, ''), { handled: true })
  assert.equal(nav.index, 0)
})

test('step：↓ 往更近翻，越过最新一条时还回原草稿并退出浏览', () => {
  const nav = fresh()
  const history = ['第一条', '第二条']
  // 第一次 ↑：草稿为空，进入浏览，备份空草稿，回填「第二条」。
  assert.equal(step('ArrowUp', nav, history, '').next, '第二条')
  assert.equal(nav.backup, '')
  // 第二次 ↑：真实调用链里 draft 已经是刚回填的「第二条」；
  // 但 nav.index 非 null 说明在浏览中，不重新备份，继续往更早翻。
  assert.equal(step('ArrowUp', nav, history, '第二条').next, '第一条')
  assert.equal(nav.backup, '', '浏览中不能覆盖备份')
  // ↓ 回到「第二条」。
  assert.equal(step('ArrowDown', nav, history, '第一条').next, '第二条')
  // 再 ↓ 越过最新一条：还回备份，游标归零。
  assert.deepEqual(step('ArrowDown', nav, history, '第二条'), { handled: true, next: '' })
  assert.equal(nav.index, null)
  assert.equal(nav.backup, '')
})

test('step：进入浏览时备份的是你正在打的草稿，越界 ↓ 会原样还给你', () => {
  const nav = fresh()
  const history = ['旧提示词']
  // 草稿非空时 ↑ 不接管 —— 所以「备份非空草稿」只在草稿为纯空白时发生，
  // 这里用单个空格验证：trim() 为空 → 接管，且备份保留原样（含空格）。
  const out = step('ArrowUp', nav, history, ' ')
  assert.deepEqual(out, { handled: true, next: '旧提示词' })
  assert.equal(nav.backup, ' ', '备份必须是进入浏览前的原样草稿')
  // ↓ 越过最新一条 → 还回那个空格草稿。
  assert.deepEqual(step('ArrowDown', nav, history, '旧提示词'), { handled: true, next: ' ' })
  assert.equal(nav.index, null)
})

test('step：草稿非空时 ↑ 不接管（把按键留给斜杠/引用菜单）', () => {
  const nav = fresh()
  assert.deepEqual(step('ArrowUp', nav, ['历史'], '/help'), { handled: false })
  assert.equal(nav.index, null)
})

test('step：没有历史时 ↑ 不接管', () => {
  const nav = fresh()
  assert.deepEqual(step('ArrowUp', nav, [], ''), { handled: false })
  assert.equal(nav.index, null)
})

test('step：没在浏览时 ↓ 不接管（留给编辑器自己）', () => {
  const nav = fresh()
  assert.deepEqual(step('ArrowDown', nav, ['历史'], ''), { handled: false })
})

test('step：历史在浏览中被截短时钳制游标，不越界读', () => {
  const nav = fresh()
  step('ArrowUp', nav, ['a', 'b', 'c'], '')
  assert.equal(nav.index, 2)
  // 会话被截断，历史只剩 1 条：应先退出浏览，再按「草稿为空」重新进入。
  const out = step('ArrowUp', nav, ['a'], '')
  assert.deepEqual(out, { handled: true, next: 'a' })
  assert.equal(nav.index, 0)
})

test('step：调用方写草稿后必须能靠 selfWrite 区分自己写的变化', () => {
  // 这个契约由 overlay 组件消费：step 只改 nav，写草稿是调用方的事。
  const nav = fresh()
  const out = step('ArrowUp', nav, ['x'], '')
  assert.equal(out.handled, true)
  // step 本身绝不碰 selfWrite —— 由调用方在 setDraft 前置位。
  assert.equal(nav.selfWrite, false)
})

test('atEarliest：只有停在最早一条（或历史为空）时才该向宿主再要一页', () => {
  const nav = fresh()
  // 还没进入浏览：历史非空时不处于「最早一条」，历史为空时视作到底。
  assert.equal(atEarliest(nav, 3), false)
  assert.equal(atEarliest(nav, 0), true)
  // 停在最早一条。
  nav.index = 0
  assert.equal(atEarliest(nav, 3), true)
  // 停在中间的某一条：不该触发翻页。
  nav.index = 1
  assert.equal(atEarliest(nav, 3), false)
})

test('rebaseCursor：历史变长后把游标挪到旧位置再往前一条', () => {
  // 原来停在 3 条历史里的第 0 条；宿主在前面插了 7 条 → 旧位置变成 7，再往前一条是 6。
  assert.equal(rebaseCursor(0, 3, 10), 6)
  // 宿主只多给 1 条：旧位置 1，往前一条是 0（新加载的那条正好是更早的一条）。
  assert.equal(rebaseCursor(0, 3, 4), 0)
  // 夹取：旧位置 2 + 增量 7 = 9（新长度 10 的末尾之外是 9），再往前一条是 8。
  assert.equal(rebaseCursor(2, 3, 10), 8)
  // 历史没变长（宿主其实到底了）：返回 null，由调用方判定 exhausted。
  assert.equal(rebaseCursor(0, 3, 3), null)
  assert.equal(rebaseCursor(0, 200, 200), null)
  // 历史反而变短（会话被截断）：也返回 null，不猜位置。
  assert.equal(rebaseCursor(5, 10, 8), null)
})
