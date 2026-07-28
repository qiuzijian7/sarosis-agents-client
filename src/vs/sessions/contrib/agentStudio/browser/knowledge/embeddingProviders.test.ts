/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  embeddingProviders.test.ts — 供应商适配层 + 配置解析 + 分块/重试单元测试。
 *
 *  覆盖：
 *   1. resolveEmbeddingAdapter — 工厂按 providerId 正确返回适配器 / undefined
 *   2. resolveOrFallbackAdapter — 未配置时回退到 KB_FALLBACK_PROVIDER
 *   3. resolveEmbeddingConfigForProvider — 含 API key / 不含 / Ollama 免 key
 *   4. normalizeBaseUrl — 去尾斜杠、保留 /v1 路径
 *   5. KB_FALLBACK_PROVIDER — 常量值
 *   6. DEFAULT_EMBEDDING_CONFIG — 各 provider 的默认模型/维度
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { describe, it } from 'node:test';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';

import { BUILTIN_BYOK_PROVIDERS } from '../builtInBYOKModelProvider.js';
import {
	resolveEmbeddingAdapter,
	resolveOrFallbackAdapter,
} from './embeddingProviders.js';
import {
	resolveEmbeddingConfigForProvider,
	normalizeBaseUrl,
	KB_FALLBACK_PROVIDER,
	DEFAULT_EMBEDDING_CONFIG,
} from './builtinEmbeddingProvider.js';

// ── Mock config ─────────────────────────────────────────────────────────────

const OpenRouterDef = BUILTIN_BYOK_PROVIDERS.find(p => p.id === 'openrouter')!;
const OllamaDef = BUILTIN_BYOK_PROVIDERS.find(p => p.id === 'ollama')!;

class MockConfig {
	private readonly _store = new Map<string, unknown>();
	set(key: string, value: unknown): void { this._store.set(key, value); }
	clear(key: string): void { this._store.delete(key); }
	getValue(key: string): unknown { return this._store.get(key); }
}

function asConfig(m: MockConfig): IConfigurationService {
	return m as unknown as IConfigurationService;
}

function configureProvider(m: MockConfig, def: typeof OpenRouterDef, apiKey: string | undefined): void {
	if (apiKey !== undefined) { m.set(def.apiKeyConfigKey, apiKey); }
	if (def.baseUrlConfigKey) {
		m.set(def.baseUrlConfigKey, def.defaultBaseUrl ?? '');
	}
}

// ── resolveEmbeddingAdapter ─────────────────────────────────────────────────

describe('resolveEmbeddingAdapter', () => {

	it('OpenRouter 已配置 → 返回 OpenAICompatibleAdapter', () => {
		const m = new MockConfig();
		configureProvider(m, OpenRouterDef, 'sk-test-key');
		const adapter = resolveEmbeddingAdapter(asConfig(m), 'openrouter');
		assert.ok(adapter, '应返回 adapter');
		assert.strictEqual(adapter.providerId, 'openrouter');
	});

	it('OpenRouter 未配置 → 返回 undefined', () => {
		const m = new MockConfig();
		// 不设 apiKey
		const adapter = resolveEmbeddingAdapter(asConfig(m), 'openrouter');
		assert.strictEqual(adapter, undefined);
	});

	it('Ollama 不需要 API key → 返回 OllamaAdapter', () => {
		const m = new MockConfig();
		const adapter = resolveEmbeddingAdapter(asConfig(m), 'ollama');
		assert.ok(adapter, 'Ollama 应不需 key 即返回 adapter');
		assert.strictEqual(adapter.providerId, 'ollama');
	});

	it('不存在的 provider → 返回 undefined', () => {
		const m = new MockConfig();
		const adapter = resolveEmbeddingAdapter(asConfig(m), 'nonexistent-provider');
		assert.strictEqual(adapter, undefined);
	});
});

// ── resolveOrFallbackAdapter ────────────────────────────────────────────────

describe('resolveOrFallbackAdapter', () => {

	it('主 provider 可用 → 返回主 adapter', () => {
		const m = new MockConfig();
		configureProvider(m, OpenRouterDef, 'sk-main');
		const adapter = resolveOrFallbackAdapter(asConfig(m), 'openrouter');
		assert.ok(adapter);
		assert.strictEqual(adapter.providerId, 'openrouter');
	});

	it('主 provider 不可用 → 回退到 KB_FALLBACK_PROVIDER', () => {
		const m = new MockConfig();
		// 主 provider 不存在
		const adapter = resolveOrFallbackAdapter(asConfig(m), 'nonexistent');
		// openrouter 也未配置 → adapter 为 undefined
		assert.strictEqual(adapter, undefined,
			'主不存在 + fallback 也未配置 → 返回 undefined');
	});

	it('主 provider 不可用但 fallback 已配置 → 返回 fallback', () => {
		const m = new MockConfig();
		configureProvider(m, OpenRouterDef, 'sk-fallback');
		const adapter = resolveOrFallbackAdapter(asConfig(m), 'nonexistent');
		assert.ok(adapter, '应回退到已配置的 fallback');
		assert.strictEqual(adapter.providerId, KB_FALLBACK_PROVIDER);
	});

	it('主与 fallback 相同 → 不重复尝试', () => {
		const m = new MockConfig();
		configureProvider(m, OpenRouterDef, 'sk-same');
		const adapter = resolveOrFallbackAdapter(asConfig(m), 'openrouter');
		assert.ok(adapter);
		assert.strictEqual(adapter.providerId, 'openrouter');
	});
});

// ── resolveEmbeddingConfigForProvider ───────────────────────────────────────

describe('resolveEmbeddingConfigForProvider', () => {

	it('已配置 provider → 返回 baseUrl/apiKey/model/dimensions', () => {
		const m = new MockConfig();
		configureProvider(m, OpenRouterDef, 'sk-or-key');
		const res = resolveEmbeddingConfigForProvider(asConfig(m), 'openrouter');
		assert.ok(res);
		assert.ok(res.baseUrl, 'baseUrl 不应为空');
		assert.strictEqual(res.apiKey, 'sk-or-key');
		assert.strictEqual(res.model, DEFAULT_EMBEDDING_CONFIG['openrouter']!.model);
		assert.strictEqual(res.dimensions, DEFAULT_EMBEDDING_CONFIG['openrouter']!.dimensions);
	});

	it('未配置 key 且非 optional → 返回 null', () => {
		const m = new MockConfig();
		const res = resolveEmbeddingConfigForProvider(asConfig(m), 'openrouter');
		assert.strictEqual(res, null);
	});

	it('Ollama 无 key → 返回配置（apiKeyOptional=true）', () => {
		const m = new MockConfig();
		const res = resolveEmbeddingConfigForProvider(asConfig(m), 'ollama');
		if (OllamaDef?.apiKeyOptional) {
			assert.ok(res, 'Ollama 应不需 key 即返回配置');
		}
	});

	it('未知 provider → 返回 null', () => {
		const m = new MockConfig();
		const res = resolveEmbeddingConfigForProvider(asConfig(m), 'unknown-xxx');
		assert.strictEqual(res, null);
	});
});

// ── normalizeBaseUrl ────────────────────────────────────────────────────────

describe('normalizeBaseUrl', () => {

	it('去尾斜杠', () => {
		assert.strictEqual(normalizeBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
	});

	it('多个尾斜杠全去', () => {
		assert.strictEqual(normalizeBaseUrl('https://api.example.com///'), 'https://api.example.com');
	});

	it('无尾斜杠不变', () => {
		assert.strictEqual(normalizeBaseUrl('https://api.example.com/v1'), 'https://api.example.com/v1');
	});

	it('前后空格 trim', () => {
		assert.strictEqual(normalizeBaseUrl('  https://api.example.com/v1/  '), 'https://api.example.com/v1');
	});

	it('空串不变', () => {
		assert.strictEqual(normalizeBaseUrl(''), '');
	});
});

// ── KB_FALLBACK_PROVIDER ────────────────────────────────────────────────────

describe('KB_FALLBACK_PROVIDER', () => {

	it('值为 openrouter', () => {
		assert.strictEqual(KB_FALLBACK_PROVIDER, 'openrouter');
	});

	it('在 BUILTIN_BYOK_PROVIDERS 中可找到', () => {
		const def = BUILTIN_BYOK_PROVIDERS.find(p => p.id === KB_FALLBACK_PROVIDER);
		assert.ok(def, `KB_FALLBACK_PROVIDER "${KB_FALLBACK_PROVIDER}" 应在 BUILTIN_BYOK_PROVIDERS 中注册`);
	});
});

// ── DEFAULT_EMBEDDING_CONFIG ────────────────────────────────────────────────

describe('DEFAULT_EMBEDDING_CONFIG', () => {

	it('openrouter 默认为 text-embedding-3-small / 512', () => {
		const c = DEFAULT_EMBEDDING_CONFIG['openrouter'];
		assert.ok(c);
		assert.strictEqual(c.model, 'text-embedding-3-small');
		assert.strictEqual(c.dimensions, 512);
	});

	it('ollama 默认为 nomic-embed-text / 768', () => {
		const c = DEFAULT_EMBEDDING_CONFIG['ollama'];
		assert.ok(c);
		assert.strictEqual(c.model, 'nomic-embed-text');
		assert.strictEqual(c.dimensions, 768);
	});

	it('已知 provider 均有 model 和 dimensions', () => {
		for (const [id, cfg] of Object.entries(DEFAULT_EMBEDDING_CONFIG)) {
			assert.ok(cfg.model, `${id} 的 model 不应为空`);
			assert.ok(typeof cfg.dimensions === 'number' && cfg.dimensions > 0,
				`${id} 的 dimensions 应为正数，实际: ${cfg.dimensions}`);
		}
	});
});

// ── Adapter 类型检查 ────────────────────────────────────────────────────────

describe('IEmbeddingProviderAdapter', () => {

	it('OpenAICompatibleAdapter 实现 IEmbeddingProviderAdapter', () => {
		const m = new MockConfig();
		configureProvider(m, OpenRouterDef, 'sk-typecheck');
		const adapter = resolveEmbeddingAdapter(asConfig(m), 'openrouter');
		assert.ok(adapter);
		assert.strictEqual(typeof adapter.embed, 'function');
		assert.strictEqual(typeof adapter.providerId, 'string');
	});

	it('OllamaAdapter 实现 IEmbeddingProviderAdapter', () => {
		const m = new MockConfig();
		const adapter = resolveEmbeddingAdapter(asConfig(m), 'ollama');
		assert.ok(adapter);
		assert.strictEqual(typeof adapter.embed, 'function');
		assert.strictEqual(typeof adapter.providerId, 'string');
	});
});
