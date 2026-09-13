/*──────────────────────────────────────────────────────────────
 * 图像分析工具（vision_analyze）
 *
 * 2026-09-11 补全：与 `drawio` / `session_search` 同源的**第 4 个半成品** ——
 * 基础设施齐备、唯独缺 handler：
 *   - bundled 定义（`category: "vision"`，`source: 'hermes-bundled'`）
 *   - `BUNDLED_TOOLSETS.vision`（`tools: ["vision_analyze"]`）
 *   - `agentToolIsolator.ts` 的 `READ_IMAGE: 'vision_analyze'`
 *   - 配置项 `AGENT_STUDIO_AUX_VISION_PROVIDER` / `_MODEL`（constants + contribution 注册）
 *   - 设置面板 UI 区块「Vision（图像分析）— 用于分析上传的图片」
 * 但 `name: 'vision_analyze'` 全仓只出现在 bundled 定义里 → 注册成 stub →
 * `listTools` 跳过 → **模型看不到**。
 *
 * 复用能力（无需新建基础设施）：
 *   - `IModelProvider.chat(modelId, messages, options)` —— 通用推理调用
 *   - `IChatMessage.contentParts` 的多模态支持**已完备**：`messageFormatConverter`
 *     已实现 OpenAI / Anthropic / Gemini 三种格式的图片转换
 *   - `IModelInfo.supportsImages` —— 用于自动路由到支持图片输入的模型
 *
 * ★ 与 `image_generate` 的关键差异：**本工具不落盘**。分析产物是**文本**，
 * 不占用上下文（对比：生成的图片是 1–2MB base64，必须落媒体库只留短引用）。
 *──────────────────────────────────────────────────────────────*/

import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import type { IFileService } from '../../../../../../platform/files/common/files.js';
import { URI } from '../../../../../../base/common/uri.js';
import type { IModelProvider, IChatMessage, IChatImagePart } from '../../../common/providers.js';
import { AGENT_STUDIO_AUX_VISION_PROVIDER, AGENT_STUDIO_AUX_VISION_MODEL } from '../../../common/constants.js';

export const VISION_ANALYZE_TOOL_NAME = 'vision_analyze';

/**
 * 图片载荷上限（base64 字符数，≈ 6 MB 原始图片）。
 *
 * 为什么需要：base64 会随请求整体发出，超大图会显著抬高 token 成本与请求体体积
 * （部分网关直接 413）。超限时明确报错并给出建议，好过让请求在网络层神秘失败。
 */
const MAX_IMAGE_BASE64_CHARS = 8 * 1024 * 1024;
/** 单次分析的输出上限（防止模型长篇输出）。 */
const MAX_OUTPUT_TOKENS = 2048;
/** 下载 http(s) 图片的超时。 */
const IMAGE_FETCH_TIMEOUT_MS = 15_000;

export interface VisionAnalyzeToolContext {
	register: (descriptor: { definition: any; handler: any }) => void;
	logService: ILogService;
	configurationService?: IConfigurationService;
	/** 取当前注册的模型 provider 列表（`IAgentOSService.getModelProviders`）。 */
	getModelProviders: () => readonly IModelProvider[];
	/**
	 * **本地图片路径**加载器（2026-09-13 新增，可选）。
	 *
	 * ## 为什么必须有
	 *
	 * 本工具的 `image` 原先只收 data URL / base64 / http(s) URL —— 而**最高频的用法**
	 * 恰恰是「模型自己截图（如 mockup 渲染）后要看一眼」，此时手上是**本地文件路径**。
	 * 实测日志：模型拿 `docs/kb-mockups/_shot-sidebar.png` 调 `file_read` →
	 * 被二进制守护拒绝（文案建议 pandoc/csv，对 PNG **不可执行**）→ 整条
	 * 「渲染 → 截图 → 看效果」闭环断掉。
	 *
	 * 由调用方（`builtinToolProvider`）注入而非在此 import `IFileService`，原因：
	 * **护栏必须与 `file_read` 同源** —— 沙箱路径解析（`resolveAndCheckWorkspacePath`）、
	 * 设备伪文件系统、敏感路径读守卫三件套都在调用方那侧已具备，此处直接复用，
	 * 否则本工具会成为「读守卫的绕过通道」（image 后缀不在敏感名表里，但目录级
	 * 敏感项如 `.ssh/` `.aws/` 仍会被命中，漏了就是又一个绕过面）。
	 *
	 * 缺省（未注入）时退化为旧行为：路径形态的输入会被明确拒绝并说明可用形态。
	 */
	loadLocalImage?: (requestedPath: string, agentId?: string) => Promise<IParsedImage>;
	/**
	 * **主模型**是否支持图片输入（`supportsImages`）—— 供 `mode: 'auto' | 'attach'` 判定。
	 *
	 * 支持时本工具**跳过 aux 模型**，直接把图像块作为工具结果返回 —— 由 agent loop 转成
	 * 一条 `role:'user'` 消息附给主模型（唯一可移植的位置，见 `common/toolResultImages`）。
	 * 这样主模型**直接看像素**，不再经过一次有损的文本转述。
	 *
	 * 缺省 / 返回 false → 一律回退文本模式（fail-closed：对不支持图片的模型发图会 400）。
	 */
	mainModelSupportsImages?: () => Promise<boolean>;
}

/** `mode` 参数归一化：非法值一律退回 `auto`（宽容解析，与本项目其它工具同纪律）。 */
function normalizeVisionMode(raw: unknown): 'auto' | 'text' | 'attach' {
	const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
	if (v === 'text' || v === 'attach') { return v; }
	return 'auto';
}

/** 图片解析结果。 */
export interface IParsedImage {
	readonly data: string;          // base64，不含 data: 前缀
	readonly mimeType: IChatImagePart['mimeType'];
}

const DATA_URL_RE = /^data:([^;,]+);base64,(.*)$/s;

/** 把 MIME 收敛到 `ChatImageMimeType` 允许的集合（未知一律按 png 处理）。 */
function normalizeMime(mime: string | undefined): IChatImagePart['mimeType'] {
	const m = (mime ?? '').toLowerCase();
	if (m === 'image/jpeg' || m === 'image/jpg') { return 'image/jpeg'; }
	if (m === 'image/webp') { return 'image/webp'; }
	if (m === 'image/gif') { return 'image/gif'; }
	return 'image/png';
}

/**
 * 解析 `image` 参数（三种形态：data URL / 裸 base64 / http(s) URL）。
 *
 * 裸 base64 无法自带 MIME → 默认按 `image/png` 处理（绝大多数截图/生成图）；
 * 调用方若知道真实类型，应优先传 data URL 形态以保留 MIME。
 */
export async function parseImageInput(image: string, log: ILogService): Promise<IParsedImage> {
	const raw = image.trim();

	const dataUrl = DATA_URL_RE.exec(raw);
	if (dataUrl) {
		return { data: dataUrl[2], mimeType: normalizeMime(dataUrl[1]) };
	}

	if (/^https?:\/\//i.test(raw)) {
		// 远程图片：下载后转 base64（provider 侧统一按 base64 处理）。
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
		try {
			const res = await fetch(raw, { signal: controller.signal });
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			const mime = normalizeMime(res.headers.get('content-type') ?? undefined);
			const buf = await res.arrayBuffer();
			const b64 = Buffer.from(buf).toString('base64');
			return { data: b64, mimeType: mime };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log.warn(`[vision_analyze] failed to fetch image url: ${msg}`);
			throw new Error(`could not download the image from "${raw}": ${msg}. Pass base64 data instead (data URL form keeps the MIME type).`);
		} finally {
			clearTimeout(timer);
		}
	}

	// 裸 base64（可能含换行/空白）。
	const compact = raw.replace(/\s+/g, '');
	if (!/^[A-Za-z0-9+/=]+$/.test(compact)) {
		// ⚠ 本分支在「本地路径」支持（2026-09-13）之后**几乎不可达** ——
		// 调用方先用 `isInlineImagePayload` 分流，路径不会走到这里。
		// 保留文案准确性：说明可用形态，并点明路径形态（避免读到它的人以为只能用 base64）。
		throw new Error(
			'"image" must be a local file path, a data URL (data:image/png;base64,...), a base64 string, or an http(s) URL.',
		);
	}
	return { data: compact, mimeType: 'image/png' };
}

/**
 * 支持的本地图片扩展名 → MIME。**只认图片**。
 *
 * 为什么必须是白名单而非「非图片就拒」的反向判定：本工具会把字节**发给外部模型
 * provider** —— 若允许任意文件，它就成了「任意文件转 base64 出网」的通道，
 * 而 `file_read` 的二进制守护、读守卫都会被绕开。白名单是 fail-closed 的写法。
 *
 * `.bmp` / `.svg` / `.tiff` 不在多模态 MIME 白名单内（`ChatImageMimeType`），
 * 故明确报错并列出可用格式，而不是悄悄按 png 送出去。
 */
const IMAGE_EXT_TO_MIME: Readonly<Record<string, IChatImagePart['mimeType']>> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
};

/** 图片原始字节上限（与 `MAX_IMAGE_BASE64_CHARS` 同源：base64 ≈ 原始 × 4/3）。 */
const MAX_IMAGE_BYTES = Math.floor(MAX_IMAGE_BASE64_CHARS * 3 / 4);

/**
 * 读取**本地**图片文件为 base64（供注入的 `loadLocalImage` 使用）。
 *
 * 调用方（`builtinToolProvider`）在此之前已跑完与 `file_read` **同一套**读护栏
 * （沙箱路径解析 / 设备伪文件系统 / 敏感路径读守卫），本函数只负责「读 + 编码 + 校验」。
 */
export async function readLocalImageAsBase64(
	fileService: IFileService, absPath: string,
): Promise<IParsedImage> {
	const ext = (/\.[A-Za-z0-9]+$/.exec(absPath)?.[0] ?? '').toLowerCase();
	const mimeType = IMAGE_EXT_TO_MIME[ext];
	if (!mimeType) {
		throw new Error(
			`not a supported image file ("${absPath}"${ext ? `, ${ext}` : ', no extension'}). `
			+ `Supported: ${Object.keys(IMAGE_EXT_TO_MIME).join(', ')}.`,
		);
	}
	const content = await fileService.readFile(URI.file(absPath));
	// 先按**原始字节**拦，避免把超大文件整份编码成 base64 再拒（内存 + 无用功）
	if (content.value.byteLength > MAX_IMAGE_BYTES) {
		throw new Error(
			`image is too large (${Math.round(content.value.byteLength / 1024 / 1024)} MB, limit ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB). Downscale or crop it first.`,
		);
	}
	return { data: Buffer.from(content.value.buffer).toString('base64'), mimeType };
}

/** 该值是否已是可直接使用的图片载荷（data URL / http(s) / 纯 base64 字符集）。 */
function isInlineImagePayload(raw: string): boolean {
	const v = raw.trim();
	if (DATA_URL_RE.test(v)) { return true; }
	if (/^https?:\/\//i.test(v)) { return true; }
	// 纯 base64（允许空白换行）。**路径必然含 `/` `\` `.` `-` 之一** —— 与 base64 字符集
	// 不相交，故这条判据不会把路径误判成 base64（Windows 盘符 `g:\` 里的 `:` 同理）。
	return /^[A-Za-z0-9+/=\s]+$/.test(v);
}

/** 走上下文注入的加载器读本地路径；未注入时给出**可执行**的替代说明。 */
async function loadLocalImageViaContext(
	ctx: VisionAnalyzeToolContext, requestedPath: string, agentId?: string,
): Promise<IParsedImage> {
	if (!ctx.loadLocalImage) {
		throw new Error(
			`"image" looks like a local path ("${requestedPath}") but local-path loading is unavailable in this host. `
			+ 'Pass the image as a data URL (data:image/png;base64,...), a base64 string, or an http(s) URL instead.',
		);
	}
	return ctx.loadLocalImage(requestedPath, agentId);
}

export function registerVisionAnalyzeTools(ctx: VisionAnalyzeToolContext): void {
	ctx.register({
		definition: {
			name: VISION_ANALYZE_TOOL_NAME,
			description: 'Analyze an image with a multimodal vision model and answer a question about it. '
				+ 'Use this whenever the user attaches/sends an image and asks about its content, or when you need to read text/UI/layout from a screenshot.\n'
				+ 'THIS IS THE ONLY WAY TO LOOK AT AN IMAGE — `file_read` rejects images (and every other binary) by design; do not retry it on a .png/.jpg.\n\n'
				+ 'Parameters:\n'
				+ '- `image` (required): EITHER a local file path (e.g. `docs/kb-mockups/_shot-sidebar.png`, resolved against the workspace), '
				+ 'OR a data URL (`data:image/png;base64,...`), a raw base64 string, or an http(s) URL.\n'
				+ '- `query` (required): what to ask or do about the image (e.g. "描述这张图", "图中报错是什么", "把表格转成 markdown").\n'
				+ '- `mode` (optional, default "auto"): "auto" = if YOUR model supports image input, the image is attached and you answer it yourself; otherwise an auxiliary vision model answers with text. '
				+ '"text" = always get a text answer from the aux vision model (cheaper for context). '
				+ '"attach" = require attaching (errors if your model has no image input).\n\n'
				+ 'Model selection: the configured Vision auxiliary model (settings → Vision), otherwise auto-routed to the first available model that supports image input.',
			inputSchema: {
				type: 'object',
				properties: {
					image: {
						type: 'string',
						description: 'Local file path (e.g. `docs/kb-mockups/_shot-sidebar.png`), or a data URL (data:image/png;base64,...), or a raw base64 string, or an http(s) URL.',
					},
					query: {
						type: 'string',
						description: 'Question or instruction about the image (e.g. "describe this", "what error is shown", "transcribe the table to markdown").',
					},
					mode: {
						type: 'string',
						enum: ['auto', 'text', 'attach'],
						description: '"auto" (default): attach the image when the current model supports image input, else return a text answer. "text": always return a text answer from the vision aux model. "attach": require attaching (error if the current model cannot accept images).',
					},
				},
				required: ['image', 'query'],
			},
			category: 'vision',
			source: 'saros.builtin-tools',
		},
		handler: async (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string) => {
			const image = typeof args.image === 'string' ? args.image : '';
			const query = typeof args.query === 'string' ? args.query.trim() : '';
			if (!image.trim()) {
				return [{ type: 'text', text: 'vision_analyze error: "image" is required.' }];
			}
			if (!query) {
				return [{ type: 'text', text: 'vision_analyze error: "query" is required.' }];
			}

			// ── 1. 解析图片 ──
			//
			// ★ 2026-09-13：**本地文件路径**也接受。判定顺序刻意如此 ——
			// 先排除「明确是载荷」的形态（data URL / http(s) / 纯 base64 字符集），
			// 剩下的按**路径**处理。
			//
			// 动机：最高频用法是「模型自己截图后要看一眼」，此时手上就是本地路径；
			// 而 `file_read` 会以「binary」拒绝它（见 `coreTools.binaryReadRejectedMessage`
			// —— 那里现在会点名本工具）。缺了这条分支，模型只能自己 base64 一遍
			// （要走 shell → 弹审批打断），闭环依然是断的。
			let parsed: IParsedImage;
			try {
				parsed = isInlineImagePayload(image)
					? await parseImageInput(image, ctx.logService)
					: await loadLocalImageViaContext(ctx, image, agentId);
			} catch (err) {
				return [{ type: 'text', text: `vision_analyze error: ${err instanceof Error ? err.message : String(err)}` }];
			}
			if (parsed.data.length > MAX_IMAGE_BASE64_CHARS) {
				return [{
					type: 'text',
					text: `vision_analyze error: image is too large (${Math.round(parsed.data.length / 1024 / 1024)} MB base64, limit ${MAX_IMAGE_BASE64_CHARS / 1024 / 1024} MB). `
						+ 'Downscale or crop the image first.',
				}];
			}

			// ── 1.5 模式分流（2026-09-13）──────────────────────────────────
			//
			// `auto`（默认）：主模型能看图 → **直接把图像块返回**（agent loop 会把它转成
			//   `role:'user'` 消息附上）→ 主模型看像素，不经有损转述；否则退回文本模式。
			// `text`：强制走 aux 视觉模型拿文本答案（主模型能看图时也可用，省上下文）。
			// `attach`：强制附加；主模型不支持图片时**明确报错**（而非静默退化）。
			//
			// ⚠ 与主流方案的差异：Claude Code / Gemini CLI 等把图直接塞给主模型（要求主模型
			// 必须多模态，否则 400）；本工具用 aux 模型兜住纯文本主模型 —— 这里让两者**兼得**。
			const mode = normalizeVisionMode(args['mode']);
			const mainSupportsImages = mode !== 'text' && ctx.mainModelSupportsImages
				? await ctx.mainModelSupportsImages().catch(() => false)
				: false;
			if (mode === 'attach' && !mainSupportsImages) {
				return [{
					type: 'text',
					text: 'vision_analyze error: mode="attach" requires a main model with image input support, '
						+ 'but the current model does not declare it. Use mode="text" instead — an auxiliary vision model '
						+ 'will answer with a text description.',
				}];
			}
			if (mainSupportsImages) {
				return [
					{ type: 'image', data: parsed.data, mimeType: parsed.mimeType },
					{
						type: 'text',
						text: `[vision_analyze] Image attached (${parsed.mimeType}, ~${Math.round(parsed.data.length / 1024)} KB base64) — `
							+ 'you can see it directly now; answer this yourself: ' + query,
					},
				];
			}

			// ── 2. 选择 provider / model ──
			// ① 用户级 Vision 辅助模型配置（设置面板「Vision（图像分析）」写入）；
			// ② 自动路由：第一个声明 supportsImages 的模型。
			let providerId: string | undefined;
			let modelId: string | undefined;
			if (ctx.configurationService) {
				try {
					providerId = ctx.configurationService.getValue<string>(AGENT_STUDIO_AUX_VISION_PROVIDER) || undefined;
					modelId = ctx.configurationService.getValue<string>(AGENT_STUDIO_AUX_VISION_MODEL) || undefined;
					// 'auto' 是设置项的默认值，表示"跟随自动路由"，不是真实 provider id。
					if (providerId === 'auto') { providerId = undefined; }
				} catch { /* 配置读取失败 → 走自动路由 */ }
			}

			const providers = ctx.getModelProviders();
			let provider: IModelProvider | undefined = providerId
				? providers.find(p => p.id === providerId)
				: undefined;

			if (!provider || !modelId) {
				for (const p of providers) {
					if (typeof p.chat !== 'function') { continue; }
					if (providerId && p.id !== providerId) { continue; }
					const models = await p.listModels().catch(() => []);
					const visionModel = models.find(m => m.supportsImages);
					if (visionModel) {
						provider = p;
						modelId = visionModel.id;
						break;
					}
				}
			}

			if (!provider || !modelId) {
				return [{
					type: 'text',
					text: 'vision_analyze error: no vision-capable model available. '
						+ 'Configure one in settings («Vision（图像分析）») or enable a provider that exposes a model with image input support.',
				}];
			}

			// ── 3. 调用多模态推理 ──
			const message: IChatMessage = {
				role: 'user',
				content: query,
				// contentParts 优先于 content（见 providers.ts 的 IChatMessage 注释）；
				// 同时保留 content=query 以便不支持多模态的适配层仍能拿到问题文本。
				contentParts: [
					{ type: 'text', text: query },
					{ type: 'image', data: parsed.data, mimeType: parsed.mimeType },
				],
			};

			try {
				ctx.logService.info(`[vision_analyze] provider=${provider.id} model=${modelId} mime=${parsed.mimeType} b64.len=${parsed.data.length}`);
				let out = '';
				let sawError: string | undefined;
				for await (const delta of provider.chat(modelId, [message], { maxTokens: MAX_OUTPUT_TOKENS })) {
					if (signal?.aborted) {
						return [{ type: 'text', text: '[vision_analyze] cancelled before completion.' }];
					}
					// 只收正文；thinking 属推理过程，不作为答案回给模型。
					if (delta.type === 'text' && delta.content) { out += delta.content; }
					else if (delta.type === 'error') { sawError = delta.error ?? 'unknown error'; }
				}
				if (sawError && !out) {
					return [{ type: 'text', text: `vision_analyze error from provider: ${sawError}` }];
				}
				if (!out.trim()) {
					return [{ type: 'text', text: 'vision_analyze: the model returned no text for this image.' }];
				}
				return [{ type: 'text', text: `[Vision Analysis] (model: ${modelId})\n\n${out.trim()}` }];
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.logService.error(`[vision_analyze] call failed: ${msg}`);
				return [{ type: 'text', text: `vision_analyze error: ${msg}` }];
			}
		},
	});

	ctx.logService.info('[VisionAnalyzeTools] Registered vision_analyze tool');
}
