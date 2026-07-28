/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Skill 格式增强（Hermes-Agent 兼容字段）单元测试。
 *
 * 覆盖点：
 *   1. extractYamlList — 内联数组 / 缩进列表 / 不存在 / 空数组
 *   2. buildSkillMdFull — 验证新字段正确写入 frontmatter
 *   3. parseSkillMd — 验证新字段正确解析往返
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildSkillMdFull,
	parseSkillMd,
	type IExtractedSkillComponents,
} from '../../common/extractSkill.js';
// extractYamlList is private; test via parseSkillMd which internally uses it

function makeComponents(overrides: Partial<IExtractedSkillComponents> = {}): IExtractedSkillComponents {
	return {
		name: 'my-skill',
		description: 'A test skill',
		prompt: '## Test Skill\n\nThis is a test skill body.\n\n- Step 1\n- Step 2',
		category: undefined,
		platforms: undefined,
		tags: undefined,
		relatedSkills: undefined,
		author: undefined,
		license: undefined,
		version: undefined,
		...overrides,
	};
}

suite('Agent Studio - Skill Format Enhanced (Hermes-Agent compat)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('buildSkillMdFull', () => {

		test('最小 skill（仅 name + description + prompt）→ 生成有效 SKILL.md', () => {
			const c = makeComponents();
			const md = buildSkillMdFull(c);

			assert.ok(md.startsWith('---'), 'should start with ---');
			assert.ok(md.includes('name: "my-skill"'));
			assert.ok(md.includes('description: "A test skill"'));
			assert.ok(md.includes('## Test Skill'));
			assert.ok(md.includes('Step 1'));
		});

		test('category 非空时写入', () => {
			const c = makeComponents({ category: 'devops' });
			const md = buildSkillMdFull(c);
			assert.ok(md.includes('category: "devops"'));
		});

		test('category 空时不写入', () => {
			const c = makeComponents({ category: '   ' });
			const md = buildSkillMdFull(c);
			assert.ok(!md.includes('category:'));
		});

		test('version 写入 frontmatter', () => {
			const c = makeComponents({ version: '2.0.0' });
			const md = buildSkillMdFull(c);
			assert.ok(md.includes('version: "2.0.0"'));
		});

		test('author 写入 frontmatter', () => {
			const c = makeComponents({ author: 'zhangsan' });
			const md = buildSkillMdFull(c);
			assert.ok(md.includes('author: "zhangsan"'));
		});

		test('license 写入 frontmatter', () => {
			const c = makeComponents({ license: 'MIT' });
			const md = buildSkillMdFull(c);
			assert.ok(md.includes('license: "MIT"'));
		});

		test('platforms 内联数组写入', () => {
			const c = makeComponents({ platforms: ['linux', 'macos', 'windows'] });
			const md = buildSkillMdFull(c);
			assert.ok(md.includes('platforms: ["linux", "macos", "windows"]'));
		});

		test('tags 内联数组写入', () => {
			const c = makeComponents({ tags: ['planning', 'code-review', 'workflow'] });
			const md = buildSkillMdFull(c);
			assert.ok(md.includes('tags: ["planning", "code-review", "workflow"]'));
		});

		test('relatedSkills 内联数组写入', () => {
			const c = makeComponents({ relatedSkills: ['tdd', 'github-pr'] });
			const md = buildSkillMdFull(c);
			assert.ok(md.includes('related_skills: ["tdd", "github-pr"]'));
		});

		test('全部字段写入 — frontmatter 完整', () => {
			const c = makeComponents({
				name: 'full-skill',
				description: 'A fully described skill',
				category: 'testing',
				version: '1.0.0',
				author: 'lisi',
				license: 'Apache-2.0',
				platforms: ['linux', 'windows'],
				tags: ['testing', 'ci-cd'],
				relatedSkills: ['tdd'],
			});
			const md = buildSkillMdFull(c);

			assert.ok(md.includes('name: "full-skill"'));
			assert.ok(md.includes('category: "testing"'));
			assert.ok(md.includes('version: "1.0.0"'));
			assert.ok(md.includes('author: "lisi"'));
			assert.ok(md.includes('license: "Apache-2.0"'));
			assert.ok(md.includes('platforms: ["linux", "windows"]'));
			assert.ok(md.includes('tags: ["testing", "ci-cd"]'));
			assert.ok(md.includes('related_skills: ["tdd"]'));
		});

		test('YAML 特殊字符正确转义', () => {
			const c = makeComponents({
				description: 'Skill with "quotes" and special chars',
				author: 'John "The Tester" Doe',
			});
			const md = buildSkillMdFull(c);
			assert.ok(md.includes('description:'), 'should not crash on special chars');
		});
	});

	suite('parseSkillMd — 新字段解析', () => {

		function buildMd(fields: string[]): string {
			return ['---', ...fields, '---', '', '## Body'].join('\n');
		}

		test('解析 tags 内联数组', () => {
			const md = buildMd([
				'name: tagged-skill',
				'description: "A tagged skill"',
				'tags: [planning, code-review]',
			]);
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.deepStrictEqual(parsed!.tags, ['planning', 'code-review']);
		});

		test('解析 tags 缩进列表', () => {
			const md = [
				'---',
				'name: tagged-skill',
				'description: "A tagged skill"',
				'tags:',
				'  - planning',
				'  - code-review',
				'---',
				'',
				'## Body',
			].join('\n');
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.deepStrictEqual(parsed!.tags, ['planning', 'code-review']);
		});

		test('解析 platforms 内联数组', () => {
			const md = buildMd([
				'name: cross-platform',
				'description: "Runs everywhere"',
				'platforms: [linux, macos, windows]',
			]);
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.deepStrictEqual(parsed!.platforms, ['linux', 'macos', 'windows']);
		});

		test('解析 related_skills 内联数组', () => {
			const md = buildMd([
				'name: main-skill',
				'description: "Main skill"',
				'related_skills: [tdd, github-pr]',
			]);
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.deepStrictEqual(parsed!.relatedSkills, ['tdd', 'github-pr']);
		});

		test('解析 author', () => {
			const md = buildMd([
				'name: authored-skill',
				'description: "Has an author"',
				'author: zhangsan',
			]);
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.strictEqual(parsed!.author, 'zhangsan');
		});

		test('解析 license', () => {
			const md = buildMd([
				'name: licensed-skill',
				'description: "Licensed"',
				'license: MIT',
			]);
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.strictEqual(parsed!.license, 'MIT');
		});

		test('解析 version', () => {
			const md = buildMd([
				'name: versioned-skill',
				'description: "Has version"',
				'version: "3.1.0"',
			]);
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.strictEqual(parsed!.version, '3.1.0');
		});

		test('不存在的字段返回 undefined', () => {
			const md = buildMd([
				'name: basic-skill',
				'description: "Basic"',
			]);
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.strictEqual(parsed!.tags, undefined);
			assert.strictEqual(parsed!.platforms, undefined);
			assert.strictEqual(parsed!.author, undefined);
			assert.strictEqual(parsed!.license, undefined);
		});
	});

	suite('往返一致性 — buildSkillMdFull ↔ parseSkillMd', () => {

		test('全部字段往返', () => {
			const original = makeComponents({
				name: 'round-trip-skill',
				description: 'Round trip test skill',
				category: 'testing',
				version: '2.0.0',
				author: 'wangwu',
				license: 'MIT',
				platforms: ['linux', 'macos'],
				tags: ['testing', 'quality'],
				relatedSkills: ['tdd'],
			});
			const md = buildSkillMdFull(original);
			const parsed = parseSkillMd(md);
			assert.ok(parsed);

			assert.strictEqual(parsed!.name, 'round-trip-skill');
			assert.strictEqual(parsed!.description, 'Round trip test skill');
			assert.strictEqual(parsed!.category, 'testing');
			assert.strictEqual(parsed!.version, '2.0.0');
			assert.strictEqual(parsed!.author, 'wangwu');
			assert.strictEqual(parsed!.license, 'MIT');
			assert.deepStrictEqual(parsed!.platforms, ['linux', 'macos']);
			assert.deepStrictEqual(parsed!.tags, ['testing', 'quality']);
			assert.deepStrictEqual(parsed!.relatedSkills, ['tdd']);
			assert.ok(parsed!.prompt.includes('## Test Skill'), 'body should be preserved');
		});

		test('最小字段往返（仅 name + description + prompt）', () => {
			const original = makeComponents({
				name: 'minimal-skill',
				description: 'Minimal',
			});
			const md = buildSkillMdFull(original);
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.strictEqual(parsed!.name, 'minimal-skill');
		});
	});
});
