// @vssaros/dsh-agents — store（主机侧 I/O）：数据根解析 + agent 目录扫描。只读，不声明 `owns`。
//
// 数据根口径与 kanban / skills 一致：`config.dataRoot` → `VSSAROS_DATA_ROOT` → `~/.vssaros`。
// agent 根：`<数据根>/agents/<id>/.agent.md`（与 IDE 的 `_getSarosAgentsDir()` 同一处）。
//
// ✅ 2026-10-19 **缺口已补上**（原先记的是"v0 不覆盖"）：内置 agent 现在经
//   `config.agentsBuiltinRoot` 交付 —— Host 启动期由代码真源（`common/builtinAgents.ts`）生成
//   md 副本到 runDir（`dshHostSupervisor._writeBuiltinAgentsDir`），再把该目录写进覆盖层。
//   ⚠ 真源**只有** IDE 那份代码；`resources/.agents/agents/` 已删除，这里的目录是**产物**
//   （与 skills 的 `bundledSkillDir` 同一类道理：产品侧的东西用绝对路径交付给读不到源码的进程 ⇒
//   内置技能/内置 agent 都活在同一层设计里）。没注入 ⇒ 退回"只列自定义"（不报错 ✓）。

import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_FILE, agentFromFile } from './core/agents.js';

/** 数据根。优先级：`config.dataRoot` → 环境变量 → `~/.vssaros`。 */
export function dataRootOf(config) {
	const configured = typeof config?.dataRoot === 'string' ? config.dataRoot.trim() : '';
	if (configured) {
		return configured;
	}
	const fromEnv = typeof process.env.VSSAROS_DATA_ROOT === 'string' ? process.env.VSSAROS_DATA_ROOT.trim() : '';
	return fromEnv || join(homedir(), '.vssaros');
}

/** agent 根：`config.agentsRoot`（测试/特殊部署）→ `<数据根>/agents`。 */
export function agentsRootOf(config) {
	const configured = typeof config?.agentsRoot === 'string' ? config.agentsRoot.trim() : '';
	return configured || join(dataRootOf(config), 'agents');
}

/**
 * **内置** agent 根：`config.agentsBuiltinRoot`（Host 启动期由代码真源生成的 md 副本目录）。
 * ⚠ 它是**产物**不是真源 —— 真源只有 IDE 侧的 `common/builtinAgents.ts`；
 *   `resources/.agents/agents/` 已删除，Host 读不到产品源码 ⇒ 只能这样交付。
 *   没注入 ⇒ 返回 undefined（只列自定义 agent，与 2026-10-19 之前的行为一致 ✓ 不会更糟）。
 */
export function agentsBuiltinRootOf(config) {
	const configured = typeof config?.agentsBuiltinRoot === 'string' ? config.agentsBuiltinRoot.trim() : '';
	return configured || undefined;
}

/**
 * 扫**两个**根并合并：内置（`agentsBuiltinRoot`）+ 自定义（`agentsRoot`）。
 *
 * ★ 同 id 时**自定义优先**：用户在设置里改过的内置 agent 会落在用户目录
 *   （IDE 侧 getAgents 的第 2 级"用户覆写"）⇒ 那份必须赢，否则用户的改动被内置覆盖 ✗。
 *
 * ⚠ 内置那份**可能不存在**（老 Host / 没注入）⇒ 忽略其 missing，不把它算成错误
 *   （"没有内置目录"是降级，不是故障；只列自定义即可 ✓）。
 */
export async function scanAgentsFromConfig(config, signal) {
	const builtinRoot = agentsBuiltinRootOf(config);
	let builtin = { agents: [], errors: [], missing: undefined, fingerprint: undefined };
	if (builtinRoot) {
		try {
			builtin = await scanAgents(builtinRoot, signal);
		} catch (e) {
			builtin = { agents: [], errors: [`内置 agent 目录读取失败（${builtinRoot}）：${String(e?.message ?? e)}`], missing: undefined, fingerprint: undefined };
		}
	}
	const custom = await scanAgents(agentsRootOf(config), signal);
	const byId = new Map();
	// `source` 决定"能不能给用户看"（内置的 code-architect/coder 那些只是内部子代理）。
	// ★ 2026-10-20：判定改为 `isShownAgent`（core/agents.js）——内置必须 `.agent.md` 写了
	//   `userFacing: true` 才展示（与 IDE 的 `USER_FACING_BUILTIN_AGENT_IDS` 由守卫 ⑤ 强绑定）；
	//   自定义永远可见。这里只负责把 `source` 标对，过滤别在本函数里各写一份 ✗。
	for (const a of builtin.agents) { byId.set(a.id, { ...a, source: 'builtin' }); }
	for (const a of custom.agents) { byId.set(a.id, { ...a, source: 'custom' }); }
	return {
		agents: [...byId.values()],
		errors: [...(builtin.errors ?? []), ...(custom.errors ?? [])],
		root: custom.root,
		missing: custom.missing,
		fingerprint: `${builtin.fingerprint ?? 'absent'}|${custom.fingerprint ?? 'absent'}`,
	};
}

async function fingerprintOf(root) {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return entries.filter(e => e.isDirectory()).map(e => e.name).sort().join(',');
	} catch {
		return 'absent';
	}
}

/**
 * 扫描 agent 根：每个子目录一个 `.agent.md`。
 * 返回 `{ agents, errors, root, missing }`——坏文件带原因进 errors，**不丢其它 agent**。
 * （目录里没有 `.agent.md` 属正常，跳过；不把它当错误刷屏。）
 */
export async function scanAgents(root, signal) {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (e) {
		if (e?.code === 'ENOENT') {
			return { agents: [], errors: [], root, missing: root, fingerprint: 'absent' };
		}
		throw new Error(`agent 目录读取失败（${root}）：${e?.message ?? e}`);
	}
	const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
	const agents = [];
	const errors = [];
	for (const dir of dirs) {
		if (signal?.aborted) {
			break;
		}
		const file = join(root, dir, AGENT_FILE);
		try {
			const info = await stat(file);
			if (!info.isFile()) {
				continue;
			}
		} catch {
			continue; // 没有 .agent.md 的目录：正常（如 agents/custom 只是容器）
		}
		let text;
		try {
			text = await readFile(file, { encoding: 'utf8' });
		} catch {
			errors.push(`读取失败：${file}`);
			continue;
		}
		const parsed = agentFromFile(text, { id: dir, file });
		if (parsed.error) {
			errors.push(parsed.error);
			continue;
		}
		agents.push(parsed.agent);
	}
	return { agents, errors, root, fingerprint: await fingerprintOf(root) };
}
