/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Steering（运行中消息注入）链路「接线」不变量 —— **源码级**断言。
 *
 * ## 为什么需要这一层
 *
 * steering 是全仓唯一一条「用户运行中输入 → 不打断 turn → 下轮注入」的路径，
 * 横跨 5 个文件、3 个构建目标：
 *
 *   webview useChatStore ──postMessage──▶ controller case ──▶ driver 队列 ──▶ executor 注入点
 *
 * `agentSteeringWiring.test.ts` 已经用真实实例锁住了 driver 队列的**语义**
 * （agentId 隔离 / 懒建 / id 唯一 / from 默认值）。但语义正确 ≠ 接线完整：
 *
 *   · executor 的注入点被删 → 队列照常入队、永远无人消费，**用户消息静默消失**；
 *   · controller 的 case 被删 → webview 发的消息落进 default 分支，**无任何报错**；
 *   · webview 改回 `cancelStream()` → 退回到「打断重发」，把本次注入白做。
 *
 * 这三处**单元测试都测不出来**：被测逻辑本身没跑，错的是「有没有人调用它」。
 * 与 `guardrailWiring.test.ts` 同一类问题，故用同一手法：直接扫源码钉死接线。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/agentSteeringContract.test.ts
 */

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const AGENT_STUDIO = 'src/vs/sessions/contrib/agentStudio';

function read(rel: string): string {
	return fs.readFileSync(path.join(AGENT_STUDIO, rel), 'utf8');
}

/**
 * 去掉整行 `//` 注释 —— 与 `guardrailWiring.test.ts` 同一实现与理由：
 * 注释里提到某个标识符会让正向断言「假通过」，必须只看代码。
 */
function stripComments(src: string): string {
	return src
		.split('\n')
		.filter(line => !/^\s*\/\//.test(line))
		.join('\n');
}

/** 从 `case "X": {` 起截取该 case 的代码块（按花括号配平）。 */
function extractCaseBlock(src: string, caseName: string): string {
	const marker = `case '${caseName}':`;
	const alt = `case "${caseName}":`;
	let start = src.indexOf(marker);
	if (start === -1) { start = src.indexOf(alt); }
	if (start === -1) { return ''; }

	const open = src.indexOf('{', start);
	if (open === -1) { return ''; }

	let depth = 0;
	for (let i = open; i < src.length; i++) {
		if (src[i] === '{') { depth++; }
		else if (src[i] === '}') {
			depth--;
			if (depth === 0) { return src.slice(start, i + 1); }
		}
	}
	return src.slice(start);
}

suite('Steering — 链路接线不变量（源码级）', () => {

	test('controller 注册了 agents.steeringMessage 且转发到 driver', () => {
		const src = stripComments(read('browser/agentStudioWebviewController.ts'));
		const block = extractCaseBlock(src, 'agents.steeringMessage');

		assert.ok(block.length > 0, 'controller 缺少 agents.steeringMessage case —— webview 的投递会落进 default 而静默丢弃');
		assert.ok(
			block.includes('enqueueSteeringMessage'),
			'case 存在但未调用 driver.enqueueSteeringMessage —— 消息进了 handler 却没进队列',
		);
	});

	test('controller case 读取 agentId 与 content，且缺一不可', () => {
		const src = stripComments(read('browser/agentStudioWebviewController.ts'));
		const block = extractCaseBlock(src, 'agents.steeringMessage');

		assert.ok(block.includes('agentId'), 'case 未读取 payload.agentId');
		assert.ok(block.includes('content'), 'case 未读取 payload.content');

		// 守卫：任一缺失必须短路，否则会用 undefined 当 agentId 建队列
		// ——产生一条永远无人消费的幽灵队列，且用户输入被静默吞掉。
		assert.ok(
			/if\s*\(\s*!agentId\s*\|\|\s*!content\s*\)/.test(block),
			'缺少 `if (!agentId || !content)` 守卫 —— 空 payload 会污染队列',
		);
	});

	test('executor 在主循环内调用注入函数，且注入函数消费队列', () => {
		const src = stripComments(read('browser/agentTurnExecutor.ts'));

		// 门控段（含 steering 注入）已抽成 turnIterationGate.ts 的 runIterationGate，
		// 由主循环每轮调用。这里守护完整接线链：
		//   主循环 → runIterationGate → injectSteeringMessages → lease/ack/release
		// 任一环断裂都会让「队列只进不出」或「重复注入」重现。
		const loopAt = src.indexOf('loopState.iteration < HARD_STOP_ITERATIONS');
		assert.ok(loopAt !== -1, '未找到主循环');
		const loopBody = src.slice(loopAt);
		assert.ok(
			loopBody.includes('runIterationGate('),
			'主循环未调用 runIterationGate —— 门控段（含 steering 注入）不再被执行',
		);

		// 被调用的函数本身必须真的消费队列（lease/ack/release 齐全）。
		// 注：injectSteeringMessages 已下沉到 common/loopGate.ts（避免与 turnIterationGate
		// 形成循环依赖），故这里改扫该文件 —— executor 侧只保留 import 接线。
		const gateSrc = stripComments(read('common/loopGate.ts'));
		assert.ok(
			gateSrc.includes('steeringQueue.lease('),
			'injectSteeringMessages 未调用 lease()',
		);
		assert.ok(
			gateSrc.includes('steeringQueue.ack('),
			'injectSteeringMessages 未调用 ack() —— 消息会被重复注入',
		);
		assert.ok(
			gateSrc.includes('steeringQueue.release('),
			'injectSteeringMessages 未调用 release() —— 注入失败时消息永久丢失',
		);
	});

	test('主循环调用预算门控裁决（收尾轮语义）', () => {
		// 裁决调用现位于 turnIterationGate.ts；executor 侧只保留 runIterationGate 调用点。
		const loopSrc = stripComments(read('browser/agentTurnExecutor.ts'));
		const loopAt = loopSrc.indexOf('loopState.iteration < HARD_STOP_ITERATIONS');
		assert.ok(loopAt !== -1);
		assert.ok(
			loopSrc.slice(loopAt).includes('runIterationGate('),
			'主循环未调用 runIterationGate —— 预算门控不再被执行',
		);

		const src = stripComments(read('browser/turnIterationGate.ts'));
		assert.ok(
			src.includes('classifyIterationStop('),
			'未调用 classifyIterationStop —— 收尾轮两段式语义失效（末轮成果会被丢弃）',
		);

		// 'stop' / 'wrap-up' 两个分支都必须被处理，缺一即语义残缺
		assert.ok(src.includes("'stop'"), '未处理 stop 裁决 —— 收尾轮跑完不会硬停，可能死循环');
		assert.ok(src.includes("'wrap-up'"), '未处理 wrap-up 裁决 —— 预算耗尽直接停，末轮成果丢失');
	});

	test('ping-pong 判定收口到 turnStopGate（不得回退为内联双条件）', () => {
		// 背景：`classifyPingPong` 曾长期零生产调用点（写好未接线），executor 侧
		// 是内联的 `_pingPong.pingPong && _pingPong.noProgressEvidence`。内联版的
		// 危险在于「命中模式但结果仍在变化」这一 allow 分支容易被后来者顺手简化成
		// 单条件，从而误伤正在推进的翻页/逐文件读取。
		const src = stripComments(read('browser/agentTurnExecutor.ts'));
		assert.ok(
			src.includes('classifyPingPong('),
			'executor 未调用 classifyPingPong —— ping-pong 判定又回到内联条件',
		);
		assert.ok(
			src.includes("'block-batch'"),
			'未处理 block-batch 裁决 —— ping-pong 死循环不再被拦截',
		);
		assert.ok(
			src.includes("'allow-changing'"),
			'未处理 allow-changing 裁决 —— 结果仍在变化的批次会被误拦',
		);
		// 内联双条件必须已消失，否则等于两套判据并存
		assert.ok(
			!src.includes('_pingPong.pingPong && _pingPong.noProgressEvidence'),
			'内联双条件仍在 —— 判定未真正收口，存在两套判据',
		);
	});

	test('driver 在 turn 起点回收陈旧租约（消费方崩溃兜底）', () => {
		// 回收挂在 turn 边界而非每轮 iteration：语义上「上一轮 turn 若崩在注入途中，
		// 消息卡在 in_progress，下一次 turn 开始时先捞回来」。
		// 若被删除，崩溃恢复路径消失 —— 消息永久卡死且无任何报错。
		const src = stripComments(read('browser/agentDriverService.ts'));

		assert.ok(
			src.includes('.reclaimStale()'),
			'driver 未调用 reclaimStale() —— 消费方崩溃后消息永久卡在 in_progress',
		);

		// 必须在 executeTurn 之内，否则失去「每 turn 起点回收」语义
		const turnAt = src.indexOf('async *executeTurn(');
		assert.ok(turnAt !== -1);
		const reclaimAt = src.indexOf('.reclaimStale()');
		assert.ok(
			reclaimAt > turnAt,
			'reclaimStale() 不在 executeTurn 内 —— 回收时机与 turn 解耦，崩溃兜底失效',
		);
	});

	test('注入调用点位于主循环内、每轮 iteration 处（而非循环外）', () => {
		const src = stripComments(read('browser/agentTurnExecutor.ts'));

		const callAt = src.indexOf('runIterationGate(');
		assert.ok(callAt !== -1, 'executor 未调用 runIterationGate');

		// 调用点必须在主循环体**之内**才能做到每轮 iteration 前注入；
		// 若被挪到循环外，只有首轮生效 —— 后续轮次的用户输入全部滞后。
		const loopAt = src.indexOf('loopState.iteration < HARD_STOP_ITERATIONS');
		assert.ok(loopAt !== -1, '未找到主循环');
		assert.ok(
			callAt > loopAt,
			'门控调用点不在主循环内 —— steering 只会在 turn 开头生效，失去「运行中注入」语义',
		);

		// 注入本身在 turnIterationGate.ts 内、由 runIterationGate 每轮执行；
		// 守护它确实在该模块体内（而非模块级一次性执行）。
		const gateSrc = stripComments(read('browser/turnIterationGate.ts'));
		const fnAt = gateSrc.indexOf('export function runIterationGate(');
		assert.ok(fnAt !== -1, 'turnIterationGate 未导出 runIterationGate');
		assert.ok(
			gateSrc.slice(fnAt).includes('injectSteeringMessages('),
			'runIterationGate 内未调用 injectSteeringMessages —— 注入不再逐轮执行',
		);
	});

	test('webview 在 stream 活跃时投递 steering，而非取消重发', () => {
		const src = stripComments(read('webview/src/store/useChatStore.ts'));

		const guardAt = src.indexOf("isPhaseActive(streamState?.phase)");
		assert.ok(guardAt !== -1, 'useChatStore 缺少 stream 活跃判定');

		const after = src.slice(guardAt, guardAt + 1200);

		assert.ok(
			after.includes("'agents.steeringMessage'"),
			'stream 活跃分支未发送 agents.steeringMessage —— 退回旧行为',
		);

		// 负向断言：该分支内不得再调 cancelStream()。
		// 取消会丢弃当前 turn 已产生的中间成果，与 steering 语义互斥；
		// 两者同存则 steering 白做（消息刚入队，turn 立刻被取消）。
		const branchEnd = after.indexOf('return;');
		const branch = branchEnd === -1 ? after : after.slice(0, branchEnd);
		assert.ok(
			!branch.includes('cancelStream()'),
			'活跃分支内仍有 cancelStream() —— 与 steering 语义冲突，会丢弃当前 turn 成果',
		);
	});

	test('driver 对外暴露 enqueueSteeringMessage 且声明在接口上', () => {
		const iface = stripComments(read('common/agentDriver.ts'));
		assert.ok(
			iface.includes('enqueueSteeringMessage'),
			'IAgentDriverService 未声明 enqueueSteeringMessage —— controller 无法经接口调用（DI 边界）',
		);

		const impl = stripComments(read('browser/agentDriverService.ts'));
		assert.ok(impl.includes('enqueueSteeringMessage('), 'driver 未实现 enqueueSteeringMessage');
	});

	test('executor 通过 driver 兜底取队列，避免逐层传参断链', () => {
		const src = stripComments(read('browser/agentDriverService.ts'));

		// 队列既支持逐层传参（可测试），又支持按 agentId 兜底（防调用方漏传）。
		// 兜底若被删，任何忘记传 steeringQueue 的调用路径都会静默失去注入能力。
		assert.ok(
			src.includes('_getSteeringQueue('),
			'driver 缺少 _getSteeringQueue 兜底 —— 漏传 steeringQueue 的路径将静默失去注入',
		);
	});
});

suite('钩子分发面收口契约（TurnHookBus 是唯一分发面）', () => {

	test('工具级钩子经总线分发，executor 不再直接调用 triggerHook', () => {
		// 2026-09-17 拍板「总线是唯一分发面」。此前 executor 直接调
		// `memoryProvider.triggerHook('pre_tool_use' | 'post_tool_use', ...)`，
		// 钩子名是裸 string、无类型约束、拼错不报错。
		const src = stripComments(read('browser/agentTurnExecutor.ts'));

		assert.ok(
			!/memoryProvider\??\.triggerHook/.test(src),
			'executor 仍直接调用 memoryProvider.triggerHook —— 绕过总线会重新分裂出第二套未类型化的分发面',
		);
		assert.ok(
			src.includes(`runWithGate('before_tool'`),
			'executor 未经总线分发 before_tool —— 工具前置钩子失效',
		);
		// after_tool 的实现点已随重构抽到 parts/turnPostIteration.ts（executor
		// 保留 before_tool）。断言改查抽取模块，避免把「已抽取」误判为「未分发」。
		const postSrc = stripComments(read('browser/parts/turnPostIteration.ts'));
		assert.ok(
			postSrc.includes(`runWithGate('after_tool'`),
			'工具结果钩子未经总线分发 after_tool —— 记忆系统收不到工具结果',
		);
		assert.ok(
			src.includes('registerMemoryProviderHooks('),
			'executor 未注册 memory provider 的钩子转发 —— provider 将完全收不到工具级钩子',
		);
	});

	test('注册的钩子 handler 在 turn 收尾时解绑', () => {
		const src = stripComments(read('browser/agentTurnExecutor.ts'));
		const finallyAt = src.lastIndexOf('} finally {');
		assert.ok(finallyAt !== -1, '未找到 turn 级 finally 块');
		assert.ok(
			src.slice(finallyAt).includes('disposeMemoryHooks()'),
			'finally 块未调用 disposeMemoryHooks() —— handler 闭包持有 memoryProvider，abort 路径下不解绑',
		);
	});

	test('provider 转发保持 fire-and-forget，不得 await 进主循环', () => {
		// 原实现刻意不 await：memory provider 常是跨进程代理，await 会给每个工具
		// 调用增加一次 IPC 往返。收口到总线后这一点必须由 wiring 层继续保证 ——
		// handler 同步返回 undefined，内部转发不阻塞。
		const src = stripComments(read('browser/turnHookWiring.ts'));

		assert.ok(
			!/await\s+triggerHook/.test(src) && !/await\s+pending/.test(src),
			'wiring 层 await 了 provider 转发 —— 每个工具调用会多一次 IPC 往返（性能回归）',
		);
		assert.ok(
			/pending\?\.catch\(/.test(src),
			'wiring 层未 catch 转发失败 —— 未处理的 rejection 会冒泡成 unhandled error',
		);
	});

	test('before_tool 是 fail-closed，wiring 层 handler 不得抛错', () => {
		// before_tool 抛错 → TurnHookGateError → 工具被拒执行。若 memory 转发
		// 会抛错，「记忆系统不可用」就会升级成「所有工具无法执行」。
		const src = stripComments(read('browser/turnHookWiring.ts'));
		const forwardAt = src.indexOf('const forward =');
		assert.ok(forwardAt !== -1, '未找到 forward 转发函数');

		const forwardBody = src.slice(forwardAt, src.indexOf('bus.register('));
		assert.ok(
			forwardBody.includes('try {') && forwardBody.includes('catch'),
			'forward 未用 try/catch 包裹同步抛错路径 —— provider 同步 throw 会让工具调用被 fail-closed 拒绝',
		);
	});

	test('会话级 provider 钩子不被强行塞进 turn 总线', () => {
		// session_start / prompt_submit / stop / session_end 的生命周期比一个 turn
		// 长，TurnHookBus 没有对应钩子名。它们留在原位是有意决策，不是漏迁。
		const busSrc = stripComments(read('common/turnHookBus.ts'));
		for (const sessionHook of ['session_start', 'prompt_submit', 'session_end']) {
			assert.ok(
				!busSrc.includes(`'${sessionHook}'`),
				`TurnHookBus 出现会话级钩子 ${sessionHook} —— turn 级总线不应承担跨 turn 生命周期`,
			);
		}

		// 但它们必须仍在生产中被触发，不能因为「总线唯一」而被顺手删掉。
		const injectionSrc = stripComments(read('browser/agentMemoryInjection.ts'));
		assert.ok(
			injectionSrc.includes(`triggerHook('session_start'`),
			'agentMemoryInjection 不再触发 session_start —— 会话级钩子被误删',
		);
	});
});

suite('沙箱确认收口契约（三条工具执行路径行为一致）', () => {
	/**
	 * 背景：headSerial / serial 两条路径原先各自内联约 25 行逐字重复的沙箱确认段，
	 * 而**并行路径完全没有** —— 并行批次里的写工具撞沙箱时用户拿不到确认卡片，
	 * 工具直接失败；同样的调用走串行却会弹卡片。收口到 `finalizeToolCall` 后，
	 * 这些断言防止任何一条路径再次跑偏。
	 */
	test('三条路径都经 finalizeToolCall 收尾（含并行路径）', () => {
		const src = stripComments(read('browser/agentTurnExecutor.ts'));
		const finalizeCalls = src.match(/yield\* finalizeToolCall\(/g) ?? [];
		assert.strictEqual(
			finalizeCalls.length, 3,
			`期望 headSerial/parallel/serial 三条路径各调用一次 finalizeToolCall，实际 ${finalizeCalls.length} 次`,
		);
	});

	test('并行路径的结果处理落在 finalizeToolCall 之后', () => {
		// 精确锚定并行分支：确保沙箱收尾在并行流式循环体内，而不是只在串行分支里。
		const src = stripComments(read('browser/agentTurnExecutor.ts'));
		const parallelAt = src.indexOf('_executeToolCallsParallelStreaming(');
		assert.ok(parallelAt !== -1, '未找到并行流式执行入口');

		// 并行循环体到 finally 之间必须出现 finalizeToolCall。
		const parallelBody = src.slice(parallelAt, src.indexOf('} finally {', parallelAt));
		assert.ok(
			parallelBody.includes('yield* finalizeToolCall('),
			'并行路径未经 finalizeToolCall —— 沙箱违规在并行批次中不会弹确认卡片（历史行为分叉复现）',
		);
	});

	test('executor 不再内联沙箱确认段（防重复实现回归）', () => {
		// 判据用 `_awaitSandboxConfirmation`：它是「弹卡片 + 等决策」的必经调用。
		// 收口后整个 executor 只应有一处（`_resolveSandbox` 内）。
		const src = stripComments(read('browser/agentTurnExecutor.ts'));
		const awaits = src.match(/_awaitSandboxConfirmation\(/g) ?? [];
		assert.strictEqual(
			awaits.length, 1,
			`_awaitSandboxConfirmation 出现 ${awaits.length} 次 —— 沙箱确认段被重新内联到某条路径`,
		);
	});

	test('沙箱重执行只用原始调用，不接受兜底伪造的 call', () => {
		// `_callOf` 的兜底会造出 `arguments: {}` 的假调用（供 observe 取 name）。
		// 若把它喂给 `_reExecuteAfterSandbox`，就会以空参数真实执行工具 ——
		// 比不重执行危险得多。故重执行必须走可空的 `_findCall`。
		const src = stripComments(read('browser/agentTurnExecutor.ts'));
		const reExecAt = src.indexOf('_reExecuteAfterSandbox(');
		assert.ok(reExecAt !== -1, '未找到沙箱重执行调用');

		const guardWindow = src.slice(Math.max(0, reExecAt - 400), reExecAt);
		assert.ok(
			guardWindow.includes('_findCall('),
			'沙箱重执行未经 _findCall 取原始调用 —— 可能以兜底的空 arguments 执行工具',
		);
	});
});

