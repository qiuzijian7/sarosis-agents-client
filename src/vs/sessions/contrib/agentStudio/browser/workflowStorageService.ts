/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// ------------------------------------------------------------------------------------------------
// workflowStorageService.ts - 工作流文件存储服务实现
// ------------------------------------------------------------------------------------------------
//
// 将工作流以 JSON 文件形式持久化到当前工作区的
// `.sarosworkspace/workflows/{id}.json`。
//
// 目录定位:
//   workspace.path → home/元数据目录 → 拼接 `.sarosworkspace/workflows/`
//   (workspace.path 通过 IAgentStudioService.getWorkspace(activeId) 获取)

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';

import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import {
	IWorkflowStorageService,
	type IStoredWorkflow,
	type IWorkflowFileEntry,
	type WorkflowResourceSection,
	WorkflowResourceDir,
} from '../common/workflowStorage.js';
import { IWorkflowVersionService } from '../common/workflowVersionTypes.js';
import {
	type IWorkflowSessionMeta,
	buildWorkflowSession,
	pickSessionForChat,
	renameWorkflowSession,
	touchWorkflowSession,
} from '../common/workflowSessions.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { SarosPath, resolveSarosPath } from '../common/sarosPaths.js';
import * as path from '../../../../base/common/path.js';
// 本地文件导入（2026-09-11）：纯函数解析/校验 + id 冲突消解（见 importWorkflowJson）。
import { parseWorkflowImportFile, resolveImportSlug } from './workflow/workflowFileImport.js';

const WORKFLOW_FILE = 'workflow.json';
const DEFAULT_WORKFLOW_PRESET_ID = 'workflow-agent';

/**
 * 校验资源子目录内的相对路径，防目录穿越。
 * 规则：非空、不含 `..` 段、不是绝对路径（win 盘符 / 反斜杠开头）、不含 NUL。
 * 返回规范化的 `/` 分隔相对路径；非法则抛错。
 */
export function sanitizeRelPath(relPath: string): string {
	if (!relPath || relPath.trim() === '') {
		throw new Error('相对路径不能为空');
	}
	if (relPath.includes('\0')) {
		throw new Error('相对路径包含非法字符');
	}
	// 统一分隔符
	const normalized = relPath.replace(/\\/g, '/');
	// 绝对路径（unix `/` 开头 或 win `C:/` 盘符）
	if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
		throw new Error(`相对路径不能是绝对路径: ${relPath}`);
	}
	// 目录穿越段
	const segments = normalized.split('/');
	if (segments.some(s => s === '..' || s === '')) {
		throw new Error(`相对路径含非法段: ${relPath}`);
	}
	return segments.join('/');
}

export class WorkflowStorageService extends Disposable implements IWorkflowStorageService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeWorkflows = this._register(new Emitter<void>());
	readonly onDidChangeWorkflows: Event<void> = this._onDidChangeWorkflows.event;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IFileService private readonly _fileService: IFileService,
		@IAgentStudioService private readonly _studioService: IAgentStudioService,
		@INativeEnvironmentService private readonly _envService: INativeEnvironmentService,
		@IWorkflowVersionService private readonly _versionService: IWorkflowVersionService,
	) {
		super();
	}

	// ─── Directory resolution ────────────────────────────────────────────

	/**
	 * 解析用户级的 `~/.vssaros/workflows/` 目录 URI。
	 * 所有工作流全局存储，不再按工作区隔离。
	 */
	private async _resolveWorkflowsDir(_workspaceId?: string): Promise<URI | undefined> {
		try {
			const dir = resolveSarosPath(URI.file(this._envService.userDataPath), SarosPath.workflows);
			return dir;
		} catch (err) {
			this._logService.error('[WorkflowStorage] Failed to resolve user workflows dir', err);
			return undefined;
		}
	}

	// ── 工作流 Session（2026-09-11 用户需求）────────────────────────────────
	//  每个工作流可有多个 session，隔离不同聊天会话生成的内容；与聊天 session 绑定
	//  （同一聊天 session 复用同一工作流 session）。索引存 sessions.json，产物目录
	//  为 `{workflowsDir}/{workflowId}/sessions/{sessionId}/`。

	/** session 索引文件：`{workflowsDir}/{workflowId}/sessions.json`。 */
	private _sessionsIndexUri(workflowsDir: URI, workflowId: string): URI {
		return URI.joinPath(workflowsDir, workflowId, 'sessions.json');
	}

	async listWorkflowSessions(workflowId: string): Promise<IWorkflowSessionMeta[]> {
		if (!workflowId) { return []; }
		const dir = await this._resolveWorkflowsDir();
		if (!dir) { return []; }
		try {
			const content = await this._fileService.readFile(this._sessionsIndexUri(dir, workflowId));
			const parsed = JSON.parse(content.value.toString());
			return Array.isArray(parsed) ? (parsed as IWorkflowSessionMeta[]) : [];
		} catch {
			return []; // 无索引文件 = 尚未创建任何 session
		}
	}

	private async _writeWorkflowSessions(workflowId: string, sessions: IWorkflowSessionMeta[]): Promise<void> {
		const dir = await this._resolveWorkflowsDir();
		if (!dir) { return; }
		await this._ensureDir(URI.joinPath(dir, workflowId));
		await this._fileService.writeFile(
			this._sessionsIndexUri(dir, workflowId),
			VSBuffer.fromString(JSON.stringify(sessions, null, 2)),
		);
	}

	async createWorkflowSession(workflowId: string, name?: string, chatSessionId?: string): Promise<IWorkflowSessionMeta> {
		const existing = await this.listWorkflowSessions(workflowId);
		const meta = buildWorkflowSession({ workflowId, name, chatSessionId, existingCount: existing.length });
		await this._writeWorkflowSessions(workflowId, [...existing, meta]);
		const sessionDir = await this.getWorkflowSessionDir(workflowId, meta.id);
		if (sessionDir) { await this._ensureDir(sessionDir); }
		this._logService.info(
			`[WorkflowStorage] session created: wf=${workflowId} sid=${meta.id} ` +
			`chat=${chatSessionId ?? '-'} name=${meta.name}`,
		);
		return meta;
	}

	async getOrCreateWorkflowSession(workflowId: string, chatSessionId?: string): Promise<IWorkflowSessionMeta> {
		const sessions = await this.listWorkflowSessions(workflowId);
		const hit = pickSessionForChat(sessions, chatSessionId);
		if (hit) {
			const touched = touchWorkflowSession(hit);
			await this._writeWorkflowSessions(workflowId, sessions.map(s => (s.id === hit.id ? touched : s)));
			return touched;
		}
		// 未绑定该聊天 session → 新建（隔离）
		return this.createWorkflowSession(workflowId, undefined, chatSessionId);
	}

	async touchWorkflowSession(workflowId: string, sessionId: string): Promise<void> {
		const sessions = await this.listWorkflowSessions(workflowId);
		let changed = false;
		const next = sessions.map(s => {
			if (s.id !== sessionId) { return s; }
			changed = true;
			return touchWorkflowSession(s);
		});
		if (changed) { await this._writeWorkflowSessions(workflowId, next); }
	}

	async getWorkflowSessionDir(workflowId: string, sessionId: string): Promise<URI | undefined> {
		const dir = await this._resolveWorkflowsDir();
		if (!dir || !workflowId || !sessionId) { return undefined; }
		return URI.joinPath(dir, workflowId, 'sessions', sessionId);
	}

	/**
	 * 重命名 session（2026-09-11 用户需求）：仅改显示名，不动 id（产物隔离 key 前缀）
	 * 也不动 updatedAt（列表顺序，见 renameWorkflowSession 纯函数注释）。
	 * @returns 是否实际写入（名字为空或未变化时 false）
	 */
	async renameWorkflowSession(workflowId: string, sessionId: string, name: string): Promise<boolean> {
		if (!workflowId || !sessionId || !(name ?? '').trim()) { return false; }
		const sessions = await this.listWorkflowSessions(workflowId);
		let changed = false;
		const next = sessions.map(s => {
			if (s.id !== sessionId) { return s; }
			const renamed = renameWorkflowSession(s, name);
			if (renamed !== s) { changed = true; }
			return renamed;
		});
		if (!changed) { return false; }
		await this._writeWorkflowSessions(workflowId, next);
		this._logService.info(
			`[WorkflowStorage] session renamed: wf=${workflowId} sid=${sessionId} name=${name.trim()}`,
		);
		return true;
	}

	private async _ensureDir(dirUri: URI): Promise<void> {
		try {
			await this._fileService.stat(dirUri);
		} catch {
			try {
				await this._fileService.createFolder(dirUri);
			} catch (createErr) {
				this._logService.error('[WorkflowStorage] createFolder failed', dirUri.toString(), createErr);
				throw createErr;
			}
		}
	}

	// ─── ID generation ───────────────────────────────────────────────────

	/**
	 * 从名称生成工作流 ID，格式：wf-{slug}
	 * 示例："My Workflow" → "wf-my-workflow"
	 */
	private _generateId(name: string): string {
		const slug = name
			.toLowerCase()
			.replace(/[^a-z0-9\s_-]/g, '')
			.replace(/[\s_]+/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 40);
		return `wf-${slug || 'workflow'}`;
	}

	// ─── CRUD ────────────────────────────────────────────────────────────

	async listWorkflows(workspaceId?: string): Promise<IStoredWorkflow[]> {
		const workflows: IStoredWorkflow[] = [];

		// 用户/商城工作流（工作区 .sarosworkspace/workflows/）
		const dir = await this._resolveWorkflowsDir(workspaceId);
		if (dir) {
			try {
				const stat = await this._fileService.resolve(dir);
				if (stat.children) {
					for (const child of stat.children) {
						if (!child.isDirectory) { continue; }
						try {
							const workflowFile = URI.joinPath(child.resource, WORKFLOW_FILE);
							const content = await this._fileService.readFile(workflowFile);
							const wf = JSON.parse(content.value.toString()) as IStoredWorkflow;
							if (wf && wf.id) {
								workflows.push(wf);
							}
						} catch (parseErr) {
							this._logService.warn('[WorkflowStorage] Failed to parse workflow file in', child.resource.toString(), parseErr);
						}
					}
				}
			} catch { /* 目录不存在 */ }
		}

		// 按更新时间倒序
		workflows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
		return workflows;
	}

	async getWorkflow(id: string, workspaceId?: string): Promise<IStoredWorkflow | undefined> {
		const dir = await this._resolveWorkflowsDir(workspaceId);
		if (!dir) { return undefined; }
		// 目录式存储：{workflowsDir}/{id}/workflow.json
		const workflowDir = URI.joinPath(dir, id);
		const uri = URI.joinPath(workflowDir, WORKFLOW_FILE);
		try {
			const content = await this._fileService.readFile(uri);
			return JSON.parse(content.value.toString()) as IStoredWorkflow;
		} catch {
			return undefined;
		}
	}

	async createWorkflow(
		data: {
			name: string;
			description?: string;
			presetId?: string;
			agentId?: string;
			steps?: IStoredWorkflow['steps'];
			slug?: string;
		},
		workspaceId?: string,
	): Promise<IStoredWorkflow> {
		const dir = await this._resolveWorkflowsDir(workspaceId);
		if (!dir) {
			throw new Error('Cannot resolve workflows directory. Please ensure your home directory is accessible.');
		}
		await this._ensureDir(dir);

		const now = Date.now();
		const id = data.slug
			? (() => {
				const sanitized = data.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
				return sanitized ? `wf-${sanitized}` : this._generateId(data.name || 'workflow');
			})()
			: this._generateId(data.name || 'workflow');
		const activeWsId = workspaceId ?? this._studioService.getActiveWorkspaceId();
		const workflow: IStoredWorkflow = {
			id,
			name: data.name,
			description: data.description ?? '',
			steps: data.steps ?? [],
			isActive: false,
			createdAt: now,
			updatedAt: now,
			presetId: data.presetId ?? DEFAULT_WORKFLOW_PRESET_ID,
			agentId: data.agentId,
			workspaceId: activeWsId,
		};

		// 目录式存储：{workflowsDir}/{id}/workflow.json + scripts/ + bin/
		const workflowDir = URI.joinPath(dir, id);
		await this._ensureDir(workflowDir);
		// ★ 预建 scripts/ 和 bin/ 资源子目录：工作流目录支持自带依赖脚本与配置。
		await this._ensureDir(URI.joinPath(workflowDir, WorkflowResourceDir.scripts));
		await this._ensureDir(URI.joinPath(workflowDir, WorkflowResourceDir.bin));
		const uri = URI.joinPath(workflowDir, WORKFLOW_FILE);
		await this._fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(workflow, null, 2)));
		this._logService.info('[WorkflowStorage] Created workflow', id, 'at', uri.toString());
		// 版本管理：新建 workflow 后异步初始化 git repo + 初始 commit（fire-and-forget）
		this._versionService.init(id).catch(err =>
			this._logService.warn(`[WorkflowStorage] version init failed for ${id}:`, err));
		this._onDidChangeWorkflows.fire();
		return workflow;
	}

	/**
	 * 从工作流 JSON 文本导入（本地文件导入，2026-09-11）。
	 * 契约详见 `IWorkflowStorageService.importWorkflowJson`。
	 *
	 * 流程：纯函数解析/校验 → 读现有 id 集合 → 消解冲突得 slug → createWorkflow
	 * → 补写 nodes/connections/版本元数据 → 返回（非致命问题走 warnings）。
	 */
	async importWorkflowJson(text: string): Promise<{ workflow: IStoredWorkflow; warnings: string[] }> {
		const { payload, warnings } = parseWorkflowImportFile(text);
		const existing = await this.listWorkflows();
		const slug = resolveImportSlug(payload.sourceId, payload.name, new Set(existing.map(w => w.id)));
		// 源 id 被消解（冲突）→ 明确告知，避免「怎么多了一份、id 还变了」的困惑。
		if (payload.sourceId && `wf-${slug}` !== payload.sourceId) {
			warnings.push(`源 id「${payload.sourceId}」已存在，导入为新工作流「wf-${slug}」（未覆盖原工作流）`);
		}
		let workflow = await this.createWorkflow({
			name: payload.name,
			description: payload.description,
			...(payload.presetId ? { presetId: payload.presetId } : {}),
			...(payload.agentId ? { agentId: payload.agentId } : {}),
			steps: payload.steps as IStoredWorkflow['steps'],
			slug,
		});
		// `createWorkflow` 的签名面向「新建空工作流」，不含画布数据 → 这里补写。
		const patch: Partial<IStoredWorkflow> = {};
		if (payload.nodes) { patch.nodes = payload.nodes as IStoredWorkflow['nodes']; }
		if (payload.connections) { patch.connections = payload.connections as IStoredWorkflow['connections']; }
		// 2026-09-11：breakpoints / author / visibility 此前**未随文件迁移** ——
		// 导出侧已带上、解析侧已识别，此处却漏写 patch → 「导出 → 导入」静默丢
		// 断点与发布元信息（round-trip 不闭环）。凡解析载荷里的可持久化字段，
		// 这里必须一一落地。
		if (payload.breakpoints && payload.breakpoints.length > 0) { patch.breakpoints = payload.breakpoints; }
		if (payload.version) { patch.version = payload.version; }
		if (payload.category) { patch.category = payload.category; }
		if (payload.author) { patch.author = payload.author; }
		if (payload.visibility) { patch.visibility = payload.visibility; }
		if (payload.tags && payload.tags.length > 0) { patch.tags = payload.tags; }
		if (payload.useGuide) { patch.useGuide = payload.useGuide; }
		if (Object.keys(patch).length > 0) {
			workflow = await this.updateWorkflow(workflow.id, patch);
		}
		this._logService.info(
			`[WorkflowStorage] Imported workflow from file: ${workflow.id} ` +
			`(nodes=${payload.nodes?.length ?? 0}, connections=${payload.connections?.length ?? 0})`,
		);
		return { workflow, warnings };
	}

	async updateWorkflow(id: string, patch: Partial<IStoredWorkflow>, workspaceId?: string, opts?: { autoCommit?: boolean }): Promise<IStoredWorkflow> {
		const dir = await this._resolveWorkflowsDir(workspaceId);
		if (!dir) {
			throw new Error('No active workspace — cannot update workflow.');
		}
		const existing = await this.getWorkflow(id, workspaceId);
		if (!existing) {
			throw new Error(`Workflow ${id} not found.`);
		}
		const updated: IStoredWorkflow = {
			...existing,
			...patch,
			id: existing.id, // id 不可变
			updatedAt: Date.now(),
		};
		// 目录式存储：{workflowsDir}/{id}/workflow.json
		const workflowDir = URI.joinPath(dir, id);
		await this._ensureDir(workflowDir);
		const uri = URI.joinPath(workflowDir, WORKFLOW_FILE);
		await this._fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(updated, null, 2)));
		// 版本管理：每次保存后异步 auto-commit（fire-and-forget，不阻塞 UI 保存）。
		// ★ auto-save 传 opts.autoCommit=false 跳过 —— 否则 updatedAt 时间戳 + 节点
		// 微调导致内容每次变，git 版本爆炸（历史里全是无意义的浮点坐标 commit）。
		if (opts?.autoCommit !== false) {
			this._versionService.autoCommit(id).catch(err =>
				this._logService.warn(`[WorkflowStorage] autoCommit failed for ${id}:`, err));
		}
		this._onDidChangeWorkflows.fire();
		return updated;
	}

	async deleteWorkflow(id: string, workspaceId?: string): Promise<void> {
		const dir = await this._resolveWorkflowsDir(workspaceId);
		if (!dir) { return; }
		// 目录式存储：删除整个 {id}/ 目录
		const workflowDir = URI.joinPath(dir, id);
		try {
			await this._fileService.del(workflowDir, { recursive: true });
			this._onDidChangeWorkflows.fire();
		} catch (err) {
			this._logService.warn('[WorkflowStorage] delete failed', workflowDir.toString(), err);
		}
	}

	// ─── 工作流资源子目录（scripts / bin）─────────────────────────────────────

	/** 解析 `{workflowsDir}/{id}/{section}/` 资源子目录 URI；不存在返回 undefined。 */
	async getWorkflowResourceDir(id: string, section: WorkflowResourceSection): Promise<URI | undefined> {
		const dir = await this._resolveWorkflowsDir();
		if (!dir) { return undefined; }
		const resourceDir = URI.joinPath(dir, id, WorkflowResourceDir[section]);
		try {
			const stat = await this._fileService.resolve(resourceDir);
			if (stat && stat.isDirectory) { return resourceDir; }
		} catch { /* 目录不存在 */ }
		return undefined;
	}

	/** 解析并确保资源子目录存在（不存在则创建）。 */
	private async _ensureResourceDir(id: string, section: WorkflowResourceSection): Promise<URI> {
		const dir = await this._resolveWorkflowsDir();
		if (!dir) {
			throw new Error('Cannot resolve workflows directory.');
		}
		const workflowDir = URI.joinPath(dir, id);
		await this._ensureDir(workflowDir);
		const resourceDir = URI.joinPath(workflowDir, WorkflowResourceDir[section]);
		await this._ensureDir(resourceDir);
		return resourceDir;
	}

	async listWorkflowFiles(id: string, section: WorkflowResourceSection): Promise<IWorkflowFileEntry[]> {
		const resourceDir = await this.getWorkflowResourceDir(id, section);
		if (!resourceDir) { return []; }
		try {
			const stat = await this._fileService.resolve(resourceDir);
			if (!stat.children) { return []; }
			const entries: IWorkflowFileEntry[] = [];
			for (const child of stat.children) {
				entries.push({
					name: child.name,
					size: child.isDirectory ? 0 : (child.size ?? 0),
					mtime: child.mtime ?? 0,
					isDirectory: child.isDirectory,
				});
			}
			// 稳定排序：目录在前，文件按名称
			entries.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
			return entries;
		} catch (err) {
			this._logService.warn('[WorkflowStorage] listWorkflowFiles failed', resourceDir.toString(), err);
			return [];
		}
	}

	async readWorkflowFile(id: string, section: WorkflowResourceSection, relPath: string): Promise<string | undefined> {
		const safe = sanitizeRelPath(relPath);
		const resourceDir = await this.getWorkflowResourceDir(id, section);
		if (!resourceDir) { return undefined; }
		const fileUri = URI.joinPath(resourceDir, safe);
		try {
			const content = await this._fileService.readFile(fileUri);
			return content.value.toString();
		} catch {
			return undefined;
		}
	}

	async writeWorkflowFile(id: string, section: WorkflowResourceSection, relPath: string, content: string): Promise<void> {
		const safe = sanitizeRelPath(relPath);
		const resourceDir = await this._ensureResourceDir(id, section);
		const fileUri = URI.joinPath(resourceDir, safe);
		// 若 relPath 含子目录（如 `sub/x.py`），确保父目录存在
		const parentPath = path.dirname(fileUri.fsPath);
		if (parentPath !== resourceDir.fsPath) {
			await this._ensureDir(URI.file(parentPath));
		}
		await this._fileService.writeFile(fileUri, VSBuffer.fromString(content));
		this._logService.info('[WorkflowStorage] writeWorkflowFile', fileUri.toString());
	}

	async deleteWorkflowFile(id: string, section: WorkflowResourceSection, relPath: string): Promise<void> {
		const safe = sanitizeRelPath(relPath);
		const resourceDir = await this.getWorkflowResourceDir(id, section);
		if (!resourceDir) { return; }
		const fileUri = URI.joinPath(resourceDir, safe);
		try {
			await this._fileService.del(fileUri);
			this._logService.info('[WorkflowStorage] deleteWorkflowFile', fileUri.toString());
		} catch (err) {
			this._logService.warn('[WorkflowStorage] deleteWorkflowFile failed', fileUri.toString(), err);
		}
	}

	/**
	 * v19: Persist workflow display order.
	 * Stores ordered IDs in `.sarosworkspace/workflows-order.json`.
	 */
	async reorderWorkflows(orderedIds: string[], workspaceId?: string): Promise<void> {
		const dir = await this._resolveWorkflowsDir(workspaceId);
		if (!dir) { return; }
		// Write order file in parent directory (.sarosworkspace/)
		const orderUri = URI.joinPath(dir, '..', 'workflows-order.json');
		const data = JSON.stringify({ order: orderedIds, updatedAt: Date.now() }, null, 2);
		await this._fileService.writeFile(orderUri, VSBuffer.fromString(data));
		this._logService.info(`[WorkflowStorage] Reorder saved: ${orderedIds.length} workflows`);
	}
}
