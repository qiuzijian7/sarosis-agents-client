/*---------------------------------------------------------------------------------------------
 *  `process` 工具单元测试 —— 2026-09-24（P1-5）
 *
 *  管后台任务（list/output/terminate/wait），薄封装主进程 `vscode:execCode` 的任务注册表。
 *  这里的每个断言都对着一类真实事故写：
 *   · **失联**：agent 启动几个后台任务后只剩一串 taskId UUID —— `list` 必须能让人认出
 *     "哪个是构建、哪个是服务、跑了多久"（这就是主进程要存 command/cwd/startedAt 的原因）；
 *   · **假信号**：kill 成功但回「still running」（日志 1789813310143 的 20+ 轮误诊）——
 *     所以 terminate 的判据是 `done:true` 而不是 `killed`；
 *   · **干等**：用前景 sleep 轮询长任务撞满 30 分钟超时 —— 所以 `wait` 封顶 120s 且到点
 *     **如实说"还在跑"**，绝不假装等到了；
 *   · **静默截断**：输出只回尾部时必须有标注，否则模型会把"尾部"当"全部"。
 *
 *  ⚠ 局部 helper 命名 `makeTool` 而非 `setup`：`setup` 是 mocha(tdd) 的 beforeEach 全局。
 *
 *  运行（仓库根目录）：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/processTools.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import {
	registerProcessTools, tailWithMarker, formatDuration, commandPreview,
	formatTaskList, pickTaskId, parseTaskList, renderTaskOutput,
	WAIT_MAX_S,
	type IProcessToolContext, type IProcessTaskInfo,
} from '../../browser/providers/tool/processTools.js';
import type { IBuiltinToolRegistration } from '../../browser/providers/tool/toolRegistry.js';

const NOW = 1_700_000_000_000;

function makeTool(opts: {
	/** 按 action 分发的主进程应答；缺省 = 成功空列表。 */
	responder?: (payload: Record<string, unknown>) => Record<string, unknown> | undefined;
	/** 没有主进程通道（非桌面宿主）。 */
	noChannel?: boolean;
}) {
	const registered: IBuiltinToolRegistration[] = [];
	const calls: Record<string, unknown>[] = [];
	const sleepCalls: number[] = [];
	let now = NOW;
	const ctx: IProcessToolContext = {
		register: d => { registered.push(d); },
		logService: { info() { }, warn() { }, error() { }, debug() { }, trace() { } } as never,
		invoke: opts.noChannel ? undefined : async (channel, payload) => {
			assert.strictEqual(channel, 'vscode:execCode', '必须走主进程 execCode 通道');
			const p = payload as Record<string, unknown>;
			calls.push(p);
			return opts.responder ? opts.responder(p) : { success: true, tasks: [] };
		},
		now: () => now,
		sleep: async (ms) => { sleepCalls.push(ms); now += ms; },
	};
	registerProcessTools(ctx);
	const tool = registered.find(r => r.definition.name === 'process');
	assert.ok(tool, '未注册 process');
	return { tool: tool!, calls, sleepCalls, advance: (ms: number) => { now += ms; } };
}

async function textOf(r: unknown): Promise<string> {
	const arr = Array.isArray(r) ? r as Array<{ text?: string }> : [];
	return String(arr[0]?.text ?? '');
}

const task = (o: Partial<IProcessTaskInfo> & { taskId: string }): IProcessTaskInfo => ({
	pid: 1234, done: false, exitCode: -1, command: 'npm run build', startedAt: NOW - 90_000, ...o,
});

suite('process 工具 · 纯函数', () => {

	test('★ 截断必须带标注（否则模型会把尾部当成全部输出）', () => {
		assert.strictEqual(tailWithMarker('abc', 10), 'abc', '没超就不该加标记');
		const long = 'x'.repeat(100);
		const out = tailWithMarker(long, 30);
		assert.match(out, /仅显示最后 30 字符/);
		assert.match(out, /共 100 字符/);
		assert.ok(out.endsWith('x'.repeat(30)));
	});

	test('formatDuration：秒/分/时各档位', () => {
		assert.strictEqual(formatDuration(3_000), '3s');
		assert.strictEqual(formatDuration(125_000), '2m05s');
		assert.strictEqual(formatDuration(3_800_000), '1h03m');
		assert.strictEqual(formatDuration(-1), '?', '非法输入不该崩');
	});

	test('commandPreview：换行折叠 + 截断（命令可能很长/多行）', () => {
		assert.strictEqual(commandPreview('echo 1'), 'echo 1');
		assert.strictEqual(commandPreview('a\n\n  b'), 'a b');
		assert.ok(commandPreview('y'.repeat(200)).endsWith('…'));
	});

	test('★★ list：运行中的排前面，带 pid/状态/时长/命令摘要（认得出任务才有意义）', () => {
		const out = formatTaskList([
			task({ taskId: 't-done', done: true, exitCode: 0, command: 'npm test', settledAt: NOW - 10_000 }),
			task({ taskId: 't-run', command: 'node server.js', startedAt: NOW - 125_000 }),
		], NOW);
		const runIdx = out.indexOf('t-run');
		const doneIdx = out.indexOf('t-done');
		assert.ok(runIdx >= 0 && doneIdx >= 0 && runIdx < doneIdx, '运行中的必须排前面');
		assert.match(out, /运行中/);
		assert.match(out, /已完成 exit=0/);
		assert.match(out, /2m05s/);
		assert.match(out, /node server\.js/);
	});

	test('空列表：明确说"没有"并给出启动方式（而不是返回空白）', () => {
		const out = formatTaskList([], NOW);
		assert.match(out, /没有后台任务/);
		assert.match(out, /execute_code\(\{/, '要告诉模型怎么启动（管理面不负责启动）');
	});

	test('pickTaskId：pid / task_id / taskId 都认（模型沿用哪个名字说不好）', () => {
		assert.strictEqual(pickTaskId({ pid: 'abc' }), 'abc');
		assert.strictEqual(pickTaskId({ task_id: 't1' }), 't1');
		assert.strictEqual(pickTaskId({ taskId: 't2' }), 't2');
		assert.strictEqual(pickTaskId({ pid: 42 }), '42');
		assert.strictEqual(pickTaskId({}), '');
	});

	test('parseTaskList 容错：缺字段/非数组/空值都不抛', () => {
		assert.deepStrictEqual(parseTaskList(undefined), []);
		assert.deepStrictEqual(parseTaskList({ tasks: 'nope' }), []);
		const list = parseTaskList({ tasks: [{ taskId: 't1', pid: 9, done: true, exitCode: 0, command: 'ls' }, { noTaskId: true }] });
		assert.strictEqual(list.length, 1, '缺 taskId 的条目要丢掉');
		assert.strictEqual(list[0].done, true);
	});

	test('renderTaskOutput：运行中/已完成/已终止三态分明，stdout 与 stderr 分开给', () => {
		assert.match(renderTaskOutput('t1', { done: false }, 100), /运行中/);
		assert.match(renderTaskOutput('t1', { done: true, exitCode: 0 }, 100), /已完成 exit=0/);
		assert.match(renderTaskOutput('t1', { killed: true, exitCode: -1 }, 100), /已被终止/);
		const out = renderTaskOutput('t1', { done: true, exitCode: 1, stdout: 'out', stderr: 'err' }, 100);
		assert.match(out, /stdout（尾部）：\nout/);
		assert.match(out, /stderr（尾部）：\nerr/);
	});
});

suite('process 工具 · handler（注入式端到端）', () => {

	test('★ list：走主进程 action=list，格式化输出（含"这些任务能干什么"的指引）', async () => {
		const { tool, calls } = makeTool({
			responder: p => p['action'] === 'list'
				? { success: true, tasks: [task({ taskId: 'abc' })] }
				: { success: false },
		});
		const out = await textOf(await tool.handler({ action: 'list' }, undefined, 'a1'));
		assert.deepStrictEqual(calls, [{ action: 'list' }]);
		assert.match(out, /abc/);
		assert.match(out, /npm run build/);
		assert.match(out, /taskId 供 output \/ wait \/ terminate/, '要带"下一步怎么用"的指引');
	});

	test('★ output：需要 taskId；未知任务把主进程原因原样带出 + 引导先 list', async () => {
		const { tool, calls } = makeTool({
			responder: p => ({ success: false, stdout: '', stderr: `unknown exec task: ${p['taskId']}`, exitCode: -1 }),
		});
		assert.match(await textOf(await tool.handler({ action: 'output' }, undefined, 'a1')), /需要 pid/);
		assert.strictEqual(calls.length, 0, '缺参数不该调用主进程');
		const out = await textOf(await tool.handler({ action: 'output', pid: 'ghost' }, undefined, 'a1'));
		assert.match(out, /unknown exec task: ghost/, '要把"任务不存在"原样带出');
		assert.match(out, /list/, '要引导先 list');
	});

	test('★ output：尾部截断默认 4000 字符（且 stdout/stderr 各自截断）', async () => {
		const big = 'o'.repeat(6000);
		const { tool } = makeTool({
			responder: () => ({ success: true, done: false, stdout: big, stderr: 'e'.repeat(6000), exitCode: -1 }),
		});
		const out = await textOf(await tool.handler({ action: 'output', pid: 't1' }, undefined, 'a1'));
		assert.match(out, /仅显示最后 4000 字符/);
		assert.ok(out.length < 10_000, `不能把 12k 全灌进上下文，实际 ${out.length}`);
	});

	test('★★ terminate：判据是 done:true（**不是** killed）—— kill 成功但说"还在跑"曾把 agent 带偏 20+ 轮', async () => {
		const { tool } = makeTool({
			responder: p => p['action'] === 'kill'
				? { success: true, done: true, killed: true, exitCode: -1, stdout: '', stderr: '' }
				: { success: false },
		});
		const out = await textOf(await tool.handler({ action: 'terminate', pid: 't1' }, undefined, 'a1'));
		assert.match(out, /已终止任务 t1/);
	});

	test('terminate 未确认 ⇒ 如实说"未确认"并给下一步（绝不假装成功）', async () => {
		const { tool } = makeTool({
			responder: p => p['action'] === 'kill'
				? { success: false, done: false, stdout: '', stderr: 'taskkill 失败', exitCode: -1 }
				: { success: false },
		});
		const out = await textOf(await tool.handler({ action: 'terminate', pid: 't1' }, undefined, 'a1'));
		assert.match(out, /未确认/);
		assert.match(out, /taskkill 失败/);
		assert.match(out, /output/, '要给下一步（看一眼它是否还在跑）');
	});

	test('★★ wait：任务在限时内完成 ⇒ 直接回最终结果（不占住轮次干等）', async () => {
		let polls = 0;
		const { tool, sleepCalls } = makeTool({
			responder: p => {
				polls++;
				return polls >= 2
					? { success: true, done: true, exitCode: 0, stdout: 'build ok', stderr: '' }
					: { success: true, done: false, stdout: '', stderr: '', exitCode: -1 };
			},
		});
		const out = await textOf(await tool.handler({ action: 'wait', pid: 't1' }, undefined, 'a1'));
		assert.match(out, /已完成 exit=0/);
		assert.match(out, /build ok/);
		assert.strictEqual(sleepCalls.length, 1, '第 2 次 poll 就完成 ⇒ 只该等一拍');
	});

	test('★★ wait：到点还没完 ⇒ 如实说"仍在运行"并指明出路（完成通知 / output / terminate）', async () => {
		const { tool, advance } = makeTool({
			responder: () => ({ success: true, done: false, stdout: '', stderr: '', exitCode: -1 }),
		});
		// 注入的 sleep 会推进时钟；给 deadline 留一点空间再推进
		const promise = tool.handler({ action: 'wait', pid: 't1', timeout: 3 }, undefined, 'a1');
		const out = await textOf(await promise);
		assert.match(out, /仍在运行/);
		assert.match(out, /自动通知/);
		assert.match(out, /terminate/);
		void advance;
	});

	test('wait 的 timeout 有硬上限（防止"等 30 分钟"）', async () => {
		const { tool } = makeTool({
			responder: () => ({ success: true, done: false, stdout: '', stderr: '', exitCode: -1 }),
		});
		const out = await textOf(await tool.handler({ action: 'wait', pid: 't1', timeout: 99999 }, undefined, 'a1'));
		assert.match(out, new RegExp(`等了 ${WAIT_MAX_S}s`), `应封顶在 ${WAIT_MAX_S}s，实际：${out.slice(0, 60)}`);
	});

	test('★ 没有主进程通道 ⇒ 明确说明 + 仍给出 execute_code 的手动路径（不假装可用）', async () => {
		const { tool, calls } = makeTool({ noChannel: true });
		const out = await textOf(await tool.handler({ action: 'list' }, undefined, 'a1'));
		assert.match(out, /主进程通道|桌面版/);
		assert.match(out, /execute_code/);
		assert.strictEqual(calls.length, 0);
	});

	test('★ 未知 action ⇒ 列出合法动作（不要静默吞掉）', async () => {
		const { tool } = makeTool({});
		const out = await textOf(await tool.handler({ action: 'fly' }, undefined, 'a1'));
		assert.match(out, /list \/ output \/ terminate \/ wait/);
	});

	test('★ schema 与 bundled 兼容：action 枚举含 bundled 的四个动作，且接受 pid', () => {
		const { tool } = makeTool({});
		const schema = tool.definition.inputSchema as { properties: Record<string, { enum?: string[] }> };
		assert.deepStrictEqual(schema.properties['action'].enum, ['list', 'output', 'terminate', 'wait'],
			'bundled 定义就是这 4 个动作（models 可能按它学来的名字调用）');
		assert.ok(schema.properties['pid'], 'bundled 用 pid 命名，必须保留这个键');
	});
});
