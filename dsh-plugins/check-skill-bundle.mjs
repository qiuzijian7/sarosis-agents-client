/*
 * 守卫：随包技能真源必须在 **dsh 侧**（P0，2026-11-06）。
 *
 * 目标态：`dsh-plugins/vssaros-skill-bundle/skills/` 是唯一随包技能根，由插件自己的
 * `cordis.patch.yml` 挂成官方 `bundledSkillDir`（rank 600）；IDE 侧 `resources/.agents/skills`
 * 在 P3 删除。过渡期旧根仍在（工作区有并发未提交改动），因此这里：
 *   · 硬判据全部只针对新根（存在 / 顶层 / frontmatter / 工具名 / 插件声明 / 守卫链）；
 *   · 旧根只做「迁移完整性 + 内容分叉」对照，分叉只报告不判失败（避免干扰并发会话）。
 *
 * 判据刻意可反向突变：造一个嵌套技能容器、删一个 SKILL.md、把 frontmatter 写坏、
 * 去掉 files 里的 skills、把链脚本改回旧根 —— 都应立刻红。
 *
 * 跑法：node dsh-plugins/check-skill-bundle.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
	BUNDLE_PLUGIN_DIR,
	BUNDLED_SKILL_ROOT,
	LEGACY_BUNDLED_SKILL_ROOT,
	REPO_ROOT,
} from './scripts/skill-bundle-paths.mjs';
import { loadDshYaml, skillProblems } from './check-skill-frontmatter.mjs';
import { dshToolNames, scanToolRefs } from './scripts/skill-tool-map.mjs';

let failed = 0;
const fail = (msg) => { failed += 1; console.error(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✔ ${msg}`);

const topLevel = (root) => existsSync(root)
	? readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
	: [];

const pkgPath = join(BUNDLE_PLUGIN_DIR, 'package.json');
const patchPath = join(BUNDLE_PLUGIN_DIR, 'cordis.patch.yml');

console.log('★ 随包技能真源（dsh 侧 bundle）守卫\n');

// ── 1 新根存在 + 顶层可读（假绿防线） ────────────────────────────────
const names = topLevel(BUNDLED_SKILL_ROOT);
if (!existsSync(BUNDLED_SKILL_ROOT)) {
	fail(`新根不存在：${BUNDLED_SKILL_ROOT}`);
} else if (names.length === 0) {
	fail('新根一个技能都没扫到（路径或判据失效 ⇒ 守卫永远绿比没有更坏）');
} else {
	ok(`新根 ${names.length} 个顶层技能`);
	const noMd = names.filter(n => !existsSync(join(BUNDLED_SKILL_ROOT, n, 'SKILL.md')));
	if (noMd.length) {
		fail(`顶层缺 SKILL.md（dsh provider 是单层 readdir，容器目录里的技能会凭空消失）：${noMd.slice(0, 5).join('、')}`);
	} else {
		ok('每个顶层目录都有 SKILL.md（无嵌套容器）');
	}
}

// ── 2 frontmatter 能被 DSH 加载 ──────────────────────────────────────
const loaded = loadDshYaml(REPO_ROOT);
if (!loaded) {
	console.log('  --   没有 dsh-runtime/*/node_modules/yaml ⇒ 跳过 YAML 解析（干净检出时正常）');
}
const fmBad = [];
for (const name of names) {
	const file = join(BUNDLED_SKILL_ROOT, name, 'SKILL.md');
	if (!existsSync(file)) { continue; }
	const problems = skillProblems(readFileSync(file, 'utf8'), name, loaded?.yaml.parse);
	if (problems.length) { fmBad.push(`${name}：${problems.join('；')}`); }
}
if (fmBad.length) {
	fail(`${fmBad.length} 个技能的 frontmatter DSH 加载不了：\n      ${fmBad.slice(0, 6).join('\n      ')}`);
} else {
	ok(`frontmatter 全部可被 DSH 加载${loaded ? `（yaml ${loaded.version}）` : ''}`);
}

// ── 3 P3：IDE 侧旧根必须已删除（500 个文件逐字节迁到新根后不再保留第二份） ──
//   过渡期这里做的是「迁移完整性 + 内容分叉」对照；P3 完成后改为硬判，
//   防有人把旧目录重建出来 ⇒ 又变成两份真源、并发改动静默分叉 ✗。
if (existsSync(LEGACY_BUNDLED_SKILL_ROOT)) {
	fail('IDE 侧旧技能根仍在 ⇒ P3 未完成（内容已在新根，别再往旧路径写）');
	const legacyNames = topLevel(LEGACY_BUNDLED_SKILL_ROOT);
	const lost = legacyNames.filter(n => !names.includes(n));
	if (lost.length) { fail(`旧根有 ${lost.length} 个技能没迁过来：${lost.slice(0, 6).join('、')}`); }
} else {
	ok('P3：IDE 侧旧技能根已删除，dsh 侧新根是唯一真源');
}

// ── 4 技能正文引用的工具名真实存在 ───────────────────────────────────
const tools = dshToolNames();
const dangling = [];
for (const name of names) {
	const file = join(BUNDLED_SKILL_ROOT, name, 'SKILL.md');
	if (!existsSync(file)) { continue; }
	const { dangling: bad } = scanToolRefs(readFileSync(file, 'utf8'), tools);
	if (bad.length) { dangling.push(`${name}: ${bad.join('、')}`); }
}
if (dangling.length) {
	fail(`技能正文引用了不存在的工具：${dangling.slice(0, 5).join('；')}`);
} else {
	ok(`技能正文的工具名全部有效（dsh 工具清单 ${tools.size} 个）`);
}

// ── 5 插件声明：数据进包 + 自带 bundled 挂载 ────────────────────────
let pkg = {};
try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { /* 下面报 */ }
if (!Array.isArray(pkg.files) || !pkg.files.includes('skills')) {
	fail('package.json 的 files 白名单没列 skills ⇒ 按 files 安装时技能整棵不进副本');
} else {
	ok('files 白名单包含 skills');
}
if (!pkg.dsh?.bundle?.patch) {
	fail('package.json 缺 dsh.bundle.patch ⇒ Host 不会加载 bundledSkillDir 挂载');
} else {
	ok('dsh.bundle.patch 已声明');
}
let patch = '';
try { patch = readFileSync(patchPath, 'utf8'); } catch { /* 下面报 */ }
for (const needle of ['bundledSkillDir', 'vssaros-skill-bundle', 'providerName']) {
	if (!patch.includes(needle)) { fail(`cordis.patch.yml 缺 ${needle}`); }
}
if (patch.includes('bundledSkillDir') && patch.includes('vssaros-skill-bundle') && patch.includes('providerName')) {
	ok('cordis.patch.yml 自带独立 providerName 的 bundledSkillDir 行');
}

// ── 6 守卫链不许再引用旧根里的脚本（P3 删目录会断链） ──────────────
const chain = String(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts?.['check:dsh-plugins'] ?? '');
if (/resources\/\.agents\/skills\//.test(chain)) {
	fail('check:dsh-plugins 链仍引用已删除的 IDE 旧技能根下的脚本 ⇒ 守卫链会静默断掉');
} else {
	ok('守卫链已不引用旧根脚本');
}

// ── 7 P2 对照：创建链 / 安装链 / 技能 provider 必须落在同一个根 ────
{
	const installers = readFileSync(join(REPO_ROOT, 'dsh-plugins', 'vssaros-marketplace', 'lib', 'installers.js'), 'utf8');
	const store = readFileSync(join(REPO_ROOT, 'dsh-plugins', 'vssaros-skills', 'lib', 'store.js'), 'utf8');
	const dispatch = readFileSync(join(REPO_ROOT, 'dsh-plugins', 'vssaros-marketplace', 'lib', 'dispatch.js'), 'utf8');
	if (!/if \(kind === 'skill'\) \{ return join\(dataRoot, 'skills'\); \}/.test(installers)) {
		fail('安装链的 skill 落点不再是 <数据根>/skills ⇒ 与技能 provider 扫描根分叉');
	} else if (!/join\(dataRootOf\(config\), 'skills'\)/.test(store)) {
		fail('技能 provider 不再扫 <数据根>/skills ⇒ 装完的技能模型看不见');
	} else {
		ok('P2：安装链落点与技能 provider 扫描根同为 <数据根>/skills');
	}
	if (!dispatch.includes("'installSkillContent'")) {
		fail('非商城来源安装 op 从分派表消失 ⇒ 创建/下载链又只剩商城一条路');
	} else {
		ok('P2：4 类非商城来源统一走 installSkillContent');
	}
	if (!dispatch.includes("'listSkillHub'")) {
		fail('Hub 列表 op 从分派表消失 ⇒ 非商城浏览入口又回到 IDE 侧');
	} else {
		ok('P2：4 个内置 Hub 由 dsh 侧 listSkillHub 自持');
	}
}

console.log(failed ? `\n✗ ${failed} 项不通过` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
