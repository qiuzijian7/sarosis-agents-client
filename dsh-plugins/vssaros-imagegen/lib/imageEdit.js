/**
 * 改图（按参考图改）的宿主侧共用实现。
 *
 * 为什么抽出来：edit_image 工具与节点图执行引擎都要按参考图改，
 * 两条链路的落盘与失败口径必须一致，抄一遍就会漂。
 */
import { maybeSaveToWorkspace } from './workspaceSave.js';
import { decodeBase64, decodeDataUrl } from './imageBytes.js';

const IDE_TIMEOUT_MS = 10 * 60 * 1000;

function decodeImagePayload(raw) {
	const text = String((raw && (raw.b64 ?? raw.url)) ?? '');
	if (!text) { return undefined; }
	try {
		if (text.startsWith('data:')) { return decodeDataUrl(text); }
		const bytes = decodeBase64(text);
		if (!bytes || bytes.length === 0) { return undefined; }
		return { bytes, mediaType: 'image/png' };
	} catch {
		return undefined;
	}
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
	const bridge = state.bridge;
	if (!bridge || typeof bridge.callIDE !== 'function') {
		throw new Error('改图要经控制桥回 IDE（模型 provider 在 IDE 进程），但 vssarosBridge 不在（bridge 插件没装/没连）');
	}
	const reply = await bridge.callIDE('ide.request', {
		capability: 'media',
		pluginId: state.pluginName,
		params: {
			op: 'editImage',
			prompt,
			image,
			...(options.model ? { modelId: String(options.model) } : {}),
		},
	}, { timeoutMs: IDE_TIMEOUT_MS });
	if (!reply || reply.ok === false) {
		throw new Error('改图失败：' + String(reply?.error ?? reply?.text ?? 'IDE 没回'));
	}
	const rawImages = Array.isArray(reply?.images) ? reply.images : [];
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
			const payload = decodeImagePayload(raw);
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
