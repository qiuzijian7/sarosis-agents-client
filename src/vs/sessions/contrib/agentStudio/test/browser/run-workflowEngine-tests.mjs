import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';

const entry = path.resolve(import.meta.dirname, './workflowEngine.integration.test.ts');

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

const out = path.join(os.tmpdir(), `workflow-engine-test-${Date.now()}.cjs`);

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

const r = spawnSync('npx', ['mocha', '--ui', 'tdd', '--timeout', '5000', out], {
	stdio: 'inherit',
	shell: process.platform === 'win32',
});
process.exit(r.status ?? 1);
