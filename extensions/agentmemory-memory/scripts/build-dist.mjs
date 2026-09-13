// 构建 renderer capability-plugin bundle（dist/extension.js + dist/extension.cjs.js）。
// 背景：dist 由本脚本手工构建（agentmemory-memory 是 tsc 型扩展，无 .esbuild.mts 打包链），
// agentStudio.contribution.ts 的 appResource 指向 dist/extension.js——改 src 后必须重跑本脚本，
// 否则渲染端仍加载旧假实现（R4 教训：out/ 是 gateway 用的，renderer 读 dist/）。
// 运行：node extensions/agentmemory-memory/scripts/build-dist.mjs
import * as esbuild from 'esbuild';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const extRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(extRoot, 'src', 'extension.ts');

const common = {
	entryPoints: [entry],
	bundle: true,
	minify: false,
	sourcemap: true,
	platform: 'browser',
	target: 'es2022',
	logLevel: 'warning',
};

await esbuild.build({ ...common, format: 'esm', outfile: join(extRoot, 'dist', 'extension.js') });
await esbuild.build({ ...common, format: 'cjs', outfile: join(extRoot, 'dist', 'extension.cjs.js') });
console.log('dist rebuilt: extension.js (esm) + extension.cjs.js (cjs)');
