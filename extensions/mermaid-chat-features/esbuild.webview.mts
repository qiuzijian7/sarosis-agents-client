/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'path';
import esbuild from 'esbuild';
import { run } from '../esbuild-webview-common.mts';

const srcDir = path.join(import.meta.dirname, 'chat-webview-src');
const outDir = path.join(import.meta.dirname, 'chat-webview-out');

const isWatch = process.argv.indexOf('--watch') >= 0;

// 1) ESM bundles — consumed by the extension as external
//    `<script type="module" src=".../index-render.js">` (asWebviewUri).
await run({
	entryPoints: {
		'index': path.join(srcDir, 'index.ts'),
		'index-editor': path.join(srcDir, 'index-editor.ts'),
		'index-render': path.join(srcDir, 'index-render.ts'),
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

// 2) IIFE build of the renderer bundle — this is inlined as a CLASSIC
//    `<script nonce>` into the hidden workbench webview created by
//    MermaidInlineRenderer. VS Code's webview HTML application (setHtml) does
//    NOT reliably execute inline ES module scripts, but classic inline scripts
//    work (see agentStudioWebviewPool._buildPooledHtml). Keep the ESM
//    `index-render.js` above for the extension's external-module load path.
if (!isWatch) {
	await esbuild.build({
		entryPoints: { 'index-render-inline': path.join(srcDir, 'index-render.ts') },
		bundle: true,
		minify: true,
		sourcemap: false,
		format: 'iife',
		platform: 'browser',
		target: ['es2024'],
		outdir: outDir,
		loader: { '.ttf': 'dataurl' },
	});
}
