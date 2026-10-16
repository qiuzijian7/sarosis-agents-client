// @vssaros/dsh-workflow — worker_threads worker。
//
// 两条消息形态，**由 `workerData.job` 决定**：
//   · 没有 job ⇒ 老的回显（`{type:'ready', echo, threadId, pid}`）—— 能力自证用（方案把本模块列为
//     "高/不满足"，卡点之一是"引擎要从渲染进程 worker 迁到 Host 的 worker_threads"；这条回显把该前提
//     变成**可断言的事实** ✓）。
//   · `job = { type:'load', path, id }` ⇒ **真的干活**：在**本线程内**读文件并用纯函数
//     `core.parseWorkflow` 解析工作流定义，回 `{type:'loaded', ok, summary|error, threadId, pid}` ✓。
//     为什么从这里开始：迁引擎的**第一个不可回避的前提**就是"线程里能不能拿到并解析工作流定义" ✓。
//     刻意**不做**：执行、Agent 节点、会话节点（那些要 `ctx.agents` 接线与运行态设计 ✓）。
//
// 契约注意：`engine.runWorker()` 是"拿到**首条**消息就终止线程" ⇒ 有 job 时只发**一条**结果消息，别先发 ready ✓。
// 另一处刻意的差别：worker 与 Host 同进程不同线程，`workerData` 只能传结构化克隆得动的东西 ⇒ job 是纯 JSON ✓。

import { parentPort, threadId, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { parseWorkflow } from './core/workflow.js';

/**
 * 只回可克隆的纯数据（计数与标识），别把整张图塞回去 ✓。
 *
 * ⚠ 字段名必须按 **`parseWorkflow` 解析后的形状**取：它把文件里的 `connections` **改名成 `edges`** ✓
 * （见 `core/workflow.js`）。第一版我按**文件**形状读 `workflow.connections` ⇒ 真机文件里有 7 条连接、
 * 回执却报 0 ✗ —— 一句"看起来对"的假话。名字也跟着改成 `edgeCount`，免得下次再按文件形状误读 ✓。
 */
function summaryOf(workflow, fallbackId) {
	const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
	const edges = Array.isArray(workflow?.edges) ? workflow.edges : [];
	return {
		id: typeof workflow?.id === 'string' ? workflow.id : fallbackId,
		name: typeof workflow?.name === 'string' ? workflow.name : undefined,
		nodeCount: nodes.length,
		edgeCount: edges.length,
		steps: typeof workflow?.steps === 'number' ? workflow.steps : 0,
		empty: workflow?.empty === true,
		...(workflow?.nodesShapeWrong || workflow?.edgesShapeWrong ? { shapeWrong: true } : {}),
	};
}

async function runJob(job) {
	try {
		const text = await readFile(job.path, { encoding: 'utf8' });
		const parsed = parseWorkflow(text, { id: job.id });
		if (parsed?.error) {
			return { type: 'loaded', ok: false, error: String(parsed.error) };
		}
		// 防御式取形状：拿不到 `workflow` 就按"解析结果本身就是定义"处理（纯函数换了形状也不会崩 ✓）
		return { type: 'loaded', ok: true, summary: summaryOf(parsed?.workflow ?? parsed, job.id) };
	} catch (e) {
		return { type: 'loaded', ok: false, error: `读不到工作流文件（${e?.code ?? 'unknown'}）：${job.path}` };
	}
}

const job = workerData?.job;

if (job && typeof job === 'object') {
	const message = await runJob(job);
	parentPort?.postMessage({ ...message, threadId, pid: process.pid });
} else {
	parentPort?.postMessage({
		type: 'ready',
		threadId,
		echo: typeof workerData?.echo === 'string' ? workerData.echo : '',
		pid: process.pid,
	});
}
