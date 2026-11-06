/**
 * 热度管理设置卡片预览构建：scripts/preview/preview.tsx → 自包含单文件 HTML
 * （react/react-dom 打包内联，双击 file:// 即开，无需 DSH 运行）。
 * 用法：node scripts/preview-card.mjs
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const result = await build({
  entryPoints: ['scripts/preview/preview.tsx'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  write: false,
  logLevel: 'warning',
  minify: false,
  loader: { '.tsx': 'tsx', '.ts': 'ts' },
  jsx: 'automatic',
  // react 来自本仓库 devDependencies；如需指向别处，设置 NODE_PATH。
});

const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-foresight 设置卡片预览</title>
</head>
<body>
<div id="root"></div>
<script>
${result.outputFiles[0].text}
</script>
</body>
</html>
`;

mkdirSync('preview', { recursive: true });
writeFileSync(join('preview', 'suggest-ghost-card.html'), html);
console.log('✅ preview/suggest-ghost-card.html 构建完成（自包含，浏览器直接打开）');
