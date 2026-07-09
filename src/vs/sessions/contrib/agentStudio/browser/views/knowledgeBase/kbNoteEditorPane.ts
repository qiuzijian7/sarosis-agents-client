/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  kbNoteEditorPane.ts — Protyle / Lute 双模笔记编辑器。
 *
 *  三级渲染模式（自动降级）：
 *   1. 完整 Protyle WYSIWYG — kernel 运行 + vendored Protyle 脚本加载 → 最完整体验
 *   2. Lute 块级渲染预览 — Lute 可用（lute.min.js 已加载）→ 丰富块视图
 *   3. 纯文本兜底 — 浏览器等受限环境 → 基础 Markdown 显示
 *
 *  复用 SiYuan：
 *   - Lute 引擎（vendored lute.min.js）→ SpinBlockDOM + Markdown2BlockDOM
 *   - Protyle 编辑器构造（new Protyle(app, element, options)）
 *   - 静态后渲染器（mathRender, mermaidRender, ...）
 *
 *  该组件为纯前端 DOM 编辑器，可嵌入 KB View 侧栏、独立 Tab、或替换原生 md 编辑器。
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../../../base/browser/dom.js';
import { safeSetInnerHtml } from '../../../../../../base/browser/domSanitize.js';
import { renderMarkdownToBlocks, applyProtylePostRenderers, highlightRefsInHtml, IKbRenderResult } from './kbLuteRenderer.js';
import { KbKernelClient } from './kbKernelApi.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** Protyle 内核客户端接口（符合 SiYuan window.siyuan.ws 约定） */
export interface IProtyleClient {
	send(data: string): void;
	onMessage(cb: (data: string) => void): void;
	open(): void;
	close(): void;
}

/** Protyle 编辑器构造选项（对齐 SiYuan Protyle 构造参数） */
export interface IProtyleOptions {
	app: unknown;
	blockId: string;
	render: {
		background?: boolean;
		mode?: 'wysiwyg' | 'preview' | 'ir';
		padding?: number;
	};
	client: IProtyleClient;
	/** Protyle 静态资源路径（stage/protyle） */
	protylePath: string;
}

/** Protyle 编辑器实例接口 */
export interface IProtyleInstance {
	dispose(): void;
	element: HTMLElement;
	setProtyleMode(mode: 'wysiwyg' | 'preview' | 'ir'): void;
	readonly protyle: {
		block: { id: string; };
		options: IProtyleOptions;
		undo: { canUndo: boolean; doUndo(): void; };
		redo: { canRedo: boolean; doRedo(): void; };
		focus(): void;
	};
}

export interface IKbNoteEditorOptions {
	/** Protyle 静态资源路径（用于 post-renderers） */
	protyleAssetsPath?: string;
	/** Kernel 客户端（可选，提供则启用 Protyle 模式） */
	kernel?: KbKernelClient;
	/**
	 * 仅 WYSIWYG 模式：隐藏模式切换工具条，预览区直接以 contentEditable 呈现，
	 * 符合「点击文件即进入所见即所得编辑器」的需求（对齐知识库 View 的 UI 入口）。
	 */
	wysiwygOnly?: boolean;
}

export type EditorMode = 'wysiwyg' | 'source' | 'preview';

// ---------------------------------------------------------------------------
// KbNoteEditorPane
// ---------------------------------------------------------------------------

export class KbNoteEditorPane extends Disposable {

	private readonly _options: IKbNoteEditorOptions;
	private _container!: HTMLElement;
	private _sourceEl?: HTMLTextAreaElement;
	private _previewEl!: HTMLElement;
	private _toolbar!: HTMLElement;
	private _mode: EditorMode = 'preview';
	private _currentMarkdown: string = '';
	private _protyleInstance: IProtyleInstance | null = null;

	private readonly _onModeChange = this._register(new Emitter<EditorMode>());
	readonly onModeChange: Event<EditorMode> = this._onModeChange.event;

	/** 内容变更（WYSIWYG 可编辑态下用户输入时触发），参数为最新内容（markdown / 纯文本）。 */
	private readonly _onContentChange = this._register(new Emitter<string>());
	readonly onContentChange: Event<string> = this._onContentChange.event;

	constructor(options: IKbNoteEditorOptions = {}) {
		super();
		this._options = options;
	}

	// -----------------------------------------------------------------------
	// 生命周期
	// -----------------------------------------------------------------------

	/** 创建编辑器 DOM 并挂载到 parent */
	render(parent: HTMLElement): void {
		this._container = parent;
		this._container.classList.add('kb-note-editor');
		this._container.replaceChildren();

		// Toolbar（wysiwygOnly 模式下隐藏模式切换工具条）
		if (!this._options.wysiwygOnly) {
			this._toolbar = this._renderToolbar();
			this._container.appendChild(this._toolbar);
		}

		// Preview area (default mode)
		this._previewEl = $('div.kb-note-preview');
		this._previewEl.classList.add('protyle-wysiwyg', 'protyle');
		this._container.appendChild(this._previewEl);

		// Source textarea (hidden by default)
		this._sourceEl = document.createElement('textarea');
		this._sourceEl.className = 'kb-note-source';
		this._sourceEl.style.display = 'none';
		this._sourceEl.spellcheck = false;
		this._sourceEl.oninput = () => this._onSourceInput();
		this._container.appendChild(this._sourceEl);

		this._setMode(this._options.wysiwygOnly ? 'wysiwyg' : 'preview');
	}

	/** 加载 Markdown 内容并渲染 */
	loadMarkdown(markdown: string, title = ''): void {
		this._currentMarkdown = markdown;
		if (this._sourceEl) { this._sourceEl.value = markdown; }
		this._renderPreview(markdown);
	}

	/** 获取当前编辑内容 */
	getContent(): string {
		if (this._mode === 'source' && this._sourceEl) {
			return this._sourceEl.value;
		}
		// WYSIWYG 可编辑态（无 Protyle 内核时）：返回渲染区的纯文本内容
		if (this._mode === 'wysiwyg' && !this._protyleInstance && this._previewEl) {
			return this._previewEl.innerText;
		}
		return this._currentMarkdown;
	}

	/** 切换到指定模式 */
	switchMode(mode: EditorMode): void {
		this._setMode(mode);
	}

	/** 尝试升级到 Protyle WYSIWYG 模式（需要 kernel 运行 + Protyle 脚本加载） */
	async tryUpgradeToProtyle(
		blockId: string,
		protylePath: string,
	): Promise<boolean> {
		if (!this._options.kernel?.isAvailable) { return false; }

		const Protyle = (window as unknown as Record<string, unknown>).Protyle as new (app: unknown, el: HTMLElement, opts: IProtyleOptions) => IProtyleInstance | undefined;
		if (!Protyle) { return false; }

		try {
			const client = this._createProtyleClient(blockId);
			const instance = new Protyle({}, this._previewEl, {
				app: {},
				blockId,
				render: { mode: 'wysiwyg' },
				client,
				protylePath,
			});

			if (instance) {
				this._protyleInstance?.dispose();
				this._protyleInstance = instance;
				this._mode = 'wysiwyg';
				// Protyle 接管编辑：关闭 contentEditable 兜底
				if (this._previewEl) {
					this._previewEl.contentEditable = 'false';
					this._previewEl.classList.remove('kb-wysiwyg-edit');
					this._previewEl.oninput = null;
				}
				this._onModeChange.fire('wysiwyg');
				this._updateToolbar();
				return true;
			}
		} catch {
			// 降级到 Lute 渲染
		}
		return false;
	}

	override dispose(): void {
		this._protyleInstance?.dispose();
		this._protyleInstance = null;
		super.dispose();
	}

	// -----------------------------------------------------------------------
	// 内部
	// -----------------------------------------------------------------------

	private _renderToolbar(): HTMLElement {
		const tb = $('div.kb-note-toolbar');
		const btns: { mode: EditorMode; label: string; title: string }[] = [
			{ mode: 'preview', label: '📖', title: 'Lute 块级预览' },
			{ mode: 'source', label: '📝', title: 'Markdown 源码' },
			{ mode: 'wysiwyg', label: '✏️', title: 'Protyle 所见即所得' },
		];

		for (const b of btns) {
			const btn = $('span.kb-note-mode-btn');
			btn.textContent = b.label;
			btn.title = b.title;
			btn.dataset.mode = b.mode;
			btn.onclick = () => {
				if ((b.mode === 'wysiwyg')) {
					// WYSIWYG requires kernel + Protyle; fallback to preview
					if (!this._protyleInstance) {
						this._setMode('preview');
						return;
					}
				}
				this._setMode(b.mode);
			};
			tb.appendChild(btn);
		}
		return tb;
	}

	private _updateToolbar(): void {
		// wysiwygOnly 模式下不渲染工具条，直接跳过
		if (!this._toolbar) { return; }
		const btns = this._toolbar.querySelectorAll('.kb-note-mode-btn');
		btns.forEach(b => {
			const el = b as HTMLElement;
			el.classList.toggle('active', el.dataset.mode === this._mode);
			// WYSIWYG 按钮在无 Protyle 时灰掉
			if (el.dataset.mode === 'wysiwyg' && !this._protyleInstance) {
				el.classList.add('disabled');
			}
		});
	}

	private _setMode(mode: EditorMode): void {
		this._mode = mode;
		this._updateToolbar();

		if (!this._sourceEl || !this._previewEl) { return; }

		// Toggle visibility
		this._sourceEl.style.display = mode === 'source' ? '' : 'none';
		this._previewEl.style.display = mode === 'preview' || mode === 'wysiwyg' ? '' : 'none';

		// WYSIWYG 可编辑：无 Protyle 内核时，将 Lute 渲染区设为 contentEditable，
		// 让用户在所见即所得视图中直接输入（Protyle 可用时由其实例接管编辑）。
		const editable = mode === 'wysiwyg' && !this._protyleInstance;
		this._previewEl.contentEditable = editable ? 'true' : 'false';
		this._previewEl.classList.toggle('kb-wysiwyg-edit', editable);
		if (editable) {
			this._previewEl.oninput = () => this._onContentChange.fire(this.getContent());
		} else {
			this._previewEl.oninput = null;
		}

		if (mode === 'preview') {
			this._renderPreview(this._currentMarkdown);
		} else if (mode === 'source' && this._sourceEl) {
			this._sourceEl.value = this._currentMarkdown;
			this._sourceEl.focus();
		}

		this._onModeChange.fire(mode);
	}

	private _onSourceInput(): void {
		if (!this._sourceEl) { return; }
		this._currentMarkdown = this._sourceEl.value;
	}

	private _renderPreview(markdown: string): void {
		if (!this._previewEl) { return; }

		// Lute 块级渲染
		let result: IKbRenderResult;
		try {
			result = renderMarkdownToBlocks(markdown);
		} catch {
			// Fallback: 纯文本
			safeSetInnerHtml(this._previewEl, `<pre>${this._escapeHtml(markdown)}</pre>`);
			return;
		}

		// 客户端高亮 [[...]] / ((...))
		const highlighted = highlightRefsInHtml(result.html);

		// 插入 DOM
		safeSetInnerHtml(this._previewEl, highlighted);

		// 应用 Protyle 静态后渲染器（数学/图表/代码高亮）
		if (this._options.protyleAssetsPath) {
			try {
				applyProtylePostRenderers(this._previewEl, this._options.protyleAssetsPath);
			} catch {
				// 后渲染器非关键，静默失败
			}
		}

		// 创建块引用跳转支持
		this._setupBlockRefNavigation(this._previewEl);
	}

	/**
	 * 为块引用 `((id))` 添加悬浮预览 + 点击跳转。
	 * 通过 Protyle 的 data-node-id / data-type=block-ref 属性识别。
	 */
	private _setupBlockRefNavigation(el: HTMLElement): void {
		el.querySelectorAll('[data-type="block-ref"]').forEach(ref => {
			const blockId = (ref as HTMLElement).dataset.id;
			if (!blockId) { return; }
			(ref as HTMLElement).style.cursor = 'pointer';
			(ref as HTMLElement).title = `块引用: ${blockId}`;
			// 点击跳转可后续通过 kernel API 定位
		});

		// 双链 [[...]] 点击事件
		el.querySelectorAll('.kb-wikilink').forEach(link => {
			(link as HTMLElement).style.cursor = 'pointer';
		});
	}

	private _createProtyleClient(blockId: string): IProtyleClient {
		const kernel = this._options.kernel;
		const wsUrl = kernel?.baseUrl?.replace(/^http/, 'ws') + '/ws';
		let ws: WebSocket | null = null;

		const client: IProtyleClient = {
			send(data: string) { ws?.send(data); },
			onMessage(cb: (data: string) => void) {
				if (ws) { ws.onmessage = (e) => cb(e.data as string); }
			},
			open() {
				if (!wsUrl) { return; }
				ws = new WebSocket(wsUrl);
				ws.onopen = () => {
					// 订阅块的实时更新
					ws?.send(JSON.stringify({
						cmd: 'ls',
						reqId: Date.now(),
						data: { st: blockId },
					}));
				};
			},
			close() { ws?.close(); },
		};
		return client;
	}

	private _escapeHtml(s: string): string {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}
}
