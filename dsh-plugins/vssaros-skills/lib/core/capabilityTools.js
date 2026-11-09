/**
 * @vssaros/dsh-skills — L3 能力发现 / 会话级挂载的纯逻辑（2026-11-08）。
 *
 * 参考 DS Bot 的 `list_capabilities` + `attach_capability`，但修掉它两处缺陷：
 *   · DS Bot 的 list_capabilities **无条数上限**，库一大就爆上下文 ⇒ 这里有界 20 条 + "N more"；
 *   · DS Bot 的 attach 写 `bot.capabilities` **持久化到全队**，改一次要触发 reconcile ⇒
 *     这里默认只挂**当前会话**（内存、随会话消失），不写 .agent.md、不惊动别的 agent。
 *
 * ★ 为什么不直接改目录消息：目录由官方 `dsh-tool-skill` 发布，我们只改 registry 候选的
 *   `invocation.modelInvocable`。attach 后调 `control.invalidate()` 让官方重新 `collect()`
 *   ⇒ digest 变化 ⇒ 官方自己重发一份收窄后的目录，不需要我们碰 deepFreeze 消息。
 *
 * 纯函数 + 显式注入 store ⇒ 守卫可离线断言，不依赖 dsh 运行时。
 */
import { CAPABILITY_PACKS } from './capabilityLibrary.js';

export const CAPABILITY_SEARCH_MAX = 20;
/** 每个会话最多临时挂多少个（防止模型一轮挂满 173 个把目录又撑回去）。 */
export const CAPABILITY_ATTACH_MAX = 40;

/** 大小写无关的子串 token 匹配（与 dsh-TUI/liangshen 同款，不引入索引依赖）。 */
export const tokensOf = (text) => String(text ?? '').toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean);

/**
 * 检索能力库。返回有界结果 + 总数 + "还有 N 个"提示（诚实降级，不把技能说成不存在）。
 * @param library `Map<name,{name,description,tier,path,kind}>`
 * @param attached `Set<string> | null`（null = 全量可见 / legacy）
 * @param query 自然语言或关键词
 */
export function searchCapabilities(library, attached, query, limit = CAPABILITY_SEARCH_MAX) {
	const wanted = tokensOf(query);
	const rows = [];
	for (const [name, item] of library ?? []) {
		const haystack = tokensOf(`${name} ${item?.description ?? ''}`).join(' ');
		if (wanted.length && !wanted.every(token => haystack.includes(token))) { continue; }
		rows.push({
			name,
			description: String(item?.description ?? ''),
			tier: item?.tier === 'extended' ? 'extended' : 'core',
			attached: attached === null || attached.has(name),
		});
	}
	rows.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	const cap = Math.max(1, Math.min(Number(limit) || CAPABILITY_SEARCH_MAX, CAPABILITY_SEARCH_MAX));
	return { total: rows.length, items: rows.slice(0, cap), omitted: Math.max(0, rows.length - cap) };
}

/** 渲染给模型的一行（含状态与取正文/挂载指引）。 */
export function renderCapabilityRows(result) {
	const lines = result.items.map(item =>
		`- ${item.name} [${item.tier}${item.attached ? ', 已可见' : ', 未列出'}] ${item.description.split('\n')[0]}`);
	const more = result.omitted > 0 ? `\n…另有 ${result.omitted} 条，换个更具体的关键词再查` : '';
	const hint = '\n用 `read_skill` 按名字取完整正文；要让某个技能常驻本会话，调 `capability_attach`。';
	return result.items.length
		? `能力库命中 ${result.total} 条：\n${lines.join('\n')}${more}${hint}`
		: '能力库里没有匹配该查询的条目；换个更具体的关键词再试。';
}

/**
 * 会话级 attach 存储。`sessionId → Set<name>`。
 * 不持久化、不跨会话；Host 重启即清空（与"临时挂载"语义一致）。
 */
export function createCapabilityAttachments(max = CAPABILITY_ATTACH_MAX) {
	const bySession = new Map();
	const setOf = (sessionId) => {
		const key = String(sessionId ?? '').trim();
		if (!key) { return null; }
		if (!bySession.has(key)) { bySession.set(key, new Set()); }
		return bySession.get(key);
	};
	return {
		/** @returns `null` = 会话 id 缺失；`'full'` = 已满；`true` = 挂上；`'exists'` = 本来就在 */
		attach(sessionId, name) {
			const set = setOf(sessionId);
			if (!set) { return null; }
			const clean = String(name ?? '').trim();
			if (set.has(clean)) { return 'exists'; }
			if (set.size >= max) { return 'full'; }
			set.add(clean);
			return true;
		},
		detach(sessionId, name) {
			const set = setOf(sessionId);
			return set ? set.delete(String(name ?? '').trim()) : false;
		},
		namesFor(sessionId) {
			const key = String(sessionId ?? '').trim();
			return new Set(bySession.get(key) ?? []);
		},
		clear(sessionId) {
			const key = String(sessionId ?? '').trim();
			if (key) { bySession.delete(key); }
		},
		get size() { return bySession.size; },
	};
}

/** attach 名字校验：必须在能力库里，且不能是包名（包名要用 capabilities: 声明）。 */
export function attachProblems(name, library, packNames = Object.keys(CAPABILITY_PACKS)) {
	const clean = String(name ?? '').trim();
	const problems = [];
	if (!clean) { problems.push('name 必填（能力库里的技能名）'); return problems; }
	if (packNames.includes(clean)) { problems.push(`\`${clean}\` 是能力包名，请写进 .agent.md 的 capabilities: 而不是临时挂载`); }
	if (library && !library.has(clean)) { problems.push(`能力库里没有 \`${clean}\`（用 capability_search 查准确名字）`); }
	return problems;
}
