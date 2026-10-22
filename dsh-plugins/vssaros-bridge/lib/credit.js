// @vssaros/dsh-bridge — 积分账本（Host 侧；2026-10-20）
//
// ── 为什么在 Host 侧做 ─────────────────────────────────────────────────────────
// 积分（网关 SSE 末块的 `usage.credit`）只有 VsSaros 主进程的计费代理读得到（dsh 的 `mapUsage`
// 在最底层就把它丢了）。但代理**不知道这次响应属于哪个会话** —— 以前只能广播给所有聊天页，
// 由页面按"时间窗 + 模型名"去猜，同模型并发就算错/算重，且样本只活在内存里（重启即丢）。
//
// Host 侧恰好有代理缺的那一半：`llm/stream` waterfall 能看到**每一次** LLM 调用的
// `sessionId` / provider / model 与精确起止时刻。于是：
//   代理抓到样本 → 经桥 `credit.record` 送到这里 → 与调用区间匹配出 (会话, 回合)
//   → `appendPluginRecord` 写进**该会话的日志**（官方 API，持久化、重启后仍在）
//   → 自定义投影 `vssaros-credit`（带 wire）把"每回合积分"自动推给页面。
//
// 本文件只放**纯逻辑**（匹配 + 投影），不 import 任何东西 ⇒ 单测可直接加载；
// 与 Host 服务的接线（取会话、写记录、注册投影）在 index.js 里。

/** 会话日志里的记录类型（官方插件记录语法：`plugin:<命名空间>/<名字>`，自动标 ignorable）。 */
export const CREDIT_RECORD_TYPE = 'plugin:vssaros/credit';
/** 投影 key（页面侧 `props.useProjection(...)` 用的就是它；两侧有契约测试钉住字面一致）。 */
export const CREDIT_PROJECTION_KEY = 'vssaros-credit';
/** 投影状态版本：状态形状变了就 +1（dsh 会丢弃旧检查点重新折叠，不会读错）。 */
export const CREDIT_STATE_VERSION = 1;

/** 样本 at 早于调用开始多少仍算同一次（两进程时钟同源，留一点舍入余量）。 */
const SLACK_BEFORE_MS = 1_000;
/** 调用结束后多久内到达的样本仍可归给它（桥消息排队 + 代理读尾巴）。 */
const SLACK_AFTER_MS = 5_000;
/** 匹配不上的样本最多等多久（等对应调用结束）。 */
const PENDING_TTL_MS = 10_000;
/** 已结束的调用保留多久（只为匹配迟到的样本）。 */
const ENDED_RETAIN_MS = 60_000;
/** 未结束的调用最多保留多久（消费者没读完流时 finally 不会跑，防泄漏）。 */
const OPEN_RETAIN_MS = 10 * 60_000;
const MAX_CALLS = 64;
const MAX_PENDING = 32;

/**
 * 模型名同族：相等，或一方是另一方加 `-后缀`（网关常加 `-ioa` 之类：`deepseek-v4-flash` ↔ `deepseek-v4-flash-ioa`）。
 * 任一方缺失 ⇒ 视为不冲突（只有两边都给了且对不上才排除）。
 */
export function sameModelFamily(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) {
		return true;
	}
	return a === b || a.startsWith(b + '-') || b.startsWith(a + '-');
}

/** 积分累加（去掉浮点尾巴：0.15 + 0.15 不该显示成 0.30000000000000004）。 */
function addCredit(prev, delta) {
	return Math.round(((prev === null ? 0 : prev) + delta) * 1e6) / 1e6;
}

/**
 * `vssaros-credit` 投影定义：fold 会话日志 ⇒ `{ lastTurn, byTurn: { [turn]: { credit, responses } }, outside }`。
 *
 * 回合归属规则（按优先级）：
 *  1. 记录里带了正整数 `turn` ⇒ 用它（账本在调用发起那一刻从 `turnBoundary` 读的，最准）；
 *  2. 记录里 `turn === null` ⇒ 账本**确认**那次调用不在任何回合里（如回合外的标题生成）⇒ 记 `outside`；
 *  3. 记录里没有 `turn` 字段（账本读不到回合）⇒ 归给最近一次 `turn/start` 的回合。
 *
 * `credit === null` = 这些响应都没带积分字段（与"积分 0"必须区分 ⇒ 页面显示 `—`）。
 * 不相关的事件**必须返回同一引用**（dsh 靠 `Object.is` 抑制下游发布）。
 */
export function creditProjection() {
	return {
		key: CREDIT_PROJECTION_KEY,
		stateVersion: CREDIT_STATE_VERSION,
		// 状态是纯 JSON；dsh 读持久化检查点时会 `stateSchema.parse(row.val)`，identity 即可。
		stateSchema: { parse: value => value },
		init: () => ({ lastTurn: 0, byTurn: {}, outside: { credit: null, responses: 0 } }),
		apply(state, event) {
			if (!event || typeof event.type !== 'string') {
				return state;
			}
			if (event.type === 'turn/start') {
				const t = event.data && typeof event.data.turn === 'number' ? event.data.turn : null;
				return t === null || t === state.lastTurn ? state : { ...state, lastTurn: t };
			}
			// 只认**官方插件记录**（`ignorable: true`）：同名但不是插件记录的事件不是我们写的。
			if (event.type !== CREDIT_RECORD_TYPE || event.ignorable !== true) {
				return state;
			}
			const data = event.data && typeof event.data === 'object' ? event.data : {};
			const delta = typeof data.credit === 'number' && Number.isFinite(data.credit) ? data.credit : null;
			const bump = (cell) => ({
				credit: delta === null ? cell.credit : addCredit(cell.credit, delta),
				responses: cell.responses + 1,
			});
			let turn;
			if (typeof data.turn === 'number' && Number.isInteger(data.turn) && data.turn > 0) {
				turn = data.turn;
			} else if (data.turn === null) {
				return { ...state, outside: bump(state.outside) };
			} else {
				turn = state.lastTurn;
			}
			if (!turn) {
				return { ...state, outside: bump(state.outside) };
			}
			const prev = state.byTurn[turn] || { credit: null, responses: 0 };
			return { ...state, byTurn: { ...state.byTurn, [turn]: bump(prev) } };
		},
		// 带 wire ⇒ 自动下发给页面（控制流 + 连接 baseline + `session/projections` RPC），页面零接线。
		wire: {
			viewSchema: { parse: value => value },
			view: state => ({ byTurn: state.byTurn, outside: state.outside }),
		},
	};
}

/**
 * 积分账本：记录 LLM 调用区间，把代理送来的样本匹配到 (会话, 回合)，再写进会话日志。
 *
 * @param {object} deps
 * @param {() => number} deps.now - 时钟（单测可注入）
 * @param {(sessionId: string) => number | null | undefined} deps.turnOf -
 *   当前回合号；`null` = 确认不在回合里；`undefined` = 读不到（记录里就不写 turn 字段）
 * @param {(sessionId: string, data: object) => boolean} deps.append - 写一条插件记录；成功返回 true
 * @param {(line: string) => void} [deps.log]
 */
export function createCreditLedger(deps) {
	const now = deps.now || Date.now;
	const log = deps.log || (() => { });
	/** @type {Array<{ sessionId: string, provider?: string, model?: string, purpose?: string, turn: number|null|undefined, start: number, end: number|null, samples: number }>} */
	const calls = [];
	/** @type {Array<{ sample: object, expires: number }>} */
	const pending = [];
	const stats = { calls: 0, samples: 0, matched: 0, appended: 0, ambiguous: 0, unmatched: 0, appendFailed: 0 };

	const prune = () => {
		const t = now();
		for (let i = calls.length - 1; i >= 0; i--) {
			const c = calls[i];
			const stale = c.end === null ? t - c.start > OPEN_RETAIN_MS : t - c.end > ENDED_RETAIN_MS;
			if (stale) {
				calls.splice(i, 1);
			}
		}
		while (calls.length > MAX_CALLS) {
			calls.shift();
		}
		for (let i = pending.length - 1; i >= 0; i--) {
			if (pending[i].expires <= t) {
				const [expired] = pending.splice(i, 1);
				stats.unmatched++;
				log(`credit: 样本无法归属到任何会话调用（route=${expired.sample.route} model=${expired.sample.model ?? '?'}，已丢弃）`);
			}
		}
	};

	/** 给样本挑调用：同 route、模型同族、时间落在区间内；优先还没配到样本的，再按"离结束最近"。 */
	const pick = (sample) => {
		const candidates = calls.filter(c =>
			(!c.provider || !sample.route || c.provider === sample.route)
			&& sameModelFamily(c.model, sample.model)
			&& sample.at >= c.start - SLACK_BEFORE_MS
			&& (c.end === null || sample.at <= c.end + SLACK_AFTER_MS));
		if (candidates.length === 0) {
			return undefined;
		}
		const fresh = candidates.filter(c => c.samples === 0);
		const pool = fresh.length > 0 ? fresh : candidates;
		const distance = c => c.end === null ? 0 : Math.abs(c.end - sample.at);
		pool.sort((a, b) => distance(a) - distance(b) || b.start - a.start);
		const sessions = new Set(pool.map(c => c.sessionId));
		return { call: pool[0], ambiguous: sessions.size > 1 };
	};

	const attribute = (sample) => {
		const hit = pick(sample);
		if (!hit) {
			return undefined;
		}
		const { call, ambiguous } = hit;
		call.samples++;
		stats.matched++;
		if (ambiguous) {
			stats.ambiguous++;
		}
		const data = {
			route: sample.route,
			at: sample.at,
			...(call.turn === undefined ? {} : { turn: call.turn }),
			...(sample.credit === undefined ? {} : { credit: sample.credit }),
			...(sample.model === undefined ? {} : { model: sample.model }),
			...(sample.status === undefined ? {} : { status: sample.status }),
			...(call.purpose ? { purpose: call.purpose } : {}),
			...(ambiguous ? { ambiguous: true } : {}),
		};
		let appended = false;
		try {
			appended = deps.append(call.sessionId, data) === true;
		} catch (e) {
			appended = false;
			log(`credit: 写会话记录失败（${call.sessionId}）：${String(e && e.message || e)}`);
		}
		if (appended) {
			stats.appended++;
		} else {
			stats.appendFailed++;
		}
		return { matched: true, appended, sessionId: call.sessionId, turn: call.turn ?? null, ambiguous };
	};

	const retryPending = () => {
		for (let i = pending.length - 1; i >= 0; i--) {
			const r = attribute(pending[i].sample);
			if (r) {
				pending.splice(i, 1);
			}
		}
	};

	return {
		/**
		 * 一次 LLM 调用开始（`llm/stream` 监听里调）。没有 sessionId 的调用（手工一次性调用）不记账。
		 * @returns 句柄（调用结束时 `end()`），或 undefined
		 */
		beginCall(opts) {
			const sessionId = opts && opts.sessionId !== undefined && opts.sessionId !== null ? String(opts.sessionId) : '';
			if (!sessionId) {
				return undefined;
			}
			prune();
			let turn;
			try {
				turn = deps.turnOf(sessionId);
			} catch {
				turn = undefined;
			}
			const call = {
				sessionId,
				...(typeof opts.provider === 'string' && opts.provider ? { provider: opts.provider } : {}),
				...(typeof opts.model === 'string' && opts.model ? { model: opts.model } : {}),
				...(typeof opts.purpose === 'string' && opts.purpose ? { purpose: opts.purpose } : {}),
				turn: typeof turn === 'number' && turn > 0 ? turn : (turn === null ? null : undefined),
				start: now(),
				end: null,
				samples: 0,
			};
			calls.push(call);
			stats.calls++;
			let ended = false;
			return {
				end() {
					if (ended) {
						return;
					}
					ended = true;
					call.end = now();
					retryPending();
				},
			};
		},

		/**
		 * 代理送来一个样本（桥 `credit.record`）。匹配不上先挂起（等对应调用结束），过期丢弃。
		 * @returns 归属结果（诊断；宿主会打进日志）
		 */
		recordSample(raw) {
			const sample = normalizeSample(raw);
			if (!sample) {
				return { matched: false, reason: 'invalid sample' };
			}
			stats.samples++;
			prune();
			const r = attribute(sample);
			if (r) {
				return r;
			}
			pending.push({ sample, expires: now() + PENDING_TTL_MS });
			while (pending.length > MAX_PENDING) {
				pending.shift();
				stats.unmatched++;
			}
			return { matched: false, pending: true };
		},

		/** 诊断快照（不含会话内容）。 */
		snapshot() {
			return { ...stats, openCalls: calls.filter(c => c.end === null).length, pending: pending.length };
		},
	};
}

/** 桥负载 → 样本；形状不对一律丢（一个 NaN 就能把整轮积分算成 null）。 */
export function normalizeSample(raw) {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	if (typeof raw.route !== 'string' || !raw.route || typeof raw.at !== 'number' || !Number.isFinite(raw.at)) {
		return undefined;
	}
	return {
		route: raw.route,
		at: raw.at,
		...(typeof raw.model === 'string' && raw.model ? { model: raw.model } : {}),
		...(typeof raw.credit === 'number' && Number.isFinite(raw.credit) ? { credit: raw.credit } : {}),
		...(typeof raw.status === 'number' ? { status: raw.status } : {}),
	};
}

/**
 * 包一层 `llm/stream` 返回的流：流结束（正常/出错/被取消）时通知账本。
 * 只观察、不改 chunk（loop 发出的请求是冻结的，listener 只能读）。
 */
export function observeStream(inner, handle) {
	if (!handle) {
		return inner;
	}
	return (async function* () {
		try {
			yield* inner;
		} finally {
			handle.end();
		}
	})();
}
