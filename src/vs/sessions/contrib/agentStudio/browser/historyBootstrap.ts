/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { ChatMessage } from '../common/types.js';
import type { AgentChatPaths } from './agentChatPaths.js';

/** 宿主注入面（桶缓存与"启动期净化后的回写"归宿主 ✓）。 */
export interface IHistoryBootstrapDeps {
	logService: ILogService;
	fileService: IFileService;
	paths: AgentChatPaths;
	/** 全局桶缓存（启动只装 noSession 桶 ✓）。 */
	cache: Map<string, ChatMessage[]>;
	/** 登记桶访问时间（LRU ✓）。 */
	touchBucket: (key: string) => void;
	/** 调度存量 inline 媒体清理（与 global history 文件**无关** ⇒ 必须放在早退分支之前 ✗✓）。 */
	scheduleBulkCleanup: () => void;
}

/**
 * global history（fallback 文件）的**惰性装载**与写回（从 `agentChatService.ts` 原样搬出 ✓，
 * 2026-09-22 阶段④-e ✓）。
 *
 * ## 三条口径（注释随实现搬走 ✓）
 *  ① **启动只装 noSession 桶** ✗✓（key 不含 `::` ✓）：会话级桶一律由
 *     `getHistory → loadFromSessionFile` **惰性**装载 ⇒ 否则每次开窗都要把
 *     **多 GB 的 ToolResult payload** 读进 renderer 堆 ✗（P0 内存纪律 ✓）。
 *  ② **启动期净化** ✗✓（2026-06-05）：noSession 桶历史上沉积过 user/assistant/tool 消息，
 *     会让 `getHistory` merge system 消息时反复报 `dropped X non-system messages` ✗
 *     ⇒ 装载后立刻过滤为**仅 system** 并**回写磁盘**（让磁盘同样干净 ✓）。
 *  ③ 批量清理必须**放在早退分支之前** ✗✓：方法末尾有「无 global history 文件即 return」的早退 ✗，
 *     而批量清理只依赖 chat-history 目录，与全球历史文件是否存在**无关** ✓。
 *
 * ⚠ 幂等：`ensureLoaded()` 用 `_loaded` 标志守（可重复调 ✓）。
 */
export class HistoryBootstrap {
	private _loaded = false;

	constructor(private readonly deps: IHistoryBootstrapDeps) { }

	async ensureLoaded(): Promise<void> {
	if (this._loaded) {
		return;
	}
	this._loaded = true;
	// ★ 2026-09-12：调度存量历史批量清理（延迟执行，不阻塞启动路径；详见方法注释）。
	//   放在此处而非方法末尾：末尾有「无 global history 文件即 return」的早退分支，
	//   而批量清理只依赖 chat-history 目录，与 global history 文件是否存在无关。
	this.deps.scheduleBulkCleanup();
	try {
		const uri = this.deps.paths.getHistoryFileUri();
		if (!(await this.deps.fileService.exists(uri))) {
			this.deps.logService.info(
				`[AgentChatService] No global history file — session buckets will be loaded lazily from per-session files.`,
			);
			return;
		}
		const content = await this.deps.fileService.readFile(uri);
		const data = JSON.parse(content.value.toString()) as Record<
			string,
			ChatMessage[]
		>;
		// P0: only load noSession buckets (keys without "::") at startup.
		// Session-level buckets are loaded lazily via getHistory →
		// _loadFromSessionFile fallback.  This avoids loading multi-GB of
		// ToolResult payloads into the renderer heap on every window launch.
		let loadedCount = 0;
		let skippedCount = 0;
		for (const [key, messages] of Object.entries(data)) {
			if (!key.includes('::')) {
				this.deps.cache.set(key, messages);
				this.deps.touchBucket(key);
				loadedCount++;
			} else {
				skippedCount++;
			}
		}
		this.deps.logService.info(
			`[AgentChatService] Loaded ${loadedCount} noSession buckets, skipped ${skippedCount} session buckets (lazy-load via per-session files)`,
		);

		// 🔒 启动期净化（2026-06-05）：noSession 桶（key 不含 `::`，即 `agentId`
		// 本身）历史上沉积过 user/assistant/tool 消息，会被 getHistory 在每次 session
		// 请求时 merge system 消息时报警 dropped X non-system messages，并增加 IO。
		// 在加载完成后立刻把所有 noSession 桶过滤为仅 system 消息，并回写 global
		// history 文件，让磁盘也保持干净。
		let dirty = false;
		let totalDropped = 0;
		for (const [key, messages] of this.deps.cache) {
			if (key.includes('::')) { continue; }
			const systemOnly = messages.filter(m => m.role === 'system');
			if (systemOnly.length !== messages.length) {
				totalDropped += messages.length - systemOnly.length;
				this.deps.cache.set(key, systemOnly);
				dirty = true;
			}
		}
		if (dirty) {
			this.deps.logService.warn(
				`[AgentChatService] Startup sanitize: dropped ${totalDropped} non-system messages from noSession buckets`,
			);
			this.persistGlobalHistory().catch((err) =>
				this.deps.logService.error('[AgentChatService] Startup sanitize persist failed:', err),
			);
		}
	} catch (err) {
		this.deps.logService.error(
			"[AgentChatService] Failed to load global history:",
			err,
		);
	}
}

	async persistGlobalHistory(): Promise<void> {
	try {
		const dirUri = this.deps.paths.getGlobalDataUri();
		if (!(await this.deps.fileService.exists(dirUri))) {
			await this.deps.fileService.createFolder(dirUri);
		}
		const data: Record<string, ChatMessage[]> = {};
		for (const [key, messages] of this.deps.cache) {
			data[key] = messages;
		}
		await this.deps.fileService.writeFile(
			this.deps.paths.getHistoryFileUri(),
			VSBuffer.fromString(JSON.stringify(data, null, 2)),
		);
	} catch (err) {
		this.deps.logService.error(
			"[AgentChatService] Failed to persist global history:",
			err,
		);
	}
}
}
