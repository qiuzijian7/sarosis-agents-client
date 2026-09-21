/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ★ 尾区增量重写的**纯逻辑**（2026-09-21，从 `xtermCliPanel._rewriteMessageTail` 抽出 ✓）。
 *
 * 为什么抽出来：行数换算错一行 ⇒ CPL 上移错位 ⇒ 终端内容错乱 ✗✓，且这类 bug 在源码断言里
 * 根本测不出来 ✗ —— 必须能脱离 xterm/DOM 直接单测 ✓✓（本文件零 DOM 依赖 ✓）。
 *
 * 协议前提（由 `XtermCliPanel` 保证 ✓）：
 *   · 每条消息的 payload **以 `\r\n` 结尾**（`_normalizeMsgAnsi` ✓）⇒ 写完后光标停在
 *     "末尾内容行之后的新行起点" ✓；
 *   · 显示行数口径 = {@link countRenderedLines}（含末尾空行计 1 ✓）—— 与全量重渲染严格一致 ✓。
 */

/** CSI/OSC 转义序列剥离（与 xtermCliPanel 原实现一致 ✓ —— 用显式 `\u001b`/`\u0007`，**不写裸控制字符** ✗）。 */
const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/**
 * ★★ 2026-09-21（日志实锤：82 条消息会话 bufferLen=3343 vs 我们估算 2747，差 596 行 ✗✗✓）：
 * **终端按"显示宽度"折行，CJK/全角字符占 2 列** ✓，而 JS `string.length` 里一个汉字是 1 ✗ ⇒
 * 中文内容的真实行数被 `length` 口径系统性低估 ~一半 ✗ ⇒ 高度推导全错 + 尾区 CPL 上移行数全错
 * （增量重写落到错误的行 ⇒ 擦乱/截断 ✗✗✓）。
 * ⇒ 折行宽度必须用**显示宽度**（wcwidth 的 BMP 子集：覆盖中日韩/全角 ✓）。
 */
export function charDisplayWidth(codePoint: number): number {
	if (codePoint < 0x1100) { return 1; }
	const wide =
		codePoint <= 0x115F ||                            // Hangul Jamo
		(codePoint >= 0x2E80 && codePoint <= 0x303E) ||   // CJK Radicals / Kangxi
		(codePoint >= 0x3041 && codePoint <= 0x33FF) ||   // 平/片假名・CJK 符号
		(codePoint >= 0x3400 && codePoint <= 0x4DBF) ||   // CJK 扩展 A
		(codePoint >= 0x4E00 && codePoint <= 0x9FFF) ||   // CJK 统一表意文字（常用汉字 ✓）
		(codePoint >= 0xA000 && codePoint <= 0xA4CF) ||   // 彝文
		(codePoint >= 0xAC00 && codePoint <= 0xD7A3) ||   // 韩文音节
		(codePoint >= 0xF900 && codePoint <= 0xFAFF) ||   // 兼容表意
		(codePoint >= 0xFE30 && codePoint <= 0xFE4F) ||   // CJK 兼容形式
		(codePoint >= 0xFF00 && codePoint <= 0xFF60) ||   // 全角 ASCII/半角片假名
		(codePoint >= 0xFFE0 && codePoint <= 0xFFE6) ||   // 全角符号
		(codePoint >= 0x20000 && codePoint <= 0x3FFFD);   // CJK 扩展 B+（增补平面 ✓）
	return wide ? 2 : 1;
}

/**
 * 统计一段 ANSI 文本渲染后实际占据的行数（按 cols 计算自动换行）。
 *
 * 关键：高度必须由**内容**推导，不能读 `term.buffer.active.length` —— 后者由
 * 上一次的 rows 决定，用它反推高度会形成「每次重算都收缩一轮」的恶性循环，
 * 最终撞上 min-height 下限，表现为面板底部大片空白。
 *
 * ⚠ 口径：`\r\n` 结尾的串 split 后会有一个**末尾空元素**，计 1 行 ✓（这是故意的 ——
 * 光标就停在那个新行上 ✓）。调用方之间相减时"尾 1"会相消 ✓。
 */
export function countRenderedLines(ansi: string, cols: number): number {
	let total = 0;
	for (const line of ansi.split('\r\n')) {
		const visible = line.replace(ANSI_ESCAPE_RE, '');
		// ★ 显示宽度折行（CJK=2 列 ✓）—— `for..of` 按码点迭代 ⇒ 代理对也正确 ✓
		let width = 0;
		for (const ch of visible) { width += charDisplayWidth(ch.codePointAt(0)!); }
		total += Math.max(1, Math.ceil(width / Math.max(1, cols)));
	}
	return total;
}

/** 尾区 diff 的判定结果。 */
export interface ITailPatch {
	/**
	 * - `noop`：内容没变 ⇒ **一次终端写都不发生** ✓✓（流式期常态 ✓）；
	 * - `patch`：只重写变化后缀 ✓✓（历史区一个字节都不动 ✓）；
	 * - `full`：无法安全增量（后缀超过视口 ⇒ CPL 进不了 scrollback ✗✓）⇒ 调用方回退全量 ✓。
	 */
	readonly kind: 'noop' | 'patch' | 'full';
	/** patch 时要上移的显示行数（0 = 光标已在后缀首行 ✓，跳过 CPL ✓）。 */
	readonly up: number;
	/** patch 时要写入的 ANSI 后缀（以 `\r\n` 结尾 ✓ ⇒ 光标归位 ✓）。 */
	readonly payload: string;
	/** 新消息的显示行总数（= `countRenderedLines(next, cols)` ✓ 口径 ✓）。 */
	readonly newTotalLines: number;
	/** 旧消息的显示行总数（无基线 = 0 ✓）。 */
	readonly oldTotalLines: number;
}

/**
 * 计算"把终端里 `prev` 的显示更新成 `next`"所需的最小写入。
 *
 * @param prev  上次实际写入的 ANSI（无基线传 `undefined` ✓ —— 按"全新后缀"处理 ✓）
 * @param next  本次要显示的 ANSI（已归一化：以 `\r\n` 结尾 ✓）
 * @param cols  折行列数（与渲染时相同 ✓）
 * @param viewportRows  终端视口行数 —— CPL 会被视口顶截断、进不了 scrollback ✗✓，
 *              故 `up > viewportRows - 1` 时必须 `full` ✓。
 */
export function computeTailPatch(
	prev: string | undefined,
	next: string,
	cols: number,
	viewportRows: number,
): ITailPatch {
	if (prev === next) {
		const lines = countRenderedLines(next, cols);
		return { kind: 'noop', up: 0, payload: '', newTotalLines: lines, oldTotalLines: lines };
	}

	const prevLines = prev !== undefined ? prev.split('\r\n') : [];
	const nextLines = next.split('\r\n');

	// 首个变化的逻辑行（行内容不同即命中 ✓ —— 行内文字变化/折行变化都从该行起重写 ✓）。
	// 前后缀完全一致而长度不同（纯追加/纯收缩 ✓）⇒ 停在公共前缀长度 ✓。
	let firstChanged = 0;
	while (firstChanged < prevLines.length && firstChanged < nextLines.length
		&& prevLines[firstChanged] === nextLines[firstChanged]) {
		firstChanged++;
	}

	const oldTotalLines = prev !== undefined ? countRenderedLines(prev, cols) : 0;

	// ⚠ 全部行数一律**直接计算**，不用"总数 − 前缀"这类代数恒等式 ✗✓ ——
	// 恒等式在 `firstChanged === 0`（无公共前缀 ⇒ 前缀侧没有"末尾空行"可相消）时**差一行** ✗✓
	//（行为测试 `ANSI 转义/首行变化` 用例抓到 ✓✓）。差一行 ⇒ CPL 上移错位 ⇒ 终端内容错乱 ✗✓。
	//
	// 旧后缀显示行数 = 光标（末尾新行起点）到后缀首行的距离
	//   = `countRenderedLines(prev 的 firstChanged..尾, cols) − 1`（去掉光标所在的末尾空行 ✓）。
	const oldSuffix = prev !== undefined
		? Math.max(0, countRenderedLines(prevLines.slice(firstChanged).join('\r\n'), cols) - 1)
		: 0;

	// CPL 视口上限：进不了 scrollback ⇒ 只能全量 ✓
	if (oldSuffix > viewportRows - 1) {
		return { kind: 'full', up: 0, payload: '', newTotalLines: 0, oldTotalLines };
	}

	const suffixStr = nextLines.slice(firstChanged).join('\r\n');
	// 新总数 = 直接对 next 全串计数 ✓（与全量重渲染的口径逐字节一致 ✓）
	const newTotalLines = countRenderedLines(next, cols);

	return {
		kind: 'patch',
		up: oldSuffix,
		payload: suffixStr,
		newTotalLines,
		oldTotalLines,
	};
}

/** 把 patch 结果编成一段 ANSI 控制序列（CPL 上移 + ED 清尾 + 后缀 ✓）。 */
export function encodeTailPatch(patch: ITailPatch): string {
	const parts: string[] = [];
	if (patch.up > 0) {
		parts.push(`\u001b[${patch.up}F`); // 上移到后缀首行（CPL ⇒ 顺带归列 1 ✓）
		parts.push('\u001b[0J');            // 清到缓冲区尾 ✓
	}
	parts.push(patch.payload);
	return parts.join('');
}
