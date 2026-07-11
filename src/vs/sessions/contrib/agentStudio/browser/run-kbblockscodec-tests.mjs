/*---------------------------------------------------------------------------------------------
 *  Bundler + runner for the KB `.bsdoc` codec unit tests.
 *
 *  Mirrors the engine test runner: maps `./foo.js` → `./foo.ts`, bundles to a
 *  single ESM file and executes under `node:test`.
 *
 *  Usage (from the repo root):
 *      node src/vs/sessions/contrib/agentStudio/browser/run-kbblockscodec-tests.mjs
 *--------------------------------------------------------------------------------------------*/
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const entry = path.resolve(import.meta.dirname, 'kbBlocksCodec.test.ts');

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

const out = path.join(os.tmpdir(), `kb-codec-test-${Date.now()}.mjs`);

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
