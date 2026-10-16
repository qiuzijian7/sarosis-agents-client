/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 生态技能目录（用户级）清单的守卫 —— "一份清单、两侧共用、与上游对齐"。
 *
 * 为什么值得钉住：
 *   1. 这份清单的价值**全在"与其它工具一致"**：少一条 ⇒ 用户为 Claude/Copilot 写的技能在我们
 *      这儿看不见 ✗；多一条 ⇒ 去扫一个没人认的目录（白扫，还可能撞 id）✗。两种偏差都没有别的
 *      测试能发现 —— 只能靠"直接读上游源码清单"这条比对。
 *   2. 两个消费点（IDE 技能库 / dsh Host 覆盖层）必须同源：否则"IDE 看得见、Host 看不见"
 *      会让同一份技能在两侧行为不同，是最难查的一类不一致 ✗。
 *   3. 上游新增目录时我们该被**提醒**（变红），而不是永远静默落后 ⇒ 比对取的是上游源码本身。
 *
 * 运行：node src/vs/sessions/contrib/agentStudio/test/common/run-all-common-tests.mjs
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { URI } from '../../../../../base/common/uri.js';
import {
	ECOSYSTEM_USER_SKILL_DIRS,
	ecosystemUserSkillDirPaths,
	ecosystemUserSkillDirUris,
} from '../../common/skillEcosystemDirs.js';

const REPO = process.cwd();
const UPSTREAM = path.join(REPO, 'src/vs/workbench/contrib/chat/common/promptSyntax/config/promptFileLocations.ts');
const IDE_SERVICE = path.join(REPO, 'src/vs/sessions/contrib/agentStudio/browser/skillRegistryService.ts');
const HOST_SERVICE = path.join(REPO, 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts');

/** 从上游源码里抠出 `DEFAULT_SKILL_SOURCE_FOLDERS` 中以 `~/` 开头的 path（去掉 `~/`）。 */
function upstreamUserSkillDirs(): string[] {
	const text = fs.readFileSync(UPSTREAM, 'utf8');
	const start = text.indexOf('DEFAULT_SKILL_SOURCE_FOLDERS');
	assert.ok(start >= 0, '上游文件里找不到 DEFAULT_SKILL_SOURCE_FOLDERS：' + UPSTREAM);
	const end = text.indexOf('];', start);
	assert.ok(end > start, '上游清单块未闭合（解析器需更新）');
	const block = text.slice(start, end);
	return [...block.matchAll(/path:\s*'([^']+)'/g)]
		.map(m => m[1])
		.filter(p => p.startsWith('~/'))
		.map(p => p.slice(2));
}

suite('生态技能目录 · 刻意不扫（2026-10-12 用户决定）', () => {

	test('清单必须为空：不扫 ~/.agents|.copilot|.claude 的用户级技能目录', () => {
		// 上游（VS Code `DEFAULT_SKILL_SOURCE_FOLDERS` 的 user 三条）确实列了这三条 —— 我们是**刻意**偏离 ✗。
		// 所以仍然解析上游源码：解析成功证明"我们偏离的是一个**真实存在**的清单" ✓，
		// 而不是"上游压根没有、这个用例在自说自话" ✗。
		const upstream = upstreamUserSkillDirs();
		assert.ok(upstream.length >= 3,
			'上游用户级技能目录应至少 3 条，实测 ' + upstream.length + ' 条（' + upstream.join(', ') + '）—— 解析器可能失效');
		assert.deepStrictEqual([...ECOSYSTEM_USER_SKILL_DIRS], [],
			'本清单必须为空（2026-10-12 决定）：生态目录与自营/内置技能**同 rank** ⇒ 撞 id 时 first-wins 并逐 id WARN ✗'
			+ '（本机实测 .agents(31) 与 .claude(35) 有 31 个同名且内容逐字节相同 ⇒ 纯噪音）。'
			+ '要重新启用：先改本用例并写清理由（偏离上游必须显式可见 ✓）。偏离的上游清单：' + upstream.join(', '));
	});

	test('两种形态在空清单下的行为：返回空数组（不扫 ≠ 报错，调用方无需分支）', () => {
		const home = URI.file(REPO);   // 用 cwd 当"主目录"，规避平台路径形态差异
		assert.deepStrictEqual(ecosystemUserSkillDirUris(home), [], 'URI 形态应为空数组');
		assert.deepStrictEqual(ecosystemUserSkillDirPaths(REPO), [], '本机路径形态应为空数组');
		assert.deepStrictEqual(ecosystemUserSkillDirPaths(REPO + path.sep), [], '主目录带尾分隔符同样应为空数组');
	});
});

suite('生态技能目录 · 两个消费点都真接线（防"有函数没人用"）', () => {

	test('IDE 侧（skillRegistryService）与 Host 侧（dshHarnessService）各引其形态', () => {
		const ide = fs.readFileSync(IDE_SERVICE, 'utf8');
		assert.ok(/ecosystemUserSkillDirUris\s*\(/.test(ide),
			'skillRegistryService 未调用 ecosystemUserSkillDirUris ⇒ IDE 侧扫不到生态技能目录（清单成装饰）✗');

		const host = fs.readFileSync(HOST_SERVICE, 'utf8');
		assert.ok(/ecosystemUserSkillDirPaths\s*\(/.test(host),
			'dshHarnessService 未调用 ecosystemUserSkillDirPaths ⇒ Host 侧技能集与 IDE 不一致 ✗');
	});
});
