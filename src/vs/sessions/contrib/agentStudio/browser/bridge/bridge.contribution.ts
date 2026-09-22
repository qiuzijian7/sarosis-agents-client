/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── 平台桥接层 contribution：注册 IBridgeService 单例，并在 workbench 就绪后启动 ──
//
// ★ 2026-09-22 修复（D-02 / D-05）：
//   D-02：把 IConfigurationService 传给飞书装配 —— 此前只读环境变量，UI 里配好的
//         凭证永远进不了运行时（「配置成功但渠道不工作」的根因）。
//   D-05：订阅 `sessions.channel.feishu` 配置变更并做防抖热重载（卸载旧平台 → 重新装配），
//         改配置不再需要重启窗口。此前只在 AfterRestored 装配一次。

import { Disposable, IDisposable } from "../../../../../base/common/lifecycle.js";
import { registerSingleton, InstantiationType } from "../../../../../platform/instantiation/common/extensions.js";
import { IConfigurationChangeEvent, IConfigurationService } from "../../../../../platform/configuration/common/configuration.js";
import { ILogService } from "../../../../../platform/log/common/log.js";
import { IRequestService } from "../../../../../platform/request/common/request.js";
import { IMainProcessService } from "../../../../../platform/ipc/common/mainProcessService.js";
import { createMainProcessRequestService } from "../mainProcessRequestService.js";
import {
	registerWorkbenchContribution2,
	WorkbenchPhase,
	IWorkbenchContribution,
} from "../../../../../workbench/common/contributions.js";
import { IBridgeService, BridgeService } from "./bridgeService.js";
import { registerFeishuPlatformIfConfigured } from "./platforms/feishu.contribution.js";
import { registerTelegramPlatformIfConfigured } from "./platforms/telegram.contribution.js";

/** 触发渠道热重载的配置前缀。 */
const CHANNEL_CONFIG_PREFIX = "sessions.channel.feishu";

/** 配置变更到平台重装之间的防抖窗口（ms）——避免用户在输入框里逐字符触发重装。 */
const RELOAD_DEBOUNCE_MS = 800;

class BridgeLifecycleContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = "bridge.lifecycle";

	/** 飞书平台当前的卸载句柄（热重载时先 dispose 再重装）。 */
	private _feishuRegistration?: IDisposable;
	private _reloadTimer?: ReturnType<typeof setTimeout>;

	/**
	 * 渠道 HTTP 出口 + 其名称（仅用于装配日志，便于现场核对走的是哪条路）。
	 *
	 * ★ 2026-09-22（CORS）：**必须是主进程出口**。DI 注入的 `IRequestService` 在桌面端是
	 * `NativeRequestService` → `requestImpl.ts` 的 `fetch`，仍在 renderer 网络栈里，
	 * origin `vscode-file://vscode-app` 会被飞书 OpenAPI 的 CORS 策略拦掉。
	 * 主进程出口 = `VSSAROS_LLM_CHANNEL` 的 `httpRequest`（见 mainProcessRequestService.ts）。
	 */
	private readonly _httpRequestService: IRequestService;
	private readonly _httpLabel: string;

	constructor(
		@IBridgeService private readonly _bridge: IBridgeService,
		@ILogService private readonly _log: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IRequestService private readonly _rendererRequestService: IRequestService,
		@IMainProcessService private readonly _mainProcessService: IMainProcessService,
	) {
		super();

		const mpRequestService = createMainProcessRequestService(this._mainProcessService);
		this._httpRequestService = mpRequestService ?? this._rendererRequestService;
		this._httpLabel = mpRequestService
			? "主进程 httpRequest"
			: "渲染进程 fetch（⚠ 桌面端会被 CORS 拦截）";

		// 凭证就绪时注册平台适配器（配置优先，env 覆盖；无凭证则跳过）
		this._applyFeishuPlatform();
		// Telegram 出站同为 POST(application/json) → 必须用同一个主进程出口（D-14）
		registerTelegramPlatformIfConfigured(this._bridge, msg => this._log.info(msg), this._httpRequestService);

		this._bridge.start().catch(err => this._log.error("[Bridge] start failed:", err));

		// D-05：配置变更 → 防抖热重载飞书平台
		this._register(
			this._configurationService.onDidChangeConfiguration((e: IConfigurationChangeEvent) => {
				if (!e.affectsConfiguration(CHANNEL_CONFIG_PREFIX)) {
					return;
				}
				this._scheduleFeishuReload();
			}),
		);

		this._register({
			dispose: () => {
				if (this._reloadTimer) {
					clearTimeout(this._reloadTimer);
					this._reloadTimer = undefined;
				}
				this._feishuRegistration?.dispose();
				this._feishuRegistration = undefined;
			},
		});
	}

	private _scheduleFeishuReload(): void {
		if (this._reloadTimer) {
			clearTimeout(this._reloadTimer);
		}
		this._reloadTimer = setTimeout(() => {
			this._reloadTimer = undefined;
			this._applyFeishuPlatform(true);
		}, RELOAD_DEBOUNCE_MS);
	}

	/**
	 * 卸载并重新装配飞书平台。
	 * @param reloading true 表示由配置变更触发（打日志用）
	 */
	private _applyFeishuPlatform(reloading = false): void {
		try {
			this._feishuRegistration?.dispose();
			this._feishuRegistration = undefined;
			this._feishuRegistration = registerFeishuPlatformIfConfigured(
				this._bridge,
				this._configurationService,
				msg => this._log.info(msg),
				this._httpRequestService,
				this._httpLabel,
			);
			if (reloading) {
				if (this._feishuRegistration) {
					this._log.info("[Bridge] 飞书渠道配置已变更 → 平台已重新装配（无需重启窗口）");
				} else {
					this._log.info("[Bridge] 飞书渠道配置已变更 → 未启用或凭证不完整，平台已卸载");
				}
			}
		} catch (err) {
			this._log.error("[Bridge] 飞书平台装配失败:", err);
		}
	}
}

registerSingleton(IBridgeService, BridgeService, InstantiationType.Delayed);
registerWorkbenchContribution2(
	BridgeLifecycleContribution.ID,
	BridgeLifecycleContribution,
	WorkbenchPhase.AfterRestored,
);
