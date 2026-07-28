/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { AgentOSService } from '../../browser/agentOSService.js';

suite('AgentOS Model Fallback (provider-aware & user-facing error)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// 直接构造真实 AgentOSService（绕过 DI），仅 stub 构造器所需的 4 个服务。
	function createAgentOSService(): any {
		// 与 AgentOSService 当前构造签名保持一致：
		// (logService, environmentService, workspaceContextService, pathService, fileService, instantiationService)
		const logService = new NullLogService();
		const envStub: any = { userRoamingDataHome: URI.file('/tmp'), appRoot: '/tmp' };
		const wsStub: any = { getWorkspace: () => ({ folders: [] as any[] }) };
		const pathStub: any = { userHome: async () => ({ scheme: 'file', path: '/tmp' } as any) };
		const fileStub: any = {};
		const instStub: any = { invokeFunction: (fn: any) => fn(() => undefined) };
		return new (AgentOSService as any)(logService, envStub, wsStub, pathStub, fileStub, instStub) as any;
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

	// ─── 模型 fallback 已关闭（测试漂移修正 2026-07-26）────────────────────────
	// 现状（agentOSService._executeWithFallback）：仅尝试主执行，失败直接产出
	// 友好中文错误，不再解析/切换备用模型（_resolveFallbackCandidates 已移除，
	// _fallbackModels/_maxFallbackAttempts 配置已注释保留供日后恢复）。
	test('fallback disabled: primary TimeoutError yields friendly error without switching models', async () => {
		const svc = createAgentOSService();
		try {
			const provider = makeProvider('ioa', ['primary-model', 'gpt-4o']);
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
			assert.ok(
				!deltas.some((d: any) => d.type === 'text' && String(d.content).includes('正在切换到备用模型')),
				'no model switch should be attempted while fallback is disabled'
			);
		} finally {
			svc.dispose();
		}
	});

	test('fallback disabled: primary success passes through unchanged', async () => {
		const svc = createAgentOSService();
		try {
			const primary = async function* () {
				yield { type: 'text', content: 'hello' } as any;
			};
			const deltas: any[] = [];
			for await (const d of svc._executeWithFallback(primary, { messages: [], systemPrompt: 'sys' } as any)) {
				deltas.push(d);
			}
			assert.deepStrictEqual(deltas.map((d: any) => d.type), ['text']);
			assert.strictEqual(deltas[0].content, 'hello');
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

});
