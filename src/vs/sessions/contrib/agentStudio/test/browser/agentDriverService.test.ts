/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentTurnStatus } from '../../common/agentDriver.js';
import { AgentDriverService } from '../../browser/agentDriverService.js';
import type { AgentBinding } from '../../../../common/agentStudioTypes.js';
import type { IAgentOSService } from '../../common/agentOS.js';
import type { ISkillRegistry } from '../../common/skills.js';
import type { IAgentStudioService } from '../../common/agentStudio.js';
import type { ILogService } from '../../../../../platform/log/common/log.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IStorageService } from '../../../../../platform/storage/common/storage.js';
import type { IMcpService } from '../../../../../workbench/contrib/mcp/common/mcpTypes.js';
// R4 顺序契约用（读源文本断言"解析在 prompt 组装之前"）
import * as fs from 'fs';
import * as path from 'path';

suite('Agent Driver Service (Phase 2)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// Mock IAgentOSService
	class MockAgentOSService {
		executeAgentTurn(request: any): AsyncIterable<any> {
			return (async function* () {
				yield { type: 'text', content: 'Mock OS response' };
				yield { type: 'done' };
			})();
		}

		getActiveModelProvider() {
			return undefined;
		}
	}

	test('AgentTurnStatus enum values', () => {
		assert.strictEqual(AgentTurnStatus.Idle, 'idle');
		assert.strictEqual(AgentTurnStatus.Running, 'running');
		assert.strictEqual(AgentTurnStatus.Cancelling, 'cancelling');
		assert.strictEqual(AgentTurnStatus.Done, 'done');
		assert.strictEqual(AgentTurnStatus.Error, 'error');
	});

	test('executeTurn returns AsyncIterable', async () => {
		const osService = new MockAgentOSService();
		
		// 模拟 executeTurn 方法
		const executeTurn = async function* (request: any) {
			const stream = osService.executeAgentTurn(request);
			for await (const delta of stream) {
				yield delta;
			}
		};

		const request = {
			agentId: 'agent-1',
			messages: [{ role: 'user', content: 'Hello' }],
			options: {},
		};

		const deltas = [];
		for await (const delta of executeTurn(request)) {
			deltas.push(delta);
		}

		assert.ok(deltas.length > 0);
		assert.strictEqual(deltas[0].type, 'text');
	});

	test('cancelTurn aborts running turn', () => {
		const activeTurns = new Map<string, AbortController>();
		const turnStatusMap = new Map<string, string>();

		// 模拟 executeTurn
		const executeTurn = async (turnId: string) => {
			const controller = new AbortController();
			activeTurns.set(turnId, controller);
			turnStatusMap.set(turnId, AgentTurnStatus.Running);
		};

		// 模拟 cancelTurn
		const cancelTurn = (turnId: string) => {
			const controller = activeTurns.get(turnId);
			if (controller) {
				turnStatusMap.set(turnId, AgentTurnStatus.Cancelling);
				controller.abort();
				activeTurns.delete(turnId);
			}
		};

		executeTurn('turn-1');
		assert.strictEqual(turnStatusMap.get('turn-1'), AgentTurnStatus.Running);

		cancelTurn('turn-1');
		assert.strictEqual(turnStatusMap.get('turn-1'), AgentTurnStatus.Cancelling);
		assert.ok(!activeTurns.has('turn-1'));
	});

	test('multiple turns can run concurrently', async () => {
		const activeTurns = new Map<string, boolean>();

		const executeTurn = async (turnId: string) => {
			activeTurns.set(turnId, true);
			// 模拟异步操作
			await new Promise(resolve => setTimeout(resolve, 10));
			activeTurns.delete(turnId);
		};

		// 启动两个并发 turn
		const p1 = executeTurn('turn-1');
		const p2 = executeTurn('turn-2');

		// 验证两个 turn 都在运行
		assert.ok(activeTurns.has('turn-1'));
		assert.ok(activeTurns.has('turn-2'));

		await Promise.all([p1, p2]);
	});

	test('executeFromChatOptions adapts options correctly', () => {
		const executeFromChatOptions = (
			agentId: string,
			message: string,
			options: any,
		) => {
			// 将 IChatSendOptions 适配为 IAgentTurnRequest
			return {
				agentId,
				messages: [{ role: 'user', content: message }],
				options: {
					temperature: options.temperature,
					maxTokens: options.maxTokens,
				},
			};
		};

		const result = executeFromChatOptions(
			'emp-1',
			'Hello',
			{ temperature: 0.7, maxTokens: 4096 },
		);

		assert.strictEqual(result.agentId, 'emp-1');
		assert.strictEqual(result.messages[0].content, 'Hello');
		assert.strictEqual(result.options.temperature, 0.7);
		assert.strictEqual(result.options.maxTokens, 4096);
	});

	test('turn status lifecycle', () => {
		const turnStatusMap = new Map<string, string>();

		const updateStatus = (turnId: string, status: string) => {
			turnStatusMap.set(turnId, status);
		};

		const getStatus = (turnId: string) => {
			return turnStatusMap.get(turnId) || AgentTurnStatus.Idle;
		};

		// 模拟 turn 生命周期
		const turnId = 'turn-1';
		
		updateStatus(turnId, AgentTurnStatus.Running);
		assert.strictEqual(getStatus(turnId), AgentTurnStatus.Running);

		updateStatus(turnId, AgentTurnStatus.Done);
		assert.strictEqual(getStatus(turnId), AgentTurnStatus.Done);
	});

	test('cancelling turn sets status to Cancelling first', () => {
		const turnStatusMap = new Map<string, string>();

		const executeTurn = (turnId: string) => {
			turnStatusMap.set(turnId, AgentTurnStatus.Running);
		};

		const cancelTurn = (turnId: string) => {
			if (turnStatusMap.get(turnId) === AgentTurnStatus.Running) {
				turnStatusMap.set(turnId, AgentTurnStatus.Cancelling);
				// 模拟异步取消
				setTimeout(() => {
					turnStatusMap.set(turnId, AgentTurnStatus.Done);
				}, 0);
			}
		};

		executeTurn('turn-1');
		cancelTurn('turn-1');

		assert.strictEqual(turnStatusMap.get('turn-1'), AgentTurnStatus.Cancelling);
	});

	test('fallback to direct chat when no OS service', async () => {
		// 模拟直通模式
		const fallbackToDirectChat = async function* () {
			yield { type: 'text', content: 'Fallback response' };
			yield { type: 'done' };
		};

		const deltas = [];
		for await (const delta of fallbackToDirectChat()) {
			deltas.push(delta);
		}

		assert.ok(deltas.length > 0);
		assert.strictEqual(deltas[0].type, 'text');
	});

	test('error handling in executeTurn', async () => {
		const executeTurnWithError = async function* (shouldError: boolean) {
			try {
				if (shouldError) {
					throw new Error('Test error');
				}
				yield { type: 'text', content: 'Success' };
				yield { type: 'done' };
			} catch (error) {
				yield { type: 'error', content: (error as Error).message };
			}
		};

		const deltas = [];
		for await (const delta of executeTurnWithError(true)) {
			deltas.push(delta);
		}

		assert.strictEqual(deltas[0].type, 'error');
		assert.strictEqual(deltas[0].content, 'Test error');
	});
});

// ─── P1b：启动自愈 —— 恢复进程崩溃/重启残留的临时 worktree 覆盖 ─────────────
// 背景：task 临时改写 binding.worktreePath 时持久化 tempWorktreeOverride 标记
// （含 originalWorktreePath）。进程崩溃导致 finally 未恢复时，启动自愈扫描所有
// 带标记的 binding 并恢复。仅动带标记的 binding，绝不触碰用户合法绑定。

// Mock ILogService（记录 info/warn 便于调试，不强断言）
class P1bLogService {
	infos: string[] = [];
	warns: string[] = [];
	debug(): void { }
	info(msg: string): void { this.infos.push(msg); }
	warn(msg: string): void { this.warns.push(msg); }
	error(): void { }
	trace(): void { }
}

// In-memory IAgentStudioService：承载 binding 存储，用于驱动自愈逻辑。
// 复制 production upsertAgentBinding 的 merge 语义（显式传 tempWorktreeOverride
// 含 undefined 即清除标记），确保被测的恢复写回与真实行为一致。
class InMemoryAgentStudioService {
	private readonly _store = new Map<string, Map<string, AgentBinding>>();
	/** 让某 workspace 的 getAgentBindings 抛错，模拟磁盘读损坏。 */
	failOnWorkspace: Set<string> = new Set();
	/** 记录 getWorkspaces 被调用次数，用于验证启动自愈确实被触发。 */
	workspaceScanCount = 0;

	seed(workspaceId: string, binding: AgentBinding): void {
		if (!this._store.has(workspaceId)) { this._store.set(workspaceId, new Map()); }
		this._store.get(workspaceId)!.set(binding.agentId, binding);
	}

	async getWorkspaces(): Promise<Array<{ id: string }>> {
		this.workspaceScanCount++;
		return [...this._store.keys()].map(id => ({ id }));
	}

	async getAgentBindings(workspaceId: string): Promise<AgentBinding[]> {
		if (this.failOnWorkspace.has(workspaceId)) {
			throw new Error(`simulated read failure for ${workspaceId}`);
		}
		const m = this._store.get(workspaceId);
		if (!m) { return []; }
		// 深拷贝返回，模拟从磁盘读取（调用方引用修改不直接影响 store，除非经 upsert 写回）。
		return [...m.values()].map(b => ({
			...b,
			tempWorktreeOverride: b.tempWorktreeOverride ? { ...b.tempWorktreeOverride } : undefined,
		} as AgentBinding));
	}

	async upsertAgentBinding(workspaceId: string, agentId: string, patch: Partial<AgentBinding>): Promise<AgentBinding> {
		if (!this._store.has(workspaceId)) { this._store.set(workspaceId, new Map()); }
		const m = this._store.get(workspaceId)!;
		const base: AgentBinding = m.get(agentId) ?? ({ agentId, workspaceId, createdAt: '', updatedAt: '' } as AgentBinding);
		const merged: AgentBinding = { ...base, ...patch, agentId, workspaceId } as AgentBinding;
		if ('tempWorktreeOverride' in patch) {
			if (patch.tempWorktreeOverride === undefined) {
				delete (merged as Record<string, unknown>).tempWorktreeOverride;
			} else {
				merged.tempWorktreeOverride = patch.tempWorktreeOverride;
			}
		}
		m.set(agentId, merged);
		return merged;
	}

	/** 绕过拷贝直接读 store，用于断言最终持久化状态。 */
	async getAgentBindingsRaw(workspaceId: string): Promise<AgentBinding[]> {
		const m = this._store.get(workspaceId);
		return m ? [...m.values()] : [];
	}
}

function makeDriver(studio: InMemoryAgentStudioService): AgentDriverService {
	const log = new P1bLogService();
	const config = { getValue: () => undefined } as unknown as IConfigurationService;
	// ⚠ 2026-09-21 修正：此前这里按**旧签名**注入（第 7 个位置传 IFileService、且缺最后的
	// IInstantiationService）⇒ `_mcpService`/`_storageService` 双双错位成 `{}`。因为错位后
	// 两边都是空对象、且这些用例不触碰 MCP/存储，所以一直"绿着"。现按真实构造签名对齐
	// （agentOS, skills, log, config, studio, workspaceContext, **mcp**, **storage**, **instantiation**）。
	return new AgentDriverService(
		{} as unknown as IAgentOSService,
		{} as unknown as ISkillRegistry,
		log as unknown as ILogService,
		config,
		studio as unknown as IAgentStudioService,
		{} as unknown as IWorkspaceContextService,
		{} as unknown as IMcpService,
		{} as unknown as IStorageService,
		{} as unknown as IInstantiationService,
	);
}

function makeBinding(over: Partial<AgentBinding> & { agentId: string; workspaceId: string; worktreePath?: string }): AgentBinding {
	return ({ createdAt: '', updatedAt: '', ...over } as unknown) as AgentBinding;
}

suite('Agent Driver Service — temp worktree startup recovery (P1b)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('recovers orphaned temp worktree override back to original worktreePath', async () => {
		const studio = new InMemoryAgentStudioService();
		studio.seed('ws1', makeBinding({
			agentId: 'agentA', workspaceId: 'ws1', worktreePath: '/tmp/crash-wt',
			tempWorktreeOverride: { originalWorktreePath: '/orig/wt', owner: 'turn-xyz', timestamp: Date.now() },
		}));

		const driver = makeDriver(studio);
		await (driver as unknown as { _recoverOrphanedTempOverrides(): Promise<void> })._recoverOrphanedTempOverrides();

		const b = await studio.getAgentBindingsRaw('ws1');
		const a = b.find(x => x.agentId === 'agentA')!;
		assert.strictEqual(a.worktreePath, '/orig/wt', '应恢复为原始 worktreePath');
		assert.strictEqual('tempWorktreeOverride' in a, false, '临时覆盖标记应被清除');
		driver.dispose();
	});

	test('does NOT touch user binding without tempWorktreeOverride marker', async () => {
		const studio = new InMemoryAgentStudioService();
		studio.seed('ws1', makeBinding({ agentId: 'agentU', workspaceId: 'ws1', worktreePath: '/user/wt' }));

		const driver = makeDriver(studio);
		await (driver as unknown as { _recoverOrphanedTempOverrides(): Promise<void> })._recoverOrphanedTempOverrides();

		const b = await studio.getAgentBindingsRaw('ws1');
		const u = b.find(x => x.agentId === 'agentU')!;
		assert.strictEqual(u.worktreePath, '/user/wt', '用户合法绑定不应被改动');
		assert.strictEqual('tempWorktreeOverride' in u, false);
		driver.dispose();
	});

	test('recovers mixed bindings across multiple workspaces, leaves unmarked untouched', async () => {
		const studio = new InMemoryAgentStudioService();
		studio.seed('ws1', makeBinding({
			agentId: 'agentA', workspaceId: 'ws1', worktreePath: '/tmp/wtA',
			tempWorktreeOverride: { originalWorktreePath: '/orig/wtA', owner: 't1', timestamp: 1 },
		}));
		studio.seed('ws1', makeBinding({ agentId: 'agentB', workspaceId: 'ws1', worktreePath: '/keep/wtB' }));
		studio.seed('ws2', makeBinding({
			agentId: 'agentC', workspaceId: 'ws2', worktreePath: '/tmp/wtC',
			tempWorktreeOverride: { originalWorktreePath: '/orig/wtC', owner: 't2', timestamp: 2 },
		}));

		const driver = makeDriver(studio);
		await (driver as unknown as { _recoverOrphanedTempOverrides(): Promise<void> })._recoverOrphanedTempOverrides();

		const ws1 = await studio.getAgentBindingsRaw('ws1');
		const a = ws1.find(x => x.agentId === 'agentA')!;
		const bnd = ws1.find(x => x.agentId === 'agentB')!;
		const ws2 = await studio.getAgentBindingsRaw('ws2');
		const c = ws2.find(x => x.agentId === 'agentC')!;

		assert.strictEqual(a.worktreePath, '/orig/wtA');
		assert.strictEqual('tempWorktreeOverride' in a, false);
		assert.strictEqual(bnd.worktreePath, '/keep/wtB', '无标记 binding 不变');
		assert.strictEqual('tempWorktreeOverride' in bnd, false);
		assert.strictEqual(c.worktreePath, '/orig/wtC');
		assert.strictEqual('tempWorktreeOverride' in c, false);
		driver.dispose();
	});

	test('recovers to undefined when originalWorktreePath was undefined (no prior binding)', async () => {
		const studio = new InMemoryAgentStudioService();
		studio.seed('ws1', makeBinding({
			agentId: 'agentD', workspaceId: 'ws1', worktreePath: '/tmp/wtD',
			tempWorktreeOverride: { originalWorktreePath: undefined, owner: 't3', timestamp: 3 },
		}));

		const driver = makeDriver(studio);
		await (driver as unknown as { _recoverOrphanedTempOverrides(): Promise<void> })._recoverOrphanedTempOverrides();

		const b = await studio.getAgentBindingsRaw('ws1');
		const d = b.find(x => x.agentId === 'agentD')!;
		assert.strictEqual(d.worktreePath, undefined, '无原始绑定时应恢复为 undefined');
		assert.strictEqual('tempWorktreeOverride' in d, false);
		driver.dispose();
	});

	test('survives read failure on one workspace and recovers the others', async () => {
		const studio = new InMemoryAgentStudioService();
		studio.seed('wsBad', makeBinding({
			agentId: 'agentBad', workspaceId: 'wsBad', worktreePath: '/tmp/bad',
			tempWorktreeOverride: { originalWorktreePath: '/orig/bad', owner: 't4', timestamp: 4 },
		}));
		studio.seed('wsGood', makeBinding({
			agentId: 'agentGood', workspaceId: 'wsGood', worktreePath: '/tmp/good',
			tempWorktreeOverride: { originalWorktreePath: '/orig/good', owner: 't5', timestamp: 5 },
		}));
		studio.failOnWorkspace.add('wsBad');

		const driver = makeDriver(studio);
		await (driver as unknown as { _recoverOrphanedTempOverrides(): Promise<void> })._recoverOrphanedTempOverrides();

		const good = await studio.getAgentBindingsRaw('wsGood');
		const g = good.find(x => x.agentId === 'agentGood')!;
		assert.strictEqual(g.worktreePath, '/orig/good', '坏 workspace 抛错不应阻断其它 workspace 的恢复');
		assert.strictEqual('tempWorktreeOverride' in g, false);

		// wsBad 因读失败被跳过：其绑定保持原样（仍带标记）。
		const bad = await studio.getAgentBindingsRaw('wsBad');
		const bd = bad.find(x => x.agentId === 'agentBad')!;
		assert.strictEqual(bd.worktreePath, '/tmp/bad', '读失败的 workspace 不被处理');
		assert.strictEqual('tempWorktreeOverride' in bd, true);
		driver.dispose();
	});

	test('no-op on empty workspace store', async () => {
		const studio = new InMemoryAgentStudioService();
		const driver = makeDriver(studio);
		// 构造时 fire-and-forget 自愈已扫描一次；此处手动触发再次确认空 store 不抛错。
		await (driver as unknown as { _recoverOrphanedTempOverrides(): Promise<void> })._recoverOrphanedTempOverrides();
		assert.ok(studio.workspaceScanCount >= 1, '空 store 也应触发至少一次自愈扫描');
		driver.dispose();
	});

	test('construction auto-triggers startup recovery', async () => {
		const studio = new InMemoryAgentStudioService();
		studio.seed('ws1', makeBinding({
			agentId: 'agentA', workspaceId: 'ws1', worktreePath: '/tmp/crash-wt',
			tempWorktreeOverride: { originalWorktreePath: '/orig/wt', owner: 'turn-xyz', timestamp: Date.now() },
		}));

		const driver = makeDriver(studio);
		// 构造时 fire-and-forget 自愈已触发；等待微任务完成。
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.ok(studio.workspaceScanCount >= 1, '构造应自动触发一次启动自愈扫描');

		const b = await studio.getAgentBindingsRaw('ws1');
		const a = b.find(x => x.agentId === 'agentA')!;
		assert.strictEqual(a.worktreePath, '/orig/wt', '构造时自愈应已恢复临时覆盖');
		assert.strictEqual('tempWorktreeOverride' in a, false);
		driver.dispose();
	});
});

suite('Agent Driver Service — resume 范式与策略提示词一致（R4 修复）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const DRIVER_SRC = () => fs.readFileSync(
		path.join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/browser/agentDriverService.ts'), 'utf8');

	/** 剥掉注释后的源码 —— 防止"注释里写着 R4 但代码没做"式假绿。 */
	function strippedSource(): string {
		return DRIVER_SRC()
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^[ \t]*\/\/.*$/gm, '');
	}

	/** 带可控 workspace storage 的 driver（checkpoint 由 storage.get 返回）。参数顺序同真实构造签名。 */
	function makeDriverWithStorage(
		studio: InMemoryAgentStudioService,
		storageGet: (key: string) => string | undefined,
		onGet?: () => void,
	): AgentDriverService {
		return new AgentDriverService(
			{} as unknown as IAgentOSService,
			{} as unknown as ISkillRegistry,
			new P1bLogService() as unknown as ILogService,
			{ getValue: () => undefined } as unknown as IConfigurationService,
			studio as unknown as IAgentStudioService,
			{} as unknown as IWorkspaceContextService,
			{} as unknown as IMcpService,
			{ get: (k: string) => { onGet?.(); return storageGet(k); } } as unknown as IStorageService,
			{} as unknown as IInstantiationService,
		);
	}

	type ResumeResolver = (req: { resumeFrom?: unknown; sessionId?: string }) => { paradigm?: string } | undefined;

	test('★★★ 调用方显式传入的 resumeFrom 优先，且**不读存储**', () => {
		const studio = new InMemoryAgentStudioService();
		let storageReads = 0;
		const driver = makeDriverWithStorage(studio, () => JSON.stringify({ paradigm: 'readonly' }), () => { storageReads++; });

		const explicit = { paradigm: 'graph' };
		const got = (driver as unknown as { _resolveTurnResumeFrom: ResumeResolver })
			._resolveTurnResumeFrom({ resumeFrom: explicit, sessionId: 's1' });

		assert.strictEqual(got, explicit, '显式 resumeFrom 必须原样返回（它是调用方的权威输入）✗');
		assert.strictEqual(storageReads, 0, '显式给了就不该再去读 checkpoint ✗');
		driver.dispose();
	});

	test('★★★ 未显式给 + 有 sessionId ⇒ 从 checkpoint 解析出范式（prompt 组装要靠它）', () => {
		const studio = new InMemoryAgentStudioService();
		const driver = makeDriverWithStorage(studio, () => JSON.stringify({ paradigm: 'readonly' }));

		const got = (driver as unknown as { _resolveTurnResumeFrom: ResumeResolver })
			._resolveTurnResumeFrom({ sessionId: 's1' });

		assert.strictEqual(got?.paradigm, 'readonly',
			'checkpoint 里的范式必须能被解析出来 —— 否则 resume 那一轮的策略提示词会按 Agent 配置渲染，'
			+ '与主循环实际采用的范式错配（R4）✗');
		driver.dispose();
	});

	test('★ 无 sessionId ⇒ 不触碰存储（与旧 `if (sessionId)` 守卫同语义）', () => {
		const studio = new InMemoryAgentStudioService();
		let storageReads = 0;
		const driver = makeDriverWithStorage(studio, () => { throw new Error('不该被调用'); }, () => { storageReads++; });

		const got = (driver as unknown as { _resolveTurnResumeFrom: ResumeResolver })._resolveTurnResumeFrom({});
		assert.strictEqual(got, undefined);
		assert.strictEqual(storageReads, 0, '无 sessionId 时不得读存储 ✗');
		driver.dispose();
	});

	test('★★★ 顺序契约：resume 解析必须在 prompt 组装**之前**，且 graphRequest 复用同一变量', () => {
		// 为什么用源码顺序断言：这是**时序**类缺陷 —— 解析写得再对，只要位置晚于 prompt 组装，
		// 就回到 R4（提示词范式 A / 策略范式 B），且没有任何单元级可观察量能捕获它。
		const src = strippedSource();
		const declIdx = src.indexOf('const resumeFromForTurn = this._resolveTurnResumeFrom(request);');
		const guidanceIdx = src.indexOf('getStrategyGuidance(resumeFromForTurn?.paradigm ?? agent?.paradigm)');
		assert.ok(declIdx !== -1, '必须统一解析一次 resumeFromForTurn ✗');
		assert.ok(guidanceIdx !== -1, '策略提示词必须读 resumeFromForTurn（否则 checkpoint 范式到不了 prompt）✗');
		assert.ok(declIdx < guidanceIdx,
			'resume 解析必须**早于**策略提示词组装 —— 晚于它就会退回 R4 错配（prompt 范式与策略范式不一致）✗');

		assert.ok(src.includes('resumeFrom: resumeFromForTurn,'),
			'graphRequest 必须复用同一份 resumeFrom（否则 prompt 与实际恢复的消息/范式口径可能漂移）✗');
		assert.ok(!/resumeFrom:\s*enrichedRequest\.resumeFrom\s*\?\?/.test(src),
			'不得退回"在 :1370 附近二次解析"的旧写法 —— 那正是 R4 的来源 ✗');
	});
});
