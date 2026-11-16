/**
 * vssaros-memory/dream — 有界并发（P2-b）。
 *
 * 官方 Cookbook 建议 analyzer 并行但要有上限（约 8）；无上限的 Promise.all
 * 在一组 20 份（甚至更多）时会同时打满模型服务。这里用固定 worker 池：
 * 结果按输入顺序返回、峰值并发 ≤ limit、非法 limit 回落默认值。
 *
 * @module vssaros-memory/dream/concurrency
 */
export const DEFAULT_CONCURRENCY = 8

/**
 * @template T, R
 * @param {Array<T>} items
 * @param {number} limit
 * @param {(item:T, index:number) => Promise<R>} fn
 * @returns {Promise<Array<R>>}
 */
export async function mapWithConcurrency(items, limit, fn) {
  const list = Array.isArray(items) ? items : []
  const size = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_CONCURRENCY
  if (list.length === 0) return []
  const results = new Array(list.length)
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor++
      if (index >= list.length) return
      results[index] = await fn(list[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, list.length) }, () => worker()))
  return results
}
