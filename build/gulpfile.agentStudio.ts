/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import gulp from 'gulp';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as task from './lib/task.ts';

const WEBVIEW_DIR = path.resolve(import.meta.dirname, '..', 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'webview');
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Install dependencies for the Agent Studio WebView.
 */
function installAgentStudioWebview() {
	return new Promise<void>((resolve, reject) => {
		try {
			// Do NOT use --prefer-offline: in CI there is no local npm cache, so
			// --prefer-offline would fail to fetch and leave node_modules/katex absent,
			// causing esbuild.kbblocks.config.mjs to ENOENT on katex/dist/katex.min.css.
			// The CI env sets npm_config_registry to the npmmirror mirror, so a plain
			// install goes through it.
			execSync('npm install --ignore-scripts --no-audit --no-fund', {
				cwd: WEBVIEW_DIR,
				stdio: 'inherit',
			});
			resolve();
		} catch (err) {
			reject(err);
		}
	});
}

/**
 * Build the Agent Studio WebView React application using esbuild.
 */
function buildAgentStudioWebview() {
	return new Promise<void>((resolve, reject) => {
		try {
			execSync('node esbuild.config.mjs', {
				cwd: WEBVIEW_DIR,
				stdio: 'inherit',
			});
			resolve();
		} catch (err) {
			reject(err);
		}
	});
}

/**
 * Build the AFFiNE / BlockSuite KB editor probe bundle (media/kbblocks.js).
 */
function buildAgentStudioKbBlocks() {
	return new Promise<void>((resolve, reject) => {
		try {
			// Ensure deps (katex etc.) are present before bundling. In CI the webview
			// node_modules may be absent; install on demand so the kbblocks bundle never
			// fails with ENOENT on katex/dist/katex.min.css.
			if (!fs.existsSync(path.join(WEBVIEW_DIR, 'node_modules', 'katex', 'dist', 'katex.min.css'))) {
				console.log('[agentStudio] katex not found in webview node_modules, installing...');
				installAgentStudioWebview();
			}
			execSync('node esbuild.kbblocks.config.mjs', {
				cwd: WEBVIEW_DIR,
				stdio: 'inherit',
			});
			resolve();
		} catch (err) {
			reject(err);
		}
	});
}

const compileAgentStudioWebviewTask = task.define('compile-agent-studio-webview',
	task.series(installAgentStudioWebview, buildAgentStudioWebview)
);

const buildAgentStudioKbBlocksTask = task.define('build-agent-studio-kbblocks',
	buildAgentStudioKbBlocks
);

/**
 * Copy the pre-built BlockSuite bundle (media/kbblocks.js) into `out` so the
 * production build can load it from `out/.../webview/media`. In dev (tsc watch)
 * the host falls back to reading it from `src/.../webview/media`, but the
 * packaged build only ships `out`.
 */
function copyKbBlocksMedia() {
	return new Promise<void>((resolve, reject) => {
		try {
			const srcFile = path.join(WEBVIEW_DIR, 'media', 'kbblocks.js');
			const outDir = path.join(REPO_ROOT, 'out', 'vs', 'sessions', 'contrib', 'agentStudio', 'webview', 'media');
			fs.mkdirSync(outDir, { recursive: true });
			fs.copyFileSync(srcFile, path.join(outDir, 'kbblocks.js'));
			resolve();
		} catch (err) {
			reject(err);
		}
	});
}
const copyKbBlocksMediaTask = task.define('copy-agent-studio-kbblocks-media', copyKbBlocksMedia);

const compileAllAgentStudioTask = task.define('compile-all-agent-studio',
	task.series(installAgentStudioWebview, task.parallel(buildAgentStudioWebview, buildAgentStudioKbBlocks), copyKbBlocksMediaTask)
);

gulp.task(compileAgentStudioWebviewTask);
gulp.task(buildAgentStudioKbBlocksTask);

export { installAgentStudioWebview };
gulp.task(compileAllAgentStudioTask);

export { compileAgentStudioWebviewTask, buildAgentStudioKbBlocksTask, compileAllAgentStudioTask };
