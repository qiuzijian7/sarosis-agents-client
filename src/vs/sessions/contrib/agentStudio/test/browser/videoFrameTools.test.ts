/*---------------------------------------------------------------------------------------------
 *  `extract_video_frames` 单元测试 —— 2026-09-24
 *
 *  这是「视频画面」能力的唯一入口（此前只有封面一张静止图 ⇒ 依赖画面的任务只能靠模型编造）。
 *  抽帧是**参数错一个就静默抽不出帧**的活，因此：
 *
 *   ① 命令拼装全部按**纯函数**逐个断言（yt-dlp 下载/取时长、ffprobe 探时长、ffmpeg 抽帧、
 *      shell 净化、帧时间戳换算）—— 这是最容易错、也最容易被"看起来跑通了"掩盖的地方；
 *   ② handler 用**注入的命令执行器 + 内存文件系统**跑通完整链路（不真跑 ffmpeg），
 *      钉住三件事：缺依赖时给**可执行的安装指引**、yt-dlp 非 0 退出但**产物存在**仍算成功
 *      （真实踩点：无字幕/无某流也会非 0）、抽完**默认删除下载的视频**；
 *   ③ 真实二进制是否在场由运行环境决定 ⇒ 本测试不依赖 ffmpeg/yt-dlp，CI 与开发机行为一致。
 *
 *  运行（仓库根目录）：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/videoFrameTools.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import {
	registerVideoFrameTools,
	sanitizeForShell, clampInt, slugifySource, isRemoteSource, parseDurationPrint,
	computeSpanSec, buildYtDlpDownloadArgs, buildYtDlpDurationArgs, buildFfprobeDurationArgs,
	buildFfmpegArgs, frameTimestampSec, formatMMSS, buildCommand,
	type IVideoFrameToolContext,
} from '../../browser/providers/tool/videoFrameTools.js';
import type { IBuiltinToolRegistration } from '../../browser/providers/tool/toolRegistry.js';
// ★ 2026-09-24：探活结果现在按进程缓存（避免每次调用都 spawn 156MB ffmpeg）⇒
//   每个用例前必须清空，否则「本用例期望 missing」会读到上一个用例缓存的 ok。
import { clearProbeCache } from '../../browser/providers/tool/mediaToolchainProbeCache.js';
// ★ 2026-09-25：下载失败备忘同为进程级共享（TTL 10min）——「下载失败」用例会毒化
//   后面复用同一 URL 的用例（实测：抽帧无产物 / keepVideo 两个用例被毒化）。
import { clearVideoDownloadFailure } from '../../browser/providers/tool/videoMediaPipeline.js';

const quietLog = { info() { }, warn() { }, error() { }, debug() { }, trace() { } };

suite('视频抽帧 · 纯函数（命令拼装 / 净化 / 时间换算）', () => {

	test('sanitizeForShell：去掉会逃出引号的双引号与换行（shell:true 通道的硬要求）', () => {
		assert.strictEqual(sanitizeForShell('a"b'), 'ab');
		assert.strictEqual(sanitizeForShell('a\r\nb'), 'ab');
		assert.strictEqual(sanitizeForShell('  x  '), 'x');
		// ⚠ 注入尝试：双引号被剥掉 ⇒ 无法闭合我们自己加的那层引号
		assert.strictEqual(sanitizeForShell('x" && rm -rf /'), 'x && rm -rf /');
	});

	test('clampInt：非法/缺失走默认值，越界被夹紧', () => {
		assert.strictEqual(clampInt(undefined, 1, 24, 6), 6);
		assert.strictEqual(clampInt('abc', 1, 24, 6), 6);
		assert.strictEqual(clampInt(100, 1, 24, 6), 24);
		assert.strictEqual(clampInt(0, 1, 24, 6), 1);
		assert.strictEqual(clampInt(7.9, 1, 24, 6), 7);
	});

	test('slugifySource：URL 取末段、本地取文件名、非法字符折叠、超长截断', () => {
		assert.strictEqual(slugifySource('https://www.douyin.com/video/7301234567890'), '7301234567890');
		assert.strictEqual(slugifySource('https://youtu.be/dQw4w9WgXcQ?t=30'), 'dQw4w9WgXcQ');
		assert.strictEqual(slugifySource('D:\\videos\\黑神话 悟空 实机.mp4'), '黑神话-悟空-实机');
		assert.strictEqual(slugifySource('https://x.com/a/' + 'b'.repeat(80)), 'b'.repeat(40));
		assert.strictEqual(slugifySource('!!!'), 'video', '全是非法字符 ⇒ 兜底名');
	});

	test('isRemoteSource：http(s) 才算远端（本地路径不触发 yt-dlp）', () => {
		assert.strictEqual(isRemoteSource('https://a/b'), true);
		assert.strictEqual(isRemoteSource('HTTP://a/b'), true);
		assert.strictEqual(isRemoteSource('D:\\a\\b.mp4'), false);
		assert.strictEqual(isRemoteSource('/tmp/a.mp4'), false);
	});

	test('parseDurationPrint：NA/空/非法 ⇒ undefined；多行取最后一行', () => {
		assert.strictEqual(parseDurationPrint('123.4'), 123.4);
		assert.strictEqual(parseDurationPrint('NA'), undefined);
		assert.strictEqual(parseDurationPrint('None'), undefined);
		assert.strictEqual(parseDurationPrint(''), undefined);
		assert.strictEqual(parseDurationPrint('warn\n88'), 88);
		assert.strictEqual(parseDurationPrint('0'), undefined, '0 秒视为拿不到（避免 fps 除零）');
	});

	test('computeSpanSec：请求值不会超过剩余时长；无时长时退化；下限 1 秒', () => {
		assert.strictEqual(computeSpanSec({ requestedSec: 30, videoDurationSec: 100, startSec: 0 }), 30);
		assert.strictEqual(computeSpanSec({ requestedSec: 500, videoDurationSec: 100, startSec: 95 }), 5, '夹到剩余 5 秒');
		assert.strictEqual(computeSpanSec({ videoDurationSec: 240, startSec: 0 }), 240, '未指定 ⇒ 整段');
		assert.strictEqual(computeSpanSec({ startSec: 0 }), 60, '时长未知 ⇒ 退化 60 秒');
		assert.strictEqual(computeSpanSec({ requestedSec: 0.2, startSec: 0 }), 1, '下限 1 秒');
	});

	test('buildYtDlpDownloadArgs：整段下载带体积上限；指定片段时用 --download-sections', () => {
		const full = buildYtDlpDownloadArgs({ url: 'https://a/b', outTemplate: 'D:/out/video.%(ext)s' });
		assert.ok(full.includes('--no-playlist'));
		// 2026-09-25：选择器改为「分离流合并优先」（B站/YouTube 只给 DASH 分离流，combined 会无格式可用）
		assert.deepStrictEqual(full.slice(full.indexOf('-f'), full.indexOf('-f') + 2), ['-f', 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b']);
		assert.ok(full.includes('--max-filesize') && full.includes('500M'), '整段下载必须有体积兜底');
		assert.ok(!full.includes('--download-sections'));
		assert.deepStrictEqual(full.slice(-2), ['--', 'https://a/b'], 'URL 前要有 -- 终止选项解析');

		const part = buildYtDlpDownloadArgs({
			url: 'https://a/b', outTemplate: 'D:/out/video.%(ext)s', sectionStartSec: 30, sectionSec: 20,
		});
		assert.deepStrictEqual(part.slice(part.indexOf('--download-sections'), part.indexOf('--download-sections') + 2),
			['--download-sections', '*30-+20'], '只下需要的片段（省流量/省时间）');
	});

	test('buildFfmpegArgs：fps = 帧数/跨度，等间隔抽；限宽且高度取偶数', () => {
		const args = buildFfmpegArgs({
			videoPath: 'D:/in.mp4', outPattern: 'D:/out/frame-%02d.png', frames: 6, startSec: 10, spanSec: 60, maxWidth: 1280,
		});
		assert.deepStrictEqual(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2), ['-ss', '10']);
		assert.deepStrictEqual(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2), ['-t', '60']);
		assert.ok(args.includes('fps=0.1000,scale=1280:-2'), '6 帧 / 60 秒 = 0.1 fps：' + args.join(' '));
		assert.deepStrictEqual(args.slice(args.indexOf('-frames:v'), args.indexOf('-frames:v') + 2), ['-frames:v', '6']);
		assert.strictEqual(args[args.length - 1], 'D:/out/frame-%02d.png');
		// 跨度 < 帧数 ⇒ fps > 1（仍按 -frames:v 截断）
		const dense = buildFfmpegArgs({ videoPath: 'v', outPattern: 'p', frames: 5, startSec: 0, spanSec: 2 });
		assert.ok(dense.includes('fps=2.5000,scale=1280:-2'));
	});

	test('buildCommand：每项加引号（含可执行文件），空值/引号被净化', () => {
		assert.strictEqual(buildCommand('ffmpeg', ['-i', 'D:/a b.mp4']), '"ffmpeg" "-i" "D:/a b.mp4"');
		assert.strictEqual(buildCommand('yt-dlp', ['https://a/b"c']), '"yt-dlp" "https://a/bc"');
	});

	test('帧时间戳换算：第 N 帧落在 start + (N-1)*step', () => {
		// 6 帧 / 60 秒，从 0 开始 ⇒ 0, 10, 20, 30, 40, 50
		assert.deepStrictEqual([1, 2, 3, 6].map(i => frameTimestampSec(i, 0, 60, 6)), [0, 10, 20, 50]);
		assert.strictEqual(frameTimestampSec(1, 30, 30, 3), 30, '起点 30 秒 ⇒ 首帧 30 秒');
		assert.strictEqual(formatMMSS(0), '00:00');
		assert.strictEqual(formatMMSS(75.4), '01:15');
	});
});

// ─── handler（注入命令执行器 + 内存文件系统）────────────────────────────────

/** 内存文件系统：只实现抽帧工具用到的面，键按 fsPath 小写归一（VS Code 的 URI.file 会小写盘符）。 */
class MemFs {
	readonly files = new Map<string, VSBuffer>();
	readonly dirs = new Set<string>();
	private key(uri: URI): string { return uri.fsPath.toLowerCase(); }
	async exists(uri: URI): Promise<boolean> { return this.files.has(this.key(uri)) || this.dirs.has(this.key(uri)); }
	async createFolder(uri: URI): Promise<void> { this.dirs.add(this.key(uri)); }
	async writeFile(uri: URI, buf: VSBuffer): Promise<void> { this.files.set(this.key(uri), buf); }
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	async resolve(uri: URI): Promise<any> {
		const dir = this.key(uri) + path.sep;
		const children: Array<{ name: string; isDirectory: boolean; resource: URI }> = [];
		const seen = new Set<string>();
		for (const f of this.files.keys()) {
			if (!f.startsWith(dir)) { continue; }
			const rest = f.slice(dir.length);
			const seg = rest.split(path.sep)[0];
			const isDir = rest.includes(path.sep);
			if (seen.has(seg)) { continue; }
			seen.add(seg);
			children.push({ name: seg, isDirectory: isDir, resource: URI.file(path.join(uri.fsPath, seg)) });
		}
		return { children };
	}
	async del(uri: URI): Promise<void> {
		const k = this.key(uri);
		this.dirs.delete(k);
		for (const f of [...this.files.keys()]) { if (f === k || f.startsWith(k + path.sep)) { this.files.delete(f); } }
	}
	names(dir: string): string[] {
		const d = dir.toLowerCase() + path.sep;
		return [...this.files.keys()].filter(f => f.startsWith(d)).map(f => f.slice(d.length)).sort();
	}
}

type Behavior = { match: RegExp; run: (cmd: string, fs: MemFs, i: number) => { stdout?: string; stderr?: string; exitCode?: number } };

/**
 * 记录每次命令；行为按**传入顺序**匹配（测试自定义的行为排在默认行为之前 ⇒ 可以覆盖默认）。
 */
function makeRunner(custom: Behavior[]) {
	const calls: string[] = [];
	let currentFs: MemFs | undefined;
	const runner = async (cmd: string) => {
		const i = calls.length;
		calls.push(cmd);
		for (const b of [...custom, ...defaultBehaviors()]) {
			if (!b.match.test(cmd)) { continue; }
			const r = b.run(cmd, currentFs!, i);
			return { ok: (r.exitCode ?? 0) === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
		}
		return { ok: true, stdout: '', stderr: '', exitCode: 0 };
	};
	return { runner, calls, bind: (fs: MemFs) => { currentFs = fs; } };
}

/** 从命令串解出引号包裹的参数（与 `buildCommand` 的拼装方式对称）。 */
function argsOf(cmd: string): string[] {
	return [...cmd.matchAll(/"([^"]*)"/g)].map(x => x[1]);
}

/** 取 `-o <template>` 的值（yt-dlp 下载落盘模板）。 */
function outTemplateOf(cmd: string): string | undefined {
	const args = argsOf(cmd);
	const i = args.indexOf('-o');
	return i >= 0 ? args[i + 1] : undefined;
}

/** 默认行为：二进制都在且工作正常（抽帧/探时长/下载都产出真实文件）。 */
function defaultBehaviors(): Behavior[] {
	return [
		// ffmpeg 抽帧 ⇒ 按命令里的输出模板生成 N 个文件
		{ match: CMD.ffmpegExtract, run: (cmd, m) => { writeFrames(cmd, m); return {}; } },
		{ match: /^"ffprobe"/, run: () => ({ stdout: '120\n' }) },
		{
			match: /^"yt-dlp"/, run: (cmd, m) => {
				if (cmd.includes('--print')) { return { stdout: '120\n' }; }
				if (cmd.includes('--version')) { return { stdout: '2026.09.01\n' }; }
				const tpl = outTemplateOf(cmd);
				if (tpl) {
					const file = tpl.replace(/\.%\(ext\)s$/, '.mp4');
					m.writeFile(URI.file(file), VSBuffer.fromString('video'));
				}
				return {};
			},
		},
	];
}

/**
 * 建一个可用的 ctx（默认所有二进制都在、行为正常；`custom` 里的行为优先匹配）。
 *
 * ⚠ 命名为 `makeTool` 而**不是** `setup`：`setup` 是 mocha(tdd) 的 `beforeEach` 全局，
 *   同名的局部函数会把它遮蔽掉 —— 于是 `setup(() => clearProbeCache())` 这种"注册钩子"
 *   的写法会静默变成"建一个 ctx"，钩子根本没生效（2026-09-24 实际踩过）。
 */
function makeTool(custom: Behavior[] = []) {
	const registered: IBuiltinToolRegistration[] = [];
	const fsImpl = new MemFs();
	const root = path.join(os.tmpdir(), 'vf-test');
	const r = makeRunner(custom);
	r.bind(fsImpl);
	const ctx: IVideoFrameToolContext = {
		register: d => { registered.push(d); },
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		fileService: fsImpl as any,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		logService: quietLog as any,
		// 沙箱校验在单测里退化为「原样返回」（真实边界由 workspaceSecurity 自己测）
		resolveAndCheckWorkspacePath: async (_agentId, requestedPath) => requestedPath,
		defaultOutRoot: root,
		runCommand: r.runner,
	};
	registerVideoFrameTools(ctx);
	const tool = registered.find(t => t.definition.name === 'extract_video_frames');
	assert.ok(tool, '未注册 extract_video_frames');
	return { tool: tool!, fs: fsImpl, calls: r.calls, root };
}

/**
 * 命令分类判据（探针 / 下载 / 取时长 / 抽帧）—— 断言用，避免把「探针」误当成「干活」。
 * ⚠ `buildCommand` 给**每个**参数都加了引号 ⇒ 模式里必须是 `"exe" "arg"` 而不是 `exe arg`。
 */
const CMD = {
	ffmpegProbe: /^"ffmpeg" "-version"/,
	ffmpegExtract: /^"ffmpeg" "-hide_banner"/,
	ffprobe: /^"ffprobe"/,
	ytdlpProbe: /^"yt-dlp" "--version"/,
	ytdlpDownload: /^"yt-dlp".*"-o" /,
	ytdlpDuration: /^"yt-dlp".*"--print"/,
};

/** 从命令串里解出输出模板并写文件（模拟 ffmpeg 的产出）。 */
function writeFrames(cmd: string, m: MemFs): void {
	const args = [...cmd.matchAll(/"([^"]*)"/g)].map(x => x[1]);
	const pattern = args[args.length - 1];
	const countArg = args[args.indexOf('-frames:v') + 1];
	const n = Number(countArg) || 0;
	for (let i = 1; i <= n; i++) {
		const file = pattern.replace(/%0?2d/, String(i).padStart(2, '0'));
		m.writeFile(URI.file(file), VSBuffer.fromString('png'));
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (tool: IBuiltinToolRegistration, args: Record<string, unknown>): Promise<any> =>
	tool.handler(args, undefined, 'agent-1');

/** handler 两种返回形态：错误路径是 `IToolResultContent[]`，成功路径是 `{ content, details }` —— 统一取文本。 */
function textOf(r: unknown): string {
	const arr = Array.isArray(r)
		? r as Array<{ text?: string }>
		: (r as { content?: Array<{ text?: string }> })?.content ?? [];
	return String(arr[0]?.text ?? '');
}

suite('视频抽帧 · handler（注入式端到端）', () => {

	setup(() => { clearProbeCache(); clearVideoDownloadFailure(); });   // 两个进程级缓存都要隔离（见文件头注释）

	test('★ 缺 ffmpeg ⇒ 给可执行的安装指引（而不是晦涩报错）', async () => {
		const { tool } = makeTool([{ match: CMD.ffmpegProbe, run: () => ({ exitCode: 127, stderr: 'command not found' }) }]);
		const r = await call(tool, { source: 'https://a/b' });
		const out = textOf(r);
		assert.match(out, /未检测到 ffmpeg/);
		assert.match(out, /winget|brew|apt/, '必须给具体安装命令');
	});

	test('★ 没有命令通道（非桌面版）⇒ 不能说「请安装 ffmpeg」（两者是不同故障）', async () => {
		// `runCommand` 返回 undefined = 通道缺失（与「命令不存在」是两种不同的故障）
		const regs: IBuiltinToolRegistration[] = [];
		registerVideoFrameTools({
			register: d => { regs.push(d); },
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			fileService: new MemFs() as any,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			logService: quietLog as any,
			resolveAndCheckWorkspacePath: async (_a, p) => p,
			defaultOutRoot: path.join(os.tmpdir(), 'vf-test'),
			runCommand: async () => undefined,
		});
		const r = await regs[0].handler({ source: 'https://a/b' }, undefined, 'agent-1');
		const out = (r as Array<{ text: string }>)[0].text;
		assert.match(out, /没有命令执行通道|非桌面版/);
		assert.ok(!/winget|brew|apt/.test(out), '不能把「通道缺失」误报成「未安装 ffmpeg」');
	});

	test('★ 远端链接但缺 yt-dlp ⇒ 给安装指引，并提示可改用本地文件', async () => {
		const { tool } = makeTool([{ match: CMD.ytdlpProbe, run: () => ({ exitCode: 127, stderr: 'not found' }) }]);
		const r = await call(tool, { source: 'https://a/b' });
		const out = textOf(r);
		assert.match(out, /未检测到 yt-dlp/);
		assert.match(out, /本地文件路径|本地/, '应指出本地文件不需要 yt-dlp');
	});

	test('本地文件不存在 ⇒ 明确报错，不白跑抽帧', async () => {
		const { tool, calls } = makeTool();
		const r = await call(tool, { source: path.join(os.tmpdir(), 'vf-test', 'nope.mp4') });
		assert.match(textOf(r), /本地视频不存在/);
		assert.ok(!calls.some(c => CMD.ffmpegExtract.test(c)), '不该白跑 ffmpeg 抽帧');
	});

	test('★ 远端链路：下载 → 取时长 → 抽帧 → 回显路径与时间点 → 删除下载的视频', async () => {
		const { tool, fs: m, calls } = makeTool();
		const r = await call(tool, { source: 'https://www.douyin.com/video/7301234567890', frames: 3, durationSec: 30 });

		const out = textOf(r);
		assert.match(out, /已从视频抽取 3 帧/,
			`调用命令：\n${calls.join('\n')}\n内存文件系统全部键：\n${[...m.files.keys()].join('\n')}`);
		assert.match(out, /视频时长 02:00/, '时长来自 yt-dlp --print（120.5 秒）');
		assert.strictEqual(r.details.frames.length, 3);
		assert.deepStrictEqual(r.details.frames.map((p: string) => path.basename(path.normalize(p))),
			['frame-01.png', 'frame-02.png', 'frame-03.png']);
		// 时间点回显（30 秒跨度 / 3 帧 ⇒ 0s、10s、20s；显示为 00:00 / 00:10 / 00:20）
		assert.match(out, /@ 00:00/);
		assert.match(out, /@ 00:20/);
		// 帧图仍在，下载的视频已清理（默认不囤视频）
		assert.ok(m.names(r.details.outDir).some(n => n.startsWith('frame-')), '帧图应保留');
		assert.strictEqual(m.names(path.join(r.details.outDir, '_src')).length, 0, '下载的视频目录应被删除');
		// 命令顺序：下载 → 取时长 → 抽帧（时长要在抽帧前拿到，才能算等间隔）
		const idx = (re: RegExp) => calls.findIndex(c => re.test(c));
		assert.ok(idx(CMD.ytdlpDownload) < idx(CMD.ytdlpDuration), '先下载再取时长');
		assert.ok(idx(CMD.ytdlpDuration) < idx(CMD.ffmpegExtract), '取时长必须在抽帧之前');
	});

	test('★ yt-dlp 非 0 退出但产物存在 ⇒ 仍算成功（真实踩点：无字幕/无某流也会非 0）', async () => {
		const { tool } = makeTool([{
			match: CMD.ytdlpDownload,
			run: (cmd, m) => {
				const tpl = outTemplateOf(cmd) ?? '';
				m.writeFile(URI.file(tpl.replace(/\.%\(ext\)s$/, '.webm')), VSBuffer.fromString('v'));
				return { exitCode: 1, stderr: 'WARNING: no subtitles' };
			},
		}]);
		const r = await call(tool, { source: 'https://a/b', frames: 2 });
		assert.match(textOf(r), /已从视频抽取 2 帧/, '应以下载产物为准，而不是退出码');
	});

	test('下载失败（无任何产物）⇒ 报错并回显 yt-dlp 尾部输出', async () => {
		const { tool } = makeTool([{ match: CMD.ytdlpDownload, run: () => ({ exitCode: 1, stderr: 'ERROR: Unsupported URL' }) }]);
		const r = await call(tool, { source: 'https://a/b' });
		const out = textOf(r);
		assert.match(out, /下载视频失败/);
		assert.match(out, /Unsupported URL/, '要回显原因，便于用户判断');
	});

	test('抽帧无产物 ⇒ 报错并建议调小 startSec/durationSec', async () => {
		const { tool } = makeTool([{ match: CMD.ffmpegExtract, run: () => ({ exitCode: 1, stderr: 'Invalid data' }) }]);
		const r = await call(tool, { source: 'https://a/b' });
		const out = textOf(r);
		assert.match(out, /抽帧失败/);
		assert.match(out, /startSec|durationSec/, '要给可操作的下一步');
	});

	test('keepVideo=true ⇒ 保留下载的视频（供反复抽帧）', async () => {
		const { tool, fs: m } = makeTool();
		const r = await call(tool, { source: 'https://a/b', frames: 1, keepVideo: true });
		assert.ok(m.names(path.join(r.details.outDir, '_src')).length > 0, 'keepVideo 生效');
	});

	test('★ 产物目录走沙箱校验：越界 ⇒ 返回可读的拒绝原因（不硬跑命令）', async () => {
		const calls: string[] = [];
		const regs: IBuiltinToolRegistration[] = [];
		const ctx: IVideoFrameToolContext = {
			register: d => { regs.push(d); },
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			fileService: new MemFs() as any,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			logService: quietLog as any,
			resolveAndCheckWorkspacePath: async () => { throw new Error('路径越界（沙箱拒绝）'); },
			defaultOutRoot: path.join(os.tmpdir(), 'vf-test'),
			runCommand: async (cmd) => { calls.push(cmd); return { ok: true, stdout: '', stderr: '', exitCode: 0 }; },
		};
		registerVideoFrameTools(ctx);
		const r = await regs[0].handler({ source: 'https://a/b' }, undefined, 'agent-1');
		const out = (r as Array<{ text: string }>)[0].text;
		assert.match(out, /不可写/);
		assert.match(out, /越界/, '要把真实原因带给用户');
		assert.deepStrictEqual(calls.filter(c => CMD.ffmpegExtract.test(c) || CMD.ytdlpDownload.test(c)), [],
			'越界时不该已经下载/抽帧（依赖探测无副作用，允许）');
	});

	test('缺少 source ⇒ 提示用法', async () => {
		const { tool } = makeTool();
		const r = await call(tool, {});
		assert.match(r[0].text as string, /缺少 source|source/);
	});
});
