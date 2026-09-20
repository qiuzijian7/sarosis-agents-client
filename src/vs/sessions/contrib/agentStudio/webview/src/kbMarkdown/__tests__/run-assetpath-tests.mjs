/*---------------------------------------------------------------------------------------------
 *  Bundler + runner for the kbMarkdown assetPath unit tests.
 *  Mirrors ../kbBlocks/__tests__/run-editorcore-tests.mjs：`.js` import → `.ts` 映射，
 *  esbuild 打成单文件 ESM，node:test 运行。
 *
 *  Usage (from the repo root):
 *      node src/vs/sessions/contrib/agentStudio/webview/src/kbMarkdown/__tests__/run-assetpath-tests.mjs
 *--------------------------------------------------------------------------------------------*/
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const entry = path.resolve(import.meta.dirname, 'assetPath.test.ts');

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
			if (fs.existsSync(resolved)) {
				return { path: resolved, namespace: 'file' };
			}
			return undefined;
		});
	},
};

const out = path.join(os.tmpdir(), `kb-assetpath-test-${Date.now()}.mjs`);

await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: out,
	plugins: [tsResolvePlugin],
	logLevel: 'silent',
});

await import(pathToFileURL(out).href);
