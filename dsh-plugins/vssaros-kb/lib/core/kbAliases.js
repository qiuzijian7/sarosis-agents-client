// @vssaros/dsh-kb — 同义归一（真源 `knowledge/kbAliases.ts` 的**纯逻辑**部分，逐字移植 ✓）。
//
// 真源文件头原话：*"用户可编辑的同义词表，让不同表述归一到同一概念，改善去抽象化门控的跨笔记聚合
//（如「GC机制」「垃圾回收」「GarbageCollection」视为同源，共享来源数）"* ✓。
// 配置位置 `<kbDir>/aliases.json`（**用户可编辑**、代码零硬编码 ✓）。
//
// ⚠ 真源里 `loadKbAliases` 带 I/O（读 aliases.json ✓）⇒ 本模块只保留**纯函数**，
//   读盘那半在 `organize.js`（读不到/JSON 非法 ⇒ **空表降级**，绝不阻断门控 ✓ 与真源同语义 ✓）。

/** aliases.json 在 kbDir 下的相对文件名（用户可编辑 ✓）。 */
export const KB_ALIASES_FILE = 'aliases.json';

/** 空表（读不到 aliases.json 时的降级值 ✓）。 */
export const EMPTY_ALIASES = { aliases: {} };

/**
 * 标题/同义词归一：小写 + 去空白与标点（与去抽象化门控的归一保持一致 ✓）。
 * @param {string} s
 * @returns {string}
 */
export function normalizeAliasKey(s) {
	return String(s ?? '').toLowerCase().replace(/[\s\-_./，。、:：()（）]/g, '').trim();
}

/**
 * 把标题归一到 canonical 键。
 * 若归一后的标题命中某条目的同义词集合（含 canonical 自身），返回该条目归一后的 canonical；
 * 否则返回标题自身的归一形式（标题自身即为 canonical）。
 * @param {string} title
 * @param {{ aliases: Record<string, string[]> } | undefined} aliases
 * @returns {string}
 */
export function canonicalizeTitle(title, aliases) {
	const key = normalizeAliasKey(title);
	if (!key) {
		return key;
	}
	for (const [canon, syns] of Object.entries(aliases?.aliases ?? {})) {
		const canonKey = normalizeAliasKey(canon);
		if (canonKey === key) {
			return canonKey;
		}
		for (const s of syns ?? []) {
			if (normalizeAliasKey(s) === key) {
				return canonKey;
			}
		}
	}
	return key;
}
