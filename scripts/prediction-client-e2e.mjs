#!/usr/bin/env node
/**
 * dsh-foresight 客户端回归（真实产物 + 受控假内核 + 最小 DOM 桩）
 *
 * 测的是哪个产物：`pnpm build` 生成的 `lib/client.js`。esbuild 把
 * `src/client/index.ts` 打成单文件 CJS，再由 `build.mjs` 用
 * `window.__ModuleLoader__.load({ id, factory })` 包一层；本脚本用 node:vm
 * 提供 `window/document` 桩把 factory 跑起来，拿到的就是**宿主真正加载的那份
 * 代码**（不是 src、不是 ts）。所以改完 client 必须先 `pnpm build`。
 *
 * 跑法：`pnpm build && node scripts/prediction-client-e2e.mjs`
 * 退出码：全部断言通过 = 0，任一失败 = 1（可重复运行，无外部依赖、无网络）。
 *
 * 覆盖 5 项客户端缺陷的反例断言（修复前的 lib/client.js 上必然失败）：
 *   1. 未确认门槛：盘上残留的 v2 `_push`（suggested）不得显示；实时推送/带本次
 *      nonce 的 pull 应答才确认；connection/reset 立即隐藏；epoch 换代清缓存。
 *   2. describe 在途重读：在途期间到达的作废通知不得丢，释放后旧幽灵必须消失。
 *   3. 非空草稿：`historyEnabled:false` 时草稿非空也不得出模型幽灵（清空后恢复）。
 *   4. `_ops` 合并与确认：pull/consume 带稳定 id、按 id 合并写、收到 opsAck 只移除
 *      被确认的那条（未确认的不得因 host 清空 `_ops` 或写失败而丢）。
 *   5. 回合回顾：在 `conversation.chat.turnTail` 注册固定 id 的条目，只渲染本节
 *      目该回合的那条（render 结构 `div.fsr-recap` + 回合号/全文 title），
 *      没有回顾的回合与其他会话返回 null，宿主换代后旧回顾消失。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, '..', 'lib', 'client.js');
const NS = 'dsh-foresight';
const OVERLAY_ID = 'dsh-foresight-overlay';

// ─────────────────────────── 最小 DOM 桩 ───────────────────────────
// 只补 client 真正触碰的面（见 src/client/index.ts 的 document/window 调用点）：
// createElement/head/body/dataset/querySelector/activeElement/visibilityState/
// getSelection、addEventListener/removeEventListener、ResizeObserver、
// getComputedStyle、offsetTop/Left、clientWidth、isConnected、closest/matches/contains。
// 所有 rect 返回 0，lineHeight 给 24px：GhostOverlay.verify() 的漂移判据即通过。

class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.offsetParent = null;
    this.dataset = {};
    this.attrs = new Map();
    this.style = {};
    this.listeners = new Map();
    this._text = '';
    this.clientWidth = 600;
    this.offsetTop = 0;
    this.offsetLeft = 0;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.selectionDirection = 'forward';
    this.isContentEditable = false;
    this.value = '';
  }
  get textContent() {
    // 采纳键提示（fsr-ghost-key）不是建议文本：断言只比对建议本身。
    return this._text + this.children.filter((c) => c.className !== 'fsr-ghost-key').map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this._text = v === null || v === undefined ? '' : String(v);
    this.children = [];
  }
  get lastChild() {
    return this.children.length === 0 ? null : this.children[this.children.length - 1];
  }
  get isConnected() {
    let node = this;
    while (node.parentElement !== null) node = node.parentElement;
    return node === documentStub.body || node === documentStub.documentElement;
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  appendChild(node) {
    node.parentElement = this;
    node.offsetParent = this;
    this.children.push(node);
    return node;
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  remove() {
    const parent = this.parentElement;
    if (parent !== null) parent.children = parent.children.filter((c) => c !== this);
    this.parentElement = null;
    this.offsetParent = null;
  }
  contains(node) {
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }
  matches(selector) {
    return matchesSimple(this, selector);
  }
  closest(selector) {
    let node = this;
    while (node !== null) {
      if (matchesSimple(node, selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
  addEventListener(type, fn) {
    const arr = this.listeners.get(type) ?? [];
    if (!arr.includes(fn)) arr.push(fn);
    this.listeners.set(type, arr);
  }
  removeEventListener(type, fn) {
    const arr = this.listeners.get(type) ?? [];
    this.listeners.set(type, arr.filter((f) => f !== fn));
  }
  dispatchEvent(event) {
    for (const fn of [...(this.listeners.get(event.type) ?? [])]) fn(event);
    return true;
  }
  getBoundingClientRect() {
    return { top: 0, left: 0, right: this.clientWidth, bottom: 24, width: this.clientWidth, height: 24 };
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  focus() {}
}
class HTMLElement extends Element {}
class HTMLTextAreaElement extends HTMLElement {}

/** 只认 `tag` 与 `[attr]`（含 `[attr="v"]`）两种 token，够 client 用。 */
function matchesSimple(el, selector) {
  const token = String(selector).trim();
  if (token.startsWith('[')) {
    const body = token.slice(1, token.indexOf(']'));
    const eq = body.indexOf('=');
    if (eq < 0) return el.attrs.has(body);
    const name = body.slice(0, eq);
    const want = body.slice(eq + 1).replace(/^["']|["']$/g, '');
    return el.getAttribute(name) === want;
  }
  return el.tagName === token.toUpperCase();
}

/** 逐 token 下探：最后一个 token 是目标，前面的每段都要满足「后代」。 */
function queryAll(root, selector) {
  const tokens = String(selector).split(/\s+/).filter((t) => t !== '');
  let current = [root];
  for (const token of tokens) {
    const next = [];
    for (const node of current) {
      const stack = [...node.children];
      while (stack.length > 0) {
        const child = stack.shift();
        if (matchesSimple(child, token)) next.push(child);
        stack.push(...child.children);
      }
    }
    current = next;
  }
  return current;
}

const documentStub = {
  head: new HTMLElement('head'),
  body: new HTMLElement('body'),
  documentElement: new HTMLElement('html'),
  activeElement: null,
  visibilityState: 'visible',
  createElement(tag) {
    return String(tag).toLowerCase() === 'textarea' ? new HTMLTextAreaElement(tag) : new HTMLElement(tag);
  },
  querySelector(selector) {
    return documentStub.querySelectorAll(selector)[0] ?? null;
  },
  // COMPOSER_SELECTOR 是逗号分隔的选择器列表（`A, B`），按逗号取并集。
  querySelectorAll(selector) {
    const out = [];
    for (const part of String(selector).split(',')) {
      for (const hit of queryAll(documentStub.body, part)) if (!out.includes(hit)) out.push(hit);
    }
    return out;
  },
  getSelection() {
    return null;
  },
  addEventListener() {},
  removeEventListener() {},
};
documentStub.documentElement.appendChild(documentStub.head);
documentStub.documentElement.appendChild(documentStub.body);

class ResizeObserver {
  constructor(cb) {
    this.cb = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const getComputedStyleStub = () => ({
  paddingLeft: '0px',
  paddingTop: '0px',
  paddingRight: '0px',
  borderLeftWidth: '0px',
  borderTopWidth: '0px',
  fontFamily: 'monospace',
  fontSize: '14px',
  lineHeight: '24px',
  fontWeight: '400',
  letterSpacing: 'normal',
  boxSizing: 'content-box',
});

const windowStub = {
  listeners: new Map(),
  addEventListener(type, fn) {
    const arr = windowStub.listeners.get(type) ?? [];
    if (!arr.includes(fn)) arr.push(fn);
    windowStub.listeners.set(type, arr);
  },
  removeEventListener(type, fn) {
    const arr = windowStub.listeners.get(type) ?? [];
    windowStub.listeners.set(type, arr.filter((f) => f !== fn));
  },
  dispatchEvent(event) {
    for (const fn of [...(windowStub.listeners.get(event.type) ?? [])]) fn(event);
    return true;
  },
};

const localStorageStub = { getItem: () => null, setItem() {}, removeItem() {} };

/** composer 夹具：body > div[data-input-scroll] > div.grow > textarea[data-composer-input]。 */
function mountComposer() {
  const scroller = documentStub.createElement('div');
  scroller.setAttribute('data-input-scroll', '');
  const grow = documentStub.createElement('div');
  const composer = documentStub.createElement('textarea');
  composer.setAttribute('data-composer-input', '');
  scroller.appendChild(grow);
  grow.appendChild(composer);
  documentStub.body.appendChild(scroller);
  documentStub.activeElement = composer;
  return { scroller, grow, composer };
}

// ──────────────────────── 真实 client 产物的装载 ────────────────────────

/** 用 node:vm + 假 loader 把 lib/client.js 跑起来，返回 bundle 的 exports。 */
function loadClientBundle() {
  const source = readFileSync(BUNDLE, 'utf8');
  const loaded = [];
  const sandboxWindow = windowStub;
  sandboxWindow.__ModuleLoader__ = {
    load(entry) {
      loaded.push(entry);
    },
  };
  const sandbox = {
    window: sandboxWindow,
    document: documentStub,
    Element,
    HTMLElement,
    HTMLTextAreaElement,
    ResizeObserver,
    getComputedStyle: getComputedStyleStub,
    localStorage: localStorageStub,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    module: { exports: {} },
    exports: {},
  };
  runInNewContext(source, sandbox, { filename: BUNDLE });
  const entry = loaded.find((e) => e.id === NS) ?? loaded[0];
  if (entry === undefined) throw new Error(`${BUNDLE}: 没有找到 __ModuleLoader__.load 注册项`);
  // react 只在注册槽位（ctx.slots）时被用到：设置页用 hook、回顾行用
  // useSyncExternalStore + jsx。默认桩对未知成员返回 no-op；额外补两处，
  // 让第 ⑤ 段能在无浏览器、无真实 React 的环境里调用槽组件做结构断言：
  //  - useSyncExternalStore 直接返回 getSnapshot()（等于「已同步到最新」）；
  //  - jsx/jsxs/jsxDEV 返回 {type, props} 普通对象（可断言 type/className）。
  const reactStub = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined;
        if (prop === 'useSyncExternalStore') return (_subscribe, getSnapshot) => getSnapshot();
        if (prop === 'jsx' || prop === 'jsxs' || prop === 'jsxDEV') return (type, props) => ({ type, props });
        return () => null;
      },
    },
  );
  const moduleExports = entry.factory((id) => {
    if (String(id).startsWith('react')) return reactStub;
    throw new Error(`unexpected require: ${id}`);
  });
  return moduleExports;
}

// ─────────────────────────── 受控假内核 ───────────────────────────
// 面（按 client 实际调用补）：sessions.list/scope/sessionOf、conversation.input.for、
// remote.$on、remote.settings.describe/mutate、ctx.on('connection/reset')、ctx.effect。
// describe 可挂起；mutate 做真实 CAS（expectedRevision 不匹配即 reject）并记录每次
// `_ops` 槽写出的载荷 —— 「host 清空 `_ops`」不能作为确认信号，所以脚本里由
// hostConsumeOps() 显式模拟条件清空 + 回带 opsAck。

const makePush = (over = {}) => ({
  rev: 1,
  protocol: 2,
  epoch: 'e1',
  prediction: null,
  suggestion: null,
  suggestionSessionId: null,
  hot: null,
  total: 0,
  ...over,
});

const makePrediction = (over = {}) => ({
  requestKey: 'rk-1',
  sessionId: 's1',
  sourceTurn: 1,
  sourceEndSeq: 1,
  outcome: 'suggested',
  reason: null,
  requestId: 'req-1',
  nonce: null,
  generatedAt: 1,
  ...over,
});

const makeSuggestion = (text, acceptKey = 'Tab') => ({ turn: 1, baseSeq: 1, text, truncated: false, acceptKey });

function createEnv({ push = null, doc = {}, sessionId = 's1', slots = null } = {}) {
  const layout = mountComposer();
  const sessions = new Map();
  const ensure = (id) => {
    if (!sessions.has(id)) {
      sessions.set(id, { id, running: false, draft: '', inputListeners: [], sessionListeners: [], faceListeners: [] });
    }
    return sessions.get(id);
  };
  let currentId = sessionId;
  ensure(currentId);

  const state = {
    value: {
      historyEnabled: true,
      historyCrossSession: false,
      historyMaxEntries: 50,
      historyMinChars: 1,
      wordAccept: true,
      llmEnabled: true,
      _push: push === null ? null : JSON.stringify(push),
      _ops: 'null',
      ...doc,
    },
    revision: 0,
  };
  const writes = [];
  const opsWrites = [];
  const docListeners = [];
  const ctxHandlers = new Map();
  const cleanups = [];
  let heldDescribe = false;
  let held = [];
  let disposed = false;

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const snapshotDoc = () => ({
    ok: true,
    value: {
      writable: true,
      hasDocument: true,
      namespaces: [{ ns: NS, value: clone(state.value), revision: state.revision }],
    },
  });
  const notifyDoc = () => {
    for (const fn of [...docListeners]) fn();
  };
  const currentPush = () => (typeof state.value._push === 'string' ? JSON.parse(state.value._push) : null);

  const remote = {
    $on(event, listener) {
      if (event === 'settings/document-updated') docListeners.push(listener);
      return () => {
        const i = docListeners.indexOf(listener);
        if (i >= 0) docListeners.splice(i, 1);
      };
    },
    settings: {
      describe() {
        const snap = snapshotDoc();
        if (!heldDescribe) return Promise.resolve(snap);
        return new Promise((resolve) => held.push(() => resolve(snap)));
      },
      mutate(ns, ops, expected) {
        const record = { ns, ops, expected, revision: state.revision };
        if (ns !== NS || !Array.isArray(ops) || ops.length === 0 || expected !== state.revision) {
          record.ok = false;
          writes.push(record);
          return Promise.reject(new Error(`stale revision: expected ${expected}, doc ${state.revision}`));
        }
        record.ok = true;
        writes.push(record);
        for (const op of ops) {
          if (op === null || op.op !== 'set' || !Array.isArray(op.path) || op.path.length !== 1) continue;
          state.value[op.path[0]] = op.value;
          if (op.path[0] === '_ops') opsWrites.push(JSON.parse(String(op.value)).ops);
        }
        state.revision += 1;
        notifyDoc();
        return Promise.resolve(undefined);
      },
    },
  };

  const sessionObj = (id) => {
    const row = ensure(id);
    return {
      id,
      getSnapshot: () => ({ id, running: row.running }),
      subscribe: (fn) => {
        row.sessionListeners.push(fn);
        return () => {
          row.sessionListeners = row.sessionListeners.filter((f) => f !== fn);
        };
      },
      projections: {
        faceOf: () => ({
          getSnapshot: () => undefined,
          subscribe: () => () => {},
        }),
      },
      input: {
        state: {
          getSnapshot: () => ({ draft: row.draft, isComposing: false }),
          subscribe: (fn) => {
            row.inputListeners.push(fn);
            return () => {
              row.inputListeners = row.inputListeners.filter((f) => f !== fn);
            };
          },
        },
        setDraft: (text) => {
          row.draft = text;
          for (const fn of [...row.inputListeners]) fn();
        },
      },
      row,
    };
  };

  const listListeners = [];
  const sessionsService = {
    list: {
      getSnapshot: () => ({
        byId: Object.fromEntries(
          [...sessions.keys()].map((id) => [
            id,
            { id, retainedBy: id === currentId ? { mainView: 1 } : {}, isCurrent: id === currentId },
          ]),
        ),
      }),
      subscribe: (fn) => {
        listListeners.push(fn);
        return () => {
          const i = listListeners.indexOf(fn);
          if (i >= 0) listListeners.splice(i, 1);
        };
      },
    },
    scope: (id) => (sessions.has(id) ? { get: scopeGet } : undefined),
    sessionOf: () => sessionObj(currentId),
  };
  const scopeGet = (key) => {
    if (key === 'conversation') {
      return { input: { for: () => sessionObj(currentId).input } };
    }
    return undefined;
  };

  const ctx = {
    // client 里有两条读 slots 的路径：注册用 `ctx.slots`（属性），设置卡片用
    // `ctx.get('slots')`。两者在真实宿主里是同一对象，这里都补上。
    ...(slots === null ? {} : { slots }),
    get: (key) => {
      if (key === 'sessions') return sessionsService;
      if (key === 'remote') return remote;
      if (key === 'slots') return slots ?? undefined;
      return undefined; // slots / locale 缺失：设置页注册整体跳过，与旧宿主一致
    },
    on: (event, fn) => {
      const arr = ctxHandlers.get(event) ?? [];
      arr.push(fn);
      ctxHandlers.set(event, arr);
      return () => {};
    },
    effect: (fn) => {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
      return () => {};
    },
    inject: (_deps, cb) => cb(ctx),
    plugin: () => {},
    logger: { info() {}, warn() {}, error() {} },
  };

  return {
    ctx,
    layout,
    sessions,
    state,
    writes,
    opsWrites,
    get push() {
      return currentPush();
    },
    /** 最近一次写出的 `_ops` 操作数组（没有写过则 null）。 */
    get lastOps() {
      return opsWrites.length === 0 ? null : opsWrites[opsWrites.length - 1];
    },
    get revision() {
      return state.revision;
    },
    /** 当前 pull 请求带的 nonce（宿主写 `_push.nonce` 即为应答凭证）。 */
    lastPullNonce() {
      for (let i = opsWrites.length - 1; i >= 0; i -= 1) {
        for (let j = opsWrites[i].length - 1; j >= 0; j -= 1) {
          const op = opsWrites[i][j];
          if (op.op === 'pull' && typeof op.nonce === 'string') return op.nonce;
        }
      }
      return null;
    },
    lastPullId() {
      for (let i = opsWrites.length - 1; i >= 0; i -= 1) {
        for (let j = opsWrites[i].length - 1; j >= 0; j -= 1) {
          const op = opsWrites[i][j];
          if (op.op === 'pull' && typeof op.id === 'string') return op.id;
        }
      }
      return null;
    },
    /** 宿主推送：直接改 `_push`（模拟另一写入方），revision +1 并通知。 */
    hostPush(payload) {
      state.value._push = payload === null ? null : JSON.stringify(payload);
      state.revision += 1;
      notifyDoc();
    },
    /** 只让文档 revision 前进（不改 `_push`）：复现「重读到同一份残留」。 */
    bumpOnly() {
      state.revision += 1;
      notifyDoc();
    },
    /** 模拟宿主消费 `_ops`：回带 opsAck + 条件清空（`_ops` 未被并发改写时才清）。 */
    hostConsumeOps({ ack = null, ...payloadOver } = {}) {
      const rawOps = typeof state.value._ops === 'string' ? state.value._ops : 'null';
      const envelope = JSON.parse(rawOps);
      const ids = ack ?? (envelope.ops ?? []).map((op) => op.id).filter((id) => typeof id === 'string');
      const base = currentPush() ?? makePush();
      state.value._push = JSON.stringify({ ...base, ...payloadOver, opsAck: ids });
      if (state.value._ops === rawOps) state.value._ops = 'null';
      state.revision += 1;
      notifyDoc();
      return ids;
    },
    /** 只回带 opsAck（不清 `_ops`），用于验证「只移除被确认的那条」。 */
    hostAck(ids, payloadOver = {}) {
      const base = currentPush() ?? makePush();
      state.value._push = JSON.stringify({ ...base, ...payloadOver, opsAck: ids });
      state.revision += 1;
      notifyDoc();
    },
    setDoc(patch) {
      Object.assign(state.value, patch);
      state.revision += 1;
      notifyDoc();
    },
    holdDescribe() {
      heldDescribe = true;
    },
    releaseDescribe() {
      heldDescribe = false;
      const pending = held;
      held = [];
      for (const fn of pending) fn();
    },
    setDraft(text) {
      sessionObj(currentId).input.setDraft(text);
    },
    getDraft() {
      return ensure(currentId).draft;
    },
    setRunning(running) {
      const row = ensure(currentId);
      row.running = running;
      for (const fn of [...row.sessionListeners]) fn();
    },
    switchSession(id) {
      ensure(id);
      currentId = id;
      for (const fn of [...listListeners]) fn();
    },
    reset() {
      for (const fn of ctxHandlers.get('connection/reset') ?? []) fn();
    },
    keydown(over = {}) {
      windowStub.dispatchEvent({
        type: 'keydown',
        code: 'Tab',
        key: 'Tab',
        keyCode: 9,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        isComposing: false,
        target: layout.composer,
        preventDefault() {},
        stopPropagation() {},
        ...over,
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const fn of cleanups.splice(0)) fn();
    },
  };
}

/** 让所有已排队的微任务跑完（client 的 describe/mutate/render 链全靠 Promise）。 */
const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findById(node, id) {
  if (node.id === id) return node;
  for (const child of node.children) {
    const hit = findById(child, id);
    if (hit !== null) return hit;
  }
  return null;
}

/** 幽灵可观测状态：overlay 节点自身 + body.dataset.sgSource 诊断标记。 */
function ghost() {
  const el = findById(documentStub.body, OVERLAY_ID);
  if (el === null) return { el: null, shown: false, text: '', source: String(documentStub.body.dataset.sgSource ?? '') };
  return {
    el,
    shown: el.dataset.shown === '1' && el.style.display !== 'none',
    text: el.textContent,
    kind: String(el.dataset.kind ?? ''),
    // 采纳键提示：overlay 里 className 为 fsr-ghost-key 的子节点，文字是键帽标签。
    hint: el.children.find((c) => c.className === 'fsr-ghost-key')?.textContent ?? null,
    source: String(documentStub.body.dataset.sgSource ?? ''),
  };
}

// ──────────────────────────── 断言框架 ────────────────────────────

let failures = 0;
let passes = 0;
const section = (title) => console.log(`\n── ${title}`);
const check = (name, ok, detail = '') => {
  if (ok) {
    passes += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`);
  }
};
const eq = (name, actual, expected) => check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const ID_SHAPE = /^[0-9a-z]+-[0-9a-z]{1,6}$/;

// ──────────────────────────── 用例 ────────────────────────────

const bundle = loadClientBundle();
check('产物入口导出 apply/name/inject', typeof bundle.apply === 'function' && bundle.name === NS && Array.isArray(bundle.inject));
check('产物是真实 lib/client.js 的打包结果', readFileSync(BUNDLE, 'utf8').includes('__ModuleLoader__.load'));

// ① 未确认门槛：盘上残留的 suggested 不得显示，确认后才显示。
{
  section('① 连接对账门槛（残留 _push 不得显示）');
  const residue = makePush({
    epoch: 'e-old',
    prediction: makePrediction(),
    suggestion: makeSuggestion('STALE-MODEL'),
    suggestionSessionId: 's1',
  });
  const env = createEnv({ push: residue });
  bundle.apply(env.ctx);
  await settle();

  check('初始 apply 后幽灵未显示（旧 epoch 残留未被当作有效记录）', ghost().shown === false, `shown=${ghost().shown} text=${JSON.stringify(ghost().text)} source=${ghost().source}`);
  check('boot 阶段写出了一次状态 pull', env.lastOps !== null && env.lastOps.some((op) => op.op === 'pull'), `lastOps=${JSON.stringify(env.lastOps)}`);

  env.hostPush(
    makePush({
      epoch: 'e-old',
      prediction: makePrediction(),
      suggestion: makeSuggestion('MODEL-AFTER-PUSH'),
      suggestionSessionId: 's1',
    }),
  );
  await settle();
  eq('实时推送（内容变化）后显示模型幽灵', ghost().shown, true);
  eq('幽灵文本来自实时推送', ghost().text, 'MODEL-AFTER-PUSH');
  eq('模型预测的幽灵标记来源为 llm（样式按它着色）', ghost().kind, 'llm');
  eq('幽灵末尾带采纳键提示，默认 Tab', ghost().hint, 'Tab');

  env.reset();
  check('connection/reset 同步隐藏模型幽灵', ghost().shown === false, `shown=${ghost().shown} text=${JSON.stringify(ghost().text)}`);
  await settle(8);
  check('reset 后重读到同一份盘上残留仍不显示', ghost().shown === false, `shown=${ghost().shown} text=${JSON.stringify(ghost().text)}`);

  env.hostPush(
    makePush({
      epoch: 'e-old',
      prediction: makePrediction({ requestKey: 'rk-2' }),
      suggestion: makeSuggestion('AFTER-RESET-PUSH'),
      suggestionSessionId: 's1',
    }),
  );
  await settle();
  eq('reset 后的实时推送重新确认并显示', ghost().text, 'AFTER-RESET-PUSH');

  // epoch 换代：清空缓存 + 重新确认；切走再切回不得凭缓存复活旧文本。
  env.hostPush(makePush({ epoch: 'e-new', prediction: null, suggestion: null }));
  await settle();
  check('epoch 换代后旧幽灵被清掉', ghost().shown === false, `shown=${ghost().shown} text=${JSON.stringify(ghost().text)}`);
  env.switchSession('s2');
  await settle();
  env.switchSession('s1');
  await sleep(80);
  await settle();
  check('换代后切走再切回：缓存不复活上个 epoch 的模型文本', ghost().shown === false, `shown=${ghost().shown} text=${JSON.stringify(ghost().text)}`);
  env.dispose();
}

// ①b 带本次 nonce 的 pull 应答也算确认（另一条确认判据）。
{
  section('①b 带 nonce 的 pull 应答确认');
  const env = createEnv({
    push: makePush({
      epoch: 'e-old',
      prediction: makePrediction(),
      suggestion: makeSuggestion('STALE-MODEL'),
      suggestionSessionId: 's1',
    }),
  });
  bundle.apply(env.ctx);
  await settle();
  check('残留仍未显示', ghost().shown === false);
  env.reset();
  await settle();
  const nonce = env.lastPullNonce();
  check('reset 后的 pull 请求带了 nonce（可作确认凭证）', typeof nonce === 'string' && nonce.length > 0, `nonce=${JSON.stringify(nonce)}`);
  env.hostPush(
    makePush({
      epoch: 'e-old',
      prediction: makePrediction(),
      suggestion: makeSuggestion('PULL-ANSWER'),
      suggestionSessionId: 's1',
      nonce,
    }),
  );
  await settle();
  eq('收到带本次 nonce 的应答后显示', ghost().text, 'PULL-ANSWER');
  env.dispose();
}

// ② describe 在途时的重读。
{
  section('② describe 在途期间的通知不得丢');
  const env = createEnv({ push: null });
  bundle.apply(env.ctx);
  await settle();
  env.hostPush(
    makePush({
      epoch: 'e1',
      prediction: makePrediction(),
      suggestion: makeSuggestion('GHOST-BEFORE-INFLIGHT'),
      suggestionSessionId: 's1',
    }),
  );
  await settle();
  eq('前置条件：模型幽灵已显示', ghost().text, 'GHOST-BEFORE-INFLIGHT');

  env.holdDescribe();
  env.bumpOnly(); // 触发一次 describe，挂起不返回
  await settle();
  env.hostPush(
    makePush({
      epoch: 'e1',
      prediction: makePrediction({ outcome: 'stale_source' }),
      suggestion: null,
      suggestionSessionId: null,
    }),
  );
  await settle();
  check('在途期间尚未重读：旧幽灵仍在显示（竞态窗口本身）', ghost().shown === true && ghost().text === 'GHOST-BEFORE-INFLIGHT', `shown=${ghost().shown} text=${JSON.stringify(ghost().text)}`);
  env.releaseDescribe();
  await settle(10);
  check('在途 describe 释放后重读最新状态并清掉旧幽灵', ghost().shown === false, `shown=${ghost().shown} text=${JSON.stringify(ghost().text)} source=${ghost().source}`);
  env.dispose();
}

// ③ 非空草稿 + historyEnabled:false。
{
  section('③ 非空草稿不得出模型幽灵');
  const env = createEnv({ push: null });
  bundle.apply(env.ctx);
  await settle();
  env.hostPush(
    makePush({
      epoch: 'e1',
      prediction: makePrediction(),
      suggestion: makeSuggestion('MODEL-TEXT'),
      suggestionSessionId: 's1',
      history: ['hello world'],
      historySessionId: 's1',
    }),
  );
  await settle();
  eq('前置条件：空草稿显示模型幽灵', ghost().text, 'MODEL-TEXT');

  env.setDraft('hel');
  await settle();
  check('草稿非空 + 历史可用 → 显示历史补全而不是模型文本', ghost().shown === true && ghost().text.includes('lo world') && ghost().source === 'push:history', `text=${JSON.stringify(ghost().text)} source=${ghost().source}`);
  eq('历史补全的幽灵标记来源为 history（保持中性灰）', ghost().kind, 'history');
  eq('历史补全同样带采纳键提示 Tab', ghost().hint, 'Tab');

  env.setDoc({ historyEnabled: false });
  await settle();
  check('historyEnabled:false + 草稿非空 → 不出模型幽灵', ghost().shown === false, `shown=${ghost().shown} text=${JSON.stringify(ghost().text)} source=${ghost().source}`);

  env.setDraft('');
  await settle();
  eq('草稿清空后模型幽灵恢复（证明前一条确由草稿非空挡住）', ghost().text, 'MODEL-TEXT');
  env.dispose();
}

// ④ `_ops` 按 id 合并 + opsAck 按 id 移除。
{
  section('④ _ops 合并写与确认移除');
  const env = createEnv({ push: null });
  bundle.apply(env.ctx);
  await settle();

  const firstWrite = env.opsWrites[0];
  check('boot 首次写出 pull 操作', Array.isArray(firstWrite) && firstWrite.length === 1 && firstWrite[0].op === 'pull', `ops=${JSON.stringify(firstWrite)}`);
  const pullId = firstWrite?.[0]?.id;
  check('pull 操作带唯一 id', typeof pullId === 'string' && ID_SHAPE.test(pullId), `id=${JSON.stringify(pullId)}`);

  // 用「实时推送」确认连接（故意不带 nonce：pull 操作仍待确认），并让建议可采纳。
  env.hostPush(
    makePush({
      epoch: 'e1',
      prediction: makePrediction(),
      suggestion: makeSuggestion('MODEL-TEXT'),
      suggestionSessionId: 's1',
      history: ['hello world'],
      historySessionId: 's1',
    }),
  );
  await settle();
  eq('前置条件：确认后显示模型幽灵', ghost().text, 'MODEL-TEXT');

  const prevOps = env.lastOps; // 采纳前的待确认集合
  env.keydown({ code: 'Tab', key: 'Tab', keyCode: 9 });
  await settle();
  eq('Tab 采纳写入草稿', env.getDraft(), 'MODEL-TEXT');
  check('采纳隐藏幽灵', ghost().shown === false);

  const merged = env.lastOps;
  const prevIds = (prevOps ?? []).map((op) => op.id);
  check(
    '合并写 = 全部待确认操作 + 本次新操作',
    Array.isArray(merged) && merged.length === prevIds.length + 1 && prevIds.every((id) => merged.some((op) => op.id === id)),
    `prev=${JSON.stringify(prevOps)} merged=${JSON.stringify(merged)}`,
  );
  check('待确认的 pull 在合并后保留原 id', Array.isArray(merged) && merged.some((op) => op.op === 'pull' && op.id === pullId), `ops=${JSON.stringify(merged)}`);
  const consume = merged?.find((op) => op.op === 'consume');
  check('consume 操作带 requestKey 与唯一 id', consume !== undefined && consume.requestKey === 'rk-1' && typeof consume.id === 'string' && ID_SHAPE.test(consume.id), `consume=${JSON.stringify(consume)}`);

  env.hostAck([pullId]); // 只确认 pull
  await settle();
  env.switchSession('s2');
  await settle();
  const afterAck = env.lastOps;
  check('只移除被确认的那条（consume 仍在待确认集合里）', Array.isArray(afterAck) && afterAck.some((op) => op.op === 'consume' && op.id === consume?.id), `ops=${JSON.stringify(afterAck)}`);
  check('已确认的 pull 不再重复写出', Array.isArray(afterAck) && !afterAck.some((op) => op.id === pullId), `ops=${JSON.stringify(afterAck)}`);
  check('consume 操作 id 跨次 flush 稳定', afterAck?.find((op) => op.op === 'consume')?.id === consume?.id, `ops=${JSON.stringify(afterAck)}`);

  const consumeId = consume?.id;
  env.hostAck([consumeId]);
  await settle();
  env.switchSession('s3');
  await settle();
  const afterSecondAck = env.lastOps;
  check('确认 consume 后不再重复写出', Array.isArray(afterSecondAck) && !afterSecondAck.some((op) => op.id === consumeId), `ops=${JSON.stringify(afterSecondAck)}`);

  // host 消费：回带 opsAck 且条件清空 `_ops`；此前的待确认项不得因写失败而丢。
  const bootOps = env.lastOps;
  const bootPullId = bootOps?.find((op) => op.op === 'pull')?.id;
  env.state.value._ops = 'null'; // 模拟 host 已清空（客户端不得把它当确认信号）
  env.state.revision += 1;
  env.bumpOnly();
  await settle();
  env.switchSession('s4');
  await settle();
  const lastOps = env.lastOps;
  check('待确认操作不因 host 清空 _ops 而丢失', Array.isArray(lastOps) && lastOps.some((op) => op.op === 'pull' && op.id === bootPullId), `ops=${JSON.stringify(lastOps)}`);
  env.dispose();
}

// ⑤ 正常路径补测：hostConsumeOps 回带 opsAck 后同一批不再重发。
{
  section('⑤ hostConsumeOps 的 opsAck 回执');
  const env = createEnv({ push: null });
  bundle.apply(env.ctx);
  await settle();
  const acked = env.hostConsumeOps({ prediction: null, suggestion: null, suggestionSessionId: null });
  await settle();
  check('hostConsumeOps 回带了 id 列表', Array.isArray(acked) && acked.length >= 1, `acked=${JSON.stringify(acked)}`);
  check('host 条件清空了 _ops', env.state.value._ops === 'null');
  env.switchSession('s2');
  await settle();
  const ops = env.lastOps;
  check('被确认的操作不再出现在后续写批次里', Array.isArray(ops) && !ops.some((op) => acked.includes(op.id)), `ops=${JSON.stringify(ops)} acked=${JSON.stringify(acked)}`);
  env.dispose();
}

// ⑥ 复核 P1：consume 撞上 CAS 冲突后，用户不再操作也必须自动补投成功。
{
  section('⑥ consume 写失败后的有界自动补投');
  const env = createEnv({ push: null });
  bundle.apply(env.ctx);
  await settle();

  // 先让连接被确认并显示模型建议（订阅之后到达的实时推送）。
  env.hostPush(
    makePush({
      epoch: 'e1',
      prediction: makePrediction(),
      suggestion: makeSuggestion('MODEL-TEXT'),
      suggestionSessionId: 's1',
      history: ['hello world'],
      historySessionId: 's1',
    }),
  );
  await settle();
  eq('前置条件：确认后显示模型幽灵', ghost().text, 'MODEL-TEXT');

  /** 每一次 `_ops` 写入里那条 consume 操作：{ok, id}（失败写也记进 `writes`）。 */
  const consumeAttempts = () =>
    env.writes
      .map((w) => {
        const set = Array.isArray(w.ops)
          ? w.ops.find((op) => op?.op === 'set' && op.path?.[0] === '_ops')
          : undefined;
        if (set === undefined) return null;
        let ops;
        try {
          ops = JSON.parse(String(set.value)).ops;
        } catch {
          return null;
        }
        const consume = Array.isArray(ops) ? ops.find((op) => op.op === 'consume') : undefined;
        return consume === undefined ? null : { ok: w.ok === true, id: consume.id };
      })
      .filter((x) => x !== null);

  // 另一个写入方推进 revision（客户端手里的 settingsRevision 因此过期）；故意不发
  // 通知，让紧随其后的采纳撞上 CAS 冲突。
  env.state.revision += 1;

  env.keydown({ code: 'Tab', key: 'Tab', keyCode: 9 });
  await settle();
  eq('Tab 采纳写入草稿', env.getDraft(), 'MODEL-TEXT');

  const first = consumeAttempts();
  check(
    'consume 首次写入撞上 CAS 冲突（写失败）',
    first.length === 1 && first[0].ok === false,
    `attempts=${JSON.stringify(first)}`,
  );
  const consumeId = first[0]?.id;
  check('冲突的 consume 带唯一 id', typeof consumeId === 'string' && ID_SHAPE.test(consumeId), `id=${JSON.stringify(consumeId)}`);

  // 只让客户端重读到新的 revision（host / 另一写者把文档推上来）：**没有**任何用户操作。
  env.bumpOnly();
  await settle();
  await sleep(400);
  await settle();

  const later = consumeAttempts();
  const ok = later.find((attempt) => attempt.ok === true);
  check('无人再操作也会自动补投成功', ok !== undefined, `attempts=${JSON.stringify(later)}`);
  check('补投保留同一操作 id', ok !== undefined && ok.id === consumeId, `ok=${JSON.stringify(ok)} id=${JSON.stringify(consumeId)}`);
  env.dispose();
}

// ⑤ 回合回顾：turnTail 槽注册 + 按回合渲染 + 换代清空。
// 这里给假内核补一个 `slots` 服务（真实宿主里由 client Slots 服务提供），
// 才能把「注册了什么槽、注册的组件拿到 props 后渲染成什么」断言出来。
{
  section('⑤ 回合回顾（turnTail 槽注册与渲染）');
  const makeSlots = () => {
    const registered = [];
    const service = {
      inject(_name, cb) {
        const dispose = cb();
        return typeof dispose === 'function' ? dispose : () => {};
      },
      register(descriptor, component) {
        registered.push({ ...descriptor, component });
        return () => {};
      },
    };
    return { service, registered };
  };

  const recapText = '把设置页补上了「启用回合回顾」开关，保存后立即生效；下一步刷新页面确认显示位置。';
  const slots = makeSlots();
  const env = createEnv({
    slots: slots.service,
    push: makePush({ recapsSessionId: 's1', recaps: [{ turn: 1, text: recapText }] }),
  });
  bundle.apply(env.ctx);
  await settle();

  const tail = slots.registered.find((row) => row.name === 'conversation.chat.turnTail');
  check(
    '在 conversation.chat.turnTail 注册了回顾条目',
    tail !== undefined,
    `registered=${slots.registered.map((row) => row.name).join(',')}`,
  );
  eq('回顾条目 id 固定', tail?.id, 'dsh-foresight-recap');
  eq('回顾条目 order', tail?.order, 10);
  check('回顾条目组件是函数', typeof tail?.component === 'function');

  const element = tail?.component({ turn: { turn: 1 }, sessionId: 's1' });
  check(
    '有回顾的回合渲染 div.fsr-recap',
    element?.type === 'div' && element?.props?.className === 'fsr-recap',
    `element=${JSON.stringify(element)?.slice(0, 160)}`,
  );
  check(
    '渲染出的行带回合号与全文 title',
    element?.props?.['data-recap-turn'] === 1 && element?.props?.title === recapText,
    `props=${JSON.stringify(element?.props)?.slice(0, 160)}`,
  );
  const otherTurn = tail?.component({ turn: { turn: 2 }, sessionId: 's1' });
  check('没有回顾的回合返回 null（不占位）', otherTurn === null, `element=${JSON.stringify(otherTurn)}`);
  const otherSession = tail?.component({ turn: { turn: 1 }, sessionId: 's9' });
  check('别的会话不串行显示', otherSession === null, `element=${JSON.stringify(otherSession)}`);

  // 宿主换代（epoch 变化）→ 作废按会话缓存，回顾行必须消失。
  env.hostPush(
    makePush({
      epoch: 'e2',
      prediction: makePrediction(),
      recapsSessionId: null,
    }),
  );
  await settle();
  const afterEpoch = tail?.component({ turn: { turn: 1 }, sessionId: 's1' });
  check('宿主换代后旧回顾不再渲染', afterEpoch === null, `element=${JSON.stringify(afterEpoch)}`);
  env.dispose();
}

// ──────────────────────────── 汇总 ────────────────────────────
console.log(`\n${failures === 0 ? '✅' : '❌'} prediction-client-e2e: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
