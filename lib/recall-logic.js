// src/client/recall/recall.ts
var HISTORY_LIMIT = 200;
function extractHistory(nodes) {
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
export {
  HISTORY_LIMIT,
  atEarliest,
  extractHistory,
  gateKey,
  rebaseCursor,
  step
};
