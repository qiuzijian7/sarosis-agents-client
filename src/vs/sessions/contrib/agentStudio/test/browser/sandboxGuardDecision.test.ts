/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `SandboxGuard.reExecuteAfterSandbox` 的**决策分支行为测试**。
 *
 * ## 为什么需要这个文件
 *
 * 既有 `sandboxBypassClear.test.ts` 覆盖的是 **AllowOnce 的放行根生命周期**
 * （add → 重执行 → finally remove，不泄漏到后续调用）。
 * 但 `reExecuteAfterSandbox` 是一张**四路分支表**，另外三条路径无任何行为覆盖：
 *
 *   · `Cancel`          —— :143 **提前返回失败**，绝不调用 executeToolCalls
 *   · `UseSuggested`    —— :152 用 suggestedPath 改写参数后再执行
 *   · `AllowWorkspace`  —— :161 持久化工作区根（而非临时放行根）
 *
 * 其中 `Cancel` 是**安全承诺本身**（「用户拒绝即不执行」）。这条路径若坏，
 * 用户点了取消但文件仍被写入 —— 属于安全漏洞而非功能缺陷，必须有护栏。
 *
 * ## 设计约束
 *
 * - 真实 import `SandboxGuard`，不 mock 它（它就是被测对象）
 * - 只 mock 它的**依赖**（SandboxGuardDeps），断言其**外部可观察行为**
 *   （是否调用 executeToolCalls、以什么参数调用、返回什么结果）
 * - 每个用例必须能说清「断言失效 = 什么坏了」
 */

import assert from 'assert';

import { SandboxGuard } from '../../browser/agentSandboxGuard.js';
import {
	SandboxConfirmationDecision,
	type ISandboxViolationInfo,
	type IToolCallInfo,
} from '../../common/providers.js';

// ─── 测试替身 ────────────────────────────────────────────────────────────

interface ExecutedCall {
	toolCalls: IToolCallInfo[];
	agentId: string;
	worktreePath?: string;
}

/** 记录所有执行调用的假 executeToolCalls。 */
function makeExecutor(executed: ExecutedCall[], result: { content: any; success: boolean }) {
	return async (
		toolCalls: IToolCallInfo[],
		agentId: string,
		worktreePath?: string,
	): Promise<Array<{ toolCallId: string; content: any; success: boolean }>> => {
		executed.push({ toolCalls, agentId, worktreePath });
		return [{ toolCallId: toolCalls[0].id, content: result.content, success: result.success }];
	};
}

function silentLog(): { info: () => void; warn: () => void; error: () => void; debug: () => void; trace: () => void } {
	const noop = (): void => { /* 静默 */ };
	return { info: noop, warn: noop, error: noop, debug: noop, trace: noop };
}

function makeViolation(overrides: Partial<ISandboxViolationInfo> = {}): ISandboxViolationInfo {
	return {
		requestedPath: '/outside/workspace/secret.txt',
		resolvedPath: 'G:\\outside\\workspace\\secret.txt',
		allowedRoots: ['g:\\SarosWorkspace\\sarosis-agents-client'],
		suggestedPath: undefined,
		isWorktree: false,
		...overrides,
	};
}

function makeToolCall(args: unknown): IToolCallInfo {
	return {
		id: 'call-1',
		name: 'file_write',
		arguments: typeof args === 'string' ? args : JSON.stringify(args),
	} as IToolCallInfo;
}

/** 装配一个记录了全部副作用的 guard。 */
function makeGuard(options: { executeResult?: { content: any; success: boolean } } = {}) {
	const executed: ExecutedCall[] = [];
	const persistedRoots: Array<{ workspaceId: string; dir: string }> = [];
	const bypassRoots = new Set<string>();
	const addedRoots: string[] = [];
	const removedRoots: string[] = [];

	const guard = new SandboxGuard({
		logService: silentLog() as never,
		approvalService: { setApprovalHandler: () => undefined },
		pendingSandboxConfirmations: new Map(),
		executeToolCalls: makeExecutor(executed, options.executeResult ?? { content: 'OK', success: true }),
		getBuiltinProvider: () => ({
			addSandboxBypassRoot: (p: string) => { bypassRoots.add(p); addedRoots.push(p); },
			removeSandboxBypassRoot: (p: string) => { bypassRoots.delete(p); removedRoots.push(p); },
		} as never),
		persistSandboxRoot: async (workspaceId: string, dir: string) => { persistedRoots.push({ workspaceId, dir }); },
	});

	return { guard, executed, persistedRoots, bypassRoots, addedRoots, removedRoots };
}

// ─── 用例 ────────────────────────────────────────────────────────────────

suite('SandboxGuard.reExecuteAfterSandbox — 决策分支', () => {

	test('Cancel：绝不执行工具，直接返回失败结果', async () => {
		// 安全承诺：用户点「取消」→ 不执行任何工具 → 以失败结束。
		// 若 executeToolCalls 被调用，就是**未经授权的文件写入**。
		const { guard, executed, bypassRoots } = makeGuard();
		const result = await guard.reExecuteAfterSandbox(
			makeToolCall({ path: '/outside/workspace/secret.txt' }),
			'agent-1', undefined, undefined,
			SandboxConfirmationDecision.Cancel,
			makeViolation(),
			'ws-1',
		);

		assert.strictEqual(
			executed.length, 0,
			`Cancel 必须零执行（实际调用 executeToolCalls ${executed.length} 次）。`
			+ `大于 0 意味着用户拒绝后文件仍被写入 —— 安全漏洞`,
		);
		assert.strictEqual(
			result.success, false,
			`Cancel 必须以 success=false 结束（实际=${result.success}）`,
		);
		assert.strictEqual(
			result.toolCallId, 'call-1',
			`Cancel 结果必须回填原 toolCallId（实际=${result.toolCallId}），否则结果无法归属到发起的调用`,
		);
		assert.strictEqual(
			bypassRoots.size, 0,
			`Cancel 不得留下任何放行根（实际=${JSON.stringify([...bypassRoots])}）`,
		);
	});

	test('Cancel：返回内容必须明确告知模型「被用户拒绝」', async () => {
		// 模型需要可读的拒绝信号；返回空内容会让模型以为工具「没被调用过」，
		// 从而换个路径继续试探同一目标。
		const { guard } = makeGuard();
		const result = await guard.reExecuteAfterSandbox(
			makeToolCall({ path: '/outside/workspace/secret.txt' }),
			'agent-1', undefined, undefined,
			SandboxConfirmationDecision.Cancel,
			makeViolation(),
			'ws-1',
		);

		const text = JSON.stringify(result.content);
		assert.ok(
			text.includes('取消') || text.includes('拒绝'),
			`Cancel 返回内容必须包含拒绝语义（实际=${text.slice(0, 200)}）`,
		);
	});

	test('UseSuggested：用 suggestedPath 改写参数后执行', async () => {
		// 用户选择「改用建议路径」→ 必须把参数里的 requestedPath
		// 换成 suggestedPath 再执行；否则重试会再次撞同一个沙箱边界。
		const { guard, executed } = makeGuard();
		const result = await guard.reExecuteAfterSandbox(
			makeToolCall({ path: '/outside/workspace/secret.txt' }),
			'agent-1', undefined, undefined,
			SandboxConfirmationDecision.UseSuggested,
			makeViolation({ suggestedPath: '/inside/workspace/secret.txt' }),
			'ws-1',
		);

		assert.strictEqual(executed.length, 1, `UseSuggested 必须执行恰好 1 次（实际=${executed.length}）`);
		const sentArgs = String(executed[0].toolCalls[0].arguments);
		assert.ok(
			sentArgs.includes('/inside/workspace/secret.txt'),
			`必须把参数改写为 suggestedPath（实际 arguments=${sentArgs}）`,
		);
		assert.ok(
			!sentArgs.includes('/outside/workspace/secret.txt'),
			`不得残留原 requestedPath（实际 arguments=${sentArgs}）—— 残留会再次被沙箱拦截`,
		);
		assert.strictEqual(result.success, true, 'UseSuggested 执行结果须原样返回');
	});

	test('UseSuggested 但无 suggestedPath → 不改写，按原参数执行', async () => {
		// suggestedPath 为 undefined 时（computeSuggestedPath 未找到可行替代路径），
		// 分支不应崩溃，也不应把 undefined 写进参数。
		const { guard, executed } = makeGuard();
		await guard.reExecuteAfterSandbox(
			makeToolCall({ path: '/outside/workspace/secret.txt' }),
			'agent-1', undefined, undefined,
			SandboxConfirmationDecision.UseSuggested,
			makeViolation({ suggestedPath: undefined }),
			'ws-1',
		);

		assert.strictEqual(executed.length, 1, '无 suggestedPath 时仍须执行一次');
		const sentArgs = String(executed[0].toolCalls[0].arguments);
		assert.ok(
			!sentArgs.includes('undefined'),
			`无 suggestedPath 时不得把 "undefined" 写进参数（实际=${sentArgs}）`,
		);
		assert.ok(
			sentArgs.includes('/outside/workspace/secret.txt'),
			`无 suggestedPath 时应保持原参数（实际=${sentArgs}）`,
		);
	});

	test('AllowWorkspace：持久化工作区根，且不写入临时放行根', async () => {
		// AllowWorkspace 是**持久**授权（跨调用保留），走 persistSandboxRoot；
		// 与 AllowOnce 的临时放行根是两条不同的通道，不得混用。
		const { guard, executed, persistedRoots, bypassRoots } = makeGuard();
		await guard.reExecuteAfterSandbox(
			makeToolCall({ path: '/outside/workspace/secret.txt' }),
			'agent-1', undefined, undefined,
			SandboxConfirmationDecision.AllowWorkspace,
			makeViolation({ requestedPath: '/outside/workspace/secret.txt' }),
			'ws-1',
		);

		assert.strictEqual(persistedRoots.length, 1, `AllowWorkspace 必须持久化恰好 1 个根（实际=${persistedRoots.length}）`);
		assert.strictEqual(persistedRoots[0].workspaceId, 'ws-1', '持久化必须带正确 workspaceId');
		assert.ok(
			persistedRoots[0].dir.includes('workspace'),
			`持久化目录应是 requestedPath 的父目录（实际=${persistedRoots[0].dir}）`,
		);
		assert.strictEqual(
			bypassRoots.size, 0,
			`AllowWorkspace 不得写临时放行根（实际=${JSON.stringify([...bypassRoots])}）—— `
			+ `临时根会被 fresh-dispatch 清空，导致持久授权失效`,
		);
		assert.strictEqual(executed.length, 1, 'AllowWorkspace 仍须执行工具');
	});

	test('mapDecisionToCardStatus：仅 Cancel 映射为 cancelled', () => {
		// UI 状态映射错误会让用户看到「已批准」而实际被取消。
		const { guard } = makeGuard();
		assert.strictEqual(guard.mapDecisionToCardStatus(SandboxConfirmationDecision.Cancel), 'cancelled');
		assert.strictEqual(guard.mapDecisionToCardStatus(SandboxConfirmationDecision.AllowOnce), 'approved');
		assert.strictEqual(guard.mapDecisionToCardStatus(SandboxConfirmationDecision.AllowWorkspace), 'approved');
		assert.strictEqual(guard.mapDecisionToCardStatus(SandboxConfirmationDecision.UseSuggested), 'approved');
	});

	test('mapConfirmationButtonToDecision：未知按钮必须保守回落为 Cancel', () => {
		// 未知按钮若回落到「放行」就是提权漏洞；必须保守拒绝。
		const { guard } = makeGuard();
		assert.strictEqual(guard.mapConfirmationButtonToDecision('cancel'), SandboxConfirmationDecision.Cancel);
		assert.strictEqual(guard.mapConfirmationButtonToDecision('reject'), SandboxConfirmationDecision.Cancel);
		assert.strictEqual(guard.mapConfirmationButtonToDecision('deny'), SandboxConfirmationDecision.Cancel);
		assert.strictEqual(guard.mapConfirmationButtonToDecision('allow_once'), SandboxConfirmationDecision.AllowOnce);
		assert.strictEqual(guard.mapConfirmationButtonToDecision('allow_workspace'), SandboxConfirmationDecision.AllowWorkspace);
		assert.strictEqual(guard.mapConfirmationButtonToDecision('use_suggested'), SandboxConfirmationDecision.UseSuggested);
		assert.strictEqual(
			guard.mapConfirmationButtonToDecision('__unknown_button__'),
			SandboxConfirmationDecision.Cancel,
			'未知按钮必须回落为 Cancel（回落为放行即提权漏洞）',
		);
	});
});
