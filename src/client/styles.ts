/**
 * SuggestGhost 设置卡片样式（裸表单 + section 分组布局）。
 *
 * 视觉对齐官方 SettingsForm（dsh-client-ui-primitives）：无卡片容器，
 * 字段按 section 分组，每组有标题，底部保存按钮。fsr- 前缀防冲突。
 *
 * 关键值从 dsh-later/styles.ts 复制（官方风格参考实现）。
 */

export const STYLE_ID = 'dsh-foresight-card-css';

const COMPONENTS = [
  /* ==================== 表单根 ==================== */
  /* 裸表单，无卡片容器（对齐官方 SettingsForm） */
  '.fsr-settings-form{display:flex;flex-direction:column}',

  /* ==================== Section 分组 ==================== */
  '.fsr-section{padding:16px 0}',
  '.fsr-section-heading{margin:0;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}',
  '.fsr-section-fields{display:flex;flex-direction:column}',
  /* 两列并排网格（对齐 dsh-later 的 grid 布局） */
  '.fsr-section-fieldsGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}',

  /* ==================== 字段 ==================== */
  '.fsr-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
  '.fsr-fieldHead{display:flex;align-items:center;gap:8px}',
  '.fsr-label-group{display:flex;align-items:center;gap:4px;flex:1;min-width:0}',
  '.fsr-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}',

  /* ==================== 输入框 ==================== */
  '.fsr-input{box-sizing:border-box;width:100%;min-height:36px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}',
  '.fsr-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
  '.fsr-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
  '.fsr-inputInvalid{border-color:var(--dsw-alias-state-error-primary)}',
  '.fsr-inputReadOnly{opacity:.6;cursor:not-allowed}',

  /* ==================== 快捷键按钮 ==================== */
  '.fsr-key{box-sizing:border-box;width:100%;appearance:none;font:inherit;text-align:left;cursor:pointer;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);min-height:36px;color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-md,8px);padding:0 12px;font-size:13px;line-height:1.5}',
  '.fsr-key:focus-visible{border-color:var(--dsw-alias-state-business-primary);outline:none}',
  '.fsr-key:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
  '.fsr-keyCapturing,.fsr-keyCapturing:focus-visible{border-color:var(--dsw-alias-brand-primary)}',

  /* ==================== 帮助按钮 ==================== */
  '.fsr-help-btn{width:24px;height:24px;padding:0;flex:none;display:inline-flex;align-items:center;justify-content:center;background:none;border:none;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-tertiary)}',
  '.fsr-help-btn:hover,.fsr-help-btnOpen{color:var(--dsw-alias-label-secondary)}',
  '.fsr-help-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}',

  /* ==================== 帮助展开区 ==================== */
  '.fsr-help{margin:0;padding:10px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
  '.fsr-help p{margin:0}',

  /* ==================== Toggle 行（布尔字段） ==================== */
  '.fsr-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:16px}',
  '.fsr-toggle-label{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
  '.fsr-toggle-switch{position:relative;width:36px;height:20px;flex:none;background:var(--dsw-alias-bg-module-platform);border-radius:999px;cursor:pointer;transition:background var(--ds-transition-duration-fast) var(--ds-ease-in-out);border:none;padding:0}',
  '.fsr-toggle-switch[aria-checked="true"]{background:var(--dsw-alias-state-business-primary)}',
  '.fsr-toggle-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:#fff;transition:transform var(--ds-transition-duration-fast) var(--ds-ease-in-out)}',
  '.fsr-toggle-switch[aria-checked="true"]::after{transform:translateX(16px)}',
  '.fsr-toggle-switch:disabled{opacity:0.4;cursor:default}',
  '.fsr-toggle-switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
  '.fsr-toggle-description{margin:0;padding:0 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',

  /* ==================== 只读/策略字段提示 ==================== */
  '.fsr-configOnly{color:var(--dsw-alias-label-tertiary);margin:2px 0 0;font-size:11px;line-height:1.4}',
  '.fsr-invalid{color:var(--dsw-alias-state-error-primary);margin:0;font-size:12px;line-height:1.5}',
  '.fsr-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
  '.fsr-readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}',

  /* ==================== 预测路由与状态（诊断行） ==================== */
  /* 键值网格：键列宽度随内容，值列换行不撑破容器（沿用表单同一套 token/字号） */
  '.fsr-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 12px;margin:8px 0 0;font-size:12px;line-height:1.6}',
  '.fsr-kvKey{color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
  '.fsr-kvVal{color:var(--dsw-alias-label-primary);min-width:0;overflow-wrap:anywhere}',
  /* 诊断说明：多条 12px 灰字，等距堆叠（与 .fsr-hint 同色号，仅补间距） */
  '.fsr-predNotes{display:flex;flex-direction:column;gap:4px;margin:8px 0 0}',

  /* ==================== 底部操作栏 ==================== */
  '.fsr-footer{justify-content:flex-end;align-items:center;gap:8px;padding-top:16px;display:flex}',
  '.fsr-status{flex:1;min-width:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:1.5}',
  '.fsr-discard,.fsr-save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:var(--dsw-radius-md,8px);padding:5px 14px;font-size:13px;line-height:1.5}',
  '.fsr-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:none}',
  '.fsr-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
  '.fsr-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
  '.fsr-save:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
  '.fsr-save:disabled,.fsr-discard:disabled{opacity:.4;cursor:default}',
  '.fsr-save:focus-visible,.fsr-discard:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',

  /* ==================== 热度管理分组 ==================== */
  /* 折叠式 section 标题按钮：外观对齐 .fsr-section-heading（13px/600/primary），可点击展开 */
  '.fsr-sectionBtn{appearance:none;width:100%;font:inherit;background:none;border:0;text-align:left;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.5;padding:0}',
  '.fsr-sectionBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}',
  '.fsr-sectionBtnText{min-width:0}',
  '.fsr-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}',
  '.fsr-chevronOpen{transform:rotate(180deg)}',
  '.fsr-hotList{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;max-height:320px;overflow-y:auto}',
  '.fsr-hotRow{display:flex;align-items:center;gap:8px;padding:6px 10px;min-width:0}',
  '.fsr-hotRow+.fsr-hotRow{border-top:1px solid var(--dsw-alias-border-l2)}',
  '.fsr-hotRow:hover{background:var(--dsw-alias-bg-layer-2)}',
  '.fsr-hotPinFlag{flex:none;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 7px;font-size:11px;font-weight:500;line-height:16px;white-space:nowrap}',
  '.fsr-hotText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
  '.fsr-hotCount{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums}',
  '.fsr-hotBtn{flex:none;appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:none;border-radius:6px;padding:2px 8px;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary)}',
  '.fsr-hotBtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
  '.fsr-hotBtn:disabled{opacity:.4;cursor:default}',
  '.fsr-hotBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
  '.fsr-hotBtnDanger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
  '.fsr-hotAdd{display:flex;gap:8px;margin-top:8px}',
  '.fsr-hotAdd .fsr-input{flex:1;min-width:0;min-height:30px;height:30px;font-size:12px}',
  '.fsr-hotMeta{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:8px 0 0}',
  '.fsr-hotDanger{color:var(--dsw-alias-state-error-primary)}',

  /* ==================== 回合回顾（turnTail 条目） ==================== */
  /* 回复末尾的一行 dim/italic 回顾：鲸鱼图标 + 全角冒号 + 正文（用户要求只去掉「回顾」两个字） */
  /* ——不抢正文注意力，但一眼能看出「这一轮做了什么」。 */
  '.fsr-recap{display:flex;align-items:baseline;gap:6px;margin:2px 0 0;min-width:0;font-size:12px;line-height:1.6}',
  '.fsr-recap-mark{flex:none;font-size:13px;line-height:1.2}',
  '.fsr-recap-text{min-width:0;color:var(--dsw-alias-label-tertiary);font-style:italic;overflow-wrap:anywhere}',
].join('\n');

/** 幂等样式注入（与 dsh-later 的 injectStyles 同一模式）。 */
export function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) {
    return () => undefined;
  }
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-foresight';
  tag.dataset.pluginCss = STYLE_ID;
  tag.textContent = COMPONENTS;
  document.head.appendChild(tag);
  return () => {
    tag.remove();
  };
}
