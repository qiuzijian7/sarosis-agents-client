/*---------------------------------------------------------------------------------------------
 *  Unit tests: **多 agent 协同**的状态与护栏。
 *
 *  背景：`delegate_task` 是「父子一次性委派」模型 —— 子代理空白启动、结果只回一次、
 *  没有点对点消息通道。因此**唯一防止「重复委派 / 复用坏结果 / 嵌套委派爆炸」的机制**
 *  就是这三块纯逻辑，而它们此前**零测试**：
 *    ① `extractDelegationLedger` —— 从消息历史推断每个委派的终态（历史真相）
 *    ② `renderDelegationLedger` —— 渲染成注入 system prompt 的紧凑账本（模型据此决定要不要再委派）
 *    ③ `DelegationLedgerManager` —— 运行中的实时真相，`toSnapshot()` 可覆盖 ① 的推断
 *    ④ `getBuiltinAgentIdentity` —— 子代理身份（**必须剥离 DELEGATION_GUIDANCE 防嵌套委派**）
 *
 *  放在 test/browser/ 的原因：该目录被 `run-all-browser-tests.mjs` 自动发现，
 *  也可用 `run-browser-test.mjs <file>` 单跑；本文件是纯逻辑（无 DOM）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	extractDelegationLedger,
	renderDelegationLedger,
	DelegationLedgerManager,
	DELEGATION_TOOL_NAMES,
	type DelegationEntry,
	type DelegationStatus,
	type LedgerMessage,
} from '../../common/delegationLedger.js';
import {
	getBuiltinAgent,
	getBuiltinAgentIdentity,
	isUserFacingAgent,
	filterUserFacingAgents,
} from '../../common/builtinAgents.js';

/** DELEGATION_GUIDANCE 未导出 → 用其小节标题做标记（改动文案需同步本测试，属有意为之的契约）。 */
const DELEGATION_GUIDANCE_MARKER = '## Delegating Work';

/** 构造一条 assistant 委派 tool_call + 可选 tool 结果。 */
function history(calls: Array<{ id: string; name?: string; args?: Record<string, unknown>; result?: string }>): LedgerMessage[] {
	const msgs: LedgerMessage[] = [{
		role: 'assistant',
		toolCalls: calls.map(c => ({ id: c.id, name: c.name ?? 'delegate_task', args: c.args ?? {} })),
	}];
	for (const c of calls) {
		if (c.result !== undefined) { msgs.push({ role: 'tool', toolCallId: c.id, content: c.result }); }
	}
	return msgs;
}

suite('多 agent 协同 / 委派账本抽取（历史真相）', () => {

	test('只认委派工具名：file_read 等非委派调用不入账', () => {
		const msgs: LedgerMessage[] = [
			{ role: 'assistant', toolCalls: [
				{ id: 'r1', name: 'file_read', args: { path: 'a.ts' } },
				{ id: 'd1', name: 'delegate_task', args: { task: 'find X' } },
			] },
			{ role: 'tool', toolCallId: 'r1', content: 'file body' },
		];
		const entries = extractDelegationLedger(msgs);
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0].callId, 'd1');
	});

	test('4 个委派工具名全部被识别', () => {
		for (const name of ['delegate_task', 'task', 'spawn_subagent', 'dispatch_subagent']) {
			assert.ok(DELEGATION_TOOL_NAMES.has(name), `${name} 应被识别为委派`);
			const entries = extractDelegationLedger(history([{ id: 'x', name, args: { task: 't' } }]));
			assert.strictEqual(entries.length, 1, `${name} 应入账`);
		}
	});

	test('无 tool 结果 → in_progress（仍在跑）', () => {
		const entries = extractDelegationLedger(history([{ id: 'd1', args: { task: 'long search' } }]));
		assert.strictEqual(entries[0].status, 'in_progress');
		assert.strictEqual(entries[0].resultBrief, undefined);
	});

	test('有结果且无失败词 → completed，并带上 resultBrief', () => {
		const entries = extractDelegationLedger(history([{ id: 'd1', args: { task: 'find X' }, result: 'found it in a.ts:12' }]));
		assert.strictEqual(entries[0].status, 'completed');
		assert.ok(entries[0].resultBrief?.includes('a.ts:12'));
	});

	test('结果含 error / failed / [task_failed]（大小写不敏感）→ failed', () => {
		for (const text of ['ERROR: boom', 'the task Failed', '[task_failed] no luck']) {
			const entries = extractDelegationLedger(history([{ id: 'd1', args: { task: 'x' }, result: text }]));
			assert.strictEqual(entries[0].status, 'failed', `"${text}" 应判 failed`);
		}
	});

	test('★ live 终态优先于内容推断：结果文本「干净」但实时已 timed_out → timed_out', () => {
		// 协同风险点：若被内容推断成 completed，主代理会把超时前的半成品当完整结果复用。
		const msgs = history([{ id: 'd1', args: { task: 'x' }, result: 'All good, here are partial results' }]);
		assert.strictEqual(extractDelegationLedger(msgs)[0].status, 'completed', '无 live 真相时应按内容推断');
		const live = new Map<string, DelegationStatus>([['d1', 'timed_out']]);
		assert.strictEqual(extractDelegationLedger(msgs, live)[0].status, 'timed_out');
	});

	test('任务描述来源优先级 task > description > prompt，且换行被压平', () => {
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ task: 'from-task', description: 'from-desc' }, 'from-task'],
			[{ description: 'from-desc' }, 'from-desc'],
			[{ prompt: 'from-prompt' }, 'from-prompt'],
		];
		for (const [args, expected] of cases) {
			assert.strictEqual(extractDelegationLedger(history([{ id: 'd1', args }]))[0].taskDescription, expected);
		}
		const multiline = extractDelegationLedger(history([{ id: 'd1', args: { task: 'line1\n\n  line2  ' } }]))[0];
		assert.strictEqual(multiline.taskDescription, 'line1 line2', '应 compact 掉换行与多余空格');
	});

	test('subagentType 来源 agent_type > subagent_type > type', () => {
		assert.strictEqual(extractDelegationLedger(history([{ id: 'd1', args: { agent_type: 'code-explorer', type: 'data' } }]))[0].subagentType, 'code-explorer');
		assert.strictEqual(extractDelegationLedger(history([{ id: 'd1', args: { subagent_type: 'researcher' } }]))[0].subagentType, 'researcher');
		assert.strictEqual(extractDelegationLedger(history([{ id: 'd1', args: { type: 'data' } }]))[0].subagentType, 'data');
	});

	test('多个委派按消息顺序全部入账（含跨多轮）', () => {
		const msgs: LedgerMessage[] = [
			...history([{ id: 'd1', args: { task: 'first' }, result: 'ok' }]),
			...history([{ id: 'd2', args: { task: 'second' } }]),
		];
		const entries = extractDelegationLedger(msgs);
		assert.deepStrictEqual(entries.map(e => e.callId), ['d1', 'd2']);
		assert.deepStrictEqual(entries.map(e => e.status), ['completed', 'in_progress']);
	});

	test('空历史 → 空账本', () => {
		assert.deepStrictEqual(extractDelegationLedger([]), []);
	});
});

suite('多 agent 协同 / 账本渲染（注入 system prompt 的防重复委派信号）', () => {

	const mk = (i: number, over: Partial<DelegationEntry> = {}): DelegationEntry => ({
		callId: `c${i}`,
		subagentType: 'code-explorer',
		taskDescription: `task-${i}`,
		status: 'completed',
		createdAt: '2026-09-11T00:00:00.000Z',
		...over,
	});

	test('空账本 → 空串（不注入空块）', () => {
		assert.strictEqual(renderDelegationLedger([]), '');
	});

	test('渲染含 header / 状态 / 描述 / 角色', () => {
		const out = renderDelegationLedger([mk(1)]);
		assert.ok(out.startsWith('## Delegation Ledger'), out);
		assert.ok(out.includes('[completed]'));
		assert.ok(out.includes('"task-1"'));
		assert.ok(out.includes('(code-explorer)'));
	});

	test('★ 防重复委派文案：in_progress / completed 明确「不要再委派」', () => {
		const running = renderDelegationLedger([mk(1, { status: 'in_progress' })]);
		assert.ok(running.includes('already delegated; do NOT delegate again'), running);
		const done = renderDelegationLedger([mk(1, { status: 'completed' })]);
		assert.ok(done.includes('do NOT delegate again; reuse this result'), done);
	});

	test('★ 失败类终态文案：允许「换个方案重试」', () => {
		for (const status of ['failed', 'cancelled', 'timed_out'] as DelegationStatus[]) {
			const out = renderDelegationLedger([mk(1, { status })]);
			assert.ok(out.includes('may retry with a changed plan'), `${status} 应给出可重试指引`);
		}
	});

	test('★ 只渲染最近 10 条（防上下文膨胀），且保持时间顺序', () => {
		const out = renderDelegationLedger(Array.from({ length: 12 }, (_, i) => mk(i + 1)));
		const numbered = out.split('\n').filter(l => /^\d+\. \[/.test(l));
		assert.strictEqual(numbered.length, 10, '条目数应为 10');
		assert.ok(!out.includes('"task-1"'), '最早的第 1 条应被裁掉');
		assert.ok(out.includes('"task-3"') && out.includes('"task-12"'), '保留最后 10 条（task-3..task-12）');
		assert.ok(numbered[0].includes('"task-3"'), '第 1 行应是保留集里最早的那条');
	});

	test('★ 超长结果 head/tail 截断（单条 result 渲染 ≤120 字符，保留首尾）', () => {
		const head = 'H'.repeat(60);
		const tail = 'T'.repeat(60);
		const out = renderDelegationLedger([mk(1, { resultBrief: head + 'M'.repeat(500) + tail })]);
		const resultLine = out.split('\n').find(l => l.includes('result:')) ?? '';
		const body = resultLine.replace(/^\s*result:\s*/, '');
		assert.ok(body.length <= 120, `result 段应 ≤120 字符，实得 ${body.length}`);
		assert.ok(body.includes('...'), '应含截断标记');
		assert.ok(body.startsWith('HHHH'), '应保留开头');
		assert.ok(body.endsWith('TTTT'), '应保留结尾');
	});

	test('in_progress 无 resultBrief → 不出现 result 行', () => {
		const out = renderDelegationLedger([mk(1, { status: 'in_progress' })]);
		assert.ok(!out.includes('result:'), out);
	});
});

suite('多 agent 协同 / 实时账本管理器 + 端到端', () => {

	test('状态流转：markDelegated → in_progress；markCompleted → completed + 结果摘要', () => {
		const led = new DelegationLedgerManager();
		led.markDelegated('c1', 'find X', 'code-explorer');
		let e = led.getAllEntries().find(x => x.callId === 'c1')!;
		assert.strictEqual(e.status, 'in_progress');
		assert.strictEqual(led.activeCount, 1, 'in_progress 计入活跃数');

		led.markCompleted('c1', 'found in a.ts:12');
		e = led.getAllEntries().find(x => x.callId === 'c1')!;
		assert.strictEqual(e.status, 'completed');
		assert.ok(e.resultBrief?.includes('a.ts:12'));
		assert.ok(e.completedAt, 'completedAt 应写入');
		assert.strictEqual(led.activeCount, 0);
	});

	test('markFailed / markTimedOut 各自落定，并带状态文案', () => {
		const led = new DelegationLedgerManager();
		led.markDelegated('a', 'ta', 'explore');
		led.markDelegated('b', 'tb', 'explore');
		led.markFailed('a', 'boom');
		led.markTimedOut('b');
		const byId = new Map(led.getAllEntries().map(e => [e.callId, e]));
		assert.strictEqual(byId.get('a')!.status, 'failed');
		assert.ok(byId.get('a')!.resultBrief?.includes('boom'));
		assert.strictEqual(byId.get('b')!.status, 'timed_out');
	});

	test('★ 未登记就 mark* 是 no-op（防止「账本里有幽灵条目」）', () => {
		const led = new DelegationLedgerManager();
		led.markCompleted('ghost', 'x');
		led.markFailed('ghost', 'x');
		led.markTimedOut('ghost');
		led.markCancelled('ghost');
		assert.strictEqual(led.getAllEntries().length, 0);
	});

	test('★ 端到端：实时 timed_out → toSnapshot → extract → render 仍判 timed_out 且给重试指引', () => {
		// 场景：子代理超时（历史里只有一条「看起来正常」的 tool 结果）。
		const led = new DelegationLedgerManager();
		led.markDelegated('d1', 'deep search', 'code-explorer');
		led.markTimedOut('d1');

		const msgs = history([{ id: 'd1', args: { task: 'deep search' }, result: 'partial results look fine' }]);
		const entries = extractDelegationLedger(msgs, led.toSnapshot());
		assert.strictEqual(entries[0].status, 'timed_out', 'live 真相必须穿透历史推断');

		const rendered = renderDelegationLedger(entries);
		assert.ok(rendered.includes('[timed_out]'), rendered);
		assert.ok(rendered.includes('may retry with a changed plan'), rendered);
		assert.ok(!rendered.includes('reuse this result'), '不得引导复用超时结果');
	});

	test('reset() 清空账本（会话重置）', () => {
		const led = new DelegationLedgerManager();
		led.markDelegated('c1', 't', 'explore');
		led.reset();
		assert.strictEqual(led.getAllEntries().length, 0);
		assert.strictEqual(led.render(), '');
	});
});

suite('多 agent 协同 / 内置 agent 身份与可见性护栏', () => {

	test('★ 子代理身份必须剥离 DELEGATION_GUIDANCE（防嵌套委派）', () => {
		for (const id of ['code-explorer', 'researcher', 'data']) {
			const full = getBuiltinAgent(id);
			assert.ok(full, `${id} 应存在`);
			assert.ok(full!.systemPrompt?.includes(DELEGATION_GUIDANCE_MARKER), `${id} 全量定义应含委派引导`);

			const identity = getBuiltinAgentIdentity(id);
			assert.ok(identity, `${id} 身份应可解析`);
			assert.strictEqual(identity!.agentId, id);
			assert.ok(identity!.systemPrompt, `${id} 身份应带 systemPrompt`);
			assert.ok(!identity!.systemPrompt!.includes(DELEGATION_GUIDANCE_MARKER),
				`${id} 子代理身份**不得**含委派引导（否则诱导嵌套委派）`);
			// 剥离是「去尾」：身份提示词应是全量提示词的前缀
			assert.ok(full!.systemPrompt!.startsWith(identity!.systemPrompt!),
				'身份提示词应是全量提示词的前缀（说明只做了去尾剥离，未篡改正文）');
		}
	});

	test('未知 agent id → undefined（调用方据此回退）', () => {
		assert.strictEqual(getBuiltinAgentIdentity('definitely-not-an-agent'), undefined);
		assert.strictEqual(getBuiltinAgent('definitely-not-an-agent'), undefined);
	});

	test('allowedTools 只在 agent 定义了 tools 时出现，且与定义一致', () => {
		for (const id of ['code-explorer', 'researcher', 'data']) {
			const full = getBuiltinAgent(id)!;
			const identity = getBuiltinAgentIdentity(id)!;
			if (full.tools?.length) {
				assert.deepStrictEqual(identity.allowedTools, full.tools, `${id} 的 allowedTools 应与定义一致`);
			} else {
				assert.strictEqual(identity.allowedTools, undefined);
			}
		}
	});

	test('★ delegate_task 的 3 个可委派 id 必须都是已注册内置 agent（防改名后静默回退）', () => {
		// 与 delegationTools.ts 的 VALID_DELEGATE_TYPES 同步；改名/删除任一 agent 时此测试会红，
		// 否则 delegate_task 会静默回退到 code-explorer（模型以为派给了 researcher，实际拿到 explorer）。
		for (const id of ['code-explorer', 'researcher', 'data']) {
			assert.ok(getBuiltinAgent(id), `${id} 必须存在于内置 agent 定义中`);
		}
	});

	test('用户可见白名单：自定义恒可见，内置仅 saros-claw / knowledge-base-expert', () => {
		assert.strictEqual(isUserFacingAgent({ id: 'saros-claw', source: 'builtin' }), true);
		assert.strictEqual(isUserFacingAgent({ id: 'knowledge-base-expert', source: 'builtin' }), true);
		// 内部子代理不得出现在用户界面
		for (const id of ['code-explorer', 'researcher', 'data', 'coder', 'planner']) {
			assert.strictEqual(isUserFacingAgent({ id, source: 'builtin' }), false, `${id} 不应面向用户`);
		}
		// 自定义 agent 不受白名单限制
		assert.strictEqual(isUserFacingAgent({ id: 'my-agent', source: 'custom' }), true);
		assert.strictEqual(isUserFacingAgent({ id: 'my-agent' }), true, '无 source 视为非内置');
	});

	test('filterUserFacingAgents 保留自定义 + 白名单内置', () => {
		const list = [
			{ id: 'saros-claw', source: 'builtin' },
			{ id: 'coder', source: 'builtin' },
			{ id: 'my-agent', source: 'custom' },
		];
		assert.deepStrictEqual(filterUserFacingAgents(list).map(a => a.id), ['saros-claw', 'my-agent']);
	});
});
