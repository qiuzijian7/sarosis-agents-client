#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  test-emoji-video-ui-e2e.mjs — VideoStage「图片 → 表情包动态视频」完整 UI 链路测试。
 *
 *  与 test-emoji-e2e.mjs（直接 POST）不同，本脚本真实调用产品代码：
 *     runNodeOrStage → runStageWorkflow → injectWorkflowValues → runner.invoke
 *  用一张图片作为 first_frame，走固化的 "Local MiniMax H3 I2V Turbo" 模板，
 *  验证「用图片生成表情包动态视频」的功能链路端到端可用。
 *
 *  测什么：
 *   1. VideoStage（ComfyTV.VideoStage）正确路由到 runStageWorkflow（非单节点降级）
 *   2. 内置模板 "Local MiniMax H3 I2V Turbo" 能解析、注入 prompt/seed/duration_s
 *   3. 上游图片（first_frame）经 upstream_image:annotated[0] 注入 LoadImage
 *   4. 出片成功，store 里落 video 快照（ref 指向 /view 的 mp4）
 *
 *  用法：
 *     node scripts/test-emoji-video-ui-e2e.mjs
 *     node scripts/test-emoji-video-ui-e2e.mjs --img 45239093-ec70-4709-a178-3c028eeb4861.png
 *     node scripts/test-emoji-video-ui-e2e.mjs --duration 1 --seed 7
 *
 *  退出码：0 = 通过；1 = 失败。
 *  依赖：Node 22+ + 仓库内 esbuild。真实推理（Turbo 4 步，约 1~3 分钟）。
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
const IMG = argVal('--img', '45239093-ec70-4709-a178-3c028eeb4861.png');
const PROMPT = argVal('--prompt',
	'A cute round purple cartoon bird with crystal wings. The bird blinks its big black eyes, '
	+ 'flutters its shimmering crystal wings, and bobs up and down cheerfully. '
	+ 'Adorable chibi emoji style, clean background, soft natural lighting, 24fps.');
const SEED = Number(argVal('--seed', '42'));
const DURATION = Number(argVal('--duration', '2'));  // 秒 → 帧数由 ComfyMathExpression 网格化

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
		id: 'ui-e2e-video', kind: 'local', baseUrl,
		async testConnection() { return { ok: true }; },
		async invoke(options) {
			onPrompt?.(options.prompt);
			const clientId = 'ui-e2e-video-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
			const res = await fetch(`${baseUrl}/prompt`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ prompt: options.prompt, client_id: clientId }),
			});
			if (!res.ok) {
				const t = await res.text();
				return { promptId: '', outputs: {}, status: 'error', error: `POST /prompt HTTP ${res.status}: ${t.slice(0, 400)}` };
			}
			const { prompt_id } = await res.json();
			for (let i = 0; i < 600; i++) {
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
	console.log(`${C.bold}VideoStage「图片 → 表情包动态视频」完整 UI 链路测试${C.off}  ${C.dim}(真实 runNodeOrStage，约 1~3 分钟)${C.off}`);
	head('[环境] ComfyUI');
	try {
		const s = await (await fetch(`${BASE}/system_stats`)).json();
		info(`目标 ${BASE}，ComfyUI ${s?.system?.comfyui_version ?? '?'}，设备 ${s?.devices?.[0]?.name ?? '?'}`);
	} catch (e) {
		console.error(`${C.red}无法连接 ${BASE}：${e.message}${C.off}`);
		process.exit(1);
	}

	const mod = await loadProdModules();
	info('已 bundle 真实 runNodeOrStage（workflowRun.ts）+ MediaSnapshotStore');

	let capturedPrompt = null;
	const runner = makeRunner(BASE, (p) => { capturedPrompt = p; });
	const store = new mod.MediaSnapshotStore(mod.createMemoryBackend(), { maxPreviewRefs: 64 });

	// ★ 上游图片：把 input 目录里的图片文件名作为 image snapshot 注入 first_frame。
	//   upstream_image:annotated[0] 对无 '?' 的纯文件名原样返回（viewUrlToAnnotated），
	//   LoadImage 直接加载该文件名。
	store.put({
		nodeId: 'img-src',
		port: 'output',
		key: 'img-src:output:0',
		media: { kind: 'image', ref: IMG },
		index: 0,
	});

	const values = {
		workflow: 'Local MiniMax H3 I2V Turbo',
		prompt: PROMPT,
		seed: SEED,
		duration_s: DURATION,
	};
	const getSpec = () => ({ kind: 'schema', comfyTV: { kind: 'video', workflowKind: 'video' } });

	const t0 = Date.now();
	const r = await mod.runNodeOrStage({
		runner, nodeId: 'video-ui-test', snapshotKey: 'video-ui-test',
		type: 'ComfyTV.VideoStage', getSpec, values,
		upstreams: ['img-src'], store, signal: undefined,
	});
	info(`耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s，status=${r.status}`);
	check(r.status === 'success', `执行成功（status=${r.status}${r.error ? '，error=' + r.error : ''}）`);
	if (r.status !== 'success') { return; }

	// ---- 参数注入断言（runner 捕获的 prompt）----
	if (capturedPrompt) {
		const nodes = Object.values(capturedPrompt);
		const byType = (ct) => nodes.find(n => n.class_type === ct)?.inputs;
		const core = byType('MiniMaxH3ImageToVideo');
		const sched = byType('BasicScheduler');
		const lora = byType('LoraLoaderModelOnly');
		const loadImg = byType('LoadImage');
		check(core, 'prompt 含核心节点 MiniMaxH3ImageToVideo');
		check(core?.first_frame?.[0] != null, `核心节点接 first_frame（源节点 ${core?.first_frame?.[0]}）`);
		check(sched?.steps === 4, `Turbo 4 步（BasicScheduler.steps=${sched?.steps}）`);
		check(lora?.lora_name?.includes('fl2v_turbo'), `Turbo LoRA 已接入（${lora?.lora_name}）`);
		check(loadImg?.image === IMG, `LoadImage.image 注入图片「${IMG}」（实际 ${loadImg?.image}）`);
		check(core?.prompt === PROMPT, '核心节点 prompt 注入用户描述');
	} else {
		fail('runner 未捕获到 prompt（invoke 未被调用？）');
	}

	// ---- 产物断言：store 里落视频快照 ----
	// ★ ComfyTV SaveVideo 写 /history 的槽名是 `images`/`animated`（非 `videos`），
	//   被 normalizeOutputSlot 归成 kind=image；但内容确实是 mp4（ref 为
	//   data:video/mp4 或 /view 的 .mp4）。故按 ref 内容判视频，不按 kind 判。
	const entries = store.byNode('video-ui-test');
	// ★ 严格断言：修复 normalizeOutputSlot 后，SaveVideo 的 mp4 必须归为 kind=video
	//   （不再靠「按 ref 内容猜」的宽松判断）。
	const videos = entries.filter(e => e.media?.kind === 'video');
	check(videos.length >= 1, `store 有 kind=video 产物（${videos.length} 个）`);
	for (const v of videos) {
		info(`video entry key=${v.key} kind=${v.media?.kind} ref=${String(v.media.ref).slice(0, 110)}`);
		check(/data:video\/mp4|\.mp4/i.test(String(v.media.ref)), 'video ref 指向 mp4（data:video/mp4 或 .mp4）');
	}
	// 负向断言：不应再有任何 kind=image 的 mp4（修复前会误判）
	const mislabeled = entries.filter(e => e.media?.kind === 'image' && /\.mp4/i.test(String(e.media.ref)));
	check(mislabeled.length === 0, `无 kind=image 的 mp4 误判（误判 ${mislabeled.length} 个）`);

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
