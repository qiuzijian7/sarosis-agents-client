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
				? [p0.replace(/\.(js|ts|tsx|json)$/, '.ts'), p0.replace(/\.(js|ts|tsx|json)$/, '.tsx'), p0]
				: [p0 + '.ts', p0 + '.tsx', p0 + '/index.ts', p0 + '/index.tsx', p0, p0 + '.js', p0 + '/index.js'];
			for (const c of candidates) {
				const resolved = path.resolve(dir, c);
				try { if (fs.statSync(resolved).isFile()) { return { path: resolved, namespace: 'file' }; } } catch { /* next */ }
			}
			return undefined;
		});
	},
};

/**
 * const enum 降级插件：VS Code 源树大量使用 `export const enum`（tsc 编译期内联），
 * esbuild 只做转译 → const enum 被当 type-only 删除 → 依赖它的模块运行时
 * 「No matching export」挂掉（AgentChatPanel 拉 base/common/filters → CharCode 等）。
 * 降级为普通 enum（运行时对象 + 类型同形，VS Code 社区标准 workaround），
 * 仅作用于 src/vs/** 源树，webview 自身代码不受影响。
 * @type {esbuild.Plugin}
 */
const constEnumDownlevelPlugin = {
	name: 'const-enum-downlevel',
	setup(build) {
		build.onLoad({ filter: /[\\\/]src[\\\/]vs[\\\/].+\.(ts|tsx)$/ }, async (args) => {
			const src = await fs.promises.readFile(args.path, 'utf8');
			if (!/\bconst\s+enum\b/.test(src)) { return undefined; }
			return { contents: src.replace(/\bconst\s+enum\b/g, 'enum'), loader: 'ts' };
		});
	},
};

/**
 * 两个入口：
 *   - `harness.tsx`              节点卡片画廊（780 场景 + 像素基线）
 *   - `canvas/canvasHost.tsx`    ★ 可手拖节点的工作流画布沙箱
 * 共用同一份选项，只换 entry/outfile。
 */
const entries = [
	{ name: 'harness', entry: path.join(__dirname, 'harness.tsx'), out: path.join(distDir, 'harness.js') },
	{ name: 'canvas', entry: path.join(__dirname, 'canvas', 'canvasHost.tsx'), out: path.join(distDir, 'canvas', 'canvas.js') },
];

/** @type {esbuild.BuildOptions} */
const baseOptions = {
	bundle: true,
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
	plugins: [tsResolvePlugin, constEnumDownlevelPlugin],
	logLevel: 'info',
};

fs.mkdirSync(path.join(distDir, 'canvas'), { recursive: true });
fs.copyFileSync(path.join(__dirname, 'index.html'), path.join(distDir, 'index.html'));
fs.copyFileSync(path.join(__dirname, 'canvas', 'index.html'), path.join(distDir, 'canvas', 'index.html'));

// ── 生成 CodeBuddy 真实模型清单模块（聊天沙箱 provider/model 下拉数据源）────
// 数据源：extensions/codebuddy-provider/model.json（73 个真实模型，与 vssaros.exe
// 的聊天 provider 下拉同源——该扩展经 vscode.lm.registerLanguageModelChatProvider
// 注册 vendor 'codebuddy'，AgentOS 侧 provider id = 'lm:codebuddy'）。
// 每次构建重新生成（模型清单随产品更新自动同步）。
try {
	const modelJsonPath = path.resolve(__dirname, '../../../../../../../extensions/codebuddy-provider/model.json');
	const raw = JSON.parse(fs.readFileSync(modelJsonPath, 'utf8'));
	const models = (raw.models ?? []).map(m => ({
		id: String(m.id ?? ''),
		name: String(m.name ?? m.id ?? ''),
		maxInputTokens: typeof m.maxInputTokens === 'number' ? m.maxInputTokens : undefined,
		supportsImages: m.supportsImages === true,
	})).filter(m => m.id);
	const generated = `/*---------------------------------------------------------------------------------------------\n *  [generated] codebuddyModels.generated.ts — 由 visual/build.mjs 从\n *  extensions/codebuddy-provider/model.json 生成（勿手改，构建时覆盖）。\n *  用途：聊天沙箱 provider/model 下拉的真实 CodeBuddy 模型清单。\n *  生成时间：${new Date().toISOString()}（${models.length} 个模型）\n *--------------------------------------------------------------------------------------------*/\n\nexport interface ICodeBuddyModel {\n\tid: string;\n\tname: string;\n\tmaxInputTokens?: number;\n\tsupportsImages?: boolean;\n}\n\nexport const CODEBUDDY_MODELS: ICodeBuddyModel[] = ${JSON.stringify(models, null, 1)};\n`;
	fs.writeFileSync(path.join(__dirname, 'codebuddyModels.generated.ts'), generated);
	console.log(`[visual] codebuddyModels.generated.ts — ${models.length} models`);
} catch (err) {
	console.warn('[visual] codebuddy model.json 读取失败（保留上次生成的模块）：', err.message);
}

if (watch) {
	for (const e of entries) {
		const ctx = await esbuild.context({ ...baseOptions, entryPoints: [e.entry], outfile: e.out });
		await ctx.watch();
	}
	console.log('[visual] watching…');
} else {
	for (const e of entries) {
		await esbuild.build({ ...baseOptions, entryPoints: [e.entry], outfile: e.out });
		const size = fs.statSync(e.out).size;
		console.log(`[visual] built ${e.name} — ${(size / 1024).toFixed(1)} KB`);
	}
}

if (serve || watch) {
	const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.map': 'application/json' };
	http.createServer((req, res) => {
		const urlPath = (req.url ?? '/').split('?')[0];
		const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
		let file = path.join(distDir, rel);
		// 目录 → 补 index.html（`/canvas/` 否则会 404）
		try { if (fs.statSync(file).isDirectory()) { file = path.join(file, 'index.html'); } } catch { /* 保持原样，交给 404 */ }
		// 防目录穿越
		if (!file.startsWith(distDir)) { res.writeHead(403).end('forbidden'); return; }
		fs.readFile(file, (err, buf) => {
			if (err) { res.writeHead(404).end('not found'); return; }
			res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
			res.end(buf);
		});
	}).on('error', (err) => {
		// ★ 端口占用兜底（2026-09-04）：watch 模式下 5599 被残留实例占用会
		//   EADDRINUSE → 顶层未捕获 → 进程退出，watch 链静默死亡（watch-all 里
		//   表现为「② exited code=1」）。服务起不来只影响预览 URL，**watch 必须
		//   继续**——打印指引而非退出。
		console.error(
			`[visual] http server failed (port ${PORT}): ${err.message} — ` +
			`watch 仍继续（bundle 照常增量产出）；如需预览，换端口：--port=5598`,
		);
	}).listen(PORT, () => {
		console.log(`[visual] harness → http://localhost:${PORT}/`);
		console.log(`[visual] 单节点聚焦示例 → http://localhost:${PORT}/?only=ComfyTV.ImageStage&state=success`);
		console.log(`[visual] ★ 画布沙箱（手拖节点）→ http://localhost:${PORT}/canvas/`);
	});
}
