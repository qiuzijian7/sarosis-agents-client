#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  test-emoji-transparent-video-ui-e2e.mjs — 「透明背景动态表情包」完整 UI 链路测试。
 *
 *  三阶段链路（路线 B）：
 *    阶段1  表情包节点出透明 PNG（本测试直接用现成的 input 透明 PNG）
 *    阶段2  MiniMax H3 I2V Turbo 出动态视频（本测试用现成的 input mp4）
 *    阶段3  透明合成：视频帧 + 透明 PNG 的 alpha → 透明动态 webp ★被测对象
 *
 *  与临时脚本 _stage3_transparent.py 不同，本测试走真实产品代码：
 *    runNodeOrStage → runStageWorkflow → injectWorkflowValues → runner.invoke
 *  用固化的 "Local Transparent Sticker Video" workflow（videoWorkflows.ts）。
 *
 *  测什么：
 *   1. VideoStage 正确路由到 runStageWorkflow（kind=video）
 *   2. "Local Transparent Sticker Video" workflow 解析 + upstream 注入
 *   3. 上游视频（upstream_video:annotated[0]）→ LoadVideo.file
 *   4. 上游透明 PNG（upstream_image:annotated[0]）→ LoadImage.image
 *   5. alpha 取 LoadImage 的 MASK slot（JoinImageWithAlpha.alpha = ["1",1]）
 *   6. 出片成功，store 落透明动图 webp（kind=image，含 animated 标志）
 *
 *  用法：
 *     node scripts/test-emoji-transparent-video-ui-e2e.mjs
 *     node scripts/test-emoji-transparent-video-ui-e2e.mjs --img <透明PNG文件名> --video <mp4文件名>
 *
 *  退出码：0 = 通过；1 = 失败。
 *  前置：ComfyUI 运行在 8188；input 目录已有透明 PNG 和动态 mp4。
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
const PNG = argVal('--img', 'emoji_sticker_transparent.png');
const MP4 = argVal('--video', 'emoji_transparent_anim_00001_.mp4');

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
		id: 'ui-e2e-transparent', kind: 'local', baseUrl,
		async testConnection() { return { ok: true }; },
		async invoke(options) {
			onPrompt?.(options.prompt);
			const clientId = 'ui-e2e-transparent-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
			const res = await fetch(`${baseUrl}/prompt`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ prompt: options.prompt, client_id: clientId }),
			});
			if (!res.ok) {
				const t = await res.text();
				return { promptId: '', outputs: {}, status: 'error', error: `POST /prompt HTTP ${res.status}: ${t.slice(0, 400)}` };
			}
			const { prompt_id } = await res.json();
			for (let i = 0; i < 180; i++) {
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
	console.log(`${C.bold}「透明背景动态表情包」完整 UI 链路测试${C.off}  ${C.dim}(真实 runNodeOrStage，阶段3 约 30s)${C.off}`);
	head('[环境] ComfyUI');
	try {
		const s = await (await fetch(`${BASE}/system_stats`)).json();
		info(`目标 ${BASE}，ComfyUI ${s?.system?.comfyui_version ?? '?'}`);
	} catch (e) {
		console.error(`${C.red}无法连接 ${BASE}：${e.message}${C.off}`);
		process.exit(1);
	}

	const mod = await loadProdModules();
	info('已 bundle 真实 runNodeOrStage（workflowRun.ts）+ MediaSnapshotStore');

	let capturedPrompt = null;
	const runner = makeRunner(BASE, (p) => { capturedPrompt = p; });
	const store = new mod.MediaSnapshotStore(mod.createMemoryBackend(), { maxPreviewRefs: 64 });

	// ★ 两个上游：
	//   img-src: 透明 PNG（kind=image，ref=纯文件名）
	//   vid-src: 动态 mp4（kind=video，ref=纯文件名）
	//   upstream_video:annotated[0] / upstream_image:annotated[0] 对纯文件名原样返回。
	store.put({
		nodeId: 'img-src', port: 'output', key: 'img-src:output:0',
		media: { kind: 'image', ref: PNG }, index: 0,
	});
	store.put({
		nodeId: 'vid-src', port: 'output', key: 'vid-src:output:0',
		media: { kind: 'video', ref: MP4 }, index: 0,
	});

	const values = {
		workflow: 'Local Transparent Sticker Video',
	};
	const getSpec = () => ({ kind: 'schema', comfyTV: { kind: 'video', workflowKind: 'video' } });

	const t0 = Date.now();
	const r = await mod.runNodeOrStage({
		runner, nodeId: 'transparent-ui-test', snapshotKey: 'transparent-ui-test',
		type: 'ComfyTV.VideoStage', getSpec, values,
		upstreams: ['vid-src', 'img-src'], store, signal: undefined,
	});
	info(`耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s，status=${r.status}`);
	check(r.status === 'success', `执行成功（status=${r.status}${r.error ? '，error=' + r.error : ''}）`);
	if (r.status !== 'success') { return; }

	// ---- workflow 结构断言（runner 捕获的 prompt）----
	if (capturedPrompt) {
		const nodes = Object.values(capturedPrompt);
		const byType = (ct) => nodes.find(n => n.class_type === ct)?.inputs;
		const loadImg = byType('LoadImage');
		const loadVid = byType('LoadVideo');
		const join = byType('JoinImageWithAlpha');
		const save = byType('SaveAnimatedWEBP');
		check(loadImg, 'prompt 含 LoadImage（透明 PNG）');
		check(loadVid, 'prompt 含 LoadVideo（动态视频）');
		check(join, 'prompt 含 JoinImageWithAlpha（合成）');
		check(save, 'prompt 含 SaveAnimatedWEBP（透明动图输出）');
		check(loadImg?.image === PNG, `LoadImage.image 注入透明 PNG「${PNG}」（实际 ${loadImg?.image}）`);
		check(loadVid?.file === MP4, `LoadVideo.file 注入动态视频「${MP4}」（实际 ${loadVid?.file}）`);
		// ★ alpha 必须取 LoadImage 的 MASK 槽（slot 1），不是 IMAGE 槽（slot 0）
		const alphaSrc = join?.alpha;
		const alphaIsMaskSlot = Array.isArray(alphaSrc) && alphaSrc[0] === '1' && alphaSrc[1] === 1;
		check(alphaIsMaskSlot, `JoinImageWithAlpha.alpha 取 LoadImage MASK 槽（["1",1]），实际 ${JSON.stringify(alphaSrc)}`);
	} else {
		fail('runner 未捕获到 prompt（invoke 未被调用？）');
	}

	// ---- 产物断言：透明动图 webp ----
	const entries = store.byNode('transparent-ui-test');
	check(entries.length >= 1, `store 有产物（${entries.length} 个）`);
	for (const e of entries) {
		info(`entry key=${e.key} kind=${e.media?.kind} ref=${String(e.media.ref).slice(0, 90)}`);
	}
	const webp = entries.find(e => /\.webp/i.test(String(e.media.ref)) || e.media?.kind === 'image');
	check(!!webp, '有 webp 透明动图产物（SaveAnimatedWEBP 进 images slot）');

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
