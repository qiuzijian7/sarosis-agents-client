/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── Feishu 平台贡献：凭证就绪时自动注册飞书适配器（对齐 cc-connect platform/feishu init）──
// 通过环境变量注入凭证：FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_ALLOW_FROM。
// 缺凭证时不注册（避免无谓启动）。入站需配合 P2 BridgeServer 的 HTTP 事件订阅。

import { IBridgeService } from "../../bridge/bridgeService.js";
import { FeishuPlatform } from "./feishu.js";

function readEnv(): { appId: string; appSecret: string; allowFrom?: string; useWs?: boolean } | undefined {
	const proc: any = (globalThis as any).process;
	const env = proc?.env;
	if (!env) {
		return undefined;
	}
	const appId = env.FEISHU_APP_ID;
	const appSecret = env.FEISHU_APP_SECRET;
	if (typeof appId !== "string" || appId === "" || typeof appSecret !== "string" || appSecret === "") {
		return undefined;
	}
	const allowFrom = typeof env.FEISHU_ALLOW_FROM === "string" ? env.FEISHU_ALLOW_FROM : undefined;
	const useWs = env.FEISHU_USE_WS === "1" || env.FEISHU_USE_WS === "true";
	return { appId, appSecret, allowFrom, useWs };
}

export function registerFeishuPlatformIfConfigured(bridge: IBridgeService): void {
	const cfg = readEnv();
	if (!cfg) {
		return;
	}
	bridge.registerPlatform({
		id: "feishu",
		create: () =>
			new FeishuPlatform({
				appId: cfg.appId,
				appSecret: cfg.appSecret,
				allowFrom: cfg.allowFrom,
				useWs: cfg.useWs,
			}),
	});
}
