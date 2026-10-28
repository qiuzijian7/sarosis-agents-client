/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 插件中心「DSH」来源的实现（方案 4.5）：把 dsh 通道服务的已装插件清单 + 启停开关
 * 暴露给 browser 层的 `PluginsViewPane`（接口见 `agentStudio/browser/dshPluginCenterHost.ts`）。
 *
 * 只读清单与启停状态，不自己维护任何状态（真源：profile 的 `dsh.profile.bundles` 组合）。
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IDshBundledInstallResult, IDshBundledPluginRow, IDshInspectResult, IDshInstallResult, IDshPluginBundlesSnapshot, IDshPluginCenterHost, IDshPluginCenterRow, IDshPluginCenterSetResult, IDshPluginCenterSnapshot, IDshPluginRowSetResult, setDshPluginCenterHostFactory } from '../../agentStudio/browser/dshPluginCenterHost.js';
import { IBridgeInstallResult } from '../common/dshBridgeProtocol.js';
import { DshHarnessSettings, IDshPluginInfo } from '../common/dshHarness.js';
import { isBundleDisableForbidden } from '../common/dshPluginActivation.js';
import { IThirdPartyPlugin } from '../common/dshPluginUpgrade.js';
import { containerOfModule, moduleIdForPluginName } from '../common/dshModuleContainers.js';
import { IDshHarnessService } from './dshHarnessService.js';

export class DshPluginCenterHost extends Disposable implements IDshPluginCenterHost {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		@IDshHarnessService private readonly _dsh: IDshHarnessService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		// 清单变化（启停开关）与 Host 状态变化都要让页签重绘（版本 / 运行态行会变）。
		this._register(this._dsh.onDidChangePlugins(() => this._onDidChange.fire()));
		this._register(this._dsh.onDidChangeStatus(() => this._onDidChange.fire()));
	}

	statusText(): string {
		const s = this._dsh.status;
		const channel = this._configurationService.getValue<string>(DshHarnessSettings.UpdateChannel) ?? 'stable';
		const profile = s.profile ?? 'vssaros';
		const parts = [s.state === 'running' ? '运行中' : s.state === 'starting' ? '启动中' : s.state === 'stopping' ? '停止中' : s.state === 'error' ? '错误' : '未启动'];
		if (s.dshVersion) {
			parts.push(`dsh ${s.dshVersion}`);
		}
		parts.push(`profile ${profile}`, `通道 ${channel}`);
		if (s.state === 'running') {
			parts.push(`控制桥 ${s.bridge === 'connected' ? '已连接' : s.bridge === 'fallback' ? '降级' : '无'}`);
		}
		if (s.error) {
			parts.push(s.error.slice(0, 160));
		}
		return parts.join(' · ');
	}

	async load(): Promise<IDshPluginCenterSnapshot> {
		try {
			const snapshot = await this._dsh.getPluginActivation();
			return { rows: this._toRows(snapshot.plugins), hmr: snapshot.hmr };
		} catch (e) {
			this._log.warn(`[dshHarness] plugin center: getPluginActivation failed: ${e instanceof Error ? e.message : String(e)}`);
			return { rows: [], hmr: 'unknown' };
		}
	}

	async setEnabled(name: string, enabled: boolean): Promise<IDshPluginCenterSetResult> {
		// 方案 5.16 批次 3：走「Host 优先、文件兜底」的通道命令（Host 运行时由它的写锁与
		// application 语义负责，VsSaros 不再复制这套逻辑）。
		const r = await this._dsh.setDshBundleEnabled(name, enabled);
		return {
			rows: this._toRows(r.plugins),
			hmr: r.hmr,
			changed: r.changed,
			...(r.via ? { via: r.via } : {}),
			...(r.application !== undefined ? { application: r.application } : {}),
			...(r.errorCode ? { errorCode: r.errorCode } : {}),
		};
	}

	async setRowEnabled(entryId: string, enabled: boolean): Promise<IDshPluginRowSetResult> {
		return this._dsh.setDshPluginRowEnabled(entryId, enabled);
	}

	/**
	 * 组合包视图（方案 5.16 批次 2）：四个只读来源并发取，任一失败都降级为"缺那块 + error 文案"。
	 * 不缓存——页签打开与刷新都实取（Host 侧快照很便宜）。
	 */
	async loadBundles(): Promise<IDshPluginBundlesSnapshot> {
		const [bundles, pluginRows, registries, inventory] = await Promise.all([
			this._dsh.listDshBundles().then(
				b => ({ ok: true as const, bundles: b }),
				(e: unknown) => ({ ok: false as const, error: this._reason(e, '组合包清单') })),
			this._dsh.listDshPluginRows().catch(() => undefined),
			this._dsh.getDshPluginRegistries().catch(() => undefined),
			this._dsh.getDshPluginInventory().catch(() => undefined),
		]);
		if (!bundles.ok) {
			return { bundles: [], pluginRows: [], error: bundles.error };
		}
		return {
			bundles: bundles.bundles.map(b => ({ ...b, rows: b.rows ?? [] })),
			pluginRows: pluginRows ?? [],
			...(registries ? { registries } : {}),
			...(inventory ? { inventory } : {}),
		};
	}

	// ─── 插件商城（方案 5.16 批次 4，安装面）。形状直接对齐（桥侧整形过），只做字段搬运。

	async inspectBundle(spec: string): Promise<IDshInspectResult> {
		const r = await this._dsh.inspectDshPlugin(spec);
		return {
			status: r.status,
			...(r.kind !== undefined ? { kind: r.kind } : {}),
			...(r.name !== undefined ? { name: r.name } : {}),
			...(r.version !== undefined ? { version: r.version } : {}),
			...(r.description !== undefined ? { description: r.description } : {}),
			...(r.bundle !== undefined ? { bundle: r.bundle } : {}),
			...(r.registry !== undefined ? { registry: r.registry } : {}),
			...(r.host !== undefined ? { host: r.host } : {}),
			...(r.problem !== undefined ? { problem: r.problem } : {}),
			...(r.reason !== undefined ? { reason: r.reason } : {}),
			...(r.registries ? { registries: r.registries } : {}),
		};
	}

	async installBundle(spec: string, requestId: string, approvedBuilds?: readonly string[]): Promise<IDshInstallResult> {
		return this._toInstallResult(await this._dsh.installDshPlugin(spec, requestId, approvedBuilds));
	}

	async cancelInstall(requestId: string): Promise<'cancelled' | 'too-late' | 'not-running'> {
		const r = await this._dsh.cancelDshPluginInstall(requestId);
		return r.status;
	}

	async removeBundle(name: string): Promise<IDshInstallResult> {
		return this._toInstallResult(await this._dsh.removeDshPlugin(name));
	}

	// ─── 随包模块插件（一键安装）：形状直接对齐（主进程整形过），只做字段搬运。 ──

	async listBundledPlugins(): Promise<readonly IDshBundledPluginRow[]> {
		return await this._dsh.listBundledPlugins();
	}

	async installBundledPlugin(name: string): Promise<IDshBundledInstallResult> {
		return await this._dsh.installBundledPlugin(name);
	}

	async installLocalPlugin(spec: string): Promise<IDshBundledInstallResult> {
		return await this._dsh.installLocalPlugin(spec);
	}

	async installPluginSpec(spec: string, name: string): Promise<IDshBundledInstallResult> {
		return await this._dsh.installPluginSpec(spec, name);
	}

	/** 列 profile 里用户自己装的第三方插件（2026-10-28）。 */
	async listThirdPartyPlugins(): Promise<IThirdPartyPlugin[]> {
		return await this._dsh.listThirdPartyPlugins();
	}

	/** 升级一个第三方插件（只有 registry 形态会真的执行）。 */
	async upgradeThirdPartyPlugin(name: string): Promise<{ ok: boolean; message: string }> {
		return await this._dsh.upgradeThirdPartyPlugin(name);
	}

	private _toInstallResult(r: IBridgeInstallResult): IDshInstallResult {
		return {
			changed: r.changed,
			application: r.application,
			stage: r.stage,
			target: r.target,
			...(r.bundle ? { bundle: r.bundle } : {}),
			...(r.error ? { errorCode: r.error } : {}),
			...(r.warnings ? { warnings: r.warnings } : {}),
			...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
			...(r.failureKind ? { failureKind: r.failureKind } : {}),
			...(r.timedOut ? { timedOut: true } : {}),
			...(r.pendingBuilds ? { pendingBuilds: r.pendingBuilds } : {}),
			...(r.registries ? { registries: r.registries } : {}),
			...(r.logPath ? { logPath: r.logPath } : {}),
		};
	}

	private _reason(e: unknown, what: string): string {
		const msg = e instanceof Error ? e.message : String(e);
		// 通道错误会把主进程那侧的完整消息带回来（含"控制桥不可用"这类明确原因）。
		return `${what}取数失败：${msg.replace(/^Error:\s*/, '').slice(0, 200)}`;
	}

	async restartHost(): Promise<string> {
		const s = await this._dsh.restart();
		return s.state === 'running' ? `Host 已重启（dsh ${s.dshVersion ?? '?'}）` : `Host 状态：${s.state}${s.error ? ` — ${s.error}` : ''}`;
	}

	private _toRows(plugins: readonly IDshPluginInfo[]): IDshPluginCenterRow[] {
		return plugins.map(p => {
			const module = moduleIdForPluginName(p.name);
			return {
				name: p.name,
				spec: p.spec,
				...(p.version ? { version: p.version } : {}),
				enabled: p.enabled !== false,
				...(isBundleDisableForbidden(p.name) ? { undisablable: true } : {}),
				...(module ? { module } : {}),
				...(module ? { containerId: containerOfModule(module)?.containerId } : {}),
			};
		});
	}
}

/**
 * 启动时注册工厂（`PluginsViewPane` 在 browser 层，经钩子取实现）。
 * 总开关关闭时工厂返回 undefined → 插件中心不出现「DSH」页签。
 */
export class DshPluginCenterHostContribution extends Disposable {
	static readonly ID = 'sessions.dshHarness.pluginCenterHost';

	private readonly _host: DshPluginCenterHost;

	constructor(
		@IDshHarnessService dsh: IDshHarnessService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService log: ILogService,
	) {
		super();
		this._host = this._register(new DshPluginCenterHost(dsh, this._configurationService, log));
		setDshPluginCenterHostFactory(() => this._configurationService.getValue<boolean>(DshHarnessSettings.Enabled) === false ? undefined : this._host);
	}

	override dispose(): void {
		setDshPluginCenterHostFactory(undefined);
		super.dispose();
	}
}
