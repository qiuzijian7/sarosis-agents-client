/**
 * 改图（按参考图改）的宿主侧共用实现。
 *
 * 为什么抽出来：edit_image 工具与节点图执行引擎都要按参考图改，
 * 两条链路的落盘与失败口径必须一致，抄一遍就会漂。
 */
import { maybeSaveToWorkspace } from './workspaceSave.js';
import { decodeBase64, decodeDataUrl, normalizeMediaType } from './imageBytes.js';
import { resolveImageRoute } from './capabilities.js';

const IDE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 一张回图 ⇒ 字节。三种来源：data URL / 裸 base64 / **http(s) URL**（LightAI 回的是带签名的 COS 地址 ⇒
 * Host 进程去取；以前这里不认 URL ⇒ 回 URL 的 provider 改图会"成功但存不下来"✗）。
 */
async function decodeImagePayload(raw) {
	const text = String((raw && (raw.b64 ?? raw.url)) ?? '');
	if (!text) { return undefined; }
	try {
		if (text.startsWith('data:')) { return decodeDataUrl(text); }
		if (/^https?:\/\//i.test(text)) {
			const response = await fetch(text);
			if (!response.ok) { throw new Error(`取回改好的图失败：HTTP ${response.status}`); }
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.length === 0) { return undefined; }
			return { bytes, mediaType: normalizeMediaType((response.headers.get('content-type') ?? '').split(';')[0]) };
		}
		const bytes = decodeBase64(text);
		if (!bytes || bytes.length === 0) { return undefined; }
		return { bytes, mediaType: 'image/png' };
	} catch (e) {
		if (/取回改好的图失败/.test(String(e?.message ?? ''))) { throw e; }
		return undefined;
	}
}

/**
 * 取回执：LightAI 直连（2026-10-22）或经桥回 IDE（老路）。
 * @returns {Promise<{images: object[], degraded: boolean, degradedReason: string}>}
 */
async function requestEdit(state, { prompt, image, model, provider, signal }) {
	const route = await resolveImageRoute(state, { provider, model });
	if (route === 'lightai') {
		const service = state.lightai;
		if (!service || typeof service.generate !== 'function') {
			throw new Error('选中了 LightAI，但 dsh 侧 LightAI 生成服务不在（bridge 插件版本太旧，需 ≥ 0.2.38）');
		}
		// 参考图走 LightAI 的上传（/api/public/upload）⇒ 模型按参考图出图（gpt-image 自动切 edits 端点）
		const out = await service.generate('image', { prompt, imageInput: image, ...(model ? { modelId: model } : {}) }, { signal });
		return { images: Array.isArray(out?.images) ? out.images : [], degraded: false, degradedReason: '' };
	}
	const bridge = state.bridge;
	if (!bridge || typeof bridge.callIDE !== 'function') {
		throw new Error('改图要经控制桥回 IDE（模型 provider 在 IDE 进程），但 vssarosBridge 不在（bridge 插件没装/没连）'
			+ '——或在 设置 → 模型 → LightAI 登录，直接用 LightAI 改图');
	}
	const reply = await bridge.callIDE('ide.request', {
		capability: 'media',
		pluginId: state.pluginName,
		params: {
			op: 'editImage',
			prompt,
			image,
			...(model ? { modelId: String(model) } : {}),
			...(provider ? { providerId: String(provider) } : {}),
		},
	}, { timeoutMs: IDE_TIMEOUT_MS });
	if (!reply || reply.ok === false) {
		throw new Error('改图失败：' + String(reply?.error ?? reply?.text ?? 'IDE 没回'));
	}
	return {
		images: Array.isArray(reply?.images) ? reply.images : [],
		degraded: reply?.degraded === true,
		degradedReason: String(reply?.degradedReason ?? ''),
	};
}

/**
 * 按参考图改一张图（只管执行与记账，不组装给用户看的文本）。
 *
 * @param {object} state 宿主状态（bridge / attachments / canvasImages / resolveWorkspaceRoot）
 * @param {object} options
 * @param {string} options.prompt 要改成什么样
 * @param {string} options.image 参考图（data URL）
 * @param {string} [options.model] 图像模型 id
 * @param {boolean} [options.askedSave] 是否存进工作区（undefined = 默认存）
 * @param {string} [options.saveDir] 落盘目录（相对工作区根）
 * @returns {Promise<{images: Array<object>, savedPaths: string[], saveFailures: string[],
 *   failures: string[], degraded: boolean, degradedReason: string}>}
 */
export async function editOneImage(state, options = {}) {
	const prompt = String(options.prompt ?? '').trim();
	if (!prompt) { throw new Error('prompt 必填（要改成什么样）'); }
	const image = String(options.image ?? '').trim();
	if (!image) { throw new Error('参考图必填（image 要是 data URL）'); }
	const reply = await requestEdit(state, {
		prompt,
		image,
		model: String(options.model ?? '').trim(),
		provider: String(options.provider ?? '').trim(),
		signal: options.signal,
	});
	const rawImages = reply.images;
	if (rawImages.length === 0) { throw new Error('改图失败：provider 没返回图片'); }
	const attachments = state.attachments;
	if (!attachments || typeof attachments.saveImage !== 'function') {
		throw new Error('改图成功但 attachments 服务不在（图片无处存放）');
	}
	const images = [];
	const failures = [];
	const savedPaths = [];
	const saveFailures = [];
	for (const raw of rawImages) {
		try {
			const payload = await decodeImagePayload(raw);
			if (!payload) { throw new Error('这张图的字节解不开（provider 回的不是可存的图）'); }
			const attachment = await attachments.saveImage({
				data: payload.bytes,
				mediaType: payload.mediaType,
				name: 'edit-image',
			});
			const recorded = state.canvasImages?.record?.({ attachment, mediaType: payload.mediaType, prompt });
			images.push({ attachment, id: recorded?.id });
			const saved = await maybeSaveToWorkspace({
				asked: options.askedSave,
				bytes: payload.bytes,
				mediaType: payload.mediaType,
				root: state.resolveWorkspaceRoot?.(),
				dir: options.saveDir,
			});
			if (saved.saved) { savedPaths.push(saved.path); }
			else if (saved.error) { saveFailures.push(saved.error); }
		} catch (e) {
			/* 单张存失败就不放它（不静默丢掉整批，也不因此中断其余的） */
			failures.push(String(e?.message ?? e));
		}
	}
	if (images.length === 0) { throw new Error('改图成功但图片没存下来'); }
	return {
		images,
		savedPaths,
		saveFailures,
		failures,
		degraded: reply?.degraded === true,
		degradedReason: String(reply?.degradedReason ?? ''),
	};
}
