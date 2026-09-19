/*---------------------------------------------------------------------------------------------
 *  空操作提供者 — 用于测试和降级时的无操作实现。
 *  1:1 复刻 agentmemory src/providers/noop.ts
 *--------------------------------------------------------------------------------------------*/

export class NoopProvider {
	readonly name = 'noop';

	async compress(_systemPrompt: string, _userPrompt: string): Promise<string> {
		return '';
	}

	async summarize(_systemPrompt: string, _userPrompt: string): Promise<string> {
		return '';
	}

	async embedImage(_path: string): Promise<Float32Array> {
		return new Float32Array(0);
	}

	async embed(_text: string): Promise<Float32Array | null> {
		return null;
	}
}

export const noopProvider = new NoopProvider();

/**
 * LLM 提供者接口（与 agentmemory MemoryProvider 一致）
 */
export interface LLMProvider {
	name: string;
	compress(systemPrompt: string, userPrompt: string): Promise<string>;
	summarize(systemPrompt: string, userPrompt: string): Promise<string>;
}

/**
 * Embedding 提供者接口
 */
export interface EmbeddingProvider {
	name: string;
	dimensions: number;
	embed(text: string): Promise<Float32Array | number[] | null>;
	embedBatch?(texts: string[]): Promise<Float32Array[]>;
	embedImage?(path: string): Promise<Float32Array | number[]>;
}
