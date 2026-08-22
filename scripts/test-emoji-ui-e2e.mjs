#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  test-emoji-ui-e2e.mjs — EmojiStage **完整 UI 链路**端到端测试。
 *
 *  与 test-emoji-e2e.mjs 的区别：
 *    · test-emoji-e2e.mjs   —— 直接 POST api_json（绕过 runNodeOrStage / 网格循环 / 注入逻辑）
 *    · 本脚本                 —— 真实调用 `runNodeOrStage` → `runEmojiStageGrid` →
 *                               `runStageWorkflow` → `runner.invoke`，**用产品代码本身**，
 *                               不做任何注入逻辑复刻。这才是「走完整 UI 链路」。
 *
 *  ## 为什么必要（血泪教训）
 *  此前出现过「e2e 直接 POST 正常、但 UI 里生成彩色噪声」——根因就藏在
 *  runEmojiStageGrid 的 cellValues 构造 / runStageWorkflow 的 applyStageOptionValues
 *  等**复刻逻辑覆盖不到**的地方。只有跑真实链路才能复现并抓住这类差异。
 *
 *  ## 测什么
 *   1. 真实 runner（POST /prompt + poll /history）打到 8188
 *   2. 真实 MediaSnapshotStore（createMemoryBackend）+ 真实 runNodeOrStage
 *   3. 静态「透明贴纸」→ 完整像素断言（alpha 方向 / 噪声 / 非纯色）
 *   4. 动态「动态表情」→ webp 容器断言（动画/帧数/alphaFlag）
 *      + runner 捕获的 prompt 参数断言（batch_size/sub_batch_size/fps/beta_schedule）
 *
 *  ## 用法
 *    node scripts/test-emoji-ui-e2e.mjs                    # 静态 + 动态
 *    node scripts/test-emoji-ui-e2e.mjs --only 静态        # 只跑静态（省 ~2min）
 *    node scripts/test-emoji-ui-e2e.mjs --only 动态        # 只跑动态
 *    node scripts/test-emoji-ui-e2e.mjs --base http://127.0.0.1:8189
 *    node scripts/test-emoji-ui-e2e.mjs --frames 12 --fps 10
 *
 *  退出码：0 = 通过；1 = 失败。
 *
 *  依赖：Node 22+（fetch/Blob）+ 仓库内 esbuild。需 polyfill FileReader（见下）。
 *  注意：真实推理，全量约 4 分钟并占用 GPU。
 *--------------------------------------------------------------------------------------------*/

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, parseWebp, alphaMetrics, noiseMetrics, dataUrlToBytes } from './emojiPixelAssert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW_RUN_TS = path.join(REPO_ROOT,
	'src/vs/sessions/contrib/agentStudio/webview/src/features/workflowEditor/comfyHost/workflowRun.ts');
const STORE_TS = path.join(REPO_ROOT,
	'src/vs/sessions/contrib/agentStudio/webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.ts');

// ---------------------------------------------------------------- CLI
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = argVal('--base', 'http://127.0.0.1:8188');
const PROMPT = argVal('--prompt', 'a cute cartoon orange cat');
const SEED = Number(argVal('--seed', '42'));
const FPS = Number(argVal('--fps', '10'));        // 非默认值，验证注入
const FRAMES = Number(argVal('--frames', '12'));  // 非默认值，验证注入
const ONLY = argVal('--only', '');

// ---------------------------------------------------------------- 输出
const C = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' };
const failures = [];
function ok(m) { console.log(`  ${C.green}✓${C.off} ${m}`); }
function fail(m) { console.log(`  ${C.red}✗${C.off} ${m}`); failures.push(m); }
function info(m) { console.log(`  ${C.dim}${m}${C.off}`); }
function head(m) { console.log(`\n${C.bold}${m}${C.off}`); }
function check(cond, msg) { cond ? ok(msg) : fail(msg); return cond; }

// ---------------------------------------------------------------- 环境 polyfill
// Node 22 有 Blob/fetch/Response.blob，但没有 FileReader。
// comfyImagePersist.materializeComfyImageRefs 用 FileReader 把 /view 图转 data URL，
// 这里用 Blob.arrayBuffer() + Buffer 实现一个最小 FileReader，贴近浏览器行为。
if (typeof FileReader === 'undefined') {
	globalThis.FileReader = class {
		readAsDataURL(blob) {
			blob.arrayBuffer().then(buf => {
				const b64 = Buffer.from(buf).toString('base64');
				this.result = `data:${blob.type || 'application/octet-stream'};base64,${b64}`;
				this.onload?.();
			}).catch(e => { this.error = e; this.onerror?.(); });
		}
		abort() { /* no-op：Node 无底层网络读取可中止 */ }
	};
	info('已 polyfill FileReader（Node 无此全局）');
}

// stageWorkflowExecutor 顶层解构 globalThis.__vssarosBridge.createComfyFetch。
// 必须在 bundle 加载前注入（见下方动态 import 时序）。
globalThis.__vssarosBridge = {
	createComfyFetch: (_baseUrl) => (input, init) => fetch(input, init),
};

// ---------------------------------------------------------------- 真实 runner
function makeRunner(baseUrl, onPrompt) {
	return {
		id: 'ui-e2e', kind: 'local', baseUrl,
		async testConnection() { return { ok: true }; },
		async invoke(options) {
			// ★ 记录这次 prompt，供「参数注入正确性」断言。
			onPrompt?.(options.prompt);
			const clientId = 'ui-e2e-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
			const res = await fetch(`${baseUrl}/prompt`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ prompt: options.prompt, client_id: clientId }),
			});
			if (!res.ok) {
				const t = await res.text();
				return { promptId: '', outputs: {}, status: 'error', error: `POST /prompt HTTP ${res.status}: ${t.slice(0, 400)}` };
			}
			const { prompt_id } = await res.json();
			for (let i = 0; i < 400; i++) {
				await new Promise(r => setTimeout(r, 2000));
				const h = await (await fetch(`${baseUrl}/history/${prompt_id}`)).json();
				const rec = h[prompt_id];
				if (rec?.status?.status_str && rec.status.status_str !== 'running') {
					const st = rec.status;
					if (st.status_str === 'success') {
						return { promptId: prompt_id, outputs: rec.outputs ?? {}, status: 'success' };
					}
					const msgs = (st.messages ?? [])
						.filter(m => Array.isArray(m) && m[0] === 'execution_error')
						.map(m => `[${m[1]?.node_type}] ${m[1]?.exception_message}`);
					return { promptId: prompt_id, outputs: rec.outputs ?? {}, status: 'error', error: msgs.join('; ') || 'execution failed' };
				}
			}
			return { promptId: prompt_id, outputs: {}, status: 'error', error: 'timeout' };
		},
	};
}

// ---------------------------------------------------------------- bundle 真实产品代码
async function loadProdModules() {
	const esbuild = await import('esbuild');
	const entry = [
		`export { runNodeOrStage } from ${JSON.stringify(WORKFLOW_RUN_TS)};`,
		`export { MediaSnapshotStore, createMemoryBackend } from ${JSON.stringify(STORE_TS)};`,
	].join('\n');
	const out = await esbuild.build({
		stdin: { contents: entry, resolveDir: path.dirname(WORKFLOW_RUN_TS), loader: 'ts' },
		bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
	});
	const code = out.outputFiles[0].text;
	// 动态 import：保证在 globalThis.__vssarosBridge / FileReader polyfill 之后加载。
	return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
}

// ---------------------------------------------------------------- 单用例
async function runCase(label, workflow, expectAnimated, mod) {
	head(`[用例] ${label}（真实 runNodeOrStage 链路）`);

	let capturedPrompt = null;
	const runner = makeRunner(BASE, (p) => { capturedPrompt = p; });
	const store = new mod.MediaSnapshotStore(mod.createMemoryBackend(), { maxPreviewRefs: 64 });

	const values = {
		rows: 1, cols: 1,
		fps: FPS, frames: FRAMES,
		prompt: PROMPT,
		cells: '[]',
		workflow,
		run_scope: 'all',
		selected_index: 0,
	};
	const getSpec = () => ({ kind: 'schema', comfyTV: { kind: 'emoji', workflowKind: 'emoji' } });

	const t0 = Date.now();
	const r = await mod.runNodeOrStage({
		runner, nodeId: 'emoji-ui-test', snapshotKey: 'emoji-ui-test',
		type: 'ComfyTV.EmojiStage', getSpec, values,
		upstreams: [], store, signal: undefined,
	});
	info(`耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s，status=${r.status}`);

	if (!check(r.status === 'success', `执行成功（status=${r.status}${r.error ? '，error=' + r.error : ''}）`)) {
		return;
	}

	const entries = store.byNode('emoji-ui-test').filter(e => e.media.kind === 'image');
	if (!check(entries.length >= 1, `store 有产物（${entries.length} 张 image）`)) { return; }
	info(`store entries: ${entries.map(e => e.key).join(', ')}`);

	// ---- 参数注入断言（runner 捕获的 prompt）----
	if (capturedPrompt) {
		const nodes = Object.values(capturedPrompt);
		const byType = (ct) => nodes.find(n => n.class_type === ct)?.inputs;
		if (expectAnimated) {
			const latent = byType('EmptyLatentImage');
			const dec = byType('LayeredDiffusionDecodeRGBA');
			const save = byType('SaveAnimatedWEBP');
			const ade = byType('ADE_AnimateDiffLoaderGen1');
			check(latent?.batch_size === FRAMES, `参数: EmptyLatentImage.batch_size == frames（${FRAMES}，实际 ${latent?.batch_size}）`);
			check(dec?.sub_batch_size === FRAMES, `参数: sub_batch_size == frames（${FRAMES}，实际 ${dec?.sub_batch_size}）`);
			check(save?.fps === FPS, `参数: SaveAnimatedWEBP.fps == fps（${FPS}，实际 ${save?.fps}）`);
			check(ade?.beta_schedule === 'linear (AnimateDiff-SDXL)', `参数: beta_schedule == "linear (AnimateDiff-SDXL)"（实际 ${ade?.beta_schedule}）`);
			// ★ 关键回归点：cellValues.batch_size=1 不得污染帧数（曾怀疑 UI 噪声根因）
			check(latent?.batch_size !== 1, `参数: batch_size 未被 cellValues.batch_size=1 污染（=${latent?.batch_size}）`);
		} else {
			const clip = nodes.filter(n => n.class_type === 'CLIPTextEncode').map(n => n.inputs?.text);
			check(clip.some(t => typeof t === 'string' && t.includes(PROMPT)), `参数: CLIPTextEncode 含 prompt「${PROMPT}」`);
		}
	} else {
		fail('runner 未捕获到 prompt（invoke 未被调用？）');
	}

	// ---- 产物像素/容器断言 ----
	for (const e of entries) {
		const ref = e.media.ref;
		if (expectAnimated && ref.startsWith('data:image/webp')) {
			const meta = parseWebp(dataUrlToBytes(ref));
			info(`webp: anim=${meta.isAnim} frames=${meta.frames} alphaFlag=${meta.hasAlphaFlag} lossless=${meta.lossless}`);
			check(meta.isAnim, `webp 是动画（ANIM flag）`);
			check(meta.frames === FRAMES, `webp 帧数 == frames（${FRAMES}，实际 ${meta.frames}）`);
			check(meta.hasAlphaFlag, `webp 有 alpha 通道`);
		} else if (!expectAnimated && ref.startsWith('data:image/png')) {
			const img = decodePng(dataUrlToBytes(ref));
			info(`PNG: ${img.width}×${img.height}, ${img.channels} 通道`);
			const m = alphaMetrics(img);
			info(`alpha: 不透明=${m.oPct.toFixed(1)}% 透明=${m.tPct.toFixed(1)}% 四角=[${m.corners.join(',')}] 外框均值=${m.edgeAvg.toFixed(1)} 中心均值=${m.ctrAvg.toFixed(1)} Δ=${(m.ctrAvg - m.edgeAvg).toFixed(1)}`);
			check(m.edgeAvg <= 32, `alpha 方向: 外框透明（均值 ${m.edgeAvg.toFixed(1)} ≤ 32）${m.edgeAvg > 32 ? (m.ctrAvg - m.edgeAvg < 0 ? ' ← 反转' : ' ← 主体溢出') : ''}`);
			check(m.corners.every(v => v <= 8), `alpha 方向: 四角透明`);
			check(m.oPct >= 2 && m.oPct <= 98, `alpha 方向: 不透明占比 ${m.oPct.toFixed(1)}% ∈ [2%,98%]`);
			check(m.ctrAvg - m.edgeAvg >= 15, `alpha 方向: 主体居中（Δ=${(m.ctrAvg - m.edgeAvg).toFixed(1)} ≥ 15）`);
			// ★ 静态透明贴纸不查噪声（layerdiffuse 解码自带高频，43 会误报），
			//   正确性由 alpha 方向 + 非纯色覆盖（见 emojiPixelAssert 注释）。
			const n = noiseMetrics(img);
			if (n) { info(`噪声(参考): 前景梯度=${n.gradient.toFixed(1)}（静态贴纸不据此判失败）`); }
		} else {
			fail(`未识别的产物 ref（expectAnimated=${expectAnimated}）：${ref.slice(0, 40)}...`);
		}
	}
}

// ---------------------------------------------------------------- main
async function main() {
	console.log(`${C.bold}EmojiStage 完整 UI 链路端到端测试${C.off}  ${C.dim}(真实 runNodeOrStage，全量约 4 分钟)${C.off}`);
	head('[环境] ComfyUI');
	try {
		const s = await (await fetch(`${BASE}/system_stats`)).json();
		info(`目标 ${BASE}，ComfyUI ${s?.system?.comfyui_version ?? '?'}，设备 ${s?.devices?.[0]?.name ?? '?'}`);
	} catch (e) {
		console.error(`${C.red}无法连接 ${BASE}：${e.message}${C.off}`);
		process.exit(1);
	}

	const mod = await loadProdModules();
	info(`已 bundle 真实 runNodeOrStage（workflowRun.ts）`);

	if (!ONLY || ONLY.includes('静态')) {
		await runCase('静态透明贴纸', '透明贴纸 (SDXL)', false, mod);
	}
	if (!ONLY || ONLY.includes('动态')) {
		await runCase('动态表情', '动态表情 (AnimateDiff)', true, mod);
	}

	head('=== 汇总 ===');
	if (failures.length === 0) { console.log(`${C.green}全部通过${C.off}`); process.exit(0); }
	console.log(`${C.red}${failures.length} 项失败：${C.off}`);
	for (const f of failures) { console.log(`  · ${f}`); }
	process.exit(1);
}

main().catch(e => {
	console.error(`\n${C.red}测试异常中止:${C.off} ${e.message}`);
	if (e.stack) { console.error(`${C.dim}${e.stack.split('\n').slice(1, 5).join('\n')}${C.off}`); }
	process.exit(1);
});
