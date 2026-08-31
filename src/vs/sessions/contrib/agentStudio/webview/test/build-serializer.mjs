/**
 * 把 drawioSerializer.ts 打包成 node 可 require 的 CJS（供 fromDrawio.test.mjs 使用）。
 * 仅打包，不引入 maxgraph 等浏览器依赖（fromDrawio 只用 DOMParser）。
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, '../src/features/mindmap/drawioSerializer.ts');
const out = resolve(__dirname, '.drawioSerializer.cjs');

await build({
	bundle: true,
	format: 'cjs',
	platform: 'node',
	target: 'node18',
	entryPoints: [entry],
	outfile: out,
	logLevel: 'info',
});

console.log(`bundled -> ${out}`);
