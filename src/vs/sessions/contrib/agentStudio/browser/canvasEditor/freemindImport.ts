/*---------------------------------------------------------------------------------------------
 *  Saros Agents — FreeMind Import（Browser 层）
 *
 *  使用 DOMParser 解析 FreeMind/Coggle .mm XML 文件，
 *  调用 common/mindmap/freemindLayout 转换为 Canvas JSON 数据。
 *--------------------------------------------------------------------------------------------*/

import type { IMindmapData } from '../../common/mindmap/mindmapTypes.js';
import { freemindToCanvas, type IFreeMindNode, type IFreeMindLayoutOptions } from '../../common/mindmap/freemindLayout.js';

/**
 * 解析 FreeMind/Coggle XML 字符串，转换为 .canvas 数据。
 * 支持标准 FreeMind（<node> 在 <map> 下）和 Coggle 导出（<x-coggle-rootnode> 同级）。
 *
 * @param xml FreeMind .mm XML 文件内容
 * @param opts 布局选项（可选）
 * @returns Canvas JSON 数据，或 null（解析失败）
 */
export function parseFreeMindXmlAndConvert(
	xml: string,
	opts?: Partial<IFreeMindLayoutOptions>,
): IMindmapData | null {
	const roots = parseFreeMindXmlToNodes(xml);
	if (roots.length === 0) { return null; }
	return freemindToCanvas(roots, opts);
}

/**
 * 解析 FreeMind XML 为 IFreeMindNode 树形数组（供测试中的独立使用）。
 */
export function parseFreeMindXmlToNodes(xml: string): IFreeMindNode[] {
	const parser = new DOMParser();
	const doc = parser.parseFromString(xml, 'text/xml');

	const errorNode = doc.querySelector('parsererror');
	if (errorNode) { return []; }

	const mapEl = doc.querySelector('map');
	if (!mapEl) { return []; }

	const roots: IFreeMindNode[] = [];

	for (const child of Array.from(mapEl.children)) {
		if (child.tagName === 'node' || child.tagName === 'x-coggle-rootnode') {
			roots.push(parseNode(child, 'right'));
		}
	}

	return roots;
}

type Position = 'left' | 'right';

function parseNode(el: Element, inheritedPosition: Position): IFreeMindNode {
	const text = el.getAttribute('TEXT') || 'Untitled';
	const posAttr = el.getAttribute('POSITION');
	const position: Position =
		posAttr === 'left' ? 'left' :
		posAttr === 'right' ? 'right' :
		inheritedPosition;

	const children: IFreeMindNode[] = [];

	for (const child of Array.from(el.children)) {
		if (child.tagName === 'node' || child.tagName === 'x-coggle-rootnode') {
			children.push(parseNode(child, position));
		}
	}

	return { text, position, children };
}
