/* eslint-disable */
/**
 * 媒体工具链离线自检（ffmpeg / ffprobe / yt-dlp）—— 2026-09-24。
 *
 * ## 为什么需要它（而不是用产品里那个「媒体工具链自检」命令）
 *
 * 产品内的自检入口要求**应用正跑着**；而本仓已经踩过一次"接线漏了、但单测全绿"的坑：
 * `builtinToolProvider` 的两个视频工具注册**漏注入 `runCommand`** ⇒ 管线缺省成
 * `async () => undefined` ⇒ 结论永远是 `no-channel` ⇒ 工具在真实环境里**恒报**
 * "当前环境没有命令执行通道（非桌面版）"，而单测因为都注入了 fake runner 所以全绿。
 *
 * 这个脚本把**真实解析链 + 真实进程执行**串起来，不开应用也能回答：
 *   ① 解析链到底指到哪个 exe（`内置 <path>` / `覆盖` / `PATH`）—— 这是"有没有随包二进制"的判据；
 *   ② 真实抽一次帧（用内置 ffmpeg 生成 2 秒测试视频 → 抽 4 帧落 PNG）—— 这是"能力真的可用"的判据；
 *   ③ 反向对照：**不注入**命令通道时必须给出 `no-channel`（证明这条判据确实能抓到漏接线）。
 *
 * 用法：`node scripts/verify-media-toolchain.mjs [appRoot]`
 *   `appRoot` 缺省取 `<repo>/out`（dev 形态下 `INativeEnvironmentService.appRoot` 的值；
 *   也是 `knowledge/mediaBinaries.ts` 向上回溯找 `build/saros/bin` 的起点）。
 */
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { exec } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_ROOT = process.argv[2] ?? path.join(ROOT, 'out');
const BUNDLE = path.join(ROOT, '.tmp-verify-media-bundle.mjs');
const TMP = path.join(ROOT, '.tmp-verify-media');

const results = [];
let failed = 0;
function check(name, ok, detail) {
	results.push(`${ok ? '  ✔' : '  ✖'} ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) { failed++; }
}
function section(title) { results.push(`\n${title}`); }

/** 与 `ts-js-resolve` 同款：把 `.js` 说明符改指到同名 `.ts`（本仓源码里 import 带 .js 后缀）。 */
const tsResolvePlugin = {
	name: 'ts-js-resolve',
	setup(build) {
		build.onResolve({ filter: /\.js$/ }, args => {
			if (!args.path.startsWith('.') && !args.path.startsWith('/')) { return undefined; }
			const candidate = args.path.replace(/\.js$/, '.ts');
			const resolved = path.resolve(args.resolveDir, candidate);
			return existsSync(resolved) ? { path: resolved, namespace: 'file' } : undefined;
		});
	},
};

await esbuild.build({
	stdin: {
		contents: [
			`export { probeMediaToolchain, prepareVideoAndFrames, resolveToolchain, buildCommand, resolveAsrToolchain, transcribeWithWhisper, parseWhisperStdout } from './src/vs/sessions/contrib/agentStudio/browser/providers/tool/videoMediaPipeline.js';`,
			// 解析结果的渲染在 `knowledge/mediaBinaries.ts`（管线只是 import 它，未再导出）
			`export { describeResolvedBinary } from './src/vs/sessions/contrib/agentStudio/browser/knowledge/mediaBinaries.js';`,
		].join('\n'),
		resolveDir: ROOT,
		loader: 'ts',
	},
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	outfile: BUNDLE,
	plugins: [tsResolvePlugin],
	logLevel: 'warning',
	tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
});

const {
	probeMediaToolchain, prepareVideoAndFrames, resolveToolchain, buildCommand, describeResolvedBinary,
	resolveAsrToolchain, transcribeWithWhisper, parseWhisperStdout,
} = await import(pathToFileURL(BUNDLE).href);

// ─── 宿主替身（形状对齐 IFileService / ILogService / runCommand）─────────────

const logs = [];
const logService = {
	info: m => logs.push(`[info] ${m}`), warn: m => logs.push(`[warn] ${m}`),
	error: m => logs.push(`[error] ${m}`), debug: () => { }, trace: () => { },
};

/** 真实文件系统上的最小 IFileService（管线用到的：stat/exists/resolve/createFolder/del[/writeFile]）。 */
const fileService = {
	stat: async uri => { const s = await fs.stat(uri.fsPath); return { isDirectory: s.isDirectory(), size: s.size }; },
	exists: async uri => { try { await fs.stat(uri.fsPath); return true; } catch { return false; } },
	resolve: async uri => {
		const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
		return { children: entries.map(d => ({ name: d.name, isDirectory: d.isDirectory() })) };
	},
	createFolder: async uri => { await fs.mkdir(uri.fsPath, { recursive: true }); },
	del: async (uri, opts) => { await fs.rm(uri.fsPath, { recursive: opts?.recursive === true, force: true }); },
	writeFile: async (uri, content) => { await fs.writeFile(uri.fsPath, content); },
};

/** 与 `feishuSyncCore.execShortCommand` 同族：`shell:true`、返回 `{ ok, exitCode, stdout, stderr }`。 */
const makeRunCommand = timeoutDefault => (command, timeoutMs) => new Promise(resolve => {
	exec(command, { timeout: timeoutMs ?? timeoutDefault, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
		(err, stdout, stderr) => resolve({ ok: !err, exitCode: err?.code ?? 0, stdout: String(stdout), stderr: String(stderr) }));
});

const baseCtx = {
	fileService, logService,
	appRoot: APP_ROOT,
	mediaBinaryRuntime: { platform: process.platform, env: process.env },
	resolveAndCheckWorkspacePath: async (_agentId, p) => path.resolve(p),
};

try {
	section(`媒体工具链自检（appRoot=${APP_ROOT}）`);

	// ① 解析链指到哪里 —— 不依赖任何执行通道，最纯粹的判据
	const bins = await resolveToolchain(baseCtx);
	for (const b of [bins.ffmpeg, bins.ffprobe, bins.ytdlp]) {
		check(`resolve: ${describeResolvedBinary(b)}`, b.source !== 'path' || /^(ffmpeg|ffprobe|yt-dlp)$/.test(b.command));
	}
	check('resolve: ffmpeg 找到随包/仓库内置（不得落到裸命令名）', bins.ffmpeg.source !== 'path', describeResolvedBinary(bins.ffmpeg));
	check('resolve: yt-dlp 找到随包/仓库内置（不得落到裸命令名）', bins.ytdlp.source !== 'path', describeResolvedBinary(bins.ytdlp));
	results.push(`    ffmpeg 命令串: ${buildCommand(bins.ffmpeg.command, ['-version'])}`);
	results.push(`    yt-dlp 命令串: ${buildCommand(bins.ytdlp.command, ['--version'])}`);

	// ② 反向对照：**不注入** runCommand ⇒ 必须 `no-channel`（证明漏接线抓得到，而不是静默通过）
	const noChannel = await probeMediaToolchain({ ...baseCtx, runCommand: undefined }, { remote: true, force: true });
	check('probe(无命令通道): 结论必须是 no-channel（旧故障形态可复现）', noChannel.status === 'no-channel', noChannel.status);
	check('probe(无命令通道): 必须打出 error 日志（否则漏接线又变静默）',
		logs.some(l => l.startsWith('[error]') && l.includes('未注入命令通道')));
	logs.length = 0;

	// ③ 正向：注入真实 exec ⇒ 三个二进制都应探活成功
	const probe = await probeMediaToolchain({ ...baseCtx, runCommand: makeRunCommand(30_000) }, { remote: true, force: true });
	check('probe(注入命令通道): status=ok', probe.status === 'ok', probe.status + (probe.message ? ` / ${probe.message.split('\n')[0]}` : ''));

	// ④ 端到端抽帧：内置 ffmpeg 生成测试视频 → 管线抽 4 帧
	await fs.rm(TMP, { recursive: true, force: true });
	const outDir = path.join(TMP, 'frames');
	await fs.mkdir(outDir, { recursive: true });
	const srcVideo = path.join(TMP, 'probe.mp4');
	const gen = await makeRunCommand(60_000)(
		buildCommand(bins.ffmpeg.command, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10', '-pix_fmt', 'yuv420p', srcVideo]),
		60_000,
	);
	check('fixture: 用内置 ffmpeg 生成 2 秒测试视频', gen.ok === true, gen.ok ? srcVideo : `${gen.exitCode} ${(gen.stderr ?? '').slice(-200)}`);

	const prepared = await prepareVideoAndFrames(
		{ ...baseCtx, runCommand: makeRunCommand(60_000) }, bins,
		{ source: srcVideo, frames: 4, startSec: 0, maxWidth: 320, outDir, keepVideo: true },
	);
	check('抽帧: prepareVideoAndFrames ok', prepared.ok === true, prepared.ok ? '' : prepared.message?.split('\n')[0]);
	if (prepared.ok) {
		check('抽帧: 产出 4 张 PNG', prepared.prepared.frames.length === 4, prepared.prepared.frames.map(f => path.basename(f)).join(' '));
		check('抽帧: 时长探测成功（ffprobe 真的跑起来了）', typeof prepared.prepared.videoDurationSec === 'number' && prepared.prepared.videoDurationSec > 0,
			`duration=${prepared.prepared.videoDurationSec}`);
		let bytes = 0;
		for (const f of prepared.prepared.frames) { bytes += (await fs.stat(f)).size; }
		check('抽帧: PNG 非空（不是 0 字节占位）', bytes > 1000, `${bytes} bytes`);
	}

	// ⑤ 本地 ASR（whisper.cpp，2026-09-25）：钉住**解析链与失败语义**。
	//    转写质量的 E2E 已由 fetch-whisper.mjs 的自检覆盖（SAPI 合成语音 → ffmpeg → whisper，
	//    输出须含 "hello"）—— 这里不重复（避免两份自检对同一件事各说各话）。
	const asr = await resolveAsrToolchain({ ...baseCtx, runCommand: makeRunCommand(30_000) });
	check('ASR: whisper-cli 解析到内置（不得落到裸命令名）', !!asr && asr.whisperCli.source !== 'path',
		asr ? describeResolvedBinary(asr.whisperCli) : '(undefined —— 先跑 node build/saros/fetch-whisper.mjs)');
	check('ASR: 模型解析到 build/saros/models', !!asr && /build[\\/]saros[\\/]models/.test(asr.modelPath), asr?.modelPath ?? '(无)');
	check('ASR: parseWhisperStdout 基本语义（时间轴 → [mm:ss]，裸文本判失败）',
		parseWhisperStdout('[00:01:02.000 --> 00:01:03.000]  你好') === '[01:02] 你好'
		&& parseWhisperStdout('裸文本') === undefined);
	// 无音轨视频（上面 fixture 是纯画面）⇒ ffmpeg 提音轨必失败 ⇒ 必须诚实返回 undefined，
	// 而不是把 whisper 的幻觉输出当口播（whisper 对静音/噪声会产生幻觉文本，这条语义要钉住）。
	const noAudio = await transcribeWithWhisper(
		{ ...baseCtx, runCommand: makeRunCommand(120_000) }, bins.ffmpeg.command, srcVideo, path.join(TMP, 'asr'),
	);
	check('ASR: 无音轨视频 ⇒ 诚实返回 undefined（退回仅帧，不伪造口播）', noAudio === undefined);
} catch (err) {
	check('脚本执行未抛异常', false, err instanceof Error ? err.message : String(err));
} finally {
	await fs.rm(TMP, { recursive: true, force: true }).catch(() => { });
	await fs.rm(BUNDLE, { force: true }).catch(() => { });
}

console.log(results.join('\n'));
console.log(`\n${failed === 0 ? '✓ 全部通过' : `✗ ${failed} 项失败`}（共 ${results.filter(r => /^\s+[✔✖]/.test(r)).length} 项断言）`);
process.exit(failed === 0 ? 0 : 1);
