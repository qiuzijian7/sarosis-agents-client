/*---------------------------------------------------------------------------------------------
 *  从 Git 安装技能（common/skillGitInstall.ts）— 单测
 *
 *  覆盖：
 *  - parseGitSkillUrl：普通仓库地址 / .git 后缀 / GitHub 与 GitLab tree 子目录链接 /
 *    ssh 拒绝 / 非 URL 拒绝 / 非 http(s) 协议拒绝 / 缺仓库路径拒绝
 *  - selectSkillRootFromPaths：根目录优先 / 唯一嵌套目录 / 无 SKILL.md /
 *    多技能歧义（含子目录提示）/ 显式 subdir 命中与未命中
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	parseGitSkillUrl,
	selectSkillRootFromPaths,
} from '../../common/skillGitInstall.js';

suite('Skill — skillGitInstall', () => {

	suite('parseGitSkillUrl', () => {

		test('普通仓库地址补 .git 后缀', () => {
			const r = parseGitSkillUrl('https://github.com/owner/repo');
			assert.ok(r.ok);
			assert.strictEqual(r.value.cloneUrl, 'https://github.com/owner/repo.git');
			assert.strictEqual(r.value.subdir, undefined);
		});

		test('已有 .git 后缀不重复追加', () => {
			const r = parseGitSkillUrl('https://github.com/owner/repo.git');
			assert.ok(r.ok);
			assert.strictEqual(r.value.cloneUrl, 'https://github.com/owner/repo.git');
		});

		test('尾部斜杠与首尾空白归一化', () => {
			const r = parseGitSkillUrl('  https://github.com/owner/repo/  ');
			assert.ok(r.ok);
			assert.strictEqual(r.value.cloneUrl, 'https://github.com/owner/repo.git');
		});

		test('GitHub tree 子目录链接提取 subdir', () => {
			const r = parseGitSkillUrl('https://github.com/owner/repo/tree/main/skills/my-skill');
			assert.ok(r.ok);
			assert.strictEqual(r.value.cloneUrl, 'https://github.com/owner/repo.git');
			assert.strictEqual(r.value.subdir, 'skills/my-skill');
		});

		test('GitHub tree 链接无子目录时 subdir 为 undefined', () => {
			const r = parseGitSkillUrl('https://github.com/owner/repo/tree/main');
			assert.ok(r.ok);
			assert.strictEqual(r.value.cloneUrl, 'https://github.com/owner/repo.git');
			assert.strictEqual(r.value.subdir, undefined);
		});

		test('GitLab /-/tree 子目录链接提取 subdir', () => {
			const r = parseGitSkillUrl('https://gitlab.com/group/proj/-/tree/master/packs/skill-a');
			assert.ok(r.ok);
			assert.strictEqual(r.value.cloneUrl, 'https://gitlab.com/group/proj.git');
			assert.strictEqual(r.value.subdir, 'packs/skill-a');
		});

		test('http 协议允许（内网 git 服务）', () => {
			const r = parseGitSkillUrl('http://git.internal/team/skill-pack');
			assert.ok(r.ok);
			assert.strictEqual(r.value.cloneUrl, 'http://git.internal/team/skill-pack.git');
		});

		test('query/hash 被丢弃', () => {
			const r = parseGitSkillUrl('https://github.com/owner/repo?tab=readme#intro');
			assert.ok(r.ok);
			assert.strictEqual(r.value.cloneUrl, 'https://github.com/owner/repo.git');
		});

		test('拒绝 ssh 形式（git@host:...）', () => {
			const r = parseGitSkillUrl('git@github.com:owner/repo.git');
			assert.ok(!r.ok);
			assert.match(r.error, /ssh/i);
		});

		test('拒绝 ssh:// 协议', () => {
			const r = parseGitSkillUrl('ssh://git@github.com/owner/repo.git');
			assert.ok(!r.ok);
		});

		test('拒绝非 URL 输入与空输入', () => {
			assert.ok(!parseGitSkillUrl('not-a-url').ok);
			assert.ok(!parseGitSkillUrl('   ').ok);
		});

		test('拒绝缺少仓库路径的 URL', () => {
			const r = parseGitSkillUrl('https://github.com/onlyowner');
			assert.ok(!r.ok);
			assert.match(r.error, /仓库路径/);
		});
	});

	suite('selectSkillRootFromPaths', () => {

		test('根目录 SKILL.md 优先', () => {
			const r = selectSkillRootFromPaths(['SKILL.md', 'skills/a/SKILL.md']);
			assert.ok(r.ok);
			assert.strictEqual(r.dir, '.');
		});

		test('唯一嵌套目录自动选用', () => {
			const r = selectSkillRootFromPaths(['packs/my-skill/SKILL.md']);
			assert.ok(r.ok);
			assert.strictEqual(r.dir, 'packs/my-skill');
		});

		test('无 SKILL.md 报错', () => {
			const r = selectSkillRootFromPaths([]);
			assert.ok(!r.ok);
			assert.match(r.error, /没有.*SKILL\.md/);
		});

		test('多个技能目录报歧义并给出子目录链接提示', () => {
			const r = selectSkillRootFromPaths(['a/SKILL.md', 'b/SKILL.md', 'c/SKILL.md']);
			assert.ok(!r.ok);
			assert.match(r.error, /多个技能/);
			assert.match(r.error, /"a"/);
		});

		test('skill.md 大小写不敏感', () => {
			const r = selectSkillRootFromPaths(['Skill.MD']);
			assert.ok(r.ok);
			assert.strictEqual(r.dir, '.');
		});

		test('显式 subdir 命中', () => {
			const r = selectSkillRootFromPaths(['skills/a/SKILL.md', 'skills/b/SKILL.md'], 'skills/b');
			assert.ok(r.ok);
			assert.strictEqual(r.dir, 'skills/b');
		});

		test('显式 subdir 未命中报错', () => {
			const r = selectSkillRootFromPaths(['skills/a/SKILL.md'], 'skills/zzz');
			assert.ok(!r.ok);
			assert.match(r.error, /skills\/zzz/);
		});
	});
});
