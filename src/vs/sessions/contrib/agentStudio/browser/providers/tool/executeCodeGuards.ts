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

// ── read-state 跟踪（2026-09-07，patch 连败根因的解药）────────────────
//
// 背景（日志 1788713328385，patch "search text not found" ×5 → same-args 循环）：
// 模型 file_read 传了幻觉路径（`...agentStudio\webidx\...`，webview 的手误）→
// 读取失败 → 模型**不重读**，凭猜测的内容拼 patch.search → 连败 5 次触发循环
// 拦截。patch 的失败消息只说 "search 必须与文件完全一致"，**没有点破「你从来没
// 成功读过这个文件」**——反馈没打中要害，模型自然继续猜。
//
// 对齐 Claude Code 的 read-before-edit 纪律：file_read 的成败在此登记（进程级
// 内存，会话重启即清零——足够覆盖单次任务周期），patch 失败时查表给**针对该
// 文件的精确反馈**（从没读过 / 上次读取失败 / 上次读取已 N 秒前）。

interface IFileReadState {
	ok: boolean;
	at: number;
	note?: string;
	/** @deprecated 2026-09-12 起不再由 patch 设置（见 markFileModified）。保留字段仅为兼容既有调用方与测试。 */
	stale?: boolean;
	/**
	 * 本会话 patch 过该文件、且此后未再 file_read。
	 * 不阻止下一次 patch（P1，2026-09-12），仅用于失败时给出精准纠偏。
	 */
	patchedSinceRead?: boolean;
	/**
	 * 最近一次成功 file_read 时文件的 mtime（ms）—— P3（2026-09-12）外部修改检测的基线。
	 * 拿不到（fileService 未返回）时缺省，此时检测退化为「不判定」。
	 */
	mtime?: number;
}
const _fileReadState = new Map<string, IFileReadState>();
const _normFilePath = (p: string): string => p.replace(/\//g, '\\').trim().toLowerCase();

export function recordFileReadSuccess(path: string, mtime?: number): void {
	if (path) {
		_fileReadState.set(_normFilePath(path), {
			ok: true,
			at: Date.now(),
			// mtime 缺失（fileService 未返回 / 为 0）时不写该字段 → 检测退化为「不判定」
			...(typeof mtime === 'number' && mtime > 0 ? { mtime } : {}),
		});
	}
}

export function recordFileReadFailure(path: string, note: string): void {
	if (path) { _fileReadState.set(_normFilePath(path), { ok: false, at: Date.now(), note: note.slice(0, 160) }); }
}

/**
 * 该路径在本会话（进程生命周期）内是否被 file_read **成功**读过。
 * P3 read-before-edit 硬闸（2026-09-07，对齐 Claude Code "File has not been
 * read yet"）的查询入口：patch 前置校验，从未读过 → 硬拒。
 */
export function hasEverReadSuccessfully(path: string): boolean {
	const st = _fileReadState.get(_normFilePath(path ?? ''));
	return !!st && st.ok;
}

/**
 * P3（2026-09-12）外部修改检测 —— 对齐 Cline `FileContextTracker` 的
 * 「只在**外部**（用户/其他进程）修改时才提醒重读，自己改的不算」，
 * 以及本项目 `file_write` 既有的 `_check_file_staleness`（coreTools.ts）。
 *
 * 语义：拿「本次操作前 stat 到的 mtime」与「上次成功 file_read 时的 mtime」比较，
 * 更大 → 说明文件在模型读取之后被外部改过，模型手里的内容已过时。
 *
 * 采用 `>` 而非 `!==`：与 `file_write` 的既有判定保持一致，避免时钟回拨造成误报。
 * 任一基线缺失（从未成功读过 / mtime 取不到）→ 返回 `false`（**不判定**，
 * 宁可漏报也不误报 —— 误报会让模型做无谓的重读）。
 *
 * 注意：本函数**只提供信号**，调用方决定是提示还是拦截。当前 patch 与 file_write
 * 一样只做**提示**（inform），不阻断 —— 外部改动可能落在与 search 无关的区域，
 * 此时 patch 仍会正常命中，硬拦反而是误伤。
 */
export function detectExternalModification(path: string, currentMtime: number): boolean {
	const st = _fileReadState.get(_normFilePath(path ?? ''));
	if (!st || !st.mtime || !currentMtime) { return false; }
	return currentMtime > st.mtime;
}

/** 外部修改的提示文案（追加到 patch 成功回报或失败消息末尾）。 */
export function describeExternalModification(path: string, currentMtime: number): string {
	const st = _fileReadState.get(_normFilePath(path ?? ''));
	const ago = st ? Math.max(1, Math.round((currentMtime - st.mtime!) / 1000)) : 0;
	return `\n⚠ EXTERNAL CHANGE: ${path} was modified OUTSIDE this session (by the user or another process) ` +
		`about ${ago}s after you last read it. The content you are working from may be outdated. ` +
		`Call file_read again before further edits to this file.`;
}

/**
 * 本会话 patch 过该文件 —— **不再**把 read-state 置为 stale（2026-09-12，P0+P1）。
 *
 * 历史（P3 二期，2026-09-07，日志 1788757547227 实证）：patch 成功后置 stale，
 * 强制下次 patch 前重读。它治好了「第二个 patch 的 search 基于改动前内容 →
 * not_found」，代价是**同一文件连续 patch 必须反复重读整个文件**（可感知的浪费）。
 *
 * 现在改为与 `file_write` 一致的语义：**patch 成功 = 内容已知 = 视为已读**。
 * 依据：
 *   ① patch 的返回值现在回传「改动区域上下文」（patchMatcher.buildEditedRegionContext），
 *      模型手里已是最新文本，可据其续写下一次 patch；
 *   ② 即便模型的 search 真的过时，`computePatch` 会以 `not_found` 失败，并由
 *      `describeReadGap` 给出「你 patch 过但未重读」的精准纠偏 —— 该问题只会在
 *      失败时才暴露，用**前置强制读**去防它属于过度代价（对齐 Cline
 *      FileContextTracker：「We do NOT want Cline to reload the context every time
 *      a file is modified」，且 Cline 自己编辑后 `cline_read_date` 会一并刷新）。
 *
 * 仅登记 `patchedSinceRead` 供失败路径使用，**不阻断**下一次 patch。
 */
export function markFileModified(path: string): void {
	if (path) {
		const key = _normFilePath(path);
		const prev = _fileReadState.get(key);
		_fileReadState.set(key, {
			ok: true,
			// 保留原读取时间：patch 并未让模型重新「读」文件，只是让它掌握了改动后的区域
			at: prev?.at ?? Date.now(),
			patchedSinceRead: true,
		});
	}
}

/**
 * patch "search text not found" 时的关联反馈。
 *
 * @returns 追加到错误消息末尾的文案；空串 = 状态健康（最近读过且无异常），
 *          此时维持原「空白/缩进必须精确」的提示即可。
 */
export function describeReadGap(path: string): string {
	const st = _fileReadState.get(_normFilePath(path ?? ''));
	if (!st) {
		return '\n⚠ READ-STATE: You have NEVER successfully read this file with file_read in this session. '
			+ 'The "search" text you sent was GUESSED, not copied from real content — that is why it can never match. '
			+ 'Call file_read on the exact absolute path FIRST, then copy the search block verbatim from its output.';
	}
	// P0+P1（2026-09-12）：patch 过但未重读 —— 不再是「硬拒」的前置条件，而是失败时
	// 的定向纠偏：告诉模型「过时的是你改过的那片区域」，并指出可复用上次回传的
	// Updated region，避免它误以为必须整文件重读。
	if (st.patchedSinceRead) {
		return '\n⚠ READ-STATE: you patched this file earlier in this session and have NOT re-read it since. '
			+ 'If your "search" block overlaps a region you already changed, it no longer matches the file. '
			+ 'Re-read with file_read (or reuse the "Updated region" text returned by your previous patch) and retry.';
	}
	if (!st.ok && st.stale) {
		return '\n⚠ READ-STATE: you modified this file earlier in this session, so the content you hold is now OUTDATED. '
			+ 'Re-read it with file_read and copy the search block from the fresh output.';
	}
	if (!st.ok) {
		return `\n⚠ READ-STATE: your most recent file_read on this path FAILED (${st.note}). `
			+ 'The "search" text you sent was guessed from stale context — it can never match. '
			+ 'Call file_read with the correct absolute path first, then copy the search block verbatim from its output.';
	}
	const agoSec = Math.max(1, Math.round((Date.now() - st.at) / 1000));
	return `\n⚠ READ-STATE: last successful file_read was ${agoSec}s ago — the file may have changed since `
		+ '(parallel edits / your own earlier patch). Re-read the target region with file_read, then reissue patch.';
}

// ── 检索类「良性非零退出码」（2026-09-09，日志：exit 123 假失败）────────────
//
// 事故：`grep -n pat file | head -45 ; find . -name "*.css" | xargs grep -ln pat`
// 输出**完全成功**（前段命中 45 行、后段列出 2 个命中文件），却被判 FAILED：
//   · `grep` 无匹配 = **exit 1**（POSIX 明确规定：0=有匹配 / 1=无匹配 / 2=错误）；
//   · `xargs` 在被调用命令返回 1-125 时自己返回 **exit 123**。
// find|xargs grep 场景下必然有部分批次无匹配 → grep 1 → xargs 123，**这是检索
// 命令的正常语义，不是失败**。旧实现对所有非零 exit 一律抛错（compatibilityTools
// 的 `throw new Error(execute_code failed (exit N))`）→ 模型拿到有效输出的同时被
// 告知「失败」，典型反应是换写法重跑一遍（纯浪费）；更糟的是它可能不信任已拿到
// 的正确结果。
//
// 判定刻意**保守**（宁可漏判也不误判真失败）：
//   · exit 123 —— xargs 专属码，语义唯一，语句里出现 xargs 即可判定；
//   · exit 1  —— 歧义大（无数真失败也是 1），故三重约束：决定退出码的**末段管道**
//     必须是纯检索命令、**stderr 为空**（grep 的真错误是 exit 2 且带 stderr）。

/** 末段管道为「无匹配即 exit 1」的检索命令。 */
const SEARCH_CMD_HEAD = /^(?:grep|egrep|fgrep|zgrep|rg|ag|ack|findstr|select-string)\b/i;

/**
 * 判定非零退出码是否属于「检索命令的正常无匹配语义」。
 *
 * @returns 附加给模型的说明文案；`undefined` = 不是良性退出，按失败处理。
 */
export function detectBenignSearchExit(command: string, exitCode: number, stderr: string): string | undefined {
	if (!command || (exitCode !== 1 && exitCode !== 123)) { return undefined; }
	// 决定整体退出码的是**最后一条语句**（`;` / `&&` / `||` 之后），其中又是**最后
	// 一个管道段**（bash 默认未开 pipefail）。
	const lastStatement = command.split(/;|&&|\|\|/).pop() ?? '';
	const lastPipeSeg = (lastStatement.split('|').pop() ?? '').trim();

	if (exitCode === 123 && /\bxargs\b/.test(lastStatement)) {
		return '[exit-note] exit 123 is xargs\' way of reporting "a command I invoked returned 1-125". '
			+ 'With `xargs grep`, any batch without a match makes grep exit 1 — so 123 here means '
			+ '"some batches had no match", NOT a failure. The output above is complete and valid; '
			+ 'do not re-run the command.';
	}

	if (exitCode === 1 && SEARCH_CMD_HEAD.test(lastPipeSeg) && !stderr.trim()) {
		return '[exit-note] exit 1 from a search command means "no match found" (POSIX: 0=match, '
			+ '1=no match, 2=error) — it is NOT an execution failure. Treat the output above as '
			+ 'authoritative: the pattern simply is not present in the searched scope. '
			+ 'Do not re-run the same search expecting a different result.';
	}

	return undefined;
}

// ── 超时引导（P0+P3，2026-09-12，日志实证 start 超时后继续绕路）──────────────
//
// 事故：`execute_code: start "" "docs/kb-mockups/index.html"` 超时被杀，模型收到的
// 只有 `[timeout: process tree killed after 20s]` 这一句**纯技术信息** —— 没有
// 「这不是失败、是超时」的定性，也没有「长任务该用 background:true」的出路，
// 于是模型换着写法继续重试同一件事，白烧轮次（同日日志里 `start` 与
// `cmd //c start` 各失败一次）。
//
// 对比开源实现（2026-09-12 调研）：MiMo 的 bash 默认超时 2min（可配）且提示
// 可用参数；本项目默认 30s 且超时后零引导。故这里补的不是「调大默认值」，
// 而是**把已有能力（background:true / timeout 参数）在失败点上讲清楚** ——
// 让正确行为变容易，而不是替模型做决定。

/**
 * 长任务形态识别（P3）—— 超时时用于给出**针对该命令**的建议。
 *
 * 判据刻意保守：只认**几乎必然超过默认超时**的形态（安装 / 构建 / 测试 / 服务器 /
 * 监听 / 打开外部程序），避免把普通命令误报成「长任务」而误导模型改用后台。
 *
 * @returns 命中的形态标签（用于回报），未命中返回 `undefined`。
 */
export function detectLongRunningCommand(command: string): string | undefined {
	// 只看第一条语句（`;` / `&&` / `||` / `|` 之前）—— 决定整体耗时的是它
	const head = (command.split(/[|;]|&&|\|\|/)[0] ?? '').trim().toLowerCase();
	if (!head) { return undefined; }

	// 包管理器 / 构建器 + 长动词：npm install / pnpm i / cargo build / docker compose up
	const pkgVerb = /^(?:npm|pnpm|yarn|bun|npx|pip|pip3|poetry|uv|cargo|go|mvn|mvnw|gradle|gradlew|dotnet|composer|bundle|gem|mix|swift|flutter|pod|docker(?:\s+compose)?)\s+(install|i|ci|add|update|upgrade|build|test|run|start|serve|dev|watch|up|pull|deploy|publish|create|generate|init|new)\b/.exec(head);
	if (pkgVerb) { return pkgVerb[0]; }

	// 裸构建 / 测试 / 服务命令
	const bare = /^(make|cmake|ninja|tsc|vite|webpack|rollup|esbuild|swc|parcel|turbo|nx|jest|vitest|pytest|tox|mocha|playwright|cypress|serve|http-server|nodemon|next|nuxt|astro|uvicorn|gunicorn|flask|django-admin|rails|sbt|bazel|buck|terraform|ansible|helm|kubectl)\b/.exec(head);
	if (bare) { return bare[1]; }

	// 监听模式（即便动词不在上表里，watch 也几乎必然长驻）
	if (/\s--?w(?:atch)?\b/.test(head)) { return 'watch mode'; }

	// 打开外部程序：不阻塞返回，必然吃满超时（日志里 start 的根因）
	if (/^(?:start|open|xdg-open|explorer|code)\b/.test(head) ||
		/^cmd\s+(?:\/\/c|\/c)\s+start\b/.test(head) ||
		/^powershell(?:\.exe)?\s+.*\bstart-process\b/.test(head)) {
		return 'opening an external app';
	}
	return undefined;
}

/**
 * 从 stderr 里提取实际超时秒数。
 *
 * 主进程（app.ts）与 renderer 侧 fallback 都会写入
 * `[timeout: process tree killed after Ns]` / `[timeout: process killed after Ns]`，
 * 本函数是该文案的**唯一解析入口**（文案改动时只需同步这里）。
 */
export function parseTimeoutSecondsFromStderr(stderr: string): number | undefined {
	const m = /\[timeout:[^\]]*?after (\d+)s\]/.exec(stderr);
	return m ? Number(m[1]) : undefined;
}

/**
 * 超时引导（P0）—— 追加在超时失败消息末尾。
 *
 * 只做两件事：① 点破「这不是命令失败，而是被超时杀掉」（输出可能不完整）；
 * ② 给出**可直接执行**的两条出路（`background:true` / 提高 `timeout`），
 * 并明确劝阻「原样重发」（必然再超时）。
 *
 * @param timeoutSec 实际超时秒数（来自 `parseTimeoutSecondsFromStderr`）。
 * @param command    模型传入的原始命令（用于形态识别）。
 */
export function timeoutGuidanceMessage(timeoutSec: number, command: string): string {
	const shape = detectLongRunningCommand(command);
	return (
		`\n\n⚠ TIMEOUT — this command did NOT finish within ${timeoutSec}s and was killed, so the output ` +
		`above may be incomplete (a killed command reports exit -1).\n` +
		(shape ? `Detected long-running shape: \`${shape}\`. ` : '') +
		`If it is expected to take longer, re-run it with ONE of:\n` +
		`  • background:true — returns immediately with a taskId; then ` +
		`execute_code({ action:"poll", taskId }) to read its output, or action:"kill" to stop it. ` +
		`Best for installs / builds / test suites / servers / watchers.\n` +
		`  • a larger "timeout" (in seconds) — e.g. timeout: 300; pass 0 for no limit at all.\n` +
		`Do NOT re-send the same command unchanged — it will time out again.`
	);
}

/**
 * 「手工重造媒体管线」劝导（2026-09-25，生产日志 20260925T023847）。
 *
 * 事故形态：模型因同会话前几轮 video_analyze/extract_video_frames 的失败经验（60s 超时
 * 误杀 / ffmpeg 探测在启动高峰被抖动误判），转而**全程手工 execute_code**：yt-dlp 下载 +
 * ffmpeg for 循环抽帧（两次 exit 127）+ 逐张 vision_analyze —— 完全绕开了 video_analyze
 * 内置的 ASR（whisper 转写）。而能力是健康的（capability facts: ffmpeg=true）——是
 * "工具信任被毒化 + 不知道有 ASR"，不是能力缺失。
 *
 * 这是**成功侧的劝导**（命令已经跑成了，只是做法绕远）：追加一行提示，不阻断、不改退出码。
 * 只匹配"干活"形态（抽帧/转写/下载视频），不匹配诊断形态（`-version`/`ffprobe` 探测是合法的）。
 */
export function manualMediaToolchainNudge(command: string): string | undefined {
	const cmd = command ?? '';
	if (!cmd.trim()) { return undefined; }
	const didFrames = /\bffmpeg[\w.-]*(?:\.exe)?\b/i.test(cmd) && (/fps=/i.test(cmd) || /frame-\d*%?0?\d*d/i.test(cmd) || /-frames:v/i.test(cmd));
	const didAsr = /\bwhisper-cli(?:\.exe)?\b/i.test(cmd);
	const didDownload = /\byt-dlp(?:\.exe)?\b/i.test(cmd) && /"-o"| -o "/.test(cmd) && /https?:\/\//i.test(cmd);
	if (!didFrames && !didAsr && !didDownload) { return undefined; }
	return '[note] This re-implements what built-in tools already do in ONE call: `video_analyze` downloads the video, ' +
		'extracts frames, transcribes speech with local ASR (whisper), and analyzes with a vision model; ' +
		'`extract_video_frames` covers plain frame extraction. Earlier failures of these tools in this conversation may have been ' +
		'transient (capability probes re-run automatically) — prefer the built-in tools over hand-written ffmpeg/whisper loops.';
}

/** Unix-only 命令 → PowerShell 等价写法（用于护栏错误消息）。 */
export const UNIX_ONLY_COMMAND_HINTS: Record<string, string> = {
	head: 'Select-Object -First <N>',
	tail: 'Select-Object -Last <N>',
	grep: 'Select-String -Pattern <regex>',
	sed: "ForEach-Object { $_ -replace '<old>','<new>' }",
	awk: 'ForEach-Object with -split',
};

/**
 * 2026-09-06：Git Bash 缺失时的一次性安装引导（附在 Unix-only 护栏报错末尾）。
 *
 * 把「降级提示」升级为「升级引导」：护栏报错只教模型换 PowerShell 写法，但
 * POSIX 能力缺失的根因是环境——模型把这句转述给用户，用户装一次 Git for
 * Windows 后本护栏即不再触发。放 executeCodeGuards（判据所在模块）保证
 * 两处护栏（execute_code / terminal）引用同一份文案。
 */
export const GIT_BASH_INSTALL_GUIDANCE =
	'Note: installing Git for Windows (https://git-scm.com/downloads/win) would make POSIX commands (grep/head/sed/awk) work natively in execute_code/terminal — this guard would stop firing.';

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

/**
 * 「下划线前缀」产物路径（2026-09-13；同日修订为**任意深度**）。
 *
 * ## 由来
 * 本项目约定：临时 / mockup / 渲染产物以 `_` 开头命名 —— 仓库根实测 10+ 个
 * （`_askuser_editor_mockup.html`、`_delegate_card_mockup.html`、`_flow_ports_mockup.html` …）。
 * 而 {@link GENERATED_PATH_MARKER} 只认 `out/ dist/ build/ tmp/` 这类**目录**，与项目
 * 实际约定不匹配 → 模型按习惯写 `_render.url.json` / `_*.html` **每次都被拦**，只能改用
 * `file_write` 逐个创建（生成多个 mockup 时摩擦显著）。
 *
 * ## 为什么放到「任意深度」
 * 首版把放行面限定在「工作区根（路径中不含分隔符）」，理由是 `_` 前缀并非产物专属
 * （`src/_internal.ts` 也以下划线开头）。但**项目自己的 .gitignore 已经把口径定死了**：
 *
 *     # Scratch / temporary working files (underscore-prefixed = throwaway debug scripts)
 *     _*.ps1  _*.py  _*.js  _*.cjs  _*.mjs  _*.ts        ← .gitignore:151-157
 *
 * 这些模式**没有前导斜杠 → 在任意深度生效**（gitignore 语义）。实测：
 *     git check-ignore --no-index src/_internal.ts     → .gitignore:156:_*.ts
 *     git check-ignore --no-index docs/deep/_draft.ts  → .gitignore:156:_*.ts
 *     git check-ignore --no-index src/vs/_scratch.js   → .gitignore:153:_*.js
 *     git check-ignore --no-index src/internal.ts      → （不忽略）
 * 即「`_` 前缀 = throwaway，不是源码」在**任意深度**都是本项目的成文约定。护栏若只认
 * 工作区根，就与仓库自己的口径矛盾 —— 模型按约定命名（`docs/_draft.md`、`src/_scratch.ts`）
 * 仍被拦，摩擦无解。
 *
 * ## 判定：路径中**任一段**以 `_` 开头即视为产物
 *   · `_render.url.json`        → 放行
 *   · `docs/_draft.md`          → 放行
 *   · `_kb-mockups/a.html`      → 放行（目录段带 `_`）
 *   · `src/_internal.ts`        → 放行（与 .gitignore 同口径）
 *   · `my_file.ts` / `a/b_c.ts` → 不受影响（`_` 不在段首）
 *   · `docs/kb-mockups/a.html`  → **仍拦**（路径中无 `_` 前缀段，不属该约定）
 *
 * ⚠ 本例外只放宽「目标是否产物」，其余判据（写形态命中 / 源码扩展名 / fail-closed）不变。
 */
const UNDERSCORE_ARTIFACT_RE = /(?:^|[\\/])_[^\\/]/;

/**
 * 「mockup」原型目录（2026-09-13）—— 目录段名 = `mockup`/`mockups`，或以 `-mockup(s)` 结尾。
 *
 * ## 由来
 * 模型按项目习惯把原型 HTML 写进 `docs/kb-mockups/*.html`，但 `docs/` 不在
 * {@link GENERATED_PATH_MARKER} 的目录名单里 → 被拦，只能逐个 `file_write`。
 *
 * 仓库实测这类目录共 4 个，**内容全是可弃原型产物、无源码**：
 *   · `doc/layout-mockup/`                                       1 html + 1 md
 *   · `docs/design-mockups/`                                     4 html
 *   · `docs/kb-mockups/`                                         8 html + 1 css + README
 *   · `src/vs/sessions/contrib/agentStudio/test/browser/mockups/` 1 html（测试夹具）
 *
 * ## 为什么是「段名以 -mockup(s) 结尾」而非「段名含 mockup」
 * 后者会放行 `src/mockupRenderer/` 这类**真源码目录**（mockup 只是定语），也会放行
 * `mockup-utils/` 这类前缀式命名。前者覆盖全部实测目录，又不越界 —— 判据收紧到
 * 「整段就是 `mockup(s)`，或它的后缀恰好是 `-mockup(s)`」。
 *
 * ⚠ 与 {@link UNDERSCORE_ARTIFACT_RE} 同属「目标是否产物」的放宽，其余判据不变。
 */
const MOCKUP_DIR_MARKER = /(?:^|[\\/])(?:[^\\/]*-)?mockups?[\\/]/i;

/**
 * 目标路径是否属于「允许脚本写入的产物」—— 构建产物目录、`mockup` 原型目录，
 * 或带 `_` 前缀段的产物路径。
 *
 * 单一判定入口：`_collectSourcePathVariables` 与 `_findSourceTargetInSegment` 必须
 * 同源调用，否则「变量绑定」与「字面量」两条路径的放行面会漂移。
 *
 * ## `cwd` 参与判定（2026-09-13 补完「已知限制」）
 *
 * 三条豁免规则**都要求路径里含目录段**（`out/` `dist/` …、`mockup(s)/`、`_` 前缀段），
 * 而**裸文件名**（如 `admin.html`）一个都不匹配 → 一律按「非产物」处理。
 *
 * 后果（实测日志 `vscode-app-1789281483413` 与本次日志）：模型在 `docs/kb-mockups/` 下
 * 生成 mockup，命令写成 `cwd: "docs/kb-mockups"` + `> admin.html` —— 目标**其实是产物**
 * （`docs/kb-mockups/` 正是豁免目录），却仍被拦，只能逐个 `file_write`。
 *
 * 现把两个 shell 工具的 `cwd` 参数透传进来：目标为**相对路径**时，用
 * `cwd + '/' + target` 判定。`cwd` 是**真实生效**的运行目录（shell 确实在那里执行），
 * 故拼接结果就是文件的真实落点 —— 模型无法靠伪造 `cwd` 去够到目录外的源码：
 * 它给什么 `cwd`，文件就真的落在那里。
 *
 * ## 三个必须做对的细节
 *
 * 1. **只在目标相对时拼接** —— 绝对路径（`/x`、`C:\x`）与 `~` 开头不受 `cwd` 影响；
 * 2. **拼接后必须归一化**（折叠 `.` / `..`）—— 否则 `cwd: "out"` + `> ../../src/app.ts`
 *    会因字符串前缀含 `out/` 而被误判为产物，而**真实落点是 `src/app.ts`**。
 *    `..` 穿透是「用 `cwd` 伪装成产物」的唯一入口，必须堵住（`_normalizeArtifactPath`）；
 * 3. **仍保留原有「路径自带目录段」判定** —— 写全路径（`docs/kb-mockups/a.html`）时
 *    不依赖 `cwd`，与改动前完全一致。
 *
 * ⚠ 残留（fail-closed，有意保留）：**没有 `cwd` 时**裸文件名仍按源码处理 ——
 * 裸名无法判定落在哪个目录，宁可按源码拦下，由拒绝文案引导补 `cwd` 或写全路径。
 * （两个工具都接受 `cwd`，故这条残留只在调用方未传时出现。）
 */
function isAllowedArtifactTarget(filePath: string, cwd?: string): boolean {
	if (_matchesArtifactPath(filePath)) { return true; }
	// 目标不是相对路径（绝对 / `~`）→ `cwd` 对它无影响
	if (!cwd || !_isCwdRelative(filePath)) { return false; }
	return _matchesArtifactPath(_normalizeArtifactPath(`${cwd}/${filePath}`));
}

/** 三条豁免规则本体（对「已归一化」的路径求值）。 */
function _matchesArtifactPath(p: string): boolean {
	return GENERATED_PATH_MARKER.test(p)
		|| MOCKUP_DIR_MARKER.test(p)
		|| UNDERSCORE_ARTIFACT_RE.test(p);
}

/** 该路径是否**相对 cwd** —— 只有相对的才需要拼 `cwd`。 */
function _isCwdRelative(p: string): boolean {
	if (!p) { return false; }
	if (/^[\\/]/.test(p)) { return false; }            // /abs、\abs
	if (/^[A-Za-z]:[\\/]/.test(p)) { return false; }   // C:\ / C:/
	if (p.startsWith('~')) { return false; }           // ~/… 由 shell 展开，与 cwd 无关
	return true;
}

/**
 * 归一化「cwd + 相对目标」：统一分隔符 + 折叠 `.` / `..`。
 *
 * 刻意**不引 `path` 模块** —— 本模块头注释承诺「无 VS Code 依赖，可独立单测」，
 * 且这段纯字符串逻辑（约 10 行）足够简单到可被直接审查。
 * 结果只用于**正则匹配**（不用于真实路径解析），故丢掉前导 `/` 无影响。
 */
function _normalizeArtifactPath(p: string): string {
	const out: string[] = [];
	for (const seg of p.replace(/\\/g, '/').split('/')) {
		if (!seg || seg === '.') { continue; }
		// `..` 能弹掉上一段就弹；弹不掉（已在最前）则保留 —— 保留即「不像产物」，fail-closed
		if (seg === '..' && out.length > 0 && out[out.length - 1] !== '..') {
			out.pop();
			continue;
		}
		out.push(seg);
	}
	return out.join('/');
}

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

	// ── P1（2026-09-13）：补齐「就地编辑 / 下载落盘 / 原地清空」类写形态 ──────
	// 起因：2026-09-13 与 Cline 的 plan-mode command-guard（`command-guard.ts`）对照，
	// 发现本表只覆盖 8 种写形态，而 Cline 另外还拦 `sed -i` / `perl -i` / `awk inplace`
	// / `sort -o` / `curl -o` / `wget` / `tee` / `truncate` 等。这里补齐**写/覆写**类。
	//
	// ★ 三条**刻意不加**（属另一档改动 —— 需要「取末参数」语义或 AST）：
	//   · `cp` / `mv` / `install`：目标是**最后一个参数**，而本表的
	//     `_findSourceTargetInSegment` 取**首个**源码扩展名字面量 → 会把高频合法形态
	//     `cp src/a.ts dist/`（把源码拷进产物目录）误判成写源码。
	//   · `dd of=<file>`：`dd if=src/a.ts of=/dev/null`（读源码并丢弃）会让「首个字面量」
	//     命中**输入**而非 `of=` 目标 → 与上同类的误伤。写块设备那条已由 HARDLINE 兜底。
	//   · `find -delete`：属**删除**族（P2「删除类强制确认」的范围），不是「写源码」；
	//     放进本表会让错误文案（"writes source code directly"）失真。
	//
	// 每条都要求**命令起始位置**（`^` / `|` / `;` / `&` 之后）—— 与 detectUnixOnlyCommand
	// 同一惯用法，避免 `--sort=date`、`"-i"` 这类**同名文本**被误认成命令。
	{
		// tee / tee -a：参数即写入目标（`... | tee src/a.ts`）
		id: 'tee',
		pattern: /(?:^|[|;&]+)\s*tee\b(?:\s+-[a-zA-Z]+)*\s/gm,
		label: 'tee — write stdout into a file',
		scope: 'line',
	},
	{
		// truncate -s 0 file / truncate --size=0 file
		id: 'truncate',
		pattern: /(?:^|[|;&]+)\s*truncate\b[^|;&\n]*\s(?:-s|--size[= ])/gm,
		label: 'truncate -s — resize/empty a file in place',
		scope: 'line',
	},
	{
		// perl -i / -pi / -ni（就地编辑；标志可与其它字母合并，故用 [a-zA-Z]*i[a-zA-Z]*；
		// 末尾 `(?=\s|$)` 排除 `perl -e 'print "-i"'` 这类**字符串里**的同名文本）
		id: 'perl-inplace',
		pattern: /(?:^|[|;&]+)\s*perl\b[^|;&\n]*?\s-[a-zA-Z]*i[a-zA-Z]*(?=\s|$)/gm,
		label: 'perl -i — in-place stream edit',
		scope: 'line',
	},
	{
		// gawk 就地编辑：awk -i inplace / --in-place
		id: 'awk-inplace',
		pattern: /(?:^|[|;&]+)\s*awk\b[^|;&\n]*\s(?:-i\s+inplace|--in-place)\b/gm,
		label: 'awk -i inplace — in-place stream edit',
		scope: 'line',
	},
	{
		// sort -o <file>：-o 须紧跟在 sort 与若干标志之后（GNU 规范写法）——
		// 以免 `sort <source> -o <artifact>` 这种「源在前、目标在后」被误判成写源码
		id: 'sort-output',
		pattern: /(?:^|[|;&]+)\s*sort\s+(?:-[a-zA-Z]+\s+)*-o\s/gm,
		label: 'sort -o — write sorted output into a file',
		scope: 'line',
	},
	{
		// curl -o <file> / --output <file>：下载直接落盘
		id: 'curl-output',
		pattern: /(?:^|[|;&]+)\s*curl\b[^|;&\n]*\s(?:-o|--output)\s/gm,
		label: 'curl -o — download straight into a file',
		scope: 'line',
	},
	{
		// wget -O <file>（大写 O）/ --output-document[=]<file>
		id: 'wget-output',
		pattern: /(?:^|[|;&]+)\s*wget\b[^|;&\n]*\s(?:-O|--output-document[= ])/gm,
		label: 'wget -O — download straight into a file',
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
 * 从「赋值右值」尽力还原出一个字面量路径（2026-09-13 扩展）。
 *
 * 原实现只认**单个**字面量（`p = "src/a.ts"`），于是这些**自然写法**全被漏掉：
 *   · `p = path.join("src", "a.ts")`     —— Node 最常见
 *   · `p = os.path.join("src", "a.ts")`  —— Python 最常见
 *   · `p = "src/" + "a.ts"`              —— 拼接
 *   · `p = Path("src") / "a.ts"`         —— pathlib 的 `/` 运算符
 * 它们随后 `writeFileSync(p, code)` / `open(p, "w")` —— 只看参数区**看不到扩展名**
 * （扩展名被 join 拆开了）→ 漏拦。
 *
 * ## 精度取舍：**只认纯字面量表达式**
 *
 * 右值里一旦出现未知标识符（`path.join(__dirname, "a.ts")` 里的 `__dirname`）就**不绑定**。
 * 理由是产物豁免（out/ dist/ build/ tmp/）依赖**完整路径**判断：把未知前缀丢掉会让
 * `path.join("out", "a.ts")` 退化成 `a.ts` → 被误判成非产物而**误拦**。
 * 本护栏是「引导模型改用 file_write」的**软约束**（真正的门是审批），故宁可少拦、不可误伤。
 *
 * 未绑定时的兜底仍在：写调用**参数区里**出现带扩展名的字面量照样会被拦
 * （见 {@link _findSourceTargetInSegment} 的 ① 分支）。
 */
function _literalPathFromRhs(rhs: string): string | undefined {
	const expr = rhs.trim();
	if (!expr) { return undefined; }
	const lit = /(?:[rRfFbBuU]{0,2})["']([^"'\n]*)["']/g;
	// 把字面量换成空格后，剩下的骨架只允许出现：连接符/括号/逗号/点 + 已知的 join 系列标识符。
	// 任何其它标识符（`__dirname` / `X` / `compute`）都会让骨架校验失败 → 不绑定。
	const skeleton = expr.replace(lit, ' ');
	if (!/^(?:[\s+\/,.()]|(?:os\s*\.\s*)?path(?:lib)?\s*(?:\.\s*Path)?|Path|join)*$/.test(skeleton)) {
		return undefined;
	}
	const parts: string[] = [];
	let m: RegExpExecArray | null;
	lit.lastIndex = 0;
	while ((m = lit.exec(expr)) !== null) { parts.push(m[1]); }
	if (parts.length === 0) { return undefined; }
	// 单字面量时 `join('/')` 即原值；多段（join / 拼接 / pathlib 的 `/`）按 `/` 连接，
	// 这样 `path.join("out", "a.ts")` 仍是 `out/a.ts` → 产物豁免照样生效。
	return parts.join('/');
}

/**
 * 收集「被赋值为源码路径的变量名」。
 *
 * 必要性：模型的实际写法是路径与写调用**分行** ——
 *   `p = r"...\WorkflowEditorPanel.tsx"` … `open(p, "w")`
 * 只看 `open(...)` 的参数区永远看不到扩展名。故先建立变量→源码路径的绑定，
 * 再在参数区里认变量名。
 *
 * 覆盖 Python（`p = r"..."` / `p = Path("...")` / `os.path.join(...)`）与
 * JS（`const p = "..."` / `path.join(...)` / 拼接）—— 右值解析见 {@link _literalPathFromRhs}。
 */
function _collectSourcePathVariables(command: string, cwd?: string): Map<string, string> {
	const out = new Map<string, string>();
	// `[const|let|var] name = <右值>`；右值取到换行 / 分号为止（再由 _literalPathFromRhs 解析）
	const re = /(?:^|[\s;{(])(?:const\s+|let\s+|var\s+)?([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+)/g;
	const sourceExtRe = new RegExp('\\.(?:' + SOURCE_EXT_ALTERNATION + ')$', 'i');
	let m: RegExpExecArray | null;
	while ((m = re.exec(command)) !== null) {
		const filePath = _literalPathFromRhs(m[2]);
		if (!filePath) { continue; }
		// 只绑定**源码**路径（join 出的 csv / json 报告等不应进入绑定表，否则会误拦）
		if (!sourceExtRe.test(filePath)) { continue; }
		if (isAllowedArtifactTarget(filePath, cwd)) { continue; }
		out.set(m[1], filePath);
	}
	return out;
}

/**
 * 在一段文本（写 API 的参数区）中查找源码目标：直接的路径字面量，或已知的
 * 源码路径变量名。返回可读的目标描述，未命中返回 undefined。
 */
function _findSourceTargetInSegment(segment: string, sourceVars: Map<string, string>, cwd?: string): string | undefined {
	// ① 直接出现的路径（带引号或裸写，如 `> src/a.ts`）
	const literal = new RegExp('[\\w./\\\\:$~-]*\\.(?:' + SOURCE_EXT_ALTERNATION + ')\\b', 'i').exec(segment);
	if (literal && !isAllowedArtifactTarget(literal[0], cwd)) {
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
 * @param command 模型传入的原始命令。
 * @param cwd 命令的**实际运行目录**（两个 shell 工具都支持 `cwd` 参数）。
 *   传进来后，**相对路径**的目标会先拼成 `cwd/target` 再判是否产物 ——
 *   否则 `cwd: "docs/kb-mockups"` + `> admin.html` 这类**产物写入**会被误拦
 *   （三条豁免规则都要求路径含目录段，裸名一个都不匹配）。
 *   省略时保持原行为（裸名 fail-closed 按源码处理）。
 * @returns 命中的写形态与目标；未命中返回 undefined。
 */
export function detectScriptSourceWrite(command: string, cwd?: string): IScriptSourceWriteHit | undefined {
	if (!command) { return undefined; }
	const sourceVars = _collectSourcePathVariables(command, cwd);
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
			const target = _findSourceTargetInSegment(segment, sourceVars, cwd);
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
		`Use the file editing tools instead — pick by whether the file already exists:\n` +
		`  • NEW file      → file_write (creates it in one call; no prior read needed)\n` +
		`  • EXISTING file → file_read it FIRST (patch is gated on a prior successful read — ` +
		`patching unread files is rejected), then patch\n` +
		`      patch TEXT mode: replace an exact block (copy "search" verbatim; line endings are handled automatically)\n` +
		`      patch LINE mode: pass insert_line + "replace" to INSERT new content at a line number (no text to match)\n` +
		`If patch keeps failing with "search text not found", re-read the exact region with file_read and copy ` +
		`the search text from that output — do NOT fall back to a hand-rolled read/splice/write script.\n` +
		`(Writing generated artifacts is still allowed and does NOT need a bypass: under ` +
		`out/ dist/ build/ tmp/, in a "mockup" prototype dir (e.g. docs/kb-mockups/), or ANY path ` +
		`with a "_"-prefixed segment — per this repo's .gitignore convention ("_" = throwaway ` +
		`debug/scratch), e.g. _mockup.html, _render.url.json, docs/_draft.md, _kb-mockups/a.html.)`
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
