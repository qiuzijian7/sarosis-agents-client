/*
 * 守卫：dsh 侧创建技能的 SKILL.md 生成器 + 页面 API 接线。
 *
 * 为什么必须有：生成侧一旦写出「description 没加引号又含冒号+空格」的 frontmatter，
 * DSH 会**静默丢弃**这个技能（2026-11-06 真机 173 个里有 45 个就是这样）。
 * 另外「create 只写草稿 / promote 才生效」是提示词注入面的安全边界，接线被删了没人知道。
 *
 * 跑法：node dsh-plugins/vssaros-skills/test/run-skill-distill-check.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_DESCRIPTION_CHARS, buildSkillMd } from '../lib/core/skillDistill.js';
import { assertSkillContent } from '../lib/core/skillManage.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');

let pass = 0;
let fail = 0;
const ck = (name, fn) => {
	try { fn(); pass += 1; console.log('  ok   ' + name); }
	catch (e) { fail += 1; console.error(`  FAIL ${name} — ${e?.message ?? e}`); }
};
const throws = (fn) => assert.throws(fn);

console.log('★ 创建技能：SKILL.md 生成器与页面 API 守卫\n');

ck('合法输入 ⇒ 完整 frontmatter + 正文', () => {
	const md = buildSkillMd({ name: 'code-review', description: '评审改动', body: '先读 diff。' });
	assert.ok(md.startsWith('---\n'));
	assert.match(md, /^name: code-review$/m);
	assert.match(md, /^description: "评审改动"$/m);
	assert.match(md, /^activation: manual$/m);
	assert.ok(md.includes('先读 diff。'));
	assert.doesNotThrow(() => assertSkillContent(md));
});

ck('★ description 含「冒号+空格」必须被引起来（否则 DSH 静默丢弃）', () => {
	const md = buildSkillMd({ name: 'a', description: '规则: 先跑测试', body: '正文' });
	assert.match(md, /^description: "规则: 先跑测试"$/m);
	assert.doesNotThrow(() => assertSkillContent(md));
});

ck('description 里的双引号被转义', () => {
	const md = buildSkillMd({ name: 'a', description: '用 "引号" 包住', body: '正文' });
	assert.match(md, /\\"引号\\"/);
});

for (const [name, input] of [
	['name 为空', { name: '', description: 'x' }],
	['name 是显示名', { name: 'Code Review', description: 'x' }],
	['name 含路径分隔符', { name: '../evil', description: 'x' }],
	['缺 description', { name: 'a' }],
	['description 全空白', { name: 'a', description: '   ' }],
	['description 超长', { name: 'a', description: 'x'.repeat(MAX_DESCRIPTION_CHARS + 1) }],
	['category 不合法', { name: 'a', description: 'x', category: 'a: b' }],
]) {
	ck(`坏输入被拒：${name}`, () => throws(() => buildSkillMd(input)));
}

ck('缺省正文给出占位指引（不生成空技能）', () => {
	const md = buildSkillMd({ name: 'a', description: 'x' });
	assert.match(md, /请在这里写下 a 的使用指引/);
});

ck('category / tags 按合法 YAML 写出', () => {
	const md = buildSkillMd({ name: 'a', description: 'x', category: 'devops', tags: ['git', 'ci'] });
	assert.match(md, /^category: "devops"$/m);
	assert.match(md, /^tags: \["git", "ci"\]$/m);
	assert.doesNotThrow(() => assertSkillContent(md));
});

// ── 接线守卫：不许「模块还在、API 没了」 ────────────────────────────
{
	const idx = readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8');
	const pkg = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
	ck('新模块在 files 白名单里（否则装上缺文件 ⇒ 页面白屏）',
		() => assert.ok(pkg.files.includes('lib/core/skillDistill.js')));
	ck('index.js 引入了生成器', () => assert.ok(idx.includes("from './core/skillDistill.js'")));
	ck('页面 API 两条都在（manage / drafts）', () => {
		assert.ok(idx.includes("`${ROUTE_PREFIX}/api/manage`"));
		assert.ok(idx.includes("`${ROUTE_PREFIX}/api/drafts`"));
	});
	ck('manage 只放行 create / promote（不开放 edit/delete 给页面）', () => {
		assert.ok(idx.includes("action !== 'create' && action !== 'promote'"));
	});
	ck('写后主动让技能目录重建', () => assert.ok(idx.includes('state.providerControl?.invalidate()')));
	ck('页面有创建卡与草稿容器', () => {
		assert.ok(idx.includes('data-sk-create-name'));
		assert.ok(idx.includes('data-sk-create-save'));
		assert.ok(idx.includes('data-sk-drafts'));
	});
	ck('页面按钮直连 dsh API（不依赖模型调工具）', () => {
		assert.ok(idx.includes("'/x/skills/api/manage'"));
		assert.ok(idx.includes("'/x/skills/api/drafts'"));
	});
	ck('★ 插件入口语法可编译（页面模板字符串没有被提前闭合）', () => {
		assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', join(PLUGIN, 'lib', 'index.js')], { stdio: 'pipe' }));
	});
	ck('新增 CSS 没有裸色值（浅/深色跟随 IDE 外观）', () => {
		const from = idx.indexOf('.sk-create {');
		const css = from > 0 ? idx.slice(from, idx.indexOf('</style>', from)) : '';
		assert.ok(css.length > 0, '找不到新建技能的 CSS 块');
		// 只看真正写了颜色的行：字号/间距这些行本来就不该有 var(--)。
		const bad = css.split('\n').filter(l => /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(l) && !l.includes('var(--'));
		assert.deepEqual(bad, [], '有裸色值：' + bad.join(' | '));
	});
}

console.log(`\n[skill distill] ${pass} passing / ${fail} failing`);
process.exit(fail ? 1 : 0);
