// @vssaros/dsh-imagegen — host half：生图工具 `image_generate`。
//
// ── 能力来源：经控制桥回 IDE ────────────────────────────────────────────────
// 生图 provider、凭据、审批都在 **IDE 进程**：
//   · BYOK 的 OpenAI 兼容 provider（`MainProcessModelProvider.generateImage` → `/images/generations`，
//     405/404 自动回退 `/v1`，图生图走 multipart `/images/edits`）；
//   · 厂商扩展注册的 `${vendor}.generateImage` 命令（lightai 等）。
// Host 侧**不再存第二份 Key** —— 两处真源必然漂移，而且 BYOK 的 baseURL / apiKey 只在 IDE 设置里。
//
// ★ 桥的 `pluginId` 必须是**包名**（`@vssaros/dsh-imagegen`）：授权表按包名建
//   （`dshHarnessChannel._readIdeDeclarations` → `readCapabilityDeclarations`），
//   填入口 id 会被判「插件未安装或没有可读清单」⇒ 授权永远不通过。
//
// ── 与 `vssaros-media` 里那个同名工具的关系 ─────────────────────────────────
// `vssaros-media` 的 `image_generate` 今天**不通**，两个独立原因：
//   ① IDE 侧没有实现 `capability:'media'`（白名单里没有，`dshIdeCapabilities.ts` 也没有这个 case）；
//   ② 它填的 `pluginId` 是入口 id 而不是包名。
// 那条死代码已随本插件上线**移除**（工具名保持 `image_generate` 不变 ⇒ 技能文档与 agent 配置
// 里的旧名字继续有效，也避免出现两个同名工具让模型随机选）。
//
// ── 静态依赖只有 tools ───────────────────────────────────────────────────────
// `webServer` / `connection` / `attachments` / `vssarosBridge` 全部走**可选注入**
// （`ctx.inject`）：缺任何一个都只让本插件的对应能力消失，**不会**让整个插件在
// headless / tui profile 里永久 pending（kanban 实测过这个坑）。
//
// ── 画布工作台（2026-10-21）────────────────────────────────────────────────
// 画布是**我们自己的插件页**（`/x/imagegen/canvas/`），不是 dsh 客户端里的一个页签：
// 画布引擎产物 3.4MB ⇒ 放进 dsh 客户端包就等于"每个聊天框都加载 3.4MB"
// （那正是 tldraw 被否掉的同一个坑）⇒ 画布是独立 webview，按需加载。
// 画布页 ↔ Agent 的唯一通道是**宿主**（HTTP 路由）：画布页推状态，Agent 用两个工具读。

import { createCanvasMirror } from './canvasState.js';
import { createGraphStore } from './canvasGraph.js';
import { createImageLedger } from './canvasImages.js';
import { editOneImage } from './imageEdit.js';
import { runCanvasGraph } from './canvasRun.js';
import { EDIT_IMAGE_TOOL, canvasToolDefinitions } from './canvasTools.js';
import { CANVAS_RUN_TOOL, canvasGraphToolDefinitions } from './canvasGraphTools.js';
import { registerCanvasRoutes } from './canvasRoutes.js';
import { maybeSaveToWorkspace } from './workspaceSave.js';
import { createCapabilityCache, fitToCapabilities, formatCapabilities, resolveImageRoute } from './capabilities.js';
import { decodeBase64, decodeDataUrl, normalizeMediaType } from './imageBytes.js';
// ★ 2026-10-27（用户：「生图逻辑都在 dsh 侧，后续废除 IDE 生图」）：BYOK 的 OpenAI 兼容 provider
//   现在由 Host **直连**（baseURL 与 Key 本来就在 dsh 的设置 / 凭据里，见 imageApi.js 文件头）。
import { generateViaDsh, pickDshProvider } from './imageApi.js';

export const name = 'vssaros-imagegen';

/** 只依赖 tools：见文件头。 */
export const inject = ['tools'];

/** 桥授权用的**包名**（不是入口 id）——见文件头。 */
const PLUGIN_PACKAGE = '@vssaros/dsh-imagegen';

/** 生图可能要几十秒到几分钟（与 legacy 的 10 分钟档同量级）。 */
const IDE_TIMEOUT_MS = 10 * 60 * 1000;

/** 工具名（wire 名）：客户端工具卡按它做 keyed 命中。 */
export const IMAGE_GENERATE_TOOL = 'image_generate';

/** 批量生成的工具名（上游同名 `generate_images`，语义也同款）。 */
export const GENERATE_IMAGES_TOOL = 'generate_images';

/** 列出"这台 IDE 谁能生图"的工具名（三批⑨）。 */
export const IMAGE_MODELS_TOOL = 'image_models';

/** 多模型对比（同一条 prompt 多个 provider 各出一张）的工具名（三批⑧）。 */
export const COMPARE_MODELS_TOOL = 'compare_models';

/** 一次批量最多几条（上游也是 10 ⇒ 别自作主张放大）。 */
const MAX_BATCH_PROMPTS = 10;

/**
 * 把 IDE 回的一张图归一成「字节 + 媒体类型」。
 *
 * 两种来源：`b64`（裸 base64）与 `url`（data URL 或 http(s) URL）。
 * http(s) 由 **Host 进程**去取（它有网络；页面侧 fetch 会被 CORS 拦）。
 */
async function normalizeImage(raw) {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const b64 = raw.b64;
	if (typeof b64 === 'string' && b64.trim()) {
		const bytes = decodeBase64(b64);
		if (bytes && bytes.length > 0) {
			return { bytes, mediaType: normalizeMediaType(raw.mimeType) };
		}
	}
	const url = raw.url;
	if (typeof url === 'string' && url.trim()) {
		const dataUrl = decodeDataUrl(url);
		if (dataUrl) {
			return dataUrl;
		}
		if (/^https?:\/\//i.test(url)) {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`取回生成图失败：HTTP ${response.status}`);
			}
			const contentType = response.headers.get('content-type') ?? '';
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.length === 0) {
				throw new Error('取回生成图失败：响应是空的');
			}
			return { bytes, mediaType: normalizeMediaType(contentType.split(';')[0]) };
		}
	}
	return undefined;
}

/**
 * 生成**一组**（同 prompt 的 n 张，或批量里的一条）图：经桥回 IDE ⇒ 存 attachment
 * ⇒ 记「最近出图」账本 ⇒ 落进工作区。
 *
 * 抽成共用函数的理由（★ 别把这条链路抄第二遍）：
 *   `image_generate`（单条）与 `generate_images`（批量）必须**逐字一致** —— 落盘、记账、
 *   溯源 prompt、失败口径都只有一份实现；抄一遍就会漂（批量漏落盘、单条多记账 ✗）。
 *
 * @param {object} state 宿主状态（桥 / attachments / 账本 / 工作区根）
 * @param {object} options
 * @param {string} options.prompt 画面描述
 * @param {string} [options.size] `1024x1024` 之类
 * @param {string} [options.model] 图像模型 id
 * @param {string} [options.provider] provider id（★ 三批⑧ 多模型对比用；透传 IDE 侧选型）
 * @param {string} [options.quality] 生成质量档（provider 不支持会自己报错 ⇒ 原样透传）
 * @param {number} [options.numImages] 同 prompt 出几张（1..4）
 * @param {boolean} [options.askedSave] `save_to_workspace` 参数（缺省 = 存）
 * @param {string} [options.saveDir] 落盘目录（相对工作区根）
 * @returns {Promise<{images: Array<{attachment: object, id?: string}>, savedPaths: string[],
 *   saveFailures: string[], failures: string[]}>}
 *   硬失败（桥不在 / provider 报错 / 一张都没存下来）**抛错**；单张存失败进 `failures`（不中断其余）✓
 */
async function generateOneImage(state, options = {}) {
	const prompt = String(options.prompt ?? '').trim();
	if (!prompt) {
		throw new Error('prompt 必填（要生成的画面描述）');
	}
	const size = String(options.size ?? '').trim();
	const matched = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/.exec(size);
	const numImages = Number.isFinite(Number(options.numImages)) ? Math.max(1, Math.min(4, Number(options.numImages))) : 1;
	const model = String(options.model ?? '').trim();
	const provider = String(options.provider ?? '').trim();
	const quality = String(options.quality ?? '').trim();
	// ★ 2026-10-22：选中 LightAI（或没指定、而 dsh 侧 LightAI 已登录）⇒ **直接**在 Host 里建任务 / 轮询（不过桥回 IDE）
	const route = await resolveImageRoute(state, { provider, model });
	let rawImages;
	let usedProvider;
	let usedModel;
	if (route === 'lightai') {
		({ rawImages, usedProvider, usedModel } = await requestLightAIImages(state, {
			prompt, numImages, model, quality,
			...(matched ? { width: Number(matched[1]), height: Number(matched[2]) } : {}),
			signal: options.signal,
		}));
	} else if (route === 'dsh') {
		// BYOK / OpenAI 兼容：Host 直连（不再回 IDE）
		({ rawImages, usedProvider, usedModel } = await requestDshImages(state, {
			prompt, numImages, model, provider, quality, size, signal: options.signal,
		}));
	} else {
		// 只剩"厂商扩展注册的图像模型"这条要走 IDE；`allowIdeFallback: false` ⇒ 明确关掉（废除 IDE 生图时用）
		if (state.allowIdeFallback === false) {
			throw new Error('IDE 侧生图已关闭（`allowIdeFallback: false`）：'
				+ `provider「${provider || '(未指定)'}」在 dsh 侧既不是 LightAI 也不是可直连的 BYOK 路由。`
				+ '去 设置 → 模型 → LightAI 登录，或在 `llm-pi-ai` 里配好这条 provider（需要 baseURL + 凭据）。');
		}
		({ rawImages, usedProvider, usedModel } = await requestIdeImages(state, { prompt, numImages, matched, model, provider, quality }));
	}
	const attachments = state.attachments;
	if (!attachments || typeof attachments.saveImage !== 'function') {
		throw new Error('图像生成成功但 attachments 服务不在（图片无处存放）——attachments 是可选依赖，宿主没提供就存不了图');
	}
	const images = [];
	const failures = [];
	const savedPaths = [];
	const saveFailures = [];
	for (const [index, raw] of rawImages.entries()) {
		try {
			const normalized = await normalizeImage(raw);
			if (!normalized) {
				throw new Error('这张图既没有 b64 也没有可取的 url');
			}
			const attachment = await attachments.saveImage({
				data: normalized.bytes,
				mediaType: normalized.mediaType,
				name: `image-${index + 1}.${normalized.mediaType === 'image/jpeg' ? 'jpg' : normalized.mediaType.split('/')[1] ?? 'png'}`,
			});
			// 记一笔「最近出图」⇒ 画布页来取 ⇒ **生成结果自动落画布**（见 lib/canvasImages.js）。
			const recorded = state.canvasImages?.record({
				attachment, mediaType: normalized.mediaType,
				width: attachment.width, height: attachment.height, prompt,
				provider: usedProvider, model: usedModel, source: 'generate',
				// ★ 2026-10-22：版本族（聊天卡切版本 / 原位重生成用）。缺省＝自成一族。
				group: options.group,
			});
			// 先建对象再入列：后面入库成功要给它挂 `mediaId`（媒体库资产 id，便于对账）。
			const image = { attachment, id: recorded?.id };
			images.push(image);
			// ★ 2026-10-21（二批⑤）：结果落进工作区（内容寻址 + 原子写 ⇒ 同一张图不重复写）。
			const saved = await maybeSaveToWorkspace({
				asked: options.askedSave,
				bytes: normalized.bytes,
				mediaType: normalized.mediaType,
				root: state.resolveWorkspaceRoot?.(),
				dir: options.saveDir,
			});
			if (saved.saved) {
				savedPaths.push(saved.path);
				// 落盘路径记回账本 ⇒ 生图工作台的画廊能显示"已存到工作区：…" ✓
				if (recorded?.id) { state.canvasImages?.markSaved?.(recorded.id, saved.path); }
			}
			else if (saved.error) { saveFailures.push(saved.error); }
			// ★ 2026-10-24：**存进 IDE 媒体库**（用户要求「聊天框生成的图片自动存储到媒体库」）。
			//   best-effort：桥不在 / 老 IDE 不认这个 op ⇒ 跳过；**绝不让生图因此失败** ✓。
			const mediaId = await importToMediaLibrary(state, {
				bytes: normalized.bytes,
				mediaType: normalized.mediaType,
				prompt,
				provider: usedProvider,
				model: usedModel,
				savedPath: saved.saved ? saved.path : '',
			});
			if (mediaId) { image.mediaId = mediaId; }
		} catch (e) {
			failures.push(String(e?.message ?? e));
		}
	}
	if (images.length === 0) {
		throw new Error(`图像生成失败：${failures.join('；') || '没有一张图能存下来'}`);
	}
	return { images, savedPaths, saveFailures, failures };
}

/**
 * 把一张生成结果**存进 IDE 的媒体库**（`media` 能力的 `op:'importAsset'`，2026-10-24）。
 *
 * ★ 为什么必须回 IDE：媒体库的真源在主进程（SQLite `media_asset` + `{root}/{yyyy}/{mm}/{uuid}.{ext}`），
 *   dsh 侧的 `@vssaros/dsh-media` 是**只读镜像**（实测直连主进程正在用的 `media.db` 会 `disk I/O error`）
 *   ⇒ 写只能由 IDE 侧做。
 *
 * ★ **best-effort**：桥不在（headless / tui）/ 老 IDE 不认这个 op（会回"media 的 op 不认识：importAsset"）
 *   ⇒ **跳过**并返回空串。**绝不能**因为入库失败让生图整体失败（图已经生成好了，用户要的是那张图 ✓）。
 *
 * @param {object} state 宿主状态
 * @param {{bytes: Uint8Array, mediaType: string, prompt: string, provider: string, model: string, savedPath: string}} input
 * @returns {Promise<string>} 媒体库资产 id；没入库时为空串
 */
async function importToMediaLibrary(state, { bytes, mediaType, prompt, provider, model, savedPath }) {
	// ★★ 2026-10-24（P4）：**dsh 内直连**。媒体库真源已搬到 dsh 侧
	//   （`@vssaros/dsh-media` 的 `media-store/`，见那边 `lib/ownStore.js`），
	//   同 Host 的插件经 `ctx.provide('vssarosMediaStore')` 直接写 ⇒
	//   **不再经桥回 IDE**（那条 `media` 能力的 `importAsset` 是过渡通道，IDE 侧媒体库随后下线）。
	const store = state.mediaStore;
	if (!store || typeof store.importAsset !== 'function') {
		// 没装媒体库 / 老版本没 provide ⇒ 跳过（best-effort；生图本身不该因此失败）
		return '';
	}
	try {
		const type = String(mediaType || 'image/png');
		const ext = type === 'image/jpeg' ? 'jpg' : (type.split('/')[1] || 'png');
		// provider 口径：'byok:<providerId>' / 'lightai' / 'local'（与媒体库那侧约定一致）
		const via = !provider ? 'local' : (provider === 'lightai' ? 'lightai' : 'byok:' + provider);
		const asset = await store.importAsset({
			bytes,
			kind: 'image',
			mime: type,
			ext,
			provider: via,
			// `source` 是**来源**（chat / comfyui / local）⇒ 媒体库能筛出"聊天框生成的" ✓
			source: 'chat',
			// ★ 截断：prompt 可能很长（媒体库那侧字段只存摘要，原文在工作区文件名/账本里另有）
			prompt: String(prompt || '').slice(0, 2000),
			model: String(model || ''),
			metaJson: JSON.stringify({
				...(savedPath ? { workspacePath: savedPath } : {}),
				source: 'chat',
			}),
		});
		return String(asset?.id ?? '');
	} catch {
		// 媒体库写失败（磁盘满 / 库锁住…）：正常降级（不影响生图结果，也不刷红字）
		return '';
	}
}

/**
 * IDE 路（老路）：经桥 `media` 能力回 IDE。
 * @returns {Promise<{rawImages: object[], usedProvider: string, usedModel: string}>}
 */
async function requestIdeImages(state, { prompt, numImages, matched, model, provider, quality }) {
	const bridge = state.bridge;
	if (!bridge || typeof bridge.callIDE !== 'function') {
		throw new Error('图像生成要经控制桥回 IDE（模型 provider 在 IDE 进程），但 vssarosBridge 不在（bridge 插件没装/没连）'
			+ '——或在 设置 → 模型 → LightAI 登录，直接用 LightAI 生图');
	}
	const request = { op: 'generateImage', prompt, numImages };
	if (matched) {
		request.width = Number(matched[1]);
		request.height = Number(matched[2]);
	}
	if (model) { request.modelId = model; }
	if (provider) { request.providerId = provider; }
	if (quality) { request.quality = quality; }
	const reply = await bridge.callIDE('ide.request', {
		capability: 'media',
		pluginId: PLUGIN_PACKAGE,
		params: request,
	}, { timeoutMs: IDE_TIMEOUT_MS });
	if (!reply || reply.ok === false) {
		const reason = String(reply?.error ?? reply?.text ?? 'IDE 没回（图像 provider 不可用？）');
		throw new Error(`图像生成失败：${reason}`);
	}
	const rawImages = Array.isArray(reply?.images) ? reply.images : [];
	if (rawImages.length === 0) {
		throw new Error('图像生成失败：provider 没返回图片');
	}
	// ★ 四批⑪：把"这次到底是哪家出的"记进账本 ⇒ 画廊能按 provider 筛。
	//   IDE 回里带了 provider/model 就用它（更准）；没带才回落请求参数。
	return {
		rawImages,
		usedProvider: String(reply?.providerId ?? reply?.provider ?? provider ?? '').trim(),
		usedModel: String(reply?.modelId ?? reply?.model ?? model ?? '').trim(),
	};
}

/**
 * **dsh 侧直连 BYOK 生图**（2026-10-27）：从 dsh 设置拿 `baseURL`、从 `.credentials.yaml` 拿 Key，
 * 直接 POST `{baseURL}/images/generations`（404/405 回退 `/v1`）。不过桥、不碰 IDE。
 *
 * 与 `requestIdeImages` 的分工：那条是"IDE 侧有厂商扩展（`${vendor}.generateImage`）"才需要；
 * 纯 OpenAI 兼容的网关不该再绕道 IDE —— 而那正是 `providers.sync` 已经同步进 dsh 的那批。
 * @returns {Promise<{rawImages: object[], usedProvider: string, usedModel: string}>}
 */
async function requestDshImages(state, { prompt, numImages, model, provider, quality, size, signal }) {
	const wanted = String(provider ?? '').trim();
	// 没给 provider 时（比如画布页调 `state.generateImage`）取第一个可直连的，不猜具体哪家
	const resolved = await pickDshProvider({ settings: state.settings, credentials: state.credentials }, wanted);
	if (!resolved) {
		throw new Error(`provider「${wanted || '(未指定)'}」在 dsh 侧没有可直连的配置：`
			+ '需要 `llm-pi-ai` 设置里有这条路由（`vssaros-bridge` 的 `providers.sync` 会从 IDE 同步过来），'
			+ '并且它的 `apiKeyEnv` 能在 dsh 凭据里解析到值。');
	}
	const out = await generateViaDsh(resolved, {
		prompt, model, size, n: numImages, quality, signal,
	});
	return {
		rawImages: out.rawImages,
		usedProvider: out.providedBy,
		usedModel: String(out.modelId || model || ''),
	};
}

/**
 * LightAI 直连（2026-10-22）：`vssarosLightAI.generate('image', …)` —— 建任务 / 轮询都在 Host 里，不过桥。
 * n 张 = n 个任务并发（LightAI 一个任务出一组；扩展那条路会把 n 静默丢掉 ✗）。部分失败 ⇒ 进 failures；全失败 ⇒ 抛。
 * @returns {Promise<{rawImages: object[], usedProvider: string, usedModel: string}>}
 */
async function requestLightAIImages(state, { prompt, numImages, model, quality, width, height, signal, imageInput }) {
	const service = state.lightai;
	if (!service || typeof service.generate !== 'function') {
		throw new Error('选中了 LightAI，但 dsh 侧 LightAI 生成服务不在（bridge 插件版本太旧，需 ≥ 0.2.38）');
	}
	const params = {
		prompt,
		...(model ? { modelId: model } : {}),
		...(quality ? { quality } : {}),
		...(width && height ? { width, height } : {}),
		...(imageInput ? { imageInput } : {}),
	};
	const settled = await Promise.all(Array.from({ length: numImages }, () =>
		service.generate('image', params, { signal }).then(v => ({ v }), e => ({ e }))));
	const ok = settled.filter(s => s.v);
	if (ok.length === 0) {
		throw new Error(`LightAI 生图失败：${String(settled[0]?.e?.message ?? settled[0]?.e ?? '没有返回图片')}`);
	}
	const rawImages = ok.flatMap(s => (Array.isArray(s.v.images) ? s.v.images : []));
	if (rawImages.length === 0) {
		throw new Error('LightAI 生图失败：任务完成但没有图片');
	}
	return { rawImages, usedProvider: 'lightai', usedModel: String(ok[0].v.modelId ?? model ?? '') };
}

/** 工具定义（`state` 由 apply 注入：桥与 attachments 都是可选服务）。 */
function toolDefinitions(state) {
	return [{
		name: IMAGE_GENERATE_TOOL,
		description: [
			'生成图片并把图直接显示在对话里。',
			'provider=lightai（或 model 是 picture_* 的 LightAI 模型）⇒ 直接调 LightAI（dsh 侧登录）；',
			'其它 provider ⇒ **dsh 直连**（用 `llm-pi-ai` 那条路由的 baseURL + 凭据库里的 Key 调 /images/generations，模型 id 由你给）；',
			'只有"厂商扩展注册的图像模型"才回 IDE。都不指定 ⇒ LightAI 已登录就用 LightAI，其次 dsh 可直连的那家，否则 IDE 默认。',
			'参数：prompt（画面描述，必填）、size（如 1024x1024，可选）、model（图像模型 id，可选）、n（张数，默认 1）。',
			'★ 结果会**存进工作区**（默认 <工作区>/.vssaros-images/，内容寻址 ⇒ 同一张图不重复存）；',
			'   不想要就传 save_to_workspace=false。要改已有图用 edit_image（带参考图的那种）。',
		].join(''),
		parameters: {
			type: 'object',
			properties: {
				prompt: { type: 'string', description: '图片生成提示词（画面描述，越具体越好）' },
				size: { type: 'string', description: '输出尺寸，如 1024x1024（可选，provider 不支持时会被忽略）' },
				model: { type: 'string', description: '图像模型 id（可选；LightAI 的是 picture_*，先用 image_models 看有哪些）' },
				provider: { type: 'string', description: '图像 provider id（可选；lightai = 直连 LightAI；不填 ⇒ LightAI 已登录就用它，否则 IDE 默认）' },
				quality: { type: 'string', description: '生成质量档（如 standard/high；可选，provider 不支持会自己报错）' },
				n: { type: 'number', description: '生成几张（默认 1）' },
				save_to_workspace: { type: 'boolean', description: '是否把图存进工作区（默认 true ⇒ 存到 <工作区>/.vssaros-images/）' },
				save_dir: { type: 'string', description: '落盘目录（相对工作区根，默认 .vssaros-images）' },
			},
			required: ['prompt'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					count: { type: 'integer' },
					text: { type: 'string' },
					savedPaths: { type: 'array', items: { type: 'string' } },
					images: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								attachment: { type: 'object' },
							},
						},
					},
					error: { type: 'string' },
				},
				required: ['ok', 'count'],
			},
			// ★ 文本 + 图片块两段：只有图片块，官方工具卡才会走图片画廊渲染
			//   （`tool.call.images`，见客户端 lib/client.js）。
			render: (_args, value) => {
				const blocks = [];
				if (typeof value?.text === 'string' && value.text) {
					blocks.push({ type: 'text', text: value.text });
				}
				for (const image of value?.images ?? []) {
					if (image?.attachment) {
						blocks.push({ type: 'image', attachment: image.attachment });
					}
				}
				return blocks;
			},
		},
		// 写类（花钱、慢）⇒ 不声明 isConcurrencySafe（默认独占，见工具契约）。
		execute: async (params, exec) => {
			const prompt = String(params?.prompt ?? '').trim();
			if (!prompt) {
				throw new Error('prompt 必填（要生成的画面描述）');
			}
			const result = await generateOneImage(state, {
				prompt,
				size: params?.size,
				model: params?.model,
				provider: params?.provider,
				quality: params?.quality,
				numImages: params?.n,
				askedSave: params?.save_to_workspace,
				saveDir: params?.save_dir,
				signal: exec?.signal,
			});
			// 用户**明确**要求落盘却没落成 ⇒ 报错（不静默）；默认落盘失败 ⇒ 只在文本里说明 ✓。
			if (params?.save_to_workspace === true && result.savedPaths.length === 0) {
				throw new Error('图像生成成功，但落盘失败：' + (result.saveFailures.join('；') || '原因不明'));
			}
			const notes = [];
			// 图 id 告诉模型 ⇒ 它之后能用 `edit_image` 的 `source:'attachment_id'` 改这张图 ✓。
			const ids = result.images.map(item => item.id).filter(Boolean);
			if (ids.length > 0) { notes.push('图 id：' + ids.join('、')); }
			if (result.savedPaths.length > 0) { notes.push('已存到工作区：' + result.savedPaths.join('、')); }
			else if (result.saveFailures.length > 0) { notes.push('没能落盘：' + result.saveFailures.join('；')); }
			const text = (result.failures.length > 0
				? `已生成 ${result.images.length} 张图片（${result.failures.length} 张失败：${result.failures.join('；')}）`
				: `已生成 ${result.images.length} 张图片`)
				+ (notes.length > 0 ? '（' + notes.join('；') + '）' : '');
			return { ok: true, count: result.images.length, text, images: result.images, savedPaths: result.savedPaths };
		},
	},
		// ★ 2026-10-21（三批⑦）：`generate_images` —— 一次给多条 prompt，各出一条图。
		//   语义与上游同名工具一致（上游 `src/index.ts:323-392`）：
		//   · **顺序**执行（一条一条来 ⇒ provider 限流时不打架）；
		//   · **单条失败不中断其余**（进 `failures` 列表，带 index + prompt + 原因）；
		//   · **取消有语义**（`exec.signal.aborted` ⇒ 还没开始的那条记成"已取消"，不硬崩）；
		//   · 一次最多 10 条（多了让模型自己拆 —— 上游也是这个上限）。
		{
			name: GENERATE_IMAGES_TOOL,
			description: [
				'一次生成**多张**图：给一组 prompt，一条 prompt 出一张图（按顺序）。',
				'用于「出一套插画 / 几个方案对比 / 分镜」这类需求；只要一张时用 image_generate。',
				'参数：prompts（必填，1~10 条画面描述）、size、model、provider、quality（对每一条都生效）、',
				'save_to_workspace（是否存进工作区，默认 true）、save_dir。',
				'★ 某一条失败不会中断其余的（失败的那条会出现在结果里，附原因）。',
			].join(''),
			parameters: {
				type: 'object',
				properties: {
					prompts: {
						type: 'array',
						items: { type: 'string' },
						description: '有序的画面描述列表（1~10 条，一条 prompt 出一张图）',
					},
					size: { type: 'string', description: '输出尺寸，如 1024x1024（可选，对每一条都生效）' },
					model: { type: 'string', description: '图像模型 id（可选）' },
					provider: { type: 'string', description: '图像 provider id（可选）' },
					quality: { type: 'string', description: '生成质量档（可选）' },
					save_to_workspace: { type: 'boolean', description: '是否把图存进工作区（默认 true ⇒ 存到 <工作区>/.vssaros-images/）' },
					save_dir: { type: 'string', description: '落盘目录（相对工作区根，默认 .vssaros-images）' },
				},
				required: ['prompts'],
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						ok: { type: 'boolean' },
						count: { type: 'integer' },
						text: { type: 'string' },
						savedPaths: { type: 'array', items: { type: 'string' } },
						failures: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									index: { type: 'integer' },
									prompt: { type: 'string' },
									error: { type: 'string' },
								},
							},
						},
						images: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									attachment: { type: 'object' },
									prompt: { type: 'string' },
								},
							},
						},
					},
					required: ['ok', 'count'],
				},
				render: (_args, value) => {
					const blocks = [];
					if (typeof value?.text === 'string' && value.text) {
						blocks.push({ type: 'text', text: value.text });
					}
					for (const image of value?.images ?? []) {
						if (image?.attachment) {
							blocks.push({ type: 'image', attachment: image.attachment });
						}
					}
					return blocks;
				},
			},
			execute: async (params, exec) => {
				const prompts = Array.isArray(params?.prompts)
					? params.prompts.map(item => String(item ?? '').trim()).filter(item => item.length > 0)
					: [];
				if (prompts.length === 0) {
					throw new Error('prompts 必填（要生成的画面描述，一条一个）');
				}
				if (prompts.length > MAX_BATCH_PROMPTS) {
					throw new Error(`一次最多 ${MAX_BATCH_PROMPTS} 条（收到 ${prompts.length} 条）——请拆成多次调用`);
				}
				// ★ 系统性失败（这条路整个不可用）**先**查一次并直接报错：那是"整个批量都做不了"，
				//   不是"这一条失败" ⇒ 不该被当成 N 条 per-item 失败糊弄过去 ✓（上游同理）。
				//   2026-10-22：走 LightAI 直连时不需要桥 ⇒ 按路由查（LightAI 服务在不在 / 桥在不在）。
				const route = await resolveImageRoute(state, { provider: params?.provider, model: params?.model });
				if (route === 'lightai' && (!state.lightai || typeof state.lightai.generate !== 'function')) {
					throw new Error('选中了 LightAI，但 dsh 侧 LightAI 生成服务不在（bridge 插件版本太旧，需 ≥ 0.2.38）');
				}
				if (route === 'ide' && state.allowIdeFallback === false) {
			throw new Error('IDE 侧生图已关闭（`allowIdeFallback: false`）—— provider 要用 LightAI 或 `llm-pi-ai` 里可直连的那家。');
		}
		if (route === 'ide' && (!state.bridge || typeof state.bridge.callIDE !== 'function')) {
					throw new Error('图像生成要经控制桥回 IDE（模型 provider 在 IDE 进程），但 vssarosBridge 不在（bridge 插件没装/没连）'
						+ '——或在 设置 → 模型 → LightAI 登录，直接用 LightAI 生图');
				}
				const images = [];
				const failures = [];
				const savedPaths = [];
				for (const [index, prompt] of prompts.entries()) {
					// 取消语义：还没开始的那条**记成失败**（不硬崩，也不假装成功）✓
					if (exec?.signal?.aborted) {
						failures.push({ index, prompt, error: '已取消（这一条还没开始）' });
						continue;
					}
					try {
						const result = await generateOneImage(state, {
							prompt,
							size: params?.size,
							model: params?.model,
							provider: params?.provider,
							quality: params?.quality,
							numImages: 1,
							askedSave: params?.save_to_workspace,
							saveDir: params?.save_dir,
							signal: exec?.signal,
						});
						for (const image of result.images) {
							images.push({ ...image, prompt });
						}
						savedPaths.push(...result.savedPaths);
						// 单张存失败（不是整条失败）也如实记进 failures（不静默）✓
						for (const error of result.failures) {
							failures.push({ index, prompt, error });
						}
					} catch (e) {
						failures.push({ index, prompt, error: String(e?.message ?? e) });
					}
				}
				if (images.length === 0) {
					// ★ 一张都没出来 ⇒ **不抛异常**：抛了会变成"红色报错"（取消场景尤其刺眼 ✗）。
					//   而是如实回一份"0/N + 每条为什么失败"（上游 `generate_images` 也是返回失败清单，不抛 ✓）。
					return {
						ok: false,
						count: 0,
						text: '一张都没生成出来（' + prompts.length + ' 条全失败/被取消）：'
							+ (failures.map(item => item.prompt.slice(0, 24) + ' — ' + item.error).join('；') || '原因不明'),
						images: [],
						failures,
						savedPaths: [],
					};
				}
				const notes = [];
				const ids = images.map(item => item.id).filter(Boolean);
				if (ids.length > 0) { notes.push('图 id：' + ids.join('、')); }
				if (savedPaths.length > 0) { notes.push('已存到工作区：' + savedPaths.join('、')); }
				const text = `已生成 ${images.length}/${prompts.length} 张图片`
					+ (failures.length > 0 ? `（${failures.length} 条失败：${failures.map(item => item.prompt.slice(0, 24) + ' — ' + item.error).join('；')}）` : '')
					+ (notes.length > 0 ? '（' + notes.join('；') + '）' : '');
				return { ok: true, count: images.length, text, images, failures, savedPaths };
			},
		},
		// ★ 2026-10-21（三批⑨）：`image_models` —— "这台 IDE 谁能生图"。
		//   模型在生图前得知道**有哪些 provider/模型可选**（否则只能瞎猜一个 model id ✗）。
		//   档位（比例/质量/尺寸）只有 provider **自己登记了**才有 ⇒ 没登记就说"没登记"（不臆造 ✗）。
		{
			name: IMAGE_MODELS_TOOL,
			description: [
				'列出这台机器**能生图的 provider 与模型**（要指定某个 provider/模型生图前先用它看看有哪些可选）。',
				'包含 LightAI（dsh 直连）、**dsh 侧可直连的 BYOK 路由**（标 needsModel：模型 id 要你给，如 gpt-image-1）、',
				'以及 IDE 侧厂商扩展注册的那批（正在废弃；`allowIdeFallback:false` 时不再列出）。',
				'各家支持的比例/质量/尺寸档只有 provider 自己登记了才会有；没登记就是"没登记"（不猜）。',
				'参数：refresh（是否强制刷新，默认用 60 秒内的缓存）。',
			].join(''),
			parameters: {
				type: 'object',
				properties: {
					refresh: { type: 'boolean', description: '强制重新读一次能力表（默认用 60 秒内的缓存）' },
				},
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						ok: { type: 'boolean' },
						text: { type: 'string' },
						providers: { type: 'array', items: { type: 'object' } },
					},
					required: ['ok', 'text'],
				},
				render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
			},
			execute: async (params) => {
				const capabilities = await state.capabilities.load({ force: params?.refresh === true });
				return {
					ok: true,
					text: formatCapabilities(capabilities),
					providers: capabilities.providers,
				};
			},
		},
		// ★ 2026-10-21（三批⑧）：`compare_models` —— 同一条 prompt，**多个 provider/模型各出一张**。
		//   用户要"给我几个方案挑"时用这个（单 provider 重出多次没意义 ⇒ 那用 generate_images 的 n）。
		{
			name: COMPARE_MODELS_TOOL,
			description: [
				'同一个画面描述，让**多个 provider/模型各出一张**（并排给用户挑）。',
				'参数：prompt（必填）、targets（必填，1~4 项，每项 {provider, model?}）、size、quality、save_to_workspace、save_dir。',
				'★ 各家支持的档位不同 ⇒ provider 不支持的质量/尺寸会被去掉（文本里会说清）——先用 image_models 看有哪些可选。',
			].join(''),
			parameters: {
				type: 'object',
				properties: {
					prompt: { type: 'string', description: '画面描述（所有目标用同一条）' },
					targets: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								provider: { type: 'string', description: 'provider id（必填）' },
								model: { type: 'string', description: '模型 id（可选；不填用该 provider 的默认图像模型）' },
							},
						},
						description: '要对比的目标（1~4 项，每项 {provider, model?}）',
					},
					size: { type: 'string', description: '输出尺寸，如 1024x1024（可选）' },
					quality: { type: 'string', description: '生成质量档（可选；provider 不支持会被去掉）' },
					save_to_workspace: { type: 'boolean', description: '是否把图存进工作区（默认 true）' },
					save_dir: { type: 'string', description: '落盘目录（相对工作区根，默认 .vssaros-images）' },
				},
				required: ['prompt', 'targets'],
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						ok: { type: 'boolean' },
						count: { type: 'integer' },
						text: { type: 'string' },
						savedPaths: { type: 'array', items: { type: 'string' } },
						failures: { type: 'array', items: { type: 'object' } },
						images: { type: 'array', items: { type: 'object' } },
					},
					required: ['ok', 'count'],
				},
				render: (_args, value) => {
					const blocks = [];
					if (typeof value?.text === 'string' && value.text) {
						blocks.push({ type: 'text', text: value.text });
					}
					for (const image of value?.images ?? []) {
						if (image?.attachment) {
							blocks.push({ type: 'image', attachment: image.attachment });
						}
					}
					return blocks;
				},
			},
			execute: async (params, exec) => {
				const prompt = String(params?.prompt ?? '').trim();
				if (!prompt) {
					throw new Error('prompt 必填（画面描述）');
				}
				const rawTargets = Array.isArray(params?.targets) ? params.targets : [];
				const targets = rawTargets
					.map(item => ({
						provider: String(item?.provider ?? '').trim(),
						model: String(item?.model ?? '').trim(),
					}))
					.filter(item => item.provider || item.model);
				if (targets.length === 0) {
					throw new Error('targets 必填（每个目标写 {provider, model?}）');
				}
				if (targets.length > 4) {
					throw new Error(`一次最多对比 4 个目标（收到 ${targets.length} 个）——请拆成多次`);
				}
				// 能力表（用于按各家档位校正参数）；读不到就**原样透传**（不因查表失败就做不了对比 ✗）。
				let capabilities;
				try {
					capabilities = await state.capabilities.load();
				} catch {
					capabilities = undefined;
				}
				const notes = [];
				const jobs = targets.map(target => {
					const fit = fitToCapabilities({
						provider: target.provider,
						quality: params?.quality,
						size: params?.size,
					}, capabilities);
					for (const note of fit.notes) {
						notes.push(target.provider + '：' + note);
					}
					return generateOneImage(state, {
						prompt,
						size: fit.size,
						quality: fit.quality,
						model: target.model,
						provider: target.provider,
						askedSave: params?.save_to_workspace,
						saveDir: params?.save_dir,
						signal: exec?.signal,
					})
						.then(result => ({ target, result }))
						.catch(error => ({ target, error: String(error?.message ?? error) }));
				});
				// ★ 并发：各家各发一条（上游同款）⇒ 用户等的是"最慢的那家"而不是"逐家加起来" ✓。
				const settled = await Promise.all(jobs);
				const images = [];
				const failures = [];
				const savedPaths = [];
				for (const item of settled) {
					if (item.error) {
						failures.push({ target: item.target, error: item.error });
						continue;
					}
					for (const image of item.result.images) {
						images.push({ ...image, target: item.target });
					}
					savedPaths.push(...item.result.savedPaths);
				}
				if (images.length === 0) {
					throw new Error('对比全失败：' + (failures.map(item => item.target.provider + ' — ' + item.error).join('；') || '原因不明'));
				}
				const labels = images.map(image => image.target.provider + (image.target.model ? '/' + image.target.model : '')).join('、');
				const text = '已出 ' + images.length + '/' + targets.length + ' 张对比图（' + labels + '）'
					+ (failures.length > 0 ? '；失败：' + failures.map(item => item.target.provider + ' — ' + item.error).join('；') : '')
					+ (notes.length > 0 ? '；' + notes.join('；') : '')
					+ (savedPaths.length > 0 ? '；已存到工作区：' + savedPaths.join('、') : '');
				return { ok: true, count: images.length, text, images, failures, savedPaths };
			},
		},
		// 画布工具（只读两个）：看画布上有什么 / 看用户选中了什么。
		// ⚠ 展开必须在**数组层**（不是对象层）—— 放进对象字面量里会被当成对象展开 ⇒
		//   数组里仍然只有一个工具（还顺手把 image_generate 的 description 覆盖掉了 ✗）（踩过）。
		...canvasToolDefinitions(state),
		// 节点工作流工具：加节点 / 连线 / 跑图（节点图的真源在宿主 ⇒ 不画布页开着也能用）。
		...canvasGraphToolDefinitions(state),
	];
}

/**
 * 工具名**冲突降级**：同名工具注册会抛错（`packages/core/tools`）⇒ 整个插件起不来 ✗。
 *
 * ⚠ dsh 生态里已经有 `canvas_state` / `view_canvas` / `edit_image` / `generate_images`
 *   这几个名字（上游 dsh-image-gen）⇒ 万一同一个 Host 上同时装了两家，
 *   后注册的那个会炸 ⇒ 这里注册前**预检**，被占就退到 `vssaros_<name>`。
 *
 * @param {object} ctx 插件 ctx
 * @param {string} name 想要的名字
 */
function reserveToolName(ctx, name) {
	const tools = ctx?.tools;
	if (!tools || typeof tools.get !== 'function') { return name; }
	let candidate = name;
	for (let i = 0; i < 5; i += 1) {
		let taken = false;
		try {
			taken = Boolean(tools.get(candidate));
		} catch {
			// get 不可用（老版本）⇒ 就用原名（真撞了会抛错，那时看错误信息更直接）。
			return name;
		}
		if (!taken) { return candidate; }
		candidate = 'vssaros_' + candidate;
	}
	return candidate;
}

export function apply(ctx, config = {}) {
	const state = { bridge: null, lightai: null, mediaStore: null, attachments: null, tools: null, canvas: null, canvasImages: createImageLedger(), pluginName: PLUGIN_PACKAGE };
	// ★ 2026-10-27（用户：「生图逻辑都在 dsh 侧，后续废除 IDE 生图」）：
	//   dsh 侧直连 BYOK 生图要读两个**核心服务**（设置里的 provider 路由 + 凭据库里的 Key）。
	//   ⚠ 用 `reflect.get` 的**惰性 getter**，不用 `ctx.inject` —— 后者会让插件"等"服务，
	//     而可选依赖变硬依赖正是本仓反复踩的坑（文件头纪律）。服务晚挂也没关系，每次读时现取。
	const serviceOf = name => {
		try { return ctx.reflect?.get?.(name, false) ?? null; } catch { return null; }
	};
	Object.defineProperty(state, 'settings', { get: () => serviceOf('settings'), enumerable: true });
	Object.defineProperty(state, 'credentials', { get: () => serviceOf('credentials'), enumerable: true });
	/** `allowIdeFallback: false` ⇒ 废除 IDE 生图（provider 不认识就如实报错，不偷偷回 IDE）。 */
	state.allowIdeFallback = config?.allowIdeFallback !== false;
	// ★ 2026-10-21（二批⑤）：工作区根 —— 落盘与 `edit_image` 的 `source:'path'` 都要它。
	//
	// 取值优先级（与 vssaros-codebase 的 `workspaceRootOf` 同口径 ✓）：
	//   ① **运行期工作区上下文**（foundation 的 `workspaceContext()`）—— 切工作区后立刻跟着走
	//      （IDE 经控制桥推 `workspace.context` ⇒ 不用重启 Host ✓）。
	//   ② `config.workspaceRoot`（启动覆盖层那份快照）—— 老 Host / 没推过上下文时的回落。
	//   ③ 都没有 ⇒ **不猜**（返回 undefined）⇒ 工具如实说"不知道工作区根"，不去 `~/.vssaros` 乱写。
	//
	// ⚠ 为什么用 `ctx.reflect.get(...)` 而不是 `ctx.inject(['vssarosFoundation'])`：
	//   inject 会让插件**等**那个服务 ⇒ 组合里没 foundation 时整个插件永远 pending
	//   （文件头那条纪律：可选依赖不能变成硬依赖 ✗）。reflect 是"读，不等" ✓。
	state.resolveWorkspaceRoot = () => {
		try {
			const foundation = ctx.reflect?.get?.('vssarosFoundation', false);
			const runtime = foundation?.workspaceContext?.();
			const root = typeof runtime?.workspaceRoot === 'string' ? runtime.workspaceRoot.trim() : '';
			if (root) { return root; }
		} catch {
			/* foundation 缺席 ⇒ 回落 config ✓ */
		}
		const configured = typeof config?.workspaceRoot === 'string' ? config.workspaceRoot.trim() : '';
		return configured || undefined;
	};
	// ★ 2026-10-21（三批⑨）：图像能力表缓存（"这台 IDE 谁能生图"；60s TTL）。
	state.capabilities = createCapabilityCache(state);
	// ★ 2026-10-21：生图工作台（页面）的生图入口 —— **与工具同一条链路**（`generateOneImage`）
	//   ⇒ 页面与聊天框共用一份"怎么出图"的实现（不复制第二份 ✗）。
	state.generateImage = generateOneImage;
	// ★ 改图与节点图执行：也走**共用实现**（`lib/imageEdit.js` / `lib/canvasRun.js`），
	//   与 `edit_image` 工具逐字一致（不抄第二遍 ✗）。
	state.editImage = editOneImage;
	state.runCanvasGraph = runCanvasGraph;
// ★ 2026-10-21（节点工作流模式，P0）：节点图仓库 —— 宿主侧**唯一真源**。
//   页面与 Agent 工具都改这一份 ⇒ 带乐观并发（revision）+ 冲突合并（见 lib/canvasGraph.js）。
state.canvasGraph = createGraphStore();
// 画布镜像带**溯源查询**：图片元素的 fileId（`img-<出图id>`）⇒ 反查出图时的提示词
// ⇒ 模型的 `canvas_state` 摘要里能读到「这张图是怎么来的」（Excalidraw 元素没有 meta 字段 ⇒ 宿主侧另存）。
state.canvas = createCanvasMirror({
	imageLookup: (fileId) => {
		const id = String(fileId ?? '').replace(/^img-/, '');
		const item = state.canvasImages.get(id);
		return item ? { prompt: item.prompt } : undefined;
	},
	// 节点图真源在同一个 state 里 ⇒ 摘要读的是**当前**那张图（不是页面推来的副本）。
	graphStore: state.canvasGraph,
});

	// 画布路由（**可选**注入 webServer/connection）：没有它们 ⇒ 只是没有画布页面，
	// 工具照常注册（工具在"没有画布"时如实报错，不静默）。
	registerCanvasRoutes(ctx, state);

	// 桥（**可选**注入）：不在 ⇒ 工具照常注册，只是执行时如实报错。
	ctx.inject(['vssarosBridge'], scope => {
		state.bridge = scope.vssarosBridge;
		return () => { state.bridge = null; };
	});

	// LightAI 直连（2026-10-22，**可选**注入）：bridge 插件 ≥ 0.2.38 提供 `vssarosLightAI`
	//   ⇒ 选中 LightAI（或没指定、而 LightAI 已登录）时生图 / 改图直接在 Host 里建任务 / 轮询，不过桥回 IDE。
	//   不在 ⇒ 一切照旧走 IDE。
	ctx.inject(['vssarosLightAI'], scope => {
		// ⚠ 有些宿主的 scope 是"读未知属性即抛"的 Proxy ⇒ 读属性要兜住（缺这个可选服务 = 走 IDE 旧路，不是崩）✓
		let svc = null;
		try { svc = scope.vssarosLightAI ?? null; } catch { svc = null; }
		state.lightai = svc;
		return () => { state.lightai = null; };
	});

	// attachments（**可选**注入）：图片要落内容寻址存储才谈得上"显示在对话里"。
	ctx.inject(['attachments'], scope => {
		state.attachments = scope.attachments;
		return () => { state.attachments = null; };
	});

	// ★ 2026-10-24（P4）：媒体库真源服务（`@vssaros/dsh-media` 的 `ctx.provide('vssarosMediaStore')`）。
	//   生图结果**直接写 dsh 侧媒体库**（不再经桥回 IDE 的过渡通道）。
	//   **可选**：没装媒体库 / 老版本没 provide ⇒ 跳过入库（best-effort，绝不让生图失败）。
	ctx.inject(['vssarosMediaStore'], scope => {
		let svc = null;
		try { svc = scope.vssarosMediaStore ?? null; } catch { svc = null; }
		state.mediaStore = svc;
		return () => { state.mediaStore = null; };
	});

	ctx.effect(() => {
		// ── 双 plane（R13）：同一个包会被挂两次（host plane + preset plane）──
		// `hostHalf: true` ⇒ 这次不注册工具（工具交给 preset 里那次）；缺省 ⇒ 照常注册。
		if (config.hostHalf === true) { return undefined; }

		// ── 审批闸（2026-10-21）──────────────────────────────────────────────
		// 生图**要花钱**（调图像模型的 API）⇒ 与"写用户数据"同一档，官方派发前必须问用户。
		// 契约（`dsh-tools` 的 `tools/pre-execute` waterfall）：返回 `{ kind: 'ask' }` ⇒ 只有审批服务回
		//   `allowed-once` 才执行；**没有审批支持的部署会把 ask 变成拒绝**（fail-closed ✓）。
		// ⚠ 为什么不靠"IDE 侧审批"兜底：反向通道 `ide.request` 的闸门只做**授权**（谁能不能驱动 IDE），
		//   **不弹用户确认**（`dshIdeRequestGate.ts` 全文没有确认这一段）⇒ 审批必须挂在这条工具上 ✓。
		const offApproval = ctx.on('tools/pre-execute', (exec, next) => {
			// ★ 2026-10-21：改图（edit_image）**同样要花钱** ⇒ 一起拦（只拦生图会漏掉改图这条花钱路径）。
			//   ★ 三批⑦：批量生成（generate_images）也是花钱路径 ⇒ 一并拦（漏一条就是白烧钱 ✗）。
			//   ★ 节点图跑图（canvas_run）也是花钱路径 ⇒ 一样要拦。
			const paid = exec && (exec.name === IMAGE_GENERATE_TOOL
				|| exec.name === GENERATE_IMAGES_TOOL
				|| exec.name === COMPARE_MODELS_TOOL
				|| exec.name === EDIT_IMAGE_TOOL
				|| exec.name === CANVAS_RUN_TOOL
				|| exec.name === 'vssaros_' + CANVAS_RUN_TOOL);
			if (!paid) {
				return next();
			}
			return {
				kind: 'ask',
				reason: `${exec.name} 会调用图像模型（生成/修改图片，可能产生费用）`,
				displayReason: {
					en: `Allow ${exec.name} to call the image model (may cost money)?`,
					zh: `允许 ${exec.name} 调用图像模型生成/修改图片（可能产生费用）？`,
				},
			};
		});

		// ★ 工具名冲突降级：被别的插件占了就退到 `vssaros_<name>`（同名注册会抛错 ⇒ 插件起不来 ✗）。
		const disposers = [];
		const registeredNames = [];
		for (const definition of toolDefinitions(state)) {
			const name = reserveToolName(ctx, definition.name);
			const target = name === definition.name ? definition : Object.assign({}, definition, { name });
			registeredNames.push(target.name);
			disposers.push(ctx.tools.register(target));
		}
		state.tools = ctx.tools;
		state.toolNames = registeredNames;
		return () => {
			state.tools = null;
			offApproval();
			for (const dispose of disposers) {
				dispose();
			}
		};
	});
}
