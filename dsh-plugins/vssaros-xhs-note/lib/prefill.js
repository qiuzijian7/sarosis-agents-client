// @vssaros/dsh-xhs-note — 把草稿变成 composer 预填文案（硬伤 3）。
//
// 为什么单独一个纯函数文件：文案策略（截断 / 指令 / 去重键）是最容易反复改的部分，
//   抽出来就能被单测钉住，也不用把 React 搬进 Node 测试。
export const PREFILL_HEAD = '这是我正在写的小红书笔记，请不要改变事实，只做润色与结构优化：';
export const PREFILL_TASK = '要求：保持第一人称与真实感；标题给 3 个更有点击欲的备选；正文控制在 600 字内；最后给出话题标签。';

/** 正文超过这个长度就只带前 `BODY_KEEP` 个字（别把 4000 字灌进 composer）。 */
export const BODY_LIMIT = 1200;
export const BODY_KEEP = 600;

const oneLine = (value, max) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * @param {{ topic?: string, title?: string, body?: string, tags?: string }} draft
 * @returns {string} 预填到输入框的整段文本（**不自动发送**，用户可改可弃）
 */
export function buildPrefillPrompt(draft) {
	const topic = oneLine(draft?.topic, 120);
	const title = oneLine(draft?.title, 160);
	const rawBody = String(draft?.body || '').trim();
	const body = rawBody.length > BODY_LIMIT
		? rawBody.slice(0, BODY_KEEP).trimEnd() + '…（后略，全文在工作台）'
		: rawBody;
	const tags = oneLine(draft?.tags, 300);
	const lines = [PREFILL_HEAD, '', '【主题】' + (topic || '（未填）'), '【标题】' + (title || '（未填）')];
	lines.push('【正文】' + (body || '（空）'));
	if (tags) { lines.push('【标签】' + tags); }
	lines.push('', PREFILL_TASK);
	return lines.join('\n');
}

/** 去重键：同一会话 + 同一稿 + 同一 rev 只预填一次（避免每点一次「AI 协助」就追加一遍）。 */
export function prefillKey({ sessionId, draftId, rev }) {
	return [String(sessionId || ''), String(draftId || ''), String(rev ?? '')].join('|');
}
