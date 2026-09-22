/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { AgentSessionMeta } from './sessionIndexStore.js';
import type { AgentChatPaths } from './agentChatPaths.js';
import type { SessionIndexStore } from './sessionIndexStore.js';
import type { SessionHistoryStore } from './sessionHistoryStore.js';
import type { SessionSidecarStore } from './sessionSidecarStore.js';
import type { MessageBucketCache } from './messageBucketCache.js';

/** 宿主注入面（store 直注 ✓ ⇒ 接口窄而实，不重复包装已存在的 store 方法 ✓）。 */
export interface ISessionLifecycleDeps {
	logService: ILogService;
	fileService: IFileService;
	paths: AgentChatPaths;
	/** 会话索引：内存权威 + 合并落盘（**必须替换 filtered 副本**，见 delete ✓）。 */
	index: SessionIndexStore;
	/** 会话历史写路径（删除时要重置压缩阈值计数 ✓）。 */
	history: SessionHistoryStore;
	/** 工具结果 sidecar（删除会话要清目录 ✓）。 */
	sidecar: SessionSidecarStore;
	/** 消息桶缓存（删除会话要清桶与访问记录 ✓）。 */
	buckets: MessageBucketCache;
	/** global history 回写（删除后要同步 ✓）。 */
	persistGlobalHistory: () => Promise<void>;
	/** 会话列表/元信息变化（pane 需要刷新列表 ✓）。 */
	fireSessionsChanged: (agentId: string) => void;
	/** **专门**的"会话被删除"事件（携带 sessionId ⇒ 正显示它的面板能切走 ✓）。 */
	fireSessionDeleted: (agentId: string, sessionId: string) => void;
}

/**
 * 会话**生命周期**：列表 / 用户是否改过名 / 新建 / 重命名 / 删除（从 `agentChatService.ts`
 * 原样搬出 ✓，2026-09-22 阶段④-f ✓）。
 *
 * ## 五条不可退化约定（注释随实现搬走 ✓）
 *  ① `listAgentSessions` 必须**先 flush** ✗✓：防抖窗口内的 messageCount/updatedAt 还在内存里，
 *     不 flush 会让列表的消息数与排序**滞后一个窗口** ✗。
 *  ② `isSessionUserRenamed` 走**内存权威副本**（不 flush、不读盘 ✓）—— 它的调用点是**发消息热路径** ✓；
 *     任何异常一律 `false`（宁可自动命名照旧，也不要让首条消息因查询失败而报错 ✗✓）。
 *  ③ `createAgentSession`：先确保 sessions 目录存在，再写**空数组**快照（原子写 ✓）⇒
 *     新建的会话一打开就是"已存在但无历史" ✓，不会走"文件不存在"分支 ✗。
 *  ④ `renameAgentSession`：`userInitiated` 才打 `userRenamed` 标记 ✗✓ —— **自动命名入口刻意不传**
 *     该选项，否则用户改的名字会在下次自动命名时被静默冲掉 ✗。
 *  ⑤ `deleteAgentSession`：日志与快照是**两份文件** ⇒ 删除必须成对 ✗✓（漏删会留下孤儿日志 ✓）；
 *     索引的**内存权威副本必须替换为 filtered** ✗✓（只写盘的话 `_updateSessionIndex` 仍看到已删条目
 *     并把它写回 ✓）；最后**专门 fire 删除事件**（删除可能由历史视图/会话浏览器发起 ⇒
 *     面板自身回调不会被调用 ✗✓）。
 */
export class SessionLifecycle {
	constructor(private readonly deps: ISessionLifecycleDeps) { }

	/**
 * List all sessions for an agent.
 * Reads from sessions.json index (fast, no file scanning).
 */
async listAgentSessions(agentId: string): Promise<AgentSessionMeta[]> {
	// 内存中可能有未落盘的 messageCount/updatedAt（防抖窗口内）→ 先 flush，
	// 否则列表显示的消息数/排序会滞后一个窗口。
	await this.deps.index.flush(agentId);
	const index = await this.deps.index.read(agentId);
	index.sort(
		(a, b) =>
			new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
	);
	return index;
}

/**
 * ★ 2026-09-20：该会话的名字是否由**用户手动**起的（见 {@link AgentSessionMeta.userRenamed}）。
 *
 * 供「首条消息自动命名」在写入前判断 —— 用户已经起过名字就不要再覆盖。
 * 走内存权威副本（不 flush、不读盘），因为调用点是发消息热路径。
 * 任何异常都返回 `false`（宁可自动命名照旧，也不要让首条消息因查询失败而报错）。
 */
async isSessionUserRenamed(agentId: string, sessionId: string): Promise<boolean> {
	try {
		const index = await this.deps.index.getForWrite(agentId);
		return index.find((s) => s.id === sessionId)?.userRenamed === true;
	} catch {
		return false;
	}
}

/**
 * Create a new session. Returns the full AgentSessionMeta.
 */
async createAgentSession(
	agentId: string,
	name?: string,
): Promise<AgentSessionMeta> {
	this.deps.logService.info(
		`[AgentChatService] createAgentSession: BEGIN agentId=${agentId}, name=${name ?? '(default)'}`,
	);
	const paths = await this.deps.paths.resolveAgentPaths(agentId);

	const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
	const now = new Date().toISOString();
	const meta: AgentSessionMeta = {
		id: sessionId,
		name: name || "新对话",
		createdAt: now,
		updatedAt: now,
		messageCount: 0,
	};

	if (!(await this.deps.fileService.exists(paths.sessionsDirUri))) {
		await this.deps.fileService.createFolder(paths.sessionsDirUri);
	}
	await this.deps.fileService.writeFile(
		this.deps.paths.sessionFileUri(paths.sessionsDirUri, sessionId),
		VSBuffer.fromString("[]"),
	);

	const index = await this.deps.index.getForWrite(agentId);
	index.push(meta);
	this.deps.index.dirty.add(agentId);
	await this.deps.index.flush(agentId);

	this.deps.logService.info(
		`[AgentChatService] createAgentSession: DONE sessionId=${sessionId}, agentId=${agentId}, indexSize=${index.length}`,
	);
	this.deps.fireSessionsChanged(agentId);
	return meta;
}

/**
 * Rename a session.
 */
async renameAgentSession(
	agentId: string,
	sessionId: string,
	newName: string,
	options?: { userInitiated?: boolean },
): Promise<void> {
	const index = await this.deps.index.getForWrite(agentId);
	const entry = index.find((s) => s.id === sessionId);
	if (!entry) {
		throw new Error(`Session ${sessionId} not found`);
	}
	entry.name = newName;
	entry.updatedAt = new Date().toISOString();
	// ★ 2026-09-20：用户手动命名 ⇒ 打标记，之后「首条消息自动命名」不再覆盖它。
	// 自动命名入口（NativeChatEditorPane / webview useChatStore）刻意**不传**该选项。
	if (options?.userInitiated) {
		entry.userRenamed = true;
	}
	this.deps.index.dirty.add(agentId);
	await this.deps.index.flush(agentId);
	this.deps.fireSessionsChanged(agentId);
}

/**
 * Delete a session. If it's the last one, it can still be deleted
 * (user will get a new session auto-created on next message).
 */
async deleteAgentSession(
	agentId: string,
	sessionId: string,
): Promise<void> {
	const paths = await this.deps.paths.resolveAgentPaths(agentId);
	const fileUri = this.deps.paths.sessionFileUri(paths.sessionsDirUri, sessionId);
	try {
		await this.deps.fileService.del(fileUri);
	} catch {
		/* ignore */
	}
	// ★ P0-1：日志与快照是**两份文件** ⇒ 删除必须成对 ✗（漏删会留下孤儿日志 ✓）
	try {
		const logUri = this.deps.paths.sessionLogUri(paths.sessionsDirUri, sessionId);
		if (await this.deps.fileService.exists(logUri)) { await this.deps.fileService.del(logUri); }
	} catch {
		/* ignore */
	}
	this.deps.history.resetCounters(this.deps.paths.cacheKey(agentId, sessionId));
	// P1: clean up sidecar directory
	await this.deps.sidecar.deleteDir(agentId, sessionId);

	const index = await this.deps.index.getForWrite(agentId);
	const filtered = index.filter((s) => s.id !== sessionId);
	// 删除后内存权威副本必须替换为过滤后的数组（不能只写盘），否则后续
	// _updateSessionIndex 仍看到已删条目并把它写回。
	this.deps.index.data.set(agentId, { index: filtered, loadedAt: Date.now() });
	this.deps.index.dirty.add(agentId);
	await this.deps.index.flush(agentId);

	// Remove from memory cache
	// ★ 2026-09-22：改用 `MessageBucketCache.dropBucket` ✓ —— 同一动作**收口到一处** ⇒ "纯内存、
	//   不 externalize、不 persist" 的纪律由该类单测钉住 ✓（此前这里是内联的两行 delete ⇒
	//   谁也无法从调用点看出"它不该落盘" ✗✓）。**行为逐字不变** ✓（dropBucket 就是这两行 ✓）。
	this.deps.buckets.dropBucket(agentId, sessionId);
	await this.deps.persistGlobalHistory();

	this.deps.logService.info(
		`[AgentChatService] Deleted session ${sessionId} for ${agentId}`,
	);
	this.deps.fireSessionsChanged(agentId);
	// ★ 2026-09-12：专门通知「被删的是哪个会话」，让正显示它的聊天面板能切走
	//   （删除可能由历史视图 / 会话浏览器发起，面板自身回调不会被调用）。
	this.deps.fireSessionDeleted(agentId, sessionId);
}
}
