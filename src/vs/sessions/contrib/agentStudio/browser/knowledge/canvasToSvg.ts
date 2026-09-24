/*---------------------------------------------------------------------------------------------
 *  canvasToSvg.ts — JSON Canvas（.canvas）→ SVG 字符串（**纯函数**，无 DOM、无 IO）—— 2026-09-24
 *
 *  用途：飞书同步前把 `![[x.canvas]]` 嵌入转成图片（SVG → `svgToPng` 栅格化 → PNG 附件）。
 *  与 webview 预览侧的 CanvasMiniView（React DOM 渲染）是**两套实现、同一份数据**：
 *  DOM 渲染无法直接栅格化（html2canvas 之类不可用），所以同步侧用这份纯 SVG 生成器。
 *
 *  数据口径（与 kbMindmapGenerator 产出 + JSON Canvas 规范对齐）：
 *   · nodes: { id, type?, x, y, width, height, text?/content?/label?, file?, color? }
 *     （规范用 `text`；本项目思维导图生成器用 `content`，首行为标题）
 *   · edges: { fromNode, toNode, label? }
 *   · color：JSON Canvas 预设 "1"~"6" 或 `#rrggbb`；未知值按默认色
 *--------------------------------------------------------------------------------------------*/

export interface ICanvasToSvgOptions {
	/** 四周留白，默认 24 */
	padding?: number;
	/** 节点字号，默认 14 */
	fontSize?: number;
	/** 背景色，默认 '#ffffff'（栅格化成 PNG 后白底在飞书里效果最好） */
	background?: string;
}

/** JSON Canvas 预设色（Obsidian 口径） */
const PRESET_COLORS: Record<string, string> = {
	'1': '#e03131', // red
	'2': '#e8590c', // orange
	'3': '#f08c00', // yellow
	'4': '#2f9e44', // green
	'5': '#1971c2', // blue
	'6': '#9c36b5', // purple
};

const DEFAULT_NODE_FILL = '#ffffff';
const DEFAULT_NODE_STROKE = '#666666';

function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface INode {
	id?: string;
	x?: number; y?: number; width?: number; height?: number;
	text?: string; content?: string; label?: string; file?: string; color?: string;
}
interface IEdge { fromNode?: string; toNode?: string; label?: string }

function nodeText(n: INode): string {
	const raw = n.text ?? n.content ?? n.label ?? (n.file ? String(n.file).split(/[\\/]/).pop() ?? '' : '');
	// 思维导图约定「首行为标题」；其余行作为次行小字（最多再取 2 行，避免 SVG 里塞长文）
	return raw.trim();
}

function nodeColor(n: INode): { fill: string; stroke: string } {
	const c = (n.color ?? '').trim();
	if (!c) { return { fill: DEFAULT_NODE_FILL, stroke: DEFAULT_NODE_STROKE }; }
	if (/^#[0-9a-f]{3,8}$/i.test(c)) { return { fill: '#ffffff', stroke: c }; }
	const preset = PRESET_COLORS[c];
	if (preset) { return { fill: '#ffffff', stroke: preset }; }
	return { fill: DEFAULT_NODE_FILL, stroke: DEFAULT_NODE_STROKE };
}

/**
 * JSON Canvas 文本 → SVG 字符串。
 *
 * @throws JSON 非法 / 无有效节点（调用方把它当「转换失败，保留原文」处理）
 */
export function canvasToSvg(jsonText: string, opts: ICanvasToSvgOptions = {}): string {
	const pad = opts.padding ?? 24;
	const fontSize = opts.fontSize ?? 14;
	const background = opts.background ?? '#ffffff';

	let parsed: { nodes?: INode[]; edges?: IEdge[] };
	try {
		parsed = JSON.parse(jsonText);
	} catch (err) {
		throw new Error(`canvas 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
	}
	const nodes = (Array.isArray(parsed.nodes) ? parsed.nodes : [])
		.filter(n => n && typeof n === 'object');
	if (nodes.length === 0) { throw new Error('canvas 无有效节点'); }
	const edges = (Array.isArray(parsed.edges) ? parsed.edges : [])
		.filter(e => e && typeof e === 'object');

	const x0 = Math.min(...nodes.map(n => n.x ?? 0));
	const y0 = Math.min(...nodes.map(n => n.y ?? 0));
	const x1 = Math.max(...nodes.map(n => (n.x ?? 0) + (n.width ?? 180)));
	const y1 = Math.max(...nodes.map(n => (n.y ?? 0) + (n.height ?? 72)));
	const w = Math.max(1, x1 - x0 + pad * 2);
	const h = Math.max(1, y1 - y0 + pad * 2);

	const byId = new Map(nodes.filter(n => n.id).map(n => [n.id as string, n]));
	const cx = (n: INode) => (n.x ?? 0) - x0 + pad + (n.width ?? 180) / 2;
	const cy = (n: INode) => (n.y ?? 0) - y0 + pad + (n.height ?? 72) / 2;

	const parts: string[] = [];
	parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="sans-serif">`);
	parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="${esc(background)}"/>`);
	parts.push(`<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#888888"/></marker></defs>`);

	for (const e of edges) {
		const a = e.fromNode ? byId.get(e.fromNode) : undefined;
		const b = e.toNode ? byId.get(e.toNode) : undefined;
		if (!a || !b) { continue; }
		parts.push(`<line x1="${cx(a)}" y1="${cy(a)}" x2="${cx(b)}" y2="${cy(b)}" stroke="#888888" stroke-width="1.5" marker-end="url(#arrow)"/>`);
		if (e.label) {
			parts.push(`<text x="${(cx(a) + cx(b)) / 2}" y="${(cy(a) + cy(b)) / 2 - 4}" font-size="${fontSize - 3}" fill="#666666" text-anchor="middle">${esc(e.label)}</text>`);
		}
	}

	for (const n of nodes) {
		const nx = (n.x ?? 0) - x0 + pad;
		const ny = (n.y ?? 0) - y0 + pad;
		const nw = n.width ?? 180;
		const nh = n.height ?? 72;
		const { fill, stroke } = nodeColor(n);
		parts.push(`<rect x="${nx}" y="${ny}" width="${nw}" height="${nh}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`);
		const lines = nodeText(n).split('\n').filter(Boolean).slice(0, 3);
		const lineH = fontSize + 4;
		const startY = ny + nh / 2 - ((lines.length - 1) * lineH) / 2 + fontSize * 0.35;
		lines.forEach((line, i) => {
			const weight = i === 0 ? ' font-weight="600"' : ' opacity="0.75"';
			const size = i === 0 ? fontSize : fontSize - 2;
			parts.push(`<text x="${nx + nw / 2}" y="${startY + i * lineH}" font-size="${size}" fill="#222222" text-anchor="middle"${weight}>${esc(line)}</text>`);
		});
	}

	parts.push('</svg>');
	return parts.join('');
}
