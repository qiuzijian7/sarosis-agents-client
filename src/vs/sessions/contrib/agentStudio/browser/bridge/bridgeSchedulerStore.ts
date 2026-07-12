/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ─── BridgeScheduler 持久化：fs 落盘实现（<workDir>/scheduler.json）──
// 在 Electron renderer 中经 nodeRequire 安全访问 Node 内置 fs/path；不可用时返回 undefined
// （调度器退化为内存态）。转瞬字段 _firedMinute 不落盘；replyCtx 仅在可 JSON 序列化时保留。

import { ILogService } from "../../../../../platform/log/common/log.js";
import { IScheduledTaskStore, ScheduledTask } from "./bridgeScheduler.js";

function nodeRequire(moduleName: string): any {
	if (typeof globalThis !== "undefined" && typeof (globalThis as any).require === "function") {
		try {
			return (globalThis as any).require(moduleName);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** 调度任务持久化文件名（相对 workDir）。 */
export const BRIDGE_SCHEDULER_FILE = "scheduler.json";

/**
 * 构造基于 fs 的任务存储。fs/path 不可用或 workDir 为空时返回 undefined
 * （调用方据此退化为内存态调度器）。
 */
export function createFileTaskStore(
	workDir: string | undefined,
	log: ILogService,
): IScheduledTaskStore | undefined {
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
	const filePath = pathMod.join(absDir, BRIDGE_SCHEDULER_FILE);

	return {
		load(): ScheduledTask[] {
			try {
				if (!fs.existsSync(filePath)) {
					return [];
				}
				const raw = fs.readFileSync(filePath, "utf8");
				const arr = JSON.parse(raw);
				if (!Array.isArray(arr)) {
					return [];
				}
				return arr.filter(
					(t: any) =>
						t &&
						typeof t.id === "string" &&
						(t.kind === "cron" || t.kind === "timer"),
				) as ScheduledTask[];
			} catch (err) {
				log.error(`[BridgeScheduler] load '${filePath}' failed:`, err);
				return [];
			}
		},

		save(tasks: ScheduledTask[]): void {
			try {
				fs.mkdirSync(absDir, { recursive: true });
				const serializable = tasks.map(t => {
					// 剥离转瞬字段 _firedMinute；replyCtx 仅在可序列化时保留
					const { _firedMinute, replyCtx, ...rest } = t;
					let safeReply: unknown;
					try {
						safeReply =
							replyCtx !== undefined
								? JSON.parse(JSON.stringify(replyCtx))
								: undefined;
					} catch {
						safeReply = undefined;
					}
					return safeReply !== undefined ? { ...rest, replyCtx: safeReply } : rest;
				});
				fs.writeFileSync(filePath, JSON.stringify(serializable, null, 2), "utf8");
			} catch (err) {
				log.error(`[BridgeScheduler] save '${filePath}' failed:`, err);
			}
		},
	};
}
