// 群聊发布前门禁：固定 9 项目标回归 + CDP smoke 清单。
//   跑法：node dsh-plugins/check-rooms-release.mjs         （默认：零副作用核对清单、链与版本快照）
//         node dsh-plugins/check-rooms-release.mjs --run   （真跑 9 项，逐项汇总退出码）
//
// ★ 为什么单独一道门禁：群聊的回归散在包内自检、插件守卫和真机 CDP 里，
//   单看任何一条都会以为「全绿了」。这里把发布前必须过的目标固定成一张清单，缺一项就红。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const rel = (p) => path.join(ROOT, p);
const exists = (p) => fs.existsSync(rel(p));
const readJson = (p) => JSON.parse(fs.readFileSync(rel(p), 'utf8'));
const readText = (p) => (exists(p) ? fs.readFileSync(rel(p), 'utf8') : '');

/** 发布前 9 项目标回归：每项都必须是真实可执行文件，不许写注释占位。 */
const TARGETS = Object.freeze([
	{ name: '群聊主行为（P0 正确性 / P3 并发·预算·写范围）', file: 'dsh-plugins/vssaros-agents/test/rooms.test.mjs' },
	{ name: '强杀与重启恢复、dangling intent 收口', file: 'dsh-plugins/vssaros-agents/test/rooms-restart.test.mjs' },
	{ name: 'P3 预算 / 写范围 / 上下文压缩纯逻辑', file: 'dsh-plugins/vssaros-agents/test/room-budget.test.mjs' },
	{ name: '官方 Team 兼容性静态门禁（P1 gate=BLOCKED）', file: 'dsh-plugins/vssaros-agents/test/official-team-compat.test.mjs' },
	{ name: '官方执行树 spike（默认关闭 / 零写入）', file: 'dsh-plugins/vssaros-agents/test/official-team-spike.test.mjs' },
	{ name: 'Bots 群聊 UI 接线（新建 / 停止本轮 / 工作区绑定）', file: 'dsh-plugins/check-bots-rooms.mjs' },
	{ name: 'chat-surface 入口构建戳与 chunk 接线', file: 'dsh-plugins/check-chat-surface-chunks.mjs' },
	{ name: 'agents 包内自检（静态契约 + 全部包内单测）', file: 'dsh-plugins/vssaros-agents/test/run-agents-check.mjs' },
	{ name: '检查链完整性（新增守卫必须入库并接进根链）', file: 'dsh-plugins/check-plugin-files.mjs' },
]);

/**
 * 真机 CDP smoke：自动化回归不替代它，发布前照单走一遍。
 * 顺序固定：先建群 → 派发 → 只读诊断 → 取消 → 重启恢复。
 */
const CDP_SMOKE = Object.freeze([
	'CDP 1 · 打开 Bots 页签新建群：≥2 个不同有效成员、绑定当前工作区、四档唤醒策略可见',
	'CDP 2 · 群内 @所有人：group_relay 工具卡出现成员气泡与状态节点，progress 从 replying 走到 done',
	'CDP 3 · GET /x/agents/api/rooms?diagnostics=1：schema=1，runs[].metrics / budgetStop 只读可见，无写口',
	'CDP 4 · 活动群右键「停止本轮」：progress 变 cut、dispatch intent 收口 cancelled、用户待派发消息保留',
	'CDP 5 · 重启 Host 后重开群：轮次 / 回复 / 意图从盘上恢复，悬空意图为 cut 且不自动重放',
]);

const problems = [];
const note = (ok, text) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${text}`); if (!ok) { problems.push(text); } };

console.log('── 9 项目标回归清单 ──');
for (const [index, target] of TARGETS.entries()) {
	note(exists(target.file), `${index + 1}/9 ${target.name} — ${target.file}`);
}
note(TARGETS.length === 9, '回归目标恰好 9 项（增删必须同步改本门禁与 CHANGELOG）');

console.log('── 发布链 ──');
const rootPkg = readJson('package.json');
note((rootPkg.scripts?.['check:rooms-release'] ?? '').includes('check-rooms-release.mjs'), '根脚本 check:rooms-release 指向本门禁');
note((rootPkg.scripts?.['check:dsh-plugins'] ?? '').includes('check-rooms-release.mjs'), 'check:dsh-plugins 链已插入本门禁');

console.log('── 文档版本快照 ──');
const agentsVersion = readJson('dsh-plugins/vssaros-agents/package.json').version;
const chatVersion = readJson('dsh-plugins/vssaros-chat-surface/package.json').version;
for (const doc of ['doc/agent-team-frameworks.html', 'doc/superagent-mockups/agent-team-usage.html']) {
	const text = readText(doc);
	note(text.includes(`data-agents-version="${agentsVersion}"`)
		&& text.includes(`data-chat-surface-version="${chatVersion}"`)
		&& text.includes('data-runtime-version="0.2.2-rc.2"')
		&& text.includes('P1 gate=BLOCKED'), `${doc} 版本快照与 P1 结论`);
}

console.log('── CDP smoke（发布前人工/真机照单执行）──');
for (const step of CDP_SMOKE) { console.log('  · ' + step); }
note(CDP_SMOKE.length >= 5 && CDP_SMOKE.every(step => step.startsWith('CDP ')), 'CDP smoke 清单完整');

if (process.argv.includes('--run')) {
	console.log('── 真跑 9 项回归 ──');
	for (const target of TARGETS) {
		const r = spawnSync(process.execPath, [target.file], { cwd: ROOT, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } });
		const tail = String(r.stdout || '').trim().split('\n').filter(Boolean).pop()
			|| String(r.stderr || '').trim().slice(0, 160);
		note(r.status === 0, `${target.name} — ${tail}`);
	}
}

console.log(`\n[rooms-release] ${problems.length ? problems.length + ' 项未通过' : '全部通过'}；CDP smoke ${CDP_SMOKE.length} 步`);
process.exit(problems.length ? 1 : 0);
