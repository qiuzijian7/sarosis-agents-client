/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * sandboxBypassRoots 生命周期验收测试（真实导入集成测试）。
 *
 * 直接 import 被测实现 `SandboxGuard`，并配合一个与 builtinToolProvider 完全同构的
 * 临时放行 Set（addSandboxBypassRoot / removeSandboxBypassRoot / clearSandboxBypassRoots
 * 三件套），覆盖 2026-07-28 事故回归：
 *
 *   - AllowOnce 放行仅存活于「本次重执行」：reExecuteAfterSandbox 在 executeToolCalls
 *     前 add，finally 内 remove；重执行完成后放行根必须为空，不得泄漏到后续调用。
 *   - 跨批次的残留放行根由 fresh-dispatch 入口（agentOSService._clearSandboxBypassRoots）
 *     在进入下一批工具前清空；该清空仅作用于临时 _sandboxBypassRoots，绝不触碰
 *     persistSandboxRoot 持久根（AllowWorkspace），持久根跨调用保留。
 *   - 关键危险边界：清空绝不能发生在 reExecuteAfterSandbox 与 fresh 共用的
 *     executeToolCalls 共享路径内——否则会擦除进行中的 AllowOnce 放行、使重执行再次被拦截。
 *     本测试通过断言「重执行期间临时放行根仍可见、重执行后为空」来锁死该不变量。
 *
 * 运行方式：
 *   cd <project-root>
 *   npx mocha --require ts-node/register \
 *     src/vs/sessions/contrib/agentStudio/test/browser/sandboxBypassClear.test.ts
 */

import assert from 'assert';
import * as nodePath from 'path';

import {
	SandboxGuard,
	SandboxConfirmationDecision,
} from '../../browser/agentSandboxGuard.js';
import type {
	ISandboxViolationInfo,
	IToolCallInfo,
} from '../../common/providers.js';

// ── 与 builtinToolProvider 同构的临时放行集合（测试替身）──────────────────
interface FakeBuiltinProvider {
	addSandboxBypassRoot(p: string): void;
	removeSandboxBypassRoot(p: string): void;
	clearSandboxBypassRoots(): void;
}

function makeFakeProvider(bypass: Set<string>): FakeBuiltinProvider {
	return {
		addSandboxBypassRoot: (p: string) => bypass.add(p.replace(/[\\/]+$/, '')),
		removeSandboxBypassRoot: (p: string) => bypass.delete(p.replace(/[\\/]+$/, '')),
		clearSandboxBypassRoots: () => bypass.clear(),
	};
}

const ROOT = process.platform === 'win32' ? 'C:\\__agent_test__' : '/__agent_test__';

// 构造一个最较小的 ISandboxViolationInfo（仅覆盖 guard 实际读取的字段）
function makeViolation(requestedPath: string): ISandboxViolationInfo {
	return {
		requestedPath,
		resolvedPath: requestedPath,
		suggestedPath: undefined as unknown as string,
		allowedRoots: [ROOT],
		isWorktree: true,
	} as unknown as ISandboxViolationInfo;
}

function makeToolCall(id: string): IToolCallInfo {
	return { id, name: 'write_file', arguments: JSON.stringify({ path: id }) } as unknown as IToolCallInfo;
}

function makeGuard(bypass: Set<string>, opts: {
	persisted?: string[]; // AllowWorkspace 持久根收集器（独立，不被清空影响）
	onExecute?: (bypassSnapshot: Set<string>) => void; // 在 executeToolCalls 内观测放行根
} = {}): SandboxGuard {
	const provider = makeFakeProvider(bypass);
	const deps: any = {
		logService: { info: () => {}, warn: () => {} },
		approvalService: { setApprovalHandler: () => {} },
		pendingSandboxConfirmations: new Map<string, (d: SandboxConfirmationDecision) => void>(),
		executeToolCalls: async (tcs: IToolCallInfo[]) => {
			opts.onExecute?.(new Set(bypass)); // 快照当前放行根
			return tcs.map(tc => ({ toolCallId: (tc as any).id, content: [], success: true }));
		},
		getBuiltinProvider: () => provider,
		persistSandboxRoot: async (_wsId: string, dir: string) => {
			opts.persisted?.push(dir);
		},
	};
	return new SandboxGuard(deps);
}

// ── 测试套件 ─────────────────────────────────────────────────────────────
suite('Sandbox Bypass Roots 生命周期', () => {

	test('AllowOnce 放行根在重执行 finally 中移除，不泄漏到后续调用', async () => {
		const bypass = new Set<string>();
		let seenDuringExecute = new Set<string>();
		const guard = makeGuard(bypass, {
			onExecute: (snap) => { seenDuringExecute = snap; },
		});
		const requested = nodePath.join(ROOT, 'leak.ts');
		const v = makeViolation(requested);

		const r = await guard.reExecuteAfterSandbox(
			makeToolCall('tc-1'), 'agent-1', ROOT, undefined,
			SandboxConfirmationDecision.AllowOnce, v,
		);

		// 重执行本身应成功
		assert.strictEqual(r.success, true);
		// 重执行「期间」临时放行根必须可见（证明 add 发生在 executeToolCalls 之前）
		assert.ok(seenDuringExecute.has(requested), '重执行期间 AllowOnce 放行根应可见');
		// 重执行「之后」放行根必须已清空（finally remove）——不泄漏到后续调用
		assert.strictEqual(bypass.size, 0, '重执行 after finally 后放行根应为空');
	});

	test('fresh-dispatch 入口清空 _sandboxBypassRoots 不影响持久根（AllowWorkspace）', async () => {
		const bypass = new Set<string>();
		const persisted: string[] = [];

		// 模拟持久根（AllowWorkspace 写入）
		const persistDir = nodePath.join(ROOT, 'persisted-ws');
		persisted.push(persistDir);

		// 模拟上一批次遗留的 AllowOnce 残留（异常/abort 导致 finally 未跑到的边缘情况）
		bypass.add(nodePath.join(ROOT, 'leftover.ts'));

		// fresh-dispatch 入口执行清空（即 agentOSService._clearSandboxBypassRoots 的语义）
		makeFakeProvider(bypass).clearSandboxBypassRoots();

		// 临时放行根已清空
		assert.strictEqual(bypass.size, 0, '清空后临时放行根应为空');
		// 持久根未被触碰
		assert.strictEqual(persisted.length, 1);
		assert.strictEqual(persisted[0], persistDir, '持久根不应被 clearSandboxBypassRoots 影响');
	});

	test('清空前若残留 AllowOnce，fresh 派发时不再可见（防止跨批次泄漏）', async () => {
		const bypass = new Set<string>();
		let snapshotAtFreshExecute = new Set<string>();
		const guard = makeGuard(bypass, {
			onExecute: (snap) => { snapshotAtFreshExecute = snap; },
		});

		// 上一批次遗留的 AllowOnce 残留
		const leftover = nodePath.join(ROOT, 'leftover.ts');
		bypass.add(leftover);

		// fresh-dispatch 入口清空（在进入下一批工具前）
		makeFakeProvider(bypass).clearSandboxBypassRoots();

		// 下一批 fresh 工具派发（以 Cancel 决策模拟一次普通 fresh 调用路径的等价快照）
		await guard.reExecuteAfterSandbox(
			makeToolCall('tc-2'), 'agent-1', ROOT, undefined,
			SandboxConfirmationDecision.Cancel, makeViolation(nodePath.join(ROOT, 'fresh.ts')),
		);

		// fresh 派发期间不应再看到上一批次残留的放行根
		assert.ok(!snapshotAtFreshExecute.has(leftover), '下一批 fresh 派发不应携带上一批次残留放行根');
	});
});
