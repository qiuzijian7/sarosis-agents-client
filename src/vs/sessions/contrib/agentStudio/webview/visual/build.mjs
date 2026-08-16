// @ts-check
/*---------------------------------------------------------------------------------------------
 *  visual/build.mjs — 构建 harness bundle，并可选起一个静态服务。
 *
 *  用法：
 *    node visual/build.mjs            构建到 visual/dist/
 *    node visual/build.mjs --serve    构建 + 起服务（默认 5599）+ 打印 URL
 *    node visual/build.mjs --watch    watch 模式 + 服务
 *
 *  与主 esbuild.config.mjs 的区别：
 *    - 入口是 visual/harness.tsx（不是 src/index.tsx）
 *    - 不 minify、保留 sourcemap（可视化调试要读栈）
 *    - 不 drop console
 *    - 复用同一个 `ts-js-resolve` 思路：带 .js 后缀的相对 import 回退到 .ts/.tsx
 *      （项目源码用 TS-ESM 风格写 import，见 e2e/run.mjs 同款插件）
 *--------------------------------------------------------------------------------------------*/

import * as esbuild from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webviewRoot = path.resolve(__dirname, '..');
const distDir = path.join(__dirname, 'dist');

const serve = process.argv.includes('--serve');
const watch = process.argv.includes('--watch');
const portArg = process.argv.find(a => a.startsWith('--port='));
const PORT = portArg ? Number(portArg.split('=')[1]) : 5599;

/**
 * 相对 import 解析插件：`./x.js` → `./x.ts` / `./x.tsx`。
 * 与 e2e/run.mjs 保持一致（项目源码混用带/不带扩展名的说明符）。
 * @type {esbuild.Plugin}
 */
const tsResolvePlugin = {
	name: 'ts-js-resolve',
	setup(build) {
		build.onResolve({ filter: /^\.+\// }, (args) => {
			const dir = args.resolveDir;
			const p0 = args.path;
			const ext = path.extname(p0);
			const candidates = ext
				? [p0, p0.replace(/\.(js|ts|tsx|json)$/, '.ts'), p0.replace(/\.(js|ts|tsx|json)$/, '.tsx')]
				: [p0 + '.ts', p0 + '.tsx', p0 + '.js', p0 + '/index.ts', p0 + '/index.tsx', p0 + '/index.js', p0];
			for (const c of candidates) {
				const resolved = path.resolve(dir, c);
				try { if (fs.statSync(resolved).isFile()) { return { path: resolved, namespace: 'file' }; } } catch { /* next */ }
			}
			return undefined;
		});
	},
};

/** @type {esbuild.BuildOptions} */
const options = {
	entryPoints: [path.join(__dirname, 'harness.tsx')],
	bundle: true,
	outfile: path.join(distDir, 'harness.js'),
	// IIFE：一个 <script> 加载，与 webview 产物形态一致（避免 ESM 模块图差异掩盖 bug）
	format: 'iife',
	platform: 'browser',
	target: ['es2022'],
	// 可视化调试要能读到真实变量名与栈
	minify: false,
	sourcemap: 'inline',
	jsx: 'automatic',
	loader: { '.tsx': 'tsx', '.ts': 'ts', '.css': 'css' },
	define: { 'process.env.NODE_ENV': '"development"' },
	nodePaths: [path.join(webviewRoot, 'node_modules')],
	resolveExtensions: ['.tsx', '.ts', '.mjs', '.js', '.json'],
	plugins: [tsResolvePlugin],
	logLevel: 'info',
};

fs.mkdirSync(distDir, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'index.html'), path.join(distDir, 'index.html'));

if (watch) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
	console.log('[visual] watching…');
} else {
	await esbuild.build(options);
	const size = fs.statSync(path.join(distDir, 'harness.js')).size;
	console.log(`[visual] built harness.js — ${(size / 1024).toFixed(1)} KB`);
}

if (serve || watch) {
	const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.map': 'application/json' };
	http.createServer((req, res) => {
		const urlPath = (req.url ?? '/').split('?')[0];
		const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
		const file = path.join(distDir, rel);
		// 防目录穿越
		if (!file.startsWith(distDir)) { res.writeHead(403).end('forbidden'); return; }
		fs.readFile(file, (err, buf) => {
			if (err) { res.writeHead(404).end('not found'); return; }
			res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
			res.end(buf);
		});
	}).listen(PORT, () => {
		console.log(`[visual] harness → http://localhost:${PORT}/`);
		console.log(`[visual] 单节点聚焦示例 → http://localhost:${PORT}/?only=ComfyTV.ImageStage&state=success`);
	});
}
