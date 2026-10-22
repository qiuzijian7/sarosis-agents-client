/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fs from 'fs';
import path from 'path';
import esbuild from 'esbuild';
import { run } from '../esbuild-webview-common.mts';

const srcDir = path.join(import.meta.dirname, 'chat-webview-src');
const outDir = path.join(import.meta.dirname, 'chat-webview-out');

const isWatch = process.argv.indexOf('--watch') >= 0;

// 0) 渲染引擎 pele：从 dsh 插件的**随包产物**拷进 webview 输出目录。
//
// ⚠ 为什么要拷而不是再塞一份进仓库：pele 的**唯一真源**是 `dsh-plugins/vssaros-pele/assets/`
//   （IDE 渲染进程也读同一份）⇒ 这里只做拷贝，不存在"两个引擎版本" ✗。
//   `chat-webview-out` 是构建产物目录（已 gitignore）⇒ 不会把 666KB 重复提交进仓库 ✓。
const peleSrc = path.join(import.meta.dirname, '..', '..', 'dsh-plugins', 'vssaros-pele', 'assets', 'pele.global.js');
if (!fs.existsSync(peleSrc)) {
	throw new Error(`pele 产物不存在：${peleSrc} —— 先跑 node dsh-plugins/vssaros-pele/tools/build-pele.mjs`);
}
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(peleSrc, path.join(outDir, 'pele.global.js'));
console.log(`[mermaid-chat-features] copied pele.global.js (${(fs.statSync(peleSrc).size / 1024).toFixed(1)} KB)`);

// 1) ESM bundles — consumed by the extension as external
//    `<script type="module" src=".../index.js">` (asWebviewUri).
//    ⚠ `index-render` 已于 2026-10-19 删除：它服务的是**宿主侧隐藏 webview** 那条通道，
//      那条通道已被随包 pele（`IDiagramRenderer`）取代 ⇒ 留着只会让"先构建 webview 才有图"
//      这个陷阱继续存在 ✗。
await run({
	entryPoints: {
		'index': path.join(srcDir, 'index.ts'),
		'index-editor': path.join(srcDir, 'index-editor.ts'),
		'codicon': path.join(import.meta.dirname, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'),
	},
	srcDir,
	outdir: outDir,
	additionalOptions: {
		loader: {
			'.ttf': 'dataurl',
		}
	}
}, process.argv);
