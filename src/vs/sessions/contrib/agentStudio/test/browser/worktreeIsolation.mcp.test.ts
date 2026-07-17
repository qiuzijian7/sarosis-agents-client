/*---------------------------------------------------------------------------------------------
 *  Worktree 隔离 — D2: MCP 桥接工具 cwd 隔离
 *--------------------------------------------------------------------------------------------
 *
 * 问题来源：看板 / 聊天框选定某个 worktree 后，期望该 agent 调用的**所有**工具（含 MCP 工具）
 * 都在该 worktree 内执行（互不串台）。本文件验证并锁定这条契约。
 *
 * ─────────────────────────── D2 根因（已确认，非疑似）───────────────────────────
 * 追踪链路（src/vs/sessions/contrib/agentStudio/browser/）：
 *
 *  driver.executeTurn(request.worktreePath)
 *    └─ 临时覆盖 binding.worktreePath（仅 Builtin 工具读取，见 builtinToolProvider._resolveAndCheckWorkspacePath）
 *         ↓
 *  agentOSService._executeToolCalls(toolCalls, agentId, worktreePath, signal)   [agentOSService.ts:4208]
 *         ├─ 普通工具分支：走 _resolveAndCheckWorkspacePath(agentId,...) → 读 binding.worktreePath ✅ 隔离生效
 *         └─ 桥接工具分支（tool_search/tool_describe/tool_call）:
 *              if (isBridgeTool(toolCall.name)) {                              [agentOSService.ts:4320]
 *                  const bridgeResult = await this._executeBridgeTool(
 *                      toolCall.name, bridgeArgs, agentId, toolCall.id, abortSignal, worktreePath);  ← ✅ D2 已透传
 *              }
 *                   ↓
 *              _executeBridgeTool(bridgeToolName, args, agentId, toolCallId, abortSignal, worktreePath)  [agentOSService.ts:4058]
 *                   ↓  unwrap → 真实工具（多为 MCP 工具）
 *              executeWithRetryAndTimeout(knownProvider, agentId,
 *                  { id, name, arguments, worktreePath }, { timeoutMs, parentSignal })        [agentOSService.ts:4124 / 4465]
 *                                                                  ↑ IToolCall.worktreePath ✅ D2 已写入
 *                   ↓
 *              McpToolProvider.executeTool(_agentId, call, signal)             [mcpToolProvider.ts:141]
 *                  const res = await routed.tool.call(call.arguments ?? {}, mcpCallContext, CancellationToken.None);
 *                                                                   ↑ mcpCallContext 携带 worktreePath ✅ D2 已注入
 *
 *  约束点：
 *   - IToolCall 接口（common/providers.ts:850）增加 `worktreePath?: string`（D2 已落地）。
 *   - IMcpTool.call(params, context?, token?)（mcpTypes.ts:506）第二参是 IMcpToolCallContext。
 *   - MCP 工作目录是 **server 级别**（McpServerTransportStdio.cwd，mcpTypes.ts:527），
 *     per-call 切换 cwd 受协议限制。D2 短期方案为契约透传（context 注入 worktreePath），
 *     中期真正并发隔离：每个 worktree 起独立 MCP server 实例，或按 worktreePath 路由。
 *
 * ─────────────────────────── 修复方案（验收点，已落地）───────────────────────────
 *  1. common/providers.ts: IToolCall 增加 `worktreePath?: string`。
 *  2. agentOSService.ts: 桥接分支(_executeBridgeTool) + 普通分支均把 worktreePath 写入 IToolCall。
 *  3. McpToolProvider.executeTool 把 worktreePath 注入 IMcpTool.call 的 context。
 *
 *  下方为 D2 修复后的验收契约（回归防护，已启用）。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { observableValue, IObservable } from '../../../../../base/common/observable.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IMcpService, IMcpServer, McpConnectionState, IMcpToolCallContext } from '../../../../../workbench/contrib/mcp/common/mcpTypes.js';
import type { IToolCall, IToolProvider, IToolResult } from '../../common/providers.js';
import { McpToolProvider } from '../../browser/providers/tool/mcpToolProvider.js';
import { executeWithRetryAndTimeout } from '../../browser/toolExecutionGuard.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────────

interface MockMcpTool extends IMcpTool {
	_calls: Array<{ params: Record<string, unknown>; context: IMcpToolCallContext | undefined }>;
}

function createMockTool(name: string): MockMcpTool {
	const calls: Array<{ params: Record<string, unknown>; context: IMcpToolCallContext | undefined }> = [];
	const tool = {
		id: `mcp_${name}`,
		referenceName: name,
		definition: { name, description: `mock tool ${name}` },
		call: async (params: Record<string, unknown>, context?: IMcpToolCallContext) => {
			calls.push({ params, context });
			return { isError: false, content: [{ type: 'text', text: 'ok' }] };
		},
		_calls: calls,
	} as unknown as MockMcpTool;
	return tool;
}

function createMockServer(id: string, tools: MockMcpTool[]): IMcpServer {
	return {
		definition: { id, label: id },
		connectionState: observableValue('conn', { state: McpConnectionState.Kind.Running }),
		tools: observableValue('tools', tools),
		start: async () => { /* already running in mock */ },
	} as unknown as IMcpServer;
}

class MockMcpService implements Partial<IMcpService> {
	readonly servers: IObservable<readonly IMcpServer[]>;
	constructor(servers: IMcpServer[]) {
		this.servers = observableValue('servers', servers);
	}
}

class MockLogService implements Partial<ILogService> {
	info(): void { }
	warn(): void { }
	debug(): void { }
	error(): void { }
	trace(): void { }
}

function newProvider(tools: MockMcpTool[]): { provider: McpToolProvider; server: IMcpServer } {
	const server = createMockServer('codebase', tools);
	const provider = new McpToolProvider(new MockMcpService([server]) as unknown as IMcpService, new MockLogService() as unknown as ILogService);
	return { provider, server };
}

suite('Worktree 隔离 — D2: MCP 桥接工具 cwd 隔离', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * 基线（修复后）：确认 IToolCall 契约现在**支持**可选 worktreePath 字段，
	 * 且不影响既有结构。这是 D2 缺口修复后的正向基线。
	 */
	test('基线: IToolCall 契约包含可选 worktreePath 字段（D2 已修复）', () => {
		const withWt: IToolCall = { id: 'c1', name: 'get_architecture', arguments: {}, worktreePath: '/wt-A' };
		const withoutWt: IToolCall = { id: 'c2', name: 'search_graph', arguments: {} };
		assert.ok(withWt.id && withWt.name && typeof withWt.arguments === 'object');
		assert.strictEqual(withWt.worktreePath, '/wt-A');
		assert.strictEqual(withoutWt.worktreePath, undefined, 'worktreePath 可选，缺省为 undefined');
	});

	/**
	 * 验收 D2-1: 透传层 — IToolCall.worktreePath 经 executeWithRetryAndTimeout 到达 provider。
	 *
	 * 验收点（链路后半段，可被独立验证）：
	 *  1) AgentOS._executeBridgeTool 把 worktreePath 写入 IToolCall（agentOSService.ts:4124/4141，已落地）
	 *  2) 执行层（executeWithRetryAndTimeout → provider.executeTool）把 IToolCall 原样透传，
	 *     因此 provider 收到的 IToolCall 携带 worktreePath。
	 * 此测试锁定 (2)：一旦 IToolCall 携带 worktreePath，provider 端即可读取，契约闭合。
	 */
	test('验收 D2-1: IToolCall.worktreePath 经执行层透传到达 provider', async () => {
		const captured: IToolCall[] = [];
		const provider = {
			id: 'capture',
			executeTool: async (_agentId: string, call: IToolCall): Promise<IToolResult> => {
				captured.push(call);
				return { toolCallId: call.id, success: true, content: [] };
			},
		} as unknown as IToolProvider;

		await executeWithRetryAndTimeout(
			provider, 'agent-1',
			{ id: 'c1', name: 'get_architecture', arguments: {}, worktreePath: '/wt-A' },
			{ timeoutMs: 2000 },
		);

		assert.strictEqual(captured.length, 1, 'provider.executeTool must be called exactly once');
		assert.strictEqual(captured[0].worktreePath, '/wt-A', 'worktreePath must be propagated on the IToolCall');

		// 对照：未携带 worktreePath 时字段为 undefined（不污染普通工具调用）
		const captured2: IToolCall[] = [];
		const provider2 = {
			id: 'capture2',
			executeTool: async (_agentId: string, call: IToolCall): Promise<IToolResult> => {
				captured2.push(call);
				return { toolCallId: call.id, success: true, content: [] };
			},
		} as unknown as IToolProvider;
		await executeWithRetryAndTimeout(
			provider2, 'agent-1',
			{ id: 'c2', name: 'search_graph', arguments: {} },
			{ timeoutMs: 2000 },
		);
		assert.strictEqual(captured2[0].worktreePath, undefined, 'absent worktreePath stays undefined');
	});

	/**
	 * 验收 D2-2: McpToolProvider.executeTool 应将 worktreePath 注入 MCP 调用上下文。
	 *
	 * 验收点：
	 *   McpToolProvider.executeTool 收到携带 worktreePath 的 IToolCall 后，
	 *   在 routed.tool.call(params, context, token) 的 context 中携带 worktreePath，
	 *   使 server 能感知当前工作根。
	 */
	test('验收 D2-2: McpToolProvider.executeTool 将 worktreePath 注入 MCP 调用 context', async () => {
		const tool = createMockTool('get_architecture');
		const { provider } = newProvider([tool]);
		try {
			const result = await provider.executeTool('agent-1', {
				id: 'c1', name: 'get_architecture', arguments: {}, worktreePath: '/wt-A',
			});

			assert.strictEqual(result.success, true, 'tool should execute successfully');
			assert.strictEqual(tool._calls.length, 1, 'underlying IMcpTool.call must be invoked once');
			const ctx = tool._calls[0].context;
			assert.ok(ctx, 'MCP call context must be present when worktreePath is set');
			assert.strictEqual((ctx as unknown as { worktreePath?: string }).worktreePath, '/wt-A',
				'context must carry the worktreePath');
		} finally {
			provider.dispose();
		}
	});

	/**
	 * 对照 D2-2（无 worktreePath）：context 应保持 undefined，避免污染非看板场景。
	 */
	test('对照 D2-2: 未携带 worktreePath 时 MCP call context 为 undefined', async () => {
		const tool = createMockTool('search_graph');
		const { provider } = newProvider([tool]);
		try {
			await provider.executeTool('agent-1', {
				id: 'c2', name: 'search_graph', arguments: {},
			});
			assert.strictEqual(tool._calls.length, 1);
			assert.strictEqual(tool._calls[0].context, undefined, 'no worktreePath → context stays undefined');
		} finally {
			provider.dispose();
		}
	});

	/**
	 * 验收 D2-3: 并发看板任务（不同 worktree）的 MCP 工具应各自隔离。
	 *
	 * 验收点：
	 *   任务 X 在 /wt-A、任务 Y 在 /wt-B 并发调用同一 MCP 工具 get_architecture 时，
	 *   两次 MCP 调用各自携带对应 worktreePath，不串台。
	 */
	test('验收 D2-3: 并发看板任务（不同 worktree）的 MCP 工具各自隔离', async () => {
		const tool = createMockTool('get_architecture');
		const { provider } = newProvider([tool]);
		try {
			await Promise.all([
				provider.executeTool('agent-1', { id: 'a', name: 'get_architecture', arguments: {}, worktreePath: '/wt-A' }),
				provider.executeTool('agent-1', { id: 'b', name: 'get_architecture', arguments: {}, worktreePath: '/wt-B' }),
			]);

			assert.strictEqual(tool._calls.length, 2, 'both concurrent calls must reach the MCP tool');
			const wts = tool._calls.map(c => (c.context as unknown as { worktreePath?: string } | undefined)?.worktreePath);
			assert.ok(wts.includes('/wt-A'), 'one call must carry /wt-A');
			assert.ok(wts.includes('/wt-B'), 'the other call must carry /wt-B');
		} finally {
			provider.dispose();
		}
	});
});
