/**
 * 画布状态（宿主侧）：画布页推上来的镜像 + 给 Agent 看的人话摘要。
 *
 * 为什么在宿主侧：画布页是**独立 webview**（不是 dsh 客户端）⇒ 它与 Agent 之间的唯一通道
 * 就是宿主（HTTP 路由）。Agent 通过两个工具读它：`canvas_state`（摘要）/ `view_canvas`（选区截图）。
 *
 * ★ 2026-10-21（对比上游 dsh-image-gen 后补的三件）：
 *   ① **节点清单**：摘要里只说"3 个对象"⇒ 模型根本不知道画布上有什么 ⇒ 补明细（≤24 条，
 *      与上游 `canvas-state.ts:187-239` 同口径：kind / 尺寸 / 文字 / 提示词）。
 *   ② **选区三态**：`preparing`（还在导出）/ `ready`（可用）/ `error`（导出失败，带原因）
 *      —— 没有它，模型会把"还没导好"误判成"没有截图"。
 *   ③ **溯源**：图片元素按 `fileId` 反查出图时的提示词 ⇒ 模型能问"这张图是怎么来的"。
 *
 * ★ 2026-10-21（节点工作流模式，P0）：画布有两种模式 ⇒ 摘要也要分模式说：
 *   · `free`（自由绘制）：说对象数量 + 元素明细 + 选区三态（原口径不变）。
 *   · `graph`（节点工作流）：说节点清单 + 连线 + 环警告（**选区截图那套不适用**）。
 *   节点数据本体在 `lib/canvasGraph.js`（模型 + JSON Canvas 1.0 + 乐观并发），
 *   这里只**读**它（宿主侧唯一真源是 `state.canvasGraph` 那个仓库）。
 */

import { graphDigest } from './canvasGraph.js';

/** 画布页路由前缀（与 `lib/index.js` 的 ROUTE_PREFIX 同值）。 */
export const CANVAS_ROUTE_PREFIX = '/x/imagegen';
/** 画布页本体（HTML）。 */
export const CANVAS_PAGE_ROUTE = '/x/imagegen/canvas/';
/** 「最近出图」列表（画布页轮询；?since=<毫秒时间戳>）。 */
export const CANVAS_IMAGES_ROUTE = '/x/imagegen/api/canvas-images';
/** 单张图的字节（画布页拿到元信息后按 id 取）。 */
export const CANVAS_IMAGE_ROUTE = '/x/imagegen/api/canvas-image';
/** 画布状态（画布页 → 宿主：POST 推；宿主 → 画布页：GET 拉）。 */
export const CANVAS_STATE_ROUTE = '/x/imagegen/api/canvas-state';
/** 节点图状态（节点工作流模式专用；与自由绘制的场景是两条独立通道）。 */
export const CANVAS_GRAPH_ROUTE = '/x/imagegen/api/canvas-graph';
/** 导出 JSON Canvas 1.0（GET）。 */
export const CANVAS_GRAPH_EXPORT_ROUTE = '/x/imagegen/api/canvas-graph/export';
/** 导入 JSON Canvas 1.0（POST）。 */
export const CANVAS_GRAPH_IMPORT_ROUTE = '/x/imagegen/api/canvas-graph/import';

/** 摘要里最多列多少个对象（再多对模型没用，只占 token）。 */
const DIGEST_ELEMENT_LIMIT = 40;
/** 节点明细最多列多少条（与上游同口径：24 条 + "+N more"）。 */
const DIGEST_NODE_LIMIT = 24;
/** 每条明细里的文字最多留多少字。 */
const DIGEST_LABEL_LIMIT = 40;

/** Excalidraw 元素类型 → 中文名（模型看得懂就行）。 */
const KIND_NAMES = {
	rectangle: '矩形',
	ellipse: '椭圆',
	diamond: '菱形',
	arrow: '箭头',
	line: '线',
	freedraw: '手绘',
	text: '文字',
	image: '图片',
	frame: '画框',
	embeddable: '嵌入',
};

/**
 * 元素 → 一行明细。
 * @param {object} element Excalidraw 元素
 * @param {(fileId: string) => { prompt?: string } | undefined} imageLookup 按 fileId 查溯源
 */
function nodeLine(element, imageLookup) {
	const type = String(element?.type ?? 'other');
	const kind = KIND_NAMES[type] ?? type;
	const width = Math.round(Number(element?.width) || 0);
	const height = Math.round(Number(element?.height) || 0);
	const size = width > 0 ? ` ${width}×${height}` : '';
	let label = kind + size;
	if (type === 'text' && typeof element?.text === 'string' && element.text.trim()) {
		const text = element.text.trim().replace(/\s+/g, ' ');
		label = kind + '「' + text.slice(0, DIGEST_LABEL_LIMIT) + '」';
	}
	// 图片：附上"这张图是怎么来的"（出图时的提示词）—— 需要宿主侧能按 fileId 反查。
	if (type === 'image' && typeof element?.fileId === 'string') {
		const found = imageLookup ? imageLookup(element.fileId) : undefined;
		const prompt = typeof found?.prompt === 'string' ? found.prompt.trim() : '';
		if (prompt) {
			label += '（提示词：' + prompt.replace(/\s+/g, ' ').slice(0, DIGEST_LABEL_LIMIT) + '）';
		}
	}
	return label;
}

/**
 * 场景 → 节点明细清单（≤24 条）。
 * @param {object[] | undefined} elements
 * @param {(fileId: string) => { prompt?: string } | undefined} imageLookup
 * @returns {{ lines: string[], omitted: number }}
 */
function summarizeNodes(elements, imageLookup) {
	const list = Array.isArray(elements) ? elements.filter(el => el && el.isDeleted !== true) : [];
	const shown = list.slice(0, DIGEST_NODE_LIMIT);
	return {
		lines: shown.map(el => nodeLine(el, imageLookup)),
		omitted: Math.max(0, list.length - shown.length),
	};
}

/** 一个画布实例的状态。 */
class CanvasEntry {
	constructor(push, imageLookup, graphStore) {
		this.clientInstance = String(push?.clientInstance ?? '');
		this.sequence = Number(push?.sequence ?? 0);
		this.updatedAt = Number(push?.updatedAt ?? Date.now());
		this.elementCount = Number(push?.elementCount ?? 0);
		this.selectedIds = Array.isArray(push?.selectedIds) ? push.selectedIds.map(String) : [];
		this.selection = Array.isArray(push?.selection) ? push.selection.map(String) : [];
		this.selectionPng = typeof push?.selectionPng === 'string' ? push.selectionPng : undefined;
		// 选区截图三态：'preparing' 还在导出 / 'ready' 可用 / 'error' 导出失败（带原因）。
		this.selectionStatus = typeof push?.selectionStatus === 'string' ? push.selectionStatus : undefined;
		this.selectionError = typeof push?.selectionError === 'string' ? push.selectionError : undefined;
		// 选区里的**原图**（dataURL，fileId → dataURL）——「按选区改图」要拿它当参考图。
		this.selectionFiles = (push?.selectionFiles && typeof push.selectionFiles === 'object') ? push.selectionFiles : {};
		this.scene = push?.scene && typeof push.scene === 'object' ? push.scene : undefined;
		this.sceneOmitted = push?.sceneOmitted === true;
		this.nodes = summarizeNodes(this.scene?.elements, imageLookup);
		// ★ 节点工作流模式：画布有两种形态（free / graph）⇒ 摘要按模式说。
		this.mode = push?.mode === 'graph' ? 'graph' : 'free';
		/** 节点模式下"当前选中的节点 id"（自由绘制模式没有这个概念）。 */
		this.selectedNodeId = typeof push?.selectedNodeId === 'string' ? push.selectedNodeId : '';
		/** 节点图的**真源**在宿主（`state.canvasGraph`）⇒ 这里只拿引用，不另存一份。 */
		this.graphStore = graphStore;
	}

	/**
	 * 当前节点图（宿主侧真源；没有仓库时是空图）。
	 * @returns {{nodes: object[], edges: object[]}}
	 */
	graph() {
		if (this.graphStore && typeof this.graphStore.get === 'function') {
			return this.graphStore.get();
		}
		return { nodes: [], edges: [] };
	}

	/**
	 * 选区里的**原图**（dataURL）——「按选区改图」的参考图。
	 * @returns {string | undefined} 没有选中原图时是 undefined（调用方要如实报错，不要自己编一张）
	 */
	selectionImage() {
		for (const value of Object.values(this.selectionFiles)) {
			if (typeof value === 'string' && value.startsWith('data:')) { return value; }
		}
		return undefined;
	}

	/**
	 * ★ 2026-10-21（二批⑥）：选区该用哪张图当参考图 —— **"能用原图就别用截图"**。
	 *
	 * 规则（与上游 `canvas-tools.ts` 的优先级同口径）：
	 *   ① 选区**只有图片**（选中数 = 原图数）⇒ 用**原图**（原分辨率，不降质）✓
	 *   ② 选区**只有一张图**时用原图；有多张图而图像服务一次只吃一张参考图
	 *      ⇒ 有整选区截图就用截图（能看到多张图的构图），没有就退回第一张原图；
	 *   ③ 选区**混了非图片元素**（图 + 矩形/文字）⇒ 用**整选区截图**
	 *      （要保留构图，原图里没有那些元素）⇒ 并在 note 里说清原因。
	 *
	 * ⚠ 为什么不返回"多张原图"：provider 的图生图契约**一次只吃一张参考图**
	 *   （`IImageGenParams.imageInput` 是单数）⇒ 扩容要动 IDE 侧 6 个文件 ⇒ 列为后续批次。
	 *
	 * @returns {{kind:'original'|'screenshot'|'none', dataUrl?:string, fileId?:string, note:string}}
	 */
	selectionReference() {
		const imageIds = Object.keys(this.selectionFiles).filter(id => {
			const value = this.selectionFiles[id];
			return typeof value === 'string' && value.startsWith('data:');
		});
		const selectedCount = this.selectedIds.length;
		if (imageIds.length === 0) {
			return { kind: 'none', note: '选区里没有图片' };
		}
		if (imageIds.length === selectedCount) {
			// 选区**全是图** ⇒ 原图优先（原分辨率，不降质）。
			if (imageIds.length === 1) {
				return {
					kind: 'original',
					dataUrl: this.selectionFiles[imageIds[0]],
					fileId: imageIds[0],
					note: '选区只有一张图 ⇒ 参考图用的是原图（原分辨率，没降质）',
				};
			}
			if (this.selectionPng) {
				return {
					kind: 'screenshot',
					dataUrl: this.selectionPng,
					note: '选区里有 ' + imageIds.length + ' 张图，而图像服务一次只吃一张参考图 ⇒ 参考图用的是整选区截图',
				};
			}
			return {
				kind: 'original',
				dataUrl: this.selectionFiles[imageIds[0]],
				fileId: imageIds[0],
				note: '选区里有 ' + imageIds.length + ' 张图、整选区截图还没导出来 ⇒ 参考图用的是第一张原图',
			};
		}
		// 混合选区 ⇒ 整选区截图（构图在原图里没有）。
		if (this.selectionPng) {
			return {
				kind: 'screenshot',
				dataUrl: this.selectionPng,
				note: '选区里混了非图片元素（要保留构图）⇒ 参考图用的是整选区截图',
			};
		}
		return { kind: 'none', note: '选区里混了非图片元素，而整选区截图还没导出来' };
	}

	/** 人话摘要（给 `canvas_state` / `view_canvas` 用）。 */
	digest(now = Date.now()) {
		const age = Math.max(0, Math.round((now - this.updatedAt) / 1000));
		const ageText = age < 5 ? '刚刚' : age < 90 ? `${age} 秒前` : `${Math.round(age / 60)} 分钟前`;
		const lines = [];
		const isGraph = this.mode === 'graph';
		lines.push(isGraph
			? `画布当前在**节点工作流**模式（${ageText}更新）。`
			: `画布上有 ${this.elementCount} 个对象（${ageText}更新）。`);
		if (isGraph) {
			// ① 节点模式：说节点 + 连线（自由绘制那套"对象明细"在这里不适用）。
			lines.push(...graphDigest(this.graph()));
			if (this.selectedNodeId) {
				const picked = this.graph().nodes.find(node => node.id === this.selectedNodeId);
				const title = picked ? (picked.label || picked.prompt || picked.text || picked.id) : this.selectedNodeId;
				lines.push(`用户当前选中的节点：${this.selectedNodeId}「${String(title).slice(0, 40)}」。`);
			}
		} else {
			// ① 节点明细：模型要知道画布上**具体**有什么（只给"3 个对象"是不够的）。
			if (this.nodes.lines.length > 0) {
				lines.push('明细：');
				this.nodes.lines.forEach((line, index) => { lines.push(`  ${index + 1}. ${line}`); });
				if (this.nodes.omitted > 0) { lines.push(`  …… 还有 ${this.nodes.omitted} 个没列出来。`); }
			} else if (this.sceneOmitted) {
				lines.push('（场景太大，明细没传过来——只知道对象数量。）');
			}
		}
		// ② 选区：三态要说清（preparing ≠ 没有截图）。
		if (isGraph) {
			// 节点模式没有"选区"概念 ⇒ 只说一句"去哪改"（具体"选中的是节点不是对象"由 view_canvas 说，勿重复 ✗）。
			lines.push('（节点模式下没有"选区截图"这回事——改节点参数在画布页右侧面板，跑图用 canvas_run。）');
		} else if (this.selectedIds.length > 0) {
			lines.push(`用户当前选中了 ${this.selectedIds.length} 个：${this.selection.join('、') || '（无描述）'}。`);
			const status = this.selectionStatus;
			if (status === 'preparing') {
				lines.push('选区截图**还在导出中**（稍等一下再调 view_canvas）——先用上面的文字描述。');
			} else if (status === 'error') {
				lines.push('选区截图导出失败：' + String(this.selectionError || '原因不明') + '——先用上面的文字描述。');
			} else if (this.selectionPng) {
				lines.push('选区截图已附带（view_canvas 可直接看到）。');
			} else {
				lines.push('选区截图暂不可用（画布还没导出）——先用上面的文字描述。');
			}
		} else {
			lines.push('用户当前没有选中任何对象（要针对某个东西改，先让用户在画布上选中它）。');
		}
		return lines.join('\n');
	}
}

/**
 * 画布镜像：按实例存，取"最后活跃"的那块。
 * 旧实例的乱序推送会被 `sequence` 挡住（重连/回滚时不会用旧状态覆盖新状态）。
 * @param {object} [options]
 * @param {(fileId: string) => { prompt?: string } | undefined} [options.imageLookup] 按 fileId 查图的溯源
 * @param {{get: () => object}} [options.graphStore] 节点图真源（宿主侧仓库；摘要要读它）
 */
export function createCanvasMirror({ imageLookup, graphStore } = {}) {
	/** @type {Map<string, CanvasEntry>} */
	const entries = new Map();
	return {
		/** 收一次推送；返回 true = 已应用。 */
		apply(push) {
			const clientInstance = String(push?.clientInstance ?? '').trim();
			if (!clientInstance) { return false; }
			const previous = entries.get(clientInstance);
			const sequence = Number(push?.sequence ?? 0);
			// 序号不大于已收的 ⇒ 旧消息（重连补发/乱序）⇒ 忽略。
			if (previous && sequence <= previous.sequence) { return false; }
			entries.set(clientInstance, new CanvasEntry(push, imageLookup, graphStore));
			return true;
		},
		/** 最后活跃的那块（没有则 undefined）。 */
		latest() {
			let best;
			for (const entry of entries.values()) {
				// ⚠ 同一毫秒内两次推送（时间戳相同）⇒ 用 **sequence** 再比一次
				//   （否则会一直拿到先推的那块 ⇒ 模型看到的画布是旧的 ✗）。
				if (!best
					|| entry.updatedAt > best.updatedAt
					|| (entry.updatedAt === best.updatedAt && entry.sequence > best.sequence)) {
					best = entry;
				}
			}
			return best;
		},
		/** 有没有任何画布连着。 */
		connected() { return entries.size > 0; },
		/** 清掉（画布页关闭/测试用）。 */
		clear() { entries.clear(); },
		/** 条数（诊断用）。 */
		size() { return entries.size; },
	};
}
