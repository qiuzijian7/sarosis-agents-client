/**
 * `waitFor` / 动作后**自动沉降**（settle）的页内探针与轮询（2026-10-14，P0-①②）。
 *
 * ## 为什么需要它
 *
 * 用户与真机的典型失败模式（调研开源实现后的结论，见 README 4.94）：
 *   ① 模型"点了立刻 snapshot" ⇒ 拿到的是**旧 DOM**（SPA 抖动 ⇒ ref 全部失效 ⇒ 循环重试）；
 *   ② 没有等待语义 ⇒ 长页面/慢资源时模型只能盲等（sleep + 再看一次）；
 *   ③ `snapshot` 是整页回灌 ⇒ 多数时候模型要的只是"那个『关注』按钮在哪"（一行 ref）。
 *
 * 前两条由本模块解决（`waitFor` 与 `settleAfterAction`），第 ③ 条由 `core/findInSnapshot.js` 解决。
 *
 * ## 边界（都是刻意的）
 *
 * · 页内脚本**由本插件生成**（不接收调用方给的 JS）⇒ 不受 `allowEvaluate` 约束（那个开关管的是
 *   "**调用方给的**任意 JS" ✓；这里是固定语句 ✓）；
 * · 不引入 CDP 事件通道（`CdpConnection` 只有 JSON-RPC 关联，**没有事件订阅**）⇒ **没有 networkIdle**
 *   这一档（想做就得加事件管线 —— 那是另一个立项，别用轮询**伪装**它有 ✗）；
 * · 全部上限有界（`WAIT_*` / `SETTLE_*` 常量）；超时**报清楚哪个条件没到**，不让模型瞎等。
 */

/** waitFor 的默认超时（ms）。 */
export const WAIT_DEFAULT_TIMEOUT_MS = 5_000;
/** waitFor 的超时上限（ms）：再长就不是"慢"，而是"页面没按预期变化" ⇒ 该失败，而不是挂住整轮。 */
export const WAIT_MAX_TIMEOUT_MS = 30_000;
/** waitFor 的超时下限（ms）。 */
export const WAIT_MIN_TIMEOUT_MS = 200;
/** waitFor / settle 的轮询间隔（ms）。 */
export const WAIT_POLL_MS = 150;
/** 动作后自动沉降的默认总预算（ms）。 */
export const SETTLE_DEFAULT_MS = 400;
/** 动作后自动沉降的总预算上限（ms）。 */
export const SETTLE_MAX_MS = 3_000;
/** settle 判定"稳了"需要的连续相同次数。 */
export const SETTLE_STABLE_TICKS = 2;

/** 探针用的 settle 探针脚本（每次调用都取**同一份**页面状态指纹 —— 纯读取、无副作用 ✓）。 */
const SETTLE_PROBE = '(() => String(document.readyState) + ":" + String(document.querySelectorAll("*").length) + ":" + String(document.body ? document.body.innerText.length : 0))()';

/** 把"等什么"写成一句人话（超时错误与日志都用它 ⇒ 别各处各写一份）。 */
function describeConds(conds) {
	const parts = [];
	if (conds.text !== undefined) { parts.push(`text 含「${conds.text.slice(0, 60)}」`); }
	if (conds.textGone !== undefined) { parts.push(`text 不含「${conds.textGone.slice(0, 60)}」`); }
	if (conds.selector !== undefined) { parts.push(`selector 命中且可见「${conds.selector.slice(0, 60)}」`); }
	if (conds.urlContains !== undefined) { parts.push(`url 含「${conds.urlContains.slice(0, 60)}」`); }
	if (conds.delayMs !== undefined) { parts.push(`delay ${conds.delayMs}ms`); }
	return parts.join('，且 ');
}

/**
 * `waitFor` 参数的归一化 —— **必须先于任何页内调用跑**（否则模型会为一个必然被拒的调用点等满超时）。
 *
 * 规则：至少要给一条条件（`text` / `textGone` / `selector` / `urlContains` / `delayMs` 之一）；
 * 多条一起给是 **AND** 语义（都成立才算完，文案里写清楚 ✓）。坏值一律**报错**（不猜、不静默 ✗）。
 */
export function normalizeWaitConditions(params) {
	const text = typeof params?.text === 'string' && params.text.trim() ? params.text.trim() : undefined;
	const textGone = typeof params?.textGone === 'string' && params.textGone.trim() ? params.textGone.trim() : undefined;
	const selector = typeof params?.selector === 'string' && params.selector.trim() ? params.selector.trim() : undefined;
	const urlContains = typeof params?.urlContains === 'string' && params.urlContains.trim() ? params.urlContains.trim() : undefined;
	const delayMs = normalizeBoundedInt(params?.delayMs, 0, WAIT_MAX_TIMEOUT_MS);
	const timeoutMs = normalizeBoundedInt(params?.timeoutMs, WAIT_MIN_TIMEOUT_MS, WAIT_MAX_TIMEOUT_MS) ?? WAIT_DEFAULT_TIMEOUT_MS;
	if (text === undefined && textGone === undefined && selector === undefined && urlContains === undefined && delayMs === undefined) {
		throw new Error('browser.waitFor 需要**至少一条**条件：`text`（要等出现的文本）/ `textGone`（要等消失的文本）'
			+ '/ `selector`（要等出现的元素选择器）/ `urlContains`（要等 URL 里出现）/ `delayMs`（纯等待）。');
	}
	if (params?.timeoutMs !== undefined && timeoutMs !== params?.timeoutMs) {
		// 夹在上下限里 ≠ 报错：这不是安全问题，只是一次"要得太多"（如实夹住即可 ✓；把夹值写进返回值让日志/文案可复核）。
	}
	return { text, textGone, selector, urlContains, delayMs, timeoutMs };
}

/** 有界整数归一（非法 ⇒ 报错；不在区间 ⇒ 夹住）。 */
function normalizeBoundedInt(raw, min, max) {
	if (raw === undefined || raw === null) { return undefined; }
	const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : Number.NaN;
	if (!Number.isFinite(n)) { throw new Error(`browser.waitFor 的 timeoutMs/delayMs 必须是非负整数（收到 ${JSON.stringify(raw)}）`); }
	return Math.min(Math.max(n, min), max);
}

/**
 * 把条件编译成**一段页内布尔表达式**（纯函数 ⇒ 可单测）。
 *
 * ⚠ 所有模型给的值都经 `JSON.stringify` 落进 JS 字符串字面量 ⇒ 不存在注入面 ✓。
 * ⚠ 脚本里**不能**出现反引号或 `${`（外层是模板串；保持与 `SNAPSHOT_SCRIPT` 同一纪律）。
 */
export function buildWaitPredicate(conds) {
	const parts = [];
	if (conds.text !== undefined) {
		parts.push(`(document.body && String(document.body.innerText || "").toLowerCase().includes(${JSON.stringify(conds.text.toLowerCase())}))`);
	}
	if (conds.textGone !== undefined) {
		parts.push(`!(document.body && String(document.body.innerText || "").toLowerCase().includes(${JSON.stringify(conds.textGone.toLowerCase())}))`);
	}
	if (conds.selector !== undefined) {
		// 选择器**非法**时 `querySelector` 会抛 SyntaxError ⇒ 由 `_evaluate` 转成异常 ⇒ 我们把它译成可读错误
		//（"校验必须先于等满超时" ✓ —— 别让一个非法选择器白等 30s ✗）。
		parts.push(`(function(){ var el = document.querySelector(${JSON.stringify(conds.selector)}); if (!el) { return false; } var r = el.getBoundingClientRect(); var s = getComputedStyle(el); return r.width >= 2 && r.height >= 2 && s.visibility !== "hidden" && s.display !== "none"; })()`);
	}
	if (conds.urlContains !== undefined) {
		parts.push(`String(location.href).includes(${JSON.stringify(conds.urlContains)})`);
	}
	return `(() => (${parts.join(' && ')}))()`;
}

/**
 * 轮询直到条件成立或超时。
 *
 * @param {(expr: string) => Promise<unknown>} evalBool 页内求值回调（**调用方注入** ⇒ 探针用 stub 测 ✓）
 * @param {ReturnType<typeof normalizeWaitConditions>} conds 归一后的条件
 * @returns {Promise<{ waitedMs: number, met: string }>}
 */
export async function waitForCondition(evalBool, conds) {
	const t0 = Date.now();
	const deadline = t0 + conds.timeoutMs;
	if (conds.delayMs !== undefined) { await new Promise(r => setTimeout(r, conds.delayMs)); }
	if (conds.delayMs !== undefined && conds.text === undefined && conds.textGone === undefined
		&& conds.selector === undefined && conds.urlContains === undefined) {
		return { waitedMs: Date.now() - t0, met: describeConds(conds) };
	}
	const expr = buildWaitPredicate(conds);
	for (;;) {
		let value;
		try {
			value = await evalBool(expr);
		} catch (e) {
			throw new Error(`browser.waitFor 的页内判据失败（selector 非法 / 页面正在导航都会走到这里）：${errText(e)}。条件原样：${describeConds(conds)}`);
		}
		if (value === true) { return { waitedMs: Date.now() - t0, met: describeConds(conds) }; }
		if (Date.now() >= deadline) {
			throw new Error(`browser.waitFor 超时（${conds.timeoutMs}ms）：条件未达成 —— ${describeConds(conds)}。`
				+ '页面可能没按预期变化；先 `snapshot` 看全貌，再决定下一步（**别**把超时调大去赌 ✗）。');
		}
		await new Promise(r => setTimeout(r, WAIT_POLL_MS));
	}
}

/**
 * 动作后自动沉降：等到页面指纹**连续 N 次相同**（或预算耗尽）就返回。
 *
 * ⚠ 它**不是**"页面加载完成"的判据 —— 那件事在 `client._waitReady` 里（且那边超时不抛 ✓）。这里回答的是
 * 另一个问题："我刚点了一下，DOM 还在抖吗？" ⇒ 不抖了才值得去读它（否则 snapshot 拿到的还是旧帧 ✗）。
 *
 * 刻意**不抛错**：沉降失败（预算耗尽仍不稳定）不构成失败 —— 它只是"信息可能旧"。
 *
 * @param {(expr: string) => Promise<unknown>} evalBool 页内求值回调
 * @param {number} maxMs 总预算（0 ⇒ **立刻返回、不轮询** ⇒ 给"关掉沉降"留的口子 ✓）
 * @returns {Promise<{ settledMs: number, stable: boolean }>}
 */
export async function settleAfterAction(evalBool, maxMs) {
	if (!Number.isFinite(maxMs) || maxMs <= 0) { return { settledMs: 0, stable: true }; }
	const budget = Math.min(Math.floor(maxMs), SETTLE_MAX_MS);
	const deadline = Date.now() + budget;
	let last;
	let stable = 0;
	const t0 = Date.now();
	for (;;) {
		let value;
		try {
			value = String(await evalBool(SETTLE_PROBE));
		} catch {
			value = '<unreachable>';   // 导航中执行上下文会短暂销毁 ⇒ 视为"还在变" ✓（不算稳定）
		}
		if (value === last) { stable += 1; } else { stable = 0; last = value; }
		if (stable >= SETTLE_STABLE_TICKS || Date.now() >= deadline) {
			return { settledMs: Date.now() - t0, stable: stable >= SETTLE_STABLE_TICKS };
		}
		await new Promise(r => setTimeout(r, WAIT_POLL_MS));
	}
}

/** 把底层错误译成一行人话（保留原文，前缀标明出处）。 */
function errText(e) {
	return String(e instanceof Error ? e.message : e).split('\n')[0];
}

/** 验活探针的短超时（ms）：要回答的是"渲染进程还活着吗"，不是"等它跑完"。 */
export const LIVENESS_PROBE_TIMEOUT_MS = 3_000;

/**
 * Input 事件的"**超时 ⇒ 先验活、再重试一次**"封装（2026-10-15，真机现场：XHS 这类重 JS 页面上
 * `Input.dispatchMouseEvent` 偶发 20s 超时）。
 *
 * 两类根因**截然不同**，必须分开报：
 *   A. 渲染进程**真的卡死**（长任务/无限循环/连接已断）⇒ 重试只会再等满一个超时 ✗；
 *   B. 单次派发的应答丢了（连接没断 —— 随后的 `Runtime.evaluate` 都通）⇒ **重试一次**多半就好。
 *
 * 所以流程是：超时 → 3s 验活探针 → 不通 ⇒ 如实报"页面无响应"（**不重试** ✗）→ 通 ⇒ 重试一次。
 * ⚠ 重试一次的代价：若第一次派发**其实到了**而应答丢了，重试会让事件重复（点击场景 = 相当于多点一下）——
 * 与"用户发现没点上、又手动点一次"同一性质，可接受 ✓；而"不重试"会让本来没发生的动作永远不发生 ✗。
 *
 * @param {object} o `{ run, probe, method, label? }` —— `run`/`probe` 都是返回 Promise 的回调（探针用 stub 测 ✓）
 */
export async function withLivenessRetry(o) {
	const label = o?.label || 'Input 事件';
	let firstErr;
	try {
		return await o.run();
	} catch (e) {
		if (!/timed out/.test(String(e?.message ?? e))) { throw e; }
		firstErr = e;
	}
	let alive = false;
	try {
		await o.probe(LIVENESS_PROBE_TIMEOUT_MS);
		alive = true;
	} catch {
		alive = false;
	}
	if (!alive) {
		throw new Error(`${o.method} 超时，且验活探针（${LIVENESS_PROBE_TIMEOUT_MS}ms）也没回 ⇒ 页面/渲染进程无响应`
			+ '或连接已断（不是"没点中"）。先 `browser.waitFor` / `snapshot` 确认页面还活着；'
			+ '若是重 JS 页面（如小红书）在跑长任务，等它沉降后再试。原始错误：' + errText(firstErr));
	}
	// 验活通过 ⇒ 连接活着、单次应答丢了 ⇒ 重试一次；再超时就让它**原始错误**上去（不再吞）。
	return o.run();
}
