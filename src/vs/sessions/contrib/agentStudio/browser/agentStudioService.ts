/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import type { Employee, Workspace, Connection, AgentStudioSession, WorkspaceLayout } from '../common/types.js';
import { EmployeeStatus } from '../common/types.js';
import { DATA_FILE_EMPLOYEES, DATA_FILE_WORKSPACES, DATA_FILE_SESSIONS, AGENT_STUDIO_DATA_PATH_SETTING, WORKSPACE_DATA_DIR } from '../common/constants.js';

export class AgentStudioService extends Disposable implements IAgentStudioService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeEmployees = this._register(new Emitter<void>());
	readonly onDidChangeEmployees: Event<void> = this._onDidChangeEmployees.event;

	private readonly _onDidChangeWorkspace = this._register(new Emitter<string>());
	readonly onDidChangeWorkspace: Event<string> = this._onDidChangeWorkspace.event;

	private readonly _onDidChangeSessions = this._register(new Emitter<void>());
	readonly onDidChangeSessions: Event<void> = this._onDidChangeSessions.event;

	private readonly _onDidSelectEmployee = this._register(new Emitter<string | null>());
	readonly onDidSelectEmployee: Event<string | null> = this._onDidSelectEmployee.event;

	/** Fire the employee-selected event (called by webview controller) */
	fireSelectEmployee(employeeId: string | null): void {
		this.logService.info(`[AgentStudioService] fireSelectEmployee(employeeId=${employeeId})`);
		this._onDidSelectEmployee.fire(employeeId);
	}

	private _globalDataUri: URI | undefined;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
	) {
		super();
	}

	// ─── Data directory helpers ─────────────────────────────────────────────────

	/**
	 * Global data directory (userRoamingDataHome/agent-studio).
	 * Stores the global workspace index (workspaces.json) and fallback data
	 * for workspaces that don't have a local path.
	 */
	private _getGlobalDataUri(): URI {
		if (!this._globalDataUri) {
			const customPath = this.configurationService.getValue<string>(AGENT_STUDIO_DATA_PATH_SETTING);
			if (customPath) {
				this._globalDataUri = URI.file(customPath);
			} else {
				this._globalDataUri = URI.joinPath(this.environmentService.userRoamingDataHome, 'agent-studio');
			}
			this.logService.debug(`[AgentStudio] Global data directory: ${this._globalDataUri.toString()}`);
		}
		return this._globalDataUri;
	}

	/**
	 * Resolve the workspace-local data directory URI.
	 * If the workspace has a path, returns `{path}/.sarosisworkspace/`.
	 * Otherwise falls back to `globalDataUri/{workspaceId}/`.
	 */
	private async _getWorkspaceDataUri(workspaceId: string): Promise<URI> {
		const workspaces = await this._readJsonFile<Workspace>(this._getGlobalDataUri(), DATA_FILE_WORKSPACES);
		const ws = workspaces.find(w => w.id === workspaceId);
		if (ws?.path) {
			return URI.joinPath(URI.file(ws.path), WORKSPACE_DATA_DIR);
		}
		// Fallback: store in global directory under workspace ID
		return URI.joinPath(this._getGlobalDataUri(), workspaceId);
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

	private async _readJsonFile<T>(dirUri: URI, filename: string): Promise<T[]> {
		try {
			const uri = URI.joinPath(dirUri, filename);
			const content = await this.fileService.readFile(uri);
			return JSON.parse(content.value.toString()) as T[];
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

	private _generateId(): string {
		return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
	}

	// ─── Employees ──────────────────────────────────────────────────────────────

	async getEmployees(workspaceId?: string): Promise<Employee[]> {
		if (!workspaceId) {
			// No workspace filter — read from global fallback (legacy)
			return this._readJsonFile<Employee>(this._getGlobalDataUri(), DATA_FILE_EMPLOYEES);
		}
		const dirUri = await this._getWorkspaceDataUri(workspaceId);
		return this._readJsonFile<Employee>(dirUri, DATA_FILE_EMPLOYEES);
	}

	async getEmployee(id: string): Promise<Employee | undefined> {
		// Search across all workspaces
		const workspaces = await this.getWorkspaces();
		for (const ws of workspaces) {
			const dirUri = await this._getWorkspaceDataUri(ws.id);
			const employees = await this._readJsonFile<Employee>(dirUri, DATA_FILE_EMPLOYEES);
			const found = employees.find(e => e.id === id);
			if (found) { return found; }
		}
		// Fallback: search global
		const globalEmployees = await this._readJsonFile<Employee>(this._getGlobalDataUri(), DATA_FILE_EMPLOYEES);
		return globalEmployees.find(e => e.id === id);
	}

	async createEmployee(data: Partial<Employee>): Promise<Employee> {
		const workspaceId = data.workspaceId;
		const dirUri = workspaceId
			? await this._getWorkspaceDataUri(workspaceId)
			: this._getGlobalDataUri();
		const filename = DATA_FILE_EMPLOYEES;

		const employees = await this._readJsonFile<Employee>(dirUri, filename);
		const now = new Date().toISOString();
		const newEmployee: Employee = {
			id: this._generateId(),
			name: data.name || 'New Employee',
			role: data.role || 'engineer',
			email: data.email,
			avatar: data.avatar,
			presetId: data.presetId,
			model: data.model,
			customPrompt: data.customPrompt,
			skills: data.skills || [],
			status: EmployeeStatus.Idle,
			teamId: data.teamId,
			workspaceId: data.workspaceId,
			position: data.position || { x: 100, y: 100 },
			tokenUsage: 0,
			createdAt: now,
			updatedAt: now,
		};
		employees.push(newEmployee);
		await this._writeJsonFile(dirUri, filename, employees);
		this._onDidChangeEmployees.fire();
		return newEmployee;
	}

	async updateEmployee(id: string, data: Partial<Employee>): Promise<Employee> {
		const workspaceId = data.workspaceId;
		const dirUri = workspaceId
			? await this._getWorkspaceDataUri(workspaceId)
			: this._getGlobalDataUri();
		const filename = DATA_FILE_EMPLOYEES;

		const employees = await this._readJsonFile<Employee>(dirUri, filename);
		const index = employees.findIndex(e => e.id === id);
		if (index === -1) {
			throw new Error(`Employee not found: ${id}`);
		}
		employees[index] = {
			...employees[index],
			...data,
			id, // ensure ID can't be changed
			updatedAt: new Date().toISOString(),
		};
		await this._writeJsonFile(dirUri, filename, employees);
		this._onDidChangeEmployees.fire();
		return employees[index];
	}

	async deleteEmployee(id: string): Promise<void> {
		// Search across all workspaces to find where the employee lives
		const workspaces = await this.getWorkspaces();
		for (const ws of workspaces) {
			const dirUri = await this._getWorkspaceDataUri(ws.id);
			const employees = await this._readJsonFile<Employee>(dirUri, DATA_FILE_EMPLOYEES);
			const index = employees.findIndex(e => e.id === id);
			if (index !== -1) {
				employees.splice(index, 1);
				await this._writeJsonFile(dirUri, DATA_FILE_EMPLOYEES, employees);
				this._onDidChangeEmployees.fire();
				return;
			}
		}
		// Fallback: try global
		const globalEmployees = await this._readJsonFile<Employee>(this._getGlobalDataUri(), DATA_FILE_EMPLOYEES);
		const filtered = globalEmployees.filter(e => e.id !== id);
		if (filtered.length < globalEmployees.length) {
			await this._writeJsonFile(this._getGlobalDataUri(), DATA_FILE_EMPLOYEES, filtered);
			this._onDidChangeEmployees.fire();
			return;
		}
		throw new Error(`Employee not found: ${id}`);
	}

	// ─── Workspaces ─────────────────────────────────────────────────────────────

	async getWorkspaces(): Promise<Workspace[]> {
		return this._readJsonFile<Workspace>(this._getGlobalDataUri(), DATA_FILE_WORKSPACES);
	}

	async getWorkspace(id: string): Promise<Workspace | undefined> {
		const workspaces = await this._readJsonFile<Workspace>(this._getGlobalDataUri(), DATA_FILE_WORKSPACES);
		return workspaces.find(w => w.id === id);
	}

	async createWorkspace(data: Partial<Workspace>): Promise<Workspace> {
		const workspaces = await this._readJsonFile<Workspace>(this._getGlobalDataUri(), DATA_FILE_WORKSPACES);
		const now = new Date().toISOString();
		const newWorkspace: Workspace = {
			id: this._generateId(),
			name: data.name || 'New Workspace',
			description: data.description,
			path: data.path,
			employees: data.employees || [],
			connections: data.connections || [],
			layout: data.layout,
			createdAt: now,
			updatedAt: now,
		};
		workspaces.push(newWorkspace);

		// Save the global workspace index
		await this._writeJsonFile(this._getGlobalDataUri(), DATA_FILE_WORKSPACES, workspaces);

		// Create .sarosisworkspace directory in the workspace folder (if path is set)
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
		return newWorkspace;
	}

	async updateWorkspace(id: string, data: Partial<Workspace>): Promise<Workspace> {
		const workspaces = await this._readJsonFile<Workspace>(this._getGlobalDataUri(), DATA_FILE_WORKSPACES);
		const index = workspaces.findIndex(w => w.id === id);
		if (index === -1) {
			throw new Error(`Workspace not found: ${id}`);
		}
		workspaces[index] = {
			...workspaces[index],
			...data,
			id,
			updatedAt: new Date().toISOString(),
		};
		await this._writeJsonFile(this._getGlobalDataUri(), DATA_FILE_WORKSPACES, workspaces);

		// Update workspace manifest in .sarosisworkspace if path exists
		if (workspaces[index].path) {
			try {
				const wsDataUri = URI.joinPath(URI.file(workspaces[index].path!), WORKSPACE_DATA_DIR);
				await this._writeJsonFile(wsDataUri, 'workspace.json', [workspaces[index]]);
			} catch (err) {
				this.logService.debug('[AgentStudio] Could not update workspace manifest in workspace dir', err);
			}
		}

		this._onDidChangeWorkspace.fire(id);
		return workspaces[index];
	}

	async deleteWorkspace(id: string): Promise<void> {
		const workspaces = await this._readJsonFile<Workspace>(this._getGlobalDataUri(), DATA_FILE_WORKSPACES);
		const target = workspaces.find(w => w.id === id);
		const filtered = workspaces.filter(w => w.id !== id);
		await this._writeJsonFile(this._getGlobalDataUri(), DATA_FILE_WORKSPACES, filtered);

		// Optionally clean up workspace-local data directory
		// (We don't delete .sarosisworkspace to preserve user data on disk)
		if (target?.path) {
			this.logService.info(`[AgentStudio] Workspace deleted from index. ${WORKSPACE_DATA_DIR} directory preserved at: ${target.path}`);
		}

		this._onDidChangeWorkspace.fire(id);
	}

	async updateWorkspaceLayout(id: string, layout: WorkspaceLayout): Promise<void> {
		const workspaces = await this._readJsonFile<Workspace>(this._getGlobalDataUri(), DATA_FILE_WORKSPACES);
		const index = workspaces.findIndex(w => w.id === id);
		if (index === -1) {
			throw new Error(`Workspace not found: ${id}`);
		}
		workspaces[index].layout = layout;
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

	// ─── Connections ────────────────────────────────────────────────────────────

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
			id: this._generateId(),
			...connection,
		};
		workspaces[index].connections.push(newConnection);
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
		workspaces[index].connections = workspaces[index].connections.filter(c => c.id !== connectionId);
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
			id: this._generateId(),
			name: data.name || 'New Session',
			workspaceId: data.workspaceId || '',
			activeEmployeeId: data.activeEmployeeId,
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
}
