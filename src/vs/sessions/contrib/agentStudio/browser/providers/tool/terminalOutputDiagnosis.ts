/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `terminal` 工具输出的噪音清理与「空产出」诊断（纯逻辑，零 VS Code 依赖，可独立单测）。
 *
 * ## 事故（2026-08-21，日志 1787324352413）
 *
 * 用户会话里 `terminal` **8 次调用全部被记为 OK，却一条命令输出都没拿到**，返回内容
 * 只有 shell 提示符 + 被截断的命令回显：
 *
 *   executeTool: "terminal" OK (4916ms) → qiuzijian@ZIJIANQIU-PC4 MINGW64 /g/...(main)
 *   $cd g:\Cu
 *
 * 累计白耗 37 秒 + 8 轮迭代。模型只能不断变换规避写法（输出重定向到 `/tmp` 再 `cat`、
 * 加 `sleep 1`、最后放弃 tsc 改用 esbuild），因为它**收到的是「成功」**，无从得知
 * 「结果其实没拿到」。
 *
 * ## 三个叠加根因
 *
 * 1. **1.5s idle 判完成对慢启动命令必然误判**：`npx tsc --noEmit` 光是 npx 解析包 +
 *    tsc 启动就要数秒，这期间 pty 一个字节都不产出 → idle 计时器到点 resolve('')
 *    → 收集窗口在命令真正开始干活之前就关了。
 *
 * 2. **★ Git Bash 提示符清理正则对真实形态完全无效**：原正则
 *    `/^[^\n]*@+[^\n]*MINGW[0-9]+[^\n]*\$\s*$/gm` 要求**同一行内**既含 `@`、`MINGW<数字>`
 *    又以 `$` 结尾。而真实 Git Bash 提示符是**两行**：
 *      第一行 `user@host MINGW64 /path(branch)`  ← 以 `)` 结尾，不匹配
 *      第二行 `$ <命令回显>`                      ← 无 `@`/`MINGW`，不匹配
 *    两行都漏 → 提示符原样进入 LLM 上下文，且让「输出是否为空」无法被判断。
 *
 * 3. **拿不到结果仍报成功**：只要 `hintedOutput` 非空就 `return`，而提示符本身就是
 *    非空字符串 → 永远走成功路径。这与此前修过的 patch「失败却记 OK」是同一类缺陷：
 *    **没有有效结果就不该表示成功。**
 *
 * 本模块负责 2 和 3 的判定逻辑（1 的等待策略在 coreTools 的执行函数里）。
 */

/** shell 噪音清理的可选上下文。 */
export interface IStripShellNoiseOptions {
	/**
	 * 本次执行的命令原文。用于剥掉 shell 的**命令回显**（pty 会把输入回显一遍）。
	 * 回显常被 pty 按宽度折行，故按「前缀片段」而非整行等值来匹配。
	 */
	readonly command?: string;
}

/** 单行是否为 shell 提示符行（PowerShell / cmd / Git Bash / POSIX）。 */
function _isPromptLine(line: string): boolean {
	const t = line.trim();
	if (!t) { return false; }
	// Git Bash 第一行：user@host MINGW64 /path(branch)   ← 原正则漏掉的形态
	if (/^\S+@\S+\s+MINGW\d*\b/i.test(t)) { return true; }
	// Git Bash / POSIX 第二行：`$` 或 `$ cmd`（回显在别处剥，这里只认裸提示符）
	if (t === '$' || t === '#' || t === '>') { return true; }
	// PowerShell：`PS G:\path>` 或 `PS>`
	if (/^PS\s*[^>]*>/.test(t)) { return true; }
	// cmd.exe：`G:\path>`
	if (/^[a-zA-Z]:\\[^>]*>/.test(t)) { return true; }
	// POSIX：user@host:~/path$
	if (/^\S+@\S+:.*[$#]$/.test(t)) { return true; }
	return false;
}

/** 归一化用于「回显比对」的文本：压缩空白、去掉 shell 续行与折行残留。 */
function _normalizeForEchoCompare(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

/** shell 登录横幅 / 版本 / 升级通知 —— 任意位置出现都是噪音。 */
function _isBannerLine(t: string): boolean {
	return /^Last login:/i.test(t)
		|| /^PowerShell\s+\d+\.\d+\.\d+/i.test(t)
		|| /^A new PowerShell stable release is available:/i.test(t)
		|| /^Upgrade now, or check out the release page at:/i.test(t)
		|| /^https:\/\/aka\.ms\/PowerShell-Release\?tag=/i.test(t)
		|| /^Copyright \(C\) Microsoft Corporation/i.test(t)
		|| /^Microsoft Windows \[Version/i.test(t);
}

/**
 * 有状态的流式 shell 噪音剥离器。
 *
 * ## 为什么必须「有状态」（2026-08-22，横向对标 Cline 与 VS Code 官方后引入）
 *
 * Cline 的 `TerminalProcess.run` 用 `didOutputNonCommand` 标志：**只在还没见到任何真实
 * 输出时**才逐行剥命令回显，一旦见到真输出就永久停止剥离。官方
 * `stripCommandEchoAndPrompt` 同理。
 *
 * 这与「一次性整体清理」有本质差别：命令回显在语义上**只可能出现在真实输出之前**，
 * 因此「见到真输出后不再剥回显」是结构性正确的。上一轮只能靠经验性收窄（单方向前缀
 * + 最小长度 3）来缓解误伤 —— 那仍然拦不住「构建日志中间原样打印了一次命令行」这类
 * 形态。有状态剥离让这类误伤**不可能发生**。
 *
 * ## 分工（两类噪音的处理方式刻意不同）
 * - **提示符行 / 登录横幅**：任意位置都剥。它们是无歧义噪音，且尾部提示符必须剥掉，
 *   否则「输出是否为空」判不出来（提示符非空 → 永远走成功路径，即本次事故根因 3）。
 * - **命令回显**：仅在 `sawRealOutput === false` 期间剥。
 */
export interface IShellNoiseStripper {
	/** 送入一段原始数据（可在任意位置截断），返回本次新产出的清理后文本。 */
	push(chunk: string): string;
	/** 冲刷尾部未以换行结尾的残留行。 */
	flush(): string;
	/** 是否已见到过命令的**真实输出**（提示符/回显/横幅都不算）。 */
	readonly sawRealOutput: boolean;
}

/** 创建有状态流式剥离器。 */
export function createShellNoiseStripper(opts: IStripShellNoiseOptions = {}): IShellNoiseStripper {
	const cmdNorm = opts.command ? _normalizeForEchoCompare(opts.command) : '';
	/** 未以 `\n` 结尾的残留（pty 常在任意字节处截断）。 */
	let pending = '';
	let sawReal = false;

	/** @returns 该行应保留则返回原行，应丢弃返回 undefined。 */
	const processLine = (line: string): string | undefined => {
		const t = line.trim();
		if (!t) { return line; }                      // 空行交给尾部压缩处理
		if (_isPromptLine(line)) { return undefined; }
		if (_isBannerLine(t)) { return undefined; }

		// 命令回显：`$ <cmd>` / `PS ...> <cmd>` / 裸 <cmd>。pty 常按终端宽度折行，
		// 故按「回显是命令的前缀」判定（日志实测回显被截断成 `$cd g:\Cu`）。
		//
		// ⚠ 只认这一个方向，且只在见到真实输出**之前**生效。早期实现还判了
		// `stripped.startsWith(cmdNorm)`（输出行以命令文本开头也算回显），被控制组
		// 抓出真误伤：`npm run compile failed with exit 1` 这种「以命令开头但更长」的
		// 真实输出会被整行清掉 → 有结果的执行被误判成空产出。
		// 最小长度 3：避免单字符输出行恰好是命令首字母而被误清。
		if (cmdNorm && !sawReal) {
			const hadShellPrefix = /^(?:\$|PS\s*[^>]*>|[a-zA-Z]:\\[^>]*>)\s*/.test(t);
			const stripped = _normalizeForEchoCompare(
				t.replace(/^\$\s*/, '').replace(/^PS\s*[^>]*>\s*/, '').replace(/^[a-zA-Z]:\\[^>]*>\s*/, ''),
			);
			if (stripped && (hadShellPrefix || stripped.length >= 3) && cmdNorm.startsWith(stripped)) {
				return undefined;
			}
		}

		sawReal = true;
		return line;
	};

	return {
		push(chunk: string): string {
			if (!chunk) { return ''; }
			pending += chunk;
			const parts = pending.split('\n');
			pending = parts.pop() ?? '';       // 最后一段可能是不完整行，留到下次
			const kept: string[] = [];
			for (const line of parts) {
				const r = processLine(line);
				if (r !== undefined) { kept.push(r); }
			}
			return kept.join('\n');
		},
		flush(): string {
			if (!pending) { return ''; }
			const r = processLine(pending);
			pending = '';
			return r ?? '';
		},
		get sawRealOutput(): boolean { return sawReal; },
	};
}

/**
 * 清理 shell 噪音：提示符行、命令回显、登录横幅、版本/升级通知。
 *
 * 一次性入口，内部走 {@link createShellNoiseStripper}（单一真源，避免流式与整体两套
 * 判据漂移）。与原先散在 `executeTerminalCommand` 里的一串 `.replace()` 相比，关键
 * 差别是**按行判定**而非依赖一条大正则 —— 提示符形态在不同 shell 下差异极大，逐行
 * 判定才能覆盖 Git Bash 的两行提示符（见模块头注释根因 2）。
 */
export function stripShellNoise(output: string, opts: IStripShellNoiseOptions = {}): string {
	if (!output) { return ''; }
	const stripper = createShellNoiseStripper(opts);
	const head = stripper.push(output);
	const tail = stripper.flush();
	const joined = tail ? (head ? `${head}\n${tail}` : tail) : head;
	return joined.replace(/\n{3,}/g, '\n\n').trim();
}

/** 空产出诊断结果。 */
export interface ITerminalOutputDiagnosis {
	/** 去掉 shell 噪音后是否**没有任何实质内容**。 */
	readonly isEmpty: boolean;
	/** 清理后的实质内容（`isEmpty` 为 true 时为空串）。 */
	readonly substantive: string;
}

/**
 * 判断 terminal 返回是否「只有提示符 / 命令回显」，即实质上没有拿到命令输出。
 */
export function diagnoseTerminalOutput(
	rawOutput: string,
	command: string,
): ITerminalOutputDiagnosis {
	const substantive = stripShellNoise(rawOutput, { command });
	return { isEmpty: substantive.length === 0, substantive };
}

/**
 * 慢启动命令形态 —— 这些命令在真正产出输出之前往往静默数秒到数十秒，
 * 1.5s idle 判定对它们必然误判。命中时执行侧应放大「首次输出等待窗口」。
 *
 * 刻意只列**确定会先静默一段**的构建/测试/安装类，不做泛化匹配。
 */
const SLOW_START_COMMAND = new RegExp(
	'\\b(?:' +
	'npx|npm|pnpm|yarn|bun|tsc|tsgo|esbuild|webpack|vite|rollup|' +
	'jest|vitest|mocha|pytest|gradle|mvn|cargo|dotnet|go\\s+(?:build|test)|make|cmake|' +
	'docker|pip|poetry|uv' +
	')\\b',
	'i',
);

/** 命令是否属于「慢启动」形态（供执行侧选择更长的首输出等待窗口）。 */
export function isSlowStartCommand(command: string): boolean {
	return !!command && SLOW_START_COMMAND.test(command);
}

/**
 * 「空产出」引导消息。
 *
 * 设计要求：必须让模型明白 ① 命令**可能已经在跑但结果没被捕获**（不要当成
 * 「命令输出为空」这一事实性结论）② 下一步该做什么。若不给②，模型会像日志里那样
 * 自创「重定向到 /tmp 再 cat」「加 sleep」等无效规避，一路白烧迭代。
 */
export function emptyTerminalOutputMessage(command: string, waitedMs: number): string {
	const slow = isSlowStartCommand(command);
	return (
		`[NO OUTPUT CAPTURED] The terminal returned only the shell prompt and the echoed command — ` +
		`no actual command output was captured after ${Math.round(waitedMs / 1000)}s.\n` +
		`This does NOT mean the command produced no output. The terminal tool runs an interactive PTY and ` +
		`treats a short silence as "command finished", so a command that stays silent while starting up ` +
		`(and then prints) can have its output missed entirely.\n` +
		(slow
			? `The command looks like a build/test/install step, which typically stays silent for several seconds before printing.\n`
			: '') +
		`Do NOT retry the same command through terminal, and do NOT try to work around this by redirecting ` +
		`output to a temp file and cat-ing it, or by adding sleep — the capture window is the problem, not the file.\n` +
		`Use execute_code instead for this command: it runs a single-shot process, waits for real completion, ` +
		`and returns stdout, stderr and the real exit code.`
	);
}
