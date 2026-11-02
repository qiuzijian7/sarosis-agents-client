/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import * as DOM from '../../../../base/browser/dom.js';
import { KbHomeEditorInput } from './kbHomeEditorInput.js';

/**
 * 知识库「主页」的中心 Tab（★ 2026-11-02）。
 *
 * 实现选择：**同源 iframe** 指向 KB 插件路由 `/x/kb/home`，而不是在这里手写 DOM。
 *   · 好处：页面用插件侧的现成数据（`view-data` / `kbs` / `listAllVaults`），不必在 IDE 侧再搭一套取数；
 *   · 风险低：不新增 webview 控制器、不引入跨 webview 协议，只是一个 URL；
 *   · 与「关系图谱」不同（那个是纯 DOM 力导向图，必须本地渲染），这里是**信息页**，适合整页渲染。
 *
 * ⚠ 同源前提：KB 插件与工作台由同一个 localhost 服务提供 ⇒ 相对路径 `/x/kb/home` 天然同源。
 */
export class KbHomeEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.kbHomePane';

	private _container: HTMLElement | undefined;
	private _iframe: HTMLIFrameElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(KbHomeEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = DOM.$('div.kb-home-editor-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.position = 'relative';
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

		if (!(input instanceof KbHomeEditorInput) || !this._container) {
			return;
		}
		if (token.isCancellationRequested) {
			return;
		}

		// 每次 setInput 都重建 iframe：Tab 被移动/重新打开时 DOM 会被搬走，复用旧节点会白屏
		this._iframe?.remove();

		const iframe = document.createElement('iframe');
		iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
		iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:transparent';
		// rev 用时间戳：同一 Tab 重新聚焦也要拿到最新统计（页面本身带 cache-control: no-store）
		const rev = Date.now().toString(36);
		iframe.src = `/x/kb/home?vaultId=${encodeURIComponent(input.vaultId)}&rev=${rev}`;
		this._container.appendChild(iframe);
		this._iframe = iframe;
	}

	override clearInput(): void {
		this._iframe?.remove();
		this._iframe = undefined;
		super.clearInput();
	}

	override layout(dimension: DOM.Dimension): void {
		if (!this._container || !this._iframe) {
			return;
		}
		this._container.style.width = `${dimension.width}px`;
		this._container.style.height = `${dimension.height}px`;
		this._iframe.style.width = `${dimension.width}px`;
		this._iframe.style.height = `${dimension.height}px`;
	}

	override focus(): void {
		this._iframe?.focus();
	}
}
