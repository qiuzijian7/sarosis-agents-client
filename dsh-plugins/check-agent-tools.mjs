#!/usr/bin/env node
// check-agent-tools.mjs ★ 内置 agent 的 tools / skills 名单守卫
//
// 为什么必须有这道守卫（dsh 侧的真实现状，2026-10-22 复核）：
//   `.agent.md` 的 `tools` 是**声明式 allowlist**；dsh 侧装配时做的是
//   `allow = wanted ∩ known`（known = `ctx.tools.schemas()` 的真实工具名），
//   **不认识的名字被直接丢掉**（只写一行 Host 日志，用户看不到）⇒
//   · 名字写错 ⇒ allowlist **静默失效**（`allow` 为空时干脆不 restrict ⇒ 该 agent 拿到**全量工具**）；
//   · 表现是"agent 工具比声明的多" / "模型突然什么都不能用"，且**没有任何报错** ✗。
//   skills 同理：技能名不在 dsh 可见的技能目录里 ⇒ 那个技能**根本不会注入**（静默少一个能力）✗。
//
// 判据（两条）：
//   A `tools[]` 的每个名字都必须在 **dsh 真实工具名单**里
//     （官方 dsh-tool-* 包的注册名 ∪ 我们插件注册的工具名 [tools-snapshot.json]）。
//   B `skills[]` 的每个名字都必须在 **dsh 可见的技能目录**里
//     （内置 `dsh-plugins/vssaros-skill-bundle/skills/<name>` ∪ 插件自带 `dsh-plugins/*/skills/<name>`）。
//
// 范围：**只查内置 agent**（`common/builtinAgents.ts`）——
//   用户自建 agent 的工具名是用户自己的事（且可能依赖用户级技能，本机状态 ⇒ 不能进守卫）✓。
//
// 跑法：node dsh-plugins/check-agent-tools.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

let problems = 0;
const fail = (msg) => { problems++; console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✔ ${msg}`);

// ── 1. dsh 真实工具名单 ────────────────────────────────────────────
// 1a. 官方工具包：扫 `name: "xxx"` 的注册名（排除 `tool:` 前缀的服务名）
const officialTools = new Set();
const runtimeRoot = path.join(ROOT, 'dsh-runtime');
if (exists(runtimeRoot)) {
	for (const ver of fs.readdirSync(runtimeRoot)) {
		const nm = path.join(runtimeRoot, ver, 'node_modules', '@deepseek-ai');
		if (!exists(nm)) { continue; }
		for (const pkg of fs.readdirSync(nm)) {
			if (!pkg.startsWith('dsh-tool-')) { continue; }
			const libDir = path.join(nm, pkg, 'lib');
			if (!exists(libDir)) { continue; }
			for (const f of fs.readdirSync(libDir)) {
				if (!f.endsWith('.js')) { continue; }
				const src = read(path.join(libDir, f));
				for (const m of src.matchAll(/\bname:\s*["']([a-z][a-z0-9_]{1,40})["']/g)) {
					officialTools.add(m[1]);
				}
			}
		}
	}
}
// 1b. 我们插件注册的工具（tools-snapshot.json 是那份清单的**唯一真源**）
const snapshotPath = path.join(HERE, 'tools-snapshot.json');
let pluginTools = new Set();
if (exists(snapshotPath)) {
	try {
		const snap = JSON.parse(read(snapshotPath));
		for (const list of Object.values(snap.plugins ?? {})) {
			for (const t of list ?? []) {
				if (t && typeof t.name === 'string') { pluginTools.add(t.name); }
			}
		}
	} catch (e) {
		fail(`tools-snapshot.json 解析失败：${String(e?.message ?? e)}`);
	}
} else {
	fail('找不到 dsh-plugins/tools-snapshot.json（插件工具名单的真源）');
}
// 2026-11-03：内置记忆插件 `vssaros-memory` 的工具不进离线工具快照
// （它的 apply() 硬注入 Host 的 7 个 cordis 服务，见 tools-snapshot.mjs 的 OFFLINE_UNSUPPORTED），
// 但真机确实注册、且已写进各内置 agent 的 tools 白名单 ⇒ 显式补进 knownTools，
// 否则判据 A 会把这些合法名字当成写错并静默丢弃（allowlist 形同虚设）。
// 真源在 dsh-plugins/vssaros-memory/lib/index.js 的 DEFAULTS：toolName / todoToolName。
// 技能工具不在这里：内置包 skillManageEnabled:false，skill_manage 由 @vssaros/dsh-skills 提供。
const BUILTIN_MEMORY_TOOLS = ['memory', 'dtodo'];
const knownTools = new Set([...officialTools, ...pluginTools, ...BUILTIN_MEMORY_TOOLS]);
ok(`dsh 工具名单：官方 ${officialTools.size} 个 + 插件 ${pluginTools.size} 个 + 内置记忆 ${BUILTIN_MEMORY_TOOLS.length} 个 = ${knownTools.size} 个`);

// ── 2. dsh 可见的技能目录 ─────────────────────────────────────────
// ★ P0（2026-11-06）：内置技能真源已迁到 dsh 侧插件包内，路径取单一真源模块。
import { BUNDLED_SKILL_ROOT, USER_SKILL_ROOTS } from './scripts/skill-bundle-paths.mjs';
const skillDirs = new Set();
const builtinSkills = BUNDLED_SKILL_ROOT;
if (exists(builtinSkills)) {
	for (const d of fs.readdirSync(builtinSkills)) {
		if (fs.existsSync(path.join(builtinSkills, d, 'SKILL.md'))) { skillDirs.add(d); }
	}
}
// 插件自带技能（archify / ego …）
for (const d of fs.readdirSync(HERE)) {
	const sdir = path.join(HERE, d, 'skills');
	if (!exists(sdir)) { continue; }
	for (const s of fs.readdirSync(sdir)) {
		if (fs.existsSync(path.join(sdir, s, 'SKILL.md'))) { skillDirs.add(s); }
	}
}
ok(`dsh 可见技能：${skillDirs.size} 个`);

// ── 3. 解析内置 agent 的 tools / skills ────────────────────────────
const agentsSrc = read(path.join(ROOT, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'common', 'builtinAgents.ts'));
// agent id：`id: 'xxx',`（顶层字段，缩进 3 个制表位）
const idRe = /^\t+id:\s*'([^']+)',/gm;
const ids = [...agentsSrc.matchAll(idRe)].map(m => m[1]);
// tools / skills 数组：形如 `tools: ['a', 'b'],`（可跨行）
function arraysOf(field) {
	const out = [];
	const re = new RegExp(`^\\s*${field}:\\s*\\[([\\s\\S]*?)\\],`, 'gm');
	for (const m of agentsSrc.matchAll(re)) {
		const items = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
		out.push({ field, items, index: m.index });
	}
	return out;
}
const toolLists = arraysOf('tools');
const skillLists = arraysOf('skills');

// 抓全性自检：**数组数必须与 agent 数对齐**。
//   漏抓 ⇒ 守卫变成"部分检查"（只看了一部分 agent 却报绿）⇒ 必须红 ⇒ 不许静默放过 ✗。
//   允许的偏差：少数 agent 合法地不写 `tools`（那行整个不存在）⇒ 抓到的数组数 ≤ agent 数。
//   ⇒ 判据：抓到 0 个 agent（解析口径坏了）或 抓到数 > agent 数（解析重复了）⇒ 必红。
if (ids.length === 0) {
	fail('没抓到任何内置 agent 的 id（解析口径坏了 ⇒ 守卫会空跑）');
} else if (toolLists.length > ids.length || skillLists.length > ids.length) {
	fail(`抓到的 tools(${toolLists.length}) / skills(${skillLists.length}) 数组比 agent 数(${ids.length})还多 ⇒ 解析重复了`);
} else {
	ok(`内置 agent ${ids.length} 个，抓到 tools ${toolLists.length} 处 / skills ${skillLists.length} 处（≤ agent 数 ✓）`);
}

// ── 4. 判据 A：tools 必须在 dsh 真实工具名单里 ─────────────────────
// 2026-11-06：tools 支持 `prefix*` 通配与 `!name` / `!prefix*` 排除（vssaros-agents core/agents.js `toolRulesOf`）。
//   通配必须至少匹配一个真实工具（写错前缀 = 静默什么都不保留）；排除项是「不要」，不要求存在
//   （典型 `!mcp__*`：MCP 工具因用户而异，离线名单里本来就没有）。
// 2026-11-09：MCP 工具由 dsh-mcp-client 连接后动态注册成 mcp__<serverName>__<tool>，
//   不可能出现在 tools-snapshot.json（它只抓插件 apply() 里的 ctx.tools.register）。
//   ⇒ 可校验的是「server 确实在 dsh 侧声明过」：前缀形状 + 登记在位两条一起守，
//   写错 server 名或把 cordis.patch.yml 里的行删掉都会在这里判红。
const MCP_PATCH = path.join(ROOT, 'dsh-plugins', 'vssaros-mcp', 'cordis.patch.yml');
const mcpServers = new Set();
const mcpDrift = [];
if (exists(MCP_PATCH)) {
	const patch = read(MCP_PATCH);
	for (const m of patch.matchAll(/serverName:\s*'([A-Za-z0-9_-]{1,32})'/g)) {
		mcpServers.add(m[1]);
	}
	// 手写声明行容易与官方 renderer 漂移（缩进 / args 格式），而多个顶层 insert
	// 会让 loader 只认第一个、后面的 server 静默消失。⇒ 真调一次 dsh 侧 renderer
	// 重新渲染，逐行对账，而不是把行内容再抄一份到守卫里形成第二真源。
	const { renderMcpRows, mcpRowId } = await import('./vssaros-mcp/lib/core/mcpRows.js');
	const inserts = (patch.match(/^- insert:\s*$/gm) || []).length;
	if (inserts !== 1) {
		mcpDrift.push(`cordis.patch.yml 有 ${inserts} 个顶层 - insert:（必须恰好 1 个，多个会让后面的 server 静默消失）`);
	}
	for (const name of mcpServers) {
		const scoped = (field) => new RegExp(`serverName:\\s*'${name}'[\\s\\S]*?${field}:\\s*'([^']+)'`).exec(patch)?.[1];
		const transport = scoped('transport');
		const command = scoped('command');
		const argsRaw = new RegExp(`serverName:\\s*'${name}'[\\s\\S]*?args:\\s*\\[([^\\]]*)\\]`).exec(patch)?.[1];
		if (!transport || (transport === 'stdio' && !command)) {
			mcpDrift.push(`MCP server ${name} 缺 transport / command`);
			continue;
		}
		const server = { serverName: name, transport, command };
		if (argsRaw !== undefined) { server.args = [...argsRaw.matchAll(/'([^']*)'/g)].map((m) => m[1]); }
		const expected = renderMcpRows([server], { header: [] }).trimEnd().split('\n').slice(1).filter((l) => l.trim());
		const lines = new Set(patch.split(/\r?\n/));
		const missing = expected.filter((l) => !lines.has(l));
		if (missing.length) { mcpDrift.push(`MCP server ${name} 的行与官方 renderer 不一致：${missing[0]}`); }
		if (!patch.includes(`- id: ${mcpRowId(name)}`)) { mcpDrift.push(`MCP server ${name} 的行 id 不是 ${mcpRowId(name)}`); }
	}
}
if (mcpDrift.length) {
	for (const d of mcpDrift) { fail(d); }
} else {
	ok(`dsh 侧已声明的 MCP server：${mcpServers.size} 个（${[...mcpServers].join(', ') || '无'}），行格式与官方 renderer 一致`);
}

const badTools = [];
for (const list of toolLists) {
	for (const name of list.items) {
		if (name.startsWith('!')) {
			if (!/^![a-z][a-z0-9_]*\*?$/.test(name)) { badTools.push(name); }
			continue;
		}
		if (name.endsWith('*')) {
			const prefix = name.slice(0, -1);
			const mcp = /^mcp__([a-z0-9_]+)__$/.exec(prefix);
			if (mcp) {
				if (!mcpServers.has(mcp[1])) { badTools.push(`${name}（MCP server 未在 vssaros-mcp/cordis.patch.yml 声明）`); }
				continue;
			}
			if (!/^[a-z][a-z0-9_]*$/.test(prefix) || ![...knownTools].some((tool) => tool.startsWith(prefix))) { badTools.push(name); }
			continue;
		}
		if (!knownTools.has(name)) { badTools.push(name); }
	}
}
if (badTools.length === 0) {
	ok('所有内置 agent 的 tools[] 都是 dsh 真实工具名（allowlist 会真正生效）');
} else {
	const uniq = [...new Set(badTools)].sort();
	fail(`tools[] 里有 dsh 不认识的名字（⇒ allowlist 静默失效，该 agent 实际拿到全量工具）：${uniq.join('、')}`);
}

// ── 4b. 判据 C：能力预算（2026-11-08 P1）────────────────────────────
// 「全给再 deny」时代没有上限：pack 加法必须有硬边界，否则默认面会重新膨胀。
{
	const { PACKS, PACK_TOOL_BUDGET, expandPacks, toolBudgetProblems } = await import('./vssaros-agents/lib/core/packs.js');
	const packNames = Object.keys(PACKS);
	const badPacks = [];
	const phantom = [];
	for (const name of packNames) {
		const expanded = expandPacks([name]);
		if (expanded.unknown.length) { badPacks.push(name); }
		for (const tool of expanded.tools) {
			if (!knownTools.has(tool)) { phantom.push(`${name}:${tool}`); }
		}
	}
	const budgetHits = toolBudgetProblems(Array.from({ length: PACK_TOOL_BUDGET + 1 }, (_, i) => `x${i}`));
	if (badPacks.length === 0 && phantom.length === 0 && budgetHits.length === 1) {
		ok(`能力预算守卫：${packNames.length} 个 pack 的工具名都真实、超 ${PACK_TOOL_BUDGET} 个会判红`);
	} else {
		fail(`能力预算守卫异常：未知包=[${badPacks.join(',')}] 幽灵工具=[${phantom.join(',')}] 预算命中=${budgetHits.length}`);
	}
}

// ── 5. 判据 B：skills 必须在 dsh 可见技能目录里 ────────────────────
const badSkills = [];
for (const list of skillLists) {
	for (const name of list.items) {
		if (!skillDirs.has(name)) { badSkills.push(name); }
	}
}
if (badSkills.length === 0) {
	ok('所有内置 agent 的 skills[] 都是 dsh 可见的技能（会真的注入）');
} else {
	const uniq = [...new Set(badSkills)].sort();
	fail(`skills[] 里有 dsh 看不见的技能（⇒ 那个技能不会注入，能力静默缺失）：${uniq.join('、')}`);
}

// ── 5. 仓库内 .agent.md 的 tools/skills 名单（2026-11-09 全量排查）──────
// 自定义 agent / Bots 工作台 bot 就是 <dataRoot>/agents/<id>/.agent.md，
// 与内置 agent 走同一套 wanted ∩ known allowlist，但此前完全没有守卫。
// 用户数据根是本机状态 ⇒ 只报告不判失败；仓库内的产物与 doc 样例硬校验。
function agentMdLists(text) {
	const lines = String(text ?? '').split(/\r?\n/);
	const out = { tools: [], skills: [] };
	if (lines[0]?.trim() !== '---') { return out; }
	let field = null;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === '---') { break; }
		const head = /^\s*(tools|skills):\s*(.*)$/.exec(line);
		if (head) {
			field = head[1];
			const inline = head[2].trim();
			if (inline.startsWith('[')) {
				out[field] = [...inline.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
				field = null;
			}
			continue;
		}
		const item = /^\s*-\s+([A-Za-z0-9_.!*:-]+)\s*$/.exec(line);
		if (item && field) { out[field].push(item[1]); continue; }
		if (line.trim() && !/^\s*#/.test(line)) { field = null; }
	}
	return out;
}

function badAgentMdNames(lists) {
	const bad = [];
	for (const name of lists.tools) {
		if (name.startsWith('!')) { continue; }
		if (name.endsWith('*')) {
			const prefix = name.slice(0, -1);
			const mcp = /^mcp__([a-z0-9_]+)__$/.exec(prefix);
			if (mcp) { if (!mcpServers.has(mcp[1])) { bad.push(`${name}（MCP server 未声明）`); } continue; }
			if (![...knownTools].some((tool) => tool.startsWith(prefix))) { bad.push(`${name}（前缀无匹配）`); }
			continue;
		}
		if (!knownTools.has(name)) { bad.push(name); }
	}
	for (const name of lists.skills) {
		if (!skillDirs.has(name)) { bad.push(name); }
	}
	return bad;
}

const agentMdFiles = [];
const builtinAgentsDir = path.join(ROOT, 'resources', '.agents', 'agents');
if (exists(builtinAgentsDir)) {
	for (const d of fs.readdirSync(builtinAgentsDir, { withFileTypes: true })) {
		const file = path.join(builtinAgentsDir, d.name, '.agent.md');
		if (exists(file)) { agentMdFiles.push(file); }
	}
}
const docDir = path.join(ROOT, 'doc');
if (exists(docDir)) {
	for (const f of fs.readdirSync(docDir)) {
		if (f.endsWith('.agent.md')) { agentMdFiles.push(path.join(docDir, f)); }
	}
}
for (const file of agentMdFiles) {
	const bad = badAgentMdNames(agentMdLists(read(file)));
	if (bad.length) { fail(`${path.relative(ROOT, file).replace(/\\/g, '/')} 的 tools/skills 名单无效：${bad.join(', ')}`); }
}
if (agentMdFiles.length === 0) {
	fail('一份 .agent.md 都没扫到（路径漂移 ⇒ 守卫空跑）');
} else {
	ok(`仓库内 ${agentMdFiles.length} 份 .agent.md 的 tools/skills 名单都有效`);
}

// 用户数据根：只报告，不把本机状态写进 CI 判据。
let userHints = 0;
for (const skillRoot of USER_SKILL_ROOTS) {
	const agentsRoot = path.join(path.dirname(skillRoot), 'agents');
	if (!exists(agentsRoot)) { continue; }
	for (const d of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
		const file = path.join(agentsRoot, d.name, '.agent.md');
		if (!exists(file)) { continue; }
		const bad = badAgentMdNames(agentMdLists(read(file)));
		if (bad.length && userHints < 5) {
			console.log(`  提示（用户 agent，不判失败）${path.basename(path.dirname(file))}：${bad.join(', ')}`);
			userHints += 1;
		}
	}
}

console.log(problems === 0
	? '\n[check-agent-tools] ✓ 内置 agent 工具/技能名单守卫通过'
	: `\n[check-agent-tools] ✗ ${problems} 项问题`);
process.exit(problems === 0 ? 0 : 1);
