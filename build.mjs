/**
 * 构建脚本：
 *  1. tsc 编译宿主半区（src/ → lib/，tsconfig.json 排除 src/client）
 *  2. esbuild 打包浏览器端单文件，包进 __ModuleLoader__.load 模板（入口 src/client/main.ts）
 *  3. esbuild 单独打一份召回的纯逻辑（lib/recall-logic.js），给 `node --test` 用
 *  4. 构建后检查：握手、浏览器产物里没有框架包的值导入、功能面标记都在
 * 产物：lib/index.js（host）+ lib/client.js（浏览器端）+ lib/recall-logic.js（测试用）
 */
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

// 1. host 端：tsc
execSync('npx tsc -p tsconfig.json', { stdio: 'inherit' });

// 2. client 端：esbuild 打包（type-only imports 剥离；react 从宿主运行时解析）
const result = await build({
  entryPoints: ['src/client/main.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  write: false,
  logLevel: 'warning',
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
  // 与 DSH 官方 client 插件一致：JSX 走 react/jsx-runtime（automatic），
  // 由 __ModuleLoader__ 的 require 从宿主解析；不用 transform 模式（会生成
  // 全局 React.createElement，宿主无全局 React 导致设置卡片渲染崩溃）。
  jsx: 'automatic',
  // react 由 __ModuleLoader__ 的 require 从宿主解析（前端运行时已提供）。
  external: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
});
const body = result.outputFiles[0].text;
const wrapped = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(pkg.name)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
${body}
		return module.exports;
	}
});
`;
mkdirSync('lib', { recursive: true });
writeFileSync('lib/client.js', wrapped);

// 3. 召回纯逻辑：单独入口，不把 React 拖进来。
await build({
  entryPoints: ['src/client/recall/logic.ts'],
  outfile: 'lib/recall-logic.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  logLevel: 'warning',
});

// 4. 构建后检查 ---------------------------------------------------------
/** 浏览器产物里不许出现框架包的值导入：打包器会内联一份重复运行时（两份 cordis、两份 React）。 */
if (wrapped.includes('@deepseek-ai/')) {
  const at = wrapped.indexOf('@deepseek-ai/');
  throw new Error(
    'lib/client.js 里出现了 @deepseek-ai/ —— 浏览器半区混进了框架包的值导入，' +
      '请改成 `import type`。\n附近内容：…' + wrapped.slice(Math.max(0, at - 80), at + 120) + '…',
  );
}
if (!wrapped.includes('__ModuleLoader__') || !wrapped.includes(pkg.name)) {
  throw new Error(`lib/client.js 缺少 __ModuleLoader__ 握手或 id ${pkg.name}`);
}
/** 功能面必须真的进了产物（否则会被 tree-shaking 静默摇掉）。 */
const REQUIRED = [
  ['设置卡片样式', 'fsr-settings-form'],
  ['幽灵文本的采纳键提示', 'fsr-ghost-key'],
  ['回顾条目', 'dsh-foresight-recap'],
  ['↑/↓ 召回', 'conversation.input.overlay'],
  ['召回限域的宿主锚点', 'data-composer-card'],
];
for (const [label, marker] of REQUIRED) {
  if (!wrapped.includes(marker)) {
    throw new Error(`lib/client.js 里找不到${label}的标记 "${marker}" —— 可能被 tree-shaking 摇掉了`);
  }
}
console.log(`✅ ${pkg.name}: lib/index.js (host) + lib/client.js (browser) + lib/recall-logic.js 构建完成`);
