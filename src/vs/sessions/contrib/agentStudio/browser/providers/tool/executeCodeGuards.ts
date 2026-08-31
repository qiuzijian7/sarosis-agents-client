/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * execute_code 命令护栏与脚本路径提取的纯逻辑（无 VS Code 依赖，可独立单测）。
 *
 * 从 compatibilityTools.ts 抽出（对齐 pathFilterNormalize.ts / webSearchParse.ts 模式）。
 *
 * 背景（日志 1785744765714 子代理工具失败分析）：
 *  - exit 255：模型在 Windows 上用 Unix `head` 管道 → cmd.exe 报 "不是内部或外部命令"
 *  - exit 2：模型用相对路径引用技能 CLI（如 scripts/anysearch_cli.py），但 cwd 是
 *    另一个 workspace（S1Game），技能 CLI 不在其中
 * 这两个 helper 在工具实现层解决——不改系统提示词、不针对个案硬编码。
 */

import type { ShellDialect } from './shellPlatformPrompt.js';

/** Unix-only 命令 → PowerShell 等价写法（用于护栏错误消息）。 */
export const UNIX_ONLY_COMMAND_HINTS: Record<string, string> = {
	head: 'Select-Object -First <N>',
	tail: 'Select-Object -Last <N>',
	grep: 'Select-String -Pattern <regex>',
	sed: "ForEach-Object { $_ -replace '<old>','<new>' }",
	awk: 'ForEach-Object with -split',
};

/**
 * Windows 护栏：检测命令段起始位置（行首 / `|` / `&&` / `;` 之后）的 Unix-only 命令。
 * cmd.exe 下 head/tail/grep/sed/awk 均不存在（exit 255 "不是内部或外部命令"）。
 * 命中即由调用方抛错并附 PowerShell 等价写法——模型看到可执行反馈后自行改写重发。
 */
export function detectUnixOnlyCommand(command: string): string | undefined {
	const m = /(?:^|[|;&]+)\s*(head|tail|grep|sed|awk)\b/im.exec(command);
	return m ? m[1].toLowerCase() : undefined;
}

// ── 反向护栏：PowerShell cmdlet 裸用在 cmd.exe（2026-08-21，日志 1787292837471）──
//
// 现象：模型读了 Unix 护栏给的「用 Select-Object -First N」提示后**过度纠正** ——
// 把 PowerShell cmdlet 直接塞进 cmd.exe 管道却漏掉 `powershell -Command` 外壳：
//   python3 -c "..." 2>&1 | Out-String -Width 500
//   → exit 255：'Out-String' 不是内部或外部命令
// 这与 Unix 方言失败完全对称（都是「shell 里没这个命令」），因此同样在执行前拦下、
// 给出可执行的正确写法，而不是让它跑一次必败的命令再重试 3 次。

/** cmd.exe 下不存在的常见 PowerShell cmdlet（动词-名词式，Unix 护栏提示里会出现的那些）。 */
const POWERSHELL_ONLY_CMDLETS = [
	'Out-String', 'Out-File', 'Out-Host', 'Out-Null',
	'Select-Object', 'Select-String',
	'Get-ChildItem', 'Get-Content', 'Get-Item',
	'ForEach-Object', 'Where-Object', 'Measure-Object', 'Sort-Object',
	'Write-Host', 'Write-Output',
];

/**
 * 检测命令是否在 **未包 PowerShell 外壳** 的情况下使用了 PowerShell cmdlet。
 *
 * 判定：
 *  1. 命令里没有 `powershell` / `pwsh` 调用（有则视为已正确包裹，放行）；
 *  2. 命令段起始位置（行首 / `|` / `&&` / `;` 之后）出现 cmdlet 名。
 *
 * 返回命中的 cmdlet 名（原始大小写形式），未命中返回 undefined。
 */
export function detectPowerShellOnlyCmdlet(command: string): string | undefined {
	// 已显式走 powershell/pwsh → 放行（cmdlet 在其中合法）
	if (/\b(powershell(\.exe)?|pwsh(\.exe)?)\b/i.test(command)) { return undefined; }
	for (const cmdlet of POWERSHELL_ONLY_CMDLETS) {
		// 命令段起始位置匹配，避免误伤字符串字面量里的同名文本
		const re = new RegExp(`(?:^|[|;&]+)\\s*${cmdlet}\\b`, 'im');
		if (re.test(command)) { return cmdlet; }
	}
	return undefined;
}

/**
 * 由 PowerShell cmdlet 反查等价的 POSIX 命令（{@link UNIX_ONLY_COMMAND_HINTS} 的逆映射）。
 *
 * 刻意**不另建一张映射表** —— 两张表必然漂移（本项目已多次因「两份判据/文案漂移」
 * 踩坑）。逆查不到（如 Get-Content / Get-ChildItem 在上表里没有 POSIX 对应项）返回
 * undefined，由调用方退化为不带等价写法的通用文案。
 */
function posixEquivalentFor(cmdlet: string): string | undefined {
	for (const [unix, ps] of Object.entries(UNIX_ONLY_COMMAND_HINTS)) {
		// 'Select-Object -First <N>' → 'Select-Object'
		if (ps.split(/[\s<]/)[0].toLowerCase() === cmdlet.toLowerCase()) { return unix; }
	}
	return undefined;
}

/**
 * 反向护栏的错误消息：PowerShell cmdlet 裸用在**非 PowerShell** 的 shell 里。
 *
 * @param dialect 当前 shell 方言（由 Git Bash 探测 + 平台决定）。缺省 'cmd' 保持
 *   既有行为，避免波及其它调用点。
 */
export function powerShellCmdletGuardMessage(cmdlet: string, toolName: string, dialect: ShellDialect = 'cmd'): string {
	// ★ 按方言分派（2026-08-30）：posix（Git Bash）下 cmdlet 同样不存在，但**失败码是
	// 127**、正确做法是改用 POSIX 命令，而不是包一层 powershell。2026-08-30 前本函数
	// 写死 cmd.exe 语境，且调用方把护栏整体门控在「无 Git Bash」分支内，导致 Git Bash
	// 下这类必败命令完全不拦（日志 20260829T232635：`Select-Object: command not found`）。
	if (dialect === 'posix') {
		const equiv = posixEquivalentFor(cmdlet);
		return (
			`${toolName}: '${cmdlet}' is a PowerShell cmdlet, but this command runs in a POSIX shell ` +
			`(Git Bash) where PowerShell cmdlets do not exist — running this would fail with ` +
			`"${cmdlet}: command not found" (exit 127).\n` +
			(equiv
				? `Use the POSIX equivalent instead: \`${equiv}\` (${cmdlet} → ${equiv}).\n`
				: `Use the POSIX equivalent instead (head / tail / grep / sed / awk — NOT PowerShell cmdlets).\n`) +
			`Do NOT wrap it in powershell -Command: you are already in a POSIX shell.\n` +
			`Then reissue ${toolName} with the corrected command.`
		);
	}
	return (
		`${toolName}: '${cmdlet}' is a PowerShell cmdlet and does not exist in cmd.exe — running this would fail with ` +
		`"'${cmdlet}' is not recognized as an internal or external command" (exit 255).\n` +
		`Wrap the WHOLE pipeline in a PowerShell shell instead of piping into the cmdlet directly:\n` +
		`  powershell -NoProfile -Command "<your command> | ${cmdlet} ..."\n` +
		`Note the quoting: the entire pipeline goes inside the -Command string. ` +
		`Then reissue ${toolName} with the corrected command.`
	);
}

/**
 * 检测「命令/程序不存在」类的确定性失败（供调用方判定是否值得重试）。
 *
 * 这类失败重试毫无意义：命令名不会在退避间隙里变对。日志 1787292837471 实测
 * exit 255（`'Out-String' 不是内部或外部命令`）与 exit 1（`'import' 不是内部或
 * 外部命令`）各被重试 3 次，共浪费 4 次额外执行 + ~6s 退避，模型只拿到同一条
 * 错误重复 3 遍。
 *
 * 覆盖中英文 cmd.exe / PowerShell / POSIX shell 的典型措辞。
 */
export function isCommandNotFoundFailure(output: string): boolean {
	if (!output) { return false; }
	return (
		/不是内部或外部命令/.test(output) ||                        // cmd.exe 中文
		/is not recognized as an internal or external command/i.test(output) || // cmd.exe 英文
		/is not recognized as the name of a cmdlet/i.test(output) || // PowerShell
		/CommandNotFoundException/i.test(output) ||                  // PowerShell 异常名
		/command not found/i.test(output) ||                         // POSIX shell
		/: No such file or directory/i.test(output) && /^\S+:/.test(output) // exec 失败
	);
}

/**
 * 检测「脚本自身逻辑/语法错误」类的确定性失败（供调用方判定是否值得重试）。
 *
 * 与 {@link isCommandNotFoundFailure} 互补：那个管「程序名不存在」，这个管
 * 「解释器启动成功，但脚本自己抛错」。两者都是**同输入必然同结果**，重试无意义。
 *
 * 事故（日志 1787302409958 ITER 50）：`python3 - <<'PY'` heredoc 内
 * `assert start is not None, "start not found"` 失败 → exit 1。同一 callId
 * （chatcmpl-tool-b2d39eaa0f4d2790）被重试 **3 次** —— 同一份脚本对同一份文件
 * 必然再次 assert 失败，纯浪费 2 次执行 + ~3s 退避。
 *
 * ⚠ 刻意**保守**：只认「解释器明确报出的语法/逻辑异常类型」，绝不把所有 exit 1
 * 当确定性失败。编译失败、网络请求脚本、文件锁竞争等**可能**在重试后成功，
 * 必须保留重试（这也是为什么不做 `exitCode === 1` 这种粗判）。
 */
export function isDeterministicScriptFailure(output: string): boolean {
	if (!output) { return false; }
	// Python：须同时出现 Traceback 与确定性异常类型（避免误伤 requests.Timeout 等瞬态）
	if (/Traceback \(most recent call last\)/.test(output)) {
		if (/\b(AssertionError|SyntaxError|IndentationError|TabError|NameError|ImportError|ModuleNotFoundError|AttributeError|TypeError|IndentationError)\b/.test(output)) {
			return true;
		}
	}
	// Python 语法错误可能不带 Traceback 头（编译期即失败）
	if (/^\s*(SyntaxError|IndentationError|TabError):/m.test(output)) { return true; }
	// Node/JS：语法与引用类错误
	if (/^\s*(SyntaxError|ReferenceError|TypeError):/m.test(output) && /\bat\s+\S+:\d+:\d+/.test(output)) {
		return true;
	}
	if (/\bSyntaxError: (Unexpected|Invalid|missing)/i.test(output)) { return true; }
	// Node module 解析失败（拼错模块名/路径）
	if (/Cannot find module '/.test(output) || /ERR_MODULE_NOT_FOUND/.test(output)) { return true; }
	return false;
}

/** 脚本确定性失败的引导消息（告诉模型「改脚本/换工具」而非重试）。 */
export function deterministicScriptFailureMessage(exitCode: number, body: string): string {
	return (
		`execute_code failed (exit ${exitCode}) — the script itself raised a deterministic error; ` +
		`re-running the same script on the same input will fail identically, so it was NOT retried.\n${body}\n` +
		`Fix the script before reissuing. If you were editing source code by locating lines and splicing ` +
		`new content, use the patch tool instead — it is atomic, reviewable as a diff, and reports ` +
		`context mismatches precisely (a hand-rolled read/locate/write script has none of that).`
	);
}

// ── 裸源码护栏（2026-08-21，日志 1787292837471）──────────────────────────────
//
// 现象：模型把**多行 Python 源码**直接当 `command` 传给 execute_code：
//   import os, json
//   base = "G:/.../ComfyUI"
//   ...
//   → cmd.exe 拿 `import` 当程序名 → exit 1「'import' 不是内部或外部命令」
// command 期望的是 shell 命令，源码必须交给解释器（`python3 -c "..."` / heredoc /
// 先写文件再执行）。执行前拦下并给出正确写法。

/** 一眼可判「这是源码而非 shell 命令」的行首关键字。 */
const SOURCE_CODE_LINE_STARTS = [
	/^import\s+[A-Za-z_]/,          // Python / JS import
	/^from\s+[A-Za-z_.]+\s+import\s/, // Python from-import
	/^def\s+\w+\s*\(/,               // Python def
	/^class\s+\w+\s*[(:]/,           // Python / JS class
	/^(const|let|var)\s+\w+\s*=/,    // JS 声明
	/^function\s+\w+\s*\(/,          // JS function
	/^(async\s+)?function\s*\(/,     // JS 匿名 function
	/^print\s*\(/,                   // Python print
	/^if\s+__name__\s*==/,           // Python main guard
];

/**
 * 检测 command 是否其实是**裸源码**（而非 shell 命令）。
 *
 * 判定（须同时满足，尽量保守避免误伤）：
 *  1. 多行（单行 `import x` 极可能是有意为之的边缘用法，放行）；
 *  2. 首个非空行命中 {@link SOURCE_CODE_LINE_STARTS}；
 *  3. 命令里没有解释器调用（`python`/`node`/`ruby`…）也没有 heredoc（`<<`）——
 *     有则说明模型已正确包裹，放行。
 *
 * 命中返回匹配到的首行（截断），未命中返回 undefined。
 */
export function detectBareSourceCode(command: string): string | undefined {
	const lines = command.split(/\r?\n/);
	const nonEmpty = lines.filter(l => l.trim().length > 0);
	if (nonEmpty.length < 2) { return undefined; }              // 单行放行
	if (/<</.test(command)) { return undefined; }                // heredoc 由 _extractHeredoc 处理
	if (/\b(python3?|node|ruby|perl|php|deno|bun)\b/i.test(command)) { return undefined; } // 已有解释器

	const first = nonEmpty[0].trim();
	for (const re of SOURCE_CODE_LINE_STARTS) {
		if (re.test(first)) { return first.slice(0, 80); }
	}
	return undefined;
}

/** 裸源码护栏的错误消息（给出三种正确写法）。 */
export function bareSourceCodeGuardMessage(firstLine: string, toolName: string): string {
	return (
		`${toolName}: the "command" argument looks like raw source code, not a shell command ` +
		`(first line: \`${firstLine}\`). The shell would try to execute \`${firstLine.split(/\s+/)[0]}\` as a program and fail.\n` +
		`"command" must be a shell command line. Pick one of:\n` +
		`  1. Inline via interpreter:  python3 -c "import os; print(os.getcwd())"\n` +
		`  2. Heredoc (multi-line):    python3 << 'EOF'\\n<your code>\\nEOF\n` +
		`  3. Write then run:          use file_write to save a .py file, then run  python3 <path>\n` +
		`For simple file/content lookup prefer search_files / search_code — indexed, no shell needed.`
	);
}

// ── 源码写入护栏（2026-08-21，日志 1787319805992）────────────────────────────
//
// 事故链：`patch` 因 CRLF 不匹配连续失败两次后，模型退化为自己跑脚本改源码：
//   python3 - <<'PY'
//   p = r"...\features\workflowEditor\WorkflowEditorPanel.tsx"
//   lines = open(p, "r", newline="").readlines()
//   del lines[start:end+1]; lines[ins2:ins2] = block
//   open(p, "w", newline="").writelines(lines)
//   PY
// 且该次**执行成功（exit 0）** —— 源码被整篇重写。而 execute_code / terminal 走
// shell 路径：不创建 checkpoint（`captureBeforeToolEdit` 只在 file_write / patch
// 的 handler 里调用）、不过文件编辑审批、改动不可作为 diff 复核。等于仓库被改却
// 没有任何回滚点，且事后无从得知改了什么。
//
// 随后同一份脚本因 `start=None` 抛 TypeError 又被原样重发一次，靠 loop detection
// 才刹住 —— 证明「失败后的引导文案」不足以阻断这条退化路径，必须在执行前拦。
//
// 判据刻意要求**两个必要条件同时成立**（写文件 API × 该 API 参数指向源码文件），
// 因为「在 shell 里写文件」本身完全合法：生成产物、写日志、导出数据都必须放行。

/** 视为「源代码 / 配置」的扩展名 —— 这类文件的修改必须经 patch / file_write。 */
const SOURCE_FILE_EXTENSIONS = [
	'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'go', 'rs',
	'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'cs', 'rb', 'php', 'swift', 'kt', 'kts', 'scala',
	'sh', 'ps1', 'psm1', 'vue', 'svelte',
	'css', 'scss', 'less', 'sass', 'html', 'htm',
	'json', 'jsonc', 'yaml', 'yml', 'toml', 'md',
];

/** 源码扩展名的正则片段（不含前导点）。 */
const SOURCE_EXT_ALTERNATION = SOURCE_FILE_EXTENSIONS.join('|');

/**
 * 构建产物 / 缓存目录 —— 落在这些目录里的文件不是源码，脚本批量生成完全正常。
 * 放行这些是护栏可用性的关键（否则「写 100 个 fixture」只能逐个 file_write）。
 *
 * `(?:^|[\\/])`：目录标记也可能出现在**路径开头**（`out/vs/bundle.js`），
 * 只认前导分隔符会漏掉相对路径形态。
 */
const GENERATED_PATH_MARKER = new RegExp(
	'(?:^|[\\\\/])(?:out|out-build|out-test|dist|build|coverage|node_modules|\\.git|\\.tmp|tmp|temp|' +
	'generated|generated-images|__pycache__|\\.vscode-test|\\.cache|target)[\\\\/]',
	'i',
);

/** 单条「写文件」形态。 */
interface IScriptWritePattern {
	readonly id: string;
	/** 需带 `g` 标志：调用方遍历所有命中位置以取各自的参数区。 */
	readonly pattern: RegExp;
	readonly label: string;
	/**
	 * 目标提取范围。
	 *  - `call`：函数调用 —— 取**括号配对内的实参** + 同行前缀（接收者，
	 *    如 `target.write_text(...)` 的 `target`）。
	 *  - `line`：shell 形态 —— 取命中处到行尾（`sed -i 's/a/b/' f.ts`、`> f.ts`）。
	 *
	 * 为什么必须区分：早期实现一律取「命中位置后 240 字符」，会**跨越语句** ——
	 * `open(src,"r")` 的窗口吃进了下一行 `open(out,"w")` 的 `"w"`，把只读打开误判为
	 * 写，再从窗口里捞到 `src` 变量 → 「读源码写 csv 报告」这一高频合法形态被误伤。
	 */
	readonly scope: 'call' | 'line';
}

/**
 * 写文件类操作形态表（Python / Node / POSIX shell / PowerShell）。
 *
 * 只列**确定会落盘**的 API。刻意不含裸 `.write(`（`sys.stdout.write` 等同名成员
 * 太多）与裸 `>`（`2>&1` 是重定向 stderr 不落盘），改由更精确的形态覆盖。
 */
const SCRIPT_WRITE_PATTERNS: readonly IScriptWritePattern[] = [
	{
		// open(path, "w"/"a"/"x"[+][b])；mode 可为位置参数或 mode= 关键字
		id: 'py-open-write',
		pattern: /\bopen\s*\(/gi,
		label: 'open(..., "w") — Python file write',
		scope: 'call',
	},
	{
		id: 'py-path-write',
		pattern: /\.\s*write_(?:text|bytes)\s*\(/gi,
		label: 'pathlib.Path.write_text()/write_bytes()',
		scope: 'call',
	},
	{
		id: 'py-writelines',
		pattern: /\.\s*writelines\s*\(/gi,
		label: 'writelines() — Python bulk write',
		scope: 'call',
	},
	{
		id: 'py-move-replace',
		pattern: /\b(?:os\s*\.\s*(?:replace|rename)|shutil\s*\.\s*(?:copy2?|copyfile|move))\s*\(/gi,
		label: 'os.replace()/shutil.move() — Python file replace',
		scope: 'call',
	},
	{
		id: 'node-write-file',
		pattern: /\b(?:writeFileSync|appendFileSync|createWriteStream|renameSync|copyFileSync|writeFile|appendFile)\s*\(/g,
		label: 'fs.writeFileSync()/fs.writeFile() — Node file write',
		scope: 'call',
	},
	{
		id: 'sed-in-place',
		pattern: /\bsed\s+(?:-[a-zA-Z]+\s+)*-i[a-zA-Z]*\b|\bsed\s+-[a-zA-Z]*i[a-zA-Z]*\s/g,
		label: 'sed -i — in-place stream edit',
		scope: 'line',
	},
	{
		id: 'ps-write-cmdlet',
		pattern: /\b(?:Set-Content|Add-Content|Out-File|Move-Item|Copy-Item|Rename-Item)\b/gi,
		label: 'Set-Content/Out-File — PowerShell file write',
		scope: 'line',
	},
	{
		// shell 重定向：`> file` / `>> file`。前置字符排除数字与 `&`，避免把
		// `2>&1` / `1>` 之类的 fd 重定向当成写文件。
		id: 'shell-redirect',
		pattern: /(?:^|[^0-9&>\s])\s*>>?\s*(?![&>])/g,
		label: 'shell redirection (> / >>) into a file',
		scope: 'line',
	},
];

/** 命中结果：写 API 形态 + 被写的源码目标。 */
export interface IScriptSourceWriteHit {
	/** 命中的写形态标签（错误消息用）。 */
	readonly api: string;
	/** 推断出的被写源码文件（路径字面量，或绑定到源码路径的变量名）。 */
	readonly target: string;
}

/**
 * 收集「被赋值为源码路径的变量名」。
 *
 * 必要性：模型的实际写法是路径与写调用**分行** ——
 *   `p = r"...\WorkflowEditorPanel.tsx"` … `open(p, "w")`
 * 只看 `open(...)` 的参数区永远看不到扩展名。故先建立变量→源码路径的绑定，
 * 再在参数区里认变量名。
 *
 * 覆盖 Python（`p = r"..."` / `p = Path("...")`）与 JS（`const p = "..."`）。
 */
function _collectSourcePathVariables(command: string): Map<string, string> {
	const out = new Map<string, string>();
	const re = new RegExp(
		// [const|let|var] name = [Path(] [r|f|rb]"...ext" [)]
		'(?:^|[\\s;{(])(?:const\\s+|let\\s+|var\\s+)?([A-Za-z_$][\\w$]*)\\s*=\\s*' +
		'(?:(?:pathlib\\s*\\.\\s*)?Path\\s*\\(\\s*)?' +
		'(?:[rRfFbBuU]{1,2})?["\']([^"\'\\n]*\\.(?:' + SOURCE_EXT_ALTERNATION + '))["\']',
		'g',
	);
	let m: RegExpExecArray | null;
	while ((m = re.exec(command)) !== null) {
		const [, name, filePath] = m;
		if (GENERATED_PATH_MARKER.test(filePath)) { continue; }
		out.set(name, filePath);
	}
	return out;
}

/**
 * 在一段文本（写 API 的参数区）中查找源码目标：直接的路径字面量，或已知的
 * 源码路径变量名。返回可读的目标描述，未命中返回 undefined。
 */
function _findSourceTargetInSegment(segment: string, sourceVars: Map<string, string>): string | undefined {
	// ① 直接出现的路径（带引号或裸写，如 `> src/a.ts`）
	const literal = new RegExp('[\\w./\\\\:$~-]*\\.(?:' + SOURCE_EXT_ALTERNATION + ')\\b', 'i').exec(segment);
	if (literal && !GENERATED_PATH_MARKER.test(literal[0])) {
		return literal[0];
	}
	// ② 绑定到源码路径的变量名
	for (const [name, filePath] of sourceVars) {
		if (new RegExp('(?:^|[^\\w$])' + name.replace(/\$/g, '\\$') + '(?![\\w$])').test(segment)) {
			return `${name} (= ${filePath})`;
		}
	}
	return undefined;
}

/** Python `open()` 的写模式判定：参数区里出现 `"w"/"a"/"x"` 形态的 mode。 */
function _isPythonWriteMode(segment: string): boolean {
	return /,\s*(?:mode\s*=\s*)?["'][waxWAX]\+?[bt]?["']/.test(segment)
		|| /,\s*(?:mode\s*=\s*)?["'][bt][waxWAX]\+?["']/.test(segment);
}

/**
 * 取函数调用的实参文本：从 `from` 之后的第一个 `(` 起做括号配对（跳过字符串内的
 * 括号），返回配对区间内的内容。未闭合（脚本被截断等）则退回到行尾。
 *
 * 精确到「本次调用的实参」是避免误伤的关键 —— 见 {@link IScriptWritePattern.scope}。
 */
function _callArguments(command: string, from: number): string {
	const openIdx = command.indexOf('(', from);
	if (openIdx < 0) { return _restOfLine(command, from); }
	let depth = 0;
	let quote: string | undefined;
	for (let i = openIdx; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === '\\') { i++; continue; }
			if (ch === quote) { quote = undefined; }
			continue;
		}
		if (ch === '"' || ch === '\'' || ch === '`') { quote = ch; continue; }
		if (ch === '(') { depth++; continue; }
		if (ch === ')') {
			depth--;
			if (depth === 0) { return command.slice(openIdx + 1, i); }
		}
	}
	return _restOfLine(command, openIdx);
}

/** 取 `from` 起到行尾的文本（shell 形态的目标就在同一行）。 */
function _restOfLine(command: string, from: number): string {
	const nl = command.indexOf('\n', from);
	return nl < 0 ? command.slice(from) : command.slice(from, nl);
}

/** 取同一行内 `before` 之前的前缀（用于识别成员调用的接收者，如 `p.write_text(`）。 */
function _sameLinePrefix(command: string, before: number): string {
	const nl = command.lastIndexOf('\n', Math.max(0, before - 1));
	return command.slice(nl < 0 ? 0 : nl + 1, before);
}

/**
 * 检测脚本 / 命令是否会**直接写工作区源码文件**（绕过 patch / file_write 的
 * checkpoint 与审批）。
 *
 * 判据（两个必要条件，缺一即放行）：
 *  1. 命中 {@link SCRIPT_WRITE_PATTERNS} 中的写文件形态；
 *  2. 该形态的**目标区**指向源码文件 —— 直接路径字面量，或绑定到源码路径的变量名，
 *     且不在构建产物目录内。目标区按 `scope` 精确取（调用实参 / 同行），绝不跨语句。
 *
 * `open()` 额外要求 mode 为写模式：只读打开源码（分析、统计、生成报告）必须放行。
 *
 * @returns 命中的写形态与目标；未命中返回 undefined。
 */
export function detectScriptSourceWrite(command: string): IScriptSourceWriteHit | undefined {
	if (!command) { return undefined; }
	const sourceVars = _collectSourcePathVariables(command);
	for (const wp of SCRIPT_WRITE_PATTERNS) {
		// 每次使用新建正则：模式表是模块级常量，带 g 标志的 lastIndex 会跨调用残留
		const re = new RegExp(wp.pattern.source, wp.pattern.flags);
		let m: RegExpExecArray | null;
		while ((m = re.exec(command)) !== null) {
			const matchEnd = m.index + m[0].length;
			let segment: string;
			if (wp.scope === 'call') {
				// 实参 + 同行前缀：后者用于成员调用的接收者（`target.write_text(...)`
				// 的路径变量在 `.` 左边，只看实参必然漏判）
				segment = _sameLinePrefix(command, m.index) + '\u0000' + _callArguments(command, m.index);
			} else {
				segment = _restOfLine(command, m.index);
			}
			if (wp.id === 'py-open-write' && !_isPythonWriteMode(segment)) {
				if (re.lastIndex <= m.index) { re.lastIndex = m.index + 1; }
				continue;
			}
			const target = _findSourceTargetInSegment(segment, sourceVars);
			if (target) { return { api: wp.label, target }; }
			if (re.lastIndex <= m.index) { re.lastIndex = matchEnd > m.index ? matchEnd : m.index + 1; }
		}
	}
	return undefined;
}

/**
 * 源码写入护栏的错误消息。
 *
 * 必须同时做到：说清**为什么**被拦（否则模型会换个写法再试一次），并给出**可直接
 * 执行的替代动作**（patch / file_write），以及一条真实的逃生舱（写产物目录）。
 */
export function scriptSourceWriteGuardMessage(hit: IScriptSourceWriteHit, toolName: string): string {
	return (
		`${toolName}: blocked — this command writes source code directly (${hit.api}, target: ${hit.target}).\n` +
		`Shell-based edits bypass the editing safeguards: no checkpoint is captured (so the change CANNOT be ` +
		`rolled back), no edit approval is requested, and the change is not reviewable as a diff.\n` +
		`Use the file editing tools instead:\n` +
		`  • patch      — replace an exact block (read the file first, copy "search" verbatim; line endings are handled automatically)\n` +
		`  • file_write — only when creating a new file or rewriting one in full\n` +
		`If patch keeps failing with "search text not found", re-read the exact region with file_read and copy ` +
		`the search text from that output — do NOT fall back to a hand-rolled read/splice/write script.\n` +
		`(Writing generated artifacts under out/ dist/ build/ tmp/ is still allowed.)`
	);
}

// ── Unix 管道 → PowerShell 自动改写（2026-08-20，日志 1787217670299）──────────
//
// 此前命中护栏只抛 NonRetryableToolError 附「等价写法」，指望模型自行改写重发。
// 实测无效：同一会话里模型连续 3 次（line 370 / 1023 / …）照旧发 `grep`，每次白烧
// 一轮。原因是提示给的是**模式**（`Select-String -Pattern <regex>`）而非**可执行的
// 具体命令**，模型没有把整条管道翻译过来的动力。
//
// 故改为：能安全映射的形态**直接改写并执行**；无法安全映射的（sed/awk 语义不可
// 一一对应）才保留抛错。改写结果附 `[rewrite-note]` 回传，保证对模型透明。

/** 单个管道段的改写结果。 */
interface ISegmentRewrite { text: string; note?: string }

/**
 * 把 `head`/`tail`/`grep` 管道段翻译为 PowerShell cmdlet。
 * 返回 `undefined` 表示「该段无法安全映射」，调用方须整体放弃改写。
 */
function _rewriteUnixSegment(segment: string): ISegmentRewrite | undefined {
	const trimmed = segment.trim();
	const cmdMatch = /^(head|tail|grep|sed|awk)\b\s*(.*)$/is.exec(trimmed);
	if (!cmdMatch) { return { text: trimmed }; }   // 非 Unix 段：原样保留（已 trim）
	const cmd = cmdMatch[1].toLowerCase();
	const rest = cmdMatch[2].trim();

	if (cmd === 'head' || cmd === 'tail') {
		// 支持 `head`, `head -20`, `head -n 20`；其余（`-c` 字节模式等）不映射
		const nMatch = /^(?:-n\s*)?-?(\d+)$/.exec(rest);
		const n = rest === '' ? 10 : (nMatch ? Number(nMatch[1]) : undefined);
		if (n === undefined) { return undefined; }
		const dir = cmd === 'head' ? '-First' : '-Last';
		return {
			text: `Select-Object ${dir} ${n}`,
			note: `${cmd}${rest ? ' ' + rest : ''} → Select-Object ${dir} ${n}`,
		};
	}

	// sed / awk：脚本语言，语义无法与任何单个 cmdlet 一一对应（`sed 's/x/y/'` 需要
	// 翻译成 `ForEach-Object { $_ -replace ... }` 且分隔符/标志/地址范围规则各异）。
	// 明确放弃——由调用方走抛错路径让模型自己重写。
	// ⚠ 这条 early-return 曾遗漏，导致 sed/awk 掉进下面的 grep 分支被当成
	// 「grep 's/x/y/'」改写（测试 `refuses anything it cannot map safely` 捕获）。
	if (cmd !== 'grep') { return undefined; }

	// grep：解析短选项 + 单个 pattern。多文件参数形态（`grep -r pat dir/`）交给
	// search_code，不在此映射（PowerShell 下 -Path 语义与递归行为差异过大）。
	const tokens = _splitShellTokens(rest);
	if (tokens === undefined) { return undefined; }   // 引号不闭合 → 放弃
	let caseInsensitive = false;
	let invert = false;
	let fixedString = false;
	let pattern: string | undefined;
	const extraOperands: string[] = [];
	for (const tok of tokens) {
		if (tok.startsWith('--')) { return undefined; }             // 长选项不猜
		if (tok.startsWith('-') && tok.length > 1) {
			for (const ch of tok.slice(1)) {
				if (ch === 'i') { caseInsensitive = true; }
				else if (ch === 'v') { invert = true; }
				else if (ch === 'F') { fixedString = true; }
				else if (ch === 'n' || ch === 'h' || ch === 'H') { /* Select-String 默认带行号/文件名 */ }
				else if (ch === 'E') { /* ERE ≈ .NET regex，无需处理 */ }
				else { return undefined; }                          // -r/-c/-o/-A… 语义不同
			}
			continue;
		}
		if (pattern === undefined) { pattern = tok; } else { extraOperands.push(tok); }
	}
	if (pattern === undefined || extraOperands.length > 0) { return undefined; }

	// Select-String 默认**不区分大小写**——与 grep 相反。故无 `-i` 时须显式 -CaseSensitive。
	const flags = [
		fixedString ? '-SimpleMatch' : '',
		caseInsensitive ? '' : '-CaseSensitive',
		invert ? '-NotMatch' : '',
	].filter(Boolean).join(' ');
	const cmdlet = `Select-String ${flags ? flags + ' ' : ''}-Pattern ${_toPowerShellSingleQuoted(pattern)}`;
	return {
		text: cmdlet,
		note: `grep${rest ? ' ' + rest : ''} → ${cmdlet}`,
	};
}

/**
 * 极简 shell token 切分（仅供 grep 选项解析）：按空白切，尊重成对的 `'`/`"`。
 * 引号不闭合返回 `undefined`（调用方放弃改写，宁可不改也不改错）。
 */
function _splitShellTokens(s: string): string[] | undefined {
	const out: string[] = [];
	let cur = '';
	let quote: '"' | '\'' | undefined;
	let started = false;
	for (const ch of s) {
		if (quote) {
			if (ch === quote) { quote = undefined; } else { cur += ch; }
			continue;
		}
		if (ch === '"' || ch === '\'') { quote = ch; started = true; continue; }
		if (/\s/.test(ch)) {
			if (started || cur) { out.push(cur); cur = ''; started = false; }
			continue;
		}
		cur += ch;
		started = true;
	}
	if (quote) { return undefined; }
	if (started || cur) { out.push(cur); }
	return out;
}

/** 包成 PowerShell 单引号字面量（内部单引号翻倍，无变量插值风险）。 */
function _toPowerShellSingleQuoted(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}

/**
 * 把含 Unix-only 命令的管道整体改写为 PowerShell 脚本。
 *
 * 全有或全无：任一段无法安全映射（sed / awk / grep 的 -r 等）即返回 `undefined`，
 * 由调用方沿用原有抛错路径 —— 宁可让模型重写，也不产出语义走偏的命令。
 *
 * 只处理 `|` 管道；`&&` / `;` 串联不拆（PowerShell 5 不支持 `&&`，混合改写风险高）。
 *
 * @returns `script` 为可交给 PowerShell 执行的脚本文本；`notes` 供回传给模型。
 */
export function rewriteUnixPipelineToPowerShell(
	command: string,
): { script: string; notes: string[] } | undefined {
	if (/&&|\|\||;/.test(command)) { return undefined; }
	// 管道切分需避开引号内的 `|`（如 grep 'a|b'）
	const segments = _splitTopLevelPipes(command);
	if (!segments || segments.length === 0) { return undefined; }

	const rewritten: string[] = [];
	const notes: string[] = [];
	let touched = false;
	for (const seg of segments) {
		const r = _rewriteUnixSegment(seg);
		if (!r) { return undefined; }
		if (r.note) { touched = true; notes.push(r.note); }
		rewritten.push(r.text);
	}
	if (!touched) { return undefined; }   // 没有 Unix 段可改 → 不该走到这里
	// 各段已 trim，统一用 ` | ` 连接（避免原串尾空格 + 连接符空格叠成双空格）
	return { script: rewritten.join(' | '), notes };
}

/** 按顶层 `|` 切分（忽略引号内的竖线）。引号不闭合返回 `undefined`。 */
function _splitTopLevelPipes(s: string): string[] | undefined {
	const out: string[] = [];
	let cur = '';
	let quote: '"' | '\'' | undefined;
	for (const ch of s) {
		if (quote) {
			cur += ch;
			if (ch === quote) { quote = undefined; }
			continue;
		}
		if (ch === '"' || ch === '\'') { quote = ch; cur += ch; continue; }
		if (ch === '|') { out.push(cur); cur = ''; continue; }
		cur += ch;
	}
	if (quote) { return undefined; }
	out.push(cur);
	return out;
}

/**
 * PowerShell `-EncodedCommand` 载荷：UTF-16LE + base64。
 *
 * 为什么用 EncodedCommand 而不是 `-Command "..."`：命令要先过 cmd.exe（execute_code
 * 的 `shell: true`），双引号/`|`/`^`/`%` 在 cmd 与 PowerShell 两层各有一套转义规则，
 * 拼字符串必然踩坑。EncodedCommand 的载荷是纯 base64 字母表，两层都无法干扰。
 *
 * @param toBase64 注入的 base64 编码器（浏览器层用 encodeBase64(VSBuffer)，便于单测替换）
 */
export function powerShellEncodedCommand(script: string, toBase64: (bytes: Uint8Array) => string): string {
	const bytes = new Uint8Array(script.length * 2);
	for (let i = 0; i < script.length; i++) {
		const code = script.charCodeAt(i);
		bytes[i * 2] = code & 0xff;
		bytes[i * 2 + 1] = code >>> 8;
	}
	return `powershell -NoProfile -NonInteractive -EncodedCommand ${toBase64(bytes)}`;
}

/**
 * 从技能 supportFiles 中提取脚本文件的**绝对路径**（scripts/ 目录下的可执行脚本）。
 *
 * 用户拍板（2026-08-03）：技能 CLI 一律以绝对路径呈现给模型（技能注入/read_skill），
 * 模型直接用绝对路径调用，从根上避免相对路径 + cwd 解析问题（日志 1785744765714
 * 的 exit 2：子代理 cwd 是另一个 workspace，`scripts/anysearch_cli.py` 解析失败）。
 *
 * @param skillDir 技能根目录 fsPath
 * @param supportFiles 技能支持文件相对路径清单（如 "scripts/anysearch_cli.py"）
 */
export function skillScriptAbsolutePaths(skillDir: string, supportFiles: readonly string[]): string[] {
	const sep = skillDir.includes('\\') ? '\\' : '/';
	const out: string[] = [];
	for (const f of supportFiles) {
		const rel = f.replace(/\\/g, '/');
		if (!rel.startsWith('scripts/')) { continue; }
		if (!/\.(py|js|mjs|cjs|ps1|sh)$/i.test(rel)) { continue; }
		out.push(skillDir.replace(/[\\/]+$/, '') + sep + rel.replace(/\//g, sep));
	}
	return out;
}
