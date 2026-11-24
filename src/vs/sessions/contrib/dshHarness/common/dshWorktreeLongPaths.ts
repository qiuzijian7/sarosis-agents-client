/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Add a command-scoped Git option without changing hooks, sandboxing, or repository config. */
export function enableWorktreeLongPaths(source: string): string {
	const method = /\bgitArgv\(args\)\s*\{\s*return\s*\[\s*this\.config\.gitCommand,([\s\S]*?)\];\s*\}/g;
	const matches = [...source.matchAll(method)];
	if (matches.length !== 1 || !matches[0][1].includes('core.hooksPath=/dev/null') || !matches[0][1].includes('core.fsmonitor=false')) {
		throw new Error('dsh worktree long paths: unsupported gitArgv source contract');
	}
	if (matches[0][1].includes('core.longpaths=true')) {
		return source;
	}
	return source.replace(method, text => text.replace('this.config.gitCommand,', 'this.config.gitCommand,\n\t\t\t"-c",\n\t\t\t"core.longpaths=true",'));
}

/** Load-time compatibility for the pinned official WorktreeService; leaves dependency files untouched. */
export function renderWorktreeLongPathsPreload(version: string, platform: string): string {
	if (platform !== 'win32') {
		return '';
	}
	return `import { registerHooks as registerWorktreeHooks } from 'node:module';
import { readFileSync as readWorktreeFile } from 'node:fs';
import { dirname as worktreeDirname, resolve as worktreeResolve } from 'node:path';
import { fileURLToPath as worktreeFilePath } from 'node:url';
const enableWorktreeLongPaths = ${enableWorktreeLongPaths.toString()};
registerWorktreeHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith('file:') || !worktreeFilePath(url).replaceAll('\\\\', '/').endsWith('/@deepseek-ai/dsh-experimental-worktree/lib/index.js')) return result;
    const manifest = JSON.parse(readWorktreeFile(worktreeResolve(worktreeDirname(worktreeFilePath(url)), '../package.json'), 'utf8'));
    if (manifest.version !== ${JSON.stringify(version)}) {
      console.warn('[vssaros-worktree-compat] profile/runtime version mismatch; skip patch');
      return result;
    }
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    let patched = source;
    try {
      patched = enableWorktreeLongPaths(source);
    } catch (e) {
      console.warn('[vssaros-worktree-compat] source shape changed; skip patch: ' + String(e && e.message ? e.message : e));
      return result;
    }
    if (patched === source) return result;
    console.info('[vssaros-worktree-compat] core.longpaths=true enabled for official worktree');
    return { ...result, source: patched };
  }
});
`;
}
