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
				// 末行锚点允许在 ±(n) 行范围内漂移，取最接近原始行数的那个
				const lo = Math.max(i + 1, i + n - 1 - n);
				const hi = Math.min(lineCount - 1, i + n - 1 + n);
				for (let j = lo; j <= hi; j++) {
					if (rawLine(j).trim() === lastAnchor) {
						const { snippet, index } = sliceLines(i, j);
						return { snippet, strategy: 'blockAnchor', index };
					}
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
	| 'identical_search_replace';

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
}

export type PatchOutcome = IPatchSuccess | IPatchFailure;

/** 错误提示中回传原文片段的长度上限（对齐 MiMo 的 2000）。 */
export const CLOSEST_MATCH_HINT_LIMIT = 2000;

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
			const snippet = closest.snippet.length > CLOSEST_MATCH_HINT_LIMIT
				? `${closest.snippet.slice(0, CLOSEST_MATCH_HINT_LIMIT)}\n… (truncated)`
				: closest.snippet;
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

	return { ok: true, content, replacedCount: targets.length, lineEnding, lineEndingAdjusted };
}
