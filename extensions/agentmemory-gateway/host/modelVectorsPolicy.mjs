/*---------------------------------------------------------------------------------------------
 *  Model 向量构建的降级策略（纯函数，2026-10-21）
 *
 *  背景：P2-3 把真语义向量构建搬进了 Worker（`modelVectorsWorker.mjs`）。但 Worker 不可用时
 *  （spawn 失败 / 连续崩溃超过重建上限），旧实现会**回退到主线程**跑 embedding：
 *  实测会连续阻塞网关 35–150s ⇒ 事件循环被占满 ⇒ HTTP 请求排队到超时（dsh 20s）
 *  ⇒ 界面「载入历史…」直接卡死。**卡死整个网关**比**语义略弱**糟糕得多。
 *
 *  决策（默认）：
 *    · Worker 可用              → 用 Worker（不阻塞主线程）
 *    · Worker 不可用且允许主线程 → 主线程 embedding（**显式开关**，明知会卡）
 *    · Worker 不可用且不允许     → 保持 trigram / 保持已有 model 向量（**不阻塞**）
 *
 *  逃生口：`AGENTMEMORY_MODEL_EMBEDDING_MAINTHREAD=1`（旧行为，需要时显式打开）。
 *--------------------------------------------------------------------------------------------*/

/** 允许「主线程 embedding」的开关（默认关）。 */
export const MAINTHREAD_ENV = 'AGENTMEMORY_MODEL_EMBEDDING_MAINTHREAD';

/**
 * 是否允许主线程跑真语义 embedding。
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function mainThreadEmbeddingAllowed(env = process.env) {
	return env?.[MAINTHREAD_ENV] === '1';
}

/**
 * 降级决策（纯函数）。
 * @param {object} input
 * @param {boolean} input.workerAvailable Worker 是否可用
 * @param {boolean} input.allowMainThread 是否允许主线程 embedding
 * @param {string} input.mode 该分区的向量模式（trigram / model）
 * @param {number} [input.pendingCount] 待补算的 id 数（mode=model 时有意义）
 * @returns {{ action: 'use-worker'|'embed-on-main-thread'|'keep-model'|'keep-trigram', reason: string, pendingCount: number }}
 */
export function decideFallback(input) {
	const { workerAvailable, allowMainThread, mode } = input ?? {};
	const pendingCount = Number(input?.pendingCount ?? 0);
	if (workerAvailable) {
		return { action: 'use-worker', reason: 'worker 可用', pendingCount };
	}
	if (allowMainThread) {
		return {
			action: 'embed-on-main-thread',
			reason: 'worker 不可用但已显式允许主线程 embedding（会阻塞网关 35–150s）',
			pendingCount,
		};
	}
	// 不允许主线程 ⇒ 保持现状：model 分区保住已有向量（待补 id 留给下一次成功构建），
	// trigram 分区保住/补建 trigram 向量（检索仍可用，只是语义弱）。
	if (mode === 'model') {
		return { action: 'keep-model', reason: 'worker 不可用且主线程 embedding 已禁用 ⇒ 保持已有 model 向量', pendingCount };
	}
	return { action: 'keep-trigram', reason: 'worker 不可用且主线程 embedding 已禁用 ⇒ 保持 trigram', pendingCount };
}
