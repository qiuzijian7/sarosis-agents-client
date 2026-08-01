/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── BridgeUsage 持久化：fs 落盘实现（<workDir>/usage.json）──
// 在 Electron renderer 中经 nodeRequire 安全访问 Node 内置 fs/path；不可用时返回 undefined
// （Usage 上报退化为内存态）。UsageStats 全为可序列化基础类型，无需剥离字段（对称 bridgeSchedulerStore.ts）。

import { ILogService } from "../../../../../platform/log/common/log.js";
import { IUsageStatsStore, UsageSnapshot } from "./bridgeUsage.js";
import { nodeRequire } from "../rendererNodeRequire.js";

/** 用量持久化文件名（相对 workDir）。 */
export const BRIDGE_USAGE_FILE = "usage.json";

/**
 * 构造基于 fs 的用量存储。fs/path 不可用或 workDir 为空时返回 undefined
 * （调用方据此退化为内存态上报器）。
 */
export function createFileUsageStore(
	workDir: string | undefined,
	log: ILogService,
): IUsageStatsStore | undefined {
	const fs = nodeRequire("fs");
	const pathMod = nodeRequire("path");
	if (!fs || !pathMod || !workDir) {
		return undefined;
	}

	let absDir: string;
	try {
		absDir = pathMod.resolve(workDir);
	} catch {
		absDir = workDir;
	}
	const filePath = pathMod.join(absDir, BRIDGE_USAGE_FILE);

	return {
		load(): UsageSnapshot | undefined {
			try {
				if (!fs.existsSync(filePath)) {
					return undefined;
				}
				const raw = fs.readFileSync(filePath, "utf8");
				const obj = JSON.parse(raw);
				if (
					!obj ||
					typeof obj !== "object" ||
					!Array.isArray(obj.byAgent) ||
					!Array.isArray(obj.bySession) ||
					!obj.global
				) {
					return undefined;
				}
				return obj as UsageSnapshot;
			} catch (err) {
				log.error(`[BridgeUsage] load '${filePath}' failed:`, err);
				return undefined;
			}
		},

		save(snapshot: UsageSnapshot): void {
			try {
				fs.mkdirSync(absDir, { recursive: true });
				fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf8");
			} catch (err) {
				log.error(`[BridgeUsage] save '${filePath}' failed:`, err);
			}
		},
	};
}
