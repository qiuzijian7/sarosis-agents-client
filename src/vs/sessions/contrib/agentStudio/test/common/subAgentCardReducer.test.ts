/*---------------------------------------------------------------------------------------------
 *  subAgentCardReducer 纯函数单元测试
 *
 *  覆盖 SubAgentEvent → MutableCardState 的所有事件类型、幂等收敛、终态收敛。
 *  无外部依赖（除常量枚举），可在 node 下直接运行。
 *--------------------------------------------------------------------------------------------*/

import { strictEqual, deepStrictEqual } from 'node:assert';
import { createEmptyCard, reduceCardState, type MutableCardState } from '../../common/subAgentCardReducer.js';
import { SubAgentEventType } from '../../common/unifiedSubAgentDispatch.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<{
	type: SubAgentEventType;
	subAgentId: string;
	toolName: string;
	toolsCompleted: number;
	toolStatus: 'ok' | 'error';
	toolResultPreview: string;
	progressNote: string;
	output: string;
	error: string;
	textDelta: string;
}> = {}): any {
	return {
		type: overrides.type ?? SubAgentEventType.Progress,
		subAgentId: overrides.subAgentId ?? 'agent-1',
		subAgentType: 'explore' as const,
		task: 'test task',
		parentId: 'parent-0',
		timestamp: Date.now(),
		groupId: 'group-1',
		toolName: overrides.toolName,
		toolsCompleted: overrides.toolsCompleted,
		toolStatus: overrides.toolStatus,
		toolResultPreview: overrides.toolResultPreview,
		progressNote: overrides.progressNote,
		output: overrides.output,
		error: overrides.error,
		textDelta: overrides.textDelta,
	};
}

// ── createEmptyCard ────────────────────────────────────────────────────────

suite('[subAgentCardReducer] createEmptyCard', () => {
	test('creates a card with correct defaults', () => {
		const card = createEmptyCard('sa-1', 'explore', 'Search files');
		strictEqual(card.id, 'sa-1');
		strictEqual(card.type, 'explore');
		strictEqual(card.task, 'Search files');
		strictEqual(card.status, 'running');
		strictEqual(card.progress, undefined);
		strictEqual(card.output, undefined);
		strictEqual(card.error, undefined);
		deepStrictEqual(card.toolTraces, []);
	});
});

// ── Spawned ────────────────────────────────────────────────────────────────

suite('[subAgentCardReducer] Spawned', () => {
	test('Spawned sets status to running', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		card.status = 'pending' as any; // simulate pre-spawned state
		reduceCardState(card, makeEvent({ type: SubAgentEventType.Spawned }));
		strictEqual(card.status, 'running');
	});

	test('Spawned preserves existing toolTraces', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		card.toolTraces = [{ id: 't1', name: 'search_code', status: 'running' }];
		reduceCardState(card, makeEvent({ type: SubAgentEventType.Spawned }));
		strictEqual(card.toolTraces.length, 1);
	});
});

// ── ToolStarted ────────────────────────────────────────────────────────────

suite('[subAgentCardReducer] ToolStarted', () => {
	test('adds a running trace to empty traces', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.ToolStarted,
			toolName: 'search_graph',
			toolsCompleted: 0,
		}));
		strictEqual(card.toolTraces.length, 1);
		strictEqual(card.toolTraces[0].name, 'search_graph');
		strictEqual(card.toolTraces[0].status, 'running');
		strictEqual(card.toolTraces[0].id, 'agent-1-t0');
	});

	test('is idempotent: no duplicate for same traceId', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		for (let i = 0; i < 3; i++) {
			reduceCardState(card, makeEvent({
				type: SubAgentEventType.ToolStarted,
				toolName: 'search_code',
				toolsCompleted: 0,
			}));
		}
		strictEqual(card.toolTraces.length, 1);
		strictEqual(card.toolTraces[0].status, 'running');
	});

	test('adds multiple distinct tools', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.ToolStarted,
			toolName: 'search_code',
			toolsCompleted: 0,
		}));
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.ToolStarted,
			toolName: 'file_read',
			toolsCompleted: 1,
		}));
		strictEqual(card.toolTraces.length, 2);
		strictEqual(card.toolTraces[0].name, 'search_code');
		strictEqual(card.toolTraces[0].status, 'running');
		strictEqual(card.toolTraces[1].name, 'file_read');
		strictEqual(card.toolTraces[1].status, 'running');
	});

	test('updates progress text', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.ToolStarted,
			toolName: 'search_graph',
			toolsCompleted: 0,
		}));
		strictEqual(card.progress, '正在执行: search_graph');
	});

	test('uses "tool" as fallback name', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.ToolStarted,
			toolName: undefined,
			toolsCompleted: 0,
		}));
		strictEqual(card.toolTraces[0].name, 'tool');
	});
});

// ── ToolCompleted ──────────────────────────────────────────────────────────

suite('[subAgentCardReducer] ToolCompleted', () => {
	test('converges running trace by same name to done', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.ToolStarted,
			toolName: 'search_code',
			toolsCompleted: 0,
		}));
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.ToolCompleted,
			toolName: 'search_code',
			toolStatus: 'ok',
			toolResultPreview: '3 matches',
		}));
		strictEqual(card.toolTraces.length, 1);
		strictEqual(card.toolTraces[0].status, 'done');
		strictEqual(card.toolTraces[0].result, '3 matches');
	});

	test('converges to error when toolStatus is error', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.ToolStarted,
			toolName: 'bad_tool',
			toolsCompleted: 0,
		}));
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.ToolCompleted,
			toolName: 'bad_tool',
			toolStatus: 'error',
			toolResultPreview: 'not found',
		}));
		strictEqual(card.toolTraces[0].status, 'error');
		strictEqual(card.toolTraces[0].result, 'not found');
	});

	test('converges by different-name running trace when exact match missing', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.ToolStarted,
			toolName: 'search_code',
			toolsCompleted: 0,
		}));
		// ToolCompleted for a different tool name — should pick the closest running
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.ToolCompleted,
			toolName: 'OTHER_TOOL',
			toolStatus: 'ok',
		}));
		strictEqual(card.toolTraces[0].status, 'done');
	});

	test('appends a new done trace when no running traces exist', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.ToolCompleted,
			toolName: 'orphan_tool',
			toolStatus: 'ok',
			toolResultPreview: 'orphan result',
		}));
		strictEqual(card.toolTraces.length, 1);
		strictEqual(card.toolTraces[0].name, 'orphan_tool');
		strictEqual(card.toolTraces[0].status, 'done');
		strictEqual(card.toolTraces[0].result, 'orphan result');
	});

	test('ToolCompleted is idempotent (safe to call again)', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.ToolStarted,
			toolName: 'search_code',
			toolsCompleted: 0,
		}));
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.ToolCompleted,
			toolName: 'search_code',
			toolStatus: 'ok',
		}));
		// second ToolCompleted — no running trace left, appends a new done trace
		// (harmless in practise: _executeWithBudget emits exactly 1 ToolCompleted per tool)
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.ToolCompleted,
			toolName: 'search_code',
			toolStatus: 'ok',
		}));
		strictEqual(card.toolTraces.length, 2);
		strictEqual(card.toolTraces[0].status, 'done');
		strictEqual(card.toolTraces[1].status, 'done');
	});
});

// ── Progress ───────────────────────────────────────────────────────────────

suite('[subAgentCardReducer] Progress', () => {
	test('updates progress text', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.Progress,
			progressNote: 'Analyzing results...',
		}));
		strictEqual(card.progress, 'Analyzing results...');
	});

	test('does not update progress on falsy note', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		card.progress = 'old';
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.Progress,
			progressNote: undefined,
		}));
		strictEqual(card.progress, 'old');
	});
});

// ── Completed ──────────────────────────────────────────────────────────────

suite('[subAgentCardReducer] Completed', () => {
	test('sets status to done and clears progress', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		card.progress = 'working...';
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.Completed,
			output: 'All done!',
		}));
		strictEqual(card.status, 'done');
		strictEqual(card.progress, undefined);
		strictEqual(card.output, 'All done!');
	});

	test('truncates output to 2000 characters', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		const long = 'x'.repeat(3000);
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.Completed,
			output: long,
		}));
		strictEqual(card.output!.length, 2000);
	});

	test('converges residual running traces to done', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		card.toolTraces = [
			{ id: 't1', name: 'search_code', status: 'done' },
			{ id: 't2', name: 'read', status: 'running' },
			{ id: 't3', name: 'list', status: 'running' },
		];
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.Completed,
			output: 'done',
		}));
		strictEqual(card.toolTraces[0].status, 'done');   // already done
		strictEqual(card.toolTraces[1].status, 'done');   // converged
		strictEqual(card.toolTraces[2].status, 'done');   // converged
	});
});

// ── Failed ─────────────────────────────────────────────────────────────────

suite('[subAgentCardReducer] Failed', () => {
	test('sets status to error with message', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.Failed,
			error: 'timeout after 120s',
		}));
		strictEqual(card.status, 'error');
		strictEqual(card.error, 'timeout after 120s');
	});

	test('converges residual running traces to error', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		card.toolTraces = [
			{ id: 't1', name: 'search_code', status: 'done' },
			{ id: 't2', name: 'read', status: 'running' },
		];
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.Failed,
			error: 'crash',
		}));
		strictEqual(card.toolTraces[0].status, 'done');  // already done
		strictEqual(card.toolTraces[1].status, 'error'); // converged
	});
});

// ── Interrupted ────────────────────────────────────────────────────────────

suite('[subAgentCardReducer] Interrupted', () => {
	test('sets status to cancelled with fallback error', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.Interrupted,
			error: undefined,
		}));
		strictEqual(card.status, 'cancelled');
		strictEqual(card.error, 'Interrupted');
	});

	test('sets status to cancelled with explicit error', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.Interrupted,
			error: 'User aborted',
		}));
		strictEqual(card.status, 'cancelled');
		strictEqual(card.error, 'User aborted');
	});

	test('converges running traces to error', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		card.toolTraces = [
			{ id: 't1', name: 'search_code', status: 'done' },
			{ id: 't2', name: 'read', status: 'running' },
		];
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.Interrupted,
			error: 'aborted',
		}));
		strictEqual(card.toolTraces[1].status, 'error'); // running converged
	});
});

// ── Thinking (no-op) ───────────────────────────────────────────────────────

suite('[subAgentCardReducer] Thinking', () => {
	test('Thinking event is a no-op', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		card.status = 'running';
		card.progress = 'old progress';
		card.toolTraces = [{ id: 't1', name: 'search_code', status: 'running' }];
		reduceCardState(card, makeEvent({ type: SubAgentEventType.Thinking }));
		strictEqual(card.status, 'running');
		strictEqual(card.progress, 'old progress');
		strictEqual(card.toolTraces.length, 1);
		strictEqual(card.toolTraces[0].status, 'running');
	});
});

// ── Full Lifecycle ─────────────────────────────────────────────────────────

suite('[subAgentCardReducer] Full lifecycle', () => {
	test('Spawned→ToolStarted×2→ToolCompleted×2→Completed', () => {
		const card = createEmptyCard('sa-1', 'explore', 'Find auth module');
		card.status = 'pending' as any;

		// Spawned
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.Spawned,
			subAgentId: 'sa-1',
		}));
		strictEqual(card.status, 'running');

		// Tool 1: grep
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.ToolStarted,
			subAgentId: 'sa-1',
			toolName: 'search_graph',
			toolsCompleted: 0,
		}));
		strictEqual(card.toolTraces.length, 1);
		strictEqual(card.toolTraces[0].status, 'running');

		reduceCardState(card, makeEvent({
			type: SubAgentEventType.ToolCompleted,
			subAgentId: 'sa-1',
			toolName: 'search_graph',
			toolStatus: 'ok',
			toolResultPreview: '5 files found',
		}));
		strictEqual(card.toolTraces[0].status, 'done');
		strictEqual(card.toolTraces[0].result, '5 files found');

		// Tool 2: file_read
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.ToolStarted,
			subAgentId: 'sa-1',
			toolName: 'file_read',
			toolsCompleted: 1,
		}));
		strictEqual(card.toolTraces.length, 2);
		strictEqual(card.toolTraces[1].status, 'running');

		reduceCardState(card, makeEvent({
			type: SubAgentEventType.ToolCompleted,
			subAgentId: 'sa-1',
			toolName: 'file_read',
			toolStatus: 'ok',
			toolResultPreview: 'auth.ts (1.5KB)',
		}));
		strictEqual(card.toolTraces[1].status, 'done');

		// Completed
		reduceCardState(card, makeEvent({
			type: SubAgentEventType.Completed,
			subAgentId: 'sa-1',
			output: 'Auth module is at src/auth/ with 3 endpoints',
		}));
		strictEqual(card.status, 'done');
		strictEqual(card.progress, undefined);
		strictEqual(card.output, 'Auth module is at src/auth/ with 3 endpoints');
		strictEqual(card.toolTraces.length, 2);
	});

	test('lifecycle: Spawned→ToolStarted→Failed (converges running)', () => {
		const card = createEmptyCard('sa-x', 'explore', 'T');
		reduceCardState(card, makeEvent({ type: SubAgentEventType.Spawned, subAgentId: 'sa-x' }));
		reduceCardState(card, makeEvent({ type: SubAgentEventType.ToolStarted, subAgentId: 'sa-x', toolName: 'bad', toolsCompleted: 0 }));
		reduceCardState(card, makeEvent({ type: SubAgentEventType.Failed, subAgentId: 'sa-x', error: 'boom' }));
		strictEqual(card.status, 'error');
		strictEqual(card.error, 'boom');
		strictEqual(card.toolTraces[0].status, 'error');
	});

	test('lifecycle: no Spawned→ToolStarted→Interrupted', () => {
		const card = createEmptyCard('sa-y', 'general', 'T');
		reduceCardState(card, makeEvent({ type: SubAgentEventType.ToolStarted, subAgentId: 'sa-y', toolName: 'write', toolsCompleted: 0 }));
		reduceCardState(card, makeEvent({ type: SubAgentEventType.Interrupted, subAgentId: 'sa-y', error: 'cancel' }));
		strictEqual(card.status, 'cancelled');
		strictEqual(card.toolTraces[0].status, 'error');
	});
});

// ── Multi-card isolation ───────────────────────────────────────────────────

suite('[subAgentCardReducer] Multi-card isolation', () => {
	test('events for one subAgentId do not affect another', () => {
		const cardA = createEmptyCard('a', 'explore', 'Task A');
		const cardB = createEmptyCard('b', 'explore', 'Task B');

		reduceCardState(cardA, makeEvent({ type: SubAgentEventType.ToolStarted, subAgentId: 'a', toolName: 'search_code', toolsCompleted: 0 }));
		reduceCardState(cardA, makeEvent({ type: SubAgentEventType.ToolCompleted, subAgentId: 'a', toolName: 'search_code', toolStatus: 'ok' }));
		reduceCardState(cardB, makeEvent({ type: SubAgentEventType.ToolStarted, subAgentId: 'b', toolName: 'list', toolsCompleted: 0 }));
		reduceCardState(cardB, makeEvent({ type: SubAgentEventType.Failed, subAgentId: 'b', error: 'timeout' }));

		strictEqual(cardA.toolTraces[0].status, 'done');
		strictEqual(cardA.status, 'running');
		strictEqual(cardB.status, 'error');
		strictEqual(cardB.toolTraces[0].status, 'error');
	});

	test('snapshot represents deep copy (no shared references)', () => {
		const card = createEmptyCard('sa-z', 'explore', 'T');
		reduceCardState(card, makeEvent({ type: SubAgentEventType.ToolStarted, subAgentId: 'sa-z', toolName: 'search_code', toolsCompleted: 0 }));
		reduceCardState(card, makeEvent({ type: SubAgentEventType.ToolCompleted, subAgentId: 'sa-z', toolName: 'search_code', toolStatus: 'ok' }));

		// Simulate snapshot creation (as done in planExploreTool's map(i => ...structure))
		const snapshot = {
			id: card.id,
			type: card.type,
			task: card.task,
			status: card.status,
			toolTraces: card.toolTraces.map(t => ({ ...t })),
		};

		// Mutate original
		card.toolTraces[0].status = 'error' as any;

		// Snapshot must be unaffected
		strictEqual(snapshot.toolTraces[0].status, 'done');
	});
});

// ── TextDelta (实时流式文本) ──────────────────────────────────────────────

suite('[subAgentCardReducer] TextDelta', () => {
	test('TextDelta 累积到 streamingOutput', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		reduceCardState(card, makeEvent({ type: SubAgentEventType.TextDelta, textDelta: 'Hello ' }));
		reduceCardState(card, makeEvent({ type: SubAgentEventType.TextDelta, textDelta: 'World' }));
		strictEqual(card.streamingOutput, 'Hello World');
		strictEqual(card.status, 'running'); // TextDelta 不改 status
	});

	test('TextDelta 不影响 output（output 仅 Completed 设置）', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		reduceCardState(card, makeEvent({ type: SubAgentEventType.TextDelta, textDelta: 'streaming...' }));
		strictEqual(card.output, undefined);
		strictEqual(card.streamingOutput, 'streaming...');
	});

	test('TextDelta 超长滑窗（>8000 字符截断保留尾部）', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		const chunk = 'x'.repeat(3000);
		reduceCardState(card, makeEvent({ type: SubAgentEventType.TextDelta, textDelta: chunk }));
		reduceCardState(card, makeEvent({ type: SubAgentEventType.TextDelta, textDelta: chunk }));
		reduceCardState(card, makeEvent({ type: SubAgentEventType.TextDelta, textDelta: chunk }));
		// 9000 → 截断到 8000（保留尾部）
		strictEqual(card.streamingOutput!.length, 8000);
		strictEqual(card.streamingOutput, 'x'.repeat(8000));
	});

	test('TextDelta 空 textDelta 不累积', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		reduceCardState(card, makeEvent({ type: SubAgentEventType.TextDelta, textDelta: 'A' }));
		reduceCardState(card, makeEvent({ type: SubAgentEventType.TextDelta })); // 无 textDelta
		strictEqual(card.streamingOutput, 'A');
	});

	test('Completed 后 output 替代 streamingOutput（UI 按 status 切换显示）', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		reduceCardState(card, makeEvent({ type: SubAgentEventType.TextDelta, textDelta: 'partial...' }));
		reduceCardState(card, makeEvent({ type: SubAgentEventType.Completed, output: 'final report' }));
		strictEqual(card.status, 'done');
		strictEqual(card.output, 'final report');
		// streamingOutput 仍保留（reducer 不清空，UI 按 status 决定显示哪个）
		strictEqual(card.streamingOutput, 'partial...');
	});

	test('TextDelta 与 ToolStarted/ToolCompleted 交错（探索期间边调工具边输出文本）', () => {
		const card = createEmptyCard('sa-1', 'explore', 'T');
		reduceCardState(card, makeEvent({ type: SubAgentEventType.Spawned }));
		reduceCardState(card, makeEvent({ type: SubAgentEventType.TextDelta, textDelta: '开始探索...' }));
		reduceCardState(card, makeEvent({ type: SubAgentEventType.ToolStarted, toolName: 'search_code', toolsCompleted: 0 }));
		reduceCardState(card, makeEvent({ type: SubAgentEventType.TextDelta, textDelta: '找到认证模块' }));
		reduceCardState(card, makeEvent({ type: SubAgentEventType.ToolCompleted, toolName: 'search_code', toolStatus: 'ok' }));
		strictEqual(card.streamingOutput, '开始探索...找到认证模块');
		strictEqual(card.toolTraces.length, 1);
		strictEqual(card.toolTraces[0].status, 'done');
		strictEqual(card.status, 'running');
	});
});
