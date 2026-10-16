// @vssaros/dsh-dashboard — core（纯业务逻辑，零 I/O、零 dsh 依赖）。
//
// 数据契约真源 = **dsh 自己的会话投影缓存**（本机真实文件逐字核对，不是猜的）：
//   `<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json`
//   { "version": 7,
//     "record": {
//       "identity": { "formatVersion": 4, "createdAt": <ms>, "cwd": "...", "isSeeded": bool, "inheritedEventCount": n },
//       "rows": { "<unit>": { "ver": n, "seq": n, "val": <该单元的当前值> }, ... } } }
// 其中本模块用到的单元（val 的真实字段名已核对）：
//   sessionStats    → { turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens, … }
//   tokenUsage      → { totals: { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, last }
//   contextPressure → { surfaceTokens, contextWindow }   ← **v5 起多一个窗口大小**（占位/占比要用它）
//   title           → string | null
//   agentPreset     → string
//   turnBoundary    → { openTurnStartSeq, lastStepStartSeq, lastStepBoundary, lastTurn }   ← **在跑的回合**
//   contextBreakdown → { systemTokens, toolsTokens, messageTokens, nodes[] }   ← **表面构成**（`system+messages == surface`）
//   inbox           → { 'next-turn': [], 'next-step': [] }   ← **用户已发出、还排在队里的输入**（空数组=已知的 0）
//   modelSelection  → { lastUsed, pending }   ← 最近请求**实际**用的模型 / 已选但**尚未生效**的模型
//   sessionListMetadata → { blank, lastPromptAt }   ← 空白会话（**权威**口径）/ 最新人类提示时间
//   titleInput      → { first:{seq,text}|null, count, lastSeq }   ← **有资格参与标题生成**的人类消息聚合
//   subagent        → { identity?: {mode,label?,seq} }      ← 本会话**自己是子代理**时的身份（one-shot / continuable）
//   subagentTiming  → { settledMs, active?:{since,through}, descriptorSeen }   ← 子代理的活跃时长（active 非空 = 正在跑）
//   subagentCatalog → { head?: ChunkedList<{childId,childCreatedAt,mode}> }    ← **父会话**派出去的直接子代理清单
//   subagentModelSelectionPolicy → AllowedModelRoute[] | null   ← 允许子代理显式选的路由（null = 与"没有记录"同义）
//   （运行状态用：todos / plan / userQuestions / goal / sandboxMode / permissions / llmRetry / turnBoundary / inbox）
//
// 这是"读 dsh 会话投影"的**冷读路径**（服务端 `sessionProjections.snapshot()` 需要活的 Session 对象，
// 已结束的会话只能走它的 checkpoint 缓存）。因此页面/工具都会**标出来源**（cache / live），
// 并把"缓存里没有这个单元"如实说成未知，而不是显示 0。

/** 缓存文件的顶层版本（不认识就报错，不猜结构）。 */
export const SUPPORTED_CACHE_VERSION = 7;

/** 本模块消费的投影单元名（缺哪个就把哪个显示为未知）。 */
export const STATS_KEY = 'sessionStats';
export const TOKENS_KEY = 'tokenUsage';
export const PRESSURE_KEY = 'contextPressure';
export const TITLE_KEY = 'title';
export const PRESET_KEY = 'agentPreset';
/** 「运行中」信号用的单元（形状照运行时 schema 逐字核对，见下面各 `*Of` 的注释）。 */
export const TODOS_KEY = 'todos';
export const PLAN_KEY = 'plan';
export const QUESTIONS_KEY = 'userQuestions';
export const GOAL_KEY = 'goal';
export const SANDBOX_KEY = 'sandboxMode';
export const PERMISSIONS_KEY = 'permissions';
export const RETRY_KEY = 'llmRetry';
export const TURN_KEY = 'turnBoundary';
export const BREAKDOWN_KEY = 'contextBreakdown';
export const INBOX_KEY = 'inbox';
export const MODEL_KEY = 'modelSelection';
export const LIST_META_KEY = 'sessionListMetadata';
export const TITLE_INPUT_KEY = 'titleInput';
// ── 子代理四件（`@deepseek-ai/dsh-subagent` / `dsh-tool-subagent`）──
export const SUBAGENT_IDENTITY_KEY = 'subagent';
export const SUBAGENT_TIMING_KEY = 'subagentTiming';
export const SUBAGENT_CATALOG_KEY = 'subagentCatalog';
export const SUBAGENT_POLICY_KEY = 'subagentModelSelectionPolicy';

/**
 * `todos` 单元（`@deepseek-ai/dsh-tool-todo`，stateVersion 2）——
 * `Array<{ content, status: 'pending' | 'in_progress' | 'completed' }> | null`。
 *
 * ⚠ 它是**按轮**的清单（`turn/start` 时归 `null`）⇒ **`null`/缺席 ≠ 空清单**：前者是"本轮还没写过"，
 * 显示未知；后者才是 0。这条正是本模块"未知不伪装成 0"的家规在另一个单元上的复现。
 */
function todosOf(value) {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const count = status => value.filter(item => item?.status === status).length;
	const current = value.find(item => item?.status === 'in_progress');
	return {
		total: value.length,
		pending: count('pending'),
		inProgress: count('in_progress'),
		completed: count('completed'),
		...(typeof current?.content === 'string' && current.content ? { current: current.content.slice(0, 120) } : {}),
	};
}

/**
 * `plan` 单元（`@deepseek-ai/dsh-plan-mode`，stateVersion 3）——`{ active, wanted, running, activeAtLastHeader }`。
 * **它是"计划模式开关"的状态，不是任务清单**（早先的待办清单里把它列作"运行中任务"是松了口径）；
 * 所以这里只如实报告"计划模式是否生效"，不假装它是任务列表。
 */
function planOf(value) {
	if (!value || typeof value !== 'object' || typeof value.active !== 'boolean') {
		return undefined;
	}
	return { active: value.active, ...(typeof value.wanted === 'boolean' ? { wanted: value.wanted } : {}) };
}

/** `userQuestions`：`{ questions: { active: [...], settled: [...] } }` ⇒ 只取"还等着用户回答/审批"的条数。 */
function pendingQuestionsOf(value) {
	const active = value?.questions?.active;
	return Array.isArray(active) ? active.length : undefined;
}

/**
 * `goal`（`@deepseek-ai/dsh-goal`，stateVersion 6）：`{ current, seenGoalIds, failure }`。
 * 只取当前目标文本；`current: null` 与单元缺席等价（都没有"正在跑的目标"）⇒ 一并返回 undefined。
 */
function goalOf(value) {
	const current = value?.current;
	return typeof current === 'string' && current ? current.slice(0, 200) : undefined;
}

/** `sandboxMode`（`@deepseek-ai/dsh-sandbox-policy`）：执行器的**实际**沙箱模式（单字符串，权威）。 */
function sandboxOf(value) {
	return typeof value === 'string' && value ? value : undefined;
}

/**
 * `permissions`（`@deepseek-ai/dsh-permission-presets`，stateVersion 2）：state 是
 * `{ preset?, sandbox?, approval?, seeded }`（wire view 是 `{ currentValue }`=派生出的 preset 名，这里读的是 state）。
 * 只搬三个字符串旋钮；`approval` 是**审批策略**（本机实测 `"ask"`）——不预设枚举，原样报告。
 */
function permissionsOf(value) {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const out = {};
	for (const key of ['preset', 'sandbox', 'approval']) {
		if (typeof value[key] === 'string' && value[key]) {
			out[key] = value[key];
		}
	}
	return Object.keys(out).length ? out : undefined;
}

/**
 * `llmRetry`（`@deepseek-ai/dsh-llm-retry`，stateVersion 1）：`Record<key, { retry, retryId }>`，
 * `init` 是 `{}` 且 `step/start`、`turn/end` 都归 `{}` ⇒ **非空就表示"此刻正在重试"**（很干净的运行中信号）。
 * `retry` 是第几次重试；多个 key（不同 provider/policy）时取**最大次数**并给出条数。
 */
function retryingOf(value) {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const entries = Object.values(value).filter(entry => entry && typeof entry.retry === 'number' && Number.isFinite(entry.retry));
	if (!entries.length) {
		return undefined;
	}
	return { retry: Math.max(...entries.map(entry => entry.retry)), keys: entries.length };
}

/**
 * `turnBoundary`（stateVersion 2）：`{ openTurnStartSeq, lastStepStartSeq, lastStepBoundary, lastTurn }`。
 *
 * **语义有运行时权威证据**（不是照名字猜的）：`@deepseek-ai/dsh-agent-preset-registry` 切 preset 前**先查本
 * 单元**，`openTurnStartSeq` 非 null 就**拒绝切换**（"有回合在跑就不许换 preset"，`invariant.js` 里那句
 * `boundary.openTurnStartSeq ... throw`）⇒ **非 null = 此刻确有回合正在进行**。
 *
 * 所以它是比 `llmRetry` 更粗一层的"运行中"信号：`llmRetry` 说"正在重试"，本单元说"**整轮在跑**"。
 * `lastTurn` = 已完成回合数（真机里已结束的会话给 1，同批会话一致）。
 *
 * ⚠ `openTurnStartSeq` 的 null 与**字段缺席**要分开：前者是"没有开着的回合"（已知的否），后者是未知。
 */
function turnOf(value) {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const running = Object.prototype.hasOwnProperty.call(value, 'openTurnStartSeq')
		? value.openTurnStartSeq !== null
		: undefined;
	const lastTurn = typeof value.lastTurn === 'number' && Number.isFinite(value.lastTurn) ? value.lastTurn : undefined;
	if (running === undefined && lastTurn === undefined) {
		return undefined;
	}
	return {
		...(running !== undefined ? { running } : {}),
		...(lastTurn !== undefined ? { lastTurn } : {}),
	};
}

/**
 * 物化一个 `ChunkedList<T>`（`@deepseek-ai/dsh-chunked-list`）。
 *
 * owner 的类型原文：`{ readonly values: readonly T[]; readonly previous?: ChunkedList<T> }`——
 * **每个 chunk 最多 64 个值、片内按插入序**，更早的片在 `previous` 上（不可变、共享）；**空表用 `undefined` 表示**。
 * ⇒ 沿 `previous` 链走到底再正序拼接即得插入序全量（这里只用于**计数与末尾取样**，量级很小）。
 */
function chunkedListValues(head) {
	if (!head || typeof head !== 'object' || !Array.isArray(head.values)) {
		return [];
	}
	const chunks = [];
	for (let node = head, guard = 0; node && guard < 1000; node = node.previous, guard++) {
		if (!Array.isArray(node.values)) {
			break;
		}
		chunks.push(node.values);
	}
	return chunks.reverse().flat();
}

/**
 * `subagent`（`@deepseek-ai/dsh-subagent`，stateVersion 2）：`{ identity?: {mode, label?, seq} }`。
 *
 * owner 的 schema 是 **discriminated union**：
 *   · `{mode:'one-shot', label?: string, seq}`（一次性子代理，标签可选）；
 *   · `{mode:'continuable', label: string, seq}`（**可续**子代理，标签**必填**）。
 * ⇒ 本会话**自己是子代理**时的身份（父会话不会有这个单元）。
 */
function subagentRoleOf(value) {
	const identity = value && typeof value === 'object' ? value.identity : undefined;
	if (!identity || typeof identity !== 'object') {
		return undefined;
	}
	const mode = identity.mode === 'one-shot' || identity.mode === 'continuable' ? identity.mode : undefined;
	if (!mode) {
		return undefined;
	}
	const label = typeof identity.label === 'string' && identity.label ? identity.label : undefined;
	const seq = numOrUndefined(identity.seq);
	return { mode, ...(label ? { label } : {}), ...(seq !== undefined ? { seq } : {}) };
}

/**
 * `subagentTiming`（`@deepseek-ai/dsh-subagent`，stateVersion 3）：
 * `{ settledMs, active?: {since, through}, descriptorSeen, pendingTurnStart?, lastTurnCompleted? }`。
 *
 * owner 的折叠注释：它把**子代理自己**的 turn 边界折成"活跃时长"——`active` 是**当前这一轮**的时间窗
 * （`since` 入、`through` 随事件推进）；`turn/end` 时把 `through - since` 累加进 `settledMs` 并清掉 `active`；
 * `descriptorSeen` = 是否已见过自己的 descriptor（fork 种子可能带祖先描述符，见到自己的那一刻才算起点）。
 * ⇒ **`active` 非空 = 这个子代理此刻正在跑**（与 `turnBoundary` 同类的"运行中"信号，但有时长）。
 *
 * ⚠ **`descriptorSeen !== true` 时必须整体缺席**（2026-10-11 由 p3-19 的**真数据**逼出来的）：
 * 这个单元**每个会话都有**（父会话也有，值是 `{descriptorSeen:false, settledMs:0}`）——若照搬 `settledMs`
 * 就会给**不是子代理**的会话报一个"累计 0.0s"，页面看着像"它派过子代理"。owner 的折叠注释说得很清楚：
 * `descriptorSeen` = "已经见到**自己的** descriptor"（fork 种子可能带祖先描述符，见到自己的那一刻才算起点）
 * ⇒ 它就是"**本会话是不是子代理**"的判据。
 */
function subagentTimingOf(value) {
	if (!value || typeof value !== 'object' || value.descriptorSeen !== true) {
		return undefined;
	}
	const settledMs = numOrUndefined(value.settledMs);
	const active = value.active && typeof value.active === 'object' ? value.active : undefined;
	const since = numOrUndefined(active?.since);
	const through = numOrUndefined(active?.through);
	if (settledMs === undefined && !active) {
		return undefined;
	}
	return {
		...(settledMs !== undefined ? { settledMs } : {}),
		...(active ? { running: true } : {}),
		...(active && since !== undefined && through !== undefined ? { activeMs: Math.max(0, through - since) } : {}),
		...(typeof value.lastTurnCompleted === 'boolean' ? { lastTurnCompleted: value.lastTurnCompleted } : {}),
	};
}

/**
 * `subagentCatalog`（`@deepseek-ai/dsh-subagent`，stateVersion 3）：**父会话**持有的"我派出去的直接子代理"清单。
 *
 * state = `{ inheritedEventCount, head?: ChunkedList<{childId, childCreatedAt} & ({version:0} & mode | {version:1} & (mode|'unknown'))> }`
 * （owner 的 `catalog.d.ts` 原文）；`mode` 的取值域是 `one-shot` / `continuable` / **`unknown`**（v1 才保留未知模式的孩子）。
 * ⚠ **`head` 缺席 = 空表**（owner 的 ChunkedList 明文："`undefined` represents the empty list"）⇒ 那种情况是
 * "**已知的 0 个子代理**"，而**单元缺席**才是未知。
 */
function subagentChildrenOf(value) {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const entries = chunkedListValues(value.head);
	let oneShot = 0;
	let continuable = 0;
	let unknown = 0;
	let lastChildAt;
	for (const entry of entries) {
		if (entry?.mode === 'continuable') {
			continuable++;
		} else if (entry?.mode === 'one-shot') {
			oneShot++;
		} else {
			unknown++;
		}
		const at = numOrUndefined(entry?.childCreatedAt);
		if (at !== undefined && (lastChildAt === undefined || at > lastChildAt)) {
			lastChildAt = at;
		}
	}
	return {
		count: entries.length,
		...(oneShot ? { oneShot } : {}),
		...(continuable ? { continuable } : {}),
		...(unknown ? { unknown } : {}),
		...(lastChildAt !== undefined ? { lastChildAt } : {}),
	};
}

/**
 * `subagentModelSelectionPolicy`（`@deepseek-ai/dsh-tool-subagent`，stateVersion 1）：
 * state = `AllowedModelRoute[] | null`，`AllowedModelRoute = {provider, model}`（owner 的 `model-selection.d.ts` 原文）。
 *
 * 语义："Records that this session's **delegation tool exposes child provider/model/effort selection**" ⇒
 * 本会话允许**子代理**显式选择的精确路由白名单。
 *
 * ⚠ **`null` 按"没有这条事实"处理**（返回 undefined），依据两条 owner 原文：投影 `init: () => null`（默认值就是 null），
 * 取值器写着"returns a detached route list, **or undefined for the fixed-route definition**" ⇒ 这个 `null` 与
 * "没有政策记录（固定路由）"**同义**；若报成 `{enabled:false}`，每个会话都会多一条噪声项。
 */
function subagentPolicyOf(value) {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const routes = value
		.map(route => (route && typeof route === 'object' && typeof route.provider === 'string' && route.provider
			&& typeof route.model === 'string' && route.model ? { provider: route.provider, model: route.model } : undefined))
		.filter(Boolean);
	return { routes: routes.length, ...(routes.length ? { list: routes.slice(0, 8) } : {}) };
}

/**
 * 「子代理」视图：把上面四个单元合成**一个** `subagent` 字段（任一子项都没有时该子项缺席——未知不伪装成 0）。
 *
 * 四个单元各回答一件事：**我是不是子代理**（`subagent` 身份）／**我跑了多久**（`subagentTiming`）／
 * **我派出了谁**（`subagentCatalog`）／**我允许子代理选什么模型**（`subagentModelSelectionPolicy`）。
 *
 * ⚠ **真数据现状（2026-10-11）**：本机三份投影缓存（prod home 不存在、dev 6 个会话、poc 5 个会话）里
 * 这四个单元**全是空/默认值**——没有任何会话真的派过子代理。本模块因此**只能以 owner 的 schema 为真源**
 * （zod 原文 + 类型注释 + fold 实现逐行读过），**没有真数据可验**；要验得先造出真实数据
 * （驱动一个真的用了子代理的会话）。这条如实写在这里，别把"fixture 全绿"当成"真机验过"。
 */
function subagentOf(valueOf) {
	const role = subagentRoleOf(valueOf(SUBAGENT_IDENTITY_KEY));
	const timing = subagentTimingOf(valueOf(SUBAGENT_TIMING_KEY));
	const children = subagentChildrenOf(valueOf(SUBAGENT_CATALOG_KEY));
	const policy = subagentPolicyOf(valueOf(SUBAGENT_POLICY_KEY));
	if (!role && !timing && !children && !policy) {
		return undefined;
	}
	return {
		...(role ? { role } : {}),
		...(timing ? { timing } : {}),
		...(children ? { children } : {}),
		...(policy ? { policy } : {}),
	};
}

/**
 * `titleInput`（`@deepseek-ai/dsh-session-title`，stateVersion 3）：
 * `{ first: {seq, text} | null, count: number, lastSeq: seq | null }`。
 *
 * owner 的类型注释原文：它是 **"Eligible title input stored as a bounded aggregate"**——
 * `first` = "The **oldest eligible** message, or null before any"、`count` = "Total **eligible** messages
 * folded so far"、`lastSeq` = "Seq of the **newest** eligible message"；而"eligible"的定语是
 * `SessionTitleUserMessage` = "One **eligible human text message** exposed to title providers"。
 *
 * ⚠ 所以它**不是"全部用户消息"**，而是"**有资格参与标题生成**的人类文本消息"⇒ 措辞要照这个来
 * （页面上写"参与标题的输入 N 条"，不写"用户输入 N 条"）。只取前 80 字符的文本，避免把会话内容搬进遥测。
 */
function titleInputOf(value) {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const count = typeof value.count === 'number' && Number.isFinite(value.count) && value.count >= 0 ? value.count : undefined;
	const first = value.first && typeof value.first === 'object' ? value.first : undefined;
	const firstSeq = numOrUndefined(first?.seq);
	const firstText = typeof first?.text === 'string' && first.text ? first.text.slice(0, 80) : undefined;
	const lastSeq = numOrUndefined(value.lastSeq);
	if (count === undefined && firstSeq === undefined && firstText === undefined && lastSeq === undefined) {
		return undefined;
	}
	return {
		...(count !== undefined ? { count } : {}),
		...(firstSeq !== undefined ? { firstSeq } : {}),
		...(firstText ? { firstText } : {}),
		...(lastSeq !== undefined ? { lastSeq } : {}),
	};
}

/**
 * `sessionListMetadata`（`@deepseek-ai/dsh-api-session-controller`，`key` 同名，stateVersion 1）。
 *
 * owner 的类型注释原文（`lib/types/types.d.ts` + zod `{blank: boolean, lastPromptAt: number|null}`）：
 *   · `blank` = "Whether the folded prefix contains **no turn**" ⇒ **空白会话**（产品**权威**口径）；
 *   · `lastPromptAt` = "Latest **human-authored** prompt time in the folded prefix" ⇒ **最新的人类提示时间**。
 *
 * 与本模块既有的 `isActive()`（**派生**口径：有 turn 或 token 才算用过）**互补**：`blank` 说的是
 * "折叠前缀里有没有回合"，即使 stats 读不到也能回答"这个会话是不是空的"。
 *
 * ⚠ `lastPromptAt: null` 是 owner 明确表达的"**没有人提示过**"（已知的没有），与**字段缺席**（未知）
 * 不是一回事 ⇒ 前者保 `null`，后者才 undefined。
 */
function listMetaOf(value) {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const blank = typeof value.blank === 'boolean' ? value.blank : undefined;
	const lastPromptAt = Object.prototype.hasOwnProperty.call(value, 'lastPromptAt')
		? (value.lastPromptAt === null ? null : numOrUndefined(value.lastPromptAt))
		: undefined;
	if (blank === undefined && lastPromptAt === undefined) {
		return undefined;
	}
	return {
		...(blank !== undefined ? { blank } : {}),
		...(lastPromptAt !== undefined ? { lastPromptAt } : {}),
	};
}

/**
 * `modelSelection`（`@deepseek-ai/dsh-api-session-controller`，`key: "modelSelection"`，stateVersion 2）。
 *
 * state = `{ lastUsed: {provider, model, reasoningEffort?}|null, pending: 同|null }`（owner 的 zod 原文：
 * `provider`/`model` 都是 `min(1)` 的非空字符串，`reasoningEffort` 可选）。
 *
 * 语义从 owner 的 fold **逐行读出来**（不是照名字猜的）：
 *   · `model/selection` 事件（用户选了模型）⇒ **`pending` = 那次选择**（"intent"），`lastUsed` 不动；
 *   · `request/header` 事件（真的发请求了）⇒ **`lastUsed` = 该请求实际用的 provider/model/effort**；
 *     且**当 `pending` 与这次实际用的相同就清空**。
 * ⇒ `lastUsed` = "最近一次请求**实际**用的模型"（权威，来自请求头）；
 *    **`pending` 非空 = 用户已选、但还没真正生效**（"切到 X 中"）。
 *
 * ⚠ 缓存里存的是 **state**（有 `lastUsed`/`pending`）；owner 的 wire view 是派生形态
 * （`{lastUsed, next: pending ?? lastUsed}`）——**不要读错那一层**（4.P23 的教训）。
 */
function modelSelectionOf(value) {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const pick = selection => {
		if (!selection || typeof selection !== 'object') {
			return undefined;
		}
		const provider = typeof selection.provider === 'string' && selection.provider ? selection.provider : undefined;
		const model = typeof selection.model === 'string' && selection.model ? selection.model : undefined;
		if (!provider || !model) {
			return undefined;      // owner 的 schema 要求两者都非空 ⇒ 缺一个就当这个选择不可用（不拼半个）
		}
		return {
			provider, model,
			...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
		};
	};
	const used = pick(value.lastUsed);
	const pending = pick(value.pending);
	if (!used && !pending) {
		return undefined;
	}
	return {
		...(used ? { used } : {}),
		...(pending ? { pending } : {}),
	};
}

/**
 * `inbox`（`@deepseek-ai/dsh-agent-loop`，投影 `key: "inbox"`）：
 * state = `{ 'next-turn': UserMessage[], 'next-step': UserMessage[] }`（owner 的 `inboxProjectionSchema` 原文）。
 *
 * 语义照 owner 类 `ReactLoopInbox` 的注释（不是照名字猜的）：
 *   · `nextTurn` = "Prompts **awaiting individual turns**"（等着各自开一轮的提示词）；
 *   · `nextStep` = "Input **awaiting the next step boundary**"（等下一个 step 边界的输入）；
 *   · `hasPending` = "Whether either pending-message list contains **work**"。
 * ⇒ 这就是**"用户已经发出去、还排在队里的输入"**：非空 = 用户发完在等 agent 继续跑。
 *   与 `pendingQuestions`（谁在**等用户**）方向相反，同属"谁在等"这一类。
 *
 * ⚠ **空数组是"已知的 0"**（真机每份缓存都带着这两个空数组）⇒ 报 0；**单元缺席**才是未知。
 * 只**数条数**，不碰 `UserMessage` 的字段（那是另一套 schema，没核过就不猜）。
 */
function inboxOf(value) {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const count = key => (Array.isArray(value[key]) ? value[key].length : undefined);
	const turn = count('next-turn');
	const step = count('next-step');
	if (turn === undefined && step === undefined) {
		return undefined;
	}
	return {
		...(turn !== undefined ? { turn } : {}),
		...(step !== undefined ? { step } : {}),
		// 总账只在两个数都在时给（只知一半就不算总数——不猜）。
		...(turn !== undefined && step !== undefined ? { queued: turn + step } : {}),
	};
}

/**
 * `contextBreakdown`（`@deepseek-ai/dsh-token-meter`，stateVersion 5）：
 * `{ nodes: [{ seq, heuristicTokens, system }], breakdown: { systemTokens, toolsTokens, messageTokens } }`
 * ——⚠ **三个数在 `breakdown` 子对象里**（不是顶层；真机实测 + 投影 schema `contextBreakdownStateSchema`
 * 都是这个形状，读错层会静默拿到 undefined）。
 *
 * **语义有 owner 包 README 的原文背书**（不是照名字猜的）：
 *   · `systemTokens` = surface 顺序里**最后一个非空且存活的 `system/message`**（没有就为 0）；
 *   · `messageTokens` = **其余所有可见节点**（含被取代的提示词）；
 *   · **两者之和恒等于 surface 总量**（`measure().nodes[].tokens` 之和，即 `contextPressure.surfaceTokens`）
 *     ——真机自验：697 + 2361 = 3058 ✓；
 *   · `toolsTokens` 来自 `estimateToolsTokens`（**工具定义**那部分请求量）⇒ **不在 surface 里**，
 *     别把它加进表面占比（真机 5441 远大于 surface，正是这个原因）；
 *   · 两个量都是**启发式估算**（owner 原文 "Heuristic composition of the current retained surface"）
 *     ⇒ 报数时标"估算"，不当精确值。
 *
 * 这条正是 4.P16 记的"与 contextPressure 重叠 ⇒ 不为堆字段而做"的**更正**：两者互补（一个说"占了多少"，
 * 一个说"占的是什么"）。
 */
function contextBreakdownOf(value) {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const breakdown = value.breakdown && typeof value.breakdown === 'object' ? value.breakdown : {};
	const num = key => (typeof breakdown[key] === 'number' && Number.isFinite(breakdown[key]) && breakdown[key] >= 0 ? breakdown[key] : undefined);
	const system = num('systemTokens');
	const tools = num('toolsTokens');
	const messages = num('messageTokens');
	if (system === undefined && tools === undefined && messages === undefined) {
		return undefined;
	}
	return {
		...(system !== undefined ? { system } : {}),
		...(messages !== undefined ? { messages } : {}),
		...(tools !== undefined ? { tools } : {}),
		...(Array.isArray(value.nodes) ? { nodes: value.nodes.length } : {}),
		// 文档保证 `system + messages == surface`：两个都在就把它算出来（不在场就不算——不猜）。
		...(system !== undefined && messages !== undefined ? { surface: system + messages } : {}),
	};
}

/**
 * 「运行状态」视图（所有相关单元都缺席时**整个字段缺席**——未知不伪装成 0）。
 *
 * 三类信号合在一起：**在做什么**（todos 清单 / goal 目标）、**什么状态**（turn 回合在不在跑 / plan 计划模式 /
 * approvals 审批策略 / sandbox 沙箱模式 / llmRetry 正在重试）、**谁在等**（userQuestions 待用户回答）。
 */
function activityOf(valueOf) {
	const todos = todosOf(valueOf(TODOS_KEY));
	const plan = planOf(valueOf(PLAN_KEY));
	const pendingQuestions = pendingQuestionsOf(valueOf(QUESTIONS_KEY));
	const goal = goalOf(valueOf(GOAL_KEY));
	const sandbox = sandboxOf(valueOf(SANDBOX_KEY));
	const permissions = permissionsOf(valueOf(PERMISSIONS_KEY));
	const retrying = retryingOf(valueOf(RETRY_KEY));
	const turn = turnOf(valueOf(TURN_KEY));
	const inbox = inboxOf(valueOf(INBOX_KEY));
	if (!todos && !plan && pendingQuestions === undefined && !goal && !sandbox && !permissions && !retrying && !turn && !inbox) {
		return undefined;
	}
	return {
		...(todos ? { todos } : {}),
		...(plan ? { plan } : {}),
		...(pendingQuestions !== undefined ? { pendingQuestions } : {}),
		...(goal ? { goal } : {}),
		...(sandbox ? { sandbox } : {}),
		...(permissions ? { permissions } : {}),
		...(retrying ? { retrying } : {}),
		...(turn ? { turn } : {}),
		...(inbox ? { inbox } : {}),
	};
}

/** 「运行状态」的横向清点（页面卡片用；只数**已知**的，缺席不算 0）。 */
export function activityTally(sessions) {
	const withTodos = sessions.filter(s => s.activity?.todos);
	const inProgress = withTodos.reduce((total, s) => total + (s.activity.todos.inProgress ?? 0), 0);
	const activePlans = sessions.filter(s => s.activity?.plan?.active === true).length;
	const waiting = sessions.reduce((total, s) => total + (s.activity?.pendingQuestions ?? 0), 0);
	const retrying = sessions.filter(s => s.activity?.retrying).length;
	// 横向清点沿用本文件既有口径：**只把非零项放进结果**（缺席 ≠ 0，`0 个在跑` 不进清点，避免噪音）。
	const running = sessions.filter(s => s.activity?.turn?.running === true).length;
	const turns = sessions.reduce((total, s) => total + (typeof s.activity?.turn?.lastTurn === 'number' ? s.activity.turn.lastTurn : 0), 0);
	// 排队待发的**总条数**（与 `waiting` 同口径：跨会话求和；只累加已知的）。
	const queued = sessions.reduce((total, s) => total + (typeof s.activity?.inbox?.queued === 'number' ? s.activity.inbox.queued : 0), 0);
	// 子代理三笔账（都只算**已知**的）：自己是子代理的会话数 / 其中**正在跑**的 / 派出去的子代理总数。
	const subagentSessions = sessions.filter(s => s.subagent?.role).length;
	const subagentRunning = sessions.filter(s => s.subagent?.timing?.running === true).length;
	const subagentChildren = sessions.reduce((total, s) => total + (typeof s.subagent?.children?.count === 'number' ? s.subagent.children.count : 0), 0);
	return {
		...(withTodos.length ? { todoSessions: withTodos.length, inProgress } : {}),
		...(activePlans ? { activePlans } : {}),
		...(waiting ? { waiting } : {}),
		...(retrying ? { retrying } : {}),
		...(running ? { running } : {}),
		...(turns ? { turns } : {}),
		...(queued ? { queued } : {}),
		...(subagentSessions ? { subagentSessions } : {}),
		...(subagentRunning ? { subagentRunning } : {}),
		...(subagentChildren ? { subagentChildren } : {}),
	};
}

/**
 * 由"单元取值函数"组装会话行——**缓存冷读与 live 热读共用这一套字段映射**（同一份契约只写一次，
 * 两边的差异只有 `source` 与"单元从哪来"）。
 */
function sessionFromUnits(valueOf, { id, cwd, createdAt, source }) {
	return {
		id: typeof id === 'string' ? id : undefined,
		title: typeof valueOf(TITLE_KEY) === 'string' ? valueOf(TITLE_KEY) : undefined,
		preset: typeof valueOf(PRESET_KEY) === 'string' ? valueOf(PRESET_KEY) : undefined,
		cwd: typeof cwd === 'string' ? cwd : undefined,
		createdAt: numOrUndefined(createdAt),
		/** 只有拿到至少一个已知字段才算"有统计"；否则整个子对象缺席（下游显示未知，不显示 0） */
		stats: subObject(valueOf(STATS_KEY), {
			turns: 'turns', steps: 'steps', llmMs: 'llmMs', toolMs: 'toolMs', ttftMs: 'ttftMs', decodeMs: 'decodeMs',
		}),
		tokens: subObject(valueOf(TOKENS_KEY)?.totals, {
			uncachedInput: 'uncachedInputTokens', output: 'outputTokens', cacheRead: 'cacheReadTokens', cacheWrite: 'cacheWriteTokens',
		}),
		surfaceTokens: subObject(valueOf(PRESSURE_KEY), { surfaceTokens: 'surfaceTokens' })?.surfaceTokens,
		// `contextPressure` **v5 起还带上下文窗口大小**（真机实测 `{"surfaceTokens":3058,"contextWindow":1000000}`）：
		// 只报 `surfaceTokens` 看不出"有多满"，两个数一起才能算占用率。缺就缺席（老版本/未知不伪装成 0）。
		contextWindow: subObject(valueOf(PRESSURE_KEY), { contextWindow: 'contextWindow' })?.contextWindow,
		contextBreakdown: contextBreakdownOf(valueOf(BREAKDOWN_KEY)),
		model: modelSelectionOf(valueOf(MODEL_KEY)),
		listMeta: listMetaOf(valueOf(LIST_META_KEY)),
		titleInput: titleInputOf(valueOf(TITLE_INPUT_KEY)),
		subagent: subagentOf(valueOf),
		activity: activityOf(valueOf),
		source,
	};
}

/** `{ 目标字段: 源字段 }` 映射出子对象；**全 undefined 时返回 undefined**（让"未知"保持缺席）。 */
function subObject(source, mapping) {
	if (!source || typeof source !== 'object') {
		return undefined;
	}
	const out = {};
	for (const [outKey, srcKey] of Object.entries(mapping)) {
		const value = numOrUndefined(source[srcKey]);
		if (value !== undefined) {
			out[outKey] = value;
		}
	}
	return Object.keys(out).length ? out : undefined;
}

/** 解析一个缓存文件 → `{ session }` 或 `{ error }`（坏文件带原因，不影响其它会话）。 */
export function parseSessionCache(text, { id } = {}) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { error: `不是合法 JSON：${String(e?.message ?? e)}` };
	}
	if (!raw || typeof raw !== 'object') {
		return { error: `顶层不是对象：${typeof raw}` };
	}
	if (raw.version !== SUPPORTED_CACHE_VERSION) {
		return { error: `缓存版本不认识：version=${String(raw.version)}（本模块按 v${SUPPORTED_CACHE_VERSION} 解析）` };
	}
	const record = raw.record;
	if (!record || typeof record !== 'object') {
		return { error: '缺 record' };
	}
	const identity = record.identity && typeof record.identity === 'object' ? record.identity : {};
	const rows = record.rows && typeof record.rows === 'object' ? record.rows : {};
	return {
		session: sessionFromUnits(
			key => (rows[key] && typeof rows[key] === 'object' ? rows[key].val : undefined),
			{ id, cwd: identity.cwd, createdAt: identity.createdAt, source: 'cache' },
		),
	};
}

/**
 * 把**活会话**的单元读值合并到缓存行上（**live 优先**）。
 *
 * 为什么要它：Dashbord 的主路径是冷读投影缓存（已结束的会话只能走缓存），但**正在跑的会话**最新数据
 * 在服务端的活会话里——缓存要等落盘，页面就会落后。dsh 的两个服务正好够用（API 形态已从运行时源码
 * 逐字核对，不是猜的）：`sessions.get(id)` → 活 Session 对象；`sessionProjections.stateOf(session, unit)`
 * → 该单元的当前值（与缓存 `rows[unit].val` 同形，5 个单元名两边完全一致）。
 *
 * **逐字段合并**（不是整行替换）：live 有值才覆盖；live 没给的字段**保留缓存值**——把已读到的数据抹成
 * 未知比落后更糟。另外"活会话存在"≠"已经投影过"：一个刚建、还没跑 turn 的活会话五个单元可能全是
 * undefined，这时**仍然是 cache 来源**（如实标注，别谎报 live）。
 *
 * @param sessions 缓存解析出来的行数组
 * @param getLive `(id) => 活 Session | undefined`（调用方接 `sessions.get`）
 * @param readUnit `(session, unitKey) => unknown`（调用方接 `sessionProjections.stateOf`）
 * @returns `{ sessions, live }`——`live` = 真被活服务覆盖的行数（页面/工具据此如实标注）。
 */
export function applyLiveSessions(sessions, { getLive, readUnit }) {
	let live = 0;
	const merged = sessions.map(row => {
		const session = typeof row.id === 'string' ? getLive(row.id) : undefined;
		if (!session) {
			return row;
		}
		const fromLive = sessionFromUnits(unit => readUnit(session, unit), {
			id: row.id, cwd: row.cwd, createdAt: row.createdAt, source: 'live',
		});
		const gotAny = fromLive.title !== undefined || fromLive.preset !== undefined
			|| fromLive.surfaceTokens !== undefined || fromLive.contextWindow !== undefined
			|| fromLive.contextBreakdown !== undefined || fromLive.model !== undefined || fromLive.listMeta !== undefined
			|| fromLive.titleInput !== undefined || fromLive.subagent !== undefined
			|| fromLive.stats !== undefined || fromLive.tokens !== undefined
			|| fromLive.activity !== undefined;
		if (!gotAny) {
			return row;
		}
		live++;
		return {
			...row,
			title: fromLive.title !== undefined ? fromLive.title : row.title,
			preset: fromLive.preset !== undefined ? fromLive.preset : row.preset,
			surfaceTokens: fromLive.surfaceTokens !== undefined ? fromLive.surfaceTokens : row.surfaceTokens,
			contextWindow: fromLive.contextWindow !== undefined ? fromLive.contextWindow : row.contextWindow,
			// `contextBreakdown` **整块取 live**（同 `activity` 的理由）：它的 `surface` 是由
			// `system + messages` 派生出来的——半块拼接（system 来自 live、messages 来自缓存）会算出一个
			// 自相矛盾的 surface，比"整块用一侧"更糟。
			contextBreakdown: fromLive.contextBreakdown !== undefined ? fromLive.contextBreakdown : row.contextBreakdown,
			// `model` 同样**整块取 live**：`used` 与 `pending` 是一对（"实际用的" 与 "还没生效的"），
			// 拼半个会讲出一个不存在的状态。
			model: fromLive.model !== undefined ? fromLive.model : row.model,
			// `listMeta` 同样**整块取**（`blank` 与 `lastPromptAt` 是同一份摘要提示的两半）。
			listMeta: fromLive.listMeta !== undefined ? fromLive.listMeta : row.listMeta,
			// `titleInput` 也是**有界聚合**（first/count/lastSeq 互相约束）⇒ 整块取。
			titleInput: fromLive.titleInput !== undefined ? fromLive.titleInput : row.titleInput,
			// `subagent` 是**四个单元的派生视图**（同 `activity` 的理由）⇒ 整块取 live，别拼半个。
			subagent: fromLive.subagent !== undefined ? fromLive.subagent : row.subagent,
			stats: mergeSub(row.stats, fromLive.stats, ['turns', 'steps', 'llmMs', 'toolMs', 'ttftMs', 'decodeMs']),
			tokens: mergeSub(row.tokens, fromLive.tokens, ['uncachedInput', 'output', 'cacheRead', 'cacheWrite']),
			// `activity` 是**三个单元（todos/plan/userQuestions）的派生视图**：它只是"整体存在/不存在"，
			// 子字段没有一一对应关系可合 ⇒ **整块取 live**（只要 live 侧读到任一单元就取 live 的视图）。
			// 理由：半块合出来的"运行中"状态自相矛盾（todos 来自 live、plan 来自缓存）比"整体用一侧"更危险。
			activity: fromLive.activity !== undefined ? fromLive.activity : row.activity,
			source: 'live',
		};
	});
	return { sessions: merged, live };
}

/** 子对象逐字段合并（live 有值才覆盖缓存值；两边都没有 ⇒ undefined）。 */
function mergeSub(cachedSub, liveSub, keys) {
	if (!cachedSub && !liveSub) {
		return undefined;
	}
	const out = {};
	for (const key of keys) {
		const value = liveSub?.[key] !== undefined ? liveSub[key] : cachedSub?.[key];
		if (value !== undefined) {
			out[key] = value;
		}
	}
	return Object.keys(out).length ? out : undefined;
}

function numOrUndefined(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 会话的"活跃度"：有 turn 或有 token 才算真的用过（用于汇总与排序）。 */
export function isActive(session) {
	return (session.stats?.turns ?? 0) > 0 || (session.tokens?.output ?? 0) > 0;
}

/**
 * 汇总（只累加**已知**的量；未知不当作 0——那会把"读不到"伪装成"没有消耗"）。
 * 结果稳定排序（createdAt 倒序、再按 id），保证同输入同输出。
 */
export function aggregate(sessions) {
	const sorted = [...sessions].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || String(a.id).localeCompare(String(b.id)));
	const known = key => sorted.filter(s => s.stats?.[key] !== undefined);
	const sum = (list, read) => list.length ? list.reduce((total, item) => total + (read(item) ?? 0), 0) : undefined;
	return {
		sessions: sorted.length,
		active: sorted.filter(isActive).length,
		turns: sum(known('turns'), s => s.stats.turns),
		steps: sum(known('steps'), s => s.stats.steps),
		llmMs: sum(known('llmMs'), s => s.stats.llmMs),
		toolMs: sum(known('toolMs'), s => s.stats.toolMs),
		tokens: {
			uncachedInput: sum(sorted.filter(s => s.tokens?.uncachedInput !== undefined), s => s.tokens.uncachedInput),
			output: sum(sorted.filter(s => s.tokens?.output !== undefined), s => s.tokens.output),
			cacheRead: sum(sorted.filter(s => s.tokens?.cacheRead !== undefined), s => s.tokens.cacheRead),
			cacheWrite: sum(sorted.filter(s => s.tokens?.cacheWrite !== undefined), s => s.tokens.cacheWrite),
		},
		sorted,
	};
}

/** 毫秒 → 人读（`1.2s` / `340ms` / 未知）。 */
/**
 * 页面的「日期范围」筛选（**纯函数**：页面链接与 `/api/sessions` **共用这一份** ✓）。
 *
 * 口径按**本地日界**：`today` = 今天 0 点起 ✓；`7d` / `30d` = **含今天在内**的 7 / 30 个自然日 ✓。
 * 为什么不是"now − 7×24h"：页面上写的是"7 天"，人按自然日理解 ✓；两种口径在跨零点时会差一天 ✓，
 * 而"**为什么昨天下午的会话不见了**"是最难解释的那类问题 ✓。
 *
 * ⚠ **没有 `createdAt` 的会话**（缓存可能缺 `identity.createdAt` ✓）在 `all` 里保留 ✓，
 * 带范围的三档里**必须排除** ✓ —— 不能把"不知道什么时候"当成"刚刚" ✗（"未知伪装成 0"的亲戚 ✓）。
 *
 * @returns `{ sessions }`；范围不认识则 `{ error }`（**明确失败**，不静默当 `all` ✗）
 */
export function filterSessionsByRange(sessions, range, now = Date.now()) {
	const DAY = 86_400_000;
	const startOfDay = ms => {
		const d = new Date(ms);
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	};
	const today = startOfDay(now);
	const sinceOf = { today: today, '7d': today - 6 * DAY, '30d': today - 29 * DAY };
	if (range === undefined || range === '' || range === 'all') {
		return { sessions };
	}
	if (!(range in sinceOf)) {
		return { error: `不认识的日期范围：${range}（可用：today / 7d / 30d / all）` };
	}
	const since = sinceOf[range];
	return { sessions: sessions.filter(s => typeof s.createdAt === 'number' && s.createdAt >= since) };
}

/** 页面上的四个范围档（顺序即展示顺序 ✓；`range` 值就是 API 的参数值 ✓ —— 一处定义、两处用 ✓）。 */
export const DATE_RANGES = [
	{ range: 'today', label: '今日' },
	{ range: '7d', label: '7 天' },
	{ range: '30d', label: '30 天' },
	{ range: 'all', label: '全部' },
];

export function formatMs(ms) {
	if (typeof ms !== 'number' || !Number.isFinite(ms)) {
		return '未知';
	}
	if (ms < 1000) {
		return `${Math.round(ms)}ms`;
	}
	const seconds = ms / 1000;
	if (seconds < 60) {
		return `${seconds.toFixed(1)}s`;
	}
	return `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}

/** token 数 → 人读（`12.3k`）。 */
export function formatTokens(n) {
	if (typeof n !== 'number' || !Number.isFinite(n)) {
		return '未知';
	}
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
