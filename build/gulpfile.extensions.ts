/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Increase max listeners for event emitters
import { EventEmitter } from 'events';
EventEmitter.defaultMaxListeners = 100;

import es from 'event-stream';
import fancyLog from 'fancy-log';
import * as fs from 'fs';
import glob from 'glob';
import gulp from 'gulp';
import filter from 'gulp-filter';
import plumber from 'gulp-plumber';
import sourcemaps from 'gulp-sourcemaps';
import * as path from 'path';
import * as nodeUtil from 'util';
import * as ext from './lib/extensions.ts';
import { getVersion } from './lib/getVersion.ts';
import { createReporter } from './lib/reporter.ts';
import * as task from './lib/task.ts';
import * as tsb from './lib/tsb/index.ts';
import { createTsgoStream, spawnTsgo } from './lib/tsgo.ts';
import * as util from './lib/util.ts';
import watcher from './lib/watch/index.ts';

const root = path.dirname(import.meta.dirname);
const commit = getVersion(root);

// Tracks active extension compilations to emit aggregate
// "Starting compilation" / "Finished compilation" messages
// that the problem matcher in tasks.json relies on.
let activeExtensionCompilations = 0;

function onExtensionCompilationStart(): void {
	if (activeExtensionCompilations === 0) {
		fancyLog('Starting compilation');
	}
	activeExtensionCompilations++;
}

function onExtensionCompilationEnd(): void {
	activeExtensionCompilations--;
	if (activeExtensionCompilations === 0) {
		fancyLog('Finished compilation');
	}
}

// To save 250ms for each gulp startup, we are caching the result here
// const compilations = glob.sync('**/tsconfig.json', {
// 	cwd: extensionsPath,
// 	ignore: ['**/out/**', '**/node_modules/**']
// });
const compilations = [
	'extensions/codebuddy-provider/tsconfig.json',
	'extensions/configuration-editing/tsconfig.json',
	'extensions/css-language-features/client/tsconfig.json',
	'extensions/css-language-features/server/tsconfig.json',
	'extensions/debug-auto-launch/tsconfig.json',
	'extensions/debug-server-ready/tsconfig.json',
	'extensions/emmet/tsconfig.json',
	'extensions/extension-editing/tsconfig.json',
	'extensions/git/tsconfig.json',
	'extensions/git-base/tsconfig.json',
	'extensions/github/tsconfig.json',
	'extensions/github-authentication/tsconfig.json',
	'extensions/grunt/tsconfig.json',
	'extensions/gulp/tsconfig.json',
	'extensions/html-language-features/client/tsconfig.json',
	'extensions/html-language-features/server/tsconfig.json',
	'extensions/ipynb/tsconfig.json',
	'extensions/jake/tsconfig.json',
	'extensions/json-language-features/client/tsconfig.json',
	'extensions/json-language-features/server/tsconfig.json',
	'extensions/markdown-language-features/tsconfig.json',
	'extensions/markdown-math/tsconfig.json',
	'extensions/media-preview/tsconfig.json',
	'extensions/merge-conflict/tsconfig.json',
	'extensions/mermaid-chat-features/tsconfig.json',
	'extensions/terminal-suggest/tsconfig.json',
	'extensions/notebook-renderers/tsconfig.json',
	'extensions/npm/tsconfig.json',
	'extensions/php-language-features/tsconfig.json',
	'extensions/references-view/tsconfig.json',
	'extensions/search-result/tsconfig.json',
	'extensions/simple-browser/tsconfig.json',
	'extensions/agent-studio/tsconfig.json',
	'extensions/hermes-agent-provider/tsconfig.json',
	'extensions/knot-agui/tsconfig.json',
	'extensions/tdb-am-gateway/tsconfig.json',
	'extensions/tdb-am-memory/tsconfig.json',
	'extensions/tdb-am-viewer/tsconfig.json',
	'extensions/tunnel-forwarding/tsconfig.json',
	'extensions/typescript-language-features/web/tsconfig.json',
	'extensions/typescript-language-features/tsconfig.json',
	'extensions/vscode-api-tests/tsconfig.json',
	'extensions/vscode-colorize-tests/tsconfig.json',
	'extensions/vscode-colorize-perf-tests/tsconfig.json',
	'extensions/vscode-test-resolver/tsconfig.json',

	'.vscode/extensions/vscode-selfhost-test-provider/tsconfig.json',
	'.vscode/extensions/vscode-selfhost-import-aid/tsconfig.json',
	'.vscode/extensions/vscode-extras/tsconfig.json',
	'.vscode/extensions/vscode-pr-pinger/tsconfig.json',
];

const getBaseUrl = (out: string) => `https://main.vscode-cdn.net/sourcemaps/${commit}/${out}`;

function rewriteTsgoSourceMappingUrlsIfNeeded(build: boolean, out: string, baseUrl: string): Promise<void> {
	if (!build) {
		return Promise.resolve();
	}

	return util.streamToPromise(
		gulp.src(path.join(out, '**', '*.js'), { base: out })
			.pipe(util.rewriteSourceMappingURL(baseUrl))
			.pipe(gulp.dest(out))
	);
}

const tasks = compilations.map(function (tsconfigFile) {
	const absolutePath = path.join(root, tsconfigFile);
	const relativeDirname = path.dirname(tsconfigFile.replace(/^(.*\/)?extensions\//i, ''));

	const overrideOptions: { sourceMap?: boolean; inlineSources?: boolean; base?: string } = {};
	overrideOptions.sourceMap = true;

	const name = relativeDirname.replace(/\//g, '-');

	const srcRoot = path.dirname(tsconfigFile);
	const srcBase = path.join(srcRoot, 'src');
	const src = path.join(srcBase, '**');
	const srcOpts = { cwd: root, base: srcBase, dot: true };

	const out = path.join(srcRoot, 'out');
	const baseUrl = getBaseUrl(out);

	function createPipeline(build: boolean, emitError?: boolean, transpileOnly?: boolean) {
		const reporter = createReporter('extensions');

		overrideOptions.inlineSources = Boolean(build);
		overrideOptions.base = path.dirname(absolutePath);

		const compilation = tsb.create(absolutePath, overrideOptions, { verbose: false, transpileOnly, transpileOnlyIncludesDts: transpileOnly, transpileWithEsbuild: true }, err => reporter(err.toString()));

		const pipeline = function () {
			const input = es.through();
			const tsFilter = filter(['**/*.ts', '!**/lib/lib*.d.ts', '!**/node_modules/**'], { restore: true, dot: true });
			const output = input
				.pipe(plumber({
					errorHandler: function (err) {
						if (err && !err.__reporter__) {
							reporter(err);
						}
					}
				}))
				.pipe(tsFilter)
				.pipe(util.loadSourcemaps())