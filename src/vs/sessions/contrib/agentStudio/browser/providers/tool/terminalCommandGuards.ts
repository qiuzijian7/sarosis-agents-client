/*---------------------------------------------------------------------------------------------
 *  Terminal 搜索类命令护栏（数据驱动模式表，2026-07-28）。
 *
 *  背景（日志 1785224874547）：主 agent 用 terminal 执行 Unix `find ... | grep | head`
 *  在 Windows PowerShell 下直接失败，又用 Get-ChildItem -Recurse 重复搜索三次——
 *  这些都是 search_files/search_code 的本职工作，且专用工具走索引快路径、
 *  结果结构化、无 shell 引号/可移植性问题。
 *
 *  策略：命中模式时不阻断命令（模型可能有正当理由），仅在输出末尾追加
 *  tool-hint 引导下次改用专用搜索工具。模式表集中维护，新增命令形态只需加行。
 *--------------------------------------------------------------------------------------------*/

/** 单条搜索命令形态：正则 + 给 LLM 的替代建议 */
export interface ITerminalSearchPattern {
	/** 形态标识（日志用） */
	readonly id: string;
	/** 命中正则（对整条命令字符串测试，含管道组合） */
	readonly pattern: RegExp;
	/** 人类可读的命令形态描述（hint 文案用） */
	readonly label: string;
	/** 建议改用的工具与理由 */
	readonly advice: string;
}

// ─── 建议文案（按搜索语义归类复用）───────────────────────────────────────

const ADVICE_FILENAME =
	'Use the search_files tool (filename/glob mode) instead — it uses the workspace index, ' +
	'returns structured results, and works identically on every shell (no find/grep quoting issues on Windows PowerShell).';

const ADVICE_CONTENT =
	'Use the search_files tool (content mode) or search_code instead — indexed, structured results, ' +
	'and no shell-quoting / portability pitfalls (grep is not available on Windows PowerShell).';

// ─── 模式表 ──────────────────────────────────────────────────────────────

/**
 * 搜索类终端命令模式表。第一条命中即生效（按特异性从高到低排列）。
 * 注意宁缺毋滥：只匹配「明确以搜索为目的」的命令形态，避免误伤构建/调试命令。
 */
export const TERMINAL_SEARCH_COMMAND_PATTERNS: readonly ITerminalSearchPattern[] = [
	{
		// Unix find 按文件名/类型搜索：find <path> -name/-iname/-type f ...
		id: 'posix-find-by-name',
		pattern: /\bfind\s+(?:"[^"]*"|'[^']*'|\S+)[^|;&]*?\s-(?:i?name|type\s+[fd])\b/,
		label: 'find -name/-iname (file discovery)',
		advice: ADVICE_FILENAME,
	},
	{
		// grep/rg 递归内容搜索：grep -r/-R/-rI..., rg --recursive 或裸 rg <pat> <path>
		id: 'grep-recursive',
		pattern: /\b(?:grep|rg)\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*\s|--recursive\b)/,
		label: 'grep -r / rg recursive (content search)',
		advice: ADVICE_CONTENT,
	},
	{
		// PowerShell Get-ChildItem -Recurse（含 gci/ls 别名）递归枚举文件
		id: 'ps-gci-recurse',
		pattern: /\b(?:Get-ChildItem|gci|ls)\b[^|;&]*-Recurse\b/i,
		label: 'Get-ChildItem -Recurse (recursive file enumeration)',
		advice: ADVICE_FILENAME,
	},
	{
		// cmd dir /s 递归列目录
		id: 'cmd-dir-recurse',
		pattern: /\bdir\s+[^|;&]*\/s\b/i,
		label: 'dir /s (recursive file enumeration)',
		advice: ADVICE_FILENAME,
	},
	{
		// PowerShell Select-String -Path 对文件做内容匹配
		id: 'ps-select-string',
		pattern: /\bSelect-String\b[^|;&]*-Path\b/i,
		label: 'Select-String -Path (content search)',
		advice: ADVICE_CONTENT,
	},
	{
		// Windows findstr /s 递归内容搜索
		id: 'findstr-recurse',
		pattern: /\bfindstr\s+(?:\/[a-z]+\s+)*\/s\b/i,
		label: 'findstr /s (recursive content search)',
		advice: ADVICE_CONTENT,
	},
];

// ─── 检测与 hint 生成 ────────────────────────────────────────────────────

/**
 * 检测终端命令是否属于「搜索类命令」。命中返回对应模式，否则 undefined。
 */
export function detectTerminalSearchCommand(command: string): ITerminalSearchPattern | undefined {
	if (!command) { return undefined; }
	return TERMINAL_SEARCH_COMMAND_PATTERNS.find(p => p.pattern.test(command));
}

/**
 * 生成追加到 terminal 输出末尾的 tool-hint 文本（引导 LLM 下次改用搜索工具）。
 */
export function terminalSearchCommandHint(hit: ITerminalSearchPattern): string {
	return [
		'',
		`[tool-hint] This command looks like a code search (${hit.label}).`,
		hit.advice,
		'Reserve the terminal for build/run/test commands.',
	].join('\n');
}
