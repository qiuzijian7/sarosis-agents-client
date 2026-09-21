/*---------------------------------------------------------------------------------------------
 *  toolCallNameSanitizer.ts — 工具名字的**伪 XML 泄漏**归一化（2026-09-21，真机取证）
 *
 *  背景（http-debug SSE 原文实证）：上游（hy4-preview-ioa / IOA 网关）在解析**并行工具调用**时，
 *  会把模型伪 XML 框里的两个 tag 连同标记一起粘进 **native tool call 的 name 字段**：
 *
 *      "name": "index_status</tool_call:6124c78e><tool_call:6124c78e>search_files"
 *
 *  而紧随其后的 arguments chunk 携带的是**最后一个 tag** 的参数（本例 `search_files` 的
 *  `pattern/mode/path`）。此前坏名字一路走到 piLoop `prepareToolCall` → `未找到名为…的工具`
 *  → 模型被迫重试一轮（还留下一张失败卡）。
 *
 *  归一化策略（该协议下语义正确）：**按标记切分、取最后一个合法工具名 token**
 *  （args 属最后一个 tag）；同时把被丢弃的片段记录下来（日志/判读用）。
 *
 *  ⚠ 与 `agentRunState.detectXmlToolCallLeak`（文本守卫）分工：
 *  它管「伪 XML 写在**文本**里」；本模块管「伪 XML 混进了 **name 字段**」——后者守卫此前无人覆盖。
 *--------------------------------------------------------------------------------------------*/

// 与 agentRunState.TAGGED_ID_SCAN_RE 同形（该模块未导出常量；本模块需匹配长度做切分，故本地声明）：
// `<tag:hexid>` / `</tag:hexid>` 形态伪标签，id 为 6+ 位十六进制或纯数字。
const TAGGED_ID_MARKER_RE = /<\s*\/?\s*[A-Za-z_][\w.-]*\s*:\s*(?:[0-9a-fA-F]{6,}|\d+)\s*>/g;

/** 合法工具名形态（与本仓工具注册/调用约定一致：`index_status` / `mermaid_render` 等）。 */
const TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export interface IToolCallNameSanitizeResult {
	/** 归一化后的名字；无法修复时保持原值。 */
	readonly name: string;
	/** 是否发生了归一化（有标记且成功取出一个合法 token）。 */
	readonly repaired: boolean;
	/** 名字含伪 XML 标记（无论是否修复成功）⇒ 上游曾发生泄漏，应留可观测痕迹。 */
	readonly tainted: boolean;
	/** 按标记切分得到的全部片段（原顺序），供日志/判读。 */
	readonly fragments: readonly string[];
}

/** 名字是否含伪 XML 标记（`<tag:hexid>` / `</tag:hexid>` 形态）。 */
export function hasPseudoXmlMarkers(name: string | undefined | null): boolean {
	if (!name) { return false; }
	TAGGED_ID_MARKER_RE.lastIndex = 0;
	return TAGGED_ID_MARKER_RE.test(name);
}

/**
 * 归一化被伪 XML 污染的工具名。
 *
 * - 无标记 ⇒ 原样返回（合法名或普通坏名，走标准 unknown-tool 路径）；
 * - 有标记 ⇒ 按标记切分取**最后一个**合法 token（该协议下 args 属最后一个 tag）；
 * - 有标记但取不出合法 token ⇒ 保持原值（`tainted=true`，交给调用方打标/上报）。
 */
export function sanitizeToolCallName(rawName: string): IToolCallNameSanitizeResult {
	if (!rawName) { return { name: rawName, repaired: false, tainted: false, fragments: [] }; }
	TAGGED_ID_MARKER_RE.lastIndex = 0;
	const fragments: string[] = [];
	let last = 0;
	let anyMarker = false;
	for (let m = TAGGED_ID_MARKER_RE.exec(rawName); m; m = TAGGED_ID_MARKER_RE.exec(rawName)) {
		anyMarker = true;
		if (m.index > last) {
			const seg = rawName.slice(last, m.index).trim();
			if (seg) { fragments.push(seg); }
		}
		last = m.index + m[0].length;
	}
	if (!anyMarker) { return { name: rawName, repaired: false, tainted: false, fragments: [] }; }
	if (last < rawName.length) {
		const seg = rawName.slice(last).trim();
		if (seg) { fragments.push(seg); }
	}
	// 取最后一个合法 token（args 属最后一个 tag）；无合法 token ⇒ 不猜测，保持原值。
	const valid = fragments.filter(f => TOOL_NAME_RE.test(f));
	const chosen = valid.length > 0 ? valid[valid.length - 1] : undefined;
	if (!chosen) { return { name: rawName, repaired: false, tainted: true, fragments }; }
	return { name: chosen, repaired: chosen !== rawName, tainted: true, fragments };
}
