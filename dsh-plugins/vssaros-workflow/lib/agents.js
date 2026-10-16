// @vssaros/dsh-workflow — 读 `<数据根>/agents/<id>/.agent.md`（只读 ✓）。
//
// 为什么在 workflow 模块里也要读 agent ✗→✓：`workflow_get_schema` 的价值一半在**在线 agent 列表** ✓
// （`agent` 节点的 `data.agentId` 必须是其中之一 ✓，真源 IDE 的 schema 原话 ✓）；IDE 版从
// `studioService.getAgents()` 拿 ✓，那个服务的**唯一数据源**就是 `~/.vssaros/agents/<id>/.agent.md` ✓
// （真源注释 ✓）⇒ dsh 侧直接读盘 ✓，不引入任何服务依赖 ✓。
//
// ⚠ **契约同源、实现各自一份**（方案 6.9 方案 C ✓）：解析口径照 `vssaros-agents/lib/core/agents.js`
// 的 `parseFrontmatter` / `agentFromFile`（那份又照 `common/agentMdFormat.ts` ✓）——**插件之间不能互相 import** ✗
// （见 `lib/index.js` 里那条同款注释 ✓），所以这里是**子集实现** ✓：只取 `id` / `name` / `model` 三个字段
// （目录只需要"合法 id + 人可读名字" ✓）。`p3-10` 拿**同一份 fixture 喂两份解析器**做跨插件对账 ✓
// —— 口径要是分叉，那条断言会红 ✓。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dataRootOf } from './store.js';

/** agent 目录（`<数据根>/agents/<id>/.agent.md` ✓）。 */
export function agentsRootOf(config) {
	return join(dataRootOf(config), 'agents');
}

/** 取 frontmatter 里的顶层标量（`key: value` ✓；只认我们需要的三个键 ✓，不猜复杂 YAML ✗）。 */
function frontmatterValue(text, key) {
	const raw = typeof text === 'string' ? text : '';
	if (!raw.startsWith('---')) { return ''; }
	const end = raw.indexOf('\n---', 3);
	if (end < 0) { return ''; }
	for (const line of raw.slice(3, end).split(/\r?\n/)) {
		const at = line.indexOf(':');
		if (at < 0) { continue; }
		if (line.slice(0, at).trim() !== key) { continue; }
		let value = line.slice(at + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		return value.trim();
	}
	return '';
}

/**
 * 列出可用 agent（只读 ✓；读不了就**如实报错**，不假装"没有 agent" ✗ —— 两者对模型的含义完全不同 ✓）。
 * @returns `{ root, missing, agents: Array<{id,name,model}>, errors: string[] }`
 */
export async function listAgents(config) {
	const root = agentsRootOf(config);
	const out = { root, missing: '', agents: [], errors: [] };
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		out.missing = root;
		return out;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) { continue; }
		const file = join(root, entry.name, '.agent.md');
		let text;
		try {
			if (!statSync(file).isFile()) { throw new Error('不是文件'); }
			text = readFileSync(file, 'utf8');
		} catch {
			// 有目录没文件：不算错误（用户可能刚建目录），但**如实列出来** ✓
			out.errors.push(`跳过 ${entry.name}：没有 .agent.md`);
			continue;
		}
		const name = frontmatterValue(text, 'name');
		if (!name) {
			// 照 `agents.js` 的口径：缺 name 直接跳过，**并说明为什么** ✓（它连展示名都拼不出来 ✓）
			out.errors.push(`跳过 ${entry.name}：.agent.md 缺 name`);
			continue;
		}
		// id 口径照真源 ✓：先看 frontmatter 的 `id`，否则用**目录名** ✓（`<id>` 就是目录 ✓）
		const id = frontmatterValue(text, 'id') || entry.name;
		const model = frontmatterValue(text, 'model').split(',')[0]?.trim() || '';
		out.agents.push({ id, name, ...(model ? { model } : {}) });
	}
	out.agents.sort((a, b) => a.id.localeCompare(b.id));
	return out;
}
