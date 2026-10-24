// @ts-check
// 独立 esbuild bundle：KB 侧栏（知识库 sideview，React）→ media/kbSideview.js
//
// 与 esbuild.kbviewers.config.mjs 同构：单 IIFE（不做 ESM splitting），宿主一次性内联注入。
//
// 为什么单独一个 bundle 而不是并进 kbblocks：
//   - kbblocks 是「笔记编辑器」（WYSIWYG + pdf.js + mammoth ≈ 3.8MB），只在打开笔记时加载；
//   - 侧栏是**常驻**视图，不能拖着一个 3.8MB 的编辑器 bundle 一起走 ✗。
//   ⇒ 两个 bundle 各自按需加载，侧栏这份应该只有几十 KB。
//
// 产出：media/kbSideview.js（+ 同名 css）。宿主通过 `asWebviewUri` 交给 webview，
//       或由 `WebviewViewProvider` 注入；本阶段**只产出、不接线**（零回归）。
import * as esbuild from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');
const MEDIA = resolve(__dirname, 'media');

/** @type {esbuild.BuildOptions} */
const buildOptions = {
	entryPoints: [resolve(__dirname, 'src/kbSideview/index.tsx')],
	bundle: true,
	outdir: MEDIA,
	format: 'iife',
	splitting: false,
	platform: 'browser',
	target: ['es2022'],
	minify: !isWatch,
	sourcemap: isWatch ? 'inline' : false,
	entryNames: 'kbSideview',
	loader: {
		'.ts': 'ts',
		'.tsx': 'tsx',
		'.css': 'css',
	},
	define: {
		'process.env.NODE_ENV': isWatch ? '"development"' : '"production"',
	},
	jsx: 'automatic',
	logLevel: 'info',
};

if (isWatch) {
	const ctx = await esbuild.context(buildOptions);
	await ctx.watch();
	console.log('kbSideview: watching…');
} else {
	await esbuild.build(buildOptions);
}
