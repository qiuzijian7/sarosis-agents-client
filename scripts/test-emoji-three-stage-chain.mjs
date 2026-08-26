#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  test-emoji-three-stage-chain.mjs — 「图片 → 透明背景动态表情包」三阶段全自动串联测试。
 *
 *  阶段1  EmojiStage（1格）出透明 PNG（透明贴纸模板）
 *  阶段2  该 PNG 作首帧 → MiniMax H3 I2V Turbo 出动态 mp4
 *  阶段3  首帧 alpha + mp4 → 透明合成 → 透明动图 webp
 *
 *  三个阶段都用真实产品代码 runNodeOrStage，共享一个 MediaSnapshotStore，
 *  阶段间通过 upstreams 数组衔接（与真实画布连线一致）。
 *
 *  用法：
 *     node scripts/test-emoji-three-stage-chain.mjs
 *     node scripts/test-emoji-three-stage-chain.mjs --prompt "一只紫色小鸟"
 *     node scripts/test-emoji-three-stage-chain.mjs --skip-stage1  （阶段1已有产物时跳过）
 *
 *  退出码：0 = 通过；1 = 失败。
 *  前置：ComfyUI 运行在 8188；layerdiffuse 透明 LoRA/VAE + MiniMax H3 模型就绪。
 *--------------------------------------------------------------------------------------------*/

import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const PROMPT = argVal('--prompt',
	'A cute round purple cartoon bird with crystal wings, thick outlines, vibrant colors, isolated on transparent background, die-cut sticker');
const SKIP_STAGE1 = args.includes('--skip-stage1');

// ---------------------------------------------------------------- 输出
const C = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' };
const failures = [];
function ok(m) { console.log(`  ${C.green}✓${C.off} ${m}`); }
function fail(m) { console.log(`  ${C.red}✗${C.off} ${m}`); failures.push(m); }
function info(m) { console.log(`  ${C.dim}${m}${C.off}`); }
function head(m) { console.log(`\n${C.bold}${m}${C.off}`); }
function check(cond, msg) { cond ? ok(msg) : fail(msg); return cond; }

// ---------------------------------------------------------------- polyfill
if (typeof FileReader === 'undefined') {
	globalThis.FileReader = class {
		readAsDataURL(blob) {
			blob.arrayBuffer().then(buf => {
				const b64 = Buffer.from(buf).toString('base64');
				this.result = `data:${blob.type || 'application/octet-stream'};base64,${b64}`;
				this.onload?.();
			}).catch(e => { this.error = e; this.onerror?.(); });
		}
		abort() { /* no-op */ }
	};
	info('已 polyfill FileReader');
}
globalThis.__vssarosBridge = {
	createComfyFetch: (_baseUrl) => (input, init) => fetch(input, init),
};

// ---------------------------------------------------------------- runner
function makeRunner(baseUrl, onPrompt) {
	return {
		id: 'three-stage-chain', kind: 'local', baseUrl,
		async testConnection() { return { ok: true }; },
		async invoke(options) {
			onPrompt?.(options.prompt);
			const clientId = 'three-stage-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
			const res = await fetch(`${baseUrl}/prompt`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ prompt: options.prompt, client_id: clientId }),
			});
			if (!res.ok) {
				const t = await res.text();
				return { promptId: '', outputs: {}, status: 'error', error: `POST /prompt HTTP ${res.status}: ${t.slice(0, 400)}` };
			}
			const { prompt_id } = await res.json();
			// 阶段1 透明贴纸 ~150s，阶段2 MiniMax ~180s，阶段3 ~30s → 上限 600s/阶段
			for (let i = 0; i < 360; i++) {
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
	return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
}

// ---------------------------------------------------------------- main
async function main() {
	console.log(`${C.bold}「图片 → 透明背景动态表情包」三阶段全自动串联测试${C.off}  ${C.dim}(真实 runNodeOrStage，约 5~7 分钟)${C.off}`);
	head('[环境] ComfyUI');
	try {
		const s = await (await fetch(`${BASE}/system_stats`)).json();
		info(`目标 ${BASE}，ComfyUI ${s?.system?.comfyui_version ?? '?'}`);
	} catch (e) {
		console.error(`${C.red}无法连接 ${BASE}：${e.message}${C.off}`);
		process.exit(1);
	}

	const mod = await loadProdModules();
	info('已 bundle 真实 runNodeOrStage + MediaSnapshotStore');

	let capturedPrompt = null;
	const runner = makeRunner(BASE, (p) => { capturedPrompt = p; });
	const store = new mod.MediaSnapshotStore(mod.createMemoryBackend(), { maxPreviewRefs: 128 });

	// ── 阶段1：EmojiStage（1格）出透明 PNG ──────────────────────────────
	const stage1NodeId = 'stage1-emoji';
	const stage1Spec = () => ({ kind: 'schema', comfyTV: { kind: 'emoji', workflowKind: 'emoji' } });
	head('[阶段1] EmojiStage 透明贴纸（1格）');
	let stage1Ref = null;
	if (!SKIP_STAGE1) {
		const t1 = Date.now();
		const r1 = await mod.runNodeOrStage({
			runner, nodeId: stage1NodeId, snapshotKey: stage1NodeId,
			type: 'ComfyTV.EmojiStage', getSpec: stage1Spec,
			values: {
				workflow: '透明贴纸 (SDXL)',   // 透明贴纸模板 label（emojiWorkflows.ts）
				prompt: PROMPT, rows: 1, cols: 1, run_scope: 'all',
			},
			upstreams: [], store, signal: undefined,
		});
		info(`阶段1 耗时 ${((Date.now() - t1) / 1000).toFixed(0)}s status=${r1.status}`);
		check(r1.status === 'success', `阶段1 成功（status=${r1.status}${r1.error ? '，error=' + r1.error : ''}）`);
		if (r1.status !== 'success') { console.log(`${C.red}阶段1失败，终止${C.off}`); process.exit(1); }
		// 阶段1 产物（透明 PNG，materialize 成 data: URL）
		const imgs = store.byNode(stage1NodeId).filter(e => e.media.kind === 'image');
		stage1Ref = imgs[imgs.length - 1]?.media.ref ?? null;
		check(!!stage1Ref, `阶段1 产出透明 PNG（ref=${String(stage1Ref).slice(0, 40)}...）`);
		info(`阶段1 产物 ref 前缀: ${String(stage1Ref).slice(0, 30)}`);
	} else {
		// 跳过阶段1：直接注入一个 data: URL 模拟透明 PNG 产物
		info('--skip-stage1：跳过阶段1，注入模拟透明 PNG');
		stage1Ref = 'data:image/png;base64,__SKIP__';
		store.put({ nodeId: stage1NodeId, port: 'output', key: '', media: { kind: 'image', ref: stage1Ref } }, true);
	}

	// ── 阶段2：MiniMax H3 I2V Turbo（透明 PNG 作首帧）──────────────────
	const stage2NodeId = 'stage2-video';
	const stage2Spec = () => ({ kind: 'schema', comfyTV: { kind: 'video', workflowKind: 'video' } });
	head('[阶段2] MiniMax H3 I2V Turbo（首帧=阶段1透明PNG）');
	const t2 = Date.now();
	const r2 = await mod.runNodeOrStage({
		runner, nodeId: stage2NodeId, snapshotKey: stage2NodeId,
		type: 'ComfyTV.VideoStage', getSpec: stage2Spec,
		values: {
			workflow: 'Local MiniMax H3 I2V Turbo',
			prompt: PROMPT.replace(/isolated on transparent background, die-cut sticker/, 'blinks its eyes and flutters its crystal wings, plain solid background'),
			seed: 4242, duration_s: 2,
		},
		upstreams: [stage1NodeId], store, signal: undefined,
	});
	info(`阶段2 耗时 ${((Date.now() - t2) / 1000).toFixed(0)}s status=${r2.status}`);
	check(r2.status === 'success', `阶段2 成功（status=${r2.status}${r2.error ? '，error=' + r2.error : ''}）`);
	if (r2.status !== 'success') { console.log(`${C.red}阶段2失败，终止${C.off}`); process.exit(1); }

	// ── 阶段3：透明合成（mp4 + 透明PNG alpha → webp）────────────────────
	const stage3NodeId = 'stage3-composite';
	const stage3Spec = () => ({ kind: 'schema', comfyTV: { kind: 'video', workflowKind: 'video' } });
	head('[阶段3] 透明合成（Local Transparent Sticker Video）');
	const t3 = Date.now();
	const r3 = await mod.runNodeOrStage({
		runner, nodeId: stage3NodeId, snapshotKey: stage3NodeId,
		type: 'ComfyTV.VideoStage', getSpec: stage3Spec,
		values: { workflow: 'Local Transparent Sticker Video' },
		upstreams: [stage2NodeId, stage1NodeId], store, signal: undefined,
	});
	info(`阶段3 耗时 ${((Date.now() - t3) / 1000).toFixed(0)}s status=${r3.status}`);
	check(r3.status === 'success', `阶段3 成功（status=${r3.status}${r3.error ? '，error=' + r3.error : ''}）`);
	if (r3.status !== 'success') { console.log(`${C.red}阶段3失败，终止${C.off}`); process.exit(1); }

	// ── 产物断言：透明动图 webp ────────────────────────────────────────
	const entries = store.byNode(stage3NodeId);
	const webp = entries.find(e => /\.webp|animated/i.test(String(e.media.ref)) || e.media?.kind === 'image');
	check(entries.length >= 1, `阶段3 有产物（${entries.length} 个）`);
	check(!!webp, '阶段3 产出透明动图 webp');

	head('=== 汇总 ===');
	console.log(`${C.dim}三阶段：透明PNG(${stage1NodeId}) → 动态mp4(${stage2NodeId}) → 透明webp(${stage3NodeId})${C.off}`);
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
