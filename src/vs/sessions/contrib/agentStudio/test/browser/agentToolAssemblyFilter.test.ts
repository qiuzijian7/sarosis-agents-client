/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `agentToolAssembly.getEnabledTools` 过滤链回归 —— 锁定两个「配置写了不生效」的
 * 缺陷修复（2026-09-11 调研发现，P0）。
 *
 *   1. `agentTools` 分支原用 `allTagged.filter(...)`，**丢弃** focus / enabledToolsets
 *      的收窄结果 → 同时配 `tools[]` + `enabledToolsets[]` 时后者形同虚设。
 *   2. `excludedTools: ['*']`（禁工具轮，对齐 toolChoice:"none"）只清空 `scoped`，
 *      而 Step 4 无条件拼回 `mcpTagged` → 模型仍可经桥接调用 MCP 工具。
 *
 * ★ 另有一条**实测锁定**用例：`shouldActivate` 阈值门控对工具列表**零影响**
 * （`assembleToolDefs` 两分支的 `toolDefs` 完全相同），deferrable 工具从不直发。
 * 这属**待决策的设计问题**（见当日记录），本次只锁定现状 + 修正误导性日志，
 * **未**擅自改实现（改它会改变全部 deferrable 工具的可见性，影响面大）。
 */

import assert from 'assert';
import { getEnabledTools, type ToolAssemblyDeps } from '../../browser/agentToolAssembly.js';
import { DEFAULT_TOOL_SEARCH_CONFIG } from '../../common/toolSearchAssembler.js';

interface IToolSpec {
	name: string;
	toolset?: string;
	category?: string;
	enabled?: boolean;
}

/** 最小可用的 ToolAssemblyDeps stub（只驱动过滤链，不碰真实服务）。 */
function makeDeps(specs: IToolSpec[], cfg: {
	agentTools?: string[];
	enabledToolsets?: string[];
	disabledToolsets?: string[];
} = {}): ToolAssemblyDeps {
	const noopLog = { info() { }, warn() { }, error() { }, debug() { }, trace() { } };
	return {
		logService: noopLog as never,
		resolveContextWindow: async () => 100_000,
		listAllToolsWithState: async () => specs.map(s => ({
			name: s.name,
			description: '',
			inputSchema: { type: 'object', properties: {} },
			enabled: s.enabled ?? true,
			...(s.category ? { category: s.category } : {}),
			// toolset 显式给出（生产侧等价于 `t.toolset ?? getToolsetForTool(name)`，
			// 见 agentToolAssembly.ts:158-161）——测试里显式化可避免依赖真实 toolset 表。
			...(s.toolset ? { toolset: s.toolset } : {}),
		})) as never,
		getAgentToolsConfig: () => cfg.agentTools,
		getAgentEnabledToolsets: () => cfg.enabledToolsets,
		getAgentDisabledToolsets: () => cfg.disabledToolsets,
		shouldEnableUpdatePlan: () => true,
		detectFocusModeIfNeeded: async () => ({ mode: 'auto', recommendedToolsets: [], reason: 'test' }) as never,
		getToolSearchConfig: () => ({ ...DEFAULT_TOOL_SEARCH_CONFIG }),
		getConfigFingerprint: () => 'fp-test',
		registryGeneration: 1,
		currentModelProvider: undefined,
		currentModelId: undefined,
		cachedToolDefs: new Map(),
		toolDefsCacheMax: 8,
		setLastAllEnabledToolNames: () => { },
		setLastAssembly: () => { },
		setLastDispatcherCtx: () => { },
	};
}

suite('agentToolAssembly 过滤链（P0 回归）', () => {

	test('★ agentTools 必须叠加在 enabledToolsets 之上（不得退回全量重算）', async () => {
		// 修复前：agentTools 分支用 `allTagged.filter(...)` → 丢弃 enabledToolsets
		// 的收窄结果，web toolset 的工具被放回（配置形同虚设）。
		const deps = makeDeps(
			[{ name: 'file_read', toolset: 'core' }, { name: 'web_search', toolset: 'web' }],
			{ enabledToolsets: ['core'], agentTools: ['file_read', 'web_search'] },
		);
		const names = (await getEnabledTools(deps, 'agent-1')).map(t => t.name);
		assert.ok(names.includes('file_read'), `core 工具应保留，实际：${names}`);
		assert.ok(
			!names.includes('web_search'),
			`web_search 属被 enabledToolsets 排除的 web toolset，不得出现，实际：${names}`,
		);
	});

	test('★ excludedTools=[\'*\'] 必须连 MCP 工具一起禁（禁工具轮）', async () => {
		// 修复前：`'*'` 只清空 scoped，Step 4 却无条件拼回 mcpTagged →
		// 模型仍可经桥接 tool_call 调用 MCP，toolChoice:none 语义被绕过。
		const deps = makeDeps([
			{ name: 'file_read', toolset: 'core' },
			{ name: 'mcp_foo_query', category: 'mcp:server1' },
		]);
		const names = (await getEnabledTools(deps, 'agent-1', undefined, undefined, undefined, ['*']))
			.map(t => t.name);
		assert.deepStrictEqual(names, [], `禁工具轮必须一个工具都不给，实际：${names}`);
	});

	test('★ 桥接上下文必须带 agentId（防跨会话串台）', async () => {
		// 2026-09-11 修复：`_lastAssembly` / `_lastDispatcherCtx` 此前是宿主侧**全局
		// 单值**（last-write-wins）→ 多 agent 并发时 A 会话的 `tool_call` 会用 B 会话
		// 最后写入的 catalog 做 scope 门控。现要求回调按 agentId 分别记录。
		const seenAssembly: string[] = [];
		const seenCtx: string[] = [];
		const deps = makeDeps([{ name: 'file_read', toolset: 'core' }]);
		deps.setLastAssembly = (agentId) => { seenAssembly.push(agentId); };
		deps.setLastDispatcherCtx = (agentId) => { seenCtx.push(agentId); };

		await getEnabledTools(deps, 'agent-A');
		await getEnabledTools(deps, 'agent-B');

		assert.deepStrictEqual(seenAssembly, ['agent-A', 'agent-B'], `assembly 必须按 agent 记录，实际：${seenAssembly}`);
		assert.deepStrictEqual(seenCtx, ['agent-A', 'agent-B'], `dispatcher ctx 必须按 agent 记录，实际：${seenCtx}`);
	});

	test('对照：未禁时 MCP 工具确实参与（防止上条因无关原因恒真）', async () => {
		const deps = makeDeps([
			{ name: 'file_read', toolset: 'core' },
			{ name: 'mcp_foo_query', category: 'mcp:server1' },
		]);
		const names = (await getEnabledTools(deps, 'agent-1')).map(t => t.name);
		// 未禁时结果非空（core 直发 + 桥接入口）——证明上一条的「空」来自排除逻辑，
		// 而不是 assembly 恒返回空。
		assert.ok(names.includes('file_read'), `core 工具应直发，实际：${names}`);
		assert.ok(names.includes('tool_search'), `应提供桥接入口，实际：${names}`);
	});

	test('★ 实测锁定：deferrable 工具（含 MCP）当前**不直发**，只经桥接可达', async () => {
		// 现场核实（2026-09-11）：`assembleToolDefs` 的两个分支
		// （`activated` / 未激活）返回**完全相同**的 `toolDefs = finalVisible + bridge`
		// → `shouldActivate` 的阈值门控对工具列表**零影响**，deferrable 工具从不直发。
		// （原日志 "sent directly (passthrough)" 是误述，已一并修正。）
		//
		// 本用例锁定**当前真实行为**以防无感漂移；「未激活是否应直发」属待决策的
		// 设计问题（见当日记录），未擅自改动实现。
		const deps = makeDeps([
			{ name: 'file_read', toolset: 'core' },
			{ name: 'mcp_foo_query', category: 'mcp:server1' },
		]);
		const names = (await getEnabledTools(deps, 'agent-1')).map(t => t.name);
		assert.ok(
			!names.includes('mcp_foo_query'),
			`deferrable（MCP）工具当前不直发、只经桥接，若此断言失败说明行为已变更：${names}`,
		);
		assert.ok(names.includes('tool_search'), `桥接入口应在，实际：${names}`);
	});
});
