// 结构化 handoff：item 会话收尾时，除最后一行 `[item:...]` 标记外，再交一份带字段的报告块。
//
// ── 为什么要这一层（2026-10-31，对照官方 `@deepseek-ai/dsh-tool-ralph`）──────────
// 官方 Ralph 让每轮 fresh agent 交一份**结构化报告**（status/summary/evidence/next/blocker），
// 并且三条纪律值得照抄：
//   ① **有大小上限**（`maxHandoffChars` 16384）；
//   ② 非法 / 缺失 / 超长 ⇒ **整条判失败**，而不是截断、也不是当成"轮次跑满"；
//   ③ 明说"完成与阻塞是 worker **自述**，不是独立验证"。
// 我们原来只有最后一行标记 ⇒ 没有可复核的依据，也分不清"做完了"和"说做完了"。
//
// ── 为什么放在 loop 侧而不是 workitem 内核 ────────────────────────────────────
// 完成契约的唯一真源确实是内核（与群聊共用），但内核那套是 `[item:...]` 标记，群聊侧也在用；
// 这次是**无人值守循环**特有的"跨轮交接"语义，动内核会让群聊一起变。⇒ 只在 loop 侧加，
// 且**默认关闭**（`handoff.require` 默认 false）⇒ 没配置的 loop 与从前逐字一致。
//
// 纯模块：零 I/O、零时钟 ⇒ 单测与干跑可直接调。

/** 硬上限（越过即拒绝，不夹紧 —— 夹紧会把"我写了 64K"静默变成 16K）。 */
export const HANDOFF_HARD_LIMITS = { maxChars: 65536 };
/** 默认值：默认不强制（增量式），上限对齐官方的 16K。 */
export const HANDOFF_DEFAULTS = { require: false, maxChars: 16384 };

const BEGIN = '--- handoff ---';
const END = '--- /handoff ---';
const FIELD_KEYS = ['status', 'summary', 'evidence', 'next', 'blocker'];

/**
 * 追加到 item prompt 末尾的交接契约（只在 `handoff.require=true` 时附加 —— 不加就不会有人写）。
 * @returns 契约文本。
 */
export function handoffContract(spec) {
	const maxChars = spec?.handoff?.maxChars ?? HANDOFF_DEFAULTS.maxChars;
	return [
		'',
		`收尾时**另外**给一份结构化交接（放在 ${BEGIN} 与 ${END} 之间，5 个字段齐全）：`,
		'summary: 一句话结论（非空）',
		'evidence: 你据以判断的依据 —— 命令输出 / 改动的文件 / 单测结果（非空）',
		'next: 下一轮该做什么（done 时必须为空）',
		'blocker: 卡在哪（blocked 时必须非空，其余必须为空）',
		`整段不得超过 ${maxChars} 字符（超了判失败，不会替你截断）。`,
		'⚠ 这份交接是**你自己的陈述**，不是独立验收：写 done ≠ 有人复核过。',
	].join('\n');
}

/**
 * 从 finalText 里抽 handoff 块（取**最后一处**，与"最后一行标记"的口径一致）。
 * @returns `{ found, fields, chars, raw }`。
 */
export function parseHandoff(finalText) {
	const raw = typeof finalText === 'string' ? finalText : '';
	const begin = raw.lastIndexOf(BEGIN);
	if (begin < 0) {
		return { found: false, fields: {}, chars: 0, raw: '' };
	}
	const tail = raw.slice(begin + BEGIN.length);
	const end = tail.indexOf(END);
	const body = end < 0 ? tail : tail.slice(0, end);
	const fields = {};
	for (const line of body.split(/\r?\n/)) {
		const m = /^\s*([a-zA-Z]+)\s*:\s*(.*)$/.exec(line);
		if (!m) { continue; }
		const key = m[1].toLowerCase();
		if (FIELD_KEYS.includes(key) && fields[key] === undefined) { fields[key] = m[2].trim(); }
	}
	return { found: true, fields, chars: body.length, raw: body };
}

/**
 * 校验一份 handoff（状态语义对齐官方 Ralph）。
 * @param handoff - `parseHandoff` 的结果。
 * @param options - `{ status, maxChars }`；status 来自 `[item:...]` 标记。
 * @returns `{ ok, errors }`。
 */
export function validateHandoff(handoff, { status, maxChars = HANDOFF_DEFAULTS.maxChars } = {}) {
	const errors = [];
	if (!handoff?.found) {
		return { ok: false, errors: ['缺少 handoff 块'] };
	}
	if (handoff.chars > maxChars) {
		errors.push(`handoff 超长：${handoff.chars} > ${maxChars}（不截断，按失败处理）`);
	}
	const f = handoff.fields;
	if (!f.summary) { errors.push('summary 为空'); }
	if (status === 'done') {
		if (!f.evidence) { errors.push('done 必须有 evidence（据以判断的依据）'); }
		if (f.next) { errors.push('done 的 next 必须为空'); }
		if (f.blocker) { errors.push('done 的 blocker 必须为空'); }
	} else if (status === 'blocked') {
		if (!f.blocker) { errors.push('blocked 必须有具体 blocker'); }
	} else if (status === 'failed') {
		if (!f.evidence) { errors.push('failed 必须有 evidence'); }
	}
	return { ok: errors.length === 0, errors };
}
