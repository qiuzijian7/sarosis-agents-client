/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 技能根单一真源的守卫（P1，2026-10-13）：顺序 / trust 门控 / 两个开关 / 去重 / 两侧真接线。
 *
 * 为什么值得钉住（方案稿 `doc/dsh-skill-roots-plan.md` §2 四条不变量）：
 *   1. 顺序即优先级 ⇒ 顺序错了就是"用户改了同名技能不生效"且**零提示** ✗（P0 刚修过的同类问题）；
 *   2. 项目级根是**提示词注入面** ⇒ 未信任时**一个都不能进**，而且不能静默（要留 `skippedUntrusted` ✓）；
 *   3. 两个开关必须能回到旧行为（不变量 4）：项目级 ← `projectRoots`、官方用户级 ← `officialUserRoot` ✓；
 *   4. 两个消费点必须读同一份（不同源 = "IDE 看得见、聊天框看不见" ✗✗）。
 * 前四条都是**行为**（真跑函数），后一条是**接线**（读源码）—— 两类都不能只靠注释 ✗。
 *
 * 运行：node src/vs/sessions/contrib/agentStudio/test/common/run-all-common-tests.mjs
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
	SKILL_OFFICIAL_USER_ROOT_SETTING_ID,
	SKILL_PROJECT_ROOTS_SETTING_ID,
	SKILL_ROOT_SPECS,
	officialUserSkillRootCandidates,
	resolveSkillRoots,
} from '../../common/skillRoots.js';

const REPO = process.cwd();
const IDE_SERVICE = path.join(REPO, 'src/vs/sessions/contrib/agentStudio/browser/skillRegistryService.ts');
const HOST_SERVICE = path.join(REPO, 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts');
const CONTRIBUTION = path.join(REPO, 'src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts');
const DSH_HARNESS_COMMON = path.join(REPO, 'src/vs/sessions/contrib/dshHarness/common/dshHarness.ts');

/** 读源码（守卫不能空跑：读不到就让用例红 ✗）。 */
function source(rel: string): string {
	const abs = path.join(REPO, rel);
	assert.ok(fs.existsSync(abs), `读不到 ${rel}（cwd=${REPO}）`);
	const text = fs.readFileSync(abs, 'utf8');
	assert.ok(text.length > 0, `${rel} 是空文件（守卫不能空跑）`);
	return text;
}

const WS = 'G:\\ws\\app';
const DATA_ROOT = 'C:\\Users\\u\\.vssaros';
const USER_HOME = 'C:\\Users\\u';
const BUILTIN = 'G:\\ws\\app\\resources\\.agents\\skills';
/** 官方用户级候选：dev 的 DSH_HOME 在数据根下（见 `officialUserSkillRootCandidates` 注释 ✓）。 */
const OFFICIAL_USER = `${DATA_ROOT}\\dsh-home\\skills`;

/** 一个"全都在、且已信任"的典型现场。 */
const BASES = {
	workspaceFolders: [WS],
	dataRoot: DATA_ROOT,
	officialUserDirs: [OFFICIAL_USER],
	builtinDirs: [BUILTIN],
};
const ALL_ON = { trusted: true, projectRoots: true, officialUserRoot: true };

suite('技能根 · 单一真源：顺序 / 门控 / 两个开关', () => {

	test('顺序即优先级：项目级 .dsh → 项目级 .agents → 用户级 → 官方用户级 → 内置', () => {
		const { roots } = resolveSkillRoots(BASES, ALL_ON);
		assert.deepStrictEqual(roots.map(r => r.fsPath), [
			'G:\\ws\\app\\.dsh\\skills',
			'G:\\ws\\app\\.agents\\skills',
			'C:\\Users\\u\\.vssaros\\skills',
			`${DATA_ROOT}\\dsh-home\\skills`,
			'G:\\ws\\app\\resources\\.agents\\skills',
		], '顺序错了优先级就错（同 rank 内 first-wins）：官方顺序是 项目级(100/200) → 自定义(300) → 官方用户级(400) → bundled(600) ✗');
		assert.deepStrictEqual(roots.map(r => r.scope), ['project', 'project', 'user', 'user', 'builtin']);
	});

	test('★ 未信任：项目级一个都不进（含"被记下来"），但**官方用户级仍然在**', () => {
		const { roots, skippedUntrusted } = resolveSkillRoots(BASES, { ...ALL_ON, trusted: false });
		assert.deepStrictEqual(roots.map(r => r.fsPath), [
			'C:\\Users\\u\\.vssaros\\skills',
			`${DATA_ROOT}\\dsh-home\\skills`,
			'G:\\ws\\app\\resources\\.agents\\skills',
		], '未信任时**只有工作区目录**要被挡（可被 clone 注入 ✗）；用户主目录下的根信任级别相同 ⇒ 照常加载 ✓');
		assert.deepStrictEqual(skippedUntrusted, [
			'G:\\ws\\app\\.dsh\\skills',
			'G:\\ws\\app\\.agents\\skills',
		], '被门控挡掉的根必须能被调用方读到 ⇒ 否则就是"静默少一半技能" ✗');
	});

	test('★ 开关 projectRoots 关闭（一键回滚）：项目级整族消失，且不再有"未信任"提示', () => {
		const { roots, skippedUntrusted } = resolveSkillRoots(BASES, { trusted: false, projectRoots: false, officialUserRoot: true });
		assert.deepStrictEqual(roots.map(r => r.fsPath), [
			'C:\\Users\\u\\.vssaros\\skills',
			`${DATA_ROOT}\\dsh-home\\skills`,
			'G:\\ws\\app\\resources\\.agents\\skills',
		], '关掉开关必须回到 2026-10-13 之前的行为（不变量 4）');
		assert.deepStrictEqual(skippedUntrusted, [],
			'用户主动关的，不是被门控挡的 ⇒ 不该再提示（提示就是噪音 ✗）');
	});

	test('★ 开关 officialUserRoot 关闭：官方用户级整族消失，**项目级不受影响**（两个开关独立）', () => {
		const { roots } = resolveSkillRoots(BASES, { trusted: true, projectRoots: true, officialUserRoot: false });
		assert.deepStrictEqual(roots.map(r => r.fsPath), [
			'G:\\ws\\app\\.dsh\\skills',
			'G:\\ws\\app\\.agents\\skills',
			'C:\\Users\\u\\.vssaros\\skills',
			'G:\\ws\\app\\resources\\.agents\\skills',
		], '两个开关必须互不影响：关官方用户级不该连带动到项目级 ✓');
	});

	test('多根工作区：每个根的 .dsh/.agents 都要进（顺序 = folder 顺序）', () => {
		const { roots } = resolveSkillRoots(
			{ workspaceFolders: ['G:\\a', 'G:\\b'], dataRoot: 'D:\\data' }, ALL_ON);
		assert.deepStrictEqual(roots.map(r => r.fsPath), [
			'G:\\a\\.dsh\\skills', 'G:\\b\\.dsh\\skills',
			'G:\\a\\.agents\\skills', 'G:\\b\\.agents\\skills',
			'D:\\data\\skills',
		], '多根下漏掉某个根 ⇒ 那个根里的项目技能在 IDE 与 Host 两侧都看不见 ✗');
	});

	test('去重：同一物理目录被两处引用（大小写/尾分隔符不同）只留一份', () => {
		const { roots } = resolveSkillRoots({
			workspaceFolders: ['G:\\WS'],
			dataRoot: 'C:\\Users\\u\\.vssaros',
			// 与项目级 `.dsh/skills` 是**同一个物理目录**，只是大小写与首字符不同 ⇒ 必须去重
			builtinDirs: ['g:\\ws\\.dsh\\skills'],
		}, ALL_ON);
		assert.deepStrictEqual(roots.map(r => r.fsPath), [
			'G:\\WS\\.dsh\\skills',
			'G:\\WS\\.agents\\skills',
			'C:\\Users\\u\\.vssaros\\skills',
		], '同一个目录被两个根引用时必须只留一份（先到先得）：扫两遍白跑同级同内容分支 + 噪音 ✗');
	});

	test('官方用户级与用户级撞同一目录时也去重（用户把 DshHome 指到数据根之外/之内都可能撞）', () => {
		const { roots } = resolveSkillRoots({
			workspaceFolders: [],
			dataRoot: 'C:\\Users\\u\\.vssaros',
			officialUserDirs: ['c:\\users\\u\\.vssaros\\skills'],   // 故意与数据根的用户库同目录、大小写不同
		}, ALL_ON);
		assert.deepStrictEqual(roots.map(r => r.fsPath), ['C:\\Users\\u\\.vssaros\\skills'],
			'官方用户级与自营用户库指向同一目录时必须只留一份（否则同级同内容分支白跑 ✗）');
	});

	test('缺基址不算错：拿不到数据根/内置目录就不产出那一条', () => {
		const { roots } = resolveSkillRoots({ workspaceFolders: [] }, ALL_ON);
		assert.deepStrictEqual(roots, [], '一个基址都没有 ⇒ 空清单（调用方据此不挂覆盖层 ✓）');
	});

	test('拼接用基址自己的分隔符（Windows 反斜杠不能混进正斜杠）', () => {
		const win = resolveSkillRoots({ workspaceFolders: ['G:\\ws'], builtinDirs: ['G:\\ws\\res'] }, ALL_ON);
		for (const root of win.roots) {
			assert.ok(!root.fsPath.includes('/'),
				'Windows 基址上不得出现正斜杠（混用路径会与主进程/IDE 侧的字面比较对不上 ✗）：' + root.fsPath);
		}
		const posix = resolveSkillRoots({ workspaceFolders: ['/home/u/ws'], dataRoot: '/home/u/.vssaros', officialUserDirs: ['/home/u/.dsh/skills'] }, ALL_ON);
		assert.deepStrictEqual(posix.roots.map(r => r.fsPath), [
			'/home/u/ws/.dsh/skills', '/home/u/ws/.agents/skills', '/home/u/.vssaros/skills', '/home/u/.dsh/skills',
		], 'POSIX 基址上必须用正斜杠 ✓');
	});

	test('生态用户级目录追加在最后（清单当前为空 ⇒ 通常一个都不加）', () => {
		const { roots } = resolveSkillRoots({ ...BASES, extraUserDirs: ['C:\\Users\\u\\.agents\\skills'] }, ALL_ON);
		assert.strictEqual(roots[roots.length - 1].fsPath, 'C:\\Users\\u\\.agents\\skills',
			'生态目录必须排在最后（历史顺序：内置之后）⇒ 否则与 2026-10-12 起的行为不一致 ✗');
		assert.strictEqual(roots[roots.length - 1].scope, 'user');
	});
});

suite('技能根 · 官方用户级目录的路径公式（<DSH_HOME>/skills）', () => {

	test('三个候选：设置项 → dev 默认（数据根/dsh-home）→ 打包版回落 ~/.dsh', () => {
		assert.deepStrictEqual(
			officialUserSkillRootCandidates({ dshHome: 'D:\\custom-dsh-home', dataRoot: DATA_ROOT, userHome: USER_HOME }),
			['D:\\custom-dsh-home\\skills', `${DATA_ROOT}\\dsh-home\\skills`, `${USER_HOME}\\.dsh\\skills`],
			'三个候选的顺序必须是 设置项 → dev 默认 → 打包版默认（前者优先，用户配了就以他为准 ✓）');
	});

	test('缺省基址不产出对应候选（拿不到主目录也能算）', () => {
		assert.deepStrictEqual(officialUserSkillRootCandidates({ dataRoot: DATA_ROOT }),
			[`${DATA_ROOT}\\dsh-home\\skills`], '没有 dshHome/userHome 时只该有 dev 默认那条');
		assert.deepStrictEqual(officialUserSkillRootCandidates({}), [], '什么都没有 ⇒ 空候选（不报错 ✓）');
		assert.deepStrictEqual(officialUserSkillRootCandidates({ dshHome: '   ' }),
			[], '空白设置项等同于没配（`getValue` 返回空串是常态 ✗）');
	});

	test('用户把 DshHome 配成 ~/.dsh 时，两个候选就是同一目录 ⇒ 去重成一个', () => {
		assert.deepStrictEqual(
			officialUserSkillRootCandidates({ dshHome: `${USER_HOME}\\.dsh`, userHome: USER_HOME }),
			[`${USER_HOME}\\.dsh\\skills`],
			'候选重合必须去重（否则同一技能扫两遍 + 无信息量的同级比较 ✗）');
	});
});

suite('技能根 · 两个消费点都真接线（防"有模块没人用"）', () => {

	test('★ dsh 侧与 IDE 侧都必须调 resolveSkillRoots（同源 = 本模块存在的唯一理由）', () => {
		for (const [label, rel] of [['Host 侧', HOST_SERVICE], ['IDE 侧', IDE_SERVICE]] as const) {
			const text = fs.readFileSync(rel, 'utf8');
			assert.match(text, /resolveSkillRoots\s*\(/,
				`${label} 未调用 resolveSkillRoots ⇒ 又回到"两侧各自拼目录"✗✗（那正是本模块要消灭的漂移）`);
			assert.match(text, /officialUserSkillRootCandidates\s*\(/,
				`${label} 未调用 officialUserSkillRootCandidates ⇒ 官方用户级目录的路径公式又变成两份 ✗`);
		}
	});

	test('★ trust 门控真接线：Host 侧读 isWorkspaceTrusted、IDE 侧同样（否则项目根无条件进上下文）', () => {
		const host = fs.readFileSync(HOST_SERVICE, 'utf8');
		assert.match(host, /IWorkspaceTrustManagementService/, 'Host 侧必须注入 Workspace Trust 服务');
		assert.match(host, /isWorkspaceTrusted\(\)/, 'Host 侧必须**真的读**信任状态（注入了不用 = 没门控 ✗）');
		assert.match(host, /trusted:\s*[^,]*isWorkspaceTrusted\(\)/,
			'trusted 必须直接来自 isWorkspaceTrusted()，不能是别的推断（推错的后果是未信任仓库的技能进上下文 ✗✗）');

		const ide = fs.readFileSync(IDE_SERVICE, 'utf8');
		assert.match(ide, /IWorkspaceTrustManagementService/, 'IDE 侧必须注入 Workspace Trust 服务');
		assert.match(ide, /isWorkspaceTrusted\(\)/, 'IDE 侧必须**真的读**信任状态');
	});

	test('★ 开关真接线：两侧都读两个设置键（关不干净 = 回滚不可信）', () => {
		for (const rel of [HOST_SERVICE, IDE_SERVICE]) {
			const text = fs.readFileSync(rel, 'utf8');
			// 两侧都用**常量**读开关（字面量只允许出现在声明那里 ✓）⇒ 常量名不在 = 这个开关没接线 ✗
			for (const constName of ['SKILL_PROJECT_ROOTS_SETTING_ID', 'SKILL_OFFICIAL_USER_ROOT_SETTING_ID']) {
				assert.ok(text.includes(constName),
					`${rel} 未用 ${constName} 读开关 ⇒ 一键回滚失效（不变量 4）✗`);
			}
		}
		assert.strictEqual(SKILL_PROJECT_ROOTS_SETTING_ID, 'agentStudio.skills.projectRoots');
		assert.strictEqual(SKILL_OFFICIAL_USER_ROOT_SETTING_ID, 'agentStudio.skills.officialUserRoot',
			'设置键改了就要同步改这一行与声明处（改键 = 老用户设置静默失效 ✗）');
		// 声明处用的是字面量（少引一层）⇒ 必须有一条守卫比对"声明了"与"读的键"一致 ✓
		const contribution = fs.readFileSync(CONTRIBUTION, 'utf8');
		for (const key of [SKILL_PROJECT_ROOTS_SETTING_ID, SKILL_OFFICIAL_USER_ROOT_SETTING_ID]) {
			assert.ok(contribution.includes(`'${key}':`),
				`设置声明里找不到 ${key} ⇒ 用户看不到这个开关（一键回滚形同虚设 ✗）`);
		}
		assert.match(contribution, /'agentStudio\.skills\.projectRoots':[\s\S]{0,200}?default: true/,
			'默认值必须是 true（= 受信任时启用项目技能）；改默认值要在这条守卫里写明理由');
		assert.match(contribution, /'agentStudio\.skills\.officialUserRoot':[\s\S]{0,200}?default: true/,
			'官方用户级默认 true（2026-10-13 用户拍板"支持"）；改默认值要在这条守卫里写明理由');
	});

	test('★ dshHome 设置键在两侧同值（IDE 侧用的是字面量，漂了就是"技能看不见"✗）', () => {
		const common = fs.readFileSync(DSH_HARNESS_COMMON, 'utf8');
		assert.match(common, /DshHome = 'sessions\.dshHarness\.dshHome'/,
			'DshHarnessSettings.DshHome 的键变了 ⇒ 同步改 skillRegistryService 里的字面量与本守卫');
		assert.match(fs.readFileSync(IDE_SERVICE, 'utf8'), /'sessions\.dshHarness\.dshHome'/,
			'IDE 侧必须用同一个键读 dshHome（否则它算出的官方用户级目录与 Host 侧不是同一个 ✗）');
	});

	test('★ IDE 侧 rank 表必须有 project，且**高于** user（官方：项目级 100 先于用户级 400）', () => {
		const ide = fs.readFileSync(IDE_SERVICE, 'utf8');
		// ⚠ 别用"声明处往后切 N 个字符"那种窗口取表（2026-10-13 踩过）：表里多几行注释/多一个键，
		//   `project:`/`user:` 就被挤出窗口 ⇒ 用例报"表里没有 project"，而表其实好好的 ✗。
		//   取**整张表**：从声明名到该对象字面量结束的 `};`（找不到就让用例红，不能空跑 ✓）。
		const at = ide.indexOf('SKILL_SOURCE_RANK');
		assert.ok(at > 0, '找不到 SKILL_SOURCE_RANK（改名就要同步改本守卫）');
		const end = ide.indexOf('};', at);
		assert.ok(end > at, 'rank 表没有找到结束的 `};`（结构变了 ⇒ 守卫不能空跑）');
		const table = ide.slice(at, end);
		assert.match(table, /project:\s*\d+/,
			'rank 表缺 project ⇒ 项目级技能 rank=0，会被内置(1)静默压掉 ✗');
		const project = /project:\s*(\d+)/.exec(table);
		const user = /user:\s*(\d+)/.exec(table);
		assert.ok(project && user, 'rank 表里应同时有 project 与 user');
		assert.ok(Number(project![1]) > Number(user![1]),
			'project 的 rank 必须高于 user（值越大优先级越高）—— 与 dsh 侧根顺序 [项目级, 用户级, 内置] 一致 ✓');
	});

	test('清单里的 project 根必须带 requiresTrust（谁把门控关掉，这里就红）', () => {
		for (const spec of SKILL_ROOT_SPECS.filter(s => s.scope === 'project')) {
			assert.strictEqual(spec.requiresTrust, true,
				`项目级根 ${spec.rel} 必须门控 trust（工作区目录可被 clone 注入 ⇒ 提示词注入面 ✗✗）`);
			assert.strictEqual(spec.gatedBy, 'projectRoots', `项目级根 ${spec.rel} 的开关必须是 projectRoots`);
		}
		for (const spec of SKILL_ROOT_SPECS.filter(s => s.base === 'officialUser')) {
			assert.strictEqual(spec.requiresTrust, false,
				'官方用户级在用户主目录下 ⇒ **不该**要 trust（信任级别与我们自己的用户库相同 ✓）');
			assert.strictEqual(spec.gatedBy, 'officialUserRoot', '官方用户级根必须挂在 officialUserRoot 开关上');
		}
	});
});


