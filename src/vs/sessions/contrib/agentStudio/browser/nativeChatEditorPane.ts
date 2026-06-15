/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
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

import { NativeChatEditorInput } from './nativeChatEditorInput.js';
import { AgentChatPanel } from '../../../browser/agentChat/agentChatPanel.js';
import { IAgentStudioService } from '../../../common/agentStudioService.js';
import type { AgentStatus as AgentChatAgentStatus } from '../../../browser/agentChat/agentChatTypes.js';
import * as DOM from '../../../../base/browser/dom.js';

/**
 * EditorPane that hosts AgentChatPanel natively in the DOM.
 *
 * This replaces the WebView/iframe-based AgentStudioEditorPane for chat,
 * eliminating the overlay synchronisation issues (bottom gap on resize),
 * iframe destruction on DOM reparent, and cross-origin communication overhead.
 *
 * The pane mounts the existing AgentChatPanel (which renders the full chat UI:
 * tabs, header, messages, input area) directly inside the editor container.
 */
export class NativeChatEditorPane extends EditorPane {

	static readonly ID = NativeChatEditorInput.EditorID;

	private _container: HTMLElement | undefined;
	private _chatPanel: AgentChatPanel | undefined;
	private _isInitialized = false;
	private _defaultAgentSelected = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAgentStudioService private readonly _agentStudioService: IAgentStudioService,
	) {
		super(NativeChatEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('native-chat-editor-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.overflow = 'hidden';
		parent.appendChild(this._container);

		this._initChatPanel();
	}

	private _initChatPanel(): void {
		if (this._isInitialized || !this._container) {
			return;
		}

		this._chatPanel = this._register(new AgentChatPanel({
			onSendMessage: async (text: string) => {
				// TODO: Wire to IAgentChatService for actual message sending
				console.log('[NativeChatEditorPane] sendMessage:', text);
			},
			onCancelExecution: () => {
				// TODO: Wire to abort controller
				console.log('[NativeChatEditorPane] cancelExecution');
			},
			onToggleCollapse: () => {
				document.dispatchEvent(new CustomEvent('agent-studio:toggle-right-column'));
			},
			onSelectAgent: (agentId: string) => {
				this._selectAndLoadAgent(agentId);
			},
		}));

		this._container.appendChild(this._chatPanel.element);
		this._isInitialized = true;

		// Load available agents
		this._loadAvailableAgents();

		// Listen for agent selection from agentStudio webview/external sources
		this._register(this._agentStudioService.onDidSelectAgent(async (agentId) => {
			if (!agentId) {
				this._chatPanel?.setAgent(null);
				return;
			}
			await this._selectAndLoadAgent(agentId);
		}));

		console.log('[NativeChatEditorPane] Chat panel initialized');
	}

	private async _selectAndLoadAgent(agentId: string): Promise<void> {
		try {
			const emp = await this._agentStudioService.getAgent(agentId);
			if (emp && this._chatPanel) {
				this._chatPanel.setAgent({
					id: emp.id,
					name: emp.name,
					role: emp.role,
					avatarUrl: emp.avatar,
					status: (emp.status ?? 'idle') as AgentChatAgentStatus,
					isPM: emp.id === 'pm' || emp.role?.toLowerCase().includes('project manager'),
					customPrompt: emp.systemPrompt,
					model: emp.model,
					provider: undefined,
				});
			}
		} catch (err) {
			console.warn('[NativeChatEditorPane] _selectAndLoadAgent failed:', err);
		}
	}

	private async _loadAvailableAgents(): Promise<void> {
		try {
			const agents = await this._agentStudioService.getAgents();
			console.info(
				`[NativeChatEditorPane] _loadAvailableAgents: fetched ${agents?.length ?? 0} agents — ` +
				`ids=[${(agents ?? []).map(a => a.id).join(', ')}]`
			);
			if (this._chatPanel && agents) {
				this._chatPanel.setAvailableAgents(
					agents.map(emp => ({
						id: emp.id,
						name: emp.name,
						role: emp.role,
						avatarUrl: emp.avatar,
						status: (emp.status ?? 'idle') as AgentChatAgentStatus,
						isPM: emp.id === 'pm' || emp.role?.toLowerCase().includes('project manager'),
						customPrompt: emp.systemPrompt,
						model: emp.model,
						provider: undefined,
					}))
				);

				// 默认选中 claw agent（多级 fallback）：
				//   1. id / presetId 完全等于 'saros-claw' / 'claw'
				//   2. id / presetId / name / role 不区分大小写包含 'claw'
				//   3. 上面都没匹配到 → 列表第一个 agent
				if (!this._defaultAgentSelected && agents.length > 0) {
					const lower = (s: unknown) => (typeof s === 'string' ? s.toLowerCase() : '');
					const matchExact = (a: any) => a.id === 'saros-claw' || a.id === 'claw' || (a as any).presetId === 'claw' || (a as any).presetId === 'saros-claw';
					const matchFuzzy = (a: any) => lower(a.id).includes('claw') || lower((a as any).presetId).includes('claw') || lower(a.name).includes('claw') || lower(a.role).includes('claw');
					const target = agents.find(matchExact) ?? agents.find(matchFuzzy) ?? agents[0];
					if (target) {
						this._defaultAgentSelected = true;
						console.info(`[NativeChatEditorPane] _loadAvailableAgents: defaulting to agent "${target.id}" (${target.name})`);
						await this._selectAndLoadAgent(target.id);
					}
				}
			}
		} catch (err) {
			console.warn('[NativeChatEditorPane] _loadAvailableAgents failed:', err);
		}
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof NativeChatEditorInput)) {
			console.warn('[NativeChatEditorPane] setInput: not a NativeChatEditorInput, skipping');
			return;
		}

		if (token.isCancellationRequested) {
			return;
		}

		// The chat panel is already initialized in createEditor.
		// Re-entering setInput (e.g. after a group move) just needs to ensure
		// the panel element is in the container.
		if (this._chatPanel && this._container && !this._container.contains(this._chatPanel.element)) {
			this._container.appendChild(this._chatPanel.element);
		}
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = '100%';
		}
	}

	override dispose(): void {
		this._chatPanel = undefined;
		this._isInitialized = false;
		super.dispose();
	}
}
