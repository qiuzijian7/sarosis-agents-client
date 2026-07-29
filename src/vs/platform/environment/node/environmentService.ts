/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { homedir, tmpdir } from 'os';
import { existsSync, mkdirSync, readdirSync, cpSync, writeFileSync } from 'fs';
import { NativeParsedArgs } from '../common/argv.js';
import { IDebugParams } from '../common/environment.js';
import { AbstractNativeEnvironmentService, parseDebugParams } from '../common/environmentService.js';
import { getUserDataPath, getLegacyDefaultUserDataPath } from './userDataPath.js';
import { IProductService } from '../../product/common/productService.js';
import { INodeProcess } from '../../../base/common/platform.js';
import { join } from '../../../base/common/path.js';
import { env } from '../../../base/common/process.js';

export class NativeEnvironmentService extends AbstractNativeEnvironmentService {

	constructor(args: NativeParsedArgs, productService: IProductService) {
		const homeDir = homedir();
		const userDataDir = getUserDataPath(args, productService.dataFolderName);
		// One-time best-effort migration of data from the legacy (app-data
		// based) location to the new home-based `dataFolderName` layout
		// (`~/.vssaros`). Never blocks startup and never throws.
		migrateLegacyUserDataDir(userDataDir, getLegacyDefaultUserDataPath(productService.nameShort), isEmbeddedApp());
		super(args, {
			homeDir,
			tmpDir: tmpdir(),
			userDataDir,
			parentAppUserDataDir: getParentAppUserDataDir(args, productService),
			parentAppUserHomeDir: getParentAppUserHomeDir(homeDir, productService)
		}, productService, isEmbeddedApp());
	}
}

/**
 * Merges the contents of the legacy user data directory into the new
 * home-based one on first run. Best-effort only: any error is swallowed and a
 * marker file is written so the work is not repeated.
 */
function migrateLegacyUserDataDir(newDir: string, legacyDir: string, embedded: boolean): void {
	if (embedded || !legacyDir || legacyDir === newDir || !existsSync(legacyDir)) {
		return;
	}
	try {
		if (!existsSync(newDir)) {
			mkdirSync(newDir, { recursive: true });
		}
		const marker = join(legacyDir, '.vssaros-migrated');
		if (existsSync(marker)) {
			return;
		}
		for (const entry of readdirSync(legacyDir)) {
			if (entry === marker) {
				continue;
			}
			const src = join(legacyDir, entry);
			const dst = join(newDir, entry);
			if (!existsSync(dst)) {
				cpSync(src, dst, { recursive: true });
			}
		}
		writeFileSync(marker, '');
	} catch (err) {
		// Best-effort: never block startup on migration errors.
		console.error('[VsSaros] Failed to migrate legacy user data:', err);
	}
}

export function parsePtyHostDebugPort(args: NativeParsedArgs, isBuilt: boolean): IDebugParams {
	return parseDebugParams(args['inspect-ptyhost'], args['inspect-brk-ptyhost'], 5877, isBuilt, args.extensionEnvironment);
}

export function parseAgentHostDebugPort(args: NativeParsedArgs, isBuilt: boolean): IDebugParams {
	return parseDebugParams(args['inspect-agenthost'], args['inspect-brk-agenthost'], 5878, isBuilt, args.extensionEnvironment);
}

export function parseSharedProcessDebugPort(args: NativeParsedArgs, isBuilt: boolean): IDebugParams {
	return parseDebugParams(args['inspect-sharedprocess'], args['inspect-brk-sharedprocess'], 5879, isBuilt, args.extensionEnvironment);
}


function getParentAppUserDataDir(args: NativeParsedArgs, productService: IProductService): string | undefined {
	if (!(process as INodeProcess).isEmbeddedApp) {
		return undefined;
	}
	if (env['VSCODE_DEV']) {
		return undefined;
	}
	const quality = productService.quality;
	let hostProductName: string;
	if (quality === 'stable') {
		hostProductName = 'Code';
	} else if (quality === 'insider') {
		hostProductName = 'Code - Insiders';
	} else if (quality === 'exploration') {
		hostProductName = 'Code - Exploration';
	} else {
		return undefined;
	}

	// Honor the same env-var overrides that the host VS Code itself uses
	// (portable mode and VSCODE_APPDATA), but intentionally skip --user-data-dir
	// because that CLI arg belongs to the Agents app, not the host.
	const hostUserDataPath = getUserDataPath(args, hostProductName);
	return join(hostUserDataPath, 'User');
}

function getParentAppUserHomeDir(homeDir: string, productService: IProductService): string | undefined {
	if (!(process as INodeProcess).isEmbeddedApp) {
		return undefined;
	}
	if (env['VSCODE_DEV']) {
		return undefined;
	}
	const quality = productService.quality;
	let hostDataFolderName: string;
	if (quality === 'stable') {
		hostDataFolderName = '.vscode';
	} else if (quality === 'insider') {
		hostDataFolderName = '.vscode-insiders';
	} else if (quality === 'exploration') {
		hostDataFolderName = '.vscode-exploration';
	} else {
		return undefined;
	}
	return join(homeDir, hostDataFolderName);
}

function isEmbeddedApp(): boolean {
	return !!(process as INodeProcess).isEmbeddedApp;
}
