/*---------------------------------------------------------------------------------------------
 *  Bundler + runner for the KB editor-core unit tests.
 *
 *  Mirrors the engine test runner (../knowledge/engine/__tests__/run-engine-tests.mjs):
 *  the editor core uses the `.js`-import convention, so a tiny resolve plugin maps
 *  `./foo.js` → `./foo.ts` when the `.ts` exists, then esbuild bundles to a single
 *  ESM file and runs it under `node:test`.
 *
 *  Usage (from the repo root):
 *      node src/vs/sessions/contrib/agentStudio/webview/src/kbBlocks/__tests__/run-editorcore-tests.mjs
 *--------------------------------------------------------------------------------------------*/
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const entry = path.resolve(import.meta.dirname, 'editorCore.test.ts');

/** Map explicit `.js` imports to their `.ts` source when present. */
const tsResolvePlugin = {
	name: 'ts-js-resolve',
	setup(build) {
		build.onResolve({ filter: /\.js$/ }, async (args) => {
			if (!args.path.startsWith('.') && !args.path.startsWith('/')) {
				return undefined;
			}
			const candidate = args.path.replace(/\.js$/, '.ts');
			const resolved = path.resolve(args.resolveDir, candidate);
			if (fs.existsSync(resolved)) {
				return { path: resolved, namespace: 'file' };
			}
			return undefined;
		});
	},
};

const out = path.join(os.tmpdir(), `kb-editorcore-test-${Date.now()}.mjs`);

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
