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
				// ★ batch_size=1 时 sub_batch_size 必须一致（否则节点内部按 16
				//   分批处理，其余 15 份读未初始化内存 → RGBA 输出混乱/彩色噪声）。
				"sub_batch_size": 1,
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
				"text": "a cute cartoon sticker, thick outlines, vibrant colors, isolated on transparent background, bouncing animation, smooth loop, small centered subject, wide empty margin around subject",
				"clip": ["1", 1],
			},
		},
		"5": {
			"class_type": "CLIPTextEncode",
			"inputs": {
				"text": "text, watermark, blurry, low quality, deformed, static, cropped, close-up",
				"clip": ["1", 1],
			},
		},
		"6": {
			"class_type": "EmptyLatentImage",
			// ★ 768² 而非 512²：SDXL 原生训练分辨率是 1024，512 下构图会失控 ——
			//   主体涨满全幅、四周没有留白，透明贴纸的边缘 alpha 被主体压住变不
			//   透明（实测 512²：外框 alpha 均值 ~75、16/16 帧脏；768²：均值 6.2、
			//   1/16 脏；768² + 留白引导 prompt：均值 2.0、0/16 脏）。
			//   代价是耗时约翻倍（16 帧 512²≈62s → 768²≈131s，RTX 4070）。
			//   验收脚本：scripts/test-emoji-e2e.mjs（外框 alpha 均值须 ≤32）。
			"inputs": { "width": 768, "height": 768, "batch_size": 16 },
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
				// ★ 动态模板 batch_size=16（EmptyLatentImage 一次出 16 帧），
				//   sub_batch_size 必须匹配，否则 RGBA 解码越界 → 彩色噪声。
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
				// 「small centered subject / wide empty margin」是必需的构图约束，不是修辞：
				// 缺它时主体会涨满画框、压掉四周透明留白（见节点 6 的注释与实测数据）。
				"suffix": ", thick outlines, vibrant colors, isolated on transparent background, bouncing animation, smooth loop, die-cut sticker, small centered subject, wide empty margin around subject, full body visible",
				"required": false,
			},
		},
		// ★ 帧数 = EmptyLatentImage.batch_size（AnimateDiff 用 batch 维度承载时间轴）。
		//   卡片上的「帧数」控件必须绑到这里，否则是假控件（曾硬编码 16，用户改无效）。
		//   注意 `values.batch_size` 被 runEmojiStageGrid 固定为 1（网格由循环驱动），
		//   所以这里必须绑 `option:frames` 而不是 `option:batch_size`。
		"6": {
			"batch_size": { "from": "option:frames", "default": 16, "required": false, "cast": "int" },
		},
		"7": {
			"seed": { "from": "option:seed", "default": "random_int31", "required": false, "cast": "int" },
		},
		// ★ sub_batch_size 必须与 batch_size 同值，否则 LayeredDiffusionDecodeRGBA
		//   按错误的分批数解码 → 越界读未初始化内存 → 彩色噪声（见节点 9 注释）。
		//   因此这两个字段绑同一个 option:frames。
		"9": {
			"sub_batch_size": { "from": "option:frames", "default": 16, "required": false, "cast": "int" },
		},
		"10": {
			"fps": { "from": "option:fps", "default": 8, "required": false, "cast": "int" },
		},
	},
};

export const EMOJI_BUILTIN_WORKFLOWS: Record<string, StageWorkflowConfig> = {
	"透明贴纸 (SDXL)": EMOJI_TRANSPARENT_STICKER,
	"动态表情 (AnimateDiff)": EMOJI_ANIMATED_TRANSPARENT,
	/**
	 * Fallback：纯 SDXL 生成（不依赖 LayeredDiffusion LoRA）。
	 *
	 * 当用户环境未安装 ComfyUI_LayeredDiffusion 或 layer_xl_transparent_conv.safetensors
	 * 缺失时，透明模板的 LayeredDiffusionApply/DecodeRGBA 会静默输出混乱数据
	 * （彩色噪声/扭曲笔画）。此 fallback 用 SDXL 原生 VAE 解码，保证出图质量，
	 * 唯一代价是无 alpha 通道（背景不透明 —— 可用 ComfyUI 后处理或 PS 抠图）。
	 *
	 * 执行路径：runStageWorkflow → runner.invoke(prompt) → SaveImage → /history。
	 * 与透明模板完全相同的 bindings 接口（main_prompt + seed）。
	 */
	"普通贴纸 (SDXL, 无需 LoRA)": {
		api_json: {
			"1": {
				"class_type": "CheckpointLoaderSimple",
				"inputs": { "ckpt_name": "sd_xl_base_1.0.safetensors" },
			},
			"2": {
				"class_type": "CLIPTextEncode",
				"inputs": {
					"text": "a cute cartoon sticker, thick outlines, vibrant colors, solid white background, die-cut sticker style, high quality",
					"clip": ["1", 1],
				},
			},
			"3": {
				"class_type": "CLIPTextEncode",
				"inputs": {
					"text": "text, watermark, blurry, low quality, deformed, ugly, duplicate, morbid, mutilated, out of frame, extra fingers, mutated hands, poorly drawn hands, poorly drawn face, mutation, deformed, bad anatomy, bad proportions, extra limbs, cloned face, disfigured, gross proportions, malformed limbs, missing arms, missing legs, extra arms, extra legs, fused fingers, too many fingers, long neck",
					"clip": ["1", 1],
				},
			},
			"4": {
				"class_type": "EmptyLatentImage",
				"inputs": { "width": 1024, "height": 1024, "batch_size": 1 },
			},
			"5": {
				"class_type": "KSampler",
				"inputs": {
					"model": ["1", 0],
					"positive": ["2", 0],
					"negative": ["3", 0],
					"latent_image": ["4", 0],
					"seed": 0,
					"steps": 30,
					"cfg": 7.0,
					"sampler_name": "euler_ancestral",
					"scheduler": "normal",
					"denoise": 1.0,
				},
			},
			"6": {
				"class_type": "VAEDecode",
				"inputs": {
					"samples": ["5", 0],
					"vae": ["1", 2],
				},
			},
			"7": {
				"class_type": "SaveImage",
				"inputs": {
					"images": ["6", 0],
					"filename_prefix": "ComfyTV/emoji_fallback",
				},
			},
		},
		result: { "type": "ui_save", "node": "7" },
		inputs: {
			"2": {
				"text": {
					"from": "main_prompt",
					"default": "a cute cartoon sticker",
					"suffix": ", thick outlines, vibrant colors, solid white background, die-cut sticker style, high quality, centered composition",
					"required": false,
				},
			},
			"5": {
				"seed": { "from": "option:seed", "default": "random_int31", "required": false, "cast": "int" },
			},
		},
	},
};
