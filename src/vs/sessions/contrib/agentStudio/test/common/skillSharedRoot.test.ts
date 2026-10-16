/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **dsh 插件自带技能**（IDE 侧补的技能来源，2026-10-13 P2）的守卫。
 *
 * 为什么要一条（背景）：用户拍板"archify 以 dsh 插件 `@tt-a1i/archify-dsh` 为**唯一来源**" ——
 * 把 `resources/.agents/skills/archify` 从产品内置里删掉。但插件自带的技能在 dsh 里是**插件自己注册**的
 * （插件包内那行 `dsh-skill-filesystem`），IDE 技能库此前完全看不见 ⇒ 删了内置 = 技能从 IDE 侧消失 ✗。
 * 于是补一条**只给 IDE 侧**的技能根（`ideOnly`）。这条守卫钉住三件事：
 *
 *  1. **解析**（纯函数）：真实 profile 的 `package.json` 形状（`file:` 绝对/相对 + 注册表版本号 +
 *     `bundles` 里有但 `dependencies` 里没有的）都能算对，且保序去重；
 *  2. **不对称是刻意的**：不传 `includeIdeOnlyRoots` 时那条根**一条都不产出** —— dsh 侧走的就是这条
 *     路径，若它也开始注入 ⇒ 同一技能名两个 provider 各报一份（rank 还同为 bundled/600）✗✗；
 *  3. **接线**：IDE 侧真喂目录、真启用；Host 侧两边都不沾（读源码，防"实现改了没人用"）。
 *
 * 运行：node src/vs/sessions/contrib/agentStudio/test/common/run-all-common-tests.mjs
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { dshPluginSkillRootCandidates, dshProfileDirCandidates } from '../../common/dshPluginSkillRoots.js';
import { SKILL_ROOT_SPECS, resolveSkillRoots } from '../../common/skillRoots.js';

const REPO = process.cwd();
const IDE_SERVICE = path.join(REPO, 'src/vs/sessions/contrib/agentStudio/browser/skillRegistryService.ts');
const HOST_SERVICE = path.join(REPO, 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts');

/** 读源码（守卫不能空跑：读不到就让用例红 ✗）。 */
function source(abs: string): string {
	assert.ok(fs.existsSync(abs), `读不到 ${abs}（cwd=${REPO}）`);
	const text = fs.readFileSync(abs, 'utf8');
	assert.ok(text.length > 0, `${abs} 是空文件（守卫不能空跑）`);
	return text;
}

const DATA_ROOT = 'C:\\Users\\u\\.vssaros-dev';
const PROFILE_DIR = `${DATA_ROOT}\\dsh-home\\profiles\\vssaros`;

/**
 * **真机形态**的 profile `package.json` 片段（照 2026-10-13 本机 dev profile 抄，
 * 只留与解析相关的键）：三种 spec 形态都在这份里 ✓。
 */
const PROFILE_PKG = {
	dependencies: {
		'@tt-a1i/archify-dsh': '1.0.0',
		'@vssaros/dsh-kanban': 'file:C:/Users/u/.vssaros-dev/dsh-home/profiles/vssaros/.vssaros/plugins/vssaros-dsh-kanban-0.4.11',
		'@vssaros/dsh-unreal': 'file:.vssaros\\plugins\\vssaros-dsh-unreal-0.2.0',
		'@vssaros/dsh-skills': 'file:.vssaros/plugins/vssaros-dsh-skills-0.3.9',
	},
	dsh: {
		profile: {
			// `@deepseek-ai/dsh-base` 是**运行时**提供的（不在 dependencies 里）⇒ 必须被跳过
			bundles: [
				'@deepseek-ai/dsh-base',
				'@tt-a1i/archify-dsh',
				'@vssaros/dsh-kanban',
				'@vssaros/dsh-unreal',
				'@vssaros/dsh-skills',
			],
		},
	},
};

suite('dsh 插件自带技能 · 路径解析（IDE 侧补来源）', () => {

	test('profile 目录候选：设置项 → dev 默认（数据根/dsh-home）→ 打包版回落 ~/.dsh', () => {
		assert.deepStrictEqual(
			dshProfileDirCandidates({ dshHome: 'D:\\custom-dsh-home', dataRoot: DATA_ROOT, userHome: 'C:\\Users\\u' }),
			[
				'D:\\custom-dsh-home\\profiles\\vssaros',
				`${DATA_ROOT}\\dsh-home\\profiles\\vssaros`,
				'C:\\Users\\u\\.dsh\\profiles\\vssaros',
			],
			'候选顺序必须与 officialUserSkillRootCandidates 同一组基址（只是多拼 /profiles/<profile> ✓）');
	});

	test('profile 名留空 ⇒ 用产品默认（与 Host 启动用同一个常量）', () => {
		assert.deepStrictEqual(dshProfileDirCandidates({ dataRoot: DATA_ROOT, profile: '   ' }),
			[`${DATA_ROOT}\\dsh-home\\profiles\\vssaros`], '空白设置项等同没配（getValue 返回空串是常态 ✗）');
		assert.deepStrictEqual(dshProfileDirCandidates({ dataRoot: DATA_ROOT, profile: 'mine' }),
			[`${DATA_ROOT}\\dsh-home\\profiles\\mine`], '用户自己配了 profile 名就以他为准');
		assert.deepStrictEqual(dshProfileDirCandidates({}), [], '一个基址都没有 ⇒ 空候选（不报错 ✓）');
	});

	test('★ 真机形态的 profile：三种 spec 都算对，且跳过"运行时提供"的 bundle', () => {
		assert.deepStrictEqual(dshPluginSkillRootCandidates(PROFILE_PKG, PROFILE_DIR), [
			// 注册表版本号 ⇒ profile 的 node_modules 下
			`${PROFILE_DIR}\\node_modules\\@tt-a1i\\archify-dsh\\skills`,
			// `file:` 绝对路径 ⇒ 原样（连分隔符也不改写，绝对路径里的正斜杠保持 ✓）
			'C:/Users/u/.vssaros-dev/dsh-home/profiles/vssaros/.vssaros/plugins/vssaros-dsh-kanban-0.4.11/skills',
			// `file:` 相对路径（反斜杠形态）⇒ 挂到 profile 目录下
			`${PROFILE_DIR}\\.vssaros\\plugins\\vssaros-dsh-unreal-0.2.0\\skills`,
			// `file:` 相对路径（正斜杠形态）⇒ 同样挂到 profile 目录下（分隔符归一 ✓）
			`${PROFILE_DIR}\\.vssaros\\plugins\\vssaros-dsh-skills-0.3.9\\skills`,
		], '顺序 = dsh.profile.bundles 的顺序；`@deepseek-ai/dsh-base`（运行时提供、deps 里没有）必须被跳过');
	});

	test('解析不出来的一律跳过（不猜路径）：无 bundles / 非对象 / 空 spec', () => {
		assert.deepStrictEqual(dshPluginSkillRootCandidates({}, PROFILE_DIR), [], '没有 dsh.profile.bundles ⇒ 空');
		assert.deepStrictEqual(dshPluginSkillRootCandidates(undefined, PROFILE_DIR), [], '畸形入参按"没有"处理（不抛 ✗）');
		assert.deepStrictEqual(
			dshPluginSkillRootCandidates({ dependencies: { a: '   ' }, dsh: { profile: { bundles: ['a'] } } }, PROFILE_DIR),
			[], '空 spec（依赖没写版本/路径）⇒ 跳过，不能拼出 `<profile>/node_modules/a/skills` 这种假根 ✗');
		assert.deepStrictEqual(dshPluginSkillRootCandidates(PROFILE_PKG, '   '), [], '没有 profile 目录 ⇒ 空');
	});

	test('去重：两个 bundle 指向同一物理目录（大小写不同）只留一条', () => {
		const pkg = {
			dependencies: { a: 'file:C:/X/plug', b: 'file:c:\\x\\plug' },
			dsh: { profile: { bundles: ['a', 'b'] } },
		};
		assert.deepStrictEqual(dshPluginSkillRootCandidates(pkg, PROFILE_DIR),
			['C:/X/plug/skills'], 'Windows 路径大小写不敏感 ⇒ 同一目录不能算两条根（会白扫一遍 + 噪音 ✗）');
	});
});

suite('dsh 插件自带技能 · 技能根清单（只给 IDE 侧）', () => {

	const BASES = {
		workspaceFolders: ['G:\\ws'],
		dataRoot: DATA_ROOT,
		builtinDirs: ['G:\\ws\\app\\resources\\.agents\\skills'],
		dshPluginSkillDirs: ['C:\\Users\\u\\plug\\skills'],
	};
	const ALL_ON = { trusted: true, projectRoots: true, officialUserRoot: true };

	test('★ 不传 includeIdeOnlyRoots ⇒ 插件根一条都不产出（dsh 侧就是这条路径）', () => {
		const { roots } = resolveSkillRoots(BASES, ALL_ON);
		assert.ok(!roots.some(r => r.scope === 'plugin'),
			'dsh 侧不能注入插件技能根：插件已经自己注册过 ⇒ 同名两 provider 各报一份，模型拿到哪份就没保证了 ✗✗');
	});

	test('★ IDE 侧开启时：插件根在**最后**、scope=plugin（= 优先级最低，与 dsh 的 bundled/600 一致）', () => {
		const { roots } = resolveSkillRoots(BASES, { ...ALL_ON, includeIdeOnlyRoots: true });
		assert.deepStrictEqual(roots.map(r => r.fsPath), [
			'G:\\ws\\.dsh\\skills',
			'G:\\ws\\.agents\\skills',
			'C:\\Users\\u\\.vssaros-dev\\skills',
			'G:\\ws\\app\\resources\\.agents\\skills',
			'C:\\Users\\u\\plug\\skills',
		], '顺序错了优先级就错：插件根必须在内置**之后**（撞名时内置/用户技能压得住插件技能 ✓）');
		assert.strictEqual(roots[roots.length - 1].scope, 'plugin');
	});

	test('清单里那条根必须标 ideOnly + scope=plugin（谁改成对称，这里就红）', () => {
		const specs = SKILL_ROOT_SPECS.filter(s => s.base === 'dshPluginSkills');
		assert.strictEqual(specs.length, 1, '插件技能根只该有一条');
		assert.strictEqual(specs[0].ideOnly, true,
			'必须标 ideOnly：dsh 侧注入了就是重复交付 ✗（理由见 dshPluginSkillRoots.ts 头注释）');
		assert.strictEqual(specs[0].scope, 'plugin');
		assert.strictEqual(specs[0].requiresTrust, false,
			'插件包在**用户目录/产品目录**下（不是工作区）⇒ 不该要 trust（要了就是"未信任就少技能" ✗）');
	});

	test('★ 接线：IDE 侧真喂目录 + 真启用；Host 侧两边都不沾', () => {
		const ide = source(IDE_SERVICE);
		assert.match(ide, /dshPluginSkillDirs:\s*await this\._dshPluginSkillDirs\(\)/,
			'IDE 侧必须把插件目录喂给 resolveSkillRoots（否则那条根永远空 ✗）');
		assert.match(ide, /includeIdeOnlyRoots:\s*true/,
			'IDE 侧必须显式启用 ideOnly 根（否则补了来源也一条都不产出 ✗）');
		assert.match(ide, /dshPluginSkillRootCandidates\(/,
			'IDE 侧必须用共享解析器（自己拼一份路径 = 又一处会漂的实现 ✗）');
		assert.match(ide, /'sessions\.dshHarness\.profile'/,
			'profile 名必须从 sessions.dshHarness.profile 读（写死 vssaros 会让"用户改了 profile 名"静默失效 ✗）');

		const host = source(HOST_SERVICE);
		// 断言的是**调用形态**（不是名字出现）：Host 侧的注释里会提到这两个标识符，那是有意写的说明 ✓
		assert.ok(!/dshPluginSkillDirs\s*:/.test(host),
			'Host 侧不能喂插件技能目录：插件自己注册过了，重复注入 ⇒ 同名两份 ✗✗');
		assert.ok(!/includeIdeOnlyRoots\s*:\s*true/.test(host),
			'Host 侧不能启用 ideOnly 根（同上）✗✗');
	});
});
