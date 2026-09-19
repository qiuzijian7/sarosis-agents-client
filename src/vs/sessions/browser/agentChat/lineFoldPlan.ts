/*---------------------------------------------------------------------------------------------
 *  lineFoldPlan.ts — 「逐行输出」的**折叠计划**（纯函数，无 DOM 依赖 ⇒ 可单测 ✓）
 *
 *  背景（2026-09-19 真机日志 `vscode-app-1789804731524.log` ✓）：
 *   终端输出卡与写文件 diff 卡都是**每行建 DOM**（终端：行 + 前缀 + 文本 = **3 节点/行** ✗；
 *   diff：行 + marker + content ✓）。日志的「密度点名」实测单条消息里
 *     `div.terminal-output-line:264/spans…` / `div.write-file-diff-line:166` ✓
 *   ⇒ 单卡上千节点 ✓，50 条消息累到**页面 10.6 万节点** ⇒ 触发窗口裁剪、布局变慢 ✓
 *   （`DOM 预算超限 ⇒ 提前裁剪：nodes=106324 > 40000` ✓）。
 *
 *  为什么不是"虚拟滚动"✗：终端/ diff 都在**卡片内部**、高度不定、还要支持 Ctrl+F 与
 *  滚动锚点 ✓；而用户真正需要的是「**开头**（命令概览/文件头）+ **结尾**（成败结论/diff 尾）」✓
 *  ⇒ 首尾保留 + 中间可点击**逐批展开** 已经解决 99% 的诉求 ✓，且实现零风险 ✓。
 *
 *  ⚠ 纯函数、零副作用 ⇒ 只算"渲染哪几段"，DOM 操作由调用方执行 ✓。
 *--------------------------------------------------------------------------------------------*/

/** 折叠阈值（可注入以便调参 ✓）。 */
export interface LineFoldOptions {
	/** 头部保留行数（默认 120 ✓）。 */
	readonly head?: number;
	/** 尾部保留行数（默认 40 ✓）。 */
	readonly tail?: number;
}

/**
 * 默认阈值。
 *
 * `head=120 / tail=40` 的取法：**≤160 行的输出完全不受影响** ✓（绝大多数命令与 diff 都在此内 ✓），
 * 只有真正超长的才被折叠 ⇒ 视觉上"常态无感、极端有救" ✓。
 */
export const LINE_FOLD_LIMITS = { head: 120, tail: 40, chunk: 300 } as const;

export interface LineFoldPlan {
	/** 是否发生折叠（`false` ⇒ 调用方照旧全渲染 ✓）。 */
	readonly folded: boolean;
	/** 头部渲染区间 `[0, headEnd)` ✓。 */
	readonly headEnd: number;
	/** 尾部渲染区间 `[tailStart, total)` ✓；未折叠时等于 `total` ✓。 */
	readonly tailStart: number;
	/** 中间被折叠的行数（= `tailStart - headEnd` ✓）。 */
	readonly hiddenCount: number;
}

/** 归一化：负数/非整数/NaN ⇒ 取 0 ✓（诊断与渲染都不该因脏输入崩 ✗）。 */
function _int(v: number): number {
	return Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
}

/**
 * 计算「首尾保留 + 中间折叠」的渲染区间 ✓。
 *
 * 边界：`total <= head + tail` ⇒ **不折叠** ✓（`headEnd = tailStart = total` ✓）。
 */
export function planLineFold(total: number, options: LineFoldOptions = {}): LineFoldPlan {
	const n = _int(total);
	const head = Math.max(0, Math.trunc(options.head ?? LINE_FOLD_LIMITS.head));
	const tail = Math.max(0, Math.trunc(options.tail ?? LINE_FOLD_LIMITS.tail));
	if (n <= head + tail) {
		return { folded: false, headEnd: n, tailStart: n, hiddenCount: 0 };
	}
	const headEnd = head;
	const tailStart = n - tail;
	return { folded: true, headEnd, tailStart, hiddenCount: tailStart - headEnd };
}

export interface LineFoldChunk {
	/** 本次要渲染的区间 `[start, end)` ✓。 */
	readonly start: number;
	readonly end: number;
	/** 本批之后还剩多少未渲染 ✓（0 ⇒ 调用方可移除"展开"入口 ✓）。 */
	readonly remaining: number;
}

/**
 * 逐批展开：算出**下一批**要渲染的行区间 ✓（每次点击只加 `chunk` 行 ⇒ DOM 只随用户点击增长 ✓）。
 *
 * ⚠ 刻意**不做"一次展开全部"** ✗ —— 那等于把 10 万节点问题原样搬回来 ✓；
 * 用户真要全量内容时，终端卡另有「在终端中显示 / 复制命令」✓、diff 卡另有「查看文件」✓。
 */
export function planNextChunk(from: number, to: number, chunk: number = LINE_FOLD_LIMITS.chunk): LineFoldChunk {
	const start = _int(from);
	const end0 = _int(to);
	const size = Math.max(1, Math.trunc(chunk));
	const end = Math.min(end0, start + size);
	return { start, end, remaining: Math.max(0, end0 - end) };
}
