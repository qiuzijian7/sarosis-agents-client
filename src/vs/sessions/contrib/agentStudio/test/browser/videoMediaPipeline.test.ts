/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 视频媒体管线（videoMediaPipeline.ts）的 yt-dlp **命令拼装**单测 —— 2026-09-25。
 *
 * 为什么必须单测它：它是**纯函数**，而"参数错一个就静默抽不出帧"（本模块头注释）。
 * 这里重点钉住「用浏览器 cookie」这个新参数的两条纪律 —— 这个值**进命令行**，是边界：
 *   ① 关（缺省/空串/非法值）⇒ **一个参数都不加**（与旧行为逐字一致）；
 *   ② 开 ⇒ 恰好加在 `--no-warnings` 之后，值经规范化（trim + 小写），且**白名单**兜底
 *      （防止把任意字符串交给 shell / yt-dlp）。
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import {
	COOKIES_FROM_BROWSER_VALUES,
	buildFfmpegAudioArgs,
	buildWhisperArgs,
	buildYtDlpDownloadArgs,
	buildYtDlpDurationArgs,
	buildYtDlpInfoArgs,
	buildYtDlpSubtitleArgs,
	cookiesFromBrowserArgs,
	parseWhisperStdout,
	probeMediaBinaryDetailed,
	readVideoDownloadFailure,
	writeVideoDownloadFailure,
} from '../../browser/providers/tool/videoMediaPipeline.js';
import { clearProbeCache } from '../../browser/providers/tool/mediaToolchainProbeCache.js';

suite('videoMediaPipeline — yt-dlp 命令拼装（含 --cookies-from-browser）', () => {

	test('★★ 关时零参数：undefined / 空串 / 非法值 / 仅空白 —— 一个参数都不加', () => {
		for (const v of [undefined, '', '   ', 'not-a-browser', 'chrome.exe', '--evil']) {
			assert.deepStrictEqual(cookiesFromBrowserArgs(v), [], `${JSON.stringify(v)} 必须当没开`);
			const dl = buildYtDlpDownloadArgs({ url: 'https://x', outTemplate: 'o', cookiesFromBrowser: v });
			assert.ok(!dl.includes('--cookies-from-browser'), `下载参数不得含该 flag（值=${JSON.stringify(v)}）`);
		}
	});

	test('★★ 开时：恰好跟在 --no-warnings 之后，值被规范化（trim + 小写）', () => {
		for (const v of ['chrome', 'Chrome', '  EDGE  ']) {
			const dl = buildYtDlpDownloadArgs({ url: 'https://x', outTemplate: 'o', cookiesFromBrowser: v });
			const i = dl.indexOf('--cookies-from-browser');
			assert.ok(i > 0, `flag 必须在（值=${JSON.stringify(v)}）`);
			assert.strictEqual(dl[i - 1], '--no-warnings', '它必须紧跟在 --no-warnings 之后（命令拼装顺序的唯一真源在这里）');
			assert.strictEqual(dl[i + 1], v.trim().toLowerCase(), '值必须规范化');
		}
	});

	test('★ 时长 / 信息 / 字幕三条非下载命令与下载同一口径（登录墙站点的字幕也要身份）', () => {
		const expectContains = (args: string[]) => {
			const i = args.indexOf('--cookies-from-browser');
			assert.ok(i > 0 && args[i + 1] === 'chrome', `应带 cookie 参数：${args.join(' ')}`);
		};
		expectContains(buildYtDlpDurationArgs('https://x', 'chrome'));
		expectContains(buildYtDlpInfoArgs('https://x', 'chrome'));
		expectContains(buildYtDlpSubtitleArgs('https://x', 'tpl', 'chrome'));

		for (const args of [buildYtDlpDurationArgs('https://x'), buildYtDlpInfoArgs('https://x'), buildYtDlpSubtitleArgs('https://x', 'tpl')]) {
			assert.ok(!args.includes('--cookies-from-browser'), '缺省（不传）时不得加');
		}
	});

	test('★ 白名单本身：覆盖 yt-dlp 支持的浏览器名，且不含空串', () => {
		for (const b of ['chrome', 'edge', 'firefox']) {
			assert.ok((COOKIES_FROM_BROWSER_VALUES as readonly string[]).includes(b));
		}
		assert.ok(!(COOKIES_FROM_BROWSER_VALUES as readonly string[]).includes(''), '白名单不得含空串（空串的含义是"关"，不是"传给 yt-dlp"）');
	});

	// ─── 下载格式选择器（2026-09-25 生产事故驱动）──────────────────────────
	// 事故形态：B站链接外部 yt-dlp 能下、video_analyze 内部 exit 1 —— 因为内部选择器
	// 只认 combined（`b`），而 B站只给音画分离的 DASH 流。

	test('★★ 格式选择器：分离流合并优先、combined 兜底、不限高兜底（B站只有 DASH 分离流）', () => {
		const args = buildYtDlpDownloadArgs({ url: 'https://x', outTemplate: 'o' });
		const sel = args[args.indexOf('-f') + 1];
		assert.strictEqual(
			sel, 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b',
			'第一档必须是分离流合并（bv*+ba），只给 combined（b）会在 B站/YouTube 直接无格式可用',
		);
		const capped = buildYtDlpDownloadArgs({ url: 'https://x', outTemplate: 'o', maxHeight: 720 });
		assert.ok(capped[capped.indexOf('-f') + 1].includes('height<=720'), '限高要跟着 maxHeight 走');
	});

	test('★★ --ffmpeg-location：给了绝对路径才传（合并分离流要靠它找到 ffmpeg）', () => {
		const withLoc = buildYtDlpDownloadArgs({ url: 'https://x', outTemplate: 'o', ffmpegLocation: 'D:/bin/ffmpeg.exe' });
		const i = withLoc.indexOf('--ffmpeg-location');
		assert.ok(i > 0 && withLoc[i + 1] === 'D:/bin/ffmpeg.exe', '传了就必须出现在参数里');
		const without = buildYtDlpDownloadArgs({ url: 'https://x', outTemplate: 'o' });
		assert.ok(!without.includes('--ffmpeg-location'), '不传时不得加（裸名/PATH 兜底交给 yt-dlp 自己找）');
	});

	// ─── 下载失败备忘（2026-09-25）────────────────────────────────────────

	test('★★ 失败备忘：写后命中、TTL 到期落空、不同 URL 互不影响、空白 key 不许写', () => {
		// 实测驱动（日志 1790262747712）：同一小红书链接同会话里被抽帧两次、两次都是
		// `yt-dlp exit 1`（需登录）——第二次没有任何信息量，只是重打了一次网。所以钉住：
		let t = 1_000;
		const now = () => t;

		writeVideoDownloadFailure('https://x/post', '下载视频失败（yt-dlp exit 1）', now);
		assert.strictEqual(readVideoDownloadFailure('https://x/post', now), '下载视频失败（yt-dlp exit 1）', '刚写过 ⇒ 命中（不重打网）');
		assert.strictEqual(readVideoDownloadFailure('https://x/other', now), undefined, '别的 URL 不该命中');

		t += 10 * 60_000 + 1;  // 越过 TTL
		assert.strictEqual(readVideoDownloadFailure('https://x/post', now), undefined, 'TTL 到期 ⇒ 落空（才会重新尝试）');

		writeVideoDownloadFailure('   ', 'x', now);
		assert.strictEqual(readVideoDownloadFailure('   ', now), undefined, '空白 key 不许写进备忘');
	});

});

suite('videoMediaPipeline — 本地 ASR（whisper.cpp）命令拼装与输出解析', () => {

	test('★★ whisper 参数必须带 `-l auto`（默认语言是英文，中文口播不传会被按英文硬猜）', () => {
		const args = buildWhisperArgs('D:/m/ggml-base.bin', 'D:/w/a.wav');
		const i = args.indexOf('-l');
		assert.ok(i > 0 && args[i + 1] === 'auto', '必须显式 -l auto');
		assert.deepStrictEqual([args[0], args[1]], ['-m', 'D:/m/ggml-base.bin']);
		assert.deepStrictEqual([args[2], args[3]], ['-f', 'D:/w/a.wav']);
	});

	test('★★ 提音轨参数钉住 whisper 的硬要求：-vn / 16kHz / mono / pcm_s16le', () => {
		const args = buildFfmpegAudioArgs('v.mp4', 'a.wav');
		for (const [k, v] of [['-ar', '16000'], ['-ac', '1'], ['-c:a', 'pcm_s16le']] as const) {
			const i = args.indexOf(k);
			assert.ok(i > 0 && args[i + 1] === v, `${k} ${v} 必须在（whisper 的 WAV 读取器只认这个格式）`);
		}
		assert.ok(args.includes('-vn'), '必须丢弃视频流');
		assert.strictEqual(args[args.length - 1], 'a.wav', '输出路径在最后');
	});

	test('★★ whisper stdout 解析：时间轴压成 [mm:ss]、噪音丢弃、解析不出 ⇒ undefined', () => {
		const text = parseWhisperStdout([
			'whisper_init_from_file: loading model',   // 万一漏进 stdout 的噪音
			'[00:00:00.000 --> 00:00:02.000]  大家好',
			'[00:01:05.500 --> 00:01:07.000]  继续讲',
			'[01:02:03.000 --> 01:02:05.000]  一小时后的内容',
			'',
		].join('\n'));
		assert.ok(text);
		assert.ok(text!.includes('[00:00] 大家好'));
		assert.ok(text!.includes('[01:05] 继续讲'), '分:秒要正确进位');
		assert.ok(text!.includes('[62:03] 一小时后的内容'), '超过一小时要换算成总分钟');
		assert.ok(!text!.includes('whisper_init'), '噪音行不许进文本');
		assert.strictEqual(parseWhisperStdout(''), undefined);
		assert.strictEqual(
			parseWhisperStdout('没有时间轴的裸文本'), undefined,
			'解析不出时间轴宁可判失败（否则会把 whisper 的日志行当转写喂给模型）',
		);
		assert.strictEqual(parseWhisperStdout(undefined), undefined);
	});

});

suite('videoMediaPipeline — 探测的抖动吸收（2026-09-25 启动期误判事故）', () => {
	// 事故形态：应用重启后 ~40s 的 spawn 抖动把完好的 ffmpeg 判成 missing，并缓存 5 分钟
	// ⇒ 整场会话 ffmpeg "不可用"。修复：missing 先重试一次再定论 + 失败带回原因。
	const quietLog = { info() { }, warn() { }, error() { }, debug() { }, trace() { } };
	const bin = { name: 'ffmpeg', command: 'ffmpeg', source: 'path' } as const;

	test('★★ 首次 missing、重试 ok ⇒ 结论 ok（抖动不许定案）', async () => {
		clearProbeCache();
		let n = 0;
		const ctx = {
			logService: quietLog,
			runCommand: async () => (++n === 1
				? { ok: false, exitCode: 1, stdout: '', stderr: 'transient lock' }
				: { ok: true, exitCode: 0, stdout: 'ffmpeg version x', stderr: '' }),
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const d = await probeMediaBinaryDetailed(ctx as any, bin as any, '-version', { retryDelayMs: 0 });
		assert.strictEqual(d.status, 'ok', '重试成功 ⇒ ok');
		assert.strictEqual(n, 2, '必须真的重试了一次');
		assert.strictEqual(d.retried, true, '要标记发生了重试（诊断用）');
	});

	test('★ 重试仍 missing ⇒ missing（不无限重试），且带回 exit/stderr（失败要能说原因）', async () => {
		clearProbeCache();
		let n = 0;
		const ctx = {
			logService: quietLog,
			runCommand: async () => { n++; return { ok: false, exitCode: 127, stdout: '', stderr: 'command not found' }; },
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const d = await probeMediaBinaryDetailed(ctx as any, bin as any, '-version', { retryDelayMs: 0 });
		assert.strictEqual(d.status, 'missing');
		assert.strictEqual(n, 2, '只重试一次（真没装时不能拖慢热路径）');
		assert.strictEqual(d.exitCode, 127);
		assert.ok(d.stderr?.includes('command not found'), 'stderr 要带回（能力探测日志靠它说原因）');
	});
});
