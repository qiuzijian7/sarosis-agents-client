/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { appendFileSafe, writeFileAtomicSafe } from '../common/atomicWrite.js';
import {
	serializeSessionLogAppends,
	serializeSessionLogBarrier,
} from '../common/sessionHistoryLog.js';
import type { ChatMessage } from '../common/types.js';
import type { AgentChatPaths } from './agentChatPaths.js';

/**
 * 会话历史的**写路径**（快照 / 追加日志 / 屏障 / 串行化）—— 从 `agentChatService.ts`
 * 拆出的独立簇 ✓（2026-09-22 阶段③a）。
 *
 * 存储协议（详见 `common/sessionHistoryLog.ts` 头注释 ✓）：
 * ```
 * {id}.jsonl  追加日志（一行一条 ✓，`op:'base'` 是**屏障**）
 * {id}.json   快照（完整数组，原子写 ✓）
 * ```
 * 读 = 快照 + 重放日志（按 id 归并 ⇒ 幂等 ✓）；写在**同一会话内串行** ✓，否则
 * 「快照 → 屏障 → 截断日志」三步会被并发追加插进来 ⇒ 那条追加被重放丢弃（静默丢消息 ✗✓）。
 *
 * 两条语义边界 ✗✓（调用方必须选对）：
 *  · **增量追加** ⇒ {@link append} ✓（O(1) 增量写，崩溃最多丢最后一行 ✓）；
 *  · **整段改写** ⇒ {@link persistSnapshot} / {@link writeSnapshotLocked} ✓
 *    （`messages` 被当作**完整权威** ⇒ 必须带屏障，否则旧日志会被"重放复活" ✗✓）。
 *
 * 依赖刻意收窄 ✓：`getCached`（读内存缓存以写压缩快照）与 `updateIndex`（同步索引 messageCount）
 * 都以回调注入 ⇒ 本模块**不持有**缓存与索引 ✓（两者仍归服务 ✓）。
 */
export class SessionHistoryStore {
	/**
	 * 触发压缩（快照 + 屏障 + 截断）的**追加条数**阈值。
	 *
	 * 取值权衡：太小 ⇒ 快照写（整文件，MB 级）频繁 ✗，退化成改造前的成本；
	 * 太大 ⇒ 打开会话时要重放的日志行多（每行 parse 一次 ✓ 微秒级，可接受 ✓），
	 * 且日志文件体积大 ✗。512 条 ≈ 一个长 turn 的量级 ✓，典型会话压缩 1–2 次 ✓。
	 */
	static readonly COMPACT_AFTER = 512;
	/**
	 * 触发压缩的**字节**阈值（4MB）。
	 *
	 * **为什么条数阈值不够** ✗：单条消息可以是 MB 级（工具结果全文、大段代码 ✓），
	 * 512 条 × 大消息 ⇒ 日志能涨到几百 MB ✗（每次打开会话都要整份重放 ✗）。
	 * 两个阈值取「先到者」✓。
	 */
	static readonly COMPACT_AFTER_BYTES = 4 * 1024 * 1024;

	/** 每会话的写串行化链（见头注释 ✓）。 */
	private readonly _chain = new Map<string, Promise<void>>();
	/** key → 上次压缩后累计的追加条数（重放日志时按实际条数恢复 ✓）。 */
	private readonly _appends = new Map<string, number>();
	/** key → 上次压缩后累计的追加字节数（条数阈值兜不住 MB 级消息 ⇒ 双阈值 ✓）。 */
	private readonly _bytes = new Map<string, number>();

	constructor(
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
		private readonly paths: AgentChatPaths,
		/** 读内存缓存（压缩时要写完整快照 ✓）；缓存归服务所有 ⇒ 回调注入 ✓。 */
		private readonly getCached: (key: string) => ChatMessage[] | undefined,
		/** 同步索引里的 messageCount（索引归服务所有 ⇒ 回调注入 ✓）。 */
		private readonly updateIndex: (agentId: string, sessionId: string, count: number) => Promise<void>,
	) { }

	async persistSnapshot(agentId: string, sessionId: string | undefined, messages: ChatMessage[]): Promise<void> {
		if (!sessionId) {
			return;
		} // No session assigned yet — skip per-file persist
		try {
			// ★ P0-1（2026-09-21）：本方法语义 = 「以 messages 为**完整权威**」⇒ 走快照路径
			//   （原子写 + 屏障 + 截断日志 ✓）。**增量追加**请用 `append` ✓ ——
			//   正常对话路径（append/update）已全部切换到追加；此处只剩「整段改写」的调用方：
			//   压缩后写回、LRU 淘汰前写回、加载期修复（refs 解析 / 内联大图清理）、
			//   deleteMessagesAfter（截断）✓。
			const key = this.paths.cacheKey(agentId, sessionId);
			await this.withLock(key, async () => {
				const { sessionsDirUri } = await this.paths.resolveAgentPaths(agentId);
				if (!(await this.fileService.exists(sessionsDirUri))) {
					await this.fileService.createFolder(sessionsDirUri);
				}
				await this.writeSnapshotLocked(agentId, sessionId, sessionsDirUri, messages);
			});
		} catch (err) {
			this.logService.error('[SessionHistoryStore] persistSnapshot failed:', err);
		}
	}

	/**
	 * ★ P0-1：写**快照**（完整会话）+ 屏障 + 截断日志。
	 *
	 * 语义 = 「以 `messages` 为完整权威」⇒ 此前写入的日志条目必须失效 ✓：
	 * ① 原子写快照（旧内容 / 新内容二选一，绝不半截 ✓）；
	 * ② 追加**屏障**：重放时屏障之前的条目一律丢弃 ✓（此步之后崩了也正确 ✓）；
	 * ③ 尽力删除日志（删不掉只是体积问题 ✓ 正确性已由屏障兜住 ✓）。
	 *
	 * ⚠ 必须在 {@link withLock} **内**调用 —— 三步之间不允许插入任何追加 ✗，
	 * 否则「先追加、后屏障」的那条追加会被重放丢弃（静默丢消息 ✗✓）。
	 */
	async writeSnapshotLocked(
		agentId: string,
		sessionId: string,
		sessionsDirUri: URI,
		messages: readonly ChatMessage[],
	): Promise<void> {
		if (!(await this.fileService.exists(sessionsDirUri))) {
			await this.fileService.createFolder(sessionsDirUri);
		}
		const fileUri = this.paths.sessionFileUri(sessionsDirUri, sessionId);
		// ★ 2026-09-15：**会话本体**是高频覆盖写、且启动即读 ⇒ 必须原子写（详见 common/atomicWrite.ts）。
		await writeFileAtomicSafe(this.fileService, fileUri, VSBuffer.fromString(JSON.stringify(messages, null, 2)));
		const logUri = this.paths.sessionLogUri(sessionsDirUri, sessionId);
		await appendFileSafe(this.fileService, logUri, VSBuffer.fromString(serializeSessionLogBarrier()));
		try {
			if (await this.fileService.exists(logUri)) { await this.fileService.del(logUri); }
		} catch { /* 删不掉无妨：重放遇到屏障即丢弃旧条目 ✓ */ }
		const key = this.paths.cacheKey(agentId, sessionId);
		this._appends.set(key, 0);
		this._bytes.set(key, 0);
		await this.updateIndex(agentId, sessionId, messages.length).catch(err =>
			this.logService.warn(
				`[SessionHistoryStore] session index update after snapshot failed for ${agentId}::${sessionId}: ${err instanceof Error ? err.message : err}`,
			),
		);
	}

	/** 同一会话的日志/快照写串行化（见 `_chain` 字段注释 ✓）。 */
	async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this._chain.get(key) ?? Promise.resolve();
		// ⚠ 前一笔失败不能阻塞后续 —— 否则一次写失败会让该会话**永久**无法落盘 ✗
		const run = prev.then(fn, fn);
		const tail = run.then(() => { }, () => { });
		this._chain.set(key, tail);
		try {
			return await run;
		} finally {
			if (this._chain.get(key) === tail) { this._chain.delete(key); }
		}
	}

	/**
	 * ★ P0-1：**追加**消息到会话日志（增量写 ✓，不动快照 ✓）。
	 *
	 * 累计条数超阈值时在锁内顺带压缩（快照 + 屏障 + 截断）⇒ 日志不会无限增长 ✓。
	 * 失败只记日志 —— 与改造前一致：落盘失败不该打断对话 ✓。
	 */
	async append(agentId: string, sessionId: string | undefined, msgs: readonly ChatMessage[]): Promise<void> {
		if (!sessionId || msgs.length === 0) { return; }
		const text = serializeSessionLogAppends(msgs);
		if (!text) { return; } // 全部无 id ⇒ 无法在重放时定位（写了只会变成重复气泡 ✗）
		const key = this.paths.cacheKey(agentId, sessionId);
		try {
			await this.withLock(key, async () => {
				const { sessionsDirUri } = await this.paths.resolveAgentPaths(agentId);
				if (!(await this.fileService.exists(sessionsDirUri))) {
					await this.fileService.createFolder(sessionsDirUri);
				}
				await appendFileSafe(this.fileService, this.paths.sessionLogUri(sessionsDirUri, sessionId), VSBuffer.fromString(text));
				const pending = (this._appends.get(key) ?? 0) + msgs.length;
				const pendingBytes = (this._bytes.get(key) ?? 0) + text.length;
				this._appends.set(key, pending);
				this._bytes.set(key, pendingBytes);
				if (pending >= SessionHistoryStore.COMPACT_AFTER
					|| pendingBytes >= SessionHistoryStore.COMPACT_AFTER_BYTES) {
					const messages = this.getCached(key);
					if (messages) {
						await this.writeSnapshotLocked(agentId, sessionId, sessionsDirUri, messages);
						this.logService.info(
							`[SessionHistoryStore] compacted session log ${key} after ${pending} appends → snapshot ${messages.length} msgs`,
						);
					} else {
						// 缓存已被 LRU 淘汰：无从写快照 ⇒ 只重置计数（下次加载按重放条数恢复 ✓）
						this._appends.set(key, 0);
						this._bytes.set(key, 0);
					}
				} else {
					const total = this.getCached(key)?.length ?? msgs.length;
					await this.updateIndex(agentId, sessionId, total).catch(err =>
						this.logService.warn(
							`[SessionHistoryStore] session index update failed for ${key}: ${err instanceof Error ? err.message : err}`,
						),
					);
				}
			});
		} catch (err) {
			this.logService.error('[SessionHistoryStore] append failed:', err);
		}
	}

	/** 按重放结果恢复压缩阈值计数（跨进程重启后依然有界 ✓）。 */
	setCounters(key: string, appends: number, bytes: number): void {
		this._appends.set(key, appends);
		this._bytes.set(key, bytes);
	}

	/** 清空某会话的计数（清空历史 / 删除会话时 ✓）。 */
	resetCounters(key: string): void {
		this._appends.delete(key);
		this._bytes.delete(key);
	}
}
