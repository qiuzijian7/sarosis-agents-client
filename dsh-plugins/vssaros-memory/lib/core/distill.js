// @vssaros/dsh-memory — distill core（纯逻辑：零 I/O、零 dsh 依赖、**全同步**）。
//
// 这是「turn/end 自动沉淀」的**纯逻辑半边**（2026-10-13）。
//
// 为什么需要它：社区 12 款 dsh 记忆插件里 **10 款**都有自动沉淀（`mneme` 的 autoSummarize / `meow` 的
// dream / `eternal` 的 capture / `haitang1` 的 rollout distill / `jessenjx` 的 session-disposed distill …）
// 而我们的写入此前**只有模型显式调 `memory_remember`** 一条路 ⇒ 会话里说过的约定 / 偏好，
// 模型不主动写就永久丢了 ✗（这是历轮评估里排第一的能力缺口）。
//
// ⚠⚠ 三条**硬约束**（前两条来自官方契约，不是风格偏好）：
//   ① **绝不阻塞回合**：本模块的调用点是 `agent/turn-stopping`，而官方对它的说明是
//      "The turn is about to close… **Awaited before the boundary commits**" + `@mode serial`
//      （`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:370-391`）⇒ 在那个钩子里做任何 I/O
//      就等于"每个回合多等一次网关" ✗✗。所以**本文件必须全是同步纯函数**（毫秒级返回、无 await）✓。
//   ② **先草稿，不直写长期层**：自动提取必然有误（玩笑、否定句「以后不要 X」、别人转述的约定）；
//      直接进跨会话记忆＝把错误喂给之后每一轮 ✗ —— 社区的自陈教训正是这个（`haitang1` 的 README
//      承认"配置分层让合并长期失败，而插件看起来是健康的"）。所以产出是**草稿**，等用户显式提升 ✓
//      （与我们给 `skill_manage` 定的同一条判据：先草稿 + 用户显式提升 ✓）。
//   ③ **隐私**：候选只落 digest + 预览（与 `core/audit.js` 同一口径 ✓）。
//
// 为什么先上**规则**而不是调模型：调模型要 `ctx.llm` + 一次真实 LLM 往返，而它**不能**在
// `turn-stopping` 里等（见 ①）⇒ 那需要一套带队列 / 并发上限 / 重试的后台设施（社区做法，下一步）。
// 本文件先用规则拿到**最小可用闭环**，并把接口留成可替换的：`extractCandidates` 是纯函数，
// 将来换成 LLM 摘要时**签名不变**（调用方不必改）✓。

import { auditDigestOf } from './audit.js';

/**
 * 触发模式 —— **只在用户消息里找**。
 *
 * 为什么只看用户消息：模型自己说的话不算"用户的约定" ✗（模型可能在复述、在提问、在举例）。
 * 触发词是**中英双语**（本项目的会话是中英混用的 ✓）。
 */
export const DISTILL_PATTERNS = [
	// 时态类：以后 / 之后 / 从现在起 …
	{ tag: '习惯约定', re: /(?:以后|之后|今后|后续|往后|从现在起)[^。！？；\n]{2,80}/ },
	// 记忆类：记住 / 别忘了 …
	{ tag: '显式要求', re: /(?:记住|请记住|要记住|别忘了|记得)[^。！？；\n]{2,80}/ },
	// 规范类：我们约定 / 规范是 / 纪律是 …
	{ tag: '项目规范', re: /(?:我们约定|约定好|规范是|规则是|要求是|口径是|纪律是)[^。！？；\n]{2,80}/ },
	// 强调类：注意 / 务必 / 必须 …
	{ tag: '强调提醒', re: /(?:注意|务必|一定要|必须)[^。！？；\n]{2,60}/ },
	// 英文：**必须是短语**（`remember to` / `make sure to`…）—— ⚠ 不能收光秃秃的 `remember` ✗：
	// 真机实测（2026-10-13，p3-36）任务文本里的 "e2e memory remember check" 被它抓成了两条误报草稿
	//（`remember check` / `remember check）`）⇒ 通用词 + 宽匹配 = 噪音 ✗。
	{ tag: '英文约定', re: /\b(?:remember to|always|never|from now on|make sure to|don'?t ever)\b[^.!?;\n]{2,60}/i },
];

/**
 * 剥掉 **dsh 自己包装/注入**的内容（纯函数）。
 *
 * 为什么必须有这一步：真机实测（2026-10-13，p3-36）自动沉淀从"用户消息"里提出了一条
 * `必须通过此 skill 处理，包括：搜索、网页抓取、登录后操作、网络交互等` —— 那是 **skill 的描述文本**，
 * 根本不是用户说的话 ✗✗。dsh 会把系统内容（`<system-reminder>` 提醒、`<available_skills>` 技能目录）
 * **作为 user 消息**注入会话，而"用户的约定"与"系统的说明"在**消息层面长得一模一样** ✗。
 *
 * 手法照 `poc/dsh-p0/scripts/mock-llm.mjs:33`（那边剥 `<system-reminder>` 是同一原因 ✓）。
 * ⚠ **只剥已知标签**，不做"剥掉所有 `<x>…</x>`"那种激进规则 —— 用户真的可能写 HTML 标签 ✓。
 *
 * @param {unknown} text - 原始用户消息文本。
 * @returns {string} 剥完（可能为空串）。
 */
export function stripSystemWrappers(text) {
	if (typeof text !== 'string') { return ''; }
	return text
		.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
		.replace(/<available_skills>[\s\S]*?<\/available_skills>/g, ' ')
		.trim();
}

/** 每个回合最多产出几条候选（防"一整段话被切成二十条"✗）。 */
export const DISTILL_MAX_PER_TURN = 3;

/** 候选文本长度闸：太短没信息、太长不是记忆（是文档 ✗）。 */
export const DISTILL_MIN_CHARS = 8;
export const DISTILL_MAX_CHARS = 200;

/** 草稿文件的目录名 / 文件名（I/O 层拼绝对路径；与审计账本同级 ✓）。 */
export const DRAFT_DIR_NAME = 'memory-drafts';
export const DRAFT_FILE_NAME = 'drafts.jsonl';

/**
 * 草稿行数上限与保鲜期（2026-10-13 治理）。
 *
 * 为什么必须有：草稿是**只增**的（每个回合都可能提几条），而它又是**待办**性质 ——
 * 没人处理的草稿堆到几千行之后，页面读不动、去重表也变得没有意义 ✗。审计账本有同类问题
 * （那边靠**轮转 + 保留 3 份** ✓），草稿的处理方式不同：它是待办 ⇒ 过期就可以**直接丢** ✓
 * （不是"归档"：没人会去翻 30 天前的自动草稿 ✓）。
 */
export const DRAFT_MAX_ROWS_DEFAULT = 500;
export const DRAFT_TTL_MS_DEFAULT = 30 * 24 * 60 * 60 * 1000;

/**
 * 淘汰判据（纯函数）：给定草稿行，算出该保留哪些。
 *
 * 两条：① 超 TTL 的丢（30 天没被处理的自动草稿，多半已经过时或不再相关 ✓）；
 * ② 仍然超上限的，按时间保留**最近** N 条 ✓。
 *
 * ⚠ `status` **不参与**判据：`promoted`（已提升）与 `rejected`（已拒）都照常淘汰 ✓ ——
 * 它们该发挥的作用（写进长期层 / 不再重复提）已经由**长期层**与 `seenDigestsOf` 承担了，
 * 草稿本身留着只是噪音 ✓（这也是它与审计账本的关键差别：账本是证据，草稿是待办 ✓）。
 *
 * ⚠ 排序必须**稳定**：同一回合落的几条 `at` 相同 ⇒ 保持原有顺序 ✓（否则每次压缩都会
 * 把它们洗牌，等于每回合都产生一次"内容变化"✗）。
 *
 * @param {readonly unknown[]} rows - 草稿行。
 * @param {{now?: number, maxRows?: number, ttlMs?: number}} [options] - 上下文。
 * @returns {{kept: object[], keptCount: number, droppedByTtl: number, droppedByLimit: number}} 结果。
 */
export function pruneDrafts(rows, options = {}) {
	const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
	const limit = Number.isInteger(options.maxRows) && options.maxRows > 0 ? options.maxRows : DRAFT_MAX_ROWS_DEFAULT;
	const ttl = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DRAFT_TTL_MS_DEFAULT;
	const list = (Array.isArray(rows) ? rows : []).filter(row => row && typeof row.digest === 'string');
	const fresh = list.filter(row => nowMs - (Number.isFinite(row.at) ? row.at : 0) <= ttl);
	const ordered = fresh
		.map((row, index) => ({ row, index }))
		.sort((a, b) => ((Number.isFinite(a.row.at) ? a.row.at : 0) - (Number.isFinite(b.row.at) ? b.row.at : 0)) || (a.index - b.index))
		.map(entry => entry.row);
	const kept = ordered.length > limit ? ordered.slice(-limit) : ordered;
	return {
		kept,
		keptCount: kept.length,
		droppedByTtl: list.length - fresh.length,
		droppedByLimit: fresh.length - kept.length,
	};
}

/**
 * 是否值得压缩（纯函数）：**有东西要丢**才重写文件 ✓。
 * 为什么单列：每次 `append` 都重写整份草稿会把 I/O 放大（草稿区是每回合都碰的路径 ✓）——
 * 只有"确实该淘汰了"才付这个代价 ✓。
 * @param {readonly unknown[]} rows - 草稿行。
 * @param {{now?: number, maxRows?: number, ttlMs?: number}} [options] - 上下文。
 * @returns {boolean} 是否该压缩。
 */
export function shouldCompactDrafts(rows, options = {}) {
	const { droppedByTtl, droppedByLimit } = pruneDrafts(rows, options);
	return droppedByTtl > 0 || droppedByLimit > 0;
}

/**
 * 候选文本的规范化（纯函数）。
 * 折叠空白、去掉首尾标点残留、按上限截断 ⇒ 让"同一条意思"在去重时能对上 ✓。
 * @param {unknown} raw - 原文。
 * @returns {string} 规范化后的文本（不合适时空串）。
 */
export function normalizeCandidateText(raw) {
	if (typeof raw !== 'string') { return ''; }
	const collapsed = raw.replace(/\s+/g, ' ').trim().replace(/^[\s,，;；:：。]+/, '').replace(/[\s,，;；:：、]+$/, '');
	if (collapsed.length < DISTILL_MIN_CHARS) { return ''; }
	return collapsed.length > DISTILL_MAX_CHARS ? collapsed.slice(0, DISTILL_MAX_CHARS) : collapsed;
}

/**
 * 从一批**用户消息文本**里提取候选草稿。
 *
 * ⚠ 为什么入参是"已抽好的文本数组"而不是 `SessionEvent[]`：本模块要能**独立测**（零 dsh 依赖 ✓），
 * 而事件形状是宿主的事（`session.snapshotEvents()` 的产物由 I/O 层翻译）✓ —— 这层分层让
 * 探针不必造假的会话事件就能钉住提取质量 ✓。
 *
 * @param {readonly unknown[]} userTexts - 本回合的用户消息文本（顺序即时间序）。
 * @param {{sessionId?: string, turn?: number, seenDigests?: Set<string> | readonly string[], maxPerTurn?: number, now?: number}} [options] - 上下文。
 * @returns {Array<{id: string, at: number, text: string, chars: number, digest: string, matched: string, source: {sessionId: string, turn: number}}>} 候选草稿（不含已见过的）。
 */
export function extractCandidates(userTexts, options = {}) {
	const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
	const turn = Number.isFinite(options.turn) ? options.turn : 0;
	const now = Number.isFinite(options.now) ? options.now : 0;
	const maxPerTurn = Number.isInteger(options.maxPerTurn) && options.maxPerTurn > 0 ? options.maxPerTurn : DISTILL_MAX_PER_TURN;
	const seen = options.seenDigests instanceof Set ? options.seenDigests : new Set(Array.isArray(options.seenDigests) ? options.seenDigests : []);

	const out = [];
	const emitted = new Set();
	for (const raw of Array.isArray(userTexts) ? userTexts : []) {
		const text = typeof raw === 'string' ? raw : '';
		if (!text) { continue; }
		for (const { tag, re } of DISTILL_PATTERNS) {
			const match = re.exec(text);
			if (match === null) { continue; }
			const candidate = normalizeCandidateText(match[0]);
			if (!candidate) { continue; }
			const digest = auditDigestOf(candidate);
			// 三处去重：本回合内重复命中（同一句被多个模式抓到）、**历史草稿里已有**、以及空指纹
			if (!digest || emitted.has(digest) || seen.has(digest)) { continue; }
			emitted.add(digest);
			out.push({
				id: `draft-${digest.slice(0, 12)}`,
				at: now,
				text: candidate,
				chars: candidate.length,
				digest,
				matched: tag,
				source: { sessionId, turn },
			});
			if (out.length >= maxPerTurn) { return out; }
		}
	}
	return out;
}

/**
 * 草稿行的形状（落 JSONL 用；字段白名单，照 `buildAuditRow` 的口径 ✓）。
 * @param {object} candidate - `extractCandidates` 的产物。
 * @param {{status?: string}} [options] - 初始状态。
 * @returns {object} 可 `JSON.stringify` 的行。
 */
export function buildDraftRow(candidate, options = {}) {
	return {
		id: String(candidate?.id ?? ''),
		at: Number.isFinite(candidate?.at) ? candidate.at : Date.now(),
		status: typeof options.status === 'string' && options.status ? options.status : 'draft',
		matched: String(candidate?.matched ?? ''),
		digest: String(candidate?.digest ?? ''),
		text: String(candidate?.text ?? ''),
		chars: Number.isFinite(candidate?.chars) ? candidate.chars : String(candidate?.text ?? '').length,
		sessionId: String(candidate?.source?.sessionId ?? ''),
		turn: Number.isFinite(candidate?.source?.turn) ? candidate.source.turn : 0,
	};
}

/**
 * 从一批**会话事件**里取用户消息文本（纯函数；形状容错）。
 *
 * 事件形状：`SessionEvent` ＝ `{ type, data, seq }`（`@deepseek-ai/dsh-session/lib/types/types.d.ts`
 * 的 `SessionEventMap` ⇒ `'user/message': UserMessage` ✓；`data` 是那张表的值 ✓）。
 * `content` 允许是字符串或 parts 数组（取 `text` 片段）—— 两种都认，别的形态跳过（**不猜** ✓）。
 *
 * 为什么放在 core：它是纯函数（零 I/O、零 dsh import），**能被探针独立钉住** ✓
 * —— 否则"提取质量"就只能靠真机回合间接观察 ✗。
 *
 * @param {readonly unknown[]} events - `session.snapshotEvents(from, to)` 的产物。
 * @returns {string[]} 用户消息文本（顺序即时间序）。
 */
export function userTextsOf(events) {
	const out = [];
	for (const event of Array.isArray(events) ? events : []) {
		if (event?.type !== 'user/message') { continue; }
		// ★ 2026-10-20：只认**人说的话**。dsh 的 `user/message` 是"所有非模型输入"的统一载体 ——
		//   压缩替代消息（`source.kind === 'compact-checkpoint'`，正文是**模型写的摘要**）、
		//   `agent-instructions` / `runtime-context` / `goal` / `team-message` 等都走它
		//   （`@deepseek-ai/dsh-llm` 的 `MessageSourceMap`：「user messages carry any producer's kind」）。
		//   不过滤 ⇒ 一次压缩就把模型对整段对话的转述当成"用户约定"拿去正则提取 ✗。
		//   判据：没有 `source`（老日志 / 夹具）或 `kind === 'user'`（浏览器提交 `user-rpc` 就是它）⇒ 才算。
		if (!isHumanSource(event?.data?.source)) { continue; }
		const content = event?.data?.content;
		const raw = typeof content === 'string'
			? content
			: (Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text).join(' ') : '');
		// ⚠ **必须剥 dsh 自己注入的内容**（`<system-reminder>` / `<available_skills>`）——
		// 真机实测把 skill 描述文本提成了草稿（见 `stripSystemWrappers` 的注释 ✓）。
		const text = stripSystemWrappers(raw);
		if (text) { out.push(text); }
	}
	return out;
}

/** 草稿状态词表（`promote` 只会往 `promoted` 走；`rejected` 供将来的人工"丢弃"用 ✓）。 */
export const DRAFT_STATUSES = ['draft', 'promoted', 'rejected'];

/**
 * 这条消息是不是**人**说的（`userTextsOf` 的来源闸；纯函数）。
 * @param {unknown} source - `UserMessage.source`。
 * @returns {boolean}
 */
export function isHumanSource(source) {
	if (source === undefined || source === null) { return true; }
	return typeof source === 'object' && /** @type {any} */ (source).kind === 'user';
}

// ── 会话摘要草稿（2026-10-20：dsh 侧补「压缩摘要」写入点）─────────────────────────
//
// IDE 时代压缩时直接 `writeMemory('compression-<ts>')` 进长期层（`turnContextCompaction.ts`）。
// dsh 侧的等价物是会话日志里的 `compaction/summary`（`@deepseek-ai/dsh-compaction`：模型写好的
// 摘要在 `data.summary: ContentBlock[]`，log-only，不进 surface）。
// ⚠ 口径与自动沉淀**同一条纪律**：产出**草稿**、人工「提升」才进长期记忆 —— 摘要是模型对整段
//   对话的转述，同样"必然有误"（约束 ②），直写＝把转述错误喂给之后每一轮 ✗。

/** 摘要草稿的 `matched` 标签（页面 / 探针据此区分"摘要"与"约定"）。 */
export const SUMMARY_MATCHED_TAG = 'session-summary';

/**
 * 摘要草稿的长度上限。比约定（200）大得多：摘要的价值在"一段话讲清这次会话做了什么"，
 * 但也不能是整份对话（长期记忆的每条都要能被检索/注入，几千字的一条会挤掉别的）。
 */
export const SUMMARY_MAX_CHARS = 1200;

/** 太短的摘要没有信息量（压缩后端失败时可能只产出一句占位）。 */
export const SUMMARY_MIN_CHARS = 40;

/**
 * 从一批会话事件里取压缩摘要 → 摘要草稿候选（纯函数；零 I/O）。
 *
 * 去重走同一套指纹（`auditDigestOf`）：同一段摘要（重放 / 重读游标）不会出两条草稿。
 * 草稿 id 用 `summary-` 前缀 ⇒ 与约定草稿的 `draft-` 不撞（提升后的记忆 id 由 `promotedMemoryIdOf` 派生）。
 *
 * @param {readonly unknown[]} events - `session.snapshotEvents(from, to)` 的产物。
 * @param {{sessionId?: string, turn?: number, seenDigests?: Set<string> | readonly string[], now?: number}} [options]
 * @returns {Array<{id: string, at: number, text: string, chars: number, digest: string, matched: string, source: {sessionId: string, turn: number}}>}
 */
/**
 * **按回合摘要自动沉淀**（★ 2026-10-26，用户要求）。
 *
 * ## 为什么需要它
 * 旧的自动沉淀只认**显式句式**（`DISTILL_PATTERNS`：以后/记住/约定/注意/务必/always…）⇒
 * 普通对话（"帮我看看这个 bug"）一条候选都产不出来 ⇒ 账本实测 **106/106 `no-candidate`**、
 * 四层记忆恒 0 ⇒ 用户感受就是"聊了半天什么都没记住" ✗✗
 * 而另一条 `summaryCandidatesOf` 只认 `compaction/summary`（**上下文压缩**时才有的模型摘要）
 * ⇒ 短会话永远等不到。
 *
 * ## 做法（保守优先，宁少不脏）
 * 取本回合**最后一条人说的用户消息** + **最后一条助手回复**，压成一句 `用户诉求 ⇒ 助手结论`，
 * 截到 `DISTILL_MAX_CHARS`（200）⇒ 作为**草稿**（`draft`，仍需人工「提升」才进长期记忆 ✓）。
 * 判据（任一不满足就不产）：
 *   · 用户文本 ≥ `TURN_MIN_USER_CHARS`（10 字，寒暄/单词不算）
 *   · 助手文本 ≥ `TURN_MIN_ASSISTANT_CHARS`（24 字，避免"好的/收到"这类空回复）
 *   · 与历史草稿 digest 去重（`seenDigests`）
 *   · 每回合**最多 1 条**
 * ⚠ 只在"本回合没有显式候选"时才调用（由调用方判定）⇒ 不会与正则候选重复 ✓
 */
export const TURN_MATCHED_TAG = 'turn-summary';
export const TURN_MIN_USER_CHARS = 10;
export const TURN_MIN_ASSISTANT_CHARS = 24;

/**
 * 取事件里的纯文本。
 *
 * ⚠⚠ **两种真实形状都要认**（2026-10-26 对照 dsh 运行时 `types.d.ts` 核对出来的）：
 *   · `user/message`      ⇒ `event.data.content`（字符串或 text 分片数组）
 *   · `assistant/message` ⇒ **`event.data.message.content`** —— 事件体是
 *     `{ turn, step, message: AssistantMessage, stream, usage? }`，**没有** `data.content` ✗✗
 *   ⇒ 早期只读 `data.content` ⇒ 助手文本**恒为空** ⇒ 回合摘要永远凑不够字数 ⇒
 *     真机账本 **101/101 `no-candidate`**（"按回合摘要自动沉淀"看起来上线了、其实一条都没产）✗
 */
function textOfEvent(event) {
	const d = event?.data;
	const candidates = [d?.content, d?.message?.content, d?.text, d?.message?.text];
	for (const c of candidates) {
		if (typeof c === 'string' && c.trim()) { return c; }
		if (Array.isArray(c)) {
			const text = c.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join(' ');
			if (text.trim()) { return text; }
		}
	}
  return '';
}

/** 压成单行（去系统包装 + 合并空白），并截断到上限。 */
function collapseOneLine(raw, maxChars) {
	const t = stripSystemWrappers(String(raw ?? ''))
		.replace(/[ \t]+/g, ' ')
		.replace(/\s*\n\s*/g, ' ')
		.trim();
	return t.length > maxChars ? `${t.slice(0, maxChars)}…` : t;
}

/**
 * **回合观测**（`mem:obs:*` 暂存层）★ 2026-10-27（阶段③）。
 *
 * ## 为什么要搬到 dsh 侧
 * IDE 渲染进程此前每回合调 `memoryProvider.observe(...)`（"边聊边记"的唯一自动入口）
 * ⇒ 依赖**渲染进程存活 + 代理可用 + IDE 重启才生效**；而 dsh 插件本来就在同一个
 * `agent/turn-stopping` hook 上跑 distill（事件源完全一样）⇒ 搬到这里更稳：
 *   ① 不需要 IDE 渲染侧参与；② 与 distill 共用同一份事件游标，不会漏回合；③ 可单测。
 *
 * ## 与 `turnCandidatesOf` 的关系（两层，别混）
 *   · 本函数 ⇒ **观测**（暂存层，流水，由引擎固化管线消费）
 *   · `turnCandidatesOf` ⇒ **草稿**（需人工「提升」才进长期记忆）
 * ⇒ 两者都在同一批事件上产出，但落点不同、生命周期不同 ✓
 *
 * ## 门槛（比草稿宽松：观测是流水，不追求"值不值得记"）
 *   · 用户或助手**至少一边有内容**就产（都空 ⇒ `null`，不写噪音）
 *   · 分别截断到 `TURN_OBS_USER_MAX` / `TURN_OBS_ASSISTANT_MAX`（避免把整段对话塞进暂存层）
 *
 * @returns {{ sessionId: string, hookType: string, timestamp: string, data: object } | null}
 */
export const TURN_OBS_HOOK_TYPE = 'turn_end';
export const TURN_OBS_USER_MAX = 300;
export const TURN_OBS_ASSISTANT_MAX = 500;

export function buildTurnObservation(events, options = {}) {
	const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
	const turn = Number.isFinite(options.turn) ? options.turn : 0;
	const now = Number.isFinite(options.now) ? options.now : Date.now();
	const user = collapseOneLine(lastUserRaw(events), TURN_OBS_USER_MAX);
	const assistant = collapseOneLine(lastAssistantText(events), TURN_OBS_ASSISTANT_MAX);
	if (!user && !assistant) { return null; }
	return {
		sessionId,
		hookType: TURN_OBS_HOOK_TYPE,
		timestamp: new Date(now).toISOString(),
		data: {
			turn,
			user,
			assistant,
			chars: { user: user.length, assistant: assistant.length },
			source: 'dsh-plugin',
		},
	};
}

export function turnCandidatesOf(events, options = {}) {
	const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
	const turn = Number.isFinite(options.turn) ? options.turn : 0;
	const now = Number.isFinite(options.now) ? options.now : 0;
	const seen = options.seenDigests instanceof Set ? options.seenDigests : new Set(Array.isArray(options.seenDigests) ? options.seenDigests : []);
	let userRaw = lastUserRaw(events);
	let assistantRaw = lastAssistantText(events);
	const user = collapseOneLine(userRaw, 120);
	const assistant = collapseOneLine(assistantRaw, 160);
	if (user.length < TURN_MIN_USER_CHARS || assistant.length < TURN_MIN_ASSISTANT_CHARS) { return []; }
	const text = collapseOneLine(`${user} ⇒ ${assistant}`, DISTILL_MAX_CHARS);
	const digest = auditDigestOf(text);
	if (!digest || seen.has(digest)) { return []; }
	return [{
		id: `turn-${digest.slice(0, 12)}`,
		at: now,
		text,
		chars: text.length,
		digest,
		matched: TURN_MATCHED_TAG,
		source: { sessionId, turn },
	}];
}

/** 本回合**最后一条人说的**用户消息（复用 `userTextsOf` 的过滤口径 ⇒ 压缩摘要不算用户话 ✓）。 */
function lastUserRaw(events) {
	const texts = userTextsOf(events);
	return texts.length > 0 ? texts[texts.length - 1] : '';
}

/** 本回合**最后一条**助手回复文本。 */
function lastAssistantText(events) {
	let last = '';
	for (const event of Array.isArray(events) ? events : []) {
		if (event?.type !== 'assistant/message') { continue; }
		const t = textOfEvent(event);
		if (t.trim()) { last = t; }
	}
	return last;
}

export function summaryCandidatesOf(events, options = {}) {
	const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
	const turn = Number.isFinite(options.turn) ? options.turn : 0;
	const now = Number.isFinite(options.now) ? options.now : 0;
	const seen = options.seenDigests instanceof Set ? options.seenDigests : new Set(Array.isArray(options.seenDigests) ? options.seenDigests : []);
	const out = [];
	for (const event of Array.isArray(events) ? events : []) {
		if (event?.type !== 'compaction/summary') { continue; }
		const blocks = event?.data?.summary;
		const raw = Array.isArray(blocks)
			? blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
			: '';
		const collapsed = stripSystemWrappers(raw).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
		if (collapsed.length < SUMMARY_MIN_CHARS) { continue; }
		const text = collapsed.length > SUMMARY_MAX_CHARS ? `${collapsed.slice(0, SUMMARY_MAX_CHARS)}…` : collapsed;
		const digest = auditDigestOf(text);
		if (!digest || seen.has(digest) || out.some(c => c.digest === digest)) { continue; }
		out.push({
			id: `summary-${digest.slice(0, 12)}`,
			at: now,
			text,
			chars: text.length,
			digest,
			matched: SUMMARY_MATCHED_TAG,
			source: { sessionId, turn },
		});
	}
	return out;
}

/**
 * 解析 `application/x-www-form-urlencoded` 的表单体（纯函数）。
 *
 * 为什么自己写 3 行而不用 `URLSearchParams`：**不是**为了省依赖（`URLSearchParams` 就在全局 ✓），
 * 而是为了**把"只认白名单键"这件事写进签名** —— 这个解析结果会被送进网关的写路径，
 * 一个"顺手把整个表单展开"的实现等于把未知字段一路带进长期记忆 ✗。
 *
 * @param {unknown} body - 请求体正文。
 * @param {readonly string[]} [allowedKeys] - 白名单键（其它键丢弃）。
 * @returns {Record<string, string>} 解析结果（键都被 `decodeURIComponent` 解过 ✓）。
 */
export function parseFormUrlEncoded(body, allowedKeys = ['id']) {
	const out = {};
	if (typeof body !== 'string' || !body) { return out; }
	for (const pair of body.split('&')) {
		if (!pair) { continue; }
		const eq = pair.indexOf('=');
		const rawKey = eq === -1 ? pair : pair.slice(0, eq);
		const rawValue = eq === -1 ? '' : pair.slice(eq + 1);
		let key = rawKey;
		let value = rawValue;
		try { key = decodeURIComponent(rawKey.replace(/\+/g, ' ')); } catch { /* 保持原样 */ }
		try { value = decodeURIComponent(rawValue.replace(/\+/g, ' ')); } catch { /* 保持原样 */ }
		if (!allowedKeys.includes(key)) { continue; }
		out[key] = value;
	}
	return out;
}

/**
 * 从已有的草稿行里取"已见过的指纹"（去重表；纯函数）。
 * 只把 `status !== 'rejected'` 的算作已见 —— 用户明确拒掉的候选，下次还该再提一次 ✓
 * （否则"拒了一次 ⇒ 这条约定永久不再被提醒"，那是静默丢数据 ✗）。
 * @param {readonly unknown[]} rows - 已落盘的行。
 * @returns {Set<string>} 指纹集合。
 */
export function seenDigestsOf(rows) {
	const seen = new Set();
	for (const row of Array.isArray(rows) ? rows : []) {
		const digest = typeof row?.digest === 'string' ? row.digest : '';
		if (digest && row?.status !== 'rejected') { seen.add(digest); }
	}
	return seen;
}
