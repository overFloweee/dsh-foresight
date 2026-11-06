window.__ModuleLoader__.load({
	id: "dsh-foresight",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/main.ts
var main_exports = {};
__export(main_exports, {
  apply: () => apply2,
  inject: () => inject3,
  name: () => name
});
module.exports = __toCommonJS(main_exports);

// src/client/history.ts
function normalizeForMatch(text) {
  return text.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 65248)).replace(/\u3000/g, " ").toLowerCase().replace(/\s+/g, " ").trim();
}
function commonPrefixLength(a, b) {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return i;
}
var TIME_TOKEN_RE = /^[+\d].*|^[a-z]+\d+.*|^\d{1,2}:\d{2}.*|^\d+月.*|^\d{1,2}日.*|^[上下]周.*|^今天.*|^明天.*|^后天.*|^今.*|^明.*|^后.*/i;
function stripCommandPrefix(draft) {
  const head = /^\/([A-Za-z][\w-]*)((?:\s+[\s\S]*)?)$/.exec(draft);
  if (head === null) return draft;
  const rest = (head[2] ?? "").replace(/^\s+/, "");
  if (rest === "") return "";
  const firstToken = /^\S+/.exec(rest);
  if (firstToken === null) return rest;
  if (TIME_TOKEN_RE.test(firstToken[0])) {
    return rest.slice(firstToken[0].length).replace(/^\s+/, "");
  }
  return rest;
}
var HISTORY_WEIGHTS = {
  /** 新近度（0–1，最新≈1）；跨会话候选固定 0。 */
  recency: 1,
  /** 会话内出现次数 / 候选内最大次数（0–1）。 */
  localFreq: 0.45,
  /** 全局热度频次 / 热度表最大频次（0–1；无热度信号时为 0）。 */
  hotFreq: 0.3,
  /** 后缀信息量：min(后缀长, 60) / 60，偏好有内容的补全而非 1 字符碎片。 */
  suffixLen: 0.1
};
var SUFFIX_LEN_CAP = 60;
function historySuggestion(history, draft, opts = { minChars: 1, maxEntries: 0 }) {
  const normDraft = normalizeForMatch(draft);
  if (normDraft === "" || normDraft.length < opts.minChars) return void 0;
  const entries = opts.maxEntries > 0 ? history.slice(-opts.maxEntries) : history;
  const byNorm = /* @__PURE__ */ new Map();
  entries.forEach((raw, idx) => {
    const norm = normalizeForMatch(raw);
    if (norm === "") return;
    const prev = byNorm.get(norm);
    if (prev === void 0) {
      byNorm.set(norm, { text: raw, norm, bestIdx: idx, localCount: 1 });
    } else {
      prev.localCount += 1;
      if (idx > prev.bestIdx) {
        prev.bestIdx = idx;
        prev.text = raw;
      }
    }
  });
  if (opts.extraCandidates !== void 0) {
    for (const item of opts.extraCandidates) {
      const norm = normalizeForMatch(item.text);
      if (norm === "" || byNorm.has(norm)) continue;
      byNorm.set(norm, { text: item.text, norm, bestIdx: -1, localCount: 0 });
    }
  }
  let maxLocal = 0;
  for (const c of byNorm.values()) if (c.localCount > maxLocal) maxLocal = c.localCount;
  let maxHot = 0;
  if (opts.hotCounts !== void 0) {
    for (const h of opts.hotCounts.values()) if (h > maxHot) maxHot = h;
  }
  let best;
  let bestScore = 0;
  let bestRecency = -1;
  for (const c of byNorm.values()) {
    if (c.norm === normDraft) continue;
    if (!c.norm.startsWith(normDraft)) continue;
    const recency = c.bestIdx < 0 ? 0 : (c.bestIdx + 1) / Math.max(entries.length, 1);
    const localFreq = maxLocal > 0 ? c.localCount / maxLocal : 0;
    const hotCount = opts.hotCounts?.get(c.norm) ?? 0;
    const hotFreq = maxHot > 0 ? hotCount / maxHot : 0;
    const suffixLen = Math.min(Math.max(c.norm.length - normDraft.length, 0), SUFFIX_LEN_CAP) / SUFFIX_LEN_CAP;
    const score = HISTORY_WEIGHTS.recency * recency + HISTORY_WEIGHTS.localFreq * localFreq + HISTORY_WEIGHTS.hotFreq * hotFreq + HISTORY_WEIGHTS.suffixLen * suffixLen;
    if (best === void 0 || score > bestScore || score === bestScore && recency > bestRecency) {
      best = c;
      bestScore = score;
      bestRecency = recency;
    }
  }
  return best?.text;
}

// src/client/chunk.ts
var segmenter;
try {
  const ctor = Intl.Segmenter;
  segmenter = typeof ctor === "function" ? new ctor("zh", { granularity: "word" }) : void 0;
} catch {
  segmenter = void 0;
}
function charClassOf(ch) {
  if (/\s/.test(ch)) return "space";
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch)) return "cjk";
  if (/[\w]/.test(ch)) return "word";
  return "punct";
}
function nextAcceptChunkFallback(text) {
  if (text === "") return "";
  let i = 0;
  while (i < text.length && charClassOf(text[i]) === "space") i++;
  if (i < text.length) {
    const cls = charClassOf(text[i]);
    let run = 0;
    while (i < text.length && charClassOf(text[i]) === cls) {
      i++;
      run++;
      if (cls === "cjk" && run >= 2) break;
    }
    while (i < text.length && charClassOf(text[i]) === "space") i++;
  }
  return text.slice(0, Math.max(i, 1));
}
function nextAcceptChunk(text) {
  if (text === "") return "";
  if (segmenter === void 0) return nextAcceptChunkFallback(text);
  const parts = [...segmenter.segment(text)];
  let firstWord = 0;
  while (firstWord < parts.length && !parts[firstWord].isWordLike) firstWord++;
  if (firstWord >= parts.length) return text;
  let end = firstWord + 1;
  while (end < parts.length && !parts[end].isWordLike) end++;
  return parts.slice(0, end).map((p) => p.segment).join("");
}

// src/client/keyspec.ts
var KEY_CODES = {
  tab: "Tab",
  enter: "Enter",
  slash: "Slash",
  space: "Space",
  comma: "Comma",
  period: "Period",
  minus: "Minus",
  equal: "Equal",
  semicolon: "Semicolon",
  quote: "Quote",
  backquote: "Backquote",
  backslash: "Backslash",
  bracketleft: "BracketLeft",
  bracketright: "BracketRight",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`]))
};
function keyCodeOf(spec) {
  const parts = spec.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return void 0;
  const key = parts[parts.length - 1];
  const direct = key === void 0 ? void 0 : KEY_CODES[key];
  if (direct !== void 0) return direct;
  if (key !== void 0 && /^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (key !== void 0 && /^[0-9]$/.test(key)) return `Digit${key}`;
  return void 0;
}
function keyNameOfCode(code) {
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  const arrows = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right"
  };
  if (code in arrows) return arrows[code];
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  if (Object.values(KEY_CODES).includes(code)) return code;
  return void 0;
}
var MODIFIER_KEYS = /* @__PURE__ */ new Set(["Alt", "AltGraph", "Control", "Meta", "Shift", "Fn", "FnLock"]);
function keyEventToSpec(event) {
  if (MODIFIER_KEYS.has(event.key)) return void 0;
  const key = keyNameOfCode(event.code);
  if (key === void 0) return void 0;
  const mods = [];
  if (event.altKey) mods.push("Alt");
  if (event.ctrlKey) mods.push("Ctrl");
  if (event.metaKey) mods.push("Meta");
  if (event.shiftKey) mods.push("Shift");
  return [...mods, key].join("+");
}

// src/client/recap.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var recapsBySession = /* @__PURE__ */ new Map();
var listeners = /* @__PURE__ */ new Set();
function notify() {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
    }
  }
}
function subscribe(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function applyRecaps(sessionId, raw) {
  const next = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const turn = item.turn;
      const text = item.text;
      if (typeof turn !== "number" || !Number.isInteger(turn) || turn < 0) continue;
      if (typeof text !== "string" || text === "") continue;
      next.push({ turn, text });
    }
  }
  next.sort((a, b) => a.turn - b.turn);
  const previous = recapsBySession.get(sessionId);
  const unchanged = previous !== void 0 && previous.length === next.length && previous.every((entry, i) => entry.turn === next[i]?.turn && entry.text === next[i]?.text);
  if (unchanged) return;
  if (next.length === 0) recapsBySession.delete(sessionId);
  else recapsBySession.set(sessionId, next);
  notify();
}
function clearRecaps() {
  if (recapsBySession.size === 0) return;
  recapsBySession.clear();
  notify();
}
function recapTextFor(sessionId, turn) {
  const entries = recapsBySession.get(sessionId);
  if (entries === void 0) return null;
  for (const entry of entries) {
    if (entry.turn === turn) return entry.text;
  }
  return null;
}
function RecapLine(props) {
  const sessionId = typeof props.sessionId === "string" ? props.sessionId : null;
  const turnNumber = typeof props.turn?.turn === "number" ? props.turn.turn : null;
  const text = (0, import_react.useSyncExternalStore)(
    subscribe,
    () => sessionId === null || turnNumber === null ? null : recapTextFor(sessionId, turnNumber),
    () => null
  );
  if (text === null) return null;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "fsr-recap", "data-recap-turn": turnNumber ?? void 0, title: text, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "fsr-recap-mark", "aria-hidden": "true", children: "\u{1F433}\uFF1A" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "fsr-recap-text", children: text })
  ] });
}

// src/client/settings-card.tsx
var import_react3 = require("react");

// src/client/useGhostT.ts
var import_react2 = require("react");
var noopSubscribe = () => () => {
};
function useGhostT(locale) {
  const subscribe2 = (0, import_react2.useCallback)(
    (onStoreChange) => locale === void 0 ? noopSubscribe() : locale.subscribe(onStoreChange),
    [locale]
  );
  const getActive = (0, import_react2.useCallback)(
    () => locale === void 0 ? "zh" : locale.getSnapshot().active,
    [locale]
  );
  const active = (0, import_react2.useSyncExternalStore)(subscribe2, getActive, getActive);
  if (active === "en") return "en";
  if (active?.startsWith("zh")) return "zh";
  return "zh";
}

// src/client/styles.ts
var STYLE_ID = "dsh-foresight-card-css";
var COMPONENTS = [
  /* ==================== 表单根 ==================== */
  /* 裸表单，无卡片容器（对齐官方 SettingsForm） */
  ".fsr-settings-form{display:flex;flex-direction:column}",
  /* ==================== Section 分组 ==================== */
  ".fsr-section{padding:16px 0}",
  ".fsr-section-heading{margin:0;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}",
  ".fsr-section-fields{display:flex;flex-direction:column}",
  /* 两列并排网格（对齐 dsh-later 的 grid 布局） */
  ".fsr-section-fieldsGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}",
  /* ==================== 字段 ==================== */
  ".fsr-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}",
  ".fsr-fieldHead{display:flex;align-items:center;gap:8px}",
  ".fsr-label-group{display:flex;align-items:center;gap:4px;flex:1;min-width:0}",
  ".fsr-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}",
  /* ==================== 输入框 ==================== */
  ".fsr-input{box-sizing:border-box;width:100%;min-height:36px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}",
  ".fsr-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}",
  ".fsr-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
  ".fsr-inputInvalid{border-color:var(--dsw-alias-state-error-primary)}",
  ".fsr-inputReadOnly{opacity:.6;cursor:not-allowed}",
  /* ==================== 快捷键按钮 ==================== */
  ".fsr-key{box-sizing:border-box;width:100%;appearance:none;font:inherit;text-align:left;cursor:pointer;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);min-height:36px;color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-md,8px);padding:0 12px;font-size:13px;line-height:1.5}",
  ".fsr-key:focus-visible{border-color:var(--dsw-alias-state-business-primary);outline:none}",
  ".fsr-key:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
  ".fsr-keyCapturing,.fsr-keyCapturing:focus-visible{border-color:var(--dsw-alias-brand-primary)}",
  /* ==================== 帮助按钮 ==================== */
  ".fsr-help-btn{width:24px;height:24px;padding:0;flex:none;display:inline-flex;align-items:center;justify-content:center;background:none;border:none;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-tertiary)}",
  ".fsr-help-btn:hover,.fsr-help-btnOpen{color:var(--dsw-alias-label-secondary)}",
  ".fsr-help-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}",
  /* ==================== 帮助展开区 ==================== */
  ".fsr-help{margin:0;padding:10px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}",
  ".fsr-help p{margin:0}",
  /* ==================== Toggle 行（布尔字段） ==================== */
  ".fsr-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:16px}",
  ".fsr-toggle-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}",
  ".fsr-toggle-switch{position:relative;width:36px;height:20px;flex:none;background:var(--dsw-alias-bg-module-platform);border-radius:999px;cursor:pointer;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out);border:none;padding:0}",
  '.fsr-toggle-switch[aria-checked="true"]{background:var(--dsw-alias-state-business-primary)}',
  '.fsr-toggle-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:#fff;transition:transform var(--ds-transition-duration-fast) var(--ds-ease-in-out)}',
  '.fsr-toggle-switch[aria-checked="true"]::after{transform:translateX(16px)}',
  ".fsr-toggle-switch:disabled{opacity:0.4;cursor:default}",
  ".fsr-toggle-switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}",
  ".fsr-toggle-description{margin:0;padding:0 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}",
  /* ==================== 只读/策略字段提示 ==================== */
  ".fsr-configOnly{color:var(--dsw-alias-label-tertiary);margin:2px 0 0;font-size:11px;line-height:1.4}",
  ".fsr-invalid{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:1.5}",
  ".fsr-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}",
  ".fsr-readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}",
  /* ==================== 预测路由与状态（诊断行） ==================== */
  /* 键值网格：键列宽度随内容，值列换行不撑破容器（沿用表单同一套 token/字号） */
  ".fsr-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;margin:8px 0 0;font-size:12px;line-height:1.6}",
  ".fsr-kvKey{color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
  ".fsr-kvVal{color:var(--dsw-alias-label-primary);min-width:0;overflow-wrap:anywhere}",
  /* 诊断说明：多条 12px 灰字，等距堆叠（与 .fsr-hint 同色号，仅补间距） */
  ".fsr-predNotes{display:flex;flex-direction:column;gap:4px;margin:8px 0 0}",
  /* ==================== 底部操作栏 ==================== */
  ".fsr-footer{justify-content:flex-end;align-items:center;gap:8px;padding-top:16px;display:flex}",
  ".fsr-status{flex:1;min-width:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:1.5}",
  ".fsr-discard,.fsr-save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:var(--dsw-radius-md,8px);padding:5px 14px;font-size:13px;line-height:1.5}",
  ".fsr-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:none}",
  ".fsr-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}",
  ".fsr-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}",
  ".fsr-save:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}",
  ".fsr-save:disabled,.fsr-discard:disabled{opacity:.4;cursor:default}",
  ".fsr-save:focus-visible,.fsr-discard:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
  /* ==================== 热度管理分组 ==================== */
  /* 折叠式 section 标题按钮：外观对齐 .fsr-section-heading（13px/600/primary），可点击展开 */
  ".fsr-sectionBtn{appearance:none;width:100%;font:inherit;background:none;border:0;text-align:left;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.5;padding:0}",
  ".fsr-sectionBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}",
  ".fsr-sectionBtnText{min-width:0}",
  ".fsr-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
  ".fsr-chevronOpen{transform:rotate(180deg)}",
  ".fsr-hotList{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;max-height:320px;overflow-y:auto}",
  ".fsr-hotRow{display:flex;align-items:center;gap:8px;padding:6px 10px;min-width:0}",
  ".fsr-hotRow+.fsr-hotRow{border-top:1px solid var(--dsw-alias-border-l2)}",
  ".fsr-hotRow:hover{background:var(--dsw-alias-bg-layer-2)}",
  ".fsr-hotPinFlag{flex:none;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 7px;font-size:11px;font-weight:500;line-height:16px;white-space:nowrap}",
  ".fsr-hotText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}",
  ".fsr-hotCount{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums}",
  ".fsr-hotBtn{flex:none;appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:none;border-radius:6px;padding:2px 8px;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary)}",
  ".fsr-hotBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}",
  ".fsr-hotBtn:disabled{opacity:.4;cursor:default}",
  ".fsr-hotBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}",
  ".fsr-hotBtnDanger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
  ".fsr-hotAdd{display:flex;gap:8px;margin-top:8px}",
  ".fsr-hotAdd .fsr-input{flex:1;min-width:0;min-height:30px;height:30px;font-size:12px}",
  ".fsr-hotMeta{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:8px 0 0}",
  ".fsr-hotDanger{color:var(--dsw-alias-state-error-primary)}",
  /* ==================== 回合回顾（turnTail 条目） ==================== */
  /* 回复末尾的一行 dim/italic 回顾：鲸鱼图标 + 全角冒号 + 正文（用户要求只去掉「回顾」两个字） */
  /* ——不抢正文注意力，但一眼能看出「这一轮做了什么」。 */
  ".fsr-recap{display:flex;align-items:baseline;gap:6px;margin:2px 0 0;min-width:0;font-size:12px;line-height:1.6}",
  ".fsr-recap-mark{flex:none;font-size:13px;line-height:1.2}",
  ".fsr-recap-text{min-width:0;color:var(--dsw-alias-label-tertiary);font-style:italic;overflow-wrap:anywhere}"
].join("\n");
function injectStyles() {
  if (typeof document === "undefined") return () => void 0;
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) {
    return () => void 0;
  }
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-foresight";
  tag.dataset.pluginCss = STYLE_ID;
  tag.textContent = COMPONENTS;
  document.head.appendChild(tag);
  return () => {
    tag.remove();
  };
}

// src/client/settings-card.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var GHOST_FIELDS = [
  // —— LLM 下一条建议 ——
  {
    key: "maxInputBytes",
    label: { zh: "\u8F93\u5165\u5B57\u8282\u4E0A\u9650", en: "Input byte cap" },
    hint: {
      zh: "\u6700\u7EC8\u6846\u67B6\u5316\u7528\u6237\u63D0\u793A\u7684\u6700\u5927 UTF-8 \u5B57\u8282\u6570",
      en: "Max UTF-8 bytes of the final framed user prompt"
    },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "maxOutputTokens",
    label: { zh: "\u8F93\u51FA\u4EE4\u724C\u4E0A\u9650", en: "Output token cap" },
    hint: {
      zh: "\u5EFA\u8BAE\u751F\u6210\u7684\u6700\u5927\u8F93\u51FA token\uFF08\u63A8\u7406\u6A21\u578B\u7559\u8DB3\u9884\u7B97\uFF0C\u5982 512\uFF09",
      en: "Max output tokens per suggestion (leave headroom for reasoning models, e.g. 512)"
    },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "maxSuggestionChars",
    label: { zh: "\u5EFA\u8BAE\u5B57\u7B26\u4E0A\u9650", en: "Suggestion character cap" },
    hint: {
      zh: "\u5386\u53F2\u524D\u7F00\u8865\u5168\u7684\u53EF\u89C1\u5B57\u7B26\u6570\u4E0A\u9650\uFF1B\u6A21\u578B\u9884\u6D4B\u4E0D\u6309\u6B64\u503C\u622A\u65AD\uFF08\u5B98\u65B9\u63D0\u793A\u8BCD\u56FA\u5B9A\u8981\u6C42\u5355\u884C \u2264240 \u5B57\u7B26\uFF0C\u8D85\u957F\u8F93\u51FA\u4FDD\u7559\u539F\u6587\u4EA4\u7531\u5C55\u793A\u5C42\uFF09",
      en: "Visible-character cap for history prefix completion; model prediction is not truncated by it (the official prompt fixes a single line \u2264240 chars; longer output is kept verbatim for the display layer)"
    },
    note: {
      zh: "\u4EC5\u4F5C\u7528\u4E8E\u5386\u53F2\u8865\u5168\uFF1B\u6A21\u578B\u9884\u6D4B\u4E0D\u6309\u957F\u5EA6\u622A\u65AD",
      en: "Applies to history completion only; model prediction is not truncated by length"
    },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "maxRecentTurns",
    label: { zh: "\u53C2\u8003\u56DE\u5408\u6570", en: "Recent turns referenced" },
    hint: {
      zh: "\u8F6C\u5F55\u5C3E\u90E8\u4FDD\u7559\u7684\u6700\u8FD1\u5B8C\u6210\u56DE\u5408\u6570\uFF081 = \u53EA\u53D6\u6700\u540E\u4E00\u8F6E\uFF09",
      en: "Completed turns kept from the transcript tail (1 = last turn only)"
    },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "maxTranscriptChars",
    label: { zh: "\u8F6C\u5F55\u5B57\u7B26\u9884\u7B97", en: "Transcript character budget" },
    hint: {
      zh: "\u53D1\u9001\u7ED9\u5EFA\u8BAE\u6A21\u578B\u7684\u8F6C\u5F55\u5B57\u7B26\u4E0A\u9650",
      en: "Max transcript characters sent to the suggestion model"
    },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "timeoutMs",
    label: { zh: "\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF09", en: "Timeout (ms)" },
    hint: {
      zh: "\u8F85\u52A9 LLM \u8BF7\u6C42\u7AEF\u5230\u7AEF\u622A\u6B62\u65F6\u95F4",
      en: "End-to-end deadline for the auxiliary LLM request"
    },
    kind: "number",
    section: "llm",
    writable: true
  },
  {
    key: "acceptKey",
    label: { zh: "\u91C7\u7EB3\u5FEB\u6377\u952E", en: "Accept shortcut" },
    hint: {
      zh: "\u70B9\u51FB\u540E\u6309\u4E0B\u7EC4\u5408\u952E\uFF1B\u652F\u6301 Tab\u3001\u5B57\u6BCD/\u6570\u5B57\u3001F1-F12\u3001\u65B9\u5411\u952E\u7B49\uFF08\u4E24\u4E2A\u529F\u80FD\u5171\u7528\uFF09",
      en: "Click, then press a key combo; supports Tab, letters/digits, F1-F12, arrows, etc. (shared by both features)"
    },
    kind: "key",
    section: "llm",
    writable: true
  },
  {
    key: "llmEnabled",
    label: { zh: "\u542F\u7528 LLM \u5EFA\u8BAE", en: "Enable LLM suggestions" },
    hint: {
      zh: "\u5173\u95ED\u540E\u6BCF\u56DE\u5408\u4E0D\u518D\u8C03\u7528\u5EFA\u8BAE\u6A21\u578B\uFF08\u7701 token\uFF09\uFF1B\u5386\u53F2\u524D\u7F00\u8865\u5168\u4E0E\u70ED\u5EA6\u4E0D\u53D7\u5F71\u54CD",
      en: "When off, no suggestion model call per turn (saves tokens); history completion and hotness are unaffected"
    },
    kind: "boolean",
    section: "llm",
    writable: true
  },
  {
    key: "recapEnabled",
    label: { zh: "\u542F\u7528\u56DE\u5408\u56DE\u987E", en: "Enable turn recaps" },
    hint: {
      zh: "\u6BCF\u56DE\u5408\u5B8C\u6210\u540E\uFF0C\u5728\u56DE\u590D\u672B\u5C3E\u8FFD\u52A0\u4E00\u884C\u56DE\u987E\uFF1A\u8FD9\u4E00\u8F6E\u4E4B\u540E\u4EC0\u4E48\u53D8\u4E86\uFF08\u7ED3\u8BBA / \u73B0\u5728\u7684\u72B6\u6001 / \u8FD8\u5DEE\u4EC0\u4E48\uFF09\uFF0C\u4E00\u884C 80 \u5B57\u5185\uFF1B\u6CA1\u6709\u53D8\u5316\u7684\u56DE\u5408\u4E0D\u663E\u793A\u3002\u5173\u95ED\u540E\u4E0D\u518D\u751F\u6210\u65B0\u56DE\u987E\uFF08\u5DF2\u751F\u6210\u7684\u4FDD\u7559\uFF09\uFF0C\u4E5F\u4E0D\u5F71\u54CD\u4E0B\u4E00\u6761\u5EFA\u8BAE",
      en: "After each turn, append one line under the reply: what changed after this turn (outcome / current state / what is left), within 30 characters; turns with no change stay blank. When off, no new recaps are generated (existing ones stay) and suggestions are unaffected"
    },
    kind: "boolean",
    section: "llm",
    writable: true
  },
  {
    key: "provider",
    label: { zh: "Provider", en: "Provider" },
    hint: {
      zh: "\u65E7\u7248\u663E\u5F0F\u8DEF\u7531\uFF08\u517C\u5BB9\u4FDD\u7559\uFF09\uFF1A\u9884\u6D4B\u8DEF\u7531\u5DF2\u6539\u4E3A\u7EE7\u627F\u7236\u4F1A\u8BDD\u6A21\u578B\uFF0C\u7236\u4F1A\u8BDD\u7528 GPT \u5219\u9884\u6D4B\u4E5F\u7528 GPT\uFF0C\u7236\u4F1A\u8BDD\u7528 DeepSeek \u5219\u9884\u6D4B\u4E5F\u7528 DeepSeek\uFF1B\u6B64\u9879\u4E0D\u518D\u8986\u76D6\u9884\u6D4B\u8DEF\u7531",
      en: "Legacy explicit route (kept for compatibility): prediction now inherits the parent session model \u2014 GPT parent means GPT prediction, DeepSeek parent means DeepSeek prediction; this no longer overrides prediction routing"
    },
    note: {
      zh: "\u4E0D\u518D\u8986\u76D6\u9884\u6D4B\u8DEF\u7531\uFF08\u9884\u6D4B\u7EE7\u627F\u7236\u4F1A\u8BDD\u6A21\u578B\uFF09",
      en: "No longer overrides prediction routing (prediction inherits the parent session model)"
    },
    kind: "text",
    section: "llm",
    writable: true
  },
  {
    key: "model",
    label: { zh: "Model", en: "Model" },
    hint: {
      zh: "\u65E7\u7248\u663E\u5F0F\u8DEF\u7531\uFF08\u517C\u5BB9\u4FDD\u7559\uFF09\uFF1A\u9884\u6D4B\u8DEF\u7531\u5DF2\u6539\u4E3A\u7EE7\u627F\u7236\u4F1A\u8BDD\u6A21\u578B\uFF1B\u6B64\u9879\u4E0D\u518D\u8986\u76D6\u9884\u6D4B\u8DEF\u7531\u3002\u5B9E\u9645\u751F\u6548\u7684\u9884\u6D4B\u8DEF\u7531\u89C1\u4E0B\u65B9\u300C\u9884\u6D4B\u8DEF\u7531\u4E0E\u72B6\u6001\u300D",
      en: "Legacy explicit route (kept for compatibility): prediction now inherits the parent session model, and this no longer overrides prediction routing. See \u201CPrediction route & status\u201D below for the effective route"
    },
    note: {
      zh: "\u4E0D\u518D\u8986\u76D6\u9884\u6D4B\u8DEF\u7531\uFF08\u9884\u6D4B\u7EE7\u627F\u7236\u4F1A\u8BDD\u6A21\u578B\uFF09",
      en: "No longer overrides prediction routing (prediction inherits the parent session model)"
    },
    kind: "text",
    section: "llm",
    writable: true
  },
  {
    key: "reasoningEffort",
    label: { zh: "\u63A8\u7406\u6863", en: "Reasoning effort" },
    hint: {
      zh: "\u9884\u6D4B\u8BF7\u6C42\u7684\u63A8\u7406\u6863\uFF1A\u7559\u7A7A =\u7EE7\u627F\u7236\u4F1A\u8BDD\u8BF7\u6C42\u7684\u6863\u4F4D\uFF08parent\uFF09\uFF1B\u975E\u7A7A\u65F6\u6821\u9A8C\u540E\u8986\u76D6\u7236\u503C\u5E76\u6210\u4E3A\u5B9E\u9645\u6863\uFF08effective\uFF09",
      en: "Reasoning effort for prediction: empty = inherit the parent request effort (parent); a non-empty value is validated and replaces it as the effective effort"
    },
    note: {
      zh: "\u7559\u7A7A =\u7EE7\u627F\u7236\u4F1A\u8BDD\u6863\uFF1B\u975E\u7A7A\u65F6\u6821\u9A8C\u540E\u8986\u76D6\u3002\u4E09\u6863\u5B9E\u9645\u53D6\u503C\u89C1\u4E0B\u65B9\u300C\u9884\u6D4B\u8DEF\u7531\u4E0E\u72B6\u6001\u300D",
      en: "Empty = inherit the parent session effort; a non-empty value overrides it after validation. See \u201CPrediction route & status\u201D below for all three values"
    },
    kind: "text",
    section: "llm",
    writable: false
  },
  // —— 历史前缀补全 ——
  {
    key: "historyEnabled",
    label: { zh: "\u542F\u7528\u5386\u53F2\u8865\u5168", en: "Enable history completion" },
    hint: {
      zh: "\u8349\u7A3F\u975E\u7A7A\u65F6\u6309\u5386\u53F2\u6D88\u606F\u524D\u7F00\u8865\u5168\uFF08\u6253\u5206\u5236\uFF1A\u6700\u8FD1\u4F18\u5148 + \u9891\u6B21/\u70ED\u5EA6\u52A0\u6743\uFF09",
      en: "Completes the draft from history-message prefixes while typing (scored: recency first, weighted by frequency/heat)"
    },
    kind: "boolean",
    section: "history",
    writable: true
  },
  {
    key: "historyCrossSession",
    label: { zh: "\u8DE8\u4F1A\u8BDD\u641C\u7D22", en: "Cross-session search" },
    hint: {
      zh: "\u5173=\u5019\u9009\u4EC5\u5F53\u524D\u4F1A\u8BDD\uFF1B\u5F00=\u5E76\u5165\u5176\u4ED6\u4F1A\u8BDD\u7684\u9AD8\u9891\u5386\u53F2\u3002\u70ED\u5EA6\u9891\u6B21\u6253\u5206\u4E0D\u53D7\u6B64\u5F00\u5173\u5F71\u54CD",
      en: "Off = candidates from this session only; on = merge frequent history from other sessions. Hotness frequency scoring is unaffected by this switch"
    },
    kind: "boolean",
    section: "history",
    writable: true
  },
  {
    key: "historyMaxEntries",
    label: { zh: "\u6700\u5927\u5386\u53F2\u6761\u76EE", en: "Max history entries" },
    hint: {
      zh: "\u6700\u591A\u53C2\u8003\u7684\u5386\u53F2\u6761\u76EE\u6570\uFF080 = \u4E0D\u9650\uFF09",
      en: "How many history entries to consider at most (0 = unlimited)"
    },
    kind: "number",
    section: "history",
    writable: true
  },
  {
    key: "historyMinChars",
    label: { zh: "\u6700\u5C11\u8F93\u5165\u5B57\u7B26", en: "Minimum typed characters" },
    hint: {
      zh: "\u8349\u7A3F\u8F93\u5165\u591A\u5C11\u5B57\u7B26\u540E\u624D\u89E6\u53D1\u8865\u5168\uFF08\u907F\u514D\u8FC7\u65E9\u5F39\u6846\uFF09",
      en: "How many characters must be typed before completion kicks in (avoids popping up too early)"
    },
    kind: "number",
    section: "history",
    writable: true
  },
  {
    key: "wordAccept",
    label: { zh: "\u9010\u8BCD\u91C7\u7EB3", en: "Word-by-word accept" },
    hint: {
      zh: "\u5E7D\u7075\u663E\u793A\u65F6\u6309 \u2192 \u6BCF\u6B21\u91C7\u7EB3\u4E00\u4E2A\u8BCD\uFF08\u4E2D\u6587\u6309\u8BCD\u5178\u5206\u8BCD\uFF09\uFF1BTab \u59CB\u7EC8\u6574\u6761\u91C7\u7EB3\u3002\u5BF9\u4E24\u79CD\u5EFA\u8BAE\u6A21\u5F0F\u90FD\u751F\u6548",
      en: "While the ghost shows, \u2192 accepts one word at a time (Chinese segments via dictionary); Tab always accepts the whole text. Applies to both suggestion modes"
    },
    kind: "boolean",
    section: "history",
    writable: true
  },
  // —— 语言设置 ——
  {
    key: "languageMode",
    label: { zh: "\u5EFA\u8BAE\u8BED\u8A00", en: "Suggestion language" },
    hint: {
      zh: "\u81EA\u52A8\uFF1A\u7ED3\u5408\u754C\u9762\u8BED\u8A00\u4E0E\u6D88\u606F\u5185\u5BB9\u63A8\u65AD\uFF1B\u6307\u5B9A\uFF1A\u59CB\u7EC8\u4F7F\u7528\u6240\u9009\u8BED\u8A00",
      en: "Auto: infer from UI locale and message content; Specified: always use the selected language"
    },
    kind: "select",
    section: "language",
    writable: true,
    options: [
      { value: "auto", label: { zh: "\u81EA\u52A8", en: "Auto" } },
      { value: "zh", label: { zh: "\u7B80\u4F53\u4E2D\u6587", en: "Simplified Chinese" } },
      { value: "zh-TW", label: { zh: "\u7E41\u9AD4\u4E2D\u6587", en: "Traditional Chinese" } },
      { value: "en", label: { zh: "English", en: "English" } },
      { value: "ja", label: { zh: "\u65E5\u672C\u8A9E", en: "Japanese" } },
      { value: "ko", label: { zh: "\uD55C\uAD6D\uC5B4", en: "Korean" } },
      { value: "ru", label: { zh: "\u0420\u0443\u0441\u0441\u043A\u0438\u0439", en: "Russian" } },
      { value: "fr", label: { zh: "Fran\xE7ais", en: "French" } },
      { value: "de", label: { zh: "Deutsch", en: "German" } },
      { value: "es", label: { zh: "Espa\xF1ol", en: "Spanish" } }
    ]
  },
  {
    key: "uiLocaleWeight",
    label: { zh: "\u754C\u9762\u8BED\u8A00\u6743\u91CD", en: "UI language weight" },
    hint: {
      zh: "\u81EA\u52A8\u6A21\u5F0F\u4E0B\u754C\u9762\u8BED\u8A00\u7684\u5F71\u54CD\u529B\uFF080-500\uFF09\uFF1B\u503C\u8D8A\u5927\u8D8A\u503E\u5411\u754C\u9762\u8BED\u8A00\uFF0C0 = \u5B8C\u5168\u5FFD\u7565\u754C\u9762\u8BED\u8A00",
      en: "Influence of the UI locale in auto mode (0-500); higher = stronger preference for UI language, 0 = ignore UI locale entirely"
    },
    kind: "number",
    section: "language",
    writable: true
  }
];
var zhStrings = {
  /** 只读提示 */
  readOnly: "\u5F53\u524D\u90E8\u7F72\u4E0D\u53EF\u5199\uFF08\u5185\u5B58\u6A21\u5F0F\uFF09",
  /** 策略字段（非 volatile）只能改配置文件 */
  configOnly: "\u7B56\u7565\u5B57\u6BB5\uFF1Ahost \u7AEF\u672A\u5F00\u653E\u5199\u5165\uFF0C\u8BF7\u6539 cordis.patch.yml",
  /** 显示设置 section（仅详情页显示） */
  sectionDisplay: "\u663E\u793A\u8BBE\u7F6E",
  showInSettings: "\u5728\u8BBE\u7F6E\u4E2D\u663E\u793A",
  showInSettingsHint: "\u5728\u8BBE\u7F6E\u5BF9\u8BDD\u6846\u4E2D\u663E\u793A\u672C\u63D2\u4EF6\u7684\u8BBE\u7F6E\u9875\uFF08\u5237\u65B0\u9875\u9762\u540E\u751F\u6548\uFF09",
  /** 分组标题 */
  sectionLlm: "LLM \u4E0B\u4E00\u6761\u5EFA\u8BAE",
  sectionHistory: "\u5386\u53F2\u524D\u7F00\u8865\u5168",
  sectionLanguage: "\u8BED\u8A00\u8BBE\u7F6E",
  /** 帮助按钮无障碍标签（label 为字段名） */
  helpFor: (label) => `${label}\u8BF4\u660E`,
  /** footer 状态与按钮 */
  saved: "\u5DF2\u4FDD\u5B58",
  discard: "\u653E\u5F03\u4FEE\u6539",
  saving: "\u4FDD\u5B58\u4E2D\u2026",
  save: "\u4FDD\u5B58",
  /** 数字字段校验错误 */
  invalidNumber: "\u8BF7\u8F93\u5165\u6570\u5B57",
  /** 快捷键控件 */
  keyCapturing: "\u6309\u4E0B\u7EC4\u5408\u952E\u2026\uFF08Esc \u53D6\u6D88\uFF09",
  keyEmpty: "\u70B9\u51FB\u8BBE\u7F6E\u5FEB\u6377\u952E",
  // —— 热度管理 ——
  sectionHotness: "\u70ED\u5EA6\u7BA1\u7406\uFF08\u8DE8\u4F1A\u8BDD\u9AD8\u9891\u77ED\u8BED\uFF09",
  hotHint: "\u5373\u65F6\u751F\u6548\uFF0C\u65E0\u9700\u4FDD\u5B58\u3002\u5220\u9664\u53EA\u6E05\u5F53\u524D\u7EDF\u8BA1\uFF08\u518D\u6B21\u8F93\u5165\u4F1A\u91CD\u65B0\u8BA1\u5165\uFF09\uFF1B\u56FA\u5B9A\u540E\u4E0D\u53C2\u4E0E\u6DD8\u6C70\u3001\u8DE8\u4F1A\u8BDD\u5019\u9009\u6052\u7F6E\u9876\u3002",
  hotSearch: "\u5728\u4E0B\u65B9\u5217\u8868\u4E2D\u8FC7\u6EE4\u2026",
  hotEmpty: "\u6682\u65E0\u70ED\u5EA6\u6761\u76EE\u2014\u2014\u6B63\u5E38\u4F7F\u7528\u51E0\u4E2A\u56DE\u5408\u540E\u81EA\u52A8\u7D2F\u79EF\u3002",
  hotNoMatch: "\u6CA1\u6709\u5339\u914D\u7684\u6761\u76EE\uFF08\u4EC5\u8FC7\u6EE4\u5F53\u524D\u663E\u793A\u7684 top-K\uFF09\u3002",
  hotAdd: "\u6DFB\u52A0",
  hotAddPlaceholder: "\u624B\u5DE5\u65B0\u589E\u4E00\u6761\u5019\u9009\u77ED\u8BED\u2026",
  hotPin: "\u56FA\u5B9A",
  hotUnpin: "\u53D6\u6D88\u56FA\u5B9A",
  hotPinnedBadge: "\u5DF2\u56FA\u5B9A",
  hotDelete: "\u5220\u9664",
  hotClear: "\u6E05\u7A7A\u5168\u90E8",
  hotClearConfirm: "\u786E\u8BA4\u6E05\u7A7A\uFF1F",
  hotMeta: (total, shown) => total > shown ? `\u5171 ${total} \u6761\uFF0C\u663E\u793A\u70ED\u5EA6\u6700\u9AD8\u7684 ${shown} \u6761` : `\u5171 ${total} \u6761`
};
var enStrings = {
  readOnly: "Not writable in this deployment (in-memory mode)",
  configOnly: "Strategy field: not writable from the UI \u2014 edit cordis.patch.yml",
  sectionDisplay: "Display",
  showInSettings: "Show in settings",
  showInSettingsHint: "Show this plugin's settings page in the settings dialog (refresh to take effect)",
  sectionLlm: "LLM next suggestion",
  sectionHistory: "History prefix completion",
  sectionLanguage: "Language settings",
  helpFor: (label) => `About ${label}`,
  saved: "Saved",
  discard: "Discard changes",
  saving: "Saving\u2026",
  save: "Save",
  invalidNumber: "Enter a number",
  keyCapturing: "Press a key combo\u2026 (Esc to cancel)",
  keyEmpty: "Click to set a shortcut",
  // —— Hotness management ——
  sectionHotness: "Hotness management (frequent cross-session phrases)",
  hotHint: "Takes effect immediately, no save needed. Delete only clears the current tally (typing it again re-counts); pinned entries are exempt from eviction and always lead cross-session candidates.",
  hotSearch: "Filter the list below\u2026",
  hotEmpty: "No entries yet \u2014 they accumulate automatically after a few turns of normal use.",
  hotNoMatch: "No matching entries (filters the displayed top-K only).",
  hotAdd: "Add",
  hotAddPlaceholder: "Manually add a candidate phrase\u2026",
  hotPin: "Pin",
  hotUnpin: "Unpin",
  hotPinnedBadge: "Pinned",
  hotDelete: "Delete",
  hotClear: "Clear all",
  hotClearConfirm: "Confirm clear?",
  hotMeta: (total, shown) => total > shown ? `${total} total, showing the top ${shown} by heat` : `${total} total`
};
var GHOST_STRINGS = { zh: zhStrings, en: enStrings };
var zhPredictionStrings = {
  section: "\u9884\u6D4B\u8DEF\u7531\u4E0E\u72B6\u6001",
  explain: "\u6A21\u578B\u9884\u6D4B\u7EE7\u627F\u7236\u4F1A\u8BDD\u7684\u8DEF\u7531\uFF1A\u7236\u4F1A\u8BDD\u7528 GPT \u5219\u9884\u6D4B\u4E5F\u7528 GPT\uFF0C\u7236\u4F1A\u8BDD\u7528 DeepSeek \u5219\u9884\u6D4B\u4E5F\u7528 DeepSeek\u3002\u7236\u8DEF\u7531\u4E0D\u53EF\u8C03\u7528\u65F6\u9884\u6D4B\u4E0D\u53EF\u7528\uFF08route_unavailable\uFF09\uFF0C\u5386\u53F2\u524D\u7F00\u8865\u5168\u4E0D\u53D7\u5F71\u54CD\u3002",
  scopeHint: "\u6570\u636E\u6765\u81EA\u5BBF\u4E3B\u6700\u8FD1\u4E00\u6B21\u63A8\u9001\uFF08`_push` \u5168\u5C40\u5355\u69FD\uFF09\uFF1B\u5207\u6362\u5230\u522B\u7684\u4F1A\u8BDD\u540E\u53EF\u80FD\u4ECD\u662F\u4E0A\u4E00\u6761\u8BB0\u5F55\u3002",
  noPush: "\u5BBF\u4E3B\u5C1A\u672A\u63A8\u9001\u9884\u6D4B\u8BCA\u65AD\uFF08\u65E7\u534F\u8BAE\uFF0C\u6216\u5C1A\u65E0\u9884\u6D4B\u8BB0\u5F55\uFF09\u3002",
  routeLabel: "\u9884\u6D4B\u8DEF\u7531",
  routeSourceLabel: "\u8DEF\u7531\u6765\u6E90",
  routeInherited: "\u7EE7\u627F\u7236\u4F1A\u8BDD",
  routeConfigured: "\u663E\u5F0F\u914D\u7F6E\uFF08\u517C\u5BB9\u5B57\u6BB5\uFF09",
  routeUnknown: "\u672A\u63D0\u4F9B",
  effortParent: "\u7236\u4F1A\u8BDD\u6863\uFF08parent\uFF09",
  effortConfigured: "\u914D\u7F6E\u6863\uFF08configured\uFF09",
  effortEffective: "\u5B9E\u9645\u6863\uFF08effective\uFF09",
  effortEmpty: "\u7559\u7A7A\uFF08\u7EE7\u627F\u7236\u4F1A\u8BDD\u6863\uFF09",
  effortInherit: "\u7EE7\u627F\u7236\u4F1A\u8BDD\u6863",
  unset: "\u2014",
  statusLabel: "\u6700\u8FD1\u4E00\u6B21\u9884\u6D4B",
  noRecord: "\u5C1A\u65E0\u9884\u6D4B\u8BB0\u5F55",
  reasonLabel: "\u539F\u56E0",
  errorLabel: "\u6700\u8FD1\u4E00\u6B21\u9519\u8BEF",
  sourceTurnLabel: "\u6E90\u56DE\u5408",
  /** 记录时间 */
  timeLabel: "\u8BB0\u5F55\u65F6\u95F4",
  /** 上一次预测的耗时（诊断「慢」还是「失败」的关键字段） */
  durationLabel: "\u8017\u65F6",
  durationRunning: "\u8FDB\u884C\u4E2D\u2026",
  routeUnavailableHint: "\u7236\u4F1A\u8BDD\u8DEF\u7531\u4E0D\u53EF\u8C03\u7528\uFF1A\u9884\u6D4B\u4E0D\u53EF\u7528\uFF1B\u5386\u53F2\u524D\u7F00\u8865\u5168\u4E0D\u53D7\u5F71\u54CD\u3002"
};
var enPredictionStrings = {
  section: "Prediction route & status",
  explain: "Model prediction inherits the parent session route: a GPT parent predicts with GPT, a DeepSeek parent predicts with DeepSeek. When the parent route cannot be called, prediction is unavailable (route_unavailable) while history prefix completion is unaffected.",
  scopeHint: "Data comes from the host's latest push (the `_push` global slot); after switching sessions it may still be the previous record.",
  noPush: "The host has not pushed prediction diagnostics yet (older protocol, or no prediction record yet).",
  routeLabel: "Prediction route",
  routeSourceLabel: "Route source",
  routeInherited: "Inherited from parent",
  routeConfigured: "Explicitly configured (legacy field)",
  routeUnknown: "Not provided",
  effortParent: "Parent effort (parent)",
  effortConfigured: "Configured effort (configured)",
  effortEffective: "Effective effort (effective)",
  effortEmpty: "Empty (inherits the parent session effort)",
  effortInherit: "inherits the parent session effort",
  unset: "\u2014",
  statusLabel: "Latest prediction",
  noRecord: "No prediction record yet",
  reasonLabel: "Reason",
  errorLabel: "Latest error",
  sourceTurnLabel: "Source turn",
  timeLabel: "Recorded at",
  durationLabel: "Duration",
  durationRunning: "in progress\u2026",
  routeUnavailableHint: "The parent session route cannot be called: prediction is unavailable; history prefix completion is unaffected."
};
var zhPredictionOutcomes = {
  suggested: "\u5DF2\u7ED9\u51FA\u5EFA\u8BAE",
  abstained: "\u6A21\u578B\u5224\u5B9A\u6CA1\u6709\u4E0B\u4E00\u6761\uFF08\u660E\u786E\u5F03\u6743\uFF0C\u4E0D\u662F\u5931\u8D25\uFF09",
  failed: "\u751F\u6210\u5931\u8D25",
  cancelled: "\u5DF2\u53D6\u6D88\uFF08\u6E90\u56DE\u5408\u53D8\u5316\u6216\u63D2\u4EF6\u5378\u8F7D\uFF09",
  consumed: "\u5EFA\u8BAE\u5DF2\u88AB\u91C7\u7EB3",
  in_flight: "\u751F\u6210\u4E2D",
  cache_hit: "\u547D\u4E2D\u7F13\u5B58\uFF08\u672A\u53D1\u8D77\u65B0\u8BF7\u6C42\uFF09",
  in_flight_reused: "\u590D\u7528\u8FDB\u884C\u4E2D\u7684\u8BF7\u6C42",
  started: "\u5DF2\u53D1\u8D77\u8BF7\u6C42",
  stale_source: "\u6E90\u56DE\u5408\u5DF2\u8FC7\u671F",
  ineligible: "\u4E0D\u6EE1\u8DB3\u89E6\u53D1\u6761\u4EF6"
};
var enPredictionOutcomes = {
  suggested: "Suggestion produced",
  abstained: "Model decided there is no next step (explicit abstention, not a failure)",
  failed: "Generation failed",
  cancelled: "Cancelled (source turn changed, or plugin unloaded)",
  consumed: "Suggestion accepted",
  in_flight: "In flight",
  cache_hit: "Cache hit (no new request)",
  in_flight_reused: "Reused an in-flight request",
  started: "Request started",
  stale_source: "Source turn went stale",
  ineligible: "Not eligible"
};
var zhPredictionReasons = {
  empty_body: "\u6A21\u578B\u8FD4\u56DE\u7A7A\u6B63\u6587",
  invalid_json: "\u8FD4\u56DE\u5185\u5BB9\u4E0D\u662F\u5408\u6CD5 JSON",
  schema_mismatch: 'JSON \u5F62\u72B6\u4E0D\u7B26\uFF08\u5E94\u4E3A {"suggestion": string|null}\uFF09',
  tool_call: "\u6A21\u578B\u53D1\u8D77\u4E86\u5DE5\u5177\u8C03\u7528",
  abnormal_finish: "\u7ED3\u675F\u539F\u56E0\u5F02\u5E38",
  transport: "\u4F20\u8F93\u5931\u8D25",
  timeout: "\u8D85\u65F6",
  route_unavailable: "\u7236\u4F1A\u8BDD\u8DEF\u7531\u4E0D\u53EF\u8C03\u7528",
  fork_failed: "\u7EE7\u627F\u7236\u4F1A\u8BDD\u4E0A\u4E0B\u6587\u5931\u8D25\uFF08fork\uFF09",
  ineligible: "\u4E0D\u6EE1\u8DB3\u89E6\u53D1\u6761\u4EF6",
  stale_source: "\u751F\u6210\u671F\u95F4\u6E90\u56DE\u5408\u5DF2\u53D8\u5316"
};
var enPredictionReasons = {
  empty_body: "Model returned an empty body",
  invalid_json: "Response is not valid JSON",
  schema_mismatch: 'JSON shape mismatch (expected {"suggestion": string|null})',
  tool_call: "Model issued a tool call",
  abnormal_finish: "Abnormal finish reason",
  transport: "Transport failure",
  timeout: "Timed out",
  route_unavailable: "Parent session route is unavailable",
  fork_failed: "Failed to inherit the parent context (fork)",
  ineligible: "Not eligible",
  stale_source: "Source turn changed during generation"
};
var PREDICTION_STRINGS = {
  zh: zhPredictionStrings,
  en: enPredictionStrings
};
var PREDICTION_OUTCOMES = {
  zh: zhPredictionOutcomes,
  en: enPredictionOutcomes
};
var PREDICTION_REASONS = {
  zh: zhPredictionReasons,
  en: enPredictionReasons
};
function displayValue(v) {
  if (typeof v === "boolean") return v ? "true" : "false";
  return v === void 0 || v === null ? "" : String(v);
}
function ChevronDown({ className }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("svg", { width: "14", height: "14", viewBox: "0 0 16 16", className, "aria-hidden": "true", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M4 6l4 4 4-4", stroke: "currentColor", strokeWidth: "1.5", fill: "none", strokeLinecap: "round", strokeLinejoin: "round" }) });
}
function HelpIcon() {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("svg", { width: "12", height: "12", viewBox: "0 0 14 14", fill: "none", "aria-hidden": "true", strokeWidth: "1", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M12.5757 7.00012C12.5757 3.92085 10.0794 1.42463 7.00012 1.42456C3.9208 1.42456 1.42456 3.9208 1.42456 7.00012C1.42463 10.0794 3.92085 12.5757 7.00012 12.5757C10.0793 12.5756 12.5756 10.0793 12.5757 7.00012ZM13.8002 7.00012C13.8001 10.7559 10.7559 13.8001 7.00012 13.8002C3.2443 13.8002 0.199291 10.7559 0.199219 7.00012C0.199219 3.24426 3.24426 0.199219 7.00012 0.199219C10.7559 0.199291 13.8002 3.2443 13.8002 7.00012Z", fill: "currentColor" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M7.6127 3.18921V4.55986H6.38735V3.18921H7.6127Z", fill: "currentColor" }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("path", { d: "M7.6127 5.68921V10.8109H6.38735V5.68921H7.6127Z", fill: "currentColor" })
  ] });
}
function KeyField({ id, value, disabled, t, onChange }) {
  const [capturing, setCapturing] = (0, import_react3.useState)(false);
  (0, import_react3.useEffect)(() => {
    if (!capturing) return;
    const onKey = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturing(false);
        return;
      }
      const spec = keyEventToSpec(event);
      if (spec !== void 0) {
        onChange(spec);
        setCapturing(false);
      }
    };
    const cancel = () => setCapturing(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
    };
  }, [capturing, onChange]);
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
    "button",
    {
      type: "button",
      id,
      className: capturing ? "fsr-key fsr-keyCapturing" : "fsr-key",
      disabled,
      onClick: () => setCapturing((c) => !c),
      children: capturing ? t.keyCapturing : value === "" ? t.keyEmpty : value
    }
  );
}
function HotnessSection({ scope, pushRaw, writable, busy, lang, t, uiLocale }) {
  const [search, setSearch] = (0, import_react3.useState)("");
  const [adding, setAdding] = (0, import_react3.useState)("");
  const [confirmClear, setConfirmClear] = (0, import_react3.useState)(false);
  const opsRev = (0, import_react3.useRef)(0);
  (0, import_react3.useEffect)(() => {
    if (!confirmClear) return;
    const timer = window.setTimeout(() => setConfirmClear(false), 3e3);
    return () => window.clearTimeout(timer);
  }, [confirmClear]);
  const disabled = !writable || busy;
  let hot = [];
  let total = 0;
  if (typeof pushRaw === "string" && pushRaw !== "" && pushRaw !== "null") {
    try {
      const parsed = JSON.parse(pushRaw);
      if (Array.isArray(parsed.hot)) hot = parsed.hot;
      if (typeof parsed.total === "number") total = parsed.total;
    } catch {
    }
  }
  if (!Number.isFinite(total) || total < hot.length) total = hot.length;
  const sendOps = (ops) => {
    if (!writable) return;
    opsRev.current += 1;
    const payload = { rev: opsRev.current, ops };
    if (uiLocale) payload.locale = uiLocale;
    void scope.set("_ops", JSON.stringify(payload));
  };
  const needle = search.trim().toLowerCase();
  const visible = needle === "" ? hot : hot.filter((entry) => entry.text.toLowerCase().includes(needle));
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "fsr-hint", children: t.hotHint }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "input",
      {
        className: "fsr-input",
        type: "text",
        "aria-label": t.hotSearch,
        placeholder: t.hotSearch,
        value: search,
        disabled,
        onChange: (e) => setSearch(e.target.value)
      }
    ),
    hot.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "fsr-hint", children: t.hotEmpty }) : visible.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "fsr-hint", children: t.hotNoMatch }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "fsr-hotList", role: "list", children: visible.map((entry) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "fsr-hotRow", role: "listitem", children: [
      entry.pinned === true && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "fsr-hotPinFlag", children: t.hotPinnedBadge }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "fsr-hotText", title: entry.text, children: entry.text }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "fsr-hotCount", children: [
        "\xD7",
        entry.count
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "button",
        {
          type: "button",
          className: "fsr-hotBtn",
          disabled,
          onClick: () => sendOps([{ op: "pin", text: entry.text, pinned: entry.pinned !== true }]),
          children: entry.pinned === true ? t.hotUnpin : t.hotPin
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "button",
        {
          type: "button",
          className: "fsr-hotBtn fsr-hotBtnDanger",
          disabled,
          onClick: () => sendOps([{ op: "delete", text: entry.text }]),
          children: t.hotDelete
        }
      )
    ] }, entry.text)) }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "fsr-hotAdd", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "input",
        {
          className: "fsr-input",
          type: "text",
          "aria-label": t.hotAddPlaceholder,
          placeholder: t.hotAddPlaceholder,
          value: adding,
          disabled,
          onChange: (e) => setAdding(e.target.value),
          onKeyDown: (e) => {
            if (e.key === "Enter" && adding.trim() !== "" && !disabled) {
              sendOps([{ op: "add", text: adding.trim(), pinned: true }]);
              setAdding("");
            }
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "button",
        {
          type: "button",
          className: "fsr-hotBtn",
          disabled: disabled || adding.trim() === "",
          onClick: () => {
            sendOps([{ op: "add", text: adding.trim(), pinned: true }]);
            setAdding("");
          },
          children: t.hotAdd
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "fsr-hotMeta", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "fsr-hint", children: t.hotMeta(total, hot.length) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "button",
        {
          type: "button",
          className: `fsr-hotBtn fsr-hotBtnDanger${confirmClear ? " fsr-hotConfirming" : ""}`,
          disabled: disabled || hot.length === 0,
          onClick: () => {
            if (!confirmClear) {
              setConfirmClear(true);
              return;
            }
            setConfirmClear(false);
            sendOps([{ op: "clear" }]);
          },
          children: confirmClear ? t.hotClearConfirm : t.hotClear
        }
      )
    ] })
  ] });
}
var asText = (v) => typeof v === "string" && v !== "" ? v : null;
var asNumber = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
var asRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
function readPushDiagnostics(pushRaw) {
  if (typeof pushRaw !== "string" || pushRaw === "" || pushRaw === "null") return null;
  let parsed;
  try {
    const rec = asRecord(JSON.parse(pushRaw));
    if (rec === null) return null;
    parsed = rec;
  } catch {
    return null;
  }
  const routeRaw = asRecord(parsed.route);
  const predRaw = asRecord(parsed.prediction);
  const sourceRaw = routeRaw === null ? null : asText(routeRaw.source);
  return {
    protocol: asNumber(parsed.protocol),
    error: asText(parsed.error),
    route: routeRaw === null ? null : {
      provider: asText(routeRaw.provider),
      model: asText(routeRaw.model),
      parentEffort: asText(routeRaw.parentEffort),
      configuredEffort: asText(routeRaw.configuredEffort),
      effectiveEffort: asText(routeRaw.effectiveEffort),
      source: sourceRaw === "inherited" || sourceRaw === "configured" ? sourceRaw : null
    },
    prediction: predRaw === null ? null : {
      outcome: asText(predRaw.outcome),
      reason: asText(predRaw.reason),
      sourceTurn: asNumber(predRaw.sourceTurn),
      sourceEndSeq: asNumber(predRaw.sourceEndSeq),
      generatedAt: asNumber(predRaw.generatedAt),
      startedAt: asNumber(predRaw.startedAt),
      durationMs: asNumber(predRaw.durationMs)
    }
  };
}
function PredictionSection({ pushRaw, lang }) {
  const P = PREDICTION_STRINGS[lang];
  const outcomes = PREDICTION_OUTCOMES[lang];
  const reasons = PREDICTION_REASONS[lang];
  const diag = readPushDiagnostics(pushRaw);
  const route = diag === null ? null : diag.route;
  const pred = diag === null ? null : diag.prediction;
  const error = diag === null ? null : diag.error;
  const routeText = route === null || route.provider === null && route.model === null ? P.routeUnknown : [route.provider, route.model].filter((part) => part !== null).join(" / ");
  const sourceText = route === null || route.source === null ? P.routeUnknown : route.source === "inherited" ? P.routeInherited : P.routeConfigured;
  const configuredEffort = route === null ? null : route.configuredEffort;
  const effectiveEffort = route === null ? null : route.effectiveEffort ?? route.parentEffort;
  const inheritedNow = route !== null && (route.source === "inherited" || route.source === null && configuredEffort === null);
  const effectiveText = effectiveEffort === null ? P.unset : inheritedNow ? `${effectiveEffort} (${P.effortInherit})` : effectiveEffort;
  const outcome = pred === null ? null : pred.outcome;
  const reason = pred === null ? null : pred.reason;
  const outcomeText = outcome === null ? P.noRecord : outcomes[outcome] ?? outcome;
  const reasonText = reason === null ? null : reasons[reason] ?? reason;
  const turnText = pred === null || pred.sourceTurn === null ? null : pred.sourceEndSeq === null ? `#${String(pred.sourceTurn)}` : `#${String(pred.sourceTurn)}@${String(pred.sourceEndSeq)}`;
  const timeText = pred === null || pred.generatedAt === null ? null : new Date(pred.generatedAt).toLocaleTimeString();
  const durationText = pred === null ? null : pred.durationMs !== null ? `${(pred.durationMs / 1e3).toFixed(1)}s` : pred.startedAt !== null ? P.durationRunning : null;
  const kv = (label, value, key) => [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "fsr-kvKey", children: label }, `${key}:k`),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "fsr-kvVal", children: value }, `${key}:v`)
  ];
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "fsr-section", "aria-labelledby": "fsr-section-prediction", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { className: "fsr-section-heading", id: "fsr-section-prediction", children: P.section }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "fsr-kv", children: [
      kv(P.routeLabel, routeText, "route"),
      kv(P.routeSourceLabel, sourceText, "source"),
      kv(P.effortParent, route === null || route.parentEffort === null ? P.unset : route.parentEffort, "parent"),
      kv(P.effortConfigured, configuredEffort === null ? P.effortEmpty : configuredEffort, "configured"),
      kv(P.effortEffective, effectiveText, "effective"),
      kv(P.statusLabel, outcomeText, "outcome"),
      reasonText !== null && kv(P.reasonLabel, reasonText, "reason"),
      turnText !== null && kv(P.sourceTurnLabel, turnText, "turn"),
      durationText !== null && kv(P.durationLabel, durationText, "duration"),
      timeText !== null && kv(P.timeLabel, timeText, "time"),
      error !== null && kv(P.errorLabel, error, "error")
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "fsr-predNotes", children: [
      reason === "route_unavailable" && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "fsr-hint", children: P.routeUnavailableHint }),
      (diag === null || route === null && pred === null) && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "fsr-hint", children: P.noPush }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "fsr-hint", children: P.explain }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "fsr-hint", children: P.scopeHint })
    ] })
  ] });
}
function SuggestGhostCard({ scope, locale, surface }) {
  (0, import_react3.useEffect)(() => injectStyles(), []);
  const lang = useGhostT(locale);
  const t = GHOST_STRINGS[lang];
  const [snap, setSnap] = (0, import_react3.useState)(scope.getSnapshot());
  (0, import_react3.useEffect)(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);
  const [edits, setEdits] = (0, import_react3.useState)({});
  const [busy, setBusy] = (0, import_react3.useState)(false);
  const [saved, setSaved] = (0, import_react3.useState)(false);
  const [helpOpen, setHelpOpen] = (0, import_react3.useState)({});
  const [hotOpen, setHotOpen] = (0, import_react3.useState)(false);
  const SHOW_SETTINGS_KEY = "dsh-foresight:show-settings-section";
  const [showSettings, setShowSettings] = (0, import_react3.useState)(() => {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(SHOW_SETTINGS_KEY) === "true";
  });
  const toggleShowSettings = () => {
    const next = !showSettings;
    setShowSettings(next);
    if (typeof localStorage !== "undefined") {
      if (next) localStorage.setItem(SHOW_SETTINGS_KEY, "true");
      else localStorage.removeItem(SHOW_SETTINGS_KEY);
    }
  };
  if (snap.status === "unavailable") return null;
  const value = snap.value ?? {};
  const writable = snap.writable && snap.status === "ready";
  const isDirty = Object.keys(edits).some((k) => GHOST_FIELDS.find((f) => f.key === k)?.writable === true);
  const fieldValue = (key) => {
    if (key in edits) return String(edits[key]);
    return displayValue(value[key]);
  };
  const fieldInvalid = (f) => {
    if (f.kind !== "number" || !(f.key in edits)) return false;
    const raw = String(edits[f.key]).trim();
    return raw === "" || Number.isNaN(Number(raw));
  };
  const anyInvalid = GHOST_FIELDS.some(fieldInvalid);
  const setField = (key, raw) => {
    setEdits((prev) => ({ ...prev, [key]: raw }));
  };
  const save = async () => {
    if (anyInvalid) return;
    setBusy(true);
    try {
      for (const [key, raw] of Object.entries(edits)) {
        const def = GHOST_FIELDS.find((f) => f.key === key);
        if (!def.writable) continue;
        let final = raw;
        if (def.kind === "number") final = Number(raw);
        else if (def.kind === "boolean") final = raw === true || raw === "true";
        else if (def.kind === "key") {
          const trimmed = String(raw).trim();
          if (trimmed === "") continue;
          final = trimmed;
        }
        await scope.set(key, final);
      }
      setEdits({});
      setSaved(true);
      setTimeout(() => setSaved(false), 2e3);
    } finally {
      setBusy(false);
    }
  };
  const discard = () => setEdits({});
  const renderField = (f) => {
    const invalid = fieldInvalid(f);
    const editable = writable && f.writable;
    const fieldId = `fsr-field-${f.key}`;
    const helpId = `fsr-help-${f.key}`;
    const helpOpenNow = helpOpen[f.key] === true;
    const helpAria = t.helpFor(f.label[lang]);
    if (f.kind === "boolean") {
      const checked = fieldValue(f.key) === "true";
      return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "fsr-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "fsr-toggle-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "fsr-label-group", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "fsr-toggle-label", htmlFor: fieldId, children: f.label[lang] }) }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "button",
            {
              type: "button",
              id: fieldId,
              role: "switch",
              "aria-checked": checked,
              "aria-label": f.label[lang],
              className: "fsr-toggle-switch",
              disabled: !editable || busy,
              onClick: () => setField(f.key, !checked)
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: invalid ? "fsr-invalid" : "fsr-toggle-description", children: invalid ? t.invalidNumber : f.hint[lang] }),
        !f.writable && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "fsr-configOnly", children: t.configOnly }),
        f.note !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "fsr-configOnly", children: f.note[lang] })
      ] }, f.key);
    }
    const inputClass = [
      invalid ? "fsr-input fsr-inputInvalid" : "fsr-input",
      f.writable ? "" : "fsr-inputReadOnly"
    ].filter(Boolean).join(" ");
    const control = f.kind === "key" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      KeyField,
      {
        id: fieldId,
        value: fieldValue(f.key),
        disabled: !editable || busy,
        t,
        onChange: (spec) => setField(f.key, spec)
      }
    ) : f.kind === "select" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "select",
      {
        className: inputClass,
        id: fieldId,
        value: fieldValue(f.key),
        disabled: !editable || busy,
        onChange: (e) => setField(f.key, e.target.value),
        children: (f.options ?? []).map((opt) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("option", { value: opt.value, children: opt.label[lang] }, opt.value))
      }
    ) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "input",
      {
        className: inputClass,
        id: fieldId,
        type: "text",
        ...f.kind === "number" ? { inputMode: "numeric" } : {},
        ...invalid ? { "aria-invalid": true } : {},
        value: fieldValue(f.key),
        disabled: !editable || busy,
        onChange: (e) => setField(f.key, e.target.value)
      }
    );
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "fsr-field", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "fsr-fieldHead", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "fsr-label-group", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "fsr-label", htmlFor: fieldId, children: f.label[lang] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "button",
          {
            type: "button",
            className: helpOpenNow ? "fsr-help-btn fsr-help-btnOpen" : "fsr-help-btn",
            "aria-label": helpAria,
            "aria-expanded": helpOpenNow,
            "aria-controls": helpId,
            onClick: () => setHelpOpen((prev) => ({ ...prev, [f.key]: !helpOpenNow })),
            children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(HelpIcon, {})
          }
        )
      ] }) }),
      control,
      invalid && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "fsr-invalid", role: "status", children: t.invalidNumber }),
      helpOpenNow && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { id: helpId, role: "region", "aria-label": helpAria, className: "fsr-help", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { children: f.hint[lang] }) }),
      !f.writable && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "fsr-configOnly", children: t.configOnly }),
      f.note !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "fsr-configOnly", children: f.note[lang] })
    ] }, f.key);
  };
  const llmFields = GHOST_FIELDS.filter((f) => f.section === "llm");
  const historyFields = GHOST_FIELDS.filter((f) => f.section === "history");
  const languageFields = GHOST_FIELDS.filter((f) => f.section === "language");
  const SECTION_LAYOUT = {
    llm: "stack",
    history: "stack",
    language: "grid"
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "fsr-settings-form", children: [
    !writable && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "fsr-readOnly", role: "status", children: t.readOnly }),
    surface === "detail" && /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "fsr-section", "aria-labelledby": "fsr-section-display", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { className: "fsr-section-heading", id: "fsr-section-display", children: t.sectionDisplay }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "fsr-section-fields", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "fsr-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "fsr-toggle-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "fsr-label-group", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "fsr-toggle-label", htmlFor: "fsr-show-settings", children: t.showInSettings }) }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
            "button",
            {
              type: "button",
              id: "fsr-show-settings",
              role: "switch",
              "aria-checked": showSettings,
              "aria-label": t.showInSettings,
              className: "fsr-toggle-switch",
              onClick: toggleShowSettings
            }
          )
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "fsr-toggle-description", children: t.showInSettingsHint })
      ] }) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "fsr-section", "aria-labelledby": "fsr-section-llm", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { className: "fsr-section-heading", id: "fsr-section-llm", children: t.sectionLlm }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: SECTION_LAYOUT.llm === "grid" ? "fsr-section-fields fsr-section-fieldsGrid" : "fsr-section-fields", children: llmFields.map(renderField) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(PredictionSection, { pushRaw: value._push, lang }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "fsr-section", "aria-labelledby": "fsr-section-history", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { className: "fsr-section-heading", id: "fsr-section-history", children: t.sectionHistory }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: SECTION_LAYOUT.history === "grid" ? "fsr-section-fields fsr-section-fieldsGrid" : "fsr-section-fields", children: historyFields.map(renderField) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "fsr-section", "aria-labelledby": "fsr-section-language", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("h3", { className: "fsr-section-heading", id: "fsr-section-language", children: t.sectionLanguage }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: SECTION_LAYOUT.language === "grid" ? "fsr-section-fields fsr-section-fieldsGrid" : "fsr-section-fields", children: languageFields.map(renderField) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("section", { className: "fsr-section", "aria-labelledby": "fsr-section-hotness", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
        "button",
        {
          type: "button",
          id: "fsr-section-hotness",
          className: "fsr-sectionBtn",
          "aria-expanded": hotOpen,
          "aria-controls": "fsr-hotness-body",
          onClick: () => setHotOpen((o) => !o),
          children: [
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "fsr-sectionBtnText", children: t.sectionHotness }),
            /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ChevronDown, { className: hotOpen ? "fsr-chevron fsr-chevronOpen" : "fsr-chevron" })
          ]
        }
      ),
      hotOpen && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { id: "fsr-hotness-body", children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        HotnessSection,
        {
          scope,
          pushRaw: value._push,
          writable,
          busy,
          lang,
          t,
          uiLocale: locale?.getSnapshot?.()?.active
        }
      ) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "fsr-footer", children: [
      saved && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "fsr-status", role: "status", children: t.saved }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { className: "fsr-discard", disabled: !isDirty || busy, onClick: discard, children: t.discard }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { className: "fsr-save", disabled: !writable || busy || !isDirty || anyInvalid, onClick: () => void save(), children: busy ? t.saving : t.save })
    ] })
  ] });
}

// src/client/index.ts
var currentSessionIdOf = (snapshot) => Object.values(snapshot.byId).find((row) => (row.retainedBy?.mainView ?? 0) > 0)?.id;
function unwrapSettingsDoc(response) {
  let node = response;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof node !== "object" || node === null) return void 0;
    const record = node;
    if (Array.isArray(record.namespaces)) return record;
    if (record.ok === true) {
      node = record.value;
      continue;
    }
    if ("result" in record) {
      node = record.result;
      continue;
    }
    if ("value" in record) {
      node = record.value;
      continue;
    }
    return void 0;
  }
  return void 0;
}
var PROJECTION_KEY = "suggestGhost";
var OVERLAY_ID = "dsh-foresight-overlay";
var DEFAULT_ACCEPT_KEY = "Tab";
var SETTINGS_NAMESPACE = "dsh-foresight";
var SETTINGS_SECTION_ID = "dsh-foresight";
var SECTION_LABELS = { zh: "\u8F93\u5165\u9884\u6D4B", en: "Input prediction" };
var PULL_MAX_ATTEMPTS = 5;
var PULL_RETRY_BASE_MS = 200;
var OPS_MAX_ATTEMPTS = 3;
var OPS_RETRY_BASE_MS = 900;
var OPS_RETRY_MAX_MS = 5e3;
var OPS_RETRY_IDLE_MS = 3e4;
var PER_SESSION_CACHE_CAP = 32;
var inject = ["conversation", "sessions", "remote", "remote.settings", "slots", "locale"];
var COMPOSER_SELECTOR = "[data-input-scroll] textarea, [data-input-scroll] [data-composer-input]";
function isComposerElement(el) {
  if (el === null) return false;
  const composer = el.closest("[data-input-scroll]") !== null && (el.matches("textarea") || el instanceof HTMLElement && el.isContentEditable);
  return composer;
}
function isComposerTarget(target) {
  return target instanceof Element && isComposerElement(target);
}
function caretAtComposerEnd(el) {
  if (el instanceof HTMLTextAreaElement) {
    return el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
  }
  const selection = document.getSelection();
  if (selection === null || selection.rangeCount === 0 || !selection.isCollapsed) return false;
  if (el.textContent === "") return true;
  const range = selection.getRangeAt(0);
  let last = el.lastChild;
  while (last !== null && last.lastChild !== null) last = last.lastChild;
  if (range.endContainer === last) {
    return range.endOffset === (last.textContent?.length ?? 0);
  }
  return range.endContainer === el && range.endOffset === el.childNodes.length;
}
function parseAcceptKey(spec) {
  const parts = spec.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return void 0;
  const mods = new Set(parts.slice(0, -1));
  const keyCode = keyCodeOf(spec);
  if (keyCode === void 0) return void 0;
  return (event) => event.code === keyCode && event.altKey === mods.has("alt") && event.ctrlKey === mods.has("ctrl") && event.metaKey === mods.has("meta") && event.shiftKey === mods.has("shift");
}
var KEY_LABELS = {
  Slash: "/",
  Backslash: "\\",
  Enter: "\u21B5",
  Space: "Space",
  Backquote: "`",
  Right: "\u2192",
  Left: "\u2190",
  Up: "\u2191",
  Down: "\u2193"
};
function acceptKeyLabel(spec) {
  return spec.split("+").map((part) => KEY_LABELS[part] ?? part).join(" ");
}
function parsePrediction(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw;
  if (typeof r.requestKey !== "string" || typeof r.sessionId !== "string") return null;
  return {
    requestKey: r.requestKey,
    sessionId: r.sessionId,
    sourceTurn: typeof r.sourceTurn === "number" ? r.sourceTurn : null,
    sourceEndSeq: typeof r.sourceEndSeq === "number" ? r.sourceEndSeq : null,
    outcome: typeof r.outcome === "string" ? r.outcome : "",
    reason: typeof r.reason === "string" ? r.reason : null,
    requestId: typeof r.requestId === "string" ? r.requestId : null,
    nonce: typeof r.nonce === "string" ? r.nonce : null,
    generatedAt: typeof r.generatedAt === "number" ? r.generatedAt : null
  };
}
function parseRoute(raw) {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw;
  const str = (v) => typeof v === "string" ? v : null;
  const source = r.source;
  return {
    provider: str(r.provider),
    model: str(r.model),
    parentEffort: str(r.parentEffort),
    configuredEffort: str(r.configuredEffort),
    effectiveEffort: str(r.effectiveEffort),
    // 0.2.x 的 host 多一个 'unavailable'（父路由不可调用）；未知取值按不可用处理。
    source: source === "inherited" || source === "configured" ? source : "unavailable"
  };
}
function isPlainLlmAcceptKey(event) {
  return !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.code === "Tab" || event.code === "ArrowRight" || event.code === "Enter");
}
function newOpToken() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
var GhostOverlay = class {
  el;
  composer = null;
  /**
   * 滚动容器（`[data-input-scroll]`）。
   *
   * 定位**不用**它（overlay 随内容自动滚动），保留它只为了挂 `scroll` 监听：
   * 滚动会使内容相对视口位移，需要触发一次重对齐与自检。
   */
  scroller = null;
  onScroll;
  onResize;
  styleTag;
  /** 尺寸变化观察者：composer 自动增高/附件行出现/字体回流都会改变内容起点。 */
  resizeObserver = null;
  /** 正在显示的内容（供 ResizeObserver 回调重对齐后重新自检）。 */
  current = null;
  constructor() {
    this.el = document.createElement("div");
    this.el.id = OVERLAY_ID;
    this.el.setAttribute("aria-hidden", "true");
    this.el.style.cssText = [
      "position:absolute",
      "pointer-events:none",
      "white-space:pre-wrap",
      "word-break:break-word",
      // 不设 overflow:hidden：它会贴着盒子边界裁掉 text-shadow 光晕（明显切割感）；
      // 换行安全已由 pre-wrap + break-word 保证，盒子高度自适应无需纵向裁剪。
      // 颜色与泛光由下方样式表按建议来源（data-kind）决定，不写在内联样式里。
      "z-index:1",
      // 初值：不绘制。用 display（而非旧版的 visibility）——见下方 show()/hide()
      // 与类注释，display 让节点彻底退出渲染，避免任何过渡期双绘。
      "display:none"
    ].join(";");
    this.onScroll = () => this.alignAndVerify();
    this.onResize = () => this.alignAndVerify();
    this.styleTag = document.createElement("style");
    this.styleTag.dataset.pluginCss = "dsh-foresight";
    this.styleTag.textContent = [
      // ── 幽灵文本的外观 ──
      //
      // 基色对齐官方 composer placeholder 的色阶（label-caption，全透明度），而非更重的
      // label-secondary：保证「幽灵」比正文明显更淡。贴身 1px + 8px 的同色泛光把它和原生
      // placeholder 区分开，提示这是「可采纳的建议」；同色晕不改变色相，暗/亮主题通用。
      "#dsh-foresight-overlay{color:var(--dsw-alias-label-caption,#9aa0a6);text-shadow:0 0 1px currentColor,0 0 8px currentColor}",
      // 模型预测的建议在基色上只带一点蓝灰（混入 22% 的主题品牌色），历史补全保持基色。
      // 只改颜色，泛光、字重、布局都沿用基础规则。不认 color-mix 的 WebView 会丢弃这条声明，
      // 自然退回基色，不需要另写兜底色（纯色兜底在浅/深主题下无法同时合适）。
      '#dsh-foresight-overlay[data-kind="llm"]{color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#6b8cff) 22%,var(--dsw-alias-label-caption,#9aa0a6))}',
      // 采纳键提示：跟随文字颜色的小键帽，只占文字行内的一小块，不参与对齐自检。
      "#dsh-foresight-overlay .fsr-ghost-key{display:inline-block;box-sizing:border-box;height:16px;margin-left:8px;padding:0 6px;border:1px solid currentColor;border-radius:5px;font-family:inherit;font-size:10px;font-weight:500;line-height:14px;vertical-align:1px;opacity:.85;text-shadow:none}",
      // ── 让位规则：幽灵**正在显示**时，placeholder 必须让位 ──
      //
      // 判据同时要求 `data-shown="1"` **且** overlay 未被 `display:none` 隐藏。
      // 只写 `data-shown` 不够：`hide()` / 自检失败路径会把 display 置回 none，
      // 若此时仍据 `data-shown` 或「节点存在」去隐藏 placeholder，就会出现
      // 「幽灵没显示、占位文案也没了」——草稿清空后输入框一片空白（实测过）。
      // 反过来只据「节点存在」同样错：节点在首次 show 后就常驻 DOM 不移除。
      //
      // `:not([style*="display: none"])` 读的是内联 style（本插件唯一写 display
      // 的地方），故与自身写入的状态严格同步，无属性时序竞态。
      'body:has(#dsh-foresight-overlay[data-shown="1"]:not([style*="display: none"])) [data-composer-placeholder]{display:none!important}',
      'body:has(#dsh-foresight-overlay[data-shown="1"]:not([style*="display: none"])) textarea::placeholder{visibility:hidden!important}',
      // 兜底：编辑器自带 data-placeholder 属性的伪元素（部分宿主形态）以及
      // 依赖 `[data-placeholder]` 出文案的 ::before/::after 实现。
      'body:has(#dsh-foresight-overlay[data-shown="1"]:not([style*="display: none"])) [data-composer-input][data-placeholder]::before{content:none!important}',
      'body:has(#dsh-foresight-overlay[data-shown="1"]:not([style*="display: none"])) [data-composer-input][data-placeholder]::after{content:none!important}'
    ].join("\n");
    if (typeof document !== "undefined") document.head.appendChild(this.styleTag);
  }
  /** 当前绑定的输入框（未绑定时为 null）。 */
  get currentTextarea() {
    return this.composer;
  }
  /** 绑定到当前输入框（若变化则重建对齐）。 */
  attach(composer) {
    const parent = composer.parentElement;
    if (this.composer === composer && this.el.isConnected && this.el.parentElement === parent) return;
    this.detach();
    this.composer = composer;
    this.scroller = composer.closest("[data-input-scroll]");
    if (parent !== null) parent.appendChild(this.el);
    composer.addEventListener("scroll", this.onScroll, { passive: true });
    this.scroller?.addEventListener("scroll", this.onScroll, { passive: true });
    window.addEventListener("resize", this.onResize);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(composer);
      if (this.scroller !== null) this.resizeObserver.observe(this.scroller);
      if (parent !== null) this.resizeObserver.observe(parent);
    }
    this.alignAndVerify();
  }
  detach() {
    if (this.composer !== null) {
      this.composer.removeEventListener("scroll", this.onScroll);
      this.composer = null;
    }
    if (this.scroller !== null) {
      this.scroller.removeEventListener("scroll", this.onScroll);
      this.scroller = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.current = null;
    this.el.dataset.shown = "0";
    this.el.style.display = "none";
    window.removeEventListener("resize", this.onResize);
    this.el.remove();
  }
  /**
   * 对齐 overlay 到输入框内容区（含 padding 起点）。
   *
   * ## 为什么**不做**滚动补偿（实测结论，勿回退）
   *
   * overlay 挂在 `.grow` 上，而 `.grow` 是滚动容器 `[data-input-scroll]` 的**子
   * 节点**——即 overlay 位于「被滚动的内容」坐标系里。滚动容器滚动时 `.grow`
   * 整体一起位移（实测 `scrollTop=120` 时 `.grow` 的 rect.top 同步上移 120），
   * 因此 overlay **自动跟随内容滚动，无需任何 scrollTop 项**。
   *
   * 实测反证（`.grow` 上的探针元素，`scrollTop=120`）：
   *  - `rect 差 - scrollTop` → 幽灵落在 `64`，正文在 `184`：**漂移 `-scrollTop`**；
   *  - `rect 差 + scrollTop` → 幽灵恒定不动，漂移 `+scrollTop`；
   *  - `offsetTop + paddingTop`（**本实现**）→ 与正文逐像素重合（5 个滚动位置全对）。
   *
   * 另注：rect 差在这里恒为 0（`.grow` 与编辑器一起移动、同点），用它会把真实的
   * 内容偏移丢掉；`offsetTop/offsetLeft` 相对 `offsetParent`，与滚动无关，才是
   * 「内容坐标系」里的正确坐标。
   */
  align() {
    const ta = this.composer;
    if (ta === null) return;
    const style = getComputedStyle(ta);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const padTop = parseFloat(style.paddingTop) || 0;
    const padRight = parseFloat(style.paddingRight) || 0;
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    this.el.style.left = `${ta.offsetLeft + borderLeft + padLeft}px`;
    this.el.style.top = `${ta.offsetTop + borderTop + padTop}px`;
    const width = ta.clientWidth - padLeft - padRight;
    this.el.style.width = `${width > 0 ? width : ta.clientWidth}px`;
    this.el.style.fontFamily = style.fontFamily;
    this.el.style.fontSize = style.fontSize;
    this.el.style.lineHeight = style.lineHeight;
    this.el.style.fontWeight = style.fontWeight;
    this.el.style.letterSpacing = style.letterSpacing;
    this.el.style.boxSizing = "border-box";
  }
  /**
   * 对齐后做几何自检：定位明显失真时宁可不显示，也绝不糊在正文上。
   *
   * ## 判据（依据实测，不是推测）
   *
   * overlay 是 `.grow` 的子节点，随内容一起滚动——所以「幽灵跑到滚动视口外」是
   * **正常且正确**的（正文也一起滚出去了，被滚动容器裁掉）。因此**不能**用
   * 「必须落在滚动视口内」当判据：实测 `scrollTop=384` 时幽灵与正文同在
   * `top=-80`，两者都被裁掉，这是正确的。
   *
   * 真正要防的是**定位失真**：overlay 没有落在编辑器内容原点上（例如宿主要
   * 在 `.grow` 与编辑器之间插入带 padding/border 的新层，或 `.grow` 不再是
   * offsetParent）。此时幽灵会浮在别的内容上——就是用户报告的重叠。
   *
   * 判据：幽灵左上角与「编辑器在 offsetParent 内的内容原点」之差必须在一个
   * 行高量级内。偏差超过一行，说明坐标系假设已被宿主破坏，放弃显示。
   */
  verify() {
    const ta = this.composer;
    if (ta === null) return false;
    const host = this.el.offsetParent;
    if (!(host instanceof HTMLElement)) return false;
    const ghostRect = this.el.getBoundingClientRect();
    const expectedTop = ta.getBoundingClientRect().top + (parseFloat(getComputedStyle(ta).paddingTop) || 0);
    const drift = Math.abs(ghostRect.top - expectedTop);
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight);
    const tolerance = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 24;
    if (drift > tolerance) return false;
    const expectedLeft = ta.getBoundingClientRect().left + (parseFloat(getComputedStyle(ta).paddingLeft) || 0);
    if (Math.abs(ghostRect.left - expectedLeft) > tolerance) return false;
    return host.contains(ta) || host === ta.parentElement;
  }
  /**
   * 对齐 + 自检；自检失败则隐藏（保持 current 以便下次事件重试）。
   *
   * ## 两条顺序约束（都踩过坑，勿调换）
   *
   * 1. **必须先 `display:block` 再测量**：`getBoundingClientRect()` 对
   *    `display:none` 的元素恒返回全 0，先测量会把每次首帧都判为「空矩形 →
   *    不可显示」，`display` 永远停在 `none`——表现为幽灵彻底不出现。
   *
   * 2. **必须在显示之前就 `data-shown="1"`**：placeholder 的隐藏规则
   *    （`body:has(#…[data-shown="1"]) [data-composer-placeholder]{display:none}`）
   *    挂在 `data-shown` 上。若先 `display:block` 再标 `data-shown`，中间就存在
   *    一个「幽灵已可见、placeholder 还没隐藏」的窗口——两者同原点，直接重叠
   *    （实测：该窗口内 placeholder 的 computed display 仍是 block）。
   *
   * 注意两者是**不同元素上的两个开关**，互不冲突：
   *  - `data-shown` 打在 overlay 自身（控制 placeholder 是否让位）；
   *  - `display` 打在 overlay 自身（控制幽灵是否绘制）。
   * 因此正确顺序是：**先标 `data-shown` 让位 → 再 `display:block` → 测量自检
   * → 不合格则把两者一起回退**。
   */
  alignAndVerify() {
    if (this.current === null) return;
    this.align();
    this.el.dataset.shown = "1";
    this.el.style.display = "block";
    if (!this.verify()) {
      this.el.style.display = "none";
      this.el.dataset.shown = "0";
      return;
    }
  }
  /** 显示幽灵内容（对齐由滚动/尺寸事件持续维护）；隐藏 placeholder 避免重叠。 */
  show(content) {
    this.el.textContent = "";
    this.el.dataset.kind = content.kind;
    if (content.kind === "llm") {
      this.el.textContent = content.text;
    } else {
      const prefix = document.createElement("span");
      prefix.style.visibility = "hidden";
      prefix.textContent = content.prefix;
      const suffix = document.createElement("span");
      suffix.textContent = content.suffix;
      this.el.append(prefix, suffix);
    }
    const key = document.createElement("span");
    key.className = "fsr-ghost-key";
    key.textContent = acceptKeyLabel(content.kind === "llm" ? content.acceptKey : DEFAULT_ACCEPT_KEY);
    this.el.append(key);
    this.current = content;
    this.alignAndVerify();
  }
  hide() {
    this.current = null;
    this.el.style.display = "none";
    this.el.textContent = "";
    this.el.dataset.shown = "0";
  }
  /**
   * 幽灵当前是否**真的**挂在文档里并处于绘制态。
   *
   * 供 render 的「内容没变化就早退」判断使用：React 重建 composer 的父节点时会把
   * 我们的私有节点一并丢掉（见 attach() 注释），而 `shown` 指纹里还留着同一份
   * 内容——只看指纹就会早退，节点的补挂永远不会发生。真机表现：切走再切回同一条
   * 建议，幽灵再也不出现（诊断标记却仍是 `projection:llm`）。
   */
  isShowing() {
    return this.el.isConnected && this.el.dataset.shown === "1" && this.el.style.display !== "none";
  }
  dispose() {
    this.detach();
    this.styleTag.remove();
  }
};
var remoteOf = (ctx) => ctx.get("remote");
var sectionLabel = (locale) => {
  const active = locale === void 0 ? "zh" : locale.getSnapshot().active;
  return active === "en" ? SECTION_LABELS.en : SECTION_LABELS.zh;
};
function applyInner(ctx) {
  applyBody(ctx);
}
function applyBody(ctx) {
  const sessions = ctx.get("sessions");
  if (sessions === void 0) return;
  const overlay = new GhostOverlay();
  let lastSessionId;
  let bound = null;
  let shown = null;
  let composing = false;
  let lastSourceLabel = "none";
  const perSession = /* @__PURE__ */ new Map();
  const cachePut = (sessionId, suggestion, history, prediction, route) => {
    const prev = perSession.get(sessionId);
    perSession.delete(sessionId);
    perSession.set(sessionId, {
      // 省略（undefined）= 本次载荷不携带该字段，保留旧值；`null` 是**权威的**
      // 「该会话没有」，必须覆盖（与 history 的省略语义一致）。
      suggestion: suggestion === void 0 ? prev?.suggestion ?? null : suggestion,
      history: history ?? prev?.history ?? [],
      prediction: prediction === void 0 ? prev?.prediction ?? null : prediction,
      route: route === void 0 ? prev?.route ?? null : route
    });
    while (perSession.size > PER_SESSION_CACHE_CAP) {
      const oldest = perSession.keys().next().value;
      if (oldest === void 0) break;
      perSession.delete(oldest);
    }
  };
  const cacheGet = (sessionId) => {
    const cached = perSession.get(sessionId);
    if (cached === void 0) return void 0;
    perSession.delete(sessionId);
    perSession.set(sessionId, cached);
    return cached;
  };
  let settings = {
    historyEnabled: true,
    historyCrossSession: false,
    historyMaxEntries: 50,
    historyMinChars: 1,
    wordAccept: true,
    llmEnabled: true,
    protocol: 1,
    prediction: null,
    route: null,
    nonce: null,
    suggestion: null,
    hot: null,
    history: [],
    historySessionId: null,
    suggestionSessionId: null
  };
  const resolve = () => {
    const id = currentSessionIdOf(sessions.list.getSnapshot());
    if (id === void 0) {
      bound = null;
      lastSessionId = void 0;
      return;
    }
    if (id === lastSessionId && bound !== null) return;
    const actx = sessions.scope(id);
    if (actx === void 0) return;
    const session = sessions.sessionOf(actx);
    if (session === void 0) return;
    const conversation = actx.get("conversation");
    if (conversation === void 0) return;
    const input = conversation.input.for(actx);
    if (input === void 0) return;
    lastSessionId = id;
    bound = {
      session,
      input,
      projectionFace: session.projections.faceOf(PROJECTION_KEY)
    };
    if (id !== lastPulledSessionId) {
      lastPulledSessionId = id;
      pullHistory(id);
    }
  };
  const predictionFor = (sessionId) => settings.prediction !== null && settings.prediction.sessionId === sessionId ? settings.prediction : cacheGet(sessionId)?.prediction ?? null;
  const ghostContent = () => {
    if (bound === null) return null;
    if (composing) return null;
    const snapshot = bound.session.getSnapshot();
    const draft = bound.input.state.getSnapshot().draft;
    const currentId = currentSessionIdOf(sessions.list.getSnapshot()) ?? "";
    const cached = cacheGet(currentId);
    const suggestion = settings.suggestionSessionId === currentId ? settings.suggestion : cached?.suggestion ?? null;
    const history = settings.historySessionId === currentId ? settings.history : cached?.history ?? [];
    lastSourceLabel = settings.suggestionSessionId === currentId || settings.historySessionId === currentId ? "push" : "cache";
    if (settings.historyEnabled && draft.trim() !== "") {
      const contentDraft = stripCommandPrefix(draft);
      if (contentDraft.trim() === "") return null;
      const hot = settings.hot;
      const hotCounts = hot !== null && hot.length > 0 ? new Map(hot.map((h) => [normalizeForMatch(h.text), h.count])) : void 0;
      const full = historySuggestion(history, contentDraft, {
        minChars: settings.historyMinChars,
        maxEntries: settings.historyMaxEntries,
        hotCounts,
        extraCandidates: settings.historyCrossSession ? hot ?? void 0 : void 0
      });
      if (full === void 0) return null;
      const common = commonPrefixLength(contentDraft, full);
      return { kind: "history", prefix: draft, suffix: full.slice(common), full };
    }
    if (draft !== "") return null;
    if (!settings.llmEnabled) return null;
    if (suggestion === null) return null;
    if (snapshot.running) return null;
    if (settings.protocol >= 2) {
      if (!modelConfirmed) return null;
      const prediction = predictionFor(currentId);
      if (prediction === null || prediction.sessionId !== currentId || prediction.outcome !== "suggested") return null;
      if (isConsumed(currentId, prediction.requestKey)) return null;
    }
    return { kind: "llm", text: suggestion.text, acceptKey: suggestion.acceptKey };
  };
  let cachedComposer = null;
  let composerRetryTimer = null;
  let composerRetries = 0;
  const retryRenderSoon = () => {
    if (composerRetryTimer !== null || composerRetries >= 8) return;
    composerRetries += 1;
    composerRetryTimer = setTimeout(() => {
      composerRetryTimer = null;
      render();
    }, 150);
  };
  const render = () => {
    resolve();
    retryPendingPull();
    maybeRequestCatchUp();
    const content = ghostContent();
    document.body.dataset.sgSource = `${lastSourceLabel}:${content === null ? "none" : content.kind}`;
    if (content === null) {
      if (shown !== null) {
        overlay.hide();
        shown = null;
      }
      return;
    }
    const key = content.kind === "llm" ? `llm:${content.text}` : `hist:${content.prefix}|${content.suffix}`;
    if (shown !== null && shown.key === key && overlay.isShowing()) return;
    const attached = overlay.currentTextarea;
    let composer = attached !== null && attached.isConnected ? attached : cachedComposer !== null && cachedComposer.isConnected ? cachedComposer : document.querySelector(COMPOSER_SELECTOR);
    if (composer === null) {
      retryRenderSoon();
      return;
    }
    if (!isComposerElement(composer)) {
      if (shown !== null) {
        overlay.hide();
        shown = null;
      }
      retryRenderSoon();
      return;
    }
    cachedComposer = composer;
    overlay.attach(composer);
    overlay.show(content);
    shown = { key, content };
    composerRetries = 0;
  };
  const pendingOps = /* @__PURE__ */ new Map();
  const writeOps = (payload) => {
    const svc = remoteOf(ctx)?.settings;
    if (svc === void 0) {
      return Promise.resolve(false);
    }
    let envelope;
    try {
      envelope = JSON.parse(payload);
    } catch {
      return Promise.resolve(false);
    }
    const fresh = [];
    for (const raw of Array.isArray(envelope.ops) ? envelope.ops : []) {
      if (typeof raw !== "object" || raw === null) continue;
      const op = raw;
      if (op.op !== "pull" && op.op !== "consume") {
        fresh.push(op);
        continue;
      }
      const id = typeof op.id === "string" && op.id !== "" ? op.id : newOpToken();
      op.id = id;
      pendingOps.set(id, op);
    }
    const ops = [...pendingOps.values(), ...fresh];
    if (ops.length === 0) return Promise.resolve(false);
    envelope.ops = ops;
    const expected = settingsRevision < 0 ? 0 : settingsRevision;
    envelope.nonce = newOpToken();
    const framed = JSON.stringify(envelope);
    return svc.mutate(SETTINGS_NAMESPACE, [{ op: "set", path: ["_ops"], value: framed }], expected).then(() => {
      opsDeliveryFailed = false;
      if (pendingOps.size > 0) scheduleOpsRetry();
      return true;
    }).catch(() => {
      opsDeliveryFailed = true;
      scheduleOpsRetry();
      return false;
    });
  };
  let pullRev = 0;
  let settingsRevision = -1;
  let settingsLoaded = false;
  let modelConfirmed = false;
  let lastPulledSessionId;
  let pendingPull = null;
  let catchUpArmed = true;
  const consumedKeys = /* @__PURE__ */ new Map();
  const CONSUMED_KEYS_CAP = 32;
  const isConsumed = (sessionId, requestKey) => consumedKeys.get(sessionId)?.has(requestKey) === true;
  const markConsumed = (sessionId, requestKey) => {
    const set = consumedKeys.get(sessionId) ?? /* @__PURE__ */ new Set();
    set.add(requestKey);
    while (set.size > CONSUMED_KEYS_CAP) {
      const oldest = set.values().next().value;
      if (oldest === void 0) break;
      set.delete(oldest);
    }
    consumedKeys.set(sessionId, set);
  };
  let hadPush = false;
  let hostEpoch;
  let pullRetryTimer = null;
  let opsRetryTimer = null;
  let opsRetryAttempts = 0;
  let opsDeliveryFailed = false;
  const canRequestPrediction = (sessionId) => {
    if (!settingsLoaded) return false;
    if (!settings.llmEnabled) return false;
    if (composing) return false;
    if (bound === null || lastSessionId !== sessionId) return false;
    if (bound.input.state.getSnapshot().draft !== "") return false;
    if (bound.session.getSnapshot().running) return false;
    return document.visibilityState !== "hidden";
  };
  const sendPull = (pending) => {
    pullRev += 1;
    if (pending.id === null) pending.id = newOpToken();
    const op = {
      op: "pull",
      sessionId: pending.sessionId,
      id: pending.id
    };
    if (pending.requestPrediction) {
      op.requestPrediction = true;
      op.nonce = pending.nonce;
    }
    void writeOps(JSON.stringify({ rev: pullRev, ops: [op] }));
    schedulePullRetry();
  };
  const consumePrediction = (sessionId, requestKey) => {
    pullRev += 1;
    void writeOps(JSON.stringify({
      rev: pullRev,
      ops: [{ op: "consume", sessionId, requestKey, id: newOpToken() }]
    }));
  };
  const resetPredictionState = () => {
    consumedKeys.clear();
    catchUpArmed = true;
    pendingPull = null;
    if (pullRetryTimer !== null) {
      clearTimeout(pullRetryTimer);
      pullRetryTimer = null;
    }
    pendingOps.clear();
    if (opsRetryTimer !== null) {
      clearTimeout(opsRetryTimer);
      opsRetryTimer = null;
    }
    opsRetryAttempts = 0;
    opsDeliveryFailed = false;
  };
  const pullHistory = (sessionId) => {
    const wantPrediction = canRequestPrediction(sessionId);
    if (pendingPull !== null && pendingPull.sessionId === sessionId && (pendingPull.requestPrediction || !wantPrediction)) {
      schedulePullRetry();
      return;
    }
    const token = wantPrediction ? newOpToken() : null;
    pendingPull = {
      sessionId,
      attempts: 0,
      requestPrediction: wantPrediction,
      nonce: token,
      // 操作 id 与预测 nonce 分开：即使这条 pull 不带预测，也要有稳定的 `_ops`
      // 操作 id，host 才能在 `opsAck` 里确认它（见 pendingOps）。
      id: newOpToken()
    };
    sendPull(pendingPull);
  };
  const maybeRequestCatchUp = () => {
    const currentId = lastSessionId;
    if (currentId === void 0) return;
    if (!canRequestPrediction(currentId)) {
      catchUpArmed = true;
      return;
    }
    if (!catchUpArmed) return;
    if (pendingPull !== null && pendingPull.sessionId === currentId) return;
    const existing = predictionFor(currentId);
    if (existing !== null && existing.outcome !== "stale_source" && existing.outcome !== "ineligible") return;
    catchUpArmed = false;
    pullHistory(currentId);
  };
  const retryPendingPull = () => {
    const pending = pendingPull;
    if (pending === null) return;
    if (lastSessionId !== pending.sessionId) {
      pendingPull = null;
      return;
    }
    if (settings.historySessionId === pending.sessionId) {
      pendingPull = null;
      return;
    }
    if (pending.attempts >= PULL_MAX_ATTEMPTS) {
      pendingPull = null;
      return;
    }
    pending.attempts += 1;
    sendPull(pending);
  };
  const schedulePullRetry = () => {
    if (pendingPull === null || pullRetryTimer !== null) return;
    const delay = PULL_RETRY_BASE_MS * 2 ** pendingPull.attempts;
    pullRetryTimer = setTimeout(() => {
      pullRetryTimer = null;
      retryPendingPull();
    }, delay);
  };
  const retryPendingOps = () => {
    if (pendingOps.size === 0) return;
    void writeOps(JSON.stringify({ rev: pullRev += 1, ops: [] }));
  };
  const scheduleOpsRetry = () => {
    if (pendingOps.size === 0 || opsRetryTimer !== null) return;
    const delay = opsRetryAttempts >= OPS_MAX_ATTEMPTS ? OPS_RETRY_IDLE_MS : Math.min(OPS_RETRY_BASE_MS * 2 ** opsRetryAttempts, OPS_RETRY_MAX_MS);
    opsRetryAttempts += 1;
    opsRetryTimer = setTimeout(() => {
      opsRetryTimer = null;
      retryPendingOps();
    }, delay);
  };
  const remote = remoteOf(ctx);
  if (remote?.settings !== void 0) {
    let describeInFlight = false;
    let describePending = false;
    let describePendingLive = false;
    let settingsDisposed = false;
    let lastRawPush = null;
    const applySettings = (live) => {
      if (settingsDisposed) return;
      if (describeInFlight) {
        describePending = true;
        if (live) describePendingLive = true;
        return;
      }
      describeInFlight = true;
      void (async () => {
        try {
          const described = await remote.settings.describe();
          if (settingsDisposed) return;
          const list = unwrapSettingsDoc(described)?.namespaces ?? [];
          const entry = list.find((row) => row.ns === SETTINGS_NAMESPACE);
          if (entry === void 0) return;
          const v = entry.value ?? {};
          const rawPush = typeof v._push === "string" && v._push !== "" ? v._push : null;
          const pushChanged = rawPush !== lastRawPush;
          const rev = typeof entry.revision === "number" ? entry.revision : 0;
          if (rev === settingsRevision && !pushChanged) return;
          const revisionAdvanced = rev !== settingsRevision;
          settingsRevision = rev;
          lastRawPush = rawPush;
          if (revisionAdvanced && pendingOps.size > 0 && opsDeliveryFailed) {
            opsRetryAttempts = 0;
            retryPendingOps();
          }
          let pushed = null;
          if (rawPush !== null) {
            try {
              pushed = JSON.parse(rawPush);
            } catch {
              pushed = null;
            }
          }
          settings = {
            historyEnabled: typeof v.historyEnabled === "boolean" ? v.historyEnabled : true,
            historyCrossSession: typeof v.historyCrossSession === "boolean" ? v.historyCrossSession : false,
            historyMaxEntries: typeof v.historyMaxEntries === "number" ? v.historyMaxEntries : 50,
            historyMinChars: typeof v.historyMinChars === "number" ? v.historyMinChars : 1,
            wordAccept: typeof v.wordAccept === "boolean" ? v.wordAccept : true,
            // 预测开关（协议 v2 的 live 值；缺字段 = 旧宿主，默认开启，与 host 默认一致）。
            llmEnabled: typeof v.llmEnabled === "boolean" ? v.llmEnabled : true,
            // 缺 `protocol` 的载荷 = 旧宿主，按 v1 处理：不启用 prediction 显示门槛，
            // 免得把旧宿主仍然有效的建议整条挡掉（见 ghostContent 的模式 2）。
            protocol: typeof pushed?.protocol === "number" ? pushed.protocol : 1,
            // 预测记录：null 既是「载荷没带」也是「host 明说本会话无记录」，两者
            // 在本会话的判定上同义（无记录 → 不出幽灵），故不做区分。
            prediction: parsePrediction(pushed?.prediction),
            route: parseRoute(pushed?.route),
            nonce: typeof pushed?.nonce === "string" ? pushed.nonce : null,
            suggestion: pushed?.suggestion === null || pushed?.suggestion === void 0 ? null : pushed.suggestion,
            hot: pushed?.hot === null || pushed?.hot === void 0 ? null : pushed.hot,
            // history 省略 = host 本次推送不携带历史（保留现值）。启动对账推送正是
            // 这种形态：它只负责恢复建议，历史留给紧随其后的 pull 应答，此时若把
            // 本地历史清成 [] 会把「切回会话仍有历史」的体验一起清掉。
            history: Array.isArray(pushed?.history) ? (pushed?.history).filter((t) => typeof t === "string") : settings.history,
            historySessionId: Array.isArray(pushed?.history) ? typeof pushed?.historySessionId === "string" ? pushed.historySessionId : null : settings.historySessionId,
            suggestionSessionId: typeof pushed?.suggestionSessionId === "string" ? pushed.suggestionSessionId : null
          };
          settingsLoaded = true;
          const pushedRecapsSessionId = typeof pushed?.recapsSessionId === "string" ? pushed.recapsSessionId : null;
          if (pushedRecapsSessionId !== null) applyRecaps(pushedRecapsSessionId, pushed?.recaps);
          const nonceMatched = pendingPull !== null && pendingPull.nonce !== null && (settings.nonce === pendingPull.nonce || settings.prediction !== null && settings.prediction.nonce === pendingPull.nonce);
          const epoch = typeof pushed?.epoch === "string" ? pushed.epoch : void 0;
          const hostChanged = epoch !== void 0 && hostEpoch !== void 0 && epoch !== hostEpoch || pushed === null && hadPush;
          if (epoch !== void 0) hostEpoch = epoch;
          hadPush = pushed !== null;
          if (hostChanged) {
            perSession.clear();
            resetPredictionState();
            clearRecaps();
            lastPulledSessionId = void 0;
            modelConfirmed = false;
            if (lastSessionId !== void 0) pullHistory(lastSessionId);
          }
          if (nonceMatched || live && pushChanged) modelConfirmed = true;
          const acked = /* @__PURE__ */ new Set();
          if (Array.isArray(pushed?.opsAck)) {
            for (const id of pushed.opsAck) if (typeof id === "string" && id !== "") acked.add(id);
          }
          if (nonceMatched) {
            if (pendingPull !== null && pendingPull.id !== null) acked.add(pendingPull.id);
            pendingPull = null;
            if (pullRetryTimer !== null) {
              clearTimeout(pullRetryTimer);
              pullRetryTimer = null;
            }
          }
          if (settings.prediction !== null && settings.prediction.outcome === "consumed") {
            for (const [id, op] of pendingOps) {
              if (op.op === "consume" && op.requestKey === settings.prediction.requestKey) acked.add(id);
            }
          }
          for (const id of acked) pendingOps.delete(id);
          if (settings.suggestionSessionId !== null) {
            cachePut(settings.suggestionSessionId, settings.suggestion);
          }
          if (modelConfirmed && settings.prediction !== null) {
            cachePut(settings.prediction.sessionId, void 0, void 0, settings.prediction, settings.route);
          }
          if (Array.isArray(pushed?.history) && settings.historySessionId !== null) {
            const sid = settings.historySessionId;
            const prediction = modelConfirmed ? settings.prediction !== null && settings.prediction.sessionId === sid ? settings.prediction : null : void 0;
            cachePut(
              sid,
              settings.suggestionSessionId === sid ? settings.suggestion : null,
              settings.history,
              prediction,
              settings.route
            );
          }
          render();
        } catch {
        } finally {
          describeInFlight = false;
          const again = describePending && !settingsDisposed;
          const againLive = describePendingLive;
          describePending = false;
          describePendingLive = false;
          if (again) applySettings(againLive);
        }
      })();
    };
    const offUpdated = remote.$on?.("settings/document-updated", () => applySettings(true));
    const offReset = ctx.on("connection/reset", () => {
      modelConfirmed = false;
      perSession.clear();
      resetPredictionState();
      clearRecaps();
      lastPulledSessionId = void 0;
      render();
      if (lastSessionId !== void 0) pullHistory(lastSessionId);
      applySettings(false);
    });
    ctx.effect(() => () => {
      settingsDisposed = true;
      describePending = false;
      offUpdated?.();
      offReset();
    });
    applySettings(false);
  }
  const onKeyDown = (event) => {
    if (event.isComposing) return;
    if (shown === null) return;
    const focused = document.activeElement;
    if (!(focused instanceof HTMLTextAreaElement) && !(focused instanceof HTMLElement && focused.isContentEditable)) return;
    if (!isComposerTarget(focused)) return;
    const content = shown.content;
    const llmPlainAccept = content.kind === "llm" && isPlainLlmAcceptKey(event);
    const acceptKey = content.kind === "llm" ? content.acceptKey : DEFAULT_ACCEPT_KEY;
    const matcher = parseAcceptKey(acceptKey);
    if (llmPlainAccept || matcher !== void 0 && matcher(event)) {
      if (content.kind === "llm") {
        if (!isPlainLlmAcceptKey(event)) return;
        if (event.isComposing || event.keyCode === 229) return;
        if (shown === null || shown.content !== content || !overlay.isShowing()) return;
        if (bound === null || lastSessionId === void 0) return;
        const currentId = lastSessionId;
        if (bound.input.state.getSnapshot().draft !== "") return;
        let requestKey = null;
        if (settings.protocol >= 2) {
          const prediction = predictionFor(currentId);
          if (prediction === null || prediction.sessionId !== currentId || prediction.outcome !== "suggested" || isConsumed(currentId, prediction.requestKey)) return;
          requestKey = prediction.requestKey;
        }
        event.preventDefault();
        event.stopPropagation();
        bound.input.setDraft(content.text);
        if (requestKey !== null) {
          markConsumed(currentId, requestKey);
          consumePrediction(currentId, requestKey);
        }
        overlay.hide();
        shown = null;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (bound !== null) {
        const draftNow = bound.input.state.getSnapshot().draft;
        const contentDraft = stripCommandPrefix(draftNow);
        const head = contentDraft === "" ? draftNow : draftNow.slice(0, draftNow.length - contentDraft.length);
        const tailJoiner = head.endsWith(" ") || head === "" ? "" : " ";
        bound.input.setDraft(`${head}${tailJoiner}${content.full}`);
      }
      overlay.hide();
      shown = null;
      return;
    }
    if (content.kind !== "history") return;
    if (settings.wordAccept && event.code === "ArrowRight" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const ta = focused;
      const draftNow = bound !== null ? bound.input.state.getSnapshot().draft : "";
      const full = content.full;
      if (!caretAtComposerEnd(ta)) return;
      const matchBase = stripCommandPrefix(draftNow);
      if (!full.startsWith(matchBase) || matchBase.length >= full.length) return;
      const chunk = nextAcceptChunk(full.slice(matchBase.length));
      if (chunk === "") return;
      event.preventDefault();
      event.stopPropagation();
      let accepted;
      if (content.kind === "history") {
        const head = matchBase === "" ? draftNow : draftNow.slice(0, draftNow.length - matchBase.length);
        const tailJoiner = head.endsWith(" ") || head === "" ? "" : " ";
        accepted = `${head}${tailJoiner}${matchBase}${chunk}`;
      } else {
        accepted = draftNow + chunk;
      }
      if (bound !== null) bound.input.setDraft(accepted);
      if (accepted === full || content.kind === "history" && accepted.endsWith(full)) {
        overlay.hide();
        shown = null;
      }
    }
  };
  ctx.effect(() => {
    let unsubs = [];
    let deferredRenders = [];
    const scheduleDeferredRenders = () => {
      for (const t of deferredRenders) clearTimeout(t);
      deferredRenders = [60, 300, 900].map((ms) => setTimeout(render, ms));
    };
    const rebind = () => {
      for (const un of unsubs) un();
      unsubs = [];
      resolve();
      if (bound !== null) {
        unsubs.push(
          bound.session.subscribe(render),
          bound.input.state.subscribe(render),
          bound.projectionFace.subscribe(render)
        );
      }
      scheduleDeferredRenders();
    };
    rebind();
    render();
    const onList = () => {
      const id = currentSessionIdOf(sessions.list.getSnapshot());
      if (id !== lastSessionId) rebind();
      render();
    };
    const unList = sessions.list.subscribe(onList);
    const onCompositionStart = () => {
      composing = true;
      render();
    };
    const onCompositionEnd = () => {
      composing = false;
      render();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("compositionstart", onCompositionStart, true);
    window.addEventListener("compositionend", onCompositionEnd, true);
    return () => {
      unList();
      for (const un of unsubs) un();
      for (const t of deferredRenders) clearTimeout(t);
      if (composerRetryTimer !== null) clearTimeout(composerRetryTimer);
      composerRetryTimer = null;
      if (pullRetryTimer !== null) clearTimeout(pullRetryTimer);
      pullRetryTimer = null;
      if (opsRetryTimer !== null) clearTimeout(opsRetryTimer);
      opsRetryTimer = null;
      pendingPull = null;
      consumedKeys.clear();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("compositionstart", onCompositionStart, true);
      window.removeEventListener("compositionend", onCompositionEnd, true);
      overlay.dispose();
    };
  }, "dsh-foresight: composer ghost render");
  const locale = ctx.get("locale");
  const ENTRY_ID = "dsh-foresight";
  if (ctx.slots !== void 0) {
    ctx.inject(["configForms"], () => {
      const forms = ctx.get("configForms");
      if (forms === void 0 || typeof forms.get !== "function" || typeof forms.whileServed !== "function") return;
      const formScope = forms.get(ENTRY_ID);
      ctx.effect(
        () => forms.whileServed(
          [ENTRY_ID],
          () => ctx.slots.inject(
            "plugins.bundle.config",
            () => ctx.slots.register({
              name: "plugins.bundle.config",
              key: "dsh-foresight",
              locale: "dsh-foresight",
              inject: () => ({ scope: formScope, locale, surface: "detail" })
            }, SuggestGhostCard)
          )
        ),
        "dsh-foresight: plugins-page card"
      );
    });
  }
  if (ctx.slots !== void 0) {
    const disposeRecapTail = ctx.slots.inject(
      "conversation.chat.turnTail",
      () => ctx.slots.register({
        name: "conversation.chat.turnTail",
        id: "dsh-foresight-recap",
        order: 10
      }, RecapLine)
    );
    if (typeof disposeRecapTail === "function") {
      ctx.effect(() => () => {
        try {
          disposeRecapTail();
        } catch {
        }
      });
    }
  }
  const remoteForCard = remoteOf(ctx);
  if (ctx.slots === void 0 || remoteForCard?.settings === void 0) return;
  const SHOW_SETTINGS_KEY = "dsh-foresight:show-settings-section";
  const showSettingsSection = typeof localStorage !== "undefined" && localStorage.getItem(SHOW_SETTINGS_KEY) === "true";
  if (!showSettingsSection) return;
  const cardScope = remoteSettingsScope(remoteForCard, SETTINGS_NAMESPACE);
  const disposeSection = ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    // 自有 id：用宿主没有的 id 才会「并排新增一页」，复用宿主 id 会顶掉那一页。
    id: SETTINGS_SECTION_ID,
    order: 40,
    label: () => sectionLabel(locale),
    // 卡片只依赖 scope 的 get/subscribe/set 三个成员（见 settings-card.tsx 的
    // PluginSettingsScope），这里用 remote.settings 适配出同形状的最小面：
    // 0.1.7 已无 settingsScope 服务，而卡片逻辑（读快照 / 订阅变更 / 写字段）
    // 与代次无关，不必改卡片本体。
    inject: () => ({ scope: cardScope, locale, surface: "settings" })
  }, SuggestGhostCard));
  if (typeof disposeSection === "function") {
    ctx.effect(() => () => {
      disposeSection();
      cardScope.dispose();
    });
  }
}
function remoteSettingsScope(remote, ns) {
  let snapshot = { status: "loading", value: {}, writable: false };
  let revision = -1;
  const listeners2 = [];
  let disposed = false;
  const notify2 = () => {
    for (const listener of [...listeners2]) {
      try {
        listener();
      } catch {
      }
    }
  };
  const readValue = () => {
    void (async () => {
      if (disposed) return;
      try {
        const described = await remote.settings?.describe();
        const doc = unwrapSettingsDoc(described);
        const entry = (doc?.namespaces ?? []).find((row) => row.ns === ns);
        if (entry === void 0) return;
        const rev = typeof entry.revision === "number" ? entry.revision : 0;
        if (rev === revision) return;
        revision = rev;
        snapshot = {
          status: "ready",
          value: entry.value ?? {},
          // `writable` 是 describe() 的**外层**字段（整个设置文档可否写），
          // 不是命名空间条目的字段。缺省视为可写（旧宿主不带该字段）。
          writable: doc?.writable !== false
        };
        notify2();
      } catch {
      }
    })();
  };
  readValue();
  const offUpdated = remote.$on?.("settings/document-updated", () => readValue());
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners2.push(listener);
      return () => {
        const i = listeners2.indexOf(listener);
        if (i >= 0) listeners2.splice(i, 1);
      };
    },
    set: (key, next) => {
      const svc = remote.settings;
      if (svc === void 0) return Promise.resolve();
      const expected = revision < 0 ? 0 : revision;
      return svc.mutate(ns, [{ op: "set", path: [key], value: next }], expected).then(() => {
        readValue();
      }).catch(() => {
      });
    },
    dispose: () => {
      disposed = true;
      offUpdated?.();
      listeners2.length = 0;
    }
  };
}
function apply(ctx) {
  applyInner(ctx);
}

// src/client/recall/register.ts
var import_react5 = require("react");

// src/client/recall/Overlay.tsx
var import_react4 = require("react");

// src/client/recall/recall.ts
var HISTORY_LIMIT = 200;
function extractHistory2(nodes) {
  const out = [];
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    const kind = node.kind;
    if (kind !== "user" && kind !== "steering") continue;
    const message = node;
    if (!Array.isArray(message.content)) continue;
    let text = "";
    for (const block of message.content) {
      if (typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string") {
        text += block.text;
      }
    }
    text = text.trim();
    if (text === "") continue;
    if (out.length > 0 && out[out.length - 1] === text) continue;
    out.push(text);
  }
  return out.length > HISTORY_LIMIT ? out.slice(-HISTORY_LIMIT) : out;
}
function step(key, nav, history, draft) {
  if (nav.index !== null && nav.index >= history.length) {
    nav.index = null;
    nav.backup = "";
  }
  if (key === "ArrowUp") {
    if (nav.index === null) {
      if (draft.trim() !== "" || history.length === 0) return { handled: false };
      nav.index = history.length - 1;
      nav.backup = draft;
      const entry2 = history[nav.index];
      return entry2 === void 0 ? { handled: false } : { handled: true, next: entry2 };
    }
    if (nav.index === 0) return { handled: true };
    nav.index -= 1;
    const entry = history[nav.index];
    return entry === void 0 ? { handled: false } : { handled: true, next: entry };
  }
  if (nav.index === null) return { handled: false };
  const last = history.length - 1;
  if (nav.index < last) {
    nav.index += 1;
    const entry = history[nav.index];
    return entry === void 0 ? { handled: false } : { handled: true, next: entry };
  }
  const restored = nav.backup;
  nav.index = null;
  nav.backup = "";
  return { handled: true, next: restored };
}
function atEarliest(nav, historyLength) {
  if (nav.index === null) return historyLength === 0;
  return nav.index === 0;
}
function rebaseCursor(previousIndex, previousLength, nextLength) {
  if (previousIndex < 0 || previousLength < 0) return null;
  const shift = nextLength - previousLength;
  if (shift <= 0) return null;
  const next = previousIndex + shift - 1;
  if (next < 0) return 0;
  return next > nextLength - 1 ? nextLength - 1 : next;
}

// src/client/recall/keyGate.ts
function gateKey(stroke, env) {
  if (stroke.key !== "ArrowUp" && stroke.key !== "ArrowDown") return { takeOver: false, reason: "not-arrow" };
  if (stroke.ctrlKey || stroke.metaKey || stroke.altKey || stroke.shiftKey) return { takeOver: false, reason: "modifier" };
  if (stroke.isComposing || stroke.keyCode === 229) return { takeOver: false, reason: "composing" };
  if (!env.editable) return { takeOver: false, reason: "not-editable" };
  if (!env.inComposerScope) return { takeOver: false, reason: "out-of-scope" };
  if (!env.hasInputActions) return { takeOver: false, reason: "no-input-actions" };
  if (env.phase !== "plain") return { takeOver: false, reason: "phase" };
  return { takeOver: true, reason: "ok" };
}

// src/client/recall/Overlay.tsx
var import_jsx_runtime3 = require("react/jsx-runtime");
var COMPOSER_CARD_ATTR = "data-composer-card";
var FALLBACK_SCOPE_DEPTH = 6;
var warnedMissingCard = false;
function composerScope(anchor) {
  const card = anchor.closest(`[${COMPOSER_CARD_ATTR}]`);
  if (card instanceof HTMLElement) return card;
  if (!warnedMissingCard) {
    warnedMissingCard = true;
    console.warn(
      `[dsh-foresight] \u5BBF\u4E3B\u8F93\u5165\u6846\u5361\u7247\u4E0A\u627E\u4E0D\u5230 [${COMPOSER_CARD_ATTR}]\uFF0C\u53EC\u56DE\u5DF2\u964D\u7EA7\u4E3A\u300C\u951A\u70B9\u7956\u5148\u8303\u56F4\u5185\u63A5\u7BA1\u300D\u3002\u8BF7\u66F4\u65B0 scripts/probe-host.mjs \u7684 DOM \u5951\u7EA6\u6E05\u5355\uFF0C\u5E76\u628A\u65B0\u5C5E\u6027\u8865\u8FDB src/client/recall/Overlay.tsx\u3002`
    );
  }
  let el = anchor.parentElement;
  for (let depth = 0; depth < FALLBACK_SCOPE_DEPTH && el !== null; depth += 1) {
    if (el === document.body || el === document.documentElement) break;
    if (el.querySelector('[contenteditable]:not([contenteditable="false"])') !== null) return el;
    el = el.parentElement;
  }
  return null;
}
var pillStyle = {
  position: "absolute",
  top: 6,
  right: 12,
  zIndex: 6,
  pointerEvents: "none",
  userSelect: "none",
  whiteSpace: "nowrap",
  fontSize: 12,
  lineHeight: "16px",
  padding: "2px 8px",
  borderRadius: 999,
  background: "var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.18))",
  color: "var(--dsw-alias-label-secondary, inherit)"
};
function useArrowKeys(anchor, latest, nav, bump, requestOlder) {
  (0, import_react4.useEffect)(() => {
    function onKeyDown(event) {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const node = anchor.current;
      if (node === null) return;
      const target = event.target;
      const scope = composerScope(node);
      const verdict = gateKey(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          isComposing: event.isComposing,
          keyCode: event.keyCode
        },
        {
          editable: target instanceof HTMLElement && target.isContentEditable,
          inComposerScope: scope !== null && target instanceof Node && scope.contains(target),
          phase: latest.current.phase,
          hasInputActions: latest.current.inputActions !== void 0
        }
      );
      if (!verdict.takeOver) return;
      const { history, draft, inputActions } = latest.current;
      if (inputActions === void 0 || latest.current.phase !== "plain") return;
      if (event.key === "ArrowUp" && history.length > 0 && atEarliest(nav.current, history.length)) {
        requestOlder();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const result = step(event.key, nav.current, history, draft);
      if (!result.handled) return;
      if (result.next !== void 0) {
        nav.current.selfWrite = true;
        inputActions.setDraft(result.next);
      }
      event.preventDefault();
      event.stopPropagation();
      bump();
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [anchor, latest, nav, bump, requestOlder]);
}
var EMPTY_PAGE_LIMIT = 3;
function RecallOverlay(props) {
  const { useChat, useInput, inputActions, loadOlder, sessionId } = props;
  const nodes = useChat?.((snapshot) => snapshot.legacy.nodes);
  const phase = useInput?.((snapshot) => snapshot.phase);
  const draft = useInput?.((snapshot) => snapshot.draft);
  const history = (0, import_react4.useMemo)(() => nodes === void 0 ? [] : extractHistory2(nodes), [nodes]);
  const anchor = (0, import_react4.useRef)(null);
  const nav = (0, import_react4.useRef)({ index: null, backup: "", selfWrite: false });
  const [, setTick] = (0, import_react4.useState)(0);
  const bump = (0, import_react4.useCallback)(() => setTick((tick) => tick + 1), []);
  const latest = (0, import_react4.useRef)({ history, phase, draft: draft ?? "", inputActions, loadOlder });
  (0, import_react4.useLayoutEffect)(() => {
    latest.current = { history, phase, draft: draft ?? "", inputActions, loadOlder };
  });
  const exitBrowse = (0, import_react4.useCallback)(() => {
    if (nav.current.index === null) return;
    nav.current.index = null;
    nav.current.backup = "";
    bump();
  }, [bump]);
  const paging = (0, import_react4.useRef)({
    loading: false,
    exhausted: false,
    pending: null,
    emptyPages: 0,
    lastLength: 0,
    timer: void 0
  });
  const requestOlder = (0, import_react4.useCallback)(() => {
    const state = paging.current;
    if (state.loading || state.pending !== null || state.exhausted) return;
    const load = latest.current.loadOlder;
    if (load === void 0) return;
    state.loading = true;
    state.pending = { index: nav.current.index ?? 0, length: latest.current.history.length };
    bump();
    void load(sessionId ?? "").catch(() => false).then((started) => {
      if (!started) {
        state.pending = null;
        state.loading = false;
        state.exhausted = true;
        bump();
        return;
      }
      state.timer = setTimeout(() => {
        if (state.pending === null) return;
        state.pending = null;
        state.loading = false;
        state.emptyPages += 1;
        if (state.emptyPages >= EMPTY_PAGE_LIMIT) state.exhausted = true;
        bump();
      }, 2e3);
    });
  }, [bump, sessionId]);
  (0, import_react4.useEffect)(() => {
    const state = paging.current;
    if (state.pending !== null && state.pending.length !== history.length) {
      const rebased = rebaseCursor(state.pending.index, state.pending.length, history.length);
      if (state.timer !== void 0) {
        clearTimeout(state.timer);
        state.timer = void 0;
      }
      state.pending = null;
      state.loading = false;
      state.emptyPages = 0;
      const entry = rebased === null ? void 0 : history[rebased];
      if (rebased === null || entry === void 0) {
        state.exhausted = true;
      } else {
        nav.current.index = rebased;
        nav.current.selfWrite = true;
        inputActions?.setDraft(entry);
      }
      bump();
    }
    if (history.length > state.lastLength) state.exhausted = false;
    state.lastLength = history.length;
  }, [history, inputActions, bump]);
  (0, import_react4.useEffect)(() => {
    exitBrowse();
    const state = paging.current;
    if (state.timer !== void 0) clearTimeout(state.timer);
    paging.current = { loading: false, exhausted: false, pending: null, emptyPages: 0, lastLength: 0, timer: void 0 };
  }, [sessionId, exitBrowse]);
  (0, import_react4.useEffect)(
    () => () => {
      const timer = paging.current.timer;
      if (timer !== void 0) clearTimeout(timer);
    },
    []
  );
  (0, import_react4.useEffect)(() => {
    if (nav.current.selfWrite) {
      nav.current.selfWrite = false;
      return;
    }
    exitBrowse();
  }, [draft, exitBrowse]);
  (0, import_react4.useEffect)(() => {
    if (phase !== void 0 && phase !== "plain") exitBrowse();
  }, [phase, exitBrowse]);
  useArrowKeys(anchor, latest, nav, bump, requestOlder);
  const index = nav.current.index;
  const loading = paging.current.loading;
  const label = index === null ? loading ? "\u2191\u2193 \u2026" : null : `\u2191\u2193 ${index + 1}/${history.length}${loading ? " \u2026" : ""}`;
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { ref: anchor, children: label === null ? null : /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: pillStyle, children: label }) });
}

// src/client/recall/register.ts
var RECALL_ENTRY_ID = "foresight-recall";
var OVERLAY_SLOT = "conversation.input.overlay";
function registerRecall(slots, effect, getLoadOlder = () => void 0) {
  effect(
    () => slots.inject(
      OVERLAY_SLOT,
      () => slots.register(
        { name: OVERLAY_SLOT, id: RECALL_ENTRY_ID, order: 80 },
        (props) => (
          // 每次渲染重新取：服务可能晚于注册才就绪（`ctx.inject` 回调是异步的）。
          (0, import_react5.createElement)(RecallOverlay, { ...props, loadOlder: getLoadOlder() })
        )
      )
    ),
    "foresight: recall overlay"
  );
}

// src/client/recall/index.ts
var inject2 = ["slots", "sessions"];
function createLoadOlderProvider(ctx) {
  return () => {
    const sessions = ctx.get?.("sessions");
    if (sessions?.scope === void 0) return void 0;
    return async (sessionId) => {
      const scoped = sessions.scope?.(sessionId);
      const conversation = scoped?.get?.("conversation");
      if (conversation?.loadOlder === void 0) return false;
      await conversation.loadOlder();
      return true;
    };
  };
}
function applyRecall(ctx) {
  const effect = (callback, label) => ctx.effect(callback, label);
  registerRecall(ctx.slots, effect, createLoadOlderProvider(ctx));
}

// src/client/main.ts
var name = "dsh-foresight";
var inject3 = [.../* @__PURE__ */ new Set([...inject, ...inject2])];
function warnOf(ctx) {
  const logger = ctx.logger;
  return (message) => {
    try {
      logger?.warn?.(message);
    } catch {
    }
  };
}
function apply2(ctx) {
  const warn = warnOf(ctx);
  try {
    apply(ctx);
  } catch (error) {
    warn(`dsh-foresight: prediction failed to mount: ${String(error)}`);
  }
  try {
    applyRecall(ctx);
  } catch (error) {
    warn(`dsh-foresight: recall failed to mount: ${String(error)}`);
  }
}

		return module.exports;
	}
});
