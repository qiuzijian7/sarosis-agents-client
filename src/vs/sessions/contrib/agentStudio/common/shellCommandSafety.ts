/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * shellCommandSafety — 终端命令安全判定（纯函数，无 IO / 无 Node 依赖，可单测）。
 *
 * 起因：`terminal` 声明 `securityLevel: Dangerous`，而审批粒度是**工具级、完全不看
 * 命令内容** → 连 `Get-ChildItem | Select-Object Name` 这种纯只读命令也必弹卡片。
 *
 * ── 设计路线（对比 continue 与 Hermes-Agent 后的取舍）────────────────────────
 *
 * **抄 continue 的「只能升级、不能降级」两层模型**
 * （`packages/terminal-security/src/evaluateTerminalCommandSecurity.ts`，1241 行）：
 *   · 工具自身声明 basePolicy（我们 = `Dangerous`，即默认要确认）；
 *   · 命令分析的结果与 basePolicy 取**更严者**（`getMostRestrictive`）。
 *   · 因此默认配置下**行为完全不变**；只有用户显式开启「终端命令免确认」后，
 *     本模块的 `Safe` 判定才生效，而危险命令仍会被**升级**回需确认。
 *   这保证了「放宽」这件事永远是用户主动选择 + 安全层兜底，而非静默降级。
 *
 * **抄 Hermes 的「操作符短路」**（`tools/approval.py` 的 `_ALLOWLIST_SHELL_OPERATOR_RE`）：
 *   命令一旦含 shell 操作符，Hermes 直接让 allowlist 快捷通道失效 —— **不试图解析
 *   复合命令**，安全性由「放弃优化」保证，比完整解析简单一个数量级。
 *   我们只对**管道 `|`** 例外（PowerShell 里 `| Select-Object` / `| Where-Object`
 *   是刚需，一律拒绝的话白名单几乎没有实用价值），做法是拆成段后**要求每一段
 *   都独立命中白名单**（对齐 continue 的 `evaluatePipeChain` 思路）。
 *   其余操作符（`;` `&&` `||` `>` `<` 反引号 `$(` 换行 `%` 等）**一律回退审批**。
 *
 * **本项目特有：PowerShell 别名归一**（continue 没做 —— 它面向 bash/zsh）。
 *   本仓终端是 powershell.exe，`gci`/`ls`/`dir` 都是 `Get-ChildItem`，
 *   `gc`/`cat`/`type` 都是 `Get-Content`。不归一则白名单形同虚设。
 *
 * ⚠ 一切判定 **fail-closed**：遇到任何不认识的 token、解析异常、可疑形态，
 *   一律返回"需要审批"。宁可多问，不可放过。
 *
 * ── 与既有命令护栏的分工（三层，勿混淆／勿重复实现）───────────────────────
 *  ① `providers/tool/commandSafety.ts` — **HARDLINE 不可绕过地板**：删根目录 /
 *     格式化磁盘 / fork bomb。在 handler 最前置执行，命中即抛错，
 *     **审批流程根本不介入**，任何路由都无法放行。
 *  ② `providers/tool/executeCodeGuards.ts` — 源码写入护栏（`detectScriptSourceWrite`）
 *     与 Unix-only 命令探测，同样在 handler 内硬拦。
 *  ③ **本模块** — 只回答一个问题：「这条命令是否**已知只读**，可以跳过交互审批？」
 *     它**只会让审批变宽**，因此必须由用户显式开启设置才生效（见 toolExecutionGuard
 *     的 `_terminalAutoApproveProvider`）；且①②在 handler 层独立生效，
 *     本模块放行也不会绕过它们。
 */

/** 命令安全评估结果。 */
export const enum ShellCommandSafety {
	/** 已知只读、无副作用 —— 用户开启免确认后可直接执行。 */
	Safe = 'safe',
	/** 未知或有副作用 —— 必须弹审批。 */
	NeedsApproval = 'needs-approval',
}

/**
 * 会让「白名单快捷通道」直接失效的 shell 元字符 / 操作符（管道 `|` 单独处理）。
 *
 * 逐项理由（都能把只读命令变成有副作用）：
 *   · `;` `&&` `||`  串联另一条命令（`ls; rm -rf x`）
 *   · `>` `>>` `<`   重定向 —— **`Get-ChildItem > x.txt` 会写文件**
 *   · 反引号 / `$(`  命令替换（PowerShell 里 `$(...)` 同样执行）
 *   · `\n` `\r`      多行脚本
 *   · `&`            后台执行 / PowerShell 的调用操作符
 *   · `{` `}`        脚本块（`ForEach-Object { rm $_ }`）
 *   · `%`            PowerShell 中 `%` 是 ForEach-Object 别名，可执行任意脚本块
 *   · `@(` `$(`      子表达式
 *   · `::`           .NET 静态方法调用（`[System.IO.File]::Delete(...)`）
 *   · `[`            .NET 类型字面量（配合 `::` 可调任意 API）
 */
const BLOCKING_SHELL_TOKENS = [
	';', '&&', '||', '&', '>', '<', '`', '$(', '@(', '${',
	'\n', '\r', '{', '}', '%', '::', '[',
];

/**
 * PowerShell / cmd 别名 → 规范命令名。
 * 只收**只读**别名；有副作用的别名（`rm`/`del`/`mv`/`cp`/`ni`…）故意不收录，
 * 它们会因为不在白名单里而自然落到"需审批"。
 */
const COMMAND_ALIASES: ReadonlyMap<string, string> = new Map([
	// Get-ChildItem
	['gci', 'get-childitem'], ['ls', 'get-childitem'], ['dir', 'get-childitem'],
	// Get-Content
	['gc', 'get-content'], ['cat', 'get-content'], ['type', 'get-content'],
	// Get-Location / Get-Item / Get-Command 等
	['pwd', 'get-location'], ['gl', 'get-location'],
	['gi', 'get-item'], ['gp', 'get-itemproperty'],
	['gcm', 'get-command'], ['where', 'get-command'],
	['gm', 'get-member'], ['gps', 'get-process'], ['ps', 'get-process'],
	['measure', 'measure-object'],
	// 过滤/投影（管道常用）
	['select', 'select-object'], ['where-object', 'where-object'], ['?', 'where-object'],
	['sort', 'sort-object'], ['group', 'group-object'],
	['ft', 'format-table'], ['fl', 'format-list'], ['fw', 'format-wide'],
	['sls', 'select-string'],
	['echo', 'write-output'], ['write', 'write-output'],
]);

/**
 * 只读命令白名单（规范化后的小写名）。
 *
 * 取自 continue 的 `isSafeCommand` 分类（info / read / search / vcs-read），
 * 并补入 PowerShell 常用只读 cmdlet。
 * **务必只放"读"** —— 任何可能写盘、改环境、发网络请求的都不许进。
 */
const SAFE_COMMANDS: ReadonlySet<string> = new Set([
	// ── 信息查询 ──
	'get-childitem', 'get-location', 'get-item', 'get-itemproperty', 'get-command',
	'get-member', 'get-process', 'get-date', 'get-host', 'get-variable',
	'whoami', 'hostname', 'id', 'uname', 'date', 'uptime', 'df', 'du', 'free',
	'which', 'whereis', 'file', 'stat', 'wc', 'basename', 'dirname', 'realpath',
	// ── 读取内容 ──
	'get-content', 'head', 'tail', 'less', 'more', 'nl', 'od', 'strings',
	// ── 管道投影 / 过滤（无副作用）──
	'select-object', 'where-object', 'sort-object', 'group-object', 'measure-object',
	'format-table', 'format-list', 'format-wide', 'out-string',
	'select-string', 'convertto-json', 'convertfrom-json',
	// ── 输出 ──
	'write-output', 'write-host',
	// ── 搜索（带参数排除，见 ARG_EXCLUSIONS）──
	'grep', 'rg', 'find', 'findstr',
	// ── 版本控制只读（带子命令限制，见 SUBCOMMAND_ALLOWLIST）──
	'git',
	// ── 包管理器只读脚本（带子命令限制）──
	'npm', 'yarn', 'pnpm',
]);

/**
 * 子命令白名单 —— 这些命令只有特定子命令才算只读。
 * 例：`git status` 安全，但 `git push` / `git clean -fdx` 绝不安全。
 */
const SUBCOMMAND_ALLOWLIST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	['git', new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'blame', 'describe', 'rev-parse', 'ls-files', 'tag'])],
	// npm/yarn/pnpm 的 run/test/build 仍会执行任意脚本 → **刻意不放行**。
	// 只放行纯查询子命令。（continue 放行了 `npm test/build/run`，我们更保守：
	// package.json 的脚本内容对审批层不可见，等于放行任意命令。）
	['npm', new Set(['ls', 'list', 'view', 'outdated', 'why', 'ping', 'whoami'])],
	['yarn', new Set(['list', 'why', 'info'])],
	['pnpm', new Set(['list', 'ls', 'why', 'outdated'])],
]);

/**
 * 参数排除表 —— 命令在白名单内，但带上这些参数就能执行任意代码 / 删文件。
 * 取自 continue 的 `isSafeCommand`（`find -exec` / `grep --exec`）。
 */
const ARG_EXCLUSIONS: ReadonlyMap<string, readonly string[]> = new Map([
	['find', ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprintf', '-fls']],
	['grep', ['--exec', '-f', '--file']],
	['rg', ['--pre', '--hostname-bin', '-f', '--file']],
	['findstr', ['/f', '/g']],
]);

/**
 * 任何位置出现即视为危险的参数片段。
 *
 * ⚠ 只收「安全命令绝不会用到」的开关。**不要**把 `-c` / `-e` 放进来：
 * 它们只对解释器危险（`python -c` / `node -e` / `sh -c`），而解释器本就不在
 * `SAFE_COMMANDS` 里、早已被拒；放进来只会误伤 `grep -e pattern`、`wc -c`、
 * `du -c`、`git log -c` 这些合法只读用法。
 */
const GLOBAL_DANGEROUS_ARGS = [
	'-encodedcommand', '-enc', '-command',
	'-executionpolicy', '-noprofile', '-noninteractive',
	'--eval', '--exec', '-exec',
];

/**
 * 把命令切成 token（极简词法器：只需支持"引号包裹 + 空白分隔"）。
 *
 * 不追求完整 shell 语法 —— 因为**所有含元字符的命令都已在上游被拒**，
 * 到这里的一定是"单条简单命令 [| 单条简单命令]*"。
 * 引号不闭合 → 返回 undefined（fail-closed，交给审批）。
 */
function tokenize(segment: string): string[] | undefined {
	const tokens: string[] = [];
	let cur = '';
	let quote: '"' | '\'' | undefined;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (quote) {
			if (ch === quote) { quote = undefined; } else { cur += ch; }
			continue;
		}
		if (ch === '"' || ch === '\'') { quote = ch; continue; }
		if (ch === ' ' || ch === '\t') {
			if (cur) { tokens.push(cur); cur = ''; }
			continue;
		}
		cur += ch;
	}
	if (quote) { return undefined; } // 引号未闭合
	if (cur) { tokens.push(cur); }
	return tokens;
}

/** 规范化命令名：去路径、去 .exe、小写、解别名。 */
function canonicalizeCommandName(raw: string): string {
	let name = raw.toLowerCase();
	// 去掉路径前缀（`/usr/bin/ls`、`C:\Windows\System32\where.exe`）
	const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
	if (slash >= 0) { name = name.slice(slash + 1); }
	if (name.endsWith('.exe') || name.endsWith('.cmd') || name.endsWith('.bat')) {
		name = name.slice(0, name.lastIndexOf('.'));
	}
	return COMMAND_ALIASES.get(name) ?? name;
}

/** 判定单个管道段是否只读安全。 */
function isSafeSegment(segment: string): boolean {
	const tokens = tokenize(segment);
	if (!tokens || tokens.length === 0) { return false; }

	const name = canonicalizeCommandName(tokens[0]);
	if (!SAFE_COMMANDS.has(name)) { return false; }

	const args = tokens.slice(1);
	const lowerArgs = args.map(a => a.toLowerCase());

	// 全局危险参数（`-Command`、`-EncodedCommand` 等能执行任意代码）
	for (const a of lowerArgs) {
		if (GLOBAL_DANGEROUS_ARGS.includes(a)) { return false; }
	}

	// 命令专属参数排除
	const excluded = ARG_EXCLUSIONS.get(name);
	if (excluded && excluded.length > 0) {
		for (const a of lowerArgs) {
			if (excluded.includes(a)) { return false; }
		}
	}

	// 子命令限制（git / npm / yarn / pnpm）
	const allowedSubs = SUBCOMMAND_ALLOWLIST.get(name);
	if (allowedSubs) {
		// 第一个非选项参数即子命令
		const sub = lowerArgs.find(a => !a.startsWith('-'));
		if (!sub || !allowedSubs.has(sub)) { return false; }
	}

	return true;
}

/**
 * 评估终端命令是否只读安全。
 *
 * @param command 原始命令字符串
 * @returns `Safe` 仅当：无危险元字符、且每个管道段都命中只读白名单。
 */
export function evaluateShellCommandSafety(command: string | undefined): ShellCommandSafety {
	const cmd = (command ?? '').trim();
	if (!cmd) { return ShellCommandSafety.NeedsApproval; }

	// ── Hermes 式操作符短路：含危险元字符一律不走白名单 ──
	for (const tok of BLOCKING_SHELL_TOKENS) {
		if (cmd.includes(tok)) { return ShellCommandSafety.NeedsApproval; }
	}
	// `$` 变量展开：值不可知（`$env:X`、`$path`），可能被展开成任意内容 → 保守拒绝
	if (cmd.includes('$')) { return ShellCommandSafety.NeedsApproval; }
	// `--%` PowerShell 停止解析符号，之后内容原样传给外部程序
	if (cmd.includes('--%')) { return ShellCommandSafety.NeedsApproval; }

	// ── 管道链：每一段都必须独立安全（对齐 continue 的 evaluatePipeChain）──
	const segments = cmd.split('|').map(s => s.trim());
	if (segments.some(s => s.length === 0)) { return ShellCommandSafety.NeedsApproval; }
	for (const seg of segments) {
		if (!isSafeSegment(seg)) { return ShellCommandSafety.NeedsApproval; }
	}
	return ShellCommandSafety.Safe;
}

/** 会走命令内容分析的工具名（其余工具与本模块无关）。 */
const SHELL_TOOLS_WITH_COMMAND_ARG: ReadonlyMap<string, string> = new Map([
	['terminal', 'command'],
	['execute_code', 'command'],
]);

/**
 * 从工具调用中取出命令并评估。
 *
 * 只对 `terminal` / `execute_code` 生效；其余工具返回 `NeedsApproval`
 * （由调用方决定是否忽略 —— 本函数不应被用于非 shell 工具的放行判断）。
 */
export function evaluateToolCallShellSafety(toolName: string, args: unknown): ShellCommandSafety {
	const argKey = SHELL_TOOLS_WITH_COMMAND_ARG.get((toolName ?? '').toLowerCase());
	if (!argKey) { return ShellCommandSafety.NeedsApproval; }
	if (!args || typeof args !== 'object') { return ShellCommandSafety.NeedsApproval; }
	const raw = (args as Record<string, unknown>)[argKey];
	if (typeof raw !== 'string') { return ShellCommandSafety.NeedsApproval; }
	return evaluateShellCommandSafety(raw);
}

/** 该工具是否属于「命令内容可被分析」的 shell 工具。 */
export function isShellToolWithCommandArg(toolName: string): boolean {
	return SHELL_TOOLS_WITH_COMMAND_ARG.has((toolName ?? '').toLowerCase());
}

/**
 * 给模型看的「哪些命令形态会强制触发审批」提示词片段 —— **与本模块判据同源**。
 *
 * 为什么放在这里而不是各工具 description 里各写一份（2026-08-22）：
 * 文案描述的正是 `BLOCKING_SHELL_TOKENS` + 解释器白名单缺失这两条**运行时规则**。
 * 若在 `coreTools`（terminal）与 `compatibilityTools`（execute_code）各写一遍，
 * 改判据时必然漏改文案 —— 本项目已多次因「两份判据/文案漂移」踩坑
 * （沙箱提示词、模型族判断、keyed diff 均是）。故由判据所在模块导出唯一文案。
 *
 * 背景（日志实测）：模型写出 `cd X && (Get-Content y).Count` 与
 * `powershell -NoProfile -Command "..."`，两者都必然弹审批打断执行。原 description
 * 只说「用 cwd 而非 cd &&」且给的理由是实现细节（worktree 解析），对模型无感；
 * 更糟的是它还主动建议用 `&&` 串联，与审批规则自相矛盾。
 * 这里改为前置声明**对模型有意义的后果**——「护栏 ≠ 引导」。
 */
export const SHELL_APPROVAL_SHAPE_GUIDANCE =
	'\n\nCOMMAND SHAPE DECIDES WHETHER THE USER IS INTERRUPTED. These force an approval prompt that blocks'
	+ ' your execution: `&&` `;` `||` `&` `>` `<` backticks `$(` `@(` `${` `{}` `%` `::` `[` `$` newlines, and interpreter'
	+ ' wrappers (powershell -Command, bash -c, python -c). A single known read-only command may run without asking.'
	+ ' So: pass "cwd" rather than `cd X && Y`; never wrap in `powershell -Command` (you are ALREADY in a shell);'
	+ ' and to inspect a file use file_read (with limit:1 for line count + size) instead of shell counting.';

// ─── 反引导调用检测（[AntiGuidance] 诊断）────────────────────────────────

/**
 * 命中的「违反自身 description 明确指引」的规则。
 *
 * 每条规则**必须对应 `SHELL_APPROVAL_SHAPE_GUIDANCE` 里的一句具体指引** ——
 * 这是本模块的核心纪律：文案说了什么，就检测什么。二者放同一模块，避免
 * 「文案改了检测没改」（本项目已多次因两份判据漂移踩坑）。
 */
export type AntiGuidanceRule =
	/** 对应「never wrap in `powershell -Command` (you are ALREADY in a shell)」。 */
	| 'interpreter-wrapper'
	/** 对应「to inspect a file use file_read (with limit:1) instead of shell counting」。 */
	| 'shell-line-counting'
	/** 对应「pass "cwd" rather than `cd X && Y`」。 */
	| 'leading-cd';

export interface IAntiGuidanceFinding {
	readonly rule: AntiGuidanceRule;
	/** 命中的片段（已截断，用于日志定位）。 */
	readonly matched: string;
	/** description 里对应的那句指引原文 —— 证明「已经说过了」。 */
	readonly guidance: string;
	/** 应该改用的做法（给模型/给排查者）。 */
	readonly suggestion: string;
}

/** 解释器包装：命令把自己再套一层 shell/解释器。 */
const INTERPRETER_WRAPPER_RE =
	/\b(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[^\n]*?\s-(?:c|command)\b|\b(?:bash|sh|zsh)\b\s+-c\b|\b(?:python3?|node)\b\s+-(?:c|e)\b/i;

/**
 * 纯粹为「数行数 / 量文件大小」而跑的 shell 命令。
 *
 * ⚠ 判据刻意收窄，只匹配**结果只用于取行数/大小**的形态，避免误伤合法用法：
 *   · `(Get-Content x).Count` / `Get-Content x | Measure-Object -Line` → 命中
 *   · `wc -l file` → 命中
 *   · `Get-Content x | Select-String foo` → **不命中**（这是搜索，不是数行数）
 */
const LINE_COUNTING_RES: ReadonlyArray<RegExp> = [
	/\(\s*(?:get-content|gc|cat|type)\b[^)]*\)\s*\.\s*count\b/i,
	/\|\s*measure-object\b[^|\n]*-line\b/i,
	/\bwc\b\s+-[lc]\b/i,
	/\(\s*get-item\b[^)]*\)\s*\.\s*length\b/i,
];

/** 以 `cd <dir> &&|;` 开头 —— 应该用 cwd 参数。 */
const LEADING_CD_RE = /^\s*cd\s+[^\n&;|]+(?:&&|;)/i;

const GUIDANCE_QUOTES: Readonly<Record<AntiGuidanceRule, { guidance: string; suggestion: string }>> = {
	'interpreter-wrapper': {
		guidance: 'never wrap in `powershell -Command` (you are ALREADY in a shell)',
		suggestion: 'run the command directly without the interpreter wrapper',
	},
	'shell-line-counting': {
		guidance: 'to inspect a file use file_read (with limit:1 for line count + size) instead of shell counting',
		suggestion: 'call file_read with limit:1 — it returns "[File info: N 行, X KB]" without any approval prompt',
	},
	'leading-cd': {
		guidance: 'pass "cwd" rather than `cd X && Y`',
		suggestion: 'move the directory into the tool\'s "cwd" argument and drop the leading cd',
	},
};

function finding(rule: AntiGuidanceRule, matched: string): IAntiGuidanceFinding {
	const q = GUIDANCE_QUOTES[rule];
	return {
		rule,
		matched: matched.length > 120 ? `${matched.slice(0, 120)}…` : matched,
		guidance: q.guidance,
		suggestion: q.suggestion,
	};
}

/**
 * 检测命令是否违反了工具 description 里的明确指引。
 *
 * ## 为什么需要这个诊断（2026-08-22，日志 1787384463685）
 * 我们已把「哪些形态会触发审批 / 该用 file_read 查行数」写进 `execute_code` 与
 * `terminal` 的 description（实测 `toolsSchemaTokens` 13509→13912 证明确已送达），
 * 但模型**仍然**发出 `powershell -NoProfile -Command "(Get-Content x).Count"` ——
 * 同时违反了「别包解释器」和「查行数用 file_read」两条。
 *
 * 此前完全无法区分三种可能：① description 没送达 ② 送达但被截断
 * ③ 送达且完整、模型就是不听。本函数把 ③ 变成可计量的日志事实：命中哪条规则、
 * description 原话是什么、应该怎么做。据此才能决定下一步是改文案还是升级为硬拦截。
 *
 * **只做检测，不做拦截** —— 先观察频率。若某规则高频命中，再考虑在 handler 里
 * 直接拒绝并回传 suggestion（那属于行为变更，需要单独评估）。
 */
export function detectAntiGuidanceCommand(command: string): IAntiGuidanceFinding[] {
	const cmd = (command ?? '').trim();
	if (!cmd) { return []; }
	const out: IAntiGuidanceFinding[] = [];

	const wrapper = INTERPRETER_WRAPPER_RE.exec(cmd);
	if (wrapper) { out.push(finding('interpreter-wrapper', wrapper[0])); }

	for (const re of LINE_COUNTING_RES) {
		const m = re.exec(cmd);
		if (m) { out.push(finding('shell-line-counting', m[0])); break; }
	}

	const cd = LEADING_CD_RE.exec(cmd);
	if (cd) { out.push(finding('leading-cd', cd[0])); }

	return out;
}

/**
 * 渲染 `[AntiGuidance]` 日志。
 *
 * ⚠ 格式是**对外契约**（会被 grep 统计命中频率）：首行以
 * `[AntiGuidance] <tool> ignored its own description:` 开头。
 */
export function formatAntiGuidanceLog(
	toolName: string,
	command: string,
	findings: ReadonlyArray<IAntiGuidanceFinding>,
): string {
	const shortCmd = command.length > 200 ? `${command.slice(0, 200)}…` : command;
	const lines = [
		`[AntiGuidance] ${toolName} ignored its own description: rules=[${findings.map((f) => f.rule).join(', ')}]`,
		`  command: ${shortCmd}`,
	];
	for (const f of findings) {
		lines.push(`  · ${f.rule}: matched \`${f.matched}\``);
		lines.push(`      description said: ${f.guidance}`);
		lines.push(`      should instead:   ${f.suggestion}`);
	}
	return lines.join('\n');
}
