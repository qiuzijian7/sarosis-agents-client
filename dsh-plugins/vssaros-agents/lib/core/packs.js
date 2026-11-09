/**
 * @vssaros/dsh-agents — capability pack（2026-11-08 P1）。
 *
 * ★ 为什么要它：原来的默认面是「全量基座 + tools[] 声明 allowlist，再靠 restrict({deny}) 收窄」
 *   ⇒ 每个 agent 都在**全量工具面**上起步，能力预算形同虚设（R13）。
 *   pack 把默认面改成「最小基座 + 能力包**加法**」：`.agent.md` 只写 `capabilities: [fs, web]`，
 *   展开出的 tools / skills 与显式 `tools:[]` **取并集**（只加不减）⇒ 老 agent 零回归。
 *
 * ⚠ 保守取舍（2026-11-08）：**不改 `presetBase.generated.js` / `cordis.presets.yml` 的生成链**。
 *   那两份是官方 standard preset 的逐字副本，`REQUIRED_BASE_ROW_IDS` 钉着 6 行必需能力
 *   （agent-instructions / tool-fs / tool-fs-search / skill-filesystem / tool-skill / compaction）；
 *   删任一都会让 21 个 agent 同时少工具。所以「最小默认面」落在 preset 定义层：
 *   `toPresetDefinition` 按 pack 展开 tools 的**并集**，`restrict({deny})` 保留为兜底。
 *   `check-agent-tools.mjs` 的工具数预算守卫负责让「加法」有上限。
 *
 * 纯函数、零 dsh 依赖 ⇒ 守卫可直接 import 断言。
 */

/** 能力包目录：tools / skills / mcp 三类，都是**只加不减**的白名单。 */
export const PACKS = Object.freeze({
	core: Object.freeze({
		// 官方基座自带的必需能力（写在这里是为了让 `.agent.md` 可以显式声明，不产生新工具行）
		tools: Object.freeze(['read', 'write', 'edit', 'glob', 'grep']),
		skills: Object.freeze([]),
		mcp: Object.freeze([]),
	}),
	fs: Object.freeze({
		tools: Object.freeze(['read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh']),
		skills: Object.freeze([]),
		mcp: Object.freeze([]),
	}),
	web: Object.freeze({
		tools: Object.freeze(['web_search', 'web_fetch']),
		skills: Object.freeze([]),
		mcp: Object.freeze([]),
	}),
	skills: Object.freeze({
		tools: Object.freeze(['skill', 'read_skill', 'skill_search', 'skill_context', 'list_skills']),
		skills: Object.freeze([]),
		mcp: Object.freeze([]),
	}),
	team: Object.freeze({
		// ⚠ 不写 group_ask / group_goal：那两个只挂在群成员影子会话上，不是全局注册工具
		//   （rooms.js:58,1594），写进 pack 会让普通会话拿到一个「名字存在但工具不在」的假能力。
		tools: Object.freeze(['agent_message', 'agent_list']),
		skills: Object.freeze([]),
		mcp: Object.freeze([]),
	}),

	// ── 技能专属包（2026-11-08：给 21 个内置 agent 配 capabilities 时补齐）─────────
	// ⚠ `.agent.md` 的 `capabilities:` 同时喂给两套表：这里的工具包，和
	//   `vssaros-skills/lib/core/capabilityLibrary.js` 的技能包。技能包名在工具面里
	//   **不贡献任何工具**，但必须登记成空包，否则 `expandPacks` 会报 unknown，
	//   `toPresetDefinition` 会给每个 agent 写一条「未知能力包」note。
	//   两表键集合必须完全相等，`check-agent-capabilities.mjs` 钉住。
	all: Object.freeze({ tools: Object.freeze([]), skills: Object.freeze([]), mcp: Object.freeze([]) }),
	code: Object.freeze({ tools: Object.freeze([]), skills: Object.freeze([]), mcp: Object.freeze([]) }),
	git: Object.freeze({ tools: Object.freeze([]), skills: Object.freeze([]), mcp: Object.freeze([]) }),
	qa: Object.freeze({ tools: Object.freeze([]), skills: Object.freeze([]), mcp: Object.freeze([]) }),
	docs: Object.freeze({ tools: Object.freeze([]), skills: Object.freeze([]), mcp: Object.freeze([]) }),
	research: Object.freeze({ tools: Object.freeze([]), skills: Object.freeze([]), mcp: Object.freeze([]) }),
	design: Object.freeze({ tools: Object.freeze([]), skills: Object.freeze([]), mcp: Object.freeze([]) }),
	knowledge: Object.freeze({ tools: Object.freeze([]), skills: Object.freeze([]), mcp: Object.freeze([]) }),
	media: Object.freeze({ tools: Object.freeze([]), skills: Object.freeze([]), mcp: Object.freeze([]) }),
	platform: Object.freeze({ tools: Object.freeze([]), skills: Object.freeze([]), mcp: Object.freeze([]) }),
	planning: Object.freeze({ tools: Object.freeze([]), skills: Object.freeze([]), mcp: Object.freeze([]) }),
});

/** 技能专属包名（供守卫/文档区分两侧语义）。 */
export const SKILL_ONLY_PACKS = Object.freeze(['all', 'code', 'git', 'qa', 'docs', 'research', 'design', 'knowledge', 'media', 'platform', 'planning']);

/** 单个 preset 展开后的工具数上限（预算守卫同值；超过即在 check-agent-tools 判红）。 */
export const PACK_TOOL_BUDGET = 40;

/** 未知 pack 名：不静默吞（守卫会报），但也不让整个 preset 挂掉 ⇒ 记进 unknown 交给调用方写 note。 */
export function expandPacks(names) {
	const list = Array.isArray(names) ? names.map(String).map(s => s.trim()).filter(Boolean) : [];
	const tools = new Set();
	const skills = new Set();
	const mcp = new Set();
	const unknown = [];
	for (const name of list) {
		const pack = PACKS[name];
		if (!pack) { unknown.push(name); continue; }
		for (const tool of pack.tools) { tools.add(tool); }
		for (const skill of pack.skills) { skills.add(skill); }
		for (const server of pack.mcp) { mcp.add(server); }
	}
	return { tools: [...tools], skills: [...skills], mcp: [...mcp], unknown, names: list };
}

/**
 * 能力包与显式声明合并：只加不减。
 * @returns `{ tools, skills, unknown, fromPacks, declared }`
 */
export function mergeCapabilities(declaredTools, declaredSkills, packNames) {
	const expanded = expandPacks(packNames);
	const tools = [...new Set([...(Array.isArray(declaredTools) ? declaredTools : []).map(String), ...expanded.tools])];
	const skills = [...new Set([...(Array.isArray(declaredSkills) ? declaredSkills : []).map(String), ...expanded.skills])];
	return {
		tools,
		skills,
		unknown: expanded.unknown,
		fromPacks: expanded.tools,
		declared: Array.isArray(declaredTools) ? declaredTools.map(String) : [],
	};
}

/** 预算判定（纯函数，守卫与运行期共用一条口径）。 */
export function toolBudgetProblems(tools, budget = PACK_TOOL_BUDGET) {
	const list = Array.isArray(tools) ? tools : [];
	return list.length > budget
		? [`工具数 ${list.length} 超过预算 ${budget}（能力包是加法，超过就说明默认面又膨胀了）`]
		: [];
}
