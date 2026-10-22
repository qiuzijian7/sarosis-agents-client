/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **只读技能来源**（内置 / dsh 插件自带）的收口守卫（2026-10-13 P2）。
 *
 * 背景：为落实"archify 只以 dsh 插件为唯一来源"，IDE 技能库新增了 `source: 'plugin'` 的技能
 * （文件在 `<插件包>/skills` 下，即 `node_modules` / `profile/.vssaros/plugins` 里）。
 * 那些目录**不是我们的**：原来只挡 `=== 'builtin'` 的几处守卫，一旦漏掉 `'plugin'`，后果是
 * **真删/真写依赖产物**（`uninstallSkill` 与 `skill_manage delete` 都是 `fs.rm`，写得进去也会被
 * 包管理器静默回滚 ✗✗）。所以：
 *
 *   · 判据只有一处实现（`common/skills.ts` 的 `isSkillReadOnly`）；
 *   · 每个会写/会删的入口都必须**调它**（而不是各写一遍 `=== 'builtin'`）—— 本文件按调用形态钉住；
 *   · 标签要分开显示（"内置" vs "插件技能"）：说成内置会让人以为技能随产品走 ✗。
 *
 * 运行：node src/vs/sessions/contrib/agentStudio/test/common/run-all-common-tests.mjs
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { isSkillReadOnly } from '../../common/skills.js';
import type { ISkillDefinition } from '../../common/skills.js';
import { skillSourceLabel } from '../../browser/skillSourceLabel.js';

const REPO = process.cwd();

function source(rel: string): string {
	const abs = path.join(REPO, rel);
	assert.ok(fs.existsSync(abs), `读不到 ${rel}（cwd=${REPO}）`);
	const text = fs.readFileSync(abs, 'utf8');
	assert.ok(text.length > 0, `${rel} 是空文件（守卫不能空跑）`);
	return text;
}

const SKILL_MANAGER = 'src/vs/sessions/contrib/agentStudio/browser/skillManagerTool.ts';
// ★ 2026-10-20：`providers/tool/skillTools.ts` 已在提交 0f01ef10a43（"legacy 工具整体下线"）里删除，
//   它的写入/删除入口**并入了 skillManagerTool.ts**（LN316/395 就是那两个 isSkillReadOnly 调用）
//   ⇒ 原来那两条 WRITE_PATHS 现在指向同一个文件，用**两条不同的 pattern** 分别核对，
//     比"合并成一条"更严（任意一条被改坏都会红 ✓）。
const SKILL_INSTALL = 'src/vs/sessions/contrib/agentStudio/browser/skillInstallService.ts';
const INTEGRATION_VIEW = 'src/vs/sessions/contrib/agentStudio/browser/views/integrationView.ts';
const IDE_SERVICE = 'src/vs/sessions/contrib/agentStudio/browser/skillRegistryService.ts';
const SOURCE_LABEL = 'src/vs/sessions/contrib/agentStudio/browser/skillSourceLabel.ts';

/** 所有**会写盘/会删盘**的技能入口（漏一个 = 能删掉插件包里的文件 ✗）。 */
const WRITE_PATHS: readonly { readonly file: string; readonly pattern: RegExp; readonly why: string }[] = [
	{ file: SKILL_INSTALL, pattern: /isSkillReadOnly\(skill\.source\)/,
		why: 'uninstallSkill 会 `fileService.del` 掉技能目录 ⇒ 插件技能必须被挡（删的是插件包 ✗✗）' },
	// ⚠ 2026-10-20：`skill_manage action=delete` 那条入口随 `providers/tool/skillTools.ts` 一起下线了
	//   （提交 0f01ef10a43「legacy 工具整体下线」）。它在 skillManagerTool.ts 里**没有**对应物
	//   （那儿只有 `isSkillReadOnly(existing.source)` 两处，分别管 updateSkill / patchSkill ⇒ 见下一条）。
	//   所以这里**删掉这一项**，而不是改指到同一个文件 —— 指向同一文件且同一 pattern 只会变成
	//   一条重复断言，看着是两条、实际只挡一件事（假安全感 ✗）。
	//   若将来恢复 skill_manage 的删除能力，必须把这一项加回来。
	{ file: SKILL_MANAGER, pattern: /isSkillReadOnly\(existing\.source\)/,
		why: 'updateSkill / patchSkill 会把 SKILL.md 写进技能目录 ⇒ 只读来源必须被挡' },
	{ file: INTEGRATION_VIEW, pattern: /isSkillReadOnly\(skill\.source\)/,
		why: '技能库的删除入口不能出现在只读来源上（UI 入口 + 右键菜单两处）' },
];

suite('只读技能来源 · 判据与写入点收口', () => {

	test('isSkillReadOnly：内置与 dsh 插件自带是只读；用户/商城/扩展/内存/工作流/项目级都不是', () => {
		assert.strictEqual(isSkillReadOnly('builtin'), true);
		assert.strictEqual(isSkillReadOnly('plugin'), true,
			'插件技能的所有者是插件包（node_modules / profile 下的 .vssaros/plugins）⇒ 必须只读 ✗');
		const writable: ISkillDefinition['source'][] = ['project', 'user', 'marketplace', 'extension', 'memory', 'workflow'];
		for (const s of writable) {
			assert.strictEqual(isSkillReadOnly(s), false, `${s} 不是只读来源（改这一条要同时改所有写入点）`);
		}
	});

	test('★ 每个写入/删除入口都调 isSkillReadOnly（不各写一遍 === builtin）', () => {
		for (const { file, pattern, why } of WRITE_PATHS) {
			assert.match(source(file), pattern,
				`${file} 的只读守卫没走 isSkillReadOnly ⇒ ${why}`);
		}
	});

	test('★ 技能库两处删除入口都在（UI 按钮 + 右键菜单），且都判只读来源', () => {
		const view = source(INTEGRATION_VIEW);
		const hits = view.match(/isSkillReadOnly\(skill\.source\)/g) ?? [];
		assert.strictEqual(hits.length, 2,
			`技能库应有 2 处只读判定（badge 与 onDelete），实际 ${hits.length} 处 ⇒ 少一处就是"右键还能删" ✗`);
		assert.ok(!/skill\.source !== 'builtin'/.test(view),
			'旧的"只挡内置"写法必须收口到 isSkillReadOnly（漏了插件来源就能删插件包里的文件 ✗✗）');
	});

	test('标签分开显示：插件技能 ≠ 内置技能（说成内置会让人以为随产品走 ✗）', () => {
		const label = skillSourceLabel('plugin');
		assert.ok(label && label.includes('插件'), `插件来源必须有独立标签，实际拿到 ${JSON.stringify(label)}`);
		assert.notStrictEqual(label, skillSourceLabel('builtin'), '与"内置"共用标签 = 用户分不清技能归谁 ✗');
		assert.match(source(SOURCE_LABEL), /case 'plugin'/);
	});

	test('IDE 侧 rank 表必须有 plugin，且与 builtin 同档（dsh 侧两者同为 bundled/600）', () => {
		const ide = source(IDE_SERVICE);
		const at = ide.indexOf('SKILL_SOURCE_RANK');
		assert.ok(at > 0, '找不到 SKILL_SOURCE_RANK（改名就要同步改本守卫）');
		const table = ide.slice(at, at + 900);
		const plugin = /plugin:\s*(\d+)/.exec(table);
		const builtin = /builtin:\s*(\d+)/.exec(table);
		assert.ok(plugin, 'rank 表缺 plugin ⇒ 它落到 0，会被 workflow/memory 之外的一切压掉，且同级比较失去意义 ✗');
		assert.ok(builtin && Number(plugin![1]) === Number(builtin![1]),
			'plugin 必须与 builtin 同档（dsh 侧它们是同一档 bundled/600）；要改档必须同时改这条守卫与注释');
	});
});
