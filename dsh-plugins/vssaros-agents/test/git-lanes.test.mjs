// @vssaros/dsh-agents — Git 分道图 + 回合末自动提交（2026-10-31，对齐 DeepSeekBot）
//   跑法：node dsh-plugins/vssaros-agents/test/git-lanes.test.mjs
//
// 钉住三件事：
//   ① 轨道布局：`lib/core/gitLanes.js` 是**唯一**的布局实现（页面只拼服务端算好的 path）。
//      线性历史全在第 0 轨；有分叉才出现第 1 轨；merge 的第二父必须汇入（joins）。
//   ② 悬空轨：`log --max-count=N` 截断处的父提交**不占轨道**（否则图右侧凭空多一列）。
//   ③ 自动提交：回合末把改动落成一条提交；关掉开关就不提交；记账表要 +1。
//
// ⚠ 机器没装 git ⇒ 真仓库那一组自动跳过（文件模式的记忆本来就该照常可用，不是失败）。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { layoutGitLanes, laneRowPaths, LANE_W, ROW_H } from '../lib/core/gitLanes.js';

let pass = 0;
const fails = [];
const check = (n, fn) => { try { fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };
const checkAsync = async (n, fn) => { try { await fn(); pass += 1; } catch (e) { fails.push(`${n} → ${String((e && e.message) || e).split('\n')[0]}`); } };

/* ── 1. 纯函数：轨道布局 ─────────────────────────────────────────────── */

const linear = [
	{ full: 'c', hash: 'c', parents: ['b'] },
	{ full: 'b', hash: 'b', parents: ['a'] },
	{ full: 'a', hash: 'a', parents: [] },
];

check('线性历史：全在第 0 轨（不画无意义的岔路）', () => {
	const rows = layoutGitLanes(linear);
	assert.deepEqual(rows.map(r => r.lane), [0, 0, 0]);
	assert.deepEqual(rows.map(r => r.width), [1, 1, 1]);
});

check('线性历史：每行都有一条"从上方进来"的边（轨道连续）', () => {
	const rows = layoutGitLanes(linear);
	assert.equal(rows[0].fromAbove, false); // 第一行（tip）没有上游
	assert.equal(rows[1].fromAbove, true);
	assert.equal(rows[2].fromAbove, true);
});

// main: d→c→b→a，exp 从 c 分出：e→c
const forked = [
	{ full: 'd', hash: 'd', parents: ['c'] },
	{ full: 'e', hash: 'e', parents: ['c'] },
	{ full: 'c', hash: 'c', parents: ['b'] },
	{ full: 'b', hash: 'b', parents: ['a'] },
	{ full: 'a', hash: 'a', parents: [] },
];

check('★ 有分叉：第二条线落在第 1 轨（不是都挤在第 0 轨）', () => {
	const rows = layoutGitLanes(forked);
	assert.equal(rows[0].lane, 0);
	assert.equal(rows[1].lane, 1);
	assert.equal(rows[2].lane, 0);
});

check('★ 分叉后汇回：另一条线在父提交那一行汇进来（joins 记下它）', () => {
	const rows = layoutGitLanes(forked);
	// c 是 d 与 e 的共同父：d 延续第 0 轨，e 那条（第 1 轨）在这一行汇入 ⇒ width 至少 2
	assert.ok(rows[2].joins.includes(1), `joins=${JSON.stringify(rows[2].joins)}`);
	assert.ok(rows[2].width >= 2, `width=${rows[2].width}`);
});

check('路过其它轨道的行：through 记下要画的竖线', () => {
	const rows = layoutGitLanes(forked);
	// 第 0 行（d）之后，exp 那条线仍在活跃 ⇒ 之后的 c/b/a 行会有 through
	assert.ok(rows.some(r => (r.through ?? []).length > 0), '没有任何一行记下 through');
});

// merge：m 的两个父都在列表里 ⇒ 第二父要汇入
const merged = [
	{ full: 'm', hash: 'm', parents: ['x', 'y'] },
	{ full: 'x', hash: 'x', parents: ['base'] },
	{ full: 'y', hash: 'y', parents: ['base'] },
	{ full: 'base', hash: 'base', parents: [] },
];

check('★ merge：第二父汇入本行（joins 非空）', () => {
	const rows = layoutGitLanes(merged);
	const base = rows[2]; // y 所在行：它的 lane 与 x 不同 ⇒ 会被记成 join/through
	assert.ok(base.joins.length > 0 || base.lane === 1, `joins=${JSON.stringify(base.joins)} lane=${base.lane}`);
});

/* ── 2. 悬空轨（核心不变量）─────────────────────────────────────────── */

check('★★ 父提交不在显示列表里 ⇒ 不开轨道（否则图右侧凭空多一列）', () => {
	// 模拟 log --max-count=2 的截断：'a' 根本没取回来
	const rows = layoutGitLanes([
		{ full: 'b', hash: 'b', parents: ['a'] },
		{ full: 'a2', hash: 'a2', parents: ['missing'] },
	]);
	const orphan = rows[1];
	assert.deepEqual(orphan.toParents, [], `应为 []，实际 ${JSON.stringify(orphan.toParents)}`);
	assert.equal(orphan.width, 1);
});

check('laneRowPaths：给出可直接画的 path 与圆点坐标', () => {
	const rows = layoutGitLanes(linear);
	const svg = laneRowPaths(rows[1]);
	assert.ok(Array.isArray(svg.paths) && svg.paths.length > 0);
	assert.ok(svg.paths.every(d => typeof d === 'string' && d.startsWith('M ')));
	assert.equal(svg.dot.x, 0 * LANE_W + LANE_W / 2);
	assert.equal(svg.dot.y, 12);
});

check('几何常量：行高与轨道宽是稳定值（页面 CSS 依赖它们）', () => {
	assert.equal(LANE_W, 12);
	assert.equal(ROW_H, 46);
});

/* ── 3. 真仓库：gitGraphOf + 回合末自动提交 ─────────────────────────── */

const hasGit = (() => {
	try {
		execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
		return true;
	} catch { return false; }
})();

if (!hasGit) {
	console.log('（本机没有 git ⇒ 跳过真仓库一组；文件模式的记忆不受影响）');
} else {
	const { enableGit, gitGraphOf, gitStatusOf, memoryDirOf, setVersion, switchBranch, autoCommitAfterTurn, memoryAutoCommitOnTurn, __memoryTurn } = await import('../lib/memory.js');
	const root = mkdtempSync(join(tmpdir(), 'vssaros-gitlanes-'));
	const config = { agentsRoot: join(root, 'agents'), dataRoot: join(root, 'data') };
	mkdirSync(join(config.agentsRoot, 'demo'), { recursive: true });
	const dir = memoryDirOf(config, 'demo');

	await checkAsync('建仓（enableGit 幂等）→ git 状态可用', async () => {
		const st = await enableGit(config, 'demo');
		assert.equal(st.enabled, true);
		assert.ok(st.commits >= 1);
	});

	await checkAsync('★ 回合末自动提交：改动落成一条提交（演化链靠它连起来）', async () => {
		writeFileSync(join(dir, 'MEMORY.md'), '# 记忆\n\n- 第一条：来自回合结束\n', 'utf8');
		const before = await gitStatusOf(config, 'demo');
		assert.equal(before.dirty, 1, '改动前应有 1 个未提交文件');
		const r = await autoCommitAfterTurn(config, 'demo');
		assert.equal(r.committed, true, JSON.stringify(r));
		const after = await gitStatusOf(config, 'demo');
		assert.equal(after.dirty, 0);
		assert.equal(after.commits, before.commits + 1);
	});

	await checkAsync('自动提交记账：__memoryTurn 计到 1 次', async () => {
		assert.equal(__memoryTurn.byAgent.get('demo')?.commits ?? 0, 1);
	});

	await checkAsync('★ 关掉开关（memoryAutoCommit:false）⇒ 不提交（权限边界可退回到人按按钮）', async () => {
		writeFileSync(join(dir, 'MEMORY.md'), '# 记忆\n\n- 第二条（不该被自动提交）\n', 'utf8');
		const r = await autoCommitAfterTurn({ ...config, memoryAutoCommit: false }, 'demo');
		assert.equal(r.committed, false);
		assert.match(String(r.note ?? ''), /关闭/);
		const st = await gitStatusOf(config, 'demo');
		assert.equal(st.dirty, 1, '改动应仍在（没被提交也没被丢）');
	});

	check('memoryAutoCommitOnTurn：缺省开、显式 false 关', () => {
		assert.equal(memoryAutoCommitOnTurn(config), true);
		assert.equal(memoryAutoCommitOnTurn({ memoryAutoCommit: false }), false);
		assert.equal(memoryAutoCommitOnTurn({}), true);
	});

	await checkAsync('★ Git 图：带父提交 / 分支 / 版本 / 轨道 path', async () => {
		// 先提交掉上一条改动（保持工作树干净才能切分支）
		await autoCommitAfterTurn(config, 'demo');
		await setVersion(config, 'demo', 'v1');            // 给 HEAD 起个版本名
		await switchBranch(config, 'demo', { name: 'exp', create: true }); // 从 HEAD 拉一条分支
		writeFileSync(join(dir, 'MEMORY.md'), '# 记忆\n\n- exp 分支上的一条\n', 'utf8');
		await autoCommitAfterTurn(config, 'demo');
		// ★ 切回 main 再改一次：**两条线各自前进**才有真正的岔路
		//   （只拉分支不提交 ⇒ exp 只是领先 main 一个提交，图上是直线，width 恒 1）
		await switchBranch(config, 'demo', { name: 'main', create: false });
		writeFileSync(join(dir, 'MEMORY.md'), '# 记忆\n\n- main 分支上的另一条\n', 'utf8');
		await autoCommitAfterTurn(config, 'demo');

		const g = await gitGraphOf(config, 'demo', undefined, 20);
		assert.equal(g.enabled, true);
		assert.ok(g.commits.length >= 4, `commits=${g.commits.length}`);
		assert.ok(g.branches.includes('exp') && g.branches.includes('main'), JSON.stringify(g.branches));
		assert.equal(g.currentBranch, 'main');
		// 每条提交都要有轨道与可画的 path（页面只拼这些）
		assert.ok(g.commits.every(c => Array.isArray(c.svg?.paths) && c.svg.paths.length > 0));
		// 分支 tip 与版本名要挂到对应提交上
		assert.ok(g.commits.some(c => (c.branches ?? []).includes('exp')), 'exp 分支没挂到任何提交');
		assert.ok(g.commits.some(c => (c.versions ?? []).includes('v1')), 'v1 版本没挂到任何提交');
		// 至少有一条提交有父提交（parents 没接上就没法画分道）
		assert.ok(g.commits.some(c => (c.parents ?? []).length > 0));
	});

	await checkAsync('★ 两条分支 ⇒ 至少有一行 width ≥ 2（图上真能看出岔路）', async () => {
		const g = await gitGraphOf(config, 'demo', undefined, 20);
		assert.ok(g.commits.some(c => (c.svg?.width ?? 1) >= 2),
			`最大 width=${Math.max(...g.commits.map(c => c.svg?.width ?? 1))}`);
	});

	await checkAsync('未启用 Git 的 agent：gitGraphOf 如实返回 enabled:false（不抛、不假装）', async () => {
		const g = await gitGraphOf(config, 'nobody', undefined, 20);
		assert.equal(g.enabled, false);
		assert.deepEqual(g.commits, []);
	});

	try { rmSync(root, { recursive: true, force: true, maxRetries: 2 }); } catch { /* tmp 自清 */ }
}

console.log(`\n[git-lanes] ${pass} passing / ${fails.length} failing`);
for (const f of fails) { console.log(`  ✗ ${f}`); }
process.exit(fails.length === 0 ? 0 : 1);
