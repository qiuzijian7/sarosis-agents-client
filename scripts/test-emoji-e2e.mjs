#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  test-emoji-e2e.mjs — EmojiStage（表情包节点）端到端集成测试。
 *
 *  真实调用 ComfyUI /prompt 生成表情包，并对**像素**做断言。设计目标是抓住 TS 单测
 *  结构上无法覆盖的一类缺陷 —— ComfyUI 侧（Python 插件 / 模型 / 节点参数）产出的
 *  图「能生成但内容不对」。
 *
 *  ## 为什么需要像素级断言（血泪教训）
 *  本脚本旧版只检查 PNG IHDR color type == 6（"有 alpha 通道"），于是放过了一个
 *  真实 bug：layerdiffuse 的 `LayeredDiffusionDecodeRGBA` 少了一次取反，导致
 *  **主体透明、背景不透明**（alpha 完全反了）。图有 alpha 通道、能打开、看着"有
 *  二值分离"，旧断言全绿。
 *  ⇒ 结论：透明贴纸必须验 **alpha 方向**，判据见 `assertAlphaDirection()`。
 *
 *  ## 测什么
 *   1. 环境依赖（ComfyUI 存活 / 节点注册 / checkpoint & motion & layer 模型齐备）
 *   2. 模板真实性：直接用 esbuild 加载 `emojiWorkflows.ts`，**不在本文件内联副本**，
 *      模板改动自动同步，永不漂移
 *   3. 注入语义：复刻 runStageWorkflow 的 main_prompt(+suffix) / option:seed 注入
 *   4. 执行成功 + 产物像素断言：
 *      · 透明贴纸(静态) → RGBA + alpha 方向正确 + 非纯色
 *      · 动态表情       → N 帧 + 每帧 alpha 方向正确 + 帧间有差异（真动画）+ 非噪声
 *      · 普通贴纸(fallback) → 正常出图（不要求 alpha）+ 非噪声
 *
 *  ## 噪声判据（assertNotNoise）—— 抓「图像能生成但内容是彩色噪声」
 *  用户报「表情包生成图像混乱」，产物是彩色噪声（AnimateDiff 没吃到 prompt 时
 *  输出的"色块涌动"）。它**不是**纯色、**有** alpha、**有**帧间差异，所以
 *  `assertNotBlank` / `assertAlphaDirection` / 帧间差异**全部抓不住**。
 *  噪声的本质是空间高频：相邻像素 RGB 差值巨大。
 *    实测（RTX 4070）：
 *      动态表情前景梯度 ≈ 11（AnimateDiff 时间平滑 → 低）
 *      静态透明贴纸前景梯度 ≈ 43（layerdiffuse 解码自带高频细节 → 偏高）
 *      彩色噪声前景梯度 ≈ 85（随机 RGB，|Δ| 期望 255/3）
 *  ★ 阈值 40 只对「动态表情」可靠（11 vs 85 差距巨大）。**静态透明贴纸不查
 *    噪声**（43 会误报），其正确性由 alpha 方向 + 非纯色覆盖。
 *
 *  ## 用法
 *    npm run test-emoji-criteria                          # 判据自测（秒级，无需 GPU/ComfyUI）
 *    npm run test-emoji-e2e                               # 全部用例（真实推理）
 *    node scripts/test-emoji-e2e.mjs --quick              # 跳过动态（省 ~140s）
 *    node scripts/test-emoji-e2e.mjs --only 透明贴纸       # 只跑名字含该串的模板
 *    node scripts/test-emoji-e2e.mjs --base http://127.0.0.1:8189
 *    node scripts/test-emoji-e2e.mjs --prompt "一只橘猫" --seed 42
 *    node scripts/test-emoji-e2e.mjs --analyze path/to.png   # 离线只分析一张图（不推理）
 *
 *  退出码：0 = 全部通过；1 = 有断言失败 / 环境缺失（可用于 CI 闸门）。
 *
 *  ## 两级闸门
 *   · `--self-test`：合成正常/反转/全透明/全不透明四种样本，验证判据分别放行与拦下。
 *     毫秒级、零依赖 ⇒ **可进常规 CI**，防止判据被改弱（本文件的核心资产是判据本身）。
 *   · 默认全量：真实推理 + 像素断言 ⇒ 改动 ComfyUI 侧（插件/模型/模板）后手动跑。
 *     单次约 3.5 分钟并占用 GPU，故不进常规套件。
 *
 *  ## 战果
 *  重写后首次运行即抓到一个未知缺陷：动态模板用 512×512（SDXL 原生 1024），
 *  构图失控导致主体涨满画框、四周透明留白被压掉 —— 16/16 帧外框 alpha 均值
 *  33.9~113.7（阈值 32）。改 768² + 留白引导 prompt 后降到 0.0~5.4、0/16 脏帧。
 *
 *  依赖：Node 18+（内置 fetch / zlib）+ 仓库内 esbuild。无需 Python/PIL。
 *--------------------------------------------------------------------------------------------*/

import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_TS = path.join(
	REPO_ROOT,
	'src/vs/sessions/contrib/agentStudio/webview/src/features/workflowEditor/comfyHost/builtinWorkflows/emojiWorkflows.ts',
);

// ---------------------------------------------------------------- CLI

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const BASE = argVal('--base', 'http://127.0.0.1:8188');
const PROMPT = argVal('--prompt', 'a cute cartoon orange cat');
const SEED = Number(argVal('--seed', '42'));
// 刻意用非模板默认值（模板 default 是 fps=8 / frames=16），这样断言
// 「api_json 里等于这个值」才能真正证明卡片控件透传生效。
const FPS = Number(argVal('--fps', '12'));
const FRAMES = Number(argVal('--frames', '12'));
const ONLY = argVal('--only', '');
const QUICK = flag('--quick');

// ---------------------------------------------------------------- 输出

const C = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' };
const failures = [];
let SILENT = false; // --self-test 期间抑制内层输出
function ok(msg) { if (!SILENT) { console.log(`  ${C.green}✓${C.off} ${msg}`); } }
function fail(msg) { if (!SILENT) { console.log(`  ${C.red}✗${C.off} ${msg}`); } failures.push(msg); }
function warn(msg) { if (!SILENT) { console.log(`  ${C.yellow}!${C.off} ${msg}`); } }
function info(msg) { if (!SILENT) { console.log(`  ${C.dim}${msg}${C.off}`); } }
function head(msg) { console.log(`\n${C.bold}${msg}${C.off}`); }
/** 断言：cond 为真则 ok，否则记 fail。返回 cond 便于短路。 */
function check(cond, msg) { cond ? ok(msg) : fail(msg); return cond; }

// ---------------------------------------------------------------- HTTP

async function jget(p) {
	const r = await fetch(BASE + p);
	if (!r.ok) { throw new Error(`GET ${p} → HTTP ${r.status}`); }
	return r.json();
}
async function jpost(p, body) {
	const r = await fetch(BASE + p, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	const text = await r.text();
	if (!r.ok) { throw new Error(`POST ${p} → HTTP ${r.status}: ${text.slice(0, 900)}`); }
	return JSON.parse(text);
}

// ---------------------------------------------------------------- PNG 解码
// 纯 Node 实现（zlib inflate + 反 filter），只支持 8-bit 非隔行 —— ComfyUI SaveImage
// 的输出恒为该形态。够用且零外部依赖。

function readU32(b, i) { return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0; }

function paeth(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
	return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
}

/** @returns {{width:number,height:number,channels:number,px:Buffer}} px 为紧凑的 [H*W*channels] */
function decodePng(bytes) {
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

/** WebP 容器解析（不解像素）：拿 alpha 标志 / 是否动画 / 帧数。 */
function parseWebp(bytes) {
	const tag = (i) => String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
	if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') { throw new Error('不是 WebP'); }
	let pos = 12, frames = 0, hasAlphaFlag = false, isAnim = false, lossless = false;
	while (pos + 8 <= bytes.length) {
		const t = tag(pos);
		// RIFF chunk size 是小端
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

// ---------------------------------------------------------------- ★ 核心判据

/**
 * 计算 alpha 的统计特征。抽出来供「单图断言」与「多帧取最差」共用。
 *   edgeAvg —— 外框(2%)带的 alpha 均值，★ 判断反转/脏边的主信号
 *   ctrAvg  —— 中心 1/3~2/3 区域均值
 *   oPct/tPct —— 不透明(>200)/透明(<50) 像素占比
 */
function alphaMetrics(img) {
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

/**
 * 断言透明贴纸的 alpha **方向**正确（主体不透明、背景透明）。
 *
 * 判据设计的核心洞察：**alpha 反转最稳定的特征是「外框变不透明」**。
 * 贴纸的画面边缘必然是背景，正确时 alpha≈0、反转时 alpha≈250 —— 这个信号
 * 与主体大小/构图无关，故作为主判据。而「中心 − 外框」的差值受构图影响很大
 * （主体小的时候只有 40 左右，主体大时能到 200），只能作为辅助判据、阈值须放宽。
 *
 * 硬判据（任一不满足即失败）：
 *   A. 必须是 RGBA（4 通道）
 *   B. ★ 外框(2%)均值 ≤ 32   —— 抓 alpha 反转（≈250）与脏边（主体溢出画框）
 *   C. 四角 alpha ≤ 8        —— 同上，点采样二次确认
 *   D. 不透明占比 ∈ [2%, 98%] —— 抓「整张空图」与「alpha 完全未生效」
 *   E. 中心(1/3~2/3)均值 − 外框均值 ≥ 15 —— 主体确实在画面中部（反转时为负）
 *
 * B 与 E 组合还能区分两种不同故障：B 失败 + E 为负 = alpha 反转；
 * B 失败 + E 很大 = 方向没错但主体溢出画框（贴纸不合格，通常是分辨率/构图问题）。
 */
function assertAlphaDirection(img, label) {
	if (!check(img.channels === 4, `${label}: RGBA 4 通道`)) { return false; }
	const m = alphaMetrics(img);
	const delta = m.ctrAvg - m.edgeAvg;

	info(`alpha: 不透明=${m.oPct.toFixed(1)}% 透明=${m.tPct.toFixed(1)}% | 四角=[${m.corners.join(',')}] | 外框均值=${m.edgeAvg.toFixed(1)} 中心均值=${m.ctrAvg.toFixed(1)} Δ=${delta.toFixed(1)}`);

	const edgeBad = m.edgeAvg > 32;
	// 同一条断言失败，按 Δ 的符号给出不同诊断 —— 反转 vs 主体溢出是两码事。
	const hint = !edgeBad ? ''
		: delta < 0 ? ` ← ${C.bold}alpha 反转！主体透明、背景不透明${C.off}`
			: ` ← ${C.bold}主体溢出画框${C.off}（方向正确但四周没留白，贴纸不合格）`;

	let pass = true;
	pass = check(!edgeBad, `${label}: 外框透明（均值 ${m.edgeAvg.toFixed(1)} ≤ 32）${hint}`) && pass;
	pass = check(m.corners.every(v => v <= 8), `${label}: 四角透明（alpha ≤ 8）`) && pass;
	pass = check(m.oPct >= 2 && m.oPct <= 98, `${label}: 不透明占比 ${m.oPct.toFixed(1)}% 在 [2%,98%]（既非空图也非未生效）`) && pass;
	pass = check(delta >= 15, `${label}: 主体位于画面中部（Δ=${delta.toFixed(1)} ≥ 15）`) && pass;
	return pass;
}

/** 断言图像非纯色（抓"全黑/全白/纯噪声块"）。用 RGB 通道方差。 */
function assertNotBlank(img, label) {
	const { width: w, height: h, channels, px } = img;
	let min = 255, max = 0, sum = 0, n = 0;
	const step = Math.max(1, Math.floor((w * h) / 20000)); // 抽样 ~2 万点，够稳且快
	for (let i = 0; i < w * h; i += step) {
		for (let c = 0; c < Math.min(3, channels); c++) {
			const v = px[i * channels + c];
			if (v < min) { min = v; }
			if (v > max) { max = v; }
			sum += v; n++;
		}
	}
	info(`RGB: min=${min} max=${max} mean=${(sum / Math.max(1, n)).toFixed(1)}`);
	return check(max - min >= 40, `${label}: 画面非纯色（极差 ${max - min} ≥ 40）`);
}

/**
 * ★ 噪声检测 —— 抓「图像能生成但内容是彩色噪声」这一类缺陷。
 *
 * 背景：用户报「表情包生成图像混乱」，产物是彩色噪声（AnimateDiff 没吃到
 * prompt 时输出的"色块涌动"）。它**不是**纯色、**有** alpha 通道、**有**帧间
 * 差异，所以 `assertNotBlank` / `assertAlphaDirection` / 帧间差异全部抓不住。
 *
 * 原理：噪声的本质是**空间高频**——相邻像素 RGB 无相关性、差值巨大。
 *   实测（RTX 4070，768² SDXL + mm_sdxl_v10_beta）：
 *     · 正常卡通贴纸前景梯度 ≈ 9.1（平滑色块 + 描边）
 *     · 合成彩色噪声前景梯度 ≈ 85.3（随机 RGB，均匀分布 |Δ| 期望 255/3）
 *   阈值 40 有约 4× 安全边际。
 *
 * 只看前景（alpha > 128）：透明背景是纯 0，不参与噪声判断；也避免把
 * 「透明贴纸的透明区」误判成噪声。
 *
 * @returns {gradient:number, samples:number} 前景像素空间高频梯度均值与采样数
 */
function noiseMetrics(img) {
	const { width: w, height: h, px, channels } = img;
	if (channels < 3) { return null; }
	const step = 2; // 抽样步长：768² 全像素太慢，步长 2 = 1/4 像素，仍够稳
	let sum = 0, n = 0;
	for (let y = 0; y < h - step; y += step) {
		for (let x = 0; x < w - step; x += step) {
			const i = (y * w + x) * channels;
			const a = channels === 4 ? px[i + 3] : 255;
			if (a < 128) { continue; } // 只看前景
			const r = px[i], g = px[i + 1], b = px[i + 2];
			const ir = i + step * channels;       // 右邻
			const id = i + step * w * channels;   // 下邻
			const d = (Math.abs(r - px[ir]) + Math.abs(g - px[ir + 1]) + Math.abs(b - px[ir + 2])
				+ Math.abs(r - px[id]) + Math.abs(g - px[id + 1]) + Math.abs(b - px[id + 2])) / 6;
			sum += d; n++;
		}
	}
	return { gradient: n ? sum / n : 0, samples: n };
}

/**
 * 断言前景不是彩色噪声。前景像素太少（< 1000 采样）时跳过 —— 那是「空图」
 * 问题，由 assertAlphaDirection 的「不透明占比」判据负责。
 */
function assertNotNoise(img, label) {
	const m = noiseMetrics(img);
	if (!m || m.samples < 1000) { return true; }
	info(`噪声: 前景梯度=${m.gradient.toFixed(1)}（采样 ${m.samples} 点）`);
	return check(m.gradient <= 40, `${label}: 前景非彩色噪声（梯度 ${m.gradient.toFixed(1)} ≤ 40）${m.gradient > 40 ? ' ← 图像混乱！AnimateDiff 未吃到 prompt' : ''}`);
}

// ---------------------------------------------------------------- 模板加载

/**
 * 用 esbuild 就地编译 emojiWorkflows.ts 并 import —— 保证测的就是产品模板本身。
 * 该文件只有 type-only import，bundle 后无外部依赖。
 */
async function loadTemplates() {
	const esbuild = await import('esbuild');
	const out = await esbuild.build({
		entryPoints: [TEMPLATE_TS],
		bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
	});
	const code = out.outputFiles[0].text;
	const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
	return mod.EMOJI_BUILTIN_WORKFLOWS;
}

/**
 * 复刻 `runStageWorkflow` 的注入语义：按 cfg.inputs 声明把值写进 api_json。
 * 对齐 `stageWorkflowExecutor.resolveBindingValue` 支持的 from 形式：
 *   main_prompt        → values.prompt（+ spec.suffix）
 *   option:<key>       → values[key]（**通用**，覆盖 seed / fps / frames …）
 *   literal:<value>    → 字面量
 * 未命中的 from（如 upstream_*）跳过 —— 本脚本不接上游。
 *
 * ★ option: 必须**通用**处理，不能只 hardcode seed：动态模板把
 *   帧数 → EmptyLatentImage.batch_size + DecodeRGBA.sub_batch_size、
 *   帧率 → SaveAnimatedWEBP.fps 全部经 option: 绑定，写死 seed 会漏测这些。
 */
function applyInputs(cfg, values) {
	const api = structuredClone(cfg.api_json);
	const applied = [];
	for (const [nodeId, fields] of Object.entries(cfg.inputs ?? {})) {
		for (const [field, spec] of Object.entries(fields)) {
			let v;
			if (spec.from === 'main_prompt') {
				v = (values.prompt || spec.default || '') + (spec.suffix ?? '');
			} else if (typeof spec.from === 'string' && spec.from.startsWith('option:')) {
				const key = spec.from.slice(7);
				v = values[key];
				// 与 resolveBindingValue 一致：空值视为未提供 → 用模板 default
				if (v === undefined || v === null || v === '') {
					v = spec.default === 'random_int31' ? 0 : spec.default;
				}
			} else if (typeof spec.from === 'string' && spec.from.startsWith('literal:')) {
				v = spec.from.slice(8);
			} else { continue; }
			if (spec.cast === 'int') { v = Math.trunc(Number(v)); }
			api[nodeId].inputs[field] = v;
			applied.push({ nodeId, field, from: spec.from, value: v });
		}
	}
	return { api, applied };
}

/**
 * 为动态模板补一个 SaveImage 分支，让同一次执行**同时**产出动画 webp 和逐帧 PNG。
 * webp 的像素解码（VP8L/VP8）在纯 Node 里不现实，而逐帧 PNG 能让我们对
 * `LayeredDiffusionDecodeRGBA` 在 batch=16 下的 alpha 方向做同样的硬断言。
 * 这不改变被测链路（同一个 DecodeRGBA 输出接两个 Save 节点）。
 */
function attachFrameDump(api) {
	const animNode = Object.entries(api).find(([, n]) => n.class_type === 'SaveAnimatedWEBP');
	if (!animNode) { return api; }
	const imagesRef = animNode[1].inputs.images;
	api['__frames'] = { class_type: 'SaveImage', inputs: { images: imagesRef, filename_prefix: 'ComfyTV/e2e_frames' } };
	return api;
}

// ---------------------------------------------------------------- 执行

async function runPrompt(api, label) {
	const { prompt_id } = await jpost('/prompt', { prompt: api });
	info(`prompt_id=${prompt_id}，等待推理…`);
	const t0 = Date.now();
	for (let i = 0; i < 300; i++) {
		await new Promise(r => setTimeout(r, 2000));
		const h = await jget(`/history/${prompt_id}`);
		const rec = h[prompt_id];
		if (rec?.status?.status_str && rec.status.completed !== undefined) {
			const st = rec.status;
			if (st.status_str === 'success' || st.status_str === 'error') {
				info(`耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s，status=${st.status_str}`);
				if (st.status_str === 'error') {
					for (const m of st.messages ?? []) {
						if (Array.isArray(m) && m[0] === 'execution_error') {
							fail(`${label}: 执行报错 [${m[1]?.node_type}] ${m[1]?.exception_message}`);
							const tb = (m[1]?.traceback ?? []).join('').slice(-700);
							if (tb) { console.log(`${C.dim}${tb}${C.off}`); }
						}
					}
					return null;
				}
				return rec;
			}
		}
	}
	fail(`${label}: 推理超时（>600s）`);
	return null;
}

async function fetchOutputs(rec) {
	const files = [];
	for (const out of Object.values(rec.outputs ?? {})) {
		for (const im of out.images ?? []) { files.push(im); }
	}
	const results = [];
	for (const im of files) {
		const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder ?? '', type: im.type ?? 'output' });
		const buf = await (await fetch(`${BASE}/view?${q}`)).arrayBuffer();
		results.push({ ...im, bytes: new Uint8Array(buf) });
	}
	return results;
}

/** 逐用例：注入 → 执行 → 取产物 → 按 expect 断言。 */
async function runCase(name, cfg, expect) {
	head(`[用例] ${name}`);
	// 用**非默认**的 fps/frames，才能证明卡片控件真的透传到模板
	// （曾经 fps 硬编码 8.0、batch_size 硬编码 16 → 控件是假的，调了没反应）。
	const values = { prompt: PROMPT, seed: SEED, fps: FPS, frames: FRAMES };
	let { api, applied } = applyInputs(cfg, values);
	if (expect.animated) { api = attachFrameDump(api); }

	// 注入正确性（不依赖推理，先查）
	const injected = Object.values(api).some(n =>
		typeof n.inputs?.text === 'string' && n.inputs.text.includes(PROMPT));
	check(injected, '注入: main_prompt 已写入 CLIPTextEncode');
	const seedOk = Object.values(api).some(n => n.inputs?.seed === SEED);
	check(seedOk, `注入: seed=${SEED} 已写入 KSampler`);

	if (expect.animated) {
		// ★ 帧率/帧数必须经 `option:` 绑定进模板，否则卡片上的控件是装饰品。
		info(`绑定: ${applied.map(a => `${a.nodeId}.${a.field}←${a.from}=${a.value}`).join(', ')}`);
		const fpsNode = Object.values(api).find(n => n.class_type === 'SaveAnimatedWEBP');
		check(fpsNode?.inputs?.fps === FPS, `注入: fps=${FPS} 已写入 SaveAnimatedWEBP（实际 ${fpsNode?.inputs?.fps}）`);
		const latent = Object.values(api).find(n => n.class_type === 'EmptyLatentImage');
		check(latent?.inputs?.batch_size === FRAMES, `注入: 帧数=${FRAMES} 已写入 EmptyLatentImage.batch_size（实际 ${latent?.inputs?.batch_size}）`);
		// sub_batch_size 必须与 batch_size 同值，否则 DecodeRGBA 越界 → 彩色噪声
		const dec = Object.values(api).find(n => n.class_type === 'LayeredDiffusionDecodeRGBA');
		check(dec?.inputs?.sub_batch_size === FRAMES,
			`注入: sub_batch_size 与帧数一致（=${FRAMES}，实际 ${dec?.inputs?.sub_batch_size}）`);
	}

	const rec = await runPrompt(api, name);
	if (!rec) { return; }

	const files = await fetchOutputs(rec);
	if (!check(files.length > 0, '产物: 至少一个输出文件')) { return; }
	info(`产物 ${files.length} 个: ${files.map(f => f.filename).join(', ').slice(0, 200)}`);

	const pngs = files.filter(f => f.filename.toLowerCase().endsWith('.png'));
	const webps = files.filter(f => f.filename.toLowerCase().endsWith('.webp'));

	// ---- 动画容器断言
	if (expect.animated) {
		if (check(webps.length > 0, '产物: 含动画 webp')) {
			const meta = parseWebp(webps[0].bytes);
			info(`webp: ${webps[0].bytes.length} bytes, anim=${meta.isAnim}, frames=${meta.frames}, alphaFlag=${meta.hasAlphaFlag}`);
			check(meta.isAnim, '动画: webp 含 ANIM（是动画而非单帧）');
			// ★ 精确等于注入的帧数 —— 只断言 ≥2 会漏掉「帧数控件不生效」
			//   （硬编码 16 时传 12 也能过 ≥2）。
			check(meta.frames === FRAMES, `动画: webp 帧数 == 注入帧数 ${FRAMES}（实际 ${meta.frames}）`);
			check(meta.hasAlphaFlag, '动画: webp 声明 alpha 通道');
		}
		// 逐帧 PNG：帧数 + 帧间差异
		if (check(pngs.length === FRAMES, `动画: 逐帧 PNG ${pngs.length} 张 == 注入帧数 ${FRAMES}`)) {
			const f0 = decodePng(pngs[0].bytes);
			const fMid = decodePng(pngs[Math.floor(pngs.length / 2)].bytes);
			let diff = 0;
			const n = Math.min(f0.px.length, fMid.px.length);
			const step = Math.max(1, Math.floor(n / 60000));
			let cnt = 0;
			for (let i = 0; i < n; i += step) { diff += Math.abs(f0.px[i] - fMid.px[i]); cnt++; }
			const avgDiff = diff / Math.max(1, cnt);
			info(`帧间平均像素差 = ${avgDiff.toFixed(2)}`);
			check(avgDiff > 1, `动画: 首帧与中间帧有差异（${avgDiff.toFixed(2)} > 1，非静止画面）`);
		}
	}

	// ---- 像素断言（透明贴纸 / 动态逐帧 都走这条）
	if (expect.alpha) {
		if (pngs.length === 0) {
			fail(`${name}: 需要 PNG 做 alpha 断言，但没拿到 PNG`);
		} else if (pngs.length === 1) {
			const img = decodePng(pngs[0].bytes);
			info(`PNG: ${img.width}×${img.height}, ${img.channels} 通道`);
			assertAlphaDirection(img, '透明');
			assertNotBlank(img, '透明');
			// ★ 不查 assertNotNoise：静态透明贴纸经 layerdiffuse 解码，RGB 通道
			//   天然带高频细节（前景梯度 ≈ 43），与彩色噪声（≈ 85）不同但会踩
			//   40 阈值 → 误报。噪声判据只对动态表情（AnimateDiff 时间平滑后
			//   梯度 ≈ 11，与噪声 85 差距巨大）可靠，见下方多帧分支。
		} else {
			// 多帧：逐帧算，用**最差帧**做断言。只看首帧会漏掉中段掉链子的帧。
			const stats = pngs.map(p => ({ name: p.filename, img: decodePng(p.bytes) }))
				.map(s => ({ ...s, m: alphaMetrics(s.img) }));
			const worst = stats.reduce((a, b) => (b.m.edgeAvg > a.m.edgeAvg ? b : a));
			const dirty = stats.filter(s => s.m.edgeAvg > 32).length;
			info(`PNG: ${worst.img.width}×${worst.img.height}, ${worst.img.channels} 通道，共 ${stats.length} 帧`);
			info(`外框均值 min=${Math.min(...stats.map(s => s.m.edgeAvg)).toFixed(1)} max=${worst.m.edgeAvg.toFixed(1)}；超阈值(>32) ${dirty}/${stats.length} 帧`);
			info(`最差帧: ${worst.name}`);
			assertAlphaDirection(worst.img, `透明(最差帧)`);
			assertNotBlank(worst.img, '透明');
			// ★ 噪声检测：逐帧算，用「梯度最高的一帧」判 —— 噪声常集中在中段帧
			//   （AnimateDiff 时间轴越靠后越发散），只看首帧会漏掉。
			const noisy = stats.reduce((a, b) => {
				const ga = noiseMetrics(a.img)?.gradient ?? 0;
				const gb = noiseMetrics(b.img)?.gradient ?? 0;
				return gb > ga ? b : a;
			});
			assertNotNoise(noisy.img, '动态(噪声最重帧)');
		}
	} else {
		// fallback：不要求 alpha，但要求出图正常
		if (check(pngs.length > 0, '产物: 含 PNG')) {
			const img = decodePng(pngs[0].bytes);
			info(`PNG: ${img.width}×${img.height}, ${img.channels} 通道`);
			assertNotBlank(img, 'fallback');
			assertNotNoise(img, 'fallback');
		}
	}
}

// ---------------------------------------------------------------- 环境检查

/**
 * 从 /object_info 的 input 规格里取 COMBO 选项列表。
 *
 * ★ ComfyUI 0.33 有**三种并存**形态，必须全兼容，否则会误报模型缺失：
 *   · `[[opt,...], {tooltip}]`      —— 旧式，选项在 [0]（如 CheckpointLoaderSimple.ckpt_name）
 *   · `["COMBO", {options:[...]}]`  —— v3 io schema，选项在 [1].options（如 ADE_*.model_name）
 *   · `[[opt,...]]`                 —— 旧式无 meta（如 LayeredDiffusionApply.config）
 */
function comboOptions(spec) {
	if (!Array.isArray(spec)) { return []; }
	if (Array.isArray(spec[0])) { return spec[0]; }
	if (spec[1] && Array.isArray(spec[1].options)) { return spec[1].options; }
	return [];
}

async function checkEnv() {
	head('[环境] ComfyUI 与模型依赖');
	const stats = await jget('/system_stats');
	info(`目标 ${BASE}，ComfyUI ${stats?.system?.comfyui_version ?? '?'}，设备 ${stats?.devices?.[0]?.name ?? '?'}`);

	const oi = await jget('/object_info');
	for (const n of ['LayeredDiffusionApply', 'LayeredDiffusionDecodeRGBA', 'SaveAnimatedWEBP', 'ADE_AnimateDiffLoaderGen1']) {
		check(!!oi[n], `节点已注册: ${n}`);
	}
	const ckpts = comboOptions(oi.CheckpointLoaderSimple?.input?.required?.ckpt_name);
	check(ckpts.includes('sd_xl_base_1.0.safetensors'), `模型: sd_xl_base_1.0.safetensors（可选 ${ckpts.length} 个）`);

	if (!QUICK) {
		const motions = comboOptions(oi.ADE_AnimateDiffLoaderGen1?.input?.required?.model_name);
		check(motions.includes('mm_sdxl_v10_beta.ckpt'), `模型: mm_sdxl_v10_beta.ckpt（可选 ${motions.length} 个）`);
		const betas = comboOptions(oi.ADE_AnimateDiffLoaderGen1?.input?.required?.beta_schedule);
		check(betas.includes('linear (AnimateDiff-SDXL)'), 'AnimateDiff: 支持 beta_schedule "linear (AnimateDiff-SDXL)"');
	}

	// layerdiffuse 的 config 下拉必须含 Conv Injection（模板依赖它）
	const cfgs = comboOptions(oi.LayeredDiffusionApply?.input?.required?.config);
	check(cfgs.some(c => String(c).includes('Conv Injection')), 'layerdiffuse: 支持 "SDXL, Conv Injection"');
}

// ---------------------------------------------------------------- 判据自测

/** 合成一张「圆形主体居中 + 四周透明」的假贴纸；inverted=true 时把 alpha 取反。 */
function synthSticker({ inverted }) {
	const w = 256, h = 256;
	const px = Buffer.alloc(w * h * 4);
	const cx = w / 2, cy = h / 2, r = w * 0.3;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			const inside = Math.hypot(x - cx, y - cy) < r;
			px[i] = (x * 255 / w) | 0;          // R 渐变，保证 assertNotBlank 能过
			px[i + 1] = (y * 255 / h) | 0;
			px[i + 2] = inside ? 200 : 60;
			const a = inside ? 255 : 0;
			px[i + 3] = inverted ? 255 - a : a;
		}
	}
	return { width: w, height: h, channels: 4, px };
}

/**
 * 自测判据本身：合成正常/反转两张贴纸，要求判据分别放行与拦下。
 * 不需要 ComfyUI、不需要 GPU、毫秒级 —— 可放进常规 CI，防止判据被误改削弱
 * （历史上正是因为断言只看"有无 alpha 通道"，才漏掉了真实的 alpha 反转 bug）。
 */
function selfTest() {
	head('[自测] 判据有效性（不需要 ComfyUI）');
	const run = (img, label) => {
		const base = failures.length;
		SILENT = true;
		const pass = assertAlphaDirection(img, label);
		SILENT = false;
		const hits = failures.length - base;
		failures.length = base; // 回滚，自测的内层失败不计入总账
		return { pass, hits };
	};

	const good = run(synthSticker({ inverted: false }), '合成-正常');
	check(good.pass && good.hits === 0, `判据: 正常贴纸样本 → 放行（命中 ${good.hits} 条失败）`);

	const bad = run(synthSticker({ inverted: true }), '合成-反转');
	check(!bad.pass && bad.hits >= 1, `判据: alpha 反转样本 → 拦下（命中 ${bad.hits} 条失败）`);

	// 全透明（空图）与全不透明（alpha 未生效）也必须被拦
	const blankPx = Buffer.alloc(256 * 256 * 4);
	for (let i = 0; i < blankPx.length; i += 4) { blankPx[i] = i % 255; blankPx[i + 3] = 0; }
	const blank = run({ width: 256, height: 256, channels: 4, px: blankPx }, '合成-全透明');
	check(!blank.pass, `判据: 整张全透明 → 拦下（命中 ${blank.hits} 条）`);

	const solidPx = Buffer.alloc(256 * 256 * 4);
	for (let i = 0; i < solidPx.length; i += 4) { solidPx[i] = i % 255; solidPx[i + 3] = 255; }
	const solid = run({ width: 256, height: 256, channels: 4, px: solidPx }, '合成-全不透明');
	check(!solid.pass, `判据: alpha 完全未生效 → 拦下（命中 ${solid.hits} 条）`);

	// ★ 噪声判据负向自测：随机 RGB（彩色噪声）必须被 assertNotNoise 拦下，
	//   平滑色块（正常卡通主体）必须放行。
	const runNoise = (img, label) => {
		const base = failures.length;
		SILENT = true;
		const pass = assertNotNoise(img, label);
		SILENT = false;
		const hits = failures.length - base;
		failures.length = base;
		return { pass, hits };
	};
	const flatPx = Buffer.alloc(256 * 256 * 4);
	for (let y = 0; y < 256; y++) {
		for (let x = 0; x < 256; x++) {
			const i = (y * 256 + x) * 4;
			const inside = Math.hypot(x - 128, y - 128) < 76;
			flatPx[i] = 240; flatPx[i + 1] = 140; flatPx[i + 2] = 40;
			flatPx[i + 3] = inside ? 255 : 0;
		}
	}
	const flat = runNoise({ width: 256, height: 256, channels: 4, px: flatPx }, '合成-平滑主体');
	check(flat.pass, `判据: 平滑色块（正常卡通）→ 放行（命中 ${flat.hits} 条）`);

	const noisePx = Buffer.alloc(256 * 256 * 4);
	for (let i = 0; i < noisePx.length; i += 4) {
		noisePx[i] = Math.floor(Math.random() * 256);
		noisePx[i + 1] = Math.floor(Math.random() * 256);
		noisePx[i + 2] = Math.floor(Math.random() * 256);
		noisePx[i + 3] = 255;
	}
	const noise = runNoise({ width: 256, height: 256, channels: 4, px: noisePx }, '合成-彩色噪声');
	check(!noise.pass && noise.hits >= 1, `判据: 彩色噪声 → 拦下（命中 ${noise.hits} 条）`);
}

// ---------------------------------------------------------------- main

/**
 * 离线分析模式：对已有 PNG 直接跑像素判据，不碰 ComfyUI。
 * 两个用途：① 用户反馈"图不对"时快速定性；② 给判据本身做负向自测
 * （构造 alpha 反转图喂进来，必须 FAIL）。
 */
async function analyzeFile(file) {
	const fs = await import('node:fs');
	head(`[离线分析] ${file}`);
	const bytes = new Uint8Array(fs.readFileSync(file));
	if (file.toLowerCase().endsWith('.webp')) {
		const meta = parseWebp(bytes);
		info(`webp: anim=${meta.isAnim} frames=${meta.frames} alphaFlag=${meta.hasAlphaFlag} lossless=${meta.lossless}`);
		return;
	}
	const img = decodePng(bytes);
	info(`PNG: ${img.width}×${img.height}, ${img.channels} 通道`);
	assertAlphaDirection(img, '离线');
	assertNotBlank(img, '离线');
}

async function main() {
	// 判据自测：秒级、无外部依赖，可单独当 CI 闸门
	if (flag('--self-test')) {
		selfTest();
		head('=== 汇总 ===');
		if (failures.length === 0) { console.log(`${C.green}判据自测通过${C.off}`); process.exit(0); }
		console.log(`${C.red}${failures.length} 项失败：${C.off}`);
		for (const f of failures) { console.log(`  · ${f}`); }
		process.exit(1);
	}

	const analyze = argVal('--analyze', '');
	if (analyze) {
		await analyzeFile(analyze);
		head('=== 汇总 ===');
		if (failures.length === 0) { console.log(`${C.green}全部通过${C.off}`); process.exit(0); }
		console.log(`${C.red}${failures.length} 项失败：${C.off}`);
		for (const f of failures) { console.log(`  · ${f}`); }
		process.exit(1);
	}

	console.log(`${C.bold}EmojiStage 端到端测试${C.off}  ${C.dim}(真实推理，全量约 3 分钟)${C.off}`);
	await checkEnv();

	const templates = await loadTemplates();
	head('[模板] 从 emojiWorkflows.ts 实时加载');
	info(`共 ${Object.keys(templates).length} 个: ${Object.keys(templates).join(' / ')}`);

	// 期望矩阵：alpha=是否要求透明方向正确；animated=是否要求动画
	const EXPECT = {
		'透明贴纸 (SDXL)': { alpha: true, animated: false },
		'动态表情 (AnimateDiff)': { alpha: true, animated: true, slow: true },
		'普通贴纸 (SDXL, 无需 LoRA)': { alpha: false, animated: false },
	};
	for (const [name, cfg] of Object.entries(templates)) {
		const expect = EXPECT[name];
		if (!expect) { warn(`模板「${name}」没有对应期望，跳过（新增模板请补 EXPECT）`); continue; }
		if (ONLY && !name.includes(ONLY)) { continue; }
		if (QUICK && expect.slow) { info(`--quick: 跳过「${name}」`); continue; }
		await runCase(name, cfg, expect);
	}

	head('=== 汇总 ===');
	if (failures.length === 0) {
		console.log(`${C.green}全部通过${C.off}`);
		process.exit(0);
	}
	console.log(`${C.red}${failures.length} 项失败：${C.off}`);
	for (const f of failures) { console.log(`  · ${f}`); }
	process.exit(1);
}

main().catch(e => {
	console.error(`\n${C.red}测试异常中止:${C.off} ${e.message}`);
	if (e.stack) { console.error(`${C.dim}${e.stack.split('\n').slice(1, 4).join('\n')}${C.off}`); }
	process.exit(1);
});
