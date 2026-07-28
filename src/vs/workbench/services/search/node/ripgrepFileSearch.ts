/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from '../../../../base/common/path.js';
import * as glob from '../../../../base/common/glob.js';
import { normalizeNFD } from '../../../../base/common/normalization.js';
import * as extpath from '../../../../base/common/extpath.js';
import { isMacintosh as isMac } from '../../../../base/common/platform.js';
import * as strings from '../../../../base/common/strings.js';
import { IFileQuery, IFolderQuery } from '../common/search.js';
import { anchorGlob } from './ripgrepSearchUtils.js';
import { rgPath } from '@vscode/ripgrep';

// If @vscode/ripgrep is in an .asar file, then the binary is unpacked.
const rgDiskPath = rgPath.replace(/\bnode_modules\.asar\b/, 'node_modules.asar.unpacked');

/**
 * Whether the ripgrep binary is actually present on disk.
 *
 * In packaged builds the @vscode/ripgrep postinstall script downloads the
 * platform binary from GitHub. When that download fails (e.g. CI without
 * GITHUB_TOKEN, sandboxed environments) the `bin/` directory ends up empty
 * and `rgDiskPath` points at a file that does not exist. Calling
 * `cp.spawn` on it then throws ENOENT and the activity bar search fails.
 *
 * We probe synchronously at module-load time so that callers can route
 * around the missing binary (e.g. fall back to a pure Node walker) without
 * paying the cost of the failed spawn. The result is cached — rg.exe
 * does not materialize at runtime in a packaged app.
 */
export const isRipgrepAvailable: boolean = (() => {
	try {
		return fs.existsSync(rgDiskPath);
	} catch {
		return false;
	}
})();

/**
 * Human-readable hint shown to the user when ripgrep is unavailable.
 * Kept in sync with the build-side `ensureRipgrepBinaryTask` log message.
 */
export const RIPGREP_MISSING_HINT =
	`ripgrep binary not found at ${rgDiskPath}. ` +
	`Activity bar search requires ripgrep. ` +
	`Re-install VsSaros (the build should copy rg.exe into node_modules.asar.unpacked) ` +
	`or copy @vscode/ripgrep/bin/rg[.exe] from a working install into ` +
	`<app>/node_modules.asar.unpacked/@vscode/ripgrep/bin/ manually.`;

export function spawnRipgrepCmd(config: IFileQuery, folderQuery: IFolderQuery, includePattern?: glob.IExpression, excludePattern?: glob.IExpression, numThreads?: number) {
	if (!isRipgrepAvailable) {
		throw new Error(RIPGREP_MISSING_HINT);
	}
	const rgArgs = getRgArgs(config, folderQuery, includePattern, excludePattern, numThreads);
	const cwd = folderQuery.folder.fsPath;
	return {
		cmd: cp.spawn(rgDiskPath, rgArgs.args, { cwd }),
		rgDiskPath,
		siblingClauses: rgArgs.siblingClauses,
		rgArgs,
		cwd
	};
}

function getRgArgs(config: IFileQuery, folderQuery: IFolderQuery, includePattern?: glob.IExpression, excludePattern?: glob.IExpression, numThreads?: number) {
	const args = ['--files', '--hidden', '--case-sensitive', '--no-require-git'];

	if (config.ignoreGlobCase || folderQuery.ignoreGlobCase) {
		args.push('--glob-case-insensitive');
		args.push('--ignore-file-case-insensitive');
	}

	// includePattern can't have siblingClauses
	foldersToIncludeGlobs([folderQuery], includePattern, false).forEach(globArg => {
		const inclusion = anchorGlob(globArg);
		args.push('-g', inclusion);
		if (isMac) {
			const normalized = normalizeNFD(inclusion);
			if (normalized !== inclusion) {
				args.push('-g', normalized);
			}
		}
	});

	const rgGlobs = foldersToRgExcludeGlobs([folderQuery], excludePattern, undefined, false);
	rgGlobs.globArgs.forEach(globArg => {
		const exclusion = `!${anchorGlob(globArg)}`;
		args.push('-g', exclusion);
		if (isMac) {
			const normalized = normalizeNFD(exclusion);
			if (normalized !== exclusion) {
				args.push('-g', normalized);
			}
		}
	});
	if (folderQuery.disregardIgnoreFiles !== false) {
		// Don't use .gitignore or .ignore
		args.push('--no-ignore');
	} else if (folderQuery.disregardParentIgnoreFiles !== false) {
		args.push('--no-ignore-parent');
	}

	// Follow symlinks
	if (!folderQuery.ignoreSymlinks) {
		args.push('--follow');
	}

	if (config.exists) {
		args.push('--quiet');
	}

	if (numThreads) {
		args.push('--threads', `${numThreads}`);
	}

	args.push('--no-config');
	if (folderQuery.disregardGlobalIgnoreFiles) {
		args.push('--no-ignore-global');
	}

	return {
		args,
		siblingClauses: rgGlobs.siblingClauses
	};
}

interface IRgGlobResult {
	globArgs: string[];
	siblingClauses: glob.IExpression;
}

function foldersToRgExcludeGlobs(folderQueries: IFolderQuery[], globalExclude?: glob.IExpression, excludesToSkip?: Set<string>, absoluteGlobs = true): IRgGlobResult {
	const globArgs: string[] = [];
	let siblingClauses: glob.IExpression = {};
	folderQueries.forEach(folderQuery => {
		const totalExcludePattern = Object.assign({}, folderQuery.excludePattern || {}, globalExclude || {});
		const result = globExprsToRgGlobs(totalExcludePattern, absoluteGlobs ? folderQuery.folder.fsPath : undefined, excludesToSkip);
		globArgs.push(...result.globArgs);
		if (result.siblingClauses) {
			siblingClauses = Object.assign(siblingClauses, result.siblingClauses);
		}
	});

	return { globArgs, siblingClauses };
}

function foldersToIncludeGlobs(folderQueries: IFolderQuery[], globalInclude?: glob.IExpression, absoluteGlobs = true): string[] {
	const globArgs: string[] = [];
	folderQueries.forEach(folderQuery => {
		const totalIncludePattern = Object.assign({}, globalInclude || {}, folderQuery.includePattern || {});
		const result = globExprsToRgGlobs(totalIncludePattern, absoluteGlobs ? folderQuery.folder.fsPath : undefined);
		globArgs.push(...result.globArgs);
	});

	return globArgs;
}

function globExprsToRgGlobs(patterns: glob.IExpression, folder?: string, excludesToSkip?: Set<string>): IRgGlobResult {
	const globArgs: string[] = [];
	const siblingClauses: glob.IExpression = {};
	Object.keys(patterns)
		.forEach(key => {
			if (excludesToSkip && excludesToSkip.has(key)) {
				return;
			}

			if (!key) {
				return;
			}

			const value = patterns[key];
			key = trimTrailingSlash(folder ? getAbsoluteGlob(folder, key) : key);

			// glob.ts requires forward slashes, but a UNC path still must start with \\
			// #38165 and #38151
			if (key.startsWith('\\\\')) {
				key = '\\\\' + key.substr(2).replace(/\\/g, '/');
			} else {
				key = key.replace(/\\/g, '/');
			}

			if (typeof value === 'boolean' && value) {
				if (key.startsWith('\\\\')) {
					// Absolute globs UNC paths don't work properly, see #58758
					key += '**';
				}

				globArgs.push(fixDriveC(key));
			} else if (value && value.when) {
				siblingClauses[key] = value;
			}
		});

	return { globArgs, siblingClauses };
}

/**
 * Resolves a glob like "node_modules/**" in "/foo/bar" to "/foo/bar/node_modules/**".
 * Special cases C:/foo paths to write the glob like /foo instead - see https://github.com/BurntSushi/ripgrep/issues/530.
 *
 * Exported for testing
 */
export function getAbsoluteGlob(folder: string, key: string): string {
	return path.isAbsolute(key) ?
		key :
		path.join(folder, key);
}

function trimTrailingSlash(str: string): string {
	str = strings.rtrim(str, '\\');
	return strings.rtrim(str, '/');
}

export function fixDriveC(path: string): string {
	const root = extpath.getRoot(path);
	return root.toLowerCase() === 'c:/' ?
		path.replace(/^c:[/\\]/i, '/') :
		path;
}
