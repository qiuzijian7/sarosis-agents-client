/**
 * @vssaros/dsh-skills — `.agent.md` 的 `skills:[]` → 该 agent 可见技能子集（纯函数 + 只读 IO）。
 *
 * ★ 2026-11-08（P0）：`.agent.md` 仍是声明式身份的**唯一真源**，本模块只读它、不写它、不复制身份模型。
 *   官方 `PresetDefinition`（dsh-agent-preset-registry）与 `dsh-skill-filesystem` 的 Config 都**没有**
 *   「按名字筛技能子集」的字段 ⇒ 子集只能在 skills provider 的 `list()` 内做，且必须在 `toCandidate()`
 *   之前（官方 `toSummary()` 会丢掉候选上的额外字段）。
 *
 * 判据与官方同款：`list(options)` 收到 `{ cwd, signal, scope }`，其中 `scope` **就是 agent 对象**
 * （`dsh-skill/lib/index.js:350` 原样透传，没有 `agent`/`session` 字段；`scope.session.header` 可达）。
 * preset id 形如 `vssaros-<id>`（`vssaros-agents/lib/core/agents.js:37,192`）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** preset id → agent id；空/其它前缀返回空串（表示「不是我们的 agent，不收窄」）。 */
export function agentIdOfPreset(preset) {
	const text = String(preset ?? '').trim();
	if (!text.startsWith('vssaros-')) { return ''; }
	const rest = text.slice('vssaros-'.length).trim();
	return rest && rest !== 'agent' ? rest : '';
}

/** 轻量 frontmatter 读 `skills:`（顶层标量逗号串 / YAML 块列表都认，与 agents.js 的 listValue 同口径）。 */
export function skillsOfAgentMd(text) {
	const raw = String(text ?? '');
	if (!raw.startsWith('---')) { return []; }
	const end = raw.indexOf('\n---', 3);
	if (end < 0) { return []; }
	const head = raw.slice(raw.indexOf('\n', 3) + 1, end);
	const out = [];
	let pending = false;
	for (const line of head.split(/\r?\n/)) {
		if (pending) {
			const item = /^\s+-\s+(.*)$/.exec(line);
			if (item) {
				const value = item[1].trim().replace(/^["']|["']$/g, '');
				if (value) { out.push(value); }
				continue;
			}
			if (!/^\s*(?:#.*)?$/.test(line)) { pending = false; }
		}
		const scalar = /^skills\s*:\s*(.*)$/.exec(line);
		if (!scalar) { continue; }
		const rest = scalar[1].trim().replace(/^["']|["']$/g, '');
		if (rest) {
			for (const part of rest.split(',')) {
				const value = part.trim().replace(/^["']|["']$/g, '');
				if (value) { out.push(value); }
			}
			pending = false;
		} else {
			pending = true;
		}
	}
	return [...new Set(out)];
}

/** 技能的归属 bot（frontmatter `owner: bot:<id>`，顶层或 `metadata:` 下都认）；不是 bot 归属 ⇒ 空串。 */
export function ownerBotOfSkillMd(text) {
	const raw = String(text ?? '');
	if (!raw.startsWith('---')) { return ''; }
	const end = raw.indexOf('\n---', 3);
	const head = end < 0 ? '' : raw.slice(raw.indexOf('\n', 3) + 1, end);
	const hit = /^\s*owner:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(head);
	const value = hit ? hit[1].trim() : '';
	return value.startsWith('bot:') ? value.slice(4).trim() : '';
}

/**
 * 读 `<dataRoot>/agents/<id>/.agent.md` 的 `skills[]`。
 * @returns `string[]`；agent 未声明 / 文件不存在 / 读失败 ⇒ `[]`（**缺省全量语义不变**）。
 */
export function readAgentSkillNames(dataRoot, agentId) {
	const id = String(agentId ?? '').trim();
	if (!id || !dataRoot) { return []; }
	try {
		return skillsOfAgentMd(readFileSync(join(dataRoot, 'agents', id, '.agent.md'), 'utf8'));
	} catch {
		return [];
	}
}

/**
 * 由 `options.scope`（agent）解析出本会话的技能子集。纯读，不改 agent。
 * @returns `null` = 不收窄（非 vssaros agent / 未声明 skills[]）；`string[]` = 只保留这些名字。
 */
export function skillSubsetFor(options, dataRoot) {
	const scope = options?.scope;
	if (!scope || typeof scope !== 'object') { return null; }
	const preset = scope?.session?.header?.agentPreset ?? scope?.header?.agentPreset ?? '';
	const agentId = agentIdOfPreset(preset);
	if (!agentId) { return null; }
	const names = readAgentSkillNames(dataRoot, agentId);
	return names.length ? names : null;
}

/**
 * 候选过滤：只保留子集内的技能 + **归属给别的 bot 的技能一律不出现**。
 * @param skills `{ name, owner? }[]`（owner = 'bot:<id>' 或空）
 * @param subset `null` | `string[]`
 * @param agentId 当前 agent id（用于归属隔离）
 */
export function filterSkillsForAgent(skills, subset, agentId) {
	const list = Array.isArray(skills) ? skills : [];
	const allow = Array.isArray(subset) ? new Set(subset.map(String)) : null;
	const me = String(agentId ?? '').trim();
	return list.filter(skill => {
		const name = String(skill?.name ?? '');
		if (!name) { return false; }
		const owner = String(skill?.owner ?? '').trim();
		// 归属标记：别的 bot 沉淀的技能绝不出现在当前 agent 的清单里（P0 验收）
		if (owner.startsWith('bot:') && owner.slice(4).trim() !== me) { return false; }
		return !allow || allow.has(name);
	});
}

/**
 * ★ 2026-11-08 P2：沉淀技能的 owner 强校验。
 * owner: bot:<id> 里的 bot 必须真实存在，否则技能会挂到"幽灵 Bot"上，
 * 而 stepMemory 的归属过滤永远匹配不到 ⇒ 技能既看不见也改不了。
 * 纯函数：botExists 由调用方注入（读 <dataRoot>/agents/<id>/.agent.md 或团队总线），
 * 便于守卫在进程内断言，不引入跨插件依赖。
 */
export function ownerBotProblems(text, botExists) {
	const botId = ownerBotOfSkillMd(text);
	if (!botId) { return []; }
	try {
		return botExists?.(botId) === true ? [] : [`owner 指向不存在的 bot: ${botId}（沉淀技能不能挂到幽灵 Bot）`];
	} catch (error) {
		return [`owner 校验失败（bot: ${botId}）：${error?.message ?? error}`];
	}
}

/** 由数据根构造 botExists（.agent.md 是本仓 agent 身份的唯一真源 ✓）。 */
export function botExistsInDataRoot(dataRoot) {
	if (!dataRoot) { return () => false; }
	return botId => {
		try { return existsSync(join(dataRoot, 'agents', botId, '.agent.md')); }
		catch { return false; }
	};
}

/** 只读：列出 agent 目录（守卫/自诊断用），避免各处手写路径。 */
export function listAgentDirs(dataRoot) {
	try {
		return readdirSync(join(dataRoot, 'agents'), { withFileTypes: true })
			.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
			.map(entry => ({ id: entry.name, mtime: (() => { try { return statSync(join(dataRoot, 'agents', entry.name, '.agent.md')).mtimeMs; } catch { return 0; } })() }));
	} catch {
		return [];
	}
}
