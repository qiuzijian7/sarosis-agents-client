/*---------------------------------------------------------------------------------------------
 *  agentMemoryInjection.test.ts — <agentmemory-context> 注入节奏回归测试
 *
 *  P0-1（2026-09-09）：修复「已注入即 return」使 isNewSession 恒 true、
 *  「后续轮次完整注入」分支不可达的缺陷。本测试锁定修复后的注入节奏：
 *    首轮 → 仅元信息（防旧结论锚定）
 *    次轮 → 完整注入（一次性）
 *    之后 → 完全跳过（幂等）
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { injectMemoryContext } from '../../browser/agentMemoryInjection.js';

const CURATION_BLOCK = 'CURATION-BLOCK-CONTENT-应完整注入';

function makeProvider() {
	return {
		loadContext: async () => ({
			systemPrompt: CURATION_BLOCK,
			longTermMemories: [],
			shortTermMemories: [],
			contextBlocks: 1,
			contextTokens: 20,
		}),
		triggerHook: async () => undefined,
	};
}

function makeDeps() {
	return {
		logService: new NullLogService(),
		getActiveMemoryProvider: () => makeProvider(),
		injectedSessions: new Set<string>(),
		metaInjectedSessions: new Set<string>(),
	};
}

function makeRequest(overrides: Partial<{ sessionId: string; agentId: string }> = {}) {
	return {
		sessionId: 'sess-1',
		agentId: 'agent-1',
		messages: [{ role: 'user', content: 'hello' }],
		...overrides,
	} as any;
}

async function runInjection(deps: any, request: any, messages: any[]) {
	const gen = injectMemoryContext(deps, request, messages);
	const deltas: any[] = [];
	let result = await gen.next();
	while (!result.done) {
		deltas.push(result.value);
		result = await gen.next();
	}
	return { messages: result.value.messages, deltas };
}

suite('agentMemoryInjection — 注入节奏（P0-1）', () => {
	const prevEnv = process.env['AGENTMEMORY_INJECT_CONTEXT'];

	suiteSetup(() => { process.env['AGENTMEMORY_INJECT_CONTEXT'] = 'true'; });
	suiteTeardown(() => {
		if (prevEnv === undefined) { delete process.env['AGENTMEMORY_INJECT_CONTEXT']; }
		else { process.env['AGENTMEMORY_INJECT_CONTEXT'] = prevEnv; }
	});

	test('开关关闭时不注入（默认姿态）', async () => {
		delete process.env['AGENTMEMORY_INJECT_CONTEXT'];
		try {
			const deps = makeDeps();
			const messages = [{ role: 'system', content: 'base' }, { role: 'user', content: 'q' }];
			const { messages: out } = await runInjection(deps, makeRequest(), messages);
			assert.strictEqual(out.length, 2, '不应新增任何消息');
		} finally {
			process.env['AGENTMEMORY_INJECT_CONTEXT'] = 'true';
		}
	});

	test('首轮：仅注入元信息，不暴露具体内容', async () => {
		const deps = makeDeps();
		const { messages, deltas } = await runInjection(deps, makeRequest(), [{ role: 'user', content: 'q' }]);
		const injected = messages.find((m: any) => m.role === 'system' && m.content.includes('agentmemory-context'));
		assert.ok(injected, '应注入 agentmemory-context 系统消息');
		assert.ok(injected.content.includes('NEW SESSION'), '应包含新会话元信息标记');
		assert.ok(!injected.content.includes(CURATION_BLOCK), '首轮不得暴露策展块内容');
		assert.strictEqual(deltas[0]?.metadata?.newSession, true);
		assert.ok(deps.injectedSessions.has('sess-1'), 'injectedSessions 应标记');
		assert.ok(deps.metaInjectedSessions.has('sess-1'), 'metaInjectedSessions 应标记');
	});

	test('次轮：恢复完整注入（此前不可达分支，P0-1 核心修复）', async () => {
		const deps = makeDeps();
		await runInjection(deps, makeRequest(), [{ role: 'user', content: 'q1' }]);
		const { messages, deltas } = await runInjection(deps, makeRequest(), [{ role: 'user', content: 'q2' }]);
		const injected = messages.find((m: any) => m.role === 'system' && m.content.includes('agentmemory-context'));
		assert.ok(injected, '次轮应注入');
		assert.ok(injected.content.includes(CURATION_BLOCK), '次轮应包含完整策展块内容');
		assert.ok(!injected.content.includes('NEW SESSION'), '次轮不再注入元信息标记');
		assert.strictEqual(deltas[0]?.metadata?.newSession, undefined, '次轮不是 newSession 元信息模式');
		assert.ok(deps.injectedSessions.has('sess-1'));
		assert.ok(!deps.metaInjectedSessions.has('sess-1'), '完整注入后应清除 meta-only 标记');
	});

	test('第三轮起：完全跳过（幂等，不重复注入）', async () => {
		const deps = makeDeps();
		await runInjection(deps, makeRequest(), [{ role: 'user', content: 'q1' }]);
		await runInjection(deps, makeRequest(), [{ role: 'user', content: 'q2' }]);
		const before = [{ role: 'user', content: 'q3' }];
		const { messages: out, deltas } = await runInjection(deps, makeRequest(), before);
		assert.strictEqual(out, before, '消息数组不应被修改（同一引用）');
		assert.strictEqual(deltas.length, 0, '不应产生 memory_injected delta');
	});

	test('不同 session 相互独立（meta-only 不串台）', async () => {
		const deps = makeDeps();
		await runInjection(deps, makeRequest({ sessionId: 'sess-A' }), [{ role: 'user', content: 'q' }]);
		assert.ok(deps.metaInjectedSessions.has('sess-A'));
		assert.ok(!deps.injectedSessions.has('sess-B'));
		const { messages } = await runInjection(deps, makeRequest({ sessionId: 'sess-B' }), [{ role: 'user', content: 'q' }]);
		const injected = messages.find((m: any) => m.role === 'system' && m.content.includes('agentmemory-context'));
		assert.ok(injected?.content.includes('NEW SESSION'), 'sess-B 首轮仍走元信息模式');
	});
});
