/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';

import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import { classifyByKeywords, classifyContentViaLLM } from './knowledge/classifier.js';
import { resolveChatModel, createKbEmbedder } from './knowledge/knowledgeAdapters.js';
import { IAiEmbeddingVectorService } from '../../../../workbench/services/aiEmbeddingVector/common/aiEmbeddingVectorService.js';
import { resolveAuxEmbeddingConfig, resolveAuxEmbeddingProviderId } from './knowledge/embeddingConfigResolver.js';
import { resolveKbRoot } from './knowledge/knowledgeStorage.js';
import {
	type KnowledgeToolDeps,
	importMessageToKnowledgeBase,
	importFolderToRag,
	searchFolderRag,
	type ImportToKbOptions,
	type ImportToKbResult,
	type FolderRagResult,
	type FolderRagSearchResult,
	type BuildFolderOptions,
} from './knowledge/knowledgeTools.js';
import type { Agent, AgentBinding, Workspace, Connection, AgentStudioSession, WorkspaceLayout } from '../../../common/agentStudioTypes.js';
import { ITofAuthService } from '../common/tofAuth.js';
import { canUploadAgent as evaluateCanUploadAgent, resolveClaimOwner } from '../common/uploadPermission.js';
import { ConnectionType } from '../../../common/agentStudioTypes.js';
import { migrateWorkspace } from '../../../common/agentStudioTypes.js';
import { DATA_FILE_WORKSPACES, DATA_FILE_SESSIONS, DATA_FILE_LAST_ACTIVE_WORKSPACE, DATA_FILE_LAST_ACTIVE_AGENT, DATA_FILE_AGENT_BINDINGS, AGENT_STUDIO_DATA_PATH_SETTING, WORKSPACE_DATA_DIR, AGENT_STUDIO_AUX_CURATOR_PROVIDER, AGENT_STUDIO_AUX_CURATOR_MODEL } from '../common/constants.js';
import { IWorkspaceLifecycleService, WorkspaceLifecycleEvent, IWorkspaceLifecyclePayload } from '../common/workspaceLifecycle.js';
import { IWorktreeService } from '../../worktree/common/worktreeService.js';
import { IWorktreeWorkspaceOptions, WorktreeStatus, IWorktreeStateEvent, IWorktreeDetail } from '../../worktree/common/worktreeTypes.js';
import { getBuiltinAgents } from '../common/builtinAgents.js';

export class AgentStudioService extends Disposable implements IAgentStudioService {
	declare readonly _serviceBrand: undefined;

	private _agentsCache: { data: Agent[]; ts: number } | undefined;

	private readonly _onDidChangeWorkspace = this._register(new Emitter<string>());
	readonly onDidChangeWorkspace: Event<string> = this._onDidChangeWorkspace.event;

	private readonly _onDidChangeActiveWorkspace = this._register(new Emitter<string | undefined>());
	readonly onDidChangeActiveWorkspace: Event<string | undefined> = this._onDidChangeActiveWorkspace.event;

	/** Runtime-only active workspace id (persisted as lastActive via setActiveWorkspace). */
	private _activeWorkspaceId: string | undefined;

	private readonly _onDidChangeSessions = this._register(new Emitter<void>());
	readonly onDidChangeSessions: Event<void> = this._onDidChangeSessions.event;

	private readonly _onDidSelectAgent = this._register(new Emitter<string | null>());
	readonly onDidSelectAgent: Event<string | null> = this._onDidSelectAgent.event;

	private readonly _onDidChangeAgents = this._register(new Emitter<void>());
	readonly onDidChangeAgents: Event<void> = this._onDidChangeAgents.event;

	private readonly _onDidRequestInjectPrompt = this._register(new Emitter<{ agentId: string; message: string }>());
	readonly onDidRequestInjectPrompt: Event<{ agentId: string; message: string }> = this._onDidRequestInjectPrompt.event;

	private readonly _onDidChangeWorktreeState = this._register(new Emitter<{ workspaceId: string; status: string; message?: string }>());
	readonly onDidChangeWorktreeState: Event<{ workspaceId: string; status: string; message?: string }> = this._onDidChangeWorktreeState.event;

	/** Fire the agent-selected event (called by webview controller) */
	fireSelectAgent(agentId: string | null): void {
		this.logService.info(`[AgentStudioService] fireSelectAgent(agentId=${agentId})`);
		this._onDidSelectAgent.fire(agentId);
		// Persist so the chat panel restores this agent on next startup
		this.setLastSelectedAgentId(agentId).catch(err =>
			this.logService.warn('[AgentStudioService] Failed to persist last agent:', err),
		);
	}

	/** Request the chat panel to inject a prompt into the conversation (e.g. workflow run). */
	requestInjectPrompt(agentId: string, message: string): void {
		this.logService.info(`[AgentStudioService] requestInjectPrompt(agentId=${agentId}, len=${message.length})`);
		this._onDidRequestInjectPrompt.fire({ agentId, message });
	}

	private _globalDataUri: URI | undefined;

	/** 内置 agent 落地到 ~/.saros/agents/ 的 seed 任务（仅执行一次）。 */
	private _seedBuiltinsPromise?: Promise<void>;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceLifecycleService private readonly workspaceLifecycleService: IWorkspaceLifecycleService,
		@IWorktreeService private readonly worktreeService: IWorktreeService,
		@IPathService private readonly pathService: IPathService,
		@IAiEmbeddingVectorService private readonly embeddingService: IAiEmbeddingVectorService,
		@ITofAuthService private readonly tofAuthService: ITofAuthService,
	) {
		super();

		// Listen for worktree state changes and forward as workspace-level events
		this._register(this.worktreeService.onDidChangeWorktreeState((e: IWorktreeStateEvent) => {
			this._forwardWorktreeStateChange(e);
		}));

		// Listen for worktree removal and clear stale bindings on any
		// workspace/agent that pointed at the removed worktree directory.
		this._register(this.worktreeService.onDidRemoveWorktree((removedPath: string) => {
			void this._clearWorktreeBindings(removedPath);
		}));

		// Seed builtin agents into ~/.saros/agents/{id}/ on first launch so they
		// appear in the native chat mode picker and the preset panel. The promise
		// is cached so concurrent getAgents() calls await the same seed.
		this._ensureBuiltinsSeeded();
	}

	/**
	 * Forward worktree state changes to workspace-level events.
	 * Looks up which workspace(s) are associated with the worktree directory.
	 */
	private async _forwardWorktreeStateChange(e: IWorktreeStateEvent): Promise<void> {
		const workspaces = await this.getWorkspaces();
		const matching = workspaces.filter(ws => ws.worktreePath === e.directory);
		for (const ws of matching) {
			this._onDidChangeWorktreeState.fire({
				workspaceId: ws.id,
				status: e.status,
				message: e.message,
			});
			// Also update the workspace's worktreeStatus field
			await this.updateWorkspace(ws.id, {
				worktreeStatus: e.status as Workspace['worktreeStatus'],
			});
		}
	}

	/**
	 * Clear stale worktree bindings after a worktree directory is removed.
	 * Scans all workspaces and all agents; any whose `worktreePath` matches
	 * the removed directory gets its worktree binding reset, so agents are no
	 * longer sandboxed to a directory that no longer exists.
	 *
	 * @param removedPath Absolute path of the removed worktree (no trailing separator)
	 */
	private async _clearWorktreeBindings(removedPath: string): Promise<void> {
		const normalize = (p: string | undefined): string | undefined =>
			p ? p.replace(/[/\\]+$/, '') : undefined;
		const target = normalize(removedPath);
		if (!target) {
			return;
		}

		this.logService.info(`[AgentStudioService] _clearWorktreeBindings: clearing bindings for removed worktree "${target}"`);

		// 1. Clear matching workspace-level bindings
		let affectedWorkspaceIds: string[] = [];
		try {
			const workspaces = await this.getWorkspaces();
			affectedWorkspaceIds = workspaces
				.filter(ws => normalize(ws.worktreePath) === target)
				.map(ws => ws.id);
			for (const wsId of affectedWorkspaceIds) {
				try {
					await this.updateWorkspace(wsId, {
						worktreePath: undefined,
						worktreeBranch: undefined,
						worktreeStatus: 'none',
					});
					this.logService.info(`[AgentStudioService] _clearWorktreeBindings: cleared workspace ${wsId}`);
				} catch (err) {
					this.logService.warn(`[AgentStudioService] _clearWorktreeBindings: failed to clear workspace ${wsId}:`, err);
				}
			}
		} catch (err) {
			this.logService.warn('[AgentStudioService] _clearWorktreeBindings: failed to enumerate workspaces:', err);
		}

		// 2. Clear matching agent-binding-level worktree paths (per-workspace).
		//    An AgentBinding may set its own worktreePath that overrides the
		//    workspace-level worktree, so we scan every workspace's bindings.
		try {
			const workspaces = await this.getWorkspaces().catch(() => [] as Workspace[]);
			for (const ws of workspaces) {
				let bindings: AgentBinding[];
				try {
					bindings = await this.getAgentBindings(ws.id);
				} catch {
					continue;
				}
				for (const binding of bindings) {
					if (normalize(binding.worktreePath) === target) {
						try {
							await this.upsertAgentBinding(ws.id, binding.agentId, {
								worktreePath: undefined,
								worktreeBranch: undefined,
							});
							this.logService.info(`[AgentStudioService] _clearWorktreeBindings: cleared binding ${binding.agentId} in workspace ${ws.id}`);
						} catch (err) {
							this.logService.warn(`[AgentStudioService] _clearWorktreeBindings: failed to clear binding ${binding.agentId} in workspace ${ws.id}:`, err);
						}
					}
				}
			}
		} catch (err) {
			this.logService.warn('[AgentStudioService] _clearWorktreeBindings: failed to enumerate agent bindings:', err);
		}
	}

	// ─── Workspace lifecycle helpers ─────────────────────────────────────────────

	/**
	 * Build a small, transport-safe snapshot of a workspace and fire the
	 * generic IWorkspaceLifecycleService event. We deliberately keep this
	 * shape minimal (id, name, path, timestamp) so the lifecycle layer stays
	 * decoupled from the full Workspace object — third-party hooks (knot CLI,
	 * future provider CLIs, …) only get what they actually need to react.
	 */
	private _fireWorkspaceLifecycle(event: WorkspaceLifecycleEvent, ws: Workspace): void {
		const payload: IWorkspaceLifecyclePayload = {
			id: ws.id,
			name: ws.name,
			path: ws.path,
			timestamp: new Date().toISOString(),
		};
		// Fire-and-forget — hook failures must never break a workspace mutation.
		void this.workspaceLifecycleService.fire(event, payload).catch(err => {
			this.logService.warn(
				`[AgentStudioService] workspace lifecycle "${event}" hook propagation failed for ${ws.id}: `
				+ `${err instanceof Error ? err.message : String(err)}`,
			);
		});
	}

	// ─── VS Code Workspace Folder Helpers ────────────────────────────────────────

	/**
	 * Return the first VS Code workspace folder URI, if available.
	 * This is the folder the user has open in the editor (File > Open Folder).
	 */
	private _getFirstWorkspaceFolderUri(): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : undefined;
	}

	/**
	 * Resolve the data directory URI for an agent.
	 * Priority:
	 *   1. Workspace with `path` → `{path}/.sarosworkspace/`
	 *   2. VS Code open folder   → `{folder}/.sarosworkspace/`
	 *   3. Global fallback       → `{globalDataUri}/` or `{globalDataUri}/{workspaceId}/`
	 */
	private async _resolveDataUri(workspaceId?: string): Promise<URI> {
		if (workspaceId) {
			const result = await this._getWorkspaceDataUri(workspaceId);
			this.logService.info(`[AgentStudio] _resolveDataUri(workspaceId=${workspaceId}) -> ${result.toString()}`);
			return result;
		}
		// No workspaceId — try to use the currently open VS Code folder
		const folderUri = this._getFirstWorkspaceFolderUri();
		if (folderUri) {
			const result = URI.joinPath(folderUri, WORKSPACE_DATA_DIR);
			this.logService.info(`[AgentStudio] _resolveDataUri(no workspaceId, folder=${folderUri.toString()}) -> ${result.toString()}`);
			return result;
		}
		const result = this._getGlobalDataUri();
		this.logService.info(`[AgentStudio] _resolveDataUri(no workspaceId, no folder) -> ${result.toString()}`);
		return result;
	}

	// ─── Data directory helpers ─────────────────────────────────────────────────

	/**
	 * Global data directory (~/.saros).
	 * Stores the global workspace index (workspaces.json) and fallback data
	 * for workspaces that don't have a local path.
	 *
	 * All user-level global data is stored under `~/.saros/` (userHome)
	 * for consistency with other modules (skills, marketplace, memory, etc.).
	 */
	private _getGlobalDataUri(): URI {
		if (!this._globalDataUri) {
			const customPath = this.configurationService.getValue<string>(AGENT_STUDIO_DATA_PATH_SETTING);
			if (customPath) {
				this._globalDataUri = URI.file(customPath);
			} else {
				// Use userRoamingDataHome's parent as the user home directory.
				// In VS Code, userRoamingDataHome is typically ~/.vscode-oss,
				// so we go up one level to get ~/.saros
				this._globalDataUri = URI.joinPath(this.environmentService.userRoamingDataHome, '..', '.saros');
			}
			this.logService.debug(`[AgentStudio] Global data directory: ${this._globalDataUri.toString()}`);
		}
		return this._globalDataUri;
	}

	/**
	 * Resolve the workspace-local data directory URI.
	 * If the workspace has a path, returns `{path}/.sarosworkspace/`.
	 * Otherwise falls back to `globalDataUri/{workspaceId}/`.
	 */
	private async _getWorkspaceDataUri(workspaceId: string): Promise<URI> {
		const workspaces = await this._readJsonFile<Workspace>(this._getGlobalDataUri(), DATA_FILE_WORKSPACES);
		const ws = workspaces.find(w => w.id === workspaceId);
		if (ws?.path) {
			const result = URI.joinPath(URI.file(ws.path), WORKSPACE_DATA_DIR);
			this.logService.info(`[AgentStudio] _getWorkspaceDataUri(${workspaceId}) -> ${result.toString()} (workspace has path)`);
			return result;
		}
		// Fallback: store in global directory under workspace ID
		const result = URI.joinPath(this._getGlobalDataUri(), workspaceId);
		this.logService.info(`[AgentStudio] _getWorkspaceDataUri(${workspaceId}) -> ${result.toString()} (workspace not found or no path, fallback)`);
		return result;
	}

	private async _ensureDir(dirUri: URI): Promise<void> {
		try {
			await this.fileService.stat(dirUri);
		} catch {
			try {
				await this.fileService.createFolder(dirUri);
			} catch (createErr) {
				this.logService.error('[AgentStudio] Failed to create directory', dirUri.toString(), createErr);
				throw createErr;
			}
		}
	}

	private async _readJsonFile<T extends { id?: string }>(dirUri: URI, filename: string): Promise<T[]> {
		try {
			const uri = URI.joinPath(dirUri, filename);
			const content = await this.fileService.readFile(uri);
			const parsed = JSON.parse(content.value.toString()) as T[];
			// Defensive: filter out null/undefined/corrupted entries that could crash downstream .id access
			return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object' && item.id) : [];
		} catch (err) {
			this.logService.debug(`[AgentStudio] File not found or empty: ${filename} in ${dirUri.toString()}`);
			return [];
		}
	}

	private async _writeJsonFile<T>(dirUri: URI, filename: string, data: T[]): Promise<void> {
		await this._ensureDir(dirUri);
		const uri = URI.joinPath(dirUri, filename);
		const content = VSBuffer.fromString(JSON.stringify(data, null, 2));
		await this.fileService.writeFile(uri, content);
	}

	/**
	 * Read agent bindings. These key on `agentId` (not `id`), so they can't go
	 * through the generic `_readJsonFile` (which filters by `item.id`).
	 */
	private async _readBindings(dirUri: URI): Promise<AgentBinding[]> {
		try {
			const uri = URI.joinPath(dirUri, DATA_FILE_AGENT_BINDINGS);
			const content = await this.fileService.readFile(uri);
			const parsed = JSON.parse(content.value.toString()) as AgentBinding[];
			return Array.isArray(parsed)
				? parsed.filter(item => item && typeof item === 'object' && item.agentId && item.workspaceId)
				: [];
		} catch {
			return [];
		}
	}

	/**
	 * 从名称生成 Agent ID。
	 * 规则：名称转 slug + 短随机后缀，确保可读性和唯一性。
	 * 示例："My Coding Agent" → "my-coding-agent-x7k2m"
	 */
	private _generateId(name: string): string {
		const slug = name
			.toLowerCase()
			.replace(/[^a-z0-9\s_-]/g, '')   // 移除特殊字符
			.replace(/[\s_]+/g, '-')          // 空格/下划线 → 连字符
			.replace(/-+/g, '-')              // 去重连字符
			.replace(/^-|-$/g, '')            // 去首尾连字符
			.slice(0, 40);                    // 限制长度
		const suffix = Math.random().toString(36).substring(2, 7);
		return `${slug || 'agent'}-${suffix}`;
	}

	// ─── Builtin / custom agent resolution ────────────────────────────────

	private _getBuiltinAgents(): Agent[] {
		// Delegate to the canonical builtin agent definitions which include
		// systemPrompt, skills, and tools — the old stub was missing these fields.
		return getBuiltinAgents();
	}

	// ── Agent CRUD ──────────────────────────────────────────────────────────

	/**
	 * 读取所有 agent 定义。
	 *
	 * 唯一数据源：`~/.saros/agents/{agentId}/agent.json`。
	 * 在首次读取前，确保内置 agent 已落地到该目录（初始安装 VsSaros 时，
	 * 从内置预设创建各 agent 文件）。其余来源（custom-agents.json 等）已全部移除。
	 */
	async getAgents(): Promise<Agent[]> {
		// Cache for 30s — agents rarely change during a session, and
		// every task board interaction (drag, status change, etc.) calls
		// ensureTaskAgent → getAgents() which does a full directory scan
		// + N serial file reads.  Without caching this can cost 2‑16s
		// per interaction when disk I/O is slow or agent count is high.
		const CACHE_TTL_MS = 30_000;
		const now = performance.now();
		if (this._agentsCache && (now - this._agentsCache.ts) < CACHE_TTL_MS) {
			this.logService.trace(`[AS-PERF][service] getAgents: cache HIT — ${this._agentsCache.data.length} agents (age=${(now - this._agentsCache.ts).toFixed(0)}ms)`);
			return this._agentsCache.data;
		}
		const t0 = Date.now();
		// 确保内置 agent 已落地（幂等；已存在则不覆盖用户编辑）
		await this._ensureBuiltinsSeeded();

		const agentsDir = await this._getSarosAgentsDir();
		const agents: Agent[] = [];
		try {
			const result = await this.fileService.resolve(agentsDir);
			const dirs = (result.children ?? []).filter(c => c.isDirectory);
			// Parallel read — much faster than serial await in for-loop
			const reads = dirs.map(async child => {
				const agentJsonUri = joinPath(child.resource, 'agent.json');
				try {
					const content = await this.fileService.readFile(agentJsonUri);
					const agent = JSON.parse(content.value.toString()) as Agent;
					if (agent && agent.id) { return agent; }
				} catch { /* missing agent.json — skip */ }
				return null;
			});
			const results = await Promise.all(reads);
			for (const agent of results) {
				if (agent) { agents.push(agent); }
			}
		} catch {
			// ~/.saros/agents 目录尚不存在（极少发生，seeding 应已创建）
		}

		this._agentsCache = { data: agents, ts: performance.now() };
		const t1 = Date.now();
		this.logService.info(
			`[AS-PERF][service] getAgents: TOTAL ${t1 - t0}ms, agents=${agents.length} (from ${agentsDir.toString()})`,
		);
		return agents;
	}

	/** 确保内置 agent 已落地到 ~/.saros/agents/（仅执行一次，缓存 promise）。 */
	private _ensureBuiltinsSeeded(): Promise<void> {
		if (!this._seedBuiltinsPromise) {
			this._seedBuiltinsPromise = this.ensureBuiltinAgentMdFiles().catch(err =>
				this.logService.warn('[AgentStudioService] Failed to seed builtin agent files:', err),
			);
		}
		return this._seedBuiltinsPromise;
	}

	async getAgent(id: string): Promise<Agent | undefined> {
		const agents = await this.getAgents();
		return agents.find(a => a.id === id);
	}

	/** 当前登录用户的内部标准 ID（taihu:staffid:xxx），未登录返回 undefined */
	private get _currentUserId(): string | undefined {
		return this.tofAuthService?.currentUser?.user_id;
	}

	/**
	 * 判定当前用户是否可上传（发布到商城）该 agent。
	 * - 内置 agent（source==='builtin'）不可上传（系统资产）。
	 * - owner 为空：允许认领式上传（兼容存量 / 未登录创建的 agent）。
	 * - owner 非空：仅 owner 本人可上传，避免多人维护时互相覆盖。
	 */
	canUploadAgent(agent: Agent): boolean {
		return evaluateCanUploadAgent(agent, this._currentUserId);
	}

	/** 上传成功后认领 owner：把 agent.owner 设为当前用户（用于存量 agent 首次上传）。 */
	async claimAgentOwnership(agentId: string): Promise<void> {
		const owner = resolveClaimOwner(this._currentUserId);
		if (!owner) { return; }
		try {
			await this.updateAgent(agentId, { owner });
		} catch {
			// 认领失败不阻塞上传主流程
		}
	}

	async createAgent(data: Partial<Agent>): Promise<Agent> {
		// The caller may also supply per-workspace runtime fields (workspaceId /
		// worktreePath / worktreeBranch / agentDir / memoryConfig). These are NOT
		// part of the global Agent definition — they are extracted here and
		// persisted as an AgentBinding instead.
		const runtime = data as Partial<Agent> & {
			workspaceId?: string; worktreePath?: string; worktreeBranch?: string;
			agentDir?: string; memoryConfig?: AgentBinding['memoryConfig'];
		};
		const now = new Date().toISOString();
		const id = data.id || this._generateId(data.name || 'agent');
		const agent: Agent = {
			id, name: data.name || 'New Agent', role: data.role || 'assistant',
			description: data.description || '', icon: data.icon || '🤖',
			model: data.model || 'claude-sonnet-4-20250514',
			skills: data.skills || [], tools: data.tools,
			category: data.category || 'General',
			systemPrompt: data.systemPrompt, temperature: data.temperature,
			handOffs: data.handOffs, hooks: data.hooks,
			visibility: data.visibility, agents: data.agents,
			confidenceThreshold: data.confidenceThreshold,
			parallelStrategy: data.parallelStrategy,
			// Agent type is part of the global definition (planner vs worker).
			agentType: data.agentType,
			// config.md binding is part of the definition (same across workspaces).
			configHtml: data.configHtml,
			sortOrder: data.sortOrder,
			status: data.status,
			version: data.version,
			storeId: data.storeId,
			source: 'custom',
			// owner 记录创建者（当前登录用户），用于上传权限控制；未登录时为空串（可认领式上传）
			owner: this.tofAuthService?.currentUser?.user_id ?? '',
			createdAt: now, updatedAt: now,
		};
		// NOTE: per-workspace runtime state (workspaceId / worktreePath /
		// worktreeBranch / agentDir / memoryConfig) is intentionally NOT written
		// here — it now lives on AgentBinding. If the caller supplied any of
		// those, persist them as a binding for the target workspace instead.

		// Create the agent's directory: ~/.saros/agents/{agentId}/
		// Write agent.json and .agent.md so the agent has a persistent home dir.
		try {
			const agentDir = await this.getAgentDir(id);
			try {
				await this.fileService.resolve(agentDir);
			} catch {
				await this.fileService.createFolder(agentDir);
			}
			// Write agent.json
			const agentJsonUri = joinPath(agentDir, 'agent.json');
			await this.fileService.writeFile(agentJsonUri, VSBuffer.fromString(JSON.stringify(agent, null, 2)));
			// Write .agent.md
			const toolsLine = agent.tools?.length ? `\ntools: ${agent.tools.join(', ')}` : '';
			const categoryLine = agent.category ? `\ncategory: ${agent.category}` : '';
			const agentMdContent = `---
name: ${agent.name}
description: ${agent.description || ''}
model: ${agent.model || 'claude-sonnet-4-20250514'}${toolsLine}${categoryLine}
icon: "${agent.icon || '🤖'}"
---

# ${agent.name}

${agent.systemPrompt || ''}
`;
			const agentMdUri = joinPath(agentDir, '.agent.md');
			await this.fileService.writeFile(agentMdUri, VSBuffer.fromString(agentMdContent));
			this.logService.info(`[AgentStudio] Created agent dir + files at ${agentDir.toString()}`);
		} catch (err) {
			this.logService.warn(`[AgentStudio] createAgent: failed to create agent dir for ${id}: ${err instanceof Error ? err.message : String(err)}`);
		}

		// If bootstrapTemplates were provided, create a .agent.md file so the
		// agent appears in the native chat mode picker with its icon and metadata.
		const bootstrap = (data as any).bootstrapTemplates;
		if (bootstrap?.agentsMd) {
			try {
				await this._createAgentMdFile(agent, bootstrap.agentsMd);
			} catch (err) {
				this.logService.warn(`[AgentStudio] createAgent: failed to create .agent.md for ${id}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		if (runtime.workspaceId) {
			try {
				await this.upsertAgentBinding(runtime.workspaceId, id, {
					worktreePath: runtime.worktreePath,
					worktreeBranch: runtime.worktreeBranch,
					agentDir: runtime.agentDir,
					memoryConfig: runtime.memoryConfig,
				});
			} catch (err) {
				this.logService.warn(`[AgentStudio] createAgent: failed to persist binding for ${id} in ${runtime.workspaceId}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		// 清除缓存，确保下次 getAgents() 返回包含新 agent 的数据
		this._agentsCache = undefined;
		this._onDidChangeAgents.fire();
		return agent;
	}

	/**
	 * Gets the unified agent directory: `~/.saros/agents/`.
	 * This is the single source of truth for all agent definitions.
	 */
	private async _getSarosAgentsDir(): Promise<URI> {
		const userHome = await this.pathService.userHome();
		return joinPath(userHome, '.saros', 'agents');
	}

	/** Resolve the OS user home directory path (e.g. /home/user). */
	async resolveUserHome(): Promise<string> {
		const home = await this.pathService.userHome();
		return home.fsPath;
	}

	/** KB storage root (~/.saros/knowledge-base by default, config-overridable). */
	private async _resolveKbStorageRoot(): Promise<string> {
		const cfg = this.configurationService.getValue<string>('agentStudio.knowledge.storage.path');
		const userHome = (await this.pathService.userHome()).fsPath;
		return resolveKbRoot(cfg, userHome);
	}

	/** Workspace root — used to resolve relative source file paths in kb_* tools. */
	private async _resolveWorkspaceDir(): Promise<string> {
		const wsId = this.getActiveWorkspaceId();
		if (wsId) {
			const ws = await this.getWorkspace(wsId);
			if (ws?.path) { return ws.path; }
		}
		return (await this.pathService.userHome()).fsPath;
	}

	/**
	 * Import an LLM chat message into the knowledge base engine. Routes to
	 * `kb_build` (new note) or `kb_ingest` (improve existing note) via
	 * `importMessageToKnowledgeBase` in `knowledgeTools.ts`.
	 */
	async importMessageToKnowledgeBase(content: string, opts?: ImportToKbOptions): Promise<ImportToKbResult> {
		const deps = this._buildKbToolDeps();
		return importMessageToKnowledgeBase(deps, content, opts);
	}

	/** Build the `KnowledgeToolDeps` shared by all KB engine operations (message import + folder RAG). */
	private _buildKbToolDeps(): KnowledgeToolDeps {
		return {
			fileService: this.fileService,
			configurationService: this.configurationService,
			embeddingService: this.embeddingService,
			resolveBaseDir: () => this._resolveWorkspaceDir(),
		resolveStorageRoot: () => this._resolveKbStorageRoot(),
		// 跨库检索：暴露全局文件夹 RAG 索引读取器（kb_search_repo 用它 fan-out 各仓库 session）。
		readFolderRagIndex: () => this._readFolderRagIndex(),
		// 知识库操作的 chat 模型一律取自「辅助模型 → Curator」配置，解除对 KB agent 的依赖。
		resolveKbModel: () => this._resolveKbChatModel(),
			// Embedding 一律使用「辅助模型 → Embedding」配置（provider/model/dimensions），
			// 不再跟随 KB agent；provider 留空时由 resolver 回退到全局 embedding provider。
			createKbEmbedder: (_providerId: string) => {
				// P2 修复：优先取用户显式配置的 aux embedding provider，
				// 未配置时回退到知识库操作所使用的 chat model 的 provider（_providerId），
				// 因为 chat model 是可用的（否则 KB 导入本身无法调用 LLM）。
				const resolvedId = resolveAuxEmbeddingProviderId(this.configurationService)
					?? (_providerId || 'openrouter');
				return createKbEmbedder(
					this.configurationService,
					this.logService,
					{
						providerId: resolvedId,
						model: resolveAuxEmbeddingConfig(this.configurationService).modelId,
						dimensions: resolveAuxEmbeddingConfig(this.configurationService).dimensions,
					},
				);
			},
		};
	}

	/**
	 * Import a linked/copied folder as per-repo RAG (Option A): one git repository →
	 * one KnowledgeSession. Delegates to `importFolderToRag` in knowledgeTools, which
	 * builds a real KnowledgeManager + an IFileService-backed probe and persists the
	 * sessions to the KB storage root. Returns the repoRoot→sessionId map (plus any
	 * per-repo errors) so the caller can record it on the vault for later re-query or
	 * re-ingest after a `git pull`.
	 */
	async importFolderToRag(folderPath: string, opts?: BuildFolderOptions): Promise<FolderRagResult> {
		const result = await importFolderToRag(this._buildKbToolDeps(), folderPath, opts);
		// Register the new repoRoot→sessionId map in the global folder-RAG index so
		// `kb_search_repo` can fan out across every imported repository session.
		const index = await this._readFolderRagIndex();
		for (const [repoRoot, sid] of Object.entries(result.sessions)) {
			index[repoRoot] = sid;
		}
		if (result.unversionedSessionId) {
			index[`${folderPath}::unversioned`] = result.unversionedSessionId;
		}
		await this._writeFolderRagIndex(index);
		return result;
	}

	// ── Folder RAG global index (cross-repo search registry) ──────────────────
	// Aggregates `repoRoot → sessionId` across ALL imported folders, independent of
	// per-vault bookkeeping, so `kb_search_repo` / `searchFolderRag` can query every
	// imported repository regardless of which vault it lives in. Stored next to the
	// KB storage root as `.folderRagIndex.json`.

	private async _folderRagIndexPath(): Promise<URI> {
		return URI.joinPath(URI.file(await this._resolveKbStorageRoot()), '.folderRagIndex.json');
	}

	private async _readFolderRagIndex(): Promise<Record<string, string>> {
		try {
			const buf = await this.fileService.readFile(await this._folderRagIndexPath());
			const parsed = JSON.parse(buf.value.toString());
			return (parsed && typeof parsed === 'object') ? (parsed as Record<string, string>) : {};
		} catch {
			return {};
		}
	}

	private async _writeFolderRagIndex(map: Record<string, string>): Promise<void> {
		const root = await this._resolveKbStorageRoot();
		await this._ensureDir(URI.file(root));
		await this.fileService.writeFile(await this._folderRagIndexPath(), VSBuffer.fromString(JSON.stringify(map, null, 2)));
	}

	/** Remove a folder (and its sub-tree) from the global folder-RAG index (on unlink). */
	async unlinkFolderRag(folderPath: string): Promise<void> {
		const index = await this._readFolderRagIndex();
		const kept: Record<string, string> = {};
		for (const [repoRoot, sid] of Object.entries(index)) {
			if (repoRoot === folderPath
				|| repoRoot.startsWith(folderPath + '/')
				|| repoRoot.startsWith(folderPath + '\\')
				|| repoRoot === `${folderPath}::unversioned`) {
				continue;
			}
			kept[repoRoot] = sid;
		}
		await this._writeFolderRagIndex(kept);
	}

	/** Cross-repository semantic search over every imported folder's RAG sessions. */
	async searchFolderRag(query: string, topK = 5): Promise<FolderRagSearchResult> {
		return searchFolderRag(this._buildKbToolDeps(), query, topK);
	}

	/**
	 * LLM 驱动的智能内容分类（复刻 Hyper-Extract 的 guideline.target + structured output 模式）。
	 * 失败时自动降级到关键词启发式分类，保证零中断。
	 */
	async classifyContent(content: string): Promise<{ category: string; label: string; confidence: number; reasoning: string; source: 'llm' | 'keyword' }> {
		try {
			const kb = this._resolveKbChatModel();
			const chatModel = resolveChatModel(this.configurationService, { providerId: kb.providerId, modelId: kb.modelId });
			return await classifyContentViaLLM(chatModel, content);
		} catch {
			return classifyByKeywords(content);
		}
	}

	/**
	 * 解析知识库操作（收藏 / 分类 / 导入）使用的 chat 模型，解除对 knowledge-base-expert
	 * agent 的依赖：优先取「辅助模型 → Curator」配置，未配置时回退到默认 openrouter 模型。
	 */
	private _resolveKbChatModel(): { providerId: string; modelId: string } {
		const provider = (this.configurationService.getValue<string>(AGENT_STUDIO_AUX_CURATOR_PROVIDER) || 'auto').trim();
		const model = (this.configurationService.getValue<string>(AGENT_STUDIO_AUX_CURATOR_MODEL) || '').trim();
		if (provider && provider !== 'auto' && model) {
			return { providerId: provider, modelId: model };
		}
		return { providerId: 'openrouter', modelId: 'openai/gpt-4o-mini' };
	}

	/**
	 * Resolve the per-agent directory: `~/.saros/agents/{agentId}/`.
	 * Contains agent.json, .agent.md, config.html, and HTML assets.
	 */
	async getAgentDir(agentId: string): Promise<URI> {
		const agentsDir = await this._getSarosAgentsDir();
		return joinPath(agentsDir, agentId);
	}

	/**
	 * Creates a `.agent.md` file in `~/.saros/agents/{agentId}/` so the agent
	 * appears in the native chat mode picker with its icon and metadata.
	 * If the agentsMd content lacks YAML front matter with an `icon` field,
	 * prepends one using the agent's `icon` property.
	 */
	private async _createAgentMdFile(agent: Agent, agentsMdContent: string): Promise<void> {
		const agentDir = await this.getAgentDir(agent.id);

		// Ensure the directory exists
		try {
			await this.fileService.resolve(agentDir);
		} catch {
			await this.fileService.createFolder(agentDir);
		}

		// If the content already has YAML front matter with icon, use as-is.
		// Otherwise, prepend a minimal front matter with the icon field.
		let content = agentsMdContent;
		const hasFrontMatter = content.startsWith('---');
		const hasIconInFrontMatter = hasFrontMatter && /^---[\s\S]*?icon\s*:/m.test(content);

		if (!hasIconInFrontMatter && agent.icon) {
			if (hasFrontMatter) {
				// Insert icon into existing front matter (after the opening ---)
				content = content.replace(/^---/, `---\nicon: "${agent.icon}"`);
			} else {
				// Prepend a new front matter block
				content = `---\nname: ${agent.name}\ndescription: ${agent.description || ''}\nicon: "${agent.icon}"\n---\n\n${content}`;
			}
		}

		const fileUri = joinPath(agentDir, '.agent.md');
		await this.fileService.writeFile(fileUri, VSBuffer.fromString(content));
		this.logService.info(`[AgentStudio] Created .agent.md at ${fileUri.toString()}`);
	}

	/**
	 * Ensures every builtin agent has a dedicated directory at
	 * `~/.saros/agents/{agentId}/` containing:
	 *   - agent.json   (agent definition, for config/reading)
	 *   - .agent.md    (YAML front matter + system prompt, for chat mode picker)
	 *
	 * Only creates files that don't already exist — never overwrites user edits.
	 */
	async ensureBuiltinAgentMdFiles(): Promise<void> {
		const agentsDir = await this._getSarosAgentsDir();

		// Ensure ~/.saros/agents/ exists
		try {
			await this.fileService.resolve(agentsDir);
		} catch {
			try {
				await this.fileService.createFolder(agentsDir);
			} catch {
				return; // Can't create directory — silently skip
			}
		}

		const builtinAgents = getBuiltinAgents();
		for (const agent of builtinAgents) {
			const agentDir = joinPath(agentsDir, agent.id);

			// Ensure per-agent directory exists
			try {
				await this.fileService.resolve(agentDir);
			} catch {
				try {
					await this.fileService.createFolder(agentDir);
				} catch (err) {
					this.logService.warn(`[AgentStudio] Failed to create dir for "${agent.name}": ${err}`);
					continue;
				}
			}

			// Write agent.json if it doesn't exist（写入完整 agent 定义）
			const agentJsonUri = joinPath(agentDir, 'agent.json');
			try {
				await this.fileService.resolve(agentJsonUri);
			} catch {
				try {
					await this.fileService.writeFile(agentJsonUri, VSBuffer.fromString(JSON.stringify(agent, null, 2)));
					this.logService.info(`[AgentStudio] Seeded agent.json for "${agent.name}" at ${agentJsonUri.toString()}`);
				} catch (err) {
					this.logService.warn(`[AgentStudio] Failed to seed agent.json for "${agent.name}": ${err}`);
				}
			}

			// Write .agent.md if it doesn't exist
			const agentMdUri = joinPath(agentDir, '.agent.md');
			try {
				await this.fileService.resolve(agentMdUri);
				continue; // File exists, skip
			} catch {
				// File doesn't exist — proceed to create it
			}

			const toolsLine = agent.tools?.length ? `\ntools: ${agent.tools.join(', ')}` : '';
			const categoryLine = agent.category ? `\ncategory: ${agent.category}` : '';
			const content = `---
name: ${agent.name}
description: ${agent.description || ''}
model: ${agent.model || 'claude-sonnet-4-20250514'}${toolsLine}${categoryLine}
icon: "${agent.icon || '🤖'}"
---

# ${agent.name}

${agent.systemPrompt || ''}
`;

			try {
				await this.fileService.writeFile(agentMdUri, VSBuffer.fromString(content));
				this.logService.info(`[AgentStudio] Seeded .agent.md for builtin agent "${agent.name}" at ${agentMdUri.toString()}`);
			} catch (err) {
				this.logService.warn(`[AgentStudio] Failed to seed .agent.md for "${agent.name}": ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	async updateAgent(id: string, data: Partial<Agent>): Promise<void> {
		// Split incoming patch: definition fields go to the agent.json file in
		// ~/.saros/agents/{id}/, per-workspace runtime fields go to the binding.
		const { workspaceId, worktreePath, worktreeBranch, agentDir, memoryConfig, ...defPatch } = data as Partial<Agent> & {
			workspaceId?: string; worktreePath?: string; worktreeBranch?: string; agentDir?: string; memoryConfig?: AgentBinding['memoryConfig'];
		};

		const hasRuntimePatch = worktreePath !== undefined || worktreeBranch !== undefined || agentDir !== undefined || memoryConfig !== undefined;
		if (hasRuntimePatch) {
			if (workspaceId) {
				await this.upsertAgentBinding(workspaceId, id, { worktreePath, worktreeBranch, agentDir, memoryConfig });
			} else {
				this.logService.warn(`[AgentStudio] updateAgent(${id}): runtime fields provided without workspaceId — binding not updated. Pass workspaceId to persist per-workspace state.`);
			}
		}

		// If only runtime fields were provided, we're done.
		if (Object.keys(defPatch).length === 0) {
			if (hasRuntimePatch) { this._agentsCache = undefined; this._onDidChangeAgents.fire(); }
			return;
		}

		// 读取目录中的 agent.json，合并补丁后写回 ~/.saros/agents/{id}/agent.json
		const agentDirUri = await this.getAgentDir(id);
		const agentJsonUri = joinPath(agentDirUri, 'agent.json');
		let existing: Agent;
		try {
			const buf = await this.fileService.readFile(agentJsonUri);
			existing = JSON.parse(buf.value.toString()) as Agent;
		} catch {
			// agent.json 不存在：基于内置定义创建（用户编辑内置 agent 时也走此路径）
			const builtin = this._getBuiltinAgents().find(a => a.id === id);
			if (!builtin) { throw new Error(`Agent not found: ${id}`); }
			existing = { ...builtin };
		}
		const updated: Agent = { ...existing, ...defPatch, id, updatedAt: new Date().toISOString() };

		// 当启用 configHtml 时，自动将 confightml skill 加入 agent skills 列表
		if (updated.configHtml && !(updated.skills ?? []).includes('confightml')) {
			updated.skills = [...(updated.skills ?? existing.skills ?? []), 'confightml'];
			this.logService.info(`[AgentStudio] Auto-added "confightml" skill for agent "${id}" (configHtml enabled)`);
		}

		await this._updateAgentJsonFile(updated);

		// Sync .agent.md file if definition fields changed
		if (defPatch.name || defPatch.description || defPatch.icon || defPatch.model || defPatch.tools || defPatch.systemPrompt) {
			await this._updateAgentMdFile(updated);
		}

		this._agentsCache = undefined;
		this._onDidChangeAgents.fire();
	}

	// ─── Agent Bindings (per-workspace runtime instance state) ──────────────

	async getAgentBindings(workspaceId: string): Promise<AgentBinding[]> {
		const dirUri = await this._resolveDataUri(workspaceId);
		return this._readBindings(dirUri);
	}

	async getAgentBinding(workspaceId: string, agentId: string): Promise<AgentBinding | undefined> {
		const bindings = await this.getAgentBindings(workspaceId);
		return bindings.find(b => b.agentId === agentId);
	}

	async upsertAgentBinding(workspaceId: string, agentId: string, patch: Partial<AgentBinding>): Promise<AgentBinding> {
		const dirUri = await this._resolveDataUri(workspaceId);
		const bindings = await this._readBindings(dirUri);
		const now = new Date().toISOString();
		const idx = bindings.findIndex(b => b.agentId === agentId);
		// 显式设置 worktreePath（含置 undefined）且未携带 tempWorktreeOverride → 视为用户/系统的
		// 主动意图，清除可能残留的临时覆盖标记，避免僵尸标记误导启动自愈。
		// AgentDriver 的临时覆盖/恢复因同时传 tempWorktreeOverride，不受影响。
		const clearsTempOverride = 'worktreePath' in patch && !('tempWorktreeOverride' in patch);
		const { agentId: _a, workspaceId: _w, createdAt: _c, ...rest } = patch;
		let result: AgentBinding;
		if (idx === -1) {
			result = {
				agentId, workspaceId,
				...rest,
				...(clearsTempOverride ? { tempWorktreeOverride: undefined } : {}),
				createdAt: now, updatedAt: now,
			};
			bindings.push(result);
		} else {
			// Merge patch, but never let agentId/workspaceId/createdAt be overwritten.
			result = {
				...bindings[idx],
				...rest,
				...(clearsTempOverride ? { tempWorktreeOverride: undefined } : {}),
				agentId, workspaceId, updatedAt: now,
			};
			bindings[idx] = result;
		}
		await this._writeJsonFile(dirUri, DATA_FILE_AGENT_BINDINGS, bindings);
		return result;
	}

	async deleteAgentBinding(workspaceId: string, agentId: string): Promise<void> {
		const dirUri = await this._resolveDataUri(workspaceId);
		const bindings = await this._readBindings(dirUri);
		const filtered = bindings.filter(b => b.agentId !== agentId);
		if (filtered.length === bindings.length) { return; }
		await this._writeJsonFile(dirUri, DATA_FILE_AGENT_BINDINGS, filtered);
	}

	async deleteAgent(id: string): Promise<void> {
		// 删除 agent 目录 ~/.saros/agents/{agentId}/（唯一数据源）。
		// 注意：内置 agent 在下次启动时会被重新 seed（保证始终可用），
		// 自定义 agent 删除后不会恢复。
		await this._deleteAgentDir(id);
		this._agentsCache = undefined;
		this._onDidChangeAgents.fire();
	}

	/**
	 * Deletes the entire agent directory at `~/.saros/agents/{agentId}/`.
	 * Also tries legacy slug-based .agent.md for backward compat.
	 */
	private async _deleteAgentDir(agentId: string): Promise<void> {
		const agentDir = await this.getAgentDir(agentId);
		try {
			await this.fileService.del(agentDir, { recursive: true });
			this.logService.info(`[AgentStudio] Deleted agent dir at ${agentDir.toString()}`);
		} catch { /* dir may not exist */ }
	}

	/**
	 * Updates the `.agent.md` file for the given agent, syncing the YAML
	 * front matter with the latest agent definition. If the agent name
	 * changed, the old file is deleted and a new one is created.
	 */
	private async _updateAgentMdFile(agent: Agent): Promise<void> {
		const agentDir = await this.getAgentDir(agent.id);
		const targetUri = joinPath(agentDir, '.agent.md');

		// Ensure directory exists
		try {
			await this.fileService.resolve(agentDir);
		} catch {
			await this.fileService.createFolder(agentDir);
		}

		// Try to read existing content to preserve user edits
		let existingContent: string | undefined;
		try {
			const buf = await this.fileService.readFile(targetUri);
			existingContent = buf.value.toString();
		} catch {
			// No existing file — will create new
		}

		// Build updated YAML front matter
		const toolsLine = agent.tools?.length ? `\ntools: ${agent.tools.join(', ')}` : '';
		const categoryLine = agent.category ? `\ncategory: ${agent.category}` : '';
		const frontMatter = `---
name: ${agent.name}
description: ${agent.description || ''}
model: ${agent.model || 'claude-sonnet-4-20250514'}${toolsLine}${categoryLine}
icon: "${agent.icon || '🤖'}"
---`;

		// Preserve existing body or use systemPrompt
		let body = '';
		if (existingContent) {
			// Extract body after the second --- 
			const bodyMatch = existingContent.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
			body = bodyMatch?.[1]?.trim() || '';
		}
		if (!body && agent.systemPrompt) {
			body = `# ${agent.name}\n\n${agent.systemPrompt}`;
		}

		const content = `${frontMatter}\n\n${body}\n`;
		await this.fileService.writeFile(targetUri, VSBuffer.fromString(content));

		this.logService.info(`[AgentStudio] Updated .agent.md at ${targetUri.toString()}`);
	}

	/**
	 * Update the agent.json file in ~/.saros/agents/{agentId}/ when the agent
	 * definition changes (e.g. rename, description, icon, etc.).
	 */
	private async _updateAgentJsonFile(agent: Agent): Promise<void> {
		try {
			const agentDir = await this.getAgentDir(agent.id);
			const agentJsonUri = joinPath(agentDir, 'agent.json');
			// Ensure directory exists
			try {
				await this.fileService.resolve(agentDir);
			} catch {
				await this.fileService.createFolder(agentDir);
			}
			await this.fileService.writeFile(agentJsonUri, VSBuffer.fromString(JSON.stringify(agent, null, 2)));
			this.logService.info(`[AgentStudio] Updated agent.json at ${agentJsonUri.toString()}`);
		} catch (err) {
			this.logService.warn(`[AgentStudio] Failed to update agent.json for ${agent.id}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async getLastSelectedAgentId(): Promise<string | null> {
		try {
			const uri = URI.joinPath(this._getGlobalDataUri(), DATA_FILE_LAST_ACTIVE_AGENT);
			const content = await this.fileService.readFile(uri);
			const data = JSON.parse(content.value.toString());
			return data.lastAgentId || null;
		} catch { return null; }
	}

	async setLastSelectedAgentId(id: string | null): Promise<void> {
		const uri = URI.joinPath(this._getGlobalDataUri(), DATA_FILE_LAST_ACTIVE_AGENT);
		await this._ensureDir(this._getGlobalDataUri());
		const content = VSBuffer.fromString(JSON.stringify({ lastAgentId: id }, null, 2));
		await this.fileService.writeFile(uri, content);
	}

	/**
	 * Reverse-lookup the `workspaceId` for the VS Code folder the user
	 * currently has open. Reads workspaces.json and matches by normalised
	 * absolute path. Returns `undefined` if no folder is open or no
	 * matching workspace record exists.
	 */
	private async _inferWorkspaceIdFromActiveFolder(): Promise<string | undefined> {
		const folderUri = this._getFirstWorkspaceFolderUri();
		if (!folderUri) { return undefined; }
		try {
			const workspaces = await this._readJsonFile<Workspace>(this._getGlobalDataUri(), DATA_FILE_WORKSPACES);
			const targetPath = folderUri.fsPath;
			const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
			const targetNorm = norm(targetPath);
			const match = workspaces.find(w => w.path && norm(w.path) === targetNorm);
			return match?.id;
		} catch (err) {
			this.logService.warn(`[AgentStudio] _inferWorkspaceIdFromActiveFolder failed: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	// ─── Workspaces ─────────────────────────────────────────────────────────────

	async getWorkspaces(): Promise<Workspace[]> {
		const rawWorkspaces = await this._readJsonFile<Workspace>(this._getGlobalDataUri(), DATA_FILE_WORKSPACES);
		const workspaces = rawWorkspaces.map(w => migrateWorkspace(w));

		// Auto-discover: if the global workspace index is empty but the current
		// VS Code folder already contains a .sarosworkspace directory (e.g.
		// user deleted workspaces.json or switched to a fresh VS Code profile),
		// automatically create a workspace entry so that agents and layout
		// are visible without manual workspace recreation.
		if (workspaces.length === 0) {
			const folderUri = this._getFirstWorkspaceFolderUri();
			if (folderUri) {
				const localDirUri = URI.joinPath(folderUri, WORKSPACE_DATA_DIR);
				try {
					await this.fileService.stat(localDirUri);
					// Local data directory exists — auto-create a workspace entry
					const wsName = folderUri.path.split('/').pop() || 'Workspace';
					const ws: Workspace = {
						id: this._generateId(wsName),
						name: wsName,
						path: folderUri.fsPath,
						relatedFolders: [],
						agents: [],
						connections: [],
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					};
					workspaces.push(ws);
					await this._writeJsonFile(this._getGlobalDataUri(), DATA_FILE_WORKSPACES, workspaces);
					this.logService.info(`[AgentStudio] Auto-discovered workspace from ${folderUri.fsPath}`);
				} catch {
					// No local data — keep empty
				}
			}
		}

		return workspaces;
	}

	async getWorkspace(id: string): Promise<Workspace | undefined> {
		const workspaces = await this._readJsonFile<Workspace>(this._getGlobalDataUri(), DATA_FILE_WORKSPACES);
		const found = workspaces.find(w => w.id === id);
		return found ? migrateWorkspace(found) : undefined;
	}

	async getWorktrees(workspaceId: string): Promise<any[]> {
		const workspace = await this.getWorkspace(workspaceId);
		if (!workspace) {
			return [];
		}

		// IMPORTANT: `workspace.path` is the workspace HOME/metadata directory
		// (holds .sarosworkspace, artifacts) and is NOT a git repository, so
		// running `git worktree list` there fails and returns []. The actual
		// code lives in `relatedFolders[].path` (the real git roots).
		//
		// A workspace may associate MULTIPLE code repositories (home dir +
		// every related folder). We aggregate worktrees from ALL git roots so
		// the agent-card worktree dropdown mirrors the Source Control Worktree
		// view (which already groups across repos via getAllRepositoryRoots).
		const repoRoots = await this._resolveAllWorktreeRepoRoots(workspace);
		if (repoRoots.length === 0) {
			this.logService.info(`[AgentStudio] getWorktrees(${workspaceId}): no git repo root resolved (relatedFolders/path all non-git) — worktree feature unavailable for this workspace`);
			return [];
		}

		this.logService.info(`[AgentStudio] getWorktrees(${workspaceId}): aggregating worktrees across ${repoRoots.length} repo root(s): ${repoRoots.join(', ')}`);
		const aggregated: any[] = [];
		const seen = new Set<string>();
		for (const repoRoot of repoRoots) {
			let details: IWorktreeDetail[];
			try {
				details = await this.worktreeService.listWorktrees(repoRoot);
			} catch (err) {
				this.logService.warn(`[AgentStudio] getWorktrees(${workspaceId}): listWorktrees failed for "${repoRoot}"`, err);
				continue;
			}
			const repoName = repoRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || repoRoot;
			for (const d of details) {
				// De-dup by worktree path across repos (a path should appear once).
				const norm = d.path.replace(/[\\/]+$/, '').toLowerCase();
				if (seen.has(norm)) {
					continue;
				}
				seen.add(norm);

				// Fetch extended metadata for this worktree (VS Code compatible)
				let metadata: Partial<IWorktreeDetail> = {};
				try {
					metadata = await this.worktreeService.getWorktreeMetadata(d.path);
				} catch (err) {
					this.logService.warn(`[AgentStudio] getWorktrees: getWorktreeMetadata failed for "${d.path}"`, err);
				}

				// Annotate each worktree with its owning repository so the UI
				// can group/label entries when multiple repos are associated.
				aggregated.push({ ...d, ...metadata, repoRoot, repoName });
			}
		}
		this.logService.info(`[AgentStudio] getWorktrees(${workspaceId}): aggregated ${aggregated.length} worktree(s)`);
		return aggregated;
	}

	/**
	 * Resolve ALL git repository roots for worktree listing across the whole
	 * workspace. Collects, in priority order and de-duplicated:
	 *   1. every `relatedFolders[]` entry that is a git repo (the real code
	 *      repositories where worktrees are created),
	 *   2. all repo roots the worktree service can probe from the active VS
	 *      Code workspace folders (getAllRepositoryRoots — home + related +
	 *      worktree dirs that contain a `.git`),
	 *   3. `workspace.path` itself if it happens to be a git repo (legacy
	 *      single-folder workspaces).
	 *
	 * Returns the full set so the agent-card worktree dropdown can aggregate
	 * worktrees from every associated repository — staying in sync as related
	 * code repositories are imported/removed.
	 */
	private async _resolveAllWorktreeRepoRoots(workspace: Workspace): Promise<string[]> {
		const roots: string[] = [];
		const seen = new Set<string>();
		const push = (raw: string | undefined, source: string) => {
			if (!raw) {
				return;
			}
			const norm = raw.replace(/[\\/]+$/, '').toLowerCase();
			if (!norm || seen.has(norm)) {
				return;
			}
			seen.add(norm);
			this.logService.info(`[AgentStudio] _resolveAllWorktreeRepoRoots: + ${raw} (from ${source})`);
			roots.push(raw);
		};

		// 1. relatedFolders — the real code repositories.
		const related = workspace.relatedFolders ?? [];
		this.logService.info(`[AgentStudio] _resolveAllWorktreeRepoRoots: workspace has ${related.length} relatedFolder(s), path="${workspace.path}"`);
		for (const folder of related) {
			if (!folder?.path) {
				continue;
			}
			if (folder.isGitRepo === true || await this._detectGitRepo(folder.path)) {
				push(folder.path, 'relatedFolder');
			}
		}

		// 2. All git roots the worktree service sees in the active VS Code
		//    workspace folders (covers cases where the active workspace was
		//    synced from a different code path than relatedFolders).
		try {
			const serviceRoots = await this.worktreeService.getAllRepositoryRoots();
			this.logService.info(`[AgentStudio] _resolveAllWorktreeRepoRoots: getAllRepositoryRoots returned ${serviceRoots.length} repo(s): ${serviceRoots.join(', ')}`);
			for (const r of serviceRoots) {
				push(r, 'getAllRepositoryRoots');
			}
		} catch (err) {
			this.logService.warn('[AgentStudio] _resolveAllWorktreeRepoRoots: getAllRepositoryRoots failed', err);
		}

		// 3. Legacy fallback: workspace.path itself is a git repo.
		if (workspace.path && await this._detectGitRepo(workspace.path)) {
			push(workspace.path, 'workspace.path');
		}

		return roots;
	}

	async createWorkspace(data: Partial<Workspace>): Promise<Workspace> {
		const workspaces = await this._readJsonFile<Workspace>(this._getGlobalDataUri(), DATA_FILE_WORKSPACES);
		const now = new Date().toISOString();

		// Auto-detect path from VS Code workspace folder if not provided
		let wsPath = data.path;
		if (!wsPath) {
			const folderUri = this._getFirstWorkspaceFolderUri();
			if (folderUri) {
				wsPath = folderUri.fsPath;
				this.logService.info(`[AgentStudio] createWorkspace: auto-detected workspace folder path: ${wsPath}`);
			}
		}

		const newWorkspace: Workspace = {
			id: this._generateId(data.name || 'New Workspace'),
			name: data.name || 'New Workspace',
			description: data.description,
			path: wsPath,
			relatedFolders: data.relatedFolders ?? [],
			agents: data.agents || [],
			connections: data.connections || [],
			layout: data.layout,
			filesExclude: data.filesExclude,
			createdAt: now,
			updatedAt: now,
		};
		workspaces.push(newWorkspace);

		// Save the global workspace index
		await this._writeJsonFile(this._getGlobalDataUri(), DATA_FILE_WORKSPACES, workspaces);

		// Create .sarosworkspace directory in the workspace folder (if path is set)
		if (newWorkspace.path) {
			try {
				const wsDataUri = URI.joinPath(URI.file(newWorkspace.path), WORKSPACE_DATA_DIR);
				await this._ensureDir(wsDataUri);
				// Write a workspace manifest into the directory
				await this._writeJsonFile(wsDataUri, 'workspace.json', [newWorkspace]);
				this.logService.info(`[AgentStudio] Created ${WORKSPACE_DATA_DIR} directory at: ${newWorkspace.path}`);
			} catch (err) {
				this.logService.warn(`[AgentStudio] Could not create ${WORKSPACE_DATA_DIR} directory at workspace path: ${newWorkspace.path}`, err);
				// Non-fatal: workspace is still created in global index
			}
		}

		this._onDidChangeWorkspace.fire(newWorkspace.id);
		this._fireWorkspaceLifecycle(WorkspaceLifecycleEvent.Created, newWorkspace);
		return newWorkspace;
	}

	async updateWorkspace(id: string, data: Partial<Workspace>): Promise<Workspace> {
		const workspaces = await this._readJsonFile<Workspace>(this._getGlobalDataUri(), DATA_FILE_WORKSPACES);
		const index = workspaces.findIndex(w => w.id === id);
		if (index === -1) {
			throw new Error(`Workspace not found: ${id}`);
		}
		// Protect critical fields from being accidentally overwritten by undefined.
		// If the caller explicitly passes undefined for path/name, we keep the existing value
		// to prevent accidental data loss (e.g. webview partial updates, message protocol quirks).
		const safeData: Partial<Workspace> = { ...data };
		if (safeData.path === undefined && workspaces[index].path !== undefined) {
			delete (safeData as any).path;
		}
		if (safeData.name === undefined && workspaces[index].name !== undefined) {
			delete (safeData as any).name;
		}
		workspaces[index] = {
			...workspaces[index],
			...safeData,
			id,
			updatedAt: new Date().toISOString(),
		};
		await this._writeJsonFile(this._getGlobalDataUri(), DATA_FILE_WORKSPACES, workspaces);

		// Update workspace manifest in .sarosworkspace if path exists
		if (workspaces[index].path) {
			try {
				const wsDataUri = URI.joinPath(URI.file(workspaces[index].path!), WORKSPACE_DATA_DIR);
				await this._writeJsonFile(wsDataUri, 'workspace.json', [workspaces[index]]);
			} catch (err) {
				this.logService.debug('[AgentStudio] Could not update workspace manifest in workspace dir', err);
			}
		}

		this._onDidChangeWorkspace.fire(id);
		this._fireWorkspaceLifecycle(WorkspaceLifecycleEvent.Updated, workspaces[index]);
		return workspaces[index];
	}

	async deleteWorkspace(id: string): Promise<void> {
		const workspaces = await this._readJsonFile<Workspace>(this._getGlobalDataUri(), DATA_FILE_WORKSPACES);
		const target = workspaces.find(w => w.id === id);
		const filtered = workspaces.filter(w => w.id !== id);
		await this._writeJsonFile(this._getGlobalDataUri(), DATA_FILE_WORKSPACES, filtered);

		// Optionally clean up workspace-local data directory
		// (We don't delete .sarosworkspace to preserve user data on disk)
		if (target?.path) {
			this.logService.info(`[AgentStudio] Workspace deleted from index. ${WORKSPACE_DATA_DIR} directory preserved at: ${target.path}`);
		}

		this._onDidChangeWorkspace.fire(id);
		if (target) {
			this._fireWorkspaceLifecycle(WorkspaceLifecycleEvent.Deleted, target);
		}
	}

	async updateWorkspaceLayout(id: string, layout: WorkspaceLayout): Promise<void> {
		const workspaces = await this._readJsonFile<Workspace>(this._getGlobalDataUri(), DATA_FILE_WORKSPACES);
		const index = workspaces.findIndex(w => w.id === id);
		if (index === -1) {
			throw new Error(`Workspace not found: ${id}`);
		}
		workspaces[index].layout = layout;

		// Sync edges from layout to connections to keep data consistent
		if (layout.edges) {
			workspaces[index].connections = layout.edges.map(e => ({
				id: e.id,
				sourceId: e.source,
				targetId: e.target,
				type: (e.type as ConnectionType) || ConnectionType.Subagent,
				label: (e.data?.label as string) || '',
			}));
		}

		workspaces[index].updatedAt = new Date().toISOString();
		await this._writeJsonFile(this._getGlobalDataUri(), DATA_FILE_WORKSPACES, workspaces);

		// Also persist layout to workspace-local dir
		if (workspaces[index].path) {
			try {
				const wsDataUri = URI.joinPath(URI.file(workspaces[index].path!), WORKSPACE_DATA_DIR);
				await this._ensureDir(wsDataUri);
				const layoutContent = VSBuffer.fromString(JSON.stringify(layout, null, 2));
				await this.fileService.writeFile(URI.joinPath(wsDataUri, 'layout.json'), layoutContent);
			} catch (err) {
				this.logService.debug('[AgentStudio] Could not save layout to workspace dir', err);
			}
		}

		this._onDidChangeWorkspace.fire(id);
	}

	// ─── Last Active Workspace ────────────────────────────────────

	/**
	 * Get the ID of the last active workspace.
	 * Returns null if no workspace has been activated yet.
	 */
	async getLastActiveWorkspaceId(): Promise<string | null> {
		try {
			const uri = URI.joinPath(this._getGlobalDataUri(), DATA_FILE_LAST_ACTIVE_WORKSPACE);
			const content = await this.fileService.readFile(uri);
			const data = JSON.parse(content.value.toString());
			return data.lastActiveWorkspaceId || null;
		} catch {
			// File doesn't exist or is corrupted — return null
			return null;
		}
	}

	/**
	 * Set the ID of the last active workspace.
	 * Pass null to clear the last active workspace.
	 */
	async setLastActiveWorkspaceId(id: string | null): Promise<void> {
		const uri = URI.joinPath(this._getGlobalDataUri(), DATA_FILE_LAST_ACTIVE_WORKSPACE);
		await this._ensureDir(this._getGlobalDataUri());
		const content = VSBuffer.fromString(JSON.stringify({ lastActiveWorkspaceId: id }, null, 2));
		await this.fileService.writeFile(uri, content);
		this.logService.info(`[AgentStudio] Last active workspace set to: ${id}`);
	}

	// ─── Related Folders (multi-repo management) ────────────────────────────

	async addRelatedFolder(workspaceId: string, folderPath: string): Promise<Workspace> {
		const ws = await this.getWorkspace(workspaceId);
		if (!ws) {
			throw new Error(`Workspace not found: ${workspaceId}`);
		}
		const norm = folderPath.replace(/[\\/]+$/, '');
		if ((ws.relatedFolders ?? []).some(f => f.path.replace(/[\\/]+$/, '') === norm)) {
			return ws; // already associated — dedupe
		}
		const name = norm.split(/[\\/]/).pop() || norm;
		// Detect whether the folder is a git repository (has a .git entry).
		// Drives the "关联仓库 · Git" badge in the ActivityBar and tells the
		// SourceControl sync which related folders carry git info.
		const isGitRepo = await this._detectGitRepo(folderPath);
		const updated = await this.updateWorkspace(workspaceId, {
			relatedFolders: [
				...(ws.relatedFolders ?? []),
				{ path: folderPath, name, addedAt: new Date().toISOString(), isGitRepo },
			],
		});
		this.logService.info(`[AgentStudio] addRelatedFolder(${workspaceId}): ${folderPath} (git=${isGitRepo})`);
		// If this is the active workspace, re-fire so sandbox + SCM re-sync.
		if (this._activeWorkspaceId === workspaceId) {
			this._onDidChangeActiveWorkspace.fire(workspaceId);
		}
		return updated;
	}

	async removeRelatedFolder(workspaceId: string, folderPath: string): Promise<Workspace> {
		const ws = await this.getWorkspace(workspaceId);
		if (!ws) {
			throw new Error(`Workspace not found: ${workspaceId}`);
		}
		const norm = folderPath.replace(/[\\/]+$/, '');
		const next = (ws.relatedFolders ?? []).filter(f => f.path.replace(/[\\/]+$/, '') !== norm);
		const updated = await this.updateWorkspace(workspaceId, { relatedFolders: next });
		this.logService.info(`[AgentStudio] removeRelatedFolder(${workspaceId}): ${folderPath}`);
		if (this._activeWorkspaceId === workspaceId) {
			this._onDidChangeActiveWorkspace.fire(workspaceId);
		}
		return updated;
	}

	/**
	 * Detect whether a folder is a git repository by probing for a `.git`
	 * entry (directory in normal clones, file in worktrees/submodules).
	 * Returns false on any IO error rather than throwing — git detection is
	 * best-effort metadata, not a hard precondition for associating a folder.
	 */
	private async _detectGitRepo(folderPath: string): Promise<boolean> {
		try {
			const gitUri = URI.file(folderPath.replace(/[\\/]+$/, '') + '/.git');
			return await this.fileService.exists(gitUri);
		} catch (err) {
			this.logService.warn(`[AgentStudio] _detectGitRepo failed for ${folderPath}`, err);
			return false;
		}
	}

	getActiveWorkspaceId(): string | undefined {
		return this._activeWorkspaceId;
	}

	/**
	 * Resolve the workspace the webview should default to on startup.
	 *
	 * Resolution order (each step falls through on miss):
	 *   1. In-memory active id (already set within this session).
	 *   2. Reverse-lookup by the currently opened IDE folder path → matches
	 *      the workspace whose `path` field equals it. This is the single
	 *      most important rule: when the user opens project X, agent-studio
	 *      should always land on the workspace bound to X.
	 *   3. Persisted `last-active-workspace.json` — but only if the entry
	 *      still exists AND has a non-empty `path` (to avoid resurrecting
	 *      a stale/orphaned workspace record).
	 *   4. First workspace in the list that has a `path` field. We
	 *      explicitly skip path-less legacy entries (e.g. workspaces created
	 *      before the `path` field existed) because falling back to one of
	 *      those is the long-standing footgun: new agents would silently be
	 *      written to a workspace that has no project root, and chat sessions
	 *      then fail with "Agent has no workspace directory".
	 *   5. As a last resort, the first workspace overall (preserves legacy
	 *      behaviour for users who never bound any path).
	 *
	 * Returns `null` when there are no workspaces at all.
	 */
	async resolveDefaultActiveWorkspaceId(): Promise<string | null> {
		// (1) In-memory wins.
		if (this._activeWorkspaceId) {
			return this._activeWorkspaceId;
		}

		let workspaces: Workspace[] = [];
		try {
			workspaces = await this._readJsonFile<Workspace>(this._getGlobalDataUri(), DATA_FILE_WORKSPACES);
		} catch (err) {
			this.logService.warn(`[AgentStudio] resolveDefaultActiveWorkspaceId: workspaces.json read failed: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
		if (workspaces.length === 0) {
			return null;
		}

		// (2) Match by currently opened IDE folder.
		const inferred = await this._inferWorkspaceIdFromActiveFolder();
		if (inferred && workspaces.some(w => w.id === inferred)) {
			this.logService.info(`[AgentStudio] resolveDefaultActiveWorkspaceId: matched current folder → ${inferred}`);
			return inferred;
		}

		// (3) Persisted lastActive — but only if it has a path.
		try {
			const lastId = await this.getLastActiveWorkspaceId();
			if (lastId) {
				const last = workspaces.find(w => w.id === lastId);
				if (last && last.path) {
					this.logService.info(`[AgentStudio] resolveDefaultActiveWorkspaceId: using persisted lastActive → ${lastId}`);
					return lastId;
				}
			}
		} catch { /* fall through */ }

		// (4) First workspace that has a path (skip legacy path-less entries).
		const firstWithPath = workspaces.find(w => !!w.path);
		if (firstWithPath) {
			this.logService.info(`[AgentStudio] resolveDefaultActiveWorkspaceId: first-with-path fallback → ${firstWithPath.id}`);
			return firstWithPath.id;
		}

		// (5) No path-bound workspace exists — preserve legacy behaviour.
		this.logService.warn(`[AgentStudio] resolveDefaultActiveWorkspaceId: no path-bound workspace exists; falling back to workspaces[0]=${workspaces[0].id}`);
		return workspaces[0].id;
	}

	async setActiveWorkspace(workspaceId: string | undefined): Promise<void> {
		if (this._activeWorkspaceId === workspaceId) {
			return;
		}
		this._activeWorkspaceId = workspaceId;
		// Persist as lastActive for next session restore.
		try {
			await this.setLastActiveWorkspaceId(workspaceId ?? null);
		} catch (err) {
			this.logService.warn('[AgentStudio] setActiveWorkspace: persist lastActive failed', err);
		}
		this.logService.info(`[AgentStudio] Active workspace changed to: ${workspaceId}`);
		// (1) Fire the internal Emitter — drives native consumers:
		//     sandbox roots, SCM folder sync, ActivityBar tree filtering.
		this._onDidChangeActiveWorkspace.fire(workspaceId);
		// (2) Dispatch the DOM event — drives the WebView canvas + any
		//     DOM-event-based listeners (agentStudioWebviewController forwards
		//     this as `workspace.activeChanged`; presetAgentView re-renders).
		//     This makes setActiveWorkspace the single source of truth: no
		//     matter who triggers the switch (ActivityBar selector, create-then-
		//     activate, lastActive restore, or the global toolbar), native and
		//     WebView views switch from the same origin.
		this._dispatchActiveWorkspaceDomEvent(workspaceId);
	}

	/**
	 * Dispatch the global `agent-studio:active-workspace-changed` DOM event so
	 * that WebView-hosted canvases (and other DOM-event listeners) switch in
	 * lockstep with the native side. Guarded for non-DOM environments.
	 */
	private _dispatchActiveWorkspaceDomEvent(workspaceId: string | undefined): void {
		if (!workspaceId) {
			return;
		}
		try {
			if (typeof document !== 'undefined' && typeof CustomEvent !== 'undefined') {
				document.dispatchEvent(new CustomEvent('agent-studio:active-workspace-changed', {
					detail: { workspaceId }
				}));
			}
		} catch (err) {
			this.logService.warn('[AgentStudio] setActiveWorkspace: dispatch DOM event failed', err);
		}
	}

	// ─── Connections ────────────────────────────────────────────

	async getConnections(workspaceId: string): Promise<Connection[]> {
		const workspace = await this.getWorkspace(workspaceId);
		return workspace?.connections || [];
	}

	async addConnection(workspaceId: string, connection: Omit<Connection, 'id'>): Promise<Connection> {
		const workspaces = await this._readJsonFile<Workspace>(this._getGlobalDataUri(), DATA_FILE_WORKSPACES);
		const index = workspaces.findIndex(w => w.id === workspaceId);
		if (index === -1) {
			throw new Error(`Workspace not found: ${workspaceId}`);
		}
		const newConnection: Connection = {
			id: this._generateId(connection.label || connection.type || 'connection'),
			...connection,
		};
		workspaces[index].connections.push(newConnection);

		// Also update layout.edges to keep data consistent
		if (workspaces[index].layout) {
			workspaces[index].layout!.edges.push({
				id: newConnection.id,
				source: newConnection.sourceId,
				target: newConnection.targetId,
				type: newConnection.type,
				data: { label: newConnection.label },
			});
		}

		workspaces[index].updatedAt = new Date().toISOString();
		await this._writeJsonFile(this._getGlobalDataUri(), DATA_FILE_WORKSPACES, workspaces);

		// Save connections to workspace-local dir
		if (workspaces[index].path) {
			try {
				const wsDataUri = URI.joinPath(URI.file(workspaces[index].path!), WORKSPACE_DATA_DIR);
				await this._writeJsonFile(wsDataUri, 'connections.json', workspaces[index].connections);
			} catch (err) {
				this.logService.debug('[AgentStudio] Could not save connections to workspace dir', err);
			}
		}

		this._onDidChangeWorkspace.fire(workspaceId);
		return newConnection;
	}

	async removeConnection(workspaceId: string, connectionId: string): Promise<void> {
		const workspaces = await this._readJsonFile<Workspace>(this._getGlobalDataUri(), DATA_FILE_WORKSPACES);
		const index = workspaces.findIndex(w => w.id === workspaceId);
		if (index === -1) {
			throw new Error(`Workspace not found: ${workspaceId}`);
		}
		workspaces[index].connections = workspaces[index].connections.filter((c: Connection) => c.id !== connectionId);

		// Also remove from layout.edges to keep data consistent
		if (workspaces[index].layout) {
			workspaces[index].layout = {
				...workspaces[index].layout,
				edges: workspaces[index].layout.edges.filter(e => e.id !== connectionId),
			};
		}

		workspaces[index].updatedAt = new Date().toISOString();
		await this._writeJsonFile(this._getGlobalDataUri(), DATA_FILE_WORKSPACES, workspaces);

		// Update workspace-local connections
		if (workspaces[index].path) {
			try {
				const wsDataUri = URI.joinPath(URI.file(workspaces[index].path!), WORKSPACE_DATA_DIR);
				await this._writeJsonFile(wsDataUri, 'connections.json', workspaces[index].connections);
			} catch (err) {
				this.logService.debug('[AgentStudio] Could not update connections in workspace dir', err);
			}
		}

		this._onDidChangeWorkspace.fire(workspaceId);
	}

	// ─── Sessions ───────────────────────────────────────────────────────────────

	async getSessions(): Promise<AgentStudioSession[]> {
		return this._readJsonFile<AgentStudioSession>(this._getGlobalDataUri(), DATA_FILE_SESSIONS);
	}

	async getSession(id: string): Promise<AgentStudioSession | undefined> {
		const sessions = await this._readJsonFile<AgentStudioSession>(this._getGlobalDataUri(), DATA_FILE_SESSIONS);
		return sessions.find(s => s.id === id);
	}

	async createSession(data: Partial<AgentStudioSession>): Promise<AgentStudioSession> {
		const sessions = await this._readJsonFile<AgentStudioSession>(this._getGlobalDataUri(), DATA_FILE_SESSIONS);
		const now = new Date().toISOString();
		const newSession: AgentStudioSession = {
			id: this._generateId(data.name || 'New Session'),
			name: data.name || 'New Session',
			workspaceId: data.workspaceId || '',
			activeAgentId: data.activeAgentId,
			createdAt: now,
			updatedAt: now,
		};
		sessions.push(newSession);
		await this._writeJsonFile(this._getGlobalDataUri(), DATA_FILE_SESSIONS, sessions);

		// Also save session to workspace-local dir if workspace has a path
		if (newSession.workspaceId) {
			try {
				const wsDataUri = await this._getWorkspaceDataUri(newSession.workspaceId);
				const localSessions = await this._readJsonFile<AgentStudioSession>(wsDataUri, DATA_FILE_SESSIONS);
				localSessions.push(newSession);
				await this._writeJsonFile(wsDataUri, DATA_FILE_SESSIONS, localSessions);
			} catch (err) {
				this.logService.debug('[AgentStudio] Could not save session to workspace dir', err);
			}
		}

		this._onDidChangeSessions.fire();
		return newSession;
	}

	async deleteSession(id: string): Promise<void> {
		const sessions = await this._readJsonFile<AgentStudioSession>(this._getGlobalDataUri(), DATA_FILE_SESSIONS);
		const target = sessions.find(s => s.id === id);
		const filtered = sessions.filter(s => s.id !== id);
		await this._writeJsonFile(this._getGlobalDataUri(), DATA_FILE_SESSIONS, filtered);

		// Also delete from workspace-local dir
		if (target?.workspaceId) {
			try {
				const wsDataUri = await this._getWorkspaceDataUri(target.workspaceId);
				const localSessions = await this._readJsonFile<AgentStudioSession>(wsDataUri, DATA_FILE_SESSIONS);
				const localFiltered = localSessions.filter(s => s.id !== id);
				await this._writeJsonFile(wsDataUri, DATA_FILE_SESSIONS, localFiltered);
			} catch (err) {
				this.logService.debug('[AgentStudio] Could not delete session from workspace dir', err);
			}
		}

		this._onDidChangeSessions.fire();
	}

	// ─── Agent Instance Import / Export (RETIRED) ──────────────────────────
	// Portable agent export/import has been retired. The bundle type
	// AgentExportData is preserved for now in case a future Agent-native
	// export path is added.


	// ─── Worktree Integration (opencode-compatible) ─────────────────────────────

	async createWorkspaceWithWorktree(
		name: string,
		options?: IWorktreeWorkspaceOptions,
	): Promise<Workspace> {
		const mode = options?.mode ?? 'main';

		if (mode === 'main') {
			// Create workspace without worktree isolation
			return this.createWorkspace({ name });
		}

		if (mode === 'existing' && options?.existingPath) {
			// Create workspace bound to an existing worktree
			const worktrees = await this.worktreeService.listWorktrees(
				(await this.worktreeService.getRepositoryRoot())!
			);
			const existing = worktrees.find(w => w.path === options.existingPath);
			const workspace = await this.createWorkspace({
				name,
				worktreePath: options.existingPath,
				worktreeBranch: existing?.branch,
				worktreeStatus: 'ready',
			});
			return workspace;
		}

		// mode === 'create' — two-phase creation
		const worktreeInfo = await this.worktreeService.makeWorktreeInfo({
			name: options?.name ?? name,
			detached: options?.detached,
		});

		// Create workspace with worktree info (pending state)
		const workspace = await this.createWorkspace({
			name,
			worktreePath: worktreeInfo.directory,
			worktreeBranch: worktreeInfo.branch,
			worktreeStatus: 'pending',
		});

		// Phase 2: Create the worktree (async boot)
		try {
			await this.worktreeService.createFromInfo(worktreeInfo);

			// Wait for ready (with timeout)
			const status = await this.worktreeService.waitForWorktreeReady(worktreeInfo.directory, 30000);
			await this.updateWorkspace(workspace.id, {
				worktreeStatus: status === WorktreeStatus.Ready ? 'ready' : 'failed',
			});
		} catch (e) {
			await this.updateWorkspace(workspace.id, {
				worktreeStatus: 'failed',
			});
			this.logService.error('[AgentStudioService] createWorkspaceWithWorktree failed:', e);
		}

		// Return the updated workspace
		const updated = await this.getWorkspace(workspace.id);
		return updated ?? workspace;
	}

	async assignWorktreeToWorkspace(
		workspaceId: string,
		worktreePath: string,
		worktreeBranch?: string,
	): Promise<void> {
		await this.updateWorkspace(workspaceId, {
			worktreePath,
			worktreeBranch,
			worktreeStatus: this.worktreeService.getWorktreeState(worktreePath) === WorktreeStatus.Ready ? 'ready' : 'pending',
		});
	}

	async resetWorkspaceWorktree(workspaceId: string): Promise<void> {
		const workspace = await this.getWorkspace(workspaceId);
		if (!workspace?.worktreePath) {
			throw new Error(`Workspace ${workspaceId} has no worktree assigned`);
		}

		await this.worktreeService.resetWorktree(workspace.worktreePath);
	}

	async removeWorkspaceWorktree(workspaceId: string): Promise<void> {
		const workspace = await this.getWorkspace(workspaceId);
		if (!workspace?.worktreePath) {
			return; // Nothing to remove
		}

		await this.worktreeService.removeWorktree(workspace.worktreePath, true);

		// Clear the worktree binding
		await this.updateWorkspace(workspaceId, {
			worktreePath: undefined,
			worktreeBranch: undefined,
			worktreeStatus: 'none',
		});
	}
}
