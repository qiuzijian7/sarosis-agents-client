/*---------------------------------------------------------------------------------------------
 *  emojiWorkflows — EmojiStage（表情包）的内置 workflow 模板。
 *
 *  EmojiStage 生成 m×n 个动态表情包（透明背景循环贴纸）。m×n 由**前端循环驱动**：
 *  每格调用一次本模板（注入该格的 prompt / seed），单格输出一个 RGBA webp，最终
 *  汇总成 m×n 网格 —— 天然支持「逐格重生成」（只重跑选中格）。
 *
 *  ## 透明背景
 *  走 SDXL + layerdiffuse `LayeredDiffusionApply`（"SDXL, Conv Injection"，
 *  `layer_xl_transparent_conv`）+ `LayeredDiffusionDecodeRGBA`（`vae_transparent_decoder`），
 *  输出带 alpha 的 PNG/webp。网格预览用棋盘格底纹实时展示透明通道（见 EmojiStageEditor）。
 *
 *  ## 动态（动画）—— 已落地（SDXL motion 路线）
 *  AnimateDiff motion 模型只匹配单一 SD 版本：`mm_sd_v15_v2` = SD1.5、`mm_sdxl_v10_beta` = SDXL。
 *  而 layerdiffuse 的透明注入也分版本：SDXL 有 `layer_xl_transparent_conv`（普通 LoRA patch，
 *  不抢 batch）；SD1.5 只有 `layer_sd15_transparent_attn`（**attn_sharing，抢 batch 做前/背景两帧**，
 *  与 AnimateDiff 的多帧 batch 语义冲突）。故动态表情包走 **SDXL + mm_sdxl_v10_beta** 路线：
 *  `CheckpointLoaderSimple(sd_xl_base)` → `LayeredDiffusionApply(Conv)` → `ADE_AnimateDiffLoaderGen1`
 *  （beta_schedule="linear (AnimateDiff-SDXL)"）→ KSampler(16 帧) → VAEDecode →
 *  `LayeredDiffusionDecodeRGBA` → `SaveAnimatedWEBP`（透明循环 webp）。
 *
 *  数据来源：手写（api_json 连线引用必须为字符串 ["4",0]，见 stageWorkflowExecutor）。
 *--------------------------------------------------------------------------------------------*/

import type { StageWorkflowConfig } from '../stageWorkflowExecutor.js';

/**
 * 单格「透明贴纸」模板（静态，SDXL + transparent LoRA + transparent VAE）。
 * 执行时由 runStageWorkflow 注入：
 *   - main_prompt（该格 prompt，留空回退全局 → 见 EmojiStageEditor）
 *   - option:seed（该格 seed）
 *   - upstream_image:annotated（可选参考图，目前模板未消费）
 */
export const EMOJI_TRANSPARENT_STICKER: StageWorkflowConfig = {
	api_json: {
		"1": {
			"class_type": "CheckpointLoaderSimple",
			"inputs": { "ckpt_name": "sd_xl_base_1.0.safetensors" },
		},
		"2": {
			"class_type": "LayeredDiffusionApply",
			"inputs": {
				"model": ["1", 0],
				"config": "SDXL, Conv Injection",
				"weight": 1.0,
			},
		},
		"3": {
			"class_type": "CLIPTextEncode",
			"inputs": {
				"text": "a cute cartoon sticker, thick outlines, vibrant colors, isolated on transparent background",
				"clip": ["1", 1],
			},
		},
		"4": {
			"class_type": "CLIPTextEncode",
			"inputs": {
				"text": "text, watermark, blurry, low quality, deformed",
				"clip": ["1", 1],
			},
		},
		"5": {
			"class_type": "EmptyLatentImage",
			"inputs": { "width": 1024, "height": 1024, "batch_size": 1 },
		},
		"6": {
			"class_type": "KSampler",
			"inputs": {
				"model": ["2", 0],
				"positive": ["3", 0],
				"negative": ["4", 0],
				"latent_image": ["5", 0],
				"seed": 0,
				"steps": 25,
				"cfg": 7.0,
				"sampler_name": "euler",
				"scheduler": "normal",
				"denoise": 1.0,
			},
		},
		"7": {
			"class_type": "VAEDecode",
			"inputs": {
				"samples": ["6", 0],
				"vae": ["1", 2],
			},
		},
		"8": {
			"class_type": "LayeredDiffusionDecodeRGBA",
			"inputs": {
				"samples": ["6", 0],
				"images": ["7", 0],
				"sd_version": "SDXL",
				"sub_batch_size": 16,
			},
		},
		"9": {
			"class_type": "SaveImage",
			"inputs": {
				"images": ["8", 0],
				"filename_prefix": "ComfyTV/emoji",
			},
		},
	},
	result: { "type": "ui_save", "node": "9" },
	inputs: {
		"3": {
			"text": {
				"from": "main_prompt",
				"default": "a cute cartoon sticker",
				"suffix": ", thick outlines, vibrant colors, isolated on transparent background, die-cut sticker",
				"required": false,
			},
		},
		"6": {
			"seed": { "from": "option:seed", "default": "random_int31", "required": false, "cast": "int" },
		},
	},
};

/**
 * 单格「动态透明表情包」模板（SDXL + AnimateDiff motion + layerdiffuse 透明）。
 * 16 帧循环 webp（透明背景），fps=8。执行时注入 main_prompt（该格 prompt）与
 * option:seed（该格 seed），其余与静态贴纸一致。
 *
 * 连线要点（已本机验证通过，输出 emoji_anim_*.webp 16 帧 RGBA）：
 *   - 透明用 `LayeredDiffusionApply`（"SDXL, Conv Injection"，layer_xl_transparent_conv）
 *   - motion 用 `ADE_AnimateDiffLoaderGen1`（mm_sdxl_v10_beta.ckpt，beta_schedule
 *     "linear (AnimateDiff-SDXL)"），model 接 LayeredDiffusionApply 的输出（两者叠加）
 *   - 解码用 `LayeredDiffusionDecodeRGBA`（samples=latent, images=VAEDecode 输出）
 *   - 输出用 `SaveAnimatedWEBP`（支持透明动画，进 history 的 images slot）
 */
export const EMOJI_ANIMATED_TRANSPARENT: StageWorkflowConfig = {
	api_json: {
		"1": {
			"class_type": "CheckpointLoaderSimple",
			"inputs": { "ckpt_name": "sd_xl_base_1.0.safetensors" },
		},
		"2": {
			"class_type": "LayeredDiffusionApply",
			"inputs": {
				"model": ["1", 0],
				"config": "SDXL, Conv Injection",
				"weight": 1.0,
			},
		},
		"3": {
			"class_type": "ADE_AnimateDiffLoaderGen1",
			"inputs": {
				"model": ["2", 0],
				"model_name": "mm_sdxl_v10_beta.ckpt",
				"beta_schedule": "linear (AnimateDiff-SDXL)",
			},
		},
		"4": {
			"class_type": "CLIPTextEncode",
			"inputs": {
				"text": "a cute cartoon sticker, thick outlines, vibrant colors, isolated on transparent background, bouncing animation, smooth loop",
				"clip": ["1", 1],
			},
		},
		"5": {
			"class_type": "CLIPTextEncode",
			"inputs": {
				"text": "text, watermark, blurry, low quality, deformed, static",
				"clip": ["1", 1],
			},
		},
		"6": {
			"class_type": "EmptyLatentImage",
			"inputs": { "width": 512, "height": 512, "batch_size": 16 },
		},
		"7": {
			"class_type": "KSampler",
			"inputs": {
				"model": ["3", 0],
				"positive": ["4", 0],
				"negative": ["5", 0],
				"latent_image": ["6", 0],
				"seed": 0,
				"steps": 25,
				"cfg": 7.0,
				"sampler_name": "euler",
				"scheduler": "normal",
				"denoise": 1.0,
			},
		},
		"8": {
			"class_type": "VAEDecode",
			"inputs": {
				"samples": ["7", 0],
				"vae": ["1", 2],
			},
		},
		"9": {
			"class_type": "LayeredDiffusionDecodeRGBA",
			"inputs": {
				"samples": ["7", 0],
				"images": ["8", 0],
				"sd_version": "SDXL",
				"sub_batch_size": 16,
			},
		},
		"10": {
			"class_type": "SaveAnimatedWEBP",
			"inputs": {
				"images": ["9", 0],
				"filename_prefix": "ComfyTV/emoji_anim",
				"fps": 8.0,
				"lossless": false,
				"quality": 90,
				"method": "default",
			},
		},
	},
	result: { "type": "ui_save", "node": "10" },
	inputs: {
		"4": {
			"text": {
				"from": "main_prompt",
				"default": "a cute cartoon sticker",
				"suffix": ", thick outlines, vibrant colors, isolated on transparent background, bouncing animation, smooth loop, die-cut sticker",
				"required": false,
			},
		},
		"7": {
			"seed": { "from": "option:seed", "default": "random_int31", "required": false, "cast": "int" },
		},
	},
};

export const EMOJI_BUILTIN_WORKFLOWS: Record<string, StageWorkflowConfig> = {
	"透明贴纸 (SDXL)": EMOJI_TRANSPARENT_STICKER,
	"动态表情 (AnimateDiff)": EMOJI_ANIMATED_TRANSPARENT,
};
