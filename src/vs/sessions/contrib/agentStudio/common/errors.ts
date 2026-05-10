/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent OS 标准错误类
 * 所有 Provider Adapter 抛出/捕获的错误均封装为此类型
 */
export class AgentOSError extends Error {
	readonly pluginId: string;
	readonly operation: string;
	override readonly cause: Error | undefined;

	constructor(message: string, cause?: Error, pluginId?: string) {
		super(message);
		this.name = 'AgentOSError';
		this.cause = cause;
		this.pluginId = pluginId ?? 'unknown';
		// 从 message 中尝试提取 operation
		const match = message.match(/\[(\w+)\\]/);
		this.operation = match ? match[1] : 'unknown';
	}

	/**
	 * 检查是否为特定插件的错误
	 */
	isFromPlugin(pluginId: string): boolean {
		return this.pluginId === pluginId;
	}

	/**
	 * 检查是否为特定操作失败
	 */
	isOperation(operation: string): boolean {
		return this.operation === operation;
	}

	/**
	 * 转换为可序列化的普通对象（用于 IPC 传输）
	 */
	toJSON(): Record<string, unknown> {
		return {
			name: this.name,
			message: this.message,
			pluginId: this.pluginId,
			operation: this.operation,
			cause: this.cause instanceof AgentOSError ? this.cause.toJSON() : this.cause?.message,
		};
	}
}
