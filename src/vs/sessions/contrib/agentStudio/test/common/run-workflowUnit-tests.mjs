import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const Mocha = require('mocha');

const entry = path.resolve(import.meta.dirname, './workflowUnit.test.ts');

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

const out = path.join(os.tmpdir(), `workflow-unit-test-${Date.now()}.cjs`);

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

const mocha = new Mocha({ ui: 'tdd', timeout: 20000 });
mocha.addFile(out);
mocha.run((failures) => {
	process.exit(failures ? 1 : 0);
});
