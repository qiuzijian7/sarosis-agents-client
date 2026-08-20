/*---------------------------------------------------------------------------------------------
 *  emojiTextOverlay — 表情包配文烘焙（Canvas 合成）。
 *
 *  用途：EmojiStage 每个格子可附加一段「配文」。静态贴纸（PNG）生成后，把配文
 *  烘焙进图（底部居中、白字黑描边、字号自适应图片宽度），返回新的 data: URL。
 *
 *  边界：动画贴纸（webp，SaveAnimatedWEBP 输出）烘焙会丢动画（Canvas 只能取首帧，
 *  且浏览器无法无损重编码带 alpha 的动画 webp），故动画贴纸**跳过烘焙**（调用方
 *  负责判定），配文改由 EmojiStageEditor 预览层的 CSS 叠加展示。
 *
 *  输入 src 优先为 data: URL（store 已物化）；也兼容 http(s)/view URL（依赖
 *  ComfyUI --enable-cors-header 允许跨域加载）。
 *--------------------------------------------------------------------------------------------*/

export interface EmojiTextOverlayOptions {
	/** 文字颜色（默认白） */
	color?: string;
	/** 描边颜色（默认黑，提高可读性） */
	strokeColor?: string;
	/** 字号相对图片宽度比例（0~1，默认 0.08） */
	fontSizeRatio?: number;
	/** 文字距图片底边的比例（0~1，默认 0.05） */
	bottomRatio?: number;
}

const DEFAULT_OPTIONS: Required<EmojiTextOverlayOptions> = {
	color: '#ffffff',
	strokeColor: 'rgba(0,0,0,0.92)',
	fontSizeRatio: 0.08,
	bottomRatio: 0.05,
};

/** 判断一个 ref 是否为（动画）webp data URL —— 这类图烘焙会丢动画，调用方应跳过。 */
export function isAnimatedWebpRef(ref: string): boolean {
	return typeof ref === 'string' && ref.startsWith('data:image/webp');
}

/**
 * 把 `text` 烘焙到 `src` 图片底部居中，返回新的 PNG data URL。
 * 多行用 `\n` 分隔。失败（图片加载超时 / 无 2d context）抛错，调用方应兜底保留原图。
 */
export function overlayTextOnImage(src: string, text: string, opts: EmojiTextOverlayOptions = {}): Promise<string> {
	const o = { ...DEFAULT_OPTIONS, ...opts };
	const trimmed = (text ?? '').replace(/\r\n/g, '\n').trim();
	return new Promise((resolve, reject) => {
		if (!trimmed) { resolve(src); return; }
		const img = new Image();
		// data: URL 是 opaque origin，设置 crossOrigin 会触发 CORS 校验导致加载失败；
		// 只有 http(s) 远程 URL 才需要 anonymous 跨域（依赖 ComfyUI --enable-cors-header）。
		if (/^https?:/i.test(src)) { img.crossOrigin = 'anonymous'; }
		const timer = setTimeout(() => reject(new Error('overlayTextOnImage timeout')), 12_000);
		img.onload = () => {
			clearTimeout(timer);
			try {
				const w = img.naturalWidth || img.width;
				const h = img.naturalHeight || img.height;
				if (!w || !h) { reject(new Error('image has no dimensions')); return; }
				const canvas = document.createElement('canvas');
				canvas.width = w;
				canvas.height = h;
				const ctx = canvas.getContext('2d');
				if (!ctx) { reject(new Error('no 2d context')); return; }
				ctx.drawImage(img, 0, 0, w, h);

				const lines = trimmed.split('\n').map(s => s.trim()).filter(Boolean);
				if (lines.length === 0) { resolve(src); return; }
				const fontSize = Math.max(12, Math.round(w * o.fontSizeRatio));
				const lineHeight = Math.round(fontSize * 1.25);
				const totalH = lineHeight * lines.length;
				const bottom = Math.round(h * o.bottomRatio);
				const startY = h - bottom - totalH / 2;
				const cx = Math.round(w / 2);

				ctx.font = `bold ${fontSize}px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif`;
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.lineJoin = 'round';
				ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.14));

				for (let i = 0; i < lines.length; i++) {
					const y = Math.round(startY + i * lineHeight);
					ctx.strokeStyle = o.strokeColor;
					ctx.strokeText(lines[i], cx, y);
					ctx.fillStyle = o.color;
					ctx.fillText(lines[i], cx, y);
				}
				resolve(canvas.toDataURL('image/png'));
			} catch (err) {
				reject(err);
			}
		};
		img.onerror = () => { clearTimeout(timer); reject(new Error('image load failed')); };
		img.src = src;
	});
}
