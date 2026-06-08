/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import { WORKSPACE_SESSIONS_DIR } from '../common/constants.js';
import type {
	WorkspaceSession,
	WorkspaceSessionStatus,
	WorkspaceSessionSource,
	AgentSessionEntry,
	WorkspaceRootInfo,
} from '../../../common/agentStudioTypes.js';

// ─── Service Interface ─────────────────────────────────────────────────────

export interface IWorkspaceSessionService {
	/**
	 * Fired whenever the session list for a workspace changes.
	 */
	readonly onDidChangeWorkspaceSessions: Event<string>;

	// CRUD
	getSessions(workspaceId: string): Promise<WorkspaceSession[]>;
	getSession(workspaceId: string, sessionId: string): Promise<WorkspaceSession | undefined>;
	createSession(params: {
		workspaceId: string;
		name: string;
		source: WorkspaceSessionSource;
		scheduledTaskId?: string;
		idempotencyKey?: string;
	}): Promise<WorkspaceSession>;
	deleteSession(workspaceId: string, sessionId: string): Promise<void>;
	archiveSession(workspaceId: string, sessionId: string): Promise<void>;
	updateSessionStatus(
		workspaceId: string,
		sessionId: string,
		status: WorkspaceSessionStatus,
		error?: string,
	): Promise<void>;

	// Active session
	getActiveSession(workspaceId: string): Promise<WorkspaceSession | null>;
	setActiveSession(workspaceId: string, sessionId: string | null): Promise<void>;

	// Agent session within a fork
	getAgentSessionId(workspaceId: string, sessionId: string, agentId: string): Promise<string | null>;
	getAgentSessions(workspaceId: string, sessionId: string): Promise<AgentSessionEntry[]>;
	ensureAgentSession(workspaceId: string, sessionId: string, agentId: string): Promise<AgentSessionEntry>;
	updateAgentSession(
		workspaceId: string,
		sessionId: string,
		agentId: string,
		data: Partial<AgentSessionEntry>,
	): Promise<void>;
}

// ─── Implementation ────────────────────────────────────────────────────────

export class WorkspaceSessionService extends Disposable implements IWorkspaceSessionService {

	private readonly _onDidChangeWorkspaceSessions = this._register(new Emitter<string>());
	readonly onDidChangeWorkspaceSessions: Event<string> = this._onDidChangeWorkspaceSessions.event;

	/** In-memory cache: workspaceId → sessions[] */
	private readonly _cache = new Map<string, WorkspaceSession[]>();

	/** Active session per workspace: workspaceId → sessionId | null */
	private readonly _activeMap = new Map<string, string | null>();

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IFileService private readonly _fileService: IFileService,
		@IAgentStudioService private readonly _studioService: IAgentStudioService,
	) {
		super();
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

	private async _getWorkspaceDataUri(workspaceId: string): Promise<URI | null> {
		const ws = await this._studioService.getWorkspace(workspaceId);
		if (!ws?.path) {
			this._logService.warn(`[WorkspaceSessionService] Workspace ${workspaceId} has no path`);
			return null;
		}
		return URI.joinPath(URI.file(ws.path), '.sarosisworkspace');
	}

	private _sessionsDir(wsDataUri: URI): URI {
		return URI.joinPath(wsDataUri, WORKSPACE_SESSIONS_DIR);
	}

	private _sessionDir(wsDataUri: URI, sessionId: string): URI {
		return URI.joinPath(wsDataUri, WORKSPACE_SESSIONS_DIR, sessionId);
	}

	private _metadataUri(wsDataUri: URI, sessionId: string): URI {
		return URI.joinPath(this._sessionDir(wsDataUri, sessionId), 'metadata.json');
	}

	private _sessionIndexUri(wsDataUri: URI, sessionId: string): URI {
		return URI.joinPath(this._sessionDir(wsDataUri, sessionId), 'session_index.json');
	}

	private _generateShortId(): string {
		return `${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
	}

	private async _ensureDir(uri: URI): Promise<void> {
		const exists = await this._fileService.exists(uri);
		if (!exists) {
			await this._fileService.createFolder(uri);
		}
	}

	private async _writeJson(uri: URI, data: unknown): Promise<void> {
		await this._fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(data, null, 2)));
	}

	private async _readJson<T>(uri: URI): Promise<T | undefined> {
		try {
			const exists = await this._fileService.exists(uri);
			if (!exists) { return undefined; }
			const content = await this._fileService.readFile(uri);
			return JSON.parse(content.value.toString()) as T;
		} catch {
			return undefined;
		}
	}

	// ─── Load from disk ──────────────────────────────────────────────────────

	private async _loadSessions(workspaceId: string): Promise<WorkspaceSession[]> {
		if (this._cache.has(workspaceId)) {
			return this._cache.get(workspaceId)!;
		}

		const wsDataUri = await this._getWorkspaceDataUri(workspaceId);
		if (!wsDataUri) { return []; }

		const sessDir = this._sessionsDir(wsDataUri);
		const exists = await this._fileService.exists(sessDir);
		if (!exists) {
			this._cache.set(workspaceId, []);
			return [];
		}

		const sessions: WorkspaceSession[] = [];
		try {
			const stat = await this._fileService.resolve(sessDir);
			if (stat.children) {
				for (const child of stat.children) {
					if (!child.isDirectory) { continue; }
					const sessionId = child.name;
					const metadata = await this._readJson<WorkspaceSession>(
						this._metadataUri(wsDataUri, sessionId),
					);
					if (metadata) {
						// Load agent sessions from index file
						const index = await this._readJson<{ agentSessions: AgentSessionEntry[] }>(
							this._sessionIndexUri(wsDataUri, sessionId),
						);
						metadata.agentSessions = index?.agentSessions || [];
						sessions.push(metadata);
					}
				}
			}
		} catch (err) {
			this._logService.error('[WorkspaceSessionService] Failed to load sessions:', err);
		}

		// Sort by creation time descending
		sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
		this._cache.set(workspaceId, sessions);
		return sessions;
	}

	// ─── CRUD ────────────────────────────────────────────────────────────────

	async getSessions(workspaceId: string): Promise<WorkspaceSession[]> {
		return this._loadSessions(workspaceId);
	}

	async getSession(workspaceId: string, sessionId: string): Promise<WorkspaceSession | undefined> {
		const sessions = await this._loadSessions(workspaceId);
		return sessions.find(s => s.id === sessionId);
	}

	async createSession(params: {
		workspaceId: string;
		name: string;
		source: WorkspaceSessionSource;
		scheduledTaskId?: string;
		idempotencyKey?: string;
	}): Promise<WorkspaceSession> {
		const { workspaceId, name, source, scheduledTaskId, idempotencyKey } = params;

		// Idempotency check
		if (idempotencyKey) {
			const existing = await this._loadSessions(workspaceId);
			const dup = existing.find(s => s.idempotencyKey === idempotencyKey);
			if (dup) {
				this._logService.info(`[WorkspaceSessionService] Idempotent hit: returning existing session ${dup.id}`);
				return dup;
			}
		}

		const wsDataUri = await this._getWorkspaceDataUri(workspaceId);
		if (!wsDataUri) {
			throw new Error(`Workspace ${workspaceId} has no path — cannot create session`);
		}

		// Get current agent list for snapshot.
		// Agents are global definitions; the snapshot captures all available agents.
		const agents = await this._studioService.getAgents();
		const snapshotAgentIds = agents.map(e => e.id);

		const now = new Date().toISOString();
		const sessionId = `workspace_session_${this._generateShortId()}`;

		const session: WorkspaceSession = {
			id: sessionId,
			workspaceId,
			name,
			source: source as any,
			scheduledTaskId,
			idempotencyKey,
			status: 'pending' as any,
			agentSessions: [],
			snapshotAgentIds,
			createdAt: now,
			updatedAt: now,
		};

		// Persist to disk
		await this._ensureDir(this._sessionsDir(wsDataUri));
		await this._ensureDir(this._sessionDir(wsDataUri, sessionId));
		await this._writeJson(this._metadataUri(wsDataUri, sessionId), {
			...session,
			agentSessions: undefined, // stored in index file
		});
		await this._writeJson(this._sessionIndexUri(wsDataUri, sessionId), {
			sessionId,
			agentSessions: [],
		});

		// Update cache
		const sessions = await this._loadSessions(workspaceId);
		sessions.unshift(session);

		this._logService.info(`[WorkspaceSessionService] Created session ${sessionId} for workspace ${workspaceId}`);
		this._onDidChangeWorkspaceSessions.fire(workspaceId);
		return session;
	}

	async deleteSession(workspaceId: string, sessionId: string): Promise<void> {
		const wsDataUri = await this._getWorkspaceDataUri(workspaceId);
		if (!wsDataUri) { return; }

		const dirUri = this._sessionDir(wsDataUri, sessionId);
		try {
			await this._fileService.del(dirUri, { recursive: true });
		} catch {
			// ignore
		}

		// Update cache
		const sessions = this._cache.get(workspaceId);
		if (sessions) {
			const idx = sessions.findIndex(s => s.id === sessionId);
			if (idx >= 0) { sessions.splice(idx, 1); }
		}

		// Clear active if it was the deleted one
		if (this._activeMap.get(workspaceId) === sessionId) {
			this._activeMap.set(workspaceId, null);
		}

		this._onDidChangeWorkspaceSessions.fire(workspaceId);
	}

	async archiveSession(workspaceId: string, sessionId: string): Promise<void> {
		await this.updateSessionStatus(workspaceId, sessionId, 'archived' as any);
	}

	async updateSessionStatus(
		workspaceId: string,
		sessionId: string,
		status: WorkspaceSessionStatus,
		error?: string,
	): Promise<void> {
		const sessions = await this._loadSessions(workspaceId);
		const session = sessions.find(s => s.id === sessionId);
		if (!session) { return; }

		session.status = status as any;
		session.updatedAt = new Date().toISOString();
		if (error !== undefined) { session.error = error; }
		if (status === ('completed' as any) || status === ('error' as any)) {
			session.completedAt = new Date().toISOString();
		}

		// Persist metadata
		const wsDataUri = await this._getWorkspaceDataUri(workspaceId);
		if (wsDataUri) {
			await this._writeJson(this._metadataUri(wsDataUri, sessionId), {
				...session,
				agentSessions: undefined,
			});
		}

		this._onDidChangeWorkspaceSessions.fire(workspaceId);
	}

	// ─── Active Session ──────────────────────────────────────────────────────

	async getActiveSession(workspaceId: string): Promise<WorkspaceSession | null> {
		const activeId = this._activeMap.get(workspaceId) ?? null;
		if (!activeId) { return null; }
		const session = await this.getSession(workspaceId, activeId);
		return session ?? null;
	}

	async setActiveSession(workspaceId: string, sessionId: string | null): Promise<void> {
		this._activeMap.set(workspaceId, sessionId);

		// Also persist to workspace rootInfo
		try {
			const ws = await this._studioService.getWorkspace(workspaceId);
			if (ws) {
				const rootInfo: WorkspaceRootInfo = {
					activeSessionId: sessionId,
					mode: sessionId ? 'fork' as any : 'root' as any,
				};
				await this._studioService.updateWorkspace(workspaceId, { rootInfo } as any);
			}
		} catch (err) {
			this._logService.warn('[WorkspaceSessionService] Failed to persist activeSessionId:', err);
		}
	}

	// ─── Agent Session Management ────────────────────────────────────────────

	async getAgentSessionId(workspaceId: string, sessionId: string, agentId: string): Promise<string | null> {
		const session = await this.getSession(workspaceId, sessionId);
		if (!session) { return null; }
		const entry = session.agentSessions.find(a => a.agentId === agentId);
		return entry?.sessionId ?? null;
	}

	async getAgentSessions(workspaceId: string, sessionId: string): Promise<AgentSessionEntry[]> {
		const session = await this.getSession(workspaceId, sessionId);
		return session?.agentSessions || [];
	}

	/**
	 * Lazily create an AgentSessionEntry when an Agent is first invoked in a Fork.
	 */
	async ensureAgentSession(workspaceId: string, sessionId: string, agentId: string): Promise<AgentSessionEntry> {
		const session = await this.getSession(workspaceId, sessionId);
		if (!session) { throw new Error(`Session ${sessionId} not found`); }

		let entry = session.agentSessions.find(a => a.agentId === agentId);
		if (entry) { return entry; }

		// Create new entry
		const now = new Date().toISOString();
		entry = {
			agentId,
			sessionId: `sess_${agentId.substring(0, 6)}_${this._generateShortId()}`,
			createdAt: now,
			updatedAt: now,
			messageCount: 0,
			status: 'active',
		};
		session.agentSessions.push(entry);
		session.updatedAt = now;

		// Persist index
		const wsDataUri = await this._getWorkspaceDataUri(workspaceId);
		if (wsDataUri) {
			await this._writeJson(this._sessionIndexUri(wsDataUri, sessionId), {
				sessionId,
				agentSessions: session.agentSessions,
			});
		}

		return entry;
	}

	async updateAgentSession(
		workspaceId: string,
		sessionId: string,
		agentId: string,
		data: Partial<AgentSessionEntry>,
	): Promise<void> {
		const session = await this.getSession(workspaceId, sessionId);
		if (!session) { return; }

		const entry = session.agentSessions.find(a => a.agentId === agentId);
		if (!entry) { return; }

		Object.assign(entry, data, { updatedAt: new Date().toISOString() });

		const wsDataUri = await this._getWorkspaceDataUri(workspaceId);
		if (wsDataUri) {
			await this._writeJson(this._sessionIndexUri(wsDataUri, sessionId), {
				sessionId,
				agentSessions: session.agentSessions,
			});
		}
	}
}
