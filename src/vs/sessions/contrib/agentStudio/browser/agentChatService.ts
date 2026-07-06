/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/* eslint-disable local/code-no-unexternalized-strings */
import { Disposable } from "../../../../base/common/lifecycle.js";
import { Emitter, Event } from "../../../../base/common/event.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import {
	IAgentChatService,
	IAgentStudioService,
} from "../common/agentStudio.js";
import type {
	IChatStreamDelta,
	IChatSendOptions,
} from "../common/agentStudio.js";
import { IAgentDriverService } from "../common/agentDriver.js";
import type { ChatMessage } from "../common/types.js";
import { deriveMessageParts } from "../common/types.js";
import type { IChatMessage } from "../common/providers.js";
import { IFileService } from "../../../../platform/files/common/files.js";
import { IEnvironmentService } from "../../../../platform/environment/common/environment.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { URI } from "../../../../base/common/uri.js";
import { VSBuffer } from "../../../../base/common/buffer.js";
import {
	AGENT_STUDIO_DATA_PATH_SETTING,
	DATA_FILE_CHAT_HISTORY,
	WORKSPACE_DATA_DIR,
	AGENTS_DIR,
} from "../common/constants.js";

// ─── Agent Session Index ────────────────────────────────────────────────────

/**
 * Metadata for one agent-level session.
 * Stored in agents/{slug}/sessions.json as an array.
 */
export interface AgentSessionMeta {
	id: string;
	name: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	/** External provider session ID (e.g. Knot AG-UI threadId). Captured from stream metadata. */
	providerSessionId?: string;
}

// ─── Service ────────────────────────────────────────────────────────────────

/**
 * AgentChatService — chat history persistence + agent session management.
 *
 * Storage layout (simplified, per-agent):
 *   agents/{slug}/sessions.json          ← session index (array of AgentSessionMeta)
 *   agents/{slug}/sessions/default.json  ← messages for default session
 *   agents/{slug}/sessions/{id}.json     ← messages for other sessions
 *
 * Global fallback (for agents without workspace path):
 *   {userRoamingDataHome}/agent-studio/chat-history.json
 */
export class AgentChatService extends Disposable implements IAgentChatService {
	declare readonly _serviceBrand: undefined;

	private readonly _activeStreams = new Map<string, AbortController>();
	private readonly logService: ILogService;
	private readonly driverService: IAgentDriverService;
	private readonly fileService: IFileService;
	private readonly environmentService: IEnvironmentService;
	private readonly configurationService: IConfigurationService;
	private readonly studioService: IAgentStudioService;

	/**
	 * 当前活跃的 onDelta 回调集合。
	 *
	 * 历史实现是单例 `_activeOnDelta`，第二个并发 sendMessage 会覆盖第一个的
	 * 回调，导致第一个流的 memory 事件无法到达 UI（跨流串台根因）。
	 * 改为按 streamKey（agentId::sessionId）分桶，支持同一 agent 下多个会话
	 * 并发流式输出。
	 */
	private readonly _activeOnDeltas = new Map<string, (delta: IChatStreamDelta) => void>();
	/** 每个 streamKey 的创建时间，用于在内存事件桥接时选出"最近一次"流。 */
	private readonly _streamCreatedAt = new Map<string, number>();
	/** provider 事件取消订阅函数 */
	private _memoryEventUnsub: (() => void) | null = null;
	/** 内存事件桥接是否已建立（幂等，只建立一次） */
	private _memoryBridgeReady = false;

	/** In-memory cache: compositeKey → messages */
	private readonly _historyCache = new Map<string, ChatMessage[]>();
	private _historyLoaded = false;
	private _globalDataUri: URI | undefined;

	private readonly _onDidChangeAgentSessionsEmitter = this._register(
		new Emitter<{ agentId: string }>(),
	);
	readonly onDidChangeAgentSessions: Event<{ agentId: string }> =
		this._onDidChangeAgentSessionsEmitter.event;

	private readonly _onDidStreamDeltaEmitter = this._register(
		new Emitter<{ agentId: string; sessionId: string; delta: IChatStreamDelta }>(),
	);
	readonly onDidStreamDelta: Event<{ agentId: string; sessionId: string; delta: IChatStreamDelta }> =
		this._onDidStreamDeltaEmitter.event;

	constructor(
		@ILogService logService: ILogService,
		@IAgentDriverService driverService: IAgentDriverService,
		@IFileService fileService: IFileService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IConfigurationService configurationService: IConfigurationService,
		@IAgentStudioService studioService: IAgentStudioService,
	) {
		super();
		this.logService = logService;
		this.driverService = driverService;
		this.fileService = fileService;
		this.environmentService = environmentService;
		this.configurationService = configurationService;
		this.studioService = studioService;
	}

	// ─── Path helpers ────────────────────────────────────────────────────────

	private _getGlobalDataUri(): URI {
		if (!this._globalDataUri) {
			const customPath = this.configurationService.getValue<string>(
				AGENT_STUDIO_DATA_PATH_SETTING,
			);
			this._globalDataUri = customPath
				? URI.file(customPath)
				: URI.joinPath(
					this.environmentService.userRoamingDataHome,
					"agent-studio",
				);
		}
		return this._globalDataUri;
	}

	private _getHistoryFileUri(): URI {
		return URI.joinPath(this._getGlobalDataUri(), DATA_FILE_CHAT_HISTORY);
	}

	/**
	 * Resolve the sessions directory and index file URI for an agent.
	 *
	 * Pure agent model — there is NO agent/instance indirection:
	 *   - The agent's own id is the on-disk directory name.
	 *   - The storage root follows the currently active workspace
	 *     (workspace.path), falling back to the global data dir when no
	 *     workspace is active or it has no disk path.
	 *
	 * Layout: {root}/data/agents/{agentId}/sessions(.json)
	 */
	private async _resolveAgentPaths(agentId: string): Promise<{
		sessionsDirUri: URI;
		indexUri: URI;
	}> {
		// Determine the storage root from the active workspace, if any.
		let rootUri: URI;
		const activeWorkspaceId = this.studioService.getActiveWorkspaceId();
		if (activeWorkspaceId) {
			const workspace = await this.studioService.getWorkspace(activeWorkspaceId);
			rootUri = workspace?.path
				? URI.file(workspace.path)
				: this._getGlobalDataUri();
		} else {
			rootUri = this._getGlobalDataUri();
		}

		const agentUri = URI.joinPath(
			rootUri,
			WORKSPACE_DATA_DIR,
			AGENTS_DIR,
			agentId,
		);
		return {
			sessionsDirUri: URI.joinPath(agentUri, "sessions"),
			indexUri: URI.joinPath(agentUri, "sessions.json"),
		};
	}

	private _sessionFileUri(sessionsDirUri: URI, sessionId: string): URI {
		return URI.joinPath(sessionsDirUri, `${sessionId}.json`);
	}

	private _cacheKey(agentId: string, sessionId?: string): string {
		return sessionId ? `${agentId}::${sessionId}` : agentId;
	}

	// ─── Global history (fallback) ───────────────────────────────────────────

	private async _ensureHistoryLoaded(): Promise<void> {
		if (this._historyLoaded) {
			return;
		}
		this._historyLoaded = true;
		try {
			const uri = this._getHistoryFileUri();
			if (!(await this.fileService.exists(uri))) {
				return;
			}
			const content = await this.fileService.readFile(uri);
			const data = JSON.parse(content.value.toString()) as Record<
				string,
				ChatMessage[]
			>;
			for (const [key, messages] of Object.entries(data)) {
				this._historyCache.set(key, messages);
			}
			this.logService.info(
				`[AgentChatService] Loaded global history: ${this._historyCache.size} keys`,
			);

			// 🔒 启动期净化（2026-06-05）：noSession 桶（key 不含 `::`，即 `agentId`
			// 本身）历史上沉积过 user/assistant/tool 消息，会被 getHistory 在每次 session
			// 请求时 merge system 消息时报警 dropped X non-system messages，并增加 IO。
			// 在加载完成后立刻把所有 noSession 桶过滤为仅 system 消息，并回写 global
			// history 文件，让磁盘也保持干净。
			let dirty = false;
			let totalDropped = 0;
			for (const [key, messages] of this._historyCache) {
				if (key.includes('::')) { continue; }
				const systemOnly = messages.filter(m => m.role === 'system');
				if (systemOnly.length !== messages.length) {
					totalDropped += messages.length - systemOnly.length;
					this._historyCache.set(key, systemOnly);
					dirty = true;
				}
			}
			if (dirty) {
				this.logService.warn(
					`[AgentChatService] Startup sanitize: dropped ${totalDropped} non-system messages from noSession buckets`,
				);
				this._persistGlobalHistory().catch((err) =>
					this.logService.error('[AgentChatService] Startup sanitize persist failed:', err),
				);
			}
		} catch (err) {
			this.logService.error(
				"[AgentChatService] Failed to load global history:",
				err,
			);
		}
	}

	private async _persistGlobalHistory(): Promise<void> {
		try {
			const dirUri = this._getGlobalDataUri();
			if (!(await this.fileService.exists(dirUri))) {
				await this.fileService.createFolder(dirUri);
			}
			const data: Record<string, ChatMessage[]> = {};
			for (const [key, messages] of this._historyCache) {
				data[key] = messages;
			}
			await this.fileService.writeFile(
				this._getHistoryFileUri(),
				VSBuffer.fromString(JSON.stringify(data, null, 2)),
			);
		} catch (err) {
			this.logService.error(
				"[AgentChatService] Failed to persist global history:",
				err,
			);
		}
	}

	// ─── Per-agent session file persistence ──────────────────────────────────

	private async _persistToSessionFile(
		agentId: string,
		sessionId: string | undefined,
		messages: ChatMessage[],
	): Promise<void> {
		if (!sessionId) {
			return;
		} // No session assigned yet — skip per-file persist
		try {
			const { sessionsDirUri } = await this._resolveAgentPaths(agentId);
			if (!(await this.fileService.exists(sessionsDirUri))) {
				await this.fileService.createFolder(sessionsDirUri);
			}
			const fileUri = this._sessionFileUri(sessionsDirUri, sessionId);
			await this.fileService.writeFile(
				fileUri,
				VSBuffer.fromString(JSON.stringify(messages, null, 2)),
			);
			await this._updateSessionIndex(agentId, sessionId, messages.length);
		} catch (err) {
			this.logService.error(
				"[AgentChatService] _persistToSessionFile failed:",
				err,
			);
		}
	}

	private async _loadFromSessionFile(
		agentId: string,
		sessionId?: string,
	): Promise<ChatMessage[]> {
		if (!sessionId) {
			return [];
		} // No session specified — nothing to load
		try {
			const paths = await this._resolveAgentPaths(agentId);
			const fileUri = this._sessionFileUri(paths.sessionsDirUri, sessionId);
			if (!(await this.fileService.exists(fileUri))) {
				return [];
			}
			const content = await this.fileService.readFile(fileUri);
			return JSON.parse(content.value.toString()) as ChatMessage[];
		} catch {
			return [];
		}
	}

	// ─── Session Index (sessions.json) ───────────────────────────────────────

	private async _readSessionIndex(
		agentId: string,
	): Promise<AgentSessionMeta[]> {
		try {
			const paths = await this._resolveAgentPaths(agentId);
			if (!(await this.fileService.exists(paths.indexUri))) {
				return [];
			}
			const content = await this.fileService.readFile(paths.indexUri);
			return JSON.parse(content.value.toString()) as AgentSessionMeta[];
		} catch {
			return [];
		}
	}

	private async _writeSessionIndex(
		agentId: string,
		index: AgentSessionMeta[],
	): Promise<void> {
		try {
			const paths = await this._resolveAgentPaths(agentId);
			await this.fileService.writeFile(
				paths.indexUri,
				VSBuffer.fromString(JSON.stringify(index, null, 2)),
			);
		} catch (err) {
			this.logService.error(
				"[AgentChatService] Failed to write session index:",
				err,
			);
		}
	}

	/**
	 * Ensure a session exists in the index; update messageCount + updatedAt.
	 * If the session doesn't exist yet, auto-create it (supports first-message auto-create).
	 */
	private async _updateSessionIndex(
		agentId: string,
		sessionId: string,
		messageCount: number,
	): Promise<void> {
		const index = await this._readSessionIndex(agentId);
		const now = new Date().toISOString();
		let entry = index.find((s) => s.id === sessionId);
		if (!entry) {
			entry = {
				id: sessionId,
				name: `新对话`,
				createdAt: now,
				updatedAt: now,
				messageCount,
			};
			index.push(entry);
		} else {
			entry.messageCount = messageCount;
			entry.updatedAt = now;
		}
		await this._writeSessionIndex(agentId, index);
		this._onDidChangeAgentSessionsEmitter.fire({ agentId });
	}

	// ─── Public: appendMessage ───────────────────────────────────────────────

	async appendMessage(agentId: string, message: ChatMessage): Promise<void> {
		await this._ensureHistoryLoaded();
		// 🔒 严格隔离写入侧（2026-06-05）：
		// 之前任何 user/assistant/tool 落到 noSession 桶（agentSessionId=undefined）
		// 都会被 getHistory 整桶 merge 出来污染所有 session。这里在源头拦截：仅
		// system 消息允许 noSession（task orchestration 全局注入用途），其它角色
		// 必须带 agentSessionId，否则丢弃并告警，避免日后再次串台。
		if (!message.agentSessionId && message.role !== 'system') {
			this.logService.warn(
				`[AgentChatService] appendMessage: dropping ${message.role} message without agentSessionId for ${agentId} (cross-session leakage guard) - content="${(message.content || '').substring(0, 60)}"`,
			);
			return;
		}
		const key = this._cacheKey(agentId, message.agentSessionId);
		let messages = this._historyCache.get(key);
		if (!messages) {
			messages = [];
			this._historyCache.set(key, messages);
		}
		// 🔒 写入侧去重（2026-06-05）：阻止连续重复的 user 消息落盘。
		// 历史双写 race（webview controller `_handleChatSend` 先 append 一次，随后
		// service `sendMessage` 的 5 秒 dedup 守卫在跨时序/进程下偶发失效又 append
		// 一次）导致 session 文件里同一条 user 消息相邻出现两次。这里在 cache 末尾
		// 做强一致检查：若新来的 user 消息与**末尾一条** user 消息 content 完全相同，
		// 直接丢弃，不依赖时间窗口。assistant/tool 不做此限制（同内容可能合法重复）。
		if (message.role === 'user') {
			const last = messages[messages.length - 1];
			if (last && last.role === 'user' && (last.content ?? '') === (message.content ?? '')) {
				this.logService.warn(
					`[AgentChatService] appendMessage: dropping consecutive duplicate user message for ${key} - content="${(message.content || '').substring(0, 40)}"`,
				);
				return;
			}
		}
		messages.push(message);

		// Dual-write: global fallback + per-agent session file
		this._persistGlobalHistory().catch((err) =>
			this.logService.error("[AgentChatService] Global persist failed:", err),
		);
		this._persistToSessionFile(
			agentId,
			message.agentSessionId,
			messages,
		).catch((err) =>
			this.logService.error(
				"[AgentChatService] Session file persist failed:",
				err,
			),
		);
	}

	// ─── Public: updateMessage ─────────────────────────────────────────────
	/**
	 * Update an existing message in cache + session file.
	 * Used by workflow trace deltas (workflowExecutions/events/collectVariables)
	 * which mutate an existing assistant message in-place.
	 */
	async updateMessage(
		agentId: string,
		sessionId: string | undefined,
		messageId: string,
		updates: Partial<ChatMessage>,
	): Promise<void> {
		await this._ensureHistoryLoaded();
		const key = this._cacheKey(agentId, sessionId);
		const messages = this._historyCache.get(key);
		if (!messages) { return; }
		const idx = messages.findIndex(m => m.id === messageId);
		if (idx < 0) { return; }
		// In-place update (mutate the cached object so panel.updateMessage also sees it)
		Object.assign(messages[idx], updates);
		// Persist
		await this._persistToSessionFile(agentId, sessionId, messages);
	}

	// ─── Public: getHistory / clearHistory ──────────────────────────────────

	async getHistory(
		agentId: string,
		sessionId?: string,
	): Promise<ChatMessage[]> {
		await this._ensureHistoryLoaded();
		const key = this._cacheKey(agentId, sessionId);
		let messages = this._historyCache.get(key);

		if (!messages || messages.length === 0) {
			messages = await this._loadFromSessionFile(agentId, sessionId);
			if (messages.length > 0) {
				this._historyCache.set(key, messages);
			}
		}

		// When a sessionId is specified, also include messages stored with
		// agentSessionId=undefined (e.g. task orchestration system messages).
		// These messages belong to the agent globally, not to any specific session,
		// so they should appear regardless of which session is active.
		//
		// 🔒 严格隔离修复（2026-06-05）：
		// 历史上 noSession 桶（key === agentId，无 sessionId）在多条路径下被错误
		// 写入过 user / assistant / tool 消息（旧 webview controller 首消息分配 session
		// 之前的临时持久化、错误回收路径、跨 worktree 共用 agentId 的旧数据等）。
		// 之前不加过滤地整桶 merge 进来，会让一个全新 sessionId 的会话立即看到
		// **几百条** 跨主题、跨 worktree 的历史（含重复 user 消息）。
		//
		// 真正需要透传的只有 task orchestration 注入的 **system 消息**。其它角色一律
		// 丢弃，避免污染当前 session 的上下文。
		if (sessionId) {
			const noSessionKey = this._cacheKey(agentId, undefined);
			let noSessionMessages = this._historyCache.get(noSessionKey);
			if (!noSessionMessages || noSessionMessages.length === 0) {
				noSessionMessages = await this._loadFromSessionFile(agentId, undefined);
			}
			if (noSessionMessages && noSessionMessages.length > 0) {
				// 仅保留 system 消息（这是注释里声明的合法用途）
				const systemOnly = noSessionMessages.filter(m => m.role === 'system');
				const droppedCrossSession = noSessionMessages.length - systemOnly.length;
				if (droppedCrossSession > 0) {
					this.logService.warn(
						`[AgentChatService] getHistory: dropped ${droppedCrossSession} non-system messages from noSession bucket for ${key} (cross-session leakage guard)`,
					);
				}
				if (systemOnly.length > 0) {
					// Merge and deduplicate by message id, sorted by timestamp
					const existingIds = new Set((messages || []).map(m => m.id));
					const merged = [
						...(messages || []),
						...systemOnly.filter(m => !existingIds.has(m.id)),
					].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
					messages = merged;
				}
			}
		}

		this.logService.info(
			`[AgentChatService] getHistory: ${(messages || []).length} msgs for ${key}`,
		);
		return messages || [];
	}

	async clearHistory(agentId: string, sessionId?: string): Promise<void> {
		await this._ensureHistoryLoaded();
		const key = this._cacheKey(agentId, sessionId);
		this._historyCache.delete(key);
		await this._persistGlobalHistory();
		if (sessionId) {
			try {
				const paths = await this._resolveAgentPaths(agentId);
				const fileUri = this._sessionFileUri(paths.sessionsDirUri, sessionId);
				if (await this.fileService.exists(fileUri)) {
					await this.fileService.writeFile(
						fileUri,
						VSBuffer.fromString("[]"),
					);
				}
			} catch {
				/* ignore */
			}
		}
	}

	/**
	 * Replace the entire chat history for an agent session in both the
	 * in-memory cache and the persistent session file. Used by workflow
	 * execution to write back compressed messages so subsequent
	 * `getHistory` calls don't reload the full uncompressed history.
	 */
	async replaceHistory(agentId: string, sessionId: string | undefined, messages: ChatMessage[]): Promise<void> {
		await this._ensureHistoryLoaded();
		const key = this._cacheKey(agentId, sessionId);
		this._historyCache.set(key, [...messages]);
		await this._persistGlobalHistory();
		if (sessionId) {
			try {
				const paths = await this._resolveAgentPaths(agentId);
				const fileUri = this._sessionFileUri(paths.sessionsDirUri, sessionId);
				const json = JSON.stringify(messages, null, 2);
				await this.fileService.writeFile(fileUri, VSBuffer.fromString(json));
				this.logService.info(
					`[AgentChatService] replaceHistory: wrote ${messages.length} msgs to ${key}`,
				);
			} catch (err) {
				this.logService.error(
					`[AgentChatService] replaceHistory: failed to persist for ${key}: ${err instanceof Error ? err.message : err}`,
				);
				throw err;
			}
		}
	}

	// ─── 历史转换：host ChatMessage[] → driver IChatMessage[] ──────────────────
	//
	// 背景：后端 turn 此前每轮只收到当前 user 消息（messages=1），长对话上下文
	// 永远涨不起来，已验证正确的压缩链路（P0/P1/P2）永远不被触发。B 方案让后端
	// 收到完整历史，这里负责把持久化的 host 历史转换为 driver 消息格式。
	//
	// 关键约束（决定 OpenAI 格式是否合法）：
	//   1. host 的 assistant 消息把工具结果**内嵌**在 toolCalls[].result 里，
	//      没有独立的 role:'tool' 消息；而 OpenAI 要求 assistant.tool_calls 的每个
	//      调用都必须有一条配对的 role:'tool' + 同 id 的 tool_call_id 响应，否则
	//      API 报错。因此对每个**有 result** 的 toolCall，要：
	//        a) 在 assistant.toolCalls 里保留它（携带 id/name/arguments）
	//        b) 紧随该 assistant 追加一条 role:'tool'、toolCallId===id 的消息
	//   2. **没有 result** 的 toolCall（status=running/error 且无结果）必须从
	//      assistant.toolCalls 中剔除——否则会留下"有 tool_call 但无配对 tool 响应"
	//      的非法序列。剔除后若该 assistant 还有文本 content 仍保留为纯文本消息。
	//   3. 历史里的 system 消息按原样转换（system prompt 由后端单独注入，这里
	//      只透传历史中可能存在的 system 类消息）。
	//   4. tool 角色的独立历史消息（理论上 host 端不产生，但防御性处理）按其
	//      自身 content 透传，toolCallId 缺失时用空串（与 MessageFormatConverter
	//      的容错一致）。
	/**
	 * 防御性过滤：检测 assistant content 是否疑似被 fake-completion / unfinished-intent
	 * 污染（旧 session 残留的"您完全正确！我犯了严重错误..."幻觉道歉模式）。
	 *
	 * 即使新机制（discard_prior_text）已阻止新污染，旧 session 已写入的 _historyCache
	 * 仍含污染条目。这里在组装 priorMessages 时主动跳过/重写这些条目，让旧 session
	 * 也能立即恢复，无需手动 reset。
	 *
	 * 命中规则（任一即视为污染）：
	 *  - "您完全正确" / "我犯了严重错误" / "让我重新" 开头（fake-completion 模型自我反省语）
	 *  - 没有 toolCalls 也没有正常文本输出，只是道歉性过渡语
	 */
	private _isContaminated(content: string): boolean {
		if (!content) {
			return false;
		}
		const head = content.slice(0, 80);
		const patterns = [
			/^您完全正确/,
			/^我犯了严重错误/,
			/^让我重新(?:开始|尝试|执行)/,
			/^抱歉.{0,10}重新/,
			/^对不起.{0,10}重新/,
			/^检测到模型未真正调用工具/, // 我们自己的 nudge 提示，也不应回灌历史
		];
		return patterns.some(re => re.test(head));
	}

	private _toDriverMessages(history: readonly ChatMessage[]): IChatMessage[] {
		// 🧹 一致性兜底（2026-06-05）：折叠**连续重复的 user 消息**。
		// 历史 session 文件（如 sess_mpwt6z2s_szhpq3.json）因早期持久化双写 race
		// （webview controller `_handleChatSend` 与 service `sendMessage` 各 append
		// 一次，5 秒 dedup 守卫在不同进程/时序下失效），磁盘上已沉淀大量"同一条
		// user 消息相邻出现 2 次"的脏数据。B 方案每轮把整段历史回灌给模型，会原样
		// 把重复 user 发出去（log 里 hello×4 / test×2 / createtestN×2）。这里在
		// 组装 driver messages 的唯一漏斗处做最终去重：相邻且 content 完全相同的
		// user 消息只保留第一条，杜绝重复输入污染模型上下文。注意只折叠**相邻**
		// 重复，正常的"用户连续发两条不同消息"不受影响。
		let collapsedUserDup = 0;
		const deduped: ChatMessage[] = [];
		for (const m of history) {
			const prev = deduped[deduped.length - 1];
			if (
				m.role === 'user' &&
				prev &&
				prev.role === 'user' &&
				(prev.content ?? '') === (m.content ?? '')
			) {
				collapsedUserDup++;
				continue;
			}
			deduped.push(m);
		}
		if (collapsedUserDup > 0) {
			this.logService.warn(
				`[AgentChatService] 🧹 _toDriverMessages: collapsed ${collapsedUserDup} consecutive duplicate user message(s) (persist-race / legacy session-file pollution guard)`,
			);
		}

		const out: IChatMessage[] = [];
		let droppedContaminated = 0;
		for (const m of deduped) {
			if (m.role === 'user') {
				out.push({ role: 'user', content: m.content ?? '' });
			} else if (m.role === 'assistant') {
				// 仅保留已完成（有 result）的工具调用，保证 tool_call ↔ tool 配对完整
				const completed = (m.toolCalls ?? []).filter(
					tc => typeof tc.result === 'string',
				);
				// 🧹 防御过滤：assistant 内容疑似污染且**没有任何工具调用**时整条丢弃
				// （有工具调用的 assistant 必须保留以维持 tool_call ↔ tool 配对完整性，
				// 但可以把 content 重写为空串，让模型只看到工具调用历史，不再看到道歉语料）
				const contentRaw = m.content ?? '';
				const contaminated = this._isContaminated(contentRaw);
				if (contaminated && completed.length === 0) {
					droppedContaminated++;
					continue;
				}
				const sanitizedContent = contaminated ? '' : contentRaw;
				if (contaminated) {
					droppedContaminated++;
				}
				const assistantMsg: IChatMessage = {
					role: 'assistant',
					content: sanitizedContent,
					...(completed.length > 0
						? {
								toolCalls: completed.map(tc => ({
									id: tc.id,
									name: tc.name,
									arguments: tc.arguments ?? '{}',
								})),
							}
						: {}),
				};
				out.push(assistantMsg);
				// 为每个已完成工具调用补一条配对的 tool 响应消息
				for (const tc of completed) {
					out.push({
						role: 'tool',
						content: tc.result ?? '',
						toolCallId: tc.id,
					});
				}
			} else if (m.role === 'system') {
				out.push({ role: 'system', content: m.content ?? '' });
			} else if (m.role === 'tool') {
				// 防御性：host 端通常不产生独立 tool 消息
				out.push({ role: 'tool', content: m.content ?? '', toolCallId: '' });
			}
		}
		if (droppedContaminated > 0) {
			this.logService.info(
				`[AgentChatService] 🧹 _toDriverMessages: filtered ${droppedContaminated} contaminated assistant messages (fake-completion / unfinished-intent residue)`,
			);
		}
		return out;
	}

	async deleteMessagesAfter(
		agentId: string,
		sessionId: string | undefined,
		messageId: string,
	): Promise<void> {
		await this._ensureHistoryLoaded();
		const key = this._cacheKey(agentId, sessionId);
		let messages = this._historyCache.get(key);

		if (!messages || messages.length === 0) {
			messages = await this._loadFromSessionFile(agentId, sessionId);
		}
		if (!messages || messages.length === 0) {
			this.logService.info(`[AgentChatService] deleteMessagesAfter: no messages found for ${key}`);
			return;
		}

		const targetIdx = messages.findIndex(m => m.id === messageId);
		if (targetIdx < 0) {
			this.logService.warn(`[AgentChatService] deleteMessagesAfter: message ${messageId} not found in ${key}`);
			return;
		}

		// Keep messages up to and including targetIdx
		const updatedMessages = messages.slice(0, targetIdx + 1);
		this._historyCache.set(key, updatedMessages);

		this.logService.info(
			`[AgentChatService] deleteMessagesAfter: kept ${updatedMessages.length} messages (removed ${messages.length - updatedMessages.length}) for ${key}`,
		);

		// Persist: global + session file
		this._persistGlobalHistory().catch((err) =>
			this.logService.error("[AgentChatService] Global persist failed:", err),
		);
		this._persistToSessionFile(
			agentId,
			sessionId,
			updatedMessages,
		).catch((err) =>
			this.logService.error("[AgentChatService] Session file persist failed:", err),
		);
	}

	// ─── Public: sendMessage ─────────────────────────────────────────────────

	async sendMessage(
		agentId: string,
		message: string,
		options: IChatSendOptions,
		onDelta: (delta: IChatStreamDelta) => void,
	): Promise<ChatMessage> {
		this.logService.info(
			`[CoderTrace] AgentChatService.sendMessage: agentId=${agentId}, messageLen=${message.length}, model=${options.model}, chatMode=${options.chatMode}, explicitSkillIds=${JSON.stringify(options.explicitSkillIds)}`,
		);

		const streamKey = options.agentSessionId
			? `${agentId}::${options.agentSessionId}`
			: agentId;
		this.cancelStream(streamKey);

		const controller = new AbortController();
		this._activeStreams.set(streamKey, controller);

		// ─── Memory provider 事件桥接 ──────────────────────────────────────
		// 订阅 provider 的 onMemoryWritten/onMemoryWriteFailed 事件，
		// 将真实的写入结果转发给 onDelta，使 UI 卡片从 pending → saved/failed。
		// 替代旧的 fire-and-forget + 假"已保存"信号模式。
		// 并发修复：每个 streamKey 独立注册回调，而非覆盖单例。
		this._activeOnDeltas.set(streamKey, onDelta);
		this._streamCreatedAt.set(streamKey, Date.now());
		this._ensureMemoryEventBridge();

		let fullContent = "";
		let fullThinking = "";
		let toolCalls: ChatMessage["toolCalls"];
		// 阶段E：textPosition 仅作**落盘时切分 parts 的本地排序信号**，不再跨层依赖。
		// driver/agentOS 不下发 textPosition，由本侧在 tool_start 时按"当前 turn 内已累积
		// 文本长度"计算（assistant_turn 结算后归零）。最终 deriveMessageParts 用它把
		// turn.content 与 toolCalls 一次性切分成有序 parts 落盘，重载即按数组顺序渲染，
		// 不再有任何一层依赖 textPosition 的字符偏移（消除历史错位根因）。
		let currentTurnTextLen = 0;
		// ─── Hermes-style 回合边界收集（2026-06-05 治本根因修复）──────────────
		// agentOS 每个 iteration yield 一个 `assistant_turn` 边界事件。我们据此把
		// 这一回合（同一次用户请求）拆成多条 assistant 消息，每条只含**本 iteration**
		// 的 content + 本 iteration 发起的 toolCalls，紧跟其 tool 结果落在下一条之前。
		// 这样持久化的历史与 agentOS loop 内部结构一致，杜绝"先宣告成功、后调用工具"
		// 的因果倒置范例。turns 为空（无边界事件，旧后端/直连模式）时回退单条逻辑。
		interface ITurnSnapshot {
			content: string;
			toolCallIds: string[];
		}
		const turns: ITurnSnapshot[] = [];
		// Accumulators for new card data (VS Code Copilot Chat pattern)
		let references: ChatMessage["references"];
		let progress: ChatMessage["progress"];
		let confirmation: ChatMessage["confirmation"];
		let todos: ChatMessage["todos"];
		let tips: ChatMessage["tips"];
		let questions: ChatMessage["questions"];
		// KV Cache: accumulated token usage across the turn.
		let usageInput = 0;
		let usageOutput = 0;
		let usageCached = 0;
		let usageCacheWrite = 0;
		let usageCredit = 0;
		let usageTotalReported = 0; // total_tokens as reported by the gateway (preferred over input+output)
		let usageSeen = false;

		try {
			// Persist user message (fire-and-forget, don't block AI response)
			// Defensive: check if an identical user message was already persisted
			// in the last 5 seconds (e.g. by the webview controller or another caller).
			const key = this._cacheKey(agentId, options.agentSessionId);
			const existingMessages = this._historyCache.get(key) || [];
			const now = Date.now();
			const alreadyPersisted = existingMessages.some(m =>
				m.role === 'user' &&
				m.content === message &&
				m.agentSessionId === options.agentSessionId &&
				(now - new Date(m.timestamp).getTime()) < 5000
			);

			if (!alreadyPersisted) {
				const userMessage: ChatMessage = {
					id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
					role: 'user',
					content: message,
					agentId,
					agentSessionId: options.agentSessionId,
					timestamp: new Date().toISOString(),
				};
				this.appendMessage(agentId, userMessage).catch(err =>
					this.logService.error('[AgentChatService] Failed to persist user message:', err)
				);
			} else {
				this.logService.info(`[AgentChatService] Skipping duplicate user message persist: "${message.substring(0, 40)}..."`);
			}

			// ─── B 方案：组装完整会话历史传给后端 ─────────────────────────────
			// 后端 turn 此前每轮只收到当前 user 消息（executeAgentTurn: messages=1），
			// 长对话上下文涨不起来，已验证正确的压缩链路（P0/P1/P2）永不触发。这里
			// 取出该 session 全量历史，转换为 driver 消息格式，经 priorMessages 参数
			// 下发。driver 会在其后追加当前 user 消息，因此先从历史尾部剔除"当前这条
			// user 消息"避免重复——user 消息在上方 fire-and-forget 持久化，时序上可能
			// 已写入 _historyCache（末尾即当前消息），也可能尚未写入（末尾是上一轮
			// assistant）。只检查末尾一条最安全：是当前 user 就剔除，否则不动。
			let priorMessages: IChatMessage[] | undefined;
			try {
				const history = await this.getHistory(agentId, options.agentSessionId);
				const trimmed = [...history];
				const last = trimmed[trimmed.length - 1];
				if (last && last.role === 'user' && last.content === message) {
					trimmed.pop();
				}
				priorMessages = this._toDriverMessages(trimmed);
				this.logService.info(
					`[AgentChatService] Assembled ${priorMessages.length} prior driver messages from ${history.length} history msgs (key=${this._cacheKey(agentId, options.agentSessionId)})`,
				);
			} catch (err) {
				this.logService.warn(
					`[AgentChatService] Failed to assemble prior messages (continuing with current message only): ${err}`,
				);
				priorMessages = undefined;
			}

			this.logService.info(`[AgentChatService] Creating stream (agentId=${agentId}, priorMsgs=${priorMessages?.length ?? 0})`);
			const t0_stream = Date.now();
			const stream = this.driverService.executeFromChatOptions(
				agentId,
				message,
				options,
				priorMessages,
			);
			this.logService.info(`[AgentChatService] Stream created in ${Date.now() - t0_stream}ms, starting iteration`);
			let _deltaCount = 0;
			for await (const delta of stream) {
				_deltaCount++;
				if (controller.signal.aborted) {
					break;
				}
				if (delta.type === "text" && delta.content) {
					fullContent += delta.content;
				}
				if (delta.type === "thinking" && delta.content) {
					fullThinking += delta.content;
				}
				// content_replace: upstream extracted tool calls from text and wants
				// to replace the accumulated fullContent with the cleaned version.
				if (delta.type === "content_replace") {
					fullContent = delta.content ?? "";
					currentTurnTextLen = (delta.content ?? "").length;
				}
				// ── Hermes-style synthetic-recovery 续跑信号 ──────────────────────
				// 参考 Hermes `agent/conversation_loop.py:4300-4310` 的 while-pop 模式：
				// upstream 检测到 fake-completion / unfinished-intent，准备注入 nudge
				// 续跑时，要求**永远不要把已累计的幻觉文本持久化到 history**——否则下一轮
				// `_toDriverMessages(history)` 会把它当作 prior driver messages 喂回模型，
				// 形成 "您完全正确！我犯了严重错误..." 的对话循环（test50 复现的根因）。
				//
				// 收到该信号后立即清空 fullContent / fullThinking，让最终持久化的
				// chatMessage.content 仅包含**信号之后真正成功的那段输出**。
				if ((delta as any).type === 'discard_prior_text') {
					const reason = (delta as any).metadata?.reason ?? 'unknown';
					this.logService.info(
						`[AgentChatService] 🧹 Received discard_prior_text (reason=${reason}) — clearing fullContent (was len=${fullContent.length}) + fullThinking (was len=${fullThinking.length}) to prevent conversation rot`,
					);
					fullContent = "";
					fullThinking = "";
					currentTurnTextLen = 0;
					// 通知 webview 同步重置（content_replace 已发，仅作冗余兜底）
					onDelta(delta as any);
					continue;
				}
			// ─── Hermes-style 回合边界事件 ──────────────────────────────
			// agentOS 在每个 iteration 确定 assistant 消息后发来 `assistant_turn`，
			// content 为本轮权威文本（已 sanitize+trim），metadata.toolCallIds 为本轮
			// 工具调用 id。收到后把这一轮快照成一个 turn。
			//
			// 同时作为 `content_replace` 转发给 webview，确保 webview 的 textBuffer
			// 与宿主的 sanitized 内容同步。若不转发，多轮 agent loop 时 webview 的 buffer
			// 会累积所有轮次的原始文本，导致最终 chat.stream.complete 时 buffer 与 host
			// message 内容完全不同（CONTENT MISMATCH），引发渲染异常和 UI 卡死。
			//
			// 注意：此时 toolCalls 里这些 id 的 result 可能尚未回填
			// （tool_result 在 assistant_turn 之后才 yield），因此只记录 id，
			// 最终持久化时再按 id 从全局 toolCalls 取回填好 result 的副本。
			if ((delta as any).type === 'assistant_turn') {
				const md = (delta as any).metadata ?? {};
				const ids = Array.isArray(md.toolCallIds) ? md.toolCallIds as string[] : [];
				const turnContent: string = (delta as any).content ?? "";
				turns.push({
					content: turnContent,
					toolCallIds: ids,
				});
				// 本轮结算：下一轮工具卡片的 textPosition 从 0 重新计起，
				// 与 _aggregateTurns 合并各 turn 时按 turn.content 长度累加 offset 对齐。
				currentTurnTextLen = 0;
				// 同步 webview 的 text buffer 为本轮 sanitized 文本
				if (turnContent) {
					onDelta({
						type: 'content_replace' as any,
						content: turnContent,
					});
				}
				continue;
			}
				if (delta.type === "tool_start" && delta.toolCallId && delta.toolName) {
					if (!toolCalls) {
						toolCalls = [];
					}
					toolCalls.push({
						id: delta.toolCallId,
						name: delta.toolName,
						arguments: "",
						result: undefined,
						displayName: delta.displayName,
						renderType: delta.renderType,
						defaultShow: delta.defaultShow,
						serverExecuted: (delta as any).serverExecuted,
						// 记录卡片插入位置：优先用上游下发的 textPosition，否则用当前 turn 内
						// 已累积的文本长度。持久化后重载即可按位置交织渲染，而非全部排到末尾。
						textPosition: typeof (delta as any).textPosition === 'number'
							? (delta as any).textPosition
							: currentTurnTextLen,
					});
				}
				if (
					delta.type === "tool_args" &&
					delta.toolCallId &&
					delta.content &&
					toolCalls
				) {
					const tc = toolCalls.find((t) => t.id === delta.toolCallId);
					if (tc) {
						tc.arguments += delta.content;
					}
				}
				if (delta.type === "tool_result" && delta.toolCallId && toolCalls) {
					const tc = toolCalls.find((t) => t.id === delta.toolCallId);
					if (tc) {
						tc.result = delta.content;
						// Mark finished so the persisted card restores in a
						// completed (not loading) state after a window refresh.
						// Without this, the webview's mapPhase sees no status and
						// defaults to 'pending' → renders the loading title forever.
						tc.status = 'done';
					}
				}
				// Handle new card data delta types (VS Code Copilot Chat pattern)
				if (delta.type === 'references' && delta.references) {
					references = delta.references as unknown as ChatMessage['references'];
				}
				if (delta.type === 'progress' && delta.progressData) {
					progress = delta.progressData as unknown as ChatMessage['progress'];
				}
				if (delta.type === 'confirmation' && delta.confirmationData) {
					confirmation = delta.confirmationData as unknown as ChatMessage['confirmation'];
				}
				if (delta.type === 'todos' && delta.todosData) {
					todos = delta.todosData as unknown as ChatMessage['todos'];
				}
				if (delta.type === 'tips' && delta.tipsData) {
					tips = delta.tipsData as unknown as ChatMessage['tips'];
				}
				if (delta.type === 'questions' && delta.questionsData) {
					questions = delta.questionsData as unknown as ChatMessage['questions'];
				}
				// KV Cache: aggregate per-chunk usage so the persisted ChatMessage
				// carries the final token totals (BYOK providers may emit usage on
				// either the streaming chunk path or the fallback non-streaming path,
				// so we sum defensively rather than overwrite).
				if (delta.type === 'usage' && delta.usage) {
					usageSeen = true;
					if (typeof delta.usage.inputTokens === 'number') { usageInput += delta.usage.inputTokens; }
					if (typeof delta.usage.outputTokens === 'number') { usageOutput += delta.usage.outputTokens; }
					if (typeof delta.usage.cachedTokens === 'number') { usageCached += delta.usage.cachedTokens; }
					if (typeof delta.usage.cacheWriteTokens === 'number') { usageCacheWrite += delta.usage.cacheWriteTokens; }
					if (typeof delta.usage.totalTokens === 'number') { usageTotalReported += delta.usage.totalTokens; }
					if (typeof delta.usage.credit === 'number') { usageCredit += delta.usage.credit; }
				}
				onDelta(delta as any);
			// Broadcast delta for external panels (kanban, task overview) to stay in sync
			this._onDidStreamDeltaEmitter.fire({
				agentId,
				sessionId: options.agentSessionId || '',
				delta: delta as any,
			});
			}

			this.logService.info(`[AgentChatService] Stream iteration done: ${_deltaCount} deltas in ${Date.now() - t0_stream}ms`);

			// 用户点击 Stop → cancelStream 调用 controller.abort() → for-await break。
			// 此时 done/error delta 尚未被 stream 发射，UI 不会收到 setSending(false)。
			// 这里补发 done delta，让 nativeChatEditorPane 的 done handler 清理消息状态。
			if (controller.signal.aborted) {
				this.logService.info(`[AgentChatService] Stream aborted by user, emitting done delta for UI cleanup`);
				onDelta({ type: 'done' } as any);
			}

			// 诊断日志：for-await 循环已退出，即将进入 finalization。
			// 如果此日志不出现，说明 generator 的 finally 块阻塞了 for-await 退出。
			this.logService.info(`[AgentChatService] for-await loop exited, starting finalization`);

			// L0 记忆写入通知：由 agentDriverService 在 finally 块中 yield memory_writing delta
			// （含 noticeId），本处不再发送假的 "已保存" 信号。
			// 真实的写入结果通过 provider 的 onMemoryWritten/onMemoryWriteFailed 事件桥接到 onDelta。

			// Finalization safety net: the stream has fully completed, so any
			// tool call still lacking a status must have finished. Mark it 'done'
			// so the persisted card restores in a completed state rather than the
			// loading title after a window refresh.
			if (toolCalls) {
				for (const tc of toolCalls) {
					if (!tc.status) {
						tc.status = 'done';
					}
				}
			}

			// 共享的 token usage 对象（多条 turn 时仅挂在最后一条上）
			const sharedTokenUsage = usageSeen
				? {
					input: usageInput,
					output: usageOutput,
					// Prefer the gateway-reported total_tokens when present (it may
					// account for tokens not split into input/output); otherwise derive.
					total: usageTotalReported > 0 ? usageTotalReported : usageInput + usageOutput,
					cached: usageCached > 0 ? usageCached : undefined,
					cacheWrite: usageCacheWrite > 0 ? usageCacheWrite : undefined,
					credit: usageCredit > 0 ? usageCredit : undefined,
				}
				: undefined;

			let chatMessage: ChatMessage;

			if (turns.length > 0) {
				// ─── Hermes-style 多条持久化（治本根因修复）──────────────────────
				// agentOS 发来了逐 iteration 的 `assistant_turn` 边界。按回合切分成
				// 多条 assistant 消息（共享一个 turnId），每条只含本轮 content + 本轮
				// 发起的 toolCalls（result 已按 id 回填到全局 toolCalls）。持久化后磁盘
				// 历史天然呈现 assistant(意图+toolCalls)→tool(结果)→assistant(下轮/总结)
				// 的正确因果链，回灌时不再出现"先宣告成功、后调用工具"的倒置范例。
				const turnId = `turn_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
				const allToolCalls = toolCalls ?? [];
				const claimedIds = new Set<string>();
				const builtMessages: ChatMessage[] = [];

				for (let i = 0; i < turns.length; i++) {
					const turn = turns[i];
					const isLast = i === turns.length - 1;
					// 收集本轮工具调用（按 id 从全局取，已含回填好的 result/status）
					let turnToolCalls = turn.toolCallIds
						.map(id => allToolCalls.find(tc => tc.id === id))
						.filter((tc): tc is NonNullable<typeof tc> => !!tc);
					for (const tc of turnToolCalls) { claimedIds.add(tc.id); }
					// 防御：最后一轮兜底接管任何未被任何 turn 认领的工具调用
					if (isLast) {
						const orphans = allToolCalls.filter(tc => !claimedIds.has(tc.id));
						if (orphans.length > 0) {
							turnToolCalls = [...turnToolCalls, ...orphans];
							for (const tc of orphans) { claimedIds.add(tc.id); }
						}
					}
					const msg: ChatMessage = {
						id: `msg_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 7)}`,
						role: "assistant",
						content: turn.content,
						agentId,
						agentSessionId: options.agentSessionId,
						turnId,
						timestamp: new Date().toISOString(),
						...(turnToolCalls.length > 0 ? { toolCalls: turnToolCalls } : {}),
						// 阶段E：落盘有序 parts（文本段与工具段按 textPosition 一次性切分定位），
						// 作为重载渲染的唯一真相。textPosition 仅在此处切分时使用，不再跨层依赖。
						parts: deriveMessageParts({ role: "assistant", content: turn.content, toolCalls: turnToolCalls }),
						// thinking + 卡片数据 + token usage 都是整回合聚合量，仅挂最后一条，
						// 避免在多条气泡里重复渲染。
						...(isLast ? {
							thinking: fullThinking || undefined,
							references: references || undefined,
							progress: progress || undefined,
							confirmation: confirmation || undefined,
							todos: todos || undefined,
							tips: tips || undefined,
							questions: questions || undefined,
							tokenUsage: sharedTokenUsage,
						} : {}),
					};
					builtMessages.push(msg);
				}

				// 顺序持久化（保持磁盘顺序 = 因果顺序）
				for (const msg of builtMessages) {
					await this.appendMessage(agentId, msg).catch((err) =>
						this.logService.error(
							"[AgentChatService] Failed to persist assistant turn message:",
							err,
						),
					);
				}
				this.logService.info(
					`[AgentChatService] Persisted ${builtMessages.length} assistant turn message(s) under turnId=${turnId} (Hermes-style boundary)`,
				);
				// 返回最后一条（其 content 为最终总结，供 configHtmlService 解析）
				chatMessage = builtMessages[builtMessages.length - 1];
			} else {
				// ─── 回退：无边界事件（直连模式/旧后端）持久化单条 ────────────────
				chatMessage = {
					id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
					role: "assistant",
					content: fullContent,
					agentId,
					agentSessionId: options.agentSessionId,
					thinking: fullThinking || undefined,
					toolCalls: toolCalls || undefined,
					// 阶段E：落盘有序 parts（单条回退路径同样写入，重载即按顺序渲染）。
					parts: deriveMessageParts({ role: "assistant", content: fullContent, toolCalls: toolCalls }),
					timestamp: new Date().toISOString(),
					// New card data fields (VS Code Copilot Chat pattern)
					references: references || undefined,
					progress: progress || undefined,
					confirmation: confirmation || undefined,
					todos: todos || undefined,
					tips: tips || undefined,
					questions: questions || undefined,
					// KV Cache: persist token usage so the webview footer can render the
					// total + cache-hit badge (only emitted when the provider reported usage).
					tokenUsage: sharedTokenUsage,
				};

				this.appendMessage(agentId, chatMessage).catch((err) =>
					this.logService.error(
						"[AgentChatService] Failed to persist assistant message:",
						err,
					),
				);
			}

			return chatMessage;
		} catch (error) {
			this.logService.error(
				`[AgentChatService] sendMessage failed for ${agentId}:`,
				error,
			);
			onDelta({ type: "error", content: String(error) });
		this._onDidStreamDeltaEmitter.fire({
			agentId,
			sessionId: options.agentSessionId || '',
			delta: { type: 'error' as any, content: String(error) },
		});
			throw error;
		} finally {
			this._activeStreams.delete(streamKey);
			// 并发修复：移除本次流的回调与计时戳。writeMemory 完成事件若晚到，
			// 桥接会按 agentId 路由到该 agent 仍活跃的最近一次流；若已无活跃流则安全 no-op。
			this._activeOnDeltas.delete(streamKey);
			this._streamCreatedAt.delete(streamKey);
		}
	}

	/**
	 * 服务销毁时取消 memory 事件桥接订阅，避免泄漏。
	 * 该字段此前仅被赋值、未被读取，现通过 dispose 真正消费它。
	 */
	override dispose(): void {
		this._memoryEventUnsub?.();
		this._memoryEventUnsub = null;
		super.dispose();
	}

	/**
	 * 订阅 memory provider 的 lifecycle 事件，桥接为 onDelta 调用。
	 * 替代旧的 fire-and-forget + 假"已保存" UI 信号。
	 *
	 * 幂等：只建立一次订阅；并发修复后用 {@link _getOnDeltaForAgent} 按 agentId
	 * 把事件路由到该 agent 最近一次活跃流的 onDelta，避免多会话串台。
	 */
	private _ensureMemoryEventBridge(): void {
		if (this._memoryBridgeReady) {
			return;
		}
		this._memoryBridgeReady = true;

		// Dedup: track processed noticeIds to prevent duplicate display
		const processedNoticeIds = new Set<string>();
		// Dedup map for Episodic/Semantic/Procedural extraction cards (no noticeId)
		// Key: memoryType, Value: last shown timestamp — 5s window prevents duplicate cards
		const recentExtractedTypes = new Map<string, number>();

		const provider = this.driverService.getActiveMemoryProvider();
		if (!provider?.onMemoryWritten) {
			// Provider 不支持事件订阅（旧 provider），回退：不桥接
			return;
		}

		const unsubWritten = provider.onMemoryWritten((agentId, data) => {
			const onDelta = this._getOnDeltaForAgent(agentId);
			if (!onDelta) {
				return;
			}
			if (data.noticeId) {
				// Dedup: skip if this noticeId was already processed
				if (processedNoticeIds.has(data.noticeId)) {
					return;
				}
				processedNoticeIds.add(data.noticeId);

				// L0 写入完成：contentLength 为 0 时移除 pending 卡片，不显示"已保存"
				if (!data.contentLength || data.contentLength === 0) {
					onDelta({
						type: 'memory_written' as any,
						content: '',
						metadata: { noticeId: data.noticeId, memoryType: data.memoryType, remove: true },
					} as any);
					return;
				}

				// Use actual memoryType for the label instead of hardcoding "Working"
				const memTypeLabels: Record<string, string> = {
					working: 'Working',
					episodic: 'Episodic',
					scene: 'Semantic',
					persona: 'Procedural',
					pattern: 'pattern', preference: 'preference', architecture: 'architecture',
					bug: 'bug', workflow: 'workflow', fact: 'fact', instruction: 'instruction',
				};
				const memLabel = memTypeLabels[data.memoryType ?? ''] ?? data.memoryType ?? 'Working';
				onDelta({
					type: 'memory_written' as any,
					content: `${memLabel} 已保存 ${data.contentLength}字`,
					metadata: { noticeId: data.noticeId, memoryType: data.memoryType },
				} as any);
			} else {
				// Episodic/Semantic/Procedural 写入完成：直接显示 saved 卡片（无对应 pending 卡片）
				// Skip 'working' type — working memory writes always go through the noticeId path above.
				// Hook-triggered working writes (post_tool_use) are redundant with per-iteration writes.
				const memType = data.memoryType ?? 'episodic';
				if (memType === 'working' || memType === 'short_term') {
					return; // Working memory without noticeId = hook-triggered duplicate, skip
				}
				// Dedup: 同一 memoryType 在 5 秒内只显示一次（一次提取可能写入多条 fact）
				const now = Date.now();
				const lastShown = recentExtractedTypes.get(memType) ?? 0;
				if (now - lastShown < 5000) {
					return; // 5 秒内已显示过同类型卡片，跳过
				}
				recentExtractedTypes.set(memType, now);

				const typeLabels: Record<string, string> = {
					working: 'Working',
					episodic: 'Episodic',
					semantic: 'Semantic',
					procedural: 'Procedural',
					scene: 'Semantic',
					persona: 'Procedural',
					pattern: 'pattern', preference: 'preference', architecture: 'architecture',
					bug: 'bug', workflow: 'workflow', fact: 'fact', instruction: 'instruction',
				};
				const label = typeLabels[memType] ?? memType ?? 'Episodic';
				onDelta({
					type: 'memory_extracted' as any,
					content: `${label} 已提取`,
					metadata: { memoryType: memType, status: 'saved' },
				} as any);
			}
		});

		const unsubFailed = provider.onMemoryWriteFailed?.((_agentId, data) => {
			const onDelta = this._getOnDeltaForAgent(_agentId);
			if (onDelta && data.noticeId) {
				onDelta({
					type: 'memory_write_failed' as any,
					content: `Working 写入失败: ${data.error}`,
					metadata: { noticeId: data.noticeId, error: data.error },
				} as any);
			}
		}) ?? (() => {});

		// 技能提取事件桥接：sweep 中自动提取技能后通知 UI
		const providerAny = provider as any;
		const unsubSkill = providerAny?.onEvent?.('skill_extracted', (event: any) => {
			const agentId = event.agentId ?? '';
			const onDelta = this._getOnDeltaForAgent(agentId);
			if (!onDelta) {
				return;
			}
			const skillId = event.data?.['skillId'] as string ?? '';
			const title = event.data?.['title'] as string ?? '未知技能';
			onDelta({
				type: 'skill_extracted' as any,
				content: `⚡ 技能已沉淀: ${title}`,
				metadata: {
					skillId,
					title,
					agentId,
					clickable: true,
				},
			} as any);
		}) ?? null;

		this._memoryEventUnsub = () => {
			unsubWritten();
			unsubFailed();
			if (typeof unsubSkill === 'function') { unsubSkill(); }
		};
	}

	/**
	 * 并发路由：给定 agentId，返回该 agent 最近一次活跃流的 onDelta 回调。
	 *
	 * 内存 provider 的 onMemoryWritten/onMemoryWriteFailed 是全局事件，不直接携带
	 * sessionId，因此按 agentId 前缀匹配所有 streamKey（agentId 或 agentId::sessionId），
	 * 选取创建时间最新的一条。当两个 chat 属于不同 agent 时路由无歧义；同 agent 多会话时
	 * 路由到最近发起的流（memory 事件通常紧跟对应生成，可接受）。
	 */
	private _getOnDeltaForAgent(agentId: string): ((delta: IChatStreamDelta) => void) | undefined {
		if (!agentId) {
			return undefined;
		}
		let bestKey: string | undefined;
		let bestTime = -1;
		for (const [key, time] of this._streamCreatedAt) {
			if (key === agentId || key.startsWith(`${agentId}::`)) {
				if (time > bestTime) {
					bestTime = time;
					bestKey = key;
				}
			}
		}
		return bestKey ? this._activeOnDeltas.get(bestKey) : undefined;
	}

	cancelStream(agentId: string, agentSessionId?: string): void {
		// The stream is stored under a composite key when agentSessionId exists
		// (see sendMessage line ~297).  We must look up the same key to abort it.
		const streamKey = agentSessionId
			? `${agentId}::${agentSessionId}`
			: agentId;
		const controller = this._activeStreams.get(streamKey);
		if (controller) {
			controller.abort();
			this._activeStreams.delete(streamKey);
		}
		// 并发修复：同步移除该流的回调与计时戳，避免内存事件桥接路由到已取消的流。
		this._activeOnDeltas.delete(streamKey);
		this._streamCreatedAt.delete(streamKey);
	}

	// ─── Agent Session CRUD (Root mode) ──────────────────────────────────────

	/**
	 * List all sessions for an agent.
	 * Reads from sessions.json index (fast, no file scanning).
	 */
	async listAgentSessions(agentId: string): Promise<AgentSessionMeta[]> {
		const index = await this._readSessionIndex(agentId);
		index.sort(
			(a, b) =>
				new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
		);
		return index;
	}

	/**
	 * Create a new session. Returns the full AgentSessionMeta.
	 */
	async createAgentSession(
		agentId: string,
		name?: string,
	): Promise<AgentSessionMeta> {
		this.logService.info(
			`[AgentChatService] createAgentSession: BEGIN agentId=${agentId}, name=${name ?? '(default)'}`,
		);
		const paths = await this._resolveAgentPaths(agentId);

		const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
		const now = new Date().toISOString();
		const meta: AgentSessionMeta = {
			id: sessionId,
			name: name || "新对话",
			createdAt: now,
			updatedAt: now,
			messageCount: 0,
		};

		if (!(await this.fileService.exists(paths.sessionsDirUri))) {
			await this.fileService.createFolder(paths.sessionsDirUri);
		}
		await this.fileService.writeFile(
			this._sessionFileUri(paths.sessionsDirUri, sessionId),
			VSBuffer.fromString("[]"),
		);

		const index = await this._readSessionIndex(agentId);
		index.push(meta);
		await this._writeSessionIndex(agentId, index);

		this.logService.info(
			`[AgentChatService] createAgentSession: DONE sessionId=${sessionId}, agentId=${agentId}, indexSize=${index.length}`,
		);
		this._onDidChangeAgentSessionsEmitter.fire({ agentId });
		return meta;
	}

	/**
	 * Rename a session.
	 */
	async renameAgentSession(
		agentId: string,
		sessionId: string,
		newName: string,
	): Promise<void> {
		const index = await this._readSessionIndex(agentId);
		const entry = index.find((s) => s.id === sessionId);
		if (!entry) {
			throw new Error(`Session ${sessionId} not found`);
		}
		entry.name = newName;
		entry.updatedAt = new Date().toISOString();
		await this._writeSessionIndex(agentId, index);
		this._onDidChangeAgentSessionsEmitter.fire({ agentId });
	}

	/**
	 * Delete a session. If it's the last one, it can still be deleted
	 * (user will get a new session auto-created on next message).
	 */
	async deleteAgentSession(
		agentId: string,
		sessionId: string,
	): Promise<void> {
		const paths = await this._resolveAgentPaths(agentId);
		const fileUri = this._sessionFileUri(paths.sessionsDirUri, sessionId);
		try {
			await this.fileService.del(fileUri);
		} catch {
			/* ignore */
		}

		const index = await this._readSessionIndex(agentId);
		const filtered = index.filter((s) => s.id !== sessionId);
		await this._writeSessionIndex(agentId, filtered);

		// Remove from memory cache
		const key = this._cacheKey(agentId, sessionId);
		this._historyCache.delete(key);
		await this._persistGlobalHistory();

		this.logService.info(
			`[AgentChatService] Deleted session ${sessionId} for ${agentId}`,
		);
		this._onDidChangeAgentSessionsEmitter.fire({ agentId });
	}

	/**
	 * Get the most recently active session for an agent.
	 * If no sessions exist, auto-create one (first conversation).
	 * Returns the AgentSessionMeta of the active session.
	 */
	async getOrCreateActiveSession(
		agentId: string,
		name?: string,
	): Promise<AgentSessionMeta> {
		const index = await this._readSessionIndex(agentId);
		if (index.length > 0) {
			index.sort(
				(a, b) =>
					new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
			);
			return index[0];
		}
		return this.createAgentSession(agentId, name || "新对话");
	}

	/**
	 * Store the external provider's session ID (e.g. Knot AG-UI threadId)
	 * into the agent session metadata so it can be sent on subsequent requests.
	 */
	async updateProviderSessionId(
		agentId: string,
		sessionId: string,
		providerSessionId: string,
	): Promise<void> {
		const index = await this._readSessionIndex(agentId);
		const entry = index.find((s) => s.id === sessionId);
		if (!entry) {
			return;
		}
		if (entry.providerSessionId === providerSessionId) {
			return;
		}
		entry.providerSessionId = providerSessionId;
		entry.updatedAt = new Date().toISOString();
		await this._writeSessionIndex(agentId, index);
		this.logService.info(
			`[AgentChatService] Stored providerSessionId=${providerSessionId} for session ${sessionId}`,
		);
	}

	/**
	 * Submit AskUser response (workflow interactive input).
	 */
	async submitAskUser(agentId: string, sessionId: string, executionId: string, nodeId: string, selection: string | string[]): Promise<void> {
		this.logService.info(
			`[AgentChatService] submitAskUser: agentId=${agentId}, sessionId=${sessionId}, executionId=${executionId}, nodeId=${nodeId}`,
		);
		// TODO: 实现向工作流引擎提交用户响应的逻辑
		// 这通常需要调用后端 API 或通过 driver 服务发送响应
		throw new Error('submitAskUser not yet implemented');
	}

	/**
	 * Apply code to file (from AI-generated code).
	 */
	async applyCode(agentId: string, sessionId: string, code: string, language: string, filePath?: string): Promise<void> {
		this.logService.info(
			`[AgentChatService] applyCode: agentId=${agentId}, sessionId=${sessionId}, language=${language}, filePath=${filePath}`,
		);
		// TODO: 实现将代码应用到文件的逻辑
		// 这通常需要调用文件服务或编辑器服务来写入文件
		throw new Error('applyCode not yet implemented');
	}
}
