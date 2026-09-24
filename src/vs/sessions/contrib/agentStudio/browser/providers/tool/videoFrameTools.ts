/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `extract_video_frames` —— 从视频抽取关键帧为 PNG（★ 2026-09-24）。
 *
 * ## 为什么需要这个工具
 *
 * 产品此前的视频链路**从不下载视频本体**（`knowledge/kbVideoFetch.ts` 只取元信息与字幕），
 * 也没有任何抽帧能力 ⇒ 任何依赖「画面」的任务（典型：技能 `kb-game-teardown` 拆解某游戏的
 * UI / 美术 / 战斗表现）都只能看到封面那一张静止图，模型于是倾向于**编造**画面细节。
 * 本工具补齐这一段：**下载（可只取片段）→ ffmpeg 等间隔抽帧 → 落盘 PNG**，
 * 产物交给 `vision_analyze` 逐张读（该工具一次只接受一张图）。
 *
 * ⚠ 2026-09-24 起**执行核已抽到 `videoMediaPipeline.ts`**（与 `video_analyze` 共用同一份
 *   依赖探测/下载/取时长/抽帧/清理），本文件只保留「注册 + 面向 agent 的回显格式」。
 *   纯函数（命令拼装等）在管线模块里，这里**原样再导出**以保持既有 import 面稳定
 *   （单测与本文件的调用方都从本路径取）。
 *
 * ## 依赖（随包自带，正常无需用户安装）
 *
 * · **ffmpeg 必需**（`ffprobe` 随 ffmpeg 分发）；
 * · **yt-dlp 仅在 source 为 http(s) 时必需** —— 本地视频文件路径不需要它；
 * · 解析顺序见 `knowledge/mediaBinaries.ts`：环境变量覆盖 → 随包内置
 *   （`<install>/resources/saros/bin/`）→ dev 仓库 `build/saros/bin/` → PATH。
 */

import { URI } from '../../../../../../base/common/uri.js';
import * as path from '../../../../../../base/common/path.js';
import { ToolSecurityLevel } from '../../../common/providers.js';
import { CAP_MEDIA_FFMPEG } from './toolAvailabilityNotes.js';
import type { IToolResultContent } from '../../../common/providers.js';
import {
	clampInt, sanitizeForShell, slugifySource, isRemoteSource, formatMMSS,
	MAX_FRAMES, DEFAULT_FRAMES, DEFAULT_MAX_WIDTH,
	probeMediaToolchain, prepareVideoAndFrames, describeToolchain,
	type IVideoMediaContext,
} from './videoMediaPipeline.js';

// ─── 对外导出（原样转出管线模块，保持既有调用/测试的 import 面）─────────────
export {
	sanitizeForShell, clampInt, slugifySource, isRemoteSource, parseDurationPrint, computeSpanSec,
	buildYtDlpDownloadArgs, buildYtDlpDurationArgs, buildYtDlpInfoArgs, buildYtDlpSubtitleArgs,
	buildFfprobeDurationArgs, buildFfmpegArgs, frameTimestampSec, formatMMSS, buildCommand,
	parseSubtitleToText, parseInfoPrint,
	MAX_FRAMES, DEFAULT_FRAMES, DEFAULT_MAX_WIDTH,
	FFMPEG_HINT, YTDLP_HINT, NO_CHANNEL_HINT,
	probeMediaToolchain, prepareVideoAndFrames, fetchTranscript, resolveToolchain, describeToolchain,
} from './videoMediaPipeline.js';
export type {
	IPreparedVideo, IPrepareFramesOptions, IResolvedToolchain, ITranscript, IVideoInfo,
} from './videoMediaPipeline.js';

/**
 * 抽帧工具的上下文（= 媒体管线上下文，历史命名保留）。
 *
 * `appRoot` / `mediaBinaryRuntime` / `resolveBinary` 供**二进制解析**使用
 * （见 `knowledge/mediaBinaries.ts`）；不传时退化为「裸命令名走 PATH」= 改动前的行为。
 */
export type IVideoFrameToolContext = IVideoMediaContext;

// ─── 注册 ────────────────────────────────────────────────────────────────────

export function registerVideoFrameTools(ctx: IVideoFrameToolContext): void {
	const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];

	ctx.register({
		definition: {
			name: 'extract_video_frames',
			description: [
				'从视频抽取若干**关键帧图片**（PNG），供 vision_analyze 逐张查看。',
				'支持 http(s) 视频链接（用 yt-dlp 下载）或本地视频文件路径（用 ffmpeg 直接抽）。',
				'ffmpeg / yt-dlp **随 VsSaros 自带**（安装目录 resources/saros/bin/），正常情况下无需用户安装；',
				'解析顺序：环境变量 FFMPEG_PATH/YTDLP_PATH → 随包内置 → PATH。',
				'产物落盘在一个目录里，返回每张帧的路径与时间点；默认抽 6 张、限宽 1280、抽完删除下载的视频。',
				'用途：需要「看到」视频画面时（游戏拆解、UI/美术/战斗表现分析、教程步骤核对），',
				'先用本工具抽帧，再用 vision_analyze 逐张提问 —— 不要凭空猜测视频画面。',
				'若你要的是「一次调用就拿到对视频内容的理解」，用 `video_analyze`（它 = 抽帧 + 字幕 + 多模态模型直接给结论）。',
			].join('\n'),
			inputSchema: {
				type: 'object',
				properties: {
					source: { type: 'string', description: 'http(s) 视频链接，或本地视频文件路径' },
					frames: { type: 'number', description: `抽帧数量（默认 ${DEFAULT_FRAMES}，最多 ${MAX_FRAMES}）` },
					startSec: { type: 'number', description: '从第几秒开始抽（默认 0）' },
					durationSec: { type: 'number', description: '采样跨度秒数（默认：整段；拿不到时长时 60）' },
					maxWidth: { type: 'number', description: `帧图最大宽度（默认 ${DEFAULT_MAX_WIDTH}）` },
					outDir: { type: 'string', description: '产物目录（默认 ~/.vssaros/tmp/video-frames/<名字>-<时间戳>）' },
					keepVideo: { type: 'boolean', description: '保留下载的视频文件（默认 false：抽完即删）' },
				},
				required: ['source'],
			},
			category: 'video',
			source: 'builtin',
			// 外部内容拉取 + 落盘，但不写远端、不删用户文件 ⇒ 与 web_extract 同级（Cautious）
			securityLevel: ToolSecurityLevel.Cautious,
			// ★ 2026-09-24（P1-4）：依赖 ffmpeg（本地与远端都要用它抽帧）。缺依赖时**不隐藏**工具，
			//   而是在描述里标注"当前不可用 + 怎么装"（见 toolAvailabilityNotes.ts 头注释）。
			availability: [{ type: 'custom', condition: CAP_MEDIA_FFMPEG }],
		},
		handler: async (args, _signal, agentId) => {
			const source = sanitizeForShell(String(args['source'] ?? ''));
			if (!source) { return text('缺少 source：请给出 http(s) 视频链接或本地视频文件路径。'); }

			const frames = clampInt(args['frames'], 1, MAX_FRAMES, DEFAULT_FRAMES);
			const startSec = Math.max(0, Math.trunc(Number(args['startSec']) || 0));
			const requestedSpan = Number(args['durationSec']);
			const durationSec = Number.isFinite(requestedSpan) && requestedSpan > 0 ? Math.trunc(requestedSpan) : undefined;
			const maxWidth = clampInt(args['maxWidth'], 320, 1920, DEFAULT_MAX_WIDTH);
			const keepVideo = args['keepVideo'] === true;
			const remote = isRemoteSource(source);

			// ① 依赖探测（先给可执行的指引，再去谈能不能抽帧）
			const probe = await probeMediaToolchain(ctx, { remote });
			if (probe.status !== 'ok' || !probe.bins) { return text(probe.message ?? '媒体工具链不可用。'); }

			// ② 确定产物目录（走沙箱校验；默认落在 ~/.vssaros/tmp 下，不污染用户工作区）
			const requestedOut = typeof args['outDir'] === 'string' && args['outDir'].trim()
				? String(args['outDir']).trim()
				: path.join(ctx.defaultOutRoot, 'video-frames', `${slugifySource(source)}-${Date.now()}`);
			let outDir: string;
			try {
				outDir = await ctx.resolveAndCheckWorkspacePath(agentId, requestedOut);
			} catch (err) {
				return text(`产物目录不可写：${err instanceof Error ? err.message : String(err)}\n请换一个位于工作区或知识库内的目录。`);
			}
			await ctx.fileService.createFolder(URI.file(outDir));

			// ③ 取视频 + 抽帧（执行核在管线模块；失败信息已含可操作指引）
			const result = await prepareVideoAndFrames(ctx, probe.bins, {
				source, agentId, frames, startSec, durationSec, maxWidth, outDir, keepVideo,
			});
			if (!result.ok) { return text(result.message); }
			const prep = result.prepared;

			// ④ 回显（含时间点，供报告里写 [帧 03:12] 这类证据标记）
			const durationNote = prep.videoDurationSec !== undefined ? `${formatMMSS(prep.videoDurationSec)}` : '未知';
			const lines = prep.frames.map((f, i) => `· ${f}  @ ${formatMMSS(prep.frameTimesSec[i])}`);
			// ★ 抽完即删下载的视频（默认不囤视频；keepVideo 可关掉）—— 必须在 return 之前完成，
			//   否则调用方（或测试）会在视频仍占盘时就看到「已清理」的假象。
			await prep.cleanup();
			return {
				content: text([
					`已从视频抽取 ${prep.frames.length} 帧（视频时长 ${durationNote}，`
						+ `采样区间 ${formatMMSS(prep.startSec)}–${formatMMSS(prep.startSec + prep.spanSec)}，宽度 ≤${maxWidth}）。`,
					'',
					...lines,
					'',
					`工具链：${describeToolchain(probe.bins)}`,
					'',
					'下一步：用 `vision_analyze` **逐张**读这些文件（一次一张）—— 看画面得出的结论要标注时间点，',
					'不要把没看到的画面写进结论。若要一次拿到整体理解（含口播字幕），改用 `video_analyze`。',
				].join('\n')),
				details: {
					frames: prep.frames.slice(),
					outDir, startSec: prep.startSec, spanSec: prep.spanSec,
					videoDurationSec: prep.videoDurationSec,
					toolchain: [probe.bins.ffmpeg, probe.bins.ffprobe, probe.bins.ytdlp]
						.map(b => ({ name: b.name, source: b.source, path: b.path })),
				},
			};
		},
	});
}
