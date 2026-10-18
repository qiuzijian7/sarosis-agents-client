#!/usr/bin/env node
// legacy 冻结守卫（方案 doc/dsh-plugin-paradigm-refactor-plan.html §5-0.3）。
//
// 迁移期纪律：agentStudio（legacy 引擎侧）的能力面**只减不增** —— 新功能一律写进 dsh-plugins/。
// 本脚本钉住三个计数快照，**增加**就红（减少是迁移在推进 ✓，不拦）：
//   ① `browser/providers/tool/` 下的工具实现文件数（新工具族不许再进 legacy）；
//   ② `agentStudio.contribution.ts` 里 registerSingleton 的服务数（新服务不许再注册）；
//   ③ browser/ 下 sendMessage / executeFromChatOptions 调用点数（新入口不许再接 legacy 引擎）。
// 迁移真要动 legacy（删代码 ⇒ 计数下降）时更新本文件的快照即可——方向不对的红会逼着更新者写理由。
// 跑法：node dsh-plugins/check-legacy-freeze.mjs（已并入 npm run check:dsh-plugins）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const AS_BROWSER = join(REPO, 'src', 'vs', 'sessions', 'contrib', 'agentStudio', 'browser');

// ── 快照基线（2026-10-16 实测；只许相等或更小）─────────────────────────────
const BASELINE = {
	toolProviderFiles: 77,     // browser/providers/tool/*.ts
	registerSingletons: 53,    // agentStudio.contribution.ts 的 registerSingleton(I*) 服务 id 数（去重）
	sendMessageCalls: 20,      // browser/**/*.ts 里 `.sendMessage(` 的出现次数
	executeFromChatOptionsCalls: 9, // browser/**/*.ts 里 `executeFromChatOptions(` 的出现次数
};

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); };

function walk(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) { walk(full, out); }
		else if (entry.name.endsWith('.ts')) { out.push(full); }
	}
	return out;
}

// ① 工具实现文件数
{
	const dir = join(AS_BROWSER, 'providers', 'tool');
	const count = readdirSync(dir).filter(f => f.endsWith('.ts') && statSync(join(dir, f)).isFile()).length;
	check(`1. legacy 工具实现文件数 ≤ ${BASELINE.toolProviderFiles}（当前 ${count}）`,
		count <= BASELINE.toolProviderFiles,
		count > BASELINE.toolProviderFiles ? `新增了 ${count - BASELINE.toolProviderFiles} 个文件——新工具请写进 dsh-plugins/` : '');
}

// ② 注册服务数
{
	const text = readFileSync(join(AS_BROWSER, 'agentStudio.contribution.ts'), 'utf8');
	const ids = new Set([...text.matchAll(/registerSingleton\(\s*I(\w+)/g)].map(m => m[1]));
	check(`2. legacy 注册服务数 ≤ ${BASELINE.registerSingletons}（当前 ${ids.size}）`,
		ids.size <= BASELINE.registerSingletons,
		ids.size > BASELINE.registerSingletons ? `新增了 ${ids.size - BASELINE.registerSingletons} 个服务` : '');
}

// ③ 入口调用点数
{
	let send = 0, exec = 0;
	for (const file of walk(AS_BROWSER)) {
		const text = readFileSync(file, 'utf8');
		send += (text.match(/\.sendMessage\(/g) ?? []).length;
		exec += (text.match(/executeFromChatOptions\(/g) ?? []).length;
	}
	check(`3a. legacy 入口 sendMessage 调用点 ≤ ${BASELINE.sendMessageCalls}（当前 ${send}）`,
		send <= BASELINE.sendMessageCalls,
		send > BASELINE.sendMessageCalls ? `新增 ${send - BASELINE.sendMessageCalls} 处——新入口请走 vssarosRuns / session.run` : '');
	check(`3b. legacy 入口 executeFromChatOptions 调用点 ≤ ${BASELINE.executeFromChatOptionsCalls}（当前 ${exec}）`,
		exec <= BASELINE.executeFromChatOptionsCalls,
		exec > BASELINE.executeFromChatOptionsCalls ? `新增 ${exec - BASELINE.executeFromChatOptionsCalls} 处` : '');
}

let failed = 0;
for (const r of results) {
	console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
	if (!r.ok) { failed++; }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
