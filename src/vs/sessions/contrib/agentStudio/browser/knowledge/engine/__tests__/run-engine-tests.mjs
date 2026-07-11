/*---------------------------------------------------------------------------------------------
 *  Bundler + runner for the engine functional tests.
 *
 *  The engine uses TS's `.js`-import convention (each module imports its
 *  siblings as `./foo.js` while the file on disk is `./foo.ts`). esbuild
 *  does not rewrite those specifiers by default, so this script installs a
 *  tiny resolve plugin that maps `*.js` → `*.ts` when the `.ts` exists,
 *  then bundles to a single ESM file and runs it under `node:test`.
 *
 *  Usage (from the repo root):
 *      node src/vs/sessions/contrib/agentStudio/browser/knowledge/engine/__tests__/run-engine-tests.mjs
 *--------------------------------------------------------------------------------------------*/

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const entry = path.resolve(
	import.meta.dirname,
	'engine.test.ts',
);

/** Map explicit `.js` imports to their `.ts` source when present. */
const tsResolvePlugin = {
	name: 'ts-js-resolve',
	setup(build) {
		build.onResolve({ filter: /\.js$/ }, async (args) => {
			// Leave node: builtins / bare packages to the default resolver.
			if (!args.path.startsWith('.') && !args.path.startsWith('/')) {
				return undefined;
			}
			const candidate = args.path.replace(/\.js$/, '.ts');
			const resolved = path.resolve(args.resolveDir, candidate);
			if (fs.existsSync(resolved)) {
				return { path: resolved, namespace: 'file' };
			}
			return undefined; // fall back to default (e.g. real .js files)
		});
	},
};

const out = path.join(os.tmpdir(), `kb-engine-test-${Date.now()}.mjs`);

await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	sourcemap: 'inline',
	external: ['node:*', 'esbuild'],
	outfile: out,
	plugins: [tsResolvePlugin],
	logLevel: 'warning',
});

await import(pathToFileURL(out).href);
