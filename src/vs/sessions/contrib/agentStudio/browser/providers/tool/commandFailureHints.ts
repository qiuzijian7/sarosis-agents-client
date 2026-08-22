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
}

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
			if (p.test.test(text)) { return { id: p.id, text: p.text }; }
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
