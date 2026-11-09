#!/usr/bin/env node
// DS Bot 三能力兼容层的一键自检（2026-11-09）。
//
// 把前几轮新增的守卫与测试收在一个入口，便于本地/CI 一次跑完：
//   ① 契约探针   ② 本地 Agent P0/P1/P2   ③ 电脑操控 P0/P1/P2
//   ④ 策略单测   ⑤ 浏览器兼容层          ⑥ 两份静态对账守卫
//
// ★ 尚未挂进 `package.json` 的 `check:dsh-plugins` 链：那条链在本轮仍被并发会话改动
//   （新增 verify:skill-catalog 并调整链内容），硬挂会冲突。收敛后只需在链尾追加一行：
//     && node dsh-plugins/scripts/run-dsb-compat-checks.mjs
//   本脚本会逐个跑完再汇总，任一失败则退出 1（不会因为 `&&` 短路漏跑后面的检查）。
//
//   node dsh-plugins/scripts/run-dsb-compat-checks.mjs
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const CHECKS = [
	{ label: '契约探针 · rc.2 LlmAdapter', args: ['dsh-plugins/test/llm-adapter-contract.test.mjs'] },
	{ label: '本地 Agent · P0/P1/P2', args: ['dsh-plugins/vssaros-local-agents/test/run-local-agents-check.mjs'] },
	{ label: '电脑操控 · P0/P1/P2', args: ['dsh-plugins/vssaros-computer/test/run-computer-check.mjs'] },
	{ label: '主进程策略单测 · desktopControl', args: ['src/vs/sessions/contrib/dshHarness/test/run-dshharness-tests.mjs', '--common', '--only', 'desktopControl'] },
	{ label: '浏览器兼容层 · 别名/体积闸', args: ['dsh-plugins/vssaros-browser/test/compat.test.mjs'] },
	{ label: '静态守卫 · 电脑操控不变量', args: ['dsh-plugins/check-computer-control.mjs'] },
	{ label: '静态守卫 · 浏览器兼容层', args: ['dsh-plugins/check-browser-compat.mjs'] },
	{ label: '静态守卫 · 引擎徽标三份对账', args: ['dsh-plugins/check-local-agent-badge.mjs'] },
	{ label: '静态守卫 · chat-surface chunk 接线', args: ['dsh-plugins/check-chat-surface-chunks.mjs'] },
];

const failed = [];
for (const check of CHECKS) {
	console.log(`\n== ${check.label} ==`);
	const run = spawnSync(process.execPath, check.args, {
		cwd: REPO,
		stdio: 'inherit',
		windowsHide: true,
		env: { ...process.env, NODE_OPTIONS: '' },
	});
	if (run.status !== 0) failed.push(`${check.label} (exit ${run.status ?? 'signal'})`);
}

console.log(`\n[dsb-compat] ${CHECKS.length - failed.length}/${CHECKS.length} 组通过`);
if (failed.length) {
	console.error(`失败：${failed.join(' / ')}`);
	process.exit(1);
}
