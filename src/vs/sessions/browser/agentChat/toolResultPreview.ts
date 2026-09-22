/*---------------------------------------------------------------------------------------------
 *  工具结果摘要与规模统计（卡片正文那些预览文案）—— 纯函数，零 DOM 零依赖。
 *
 *  事故（2026-09-22 用户报「unreal 工具卡片中 unreal_help 显示不全」✗✓）：
 *  旧实现（`agentChatPanel.unrealCard.ts` 的私有 `_summarize`）取结果**首行**当摘要 ✗ ——
 *  而 unreal 族的结构化响应统一被 `formatPayload` 美化
 *  （`unrealTools.ts:69` `JSON.stringify(payload, null, 2)` ✓）⇒ 首行恒为 **`{`** ✗✗ ⇒
 *  卡片正文只剩一个孤零零的 `{`，真正内容又藏在「完整结果」折叠里 ⇒ 用户看到的就是"显示不全" ✓✓
 *  （与真机截图完全一致 ✓）。
 *
 *  ⇒ 摘要必须**跳过无信息行**（纯 `{` / `[` / `]` / `}` / 标点 ✓），结构化结果走**单行紧凑预览**
 *    （`JSON.stringify(parsed)` ✓ 至少能看见 key ✓），纯文本才退回"首个有意义的行" ✓。
 *  ⇒ 另外提供**规模与截断识别** ✓：卡片要把「点开有多少行/多少字符」「是否已被截断」如实说出来
 *    （服务侧发给模型时确实会截断：`historyCompaction.TRUNCATED_FOR_IPC_SUFFIX` ✓）——
 *    否则用户会把「结果只有这么点」误判成工具坏了 ✗✓。
 *--------------------------------------------------------------------------------------------*/

/** 摘要行默认上限（与卡片原值一致 ✓ 便于对照）。 */
export const TOOL_RESULT_SUMMARY_LIMIT = 160;

/** 只由括号/标点/空白组成的行 —— 当摘要毫无信息量，必须跳过 ✗。 */
const MEANINGLESS_LINE = /^[\s{}[\]()<>:;,."'`|\\/]+$/;

/**
 * 结果里的**截断标记**：
 *  · 服务侧发给模型时追加的 `...[truncated for IPC]`（`historyCompaction.TRUNCATED_FOR_IPC_SUFFIX` ✓）；
 *  · 工具/桥侧自己写的 `… (已截断)`（如 `unreal_exec` 的代码片段 ✓）。
 */
const TRUNCATION_MARK = /\[truncated for IPC\]|\(已截断\)|… \(已截断\)/;

/** 折叠空白（换行/多空格 ⇒ 单空格），让预览始终是**一行** ✓。 */
function collapseWhitespace(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

/** 按上限截断并加省略号 ✓（超长时才加 ✗）。 */
function clip(s: string, limit: number): string {
	const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : TOOL_RESULT_SUMMARY_LIMIT;
	return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 把工具结果压成**一行有信息量**的摘要 ✓。
 * 顺序：① 整段是合法 JSON ⇒ 单行紧凑预览 ✓；② 否则取第一个"有意义的行" ✓；③ 再退化为整段首段 ✓。
 */
export function summarizeToolResult(text: string, limit: number = TOOL_RESULT_SUMMARY_LIMIT): string {
	const raw = (text ?? '').trim();
	if (!raw) { return ''; }

	// ① 结构化结果（unreal_help / unreal_dump / unreal_health 的常态 ✓）：
	//    紧凑成一行 ⇒ 至少能看见 `{"symbol":…,"members":[…]}` 这类关键信息 ✓✓（旧实现只剩 `{` ✗）
	if (raw.startsWith('{') || raw.startsWith('[')) {
		try {
			const parsed: unknown = JSON.parse(raw);
			const compact = collapseWhitespace(JSON.stringify(parsed));
			if (compact) { return clip(compact, limit); }
		} catch {
			// 非严格 JSON（截断/追加了日志等 ✓）⇒ 落到行级策略 ✓
		}
	}

	// ② 行级：跳过纯括号/标点的"无信息行" ✗（这就是 `{` 被跳过的地方 ✓）
	const lines = raw.split('\n');
	for (const line of lines) {
		const t = line.trim();
		if (t.length === 0 || MEANINGLESS_LINE.test(t)) { continue; }
		return clip(collapseWhitespace(t), limit);
	}

	// ③ 全是无信息行（例如结果就是一坨 JSON 标点 ✗）⇒ 至少给出首段内容 ✓（绝不返回空 ⇒ 卡片不会白板 ✓）
	return clip(collapseWhitespace(raw), limit);
}

/** 结果是否**已被截断**（卡片据此如实标注 ✓，不再让用户误判 ✗）。 */
export function isTruncatedResult(text: string): boolean {
	return TRUNCATION_MARK.test(text ?? '');
}

/** 结果规模（元信息行用 ✓ 也用于判断「该不该展开」✓）。 */
export interface IToolResultStats {
	readonly lines: number;
	readonly chars: number;
	readonly truncated: boolean;
}

/** 统计结果规模（全空白 ⇒ 全 0 ✓）。 */
export function resultStats(text: string): IToolResultStats {
	const raw = text ?? '';
	const trimmed = raw.trim();
	return {
		lines: trimmed ? trimmed.split('\n').length : 0,
		chars: trimmed.length,
		truncated: isTruncatedResult(raw),
	};
}

/** 结果行数（用于「完整结果（N 行）」提示 ✓ —— 让用户知道点开有多少 ✓）。 */
export function countResultLines(text: string): number {
	const raw = (text ?? '').trim();
	if (!raw) { return 0; }
	return raw.split('\n').length;
}
