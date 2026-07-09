/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import * as DOM from '../../../../base/browser/dom.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { KbNoteEditorInput } from './kbNoteEditorInput.js';
import { KbNoteEditorPane as KbNoteEditorComponent } from './views/knowledgeBase/kbNoteEditorPane.js';
import { whenLuteReady } from './views/knowledgeBase/kbLute.js';
// 引入知识库视图的样式（Protyle 块级布局、双链高亮等），保证编辑器独立打开时样式可用
import './views/media/kbView.css';

/**
 * KnowledgeBaseNoteEditorPane — 在中栏文件编辑器打开知识库笔记的 WYSIWYG 编辑器。
 *
 * 复用 KbNoteEditorPane 组件（Protyle/Lute 三级渲染），强制 wysiwygOnly 模式：
 * 无模式切换工具条，默认以所见即所得视图呈现，并可直接编辑。
 *
 * 对齐 SiYuan 的「笔记在中心 Tab 打开」范式；区别于原生 Markdown 编辑器，
 * 本面板使用知识库自有的 Lute/Protyle 渲染管线。
 */
export class KnowledgeBaseNoteEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.kbNotePane';

	private _container: HTMLElement | undefined;
	private _component: KbNoteEditorComponent | undefined;
	private _resource: import('../../../../base/common/uri.js').URI | undefined;
	private _currentContent = '';
	private _saveTimer: number | undefined;
	private _dirty = false;
	private _contentChangeSub: IDisposable | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IFileService private readonly fileService: IFileService,
	) {
		super(KnowledgeBaseNoteEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = DOM.$('div.kb-note-editor-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.display = 'flex';
		this._container.style.flexDirection = 'column';
		this._container.style.overflow = 'hidden';
		this._container.style.background = 'var(--vscode-editor-background)';
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		_options: IEditorOptions | undefined,
		_context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, _options, _context, token);

		if (!(input instanceof KbNoteEditorInput) || !this._container) {
			return;
		}
		if (token.isCancellationRequested) {
			return;
		}

		const resource = input.resource;
		this._resource = resource;

		// 读取文件内容
		let markdown = '';
		try {
			const content = await this.fileService.readFile(resource);
			markdown = content.value.toString();
		} catch (err) {
			this.notificationService.warn(`无法读取文件：${resource.toString()}`);
			markdown = '';
		}

		// (重新) 挂载编辑器组件
		this._disposeComponent();
		const host = DOM.$('div.kb-note-editor-host');
		host.style.flex = '1';
		host.style.overflow = 'hidden';
		host.style.display = 'flex';
		host.style.flexDirection = 'column';
		this._container.appendChild(host);

		try {
			const component = this.instantiationService.createInstance(
				KbNoteEditorComponent,
				{ wysiwygOnly: true, protyleAssetsPath: './media/protyle' },
			);
			component.render(host);

			// 等待 Lute 引擎就绪后再渲染（避免未加载导致渲染失败）
			try {
				await whenLuteReady();
			} catch {
				// Lute 未加载则走组件内部纯文本兜底
			}
			if (token.isCancellationRequested) {
				component.dispose();
				return;
			}

			component.loadMarkdown(markdown, input.getName());
			// 保存订阅并在组件销毁时释放，避免 onContentChange 返回的 IDisposable 泄漏
			this._contentChangeSub = component.onContentChange(content => this._scheduleSave(content));

			this._component = component;
			this._currentContent = markdown;
			this._dirty = false;
		} catch (err) {
			// 渲染管线任何异常都不应让编辑器整体打不开：
			// 兜底以纯文本展示内容，并把真实错误打到日志便于排查。
			console.error('[KB] note editor setInput failed:', err);
			this.notificationService.error(`笔记编辑器加载失败：${err instanceof Error ? err.message : String(err)}`);
			const pre = DOM.$('div.kb-note-preview');
			pre.style.whiteSpace = 'pre-wrap';
			pre.classList.add('protyle-wysiwyg', 'protyle');
			pre.textContent = markdown;
			host.appendChild(pre);
			this._currentContent = markdown;
			this._dirty = false;
		}
	}

	/** 用户编辑后防抖写回文件。 */
	private _scheduleSave(content: string): void {
		this._currentContent = content;
		this._dirty = true;
		if (this._saveTimer !== undefined) {
			window.clearTimeout(this._saveTimer);
		}
		this._saveTimer = window.setTimeout(() => this._flushSave(), 800);
	}

	private async _flushSave(): Promise<void> {
		this._saveTimer = undefined;
		if (!this._dirty || !this._resource) {
			return;
		}
		const content = this._currentContent;
		try {
			await this.fileService.writeFile(this._resource, VSBuffer.fromString(content));
			this._dirty = false;
		} catch (err) {
			this.notificationService.warn(`保存笔记失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		// 切回该 Tab 时给渲染区一个重新布局的机会
		if (visible && this._container) {
			const rect = this._container.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				this.layout(new DOM.Dimension(rect.width, rect.height));
			}
		}
	}

	private _disposeComponent(): void {
		if (this._saveTimer !== undefined) {
			window.clearTimeout(this._saveTimer);
			this._saveTimer = undefined;
		}
		if (this._contentChangeSub) {
			this._contentChangeSub.dispose();
			this._contentChangeSub = undefined;
		}
		void this._flushSave();
		if (this._component) {
			this._component.dispose();
			this._component = undefined;
		}
		if (this._container) {
			DOM.clearNode(this._container);
		}
	}

	override dispose(): void {
		this._disposeComponent();
		super.dispose();
	}
}
