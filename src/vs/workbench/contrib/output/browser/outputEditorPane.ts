/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './output.css';
import * as DOM from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancelablePromise, createCancelablePromise, Delayer } from '../../../../base/common/async.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IOutputChannel, IOutputService, CONTEXT_OUTPUT_SCROLL_LOCK, IOutputChannelDescriptor, Extensions, IOutputChannelRegistry } from '../../../services/output/common/output.js';
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
import { SelectBox, ISelectOptionItem } from '../../../../base/browser/ui/selectBox/selectBox.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { defaultInputBoxStyles, defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { HistoryInputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IAccessibilitySignalService, AccessibilitySignal } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { Action } from '../../../../base/common/actions.js';
import { ThemeIcon } from '../../../../base/common/themables.js';

export class OutputEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.output';

	private _container: HTMLElement | undefined;
	private _toolbarContainer: HTMLElement | undefined;
	private _editorContainer: HTMLElement | undefined;
	private _outputEditor: OutputEditor | undefined;
	private _channelId: string | undefined;
	private _editorPromise: CancelablePromise<void> | null = null;

	// 工具栏组件
	private _filterInput: HistoryInputBox | undefined;
	private _channelSelect: SelectBox | undefined;
	private _actionBar: ActionBar | undefined;
	private _channels: IOutputChannelDescriptor[] = [];
	private readonly _filterDelayer: Delayer<void>;

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
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IAccessibilitySignalService private readonly accessibilitySignalService: IAccessibilitySignalService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(OutputEditorPane.ID, group, telemetryService, themeService, storageService);
		this.scrollLockContextKey = CONTEXT_OUTPUT_SCROLL_LOCK.bindTo(this.contextKeyService);
		this._filterDelayer = new Delayer<void>(300);
		this._register(this.outputService.onActiveOutputChannel(() => {
			this.renderActiveChannel(true);
			this._updateChannelSelect();
		}));
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('output-editor-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.display = 'flex';
		this._container.style.flexDirection = 'column';
		parent.appendChild(this._container);

		// 创建工具栏区域
		this._createToolbar(this._container);

		// 创建编辑器区域
		this._editorContainer = document.createElement('div');
		this._editorContainer.classList.add('output-editor-content');
		this._editorContainer.style.flex = '1';
		this._editorContainer.style.overflow = 'hidden';
		this._container.appendChild(this._editorContainer);

		// 创建一个带有独立 context key service 的 OutputEditor 实例
		const editorInstantiationService = this._register(
			this.instantiationService.createChild(new ServiceCollection([IContextKeyService, this.contextKeyService]))
		);
		this._outputEditor = this._register(editorInstantiationService.createInstance(OutputEditor));
		this._outputEditor.create(this._editorContainer);
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

		// 监听频道注册/移除事件
		const outputChannelRegistry = Registry.as<IOutputChannelRegistry>(Extensions.OutputChannels);
		this._register(outputChannelRegistry.onDidRegisterChannel(() => this._updateChannelSelect()));
		this._register(outputChannelRegistry.onDidRemoveChannel(() => this._updateChannelSelect()));
	}

	private _createToolbar(parent: HTMLElement): void {
		this._toolbarContainer = document.createElement('div');
		this._toolbarContainer.classList.add('output-editor-toolbar');
		this._toolbarContainer.style.display = 'flex';
		this._toolbarContainer.style.alignItems = 'center';
		this._toolbarContainer.style.padding = '4px 8px';
		this._toolbarContainer.style.gap = '4px';
		this._toolbarContainer.style.borderBottom = '1px solid var(--vscode-panel-border, var(--vscode-editorGroup-border))';
		this._toolbarContainer.style.flexShrink = '0';
		parent.appendChild(this._toolbarContainer);

		// 1. 筛选器输入框
		const filterContainer = document.createElement('div');
		filterContainer.classList.add('output-filter-container');
		filterContainer.style.flex = '1';
		filterContainer.style.minWidth = '100px';
		filterContainer.style.maxWidth = '300px';
		this._toolbarContainer.appendChild(filterContainer);

		this._filterInput = this._register(new HistoryInputBox(filterContainer, this.contextViewService, {
			placeholder: nls.localize('outputFilter.placeholder', "筛选器(例如 text, !excludeText)"),
			showHistoryHint: () => false,
			inputBoxStyles: defaultInputBoxStyles,
		}));
		this._register(this._filterInput.onDidChange(() => {
			this._filterDelayer.trigger(() => {
				const text = this._filterInput?.value || '';
				this.outputService.filters.text = text;
			});
		}));

		// 2. 刷新按钮
		const refreshContainer = document.createElement('div');
		refreshContainer.classList.add('output-toolbar-action');
		this._toolbarContainer.appendChild(refreshContainer);
		const refreshAction = this._register(new Action('output.refresh', nls.localize('refresh', "刷新"), ThemeIcon.asClassName(Codicon.refresh), true, async () => {
			const channel = this.outputService.getActiveChannel();
			if (channel) {
				// 重新加载当前频道
				this._channelId = undefined;
				this.showChannel(channel, true);
			}
		}));
		const refreshBar = this._register(new ActionBar(refreshContainer));
		refreshBar.push(refreshAction);

		// 3. 频道选择下拉框
		const selectContainer = document.createElement('div');
		selectContainer.classList.add('output-channel-select');
		selectContainer.style.minWidth = '80px';
		this._toolbarContainer.appendChild(selectContainer);

		this._channels = this.outputService.getChannelDescriptors();
		const options: ISelectOptionItem[] = this._channels.map(c => ({ text: c.label }));
		const activeChannel = this.outputService.getActiveChannel();
		const selectedIndex = activeChannel ? this._channels.findIndex(c => c.id === activeChannel.id) : 0;

		this._channelSelect = this._register(new SelectBox(options, Math.max(selectedIndex, 0), this.contextViewService, defaultSelectBoxStyles));
		this._channelSelect.render(selectContainer);
		this._register(this._channelSelect.onDidSelect(e => {
			const entry = this._channels[e.index];
			if (entry) {
				// 只切换 active channel 并在当前面板中显示，不打开新的编辑器
				const channel = this.outputService.setActiveChannelById(entry.id);
				if (channel) {
					this.showChannel(channel, true);
				}
			}
		}));

		// 4. 动作按钮区域（清除、自动滚动、打开文件、更多）
		const actionsContainer = document.createElement('div');
		actionsContainer.classList.add('output-toolbar-actions');
		actionsContainer.style.display = 'flex';
		actionsContainer.style.alignItems = 'center';
		this._toolbarContainer.appendChild(actionsContainer);

		// 清除输出按钮
		const clearAction = this._register(new Action('output.clear', nls.localize('clearOutput', "清除输出"), ThemeIcon.asClassName(Codicon.clearAll), true, async () => {
			const channel = this.outputService.getActiveChannel();
			if (channel) {
				channel.clear();
				this.accessibilitySignalService.playSignal(AccessibilitySignal.clear);
			}
		}));

		// 打开输出到文件按钮
		const openFileAction = this._register(new Action('output.openFile', nls.localize('openOutputFile', "在编辑器中打开输出"), ThemeIcon.asClassName(Codicon.goToFile), true, async () => {
			const channel = this.outputService.getActiveChannel();
			if (channel) {
				await this.editorService.openEditor({
					resource: channel.uri,
					options: { pinned: true },
				});
			}
		}));

		// 自动滚动锁定按钮
		const scrollLockAction = this._register(new Action('output.scrollLock', nls.localize('toggleAutoScroll', "切换自动滚动"), ThemeIcon.asClassName(Codicon.lock), true, async () => {
			this.scrollLock = !this.scrollLock;
			scrollLockAction.class = ThemeIcon.asClassName(this.scrollLock ? Codicon.unlock : Codicon.lock);
			scrollLockAction.tooltip = this.scrollLock
				? nls.localize('outputScrollOn', "开启自动滚动")
				: nls.localize('outputScrollOff', "关闭自动滚动");
		}));

		this._actionBar = this._register(new ActionBar(actionsContainer));
		this._actionBar.push([clearAction, openFileAction, scrollLockAction]);
	}

	private _updateChannelSelect(): void {
		this._channels = this.outputService.getChannelDescriptors();
		const options: ISelectOptionItem[] = this._channels.map(c => ({ text: c.label }));
		const activeChannel = this.outputService.getActiveChannel();
		const selectedIndex = activeChannel ? this._channels.findIndex(c => c.id === activeChannel.id) : 0;
		this._channelSelect?.setOptions(options, Math.max(selectedIndex, 0));
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
		if (this._outputEditor && this._editorContainer && this._toolbarContainer) {
			const toolbarHeight = this._toolbarContainer.offsetHeight || 34;
			const editorHeight = dimension.height - toolbarHeight;
			this._outputEditor.layout(new DOM.Dimension(dimension.width, Math.max(editorHeight, 0)));
		}
	}

	override focus(): void {
		this._editorPromise?.then(() => this._outputEditor?.focus());
	}

	clearFilterText(): void {
		if (this._filterInput) {
			this._filterInput.value = '';
			this.outputService.filters.text = '';
		}
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
