/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService, GroupsOrder } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { SIDE_GROUP } from '../../../../workbench/services/editor/common/editorService.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { HtmlPreviewEditorInput } from './htmlPreviewEditorInput.js';
import { type IChatPanel } from '../../../browser/agentChat/iChatPanel.js';

/** Host bridge so the controller can reach the live chat panel without holding the pane. */
export interface IChatEditorIntegrationHost {
	getChatPanel(): IChatPanel | null;
}

/**
 * ChatEditorIntegration — extracts the file / code / terminal integration helpers
 * from NativeChatEditorPane (~330 lines): apply-code diff, open file in editor,
 * workspace file search, add file/selection to chat context, run in terminal.
 * These are callback-driven features wired through AgentChatPanel callbacks.
 */
export class ChatEditorIntegration extends Disposable {

	constructor(
		private readonly _logService: ILogService,
		private readonly _fileService: IFileService,
		private readonly _commandService: ICommandService,
		private readonly _editorService: IEditorService,
		private readonly _editorGroupsService: IEditorGroupsService,
		private readonly _modelService: IModelService,
		private readonly _workspaceContextService: IWorkspaceContextService,
		private readonly _host: unknown,
	) {
		super();
	}

	/** Typed host accessor (set by the pane). */
	private get _panelHost(): IChatEditorIntegrationHost {
		return this._host as IChatEditorIntegrationHost;
	}

	// ─── Apply code (diff editor / HTML preview) ──────────────────────────

	/**
	 * P0-3: Apply code — open a diff editor (original vs new) for existing files,
	 * or write + preview directly for HTML files. Saving the right editor = accept.
	 */
	async handleApplyCode(code: string, _language: string, filePath?: string): Promise<void> {
		this._logService.info(`[ChatEditorIntegration] handleApplyCode — lang="${_language}", filePath=${filePath ?? 'undefined'}, codeLen=${code.length}`);
		try {
			if (filePath) {
				let resource: URI;
				if (this._isAbsolutePath(filePath)) {
					resource = URI.file(filePath);
				} else {
					const folders = this._workspaceContextService.getWorkspace().folders;
					if (folders.length === 0) {
						await this._editorService.openEditor({ resource: undefined, contents: code, options: { pinned: true } });
						return;
					}
					resource = URI.joinPath(folders[0].uri, filePath);
				}

				// HTML file: write + open via HtmlPreviewEditorInput (user request)
				if (this._isHtmlFile(filePath)) {
					this._logService.info(`[ChatEditorIntegration] HTML file detected — writing + opening via HtmlPreviewEditorInput`, filePath);
					await this._fileService.writeFile(resource, VSBuffer.fromString(code));
					const groups = this._editorGroupsService.getGroups(GroupsOrder.GRID_APPEARANCE);
					const targetGroup = groups[0];
					const fileName = filePath.split(/[\\/]/).pop() || filePath;
					const previewInput = new HtmlPreviewEditorInput(resource, `预览：${fileName}`);
					try {
						const pane = await this._editorService.openEditor(previewInput, { pinned: true }, targetGroup);
						this._logService.info(`[ChatEditorIntegration] openEditor returned, pane=${pane?.getId() ?? 'undefined'}`);
					} catch (err) {
						this._logService.error(`[ChatEditorIntegration] openEditor threw`, err);
						throw err;
					}
					return;
				}

				// Read original content
				let originalContent: string;
				try {
					const fc = await this._fileService.readFile(resource);
					originalContent = fc.value.toString();
				} catch {
					await this._fileService.writeFile(resource, VSBuffer.fromString(code));
					await this.openFileInEditor(filePath);
					return;
				}
				if (originalContent === code) {
					await this.openFileInEditor(filePath);
					return;
				}
				// P0-3: open diff editor
				const fileName = filePath.split(/[\\/]/).pop() || filePath;
				const existingModel = this._modelService.getModel(resource);
				const langId = _language || existingModel?.getLanguageId() || undefined;
				await this._editorService.openEditor({
					original: { resource },
					modified: { resource: undefined, contents: code, languageId: langId },
					label: `Apply: ${fileName}`,
					description: '保存右侧编辑器以接受变更',
					options: { pinned: true },
				} as any);
			} else {
				// No filePath: chat code-block Apply (code + lang only).
				if (this._isHtmlLang(_language)) {
					const virtualUri = URI.from({ scheme: 'saros-html-preview', path: `/chat-apply/${Date.now()}.html` });
					const previewInput = new HtmlPreviewEditorInput(virtualUri, '预览：Apply HTML', undefined, undefined, undefined, undefined, code);
					const groups = this._editorGroupsService.getGroups(GroupsOrder.GRID_APPEARANCE);
					const targetGroup = groups[0];
					this._logService.info(`[ChatEditorIntegration] HTML block Apply (no file) — opening in-memory HtmlPreviewEditorInput`);
					await this._editorService.openEditor(previewInput, { pinned: true }, targetGroup);
					return;
				}
				await this._editorService.openEditor({
					resource: undefined,
					contents: code,
					options: { pinned: true },
				});
			}
		} catch (err) {
			this._logService.error('[ChatEditorIntegration] handleApplyCode failed:', err);
			if (filePath) {
				try {
					const resource = URI.file(filePath);
					await this._fileService.writeFile(resource, VSBuffer.fromString(code));
					await this.openFileInEditor(filePath);
				} catch { /* ignore */ }
			}
		}
	}

	private _isHtmlFile(filePath: string): boolean {
		return /\.(html?|xhtml)$/i.test(filePath);
	}

	private _isHtmlLang(language: string): boolean {
		return /^(html?|x?html)$/i.test((language || '').trim());
	}

	async openFileInEditor(filePath: string, lineNumber?: number): Promise<void> {
		try {
			// 防御性归一化：剥离 grep 风格尾缀 `:LINE` / `:LINE:CONTENT`
			// （来自 search 工具结果或 markdown 文件链接 _FILE_PATH_RE 捕获的 `path:LINE`）。
			// 注意 Windows 盘符 `X:\` 的冒号不是行号分隔符——正则锚定到文件扩展名，
			// 因此只剥离扩展名之后的 `:数字`，绝不会误伤盘符。
			const norm = this._normalizeOpenPath(filePath);
			if (norm.line != null && lineNumber == null) {
				lineNumber = norm.line;
			}
			filePath = norm.path;

			let absPath = filePath;
			if (!this._isAbsolutePath(absPath)) {
				const folders = this._workspaceContextService.getWorkspace().folders;
				for (const folder of folders) {
					const candidate = URI.joinPath(folder.uri, absPath);
					try {
						const stat = await this._fileService.stat(candidate);
						if (stat) {
							absPath = candidate.fsPath;
							break;
						}
					} catch {
						// File doesn't exist in this folder, try next
					}
				}
			}

			const resource = URI.file(absPath);
			const groups = this._editorGroupsService.getGroups(GroupsOrder.CREATION_TIME);
			const targetGroup = groups.length <= 1 ? SIDE_GROUP : groups[0];

			const selection = lineNumber && lineNumber > 0
				? { startLineNumber: lineNumber, startColumn: 1, endLineNumber: lineNumber, endColumn: 1 }
				: undefined;

			await this._editorService.openEditor({
				resource,
				options: {
					pinned: false,
					...(selection ? { selection } : {}),
				},
			}, targetGroup);
		} catch (err) {
			this._logService.error('[ChatEditorIntegration] _openFileInEditor failed:', err);
		}
	}

	private _isAbsolutePath(p: string): boolean {
		if (!p) { return false; }
		if (p.startsWith('/') || p.startsWith('\\\\')) { return true; }
		return /^[a-zA-Z]:[\\/]/.test(p);
	}

	/**
	 * 将可能携带 grep 尾缀的文件引用归一化为「纯路径 + 行号」。
	 * - `f:\...\file.html:69:     <li>...` → { path: 'f:\...\file.html', line: 69 }
	 * - `foo.ts:69` → { path: 'foo.ts', line: 69 }
	 * - `foo.ts`   → { path: 'foo.ts' }
	 * 仅当扩展名后紧接 `:数字`/`#数字` 才视为行号，避免误判 Windows 盘符 `X:\`。
	 */
	private _normalizeOpenPath(raw: string): { path: string; line?: number } {
		if (!raw) { return { path: raw }; }
		const m = /^(.*?\.(?:tsx?|jsx?|mjs|cjs|py[3w]?|rb|php|go|rs|java|kt|swift|scala|cs|cpp|cxx|h|hpp|vue|svelte|astro|prisma|md|mdx|css|scss|less|html?|json|ya?ml|toml|xml|svg|png|jpe?g|gif|webp|bmp|ico|sh|bash|zsh|fish|ps1|bat|cmd|sql|graphql|env|config|ini|cfg|lock|txt|log|tf|tfvars|proto|sqlx|dart|lua|r|jl|nim|zig))(?:[:#](\d+))?/i.exec(raw);
		if (m && m[2]) {
			return { path: m[1], line: parseInt(m[2], 10) };
		}
		return { path: raw };
	}

	// ─── Workspace file search ────────────────────────────────────────────

	/**
	 * P0-2: search workspace files — recursively traverse workspace folders,
	 * fuzzy-match by file name. Skips node_modules/.git/dist/out etc.,
	 * limited to depth 4 + max 50 results.
	 */
	async searchWorkspaceFiles(query: string): Promise<Array<{ path: string; name: string }>> {
		const results: Array<{ path: string; name: string }> = [];
		const q = query.toLowerCase();
		const MAX_RESULTS = 50;
		const MAX_DEPTH = 4;
		const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.codebuddy', '__pycache__', '.sarosworkspace']);

		const searchRecursive = async (uri: URI, depth: number): Promise<void> => {
			if (depth > MAX_DEPTH || results.length >= MAX_RESULTS) { return; }
			try {
				const entry = await this._fileService.resolve(uri, { resolveMetadata: false });
				if (!entry.children) { return; }
				for (const child of entry.children) {
					if (results.length >= MAX_RESULTS) { return; }
					if (child.isDirectory) {
						if (SKIP_DIRS.has(child.name) || child.name.startsWith('.')) { continue; }
						await searchRecursive(child.resource, depth + 1);
					} else {
						if (child.name.toLowerCase().includes(q)) {
							const wsFolder = this._workspaceContextService.getWorkspace().folders[0];
							const relPath = child.resource.fsPath.replace(wsFolder?.uri.fsPath ?? '', '').replace(/^[\\/]/, '');
							results.push({ name: child.name, path: relPath || child.name });
						}
					}
				}
			} catch { /* ignore permission errors */ }
		};

		const workspace = this._workspaceContextService.getWorkspace();
		for (const folder of workspace.folders) {
			await searchRecursive(folder.uri, 0);
		}
		return results;
	}

	// ─── Add file / selection to chat context ─────────────────────────────

	/** P0-2: read a file and add it as a chat context attachment. */
	async addFileContextToChat(filePath: string): Promise<void> {
		try {
			let uri: URI;
			if (this._isAbsolutePath(filePath)) {
				uri = URI.file(filePath);
			} else {
				const folders = this._workspaceContextService.getWorkspace().folders;
				if (folders.length === 0) { return; }
				uri = URI.joinPath(folders[0].uri, filePath);
			}
			const content = await this._fileService.readFile(uri);
			const text = content.value.toString();
			const maxSize = 100 * 1024; // 100KB
			const truncated = text.length > maxSize ? text.slice(0, maxSize) + '\n... (truncated)' : text;
			this._panelHost.getChatPanel()?.addFileContext(filePath, truncated);
		} catch (err) {
			this._logService.info('[ChatEditorIntegration] addFileContextToChat: failed to read file:', filePath, err);
		}
	}

	/** P1-1: run code in the integrated terminal. */
	async runInTerminal(code: string): Promise<void> {
		try {
			await this._commandService.executeCommand('workbench.action.terminal.focus');
			await this._commandService.executeCommand('workbench.action.terminal.sendSequence', { text: code + '\n' });
		} catch (err) {
			this._logService.error('[ChatEditorIntegration] runInTerminal failed:', err);
			try {
				await this._commandService.executeCommand('workbench.action.terminal.new');
				await this._commandService.executeCommand('workbench.action.terminal.sendSequence', { text: code + '\n' });
			} catch (err2) {
				this._logService.error('[ChatEditorIntegration] runInTerminal fallback failed:', err2);
			}
		}
	}

	/** P1-3: grab the editor's current selection and add it as a chat context attachment. */
	async addEditorSelectionToChat(): Promise<void> {
		try {
			const codeEditor = this._editorService.activeTextEditorControl as any;
			if (!codeEditor || typeof codeEditor.getModel !== 'function') { return; }
			const model = codeEditor.getModel();
			if (!model) { return; }
			const selection = codeEditor.getSelection();
			if (!selection || selection.isEmpty) { return; }
			const selectedText = model.getValueInRange(selection);
			if (!selectedText.trim()) { return; }
			const resource = model.uri;
			const fileName = resource?.path.split('/').pop() || 'selection';
			this._panelHost.getChatPanel()?.addFileContext(`${fileName} (L${selection.startLineNumber}-${selection.endLineNumber})`, selectedText);
		} catch (err) {
			this._logService.info('[ChatEditorIntegration] addEditorSelectionToChat: no active editor or selection:', err);
		}
	}
}
