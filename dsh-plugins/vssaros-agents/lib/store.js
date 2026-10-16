// @vssaros/dsh-agents — store（主机侧 I/O）：数据根解析 + agent 目录扫描。只读，不声明 `owns`。
//
// 数据根口径与 kanban / skills 一致：`config.dataRoot` → `VSSAROS_DATA_ROOT` → `~/.vssaros`。
// agent 根：`<数据根>/agents/<id>/.agent.md`（与 IDE 的 `_getSarosAgentsDir()` 同一处）。
//
// 覆盖缺口（与 skills 同源，如实记录）：IDE 还有一层内置 agent
// （`resources/.agents/agents/<id>/.agent.md`，随产品发布、在 `src/vs` 资源里），Host 进程未必可达，
// 本模块 v0 不覆盖。

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
