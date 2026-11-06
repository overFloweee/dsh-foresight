// Independent constructive counterexample harness for dsh-foresight client.
//
// Runs the REAL built bundle (lib/client.js) in a vm sandbox with a fake DOM + fake
// host services, drives the plugin's own applySettings()/render pipeline through a
// scripted settings document, and inspects
//   (a) the literal text the plugin writes into its overlay node, and
//   (b) the plugin's own diagnostic marker `document.body.dataset.sgSource`.
//
// The session-isolation invariant checked here is stronger than "the suggestion that
// shows up belongs to the current session": the harness also asserts the displayed
// text is never a suggestion belonging to a DIFFERENT session (`_push.suggestionSessionId`
// !== the session the user is looking at).
//
// 与真实产物同源：默认跑仓库里刚构建的 `lib/client.js`，可用 argv[1] 指向别处。
//
// 为什么要有这个冒烟：会话隔离是「显示层」不变量——宿主只发一个全局 `_push` 槽，
// 隔离靠 client 的按会话取值 + 按会话缓存 + epoch 失效。真机验证只能证明现场没串味，
// 这个用例把 7 帧反例固定下来，任何破坏守卫的改动都会在这里 FAIL。
//
// Usage: node scripts/isolation-smoke.mjs [path/to/lib/client.js]
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

const BUNDLE = process.argv[2] ?? fileURLToPath(new URL('../lib/client.js', import.meta.url));
const NS = 'dsh-foresight';
const OVERLAY_ID = `${NS}-overlay`;

// ───────────────────────── fake DOM ─────────────────────────
class FakeEl {
  constructor(tag = 'div', attrs = {}) {
    this.tagName = String(tag).toUpperCase();
    this.nodeName = this.tagName;
    this.attributes = new Map(Object.entries(attrs));
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this._text = '';
    this.isContentEditable = this.attributes.get('contenteditable') === 'true';
    this.offsetParent = null;
    this.offsetLeft = 0;
    this.offsetTop = 0;
    this.clientWidth = 400;
    this.scrollTop = 0;
    this.listeners = new Map();
    this.dataset = {};
  }
  get id() { return this.attributes.get('id') ?? ''; }
  set id(v) { this.attributes.set('id', String(v)); }
  get className() { return this.attributes.get('class') ?? ''; }
  set className(v) { this.attributes.set('class', String(v)); }
  get isConnected() {
    let node = this;
    while (node.parentElement !== null) node = node.parentElement;
    return this.ownerRoot !== undefined && this.ownerRoot.contains(node);
  }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  append(...nodes) { for (const n of nodes) this.appendChild(n); }
  remove() {
    if (this.parentElement !== null) {
      const i = this.parentElement.children.indexOf(this);
      if (i >= 0) this.parentElement.children.splice(i, 1);
      this.parentElement = null;
    }
  }
  contains(other) { return other === this || this.children.some(c => c.contains(other)); }
  matches(sel) { return matchesAny(this, sel); }
  closest(sel) {
    let node = this;
    while (node !== null) { if (matchesAny(node, sel)) return node; node = node.parentElement; }
    return null;
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatchEvent() { return true; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  focus() {}
  // 采纳键提示（fsr-ghost-key）不是建议文本：断言只比对建议本身。
  get textContent() { return this._text + this.children.filter(c => c.className !== 'fsr-ghost-key').map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children.length = 0; }
  get offsetWidth() { return this.clientWidth; }
  get offsetHeight() { return 24; }
  getBoundingClientRect() {
    const hasInline = this.style.left !== undefined || this.style.width !== undefined;
    const left = hasInline ? (parseFloat(this.style.left) || 0) : this.offsetLeft;
    const top = hasInline ? (parseFloat(this.style.top) || 0) : this.offsetTop;
    return { left, top, right: left + this.clientWidth, bottom: top + 24, width: this.clientWidth, height: 24, x: left, y: top };
  }
}
class HTMLElement extends FakeEl {}

/** Minimal CSS matcher: comma-separated simple selectors with optional tag prefix. */
function matchesOne(el, part) {
  const m = /^([a-zA-Z]*)(\[[a-zA-Z-]+\])?$/.exec(part.trim());
  if (m === null) return false;
  const [, tag, attr] = m;
  if (tag !== '' && el.tagName !== tag.toUpperCase()) return false;
  if (attr !== undefined && !el.attributes.has(attr.slice(1, -1))) return false;
  return true;
}
function matchesAny(el, sel) { return String(sel).split(',').some((part) => matchesOne(el, part)); }

const computedStyle = {
  paddingLeft: '8px', paddingTop: '6px', paddingRight: '8px',
  borderLeftWidth: '1px', borderTopWidth: '1px',
  fontFamily: 'sans-serif', fontSize: '14px', lineHeight: '24px',
  fontWeight: '400', letterSpacing: 'normal', display: 'block',
};

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── per-case environment ─────────────────────────
function bootEnv(startSession) {
  const root = new FakeEl('html');
  const grow = new FakeEl('div'); grow.className = 'grow';
  const scroller = new FakeEl('div', { 'data-input-scroll': '' });
  const composerEl = new FakeEl('textarea', { 'data-composer-input': '' });
  composerEl.offsetLeft = 8; composerEl.offsetTop = 6; composerEl.clientWidth = 400;
  scroller.appendChild(grow); grow.appendChild(composerEl); root.appendChild(scroller);
  const head = new FakeEl('head'); const body = new FakeEl('body');
  root.appendChild(head); root.appendChild(body);
  for (const el of [root, grow, scroller, composerEl, head, body]) el.ownerRoot = root;

  const findOverlay = () => grow.children.find(c => c.id === OVERLAY_ID) ?? null;
  const overlayText = () => { const el = findOverlay(); return el === null ? null : el.textContent; };

  const documentStub = {
    createElement: (tag) => { const el = new FakeEl(tag); el.ownerRoot = root; return el; },
    createTextNode: (t) => { const el = new FakeEl('#text'); el._text = String(t); el.ownerRoot = root; return el; },
    querySelector: (sel) => (String(sel).includes('textarea') ? composerEl : null),
    querySelectorAll: () => [],
    getElementById: () => findOverlay(),
    addEventListener: () => {}, removeEventListener: () => {},
    getSelection: () => null,
    activeElement: null,
    head, body, documentElement: root,
  };
  const windowStub = {
    addEventListener: () => {}, removeEventListener: () => {},
    getComputedStyle: () => computedStyle,
    innerWidth: 1280, innerHeight: 800,
  };

  const snap = (v) => ({ getSnapshot: () => v, subscribe: () => () => {} });
  const listeners = new Set();
  const s = { current: startSession, draft: '', running: false };
  const listSnapshotOf = (id) => ({ byId: { [id]: { id, retainedBy: { mainView: 1 }, isCurrent: true } } });
  const sessions = {
    list: {
      getSnapshot: () => listSnapshotOf(s.current),
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    },
    scope: () => ({ get: (k) => (k === 'conversation' ? { input: { for: () => inputFace } } : undefined) }),
    sessionOf: () => ({ getSnapshot: () => ({ running: s.running }), subscribe: () => () => {}, projections: { faceOf: () => snap(undefined) }, id: s.current }),
  };
  const inputFace = {
    state: { getSnapshot: () => ({ draft: s.draft }), subscribe: () => () => {} },
    setDraft: (d) => { s.draft = d; },
  };

  const doc = { revision: 0, value: {} };
  const emitSink = { ctx: new Map(), remote: new Map() };
  const remote = {
    $on: (name, fn) => { emitSink.remote.set(name, fn); return () => {}; },
    settings: {
      describe: () => Promise.resolve({ namespaces: [{ ns: NS, revision: doc.revision, value: doc.value }] }),
      mutate: () => Promise.resolve({}),
    },
  };
  const ctx = {
    get: (n) => ({ sessions, remote }.hasOwnProperty(n) ? { sessions, remote }[n] : undefined),
    on: (n, fn) => { emitSink.ctx.set(n, fn); return () => {}; },
    effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
    inject: (_deps, cb) => cb(ctx),
    plugin: () => {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };

  const sandbox = {
    window: windowStub, document: documentStub, HTMLElement,
    getComputedStyle: windowStub.getComputedStyle,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    console, Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, Error,
    Reflect, Map, Set, WeakMap, Symbol, RegExp, isNaN, parseInt, parseFloat,
  };
  const registered = [];
  sandbox.window.__ModuleLoader__ = { load: ({ id, factory }) => registered.push([id, factory]) };
  sandbox.globalThis = sandbox;
  runInNewContext(readFileSync(BUNDLE, 'utf8'), sandbox, { filename: BUNDLE });
  const entry = registered.find(([id]) => id === NS);
  if (entry === undefined) throw new Error(`bundle did not register "${NS}"; got ${registered.map(([i]) => i)}`);
  const plugin = entry[1]((name) => {
    if (name.startsWith('react')) {
      const h = () => null;
      return new Proxy({ createElement: h, jsx: h, jsxs: h, Fragment: 'Fragment' }, { get: (t, p) => (p in t ? t[p] : () => {}) });
    }
    throw new Error(`unexpected require: ${name}`);
  });
  plugin.apply(ctx);

  return {
    doc,
    setSession: async (id) => { s.current = id; for (const fn of listeners) fn(); await settle(); },
    /** Publish a new settings document revision the way the kernel does, then notify. */
    push: async (value) => {
      doc.revision += 1;
      doc.value = value;
      emitSink.remote.get('settings/document-updated')?.();
      await settle();
      for (const fn of listeners) fn(); // list event: forces resolve()/render()
      await settle();
    },
    text: overlayText,
    source: () => body.dataset.sgSource ?? '(unset)',
  };
}

// ───────────────────────── scenarios ─────────────────────────
const SUG_A = { turn: 1, baseSeq: 1, text: 'A-ONLY-SUGGESTION', truncated: false, acceptKey: 'Tab' };
const SUG_B = { turn: 5, baseSeq: 9, text: 'B-OWN-SUGGESTION', truncated: false, acceptKey: 'Tab' };
const payload = ({ suggestion, sessionId, history, historySessionId, epoch = 'e1' }) => JSON.stringify({
  rev: 1,
  epoch,
  suggestion: suggestion ?? null,
  suggestionSessionId: sessionId ?? null,
  hot: null,
  total: 0,
  ...(history !== undefined ? { history, historySessionId } : {}),
});

const outer = bootEnv('session-B');
await settle(60); // let the plugin's own boot-time applySettings() finish

const results = [];
/**
 * @param name - scenario label
 * @param viewing - session the user is looking at
 * @param pushed - the single global `_push` slot contents (or null = empty)
 * @param allowed - texts that may legitimately be displayed in this frame
 * @param forbidden - texts that must NOT be displayed (they belong to another session)
 */
async function check(name, { viewing, pushed, allowed, forbidden = [] }) {
  await outer.setSession(viewing);
  await outer.push(pushed === null ? { _push: 'null', historyEnabled: true } : { _push: pushed, historyEnabled: true });
  const text = outer.text();
  const source = outer.source();
  const shown = text === null ? null : text;
  const violations = shown === null || shown === '' ? [] : [
    ...(allowed.includes(shown) ? [] : [`displayed ${JSON.stringify(shown)} which is not an allowed value for ${viewing}`]),
    ...(forbidden.includes(shown) ? [`displayed cross-session text ${JSON.stringify(shown)}`] : []),
  ];
  results.push({ name, viewing, shown, source, ok: violations.length === 0, violations });
  console.log(`${violations.length === 0 ? 'PASS' : 'FAIL'}  ${name}`);
  console.log(`        viewing=${viewing}  overlay=${JSON.stringify(shown)}  sgSource=${source}`);
  for (const v of violations) console.log(`        !! ${v}`);
  return violations.length === 0;
}

console.log('=== real-bundle session-isolation harness ===');
console.log('bundle:', BUNDLE);
console.log('');

const pushB = payload({ suggestion: SUG_B, sessionId: 'session-B', history: ['b-hist'], historySessionId: 'session-B' });
const pushA = payload({ suggestion: SUG_A, sessionId: 'session-A', history: ['a-hist'], historySessionId: 'session-A' });
const pushAStale = payload({ suggestion: null, sessionId: 'session-A', history: ['a-hist'], historySessionId: 'session-A' });

// C1: suggestion for B arrives while B is on screen.
await check('C1  B-owned push while viewing B', {
  viewing: 'session-B', pushed: pushB, allowed: [SUG_B.text],
});
// C2: suggestion for A arrives while B is on screen (A is a *different* session, never cached for B).
// The page may still legitimately show B's own cached text from C1 — but never A's.
await check('C2  A-owned push arrives while viewing B (A text must never appear)', {
  viewing: 'session-B', pushed: pushA, allowed: [SUG_B.text], forbidden: [SUG_A.text],
});
// C3: switch to A, whose suggestion is still in the global slot.
await check('C3  switch to A while slot still holds A-owned push', {
  viewing: 'session-A', pushed: pushA, allowed: [SUG_A.text], forbidden: [SUG_B.text],
});
// C4: B gets its own push, then user switches back to A. B's text must not leak into A.
await check('C4  B push while viewing B', {
  viewing: 'session-B', pushed: pushB, allowed: [SUG_B.text], forbidden: [SUG_A.text],
});
await check('C5  switch back to A while slot holds B-owned push (B text must not appear in A)', {
  viewing: 'session-A', pushed: pushB, allowed: ['A-ONLY-SUGGESTION', null], forbidden: [SUG_B.text],
});
// C6: host authoritatively clears A's suggestion (turn advanced) while B has a cached one.
await check('C6  A cleared by host (null+A) while viewing A', {
  viewing: 'session-A', pushed: pushAStale, allowed: [null, ''], forbidden: [SUG_A.text, SUG_B.text],
});
// C7: host restarts (new epoch) with an A-owned suggestion; cache must be dropped and B must not show A.
await check('C7  new host epoch, A-owned push, viewing B', {
  viewing: 'session-B',
  pushed: payload({ suggestion: SUG_A, sessionId: 'session-A', history: ['a-hist'], historySessionId: 'session-A', epoch: 'e2' }),
  allowed: [],
  forbidden: [SUG_A.text],
});

console.log('\n--- raw results ---');
console.log(JSON.stringify(results, null, 2));
const failed = results.filter(r => !r.ok);
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} (${results.length} frames)`);
if (failed.length === 0) console.log('✅ 会话隔离冒烟测试通过（真实 lib/client.js，7 帧反例）');
// 真实 `lib/client.js` 在体内保留低频重试计时器（`_ops` 补投 / 状态 pull），事件
// 循环不会自然排空——脚本必须显式退出，否则 `pnpm test:smoke` 会挂死在这里。
process.exit(failed.length === 0 ? 0 : 1);
