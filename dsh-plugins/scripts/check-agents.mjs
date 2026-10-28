/*
 * 内置 agent 的一键检查（2026-10-27）。
 *
 * 为什么需要它：这一轮我踩了三个彼此独立的坑，每个都只有"跑某一条检查"才能发现：
 *   ① 改了提示词忘了重新生成 `resources/.agents/agents/<id>/.agent.md` ⇒ singleSource ③ 会红；
 *      （⚠ 这里不能写星号通配：`agents/星/.agent.md` 里的 `星/` 会提前结束块注释 —— 我又踩了一次）
 *   ② 改了 `src/vs/sessions/**` 没跑 transpile ⇒ 注释被提前关闭 / 语句被拼接这类结构伤留在树里；
 *   ③ 守卫自己写错（比较了两个 undefined）⇒ 假绿。
 * ⇒ 把这三件事串成一条命令，默认全跑，任何一项红就非零退出。
 *
 * 用法：
 *   node dsh-plugins/scripts/check-agents.mjs               # 结构守卫 + 产物一致性（快，<3s）
 *   node dsh-plugins/scripts/check-agents.mjs --with-tools  # 再加工具名守卫
 *   node dsh-plugins/scripts/check-agents.mjs --all         # 再加 transpile（~15s，抓结构伤）
 *   node dsh-plugins/scripts/check-agents.mjs --full        # 再加 agentStudio common 测试（~40s）
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const ALL = has('--all') || has('--full');
const FULL = has('--full');

/** @type {{ name: string, cmd: string[], keep?: boolean }[]} */
const steps = [
	{ name: '提示词结构守卫', cmd: ['node', 'dsh-plugins/check-agent-prompts.mjs'] },
	{ name: '产物 ↔ 真源一致', cmd: ['node', 'dsh-plugins/scripts/gen-builtin-agent-md.mjs', '--check'] },
];

if (ALL || has('--with-tools')) {
	steps.push({ name: '工具/技能名单', cmd: ['node', 'dsh-plugins/check-agent-tools.mjs'] });
}
if (ALL) {
	steps.push({ name: '真源编译（transpile）', cmd: ['npm', 'run', 'transpile-client'] });
}
if (FULL) {
	steps.push({ name: 'agentStudio common 测试', cmd: ['node', 'src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs'] });
}

const results = [];
for (const step of steps) {
	const t0 = Date.now();
	const isNpm = step.cmd[0] === 'npm';
	const r = spawnSync(isNpm ? 'npm.cmd' : process.execPath, isNpm ? step.cmd.slice(1) : step.cmd.slice(1), {
		cwd: REPO,
		encoding: 'utf8',
		windowsHide: true,          // dsh Host 无控制台 ⇒ 不加会闪窗（check-spawn-hide 判据）
		shell: isNpm,               // npm on Windows 需要 shell 才能找到 npm.cmd
		maxBuffer: 64 * 1024 * 1024,
	});
	const ms = Date.now() - t0;
	const out = String(r.stdout || '') + String(r.stderr || '');
	const ok = r.status === 0;

	// 只回显最后几行（守卫本身已经把详情打出来了；这里避免刷屏）
	const tail = out.split(/\r?\n/).filter((l) => l.trim()).slice(-3);
	results.push({ name: step.name, ok, ms, tail });

	console.log((ok ? '  ✓ ' : '  ✗ ') + step.name.padEnd(24) + (ms + 'ms').padStart(8));
	for (const l of tail) { console.log('      ' + l.trim().slice(0, 150)); }
	if (!ok) { break; }             // 一个红就停：后面的结果没有参考价值
}

console.log('\n  ' + '─'.repeat(56));
const failed = results.filter((r) => !r.ok);
if (failed.length) {
	console.log('  ✗ 未通过：' + failed.map((r) => r.name).join('、'));
	console.log('    修复提示：产物漂移 ⇒ 跑 gen-builtin-agent-md.mjs；编译失败 ⇒ 看它指出的文件与行号。');
	process.exit(1);
}
console.log('  ✓ 全部通过（' + results.length + ' 项）');
