/*---------------------------------------------------------------------------------------------
 *  Test: SubAgent Card Display — simulates LLM streaming events from real logs
 *  and verifies that card state (title, output, tool traces, progress) is correct.
 *
 *  Real log reference: E:\Downloads\vscode-app-1784619496157.log
 *  The LLM streaming flow produces events in this order:
 *    1. ToolStarted  → tool card appears with tool name
 *    2. TextDelta    → streaming LLM output text accumulates
 *    3. ToolCompleted → tool card gets result preview (toolResultPreview)
 *    4. Completed    → final subagent output is set
 *
 *  Usage:
 *      node src/vs/sessions/contrib/agentStudio/test/common/run-subAgentCardDisplay-tests.mjs
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert';
import {
	reduceCardState,
	createEmptyCard,
	type MutableCardState,
} from '../../common/subAgentCardReducer.js';
import { SubAgentEventType, type SubAgentEvent } from '../../common/unifiedSubAgentDispatch.js';

suite('SubAgent Card Display — LLM Streaming Simulation', () => {

	// ────────────────────────────────────────────────────────────
	// Helpers: minimal SubAgentEvent factories matching real log patterns
	// ────────────────────────────────────────────────────────────
	const BASE = {
		subAgentType: 'explore' as const,
		task: 'Explore the project structure',
		parentId: 'parent-main',
	};

	function toolStarted(opts: {
		subAgentId: string;
		toolName: string;
		argsPreview?: string;
		toolsCompleted?: number;
	}): SubAgentEvent {
		return {
			type: SubAgentEventType.ToolStarted,
			subAgentId: opts.subAgentId,
			...BASE,
			timestamp: Date.now(),
			toolName: opts.toolName,
			toolArgsPreview: opts.argsPreview,
			toolsCompleted: opts.toolsCompleted ?? 0,
		};
	}

	function textDelta(opts: {
		subAgentId: string;
		text: string;
	}): SubAgentEvent {
		return {
			type: SubAgentEventType.TextDelta,
			subAgentId: opts.subAgentId,
			...BASE,
			timestamp: Date.now(),
			textDelta: opts.text,
		};
	}

	function toolCompleted(opts: {
		subAgentId: string;
		toolName: string;
		resultPreview?: string;
		argsPreview?: string;
		toolStatus?: 'ok' | 'error';
		toolsCompleted?: number;
	}): SubAgentEvent {
		return {
			type: SubAgentEventType.ToolCompleted,
			subAgentId: opts.subAgentId,
			...BASE,
			timestamp: Date.now(),
			toolName: opts.toolName,
			toolResultPreview: opts.resultPreview,
			toolArgsPreview: opts.argsPreview,
			toolStatus: opts.toolStatus ?? 'ok',
			toolsCompleted: opts.toolsCompleted ?? 0,
		};
	}

	function completed(opts: {
		subAgentId: string;
		output: string;
		toolsCompleted?: number;
	}): SubAgentEvent {
		return {
			type: SubAgentEventType.Completed,
			subAgentId: opts.subAgentId,
			...BASE,
			timestamp: Date.now(),
			output: opts.output,
			toolsCompleted: opts.toolsCompleted ?? 0,
		};
	}

	function failed(opts: {
		subAgentId: string;
		error: string;
	}): SubAgentEvent {
		return {
			type: SubAgentEventType.Failed,
			subAgentId: opts.subAgentId,
			...BASE,
			timestamp: Date.now(),
			error: opts.error,
		};
	}

	// ────────────────────────────────────────────────────────────
	// Helper: apply a sequence of events to a fresh card
	// ────────────────────────────────────────────────────────────
	function applyEvents(agentId: string, type: MutableCardState['type'], task: string, events: SubAgentEvent[]): MutableCardState {
		const card = createEmptyCard(agentId, type, task);
		for (const ev of events) {
			reduceCardState(card, ev);
		}
		return card;
	}

	// ════════════════════════════════════════════════════════════
	// Test 1: Basic ToolStarted → TextDelta → ToolCompleted flow
	// ════════════════════════════════════════════════════════════
	suite('Basic LLM streaming: ToolStarted → TextDelta → ToolCompleted', () => {

		test('ToolStarted creates a tool trace with running status', () => {
			const card = createEmptyCard('agent-1', 'explore', 'Explore codebase');
			reduceCardState(card, toolStarted({
				subAgentId: 'agent-1',
				toolName: 'search_graph',
				argsPreview: '{"query":"find authentication"}',
			}));

			assert.strictEqual(card.toolTraces.length, 1);
			assert.strictEqual(card.toolTraces[0].name, 'search_graph');
			assert.strictEqual(card.toolTraces[0].status, 'running');
			assert.ok(card.toolTraces[0].args?.includes('find authentication'),
				'argsPreview should be stored in args field');
		});

		test('TextDelta updates streamingOutput while running', () => {
			const card = createEmptyCard('agent-1', 'explore', 'Explore');
			reduceCardState(card, toolStarted({
				subAgentId: 'agent-1', toolName: 'search_graph',
			}));
			reduceCardState(card, textDelta({ subAgentId: 'agent-1', text: 'Searching for auth module...' }));
			reduceCardState(card, textDelta({ subAgentId: 'agent-1', text: ' Found 3 files.' }));

			assert.ok(card.streamingOutput?.includes('Searching for auth module'),
				'streamingOutput should accumulate text');
			assert.ok(card.streamingOutput?.includes('Found 3 files'),
				'streamingOutput should accumulate subsequent text');
		});

		test('ToolCompleted updates trace status to done and stores result preview', () => {
			const card = createEmptyCard('agent-1', 'explore', 'Explore');
			reduceCardState(card, toolStarted({
				subAgentId: 'agent-1', toolName: 'search_graph',
			}));
			reduceCardState(card, toolCompleted({
				subAgentId: 'agent-1',
				toolName: 'search_graph',
				resultPreview: 'Found auth.ts, authMiddleware.ts, tokenService.ts',
			}));

			assert.strictEqual(card.toolTraces[0].status, 'done');
			assert.ok(card.toolTraces[0].result?.includes('auth.ts'),
				'resultPreview should appear in trace result');
			assert.ok(card.toolTraces[0].result?.includes('tokenService.ts'),
				'resultPreview should include all found files');
		});

		test('ToolCompleted with empty result preview still marks trace as done', () => {
			const card = createEmptyCard('agent-1', 'explore', 'Explore');
			reduceCardState(card, toolStarted({
				subAgentId: 'agent-1', toolName: 'search_graph',
			}));
			reduceCardState(card, toolCompleted({
				subAgentId: 'agent-1',
				toolName: 'search_graph',
				resultPreview: '',
			}));

			assert.strictEqual(card.toolTraces[0].status, 'done');
		});
	});

	// ════════════════════════════════════════════════════════════
	// Test 2: Multiple tools in sequence (realistic LLM flow)
	// ════════════════════════════════════════════════════════════
	suite('Multi-tool LLM flow', () => {

		test('multiple tools create ordered traces', () => {
			const card = applyEvents('agent-2', 'explore', 'Explore', [
				toolStarted({ subAgentId: 'agent-2', toolName: 'search_graph' }),
				toolCompleted({ subAgentId: 'agent-2', toolName: 'search_graph', resultPreview: '3 files' }),
				toolStarted({ subAgentId: 'agent-2', toolName: 'file_read', argsPreview: '{"path":"auth.ts"}' }),
				toolCompleted({ subAgentId: 'agent-2', toolName: 'file_read', resultPreview: 'class AuthService {...}' }),
				toolStarted({ subAgentId: 'agent-2', toolName: 'search_code', argsPreview: '{"pattern":"TODO"}' }),
				toolCompleted({ subAgentId: 'agent-2', toolName: 'search_code', resultPreview: '5 matches' }),
			]);

			assert.strictEqual(card.toolTraces.length, 3);
			assert.deepStrictEqual(card.toolTraces.map(t => t.name), ['search_graph', 'file_read', 'search_code']);
			assert.deepStrictEqual(card.toolTraces.map(t => t.status), ['done', 'done', 'done']);
			assert.ok(card.toolTraces[0].result?.includes('3 files'));
			assert.ok(card.toolTraces[1].result?.includes('AuthService'));
			assert.ok(card.toolTraces[2].result?.includes('5 matches'));
		});

		test('tools interleaved with text deltas', () => {
			const card = applyEvents('agent-3', 'explore', 'Explore', [
				toolStarted({ subAgentId: 'agent-3', toolName: 'search_graph' }),
				textDelta({ subAgentId: 'agent-3', text: 'Let me search for the auth module...' }),
				toolCompleted({ subAgentId: 'agent-3', toolName: 'search_graph', resultPreview: 'Found auth/' }),
				textDelta({ subAgentId: 'agent-3', text: 'Now reading the main file...' }),
				toolStarted({ subAgentId: 'agent-3', toolName: 'file_read' }),
				textDelta({ subAgentId: 'agent-3', text: 'Reading...' }),
				toolCompleted({ subAgentId: 'agent-3', toolName: 'file_read', resultPreview: 'Auth module exports: login, logout' }),
			]);

			assert.strictEqual(card.toolTraces.length, 2);
			assert.ok(card.streamingOutput?.includes('Let me search'));
			assert.ok(card.streamingOutput?.includes('Now reading'));
		});
	});

	// ════════════════════════════════════════════════════════════
	// Test 3: Completed event — subagent finishes
	// ════════════════════════════════════════════════════════════
	suite('Completed event — subagent completion', () => {

		test('Completed event sets status to done and stores final output', () => {
			const card = applyEvents('agent-4', 'explore', 'Explore', [
				toolStarted({ subAgentId: 'agent-4', toolName: 'search_graph' }),
				toolCompleted({ subAgentId: 'agent-4', toolName: 'search_graph', resultPreview: 'found' }),
				completed({ subAgentId: 'agent-4', output: '# Report\n\nThe auth module is in `src/auth/`.\n3 files found.' }),
			]);

			assert.strictEqual(card.status, 'done');
			assert.ok(card.output?.includes('auth module'), 'output should contain the report');
			assert.ok(card.output?.includes('src/auth/'), 'output should contain file paths');
		});

		test('Completed event with streamingOutput accumulated earlier preserves both', () => {
			const card = applyEvents('agent-5', 'explore', 'Explore', [
				toolStarted({ subAgentId: 'agent-5', toolName: 'file_read' }),
				textDelta({ subAgentId: 'agent-5', text: 'Analyzing...' }),
				toolCompleted({ subAgentId: 'agent-5', toolName: 'file_read', resultPreview: 'code' }),
				completed({ subAgentId: 'agent-5', output: 'Final report' }),
			]);

			assert.strictEqual(card.status, 'done');
			assert.ok(card.streamingOutput?.includes('Analyzing'), 'streamingOutput preserved');
			assert.strictEqual(card.output, 'Final report', 'output set from Completed event');
		});

		test('Completed event without prior tool calls still sets done status', () => {
			const card = applyEvents('agent-6', 'explore', 'Simple task', [
				completed({ subAgentId: 'agent-6', output: 'Simple analysis result' }),
			]);

			assert.strictEqual(card.status, 'done');
			assert.strictEqual(card.output, 'Simple analysis result');
			assert.strictEqual(card.toolTraces.length, 0);
		});
	});

	// ════════════════════════════════════════════════════════════
	// Test 4: Card identity and title format
	// ════════════════════════════════════════════════════════════
	suite('Card identity and title', () => {

		test('card id matches subAgentId', () => {
			const card = createEmptyCard('explore-abc123', 'explore', 'Investigate auth');
			assert.strictEqual(card.id, 'explore-abc123');
		});

		test('card type is set correctly', () => {
			assert.strictEqual(createEmptyCard('e1', 'explore', 'task').type, 'explore');
			assert.strictEqual(createEmptyCard('s1', 'scout', 'task').type, 'scout');
			assert.strictEqual(createEmptyCard('g1', 'general', 'task').type, 'general');
		});

		test('card task is preserved', () => {
			const task = 'Explore the authentication module thoroughly';
			const card = createEmptyCard('agent-x', 'explore', task);
			assert.strictEqual(card.task, task);
		});

		test('title format: "{id} subagent: {task}"', () => {
			const card = createEmptyCard('explore-42', 'explore', 'Investigate project');
			const expectedTitle = `${card.id} subagent: ${card.task}`;
			assert.strictEqual(expectedTitle, 'explore-42 subagent: Investigate project');
		});

		test('title with empty task uses fallback', () => {
			const card = createEmptyCard('agent-1', 'explore', '');
			const displayTitle = card.task || 'SubAgent (探索)';
			const expectedTitle = `${card.id} subagent: ${displayTitle}`;
			assert.strictEqual(expectedTitle, 'agent-1 subagent: SubAgent (探索)');
		});
	});

	// ════════════════════════════════════════════════════════════
	// Test 5: Error handling — tool failure and subagent failure
	// ════════════════════════════════════════════════════════════
	suite('Error handling', () => {

		test('ToolCompleted with toolStatus=error marks trace as error', () => {
			const card = createEmptyCard('agent-err', 'explore', 'Explore');
			reduceCardState(card, toolStarted({
				subAgentId: 'agent-err', toolName: 'file_read',
			}));
			reduceCardState(card, toolCompleted({
				subAgentId: 'agent-err',
				toolName: 'file_read',
				toolStatus: 'error',
				resultPreview: 'File not found: /nonexistent/path.ts',
			}));

			assert.strictEqual(card.toolTraces[0].status, 'error');
			assert.ok(card.toolTraces[0].result?.includes('File not found'));
		});

		test('Failed event sets status=error and stores error message', () => {
			const card = createEmptyCard('agent-err2', 'explore', 'Explore');
			reduceCardState(card, toolStarted({
				subAgentId: 'agent-err2', toolName: 'search_graph',
			}));
			reduceCardState(card, failed({
				subAgentId: 'agent-err2',
				error: 'Connection timeout after 30s',
			}));

			assert.strictEqual(card.status, 'error');
			assert.ok(card.error?.includes('Connection timeout'));
			assert.strictEqual(card.toolTraces[0].status, 'error',
				'running trace should be marked error on failure');
		});
	});

	// ════════════════════════════════════════════════════════════
	// Test 6: Tool args display in traces
	// ════════════════════════════════════════════════════════════
	suite('Tool args display in traces', () => {

		test('ToolStarted argsPreview is stored in trace args', () => {
			const card = createEmptyCard('agent-a', 'explore', 'Explore');
			reduceCardState(card, toolStarted({
				subAgentId: 'agent-a',
				toolName: 'search_graph',
				argsPreview: '{"query":"find database layer","maxResults":10}',
			}));

			assert.ok(card.toolTraces[0].args?.includes('database layer'));
			assert.ok(card.toolTraces[0].args?.includes('maxResults'));
		});

		test('ToolCompleted preserves args from ToolStarted and stores result', () => {
			// The reducer sets args on ToolStarted only; ToolCompleted sets result + status.
			// args from ToolStarted should survive ToolCompleted.
			const card = createEmptyCard('agent-b', 'explore', 'Explore');
			reduceCardState(card, toolStarted({
				subAgentId: 'agent-b', toolName: 'file_read',
				argsPreview: '{"path":"/src/db/index.ts"}',
			}));
			reduceCardState(card, toolCompleted({
				subAgentId: 'agent-b',
				toolName: 'file_read',
				resultPreview: 'export class Database {...}',
			}));

			assert.ok(card.toolTraces[0].args?.includes('/src/db/index.ts'),
				'args from ToolStarted should persist through ToolCompleted');
			assert.ok(card.toolTraces[0].result?.includes('Database'));
			assert.strictEqual(card.toolTraces[0].status, 'done');
		});
	});

	// ════════════════════════════════════════════════════════════
	// Test 7: Large result handling
	// ════════════════════════════════════════════════════════════
	suite('Large result handling', () => {

		test('very long result preview does not break card state', () => {
			const longResult = 'A'.repeat(10000);
			const card = applyEvents('agent-big', 'explore', 'Explore', [
				toolStarted({ subAgentId: 'agent-big', toolName: 'search_graph' }),
				toolCompleted({ subAgentId: 'agent-big', toolName: 'search_graph', resultPreview: longResult }),
			]);

			assert.strictEqual(card.toolTraces[0].status, 'done');
			assert.strictEqual(card.toolTraces[0].result?.length, 10000);
		});

		test('multiple large results across tools', () => {
			const big = 'B'.repeat(5000);
			const card = applyEvents('agent-big2', 'explore', 'Explore', [
				toolStarted({ subAgentId: 'agent-big2', toolName: 'search_graph' }),
				toolCompleted({ subAgentId: 'agent-big2', toolName: 'search_graph', resultPreview: big }),
				toolStarted({ subAgentId: 'agent-big2', toolName: 'file_read' }),
				toolCompleted({ subAgentId: 'agent-big2', toolName: 'file_read', resultPreview: big }),
			]);

			assert.strictEqual(card.toolTraces.length, 2);
			assert.strictEqual(card.toolTraces[0].result?.length, 5000);
			assert.strictEqual(card.toolTraces[1].result?.length, 5000);
		});

		test('streamingOutput is capped at 8000 chars', () => {
			const card = createEmptyCard('agent-cap', 'explore', 'Explore');
			// Push 9000 chars of text deltas
			const chunk = 'A'.repeat(1000);
			for (let i = 0; i < 9; i++) {
				reduceCardState(card, textDelta({ subAgentId: 'agent-cap', text: chunk }));
			}
			// Should be capped at last 8000 chars (tail preservation)
			assert.ok((card.streamingOutput?.length ?? 0) <= 8000,
				`streamingOutput length ${card.streamingOutput?.length} should be <= 8000`);
		});

		test('output is truncated at 2000 chars on Completed', () => {
			const longOutput = 'X'.repeat(5000);
			const card = applyEvents('agent-trunc', 'explore', 'Explore', [
				completed({ subAgentId: 'agent-trunc', output: longOutput }),
			]);
			assert.strictEqual(card.output?.length, 2000);
		});
	});

	// ════════════════════════════════════════════════════════════
	// Test 8: Card state isolation
	// ════════════════════════════════════════════════════════════
	suite('Card state isolation', () => {

		test('separate cards for different agents do not interfere', () => {
			const card1 = createEmptyCard('agent-1', 'explore', 'Task A');
			const card2 = createEmptyCard('agent-2', 'explore', 'Task B');

			reduceCardState(card1, toolStarted({
				subAgentId: 'agent-1', toolName: 'search_graph',
			}));
			reduceCardState(card2, toolStarted({
				subAgentId: 'agent-2', toolName: 'file_read',
			}));

			assert.strictEqual(card1.toolTraces.length, 1);
			assert.strictEqual(card2.toolTraces.length, 1);
			assert.strictEqual(card1.toolTraces[0].name, 'search_graph');
			assert.strictEqual(card2.toolTraces[0].name, 'file_read');
		});

		test('events for wrong agentId are still applied (reducer is per-card, no ID filtering)', () => {
			// The reducer is a pure card-state reducer — it does NOT filter by subAgentId.
			// The caller (nativeChatEditorPane) is responsible for routing events to the correct card.
			const card = createEmptyCard('agent-x', 'explore', 'Task');
			reduceCardState(card, toolStarted({
				subAgentId: 'agent-y', // different agent
				toolName: 'search_graph',
			}));

			// Reducer still applies the event to the card (no ID filtering)
			assert.strictEqual(card.toolTraces.length, 1,
				'reducer applies events blindly; caller routes by ID');
		});
	});

	// ════════════════════════════════════════════════════════════
	// Test 9: Real log simulation — complete explore subagent flow
	// Based on: preloop_explore_1784619378445_nwrzmj
	// ════════════════════════════════════════════════════════════
	suite('Real log simulation — complete explore flow', () => {

		test('full explore subagent lifecycle matches log pattern', () => {
			const agentId = 'explore_001';
			const card = createEmptyCard(agentId, 'explore', 'Explore authentication module');

			// Phase 1: Initial tool calls (search_graph)
			reduceCardState(card, toolStarted({
				subAgentId: agentId, toolName: 'search_graph',
				argsPreview: '{"query":"authentication module"}',
				toolsCompleted: 0,
			}));
			assert.strictEqual(card.toolTraces.length, 1);

			reduceCardState(card, textDelta({
				subAgentId: agentId, text: 'Let me explore the authentication module structure...',
			}));

			reduceCardState(card, toolCompleted({
				subAgentId: agentId, toolName: 'search_graph',
				resultPreview: 'Found: src/auth/index.ts, src/auth/AuthService.ts, src/auth/middleware.ts',
				toolsCompleted: 1,
			}));
			assert.strictEqual(card.toolTraces[0].status, 'done');
			assert.ok(card.toolTraces[0].result?.includes('AuthService.ts'));

			// Phase 2: Read key files
			reduceCardState(card, toolStarted({
				subAgentId: agentId, toolName: 'file_read',
				argsPreview: '{"path":"src/auth/AuthService.ts"}',
				toolsCompleted: 1,
			}));
			assert.strictEqual(card.toolTraces.length, 2);

			reduceCardState(card, textDelta({
				subAgentId: agentId, text: 'Reading the main auth service file...',
			}));

			reduceCardState(card, toolCompleted({
				subAgentId: agentId, toolName: 'file_read',
				resultPreview: 'export class AuthService { login(): Promise<Token>; logout(): void; }',
				toolsCompleted: 2,
			}));
			assert.ok(card.toolTraces[1].result?.includes('login()'));

			// Phase 3: Search for patterns
			reduceCardState(card, toolStarted({
				subAgentId: agentId, toolName: 'search_code',
				argsPreview: '{"pattern":"TODO|FIXME","path":"src/auth"}',
				toolsCompleted: 2,
			}));

			reduceCardState(card, toolCompleted({
				subAgentId: agentId, toolName: 'search_code',
				resultPreview: '2 matches: TODO: add refresh token rotation (line 45), FIXME: handle expired tokens (line 78)',
				toolsCompleted: 3,
			}));

			// Phase 4: Final output
			reduceCardState(card, completed({
				subAgentId: agentId,
				output: [
					'# Authentication Module Analysis',
					'',
					'## Key Files',
					'- `src/auth/index.ts` — barrel export',
					'- `src/auth/AuthService.ts` — main service with login/logout',
					'- `src/auth/middleware.ts` — Express middleware',
					'',
					'## Observations',
					'- Uses JWT-based auth with token pairs',
					'- Missing refresh token rotation (TODO at line 45)',
					'- Token expiry handling needs improvement',
					'',
					'## Recommendations',
					'- Implement refresh token rotation',
					'- Add token blacklist for logout',
				].join('\n'),
			}));

			// Final assertions
			assert.strictEqual(card.status, 'done');
			assert.strictEqual(card.toolTraces.length, 3);
			assert.deepStrictEqual(
				card.toolTraces.map(t => t.name),
				['search_graph', 'file_read', 'search_code']
			);
			assert.deepStrictEqual(
				card.toolTraces.map(t => t.status),
				['done', 'done', 'done']
			);
			assert.ok(card.output?.includes('Authentication Module Analysis'));
			assert.ok(card.output?.includes('JWT-based auth'));
			assert.ok(card.streamingOutput?.includes('Let me explore'));
		});
	});
});
