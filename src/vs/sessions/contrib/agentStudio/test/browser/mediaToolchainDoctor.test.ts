/*---------------------------------------------------------------------------------------------
 *  媒体工具链：探活缓存接线 + 自检报告 单元测试 —— 2026-09-24
 *
 *  两件事必须一起钉住：
 *   ① **缓存真的生效**（否则等于没做：每次工具调用仍旧 spawn 156MB 的 ffmpeg）；
 *   ② **自检真的能绕开缓存**（否则用户刚装完二进制，自检还告诉他"未找到"—— 比没有自检更糟）。
 *
 *  另外覆盖报告文案的关键分支：全就绪 / 缺失（必须给可执行的修复路径）/ 无命令通道
 *  （不得误报成"未安装"，那是两种不同故障）。
 *
 *  运行（仓库根目录）：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/mediaToolchainDoctor.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import { URI } from '../../../../../base/common/uri.js';
import {
	probeMediaBinary, resolveToolchain, type IMediaProbeContext,
} from '../../browser/providers/tool/videoMediaPipeline.js';
import {
	collectMediaToolchainStatus, formatMediaToolchainReport, summarizeMediaToolchain, firstLineOf,
} from '../../browser/providers/tool/mediaToolchainDoctor.js';
import { clearProbeCache, PROBE_CACHE_TTL_MS } from '../../browser/providers/tool/mediaToolchainProbeCache.js';

const RESOURCES = 'C:\\app\\resources';
const BIN = `${RESOURCES}\\saros\\bin`;

/** 只实现 stat 的最小文件系统（内置候选存在性判定）。 */
function makeFs(present: readonly string[]): { stat(uri: URI): Promise<{ isDirectory: boolean }> } {
	return {
		async stat(uri: URI) {
			if (!present.some(p => p.toLowerCase() === uri.fsPath.toLowerCase())) { throw new Error('ENOENT'); }
			return { isDirectory: false };
		},
	};
}

interface ICall { cmd: string }

interface IRunnerOptions {
	/** 命令中包含该子串时返回失败（模拟"未安装"）。 */
	missing?: readonly string[];
	/** 返回 undefined（模拟非桌面版：没有命令通道）。 */
	noChannel?: boolean;
	/** 各二进制的版本输出（按子串匹配，缺省给通用值）。 */
	versions?: Readonly<Record<string, string>>;
}

function makeCtx(opts: {
	present?: readonly string[];
	runner?: IRunnerOptions;
}) {
	const calls: ICall[] = [];
	const runnerOpts = opts.runner ?? {};
	const runCommand = async (cmd: string) => {
		calls.push({ cmd });
		if (runnerOpts.noChannel) { return undefined; }
		const missing = runnerOpts.missing ?? [];
		if (missing.some(m => cmd.includes(m))) {
			return { ok: false, stdout: '', stderr: 'command not found', exitCode: 127 };
		}
		const key = Object.keys(runnerOpts.versions ?? {}).find(k => cmd.includes(k)) ?? '';
		const stdout = (runnerOpts.versions ?? {})[key] ?? 'ffmpeg version TEST-1.2.3\nextra line\n';
		return { ok: true, stdout, stderr: '', exitCode: 0 };
	};
	const ctx: IMediaProbeContext = {
		fileService: makeFs(opts.present ?? [`${BIN}\\ffmpeg.exe`, `${BIN}\\ffprobe.exe`, `${BIN}\\yt-dlp.exe`]) as never,
		logService: { info() { }, warn() { }, error() { }, debug() { }, trace() { } } as never,
		runCommand,
		// 固定运行时：无 resourcesPath 之外的干扰、空 env（不受开发机 FFMPEG_PATH 影响）
		mediaBinaryRuntime: { resourcesPath: RESOURCES, env: {}, platform: 'win32' },
		appRoot: undefined,
	};
	return { ctx, calls };
}

suite('媒体工具链 · 探活缓存接线', () => {

	setup(() => clearProbeCache());

	test('★★ 同一二进制连续探测只用一次 spawn（这正是缓存的全部意义）', async () => {
		const { ctx, calls } = makeCtx({});
		const bins = await resolveToolchain(ctx);
		const first = await probeMediaBinary(ctx, bins.ffmpeg, '-version', { now: () => 0 });
		const second = await probeMediaBinary(ctx, bins.ffmpeg, '-version', { now: () => 1_000 });
		assert.strictEqual(first, 'ok');
		assert.strictEqual(second, 'ok');
		assert.strictEqual(calls.length, 1, `应命中缓存只探测一次，实际 ${calls.length} 次`);
	});

	test('★ TTL 到期后重新探测（用户装完 ffmpeg 不必重启应用）', async () => {
		const { ctx, calls } = makeCtx({});
		const bins = await resolveToolchain(ctx);
		await probeMediaBinary(ctx, bins.ffmpeg, '-version', { now: () => 0 });
		await probeMediaBinary(ctx, bins.ffmpeg, '-version', { now: () => PROBE_CACHE_TTL_MS });
		assert.strictEqual(calls.length, 2, '到期必须重探');
	});

	test('★ force=true 绕开缓存（自检入口依赖它）', async () => {
		const { ctx, calls } = makeCtx({});
		const bins = await resolveToolchain(ctx);
		await probeMediaBinary(ctx, bins.ffmpeg, '-version', { now: () => 0 });
		await probeMediaBinary(ctx, bins.ffmpeg, '-version', { now: () => 0, force: true });
		assert.strictEqual(calls.length, 2, 'force 必须重新 spawn');
	});

	test('★★ no-channel（没有命令通道）不写缓存 —— 它是"环境不可执行"，不是"未安装"', async () => {
		const { ctx, calls } = makeCtx({ runner: { noChannel: true } });
		const bins = await resolveToolchain(ctx);
		const a = await probeMediaBinary(ctx, bins.ffmpeg, '-version', { now: () => 0 });
		const b = await probeMediaBinary(ctx, bins.ffmpeg, '-version', { now: () => 0 });
		assert.strictEqual(a, 'no-channel');
		assert.strictEqual(b, 'no-channel');
		assert.strictEqual(calls.length, 2, 'no-channel 结论不得被缓存（通道可能恢复）');
	});

	test('缺失败结论也会缓存：未安装时不会反复 spawn（每次都是 exit 127）', async () => {
		const { ctx, calls } = makeCtx({ runner: { missing: ['ffmpeg.exe'] } });
		const bins = await resolveToolchain(ctx);
		await probeMediaBinary(ctx, bins.ffmpeg, '-version', { now: () => 0 });
		await probeMediaBinary(ctx, bins.ffmpeg, '-version', { now: () => 0 });
		assert.strictEqual(calls.length, 1, 'missing 也该命中缓存');
	});
});

suite('媒体工具链 · 自检（collect + format）', () => {

	setup(() => clearProbeCache());

	test('★★ collect：三项齐全 + 真实执行 + 回显版本首行', async () => {
		const { ctx } = makeCtx({
			runner: {
				versions: {
					'ffmpeg.exe': 'ffmpeg version N-1 Copyright\nbanner…\n',
					'ffprobe.exe': 'ffprobe version N-1 Copyright\n',
					'yt-dlp.exe': '2026.08.19\n',
				},
			},
		});
		const statuses = await collectMediaToolchainStatus(ctx);
		assert.strictEqual(statuses.length, 3);
		assert.deepStrictEqual(statuses.map(s => s.name), ['ffmpeg', 'ffprobe', 'yt-dlp']);
		assert.ok(statuses.every(s => s.verdict === 'ok'), '三者都该是 ok');
		assert.ok(statuses.every(s => s.source === 'bundled'), '都应解析到内置目录');
		assert.strictEqual(statuses[0].version, 'ffmpeg version N-1 Copyright', '版本取首行');
		assert.strictEqual(statuses[2].version, '2026.08.19');
	});

	test('★★ collect 默认绕开缓存：预热过缓存也要重新执行（否则用户刚装完仍看到旧结论）', async () => {
		const { ctx, calls } = makeCtx({});
		const bins = await resolveToolchain(ctx);
		await probeMediaBinary(ctx, bins.ffmpeg, '-version', { now: () => 0 });   // 预热缓存
		const before = calls.length;
		await collectMediaToolchainStatus(ctx);
		assert.ok(calls.length > before, '自检必须重新 spawn（force 默认 true）');
	});

	test('★ collect：缺 ffmpeg 时结论是 missing（而不是 no-channel）', async () => {
		// 没有内置候选 ⇒ 命令回退为裸名 `"ffmpeg"`（不带 .exe），故按引号形式匹配
		const { ctx } = makeCtx({ present: [], runner: { missing: ['"ffmpeg"'] } });
		const statuses = await collectMediaToolchainStatus(ctx);
		const ff = statuses.find(s => s.name === 'ffmpeg')!;
		assert.strictEqual(ff.verdict, 'missing');
		assert.strictEqual(ff.source, 'path', '没有内置候选 ⇒ 回退 PATH 裸名');
	});

	test('★★ 报告：全部就绪 ⇒ 明确说就绪，且**不给**修复建议（避免噪音）', () => {
		const text = formatMediaToolchainReport([
			{ name: 'ffmpeg', command: `${BIN}\\ffmpeg.exe`, source: 'bundled', path: `${BIN}\\ffmpeg.exe`, verdict: 'ok', version: 'ffmpeg version N-1' },
			{ name: 'ffprobe', command: `${BIN}\\ffprobe.exe`, source: 'bundled', path: `${BIN}\\ffprobe.exe`, verdict: 'ok' },
			{ name: 'yt-dlp', command: `${BIN}\\yt-dlp.exe`, source: 'bundled', path: `${BIN}\\yt-dlp.exe`, verdict: 'ok', version: '2026.08.19' },
		]);
		assert.match(text, /全部就绪/);
		assert.match(text, /内置/);
		assert.match(text, /ffmpeg version N-1/);
		assert.ok(!/winget|fetch-ffmpeg/.test(text), '全就绪时不该出现修复建议');
	});

	test('★★ 报告：缺失 ⇒ 必须给「源码 fetch / 自装命令 / 设 *_PATH」三条可执行路径', () => {
		const text = formatMediaToolchainReport([
			{ name: 'ffmpeg', command: `${BIN}\\ffmpeg.exe`, source: 'bundled', path: `${BIN}\\ffmpeg.exe`, verdict: 'ok' },
			{ name: 'ffprobe', command: 'ffprobe', source: 'path', verdict: 'missing' },
			{ name: 'yt-dlp', command: 'yt-dlp', source: 'path', verdict: 'missing' },
		], { platform: 'win32' });
		assert.match(text, /2 项缺失/);
		assert.match(text, /node build\/saros\/fetch-ffmpeg\.mjs/, '必须给出源码一键获取');
		assert.match(text, /winget install yt-dlp\.yt-dlp/, 'yt-dlp 的自装命令');
		assert.match(text, /YTDLP_PATH/, '已装但找不到 ⇒ 环境变量覆盖');
		assert.match(text, /FFPROBE_PATH/, 'ffprobe 同理');
		assert.match(text, /❌ ffprobe/, '缺失项要有明确标记');
	});

	test('★ 报告：macOS 平台给 brew（而不是把 winget 抄过去）', () => {
		const text = formatMediaToolchainReport([
			{ name: 'yt-dlp', command: 'yt-dlp', source: 'path', verdict: 'missing' },
		], { platform: 'darwin' });
		assert.match(text, /brew install yt-dlp/);
		assert.ok(!/winget/.test(text), 'macOS 不该出现 winget');
	});

	test('★★ 报告：no-channel 不得被说成"未安装"（两种不同故障）', () => {
		const text = formatMediaToolchainReport([
			{ name: 'ffmpeg', command: 'ffmpeg', source: 'path', verdict: 'no-channel' },
		]);
		assert.match(text, /没有命令执行通道/);
		assert.ok(!/winget|fetch-ffmpeg/.test(text), '通道缺失时给安装建议是误导');
	});

	test('firstLineOf：取首个非空行并截断；空输出 ⇒ undefined', () => {
		assert.strictEqual(firstLineOf('\n\n  abc  \nrest'), 'abc');
		assert.strictEqual(firstLineOf(undefined), undefined);
		assert.strictEqual(firstLineOf('   '), undefined);
		assert.strictEqual(firstLineOf('x'.repeat(200))!.length, 120);
	});

	test('summarizeMediaToolchain：单行（日志友好，不含换行）', () => {
		const s = summarizeMediaToolchain([
			{ name: 'ffmpeg', command: 'C:\\b\\ffmpeg.exe', source: 'bundled', path: 'C:\\b\\ffmpeg.exe', verdict: 'ok' },
			{ name: 'yt-dlp', command: 'yt-dlp', source: 'path', verdict: 'missing' },
		]);
		assert.ok(!s.includes('\n'));
		assert.match(s, /ffmpeg=bundled\(C:\\b\\ffmpeg\.exe\):ok/);
		assert.match(s, /yt-dlp=path:missing/);
	});
});
