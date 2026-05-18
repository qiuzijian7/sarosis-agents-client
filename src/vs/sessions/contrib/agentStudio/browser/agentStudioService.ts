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
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import type { Employee, Workspace, Connection, AgentStudioSession, WorkspaceLayout, AgentBootstrapTemplates, AgentExportData } from '../../../common/agentStudioTypes.js';
import { EmployeeStatus } from '../../../common/agentStudioTypes.js';
import { DATA_FILE_EMPLOYEES, DATA_FILE_WORKSPACES, DATA_FILE_SESSIONS, AGENT_STUDIO_DATA_PATH_SETTING, WORKSPACE_DATA_DIR, AGENTS_DIR, AGENT_CONFIG_FILE, AGENT_AGENTS_MD, AGENT_SOUL_MD, AGENT_IDENTITY_MD, AGENT_TOOLS_MD, AGENT_MEMORY_MD } from '../common/constants.js';
import { ISkillRegistry, ISkillDefinition } from '../common/skills.js';
import { IWorkspaceLifecycleService, WorkspaceLifecycleEvent, IWorkspaceLifecyclePayload } from '../common/workspaceLifecycle.js';
import { ISkillLifecycleService, SkillLifecycleEvent, ISkillLifecyclePayload, ISkillBatchLifecyclePayload } from '../common/skillLifecycle.js';

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
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
		@IWorkspaceLifecycleService private readonly workspaceLifecycleService: IWorkspaceLifecycleService,
		@ISkillLifecycleService private readonly skillLifecycleService: ISkillLifecycleService,
	) {
		super();
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

	// ─── Skill lifecycle helpers ──────────────────────────────────────────────

	/**
	 * Fire a skill-lifecycle event for a single skill change (add / remove).
	 * Requires enough context to build the payload (workspace + employee + skill).
	 * Fire-and-forget — hook failures must never break a skill mutation.
	 */
	private _fireSkillLifecycle(event: SkillLifecycleEvent.Added | SkillLifecycleEvent.Removed, employee: Employee, skillId: string, skillName?: string): void {
		const wsPath = employee.workspaceId
			? (async () => { try { const ws = await this.getWorkspace(employee.workspaceId!); return ws?.path; } catch { return undefined; } })()
			: Promise.resolve(undefined);

		void wsPath.then(workspacePath => {
			const payload: ISkillLifecyclePayload = {
				workspaceId: employee.workspaceId,
				workspacePath,
				agentId: employee.id,
				agentDir: employee.agentDir,
				skillId,
				skillName,
				timestamp: new Date().toISOString(),
			};
			void this.skillLifecycleService.fireSkillEvent(event, payload).catch(err => {
				this.logService.warn(
					`[AgentStudioService] skill lifecycle "${event}" hook failed for agent=${employee.id} skill=${skillId}: `
					+ `${err instanceof Error ? err.message : String(err)}`,
				);
			});
		});
	}

	/**
	 * Fire a batch skill-sync event after all skills for an agent have been
	 * written to disk (e.g. on agent creation).
	 */
	private _fireSkillBatchLifecycle(employee: Employee, skillIds: readonly string[]): void {
		const wsPath = employee.workspaceId
			? (async () => { try { const ws = await this.getWorkspace(employee.workspaceId!); return ws?.path; } catch { return undefined; } })()
			: Promise.resolve(undefined);

		void wsPath.then(workspacePath => {
			const payload: ISkillBatchLifecyclePayload = {
				workspaceId: employee.workspaceId,
				workspacePath,
				agentId: employee.id,
				agentDir: employee.agentDir,
				skillIds,
				timestamp: new Date().toISOString(),
			};
			void this.skillLifecycleService.fireBatchEvent(payload).catch(err => {
				this.logService.warn(
					`[AgentStudioService] skill batch lifecycle hook failed for agent=${employee.id}: `
					+ `${err instanceof Error ? err.message : String(err)}`,
				);
			});
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
	 * Resolve the data directory URI for an employee.
	 * Priority:
	 *   1. Workspace with `path` → `{path}/.sarosisworkspace/`
	 *   2. VS Code open folder   → `{folder}/.sarosisworkspace/`
	 *   3. Global fallback       → `{globalDataUri}/` or `{globalDataUri}/{workspaceId}/`
	 */
	private async _resolveDataUri(workspaceId?: string): Promise<URI> {
		if (workspaceId) {
			return this._getWorkspaceDataUri(workspaceId);
		}
		// No workspaceId — try to use the currently open VS Code folder
		const folderUri = this._getFirstWorkspaceFolderUri();
		if (folderUri) {
			return URI.joinPath(folderUri, WORKSPACE_DATA_DIR);
		}
		return this._getGlobalDataUri();
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

	/**
	 * Compute an initial position for a new node that does not overlap existing
	 * employees on the canvas.  Uses a grid strategy: columns of width
	 * `COL_WIDTH` (280 px), rows of height `ROW_HEIGHT` (200 px), up to
	 * `MAX_COLS` columns per row.  For every candidate cell we check whether any
	 * existing employee is "too close" (within half a cell size) and skip to the
	 * next cell if so.
	 */
	private _computeNonOverlappingPosition(existingEmployees: Employee[]): { x: number; y: number } {
		const ORIGIN_X = 100;
		const ORIGIN_Y = 100;
		const COL_WIDTH = 280;
		const ROW_HEIGHT = 200;
		const MAX_COLS = 4;
		const OVERLAP_THRESHOLD_X = COL_WIDTH / 2;   // 140
		const OVERLAP_THRESHOLD_Y = ROW_HEIGHT / 2;   // 100

		const occupied = existingEmployees
			.map(e => e.position)
			.filter((p): p is { x: number; y: number } => !!p);

		// Iterate grid cells until we find one that doesn't overlap
		for (let cell = 0; cell < 100; cell++) {   // 100 cells max (safety)
			const col = cell % MAX_COLS;
			const row = Math.floor(cell / MAX_COLS);
			const candidateX = ORIGIN_X + col * COL_WIDTH;
			const candidateY = ORIGIN_Y + row * ROW_HEIGHT;

			const overlaps = occupied.some(p =>
				Math.abs(p.x - candidateX) < OVERLAP_THRESHOLD_X &&
				Math.abs(p.y - candidateY) < OVERLAP_THRESHOLD_Y
			);
			if (!overlaps) {
				return { x: candidateX, y: candidateY };
			}
		}

		// Fallback: place below all existing nodes
		const maxY = occupied.reduce((max, p) => Math.max(max, p.y), 0);
		return { x: ORIGIN_X, y: maxY + ROW_HEIGHT };
	}

	// ─── Employees ──────────────────────────────────────────────────────────────

	async getEmployees(workspaceId?: string): Promise<Employee[]> {
		const dirUri = await this._resolveDataUri(workspaceId);
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
		// Try the VS Code workspace folder (may have employees without a workspace record)
		const folderUri = this._getFirstWorkspaceFolderUri();
		if (folderUri) {
			const localDirUri = URI.joinPath(folderUri, WORKSPACE_DATA_DIR);
			const localEmployees = await this._readJsonFile<Employee>(localDirUri, DATA_FILE_EMPLOYEES);
			const found = localEmployees.find(e => e.id === id);
			if (found) { return found; }
		}
		// Fallback: search global
		const globalEmployees = await this._readJsonFile<Employee>(this._getGlobalDataUri(), DATA_FILE_EMPLOYEES);
		return globalEmployees.find(e => e.id === id);
	}

	async createEmployee(data: Partial<Employee>): Promise<Employee> {
		const workspaceId = data.workspaceId;
		const dirUri = await this._resolveDataUri(workspaceId);
		const filename = DATA_FILE_EMPLOYEES;

		const employees = await this._readJsonFile<Employee>(dirUri, filename);

		// PM uniqueness check: only one PM per workspace
		if (data.agentType === EmployeeStatus.Idle as unknown || false) { /* never */ }
		const incomingType = (data as Record<string, unknown>).agentType as string | undefined;
		if (incomingType === 'pm') {
			const existingPM = employees.find(e => (e as unknown as Record<string, unknown>).agentType === 'pm');
			if (existingPM) {
				throw new Error(`此 Workspace 已有 PM "${existingPM.name}"，仅允许 1 个 PM。请先移除现有 PM 再创建新的。`);
			}
		}

		const now = new Date().toISOString();
		const id = this._generateId();

		// Generate a unique agent directory slug: <sanitised-name>-<shortId>
		const slug = this._generateAgentSlug(data.name || 'agent', id);

		// Extract bootstrapTemplates — used for agent dir creation but NOT persisted to employees.json
		const bootstrapTemplates = data.bootstrapTemplates;

		const newEmployee: Employee = {
			id,
			name: data.name || 'New Employee',
			role: data.role || 'engineer',
			email: data.email,
			avatar: data.avatar,
			presetId: data.presetId,
			model: data.model,
			customPrompt: data.customPrompt,
			skills: data.skills || [],
			status: EmployeeStatus.Idle,
			agentType: (data as Record<string, unknown>).agentType as Employee['agentType'],
			teamId: data.teamId,
			workspaceId: data.workspaceId,
			position: data.position || this._computeNonOverlappingPosition(employees),
			tokenUsage: 0,
			agentDir: slug,
			createdAt: now,
			updatedAt: now,
		};
		employees.push(newEmployee);
		await this._writeJsonFile(dirUri, filename, employees);

		// Create the agent instance directory with bootstrap files
		// Pass preset bootstrapTemplates so preset-specific content is used
		await this._createAgentInstanceDir(dirUri, newEmployee, bootstrapTemplates);

		this._onDidChangeEmployees.fire();
		return newEmployee;
	}

	async updateEmployee(id: string, data: Partial<Employee>): Promise<Employee> {
		this.logService.info(`[AgentStudio] updateEmployee: id=${id}, data=${JSON.stringify(data)}`);

		// First, locate the employee across all known storage locations
		// so that we write to the correct directory even when data.workspaceId is absent.
		const locateResult = await this._locateEmployee(id);
		if (!locateResult) {
			this.logService.error(`[AgentStudio] updateEmployee: Employee not found across all storage locations: ${id}`);
			throw new Error(`Employee not found: ${id}`);
		}
		const { dirUri, employees, index } = locateResult;

		this.logService.info(`[AgentStudio] updateEmployee: found at dirUri=${dirUri.toString()}, index=${index}, name=${employees[index].name}`);

		const oldSkills = employees[index].skills ?? [];
		const oldSkillIds = new Set(oldSkills.map(s => s.id));

		employees[index] = {
			...employees[index],
			...data,
			id, // ensure ID can't be changed
			updatedAt: new Date().toISOString(),
		};
		await this._writeJsonFile(dirUri, DATA_FILE_EMPLOYEES, employees);

		// ─── Skills directory sync ───────────────────────────────────────
		// If the update includes a skills change, sync the skills directory
		// on disk and fire skill-lifecycle events.
		const updated = employees[index];
		if (data.skills !== undefined) {
			const newSkills = updated.skills ?? [];
			const newSkillIds = new Set(newSkills.map(s => s.id));

			// Sync skills directory on disk (add missing, leave extras)
			if (updated.agentDir) {
				await this._syncAgentSkillsDir(dirUri, updated, newSkills);
			}

			// Fire lifecycle events for added / removed skills
			for (const skill of newSkills) {
				if (!oldSkillIds.has(skill.id)) {
					this._fireSkillLifecycle(SkillLifecycleEvent.Added, updated, skill.id, skill.name);
				}
			}
			for (const skill of oldSkills) {
				if (!newSkillIds.has(skill.id)) {
					this._fireSkillLifecycle(SkillLifecycleEvent.Removed, updated, skill.id, skill.name);
				}
			}
		}

		this.logService.info(`[AgentStudio] updateEmployee: wrote employees.json, firing onDidChangeEmployees`);
		this._onDidChangeEmployees.fire();
		return employees[index];
	}

	/**
	 * Locate an employee across all storage locations.
	 * Returns the dirUri, the employees array, and the index — or undefined if not found.
	 */
	private async _locateEmployee(id: string): Promise<{ dirUri: URI; employees: Employee[]; index: number } | undefined> {
		// 1. Search across all workspaces
		const workspaces = await this.getWorkspaces();
		this.logService.debug(`[AgentStudio] _locateEmployee(${id}): searching ${workspaces.length} workspace(s)`);
		for (const ws of workspaces) {
			const dirUri = await this._getWorkspaceDataUri(ws.id);
			const employees = await this._readJsonFile<Employee>(dirUri, DATA_FILE_EMPLOYEES);
			const index = employees.findIndex(e => e.id === id);
			this.logService.debug(`[AgentStudio] _locateEmployee: workspace ${ws.id} (${dirUri.toString()}) has ${employees.length} employees, match=${index !== -1}`);
			if (index !== -1) {
				return { dirUri, employees, index };
			}
		}
		// 2. Try the VS Code workspace folder
		const folderUri = this._getFirstWorkspaceFolderUri();
		if (folderUri) {
			const localDirUri = URI.joinPath(folderUri, WORKSPACE_DATA_DIR);
			const localEmployees = await this._readJsonFile<Employee>(localDirUri, DATA_FILE_EMPLOYEES);
			const localIndex = localEmployees.findIndex(e => e.id === id);
			this.logService.debug(`[AgentStudio] _locateEmployee: VS Code folder (${localDirUri.toString()}) has ${localEmployees.length} employees, match=${localIndex !== -1}`);
			if (localIndex !== -1) {
				return { dirUri: localDirUri, employees: localEmployees, index: localIndex };
			}
		} else {
			this.logService.debug(`[AgentStudio] _locateEmployee: no VS Code workspace folder`);
		}
		// 3. Fallback: global directory
		const globalDirUri = this._getGlobalDataUri();
		const globalEmployees = await this._readJsonFile<Employee>(globalDirUri, DATA_FILE_EMPLOYEES);
		const globalIndex = globalEmployees.findIndex(e => e.id === id);
		this.logService.debug(`[AgentStudio] _locateEmployee: global (${globalDirUri.toString()}) has ${globalEmployees.length} employees, match=${globalIndex !== -1}`);
		if (globalIndex !== -1) {
			return { dirUri: globalDirUri, employees: globalEmployees, index: globalIndex };
		}
		this.logService.warn(`[AgentStudio] _locateEmployee: employee ${id} not found in any location`);
		return undefined;
	}

	async deleteEmployee(id: string): Promise<void> {
		// Search across all workspaces to find where the employee lives
		const workspaces = await this.getWorkspaces();
		for (const ws of workspaces) {
			const dirUri = await this._getWorkspaceDataUri(ws.id);
			const employees = await this._readJsonFile<Employee>(dirUri, DATA_FILE_EMPLOYEES);
			const index = employees.findIndex(e => e.id === id);
			if (index !== -1) {
				const employee = employees[index];
				employees.splice(index, 1);
				await this._writeJsonFile(dirUri, DATA_FILE_EMPLOYEES, employees);
				// Clean up agent instance directory
				if (employee.agentDir) {
					await this._deleteAgentInstanceDir(dirUri, employee.agentDir);
				}
				this._onDidChangeEmployees.fire();
				return;
			}
		}
		// Try the VS Code workspace folder
		const folderUri = this._getFirstWorkspaceFolderUri();
		if (folderUri) {
			const localDirUri = URI.joinPath(folderUri, WORKSPACE_DATA_DIR);
			const localEmployees = await this._readJsonFile<Employee>(localDirUri, DATA_FILE_EMPLOYEES);
			const localIndex = localEmployees.findIndex(e => e.id === id);
			if (localIndex !== -1) {
				const employee = localEmployees[localIndex];
				localEmployees.splice(localIndex, 1);
				await this._writeJsonFile(localDirUri, DATA_FILE_EMPLOYEES, localEmployees);
				if (employee.agentDir) {
					await this._deleteAgentInstanceDir(localDirUri, employee.agentDir);
				}
				this._onDidChangeEmployees.fire();
				return;
			}
		}
		// Fallback: try global
		const globalEmployees = await this._readJsonFile<Employee>(this._getGlobalDataUri(), DATA_FILE_EMPLOYEES);
		const target = globalEmployees.find(e => e.id === id);
		const filtered = globalEmployees.filter(e => e.id !== id);
		if (filtered.length < globalEmployees.length) {
			await this._writeJsonFile(this._getGlobalDataUri(), DATA_FILE_EMPLOYEES, filtered);
			// Clean up agent instance directory from global dir
			if (target?.agentDir) {
				await this._deleteAgentInstanceDir(this._getGlobalDataUri(), target.agentDir);
			}
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
			id: this._generateId(),
			name: data.name || 'New Workspace',
			description: data.description,
			path: wsPath,
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
		this._fireWorkspaceLifecycle(WorkspaceLifecycleEvent.Created, newWorkspace);
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
		this._fireWorkspaceLifecycle(WorkspaceLifecycleEvent.Updated, workspaces[index]);
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

		// Sync positions to employees.json BEFORE firing the change event,
		// so that any listeners re-reading employees get the updated positions.
		try {
			await this._syncPositionsToEmployees(id, layout);
		} catch (err) {
			this.logService.debug('[AgentStudio] _syncPositionsToEmployees failed', err);
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

		// Sync connections to employees.json
		this._syncConnectionsToEmployees(workspaceId).catch(err => {
			this.logService.debug('[AgentStudio] _syncConnectionsToEmployees failed after addConnection', err);
		});

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

		// Sync connections to employees.json
		this._syncConnectionsToEmployees(workspaceId).catch(err => {
			this.logService.debug('[AgentStudio] _syncConnectionsToEmployees failed after removeConnection', err);
		});

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

	// ─── Agent Model Config Persistence ─────────────────────────────────────────
	// Write / read provider + model + agent selection to / from agent.yaml so
	// that the chat-bar selection survives a window reload.

	async updateEmployeeModelConfig(
		employeeId: string,
		config: { providerId: string; modelId: string; agentId?: string },
	): Promise<void> {
		this.logService.info(`[AgentStudio] updateEmployeeModelConfig: employeeId=${employeeId}, config=${JSON.stringify(config)}`);

		const employee = await this.getEmployee(employeeId);
		if (!employee || !employee.agentDir) {
			this.logService.warn(`[AgentStudio] updateEmployeeModelConfig: employee not found or no agentDir (id=${employeeId}, found=${!!employee}, agentDir=${employee?.agentDir})`);
			return;
		}

		const workspaceId = employee.workspaceId;
		const dirUri = await this._resolveDataUri(workspaceId);
		const configFileUri = URI.joinPath(dirUri, AGENTS_DIR, employee.agentDir, AGENT_CONFIG_FILE);
		this.logService.info(`[AgentStudio] updateEmployeeModelConfig: configFileUri=${configFileUri.toString()}`);

		try {
			// Read existing config
			const raw = await this.fileService.readFile(configFileUri);
			const agentConfig = JSON.parse(raw.value.toString());

			// Update model section
			agentConfig.model = {
				...(agentConfig.model || {}),
				providerId: config.providerId,
				modelId: config.modelId,
				...(config.agentId ? { agentId: config.agentId } : {}),
			};
			// Remove agentId from model if it's undefined/cleared
			if (!config.agentId) {
				delete agentConfig.model.agentId;
			}

			agentConfig.updatedAt = new Date().toISOString();

			await this.fileService.writeFile(
				configFileUri,
				VSBuffer.fromString(JSON.stringify(agentConfig, null, 2)),
			);

			this.logService.info(
				`[AgentStudio] Updated agent.yaml model config for employee ${employeeId}: `
				+ `${config.providerId}/${config.modelId}${config.agentId ? ` [agent: ${config.agentId}]` : ''}`,
			);
		} catch (err) {
			this.logService.error(`[AgentStudio] Failed to update agent.yaml for employee ${employeeId} at ${configFileUri.toString()}`, err);
		}
	}

	// ─── Agent Position & Connection Persistence (employees.json) ───────────────

	/**
	 * Persist position to employees.json so that canvas layout survives a window reload.
	 */
	async updateEmployeePosition(
		employeeId: string,
		position: { x: number; y: number },
	): Promise<void> {
		this.logService.info(`[AgentStudio] updateEmployeePosition: employeeId=${employeeId}, pos=(${position.x}, ${position.y})`);

		const locateResult = await this._locateEmployee(employeeId);
		if (locateResult) {
			const { dirUri, employees, index } = locateResult;
			employees[index] = {
				...employees[index],
				position,
				updatedAt: new Date().toISOString(),
			};
			await this._writeJsonFile(dirUri, DATA_FILE_EMPLOYEES, employees);
		}
	}

	/**
	 * Read position from employees.json.
	 */
	async getEmployeePosition(
		employeeId: string,
	): Promise<{ x: number; y: number } | undefined> {
		const employee = await this.getEmployee(employeeId);
		return employee?.position;
	}

	/**
	 * Persist connections (edges) involving an employee to employees.json.
	 * Each agent stores the connections it participates in (as source or target).
	 */
	async updateEmployeeConnections(
		employeeId: string,
		connections: Array<{ id: string; sourceId: string; targetId: string; type: string; label?: string }>,
	): Promise<void> {
		this.logService.info(`[AgentStudio] updateEmployeeConnections: employeeId=${employeeId}, count=${connections.length}`);

		const locateResult = await this._locateEmployee(employeeId);
		if (locateResult) {
			const { dirUri, employees, index } = locateResult;
			employees[index] = {
				...employees[index],
				connections,
				updatedAt: new Date().toISOString(),
			};
			await this._writeJsonFile(dirUri, DATA_FILE_EMPLOYEES, employees);
		}
	}

	/**
	 * Persist all positions from the canvas layout to employees.json.
	 * Called by updateWorkspaceLayout.
	 */
	private async _syncPositionsToEmployees(workspaceId: string, layout: WorkspaceLayout): Promise<void> {
		if (!layout.nodes || layout.nodes.length === 0) { return; }

		const dirUri = await this._resolveDataUri(workspaceId);
		const employees = await this._readJsonFile<Employee>(dirUri, DATA_FILE_EMPLOYEES);
		let changed = false;

		for (const node of layout.nodes) {
			if (node.position) {
				const idx = employees.findIndex(e => e.id === node.id);
				if (idx !== -1) {
					employees[idx] = {
						...employees[idx],
						position: node.position,
						updatedAt: new Date().toISOString(),
					};
					changed = true;
				}
			}
		}

		if (changed) {
			await this._writeJsonFile(dirUri, DATA_FILE_EMPLOYEES, employees);
		}
	}

	/**
	 * Persist all connections to each participating agent in employees.json.
	 * Called by addConnection / removeConnection.
	 */
	private async _syncConnectionsToEmployees(workspaceId: string): Promise<void> {
		const workspace = await this.getWorkspace(workspaceId);
		if (!workspace) { return; }

		const connections = workspace.connections || [];
		const dirUri = await this._resolveDataUri(workspaceId);
		const employees = await this._readJsonFile<Employee>(dirUri, DATA_FILE_EMPLOYEES);
		let changed = false;

		// Build per-agent connection lists
		const agentConnections = new Map<string, Array<{ id: string; sourceId: string; targetId: string; type: string; label?: string }>>();
		for (const emp of employees) {
			agentConnections.set(emp.id, []);
		}
		for (const conn of connections) {
			const connData = { id: conn.id, sourceId: conn.sourceId, targetId: conn.targetId, type: conn.type, label: conn.label };
			if (agentConnections.has(conn.sourceId)) { agentConnections.get(conn.sourceId)!.push(connData); }
			if (agentConnections.has(conn.targetId)) { agentConnections.get(conn.targetId)!.push(connData); }
		}

		for (let i = 0; i < employees.length; i++) {
			const conns = agentConnections.get(employees[i].id) || [];
			employees[i] = {
				...employees[i],
				connections: conns,
				updatedAt: new Date().toISOString(),
			};
			changed = true;
		}

		if (changed) {
			await this._writeJsonFile(dirUri, DATA_FILE_EMPLOYEES, employees);
		}
	}

	async getEmployeeModelConfig(
		employeeId: string,
	): Promise<{ providerId: string; modelId: string; agentId?: string } | undefined> {
		const employee = await this.getEmployee(employeeId);
		if (!employee || !employee.agentDir) {
			return undefined;
		}

		const workspaceId = employee.workspaceId;
		const dirUri = await this._resolveDataUri(workspaceId);
		const configFileUri = URI.joinPath(dirUri, AGENTS_DIR, employee.agentDir, AGENT_CONFIG_FILE);

		try {
			const raw = await this.fileService.readFile(configFileUri);
			const agentConfig = JSON.parse(raw.value.toString());
			const model = agentConfig.model;

			// Treat legacy placeholder values ('default', 'gpt-4o' written by
			// older versions) as "no real config" so that callers fall back to
			// the global selection / auto-pick logic instead of trying to
			// resolve a non-existent provider id.
			const providerId = model?.providerId;
			const modelId = model?.modelId;
			const isPlaceholder = providerId === 'default' || !providerId || !modelId;

			if (model && !isPlaceholder) {
				return {
					providerId: providerId,
					modelId: modelId,
					agentId: model.agentId,
				};
			}
		} catch (err) {
			this.logService.debug(`[AgentStudio] Could not read agent.yaml model config for employee ${employeeId}`, err);
		}

		return undefined;
	}

	// ─── Agent Instance Import / Export ─────────────────────────────────────────

	async exportEmployee(id: string): Promise<AgentExportData> {
		const employee = await this.getEmployee(id);
		if (!employee) {
			throw new Error(`Employee not found: ${id}`);
		}

		// Resolve agent directory
		const workspaceId = employee.workspaceId;
		const dirUri = await this._resolveDataUri(workspaceId);

		// Read agent.yaml
		let agentConfig: Record<string, unknown> = {};
		if (employee.agentDir) {
			try {
				const configUri = URI.joinPath(dirUri, AGENTS_DIR, employee.agentDir, AGENT_CONFIG_FILE);
				const raw = await this.fileService.readFile(configUri);
				agentConfig = JSON.parse(raw.value.toString());
			} catch {
				this.logService.debug(`[AgentStudio] exportEmployee: could not read agent.yaml for ${id}`);
			}
		}

		// Read bootstrap files
		const files: Record<string, string | undefined> = {};
		if (employee.agentDir) {
			const agentDirUri = URI.joinPath(dirUri, AGENTS_DIR, employee.agentDir);
			const mdFiles: Array<{ key: string; filename: string }> = [
				{ key: 'agentsMd', filename: AGENT_AGENTS_MD },
				{ key: 'soulMd', filename: AGENT_SOUL_MD },
				{ key: 'identityMd', filename: AGENT_IDENTITY_MD },
				{ key: 'toolsMd', filename: AGENT_TOOLS_MD },
				{ key: 'memoryMd', filename: AGENT_MEMORY_MD },
			];
			for (const { key, filename } of mdFiles) {
				try {
					const content = await this.fileService.readFile(URI.joinPath(agentDirUri, filename));
					files[key] = content.value.toString();
				} catch {
					// File may not exist — skip
				}
			}
		}

		// Build portable employee data (strip instance-specific fields)
		const { id: _id, workspaceId: _wsId, agentDir: _dir, bootstrapTemplates: _bt, status: _st, tokenUsage: _tu, position: _pos, ...portableEmployee } = employee;

		const exportData: AgentExportData = {
			version: 1,
			exportedAt: new Date().toISOString(),
			employee: portableEmployee,
			agentConfig,
			files: files as AgentExportData['files'],
		};

		this.logService.info(`[AgentStudio] Exported employee: ${employee.name} (${id})`);
		return exportData;
	}

	async importEmployee(data: AgentExportData, workspaceId?: string): Promise<Employee> {
		// Validate export format version
		if (!data || data.version !== 1) {
			throw new Error('Unsupported or invalid agent export format');
		}

		// Determine target directory
		const dirUri = await this._resolveDataUri(workspaceId);

		// Read existing employees to check for name collisions
		const existingEmployees = await this._readJsonFile<Employee>(dirUri, DATA_FILE_EMPLOYEES);
		const desiredName = data.employee.name || 'Imported Agent';

		// Auto-rename if a duplicate name exists
		const finalName = this._deduplicateName(desiredName, existingEmployees);

		const now = new Date().toISOString();
		const id = this._generateId();
		const slug = this._generateAgentSlug(finalName, id);

		const newEmployee: Employee = {
			id,
			name: finalName,
			role: data.employee.role || 'engineer',
			email: data.employee.email,
			avatar: data.employee.avatar,
			presetId: data.employee.presetId,
			model: data.employee.model,
			provider: data.employee.provider,
			customPrompt: data.employee.customPrompt,
			skills: data.employee.skills || [],
			status: EmployeeStatus.Idle,
			workspaceId,
			position: this._computeNonOverlappingPosition(existingEmployees),
			tokenUsage: 0,
			agentDir: slug,
			createdAt: now,
			updatedAt: now,
		};

		// Persist to employees.json
		existingEmployees.push(newEmployee);
		await this._writeJsonFile(dirUri, DATA_FILE_EMPLOYEES, existingEmployees);

		// Create agent instance directory
		if (newEmployee.agentDir) {
			try {
				// Ensure parent directories exist
				await this._ensureDir(dirUri);
				const agentsDirUri = URI.joinPath(dirUri, AGENTS_DIR);
				await this._ensureDir(agentsDirUri);
				const agentDirUri = URI.joinPath(agentsDirUri, newEmployee.agentDir);
				await this._ensureDir(agentDirUri);

				// Write agent.yaml — merge imported config with new identity
				const config = {
					...(data.agentConfig || {}),
					id: newEmployee.id,
					name: newEmployee.name,
					role: newEmployee.role,
					slug: newEmployee.agentDir,
					createdAt: newEmployee.createdAt,
					updatedAt: newEmployee.updatedAt,
					status: newEmployee.status,
				};
				await this.fileService.writeFile(
					URI.joinPath(agentDirUri, AGENT_CONFIG_FILE),
					VSBuffer.fromString(JSON.stringify(config, null, 2)),
				);

				// Write bootstrap files from export data (or fall back to generic templates)
				const bootstrapTemplates: AgentBootstrapTemplates = data.files || {};
				await this._writeBootstrapFile(agentDirUri, AGENT_AGENTS_MD,
					bootstrapTemplates.agentsMd || this._getAgentsMdTemplate(newEmployee));
				await this._writeBootstrapFile(agentDirUri, AGENT_SOUL_MD,
					bootstrapTemplates.soulMd || this._getSoulMdTemplate(newEmployee));
				await this._writeBootstrapFile(agentDirUri, AGENT_IDENTITY_MD,
					bootstrapTemplates.identityMd || this._getIdentityMdTemplate(newEmployee));
				await this._writeBootstrapFile(agentDirUri, AGENT_TOOLS_MD,
					bootstrapTemplates.toolsMd || this._getToolsMdTemplate());
				await this._writeBootstrapFile(agentDirUri, AGENT_MEMORY_MD,
					bootstrapTemplates.memoryMd || this._getMemoryMdTemplate());

				// Create sessions subdirectory
				await this._ensureDir(URI.joinPath(agentDirUri, 'sessions'));

				this.logService.info(`[AgentStudio] Imported agent instance directory: ${agentDirUri.toString()}`);
			} catch (err) {
				this.logService.error(`[AgentStudio] Failed to create imported agent directory for: ${newEmployee.agentDir}`, err);
			}
		}

		this._onDidChangeEmployees.fire();
		this.logService.info(`[AgentStudio] Imported employee: ${finalName} (original: ${desiredName})`);
		return newEmployee;
	}

	/**
	 * Deduplicate a name against existing employees.
	 * If `name` already exists, appends `_1`, `_2`, … until a unique name is found.
	 */
	private _deduplicateName(name: string, existingEmployees: Employee[]): string {
		const nameSet = new Set(existingEmployees.map(e => e.name));
		if (!nameSet.has(name)) {
			return name;
		}
		let suffix = 1;
		while (nameSet.has(`${name}_${suffix}`)) {
			suffix++;
		}
		return `${name}_${suffix}`;
	}

	// ─── Agent Instance Directory Helpers ────────────────────────────────────────
	// Inspired by OpenClaw's workspace bootstrap structure.
	// Each agent gets its own folder under .sarosisworkspace/agents/{slug}/ with
	// a config file (agent.yaml) and Markdown bootstrap files (AGENTS.md, SOUL.md,
	// IDENTITY.md, TOOLS.md, MEMORY.md).

	/**
	 * Generate a unique, filesystem-safe slug for the agent directory.
	 * Format: `<lowercase-name>-<shortId>` (e.g. "coder-xk4mq9b")
	 */
	private _generateAgentSlug(name: string, id: string): string {
		const sanitised = name
			.toLowerCase()
			.replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')  // replace non-alphanumeric (keep CJK) with dash
			.replace(/^-+|-+$/g, '')                     // trim leading/trailing dashes
			|| 'agent';                                  // fallback
		const shortId = id.replace(/-/g, '').slice(-7);  // last 7 chars of the generated id
		return `${sanitised}-${shortId}`;
	}

	/**
	 * Create the agent instance directory and bootstrap files.
	 *
	 * Directory structure (under workspaceDataUri):
	 *   agents/{slug}/
	 *     ├── agent.yaml       — Agent configuration (JSON, named .yaml for convention)
	 *     ├── AGENTS.md        — Operational instructions
	 *     ├── SOUL.md          — Personality / core values
	 *     ├── IDENTITY.md      — Identity record (name, emoji, etc.)
	 *     ├── TOOLS.md         — Local environment tool notes
	 *     ├── MEMORY.md        — Long-term memory
	 *     └── sessions/        — Future: per-agent session transcripts
	 *
	 * @param bootstrapTemplates Optional preset-specific templates. When provided,
	 *        these override the generic templates for each bootstrap file.
	 */
	private async _createAgentInstanceDir(workspaceDataUri: URI, employee: Employee, bootstrapTemplates?: AgentBootstrapTemplates): Promise<void> {
		if (!employee.agentDir) {
			return;
		}

		try {
			// Ensure .sarosisworkspace/ exists
			await this._ensureDir(workspaceDataUri);
			// Ensure .sarosisworkspace/agents/ exists
			const agentsDirUri = URI.joinPath(workspaceDataUri, AGENTS_DIR);
			await this._ensureDir(agentsDirUri);
			// Create .sarosisworkspace/agents/{slug}/
			const agentDirUri = URI.joinPath(agentsDirUri, employee.agentDir);
			await this._ensureDir(agentDirUri);

			// 1) Write agent.yaml (JSON config)
			// Only write providerId/modelId when they are real values.
			// Avoid the placeholder 'default'/'gpt-4o' — those break the
			// webview's "restore selection from agent.yaml" path because
			// 'default' is not a real provider id and the lookup silently
			// falls back to the global selection (which can be a totally
			// unrelated provider/model the user picked elsewhere).
			const modelSection: Record<string, unknown> = {
				temperature: 0.7,
				maxTokens: 4096,
			};
			if (employee.provider) {
				modelSection.providerId = employee.provider;
			}
			if (employee.model) {
				modelSection.modelId = employee.model;
			}
			const agentConfig = {
				id: employee.id,
				name: employee.name,
				role: employee.role,
				slug: employee.agentDir,
				model: modelSection,
				customPrompt: employee.customPrompt || '',
				skills: (employee.skills || []).map(s => s.name),
				presetId: employee.presetId,
				memory: { enabled: true },
				tools: ['filesystem', 'search'],
				planning: { enabled: true },
				execution: { enabled: true, maxIterations: 10 },
				createdAt: employee.createdAt,
				updatedAt: employee.updatedAt,
				status: employee.status,
			};
			await this.fileService.writeFile(
				URI.joinPath(agentDirUri, AGENT_CONFIG_FILE),
				VSBuffer.fromString(JSON.stringify(agentConfig, null, 2)),
			);

			// 2) Write bootstrap Markdown files
			// Use preset-specific templates if provided, otherwise fall back to generic templates
			await this._writeBootstrapFile(agentDirUri, AGENT_AGENTS_MD,
				bootstrapTemplates?.agentsMd || this._getAgentsMdTemplate(employee));
			await this._writeBootstrapFile(agentDirUri, AGENT_SOUL_MD,
				bootstrapTemplates?.soulMd || this._getSoulMdTemplate(employee));
			await this._writeBootstrapFile(agentDirUri, AGENT_IDENTITY_MD,
				bootstrapTemplates?.identityMd || this._getIdentityMdTemplate(employee));
			await this._writeBootstrapFile(agentDirUri, AGENT_TOOLS_MD,
				bootstrapTemplates?.toolsMd || this._getToolsMdTemplate());
			await this._writeBootstrapFile(agentDirUri, AGENT_MEMORY_MD,
				bootstrapTemplates?.memoryMd || this._getMemoryMdTemplate());

			// 3) Create sessions subdirectory for future session transcripts
			const sessionsDir = URI.joinPath(agentDirUri, 'sessions');
			await this._ensureDir(sessionsDir);

			// 4) Create skills subdirectory and populate with SKILL.md files
			await this._createAgentSkillsDir(agentDirUri, employee);

			this.logService.info(`[AgentStudio] Created agent instance directory: ${agentDirUri.toString()}`);
		} catch (err) {
			this.logService.error(`[AgentStudio] Failed to create agent instance directory for: ${employee.agentDir}`, err);
			// Non-fatal: employee is still created in the employees list
		}
	}

	/**
	 * Write a bootstrap file into the agent directory (only if it doesn't already exist).
	 */
	private async _writeBootstrapFile(agentDirUri: URI, filename: string, content: string): Promise<void> {
		const fileUri = URI.joinPath(agentDirUri, filename);
		try {
			await this.fileService.stat(fileUri);
			// File already exists — don't overwrite
			this.logService.debug(`[AgentStudio] Bootstrap file already exists, skipping: ${filename}`);
		} catch {
			// File doesn't exist — write it
			await this.fileService.writeFile(fileUri, VSBuffer.fromString(content));
		}
	}

	/**
	 * Create the `skills/` subdirectory inside the agent instance dir and
	 * populate it with one `<skill-id>/SKILL.md` per configured skill.
	 *
	 * For each skill on the employee:
	 *   1. Look up the full `ISkillDefinition` from the SkillRegistry.
	 *   2. If found, serialise it as a standard SKILL.md (YAML frontmatter + prompt body).
	 *   3. If the skill is not in the registry (e.g. a custom tag), write a
	 *      minimal placeholder SKILL.md so the folder is still useful.
	 *
	 * Existing SKILL.md files are **not overwritten** (same policy as bootstrap files).
	 */
	private async _createAgentSkillsDir(agentDirUri: URI, employee: Employee): Promise<void> {
		const skills = employee.skills;
		if (!skills || skills.length === 0) { return; }

		const skillsDirUri = URI.joinPath(agentDirUri, 'skills');
		await this._ensureDir(skillsDirUri);

		for (const empSkill of skills) {
			const skillId = empSkill.id;
			// Sanitise id for use as a directory name
			const dirName = skillId.replace(/[^a-zA-Z0-9_-]/g, '-');
			const skillSubDir = URI.joinPath(skillsDirUri, dirName);
			await this._ensureDir(skillSubDir);

			// Look up the full definition from the registry
			const definition = this.skillRegistry.getSkill(skillId);
			const content = definition
				? this._renderSkillMd(definition)
				: this._renderSkillMdFromRef(empSkill);

			// Write SKILL.md (don't overwrite existing)
			await this._writeBootstrapFile(skillSubDir, 'SKILL.md', content);
		}

		this.logService.info(`[AgentStudio] Created skills directory with ${skills.length} skill(s) for agent: ${employee.agentDir}`);

		// Fire batch skill-sync lifecycle event
		this._fireSkillBatchLifecycle(employee, skills.map(s => s.id));
	}

	/**
	 * Sync the `skills/` subdirectory when an employee's skill list is updated.
	 *
	 * Unlike `_createAgentSkillsDir` (which is called once on agent creation and
	 * never overwrites), this method:
	 *   - Creates SKILL.md for any **new** skills that are missing on disk.
	 *   - Removes skill subdirectories for skills that are **no longer** in the
	 *     employee's skill list (the SKILL.md file is deleted; the folder is
	 *     deleted only if it contains nothing else).
	 *   - Overwrites existing SKILL.md files if the registry definition has
	 *     changed (ensures the on-disk content stays in sync with the registry).
	 */
	private async _syncAgentSkillsDir(dataDirUri: URI, employee: Employee, newSkills: readonly import('../../../common/agentStudioTypes.js').EmployeeSkill[]): Promise<void> {
		if (!employee.agentDir) { return; }

		const agentDirUri = URI.joinPath(dataDirUri, AGENTS_DIR, employee.agentDir);
		const skillsDirUri = URI.joinPath(agentDirUri, 'skills');

		// Ensure the skills directory exists
		await this._ensureDir(skillsDirUri);

		const newSkillIds = new Set(newSkills.map(s => s.id));

		// 1) Add / update skills present in the new list
		for (const empSkill of newSkills) {
			const dirName = empSkill.id.replace(/[^a-zA-Z0-9_-]/g, '-');
			const skillSubDir = URI.joinPath(skillsDirUri, dirName);
			await this._ensureDir(skillSubDir);

			const definition = this.skillRegistry.getSkill(empSkill.id);
			const content = definition
				? this._renderSkillMd(definition)
				: this._renderSkillMdFromRef(empSkill);

			// Always write (update) — unlike _createAgentSkillsDir which doesn't overwrite,
			// this ensures on-disk stays in sync after an explicit skill update.
			const skillFile = URI.joinPath(skillSubDir, 'SKILL.md');
			await this.fileService.writeFile(skillFile, VSBuffer.fromString(content));
		}

		// 2) Remove skill subdirectories that are no longer in the employee's list
		try {
			const stat = await this.fileService.resolve(skillsDirUri);
			if (stat.children) {
				for (const child of stat.children) {
					if (!child.isDirectory) { continue; }
					// Derive skill id from directory name (same sanitization)
					const dirSkillId = child.name;
					if (!newSkillIds.has(dirSkillId)) {
						// Delete the skill subdirectory (recursive)
						try {
							await this.fileService.del(child.resource, { recursive: true, useTrash: false });
							this.logService.info(`[AgentStudio] Removed skill directory: ${dirSkillId} for agent: ${employee.agentDir}`);
						} catch (err) {
							this.logService.warn(`[AgentStudio] Failed to remove skill directory ${dirSkillId}: ${err instanceof Error ? err.message : String(err)}`);
						}
					}
				}
			}
		} catch (err) {
			this.logService.debug(`[AgentStudio] Could not scan skills dir for cleanup: ${err instanceof Error ? err.message : String(err)}`);
		}

		this.logService.info(`[AgentStudio] Synced skills directory for agent: ${employee.agentDir} (${newSkills.length} skill(s))`);
	}

	/**
	 * Render a full `SKILL.md` from an `ISkillDefinition` (registry lookup).
	 * Format matches the standard hermes / sarosis SKILL.md convention:
	 *   - YAML frontmatter (name, description, activation, match, category, recommended_tools)
	 *   - Markdown body (the prompt)
	 */
	private _renderSkillMd(def: ISkillDefinition): string {
		const lines: string[] = ['---'];
		lines.push(`name: ${def.name}`);
		if (def.description) {
			lines.push(`description: ${def.description}`);
		}
		lines.push(`activation: ${def.activation}`);
		if (def.match && def.match.length > 0) {
			lines.push(`match: [${def.match.join(', ')}]`);
		}
		if (def.category) {
			lines.push(`category: ${def.category}`);
		}
		if (def.recommendedTools && def.recommendedTools.length > 0) {
			lines.push(`recommended_tools: [${def.recommendedTools.join(', ')}]`);
		}
		lines.push('---');
		lines.push('');
		lines.push(def.prompt);
		lines.push('');
		return lines.join('\n');
	}

	/**
	 * Render a minimal `SKILL.md` placeholder when the skill is not found in
	 * the registry (e.g. a tag-only skill assigned via the preset UI).
	 */
	private _renderSkillMdFromRef(ref: { id: string; name: string; description?: string }): string {
		const lines: string[] = ['---'];
		lines.push(`name: ${ref.name}`);
		if (ref.description) {
			lines.push(`description: ${ref.description}`);
		}
		lines.push('activation: manual');
		lines.push('---');
		lines.push('');
		lines.push(`# ${ref.name}`);
		lines.push('');
		lines.push('<!-- TODO: Add skill instructions here -->');
		lines.push('');
		return lines.join('\n');
	}

	/**
	 * Delete the agent instance directory when an employee is removed.
	 */
	private async _deleteAgentInstanceDir(workspaceDataUri: URI, agentSlug: string): Promise<void> {
		try {
			const agentDirUri = URI.joinPath(workspaceDataUri, AGENTS_DIR, agentSlug);
			await this.fileService.del(agentDirUri, { recursive: true });
			this.logService.info(`[AgentStudio] Deleted agent instance directory: ${agentDirUri.toString()}`);
		} catch (err) {
			this.logService.warn(`[AgentStudio] Failed to delete agent instance directory: ${agentSlug}`, err);
			// Non-fatal
		}
	}

	// ─── Bootstrap File Templates ────────────────────────────────────────────────

	private _getAgentsMdTemplate(employee: Employee): string {
		return `# AGENTS.md - ${employee.name}

## Role
${employee.role}

## Instructions
${employee.customPrompt || 'You are a helpful AI assistant. Follow user instructions carefully and provide clear, concise responses.'}

## Workspace Rules
- Always read existing files before modifying them.
- Preserve existing code style and conventions.
- Ask for clarification when instructions are ambiguous.
- Report progress on long-running tasks.

## Memory Management
- Use MEMORY.md for long-term context that should persist across sessions.
- Keep session-specific notes in the sessions/ directory.

## Security
- Never expose API keys, passwords, or secrets.
- Do not execute destructive operations without explicit confirmation.
`;
	}

	private _getSoulMdTemplate(employee: Employee): string {
		return `# SOUL.md - Who You Are

## Core Identity
You are **${employee.name}**, a ${employee.role}.

## Core Values
- Be thorough and precise in your work.
- Communicate clearly — explain your reasoning.
- Respect the user's time — be efficient.
- Own your mistakes — if you're unsure, say so.

## Boundaries
- Stay within your area of expertise.
- Ask for help when a task is outside your capabilities.
- Never fabricate information — prefer "I don't know" over guessing.

## Style
- Professional yet approachable.
- Concise but complete.
- Use code examples when they clarify a point.
`;
	}

	private _getIdentityMdTemplate(employee: Employee): string {
		return `# IDENTITY.md - Who Am I?

## Name
${employee.name}

## Role
${employee.role}

## Emoji
<!-- Choose an emoji that represents this agent -->

## Avatar
<!-- Avatar reference or description -->

## Notes
<!-- Additional personality notes, tone preferences, etc. -->
`;
	}

	private _getToolsMdTemplate(): string {
		return `# TOOLS.md - Local Environment Notes

## Available Tools
- filesystem: Read and write files in the workspace
- search: Search across the codebase

## Environment Details
<!-- Record environment-specific details here:
     - SSH hosts, server names
     - CLI tool versions
     - Project-specific conventions
     - Preferred editors or formatters
-->
`;
	}

	private _getMemoryMdTemplate(): string {
		return `# MEMORY.md - Long-Term Memory

<!-- 
  This file stores persistent memory across sessions.
  The agent may read and update this file to maintain
  context about the project, user preferences, and
  ongoing work.
-->

## Project Context
<!-- Key facts about the project -->

## User Preferences
<!-- Learned preferences and conventions -->

## Ongoing Work
<!-- Current tasks and their status -->
`;
	}
}
