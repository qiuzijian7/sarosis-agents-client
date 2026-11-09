/**
 * @vssaros/dsh-skills — 进程内技能服务（17.1 P1，2026-11-09）
 *
 * 背景：`.agent.md` 的 `skills:` 由 `toPresetDefinition` 解析成 preset 声明，但此前
 *   `vssaros-agents` 的 `applyPersona` 另起一条路：每 60 秒扫一次技能目录，把「你的技能」
 *   清单拼进人设提示词（`ownedSkillsText`）。结果是同一件事两条真源、人设段被定时改写
 *   （prompt 缓存按会话冻结也救不回来），能力包展开出来的技能则完全被丢掉。
 *
 * 本模块把「技能声明」收成一份进程内服务：
 *   · `pin(agentId, names)` —— preset 声明的技能（含能力包展开）登记在这里；
 *   · `pinnedFor(...keys)` —— 目录发布器按 agent scope 取回，绕过 tier 分级常驻可见；
 *   · `listOwned(agentId)` —— 该 bot 沉淀、经人批准的技能（frontmatter `owner: bot:<id>`）；
 *   · `invalidate()` —— 写盘后让技能目录重建。
 *
 * 纯逻辑、无 cordis / HTTP 依赖 ⇒ 守卫与单测可直接真跑。持久化不做：preset 每次挂载
 * 都会重新 pin，服务随插件生命周期走，重启后由 apply 重建。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** frontmatter 里的 owner / description / name；只认单行 `key: value`，够用且不需要 YAML 依赖。 */
function frontmatterOf(text) {
	const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ''));
	const out = {};
	if (!head) { return out; }
	for (const line of head[1].split(/\r?\n/)) {
		const m = /^([a-zA-Z][\w-]*):\s*(.+?)\s*$/.exec(line);
		if (m) { out[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); }
	}
	return out;
}

/**
 * @param deps.skillsRoot `() => string` 技能库根目录（惰性：apply 期 foundation 可能未绑定）
 * @param deps.invalidate `() => void` 让官方技能目录重建
 * @param deps.now `() => number` 测试可注入
 */
export function createSkillWriteService(deps = {}) {
	const root = typeof deps.skillsRoot === 'function' ? deps.skillsRoot : () => '';
	const invalidate = typeof deps.invalidate === 'function' ? deps.invalidate : () => undefined;
	/** agentId → Set<技能名>；一次挂载里重复 pin 是幂等的。 */
	const pinned = new Map();
	const clean = (name) => String(name ?? '').trim();
	const keyOf = (id) => String(id ?? '').trim();

	return Object.freeze({
		/** preset 声明的技能（含能力包展开）；空名忽略，写后不自动 invalidate（目录由 pre-step 重建）。 */
		pin(agentId, names) {
			const key = keyOf(agentId);
			if (!key) { return 0; }
			if (!pinned.has(key)) { pinned.set(key, new Set()); }
			const set = pinned.get(key);
			for (const name of Array.isArray(names) ? names : []) { if (clean(name)) { set.add(clean(name)); } }
			return set.size;
		},
		/** 目录发布器按 scope 的多个候选 id 取并集（不同版本的 scope 形状不一样）。 */
		pinnedFor(...keys) {
			const out = new Set();
			for (const key of keys) {
				for (const name of pinned.get(keyOf(key)) ?? []) { out.add(name); }
			}
			return [...out];
		},
		/** 该 bot 沉淀、已批准的技能；草稿区 `.drafts` 不算（还没批准）。 */
		listOwned(agentId, limit = 12) {
			const dir = root();
			if (!dir || !existsSync(dir)) { return []; }
			const owner = `bot:${keyOf(agentId)}`;
			const out = [];
			try {
				for (const entry of readdirSync(dir, { withFileTypes: true })) {
					if (!entry.isDirectory() || entry.name.startsWith('.')) { continue; }
					const file = join(dir, entry.name, 'SKILL.md');
					if (!existsSync(file)) { continue; }
					const meta = frontmatterOf(readFileSync(file, 'utf8'));
					if (meta.owner === owner) { out.push({ name: meta.name || entry.name, description: meta.description || '' }); }
					if (out.length >= limit) { break; }
				}
			} catch { /* 目录读不动就少给几项，不让会话起不来 */ }
			return out;
		},
		invalidate,
		/** 测试/诊断用：当前登记数。 */
		get size() { return pinned.size; },
	});
}

export const SKILL_WRITE_SERVICE_NAME = 'vssarosSkills';
