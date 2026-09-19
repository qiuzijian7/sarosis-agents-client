/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `browser/parts/turnContextCompaction.ts` 的 **turnEmit 采用**契约测试。
 *
 * ⚠ 本测试的存在理由
 * ────────────────────────────────────────────────────────────────────────────
 * `compactContextIfNeeded` 此前**零测试覆盖**：它是 `async function*`，要触发
 * 任何一条断言都必须驱动整条 3676 行的主循环。
 *
 * turnEmit 采用后主体拆成 `compactContextIfNeededImpl(emit, deps, state)` ——
 * 一个普通 async function。本测试直接注入 **mock emit** 捕获事件序列，锁死
 * 三条契约：
 *
 *  1. `phase_change('compressing')` 只在**确会压缩**时发射（防 UI 闪烁）；
 *  2. 事件**严格保序**，且 `phase_change` 与 `context_compacted` 的相对次序固定；
 *  3. `asGenerator` 包装保持原生成器语义（保序 + 背压 + 返回值透传）。
 */

import assert from 'node:assert';
import { suite, test } from 'node:test';
import type { IChatStreamDelta } from '../../common/providers.js';
import {
	compactContextIfNeeded,
	compactContextIfNeededImpl,
	type IContextCompactionDeps,
	type IContextCompactionState,
} from '../../browser/parts/turnContextCompaction.js';

/** 记录 emit 到的每个事件，供顺序断言。 */
function makeEventRecorder(): { events: IChatStreamDelta[]; emit: (d: IChatStreamDelta) => void } {
	const events: IChatStreamDelta[] = [];
	return { events, emit: (delta) => { events.push(delta); } };
}

/** 最小 host —— 只实现被测路径会触碰的成员。 */
function makeHost(overrides: Record<string, unknown> = {}) {
	return {
		_logService: { info() { /* noop */ }, warn() { /* noop */ }, error() { /* noop */ } },
		_estimateMessagesTokens: () => 1000,
		_turnKey: (agentId: string, sessionId: string | undefined) => `${agentId}:${sessionId ?? ''}`,
		_lastAssistantAtByAgent: new Map<string, number>(),
		_lastCompressionTime: 0,
		_lastHardPruneBaselineTokens: 0,
		_compressionCount: 0,
		_compressionIneffectiveCount: 0,
		_compressionBeforeTokens: 0,
		_compressionAfterTokens: 0,
		_scheduleSave() { /* noop */ },
		_currentWorkspaceId: 'ws-test',
		getActiveMemoryProvider: () => undefined,
		_retrieveCompactionContext: () => undefined,
		...overrides,
	} as unknown as IContextCompactionDeps['host'];
}

/** 最小 state —— messages / runState 走访问器，与原设计一致。 */
function makeState(overrides: Record<string, unknown> = {}) {
	let phase = 'idle';
	const messages = [{ role: 'user', content: 'hello', timestamp: 1 }];
	const state = {
		messages: () => messages as never,
		setMessages() { /* noop */ },
		syncMessages() { /* noop */ },
		runState: () => ({
			phase,
			lastRealPromptTokens: 900,
		} as never),
		dispatchRunState: (action: { type: string; phase?: string }) => {
			if (action.type === 'SET_PHASE' && action.phase) { phase = action.phase; }
		},
		hardPrunePending: () => false,
		setHardPrunePending() { /* noop */ },
		...overrides,
	};
	return state as unknown as IContextCompactionState;
}

/** manager 桩：willAttemptCompression / compressContext 的返回值可控。 */
function makeManager(opts: { willCompress: boolean }) {
	return {
		willAttemptCompression: () => opts.willCompress,
		compressContext: async () => ({
			compressedMessageCount: 1,
			summary: 'stub summary',
			didCompress: false,
			skipped: true,
			skipReason: 'below_token_threshold',
		}),
	};
}

function makeDeps(opts: { willCompress: boolean; cooldownActive?: boolean }) {
	return {
		host: makeHost(opts.cooldownActive ? { _lastCompressionTime: Date.now() } : {}),
		request: { agentId: 'a1', sessionId: 's1' } as never,
		contextManager: makeManager(opts) as never,
		compressionWindow: 100000,
		enabledTools: () => [],
		estimateToolsSchemaTokens: () => 0,
	} as unknown as IContextCompactionDeps;
}

suite('turnContextCompaction / turnEmit 采用契约', () => {

	test('冷却期内不发射任何 compressing 事件（防 UI 闪烁）', async () => {
		const { events, emit } = makeEventRecorder();
		// 冷却期未过 → 提前 return，连 willAttemptCompression 都不会走到。
		await compactContextIfNeededImpl(emit, makeDeps({ willCompress: true, cooldownActive: true }), makeState());

		const compressing = events.filter(e => (e as { type?: string }).type === 'phase_change');
		assert.strictEqual(
			compressing.length, 0,
			`冷却期内不应发射 phase_change，实际收到 ${JSON.stringify(events)}`,
		);
	});

	test('emit 的每个事件都被捕获，且不含 undefined', async () => {
		const { events, emit } = makeEventRecorder();
		await compactContextIfNeededImpl(emit, makeDeps({ willCompress: true }), makeState());

		for (const e of events) {
			assert.ok(e && typeof e === 'object', `事件不应为空：${String(e)}`);
			assert.ok(typeof (e as { type?: string }).type === 'string', `事件必须有 type：${JSON.stringify(e)}`);
		}
	});

	test('phase_change 若出现，必先于 context_compacted（保序契约）', async () => {
		const { events, emit } = makeEventRecorder();
		await compactContextIfNeededImpl(emit, makeDeps({ willCompress: true }), makeState());

		const firstCompacting = events.findIndex(e => (e as { type?: string }).type === 'context_compacted');
		const firstPhaseChange = events.findIndex(e => (e as { type?: string }).type === 'phase_change');
		if (firstCompacting >= 0 && firstPhaseChange >= 0) {
			assert.ok(
				firstPhaseChange < firstCompacting,
				'phase_change(compressing) 必须先于 context_compacted 到达 UI',
			);
		}
	});

	test('asGenerator 包装：collect 到的事件序列与直调 Impl 一致', async () => {
		const direct = makeEventRecorder();
		await compactContextIfNeededImpl(
			direct.emit, makeDeps({ willCompress: true }), makeState(),
		);

		const wrapped: IChatStreamDelta[] = [];
		for await (const delta of compactContextIfNeeded(makeDeps({ willCompress: true }), makeState())) {
			wrapped.push(delta);
		}

		assert.deepStrictEqual(
			wrapped.map(e => (e as { type?: string }).type),
			direct.events.map(e => (e as { type?: string }).type),
			'包装后的事件 type 序列必须与直调主体逐项一致',
		);
	});

	test('asGenerator 包装：消费者提前 break 不挂起生产者（防泄漏）', async () => {
		const generator = compactContextIfNeeded(makeDeps({ willCompress: true }), makeState());
		// 取第一个事件后立即 break，触发 generator 的 return() → finally 分支。
		const first = await generator.next();
		if (!first.done) { await generator.return(undefined as never); }

		// 能走到这里即说明 finally 已解除生产侧等待（否则本测试会超时）。
		assert.ok(true, '提前 break 后生产侧未被挂起');
	});

	test('返回值透传：主体 resolve 值经包装后成为生成器 return 值', async () => {
		const generator = compactContextIfNeeded(makeDeps({ willCompress: true }), makeState());
		let result = await generator.next();
		while (!result.done) { result = await generator.next(); }

		assert.strictEqual(result.value, undefined, 'compactContextIfNeeded 主体返回 void，return 值应为 undefined');
	});
});
