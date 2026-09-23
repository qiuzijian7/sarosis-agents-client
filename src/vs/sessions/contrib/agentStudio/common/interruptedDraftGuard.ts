/*---------------------------------------------------------------------------------------------
 *  interruptedDraftGuard.ts — 「中断草稿」**去重守卫**（纯函数 ✓ 可单测 ✓）
 *
 *  背景（2026-09-23 用户报「一条回答被拆成 2 段」✓ DOM 取证 ✓）：
 *    持久化里出现 `msg_…_interrupted`（中断快照 ✓ 含全文 + 「已中断」✓）与**真·turn 消息**
 *    （带工具卡 ✓ 含全文 ✓）**并存**，开头逐字重复 ✗✓。
 *
 *  崩溃保命链路：`nativeChatEditorPane._journalStreamingDraft`（流式中每 ~2s 写草稿 ✓）→
 *    重启后 `agentChatService.getHistory` 消费草稿（`_consumeInterruptedDraft` ✓）——
 *    草稿是"流式途中进程死掉时"的最后兜底 ✓ ⇒ **绝不能误删**（真孤儿必须保留 ✓✓）。
 *
 *  旧守卫 `_isDraftAlreadyPersisted` 的判据 `tail.includes(draft)` 有三个漏口 ✗：
 *    ① tail 只拼 `content` ✗ —— stage-E 消息的正文可能**只在 `parts`**（content 空 ✗）⇒ 拼不上 ✗；
 *    ② 字符级 includes ✗ —— 草稿是流式原文，落盘文本过 `content_replace` 清洗 ⇒ 空白/标签差异失配 ✗；
 *    ③ 循环上界 `tail.length < draft.length` —— 草稿比尾部还长时凑不满 ⇒ includes 必 false ✗。
 *
 *  加固（本模块 ✓）：
 *    ① 尾部文本 = `content` **或** `parts` 拼接 ✓；
 *    ② 比较前**折叠空白**（`\s+ → ' '` ✓）⇒ 表格/换行差异不再误伤 ✓；
 *    ③ **前缀探针**：草稿是"累计文本" ⇒ 其**头部必然出现**在回合文本里 ✓ ⇒
 *      草稿前 120 字在尾部出现 ⇒ 判定同源 ✓（阈值 120：太短不足以判定同源 ✗）；
 *    ④ 方向保守：**只放宽"丢弃"，不放宽"保留"** ✓✓ —— 真孤儿（内容不在历史里）**照旧注入** ✓。
 *--------------------------------------------------------------------------------------------*/

/** 守卫所需的最小消息形状（结构化 ✓ 不引 ChatMessage 以免依赖环 ✓）。 */
export interface IDraftGuardMessage {
	readonly role?: string;
	readonly content?: string;
	readonly parts?: ReadonlyArray<{ readonly kind?: string; readonly type?: string; readonly text?: string }>;
}

/** 比对用的文本归一：折叠所有空白为单个空格 + 去两端 ✓（消除 sanitize/换行差异 ✗）。 */
export function normDraftCompareText(s: string | undefined): string {
	return (s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * ★ 覆盖比对专用归一：**去掉所有空白** ✓（不只是折叠 ✗）。
 * 真凶（2026-09-23 日志实证 ✓ 两条 `KEPT ✗`）：草稿是**流式累计文本**（迭代边界**没有**分隔符 ✓），
 * 而落盘文本是**按消息拼接**的（边界处有分隔 ✓）⇒ 折叠成单空格后仍会**差一个字符** ✗ ⇒ includes 失配 ✗✓
 * （DOM 探针里 `at=0` 覆盖 ✓、服务里却 KEPT ✗ —— 就是这个 ✓）。⇒ 干脆**全去掉** ✓。
 * 只用于"包含"判定 ✓ 不用于展示（日志仍用 `normDraftCompareText` ✓）。
 */
function squashForCoverage(s: string): string {
	return (s ?? '').replace(/\s+/g, '');
}

/** 取消息的**可见文本**：优先 `content`；空则**从 parts 拼** ✓（stage-E 正文可能只在 parts ✗）。 */
export function messageVisibleText(m: IDraftGuardMessage): string {
	if (typeof m.content === 'string' && m.content) { return m.content; }
	const parts = m.parts;
	if (Array.isArray(parts) && parts.length > 0) {
		return parts.filter(p => (p.kind ?? p.type) === 'text').map(p => p.text ?? '').join('');
	}
	return '';
}

/**
 * 草稿去重判定 ✓：**尾部连续 assistant 消息组**的文本若已覆盖草稿 ⇒ 丢弃 ✓。
 *
 * 判据（任一成立即"已落盘" ✓）：
 *   A. 归一后的草稿**整段**是归一后尾部的子串 ✓（草稿是累计文本 ⇒ 完整落盘时必中 ✓）；
 *   B. 归一后的草稿**前 120 字**出现在归一后尾部 ✓（草稿比尾部还长时的兜底 ✓ ——
 *      草稿是累计文本 ⇒ 其头部必在回合文本里 ✓；阈值 120 ✓ 太短不足以判定同源 ✗）。
 *
 * ⚠ 方向保守 ✓✓：只放宽"丢弃"，不放宽"保留" —— 真孤儿（进程真崩溃时草稿是**唯一**副本 ✓）
 *   两判据都不中 ⇒ 返回 false ⇒ 照常注入 ✓✓。
 */
export function isDraftAlreadyPersisted(
	messages: readonly IDraftGuardMessage[] | undefined,
	draftContent: string,
): boolean {
	// ⚠ 覆盖比对必须**去掉所有空白**（squashForCoverage ✓ 见上）—— 折叠成单空格仍会因
	//   迭代边界的分隔符差一个字符 ⇒ 失配 ✗✓（日志实证：DOM 层 at=0 覆盖 ✓ 服务里却 KEPT ✗）。
	const draft = squashForCoverage(draftContent);
	if (!draft || !messages || messages.length === 0) { return false; }
	let tail = '';
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== 'assistant') { break; }
		tail = messageVisibleText(m) + tail;
		if (tail.length > draft.length + 64) { break; }
	}
	const normTail = squashForCoverage(tail);
	const probe = draft.slice(0, Math.min(120, draft.length));
	return normTail.includes(draft) || (probe.length >= 24 && normTail.includes(probe));
}

/**
 * ★ 2026-09-23 读取期兜底清洗（用户报「一条回答被拆成 2 段」✓ 二次修复 ✓）：
 *   `isDraftAlreadyPersisted` 只挡**新**注入 ✗ —— 但在此之前**已经漏进来并已落盘**的
 *   `metadata.streamInterrupted` 消息 ⇒ 现在是**普通历史消息** ✗ ⇒ 每次重开都会再渲染 ✗✓。
 *
 * 本函数在**读取时**把"已被其它 assistant 消息覆盖"的旧中断快照**滤掉** ✓：
 *   · 只处理 `metadata.streamInterrupted === true` 的消息 ✓（其它消息一律不动 ✓）；
 *   · 覆盖判据与守卫同源（整段包含 / 前缀探针 120 ✓）⇒ **方向保守** ✓✓
 *     —— 真孤儿（崩溃后草稿是唯一副本 ✓ 别的消息里找不到它的内容）**一定保留** ✗✓；
 *   · **不改盘**（只影响返回的列表 ✓ —— 下次写入时自然不再携带 ✓；
 *     UI 与模型上下文都读 getHistory ⇒ 同时受益 ✓✓）。
 */
export function dropCoveredInterruptedDrafts<T extends IDraftGuardMessage>(
	messages: readonly T[],
): T[] {
	if (!messages || messages.length === 0) { return messages ? messages.slice() : []; }
	const isIntr = (m: IDraftGuardMessage): boolean =>
		(m as { metadata?: { streamInterrupted?: boolean } })?.metadata?.streamInterrupted === true;
	// ⚠ squashForCoverage（去掉所有空白 ✓）：草稿=流式累计（边界无分隔 ✓）vs 落盘=按消息拼接（边界有分隔 ✗）
	//   ⇒ 折叠成单空格仍差一个字符 ⇒ 失配 ✗✓（这就是日志里两条 KEPT ✗ 的真因 ✓）。
	const textOfAll = messages.map(m => squashForCoverage(messageVisibleText(m)));
	return messages.filter((m, i) => {
		if (!isIntr(m)) { return true; }
		const draft = textOfAll[i];
		if (!draft) { return true; }
		// 覆盖源 = **除它自己外**的所有 assistant 消息文本（顺序无关 ✓ —— 中断快照被 append 在尾部 ✓，
		//   但其回合内容在其**之前** ✓ ⇒ 不能只盯尾部 ✗；join('') ✗✓ 不得再引入分隔符 ✓）
		const rest = messages.map((x, k) => (k !== i && x.role === 'assistant') ? textOfAll[k] : '').join('');
		const probe = draft.slice(0, Math.min(120, draft.length));
		const covered = rest.includes(draft) || (probe.length >= 24 && rest.includes(probe));
		return !covered;
	});
}
