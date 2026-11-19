/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Treat a legacy null turn-end reason as unknown metadata, not as a fabricated outcome. */
export function tolerateNullSessionSearchReason(source: string): string {
	const declaration = /^function turnEndText\(reason\) \{\s*(?:if \(reason === null\) return "";\s*)?switch \(reason\.kind\) \{/gm;
	const matches = [...source.matchAll(declaration)];
	if (matches.length !== 1) {
		throw new Error('dsh session search compatibility: unsupported turnEndText source contract');
	}
	if (matches[0][0].includes('if (reason === null) return "";')) {
		return source;
	}
	return source.replace(declaration, text => text.replace('switch (reason.kind)', 'if (reason === null) return "";\n\tswitch (reason.kind)'));
}

/** Patch only the pinned Host query extractor in memory; leave logs and dependency files intact. */
export function renderSessionSearchCompatPreload(version: string): string {
	if (version !== '0.2.2-rc.2') {
		throw new Error('dsh session search compatibility: unsupported runtime version');
	}
	return `import { registerHooks as registerSessionSearchHooks } from 'node:module';
import { readFileSync as readSessionSearchFile } from 'node:fs';
import { dirname as sessionSearchDirname, resolve as sessionSearchResolve } from 'node:path';
import { fileURLToPath as sessionSearchFilePath } from 'node:url';
const tolerateNullSessionSearchReason = ${tolerateNullSessionSearchReason.toString()};
registerSessionSearchHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith('file:') || !sessionSearchFilePath(url).replaceAll('\\\\', '/').endsWith('/@deepseek-ai/dsh-session-query/lib/index.js')) return result;
    const manifest = JSON.parse(readSessionSearchFile(sessionSearchResolve(sessionSearchDirname(sessionSearchFilePath(url)), '../package.json'), 'utf8'));
    if (manifest.name !== '@deepseek-ai/dsh-session-query' || manifest.version !== ${JSON.stringify(version)}) throw new Error('dsh session search compatibility: profile/runtime version mismatch');
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    const patched = tolerateNullSessionSearchReason(source);
    console.info('[vssaros-session-search-compat] null turn-end reason is non-searchable metadata');
    return { ...result, source: patched };
  }
});
`;
}
