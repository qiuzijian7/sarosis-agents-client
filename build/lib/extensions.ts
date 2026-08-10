/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import es from 'event-stream';
import fs from 'fs';
import cp from 'child_process';
import glob from 'glob';
import gulp from 'gulp';
import path from 'path';
import crypto from 'crypto';
import { Stream } from 'stream';
import File from 'vinyl';
import { createStatsStream } from './stats.ts';
import * as util2 from './util.ts';
import filter from 'gulp-filter';
import rename from 'gulp-rename';
import fancyLog from 'fancy-log';
import ansiColors from 'ansi-colors';
import buffer from 'gulp-buffer';
import * as jsoncParser from 'jsonc-parser';
import { getProductionDependencies } from './dependencies.ts';
import { type IExtensionDefinition, getExtensionStream } from './builtInExtensions.ts';
import { fetchUrls, fetchGithub } from './fetch.ts';
import { createTsgoStream, spawnTsgo } from './tsgo.ts';
import vzip from 'gulp-vinyl-zip';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const root = path.dirname(path.dirname(import.meta.dirname));
// const commit = getVersion(root);
// const sourceMappingURLBase = `https://main.vscode-cdn.net/sourcemaps/${commit}`;

function minifyExtensionResources(input: Stream): Stream {
	const jsonFilter = filter(['**/*.json', '**/*.code-snippets'], { restore: true });
	return input
		.pipe(jsonFilter)
		.pipe(buffer())
		.pipe(es.mapSync((f: File) => {
			const errors: jsoncParser.ParseError[] = [];
			const value = jsoncParser.parse(f.contents!.toString('utf8'), errors, { allowTrailingComma: true });
			if (errors.length === 0) {
				// file parsed OK => just stringify to drop whitespace and comments
				f.contents = Buffer.from(JSON.stringify(value));
			}
			return f;
		}))
		.pipe(jsonFilter.restore);
}

function updateExtensionPackageJSON(input: Stream, update: (data: any) => any): Stream {
	const packageJsonFilter = filter('extensions/*/package.json', { restore: true });
	return input
		.pipe(packageJsonFilter)
		.pipe(buffer())
		.pipe(es.mapSync((f: File) => {
			const data = JSON.parse(f.contents!.toString('utf8'));
			f.contents = Buffer.from(JSON.stringify(update(data)));
			return f;
		}))
		.pipe(packageJsonFilter.restore);
}

function fromLocal(extensionPath: string, forWeb: boolean, _disableMangle: boolean): Stream {

	let esbuildConfigFileName = forWeb
		? 'esbuild.browser.mts'
		: 'esbuild.mts';

	let hasEsbuild = fs.existsSync(path.join(extensionPath, esbuildConfigFileName));

	// Fallback: check for .esbuild.mts/.esbuild.ts (used by extensions with their own build system, e.g. copilot)
	if (!hasEsbuild && !forWeb) {
		for (const fallback of ['.esbuild.mts', '.esbuild.ts']) {
			if (fs.existsSync(path.join(extensionPath, fallback))) {
				esbuildConfigFileName = fallback;
				hasEsbuild = true;
				break;
			}
		}
	}

	let input: Stream;
	let isBundled = false;

	if (hasEsbuild) {
		const isStandardEsbuild = !esbuildConfigFileName.startsWith('.');
		input = isStandardEsbuild
			? es.merge(
				fromLocalEsbuild(extensionPath, esbuildConfigFileName),
				// Also collect the extension files (dist, chat-webview-out, etc.)
				// so that webview bundles and other assets are included in the package.
				fromLocalNormal(extensionPath, false),
				// Standard esbuild extensions need a separate type check step
				...getBuildRootsForExtension(extensionPath).map(root => typeCheckExtensionStream(root, forWeb)),
			)
			// Extensions with their own build system (e.g. .esbuild.mts) handle type checking internally
			: es.merge(
				fromLocalEsbuild(extensionPath, esbuildConfigFileName),
				fromLocalNormal(extensionPath, false),
			);
		isBundled = true;
	} else {
		input = fromLocalNormal(extensionPath, true);
	}

	return updateExtensionPackageJSON(input, data => {
		delete data.scripts;
		delete data.devDependencies;
		if (data.main && isBundled) {
			// esbuild extensions bundle the extension host entry into dist/;
			// rewrite `main` from the tsc dev output (out/) to the bundled
			// output (dist/) so the desktop extension host can load it.
			// (Upstream VS Code uses the same replace; deleting `main` here
			// left the packaged extension with no entry point and broke
			// activation → "command ... not found".)
			data.main = data.main.replace('/out/', '/dist/');
		}
		return data;
	});
}

function typeCheckExtensionStream(tsconfigPath: string, forWeb: boolean): Stream {
	// Skip tsgo type checking for web build (will be done in a separate step)
	if (forWeb) {
		return es.readArray([]);
	}
	return createTsgoStream(tsconfigPath, {
		taskName: `typechecking extension (tsgo)`,
		noEmit: true,
});
}

function getBuildRootsForExtension(extensionPath: string): string[] {
	const tsconfigFiles = glob.sync('{src/**,*/,}tsconfig.json', { cwd: extensionPath, ignore: '**/node_modules/**' });
	return tsconfigFiles
		.map(file => path.join(extensionPath, file))
		.filter(filePath => {
			try {
				const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
				return config.compilerOptions && config.compilerOptions.noEmit !== true;
			} catch {
				return false;
			}
		});
}

function fromLocalEsbuild(extensionPath: string, esbuildConfigFileName: string): Stream {
	const esbuildConfigPath = path.join(extensionPath, esbuildConfigFileName);
	const result = es.through();

	const args = [
		esbuildConfigPath,
		`--rootDirName=extensions/${path.basename(extensionPath)}`
	];

	let hasError = false;

	function runEsbuild(configPath: string, onDone: () => void) {
		const child = cp.fork(
			path.join(import.meta.dirname, 'esbuild-runner.mjs'),
			[configPath, ...args.slice(1)],
			{
				env: { ...process.env, FORCE_COLOR: '1' },
				stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
				silent: true
			}
		);

		child.stdout?.on('data', (data) => {
			process.stdout.write(data);
		});

		child.stderr?.on('data', (data) => {
			process.stderr.write(data);
		});

		child.on('error', (err: Error & { code?: string }) => {
			hasError = true;
			result.emit('error', err);
		});

		child.on('exit', (code: number) => {
			if (code === 0 && !hasError) {
				onDone();
			} else if (!hasError) {
				result.emit('error', new Error(`esbuild exited with code ${code}`));
			}
		});
	}

	// Run main esbuild config, then optionally run esbuild.webview.mts if present
	runEsbuild(esbuildConfigPath, () => {
		const webviewConfigPath = path.join(extensionPath, 'esbuild.webview.mts');
		if (fs.existsSync(webviewConfigPath)) {
			runEsbuild(webviewConfigPath, () => {
				result.end();
			});
		} else {
			result.end();
		}
	});

	return result;
}

function walkFiles(dir: string): string[] {
	const out: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkFiles(full));
		} else if (entry.isFile()) {
			out.push(full);
		}
	}
	return out;
}

function fromLocalNormal(extensionPath: string, restoreProductionDependencies = false): Stream {
	const vsce = require('@vscode/vsce') as typeof import('@vscode/vsce');
	const result = es.through();

	vsce.listFiles({
		cwd: extensionPath,
		// PackageManager.None tells vsce to skip its production-dependency
		// enumeration (`npm list --production`). That result is discarded below
		// anyway: node_modules is filtered out (these local extensions are fully
		// bundled via esbuild/vite and ship no node_modules), and
		// updateExtensionPackageJSON strips dependencies. The npm list call is
		// strict — it aborts the whole build with ELSPROBLEMS on any missing /
		// extraneous / invalid dep (e.g. copilot's `tslib` peer dep, which
		// legacy-peer-deps skips installing) — for zero benefit. Verified: with
		// None, vsce returns the extension's own files only (no node_modules),
		// which is exactly what the node_modules filter below keeps.
		packageManager: vsce.PackageManager.None,
	})
		.then(fileNames => {
			const files = fileNames
				.filter(fileName => !fileName.startsWith('node_modules') && !fileName.includes('/node_modules/'))
				.map(fileName => path.join(extensionPath, fileName))
				.filter(filePath => {
					// Filter out directories — vsce may list them, but fs.createReadStream
					// throws EISDIR on directories
					try {
						return fs.statSync(filePath).isFile();
					} catch {
						return false;
					}
				});

			let allFiles: string[];
			if (restoreProductionDependencies) {
				// Restore production dependencies for tsc-compiled extensions that
				// declare runtime deps (e.g. git's @vscode/fs-copyfile). Upstream VS Code
				// enumerates these via vsce with PackageManager.Npm; we switched to
				// PackageManager.None to avoid npm ls on bundled/esbuild extensions, so we
				// recover them explicitly here for the tsc branch only.
				const productionDependencyFiles = getProductionDependencies(extensionPath).flatMap(dep => {
					const relative = path.relative(extensionPath, dep);
					return walkFiles(dep).map(f => path.join('node_modules', relative, path.relative(dep, f)));
				});
				allFiles = [...files, ...productionDependencyFiles];
			} else {
				allFiles = files;
			}

			// Push files one-by-one with backpressure to avoid EMFILE
			// when packaging large extensions with many files.
			let i = 0;
			function pushNext() {
				if (i >= allFiles.length) {
					result.end();
					return;
				}
				const filePath = allFiles[i++];
				const file = new File({
					path: filePath,
					stat: fs.statSync(filePath),
					base: extensionPath,
					contents: fs.createReadStream(filePath)
				});
				// Respect stream backpressure: if the writable can't accept
				// more data, wait for 'drain' before pushing the next file.
				if (!result.write(file)) {
					result.once('drain', () => setImmediate(pushNext));
				} else {
					setImmediate(pushNext);
				}
			}
			pushNext();
		})
		.catch(err => result.emit('error', err));

	return result.pipe(createStatsStream(path.basename(extensionPath)));
}

const baseHeaders = {
	'X-Market-Client-Id': 'VSCode Build',
	'User-Agent': 'VSCode Build',
};

function fromMarketplace(serviceUrl: string, { name: extensionName, version, sha256, metadata, platforms }: IExtensionDefinition): Stream {
	const url = `${serviceUrl}/publishers/${metadata!.publisherId!.publisherName}/vsextensions/${extensionName}/${version}/vspackage`;
	fancyLog('Downloading extension:', ansiColors.yellow(`${extensionName}@${version}`), '...');

	const options = {
		base: url,
		headers: baseHeaders,
		retries: 3,
		checksumSha256: sha256
	};

	// Filter out files that are not for the target platform
	const platformFilter = util2.filter((data) => {
		if (!platforms || platforms.length === 0) {
			return true;
		}

		// All platforms list (taken from VS Code's packaging)
		const allPlatforms = ['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'linux-armhf', 'alpine-x64', 'alpine-arm64', 'darwin-x64', 'darwin-arm64'];
		const filePath = data.path;

		// Check if the file has a platform directory
		for (const p of allPlatforms) {
			if (filePath.includes(`/bin/${p}/`) || filePath.includes(`\\bin\\${p}\\`)) {
				return platforms.includes(p);
			}
		}

		return true;
	});

	const packageJsonFilter = filter(['**/package.json'], { restore: true });

	return fetchUrls(options)
		.pipe(platformFilter)
		.pipe(packageJsonFilter)
		.pipe(buffer())
		.pipe(es.mapSync((f: File) => {
			// Filter unnecessary fields from package.json
			const data = JSON.parse(f.contents!.toString('utf8'));
			delete data.scripts;
			delete data.devDependencies;
			f.contents = Buffer.from(JSON.stringify(data));
			return f;
		}))
		.pipe(packageJsonFilter.restore)
		// Archive extensions slightly so they can be properly unarchived later
		.pipe(vzip.src())
		.pipe(filter('extension/**', { dot: true }))
		.pipe(rename(p => p.dirname = p.dirname!.replace(/^extension\/?/, '')));
}

function fromMarketplaceOrGithub(extension: IExtensionDefinition): Stream {
	const { name, platforms } = extension;

	// Check if GITHUB_TOKEN is available; if not, skip GitHub-only extensions
	const hasGithubToken = !!process.env['GITHUB_TOKEN'];
	const hasMarketplaceServiceUrl = !!process.env['VSCODE_MARKETPLACE_SERVICE_URL'] || !!process.env['MARKETPLACE_SERVICE_URL'];

	// Some extensions (like js-debug) are only available via GitHub and have no marketplace entry
	const isGitHubOnly = !extension.metadata && !!extension.repo;
	if (isGitHubOnly && !hasGithubToken) {
		fancyLog(`Skipping GitHub-only extension (no GITHUB_TOKEN):`, ansiColors.yellow(name));
		return es.readArray([]);
	}

	// Try marketplace first if service URL is available
	if (hasMarketplaceServiceUrl && extension.metadata) {
		const serviceUrl = process.env['VSCODE_MARKETPLACE_SERVICE_URL'] || process.env['MARKETPLACE_SERVICE_URL'];
		return fromMarketplace(serviceUrl!, extension);
	}

	// Fall back to GitHub
	if (extension.repo) {
		return fromGithub(extension);
	}

	// Local extension (built from source)
	fancyLog('Using local extension source:', ansiColors.yellow(`${name}@${extension.version}`));
	return fromLocal(path.join(root, 'extensions', name), false, false);
}

export function packageMarketplaceExtensionsStream(forWeb: boolean): Stream {
	const hasGithubToken = !!process.env['GITHUB_TOKEN'];
	const hasMarketplaceServiceUrl = !!process.env['VSCODE_MARKETPLACE_SERVICE_URL'] || !!process.env['MARKETPLACE_SERVICE_URL'];

	const streams = builtInExtensions.map(extension => {
		if (!extension.metadata && !extension.repo) {
			return fromLocal(path.join(root, 'extensions', extension.name), forWeb, false);
		}

		// Skip GitHub-only extensions when no token
		if (!extension.metadata && extension.repo && !hasGithubToken) {
			fancyLog(`Skipping GitHub-only extension (no GITHUB_TOKEN):`, ansiColors.yellow(extension.name));
			return es.readArray([]);
		}

		if (hasMarketplaceServiceUrl && extension.metadata) {
			const serviceUrl = process.env['VSCODE_MARKETPLACE_SERVICE_URL'] || process.env['MARKETPLACE_SERVICE_URL'];
			return fromMarketplace(serviceUrl!, extension);
		}

		// Extensions with metadata but no GitHub repo (e.g. tdb-am-gateway) → local
		if (extension.metadata && !extension.repo) {
			fancyLog('No GitHub repo configured, using local extension source:', ansiColors.yellow(`${extension.name}@${extension.version}`));
			return fromLocal(path.join(root, 'extensions', extension.name), forWeb, false);
		}

		// Skip GitHub extensions when no token (also covers extensions with metadata + repo)
		if (extension.repo && !hasGithubToken) {
			fancyLog(`Skipping GitHub extension (no GITHUB_TOKEN):`, ansiColors.yellow(extension.name));
			return es.readArray([]);
		}

		return fromGithub(extension);
	});

	return es.merge(streams.filter((s): s is Stream => s !== null));
}

function fromGithub(extension: IExtensionDefinition): Stream {
	const { name, version, repo, sha256 } = extension;
	fancyLog('Downloading extension from GitHub:', ansiColors.yellow(`${name}@${version}`), '...');

	// Extract owner/repo from full GitHub URL (e.g. https://github.com/microsoft/vscode-js-debug → microsoft/vscode-js-debug)
	const repoPath = repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');

	// Match VSIX asset by name (flexible: handles different naming conventions)
	const assetName = `${name}-${version}.vsix`;

	return fetchGithub(repoPath, {
		version,
		name: (n: string) => n === assetName || (n.endsWith('.vsix') && n.includes(name)),
		checksumSha256: sha256
	})
		.pipe(vzip.src())
		.pipe(filter('extension/**', { dot: true }))
		.pipe(rename(p => p.dirname = p.dirname!.replace(/^extension\/?/, '')));
}

const nativeExtensions = [
	'git',
];

const excludedExtensions = [
	'copilot',
	'vscode-api-tests',
	'vscode-colorize-tests',
	'vscode-colorize-perf-tests',
	'vscode-test-resolver',
	'ms-vscode.node-debug',
	'ms-vscode.node-debug2',
];

const marketplaceWebExtensionsExclude = new Set([
	'ms-vscode.node-debug',
	'ms-vscode.node-debug2',
	'ms-vscode.js-debug-companion',
	'ms-vscode.js-debug',
	'ms-vscode.vscode-js-profile-table'
]);

const productJson = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../product.json'), 'utf8'));
const builtInExtensions: IExtensionDefinition[] = productJson.builtInExtensions || [];
const webBuiltInExtensions: IExtensionDefinition[] = productJson.webBuiltInExtensions || [];

type ExtensionKind = 'ui' | 'workspace' | 'web';
export interface IExtensionManifest {
	main?: string;
	browser?: string;
	type?: ExtensionKind;
	capabilities?: {
		virtualWorkspaces?: ExtensionKind | boolean;
		untrustedWorkspaces?: { supported: ExtensionKind | boolean; description?: string } | { description?: string };
	};
}

export interface IScannedBuiltinExtension {
	extensionPath: string;
	packageJSON: any;
	packageNLS: any | undefined;
	readmePath: string | undefined;
	changelogPath: string | undefined;
}

export function isWebExtension(manifest: IExtensionManifest): boolean {
	// Copilot extension always gets packaged for desktop AND web
	if (manifest.name === 'copilot') {
		return true;
	}

	const webUISupported = typeof manifest.browser === 'string';
	if (!webUISupported) {
		return false;
	}

	if (manifest.capabilities?.virtualWorkspaces === 'limited' || manifest.capabilities?.virtualWorkspaces === false) {
		return false;
	}

	if (manifest.capabilities?.untrustedWorkspaces?.supported === 'limited' || manifest.capabilities?.untrustedWorkspaces?.supported === false) {
		return false;
	}

	return true;
}

export function packageNonNativeLocalExtensionsStream(forWeb: boolean, disableMangle: boolean): Stream {
	return doPackageLocalExtensionsStream(forWeb, disableMangle, false);
}

export function packageNativeLocalExtensionsStream(forWeb: boolean, disableMangle: boolean): Stream {
	return doPackageLocalExtensionsStream(forWeb, disableMangle, true);
}

export function packageAllLocalExtensionsStream(forWeb: boolean, disableMangle: boolean): Stream {
	return es.merge([
		packageNonNativeLocalExtensionsStream(forWeb, disableMangle),
		packageNativeLocalExtensionsStream(forWeb, disableMangle)
	]);
}

/**
 * @param forWeb build the extensions that have web targets
 * @param disableMangle disable the mangler
 * @param native build the extensions that are marked as having native dependencies
 */
function doPackageLocalExtensionsStream(forWeb: boolean, disableMangle: boolean, native: boolean): Stream {
	const nativeExtensionsSet = new Set(nativeExtensions);
	const localExtensionsDescriptions = (
		(glob.sync('extensions/*/package.json') as string[])
			.map(manifestPath => {
				const absoluteManifestPath = path.join(root, manifestPath);
				const extensionPath = path.dirname(path.join(root, manifestPath));
				const extensionName = path.basename(extensionPath);
				return { name: extensionName, path: extensionPath, manifestPath: absoluteManifestPath };
			})
			.filter(({ name }) => native ? nativeExtensionsSet.has(name) : !nativeExtensionsSet.has(name))
			.filter(({ name }) => excludedExtensions.indexOf(name) === -1)
			.filter(({ name }) => builtInExtensions.every(b => b.name !== name))
			.filter(({ manifestPath }) => (forWeb ? isWebExtension(require(manifestPath)) : true))
	);
	const localExtensionsStream = minifyExtensionResources(
		es.concat(
			...localExtensionsDescriptions.map(extension => {
				return fromLocal(extension.path, forWeb, disableMangle)
					.pipe(rename(p => p.dirname = `extensions/${extension.name}/${p.dirname}`));
			})
		)
	);

	return localExtensionsStream;
}

const userAgentHeaders = {
	'User-Agent': 'VSCode Build',
};

function fetchUrl(url: string, options?: { retries?: number; checksumSha256?: string; headers?: Record<string, string> }): Stream {
	return fetchUrls({
		base: url,
		retries: options?.retries || 3,
		checksumSha256: options?.checksumSha256,
		headers: options?.headers || userAgentHeaders
	});
}

/**
 * Same as `packageAllLocalExtensionsStream` but without minifying the extension resources.
 */
export function packageNonMinifiedLocalExtensionsStream(forWeb: boolean, disableMangle: boolean): Stream {
	const nativeExtensionsSet = new Set(nativeExtensions);
	const localExtensionsDescriptions = (
		(glob.sync('extensions/*/package.json') as string[])
			.map(manifestPath => {
				const absoluteManifestPath = path.join(root, manifestPath);
				const extensionPath = path.dirname(path.join(root, manifestPath));
				const extensionName = path.basename(extensionPath);
				return { name: extensionName, path: extensionPath, manifestPath: absoluteManifestPath };
			})
			.filter(({ name }) => nativeExtensionsSet.has(name))
			.filter(({ name }) => excludedExtensions.indexOf(name) === -1)
			.filter(({ name }) => builtInExtensions.every(b => b.name !== name))
	);

	return es.concat(
		...localExtensionsDescriptions.map(extension => {
			return fromLocal(extension.path, forWeb, disableMangle)
				.pipe(rename(p => p.dirname = `extensions/${extension.name}/${p.dirname}`));
		})
	);
}

/**
 * Package the copilot extension for the build.
 * Copilot is in the excludedExtensions list, so this returns an empty stream.
 */
export function packageCopilotExtensionStream(_forWeb: boolean): Stream {
	return es.readArray([]);
}
