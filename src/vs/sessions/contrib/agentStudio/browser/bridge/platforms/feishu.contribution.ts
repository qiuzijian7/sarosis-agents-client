/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── Feishu 平台贡献：凭证就绪时注册飞书适配器（对齐 cc-connect platform/feishu init）──
//
// ★ 2026-09-22 修复（D-02）：**打通「UI 配置 → 运行时装配」**。
//
// 修复前：装配只读 process.env（FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_ALLOW_FROM /
//   FEISHU_USE_WS），而 UI（渠道配置页 / 飞书扫码绑定）把凭证写进
//   `sessions.channel.feishu.*` —— 两边完全没有交汇，于是「在 UI 里配好凭证、重启后
//   渠道依旧不工作」，且没有任何提示。
//
// 修复后取值优先级（**env 是显式运维覆盖，优先级最高**）：
//   1) env 提供 appId+appSecret  → 用它（忽略配置里的 enabled，保持纯 env 部署向后兼容）；
//   2) 否则读配置 `sessions.channel.feishu.*` → 需 `enabled === true` 且 appId/appSecret 均非空；
//   3) 两者都不满足 → 不注册（避免无谓启动）。
//   allowFrom / useWs 逐项独立取：env 有则用 env，否则用配置。
//
// 热重载（D-05）：返回值由装配方（bridge.contribution.ts）持有，配置变更时先 dispose
//   （卸载平台）再重新注册 —— 改配置无需重启窗口。

import { IDisposable } from "../../../../../../base/common/lifecycle.js";
import { IConfigurationService } from "../../../../../../platform/configuration/common/configuration.js";
import { IRequestService } from "../../../../../../platform/request/common/request.js";
import { IBridgeService } from "../../bridge/bridgeService.js";
import { FeishuPlatform } from "./feishu.js";

/** 飞书渠道配置键（与 constants.ts 的 CHANNEL_DEFINITIONS.feishu 保持一致）。 */
export const FEISHU_CONFIG_KEYS = {
	enabled: "sessions.channel.feishu.enabled",
	appId: "sessions.channel.feishu.appId",
	appSecret: "sessions.channel.feishu.appSecret",
	allowFrom: "sessions.channel.feishu.allowFrom",
	useWs: "sessions.channel.feishu.useWs",
} as const;

/** 解析后的飞书凭证与装配选项。 */
export interface IResolvedFeishuConfig {
	readonly appId: string;
	readonly appSecret: string;
	/** 已归一化为「逗号分隔」——allowFromCheck 只按逗号切分（见下 normalizeAllowFrom）。 */
	readonly allowFrom?: string;
	readonly useWs: boolean;
	/** 凭证来源，用于日志与排障。 */
	readonly source: "env" | "config";
}

/**
 * 归一化白名单文本。
 *
 * ★ 必须做：UI 的 Allow From 是 textarea、提示「每行一个」，而运行时
 * `allowFromCheck()` 只按**逗号**切分（common/bridge/bridgeSecurity.ts:25）——
 * 若把配置原文直接透传，多行白名单会整体匹配失败（等于谁都进不来）。
 */
export function normalizeAllowFrom(raw: string | undefined | null): string | undefined {
	if (typeof raw !== "string") {
		return undefined;
	}
	const items = raw
		.split(/[\n,;]/u)
		.map(s => s.trim())
		.filter(s => s !== "");
	return items.length > 0 ? items.join(",") : undefined;
}

interface IEnvFeishuConfig {
	readonly appId: string;
	readonly appSecret: string;
	readonly allowFrom?: string;
	readonly useWs?: boolean;
}

/** 解析 env 布尔串（'1'/'true'/'yes'/'on' → true；'0'/'false'/'no'/'off' → false；其余 → undefined）。 */
function parseEnvBoolean(raw: string | undefined): boolean | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const s = raw.trim().toLowerCase();
	if (s === "1" || s === "true" || s === "yes" || s === "on") {
		return true;
	}
	if (s === "0" || s === "false" || s === "no" || s === "off") {
		return false;
	}
	return undefined;
}

/** 读 env（renderer 里 process.env 在 Electron 桌面端可用；不存在则返回 undefined）。 */
function readEnv(): IEnvFeishuConfig | undefined {
	const proc: any = (globalThis as any).process;
	const env = proc?.env;
	if (!env) {
		return undefined;
	}
	const appId = typeof env.FEISHU_APP_ID === "string" ? env.FEISHU_APP_ID.trim() : "";
	const appSecret = typeof env.FEISHU_APP_SECRET === "string" ? env.FEISHU_APP_SECRET.trim() : "";
	if (!appId || !appSecret) {
		return undefined;
	}
	return {
		appId,
		appSecret,
		allowFrom: normalizeAllowFrom(env.FEISHU_ALLOW_FROM),
		useWs: parseEnvBoolean(env.FEISHU_USE_WS),
	};
}

interface ICfgFeishuConfig {
	readonly appId: string;
	readonly appSecret: string;
	readonly allowFrom?: string;
	readonly useWs: boolean;
}

/**
 * 读配置（`sessions.channel.feishu.*`）。
 * 门槛：enabled === true 且 appId/appSecret 均非空，否则 undefined（不装配）。
 */
function readCfg(configurationService: IConfigurationService | undefined): ICfgFeishuConfig | undefined {
	if (!configurationService) {
		return undefined;
	}
	if (configurationService.getValue<boolean>(FEISHU_CONFIG_KEYS.enabled) !== true) {
		return undefined;
	}
	const appId = String(configurationService.getValue(FEISHU_CONFIG_KEYS.appId) ?? "").trim();
	const appSecret = String(configurationService.getValue(FEISHU_CONFIG_KEYS.appSecret) ?? "").trim();
	if (!appId || !appSecret) {
		return undefined;
	}
	return {
		appId,
		appSecret,
		allowFrom: normalizeAllowFrom(String(configurationService.getValue(FEISHU_CONFIG_KEYS.allowFrom) ?? "")),
		// 长连接默认开启（与官方推荐一致）；仅显式 false 关闭
		useWs: configurationService.getValue<boolean>(FEISHU_CONFIG_KEYS.useWs) !== false,
	};
}

/**
 * 解析飞书装配配置（env 优先，配置兜底；见文件头优先级说明）。
 * 纯函数 + 只做一次 IO 读取 —— 供装配、设置页状态徽章共用同一口径（避免两处判读漂移）。
 */
export function resolveFeishuConfig(configurationService?: IConfigurationService): IResolvedFeishuConfig | undefined {
	const env = readEnv();
	const cfg = readCfg(configurationService);
	if (env) {
		return {
			appId: env.appId,
			appSecret: env.appSecret,
			allowFrom: env.allowFrom ?? cfg?.allowFrom,
			useWs: env.useWs ?? cfg?.useWs ?? true,
			source: "env",
		};
	}
	if (cfg) {
		return { ...cfg, source: "config" };
	}
	return undefined;
}

/**
 * 凭证就绪时注册飞书平台适配器。
 *
 * @param requestService HTTP 出口。★ 桌面端必须传**主进程出口**
 *        （`createMainProcessRequestService(mainProcessService)`）——
 *        DI 注入的 `IRequestService` 在 renderer 里仍是 `fetch`，会被 CORS 拦掉；
 *        传 undefined 时平台回落渲染进程 fetch（仅单测/非 Electron 宿主）。
 * @param httpLabel HTTP 出口名称，仅用于装配日志（现场核对走的是哪条路）。
 * @returns 已注册时的卸载句柄（供配置变更热重载使用）；未就绪时返回 undefined。
 */
export function registerFeishuPlatformIfConfigured(
	bridge: IBridgeService,
	configurationService?: IConfigurationService,
	log?: (msg: string) => void,
	requestService?: IRequestService,
	httpLabel = "注入的 HTTP 出口",
): IDisposable | undefined {
	const cfg = resolveFeishuConfig(configurationService);
	if (!cfg) {
		return undefined;
	}
	if (log) {
		log(
			`[Bridge] feishu 凭证来源=${cfg.source} appId=${cfg.appId.slice(0, 8)}… ` +
				`useWs=${cfg.useWs} allowFrom=${cfg.allowFrom ? `${cfg.allowFrom.split(",").length} 项` : "未限制"} ` +
				`http=${requestService ? httpLabel : "渲染进程 fetch（⚠ 桌面端会被 CORS 拦截）"}`,
		);
	}
	return bridge.registerPlatform({
		id: "feishu",
		create: () =>
			new FeishuPlatform({
				appId: cfg.appId,
				appSecret: cfg.appSecret,
				allowFrom: cfg.allowFrom,
				useWs: cfg.useWs,
				log,
				requestService,
				callSite: "feishuBridge",
			}),
	});
}
