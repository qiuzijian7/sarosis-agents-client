/*---------------------------------------------------------------------------------------------
 *  ComfyTV · Vox 口播视频工作流节点内置模板。
 *
 *  三个 stage（口播脚本 / vox 图像生成 / vox 视频生成）映射到 vox 管道
 *  （vox-skill: keyframes.py → clips.py → audio.py → assemble.py）。
 *
 *  ★ 与 imageWorkflows/videoWorkflows/storyboardWorkflows 一致：
 *    StageWorkflowConfig 的 api_json 真源是 ComfyUI 后端 vox 自定义节点的
 *    workflow（含 ComfyTV.UIOutput / SaveImage / SaveVideo 等 result 节点）。
 *    本项目完全不依赖 ComfyTV 后端 API，仅静态打包 api_json 后 POST /prompt。
 *
 *  ★ 真实 api_json 需在本机 ComfyUI 安装 vox 节点后由
 *    scripts/export-builtin-workflows.py 从 data.db 导出覆盖（见文件头
 *    AUTO-GENERATED 约定）。此处给出**结构契约正确**的占位模板：
 *      - 端口绑定 from 严格对齐 vox 参数（main_prompt / option:xxx /
 *        upstream_text / upstream_image:annotated[0] / upstream_video:annotated[0]）
 *      - result.type 用 graph_output_first / ui_save_batch / ui_save_url 等
 *        已被 stageWorkflowExecutor 支持的枚举
 *    占位 api_json 用最小可解析的 SaveImage/SaveVideo 占位节点，保证
 *    runStageWorkflow 的 findMissingNodeRefs / injectWorkflowValues / 快照归档
 *    全链路可跑（出图需替换为真实 vox 节点图）。
 *
 *  字段严格对齐 vox-skill/scripts/{keyframes,clips,audio,styles}.py：
 *    - 图像：image_model / aspect / image_resolution / style / collage_style /
 *           palette / theme / era
 *    - 视频：video_model / camera_move / motion_style / duration / element_motion
 *    - 口播：title_cn / title_en / beats[].narration / voice / music / aspect
 *--------------------------------------------------------------------------------------------*/

import type { StageWorkflowConfig } from '../stageWorkflowExecutor.js';

/* ── ① 口播脚本节点（kind: vox-script）──────────────────────────────────────
 * 走 LLM 后端（Qwen3 / 本地 LLM）生成 beats.json 结构文本。
 * 输出 COMFYTV_TEXT（下游图像/视频节点 texts 端口消费 narration）。 */
export const VOX_LOCAL_QWEN3_4B_SCRIPT: StageWorkflowConfig = {
	api_json: {
		"7": {
			"class_type": "TextGenerate",
			"inputs": {
				"clip": ["8", 0],
				"prompt": "Now ComfyUI has native LLM support, and you can use Qwen2.5 and Qwen3.0 series models",
				"max_length": 2048,
			},
		},
		"5": {
			"class_type": "PreviewAny",
			"inputs": {
				"source": ["7", 0],
			},
		},
		"8": {
			"class_type": "CLIPLoader",
			"inputs": {
				"clip_name": "qwen_3_4b.safetensors",
				"type": "ltxv",
			},
		},
	},
	result: {
		type: "graph_output_first",
		node: "7",
	},
	inputs: {
		"7": {
			"max_length": {
				from: "option:max_length",
				default: 6144,
				required: false,
				cast: "int",
			},
			"prompt": {
				from: "main_prompt",
				default: "为「{{topic}}」写一段口播脚本：标题中英、3-6 个镜头 beats，每个 beats 含 narration 与 scene，输出 JSON。",
				required: false,
			},
			"title_cn": {
				from: "option:title_cn",
				default: "",
				required: false,
			},
			"title_en": {
				from: "option:title_en",
				default: "",
				required: false,
			},
			"aspect": {
				from: "option:aspect",
				default: "9:16",
				required: false,
			},
			"language": {
				from: "option:language",
				default: "zh",
				required: false,
			},
			"theme": {
				from: "option:theme",
				default: "american-retro",
				required: false,
			},
		},
	},
};

/* ── ② vox 图像生成节点（kind: vox-image）──────────────────────────────────
 * 消费上游 texts（narration/scene）作为每张 keyframe 的 prompt。
 * 输出 COMFYTV_IMAGES（每个 shot 一张关键帧海报）。 */
export const VOX_LOCAL_FLUX_DEV_KEYFRAME: StageWorkflowConfig = {
	api_json: {
		"3": {
			"class_type": "KSampler",
			"inputs": {
				"model": ["4", 0],
				"positive": ["6", 0],
				"negative": ["7", 0],
				"latent_image": ["5", 0],
				"seed": 0,
				"steps": 20,
				"cfg": 7.0,
				"sampler_name": "euler",
				"scheduler": "normal",
				"denoise": 1.0,
			},
		},
		"4": {
			"class_type": "CheckpointLoaderSimple",
			"inputs": {
				"ckpt_name": "flux-dev.safetensors",
			},
		},
		"5": {
			"class_type": "EmptyLatentImage",
			"inputs": {
				"width": 1024,
				"height": 1024,
				"batch_size": 1,
			},
		},
		"6": {
			"class_type": "CLIPTextEncode",
			"inputs": {
				"clip": ["8", 0],
				"text": "vox keyframe poster",
			},
		},
		"7": {
			"class_type": "CLIPTextEncode",
			"inputs": {
				"clip": ["8", 0],
				"text": "",
			},
		},
		"8": {
			"class_type": "CLIPLoader",
			"inputs": {
				"clip_name": "flux-dev.safetensors",
				"type": "flux",
			},
		},
		"9": {
			"class_type": "VAEDecode",
			"inputs": {
				"samples": ["3", 0],
				"vae": ["10", 0],
			},
		},
		"10": {
			"class_type": "VAELoader",
			"inputs": {
				"vae_name": "ae.safetensors",
			},
		},
		"11": {
			"class_type": "PreviewAny",
			"inputs": {
				"source": ["9", 0],
			},
		},
		"12": {
			"class_type": "VoxSaveImages",
			"inputs": {
				"images": ["9", 0],
				"filename_prefix": "vox/keyframe",
			},
		},
	},
	result: {
		type: "ui_save_batch",
		node: "12",
	},
	inputs: {
		"6": {
			"text": {
				from: "upstream_text:annotated[0]",
				default: "",
				required: true,
				error: "vox 图像生成需要上游口播脚本节点的 texts（scene/narration）输入。",
			},
		},
		"5": {
			"width": {
				from: "computed:width",
				required: false,
				cast: "int",
			},
			"height": {
				from: "computed:height",
				required: false,
				cast: "int",
			},
		},
		"4": {
			"ckpt_name": {
				from: "option:image_model",
				default: "flux-dev.safetensors",
				required: false,
			},
		},
		"3": {
			"steps": {
				from: "option:steps",
				default: 20,
				required: false,
				cast: "int",
			},
			"cfg": {
				from: "option:cfg",
				default: 7.0,
				required: false,
				cast: "float",
			},
			"seed": {
				from: "option:seed",
				default: "random_int31",
				required: false,
				cast: "int",
			},
		},
	},
};

/* ── ③ vox 视频生成节点（kind: vox-video）──────────────────────────────────
 * 消费上游 images（关键帧海报）作为首帧，加 camera_move / motion_style 生成
 * 每个 shot 的短视频片段。输出 COMFYTV_VIDEO。 */
export const VOX_LOCAL_LTX_2_3_FLF2V: StageWorkflowConfig = {
	api_json: {
		"75": {
			"class_type": "SaveVideo",
			"inputs": {
				"filename_prefix": "video/vox_flf2v",
				"format": "auto",
				"images": ["73", 0],
			},
		},
		"73": {
			"class_type": "VoxImageToVideo",
			"inputs": {
				"image": ["12", 0],
				"camera_move": "static",
				"motion_style": "calm",
				"duration": 4,
				"element_motion": "auto",
			},
		},
		"74": {
			"class_type": "VoxSaveVideo",
			"inputs": {
				"images": ["73", 0],
				"filename_prefix": "video/vox_flf2v",
			},
		},
		"12": {
			"class_type": "LoadImage",
			"inputs": {
				"image": "example.png",
			},
		},
	},
	result: {
		type: "ui_save_url",
		node: "74",
	},
	inputs: {
		"73": {
			"image": {
				from: "upstream_image:annotated[0]",
				required: true,
				error: "vox 视频生成需要上游图像节点的关键帧（images 端口）。",
			},
			"camera_move": {
				from: "option:camera_move",
				default: "static",
				required: false,
			},
			"motion_style": {
				from: "option:motion_style",
				default: "calm",
				required: false,
			},
			"duration": {
				from: "option:duration",
				default: 4,
				required: false,
				cast: "int",
			},
			"element_motion": {
				from: "option:element_motion",
				default: "auto",
				required: false,
			},
		},
	},
};

export const VOX_BUILTIN_WORKFLOWS: Record<string, StageWorkflowConfig> = {
	"Local Qwen3 4B Script": VOX_LOCAL_QWEN3_4B_SCRIPT,
	"Local Flux Dev Keyframe": VOX_LOCAL_FLUX_DEV_KEYFRAME,
	"Local LTX 2.3 FLF2V": VOX_LOCAL_LTX_2_3_FLF2V,
};
