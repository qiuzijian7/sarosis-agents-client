/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 随包模块插件清单（`dshBundledPlugins`）：枚举 + 与已装清单合并。
 *
 * 这一段是"用户不用再手敲 spec"的资料源，所以三条口径要钉住：
 * ① **只列模块插件**（有 `vssaros.module` 的）——伴生插件（bridge / chat-surface）由启动时自动安装维护，
 *    混进来只会让人以为要手动装；读不动/非模块的条目进 `problems`（不静默丢，探针排障要看得出）；
 * ② 安装状态有**四种**（`state` 字段，真源在 `mergeBundledWithInstalled`）：未装 / 已安装 /
 *    **可升级**（profile 更旧）/ **改回**（profile 更新）；「已装但**停用**」是与 state **正交**的标记
 *    （界面要能说清"装了但关着"，否则用户点"安装"会以为没生效）；
 * ③ 版本比较**只有一处实现**（`comparePluginVersions`）——界面**不许**自己比 ✗（2026-10-12 修：
 *    此前徽标按"不等即升级"、按钮另有一份私有比较器，装了更新版本时两者会互相矛盾）。
 */

import assert from 'assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { comparePluginVersions, listBundledPlugins, mergeBundledWithInstalled } from '../../electron-main/dshBundledPlugins.js';

/** 造一个假随包目录：`<dir>/<名称>/package.json`。 */
function makeBundledDir(root: string, entries: Record<string, unknown | 'BROKEN'>): void {
	for (const [dirName, pkg] of Object.entries(entries)) {
		const d = join(root, dirName);
		mkdirSync(d, { recursive: true });
		writeFileSync(join(d, 'package.json'), pkg === 'BROKEN' ? '{ not json' : JSON.stringify(pkg), 'utf8');
	}
}

suite('dshBundledPlugins（随包模块清单）', () => {
	let root: string;

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'vssaros-bundled-'));
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test('★ 只列模块插件：有 `vssaros.module` 的进清单，伴生插件与坏包进 problems', () => {
		makeBundledDir(root, {
			'vssaros-kanban': { name: '@vssaros/dsh-kanban', version: '0.2.9', description: '看板', vssaros: { module: 'kanban' }, peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-0 <0.3.0-0' } },
			'vssaros-mcp': { name: '@vssaros/dsh-mcp', version: '0.1.0', vssaros: { module: 'mcp' } },
			// 伴生插件：没有 vssaros.module ⇒ 不该出现在"可安装"清单里
			'vssaros-bridge': { name: '@vssaros/dsh-bridge', version: '0.2.16' },
			'broken': 'BROKEN',
			'no-version': { name: '@vssaros/dsh-x', vssaros: { module: 'x' } },
		});
		const { packages, problems } = listBundledPlugins(root);
		assert.deepStrictEqual(packages.map(p => p.name).sort(), ['@vssaros/dsh-kanban', '@vssaros/dsh-mcp']);
		assert.deepStrictEqual(packages.map(p => p.module).sort(), ['kanban', 'mcp']);
		assert.strictEqual(packages.find(p => p.module === 'kanban')?.description, '看板');
		// peer 范围要带出来（运行时升级预检用）；没声明的就是 undefined（当无约束，不误报）
		assert.strictEqual(packages.find(p => p.module === 'kanban')?.peerRange, '>=0.1.7-0 <0.3.0-0');
		assert.strictEqual(packages.find(p => p.module === 'mcp')?.peerRange, undefined);
		assert.ok(problems.some(p => p.includes('vssaros-bridge') && p.includes('非模块插件')), `伴生插件应记 problem：${problems.join(' | ')}`);
		assert.ok(problems.some(p => p.includes('broken')), `坏包应记 problem：${problems.join(' | ')}`);
		assert.ok(problems.some(p => p.includes('no-version')), `缺 version 应记 problem：${problems.join(' | ')}`);
	});

	test('枚举顺序稳定：按模块 id 排，不受目录枚举顺序影响', () => {
		makeBundledDir(root, {
			'z-module': { name: '@vssaros/dsh-zr', version: '1.0.0', vssaros: { module: 'zeta' } },
			'a-module': { name: '@vssaros/dsh-aa', version: '1.0.0', vssaros: { module: 'alpha' } },
		});
		assert.deepStrictEqual(listBundledPlugins(root).packages.map(p => p.module), ['alpha', 'zeta']);
	});

	test('随包目录不存在（老构建没带 `dsh-plugins/`）⇒ 空清单 + 一条 problem，不抛', () => {
		const r = listBundledPlugins(join(root, 'nope'));
		assert.deepStrictEqual(r.packages, []);
		assert.strictEqual(r.problems.length, 1);
	});

	test('★ 合并的四种状态：未装 / 已安装 / 可升级 / 改回（+ 停用标记与状态正交）', () => {
		makeBundledDir(root, {
			'a': { name: '@vssaros/dsh-a', version: '1.2.0', vssaros: { module: 'a' } },
			'b': { name: '@vssaros/dsh-b', version: '2.0.0', vssaros: { module: 'b' } },
			'c': { name: '@vssaros/dsh-c', version: '0.5.0', vssaros: { module: 'c' } },
			'd': { name: '@vssaros/dsh-d', version: '3.0.0', vssaros: { module: 'd' } },
			'e': { name: '@vssaros/dsh-e', version: '1.5.0', vssaros: { module: 'e' } },
			'f': { name: '@vssaros/dsh-f', version: '0.9.0', vssaros: { module: 'f' } },
		});
		const rows = mergeBundledWithInstalled(listBundledPlugins(root).packages, [
			{ name: '@vssaros/dsh-b', version: '2.0.0' },                  // 已安装（同版本）
			{ name: '@vssaros/dsh-c', version: '0.4.0' },                  // profile 更旧 ⇒ 可升级
			{ name: '@vssaros/dsh-d', version: '3.0.0', enabled: false },  // 已装但停用
			{ name: '@vssaros/dsh-e', version: '1.6.0' },                  // profile 更新 ⇒ 改回
			{ name: '@vssaros/dsh-f' },                                    // 装了但读不到版本号
		]);
		const by = (n: string) => rows.find(r => r.name === `@vssaros/dsh-${n}`);

		// ── state 是四种状态的**真源**（界面只读它，不再自己比版本）──
		assert.strictEqual(by('a')?.state, 'missing', 'a 未装');
		assert.strictEqual(by('b')?.state, 'installed');
		assert.strictEqual(by('c')?.state, 'upgradable', 'profile 0.4.0 < 随包 0.5.0 ⇒ 按钮"升级到 v0.5.0"');
		assert.strictEqual(by('d')?.state, 'installed', '停用只影响 installedDisabled，不改 state');
		assert.strictEqual(by('e')?.state, 'downgradable', 'profile 1.6.0 > 随包 1.5.0 ⇒ 按钮必须说"改回"，说"升级"会骗人 ✗');
		assert.strictEqual(by('f')?.state, 'installed', '读不到版本号时沿用"视作随包版本已装"的既有口径（不把老 profile 判成要重装）');

		// ── 与 state 正交的两项标记 ──
		assert.strictEqual(by('a')?.installedVersion, undefined);
		assert.strictEqual(by('d')?.installedDisabled, true);
		assert.strictEqual(by('b')?.installedDisabled, undefined, '没停用的不该带这个标记');
		assert.strictEqual(by('e')?.installedVersion, '1.6.0', '高版本也要如实回传（徽标要显示它）');

		// 每行都带上随包版本与目录（安装按钮要用）
		assert.strictEqual(by('a')?.version, '1.2.0');
		assert.ok(by('a')?.dir.includes('vssaros-bundled-'), '应带随包目录');
	});
});

suite('comparePluginVersions（版本粗比较 · 状态定方向的唯一实现）', () => {

	test('相等 / 更旧 / 更新；数字段按**数值**比（不是字典序）；段数不足按 0 补', () => {
		assert.strictEqual(comparePluginVersions('0.4.0', '0.4.0'), 0);
		assert.strictEqual(comparePluginVersions('0.4.0', '0.5.0'), -1);
		assert.strictEqual(comparePluginVersions('1.6.0', '1.5.0'), 1);
		// 20 > 9：字典序会判反，数值段比较才对
		assert.strictEqual(comparePluginVersions('0.2.20', '0.2.9'), 1);
		// 段数不足按 0 补 ⇒ 1.0 == 1.0.0
		assert.strictEqual(comparePluginVersions('1.0', '1.0.0'), 0);
	});

	test('⚠ 已记录的局限：预发布段被当数字比（`0.2.0-rc.2` 会被判大于 `0.2.0`）', () => {
		// 这条**不是**在宣称正确，而是钉住当前语义：随包**插件**目前都是纯数字段版本
		// （`0.1.7` / `0.2.20` / `0.3.0`），所以够用；一旦插件版本出现 `-rc` 段，必须换成
		// base/common/semver（见 comparePluginVersions 的注释）。
		assert.ok(comparePluginVersions('0.2.0-rc.2', '0.2.0') > 0,
			'若这里变红：说明比较器换了实现（大概率改用 semver）⇒ 请一并更新本用例与调用方注释 ✓');
	});
});

suite('随包插件状态 · 界面不得自己比版本（防"第二套实现"）', () => {

	test('pluginsView 只用 row.state，且没有私有的版本比较器', () => {
		const view = readFileSync(join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/browser/views/pluginsView.ts'), 'utf8');
		assert.ok(/row\.state\s*===\s*'/.test(view),
			'pluginsView 未按 row.state 分支 ⇒ 界面又会各比一次版本，徽标/按钮矛盾会复发 ✗');
		assert.ok(!/_compareVersions\s*\(/.test(view),
			'pluginsView 里又出现了 _compareVersions( ⇒ 版本比较出现第二套实现 ✗（真源应在 dshBundledPlugins.comparePluginVersions）');
	});
});

suite('随包插件行形状 · 跨层镜像必须逐字段对应（防改一边忘一边）', () => {

	/** 抠出 `export interface <name> { ... }` 的字段名集合（排序后便于比较）。 */
	function interfaceFields(text: string, name: string): string[] {
		const start = text.indexOf(`export interface ${name} {`);
		assert.ok(start >= 0, `找不到 interface ${name}`);
		const end = text.indexOf('\n}', start);
		assert.ok(end > start, `interface ${name} 未闭合`);
		return [...text.slice(start, end).matchAll(/^\s*readonly (\w+)\??:/gm)].map(m => m[1]).sort();
	}

	test('agentStudio/browser 的镜像与 dshHarness/common 的真源字段一致', () => {
		const real = readFileSync(join(process.cwd(), 'src/vs/sessions/contrib/dshHarness/common/dshHarness.ts'), 'utf8');
		const mirror = readFileSync(join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/browser/dshPluginCenterHost.ts'), 'utf8');
		const a = interfaceFields(real, 'IDshBundledPluginRow');
		const b = interfaceFields(mirror, 'IDshBundledPluginRow');
		// 防空跑下限：真源至少要能解析出 6 个字段（正则失配时这条会红，而不是静默通过 ✓）
		assert.ok(a.length >= 6, `真源字段只解析到 ${a.length} 个，解析器或接口结构变了 —— 本用例已失效 ✗`);
		assert.deepStrictEqual(b, a,
			'两处 IDshBundledPluginRow 字段不一致 ⇒ 界面读不到新字段'
			+ `（2026-10-12 加 state 时正是漏了这份镜像 ✗）。真源=[${a.join(', ')}] 镜像=[${b.join(', ')}]`);
	});
});
