/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  embeddingConfigResolver.test.ts — 「辅助模型 → Embedding」配置解析单元测试。
 *
 *  覆盖（解除对 knowledge-base-expert agent 依赖后的统一入口）：
 *   1. resolveAuxEmbeddingConfig — 永远返回带默认值的配置（默认 model/text-embedding-3-small、
 *      dimensions/512）；空白/非法 provider 归一为 'auto'；非法 dimensions 回退默认。
 *   2. resolveAuxEmbeddingProviderId — 显式非 'auto' 直接返回；'auto' 回退全局
 *      embedding.provider；仍空/为 'auto' 返回 undefined（交由主路径决策）。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import {
	AGENT_STUDIO_AUX_EMBEDDING_PROVIDER,
	AGENT_STUDIO_AUX_EMBEDDING_MODEL,
	AGENT_STUDIO_AUX_EMBEDDING_DIMENSIONS,
	AGENT_STUDIO_EMBEDDING_PROVIDER,
} from '../../common/constants.js';
import {
	resolveAuxEmbeddingConfig,
	resolveAuxEmbeddingProviderId,
	DEFAULT_AUX_EMBEDDING_MODEL,
	DEFAULT_AUX_EMBEDDING_DIMENSIONS,
} from './embeddingConfigResolver.js';

/** 最小 IConfigurationService mock：只实现 getValue，按需注入键值。 */
class MockConfig {
	private readonly _store = new Map<string, unknown>();
	set(key: string, value: unknown): void { this._store.set(key, value); }
	clear(key: string): void { this._store.delete(key); }
	getValue(key: string): unknown { return this._store.get(key); }
}

function asConfig(m: MockConfig): IConfigurationService {
	return m as unknown as IConfigurationService;
}

describe('embeddingConfigResolver', () => {

	describe('resolveAuxEmbeddingConfig', () => {
		it('空配置返回默认值（provider=auto / model / 512）', () => {
			const cfg = resolveAuxEmbeddingConfig(asConfig(new MockConfig()));
			assert.strictEqual(cfg.providerId, 'auto');
			assert.strictEqual(cfg.modelId, DEFAULT_AUX_EMBEDDING_MODEL);
			assert.strictEqual(cfg.dimensions, DEFAULT_AUX_EMBEDDING_DIMENSIONS);
		});

		it('显式配置被原样采用', () => {
			const m = new MockConfig();
			m.set(AGENT_STUDIO_AUX_EMBEDDING_PROVIDER, 'openrouter');
			m.set(AGENT_STUDIO_AUX_EMBEDDING_MODEL, 'my-embed-model');
			m.set(AGENT_STUDIO_AUX_EMBEDDING_DIMENSIONS, 1024);
			const cfg = resolveAuxEmbeddingConfig(asConfig(m));
			assert.strictEqual(cfg.providerId, 'openrouter');
			assert.strictEqual(cfg.modelId, 'my-embed-model');
			assert.strictEqual(cfg.dimensions, 1024);
		});

		it('provider 空白/全空白归一为 auto', () => {
			for (const bad of ['', '   ', undefined]) {
				const m = new MockConfig();
				if (bad === undefined) { m.clear(AGENT_STUDIO_AUX_EMBEDDING_PROVIDER); }
				else { m.set(AGENT_STUDIO_AUX_EMBEDDING_PROVIDER, bad); }
				const cfg = resolveAuxEmbeddingConfig(asConfig(m));
				assert.strictEqual(cfg.providerId, 'auto', `输入=${JSON.stringify(bad)}`);
			}
		});

		it('model 空白回退默认', () => {
			const m = new MockConfig();
			m.set(AGENT_STUDIO_AUX_EMBEDDING_MODEL, '   ');
			const cfg = resolveAuxEmbeddingConfig(asConfig(m));
			assert.strictEqual(cfg.modelId, DEFAULT_AUX_EMBEDDING_MODEL);
		});

		it('dimensions 非法（0 / 负数 / NaN / 非数字）回退 512', () => {
			for (const bad of [0, -16, NaN, 'abc', undefined]) {
				const m = new MockConfig();
				if (bad === undefined) { m.clear(AGENT_STUDIO_AUX_EMBEDDING_DIMENSIONS); }
				else { m.set(AGENT_STUDIO_AUX_EMBEDDING_DIMENSIONS, bad); }
				const cfg = resolveAuxEmbeddingConfig(asConfig(m));
				assert.strictEqual(cfg.dimensions, DEFAULT_AUX_EMBEDDING_DIMENSIONS, `输入=${JSON.stringify(bad)}`);
			}
		});

		it('dimensions 为浮点时被向下取整', () => {
			const m = new MockConfig();
			m.set(AGENT_STUDIO_AUX_EMBEDDING_DIMENSIONS, 768.9);
			const cfg = resolveAuxEmbeddingConfig(asConfig(m));
			assert.strictEqual(cfg.dimensions, 768);
		});
	});

	describe('resolveAuxEmbeddingProviderId', () => {
		it('显式非 auto provider 直接返回', () => {
			const m = new MockConfig();
			m.set(AGENT_STUDIO_AUX_EMBEDDING_PROVIDER, 'openrouter');
			assert.strictEqual(resolveAuxEmbeddingProviderId(asConfig(m)), 'openrouter');
		});

		it('provider=auto 且全局 embedding.provider 已设置 → 回退全局', () => {
			const m = new MockConfig();
			m.set(AGENT_STUDIO_AUX_EMBEDDING_PROVIDER, 'auto');
			m.set(AGENT_STUDIO_EMBEDDING_PROVIDER, 'local');
			assert.strictEqual(resolveAuxEmbeddingProviderId(asConfig(m)), 'local');
		});

		it('provider=auto 且全局为空/auto → 返回 undefined', () => {
			for (const g of ['', 'auto', undefined]) {
				const m = new MockConfig();
				m.set(AGENT_STUDIO_AUX_EMBEDDING_PROVIDER, 'auto');
				if (g === undefined) { m.clear(AGENT_STUDIO_EMBEDDING_PROVIDER); }
				else { m.set(AGENT_STUDIO_EMBEDDING_PROVIDER, g); }
				assert.strictEqual(resolveAuxEmbeddingProviderId(asConfig(m)), undefined, `全局=${JSON.stringify(g)}`);
			}
		});

		it('provider 空白视为 auto 并回退全局', () => {
			const m = new MockConfig();
			m.set(AGENT_STUDIO_AUX_EMBEDDING_PROVIDER, '   ');
			m.set(AGENT_STUDIO_EMBEDDING_PROVIDER, 'global-provider');
			assert.strictEqual(resolveAuxEmbeddingProviderId(asConfig(m)), 'global-provider');
		});
	});
});
