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

import { $ } from '../../../../../base/browser/dom.js';
import type { ChatMessage } from '../../common/types.js';

/**
 * Claw Chat View - 主聊天界面，支持与Agent对话
 * 功能：消息输入、发送、历史记录、流式响应显示
 */
export class ClawChatViewPane extends ViewPane {

	private messagesContainer!: HTMLElement;
	private inputContainer!: HTMLElement;
	private inputElement!: HTMLTextAreaElement;
	private sendButton!: HTMLButtonElement;
	private messages: ChatMessage[] = [];
	private isStreaming = false;

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('claw-chat-view');

		// Header with model selector
		const header = $('div.claw-chat-header');
		const modelLabel = $('span.claw-chat-model');
		modelLabel.textContent = '🤖 Claw Assistant';
		header.appendChild(modelLabel);

		const clearBtn = $('button.claw-chat-clear');
		clearBtn.textContent = '🗑️';
		clearBtn.title = 'Clear chat history';
		clearBtn.onclick = () => this._clearChat();
		header.appendChild(clearBtn);
		container.appendChild(header);

		// Messages area
		this.messagesContainer = $('div.claw-chat-messages');
		this._renderWelcome();
		container.appendChild(this.messagesContainer);

		// Input area
		this.inputContainer = $('div.claw-chat-input-container');

		this.inputElement = document.createElement('textarea');
		this.inputElement.className = 'claw-chat-input';
		this.inputElement.placeholder = 'Type a message... (Enter to send, Shift+Enter for newline)';
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
		this.sendButton.textContent = 'Send';
		this.sendButton.onclick = () => this._sendMessage();
		buttonRow.appendChild(this.sendButton);
		this.inputContainer.appendChild(buttonRow);

		container.appendChild(this.inputContainer);
	}

	private _renderWelcome(): void {
		const welcome = $('div.claw-chat-welcome');
		welcome.innerHTML = `
			<div class="welcome-icon">💬</div>
			<h3>Welcome to Claw Chat</h3>
			<p>Start a conversation with your AI agent. Ask questions, delegate tasks, or get help with your workspace.</p>
			<div class="welcome-suggestions">
				<button class="suggestion-btn" data-msg="Help me understand this workspace">💡 Understand workspace</button>
				<button class="suggestion-btn" data-msg="List my current tasks">📋 List tasks</button>
				<button class="suggestion-btn" data-msg="What agents are available?">🤖 Available agents</button>
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

	private async _sendMessage(): Promise<void> {
		const text = this.inputElement.value.trim();
		if (!text || this.isStreaming) {
			return;
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
			await this.chatService.sendMessage(
				'claw-default',
				text,
				{},
				(delta: IChatStreamDelta) => {
					if (delta.type === 'text' && delta.content) {
						fullResponse += delta.content;
						contentEl.textContent = fullResponse;
						this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
					} else if (delta.type === 'error') {
						contentEl.textContent = `⚠️ Error: ${delta.content || 'Unknown error'}`;
						contentEl.classList.add('message-error');
					}
				}
			);
		} catch (err) {
			contentEl.textContent = `⚠️ Failed to send message: ${(err as Error).message}`;
			contentEl.classList.add('message-error');
		}

		this.isStreaming = false;
		this.sendButton.disabled = false;
		this.sendButton.textContent = 'Send';
	}

	private _appendMessage(role: 'user' | 'assistant', content: string): void {
		const bubble = this._createMessageBubble(role, content);
		this.messagesContainer.appendChild(bubble);
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
		this.messages.push({ id: crypto.randomUUID(), role, content, employeeId: 'claw-default', timestamp: new Date().toISOString() });
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
			await this.chatService.clearHistory('claw-default');
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
