/**
 * 画布工具：`canvas_state`（看画布上有什么）+ `view_canvas`（看用户选中了什么，带截图）
 * + `edit_image`（**按参考图**去改）。
 *
 * 为什么 `edit_image` 单独一个工具：改图与生图的**输入不同**（多一张参考图）⇒ 混在一个工具里
 * 模型很容易忘记传参考图 ⇒ 变成「凭空再生成一张」（用户以为在改图，其实没有 ✗）。
 *
 * ⚠ **降级必须如实说**：IDE 侧 provider 的 edits 端点不可用时会回退为文生图（参考图被忽略）
 *   ⇒ 回执带 `degraded` ⇒ 这里把它写进文本，让用户看见「参考图没被采纳」。
 *
 * ★ 2026-10-21（二批⑥）：`edit_image` 支持**三种参考图来源**（`source`）：
 *   · `canvas_selection`（默认）——画布选区；**能用原图就别用截图**（判据在
 *     `canvasState.js` 的 `selectionReference()`：选区只有图 ⇒ 用原图，原分辨率不降质 ✓）。
 *   · `attachment_id`——本机「最近出图」账本里的图（生图/改图回执里带的那个 id）。
 *   · `path`——工作区里的文件（目录包含性校验：工作区外一律拒 ✓）。
 *
 * ★ 2026-10-21（二批⑤）：改图/生图的结果**落进工作区**（内容寻址 + 原子写）⇒
 *   用户拿得到"我的图"（见 `lib/workspaceSave.js`）。
 */

import { readImageFile } from './workspaceSave.js';
import { decodeDataUrl } from './imageBytes.js';
import { editOneImage } from './imageEdit.js';


export const CANVAS_STATE_TOOL = 'canvas_state';
export const VIEW_CANVAS_TOOL = 'view_canvas';
export const EDIT_IMAGE_TOOL = 'edit_image';

/** dataURL ⇒ bytes（画布页推上来的选区截图是 dataURL）—— 解析统一在 `lib/imageBytes.js`。 */

/** `canvas_state` / `view_canvas` 的定义。 */
function readTools(state) {
	const noCanvas = () => {
		throw new Error('现在没有画布连着（用户还没打开画布工作台，或画布页已关闭）——先让用户打开画布，或直接用文字描述需求。');
	};
	return [{
		name: CANVAS_STATE_TOOL,
		description: [
			'看画布工作台当前有什么：对象数量、用户选中了哪些（文字描述）、以及画布多久没动。',
			'★ 只读：想按画布改图要用 edit_image（它需要用户在画布上选中一张图片）。',
			'★ 没有画布时这个工具会明确报错——那表示用户还没打开画布，不是"画布是空的"。',
		].join(''),
		parameters: { type: 'object', properties: {}, required: [] },
		output: {
			schema: {
				type: 'object',
				properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
				required: ['ok', 'text'],
			},
			render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
		},
		execute: async () => {
			const entry = state.canvas?.latest?.();
			if (!entry) { noCanvas(); }
			return { ok: true, text: entry.digest() };
		},
	}, {
		name: VIEW_CANVAS_TOOL,
		description: [
			'看用户**在画布上选中的东西**（带截图）：返回选区的人话描述 + 选区图片。',
			'什么时候用：用户说"照这个改"、"按我画的来" ⇒ 先调它看选区，再决定要不要用 edit_image。',
			'★ 没有画布或没有选中时会明确说清（不是空结果）。',
		].join(''),
		parameters: { type: 'object', properties: {}, required: [] },
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					text: { type: 'string' },
					images: { type: 'array', items: { type: 'object', properties: { attachment: { type: 'object' } } } },
				},
				required: ['ok', 'text'],
			},
			render: (_args, value) => {
				const blocks = [{ type: 'text', text: String(value?.text ?? '') }];
				for (const image of value?.images ?? []) {
					if (image?.attachment) { blocks.push({ type: 'image', attachment: image.attachment }); }
				}
				return blocks;
			},
		},
		execute: async () => {
			const entry = state.canvas?.latest?.();
			if (!entry) { noCanvas(); }
			if (entry.selectedIds.length === 0) {
				// ★ 节点模式：用户选的是**节点**，不是画面对象 ⇒ 提示不能说"请框选"（误导 ✗）。
				const tail = entry.mode === 'graph'
					? '（节点工作流模式：用户选中的是节点，不是画面对象。'
						+ '要"按参考图改图"，得请用户切到「自由绘制」并框选。）'
					: '（用户没有选中任何对象：请让用户先在画布上框选要处理的东西。）';
				return { ok: true, text: entry.digest() + '\n' + tail, images: [] };
			}
			const images = [];
			if (entry.selectionPng) {
				const decoded = decodeDataUrl(entry.selectionPng);
				const attachments = state.attachments;
				if (decoded && attachments && typeof attachments.saveImage === 'function') {
					try {
						const attachment = await attachments.saveImage({
							data: decoded.bytes,
							mediaType: decoded.mediaType,
							name: 'canvas-selection',
						});
						if (attachment) { images.push({ attachment }); }
					} catch (e) {
						return { ok: true, text: entry.digest() + '\n（选区截图存成附件失败：' + String(e?.message ?? e) + '）', images: [] };
					}
				}
			}
			return { ok: true, text: entry.digest(), images };
		},
	}];
}

/** 字节 ⇒ data URL（provider 的参考图只认 data URL ✓）。 */
function toDataUrl(bytes, mediaType) {
	const buffer = Buffer.from(bytes ?? []);
	const type = String(mediaType ?? 'image/png').trim() || 'image/png';
	return 'data:' + type + ';base64,' + buffer.toString('base64');
}

/**
 * 解析参考图（三种来源，见文件头）。
 *
 * @param {object} state 宿主侧状态
 * @param {string} source `canvas_selection` / `attachment_id` / `path`
 * @param {object} params 工具参数
 * @returns {Promise<{dataUrl: string, note: string}>} 解析不出来就**抛错**（不静默换一张图）
 */
async function resolveReference(state, source, params) {
	if (source === 'canvas_selection') {
		const entry = state.canvas?.latest?.();
		if (!entry) {
			throw new Error('现在没有画布连着（用户还没打开画布工作台）——先让用户在画布上选中要改的那张图。');
		}
		if (entry.selectedIds.length === 0) {
			throw new Error('画布上当前没有选中任何东西——请让用户先在画布工作台里框选要改的图。');
		}
		// ★ "能用原图就别用截图"：判据在 CanvasEntry 里（选区是否只有图片）。
		const ref = entry.selectionReference?.();
		if (!ref || ref.kind === 'none' || !ref.dataUrl) {
			throw new Error('用户选中的不是一张图片（选区里没有原图）——这个工具只能改「选中的图片」。');
		}
		return { dataUrl: ref.dataUrl, note: String(ref.note ?? '') };
	}
	if (source === 'attachment_id') {
		const id = String(params?.attachment_id ?? '').trim();
		if (!id) {
			throw new Error('source=attachment_id 时必须给 attachment_id（生图/改图回执里带的那个图 id）。');
		}
		const item = state.canvasImages?.find?.(id);
		if (!item) {
			throw new Error('找不到 id=' + id + ' 这张图（只认本机「最近出图」账本里的图：生图/改图回执里带的那个 id）。');
		}
		const attachments = state.attachments;
		if (!attachments || typeof attachments.readImage !== 'function') {
			throw new Error('attachments 服务不在（读不到那张图的字节）');
		}
		const raw = await attachments.readImage(item.attachment);
		// readImage 的返回形状三种都认（别猜）——与 canvasRoutes.js 同口径 ✓。
		const bytes = raw?.bytes ? raw.bytes : (raw?.data ? raw.data : raw);
		if (!bytes) {
			throw new Error('附件读回来是空的（id=' + id + '）');
		}
		return { dataUrl: toDataUrl(bytes, item.mediaType), note: '参考图用的是最近出图 ' + id + '（原图）' };
	}
	if (source === 'path') {
		const raw = String(params?.path ?? '').trim();
		if (!raw) {
			throw new Error('source=path 时必须给 path（工作区里那张图的路径）。');
		}
		const read = await readImageFile({ path: raw, root: state.resolveWorkspaceRoot?.() });
		if (!read.ok) {
			throw new Error('读图失败：' + read.error);
		}
		return { dataUrl: toDataUrl(read.bytes, read.mediaType), note: '参考图用的是工作区里的文件 ' + read.path };
	}
	throw new Error('source 只认 canvas_selection / attachment_id / path（收到：' + source + '）');
}

/** `edit_image`：按参考图改（来源三选一，见文件头）。 */
function editImageTool(state) {
	return {
		name: EDIT_IMAGE_TOOL,
		description: [
			'按**参考图**改图（用户说「照我画的改」「按这个改」时用这个）。',
			'参考图来源（source）：canvas_selection（默认，画布上用户选中的那张图；能用原图就用原图，不降质）、',
			'attachment_id（之前生成过的那张图，回执里的 id）、path（工作区里的图片文件）。',
			'参数：prompt（要改成什么样，必填）、source、attachment_id、path、model（图像模型 id，可选）。',
			'★ 如果这个图像服务不支持图生图，会退回成按文字重新生成——本工具会如实告诉你这件事。',
		].join(''),
		parameters: {
			type: 'object',
			properties: {
				prompt: { type: 'string', description: '要怎么改（中文描述，如「把它改成水彩风格」）' },
				source: {
					type: 'string',
					enum: ['canvas_selection', 'attachment_id', 'path'],
					description: '参考图来源：canvas_selection（默认，画布选区）/ attachment_id（之前生成的图）/ path（工作区里的文件）',
				},
				attachment_id: { type: 'string', description: 'source=attachment_id 时给图 id（生图/改图回执里带的那个）' },
				path: { type: 'string', description: 'source=path 时给图片路径（工作区内的文件）' },
				model: { type: 'string', description: '图像模型 id（可选；不填用 IDE 侧默认的图像模型）' },
				save_to_workspace: { type: 'boolean', description: '是否把改出来的图存进工作区（默认 true ⇒ 存到 <工作区>/.vssaros-images/）' },
				save_dir: { type: 'string', description: '落盘目录（相对工作区根，默认 .vssaros-images）' },
			},
			required: ['prompt'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					text: { type: 'string' },
					degraded: { type: 'boolean' },
					savedPaths: { type: 'array', items: { type: 'string' } },
					images: { type: 'array', items: { type: 'object', properties: { attachment: { type: 'object' } } } },
				},
				required: ['ok', 'text'],
			},
			render: (_args, value) => {
				const blocks = [{ type: 'text', text: String(value?.text ?? '') }];
				for (const image of value?.images ?? []) {
					if (image?.attachment) { blocks.push({ type: 'image', attachment: image.attachment }); }
				}
				return blocks;
			},
		},
		execute: async (params) => {
			const prompt = String(params?.prompt ?? '').trim();
			if (!prompt) { throw new Error('prompt 必填（要改成什么样）'); }
			const source = String(params?.source ?? 'canvas_selection').trim() || 'canvas_selection';
			const reference = await resolveReference(state, source, params);
			// ★ 执行与记账走**共用实现**（`lib/imageEdit.js`）—— 节点图的执行引擎也用它
			//   ⇒ 两条链路的落盘 / 记账 / 降级口径**逐字一致**（不抄第二遍 ✗）。
			const result = await editOneImage(state, {
				prompt,
				image: reference.dataUrl,
				model: params?.model,
				askedSave: params?.save_to_workspace,
				saveDir: params?.save_dir,
			});
			// 用户**明确**要求落盘却没落成 ⇒ 报错（不静默）；默认落盘失败 ⇒ 只在文本里说明 ✓。
			if (params?.save_to_workspace === true && result.savedPaths.length === 0) {
				throw new Error('改图成功，但落盘失败：' + (result.saveFailures.join('；') || '原因不明'));
			}
			const degraded = result.degraded === true;
			const notes = [];
			if (reference.note) { notes.push(reference.note); }
			if (result.savedPaths.length > 0) {
				notes.push('已存到工作区：' + result.savedPaths.join('、'));
			} else if (result.saveFailures.length > 0) {
				notes.push('（没能落盘：' + result.saveFailures.join('；') + '）');
			}
			const text = (degraded
				? '已改图 ' + result.images.length + ' 张，但**参考图没有被采纳**：' + String(result.degradedReason || '这个图像服务不支持图生图，已按文字重新生成') + '。'
				: '已按画布选区改图 ' + result.images.length + ' 张。')
				+ (notes.length > 0 ? '（' + notes.join('；') + '）' : '');
			return {
				ok: true,
				text,
				degraded,
				images: result.images,
				savedPaths: result.savedPaths,
			};
		},
	};
}

/**
 * 画布工具定义。
 * @param {object} state 宿主侧状态：`state.canvas` = 镜像，`state.attachments` = 附件服务，
 *   `state.bridge` = 控制桥，`state.pluginName` = 包名（桥授权按包名建）。
 */
export function canvasToolDefinitions(state) {
	return [...readTools(state), editImageTool(state)];
}
