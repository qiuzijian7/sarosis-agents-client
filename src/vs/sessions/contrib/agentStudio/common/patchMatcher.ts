/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * patchMatcher — `patch` 工具的定点匹配核心（纯函数，无 IO / 无 Node 依赖）。
 *
 * 起因（2026-08-21，日志 1787311348450）：旧 `patch` 是 20 行朴素 `indexOf`，
 * 三次调用全部失败且**全部被记为成功**，模型只能退化成用 `execute_code` 跑
 * `python3` 做字节级替换（约 9% 调用纯属绕路，最终仍未改成）。三个缺陷：
 *   ① CRLF 不兼容 —— 本仓源文件普遍 CRLF（实测某 tsx CRLF=2371/LF=0），
 *      模型给的 search 用 `\n`，精确 indexOf 必然 not found；
 *   ② 失败走正常返回 → 日志记 OK、模型收到"成功"，拿不到任何纠错信号；
 *      `replace_all` 更是 `split/join` 找不到也照样写回并报 `Patched`（静默 no-op）；
 *   ③ 多处命中且未开 `replace_all` 时静默只改第一处（隐蔽的数据损坏源）。
 *
 * 设计取舍（对比 continue 与 MiMo-Code 后的结论）：
 * **采用 MiMo-Code 的「严格匹配 + 模糊仅用于诊断」路线，不采用 continue 的
 * 「模糊匹配直接改文件」路线。**
 *   · MiMo（`packages/opencode/src/tool/edit.ts`）默认关闭模糊替换，9 个 Replacer
 *     只用来生成错误提示（原注释："never to silently apply an edit"）→ 拿到诊断
 *     收益而不承担正确性风险。
 *   · continue（`core/edit/searchAndReplace/`）默认开启 4 级策略，但必须额外
 *     实现 `adjustReplacementIndentation` 才能不破坏缩进 —— 补偿逻辑本身即风险。
 * 因此这里：CRLF 归一是**确定性的**（可安全自动处理），其余差异（缩进/空白/
 * 大小写）一律**只报错不猜**，把文件里的真实原文回给模型让它照抄。
 *
 * 唯一的自动处理是行尾：`detectLineEnding` → `normalizeLineEndings` →
 * `convertToLineEnding`（抄 MiMo 的三函数法），把模型入参转成**文件的**行尾，
 * 而不是把文件归一化（后者会污染整个文件的行尾风格）。
 */

// 脱敏真源：零依赖的 `common/redactSecrets.ts`（2026-09-13 抽出，四侧共用）。
// 本模块**必须**能脱敏 —— 它渲染的是文件原文（成功回显改动区 ±3 行、失败回传
// Closest match 原文片段），而 `file_read` 对同一批字节是脱敏的。
// 此前因「`common/` 不能引用 `browser/`」而根本无从脱敏，只能原样回显。
import { redactSecrets } from './redactSecrets.js';

/** 文件的主行尾风格。 */
export type LineEnding = 'LF' | 'CRLF';

/**
 * 探测文件主行尾风格。CRLF 数量严格多于纯 LF 时判为 CRLF。
 * 混合行尾文件按多数派处理（与 MiMo 一致）。
 */
export function detectLineEnding(content: string): LineEnding {
	let crlf = 0;
	let lf = 0;
	for (let i = 0; i < content.length; i++) {
		if (content.charCodeAt(i) === 10 /* \n */) {
			if (i > 0 && content.charCodeAt(i - 1) === 13 /* \r */) { crlf++; } else { lf++; }
		}
	}
	return crlf > lf ? 'CRLF' : 'LF';
}

/** 把任意行尾（CRLF / 孤立 CR / LF）统一成 LF。 */
export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 把 LF 文本转成目标行尾。输入需已是 LF（先过 normalizeLineEndings）。 */
export function convertToLineEnding(text: string, ending: LineEnding): string {
	return ending === 'CRLF' ? text.replace(/\n/g, '\r\n') : text;
}

/**
 * 行尾**类型标签** → 实际行尾**字符**。
 *
 * `LineEnding` 是 `'LF' | 'CRLF'` 这样的标签，**不是**可直接拼接的字符 ——
 * 任何 `array.join(...)` / 手工拼接行的地方都必须经过本函数，否则会把字面量
 * `"LF"` / `"CRLF"` 写进文件内容（P2 实现时实测踩坑：`join(lineEnding)` 产出
 * `'aLFNEWLFbLFcLF'`）。
 */
export function lineEndingChars(ending: LineEnding): string {
	return ending === 'CRLF' ? '\r\n' : '\n';
}

/** 单个候选诊断结果。 */
export interface IClosestMatch {
	/** 文件中的真实原文（供模型照抄，**不是**归一化后的文本）。 */
	readonly snippet: string;
	/** 命中该候选的诊断器名，用于告诉模型"差在哪一类"。 */
	readonly strategy: string;
	/** 候选在文件中的起始下标。 */
	readonly index: number;
}

/**
 * `blockAnchor` 允许的**最小跨度上限**（行）。
 *
 * 末行锚点的搜索上界 = `max(2n-1, 本值)`（`n` = search 行数）。
 * 由来：2026-09-13 审计日志 `vscode-app-1789281483413` 发现，目标块是 13 行的 CSS 规则，
 * 而模型只引用首尾锚点 + 少量中间行（约 5 行）⇒ 旧上界 `2n-1 = 9 < 13` ⇒ **给不出任何提示**，
 * 文案退化成「No similar block was found either」，模型只能被迫重读整个文件。
 * 放宽后靠「行数差最小」挑选，仍能选中真正贴近的那一块。
 */
const ANCHOR_SPAN_FLOOR = 40;

/**
 * 在文件中寻找"看起来像 search"的片段，**仅用于生成错误提示，绝不用于替换**。
 *
 * 三个诊断器按特异性从高到低（够用即止，不追求 MiMo 的 9 个）：
 *   1. lineTrimmed        —— 逐行 trim 后比较（吸收行尾 \r、行首行尾空白差异）
 *   2. indentationFlexible—— 去掉每行公共缩进后比较（吸收整体缩进层级差异）
 *   3. blockAnchor        —— 仅用首行+末行作锚点（≥3 行时启用，吸收中间内容漂移）
 *
 * 关键实现约束：返回的 `snippet` 必须切自**原文**（`content.slice`），
 * 而不是归一化后的副本 —— 否则模型照抄回来的仍然对不上。
 */
export function findClosestMatch(content: string, search: string): IClosestMatch | undefined {
	const searchLines = normalizeLineEndings(search).split('\n');
	// 末行为空（search 以换行结尾）时去掉，避免锚点错位
	if (searchLines.length > 1 && searchLines[searchLines.length - 1] === '') {
		searchLines.pop();
	}
	if (searchLines.length === 0) { return undefined; }

	// 用原文切分，保留每行真实起止下标，便于回切原文
	const lineStarts: number[] = [0];
	for (let i = 0; i < content.length; i++) {
		if (content.charCodeAt(i) === 10) { lineStarts.push(i + 1); }
	}
	const lineCount = lineStarts.length;
	/** 取第 n 行原文（不含行尾换行符，但**保留** \r 以外的内容）。 */
	const rawLine = (n: number): string => {
		const start = lineStarts[n];
		const end = n + 1 < lineCount ? lineStarts[n + 1] - 1 : content.length;
		return content.slice(start, end);
	};
	/** 把 [from,to] 行范围切成原文片段。 */
	const sliceLines = (from: number, to: number): { snippet: string; index: number } => {
		const start = lineStarts[from];
		const end = to + 1 < lineCount ? lineStarts[to + 1] - 1 : content.length;
		return { snippet: content.slice(start, end), index: start };
	};

	const n = searchLines.length;

	// ── 1. lineTrimmed：逐行 trim 比较 ────────────────────────────────────
	const trimmedSearch = searchLines.map(l => l.trim());
	for (let i = 0; i + n <= lineCount; i++) {
		let hit = true;
		for (let k = 0; k < n; k++) {
			if (rawLine(i + k).trim() !== trimmedSearch[k]) { hit = false; break; }
		}
		if (hit) {
			const { snippet, index } = sliceLines(i, i + n - 1);
			return { snippet, strategy: 'lineTrimmed', index };
		}
	}

	// ── 2. indentationFlexible：剥离公共缩进后比较 ────────────────────────
	const stripCommonIndent = (lines: string[]): string[] => {
		const indents = lines.filter(l => l.trim().length > 0).map(l => l.length - l.trimStart().length);
		const min = indents.length > 0 ? Math.min(...indents) : 0;
		return lines.map(l => (l.trim().length === 0 ? '' : l.slice(min)));
	};
	const flexSearch = stripCommonIndent(searchLines.map(l => l.replace(/\r$/, '')));
	for (let i = 0; i + n <= lineCount; i++) {
		const window: string[] = [];
		for (let k = 0; k < n; k++) { window.push(rawLine(i + k).replace(/\r$/, '')); }
		const flexWindow = stripCommonIndent(window);
		let hit = true;
		for (let k = 0; k < n; k++) {
			if (flexWindow[k] !== flexSearch[k]) { hit = false; break; }
		}
		if (hit) {
			const { snippet, index } = sliceLines(i, i + n - 1);
			return { snippet, strategy: 'indentationFlexible', index };
		}
	}

	// ── 3. blockAnchor：首尾行锚定（仅 ≥3 行，避免短片段误报）─────────────
	if (n >= 3) {
		const firstAnchor = trimmedSearch[0];
		const lastAnchor = trimmedSearch[n - 1];
		if (firstAnchor.length > 0 && lastAnchor.length > 0) {
			for (let i = 0; i < lineCount; i++) {
				if (rawLine(i).trim() !== firstAnchor) { continue; }
				// 末行锚点允许漂移，取**行数最接近原始 search** 的那个。
				//
				// ⚠ 2026-09-13 修正两处：
				//
				// ① **注释与实现不符**：原注释写「取最接近原始行数的那个」，代码却是
				//    `return` **第一个命中**（从 lo 起最小跨度）—— 承诺的行为从未实现。
				//    跨度越小 ⇒ 提示里越可能**少给中间行** ⇒ 模型照抄虽能匹配上、
				//    但可能只改到目标区域的一部分。现改为真的按「行数差最小」挑选
				//    （相同时取靠前的，保持确定性）。
				//
				// ② **窗口过窄导致「什么都不给」**：原上界是 `i + 2n - 1`，即**文件块最多
				//    2n-1 行** ⇒ search 行数不足块长一半时直接放弃。
				//    实测证据（`vscode-app-1789281483413`）：目标块是 `docs/kb-mockups/kb-mockup.css`
				//    的 `.kb-node { … }`，共 **13 行**；模型引用首尾锚点 + 少量中间行（约 5 行）是
				//    **很自然**的行为 ⇒ `2n-1 = 9 < 13` ⇒ 给不出提示 ⇒ 文案退化为
				//    「No similar block was found either」⇒ 模型只能被迫重读整个文件。
				//    同一次会话里 search 够长的那些调用**确实拿到了提示**（`blockAnchor`），
				//    两个变体的差别就是 search 行数 —— 证据一致。
				//
				// 现在上界放宽为 `max(2n-1, ANCHOR_SPAN_FLOOR)`，靠上面的「行数差最小」
				// 挑选保证选到最贴近的块（首行锚点唯一时，候选 `j` 只在真正的收尾行附近胜出）。
				// 该片段**仅作提示**、绝不用于替换，故放宽是安全的。
				const lo = Math.max(i + 1, i + n - 1 - n);
				const hi = Math.min(lineCount - 1, i + Math.max(2 * n - 1, ANCHOR_SPAN_FLOOR));
				let bestJ = -1;
				let bestDiff = Number.POSITIVE_INFINITY;
				for (let j = lo; j <= hi; j++) {
					if (rawLine(j).trim() !== lastAnchor) { continue; }
					const diff = Math.abs((j - i + 1) - n);
					if (diff < bestDiff) { bestDiff = diff; bestJ = j; }
				}
				if (bestJ >= 0) {
					const { snippet, index } = sliceLines(i, bestJ);
					return { snippet, strategy: 'blockAnchor', index };
				}
			}
		}
	}

	return undefined;
}

/** `search` 在 `content` 中的全部出现下标（精确匹配，不重叠）。 */
export function findAllOccurrences(content: string, search: string): number[] {
	const out: number[] = [];
	if (search.length === 0) { return out; }
	let from = 0;
	for (;;) {
		const idx = content.indexOf(search, from);
		if (idx === -1) { break; }
		out.push(idx);
		from = idx + search.length;
	}
	return out;
}

/** patch 失败原因（结构化，便于测试与 UI 区分）。 */
export type PatchFailureReason =
	| 'not_found'
	| 'multiple_occurrences'
	| 'identical_search_replace'
	/** P2（2026-09-12）：insert_line 非整数或越界（合法范围 1..totalLines+1）。 */
	| 'invalid_insert_line'
	/** P2（2026-09-12）：insert_line 模式下待插入文本为空。 */
	| 'empty_insert'
	/** 2026-09-21 批量模式（`computeBatchPatch`）：edits 为空数组。 */
	| 'empty_edits'
	/** 2026-09-21 批量模式：某条 edit 的 search 为空。 */
	| 'empty_search'
	/** 2026-09-21 批量模式：两条 edit 的匹配区间相交（含义歧义，须合并成一条）。 */
	| 'overlapping_edits';

export interface IPatchFailure {
	readonly ok: false;
	readonly reason: PatchFailureReason;
	readonly message: string;
}

export interface IPatchSuccess {
	readonly ok: true;
	/** 替换后的完整文件内容（行尾已与原文一致）。 */
	readonly content: string;
	/** 实际替换处数。 */
	readonly replacedCount: number;
	/** 文件原本的行尾风格，供日志/回报使用。 */
	readonly lineEnding: LineEnding;
	/** 入参行尾与文件不一致、已自动转换。 */
	readonly lineEndingAdjusted: boolean;
	/**
	 * 改动后内容中，本次写入文本所占的 1-based 起始行。
	 * `replaceAll` 多处替换时为首处的起始行（多处无法用单一范围表达）。
	 */
	readonly editedLineStart: number;
	/** 改动后内容中，本次写入文本所占的 1-based 结束行（与 `editedLineStart` 配对）。 */
	readonly editedLineEnd: number;
}

export type PatchOutcome = IPatchSuccess | IPatchFailure;

/** 错误提示中回传原文片段的长度上限（对齐 MiMo 的 2000）。 */
export const CLOSEST_MATCH_HINT_LIMIT = 2000;

/** 成功回报中「改动区域上下文」在改动行前后各取的行数。 */
export const PATCH_CONTEXT_LINES = 3;

/**
 * 渲染改动区域上下文 —— 带行号，格式与 `file_read` 输出**完全一致**
 * （紧凑 `LINE_NUM|CONTENT`，无 padding，见 coreTools.ts 的 file_read 渲染），
 * 且**脱敏策略也一致**（2026-09-13 修正：此前只对齐了格式、没对齐脱敏 →
 * `patch` 成了绕过 `file_read` 的「读文件」通道）。
 *
 * 起因（2026-09-12）：此前 patch 成功只回一句 `Patched X — replaced N occurrences`，
 * 模型手里仍是被改动**之前**的文本，要继续修改邻近区域就只能重新 file_read 整个
 * 文件 —— 同一文件连续 patch 时反复付出「读 + 上下文」的代价。
 * 回传改动区域后，绝大多数「连续 patch 同一文件」的场景可直接续写；
 * 格式与 file_read 对齐，是为了让模型能把片段**原样复制**进下一次的 "search"。
 *
 * @param content   替换后的完整文件内容（来自 `IPatchSuccess.content`）。
 * @param lineStart 改动区域起始行（1-based，闭区间）。
 * @param lineEnd   改动区域结束行（1-based，闭区间）。
 * @param contextLines 前后各扩展的行数，默认 `PATCH_CONTEXT_LINES`。
 */
export function buildEditedRegionContext(
	content: string,
	lineStart: number,
	lineEnd: number,
	contextLines: number = PATCH_CONTEXT_LINES,
): string {
	const lines = content.split(/\r\n|\n/);
	const from = Math.max(1, lineStart - contextLines);
	const to = Math.min(lines.length, lineEnd + contextLines);
	const out: string[] = [];
	for (let n = from; n <= to; n++) {
		out.push(`${n}|${lines[n - 1]}`);
	}
	// ★ 脱敏（2026-09-13）：本函数渲染的是**文件原文**，而 `file_read` 对同一批字节
	// 是脱敏的 —— 不脱敏会让 `patch` 成为一条**绕过 file_read 的「读文件」通道**
	// （patch 一次即可拿到改动区 ± PATCH_CONTEXT_LINES 行的明文）。
	return redactSecrets(out.join('\n'));
}

/**
 * 计算 patch 结果 —— **纯函数，不写文件**。
 *
 * 行为契约（三条都由单测锁定）：
 *   · 未命中           → `not_found`，附「文件中最接近的原文」供模型照抄；
 *   · 多处命中且非 all → `multiple_occurrences`，要求加上下文或开 replace_all；
 *   · search===replace → `identical_search_replace`（否则是一次无意义的写盘）。
 * 任何失败都**不返回成功文本**，调用方必须据此抛错，让 executeTool 记 FAILED。
 */
export function computePatch(
	fileContent: string,
	rawSearch: string,
	rawReplace: string,
	replaceAll: boolean,
	filePathForMessage: string,
): PatchOutcome {
	const lineEnding = detectLineEnding(fileContent);
	const normSearch = normalizeLineEndings(rawSearch);
	const normReplace = normalizeLineEndings(rawReplace);

	if (normSearch === normReplace) {
		// search 与 replace 归一后相同 → 编辑是 no-op。进一步判断：归一后的 search
		// 是否已以「文件行尾风格」存在于文件中。若是，说明这个修改其实**已经应用过**
		// （模型重发了已生效的 patch）→ 给更精准的信号让模型停止重发，而非笼统说无意义。
		const searchInFileStyle = convertToLineEnding(normSearch, lineEnding);
		if (fileContent.includes(searchInFileStyle)) {
			return {
				ok: false,
				reason: 'identical_search_replace',
				message:
					`patch aborted: "search" and "replace" are identical, and this exact block already ` +
					`exists in ${filePathForMessage}. The edit appears to have already been applied — ` +
					`stop re-patching this region. If you intended a different change, provide distinct ` +
					`text in "replace".`,
			};
		}
		return {
			ok: false,
			reason: 'identical_search_replace',
			message:
				`patch aborted: "search" and "replace" are identical after line-ending normalization — ` +
				`the edit would be a no-op. Provide the intended new text in "replace".`,
		};
	}

	const search = convertToLineEnding(normSearch, lineEnding);
	const replace = convertToLineEnding(normReplace, lineEnding);
	// 入参本身的行尾与文件不同 → 记录一下，成功时回报给模型（教它下次直接给对）
	const lineEndingAdjusted = search !== rawSearch;

	const hits = findAllOccurrences(fileContent, search);

	if (hits.length === 0) {
		const closest = findClosestMatch(fileContent, search);
		// 行尾差异由 matcher 自动归一处理（见上方 convertToLineEnding），不会是 not_found
		// 的根因；故不再把「行尾」列为必须匹配项去误导模型。仅当文件是 CRLF 时附一句
		// 中性说明（明确行尾差异已自动处理、差异在文本本身），避免模型再纠结行尾。
		let message =
			`patch failed: search text not found in ${filePathForMessage}. ` +
			`It must match the file exactly, including whitespace and indentation.`;
		if (lineEnding === 'CRLF') {
			message +=
				` (This file uses CRLF line endings; line-ending differences are normalized ` +
				`automatically, so the mismatch is in the text itself.)`;
		}
		if (closest) {
			// ★ 脱敏（2026-09-13）：`snippet` 切自**文件原文**（`findClosestMatch` 的契约），
			// 而这条失败路径**不需要模型先知道任何文本** —— 发一个近似但不匹配的 search
			// 就能拿回最多 2000 字符明文，比成功路径的 ±3 行更宽。必须与 file_read 同等脱敏。
			//
			// 顺序：**先脱敏再截断** —— 反过来的话，截断点可能落在 token 中间，把密钥切成
			// 两半后正则再也匹配不上（与 `execOutputPipeline` 里 redact 必须在 longline
			// 之前是同一条教训）。
			const redacted = redactSecrets(closest.snippet);
			const snippet = redacted.length > CLOSEST_MATCH_HINT_LIMIT
				? `${redacted.slice(0, CLOSEST_MATCH_HINT_LIMIT)}\n… (truncated)`
				: redacted;
			message +=
				`\n\nClosest match in the file (differs only by ${closest.strategy}). ` +
				`Copy this verbatim into "search" and retry:\n` +
				'```\n' + snippet + '\n```';
		} else {
			message +=
				`\n\nNo similar block was found either — re-read the file with file_read ` +
				`and copy the exact text you want to replace.`;
		}
		return { ok: false, reason: 'not_found', message };
	}

	if (hits.length > 1 && !replaceAll) {
		return {
			ok: false,
			reason: 'multiple_occurrences',
			message:
				`patch failed: search text occurs ${hits.length} times in ${filePathForMessage}. ` +
				`Refusing to guess which one to edit. Either extend "search" with surrounding ` +
				`context so it matches exactly once, or pass replace_all=true to change all ${hits.length}.`,
		};
	}

	// 逆序替换以保持下标有效（对齐 continue 的 performReplace 做法）
	const targets = replaceAll ? hits : [hits[0]];
	let content = fileContent;
	for (let i = targets.length - 1; i >= 0; i--) {
		const at = targets[i];
		content = content.slice(0, at) + replace + content.slice(at + search.length);
	}

	// ── 改动区域行号（2026-09-12，P0）─────────────────────────────────────
	// 逆序替换**不触碰** targets[0] 之前的文本，故「改动起始行」在替换前后一致：
	// 数一遍 targets[0] 之前的换行符即可。比在替换后的内容里重新定位 replace 更稳
	// —— replace 文本可能恰好也出现在文件的其他位置（后者会定位到错误的一处）。
	// 结束行 = 起始行 + replace 占用的行数 - 1；`replace` 已转换为文件行尾，
	// 故按 '\n' 计数对 CRLF / LF 都正确。
	let newlinesBefore = 0;
	for (let i = 0; i < targets[0]; i++) {
		if (fileContent.charCodeAt(i) === 10 /* \n */) { newlinesBefore++; }
	}
	const editedLineStart = newlinesBefore + 1;
	const editedLineEnd = editedLineStart + replace.split('\n').length - 1;

	return {
		ok: true, content, replacedCount: targets.length, lineEnding, lineEndingAdjusted,
		editedLineStart, editedLineEnd,
	};
}

/** 批量编辑中的一条（TEXT 模式语义，与单条 `search`/`replace` 完全一致）。 */
export interface IBatchEdit {
	readonly search: string;
	readonly replace: string;
}

/**
 * 批量原子编辑 —— **一次调用改多处**（2026-09-21，pi `edit` 的 `edits[]` 对齐）。
 *
 * ## 为什么值得做（pi 的对照事实）
 *
 * pi 的 `edit` 一次调用即可改多处：全部 edit 对**原始内容**匹配、按 matchIndex 逆序应用、
 * 区间重叠直接拒绝、且**任一处失败整批不落盘**（`edits` 是原子的）。本仓此前只有单处
 * （`computePatch`）⇒「改 3 个不相干位置」= **3 次工具调用 = 3 轮 LLM 往返**（每轮重传
 * 全部上下文），而内容本身完全可以在一次调用里说清。
 *
 * ## 语义契约（与单条模式严格一致，只是批量化）
 *
 *  - **全部对原文匹配**：任一 edit 的 `search` 都按**文件原始内容**定位 —— 因此多条 edit
 *    之间互不影响、顺序无关（这也是为什么逆序应用是安全的）。相邻（首尾相接）不算重叠。
 *  - **唯一性**：每条 edit 的 `search` 在原文中必须只出现一次（批量模式不提供 replace_all，
 *    否则「多处命中」与「多条 edit 指向同一处」将无法区分）。
 *  - **原子**：任何一条失败（空 search / 未命中 / 多处命中 / 无变化 / 与其它 edit 重叠）
 *    ⇒ 整批返回失败，**不落盘**。绝不「改一半再报错」。
 *  - **不猜**：与单条模式同款 —— 只在**行尾**做确定性归一（CRLF/LF），其余差异一律报错
 *    并把文件里最接近的原文回给模型照抄（`findClosestMatch`）。
 *
 * 失败消息都带 `edits[i]`（1-based）定位，模型能立刻知道是哪一条坏了。
 *
 * @param fileContent        文件原始内容。
 * @param edits              待应用编辑（顺序无关；内部会按原文位置排序）。
 * @param filePathForMessage 错误消息中的文件路径。
 */
export function computeBatchPatch(
	fileContent: string,
	edits: readonly IBatchEdit[],
	filePathForMessage: string,
): PatchOutcome {
	if (edits.length === 0) {
		return {
			ok: false,
			reason: 'empty_edits',
			message:
				`patch failed: "edits" is empty. Pass at least one { search, replace } entry, ` +
				`or use TEXT MODE with top-level "search"/"replace" for a single edit.`,
		};
	}

	const lineEnding = detectLineEnding(fileContent);
	let lineEndingAdjusted = false;
	/** 已定位的替换点（按原文下标升序）。 */
	const resolved: Array<{ start: number; end: number; replace: string; editIndex: number }> = [];

	for (let i = 0; i < edits.length; i++) {
		const label = `edits[${i}]`;
		const rawSearch = edits[i].search ?? '';
		const rawReplace = edits[i].replace ?? '';
		if (rawSearch.length === 0) {
			return {
				ok: false,
				reason: 'empty_search',
				message:
					`patch failed: ${label}.search is empty. Each edit needs the exact existing text to ` +
					`replace — copy it verbatim from file_read output (or use insert_line for pure insertions).`,
			};
		}
		const normSearch = normalizeLineEndings(rawSearch);
		const normReplace = normalizeLineEndings(rawReplace);
		if (normSearch === normReplace) {
			return {
				ok: false,
				reason: 'identical_search_replace',
				message:
					`patch aborted: ${label} has identical "search" and "replace" after line-ending ` +
					`normalization — that edit would be a no-op. Fix ${label} (or drop it) and retry; ` +
					`the whole batch was rejected, nothing was written.`,
			};
		}
		const search = convertToLineEnding(normSearch, lineEnding);
		const replace = convertToLineEnding(normReplace, lineEnding);
		if (search !== rawSearch) { lineEndingAdjusted = true; }

		const hits = findAllOccurrences(fileContent, search);
		if (hits.length === 0) {
			// 与单条模式同款诊断（脱敏 + 截断），并点名是哪一条 edit
			const closest = findClosestMatch(fileContent, search);
			let message =
				`patch failed: ${label}.search text not found in ${filePathForMessage}. ` +
				`It must match the file exactly, including whitespace and indentation. ` +
				`Nothing was written (the batch is atomic).`;
			if (lineEnding === 'CRLF') {
				message +=
					` (This file uses CRLF line endings; line-ending differences are normalized ` +
					`automatically, so the mismatch is in the text itself.)`;
			}
			if (closest) {
				// 脱敏 → 截断（顺序不可颠倒：截断会把密钥切成两半导致正则失配）
				const redacted = redactSecrets(closest.snippet);
				const snippet = redacted.length > CLOSEST_MATCH_HINT_LIMIT
					? `${redacted.slice(0, CLOSEST_MATCH_HINT_LIMIT)}\n… (truncated)`
					: redacted;
				message +=
					`\n\nClosest match in the file (differs only by ${closest.strategy}). ` +
					`Copy this verbatim into ${label}.search and retry:\n` +
					'```\n' + snippet + '\n```';
			} else {
				message +=
					`\n\nNo similar block was found either — re-read the file with file_read ` +
					`and copy the exact text for ${label}.search.`;
			}
			return { ok: false, reason: 'not_found', message };
		}
		if (hits.length > 1) {
			return {
				ok: false,
				reason: 'multiple_occurrences',
				message:
					`patch failed: ${label}.search occurs ${hits.length} times in ${filePathForMessage}. ` +
					`Batch mode requires each "search" to match exactly once (there is no replace_all here) — ` +
					`extend ${label}.search with surrounding context until it is unique. ` +
					`Nothing was written (the batch is atomic).`,
			};
		}
		resolved.push({ start: hits[0], end: hits[0] + search.length, replace, editIndex: i });
	}

	// ── 重叠检测（按原文区间，升序）──────────────────────────────────────────
	// 相邻（前一条 end === 后一条 start）合法；真正相交才拒绝 —— 相交时「谁先应用」
	// 会改变结果，且模型的两段 text 必然来自相互重叠的文件区域 ⇒ 应合并成一条 edit。
	const ordered = [...resolved].sort((a, b) => a.start - b.start);
	for (let i = 1; i < ordered.length; i++) {
		if (ordered[i].start < ordered[i - 1].end) {
			return {
				ok: false,
				reason: 'overlapping_edits',
				message:
					`patch failed: edits[${ordered[i - 1].editIndex}] and edits[${ordered[i].editIndex}] ` +
					`overlap in ${filePathForMessage}. Overlapping edits are ambiguous — merge them into a ` +
					`single edit whose "search" spans the whole region. Nothing was written (the batch is atomic).`,
			};
		}
	}

	// ── 逆序应用（下标在原文坐标系里计算 ⇒ 逆序后始终有效）──────────────────
	let content = fileContent;
	for (let i = ordered.length - 1; i >= 0; i--) {
		const e = ordered[i];
		content = content.slice(0, e.start) + e.replace + content.slice(e.end);
	}

	// ── 改动区域（并集）行号 ────────────────────────────────────────────────
	// 起始行：逆序替换不触碰首处之前的文本 ⇒ 数原文中首处之前的换行即可（与单条同款推理）。
	const firstStart = ordered[0].start;
	let newlinesBefore = 0;
	for (let i = 0; i < firstStart; i++) {
		if (fileContent.charCodeAt(i) === 10 /* \n */) { newlinesBefore++; }
	}
	const editedLineStart = newlinesBefore + 1;
	// 结束行：末处（原文坐标最大的那条）在新内容中的结束偏移 = 原偏移 + 之前所有 edit 的长度增量。
	const last = ordered[ordered.length - 1];
	let deltaBeforeLast = 0;
	for (const e of ordered) {
		if (e === last) { break; }
		deltaBeforeLast += e.replace.length - (e.end - e.start);
	}
	const lastEndInNew = last.start + deltaBeforeLast + last.replace.length;
	let newlinesToEnd = 0;
	for (let i = 0; i < lastEndInNew && i < content.length; i++) {
		if (content.charCodeAt(i) === 10 /* \n */) { newlinesToEnd++; }
	}
	const editedLineEnd = newlinesToEnd + 1;

	return {
		ok: true,
		content,
		replacedCount: ordered.length,
		lineEnding,
		lineEndingAdjusted,
		editedLineStart,
		editedLineEnd,
	};
}

/**
 * 行号插入模式（P2，2026-09-12）—— 对齐 Cline `editor` 的 `insert_line`。
 *
 * 动机：文本匹配在「无文本可锚定」的场景天然无力 —— 新增一个 import、在文件末尾
 * 追加一段、在某处插入新函数时，模型只能把**邻近的既有文本**抄进 `search` 来定位，
 * 既冗长又易错（缩进/空白稍有出入即 not_found）。而 `file_read` 的输出本就带行号
 * （`LINE_NUM|CONTENT`），模型手里已有精确坐标 —— 本函数把这份坐标变成一等的编辑方式。
 *
 * 与文本模式**互补而非替代**：
 *   · **改写既有内容** → 仍用 `computePatch`（要改的内容本身就是最好的锚点，
 *     且能防止行号漂移导致改错位置）；
 *   · **新增内容** → 用本函数（没有既有文本可供锚定）。
 *
 * 行号语义与 `file_read` 严格对齐：行数 = `content.split(/\r\n|\n/).length`
 * （与 coreTools.readFileLines 的 `rawLines` 一致，**末尾空行也算一行**）。
 *
 * 边界特判：文件以换行结尾时，`insert_line = totalLines + 1`（追加到 EOF）会先把
 * 末尾空串摘掉再追加，使 `'a\nb\n' + 'X'` 得到直觉结果 `'a\nb\nX'` 而非
 * `'a\nb\n\nX'`（Cline 的 splice 实现会多留一个空行）。
 *
 * @param fileContent        原始文件内容。
 * @param insertLine         1-based 插入点：新文本插在「第 insertLine 行」**之前**。
 *                           合法范围 `1..totalLines+1`，取 `totalLines+1` 即追加到 EOF。
 * @param rawInsertText      待插入文本（可含换行；行尾自动转成文件风格）。
 * @param filePathForMessage 错误消息中的文件路径。
 */
export function computeInsert(
	fileContent: string,
	insertLine: number,
	rawInsertText: string,
	filePathForMessage: string,
): PatchOutcome {
	const lineEnding = detectLineEnding(fileContent);
	// 必须**先归一化到 LF 再切行**：若直接对已转成 CRLF 的文本 split('\n')，元素会
	// 残留 \r，随后 join('\r\n') 会产出 `\r\r\n`（CRLF 文件下实测踩坑）。
	// `insertLines` 供 splice 使用（元素不含 \r）；`insertText` 供整块追加与
	// lineEndingAdjusted 判定使用（已是文件行尾）。
	const normInsert = normalizeLineEndings(rawInsertText);
	const insertLines = normInsert.split('\n');
	const insertText = convertToLineEnding(normInsert, lineEnding);

	if (insertText.length === 0) {
		return {
			ok: false,
			reason: 'empty_insert',
			message:
				`patch failed: the text to insert (pass it in "replace") is empty in ${filePathForMessage}. ` +
				`Provide the text you want inserted at line ${insertLine}.`,
		};
	}

	const lines = fileContent.split(/\r\n|\n/);
	const totalLines = lines.length; // 与 file_read 一致：末尾空行也算一行
	const maxBoundary = totalLines + 1; // 追加到 EOF 的边界
	const endsWithNewline = lines.length > 1 && lines[lines.length - 1] === '';

	if (!Number.isInteger(insertLine) || insertLine < 1 || insertLine > maxBoundary) {
		return {
			ok: false,
			reason: 'invalid_insert_line',
			message:
				`patch failed: insert_line must be an integer in 1..${maxBoundary} — ${filePathForMessage} has ` +
				`${totalLines} lines, so use 1 to insert at the very top or ${maxBoundary} to append at EOF. ` +
				`Got: ${insertLine}. (Line numbers come from file_read output, format LINE_NUM|CONTENT.)`,
		};
	}

	// 空文件特例：'' 的 split 结果是 ['']（一个空串元素），走 splice+join 会产出 'X\n'，
	// 而空文件插入应得到 'X'（与编辑器行为一致）。
	if (fileContent.length === 0) {
		return {
			ok: true, content: insertText, replacedCount: 1, lineEnding,
			lineEndingAdjusted: insertText !== rawInsertText,
			editedLineStart: 1, editedLineEnd: insertLines.length,
		};
	}

	// ★ 拼接必须用**实际行尾字符**（lineEndingChars），不能用 LineEnding 标签 ——
	// 后者会把字面量 "LF"/"CRLF" 写进文件（P2 首版实测踩坑）。
	const eol = lineEndingChars(lineEnding);
	// 追加到「末尾空行之后」时摘掉那个空串，避免多引入一个空行（见函数注释）
	const appendAtEof = insertLine === maxBoundary && endsWithNewline;
	let content: string;
	if (appendAtEof) {
		content = [...lines.slice(0, -1), insertText].join(eol);
	} else {
		lines.splice(insertLine - 1, 0, ...insertLines);
		content = lines.join(eol);
	}

	// 插入文本在新内容中的起始行 = 插入点之前的行数（1-based）；追加特判时少一行
	const editedLineStart = appendAtEof ? insertLine - 1 : insertLine;

	return {
		ok: true,
		content,
		// 插入不是「替换」，但记为 1 处改动，让调用方的文案与统计口径统一
		replacedCount: 1,
		lineEnding,
		lineEndingAdjusted: insertText !== rawInsertText,
		editedLineStart,
		editedLineEnd: editedLineStart + insertLines.length - 1,
	};
}
