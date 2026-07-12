/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── 平台桥接层 contribution：注册 IBridgeService 单例，并在 workbench 就绪后启动 ──

import { registerSingleton, InstantiationType } from "../../../../../platform/instantiation/common/extensions.js";
import { ILogService } from "../../../../../platform/log/common/log.js";
import {
	registerWorkbenchContribution2,
	WorkbenchPhase,
	IWorkbenchContribution,
} from "../../../../../workbench/common/contributions.js";
import { IBridgeService, BridgeService } from "./bridgeService.js";
import { registerFeishuPlatformIfConfigured } from "./platforms/feishu.contribution.js";
import { registerTelegramPlatformIfConfigured } from "./platforms/telegram.contribution.js";

class BridgeLifecycleContribution implements IWorkbenchContribution {
	static readonly ID = "bridge.lifecycle";

	constructor(
		@IBridgeService private readonly _bridge: IBridgeService,
		@ILogService private readonly _log: ILogService,
	) {
		// 凭证就绪时注册平台适配器（无凭证则跳过）
		registerFeishuPlatformIfConfigured(this._bridge);
		registerTelegramPlatformIfConfigured(this._bridge);
		this._bridge.start().catch(err => this._log.error("[Bridge] start failed:", err));
	}
}

registerSingleton(IBridgeService, BridgeService, InstantiationType.Delayed);
registerWorkbenchContribution2(
	BridgeLifecycleContribution.ID,
	BridgeLifecycleContribution,
	WorkbenchPhase.AfterRestored,
);
