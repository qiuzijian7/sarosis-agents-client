/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ITerminalInstance, ITerminalService } from './terminal.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { TerminalPanelEditorInput } from './terminalPanelEditorInput.js';

export class TerminalPanelEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.terminalPanel';

	private _container: HTMLElement | undefined;
	private _terminalInstance: ITerminalInstance | undefined;
	private _lastDimension: dom.Dimension | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super(TerminalPanelEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('terminal-panel-editor-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		parent.appendChild(this._container);
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof TerminalPanelEditorInput) || token.isCancellationRequested) {
			return;
		}

		// 如果还没有终端实例，创建一个
		if (!this._terminalInstance) {
			await this._createTerminalInstance();
		}

		if (token.isCancellationRequested) {
			return;
		}

		// 等待 xterm 初始化完成，确保终端渲染器已就绪
		if (this._terminalInstance) {
			await this._terminalInstance.xtermReadyPromise;
		}

		if (token.isCancellationRequested) {
			return;
		}

		// 将终端实例附加到容器
		if (this._terminalInstance && this._container) {
			this._terminalInstance.attachToElement(this._container);
			this._terminalInstance.setVisible(true);
			if (this._lastDimension) {
				this._terminalInstance.layout(this._lastDimension);
			}
			if (!options?.preserveFocus) {
				this._terminalInstance.focus(true);
			}
		}
	}

	private async _createTerminalInstance(): Promise<void> {
		if (this._terminalInstance) {
			return;
		}

		// 使用默认 profile 创建终端实例
		const instance = await this.terminalService.createTerminal({
			location: TerminalLocation.Panel,
		});

		this._terminalInstance = instance;

		// 监听终端实例销毁事件
		this._register(instance.onDisposed(() => {
			if (this._terminalInstance === instance) {
				this._terminalInstance = undefined;
			}
		}));
	}

	override layout(dimension: dom.Dimension): void {
		this._lastDimension = dimension;
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
		if (this._terminalInstance) {
			this._terminalInstance.layout(dimension);
		}
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (this._terminalInstance) {
			this._terminalInstance.setVisible(visible);
		}
	}

	override focus(): void {
		this._terminalInstance?.focus(true);
	}

	override dispose(): void {
		if (this._terminalInstance) {
			this._terminalInstance.detachFromElement();
			// 不销毁终端实例，让它可以被重新附加
		}
		super.dispose();
	}
}
