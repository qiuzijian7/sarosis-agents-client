// 模型侧图片内容块 → 本地 Agent 的输入（P2 · 2026-11-09）。
//
// dsh 的 ContentBlock 里图片是 `{ type:'image', attachment: ImageAttachmentRef }`，
// **不是 base64**：字节要经 `attachments.readImage(ref)` 拿（`vssaros-memory/lib/notify.js:147-180`
// 有同款用法）。ACP `session/prompt` 的 prompt 数组按 ACP ContentBlock 规范发
// `{ type:'image', data:<base64>, mimeType:<mediaType> }`（该形状未真机验证，见文档 §6.5）。
//
// ★ 声明与实现必须一致：只有 `kind==='acp'` 且注入了 readImage 的路由才在 resolveModel
//   里声明 `inputModalities:['text','image']`；NDJSON 单轮路由保持纯文本，遇到图片给明确
//   文本提示而不是静默丢弃 —— 不迁移 DS Bot「声明 image 却只发 text」的已知不一致。
import { textOfContent } from './text.js';

export const MAX_IMAGES_PER_TURN = 4;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** 取出合法的图片附件引用；坏块/非图片块忽略。 */
export function imageRefsOf(content) {
	if (!Array.isArray(content)) return [];
	return content
		.filter((part) => part && part.type === 'image' && part.attachment && typeof part.attachment === 'object')
		.map((part) => part.attachment);
}

export function supportsImages(spec, readImage) {
	return spec?.kind === 'acp' && typeof readImage === 'function';
}

/** 最后一条 user 消息的原始 content（含图片块）。 */
export function lastUserContent(options) {
	const messages = Array.isArray(options?.messages) ? options.messages : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === 'user') return messages[i].content;
	}
	return undefined;
}

/** NDJSON 路由没有声明支持图片：给模型一条可读提示，绝不假装看过图。 */
export function imageNoticeOf(content) {
	const count = imageRefsOf(content).length;
	if (!count) return '';
	return `\n[用户附了 ${count} 张图片，但当前 CLI 引擎（NDJSON 单轮）不支持图片输入，已按纯文本继续。`
		+ '若需要看图，请换用 ACP 引擎。]';
}

/**
 * 按原顺序把 RequestMessage.content 投影成 ACP `session/prompt` 的 ContentBlock[]。
 * 读图失败不中断回合：降级成一条明确说明的 text 块（同样不静默丢）。
 * @returns `{ blocks, images }`
 */
export async function acpPromptBlocks({
	content, readImage,
	maxImages = MAX_IMAGES_PER_TURN, maxBytes = MAX_IMAGE_BYTES,
} = {}) {
	const blocks = [];
	let images = 0;
	for (const part of Array.isArray(content) ? content : []) {
		if (part?.type === 'text') {
			const text = String(part.text ?? '');
			if (text) blocks.push({ type: 'text', text });
			continue;
		}
		if (part?.type === 'image' && part.attachment) {
			if (images >= maxImages) {
				blocks.push({ type: 'text', text: `[第 ${images + 1} 张图片超出单次 ${maxImages} 张上限，已省略]` });
				continue;
			}
			try {
				if (typeof readImage !== 'function') throw new Error('附件服务不可用（attachments.readImage 缺失）');
				const stored = await readImage(part.attachment);
				const data = stored?.data;
				if (!data || typeof data.byteLength !== 'number' || data.byteLength === 0) {
					throw new Error('附件字节为空或损坏');
				}
				if (data.byteLength > maxBytes) {
					throw new Error(`图片 ${Math.round(data.byteLength / 1024)}KB 超过 ${Math.round(maxBytes / 1024)}KB 上限`);
				}
				blocks.push({
					type: 'image',
					data: Buffer.from(data).toString('base64'),
					mimeType: String(part.attachment.mediaType ?? 'image/png'),
				});
				images++;
			} catch (error) {
				blocks.push({ type: 'text', text: `[图片未能传给本地 Agent：${String(error?.message ?? error)}]` });
			}
			continue;
		}
		if (part?.type) {
			blocks.push({ type: 'text', text: `[${String(part.type)} 内容未传给本地 Agent]` });
		}
	}
	return { blocks, images };
}

/** 有 system 附加指令时作为前置 text 块；无图片时走纯字符串，保持 P1 行为逐字不变。 */
export function withInstructions(blocks, instructions) {
	const prefix = instructions ? [{ type: 'text', text: instructions }] : [];
	return [...prefix, ...blocks];
}

export { textOfContent };
