/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 视频媒体管线（ffmpeg / ffprobe / yt-dlp）—— **抽帧与视频理解的公共执行核**（2026-09-24）。
 *
 * ## 为什么单独成模块
 *
 * `extract_video_frames`（只抽帧，交 `vision_analyze` 逐张看）与 `video_analyze`
 * （一次调用内抽帧 + 字幕 + 多模态模型直接给结论）走的是**同一条媒体管线**：
 * 依赖探测 → 下载/取时长 → 抽帧 → 清理。若各写一份，必然出现「一处修好、另一处留旧」
 * 的漂移（本仓已有同类教训）。故：
 *   · 命令拼装：全为**纯函数**（参数错一个就静默抽不出帧，纯函数化才能单测到）；
 *   · 执行编排：`probeMediaToolchain` / `prepareVideoAndFrames` / `fetchTranscript`
 *     三个入口，两个工具共用。
 *
 * ## 二进制解析（★ 2026-09-24 补齐）
 *
 * 此前**只用裸命令名**，完全依赖用户 PATH ⇒ 绝大多数机器没有 ffmpeg/yt-dlp，
 * 工具只能返回「请先安装」的指引。现在走 `knowledge/mediaBinaries.ts`：
 * 环境变量覆盖 → 随包内置（`<install>/resources/saros/bin/`）→ dev 仓库 → PATH。
 *
 * ## 降级纪律（缺依赖时给可执行的指引，而不是晦涩报错）
 *
 * · **ffmpeg 必需**（`ffprobe` 随 ffmpeg 分发）；
 * · **yt-dlp 仅在 source 为 http(s) 时必需** —— 本地视频文件路径不需要它；
 * · 视频时长：URL 走 `yt-dlp --print`，本地文件走 `ffprobe`；
 *   两者都拿不到时退化为「按给定 durationSec（默认 60s）等间隔抽」。
 *
 * ## 设计取舍
 *
 * · **落盘而非内联返回图片**：帧是可复用的证据（可写进笔记、可被再次引用），
 *   而 `vision_analyze` 的入参本来就是文件路径 ⇒ 落盘让工具天然组合；
 * · **默认 6 张 / 限宽 1280**：`vision_analyze` 单图 base64 ≤ 8MB（≈6MB 原图），
 *   1080p 全彩帧很容易超限 ⇒ 默认缩放，宁可让模型看小图也不要报错；
 * · **抽完即删下载的视频**（`keepVideo:false` 默认）：延续「不囤视频」的立场，避免磁盘被吃满。
 */

import * as path from '../../../../../../base/common/path.js';
import { URI } from '../../../../../../base/common/uri.js';
import type { IFileService } from '../../../../../../platform/files/common/files.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { ICommandResult } from '../../knowledge/feishuSyncCore.js';
import {
	resolveMediaBinary, resolveWhisperModel, defaultMediaBinaryRuntime, describeResolvedBinary,
	type IResolvedMediaBinary, type IMediaBinaryContext, type MediaBinaryName,
} from '../../knowledge/mediaBinaries.js';
// ★ 2026-09-24：探活结果进程级缓存（避免每次工具调用都 spawn 156MB ffmpeg / 17MB yt-dlp 做 -version）
import {
	probeCacheKey, readProbeCache, writeProbeCache, type ProbeVerdict,
} from './mediaToolchainProbeCache.js';
import type { IBuiltinToolRegistration } from './toolRegistry.js';

// ─── 上下文 ──────────────────────────────────────────────────────────────────

export interface IVideoMediaContext {
	/**
	 * 工具注册入口。
	 *
	 * 管线本身不注册工具，但两个工具（`extract_video_frames` / `video_analyze`）的 ctx
	 * 都是从这里派生的 ⇒ 把 `register` 放在基类里，避免各处重复声明同一字段。
	 */
	register(registration: IBuiltinToolRegistration): void;
	fileService: IFileService;
	logService: ILogService;
	/** 路径解析 + 沙箱校验（与 file_write 同一套；越界则抛 SandboxViolationError）。 */
	resolveAndCheckWorkspacePath(agentId: string | undefined, requestedPath: string, checkSandbox?: boolean): Promise<string>;
	/** 默认产物根目录（宿主传 `~/.vssaros/tmp`，属允许根且不污染用户工作区）。 */
	defaultOutRoot: string;
	/**
	 * 命令执行器（**宿主必须注入**，见下方 ⚠）。
	 *
	 * ⚠ 这条注释此前写的是"默认 `execShortCommand`"，**与实现不符**：探测里缺省是
	 *   `async () => undefined` ⇒ 结论为 `no-channel`。于是"忘了注入"不会报错，只会让工具
	 *   在真实环境里**恒报"请在桌面版使用"**（单测都注入 fake runner，所以全绿）。
	 *   生产注入点：`builtinToolProvider` 的两个视频工具注册（用 `execShortCommand`）；
	 *   诊断入口 `agentStudio.mediaToolchain.check` 亦同。缺注入时 `probeMediaToolchain`
	 *   会打一条 error 日志（见该函数），避免这类漏接线再次静默。
	 */
	runCommand?: (command: string, timeoutMs?: number) => Promise<ICommandResult | undefined>;
	/** `INativeEnvironmentService.appRoot` —— 供 mediaBinaries 找 dev 仓库内的内置二进制。 */
	appRoot?: string;
	/**
	 * 二进制解析的运行时覆盖（`resourcesPath` / `env` / `platform`）。
	 * 缺省读 `globalThis.process`（见 `defaultMediaBinaryRuntime`）；注入以便单测。
	 */
	mediaBinaryRuntime?: Pick<IMediaBinaryContext, 'resourcesPath' | 'env' | 'platform'>;
	/**
	 * 让 yt-dlp 借用浏览器登录态（设置项 `…browserCdp.cookiesFromBrowser`）—— 2026-09-24。
	 *
	 * 用**取值函数**而不是值：设置随时可能被改，而管线是长生命周期对象（每次调用现取最准）。
	 * 返回 undefined / 空串 / 非法值 ⇒ 不附加任何参数（默认关闭，见 `cookiesFromBrowserArgs`）。
	 */
	cookiesFromBrowser?: () => string | undefined;
	/** 二进制解析器覆盖（单测注入；默认走 `knowledge/mediaBinaries`）。 */
	resolveBinary?: (name: MediaBinaryName) => Promise<IResolvedMediaBinary>;
}

/**
 * 解析/探测所需的**最小上下文**（`IVideoMediaContext` 的子集）。
 *
 * 为什么单独抽出来：自检入口（`mediaToolchainDoctor.ts`，命令面板触发）只需要这几个字段，
 * 不必伪造 `register` / `resolveAndCheckWorkspacePath` / `defaultOutRoot` 这些**工具注册期**
 * 才需要的东西 —— 生产代码里塞哑值迟早会被当成真的用。
 */
export type IMediaProbeContext = Pick<
	IVideoMediaContext,
	'fileService' | 'logService' | 'runCommand' | 'appRoot' | 'mediaBinaryRuntime' | 'resolveBinary'
>;

/** 已解析的工具链（三个二进制一次解析，避免每步各解析一遍）。 */
export interface IResolvedToolchain {
	readonly ffmpeg: IResolvedMediaBinary;
	readonly ffprobe: IResolvedMediaBinary;
	readonly ytdlp: IResolvedMediaBinary;
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** 一次最多抽多少帧（vision_analyze 逐张读，太多既慢又贵）。 */
export const MAX_FRAMES = 24;
export const DEFAULT_FRAMES = 6;
/** 缩放后的最大宽度（高度按比例、且强制偶数）。 */
export const DEFAULT_MAX_WIDTH = 1280;
/** 下载分辨率上限：高于这个对「看画面」没有增量价值，只是白白变大。 */
export const DOWNLOAD_MAX_HEIGHT = 1080;
/** 下载体积上限（防御：误传长视频时不要把磁盘吃满）。 */
export const MAX_DOWNLOAD_MB = 500;
/** 时长未知时的默认采样跨度（秒）。 */
export const FALLBACK_SPAN_SEC = 60;

/** 各步骤超时：元信息/探测要短（失败就降级），下载与抽帧要给足。 */
export const T_META_MS = 20_000;
export const T_DOWNLOAD_MS = 300_000;
export const T_FFMPEG_MS = 120_000;
export const T_PROBE_MS = 15_000;
/** 字幕下载 + 解析（远端链接，best-effort）。 */
export const T_SUBS_MS = 120_000;
/**
 * whisper 转写上限（best-effort）。CPU + base 模型大致 1× 实时 ⇒ 10 分钟够覆盖
 * 大多数短视频；超时按失败处理（退回仅帧分析），不阻塞主流程。
 */
export const T_WHISPER_MS = 600_000;

/** 产物文件名模式（ffmpeg 从 1 开始编号 ⇒ frame-01.png）。 */
export const FRAME_PATTERN = 'frame-%02d.png';

/** 字幕语言偏好：中文优先（zh-Hans/zh-CN 是平台常见写法），再英文。 */
export const SUBTITLE_LANGS = 'zh-Hans.*,zh-CN.*,zh.*,en.*';

// ─── 纯函数（单测覆盖）──────────────────────────────────────────────────────

/**
 * 净化放进 shell 命令串的片段。
 *
 * ⚠ 该通道是 `shell:true`（见 feishuSyncCore.execShortCommand）⇒ URL/路径里的双引号会**逃出引号**
 * 变成额外参数或命令。与 `kbVideoFetch.sanitizeForShell` 同一口径：去引号与控制字符。
 */
export function sanitizeForShell(value: string): string {
	return String(value ?? '').replace(/["\r\n]/g, '').trim();
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(n)) { return fallback; }
	return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** 由 source 派生一个安全的子目录名（URL 取末段、本地取文件名）。 */
export function slugifySource(source: string): string {
	const s = sanitizeForShell(source);
	let base = s;
	try {
		if (/^https?:\/\//i.test(s)) {
			const u = new URL(s);
			base = `${u.hostname}${u.pathname}`;
		}
	} catch { /* 非法 URL ⇒ 用原文 */ }
	base = base.split(/[?#]/)[0].replace(/[\\/]+$/, '');
	const last = base.split(/[\\/]/).filter(Boolean).pop() ?? 'video';
	// 去掉扩展名 → 非法字符折叠为 '-' → 截断 → 去掉首尾 '-'（避免产出名为 '-' 的目录）
	const slug = last.replace(/\.[a-z0-9]{1,6}$/i, '')
		.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, '-')
		.slice(0, 40)
		.replace(/^-+|-+$/g, '');
	// 只剩符号（如 "!!!"）⇒ 兜底名，保证目录可读且稳定
	return /[a-zA-Z0-9\u4e00-\u9fa5_]/.test(slug) ? slug : 'video';
}

export function isRemoteSource(source: string): boolean {
	return /^https?:\/\//i.test(source.trim());
}

/** `yt-dlp --print "%(duration)s"` 的输出 → 秒数（拿不到返回 undefined，不抛）。 */
export function parseDurationPrint(stdout: string | undefined): number | undefined {
	const line = String(stdout ?? '').trim().split('\n').filter(Boolean).pop();
	if (!line || /^(NA|None|N\/A)$/i.test(line)) { return undefined; }
	const n = Number(line);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 采样跨度（秒）：优先用户给的 `durationSec`，否则用「视频总时长 − 起点」，
 * 都拿不到时退化为 `FALLBACK_SPAN_SEC`。结果至少 1 秒。
 */
export function computeSpanSec(opts: { requestedSec?: number; videoDurationSec?: number; startSec: number }): number {
	const remaining = opts.videoDurationSec !== undefined
		? Math.max(1, opts.videoDurationSec - opts.startSec)
		: undefined;
	const span = opts.requestedSec !== undefined
		? Math.min(opts.requestedSec, remaining ?? opts.requestedSec)
		: (remaining ?? FALLBACK_SPAN_SEC);
	return Math.max(1, Math.round(span));
}

export interface IYtDlpDownloadArgsOptions {
	url: string;
	/** 落盘模板（含 `%(ext)s`） */
	outTemplate: string;
	/** 只要这一段（秒）时传；否则整段下载（体积上限保护） */
	sectionSec?: number;
	sectionStartSec?: number;
	maxHeight?: number;
	maxFilesizeMb?: number;
	/**
	 * 已解析 ffmpeg 的绝对路径（内置/覆盖时传）—— 分离流合并（B站/YouTube 的常态）需要
	 * ffmpeg，而 yt-dlp 默认只找 PATH 与自身同目录；显式传 `--ffmpeg-location` 才不受
	 * PATH 有无的左右（2026-09-25：本机 PATH 无 ffmpeg，合并恰靠"同目录"撞上，不能赌）。
	 */
	ffmpegLocation?: string;
}

/**
 * yt-dlp 支持的「从哪个浏览器取 cookie」取值白名单。
 *
 * 为什么要有白名单（值来自用户设置）：这些字符串会被拼进**命令行**，白名单是 fail-closed
 * 的护栏 —— 非法值一律当"没开"，而不是把任意字符串交给 yt-dlp/ shell。
 */
export const COOKIES_FROM_BROWSER_VALUES = [
	'brave', 'chrome', 'chromium', 'edge', 'firefox', 'opera', 'safari', 'vivaldi', 'whale',
] as const;

/**
 * 「借用浏览器登录态」的 yt-dlp 参数（2026-09-24）。
 *
 * ## 为什么需要（实测驱动）
 *
 * yt-dlp 是**独立 http 客户端**，不共享我们在浏览器里建立的登录态 ⇒ 小红书这类需登录的站点
 * 一律 `下载视频失败（yt-dlp exit 1）`，模型只能每次自己绕（`execute_code` 里拿直链）。
 * 开启后由 yt-dlp 直接读本机浏览器的 cookie，是业界标准做法。
 *
 * ## 纪律
 *
 * · 默认**关闭**（`undefined`/空串/非法值 ⇒ 返回空数组）—— 开启意味着把登录态交给外部程序，
 *   必须由用户显式设置；也让"关"时**一个参数都不加**（口径与旧行为逐字一致，可被单测钉住）；
 * · 值大小写不敏感（用户在设置里写 `Chrome` 也应生效）。
 */
export function cookiesFromBrowserArgs(browser: string | undefined): string[] {
	const v = (browser ?? '').trim().toLowerCase();
	if (!v || !(COOKIES_FROM_BROWSER_VALUES as readonly string[]).includes(v)) { return []; }
	return ['--cookies-from-browser', v];
}

/** 下载参数里可选带上的 cookie 来源（见 `cookiesFromBrowserArgs`）。 */
export interface ICookiesFromBrowserOption {
	readonly cookiesFromBrowser?: string;
}

/**
 * 构造 yt-dlp 下载参数（数组形式，便于单测逐项断言）。
 *
 * `--download-sections` 需要较新版本且要 ffmpeg 参与 ⇒ 只在显式要求片段时使用；
 * 整段下载时用 `--max-filesize` 兜底（超限时 yt-dlp 会放弃而不是把磁盘写满）。
 */
export function buildYtDlpDownloadArgs(o: IYtDlpDownloadArgsOptions & ICookiesFromBrowserOption): string[] {
	const h = o.maxHeight ?? DOWNLOAD_MAX_HEIGHT;
	const args = [
		'--no-playlist',
		'--no-warnings',
		...cookiesFromBrowserArgs(o.cookiesFromBrowser),
		// ★★ 2026-09-25（实测驱动）：B站/YouTube 这类站点**只提供音画分离的 DASH 流**，
		//   没有「单文件含音画」的 combined 格式 ⇒ 旧选择器 `b[height<=N]/b` 直接
		//   "Requested format is not available"（生产日志 20260925T015254 实锤：
		//   内部失败、外部默认参数成功）。新选择器按「分离流合并优先、combined 兜底、
		//   最后不限高兜底」逐档回退 —— 与 yt-dlp 隐式默认 `bv*+ba/b` 同族，多了限高。
		//   ⚠ 分离流合并需要 ffmpeg ⇒ 见 ffmpegLocation（yt-dlp 只会自动找 PATH 与
		//   自身同目录，**显式传**才不被 PATH 的有无左右）。
		'-f', `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`,
		'--max-filesize', `${o.maxFilesizeMb ?? MAX_DOWNLOAD_MB}M`,
		'-o', o.outTemplate,
	];
	// ffmpeg 解析到了绝对路径（内置/覆盖）时显式告诉 yt-dlp；裸命令名（PATH 兜底）则不传，
	// 交给 yt-dlp 自己按 PATH 找（传一个裸命令名没有信息量）。
	if (o.ffmpegLocation) {
		args.push('--ffmpeg-location', o.ffmpegLocation);
	}
	if (o.sectionSec !== undefined) {
		args.push('--download-sections', `*${o.sectionStartSec ?? 0}-+${o.sectionSec}`);
	}
	args.push('--', o.url);
	return args;
}

/** `yt-dlp` 取时长的参数（不下载）。 */
export function buildYtDlpDurationArgs(url: string, cookiesFromBrowser?: string): string[] {
	return ['--no-playlist', '--no-warnings', ...cookiesFromBrowserArgs(cookiesFromBrowser), '--skip-download', '--print', '%(duration)s', '--', url];
}

/** `yt-dlp` 取时长 + 标题 + 作者的参数（不下载；一次调用拿到，供 `video_analyze` 的上下文用）。 */
export function buildYtDlpInfoArgs(url: string, cookiesFromBrowser?: string): string[] {
	return ['--no-playlist', '--no-warnings', ...cookiesFromBrowserArgs(cookiesFromBrowser), '--skip-download', '--print', '%(duration)s\t%(title)s\t%(uploader)s', '--', url];
}

export interface IVideoInfo {
	durationSec?: number;
	title?: string;
	uploader?: string;
}

/** 解析 `buildYtDlpInfoArgs` 的输出（Tab 分隔；NA/空 ⇒ 该字段缺省）。 */
export function parseInfoPrint(stdout: string | undefined): IVideoInfo {
	const line = String(stdout ?? '').trim().split('\n').filter(Boolean).pop();
	if (!line) { return {}; }
	const [dur, title, uploader] = line.split('\t');
	const clean = (v: string | undefined): string | undefined => {
		const t = (v ?? '').trim();
		return !t || /^(NA|None|N\/A)$/i.test(t) ? undefined : t;
	};
	const n = Number((dur ?? '').trim());
	return {
		durationSec: Number.isFinite(n) && n > 0 ? n : undefined,
		title: clean(title),
		uploader: clean(uploader),
	};
}

/** `yt-dlp` 下载字幕的参数（不下载视频；含自动字幕，缺中文时回落英文）。 */
export function buildYtDlpSubtitleArgs(url: string, outTemplate: string, cookiesFromBrowser?: string): string[] {
	return [
		'--no-playlist', '--no-warnings', ...cookiesFromBrowserArgs(cookiesFromBrowser), '--skip-download',
		'--write-subs', '--write-auto-subs',
		'--sub-langs', SUBTITLE_LANGS,
		'--convert-subs', 'srt',
		'-o', outTemplate,
		'--', url,
	];
}

/**
 * SRT/VTT 字幕 → 纯文本。
 *
 * 为什么不用现成库：只需「去掉序号与时间轴、合并成段」这一步，引入依赖不划算；
 * 且字幕格式高度规整，正则足够稳定（已单测覆盖 SRT / VTT / 空输入三种形态）。
 */
export function parseSubtitleToText(raw: string | undefined): string | undefined {
	const src = String(raw ?? '').replace(/\r/g, '');
	if (!src.trim()) { return undefined; }
	const lines: string[] = [];
	for (const line of src.split('\n')) {
		const t = line.trim();
		if (!t) { continue; }
		if (/^WEBVTT/i.test(t)) { continue; }
		if (/^\d+$/.test(t)) { continue; }                                   // SRT 序号
		if (t.includes('-->')) { continue; }                                 // 时间轴
		if (/^(NOTE|STYLE|REGION)\b/i.test(t)) { continue; }                 // VTT 元块
		if (/^Kind:|^Language:/i.test(t)) { continue; }
		// 去 VTT 的内联时间标记 `<00:00:01.000>` 与说话人标记
		const clean = t.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
		if (!clean) { continue; }
		// 连续重复行（自动字幕常见的滚动重复）只留一次
		if (lines.length && lines[lines.length - 1] === clean) { continue; }
		lines.push(clean);
	}
	const text = lines.join('\n').trim();
	return text || undefined;
}

/** `ffprobe` 取本地文件时长的参数。 */
export function buildFfprobeDurationArgs(filePath: string): string[] {
	return ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath];
}

export interface IFfmpegFrameArgsOptions {
	videoPath: string;
	outPattern: string;
	/** 抽几帧 */
	frames: number;
	startSec: number;
	/** 采样跨度（秒） */
	spanSec: number;
	maxWidth?: number;
}

/**
 * 构造 ffmpeg 抽帧参数：`fps = frames / span` ⇒ 在 span 内**等间隔**取 frames 张，
 * 再用 `scale=W:-2` 等比缩放到目标宽度（-2 保证高度为偶数，编码器要求）。
 */
export function buildFfmpegArgs(o: IFfmpegFrameArgsOptions): string[] {
	const span = Math.max(1, o.spanSec);
	const fps = o.frames / span;
	return [
		'-hide_banner', '-loglevel', 'error', '-y',
		'-ss', String(Math.max(0, o.startSec)),
		'-i', o.videoPath,
		'-t', String(span),
		'-vf', `fps=${fps.toFixed(4)},scale=${o.maxWidth ?? DEFAULT_MAX_WIDTH}:-2`,
		'-frames:v', String(o.frames),
		o.outPattern,
	];
}

/** 帧序号 → 该帧的时间戳（秒）；用于回显「frame-03.png @ 00:20」。 */
export function frameTimestampSec(index1Based: number, startSec: number, spanSec: number, frames: number): number {
	const step = spanSec / Math.max(1, frames);
	return Math.round((startSec + (index1Based - 1) * step) * 10) / 10;
}

export function formatMMSS(sec: number): string {
	const s = Math.max(0, Math.round(sec));
	return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 把参数数组拼成可交给 shell 的命令串（每项都加引号，抵御空格与特殊字符）。 */
export function buildCommand(executable: string, args: readonly string[]): string {
	return [executable, ...args].map(a => `"${sanitizeForShell(a)}"`).join(' ');
}

// ─── 依赖探测 + 指引 ────────────────────────────────────────────────────────

/** 依赖缺失时的指引（★ 2026-09-24 改：先说明「正常安装包自带」，再给自装与覆盖手段）。 */
export const FFMPEG_HINT = [
	'未检测到 ffmpeg（抽帧/取时长必需）。正常情况下**不需要你安装** —— VsSaros 安装包自带：',
	'  <安装目录>/resources/saros/bin/ffmpeg.exe',
	'排查顺序：',
	'  1. 从源码运行 ⇒ 先执行 `node build/saros/fetch-ffmpeg.mjs` 一键下载内置二进制；',
	'  2. 想自装也可以：Windows `winget install --id Gyan.FFmpeg` / macOS `brew install ffmpeg` / Linux `apt install ffmpeg`；',
	'  3. 已装但找不到 ⇒ 设环境变量 `FFMPEG_PATH=<ffmpeg 绝对路径>`（本工具优先使用它）。',
].join('\n');

export const YTDLP_HINT = [
	'未检测到 yt-dlp（下载远端视频与字幕必需）。正常情况下**不需要你安装** —— VsSaros 安装包自带：',
	'  <安装目录>/resources/saros/bin/yt-dlp.exe',
	'排查顺序：',
	'  1. 从源码运行 ⇒ 执行 `node build/saros/fetch-ffmpeg.mjs`（会一并下载 yt-dlp）；',
	'  2. 已装但找不到 ⇒ 设环境变量 `YTDLP_PATH=<yt-dlp 绝对路径>`（本工具优先使用它）；',
	'  3. 视频已在本地时，可直接把**本地文件路径**作为 source 传入（不需要 yt-dlp）。',
].join('\n');

export const NO_CHANNEL_HINT = [
	'当前环境没有命令执行通道（非桌面版）⇒ 无法调用 ffmpeg/yt-dlp。',
	'请在 VsSaros 桌面版里使用，或让用户自己抽好帧后把图片发给你（再用 vision_analyze 读）。',
].join('\n');

export type ProbeStatus = 'ok' | 'missing' | 'no-channel';

export interface IToolchainProbe {
	readonly status: ProbeStatus;
	/** 失败时给用户的完整说明（已含指引）。 */
	readonly message?: string;
	readonly bins?: IResolvedToolchain;
}

export interface IProbeOptions {
	/** 注入时钟（单测控制 TTL；缺省 `Date.now`）。 */
	now?: () => number;
	/** 绕开探活缓存（**诊断/自检入口必须用**，否则用户刚装完仍看到旧结论）。 */
	force?: boolean;
	/** 超时（缺省 `T_META_MS`）。 */
	timeoutMs?: number;
	/** 「missing ⇒ 重试一次」的间隔（缺省 1500ms；单测传 0）。 */
	retryDelayMs?: number;
}

/**
 * 解析 + 探测单个二进制（`-version` / `--version`；只看退出码），**带进程级缓存**。
 *
 * 为什么必须缓存：这两个 exe 都不小（ffmpeg 156MB / yt-dlp 17MB PyInstaller 单文件），
 * 每次工具调用都 spawn 一次来回答「装没装」这个静态问题，代价被任务内的多次调用乘起来。
 * 详见 `mediaToolchainProbeCache.ts` 头注释（含三条纪律与 TTL 选择理由）。
 *
 * ⚠ **只看退出码**：曾把「有输出」也算可用 ⇒ `command not found`（stderr 有字、exit 127）
 *   被误判为已安装，于是不给安装指引，而是继续跑到抽帧失败（用户看到无用的"抽帧失败"）。
 * ⚠ `no-channel` **不进缓存**：它描述"本次环境能否执行命令"，与二进制在不在是两回事。
 */
export async function probeMediaBinary(
	ctx: IMediaProbeContext, bin: IResolvedMediaBinary, flag: string, opts: IProbeOptions = {},
): Promise<ProbeStatus> {
	return (await probeMediaBinaryDetailed(ctx, bin, flag, opts)).status;
}

/** 探测的详细信息（含**原始输出**，供自检报告显示版本、供失败日志说清原因）。 */
export interface IProbeDetail {
	readonly status: ProbeStatus;
	/** `-version` / `--version` 的输出（仅在真正执行时才有；缓存命中时缺省）。 */
	readonly stdout?: string;
	/** stderr 末尾（失败原因诊断用；2026-09-25：此前失败完全不打原因，只能猜）。 */
	readonly stderr?: string;
	readonly exitCode?: number;
	/** 本次是否发生了「missing ⇒ 重试」的抖动吸收（诊断用）。 */
	readonly retried?: boolean;
}

/**
 * 与 `probeMediaBinary` 同源，但**额外带回输出**（自检入口要显示版本号）。
 *
 * 为什么放在同一处而不是让自检自己拼命令：命令拼装（`buildCommand` 的引号规则）与
 * 缓存写入必须只有一份实现 —— 自检若自己 spawn 一次，就既绕开了缓存、又可能拼出
 * 另一套引号，两处行为会漂移。
 */
export async function probeMediaBinaryDetailed(
	ctx: IMediaProbeContext, bin: IResolvedMediaBinary, flag: string, opts: IProbeOptions = {},
): Promise<IProbeDetail> {
	const run = ctx.runCommand ?? (async () => undefined);
	const now = opts.now ?? (() => Date.now());
	const key = probeCacheKey(bin.command, flag);
	if (!opts.force) {
		const cached = readProbeCache(key, now());
		if (cached) {
			ctx.logService.debug(`[videoMedia] probe cache hit: ${bin.name} = ${cached}`);
			return { status: cached };
		}
	}
	const once = async () => run(buildCommand(bin.command, [flag]), opts.timeoutMs ?? T_META_MS);
	let r = await once();
	if (!r) { return { status: 'no-channel' }; }
	let retried = false;
	// ★ 2026-09-25（生产日志 20260925T022608）：启动高峰期的一次抖动（spawn 慢/杀软占用）
	//   会把完好的二进制误判 missing。missing 先重试一次再定论（与 fetch-ffmpeg.mjs 的
	//   verifyBinary 重试同一教训：刚落盘/高负载时的首次执行不可信）。
	if (!(r.ok || r.exitCode === 0)) {
		retried = true;
		await new Promise(res => setTimeout(res, opts.retryDelayMs ?? 1500));
		const r2 = await once();
		if (r2) { r = r2; }
	}
	const status: ProbeVerdict = (r.ok || r.exitCode === 0) ? 'ok' : 'missing';
	writeProbeCache(key, status, now());
	return { status, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, retried };
}

/** 解析三个二进制（环境变量覆盖 → 随包内置 → dev 仓库 → PATH）。 */
export async function resolveToolchain(ctx: IMediaProbeContext): Promise<IResolvedToolchain> {
	const runtime = ctx.mediaBinaryRuntime ?? defaultMediaBinaryRuntime();
	const resolve = ctx.resolveBinary ?? ((name: MediaBinaryName) => resolveMediaBinary(name, {
		fileService: ctx.fileService,
		appRoot: ctx.appRoot,
		resourcesPath: runtime.resourcesPath,
		env: runtime.env,
		platform: runtime.platform,
		logService: ctx.logService,
	}));
	const [ffmpeg, ffprobe, ytdlp] = await Promise.all([
		resolve('ffmpeg'), resolve('ffprobe'), resolve('yt-dlp'),
	]);
	return { ffmpeg, ffprobe, ytdlp };
}

/**
 * 探测工具链：`ffmpeg` 必需；远端链接时 `yt-dlp` 必需。
 * 失败时返回**可执行的指引**（与工具回显同一套文案，避免两处各写一份）。
 *
 * `opts.force` ⇒ 绕开探活缓存（自检/诊断入口用）；`opts.now` ⇒ 注入时钟（单测 TTL）。
 */
export async function probeMediaToolchain(
	ctx: IMediaProbeContext, opts: { remote: boolean; force?: boolean; now?: () => number },
): Promise<IToolchainProbe> {
	// ★★ 2026-09-24（修复）：缺命令通道是**宿主接线漏了**，不是用户的错。
	//   此前它静默表现为 `no-channel` ⇒ 工具一律回"请在桌面版使用"，排查无从下手
	//   （实测：provider 漏注入 `runCommand`，生产全废而单测全绿）。这条日志只在
	//   **工具路径**上打（诊断入口直接调 `probeMediaBinaryDetailed`，不受影响）。
	if (!ctx.runCommand) {
		ctx.logService.error('[videoMedia] 未注入命令通道（ctx.runCommand 缺失）⇒ 媒体工具将恒报 no-channel。'
			+ '请检查宿主接线（builtinToolProvider 的视频工具注册应传 execShortCommand）。');
	}
	const bins = await resolveToolchain(ctx);
	const probeOpts: IProbeOptions = { force: opts.force, now: opts.now };

	const ff = await probeMediaBinary(ctx, bins.ffmpeg, '-version', probeOpts);
	if (ff === 'no-channel') { return { status: 'no-channel', message: NO_CHANNEL_HINT }; }
	if (ff === 'missing') { return { status: 'missing', message: FFMPEG_HINT }; }

	if (opts.remote) {
		const yt = await probeMediaBinary(ctx, bins.ytdlp, '--version', probeOpts);
		if (yt === 'no-channel') { return { status: 'no-channel', message: NO_CHANNEL_HINT }; }
		if (yt === 'missing') { return { status: 'missing', message: YTDLP_HINT }; }
	}
	return { status: 'ok', bins };
}

/**
 * 探测「能力就绪度」：**分别**返回 `ffmpeg` / `yt-dlp` 的结论 —— 供工具列表做 availability 标注
 * （见 `toolAvailabilityNotes.ts`）。
 *
 * 为什么不复用 `probeMediaToolchain`：后者在**第一个缺失处提前返回**（它回答的是"这次任务能不能跑"），
 * 拿不到"两个各自如何"。这里两个都探，且共用同一份解析 + 同一份探活缓存（不额外 spawn）。
 *
 * `undefined` = 未知（非桌面通道 / 探测异常）⇒ 调用方按"可用"处理（fail-open）。
 */
export async function probeMediaCapabilities(
	ctx: IMediaProbeContext, opts: IProbeOptions = {},
): Promise<{ ffmpeg?: boolean; ytdlp?: boolean }> {
	const toFact = (status: ProbeStatus): boolean | undefined =>
		status === 'ok' ? true : (status === 'missing' ? false : undefined);
	const bins = await resolveToolchain(ctx);
	// 失败必须带原因进日志（2026-09-25：ffmpeg 被判 false 但日志零细节，排查只能靠猜）——
	// 能力表是给工具列表做标注的，它的误判会让工具整场会话被错误标注。
	const probe = async (bin: IResolvedMediaBinary, flag: string) => {
		const d = await probeMediaBinaryDetailed(ctx, bin, flag, opts);
		if (d.status !== 'ok') {
			ctx.logService.warn(`[videoMedia] capability probe: ${bin.name} => ${d.status}`
				+ `（exit=${d.exitCode ?? '?'}${d.retried ? '，已重试' : ''}）${(d.stderr ?? d.stdout ?? '').trim().slice(-300)}`);
		}
		return d.status;
	};
	const ffmpeg = toFact(await probe(bins.ffmpeg, '-version'));
	const ytdlp = toFact(await probe(bins.ytdlp, '--version'));
	return { ffmpeg, ytdlp };
}

// ─── 执行：取视频 + 抽帧 ────────────────────────────────────────────────────

export interface IPrepareFramesOptions {
	readonly source: string;
	/** 调用方 agent（沙箱校验按 agent 作用域，必须透传 —— 漏传会放宽/错配越界判定）。 */
	readonly agentId?: string;
	readonly frames: number;
	readonly startSec: number;
	/** 采样跨度（秒）；缺省 = 整段（拿不到时长时 FALLBACK_SPAN_SEC）。 */
	readonly durationSec?: number;
	readonly maxWidth: number;
	/** 产物目录（调用方已解析并创建的绝对路径）。 */
	readonly outDir: string;
	/** 是否保留下载的视频（默认 false：抽完即删）。 */
	readonly keepVideo: boolean;
	/** 是否顺带取标题/作者（`video_analyze` 需要给模型更多上下文）。 */
	readonly withMetadata?: boolean;
}

export interface IPreparedVideo {
	readonly videoPath: string;
	readonly remote: boolean;
	readonly workDir?: string;
	readonly frames: readonly string[];
	readonly frameTimesSec: readonly number[];
	readonly startSec: number;
	readonly spanSec: number;
	readonly videoDurationSec?: number;
	readonly title?: string;
	readonly uploader?: string;
	/** 删除下载的视频与临时目录（远端且 keepVideo=false 时调用）。 */
	readonly cleanup: () => Promise<void>;
}

// ─── 下载失败备忘（同进程内同 URL 的同种失败不重打网，2026-09-25）────────────
//
// 实测驱动（日志 1790262747712）：`extract_video_frames` 对同一小红书链接在**同一会话**里
// 被调两次，两次都是 `yt-dlp exit 1`（需登录），各耗 ~4.3s —— 第二次没有任何信息量，
// 只是重新打了一次网。web_search 早已有同款的"结果备忘"（TTL + 单飞），这里补它的**失败**侧。
//
// 刻意只备忘「下载失败」：它由**网络/登录态**决定，同进程内重复没有信息量；
// 二进制缺失（probe）有自己的缓存（mediaToolchainProbeCache），不在这里混。

/** 失败备忘的存活期。太短（<1min）挡不住"同轮重试"；太长会挡住"用户刚登完录"。 */
const VIDEO_DL_FAILURE_TTL_MS = 10 * 60_000;

const videoDlFailureMemo = new Map<string, { message: string; at: number }>();

/** 该 source 在 TTL 内是否已失败过（命中 ⇒ 直接返回那时的结论，不重打网）。 */
export function readVideoDownloadFailure(source: string, now: () => number = Date.now): string | undefined {
	const hit = videoDlFailureMemo.get(source.trim());
	if (!hit) { return undefined; }
	if (now() - hit.at > VIDEO_DL_FAILURE_TTL_MS) { videoDlFailureMemo.delete(source.trim()); return undefined; }
	return hit.message;
}

/** 记录一次下载失败（只在**真的打过网**之后调用 —— 命中备忘的路径不许再写）。 */
export function writeVideoDownloadFailure(source: string, message: string, now: () => number = Date.now): void {
	const key = source.trim();
	if (!key) { return; }
	if (videoDlFailureMemo.size > 60) { videoDlFailureMemo.clear(); }  // 朴素的容量上限（失败消息都很小）
	videoDlFailureMemo.set(key, { message, at: now() });
}

/**
 * 清空失败备忘 —— **测试隔离钩子**（与 `clearProbeCache` 同一存在的理由）：
 * 备忘是进程级共享的，前一个用例的失败会在 TTL 内毒化所有复用同一 URL 的后续用例
 * （2026-09-25 实测：「下载失败」用例毒化了同文件的「抽帧无产物」「keepVideo」两个用例）。
 */
export function clearVideoDownloadFailure(): void {
	videoDlFailureMemo.clear();
}

export type PrepareFramesResult = { ok: true; prepared: IPreparedVideo } | { ok: false; message: string };

/** 列出目录下的直接子项名（目录不存在 / 读取失败 ⇒ 空数组）。 */
async function listChildren(fileService: IFileService, dir: string): Promise<string[]> {
	try {
		const stat = await fileService.resolve(URI.file(dir));
		return (stat.children ?? []).filter(c => !c.isDirectory).map(c => c.name);
	} catch {
		return [];
	}
}

/**
 * 取视频（远端下载 / 本地直接用）→ 探时长 → 等间隔抽帧。
 *
 * 成功返回的 `prepared.cleanup()` 会删除下载的视频；调用方**必须**在 finally 里调
 * （除非显式要保留），否则磁盘会被下载的视频吃满 —— 这是本管线唯一的副作用。
 */
export async function prepareVideoAndFrames(
	ctx: IVideoMediaContext, bins: IResolvedToolchain, opts: IPrepareFramesOptions,
): Promise<PrepareFramesResult> {
	const run = ctx.runCommand ?? (async () => undefined);
	const remote = isRemoteSource(opts.source);

	let videoPath = opts.source;
	let workDir: string | undefined;
	let videoDurationSec: number | undefined;
	let title: string | undefined;
	let uploader: string | undefined;

	const cleanup = async (): Promise<void> => {
		if (workDir && !opts.keepVideo) {
			try { await ctx.fileService.del(URI.file(workDir), { recursive: true }); } catch { /* best-effort */ }
		}
	};

	try {
		if (remote) {
			workDir = path.join(opts.outDir, '_src');
			await ctx.fileService.createFolder(URI.file(workDir));
			const dlTemplate = path.join(workDir, 'video.%(ext)s');
			const span = computeSpanSec({ requestedSec: opts.durationSec, startSec: opts.startSec });
			const dlArgs = buildYtDlpDownloadArgs({
				url: opts.source,
				outTemplate: dlTemplate,
				// 需登录才给流的站点（小红书等）必须靠它 —— 见 `cookiesFromBrowserArgs`。
				cookiesFromBrowser: ctx.cookiesFromBrowser?.(),
				// 分离流合并要用 ffmpeg：把已解析的绝对路径显式传给 yt-dlp（裸名则不传）。
				ffmpegLocation: bins.ffmpeg.source === 'path' ? undefined : bins.ffmpeg.command,
				// 只要一小段时用 --download-sections 省流量；整段才下载
				...(opts.durationSec !== undefined ? { sectionSec: span, sectionStartSec: opts.startSec } : {}),
			});
			ctx.logService.info(`[videoMedia] downloading: ${sanitizeForShell(opts.source)}`);
			// 失败备忘：同一 URL 在 TTL 内刚失败过 ⇒ 直接回上次的结论，**不重打网**
			// （它由网络/登录态决定，同进程内重复没有信息量 —— 实测同链接被原样重打过）。
			const memoizedFailure = readVideoDownloadFailure(opts.source);
			if (memoizedFailure) {
				return {
					ok: false,
					message: memoizedFailure
						+ '\n\n（同一 URL 在本进程内刚失败过 ⇒ 这次**没有**重复下载。换了 cookie / 登录态 / 网络后，TTL 到期才会再试。）',
				};
			}
			const dl = await run(buildCommand(bins.ytdlp.command, dlArgs), T_DOWNLOAD_MS);
			if (!dl) { return { ok: false, message: '命令通道不可用（非桌面版）⇒ 无法下载视频。' }; }

			// ⚠ yt-dlp 遇到"没有字幕/没有某个流"等也会非 0 退出 ⇒ 以**产物文件是否存在**判定成功
			const produced = await listChildren(ctx.fileService, workDir);
			const video = produced.find(n => /^video\./i.test(n));
			if (!video) {
				const tail = `${dl.stdout ?? ''}${dl.stderr ?? ''}`.trim().slice(-600);
				const message = `下载视频失败（yt-dlp exit ${dl.exitCode}）。\n${tail || '(无输出)'}\n`
					+ '可尝试：\n'
					+ '  · 确认链接可公开访问（私密/已删除/需登录的视频拿不到）；\n'
					+ '  · **平台反爬**（YouTube 常报 "Sign in to confirm you\'re not a bot"；抖音/小红书也会拦）'
					+ '⇒ 让用户把视频下载到本地，再把**本地文件路径**作为 source 传入（最可靠）；\n'
					+ '  · 升级 yt-dlp（平台改动频繁，旧版本容易失效）。';
				writeVideoDownloadFailure(opts.source, message);
				return { ok: false, message };
			}
			videoPath = path.join(workDir, video);

			const metaArgs = opts.withMetadata
				? buildYtDlpInfoArgs(opts.source, ctx.cookiesFromBrowser?.())
				: buildYtDlpDurationArgs(opts.source, ctx.cookiesFromBrowser?.());
			const meta = await run(buildCommand(bins.ytdlp.command, metaArgs), T_META_MS);
			if (opts.withMetadata) {
				const info = parseInfoPrint(meta?.stdout);
				videoDurationSec = info.durationSec;
				title = info.title;
				uploader = info.uploader;
			} else {
				videoDurationSec = parseDurationPrint(meta?.stdout);
			}
		} else {
			const resolved = await ctx.resolveAndCheckWorkspacePath(opts.agentId, opts.source);
			if (!(await ctx.fileService.exists(URI.file(resolved)))) {
				return { ok: false, message: `本地视频不存在：${resolved}` };
			}
			videoPath = resolved;
			const probe = await run(buildCommand(bins.ffprobe.command, buildFfprobeDurationArgs(videoPath)), T_PROBE_MS);
			videoDurationSec = parseDurationPrint(probe?.stdout);
		}

		// 抽帧
		const spanSec = computeSpanSec({ requestedSec: opts.durationSec, videoDurationSec, startSec: opts.startSec });
		const outPattern = path.join(opts.outDir, FRAME_PATTERN);
		const ffArgs = buildFfmpegArgs({
			videoPath, outPattern, frames: opts.frames, startSec: opts.startSec, spanSec, maxWidth: opts.maxWidth,
		});
		const ff = await run(buildCommand(bins.ffmpeg.command, ffArgs), T_FFMPEG_MS);
		const names = (await listChildren(ctx.fileService, opts.outDir))
			.filter(n => /^frame-\d+\.png$/i.test(n)).sort();
		if (!names.length) {
			const tail = `${ff?.stdout ?? ''}${ff?.stderr ?? ''}`.trim().slice(-600);
			await cleanup();
			return {
				ok: false,
				message: `抽帧失败（ffmpeg exit ${ff?.exitCode ?? 'n/a'}）。\n${tail || '(无输出)'}\n`
					+ '可尝试：确认该文件确实是视频、或把 startSec/durationSec 调小一些。',
			};
		}

		return {
			ok: true,
			prepared: {
				videoPath, remote, workDir,
				frames: names.map(n => path.join(opts.outDir, n)),
				frameTimesSec: names.map((_n, i) => frameTimestampSec(i + 1, opts.startSec, spanSec, opts.frames)),
				startSec: opts.startSec, spanSec, videoDurationSec, title, uploader,
				cleanup,
			},
		};
	} catch (err) {
		await cleanup();
		return { ok: false, message: `视频处理异常：${err instanceof Error ? err.message : String(err)}` };
	}
}

// ─── 执行：字幕（best-effort）───────────────────────────────────────────────

export interface ITranscript {
	readonly text: string;
	/**
	 * `auto` ⇒ 平台自动字幕（可能有错别字）；`manual` ⇒ 人工上传字幕；
	 * `asr` ⇒ **本地 ASR 转写**（whisper.cpp，2026-09-25）——无字幕轨视频的口播兜底，
	 * 可能有错别字/简繁混排（base 档位已知水平），结论里要注明。
	 */
	readonly kind: 'auto' | 'manual' | 'asr';
	readonly chars: number;
}

/** 单次最多带回多少字字幕（防止把长视频字幕整份灌进上下文）。 */
export const MAX_TRANSCRIPT_CHARS = 12_000;

/**
 * 抓字幕（仅远端链接；best-effort：任何失败都返回 undefined，**不影响**抽帧结果）。
 *
 * 为什么值得做：抽帧只覆盖**画面**，口播/机制说明几乎全在**字幕**里；
 * 缺了它，模型只能凭几帧画面猜玩法（`kb-game-teardown` 最在意的"编造"风险）。
 */
export async function fetchTranscript(
	ctx: IVideoMediaContext, bins: IResolvedToolchain, source: string, workDir: string | undefined,
): Promise<ITranscript | undefined> {
	if (!workDir) { return undefined; }
	const run = ctx.runCommand ?? (async () => undefined);
	const subDir = path.join(workDir, 'subs');
	try {
		await ctx.fileService.createFolder(URI.file(subDir));
		const tpl = path.join(subDir, 'sub.%(ext)s');
		// 登录墙站点的字幕同样需要身份（与下载同一条 cookie 来源；默认关 ⇒ 一个参数都不加）
		await run(buildCommand(bins.ytdlp.command, buildYtDlpSubtitleArgs(source, tpl, ctx.cookiesFromBrowser?.())), T_SUBS_MS);
		const files = (await listChildren(ctx.fileService, subDir)).filter(n => /\.(srt|vtt)$/i.test(n));
		if (!files.length) { return undefined; }
		// 优先人工字幕（文件名不带 .auto 后缀），其次自动字幕
		const manual = files.find(n => !/\.auto\./i.test(n));
		const picked = manual ?? files[0];
		const content = await ctx.fileService.readFile(URI.file(path.join(subDir, picked)));
		const text = parseSubtitleToText(content.value.toString());
		if (!text) { return undefined; }
		const clipped = text.length > MAX_TRANSCRIPT_CHARS ? text.slice(0, MAX_TRANSCRIPT_CHARS) : text;
		return { text: clipped, kind: manual ? 'manual' : 'auto', chars: clipped.length };
	} catch {
		return undefined;
	}
}

// ─── 执行：本地 ASR（whisper.cpp，2026-09-25）───────────────────────────────
//
// 为什么需要：字幕轨抓取（fetchTranscript）对**没有字幕轨**的视频（小红书/抖音教程几乎都是
// 口播）只能返回 undefined ⇒ 模型只剩帧 ⇒ 「口播内容不可知」。whisper 补上这一环：
// ffmpeg 提音轨 → whisper-cli 转写，全程本地、离线、不依赖外部模型。
//
// 纪律与 fetchTranscript 相同：**best-effort** —— 任何一步失败都返回 undefined（退回仅帧
// 分析），绝不让 ASR 故障把已经抽好的帧也拖下水。

/** ffmpeg 提音轨参数：whisper.cpp 的 WAV 读取器只认 16kHz mono 16bit ⇒ 必须显式转。 */
export function buildFfmpegAudioArgs(videoPath: string, wavPath: string): string[] {
	return ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath,
		'-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath];
}

/**
 * whisper-cli 转写参数。
 * ⚠ `-l auto` 必传：whisper-cli 的默认语言是**英文**（whisper.cpp 的 upstream 默认），
 *   中文口播不传它会被按英文音素硬猜 ⇒ 输出一堆无意义英文。
 */
export function buildWhisperArgs(modelPath: string, wavPath: string): string[] {
	return ['-m', modelPath, '-f', wavPath, '-l', 'auto'];
}

/**
 * 解析 whisper-cli 的 stdout 为带时间锚点的文本。
 *
 * whisper-cli 默认输出形如 `[00:01:23.450 --> 00:01:26.000]  文本` 的行；进度/日志走 stderr。
 * 这里只保留每段的**开始时间**并压成 `[mm:ss] 文本`（与帧标注 `[帧 mm:ss]` 同款格式，模型
 * 可以把口播与画面对到同一时间轴上）。一行都解析不出来 ⇒ undefined（调用方按失败处理）。
 */
export function parseWhisperStdout(raw: string | undefined): string | undefined {
	const src = String(raw ?? '').replace(/\r/g, '');
	const lines: string[] = [];
	for (const line of src.split('\n')) {
		const m = line.match(/^\s*\[(\d+):(\d{2}):(\d{2})\.\d+\s*-->\s*[\d:.]+\s*\]\s*(.*)$/);
		if (!m) { continue; }
		const text = m[4].trim();
		if (!text) { continue; }
		const mm = String(Number(m[1]) * 60 + Number(m[2])).padStart(2, '0');
		lines.push(`[${mm}:${m[3]}] ${text}`);
	}
	const out = lines.join('\n').trim();
	return out || undefined;
}

/** 已解析的 ASR 工具链（whisper-cli + 模型，两者缺一即不可用）。 */
export interface IResolvedAsr {
	readonly whisperCli: IResolvedMediaBinary;
	readonly modelPath: string;
}

/**
 * 解析 + 探测 ASR 工具链（whisper-cli 与模型）。任一缺失/不可执行 ⇒ undefined。
 *
 * ⚠ 探测不能只信退出码：`whisper-cli --help` 在部分版本上退出码非 0 ⇒ 输出里含
 *   「whisper」字样也算可用（与 fetch-whisper.mjs 的 verifyWhisper 同一判据，两处别漂移）。
 */
export async function resolveAsrToolchain(ctx: IMediaProbeContext): Promise<IResolvedAsr | undefined> {
	if (!ctx.runCommand) { return undefined; }
	const runtime = ctx.mediaBinaryRuntime ?? defaultMediaBinaryRuntime();
	const binCtx: IMediaBinaryContext = {
		fileService: ctx.fileService, appRoot: ctx.appRoot,
		resourcesPath: runtime.resourcesPath, env: runtime.env, platform: runtime.platform,
		logService: ctx.logService,
	};
	// ⚠ 必须走 ctx.resolveBinary 钩子（若宿主注入）：与 resolveToolchain 同一约定 ——
	//   单测靠它喂假二进制；绕过它会让测试里的 ASR 永远解析不到（静默退回仅帧）。
	const whisperCli = ctx.resolveBinary
		? await ctx.resolveBinary('whisper-cli')
		: await resolveMediaBinary('whisper-cli', binCtx);
	const model = await resolveWhisperModel(binCtx);
	if (!model) {
		ctx.logService.debug('[videoMedia] ASR 不可用：whisper 模型未找到（build/saros/models 或 WHISPER_MODEL_PATH）');
		return undefined;
	}
	const probe = await probeMediaBinaryDetailed(ctx, whisperCli, '--help');
	const usable = probe.status === 'ok' || /whisper/i.test(probe.stdout ?? '');
	if (!usable) {
		ctx.logService.debug(`[videoMedia] ASR 不可用：whisper-cli 探测失败（status=${probe.status}）`);
		return undefined;
	}
	return { whisperCli, modelPath: model.path };
}

/**
 * 本地 ASR 转写（best-effort）：ffmpeg 提音轨 → whisper-cli 转写。
 *
 * `ffmpegCommand`：主工具链已解析/探测过的 ffmpeg（调用方 probe 后必有）——ASR 复用它，
 * 不自己再解析一遍（同一进程内同一判据，避免"抽帧用内置、提音轨用 PATH"的两套口径）。
 *
 * `audioDir`：wav 临时目录（远端视频复用下载目录 `_src`，本地视频由调用方给产物目录）。
 * 转写成功后 wav 即删（它只是中间产物；删不掉也不影响结果）。
 */
export async function transcribeWithWhisper(
	ctx: IVideoMediaContext, ffmpegCommand: string, videoPath: string, audioDir: string,
): Promise<ITranscript | undefined> {
	const run = ctx.runCommand;
	if (!run) { return undefined; }
	let wavPath: string | undefined;
	try {
		const asr = await resolveAsrToolchain(ctx);
		if (!asr) { return undefined; }

		const wavDir = path.join(audioDir, '_asr');
		await ctx.fileService.createFolder(URI.file(wavDir));
		wavPath = path.join(wavDir, 'audio-16k.wav');

		ctx.logService.info(`[videoMedia] ASR: 提取音轨（${path.basename(videoPath)} → 16kHz mono wav）`);
		const ff = await run(buildCommand(ffmpegCommand, buildFfmpegAudioArgs(videoPath, wavPath)), T_FFMPEG_MS);
		if (!ff || !(ff.ok || ff.exitCode === 0) || !(await ctx.fileService.exists(URI.file(wavPath)))) {
			ctx.logService.warn('[videoMedia] ASR: ffmpeg 提音轨失败 ⇒ 退回仅帧分析');
			return undefined;
		}

		ctx.logService.info(`[videoMedia] ASR: whisper 转写中（模型 ${path.basename(asr.modelPath)}，最长 ${Math.round(T_WHISPER_MS / 60000)} 分钟）…`);
		const wp = await run(buildCommand(asr.whisperCli.command, buildWhisperArgs(asr.modelPath, wavPath)), T_WHISPER_MS);
		const text = parseWhisperStdout(wp?.stdout);
		if (!text) {
			ctx.logService.warn(`[videoMedia] ASR: 转写无产出（exit=${wp?.exitCode}）⇒ 退回仅帧分析`);
			return undefined;
		}
		const clipped = text.length > MAX_TRANSCRIPT_CHARS ? text.slice(0, MAX_TRANSCRIPT_CHARS) : text;
		ctx.logService.info(`[videoMedia] ASR: 转写完成（${clipped.length} 字）`);
		return { text: clipped, kind: 'asr', chars: clipped.length };
	} catch (err) {
		ctx.logService.warn(`[videoMedia] ASR 异常（退回仅帧分析）：${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	} finally {
		if (wavPath) {
			try { await ctx.fileService.del(URI.file(wavPath)); } catch { /* best-effort */ }
		}
	}
}

/** 解析结果的一行诊断（工具回显用：让用户/模型知道用的是内置还是 PATH 里的二进制）。 */
export function describeToolchain(bins: IResolvedToolchain): string {
	return [bins.ffmpeg, bins.ffprobe, bins.ytdlp].map(describeResolvedBinary).join(' · ');
}
