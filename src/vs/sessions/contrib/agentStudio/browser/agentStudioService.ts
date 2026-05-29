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
import { ConnectionType } from '../../../common/agentStudioTypes.js';
import { EmployeeStatus } from '../../../common/agentStudioTypes.js';
import { DATA_FILE_EMPLOYEES, DATA_FILE_WORKSPACES, DATA_FILE_SESSIONS, DATA_FILE_LAST_ACTIVE_WORKSPACE, AGENT_STUDIO_DATA_PATH_SETTING, WORKSPACE_DATA_DIR, AGENTS_DIR, AGENT_CONFIG_FILE, AGENT_AGENTS_MD, AGENT_SOUL_MD, AGENT_IDENTITY_MD, AGENT_TOOLS_MD, AGENT_MEMORY_MD } from '../common/constants.js';
import { ISkillRegistry } from '../common/skills.js';
import { IWorkspaceLifecycleService, WorkspaceLifecycleEvent, IWorkspaceLifecyclePayload } from '../common/workspaceLifecycle.js';
import { ISkillLifecycleService, SkillLifecycleEvent, ISkillLifecyclePayload } from '../common/skillLifecycle.js';
import { IMGUI_SDK_STYLES } from './imguiBlockProcessor.js';
import { IWorktreeService } from '../../worktree/common/worktreeService.js';
import { IWorktreeWorkspaceOptions, WorktreeStatus, IWorktreeStateEvent } from '../../worktree/common/worktreeTypes.js';

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

	private readonly _onDidChangeWorktreeState = this._register(new Emitter<{ workspaceId: string; status: string; message?: string }>());
	readonly onDidChangeWorktreeState: Event<{ workspaceId: string; status: string; message?: string }> = this._onDidChangeWorktreeState.event;

	/**
	 * 规范化 skills 格式：处理旧格式（对象数组）和新格式（字符串数组）的混合情况
	 * 旧格式: [{id: "configmd", name: "ConfigMD", enabled: true}, ...]
	 * 新格式: ["configmd", ...]
	 */
	private _normalizeSkillIds(skills: any[]): string[] {
		if (!skills || !Array.isArray(skills)) {
			return [];
		}
		return skills.map(s => {
			if (typeof s === 'string') {
				return s;
			} else if (s && typeof s === 'object' && 'id' in s) {
				return (s as { id: string }).id;
			}
			return '';
		}).filter(Boolean);
	}

	/** Fire the employee-selected event (called by webview controller) */
	fireSelectEmployee(employeeId: string | null): void {
		this.logService.info(`[AgentStudioService] fireSelectEmployee(employeeId=${employeeId})`);
		this._onDidSelectEmployee.fire(employeeId);
	}

	private _globalDataUri: URI | undefined;

	/**
	 * Tracks `_resolveDataUri` results we've already migrated through
	 * {@link _ensureDefaultSkillsInDir}. Keyed by `URI.toString()` so the
	 * same workspace dir is migrated at most once per session, regardless
	 * of how many `getEmployees` callers race in.
	 */
	private readonly _migratedDefaultSkillsDirs = new Set<string>();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISkillRegistry private readonly skillRegistry: ISkillRegistry,
		@IWorkspaceLifecycleService private readonly workspaceLifecycleService: IWorkspaceLifecycleService,
		@ISkillLifecycleService private readonly skillLifecycleService: ISkillLifecycleService,
		@IWorktreeService private readonly worktreeService: IWorktreeService,
	) {
		super();

		// Listen for worktree state changes and forward as workspace-level events
		this._register(this.worktreeService.onDidChangeWorktreeState((e: IWorktreeStateEvent) => {
			this._forwardWorktreeStateChange(e);
		}));
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
		this.logService.info(`[AgentStudio] getEmployees: workspaceId=${workspaceId}, dirUri=${dirUri.toString()}`);
		const employees = await this._readJsonFile<Employee>(dirUri, DATA_FILE_EMPLOYEES);
		this.logService.info(`[AgentStudio] getEmployees: found ${employees.length} employees`);
		// Lazy migration: backfill default skills (e.g. `configmd`) onto
		// existing agents that pre-date the default-skill bundling. Runs
		// at most once per dataDir per session.
		const migrated = await this._ensureDefaultSkillsInDir(dirUri, employees);
		const result = migrated || employees;
		
		// Calculate skillErrorCount and missingSkillIds for each employee
		for (const emp of result) {
			const { errorCount, missingSkillIds } = this._calculateSkillErrorInfo(emp);
			emp.skillErrorCount = errorCount;
			emp.missingSkillIds = missingSkillIds;
		}
		
		return result;
	}

	/**
	 * Calculate the number of skills that are missing from the skill registry
	 * for a given employee, and return the list of missing skill IDs.
	 */
	private _calculateSkillErrorInfo(employee: Employee): { errorCount: number; missingSkillIds: string[] } {
		const skillIds = this._normalizeSkillIds(employee.skills || []);
		if (skillIds.length === 0) { return { errorCount: 0, missingSkillIds: [] }; }
		
		const missingSkillIds: string[] = [];
		for (const skillId of skillIds) {
			const skill = this.skillRegistry.getSkill(skillId);
			if (!skill) {
				missingSkillIds.push(skillId);
			}
		}
		return { errorCount: missingSkillIds.length, missingSkillIds };
	}

	async getEmployee(id: string): Promise<Employee | undefined> {
		// Search across all workspaces
		const workspaces = await this.getWorkspaces();
		for (const ws of workspaces) {
			const dirUri = await this._getWorkspaceDataUri(ws.id);
			const employees = await this._readJsonFile<Employee>(dirUri, DATA_FILE_EMPLOYEES);
			const migrated = await this._ensureDefaultSkillsInDir(dirUri, employees);
			const list = migrated || employees;
			const found = list.find(e => e.id === id);
			if (found) { return found; }
		}
		// Try the VS Code workspace folder (may have employees without a workspace record)
		const folderUri = this._getFirstWorkspaceFolderUri();
		if (folderUri) {
			const localDirUri = URI.joinPath(folderUri, WORKSPACE_DATA_DIR);
			const localEmployees = await this._readJsonFile<Employee>(localDirUri, DATA_FILE_EMPLOYEES);
			const migrated = await this._ensureDefaultSkillsInDir(localDirUri, localEmployees);
			const list = migrated || localEmployees;
			const found = list.find(e => e.id === id);
			if (found) { return found; }
		}
		// Fallback: search global
		const globalEmployees = await this._readJsonFile<Employee>(this._getGlobalDataUri(), DATA_FILE_EMPLOYEES);
		const migrated = await this._ensureDefaultSkillsInDir(this._getGlobalDataUri(), globalEmployees);
		const list = migrated || globalEmployees;
		return list.find(e => e.id === id);
	}

	/**
	 * Backfill default skills (currently just `configmd`) onto employees that
	 * pre-date the default-skill bundling. We:
	 *
	 *   1. Skip immediately if this `dataDir` has already been migrated this
	 *      session (`_migratedDefaultSkillsDirs`) — prevents reentrancy and
	 *      avoids re-writing employees.json on every `getEmployees` call.
	 *   2. Detect employees missing any of `DEFAULT_AGENT_SKILL_IDS`. If
	 *      everything is already present, return `null` so the caller uses
	 *      the original list.
	 *   3. Otherwise: add missing default skill IDs to the employee's skills array,
	 *      persist the updated employees.json.
	 *
	 * Errors are swallowed (logged at warn level) — a failed migration
	 * must NEVER prevent the original employee list from being returned,
	 * otherwise the whole UI breaks.
	 */
	private async _ensureDefaultSkillsInDir(
		dataDirUri: URI,
		employees: Employee[],
	): Promise<Employee[] | null> {
		const key = dataDirUri.toString();
		if (this._migratedDefaultSkillsDirs.has(key)) {
			return null;
		}
		// Mark *before* doing async work so concurrent callers don't both
		// execute the migration. Worst case on failure: we skip migration
		// for this session, which is exactly what we want — re-trying every
		// getEmployees would spam the disk.
		this._migratedDefaultSkillsDirs.add(key);

		try {
			const defaults = AgentStudioService.DEFAULT_AGENT_SKILL_IDS;
			const defaultConfigMd = (): NonNullable<Employee['configMd']> => ({
				mdPath: 'config.md',
				parserPath: 'ui/parser.js',
				stylesPath: 'ui/styles.css',
				displayMode: 'side',
				defaultView: 'split',
				editable: true,
			});
			const needsMigration = employees.some(e => {
				const have = new Set(e.skills || []);
				const skillsMissing = defaults.some(id => !have.has(id));
				const configMdMissing = !e.configMd;
				return skillsMissing || configMdMissing;
			});
			if (!needsMigration) {
				return null;
			}

			const updated: Employee[] = employees.map(e => {
				const have = new Set(e.skills || []);
				const missing = defaults.filter(id => !have.has(id));
				const next: Employee = { ...e };
				if (missing.length > 0) {
					next.skills = [...(e.skills || []), ...missing];
				}
				if (!next.configMd) {
					// Backfill the ConfigMD binding so existing agents pick
					// up panel rendering on the next reload. The actual
					// `config.md` / `ui/*` files are created lazily by
					// `_ensureState` (config.md scaffold) and on the next
					// `_createAgentInstanceDir` call (ui/*). We don't write
					// them here to keep the migration cheap.
					next.configMd = defaultConfigMd();
				}
				return next;
			});

			await this._writeJsonFile(dataDirUri, DATA_FILE_EMPLOYEES, updated);
			this.logService.info(
				`[AgentStudio] Backfilled default skills [${defaults.join(', ')}] and configMd binding into ${updated.length} employee(s) in ${key}`
			);

			// Materialise the ConfigMD scaffold (config.md + ui/*.example) for
			// any agent that didn't have it before. We run this as a
			// fire-and-forget — failure on one agent shouldn't roll back
			// the migration that's already on disk.
			void this._materialiseConfigMdScaffoldsForExisting(dataDirUri, updated);

			// Notify the UI so it re-fetches the employee list with the new
			// skill entries (the previously-cached zustand state is otherwise
			// stale for the rest of the session).
			this._onDidChangeEmployees.fire();
			return updated;
		} catch (err) {
			this.logService.warn(`[AgentStudio] _ensureDefaultSkillsInDir failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}
	}

	/**
	 * For agents that pre-date the default `configMd` scaffold, ensure the
	 * supporting files (`config.md`, `ui/parser.js.example`,
	 * `ui/styles.css.example`) exist on disk. We never overwrite, so users
	 * with hand-edited configurations are safe.
	 */
	private async _materialiseConfigMdScaffoldsForExisting(
		dataDirUri: URI,
		employees: Employee[],
	): Promise<void> {
		for (const employee of employees) {
			if (!employee.agentDir) { continue; }
			try {
				const agentDirUri = URI.joinPath(dataDirUri, AGENTS_DIR, employee.agentDir);
				// Skip silently if the agent dir itself doesn't exist —
				// this can happen for orphaned employees.json entries.
				try { await this.fileService.stat(agentDirUri); } catch { continue; }
				await this._writeBootstrapFile(agentDirUri, 'config.md',
					this._getConfigMdTemplate(employee));
				const uiDirUri = URI.joinPath(agentDirUri, 'ui');
				await this._ensureDir(uiDirUri);
				await this._writeBootstrapFile(uiDirUri, 'parser.js.example',
					this._getConfigMdParserExampleTemplate());
				await this._writeBootstrapFile(uiDirUri, 'styles.css.example',
					this._getConfigMdStylesExampleTemplate());
			} catch (err) {
				this.logService.debug(`[AgentStudio] backfill ConfigMD scaffold failed for ${employee.agentDir}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	async createEmployee(data: Partial<Employee>): Promise<Employee> {
		const workspaceId = data.workspaceId;
		const dirUri = await this._resolveDataUri(workspaceId);
		this.logService.info(`[AgentStudio] createEmployee: workspaceId=${workspaceId}, dirUri=${dirUri.toString()}`);
		const filename = DATA_FILE_EMPLOYEES;

		const employees = await this._readJsonFile<Employee>(dirUri, filename);

		const now = new Date().toISOString();
		const id = this._generateId();

		// Generate a unique agent directory slug: <sanitised-name>-<shortId>
		const slug = this._generateAgentSlug(data.name || 'agent', id);

		// Extract bootstrapTemplates — used for agent dir creation but NOT persisted to employees.json
		const bootstrapTemplates = data.bootstrapTemplates;

		// Merge caller-provided skills with the default skill set every new
		// agent should ship with (e.g. `configmd` so the agent knows how to
		// drive its own ConfigMD panel from day one). Caller-supplied skills
		// take precedence on id collision so explicit overrides win.
		const mergedSkills = this._mergeWithDefaultSkills(data.skills);

		// Merge caller-provided tools with the default tool set for the role.
		// If the caller explicitly provides tools, those take priority.
		// If no tools are provided, infer from role using DEFAULT_TOOL_SETS.
		const mergedTools = this._mergeWithDefaultTools(data.tools, data.role);

		const newEmployee: Employee = {
			id,
			name: data.name || 'New Employee',
			role: data.role || 'engineer',
			email: data.email,
			avatar: data.avatar,
			presetId: data.presetId,
			model: data.model,
			customPrompt: data.customPrompt,
			skills: mergedSkills,
			tools: mergedTools,
			handOffs: (data as Record<string, unknown>).handOffs as Employee['handOffs'],
			hooks: (data as Record<string, unknown>).hooks as Employee['hooks'],
			visibility: (data as Record<string, unknown>).visibility as Employee['visibility'],
			agents: (data as Record<string, unknown>).agents as Employee['agents'],
			status: EmployeeStatus.Idle,
			agentType: (data as Record<string, unknown>).agentType as Employee['agentType'],
			teamId: data.teamId,
			workspaceId: data.workspaceId,
			position: data.position || this._computeNonOverlappingPosition(employees),
			tokenUsage: 0,
			agentDir: slug,
			temperature: (data as Record<string, unknown>).temperature as number | undefined,
			maxTokens: (data as Record<string, unknown>).maxTokens as number | undefined,
			// Every new agent ships with a ConfigMD panel scaffolded at
			// <agentDir>/config.md plus optional parser/styles overrides at
			// <agentDir>/ui/parser.js and <agentDir>/ui/styles.css. Without
			// these overrides the panel renders via the project's built-in
			// markdown parser + imgui SDK styles.
			configMd: data.configMd || {
				mdPath: 'config.md',
				parserPath: 'ui/parser.js',
				stylesPath: 'ui/styles.css',
				displayMode: 'side',
				defaultView: 'split',
				editable: true,
			},
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

		const oldName = employees[index].name;
		const oldSkills = employees[index].skills ?? [];
		const oldSkillIds = new Set(oldSkills);

		// Deduplicate skills if provided
		const sanitizedData = { ...data };
		if (sanitizedData.skills !== undefined) {
			sanitizedData.skills = [...new Set(sanitizedData.skills)];
		}

		employees[index] = {
			...employees[index],
			...sanitizedData,
			id, // ensure ID can't be changed
			updatedAt: new Date().toISOString(),
		};
		await this._writeJsonFile(dirUri, DATA_FILE_EMPLOYEES, employees);

		// ─── Skills directory sync ───────────────────────────────────────
		// If the update includes a skills change, fire skill-lifecycle events AND
		// propagate to agent.yaml so that the skill index is recorded in the
		// agent instance folder (source of truth for skill references).
		const updated = employees[index];
		if (data.skills !== undefined) {
			const newSkills = updated.skills ?? [];
			const newSkillIds = new Set(newSkills);

			// Fire lifecycle events for added / removed skills
			for (const skillId of newSkills) {
				if (!oldSkillIds.has(skillId)) {
					const skillDef = this.skillRegistry.getSkill(skillId);
					this._fireSkillLifecycle(SkillLifecycleEvent.Added, updated, skillId, skillDef?.name ?? skillId);
				}
			}
			for (const skillId of oldSkills) {
				if (!newSkillIds.has(skillId)) {
					const skillDef = this.skillRegistry.getSkill(skillId);
					this._fireSkillLifecycle(SkillLifecycleEvent.Removed, updated, skillId, skillDef?.name ?? skillId);
				}
			}

			// ─── Skills change sync to agent.yaml ───────────────────────
			// When the employee's skills change, propagate to agent.yaml
			if (updated.agentDir) {
				try {
					const agentDirUri = URI.joinPath(dirUri, AGENTS_DIR, updated.agentDir);
					const configUri = URI.joinPath(agentDirUri, AGENT_CONFIG_FILE);
					try {
						const raw = await this.fileService.readFile(configUri);
						const agentConfig = JSON.parse(raw.value.toString());
						agentConfig.skills = updated.skills; // Update skills field
						agentConfig.updatedAt = updated.updatedAt;
						await this.fileService.writeFile(
							configUri,
							VSBuffer.fromString(JSON.stringify(agentConfig, null, 2)),
						);
						this.logService.info(`[AgentStudio] updateEmployee: synced skills to agent.yaml`);
					} catch (err) {
						this.logService.debug(`[AgentStudio] updateEmployee: could not update agent.yaml skills`, err);
					}
				} catch (err) {
					this.logService.warn(`[AgentStudio] updateEmployee: failed to sync skills to agent.yaml`, err);
				}
			}
		}

		this.logService.info(`[AgentStudio] updateEmployee: wrote employees.json, firing onDidChangeEmployees`);

		// ─── Name change sync ───────────────────────────────────────────
		// When the employee's name changes, propagate to agent.yaml, IDENTITY.md,
		// and SOUL.md so that all files stay in sync.
		if (data.name !== undefined && updated.agentDir) {
			try {
				const agentDirUri = URI.joinPath(dirUri, AGENTS_DIR, updated.agentDir);

				// 1) Update agent.yaml — overwrite name and updatedAt fields
				const configUri = URI.joinPath(agentDirUri, AGENT_CONFIG_FILE);
				try {
					const raw = await this.fileService.readFile(configUri);
					const agentConfig = JSON.parse(raw.value.toString());
					agentConfig.name = updated.name;
					agentConfig.updatedAt = updated.updatedAt;
					await this.fileService.writeFile(
						configUri,
						VSBuffer.fromString(JSON.stringify(agentConfig, null, 2)),
					);
					this.logService.info(`[AgentStudio] updateEmployee: synced name to agent.yaml`);
				} catch (err) {
					this.logService.debug(`[AgentStudio] updateEmployee: could not update agent.yaml name`, err);
				}

				// 2) Update IDENTITY.md — replace the Name section
				try {
					const identityUri = URI.joinPath(agentDirUri, AGENT_IDENTITY_MD);
					const identityContent = await this.fileService.readFile(identityUri);
					let text = identityContent.value.toString();
					// Replace the line after "## Name" with the new name
					text = text.replace(/(^## Name\s*\n)(.*(?:\n|$))/m, `$1${updated.name}\n`);
					await this.fileService.writeFile(identityUri, VSBuffer.fromString(text));
					this.logService.info(`[AgentStudio] updateEmployee: synced name to IDENTITY.md`);
				} catch (err) {
					this.logService.debug(`[AgentStudio] updateEmployee: could not update IDENTITY.md name`, err);
				}

				// 3) Update SOUL.md — replace the "You are **OldName**" pattern
				try {
					const soulUri = URI.joinPath(agentDirUri, AGENT_SOUL_MD);
					const soulContent = await this.fileService.readFile(soulUri);
					let text = soulContent.value.toString();
					// The template writes: "You are **OldName**, a Role."
					text = text.replace(
						new RegExp(`You are \\*\\*${escapeRegExp(oldName)}\\*\\*`, 'g'),
						`You are **${updated.name}**`,
					);
					// Also update the title line: "# SOUL.md - Who You Are" has no name, but user may have edited it
					text = text.replace(
						new RegExp(`^(# SOUL\\.md - ).*$`, 'm'),
						`$1${updated.name}`,
					);
					await this.fileService.writeFile(soulUri, VSBuffer.fromString(text));
					this.logService.info(`[AgentStudio] updateEmployee: synced name to SOUL.md`);
				} catch (err) {
					this.logService.debug(`[AgentStudio] updateEmployee: could not update SOUL.md name`, err);
				}

				// 4) Update AGENTS.md — replace the title "# AGENTS.md - OldName"
				try {
					const agentsUri = URI.joinPath(agentDirUri, AGENT_AGENTS_MD);
					const agentsContent = await this.fileService.readFile(agentsUri);
					let text = agentsContent.value.toString();
					// The template writes: "# AGENTS.md - OldName"
					text = text.replace(
						new RegExp(`^(# AGENTS\\.md - )${escapeRegExp(oldName)}`, 'm'),
						`$1${updated.name}`,
					);
					await this.fileService.writeFile(agentsUri, VSBuffer.fromString(text));
					this.logService.info(`[AgentStudio] updateEmployee: synced name to AGENTS.md`);
				} catch (err) {
					this.logService.debug(`[AgentStudio] updateEmployee: could not update AGENTS.md name`, err);
				}
			} catch (err) {
				this.logService.warn(`[AgentStudio] updateEmployee: failed to sync name to agent files`, err);
			}
		}

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
		const workspaces = await this._readJsonFile<Workspace>(this._getGlobalDataUri(), DATA_FILE_WORKSPACES);

		// Auto-discover: if the global workspace index is empty but the current
		// VS Code folder already contains a .sarosisworkspace directory (e.g.
		// user deleted workspaces.json or switched to a fresh VS Code profile),
		// automatically create a workspace entry so that employees and layout
		// are visible without manual workspace recreation.
		if (workspaces.length === 0) {
			const folderUri = this._getFirstWorkspaceFolderUri();
			if (folderUri) {
				const localDirUri = URI.joinPath(folderUri, WORKSPACE_DATA_DIR);
				try {
					await this.fileService.stat(localDirUri);
					// Local data directory exists — auto-create a workspace entry
					const ws: Workspace = {
						id: this._generateId(),
						name: folderUri.path.split('/').pop() || 'Workspace',
						path: folderUri.fsPath,
						employees: [],
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
		return workspaces.find(w => w.id === id);
	}

	async getWorktrees(workspaceId: string): Promise<any[]> {
		const workspace = await this.getWorkspace(workspaceId);
		if (!workspace?.path) {
			return [];
		}
		return this.worktreeService.listWorktrees(workspace.path);
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

		// Sync positions to employees.json BEFORE firing the change event,
		// so that any listeners re-reading employees get the updated positions.
		try {
			await this._syncPositionsToEmployees(id, layout);
		} catch (err) {
			this.logService.debug('[AgentStudio] _syncPositionsToEmployees failed', err);
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
			id: this._generateId(),
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

	/**
	 * 检查 agent 的技能依赖是否缺失。
	 * @param employee Agent 实例
	 * @returns 缺失的技能 ID 列表
	 */
	async checkSkillDependencies(employee: Employee): Promise<string[]> {
		const missingSkills: string[] = [];
		const skillIds = this._normalizeSkillIds(employee.skills || []);

		for (const skillId of skillIds) {
			const skill = this.skillRegistry.getSkill(skillId);
			if (!skill) {
				missingSkills.push(skillId);
			}
		}

		return missingSkills;
	}

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
			skills: this._mergeWithDefaultSkills(data.employee.skills),
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
	/**
	 * Skill IDs that every freshly-created (or imported) agent should have
	 * by default. Each id MUST exist in the SkillRegistry's BUILTIN_SKILLS
	 * (or be available via another source) — otherwise we fall back to a
	 * minimal placeholder SKILL.md when materialising the skills folder.
	 *
	 * `configmd` ships with the skill prompt that teaches the agent how to
	 * read / patch / push to its own ConfigMD panel. Bundling it by default
	 * means a brand-new agent can drive its panel UI from the very first
	 * conversation without the user manually wiring anything up.
	 */
	private static readonly DEFAULT_AGENT_SKILL_IDS: readonly string[] = [
		'configmd',
	];

	/**
	 * Combine `provided` with {@link DEFAULT_AGENT_SKILL_IDS}, de-duplicating
	 * by skill id and giving caller-supplied entries priority on collision.
	 */
	private _mergeWithDefaultSkills(
		provided: readonly string[] | undefined,
	): string[] {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const id of provided || []) {
			if (!seen.has(id)) {
				seen.add(id);
				out.push(id);
			}
		}
		for (const id of AgentStudioService.DEFAULT_AGENT_SKILL_IDS) {
			if (seen.has(id)) { continue; }
			seen.add(id);
			out.push(id);
		}
		return out;
	}

	/**
	 * Merge caller-provided tools with a role-based default tool set.
	 * If the caller explicitly provides tools, those take priority (no auto-merge).
	 * If no tools are provided, infer from the agent's role category.
	 */
	private _mergeWithDefaultTools(
		provided: readonly string[] | undefined,
		role?: string,
	): string[] | undefined {
		// If caller explicitly provides tools, use them as-is
		if (provided && provided.length > 0) {
			return [...provided];
		}

		// Infer default tool set from role
		if (!role) { return undefined; }
		const roleLower = role.toLowerCase();

		// Match role keywords to tool categories
		if (/\b(engineer|developer|coder|programmer|dev)\b/i.test(roleLower)) {
			return ['vscode', 'read', 'execute', 'search'];
		}
		if (/\b(research|analyst|investigator)\b/i.test(roleLower)) {
			return ['read', 'search'];
		}
		if (/\b(writer|author|document)\b/i.test(roleLower)) {
			return ['read', 'vscode'];
		}
		if (/\b(design|ui|ux)\b/i.test(roleLower)) {
			return ['read', 'vscode'];
		}
		if (/\b(manager|planner|coordinator|pm)\b/i.test(roleLower)) {
			return ['read', 'agent'];
		}
		if (/\b(test|qa|quality)\b/i.test(roleLower)) {
			return ['vscode', 'read', 'execute', 'search'];
		}
		if (/\b(devops|deploy|infra|sre)\b/i.test(roleLower)) {
			return ['vscode', 'read', 'execute'];
		}
		if (/\b(data|scientist|ml|ai)\b/i.test(roleLower)) {
			return ['read', 'execute'];
		}

		// Default: read-only access
		return ['read'];
	}

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
				const primary = typeof employee.model === 'string' ? employee.model : (Array.isArray(employee.model) ? employee.model[0] : employee.model.primary);
				if (primary) {
					modelSection.modelId = primary;
				}
			}
			const agentConfig = {
				id: employee.id,
				name: employee.name,
				role: employee.role,
				slug: employee.agentDir,
				model: modelSection,
				customPrompt: employee.customPrompt || '',
				skills: (employee.skills || []),
				presetId: employee.presetId,
				memory: { enabled: true },
				tools: employee.tools && employee.tools.length > 0 ? employee.tools : ['read_file', 'list_dir', 'search_files', 'grep_search'],
				planning: { enabled: true },
				execution: { enabled: true, maxIterations: 10 },
				// ConfigMD panel binding. Paths are resolved relative to this
				// agent's directory. `parserPath` / `stylesPath` are optional
				// — when absent the host uses its built-in markdown renderer
				// and the bundled imgui SDK styles.  The user (or the agent
				// via the `configmd` skill) can later create
				// `<agentDir>/ui/parser.js` / `<agentDir>/ui/styles.css` and
				// update this section to point at them.
				configMd: employee.configMd || {
					mdPath: 'config.md',
					displayMode: 'side',
					defaultView: 'split',
					editable: true,
				},
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

			// 2b) ConfigMD scaffold:
			//   - config.md : starter panel with anchors so the agent and
			//                 the imgui SDK have known targets.
			await this._writeBootstrapFile(agentDirUri, 'config.md',
				this._getConfigMdTemplate(employee));

			// 3) Create sessions subdirectory for future session transcripts
			const sessionsDir = URI.joinPath(agentDirUri, 'sessions');
			await this._ensureDir(sessionsDir);

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

	/**
	 * Initial scaffold for the agent's `config.md` ConfigMD panel. We seed it
	 * with the standard anchors (`agent-state` / `agent-bind`) and a small
	 * imgui form so that:
	 *   - the panel renders something useful immediately on first open;
	 *   - the agent's `configmd` skill has known anchor names to target
	 *     when the user later asks to edit progress / status / etc.
	 *
	 * Lines beginning with `>` near the top are operator notes — they don't
	 * affect rendering but help users orient themselves the first time they
	 * open the file.
	 */
	private _getConfigMdTemplate(employee: Employee): string {
		const safeName = (employee.name || 'Agent').replace(/[<>]/g, '');
		return `# ${safeName} 工作面板

> 这是 **${safeName}** 的 ConfigMD 控制面板。该面板由
> \`<agentDir>/config.md\` 渲染而成；锚点（agent-state / agent-bind）允许
> agent 在对话中通过 \`configmd-patch\` / \`configmd-command\` 块对其进行
> 增量更新。如需自定义解析器或样式，参考同目录下
> \`ui/parser.js.example\` / \`ui/styles.css.example\`，将其复制为
> \`parser.js\` / \`styles.css\` 即生效。

---

## 状态

- 进度：<!-- agent-bind:progress -->0%<!-- /agent-bind:progress -->
- 当前任务：<!-- agent-bind:status -->待启动<!-- /agent-bind:status -->

## 任务清单

<!-- agent-state:tasks -->
- [ ] 在此处列出待办事项
<!-- /agent-state:tasks -->

## 与 Agent 对话

\`\`\`imgui
heading("快速指令")
textarea(id="ask", label="问题 / 指令", rows=3, placeholder="想让 agent 做什么？")
button(id="send", label="💬 发送", action="send_to_chat", variant="primary",
       template="{ask}")
\`\`\`

## 表单状态快照

> 当用户提交表单且按钮带 \`state="form_snapshot"\` 时，host 会把当前所有控件
> 的值以 JSON 写入下方锚点，供 agent 在后续对话中读取。

<!-- agent-state:form_snapshot -->
\`\`\`json
{ "note": "form has not been submitted yet" }
\`\`\`
<!-- /agent-state:form_snapshot -->
`;
	}

	/**
	 * Annotated example of a custom MD→HTML parser the user can drop into
	 * `<agentDir>/ui/parser.js` to override the built-in renderer. The
	 * scaffold only delegates to a simple identity transform; the comments
	 * document the contract (`parse(markdown, ctx)` → HTML string) and how
	 * to chain into the host's imgui post-processing if desired.
	 *
	 * Written to disk as `parser.js.example`. Renaming to `parser.js`
	 * activates it on the next preview render. The host watches the file
	 * via \`IFileService.watch\`, so no restart is needed.
	 */
	private _getConfigMdParserExampleTemplate(): string {
		return `// ConfigMD custom parser — example.
//
// To activate: rename this file to "parser.js" (drop the .example suffix).
// The host re-reads it on the next preview render.
//
// Contract:
//   exports.parse(markdown, ctx) -> HTML string
//
// The returned HTML is passed through a host-side sanitizer (strips
// <script>, on*= handlers, javascript:) and then through the imgui
// post-processor (which converts \`\`\`imgui code blocks into interactive
// <form> markup). You generally do NOT need to handle imgui yourself —
// just emit standard markdown HTML and let the host take care of the rest.
//
// \`ctx\` includes:
//   { employeeId: string }   // identifier of the agent owning this panel
//
// Failure mode:
//   If \`parse\` throws or returns a non-string, the host falls back to its
//   built-in markdown renderer and logs a warning. Never block on async
//   work here — the function must be synchronous.

module.exports = {
	parse(markdown, _ctx) {
		// Trivial example: pass through with a single heading wrapper.
		// Replace this with your own renderer (e.g. \`marked\`, \`markdown-it\`).
		const escape = (s) => s
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');

		const lines = markdown.split('\\n');
		const out = [];
		for (const line of lines) {
			const h1 = /^# (.+)$/.exec(line);
			if (h1) { out.push('<h1>' + escape(h1[1]) + '</h1>'); continue; }
			const h2 = /^## (.+)$/.exec(line);
			if (h2) { out.push('<h2>' + escape(h2[1]) + '</h2>'); continue; }
			if (!line.trim()) { continue; }
			out.push('<p>' + escape(line) + '</p>');
		}
		return out.join('\\n');
	},
};
`;
	}

	/**
	 * Copy of the host-bundled imgui SDK styles, dropped under
	 * `<agentDir>/ui/styles.css.example` for users who want to tweak the
	 * panel's appearance without forking the whole project. Renaming to
	 * `styles.css` activates the override (host appends it after its own
	 * built-in styles, so user rules win on specificity ties).
	 *
	 * We embed the live \`IMGUI_SDK_STYLES\` constant so this file always
	 * reflects what the host is currently shipping — no risk of drift.
	 */
	private _getConfigMdStylesExampleTemplate(): string {
		return `/*
 * ConfigMD custom stylesheet — example.
 *
 * To activate: rename this file to "styles.css" (drop the .example suffix).
 * The host injects it INTO the standalone preview document AFTER its own
 * built-in imgui SDK styles, so any rule you redefine here will override
 * the default thanks to source-order specificity.
 *
 * The block below is the verbatim copy of the host's bundled imgui SDK
 * styles at the time this agent was created. Tweak freely; you can also
 * delete most of it and only keep the rules you want to override.
 */
${IMGUI_SDK_STYLES}
`;
	}

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

	async getEffectiveWorktreePath(employeeId: string): Promise<string | undefined> {
		const employee = await this.getEmployee(employeeId);
		if (!employee) {
			return undefined;
		}

		// Employee-level worktree takes priority
		if (employee.worktreePath) {
			return employee.worktreePath;
		}

		// Fall back to workspace-level worktree
		if (employee.workspaceId) {
			const workspace = await this.getWorkspace(employee.workspaceId);
			return workspace?.worktreePath;
		}

		return undefined;
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

/** Escape special regex characters in a string for use in RegExp constructor. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
