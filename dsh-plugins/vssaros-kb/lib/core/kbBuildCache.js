// @vssaros/dsh-kb — 构建缓存 `.kb-build-cache.json` 的**纯逻辑**（零 I/O ✓）。
//
// ## 契约真源
// IDE 侧 `knowledge/kbVaultFs.ts`：
//   · `readBuildCache(vaultRoot)` = `JSON.parse(<vault>/.kb-build-cache.json)`，读不动一律当空 ✓（L399-401 ✓）；
//   · `writeBuildCache(vaultRoot, cache)` = `JSON.stringify(cache, null, 2)`（**两个空格缩进、无尾换行** ✓，L403-405 ✓）；
//   · 形状 = `{ 素材绝对路径: 已生成笔记绝对路径 }` ✓（`kbLint.ts:176` 原话 ✓）。
//   · 用途（`collectPendingSources`，L97-122 ✓）：① **value** 里的路径＝已产出笔记 ⇒ 永不当素材（防"笔记→笔记"churn ✓）；
//     ② key 命中且 `cacheEntryFresh`（笔记存在 **且** 笔记 mtime ≥ 素材 mtime ✓）⇒ 不算待构建 ✓。
//
// ## 为什么 P1 才做（P0 时明确不写 ✓，见 doc/dsh-kb-build-orchestration.html §3 / D3）
// 不写 ⇒ dsh 构建完**不登记** ⇒ 下一次 `preview` 把同一批**再算成待构建** ✗（"越用越不准" ✓）。
// 写的顾虑是**写者互斥**：IDE 侧整理器**不加锁** ✗（真源查证过 ✓）⇒ 两边并发写会**丢更新** ✗
// （原子写救不了丢更新 ✓，那是锁的活 ✓）。⇒ 本模块按"**能做的都做**"设计：
//   ① 合并写（**只增不删** ✓：别人的条目一律保留 ✓）；
//   ② 调用方在**我们那把 vault 锁**里做 read-modify-write ✓（`lib/lock.js`，与 IDE 的 `fileWriteLock.ts` 同一协议 ✓）；
//   ③ 残余风险**如实承认** ✗：IDE 侧同一瞬间也在写 ⇒ 仍可能丢**一条**（丢的那条下次会被重新算成待构建 ⇒
//      重建时按真源语义是**就地 patch** 那篇笔记 ✓，不是灾难 ✓）。这条写进回执与文档，不假装解决 ✓。
//
// ## ⚠ 最要紧的一条：**不能瞎猜 素材→笔记** ✗
// 缓存要的是"**素材绝对路径** → 笔记绝对路径"，而笔记里 `sources` 存的是 `normalizeSourceRef` 归一后的
// **小写 basename** ✗（`core/kbFrontmatter.js` 文件头第 4 条 ✓：去 `库/` 前缀、去 wikilink/引号、取最后一段、小写 ✓）。
// ⇒ 反向映射只能"按 basename 在**本批素材**里找"，且**一有歧义就不登记** ✓：
//   · 本批里有两个素材同名 ⇒ 不知道该记哪个 ⇒ **跳过**（宁可下次再算一遍 ✓，也不能把 A 的笔记记到 B 头上 ✗）；
//   · 两篇笔记都声明了同一素材 ⇒ 缓存是**一对一**映射 ⇒ **跳过**（记谁都可能记错 ✓）；
//   · 笔记没声明任何来源 ⇒ 跳过（无据可依 ✓）。
// 每一条跳过都带回 `reason` ⇒ 调用方/探针能**说出为什么**没登记 ✓（"静默少记"是本仓最忌讳的一类 ✗）。

import { extractSources } from './kbFrontmatter.js';

export { BUILD_CACHE_FILE } from './kbIngest.js';

/** basename（小写）—— 与 `normalizeSourceRef` 的落点口径一致 ✓（`kbFrontmatter.js:157-162` ✓）。 */
export function sourceBasenameOf(path) {
	return String(path ?? '').split(/[\\/]/).pop().toLowerCase();
}

/**
 * 序列化缓存：**逐字**照真源 `writeBuildCache`（两空格缩进、无尾换行 ✓）。
 * @param {Record<string, string>} cache
 */
export function serializeBuildCache(cache) {
	return JSON.stringify(cache ?? {}, null, 2);
}

/**
 * 合并：**只增不删** ✓（别人的条目一律保留；同 key 时以新登记为准 ✓ —— 新登记的那篇笔记是新写的 ✓）。
 * @param {Record<string, string>} existing
 * @param {Iterable<[string, string]>} entries
 */
export function mergeBuildCache(existing, entries) {
	const merged = { ...(existing ?? {}) };
	for (const [source, note] of entries ?? []) {
		merged[source] = note;
	}
	return merged;
}

/**
 * 由"本批素材 ＋ 本批笔记"算出可以登记的条目（**有歧义一律不登记** ✓，见文件头）。
 *
 * @param {{
 *   sources: readonly string[],                   // 本批素材的绝对路径（已选中的那几份 ✓）
 *   notes: readonly { path: string, content: string }[],   // 收尾时**确实存在**的笔记（含内容 ✓）
 * }} input
 * @returns {{ entries: [string, string][], skipped: { note: string, source?: string, reason: string }[] }}
 */
export function planBuildCacheEntries({ sources, notes }) {
	// 按 basename 归组：同名 ⇒ 记进 `ambiguous` ⇒ 相关素材一律不登记 ✓
	const byBase = new Map();
	for (const source of sources ?? []) {
		const base = sourceBasenameOf(source);
		if (!byBase.has(base)) {
			byBase.set(base, []);
		}
		byBase.get(base).push(String(source));
	}

	const skipped = [];
	// 素材 → 笔记：一篇素材只允许有一篇笔记声明它 ✓（否则跳过 ✓）
	const claimedBy = new Map();
	for (const note of notes ?? []) {
		const notePath = String(note?.path ?? '');
		for (const base of extractSources(note?.content ?? '')) {
			const matches = byBase.get(base);
			if (!matches || matches.length === 0) {
				continue;   // 声明的是别的库文件（不在本批）⇒ 不是我们该登记的 ✓
			}
			if (matches.length > 1) {
				skipped.push({ note: notePath, source: base, reason: `本批有 ${matches.length} 份素材同名（${matches.map(m => sourceBasenameOf(m)).join(' / ')}）⇒ 不知道该记哪个，跳过 ✓` });
				continue;
			}
			const source = matches[0];
			const previous = claimedBy.get(source);
			if (previous && previous !== notePath) {
				skipped.push({ note: notePath, source, reason: `同一份素材被两篇笔记声明（已由 ${sourceBasenameOf(previous)} 认领）⇒ 缓存是一对一映射，跳过 ✓` });
				continue;
			}
			claimedBy.set(source, notePath);
		}
	}

	// 稳定顺序（同输入同输出 ⇒ 可对账 ✓）：按素材路径排序
	const entries = [...claimedBy.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	return { entries, skipped };
}
