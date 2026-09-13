/*---------------------------------------------------------------------------------------------
 *  画布节点控件/属性的**唯一写入入口**（2026-09-11「卡片数据 ↔ 画布节点 UI 始终同步」第一步）。
 *
 *  由来：此前写入逻辑内联在 `LiteGraphCanvas.tsx` 的 `wf-node-control` 监听器里
 *  （`useWorkflowEditorStore.getState().updateNodeData(nodeId, { [name]: value })`）✗ ——
 *  一旦外部（host 的 canvas op、卡片回流）另起一套写路径，两套必然漂移 ✗。
 *
 *  现收敛到这里：画布自身（`wf-node-control`）与外部同步**共用同一函数** ✓。
 *  写入目标 = store 的 `node.data.<name>`；画布侧的 `node.properties.<name>` 即同一份数据
 *  （见 `applyCanvasOpsToStore` 里 `data: n.data` 的映射 ✓）。
 *--------------------------------------------------------------------------------------------*/
import { useWorkflowEditorStore } from '../store.js';

/**
 * 写入一个节点的控件/属性值。
 *
 * @param nodeId 节点 id（画布全名或 uid，由 store 决定可解析范围）
 * @param name   控件名 / 属性名（如 `selected_index`、`comfytv_image_refs`、`rows`）
 * @param value  值（`comfytv_image_refs` 这类属性以 JSON 字符串存储，由调用方负责序列化）
 * @returns 是否找到了该节点（未找到 = 写入落空，调用方可据此告警）
 */
export function applyNodeControl(
	nodeId: string,
	name: string,
	value: unknown,
	origin: 'canvas' | 'external' = 'canvas',
): boolean {
	if (!nodeId || !name) { return false; }
	const state = useWorkflowEditorStore.getState();
	const exists = Array.isArray(state.nodes) && state.nodes.some(n => n.id === nodeId);
	// 用 updateNodeData 直接 mutate（不触发 store 订阅重渲染）—— LiteGraph 自身负责重绘
	// （监听器随后 graph.change() + setDirtyCanvas()）。此处不引 LiteGraph，保持无副作用。
	state.updateNodeData(nodeId, { [name]: value });
	// ★ 画布 → 卡片回流（2026-09-11 用户需求：卡片数据 ↔ 画布节点 UI 始终同步）。
	//   只有**用户从画布改**（origin='canvas'）才通知 host；外部写入（host 的 canvas op）
	//   不通知 —— 否则与「卡片→画布」形成回环 ✗（两处数值反复互相覆盖、界面抖动）。
	if (origin === 'canvas' && exists) { scheduleNotifyHost(nodeId, name, value); }
	return exists;
}

/** 待回流的画布控件变更（按 nodeId 合并，300ms 窗口内只发一次）。 */
const pendingNotify = new Map<string, Record<string, unknown>>();
let notifyTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 节流通知 host：用户在画布上改了控件（拖动/连续输入会高频触发 ✗）。
 * 动态 import 避免与 bridge 模块的加载顺序耦合（本模块被画布核心引用）。
 */
function scheduleNotifyHost(nodeId: string, name: string, value: unknown): void {
	const bucket = pendingNotify.get(nodeId) ?? {};
	bucket[name] = value;
	pendingNotify.set(nodeId, bucket);
	if (notifyTimer !== undefined) { return; }
	notifyTimer = setTimeout(() => {
		notifyTimer = undefined;
		const batch = Array.from(pendingNotify.entries());
		pendingNotify.clear();
		void import('../../../bridge/messageClient.js').then(m => {
			for (const [id, values] of batch) {
				void m.sendRequest('workflow.nodeValuesChanged', { nodeId: id, values })
					.catch(() => { /* 通道不可用则忽略（不阻塞画布） */ });
			}
		}).catch(() => { /* 忽略 */ });
	}, 300);
}
