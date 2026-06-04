/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancelablePromise, createCancelablePromise } from '../../../../base/common/async.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IOutputChannel, IOutputService, CONTEXT_OUTPUT_SCROLL_LOCK } from '../../../services/output/common/output.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextKeyService, IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { CursorChangeReason } from '../../../../editor/common/cursorEvents.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { OutputEditor } from './outputView.js';
import { OutputEditorInput } from './outputEditorInput.js';
import * as nls from '../../../../nls.js';
import { TextResourceEditorInput } from '../../../common/editor/textResourceEditorInput.js';

export class OutputEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.output';

	private _container: HTMLElement | undefined;
	private _outputEditor: OutputEditor | undefined;
	private _channelId: string | undefined;
	private _editorPromise: CancelablePromise<void> | null = null;

	private readonly scrollLockContextKey: IContextKey<boolean>;
	get scrollLock(): boolean { return !!this.scrollLockContextKey.get(); }
	set scrollLock(scrollLock: boolean) { this.scrollLockContextKey.set(scrollLock); }

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IOutputService private readonly outputService: IOutputService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super(OutputEditorPane.ID, group, telemetryService, themeService, storageService);
		this.scrollLockContextKey = CONTEXT_OUTPUT_SCROLL_LOCK.bindTo(this.contextKeyService);
		this._register(this.outputService.onActiveOutputChannel(() => this.renderActiveChannel(true)));
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('output-editor-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		parent.appendChild(this._container);

		// 创建一个带有独立 context key service 的 OutputEditor 实例
		const editorInstantiationService = this._register(
			this.instantiationService.createChild(new ServiceCollection([IContextKeyService, this.contextKeyService]))
		);
		this._outputEditor = this._register(editorInstantiationService.createInstance(OutputEditor));
		this._outputEditor.create(this._container);
		this._outputEditor.setVisible(true);

		// 设置自动滚动行为
		const codeEditor = <ICodeEditor>this._outputEditor.getControl();
		if (codeEditor) {
			codeEditor.setAriaOptions({ role: 'document', activeDescendant: undefined });
			this._register(codeEditor.onDidChangeModelContent(() => {
				if (!this.scrollLock) {
					this._outputEditor?.revealLastLine();
				}
			}));
			this._register(codeEditor.onDidChangeCursorPosition((e) => {
				if (e.reason !== CursorChangeReason.Explicit) {
					return;
				}
				if (!this.configurationService.getValue('output.smartScroll.enabled')) {
					return;
				}
				const model = codeEditor.getModel();
				if (model) {
					const newPositionLine = e.position.lineNumber;
					const lastLine = model.getLineCount();
					this.scrollLock = lastLine !== newPositionLine;
				}
			}));
		}
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof OutputEditorInput) || token.isCancellationRequested) {
			return;
		}

		this.renderActiveChannel(!!options?.preserveFocus);
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
		if (this._outputEditor) {
			this._outputEditor.layout(new DOM.Dimension(dimension.width, dimension.height));
		}
	}

	override focus(): void {
		this._editorPromise?.then(() => this._outputEditor?.focus());
	}

	clearFilterText(): void {
		// 编辑器版暂不支持过滤，过滤功能仍在 ViewPane 版中
	}

	private renderActiveChannel(preserveFocus: boolean): void {
		const channel = this.outputService.getActiveChannel();
		if (!channel || !this._outputEditor) {
			return;
		}
		this.showChannel(channel, preserveFocus);
	}

	private showChannel(channel: IOutputChannel, preserveFocus: boolean): void {
		if (this._channelId !== channel.id) {
			this._channelId = channel.id;
			const input = this.instantiationService.createInstance(
				TextResourceEditorInput,
				channel.uri,
				nls.localize('output model title', "{0} - Output", channel.label),
				nls.localize('channel', "Output channel for '{0}'", channel.label),
				undefined,
				undefined
			);
			this._editorPromise?.cancel();
			this._editorPromise = createCancelablePromise(token =>
				this._outputEditor!.setInput(input, { preserveFocus }, Object.create(null), token)
			);
		} else if (!preserveFocus) {
			this._outputEditor?.focus();
		}
	}

	override dispose(): void {
		this._outputEditor = undefined;
		super.dispose();
	}
}
