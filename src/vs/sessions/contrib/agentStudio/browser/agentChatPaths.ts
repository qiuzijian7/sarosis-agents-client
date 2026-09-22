/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import {
	AGENT_STUDIO_DATA_PATH_SETTING,
	DATA_FILE_CHAT_HISTORY,
	WORKSPACE_DATA_DIR,
	AGENTS_DIR,
} from '../common/constants.js';
import { SESSION_LOG_SUFFIX } from '../common/sessionHistoryLog.js';

/** `resolveAgentPaths` 的返回（会话目录 + 索引文件 ✓）。 */
export interface IAgentPaths {
	readonly sessionsDirUri: URI;
	readonly indexUri: URI;
}

/**
 * agent 会话的**路径学 + 旧数据迁移** —— 从 `agentChatService.ts` 拆出的独立簇 ✓（2026-09-22 阶段②）。
 *
 * 存储布局（用户全局 ⇒ 跨工作区可访问 ✓）：
 * ```
 * ~/.vssaros/chat-history/{agentId}/sessions.json          ← 会话索引
 * ~/.vssaros/chat-history/{agentId}/sessions/{id}.json     ← 快照
 * ~/.vssaros/chat-history/{agentId}/sessions/{id}.jsonl    ← 追加日志（P0-1 ✓）
 * ~/.vssaros/chat-history/{agentId}/sessions/{id}.sidecar/ ← 工具结果外置（P1 ✓）
 * ```
 * 旧的工作区局部布局（`{workspace}/.sarosworkspace/agents/{agentId}/…`）在**首次访问时**按 agent
 * 迁移一次 ✓（`_migratedAgents` 标记 ⇒ 每个 agent 只尝试一次 ✓；失败也只记日志、不阻断 ✓）。
 *
 * ⚠ `_globalDataUri` 是**带缓存**的（配置读取 + URI 构造都不便宜 ✓）⇒ 本类保持单例语义，
 * 由服务持有唯一实例 ✓。
 */
export class AgentChatPaths {
	private _globalDataUri: URI | undefined;
	/** Per-agent migration marker: prevents repeated migration attempts for the same agent. */
	private readonly _migratedAgents = new Set<string>();

	constructor(
		private readonly fileService: IFileService,
		private readonly environmentService: IEnvironmentService,
		private readonly configurationService: IConfigurationService,
		/** 迁移需要"当前工作区"（旧数据的来源 ✓）；取不到就跳过迁移 ✓。 */
		private readonly studioService: IAgentStudioService,
		private readonly logService: ILogService,
	) { }

	/**
	 * Resolve the global chat history root directory.
	 * All chat sessions are stored under ~/.vssaros/chat-history/ (user-global),
	 * making history accessible across workspaces.
	 */
	getChatHistoryRoot(): URI {
		// userRoamingDataHome = ~/.vssaros/User/
		// Going up one level gives ~/.vssaros/
		return URI.joinPath(
			this.environmentService.userRoamingDataHome,
			'..',
			'chat-history',
		);
	}

	getGlobalDataUri(): URI {
		if (!this._globalDataUri) {
			const customPath = this.configurationService.getValue<string>(
				AGENT_STUDIO_DATA_PATH_SETTING,
			);
			this._globalDataUri = customPath
				? URI.file(customPath)
				: URI.joinPath(
					this.environmentService.userRoamingDataHome,
					'agent-studio',
				);
		}
		return this._globalDataUri;
	}

	getHistoryFileUri(): URI {
		return URI.joinPath(this.getGlobalDataUri(), DATA_FILE_CHAT_HISTORY);
	}

	/**
	 * Resolve the sessions directory and index file URI for an agent.
	 *
	 * Storage is now user-global under ~/.vssaros/chat-history/{agentId}/.
	 * Legacy workspace-local data (workspace/.sarosworkspace/agents/{agentId}/sessions/)
	 * is migrated on first access.
	 */
	async resolveAgentPaths(agentId: string): Promise<IAgentPaths> {
		const agentUri = URI.joinPath(this.getChatHistoryRoot(), agentId);

		// Migrate legacy data from workspace-local to global on first access (per-agent)
		if (!this._migratedAgents.has(agentId)) {
			await this._migrateLegacySessions(agentId, agentUri);
		}

		return {
			sessionsDirUri: URI.joinPath(agentUri, 'sessions'),
			indexUri: URI.joinPath(agentUri, 'sessions.json'),
		};
	}

	/**
	 * Migrate legacy workspace-local session data to the new global location.
	 * Source: {workspace}/.sarosworkspace/agents/{agentId}/sessions.json
	 *         {workspace}/.sarosworkspace/agents/{agentId}/sessions/{id}.json
	 * Target: ~/.vssaros/chat-history/{agentId}/sessions.json
	 *         ~/.vssaros/chat-history/{agentId}/sessions/{id}.json
	 * Only runs once per service lifetime (fire-and-forget, errors are logged).
	 */
	private async _migrateLegacySessions(agentId: string, targetAgentUri: URI): Promise<void> {
		try {
			const activeWorkspaceId = this.studioService.getActiveWorkspaceId();
			if (!activeWorkspaceId) {
				this._migratedAgents.add(agentId);
				return;
			}

			const workspace = await this.studioService.getWorkspace(activeWorkspaceId);
			const workspacePath = workspace?.path;
			if (!workspacePath) {
				this._migratedAgents.add(agentId);
				return;
			}

			const legacyAgentUri = URI.joinPath(
				URI.file(workspacePath),
				WORKSPACE_DATA_DIR,
				AGENTS_DIR,
				agentId,
			);
			const legacyIndexUri = URI.joinPath(legacyAgentUri, 'sessions.json');
			const targetIndexUri = URI.joinPath(targetAgentUri, 'sessions.json');

			// Skip if target already exists or legacy doesn't exist
			if (await this.fileService.exists(targetIndexUri)) {
				this.logService.info(`[AgentChatPaths] Migration: target already exists for ${agentId}, skipping`);
				this._migratedAgents.add(agentId);
				return;
			}
			if (!(await this.fileService.exists(legacyIndexUri))) {
				// No legacy data for this agent
				this._migratedAgents.add(agentId);
				return;
			}

			this.logService.info(`[AgentChatPaths] Migrating chat sessions for agent ${agentId} from ${legacyAgentUri.fsPath} to ${targetAgentUri.fsPath}`);

			// Ensure target directory exists
			const targetSessionsDir = URI.joinPath(targetAgentUri, 'sessions');
			if (!(await this.fileService.exists(targetAgentUri))) {
				await this.fileService.createFolder(targetAgentUri);
			}

			// Copy sessions.json index
			const legacyIdxContent = await this.fileService.readFile(legacyIndexUri);
			await this.fileService.writeFile(targetIndexUri, legacyIdxContent.value);

			// Copy individual session files
			const legacySessionsDir = URI.joinPath(legacyAgentUri, 'sessions');
			if (await this.fileService.exists(legacySessionsDir)) {
				if (!(await this.fileService.exists(targetSessionsDir))) {
					await this.fileService.createFolder(targetSessionsDir);
				}
				const children = await this.fileService.resolve(legacySessionsDir);
				if (children.children) {
					for (const child of children.children) {
						if (!child.isDirectory && child.name.endsWith('.json')) {
							const targetFile = URI.joinPath(targetSessionsDir, child.name);
							if (!(await this.fileService.exists(targetFile))) {
								const content = await this.fileService.readFile(child.resource);
								await this.fileService.writeFile(targetFile, content.value);
							}
						}
					}
				}
			}

			this.logService.info(`[AgentChatPaths] Migration complete for agent ${agentId}`);
		} catch (err) {
			this.logService.warn(`[AgentChatPaths] Migration failed for agent ${agentId}:`, err);
		} finally {
			this._migratedAgents.add(agentId);
		}
	}

	sessionFileUri(sessionsDirUri: URI, sessionId: string): URI {
		return URI.joinPath(sessionsDirUri, `${sessionId}.json`);
	}

	/** ★ P0-1：会话**追加日志**（`sessions/{sessionId}.jsonl`）—— 与快照同目录、同名不同扩展 ✓。 */
	sessionLogUri(sessionsDirUri: URI, sessionId: string): URI {
		return URI.joinPath(sessionsDirUri, `${sessionId}${SESSION_LOG_SUFFIX}`);
	}

	cacheKey(agentId: string, sessionId?: string): string {
		return sessionId ? `${agentId}::${sessionId}` : agentId;
	}
}
