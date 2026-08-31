/**
 * drawio 内联只读预览渲染 bundle（隐藏 webview 内运行）
 * ----------------------------------------------------------------
 * 对称 extensions/mermaid-chat-features/chat-webview-src/index-render-inline.ts，
 * 但本 bundle 复用 Agent Studio webview 已有的 @maxgraph/core + drawioSerializer 依赖，
 * 把 mxGraphModel XML 解析为带坐标的节点后，用 maxGraph 直接渲染进 container，
 * 再序列化 SVG 回传给宿主进程（drawioInlineRenderer）。
 *
 * 消息协议（与 mermaid 一致）：
 *   - webview 启动后 postMessage({ type: 'ready' })
 *   - 宿主收 ready 后 postMessage({ type: 'render', requestId, source, theme })
 *   - webview 渲染完成后 postMessage({ type: 'rendered', requestId, svg, error? })
 */

import { Graph, type Cell } from '@maxgraph/core';
import { fromDrawio } from './drawioSerializer.js';

// VS Code webview API：用于向宿主进程 postMessage（隐藏 webview 内直接用原生 API）
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = acquireVsCodeApi();

// 暗色主题下的 SVG 底色（透明背景，由宿主容器控制）
const DARK_BG = 'transparent';
const LIGHT_BG = 'transparent';

// 渲染节点样式：圆角矩形 + 浅色描边，对齐 mindmap 的只读风格
const DRAWIO_STYLE: any = {
	rounded: true,
	whiteSpace: 'wrap',
	html: 1,
	fillColor: '#FFFFFF',
	strokeColor: '#94A3B8',
	fontColor: '#0F172A',
	fontSize: 12,
};

/**
 * 创建隐藏渲染用的 maxGraph 实例。
 * 仅用于把图渲染进 container 的 <svg>，不参与交互/布局。
 */
function createRenderGraph(container: HTMLElement): Graph {
	const graph = new Graph(container);
	graph.setCellsSelectable(false);
	graph.setCellsMovable(false);
	graph.setCellsResizable(false);
	graph.setPanning(false);
	graph.setTooltips(false);
	graph.setEnabled(false); // 纯只读渲染
	// 关闭网格与握手，避免杂乱背景
	(graph as any).setGridEnabled?.(false);
	(graph as any).gridEnabled = false;
	container.style.background = 'transparent';
	return graph;
}

/**
 * 用 fromDrawio 解析 mxGraphModel XML（drawio .drawio 文本），
 * 把带坐标的顶点与边插入 maxGraph。
 * 尺寸按 drawioSerializer 的约定估算（图片节点 220×120，文字节点 200×56）。
 */
function insertNodes(graph: Graph, source: string): void {
	const model = fromDrawio(source ?? '');
	const positions = model.positions;
	const parent = graph.getDefaultParent();
	graph.batchUpdate(() => {
		const cellById = new Map<string, Cell>();
		for (const node of model.nodes) {
			const pos = positions[node.id] ?? { x: 0, y: 0 };
			const hasImage = !!(node.imageRefs && node.imageRefs.length);
			const w = hasImage ? 220 : 200;
			const h = hasImage ? 120 : 56;
			const cell = graph.insertVertex(
				parent,
				null,
				node.title,
				pos.x,
				pos.y,
				w,
				h,
				DRAWIO_STYLE,
			);
			cellById.set(node.id, cell);
		}
		for (const node of model.nodes) {
			if (!node.parentId) { continue; }
			const src = cellById.get(node.parentId);
			const tgt = cellById.get(node.id);
			if (!src || !tgt) {
				continue;
			}
			graph.insertEdge(parent, null, '', src, tgt, {
				strokeColor: '#64748B',
				rounded: true,
			});
		}
	});
}

/**
 * 序列化 maxGraph 渲染出的 SVG。
 * maxGraph 会把图渲染进 container 内自动创建的 <svg> 元素。
 */
function serializeSvg(container: HTMLElement): string | null {
	const svg = container.querySelector('svg');
	if (!svg) {
		return null;
	}
	try {
		return new window.XMLSerializer().serializeToString(svg);
	} catch {
		return svg.outerHTML;
	}
}

let activeContainer: HTMLElement | null = null;
let activeGraph: Graph | null = null;

function renderOnce(source: string, theme: 'dark' | 'default'): string {
	// 复用单一 container，避免反复创建 webview DOM
	if (!activeContainer) {
		activeContainer = document.createElement('div');
		activeContainer.style.position = 'fixed';
		activeContainer.style.left = '-9999px';
		activeContainer.style.top = '-9999px';
		activeContainer.style.width = '1200px';
		activeContainer.style.height = '900px';
		activeContainer.style.overflow = 'hidden';
		document.body.appendChild(activeContainer);
		activeGraph = createRenderGraph(activeContainer);
	}

	const graph = activeGraph!;
	const container = activeContainer!;
	container.style.background = theme === 'dark' ? DARK_BG : LIGHT_BG;

	// 清空上一次渲染
	graph.batchUpdate(() => {
		const parent = graph.getDefaultParent();
		graph.removeCells(parent.getChildCells(true, true));
	});

	insertNodes(graph, source);
	// 强制一次刷新，确保 SVG 已生成
	graph.refresh();
	graph.sizeDidChange?.();

	const svg = serializeSvg(container);
	if (!svg) {
		throw new Error('drawio 渲染失败：maxGraph 未生成 SVG');
	}
	return svg;
}

window.addEventListener('message', (event: MessageEvent) => {
	const msg = event.data;
	if (!msg || msg.type !== 'render') {
		return;
	}
	const { requestId, source, theme } = msg;
	try {
		const svg = renderOnce(source ?? '', theme === 'dark' ? 'dark' : 'default');
		vscode.postMessage({ type: 'rendered', requestId, svg });
	} catch (err) {
		vscode.postMessage({
			type: 'rendered',
			requestId,
			svg: null,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

// 通知宿主：bundle 已就绪
vscode.postMessage({ type: 'ready' });
