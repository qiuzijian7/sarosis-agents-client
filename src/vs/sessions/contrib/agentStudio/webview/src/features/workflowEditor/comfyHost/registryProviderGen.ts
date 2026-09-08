/*---------------------------------------------------------------------------------------------
 *  LiteGraph Node Registry — three-tier node registration.
 *
 *  Keeps all LiteGraph interaction behind a small facade so tests can run without
 *  touching the real @comfyorg/litegraph singleton, and so the webview never calls
 *  `LiteGraph.registerNodeType` directly.
 *
 *  Node kinds:
 *   - 'react'  : existing Saros.* nodes, cards rendered as React components
 *                (React is preserved; no Vue bridge).
 *   - 'schema' : ComfyTV-style stages. Only the registration info (kind/inputs/outputs)
 *                is consumed; the card is rendered by a React component driven by that schema.
 *   - 'native' : ComfyUI native nodes, dynamically registered from /object_info.
 *
 *  Port type vocabulary (mirrors LiteGraph link `type`):
 *   'IMAGE' | 'VIDEO' | 'AUDIO' | 'TEXT' | 'SAROS_JSON' | 'ANY'
 *--------------------------------------------------------------------------------------------*/
import {
	registerNodeSpec,
	SAROS_NODE_COLORS,
	workflowOptionsFor,
	WEIXIN_EXPORT_TARGETS,
	COMFYTV_RESOLUTIONS,
	COMFYTV_ASPECT_RATIOS,
	COMFYTV_IMAGE_WORKFLOWS,
	type PortSpec,
	type NodeSpec,
	type PortType,
	type NodeKind,
} from './registry.js';
import { parseSize, findUpstreamImageRef } from './imageGenBackend.js';

/**
 * Provider 生成节点族（ModelImageGen/ModelVideoGen/AnimatedEmoji/Model3D/ModelText/ModelAudio/微信表情封面）。
 * 拆自 registry.ts（2026-09-07）：注册副作用封装在函数内，由 registry.ts 在核心
 * 初始化完成后显式调用（规避 ESM 循环 import 的 TDZ/时序问题）。
 */
export function registerProviderGenNodes(): void {
	// -- Provider 生成节点族（ModelImageGen/ModelVideoGen/AnimatedEmoji/Model3D/ModelText/ModelAudio/微信表情封面） --
	registerNodeSpec({
		type: 'Saros.ModelImageGen',
		kind: 'schema',
		title: '图片生成',
		category: 'saros',
		inputs: [
			{ name: 'texts', type: 'COMFYTV_TEXT' },
			{ name: 'images', type: 'COMFYTV_IMAGE' },
		],
		outputs: [
			{ name: 'images', type: 'COMFYTV_IMAGES' },
			{ name: 'image', type: 'COMFYTV_IMAGE' },
		],
		widgets: [
			// ── Provider & Model ──────────────────────────────────────
			// provider 选择（COMBO，nodeCard 动态填充已认证文生图 provider）
			{ name: 'provider', type: 'COMBO', default: '', options: [] },
			// model 选择（COMBO，随 provider 联动）
			{ name: 'model', type: 'COMBO', default: '', options: [] },
			// ── 图像规格 ─────────────────────────────────────────────
			// 预设尺寸（优先级高于 custom_width/height；空串=使用自定义尺寸）
			{ name: 'size', type: 'COMBO', default: '', options: [
				{ value: '', label: '自定义' },
				{ value: '1024x1024', label: '1024×1024 (方形)' },
				{ value: '1792x1024', label: '1792×1024 (横版)' },
				{ value: '1024x1792', label: '1024×1792 (竖版)' },
				{ value: '2048x1152', label: '2048×1152 (宽屏)' },
				{ value: '1152x2048', label: '1152×2048 (长屏)' },
			]},
			// 自定义宽度（size 为空时生效）
			{ name: 'custom_width', type: 'INT', default: 1024 },
			// 自定义高度（size 为空时生效）
			{ name: 'custom_height', type: 'INT', default: 1024 },
			// ── 生成控制 ─────────────────────────────────────────────
			// 质量（GPT Image 等 provider 特有：standard/high）
			{ name: 'quality', type: 'COMBO', default: 'standard', options: [
				{ value: 'standard', label: '标准' },
				{ value: 'high', label: '高质量' },
			]},
			// 批量出图数量
			{ name: 'numImages', type: 'INT', default: 1, min: 1, max: 10 },
			// 可复现种子（-1 = 随机）
			{ name: 'seed', type: 'INT', default: -1 },
			// ── 提示词 ───────────────────────────────────────────────
			// 正面提示词
			{ name: 'prompt', type: 'TEXT', default: '' },
			// 负面提示词（部分 provider 支持，如 ComfyUI 后端 / SDXL）
			{ name: 'negativePrompt', type: 'TEXT', default: '' },
		],
		backendKind: 'provider',
		providerCaps: 'imageGen',
		color: '#06b6d4',
		comfyTV: { stageKind: 'image', workflowKind: 'image-to-image' },
	});
	// ── Provider 视频生成节点（模型文生视频）──────────────────────────────────
	// 经 videogen.generate RPC 走 provider 的 generateVideo()（扩展命令转发，
	// 如 lightai-provider 的 floodGen：MiniMax H3 / 混元视频）。纯 provider
	// 后端，不依赖 ComfyUI runner；输出 VIDEO 快照可与 Comfy 视频节点接力。
	//
	// 参数对齐主流图生视频 provider（2026-09-01，lightflood 协议）：
	//   - duration 时长档位（4-15 秒，MiniMax H3）
	//   - resolution 分辨率（768P / 2K）
	//   - ratio 画面比例（图生视频时 provider 自动 adaptive）
	// widget 名用 videoProvider/videoModel（区别于文生图的 provider/model），
	// resolveControlOptions 按名过滤 supportsVideoGen 模型。
	registerNodeSpec({
		type: 'Saros.ModelVideoGen',
		kind: 'schema',
		title: '视频生成',
		category: 'saros',
		inputs: [
			{ name: 'texts', type: 'COMFYTV_TEXT' },
			{ name: 'images', type: 'COMFYTV_IMAGE' },
		],
		outputs: [
			{ name: 'videos', type: 'COMFYTV_VIDEO' },
			{ name: 'video', type: 'COMFYTV_VIDEO' },
		],
		widgets: [
			{ name: 'videoProvider', type: 'COMBO', default: '', options: [] },
			{ name: 'videoModel', type: 'COMBO', default: '', options: [] },
			// 视频时长（秒；MiniMax H3 支持 4-15，provider 按档位取整）
			{ name: 'duration', type: 'COMBO', default: '5', options: [
				{ value: '4', label: '4 秒' },
				{ value: '5', label: '5 秒' },
				{ value: '6', label: '6 秒' },
				{ value: '8', label: '8 秒' },
				{ value: '10', label: '10 秒' },
				{ value: '12', label: '12 秒' },
				{ value: '15', label: '15 秒' },
			]},
			// 分辨率档位（provider 特有）
			{ name: 'resolution', type: 'COMBO', default: '2K', options: [
				{ value: '768P', label: '768P' },
				{ value: '2K', label: '2K' },
			]},
			// 画面比例（文生视频必选具体值；图生视频 provider 自动 adaptive）
			{ name: 'ratio', type: 'COMBO', default: '16:9', options: [
				{ value: 'auto', label: '自动' },
				{ value: '21:9', label: '21:9' },
				{ value: '16:9', label: '16:9' },
				{ value: '4:3', label: '4:3' },
				{ value: '1:1', label: '1:1' },
				{ value: '3:4', label: '3:4' },
				{ value: '9:16', label: '9:16' },
			]},
			{ name: 'prompt', type: 'TEXT', default: '' },
		],
		backendKind: 'provider',
		providerCaps: 'videoGen',
		color: '#3f8a5a',
		comfyTV: { stageKind: 'video', workflowKind: 'video' },
	});

	// ── Provider 3D 模型生成节点 ─────────────────────────────────────────────
	// 经 modelgen.generate RPC 走 provider 的 generateModel3D()（如 lightai
	// floodGen 的混元 3.5 文生/图生 3D）。输出 IMAGE 预览快照（3D 渲染图）
	// + TEXT 端口输出 glb 下载链接，供下游节点/Agent 消费；产物多格式
	// 源文件（fbx/obj）记录在快照 meta.modelUrl / meta.sources。
	// widget 名 m3dProvider/m3dModel → resolveControlOptions 过滤 supportsModelGen。
	registerNodeSpec({
		type: 'Saros.Model3DGen',
		kind: 'schema',
		title: '3D 模型生成',
		category: 'saros',
		inputs: [
			{ name: 'texts', type: 'COMFYTV_TEXT' },
			{ name: 'images', type: 'COMFYTV_IMAGE' },
		],
		outputs: [
			{ name: 'preview', type: 'COMFYTV_IMAGE' },
			{ name: 'model_url', type: 'COMFYTV_TEXT' },
		],
		widgets: [
			{ name: 'm3dProvider', type: 'COMBO', default: '', options: [] },
			{ name: 'm3dModel', type: 'COMBO', default: '', options: [] },
			// 目标面数（provider 特有；auto = 跟随精度档位）
			{ name: 'faceCount', type: 'COMBO', default: 'auto', options: [
				{ value: 'auto', label: '自动' },
				{ value: '100000', label: '10 万面' },
				{ value: '300000', label: '30 万面' },
				{ value: '600000', label: '60 万面' },
				{ value: '1500000', label: '150 万面' },
			]},
			// PBR 材质（混元 3.5 支持）
			{ name: 'enablePbr', type: 'COMBO', default: 'false', options: [
				{ value: 'false', label: '关' },
				{ value: 'true', label: '开' },
			]},
			{ name: 'prompt', type: 'TEXT', default: '' },
		],
		backendKind: 'provider',
		providerCaps: 'modelGen',
		color: '#8a5a7a',
		comfyTV: { stageKind: 'image', workflowKind: 'image' },
	});
	// （音频生成节点见下方 Saros.AudioGen —— TTS/音乐统一走该节点，
	//   lightai 的 audio_* 模型经 audiogen.generate RPC 接入。）
	// ── Provider 文本生成节点 ────────────────────────────────────────────────
	// 经 textgen.generate RPC 走 provider.chat()（流式聚合，与反推提示词同机制）。
	// 纯 provider 后端，不依赖 ComfyUI runner；输出 TEXT 快照可与 ComfyTV 文本链路
	// （口播脚本 / 模型文生图 / 文生视频 prompt 端口）直接接力。
	// widget 名 textProvider/textModel → chat 是模型通用能力，model 下拉不按
	// 能力标志过滤（全模型可选，nodeCard.resolveControlOptions 同步）。
	registerNodeSpec({
		type: 'Saros.TextGen',
		kind: 'schema',
		title: '文本生成',
		category: 'saros',
		inputs: [
			{ name: 'texts', type: 'COMFYTV_TEXT' },
		],
		outputs: [
			{ name: 'texts', type: 'COMFYTV_TEXT' },
			{ name: 'text', type: 'COMFYTV_TEXT' },
		],
		widgets: [
			{ name: 'textProvider', type: 'COMBO', default: '', options: [] },
			{ name: 'textModel', type: 'COMBO', default: '', options: [] },
			// 采样温度（0 = 贪婪；provider 默认 0.7）
			{ name: 'temperature', type: 'COMBO', default: '0.7', options: [
				{ value: '0', label: '0（精确）' },
				{ value: '0.4', label: '0.4' },
				{ value: '0.7', label: '0.7（默认）' },
				{ value: '1.0', label: '1.0' },
			]},
			// 系统提示（可选；为角色/格式约束预留）
			{ name: 'system', type: 'TEXT', default: '' },
			// 用户提示词（支持 {{input}} 上游模板 / @[node:] mention）
			{ name: 'prompt', type: 'TEXT', default: '' },
		],
		backendKind: 'provider',
		providerCaps: 'chat',
		color: '#3b82f6',
		comfyTV: { stageKind: 'text', workflowKind: 'text' },
	});
	// ── Provider 音频生成节点 ────────────────────────────────────────────────
	// 经 audiogen.generate RPC 走 provider.generateAudio()（扩展命令转发，同
	// videogen/modelgen 模式）。纯 provider 后端，不依赖 ComfyUI runner；输出
	// AUDIO 快照可与 ComfyTV 音频链路（视频配音 / 口播导演 audio 端口）接力。
	// widget 名 audioProvider/audioModel → resolveControlOptions 按
	// supportsAudioGen 过滤模型。
	registerNodeSpec({
		type: 'Saros.AudioGen',
		kind: 'schema',
		title: '音频生成',
		category: 'saros',
		inputs: [
			{ name: 'texts', type: 'COMFYTV_TEXT' },
		],
		outputs: [
			{ name: 'audios', type: 'COMFYTV_AUDIO' },
			{ name: 'audio', type: 'COMFYTV_AUDIO' },
		],
		widgets: [
			{ name: 'audioProvider', type: 'COMBO', default: '', options: [] },
			{ name: 'audioModel', type: 'COMBO', default: '', options: [] },
			// 音频时长（秒；provider 按档位取整，空 = provider 默认）
			{ name: 'duration', type: 'COMBO', default: '', options: [
				{ value: '', label: '自动' },
				{ value: '15', label: '15 秒' },
				{ value: '30', label: '30 秒' },
				{ value: '60', label: '60 秒' },
				{ value: '120', label: '2 分钟' },
				{ value: '240', label: '4 分钟' },
			]},
			// 生成数量
			{ name: 'numAudios', type: 'INT', default: 1, min: 1, max: 4 },
			// 提示词（风格/情绪/乐器等）
			{ name: 'prompt', type: 'TEXT', default: '' },
			// 歌词（可选；音乐类 provider 用，空 = 纯器乐）
			{ name: 'lyrics', type: 'TEXT', default: '' },
		],
		backendKind: 'provider',
		providerCaps: 'audioGen',
		color: '#f59e0b',
		comfyTV: { stageKind: 'audio', workflowKind: 'audio' },
	});
	// ── 微信表情包封面节点（provider 图像生成特化）─────────────────────────
	// 微信表情包开放平台「表情封面图」规范（240×240 PNG ≤500KB，艺术家主页
	// 列表展示）：透明背景、建议半身/全身像、无白边/锯齿/装饰/文字、避免白色
	// 背景。默认 prompt 模板已编码全部规范；{{character}}/{{style}}/{{framing}}
	// 引用本节点控件（runProviderImage 的 named 注入展开），填「角色描述」即出图。
	// 复用 runProviderImage（backendKind='provider' 自动路由），零新增执行代码。
	registerNodeSpec({
		type: 'Saros.WeixinStickerCover',
		kind: 'schema',
		title: '微信表情包封面',
		category: 'saros',
		inputs: [
			{ name: 'texts', type: 'COMFYTV_TEXT' },
			{ name: 'images', type: 'COMFYTV_IMAGE' },
		],
		outputs: [
			{ name: 'images', type: 'COMFYTV_IMAGES' },
			{ name: 'image', type: 'COMFYTV_IMAGE' },
		],
		widgets: [
			// 处理模式：生成（文生图，走 provider）| 导出规格化（上游批量图片按
			// 微信素材规格本地转换——缩放/格式/体积控制，浏览器 canvas 执行）
			{ name: 'mode', type: 'COMBO', default: '生成', options: ['生成', '导出规格化'] },
			// 导出目标（微信素材三规格；仅「导出规格化」模式生效）：切换时由
			// nodeCard 联动同步 size/custom_width/custom_height（WEIXIN_EXPORT_TARGETS）
			{ name: 'exportTarget', type: 'COMBO', default: '表情封面图', options: ['表情封面图', '聊天页图标', '详情页横幅'] },
			{ name: 'provider', type: 'COMBO', default: '', options: [] },
			{ name: 'model', type: 'COMBO', default: '', options: [] },
			// 表情角色描述（核心输入；空 = 通用可爱卡通角色）
			{ name: 'character', type: 'TEXT', default: '' },
			// 构图档位（规范：建议半身/全身像）
			{ name: 'framing', type: 'COMBO', default: '半身像', options: ['半身像', '全身像', '头像特写'] },
			// 表情风格
			{ name: 'style', type: 'COMBO', default: '软萌可爱', options: ['软萌可爱', '像素风', '扁平插画', '3D渲染', '手绘线稿'] },
			// 输出尺寸（生成模式用；含三种微信规格档，与 exportTarget 联动）
			{ name: 'size', type: 'COMBO', default: '240x240', options: [
				{ value: '240x240', label: '240×240（封面规范）' },
				{ value: '50x50', label: '50×50（图标规范）' },
				{ value: '750x400', label: '750×400（横幅规范）' },
				{ value: '512x512', label: '512×512（高清）' },
				{ value: '1024x1024', label: '1024×1024' },
				{ value: '', label: '自定义' },
			]},
			{ name: 'custom_width', type: 'INT', default: 240 },
			{ name: 'custom_height', type: 'INT', default: 240 },
			{ name: 'numImages', type: 'INT', default: 1, min: 1, max: 8 },
			{ name: 'seed', type: 'INT', default: -1 },
			// 提示词：默认模板已编码微信规范；{{character}} 空 → 展开为空串不留孤立占位
			{ name: 'prompt', type: 'TEXT', default: '微信表情包封面插画：{{character}}{{style}}风格，{{framing}}居中构图，姿态生动可爱。透明背景（PNG 通道），避免纯白色背景；无白边、无锯齿、无生硬直角、无装饰边框、无文字水印；构图合理少留白，色彩鲜明，适合微信聊天表情场景。' },
			{ name: 'negativePrompt', type: 'TEXT', default: '白边, 锯齿, 生硬直角, 装饰边框, 文字, 水印, 纯白色背景, 复杂背景装饰' },
		],
		backendKind: 'provider',
		providerCaps: 'imageGen',
		color: '#07c160',
		comfyTV: { stageKind: 'image', workflowKind: 'text-to-image' },
	});
}
