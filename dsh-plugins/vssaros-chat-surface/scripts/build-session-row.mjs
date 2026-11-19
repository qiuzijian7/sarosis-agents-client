/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(plugin, '../..');
const manifest = JSON.parse(readFileSync(resolve(plugin, 'package.json'), 'utf8'));
const { bundled } = JSON.parse(readFileSync(resolve(plugin, '../dsh-compat.json'), 'utf8'));
const modules = resolve(repo, 'dsh-runtime', bundled, 'node_modules');
const upstream = resolve(modules, '@deepseek-ai/dsh-client-ui-workspace');
const official = JSON.parse(readFileSync(resolve(upstream, 'package.json'), 'utf8'));
if (official.version !== bundled) { throw new Error('Official session row version does not match bundled runtime'); }
const outfile = resolve(plugin, 'lib/client.sessionRow.js');
const result = await build({
	entryPoints: [resolve(plugin, 'src/sessionRow.js')],
	outfile,
	bundle: true,
	write: false,
	format: 'cjs',
	platform: 'browser',
	target: 'es2022',
	jsx: 'automatic',
	minify: false,
	minifyWhitespace: true,
	minifySyntax: true,
	minifyIdentifiers: false,
	legalComments: 'inline',
	external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/*', '@deepseek-ai/dsh-client-ui-primitives'],
	nodePaths: [resolve(plugin, 'node_modules'), modules],
	alias: { '@vssaros/official-session-row': resolve(upstream, 'src/client/rows/Rows.tsx') },
	define: { __DSH_SESSION_ROW_VERSION__: JSON.stringify(bundled), 'process.env.NODE_ENV': '"production"' },
	plugins: [{
		name: 'official-css-modules',
		setup(builder) {
			builder.onLoad({ filter: /\.module\.css$/ }, args => ({ contents: readFileSync(args.path, 'utf8'), loader: 'local-css', resolveDir: dirname(args.path) }));
		},
	}],
});
const js = result.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
const artifact = `/* Generated from dsh ${bundled}; run npm run build:session-row in @vssaros/dsh-chat-surface. */\nwindow.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},chunk:"client.sessionRow.js",factory:(require)=>{\nvar module={exports:{}};var exports=module.exports;\nconst rowStyle=document.createElement("style");rowStyle.dataset.vssarosOfficialSessionRow=${JSON.stringify(bundled)};rowStyle.textContent=${JSON.stringify(css)};if(!document.head.querySelector("[data-vssaros-official-session-row]")){document.head.appendChild(rowStyle);}\n${js}\nreturn module.exports;}});\n`;
if (process.argv.includes('--check')) {
	if (readFileSync(outfile, 'utf8') !== artifact) { throw new Error('client.sessionRow.js is stale; rebuild the official session row'); }
} else {
	writeFileSync(outfile, artifact);
}
console.log(`Official session row ${bundled}: ${process.argv.includes('--check') ? 'verified' : 'built'}`);
