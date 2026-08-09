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
	get backupHome(): string {
		// 多开（--instance <id>）：热退出备份按实例拆分——两实例若共享 Backups，
		// 未保存文件恢复会互相覆盖。
		return this.instanceId ? join(this.userDataPath, 'Backups', 'instances', this.instanceId) : join(this.userDataPath, 'Backups');
	}

	/**
	 * logsHome override — keep VS Code's standard behaviour: all native log
	 * channels (main, renderer, editSessions, mcpgateway, network-shared,
	 * remoteTunnelService, sharedprocess, telemetry, terminal,
	 * tunnelHostService, userDataSync, window1/, ...) live under the user data
	 * directory, which is writable for normal users:
	 *
	 *   {userDataPath}/logs/20260704T233319/main.log
	 *   {userDataPath}/logs/20260704T233319/window1/renderer.log
	 *   {userDataPath}/logs/20260704T233319/editSessions.log
	 *   ...
	 *
	 * (Previously logs were written under the install directory — for an Inno
	 * install that resolves to `Program Files\...\logs`, which regular users
	 * cannot write to. See the old `appRoot/..x3` code.)
	 */
	override get logsHome(): URI {
		if (!this.args.logsPath) {
			const key = toLocalISOString(new Date()).replace(/-|:|\.\d+Z$/g, '');
			// 多开：日志按实例拆分子目录，避免并发写同一 log 文件
			const instanceSeg = this.instanceId ? join('instances', this.instanceId) : '';
			this.args.logsPath = join(this.userDataPath, 'logs', instanceSeg, key);
		}
		return super.logsHome;
	}

	@memoize
	get mainIPCHandle(): string {
		// 多开（--instance <id>）：IPC handle 名加实例前缀——claimInstance 据此认为
		// 管道未被占用，从而允许同数据目录下的第二个独立进程运行。
		// 实例 1（无 --instance）的 handle 与改造前完全一致（向后兼容既有转发逻辑）。
		const channel = this.instanceId ? `${this.instanceId}-main` : 'main';
		return createStaticIPCHandle(this.userDataPath, channel, this.productService.version);
	}

	@memoize
	get mainLockfile(): string {
		// 多开：lockfile 按实例命名（记录各实例 PID，互不覆盖）
		return this.instanceId ? join(this.userDataPath, `code-${this.instanceId}.lock`) : join(this.userDataPath, 'code.lock');
	}

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
