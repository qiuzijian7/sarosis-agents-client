/*---------------------------------------------------------------------------------------------
 *  画布写能力解析（P0①）测试。
 *
 *  `collectWriteStepIds` 把「节点 + host 提供的 writeCapable」解析成可写节点 id 集合，
 *  供 `buildParallelExecutionPlan` 把写者排进独占层（同层至多一个写者）。
 *
 *  最关键的一条：**缺信号时不判写**。若反过来（缺信号就判写），所有 `Saros.Agent` 节点
 *  都会被串行化 → 直接回归并行探索这个主用法。正确性另有调度层写互斥锁兜底。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { collectWriteStepIds, type WriteStepNodeLike } from '../../webview/src/features/workflowEditor/comfyHost/writeStepIds.js';

/** 构造查询表：未列出的 id/name → undefined（= 缺信号）。 */
function makeLookups(agents: Record<string, boolean>, tools: Record<string, boolean>) {
	return {
		agentWriteCapable: (id: string) => agents[id],
		toolWriteCapable: (name: string) => tools[name],
	};
}

const agentNode = (id: string, agentId: string): WriteStepNodeLike => ({ id, type: 'Saros.Agent', data: { agentId } });
const toolNode = (id: string, toolName: string): WriteStepNodeLike => ({ id, type: 'Saros.Tool', data: { toolName } });

suite('画布写能力解析（P0① / collectWriteStepIds）', () => {

	test('Agent 节点：writeCapable=true → 入集', () => {
		const ids = collectWriteStepIds(
			[agentNode('n1', 'coder'), agentNode('n2', 'code-explorer')],
			makeLookups({ coder: true, 'code-explorer': false }, {}),
		);
		assert.deepStrictEqual([...ids], ['n1']);
	});

	test('Tool 节点：写类工具 → 入集（file_write / patch / execute_command）', () => {
		const ids = collectWriteStepIds(
			[toolNode('t1', 'file_write'), toolNode('t2', 'patch'), toolNode('t3', 'search_files')],
			makeLookups({}, { file_write: true, patch: true, search_files: false }),
		);
		assert.deepStrictEqual([...ids].sort(), ['t1', 't2']);
	});

	test('★ 缺信号（undefined）→ **不**判写（否则所有 Agent 被串行化，回归并行探索）', () => {
		const ids = collectWriteStepIds(
			[agentNode('n1', 'unknown-agent'), toolNode('t1', 'unknown-tool')],
			makeLookups({}, {}),
		);
		assert.strictEqual(ids.size, 0);
	});

	test('writeCapable=false → 不入集（只读 agent / 只读工具）', () => {
		const ids = collectWriteStepIds(
			[agentNode('n1', 'code-explorer'), toolNode('t1', 'search_graph')],
			makeLookups({ 'code-explorer': false }, { search_graph: false }),
		);
		assert.strictEqual(ids.size, 0);
	});

	test('Skill / Task 等无能力信号的节点类型 → 不入集（由调度层写锁兜底）', () => {
		const nodes: WriteStepNodeLike[] = [
			{ id: 's1', type: 'Saros.Skill', data: { skillName: 'x' } },
			{ id: 'k1', type: 'Saros.Task', data: {} },
			{ id: 'p1', type: 'Saros.Prompt', data: {} },
		];
		const ids = collectWriteStepIds(nodes, makeLookups({}, {}));
		assert.strictEqual(ids.size, 0);
	});

	test('agentId / toolName 为空或非字符串 → 不入集（不误判）', () => {
		const nodes: WriteStepNodeLike[] = [
			{ id: 'n1', type: 'Saros.Agent', data: {} },
			{ id: 'n2', type: 'Saros.Agent', data: { agentId: '' } },
			{ id: 'n3', type: 'Saros.Agent', data: { agentId: 42 } },
			{ id: 'n4', type: 'Saros.Tool', data: { toolName: '' } },
			{ id: 'n5', type: 'Saros.Agent' }, // 无 data
		];
		const ids = collectWriteStepIds(nodes, makeLookups({ '42': true }, { '': true }));
		assert.strictEqual(ids.size, 0);
	});

	test('混合图：只挑出可写节点', () => {
		const nodes: WriteStepNodeLike[] = [
			agentNode('w1', 'coder'),
			agentNode('r1', 'code-explorer'),
			toolNode('w2', 'patch'),
			toolNode('r2', 'file_read'),
			{ id: 'g1', type: 'Saros.Group', data: {} },
		];
		const ids = collectWriteStepIds(nodes, makeLookups(
			{ coder: true, 'code-explorer': false },
			{ patch: true, file_read: false },
		));
		assert.deepStrictEqual([...ids].sort(), ['w1', 'w2']);
	});

	test('空图 → 空集', () => {
		assert.strictEqual(collectWriteStepIds([], makeLookups({}, {})).size, 0);
	});
});
