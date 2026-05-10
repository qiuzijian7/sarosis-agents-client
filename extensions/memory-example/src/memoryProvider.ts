/*---------------------------------------------------------------------------------------------
 *  Memory Example Provider - Shell Implementation
 *  Implements IMemoryProvider interface
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../src/vs/base/common/event.js';
import { Disposable } from '../../../../src/vs/base/common/lifecycle.js';
import { IMemoryProvider, IMemoryContext, IMemoryEntry } from '../../../../src/vs/sessions/contrib/agentStudio/common/providers.js';

/**
 * Example Memory Provider - 基于内存的简单实现
 *
 * 生产环境可替换为：
 * - Mem0
 * - Honcho
 * - SuperMemory
 */
export class MemoryExampleProvider extends Disposable implements IMemoryProvider {
	readonly id = 'memory-example';
	readonly name = 'Memory Example';

	private readonly _memories = new Map<string, IMemoryEntry[]>();

	constructor() {
		super();
	}

	async loadContext(agentId: string, sessionId: string): Promise<IMemoryContext> {
		const key = `${agentId}:${sessionId}`;
		const memories = this._memories.get(key) || [];

		return {
			shortTermMemories: memories.filter(m => m.type === 'short_term'),
			longTermMemories: memories.filter(m => m.type === 'long_term'),
			systemPrompt: undefined,
			relevantDocuments: [],
		};
	}

	async writeMemory(agentId: string, entry: IMemoryEntry): Promise<void> {
		const key = `${agentId}:latest`;
		if (!this._memories.has(key)) {
			this._memories.set(key, []);
		}
		this._memories.get(key)!.push(entry);
	}

	async searchMemory(agentId: string, query: string): Promise<IMemoryEntry[]> {
		// Shell 实现：简单包含匹配
		const key = `${agentId}:latest`;
		const memories = this._memories.get(key) || [];

		return memories.filter(m =>
			m.content.toLowerCase().includes(query.toLowerCase())
		);
	}
}
