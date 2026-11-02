// @vssaros/dsh-memory — 自动提升门控（纯逻辑：零 I/O、零 dsh 依赖、全同步）。
//
// 背景（2026-11-02）：沉淀链断在这里 —— `agent/turn-stopping` 每回合都在产草稿
// （dev 库实测 17 条、`mem:obs` 3700 行、`mem:summaries` 119 条），但**没有任何一条
// 自动走到长期层**（`mem:memories` 最后一次写入 2026-09-25），全靠人在页面上逐条点「提升」。
// 结果就是：记忆系统看起来在跑，长期层其实是空的。
//
// 所以这里补"自动提升"的那一半。它必须**极窄**，理由见 `core/distill.js` 的约束 ②：
// 自动提取必然有误，错的记忆会被喂给之后每一轮。门控条件（全部满足才提升）：
//   ① 档位 `autoPromote === 'high-only'`（缺省；`off` 完全关闭，回到"只产草稿"）；
//   ② **不是摘要类**（`turn-summary` / `session-summary`）—— 整段摘要没有可用的判据，只能人来判；
//   ③ **强句式**：习惯约定 / 显式要求 / 项目规范 / 英文约定。
//      ⚠ **排除「强调提醒」**（注意 / 务必 / 必须）：真机事故里它把 skill 描述文本
//      「必须通过此 skill 处理…」提成了草稿（见 `distill.js` 的 `stripSystemWrappers` 注释）⇒
//      这一类的误报率显著高于其它四类，不给它自动通道。
//   ④ **LLM 判定成功**（`judgeOk === true`）。这是与草稿路径**相反**的失败方向：
//      草稿路径 fail-open（保留全部，宁多勿漏）；自动提升必须 **fail-closed**
//      （判定超时/抛错/解析不了 ⇒ 一条都不提），否则一次 LLM 故障就会把整批候选写进长期层。
//   ⑤ **重复出现**：同一 digest 在历史草稿里已存在（`hits >= autoPromoteMinHits`，缺省 2）。
//      说一次可能是随口，说两次才是约定 —— 这也是社区插件（evolve）的 confirmed-hits 口径。
//   ⑥ 长度 12–200 字、不含疑似凭证。
//
// ⚠ 本文件**不**决定"谁来写"：写仍然走 `lib/promote.js` 的 promoter（同一套
// "先写成功再改状态"的顺序 + 审计），只是把 `policy` 从 `human` 换成 `auto-distill`。

/** 自动提升档位。`off` = 回到只产草稿（旧行为）；`high-only` = 只提升高置信候选。 */
export const AUTO_PROMOTE_MODES = Object.freeze(['off', 'high-only']);

/** 缺省档位。★ 刻意选 `high-only`：它是"窄到几乎不会误伤"的那一档（五条条件同时满足）。 */
export const DEFAULT_AUTO_PROMOTE = 'high-only';

/** 缺省要求的最少出现次数（含本次）。1 = 首次即提（激进），2 = 重复出现才提。 */
export const DEFAULT_AUTO_PROMOTE_MIN_HITS = 2;

/** 每回合最多自动提升几条（防"一次对话把长期层刷满"）。 */
export const AUTO_PROMOTE_MAX_PER_TURN = 1;

/** 自动提升的长度区间（太短没有信息量，太长多半是转述而非约定）。 */
export const AUTO_PROMOTE_MIN_CHARS = 12;
export const AUTO_PROMOTE_MAX_CHARS = 200;

/**
 * 允许自动提升的句式标签（`distill.js` 的 `DISTILL_PATTERNS[].tag` + 摘要事实标签）。
 * ⚠ 不含 `强调提醒`，理由见文件头 ③。
 * `summary-fact`（2026-11-02）：从**压缩摘要**里切出来的原子事实句（不是整段摘要）。
 * 它比"用户亲口说的约定"弱一档（是模型转述）⇒ 单独的更高重复门槛，见 `SUMMARY_FACT_MIN_HITS`。
 */
export const AUTO_PROMOTE_KINDS = Object.freeze(['习惯约定', '显式要求', '项目规范', '英文约定', 'summary-fact']);

/**
 * `summary-fact` 的重复门槛**下限**（即使 `autoPromoteMinHits` 被调成 1 也不低于它）。
 * 理由：这类候选的来源是**模型写的摘要**而不是用户原话 ⇒ 至少要被两次独立摘要印证。
 */
export const SUMMARY_FACT_MIN_HITS = 2;

/** 摘要类标签：一律不进自动通道（`distill.js` 的两个常量）。 */
export const SUMMARY_KINDS = Object.freeze(['turn-summary', 'session-summary']);

/** 疑似凭证（与 `amSchema.stripPrivateData` 同类判据的保守子集：命中就直接不提）。 */
const SECRET_RE = /(?:api[_-]?key|secret|password|passwd|token|bearer|authorization|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

/**
 * 解析配置（容错：不认识的档位一律回落 `off` —— 宁可少提，不可多提）。
 * @param {{autoPromote?: unknown, autoPromoteMinHits?: unknown}} config 插件 config
 * @returns {{mode: string, minHits: number}} 生效档位与阈值
 */
export function resolveAutoPromote(config) {
	const raw = typeof config?.autoPromote === 'string' ? config.autoPromote.trim() : '';
	const mode = AUTO_PROMOTE_MODES.includes(raw) ? raw : (raw ? 'off' : DEFAULT_AUTO_PROMOTE);
	const hits = Number(config?.autoPromoteMinHits);
	const minHits = Number.isInteger(hits) && hits > 0 ? hits : DEFAULT_AUTO_PROMOTE_MIN_HITS;
	return { mode, minHits };
}

/**
 * 判断一条候选能否自动提升。
 *
 * @param {{matched?: string, text?: string, chars?: number, hits?: number}} candidate 候选（草稿行或候选对象）
 * @param {{mode?: string, minHits?: number, judgeOk?: boolean}} options 生效档位 / 阈值 / LLM 判定是否成功
 * @returns {{promote: boolean, reason: string}} `reason` 供审计与页面展示（**不要**只返回布尔：出问题时无从归因）
 */
export function decideAutoPromotion(candidate, options = {}) {
	const mode = AUTO_PROMOTE_MODES.includes(options.mode) ? options.mode : DEFAULT_AUTO_PROMOTE;
	if (mode !== 'high-only') { return { promote: false, reason: 'mode-off' }; }

	const kind = String(candidate?.matched ?? '');
	if (!kind) { return { promote: false, reason: 'no-kind' }; }
	if (SUMMARY_KINDS.includes(kind)) { return { promote: false, reason: 'summary-needs-human' }; }
	if (!AUTO_PROMOTE_KINDS.includes(kind)) { return { promote: false, reason: `weak-kind:${kind}` }; }

	// ★ fail-closed：判定没给结论（超时/抛错/解析失败/判定器未启用）⇒ 一律不提
	if (options.judgeOk !== true) { return { promote: false, reason: 'judge-unavailable' }; }

	const text = String(candidate?.text ?? '').trim();
	const chars = Number.isFinite(candidate?.chars) ? candidate.chars : text.length;
	if (chars < AUTO_PROMOTE_MIN_CHARS) { return { promote: false, reason: 'too-short' }; }
	if (chars > AUTO_PROMOTE_MAX_CHARS) { return { promote: false, reason: 'too-long' }; }
	if (SECRET_RE.test(text)) { return { promote: false, reason: 'sensitive' }; }

	const baseHits = Number.isInteger(options.minHits) && options.minHits > 0 ? options.minHits : DEFAULT_AUTO_PROMOTE_MIN_HITS;
	// 模型转述的事实句（`summary-fact`）不允许因"把 minHits 调成 1"而放宽到一次就提
	const minHits = kind === 'summary-fact' ? Math.max(baseHits, SUMMARY_FACT_MIN_HITS) : baseHits;
	const hits = Number.isFinite(candidate?.hits) ? candidate.hits : 1;
	if (hits < minHits) { return { promote: false, reason: `hits<${minHits}` }; }

	return { promote: true, reason: `high-confidence:${kind}` };
}

/**
 * 在一批候选里挑出**本回合允许自动提升**的那些（最多 `AUTO_PROMOTE_MAX_PER_TURN` 条）。
 *
 * 为什么单独一层：钩子里还要做"写草稿 → 提升"两步，挑选逻辑必须可被探针独立钉住
 * （否则只能靠真机观察，而这类功能的失败是**静默**的）。
 *
 * @param {Array<object>} candidates 候选（需带 `matched` / `text` / `chars` / `hits`）
 * @param {{mode?: string, minHits?: number, judgeOk?: boolean, maxPerTurn?: number}} options 生效参数
 * @returns {{selected: Array<object>, skipped: Array<{id: string, reason: string}>}} 选中与跳过（含原因）
 */
export function pickAutoPromotions(candidates, options = {}) {
	const list = Array.isArray(candidates) ? candidates : [];
	const max = Number.isInteger(options.maxPerTurn) && options.maxPerTurn > 0 ? options.maxPerTurn : AUTO_PROMOTE_MAX_PER_TURN;
	const selected = [];
	const skipped = [];
	for (const candidate of list) {
		const verdict = decideAutoPromotion(candidate, options);
		if (!verdict.promote) {
			skipped.push({ id: String(candidate?.id ?? ''), reason: verdict.reason });
			continue;
		}
		if (selected.length >= max) {
			skipped.push({ id: String(candidate?.id ?? ''), reason: 'turn-quota' });
			continue;
		}
		selected.push(candidate);
	}
	return { selected, skipped };
}
