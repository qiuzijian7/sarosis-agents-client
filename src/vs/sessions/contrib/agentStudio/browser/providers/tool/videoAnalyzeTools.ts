/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `video_analyze` —— **一次调用看懂一段视频**（★ 2026-09-24 实现真 handler）。
 *
 * ## 为什么需要
 *
 * `video_analyze` 此前与 drawio / session_search / vision_analyze 同源：**只有 bundled 定义、
 * 没有 handler**（`common/bundled-tools/bundledTools.ts` 的 `category: 'video'`），
 * 注册时被判为 stub ⇒ `listTools` 跳过 ⇒ 模型**根本看不到**这个工具。
 * 而其定义承诺的能力（"Extract frames and understand video content"）恰恰是视频类任务最缺的一环：
 *   · `extract_video_frames` 只给**图片路径**，要么模型再逐张调 `vision_analyze`（N 次往返、慢且贵），
 *     要么只能看着路径猜；
 *   · 字幕（口播内容/机制说明）此前**只有 URL 导入链路**才拿得到（`kbVideoFetch`），
 *     普通对话里完全缺失 ⇒ 模型对「玩法怎么讲」只能凭空发挥。
 *
 * ## 与 `extract_video_frames` 的分工（互补，不替代）
 *
 * | 工具 | 产物 | 何时用 |
 * |---|---|---|
 * | `extract_video_frames` | 帧图**文件路径** + 时间点 | 要把帧当**证据**落进笔记、或要针对某一帧追问细节 |
 * | `video_analyze` | **文字分析**（含帧画面 + 字幕，标注时间点） | 想一次拿到「这段视频讲了什么/画面是什么样」 |
 *
 * 两者共用 `videoMediaPipeline.ts`（依赖探测/下载/取时长/抽帧/清理、字幕抓取），
 * 模型选择与 `vision_analyze` 共用 `visionModelSelect.ts`（避免「看图用 A 模型、看视频用 B 模型」）。
 *
 * ## 证据纪律（与本仓 `kb-game-teardown` 技能同一立场）
 *
 * 抽帧是**采样**：没抽到的时段等于没看过。故提示词明确要求
 * 「只基于给出的帧与字幕」「材料没覆盖就说无法判断」「结论挂 [帧 mm:ss]/[字幕] 标记」——
 * 否则模型会用「这类游戏一般都…」把采样缺口用常识填掉（这正是本工具要防的失败模式）。
 */

import * as path from '../../../../../../base/common/path.js';
import { URI } from '../../../../../../base/common/uri.js';
import type { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import type { IModelProvider, IChatMessage, IChatImagePart } from '../../../common/providers.js';
import { ToolSecurityLevel } from '../../../common/providers.js';
import { CAP_MEDIA_FFMPEG } from './toolAvailabilityNotes.js';
import type { IToolResultContent } from '../../../common/providers.js';
import {
	clampInt, sanitizeForShell, slugifySource, isRemoteSource, formatMMSS,
	DEFAULT_MAX_WIDTH,
	probeMediaToolchain, prepareVideoAndFrames, fetchTranscript, transcribeWithWhisper, describeToolchain,
	type IVideoMediaContext, type ITranscript,
} from './videoMediaPipeline.js';
import { selectVisionModel, NO_VISION_MODEL_MESSAGE } from './visionModelSelect.js';
import { readLocalImageAsBase64 } from './visionAnalyzeTools.js';

export const VIDEO_ANALYZE_TOOL_NAME = 'video_analyze';

/** 默认抽几帧给模型看（比「交给人看」更克制：多图会显著抬高请求体积与成本）。 */
const ANALYZE_DEFAULT_FRAMES = 6;
/** 分析模式的帧数上限（帧图 base64 会整体进请求体，不能再按 24 张放开）。 */
const ANALYZE_MAX_FRAMES = 12;
/** 单次分析的输出上限（防止模型长篇输出）。 */
const MAX_OUTPUT_TOKENS = 3000;
/** 多图请求体的总体上限（base64 字符数）：超限时明确报错，而不是发一个可能被网关 413 的请求。 */
const MAX_TOTAL_BASE64_CHARS = 16 * 1024 * 1024;

export interface IVideoAnalyzeToolContext extends IVideoMediaContext {
	configurationService?: IConfigurationService;
	/** 取当前注册的模型 provider 列表（`IAgentOSService.getModelProviders`）。 */
	getModelProviders: () => readonly IModelProvider[];
	/** 「知识库专家」配置的模型（多模态的默认来源，与 vision_analyze 同一套语义）。 */
	getKbExpertModel?: () => { providerId: string; modelId: string } | undefined;
}

// ─── 纯函数（单测覆盖）──────────────────────────────────────────────────────

export interface IAnalysisPromptOptions {
	readonly query: string;
	readonly frameCount: number;
	readonly startSec: number;
	readonly spanSec: number;
	readonly videoDurationSec?: number;
	readonly hasTranscript: boolean;
	/**
	 * 字幕来源（`hasTranscript` 为 true 时给）：`manual` 人工上传 / `auto` 平台自动生成 /
	 * `asr` 本地 ASR 转写（whisper，2026-09-25）。后两者都要在结论里注明可能不准。
	 */
	readonly transcriptKind?: 'auto' | 'manual' | 'asr';
}

/** 字幕来源的人读标注（提示词与素材清单共用，避免两处措辞漂移）。 */
const TRANSCRIPT_KIND_LABEL: Record<'auto' | 'manual' | 'asr', string> = {
	manual: '人工上传',
	auto: '平台**自动**生成，可能有错别字',
	asr: '本地 ASR 转写（whisper，离线），可能有错别字/简繁混排',
};

/**
 * 分析提示词（纯函数，便于逐条钉住"防编造"要求）。
 *
 * 语言：用中文写指令，但明确要求「用与用户问题相同的语言回答」——
 * 产品主要面向中文用户，而 `query` 可能是英文。
 */
export function buildAnalysisPrompt(o: IAnalysisPromptOptions): string {
	const duration = o.videoDurationSec !== undefined ? formatMMSS(o.videoDurationSec) : '未知';
	const lines: string[] = [
		'你要基于下面给出的材料，回答关于这段视频的问题。',
		'',
		'【你能拿到的全部材料】',
		`· 抽帧：${o.frameCount} 张静止画面，覆盖 ${formatMMSS(o.startSec)}–${formatMMSS(o.startSec + o.spanSec)}`
			+ `（视频总时长 ${duration}）；每张图前一行标注了它的时间点。`,
		o.hasTranscript
			? `· 字幕：完整口播文本（${TRANSCRIPT_KIND_LABEL[o.transcriptKind ?? 'manual']}），附在最后。`
			// 「没有」也要说清为什么没有：无字幕轨 + 本地 ASR 兜底也落空（whisper 缺失/失败）
			// —— 否则模型/用户无法区分「视频本来就没人说话」与「能力没到位」。
			: '· 字幕：**没有**（该视频无字幕轨，且本地 ASR 不可用或转写失败）—— 口播内容不可知。',
		'',
		'【必须遵守的证据纪律】',
		'1. 只依据上面的帧与字幕作答；**材料没覆盖的部分，明确写「无法判断」**，并说明需要什么材料才能确认；',
		'2. 画面结论必须挂时间点标记 `[帧 mm:ss]`；口播内容挂 `[字幕]`（自动字幕/ASR 转写要注明可能不准）；',
		'3. 推断必须写明依据（如「因为字幕提到 X，所以推断 Y」），并标 `[推断]`；',
		'4. **禁止**用「这类视频一般…」的常识填补空缺；**禁止**描述你没看到的时段或镜头；',
		'5. 注意：抽帧是**采样**，帧与帧之间的过程（连续动作/音乐/转场）你并没有看到。',
		'',
		'【用户的问题】',
		o.query,
		'',
		'（用与上面问题相同的语言作答；先给结论，再给证据。）',
	];
	return lines.join('\n');
}

export interface IAnalyzeFrame {
	readonly label: string;         // 形如 `帧 1 @ 00:00`
	readonly data: string;          // base64（不含前缀）
	readonly mimeType: IChatImagePart['mimeType'];
}

/**
 * 组装多模态消息的 contentParts：`说明 → (帧标注, 图) ×N → 字幕`。
 *
 * ⚠ 顺序**必须**是「图前紧跟它的时间点标注」：三个适配器（OpenAI / Anthropic / Gemini）
 *   都按 `contentParts` 原序转换（`messageFormatConverter`），交错排列才能让模型把
 *   具体画面与时间点对上；若把所有文字并到最前，模型只能靠"大概第几张"猜时间点。
 */
export function buildAnalyzeContentParts(o: {
	prompt: string;
	frames: readonly IAnalyzeFrame[];
	transcript?: string;
}): IChatMessage['contentParts'] {
	const parts: NonNullable<IChatMessage['contentParts']> = [{ type: 'text', text: o.prompt }];
	for (const f of o.frames) {
		parts.push({ type: 'text', text: `[${f.label}]` });
		parts.push({ type: 'image', data: f.data, mimeType: f.mimeType });
	}
	if (o.transcript) {
		parts.push({ type: 'text', text: `[以下为字幕全文]\n${o.transcript}` });
	}
	return parts;
}

/** 收尾素材清单（回给模型的文本块，让它知道证据都在哪、哪些维度缺料）。 */
export function buildEvidenceNote(o: {
	frames: readonly string[];
	frameTimesSec: readonly number[];
	outDir: string;
	transcript?: ITranscript;
	toolchain: string;
	videoDurationSec?: number;
	title?: string;
	uploader?: string;
}): string {
	const lines: string[] = ['', '── 素材 ──'];
	if (o.title) { lines.push(`· 视频：${o.title}${o.uploader ? `（${o.uploader}）` : ''}`); }
	o.frames.forEach((f, i) => {
		const t = o.frameTimesSec[i];
		lines.push(`· ${f}  @ ${t !== undefined ? formatMMSS(t) : '?'}`);
	});
	lines.push(`· 产物目录：${o.outDir}`);
	lines.push(o.transcript
		? `· 字幕：${o.transcript.chars} 字（${TRANSCRIPT_KIND_LABEL[o.transcript.kind]}）`
		: '· 字幕：无（无字幕轨且本地 ASR 不可用/失败 ⇒ 口播内容不可知）');
	lines.push(`· 工具链：${o.toolchain}`);
	lines.push('· 帧图已落盘，可再用 `vision_analyze` 针对某一帧追问细节。');
	return lines.join('\n');
}

// ─── 注册 ────────────────────────────────────────────────────────────────────

export function registerVideoAnalyzeTools(ctx: IVideoAnalyzeToolContext): void {
	const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];

	ctx.register({
		definition: {
			name: VIDEO_ANALYZE_TOOL_NAME,
			description: [
				'分析一段视频并回答关于它的问题（**一次调用**完成：抽帧 + 字幕/口播转写 + 多模态模型给结论）。',
				'输入 http(s) 视频链接（抖音/小红书/B站/YouTube…）或本地视频文件路径。',
				'ffmpeg / yt-dlp / whisper **随 VsSaros 自带**，正常情况下无需用户安装。',
				'',
				'**口播内容的正确来源是音轨，不是画面**：有字幕轨用字幕轨；没有字幕轨（抖音/小红书/快手教程的常态）',
				'自动走**本地 ASR（whisper）转写口播全文** —— 不要手工 yt-dlp 下载 + ffmpeg 循环抽帧 + 逐张 vision_analyze',
				'（那条路没有 ASR，且慢数倍；2026-09-25 用户明确纠正过这个错误流程）。',
				'',
				'返回：带时间点标记的分析文本 + 素材清单（帧图路径与时间点、字幕/转写字数与来源）。',
				'证据纪律已内置：只依据抽出的帧与字幕/转写作答，覆盖不到的维度会明确写「无法判断」。',
				'',
				`对比 \`extract_video_frames\`（只给帧图路径，需你再逐张调 vision_analyze）：`
					+ `想**一次拿到理解**用本工具（默认 ${ANALYZE_DEFAULT_FRAMES} 帧，最多 ${ANALYZE_MAX_FRAMES}）；`,
				'想把帧当**证据**落进笔记、或要针对单帧追问细节，用 extract_video_frames + vision_analyze。',
			].join('\n'),
			inputSchema: {
				type: 'object',
				properties: {
					video_url: { type: 'string', description: 'http(s) 视频链接，或本地视频文件路径' },
					query: { type: 'string', description: '要回答的问题（如「这游戏的战斗循环是怎么设计的」「这段教程讲了哪几步」）' },
					frames: { type: 'number', description: `抽帧数量（默认 ${ANALYZE_DEFAULT_FRAMES}，最多 ${ANALYZE_MAX_FRAMES}）` },
					startSec: { type: 'number', description: '从第几秒开始抽（默认 0）' },
					durationSec: { type: 'number', description: '采样跨度秒数（默认：整段；拿不到时长时 60）' },
					maxWidth: { type: 'number', description: `帧图最大宽度（默认 ${DEFAULT_MAX_WIDTH}；调小可降低请求体积）` },
					outDir: { type: 'string', description: '产物目录（帧图落盘处；默认 ~/.vssaros/tmp/video-analyze/<名字>-<时间戳>）' },
					keepVideo: { type: 'boolean', description: '保留下载的视频文件（默认 false：分析完即删）' },
					withTranscript: { type: 'boolean', description: '是否抓字幕（默认 true；仅远端链接有效）' },
				},
				required: ['video_url', 'query'],
			},
			category: 'video',
			source: 'saros.builtin-tools',
			// 拉取外部内容 + 落盘 + 把画面发给外部模型 ⇒ 与 vision_analyze / extract_video_frames 同级
			securityLevel: ToolSecurityLevel.Cautious,
			// ★ 2026-09-24（P1-4）：同样依赖 ffmpeg —— 缺依赖时标注而非隐藏（理由见 toolAvailabilityNotes.ts）。
			//   远端链接还额外需要 yt-dlp，但那属于"输入形态"限制（本地文件仍可用）⇒ 只在描述里由
			//   工具文案说明，不当作硬门控，否则本地文件场景会被误标为不可用。
			availability: [{ type: 'custom', condition: CAP_MEDIA_FFMPEG }],
		},

		handler: async (args, signal, agentId) => {
			const source = sanitizeForShell(String(args['video_url'] ?? args['source'] ?? ''));
			const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
			if (!source) { return text('缺少 video_url：请给出 http(s) 视频链接或本地视频文件路径。'); }
			if (!query) { return text(`缺少 query：请说明要问这段视频的什么问题（${VIDEO_ANALYZE_TOOL_NAME} 需要有明确的分析目标）。`); }

			const frames = clampInt(args['frames'], 1, ANALYZE_MAX_FRAMES, ANALYZE_DEFAULT_FRAMES);
			const startSec = Math.max(0, Math.trunc(Number(args['startSec']) || 0));
			const requestedSpan = Number(args['durationSec']);
			const durationSec = Number.isFinite(requestedSpan) && requestedSpan > 0 ? Math.trunc(requestedSpan) : undefined;
			const maxWidth = clampInt(args['maxWidth'], 320, 1920, DEFAULT_MAX_WIDTH);
			const keepVideo = args['keepVideo'] === true;
			const withTranscript = args['withTranscript'] !== false;
			const remote = isRemoteSource(source);

			// ① 依赖探测
			const probe = await probeMediaToolchain(ctx, { remote });
			if (probe.status !== 'ok' || !probe.bins) { return text(probe.message ?? '媒体工具链不可用。'); }

			// ② 产物目录（沙箱校验；默认落 ~/.vssaros/tmp，不污染工作区）
			const requestedOut = typeof args['outDir'] === 'string' && args['outDir'].trim()
				? String(args['outDir']).trim()
				: path.join(ctx.defaultOutRoot, 'video-analyze', `${slugifySource(source)}-${Date.now()}`);
			let outDir: string;
			try {
				outDir = await ctx.resolveAndCheckWorkspacePath(agentId, requestedOut);
			} catch (err) {
				return text(`产物目录不可写：${err instanceof Error ? err.message : String(err)}\n请换一个位于工作区或知识库内的目录。`);
			}
			await ctx.fileService.createFolder(URI.file(outDir));

			// ③ 取视频 + 抽帧（带元信息：标题/作者给模型当上下文）
			const result = await prepareVideoAndFrames(ctx, probe.bins, {
				source, agentId, frames, startSec, durationSec, maxWidth, outDir, keepVideo,
				withMetadata: remote,
			});
			if (!result.ok) { return text(result.message); }
			const prep = result.prepared;

			try {
				// 取消检查①（2026-09-25）：下载+抽帧已是分钟级段，此后若已 abort（守卫超时/
				// 用户停止），别再烧 ASR 与模型的钱。whisper/runCommand 不响应 signal，
				// 只能在步间止步 —— 实测 60s abort 后 whisper 仍白跑了 3.5 分钟才收尾。
				if (signal?.aborted) {
					await prep.cleanup();
					return text('[Video Analysis] cancelled before completion.');
				}

				// ④ 字幕（best-effort；失败不影响分析，但要在结果里如实说明"没有"）。
				//    顺序：平台字幕轨（最准）→ 本地 ASR（whisper，2026-09-25）。
				//    ASR 对本地文件同样有效（本地文件本来就没有"平台字幕"一说）；
				//    远端无字幕轨（小红书/抖音教程的常态）⇒ ASR 是口播内容的唯一来源。
				let transcript = withTranscript && remote
					? await fetchTranscript(ctx, probe.bins, source, prep.workDir)
					: undefined;
				if (!transcript && withTranscript) {
					transcript = await transcribeWithWhisper(
						ctx, probe.bins.ffmpeg.command, prep.videoPath, prep.workDir ?? outDir,
					);
				}

				// 取消检查②：ASR（分钟级）之后、模型调用之前。
				if (signal?.aborted) {
					await prep.cleanup();
					return text('[Video Analysis] cancelled before completion.');
				}

				// ⑤ 模型选择（与 vision_analyze 同一套：Vision 设置 > 知识库专家 > 自动路由）
				const selected = await selectVisionModel(ctx);
				if (!selected) {
					// 没有多模态模型时不静默失败：把**已经拿到手**的素材交回给 agent，
					// 让它自己用 vision_analyze 逐帧看（能力降级，但结果仍有价值）。
					await prep.cleanup();
					return text([
						`${VIDEO_ANALYZE_TOOL_NAME}: ${NO_VISION_MODEL_MESSAGE}`,
						'',
						`不过帧已经抽好了（${prep.frames.length} 张），你可以用 vision_analyze 逐张查看：`,
						...prep.frames.map((f, i) => `· ${f}  @ ${formatMMSS(prep.frameTimesSec[i])}`),
						transcript ? `· 字幕已抓取（${transcript.chars} 字），但当前无模型可读 —— 需要多模态模型才能分析。` : '· 字幕：无。',
					].join('\n'));
				}

				// ⑥ 读帧为 base64（复用 file_read 同源护栏的读图工具函数：只认图片扩展名且有体积上限）
				const images: IAnalyzeFrame[] = [];
				let totalChars = 0;
				for (let i = 0; i < prep.frames.length; i++) {
					const framePath = prep.frames[i];
					try {
						const parsed = await readLocalImageAsBase64(ctx.fileService, framePath);
						totalChars += parsed.data.length;
						images.push({ label: `帧 ${i + 1} @ ${formatMMSS(prep.frameTimesSec[i])}`, data: parsed.data, mimeType: parsed.mimeType });
					} catch (err) {
						ctx.logService.warn(`[${VIDEO_ANALYZE_TOOL_NAME}] 读取帧图失败（跳过该帧）：${framePath} — ${err instanceof Error ? err.message : String(err)}`);
					}
				}
				if (!images.length) {
					await prep.cleanup();
					return text(`抽帧成功但读图失败（${prep.frames.length} 张都无法读取）⇒ 无法分析。请检查帧图是否被安全软件拦截。`);
				}
				if (totalChars > MAX_TOTAL_BASE64_CHARS) {
					await prep.cleanup();
					return text([
						`图像总量过大（${Math.round(totalChars / 1024 / 1024)}MB base64，上限 ${MAX_TOTAL_BASE64_CHARS / 1024 / 1024}MB）⇒ 未发起请求。`,
						`请减少 frames（当前 ${images.length}）或调小 maxWidth（当前 ${maxWidth}）后重试。`,
						'帧图已落盘，也可改用 extract_video_frames + vision_analyze 逐张查看。',
					].join('\n'));
				}

				// ⑦ 调用多模态模型
				const prompt = buildAnalysisPrompt({
					query,
					frameCount: images.length,
					startSec: prep.startSec,
					spanSec: prep.spanSec,
					videoDurationSec: prep.videoDurationSec,
					hasTranscript: !!transcript,
					transcriptKind: transcript?.kind,
				});
				const message: IChatMessage = {
					role: 'user',
					content: prompt,
					contentParts: buildAnalyzeContentParts({ prompt, frames: images, transcript: transcript?.text }),
				};

				const evidence = buildEvidenceNote({
					frames: prep.frames, frameTimesSec: prep.frameTimesSec, outDir,
					transcript, toolchain: describeToolchain(probe.bins),
					videoDurationSec: prep.videoDurationSec, title: prep.title, uploader: prep.uploader,
				});
				const details = {
					frames: prep.frames.slice(), outDir, startSec: prep.startSec, spanSec: prep.spanSec,
					videoDurationSec: prep.videoDurationSec, model: selected.modelId,
					transcriptChars: transcript?.chars ?? 0,
					toolchain: [probe.bins.ffmpeg, probe.bins.ffprobe, probe.bins.ytdlp]
						.map(b => ({ name: b.name, source: b.source, path: b.path })),
				};

				try {
					ctx.logService.info(`[${VIDEO_ANALYZE_TOOL_NAME}] provider=${selected.provider.id} model=${selected.modelId} frames=${images.length} b64=${Math.round(totalChars / 1024)}KB transcript=${transcript?.chars ?? 0}字`);
					let out = '';
					let sawError: string | undefined;
					for await (const delta of selected.provider.chat(selected.modelId, [message], { maxTokens: MAX_OUTPUT_TOKENS })) {
						if (signal?.aborted) { return text(`[Video Analysis] cancelled before completion.${evidence}`); }
						// 只收正文；thinking 属推理过程，不作为答案回给模型。
						if (delta.type === 'text' && delta.content) { out += delta.content; }
						else if (delta.type === 'error') { sawError = delta.error ?? 'unknown error'; }
					}
					if (sawError && !out) { return text(`${VIDEO_ANALYZE_TOOL_NAME} error from provider: ${sawError}${evidence}`); }
					if (!out.trim()) { return text(`${VIDEO_ANALYZE_TOOL_NAME}: the model returned no text for this video.${evidence}`); }
					return {
						content: text(`[Video Analysis] (model: ${selected.modelId})\n\n${out.trim()}${evidence}`),
						details,
					};
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					ctx.logService.error(`[${VIDEO_ANALYZE_TOOL_NAME}] call failed: ${msg}`);
					return text(`${VIDEO_ANALYZE_TOOL_NAME} error: ${msg}${evidence}`);
				}
			} finally {
				// ⑧ 分析完删除下载的视频（默认不囤视频；keepVideo 可关掉）
				await prep.cleanup();
			}
		},
	});

	ctx.logService.info(`[VideoAnalyzeTools] Registered ${VIDEO_ANALYZE_TOOL_NAME} tool`);
}
