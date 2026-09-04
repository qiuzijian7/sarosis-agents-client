/*---------------------------------------------------------------------------------------------
 *  removeBg — 「去背景」工具节点的纯逻辑层。
 *
 *  为什么纯前端实现（而非后端 stage / 云端模型）：
 *    - 抠图是本地服务能稳定做好的事：本地 rembg（U2Net/BiRefNet/Bria 系列）输出
 *      **真 RGBA 透明 PNG**，不依赖云端模型是否支持 `background=transparent`，
 *      无调用成本、可离线、无隐私外发；
 *    - 服务 = `G:\CustomWorkspaces\AIProjects\rembg\rembg_server.py`（极简 FastAPI，
 *      CORS 全开，契约与官方 `rembg s` 的 `POST /api/remove` 一致；webview CSP 的
 *      `connect-src` 已含 `http://127.0.0.1:*`，浏览器可直连，无需代理）。
 *
 *  本模块只放**纯函数**（类型谓词、widget 定义、参数解析），便于单测；
 *  真正的「取上游图 → POST rembg → 上传 → 写快照」在 removeBgExecutor.ts。
 *--------------------------------------------------------------------------------------------*/

import type { NodeSpec } from './registry.js';

/** 本项目「去背景」工具节点类型（手写注册，不在 comfyTVStageMeta.generated.ts）。 */
export const REMOVE_BG_TYPE = 'Saros.RemoveBg';

/** True 表示该节点走 removeBgExecutor（浏览器直连本地 rembg 服务）。 */
export function isRemoveBgNode(type: string): boolean {
	return type === REMOVE_BG_TYPE;
}

/** 本地 rembg 服务默认地址（rembg_server.py 默认端口 7000）。 */
export const REMBG_DEFAULT_URL = 'http://127.0.0.1:7000';

/** 默认模型：bria-rmbg 综合质量最好。 */
export const REMBG_DEFAULT_MODEL = 'bria-rmbg';

/** 免凭据常用模型（完整列表见 rembg `/healthz`；二次元用 isnet-anime，人像用 birefnet-portrait）。 */
export const REMBG_MODEL_OPTIONS: Array<{ value: string; label: string }> = [
	{ value: 'bria-rmbg', label: 'bria-rmbg（综合）' },
	{ value: 'isnet-general-use', label: 'isnet-general-use（通用）' },
	{ value: 'isnet-anime', label: 'isnet-anime（二次元）' },
	{ value: 'birefnet-general', label: 'birefnet-general（高精度）' },
	{ value: 'u2net', label: 'u2net（经典）' },
	{ value: 'u2netp', label: 'u2netp（轻量快速）' },
];

// ─── 参数（widget）定义 ─────────────────────────────────────────────────────

/**
 * 控件定义。命名沿用 ComfyTV 的 snake_case 惯例（alpha_matting / post_process），
 * 这样导入/导出工作流 JSON 时与后端字段风格一致。
 *
 * ★ 不暴露 rembg_url 为 widget：控件网格（comfyTV 分支）只支持
 *   COMBO/INT/FLOAT/BOOLEAN（nodeCard controls 白名单），服务地址用常量默认值，
 *   需要改端口时改 REMBG_DEFAULT_URL 或节点 properties（高级场景）。
 */
export const REMOVE_BG_WIDGETS: NodeSpec['widgets'] = [
	{ name: 'model', type: 'COMBO', default: REMBG_DEFAULT_MODEL, options: REMBG_MODEL_OPTIONS },
	// Alpha Matting：pymatting 边缘精细化（毛发/半透明边缘更好，但更慢且可能出噪点）
	{ name: 'alpha_matting', type: 'BOOLEAN', default: false },
	// 蒙版后处理（rembg 默认开）：去小噪点，多数场景建议保持开
	{ name: 'post_process', type: 'BOOLEAN', default: true },
];

/** 字符串参数取值（缺失/非法 → fallback）。纯函数。 */
export function rembgStr(values: Record<string, unknown>, key: string, fallback: string): string {
	const v = values[key];
	return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

/** 布尔参数取值：兼容 true / 1 / '1' / 'true'。缺失/空 → fallback。纯函数。 */
export function rembgBool(values: Record<string, unknown>, key: string, fallback: boolean): boolean {
	const v = values[key];
	if (v === undefined || v === null || v === '') { return fallback; }
	return v === true || v === 1 || v === '1' || v === 'true';
}

/** 解析后的去背景参数（供执行器与单测使用）。 */
export interface RembgParams {
	model: string;
	alphaMatting: boolean;
	postProcessMask: boolean;
}

/** 从节点 values 解析参数。纯函数（非法值一律回退默认，绝不抛错）。 */
export function resolveRembgParams(values: Record<string, unknown>): RembgParams {
	const model = rembgStr(values, 'model', REMBG_DEFAULT_MODEL);
	const known = REMBG_MODEL_OPTIONS.some((o) => o.value === model);
	return {
		model: known ? model : REMBG_DEFAULT_MODEL,
		alphaMatting: rembgBool(values, 'alpha_matting', false),
		postProcessMask: rembgBool(values, 'post_process', true),
	};
}
