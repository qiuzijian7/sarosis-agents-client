/*---------------------------------------------------------------------------------------------
 *  飞书长连接「真连」联测（esbuild + mocha，纯 Node.js 环境）。
 *
 *  用法：node run-feishuWsLive-tests.mjs
 *        npm run test-agentstudio-feishu-ws
 *--------------------------------------------------------------------------------------------*/

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const Mocha = require('mocha');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(__dirname, 'feishuWsLive.test.ts');

/** Map explicit `.js` imports to their `.ts` source (VS Code style). */
const tsResolvePlugin = {
	name: 'ts-js-resolve',
	setup(build) {
		build.onResolve({ filter: /\.js$/ }, async (args) => {
			if (!args.path.startsWith('.') && !args.path.startsWith('/')) { return undefined; }
			const candidate = args.path.replace(/\.js$/, '.ts');
			const resolved = path.resolve(args.resolveDir, candidate);
			const fsMod = await import('node:fs');
			if (fsMod.existsSync(resolved)) { return { path: resolved, namespace: 'file' }; }
			return undefined;
		});
	},
};

const projectRoot = path.resolve(__dirname, '../../../../../../..');
const out = path.join(projectRoot, 'tmp', `feishuWsLive-test-${Date.now()}.cjs`);
fs.mkdirSync(path.join(projectRoot, 'tmp'), { recursive: true });

await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	outfile: out,
	plugins: [tsResolvePlugin],
}).catch(e => { console.error('BUILD FAILED:', e); process.exit(1); });

const mocha = new Mocha({ ui: 'bdd', timeout: 15_000, reporter: 'spec' });
mocha.addFile(out);
mocha.run(failures => {
	process.exitCode = failures ? 1 : 0;
});
