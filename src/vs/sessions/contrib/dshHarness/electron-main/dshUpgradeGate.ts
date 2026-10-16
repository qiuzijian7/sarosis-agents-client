/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 升级闸门（方案第 3.3 节）：运行中任务检查 → 停 Host → 快照 → 切换指针 → 启动 → 健康检查 → 失败自动回退。
 *
 * 快照只覆盖可能被新版本迁移的数据：`profiles/<profile>`、`sessions`、`storages`。
 * **不复制凭证**（`.credentials.yaml`）：升级不会改它，备份一份密钥只会扩大泄露面。
 * 快照在 Host 停止后进行，避免复制到写了一半的会话文件。
 *
 * 只依赖 Node 内置模块与 vs/base；Host / 运行时以接口注入，便于用假实现覆盖拒绝与回退分支。
 */

import { existsSync, promises as fsp } from 'fs';
import { join } from '../../../../base/common/path.js';
import { IRuntimeState, selectRuntimeVersion } from '../common/dshCli.js';
import { IDshHostStartOptions, IDshHostStatus } from '../common/dshHarness.js';
import { blockingSessions, IDshHealthReport, IDshUpgradeRequest, IDshUpgradeResult, IHostActivity, snapshotName, snapshotsToPrune, summarizeHealth } from '../common/dshUpgrade.js';

export interface IUpgradeHost {
	readonly status: IDshHostStatus;
	start(options: IDshHostStartOptions): Promise<IDshHostStatus>;
	stop(): Promise<void>;
	getActivity(): Promise<IHostActivity | undefined>;
	healthCheck(): Promise<IDshHealthReport>;
	effectiveDshHome(dshHome?: string): string;
}

export interface IUpgradeRuntime {
	readState(): IRuntimeState;
	restoreState(state: IRuntimeState): Promise<void>;
	listInstalled(): string[];
	setCurrent(version: string): Promise<void>;
}

export interface ISnapshotManifest {
	readonly from?: string;
	readonly to: string;
	readonly profile: string;
	readonly dshHome: string;
	/** 相对 `$DSH_HOME` 的目录；`present=false` 表示快照时不存在（回退时应删除新版本创建的同名目录）。 */
	readonly dirs: readonly { readonly rel: string; readonly present: boolean }[];
	readonly createdAt: string;
	readonly bytes: number;
}

const KEEP_SNAPSHOTS = 3;

async function dirSize(dir: string): Promise<number> {
	let total = 0;
	for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			total += await dirSize(p);
		} else if (e.isFile()) {
			total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
		}
	}
	return total;
}

export class DshUpgradeGate {

	private _running: Promise<IDshUpgradeResult> | undefined;

	constructor(
		private readonly _host: IUpgradeHost,
		private readonly _runtime: IUpgradeRuntime,
		private readonly _snapshotRoot: string,
		private readonly _log: (line: string) => void,
	) { }

	upgrade(request: IDshUpgradeRequest, startOptions: IDshHostStartOptions): Promise<IDshUpgradeResult> {
		if (this._running) {
			return Promise.resolve({ outcome: 'failed', to: request.version, error: '已有一次升级正在进行' });
		}
		this._running = this._doUpgrade(request, startOptions).finally(() => this._running = undefined);
		return this._running;
	}

	private async _doUpgrade({ version, force }: IDshUpgradeRequest, startOptions: IDshHostStartOptions): Promise<IDshUpgradeResult> {
		if (startOptions.runtimePath?.trim()) {
			return { outcome: 'failed', to: version, error: '设置 sessions.dshHarness.runtimePath 指定了 dsh 位置，托管版本切换不会生效。请先清空该设置。' };
		}
		const installed = this._runtime.listInstalled();
		if (!installed.includes(version)) {
			return { outcome: 'failed', to: version, error: `dsh ${version} 尚未安装` };
		}
		const prevState = this._runtime.readState();
		const from = selectRuntimeVersion(prevState, installed);
		if (from === version) {
			return { outcome: 'unchanged', from, to: version };
		}

		const wasRunning = this._host.status.state === 'running';
		if (wasRunning && !force) {
			const activity = await this._host.getActivity();
			if (!activity) {
				return { outcome: 'blocked', from, to: version, running: -1, error: '控制桥不可用，无法确认是否有运行中的任务' };
			}
			const busy = blockingSessions(activity);
			if (busy.length) {
				return { outcome: 'blocked', from, to: version, running: busy.length };
			}
		}

		this._log(`upgrade ${from ?? 'none'} → ${version}: stopping Host`);
		await this._host.stop();

		let manifest: ISnapshotManifest;
		let snapshotDir: string;
		try {
			({ manifest, dir: snapshotDir } = await this._snapshot(from, version, startOptions));
		} catch (e) {
			// 快照失败时不切换：没有快照就无法回退。
			if (wasRunning) {
				await this._host.start(startOptions);
			}
			return { outcome: 'failed', from, to: version, error: `快照失败，未切换版本：${String((e as Error)?.message ?? e)}` };
		}

		await this._runtime.setCurrent(version);
		const status = await this._host.start(startOptions);
		const health = status.state === 'running'
			? await this._host.healthCheck()
			: summarizeHealth([{ name: 'host running', ok: false, detail: status.error }]);

		if (health.ok) {
			this._log(`upgrade to ${version} healthy`);
			if (!wasRunning) {
				await this._host.stop();
			}
			await this._prune();
			return { outcome: 'switched', from, to: version, snapshot: snapshotDir, health };
		}

		const reason = health.checks.filter(c => !c.ok).map(c => `${c.name}${c.detail ? `（${c.detail}）` : ''}`).join('；');
		this._log(`upgrade to ${version} failed health check: ${reason}; rolling back`);
		try {
			await this._host.stop();
			await this._restore(manifest, snapshotDir);
			await this._runtime.restoreState(prevState);
			if (wasRunning) {
				await this._host.start(startOptions);
			}
			return { outcome: 'rolled-back', from, to: version, snapshot: snapshotDir, health, error: reason };
		} catch (e) {
			return { outcome: 'failed', from, to: version, snapshot: snapshotDir, health, error: `健康检查失败（${reason}），且回退出错：${String((e as Error)?.message ?? e)}。快照保留在 ${snapshotDir}` };
		}
	}

	private async _snapshot(from: string | undefined, to: string, startOptions: IDshHostStartOptions): Promise<{ manifest: ISnapshotManifest; dir: string }> {
		const dshHome = this._host.effectiveDshHome(startOptions.dshHome);
		const profile = startOptions.profile?.trim() || 'vssaros';
		const rels = [join('profiles', profile), 'sessions', 'storages'];
		const dir = join(this._snapshotRoot, snapshotName(new Date(), from, to));
		const t0 = Date.now();
		await fsp.mkdir(dir, { recursive: true });
		const dirs: { rel: string; present: boolean }[] = [];
		let bytes = 0;
		for (const rel of rels) {
			const src = join(dshHome, rel);
			const present = existsSync(src);
			dirs.push({ rel, present });
			if (present) {
				// ★ `dereference: true` 不是可选项：profile 里可能有**目录联接**——`dshHostSupervisor._dedupeSharedPackages`
				// 会把 profile 侧的 `@deepseek-ai/dsh-app-boot` 换成指向运行时的 junction（4.58：两份实例会让实时启停必失败）。
				// 不跟随链接时 `fs.cp` 会在 junction 上抛 `EPERM: operation not permitted, symlink …`，
				// 于是**整个升级闸变成"快照失败、未切换版本"**（实测 4 条集成用例全红）。
				// 跟随之后快照里是**真实内容**（自洽、可回退）；回退出来的 profile 里那份又变回真副本，
				// 下次启动会被去重步骤重新收敛 ⇒ 自愈。
				await fsp.cp(src, join(dir, 'data', rel), { recursive: true, preserveTimestamps: true, dereference: true });
				bytes += await dirSize(join(dir, 'data', rel));
			}
		}
		const manifest: ISnapshotManifest = { from, to, profile, dshHome, dirs, createdAt: new Date().toISOString(), bytes };
		await fsp.writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, undefined, 2));
		this._log(`snapshot ${dir}: ${Math.round(bytes / 1024)} KB in ${Date.now() - t0} ms`);
		return { manifest, dir };
	}

	private async _restore(manifest: ISnapshotManifest, dir: string): Promise<void> {
		for (const { rel, present } of manifest.dirs) {
			const target = join(manifest.dshHome, rel);
			await fsp.rm(target, { recursive: true, force: true });
			if (present) {
				await fsp.cp(join(dir, 'data', rel), target, { recursive: true, preserveTimestamps: true });
			}
		}
		this._log(`restored snapshot ${dir}`);
	}

	private async _prune(): Promise<void> {
		const names = await fsp.readdir(this._snapshotRoot).catch(() => [] as string[]);
		for (const n of snapshotsToPrune(names, KEEP_SNAPSHOTS)) {
			await fsp.rm(join(this._snapshotRoot, n), { recursive: true, force: true }).catch(() => undefined);
		}
	}
}
