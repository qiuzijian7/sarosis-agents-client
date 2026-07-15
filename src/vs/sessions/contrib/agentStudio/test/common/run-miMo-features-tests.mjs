/*---------------------------------------------------------------------------------------------
 *  Bundler + mocha runner for the MiMo-Code-inspired feature tests.
 *  esbuild bundles the .test.ts (resolving .js->.ts), then mocha (tdd ui) runs it.
 *
 *  Usage (from the repo root):
 *      node src/vs/sessions/contrib/agentStudio/test/common/run-miMo-features-tests.mjs
 *--------------------------------------------------------------------------------------------*/
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const Mocha = require('mocha');

const entry = path.resolve(import.meta.dirname, './agentOS-miMo-features.test.ts');

/** Map explicit `.js` imports to their `.ts` source when present (VS Code style). */
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

const out = path.join(os.tmpdir(), `mimo-features-test-${Date.now()}.cjs`);

await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node20',
	sourcemap: 'inline',
	external: ['node:*'],
	outfile: out,
	plugins: [tsResolvePlugin],
	logLevel: 'warning',
});

const mocha = new Mocha({ ui: 'tdd', timeout: 10000 });
mocha.addFile(out);
mocha.run((failures) => {
	// Force exit: StallWatchdog leaves a pending setTimeout on the event loop.
	process.exit(failures ? 1 : 0);
});
