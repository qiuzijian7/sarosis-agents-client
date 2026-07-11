/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { EventEmitter } from 'events';
EventEmitter.defaultMaxListeners = 100;

import { execSync } from 'child_process';
import glob from 'glob';
import gulp from 'gulp';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'path';
import { monacoTypecheckTask /* , monacoTypecheckWatchTask */ } from './gulpfile.editor.ts';
import { compileExtensionMediaTask, compileExtensionsTask, watchExtensionsTask } from './gulpfile.extensions.ts';
import * as compilation from './lib/compilation.ts';
import * as task from './lib/task.ts';
import * as util from './lib/util.ts';
import { runEsbuildTranspile } from './lib/esbuild.ts';

// ── Media asset pre-build (BlockSuite KB probe) ─────────────────────────────

const WEBVIEW_DIR = path.resolve(import.meta.dirname, '..', 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'webview');

/** Ensure media/kbblocks.js exists in src/ before the transpile copies it to out/. Non-fatal (the probe is optional for now). */
function compileKbBlocksMedia() {
	return new Promise<void>((resolve) => {
		const outFile = path.join(WEBVIEW_DIR, 'media', 'kbblocks.js');
		// Skip rebuild if the bundle already exists — avoids redundant fd pressure
		// on every compile (the probe only needs rebuilding when its source changes).
		if (fs.existsSync(outFile)) {
			console.log('[gulpfile] build:kbblocks skipped (media/kbblocks.js present)');
			return resolve();
		}
		try {
			execSync('node esbuild.kbblocks.config.mjs', {
				cwd: WEBVIEW_DIR,
				stdio: 'inherit',
				timeout: 120_000,
			});
		} catch (err) {
			console.warn('[gulpfile] build:kbblocks failed (non-fatal):', String(err).slice(0, 200));
		}
		resolve();
	});
}

const compileKbBlocksMediaTask = task.define('compile-kbblocks-media', compileKbBlocksMedia);
gulp.task(compileKbBlocksMediaTask);

// ── Standard build tasks ─────────────────────────────────────────────────────

// Extension point names
gulp.task(compilation.compileExtensionPointNamesTask);

const require = createRequire(import.meta.url);

// API proposal names
gulp.task(compilation.compileApiProposalNamesTask);
gulp.task(compilation.watchApiProposalNamesTask);

// Client Transpile
gulp.task(task.define('transpile-client-esbuild', task.series(
	compilation.copyCodiconsTask,
	task.define('esbuild-out-build', () => runEsbuildTranspile('out', false)),
)));

// Transpile only
const transpileClientTask = task.define('transpile-client', task.series(compileKbBlocksMediaTask, util.rimraf('out'), compilation.transpileTask('src', 'out')));
gulp.task(transpileClientTask);

// Fast compile for development time
const compileClientTask = task.define('compile-client', task.series(compileKbBlocksMediaTask, util.rimraf('out'), compilation.copyCodiconsTask, compilation.compileApiProposalNamesTask, compilation.compileExtensionPointNamesTask, compilation.compileTask('src', 'out', false)));
gulp.task(compileClientTask);

const watchClientTask = task.define('watch-client', task.series(compileKbBlocksMediaTask, task.parallel(compilation.watchTypeCheckTask('src'), compilation.watchApiProposalNamesTask, compilation.watchExtensionPointNamesTask, compilation.watchCodiconsTask)));
gulp.task(watchClientTask);

// All
const _compileTask = task.define('compile', task.parallel(monacoTypecheckTask, compileClientTask, compileExtensionsTask, compileExtensionMediaTask));
gulp.task(_compileTask);

gulp.task(task.define('watch', task.parallel(/* monacoTypecheckWatchTask, */ watchClientTask, watchExtensionsTask)));

// Default
gulp.task('default', _compileTask);

process.on('unhandledRejection', (reason, p) => {
	console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
	process.exit(1);
});

// Load all the gulpfiles only if running tasks other than the editor tasks
glob.sync('gulpfile.*.ts', { cwd: import.meta.dirname })
	.forEach(f => {
		return require(`./${f}`);
	});
