// 转录过滤冒烟：注入上下文不得进转录（否则会吃光双预算、把真实对话挤出窗口、
// 并让 suggestionLanguage 按英文注入块判成英文）。
//
// 判据与 coldstart.ts 的 userTextOfEvent 一致：user/message 且 source.kind
// 存在且不等于 'user' ⇒ 跳过；source 缺失（老日志）视为用户输入。
//
// 跑的是编译产物（lib/），与 ghost-geom-smoke 同例：src/generate.ts 内部
// 是 `.js` 推导导入，`--experimental-strip-types` 解不开，只有 lib 能直跑。

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const generatePath = fileURLToPath(new URL('../lib/generate.js', import.meta.url));
const transcriptPath = fileURLToPath(new URL('../lib/transcript.js', import.meta.url));
const { buildTranscript } = await import(generatePath);
const { frameTranscript, suggestionLanguage, trimTranscript } = await import(transcriptPath);

const INJECT_MARK = 'INJECTED-CONTEXT-MARKER';
const HUGE = `${INJECT_MARK} ${'x'.repeat(30000)}`;
const ENGLISH_TIME = `Time sampled while preparing turn 1: ${INJECT_MARK} 2026-10-12T15:56:33+08:00`;

/** 造一个与真机同形的事件流：注入块夹在真实对话之间，且注入块更大、更晚。 */
function syntheticSession() {
  const events = [
    { type: 'turn/start', seq: 4, data: { turn: 1 } },
    { type: 'user/message', seq: 8, data: { role: 'user', turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: '只回复两个字：测试' }] } },
    { type: 'user/message', seq: 9, data: { role: 'user', turn: 1, source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: HUGE }] } },
    { type: 'user/message', seq: 10, data: { role: 'user', turn: 1, source: { kind: 'runtime-context' }, content: [{ type: 'text', text: ENGLISH_TIME }] } },
    { type: 'user/message', seq: 11, data: { role: 'user', turn: 1, source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: `${INJECT_MARK} catalog` }] } },
    // kind 是 'user' 但内容是 harness 横幅（teammate 提示等）：同样不是用户打的字。
    { type: 'user/message', seq: 12, data: { role: 'user', turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: '<system-reminder>\nYou are teammate "x".' }] } },
    // kind 不是字符串：按 typeof 判据**放行**（与 coldstart.ts 的 userTextOfEvent 同口径，
    // 只有字符串且不等于 'user' 才算注入）。2824 条真实样本里这类异常值计数为 0，
    // 这里刻意不带 INJECT_MARK —— 它就该进转录。
    { type: 'user/message', seq: 13, data: { role: 'user', turn: 1, source: { kind: null }, content: [{ type: 'text', text: '非字符串 kind 按 typeof 口径放行' }] } },
    { type: 'assistant/message', seq: 17, data: { turn: 1, message: { content: [{ type: 'text', text: '测试' }] } } },
    { type: 'turn/end', seq: 19, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 22, data: { turn: 2 } },
    { type: 'user/message', seq: 25, data: { role: 'user', turn: 2, source: { kind: 'user' }, content: [{ type: 'text', text: '第二轮的提问' }] } },
    // 老日志：没有 source 字段的 user/message 必须照旧放行。
    { type: 'user/message', seq: 26, data: { role: 'user', turn: 2, content: [{ type: 'text', text: '老日志里的用户消息' }] } },
    // 未来新增的注入 kind 也不该进转录。
    { type: 'user/message', seq: 27, data: { role: 'user', turn: 2, source: { kind: 'plugin:some-future-thing' }, content: [{ type: 'text', text: `${INJECT_MARK} plugin` }] } },
    { type: 'assistant/message', seq: 33, data: { turn: 2, message: { content: [{ type: 'text', text: '回答' }] } } },
    { type: 'turn/end', seq: 35, data: { turn: 2, reason: { kind: 'completed' } } },
  ];
  return { id: 'session-transcript-filter-smoke', snapshotEvents: () => events };
}

let passed = 0;
function ok(label, fn) {
  fn();
  passed += 1;
  console.log(`✅ ${label}`);
}

const session = syntheticSession();

// 1) 默认参数（真机默认：maxRecentTurns 1 / 12000 字符 / 4096 字节）：只收真人输入。
const one = buildTranscript(session, 1, 12000, 4096);
assert.ok(one !== undefined, '转录不应为空');
ok('默认参数下注入块不进转录', () => {
  assert.deepEqual(one.sourceMessageSeqs, [25, 26, 33], `实际 seqs=${JSON.stringify(one.sourceMessageSeqs)}`);
});

// 2) 核心症状回归：注入块可达 3 万字符，仍不得把真实用户消息挤出窗口。
ok('3 万字符注入块不挤掉真实用户消息', () => {
  assert.equal(one.pairs[0].role, 'user');
  assert.equal(one.pairs[0].text, '第二轮的提问');
  assert.ok(one.pairs.some(p => p.text.includes('老日志里的用户消息')), '缺 source 的消息被误杀');
});

// 3) 转录原文里不得出现注入标记，也不能多出 [User Message] 块。
ok('转录原文里没有注入内容', () => {
  const framed = frameTranscript(one.pairs);
  assert.ok(!framed.includes(INJECT_MARK), '注入内容漏进转录');
  assert.equal((framed.match(/\[User Message\]/g) ?? []).length, 2);
  assert.equal((framed.match(/\[Assistant Response\]/g) ?? []).length, 1);
});

// 4) 语言判定取最后一条**真人**消息：注入的英文块不能让中文用户的建议变英文。
ok('语言判定不受英文注入块影响', () => {
  assert.equal(suggestionLanguage(one.pairs), '简体中文');
});

// 5) 放大窗口（maxRecentTurns 3）：先前「真实用户消息被裁掉、助手回复留下」的实例已消失。
const three = buildTranscript(session, 3, 24000, 16384);
ok('放大窗口后早期真实对话完整保留', () => {
  assert.deepEqual(three.sourceMessageSeqs, [8, 13, 17, 25, 26, 33]);
  const framed = frameTranscript(three.pairs);
  assert.ok(framed.includes('只回复两个字：测试'));
  assert.ok(framed.includes('测试'));
  assert.ok(!framed.includes(INJECT_MARK));
});

// 6) baseSeq 是承载字段（当前语义=最后一条被收事件），不参与任何窗口判断；
//    这里只固定「它是正数」，避免把语义写死成用例契约。
ok('baseSeq 为有效 seq', () => {
  assert.ok(Number.isInteger(one.baseSeq) && one.baseSeq > 0);
});

// 7) 字节预算不得丢掉最后一条 user 对：模型的任务是预测「用户下一句」，
//    转录里没有 user 块时它会凭空猜、语言判定也会退化。
ok('字节预算下最后一条 user 消息仍在', () => {
  const trimmed = trimTranscript(
    [{ role: 'user', text: '现在呢？' }, { role: 'assistant', text: '回'.repeat(3000) }],
    [11, 12],
    12000,
    4096,
  );
  assert.ok(trimmed.pairs.some(p => p.role === 'user' && p.text === '现在呢？'), '用户消息被字节预算丢掉了');
  assert.ok(Buffer.byteLength(frameTranscript(trimmed.pairs), 'utf8') <= 4096 + 48, '裁剪后仍超预算');
});

// 8) 预算不足时先丢更老的 assistant 对，而不是丢用户消息。
ok('预算不足时先丢更老的 assistant 对', () => {
  const trimmed = trimTranscript(
    [
      { role: 'assistant', text: '旧'.repeat(2000) },
      { role: 'user', text: '现在呢？' },
      { role: 'assistant', text: '新'.repeat(2000) },
    ],
    [1, 2, 3],
    12000,
    4096,
  );
  assert.deepEqual(trimmed.sourceMessageSeqs, [2], `实际 seqs=${JSON.stringify(trimmed.sourceMessageSeqs)}`);
  assert.equal(trimmed.pairs[0].text, '现在呢？');
});

// 9) 非字符串 kind 放行是**有意**的口径（与 coldstart.ts 一致），不是漏网。
ok('非字符串 kind 按 typeof 口径放行', () => {
  assert.ok(three.sourceMessageSeqs.includes(13), '非字符串 kind 被误杀');
  assert.ok(frameTranscript(three.pairs).includes('非字符串 kind 按 typeof 口径放行'));
});

console.log(`转录过滤冒烟：${passed} 通过, 0 失败`);
