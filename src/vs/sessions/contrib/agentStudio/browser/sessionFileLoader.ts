/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { ChatMessage } from '../common/types.js';
import { replaySessionLog, upsertMessageById } from '../common/sessionHistoryLog.js';
import type { AgentChatPaths } from './agentChatPaths.js';

/** 宿主注入面（路径学 / 文件 IO / sidecar / inline 媒体 / 快照回写 ✓）。 */
export interface ISessionFileLoaderDeps {
	logService: ILogService;
	fileService: IFileService;
	paths: AgentChatPaths;
	/** 压缩阈值计数按**实际重放**条数/字节恢复（跨进程重启后依然有界 ✓）。 */
	setHistoryCounters: (key: string, appends: number, bytes: number) => void;
	/** 取回被外置（LRU 淘汰时）的工具结果 ✓。 */
	resolveSidecarRefs: (agentId: string, sessionId: string, messages: ChatMessage[]) => Promise<number>;
	/** 存量 inline 媒体清理（**唯一收口**：此处 messages 就是该文件的全部内容 ✓）。 */
	scrubInlineMedia: (messages: ChatMessage[]) => { replaced: number; freedBytes: number };
	/** 整段改写落盘（resolved / scrubbed 后回写 ⇒ 下次装载更快 ✓）。 */
	persistSnapshot: (agentId: string, sessionId: string | undefined, messages: ChatMessage[]) => Promise<void>;
}

/**
 * 会话文件装载：**快照 + 追加日志重放**（从 `agentChatService.ts` 原样搬出 ✓，2026-09-22 阶段④-e ✓）。
 *
 * 读模型（P0-1 ✓）：**快照**（完整 ChatMessage[]，原子写 ⇒ 绝不会半截 ✓）+ **追加日志**
 * （只取屏障之后的条目，按 id **upsert 归并** ⇒ 幂等 ✓）。两者合并即权威历史 ✓。
 *
 * ## 四条口径（注释随实现搬走 ✓）
 *  ① **快照读不出来不整段丢弃** ✗✓（历史遗留半写 / 外部损坏 ✓）：改为**尽量从追加日志重建** ✓
 *     —— 这正是"崩溃丢整轮"事故的对策 ✓。
 *  ② **尾行半截是正常情况** ✗✓（追加途中被 kill ⇒ 尾行可能只有半行 JSON ✓）：损失仅最后一条 ✓，
 *     属 `warn` 而非 `error` ✓。
 *  ③ **压缩阈值计数按实际重放条数与字节恢复** ✓：否则重启后累计值归零 ⇒ 压缩永不触发 ✗。
 *  ④ **inline 媒体 scrub 只在这一处做** ✗✓：此处 messages 是该文件**全部内容**
 *     （不含 `getHistory` merge 进来的跨会话 system 消息 ✓）⇒ 回写即精确修正本文件 ✓。
 *
 * ⚠ 任何异常都返回 `[]`（宁可空历史，也不让装载失败炸掉上层 ✓）。
 */
export class SessionFileLoader {
	constructor(private readonly deps: ISessionFileLoaderDeps) { }

	async loadFromSessionFile(
	agentId: string,
	sessionId?: string,
): Promise<ChatMessage[]> {
	if (!sessionId) {
		return [];
	} // No session specified — nothing to load
	try {
		const paths = await this.deps.paths.resolveAgentPaths(agentId);
		const fileUri = this.deps.paths.sessionFileUri(paths.sessionsDirUri, sessionId);
		const logUri = this.deps.paths.sessionLogUri(paths.sessionsDirUri, sessionId);
		const hasSnapshot = await this.deps.fileService.exists(fileUri);
		const hasLog = await this.deps.fileService.exists(logUri);
		if (!hasSnapshot && !hasLog) {
			return [];
		}
		// ① 快照（完整 ChatMessage[]，原子写 ⇒ 不会是半截 ✓）
		let messages: ChatMessage[] = [];
		if (hasSnapshot) {
			try {
				const parsed = JSON.parse(
					(await this.deps.fileService.readFile(fileUri)).value.toString(),
				) as ChatMessage[];
				messages = Array.isArray(parsed) ? parsed : [];
			} catch (err) {
				// 快照读不出来（历史遗留半写 / 外部损坏 ✗）⇒ **不整段丢弃**：改为尽量从日志重建 ✓
				this.deps.logService.warn(
					`[AgentChatService] session snapshot unreadable for ${agentId}::${sessionId} ` +
					`— rebuilding from append-only log: ${err instanceof Error ? err.message : err}`,
				);
				messages = [];
			}
		}
		// ② 追加日志（★ P0-1）：只取**屏障之后**的条目，按 id 归并（幂等 ✓）
		if (hasLog) {
			try {
				const replay = replaySessionLog(
					(await this.deps.fileService.readFile(logUri)).value.toString(),
				);
				if (replay.tornLines > 0) {
					// 追加途中被 kill ⇒ 尾行可能只有半行 JSON —— 这是**正常情况** ✓
					// （损失仅最后一条消息 ✓），不是数据损坏，不必告警到 error ✓
					this.deps.logService.warn(
						`[AgentChatService] session log for ${agentId}::${sessionId} had ` +
						`${replay.tornLines} unparsable line(s) (crash-truncated tail) — ignored`,
					);
				}
				for (const m of replay.messages) { upsertMessageById(messages, m); }
				// 压缩阈值计数按**实际重放条数与字节**恢复（跨进程重启后依然有界 ✓）
				this.deps.setHistoryCounters(this.deps.paths.cacheKey(agentId, sessionId), replay.appends, replay.bytes);
			} catch (err) {
				this.deps.logService.warn(
					`[AgentChatService] session log unreadable for ${agentId}::${sessionId}: ` +
					`${err instanceof Error ? err.message : err}`,
				);
			}
		}
		// P1: resolve externalised tool result refs (from prior LRU eviction)
		const resolved = await this.deps.resolveSidecarRefs(agentId, sessionId, messages);
		// ★ 2026-09-12：存量历史脏数据清理 —— 移除内联的超长 data URI（详见方法注释）。
		//   放在「会话文件刚出磁盘」这一唯一收口：此处 messages 就是该文件的全部内容
		//   （不含 getHistory 里 merge 进来的跨会话 system 消息），回写即精确修正本文件。
		const scrubbed = this.deps.scrubInlineMedia(messages);
		if (scrubbed.replaced > 0) {
			this.deps.logService.info(
				`[AgentChatService] Scrubbed ${scrubbed.replaced} oversized inline data URI(s) ` +
				`(${(scrubbed.freedBytes / 1024 / 1024).toFixed(1)}MB) from ${agentId}::${sessionId} — ` +
				`images remain available in workflow cards.`,
			);
		}
		if (resolved > 0 || scrubbed.replaced > 0) {
			// Write back resolved messages so next load is fast (no sidecar I/O)
			await this.deps.persistSnapshot(agentId, sessionId, messages).catch(() => { });
		}
		return messages;
	} catch {
		return [];
	}
}
}
