/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { UnifiedSubAgentDispatch, SubAgentType } from '../../common/unifiedSubAgentDispatch.js';
import type { IAgentTurnRequest, IChatStreamDelta } from '../../common/providers.js';
import type { IterationBudget } from '../../common/iterationBudget.js';

/**
 * Regression tests for the delegate_task propagation chain (v17).
 *
 * These verify that `delegate_task`'s `toolsets` / `model` / `worktree` / `context`
 * options flow all the way into the `IAgentTurnRequest` handed to the sub-agent's
 * execution function — without this, the sub-agent silently ignores the scoping
 * the parent requested (the original "dead parameter" bug, now fixed).
 */
suite('UnifiedSubAgentDispatch — delegate_task propagation', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** Capturing executeFn: records the request it receives and yields a single text delta. */
	function makeCaptureFn(captured: IAgentTurnRequest[]) {
		return async function* execFn(request: IAgentTurnRequest, _budget: IterationBudget): AsyncIterable<IChatStreamDelta> {
			captured.push(request);
			yield { type: 'text', content: 'sub-agent output' };
		};
	}

	test('dispatch propagates toolsets/model/worktree/context into the request', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const captured: IAgentTurnRequest[] = [];
		const execFn = makeCaptureFn(captured);

		const result = await dispatch.dispatch(
			'parent-1',
			'Investigate the auth module',
			execFn,
			{
				type: SubAgentType.General,
				worktreePath: '/worktrees/feature-x',
				context: 'Prior steps: we ruled out the OAuth path.',
				toolsets: ['core'],
				model: { providerId: 'knot-agui', modelId: 'gpt-4o-mini' },
			},
		);

		assert.strictEqual(result.success, true);
		assert.strictEqual(captured.length, 1, 'executeFn should be called exactly once');
		const req = captured[0];

		// toolset scope override reaches the request
		assert.deepStrictEqual(req.toolsetsOverride, ['core'], 'toolsetsOverride must equal the requested toolset');
		// model override reaches the request
		assert.deepStrictEqual(req.modelOverride, { providerId: 'knot-agui', modelId: 'gpt-4o-mini' }, 'modelOverride must equal the resolved model');
		// worktree inheritance reaches the request
		assert.strictEqual(req.worktreePath, '/worktrees/feature-x', 'worktreePath must be inherited from the parent');

		// context injected into the first user message (with the task)
		assert.ok(req.messages.length >= 1, 'at least one message must be built');
		const firstMsg = req.messages[0].content as string;
		assert.ok(firstMsg.includes('Prior steps: we ruled out the OAuth path.'), 'context must be injected into the message');
		assert.ok(firstMsg.includes('Investigate the auth module'), 'task must be injected into the message');

		// type drives the system prompt
		assert.ok(req.systemPrompt.includes('general-purpose agent'), 'General role prompt must be selected');
	});

	test('dispatch without toolsets/model leaves overrides undefined (no behavior change)', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const captured: IAgentTurnRequest[] = [];
		const execFn = makeCaptureFn(captured);

		await dispatch.dispatch('parent-2', 'plain task', execFn, { type: SubAgentType.Explore });

		assert.strictEqual(captured.length, 1);
		const req = captured[0];
		assert.strictEqual(req.toolsetsOverride, undefined, 'toolsetsOverride must be undefined when not requested');
		assert.strictEqual(req.modelOverride, undefined, 'modelOverride must be undefined when not requested');
		// Explore is the read-only role
		assert.ok(req.systemPrompt.includes('file search specialist'), 'Explore role prompt must be selected');
	});

	test('dispatchParallelExplore propagates per-task toolsets/model/worktree', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const captured: IAgentTurnRequest[] = [];
		const execFn = makeCaptureFn(captured);

		const results = await dispatch.dispatchParallelExplore(
			'parent-3',
			['task alpha', 'task beta'],
			execFn,
			'shared context for fan-out',
			[
				{ type: SubAgentType.Explore, toolsets: ['core'], model: { providerId: 'knot-agui', modelId: 'mini-a' }, worktreePath: '/wt/a' },
				{ type: SubAgentType.General, toolsets: ['utility'], model: { providerId: 'knot-agui', modelId: 'mini-b' }, worktreePath: '/wt/b' },
			],
		);

		assert.strictEqual(results.length, 2, 'both parallel sub-agents should return a result');
		assert.strictEqual(captured.length, 2, 'executeFn should be called once per sub-agent');

		// Match each captured request back to its task by content (order is non-deterministic under concurrency).
		const reqAlpha = captured.find(r => (r.messages[0].content as string).includes('task alpha'))!;
		const reqBeta = captured.find(r => (r.messages[0].content as string).includes('task beta'))!;
		assert.ok(reqAlpha && reqBeta, 'both tasks must produce a request');

		// Per-task toolset scope
		assert.deepStrictEqual(reqAlpha.toolsetsOverride, ['core'], 'alpha scoped to core');
		assert.deepStrictEqual(reqBeta.toolsetsOverride, ['utility'], 'beta scoped to utility');

		// Per-task model override
		assert.deepStrictEqual(reqAlpha.modelOverride, { providerId: 'knot-agui', modelId: 'mini-a' });
		assert.deepStrictEqual(reqBeta.modelOverride, { providerId: 'knot-agui', modelId: 'mini-b' });

		// Per-task worktree
		assert.strictEqual(reqAlpha.worktreePath, '/wt/a');
		assert.strictEqual(reqBeta.worktreePath, '/wt/b');

		// Shared context injected into both
		assert.ok((reqAlpha.messages[0].content as string).includes('shared context for fan-out'));
		assert.ok((reqBeta.messages[0].content as string).includes('shared context for fan-out'));
	});

	test('dispatchParallelExplore defaults to Explore when per-task options omit type', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const captured: IAgentTurnRequest[] = [];
		const execFn = makeCaptureFn(captured);

		await dispatch.dispatchParallelExplore('parent-4', ['only task'], execFn, undefined, undefined);

		assert.strictEqual(captured.length, 1);
		assert.ok(captured[0].systemPrompt.includes('file search specialist'), 'parallel fan-out must default to the Explore (read-only) role');
	});
});
