// @vssaros/dsh-workflow — 引擎核心环（重构 3.1）：DAG 编排 + checkpoint + 断点续跑。
//
// ── 本轮的边界（写清楚，免被误读成"引擎迁完了"）────────────────────────────
// 支持：start / end / prompt / agent / ifElse / switch（纯数据节点 + agent 经 runs）。
// 不支持（留壳，走 vssarosBridge 回 IDE）：comfy / comfyStage / askUser / media / skill / tool
//   —— 撞到这些节点 ⇒ 节点失败 + 原因写清（不静默跳过 ✗）。
//
// ── 与 legacy 的对应 ────────────────────────────────────────────────────────
// · DAG 遍历：`core/dag.js`（移植自 _getNextNodes / _getAskUserNextNodes / 邻接表）；
// · checkpoint：`core/checkpoint.js`（移植自 workflowCheckpoint.ts，逐字同逻辑 ✓）；
// · 节点重试：节点级 retryMaxAttempts（legacy 同款，默认 0 = 不重试）；
// · 断点续跑：`planWorkflowResume` 判据（completed 复用产出，其余重跑 ✓）。

import { buildWorkflowCheckpoint, parseWorkflowCheckpoint, planWorkflowResume } from './checkpoint.js';
import { askUserNextNodes, buildAdjacency, nextNodes, topoOrder } from './dag.js';

/** 确定性条件判定（移植自 legacy `_evaluateSimpleCondition`，逐字同逻辑 ✓）。 */
export function evalSimpleCondition(condition) {
	const text = String(condition ?? '').trim();
	if (!text) { return false; }
	// 裸字面量（引号包着）⇒ 真值判定（至少一个字符）
	if (/^["'].*["']$/.test(text)) { return text.length > 2; }
	// value == "literal" / value != "literal"
	const eqMatch = text.match(/^(.+?)\s*[=!]==?\s*["'](.+?)["']$/);
	if (eqMatch) {
		const lhs = eqMatch[1].trim();
		const op = text.includes('!=') || text.includes('!==') ? '!=' : '==';
		return op === '==' ? lhs === eqMatch[2] : lhs !== eqMatch[2];
	}
	// value contains "substring"
	const containsMatch = text.match(/^(.+?)\s+contains\s+["'](.+?)["']$/i);
	if (containsMatch) { return containsMatch[1].trim().toLowerCase().includes(containsMatch[2].toLowerCase()); }
	// value startsWith "prefix" / endsWith "suffix"
	const startsMatch = text.match(/^(.+?)\s+startsWith\s+["'](.+?)["']$/i);
	if (startsMatch) { return startsMatch[1].trim().toLowerCase().startsWith(startsMatch[2].toLowerCase()); }
	const endsMatch = text.match(/^(.+?)\s+endsWith\s+["'](.+?)["']$/i);
	if (endsMatch) { return endsMatch[1].trim().toLowerCase().endsWith(endsMatch[2].toLowerCase()); }
	// 真值兜底：非空且不是 false/0/null/undefined
	return text !== 'false' && text !== '0' && text !== 'null' && text !== 'undefined';
}

/** 节点状态机的词表（与 legacy WorkflowNodeExecutionStatus 逐项一致 ✓）。 */
export const NODE_STATUS = { Pending: 'pending', Running: 'running', Completed: 'completed', Failed: 'failed', Cancelled: 'cancelled', Skipped: 'skipped' };

/** 执行状态机的词表（与 legacy WorkflowExecutionStatus 逐项一致 ✓）。 */
export const EXECUTION_STATUS = { Running: 'running', Completed: 'completed', Failed: 'failed', Cancelled: 'cancelled', Paused: 'paused' };

/** 模板插值：{{nodeId.output}} / {{key}}（从 nodeStates 与 context 取，取不到留原文）。 */
export function interpolate(text, nodeStates, context) {
	return String(text ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (raw, key) => {
		const m = /^([\w-]+)\.output$/.exec(key);
		if (m) {
			const out = nodeStates[m[1]]?.output;
			return typeof out === 'string' ? out : raw;
		}
		const v = context?.[key];
		return typeof v === 'string' ? v : raw;
	});
}

/**
 * 引擎核心。deps:
 *   loadWorkflow(workflowId) → { nodes, connections }（读定义；找不到抛错）
 *   saveCheckpoint(executionId, checkpoint)（落盘；best-effort 由调用方保证）
 *   loadCheckpoint(executionId) → checkpoint | null（没有 ⇒ null）
 *   runs（vssarosRuns 服务：agent/prompt 节点的回合驱动）
 *   cwdOf(workflowId) → string（回合的工作目录）
 *   log(level, msg)
 */
export function createEngineCore(deps) {
	const { loadWorkflow, saveCheckpoint, loadCheckpoint, runs, cwdOf, log } = deps;

	/** 执行一条工作流。resumeFromExecutionId 给定时走断点续跑。 */
	async function run({ workflowId, executionId, input = {}, resumeFromExecutionId }) {
		const wf = await loadWorkflow(workflowId);
		const nodes = wf.nodes ?? [];
		const connections = wf.connections ?? [];
		const order = topoOrder(nodes, connections);
		const adj = buildAdjacency(connections);
		const byId = new Map(nodes.map(n => [String(n.id), n]));

		// 断点续跑：读 checkpoint 判可复用
		const nodeStates = {};
		let toRunSet = new Set(order);
		let resumed = false;
		if (resumeFromExecutionId) {
			const cp = await loadCheckpoint(resumeFromExecutionId);
			if (!cp) {
				throw new Error(`断点续跑：找不到 checkpoint ${resumeFromExecutionId}`);
			}
			const plan = planWorkflowResume(cp, order);
			for (const r of plan.reusable) {
				nodeStates[r.nodeId] = { status: NODE_STATUS.Completed, output: r.output ?? null, error: null, startTime: null, endTime: null };
			}
			toRunSet = new Set(plan.toRun);
			resumed = true;
			log('info', `断点续跑 ${executionId}（自 ${resumeFromExecutionId}）：${plan.summary}`);
		}

		const context = { ...input };
		const execution = { executionId, workflowId, status: EXECUTION_STATUS.Running, nodeStates, context, startedAt: new Date().toISOString() };
		// 分支剪枝（legacy 语义 ✓）：分支节点只走选中的支 ⇒ 没选中的支的下游要跳过。
		// 判定：分支节点返回的 next 是"选中的出边"；没选中的出边目标记 skip ⇒ 级联（被 skip 的节点的
		// 下游也 skip，除非它有另一条来自**非 skip** 节点的入边——合流点不该被剪 ✗）。
		const skipped = new Set();
		// 被分支节点**放弃**的边（"from:fromPort" → true）：合流判定时这些边不算活入边 ✓
		// （不修这个的话：分支源头不在 skipped ⇒ 它的未选中出边被当成活入边 ⇒ 剪不动 ✗，p3-103 ④b 实测抓到）。
		const deadEdges = new Set();
		const cascadeSkip = (id) => {
			if (skipped.has(id)) { return; }
			// 有来自非 skip、且**没被放弃**的入边 ⇒ 是合流点，不剪
			const inbound = (connections ?? []).filter(c => String(c.to ?? c.target) === id);
			const hasLiveInbound = inbound.some(c => {
				const from = String(c.from ?? c.source);
				return !skipped.has(from) && !deadEdges.has(`${from}:${c.fromPort ?? ''}`);
			});
			if (!hasLiveInbound) {
				skipped.add(id);
				nodeStates[id] = { status: NODE_STATUS.Skipped, output: null, error: '上游分支未选中', startTime: null, endTime: new Date().toISOString() };
				for (const c of adj.get(id) ?? []) { cascadeSkip(c.targetId); }
			}
		};

		const persist = async () => {
			const cp = buildWorkflowCheckpoint({
				executionId, workflowId, status: execution.status,
				nodeStates: Object.entries(nodeStates).map(([id, ns]) => [id, ns]),
				context,
			});
			await saveCheckpoint(executionId, cp);
		};

		for (const nodeId of order) {
			if (!toRunSet.has(nodeId)) { continue; }  // 复用节点：已在 nodeStates 里
			if (skipped.has(nodeId)) { continue; }    // 分支剪枝：没选中的支跳过（state 已在 cascadeSkip 里写成 Skipped ✓）
			const node = byId.get(nodeId);
			if (!node) { continue; }
			const state = { status: NODE_STATUS.Running, output: null, error: null, startTime: new Date().toISOString(), endTime: null };
			nodeStates[nodeId] = state;
			const retryMax = Number(node.data?.retryMaxAttempts ?? 0);
			let next = [];
			let failed = null;
			for (let attempt = 0; attempt <= retryMax; attempt++) {
				try {
					next = await executeNode(node, { nodeStates, context, adj, workflowId, executionId });
					failed = null;
					break;
				} catch (e) {
					failed = e;
					if (attempt < retryMax) {
						log('info', `节点 ${nodeId} 第 ${attempt + 1} 次失败，重试：${String(e?.message ?? e)}`);
					}
				}
			}
			if (failed) {
				state.status = NODE_STATUS.Failed;
				state.error = String(failed?.message ?? failed);
				state.endTime = new Date().toISOString();
				execution.status = EXECUTION_STATUS.Failed;
				await persist();
				return { ...execution, failedNode: nodeId, resumed };
			}
			state.status = NODE_STATUS.Completed;
			state.endTime = new Date().toISOString();
			await persist();  // 每节点完成后落 checkpoint（崩溃一致性 ✓）
			// 分支剪枝：分支节点返回的 next 是"选中的出边"；它**全部**出边里没被选中的目标 ⇒ 级联 skip。
			// 判据：该节点有 fromPort 出边（分支语义）且 next 覆盖了部分而不是全部 ⇒ 没盖到的剪掉。
			const outEdges = adj.get(nodeId) ?? [];
			const hasPorts = outEdges.some(c => c.fromPort);
			if (hasPorts && next.length > 0) {
				const chosen = new Set(next);
				for (const c of outEdges) {
					if (!chosen.has(c.targetId)) {
						deadEdges.add(`${nodeId}:${c.fromPort ?? ''}`);  // 这条边被放弃 ⇒ 合流判定不算它
						cascadeSkip(c.targetId);
					}
				}
			}
		}
		execution.status = EXECUTION_STATUS.Completed;
		await persist();
		return { ...execution, resumed };
	}

	/** 节点分发。返回后继 id 列表（当前实现按拓扑序走，返回值只用于 AskUser/分支语义预留）。 */
	async function executeNode(node, env) {
		const { nodeStates, context, adj, workflowId } = env;
		const type = String(node.type ?? '');
		const data = node.data ?? {};
		switch (type) {
			case 'start':
				return nextNodes(node.id, adj);
			case 'end':
				return [];
			case 'prompt':
			case 'agent': {
				// LLM 判定节点：经 vssarosRuns 驱动一回合（S4 结论：用 runs 而不是官方 subagent——
				// 子代理的 parent 必须是活 Agent，后台没有 ⇒ 先 agents.create 建根会话，那是 runs 的事 ✓）。
				const prompt = interpolate(String(data.prompt ?? data.instruction ?? data.title ?? ''), nodeStates, context);
				const result = await runs.run({
					sessionId: `wf-${workflowId}-${node.id}`,
					cwd: cwdOf(workflowId),
					prompt,
					approval: { allow: Array.isArray(data.allowTools) ? data.allowTools : [] },
				});
				if (result.stopReason !== 'completed') {
					throw new Error(`节点 ${node.id} 回合未完成（stopReason=${result.stopReason ?? '未知'}）`);
				}
				nodeStates[node.id].output = result.finalText ?? null;
				return nextNodes(node.id, adj);
			}
			case 'ifElse': {
				// 与 legacy 同形状（对账的前提 ✓）：`data.branches = [{id,label,condition,isDefault}]`，
				// 端口 `branch-N`（N = 分支下标）。判定走 legacy `_evaluateSimpleCondition` 同款
				// （确定性规则：==/!=/contains/startsWith/endsWith/裸字面量真值 ⇒ 不喊模型 ✓）。
				const branches = Array.isArray(data.branches) && data.branches.length > 0
					? data.branches
					: [{ id: '0', label: 'True', condition: '' }, { id: '1', label: 'False', condition: '' }];
				const defaultIdx = Math.max(0, branches.findIndex(b => b.isDefault));
				// 逐支判定：第一支条件成立 ⇒ 走它；都不成立 ⇒ 走 isDefault（没有 ⇒ 0）。
				let branchIndex = -1;
				for (let i = 0; i < branches.length; i++) {
					const cond = String(branches[i]?.condition ?? '').trim();
					if (!cond) { continue; }
					if (evalSimpleCondition(interpolate(cond, nodeStates, context))) {
						branchIndex = i;
						break;
					}
				}
				if (branchIndex < 0) { branchIndex = defaultIdx; }
				const connections = adj.get(node.id) ?? [];
				const matched = connections.filter(c => String(c.fromPort ?? '') === `branch-${branchIndex}`);
				return matched.length > 0 ? matched.map(c => c.targetId) : nextNodes(node.id, adj);
			}
			case 'switch': {
				const value = interpolate(String(data.expression ?? ''), nodeStates, context).trim();
				const connections = adj.get(node.id) ?? [];
				const matched = connections.filter(c => String(c.fromPort ?? '') === `case-${value}`);
				return matched.length > 0 ? matched.map(c => c.targetId) : nextNodes(node.id, adj);
			}
			case 'script': {
				// 重构 3.2：script 转交官方 `workflowEngine`（一次性脚本引擎；dsh 0.2.0 的 `workflowEngine.start`）。
				// 官方脚本是"模型现场写脚本"的场景（S4 实测）⇒ 我们的持久化节点图**不能**直接转 ✗——
				// 这里只在节点**显式给了 script 文本**时转交（data.script），否则如实失败 ✗。
				if (!deps.officialWorkflow) {
					throw new Error(`节点 ${node.id} 是 script：官方 workflowEngine 服务不在（dsh 0.2.0+ 才有）`);
				}
				const script = String(data.script ?? '').trim();
				if (!script) { throw new Error(`节点 ${node.id} 是 script 但没给脚本（data.script 为空）`); }
				const out = await deps.officialWorkflow.start({ script, cwd: cwdOf(workflowId) });
				nodeStates[node.id].output = typeof out?.output === 'string' ? out.output : (out?.output != null ? JSON.stringify(out.output) : null);
				return nextNodes(node.id, adj);
			}
			case 'comfy':
			case 'comfyStage':
			case 'askUser': {
				// 重构 3.2：留壳节点经 vssarosBridge 回 IDE（画布/媒体/交互在壳侧）。
				// 桥不在 ⇒ 如实失败（不静默跳过 ✗）。
				if (!deps.bridge) {
					throw new Error(`节点 ${node.id} 的类型 ${type} 要经桥回 IDE，但 vssarosBridge 不在（bridge 插件没装/没连）`);
				}
				const reply = await deps.bridge.callIDE('workflow.executeNode', {
					workflowId, executionId: env.executionId, nodeId: node.id, nodeType: type, data,
				});
				nodeStates[node.id].output = typeof reply?.output === 'string' ? reply.output : null;
				return nextNodes(node.id, adj);
			}
			default:
				// 其余（media / skill / tool / …）⇒ 本轮不支持，如实失败（不静默跳过 ✗）
				throw new Error(`节点 ${node.id} 的类型 ${type} 还没迁到 dsh 引擎（留壳：媒体/技能/工具节点待 Phase 4）`);
		}
	}

	return { run };
}

/** checkpoint 读入（parse + 结构校验）。 */
export function readCheckpointText(raw) {
	return parseWorkflowCheckpoint(raw);
}
