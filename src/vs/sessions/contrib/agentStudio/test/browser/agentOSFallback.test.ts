/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { AgentOSService } from '../agentOSService.js';

suite('AgentOS Model Fallback (provider-aware & user-facing error)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// 直接构造真实 AgentOSService（绕过 DI），仅 stub 构造器所需的 4 个服务。
	function createAgentOSService(): any {
		const logService = new NullLogService();
		const wsStub: any = { getWorkspace: () => ({ folders: [] as any[] }) };
		const pathStub: any = { userHome: async () => ({ scheme: 'file', path: '/tmp' } as any) };
		const fileStub: any = {};
		return new (AgentOSService as any)(logService, wsStub, pathStub, fileStub) as any;
	}

	// 构造一个支持 listModels 的 provider stub
	function makeProvider(id: string, modelIds: string[], chatImpl?: (modelId: string) => any): any {
		return {
			id,
			name: id,
			priority: 0,
			onDidChangeModels: { fire() {}, /* Event */ } as any,
			listModels: async () => modelIds.map(mid => ({ id: mid, name: mid } as any)),
			getAuthStatus: () => ({ status: 'authenticated' } as any),
			chat: chatImpl ?? (async function* () { yield { type: 'text', text: 'ok' } as any; }),
		};
	}

	// ─── _resolveFallbackCandidates：provider-aware 解析 ─────────────────────────
	test('_resolveFallbackCandidates returns hardcoded minus primary when no active provider', async () => {
		const svc = createAgentOSService();
		try {
			svc._modelProviders = [];
			svc._activeSelection = { providerId: 'p', modelId: 'gpt-4o' };
			const candidates = await svc._resolveFallbackCandidates('gpt-4o');
			// gpt-4o 被排除，其余硬编码保留
			assert.deepStrictEqual(candidates, ['gpt-4-turbo', 'gpt-3.5-turbo']);
		} finally {
			svc.dispose();
		}
	});

	test('_resolveFallbackCandidates keeps provider-supported hardcoded fallbacks and adds other available models', async () => {
		const svc = createAgentOSService();
		try {
			const provider = makeProvider('ioa', ['primary-model', 'gpt-4o', 'claude-sonnet-4', 'some-other']);
			svc._modelProviders = [provider];
			svc._activeSelection = { providerId: 'ioa', modelId: 'primary-model' };

			const candidates = await svc._resolveFallbackCandidates('primary-model');
			// 主模型排除；gpt-4o 是 provider 支持的硬编码 fallback → 保留
			assert.ok(candidates.includes('gpt-4o'), 'supported hardcoded fallback should be kept');
			assert.ok(!candidates.includes('primary-model'), 'primary must be excluded');
			// provider 的其它可用模型也应被纳入（至少 claude-sonnet-4）
			assert.ok(candidates.includes('claude-sonnet-4'), 'other available models should be added');
		} finally {
			svc.dispose();
		}
	});

	test('_resolveFallbackCandidates drops hardcoded IDs the provider does NOT support (provider-aware)', async () => {
		const svc = createAgentOSService();
		try {
			// provider 一个 gpt-* 都不支持 → 此前硬编码 fallback 会立刻失败/挂起
			const provider = makeProvider('ioa', ['primary-model', 'claude-sonnet-4', 'claude-opus']);
			svc._modelProviders = [provider];
			svc._activeSelection = { providerId: 'ioa', modelId: 'primary-model' };

			const candidates = await svc._resolveFallbackCandidates('primary-model');
			assert.ok(!candidates.includes('gpt-4o'), 'unsupported hardcoded gpt-4o must be dropped');
			assert.ok(!candidates.includes('gpt-4-turbo'), 'unsupported gpt-4-turbo must be dropped');
			assert.ok(candidates.length > 0, 'should fall back to provider-available models');
			assert.ok(candidates.every(c => c !== 'primary-model'));
		} finally {
			svc.dispose();
		}
	});

	test('_resolveFallbackCandidates falls back to hardcoded list when listModels throws', async () => {
		const svc = createAgentOSService();
		try {
			const provider = makeProvider('ioa', []);
			provider.listModels = async () => { throw new Error('listModels boom'); };
			svc._modelProviders = [provider];
			svc._activeSelection = { providerId: 'ioa', modelId: 'gpt-4o' };

			const candidates = await svc._resolveFallbackCandidates('gpt-4o');
			assert.deepStrictEqual(candidates, ['gpt-4-turbo', 'gpt-3.5-turbo']);
		} finally {
			svc.dispose();
		}
	});

	// ─── _formatUserFacingError：清晰中文提示 ──────────────────────────────────
	test('_formatUserFacingError produces a clear Chinese message for stream idle TimeoutError', () => {
		const svc = createAgentOSService();
		try {
			const timeout = new DOMException('Stream idle timeout after 180000ms', 'TimeoutError');
			const msg = svc._formatUserFacingError(timeout, ['gpt-4-turbo', 'claude-sonnet-4']);
			assert.ok(msg.includes('模型响应超时'), 'should mention timeout in Chinese');
			assert.ok(msg.includes('gpt-4-turbo') && msg.includes('claude-sonnet-4'), 'should list tried fallback models');
			assert.ok(msg.includes('建议'), 'should include actionable advice');
			assert.ok(!msg.includes('TimeoutError'), 'should not leak raw TimeoutError class name');
		} finally {
			svc.dispose();
		}
	});

	test('_formatUserFacingError produces a clear Chinese message for a generic failure', () => {
		const svc = createAgentOSService();
		try {
			const err = new Error('connection reset by peer');
			const msg = svc._formatUserFacingError(err, ['gpt-4-turbo']);
			assert.ok(msg.includes('所有模型均调用失败'), 'should state all models failed');
			assert.ok(msg.includes('gpt-4-turbo'), 'should list tried fallback models');
			assert.ok(msg.includes('connection reset by peer'), 'should include last error message');
		} finally {
			svc.dispose();
		}
	});

	// ─── 集成：主模型超时 → 走 fallback → 全部失败 → 友好中文错误 ─────────────────
	test('_executeWithFallback yields a friendly Chinese error when primary times out and all fallbacks fail', async () => {
		const svc = createAgentOSService();
		try {
			const provider = makeProvider('ioa', ['primary-model', 'gpt-4o', 'claude-sonnet-4']);
			// 每个模型（主 + 备）都抛 TimeoutError
			provider.chat = () => { throw new DOMException('idle', 'TimeoutError'); };
			svc._modelProviders = [provider];
			svc._activeSelection = { providerId: 'ioa', modelId: 'primary-model' };

			const primary = async function* () {
				throw new DOMException('idle', 'TimeoutError');
			};

			const deltas: any[] = [];
			for await (const d of svc._executeWithFallback(primary, { messages: [], systemPrompt: 'sys' } as any)) {
				deltas.push(d);
			}

			const errorDelta = deltas.find((d: any) => d.type === 'error');
			assert.ok(errorDelta, 'should emit a final error delta');
			assert.ok(errorDelta.content.includes('模型响应超时'), 'error must be the friendly Chinese timeout message');
		} finally {
			svc.dispose();
		}
	});

	test('_executeWithFallback switches to a working fallback model on primary TimeoutError', async () => {
		const svc = createAgentOSService();
		try {
			const provider = makeProvider('ioa', ['primary-model', 'gpt-4o', 'claude-sonnet-4']);
			// 主模型抛超时；第一个 fallback 成功
			let calls = 0;
			provider.chat = (modelId: string) => {
				calls++;
				if (calls === 1 && modelId === 'primary-model') {
					throw new DOMException('idle', 'TimeoutError');
				}
				return (async function* () { yield { type: 'text', text: `answer from ${modelId}` } as any; })();
			};
			svc._modelProviders = [provider];
			svc._activeSelection = { providerId: 'ioa', modelId: 'primary-model' };

			const primary = async function* () {
				throw new DOMException('idle', 'TimeoutError');
			};

			const deltas: any[] = [];
			for await (const d of svc._executeWithFallback(primary, { messages: [], systemPrompt: 'sys' } as any)) {
				deltas.push(d);
			}

			const switchDelta = deltas.find((d: any) => d.type === 'text' && d.content.includes('正在切换到备用模型'));
			assert.ok(switchDelta, 'should emit a switching notice');
			const textDelta = deltas.find((d: any) => d.type === 'text' && d.content.includes('answer from'));
			assert.ok(textDelta, 'should yield content from the working fallback model');
			assert.ok(!deltas.some((d: any) => d.type === 'error'), 'should NOT emit error when a fallback succeeds');
		} finally {
			svc.dispose();
		}
	});
});
