/*---------------------------------------------------------------------------------------------
 *  canvasToMermaid.ts — JSON Canvas（.canvas）→ **Mermaid 源码**（纯函数，无 DOM、无 IO）—— 2026-10-19
 *
 *  为什么要有这一层：全项目的图表渲染统一到 **pele**（`IDiagramRenderer`），而 pele 的输入契约
 *  是 Mermaid 源码文本。`.canvas` 是 JSON Canvas（节点 + 边 + 绝对坐标），pele 吃不下 ⇒
 *  先把 JSON Canvas **转译成 Mermaid**，再交给 pele 渲染。
 *
 *  取代了原来的 `canvasToSvg.ts`（自己拼 `<rect>/<line>` 的纯函数）。换掉的收益：
 *    · 只有**一个**渲染引擎 ⇒ 画布/思维导图与 mermaid 图的观感、主题（浅/深）完全一致；
 *    · 不再有两套实现（同步侧 canvasToSvg / 预览侧 CanvasMiniView）各自漂移的问题。
 *
 *  ⚠ 代价（**必须知道**）：Mermaid 由引擎自己排版，**JSON Canvas 里的绝对坐标 x/y 会被丢弃**。
 *    对思维导图（`mindmap: true`）无所谓——它本来就是布局引擎算的；对手工摆位的自由画布，
 *    同步出去的 PNG 会是**重排后的样子**。这是"统一到 pele"的必要代价，不是 bug。
 *
 *  两个图种的取舍（pele 实测，见 dsh-plugins/vssaros-pele/test/run-pele-check.mjs 第 4 组）：
 *    · `mindmap`：只能有**一个根**（多根直接报 `There can be only one root` ✗）
 *      ⇒ 只有当边构成一棵树（单根、每节点至多一个父、无环、全可达）时才用；
 *    · 其余（森林 / 有向图 / 孤立节点 / 有环）一律 `flowchart TD`，它什么形状都吃得下 ✓。
 *--------------------------------------------------------------------------------------------*/

export type CanvasMermaidKind = 'mindmap' | 'flowchart';

export interface ICanvasToMermaidResult {
	readonly kind: CanvasMermaidKind;
	/** 可直接喂给 `IDiagramRenderer.renderToSvg()` 的 Mermaid 源码 */
	readonly source: string;
}

interface ICanvasNode {
	id?: string;
	type?: string;
	x?: number; y?: number; width?: number; height?: number;
	/** JSON Canvas 规范用 `text`；本项目思维导图生成器用 `content`（首行为标题） */
	text?: string; content?: string; label?: string; file?: string;
	color?: string;
}
interface ICanvasEdge { id?: string; fromNode?: string; toNode?: string; label?: string }

/** 节点显示文本：与旧 canvasToSvg 同口径（text / content / label / file 的 basename）。 */
function rawText(n: ICanvasNode): string {
	if (typeof n.text === 'string' && n.text.trim()) { return n.text; }
	if (typeof n.content === 'string' && n.content.trim()) { return n.content; }
	if (typeof n.label === 'string' && n.label.trim()) { return n.label; }
	if (typeof n.file === 'string' && n.file.trim()) {
		return n.file.split(/[\\/]/).pop() ?? '';
	}
	return '';
}

/**
 * Mermaid 标签转义。
 *
 * `"` 必须转成 `#quot;`：节点标签在 `["…"]` 里，裸引号会提前闭合 ✗（pele 实测可渲染 ✓）。
 * `|` 会破坏边标签 `-->|…|` ⇒ 直接去掉。换行压成空格（mermaid 单行标签不支持裸换行）。
 */
function escapeLabel(text: string): string {
	return text
		.replace(/[\r\n]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/"/g, '#quot;')
		.replace(/\|/g, '');
}

/**
 * JSON Canvas 文本 → Mermaid 源码。
 *
 * @throws JSON 非法 / 无有效节点（调用方按「转换失败，保留原文」处理 —— 与旧 canvasToSvg 同契约）
 */
export function canvasToMermaidSource(jsonText: string): ICanvasToMermaidResult {
	let parsed: { nodes?: ICanvasNode[]; edges?: ICanvasEdge[]; mindmap?: boolean };
	try {
		parsed = JSON.parse(jsonText);
	} catch (err) {
		throw new Error(`canvas 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
	}
	const nodes = (Array.isArray(parsed.nodes) ? parsed.nodes : [])
		.filter((n): n is ICanvasNode => !!n && typeof n === 'object');
	if (nodes.length === 0) { throw new Error('canvas 无有效节点'); }
	const edges = (Array.isArray(parsed.edges) ? parsed.edges : [])
		.filter((e): e is ICanvasEdge => !!e && typeof e === 'object');

	// 节点 id 一律换成 n0/n1/…：原 id 可能是 UUID / 中文 / 带空格，直接当 mermaid id 会语法错 ✗。
	const idOf = new Map<ICanvasNode, string>();
	const labels: string[] = [];
	nodes.forEach((n, i) => {
		idOf.set(n, `n${i}`);
		const raw = escapeLabel(rawText(n).split('\n')[0] ?? '');
		// 空标签会让 `n0[""]` 直接语法错（pele 实测）⇒ 退回原 id，再退回序号 ✗
		labels.push(raw || escapeLabel(String(n.id ?? '')) || `n${i}`);
	});

	const indexOf = new Map<string, number>();
	nodes.forEach((n, i) => { if (n.id) { indexOf.set(n.id, i); } });

	interface ILink { from: number; to: number; label: string }
	const seen = new Set<string>();
	const links: ILink[] = [];
	for (const e of edges) {
		const a = e.fromNode ? indexOf.get(e.fromNode) : undefined;
		const b = e.toNode ? indexOf.get(e.toNode) : undefined;
		if (a === undefined || b === undefined || a === b) { continue; } // 自环跳过（mermaid 画出来也是个点）
		const key = `${a}>${b}`;
		if (seen.has(key)) { continue; }
		seen.add(key);
		links.push({ from: a, to: b, label: escapeLabel(typeof e.label === 'string' ? e.label : '') });
	}

	// ★ 只有**显式标了 `mindmap: true`** 的画布才走 mindmap 图种（kbMindmapGenerator 会写这个标记）。
	//   为什么不让"碰巧是树"的普通画布也变 mindmap：那会把用户手工摆位的自由画布突然变成放射状
	//   思维导图（观感突变）；而 flowchart TD 画树本来就很好看 ⇒ 不标就不变 ✓。
	if (parsed.mindmap === true) {
		const tree = buildMindmapSource(nodes.length, links, labels);
		if (tree) { return { kind: 'mindmap', source: tree }; }
		// 标了 mindmap 但边不是树（多根 / 有环 / 有孤立点）⇒ 硬出 mindmap 会直接报错
		// （pele: `There can be only one root` ✗）⇒ 退回 flowchart（画得出来比画不出来重要 ✓）。
	}
	return { kind: 'flowchart', source: buildFlowchartSource(labels, links) };
}

/**
 * 边是否构成「恰好一个根 + 每节点至多一个父 + 无环 + 全可达」的树。
 *
 * 判定方法：入度统计 + 从唯一根做一次 BFS， visited 数 === 节点数 ⇒ 无环且全可达 ✓
 * （有环时环上节点入度虽为 1，但从根 BFS 到不了 ⇒ visited 少 ⇒ 判否 ✓）。
 */
function isForestRooted(nodeCount: number, links: readonly { from: number; to: number }[]): boolean {
	const indeg = new Array<number>(nodeCount).fill(0);
	const children = new Map<number, number[]>();
	for (const l of links) {
		indeg[l.to]++;
		if (indeg[l.to] > 1) { return false; }
		const list = children.get(l.from);
		if (list) { list.push(l.to); } else { children.set(l.from, [l.to]); }
	}
	const roots: number[] = [];
	for (let i = 0; i < nodeCount; i++) { if (indeg[i] === 0) { roots.push(i); } }
	if (roots.length !== 1) { return false; }

	const visited = new Set<number>([roots[0]]);
	const queue = [roots[0]];
	while (queue.length) {
		const cur = queue.shift() as number;
		for (const c of children.get(cur) ?? []) {
			if (visited.has(c)) { return false; }
			visited.add(c);
			queue.push(c);
		}
	}
	return visited.size === nodeCount;
}

/** 树 → `mindmap` 源码（缩进 = 层级，每层 2 空格；根节点必须唯一 ✓）。 */
function buildMindmapSource(nodeCount: number, links: readonly { from: number; to: number }[], labels: readonly string[]): string | undefined {
	if (!isForestRooted(nodeCount, links)) { return undefined; }
	const children = new Map<number, number[]>();
	const indeg = new Array<number>(nodeCount).fill(0);
	for (const l of links) {
		indeg[l.to]++;
		const list = children.get(l.from);
		if (list) { list.push(l.to); } else { children.set(l.from, [l.to]); }
	}
	const root = indeg.findIndex(v => v === 0);
	if (root < 0) { return undefined; }

	const lines = ['mindmap'];
	const walk = (node: number, depth: number): void => {
		// ⚠ 不加 `(())` / `[]` 之类形状标记：实测纯文本最稳（带标记在部分图种下会解析失败）
		lines.push(`${'  '.repeat(depth)}${labels[node]}`);
		for (const c of children.get(node) ?? []) { walk(c, depth + 1); }
	};
	walk(root, 1);
	return lines.join('\n');
}

/** 任意形状（森林 / 环 / 孤立点）→ `flowchart TD` 源码。 */
function buildFlowchartSource(labels: readonly string[], links: readonly { from: number; to: number; label: string }[]): string {
	const lines = ['flowchart TD'];
	labels.forEach((label, i) => { lines.push(`  n${i}["${label}"]`); });
	for (const l of links) {
		lines.push(l.label
			? `  n${l.from} -->|${l.label}| n${l.to}`
			: `  n${l.from} --> n${l.to}`);
	}
	return lines.join('\n');
}
