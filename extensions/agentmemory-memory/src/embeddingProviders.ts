/*---------------------------------------------------------------------------------------------
 *  Embedding Provider 工厂（P1-1，2026-09-19 从 `_unused/` 恢复并改造）
 *
 *  优先级（**检查已配置的 provider 和 model**）：
 *    ① `EMBEDDING_PROVIDER` env 显式指定（openai / gemini / local）
 *    ② env 自动检测：`GEMINI_API_KEY` ⇒ gemini；`OPENAI_API_KEY` / `OPENAI_BASE_URL` ⇒ openai
 *       —— 主进程 `_initAgentMemoryLlm()` 已把 BYOK 的 apiKey 注入这些 env ⇒
 *       即"按已配置的 BYOK provider 选择 embedding provider"（openrouter→openai、gemini→gemini、ollama→openai）
 *    ③ null（本地 xenova / trigram 兜底）
 *
 *  模型可由 env 覆盖：`OPENAI_EMBEDDING_MODEL` / `GEMINI_EMBEDDING_MODEL`（满足"检查 model 的配置"）。
 *  维度由 provider 的 `dimensions` 提供（OpenAI 1536 / Gemini 768 / xenova 384 / trigram 384），
 *  `VectorIndex.add()` 会自动适配第一条向量的维度；**切换 provider ⇒ 维度变化 ⇒ 需要全量重建**
 *  （由 `indexCache` 的 provider 记录触发，见 host.mjs）。
 *--------------------------------------------------------------------------------------------*/

import type { EmbeddingProvider } from './noopProvider.js';
import { OpenAIEmbeddingProvider } from './openaiEmbedding.js';
import { GeminiEmbeddingProvider } from './geminiEmbedding.js';

function getEnv(key: string): string | undefined {
	return (globalThis as { process?: { env?: Record<string, string> } })?.process?.env?.[key];
}

export function createEmbeddingProvider(): EmbeddingProvider | null {
	const providerName = getEnv('EMBEDDING_PROVIDER')?.toLowerCase();

	// ① 显式指定
	if (providerName) {
		switch (providerName) {
			case 'local': return null; // 本地 xenova 由 vectorIndex.ts 内部处理
			case 'openai': return new OpenAIEmbeddingProvider();
			case 'gemini': return new GeminiEmbeddingProvider();
			default:
				console.warn(`[AgentMemory] Unknown EMBEDDING_PROVIDER: ${providerName}`);
				return null;
		}
	}

	// ② env 自动检测（主进程已把 BYOK apiKey 注入这些 env ⇒ 即"按已配置的 BYOK provider 选择"）
	try {
		if (getEnv('GEMINI_API_KEY')) { return new GeminiEmbeddingProvider(); }
	} catch { /* key missing, try next */ }
	try {
		if (getEnv('OPENAI_API_KEY') || getEnv('OPENAI_BASE_URL')) { return new OpenAIEmbeddingProvider(); }
	} catch { /* key missing */ }

	// ③ 本地 xenova（由 vectorIndex.ts 处理）或 trigram 兜底
	return null;
}

export { OpenAIEmbeddingProvider, GeminiEmbeddingProvider };
