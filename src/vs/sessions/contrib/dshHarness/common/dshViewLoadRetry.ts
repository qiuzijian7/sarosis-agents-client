/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 视图加载重试的**有界**状态机（纯逻辑、无 I/O、不依赖 electron）。
 * `dshViewHost` 的 `_retryLoad` 只负责"照着决策去执行"（打日志 + setTimeout + loadURL）。
 *
 * ## 为什么单独提出来（2026-10-12 实测事故，本模块就是为了永久钉住它）
 *
 * 原来的实现把计数复位挂在 `did-finish-load` 上（"加载成功就复位"），看着合理，实则**不成立**：
 * 401 的**错误文档**同样会走完 `did-finish-load` ⇒ 复位 → 下一次 401 再从 1 开始
 * ⇒ "3 次有界重试"退化成 **500ms 一次、永远不停**的循环。实测日志（dev 实例 main.log）：
 * `view … load retry 1/3 in 500ms (HTTP 401)` 连续 449 条（18:15:12 → 18:19:05，每 500ms 一条），
 * 计数**永远是 1**。判据因此必须绑定到"这一次主 frame 导航**拿到的状态码不是 401**"——
 * 状态机得记住上一次导航的状态码，这个"记住 + 判断"就是本模块存在的理由（可单测、可回归）。
 *
 * ## 语义约定
 *
 * - `loadFailures`：已消耗的重试次数，**只有"真成功"或"人工重载/换 Host"才清零**；
 * - `retriedAuth`：本次加载链是否已切到带 token 的 `authUrl`（`_load` 据此选 URL）；
 * - `lastNavigationCode`：上一次**主 frame** 导航的 HTTP 状态码（拿不到时为 undefined）。
 *
 * 状态对象一律当**不可变**用：所有转移函数返回新对象，调用方整体替换（便于单测直接喂序列）。
 */

/** 一个视图的加载重试上限：3 次 + 线性退避（500/1000/1500ms）。 */
export const VIEW_LOAD_MAX_RETRIES = 3;

/** 退避基数：第 n 次重试等 `n * VIEW_LOAD_RETRY_BASE_MS`。 */
export const VIEW_LOAD_RETRY_BASE_MS = 500;

/** HTTP 401：dsh 的"cookie 失效/未建立"，也是本模块唯一需要特殊对待的状态码。 */
const HTTP_UNAUTHORIZED = 401;

export interface IViewLoadRetryState {
	/** 已消耗的加载重试次数（有界：达到 `VIEW_LOAD_MAX_RETRIES` 后不再重试）。 */
	readonly loadFailures: number;
	/** 已切到带 token 的 authUrl 重试过。 */
	readonly retriedAuth: boolean;
	/** 上一次主 frame 导航的 HTTP 状态码；没拿到过时为 undefined。 */
	readonly lastNavigationCode: number | undefined;
}

/** 新视图的初始状态（预算满格）。 */
export function newViewLoadRetryState(): IViewLoadRetryState {
	return { loadFailures: 0, retriedAuth: false, lastNavigationCode: undefined };
}

/**
 * 手动重载 / 换 Host（origin 变了）后的状态：**新一轮，预算回满**。
 * 不复位的话"一次失败之后连手动重载也不再有机会"（用户唯一自救手段被吃掉）。
 */
export function resetViewLoadRetry(): IViewLoadRetryState {
	return newViewLoadRetryState();
}

/**
 * 主 frame 导航结束（`did-navigate`）：只记状态码，**不动重试预算**。
 *
 * 记的是"整页导航"的状态码（子 frame 走 `did-frame-navigate`，不会污染这里）；
 * 拿不到 HTTP 状态时 Electron 给 0（如 `about:blank`、非 HTTP 协议）——那也算"不是 401"。
 */
export function onMainFrameNavigated(state: IViewLoadRetryState, httpResponseCode: number): IViewLoadRetryState {
	return { ...state, lastNavigationCode: httpResponseCode };
}

/**
 * 这一次 `did-finish-load` 算不算"真的加载成功"（= 该不该复位重试预算）。
 *
 * **不是 401 才算**。这是 2026-10-12 无限重试的直接原因：401 的错误文档也会走到
 * `did-finish-load`，原来在那里无条件复位 ⇒ 循环停不下来。
 */
export function shouldResetRetryBudget(state: IViewLoadRetryState): boolean {
	return state.lastNavigationCode !== HTTP_UNAUTHORIZED;
}

/**
 * 文档加载结束（`did-finish-load`）的状态转移。
 *
 * 只有 `shouldResetRetryBudget` 为真才复位（401 失败页不动预算）；
 * 其余情况原样返回，让重试预算能真正被消耗完。
 */
export function onDocumentFinishedLoad(state: IViewLoadRetryState): IViewLoadRetryState {
	if (!shouldResetRetryBudget(state)) {
		return state;
	}
	return { loadFailures: 0, retriedAuth: false, lastNavigationCode: state.lastNavigationCode };
}

/**
 * 白屏看门狗自动重载：这次**直接用带 token 的 authUrl**（跳过注定 401 的 cookie 尝试）。
 * 与 `_retryLoad` 的区别：它不消耗重试预算（那条链有自己的 `blankReloads` 上限）。
 */
export function withAuthRetry(state: IViewLoadRetryState): IViewLoadRetryState {
	return { ...state, retriedAuth: true };
}

export interface ILoadRetryPlanOptions {
	/** 重试上限（默认 {@link VIEW_LOAD_MAX_RETRIES}）；测试可调小。 */
	readonly maxRetries?: number;
	/** 这次重试是否切到带 token 的 authUrl（401 / 加载失败时为 true）。 */
	readonly useAuthUrl?: boolean;
}

export interface ILoadRetryPlan {
	/** 是否还允许重试；false = 预算用尽，调用方应报 error 并**停手**。 */
	readonly retry: boolean;
	/** 重试前等待的毫秒数（`retry=false` 时无意义）。 */
	readonly delayMs: number;
	/** 这是第几次重试（1-based；`retry=false` 时为已消耗的总次数），供日志写 `n/max`。 */
	readonly attempt: number;
	/** 转移后的状态（即使 `retry=false` 也返回，便于调用方统一写回）。 */
	readonly state: IViewLoadRetryState;
}

/**
 * 失败（`did-navigate` 401 / `did-fail-load` / `render-process-gone`）后的**有界**重试决策：
 * 消耗一次预算并给出退避；预算用尽则 `retry=false`（调用方报 error 停手，不再形成循环）。
 */
export function planLoadRetry(state: IViewLoadRetryState, options: ILoadRetryPlanOptions = {}): ILoadRetryPlan {
	const maxRetries = options.maxRetries ?? VIEW_LOAD_MAX_RETRIES;
	if (state.loadFailures >= maxRetries) {
		return { retry: false, delayMs: 0, attempt: state.loadFailures, state };
	}
	const loadFailures = state.loadFailures + 1;
	return {
		retry: true,
		delayMs: VIEW_LOAD_RETRY_BASE_MS * loadFailures,
		attempt: loadFailures,
		state: {
			loadFailures,
			retriedAuth: options.useAuthUrl ? true : state.retriedAuth,
			lastNavigationCode: state.lastNavigationCode,
		},
	};
}
