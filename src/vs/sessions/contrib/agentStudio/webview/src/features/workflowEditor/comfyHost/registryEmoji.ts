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
import { EMOJI_SHEET_SIZES, EMOJI_SHEET_SIZE_DEFAULT } from './builtinWorkflows/emojiWorkflows.js';

/**
 * 表情包节点（静态 ComfyTV.StatEmojiStage + 动态 Saros.AnimatedEmoji 等）。
 * 拆自 registry.ts（2026-09-07）：注册副作用封装在函数内，由 registry.ts 在核心
 * 初始化完成后显式调用（规避 ESM 循环 import 的 TDZ/时序问题）。
 */
export function registerEmojiNodes(): void {
	// -- 表情包节点（静态 ComfyTV.StatEmojiStage + 动态 Saros.AnimatedEmoji 等） --
	// ── 表情包拆分为两个独立节点（2026-08-26）────────────────────────────────
	// 静态表情包：m×n 透明背景贴纸网格，主题预设作为 prompt 后缀（单一透明贴纸模板 + 风格）。
	// 动态表情包：参考图 → MiniMax H3 绿幕视频 → 前端抠图 → GIF 输出。
	// 两者均不在 comfyTVStageMeta.generated.ts（后端无此 stage），comfyTV 元数据显式声明。

	// StatEmojiStage — 静态表情包（m×n 透明背景贴纸网格）。
	// 主题预设（3D/Q版/手绘/Meme/漫画封/粘土/像素艺术/可爱风）作为 prompt 后缀注入。
	// variant='generator' → 有运行按钮；workflowKind='emoji' → 读 builtinWorkflows/emojiWorkflows。
	registerNodeSpec({
		type: 'ComfyTV.StatEmojiStage',
		kind: 'schema',
		title: '静态表情包',
		category: 'comfyTV',
		inputs: [
			// text = 单条文本输入（接 TextStage 输出作为表情描述）；
			// texts = 批量文本（逐格分配）；images = 参考图（slot 注入）。
			{ name: 'text', type: 'COMFYTV_TEXT' },
			{ name: 'texts', type: 'COMFYTV_TEXT' },
			{ name: 'images', type: 'COMFYTV_IMAGE' },
			// ★ sheet = 上游整图图集直通（2026-09）：连线时 runEmojiStageGrid 跳过
			//   生成，直接按 rows×cols 切分上游整图归档（外部拼贴图 / 上游
			//   EmojiStage 的 sheetFull 整图传递链）。零生成成本的图集入口。
			{ name: 'sheet', type: 'COMFYTV_IMAGE' },
		],
		outputs: [
			// images = m×n 表情批次；image = 当前选中格（selected_index）；
			// sheet = 原生整图图集（port 'sheet' 的 sheetFull 归档，供下游
			// EmojiStage 的 sheet 输入口直通连线）。
			{ name: 'images', type: 'COMFYTV_IMAGES' },
			{ name: 'image', type: 'COMFYTV_IMAGE' },
			{ name: 'sheet', type: 'COMFYTV_IMAGE' },
		],
		widgets: [
			{ name: 'workflow', type: 'COMBO', default: workflowOptionsFor('emoji')[0], options: workflowOptionsFor('emoji') },
			// 主题预设：作为 prompt 后缀的风格关键词（见 emojiWorkflows 的 SUFFIX 映射）。
			{ name: 'style_preset', type: 'COMBO', default: 'Q版', options: ['Q版', '3D', '手绘', 'Meme', '漫画封', '粘土', '像素艺术', '可爱风'] },
			// 生成渠道（2026-09-02）：'comfyui'（本地 ComfyUI，模型下拉 comfy_model）| 'provider'
			// （provider 图生图 RPC，provider/model 下拉）。StatEmojiStageEditor 选项卡消费。
			{ name: 'backend', type: 'COMBO', default: 'comfyui', options: ['comfyui', 'provider'] },
			// ComfyUI 渠道模型（checkpoint 文件名）→ 整图图集模板 option:comfy_model 注入
			// CheckpointLoaderSimple.ckpt_name；单格模板沿用 workflow 模板自身的 checkpoint。
			{ name: 'comfy_model', type: 'COMBO', default: 'sd_xl_base_1.0.safetensors', options: [] },
			// Provider 渠道（文生图命名约定：provider/model，supportsImageGen 过滤）
			{ name: 'provider', type: 'COMBO', default: '', options: [] },
			{ name: 'model', type: 'COMBO', default: '', options: [] },
			// ★ 生成图像大小（2026-09-02）：整图图集的**整版分辨率**（非单格尺寸）。
			//   provider → sendImageGen 的 width/height；comfyui → 覆盖模板
			//   EmptyLatentImage 的 width/height（promptPostProcess 注入）。
			//   选项见 emojiWorkflows.EMOJI_SHEET_SIZES（三处同步：registry / 编辑器 UI / 执行器）。
			{ name: 'size', type: 'COMBO', default: EMOJI_SHEET_SIZE_DEFAULT, options: EMOJI_SHEET_SIZES },
			{ name: 'rows', type: 'INT', default: 3, min: 1, max: 6 },
			{ name: 'cols', type: 'INT', default: 3, min: 1, max: 6 },
			{ name: 'prompt', type: 'TEXT', default: '' },
			{ name: 'cells', type: 'TEXT', default: '[]' },
			// m×n 每格裁剪框（归一化 [{x,y,w,h}]，JSON）——编辑器「调整裁剪」拖拽/缩放
			// 写回；runEmojiStageGrid 消费（缺省 = 等分 + margin 内缩）。
			{ name: 'cell_crops', type: 'TEXT', default: '' },
			{ name: 'selected_index', type: 'INT', default: 0, min: 0, max: 35 },
			// run_scope：'all'（生成全部）| 'cell'（只跑 selected_index 一格）。
			// 由 StatEmojiStageEditor 在点击运行前写回，workflowRun.runEmojiStageGrid 消费。
			{ name: 'run_scope', type: 'TEXT', default: 'all' },
			// 整版图集背景策略（2026-09-02）：'auto'（默认，不追加背景子句）|
			// 'transparent'（追加 isolated on transparent background）|
			// 'white'（追加 flat clean white background）。
			// ★ 切分不做抠图（2026-09-03 用户要求移除生成链路抠图）——透明化由
			//   prompt 约束或手动「去背景」（内置 U²Net）完成。
			{ name: 'sheet_background', type: 'COMBO', default: 'auto', options: ['auto', 'transparent', 'white'] },
			],
		color: '#e879f9',
		comfyTV: { stageKind: 'emoji', workflowKind: 'emoji', variant: 'generator' },
	});

	// VideoToGifStage — 视频转 GIF（浏览器本地执行，见 videoToGif.ts 顶部注释：
	// ComfyTV 无 gif stage，本机 ComfyUI 也只有 SaveAnimatedWEBP/PNG）。
	// variant='transform' → 无「生成」语义的运行按钮，改由 ACTIONS/参数变更驱动；
	// 输出 kind='image' → GIF 用 <img> 播放动图（标 video 会被 <video> 播成黑框）。
	// 同 EmojiStage：不在 comfyTVStageMeta.generated.ts，comfyTV 元数据显式声明。
}
