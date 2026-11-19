/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(plugin, 'package.json'), 'utf8'));
const { bundled } = JSON.parse(readFileSync(resolve(plugin, '../dsh-compat.json'), 'utf8'));
const modules = resolve(plugin, '../../dsh-runtime', bundled, 'node_modules');
const upstream = resolve(modules, '@deepseek-ai/dsh-client-ui-conversation');
const official = JSON.parse(readFileSync(resolve(upstream, 'package.json'), 'utf8'));
if (official.version !== bundled) { throw new Error('Official conversation header version does not match bundled runtime'); }
const outfile = resolve(plugin, 'lib/client.conversationHeader.js');
function replaceOnce(source, before, after) {
	if (source.split(before).length !== 2) { throw new Error(`Official conversation header contract changed: ${before}`); }
	return source.replace(before, after);
}
const result = await build({
	entryPoints: [resolve(plugin, 'src/conversationHeader.js')], outfile,
	bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022',
	jsx: 'automatic', minify: false, minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false, legalComments: 'inline',
	external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/*', '@deepseek-ai/dsh-client-ui-primitives'],
	nodePaths: [resolve(plugin, 'node_modules'), modules],
	alias: { '@vssaros/official-conversation-header': resolve(upstream, 'src/client/skeleton/ConversationHeader.tsx') },
	define: { __DSH_CONVERSATION_HEADER_VERSION__: JSON.stringify(bundled), 'process.env.NODE_ENV': '"production"' },
	plugins: [{
		name: 'resident-header-actions',
		setup(builder) {
			builder.onLoad({ filter: /[\\/]ConversationHeader\.tsx$/ }, args => {
				let source = readFileSync(args.path, 'utf8');
				source = replaceOnce(source, 'data-window-drag>', 'data-window-drag data-vssaros-conversation-header="" style={{ gridTemplateColumns: "auto minmax(0, 1fr) auto" }}>');
				source = replaceOnce(source, "renderSlot('conversation.header.leading'", "renderSlot('vssaros.conversation.header.leading'");
				source = replaceOnce(source, "renderSlot('conversation.session.header'", "renderSlot('vssaros.conversation.session.header'");
				source = replaceOnce(source, '    </header>', `      <div className={css.residentActions} data-vssaros-conversation-header-actions="">
        {renderSlot('vssaros.conversation.header.actions', {})}
        {sessionId !== undefined && <div className={css.residentCorner} data-vssaros-conversation-header-bottom="">
          {renderSlot('vssaros.conversation.header.bottom', {})}
        </div>}
        {sessionId !== undefined && <div className={css.residentCorner} data-conversation-header-corner="">
          {renderSlot('vssaros.conversation.session.header.corner', {})}
        </div>}
      </div>
    </header>`);
				return { contents: source, loader: 'tsx', resolveDir: dirname(args.path) };
			});
			builder.onLoad({ filter: /\.module\.css$/ }, args => {
				let source = readFileSync(args.path, 'utf8');
				if (args.path.endsWith('ConversationRoot.module.css')) {
					source = replaceOnce(source, ':has(.tabs)', ':has([data-conversation-tabs])');
					source += `
.header > :global([data-slot='vssaros.conversation.session.header']) > :first-child { grid-column: 2; grid-row: 1; }
.header > .titleRow { grid-row: 1; }
.residentActions { grid-column: 3; grid-row: 1; display: flex; align-items: center; gap: 8px; min-height: 30px; margin-left: 8px; margin-right: -16px; -webkit-app-region: no-drag; }
.residentCorner { display: flex; align-items: center; }
.residentCorner:not(:has(button)) { display: none; }
.residentActions :global([data-vssaros-new-window]) { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 28px; height: 28px; padding: 0; border: none; border-radius: 50%; background: transparent; color: var(--dsw-alias-label-secondary, currentColor); cursor: pointer; -webkit-app-region: no-drag; }
.residentActions :global([data-vssaros-new-window]):hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.residentActions :global([data-vssaros-new-window]):focus-visible { outline: 1px solid var(--dsw-alias-state-business-primary, currentColor); outline-offset: 2px; }
`;
				}
				return { contents: source, loader: 'local-css', resolveDir: dirname(args.path) };
			});
		},
	}],
});
const js = result.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
const artifact = `/* Generated from dsh ${bundled}; run npm run build:conversation-header in @vssaros/dsh-chat-surface. */\nwindow.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},chunk:"client.conversationHeader.js",factory:(require)=>{\nvar module={exports:{}};var exports=module.exports;\nconst headerStyle=document.createElement("style");headerStyle.dataset.vssarosConversationHeader=${JSON.stringify(bundled)};headerStyle.textContent=${JSON.stringify(css)};if(!document.head.querySelector("[data-vssaros-conversation-header-style]")){headerStyle.setAttribute("data-vssaros-conversation-header-style","");document.head.appendChild(headerStyle);}\n${js}\nreturn module.exports;}});\n`;
if (process.argv.includes('--check')) {
	if (readFileSync(outfile, 'utf8') !== artifact) { throw new Error('client.conversationHeader.js is stale; rebuild the resident conversation header'); }
} else { writeFileSync(outfile, artifact); }
console.log(`Resident conversation header ${bundled}: ${process.argv.includes('--check') ? 'verified' : 'built'}`);
