/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { UnifiedSubAgentDispatch, SubAgentType, SubAgentEventType, SUB_AGENT_TYPE_LABELS, resolveSubAgentTypeLabel, resolveIsolationLevel, previewStructured, type SubAgentEvent } from '../../common/unifiedSubAgentDispatch.js';
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

	// ─── 2026-07-25 线上事故回归：mid-turn provider done 不得杀死子代理 turn ───
	// executeAgentTurn 会在每个迭代的 provider 流结束透传一个 done delta
	// （languageModelsBridge 流尾统一 yield done，executor 经 _adaptModelDelta 转发）。
	// _executeWithBudget 曾在 done 处 break → for-await return() 掉 executor 生成器，
	// 本轮工具未执行、后续迭代夭折，子代理带"开场白"空转返回。

	test('mid-turn provider done 后仍继续消费（工具执行与后续迭代不被腰斩）', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		// 模拟 executor 真实 yield 序列：迭代1 text+tool_start → provider done 透传
		// → 工具执行 tool_result/tool_end → 迭代2 最终答案 → 轮末 lifecycle done。
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			yield { type: 'text', content: 'I\'ll start by searching. ' } as any;
			yield { type: 'tool_start', toolCallId: 'tc-1', toolName: 'search_files' } as any;
			// provider 流尾 done（finishReason=tool_calls）——旧代码在此 break，后面全部丢失
			yield { type: 'done', finishReason: 'tool_calls' } as any;
			yield { type: 'tool_result', content: 'found 3 files', toolCallId: 'tc-1' } as any;
			yield { type: 'tool_end', toolCallId: 'tc-1', toolName: 'search_files', success: true } as any;
			yield { type: 'text', content: 'Final answer: IncrementalPurgeGarbage at line 5190.' } as any;
			yield { type: 'done' } as any;
		};

		const result = await dispatch.dispatch('parent-1', 'Locate the purge implementation', execFn, { type: SubAgentType.Explore });

		assert.strictEqual(result.success, true);
		assert.ok(result.output.includes('Final answer: IncrementalPurgeGarbage at line 5190.'),
			`最终答案必须进入 output（mid-turn done 后内容不得丢失），实际: ${result.output.slice(0, 120)}`);
		assert.ok(result.output.includes('I\'ll start by searching.'), '开场白也应保留');
		assert.strictEqual(result.toolTrace?.length, 1, 'tool_end 在 provider done 之后到达，toolTrace 必须有条目');
		assert.strictEqual(result.toolTrace?.[0]?.toolName, 'search_files');
	});

	// ─── 2026-07-25 时间/结束逻辑优化回归：salvage + 深度封顶工具隐藏 ───

	test('salvage：预算耗尽(max_iterations)但有真实工具产出 → 部分成功', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		// maxIterations=1：第一次 tool_end 后 budget 耗尽 → max_iterations
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			yield { type: 'text', content: '先搜索源码，发现了 IncrementalPurgeGarbage 的关键行号 5190。 ' } as any;
			yield { type: 'tool_start', toolCallId: 'tc-1', toolName: 'search_files' } as any;
			yield { type: 'tool_end', toolCallId: 'tc-1', toolName: 'search_files', success: true } as any;
			yield { type: 'text', content: '这段文本在预算耗尽后到达，不应出现。' } as any;
		};

		const result = await dispatch.dispatch('parent-1', 'explore task', execFn, {
			type: SubAgentType.Explore, maxIterations: 1,
		});

		assert.strictEqual(result.exitReason, 'max_iterations');
		assert.strictEqual(result.success, true, 'salvage：有真实产出应部分成功');
		assert.ok(result.output.includes('[部分完成'), `应含部分完成标注，实际: ${result.output.slice(0, 120)}`);
		assert.ok(result.output.includes('5190'), '已获取的发现必须透传');
	});

	test('无 salvage：预算耗尽且 0 个成功工具 → 仍判失败', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			yield { type: 'tool_start', toolCallId: 'tc-1', toolName: 'search_files' } as any;
			yield { type: 'tool_end', toolCallId: 'tc-1', toolName: 'search_files', success: false } as any;
		};

		const result = await dispatch.dispatch('parent-1', 'explore task', execFn, {
			type: SubAgentType.Explore, maxIterations: 1,
		});

		assert.strictEqual(result.exitReason, 'max_iterations');
		assert.strictEqual(result.success, false, '0 个成功工具不触发 salvage');
	});

	// ─── 2026-07-25 用户规则：不限轮数 + 工具活动 180s 超时 ───

	test('不限轮数：工具调用次数远超旧预算上限(50)也不触发 max_iterations', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			yield { type: 'text', content: '开始批量探索。 ' } as any;
			for (let i = 0; i < 120; i++) {
				yield { type: 'tool_start', toolCallId: `tc-${i}`, toolName: 'search_files' } as any;
				yield { type: 'tool_end', toolCallId: `tc-${i}`, toolName: 'search_files', success: true } as any;
			}
			yield { type: 'text', content: '120 次工具调用后的最终结论。' } as any;
		};

		const result = await dispatch.dispatch('parent-1', 'heavy task', execFn, { type: SubAgentType.Explore });
		assert.strictEqual(result.exitReason, 'completed', `不应 max_iterations，实际: ${result.exitReason}`);
		assert.strictEqual(result.success, true);
		assert.strictEqual(result.toolTrace?.length, 120);
	});

	test('工具活动超时：最后一次工具调用后停滞 → timeout + salvage 部分结果', async () => {
		const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 1, 60); // stallTimeoutMs=60
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			yield { type: 'text', content: '先做了一次搜索。 ' } as any;
			yield { type: 'tool_start', toolCallId: 'tc-1', toolName: 'search_files' } as any;
			yield { type: 'tool_end', toolCallId: 'tc-1', toolName: 'search_files', success: true } as any;
			// 工具活动结束后静默 120ms（> 60ms 阈值）→ 看门狗触发；
			// 随后的文本 delta 让循环评估 isStalled → 判 timeout。
			await new Promise(r => setTimeout(r, 120));
			yield { type: 'text', content: '迟到的后续文本。' } as any;
		};

		const result = await dispatch.dispatch('parent-1', 'stall task', execFn, { type: SubAgentType.Explore });
		assert.strictEqual(result.exitReason, 'timeout', `应为 timeout，实际: ${result.exitReason}`);
		assert.strictEqual(result.success, true, '有成功工具调用 → salvage 部分成功');
		assert.ok(result.output.includes('[部分完成'), '应含部分完成标注');
	});

	// ─── 2026-07-26 MiMo 对齐重构：内容级计活 + 工具执行暂停 + 单响应软上限 ───

	test('内容级计活：持续文本流（长最终答案）不再误判停滞', async () => {
		const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 1, 60); // stallTimeoutMs=60
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			// 连续文本输出（每 40ms 一段，共 ~160ms > 60ms 停滞阈值）。
			// 旧语义（仅工具活动计活）会在 60ms 误判停滞；新语义下文本质delta
			// 持续计活 → 不超时，正常完成（长最终答案场景，事故 1785037741973）。
			for (let i = 0; i < 4; i++) {
				yield { type: 'text', content: `最终答案第 ${i} 段。 ` } as any;
				await new Promise(r => setTimeout(r, 40));
			}
		};

		const result = await dispatch.dispatch('parent-1', 'long answer task', execFn, { type: SubAgentType.Explore });
		assert.strictEqual(result.exitReason, 'completed', `长文本流应正常完成，实际: ${result.exitReason}`);
	});

	test('工具执行盲区修复：长工具执行期间看门狗暂停，不误判停滞', async () => {
		const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 1, 60); // stallTimeoutMs=60
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			// tool_start 后静默 120ms（模拟长工具执行，期间无任何 delta——嵌套
			// delegate_task 场景），旧语义 60ms 即误判停滞；新语义暂停看门狗。
			// （工具名用探索工具，避免触发 Explore 完成门 noRealExploration 降级）
			yield { type: 'tool_start', toolCallId: 'tc-1', toolName: 'search_files' } as any;
			await new Promise(r => setTimeout(r, 120));
			yield { type: 'tool_end', toolCallId: 'tc-1', toolName: 'search_files', success: true } as any;
			yield { type: 'text', content: '工具完成后的结论。' } as any;
		};

		const result = await dispatch.dispatch('parent-1', 'nested delegation task', execFn, { type: SubAgentType.Explore });
		assert.strictEqual(result.exitReason, 'completed', `长工具执行不应误判停滞，实际: ${result.exitReason}`);
		assert.strictEqual(result.success, true);
	});

	test('tool_progress 计活：工具参数生成进度信号为看门狗续命', async () => {
		const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 1, 60); // stallTimeoutMs=60
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			// 真实时序（provider 只在 finish_reason 才发完整 tool_call → tool_start
			// 在参数流之后到达）：参数流式期间看门狗未被 pause 保护，全靠
			// tool_progress 计活（共 ~160ms > 60ms 阈值）→ 不误判停滞
			// （事故 1785049332701）。若 tool_progress 不计活，60ms 即误判。
			for (let i = 0; i < 4; i++) {
				yield { type: 'tool_progress', stage: `正在生成工具调用参数… 已 ${i + 1} KB` } as any;
				await new Promise(r => setTimeout(r, 40));
			}
			yield { type: 'tool_start', toolCallId: 'tc-1', toolName: 'file_write' } as any;
			yield { type: 'tool_end', toolCallId: 'tc-1', toolName: 'file_write', success: true } as any;
			yield { type: 'text', content: '文件已写入。' } as any;
		};

		// 用 General 型：Explore 型的 noRealExploration 完成门会因 file_write
		// 非探索工具降级 partial（与本测试关注点无关）。
		const result = await dispatch.dispatch('parent-1', 'write big file task', execFn, { type: SubAgentType.General });
		assert.strictEqual(result.exitReason, 'completed', `参数生成进度期不应误判停滞，实际: ${result.exitReason}`);
		assert.strictEqual(result.success, true);
	});

	// ─── P1（2026-07-26，对齐 MiMo max-steps）：停滞禁工具强制总结 ───

	test('停滞后有工具产出 → 禁工具总结轮成功：output 用模型自己的总结', async () => {
		const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 1, 60); // stallTimeoutMs=60
		const requests: IAgentTurnRequest[] = [];
		const execFn = async function* (r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			requests.push(r);
			const isSummaryRound = r.excludedTools?.length === 1 && r.excludedTools[0] === '*';
			if (!isSummaryRound) {
				// 主轮：1 个 ok 工具，然后静默 250ms（>60ms 阈值 → 停滞；
				// 余量放宽——事件循环负载下 60ms 泵可能被推迟，120ms 太薄曾抖动）
				yield { type: 'tool_start', toolCallId: 'tc-1', toolName: 'search_files' } as any;
				yield { type: 'tool_end', toolCallId: 'tc-1', toolName: 'search_files', success: true } as any;
				yield { type: 'text', content: '原始片段：我找到了一些线索，' } as any;
				await new Promise(r2 => setTimeout(r2, 250));
				yield { type: 'text', content: '（停滞后的迟到文本）' } as any;
			} else {
				// 总结轮：禁工具，直接输出总结
				yield { type: 'text', content: '【模型总结】已完成：找到 3 个关键文件；未完成：未验证调用链；建议：从 GC.cpp 入手。' } as any;
			}
		};

		const result = await dispatch.dispatch('parent-1', 'explore gc', execFn, { type: SubAgentType.General });
		assert.strictEqual(result.exitReason, 'timeout', `停滞应保留 timeout 事实，实际: ${result.exitReason}`);
		assert.strictEqual(result.success, true, '有 ok 工具 → salvage 部分成功');
		assert.ok(result.output?.includes('[部分完成'), 'salvage 头仍在 settle 路径添加');
		assert.ok(result.output?.includes('【模型总结】'), `output 应用模型总结而非原始片段，got: ${result.output?.slice(0, 200)}`);
		assert.ok(!result.output?.includes('原始片段'), '原始片段不应再作为正文');
		assert.strictEqual(requests.length, 2, '应有主轮+总结轮两次执行');
		assert.deepStrictEqual(requests[1].excludedTools, ['*'], '总结轮必须禁工具');
		const lastMsg = requests[1].messages[requests[1].messages.length - 1];
		assert.ok(String((lastMsg as any).content).includes('禁止调用任何工具'), '总结提示词应随消息注入');
	});

	test('停滞后总结轮也停滞 → 回退原始片段（best effort）', async () => {
		const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 1, 60);
		const execFn = async function* (r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			const isSummaryRound = r.excludedTools?.length === 1 && r.excludedTools[0] === '*';
			yield { type: 'tool_start', toolCallId: 'tc-1', toolName: 'search_files' } as any;
			yield { type: 'tool_end', toolCallId: 'tc-1', toolName: 'search_files', success: true } as any;
			yield { type: 'text', content: isSummaryRound ? '（总结轮也开始卡死）' : '原始片段：部分线索。' } as any;
			await new Promise(r2 => setTimeout(r2, 250)); // 两轮都静默 >60ms → 双双停滞（余量同放宽）
			yield { type: 'text', content: '（迟到文本）' } as any;
		};

		const result = await dispatch.dispatch('parent-1', 'explore gc 2', execFn, { type: SubAgentType.General });
		assert.strictEqual(result.exitReason, 'timeout');
		assert.strictEqual(result.success, true, 'salvage 仍成立（原始片段回退）');
		assert.ok(result.output?.includes('原始片段'), `总结轮失败应回退原始片段，got: ${result.output?.slice(0, 200)}`);
	});

	test('单响应软上限：连续文本流超过软上限 → timeout 且无 salvage', async () => {
		const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 1, 60_000); // 停滞阈值放宽，隔离软上限变量
		dispatch.responseSoftCapMs = 100; // 软上限 100ms
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			// 空谈永动：每 40ms 一段文本（内容计活，看门狗不触发），但连续
			// ~160ms > 100ms 软上限 → 判停滞中止。0 工具调用 → 不触发 salvage。
			for (let i = 0; i < 4; i++) {
				yield { type: 'text', content: `持续空谈第 ${i} 段。 ` } as any;
				await new Promise(r => setTimeout(r, 40));
			}
		};

		const result = await dispatch.dispatch('parent-1', 'chatty task', execFn, { type: SubAgentType.Explore });
		assert.strictEqual(result.exitReason, 'timeout', `空谈永动应判 timeout，实际: ${result.exitReason}`);
		assert.strictEqual(result.success, false, '0 个成功工具 → 不触发 salvage');
	});

	// ─── 2026-07-26 "搜索内容显示 0" 回归：previewStructured 不产生索引键垃圾 ───

	// ─── 2026-07-26 用户决策：「一个 subagent 执行完毕所有任务」——会话复用 ───

	suite('delegate_task 子代理会话复用（follow-up 续跑）', () => {

		const okFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			yield { type: 'text', content: '任务完成的结论。' } as any;
		};

		test('完成后 findReusableSubAgent 可找到同类型子代理', async () => {
			const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 2);
			await dispatch.dispatch('parent-1', 'task A', okFn, { type: SubAgentType.Explore });
			const found = dispatch.findReusableSubAgent('parent-1', SubAgentType.Explore);
			assert.ok(found, '完成后应可复用');
			// 类型不同 → 不复用
			assert.strictEqual(dispatch.findReusableSubAgent('parent-1', SubAgentType.General), undefined);
			// 父 agent 不同 → 不复用
			assert.strictEqual(dispatch.findReusableSubAgent('parent-2', SubAgentType.Explore), undefined);
		});

		test('复用窗口过期 → 不再复用', async () => {
			const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 2);
			dispatch.reuseWindowMs = 1; // 1ms 窗口
			await dispatch.dispatch('parent-1', 'task A', okFn, { type: SubAgentType.Explore });
			await new Promise(r => setTimeout(r, 20));
			assert.strictEqual(dispatch.findReusableSubAgent('parent-1', SubAgentType.Explore), undefined);
		});

		test('dispatchFollowUp：复用同一 sessionId（会话连续）+ 任务更新', async () => {
			const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 2);
			const spawnedIds: string[] = [];
			const sink = (ev: SubAgentEvent) => {
				if (ev.type === SubAgentEventType.Spawned) { spawnedIds.push(ev.subAgentId); }
			};
			const captured: IAgentTurnRequest[] = [];
			const execFn = async function* (r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
				captured.push(r);
				yield { type: 'text', content: '完成。' } as any;
			};

			await dispatch.dispatch('parent-1', 'task A', execFn, { type: SubAgentType.Explore }, sink);
			const reusable = dispatch.findReusableSubAgent('parent-1', SubAgentType.Explore)!;
			assert.ok(reusable);
			const firstId = reusable.id;

			const r2 = await dispatch.dispatchFollowUp(firstId, 'task B（后续任务）', execFn, sink);

			assert.strictEqual(r2.success, true);
			assert.strictEqual(spawnedIds.length, 2, '两次各一次 Spawned');
			assert.strictEqual(spawnedIds[1], firstId, 'follow-up 复用同一 subAgentId');
			assert.strictEqual(captured[1].sessionId, firstId, 'sessionId 不变 → 网关会话连续');
			assert.ok(captured[1].messages.some(m => m.content.includes('task B')), '新任务进入消息');
		});

		// ─── P3（2026-07-26，对齐 MiMo output_schema）：结构化交接 ───

	test('outputSchema：禁工具结构化轮成功 → output 为校验通过的 JSON 对象', async () => {
		const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 2);
		const requests: IAgentTurnRequest[] = [];
		const execFn = async function* (r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			requests.push(r);
			const isSchemaRound = r.excludedTools?.length === 1 && r.excludedTools[0] === '*';
			yield { type: 'text', content: isSchemaRound
				? '```json\n{"summary":"发现 3 个 GC 入口","key_files":["GC.cpp"]}\n```'
				: '探索完成：发现 3 个 GC 入口，关键在 GC.cpp。' } as any;
		};

		const result = await dispatch.dispatch('parent-1', 'explore gc', execFn, {
			type: SubAgentType.General,
			outputSchema: { type: 'object', required: ['summary'] },
		});
		assert.strictEqual(result.success, true);
		assert.strictEqual(requests.length, 2, '主轮+结构化轮共两次执行');
		assert.deepStrictEqual(requests[1].excludedTools, ['*'], '结构化轮必须禁工具');
		const parsed = JSON.parse(result.output ?? '');
		assert.strictEqual(parsed.summary, '发现 3 个 GC 入口');
		assert.deepStrictEqual(parsed.key_files, ['GC.cpp']);
	});

	test('outputSchema：首次输出不合规 → 重试 1 次后合规', async () => {
		const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 2);
		let schemaRounds = 0;
		const execFn = async function* (r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			const isSchemaRound = r.excludedTools?.length === 1 && r.excludedTools[0] === '*';
			if (!isSchemaRound) {
				yield { type: 'text', content: '探索完成。' } as any;
				return;
			}
			schemaRounds++;
			yield { type: 'text', content: schemaRounds === 1 ? '这不是 JSON，是散文。' : '{"summary":"整理后的结论"}' } as any;
		};

		const result = await dispatch.dispatch('parent-1', 'explore gc', execFn, {
			type: SubAgentType.General,
			outputSchema: { type: 'object', required: ['summary'] },
		});
		assert.strictEqual(result.success, true);
		assert.strictEqual(schemaRounds, 2, '不合规应重试一次');
		assert.deepStrictEqual(JSON.parse(result.output ?? ''), { summary: '整理后的结论' });
	});

	test('outputSchema：两次都不合规 → 回退自由文本（best effort 不硬失败）', async () => {
		const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 2);
		const execFn = async function* (r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			const isSchemaRound = r.excludedTools?.length === 1 && r.excludedTools[0] === '*';
			yield { type: 'text', content: isSchemaRound ? '{"other":"缺 required 键"}' : '自由文本结论：一切正常。' } as any;
		};

		const result = await dispatch.dispatch('parent-1', 'explore gc', execFn, {
			type: SubAgentType.General,
			outputSchema: { type: 'object', required: ['summary'] },
		});
		assert.strictEqual(result.success, true, '结构化失败不应拖垮任务');
		assert.ok(result.output?.includes('自由文本结论'), `应回退原始自由文本，got: ${result.output?.slice(0, 120)}`);
	});

	test('总时长上限（2026-07-26 MiMo 对齐）：超时走 salvage 保产出，而非硬失败', async () => {
		const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 1, 60_000); // 停滞阈值放宽，隔离变量
		const requests: IAgentTurnRequest[] = [];
		const execFn = async function* (r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			requests.push(r);
			const isSummaryRound = r.excludedTools?.length === 1 && r.excludedTools[0] === '*';
			if (!isSummaryRound) {
				yield { type: 'tool_start', toolCallId: 'tc-1', toolName: 'search_files' } as any;
				yield { type: 'tool_end', toolCallId: 'tc-1', toolName: 'search_files', success: true } as any;
				// 持续产出（每 40ms 一段）；wall-clock 100ms 后在下一 delta 触发限时收尾
				for (let i = 0; i < 10; i++) {
					yield { type: 'text', content: `探索进展 ${i}。` } as any;
					await new Promise(r2 => setTimeout(r2, 40));
				}
			} else {
				yield { type: 'text', content: '【模型总结】已完成：找到入口；未完成：未验证。' } as any;
			}
		};

		const result = await dispatch.dispatch('parent-1', 'long explore', execFn, { type: SubAgentType.General, timeout: 100 });
		assert.strictEqual(result.exitReason, 'timeout', `限时应记 timeout，实际: ${result.exitReason}`);
		assert.strictEqual(result.success, true, '有 ok 工具 → salvage 部分成功（限时不丢产出）');
		assert.ok(result.output?.includes('[部分完成'), 'salvage 头存在');
		assert.ok(result.output?.includes('【模型总结】'), 'P1 总结轮生效（模型自己梳理交接）');
		assert.strictEqual(requests.length, 2, '主轮+总结轮两次执行');
	});

	test('异常失败（failure 路径）同样登记复用，follow-up 可续跑同一会话', async () => {
			const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 2);
			let calls = 0;
			const failThenOk = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
				calls++;
				// dispatch 对瞬时失败重试一次：前两次（初次+重试）都抛错才落入 failure 路径
				if (calls <= 2) { throw new Error('gateway boom'); }
				yield { type: 'text', content: '续跑完成。' } as any;
			};
			const r1 = await dispatch.dispatch('parent-1', 'task A', failThenOk, { type: SubAgentType.Explore });
			assert.strictEqual(r1.success, false, '双重失败应落入 failure 路径');
			const reusable = dispatch.findReusableSubAgent('parent-1', SubAgentType.Explore);
			assert.ok(reusable, '异常失败后仍应可复用（会话上下文有价值）');
			const r2 = await dispatch.dispatchFollowUp(reusable!.id, 'task B', failThenOk);
			assert.strictEqual(r2.success, true, 'follow-up 续跑成功');
			assert.strictEqual(calls, 3);
		});

		test('reducer：Spawned 对已完成卡片重置过程数据（新任务周期）', async () => {
			const { reduceCardState, createEmptyCard } = await import('../../common/subAgentCardReducer.js');
			const card = createEmptyCard('sa-1', 'explore', '旧任务');
			card.status = 'done';
			card.output = '旧结论';
			card.toolTraces.push({ id: 'x', name: 'search_files', status: 'done' });
			card.completedAt = Date.now() - 1000;

			reduceCardState(card, {
				type: SubAgentEventType.Spawned, subAgentId: 'sa-1', task: '新任务',
				parentId: 'p', timestamp: Date.now(),
			} as any);

			assert.strictEqual(card.task, '新任务');
			assert.strictEqual(card.status, 'running');
			assert.strictEqual(card.toolTraces.length, 0, '旧 traces 应清空');
			assert.strictEqual(card.output, undefined);
			assert.strictEqual(card.completedAt, undefined);
		});
	});

	suite('previewStructured', () => {

		test('text 包装数组 >maxLen → 解包拼接内层文本，不出现 "0" 索引键', () => {
			const inner = 'f:\\GR\\Config\\WindowsEngine.ini:10: gc.AllowIncrementalReachability=1\n'.repeat(10);
			const raw = JSON.stringify([{ type: 'text', text: inner }]);
			const out = previewStructured(raw, 500);
			assert.ok(!out.includes('"0"'), `不应含索引键，实际: ${out.slice(0, 120)}`);
			assert.ok(out.startsWith('f:\\GR\\Config'), `应展示内层文本，实际: ${out.slice(0, 80)}`);
			assert.ok(out.length <= 501);
		});

		test('text 包装数组 ≤maxLen → 同样解包（旧逻辑返回原始包装）', () => {
			const raw = '[{"type":"text","text":"(no matching files)"}]';
			assert.strictEqual(previewStructured(raw, 500), '(no matching files)');
		});

		test('对象 → 顶层 key 保留、value 截断', () => {
			const raw = JSON.stringify({ pattern: 'gc\\.', path: 'f:\\GR_' + 'x'.repeat(300), mode: 'content' });
			const out = previewStructured(raw, 200);
			assert.ok(out.includes('pattern'), `应保留 key，实际: ${out.slice(0, 120)}`);
			assert.ok(out.length <= 201);
		});

		test('非 text 包装数组 → 元素摘要 + 项数', () => {
			const raw = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ a: i })));
			// 原文 ~110 超 maxLen=50 → 摘要分支；摘要 ~42 可容于 50
			const out = previewStructured(raw, 50);
			assert.ok(out.includes('(10 项)'), `实际: ${out}`);
			assert.ok(!out.includes('"0"'));
		});

		test('纯文本截断', () => {
			const out = previewStructured('x'.repeat(300), 100);
			assert.strictEqual(out.length, 101); // slice(0,100) + '…'
			assert.ok(out.endsWith('…'));
		});

		// ─── 2026-07-27 "搜索代码卡片 4 种样式" 回归 ───
		// 错误数据流（修复前）：
		//   search_code 返回 {"results":[…20 项…],"total":20,"total_grep_matches":33}（~2KB JSON 文本）
		//   → dispatch previewStructured(500)：object 预算分支，'results' 数组 JSON ~1800B > 498B
		//     → preview['results'] = `[${typeof []}]` = "[object]"（typeof 数组 === 'object'）
		//     → trace.result = '{"results":"[object]","total":"…"}'
		//   → UI cleanTracePreview：parse 成功但 results 已是字符串 "[object]"（数组信息已毁）
		//     → generic key=value 分支 → 用户看到 `results=[object] total=…`
		//   另一路（500~600B 中等负载）：小数组保留后 JSON.stringify 超 maxLen 被硬切成
		//   无效 JSON（`{"results":[{"filePath":"E…`），UI parse 失败退化为原始乱码。

		test('search_code 大 results 信封 → 语义摘要，无 [object]，含命中数与文件', () => {
			const results = Array.from({ length: 20 }, (_, i) => ({
				filePath: `f:/GR_qiuzijian_main/UE5EA/Engine/Source/Runtime/CoreUObject/Private/UObject/UObjectClusters${i}.cpp`,
				lineNo: 100 + i, text: 'void Foo() {}', isIndexed: true,
			}));
			const raw = JSON.stringify({ results, total: 20, total_grep_matches: 33, truncated: true, mode: 'compact' });
			const out = previewStructured(raw, 500);
			assert.ok(!out.includes('[object]'), `不应出现 [object]，实际: ${out.slice(0, 150)}`);
			assert.ok(out.includes('33 命中'), `应含总命中数，实际: ${out}`);
			assert.ok(out.includes('UObjectClusters0.cpp:100'), `应含首项 文件:行号，实际: ${out}`);
			assert.ok(out.length <= 500, `长度 ${out.length} 应 ≤500`);
		});

		test('search_code 小 results 信封（原文 ≤maxLen）→ 同样语义摘要（不泄露原始 JSON）', () => {
			const raw = JSON.stringify({ results: [{ filePath: 'Engine/A.cpp', lineNo: 600, text: 'cl…' }], total: 1, mode: 'compact' });
			const out = previewStructured(raw, 500);
			assert.ok(!out.startsWith('{'), `不应是原始 JSON，实际: ${out}`);
			assert.ok(out.includes('1 命中') && out.includes('A.cpp:600'), `实际: ${out}`);
		});

		test('files mode 信封 → 文件数摘要', () => {
			const raw = JSON.stringify({ files: ['f:/a/b/c1.cpp', 'f:/a/b/c2.cpp', 'f:/a/b/c3.cpp', 'f:/a/b/c4.cpp'], total_files: 4, total_grep_matches: 9 });
			const out = previewStructured(raw, 500);
			assert.ok(out.includes('4 个文件'), `实际: ${out}`);
			assert.ok(out.includes('b/c1.cpp'), `路径应压缩为末两段，实际: ${out}`);
		});

		test('text 包装内的 results 信封 → 解包后语义摘要', () => {
			const inner = JSON.stringify({ results: [{ filePath: 'x/y/z.cpp', lineNo: 7 }], total: 1 });
			const raw = JSON.stringify([{ type: 'text', text: inner }]);
			const out = previewStructured(raw, 500);
			assert.ok(out.includes('1 命中') && out.includes('y/z.cpp:7'), `实际: ${out}`);
		});

		test('泛化对象超预算 → 类型感知占位（[N 项]/{M keys}），绝不出现 [object]', () => {
			const raw = JSON.stringify({
				big: Array.from({ length: 50 }, (_, i) => ({ k: i })),
				nested: { a: 1, b: 2, c: 3 },
				n: 42,
			});
			const out = previewStructured(raw, 60);
			assert.ok(!out.includes('[object]'), `实际: ${out}`);
			assert.ok(out.includes('[50 项]') || out.includes('big='), `应有数组项数占位，实际: ${out}`);
			assert.ok(out.length <= 61);
		});

		test('对象最终 stringify 超 maxLen → 输出有效文本（非截断无效 JSON）', () => {
			// 小数组保留后，结构开销使最终 JSON 略超 maxLen —— 旧实现硬切成 `{"a":[{…` 无效 JSON
			const raw = JSON.stringify({ results2: [{ filePath: 'a/b.cpp', lineNo: 1, text: 'x'.repeat(40) }], extra: 'y'.repeat(40) });
			const out = previewStructured(raw, 120);
			if (out.startsWith('{')) {
				// 若以 { 开头则必须是可解析的有效 JSON（不允许截断残骸）
				JSON.parse(out.endsWith('…') ? out.slice(0, -1) : out);
			}
			assert.ok(!out.includes('[object]'));
			assert.ok(out.length <= 121);
		});

		test('纯文本消息（grep: no matches found.）→ 原样透传', () => {
			assert.strictEqual(previewStructured('grep: no matches found.', 500), 'grep: no matches found.');
		});
	});

	test('深度封顶：maxSpawnDepth=1 时子代理工具面隐藏编排工具', async () => {
		const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 1);
		let captured: IAgentTurnRequest | undefined;
		const execFn = async function* (r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			captured = r;
			yield { type: 'text', content: 'done' } as any;
		};

		await dispatch.dispatch('parent-1', 'task', execFn, { type: SubAgentType.Explore });
		assert.ok(captured, 'executeFn 应被调用');
		assert.ok(captured!.excludedTools?.includes('delegate_task'),
			`深度封顶子代理不得见 delegate_task，实际: ${captured!.excludedTools}`);
		assert.ok(captured!.excludedTools?.includes('plan_explore'));
		assert.ok(captured!.excludedTools?.includes('subagent_batch'));
	});

	test('provider done 携带 responseId/finishReason 也不触发提前终止', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			yield { type: 'text', content: 'working... ' } as any;
			yield { type: 'done', responseId: '78c55812f3', finishReason: 'tool_calls' } as any;
			yield { type: 'text', content: 'completed with evidence' } as any;
			yield { type: 'done' } as any;
		};

		const result = await dispatch.dispatch('parent-1', 'task', execFn, { type: SubAgentType.Explore });
		assert.ok(result.output.includes('completed with evidence'), `done(responseId) 后内容不得丢失，实际: ${result.output}`);
	});

	test('error delta 仍然终止流（保持原有语义）', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			yield { type: 'text', content: 'before error. ' } as any;
			yield { type: 'error', content: 'stream blew up' } as any;
			yield { type: 'text', content: 'SHOULD-NOT-APPEAR' } as any;
		};

		const result = await dispatch.dispatch('parent-1', 'task', execFn, { type: SubAgentType.Explore });
		assert.ok(!result.output.includes('SHOULD-NOT-APPEAR'), 'error 后的 delta 不应被消费');
	});

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
				parentChatMode: 'craft',
				parentWorkMode: 'plan',
			},
		);

		assert.strictEqual(result.success, true);
		assert.strictEqual(captured.length, 1, 'executeFn should be called exactly once');
		const req = captured[0];

		// toolset scope override reaches the request
		assert.deepStrictEqual(req.toolsetsOverride, ['core'], 'toolsetsOverride must equal the requested toolset');
		// model override reaches the request
		assert.deepStrictEqual(req.modelOverride, { providerId: 'knot-agui', modelId: 'gpt-4o-mini' }, 'modelOverride must equal the resolved model');
		// worktree + policy/phase inheritance reach the request
		assert.strictEqual(req.worktreePath, '/worktrees/feature-x', 'worktreePath must be inherited from the parent');
		assert.strictEqual(req.chatMode, 'craft', 'stable ChatMode policy must be inherited');
		assert.strictEqual(req.workMode, 'plan', 'planning WorkMode permission ceiling must be inherited');

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
		assert.ok(req.systemPrompt.includes('code-explorer sub-agent'), 'Explore role prompt must be selected');
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
				{ type: SubAgentType.Explore, toolsets: ['core'], model: { providerId: 'knot-agui', modelId: 'mini-a' }, worktreePath: '/wt/a', parentWorkMode: 'plan' },
				{ type: SubAgentType.General, toolsets: ['utility'], model: { providerId: 'knot-agui', modelId: 'mini-b' }, worktreePath: '/wt/b', parentWorkMode: 'work' },
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

		// Per-task worktree + WorkMode
		assert.strictEqual(reqAlpha.worktreePath, '/wt/a');
		assert.strictEqual(reqBeta.worktreePath, '/wt/b');
		assert.strictEqual(reqAlpha.workMode, 'plan');
		assert.strictEqual(reqBeta.workMode, 'work');

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
		assert.ok(captured[0].systemPrompt.includes('code-explorer sub-agent'), 'parallel fan-out must default to the Explore (read-only) role');
	});

	// ─── A：excludedTools 传播（索引管理工具对只读探索子代理隐藏）────────────────
	test('dispatch propagates excludedTools into the request（+编排工具隐藏叠加）', async () => {
		// 2026-07-26 P3b：所有子代理（depth≥1）工具面隐藏编排工具，
		// 用户显式 excludedTools 在前、编排工具追加在后（去重）。
		const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 2);
		const captured: IAgentTurnRequest[] = [];
		const execFn = makeCaptureFn(captured);

		await dispatch.dispatch('parent-excl', 'explore task', execFn, {
			type: SubAgentType.Explore,
			excludedTools: ['index_repository', 'delete_project'],
		});

		assert.strictEqual(captured.length, 1);
		assert.deepStrictEqual(captured[0].excludedTools,
			['index_repository', 'delete_project', 'delegate_task', 'plan_explore', 'subagent_batch'],
			'excludedTools must flow into the sub-agent request（编排工具叠加隐藏）');
	});

	test('dispatchParallelExplore propagates per-task excludedTools（+编排工具隐藏叠加）', async () => {
		// 2026-07-26 P3b：同上，per-task 透传 + 编排工具追加。
		const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 2);
		const captured: IAgentTurnRequest[] = [];
		const execFn = makeCaptureFn(captured);

		await dispatch.dispatchParallelExplore(
			'parent-excl-batch',
			['task a', 'task b'],
			execFn,
			undefined,
			[
				{ type: SubAgentType.Explore, excludedTools: ['index_repository'] },
				{ type: SubAgentType.General }, // no excludedTools
			],
		);

		assert.strictEqual(captured.length, 2);
		const reqA = captured.find(r => (r.messages[0].content as string).includes('task a'))!;
		const reqB = captured.find(r => (r.messages[0].content as string).includes('task b'))!;
		assert.deepStrictEqual(reqA.excludedTools, ['index_repository', 'delegate_task', 'plan_explore', 'subagent_batch'],
			'explore sub-agent gets excludedTools（编排工具叠加）');
		assert.deepStrictEqual(reqB.excludedTools, ['delegate_task', 'plan_explore', 'subagent_batch'],
			'general sub-agent 无显式排除时仅隐藏编排工具');
	});

	// ─── B：noRealExploration ground-truth 门控 ─────────────────────────────
	test('Explore sub-agent using only index_repository (no real exploration) is downgraded to partial', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		// 模拟 bug 场景：explore 子代理只调用 index_repository（非探索工具）就输出文本。
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			yield { type: 'tool_start', toolCallId: 'tc-1', toolName: 'index_repository' } as any;
			yield { type: 'tool_end', toolCallId: 'tc-1', toolName: 'index_repository', success: true } as any;
			yield { type: 'text', content: 'Done exploring the codebase.' };
		};

		const result = await dispatch.dispatch('parent-gate', 'explore task', execFn, { type: SubAgentType.Explore });

		// ground-truth：调用了工具但无真正探索工具 → gate 降级 partial → result.success=false
		assert.strictEqual(result.success, false,
			'explore sub-agent with only index_repository must NOT be marked success');
		assert.ok(result.exitReason === 'completed' || result.exitReason === 'error',
			'exitReason reflects the gate-verified (non-success) outcome');
	});

	// ─── 2026-07-27 线上回归：正常收尾但自报 partial/blocked → 打捞发现报告，不判 failed ───
	test('completedPartial salvage：真正探索过 + 自报 partial → 保留发现、标 partial（不丢 output）', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		// 复刻线上：子代理调用真实探索工具、正常收尾（finishReason=stop），
		// 但在最终文本里诚实自报 **Status**: partial（例如发现假设的文件位置有出入）。
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			yield { type: 'tool_start', toolCallId: 'tc-1', toolName: 'search_graph' } as any;
			yield { type: 'tool_end', toolCallId: 'tc-1', toolName: 'search_graph', success: true } as any;
			yield { type: 'text', content: '**Status**: partial\n\n发现 GC 关键函数 IncrementalPurgeGarbage 位于 GarbageCollection.cpp:5190，但任务假设的文件位置有出入。' } as any;
		};

		const result = await dispatch.dispatch('parent-cp', 'explore gc ACCEPTANCE: 汇总发现', execFn, { type: SubAgentType.Explore });

		assert.strictEqual(result.success, true, 'completedPartial：真正探索过应打捞为部分成功，而非 failed');
		assert.strictEqual(result.exitReason, 'partial', 'exitReason 归一为 partial（供 formatDelegationResult 标 RESULT: partial）');
		assert.ok(result.output?.includes('[部分完成'), `应含部分完成标注，实际: ${result.output?.slice(0, 120)}`);
		assert.ok(result.output?.includes('5190'), '子代理的发现报告必须透传给父代理（不能被 error 覆盖丢弃）');
		assert.strictEqual(result.error, undefined, 'effectiveSuccess=true → 无 error');
	});

	test('completedPartial 护栏：Explore 只调 index_repository（无真实探索）自报 partial → 仍不打捞', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		// noRealExploration 空洞输出：即使自报 partial 也不应被 completedPartial 打捞。
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			yield { type: 'tool_start', toolCallId: 'tc-1', toolName: 'index_repository' } as any;
			yield { type: 'tool_end', toolCallId: 'tc-1', toolName: 'index_repository', success: true } as any;
			yield { type: 'text', content: '**Status**: partial\n\nDone.' } as any;
		};

		const result = await dispatch.dispatch('parent-cp2', 'explore task', execFn, { type: SubAgentType.Explore });

		assert.strictEqual(result.success, false, 'Explore 未真正探索的空洞 partial 不得被打捞');
	});

	test('Explore sub-agent using a real exploration tool (search_graph) passes the gate', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			yield { type: 'tool_start', toolCallId: 'tc-1', toolName: 'search_graph' } as any;
			yield { type: 'tool_end', toolCallId: 'tc-1', toolName: 'search_graph', success: true } as any;
			yield { type: 'text', content: 'Found the work-stealing implementation in gc/heap.cpp.' };
		};

		const result = await dispatch.dispatch('parent-gate-ok', 'explore task', execFn, { type: SubAgentType.Explore });

		assert.strictEqual(result.success, true,
			'explore sub-agent that used a real exploration tool must pass the gate');
	});

	test('General sub-agent is NOT subject to the noRealExploration gate', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			yield { type: 'tool_start', toolCallId: 'tc-1', toolName: 'memory_read' } as any;
			yield { type: 'tool_end', toolCallId: 'tc-1', toolName: 'memory_read', success: true } as any;
			yield { type: 'text', content: 'Updated the auth module.' };
		};

		const result = await dispatch.dispatch('parent-gate-general', 'write task', execFn, { type: SubAgentType.General });

		assert.strictEqual(result.success, true,
			'General (write-capable) sub-agent must not be gated by exploration-tool ground truth');
	});

	// ─── P3: 父→子取消传播 ─────────────────────────────────────────────
	test('abortSignal aborts an in-flight sub-agent (parent→child cancellation)', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const controller = new AbortController();
		// 模拟一个长时子 agent：先产出一段文本，再周期性产出，使流循环能在
		// 每次 delta 之间检查 interrupt/abort 信号。
		const execFn = async function* (_request: IAgentTurnRequest, _budget: IterationBudget): AsyncIterable<IChatStreamDelta> {
			yield { type: 'text', content: 'working' };
			for (let i = 0; i < 10; i++) {
				await new Promise<void>((r) => setTimeout(r, 20));
				yield { type: 'text', content: '.' };
			}
		};

		const p = dispatch.dispatch('parent-abort', 'long task', execFn, { type: SubAgentType.Explore }, undefined, controller.signal);
		// 子 agent 启动后立刻 abort —— 模拟父 turn 被用户/系统取消。
		setTimeout(() => controller.abort(), 10);
		const result = await p;

		assert.strictEqual(result.success, false, 'aborted sub-agent must NOT report success');
		assert.strictEqual(result.exitReason, 'interrupted', 'exitReason must be interrupted');
	});

	test('already-aborted signal marks the sub-agent as interrupted at start', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const controller = new AbortController();
		controller.abort();
		let executed = false;
		const execFn = async function* (_request: IAgentTurnRequest, _budget: IterationBudget): AsyncIterable<IChatStreamDelta> {
			executed = true;
			yield { type: 'text', content: 'should not run to completion' };
		};

		const result = await dispatch.dispatch('parent-pre', 'task', execFn, { type: SubAgentType.Explore }, undefined, controller.signal);
		assert.strictEqual(result.success, false, 'pre-aborted sub-agent must NOT report success');
		assert.strictEqual(result.exitReason, 'interrupted', 'exitReason must be interrupted');
		// 流循环在首轮 delta 即检测到中断标记并 break，不应跑完整个执行。
		assert.strictEqual(executed, true, 'executeFn must have been invoked (stream started) before interruption');
	});
});

// ─── P2c: delegate_task 动态枚举单一来源 ─────────────────────────────
// 验证 SUB_AGENT_TYPE_LABELS 是 delegate_task schema enum 与 label→SubAgentType
// 反查的唯一来源，新增子 agent 类型时 schema 与运行时路径自动同步、不再漂移。
suite('SubAgentType labels (P2c dynamic enum source)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('SUB_AGENT_TYPE_LABELS covers all runtime SubAgentType values', () => {
		const values = SUB_AGENT_TYPE_LABELS.map((t) => t.value);
		assert.ok(values.includes(SubAgentType.General));
		assert.ok(values.includes(SubAgentType.Explore));
		assert.ok(values.includes(SubAgentType.Scout));
	});

	test('labels are capitalized display names (schema-facing)', () => {
		const byValue = new Map(SUB_AGENT_TYPE_LABELS.map((t) => [t.value, t.label]));
		assert.strictEqual(byValue.get(SubAgentType.General), 'General');
		assert.strictEqual(byValue.get(SubAgentType.Explore), 'Explore');
		assert.strictEqual(byValue.get(SubAgentType.Scout), 'Scout');
	});

	test('resolveSubAgentTypeLabel is case-insensitive and defaults to General', () => {
		assert.strictEqual(resolveSubAgentTypeLabel('explore'), SubAgentType.Explore);
		assert.strictEqual(resolveSubAgentTypeLabel('EXPLORE'), SubAgentType.Explore);
		assert.strictEqual(resolveSubAgentTypeLabel('Scout'), SubAgentType.Scout);
		assert.strictEqual(resolveSubAgentTypeLabel(undefined), SubAgentType.General);
		assert.strictEqual(resolveSubAgentTypeLabel(''), SubAgentType.General);
		assert.strictEqual(resolveSubAgentTypeLabel('bogus'), SubAgentType.General);
	});
});

// ─── P2b: 显式两档隔离模型 (subagent / peer) ─────────────────────────
// 验证 SubAgentIsolationLevel 是隔离档位的唯一来源，且两档在「父 turn abort
// 是否级联取消子 agent」这一关键安全契约上行为不同：subagent 档继承父控制
// （abort 级联），peer 档独立生命周期（abort 不级联，仅显式 interrupt 可停）。
suite('SubAgent isolation level (P2b two-tier model)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolveIsolationLevel is case-insensitive and defaults to subagent', () => {
		assert.strictEqual(resolveIsolationLevel('peer'), 'peer');
		assert.strictEqual(resolveIsolationLevel('PEER'), 'peer');
		assert.strictEqual(resolveIsolationLevel('subagent'), 'subagent');
		assert.strictEqual(resolveIsolationLevel(undefined), 'subagent');
		assert.strictEqual(resolveIsolationLevel(''), 'subagent');
		assert.strictEqual(resolveIsolationLevel('bogus'), 'subagent');
	});

	test('peer isolation level ignores parent abort (independent lifecycle)', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const controller = new AbortController();
		controller.abort(); // 父 turn 已取消
		let executed = false;
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			executed = true;
			yield { type: 'text', content: 'peer ran to completion' };
		};
		const result = await dispatch.dispatch('parent-peer', 'peer task', execFn, { type: SubAgentType.General, isolationLevel: 'peer' }, undefined, controller.signal);
		assert.strictEqual(executed, true, 'peer must execute despite parent abort');
		assert.strictEqual(result.success, true, 'peer must complete (parent abort must NOT cascade)');
		assert.notStrictEqual(result.exitReason, 'interrupted', 'peer must not be interrupted by a parent-turn abort');
	});

	test('subagent isolation level cascades parent abort (default behavior)', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const controller = new AbortController();
		controller.abort();
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			yield { type: 'text', content: 'should not complete' };
		};
		const result = await dispatch.dispatch('parent-sub', 'task', execFn, { type: SubAgentType.Explore, isolationLevel: 'subagent' }, undefined, controller.signal);
		assert.strictEqual(result.success, false, 'subagent must NOT report success when parent aborted');
		assert.strictEqual(result.exitReason, 'interrupted', 'subagent exitReason must be interrupted (parent abort cascades)');
	});

	test('peer can still be stopped by an explicit interruptSubAgent (mid-flight)', async () => {
		// P2b 契约的另一半：peer 忽略「父 turn abort 级联」，但**不是**不可中断的——
		// 显式 interruptSubAgent（或 swarm.cancelSwarm）仍必须能停掉一个正在运行的 peer。
		const dispatch = new UnifiedSubAgentDispatch();
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			yield { type: 'text', content: 'peer working' };
			for (let i = 0; i < 20; i++) {
				await new Promise<void>((r) => setTimeout(r, 20));
				yield { type: 'text', content: '.' };
			}
		};
		// 用 createSubAgent 拿到 id 以便运行途中显式中断。
		const id = dispatch.createSubAgent('root-peer', 'long peer task', { type: SubAgentType.General, isolationLevel: 'peer' });
		const p = dispatch.executeSubAgent(id, execFn);
		setTimeout(() => dispatch.interruptSubAgent(id), 10);
		const result = await p;
		assert.strictEqual(result.success, false, 'explicitly interrupted peer must NOT report success');
		assert.strictEqual(result.exitReason, 'interrupted', 'explicit interrupt must stop even a peer (independent lifecycle ≠ uninterruptible)');
	});
});

// ─── 生命周期管理与故障隔离 ─────────────────────────────────────────
// 覆盖 dispatch 的三条关键运行时不变量：interrupt 递归传播、批量执行的
// 单点故障隔离（Promise.allSettled）、以及状态在 create→done 生命周期中的迁移。
suite('UnifiedSubAgentDispatch — lifecycle & fault isolation', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('interruptSubAgent recursively cancels a running child (P3 recursion)', async () => {
		const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 2);
		const parentId = dispatch.createSubAgent('root', 'parent task');
		const childId = dispatch.createSubAgent(parentId, 'child task', { type: SubAgentType.Explore });
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			yield { type: 'text', content: 'child working' };
			for (let i = 0; i < 20; i++) {
				await new Promise<void>((r) => setTimeout(r, 20));
				yield { type: 'text', content: '.' };
			}
		};
		const p = dispatch.executeSubAgent(childId, execFn);
		// 中断父 → interruptSubAgent 必须递归取消仍在 running 的子代。
		setTimeout(() => dispatch.interruptSubAgent(parentId), 10);
		const result = await p;
		assert.strictEqual(result.success, false, 'child of an interrupted parent must NOT report success');
		assert.strictEqual(result.exitReason, 'interrupted', 'interrupt must propagate parent → child recursively');
	});

	test('executeMultipleSubAgents isolates a single failure (Promise.allSettled)', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const okId = dispatch.createSubAgent('root', 'ok task');
		const boomId = dispatch.createSubAgent('root', 'boom task');
		// 单一 executeFn 按任务内容分流：boom 任务抛错，健康任务正常产出。
		const execFn = async function* (request: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			const content = request.messages[0].content as string;
			if (content.includes('boom')) {
				throw new Error('kaboom');
			}
			yield { type: 'text', content: 'ok output' };
		};
		const map = await dispatch.executeMultipleSubAgents([okId, boomId], execFn);
		assert.strictEqual(map.size, 2, 'both sub-agents must produce a result (one failure must not abort the batch)');
		assert.strictEqual(map.get(okId)!.success, true, 'healthy sub-agent must still succeed alongside a failing sibling');
		assert.strictEqual(map.get(boomId)!.success, false, 'failing sub-agent must be captured as a failed result, not thrown');
	});

	test('getSubAgentStatus reflects pending on create and done after execution', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		const id = dispatch.createSubAgent('root', 'status task', { type: SubAgentType.General });

		const pending = dispatch.getSubAgentStatus(id);
		assert.ok(pending, 'status must be available immediately after create');
		assert.strictEqual(pending!.status, 'pending', 'a freshly created sub-agent must be pending (not yet executed)');
		assert.strictEqual(pending!.task, 'status task');
		assert.strictEqual(pending!.type, SubAgentType.General);

		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			yield { type: 'text', content: 'done' };
		};
		const result = await dispatch.executeSubAgent(id, execFn);
		assert.strictEqual(result.success, true);
		assert.strictEqual(dispatch.getSubAgentStatus(id)!.status, 'done', 'a completed sub-agent must transition to done');
	});
});

// ─── Effect model: fiber / timeout / retry / stall 执行语义 ─────────────
// 覆盖 Effect 化重构后的四条关键执行路径：stall watchdog → timeout 退出、
// 硬超时 cap 不重试、瞬态失败重试一次并发出 Progress+Completed 事件、
// 双重失败 settle 为 Failed 结果（never-reject 契约）。
suite('UnifiedSubAgentDispatch — Effect model execution semantics', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('stall watchdog aborts an idle sub-agent with exitReason timeout', async () => {
		const dispatch = new UnifiedSubAgentDispatch(undefined, 3, 1, 40); // stallTimeoutMs = 40
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			yield { type: 'text', content: 'working' };
			// 150ms 无 delta 空窗 → stall watchdog（40ms）触发，下一个 delta 处中止。
			await new Promise<void>((r) => setTimeout(r, 150));
			yield { type: 'text', content: 'resumed' };
		};
		const result = await dispatch.dispatch('root-stall', 'stall task', execFn, { type: SubAgentType.Explore });
		assert.strictEqual(result.success, false, 'stalled sub-agent must NOT report success');
		assert.strictEqual(result.exitReason, 'timeout', 'idle stall must map to exitReason timeout');
	});

	test('hard timeout cap rejects with exitReason timeout and does NOT retry', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		let calls = 0;
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			calls++;
			// 永不 yield，挂起超过 50ms 超时上限。
			await new Promise<void>((r) => setTimeout(r, 5000));
			yield { type: 'text', content: 'late' };
		};
		const result = await dispatch.dispatch('root-slow', 'slow task', execFn, { type: SubAgentType.Explore, timeout: 50 });
		assert.strictEqual(result.success, false);
		assert.strictEqual(result.exitReason, 'timeout');
		assert.strictEqual(calls, 1, 'timeout must NOT be retried (SubAgentTimeoutError is not retryable)');
	});

	test('transient failure is retried once and emits Progress + Completed events', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		let calls = 0;
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			calls++;
			if (calls === 1) { throw new Error('transient network glitch'); }
			yield { type: 'text', content: 'recovered output' };
		};
		const events: SubAgentEvent[] = [];
		const result = await dispatch.dispatch('root-flaky', 'flaky task', execFn, { type: SubAgentType.Explore }, (e) => events.push(e));
		assert.strictEqual(result.success, true, 'retry must recover from a transient failure');
		assert.strictEqual(calls, 2, 'exactly one retry attempt');
		const types = events.map(e => e.type);
		assert.ok(types.includes(SubAgentEventType.Progress), 'retry progress note must be emitted');
		assert.ok(types.includes(SubAgentEventType.Completed), 'Completed event must be emitted after a successful retry');
	});

	test('double failure settles as a Failed result instead of rejecting (never-reject contract)', async () => {
		const dispatch = new UnifiedSubAgentDispatch();
		let calls = 0;
		const execFn = async function* (_r: IAgentTurnRequest, _b: IterationBudget): AsyncIterable<IChatStreamDelta> {
			calls++;
			throw new Error(`boom-${calls}`);
		};
		const result = await dispatch.dispatch('root-doomed', 'doomed task', execFn, { type: SubAgentType.Explore });
		assert.strictEqual(result.success, false);
		assert.strictEqual(result.exitReason, 'error');
		assert.strictEqual(calls, 2, 'one retry must be attempted before giving up');
		assert.ok(result.error!.includes('boom-2'), 'the LAST error must be reported, not the first');
	});
});
