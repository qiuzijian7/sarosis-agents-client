// @vssaros/dsh-agents — Git 分道图 + 回合末自动提交（2026-10-31，对齐 DeepSeekBot）
//   跑法：node dsh-plugins/vssaros-agents/test/git-lanes.test.mjs
//
// 钉住三件事：
//   ① 轨道布局：`lib/core/gitLanes.js` 是**唯一**的布局实现（页面只拼服务端算好的 path）。
//      线性历史全在第 0 轨；有分叉才出现第 1 轨；merge 的第二父必须汇入（joins）。
//   ② 悬空轨：`log --max-count=N` 截断处的父提交**不占轨道**（否则图右侧凭空多一列）。
//   （③ 回合末自动提交 / 真仓库分道图随 lib/memory.js 一起删除：2026-11-06 Bot 记忆并入 @vssaros/dsh-memory，
//    版本历史由它的 lib/bot-history.js 负责，测试在 vssaros-memory/tests/vssaros-bot-history.test.js。）
import assert from 'node:assert/strict';
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

console.log(`\n[git-lanes] ${pass} passing / ${fails.length} failing`);
for (const f of fails) { console.log(`  ✗ ${f}`); }
process.exit(fails.length === 0 ? 0 : 1);
