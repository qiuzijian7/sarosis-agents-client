/*---------------------------------------------------------------------------------------------
 *  Bundler + runner for the i18n prompt catalog tests.
 *  Mirrors run-engine-tests.mjs; injects KB_ENGINE_DIR so the test can
 *  locate prompts.yaml relative to the engine source dir.
 *
 *  Usage (from the repo root):
 *      node src/vs/sessions/contrib/agentStudio/browser/knowledge/engine/__tests__/run-i18n-tests.mjs
 *--------------------------------------------------------------------------------------------*/

import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

process.env.KB_ENGINE_DIR = path.resolve(import.meta.dirname, '..');

const entry = path.resolve(import.meta.dirname, 'i18nPrompts.test.ts');

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
			const fs = await import('node:fs');
			if (fs.existsSync(resolved)) {
				return { path: resolved, namespace: 'file' };
			}
			return undefined;
		});
	},
};

const out = path.join(os.tmpdir(), `kb-i18n-test-${Date.now()}.mjs`);

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
