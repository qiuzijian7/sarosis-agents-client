/**
 * @vssaros/dsh-skills — 随包技能的 tier 索引（2026-11-08 P2）。
 *
 * ★ 为什么需要它：`<available_skills>` 来自 `registry.snapshot()`，官方 `toSummary()` 会丢掉
 *   candidate 上的额外字段（tier 不在返回里）；而 `skill_search` 原本只扫 `<dataRoot>/skills`
 *   （用户技能），**搜不到随包的 173 个**。若目录按 P2 只列 core，却不给 extended 一条检索路径，
 *   那 133 个技能就彻底失联了 —— 分级必须和检索一起做。
 *
 * 本模块**只读**随包 SKILL.md 的 frontmatter，不注册 provider、不改官方裁决、不复活 IDE 技能链。
 * 纯函数 + 显式注入的 root ⇒ 守卫可直接 import 断言，不需要 dsh 运行时。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_TIERS = Object.freeze(['core', 'extended']);
/** `<available_skills>` 每轮只列 core 的硬上限（check-skill-bundle.mjs 同值守卫）。 */
export const SKILL_CORE_LIMIT = 40;

/** frontmatter 的 tier；没写/非法一律按 core（老技能零回归，分级不是删除）。 */
export function tierOfMd(text) {
	const raw = String(text ?? '');
	if (!raw.startsWith('---')) { return 'core'; }
	const end = raw.indexOf('\n---', 3);
	const head = end < 0 ? '' : raw.slice(raw.indexOf('\n', 3) + 1, end);
	const value = /^tier:\s*(core|extended)\s*$/m.exec(head)?.[1];
	return value === 'extended' ? 'extended' : 'core';
}

/** 从已安装的 npm 包身份解析随包技能根（与 cordis.patch.yml 同一真源），找不到返回 null。 */
export function bundledRootFromPackage() {
	try {
		const require = createRequire(import.meta.url);
		const pkg = require.resolve('@vssaros/dsh-skill-bundle/package.json');
		const root = join(dirname(pkg), 'skills');
		return existsSync(root) ? root : null;
	} catch {
		return null;
	}
}

/** 仓库内（守卫/开发期）的随包根；生产环境由 bundledRootFromPackage() 提供。 */
export function bundledRootFromRepo() {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		return join(here, '..', '..', 'vssaros-skill-bundle', 'skills');
	} catch {
		return null;
	}
}

/**
 * 扫随包根 → `{ name → { tier, path, name, description } }`。
 * 不依赖 dsh、不写盘；坏文件跳过并记 errors（与 store.js 的容错口径一致）。
 */
export function bundledTierIndex(root) {
	const index = new Map();
	const errors = [];
	if (!root || !existsSync(root)) { return { index, errors, root: root ?? '' }; }
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) { continue; }
		const file = join(root, entry.name, 'SKILL.md');
		if (!existsSync(file)) { continue; }
		try {
			const text = readFileSync(file, 'utf8');
			const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
			const name = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(head)?.[1]?.trim() || entry.name;
			const description = /^description:\s*(.*)$/m.exec(head)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
			index.set(name, { name, description, tier: tierOfMd(text), path: file });
		} catch (e) {
			errors.push(`${entry.name}: ${e?.message ?? e}`);
		}
	}
	return { index, errors, root };
}

/**
 * 把一批目录条目按 tier 分区。
 * ★ agent 在 `.agent.md` 的 `skills:[]` 里**显式点名**的技能绕过 tier（永远可见）——
 *   绑定是显式的，不能被分级悄悄抹掉。
 * @param entries `{ name, description }[]`
 * @param index `Map<name,{tier}>`
 * @param pinned `Set<string>` | null
 * @returns `{ core, extended, hidden }`
 */
export function partitionCatalog(entries, index, pinned = null) {
	const core = [], extended = [], hidden = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		const name = String(entry?.name ?? '');
		if (!name) { continue; }
		if (pinned?.has(name)) { core.push(entry); continue; }
		const tier = index?.get(name)?.tier ?? 'core';
		if (tier === 'extended') { extended.push(entry); }
		else { core.push(entry); }
	}
	return { core, extended, hidden };
}

/** 超过 core 上限时的降级说明（诚实：不把 133 个技能说成「不存在」）。 */
export function extendedHint(extendedCount, coreOmitted = 0) {
	if (extendedCount <= 0 && coreOmitted <= 0) { return ''; }
	const parts = [];
	if (extendedCount > 0) { parts.push(`另有 ${extendedCount} 个扩展技能未列出，用 \`skill_search\` 按任务检索`); }
	if (coreOmitted > 0) { parts.push(`${coreOmitted} 个核心技能超出本轮清单预算`); }
	return `- ${parts.join('；')}（完整正文用 \`read_skill\` / \`skill_context\` 取）`;
}
