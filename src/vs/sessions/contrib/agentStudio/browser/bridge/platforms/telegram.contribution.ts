/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── Telegram 平台贡献：凭证就绪时自动注册 Telegram 适配器（对齐 cc-connect platform/telegram init）──
// 通过环境变量注入凭证：TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOW_FROM。
// 缺 token 时不注册（避免无谓启动）。入站采用 Bot API 长轮询（telegram.ts start() 内部拉起）。
//
// ★ 2026-09-22（D-14）：装配时注入 **主进程 HTTP 出口** —— 见 telegram.ts 文件头实测结论：
//   renderer 的 POST(application/json) 会被 CORS 预检拦死（`TypeError: Failed to fetch`），
//   表现为「机器人能收消息但永不回话」。

import { IRequestService } from "../../../../../../platform/request/common/request.js";
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

/**
 * 凭证就绪时注册 Telegram 平台适配器。
 *
 * @param log 日志出口（接 ILogService 后轮询失败不再静默）
 * @param requestService 出站 HTTP 出口。★ 桌面端必须传**主进程出口**
 *        （`createMainProcessRequestService(mainProcessService)`），否则 POST 被 CORS 预检拦死。
 */
export function registerTelegramPlatformIfConfigured(
	bridge: IBridgeService,
	log?: (msg: string) => void,
	requestService?: IRequestService,
): void {
	const cfg = readEnv();
	if (!cfg) {
		return;
	}
	if (log) {
		log(
			`[Bridge] telegram 凭证来源=env botToken=${cfg.botToken.slice(0, 8)}… ` +
				`allowFrom=${cfg.allowFrom ? `${cfg.allowFrom.split(",").length} 项` : "未限制"} ` +
				`http=${requestService ? "主进程 httpRequest" : "渲染进程 fetch（⚠ 出站 POST 会被 CORS 预检拦）"}`,
		);
	}
	bridge.registerPlatform({
		id: "telegram",
		create: () =>
			new TelegramPlatform({
				botToken: cfg.botToken,
				allowFrom: cfg.allowFrom,
				log,
				requestService,
				callSite: "telegramBridge",
			}),
	});
}
