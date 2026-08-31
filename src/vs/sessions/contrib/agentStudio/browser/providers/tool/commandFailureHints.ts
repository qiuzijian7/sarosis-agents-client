/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 命令失败提示（借鉴 Hermes-Agent `tools/terminal_hints.py`，2026-08-21）。
 *
 * 设计背景：本项目原先对失败命令只回显 `[stderr] + (exit code: N)`。模型要自己从
 * 原始 stderr 反推「该怎么办」——实测经常反推错（日志 1787292837471：Unix 命令被拒
 * 后改用 PowerShell cmdlet 裸用，又 exit 255）。
 *
 * Hermes 的做法是给**一条精准的下一步动作**，而不是诊断长文。三条原则照搬：
 *  1. **仅失败时触发**（非 0 退出码 / 启动失败）；
 *  2. **每次最多一条**（首个匹配胜出，避免提示噪音互相削弱）；
 *  3. **只说下一步做什么**，不解释原理 —— 模型需要的是可执行动作。
 *
 * 关键补充：明确区分「别重试」与「稍后重试」。工具级重试已于 2026-08-21 移除
 * （460 份日志实测 216 次重试 0 次成功），重试决策现在完全交给模型，因此**必须由
 * 提示文本告诉模型该不该重发**，否则模型只会盲目重发同一条必败命令。
 *
 * 纯字符串模块：无 I/O、无 VS Code 依赖，便于单测。
 */

/** 一条失败提示（`exitNote` 供工具回显时追加到失败体末尾）。 */
export interface ICommandFailureHint {
	/** 模式标识（日志/测试用） */
	readonly id: string;
	/** 提示正文（面向模型的下一步动作） */
	readonly text: string;
}

// ─── 退出码专项提示（Hermes `_EXIT_CODE_HINTS` 同款）────────────────────────
//
// 这些退出码有明确的 POSIX 语义，比 stderr 文本更可靠（stderr 可能为空或被本地化）。

const EXIT_CODE_HINTS: ReadonlyMap<number, string> = new Map([
	[
		126,
		'Exit 126 means the file was found but is NOT executable. ' +
		'Do not retry unchanged — either run it through its interpreter explicitly ' +
		'(python3 <script> / node <script> / bash <script>), or make it executable first (chmod +x <path>).',
	],
	[
		127,
		'Exit 127 means the command was not found. Do not retry unchanged — ' +
		'verify the executable name and that it is installed (try `which <cmd>` on POSIX / `where <cmd>` on Windows), ' +
		'or invoke it via an absolute path.',
	],
	[
		137,
		'Exit 137 means the process was killed with SIGKILL — almost always the OS out-of-memory killer. ' +
		'Retrying identically will hit the same limit: reduce the working set instead ' +
		'(process the input in chunks, narrow the file scope, or stream rather than loading everything into memory).',
	],
	[
		139,
		'Exit 139 means a segmentation fault (SIGSEGV) inside the program — not a shell mistake. ' +
		'Do not retry unchanged; check the inputs you passed, or use a different tool for the job.',
	],
	[
		124,
		'Exit 124 means the command hit the timeout. Do not simply retry the same way — ' +
		'either narrow the work so it finishes sooner, or raise the "timeout" argument (max 120s). ' +
		'For long-running processes, start them in the background instead of blocking on completion.',
	],
]);

// ─── 错误文本模式提示（Hermes 的 patterns 表）───────────────────────────────
//
// 顺序即优先级：越具体的模式越靠前，首个命中胜出。
// 每条都明确表态「别重试」或「稍后重试」——这是重试决策交给模型后的必要信息。

interface IFailurePattern {
	readonly id: string;
	readonly test: RegExp;
	readonly text: string;
	/**
	 * 可选：按命中详情生成**定制**文案（首个参数是 `test.exec()` 的结果）。
	 *
	 * 用途：把命中里抓到的具体对象（如缺失的命令名）写进提示。静态 text 只能说
	 * 「verify the executable name」，而模型需要的是「`Select-Object` 不存在」。
	 * 缺省时回落到静态 text。
	 */
	readonly render?: (match: RegExpExecArray) => string;
}

/** `command-not-found` 的兜底文案：抓不到具体命令名时使用（text 与 render 共用）。 */
const COMMAND_NOT_FOUND_GENERIC =
	'The command was not found — do not retry unchanged: verify the executable name and that it is installed ' +
	'(`which <cmd>` on POSIX / `where <cmd>` on Windows), or invoke it via an absolute path.';

const FAILURE_PATTERNS: readonly IFailurePattern[] = [
	// ── 确定性失败：明确告知「别重试」 ──
	{
		id: 'git-merge-conflict',
		test: /\b(CONFLICT \(|Automatic merge failed|fix conflicts and then commit)/i,
		text: 'Git merge conflict. Do not retry this command — resolve the conflicted files first ' +
			'(read them, patch the conflict markers, then `git add` those paths), and only then continue the merge.',
	},
	{
		id: 'git-nothing-to-commit',
		test: /\bnothing to commit, working tree clean\b/i,
		text: 'There is nothing to commit — the working tree is already clean. ' +
			'Do not retry; verify with `git status` / `git log -1` whether your change was already committed.',
	},
	{
		id: 'git-no-upstream',
		test: /\bno upstream branch|--set-upstream\b/i,
		text: 'The branch has no upstream. Retrying unchanged will keep failing — ' +
			'push with `git push -u origin <branch>` once, then plain `git push` works.',
	},
	{
		id: 'already-exists',
		test: /\b(already exists|File exists|EEXIST)\b/i,
		text: 'The target already exists — retrying unchanged will keep failing. ' +
			'Either read/patch the existing item, or pick a different name/path.',
	},
	{
		id: 'no-such-file',
		// 注意：中文措辞不能套 \b —— 中文字符不是 word char，`路径。` 两侧均非 word，
		// \b 不成立会导致整条正则对中文 shell 输出失效（2026-08-21 单测捕获）。
		test: /\b(?:No such file or directory|ENOENT|cannot find the path)\b|系统找不到指定的(?:路径|文件)|找不到文件/i,
		text: 'A path in the command does not exist — retrying unchanged will keep failing. ' +
			'Do not guess paths: use search_files to get the real absolute path, then reissue with that exact path.',
	},
	{
		id: 'permission-denied',
		test: /\b(?:Permission denied|EACCES|Access is denied)\b|拒绝访问/i,
		text: 'Permission denied — retrying identically will keep failing. ' +
			'Check whether the path is correct and writable; prefer writing inside the workspace, ' +
			'and do not attempt to elevate privileges.',
	},
	{
		id: 'python-no-module',
		test: /\bModuleNotFoundError: No module named\b/i,
		text: 'A Python module is missing — retrying unchanged will keep failing. ' +
			'Install it into the environment you are invoking (e.g. `python3 -m pip install <pkg>`), ' +
			'or use the project virtualenv interpreter instead of a bare `python3`.',
	},
	{
		id: 'bare-python-windows',
		test: /\bpython\b(?!3)[^\n]*?(不是内部或外部命令|is not recognized as an internal or external command)/i,
		text: 'There is no bare `python` on this system. Do not retry unchanged — ' +
			'use `python3`, or the project virtualenv interpreter, or an absolute path to python.exe.',
	},
	{
		// ★ 2026-08-30（日志 20260829T232635）：**点名**缺失的具体命令。
		//
		// `text` 与 `render` 共用同一份兜底文案：`text` 是默认值，`render` 在抓到
		// 命令名时覆盖它（抓不到时退回默认）。两者必须同一份常量，否则又会漂移。
		// 原先只有退出码表里的通用文案「verify the executable name…try `which <cmd>`」——
		// 模型得自己从 stderr 里认出是哪个命令不存在。实测事故就是 `Select-Object`：
		// 通用文案让模型多花一轮才反应过来「我写的是 PowerShell cmdlet，而这是 bash」。
		// Hermes `terminal_hints._hint_command_not_found` 同款：点名 + 给特化建议。
		//
		// 排在 bare-python-windows **之后**：`python` 缺失有更精准的特化文案
		// （直接指向 python3 / 虚拟环境），不能被通用文案抢先命中。
		//
		// ⚠ 刻意**不**在这里给「改用哪个命令」的方言建议 —— 方言由
		// environmentDirective（描述侧）与执行前护栏（拦截侧）两处负责，这里再写一份
		// 就成了第三份、必然与另两份漂移（本项目已多次踩此坑）。点名即止。
		id: 'command-not-found',
		text: COMMAND_NOT_FOUND_GENERIC,
		// 捕获组 1..6 依次对应下面六种措辞里提取到的命令名。
		// 注意：中文措辞两侧非 word char，`\b` 对中文不成立（见 no-such-file 的注释）。
		//
		// ⚠ 分支 1 末尾的 `(?!\s*:)` 是**测试逼出来的**：zsh 的语序相反，报的是
		// `zsh: command not found: rg`。若不加该断言，分支 1 会在位置 0 把 **shell 名
		// `zsh`** 当成缺失的命令（"There is no `zsh` in this shell"）—— 而正则一旦在
		// 某位置分支成功就不再后移，调到分支 2 也无用。断言使分支 1 在 zsh 形态下
		// 失败、引擎后移到 `command not found: rg` 处命中分支 2。
		test: /([\w][\w.+-]*):\s*command not found(?!\s*:)|command not found:\s*([\w][\w.+-]*)|([\w][\w.+-]*):\s*not found|The term '([\w][\w.+-]*)' is not recognized|'([\w][\w.+-]*)' is not recognized as an internal|'([\w][\w.+-]*)'[^'\n]{0,24}?不是内部或外部命令/i,
		render: (m) => {
			const cmd = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6];
			if (!cmd) { return COMMAND_NOT_FOUND_GENERIC; }
			return `There is no \`${cmd}\` in this shell — do not retry unchanged. ` +
				`Verify the name and that it is installed (\`which ${cmd}\` on POSIX / \`where ${cmd}\` on Windows), ` +
				`or invoke it via an absolute path.`;
		},
	},
	{
		id: 'npm-missing-script',
		test: /\b(Missing script:|npm ERR! missing script)\b/i,
		text: 'That npm script does not exist — retrying unchanged will keep failing. ' +
			'Read package.json "scripts" first (file_read), then run one of the scripts that is actually defined.',
	},
	{
		id: 'port-in-use',
		test: /\b(EADDRINUSE|address already in use)\b/i,
		text: 'The port is already in use — retrying immediately will keep failing. ' +
			'Either target a different port, or find and stop the process holding it.',
	},

	// ── 瞬时失败：明确告知「稍后重试」（这类才值得重发）──
	{
		id: 'rate-limited',
		test: /\b(rate limit|429 Too Many Requests|API rate limit exceeded)\b/i,
		text: 'Rate limited — immediate retries will keep failing. ' +
			'Continue with other work first and retry this operation later.',
	},
	{
		id: 'network-transient',
		test: /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|Temporary failure in name resolution|EAI_AGAIN|network is unreachable)\b/i,
		text: 'This looks like a transient network failure. Retrying once is reasonable; ' +
			'if it fails again, proceed without this step and report it as unverified rather than looping.',
	},
	{
		id: 'resource-busy',
		test: /\b(EBUSY|resource busy or locked|being used by another process)\b/i,
		text: 'The file/resource is temporarily locked by another process. ' +
			'A single retry may succeed; if it does not, work on a different file instead of looping.',
	},
];

/**
 * 为一次失败的命令执行生成**至多一条**下一步提示。
 *
 * 优先级：错误文本模式（更具体，含中英文本地化措辞） > 退出码专项。
 * 都不命中返回 undefined —— 宁缺毋滥，不产出泛泛而谈的提示。
 *
 * @param exitCode 进程退出码（未知传 undefined）
 * @param output   stdout + stderr 合并文本
 */
export function annotateCommandFailure(
	exitCode: number | undefined,
	output: string,
): ICommandFailureHint | undefined {
	const text = output ?? '';
	if (text) {
		for (const p of FAILURE_PATTERNS) {
			const m = p.test.exec(text);
			if (m) { return { id: p.id, text: p.render ? p.render(m) : p.text }; }
		}
	}
	if (typeof exitCode === 'number') {
		const hint = EXIT_CODE_HINTS.get(exitCode);
		if (hint) { return { id: `exit-${exitCode}`, text: hint }; }
	}
	return undefined;
}

/** 把提示渲染为追加到失败体末尾的一行（统一 `[next-step]` 前缀，便于模型识别）。 */
export function renderFailureHint(hint: ICommandFailureHint): string {
	return `[next-step] ${hint.text}`;
}

// ─── 假成功检测（exit 0 但其实失败了）──────────────────────────────────────
//
// `cargo build 2>&1 | tail -20` 的退出码是 **tail** 的、不是 cargo 的（bash 未开
// pipefail 时报管道最后一条的状态）；`cargo build || echo "BUILD FAILED"` 同理，
// 退出码是 echo 的。模型把 exit 0 当强成功信号 → 得出「构建通过」的错误结论。
//
// Hermes `terminal_hints.py` 的注释直接点名了这件事：
//   "OpenCode's answer is prompt-side only ('do NOT pipe through head/tail');
//    this adds a cheap result-side backstop for when the model pipes anyway."
// 我们此前正是「只有描述侧禁令」那一侧：description 里写了「别用 head/tail，输出
// 会自动截断并落盘」，但模型照旧管道 —— 结果侧零兜底。这条补上那一环。
//
// 刻意保守，**两个条件必须同时成立**：
//   1. 命令形态能吞掉上游状态（顶层管道进了 passthrough 消费者，或 `|| <廉价兜底>`）；
//   2. 输出里有**强失败特征**（rustc / pytest / gcc / npm / traceback 的具体形态），
//      而非泛泛的 "error" 子串。
// 搜索/只读管道（`grep ... | head`）排除：其输出本来就合法地包含 error 文本。
//
// ⚠ 只返回**建议性**提示，**绝不修改 exitCode** —— 退出码的语义由执行层负责。

/** 输出扫描上限（与 Hermes `_SCAN_CHARS` 同款）：避免超长输出上反复跑整表正则。 */
const MASKED_SCAN_CHARS = 4000;

/** 退出状态说明不了上游命令成败的管道消费者。 */
const PASSTHROUGH_CONSUMERS = '(?:tail|head|cat|tee|less|more|wc|sort|uniq)';

/** 顶层 `... | tail -20`（不是 `||`），且消费者必须是最后一段。 */
const MASKING_PIPE_RE = new RegExp(`(?<!\\|)\\|(?!\\|)\\s*${PASSTHROUGH_CONSUMERS}\\b[^|]*$`);

/** `cmd || echo ...` / `cmd || true` —— 兜底吞掉失败状态。 */
const MASKING_OR_RE = /\|\|\s*(?:echo\b|printf\b|true\b|:\s|:$)/;

/**
 * 只读 / 内容产出类管道头：其输出合法地含失败文本（搜索结果、被读的日志），
 * 上游谈不上「失败」，故排除。
 */
const READONLY_HEADS: ReadonlySet<string> = new Set([
	'grep', 'rg', 'ag', 'find', 'ls', 'cat', 'head', 'tail', 'jq', 'awk',
	'sed', 'strings', 'zcat', 'journalctl', 'dmesg', 'echo', 'printf',
]);

/**
 * 强失败特征。绑定到**具体工具**的形态，避免「正在读的日志 / diff 内容里出现了
 * error」被误判。
 *
 * ⚠ JS 正则没有 Python 的 `(?m:...)` 内联修饰符 —— 改用整条 `m` flag + `^`
 * （其余分支不含 `^`/`$`，加 `m` 无副作用）。
 */
const FAILURE_SHAPES_RE = /(?:error\[E\d+\]|error: could not compile|error: aborting due to|Traceback \(most recent call last\)|^(?:=+ )?\d+ failed|^FAILED (?:\S+::|\S+\.py)|compilation terminated\.|npm ERR!|BUILD FAILED|Build FAILED|FAILED: |^make(?:\[\d+\])?: \*\*\*)/m;

/** 取命令的首个真实 token（跳过 env 赋值与路径前缀）。 */
function firstToken(command: string): string {
	for (const tok of (command ?? '').trim().split(/\s+/)) {
		if (!tok) { continue; }
		// 跳过 `FOO=bar` 形式的 env 赋值（但不跳过 `./x` `/x` 这类路径）
		if (tok.includes('=') && !tok.startsWith('=') && !tok.startsWith('./') && !tok.startsWith('/')) { continue; }
		return tok.split('/').pop() ?? '';
	}
	return '';
}

/**
 * 检测「假成功」—— exit code 为 0，但很可能其实失败了。
 *
 * **仅在 exitCode === 0 时调用**（调用方负责门控）。
 *
 * @returns 建议性提示；无需提示时返回 undefined。**不修改任何退出码。**
 */
export function annotateMaskedSuccess(command: string, output: string): ICommandFailureHint | undefined {
	const cmd = command ?? '';
	const scan = (output ?? '').slice(0, MASKED_SCAN_CHARS);
	if (!cmd || !scan) { return undefined; }
	if (READONLY_HEADS.has(firstToken(cmd))) { return undefined; }
	if (!FAILURE_SHAPES_RE.test(scan)) { return undefined; }

	if (MASKING_PIPE_RE.test(cmd)) {
		return {
			id: 'masked-success-pipe',
			text: 'exit code 0 here is the status of the LAST pipeline command (tail/head/cat/...), ' +
				'NOT of the command before the pipe — and the output contains failure indicators. ' +
				'Treat this run as FAILED until proven otherwise: re-run it WITHOUT the pipe ' +
				'(output is auto-truncated and the full text is saved to a file, so piping through tail/head is never needed) ' +
				'to get the real exit code.',
		};
	}
	if (MASKING_OR_RE.test(cmd)) {
		return {
			id: 'masked-success-or',
			text: 'exit code 0 here is the status of the `||` fallback (echo/true), ' +
				'NOT of the command before it — and the output contains failure indicators. ' +
				'Treat this run as FAILED until proven otherwise: re-run the command bare to get its real exit code.',
		};
	}
	return undefined;
}
