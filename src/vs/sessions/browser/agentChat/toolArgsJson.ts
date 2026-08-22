/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 渲染层工具参数（`IToolCall.args`）宽松解析 —— 修复「空白工具卡片」缺陷。
 *
 * ## 背景（日志 1787311601345 + 用户截图）
 * 执行侧拿到的参数是 provider 已解析好的对象（Anthropic `input`）或经过
 * `toolCallUtils.repairToolArguments` 修复链的字符串，所以工具**执行成功**；
 * 而渲染侧的 `tc.args` 是 `tool_args` delta **逐块累加的原始字符串**
 * （`nativeChatEditorPane.ts` 的 `case 'tool_args'`），从未复用任何修复链：
 * 各卡片一律裸 `JSON.parse(tc.args)` + 静默 `catch`。
 *
 * 于是只要参数里有一个 JSON 非法转义（实测 `\x09`，模型把制表符写成 `\x09`
 * 而非 `\t`），整个 `JSON.parse` 抛错 → `filePath` 退化成 `''` →
 * `fileCards._createWriteFileToolCard` 的 `if (filePath)` 整段不执行 →
 * **卡片标题区什么都不渲染**（用户看到的空白卡片）。
 *
 * ## 为什么不直接 import `contrib/agentStudio/browser/toolCallUtils.ts`
 * 层约束：`browser/agentChat/` 不得反向依赖 `contrib/agentStudio/**`。
 * 因此这里实现渲染层专用的等价修复链（零依赖），并额外覆盖执行侧修复链
 * 没有的两类问题：**非法转义** 与 **字段级正则兜底**。
 *
 * ## 修复链（逐级降级，越往后越激进）
 *  1. `JSON.parse` 原样
 *  2. 转义修复（非法转义 `\x` → `\\x`；字符串内裸控制字符 → `\uXXXX`）
 *  3. 自动闭合（流式截断：补引号 / 去尾部悬空 key / 补 `]` `}`）
 *  4. 字段级正则扫描（只捞顶层字符串字段，专为「至少把文件名显示出来」）
 *  5. `{}`
 */

/** JSON 字符串中合法的转义字符（RFC 8259 §7）。 */
const VALID_ESCAPE_CHARS = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

/** 控制字符 → 可读转义（其余走 `\uXXXX`）。 */
const CONTROL_ESCAPES: Record<number, string> = {
	0x08: '\\b',
	0x09: '\\t',
	0x0a: '\\n',
	0x0c: '\\f',
	0x0d: '\\r',
};

function isHex(ch: string | undefined): boolean {
	if (!ch) { return false; }
	return /[0-9a-fA-F]/.test(ch);
}

/**
 * 修复 JSON 字符串里的非法转义与裸控制字符（单遍扫描，只在字符串字面量内部生效）。
 *
 * - `\x09` / `\d` / `\p` 之类非法转义 → 反斜杠自身被转义（`\\x09`），语义保留为字面文本
 * - `\uZZ` （u 后不足 4 位 hex）→ 同上按字面处理
 * - 字符串内的裸 TAB / LF / CR / 其它 < 0x20 控制字符 → 规范转义
 *
 * 字符串外的内容原样保留（缩进/换行是合法 JSON 空白）。
 */
export function sanitizeJsonEscapes(raw: string): string {
	let out = '';
	let inString = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (!inString) {
			out += ch;
			if (ch === '"') { inString = true; }
			continue;
		}
		if (ch === '"') {
			out += ch;
			inString = false;
			continue;
		}
		if (ch === '\\') {
			const next = raw[i + 1];
			if (next === undefined) {
				// 末尾悬空反斜杠 → 转义自身（避免吞掉后续补入的引号）
				out += '\\\\';
				continue;
			}
			if (!VALID_ESCAPE_CHARS.has(next)) {
				// 非法转义（如 \x09）：把反斜杠字面化，next 留给下一轮正常处理
				out += '\\\\';
				continue;
			}
			if (next === 'u') {
				const hex = raw.slice(i + 2, i + 6);
				if (hex.length < 4 || ![...hex].every(isHex)) {
					out += '\\\\';
					continue;
				}
			}
			out += ch + next;
			i++;
			continue;
		}
		const code = ch.charCodeAt(0);
		if (code < 0x20) {
			out += CONTROL_ESCAPES[code] ?? `\\u${code.toString(16).padStart(4, '0')}`;
			continue;
		}
		out += ch;
	}
	return out;
}

/**
 * 为流式截断的 JSON 自动补齐结构（未闭合引号 / 悬空 key / 未闭合括号）。
 * 输入应先经 {@link sanitizeJsonEscapes}，否则转义计数可能错位。
 */
export function autoCloseJson(raw: string): string {
	let candidate = raw.trim();
	if (!candidate) { return candidate; }

	// 1. 统计括号 / 判断是否停在字符串内（一次扫描同时完成）
	let inString = false;
	let openBraces = 0;
	let openBrackets = 0;
	for (let i = 0; i < candidate.length; i++) {
		const ch = candidate[i];
		if (inString) {
			if (ch === '\\') { i++; continue; }
			if (ch === '"') { inString = false; }
			continue;
		}
		if (ch === '"') { inString = true; continue; }
		if (ch === '{') { openBraces++; }
		else if (ch === '}') { openBraces--; }
		else if (ch === '[') { openBrackets++; }
		else if (ch === ']') { openBrackets--; }
	}

	// 2. 停在字符串内 → 先闭合引号
	if (inString) { candidate += '"'; }

	// 3. 去掉尾部悬空结构：`,` / `"key":` / `"key":,`
	//    循环处理，覆盖 `{"a":1,"b":` 这类被截断在冒号后的形态。
	for (let guard = 0; guard < 4; guard++) {
		const before = candidate;
		candidate = candidate.replace(/,\s*$/, '');
		candidate = candidate.replace(/,?\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, '');
		candidate = candidate.replace(/:\s*$/, '');
		if (candidate === before) { break; }
	}

	// 4. 补齐括号（先内层数组，再外层对象）
	while (openBrackets > 0) { candidate += ']'; openBrackets--; }
	while (openBraces > 0) { candidate += '}'; openBraces--; }
	return candidate;
}

/** JSON 字符串字面量反转义（宽松：非法转义降级为去掉反斜杠的字面量）。 */
function unescapeJsonStringLiteral(body: string): string {
	return body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m, esc: string) => {
		switch (esc) {
			case '"': return '"';
			case '\\': return '\\';
			case '/': return '/';
			case 'b': return '\b';
			case 'f': return '\f';
			case 'n': return '\n';
			case 'r': return '\r';
			case 't': return '\t';
			default:
				if (esc[0] === 'u') {
					return String.fromCharCode(parseInt(esc.slice(1), 16));
				}
				return esc; // 非法转义：保留字面字符
		}
	});
}

/** `"key": "value"` 形态的字段扫描正则（全局，用于最后一级兜底）。 */
const STRING_FIELD_RE = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * 最后一级兜底：不做 JSON 解析，直接正则扫描所有 `"key": "string"` 字段。
 *
 * 会连带抓到嵌套对象里的同名字段（无法区分层级），但本函数只服务「显示」
 * 场景（文件名 / 命令 / query），宁可显示近似值也不要空白卡片。
 */
export function scanStringFields(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	STRING_FIELD_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = STRING_FIELD_RE.exec(raw)) !== null) {
		if (!(m[1] in out)) {
			out[m[1]] = unescapeJsonStringLiteral(m[2]);
		}
	}
	return out;
}

/** 参数解析所经过的修复级别（供诊断日志使用）。 */
export type ToolArgsRepairLevel = 'none' | 'object' | 'escapes' | 'autoclose' | 'scan' | 'failed';

export interface IToolArgsParseResult {
	readonly args: Record<string, unknown>;
	readonly repair: ToolArgsRepairLevel;
	/** `repair === 'scan'` 时为 true —— 结果是不完整的近似值，仅可用于显示。 */
	readonly partial: boolean;
}

/**
 * 宽松解析工具调用参数，带修复级别诊断。
 * 兼容 string(JSON) / object / undefined 三种 `tc.args` 形态。
 */
export function parseToolArgsWithDiagnostics(raw: unknown): IToolArgsParseResult {
	if (raw === undefined || raw === null || raw === '') {
		return { args: {}, repair: 'none', partial: false };
	}
	if (typeof raw === 'object') {
		if (Array.isArray(raw)) { return { args: {}, repair: 'failed', partial: false }; }
		return { args: raw as Record<string, unknown>, repair: 'object', partial: false };
	}
	if (typeof raw !== 'string') {
		return { args: {}, repair: 'failed', partial: false };
	}

	const trimmed = raw.trim();
	if (!trimmed) { return { args: {}, repair: 'none', partial: false }; }

	const tryParse = (text: string): Record<string, unknown> | undefined => {
		try {
			const parsed = JSON.parse(text);
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch { /* fall through */ }
		return undefined;
	};

	// 1. 原样
	const direct = tryParse(trimmed);
	if (direct) { return { args: direct, repair: 'none', partial: false }; }

	// 2. 转义修复
	const sanitized = sanitizeJsonEscapes(trimmed);
	const afterEscapes = tryParse(sanitized);
	if (afterEscapes) { return { args: afterEscapes, repair: 'escapes', partial: false }; }

	// 3. 自动闭合（流式截断）
	const closed = autoCloseJson(sanitized);
	if (closed !== sanitized) {
		const afterClose = tryParse(closed);
		if (afterClose) { return { args: afterClose, repair: 'autoclose', partial: false }; }
	}

	// 4. 字段级扫描兜底
	const scanned = scanStringFields(sanitized);
	if (Object.keys(scanned).length > 0) {
		return { args: scanned, repair: 'scan', partial: true };
	}

	return { args: {}, repair: 'failed', partial: false };
}

/** 已告警过的 tool call，避免同一张卡片每次重渲染都刷日志。 */
const _warnedKeys = new Set<string>();
const MAX_WARNED_KEYS = 200;

/**
 * 解析失败 / 需要修复时打一条 warn（同一 key 只打一次）。
 *
 * 原实现是 `catch { /* ignore *\/ }` 静默吞掉 —— 空白卡片这类缺陷因此完全
 * 不可观测（必须靠用户截图才发现）。这里保留降级渲染，同时留下诊断痕迹。
 */
export function warnToolArgsRepair(result: IToolArgsParseResult, key: string, raw: unknown): void {
	if (result.repair === 'none' || result.repair === 'object') { return; }
	if (_warnedKeys.has(key)) { return; }
	if (_warnedKeys.size >= MAX_WARNED_KEYS) { _warnedKeys.clear(); }
	_warnedKeys.add(key);
	const preview = typeof raw === 'string' ? raw.slice(0, 200) : String(raw);
	console.warn(`[AgentChat] tool args JSON repaired (level=${result.repair}, partial=${result.partial}) for "${key}": ${preview}`);
}

/**
 * 宽松解析 `tc.args`（薄封装，丢弃诊断信息）。
 *
 * 这是渲染层解析工具参数的**唯一入口** —— 各卡片文件里原先散落的
 * `try { JSON.parse(tc.args) } catch { {} }` 一律收敛到此，避免修复能力漂移。
 */
export function parseToolArgsLoose(raw: unknown): Record<string, unknown> {
	return parseToolArgsWithDiagnostics(raw).args;
}
