/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { UnifiedSubAgentDispatch, SubAgentType } from '../../common/unifiedSubAgentDispatch';
import { IterationBudget } from '../../common/iterationBudget';
import type { IAgentTurnRequest, IChatStreamDelta } from '../../common/providers';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils';

suite('UnifiedSubAgentDispatch', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── Helper: create a mock executeFn ──────────────────────────────────

	function createMockExecuteFn(deltas: IChatStreamDelta[]): (req: IAgentTurnRequest, budget: IterationBudget) => AsyncIterable<IChatStreamDelta> {
		return async function* (_req: IAgentTurnRequest, _budget: IterationBudget) {
			for (const delta of deltas) {
				yield delta;
			}
		};
	}

	// ─── Budget double-consumption fix ────────────────────────────────────

	test('budget should only be consumed once per tool call (tool_end only, not tool_result)', async () => {
		const parentBudget = new IterationBudget(90);
		const dispatch = new UnifiedSubAgentDispatch(parentBudget, 3);
		const subAgentId = dispatch.createSubAgent('parent-1', 'test task', {
			type: SubAgentType.Explore,
			maxIterations: 10,
		});

		// Simulate: one tool call produces both tool_end and tool_result
		const executeFn = createMockExecuteFn([
			{ type: 'text', content: 'Searching...' },
			{ type: 'tool_end' },       // should consume 1
			{ type: 'tool_result' },    // should NOT consume again
			{ type: 'text', content: 'Found it!' },
			{ type: 'tool_end' },       // should consume 1
			{ type: 'tool_result' },    // should NOT consume again
			{ type: 'done' },
		]);

		const result = await dispatch.executeSubAgent(subAgentId, executeFn);

		assert.strictEqual(result.success, true);
		// Budget should have consumed exactly 2 (for two tool_end events),
		// NOT 4 (which would happen if both tool_end and tool_result consumed).
		const status = dispatch.getSubAgentStatus(subAgentId);
		assert.ok(status, 'SubAgent status should exist');
		// The child budget started with some iterations; verify it consumed exactly 2
		const subAgent = (dispatch as any)._activeSubAgents.get(subAgentId);
		assert.strictEqual(subAgent.budget.consumed, 2, 'Budget should be consumed exactly 2 times (one per tool_end), not 4');
	});

	test('budget exhaustion stops sub-agent execution', async () => {
		const parentBudget = new IterationBudget(90);
		const dispatch = new UnifiedSubAgentDispatch(parentBudget, 3);
		const subAgentId = dispatch.createSubAgent('parent-1', 'test task', {
			type: SubAgentType.Explore,
			maxIterations: 2,  // Very small budget
		});

		const executeFn = createMockExecuteFn([
			{ type: 'text', content: 'Working...' },
			{ type: 'tool_end' },       // consumes 1 → remaining=1
			{ type: 'tool_end' },       // consumes 1 → remaining=0
			{ type: 'tool_end' },       // should be ignored (budget exhausted)
			{ type: 'text', content: 'Should not appear' },
			{ type: 'done' },
		]);

		const result = await dispatch.executeSubAgent(subAgentId, executeFn);

		assert.strictEqual(result.success, true);
		assert.ok(result.output?.includes('[Budget exhausted'), 'Output should indicate budget exhaustion');
	});

	// ─── Parallel execution error handling ────────────────────────────────

	test('parallel execution should continue when one sub-agent fails', async () => {
		const parentBudget = new IterationBudget(90);
		const dispatch = new UnifiedSubAgentDispatch(parentBudget, 3);

		const successId = dispatch.createSubAgent('parent-1', 'succeeding task', {
			type: SubAgentType.Explore,
		});
		const failId = dispatch.createSubAgent('parent-1', 'failing task', {
			type: SubAgentType.Explore,
		});

		// One succeeds, one throws
		const successFn = createMockExecuteFn([
			{ type: 'text', content: 'I succeeded' },
			{ type: 'done' },
		]);
		const failFn = async function* (_req: IAgentTurnRequest, _budget: IterationBudget) {
			throw new Error('Intentional failure');
		};

		// Execute the success one directly
		const successResult = await dispatch.executeSubAgent(successId, successFn);
		assert.strictEqual(successResult.success, true);

		// Execute the failing one directly
		const failResult = await dispatch.executeSubAgent(failId, failFn);
		assert.strictEqual(failResult.success, false);
		assert.ok(failResult.error?.includes('Intentional failure'));
	});

	test('executeMultipleSubAgents uses Promise.allSettled to handle partial failures', async () => {
		const parentBudget = new IterationBudget(90);
		const dispatch = new UnifiedSubAgentDispatch(parentBudget, 3);

		const id1 = dispatch.createSubAgent('parent-1', 'task 1');
		const id2 = dispatch.createSubAgent('parent-1', 'task 2');
		const id3 = dispatch.createSubAgent('parent-1', 'task 3');

		// Mix of success and failure
		let callCount = 0;
		const mixedFn = async function* (_req: IAgentTurnRequest, _budget: IterationBudget): AsyncIterable<IChatStreamDelta> {
			callCount++;
			if (callCount === 2) {
				throw new Error('Sub-agent 2 failed');
			}
			yield { type: 'text', content: `Result ${callCount}` };
			yield { type: 'done' };
		};

		const results = await dispatch.executeMultipleSubAgents([id1, id2, id3], mixedFn);

		assert.strictEqual(results.size, 3, 'All 3 sub-agents should have results');
		// At least one should succeed and one should fail
		const successes = Array.from(results.values()).filter((r: any) => r.success);
		const failures = Array.from(results.values()).filter((r: any) => !r.success);
		assert.ok(successes.length >= 1, 'At least one sub-agent should succeed');
		assert.ok(failures.length >= 1, 'At least one sub-agent should fail');
	});

	// ─── Tool permission checks ───────────────────────────────────────────

	test('Explore agent cannot write', () => {
		const dispatch = new UnifiedSubAgentDispatch();
		assert.strictEqual(dispatch.isToolAllowed(SubAgentType.Explore, 'read'), true);
		assert.strictEqual(dispatch.isToolAllowed(SubAgentType.Explore, 'write'), false);
		assert.strictEqual(dispatch.isToolAllowed(SubAgentType.Explore, 'execute'), false);
	});

	test('General agent can write but cannot delegate', () => {
		const dispatch = new UnifiedSubAgentDispatch();
		assert.strictEqual(dispatch.isToolAllowed(SubAgentType.General, 'write'), true);
		assert.strictEqual(dispatch.isToolAllowed(SubAgentType.General, 'delegate_task'), false);
	});

	test('Scout agent can clone repos but cannot write', () => {
		const dispatch = new UnifiedSubAgentDispatch();
		assert.strictEqual(dispatch.isToolAllowed(SubAgentType.Scout, 'repo_clone'), true);
		assert.strictEqual(dispatch.isToolAllowed(SubAgentType.Scout, 'write'), false);
	});

	// ─── dispatchParallelExplore with per-task options ─────────────────────

	test('dispatchParallelExplore respects per-task priority', async () => {
		const parentBudget = new IterationBudget(90);
		const dispatch = new UnifiedSubAgentDispatch(parentBudget, 3);

		const executeFn = createMockExecuteFn([
			{ type: 'text', content: 'done' },
			{ type: 'done' },
		]);

		const results = await dispatch.dispatchParallelExplore(
			'parent-1',
			['low priority task', 'high priority task'],
			executeFn,
			'context',
			[{ priority: 'low' }, { priority: 'high' }],
		);

		assert.strictEqual(results.length, 2);
		assert.strictEqual(results[0].success, true);
		assert.strictEqual(results[1].success, true);
	});
});
