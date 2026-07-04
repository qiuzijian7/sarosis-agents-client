/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { memoize } from '../../../base/common/decorators.js';
import { join, resolve } from '../../../base/common/path.js';
import { isLinux } from '../../../base/common/platform.js';
import { createStaticIPCHandle } from '../../../base/parts/ipc/node/ipc.net.js';
import { IEnvironmentService, INativeEnvironmentService } from '../common/environment.js';
import { NativeEnvironmentService } from '../node/environmentService.js';
import { refineServiceDecorator } from '../../instantiation/common/instantiation.js';
import { URI } from '../../../base/common/uri.js';
import { toLocalISOString } from '../../../base/common/date.js';

export const IEnvironmentMainService = refineServiceDecorator<IEnvironmentService, IEnvironmentMainService>(IEnvironmentService);

/**
 * A subclass of the `INativeEnvironmentService` to be used only in electron-main
 * environments.
 */
export interface IEnvironmentMainService extends INativeEnvironmentService {

	// --- backup paths
	readonly backupHome: string;

	// --- V8 code caching
	readonly codeCachePath: string | undefined;
	readonly useCodeCache: boolean;

	// --- IPC
	readonly mainIPCHandle: string;
	readonly mainLockfile: string;

	// --- config
	readonly disableUpdates: boolean;
	readonly isPortable: boolean;

	// TODO@deepak1556 temporary until a real fix lands upstream
	readonly enableRDPDisplayTracking: boolean;

	unsetSnapExportedVariables(): void;
	restoreSnapExportedVariables(): void;
}

export class EnvironmentMainService extends NativeEnvironmentService implements IEnvironmentMainService {

	private _snapEnv: Record<string, string> = {};

	@memoize
	get backupHome(): string { return join(this.userDataPath, 'Backups'); }

	/**
	 * Override logsHome to store ALL VS Code native log files inside the
	 * product directory for packaged EXE releases, using the original VS
	 * Code timestamp sub-directory layout so all native log channels
	 * (main, renderer, editSessions, mcpgateway, network-shared,
	 * remoteTunnelService, sharedprocess, telemetry, terminal,
	 * tunnelHostService, userDataSync, window1/, ...) end up under the
	 * product folder.
	 *
	 * Packaged:
	 *   {productRoot}/logs/20260704T233319/main.log
	 *   {productRoot}/logs/20260704T233319/window1/renderer.log
	 *   {productRoot}/logs/20260704T233319/editSessions.log
	 *   ...
	 *
	 * Dev mode:
	 *   {userDataPath}/logs/{timestamp}/...  (original VS Code behavior)
	 *
	 * Note: appRoot is at {productRoot}/resources/app/out/,
	 * so resolve '..' x3 to reach productRoot.
	 */
	override get logsHome(): URI {
		if (!this.args.logsPath) {
			if (this.isBuilt) {
				// Packaged EXE: VS Code native timestamp subdir under product logs
				// Format matches the parent class: YYYYMMDDTHHMMSSsss
				const key = toLocalISOString(new Date()).replace(/-|:|\.\d+Z$/g, '');
				this.args.logsPath = resolve(this.appRoot, '..', '..', '..', 'logs', key);
			}
			// Dev mode: fall through to parent class (original behavior)
		}
		return super.logsHome;
	}

	@memoize
	get mainIPCHandle(): string { return createStaticIPCHandle(this.userDataPath, 'main', this.productService.version); }

	@memoize
	get mainLockfile(): string { return join(this.userDataPath, 'code.lock'); }

	@memoize
	get disableUpdates(): boolean { return !!this.args['disable-updates']; }

	@memoize
	get isPortable(): boolean { return !!process.env['VSCODE_PORTABLE']; }

	@memoize
	get crossOriginIsolated(): boolean { return !!this.args['enable-coi']; }

	@memoize
	get enableRDPDisplayTracking(): boolean { return !!this.args['enable-rdp-display-tracking']; }

	@memoize
	get codeCachePath(): string | undefined { return process.env['VSCODE_CODE_CACHE_PATH'] || undefined; }

	@memoize
	get useCodeCache(): boolean { return !!this.codeCachePath; }

	unsetSnapExportedVariables() {
		if (!isLinux) {
			return;
		}
		for (const key in process.env) {
			if (key.endsWith('_VSCODE_SNAP_ORIG')) {
				const originalKey = key.slice(0, -17); // Remove the _VSCODE_SNAP_ORIG suffix
				if (this._snapEnv[originalKey]) {
					continue;
				}
				// Preserve the original value in case the snap env is re-entered
				if (process.env[originalKey]) {
					this._snapEnv[originalKey] = process.env[originalKey]!;
				}
				// Copy the original value from before entering the snap env if available,
				// if not delete the env variable.
				if (process.env[key]) {
					process.env[originalKey] = process.env[key];
				} else {
					delete process.env[originalKey];
				}
			}
		}
	}

	restoreSnapExportedVariables() {
		if (!isLinux) {
			return;
		}
		for (const key in this._snapEnv) {
			process.env[key] = this._snapEnv[key];
			delete this._snapEnv[key];
		}
	}
}
