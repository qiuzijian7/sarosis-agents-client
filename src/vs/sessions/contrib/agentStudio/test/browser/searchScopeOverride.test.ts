/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 搜索根放行决策回归测试（2026-08-22，日志 1787363991734）。
 *
 * 事故：7 次 search_code 想在 `@comfyorg/litegraph` bundle 里找符号全部 0 命中
 * （node_modules 被 `.gitignore` + 默认 exclude **两层**挡住，且都无法绕过），
 * 模型最后退化为 execute_code 跑 python 手工扫文件。
 *
 * 最关键的断言是**放行范围最小化**：只放行搜索根里实际出现的目录名，其余排除项
 * 必须保留 —— 否则一次「我要搜依赖」会把默认搜索面永久放宽。
 */

import assert from 'assert';
import {
	computeSearchScopeOverride, applyExcludeOverride, applyNoiseDirsOverride,
} from '../../browser/providers/tool/searchScopeOverride.js';

/** 简化版噪声目录集（取真实 NOISE_DIR_NAMES 的代表子集）。 */
const NOISE = new Set([
	'node_modules', '.git', 'out', 'dist', 'build', 'coverage',
	'.worktrees', 'Intermediate', 'target', 'venv',
]);

suite('searchScopeOverride — computeSearchScopeOverride', () => {

	test('★ 日志场景：根指向 node_modules/<pkg>/dist → 同时放行 node_modules 与 dist', () => {
		// 目标 bundle 路径里**同时**含 node_modules 和 dist，两个排除项都得放行才搜得到
		const p = 'g:\\CustomWorkspaces\\AIProjects\\sarosis-agents-client\\src\\vs\\sessions\\contrib\\agentStudio\\webview\\node_modules\\@comfyorg\\litegraph\\dist';
		const o = computeSearchScopeOverride(p, NOISE);
		assert.strictEqual(o.hasOverride, true);
		assert.deepStrictEqual([...o.noiseDirsToDrop].sort(), ['dist', 'node_modules']);
		assert.strictEqual(o.disregardIgnoreFiles, true, '第一层 .gitignore 也必须解除');
	});

	test('★ 放行范围最小化：其余排除项一个都不能动', () => {
		const o = computeSearchScopeOverride('/repo/node_modules/pkg', NOISE);
		const dropped = new Set(o.noiseDirsToDrop);
		for (const keep of ['.git', 'out', 'build', 'coverage', '.worktrees', 'target', 'venv']) {
			assert.ok(!dropped.has(keep), `${keep} 必须保持排除`);
		}
	});

	test('普通源码根 → 无放行（默认行为完全不变）', () => {
		const o = computeSearchScopeOverride('g:\\repo\\src\\vs\\sessions', NOISE);
		assert.strictEqual(o.hasOverride, false);
		assert.strictEqual(o.disregardIgnoreFiles, false);
		assert.strictEqual(o.excludeGlobsToDrop.length, 0);
	});

	test('undefined / 空路径 → 无放行', () => {
		assert.strictEqual(computeSearchScopeOverride(undefined, NOISE).hasOverride, false);
		assert.strictEqual(computeSearchScopeOverride('', NOISE).hasOverride, false);
	});

	test('★ 正反斜杠混用都能识别（模型同一会话里两种都用）', () => {
		const a = computeSearchScopeOverride('/g/repo/node_modules/pkg', NOISE);
		const b = computeSearchScopeOverride('g:\\repo\\node_modules\\pkg', NOISE);
		assert.strictEqual(a.hasOverride, true, 'POSIX 风格');
		assert.strictEqual(b.hasOverride, true, 'Windows 风格');
	});

	test('★ 修正 .worktrees 注释所称行为：显式指向 worktree 现在真的能搜', () => {
		// DEFAULT_EXCLUDE_GLOBS 的注释声称「显式传 path_filter 指向具体 worktree 即可
		// 绕过本排除」—— 实测绕不过（glob 按完整路径匹配）。现由本模块兑现该承诺。
		const o = computeSearchScopeOverride('/repo/.worktrees/feat-chat/src', NOISE);
		assert.strictEqual(o.hasOverride, true);
		assert.ok(new Set(o.noiseDirsToDrop).has('.worktrees'));
	});

	test('★ 只匹配完整路径段，不做子串匹配', () => {
		// `my-node_modules-backup` 不是 node_modules，不应触发放行
		assert.strictEqual(computeSearchScopeOverride('/repo/my-node_modules-backup/x', NOISE).hasOverride, false);
		assert.strictEqual(computeSearchScopeOverride('/repo/distribution/x', NOISE).hasOverride, false,
			'distribution 不是 dist');
	});

	test('reason 始终可读（用于日志复盘）', () => {
		assert.match(computeSearchScopeOverride('/r/node_modules/p', NOISE).reason, /node_modules/);
		assert.ok(computeSearchScopeOverride('/r/src', NOISE).reason.length > 0);
	});
});

suite('searchScopeOverride — applyExcludeOverride', () => {

	const baseExpr = Object.freeze({
		'**/node_modules/**': true, '**/.git/**': true, '**/out/**': true,
		'**/dist/**': true, '**/coverage/**': true, '**/.env': true,
	});

	test('★ 移除命中的 glob，保留其余', () => {
		const o = computeSearchScopeOverride('/r/node_modules/p/dist', NOISE);
		const out = applyExcludeOverride(baseExpr, o);
		assert.strictEqual(out['**/node_modules/**'], undefined, 'node_modules 放行');
		assert.strictEqual(out['**/dist/**'], undefined, 'dist 放行');
		assert.strictEqual(out['**/.git/**'], true, '.git 保留');
		assert.strictEqual(out['**/out/**'], true, 'out 保留');
		assert.strictEqual(out['**/coverage/**'], true, 'coverage 保留');
		assert.strictEqual(out['**/.env'], true, '敏感文件排除必须保留');
	});

	test('★★ 绝不原地改传入对象（exclude 表是进程级缓存，污染会全局放宽）', () => {
		const o = computeSearchScopeOverride('/r/node_modules/p', NOISE);
		applyExcludeOverride(baseExpr, o);
		assert.strictEqual(baseExpr['**/node_modules/**'], true,
			'原表必须保持不变，否则一次放行会永久污染后续所有搜索');
	});

	test('无放行时返回等价副本', () => {
		const o = computeSearchScopeOverride('/r/src', NOISE);
		const out = applyExcludeOverride(baseExpr, o);
		assert.deepStrictEqual(out, { ...baseExpr });
	});
});

suite('searchScopeOverride — applyNoiseDirsOverride', () => {

	test('walk-fallback 与 ripgrep 路径语义等价', () => {
		const o = computeSearchScopeOverride('/r/node_modules/p', NOISE);
		const out = applyNoiseDirsOverride(NOISE, o);
		assert.ok(!out.has('node_modules'), 'node_modules 放行');
		assert.ok(out.has('.git'), '.git 保留');
		assert.ok(out.has('out'), 'out 保留');
	});

	test('★ 不改传入集合（NOISE_DIR_NAMES 是 static readonly）', () => {
		const o = computeSearchScopeOverride('/r/node_modules/p', NOISE);
		applyNoiseDirsOverride(NOISE, o);
		assert.ok(NOISE.has('node_modules'), '原集合必须保持不变');
	});

	test('无放行时直接返回原集合（零分配快路径）', () => {
		const o = computeSearchScopeOverride('/r/src', NOISE);
		assert.strictEqual(applyNoiseDirsOverride(NOISE, o), NOISE);
	});
});
