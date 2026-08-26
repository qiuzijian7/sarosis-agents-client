/*---------------------------------------------------------------------------------------------
 *  videoToGif 单测 —— GIF89a 编码器 / median-cut 量化 / 抽帧计划的纯逻辑校验。
 *
 *  测试哲学（项目惯例）：不做 `assert.doesNotThrow` 这类零价值断言，而是
 *  **逐字节校验 GIF 结构**（Header / LSD / NETSCAPE / GCE / Image Descriptor /
 *  Trailer）并**实解 LZW** 验证往返无损 —— 编码器写错一位就会被抓。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	encodeGif, gifOutputSize, lzwEncode, mapToPaletteIndices, medianCutPalette,
	padPalette, planGifFrames, toSubBlocks, isVideoToGifNode, VIDEO_TO_GIF_TYPE,
	VIDEO_TO_GIF_WIDGETS,
} from '../../webview/src/features/workflowEditor/comfyHost/videoToGif.js';

/**
 * 参考 LZW 解码器（GIF 变体）—— 只在测试里用，作为编码器的独立对照实现。
 * 与被测代码**没有共享逻辑**，因此往返一致才有证明力。
 */
function lzwDecode(data: Uint8Array, minCodeSize: number): number[] {
	const clearCode = 1 << minCodeSize;
	const eoiCode = clearCode + 1;
	let codeSize = minCodeSize + 1;
	let dict: number[][] = [];
	const resetDict = (): void => {
		dict = [];
		for (let i = 0; i < clearCode; i++) { dict.push([i]); }
		dict.push([]); // clear
		dict.push([]); // eoi
		codeSize = minCodeSize + 1;
	};
	resetDict();

	const out: number[] = [];
	let bitPos = 0;
	const readCode = (): number => {
		let v = 0;
		for (let i = 0; i < codeSize; i++) {
			const byte = data[(bitPos >> 3)] ?? 0;
			const bit = (byte >> (bitPos & 7)) & 1;
			v |= bit << i;
			bitPos++;
		}
		return v;
	};

	let prev: number[] | null = null;
	for (;;) {
		if ((bitPos >> 3) >= data.length) { break; }
		const code = readCode();
		if (code === eoiCode) { break; }
		if (code === clearCode) { resetDict(); prev = null; continue; }
		let entry: number[];
		if (code < dict.length && dict[code].length > 0) {
			entry = dict[code].slice();
		} else if (code < dict.length && code < clearCode) {
			entry = dict[code].slice();
		} else if (prev) {
			entry = prev.concat([prev[0]]);
		} else {
			break;
		}
		for (const v of entry) { out.push(v); }
		if (prev) {
			dict.push(prev.concat([entry[0]]));
			// ★ 码长增长对齐标准 GIF LZW 解码器：加字典后 dict.length >= 2^code_size
			//   即增长（下一个码需要更长位宽）。写 `dict.length + 1` 会「早一个码」，
			//   与标准编码器脱轨（浏览器解码即现形）。
			if (dict.length >= (1 << codeSize) && codeSize < 12) { codeSize++; }
		}
		prev = entry;
	}
	return out;
}

/** 从 GIF 子块还原裸 LZW 流（toSubBlocks 的逆运算，独立实现）。 */
function fromSubBlocks(bytes: number[]): Uint8Array {
	const out: number[] = [];
	let i = 0;
	for (;;) {
		const len = bytes[i++];
		if (!len) { break; }
		for (let k = 0; k < len; k++) { out.push(bytes[i++]); }
	}
	return new Uint8Array(out);
}

const u16le = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);
const ascii = (b: Uint8Array, o: number, n: number): string =>
	Array.from(b.subarray(o, o + n)).map(c => String.fromCharCode(c)).join('');

suite('videoToGif — 节点身份与控件', () => {
	test('isVideoToGifNode 只认自己的类型', () => {
		assert.strictEqual(isVideoToGifNode(VIDEO_TO_GIF_TYPE), true);
		assert.strictEqual(isVideoToGifNode('ComfyTV.VideoClipStage'), false);
		assert.strictEqual(isVideoToGifNode('ComfyTV.CropStage'), false);
		assert.strictEqual(isVideoToGifNode(''), false);
	});

	test('控件齐全且范围合法（fps/max_width/max_frames/start_s/end_s/colors/loop）', () => {
		const names = (VIDEO_TO_GIF_WIDGETS ?? []).map(w => w.name);
		for (const need of ['fps', 'max_width', 'max_frames', 'start_s', 'end_s', 'colors', 'loop']) {
			assert.ok(names.includes(need), `缺少控件 ${need}`);
		}
		const colors = (VIDEO_TO_GIF_WIDGETS ?? []).find(w => w.name === 'colors')!;
		// GIF 调色板上限 256，下限 2（1 色无法编码索引）
		assert.strictEqual(colors.max, 256);
		assert.ok((colors.min ?? 0) >= 2);
	});
});

suite('videoToGif — 抽帧计划', () => {
	test('gifOutputSize 等比缩放且不放大', () => {
		assert.deepStrictEqual(gifOutputSize(1920, 1080, 480), { width: 480, height: 270 });
		// 源比 max_width 窄 → 保持原尺寸（不放大，避免糊图 + 白占体积）
		assert.deepStrictEqual(gifOutputSize(320, 180, 480), { width: 320, height: 180 });
	});

	test('按 fps 均匀取样，帧数受 max_frames 截断', () => {
		// 10s @ 10fps = 100 帧，被 max_frames=24 截断
		const p = planGifFrames({ fps: 10, max_frames: 24, max_width: 480 }, 10, 640, 360);
		assert.strictEqual(p.times.length, 24);
		// 采样点取窗口中点：第 0 帧 = 0.05s，第 1 帧 = 0.15s
		assert.ok(Math.abs(p.times[0] - 0.05) < 1e-9, `times[0]=${p.times[0]}`);
		assert.ok(Math.abs(p.times[1] - 0.15) < 1e-9, `times[1]=${p.times[1]}`);
		// delay 厘秒 = 100/fps
		assert.strictEqual(p.delayCs, 10);
	});

	test('start_s/end_s 区间裁剪；end_s<=start_s 视为到结尾', () => {
		const clip = planGifFrames({ fps: 4, max_frames: 300, start_s: 2, end_s: 4 }, 10, 100, 100);
		// 2s 区间 @4fps = 8 帧，全部落在 [2,4]
		assert.strictEqual(clip.times.length, 8);
		assert.ok(clip.times[0] >= 2 && clip.times[clip.times.length - 1] <= 4);

		const toEnd = planGifFrames({ fps: 2, max_frames: 300, start_s: 8, end_s: 0 }, 10, 100, 100);
		// end_s=0 → 到 10s 结尾，2s 区间 @2fps = 4 帧
		assert.strictEqual(toEnd.times.length, 4);
		assert.ok(toEnd.times[0] >= 8);
	});

	test('零时长/非法 duration 也至少产出 1 帧（静态 gif）', () => {
		assert.strictEqual(planGifFrames({}, 0, 64, 64).times.length, 1);
		assert.strictEqual(planGifFrames({}, NaN, 64, 64).times.length, 1);
	});

	test('loop 控件映射到 loopCount（true→0 无限 / false→1）', () => {
		assert.strictEqual(planGifFrames({ loop: true }, 1, 64, 64).loopCount, 0);
		assert.strictEqual(planGifFrames({ loop: false }, 1, 64, 64).loopCount, 1);
		// 缺省 = 循环
		assert.strictEqual(planGifFrames({}, 1, 64, 64).loopCount, 0);
	});
});

suite('videoToGif — 调色板量化', () => {
	test('medianCutPalette 覆盖整个色域（不把配额耗在相邻色阶）', () => {
		// 4 个极端角色：黑 / 红 / 绿 / 蓝，各 16 像素
		const rgba = new Uint8Array(64 * 4);
		const corners = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]];
		for (let i = 0; i < 64; i++) {
			const c = corners[Math.floor(i / 16)];
			rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1]; rgba[i * 4 + 2] = c[2]; rgba[i * 4 + 3] = 255;
		}
		const pal = medianCutPalette(rgba, 4, 1);
		assert.strictEqual(pal.length, 4 * 3, '应产出 4 色');
		// 每个角色都应有一个足够接近的调色板项
		for (const c of corners) {
			let best = Infinity;
			for (let i = 0; i < pal.length; i += 3) {
				const d = (pal[i] - c[0]) ** 2 + (pal[i + 1] - c[1]) ** 2 + (pal[i + 2] - c[2]) ** 2;
				best = Math.min(best, d);
			}
			assert.ok(best < 100, `色 ${c} 未被调色板覆盖（最近距离² = ${best}）`);
		}
	});

	test('全同色图像不会因无法切分而死循环', () => {
		const rgba = new Uint8Array(16 * 4);
		for (let i = 0; i < 16; i++) { rgba[i * 4] = 7; rgba[i * 4 + 1] = 7; rgba[i * 4 + 2] = 7; }
		const pal = medianCutPalette(rgba, 256, 1);
		assert.ok(pal.length >= 3 && pal.length % 3 === 0);
		assert.strictEqual(pal[0], 7);
	});

	test('mapToPaletteIndices 取最近邻且索引在界内', () => {
		const pal = new Uint8Array([0, 0, 0, 255, 255, 255]);
		const rgba = new Uint8Array([10, 10, 10, 255, 240, 240, 240, 255]);
		const idx = mapToPaletteIndices(rgba, pal);
		assert.deepStrictEqual(Array.from(idx), [0, 1]);
	});
});

suite('videoToGif — LZW', () => {
	test('往返无损（对照独立解码器）', () => {
		const cases: number[][] = [
			[0],
			[1, 1, 1, 1, 1, 1, 1, 1],
			[0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3],
			Array.from({ length: 500 }, (_, i) => i % 7),
		];
		for (const c of cases) {
			const src = new Uint8Array(c);
			const enc = lzwEncode(src, 3);
			const dec = lzwDecode(enc, 3);
			assert.deepStrictEqual(dec, c, `LZW 往返失真：${JSON.stringify(c.slice(0, 12))}…`);
		}
	});

	test('空输入只产生 clear + EOI（不崩溃、不产生垃圾码）', () => {
		const enc = lzwEncode(new Uint8Array([]), 2);
		assert.ok(enc.length > 0);
		assert.deepStrictEqual(lzwDecode(enc, 2), []);
	});

	test('toSubBlocks 分块 ≤255 并以 0 结束', () => {
		const data = new Uint8Array(600).fill(9);
		const blocks = toSubBlocks(data);
		assert.strictEqual(blocks[0], 255);
		assert.strictEqual(blocks[256], 255);          // 第二块长度字节
		assert.strictEqual(blocks[blocks.length - 1], 0, '必须以 0 块结束');
		assert.deepStrictEqual(Array.from(fromSubBlocks(blocks)), Array.from(data));
	});

	test('padPalette 补齐到 2 的幂并给出正确 sizeCode', () => {
		// 3 色 → 补到 4（2^2）→ sizeCode=1（2^(1+1)=4）
		const p3 = padPalette(new Uint8Array(3 * 3));
		assert.strictEqual(p3.table.length, 4 * 3);
		assert.strictEqual(p3.sizeCode, 1);
		// 128 色 → sizeCode=6（2^7=128）
		const p128 = padPalette(new Uint8Array(128 * 3));
		assert.strictEqual(p128.table.length, 128 * 3);
		assert.strictEqual(p128.sizeCode, 6);
	});
});

suite('videoToGif — GIF89a 字节结构', () => {
	const W = 4;
	const H = 2;
	const palette = new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0]);  // 3 色
	const mkFrame = (fill: number) => ({
		indices: new Uint8Array(W * H).fill(fill),
		palette,
		delayCs: 7,
	});

	test('Header / LSD / Trailer 正确', () => {
		const gif = encodeGif([mkFrame(1)], W, H, 0);
		assert.strictEqual(ascii(gif, 0, 6), 'GIF89a');
		assert.strictEqual(u16le(gif, 6), W, '宽度必须 little-endian');
		assert.strictEqual(u16le(gif, 8), H, '高度必须 little-endian');
		assert.strictEqual(gif[gif.length - 1], 0x3b, 'Trailer 必须是 0x3B');
	});

	test('NETSCAPE2.0 循环扩展存在且 loopCount 写入正确', () => {
		const inf = encodeGif([mkFrame(0)], W, H, 0);
		const at = 13;   // Header(6) + LSD(7)
		assert.strictEqual(inf[at], 0x21, 'Extension Introducer');
		assert.strictEqual(inf[at + 1], 0xff, 'Application Extension Label');
		assert.strictEqual(inf[at + 2], 0x0b, 'block size = 11');
		assert.strictEqual(ascii(inf, at + 3, 11), 'NETSCAPE2.0');
		assert.strictEqual(u16le(inf, at + 16), 0, '无限循环 = 0');

		const once = encodeGif([mkFrame(0)], W, H, 1);
		assert.strictEqual(u16le(once, at + 16), 1, 'loop=1 写入失败');
	});

	test('每帧含 GCE(0x21F9) + Image Descriptor(0x2C) 且 delay 写入正确', () => {
		const gif = encodeGif([mkFrame(0), mkFrame(2)], W, H, 0);
		let gce = 0;
		let imgDesc = 0;
		for (let i = 0; i < gif.length - 1; i++) {
			if (gif[i] === 0x21 && gif[i + 1] === 0xf9) {
				gce++;
				// GCE: 0x21 0xF9 0x04 packed delay(2) transparentIdx 0x00
				assert.strictEqual(gif[i + 2], 0x04, 'GCE block size');
				assert.strictEqual(u16le(gif, i + 4), 7, 'delayCs 写入失败');
			}
			if (gif[i] === 0x2c) { imgDesc++; }
		}
		assert.strictEqual(gce, 2, '每帧应有一个 GCE');
		assert.strictEqual(imgDesc, 2, '每帧应有一个 Image Descriptor');
	});

	test('像素往返：解析首帧 LZW 还原出原始索引位图', () => {
		const indices = new Uint8Array([0, 1, 2, 1, 2, 0, 1, 1]);
		const gif = encodeGif([{ indices, palette, delayCs: 5 }], W, H, 0);

		// 定位首个 Image Descriptor（0x2C）
		const at = gif.indexOf(0x2c);
		assert.ok(at > 0, '未找到 Image Descriptor');
		const packed = gif[at + 9];
		assert.strictEqual(packed & 0x80, 0x80, '应使用局部色表');
		const sizeCode = packed & 0x07;
		const lctBytes = 3 * (1 << (sizeCode + 1));
		const minCodeSize = gif[at + 10 + lctBytes];
		const lzw = fromSubBlocks(Array.from(gif.subarray(at + 11 + lctBytes)));
		assert.deepStrictEqual(lzwDecode(lzw, minCodeSize), Array.from(indices),
			'GIF 像素数据往返失真（LZW/子块/色表偏移任一处写错都会命中这里）');
	});

	test('多帧 GIF 体积随帧数增长（局部色表每帧独立写入）', () => {
		const one = encodeGif([mkFrame(1)], W, H, 0).length;
		const three = encodeGif([mkFrame(1), mkFrame(1), mkFrame(1)], W, H, 0).length;
		assert.ok(three > one * 1.5, `多帧未正确写入（1 帧 ${one}B / 3 帧 ${three}B）`);
	});

	test('★ 大色表（128 色 / 7 位码长）真实渐变图往返 0 误差', () => {
		// 回归锚点：小色表（3 色 / sizeCode=1）能通过、大色表却错，是 GIF 编码器
		// 最典型的失败模式（LZW 码长增长、局部色表偏移、minCodeSize 都随色数变化）。
		// 本例走完整真实链路：渐变图 → medianCut(128) → mapToPalette → encodeGif
		// → 解析 Image Descriptor/LCT/子块 → LZW 解码 → 逐像素比对。
		const w = 64;
		const h = 48;
		const rgba = new Uint8Array(w * h * 4);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const i = (y * w + x) * 4;
				rgba[i] = (x * 4) & 0xff;
				rgba[i + 1] = (y * 5) & 0xff;
				rgba[i + 2] = ((x + y) * 3) & 0xff;
				rgba[i + 3] = 255;
			}
		}
		const pal = medianCutPalette(rgba, 128, 1);
		assert.strictEqual(pal.length / 3, 128, 'median-cut 应用满 128 色配额（纯色箱不得提前终止切分）');
		const indices = mapToPaletteIndices(rgba, pal);
		assert.ok(new Set(Array.from(indices)).size > 120, `调色板利用率过低：仅 ${new Set(Array.from(indices)).size} 项被用到`);

		const gif = encodeGif([{ indices, palette: pal, delayCs: 8 }], w, h, 0);
		const at = gif.indexOf(0x2c);
		const packed = gif[at + 9];
		const sizeCode = packed & 0x07;
		assert.strictEqual(sizeCode, 6, '128 色 → Local Color Table Size 字段应为 6（2^7）');
		const lctBytes = 3 * (1 << (sizeCode + 1));
		const minCodeSize = gif[at + 10 + lctBytes];
		assert.strictEqual(minCodeSize, 7, '128 色索引需要 7 位 minCodeSize');
		const lzw = fromSubBlocks(Array.from(gif.subarray(at + 11 + lctBytes)));
		const decoded = lzwDecode(lzw, minCodeSize);
		assert.strictEqual(decoded.length, w * h, `解码像素数不符（得到 ${decoded.length}）`);
		let mismatch = 0;
		for (let i = 0; i < indices.length; i++) { if (decoded[i] !== indices[i]) { mismatch++; } }
		assert.strictEqual(mismatch, 0, `大色表往返有 ${mismatch} 个像素失真`);
	});
});
