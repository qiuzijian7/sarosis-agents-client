/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Package Map — 包清单解析（package.json, go.mod, Cargo.toml, pom.xml, requirements.txt）。
 *
 * 对标 codebase-memory-mcp 的 pass_pkgmap.c。
 * 解析项目清单文件，创建 Package 节点和依赖边。
 */

import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';

export interface PackageInfo {
	name: string;
	version: string;
	type: 'npm' | 'go' | 'cargo' | 'maven' | 'pypi' | 'nuget' | 'composer';
	dependencies: { name: string; version: string }[];
	devDependencies?: { name: string; version: string }[];
	filePath: string;
}

const MANIFEST_FILES: { [key: string]: string } = {
	'package.json': 'npm',
	'go.mod': 'go',
	'Cargo.toml': 'cargo',
	'pom.xml': 'maven',
	'requirements.txt': 'pypi',
	'pyproject.toml': 'pypi',
	'packages.config': 'nuget',
	'composer.json': 'composer',
};

export async function scanPackageManifests(
	fileService: IFileService,
	rootUri: URI,
	maxDepth: number = 3
): Promise<PackageInfo[]> {
	const results: PackageInfo[] = [];
	await _scanDir(fileService, rootUri, results, 0, maxDepth);
	return results;
}

async function _scanDir(
	fileService: IFileService,
	dirUri: URI,
	results: PackageInfo[],
	depth: number,
	maxDepth: number
): Promise<void> {
	if (depth > maxDepth) { return; }

	let stat;
	try { stat = await fileService.resolve(dirUri); } catch { return; }
	if (!stat.children) { return; }

	for (const child of stat.children) {
		if (child.name.startsWith('.') || child.name === 'node_modules' || child.name === 'vendor') { continue; }

		if (child.isDirectory) {
			await _scanDir(fileService, child.resource, results, depth + 1, maxDepth);
		} else if (child.isFile) {
			const pkgType = MANIFEST_FILES[child.name];
			if (pkgType) {
				try {
					const content = await fileService.readFile(child.resource);
					const pkg = parseManifest(content.value.toString(), pkgType, child.resource.fsPath);
					if (pkg) { results.push(pkg); }
				} catch { /* ignore parse errors */ }
			}
		}
	}
}

function parseManifest(content: string, type: string, filePath: string): PackageInfo | undefined {
	switch (type) {
		case 'npm': return parseNpm(content, filePath);
		case 'go': return parseGoMod(content, filePath);
		case 'cargo': return parseCargoToml(content, filePath);
		case 'pypi': return parseRequirements(content, filePath);
		default: return undefined;
	}
}

function parseNpm(content: string, filePath: string): PackageInfo {
	const json = JSON.parse(content);
	const deps = Object.entries(json.dependencies || {}).map(([name, version]) => ({ name, version: version as string }));
	const devDeps = Object.entries(json.devDependencies || {}).map(([name, version]) => ({ name, version: version as string }));
	return { name: json.name || 'unnamed', version: json.version || '0.0.0', type: 'npm', dependencies: deps, devDependencies: devDeps, filePath };
}

function parseGoMod(content: string, filePath: string): PackageInfo {
	const lines = content.split('\n');
	let name = 'unnamed';
	const deps: { name: string; version: string }[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith('module ')) { name = trimmed.substring(7).trim(); }
		else if (trimmed.match(/^\s*\S+\s+v\S+/) && !trimmed.startsWith('//')) {
			const parts = trimmed.split(/\s+/);
			if (parts.length >= 2) { deps.push({ name: parts[0], version: parts[1] }); }
		}
	}
	return { name, version: '1.0', type: 'go', dependencies: deps, filePath };
}

function parseCargoToml(content: string, filePath: string): PackageInfo {
	let name = 'unnamed';
	let version = '0.0.0';
	const deps: { name: string; version: string }[] = [];

	const lines = content.split('\n');
	let inDeps = false;
	for (const line of lines) {
		if (line.trim().startsWith('name =')) { name = line.split('"')[1] || name; }
		else if (line.trim().startsWith('version =')) { version = line.split('"')[1] || version; }
		else if (line.trim() === '[dependencies]') { inDeps = true; }
		else if (line.trim().startsWith('[') && inDeps) { inDeps = false; }
		else if (inDeps) {
			const match = line.match(/^(\S+)\s*=\s*"([^"]+)"/);
			if (match) { deps.push({ name: match[1], version: match[2] }); }
		}
	}
	return { name, version, type: 'cargo', dependencies: deps, filePath };
}

function parseRequirements(content: string, filePath: string): PackageInfo {
	const deps: { name: string; version: string }[] = [];
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) { continue; }
		const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*([><=~!]*[\d.]+)/);
		if (match) { deps.push({ name: match[1], version: match[2] }); }
	}
	return { name: 'python-project', version: '0.0.0', type: 'pypi', dependencies: deps, filePath };
}
