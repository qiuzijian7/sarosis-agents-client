/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工具结果里的**图像项**处理（2026-09-13）。
 *
 * ## 背景：工具能返回图像，但图像**到不了模型**
 *
 * `IToolResultContent` 允许 `{ type: 'image', data, mimeType }`，且已有两处真的这么返回：
 *   · `mcpToolProvider._adaptContent` 转发 MCP image content；
 *   · `imageGenTools` 落盘失败时的兜底。
 *
 * 但**回灌给模型的那条路径只认文本**（2026-09-13 全链路追踪结论）：
 *   1. `safeStringifyToolResult`（`toolCallUtils`）把整个数组 `JSON.stringify` 成字符串，
 *      再按 `MAX_TOOL_RESULT_CHARS`（100K）截断 → **图片 base64 被切断损坏**；
 *   2. `messageFormatConverter` 的 `role: 'tool'` 分支只读 `m.content`（字符串），
 *      OpenAI / Anthropic / Gemini **三家都是如此** → 给 tool 消息挂 `contentParts` 也会被忽略。
 *
 * ⇒ 结论：**图像必须走 `role: 'user'` 消息**。只有该分支读 `contentParts`，且三家 provider
 * 都会把它转成各自的图像格式（OpenAI `image_url` / Anthropic base64 source / Gemini `inline_data`）。
 *
 * ## 本模块只做**纯**的两件事
 *
 *   1. {@link splitToolResultImages}：把图像项从工具结果里分离出来（并让它们不再进入
 *      被截断的 JSON 文本）；
 *   2. {@link buildToolImageMessage}：把它们组装成一条 `role: 'user'` 消息。
 *
 * **接线（把消息追加进对话）在 agent loop 里**，且**必须门控主模型的 `supportsImages`** ——
 * 否则不支持图片的模型会直接 400（Claude Code 的 `Read` 工具踩过这个坑）。
 */

import type { IChatContentPart, IChatImagePart, IChatMessage } from './providers.js';

/** 从工具结果里分离出的图像载荷。 */
export interface IToolResultImage {
	/** base64 编码（**不含** `data:` 前缀）。 */
	readonly data: string;
	/** 原始 MIME（构造消息时会收敛到 `ChatImageMimeType`）。 */
	readonly mimeType: string;
}

/**
 * 把 `ChatImageMimeType` 允许之外的 MIME 收敛到 `image/png`。
 *
 * 与 `visionAnalyzeTools.normalizeMime` 同口径 —— 那边是工具入参解析，这里是消息构造，
 * 各自只需 5 行；共同的**真源**是 `providers.ts` 的 `ChatImageMimeType` 联合类型
 * （类型层面已保证写错就编译失败）。
 */
function toChatImageMime(mime: string | undefined): IChatImagePart['mimeType'] {
	const m = (mime ?? '').toLowerCase();
	if (m === 'image/jpeg' || m === 'image/jpg') { return 'image/jpeg'; }
	if (m === 'image/webp') { return 'image/webp'; }
	if (m === 'image/gif') { return 'image/gif'; }
	return 'image/png';
}

/** 该值是否是**内联**图像载荷（base64），而不是 URI / 路径等引用形态。 */
function isInlineImageData(data: string): boolean {
	if (!data) { return false; }
	// 带 scheme 的（`saros-media://…` / `https://…` / `data:`）不是 base64 载荷。
	// ⚠ 不能按「看起来像 base64」判定 —— base64 字符集与路径字符有交集，
	//    但**带 scheme 前缀**这一条足以区分（`data:` 形态这里也不接受：调用方应传纯 base64）。
	return !/^[a-z][a-z0-9+.-]*:/i.test(data);
}

/**
 * 从工具结果里分离图像项。
 *
 * @param content 工具的原始返回（可能是 `IToolResultContent[]`，也可能是字符串等）。
 * @returns `text`：剥离图像项后的内容（**形态与顺序保持不变**，非数组时原样返回）；
 *          `images`：可内联发送的图像（无则空数组）。
 *
 * ⚠ **只剥离真正的 base64 载荷**：`type: 'image'` 但 `data` 是 URI 的项（MCP 允许
 * `resource_link` 这类引用形态）**保留在文本里** —— 宁可让模型看到那个 URI，
 * 也不要静默丢掉信息（本项目对「静默削弱」一贯的态度是：要么做到，要么说出来）。
 */
export function splitToolResultImages(content: unknown): { text: unknown; images: IToolResultImage[] } {
	const images: IToolResultImage[] = [];
	if (!Array.isArray(content)) { return { text: content, images }; }
	const text = content.filter(item => {
		if (item && typeof item === 'object' && (item as { type?: unknown }).type === 'image') {
			const raw = item as { data?: unknown; mimeType?: unknown };
			const data = typeof raw.data === 'string' ? raw.data : '';
			if (isInlineImageData(data)) {
				images.push({ data, mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : 'image/png' });
				return false; // 已作为图像块发送 → 不再进入被截断的 JSON 文本
			}
		}
		return true;
	});
	return { text, images };
}

/**
 * 组装承载图像的 `role: 'user'` 消息；无图像时返回 `undefined`（调用方据此零成本跳过）。
 *
 * ## 为什么是 `user` 而不是挂在 tool 消息上
 *
 * OpenAI 协议**不允许** `role: 'tool'` 消息携带图像块（只接受字符串 content），
 * 且本项目的 `messageFormatConverter` 对 tool 分支也只读字符串 →
 * 挂在 tool 消息上在**任何一家** provider 都不会生效。
 * `role: 'user'` 是唯一可移植的位置（用户附件走的正是这条路径）。
 *
 * @param images 待发送的图像（须来自 {@link splitToolResultImages}）。
 * @param toolName 产生图像的工具名（写进说明文本，让模型知道图从哪来）。
 * @param note 自定义说明；缺省给一句通用说明。
 */
export function buildToolImageMessage(
	images: readonly IToolResultImage[],
	toolName: string,
	note?: string,
): IChatMessage | undefined {
	if (images.length === 0) { return undefined; }
	const intro = note ?? (
		`[${toolName}] produced ${images.length} image${images.length > 1 ? 's' : ''} — attached below so you can look at ${images.length > 1 ? 'them' : 'it'} directly.`
	);
	const parts: IChatContentPart[] = [{ type: 'text', text: intro }];
	for (const img of images) {
		parts.push({ type: 'image', data: img.data, mimeType: toChatImageMime(img.mimeType) });
	}
	return { role: 'user', content: intro, contentParts: parts };
}

/**
 * 主模型是否支持**图片输入**（`IModelInfo.supportsImages`）—— 发图前的**硬门控**。
 *
 * ## 为什么必须问
 *
 * 把图像作为 `role:'user'` 消息发出去，若主模型不支持图片，**provider 会直接 400**
 * （Claude Code 的 `Read` 工具踩过这个坑：读图即报错）。故这里是「发图 vs 只发文字说明」的开关。
 *
 * ## 判定与缓存
 *   · `listModels()` 抛错 / 模型查不到 / 字段缺失 → **false**（fail-closed：不发图）；
 *   · 结果按 `provider.id::modelId` 缓存 —— **键含模型**，故用户切换模型时自动失效，
 *     不存在「拿旧模型的结论判新模型」的错配；TTL 兜住「同一模型能力被更正」的情况。
 */
const SUPPORTS_IMAGES_TTL_MS = 60_000;
const _supportsImagesCache = new Map<string, { at: number; value: boolean }>();

/** 清空能力缓存（测试用 —— 模块级缓存必须可重置，否则用例之间互相污染）。 */
export function resetSupportsImagesCacheForTests(): void {
	_supportsImagesCache.clear();
}

export async function resolveSupportsImages(
	provider: { id?: string; listModels?: () => Promise<ReadonlyArray<{ id: string; supportsImages?: boolean }>> } | undefined,
	modelId: string | undefined,
): Promise<boolean> {
	if (!provider?.listModels || !modelId) { return false; }
	const key = `${provider.id ?? '?'}::${modelId}`;
	const hit = _supportsImagesCache.get(key);
	if (hit && Date.now() - hit.at < SUPPORTS_IMAGES_TTL_MS) { return hit.value; }
	let value = false;
	try {
		const models = await provider.listModels();
		value = models.find(m => m.id === modelId)?.supportsImages === true;
	} catch {
		value = false; // 查不到 → 不发图（fail-closed）
	}
	_supportsImagesCache.set(key, { at: Date.now(), value });
	return value;
}

/**
 * 主模型**不支持图片输入**时的文本替代说明。
 *
 * 图像已被剥离（避免把截断损坏的 base64 塞进上下文），但**必须让模型知道这件事** ——
 * 否则它会以为工具没产出图，或以为自己看到了（静默削弱）。文案同时指出两条出路：
 * 换支持图片的模型，或用 `vision_analyze`（它返回文本答案）。
 */
export function toolImageOmittedNote(toolName: string, count: number): string {
	const them = count > 1 ? 'them' : 'it';
	return `\n\n[${toolName}] returned ${count} image${count > 1 ? 's' : ''}, but ${them === 'them' ? 'they are' : 'it is'} NOT attached: `
		+ 'the current model does not declare image input support. '
		+ `If you need to inspect ${them}, switch to a vision-capable model, or use the \`vision_analyze\` tool `
		+ '(it accepts a local file path and returns a text answer).';
}
