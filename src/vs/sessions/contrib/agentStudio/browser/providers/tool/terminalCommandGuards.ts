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
	/**
	 * 搜索语义类别（2026-08-21 新增，供 `terminalSearchFingerprint` 分派指纹策略）：
	 *  - `'content'`  内容搜索（grep/rg/Select-String/findstr）：**路径不进指纹**，
	 *    只留搜索词 —— 模型常「换个 root 再搜同一符号」，剥掉路径才能聚成同一意图。
	 *  - `'filename'` 文件枚举（find -name / Get-ChildItem -Recurse / dir /s）：
	 *    路径**就是**搜索意图本身，必须保留（取 basename），否则指纹为空拦不住。
	 */
	readonly kind: 'content' | 'filename';
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
		kind: 'filename',
	},
	{
		// grep/rg 递归内容搜索：grep -r/-R/-rI..., rg --recursive 或裸 rg <pat> <path>
		id: 'grep-recursive',
		pattern: /\b(?:grep|rg)\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*\s|--recursive\b)/,
		label: 'grep -r / rg recursive (content search)',
		advice: ADVICE_CONTENT,
		kind: 'content',
	},
	{
		// PowerShell Get-ChildItem -Recurse（含 gci/ls 别名）递归枚举文件
		id: 'ps-gci-recurse',
		pattern: /\b(?:Get-ChildItem|gci|ls)\b[^|;&]*-Recurse\b/i,
		label: 'Get-ChildItem -Recurse (recursive file enumeration)',
		advice: ADVICE_FILENAME,
		kind: 'filename',
	},
	{
		// cmd dir /s 递归列目录
		id: 'cmd-dir-recurse',
		pattern: /\bdir\s+[^|;&]*\/s\b/i,
		label: 'dir /s (recursive file enumeration)',
		advice: ADVICE_FILENAME,
		kind: 'filename',
	},
	{
		// PowerShell Select-String -Path 对文件做内容匹配
		id: 'ps-select-string',
		pattern: /\bSelect-String\b[^|;&]*-Path\b/i,
		label: 'Select-String -Path (content search)',
		advice: ADVICE_CONTENT,
		kind: 'content',
	},
	{
		// Windows findstr /s 递归内容搜索
		id: 'findstr-recurse',
		pattern: /\bfindstr\s+(?:\/[a-z]+\s+)*\/s\b/i,
		label: 'findstr /s (recursive content search)',
		advice: ADVICE_CONTENT,
		kind: 'content',
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

// ─── 重复搜索指纹（2026-08-21，事故 1787282838177）─────────────────────────
//
// 背景：既有三道搜索熔断（recordSearchRepeat / EmptyStreak / IntentRepeat）**只覆盖
// search_code / search_files 工具**。模型完全可以绕开它们改用 `terminal` 跑 shell
// grep —— 事故日志实证：47 轮迭代 78 个工具调用，大量 Select-String / Get-ChildItem
// 反复搜同一批 litegraph 文件，三道闸门全程零拦截，上下文一路涨到 4.4 万 token
// 触发压缩，最终压缩摘要挂死。
//
// 本文件此前只有「提示改用专用工具」（不阻断）——日志证明**提示无效**，模型照旧重复。
// 故补上第四道闸门：对**搜索类** terminal 命令按指纹计数，达阈值硬拦。
//
// 只对 TERMINAL_SEARCH_COMMAND_PATTERNS 命中的命令生效（即明确以递归搜索为目的），
// build/run/test/cat/git 等一概不计数、不拦截。

/**
 * 管道中的「纯格式化/分页」命令：不影响**结果集**，只影响呈现，故整段不进指纹。
 *
 * 判据与 `recordSearchRepeat` 的 `target` 设计原则一致（只对影响结果集的维度计数），
 * 否则模型加一个 `| Format-Table` 就能换出新指纹绕过熔断。
 *
 * 注意：`grep`/`rg`/`findstr`/`Select-String` **不在**此列 —— `grep -r foo | grep bar`
 * 的第二段真实收窄结果集，必须进指纹，否则 `| grep bar` 与 `| grep baz` 会同指纹被误拦。
 */
const PIPELINE_FORMATTER_COMMANDS: ReadonlySet<string> = new Set([
	'select-object', 'format-table', 'format-list', 'format-wide', 'sort-object',
	'measure-object', 'group-object', 'out-string', 'out-host', 'out-file', 'tee-object',
	'head', 'tail', 'sort', 'uniq', 'wc', 'less', 'more', 'cat', 'tee', 'column', 'tr',
]);

/**
 * 指纹噪声 token：flag 的枚举值、格式化属性名、shell 包装词。
 *
 * 只收录「高频且确定无搜索语义」的词。刻意保持精简 —— 词表越长越容易误删真实搜索词
 * （宁可指纹稍宽而漏拦，不可把关键词吃掉造成误拦）。
 */
const FINGERPRINT_NOISE_TOKENS: ReadonlySet<string> = new Set([
	// 命令名本身
	'grep', 'rg', 'find', 'findstr', 'dir', 'ls', 'get-childitem', 'gci',
	'select-string', 'cmd', 'powershell', 'pwsh', 'bash', 'sh', 'where-object',
	// -ErrorAction 等 flag 的枚举值
	'silentlycontinue', 'stop', 'continue', 'ignore', 'inquire', 'suspend',
	// 常见属性名/格式化参数（Select-Object Name / -AutoSize / -First N）
	'name', 'fullname', 'basename', 'directory', 'directoryname', 'length',
	'autosize', 'first', 'last', 'count', 'property', 'expandproperty',
	// shell 包装
	'noprofile', 'command', 'nologo', 'noninteractive', 'true', 'false', 'null',
]);

/**
 * 是否像路径（而非正则 pattern）。
 *
 * ⚠ 判据必须能区分「路径分隔符」与「正则转义反斜杠」——最初实现用
 * `/[\\/]/.test(token)` 一刀切，把 `"\bshowLinkMenu\b"` 判成路径，content 类
 * 又会**整个丢弃**路径 token，导致关键搜索词被吃掉、指纹为空、熔断彻底失效
 * （本文件验证脚本 B4/C4 曾复现）。
 *
 * 因此改为**白名单式**识别路径形态，其余含反斜杠的一律视为正则转义：
 *   盘符 `G:\` / `G:/`、裸盘符 `G:`、UNC `\\server`、相对 `./` `../` `.\` `..\`、含 `/`。
 *
 * 失败模式是刻意选的：Windows 裸相对路径（`src\foo`，模型极少这么写）会被判为
 * 非路径而进入指纹 → content 类换 root 时聚不到一起 → **漏拦**。
 * 这符合本模块的一贯取舍：宁可指纹稍宽而漏拦，不可吃掉搜索词造成误拦。
 */
function looksLikePath(token: string): boolean {
	if (/^[A-Za-z]:[\\/]/.test(token)) { return true; }  // G:\dir / G:/dir
	if (/^[A-Za-z]:$/.test(token)) { return true; }      // 裸盘符
	if (token.startsWith('\\\\')) { return true; }       // UNC \\server\share
	if (/^\.\.?[\\/]/.test(token)) { return true; }      // ./ ../ .\ ..\
	if (token.includes('/')) { return true; }            // Unix 路径 / glob
	return false;
}

/** 取路径末段（basename），并去掉尾部分隔符。 */
function pathBasename(token: string): string {
	const cleaned = token.replace(/[\\/]+$/, '');
	const parts = cleaned.split(/[\\/]+/).filter(Boolean);
	return parts.length > 0 ? parts[parts.length - 1] : '';
}

/**
 * 把「搜索类」terminal 命令归一成搜索意图指纹（纯函数，便于单测）。
 *
 * 归一策略（与 `searchQueryFingerprint` 同样有意做「宽」，只求同意图聚类）：
 *  1. 按 `|` 拆管道段，丢弃首 token 属 `PIPELINE_FORMATTER_COMMANDS` 的整段；
 *  2. 逐段做 shell-aware 分词（保留引号内含空格的整体）；
 *  3. 丢弃 flag（`-x` / `--xx` / `/x`）、纯数字、`FINGERPRINT_NOISE_TOKENS`；
 *  4. 路径处理按 `kind` 分派：
 *     - `content`：路径**整个丢弃**（换 root 搜同一符号 → 同指纹，这是主要绕过手法）；
 *     - `filename`：路径取 basename 保留（路径即搜索意图）；
 *  5. 剩余 token 拼接后交给调用方（searchHelpers）用 `searchQueryFingerprint` 做最终归一。
 *
 * @returns 归一化前的「意图 token 串」；无有效 token 时返回 undefined（不参与计数）
 */
export function terminalSearchFingerprintTokens(
	command: string, kind: 'content' | 'filename',
): string | undefined {
	if (!command) { return undefined; }
	const segments = command.split('|');
	const kept: string[] = [];

	for (const seg of segments) {
		// shell-aware 分词：把 "..." / '...' 视为单 token（去掉引号本身）
		const tokens = (seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
			.map(t => t.replace(/^["']|["']$/g, ''))
			.filter(Boolean);
		if (tokens.length === 0) { continue; }

		// 纯格式化段整体跳过（PowerShell cmdlet 大小写不敏感）
		const head = tokens[0].toLowerCase();
		if (PIPELINE_FORMATTER_COMMANDS.has(head)) { continue; }

		for (const raw of tokens) {
			// flag：`-Recurse` / `--include` / `/s`（cmd 风格，注意排除路径 `/usr/bin`）
			if (/^--?[A-Za-z]/.test(raw)) { continue; }
			if (/^\/[A-Za-z]$/.test(raw)) { continue; }
			if (/^\d+$/.test(raw)) { continue; }

			if (looksLikePath(raw)) {
				// content 搜索：路径不进指纹（换 root 重搜必须聚成同一意图）
				if (kind === 'content') { continue; }
				const base = pathBasename(raw);
				if (base && !FINGERPRINT_NOISE_TOKENS.has(base.toLowerCase())) { kept.push(base); }
				continue;
			}
			if (FINGERPRINT_NOISE_TOKENS.has(raw.toLowerCase())) { continue; }
			kept.push(raw);
		}
	}

	if (kept.length === 0) { return undefined; }
	return kept.join(' ');
}

/**
 * 生成 terminal 重复搜索的硬拦消息。
 *
 * 与 `recordSearchRepeat` 的 blocked 文案同风格：说清「为什么拦」+「该怎么做」，
 * 并给出明确出路（转专用工具），避免模型原地重试到烧完预算。
 */
export function terminalSearchRepeatBlockedMessage(
	count: number, fingerprint: string, hit: ITerminalSearchPattern,
): string {
	return [
		`BLOCKED: 你已用 terminal 发起 ${count} 次同一搜索意图的命令（${hit.label}，指纹=${fingerprint}），结果不会有实质变化。`,
		`shell 搜索不走工作区索引、要全树扫描，且每次输出都会挤占上下文预算——这正是本次会话上下文膨胀的主因。`,
		hit.advice,
		`请立刻改用 search_code / search_files（它们有独立的分页与熔断口径），或基于已获得的信息推进任务。`,
	].join('\n');
}
