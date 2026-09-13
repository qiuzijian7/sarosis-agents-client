/*──────────────────────────────────────────────────────────────
 * 视频 / 语音生成工具（video_generate、text_to_speech）
 *
 * 2026-09-11 补全：与 `drawio` / `session_search` / `vision_analyze` 同源的半成品。
 *
 * 这两个工具此前只有 bundled 定义（`isStub` → `listTools` 跳过 → **模型看不到**），
 * 而**底层能力早已完整实现**（本轮审计确认）：
 *   - `IModelProvider.generateVideo?` / `generateAudio?`（providers.ts）
 *   - `languageModelsBridge` 的扩展命令转发（`${vendor}.generateVideo/generateAudio`）
 *   - host 侧 RPC `videogen.generate` / `audiogen.generate`（agentStudioWebviewController）
 *   - 工作流画布节点 `Saros.ModelVideoGen` / `Saros.AudioGen`（providerExecutors）
 *   - 模型能力标记 `IModelInfo.supportsVideoGen` / `supportsAudioGen`
 *
 * 与已实现的 `image_generate`（imageGenTools.ts）**完全对称**，差异只有两点：
 *   1. **不落盘**：`IVideoGenResult.videos[].url` / `IAudioGenResult.audios[].url`
 *      约定为 **URL**（无 b64 字段）—— 视频/音频体积极大，本就不该内联进上下文；
 *      因此无需 mediaBackend，直接回传 URL 即可。
 *   2. 参数集不同（时长 / 分辨率 / 音色 / 语速等，见各工具 schema）。
 *──────────────────────────────────────────────────────────────*/

import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IModelProvider, IModelInfo } from '../../../common/providers.js';

export const VIDEO_GEN_TOOL_NAME = 'video_generate';
export const TEXT_TO_SPEECH_TOOL_NAME = 'text_to_speech';

/** 单次请求的输出上限（视频/音频生成较慢，给足时间但不过度）。 */
const VIDEO_TIMEOUT_HINT_MS = 10 * 60 * 1000;

export interface MediaGenToolContext {
	register: (descriptor: { definition: any; handler: any }) => void;
	logService: ILogService;
	/** 取当前注册的模型 provider 列表（`IAgentOSService.getModelProviders`）。 */
	getModelProviders: () => readonly IModelProvider[];
}

type CapabilityKey = 'supportsVideoGen' | 'supportsAudioGen';

/**
 * 按能力标记解析 provider / model。
 *
 * 优先级：① 显式 `provider_id` / `model_id` → ② 自动路由（第一个声明该能力
 * 且暴露对应方法的 provider）。
 *
 * 与 `image_generate` 的解析逻辑同构，但抽成共用函数 —— 视频/音频两个工具
 * 的解析规则完全一致，分头实现必然漂移（本仓高频的「修一半」模式）。
 */
async function resolveProviderModel(
	providers: readonly IModelProvider[],
	capability: CapabilityKey,
	providerMethod: 'generateVideo' | 'generateAudio',
	explicitProviderId: string | undefined,
	explicitModelId: string | undefined,
): Promise<{ provider: IModelProvider; modelId: string } | { error: string }> {
	let provider: IModelProvider | undefined = explicitProviderId
		? providers.find(p => p.id === explicitProviderId)
		: undefined;
	let modelId = explicitModelId;

	const supports = (m: IModelInfo) => m[capability] === true;

	if (!provider || !modelId) {
		for (const p of providers) {
			if (typeof (p as unknown as Record<string, unknown>)[providerMethod] !== 'function') { continue; }
			if (explicitProviderId && p.id !== explicitProviderId) { continue; }
			const models = await p.listModels().catch(() => []);
			const hit = models.find(supports);
			if (hit) {
				provider = p;
				modelId = modelId ?? hit.id;
				break;
			}
		}
	}

	if (!provider) {
		return {
			error: explicitProviderId
				? `provider "${explicitProviderId}" not found (or it does not support this generation type).`
				: 'no provider available for this generation type. Configure a model that supports it, or pass provider_id.',
		};
	}
	if (typeof (provider as unknown as Record<string, unknown>)[providerMethod] !== 'function') {
		return { error: `provider "${provider.id}" does not implement ${providerMethod}().` };
	}
	if (!modelId) {
		return { error: `provider "${provider.id}" exposes no model supporting this generation type.` };
	}
	return { provider, modelId };
}

function asString(v: unknown): string | undefined {
	return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function asPositiveNumber(v: unknown): number | undefined {
	const n = typeof v === 'number' ? v : Number(v);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function registerMediaGenTools(ctx: MediaGenToolContext): void {
	// ── video_generate ────────────────────────────────────────────────────
	ctx.register({
		definition: {
			name: VIDEO_GEN_TOOL_NAME,
			description: 'Generate a short video from a text prompt and/or a reference image using the configured video generation model. '
				+ 'The resulting video URL is returned and can be played/shared.\n\n'
				+ 'Parameters:\n'
				+ '- `prompt` (optional): what the video should show. May be omitted for pure image-to-video providers.\n'
				+ '- `image_url` (optional): first-frame / reference image (URL, data URL, or canvas snapshot ref) for image-to-video.\n'
				+ '- `duration` (optional): seconds (provider rounds to its nearest supported tier).\n'
				+ '- `resolution` (optional): provider-specific tier, e.g. "768P" / "2K".\n'
				+ '- `ratio` (optional): aspect ratio, e.g. "16:9".\n'
				+ '- `provider_id` / `model_id` (optional): override model selection.\n\n'
				+ 'At least one of `prompt` / `image_url` is required.\n'
				+ 'Model selection: explicit ids > first available model declaring video generation support.',
			inputSchema: {
				type: 'object',
				properties: {
					prompt: { type: 'string', description: 'What the video should show.' },
					image_url: { type: 'string', description: 'First-frame/reference image URL, data URL, or canvas snapshot ref (image-to-video).' },
					duration: { type: 'number', description: 'Video duration in seconds (provider rounds to its nearest tier).' },
					resolution: { type: 'string', description: 'Resolution tier, e.g. "768P" or "2K" (provider-specific).' },
					ratio: { type: 'string', description: 'Aspect ratio, e.g. "16:9".' },
					provider_id: { type: 'string', description: 'Optional explicit provider id.' },
					model_id: { type: 'string', description: 'Optional explicit model id.' },
				},
				required: [],
			},
			category: 'video',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
			const prompt = asString(args.prompt);
			const imageUrl = asString(args.image_url);
			if (!prompt && !imageUrl) {
				return [{ type: 'text', text: 'video_generate error: at least one of "prompt" or "image_url" is required.' }];
			}

			const resolved = await resolveProviderModel(
				ctx.getModelProviders(), 'supportsVideoGen', 'generateVideo',
				asString(args.provider_id), asString(args.model_id),
			);
			if ('error' in resolved) {
				return [{ type: 'text', text: `video_generate error: ${resolved.error}` }];
			}
			const { provider, modelId } = resolved;

			try {
				ctx.logService.info(`[video_generate] provider=${provider.id} model=${modelId} prompt.len=${prompt?.length ?? 0} img=${imageUrl ? 'yes' : 'no'}`);
				const result = await provider.generateVideo!({
					modelId,
					prompt,
					duration: asPositiveNumber(args.duration),
					resolution: asString(args.resolution),
					ratio: asString(args.ratio),
					imageInput: imageUrl,
				});
				if (signal?.aborted) {
					return [{ type: 'text', text: '[video_generate] cancelled.' }];
				}
				const urls = (result?.videos ?? []).map(v => v.url).filter((u): u is string => !!u);
				if (urls.length === 0) {
					return [{ type: 'text', text: 'video_generate: the provider returned no video URL.' }];
				}
				const lines = urls.map((u, i) => `  ${i + 1}. ${u}`).join('\n');
				return [{
					type: 'text',
					text: `[Video Generated] (model: ${modelId})\n${urls.length} video(s):\n${lines}\n\n`
						+ `Note: generation may take a while on the provider side; the URL above is the final asset.`,
				}];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.logService.error(`[video_generate] failed: ${msg}`);
				return [{ type: 'text', text: `video_generate error: ${msg}` }];
			}
		},
	});

	// ── text_to_speech ────────────────────────────────────────────────────
	ctx.register({
		definition: {
			name: TEXT_TO_SPEECH_TOOL_NAME,
			description: 'Synthesize speech (or music/audio) from text using the configured audio generation model, and return the audio URL.\n\n'
				+ 'Parameters:\n'
				+ '- `text` (required): the text to speak (for music providers this is the style/mood prompt).\n'
				+ '- `voice` (optional): voice id (provider-specific; omitted = provider default voice).\n'
				+ '- `speed` (optional): speaking rate, 1 = normal.\n'
				+ '- `emotion` (optional): emotion hint (provider-specific, e.g. happy/sad/angry).\n'
				+ '- `lyrics` (optional): lyrics for music providers (empty = instrumental).\n'
				+ '- `provider_id` / `model_id` (optional): override model selection.\n\n'
				+ 'Model selection: explicit ids > first available model declaring audio generation support.',
			inputSchema: {
				type: 'object',
				properties: {
					text: { type: 'string', description: 'Text to synthesize (style/mood prompt for music providers).' },
					voice: { type: 'string', description: 'Voice id (provider-specific; omitted = provider default).' },
					speed: { type: 'number', description: 'Speaking rate, 1 = normal (provider range varies, e.g. MiniMax 0.5–2).' },
					emotion: { type: 'string', description: 'Emotion hint (provider-specific, e.g. happy/sad/angry).' },
					lyrics: { type: 'string', description: 'Lyrics for music providers (empty = instrumental).' },
					provider_id: { type: 'string', description: 'Optional explicit provider id.' },
					model_id: { type: 'string', description: 'Optional explicit model id.' },
				},
				required: ['text'],
			},
			category: 'tts',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, signal?: AbortSignal) => {
			const text = asString(args.text);
			if (!text) {
				return [{ type: 'text', text: 'text_to_speech error: "text" is required and cannot be empty.' }];
			}

			const resolved = await resolveProviderModel(
				ctx.getModelProviders(), 'supportsAudioGen', 'generateAudio',
				asString(args.provider_id), asString(args.model_id),
			);
			if ('error' in resolved) {
				return [{ type: 'text', text: `text_to_speech error: ${resolved.error}` }];
			}
			const { provider, modelId } = resolved;

			try {
				ctx.logService.info(`[text_to_speech] provider=${provider.id} model=${modelId} text.len=${text.length}`);
				const result = await provider.generateAudio!({
					modelId,
					prompt: text,
					lyrics: asString(args.lyrics),
					voiceId: asString(args.voice),
					speed: asPositiveNumber(args.speed),
					emotion: asString(args.emotion),
				});
				if (signal?.aborted) {
					return [{ type: 'text', text: '[text_to_speech] cancelled.' }];
				}
				const audios = (result?.audios ?? []).filter(a => !!a.url);
				if (audios.length === 0) {
					return [{ type: 'text', text: 'text_to_speech: the provider returned no audio URL.' }];
				}
				const lines = audios
					.map((a, i) => `  ${i + 1}. ${a.url}${a.duration ? ` (${a.duration}s)` : ''}${a.format ? ` [${a.format}]` : ''}`)
					.join('\n');
				return [{
					type: 'text',
					text: `[Audio Generated] (model: ${modelId})\n${audios.length} audio file(s):\n${lines}`,
				}];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.logService.error(`[text_to_speech] failed: ${msg}`);
				return [{ type: 'text', text: `text_to_speech error: ${msg}` }];
			}
		},
	});

	ctx.logService.info('[MediaGenTools] Registered video_generate and text_to_speech tools');
}

/** 供 UI 提示使用的最长等待建议（视频生成较慢）。 */
export const MEDIA_GEN_TIMEOUT_HINT_MS = VIDEO_TIMEOUT_HINT_MS;
