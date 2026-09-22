/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { writeFileAtomicSafe } from '../common/atomicWrite.js';
import type { IForkContext } from '../common/forkContext.js';
import type { AgentChatPaths } from './agentChatPaths.js';

/**
 * Metadata for one agent-level session.
 * Stored in chat-history/{agentId}/sessions.json as an array.
 *
 * ★ 2026-09-22（阶段③b）：类型随索引簇一并搬到本模块 ✓，`agentChatService.ts` 仍**再导出**
 *   ⇒ 所有既有 import 方零改动 ✓✓。
 */
export interface AgentSessionMeta {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	/**
	 * ★ 2026-09-20（用户需求）：**这个名字是用户手动起的**。
	 *
	 * 首条消息发出去时，`NativeChatEditorPane` / webview `useChatStore` 会把会话名
	 * 自动改成「消息前 30 字」（因为新会话的占位名是「新对话」，没信息量）。
	 * 但如果用户已经手动改过名（侧栏铅笔 / 页签 Rename / 聊天框 Rename），
	 * 那次自动命名就会**把用户起的名字覆盖掉** —— 用户报的正是这个。
	 *
	 * 显式字段（而不是去猜「名字像不像自动生成的」——形态判断会随命名规则变化静默失效）：
	 * 手动改名入口传 `userInitiated` ⇒ 打上本标记；两个自动命名入口先检查它，置位即跳过。
	 */
	userRenamed?: boolean;
	/** External provider session ID (e.g. Knot AG-UI threadId). Captured from stream metadata. */
	providerSessionId?: string;
	/**
	 * Fork prefix-cache fingerprint (MiMo-inspired). Set when this session was forked
	 * from a parent whose frozen system+tools prefix is reused so the LLM provider's
	 * prompt cache hits instead of re-billing the stable prefix every turn.
	 */
	forkContextFingerprint?: string;
	/**
	 * Fork 前缀缓存上下文（MiMo ForkContext）— 请求构造端接 ForkContext 的完整形态。
	 * 携带父级冻结的 system+tools 前缀。fork 会话由 forkAgentSession 持久化父级
	 * ForkContext；后续 sendMessage 经 session.forkContext 透传到 IAgentTurnRequest，
	 * 使子会话请求与父级前缀对齐 → 命中 provider prompt cache。非 fork 会话为 undefined。
	 */
	forkContext?: IForkContext;
}

/**
 * 会话索引（`chat-history/{agentId}/sessions.json`）—— 从 `agentChatService.ts` 拆出的独立簇
 * ✓（2026-09-22 阶段③b）。
 *
 * ## 内存权威 + 合并落盘（2026-08-20 的性能修复，随簇一起搬 ✓）
 * 此前每条消息都「读盘 + parse + 原子写盘」一次 ✗（日志 1787214724132：单 turn 51 条 assistant
 * 消息 ⇒ 51 读 + 51 写，`_readSessionIndex(saros-claw): 20 sessions found` 连刷 50+ 次 ✓）。
 * 现在：完整索引常驻内存作为**写路径权威** ✓，`messageCount/updatedAt` 这类高频更新只改内存 +
 * 防抖落盘 ✓；而 `createAgentSession/rename/delete/fork` 等**结构性变更立即落盘** ✓（不能丢 ✓）。
 *
 * ## 三条不可退化约定 ✗✓
 *  ① **缺失/空/损坏一律自愈**（`_recoverFromDir` ✓）：索引丢了 ≠ 没有会话 ✗ —— 曾把空文件当
 *     "合法空索引"，随后任何一次 flush 都把空数组写回 ⇒ **永久丢失**（事故 20260912T145937：
 *     聊天框「0 sessions」+ 历史列表却列得出 ✓）。
 *  ② **dirty 期间禁止按 TTL 重读磁盘** ✗：否则内存里的修改被磁盘旧值覆盖 ✓。
 *  ③ **每个 agent 一条写链**（`writeQueue` ✓）：读写-改-写交错会把 JSON 截断 ✓。
 *
 * 暴露 `data`/`dirty`/`flushTimers`/`writeQueue`/`cache` 为 `readonly` 供宿主直接操作 ✓ ——
 * 会话 CRUD（create/rename/delete/fork ✓）需要就地改内存权威副本，为它再造一层 API 只会
 * 增加噪音 ✓；集合归属仍在本模块 ⇒ 拆分是实的 ✓✓。
 */
export class SessionIndexStore {
	/** agentId → 完整 index 内存副本（写路径权威 ✓）。 */
	readonly data = new Map<string, { index: AgentSessionMeta[]; loadedAt: number }>();
	/** agentId → 尚未落盘（dirty）。dirty 期间禁止按 TTL 重读磁盘，否则丢失内存修改 ✓。 */
	readonly dirty = new Set<string>();
	/** agentId → 防抖落盘定时器句柄 ✓。 */
	readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Per-agentId promise chain serialising session-index read-modify-write（防交错截断 JSON ✓）。 */
	readonly writeQueue = new Map<string, Promise<void>>();
	/** Short-lived cache: agentId → session index（避免每次任务执行 4–5s 文件读 ✓）。 */
	cache: Map<string, { meta: AgentSessionMeta; ts: number }> | undefined;

	/** 防抖窗口：turn 内连续 append 合并为一次写；崩溃最多丢这段时间的 messageCount ✓。 */
	private static readonly FLUSH_DELAY_MS = 800;
	/** 内存副本存活时间（无 dirty 时）。多实例场景下过期后重读，感知外部修改 ✓。 */
	private static readonly DATA_TTL_MS = 10_000;

	constructor(
		private readonly fileService: IFileService,
		private readonly logService: ILogService,
		private readonly paths: AgentChatPaths,
		/** 索引变更通知（宿主据此刷新会话列表 ✓）；事件源仍归宿主 ✓。 */
		private readonly onIndexChanged: (agentId: string) => void,
	) { }

	async read(agentId: string): Promise<AgentSessionMeta[]> {
		try {
			const paths = await this.paths.resolveAgentPaths(agentId);
			if (!(await this.fileService.exists(paths.indexUri))) {
				// ★ 2026-09-12：索引文件不存在 ≠ 没有会话 —— 可能是索引丢失。
				//   见 _recoverFromDir 的事故说明。
				return await this._recoverFromDir(agentId, 'missing');
			}
			const content = await this.fileService.readFile(paths.indexUri);
			const text = content.value.toString();
			// ★ 2026-09-12 修正：原实现把空文件当「合法空索引」，并注释称
			//   「由下次 updateCount 恢复」——**该假设是错的**：
			//   ① `updateCount` 只在该会话**首次 append** 时 push，不会重建已丢失的条目；
			//   ② 本函数返回的 `[]` 会被 `getForWrite` 设为内存**写权威**，
			//      之后任何一次 flush 都把空数组写回磁盘 → 空状态被固化 → **永久丢失**。
			//   事故（日志 20260912T145937）：sessions.json 变空后重启，聊天框读到
			//   「0 sessions」→ 新建空会话 → 用户看到历史会话全部消失；而会话文件其实
			//   还在 sessions/ 目录里（SessionHistoryView 扫目录仍列得出）。
			//   现在：缺失 / 空 / 损坏 一律尝试从目录重建。
			if (text.trim().length === 0) {
				return await this._recoverFromDir(agentId, 'empty');
			}
			const parsed = JSON.parse(text) as AgentSessionMeta[];
			// 2026-08-20：原先每次读盘都 info 一行，turn 内连刷 50+ 次（日志
			// 1787214724132）。写路径已改为内存权威 + 防抖落盘，此处读盘应变得罕见；
			// 仅在索引异常庞大时告警，正常情况保持静默（trace 级留给排障）。
			if (parsed.length > 200) {
				this.logService.warn(`[SessionIndexStore] read(${agentId}): ${parsed.length} sessions — index is large, consider pruning`);
			} else {
				this.logService.trace(`[SessionIndexStore] read(${agentId}): ${parsed.length} sessions found`);
			}
			return parsed;
		} catch (err) {
			this.logService.warn(`[SessionIndexStore] read(${agentId}) error:`, err);
			// ★ JSON 损坏（半截写入等）同样走重建，而不是返回空索引。
			return await this._recoverFromDir(agentId, 'corrupt');
		}
	}

	/**
	 * ★ 2026-09-12：索引 缺失/为空/损坏 时的**自愈** —— 从 `sessions/` 目录重建。
	 *
	 * **为何需要**：`getOrCreateActiveSession` 只信任 `sessions.json`，而
	 * `SessionHistoryView._discoverAgentIds` 是**扫目录**的。索引一丢，聊天框就认为
	 * 「无会话」并新建空会话，历史列表却仍列得出会话 —— 用户看到「聊天框空白 / 历史消失」。
	 * 会话文件本身通常还在（丢的只是索引），所以重建即可**全量恢复**。
	 *
	 * 代价可控：只在索引异常时触发（正常路径**不**扫目录）；重建结果立即写回，
	 * 之后走正常路径。
	 *
	 * `messageCount` 置 0 而不读每个会话文件 —— 避免为几十 MB 的历史付解析成本；
	 * 该会话下次 append 时由 `updateCount` 刷新为真实值 ✓。名称同理无法恢复（用文件名占位 ✓）。
	 */
	private async _recoverFromDir(agentId: string, reason: 'missing' | 'empty' | 'corrupt'): Promise<AgentSessionMeta[]> {
		const rebuilt: AgentSessionMeta[] = [];
		try {
			const paths = await this.paths.resolveAgentPaths(agentId);
			if (await this.fileService.exists(paths.sessionsDirUri)) {
				const children = await this.fileService.resolve(paths.sessionsDirUri);
				for (const child of children.children ?? []) {
					if (child.isDirectory || !child.name.endsWith('.json')) { continue; }
					const id = child.name.slice(0, -'.json'.length);
					let updatedAt = new Date().toISOString();
					try { updatedAt = new Date((await this.fileService.stat(child.resource)).mtime).toISOString(); } catch { /* 用当前时间兜底 ✓ */ }
					rebuilt.push({ id, name: id, createdAt: updatedAt, updatedAt, messageCount: 0 });
				}
			}
			this.logService.warn(
				`[SessionIndexStore] index ${reason} for ${agentId} — rebuilt ${rebuilt.length} session(s) from sessions/ dir`,
			);
		} catch (err) {
			this.logService.warn(`[SessionIndexStore] recoverFromDir(${agentId}) failed:`, err);
		}
		// 立即写回（不 await：调用方只读索引；写失败下次再自愈 ✓）
		void this.writeQueued(agentId, rebuilt).catch(() => { });
		return rebuilt;
	}

	async write(agentId: string, index: AgentSessionMeta[]): Promise<void> {
		try {
			const paths = await this.paths.resolveAgentPaths(agentId);
			if (!(await this.fileService.exists(paths.sessionsDirUri))) {
				await this.fileService.createFolder(paths.sessionsDirUri);
			}
			// 会话索引是「启动即读」的：必须原子写，否则半截 JSON ⇒ 读侧报损坏（见 atomicWrite.ts ✓）
			await writeFileAtomicSafe(this.fileService, paths.indexUri, VSBuffer.fromString(JSON.stringify(index, null, 2)));
			// 写成功 ⇒ 失效短时缓存（下次 getOrCreateActiveSession 拿到新数据 ✓）
			this.cache?.delete(agentId);
		} catch (err) {
			this.logService.warn(`[SessionIndexStore] write(${agentId}) failed:`, err);
		}
	}

	/**
	 * 取「写路径权威」索引：优先内存副本（dirty 或 未过期 ✓），否则读盘并落内存 ✓。
	 *
	 * ⚠ dirty 时**必须**用内存副本 ✗✓：否则磁盘上的旧值会覆盖内存里的未落盘修改 ✓。
	 */
	async getForWrite(agentId: string): Promise<AgentSessionMeta[]> {
		const held = this.data.get(agentId);
		const fresh = held && (Date.now() - held.loadedAt) < SessionIndexStore.DATA_TTL_MS;
		if (held && (this.dirty.has(agentId) || fresh)) {
			return held.index;
		}
		const index = await this.read(agentId);
		this.data.set(agentId, { index, loadedAt: Date.now() });
		return index;
	}

	/** 标记 dirty 并安排防抖落盘（同一 agent 的多次调用合并为一次写 ✓）。 */
	scheduleFlush(agentId: string): void {
		this.dirty.add(agentId);
		const existing = this.flushTimers.get(agentId);
		if (existing !== undefined) {
			// 已有 pending 定时器：重置窗口（turn 内连续 append 只落盘一次 ✓）
			clearTimeout(existing);
			this.flushTimers.delete(agentId);
		}
		const timer = setTimeout(() => {
			void this.flush(agentId).catch(() => { });
		}, SessionIndexStore.FLUSH_DELAY_MS);
		this.flushTimers.set(agentId, timer);
	}

	/** 立即把内存权威副本落盘（结构性变更 / 关窗兜底 ✓）。 */
	async flush(agentId: string): Promise<void> {
		const timer = this.flushTimers.get(agentId);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.flushTimers.delete(agentId);
		}
		if (!this.dirty.has(agentId)) { return; }
		const held = this.data.get(agentId);
		if (!held) { this.dirty.delete(agentId); return; }
		// ⚠ 先清 dirty 再写：写失败也不重试（下次变更会再置 dirty）⇒ 不产生写风暴 ✓
		this.dirty.delete(agentId);
		await this.writeQueued(agentId, held.index);
	}

	/** 同一 agent 的索引写串行化（防读写-改-写交错截断 JSON ✓）。 */
	private async writeQueued(agentId: string, index: AgentSessionMeta[]): Promise<void> {
		const prev = this.writeQueue.get(agentId) ?? Promise.resolve();
		// 快照索引（写入期间调用方可能继续改内存副本 ⇒ 不能写活引用 ✓）
		const snapshot = JSON.parse(JSON.stringify(index)) as AgentSessionMeta[];
		const run = prev.catch(() => { }).then(() => this._writeWithTimeout(agentId, snapshot));
		this.writeQueue.set(agentId, run);
		try {
			await run;
		} finally {
			if (this.writeQueue.get(agentId) === run) {
				this.writeQueue.delete(agentId);
			}
		}
	}

	/**
	 * 带**硬超时**的索引写（2026-09-07 关窗卡死事故后加 ✓）。
	 *
	 * 为什么需要：`write` 的 try/catch 只能兜**异常**，兜不住"永不 settle"的 I/O 挂起 ✗ ——
	 * 关窗时 `onWillShutdown` 的 join 会因此**永久阻塞**（用户报「点 close 没反应」✓）。
	 */
	private async _writeWithTimeout(agentId: string, index: AgentSessionMeta[]): Promise<void> {
		const WRITE = `done`;
		const result = await Promise.race([
			this.write(agentId, index).then(() => WRITE),
			new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 3000)),
		]);
		if (result !== WRITE) {
			this.logService.warn(`[SessionIndexStore] write(${agentId}) timed out after 3000ms — gave up (index fields may be stale)`);
		}
	}

	/**
	 * Ensure a session exists in the index; update messageCount + updatedAt.
	 * If the session doesn't exist yet, auto-create it (supports first-message auto-create).
	 *
	 * 2026-08-20：高频路径（每条消息都会调用）不再每次读写磁盘 —— 只更新内存权威副本
	 * 并安排防抖落盘。新建 session 这类结构性变更立即落盘（不能丢）✓。
	 */
	async updateCount(agentId: string, sessionId: string, messageCount: number): Promise<void> {
		const index = await this.getForWrite(agentId);
		const now = new Date().toISOString();
		const entry = index.find((s) => s.id === sessionId);
		if (!entry) {
			// 新 session 首次入索引：结构性变更，立即落盘，避免崩溃后会话「消失」✓。
			index.push({
				id: sessionId,
				name: `新对话`,
				createdAt: now,
				updatedAt: now,
				messageCount,
			});
			this.dirty.add(agentId);
			await this.flush(agentId);
			this.onIndexChanged(agentId);
			return;
		}
		// 已存在：仅 messageCount/updatedAt 变化 → 内存改动 + 防抖落盘。
		// 值未变则连事件都不用发（避免 UI 无谓刷新 ✓）。
		if (entry.messageCount === messageCount) { return; }
		entry.messageCount = messageCount;
		entry.updatedAt = now;
		this.scheduleFlush(agentId);
		this.onIndexChanged(agentId);
	}

	/** 落盘所有 dirty 的索引（关窗兜底 ✓）。 */
	async flushAll(): Promise<void> {
		for (const timer of this.flushTimers.values()) { clearTimeout(timer); }
		this.flushTimers.clear();
		await Promise.all(
			[...this.dirty].map(agentId => this.flush(agentId).catch(() => { })),
		);
	}
}
