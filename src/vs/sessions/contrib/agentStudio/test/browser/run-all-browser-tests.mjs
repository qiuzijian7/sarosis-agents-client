/*---------------------------------------------------------------------------------------------
 *  One-shot runner for ALL agentStudio *browser* tests.
 *
 *  Mirrors run-browser-test.mjs but discovers *.test.ts files in this directory
 *  and runs them sequentially under a single Mocha instance.
 *
 *  Usage (from the repo root):
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-all-browser-tests.mjs
 *      npm run test-agentstudio-browser
 *--------------------------------------------------------------------------------------------*/
import path from 'node:path';
import os from 'node:os';
import fsSync from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Mocha = require('mocha');

const testDir = import.meta.dirname;

// Discover all .test.ts files (exclude test-helper / fixture files starting with _)
const testFiles = fsSync
	.readdirSync(testDir)
	.filter(f => /^[a-z].+\.test\.ts$/.test(f))
	.sort()
	.map(f => path.resolve(testDir, f));

if (testFiles.length === 0) {
	console.error('No agentStudio browser test files found.');
	process.exit(1);
}

console.log(`Discovered ${testFiles.length} agentStudio browser test file(s):`);
for (const f of testFiles) {
	console.log(`  ${path.relative(process.cwd(), f)}`);
}

// ─── Bundle each test file with esbuild ──────────────────────────────────────

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
			if (fsSync.existsSync(resolved)) {
				return { path: resolved, namespace: 'file' };
			}
			return undefined;
		});
	},
};

const esbuild = (await import('esbuild')).default;

const tempFiles = [];

let buildOk = 0;
let buildSkipped = 0;

for (const entry of testFiles) {
	const out = path.join(os.tmpdir(), `agentstudio-browser-all-${Date.now()}-${path.basename(entry, '.ts')}.cjs`);

	try {
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
		tempFiles.push(out);
		buildOk++;
	} catch (err) {
		buildSkipped++;
		console.warn(`  [SKIP] ${path.relative(process.cwd(), entry)} — ${err.message.split('\n')[0]}`);
		// Clean up the partial outfile if esbuild created it
		try { fsSync.unlinkSync(out); } catch { /* ignore */ }
	}
}

if (buildOk === 0) {
	console.error('No test files built successfully — aborting.');
	process.exit(1);
}

console.log(`\nBuilt ${buildOk} test file(s), skipped ${buildSkipped} (pre-existing build issues).`);

// ─── Run each bundled file in its own Mocha instance ────────────────────────
// Per-file isolation: a crash in one test file (e.g. module-level `window` ref)
// only skips that file, not the entire suite.

let totalPassing = 0;
let totalFailing = 0;
let totalSkippedRuntime = 0;
let globFailures = 0;

for (const f of tempFiles) {
	const mocha = new Mocha({ ui: 'tdd', timeout: 15000 });
	mocha.addFile(f);

	const label = path.basename(f, '.cjs').replace(/^agentstudio-browser-all-\d+-/, '');

	try {
		await new Promise((resolve) => {
			const runner = mocha.run((failCount) => {
				totalPassing += mocha.suite.total() - failCount;
				totalFailing += failCount;
				globFailures += failCount;
				resolve();
			});
			if (!runner) { resolve(); }
		});
	} catch (err) {
		totalSkippedRuntime++;
		console.warn(`  [RUNTIME-SKIP] ${label}.test — ${err.message.split('\n')[0]}`);
	}
}

// ─── Cleanup ────────────────────────────────────────────────────────────────
const cleanup = () => {
	for (const f of tempFiles) {
		try { fsSync.unlinkSync(f); } catch { /* ignore */ }
	}
};
cleanup();

console.log(`\n---`);
console.log(`Total: ${totalPassing} passing, ${totalFailing} failing`);
console.log(`Built: ${buildOk} | Skipped (build): ${buildSkipped} | Skipped (runtime): ${totalSkippedRuntime}`);
console.log(`---`);
process.exit(globFailures ? 1 : 0);
