// 真源：work item 的账本状态机（去重 / 退避 / attempts / 崩溃恢复）。
//
// 这里是**唯一实现**。`vssaros-loop` 与群聊（`vssaros-agents`）都通过 cordis 服务
// `vssarosWorkItems` 拿它 —— 插件之间不能互相 import（profile 里没有跨包解析路径），
// 而复制一份就会分叉：loop 说"做过了"、群聊说"没做过"，正是要消灭的那类不一致。
//
// 为什么必须机器化去重：无人值守循环最容易出的不是"跑不动"，而是**同一件事被反复做**。
// 靠"模型记得别重复"不可靠 —— 框架层强制去重是唯一答案。
//
// 两条铁律：
//   1. 每次状态变化都落盘（落盘由调用方负责，本模块只算状态）；
//   2. 启动时把残留的 `running` 一律归正为 `failed`（保留 attempts）—— 进程被杀时没有机会
//      写"我死了"，只能靠恢复时的这条规则把账算清。

export const LEDGER_VERSION = 1;

/** 终态：`done` 永不再做（dedupe=forever）。 */
export const TERMINAL = new Set(['done']);
/** 人工持有：`blocked` 不再自动重试，等人显式放回（`loop_answer` / 群里回答）。 */
export const HOLD = new Set(['blocked']);

export function createLedger() {
	return { version: LEDGER_VERSION, items: {} };
}

/**
 * 把磁盘上的 JSON 规整成可用的账本。
 * 坏文件 → 空账本 + warning（**不抛**：读不懂账本不该让整个 loop/群起不来，
 * 但必须如实报告，否则表现成"去重突然失效"——那是最坏的一种静默）。
 */
export function normalizeLedger(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { ledger: createLedger(), warning: 'ledger 不是对象，已重置为空账本（去重历史丢失）' };
	}
	const items = raw.items && typeof raw.items === 'object' && !Array.isArray(raw.items) ? raw.items : {};
	const clean = {};
	for (const [key, entry] of Object.entries(items)) {
		if (!key || !entry || typeof entry !== 'object') {
			continue;
		}
		clean[key] = {
			status: typeof entry.status === 'string' ? entry.status : 'failed',
			attempts: Number.isInteger(entry.attempts) ? entry.attempts : 0,
			sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
			lastError: typeof entry.lastError === 'string' ? entry.lastError : '',
			firstSeenAt: typeof entry.firstSeenAt === 'string' ? entry.firstSeenAt : '',
			updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
			// 完成标记原文（`[item:done]` / `[item:failed:...]`），审计用
			marker: typeof entry.marker === 'string' ? entry.marker : '',
			// 来源：'loop' | 'group'（同一个 key 可能来自两种驱动，互不覆盖但可见）
			source: typeof entry.source === 'string' ? entry.source : '',
		};
	}
	return {
		ledger: { version: LEDGER_VERSION, items: clean },
		warning: raw.version === LEDGER_VERSION ? '' : `ledger 版本 ${JSON.stringify(raw.version)} 非 ${LEDGER_VERSION}，已按当前版本读取`,
	};
}

export const entryOf = (ledger, key) => ledger?.items?.[key] ?? null;

/**
 * 这个 key 本轮该不该跳过。返回原因字符串（跳过）或 `null`（可做）。
 *
 * 判定顺序：终态 → 人工持有 → attempts 耗尽 → 退避未到。
 * `policy` 只需 `{ maxAttempts, retryBackoffS }`（loop 直接传整个 spec 也可以）。
 */
export function skipReasonOf(entry, policy, nowMs) {
	if (!entry) {
		return null;
	}
	const maxAttempts = Number(policy?.maxAttempts ?? 2);
	const retryBackoffS = Number(policy?.retryBackoffS ?? 1800);
	if (TERMINAL.has(entry.status)) {
		return 'ledger:done';
	}
	if (HOLD.has(entry.status)) {
		return 'ledger:blocked（等待人工回答）';
	}
	if (entry.attempts >= maxAttempts) {
		return `attempts-exhausted（${entry.attempts}/${maxAttempts}）`;
	}
	if (entry.status === 'failed' && entry.updatedAt) {
		const updated = Date.parse(entry.updatedAt);
		if (Number.isFinite(updated)) {
			const dueAt = updated + retryBackoffS * 1000;
			if (nowMs < dueAt) {
				return `backoff（${Math.ceil((dueAt - nowMs) / 1000)}s 后重试）`;
			}
		}
	}
	return null;
}

function upsert(ledger, key, patch, nowMs) {
	const at = new Date(nowMs).toISOString();
	const prev = ledger.items[key];
	ledger.items[key] = {
		status: 'failed',
		attempts: 0,
		sessionId: '',
		lastError: '',
		firstSeenAt: prev?.firstSeenAt || at,
		updatedAt: at,
		marker: '',
		source: '',
		...prev,
		...patch,
		// ⚠ 这两个字段**永远由本函数决定**，不能被 patch 覆盖
		firstSeenAt: prev?.firstSeenAt || at,
		updatedAt: at,
	};
	return ledger.items[key];
}

export const markRunning = (ledger, key, { sessionId = '', source = '' } = {}, nowMs = Date.now()) =>
	upsert(ledger, key, { status: 'running', sessionId, source, lastError: '', marker: '' }, nowMs);

export const markDone = (ledger, key, { sessionId = '', source = '', marker = '[item:done]' } = {}, nowMs = Date.now()) =>
	upsert(ledger, key, { status: 'done', sessionId, source, marker, lastError: '' }, nowMs);

export function markFailed(ledger, key, { sessionId = '', source = '', reason = '', marker = '' } = {}, nowMs = Date.now()) {
	const attempts = (ledger.items[key]?.attempts ?? 0) + 1;
	return upsert(ledger, key, { status: 'failed', attempts, sessionId, source, marker, lastError: reason }, nowMs);
}

export const markBlocked = (ledger, key, { sessionId = '', source = '', reason = '', marker = '' } = {}, nowMs = Date.now()) =>
	upsert(ledger, key, { status: 'blocked', sessionId, source, marker, lastError: reason }, nowMs);

/**
 * 启动恢复：`running` → `failed`（attempts 保留，按退避重试）。
 *
 * ⚠ **不补跑**错过的轮次：重启后直接算下一个 dueAt。补跑会在"改了 schedule 或机器睡了一夜"
 * 时一次性放出 N 轮，比"漏一轮"严重得多。
 */
export function recoverOnStart(ledger, nowMs = Date.now()) {
	const recovered = [];
	for (const [key, entry] of Object.entries(ledger.items)) {
		if (entry.status !== 'running') {
			continue;
		}
		ledger.items[key] = {
			...entry,
			status: 'failed',
			attempts: (entry.attempts ?? 0) + 1,
			lastError: entry.lastError || 'interrupted（进程重启时仍在 running）',
			updatedAt: new Date(nowMs).toISOString(),
		};
		recovered.push(key);
	}
	return recovered;
}

/** 面板/工具回执用的计数。 */
export function summarizeLedger(ledger) {
	const counts = { total: 0, done: 0, failed: 0, blocked: 0, running: 0 };
	for (const entry of Object.values(ledger?.items ?? {})) {
		counts.total += 1;
		if (counts[entry.status] !== undefined) {
			counts[entry.status] += 1;
		}
	}
	return counts;
}
