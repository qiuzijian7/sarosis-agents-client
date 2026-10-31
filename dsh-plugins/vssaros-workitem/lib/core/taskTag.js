// 真源：群聊里「这件事要当成一件活」的显式标记 —— `#task:<key>`（用户 2026-10-31 拍板）。
//
// 为什么是**显式**而不是隐式文本指纹：
//   指纹（把整条消息哈希当 key）看着自动，但群聊里"再发一遍、改两个字"是常态 ⇒
//   同一件事会拿到不同 key ⇒ 去重失效、重复派发（正是 loop 侧 ledger 要消灭的事故）。
//   显式标签把"这是同一件事"的判断交回给人，代价是要人配合写标签。
//
// 语法：`#task:<key>`，key 允许 `[A-Za-z0-9_.\-\/]+`（含斜杠 ⇒ `bug/1234` 这种分层 id 能写）。
// 停止于空白 / 中文 / 标点 —— 所以 `#task:1234，帮我看下` 只取 `1234`。
//
// 归一化：**key 一律转小写**再入账（`#task:Bug-1` 与 `#task:bug-1` 是同一件事，
// 否则大小写差异就能绕过去重 —— 这跟 loop 侧 `identityOf` 的稳定性要求是同一条纪律）。

/** `#task:` 标签的识别正则。捕获组就是 key。 */
export const TASK_TAG_RE = /#task:([A-Za-z0-9_.\-/]+)/g;

/** 标签在字符串里出现的位置信息（UI 高亮 / 报错定位用）。 */
function scan(text) {
	const out = [];
	const source = typeof text === 'string' ? text : '';
	for (const match of source.matchAll(TASK_TAG_RE)) {
		out.push({ raw: match[0], key: match[1], index: match.index ?? 0 });
	}
	return out;
}

/** key 归一化（小写 + 去首尾空白）。 */
export const normalizeTaskKey = key => String(key ?? '').trim().toLowerCase();

/**
 * 从一条消息里解析出所有活（去重、保序、空 key 丢弃）。
 * `source` 用于标来源（`'group'`），写进账本条目的 `source` 字段。
 */
export function parseTaskTags(text, { source = 'group' } = {}) {
	const seen = new Set();
	const out = [];
	for (const hit of scan(text)) {
		const key = normalizeTaskKey(hit.key);
		if (!key || seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push({ key, raw: hit.raw, index: hit.index, source });
	}
	return out;
}

/** 这条消息有没有活要做（派发前的快速闸门）。 */
export function hasTaskTag(text) {
	return parseTaskTags(text).length > 0;
}

/**
 * 把标签渲染成人能读的一行（干跑预告 / 群内提示用）。
 * 例：`#task:bug/1234 #task:bug/1235` → `bug/1234、bug/1235`
 */
export function describeTaskTags(text) {
	return parseTaskTags(text).map(tag => tag.key).join('、');
}
