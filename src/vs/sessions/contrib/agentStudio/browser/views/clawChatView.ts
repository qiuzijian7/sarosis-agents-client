/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IViewPaneOptions, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IAgentChatService } from '../../common/agentStudio.js';
import type { IChatStreamDelta } from '../../common/agentStudio.js';
import { IModelSelectorService } from '../../common/modelSelector.js';
import { IAgentOSService } from '../../common/agentOS.js';
import { $ } from '../../../../../base/browser/dom.js';
import type { ChatMessage } from '../../common/types.js';

/**
 * Claw Chat View - 主聊天界面，支持与Agent对话
 * 功能：消息输入、发送、历史记录、流式响应显示、Provider 选择器
 *
 * Provider 选择器行为：
 * - 只显示已认证（getAuthStatus() === Authenticated）的 Provider
 * - 未配置参数的 Provider（NotConfigured / Failed）不出现
 * - 选择器显示 "Provider名 / 模型名"，点击弹出 QuickPick 由 ModelSelectorService 驱动
 */
export class ClawChatViewPane extends ViewPane {

	private messagesContainer!: HTMLElement;
	private inputContainer!: HTMLElement;
	private inputElement!: HTMLTextAreaElement;
	private sendButton!: HTMLButtonElement;
	private messages: ChatMessage[] = [];
	private isStreaming = false;

	// Provider 选择器相关
	private _providerLabel!: HTMLElement;
	private _modelLabel!: HTMLElement;
	private _agentContainer!: HTMLElement;   // Agent 选择器容器（条件显示）
	private _agentLabel!: HTMLElement;       // Agent 名称显示
	private _agentBtn!: HTMLButtonElement;    // Agent 选择器按钮

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IAgentChatService private readonly chatService: IAgentChatService,
		@IModelSelectorService private readonly modelSelectorService: IModelSelectorService,
		@IAgentOSService private readonly agentOSService: IAgentOSService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// 监听选择变化 → 更新 Header 显示
		this._register(this.modelSelectorService.onDidChangeSelection((sel) => {
			this._updateProviderDisplay();
		}));

		// 监听可用模型变化（Provider 注册/卸载/认证状态变化） → 刷新显示
		this._register(this.modelSelectorService.onDidChangeAvailableModels(() => {
			this._updateProviderDisplay();
		}));

		// 监听 Agent 选择变化 → 更新 Agent 显示
		this._register(this.modelSelectorService.onDidChangeAgent((agentId) => {
			this._updateAgentDisplay(agentId);
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('claw-chat-view');

		// ─── Header with provider selector ──────────────────────────────
		const header = $('div.claw-chat-header');

		// Provider + Model 选择器按钮
		const selectorBtn = $('button.claw-chat-provider-selector');
		selectorBtn.title = '选择模型 Provider 和模型';
		selectorBtn.onclick = () => this._onProviderSelectorClick();

		// Provider 图标/名称
		this._providerLabel = $('span.claw-chat-provider-name');
		selectorBtn.appendChild(this._providerLabel);

		// 分隔符
		const separator = $('span.claw-chat-provider-separator');
		separator.textContent = ' / ';
		selectorBtn.appendChild(separator);

		// 模型名称
		this._modelLabel = $('span.claw-chat-model-name');
		selectorBtn.appendChild(this._modelLabel);

		// Agent 选择器（条件显示：仅 Provider 支持 Agent 时显示）
		this._agentContainer = $('span.claw-chat-agent-container');
		this._agentContainer.style.display = 'none'; // 默认隐藏

		const agentSeparator = $('span.claw-chat-agent-separator');
		agentSeparator.textContent = ' / ';
		this._agentContainer.appendChild(agentSeparator);

		this._agentBtn = document.createElement('button');
		this._agentBtn.className = 'claw-chat-agent-selector';
		this._agentBtn.title = '选择 Agent';
		this._agentBtn.onclick = () => this._onAgentSelectorClick();

		this._agentLabel = $('span.claw-chat-agent-name');
		this._agentLabel.textContent = '选择 Agent';
		this._agentBtn.appendChild(this._agentLabel);

		const agentArrow = $('span.claw-chat-agent-arrow');
		agentArrow.textContent = '▾';
		this._agentBtn.appendChild(agentArrow);

		this._agentContainer.appendChild(this._agentBtn);
		selectorBtn.appendChild(this._agentContainer);

		// 下拉箭头
		const arrow = $('span.claw-chat-provider-arrow');
		arrow.textContent = '▾';
		selectorBtn.appendChild(arrow);

		header.appendChild(selectorBtn);

		// 清空按钮
		const clearBtn = $('button.claw-chat-clear');
		clearBtn.textContent = '🗑️';
		clearBtn.title = '清空聊天记录';
		clearBtn.onclick = () => this._clearChat();
		header.appendChild(clearBtn);

		container.appendChild(header);

		// ─── Messages area ───────────────────────────────────────────
		this.messagesContainer = $('div.claw-chat-messages');
		this._renderWelcome();
		container.appendChild(this.messagesContainer);

		// ─── Input area ───────────────────────────────────────────────
		this.inputContainer = $('div.claw-chat-input-container');

		this.inputElement = document.createElement('textarea');
		this.inputElement.className = 'claw-chat-input';
		this.inputElement.placeholder = '输入消息...（Enter 发送，Shift+Enter 换行）';
		this.inputElement.rows = 3;
		this.inputElement.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this._sendMessage();
			}
		});
		this.inputContainer.appendChild(this.inputElement);

		const buttonRow = $('div.claw-chat-button-row');
		this.sendButton = document.createElement('button');
		this.sendButton.className = 'claw-chat-send-btn';
		this.sendButton.textContent = '发送';
		this.sendButton.onclick = () => this._sendMessage();
		buttonRow.appendChild(this.sendButton);
		this.inputContainer.appendChild(buttonRow);

		container.appendChild(this.inputContainer);

		// 初始化 Provider 显示
		this._updateProviderDisplay();
	}

	// ─── Provider 选择器 ─────────────────────────────────────────────

	private async _onProviderSelectorClick(): Promise<void> {
		// 先刷新可用模型列表（触发 Provider 重新扫描）
		const models = await this.modelSelectorService.getAvailableModels();
		if (models.length === 0) {
			// 没有可用 Provider，提示用户去设置
			this._showNoProviderHint();
			return;
		}
		// 委托给 ModelSelectorService 显示 QuickPick
		await this.modelSelectorService.showQuickPick();
	}

	private _updateProviderDisplay(): void {
		const selection = this.modelSelectorService.getSelection();
		if (selection) {
			// 查找 Provider 信息
			const provider = this.agentOSService.getModelProviders()
				.find(p => p.id === selection.providerId);
			const providerName = provider?.name || selection.providerId;
			const modelId = selection.modelId;

			this._providerLabel.textContent = providerName;
			this._modelLabel.textContent = modelId;

			// 条件显示 Agent 选择器
			const supportsAgents = this.modelSelectorService.currentProviderSupportsAgents();
			this._agentContainer.style.display = supportsAgents ? 'inline-flex' : 'none';

			if (supportsAgents) {
				this._updateAgentDisplay(this.modelSelectorService.getSelectedAgentId());
			}
		} else {
			// 没有选择，显示默认/第一个已认证 Provider
			this._autoSetDefaultProvider();
			this._agentContainer.style.display = 'none';
		}
	}

	private _updateAgentDisplay(agentId: string | undefined): void {
		if (!agentId) {
			this._agentLabel.textContent = '默认 Agent';
			return;
		}
		// 查找 Agent 名称
		this.modelSelectorService.getAvailableAgents().then(agents => {
			const agent = agents.find(a => a.id === agentId);
			this._agentLabel.textContent = agent?.name || agentId;
		}).catch(() => {
			this._agentLabel.textContent = agentId;
		});
	}

	private async _autoSetDefaultProvider(): Promise<void> {
		const models = await this.modelSelectorService.getAvailableModels();
		if (models.length > 0) {
			const first = models[0];
			this.modelSelectorService.setSelection({
				providerId: first.provider.id,
				modelId: first.model.id,
			});
		} else {
			this._providerLabel.textContent = '未配置';
			this._modelLabel.textContent = '请在设置中配置 Provider';
		}
	}

	private _showNoProviderHint(): void {
		this._providerLabel.textContent = '未配置';
		this._modelLabel.textContent = '请在设置中配置 Provider';
	}

	// ─── Agent 选择器 ─────────────────────────────────────

	private async _onAgentSelectorClick(): Promise<void> {
		if (!this.modelSelectorService.currentProviderSupportsAgents()) {
			return;
		}
		await this.modelSelectorService.showAgentQuickPick();
	}


	// ─── 消息发送（使用选中的 Provider/Model）──────────────────

	private async _sendMessage(): Promise<void> {
		const text = this.inputElement.value.trim();
		if (!text || this.isStreaming) {
			return;
		}

		// 获取当前选中的 Provider + Model
		let selection = this.modelSelectorService.getSelection();
		if (!selection) {
			await this._autoSetDefaultProvider();
			selection = this.modelSelectorService.getSelection();
			if (!selection) {
				this._appendSystemMessage('⚠️ 请先在设置中配置 Provider（API Token 等）');
				return;
			}
		}

		// Clear welcome if first message
		if (this.messages.length === 0) {
			this.messagesContainer.innerHTML = '';
		}

		// Add user message
		this._appendMessage('user', text);
		this.inputElement.value = '';
		this.isStreaming = true;
		this.sendButton.disabled = true;
		this.sendButton.textContent = '⏳';

		// Create assistant bubble for streaming
		const assistantBubble = this._createMessageBubble('assistant', '');
		this.messagesContainer.appendChild(assistantBubble);
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

		const contentEl = assistantBubble.querySelector('.message-content') as HTMLElement;
		let fullResponse = '';

		try {
			// 使用选中的 providerId、model 和 agentId 发送消息
			const agentId = this.modelSelectorService.getSelectedAgentId();
			await this.chatService.sendMessage(
				selection.providerId,
				text,
				{
					model: selection.modelId,
					agentId,
				},
				(delta: IChatStreamDelta) => {
					if (delta.type === 'text' && delta.content) {
						fullResponse += delta.content;
						contentEl.textContent = fullResponse;
						this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
					} else if (delta.type === 'error') {
						contentEl.textContent = `⚠️ 错误: ${delta.content || '未知错误'}`;
						contentEl.classList.add('message-error');
					} else if (delta.type === 'thinking' && delta.content) {
						// 思考过程单独显示
						this._appendThinkingContent(delta.content);
					}
				}
			);
		} catch (err) {
			contentEl.textContent = `⚠️ 发送失败: ${(err as Error).message}`;
			contentEl.classList.add('message-error');
		}

		this.isStreaming = false;
		this.sendButton.disabled = false;
		this.sendButton.textContent = '发送';
	}

	private _appendSystemMessage(content: string): void {
		const el = $('div.message-system');
		el.textContent = content;
		this.messagesContainer.appendChild(el);
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
	}

	private _appendThinkingContent(content: string): void {
		let thinkingEl = this.messagesContainer.querySelector('.message-thinking') as HTMLElement;
		if (!thinkingEl) {
			thinkingEl = $('div.message-thinking');
			const label = $('span.thinking-label');
			label.textContent = '🤔 思考中';
			thinkingEl.appendChild(label);
			const contentEl = $('div.thinking-content');
			thinkingEl.appendChild(contentEl);
			this.messagesContainer.appendChild(thinkingEl);
		}
		const contentEl = thinkingEl.querySelector('.thinking-content') as HTMLElement;
		contentEl.textContent += content;
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
	}

	// ─── 消息渲染 ─────────────────────────────────────────────────

	private _renderWelcome(): void {
		const welcome = $('div.claw-chat-welcome');
		welcome.innerHTML = `
			<div class="welcome-icon">💬</div>
			<h3>欢迎使用 Claw Chat</h3>
			<p>与你的 AI Agent 开始对话。提问、委托任务，或获取工作区帮助。</p>
			<div class="welcome-suggestions">
				<button class="suggestion-btn" data-msg="帮我了解这个工作区">💡 了解工作区</button>
				<button class="suggestion-btn" data-msg="列出我的当前任务">📋 列出任务</button>
				<button class="suggestion-btn" data-msg="有哪些可用的 Agent？">🤖 可用 Agent</button>
			</div>
		`;
		welcome.querySelectorAll('.suggestion-btn').forEach(btn => {
			(btn as HTMLButtonElement).onclick = () => {
				const msg = btn.getAttribute('data-msg');
				if (msg) {
					this.inputElement.value = msg;
					this._sendMessage();
				}
			};
		});
		this.messagesContainer.appendChild(welcome);
	}

	private _appendMessage(role: 'user' | 'assistant', content: string): void {
		const bubble = this._createMessageBubble(role, content);
		this.messagesContainer.appendChild(bubble);
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
		this.messages.push({
			id: crypto.randomUUID(),
			role,
			content,
			employeeId: this.modelSelectorService.getSelection()?.providerId || 'claw-default',
			timestamp: new Date().toISOString(),
		});
	}

	private _createMessageBubble(role: string, content: string): HTMLElement {
		const wrapper = $('div.message-wrapper');
		wrapper.classList.add(`message-${role}`);

		const avatar = $('div.message-avatar');
		avatar.textContent = role === 'user' ? '👤' : '🤖';
		wrapper.appendChild(avatar);

		const bubble = $('div.message-bubble');
		const contentEl = $('div.message-content');
		contentEl.textContent = content;
		bubble.appendChild(contentEl);
		wrapper.appendChild(bubble);

		return wrapper;
	}

	private async _clearChat(): Promise<void> {
		this.messages = [];
		this.messagesContainer.innerHTML = '';
		this._renderWelcome();
		try {
			const selection = this.modelSelectorService.getSelection();
			await this.chatService.clearHistory(selection?.providerId || 'claw-default');
		} catch {
			// ignore
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.messagesContainer) {
			const inputHeight = this.inputContainer?.offsetHeight || 100;
			const headerHeight = 36;
			this.messagesContainer.style.height = `${height - inputHeight - headerHeight}px`;
		}
	}
}
