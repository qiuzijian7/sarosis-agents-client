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
				// Standard esbuild extensions need a separate type check step
				...getBuildRootsForExtension(extensionPath).map(root => typeCheckExtensionStream(root, forWeb)),
			)
			// Extensions with their own build system (e.g. .esbuild.mts) handle type checking internally
			: fromLocalEsbuild(extensionPath, esbuildConfigFileName);
		isBundled = true;
	} else {
		input = fromLocalNormal(extensionPath);
	}

	return updateExtensionPackageJSON(input, data => {
		delete data.scripts;
		delete data.devDependencies;
		if (data.main && isBundled) {
			// esbuild extensions bundle everything into a single file but
			// vsce (the marketplace packaging tool) only respects the `main`
			// field if it points to an existing file. For esbuild extensions,
			// the `main` field points to uncompiled source that no longer
			// exists after bundling, so we clear it.
			delete data.main;
		}
		return data;
	});
}

function typeCheckExtensionStream(tsconfigPath: string, forWeb: boolean): Stream {
	// Skip tsgo type checking for web build (will be done in a separate step)
	if (forWeb) {
		return es.through();
	}
	return createTsgoStream({
		tsconfigPath,
		projectRoot: root,
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

	const child = cp.fork(
		path.join(import.meta.dirname, 'esbuild-runner.mjs'),
		args,
		{
			env: { ...process.env, FORCE_COLOR: '1' },
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
			silent: true
		}
	);

	let hasError = false;

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
			result.end();
		} else if (!hasError) {
			result.emit('error', new Error(`esbuild exited with code ${code}`));
		}
	});

	return result;
}

function fromLocalNormal(extensionPath: string): Stream {
	const vsce = require('@vscode/vsce') as typeof import('@vscode/vsce');
	const result = es.through();

	vsce.listFiles({ cwd: extensionPath, packageManager: vsce.PackageManager.Npm })
		.then(fileNames => {
			const files = fileNames
				.map(fileName => path.join(extensionPath, fileName))
				.map(filePath => new File({
					path: filePath,
					stat: fs.statSync(filePath),
					base: extensionPath,
					contents: fs.createReadStream(filePath)
				}));

			es.readArray(files).pipe(result);
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
		return es.through();
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
			return es.through();
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

		return fromGithub(extension);
	});

	return es.merge(streams.filter((s): s is Stream => s !== null));
}

function fromGithub(extension: IExtensionDefinition): Stream {
	const { name, version, repo, sha256 } = extension;
	fancyLog('Downloading extension from GitHub:', ansiColors.yellow(`${name}@${version}`), '...');

	const assetName = `${name}-${version}.vsix`;
	const url = `${repo}/releases/download/v${version}/${assetName}`;

	const headers: Record<string, string> = {
		...baseHeaders,
		Accept: 'application/octet-stream',
	};
	if (process.env['GITHUB_TOKEN']) {
		headers.Authorization = `Bearer ${process.env['GITHUB_TOKEN']}`;
	}

	return fetchUrls([''], {
		base: url,
		nodeFetchOptions: { headers },
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

function packageNonNativeLocalExtensionsStream(forWeb: boolean, disableMangle: boolean): Stream {
	return doPackageLocalExtensionsStream(forWeb, disableMangle, false);
}

function packageNativeLocalExtensionsStream(forWeb: boolean, disableMangle: boolean): Stream {
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
		es.merge(
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

	return es.merge(
		...localExtensionsDescriptions.map(extension => {
			return fromLocal(extension.path, forWeb, disableMangle)
				.pipe(rename(p => p.dirname = `extensions/${extension.name}/${p.dirname}`));
		})
	);
}
