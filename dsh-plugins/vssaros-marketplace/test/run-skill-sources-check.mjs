/*
 * 守卫 + 单测：技能安装的**4 类非商城来源**（内容 / 文件夹 / URL / GitHub）。
 *
 * 为什么必须有：这四条旁路原先都在 IDE 侧 `SkillInstallService`，迁到 dsh 侧后
 * 收敛成一个 op + 一个纯函数模块。任何一条校验被放松，症状都是"装好了却看不见"
 * 或"把包外路径写进数据根" —— 两者都不会当场报错 ✗。
 *
 * 跑法：node dsh-plugins/vssaros-marketplace/test/run-skill-sources-check.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	ALLOWED_SKILL_URL_HOSTS,
	MAX_SKILL_SOURCE_BYTES,
	SKILL_HUBS,
	SKILL_NAME,
	assertSafeSkillPath,
	hubTreeToEntries,
	normalizeSkillFiles,
	parseSkillFrontmatter,
	parseSkillSource,
} from '../lib/skillSources.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

let pass = 0;
let fail = 0;
const ck = (name, fn) => {
	try { fn(); pass += 1; console.log('  ok   ' + name); }
	catch (e) { fail += 1; console.error(`  FAIL ${name} — ${e?.message ?? e}`); }
};
const throws = (fn, why) => assert.throws(fn, undefined, why);

const VALID = '---\nname: my-skill\ndescription: 做某件事\n---\n\n正文\n';

console.log('★ 技能安装来源（content / folder / url / github）单测\n');

// ── ① Hub 清单迁移完整性 ───────────────────────────────────────────
ck('Hub 共 4 个且 id 唯一', () => {
	assert.equal(SKILL_HUBS.length, 4);
	assert.equal(new Set(SKILL_HUBS.map(h => h.id)).size, 4);
});
// ★ P3（2026-11-07）：过渡期这里做的是「dsh 侧 SKILL_HUBS ↔ IDE 侧 BUILTIN_SKILL_HUBS」双跑对账。
//   IDE 侧 Hub 定义与技能安装服务已整体删除 ⇒ 对账对象不存在，改成钉住 dsh 侧这份**唯一真源**
//   （固定 4 条 + repo/branch 形状 + IDE 文件不许重建），等价覆盖不丢。
ck('★ P3：Hub 清单是 dsh 侧唯一真源（IDE 侧定义已删除）', () => {
	assert.deepEqual(SKILL_HUBS.map(h => h.id),
		['anthropic-skills', 'hermes-skills', 'awesome-copilot', 'prompt-skills']);
	for (const hub of SKILL_HUBS) {
		assert.match(hub.repo, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, `repo 格式不对：${hub.repo}`);
		assert.ok(hub.branch, `Hub ${hub.id} 缺 branch`);
	}
	assert.ok(!existsSync(join(REPO, 'src/vs/sessions/contrib/agentStudio/common/skillHubTypes.ts')),
		'IDE 侧 Hub 定义文件仍在 ⇒ 又变成两份真源 ✗');
});

// ── ② frontmatter 规则（与 DSH 加载器同源） ───────────────────────
ck('合法 frontmatter ⇒ name / description', () => {
	assert.deepEqual(parseSkillFrontmatter(VALID), { name: 'my-skill', description: '做某件事' });
});
ck('CRLF 文件也能解析', () => {
	assert.equal(parseSkillFrontmatter(VALID.replace(/\n/g, '\r\n')).name, 'my-skill');
});
ck('带引号的 description 能解析', () => {
	assert.equal(parseSkillFrontmatter('---\nname: a\ndescription: "含: 冒号"\n---\n正文').description, '含: 冒号');
});
for (const [name, text] of [
	['缺 --- 开头', 'name: a\n---\n'],
	['没有收尾 ---', '---\nname: a\ndescription: b\n正文'],
	['缺 name', '---\ndescription: b\n---\n正文'],
	['缺 description', '---\nname: a\n---\n正文'],
	['name 是显示名', '---\nname: Code Review\ndescription: b\n---\n正文'],
	['BOM', '\uFEFF---\nname: a\ndescription: b\n---\n正文'],
]) {
	ck(`坏 frontmatter 被拒：${name}`, () => throws(() => parseSkillFrontmatter(text)));
}

// ── ③ 包内路径围栏 ────────────────────────────────────────────────
ck('合法相对路径（含 Windows 分隔符）', () => {
	assert.equal(assertSafeSkillPath('scripts\\run.py'), 'scripts/run.py');
	assert.equal(assertSafeSkillPath('references/a.md'), 'references/a.md');
});
for (const bad of ['../evil.md', 'a/../../evil.md', '/abs/x', 'C:\\x', 'a/..', '', 'a\u0000b']) {
	ck(`路径围栏拒绝 ${JSON.stringify(bad)}`, () => throws(() => assertSafeSkillPath(bad)));
}

// ── ④ 来源分类 ────────────────────────────────────────────────────
ck('content（缺省）/ folder / url / github 四类都能分类', () => {
	assert.equal(parseSkillSource({ content: VALID }).type, 'content');
	assert.equal(parseSkillSource({ source: 'folder', files: [] }).type, 'folder');
	assert.equal(parseSkillSource({ source: 'url', url: 'https://raw.githubusercontent.com/x/y/main/SKILL.md' }).type, 'url');
	assert.deepEqual(parseSkillSource({ source: 'github', repo: 'owner/repo' }), { type: 'github', ref: 'owner/repo' });
});
ck('不认识的 source 明确报错', () => throws(() => parseSkillSource({ source: 'zip' })));
ck('URL 域名白名单只放行 GitHub（防 SSRF）', () => {
	assert.ok(ALLOWED_SKILL_URL_HOSTS.has('raw.githubusercontent.com'));
	assert.ok(!ALLOWED_SKILL_URL_HOSTS.has('127.0.0.1'));
	assert.ok(!ALLOWED_SKILL_URL_HOSTS.has('evil.example.com'));
});

// ── ⑤ 规范化为 installBundle 的 files[] ───────────────────────────
ck('content ⇒ 单份 SKILL.md，storeId 取自 frontmatter', () => {
	const r = normalizeSkillFiles({ content: VALID });
	assert.equal(r.storeId, 'my-skill');
	assert.equal(r.files.length, 1);
	assert.equal(r.files[0].path, 'SKILL.md');
	assert.ok(Buffer.isBuffer(r.files[0].data));
});
ck('folder ⇒ 保留支持目录，SKILL.md 必须在顶层', () => {
	const r = normalizeSkillFiles({ files: [
		{ path: 'SKILL.md', data: VALID },
		{ path: 'scripts/run.py', data: 'print(1)' },
		{ path: 'references/a.md', data: 'x' },
	] });
	assert.equal(r.storeId, 'my-skill');
	assert.equal(r.files.length, 3);
});
ck('name 与 frontmatter 不一致 ⇒ 拒绝（dsh 用目录名定位）', () => {
	throws(() => normalizeSkillFiles({ content: VALID, name: 'another-name' }));
});
ck('name 显式给且一致 ⇒ 通过', () => {
	assert.equal(normalizeSkillFiles({ content: VALID, name: 'my-skill' }).storeId, 'my-skill');
});
ck('folder 缺 SKILL.md ⇒ 拒绝', () => {
	throws(() => normalizeSkillFiles({ files: [{ path: 'README.md', data: 'x' }] }));
});
ck('folder 路径穿越 ⇒ 拒绝', () => {
	throws(() => normalizeSkillFiles({ files: [{ path: 'SKILL.md', data: VALID }, { path: '../evil', data: 'x' }] }));
});
ck('空内容 ⇒ 拒绝', () => throws(() => normalizeSkillFiles({ content: '' })));
ck('总体积超上限 ⇒ 拒绝', () => {
	throws(() => normalizeSkillFiles({ content: VALID, files: [
		{ path: 'SKILL.md', data: VALID },
		{ path: 'big.bin', data: Buffer.alloc(MAX_SKILL_SOURCE_BYTES) },
	] }));
});
ck('SKILL_NAME 规则与 dsh 一致', () => {
	assert.ok(SKILL_NAME.test('code-review'));
	assert.ok(!SKILL_NAME.test('Code Review'));
});

// ── ⑥ Hub tree → 条目 ─────────────────────────────────────────────
ck('Hub tree 只收 skillsPath 下的顶层技能', () => {
	const tree = { tree: [
		{ path: 'README.md' },
		{ path: 'skills/code-review/SKILL.md' },
		{ path: 'skills/code-review/references/a.md' },
		{ path: 'skills/nested/inner/deep/SKILL.md' },
		{ path: 'other/SKILL.md' },
	] };
	const items = hubTreeToEntries(tree, 'hermes-skills');
	assert.equal(items.length, 1);
	assert.equal(items[0].id, 'code-review');
	assert.equal(items[0].rawUrl, 'https://raw.githubusercontent.com/nicobailey/hermes/main/skills/code-review/SKILL.md');
});
ck('无 skillsPath 的 Hub 收仓库顶层技能', () => {
	const items = hubTreeToEntries({ tree: [{ path: 'pdf/SKILL.md' }, { path: 'a/b/SKILL.md' }] }, 'anthropic-skills');
	assert.equal(items.length, 1);
	assert.equal(items[0].id, 'pdf');
});
ck('不认识的 Hub ⇒ 明确报错', () => throws(() => hubTreeToEntries({ tree: [] }, 'nope')));

// ── ⑦ 接线守卫：不许"模块还在、接线被删" ─────────────────────────
{
	const idx = readFileSync(join(REPO, 'dsh-plugins', 'vssaros-marketplace', 'lib', 'index.js'), 'utf8');
	const pkg = JSON.parse(readFileSync(join(REPO, 'dsh-plugins', 'vssaros-marketplace', 'package.json'), 'utf8'));
	ck('index.js 有 installSkillContent 分支', () => assert.ok(idx.includes("if (op === 'installSkillContent')")));
	ck('4 类来源都接了线', () => {
		assert.ok(idx.includes('parseSkillSource(params)'));
		assert.ok(idx.includes("source.type === 'github'"));
		assert.ok(idx.includes("source.type === 'url'"));
		assert.ok(idx.includes('normalizeSkillFiles('));
	});
	ck('规范化后的 files 交给同一个 installBundle', () => assert.ok(idx.includes('files: bundleFiles')));
	ck('新模块在 files 白名单里（否则装上缺文件）', () => assert.ok(pkg.files.includes('lib/skillSources.js')));
	ck('Hub 列表 op 已在分派表与执行端接线', () => {
		const d = readFileSync(join(REPO, 'dsh-plugins', 'vssaros-marketplace', 'lib', 'dispatch.js'), 'utf8');
		assert.ok(d.includes("'listSkillHub'"));
		assert.ok(idx.includes("if (op === 'listSkillHub')"));
		assert.ok(idx.includes('hubTreeToEntries(tree, hubId)'));
	});
	ck('Hub repo 都是 owner/repo 且 branch 非空', () => {
		for (const h of SKILL_HUBS) {
			assert.match(h.repo, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
			assert.ok(h.branch);
		}
	});
}

console.log(`\n[skill sources] ${pass} passing / ${fail} failing`);
process.exit(fail ? 1 : 0);
