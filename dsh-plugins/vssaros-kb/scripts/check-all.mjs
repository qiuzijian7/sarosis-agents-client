/*
 * 一把跑完本插件的**全部**静态守卫。
 *
 * ★ 为什么要有它（2026-10-19 第 6 次反引号事故）：那次我只手动跑了 `check-plugin-scope` 和
 *   `check-page-script`，**漏了 `check-page-templates`** —— 而恰恰是它才管"页内脚本注释里不许有反引号"
 *   ⇒ 模板串被提前闭合、`node --check` 报错，全靠人肉发现 ✗。
 *   守卫齐不齐不该靠记性 ⇒ 统一入口，一条命令。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-all.mjs
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const STEPS = [
	{ file: 'check-page-templates.mjs', desc: '模板串：HTML 注释/内容不许有反引号 + 真求值' },
	{ file: 'check-page-script.mjs', desc: '页内脚本：no-undef' },
	{ file: 'check-page-surfaces.mjs', desc: '一页三形态：脚本可解析 + 三态接线不变（2026-10-21）' },
	{ file: 'check-page-render-surfaces.mjs', desc: '一页三形态：真渲染三种表面（2026-10-21）' },
	{ file: 'check-plugin-scope.mjs', desc: '服务端模块：no-undef（抓跨作用域误用，如 vaultDisplayName）' },
	{ file: 'check-codicon-subset.mjs', desc: 'codicon 子集与页面引用对账' },
	{ file: 'smoke-graph-page.mjs', args: ['--no-serve'], desc: '图谱页端到端（真实 renderGraphPage + 数据）' },
];

const failed = [];
for (const step of STEPS) {
	console.log(`\n── ${step.file} —— ${step.desc}`);
	// windowsHide 必带（本仓约定，见 dsh-plugins/check-spawn-hide.mjs）：这个脚本可能跑在
	// dsh Host（node.exe，无控制台）里 ⇒ 不带就会为每个子检查新分配一个控制台窗口（闪窗）。
	const r = spawnSync(process.execPath, [HERE + step.file, ...(step.args ?? [])], { encoding: 'utf8', windowsHide: true });
	const out = (r.stdout ?? '').trim();
	// 只回显最后几行（前面是逐条 PASS，太多）
	const lines = out.split('\n');
	console.log(lines.slice(-4).join('\n'));
	if (r.status !== 0) { failed.push(step.file); }
}

console.log('\n' + '='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 个守卫未通过：${failed.join(', ')}`);
	process.exit(1);
}
console.log(`✓ 全部 ${STEPS.length} 个守卫通过`);
