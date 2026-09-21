/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 超限命令输出的落盘决策（纯逻辑部分，零 IO —— IO 留在调用侧）。
 *
 * ## 动机（2026-08-22，对标 MiMo-Code / opencode 的 bash 提示词）
 *
 * 本项目原先对超限输出只有**头尾截断**：`slice(0,32KB) + "…omitted…" + slice(-32KB)`，
 * **中段永久丢失**。而 tsc/测试/构建的关键信息经常正落在中段（例如第一个真正的
 * 编译错误在几百行 warning 之后）。
 *
 * MiMo/opencode 的做法是超限则把**全量输出写入文件**并在返回里告知路径，模型再用
 * read/grep 精确检索 —— 信息不丢，且检索是按需的（不占用当轮上下文）。本项目已有
 * `file_read`（支持 offset/limit 分页）与 `search_code`，天然契合。
 *
 * ## 为什么落盘目标必须是 `~/.vssaros/tmp/`
 *
 * 三个约束同时满足只有这一个位置：
 *  1. **在沙箱允许根内** —— `~/.vssaros` 是 5 个允许根之一，模型后续 `file_read`
 *     该路径不会触发越界确认卡片（写工作区 tmp/ 则会污染用户仓库与 git status）。
 *  2. **有现成路径约定** —— `SarosPath.tmp` 已存在。
 *  3. **可安全清理** —— 该目录语义即临时文件，按数量/时长回收不会误删用户数据。
 */

/** 落盘阈值：小于此值直接内联返回，不落盘（避免为小输出制造文件）。 */
export const SPILL_THRESHOLD_BYTES = 65536;

/** 内联保留的头部字节数 —— 落盘后仍给模型一段开头，避免它为了「看一眼」就得再读文件。 */
export const SPILL_INLINE_HEAD_BYTES = 8192;

/**
 * 内联保留的**尾部**字节数（2026-09-21，pi/bash 对比后新增）。
 *
 * 此前内联片段**只有头部**：对构建/测试日志，头部基本是进度与 warning 噪音，而
 * **错误与结论在尾部** —— 模型必须再花一次 `file_read` 才知道构建到底过没过。
 * pi 的 bash 正是基于这一点选择「**尾部优先**」保留（`truncateTail`，
 * 2000 行/50KB，先到者胜）。本仓做头+尾双段：既保留"命令开头的解析/回显结论"，
 * 又让**结尾的成败结论直接可见**，中段仍靠落盘文件按需检索 ✓。
 */
export const SPILL_INLINE_TAIL_BYTES = 8192;

/** 落盘文件保留上限（个）。超出则删最旧的。 */
export const SPILL_MAX_FILES = 40;

/** 落盘文件保留时长（ms）。 */
export const SPILL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 落盘决策。 */
export interface ISpillDecision {
	/** 是否需要落盘。 */
	readonly shouldSpill: boolean;
	/**
	 * 内联返回的片段（`shouldSpill` 为 true 时有值）——
	 * **头 + 省略标记 + 尾**（头尾均切在行边界），不是单纯的头部。
	 */
	readonly inlineExcerpt: string;
	/** 原始总长度（字符）。 */
	readonly totalChars: number;
}

/**
 * 判断输出是否需要落盘，并切出**内联片段（头 + 省略标记 + 尾）**。
 *
 * 注意按**字符**而非字节判断：上游 `EXEC_OUTPUT_MAX` 也是字符语义，两者保持一致
 * 便于推理；且此处的目的是控制上下文占用，字符数与 token 数更相关。
 *
 * 头尾都切在**行边界**（头取最后一个换行之前，尾从换行之后开始）—— 半行会误导模型
 * 把截断处当成内容 ✗。头尾各 8KB，中段以省略标记替代并说明「完整输出在下方」。
 */
export function decideOutputSpill(text: string): ISpillDecision {
	const totalChars = text.length;
	if (totalChars <= SPILL_THRESHOLD_BYTES) {
		return { shouldSpill: false, inlineExcerpt: text, totalChars };
	}
	// 头部：切在行边界上，避免把一行截成两半误导模型
	let headCut = text.lastIndexOf('\n', SPILL_INLINE_HEAD_BYTES);
	if (headCut < SPILL_INLINE_HEAD_BYTES / 2) { headCut = SPILL_INLINE_HEAD_BYTES; }
	// 尾部：同样切在行边界（从一个换行**之后**开始，保证不出现半行）
	const tailFrom = Math.max(headCut, text.length - SPILL_INLINE_TAIL_BYTES);
	const nlAfter = text.indexOf('\n', tailFrom);
	// ⚠ 无换行（超长单行）⇒ 找不到行边界，只能按字符切 —— 此时**必须回退到 tailFrom**
	// 而不是 text.length：后者会让尾段变成空串（等于又退回"只给头部"，把结论丢掉 ✗）。
	const tailCut = nlAfter === -1 ? tailFrom : nlAfter + 1;
	const omitted = Math.max(0, tailCut - headCut);
	return {
		shouldSpill: true,
		inlineExcerpt: text.slice(0, headCut)
			+ `\n... (${omitted} chars omitted — full output below) ...\n`
			+ text.slice(tailCut),
		totalChars,
	};
}

/** 生成落盘文件名（可排序 + 唯一）。 */
export function spillFileName(now: Date, seq: number): string {
	const pad = (n: number, w = 2) => String(n).padStart(w, '0');
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
		+ `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
		+ `-${pad(now.getMilliseconds(), 3)}`;
	return `exec-${stamp}-${pad(seq % 1000, 3)}.log`;
}

/**
 * 落盘后返回给模型的说明文本。
 *
 * 必须做到：① 明确「输出没有丢」② 给出**可直接执行**的检索方式 —— 否则模型会以为
 * 信息不可得而重跑命令（重跑构建的代价远大于读文件）。
 */
export function spillNoticeMessage(filePath: string, totalChars: number, inlineExcerpt: string): string {
	return (
		`${inlineExcerpt}\n\n`
		+ `[OUTPUT TRUNCATED IN CONTEXT — FULL OUTPUT SAVED]\n`
		+ `The command produced ${totalChars} characters; the excerpt above is its HEAD and TAIL `
		+ `(${inlineExcerpt.length} characters) — the middle was omitted from the context here.\n`
		+ `Nothing was lost: the COMPLETE output was written to:\n  ${filePath}\n`
		+ `To inspect the omitted middle, use the file tools on that path instead of re-running the command:\n`
		+ `  - search_code with path set to that file — to jump straight to an error/symbol\n`
		+ `  - file_read with offset/limit — to page through it\n`
		+ `Do NOT re-run the command just to see the output again.`
	);
}

/** 判断一个落盘文件是否该被回收。 */
export function isStaleSpillFile(fileName: string, mtimeMs: number, now: number): boolean {
	if (!/^exec-\d{8}-\d{6}-\d{3}-\d{3}\.log$/.test(fileName)) { return false; }
	return now - mtimeMs > SPILL_MAX_AGE_MS;
}

/**
 * 从现有落盘文件列表中挑出需要删除的（超龄 + 超量）。
 *
 * @param files `{ name, mtimeMs }` 列表
 * @returns 应删除的文件名
 */
export function selectSpillFilesToDelete(
	files: readonly { readonly name: string; readonly mtimeMs: number }[],
	now: number,
): string[] {
	const owned = files.filter(f => /^exec-\d{8}-\d{6}-\d{3}-\d{3}\.log$/.test(f.name));
	const stale = owned.filter(f => now - f.mtimeMs > SPILL_MAX_AGE_MS).map(f => f.name);
	const staleSet = new Set(stale);
	// 剩余的按新→旧排序，超出上限的尾部一并删
	const fresh = owned.filter(f => !staleSet.has(f.name)).sort((a, b) => b.mtimeMs - a.mtimeMs);
	const overflow = fresh.slice(SPILL_MAX_FILES).map(f => f.name);
	return [...stale, ...overflow];
}
