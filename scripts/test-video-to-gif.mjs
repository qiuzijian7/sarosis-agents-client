#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  test-video-to-gif.mjs — 「视频转 GIF」端到端验证：真实产出 GIF 文件。
 *
 *  与 TS 单测（videoToGif.test.ts，纯逻辑字节级）互补：本脚本走**真实视频解码**，
 *  证明 videoToGifExecutor 的抽帧链路（HTMLVideoElement seek → canvas drawImage →
 *  getImageData → 量化 → GIF89a 编码）在真实视频上能产出可被浏览器解码的动图。
 *
 *  ## 三层验证
 *  1. 字节结构（node 侧解析）：Header GIF89a / NETSCAPE loop / 每帧 Image Descriptor
 *     数量 == 抽帧数；
 *  2. 真实浏览器解码：img.decode() + drawImage + getImageData，确认非空白（有内容）；
 *  3. 体积/耗时/尺寸/delay 的合理性检查（不写死值，只打印 + 结构性断言）。
 *
 *  ## 用法
 *    node scripts/test-video-to-gif.mjs [videoPath] [fps] [maxFrames] [maxWidth]
 *
 *  默认源 = ComfyUI 最新生成的视频；缺省参数 fps=10 maxFrames=32 maxWidth=480。
 *--------------------------------------------------------------------------------------------*/
import { chromium } from 'playwright';
import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const comfyHostDir = path.join(repoRoot, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'webview', 'src', 'features', 'workflowEditor', 'comfyHost');

const videoPath = process.argv[2]
	|| path.join('D:\\', 'ComfyUI', 'output', 'video', 'MiniMax_H3_i2v_turbo_00004_.mp4');
const fps = Number(process.argv[3] ?? 10);
const maxFrames = Number(process.argv[4] ?? 32);
const maxWidth = Number(process.argv[5] ?? 480);

if (!fs.existsSync(videoPath)) {
	console.error(`[video-to-gif] 视频不存在: ${videoPath}`);
	process.exit(1);
}

// ── 1. esbuild 把纯逻辑 videoToGif.ts 打成浏览器 IIFE（挂 window.__giflib）──
const built = await esbuild.build({
	stdin: {
		contents: `import * as gif from './videoToGif'; (globalThis).__giflib = gif;`,
		resolveDir: comfyHostDir,
		loader: 'ts',
	},
	bundle: true, write: false, format: 'iife', platform: 'browser',
	target: 'chrome120', logLevel: 'silent',
});
const libJs = built.outputFiles[0].text;

const videoBuf = fs.readFileSync(videoPath);
const mime = videoPath.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4';
console.log(`[video-to-gif] 源视频: ${path.basename(videoPath)} (${(videoBuf.length / 1024 / 1024).toFixed(1)}MB)`);
console.log(`[video-to-gif] 参数: fps=${fps} maxFrames=${maxFrames} maxWidth=${maxWidth}`);

// ★ 用系统 Chrome（channel:'chrome'）而非 Playwright 自带 chromium：
//    chromium 默认**不含 H.264 解码器**（专利原因），而 AI 视频模型（MiniMax 等）
//    输出的 mp4 几乎都是 H.264 → 自带 chromium 会报 MEDIA_ERR_SRC_NOT_SUPPORTED。
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });

// ★ 用 route 提供视频（虚拟 URL → 本地文件），而非 data: URL：
//    data: URL 内联 1MB base64 会让 Chrome 渲染进程 OOM → tab 崩溃
//    （Execution context was destroyed）。HTTP 流式加载更贴近真实场景也更稳。
const VIDEO_URL = 'http://video.test.local/input';
await page.route(VIDEO_URL, route => route.fulfill({ body: videoBuf, contentType: mime }));
await page.addScriptTag({ content: libJs });

const t0 = Date.now();
const result = await page.evaluate(async ({ videoUrl, fps, maxFrames, maxWidth }) => {
	const gif = globalThis.__giflib;
	const params = { fps, max_frames: maxFrames, max_width: maxWidth, start_s: 0, end_s: 0, colors: 128, loop: true };

	// fetch → blob → objectURL（同源，canvas 不污染，也是 executor 生产路径）
	const resp = await fetch(videoUrl);
	const blob = await resp.blob();
	const objectUrl = URL.createObjectURL(blob);

	const video = document.createElement('video');
	video.muted = true;
	video.playsInline = true;
	video.preload = 'auto';
	video.src = objectUrl;
	await new Promise((res, rej) => {
		video.addEventListener('loadedmetadata', res, { once: true });
		video.addEventListener('error', () => {
			const codes = { 1: 'ABORTED', 2: 'NETWORK', 3: 'DECODE', 4: 'SRC_NOT_SUPPORTED' };
			rej(new Error(`视频解码失败：${codes[video.error?.code] ?? video.error?.code ?? '?'} ${video.error?.message ?? ''}`));
		}, { once: true });
	});

	const srcW = video.videoWidth || 0;
	const srcH = video.videoHeight || 0;
	if (srcW <= 0 || srcH <= 0) { throw new Error('无法读取视频尺寸'); }

	const plan = gif.planGifFrames(params, video.duration, srcW, srcH);
	const canvas = document.createElement('canvas');
	canvas.width = plan.width;
	canvas.height = plan.height;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) { throw new Error('无法创建 canvas 2d context'); }

	// 逐帧 seek 抽帧（与 videoToGifExecutor.seekTo 同语义：seeked 后等双 rAF，
	//  否则 drawImage 会画黑帧；不用 requestVideoFrameCallback —— 见 executor 该函数注释）
	const seekTo = (t) => new Promise((res, rej) => {
		const onSeeked = () => { video.removeEventListener('seeked', onSeeked); requestAnimationFrame(() => requestAnimationFrame(res)); };
		const onError = () => { video.removeEventListener('seeked', onSeeked); rej(new Error(`seek ${t.toFixed(2)}s 失败`)); };
		video.addEventListener('seeked', onSeeked);
		video.addEventListener('error', onError);
		try { video.currentTime = t; } catch (e) { rej(e); }
	});

	const frames = [];
	const perFrameStats = [];   // 每帧色数（诊断 + 断言「至少一帧内容丰富」）
	for (const t of plan.times) {
		await seekTo(t);
		ctx.drawImage(video, 0, 0, plan.width, plan.height);
		const d = ctx.getImageData(0, 0, plan.width, plan.height).data;
		const rgba = new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
		// 帧内容统计（抽帧即算，避免「编码成功但全是黑帧」的假绿）
		let distinct = new Set();
		let nonZero = 0;
		for (let i = 0; i < d.length; i += 4) {
			distinct.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
			if (d[i] + d[i + 1] + d[i + 2] > 30) { nonZero++; }
		}
		perFrameStats.push({ t: Number(t.toFixed(3)), colors: distinct.size, nonZero });
		const palette = gif.medianCutPalette(rgba, plan.colors);
		frames.push({
			indices: gif.mapToPaletteIndices(rgba, palette),
			palette,
			delayCs: plan.delayCs,
		});
	}
	if (frames.length === 0) { throw new Error('未抽到任何帧'); }

	const gifBytes = gif.encodeGif(frames, plan.width, plan.height, plan.loopCount);

	// Uint8Array → base64（分块避免 String.fromCharCode 栈溢出）
	const u8ToB64 = (u8) => {
		let bin = '';
		const CHUNK = 0x8000;
		for (let i = 0; i < u8.length; i += CHUNK) {
			bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
		}
		return btoa(bin);
	};

	return {
		b64: u8ToB64(gifBytes),
		width: plan.width,
		height: plan.height,
		frameCount: frames.length,
		delayCs: plan.delayCs,
		srcW, srcH,
		duration: Number(video.duration.toFixed(3)),
		times: plan.times.map(t => Number(t.toFixed(3))),
		perFrameStats,
	};
}, { videoUrl: VIDEO_URL, fps, maxFrames, maxWidth });

const elapsed = Date.now() - t0;
const gifBuffer = Buffer.from(result.b64, 'base64');

// ── 2. 写盘 ────────────────────────────────────────────────────────────────
const outDir = path.join(repoRoot, 'generated-images');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `video-to-gif-${Date.now()}.gif`);
fs.writeFileSync(outPath, gifBuffer);

console.log(`\n[video-to-gif] 输出: ${outPath}`);
console.log(`[video-to-gif] 源 ${result.srcW}x${result.srcH} @ ${result.duration}s → GIF ${result.width}x${result.height} x${result.frameCount}帧 (delay=${result.delayCs}cs, 体积=${(gifBuffer.length / 1024).toFixed(1)}KB, 耗时=${elapsed}ms)`);
console.log(`[video-to-gif] 抽帧时间点: ${result.times.join(', ')}s`);

// ── 3. 字节级验证（node 侧，不依赖浏览器）──────────────────────────────────
const assert = (cond, msg) => { if (!cond) { console.error(`  ✗ ${msg}`); process.exitCode = 1; } else { console.log(`  ✓ ${msg}`); } };
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const ascii = (b, o, n) => Buffer.from(b.subarray(o, o + n)).toString('ascii');

/**
 * 顺序解析 GIF 结构数帧数（不能简单数 0x2c 字节：LZW 压缩数据里会随机出现 44）。
 * 从 Header 开始按块长度前进，精确统计 Image Descriptor 数量。
 */
function countGifFrames(buf) {
	let p = 6 + 7;                                   // Header(6) + LSD(7)
	const lsdPacked = buf[10];
	if (lsdPacked & 0x80) { p += 3 * (1 << ((lsdPacked & 0x07) + 1)); }  // GCT
	let frames = 0;
	while (p < buf.length) {
		const b = buf[p];
		if (b === 0x3b) { break; }                   // Trailer
		if (b === 0x21) {                            // Extension：跳过
			p += 2;                                   // 0x21 + label
			while (buf[p] !== 0) { p += 1 + buf[p]; } // sub-blocks
			p += 1;                                   // 0 结束块
		} else if (b === 0x2c) {                     // Image Descriptor
			frames++;
			// ★ Image Descriptor = 10 字节：0x2C + left(2) + top(2) + width(2) +
			//   height(2) + packed(1)。写成 p += 9 会少算 packed 字节 → LCT 偏移错
			//   → minCodeSize 读成 LCT 数据（如 249）→ LZW 子块解析全错。
			p += 10;
			const packed = buf[p - 1];
			if (packed & 0x80) { p += 3 * (1 << ((packed & 0x07) + 1)); }  // LCT
			p += 1;                                   // minCodeSize
			while (buf[p] !== 0) { p += 1 + buf[p]; } // LZW 子块
			p += 1;                                   // 0 结束块
		} else {
			break;
		}
	}
	return frames;
}

console.log('\n[video-to-gif] 字节级验证:');
assert(gifBuffer.length > 0, 'GIF 非空');
assert(ascii(gifBuffer, 0, 6) === 'GIF89a', `Header = "${ascii(gifBuffer, 0, 6)}"`);
assert(u16(gifBuffer, 6) === result.width && u16(gifBuffer, 8) === result.height, `逻辑屏尺寸 ${u16(gifBuffer, 6)}x${u16(gifBuffer, 8)} == 输出 ${result.width}x${result.height}`);

// NETSCAPE2.0 loop 扩展
const nsAt = 13;
assert(ascii(gifBuffer, nsAt + 3, 11) === 'NETSCAPE2.0', '含 NETSCAPE2.0 循环扩展');
assert(u16(gifBuffer, nsAt + 16) === 0, 'loopCount=0（无限循环）');

// Image Descriptor 数量 == 帧数（顺序解析，不数 0x2c 字节）
const imgDesc = countGifFrames(gifBuffer);
assert(imgDesc === result.frameCount, `帧数 ${imgDesc} == 抽帧数 ${result.frameCount}`);
assert(gifBuffer[gifBuffer.length - 1] === 0x3b, 'Trailer = 0x3B');

// 每帧内容断言（抽帧即算的统计）：抓「编码成功但全是黑帧」的假绿
const rich = result.perFrameStats.filter(s => s.colors > 16);
const black = result.perFrameStats.filter(s => s.nonZero < 200);
assert(rich.length >= result.frameCount * 0.8, `至少 80% 帧内容丰富（${rich.length}/${result.frameCount} 帧 >16 色）`);
assert(black.length === 0, `无黑帧（黑帧数 ${black.length}）`);
console.log(`  ✓ 帧内容抽样: ${result.perFrameStats.slice(0, 4).map(s => `t${s.t}s=${s.colors}色`).join(' ')} …`);

// ── 4. 真实浏览器解码验证 ───────────────────────────────────────────────────
// ★ 用 route 提供 GIF（而非 data: URL）：2.4MB base64 作为 evaluate 参数会导致
//   序列化/内存问题，img 可能加载到截断数据（色表损坏 → 首帧大量像素变黑）。
console.log('\n[video-to-gif] 浏览器解码验证:');
const GIF_URL = 'http://gif.test.local/out.gif';
await page.route(GIF_URL, route => route.fulfill({
	body: gifBuffer,
	contentType: 'image/gif',
	headers: { 'Access-Control-Allow-Origin': '*' },   // 让 crossOrigin=anonymous 通过 CORS，canvas 不污染
}));
const decodeCheck = await page.evaluate(async (gifUrl) => {
	const img = new Image();
	img.crossOrigin = 'anonymous';
	img.src = gifUrl;
	try { await img.decode(); } catch (e) { return { ok: false, err: String(e) }; }
	const c = document.createElement('canvas');
	c.width = img.naturalWidth;
	c.height = img.naturalHeight;
	const ctx = c.getContext('2d');
	ctx.drawImage(img, 0, 0);
	const d = ctx.getImageData(0, 0, c.width, c.height).data;
	let distinct = new Set();
	let nonZero = 0;
	for (let i = 0; i < d.length; i += 4) {
		const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
		distinct.add(key);
		if (d[i] + d[i + 1] + d[i + 2] > 30) { nonZero++; }
	}
	return { ok: true, w: img.naturalWidth, h: img.naturalHeight, distinctColors: distinct.size, nonZeroPx: nonZero };
}, GIF_URL);
assert(decodeCheck.ok === true, `浏览器可解码（${decodeCheck.w}x${decodeCheck.h}）`);
assert(decodeCheck.distinctColors > 8, `首帧有真实内容（${decodeCheck.distinctColors} 色，非纯色/空白）`);
assert(decodeCheck.nonZeroPx > 100, `首帧非全黑（非零像素 ${decodeCheck.nonZeroPx}）`);

await browser.close();
console.log(`\n[video-to-gif] ${process.exitCode ? '存在失败断言' : '全部通过'} ✅  GIF 已输出到 ${outPath}`);
