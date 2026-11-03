// @vssaros/dsh-agents — 派发相关的通用文本/身份小工具（纯逻辑，零 I/O、零 dsh 依赖）。
//
// ★ 2026-11-03 从 groups.js 抽出来：群聊功能整体下线（用户要求），但这三个函数被 **IM 渠道绑定**
//   （bindings.js）复用，与群无关 ⇒ 先搬家再删群，避免把渠道功能一起带走。
//   `normalizeActor` = 调用方归一（人 / bot）；`dispatchModeOf` + `clipDispatchText` = 投递语义与正文预算。

/** 把调用方归一成 `{ kind:'human' } | { kind:'bot', agentId }`（缺省 = 人）。 */
export function normalizeActor(input) {
	const raw = input && typeof input === 'object' ? input : {};
	const kind = String(raw.kind ?? 'human').trim().toLowerCase();
	if (kind === 'bot') {
		return { kind: 'bot', agentId: String(raw.agentId ?? '').trim() };
	}
	return { kind: 'human' };
}

/* ── 派发方式：抢断 vs 排队 ────────────────────────────────────────────────
   对应 dsh 的两种投递方法：
     · `steer`    —— 注入**当前回合**："它在干活则下一 step 读到，空闲则直接开回合"
                     ⇒ 长回合会被打断/混进新指令（用户看到"话没说完就被插话"）
     · `followup` —— **等当前回合结束**再作为新回合处理（消息不会丢，只是排队）
   ⚠ 不需要自建队列 —— dsh 的 followup 本身就是排队语义，再排一层只会更难对账。
*/
export const DISPATCH_MODES = ['steer', 'followup'];

/** 派发方式（非法/缺省 ⇒ steer）。`turn` 是给人读的别名，内部统一成 followup。 */
export function dispatchModeOf(input) {
	const raw = String(input?.dispatchMode ?? '').trim().toLowerCase();
	if (raw === 'turn') { return 'followup'; }
	return DISPATCH_MODES.includes(raw) ? raw : 'steer';
}

/* ── 派发正文预算 ──────────────────────────────────────────────────────────
   单条消息也可能是几万字的日志粘贴 ⇒ 一次投递就能把成员的上下文撑爆。
   整条 12k：超了**保头部 + 保尾部**（开头通常是诉求，结尾通常是结论/细节），中间显式标注省略量。
   ⚠ 只在**派发出去的那份文本**上截断；界面与记录里永远存全文。 */
const DISPATCH_BUDGET_CHARS = 12_000;

/**
 * 派发正文的总量预算。返回字符串（可直接塞进 message.content）。
 */
export function clipDispatchText(text, budget = DISPATCH_BUDGET_CHARS) {
	const s = String(text == null ? '' : text);
	if (s.length <= budget) { return s; }
	const headLen = Math.floor(budget * 0.6);
	const tailLen = Math.max(0, budget - headLen);
	const omitted = s.length - headLen - tailLen;
	return s.slice(0, headLen)
		+ `\n\n…（正文过长：中间省略 ${omitted} 字）…\n\n`
		+ (tailLen > 0 ? s.slice(s.length - tailLen) : '');
}
