/*---------------------------------------------------------------------------------------------
 *  飞书长连接联调探针的运行器：esbuild 打包探针（复用生产编解码 feishuWsProtocol.ts）后执行。
 *
 *  用法：
 *    node run-feishu-ws-probe.mjs --appId cli_xxx --appSecret yyy [--base ...] [--timeoutSec 30] [--keep]
 *    FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=yyy node run-feishu-ws-probe.mjs
 *    npm run probe-feishu-ws -- --appId cli_xxx --appSecret yyy
 *--------------------------------------------------------------------------------------------*/

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(__dirname, 'feishuWsProbe.ts');

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
const out = path.join(projectRoot, 'tmp', `feishuWsProbe-${Date.now()}.cjs`);
fs.mkdirSync(path.join(projectRoot, 'tmp'), { recursive: true });

await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	outfile: out,
	plugins: [tsResolvePlugin],
}).catch(e => { console.error('BUILD FAILED:', e); process.exit(1); });

const r = spawnSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
