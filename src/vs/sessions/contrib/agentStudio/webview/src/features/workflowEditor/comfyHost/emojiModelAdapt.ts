/**
 * 表情包节点 ComfyUI 渠道的「模型驱动工作流组装」（2026-09-04）。
 *
 * ## 解决什么问题
 * 此前执行器把流程**固化**在内置模板上：整图固定走「表情包图集 (SDXL)」
 * （CheckpointLoaderSimple + KSampler cfg=7），Diffusion 模型靠
 * `comfy_model_group` hack 切到「Qwen 贴纸」模板——组合错误依旧 400：
 *   - flux（unet）被配进 Qwen 模板：CLIPLoader(type=qwen_image) + qwen VAE 全错；
 *   - flux checkpoint 版被配进 SDXL 模板：cfg=7 直接炸（flux 必须 cfg=1 + guidance）；
 *   - img2img 后处理硬编码节点 5/9，只对 SDXL 图集模板成立，对 Qwen 模板
 *     （SamplerCustomAdvanced + latent 在节点 6）静默失效甚至污染节点。
 *
 * 现在的做法：**模型 → 判族 → 按族组装最终 api_json**，单图（单格）与
 * 表情包图集共用同一条组装路径（只是 positive/尺寸不同）。执行器拿到
 * 组装结果后以 promptOverride 直通 runner.invoke，不再挑模板。
 *
 * ## 支持矩阵
 * | 模型文件名特征                  | 来源     | 组装结构 |
 * |--------------------------------|----------|----------|
 * | `qwen*`                        | unet/ckpt| Qwen-Image（UNET/AuraFlow/TextEncodeQwenImageEdit/SamplerCustomAdvanced） |
 * | `flux*`                        | unet     | Flux（UNET + DualCLIPLoader(clip_l+t5xxl) + FluxGuidance cfg=1） |
 * | `flux*`                        | ckpt     | Flux checkpoint（CheckpointLoader 自带编码器 + FluxGuidance） |
 * | `sd3*`                         | ckpt     | SD3.5（KSampler cfg=3.5 dpmpp_2m + EmptySD3LatentImage） |
 * | `sd_xl/sdxl/*xl*` 及其余 ckpt   | ckpt     | SDXL 通用（KSampler cfg=7 euler_ancestral） |
 * | `sd15/v1-5/v1_5`               | ckpt     | SD1.5 通用 + 尺寸 clamp 到 768 |
 * | 其余 unet                      | unet     | 按 Flux 处理（现代 unet 多为 flux 系，日志提示） |
 */

/** 模型加载来源：checkpoints/（ckpt）或 diffusion_models/（unet）。 */
export type EmojiModelSource = 'ckpt' | 'unet';

/** 模型族别（决定工作流结构）。 */
export type EmojiModelFamily = 'qwen' | 'flux' | 'sd35' | 'sdxl' | 'sd15' | 'unknown';

export interface EmojiModelSpec {
	source: EmojiModelSource;
	family: EmojiModelFamily;
	/** 纯文件名（无前缀）。 */
	name: string;
}

/** 编辑器下拉写入的 value 前缀。 */
export const COMFY_MODEL_CKPT_PREFIX = 'ckpt:';
export const COMFY_MODEL_UNET_PREFIX = 'unet:';

/**
 * 解析 `ckpt:name` / `unet:name` 前缀值。旧数据无前缀 → 按文件名启发式：
 * qwen/flux/sd3 系模型官方发布在 diffusion_models → unet，其余 → ckpt。
 */
export function parseComfyModelValue(raw: string): EmojiModelSpec {
	const value = (raw ?? '').trim();
	if (value.startsWith(COMFY_MODEL_CKPT_PREFIX)) {
		return finalizeSpec('ckpt', value.slice(COMFY_MODEL_CKPT_PREFIX.length));
	}
	if (value.startsWith(COMFY_MODEL_UNET_PREFIX)) {
		return finalizeSpec('unet', value.slice(COMFY_MODEL_UNET_PREFIX.length));
	}
	const guessSource: EmojiModelSource = /qwen|flux|sd3|sd_3|wan|auraflow/i.test(value) ? 'unet' : 'ckpt';
	return finalizeSpec(guessSource, value);
}

function finalizeSpec(source: EmojiModelSource, name: string): EmojiModelSpec {
	return { source, family: classifyModelName(name, source), name };
}

/** 按文件名判定模型族（大小写不敏感）。 */
export function classifyModelName(name: string, source: EmojiModelSource): EmojiModelFamily {
	const n = (name ?? '').toLowerCase();
	if (/qwen/.test(n)) { return 'qwen'; }
	if (/flux/.test(n)) { return 'flux'; }
	if (/sd3|sd_3|sd-3/.test(n)) { return 'sd35'; }
	if (/sd15|sd_1|sd-1|v1-5|v1_5|v1\.5/.test(n)) { return 'sd15'; }
	if (/sd_xl|sdxl|xl_base|-xl|playground/.test(n)) { return 'sdxl'; }
	// 未知来源按 loader 推断：unet 大概率 flux 系新模型；ckpt 走 SDXL 通用结构最兼容。
	return source === 'unet' ? 'flux' : 'sdxl';
}

interface ComfyNode { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } }

export interface EmojiPromptBuildOptions {
	/** 正向描述（单格贴纸描述或整图拼贴 prompt）。 */
	positive: string;
	/** 负向描述（qwen/flux 组装忽略——其采样链无 negative 输入）。 */
	negative: string;
	seed: number;
	width: number;
	height: number;
	/** 参考图（**已 resolve 成 ComfyUI 文件名 / /view 引用**）→ 组装 img2img 分支。 */
	refImage?: string;
	/** 重绘幅度：text2img=1.0，img2img=0.75。 */
	denoise?: number;
	filenamePrefix: string;
}

export interface EmojiPromptBuildResult {
	prompt: Record<string, ComfyNode>;
	saveNodeId: string;
	/** 组装时实际生效的族/来源（诊断日志用）。 */
	debug: string;
}

/** Qwen-Image 官方发布的 text encoder / VAE 惯例文件名。 */
const QWEN_CLIP = 'qwen_2.5_vl_7b_fp8_scaled.safetensors';
const QWEN_VAE = 'qwen_image_vae.safetensors';
/** Flux 官方发布的双文本编码器 / VAE 惯例文件名。 */
const FLUX_CLIP_L = 'clip_l.safetensors';
const FLUX_T5 = 't5xxl_fp8_e4m3fn_scaled.safetensors';
const FLUX_VAE = 'ae.safetensors';

/**
 * 按模型族组装表情包工作流（单图与图集共用）。
 * 返回最终 api_json（可直接 POST /prompt）与 SaveImage 节点号。
 */
export function buildEmojiModelPrompt(spec: EmojiModelSpec, opts: EmojiPromptBuildOptions): EmojiPromptBuildResult {
	const denoise = typeof opts.denoise === 'number' ? opts.denoise : 1.0;
	// ★ 大模型耗时预期提示（2026-09-05 实测教训）：qwen_image_2512 为 20B 级模型，
	//   无 fp8 硬件加速的 GPU（或显存不足 CPU offload）下 1024² 单图实测 40 分钟+
	//   （触发执行器 600s 硬超时，但 ComfyUI 端仍在继续跑完）。大图（图集）叠加
	//   更慢。给出明确预期与替代建议，而不是让用户对着 10 分钟无响应猜。
	if (spec.family === 'qwen' && /2512|20b/i.test(spec.name)) {
		// eslint-disable-next-line no-console
		console.warn(
			`[emojiModelAdapt] ⚠ ${spec.name} 是 20B 级大模型：弱 GPU / 显存不足（CPU offload）时` +
			`单张 1024² 实测可达 40 分钟+，会触发执行器 10 分钟硬超时（ComfyUI 端仍会继续跑完）。` +
			`建议改选 Checkpoint 系模型（SDXL，实测秒级）或更小的 qwen/flux 变体。`,
		);
	}
	// SD1.5 在 1024² 会结构崩坏 → clamp 到 768（64 对齐），并给出诊断日志。
	let { width, height } = opts;
	if (spec.family === 'sd15' && (width > 768 || height > 768)) {
		width = Math.max(256, Math.round(Math.min(width, 768) / 64) * 64);
		height = Math.max(256, Math.round(Math.min(height, 768) / 64) * 64);
		// eslint-disable-next-line no-console
		console.warn(`[emojiModelAdapt] SD1.5 模型 → 尺寸 clamp 到 ${width}x${height}（1024² 会结构崩坏）`);
	}

	const prompt: Record<string, ComfyNode> = {};
	let saveNodeId = '';

	/** img2img 公共段：LoadImage + VAEEncode，返回 latent 来源。 */
	const buildImg2Img = (idBase: string, vaeRef: [string, number]): [string, number] => {
		const loadImageId = `${idBase}L`;
		const encodeId = `${idBase}E`;
		prompt[loadImageId] = { class_type: 'LoadImage', inputs: { image: opts.refImage ?? '' } };
		prompt[encodeId] = { class_type: 'VAEEncode', inputs: { pixels: [loadImageId, 0], vae: vaeRef } };
		return [encodeId, 0];
	};

	if (spec.family === 'qwen') {
		// Qwen-Image：照抄内置「Qwen 贴纸」骨架（UNET + AuraFlow shift 1.73 +
		// TextEncodeQwenImageEdit + SamplerCustomAdvanced），positive 换成调用方内容。
		prompt['1'] = { class_type: 'UNETLoader', inputs: { unet_name: spec.name, weight_dtype: 'default' } };
		prompt['2'] = { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 1.73 } };
		prompt['3'] = { class_type: 'CLIPLoader', inputs: { clip_name: QWEN_CLIP, type: 'qwen_image' } };
		prompt['4'] = { class_type: 'VAELoader', inputs: { vae_name: QWEN_VAE } };
		prompt['5'] = { class_type: 'TextEncodeQwenImageEdit', inputs: { clip: ['3', 0], prompt: opts.positive } };
		prompt['6'] = { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: 1 } };
		prompt['7'] = { class_type: 'RandomNoise', inputs: { noise_seed: opts.seed } };
		prompt['8'] = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } };
		prompt['9'] = { class_type: 'BasicScheduler', inputs: { model: ['2', 0], scheduler: 'simple', steps: 20, denoise } };
		prompt['10'] = { class_type: 'BasicGuider', inputs: { model: ['2', 0], conditioning: ['5', 0] } };
		const latentRef = opts.refImage ? buildImg2Img('8', ['4', 0]) : (['6', 0] as [string, number]);
		prompt['11'] = {
			class_type: 'SamplerCustomAdvanced',
			inputs: { noise: ['7', 0], guider: ['10', 0], sampler: ['8', 0], sigmas: ['9', 0], latent_image: latentRef },
		};
		prompt['12'] = { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: ['4', 0] } };
		prompt['13'] = { class_type: 'SaveImage', inputs: { images: ['12', 0], filename_prefix: opts.filenamePrefix } };
		saveNodeId = '13';
	} else if (spec.family === 'flux') {
		// Flux：unet 版 = UNETLoader + DualCLIPLoader(clip_l+t5xxl)；ckpt 版 =
		// CheckpointLoaderSimple 自带编码器/VAE。采样链必须 cfg=1 + FluxGuidance。
		const isUnet = spec.source === 'unet';
		const clipRef: [string, number] = isUnet ? ['2', 0] : ['1', 1];
		const vaeRef: [string, number] = isUnet ? ['14', 0] : ['1', 2];
		prompt['1'] = isUnet
			? { class_type: 'UNETLoader', inputs: { unet_name: spec.name, weight_dtype: 'default' } }
			: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: spec.name } };
		if (isUnet) {
			prompt['2'] = { class_type: 'DualCLIPLoader', inputs: { clip_name1: FLUX_CLIP_L, clip_name2: FLUX_T5, type: 'flux', device: 'default' } };
		}
		prompt['3'] = { class_type: 'CLIPTextEncode', inputs: { text: opts.positive, clip: clipRef } };
		prompt['4'] = { class_type: 'CLIPTextEncode', inputs: { text: opts.negative, clip: clipRef } };
		prompt['5'] = { class_type: 'FluxGuidance', inputs: { conditioning: ['3', 0], guidance: 3.5 } };
		prompt['6'] = { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: 1 } };
		prompt['7'] = { class_type: 'RandomNoise', inputs: { noise_seed: opts.seed } };
		prompt['8'] = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } };
		prompt['9'] = { class_type: 'BasicScheduler', inputs: { model: ['1', 0], scheduler: 'simple', steps: 20, denoise } };
		prompt['10'] = { class_type: 'BasicGuider', inputs: { model: ['1', 0], conditioning: ['5', 0] } };
		const latentRef = opts.refImage ? buildImg2Img('8', vaeRef) : (['6', 0] as [string, number]);
		prompt['11'] = {
			class_type: 'SamplerCustomAdvanced',
			inputs: { noise: ['7', 0], guider: ['10', 0], sampler: ['8', 0], sigmas: ['9', 0], latent_image: latentRef },
		};
		if (isUnet) {
			prompt['14'] = { class_type: 'VAELoader', inputs: { vae_name: FLUX_VAE } };
		}
		prompt['12'] = { class_type: 'VAEDecode', inputs: { samples: ['11', 0], vae: vaeRef } };
		prompt['13'] = { class_type: 'SaveImage', inputs: { images: ['12', 0], filename_prefix: opts.filenamePrefix } };
		saveNodeId = '13';
	} else {
		// SD3.5 / SDXL / SD1.5 / 其余 checkpoint：CheckpointLoader + CLIPTextEncode +
		// KSampler 简洁链（negative 生效）。族间只差 latent 节点与采样参数。
		const isSd35 = spec.family === 'sd35';
		prompt['1'] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: spec.name } };
		prompt['2'] = { class_type: 'CLIPTextEncode', inputs: { text: opts.positive, clip: ['1', 1] } };
		prompt['3'] = { class_type: 'CLIPTextEncode', inputs: { text: opts.negative, clip: ['1', 1] } };
		prompt['4'] = isSd35
			? { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: 1 } }
			: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } };
		prompt['5'] = {
			class_type: 'KSampler',
			inputs: {
				model: ['1', 0],
				positive: ['2', 0],
				negative: ['3', 0],
				latent_image: opts.refImage ? buildImg2Img('8', ['1', 2]) : (['4', 0] as [string, number]),
				seed: opts.seed,
				steps: isSd35 ? 28 : 30,
				cfg: isSd35 ? 3.5 : 7.0,
				sampler_name: isSd35 ? 'dpmpp_2m' : 'euler_ancestral',
				scheduler: isSd35 ? 'sgm_uniform' : 'normal',
				denoise,
			},
		};
		prompt['6'] = { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } };
		prompt['7'] = { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: opts.filenamePrefix } };
		saveNodeId = '7';
	}

	return {
		prompt,
		saveNodeId,
		debug: `${spec.source}/${spec.family}/${spec.name}${opts.refImage ? ' +img2img' : ''} @${width}x${height} denoise=${denoise}`,
	};
}
