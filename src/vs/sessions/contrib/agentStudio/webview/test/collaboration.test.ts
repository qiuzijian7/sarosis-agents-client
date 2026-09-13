/* Unit tests for the multi-agent collaboration kernel (P0 — docs/multi-agent-collaboration-design.md).
 * Pure logic, no DOM / no React / no LiteGraph singleton.
 * Run with: node test/run-collaboration.mjs  (esbuild-bundles this file then executes it). */

import {
	createSemaphore, runPooled,
	createCollaborationQueue, validateDependencies,
	assembleNodeContext, stableStringify, DependencyPayloadError, DEFAULT_MAX_PAYLOAD_BYTES,
	createBlackboard,
	createDeliveryQueue,
	createLoopDetector, createIterationGuard, computeToolSignature,
	type CollabTask,
} from '../src/features/workflowEditor/comfyHost/collaboration/index';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { passed++; }
	else { failed++; console.error(`✗ ${label}\n   expected: ${e}\n   actual:   ${a}`); }
}

function ok(cond: boolean, label: string): void {
	if (cond) { passed++; }
	else { failed++; console.error(`✗ ${label}`); }
}

async function throwsAsync(fn: () => Promise<unknown> | unknown, label: string): Promise<void> {
	try {
		await fn();
		failed++;
		console.error(`✗ ${label}（预期抛错但成功返回）`);
	} catch {
		passed++;
	}
}

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════════════════════
// 1. Semaphore —— 并发闸门
// ════════════════════════════════════════════════════════════════════════════
{
	const sem = createSemaphore(2);
	eq(sem.max, 2, 'semaphore: 初始 max');
	eq(sem.active, 0, 'semaphore: 初始 active');

	// 并发上限：同时最多 2 个任务处于 active
	let peak = 0;
	const tasks = Array.from({ length: 6 }, (_, i) => sem.run(async () => {
		peak = Math.max(peak, sem.active);
		await delay(5);
		return i;
	}));
	const results = await Promise.all(tasks);
	eq(peak, 2, 'semaphore: 峰值并发不超过上限');
	eq(results, [0, 1, 2, 3, 4, 5], 'semaphore: 结果保序');
	eq(sem.active, 0, 'semaphore: 全部完成后 active 归零');
	eq(sem.pending, 0, 'semaphore: 全部完成后无等待者');

	// 异常安全：fn 抛错也释放槽位
	await throwsAsync(() => sem.run(async () => { throw new Error('boom'); }), 'semaphore: run 透传异常');
	eq(sem.active, 0, 'semaphore: 异常后槽位已释放');

	// FIFO：先等待者先获得移交的槽位
	const order: number[] = [];
	const a = sem.run(async () => { order.push(1); await delay(20); });
	await delay(1);
	const b = sem.run(async () => { order.push(2); });
	const c = sem.run(async () => { order.push(3); });
	await Promise.all([a, b, c]);
	eq(order, [1, 2, 3], 'semaphore: FIFO 顺序');

	// setMax 放宽：立即唤醒等待者
	const sem2 = createSemaphore(1);
	const first = sem2.run(async () => { await delay(20); });
	await delay(1);
	const waiting = sem2.run(async () => 'w');
	eq(sem2.pending, 1, 'semaphore: 池满时有等待者');
	sem2.setMax(2);
	eq(await waiting, 'w', 'semaphore: setMax 放宽后等待者立即获得槽位');
	await first;

	// 非法入参
	await throwsAsync(() => { createSemaphore(0); }, 'semaphore: max=0 抛错');
	await throwsAsync(() => { createSemaphore(Number.NaN); }, 'semaphore: max=NaN 抛错');

	// runPooled：失败回填不中断其他任务
	const pooled = await runPooled([1, 2, 3], 2, async (n) => {
		if (n === 2) { throw new Error('n=2 failed'); }
		return n * 10;
	});
	eq(pooled[0], { ok: true, value: 10 }, 'runPooled: 成功项');
	eq(pooled[2], { ok: true, value: 30 }, 'runPooled: 失败不影响后续项');
	eq(pooled[1].ok, false, 'runPooled: 失败项回填 error');
	ok(pooled[1].ok === false && pooled[1].error.message === 'n=2 failed', 'runPooled: 错误信息保留');
}

// ════════════════════════════════════════════════════════════════════════════
// 2. CollaborationQueue —— 就绪集 / 级联终态 / 环检测
// ════════════════════════════════════════════════════════════════════════════
{
	// 依赖校验
	eq(validateDependencies([
		{ id: 'a', title: 'A', dependsOn: [] },
		{ id: 'b', title: 'B', dependsOn: ['a'] },
	]), [], 'validateDependencies: 合法 DAG');
	eq(validateDependencies([
		{ id: 'a', title: 'A', dependsOn: ['b'] },
		{ id: 'b', title: 'B', dependsOn: ['a'] },
	]).length, 1, 'validateDependencies: 检出成环');
	eq(validateDependencies([{ id: 'a', title: 'A', dependsOn: ['ghost'] }]).length, 1, 'validateDependencies: 检出未知依赖');
	eq(validateDependencies([{ id: 'a', title: 'A', dependsOn: ['a'] }]).length, 1, 'validateDependencies: 检出自依赖（只报一条，不重复报环）');

	// 就绪判定 + 依赖满足后自动就绪
	const q = createCollaborationQueue([
		{ id: 'a', title: 'A' },
		{ id: 'b', title: 'B', dependsOn: ['a'] },
		{ id: 'c', title: 'C', dependsOn: ['a', 'b'] },
		{ id: 'd', title: 'D' },
	]);
	eq(q.ready().map(t => t.id).sort(), ['a', 'd'], 'queue: 初始就绪集（无依赖者）');
	const readyEvents: string[] = [];
	q.on('task:ready', (t) => readyEvents.push(t.id));
	// 注册监听后建立基线：初始就绪（a、d）在此广播——构造函数里广播会丢事件
	q.announceReady();
	eq(readyEvents.sort(), ['a', 'd'], 'queue: announceReady 广播初始就绪');
	readyEvents.length = 0;

	q.start('a');
	eq(q.ready().map(t => t.id), ['d'], 'queue: in_progress 不在就绪集');
	q.complete('a', 'A-result');
	// ★ ready 事件是**派发信号**，必须去重：d 无依赖（add 时已广播），complete(a) 只应新增 b
	eq(readyEvents, ['b'], 'queue: 完成 a 后只新增 b 的 ready 事件（不重复广播 d）');
	eq(q.ready().map(t => t.id).sort(), ['b', 'd'], 'queue: 就绪集含 b/d');
	q.complete('b', 'B-result');
	eq(q.ready().map(t => t.id).sort(), ['c', 'd'], 'queue: 双依赖满足后 c 就绪');

	// 级联失败：d 无依赖不受影响，c 依赖 b 已完成 → 需另建场景
	const q2 = createCollaborationQueue([
		{ id: 'root', title: 'Root' },
		{ id: 'mid', title: 'Mid', dependsOn: ['root'] },
		{ id: 'leaf', title: 'Leaf', dependsOn: ['mid'] },
		{ id: 'sibling', title: 'Sibling', dependsOn: ['root'] },
		{ id: 'free', title: 'Free' },
	]);
	const failedEvents: string[] = [];
	q2.on('task:failed', (t) => failedEvents.push(t.id));
	q2.start('root');
	q2.fail('root', 'provider 500');
	eq(q2.get('mid')?.status, 'failed', 'queue: 级联失败 → 直接下游 failed');
	eq(q2.get('leaf')?.status, 'failed', 'queue: 级联失败 → 递归下游 failed');
	eq(q2.get('sibling')?.status, 'failed', 'queue: 级联失败 → 兄弟分支也 failed');
	eq(q2.get('free')?.status, 'pending', 'queue: 级联失败 → 无依赖任务不受影响');
	// 级联是 DFS 递归（mid 分支先递归到 leaf，再处理 sibling）
	eq(failedEvents, ['root', 'mid', 'leaf', 'sibling'], 'queue: 级联失败事件按 DFS 序广播');
	ok((q2.get('mid')?.error ?? '').includes('dependency "Root" failed'), 'queue: 级联失败错误写明上游');
	eq(q2.ready().map(t => t.id), ['free'], 'queue: 级联后只剩无依赖任务就绪');
	ok(!q2.isDone(), 'queue: free 未终态 → 未完成');
	q2.complete('free', 'done');
	ok(q2.isDone(), 'queue: 全部终态 → isDone');
	eq(q2.summary(), { pending: 0, in_progress: 0, completed: 1, failed: 4, skipped: 0 }, 'queue: summary（root+mid+leaf+sibling 全 failed，free completed）');

	// 级联跳过
	const q3 = createCollaborationQueue([
		{ id: 'a', title: 'A' },
		{ id: 'b', title: 'B', dependsOn: ['a'] },
	]);
	const skippedEvents: string[] = [];
	q3.on('task:skipped', (t) => skippedEvents.push(t.id));
	q3.start('a');
	q3.skip('a', '用户跳过');
	eq(q3.get('b')?.status, 'skipped', 'queue: 级联跳过 → 下游 skipped');
	eq(skippedEvents, ['a', 'b'], 'queue: 跳过事件广播');
	ok(q3.isDone(), 'queue: 全部 skipped → isDone');

	// 运行期动态插入（动态委派产物）：依赖满足即自动就绪
	const q4 = createCollaborationQueue([{ id: 'plan', title: 'Plan' }]);
	const added: string[] = [];
	q4.on('task:added', (t) => added.push(t.id));
	q4.complete('plan', 'plan-output');
	q4.add({ id: 'spawn-1', title: 'Spawn 1', dependsOn: ['plan'] });
	q4.add({ id: 'spawn-2', title: 'Spawn 2', dependsOn: ['plan'] });
	eq(added, ['spawn-1', 'spawn-2'], 'queue: 动态插入发 task:added');
	eq(q4.ready().map(t => t.id).sort(), ['spawn-1', 'spawn-2'], 'queue: 动态插入且依赖已满足 → 立即就绪');

	// 重复 id 与非法操作
	await throwsAsync(() => q4.add({ id: 'plan', title: 'dup' }), 'queue: 重复 id 抛错');
	await throwsAsync(() => q4.update('ghost', { title: 'x' }), 'queue: update 未知任务抛错');

	// in_progress 不被级联覆盖（正在跑的节点有自己终态）
	const q5 = createCollaborationQueue([
		{ id: 'a', title: 'A' },
		{ id: 'b', title: 'B', dependsOn: ['a'] },
	]);
	q5.start('a');
	q5.start('b');
	q5.fail('a', 'x');
	eq(q5.get('b')?.status, 'in_progress', 'queue: 级联不覆盖 in_progress 节点');

	// unregister 监听器
	const q6 = createCollaborationQueue([{ id: 'a', title: 'A' }]);
	let calls = 0;
	const off = q6.on('task:completed', () => { calls++; });
	q6.start('a');
	q6.complete('a');
	off();
	eq(calls, 1, 'queue: 监听器可注销');
}

// ════════════════════════════════════════════════════════════════════════════
// 3. contextAssembly —— 拒绝式上下文注入
// ════════════════════════════════════════════════════════════════════════════
{
	const self = { id: 'n3', title: '汇总', description: '把上游结论汇总' };
	const deps = [
		{ taskId: 'n1', title: '检索', assignee: 'researcher', output: '结论 A', structured: { hits: 3 }, status: 'completed' as const },
		{ taskId: 'n2', title: '分析', assignee: 'data', output: '结论 B', status: 'completed' as const },
		{ taskId: 'n0', title: '失败项', output: '半成品', status: 'failed' as const },
		{ taskId: 'n4', title: '未完成', output: undefined, status: 'completed' as const },
	];

	// 默认拒绝式：只注入直接依赖且 completed 且有输出
	const r1 = assembleNodeContext(self, deps);
	eq(r1.included, ['n1', 'n2'], 'context: 默认只注入 completed 且有输出的直接依赖');
	eq(r1.skipped.sort(), ['n0', 'n4'], 'context: 跳过 failed 与空输出');
	ok(r1.text.includes('# Task: 汇总'), 'context: 含任务标题');
	ok(r1.text.includes('## Context from prerequisite tasks'), 'context: 含依赖区块');
	ok(r1.text.includes('结论 A') && r1.text.includes('结论 B'), 'context: 含依赖原文');
	ok(!r1.text.includes('半成品'), 'context: 不注入失败依赖的内容');

	// 无依赖：只有任务头
	const r2 = assembleNodeContext(self, []);
	ok(!r2.text.includes('Context from prerequisite tasks'), 'context: 无依赖时无依赖区块');

	// memoryScope='all' 才注入共享摘要
	const withSummary = assembleNodeContext(self, deps, { memoryScope: 'all', sharedSummary: '## Shared blackboard\n- key: v' });
	ok(withSummary.text.includes('Shared memory summary'), 'context: all 模式注入共享摘要');
	const withoutSummary = assembleNodeContext(self, deps, { sharedSummary: '## Shared blackboard' });
	ok(!withoutSummary.text.includes('Shared memory summary'), 'context: dependencies 模式不注入共享摘要（拒绝式）');

	// 消息总线恒注入
	const r3 = assembleNodeContext(self, deps, { messages: [{ from: 'agent-a', content: '注意格式' }] });
	ok(r3.text.includes('## Messages from team members') && r3.text.includes('**agent-a**: 注意格式'), 'context: 消息总线恒注入');

	// payload 形态
	const structured = assembleNodeContext(self, [deps[0]], { dependencyPayload: 'structured' });
	ok(structured.text.includes('{"hits":3}'), 'context: structured 模式序列化结构化值');
	await throwsAsync(
		() => assembleNodeContext(self, [deps[1]], { dependencyPayload: 'structured' }),
		'context: structured 模式缺结构化值 → 抛 DependencyPayloadError',
	);
	const both = assembleNodeContext(self, [deps[0]], { dependencyPayload: 'both' });
	ok(both.text.includes('Validated structured result:'), 'context: both 模式含两段');

	// 大小上限：超限抛错而非截断
	const huge = 'x'.repeat(DEFAULT_MAX_PAYLOAD_BYTES + 10);
	await throwsAsync(
		() => assembleNodeContext(self, [{ taskId: 'big', title: 'Big', output: huge, status: 'completed' }]),
		'context: payload 超 64KB → 抛错（不静默截断）',
	);
	// 自定义上限
	await throwsAsync(
		() => assembleNodeContext(self, [{ taskId: 'big', title: 'Big', output: 'y'.repeat(50), status: 'completed' }], { maxPayloadBytes: 10 }),
		'context: 自定义 maxPayloadBytes 生效',
	);

	// stableStringify：key 顺序无关
	eq(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }), 'stableStringify: key 顺序无关');
	eq(stableStringify({ a: [1, { y: 1, x: 2 }] }), '{"a":[1,{"x":2,"y":1}]}', 'stableStringify: 嵌套稳定');
	eq(stableStringify(null), 'null', 'stableStringify: null');

	// revealContext 前置
	const r4 = assembleNodeContext(self, [], { revealContext: '## Team\n- agent-a' });
	ok(r4.text.startsWith('## Team'), 'context: revealContext 注入在最前');
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Blackboard —— 共享记忆（命名空间 / TTL / 摘要截断）
// ════════════════════════════════════════════════════════════════════════════
{
	const bb = createBlackboard({ summaryValueChars: 20 });
	bb.write('agent-a', 'finding', 'A 的发现');
	bb.write('agent-b', 'finding', 'B 的发现');
	eq(bb.read('agent-a/finding')?.value, 'A 的发现', 'blackboard: 命名空间读写');
	eq(bb.read('agent-b/finding')?.value, 'B 的发现', 'blackboard: 不同 agent 同 key 不冲突');
	eq(bb.read('finding'), undefined, 'blackboard: 未限定键读不到（需全限定）');
	eq(bb.list().length, 2, 'blackboard: list 全量');
	eq(bb.list({ agent: 'agent-a' }).length, 1, 'blackboard: list 按 agent 过滤');

	// 摘要：按 agent 分组 + 截断
	bb.write('agent-a', 'long', 'x'.repeat(100));
	const sum = bb.getSummary();
	ok(sum.includes('### agent-a') && sum.includes('### agent-b'), 'blackboard: 摘要按 agent 分组');
	ok(sum.includes('xxxxx…'), 'blackboard: 摘要超长值截断');
	ok(!sum.includes('x'.repeat(30)), 'blackboard: 摘要不含完整长值');

	// 过滤
	bb.write('agent-a', 'task:t1:result', 'r1');
	ok(bb.getSummary({ taskId: 't1' }).includes('task:t1:result'), 'blackboard: 摘要按 taskId 过滤');
	ok(!bb.getSummary({ taskId: 't1' }).includes('finding'), 'blackboard: 过滤生效（不含其他键）');

	// 保留前缀不进摘要
	bb.write('__internal', 'checkpoint', 'secret');
	ok(!bb.getSummary().includes('checkpoint'), 'blackboard: __ 前缀不进摘要');

	// TTL：按回合过期，只过滤不删除
	const bb2 = createBlackboard();
	bb2.write('a', 'temp', 'v', { ttlTurns: 2 });
	eq(bb2.turn, 0, 'blackboard: 初始回合 0');
	eq(bb2.read('a/temp')?.value, 'v', 'blackboard: TTL 内可读');
	bb2.advanceTurn();
	eq(bb2.read('a/temp')?.value, 'v', 'blackboard: 回合 1 仍可读');
	bb2.advanceTurn();
	bb2.advanceTurn();
	eq(bb2.read('a/temp'), undefined, 'blackboard: 超 TTL 读取返回 undefined');
	eq(bb2.snapshot().length, 1, 'blackboard: TTL 过期项仍保留在存储（只过滤不删除）');
	ok(!bb2.getSummary().includes('temp'), 'blackboard: 过期项不进摘要');

	// snapshot / restore
	const snap = bb.snapshot();
	const bb3 = createBlackboard();
	bb3.restore(snap);
	eq(bb3.list().length, snap.length, 'blackboard: restore 恢复条目');
	ok(bb3.turn >= bb.turn, 'blackboard: restore 不回退回合号');
	bb3.clear();
	eq(bb3.list().length, 0, 'blackboard: clear 清空');
}

// ════════════════════════════════════════════════════════════════════════════
// 5. DeliveryQueue —— 租约式结果回灌
// ════════════════════════════════════════════════════════════════════════════
{
	let clock = 1000;
	const dq = createDeliveryQueue({ leaseTtlMs: 100, maxContentChars: 10, now: () => clock });

	const d1 = dq.enqueue({ id: 'd1', from: 'child-1', to: 'parent', content: '结果 1' });
	const d2 = dq.enqueue({ id: 'd2', from: 'child-2', to: 'parent', content: '结果 2' });
	dq.enqueue({ id: 'd3', from: 'child-3', to: 'other', content: '别的父节点' });
	eq(d1.status, 'pending', 'delivery: 入队为 pending');
	eq(d1.attempts, 0, 'delivery: 初始 attempts 0');

	// 内容上限截断
	const longItem = dq.enqueue({ id: 'd-long', from: 'c', to: 'parent', content: 'z'.repeat(50) });
	eq(longItem.content.length, 10 + '…[truncated]'.length, 'delivery: 超长内容截断');
	ok(longItem.content.endsWith('…[truncated]'), 'delivery: 截断标记');

	// peek 不占用
	eq(dq.peek('parent').length, 3, 'delivery: peek 返回该目标全部 pending');
	eq(dq.peek('parent')[0].status, 'pending', 'delivery: peek 不改变状态');

	// lease 原子领取（只领自己的目标）
	const leased = dq.lease('parent', 'lease-1');
	eq(leased.map(i => i.id), ['d1', 'd2', 'd-long'], 'delivery: lease 按 enqueue 序领取本目标');
	eq(leased[0].status, 'in_progress', 'delivery: lease 后为 in_progress');
	eq(leased[0].leaseId, 'lease-1', 'delivery: 记录租约 id');
	eq(dq.peek('parent').length, 0, 'delivery: 领取后无 pending');
	eq(dq.peek('other').length, 1, 'delivery: 不误领其他目标');

	// ack 确认交付
	eq(dq.ack(['d1']), 1, 'delivery: ack 变更 1 条');
	eq(dq.list({ status: 'delivered' }).map(i => i.id), ['d1'], 'delivery: ack 后为 delivered');
	eq(dq.ack(['d1']), 0, 'delivery: 重复 ack 幂等（0 变更）');
	eq(dq.ack(['ghost']), 0, 'delivery: ack 未知 id 无副作用');

	// release 归还（交付失败重试）
	eq(dq.release('lease-1'), 2, 'delivery: release 归还剩余 2 条');
	// list 按状态过滤（不隐含 to 过滤）→ pending 含始终未领取的 d3
	eq(dq.list({ status: 'pending' }).map(i => i.id).sort(), ['d-long', 'd2', 'd3'], 'delivery: 归还后回 pending（含未领取项）');
	eq(dq.list({ to: 'parent', status: 'pending' }).map(i => i.id).sort(), ['d-long', 'd2'], 'delivery: 按 to + status 过滤');
	eq(dq.list({ status: 'pending' })[0].attempts, 1, 'delivery: release 累加 attempts');
	eq(dq.release('lease-1'), 0, 'delivery: 重复 release 幂等');

	// 陈旧租约回收
	dq.lease('parent', 'lease-2');
	clock += 200;   // 超过 ttl=100
	eq(dq.reclaimStale(), 2, 'delivery: 回收陈旧租约');
	eq(dq.list({ status: 'in_progress' }).length, 0, 'delivery: 回收后无 in_progress');

	// 未超时不回收
	dq.lease('parent', 'lease-3');
	clock += 50;
	eq(dq.reclaimStale(), 0, 'delivery: 未超时不回收');
	dq.release('lease-3');

	// discard
	eq(dq.discard(['d2']), 1, 'delivery: discard 生效');
	eq(dq.list({ status: 'discarded' }).map(i => i.id), ['d2'], 'delivery: discard 状态');
	eq(dq.discard(['d2']), 0, 'delivery: 重复 discard 幂等');

	// stats
	const st = dq.stats();
	eq(st.pending + st.in_progress + st.delivered + st.discarded, 4, 'delivery: stats 总数守恒');
}

// ════════════════════════════════════════════════════════════════════════════
// 6. LoopGuard —— 循环/重复检测 + 迭代护栏
// ════════════════════════════════════════════════════════════════════════════
{
	// 工具签名确定性
	eq(
		computeToolSignature([{ name: 'read', input: { b: 1, a: 2 } }, { name: 'grep', input: {} }]),
		computeToolSignature([{ name: 'grep', input: {} }, { name: 'read', input: { a: 2, b: 1 } }]),
		'loopGuard: 工具签名与顺序/key 顺序无关',
	);

	const ld = createLoopDetector({ maxRepetitions: 3, window: 4 });
	eq(ld.maxRepeats, 3, 'loopGuard: maxRepeats');
	eq(ld.windowSize, 4, 'loopGuard: windowSize');

	const same = [{ name: 'read_file', input: { path: '/a' } }];
	eq(ld.recordToolCalls(same), null, 'loopGuard: 第 1 次不判定');
	eq(ld.recordToolCalls(same), null, 'loopGuard: 第 2 次不判定');
	const hit = ld.recordToolCalls(same);
	ok(hit !== null && hit.kind === 'tool_repetition', 'loopGuard: 第 3 次连续相同 → 命中');
	eq(hit?.repetitions, 3, 'loopGuard: 命中时报告重复次数');

	// 不同调用打破连续
	ld.reset();
	ld.recordToolCalls(same);
	ld.recordToolCalls([{ name: 'write_file', input: { path: '/b' } }]);
	ld.recordToolCalls(same);
	eq(ld.recordToolCalls(same), null, 'loopGuard: 中间不同则不算连续');

	// 窗口滑动：窗口外的不影响；连续计数未达阈值不判定
	ld.reset();
	for (let i = 0; i < 5; i++) {
		ld.recordToolCalls([{ name: `tool-${i}`, input: {} }]);
	}
	eq(ld.recordToolCalls([{ name: 'tool-4', input: {} }]), null, 'loopGuard: 连续 2 次未达阈值(3) 不判定');
	eq(ld.recordToolCalls([{ name: 'tool-4', input: {} }])?.repetitions, 3, 'loopGuard: 达到阈值即判定');

	// 文本重复（归一化空白：连续空白压缩为单个空格）
	const lt = createLoopDetector({ maxRepetitions: 2 });
	lt.recordText('结论 A');
	eq(lt.recordText('结论   A')?.kind, 'text_repetition', 'loopGuard: 文本归一化后判定重复');
	eq(lt.recordText('   '), null, 'loopGuard: 空文本不记录');
	lt.reset();
	eq(lt.recordText('a'), null, 'loopGuard: reset 后窗口清空');

	// 迭代护栏
	const guard = createIterationGuard(3, 'Saros.Loop');
	eq(guard.limit, 3, 'iterationGuard: limit');
	ok(guard.next(), 'iterationGuard: 第 1 次');
	ok(guard.next(), 'iterationGuard: 第 2 次');
	ok(guard.next(), 'iterationGuard: 第 3 次');
	ok(!guard.next(), 'iterationGuard: 第 4 次超限返回 false');
	eq(guard.count, 3, 'iterationGuard: count 不超限');
	ok(guard.exhausted(), 'iterationGuard: exhausted');
	eq(String(guard), 'Saros.Loop: 3/3', 'iterationGuard: 可读标签');

	// 非法上限归一到 >= 1
	const g0 = createIterationGuard(0);
	eq(g0.limit, 1, 'iterationGuard: 0 → 归一为 1');
}

// ════════════════════════════════════════════════════════════════════════════
// 7. 端到端协同场景（组合使用）
// ════════════════════════════════════════════════════════════════════════════
{
	// 场景：主管 → 3 个子任务（并发 2）→ 汇总（拒绝式注入 + 黑板摘要）
	const bb = createBlackboard();
	const q = createCollaborationQueue([
		{ id: 'plan', title: '拆解' },
		{ id: 'w1', title: '检索', dependsOn: ['plan'], assignee: 'researcher' },
		{ id: 'w2', title: '分析', dependsOn: ['plan'], assignee: 'data' },
		{ id: 'w3', title: '写作', dependsOn: ['plan'], assignee: 'writer' },
		{ id: 'merge', title: '汇总', dependsOn: ['w1', 'w2', 'w3'] },
	]);

	const sem = createSemaphore(2);
	const readyOrder: string[] = [];
	q.on('task:ready', t => readyOrder.push(t.id));
	// 注册监听后建立基线：初始就绪只有 plan（其余依赖 plan）
	q.announceReady();
	eq(readyOrder, ['plan'], 'e2e: 无依赖任务在 announceReady 时即就绪');

	readyOrder.length = 0;
	q.start('plan');
	q.complete('plan', 'plan-result');
	eq(readyOrder, ['w1', 'w2', 'w3'], 'e2e: plan 完成后三个子任务就绪');

	// 子任务并发执行（信号量限 2），结果写入黑板
	let peak = 0;
	const worker = (id: string, output: string) => sem.run(async () => {
		peak = Math.max(peak, sem.active);
		q.start(id);
		await delay(5);
		bb.write(id, 'task:' + id + ':result', output);
		bb.advanceTurn();
		q.complete(id, output);
		return output;
	});
	await Promise.all([
		worker('w1', '检索结论'),
		worker('w2', '分析结论'),
		worker('w3', '写作结论'),
	]);
	eq(peak, 2, 'e2e: 子任务并发受信号量限制');
	eq(q.get('merge')?.status, 'pending', 'e2e: merge 未开始');
	ok(q.ready().some(t => t.id === 'merge'), 'e2e: 全部子任务完成后 merge 就绪');

	// 汇总节点：拒绝式注入直接依赖 + 黑板摘要（opt-in）
	const deps = ['w1', 'w2', 'w3'].map(id => {
		const t = q.get(id) as CollabTask;
		return { taskId: id, title: t.title, assignee: t.assignee, output: t.result, status: 'completed' as const };
	});
	const ctxDefault = assembleNodeContext({ id: 'merge', title: '汇总', description: '合并三份结论' }, deps);
	ok(!ctxDefault.text.includes('Shared blackboard'), 'e2e: 默认不注入黑板（拒绝式）');
	eq(ctxDefault.included, ['w1', 'w2', 'w3'], 'e2e: 注入三个直接依赖');
	const ctxAll = assembleNodeContext(
		{ id: 'merge', title: '汇总', description: '合并三份结论' },
		deps,
		{ memoryScope: 'all', sharedSummary: bb.getSummary() },
	);
	ok(ctxAll.text.includes('检索结论'), 'e2e: all 模式黑板摘要含子任务产出');

	// 结果回灌：子任务产物交回父节点（租约式）
	const dq = createDeliveryQueue();
	for (const id of ['w1', 'w2', 'w3']) {
		dq.enqueue({ id: `deliver-${id}`, from: id, to: 'merge', content: q.get(id)?.result ?? '' });
	}
	const batch = dq.lease('merge', 'lease-merge');
	eq(batch.map(i => i.id), ['deliver-w1', 'deliver-w2', 'deliver-w3'], 'e2e: 回灌按 enqueue 序');
	dq.ack(batch.map(i => i.id));
	eq(dq.stats().delivered, 3, 'e2e: 三条结果已交付');

	// 循环护栏：汇总节点若反复输出相同内容 → 命中
	const ld = createLoopDetector({ maxRepetitions: 2 });
	ld.recordText('结论：A');
	ok(ld.recordText('结论：A') !== null, 'e2e: 重复输出被检测');
}

// ─── 汇总 ────────────────────────────────────────────────────────────────────
console.log(`\ncollaboration kernel: ${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
