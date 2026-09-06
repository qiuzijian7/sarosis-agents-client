/*---------------------------------------------------------------------------------------------
 *  comfyCutout — 「AI 去背景」的 ComfyUI 执行端（webview 侧）。
 *
 *  2026-09-06：处理端从「主进程 ONNX U²Net（cutout.remove RPC + ~/.vssaros 缓存）」
 *  迁移为 **ComfyUI 自定义节点 saros_cutout（SarosBiRefNetCutout，GPU/CPU 自动）**。
 *  主进程不再参与：无 cutout.* RPC、无模型下载/缓存 —— 模型唯一落盘位置是
 *  ComfyUI 的 models/onnx/（由用户/部署方放置，节点运行时枚举）。
 *
 *  链路：bytes/dataURL → POST /upload/image → 内置三节点工作流
 *        （LoadImage → SarosBiRefNetCutout → SaveImage，经 runner.invoke 轮询）
 *        → /view 拉回 RGBA 透明 PNG（经 createComfyFetch，跨源/代理兜底）。
 *--------------------------------------------------------------------------------------------*/

import type { ComfyRunProgress, IComfyRunner } from './comfyRunner.js';
import { createComfyFetch } from '../../../bridge/messageClient.js';
import { getActiveRunnerPreference, getActiveRunnerRegistry } from './runnerContext.js';

/** 与 comfyHost/builtinWorkflows/cutoutWorkflows.ts 的 api_json 节点号保持一致。 */
const LOAD_IMAGE_NODE = '17';
const CUTOUT_NODE = '19';
const SAVE_IMAGE_NODE = '18';

/** saros_cutout 自定义节点的注册名（/object_info 键 + class_type）。 */
const CUTOUT_NODE_CLASS = 'SarosBiRefNetCutout';

/** 默认模型文件名（saros_cutout 的 DEFAULT_MODEL，位于 ComfyUI models/onnx/）。 */
const DEFAULT_CUTOUT_MODEL_FILE = 'BiRefNet-general-epoch_244.onnx';

/**
 * 阶段回调（旧 cutoutAi.CutoutProgressCallback 的收窄版）：模型下载/字节级进度
 * 已随主进程链路移除，只剩阶段文本，供 UI busy 标签/进度条消费。
 */
export type CutoutProgressCallback = (text: string) => void;

/** 每个 baseUrl 复用一个 fetch（内含 CORS 模式探测缓存）。 */
const comfyFetchCache = new Map<string, typeof fetch>();

function getComfyFetch(baseUrl: string): typeof fetch {
	let fetchImpl = comfyFetchCache.get(baseUrl);
	if (!fetchImpl) {
		fetchImpl = createComfyFetch(baseUrl);
		comfyFetchCache.set(baseUrl, fetchImpl);
	}
	return fetchImpl;
}

/**
 * 从 miniEditorAi / nodeCard 等无 props 上下文解析当前活动 runner。
 * registry 由 WorkflowEditorPanel 初始化（setActiveRunnerRegistry），缺省即「未连接」。
 */
export function resolveActiveComfyRunner(): IComfyRunner {
	const registry = getActiveRunnerRegistry();
	const runner = registry?.resolve(getActiveRunnerPreference()) ?? registry?.list()[0];
	if (!runner) {
		throw new Error(buildNotConnectedMessage());
	}
	return runner;
}

function buildNotConnectedMessage(): string {
	return 'ComfyUI 未连接：请先在工作流面板连接一个 ComfyUI 运行器（去背景由 ComfyUI 的 saros_cutout 节点执行，环境安装见 docs/ComfyUI-去背景环境安装指南.md）。';
}

/**
 * 环境预检：未连接 / 缺节点 / 缺模型 三级诊断。
 *
 * 一次 GET /object_info 同时覆盖两类问题：
 *  - 响应缺 `SarosBiRefNetCutout` 键 → 节点未安装（或 ComfyUI 启动时 import 报错）；
 *  - 节点定义存在但 model 枚举为空/回退值 → models/onnx/ 里没放 .onnx（节点
 *    INPUT_TYPES 的 model 下拉来自 _list_models()，目录为空时回退 DEFAULT_MODEL）。
 * 返回错误信息（可直接 throw），null = 环境就绪。
 */
export async function checkCutoutEnvironment(runner: IComfyRunner): Promise<string | null> {
	let content: string;
	try {
		const resp = await getComfyFetch(runner.baseUrl)(`${runner.baseUrl}/object_info`);
		if (!resp.ok) {
			return `无法访问 ComfyUI（HTTP ${resp.status}）：${runner.baseUrl} —— 请确认 ComfyUI 已启动。`;
		}
		content = await resp.text();
	} catch (err) {
		return `无法访问 ComfyUI（${err instanceof Error ? err.message : String(err)}）：${runner.baseUrl} —— 请确认 ComfyUI 已启动。`;
	}
	const entries = JSON.parse(content) as Record<string, unknown>;
	if (!(CUTOUT_NODE_CLASS in entries)) {
		return 'ComfyUI 缺少去背景节点 SarosBiRefNetCutout：请安装 saros_cutout 自定义节点'
			+ '（一键脚本 setup-saros-cutout.ps1，或见 docs/ComfyUI-去背景环境安装指南.md）。';
	}
	const nodeInfo = entries[CUTOUT_NODE_CLASS] as { input?: { required?: Record<string, unknown> } } | undefined;
	const modelOptions = nodeInfo?.input?.required?.['model'];
	const enumValues = Array.isArray(modelOptions) && Array.isArray(modelOptions[0]) ? modelOptions[0] as unknown[] : [];
	if (enumValues.length === 0) {
		return 'ComfyUI 缺少去背景模型：models/onnx/ 下没有 .onnx 文件，请下载 BiRefNet-general'
			+ '（一键脚本 setup-saros-cutout.ps1，或见 docs/ComfyUI-去背景环境安装指南.md）。';
	}
	return null;
}

/** data: URL → Blob（webview CSP 的 connect-src 不含 data:，必须本地解码）。 */
function dataUrlToBlob(url: string): Blob {
	const comma = url.indexOf(',');
	if (comma < 0) { throw new TypeError('Invalid data: URL'); }
	const meta = url.slice(5, comma);
	const payload = url.slice(comma + 1);
	const isB64 = /;base64$/i.test(meta);
	const contentType = (isB64 ? meta.replace(/;base64$/i, '') : meta) || 'application/octet-stream';
	if (!isB64) { return new Blob([decodeURIComponent(payload)], { type: contentType }); }
	const bin = atob(payload);
	const arr = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) { arr[i] = bin.charCodeAt(i); }
	return new Blob([arr as unknown as BlobPart], { type: contentType });
}

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const fr = new FileReader();
		fr.onload = () => resolve(String(fr.result ?? ''));
		fr.onerror = () => reject(fr.error ?? new Error('读取去背景结果失败'));
		fr.readAsDataURL(blob);
	});
}

/** 上传图像到 ComfyUI input/，返回 LoadImage 可用的文件名。 */
async function uploadImageToComfy(runner: IComfyRunner, blob: Blob, onStatus?: CutoutProgressCallback): Promise<string> {
	onStatus?.('上传图像到 ComfyUI…');
	// 文件名必须唯一：ComfyUI 覆盖同名文件返回同一 name → 浏览器命中磁盘缓存显示旧图。
	const name = `saros-cutout-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`;
	const form = new FormData();
	form.append('image', blob, name);
	const resp = await runner.fetchApi?.('/upload/image', { method: 'POST', body: form });
	const data = await resp?.json() as { name?: string; error?: string } | undefined;
	const uploaded = String(data?.name ?? '');
	if (!uploaded) {
		throw new Error(`上传图像到 ComfyUI 失败：${data?.error ?? `HTTP ${resp?.status ?? '??'}`}`);
	}
	return uploaded;
}

/**
 * 跑内置抠图工作流（LoadImage → SarosBiRefNetCutout → SaveImage），
 * 返回 SaveImage 落盘文件的 view 查询串（filename/subfolder/type）。
 */
async function runCutoutWorkflow(
	runner: IComfyRunner,
	uploadedName: string,
	onStatus?: CutoutProgressCallback,
): Promise<{ filename: string; subfolder: string; type: string }> {
	const prompt = {
		[LOAD_IMAGE_NODE]: { class_type: 'LoadImage', inputs: { image: uploadedName } },
		[CUTOUT_NODE]: {
			class_type: CUTOUT_NODE_CLASS,
			inputs: { image: [LOAD_IMAGE_NODE, 0], model: DEFAULT_CUTOUT_MODEL_FILE },
		},
		[SAVE_IMAGE_NODE]: {
			class_type: 'SaveImage',
			inputs: { filename_prefix: 'SarosCutout', images: [CUTOUT_NODE, 0] },
		},
	};
	const result = await runner.invoke({
		prompt,
		onProgress: (p: ComfyRunProgress) => {
			if (typeof p.value === 'number') {
				onStatus?.(`抠图推理中 ${Math.round(p.value)}%…`);
			} else if (p.message) {
				onStatus?.(p.message);
			}
		},
	});
	if (result.status === 'canceled') { throw new Error('去背景已取消'); }
	if (result.status !== 'success') {
		throw new Error(result.error ?? 'ComfyUI 抠图执行失败');
	}
	const saveOutputs = result.outputs[SAVE_IMAGE_NODE] as { images?: Array<{ filename?: string; subfolder?: string; type?: string }> } | undefined;
	const image = saveOutputs?.images?.[0];
	if (!image?.filename) {
		throw new Error('ComfyUI 抠图完成但未返回图像输出（SaveImage 节点无 images）');
	}
	return { filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' };
}

/** 从 ComfyUI /view 拉回结果图像 bytes（跨源 → createComfyFetch 代理兜底）。 */
async function fetchOutputBytes(runner: IComfyRunner, out: { filename: string; subfolder: string; type: string }): Promise<Uint8Array> {
	const query = `filename=${encodeURIComponent(out.filename)}`
		+ (out.subfolder ? `&subfolder=${encodeURIComponent(out.subfolder)}` : '')
		+ `&type=${encodeURIComponent(out.type)}`;
	const resp = await getComfyFetch(runner.baseUrl)(`${runner.baseUrl}/view?${query}`);
	if (!resp.ok) { throw new Error(`读取抠图结果失败：HTTP ${resp.status}`); }
	return new Uint8Array(await resp.arrayBuffer());
}

/**
 * 核心流程：bytes → 上传 → 抠图工作流 → 拉回透明 PNG。
 * 同时返回 Blob 与 ComfyUI output 的 view URL —— 调用方可直接把 view URL 作为
 * 快照 ref（下游 LoadImage / 持久化可直接引用，无需二次上传）。
 */
export async function comfyRemoveBackground(
	runner: IComfyRunner,
	bytes: Uint8Array,
	onStatus?: CutoutProgressCallback,
): Promise<{ blob: Blob; viewUrl: string }> {
	onStatus?.('准备去背景…');
	// 环境预检先行：未连接/缺节点/缺模型在上传前就给出可操作的诊断（而非等推理失败）。
	const envProblem = await checkCutoutEnvironment(runner);
	if (envProblem) { throw new Error(envProblem); }
	const uploaded = await uploadImageToComfy(runner, new Blob([bytes as unknown as BlobPart], { type: 'image/png' }), onStatus);
	onStatus?.('已上传，启动抠图工作流…');
	const out = await runCutoutWorkflow(runner, uploaded, onStatus);
	onStatus?.('拉取结果图像…');
	const resultBytes = await fetchOutputBytes(runner, out);
	const blob = new Blob([resultBytes as unknown as BlobPart], { type: 'image/png' });
	const viewUrl = `${runner.baseUrl}/view?filename=${encodeURIComponent(out.filename)}`
		+ (out.subfolder ? `&subfolder=${encodeURIComponent(out.subfolder)}` : '')
		+ `&type=${encodeURIComponent(out.type)}`;
	return { blob, viewUrl };
}

/** AI 去背景：PNG/JPEG bytes → ComfyUI saros_cutout → RGBA 透明 PNG Blob。 */
export async function comfyRemoveBackgroundPng(
	runner: IComfyRunner,
	bytes: Uint8Array,
	onStatus?: CutoutProgressCallback,
): Promise<Blob> {
	return (await comfyRemoveBackground(runner, bytes, onStatus)).blob;
}

/** AI 去背景：dataURL 图 → ComfyUI saros_cutout → RGBA 透明 PNG dataURL。 */
export async function comfyRemoveBackgroundDataUrl(
	runner: IComfyRunner,
	dataUrl: string,
	onStatus?: CutoutProgressCallback,
): Promise<string> {
	const blob = /^data:/i.test(dataUrl) ? dataUrlToBlob(dataUrl) : await (await fetch(dataUrl)).blob();
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const outBlob = await comfyRemoveBackgroundPng(runner, bytes, onStatus);
	return blobToDataUrl(outBlob);
}
