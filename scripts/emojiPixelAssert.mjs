/*---------------------------------------------------------------------------------------------
 *  emojiPixelAssert — 表情包产物像素级纯函数（e2e 与 ui-e2e 共用）。
 *
 *  纯解析 + 纯统计，零依赖（仅 node:zlib），无 console、无断言副作用。
 *  断言逻辑由调用方（test-emoji-e2e.mjs / test-emoji-ui-e2e.mjs）自行组织。
 *
 *  阈值标定（RTX 4070 实测，见各函数注释）：
 *    - alpha 方向：外框(2%)均值 ≤ 32 判「非反转/非溢出」
 *    - 噪声：前景梯度 ≤ 40 判「非彩色噪声」（仅动态表情可靠）
 *--------------------------------------------------------------------------------------------*/

import zlib from 'node:zlib';

// ---------------------------------------------------------------- PNG 解码
// 纯 Node 实现（zlib inflate + 反 filter），只支持 8-bit 非隔行 —— ComfyUI
// SaveImage 的输出恒为该形态。够用且零外部依赖。

function readU32(b, i) { return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0; }

function paeth(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
	return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}

/** @returns {{width:number,height:number,channels:number,px:Buffer}} px 为紧凑的 [H*W*channels] */
export function decodePng(bytes) {
	if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) {
		throw new Error('不是 PNG（魔数不符）');
	}
	let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
	const idat = [];
	while (pos + 8 <= bytes.length) {
		const len = readU32(bytes, pos);
		const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
		const ds = pos + 8;
		if (type === 'IHDR') {
			width = readU32(bytes, ds); height = readU32(bytes, ds + 4);
			bitDepth = bytes[ds + 8]; colorType = bytes[ds + 9]; interlace = bytes[ds + 12];
		} else if (type === 'IDAT') {
			idat.push(Buffer.from(bytes.subarray(ds, ds + len)));
		} else if (type === 'IEND') { break; }
		pos = ds + len + 4; // +4 = CRC
	}
	if (bitDepth !== 8) { throw new Error(`只支持 8-bit PNG（实际 ${bitDepth}）`); }
	if (interlace !== 0) { throw new Error('不支持隔行 PNG'); }
	const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
	if (!channels) { throw new Error(`不支持的 colorType ${colorType}`); }

	const raw = zlib.inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const out = Buffer.alloc(height * stride);
	let rp = 0;
	for (let y = 0; y < height; y++) {
		const ft = raw[rp++];
		const row = y * stride, prev = (y - 1) * stride;
		for (let x = 0; x < stride; x++) {
			const v = raw[rp + x];
			const a = x >= channels ? out[row + x - channels] : 0;
			const b = y > 0 ? out[prev + x] : 0;
			const c = (x >= channels && y > 0) ? out[prev + x - channels] : 0;
			let r;
			switch (ft) {
				case 0: r = v; break;
				case 1: r = v + a; break;
				case 2: r = v + b; break;
				case 3: r = v + ((a + b) >> 1); break;
				case 4: r = v + paeth(a, b, c); break;
				default: throw new Error(`非法 filter type ${ft} @row ${y}`);
			}
			out[row + x] = r & 0xff;
		}
		rp += stride;
	}
	return { width, height, channels, px: out };
}

// ---------------------------------------------------------------- WebP 容器
/** WebP 容器解析（不解像素）：拿 alpha 标志 / 是否动画 / 帧数。 */
export function parseWebp(bytes) {
	const tag = (i) => String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
	if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') { throw new Error('不是 WebP'); }
	let pos = 12, frames = 0, hasAlphaFlag = false, isAnim = false, lossless = false;
	while (pos + 8 <= bytes.length) {
		const t = tag(pos);
		const size = bytes[pos + 4] | (bytes[pos + 5] << 8) | (bytes[pos + 6] << 16) | (bytes[pos + 7] << 24);
		const ds = pos + 8;
		if (t === 'VP8X') {
			const f = bytes[ds];
			isAnim = !!(f & 0x02);
			hasAlphaFlag = !!(f & 0x10);
		} else if (t === 'ANMF') { frames++; }
		else if (t === 'ALPH') { hasAlphaFlag = true; }
		else if (t === 'VP8L') { lossless = true; }
		pos = ds + size + (size & 1); // chunk 按偶数对齐
	}
	return { hasAlphaFlag, isAnim, frames, lossless };
}

// ---------------------------------------------------------------- alpha 统计

/**
 * 计算 alpha 的统计特征。
 *   edgeAvg —— 外框(2%)带的 alpha 均值，★ 判断反转/脏边的主信号
 *   ctrAvg  —— 中心 1/3~2/3 区域均值
 *   corners  —— 四角 alpha（正确应为 [0,0,0,0]）
 *   oPct/tPct —— 不透明(>200)/透明(<50) 像素占比
 */
export function alphaMetrics(img) {
	const { width: w, height: h, px, channels } = img;
	if (channels !== 4) { return { edgeAvg: 0, ctrAvg: 0, corners: [], oPct: 0, tPct: 0 }; }
	const A = (x, y) => px[(y * w + x) * 4 + 3];
	const band = Math.max(4, Math.round(Math.min(w, h) * 0.02)); // 外框宽度 ~2%
	const x0 = Math.floor(w / 3), x1 = Math.floor(w * 2 / 3);
	const y0 = Math.floor(h / 3), y1 = Math.floor(h * 2 / 3);
	let edgeSum = 0, edgeN = 0, ctrSum = 0, ctrN = 0, transparent = 0, opaque = 0;
	for (let y = 0; y < h; y++) {
		const inEdgeRow = y < band || y >= h - band;
		for (let x = 0; x < w; x++) {
			const a = A(x, y);
			if (a < 50) { transparent++; } else if (a > 200) { opaque++; }
			if (inEdgeRow || x < band || x >= w - band) { edgeSum += a; edgeN++; }
			if (x >= x0 && x < x1 && y >= y0 && y < y1) { ctrSum += a; ctrN++; }
		}
	}
	const total = w * h;
	return {
		edgeAvg: edgeSum / Math.max(1, edgeN),
		ctrAvg: ctrSum / Math.max(1, ctrN),
		corners: [A(0, 0), A(w - 1, 0), A(0, h - 1), A(w - 1, h - 1)],
		oPct: opaque * 100 / total,
		tPct: transparent * 100 / total,
	};
}

// ---------------------------------------------------------------- 噪声统计

/**
 * 前景（alpha>128）空间高频梯度 —— 抓「图像能生成但内容是彩色噪声」。
 * 噪声本质 = 相邻像素 RGB 无相关性、差值巨大。
 * 实测：正常贴纸前景梯度 ≈ 9~11，彩色噪声 ≈ 85，阈值 40。
 * 返回 null 当 channels<3；samples<1000 由调用方判定为空图（alpha 判据负责）。
 */
export function noiseMetrics(img) {
	const { width: w, height: h, px, channels } = img;
	if (channels < 3) { return null; }
	const step = 2;
	let sum = 0, n = 0;
	for (let y = 0; y < h - step; y += step) {
		for (let x = 0; x < w - step; x += step) {
			const i = (y * w + x) * channels;
			const a = channels === 4 ? px[i + 3] : 255;
			if (a < 128) { continue; }
			const r = px[i], g = px[i + 1], b = px[i + 2];
			const ir = i + step * channels;
			const id = i + step * w * channels;
			const d = (Math.abs(r - px[ir]) + Math.abs(g - px[ir + 1]) + Math.abs(b - px[ir + 2])
				+ Math.abs(r - px[id]) + Math.abs(g - px[id + 1]) + Math.abs(b - px[id + 2])) / 6;
			sum += d; n++;
		}
	}
	return { gradient: n ? sum / n : 0, samples: n };
}

// ---------------------------------------------------------------- data URL 解码

/** 把 `data:image/png;base64,...` / `data:image/webp;base64,...` 转成 Uint8Array。 */
export function dataUrlToBytes(dataUrl) {
	const comma = dataUrl.indexOf(',');
	if (comma < 0) { throw new Error('不是 data URL'); }
	const b64 = dataUrl.slice(comma + 1);
	return new Uint8Array(Buffer.from(b64, 'base64'));
}
