// @vssaros/dsh-agents — 原子替换 + 退避重试（2026-10-27）
//
// ── 为什么需要 ────────────────────────────────────────────────────────────────
// 我们所有"写状态文件"的地方都是这个形状：写一个带随机后缀的 tmp，再 `rename(tmp, target)`
// 覆盖目标（这样读的人永远看不到半个文件）。
//
// 但在 Windows 上 `rename` 会因**目标文件被杀软 / 索引器 / 另一个写者短暂持有**而抛
// `EPERM` / `EBUSY` / `EACCES`。它不是逻辑错误 —— 退避几十毫秒再试就会成功；
// 而裸 rename 会让整次写入失败。
//
// 实证：`dead-letters.test.mjs` 的「有界 FIFO」（连续写 205 次）**偶发** EPERM，
//   跑 8 次里有 1~2 次红。真实使用中并发写死信 / 凭据 / 配对状态同样会撞上。
//
// ⚠ 只重试上面三类可恢复错误。`ENOENT` / `ENOSPC` / `EXDEV` 是真实的，立刻上抛
//   （把它们也重试只会让故障晚 385ms 才暴露，且更难定位）。

import { rename } from 'node:fs/promises';

/** 可恢复的 Windows 文件占用错误。 */
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** 退避序列（毫秒）：总等待 385ms，足够跨过一次杀软扫描，又不至于让请求挂住。 */
const DEFAULT_DELAYS = [10, 25, 50, 100, 200];

/**
 * `rename` 的带重试版本。
 *
 * @param from 源（通常是 tmp 文件）
 * @param to   目标
 * @param options.delays     覆盖退避序列（测试用）
 * @param options.renameImpl 覆盖 rename 实现（**只为可测**：ESM 无法被 mock）
 * @returns `true`（成功）
 * @throws  最后一次的错误（重试用尽）或不可恢复的错误（立刻）
 */
export async function renameWithRetry(from, to, options = {}) {
	const delays = Array.isArray(options.delays) && options.delays.length ? options.delays : DEFAULT_DELAYS;
	const doRename = typeof options.renameImpl === 'function' ? options.renameImpl : rename;
	let lastError = null;
	for (let attempt = 0; attempt <= delays.length; attempt += 1) {
		try {
			await doRename(from, to);
			return true;
		} catch (e) {
			lastError = e;
			if (!RETRYABLE.has(String(e?.code ?? ''))) { throw e; }
			if (attempt === delays.length) { break; }
			await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
		}
	}
	throw lastError;
}

export const RENAME_RETRYABLE_CODES = [...RETRYABLE];
export const RENAME_BACKOFF_MS = [...DEFAULT_DELAYS];
