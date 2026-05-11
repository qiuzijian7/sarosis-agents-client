/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChatMessage } from '../common/providers.js';
import { IModelProvider } from '../common/providers.js';

/**
 * 上下文压缩管理器
 * 当对话历史过长时，自动压缩历史消息以节省 token
 */
export class ContextManager {
	private readonly _compressionThreshold: number = 0.5; // 50% 阈值
	private readonly _maxRecentMessages: number = 20; // 保留最近20条消息
	private readonly _minMessagesToCompress: number = 10; // 最少10条消息才压缩

	constructor(
		private readonly _modelProvider: IModelProvider,
		private readonly _modelId: string,
	) {}

	/**
	 * 检查并压缩上下文（如需要）
	 * @returns 压缩后的消息列表
	 */
	async compressIfNeeded(messages: IChatMessage[], maxTokens: number): Promise<IChatMessage[]> {
		const estimatedTokens = this._estimateTokens(messages);

		// 检查是否需要压缩
		if (
			estimatedTokens < maxTokens * this._compressionThreshold ||
			messages.length < this._minMessagesToCompress
		) {
			return messages;
		}

		// 分离系统消息（保留）
		const systemMessages = messages.filter(m => m.role === 'system');
		const nonSystemMessages = messages.filter(m => m.role !== 'system');

		// 保留最近的消息
		const recentMessages = nonSystemMessages.slice(-this._maxRecentMessages);
		const oldMessages = nonSystemMessages.slice(0, -this._maxRecentMessages);

		if (oldMessages.length === 0) {
			return messages;
		}

		// 生成历史摘要
		const summary = await this._generateSummary(oldMessages);

		// 构造压缩后的消息列表
		const compressedMessages: IChatMessage[] = [
			...systemMessages,
			{
				role: 'system',
				content: `Previous conversation summary:\n${summary}`,
			},
			...recentMessages,
		];

		return compressedMessages;
	}

	/**
	 * 生成对话历史摘要
	 */
	private async _generateSummary(messages: IChatMessage[]): Promise<string> {
		try {
			const summaryPrompt = this._buildSummaryPrompt(messages);

			const stream = this._modelProvider.chat(this._modelId, [
				{ role: 'user', content: summaryPrompt },
			], {
				temperature: 0.3,
				maxTokens: 500,
			});

			let summary = '';
			for await (const delta of stream) {
				if (delta.type === 'text' && delta.content) {
					summary += delta.content;
				}
				if (delta.type === 'done') {
					break;
				}
			}

			return summary.trim() || 'No summary available.';
		} catch (error) {
			console.error('[ContextManager] Failed to generate summary:', error);
			return 'Previous conversation (summary generation failed).';
		}
	}

	/**
	 * 构建摘要生成提示
	 */
	private _buildSummaryPrompt(messages: IChatMessage[]): string {
		const conversationText = messages
			.map(m => `${m.role}: ${m.content.substring(0, 200)}`)
			.join('\n');

		return `Please summarize the following conversation concisely, focusing on key decisions, actions taken, and important context for continuing the conversation:\n\n${conversationText}\n\nSummary:`;
	}

	/**
	 * 估算 token 数量（简单估算：1 token ≈ 4 characters）
	 */
	private _estimateTokens(messages: IChatMessage[]): number {
		const totalChars = messages.reduce((sum, m) => {
			return sum + (m.content?.length || 0) + this._estimateToolCallsTokens(m.toolCalls);
		}, 0);

		return Math.ceil(totalChars / 4);
	}

	/**
	 * 估算 toolCalls 的 token 数量
	 */
	private _estimateToolCallsTokens(toolCalls?: any[]): number {
		if (!toolCalls || toolCalls.length === 0) {
			return 0;
		}

		const toolCallsText = JSON.stringify(toolCalls);
		return Math.ceil((toolCallsText?.length || 0) / 4);
	}

	/**
	 * 获取上下文统计信息
	 */
	getContextStats(messages: IChatMessage[], maxTokens: number): {
		estimatedTokens: number;
		usagePercentage: number;
		messageCount: number;
		needsCompression: boolean;
	} {
		const estimatedTokens = this._estimateTokens(messages);
		const usagePercentage = (estimatedTokens / maxTokens) * 100;

		return {
			estimatedTokens,
			usagePercentage,
			messageCount: messages.length,
			needsCompression: usagePercentage > this._compressionThreshold * 100,
		};
	}
}
