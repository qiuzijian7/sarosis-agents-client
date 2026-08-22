/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 提示词预算可观测（对齐 Hermes-Agent 的 `prompt-size` 诊断命令）。
 *
 * 背景：本项目此前只有**两个聚合数字**可看 ——
 *   · `estAtRequest` / `toolsSchema`（请求发出点快照）
 *   · `promptOverhead`（真实 usage 回来后的残差）
 * 它们能告诉你「一共多大」，但回答不了「**谁**在吃 context」。
 * 历史事故正是这个盲区造成的：core toolset 的 prefixes 误含 `memory_` 把 16 个
 * memory_* 工具全抢进不可折叠层、白烧 ~4k schema token，只能靠人工读源码发现。
 *
 * 本模块把「一次请求」拆成可归因的明细行：
 *   system:frozen/<段名>     ← driver 分层组装时逐段命名（persona / tool-section / …）
 *   system:<注入来源>        ← executor 逐个注入的 system 消息（durable-context / …）
 *   conversation:<role>      ← 真实对话消息
 *   tools:<toolset>          ← 结构化 tools schema 按 toolset 聚合
 *
 * ## 口径纪律（务必遵守）
 * 1. **token 估算与压缩判定同源**：`weightedCharCount` 是全仓唯一真源，
 *    `contextManager._weightedCharCount` 委托到这里。绝不在别处另写 CJK 权重公式，
 *    否则「预算表说没超」而「压缩判定说超了」会同时成立。
 * 2. **权威总量以调用方传入的 `messagesTokens` 为准**（即 `estimateMessagesTokens`），
 *    明细求和与它的差额显式输出为 `messages:(estimator-delta)` 行。
 *    这条残差行就是**对账**：它一旦变大，说明本模块的分解口径与压缩口径漂移了。
 * 3. 分组不得重复计算：`messages` 已包含全部 system 消息（executor 把冻结前缀
 *    作为 `messages[0]` 送出），因此 system 段**不额外加总**，只做归因细分。
 *
 * 纯函数、零依赖 → 可单测、可在 common 层安全使用。
 */

// ─── token 估算（全仓唯一真源）──────────────────────────────────────────

/**
 * 字符 → est-char 加权计数（修正裸 chars/4 对中文/代码系统性低估 3–5×）。
 * - CJK（统一表意文字/扩展/兼容/全角标点）：约 1.5 字符/token → 每字符 ≈ 2.67 est-char
 * - 其余（英文/代码/符号）：约 4 字符/token → 每字符 ≈ 1 est-char
 *
 * ⚠ 这是压缩阈值判定所用的同一公式。`contextManager._weightedCharCount` 委托到
 * 本函数；**不要在任何地方复制这段权重**，两份必漂移。
 */
export function weightedCharCount(s: string): number {
	let w = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if ((c >= 0x3000 && c <= 0x9FFF) || (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFF00 && c <= 0xFFEF)) {
			w += 2.67;
		} else {
			w += 1;
		}
	}
	return w;
}

/** 单张图片平摊 token 成本（Anthropic 口径），与 contextManager 保持一致。 */
export const IMAGE_TOKEN_COST = 1500;

/** 纯文本段的 est-token（与压缩判定同口径）。 */
export function estimateTextTokens(s: string): number {
	if (!s) { return 0; }
	return Math.ceil(weightedCharCount(s) / 4);
}

// ─── system 消息来源分类 ────────────────────────────────────────────────

/**
 * 按内容特征给 executor 逐个注入的 system 消息打来源标签。
 *
 * 为什么用内容探测而不是在每个注入点传标签：注入点分散在 executor / 记忆注入 /
 * 压缩回填等多处，且部分注入走公共 helper（`insertMessages`）。内容标记是这些
 * 消息**已有的**结构（`<durable-context>` / `## Recently Touched Files` 等），
 * 复用它不引入第二套状态；未匹配的一律归到 `injected/other`，不会静默丢失。
 */
export function classifySystemSegment(content: string): string {
	const s = content.slice(0, 400);
	if (s.includes('<system-reminder>')) { return 'injected/system-reminder'; }
	if (s.includes('<durable-context>') || s.includes('Durable Context')) { return 'injected/durable-context'; }
	if (s.includes('## Recently Touched Files')) { return 'injected/touched-files'; }
	if (s.includes('<agentmemory')) { return 'injected/agent-memory'; }
	if (s.includes('Persona Memory') || s.includes('<persona-memory>')) { return 'injected/persona-memory'; }
	if (s.includes('Retrieved Context') || s.includes('<retrieved-context>')) { return 'injected/retrieved-context'; }
	if (s.includes('CONVERSATION SUMMARY') || s.includes('Previous conversation summary')) { return 'injected/compression-summary'; }
	if (s.includes('<available_skills>') || s.includes('SKILL.md')) { return 'injected/skill'; }
	if (s.includes('TOOL_USE_ENFORCEMENT')) { return 'injected/tool-enforcement'; }
	return 'injected/other';
}

// ─── 输入 / 输出结构 ────────────────────────────────────────────────────

/** driver 分层组装时的命名段（用于细分冻结前缀）。 */
export interface IPromptSegmentInput {
	readonly name: string;
	readonly text: string;
}

/** 报告所需的消息形状（只读最小面，兼容 IChatMessage）。 */
export interface IPromptBudgetMessage {
	readonly role?: string;
	readonly content?: unknown;
	readonly contentParts?: ReadonlyArray<{ readonly type?: string }>;
}

export interface IPromptBudgetInput {
	/** 实际发送的消息数组（**必须**是含 system 消息的最终形态）。 */
	readonly messages: ReadonlyArray<IPromptBudgetMessage>;
	/**
	 * 权威消息总量 —— 传 `contextManager.estimateMessagesTokens(messages)`。
	 * 明细求和与它的差额会显式作为残差行输出，用于对账。
	 */
	readonly messagesTokens: number;
	/** 冻结前缀的命名段（`request.promptSegments`）。缺省时前缀不细分。 */
	readonly frozenPrefixSegments?: ReadonlyArray<IPromptSegmentInput>;
	/** tools schema 按 toolset 聚合（求和须等于总 schema 开销）。 */
	readonly toolGroups?: ReadonlyArray<{ readonly name: string; readonly tokens: number; readonly count: number }>;
	/** 单工具 schema 开销（用于列出最贵的几个）。 */
	readonly toolCosts?: ReadonlyArray<{ readonly name: string; readonly tokens: number }>;
	/** 模型上下文窗口（token）。<=0 时不输出占比。 */
	readonly contextWindow: number;
	/** 列出最贵单工具的条数，默认 5。 */
	readonly hottestToolCount?: number;
}

export interface IPromptBudgetLine {
	readonly name: string;
	readonly tokens: number;
	/** 占 totalTokens 的百分比（0–100）。 */
	readonly pct: number;
}

export interface IPromptBudgetReport {
	/** 全部 system 消息合计（含冻结前缀与各注入层）。 */
	readonly systemTokens: number;
	/** 非 system 消息合计。 */
	readonly conversationTokens: number;
	/** tools schema 合计。 */
	readonly toolsTokens: number;
	/** = messagesTokens + toolsTokens（messagesTokens 已含 system）。 */
	readonly totalTokens: number;
	readonly contextWindow: number;
	/** totalTokens / contextWindow × 100；窗口不可知时为 0。 */
	readonly usedPct: number;
	readonly messageCount: number;
	readonly systemMessageCount: number;
	readonly toolCount: number;
	/** 明细行，按 tokens 降序。 */
	readonly lines: ReadonlyArray<IPromptBudgetLine>;
	/** 最贵的单个工具（降序）。 */
	readonly hottestTools: ReadonlyArray<{ readonly name: string; readonly tokens: number }>;
	/** 明细求和与权威 messagesTokens 的差（正=明细偏低）。 */
	readonly estimatorDelta: number;
}

// ─── 报告构建 ───────────────────────────────────────────────────────────

function messageText(m: IPromptBudgetMessage): string {
	const c = m.content;
	if (typeof c === 'string') { return c; }
	if (c === undefined || c === null) { return ''; }
	try { return JSON.stringify(c); } catch { return ''; }
}

function imageTokens(m: IPromptBudgetMessage): number {
	const parts = m.contentParts;
	if (!Array.isArray(parts)) { return 0; }
	let n = 0;
	for (const p of parts) {
		if (p && p.type === 'image') { n++; }
	}
	return n * IMAGE_TOKEN_COST;
}

/**
 * 把一次请求拆成可归因的明细。
 *
 * ⚠ 不重复计算：`systemTokens` 与 `conversationTokens` 都来自同一份 `messages`，
 * 二者之和即消息侧全部开销；`totalTokens` 只额外加 tools schema。
 */
export function buildPromptBudgetReport(input: IPromptBudgetInput): IPromptBudgetReport {
	const buckets = new Map<string, number>();
	const add = (name: string, tokens: number) => {
		if (tokens <= 0) { return; }
		buckets.set(name, (buckets.get(name) ?? 0) + tokens);
	};

	let systemTokens = 0;
	let conversationTokens = 0;
	let systemMessageCount = 0;
	let frozenSeen = false;

	for (const m of input.messages) {
		if (!m) { continue; }
		const tokens = estimateTextTokens(messageText(m)) + imageTokens(m);
		if (m.role === 'system') {
			systemMessageCount++;
			systemTokens += tokens;
			if (!frozenSeen) {
				// 第一条 system = driver 合成的冻结前缀，用命名段细分。
				frozenSeen = true;
				const segs = input.frozenPrefixSegments ?? [];
				if (segs.length === 0) {
					add('system:frozen', tokens);
				} else {
					let attributed = 0;
					for (const seg of segs) {
						const t = estimateTextTokens(seg.text.trim());
						attributed += t;
						add(`system:frozen/${seg.name}`, t);
					}
					// 残差 = 分节连接符 + 未命名追加内容（如 TOOL_USE_ENFORCEMENT 追加）。
					// 显式出行，避免「前缀里有东西却没人认领」被静默吞掉。
					const rest = tokens - attributed;
					if (rest >= 1) { add('system:frozen/(unattributed)', rest); }
				}
			} else {
				add(`system:${classifySystemSegment(messageText(m))}`, tokens);
			}
		} else {
			conversationTokens += tokens;
			add(`conversation:${m.role ?? 'unknown'}`, tokens);
		}
	}

	// 与压缩口径对账：明细逐条 ceil，权威值整体 ceil，二者天然有小差；
	// 差额显著变大即说明分解漏了内容或口径漂移。
	const detailSum = systemTokens + conversationTokens;
	const estimatorDelta = input.messagesTokens - detailSum;
	if (Math.abs(estimatorDelta) >= 1) {
		buckets.set('messages:(estimator-delta)', estimatorDelta);
	}

	let toolsTokens = 0;
	for (const g of input.toolGroups ?? []) {
		toolsTokens += g.tokens;
		add(`tools:${g.name}`, g.tokens);
	}

	const totalTokens = input.messagesTokens + toolsTokens;
	const lines: IPromptBudgetLine[] = [];
	for (const [name, tokens] of buckets) {
		lines.push({ name, tokens, pct: totalTokens > 0 ? (tokens / totalTokens) * 100 : 0 });
	}
	lines.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));

	const hottestTools = [...(input.toolCosts ?? [])]
		.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
		.slice(0, Math.max(0, input.hottestToolCount ?? 5));

	const toolCount = (input.toolGroups ?? []).reduce((n, g) => n + g.count, 0);

	return {
		systemTokens,
		conversationTokens,
		toolsTokens,
		totalTokens,
		contextWindow: input.contextWindow,
		usedPct: input.contextWindow > 0 ? (totalTokens / input.contextWindow) * 100 : 0,
		messageCount: input.messages.length,
		systemMessageCount,
		toolCount,
		lines,
		hottestTools,
		estimatorDelta,
	};
}

// ─── 输出格式化 ─────────────────────────────────────────────────────────

/** 明细行最多输出多少条（其余合并为一行 `(others)`）。 */
const MAX_DETAIL_LINES = 10;

/**
 * 渲染为日志文本。
 *
 * ⚠ 该格式是**对外契约**（会被 grep / 脚本统计）：第一行必须以
 * `[PromptBudget] total=<n>` 开头，明细行以两空格缩进。改动前先看单测。
 */
export function formatPromptBudgetLog(report: IPromptBudgetReport, note?: string): string {
	const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
	const head =
		`[PromptBudget] total=${report.totalTokens} est-tok` +
		(report.contextWindow > 0 ? ` (${report.usedPct.toFixed(1)}% of ${report.contextWindow} window)` : '') +
		` | system=${report.systemTokens} conversation=${report.conversationTokens} tools=${report.toolsTokens}` +
		` | msgs=${report.messageCount} (system=${report.systemMessageCount}) tools=${report.toolCount}` +
		(note ? ` | ${note}` : '');

	const shown = report.lines.slice(0, MAX_DETAIL_LINES);
	const rest = report.lines.slice(MAX_DETAIL_LINES);
	const restTokens = rest.reduce((n, l) => n + l.tokens, 0);
	const detail = shown.map(
		(l) => `  ${pad(l.name, 34)}${String(l.tokens).padStart(7)}  ${l.pct.toFixed(1)}%`
	);
	if (rest.length > 0) {
		const pct = report.totalTokens > 0 ? (restTokens / report.totalTokens) * 100 : 0;
		detail.push(`  ${pad(`(others ×${rest.length})`, 34)}${String(restTokens).padStart(7)}  ${pct.toFixed(1)}%`);
	}
	if (report.hottestTools.length > 0) {
		detail.push(`  hottest tools: ${report.hottestTools.map((t) => `${t.name}=${t.tokens}`).join(', ')}`);
	}
	return [head, ...detail].join('\n');
}

// ─── 输出节流 ───────────────────────────────────────────────────────────

/** 相对上次上报的变化比例超过此值即重新上报。 */
export const BUDGET_DRIFT_RATIO = 0.15;

/**
 * 是否值得打这条报告。
 *
 * 每 turn 首次必打（`lastTotal <= 0`）+ 之后仅在总量漂移超过 15% 时再打 ——
 * 与 `agentChatPanel.refreshLog` 的聚合思路一致：既留下基线，又能捕获突变，
 * 而不会让每个 iteration 都刷 10 行。刻意不挂配置开关（提示词膨胀本身即缺陷
 * 信号，默认可见；三态配置在本项目已踩坑 3 次，不为诊断日志再引入一个）。
 */
export function shouldEmitBudgetReport(total: number, lastTotal: number, driftRatio: number = BUDGET_DRIFT_RATIO): boolean {
	if (total <= 0) { return false; }
	if (lastTotal <= 0) { return true; }
	return Math.abs(total - lastTotal) / lastTotal >= driftRatio;
}
