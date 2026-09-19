/*---------------------------------------------------------------------------------------------
 *  Bundler + runner for the turnLoopConstants consistency tests
 *  (mirror of the turnStopGate test runner).
 *
 *  The project uses TS's `.js`-import convention; this script installs a tiny
 *  resolve plugin mapping `*.js` → `*.ts` when the `.ts` exists, bundles to a
 *  single ESM file and runs it under `node:test`.
 *
 *  ⚠ MUST be run from the repo root: the test reads `agentOSService.ts` off disk
 *  via a cwd-relative path (it cannot import it — that would pull in the whole
 *  workbench dependency tree).
 *
 *  Usage (from the repo root):
 *      node src/vs/sessions/contrib/agentStudio/test/common/run-turnloopconstants-tests.mjs
 *--------------------------------------------------------------------------------------------*/

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const entry = path.resolve(import.meta.dirname, 'turnLoopConstants.test.ts');

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

const out = path.join(os.tmpdir(), `agentstudio-turnloopconstants-test-${Date.now()}.mjs`);

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
