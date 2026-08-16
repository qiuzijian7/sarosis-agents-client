/*---------------------------------------------------------------------------------------------
 *  One-shot runner for workflowChipComposer.test.ts.
 *  Usage (from repo root):
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-workflowChipComposer-tests.mjs
 *--------------------------------------------------------------------------------------------*/
import path from 'node:path';
import os from 'node:os';
import fsSync from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Mocha = require('mocha');

const entry = path.resolve(import.meta.dirname, 'workflowChipComposer.test.ts');

const tsResolvePlugin = {
	name: 'ts-js-resolve',
	setup(build) {
		build.onResolve({ filter: /\.js$/ }, async (args) => {
			if (!args.path.startsWith('.') && !args.path.startsWith('/')) {
				return undefined;
			}
			const candidate = args.path.replace(/\.js$/, '.ts');
			const resolved = path.resolve(args.resolveDir, candidate);
			if (fsSync.existsSync(resolved)) {
				return { path: resolved, namespace: 'file' };
			}
			return undefined;
		});
	},
};

const esbuild = (await import('esbuild')).default;
const out = path.join(os.tmpdir(), `workflowChipComposer-${Date.now()}.cjs`);

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
	tsconfigRaw: {
		compilerOptions: {
			experimentalDecorators: true,
			useDefineForClassFields: false,
		},
	},
});

const mocha = new Mocha({ ui: 'tdd', timeout: 15000 });
mocha.addFile(out);

let failures = 0;
await new Promise((resolve) => {
	const runner = mocha.run((failCount) => {
		failures = failCount;
		resolve();
	});
	if (!runner) { resolve(); }
});

try { fsSync.unlinkSync(out); } catch { /* ignore */ }

process.exit(failures ? 1 : 0);
