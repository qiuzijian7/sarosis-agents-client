/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── Telegram 平台贡献：凭证就绪时自动注册 Telegram 适配器（对齐 cc-connect platform/telegram init）──
// 通过环境变量注入凭证：TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOW_FROM。
// 缺 token 时不注册（避免无谓启动）。入站采用 Bot API 长轮询（telegram.ts start() 内部拉起）。

import { IBridgeService } from "../../bridge/bridgeService.js";
import { TelegramPlatform } from "./telegram.js";

function readEnv(): { botToken: string; allowFrom?: string } | undefined {
	const proc: any = (globalThis as any).process;
	const env = proc?.env;
	if (!env) {
		return undefined;
	}
	const botToken = env.TELEGRAM_BOT_TOKEN;
	if (typeof botToken !== "string" || botToken === "") {
		return undefined;
	}
	const allowFrom = typeof env.TELEGRAM_ALLOW_FROM === "string" ? env.TELEGRAM_ALLOW_FROM : undefined;
	return { botToken, allowFrom };
}

export function registerTelegramPlatformIfConfigured(bridge: IBridgeService): void {
	const cfg = readEnv();
	if (!cfg) {
		return;
	}
	bridge.registerPlatform({
		id: "telegram",
		create: () =>
			new TelegramPlatform({
				botToken: cfg.botToken,
				allowFrom: cfg.allowFrom,
			}),
	});
}
