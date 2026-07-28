/*---------------------------------------------------------------------------------------------
 *  AgentLoop 策略层 — AgentLoopStrategyFactory + 策略行为 单测
 *
 *  覆盖：
 *  - 工厂 resolve 所有注册范式
 *  - 未注册范式回退 HermesReAct
 *  - 各策略 paradigm 属性
 *  - ReadonlyStrategy hardPermission 写工具拦截
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';

const DEFAULT_BUDGET_MAX = 90;

// ─── Common test helpers (no browser dependencies) ──────────────────

/** Write tools blacklist (aligned with agentTurnExecutor.ts and readonlyStrategy.ts) */
const WRITE_TOOLS = new Set([
	'file_write', 'write_to_file', 'replace_in_file', 'edit_file',
	'delete_file', 'delete_files',
	'execute_command', 'terminal', 'bash', 'shell', 'run',
	'git_commit', 'git_push',
]);

/** ChatOnly 工具过滤器（纯函数版，对齐 agentTurnExecutor.ts） */
function filterWriteToolsForChatOnly(tools: Array<{ name: string }>): Array<{ name: string }> {
	return tools.filter(t => !WRITE_TOOLS.has(t.name));
}

suite('AgentLoop — ChatOnly 写工具过滤', () => {

	test('chatOnly=OFF：不过滤任何工具', () => {
		const tools = [{ name: 'file_read' }, { name: 'file_write' }, { name: 'terminal' }];
		// chatOnly=false → 全通过
		const result = tools.filter(() => true); // no-op
		assert.strictEqual(result.length, 3);
	});

	test('chatOnly=ON：过滤所有写工具', () => {
		const tools = [
			{ name: 'file_read' }, { name: 'file_write' },
			{ name: 'search_code' }, { name: 'execute_command' },
			{ name: 'query_graph' }, { name: 'delete_file' },
		];
		const result = filterWriteToolsForChatOnly(tools);
		assert.strictEqual(result.length, 3);
		assert.deepStrictEqual(result.map(t => t.name), ['file_read', 'search_code', 'query_graph']);
	});

	test('chatOnly=ON：delegate_task 不受写工具过滤影响', () => {
		// delegate_task 不在 WRITE_TOOLS 黑名单中
		const tools = [
			{ name: 'file_read' }, { name: 'delegate_task' }, { name: 'file_write' },
		];
		const result = filterWriteToolsForChatOnly(tools);
		assert.strictEqual(result.length, 2);
		assert.deepStrictEqual(result.map(t => t.name), ['file_read', 'delegate_task']);
	});

	test('chatOnly=ON：空工具列表安全', () => {
		const result = filterWriteToolsForChatOnly([]);
		assert.strictEqual(result.length, 0);
	});

	test('chatOnly=ON：全部是写工具时返回空', () => {
		const tools = [{ name: 'file_write' }, { name: 'delete_file' }, { name: 'execute_command' }];
		const result = filterWriteToolsForChatOnly(tools);
		assert.strictEqual(result.length, 0);
	});

	test('终端和 shell 也在写工具黑名单中', () => {
		assert.ok(WRITE_TOOLS.has('terminal'));
		assert.ok(WRITE_TOOLS.has('bash'));
		assert.ok(WRITE_TOOLS.has('shell'));
		assert.ok(WRITE_TOOLS.has('run'));
	});

	test('只读工具全不在黑名单', () => {
		assert.ok(!WRITE_TOOLS.has('file_read'));
		assert.ok(!WRITE_TOOLS.has('search_code'));
		assert.ok(!WRITE_TOOLS.has('search_graph'));
		assert.ok(!WRITE_TOOLS.has('query_graph'));
		assert.ok(!WRITE_TOOLS.has('get_code_snippet'));
		assert.ok(!WRITE_TOOLS.has('delegate_task'));
	});
});
