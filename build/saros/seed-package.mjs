/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs';
import path from 'node:path';
import * as tar from 'tar';

export const SEED_GENERATOR_REVISION = 4;
export const UNSCOPED_SEED_PLUGINS = Object.freeze(['dsh-ego-browser', 'dsh-vision-router', 'dsh-better-sidebar']);
export const SEED_PATH_FILES = Object.freeze(['package.json', 'pnpm-lock.yaml', 'node_modules/.pnpm/lock.yaml']);

export function relativizeSeedPaths(profileDir) {
	const prefix = profileDir.replace(/\\/g, '/');
	let rewritten = 0;
	for (const relative of SEED_PATH_FILES) {
		const file = path.join(profileDir, relative);
		if (!fs.existsSync(file)) { continue; }
		const text = fs.readFileSync(file, 'utf8');
		const fixed = text.replaceAll(`file:${prefix}/`, 'file:');
		if (fixed !== text) { fs.writeFileSync(file, fixed, 'utf8'); rewritten++; }
	}
	return rewritten;
}

export function isRepoSeedPlugin(name) {
	return typeof name === 'string' && (name.startsWith('@vssaros/') || name.startsWith('@tt-a1i/') || UNSCOPED_SEED_PLUGINS.includes(name));
}

/** Keep the directory's complete payload, not npm's publish whitelist; skip only development node_modules. */
export async function archiveSeedPlugin(source, destination) {
	const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
	if (!manifest.name || !manifest.version || !path.isAbsolute(source) || !path.isAbsolute(destination)) { throw new Error('Invalid seed package source/destination'); }
	if (fs.existsSync(destination)) { throw new Error('Seed package archive already exists'); }
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	await tar.c({
		cwd: source, file: destination, gzip: true, portable: true, prefix: 'package', follow: false,
		filter: entry => !entry.split(/[\\/]/).includes('node_modules'),
	}, ['.']);
	let packageFound = false;
	await tar.t({ file: destination, onReadEntry: entry => { if (entry.path === 'package/package.json' || entry.path === 'package/./package.json') { packageFound = true; } } });
	if (!packageFound) { throw new Error('Seed archive is missing package/package.json'); }
	return destination;
}
