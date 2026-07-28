import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';
import Mocha from 'mocha';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));

const entry = path.join(__dirname, 'preLoopOrchestrator.test.ts');
const outfile = path.join(os.tmpdir(), 'preLoopOrchestrator.test.js');

const tsResolvePlugin = {
	name: 'ts-resolve',
	setup(b) {
		b.onResolve({ filter: /\.js$/ }, args => {
			const dir = path.dirname(path.resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts')));
			const base = path.basename(args.path, '.js');
			return { path: path.join(dir, base + '.ts') };
		});
		b.onResolve({ filter: /\.ts$/ }, args => {
			return { path: path.resolve(args.resolveDir, args.path) };
		});
	},
};

const mocha = new Mocha({ reporter: 'spec', color: true });

await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	format: 'cjs',
	platform: 'node',
	outfile,
	plugins: [tsResolvePlugin],
	logLevel: 'silent',
	sourcemap: false,
});

mocha.addFile(outfile);
mocha.run(failures => {
	process.exitCode = failures ? 1 : 0;
});
