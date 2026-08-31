/*---------------------------------------------------------------------------------------------
 *  drawioSerializer — 思维导图 ↔ drawio (.drawio / mxGraphModel) 互转。
 *
 *  目标：导出的 .drawio 文件可被「飞书思维笔记」直接读取（飞书导入 xmind/opml/
 *  drawio 等主流脑图格式）。采用 mxGraphModel 通用结构：
 *    - 每个主题节点 = 一个 mxCell（vertex），value = 标题，含几何信息。
 *    - 父子关系 = 一个 mxCell（edge），source/target 指向顶点 id。
 *    - 图片节点：value 内嵌 <img> 或把 imageRef 写在属性里（飞书读图能力有限，
 *      这里以 `imageRefs` 属性 + `<img>` 标签双写，最大化兼容）。
 *
 *  解析用 DOMParser，序列化用手写 XML（避免引入依赖；结构稳定且易审计）。
 *--------------------------------------------------------------------------------------------*/

import type { MindMapNodeData } from './radialLayout';

export interface MindMapDoc {
	nodes: MindMapNodeData[];
	/** 节点 id → 布局坐标（graph 单位，左上角）。 */
	positions: Record<string, { x: number; y: number }>;
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>\n';

function escapeXml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function escapeAttr(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 导出为 .drawio 文本（mxGraphModel）。
 * 图片节点 value 内嵌 `<img src="...">`（src 为 data: 或 http(s): 链接）。
 */
export function toDrawio(doc: MindMapDoc): string {
	const cellLines: string[] = [];
	cellLines.push(
		'\t\t<mxCell id="0" />',
		'\t\t<mxCell id="1" parent="0" />',
	);

	const posOf = (id: string): { x: number; y: number } => doc.positions[id] ?? { x: 0, y: 0 };

	for (const n of doc.nodes) {
		const p = posOf(n.id);
		const w = n.imageRefs && n.imageRefs.length ? 220 : 200;
		const h = n.imageRefs && n.imageRefs.length ? 120 : 56;
		const value = n.imageRefs && n.imageRefs.length
			? `${escapeXml(n.title)}<br/><img src="${escapeAttr(n.imageRefs[0])}" width="160" height="90"/>`
			: escapeXml(n.title);
		const imgAttr = n.imageRefs && n.imageRefs.length
			? ` imageRefs="${escapeAttr(n.imageRefs.join(','))}"`
			: '';
		const noteAttr = n.note ? ` note="${escapeAttr(n.note)}"` : '';
		cellLines.push(
			`\t\t<mxCell id="${escapeAttr(n.id)}" value="${value}" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">` +
			`<mxGeometry x="${Math.round(p.x)}" y="${Math.round(p.y)}" width="${w}" height="${h}" as="geometry"/>` +
			`</mxCell>${imgAttr}${noteAttr}`.replace(/></g, '>'),
		);
	}

	for (const n of doc.nodes) {
		if (n.parentId) {
			cellLines.push(
				`\t\t<mxCell id="e_${escapeAttr(n.id)}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;" edge="1" ` +
				`parent="1" source="${escapeAttr(n.parentId)}" target="${escapeAttr(n.id)}">` +
				`<mxGeometry relative="1" as="geometry"/></mxCell>`,
			);
		}
	}

	return (
		XML_DECL +
		'<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" ' +
		'connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" ' +
		'math="0" shadow="0">\n' +
		'\t<root>\n' +
		cellLines.join('\n') +
		'\n\t</root>\n</mxGraphModel>\n'
	);
}

/** 导出为可下载的 Blob（前端直接 trigger download）。 */
export function toDrawioBlob(doc: MindMapDoc): Blob {
	return new Blob([toDrawio(doc)], { type: 'application/vnd.jgraph.mxfile' });
}

/** 从 .drawio 文本解析回 MindMapDoc（尽量容错，缺字段不抛错）。 */
export function fromDrawio(xml: string): MindMapDoc {
	const doc = new DOMParser().parseFromString(xml, 'application/xml');
	const root = doc.querySelector('mxGraphModel > root');
	if (!root) { return { nodes: [], positions: {} }; }

	const nodes: MindMapNodeData[] = [];
	const positions: Record<string, { x: number; y: number }> = {};
	const parentOf: Record<string, string | null> = {};

	const cells = Array.from(root.querySelectorAll(':scope > mxCell')) as Element[];
	// 第一遍：顶点
	for (const cell of cells) {
		if (cell.getAttribute('vertex') !== '1') { continue; }
		const id = cell.getAttribute('id');
		if (!id || id === '0' || id === '1') { continue; }
		const value = cell.getAttribute('value') ?? '';
		const geo = cell.querySelector('mxGeometry');
		const x = Number(geo?.getAttribute('x') ?? 0);
		const y = Number(geo?.getAttribute('y') ?? 0);
		positions[id] = { x, y };
		// 图片节点：value 含 <img src> 或属性 imageRefs
		const imgMatch = value.match(/<img[^>]*src="([^"]+)"/i);
		const imgAttr = cell.getAttribute('imageRefs');
		const imageRefs = imgAttr
			? imgAttr.split(',').filter(Boolean)
			: imgMatch
				? [imgMatch[1]]
				: undefined;
		const title = value.replace(/<br\/?>.*$/is, '').replace(/<[^>]+>/g, '').trim();
		nodes.push({
			id,
			parentId: null, // 第二遍填
			title: title || '未命名',
			imageRefs,
			note: cell.getAttribute('note') ?? undefined,
		});
		parentOf[id] = null;
	}

	// 第二遍：边 → 父子关系
	for (const cell of cells) {
		if (cell.getAttribute('edge') !== '1') { continue; }
		const src = cell.getAttribute('source');
		const tgt = cell.getAttribute('target');
		if (src && tgt && parentOf[tgt] !== undefined) {
			parentOf[tgt] = src;
		}
	}
	for (const n of nodes) {
		n.parentId = parentOf[n.id] ?? null;
	}

	return { nodes, positions };
}
