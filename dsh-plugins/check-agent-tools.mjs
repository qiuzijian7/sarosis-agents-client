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
//     （内置 `resources/.agents/skills/<name>` ∪ 插件自带 `dsh-plugins/*/skills/<name>`）。
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
const knownTools = new Set([...officialTools, ...pluginTools]);
ok(`dsh 工具名单：官方 ${officialTools.size} 个 + 插件 ${pluginTools.size} 个 = ${knownTools.size} 个`);

// ── 2. dsh 可见的技能目录 ─────────────────────────────────────────
const skillDirs = new Set();
const builtinSkills = path.join(ROOT, 'resources', '.agents', 'skills');
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
const badTools = [];
for (const list of toolLists) {
	for (const name of list.items) {
		if (!knownTools.has(name)) { badTools.push(name); }
	}
}
if (badTools.length === 0) {
	ok('所有内置 agent 的 tools[] 都是 dsh 真实工具名（allowlist 会真正生效）');
} else {
	const uniq = [...new Set(badTools)].sort();
	fail(`tools[] 里有 dsh 不认识的名字（⇒ allowlist 静默失效，该 agent 实际拿到全量工具）：${uniq.join('、')}`);
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

console.log(problems === 0
	? '\n[check-agent-tools] ✓ 内置 agent 工具/技能名单守卫通过'
	: `\n[check-agent-tools] ✗ ${problems} 项问题`);
process.exit(problems === 0 ? 0 : 1);
