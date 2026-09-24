/*---------------------------------------------------------------------------------------------
 *  SVG → PNG 栅格化（渲染进程 canvas）—— 2026-09-23
 *
 *  为什么需要这一步：
 *   · 飞书**图片不支持 SVG**（实测：`file is not a supported BMP, GIF, JPEG, PNG, TIFF, or WebP image`）
 *     ⇒ mermaid / drawio 渲染出的 SVG 不能直接同步，必须先转成 PNG；
 *   · 项目没有 `sharp` / `resvg` / `svg2png` / `mmdc` 依赖，宿主侧也没有栅格化能力；
 *   · 但本模块运行在**渲染进程**（与 `mermaidInlineRenderer` 同一层，用 `mainWindow`），
 *     那里有完整 DOM ⇒ 用 `canvas.drawImage` 即可栅格化，**不引入任何依赖、不需要 webview 通道**。
 *
 *  ⚠ 只有 `parseSvgSize` 是纯函数（可在 node 测试里跑）；`svgToPng` 依赖 DOM，只能真机验证。
 *--------------------------------------------------------------------------------------------*/

/** SVG 尺寸兜底（拿不到 width/height/viewBox 时使用）。 */
const FALLBACK_SIZE = { width: 800, height: 600 };

/** 单边最大像素（避免超大画布撑爆内存 / 被 canvas 拒绝）。 */
const MAX_EDGE = 4096;

/**
 * 从 SVG 文本推断渲染尺寸（纯函数，便于单测）。
 *
 * 顺序：`width`/`height` 属性 → `viewBox`（第 3、4 个数）→ 兜底 800×600。
 * ⚠ 尺寸可能是 `100%`（mermaid 有时这么输出）⇒ `parseFloat` 得到 100 但那是百分比而非像素，
 *   故只接受**有限正数**且要求带单位是 px 或无单位；`%` 一律视为无效并回退 viewBox。
 */
export function parseSvgSize(svg: string): { width: number; height: number } {
	const readAttr = (name: string): number => {
		const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(svg ?? '');
		if (!m) { return NaN; }
		const raw = m[1].trim();
		if (raw.endsWith('%')) { return NaN; }            // 百分比不是像素
		const v = Number.parseFloat(raw);                  // 容忍 `640px` / `640`
		return Number.isFinite(v) && v > 0 ? v : NaN;
	};

	let width = readAttr('width');
	let height = readAttr('height');

	if (!Number.isFinite(width) || !Number.isFinite(height)) {
		const vb = /viewBox\s*=\s*"([^"]*)"/i.exec(svg ?? '');
		if (vb) {
			const parts = vb[1].trim().split(/[\s,]+/).map(Number);
			if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
				if (!Number.isFinite(width)) { width = parts[2]; }
				if (!Number.isFinite(height)) { height = parts[3]; }
			}
		}
	}

	return {
		width: Number.isFinite(width) ? width : FALLBACK_SIZE.width,
		height: Number.isFinite(height) ? height : FALLBACK_SIZE.height,
	};
}

/** 在不超过 `MAX_EDGE` 的前提下，把清晰度倍率收敛到可用范围。 */
export function clampScale(size: { width: number; height: number }, desiredScale: number): number {
	const longest = Math.max(size.width, size.height);
	if (longest <= 0) { return 1; }
	const maxByEdge = MAX_EDGE / longest;
	return Math.max(1, Math.min(desiredScale, maxByEdge));
}

export interface ISvgToPngOptions {
	/** 清晰度倍率（默认 2，越大越清晰也越大）。 */
	scale?: number;
	/** 背景色（默认白色 —— 飞书正文白底，透明 PNG 在深色主题下可能发黑）。 */
	background?: string;
}

/**
 * 把 SVG 文本栅格化为 PNG 字节。
 *
 * ⚠ 必须在**渲染进程**调用（依赖 `document` / `Image` / `canvas`）。
 * ⚠ 用 `data:` URL 加载（而非 blob URL）：同源、不会污染 canvas、也不需要 revoke 生命周期管理。
 */
export async function svgToPng(svg: string, opts: ISvgToPngOptions = {}): Promise<Uint8Array> {
	const text = (svg ?? '').trim();
	if (!text) { throw new Error('svgToPng: 输入为空'); }

	const size = parseSvgSize(text);
	const scale = clampScale(size, opts.scale && opts.scale > 0 ? opts.scale : 2);
	const width = Math.max(1, Math.round(size.width * scale));
	const height = Math.max(1, Math.round(size.height * scale));

	const image = new Image();
	image.decoding = 'sync';
	// URL 编码的 data URL：避免 base64（大数据会爆栈/耗 CPU），且不依赖 Buffer
	const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
	await new Promise<void>((resolve, reject) => {
		image.onload = () => resolve();
		image.onerror = () => reject(new Error('svgToPng: SVG 解码失败（可能不是合法 SVG）'));
		image.src = dataUrl;
	});

	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	if (!ctx) { throw new Error('svgToPng: 无法获取 canvas 2d 上下文'); }
	const bg = opts.background ?? '#ffffff';
	if (bg) {
		ctx.fillStyle = bg;
		ctx.fillRect(0, 0, width, height);
	}
	ctx.drawImage(image, 0, 0, width, height);

	const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
	if (!blob) { throw new Error('svgToPng: canvas.toBlob 返回空（可能画布过大）'); }
	return new Uint8Array(await blob.arrayBuffer());
}
