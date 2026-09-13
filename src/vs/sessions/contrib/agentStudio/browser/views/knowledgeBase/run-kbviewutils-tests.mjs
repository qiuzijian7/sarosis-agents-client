/*---------------------------------------------------------------------------------------------
 *  Lightweight runner for KB view-utility unit tests (kbViewUtils.test.ts).
 *
 *  Bundles the test + its imports with esbuild (mapping `./foo.js` → `./foo.ts`)
 *  and executes under Mocha (the same globals `describe`/`it` the KB tests use).
 *
 *  Usage (from the repo root):
 *      node src/vs/sessions/contrib/agentStudio/browser/views/knowledgeBase/run-kbviewutils-tests.mjs
 *--------------------------------------------------------------------------------------------*/
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const Mocha = require('mocha');

const entry = path.resolve(import.meta.dirname, 'kbViewUtils.test.ts');

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

const out = path.join(os.tmpdir(), `kb-viewutils-test-${Date.now()}.mjs`);

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

const mocha = new Mocha({ ui: 'bdd', reporter: 'spec', timeout: 5000 });
mocha.addFile(out);
await mocha.loadFilesAsync();
await mocha.run((failures) => {
	process.exitCode = failures ? 1 : 0;
});
