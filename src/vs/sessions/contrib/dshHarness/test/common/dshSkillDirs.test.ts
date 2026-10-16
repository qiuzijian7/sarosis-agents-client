/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { pathToFileURL } from 'node:url';
import { join } from '../../../../../base/common/path.js';
import { renderSkillsOverlay } from '../../common/dshSkillDirs.js';

suite('dshHarness / skills overlay', () => {

	test('单个 insert 块 + 独立 provider 行 + 目录内联列表', () => {
		// ⚠ 这里的两个目录都是**非内置**的（内置走 `bundledSkillDir`，见下面那条用例 ✓）：
		// 2026-10-13（P2）之前内置也在这张表里，那份形状已被推翻 ✗
		const yml = renderSkillsOverlay(['C:\\Users\\q\\.vssaros\\skills', 'C:\\Users\\q\\.dsh\\skills']);
		// 多个顶层 insert 块时加载器只认第一个（MCP 覆盖层实测的坑），必须只有一个。
		assert.strictEqual(yml.match(/^- insert:/gm)?.length, 1);
		assert.ok(yml.includes('- id: vssaros-skills'));
		assert.ok(yml.includes("name: '@deepseek-ai/dsh-skill-filesystem'"));
		assert.ok(yml.includes("providerName: 'vssaros'"));
		assert.ok(yml.includes('includeDefaultRoots: false'));
		assert.ok(yml.includes(`customSkillDirs: ['C:\\Users\\q\\.vssaros\\skills', 'C:\\Users\\q\\.dsh\\skills']`));
		assert.ok(!yml.includes('bundledSkillDir'), '没给内置目录时不该凭空写 bundledSkillDir（schema 会当配置 ✗）');
	});

	test('★ 内置走官方 bundled（rank 600），**不再混进 customSkillDirs**（那档锁死 300 ✗）', () => {
		const builtin = 'G:\\Saros\\resources\\.agents\\skills';
		const yml = renderSkillsOverlay(['C:\\Users\\q\\.vssaros\\skills'], builtin);
		assert.strictEqual(yml.match(/^- insert:/gm)?.length, 1, '仍然只能有一个顶层 insert 块 ✓');
		// 依据：`@deepseek-ai/dsh-skill-filesystem` 的 `bundledSkillDir` ⇒ `source: 'bundled'` +
		// `rank: BUNDLED_SKILL_RANK(600)`；而 `customSkillDirs` 的 300 是常量、配置里改不了 ✗。
		assert.ok(yml.includes(`bundledSkillDir: '${builtin.replace(/\\/g, '\\\\')}'`) || yml.includes(`bundledSkillDir: 'G:\\Saros\\resources\\.agents\\skills'`),
			'内置必须走 bundledSkillDir（否则它还是 300 ✗，与官方 rank 表不一致）');
		const custom = /customSkillDirs: \[([^\]]*)\]/.exec(yml);
		assert.ok(custom, 'customSkillDirs 必须还在（用户/项目根走它 ✓）');
		assert.ok(!custom![1].includes('resources'),
			'内置目录**不许**再出现在 customSkillDirs 里：那会让它同时以 300（胜出）+ 600 出现 ⇒ 等于没改 ✗ 且白扫两遍 ✗');
	});

	test('只有内置 / 两者都空：块的出现条件', () => {
		const onlyBundled = renderSkillsOverlay([], 'G:\\bin\\skills');
		assert.ok(onlyBundled.includes('- insert:'), '只有内置时也要挂覆盖层（否则内置技能整个不生效 ✗）');
		assert.ok(!onlyBundled.includes('customSkillDirs:'), '没有其它根时不写空的 customSkillDirs（schema 默认 [] ✓）');
		assert.ok(!renderSkillsOverlay([], undefined).includes('- insert:'), '两者都空 ⇒ 不产出 insert 块（旧行为 ✓）');
	});

	test('路径里的单引号按 YAML 双写转义', () => {
		const yml = renderSkillsOverlay([`/home/o'neil/.vssaros/skills`]);
		assert.ok(yml.includes(`'/home/o''neil/.vssaros/skills'`));
	});

	test('空目录列表不产出 insert 块', () => {
		const yml = renderSkillsOverlay([]);
		assert.ok(!yml.includes('- insert:'));
	});
});

/**
 * 技能检索结果的**可执行性**（2026-10-13 实测事故后新增）。
 *
 * 现场：技能里的脚本是模型用 bash/pwsh 执行的，而进程 cwd 是**会话工作区**、不是技能目录 ⇒ `SKILL.md`
 * 里那句 `node bin/archify.mjs doctor`（相对路径）在工作区根下直接 `Cannot find module
 * '<workspace>\bin\archify.mjs'` ✗✗。IDE 侧早就定了"技能 CLI 一律以绝对路径呈现"（2026-08-03 决策，
 * `skillTools.ts` 注入 skillDir + scriptPaths ✓），**dsh 侧此前没有这一层** ✗ —— 原生 `skill` 工具虽给
 * `resourceBase.directory`，但 `skill_search` 的结果里一个路径都没有 ⇒ 模型只能照 SKILL.md 的相对路径跑 ✗。
 *
 * 纯源码守卫：`skill_search` 的 render 是 `install()` 里的闭包，真跑起来要整棵 cordis ctx ✗
 * （真机行为由 p3 探针覆盖）。这里钉住"结构上不可能再退回去"。
 */
suite('dshHarness / 技能检索的绝对路径纪律（dsh 侧）', () => {
	const REL = 'dsh-plugins/vssaros-skills/lib/index.js';
	const src = (() => {
		const abs = join(process.cwd(), REL);
		return existsSync(abs) ? readFileSync(abs, 'utf8') : '';
	})();

	/**
	 * **行为**验证推导本身（不是正则守卫 —— 记忆里那条"正则守卫最容易错放/漏放" ✗）：
	 * 直接 import 插件里的 `store.js` 调 `skillDirOf`，与 `path` 口径对照 ✓。
	 * 动态 import + `pathToFileURL`：插件是 ESM、且不在本 tsconfig 的解析面内（照抄
	 * `dshWorkflowWriteLock.test.ts` 加载插件模块的手法 ✓）。
	 */
	test('skillDirOf：SKILL.md 路径 → 技能目录（Win/POSIX 两种分隔符都认）', async () => {
		const url = pathToFileURL(join(process.cwd(), 'dsh-plugins/vssaros-skills/lib/store.js')).href;
		const { skillDirOf } = await import(url) as { skillDirOf: (file: string) => string };
		const dir = join('/x', 'skills', 'archify');
		assert.strictEqual(skillDirOf(join(dir, 'SKILL.md')), dir, '去掉末段即技能目录');
		assert.strictEqual(skillDirOf(join(dir, 'SKILL.md')).endsWith('SKILL.md'), false, '结果里不许还带文件名');
		if (process.platform === 'win32') {
			assert.strictEqual(skillDirOf('G:\\repo\\resources\\.agents\\skills\\archify\\SKILL.md'),
				'G:\\repo\\resources\\.agents\\skills\\archify', 'Windows 反斜杠形态');
			assert.strictEqual(skillDirOf('G:/repo/skills/archify/SKILL.md'), 'G:/repo/skills/archify',
				'Windows 上的正斜杠形态（技能根可能来自配置里的任一种写法）');
		}
		assert.strictEqual(skillDirOf('SKILL.md'), '.', '裸文件名返回 `.`（扫描器给的都是绝对路径 ⇒ 正常走不到）');
	});

	test('★ 顺序：项目级 → 用户级 → 内置（同 rank 内 first-wins ⇒ 顺序即优先级）', () => {
		// ★ 2026-10-13（P1）改口径：顺序**不再由 dshHarnessService 里的字面量顺序**决定，而是单一真源
		// `agentStudio/common/skillRoots.ts` 的 `SKILL_ROOT_SPECS` ⇒ 守卫改盯真源 ✓。
		// （老写法（indexOf dshHarnessService 里两个路径字面量）在重构后**会静默失效** ✗ ——
		//   user 那行字面量已不在 `_skillDirs` 里，indexOf 返回 -1 ⇒ 正是本条守卫要防的"守卫自己失效" ✓）
		const rel = 'src/vs/sessions/contrib/agentStudio/common/skillRoots.ts';
		const abs = join(process.cwd(), rel);
		assert.ok(existsSync(abs), `读不到 ${rel}（cwd=${process.cwd()}）—— 守卫不能空跑`);
		const sup = readFileSync(abs, 'utf8');
		const projectAt = sup.indexOf("rel: '.dsh/skills'");
		const projectGenericAt = sup.indexOf("rel: '.agents/skills'");
		const userAt = sup.indexOf("{ base: 'dataRoot'");
		const officialUserAt = sup.indexOf("{ base: 'officialUser'");
		const builtinAt = sup.indexOf("{ base: 'builtin'");
		assert.ok(projectAt > 0 && projectGenericAt > 0 && userAt > 0 && officialUserAt > 0 && builtinAt > 0,
			'清单写法变了 ⇒ 同步改这条守卫（否则它会静默失效 ✗）');
		assert.ok(projectAt < projectGenericAt, '.dsh/skills 必须排在 .agents/skills 之前（官方 rank 100 先于 200 ✓）');
		assert.ok(projectGenericAt < userAt, '项目级必须在用户级之前（官方 100/200 先于 300/400 ✓）');
		assert.ok(userAt < officialUserAt, '自营用户库必须排在官方用户级之前（我们自己的库是产品默认面 ✓）');
		assert.ok(officialUserAt < builtinAt,
			'用户级（含官方的）必须排在**内置之前**：内置现在走 `bundledSkillDir`（rank 600 ✓）⇒ 用户/项目根'
			+ '（rank 300）天然赢 ✓；这条顺序仍要守，因为它是"内置永远最后"这条语义在真源里的唯一可见处 ✓'
			+ '（2026-10-13 P2 之前两者同档 300、纯靠数组顺序分先后 ✗）');
		// 顺序守住了但**没接线**也是白搭 ⇒ 同时钉住 dsh 侧真的在用这份真源 ✓
		const hostRel = 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts';
		const host = readFileSync(join(process.cwd(), hostRel), 'utf8');
		assert.match(host, /resolveSkillRoots\s*\(/, `${hostRel} 必须调用 resolveSkillRoots（否则顺序与它无关 ✗）`);
	});

	test('★ 命中的结构：输出带 skillDir，render 里把纪律写在脸上，且不碰 description', () => {
		assert.ok(src.length > 0, `读不到 ${REL}（cwd=${process.cwd()}）—— 守卫不能空跑`);
		assert.match(src, /skillDir: skillDirOf\(skill\.path\)/, '结果里必须带技能目录（推导见 store.js 的 skillDirOf ✓）');
		assert.match(src, /skillDir: \{ type: 'string' \}/, '输出 schema 要声明 skillDir');
		assert.match(src, /skillDir 的\*\*绝对路径\*\*调用/, 'render 必须提醒"用 skillDir 的绝对路径调用脚本"');
		assert.match(src, /进程 cwd 是会话工作区、不是技能目录/, '必须说清**为什么**（否则模型不会照做）');
		// 这条纪律不许挤进 description：工具快照抓的是 descriptionHash，动它就得重生成快照 ✗
		assert.doesNotMatch(src, /description: '[^']*skillDir/,
			'纪律写进 render/输出即可 —— description 进快照哈希，改它会把无关漂移混进来');
	});
});

suite('dshHarness / 技能根交付：内置单列 + 与插件 provider 的（有意）重叠', () => {

	/** 读仓库内源码（守卫不能空跑）。 */
	const readSrc = (rel: string): string => {
		const abs = join(process.cwd(), rel);
		assert.ok(existsSync(abs), `读不到 ${rel}（cwd=${process.cwd()}）`);
		const text = readFileSync(abs, 'utf8');
		assert.ok(text.length > 0, `${rel} 是空文件（守卫不能空跑）`);
		return text;
	};

	test('★ dsh 侧真接线：内置被摘出来交给 bundledSkillDir，且不再混进 skillDirs', () => {
		const host = readSrc('src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts');
		assert.match(host, /filter\(r => r\.scope !== 'builtin'\)/,
			'送进 `skillDirs` 的列表必须**去掉**内置（否则它仍在 300 ✗，等于没改）');
		assert.match(host, /find\(r => r\.scope === 'builtin'\)/,
			'内置必须被单独找出来交给 bundledSkillDir（找不到 ⇒ 内置技能整个不生效 ✗）');
		assert.match(host, /\.\.\.\(skills\.bundledDir \? \{ bundledSkillDir: skills\.bundledDir \} : \{\}\)/,
			'`_startOptions` 必须把 bundledDir 传出去（算出来不传 = 白改 ✗）');
		// 主进程那侧：也要过滤存在性并落进 hostConfig（渲染器不查盘 ✓）
		const sup = readSrc('src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts');
		assert.match(sup, /const bundledSkillDir = bundledDirRaw && existsSync\(bundledDirRaw\) \? bundledDirRaw : undefined;/,
			'主进程必须对 bundledSkillDir 做存在性过滤（否则会把不存在的目录写进覆盖层 ✗）');
		assert.match(sup, /\.\.\.\(bundledSkillDir \? \{ bundledSkillDir \} : \{\}\)/,
			'主进程必须把 bundledSkillDir 放进 hostConfig（漏了 ⇒ 覆盖层里没有内置，静默少技能 ✗）');
	});

	test('★ 与插件 provider 的重叠是**有意的**：两侧必须同源，且由覆盖层那行优先', () => {
		// 现场（`poc/dsh-p0/README.md` §5.87 已记）：`@vssaros/dsh-skills` 自己注册一个 provider 扫
		// `<数据根>/skills`（rank 600），我们的覆盖层行**也**扫同一个目录（rank 300）⇒ dsh 同层 first-wins
		// ⇒ 我们那行胜出，插件候选被丢并打一条 "ignored because a higher-priority skill already exists"。
		// 为什么现在不收口成一个：插件的 provider 是**独立 dsh 部署**（没有我们的覆盖层）时用户技能的唯一来源 ✗，
		// 且它带"指纹变了就 invalidate"的实时刷新 —— 收口要先给覆盖层那条路径配等价能力（独立议题 ✓）。
		// 本守卫的作用：任何一边换目录/换 rank，这里就红（否则重叠方向静默反转 ⇒ 用户库以副本为准 ✗）。
		assert.match(readSrc('dsh-plugins/vssaros-skills/lib/store.js'), /join\(dataRootOf\(config\), 'skills'\)/,
			'插件扫的必须是 `<数据根>/skills`（变了 ⇒ 与我们的覆盖层行不再同源 ✗）');
		assert.match(readSrc('dsh-plugins/vssaros-skills/lib/core/skills.js'), /VSAROS_SKILL_RANK = 600/,
			'插件 provider 的 rank 必须是 600；若与我们的 300 反过来，用户库就会被自家插件的副本顶掉 ✗');
		assert.match(readSrc('src/vs/sessions/contrib/agentStudio/common/skillRoots.ts'), /\{ base: 'dataRoot', rel: 'skills'/,
			'我们那行必须仍含 `<数据根>/skills`（去掉它 ⇒ 用户库只剩插件的 600，与内置同档 ✗）');
	});
});
