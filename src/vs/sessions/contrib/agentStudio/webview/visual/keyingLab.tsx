/**
 * keyingLab — 抠像算法对比实验室 v3（2026-09-12）。
 *
 * 用法：cd webview && npm run visual → 打开 http://localhost:5599/keying-lab.html
 *      → 选择/拖入绿幕视频（转动态表情包的 I2V 输出）→ 逐帧并排对比 8 种算法
 *      → 「生成 GIF 对比」走产品同一编码链做端到端裁决。
 *
 * v3 新增（用户需求「调研开源抠像算法，对比看哪个效果最好」）：
 *   1. 算法从 3 种扩到 **8 种**，覆盖开源界主流度量：
 *      · rgb / ycbcr / flood / obs-soft —— **产品真实实现**（复用 chromaKeyFrame，非复刻）；
 *      · keylight（Screen Matte：G−max(R,B)，Nuke Keylight 式）；
 *      · hsv（色相 + 饱和度，GIMP/通用 HSL keyer 式）；
 *      · lab（CIE Lab ΔE76 感知色差）；
 *      · chroma2d（归一化色度 (r,g,b)/Σ，经典 chromaticity keyer）。
 *   2. `greenDominance` 可调（此前硬编码缺省值 —— 它对浅色/白色主体影响极大）。
 *   3. 「自动采样幕色」（取首帧四边 —— 与产品 chroma_color='auto' 同款）。
 *   4. 每列显示**抠除比例**（快速判断「是不是抠过头了」）。
 *   5. 底部**调研结论表**：经典算法 vs 神经抠像（RVM/MODNet/BiRefNet/RMBG/PP-Matting/BEN2/SAM2）
 *      的来源、是否需模型、适用场景 —— 说明「为什么这些模型不在本页里跑」。
 *
 * ★ 公平性约定：所有算法都吃同一组 (similarity, smoothness, greenDominance)，
 *   且 `similarity/smoothness` 都按**各自度量的动态范围**换算（t1 = sim·dMax，
 *   t2 = t1 + smooth·dMax）—— 差异只体现在**度量本身**，不是阈值口径。
 */

import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { chromaKeyFrame, autoSampleChromaKeyRgba, CHROMA_KEY_ALGOS, type ChromaKeyAlgo, parseHexColor } from '../src/features/workflowEditor/comfyHost/videoToGifExecutor.js';
import { encodeGif, medianCutPalette, mapToPaletteIndicesWithAlpha, type GifFrameInput } from '../src/features/workflowEditor/comfyHost/videoToGif.js';

type Rgb = { r: number; g: number; b: number };

/** 本页算法 id：产品三算法 + OBS 软边 + 4 种开源经典度量 + 线性反混合。 */
type LabAlgo = 'raw' | 'rgb' | 'flood' | 'ycbcr' | 'obs-soft' | 'keylight' | 'hsv' | 'lab' | 'chroma2d' | 'unmix';

interface LabAlgoMeta {
	id: LabAlgo;
	label: string;
	/** 出处 / 依据（调研结论的一部分）。 */
	source: string;
	/** 一句话原理（决定「什么时候该选它」）。 */
	tip: string;
	/** 是否走产品真实实现（chromaKeyFrame）。 */
	product?: boolean;
}

const LAB_ALGOS: LabAlgoMeta[] = [
	{ id: 'rgb', label: 'RGB 色距', source: 'OBS「Chroma Key」/ ffmpeg colorkey 同族', tip: 'RGB 立方体欧氏距离 + 绿色优势清除。通用，但对亮度敏感（绿幕明暗不匀时阈值漂移）。', product: true },
	{ id: 'ycbcr', label: 'YCbCr 色度', source: 'BT.601；Blender「Keying → Chroma」同思路', tip: '只在 Cb/Cr 色度平面比距离 —— 与亮度解耦，绿幕打光不匀（阴影/渐变）时最稳。', product: true },
	{ id: 'flood', label: '泛洪连通', source: '连通域（本实现）；同类见 GIMP「按颜色选择 + 连通」', tip: '从画面四边 BFS，只吃「与背景连通」的绿 —— 主体内部的绿色元素零误伤；但外侧被背景包围的浅色元素（泡泡）照样会被吃掉。', product: true },
	{ id: 'obs-soft', label: 'OBS 软边', source: 'OBS chroma key shader（距离场盒滤 + pow 软 alpha）', tip: '连续软 alpha（不二值化）+ 距离场 5×5 平滑 —— 边缘最自然，适合有半透明/抗锯齿元素的素材。产品「② 抠图」预览用的就是它。', product: true },
	{ id: 'keylight', label: 'Screen Matte', source: 'Nuke Keylight 式 screen matte（G − max(R,B)）', tip: '把「绿相对于红蓝的优势」当遮罩：G−max(R,B) 越接近幕布值越是背景。对绿色主导的溢出最敏感，白描边/灰白发保留好。' },
	{ id: 'hsv', label: 'HSV 色相', source: 'GIMP / 通用 HSL keyer 式', tip: '按色相角 + 饱和度判定 —— 只认「绿这个颜色」，对绿幕明暗完全不敏感；主体含绿色时最容易误伤。' },
	{ id: 'lab', label: 'CIE Lab ΔE76', source: 'CIELAB 感知色差（ΔE76）', tip: '在感知均匀空间比距离 —— 对深色/浅色过渡更公平，边缘过渡带通常更平滑，但计算量最大（本页 ~3× 于 rgb）。' },
	{ id: 'chroma2d', label: '归一化色度', source: '经典 chromaticity keyer（(r,g,b)/Σ）', tip: '把颜色投影到「色度坐标」再比距离 —— 亮度被除掉，与 ycbcr 同族但用 RGB 轴表达；对灰白主体宽容。' },
	{ id: 'unmix', label: '★ 线性反混合', source: 'two-screen matting 的单背景退化式（C = a·F + (1−a)·B 反解）', tip: '★ 渐变透明的正解：用 g(C)=G−max(R,B) 投影**连续反解** a = 1 − g(C)/g(B)，再把幕布贡献按 (1−a) 减掉恢复前景色 —— 不猜阈值、不硬钳 G，半透明像素的 alpha 是算出来的（其余算法都是「按色距猜 alpha」，半透明叠绿幕时必然猜错 ✗）。前提：幕布纯绿且前景本身不绿。' },
];

const PREVIEW_FRAMES = 12;
const FRAME_SLOTS = 64;

/** 透明区棋盘底（与产品编辑器同款）。 */
const checkerStyle: React.CSSProperties = {
	backgroundImage:
		'linear-gradient(45deg, #2b2d33 25%, transparent 25%),' +
		'linear-gradient(-45deg, #2b2d33 25%, transparent 25%),' +
		'linear-gradient(45deg, transparent 75%, #2b2d33 75%),' +
		'linear-gradient(-45deg, transparent 75%, #2b2d33 75%)',
	backgroundSize: '12px 12px',
	backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0px',
	backgroundColor: '#232428',
};

// ═══════════════════════════════════════════════════════════════════════════
// 开源经典度量的**自实现**（产品里没有的部分）。
// 统一契约：输入 RGBA + 参数 → 就地写 alpha（0..255，可软可硬）。
// 与产品一致：d < t1 → 全透明；d > t2 → 保留；中间按 pow 1.5 曲线（软 alpha）。
// ═══════════════════════════════════════════════════════════════════════════

/** RGB → CIE Lab（sRGB / D65）。 */
function rgbToLab(r: number, g: number, b: number): [number, number, number] {
	const f = (v: number): number => {
		const c = v / 255;
		return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	};
	const R = f(r), G = f(g), B = f(b);
	// sRGB → XYZ（D65）
	const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
	const Y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
	const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
	const h = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
	const fx = h(X), fy = h(Y), fz = h(Z);
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** RGB → HSV（h ∈ [0,1)）。 */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
	const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
	const d = mx - mn;
	let h = 0;
	if (d > 0) {
		if (mx === r) { h = ((g - b) / d + 6) % 6; }
		else if (mx === g) { h = (b - r) / d + 2; }
		else { h = (r - g) / d + 4; }
		h /= 6;
	}
	return [h, mx === 0 ? 0 : d / mx, mx / 255];
}

/** 统一软 alpha 应用（与产品软边路径同款曲线）。 */
function applyMetricAlpha(
	rgba: Uint8Array, n: number, d: Float32Array, t1: number, t2: number,
	greenDominate: number,
): number {
	const band = Math.max(1e-6, t2 - t1);
	let removed = 0;
	for (let p = 0; p < n; p++) {
		const i = p * 4;
		if (rgba[i + 3] === 0) { removed++; continue; }
		const g = rgba[i + 1], r = rgba[i], b = rgba[i + 2];
		const gExcess = g - Math.max(r, b);
		// 真绿溢（色距超阈值但 G 明显主导）→ 直接透明（与产品硬路径语义一致）
		if (d[p] < t1 || (d[p] >= t2 && gExcess > greenDominate && g > 60)) {
			rgba[i + 3] = 0; removed++;
			continue;
		}
		if (d[p] < t2) {
			const k = Math.pow(Math.min(1, Math.max(0, (d[p] - t1) / band)), 1.5);
			rgba[i + 3] = Math.round(rgba[i + 3] * k);
			if (rgba[i + 3] === 0) { removed++; }
		}
	}
	// despill（OBS 式局部去饱和：半透明边缘向灰度混合，不透明像素钳 G）
	for (let i = 0; i < rgba.length; i += 4) {
		const a = rgba[i + 3];
		if (a === 0) { continue; }
		const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
		if (a < 255) {
			const k = a / 255;
			const gray = 0.299 * r + 0.587 * g + 0.114 * b;
			rgba[i] = gray * (1 - k) + r * k;
			rgba[i + 1] = gray * (1 - k) + g * k;
			rgba[i + 2] = gray * (1 - k) + b * k;
		} else if (g > Math.max(r, b)) {
			rgba[i + 1] = Math.max(r, b);
		}
	}
	return removed;
}

/**
 * Screen Matte（Nuke Keylight 式）：`screen = G − max(R,B)`。
 * 幕布绿 → screen ≈ 幕布值（如 rgb(0,212,0) → 212）；主体 → 0 或负。
 * 距离 = |screen − screenKey|（0..255）—— 只关心「绿色优势」，与亮度无关。
 */
function keyByScreenMatte(rgba: Uint8Array, key: Rgb, sim: number, smooth: number, gd: number): number {
	const n = rgba.length / 4;
	const dMax = 255;
	const kScreen = key.g - Math.max(key.r, key.b);
	const d = new Float32Array(n);
	for (let p = 0; p < n; p++) {
		const i = p * 4;
		d[p] = Math.abs((rgba[i + 1] - Math.max(rgba[i], rgba[i + 2])) - kScreen);
	}
	return applyMetricAlpha(rgba, n, d, sim * dMax, (sim + smooth) * dMax, gd);
}

/** HSV 色相 + 饱和度距离（色相角差 + 饱和度差，归一化到 0..255·√2）。 */
function keyByHsv(rgba: Uint8Array, key: Rgb, sim: number, smooth: number, gd: number): number {
	const n = rgba.length / 4;
	const dMax = 255 * Math.SQRT2;
	const [kh, ks] = rgbToHsv(key.r, key.g, key.b);
	const d = new Float32Array(n);
	for (let p = 0; p < n; p++) {
		const i = p * 4;
		const [h, s] = rgbToHsv(rgba[i], rgba[i + 1], rgba[i + 2]);
		let dh = Math.abs(h - kh);
		if (dh > 0.5) { dh = 1 - dh; }          // 色相环
		d[p] = 255 * Math.hypot(dh, s - ks);
	}
	return applyMetricAlpha(rgba, n, d, sim * dMax, (sim + smooth) * dMax, gd);
}

/** CIE Lab ΔE76 距离。 */
function keyByLab(rgba: Uint8Array, key: Rgb, sim: number, smooth: number, gd: number): number {
	const n = rgba.length / 4;
	const dMax = 374;                            // Lab 空间对角线（L 100 / a,b ±128）
	const [kL, kA, kB] = rgbToLab(key.r, key.g, key.b);
	const d = new Float32Array(n);
	for (let p = 0; p < n; p++) {
		const i = p * 4;
		const [L, A, B] = rgbToLab(rgba[i], rgba[i + 1], rgba[i + 2]);
		d[p] = Math.hypot(L - kL, A - kA, B - kB);
	}
	return applyMetricAlpha(rgba, n, d, sim * dMax, (sim + smooth) * dMax, gd);
}

/** 归一化色度（(r,g,b)/Σ）距离 —— 亮度被除掉。 */
function keyByChroma2d(rgba: Uint8Array, key: Rgb, sim: number, smooth: number, gd: number): number {
	const n = rgba.length / 4;
	const dMax = 255 * Math.SQRT2;
	const kSum = Math.max(1, key.r + key.g + key.b);
	const knr = key.r / kSum, kng = key.g / kSum;
	const d = new Float32Array(n);
	for (let p = 0; p < n; p++) {
		const i = p * 4;
		const s = Math.max(1, rgba[i] + rgba[i + 1] + rgba[i + 2]);
		d[p] = 255 * Math.hypot(rgba[i] / s - knr, rgba[i + 1] / s - kng);
	}
	return applyMetricAlpha(rgba, n, d, sim * dMax, (sim + smooth) * dMax, gd);
}

/**
 * ★★ 线性反混合（un-multiply keying）——**渐变透明**的正解。
 *
 * 合成模型（绿幕前合成，唯一真源）：
 *     C = a·F + (1−a)·B        （C 观测到的像素、F 前景真色、B 幕布色、a 前景不透明度）
 *
 * 这是 **1 个方程 2 个未知数**（a 与 F）—— 单张图**数学上欠定** ✗。所有「按色距
 * 猜 alpha」的算法（rgb/ycbcr/hsv/lab/keylight 阈值版…）都是在**猜** a，遇到
 * 「半透明元素叠在绿幕上」必然猜错：像素只是「淡一点的绿」⇒ 被当成背景删掉 ✗。
 *
 * 但绿幕给了**额外约束**：取「绿色优势」投影 g(x) = x_g − max(x_r, x_b)，
 * 并假设**前景本身不绿**（g(F) ≈ 0，对绝大多数素材成立）：
 *     g(C) = a·g(F) + (1−a)·g(B) ≈ (1−a)·g(B)
 *  ⇒  **a = 1 − g(C)/g(B)**   ← 连续、闭式、无需阈值 ✓
 * 再反解前景色（去溢色 = 把幕布贡献按 (1−a) 减掉，而不是硬钳 G）：
 *     **F = (C − (1−a)·B) / a**
 *
 * 于是「半透明泡泡」的 alpha 与真色都能被**算出来** ✓（渐变透明天然成立）。
 * · `sim` 作**背景地板**：a_raw ≤ sim 判为纯背景 → alpha=0 ⇒ 绿幕清除干净 ✓
 *   （地板之上的渐变一律保留，不做二值化 ✗）
 * · 真实素材有 H.264 4:2:0 色度下采样 + 噪声 ⇒ 结果仍需要一点空间平滑，
 *   但那是「去噪」，不是「靠阈值猜」✓
 *
 * ★ 与 two-screen matting 的关系：拍两次（绿幕 + 另一种幕）可得两方程两未知数，
 *   精确解 a = 1 − (C₁−C₂)/(B₁−B₂)、F = (C₁−(1−a)B₁)/a。本式是它在
 *   「第二个幕是**黑**（即 B₂=0，a·F 那一路）」下的退化式 —— 对 I2V 素材无需二次生成。
 */
function keyByUnmix(rgba: Uint8Array, key: Rgb, sim: number): number {
	const n = rgba.length / 4;
	const gB = key.g - Math.max(key.r, key.b);      // 幕布的绿色优势（纯绿 ≈ 255）
	let removed = 0;
	if (gB <= 20) { return 0; }                      // 幕布不是绿色主导 → 本算法不适用
	for (let p = 0; p < n; p++) {
		const i = p * 4;
		const cr = rgba[i], cg = rgba[i + 1], cb = rgba[i + 2];
		const aRaw = 1 - (cg - Math.max(cr, cb)) / gB;
		if (!(aRaw > sim)) { rgba[i + 3] = 0; removed++; continue; }   // 背景地板 → 清干净
		const a = Math.min(1, aRaw);
		const inv = 1 - a;
		// 反混合：把幕布贡献按 (1−a) 减掉（比「钳 G」更准，且保留真实色相）
		let fr = Math.max(0, Math.min(255, Math.round((cr - inv * key.r) / a)));
		let fg = Math.max(0, Math.min(255, Math.round((cg - inv * key.g) / a)));
		let fb = Math.max(0, Math.min(255, Math.round((cb - inv * key.b) / a)));
		// ★ 补一道 despill（2026-09-12 用户实测「仍然有绿色」）：反混合只减掉**幕布合成
		//   贡献**；若前景自身仍带绿（I2V 渲染时的绿溢 / 幕布环境反射，半透明元素最明显），
		//   不透明/高 alpha 区会留下可见绿 ✗。这里把「超量绿」按 (1−SPILL_KEEP) 压回：
		//   g = G − max(R,B) 的超出部分只保留 15% —— 与产品软边路径的 despill 同语义。
		const gEx = fg - Math.max(fr, fb);
		if (gEx > 0) { fg = Math.max(fr, fb) + gEx * 0.15; }
		// ★★ 低 alpha 的**颜色不可信**（2026-09-12 实测定位「仍然有绿色」的真正来源）：
		//   实测某帧「反混合输出 alpha 32~220 的像素」源帧 RGB ≈ (22,196,29)（绿占 g(B) 的
		//   79% ⇒ a≈0.21），此时 `F = (C − (1−a)·B)/a` 的 1/a ≈ **4.8× 放大** ——
		//   H.264 4:2:0 色度下采样 + 量化的色度误差被一起放大 ⇒ 反混合出来的颜色是**噪声**
		//   （实测偏青绿 (106,140,140)，用户看到的就是这个「绿」✗），而不是元素真色。
		//   物理上也成立：a 很小时 79% 的信息来自幕布，颜色本身**不可解** ✗。
		//   做法：按 (1 − a/LOW_A) 把颜色往**自身灰度**靠（a ≥ LOW_A 完全不处理）——
		//   低 alpha 区变成「淡淡的灰白」，既无绿也无彩噪 ✓，且视觉上几乎看不出差别
		//   （它本来就只有 ~20% 不透明度）。
		const LOW_A = 0.5;
		if (a < LOW_A) {
			const k = 0.85 * (1 - a / LOW_A);
			const gy = 0.299 * fr + 0.587 * fg + 0.114 * fb;
			fr += (gy - fr) * k; fg += (gy - fg) * k; fb += (gy - fb) * k;
		}
		rgba[i] = Math.round(fr); rgba[i + 1] = Math.round(fg); rgba[i + 2] = Math.round(fb);
		rgba[i + 3] = Math.round(a * 255);
	}
	return removed;
}

/** 泛洪连通（自实现，与产品 keyPrimaryFlood 同思路）：只吃与四边连通的背景。 */
function keyByFlood(rgba: Uint8Array, W: number, H: number, key: Rgb, sim: number, smooth: number): number {
	const n = W * H;
	const t2 = (sim + smooth) * 441.67;
	const visited = new Uint8Array(n);
	const stack: number[] = [];
	const dist = (i: number): number => Math.hypot(rgba[i] - key.r, rgba[i + 1] - key.g, rgba[i + 2] - key.b);
	const seed = (x: number, y: number): void => {
		const p = y * W + x;
		if (visited[p]) { return; }
		if (rgba[p * 4 + 3] !== 0 && dist(p * 4) < t2) { visited[p] = 1; stack.push(p); }
	};
	seed(0, 0); seed(W - 1, 0); seed(0, H - 1); seed(W - 1, H - 1);
	seed(W >> 1, 0); seed(W >> 1, H - 1); seed(0, H >> 1); seed(W - 1, H >> 1);
	let removed = 0;
	while (stack.length) {
		const cur = stack.pop() as number;
		rgba[cur * 4 + 3] = 0; removed++;
		const cy = (cur / W) | 0, cx = cur - cy * W;
		const push = (j: number): void => {
			if (visited[j]) { return; }
			if (rgba[j * 4 + 3] !== 0 && dist(j * 4) < t2) { visited[j] = 1; stack.push(j); }
		};
		if (cx > 0) { push(cur - 1); }
		if (cx + 1 < W) { push(cur + 1); }
		if (cy > 0) { push(cur - W); }
		if (cy + 1 < H) { push(cur + W); }
	}
	return removed;
}

/**
 * 统一入口：按算法抠像。返回「被抠掉的像素数」（用于算抠除比例）。
 * ★ 产品算法（rgb/flood/ycbcr/obs-soft）走**真实实现** `chromaKeyFrame` ✓；
 *   其余为本页自实现（同契约、同参数口径）。
 */
function runAlgo(
	algo: LabAlgo, rgba: Uint8Array, W: number, H: number,
	key: Rgb, sim: number, smooth: number, gd: number,
): number {
	const n = rgba.length / 4;
	if (algo === 'raw') { return 0; }
	if (algo === 'flood') {
		// 产品 flood（硬路径 + 后处理）
		chromaKeyFrame(rgba, key, sim, smooth, 'flood', { greenDominance: gd });
		let removed = 0;
		for (let p = 0; p < n; p++) { if (rgba[p * 4 + 3] === 0) { removed++; } }
		return removed;
	}
	if (algo === 'obs-soft') {
		chromaKeyFrame(rgba, key, sim, smooth, 'rgb', { boxFilterDistance: true, softAlpha: true, greenDominance: gd });
		let removed = 0;
		for (let p = 0; p < n; p++) { if (rgba[p * 4 + 3] === 0) { removed++; } }
		return removed;
	}
	if (algo === 'rgb' || algo === 'ycbcr') {
		chromaKeyFrame(rgba, key, sim, smooth, algo as ChromaKeyAlgo, { greenDominance: gd });
		let removed = 0;
		for (let p = 0; p < n; p++) { if (rgba[p * 4 + 3] === 0) { removed++; } }
		return removed;
	}
	switch (algo) {
		case 'keylight': return keyByScreenMatte(rgba, key, sim, smooth, gd);
		case 'hsv': return keyByHsv(rgba, key, sim, smooth, gd);
		case 'lab': return keyByLab(rgba, key, sim, smooth, gd);
		case 'chroma2d': return keyByChroma2d(rgba, key, sim, smooth, gd);
		case 'unmix': return keyByUnmix(rgba, key, sim);
		default: return keyByFlood(rgba, W, H, key, sim, smooth);
	}
}

/** 量化 + 编码一帧序列 → GIF blob URL（与产品 level0 档同参数：240² / 128 色）。 */
function encodeFramesToGif(frames: Uint8Array[], w: number, h: number, delayCs: number): { url: string; bytes: number } {
	const gifFrames: GifFrameInput[] = frames.map((rgba) => {
		const palette = medianCutPalette(rgba, 128, 4, true);
		const transparentIndex = palette.length / 3;
		const padded = new Uint8Array((transparentIndex + 1) * 3);
		padded.set(palette);
		return {
			indices: mapToPaletteIndicesWithAlpha(rgba, palette, transparentIndex),
			palette: padded,
			delayCs,
			transparentIndex,
		};
	});
	const gif = encodeGif(gifFrames, w, h, 0);
	const blob = new Blob([gif as unknown as BlobPart], { type: 'image/gif' });
	return { url: URL.createObjectURL(blob), bytes: blob.size };
}

/** 调研结论表数据（经典算法 + 神经抠像）。 */
const RESEARCH: Array<{ name: string; kind: string; needModel: string; source: string; note: string }> = [
	{ name: 'Chroma Key（RGB 色距）', kind: '经典', needModel: '否', source: 'OBS Studio / ffmpeg colorkey / GIMP', note: '最通用；亮度不均时阈值漂移，靠 similarity/smoothness 手调。' },
	{ name: 'Chroma Key（YCbCr 色度）', kind: '经典', needModel: '否', source: 'BT.601；Blender「Keying → Chroma」', note: '与亮度解耦 —— 绿幕打光不匀时首选。' },
	{ name: 'Color Difference / Screen Matte', kind: '经典', needModel: '否', source: 'Nuke Keylight；Blender「Keying → Color Difference」', note: '只吃「绿相对红蓝的优势」，对绿色溢出最敏感、对灰白主体最友好。' },
	{ name: 'Hue / HSL Keyer', kind: '经典', needModel: '否', source: 'GIMP / Kdenlive / 通用 HSL keyer', note: '只认颜色不认亮度；主体含绿色时误伤最大。' },
	{ name: 'Perceptual ΔE（CIELAB/ΔE2000）', kind: '经典', needModel: '否', source: 'CIELAB ΔE76 / ΔE2000', note: '感知均匀空间，边缘过渡更自然；计算量大。' },
	{ name: '连通域 / Flood Keyer', kind: '经典', needModel: '否', source: 'GIMP 按颜色选择（连通）；本实现', note: '保护主体内部同类色；但被背景包围的浅色元素仍会被吃掉。' },
	{ name: '线性反混合（un-multiply）', kind: '经典·物理反解', needModel: '否', source: 'C = a·F + (1−a)·B 反解；two-screen matting 的单幕退化式', note: '★ 唯一能正确处理**渐变透明**的经典算法：a = 1 − g(C)/g(B) 连续求解，再按 (1−a) 减掉幕布贡献恢复真色。前提：幕布纯绿 + 前景本身不绿。' },
	{ name: 'Two-screen Matting（双幕）', kind: '经典·精确解', needModel: '否（但要生成两次）', source: '两次拍摄/生成不同背景色（绿 + 品红/黑）', note: '两方程两未知数 ⇒ a、F **精确可解**（a = 1 − (C₁−C₂)/(B₁−B₂)）。代价：2× 生成 + 两次动作必须严格对齐（I2V 很难保证）✗。' },
	{ name: 'Robust Video Matting (RVM)', kind: '神经·视频', needModel: '是（ONNX/Torch，可 Web 跑）', source: 'github.com/PeterL1n/RobustVideoMatting（MIT）', note: '时序 RNN，视频稳定性最好；**不需要绿幕**。有官方 Web/ONNX demo。' },
	{ name: 'MODNet', kind: '神经·人像', needModel: '是', source: 'github.com/ZHKKKe/MODNet', note: '轻量人像抠像，实时；对非人主体弱。' },
	{ name: 'BiRefNet', kind: '神经·通用', needModel: '是', source: 'github.com/ZhengPeng7/BiRefNet', note: '当前开源里**发丝级细节**最强的一档；显存/算力要求高。' },
	{ name: 'RMBG-2.0', kind: '神经·通用', needModel: '是（非商用许可）', source: 'huggingface.co/briaai/RMBG-2.0', note: '通用前景分割效果好、生态成熟；注意许可是非商用。' },
	{ name: 'PP-Matting / PP-MattingV2', kind: '神经·通用', needModel: '是（PaddleSeg）', source: 'github.com/PaddlePaddle/PaddleSeg', note: '高精度（含高分辨率 trimap-free），服务端部署常见。' },
	{ name: 'BEN2', kind: '神经·通用', needModel: '是', source: 'github.com/PramaLLC/BEN2', note: '低延迟，适合实时视频/批量。' },
	{ name: 'SAM 2', kind: '神经·交互', needModel: '是', source: 'github.com/facebookresearch/sam2', note: '点/框提示的通用分割，适合「按需抠指定主体」；不是自动抠像。' },
];

function App(): React.ReactElement {
	const [videoUrl, setVideoUrl] = React.useState<string>('');
	const [videoName, setVideoName] = React.useState<string>('');
	const [frameIdx, setFrameIdx] = React.useState(0);
	const [similarity, setSimilarity] = React.useState(0.2);
	const [smoothness, setSmoothness] = React.useState(0.08);
	const [greenDom, setGreenDom] = React.useState(90);
	const [keyColor, setKeyColor] = React.useState('#00FF00');
	const [autoKey, setAutoKey] = React.useState(true);
	const [diag, setDiag] = React.useState(false);
	const [durations, setDurations] = React.useState(0);
	const [gifBusy, setGifBusy] = React.useState(false);
	const [gifPick, setGifPick] = React.useState<Set<LabAlgo>>(() => new Set<LabAlgo>(['rgb', 'ycbcr', 'flood', 'obs-soft']));
	const [gifResults, setGifResults] = React.useState<Map<LabAlgo, { url: string; bytes: number; ms: number }>>(() => new Map());
	const [msStats, setMsStats] = React.useState<Map<LabAlgo, number>>(() => new Map());
	const [removedPct, setRemovedPct] = React.useState<Map<LabAlgo, number>>(() => new Map());
	/** ★ 半透明像素占比（0<alpha<255）——「渐变透明能力」的量化指标：
	 *  二值化型算法≈0 ✗，线性反混合显著 >0 ✓（用户问「渐变透明怎么抠」时一眼可比）。 */
	const [softPct, setSoftPct] = React.useState<Map<LabAlgo, number>>(() => new Map());
	const videoRef = React.useRef<HTMLVideoElement | null>(null);
	const canvasRefs = React.useRef<Map<LabAlgo, HTMLCanvasElement | null>>(new Map());
	const rawCanvasRef = React.useRef<HTMLCanvasElement | null>(null);

	/** 统一的载入入口（文件 / 内置示例 / 未来的 URL 参数都用它）。 */
	const loadVideoFromUrl = (url: string, name: string): void => {
		if (videoUrl) { URL.revokeObjectURL(videoUrl); }
		setVideoUrl(url);
		setVideoName(name);
		setFrameIdx(0);
		setGifResults(new Map());
	};

	const loadVideo = (file: File): void => loadVideoFromUrl(URL.createObjectURL(file), file.name);

	/** ★ 内置示例（`visual/dist/sample-greenscreen.mp4`，该目录已 gitignore）：
	 *  一键载入免去「先找文件再拖进来」——把 `--serve` 起的服务当对比工作台用。 */
	const loadSample = async (): Promise<void> => {
		try {
			const r = await fetch('./sample-greenscreen.mp4');
			if (!r.ok) { return; }
			loadVideoFromUrl(URL.createObjectURL(await r.blob()), 'sample-greenscreen.mp4（内置示例）');
		} catch { /* 没有示例文件则静默忽略 */ }
	};

	React.useEffect(() => {
		const v = videoRef.current;
		if (!v || !videoUrl) { return; }
		const onMeta = (): void => setDurations(v.duration || 0);
		v.addEventListener('loadedmetadata', onMeta);
		return () => v.removeEventListener('loadedmetadata', onMeta);
	}, [videoUrl]);

	/** seek 到帧位并等待 seeked。 */
	const seekTo = async (v: HTMLVideoElement, t: number): Promise<void> => {
		await new Promise<void>((res) => {
			const onSeek = (): void => { v.removeEventListener('seeked', onSeek); res(); };
			v.addEventListener('seeked', onSeek);
			v.currentTime = t;
		});
	};

	const frameTime = (i: number): number => Math.min(durations * (i + 0.5) / FRAME_SLOTS, Math.max(0, durations - 0.05));

	// 帧渲染：原始帧 + 各算法并排（同一帧、同一组参数 → 差异只在算法本身）
	React.useEffect(() => {
		const v = videoRef.current;
		if (!v || !videoUrl || durations <= 0) { return; }
		let canceled = false;
		void (async () => {
			await seekTo(v, frameTime(frameIdx));
			if (canceled) { return; }
			const srcW = v.videoWidth || 640;
			const srcH = v.videoHeight || 360;
			const raw = rawCanvasRef.current;
			if (raw) {
				raw.width = srcW; raw.height = srcH;
				raw.getContext('2d')?.drawImage(v, 0, 0, srcW, srcH);
			}
			// 幕色：自动 = 从该帧四边采样（与产品 chroma_color='auto' 同款）
			let key: Rgb = parseHexColor(keyColor);
			if (autoKey) {
				const probe = document.createElement('canvas');
				probe.width = srcW; probe.height = srcH;
				const pctx = probe.getContext('2d', { willReadFrequently: true });
				if (pctx) {
					pctx.drawImage(v, 0, 0, srcW, srcH);
					const pd = pctx.getImageData(0, 0, srcW, srcH);
					key = autoSampleChromaKeyRgba(new Uint8Array(pd.data.buffer.slice(0)), srcW, srcH);
					if (!canceled) { setKeyColor(`#${[key.r, key.g, key.b].map(x => x.toString(16).padStart(2, '0')).join('')}`); }
				}
			}
			const ms = new Map<LabAlgo, number>();
			const pct = new Map<LabAlgo, number>();
			const soft = new Map<LabAlgo, number>();
			for (const meta of LAB_ALGOS) {
				const cv = canvasRefs.current.get(meta.id);
				if (!cv) { continue; }
				cv.width = srcW; cv.height = srcH;
				const ctx = cv.getContext('2d', { willReadFrequently: true });
				if (!ctx) { continue; }
				ctx.drawImage(v, 0, 0, srcW, srcH);
				const data = ctx.getImageData(0, 0, srcW, srcH);
				const rgba = new Uint8Array(data.data.buffer.slice(0));
				const t0 = performance.now();
				const removed = runAlgo(meta.id, rgba, srcW, srcH, key, similarity, smoothness, greenDom);
				ms.set(meta.id, Math.round((performance.now() - t0) * 10) / 10);
				pct.set(meta.id, Math.round(removed / (srcW * srcH) * 1000) / 10);
				// 半透明像素统计（必须在诊断高亮**之前**：诊断会把被抠像素写成 alpha=160 ✗）
				let softN = 0;
				for (let q = 3; q < rgba.length; q += 4) { const a = rgba[q]; if (a > 0 && a < 255) { softN++; } }
				soft.set(meta.id, Math.round(softN / (srcW * srcH) * 1000) / 10);
				if (diag) {
					for (let p = 0; p < rgba.length; p += 4) {
						if (rgba[p + 3] === 0) { rgba[p] = 255; rgba[p + 1] = 40; rgba[p + 2] = 40; rgba[p + 3] = 160; }
					}
				}
				ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer), srcW, srcH), 0, 0);
			}
			if (!canceled) { setMsStats(ms); setRemovedPct(pct); setSoftPct(soft); }
		})();
		return () => { canceled = true; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [videoUrl, durations, frameIdx, similarity, smoothness, greenDom, keyColor, autoKey, diag]);

	/** 🎞 GIF 端到端对比：当前帧位附近取 PREVIEW_FRAMES 帧 → 勾选算法编码真 GIF。 */
	const runGifCompare = async (): Promise<void> => {
		const v = videoRef.current;
		if (!v || !videoUrl || durations <= 0 || gifBusy) { return; }
		setGifBusy(true);
		const out = new Map<LabAlgo, { url: string; bytes: number; ms: number }>();
		try {
			const srcW = v.videoWidth || 640;
			const srcH = v.videoHeight || 360;
			const scale = Math.min(1, 240 / Math.max(srcW, srcH));
			const w = Math.max(16, Math.round(srcW * scale / 2) * 2);
			const h = Math.max(16, Math.round(srcH * scale / 2) * 2);
			const key = parseHexColor(keyColor);
			for (const meta of LAB_ALGOS) {
				if (!gifPick.has(meta.id)) { continue; }
				const t0 = performance.now();
				const frames: Uint8Array[] = [];
				for (let f = 0; f < PREVIEW_FRAMES; f++) {
					await seekTo(v, frameTime((frameIdx + f) % FRAME_SLOTS));
					const cv = document.createElement('canvas');
					cv.width = w; cv.height = h;
					const ctx = cv.getContext('2d', { willReadFrequently: true });
					if (!ctx) { continue; }
					ctx.drawImage(v, 0, 0, w, h);
					const data = ctx.getImageData(0, 0, w, h).data;
					const rgba = new Uint8Array(data.buffer.slice(0));
					runAlgo(meta.id, rgba, w, h, key, similarity, smoothness, greenDom);
					frames.push(rgba);
				}
				const enc = encodeFramesToGif(frames, w, h, 8);
				out.set(meta.id, { url: enc.url, bytes: enc.bytes, ms: Math.round(performance.now() - t0) });
			}
			setGifResults(out);
		} finally {
			setGifBusy(false);
		}
	};

	const onDrop = (e: React.DragEvent): void => {
		e.preventDefault();
		const f = Array.from(e.dataTransfer.files).find(x => x.type.startsWith('video/') || /\.(mp4|mov|webm|gif)$/i.test(x.name));
		if (f) { loadVideo(f); }
	};

	return (
		<div onDragOver={(e) => e.preventDefault()} onDrop={onDrop}
			style={{ fontFamily: 'system-ui, sans-serif', color: '#e8e8e8', background: '#141518', minHeight: '100vh', padding: 16 }}>
			<h2 style={{ margin: '0 0 4px', fontSize: 16 }}>🧪 抠像算法对比实验室 v3
				<span style={{ fontSize: 11, color: '#9a9a9a', marginLeft: 8 }}>
					8 种算法并排 · 4 种为产品真实实现（chromaKeyFrame）· GIF 端到端裁决
				</span>
			</h2>
			<div style={{ fontSize: 11, color: '#9a9a9a', marginBottom: 10, lineHeight: 1.7 }}>
				选择/拖入绿幕视频 → 逐帧并排对比。<b style={{ color: '#fbbf24' }}>诊断模式</b>：被抠像素标红（主体内部出现红色 = 误伤）。
				各列角标给出<b>抠除比例</b>与耗时；「抠除比例」突高的一列通常就是「抠过头」的那个 ✗。
			</div>

			<div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
				<input type="file" accept="video/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) { loadVideo(f); } }} style={{ fontSize: 11, color: '#ccc' }} />
				<button onClick={() => void loadSample()}
					style={{ padding: '3px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600, border: '1px solid rgba(34,211,238,.5)', background: 'rgba(34,211,238,.15)', color: '#67e8f9' }}>
					▶ 载入内置示例视频
				</button>
				{videoName && <span style={{ fontSize: 11, color: '#8fd' }}>{videoName}（{durations.toFixed(1)}s）</span>}
			</div>

			<div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8, fontSize: 11 }}>
				<label>相似度 {similarity.toFixed(2)}
					<input type="range" min={0.05} max={0.6} step={0.01} value={similarity}
						onChange={(e) => setSimilarity(Number(e.target.value))} style={{ accentColor: '#a855f7', marginLeft: 6 }} />
				</label>
				<label>去绿边 {smoothness.toFixed(2)}
					<input type="range" min={0} max={0.3} step={0.01} value={smoothness}
						onChange={(e) => setSmoothness(Number(e.target.value))} style={{ accentColor: '#a855f7', marginLeft: 6 }} />
				</label>
				<label title="绿色优势清除阈值：越大越宽容浅色/白色主体（产品表情包链路固定 90）">绿色优势 {greenDom}
					<input type="range" min={18} max={200} step={1} value={greenDom}
						onChange={(e) => setGreenDom(Number(e.target.value))} style={{ accentColor: '#a855f7', marginLeft: 6 }} />
				</label>
				<label>幕色 <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(keyColor) ? keyColor : '#00FF00'} onChange={(e) => setKeyColor(e.target.value)} style={{ verticalAlign: 'middle', marginLeft: 4 }} /></label>
				<label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} title="与产品 chroma_color='auto' 同款：从当前帧四边采样实际幕布色">
					<input type="checkbox" checked={autoKey} onChange={(e) => setAutoKey(e.target.checked)} style={{ accentColor: '#22d3ee' }} />
					<span style={{ color: autoKey ? '#67e8f9' : '#9a9a9a' }}>自动采样幕色</span>
				</label>
				<label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
					<input type="checkbox" checked={diag} onChange={(e) => setDiag(e.target.checked)} style={{ accentColor: '#ef4444' }} />
					<span style={{ color: diag ? '#f87171' : '#9a9a9a' }}>诊断高亮（被抠=红）</span>
				</label>
			</div>

			{videoUrl && (
				<div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10, fontSize: 11 }}>
					<span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
						<button onClick={() => setFrameIdx(v => Math.max(0, v - 1))} style={{ cursor: 'pointer' }}>◀</button>
						<input type="range" min={0} max={FRAME_SLOTS - 1} value={frameIdx}
							onChange={(e) => setFrameIdx(Number(e.target.value))} style={{ accentColor: '#a855f7', width: 220 }} />
						<button onClick={() => setFrameIdx(v => Math.min(FRAME_SLOTS - 1, v + 1))} style={{ cursor: 'pointer' }}>▶</button>
						<span style={{ fontFamily: 'monospace' }}>{frameIdx + 1}/{FRAME_SLOTS}</span>
					</span>
					<button onClick={() => void runGifCompare()} disabled={gifBusy}
						style={{ padding: '4px 10px', borderRadius: 5, cursor: gifBusy ? 'wait' : 'pointer', fontSize: 11, fontWeight: 600, border: '1px solid rgba(168,85,247,.5)', background: gifBusy ? 'rgba(148,163,184,.2)' : 'rgba(168,85,247,.2)', color: gifBusy ? '#94a3b8' : '#d8b4fe' }}>
						{gifBusy ? '⏳ 编码中…' : `🎞 生成 GIF 对比（勾选 ${gifPick.size} 个 · ${PREVIEW_FRAMES} 帧）`}
					</button>
					<span style={{ color: '#9a9a9a' }}>勾选参与 GIF 对比：</span>
					{LAB_ALGOS.map(m => (
						<label key={m.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
							<input type="checkbox" checked={gifPick.has(m.id)}
								onChange={(e) => setGifPick(prev => {
									const next = new Set(prev);
									if (e.target.checked) { next.add(m.id); } else { next.delete(m.id); }
									return next;
								})} style={{ accentColor: '#a855f7' }} />
							{m.label}
						</label>
					))}
				</div>
			)}

			{!videoUrl ? (
				<div style={{ border: '2px dashed #3a3b40', borderRadius: 10, padding: 60, textAlign: 'center', color: '#777', fontSize: 13 }}>
					← 选择/拖入绿幕视频开始对比
				</div>
			) : (
				<>
					<video ref={videoRef} src={videoUrl} muted style={{ display: 'none' }} />
					<div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 12 }}>
						{/* 原始帧（对照） */}
						<div style={{ border: '1px solid rgba(255,255,255,.12)', borderRadius: 8, padding: 8, background: '#1b1c20' }}>
							<div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: '#9a9a9a' }}>原始帧（对照）</div>
							<canvas ref={rawCanvasRef} style={{ width: '100%', borderRadius: 6, display: 'block', background: '#000' }} />
							<div style={{ fontSize: 10, color: '#777', marginTop: 6, lineHeight: 1.5 }}>绿幕源帧。对照看各算法抠掉了什么。</div>
						</div>
						{LAB_ALGOS.map((meta) => {
							const productMeta = CHROMA_KEY_ALGOS.find(m => m.id === meta.id);
							const gif = gifResults.get(meta.id);
							return (
								<div key={meta.id} style={{ border: `1px solid ${meta.product ? 'rgba(34,211,238,.35)' : 'rgba(255,255,255,.12)'}`, borderRadius: 8, padding: 8, background: '#1b1c20' }}>
									<div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>
										{meta.label}
										{meta.product && <span style={{ fontSize: 9, color: '#22d3ee', marginLeft: 6 }}>产品实现</span>}
										<span style={{ float: 'right', color: '#9a9a9a', fontFamily: 'monospace', fontSize: 10 }}>
											抠除 {removedPct.get(meta.id) ?? '—'}% ·
											<span style={{ color: (softPct.get(meta.id) ?? 0) > 0.5 ? '#4ade80' : '#9a9a9a' }}>
												渐变 {softPct.get(meta.id) ?? '—'}%
											</span> · {msStats.get(meta.id) ?? '—'}ms
										</span>
									</div>
									<div style={{ fontSize: 10, color: '#9a9a9a', lineHeight: 1.5, marginBottom: 4, minHeight: 30 }}>
										<b style={{ color: '#c4b5fd' }}>来源</b>：{meta.source}
									</div>
									<div style={{ fontSize: 10, color: '#9a9a9a', lineHeight: 1.5, marginBottom: 6, minHeight: 42 }}>
										{productMeta?.tip ?? meta.tip}
									</div>
									<canvas
										ref={(el) => { canvasRefs.current.set(meta.id, el); }}
										style={{ ...checkerStyle, width: '100%', borderRadius: 6, display: 'block' }}
									/>
									{gif && (
										<div style={{ marginTop: 8, borderTop: '1px solid rgba(255,255,255,.1)', paddingTop: 8 }}>
											<div style={{ fontSize: 10, color: '#9a9a9a', fontFamily: 'monospace', marginBottom: 4 }}>
												GIF {PREVIEW_FRAMES}帧 · {(gif.bytes / 1024).toFixed(0)}KB · 编码{gif.ms}ms
											</div>
											<img src={gif.url} alt={`gif-${meta.id}`} style={{ ...checkerStyle, width: '100%', borderRadius: 6, display: 'block' }} />
										</div>
									)}
								</div>
							);
						})}
					</div>

					{/* ── 怎么看 ── */}
					<div style={{ marginTop: 12, fontSize: 11, color: '#9a9a9a', lineHeight: 1.8, maxWidth: 1080, border: '1px solid rgba(255,255,255,.08)', borderRadius: 8, padding: 10, background: '#191a1e' }}>
						<b style={{ color: '#d8b4fe' }}>怎么看</b>：
						① <b>主体内部</b>——勾选诊断高亮，红色 = 被误抠（黑斑/破洞来源）；<br />
						② <b>描边外缘</b>——绒毛/灰白带宽（去绿边调小可收紧，但调太大会吃掉浅色元素）；<br />
						③ <b>半透明/浅色元素</b>（泡泡、高光、白发）——能保住的是赢家；<br />
						④ <b>抠除比例</b>——同一组参数下明显更高 = 抠过头；<br />
						⑤ <b>GIF 列</b>——量化成 128 色 + 1-bit 透明后的最终观感（这才等于产品输出）；<br />
						⑥ <b>渐变透明/半透明元素</b>——看 <b style={{ color: '#fbbf24' }}>★ 线性反混合</b> 列：其余算法的 alpha 基本只有 0/255 两档 ✗，
						只有它是**连续 alpha**（半透明像素的不透明度是**算出来的**）✓。<br />
						<b style={{ color: '#fbbf24' }}>结论</b>：绿幕素材（有真实绿幕底）→ 在 <b>ycbcr / obs-soft / keylight</b> 之间选；
						但<b>真半透明元素</b>（半透泡泡叠在绿幕上）「按色距猜 alpha」的算法**物理上做不到** ——
						要么用 <b>★ 线性反混合</b>（单幕反解，见上），要么换<b>神经抠像</b>（见下表，且不需要绿幕）。
					</div>

					{/* ── 调研结论表 ── */}
					<div style={{ marginTop: 14 }}>
						<div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>📚 开源抠图算法调研（2026-09-12）</div>
						<table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%', maxWidth: 1180 }}>
							<thead>
								<tr style={{ background: '#1b1c20', textAlign: 'left' }}>
									<th style={thStyle}>算法 / 模型</th>
									<th style={thStyle}>类型</th>
									<th style={thStyle}>需模型</th>
									<th style={thStyle}>来源</th>
									<th style={thStyle}>说明</th>
								</tr>
							</thead>
							<tbody>
								{RESEARCH.map((r) => (
									<tr key={r.name} style={{ borderTop: '1px solid rgba(255,255,255,.08)' }}>
										<td style={tdStyle}><b>{r.name}</b></td>
										<td style={tdStyle}>{r.kind}</td>
										<td style={{ ...tdStyle, color: r.needModel === '否' ? '#4ade80' : '#fbbf24' }}>{r.needModel}</td>
										<td style={{ ...tdStyle, color: '#9a9a9a' }}>{r.source}</td>
										<td style={tdStyle}>{r.note}</td>
									</tr>
								))}
							</tbody>
						</table>
						<div style={{ fontSize: 11, color: '#9a9a9a', marginTop: 8, lineHeight: 1.8, maxWidth: 1080 }}>
							<b style={{ color: '#fbbf24' }}>为什么神经抠像不在本页里跑</b>：RVM / MODNet / BiRefNet / RMBG 等需要推理运行时
							（PyTorch 或 ONNX Runtime Web）+ 模型权重（几十 MB 起），无法用 Canvas 逐像素实现。
							若要接入产品，推荐路径：<b>RVM（MIT，时序稳定，官方 ONNX/Web demo）</b> → ONNX Runtime Web 在 webview 内跑；
							或服务端跑 BiRefNet/RMBG 走 RPC（与现有 Provider 链路一致）。它们<b>不需要绿幕</b>，
							因此也能一次性解决「半透明泡泡」这类绿幕抠像的物理极限问题。
						</div>
					</div>
				</>
			)}
		</div>
	);
}

const thStyle: React.CSSProperties = { padding: '6px 8px', fontSize: 11, color: '#c4b5fd', fontWeight: 600 };
const tdStyle: React.CSSProperties = { padding: '6px 8px', verticalAlign: 'top', lineHeight: 1.6 };

const rootEl = document.getElementById('root');
if (rootEl) {
	createRoot(rootEl).render(<App />);
}
