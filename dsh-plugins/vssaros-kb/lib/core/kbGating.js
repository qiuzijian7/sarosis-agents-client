// @vssaros/dsh-kb — **去抽象化门控**的纯逻辑（真源 `kbVaultFs.applyDeabstractionGating` 逐字移植 ✓）。
//
// ## 它管什么（真源 `kbVaultFs.ts:775-812` ＋ `frontmatter.ts` 的文件头原话）
// 构建出来的"派生类"笔记（`concept` / `comparison` / `synthesis` / `entity` ✓）里，**来源不足 2 篇的算候选**：
//   · `status: active` = 正式（已被 **≥2 个不同来源**确认 ✓）
//   · `status: pending` = 候选（来源不足 ⇒ 视图里按"待确认"呈现 ✓）
// 对齐 llm_wiki 的纪律"概念需被 ≥2 来源提及才建页" ✓ —— 它是**抑制碎片噪音**的那道闸：
// 少了它，模型每见到一个新词就建一页，知识库里会迅速堆满"只有一个来源的孤页" ✗。
//
// ## 为什么必须在 dsh 侧也做
// dsh 的构建产物若**不带** `status`，真源那边 `getStatus()` 的缺省是 `active`（"向后兼容门控上线前的旧笔记" ✓）
// ⇒ **每一页都显示成正式** ✗ ⇒ 用户在 IDE 里看到的是一个"没有候选层"的库（与 IDE 自己构建出来的不一样 ✓）。
//
// ## 三条照抄的要点（每一条都能让结果分叉）
//   ① **按"同义归一后的标题"聚合**（`canonicalizeTitle` ✓）：同名/同义的多篇笔记共享来源集合 ✓；
//      读不到 `aliases.json` ⇒ 空表降级（绝不阻断 ✓）。
//   ② 来源数取的是 **distinct 归一 basename**（`extractSources` ⇒ 小写 basename ✓）：同一个来源写两遍只算 1 ✓。
//   ③ 判据是 **`>= 2`**、比较用的是**归一后**的类型小写（`.toLowerCase()` ✓）。
// ⇒ 交叉校验：`poc/dsh-p0/scripts/p3-59-kb-gating.mjs` 拿 IDE 侧**真** `applyDeabstractionGating`
//   在同一份夹具（含 aliases.json ✓）上跑一遍 ⇒ 与本模块的决策与**落盘内容逐字节**比 ✓。

import { canonicalizeTitle } from './kbAliases.js';
import { STATUS_ACTIVE, STATUS_PENDING, extractSources, parseFrontmatter, readNoteFrontmatterType, setStatus } from './kbFrontmatter.js';

/** 会被门控的派生类笔记（真源 `kbVaultFs.ts:42` 逐字 ✓）。 */
export const GATED_TYPES = new Set(['concept', 'comparison', 'synthesis', 'entity']);

/** 判定阈值：来源数 ≥ 此值 ⇒ 正式（真源 `distinct >= 2` 硬编码 ✓）。 */
export const MIN_DISTINCT_SOURCES = 2;

/** 取 basename（真源用的是 `URI.path.split(/[\\/]/).pop()` ✓）。 */
function basenameOf(rel) {
	return String(rel ?? '').split(/[\\/]/).pop() ?? '';
}

/**
 * 算出每个"派生类笔记"应该是什么状态，并给出**需要改写**的那些（新内容）。
 *
 * 纯函数 ✓：不读盘、不写盘；调用方负责把 `changed` 落盘（`organize.js` ✓）。
 * @param {{ rel: string, content: string }[]} notes 笔记区里的**文件**（调用方已做"算不算笔记"筛选 ✓）
 * @param {{ aliases: Record<string, string[]> }} aliases 同义表（读不到就传空表 ✓）
 * @returns {{ decisions: { rel: string, normTitle: string, sources: string[], distinct: number, status: string, changed: boolean }[],
 *             changed: { rel: string, content: string }[], active: number, pending: number }}
 */
export function planGating(notes, aliases) {
	// Pass1：收集所有派生类笔记的 (归一标题, 来源集合)，按「同义归一后的 canonical」聚合来源
	const collected = [];
	const byTitle = new Map();
	for (const note of notes) {
		const type = (readNoteFrontmatterType(note.content) ?? '').toLowerCase();
		if (!GATED_TYPES.has(type)) {
			continue;
		}
		const { frontmatter } = parseFrontmatter(note.content);
		// ⚠ 真源写法 `(frontmatter?.['title'] ?? n.path.split(/[\\/]/).pop() ?? '').toString()` 照抄 ✓ ——
		//   `title` 可能是**数组**（扁平 YAML 的 `title: [a,b]` ✓）⇒ `.toString()` 会得到 `"a,b"` ✓；
		//   而 `??` 只在 null/undefined 时才退化到文件名 ⇒ **空标题 '' 不退化**（归一后为空 ⇒ 整篇跳过 ✓）。
		const title = (frontmatter?.['title'] ?? basenameOf(note.rel) ?? '').toString();
		const normTitle = canonicalizeTitle(title, aliases);
		if (!normTitle) {
			continue;
		}
		const sources = extractSources(note.content).map(s => s.toLowerCase());
		collected.push({ rel: note.rel, content: note.content, normTitle, sources });
		let set = byTitle.get(normTitle);
		if (!set) {
			set = new Set();
			byTitle.set(normTitle, set);
		}
		for (const s of sources) {
			set.add(s);
		}
	}
	// Pass2：按同 canon 的来源总数决定 status（并算出要改写的内容 ✓）
	const decisions = [];
	const changed = [];
	let active = 0;
	let pending = 0;
	for (const entry of collected) {
		const distinct = byTitle.get(entry.normTitle)?.size ?? 0;
		const target = distinct >= MIN_DISTINCT_SOURCES ? STATUS_ACTIVE : STATUS_PENDING;
		const updated = setStatus(entry.content, target);
		if (updated.changed) {
			changed.push({ rel: entry.rel, content: updated.content });
		}
		if (target === STATUS_ACTIVE) {
			active++;
		} else {
			pending++;
		}
		decisions.push({ rel: entry.rel, normTitle: entry.normTitle, sources: entry.sources, distinct, status: target, changed: updated.changed });
	}
	return { decisions, changed, active, pending };
}
