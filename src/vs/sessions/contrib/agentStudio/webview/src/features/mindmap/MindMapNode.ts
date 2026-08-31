/*---------------------------------------------------------------------------------------------
 *  MindMapNode — 思维导图节点（LiteGraph LGraphNode 子类）。
 *
 *  与 sarosLiteGraphNodes.ts 同栈：用 @comfyorg/litegraph 的 LGraphNode 渲染，复用
 *  现有画布（拖拽/缩放/连线/overlay）。思维导图是无环树：单输入（父）+ 多输出（子）。
 *
 *  两个变体：
 *    - 文本节点（默认）：标题 + 可选 note。
 *    - 图片节点（isImage=true）：标题 + 内嵌图片缩略（右侧 inspector 可替换/移除
 *      图片，图片走现有 mediaImport / IndexedDB 后端，与 workflow 媒体同源）。
 *
 *  节点标题/图片写在 properties 上（持久化通道，与 store 对齐）；onDrawForeground
 *  自绘圆角卡片（canvas 不在 React 路径，不能用 hook，同步读 store 取数）。
 *--------------------------------------------------------------------------------------------*/

import { LiteGraph, LGraphNode } from '@comfyorg/litegraph';

export const MIND_MAP_TYPE = 'Saros.MindMap';
export const MIND_MAP_IMAGE_TYPE = 'Saros.MindMapImage';

const NODE_W = 200;
const NODE_H = 56;
const IMG_NODE_W = 220;
const IMG_NODE_H = 120;

export interface MindMapNodeProperties {
	title: string;
	note?: string;
	/** 图片节点：图片 ref（data: / http(s): / 媒体库 key）。 */
	imageRef?: string;
	/** 主题色（分支着色）。 */
	color?: string;
}

/** 注册思维导图节点类型到 LiteGraph（幂等）。 */
export function registerMindMapNodes(): void {
	LiteGraph.registerNodeType(MIND_MAP_TYPE, createMindMapClass(false));
	LiteGraph.registerNodeType(MIND_MAP_IMAGE_TYPE, createMindMapClass(true));
}

function createMindMapClass(isImage: boolean): typeof LGraphNode {
	return class MindMapNode extends LGraphNode {
		static override title = isImage ? '图片主题' : '主题';

		constructor() {
			super(isImage ? '图片主题' : '主题');
			this.color = isImage ? '#b180d7' : '#007acc';
			this.boxcolor = this.color;
			this.addInput('parent', 'MINDMAP_EDGE');
			this.addOutput('child', 'MINDMAP_EDGE');
			this.addOutput('child2', 'MINDMAP_EDGE');
			this.addOutput('child3', 'MINDMAP_EDGE');
			// 富文本标题走 overlay（NodeEditorPopup 风格的 DOM 卡片），canvas
			// 上只画自绘卡片，widget 标 hidden 保留 properties 通道（与
			// sarosLiteGraphNodes 的 hidden widget 约定一致）。
			this.addWidget('text', 'title', '', () => { /* overlay 接管 */ }).hidden = true;
			this.addWidget('text', 'note', '', () => { /* overlay 接管 */ }).hidden = true;
			if (isImage) {
				this.addWidget('text', 'imageRef', '', () => { /* overlay 接管 */ }).hidden = true;
			}
			const w = isImage ? IMG_NODE_W : NODE_W;
			const h = isImage ? IMG_NODE_H : NODE_H;
			this.size = [w, h];
		}

		override onConfigure(config: Parameters<NonNullable<LGraphNode['onConfigure']>>[0]): void {
			super.onConfigure?.(config);
			const title = config.title;
			if (typeof title === 'string' && title.length > 0) { this.title = title; }
		}

		override onDrawForeground(ctx: CanvasRenderingContext2D, _canvas: unknown): void {
			const props = (this.properties ?? {}) as unknown as MindMapNodeProperties;
			const title = props.title || this.title || '(未命名)';
			const w = this.size[0];
			const h = this.size[1];
			const pad = 8;

			// 卡片底
			ctx.save();
			ctx.fillStyle = 'rgba(30,30,30,0.96)';
			ctx.strokeStyle = props.color ?? this.color ?? '#007acc';
			ctx.lineWidth = 1.5;
			roundRect(ctx, 0.5, 0.5, w - 1, h - 1, 8);
			ctx.fill();
			ctx.stroke();

			// 标题
			ctx.fillStyle = '#e6e6e6';
			ctx.font = '600 13px "Segoe UI", system-ui, sans-serif';
			ctx.textBaseline = 'top';
			ctx.textAlign = 'left';
			ctx.fillText(truncate(ctx, title, w - pad * 2), pad, pad);

			if (isImage && props.imageRef) {
				// 图片缩略（用 drawImage 异步解码；首帧可能为空，下帧补）
				const img = imageCache.get(props.imageRef) ?? loadImage(props.imageRef);
				if (img && img.complete && img.naturalWidth > 0) {
					const iw = w - pad * 2;
					const ih = h - 28;
					ctx.drawImage(img, pad, 26, iw, ih);
				} else {
					ctx.fillStyle = '#555';
					ctx.font = '10px "Segoe UI", system-ui, sans-serif';
					ctx.fillText('图片加载中…', pad, 28);
				}
			} else if (props.note) {
				ctx.fillStyle = '#9a9a9a';
				ctx.font = '10px "Segoe UI", system-ui, sans-serif';
				const note = truncate(ctx, props.note, w - pad * 2);
				ctx.fillText(note, pad, 26);
			}
			ctx.restore();
		}
	};
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
	if (ctx.measureText(text).width <= maxW) { return text; }
	let lo = 0, hi = text.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) { lo = mid + 1; } else { hi = mid; }
	}
	return text.slice(0, Math.max(0, lo - 1)) + '…';
}

const imageCache = new Map<string, HTMLImageElement>();
function loadImage(src: string): HTMLImageElement | null {
	if (typeof Image === 'undefined') { return null; }
	const img = new Image();
	img.crossOrigin = 'anonymous';
	img.onload = () => { imageCache.set(src, img); };
	img.src = src;
	imageCache.set(src, img);
	return img;
}
