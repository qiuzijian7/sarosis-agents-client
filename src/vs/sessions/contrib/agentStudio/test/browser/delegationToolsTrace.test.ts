/*---------------------------------------------------------------------------------------------
 *  delegationTools trace 管线测试
 *
 *  覆盖 delegate_task 新增的 inlineTraceSink → cardMap → fireSubAgentTrace
 *  旁路管线，以及 extractToolTracesFromResult / normalizeTaskArg 纯函数。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { extractToolTracesFromResult, normalizeTaskArg, partialDelegationAdvisory, resolveFinalToolTraces, slugifyAgentName, stripCompletionGateFooter } from '../../browser/providers/tool/delegationTools.js';
import { reduceCardState, type MutableCardState } from '../../common/subAgentCardReducer.js';
import { SubAgentEventType, type SubAgentEvent, type SubAgentResult } from '../../common/unifiedSubAgentDispatch.js';

suite('delegationTools Trace', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── extractToolTracesFromResult ───────────────────────────────────────

	suite('extractToolTracesFromResult', () => {

		test('empty toolTrace → empty array', () => {
			const result = { success: true, output: 'done', completedAt: Date.now() } as SubAgentResult;
			const traces = extractToolTracesFromResult(result);
			assert.deepStrictEqual(traces, []);
		});

		test('maps toolName + status correctly', () => {
			const result = {
				success: true, output: 'ok', completedAt: Date.now(),
				toolTrace: [{ toolName: 'file_read', status: 'ok' }],
			} as any as SubAgentResult;
			const traces = extractToolTracesFromResult(result);
			assert.strictEqual(traces.length, 1);
			assert.strictEqual(traces[0].name, 'file_read');
			assert.strictEqual(traces[0].status, 'done');
		});

		test('error status → status=error', () => {
			const result = {
				success: false, error: 'boom', completedAt: Date.now(),
				toolTrace: [{ toolName: 'search_files', status: 'error', error: 'timeout' }],
			} as any as SubAgentResult;
			const traces = extractToolTracesFromResult(result);
			assert.strictEqual(traces.length, 1);
			assert.strictEqual(traces[0].status, 'error');
			assert.strictEqual(traces[0].result, 'timeout');
		});

		test('args/result size display', () => {
			const result = {
				success: true, output: 'ok', completedAt: Date.now(),
				toolTrace: [{
					toolName: 'file_read', status: 'ok',
					argsSizeBytes: 1024, resultSizeBytes: 2048,
				}],
			} as any as SubAgentResult;
			const traces = extractToolTracesFromResult(result);
			assert.strictEqual(traces[0].args, '1024B args');
			assert.strictEqual(traces[0].result, '2048B result');
		});

		test('multiple traces in order', () => {
			const result = {
				success: true, output: 'ok', completedAt: Date.now(),
				toolTrace: [
					{ toolName: 'file_read', status: 'ok' },
					{ toolName: 'search_files', status: 'ok' },
					{ toolName: 'terminal', status: 'error', error: 'cancelled' },
				],
			} as any as SubAgentResult;
			const traces = extractToolTracesFromResult(result);
			assert.strictEqual(traces.length, 3);
			assert.deepStrictEqual(traces.map(t => t.name), ['file_read', 'search_files', 'terminal']);
			assert.deepStrictEqual(traces.map(t => t.status), ['done', 'done', 'error']);
		});

		test('unknown toolName → "unknown"', () => {
			const result = {
				success: true, output: 'ok', completedAt: Date.now(),
				toolTrace: [{ status: 'ok' }],
			} as any as SubAgentResult;
			const traces = extractToolTracesFromResult(result);
			assert.strictEqual(traces[0].name, 'unknown');
		});
	});

	// ─── normalizeTaskArg ──────────────────────────────────────────────────

	suite('normalizeTaskArg', () => {

		test('string passthrough', () => {
			assert.strictEqual(normalizeTaskArg('hello world'), 'hello world');
		});

		test('null/undefined → empty', () => {
			assert.strictEqual(normalizeTaskArg(null as any), '');
			assert.strictEqual(normalizeTaskArg(undefined as any), '');
		});

		test('object with task field → extracts task', () => {
			assert.strictEqual(
				normalizeTaskArg({ task: 'analyze GC', role: 'explore', type: 'readonly' }),
				'analyze GC'
			);
		});

		test('object with description fallback', () => {
			assert.strictEqual(
				normalizeTaskArg({ description: 'find issues', role: 'review' }),
				'find issues'
			);
		});

		test('object without recognized field → JSON', () => {
			const result = normalizeTaskArg({ foo: 'bar' });
			assert.strictEqual(typeof result, 'string');
			assert.ok(result.includes('foo'));
		});

		test('array → joins with newlines', () => {
			assert.strictEqual(
				normalizeTaskArg(['task a', 'task b']),
				'task a\n\ntask b'
			);
		});
	});

	// ─── reduceCardState (toolTraces accumulation) ──────────────────────────

	suite('reduceCardState with ToolStarted / ToolCompleted', () => {

		function createCard(): MutableCardState {
			return {
				id: 'sa-1',
				type: 'explore',
				task: 'test task',
				status: 'running',
				toolTraces: [],
			};
		}

		test('ToolStarted → adds running entry', () => {
			const card = createCard();
			const ev: SubAgentEvent = {
				type: SubAgentEventType.ToolStarted,
				subAgentId: 'sa-1',
				toolCallId: 'tc-1',
				toolName: 'file_read',
				toolArgsPreview: 'path="/src/app.ts"',
			};
			reduceCardState(card, ev);
			assert.strictEqual(card.toolTraces.length, 1);
			assert.strictEqual(card.toolTraces[0].name, 'file_read');
			assert.strictEqual(card.toolTraces[0].status, 'running');
			assert.strictEqual(card.toolTraces[0].args, 'path="/src/app.ts"');
		});

		test('ToolCompleted → completes matching running entry', () => {
			const card = createCard();
			// First: ToolStarted
			reduceCardState(card, {
				type: SubAgentEventType.ToolStarted,
				subAgentId: 'sa-1',
				toolCallId: 'tc-1',
				toolName: 'search_files',
				toolArgsPreview: 'pattern="*.ts"',
			});
			// Then: ToolCompleted
			reduceCardState(card, {
				type: SubAgentEventType.ToolCompleted,
				subAgentId: 'sa-1',
				toolCallId: 'tc-1',
				toolName: 'search_files',
				toolResultPreview: '3 results',
			});
			assert.strictEqual(card.toolTraces.length, 1);
			assert.strictEqual(card.toolTraces[0].name, 'search_files');
			assert.strictEqual(card.toolTraces[0].status, 'done');
			assert.strictEqual(card.toolTraces[0].result, '3 results');
		});

		test('ToolCompleted with toolStatus=error → marks error', () => {
			const card = createCard();
			reduceCardState(card, {
				type: SubAgentEventType.ToolStarted,
				subAgentId: 'sa-1',
				toolCallId: 'tc-1',
				toolName: 'terminal',
				toolArgsPreview: 'command="rm -rf /"',
			});
			// reduceCardState 通过 event.toolStatus 判断 error，非 event.error
			reduceCardState(card, {
				type: SubAgentEventType.ToolCompleted,
				subAgentId: 'sa-1',
				toolCallId: 'tc-1',
				toolName: 'terminal',
				toolStatus: 'error',
				toolResultPreview: 'Permission denied',
			} as SubAgentEvent);
			assert.strictEqual(card.toolTraces[0].status, 'error');
			assert.strictEqual(card.toolTraces[0].result, 'Permission denied');
		});

		test('multiple tools → distinct entries', () => {
			const card = createCard();
			// Tool 1
			reduceCardState(card, {
				type: SubAgentEventType.ToolStarted,
				subAgentId: 'sa-1', toolCallId: 't1', toolName: 'file_read', toolArgsPreview: 'p1',
			});
			reduceCardState(card, {
				type: SubAgentEventType.ToolCompleted,
				subAgentId: 'sa-1', toolCallId: 't1', toolName: 'file_read', toolResultPreview: 'r1',
			});
			// Tool 2
			reduceCardState(card, {
				type: SubAgentEventType.ToolStarted,
				subAgentId: 'sa-1', toolCallId: 't2', toolName: 'search_files', toolArgsPreview: 'p2',
			});
			reduceCardState(card, {
				type: SubAgentEventType.ToolCompleted,
				subAgentId: 'sa-1', toolCallId: 't2', toolName: 'search_files', toolResultPreview: 'r2',
			});

			assert.strictEqual(card.toolTraces.length, 2);
			assert.deepStrictEqual(card.toolTraces.map(t => t.name), ['file_read', 'search_files']);
			assert.deepStrictEqual(card.toolTraces.map(t => t.status), ['done', 'done']);
			assert.deepStrictEqual(card.toolTraces.map(t => t.result), ['r1', 'r2']);
		});
	});

	// ─── formatSubAgentId ─────────────────────────────────────────────────

	suite('formatSubAgentId', () => {
		let formatSubAgentId: (id: string) => string;
		suiteSetup(async () => {
			const mod = await import('../../../../browser/agentChat/subAgentCardUtils.js');
			formatSubAgentId = mod.formatSubAgentId;
		});

		test('shortens full subagent id to suffix', () => {
			assert.strictEqual(formatSubAgentId('subagent-1784816784503-r8slpypyu'), 'r8slpypyu');
			assert.strictEqual(formatSubAgentId('subagent-1784816784503-int4yz8au'), 'int4yz8au');
		});
		test('short single-dash id returns suffix', () => {
			assert.strictEqual(formatSubAgentId('plan-explore-123'), '123');
		});
		test('no dash → returns original', () => {
			assert.strictEqual(formatSubAgentId('simpleid'), 'simpleid');
		});
		test('empty string → empty', () => {
			assert.strictEqual(formatSubAgentId(''), '');
		});
	});

	// ─── formatSubAgentTask ──────────────────────────────────────────────

	suite('formatSubAgentTask', () => {
		let formatSubAgentTask: (task: string | undefined, label: string) => string;
		suiteSetup(async () => {
			const mod = await import('../../../../browser/agentChat/subAgentCardUtils.js');
			formatSubAgentTask = mod.formatSubAgentTask;
		});

		test('undefined → fallback label', () => {
			assert.strictEqual(formatSubAgentTask(undefined, '探索'), 'SubAgent (探索)');
		});
		test('empty string → fallback', () => {
			assert.strictEqual(formatSubAgentTask('', '探索'), 'SubAgent (探索)');
		});
		test('plain string passed through', () => {
			assert.strictEqual(formatSubAgentTask('find GC triggers', '探索'), 'find GC triggers');
		});
		test('JSON with focus → extracts focus', () => {
			const task = JSON.stringify({ focus: 'Search the S1Game project' });
			assert.strictEqual(formatSubAgentTask(task, '探索'), 'Search the S1Game project');
		});
		test('JSON with description → extracts description', () => {
			const task = JSON.stringify({ description: 'Analyze auth module' });
			assert.strictEqual(formatSubAgentTask(task, '探索'), 'Analyze auth module');
		});
		test('JSON with title fallback', () => {
			const task = JSON.stringify({ title: 'Token Service' });
			assert.strictEqual(formatSubAgentTask(task, '探索'), 'Token Service');
		});
		test('JSON with content fallback', () => {
			const task = JSON.stringify({ content: 'Middlewares' });
			assert.strictEqual(formatSubAgentTask(task, '探索'), 'Middlewares');
		});
		test('JSON with task fallback', () => {
			const task = JSON.stringify({ task: 'delegated task' });
			assert.strictEqual(formatSubAgentTask(task, '探索'), 'delegated task');
		});
		test('no recognized field → keeps raw JSON', () => {
			const task = JSON.stringify({ role: 'explore', type: 'readonly' });
			assert.strictEqual(formatSubAgentTask(task, '探索'), task);
		});
		test('truncates at 200 chars + …', () => {
			const long = 'x'.repeat(250);
			const r = formatSubAgentTask(long, '探索');
			assert.strictEqual(r, 'x'.repeat(200) + '…');
			assert.strictEqual(r.length, 201); // 200 + …
		});
		test('plain string under 200 → no truncation', () => {
			const short = 'x'.repeat(150);
			assert.strictEqual(formatSubAgentTask(short, '探索'), short);
		});
	});

	// ─── filterChildSubAgents ────────────────────────────────────────────

	suite('filterChildSubAgents', () => {
		let filterChildSubAgents: (sas: any[] | undefined, ptcId: string) => any[];
		suiteSetup(async () => {
			const mod = await import('../../../../browser/agentChat/subAgentCardUtils.js');
			filterChildSubAgents = mod.filterChildSubAgents;
		});
		function sa(overrides: Record<string, any> = {}): any {
			return { id: 'sa-1', type: 'explore', task: 'test', status: 'done',
				parentToolCallId: 'tc-1', toolTraces: [], ...overrides };
		}

		test('matches by parentToolCallId', () => {
			const a = sa({ id: 'a', parentToolCallId: 'PTC-1' });
			const b = sa({ id: 'b', parentToolCallId: 'PTC-1' });
			const c = sa({ id: 'c', parentToolCallId: 'OTHER' });
			const r = filterChildSubAgents([a, c, b], 'PTC-1');
			assert.strictEqual(r.length, 2);
			assert.deepStrictEqual(r.map(x => x.id), ['a', 'b']);
		});
		test('no match → empty', () => {
			const r = filterChildSubAgents([sa({ id: 'x' })], 'no-match');
			assert.strictEqual(r.length, 0);
		});
		test('undefined subAgents → empty', () => {
			assert.deepStrictEqual(filterChildSubAgents(undefined, 'PTC'), []);
		});
		test('empty parentToolCallId → empty', () => {
			assert.deepStrictEqual(filterChildSubAgents([sa()], ''), []);
		});
		test('nullish parentToolCallId on sa → not matched', () => {
			const noPtc = sa({ id: 'n', parentToolCallId: undefined });
			assert.strictEqual(filterChildSubAgents([noPtc], 'PTC-1').length, 0);
		});
	});

	// ─── countSubAgentStatuses ───────────────────────────────────────────

	suite('countSubAgentStatuses', () => {
		let countSubAgentStatuses: (sas: any[]) => { done: number; running: number; error: number };
		suiteSetup(async () => {
			const mod = await import('../../../../browser/agentChat/subAgentCardUtils.js');
			countSubAgentStatuses = mod.countSubAgentStatuses;
		});
		function sa(status: string): any {
			return { id: 's', type: 'explore', task: 't', status, parentToolCallId: 'p', toolTraces: [] };
		}

		test('all done', () => {
			const r = countSubAgentStatuses([sa('done'), sa('done')]);
			assert.deepStrictEqual(r, { done: 2, running: 0, error: 0 });
		});
		test('mixed statuses', () => {
			const r = countSubAgentStatuses([sa('done'), sa('running'), sa('error'), sa('cancelled')]);
			assert.deepStrictEqual(r, { done: 1, running: 1, error: 2 });
		});
		test('empty → all zero', () => {
			assert.deepStrictEqual(countSubAgentStatuses([]), { done: 0, running: 0, error: 0 });
		});
		test('only running', () => {
			const r = countSubAgentStatuses([sa('running'), sa('running')]);
			assert.deepStrictEqual(r, { done: 0, running: 2, error: 0 });
		});
	});

	// ─── resolveFinalToolTraces ─────────────────────────────────────────────
// 回归：终态快照必须优先复用流式积累的 toolTraces（含 args/result 预览），
// 仅在流式数据为空时回退到 result.toolTrace 提取（仅 size 摘要）。
// 否则终态快照 last-write-wins 会把卡片刷成只剩 output 文本。

suite('resolveFinalToolTraces', () => {

	const streamingTraces = [
		{ id: 'sa-1-t0', name: 'search_files', status: 'done' as const, args: '{"pattern":"*.ts"}', result: '3 files' },
		{ id: 'sa-1-t1', name: 'file_read', status: 'done' as const, args: '{"path":"a.ts"}', result: 'content…' },
	];

	test('streaming traces present → preferred verbatim (copied)', () => {
		const card = { toolTraces: streamingTraces };
		const result = {
			success: true, output: 'ok', completedAt: Date.now(),
			toolTrace: [{ toolName: 'search_graph', status: 'ok', argsSizeBytes: 100 }],
		} as any as SubAgentResult;
		const traces = resolveFinalToolTraces(card, result, 'sa-1');
		assert.deepStrictEqual(traces.map(t => t.name), ['search_files', 'file_read']);
		assert.strictEqual(traces[0].args, '{"pattern":"*.ts"}');
		// 返回副本而非原数组引用
		assert.notStrictEqual(traces[0], streamingTraces[0]);
	});

	test('streaming empty → fallback to result.toolTrace extraction', () => {
		const card = { toolTraces: [] };
		const result = {
			success: true, output: 'ok', completedAt: Date.now(),
			toolTrace: [{ toolName: 'search_graph', status: 'ok', argsSizeBytes: 245, resultSizeBytes: 93225 }],
		} as any as SubAgentResult;
		const traces = resolveFinalToolTraces(card, result, 'sa-9');
		assert.strictEqual(traces.length, 1);
		assert.strictEqual(traces[0].name, 'search_graph');
		assert.strictEqual(traces[0].id, 'sa-9-t0');
		assert.strictEqual(traces[0].args, '245B args');
	});

	test('no card + empty result.toolTrace → empty (legitimate no-tools case)', () => {
		const result = { success: true, output: 'ok', completedAt: Date.now() } as SubAgentResult;
		assert.deepStrictEqual(resolveFinalToolTraces(undefined, result, 'sa-1'), []);
	});
});

// ─── stripCompletionGateFooter ──────────────────────────────────────────
// 回归：卡片 output 区不应显示 dispatch 追加给父 agent 的 gate 契约页脚。

suite('stripCompletionGateFooter', () => {

	test('strips footer with preceding blank line', () => {
		const out = 'Analysis result here.\n\n[COMPLETION GATE] status=success acceptanceMet=true — completed cleanly';
		assert.strictEqual(stripCompletionGateFooter(out), 'Analysis result here.');
	});

	test('no footer → unchanged', () => {
		assert.strictEqual(stripCompletionGateFooter('plain output'), 'plain output');
	});

	test('only footer → empty', () => {
		assert.strictEqual(stripCompletionGateFooter('[COMPLETION GATE] status=partial — no findings'), '');
	});
});

// ─── slugifyAgentName (regression) ─────────────────────────────────────

	suite('slugifyAgentName', () => {
		test('basic name → slug', () => {
			assert.strictEqual(slugifyAgentName('Code Reviewer'), 'code-reviewer');
		});
		test('mixed case and spaces', () => {
			assert.strictEqual(slugifyAgentName('My Coding Agent'), 'my-coding-agent');
		});
		test('special chars removed', () => {
			const slug = slugifyAgentName('UI/UX Designer');
			assert.ok(/^[a-z0-9-]+$/.test(slug));
		});
		test('empty/invalid → fallback timestamp', () => {
			const slug = slugifyAgentName('🎉🎉🎉');
			assert.ok(slug.startsWith('agent-'));
		});
	});

// ─── partialDelegationAdvisory（log 1785231958842：partial 不当 success 用）──

	suite('partialDelegationAdvisory', () => {
		test('advisory flags result as PARTIAL and forbids treating as final', () => {
			const advisory = partialDelegationAdvisory();
			assert.ok(advisory.includes('PARTIAL'), '应明确标注 PARTIAL');
			assert.ok(advisory.includes('INCOMPLETE'), '应说明结果不完整');
			assert.ok(advisory.includes('Do NOT treat it as a finished answer'), '应禁止当完成结果用');
		});
		test('advisory offers re-dispatch or explicit-gap options', () => {
			const advisory = partialDelegationAdvisory();
			assert.ok(advisory.includes('re-dispatch'), '应提供收窄再派选项');
			assert.ok(advisory.includes('unverified'), '应提供明示用户未验证项的选项');
		});
	});
});
