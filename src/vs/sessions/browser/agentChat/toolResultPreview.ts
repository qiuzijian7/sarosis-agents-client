/*---------------------------------------------------------------------------------------------
 *  工具结果摘要与规模统计（卡片正文那些预览文案）—— 纯函数，零 DOM 零依赖。
 *
 *  事故（2026-09-22 用户报「unreal 工具卡片中 unreal_help 显示不全」✗✓）：
 *  旧实现（`agentChatPanel.unrealCard.ts` 的私有 `_summarize`）取结果**首行**当摘要 ✗ ——
 *  而 unreal 族的结构化响应统一被 `formatPayload` 美化
 *  （`unrealTools.ts:69` `JSON.stringify(payload, null, 2)` ✓）⇒ 首行恒为 **`{`** ✗✗ ⇒
 *  卡片正文只剩一个孤零零的 `{`，真正内容又藏在「完整结果」折叠里 ⇒ 用户看到的就是"显示不全" ✓✓。
 *
 *  ★ 2026-09-22 真机日志取证（`vscode-app-1790084962792.log` ✓）拿到**真实字段契约** ✓：
 *    · `unreal_exec`   → `{ "ok": true, "repr": null, "output": "UE version: 5.8.1…" }` ✓
 *    · `unreal_health` → `{ "status": "ok", "project": "unknown", "pid": 82016, "uptime_seconds": 17 }` ✓
 *  ⇒ **人可读内容在"内容字段"里**（`output` / `result` / … ✓），直接紧凑整坨 JSON 会把它们挤成噪音 ✗
 *  ⇒ 摘要必须**优先取内容字段** ✓✓（这正是"有的工具会返回结果字段"这条线索的落点 ✓）。
 *--------------------------------------------------------------------------------------------*/

/** 摘要行默认上限（与卡片原值一致 ✓ 便于对照）。 */
export const TOOL_RESULT_SUMMARY_LIMIT = 160;

/**
 * 「内容来源字段」—— 优先级从高到低 ✓（命中即用它的字符串值当摘要源 ✓）。
 * 依据：真机日志里 `unreal_exec.output` 承载 Python stdout ✓；`result` / `text` / `message`
 * 是同类工具（MCP / 委派 / 桥）的常见载体 ✓ ⇒ 统一优先识别 ✓。
 */
const CONTENT_FIELDS = ['output', 'result', 'text', 'message', 'summary', 'docstring'] as const;

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
 * 从已解析的 JSON 里挑出**内容字段**的字符串值 ✓（没有 ⇒ undefined ✓）。
 * 只认**第一层**字符串字段 ✓（够用且可预期 ✓；嵌套结构原样走紧凑 JSON ✓）。
 */
function pickContentField(parsed: unknown): string | undefined {
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return undefined; }
	const obj = parsed as Record<string, unknown>;
	for (const name of CONTENT_FIELDS) {
		const v = obj[name];
		if (typeof v === 'string' && v.trim().length > 0) { return v; }
	}
	return undefined;
}

/**
 * 把工具结果压成**一行有信息量**的摘要 ✓。
 * 顺序：① 解析 JSON ⇒ 先取**内容字段**（`output` 等 ✓）⇒ 再退紧凑 JSON ✓；
 *      ② 非 JSON ⇒ 取第一个"有意义的行" ✓；③ 再退化为整段 ✓。
 */
export function summarizeToolResult(text: string, limit: number = TOOL_RESULT_SUMMARY_LIMIT): string {
	const raw = (text ?? '').trim();
	if (!raw) { return ''; }

	// ① 结构化结果（unreal_help / dump / health / exec 的常态 ✓）
	if (raw.startsWith('{') || raw.startsWith('[')) {
		try {
			const parsed: unknown = JSON.parse(raw);
			// ①a ★ 真机取证：内容在 `output`/`result` 这类字段里 ⇒ **优先取它** ✓✓
			//     （否则 `{"ok":true,"repr":null,"output":"UE version…"}` 会把真内容挤成一行噪音 ✗）
			const fromField = pickContentField(parsed);
			if (fromField) {
				const line = firstMeaningfulLine(fromField);
				if (line) { return clip(line, limit); }
			}
			// ①b 无内容字段（如 `unreal_health` 的 status/project/pid/uptime_seconds ✓）⇒ 紧凑单行 JSON ✓
			const compact = collapseWhitespace(JSON.stringify(parsed));
			if (compact) { return clip(compact, limit); }
		} catch {
			// 非严格 JSON（截断/追加了日志等 ✓）⇒ 落到行级策略 ✓
		}
	}

	// ② 行级：跳过纯括号/标点的"无信息行" ✗（这就是 `{` 被跳过的地方 ✓）
	const line = firstMeaningfulLine(raw);
	if (line) { return clip(line, limit); }

	// ③ 全是无信息行（例如结果就是一坨 JSON 标点 ✗）⇒ 至少给出首段内容 ✓（绝不返回空 ⇒ 卡片不会白板 ✓）
	return clip(collapseWhitespace(raw), limit);
}

/** 取第一个"有意义的行"（跳过空行与纯标点行 ✓）；没有 ⇒ undefined ✓。 */
function firstMeaningfulLine(text: string): string | undefined {
	for (const line of (text ?? '').split('\n')) {
		const t = line.trim();
		if (t.length === 0 || MEANINGLESS_LINE.test(t)) { continue; }
		return collapseWhitespace(t);
	}
	return undefined;
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
