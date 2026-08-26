#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  test-vox-director-e2e.mjs — Vox.DirectorStage 口播视频节点「真机」端到端测试。
 *
 *  与 test-emoji-*-e2e.mjs（直接 POST ComfyUI）不同，vox 走「本地 Python pipeline」：
 *     runNodeOrStage → runVoxDirectorNode → buildVoxBeats 组装 beats.json
 *     → 注入的 runVoxPipeline RPC（真实复刻主进程 VoxLaunchChannel 的 spawn 逻辑）
 *     → spawn `python vox_pipeline.py <outDir>` → 产出 final.mp4 → 归档 video 快照。
 *
 *  测什么（用产品代码本身，不复刻注入逻辑）：
 *   1. Vox.DirectorStage 正确路由到 runVoxDirectorNode（非通用 schema / 非 ComfyUI 后端）
 *   2. buildVoxBeats 组装出的 beats.json 能被真实 python pipeline 消费
 *      （keyframes SDXL 文生图 → clips zoompan 图生视频 → audio edge-tts → assemble ffmpeg）
 *   3. runVoxPipeline 返回后，store 落 kind=video 快照，ref 是 http URL（非 file://）
 *   4. final.mp4 真实存在且 ffprobe 可读（h264 视频流 + aac 音频流）
 *
 *  用法：
 *     node scripts/test-vox-director-e2e.mjs                          # topic 模板化（最短路径）
 *     node scripts/test-vox-director-e2e.mjs --topic "咖啡的历史"
 *     node scripts/test-vox-director-e2e.mjs --beats <beats.json>     # 完整 beats 透传
 *     node scripts/test-vox-director-e2e.mjs --project <vox项目根> --python <解释器>
 *
 *  退出码：0 = 通过；1 = 失败。
 *  依赖：Node 22+ + 仓库内 esbuild + 本地 python（vox-ai-motion-graphics-generator）+ ffmpeg。
 *  真实推理，约 1~3 分钟并占用 GPU。
 *--------------------------------------------------------------------------------------------*/

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, join } from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW_RUN_TS = path.join(REPO_ROOT,
	'src/vs/sessions/contrib/agentStudio/webview/src/features/workflowEditor/comfyHost/workflowRun.ts');
const STORE_TS = path.join(REPO_ROOT,
	'src/vs/sessions/contrib/agentStudio/webview/src/features/workflowEditor/comfyHost/mediaSnapshotStore.ts');

// ---------------------------------------------------------------- CLI
const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const VOX_PROJECT = argVal('--project', 'G:\\CustomWorkspaces\\AIProjects\\vox-ai-motion-graphics-generator');
const PYTHON = argVal('--python', 'python');
const TOPIC = argVal('--topic', '咖啡在征服世界之前，是一种秘密的能量。');
const BEATS_FILE = argVal('--beats', '');
const BEATS_COUNT = Number(argVal('--beats-count', '1'));
const DURATION = Number(argVal('--duration', '4'));

// ---------------------------------------------------------------- 输出
const C = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' };
const failures = [];
function ok(m) { console.log(`  ${C.green}✓${C.off} ${m}`); }
function fail(m) { console.log(`  ${C.red}✗${C.off} ${m}`); failures.push(m); }
function info(m) { console.log(`  ${C.dim}${m}${C.off}`); }
function head(m) { console.log(`\n${C.bold}${m}${C.off}`); }
function check(cond, msg) { cond ? ok(msg) : fail(msg); return cond; }

// ---------------------------------------------------------------- 环境 polyfill
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
}
globalThis.__vssarosBridge = {
	createComfyFetch: (_baseUrl) => (input, init) => fetch(input, init),
};

// ---------------------------------------------------------------- ffmpeg/ffprobe 多级探测（复刻主进程）
function findWingetBin(name) {
	if (process.platform !== 'win32') { return undefined; }
	const localAppData = process.env['LOCALAPPDATA'];
	if (!localAppData) { return undefined; }
	const pkgsRoot = join(localAppData, 'Microsoft', 'WinGet', 'Packages');
	let pkgNames = [];
	try { pkgNames = readdirSync(pkgsRoot).filter(n => n.toLowerCase().includes('ffmpeg')); } catch { return undefined; }
	for (const pkg of pkgNames) {
		const pkgDir = join(pkgsRoot, pkg);
		let versionDirs = [];
		try { versionDirs = readdirSync(pkgDir); } catch { continue; }
		for (const vd of versionDirs) {
			const candidate = join(pkgDir, vd, 'bin', `${name}.exe`);
			if (existsSync(candidate)) { return candidate; }
		}
	}
	return undefined;
}
function resolveBin(name, envKey) {
	const fromEnv = process.env[envKey]?.trim();
	if (fromEnv) { return fromEnv; }
	return findWingetBin(name);
}

// ---------------------------------------------------------------- 最小静态 http server（复刻主进程 ensureStaticServer）
const MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.json': 'application/json' };
function startStaticServer(rootDir) {
	return new Promise((res) => {
		const server = createServer((req, resp) => {
			try {
				const url = (req.url ?? '/').split('?')[0];
				const target = resolve(join(rootDir, decodeURIComponent(url).replace(/^\//, '')));
				if (!target.startsWith(resolve(rootDir)) || !existsSync(target) || !statSync(target).isFile()) {
					resp.writeHead(404); resp.end('Not found'); return;
				}
				const st = statSync(target);
				const contentType = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
				const range = req.headers.range;
				if (range) {
					const m = /bytes=(\d*)-(\d*)/.exec(range);
					const total = st.size;
					let start = 0, end = total - 1;
					if (m) { if (m[1]) { start = parseInt(m[1], 10); } if (m[2]) { end = Math.min(parseInt(m[2], 10), total - 1); } }
					resp.writeHead(206, { 'Content-Type': contentType, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
					createReadStream(target, { start, end }).pipe(resp);
				} else {
					resp.writeHead(200, { 'Content-Type': contentType, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
					createReadStream(target).pipe(resp);
				}
			} catch { resp.writeHead(500); resp.end('Internal error'); }
		});
		server.listen(0, '127.0.0.1', () => {
			const addr = server.address();
			res({ server, base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` });
		});
	});
}

// ---------------------------------------------------------------- 真实 runVoxPipeline（复刻主进程 VoxLaunchChannel.voxRun）
function makeVoxPipeline(voxProject, python, ffmpeg, ffprobe, staticBase) {
	return async ({ projectId, beats, onStage, signal }) => {
		const scriptsDir = join(voxProject, 'scripts');
		const pipeline = join(scriptsDir, 'vox_pipeline.py');
		const outDir = join(voxProject, 'out', projectId);
		if (!existsSync(pipeline)) {
			return { ok: false, error: `未找到 vox 入口脚本 ${pipeline}` };
		}
		mkdirSync(outDir, { recursive: true });
		writeFileSync(join(outDir, 'beats.json'), JSON.stringify(beats, null, 2), 'utf-8');

		const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
		if (ffmpeg) { env['FFMPEG_PATH'] = ffmpeg; }
		if (ffprobe) { env['FFPROBE_PATH'] = ffprobe; }

		info(`spawn ${python} ${pipeline} ${outDir}`);
		const child = spawn(python, [pipeline, outDir], {
			cwd: scriptsDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
		});

		let lastStage = '';
		let lastProgress = 0;
		const errLines = [];
		child.stdout.on('data', (chunk) => {
			for (const line of String(chunk).split(/\r?\n/)) {
				const t = line.trim();
				if (!t) { continue; }
				const pm = /^\[PROGRESS\]\s+(\S+)\s+(\d+)\/(\d+)\s*(.*)$/.exec(t);
				if (pm) {
					const stage = pm[1];
					const i = Number(pm[2]);
					const n = Number(pm[3]);
					lastStage = stage;
					lastProgress = stage === 'done' ? 100 : Math.max(0, Math.min(100, Math.round(((i - 1) / n) * 100)));
					onStage?.(stage, lastProgress);
				} else if (t.startsWith('[ERROR]')) {
					errLines.push(t.slice('[ERROR]'.length).trim());
				}
			}
		});
		child.stderr.on('data', (chunk) => { errLines.push(...String(chunk).split(/\r?\n/).filter(Boolean)); });

		const code = await new Promise((res) => {
			child.on('error', (err) => { errLines.push(`spawn 失败: ${err.message}`); res(-1); });
			child.on('exit', (c) => res(c ?? -1));
		});

		if (signal?.aborted) {
			try { child.kill(); } catch { /* 已退出 */ }
			return { ok: false, error: '已取消' };
		}

		const final = join(outDir, 'final.mp4');
		if (code !== 0 || !existsSync(final)) {
			return { ok: false, error: (errLines.join('\n').slice(-500) || `pipeline 退出码 ${code}`) };
		}
		info(`pipeline 完成 stage=${lastStage} progress=${lastProgress}% → ${final}`);
		return { ok: true, finalMp4Path: final, finalMp4Url: `${staticBase}/${projectId}/final.mp4` };
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
	console.log(`${C.bold}Vox.DirectorStage 口播视频节点「真机」端到端测试${C.off}  ${C.dim}(真实 runNodeOrStage + 本地 python pipeline，约 1~3 分钟)${C.off}`);

	head('[环境] vox 项目 + python + ffmpeg');
	const scriptsDir = join(VOX_PROJECT, 'scripts');
	const pipeline = join(scriptsDir, 'vox_pipeline.py');
	check(existsSync(pipeline), `vox 入口脚本存在（${pipeline}）`);
	const pyVer = spawnSync(PYTHON, ['--version'], { encoding: 'utf-8' });
	check(pyVer.status === 0, `python 可用（${(pyVer.stdout || pyVer.stderr).trim()}）`);
	const ffmpeg = resolveBin('ffmpeg', 'FFMPEG_PATH');
	const ffprobe = resolveBin('ffprobe', 'FFPROBE_PATH');
	info(`ffmpeg=${ffmpeg ?? '(PATH)'}  ffprobe=${ffprobe ?? '(PATH)'}`);
	check(!!ffmpeg, 'ffmpeg 已探测到（env FFMPEG_PATH 或 winget）');
	if (!existsSync(pipeline) || pyVer.status !== 0 || !ffmpeg) {
		console.error(`${C.red}环境不满足，中止。${C.off}`);
		process.exit(1);
	}

	const { server, base } = await startStaticServer(join(VOX_PROJECT, 'out'));
	info(`静态服务启动 ${base}`);

	const mod = await loadProdModules();
	info('已 bundle 真实 runNodeOrStage（workflowRun.ts）+ MediaSnapshotStore');

	const store = new mod.MediaSnapshotStore(mod.createMemoryBackend(), { maxPreviewRefs: 64 });

	// ---- 组装 values + upstreams（topic 模板化 或 完整 beats 透传）----
	const values = {
		topic: TOPIC,
		beats_count: BEATS_COUNT,
		duration: DURATION,
		aspect: '9:16',
		language: 'zh',
		video_model: 'local-ltx',
		provider: 'local',
		voice_id: '',
		speed: 1,
		music: '',
		caption_style: 'white',
	};
	let upstreams = [];
	if (BEATS_FILE) {
		// 完整 beats 透传：把 beats.json 内容作为 text 快照塞进 store，upstreams 指向它。
		const beatsText = (await import('node:fs')).readFileSync(BEATS_FILE, 'utf-8');
		store.put({ nodeId: 'script-src', port: 'texts', key: 'script-src:texts:0', index: 0, media: { kind: 'text', ref: beatsText } }, true);
		upstreams = ['script-src'];
		info(`走完整 beats 透传（${BEATS_FILE}）`);
	} else {
		info(`走 topic 模板化（topic="${TOPIC}"，beats_count=${BEATS_COUNT}）`);
	}

	const getSpec = () => ({ kind: 'schema', comfyTV: { kind: 'video', workflowKind: 'video' } });
	const dummyRunner = { id: 'vox-e2e', kind: 'local', baseUrl: '', testConnection: async () => ({ ok: true }), invoke: async () => ({ status: 'error', error: 'unused' }) };
	const runVoxPipeline = makeVoxPipeline(VOX_PROJECT, PYTHON, ffmpeg, ffprobe, base);

	const t0 = Date.now();
	const r = await mod.runNodeOrStage({
		runner: dummyRunner, nodeId: 'vox-director-test', snapshotKey: 'vox-director-test',
		type: 'Vox.DirectorStage', getSpec, values, upstreams, store, signal: undefined, runVoxPipeline,
	});
	info(`耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s，status=${r.status}`);
	check(r.status === 'success', `执行成功（status=${r.status}${r.error ? '，error=' + r.error : ''}）`);
	if (r.status !== 'success') { server.close(); return; }

	// ---- 产物断言：store 落 video 快照，ref 是 http URL ----
	const entries = store.byNode('vox-director-test');
	const videos = entries.filter(e => e.media?.kind === 'video');
	check(videos.length >= 1, `store 有 kind=video 产物（${videos.length} 个）`);
	for (const v of videos) {
		info(`video entry key=${v.key} ref=${String(v.media.ref).slice(0, 90)}`);
		check(/^https?:\/\//.test(String(v.media.ref)), 'video ref 是 http URL（非 file://）');
		const localPath = v.media.meta?.localPath;
		check(!!localPath && existsSync(localPath), `final.mp4 真实存在（${localPath}）`);

		// ---- ffprobe 验证产物是合法 h264+aac 视频 ----
		if (localPath && ffprobe) {
			const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', localPath], { encoding: 'utf-8' });
			if (probe.status === 0) {
				try {
					const streams = JSON.parse(probe.stdout).streams ?? [];
					const hasVideo = streams.some(s => s.codec_type === 'video' && s.codec_name === 'h264');
					const hasAudio = streams.some(s => s.codec_type === 'audio' && s.codec_name === 'aac');
					const dims = streams.find(s => s.codec_type === 'video');
					check(hasVideo, 'ffprobe: 含 h264 视频流');
					check(hasAudio, 'ffprobe: 含 aac 音频流');
					info(`ffprobe: ${dims?.width ?? '?'}×${dims?.height ?? '?'}`);
				} catch { fail('ffprobe 输出解析失败'); }
			} else { fail(`ffprobe 执行失败：${probe.stderr.slice(0, 200)}`); }
		}
	}

	server.close();

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
