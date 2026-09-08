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
import { VIDEO_TO_GIF_TYPE, VIDEO_TO_GIF_WIDGETS } from './videoToGif.js';
import { REMOVE_BG_TYPE, REMOVE_BG_WIDGETS } from './removeBg.js';

/**
 * 工具节点（videoToGif/removeBg 等）。
 * 拆自 registry.ts（2026-09-07）：注册副作用封装在函数内，由 registry.ts 在核心
 * 初始化完成后显式调用（规避 ESM 循环 import 的 TDZ/时序问题）。
 */
export function registerToolNodes(): void {
	// -- 工具节点（videoToGif/removeBg 等） --
	registerNodeSpec({
		type: VIDEO_TO_GIF_TYPE,
		kind: 'schema',
		title: '视频转 GIF',
		category: 'comfyTV',
		inputs: [
			{ name: 'input', type: 'COMFYTV_VIDEO' },
		],
		outputs: [
			{ name: 'output', type: 'COMFYTV_IMAGE' },
		],
		widgets: VIDEO_TO_GIF_WIDGETS,
		color: '#22d3ee',
		comfyTV: { stageKind: 'video', workflowKind: 'video', variant: 'transform' },
	});
	// RemoveBgStage — 去背景（浏览器直连本地 rembg 服务，见 removeBg.ts 顶部注释：
	// rembg_server.py 输出真 RGBA 透明 PNG，不依赖云端模型 transparency 支持）。
	// variant='transform' → 无「生成」语义的运行按钮，改由 ACTIONS/参数变更驱动
	//（同 VideoToGif）；输出 COMFYTV_IMAGE → 下游 ImageStage / 导出直接可用。
	// 同 VideoToGif：不在 comfyTVStageMeta.generated.ts，comfyTV 元数据显式声明。
	registerNodeSpec({
		type: REMOVE_BG_TYPE,
		kind: 'schema',
		title: '去背景',
		category: 'comfyTV',
		inputs: [
			{ name: 'input', type: 'COMFYTV_IMAGE' },
		],
		outputs: [
			{ name: 'output', type: 'COMFYTV_IMAGE' },
		],
		widgets: REMOVE_BG_WIDGETS,
		color: '#38bdf8',
		comfyTV: { stageKind: 'image', workflowKind: 'image', variant: 'transform' },
	});
}

export function normalizePortType(t?: string): PortType {
	switch (t) {
		case 'IMAGE': case 'image': return 'IMAGE';
		case 'VIDEO': case 'video': return 'VIDEO';
		case 'AUDIO': case 'audio': return 'AUDIO';
		case 'TEXT': case 'text': return 'TEXT';
		case 'SAROS_JSON': case 'json': return 'SAROS_JSON';
		default: return 'ANY';
	}
}

export function normalizeNativeType(t: string): PortType {
	const lower = t.toLowerCase();
	if (lower.includes('image')) { return 'IMAGE'; }
	if (lower.includes('video')) { return 'VIDEO'; }
	if (lower.includes('audio')) { return 'AUDIO'; }
	if (lower.includes('string') || lower.includes('text')) { return 'TEXT'; }
	return 'ANY';
}
