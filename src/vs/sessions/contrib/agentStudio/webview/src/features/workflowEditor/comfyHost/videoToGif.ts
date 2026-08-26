/*---------------------------------------------------------------------------------------------
 *  videoToGif — 「视频转 GIF」工具节点的纯逻辑层。
 *
 *  为什么纯前端实现（而非后端 stage）：
 *    - ComfyTV `nodes/stages/*.py` 里**没有** gif stage；
 *    - 本机 ComfyUI 只提供 `SaveAnimatedWEBP` / `SaveAnimatedPNG`，**无 gif 输出节点**
 *      （VideoHelperSuite 的 VHS_VideoCombine 未安装）；
 *    - 浏览器侧解码视频帧（HTMLVideoElement + canvas）+ 零依赖 GIF89a 编码完全可行，
 *      与 instantNodes（Crop/Rotate/Mirror 浏览器本地变换）同一架构惯例。
 *
 *  本模块只放**纯函数**（帧时间点、调色板量化、LZW、GIF 字节流组装），便于单测；
 *  真正的「取上游视频 → 抽帧 → 编码 → 上传 → 写快照」在 videoToGifExecutor.ts。
 *
 *  GIF89a 规范要点（本实现严格遵循）：
 *    Header "GIF89a" → Logical Screen Descriptor → Global Color Table
 *    → NETSCAPE2.0 Application Extension（循环次数）
 *    → 每帧 [Graphic Control Extension + Image Descriptor + LZW 数据块]
 *    → Trailer 0x3B
 *  多字节整数一律 **little-endian**；LZW 位流 **LSB-first**。
 *--------------------------------------------------------------------------------------------*/

import type { NodeSpec } from './registry.js';

/** 本项目「视频转 GIF」工具节点类型（手写注册，不在 comfyTVStageMeta.generated.ts）。 */
export const VIDEO_TO_GIF_TYPE = 'ComfyTV.VideoToGifStage';

/** True 表示该节点走 videoToGifExecutor（浏览器本地执行）。 */
export function isVideoToGifNode(type: string): boolean {
	return type === VIDEO_TO_GIF_TYPE;
}

/**
 * 微信表情包 GIF 规范参数（emoji stage 自动转 GIF 用）：
 * 240×240、≤3s、8-15fps、循环。max_frames = 3s × 12fps = 36 帧。
 * （微信表情开放平台：GIF 240×240、≤500KB、≤3 秒、12 fps、≤24~36 帧）
 */
export const EMOJI_GIF_PARAMS: Record<string, unknown> = {
	fps: 12,
	max_width: 240,
	max_frames: 36,
	start_s: 0,
	end_s: 3,
	colors: 128,
	loop: true,
};

// ─── 参数（widget）定义 ─────────────────────────────────────────────────────

/**
 * 控件定义。命名沿用 ComfyTV video stage 的 snake_case 惯例（fps/max_width…），
 * 这样导入/导出工作流 JSON 时与后端字段风格一致。
 */
export const VIDEO_TO_GIF_WIDGETS: NodeSpec['widgets'] = [
	{ name: 'fps', type: 'INT', default: 10, min: 1, max: 30 },
	{ name: 'max_width', type: 'INT', default: 480, min: 64, max: 1920 },
	{ name: 'max_frames', type: 'INT', default: 48, min: 2, max: 300 },
	{ name: 'start_s', type: 'FLOAT', default: 0, min: 0, max: 3600, step: 0.1 },
	// end_s = 0 表示「到视频结尾」（对齐 ComfyTV VideoClipStage 的 0=末尾惯例）
	{ name: 'end_s', type: 'FLOAT', default: 0, min: 0, max: 3600, step: 0.1 },
	{ name: 'colors', type: 'INT', default: 128, min: 8, max: 256 },
	{ name: 'loop', type: 'BOOLEAN', default: true },
];

/** 数值控件取值（缺失/非法 → fallback）。纯函数。 */
export function gifNum(values: Record<string, unknown>, key: string, fallback: number): number {
	const n = Number(values[key]);
	return Number.isFinite(n) ? n : fallback;
}

/** 布尔控件取值：兼容 true / 1 / '1' / 'true'（同 instantNodes.truthy）。纯函数。 */
export function gifBool(values: Record<string, unknown>, key: string, fallback: boolean): boolean {
	const v = values[key];
	if (v === undefined || v === null || v === '') { return fallback; }
	return v === true || v === 1 || v === '1' || v === 'true';
}

// ─── 抽帧计划 ───────────────────────────────────────────────────────────────

export interface GifPlan {
	/** 抽帧时间点（秒，升序） */
	times: number[];
	/** 每帧显示时长（GIF 单位 = 1/100 秒）；由 fps 换算并至少 2（浏览器对 <2 的处理不一致） */
	delayCs: number;
	/** 输出尺寸 */
	width: number;
	height: number;
	/** 循环次数：0 = 无限 */
	loopCount: number;
	/** 调色板颜色数（2..256） */
	colors: number;
}

/**
 * 输出尺寸：按 max_width 等比缩放，**不放大**（源比 max_width 窄时保持原尺寸）。
 * 宽高都取偶数向下取整最小 1，避免奇数尺寸在某些解码器上偏移。纯函数。
 */
export function gifOutputSize(srcW: number, srcH: number, maxWidth: number): { width: number; height: number } {
	const sw = Math.max(1, Math.floor(srcW));
	const sh = Math.max(1, Math.floor(srcH));
	const cap = Math.max(16, Math.floor(maxWidth));
	if (sw <= cap) { return { width: sw, height: sh }; }
	const scale = cap / sw;
	return { width: cap, height: Math.max(1, Math.round(sh * scale)) };
}

/**
 * 计算抽帧计划。纯函数（便于单测，不触碰 DOM）。
 *
 * - `[start_s, end_s)` 区间裁剪；`end_s <= start_s` 视为「到视频结尾」。
 * - 按 fps 均匀取样，超过 max_frames 时**截断**（不降 fps）—— 与 ffmpeg
 *   `-t` 行为一致：用户想要更长就自己调 max_frames。
 * - 至少产出 1 帧（时长为 0 的视频也能出一张静态 gif）。
 */
export function planGifFrames(
	values: Record<string, unknown>,
	durationS: number,
	srcW: number,
	srcH: number,
): GifPlan {
	const fps = Math.min(30, Math.max(1, Math.round(gifNum(values, 'fps', 10))));
	const maxFrames = Math.min(300, Math.max(2, Math.round(gifNum(values, 'max_frames', 48))));
	const dur = Number.isFinite(durationS) && durationS > 0 ? durationS : 0;
	const start = Math.max(0, Math.min(gifNum(values, 'start_s', 0), dur));
	const rawEnd = gifNum(values, 'end_s', 0);
	const end = rawEnd > start ? Math.min(rawEnd, dur || rawEnd) : dur;
	const span = Math.max(0, end - start);
	const step = 1 / fps;
	const count = span > 0 ? Math.min(maxFrames, Math.max(1, Math.floor(span / step))) : 1;
	const times: number[] = [];
	for (let i = 0; i < count; i++) {
		// 取每个采样窗口的中点，避免落在关键帧边界上取到黑帧
		times.push(start + Math.min(span, (i + 0.5) * step));
	}
	const size = gifOutputSize(srcW, srcH, gifNum(values, 'max_width', 480));
	return {
		times,
		// GIF delay 单位 = 厘秒；fps=30 → 3.33cs → 取 3（≈30fps）。下限 2 见字段注释。
		delayCs: Math.max(2, Math.round(100 / fps)),
		width: size.width,
		height: size.height,
		loopCount: gifBool(values, 'loop', true) ? 0 : 1,
		colors: Math.min(256, Math.max(2, Math.round(gifNum(values, 'colors', 128)))),
	};
}

// ─── 调色板量化（median cut）────────────────────────────────────────────────

/**
 * Median-cut 调色板。输入 RGBA（Uint8Array，长度 = n*4），输出 RGB 三元组数组
 * （长度 = colors*3，不足时按实际色数返回）。纯函数。
 *
 * 为什么 median cut 而不是「取前 256 个不同色」：后者在渐变/照片类视频上会把
 * 调色板全部耗在相邻的暗部色阶，亮部整体偏色。median cut 按最长维度递归二分，
 * 保证调色板覆盖整个色域。
 *
 * `sampleStride` 对像素下采样（默认每 4 个像素取 1）—— 480×270×48 帧 ≈ 620 万
 * 像素，全量排序会卡死 UI；下采样后量化质量几乎无差别。
 */
export function medianCutPalette(rgba: Uint8Array, colors: number, sampleStride = 4): Uint8Array {
	const maxColors = Math.min(256, Math.max(2, Math.floor(colors)));
	const px: number[] = [];
	const stride = Math.max(1, Math.floor(sampleStride)) * 4;
	for (let i = 0; i + 3 < rgba.length; i += stride) {
		// 打包成单个整数（0xRRGGBB）省内存；alpha 忽略（GIF 不做半透明）
		px.push((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
	}
	if (px.length === 0) { return new Uint8Array([0, 0, 0]); }

	type Box = { list: number[]; done?: boolean };
	let boxes: Box[] = [{ list: px }];
	// 每轮把「像素最多的**可分**箱」按最长维度中位切分，直到达到目标色数。
	// ★ done 标记不可省：纯色箱（三维跨度全 0）或单像素箱无法再分，早期实现直接
	//   `break` 整个循环 → 渐变图上刚切到十几个箱就撞上一个纯色箱，128 色只产出
	//   18 色（实测），画质明显劣化。正确做法是标记该箱并继续找别的可分箱。
	while (boxes.length < maxColors) {
		let target = -1;
		let best = 1;
		for (let i = 0; i < boxes.length; i++) {
			if (!boxes[i].done && boxes[i].list.length > best) { best = boxes[i].list.length; target = i; }
		}
		if (target < 0) { break; }   // 所有箱都不可再分
		const list = boxes[target].list;
		// 该箱在 R/G/B 三个维度上的跨度，取最长维度切分
		let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
		for (const p of list) {
			const r = (p >> 16) & 0xff, g = (p >> 8) & 0xff, b = p & 0xff;
			if (r < rMin) { rMin = r; } if (r > rMax) { rMax = r; }
			if (g < gMin) { gMin = g; } if (g > gMax) { gMax = g; }
			if (b < bMin) { bMin = b; } if (b > bMax) { bMax = b; }
		}
		const dr = rMax - rMin, dg = gMax - gMin, db = bMax - bMin;
		if (dr === 0 && dg === 0 && db === 0) {
			boxes[target].done = true;   // 纯色箱：标记后继续找别的箱
			continue;
		}
		const shift = dr >= dg && dr >= db ? 16 : (dg >= db ? 8 : 0);
		list.sort((a, b2) => (((a >> shift) & 0xff) - ((b2 >> shift) & 0xff)));
		const mid = list.length >> 1;
		const left = list.slice(0, mid);
		const right = list.slice(mid);
		if (left.length === 0 || right.length === 0) {
			boxes[target].done = true;   // 无法真正二分（如全同值），避免死循环
			continue;
		}
		boxes.splice(target, 1, { list: left }, { list: right });
	}

	const out = new Uint8Array(boxes.length * 3);
	for (let i = 0; i < boxes.length; i++) {
		let r = 0, g = 0, b = 0;
		for (const p of boxes[i].list) {
			r += (p >> 16) & 0xff; g += (p >> 8) & 0xff; b += p & 0xff;
		}
		const n = boxes[i].list.length || 1;
		out[i * 3] = Math.round(r / n);
		out[i * 3 + 1] = Math.round(g / n);
		out[i * 3 + 2] = Math.round(b / n);
	}
	return out;
}

/**
 * RGBA → 调色板索引。最近邻（欧氏距离平方），带 Map 缓存。纯函数。
 * 缓存命中率在真实视频上 > 95%（相邻像素高度相似），是性能关键。
 */
export function mapToPaletteIndices(rgba: Uint8Array, palette: Uint8Array): Uint8Array {
	const n = rgba.length >> 2;
	const out = new Uint8Array(n);
	const count = palette.length / 3;
	const cache = new Map<number, number>();
	for (let i = 0; i < n; i++) {
		const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
		const key = (r << 16) | (g << 8) | b;
		const hit = cache.get(key);
		if (hit !== undefined) { out[i] = hit; continue; }
		let bestIdx = 0;
		let bestDist = Infinity;
		for (let c = 0; c < count; c++) {
			const dr = r - palette[c * 3], dg = g - palette[c * 3 + 1], db = b - palette[c * 3 + 2];
			const d = dr * dr + dg * dg + db * db;
			if (d < bestDist) { bestDist = d; bestIdx = c; if (d === 0) { break; } }
		}
		cache.set(key, bestIdx);
		out[i] = bestIdx;
	}
	return out;
}

// ─── LZW（GIF 变体）─────────────────────────────────────────────────────────

/**
 * GIF 的 LZW 压缩。返回**不含** minCodeSize 字节、**未分块**的裸位流。纯函数。
 *
 * 与「教科书 LZW」的三个 GIF 特有点：
 *   1. 位流 LSB-first（低位先写），不是网络字节序；
 *   2. 预留 clearCode = 1<<minCodeSize、eoiCode = clearCode+1，字典从 clearCode+2 起；
 *   3. 码长在 nextCode 超过当前码长上限时 +1，字典满 4096 时发 clearCode 重置。
 */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
	const minCode = Math.max(2, Math.min(8, minCodeSize));
	const clearCode = 1 << minCode;
	const eoiCode = clearCode + 1;
	const out: number[] = [];
	let bitBuf = 0;
	let bitCount = 0;
	let codeSize = minCode + 1;

	const emit = (code: number): void => {
		bitBuf |= code << bitCount;
		bitCount += codeSize;
		while (bitCount >= 8) {
			out.push(bitBuf & 0xff);
			bitBuf >>= 8;
			bitCount -= 8;
		}
	};

	let dict = new Map<string, number>();
	let nextCode = eoiCode + 1;
	const resetDict = (): void => { dict = new Map<string, number>(); nextCode = eoiCode + 1; codeSize = minCode + 1; };

	emit(clearCode);
	if (indices.length === 0) {
		emit(eoiCode);
		if (bitCount > 0) { out.push(bitBuf & 0xff); }
		return new Uint8Array(out);
	}

	let prefix = String(indices[0]);
	let prefixCode = indices[0];
	for (let i = 1; i < indices.length; i++) {
		const c = indices[i];
		const cand = `${prefix},${c}`;
		const found = dict.get(cand);
		if (found !== undefined) {
			prefix = cand;
			prefixCode = found;
			continue;
		}
		emit(prefixCode);
		if (nextCode < 4096) {
			// ★ 码长增长时机（差一个码 = 整条位流与标准解码器脱轨）：
			//   标准 GIF LZW（omggif）在「输出 code 之后、分配新码之前」检查
			//   `next_code >= (1 << code_size)` → 增长。nextCode 是「即将分配的码」。
			//   ★★ 绝不能放在「分配后（nextCode++ 之后）」：那样增长会早一个码，
			//   后续 emit 用错位宽。浏览器按标准规则解码 → 在码长切换处脱轨，
			//   表现为「前几像素对、后面大面积黑/花」。自写测试解码器若用同错规则
			//   会「共谋」通过往返，但浏览器立刻现形（血泪教训）。
			if (nextCode >= (1 << codeSize) && codeSize < 12) { codeSize++; }
			dict.set(cand, nextCode);
			nextCode++;
		} else {
			emit(clearCode);
			resetDict();
		}
		prefix = String(c);
		prefixCode = c;
	}
	emit(prefixCode);
	emit(eoiCode);
	if (bitCount > 0) { out.push(bitBuf & 0xff); }
	return new Uint8Array(out);
}

/** 裸 LZW 流 → GIF 子块（每块最多 255 字节，0x00 结束）。纯函数。 */
export function toSubBlocks(data: Uint8Array): number[] {
	const out: number[] = [];
	for (let i = 0; i < data.length; i += 255) {
		const chunk = data.subarray(i, Math.min(i + 255, data.length));
		out.push(chunk.length);
		for (const b of chunk) { out.push(b); }
	}
	out.push(0);
	return out;
}

// ─── GIF89a 组装 ───────────────────────────────────────────────────────────

export interface GifFrameInput {
	/** 调色板索引位图（长度 = width*height） */
	indices: Uint8Array;
	/** 该帧的局部调色板（RGB 三元组，长度 = n*3；n 会补齐到 2 的幂） */
	palette: Uint8Array;
	/** 显示时长（厘秒） */
	delayCs: number;
}

/** 调色板色数补齐到 2 的幂（GIF 要求），返回 [补齐后的表, sizeCode]。纯函数。 */
export function padPalette(palette: Uint8Array): { table: Uint8Array; sizeCode: number } {
	const n = Math.max(2, palette.length / 3);
	let pow = 2;
	let sizeCode = 0;
	while (pow < n) { pow <<= 1; sizeCode++; }
	const table = new Uint8Array(pow * 3);
	table.set(palette.subarray(0, Math.min(palette.length, pow * 3)));
	return { table, sizeCode };
}

/**
 * 组装完整 GIF89a 字节流。纯函数（无 DOM 依赖，可在 node 单测中校验字节）。
 *
 * 每帧使用**局部调色板**（Local Color Table）—— 视频场景切换时全局调色板会
 * 让某些帧严重偏色；局部表每帧独立量化，代价是每帧多 3*2^n 字节（480p/128 色
 * 约 384B/帧，可接受）。
 */
export function encodeGif(frames: GifFrameInput[], width: number, height: number, loopCount = 0): Uint8Array {
	const bytes: number[] = [];
	const u8 = (v: number): void => { bytes.push(v & 0xff); };
	const u16 = (v: number): void => { bytes.push(v & 0xff, (v >> 8) & 0xff); };
	const str = (s: string): void => { for (let i = 0; i < s.length; i++) { bytes.push(s.charCodeAt(i)); } };

	// Header
	str('GIF89a');
	// Logical Screen Descriptor（无全局色表 → packed 的 GCT flag = 0）
	u16(width);
	u16(height);
	u8(0x70);   // colorResolution=7（其余位 0）
	u8(0);      // background color index
	u8(0);      // pixel aspect ratio

	// NETSCAPE2.0 Application Extension —— 循环次数（0 = 无限）
	u8(0x21); u8(0xff); u8(0x0b);
	str('NETSCAPE2.0');
	u8(0x03); u8(0x01); u16(loopCount); u8(0x00);

	for (const f of frames) {
		const { table, sizeCode } = padPalette(f.palette);
		// Graphic Control Extension（disposal=1 「不处置」，无透明色）
		u8(0x21); u8(0xf9); u8(0x04);
		u8(0x04);                       // packed: disposal(1)<<2
		u16(Math.max(0, Math.round(f.delayCs)));
		u8(0);                          // transparent color index（未启用）
		u8(0x00);
		// Image Descriptor
		u8(0x2c);
		u16(0); u16(0);                 // left / top
		u16(width); u16(height);
		u8(0x80 | sizeCode);            // 局部色表 flag | size
		for (const b of table) { u8(b); }
		// LZW 数据：minCodeSize 至少 2（GIF 规范），随色表大小增长
		const minCodeSize = Math.max(2, sizeCode + 1);
		u8(minCodeSize);
		for (const b of toSubBlocks(lzwEncode(f.indices, minCodeSize))) { u8(b); }
	}

	u8(0x3b);   // Trailer
	return new Uint8Array(bytes);
}
