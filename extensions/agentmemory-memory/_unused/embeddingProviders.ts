/*---------------------------------------------------------------------------------------------
 *  Embedding Provider 工厂 — 根据环境变量自动选择嵌入提供者。
 *  1:1 复刻 agentmemory src/providers/embedding/index.ts
 *
 *  优先级（自动检测）：
 *    1. EMBEDDING_PROVIDER=local  → 本地 xenova（all-MiniLM-L6-v2, 离线免费）
 *    2. EMBEDDING_PROVIDER=openai → OpenAI text-embedding-3-small
 *    3. EMBEDDING_PROVIDER=gemini → Gemini gemini-embedding-001
 *    4. EMBEDDING_PROVIDER=cohere → Cohere embed-english-v3.0
 *    5. EMBEDDING_PROVIDER=voyage → Voyage voyage-code-3
 *    6. EMBEDDING_PROVIDER=clip   → CLIP clip-vit-base-patch32（多模态）
 *    7. 无配置                     → null（BM25-only 模式）
 *
 *  也可通过 OPENAI_API_KEY / GEMINI_API_KEY 等自动检测。
 *--------------------------------------------------------------------------------------------*/

import type { EmbeddingProvider } from './noopProvider.js';
import { OpenAIEmbeddingProvider } from './openaiEmbedding.js';
import { GeminiEmbeddingProvider } from './geminiEmbedding.js';
import { CohereEmbeddingProvider } from './cohereEmbedding.js';
import { VoyageEmbeddingProvider } from './voyageEmbedding.js';
import { ClipEmbeddingProvider } from './clipEmbedding.js';

function getEnv(key: string): string | undefined {
	return (globalThis as { process?: { env?: Record<string, string> } })?.process?.env?.[key];
}

/**
 * 创建嵌入提供者（自动检测）
 */
export function createEmbeddingProvider(): EmbeddingProvider | null {
	const providerName = getEnv('EMBEDDING_PROVIDER')?.toLowerCase();

	// 显式指定
	if (providerName) {
		switch (providerName) {
			case 'local':
				return null; // 本地 xenova 由 vectorIndex.ts 内部处理
			case 'openai':
				return new OpenAIEmbeddingProvider();
			case 'gemini':
				return new GeminiEmbeddingProvider();
			case 'cohere':
				return new CohereEmbeddingProvider();
			case 'voyage':
				return new VoyageEmbeddingProvider();
			case 'clip':
				return new ClipEmbeddingProvider();
			default:
				console.warn(`[AgentMemory] Unknown EMBEDDING_PROVIDER: ${providerName}`);
				return null;
		}
	}

	// 自动检测（根据可用的 API key）
	try {
		if (getEnv('OPENAI_API_KEY') && getEnv('OPENAI_API_KEY_FOR_LLM') !== 'false') {
			return new OpenAIEmbeddingProvider();
		}
	} catch { /* key missing, try next */ }

	try {
		if (getEnv('GEMINI_API_KEY')) {
			return new GeminiEmbeddingProvider();
		}
	} catch { /* key missing, try next */ }

	try {
		if (getEnv('COHERE_API_KEY')) {
			return new CohereEmbeddingProvider();
		}
	} catch { /* key missing, try next */ }

	try {
		if (getEnv('VOYAGE_API_KEY')) {
			return new VoyageEmbeddingProvider();
		}
	} catch { /* key missing, try next */ }

	// 默认：本地 xenova（由 vectorIndex.ts 处理）或 BM25-only
	return null;
}

export {
	OpenAIEmbeddingProvider,
	GeminiEmbeddingProvider,
	CohereEmbeddingProvider,
	VoyageEmbeddingProvider,
	ClipEmbeddingProvider,
};
