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
 *  ## 动态（动画）—— 已落地（MiniMax H3 图生视频路线）
 *  动态表情包改用 MiniMax H3 Reference-to-Video（图生视频），产物稳定、无需
 *  layerdiffuse、**能用上游参考图让静态贴纸"动起来"**。
 *
 *  数据来源：手写（api_json 连线引用必须为字符串 ["4",0]，见 stageWorkflowExecutor）。
 *--------------------------------------------------------------------------------------------*/

import type { StageWorkflowConfig } from '../stageWorkflowExecutor.js';
import { VIDEO_LOCAL_MINIMAX_H3_R2V } from './videoWorkflows.js';

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
			// ★ 768×768 / 20 步：本机实测（12GB VRAM）比 1024×1024 / 25 步快 13 倍
			//   （50.8s vs ~660s），且主体分离更干净（透明像素 62.65% vs 39.92%）。
			//   1024 下显存吃紧触发频繁换页，是慢的主因而非计算量。
			"inputs": { "width": 768, "height": 768, "batch_size": 1 },
		},
		"6": {
			"class_type": "KSampler",
			"inputs": {
				"model": ["2", 0],
				"positive": ["3", 0],
				"negative": ["4", 0],
				"latent_image": ["5", 0],
				"seed": 0,
				"steps": 20,
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
		// ★ 方案1 解码（对齐动态模板，绕开 LayeredDiffusionDecodeRGBA）：
		//   LayeredDiffusionDecodeRGBA 内部调 `JoinImageWithAlpha().join_image_with_alpha()`
		//   —— ComfyUI 0.33 的 comfy_extras.nodes_compositing.JoinImageWithAlpha 是
		//   新式 io.ComfyNode（execute 为 classmethod），已无该实例方法 → 静态贴纸
		//   直接报 `'JoinImageWithAlpha' object has no attribute 'join_image_with_alpha'`。
		//   改为节点连线：标准 VAE 出 RGB（节点 7，清晰不花屏）+ transparent decoder
		//   只出前景 matte（节点 8 的 MASK 槽）→ InvertMask → JoinImageWithAlpha。
		"8": {
			"class_type": "LayeredDiffusionDecode",
			"inputs": {
				"samples": ["6", 0],
				"images": ["7", 0],
				"sd_version": "SDXL",
				// ★ batch_size=1 时 sub_batch_size 必须一致（否则节点内部按 16
				//   分批处理，其余 15 份读未初始化内存 → 解码越界彩色噪声）。
				"sub_batch_size": 1,
			},
		},
		"9": {
			"class_type": "InvertMask",
			"inputs": {
				// ★ LayeredDiffusionDecode 的 MASK 槽（slot 1）=「前景 matte」（1=主体），
				//   JoinImageWithAlpha 期望「透明程度」（1=透明），需反转。
				"mask": ["8", 1],
			},
		},
		"10": {
			"class_type": "JoinImageWithAlpha",
			"inputs": {
				// ★ RGB 用标准 VAE（节点 7，清晰不花屏），alpha 用前景 matte
				//   （transparent decoder 只出 alpha，绕开其花屏 RGB）。
				"image": ["7", 0],
				"alpha": ["9", 0],
			},
		},
		"11": {
			"class_type": "SaveImage",
			"inputs": {
				"images": ["10", 0],
				"filename_prefix": "ComfyTV/emoji",
			},
		},
	},
	result: { "type": "ui_save", "node": "11" },
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
 * 单格「Qwen 贴纸」模板（静态，白底，微信表情包标准格式）。
 *
 * ★ 默认模板：微信表情开放平台只支持 PNG/JPG/GIF（不支持 WebP），且动图 GIF
 *   惯例用白底（GIF 无真 alpha）。故默认走 Qwen 2512 生成白底贴纸 PNG，
 *   一步到位符合微信格式，无需 layerdiffuse（SDXL 透明 LoRA 在部分环境缺失时
 *   会静默花屏）。
 *
 * 已本机验证：qwen_image_2512_fp8 + EmptySD3LatentImage 出 1 张清晰白底图（30s）。
 * ⚠ 关键：qwen_image_2512 是【非分层】模型，必须用 EmptySD3LatentImage（16 通道
 *   单层）；误用 EmptyQwenImageLayeredLatentImage（layers=3）会通道不匹配 →
 *   输出 13 张混乱图。
 */
export const EMOJI_QWEN_STICKER: StageWorkflowConfig = {
	api_json: {
		"1": {
			"class_type": "UNETLoader",
			"inputs": { "unet_name": "qwen_image_2512_fp8_e4m3fn.safetensors", "weight_dtype": "default" },
		},
		"2": {
			"class_type": "ModelSamplingAuraFlow",
			"inputs": { "model": ["1", 0], "shift": 1.73 },
		},
		"3": {
			"class_type": "CLIPLoader",
			"inputs": { "clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", "type": "qwen_image" },
		},
		"4": {
			"class_type": "VAELoader",
			"inputs": { "vae_name": "qwen_image_vae.safetensors" },
		},
		"5": {
			"class_type": "TextEncodeQwenImageEdit",
			"inputs": {
				"clip": ["3", 0],
				// ★ 字段名是 prompt（不是 CLIPTextEncode 的 text）—— 写错会报
				//   required_input_missing: prompt。
				"prompt": "a cute cartoon sticker, thick outlines, vibrant colors, solid white background, die-cut sticker style",
			},
		},
		"6": {
			"class_type": "EmptySD3LatentImage",
			"inputs": { "width": 768, "height": 768, "batch_size": 1 },
		},
		"7": {
			"class_type": "RandomNoise",
			"inputs": { "noise_seed": 0 },
		},
		"8": {
			"class_type": "KSamplerSelect",
			"inputs": { "sampler_name": "euler" },
		},
		"9": {
			"class_type": "BasicScheduler",
			"inputs": { "model": ["2", 0], "scheduler": "simple", "steps": 20, "denoise": 1 },
		},
		"10": {
			"class_type": "BasicGuider",
			"inputs": { "model": ["2", 0], "conditioning": ["5", 0] },
		},
		"11": {
			"class_type": "SamplerCustomAdvanced",
			"inputs": {
				"noise": ["7", 0],
				"guider": ["10", 0],
				"sampler": ["8", 0],
				"sigmas": ["9", 0],
				"latent_image": ["6", 0],
			},
		},
		"12": {
			"class_type": "VAEDecode",
			"inputs": { "samples": ["11", 0], "vae": ["4", 0] },
		},
		"13": {
			"class_type": "SaveImage",
			"inputs": { "images": ["12", 0], "filename_prefix": "ComfyTV/emoji_qwen" },
		},
	},
	result: { "type": "ui_save", "node": "13" },
	inputs: {
	"1": {
	// ★ 模型下拉（comfy_model）→ UNETLoader.unet_name：用户选的 qwen/flux
	//   diffusion 模型即生效（此前写死 2512，下拉选了也不起作用）。
	"unet_name": {
	"from": "option:comfy_model",
	"default": "qwen_image_2512_fp8_e4m3fn.safetensors",
	"required": false,
	},
	},
	"5": {
	// ★ TextEncodeQwenImageEdit 的文本字段是 prompt（非 text），绑定名必须一致。
	"prompt": {
	"from": "main_prompt",
	"default": "a cute cartoon sticker",
	"suffix": ", thick outlines, vibrant colors, solid white background, die-cut sticker style, centered composition",
	"required": false,
	},
	},
	"7": {
	"noise_seed": { "from": "option:seed", "default": "random_int31", "required": false, "cast": "int" },
	},
	},
};

/**
 * 单格「动态表情」模板（MiniMax H3 Reference-to-Video，**支持参考图**）。
 *
 * ★ 替代原 AnimateDiff 路线（SDXL + mm_sdxl_v10_beta 透明循环 webp）：
 *   AnimateDiff 对「随机 seed + 任意 prompt」不稳定（易花屏），且透明 LoRA
 *   （layerdiffuse）与多帧 batch 语义耦合深。改用 MiniMax H3 图生视频直接
 *   生成 mp4 动画表情，产物稳定、无需 layerdiffuse、**能用上游参考图让
 *   静态贴纸"动起来"**。
 *
 * 模板来源：基于 VIDEO_LOCAL_MINIMAX_H3_R2V 深拷贝 + 裁剪 —— 原 R2V 是电影级
 * 多镜头导演管线（30+ 节点、9 张参考图 + 多视频 + 多音频），表情包场景只取 1 张
 * 参考图，删除冗余多图/视频/音频上游节点（139/201~207/301/303/401~403）+ 清理
 * R2V 节点的悬空 ref_image_1~8 字段。
 *
 * 输出：768×768 mp4（SaveVideo → ui_save_url），fps 固定 24，时长由 duration_s
 * 驱动（ComfyMathExpression 把秒数换算成帧数并对齐 17k+5 grid）。
 * ⚠ MiniMax H3 trained range ≈ 124–362 帧（5–15s）；更短虽合法但属 untested。
 * 微信表情 GIF ≤3s，后续用「视频转 GIF」节点截取前 3s。
 */


export const EMOJI_BUILTIN_WORKFLOWS: Record<string, StageWorkflowConfig> = {
	"Qwen 贴纸 (默认)": EMOJI_QWEN_STICKER,
	"透明贴纸 (SDXL)": EMOJI_TRANSPARENT_STICKER,
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
	/**
	 * Fallback：SDXL（支持参考图 img2img）。
	 *
	 * 当 MiniMax H3 执行失败或 LayeredDiffusion 未安装时使用。
	 *
	 * 与旧版「纯 text-to-image」的关键区别：
	 *   - 新增 LoadImage（节点 10）+ VAEEncode（节点 11），可消费上游参考图
	 *   - 默认走 EmptyLatentImage + denoise=1.0（纯 text-to-image）
	 *   - **运行时**若上游有参考图，runEmojiStageGrid 会把 KSampler 切换到
	 *     VAEEncode 输出 + denoise=0.75（img2img 模式，保留参考图结构）
	 *
	 * 执行路径：runStageWorkflow → runner.invoke(prompt) → SaveImage → /history。
	 * bindings 接口：main_prompt + seed + upstream_image:annotated（可选）。
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
			// ★ 默认 latent 源（text-to-image 模式）：有参考图时被 runEmojiStageGrid 覆盖
			"4": {
				"class_type": "EmptyLatentImage",
				"inputs": { "width": 1024, "height": 1024, "batch_size": 1 },
			},
			// ★ 参考图输入：applyInputs 用 upstream_image:annotated 覆盖 image 字段
			"10": {
				"class_type": "LoadImage",
				"inputs": { "image": "material.png" },
			},
			// ★ VAEEncode：有参考图时，KSampler 的 latent_image 改接此节点输出
			"11": {
				"class_type": "VAEEncode",
				"inputs": {
					"pixels": ["10", 0],
					"vae": ["1", 2],
				},
			},
			"5": {
				"class_type": "KSampler",
				"inputs": {
					"model": ["1", 0],
					"positive": ["2", 0],
					"negative": ["3", 0],
					// ★ 默认接 EmptyLatentImage（text-to-image）；
					//   有参考图时 runEmojiStageGrid 改为 ["11", 0]（VAEEncode 输出 = img2img）
					"latent_image": ["4", 0],
					"seed": 0,
					"steps": 30,
					"cfg": 7.0,
					"sampler_name": "euler_ancestral",
					"scheduler": "normal",
					// ★ text-to-image 时 1.0；有参考图时 runEmojiStageGrid 改为 0.75
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
			// ★ 上游参考图注入：有图时覆盖 LoadImage.image 为上传后的文件名
			"10": {
				"image": {
					"from": "upstream_image:annotated",
					"default": "material.png",
					"required": false,
				},
			},
		},
	},

	/**
	 * 表情包图集 (SDXL) —— **整图模式**专用模板（scope='all' 新路径）。
	 *
	 * 与单贴纸模板的本质差异：一次生成一张 **m×n 拼贴图集**（prompt 由
	 * runEmojiStageGrid.buildEmojiSheetPrompt 组装：拼贴版式约束 + 每格描述），
	 * 生成后前端 splitStickerSheet 按 m×n 切成独立小图 —— 1 次采样替代 m×n 次
	 * （格间风格天然统一，成本 ≈ 1/m×n）。切分与抠底在前端完成（splitStickerSheet）。
	 *
	 * bindings：main_prompt（拼贴 prompt）+ seed + comfy_model（★ option:comfy_model
	 * = 渠道选择「ComfyUI」时的 checkpoint 下拉值，resolveBinding 的 option: 分支
	 * 直接从 values 取 —— 用户在编辑器选 qwen/sdxl 等本地模型即生效）。
	 */
	"表情包图集 (SDXL)": {
		api_json: {
			"1": {
				"class_type": "CheckpointLoaderSimple",
				"inputs": { "ckpt_name": "sd_xl_base_1.0.safetensors" },
			},
			"2": {
				"class_type": "CLIPTextEncode",
				"inputs": {
					"text": "a sticker sheet",
					"clip": ["1", 1],
				},
			},
			"3": {
				"class_type": "CLIPTextEncode",
				"inputs": {
					"text": "text, watermark, blurry, low quality, deformed, ugly, duplicate, morbid, mutilated, out of frame, extra fingers, mutated hands, poorly drawn hands, poorly drawn face, mutation, deformed, bad anatomy, bad proportions, extra limbs, cloned face, disfigured, gross proportions, malformed limbs, missing arms, missing legs, fused fingers, too many fingers, long neck",
					"clip": ["1", 1],
				},
			},
			"4": {
				"class_type": "EmptyLatentImage",
				"inputs": { "width": 1024, "height": 1024, "batch_size": 1 },
			},
			// ★ img2img 分支（2026-09-02）：上游 images 端口参考图 → LoadImage →
			//   VAEEncode。无参考图时 KSampler 接 EmptyLatentImage（text2img），
			//   LoadImage 从输出节点反向**不可达 → ComfyUI 不执行**（安全）；
			//   有参考图时 runEmojiStageGrid 的 promptPostProcess 把 KSampler
			//   latent_image 切到 ["9",0] + denoise=0.75（与单格 fallback 同款）。
			"8": {
				"class_type": "LoadImage",
				"inputs": { "image": "material.png" },
			},
			"9": {
				"class_type": "VAEEncode",
				"inputs": {
					"pixels": ["8", 0],
					"vae": ["1", 2],
				},
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
					"filename_prefix": "ComfyTV/emoji_sheet",
				},
			},
		},
		result: { "type": "ui_save", "node": "7" },
		inputs: {
			"2": {
				"text": {
					"from": "main_prompt",
					"default": "a sticker sheet",
					// 无 suffix：拼贴 prompt 由执行器整体组装（含版式约束+每格描述）
					"required": false,
				},
			},
			"1": {
				// ★ ComfyUI 渠道的模型下拉（qwen/sdxl 等）→ checkpoint 注入
				"ckpt_name": {
					"from": "option:comfy_model",
					"default": "sd_xl_base_1.0.safetensors",
					"required": false,
				},
			},
			"5": {
				"seed": { "from": "option:seed", "default": "random_int31", "required": false, "cast": "int" },
			},
			// ★ 上游参考图注入（img2img）：有上游 images 快照时覆盖 LoadImage.image
			//   为 resolveImageRef 上传后的文件名；无参考图时保持默认（节点不可达不执行）。
			"8": {
				"image": {
					"from": "upstream_image:annotated",
					"default": "material.png",
					"required": false,
				},
			},
		},
	},
};

/**
 * 主题预设 → 完整主 prompt 模板映射。
 *
 * 每个中文主题对应一段**完整的主 prompt**（含主体描述 + 风格词 + 透明贴纸要求），
 * 运行时**直接作为每格 prompt 使用**（替代原"全局 prompt 兜底 + 主题后缀追加"机制）。
 *
 * 拼装优先级（runEmojiStageGrid）：
 *   严格 cell.prompt > 手填 cell.prompt > 上游文本 prompt[i] > 主题模板
 *
 * 用户若在某格单独写了 prompt，则**该格**以手填为准，不再套用主题模板；
 * 仅当一格无手填、无上游文本时，才回退到所选主题的完整模板。
 *
 * 键必须与 `STYLE_PRESETS`（StatEmojiStageEditor.tsx）及 registry.ts 的
 * `style_preset` COMBO options 完全一致；新增主题需三处同步。
 */
export const STYLE_PROMPT_TEMPLATE: Record<string, string> = {
	'Q版': 'a chibi style cartoon sticker, super deformed proportions, big head small body, cute mascot, thick outlines, vibrant colors, isolated on transparent background',
	'3D': 'a 3d rendered cartoon sticker, smooth claymation look, soft studio lighting, rounded forms, blender render, vibrant, isolated on transparent background',
	'手绘': 'a hand-drawn sketch cartoon sticker, ink lineart, slightly imperfect strokes, painterly, analog doodle, isolated on transparent background',
	'Meme': 'a bold impact-font meme sticker, high contrast, exaggerated facial expression, internet meme aesthetic, thick white outline, isolated on transparent background',
	'漫画封': 'a comic cover illustration sticker, cel shading, dramatic ink outlines, graphic novel panel art, isolated on transparent background',
	'粘土': 'a claymation cartoon sticker, fuzzy felt texture, stop-motion puppet look, matte clay surface, isolated on transparent background',
	'像素艺术': 'a pixel art game sprite sticker, limited color palette, visible square pixels, retro 8-bit style, isolated on transparent background',
	'可爱风': 'a kawaii style sticker, pastel colors, soft rounded shapes, sparkles, adorable sanrio-like character, isolated on transparent background',
};

/** 取主题对应的完整主 prompt 模板（未知主题回退空串）。 */
export function styleTemplateOf(preset: string | undefined): string {
	if (!preset) { return ''; }
	return STYLE_PROMPT_TEMPLATE[preset] ?? '';
}

/**
 * 静态表情包「生成图像大小」档位（2026-09-02）。
 *
 * 三处**必须同步**（同 STYLE_PROMPT_TEMPLATE 的三处约定）：
 *  1. registry.ts StatEmojiStage 的 `size` COMBO options；
 *  2. StatEmojiStageEditor 的尺寸下拉；
 *  3. workflowRun 的 resolveEmojiSheetSize（解析成 width/height）。
 *
 * 取值均为 **SDXL 友好分辨率**（64 的倍数、总像素接近 1024²）：
 *  - 1024×1024 默认：SDXL 原生分辨率，格位排布最稳；
 *  - 768×768：省显存/快（12GB 本机实测比 1024² 快一个量级），适合草稿；
 *  - 1152×896 / 896×1152 / 1216×832 / 832×1216：横竖构图变体。
 */
export const EMOJI_SHEET_SIZES: Array<{ value: string; label: string }> = [
	{ value: '1024x1024', label: '1024×1024（方形·推荐）' },
	{ value: '768x768', label: '768×768（方形·省显存）' },
	{ value: '1152x896', label: '1152×896（横向）' },
	{ value: '896x1152', label: '896×1152（纵向）' },
	{ value: '1216x832', label: '1216×832（宽幅）' },
	{ value: '832x1216', label: '832×1216（长幅）' },
];

/** 默认尺寸档位（与 registry `size` 默认值一致）。 */
export const EMOJI_SHEET_SIZE_DEFAULT = '1024x1024';
