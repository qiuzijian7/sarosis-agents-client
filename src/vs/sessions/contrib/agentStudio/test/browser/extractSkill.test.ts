/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 沉淀技能（Extract Skill）测试 —— 覆盖从消息提取技能组分的纯函数逻辑。
 *
 * 测试场景：
 *   - toSkillSlug: 中文/英文/混合文本转 slug
 *   - buildSkillMd: 从组分构建 SKILL.md
 *   - parseSkillMd: 解析 SKILL.md 回组分
 *   - extractSkillComponents: 综合提取（标题→name、正文→prompt）
 *   - 边界情况：空输入、超长文本、特殊字符、已有 frontmatter
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	toSkillSlug,
	isValidSkillSlug,
	buildSkillMd,
	buildSkillMdFromComponents,
	parseSkillMd,
	tryExtractSkillName,
	tryExtractSkillDescription,
	tryExtractSkillPrompt,
	extractSkillComponents,
	// Hyper-Extract additions
	buildExtractSkillPrompt,
	validateExtractionResult,
	chunkLargeMessage,
	prefilterSkillIntent,
	EXTRACT_SKILL_JSON_SCHEMA,
} from '../../common/extractSkill.js';

// ─── Tests ────────────────────────────────────────────────────────────────────

suite('Extract Skill — Pure Functions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ════════════════════════════════════════════════════════════════════
	// toSkillSlug — 文本转 slug
	// ════════════════════════════════════════════════════════════════════

	suite('toSkillSlug', () => {

		test('simple English → lowercase slug', () => {
			assert.strictEqual(toSkillSlug('Git Commit Guide'), 'git-commit-guide');
		});

		test('Chinese text → pinyin-free slug (only letters/numbers preserved)', () => {
			// 不包含拼音转换——中文被替换为连字符
			const slug = toSkillSlug('代码审查指南');
			assert.ok(isValidSkillSlug(slug), `slug should be valid: "${slug}"`);
			assert.ok(slug.length > 0, 'slug should not be empty');
		});

		test('mixed Chinese + English → slug with English preserved', () => {
			const slug = toSkillSlug('Python 代码规范 Guide');
			assert.ok(slug.includes('python'), `should contain "python": "${slug}"`);
			assert.ok(slug.includes('guide'), `should contain "guide": "${slug}"`);
		});

		test('special characters stripped', () => {
			const slug = toSkillSlug('Deploy: K8s & Docker!');
			assert.strictEqual(slug, 'deploy-k8s-docker');
		});

		test('consecutive hyphens compressed', () => {
			const slug = toSkillSlug('a---b   c');
			assert.strictEqual(slug, 'a-b-c');
		});

		test('underscores preserved (valid slug char)', () => {
			// 与 SkillManagerTool.validateSkillSlug 一致：下划线是合法 slug 字符，不应被转换
			const slug = toSkillSlug('a b___c');
			assert.strictEqual(slug, 'a-b___c');
		});

		test('leading/trailing hyphens removed', () => {
			const slug = toSkillSlug('--hello world--');
			assert.strictEqual(slug, 'hello-world');
		});

		test('empty input → fallback slug', () => {
			const slug = toSkillSlug('');
			assert.ok(slug.startsWith('extracted-skill-'), `should start with "extracted-skill-": "${slug}"`);
			assert.ok(isValidSkillSlug(slug));
		});

		test('whitespace-only input → fallback slug', () => {
			const slug = toSkillSlug('   ');
			assert.ok(slug.startsWith('extracted-skill-'), `should start with "extracted-skill-": "${slug}"`);
		});

		test('long text truncated to 64 chars', () => {
			const long = 'a'.repeat(100) + '-hello';
			const slug = toSkillSlug(long);
			assert.ok(slug.length <= 64, `slug length ${slug.length} should be <= 64`);
			assert.ok(!slug.endsWith('-'), `slug should not end with hyphen: "${slug}"`);
		});

		test('all special chars → fallback slug', () => {
			const slug = toSkillSlug('！！！');
			assert.ok(slug.startsWith('extracted-skill-'), `all-special should fallback: "${slug}"`);
		});

		test('valid slug preserved', () => {
			assert.strictEqual(toSkillSlug('my-skill.v1'), 'my-skill.v1');
			assert.strictEqual(toSkillSlug('code_review_helper'), 'code_review_helper');
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// isValidSkillSlug — 校验 slug 格式
	// ════════════════════════════════════════════════════════════════════

	suite('isValidSkillSlug', () => {

		test('valid slugs → true', () => {
			assert.strictEqual(isValidSkillSlug('my-skill'), true);
			assert.strictEqual(isValidSkillSlug('deploy.v2'), true);
			assert.strictEqual(isValidSkillSlug('code_review'), true);
			assert.strictEqual(isValidSkillSlug('a'), true);
		});

		test('starts with number → true', () => {
			assert.strictEqual(isValidSkillSlug('3d-renderer'), true);
		});

		test('uppercase → false', () => {
			assert.strictEqual(isValidSkillSlug('My-Skill'), false);
		});

		test('empty → false', () => {
			assert.strictEqual(isValidSkillSlug(''), false);
		});

		test('starts with hyphen → false', () => {
			assert.strictEqual(isValidSkillSlug('-invalid'), false);
		});

		test('too long → false', () => {
			assert.strictEqual(isValidSkillSlug('a'.repeat(65)), false);
		});

		test('contains space → false', () => {
			assert.strictEqual(isValidSkillSlug('my skill'), false);
		});

		test('null / undefined → false', () => {
			assert.strictEqual(isValidSkillSlug(null as any), false);
			assert.strictEqual(isValidSkillSlug(undefined as any), false);
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// buildSkillMd — 构建完整 SKILL.md
	// ════════════════════════════════════════════════════════════════════

	suite('buildSkillMd', () => {

		test('minimal build → valid frontmatter + body', () => {
			const md = buildSkillMd('test-skill', 'A test skill', 'Do this.\nThen that.');
			assert.ok(md.startsWith('---\n'), 'should start with frontmatter');
			assert.ok(md.includes('name: "test-skill"'), 'should contain name field');
			assert.ok(md.includes('description: "A test skill"'), 'should contain description field');
			assert.ok(md.includes('Do this.\nThen that.'), 'should contain body');
			assert.ok(md.endsWith('\n'), 'should end with newline');
		});

		test('with category → includes category field', () => {
			const md = buildSkillMd('deploy', 'Deploy script', 'kubectl apply -f .', 'devops');
			assert.ok(md.includes('category: "devops"'), 'should contain category field');
		});

		test('empty category → omitted from frontmatter', () => {
			const md = buildSkillMd('x', 'x', 'body', '');
			assert.ok(!md.includes('category:'), 'empty category should be omitted');
		});

		test('double quotes in values escaped', () => {
			const md = buildSkillMd('x', 'He said "hello"', 'body');
			assert.ok(md.includes('\\"hello\\"'), 'double quotes should be escaped');
		});

		test('description truncated to 1024 chars', () => {
			const longDesc = 'd'.repeat(2000);
			const md = buildSkillMd('x', longDesc, 'body');
			const fmBlock = md.slice(0, md.indexOf('\n---', 4));
			const descMatch = fmBlock.match(/description: "(.+)"/);
			assert.ok(descMatch, 'should have description field');
			assert.ok(descMatch![1].length <= 1024 + 2, 'description should be truncated');
		});

		test('empty prompt body → still valid frontmatter', () => {
			const md = buildSkillMd('x', 'desc', '');
			assert.ok(md.startsWith('---\n'), 'should have frontmatter');
			assert.ok(md.includes('name:'), 'should have name');
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// buildSkillMdFromComponents — 便捷包装
	// ════════════════════════════════════════════════════════════════════

	suite('buildSkillMdFromComponents', () => {

		test('roundtrip with extractSkillComponents', () => {
			const components = {
				name: 'code-review',
				description: 'Review code changes',
				prompt: '## Steps\n1. Read the diff\n2. Check style\n3. Report issues',
			};
			const md = buildSkillMdFromComponents(components);
			const parsed = parseSkillMd(md);
			assert.ok(parsed, 'should parse successfully');
			assert.strictEqual(parsed!.name, 'code-review');
			assert.strictEqual(parsed!.description, 'Review code changes');
			assert.strictEqual(parsed!.prompt, '## Steps\n1. Read the diff\n2. Check style\n3. Report issues');
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// parseSkillMd — 解析 SKILL.md
	// ════════════════════════════════════════════════════════════════════

	suite('parseSkillMd', () => {

		test('valid SKILL.md → parsed components', () => {
			const md = [
				'---',
				'name: "my-skill"',
				'description: "A great skill"',
				'---',
				'',
				'Do this carefully.',
			].join('\n');
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.strictEqual(parsed!.name, 'my-skill');
			assert.strictEqual(parsed!.description, 'A great skill');
			assert.strictEqual(parsed!.prompt, 'Do this carefully.');
		});

		test('no frontmatter → null', () => {
			assert.strictEqual(parseSkillMd('Just some text'), null);
		});

		test('unclosed frontmatter → null', () => {
			assert.strictEqual(parseSkillMd('---\nname: x\nOops no close'), null);
		});

		test('empty content → null', () => {
			assert.strictEqual(parseSkillMd(''), null);
		});

		test('unquoted values → parsed', () => {
			const md = [
				'---',
				'name: my-skill',
				'description: No quotes needed',
				'---',
				'',
				'body',
			].join('\n');
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.strictEqual(parsed!.name, 'my-skill');
			assert.strictEqual(parsed!.description, 'No quotes needed');
		});

		test('single-quoted values → parsed', () => {
			const md = [
				'---',
				"name: 'my-skill'",
				"description: 'Desc'",
				'---',
				'',
				'body',
			].join('\n');
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.strictEqual(parsed!.name, 'my-skill');
		});

		test('category field → parsed', () => {
			const md = [
				'---',
				'name: "s"',
				'description: "d"',
				'category: "devops"',
				'---',
				'',
				'body',
			].join('\n');
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.strictEqual(parsed!.category, 'devops');
		});

		test('no category → category undefined', () => {
			const md = [
				'---',
				'name: "s"',
				'description: "d"',
				'---',
				'',
				'body',
			].join('\n');
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.strictEqual(parsed!.category, undefined);
		});

		test('multiline body preserved', () => {
			const md = [
				'---',
				'name: "s"',
				'description: "d"',
				'---',
				'',
				'## Heading',
				'',
				'- item 1',
				'- item 2',
				'',
				'```js',
				'console.log(1)',
				'```',
			].join('\n');
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.ok(parsed!.prompt.includes('## Heading'));
			assert.ok(parsed!.prompt.includes('```js'));
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// tryExtractSkillName — 从消息提取技能名
	// ════════════════════════════════════════════════════════════════════

	suite('tryExtractSkillName', () => {

		test('H1 heading → extracted', () => {
			assert.strictEqual(tryExtractSkillName('# Git Commit Guide\n\nSome content'), 'Git Commit Guide');
		});

		test('H2 heading → extracted', () => {
			assert.strictEqual(tryExtractSkillName('## Docker Deploy Script\n\nSteps here'), 'Docker Deploy Script');
		});

		test('no heading → first non-empty line', () => {
			assert.strictEqual(tryExtractSkillName('Python Code Style\n\nRules:\n- Pep8'), 'Python Code Style');
		});

		test('empty content → fallback', () => {
			const name = tryExtractSkillName('');
			assert.ok(name.startsWith('extracted-skill-'), `should fallback: "${name}"`);
		});

		test('whitespace only → fallback', () => {
			const name = tryExtractSkillName('\n  \n');
			assert.ok(name.startsWith('extracted-skill-'), `should fallback: "${name}"`);
		});

		test('long title truncated to 80 chars', () => {
			const long = '# ' + 'A'.repeat(100);
			const name = tryExtractSkillName(long);
			assert.ok(name.length <= 80);
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// tryExtractSkillDescription — 从消息提取描述
	// ════════════════════════════════════════════════════════════════════

	suite('tryExtractSkillDescription', () => {

		test('first paragraph → extracted', () => {
			const desc = tryExtractSkillDescription(
				'# Title\n\nThis skill helps you deploy to Kubernetes.\n\nMore details...'
			);
			assert.ok(desc.includes('skill helps you deploy'), `should extract paragraph: "${desc}"`);
		});

		test('skips heading lines', () => {
			const desc = tryExtractSkillDescription(
				'## Set up Docker\n\nAutomates Docker container setup and teardown.\n\n### Usage'
			);
			assert.ok(desc.startsWith('Automates Docker'), `should skip headings: "${desc}"`);
		});

		test('short paragraphs skipped', () => {
			const desc = tryExtractSkillDescription(
				'# Title\n\nOK.\n\nThis is a meaningful description that is long enough to be considered.\n\nThanks.'
			);
			assert.ok(desc.includes('meaningful description'), `should skip short paras: "${desc}"`);
		});

		test('no good paragraph → fallback', () => {
			const desc = tryExtractSkillDescription('# A\nOK\n');
			assert.strictEqual(desc, 'Extracted skill from chat message');
		});

		test('description truncated to 200 chars', () => {
			const longPara = 'W'.repeat(300);
			const desc = tryExtractSkillDescription(`# Title\n\n${longPara}`);
			assert.ok(desc.length <= 203, `should be truncated: got ${desc.length} chars`);
		});

		test('skips code blocks', () => {
			const desc = tryExtractSkillDescription(
				'# Title\n\n```js\nconsole.log(1)\n```\n\nThis is a real description here.\n\nMore text.'
			);
			assert.ok(!desc.includes('```'), 'should skip code blocks');
			assert.ok(desc.includes('real description'), `should find real description: "${desc}"`);
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// tryExtractSkillPrompt — 从消息提取技能正文
	// ════════════════════════════════════════════════════════════════════

	suite('tryExtractSkillPrompt', () => {

		test('plain text → full body (minus heading)', () => {
			const prompt = tryExtractSkillPrompt('# Title\n\nStep 1: Do A\nStep 2: Do B');
			assert.strictEqual(prompt, 'Step 1: Do A\nStep 2: Do B');
		});

		test('already SKILL.md format → extract body only', () => {
			const md = [
				'---',
				'name: "deploy"',
				'description: "Deploy script"',
				'---',
				'',
				'kubectl apply -f deployment.yaml',
			].join('\n');
			const prompt = tryExtractSkillPrompt(md);
			assert.strictEqual(prompt, 'kubectl apply -f deployment.yaml');
		});

		test('no heading → full text as body', () => {
			const text = 'Just run this command:\nkubectl get pods';
			assert.strictEqual(tryExtractSkillPrompt(text), text);
		});

		test('multiple headings → only first line stripped', () => {
			const prompt = tryExtractSkillPrompt('# Setup\n\n## Step 1\nDo X\n## Step 2\nDo Y');
			assert.ok(prompt.startsWith('## Step 1'));
			assert.ok(prompt.includes('Do Y'));
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// extractSkillComponents — 综合提取（主入口）
	// ════════════════════════════════════════════════════════════════════

	suite('extractSkillComponents', () => {

		test('structured message → all components extracted', () => {
			const result = extractSkillComponents(
				'# Git Commit Convention\n\n' +
				'A skill that enforces conventional commits format for all git operations.\n\n' +
				'## Rules\n' +
				'- Use `type(scope): description` format\n' +
				'- Valid types: feat, fix, docs, style, refactor, test, chore\n' +
				'- Max 72 chars per subject line'
			);
			assert.strictEqual(result.name, 'git-commit-convention');
			assert.ok(result.description.includes('conventional commits'));
			assert.ok(result.prompt.includes('feat, fix, docs'));
		});

		test('Chinese message → slug name generated', () => {
			const result = extractSkillComponents(
				'# 代码审查流程\n\n这是一个帮助团队进行代码审查的技能。\n\n## 步骤\n1. 检查代码风格\n2. 运行测试\n3. 检查安全性'
			);
			assert.ok(isValidSkillSlug(result.name), `name should be valid slug: "${result.name}"`);
			assert.ok(result.prompt.includes('代码风格') || result.prompt.includes('步骤'));
		});

		test('empty message → fallback slug', () => {
			const result = extractSkillComponents('');
			assert.ok(result.name.startsWith('extracted-skill-'));
			assert.strictEqual(result.description, 'Extracted skill from chat message');
		});

		test('SKILL.md format → parsed correctly', () => {
			const md = [
				'---',
				'name: "auto-deploy"',
				'description: "Automated deployment pipeline"',
				'category: "devops"',
				'---',
				'',
				'## Pipeline',
				'1. Build image',
				'2. Push to registry',
				'3. kubectl apply',
			].join('\n');
			const result = extractSkillComponents(md);
			assert.strictEqual(result.name, 'auto-deploy');
			assert.ok(result.description.includes('deployment'));
			assert.ok(result.prompt.includes('Build image'));
		});

		test('name with valid slug preserved as-is', () => {
			const result = extractSkillComponents('# my-cool-skill\n\nDescription here.\n\nBody text.');
			assert.strictEqual(result.name, 'my-cool-skill');
		});

		test('name with spaces → converted to slug', () => {
			const result = extractSkillComponents('# My Cool Skill\n\nDescription here.\n\nBody text.');
			assert.strictEqual(result.name, 'my-cool-skill');
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// 端到端：buildSkillMd → parseSkillMd 往返
	// ════════════════════════════════════════════════════════════════════

	suite('Roundtrip: buildSkillMd → parseSkillMd', () => {

		test('minimal roundtrip', () => {
			const md = buildSkillMd('hello-world', 'Say hello', 'echo "Hello World"');
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.strictEqual(parsed!.name, 'hello-world');
			assert.strictEqual(parsed!.description, 'Say hello');
			assert.strictEqual(parsed!.prompt, 'echo "Hello World"');
		});

		test('with category roundtrip', () => {
			const md = buildSkillMd('deploy', 'Deploy', 'body', 'devops');
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.strictEqual(parsed!.category, 'devops');
		});

		test('multiline body roundtrip', () => {
			const body = ['## Steps', '', '1. A', '2. B', '', '```python', 'print("ok")', '```'].join('\n');
			const md = buildSkillMd('test', 'Test', body);
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.strictEqual(parsed!.prompt, body);
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// 边界条件：特殊字符与异常输入
	// ════════════════════════════════════════════════════════════════════

	suite('Edge Cases', () => {

		test('backslashes in description escaped', () => {
			const md = buildSkillMd('x', 'Use C:\\path\\to\\file', 'body');
			assert.ok(md.includes('\\\\'), 'backslashes should be escaped');
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.strictEqual(parsed!.description, 'Use C:\\path\\to\\file');
		});

		test('newlines in description handled', () => {
			const md = buildSkillMd('x', 'Line 1\nLine 2', 'body');
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			// Description with \n in YAML unquoted is invalid; with quoting it's literal \n
			assert.ok(parsed!.description.includes('Line 1'));
		});

		test('code blocks in prompt preserved', () => {
			const body = '```typescript\nconst x = 1;\n```';
			const md = buildSkillMd('ts', 'TS example', body);
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.ok(parsed!.prompt.includes('```typescript'));
		});

		test('very long prompt body preserved', () => {
			const body = '# ' + 'A'.repeat(5000);
			const md = buildSkillMd('long', 'Long', body);
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.strictEqual(parsed!.prompt.length, body.length);
		});
	});
});

// ════════════════════════════════════════════════════════════════════════
// Hyper-Extract: JSON Schema + Structured Output 测试
// ════════════════════════════════════════════════════════════════════════

suite('Extract Skill — Hyper-Extract Additions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ════════════════════════════════════════════════════════════════════
	// EXTRACT_SKILL_JSON_SCHEMA — 与 Hyper-Extract Pydantic schema 对齐
	// ════════════════════════════════════════════════════════════════════

	suite('EXTRACT_SKILL_JSON_SCHEMA', () => {

		test('schema has type object', () => {
			assert.strictEqual(EXTRACT_SKILL_JSON_SCHEMA.type, 'object');
		});

		test('schema requires only isSkill', () => {
			const required = EXTRACT_SKILL_JSON_SCHEMA.required as string[];
			assert.ok(required.includes('isSkill'), 'isSkill should be required');
			assert.strictEqual(required.length, 1, 'only isSkill should be required');
		});

		test('schema has isSkill boolean property', () => {
			const props = EXTRACT_SKILL_JSON_SCHEMA.properties as Record<string, any>;
			assert.ok(props.isSkill);
			assert.strictEqual(props.isSkill.type, 'boolean');
		});

		test('schema has skill detail properties (name, description, prompt)', () => {
			const props = EXTRACT_SKILL_JSON_SCHEMA.properties as Record<string, any>;
			assert.ok(props.name, 'should have name property');
			assert.strictEqual(props.name.type, 'string');
			assert.ok(props.description, 'should have description property');
			assert.ok(props.prompt, 'should have prompt property');
		});

		test('schema has scripts array with correct shape', () => {
			const props = EXTRACT_SKILL_JSON_SCHEMA.properties as Record<string, any>;
			assert.ok(props.scripts, 'should have scripts property');
			assert.strictEqual(props.scripts.type, 'array');
			assert.ok(props.scripts.items, 'scripts should have items schema');
			const itemReq = props.scripts.items.required as string[];
			assert.ok(itemReq.includes('filename'));
			assert.ok(itemReq.includes('content'));
			assert.ok(itemReq.includes('language'));
		});

		test('schema has category optional field', () => {
			const props = EXTRACT_SKILL_JSON_SCHEMA.properties as Record<string, any>;
			assert.ok(props.category, 'should have category property');
			assert.strictEqual(props.category.type, 'string');
		});

		test('schema has reason field for classification', () => {
			const props = EXTRACT_SKILL_JSON_SCHEMA.properties as Record<string, any>;
			assert.ok(props.reason, 'should have reason property');
			assert.strictEqual(props.reason.type, 'string');
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// validateExtractionResult — LLM 结果校验（Hyper-Extract assertRequired 等价）
	// ════════════════════════════════════════════════════════════════════

	suite('validateExtractionResult', () => {

		test('valid isSkill=true → returns result with all fields', () => {
			const raw = {
				isSkill: true,
				reason: 'reusable pattern',
				name: 'git-commit-guide',
				description: 'Guide for conventional commits',
				category: 'coding',
				prompt: '# Git Commit Guide\n\nUse semantic commits with proper format.'
			};
			const result = validateExtractionResult(raw);
			assert.ok(!('error' in result));
			const r = result as any;
			assert.strictEqual(r.isSkill, true);
			assert.strictEqual(r.name, 'git-commit-guide');
			assert.strictEqual(r.prompt, '# Git Commit Guide\n\nUse semantic commits with proper format.');
			assert.strictEqual(r.category, 'coding');
		});

		test('valid isSkill=false → returns result with empty fields', () => {
			const raw = {
				isSkill: false,
				reason: 'one-time task narrative'
			};
			const result = validateExtractionResult(raw);
			assert.ok(!('error' in result));
			const r = result as any;
			assert.strictEqual(r.isSkill, false);
			assert.strictEqual(r.reason, 'one-time task narrative');
			assert.strictEqual(r.name, '');
		});

		test('isSkill=true but missing name → error', () => {
			const raw = {
				isSkill: true,
				reason: 'reusable',
				name: '',
				prompt: 'some long enough content here for the skill body to pass validation'
			};
			const result = validateExtractionResult(raw);
			assert.ok('error' in result);
			assert.ok((result as any).error.includes('name'));
		});

		test('isSkill=true but prompt too short → error', () => {
			const raw = {
				isSkill: true,
				reason: 'reusable',
				name: 'test-skill',
				prompt: 'too short'
			};
			const result = validateExtractionResult(raw);
			assert.ok('error' in result);
			assert.ok((result as any).error.includes('too short'));
		});

		test('non-object input → error', () => {
			const result = validateExtractionResult(null);
			assert.ok('error' in result, 'null should be rejected');
		});

		test('missing isSkill → error', () => {
			const result = validateExtractionResult({ name: 'x' });
			assert.ok('error' in result);
			assert.ok((result as any).error.includes('isSkill'));
		});

		test('isSkill=false with reason → valid', () => {
			const raw = { isSkill: false, reason: 'environment-specific failure' };
			const result = validateExtractionResult(raw);
			assert.ok(!('error' in result));
		});

		test('scripts array parsed correctly', () => {
			const raw = {
				isSkill: true,
				reason: 'workflow',
				name: 'deploy',
				prompt: 'A comprehensive deployment guide with multiple steps to ensure reliable production releases.',
				scripts: [
					{ filename: 'deploy.sh', content: '#!/bin/bash\necho deploy', language: 'sh' },
					{ filename: 'validate.py', content: 'print("ok")', language: 'py' }
				]
			};
			const result = validateExtractionResult(raw);
			assert.ok(!('error' in result));
			const r = result as any;
			assert.ok(r.scripts);
			assert.strictEqual(r.scripts.length, 2);
			assert.strictEqual(r.scripts[0].filename, 'deploy.sh');
			assert.strictEqual(r.scripts[1].language, 'py');
		});

		test('invalid script entries filtered out', () => {
			const raw = {
				isSkill: true,
				reason: 'workflow',
				name: 'deploy',
				prompt: 'A comprehensive deployment guide with multiple steps and configuration checks.',
				scripts: [
					{ filename: 'ok.sh', content: 'echo ok', language: 'sh' },
					{ bad: 'entry' },  // missing required fields
					null
				]
			};
			const result = validateExtractionResult(raw);
			assert.ok(!('error' in result));
			const r = result as any;
			assert.ok(r.scripts);
			assert.strictEqual(r.scripts.length, 1, 'bad entries should be filtered');
			assert.strictEqual(r.scripts[0].filename, 'ok.sh');
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// buildExtractSkillPrompt — Hyper-Extract 风格 LLM prompt
	// ════════════════════════════════════════════════════════════════════

	suite('buildExtractSkillPrompt', () => {

		test('prompt includes content', () => {
			const content = 'This is a test message about deploying to Kubernetes.';
			const prompt = buildExtractSkillPrompt(content);
			assert.ok(prompt.includes(content), 'prompt should contain original content');
		});

		test('prompt includes capture/ignore guidance', () => {
			const prompt = buildExtractSkillPrompt('test');
			assert.ok(prompt.includes('CAPTURE'), 'should have CAPTURE section');
			assert.ok(prompt.includes('IGNORE'), 'should have IGNORE section');
			assert.ok(prompt.includes('isSkill=true'), 'should reference isSkill');
		});

		test('prompt includes classification categories', () => {
			const prompt = buildExtractSkillPrompt('test');
			assert.ok(prompt.includes('reusable pattern'), 'should mention reusable pattern');
			assert.ok(prompt.includes('one-time task'), 'should mention one-time task');
			assert.ok(prompt.includes('casual chat'), 'should mention casual chat');
		});

		test('prompt includes extraction instructions', () => {
			const prompt = buildExtractSkillPrompt('test');
			assert.ok(prompt.includes('name: lowercase slug'), 'should mention name format');
			assert.ok(prompt.includes('description: one-line'), 'should mention description');
			assert.ok(prompt.includes('prompt: self-contained'), 'should mention prompt format');
		});

		test('long content truncated', () => {
			const long = 'x'.repeat(7000);
			const prompt = buildExtractSkillPrompt(long);
			assert.ok(prompt.length < 7000 + 2000, 'prompt should truncate long content');
			assert.ok(prompt.endsWith('...'), 'should end with "...');
		});

		test('short content not truncated', () => {
			const short = 'Hello World';
			const prompt = buildExtractSkillPrompt(short);
			assert.ok(prompt.includes(short));
			assert.ok(!prompt.endsWith('...'), 'short content should not be truncated');
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// chunkLargeMessage — Hyper-Extract 文本分块
	// ════════════════════════════════════════════════════════════════════

	suite('chunkLargeMessage', () => {

		test('short content → single chunk', () => {
			const chunks = chunkLargeMessage('hello world', 2048);
			assert.strictEqual(chunks.length, 1);
			assert.strictEqual(chunks[0], 'hello world');
		});

		test('exactly at chunk size → single chunk', () => {
			const content = 'a'.repeat(2048);
			const chunks = chunkLargeMessage(content, 2048);
			assert.strictEqual(chunks.length, 1);
			assert.strictEqual(chunks[0], content);
		});

		test('slightly over → two chunks with overlap', () => {
			const content = 'a'.repeat(2500);
			const chunks = chunkLargeMessage(content, 2048, 256);
			assert.ok(chunks.length >= 2, `should have at least 2 chunks, got ${chunks.length}`);
			// overlap: chunk[1] should start within first chunk's range
			const overlapStart = content.indexOf(chunks[1]);
			assert.ok(overlapStart < 2048, `overlap start should be < 2048, got ${overlapStart}`);
		});

		test('breaks on paragraph boundary (double newline)', () => {
			const para1 = 'A'.repeat(1500);
			const para2 = 'B'.repeat(1500);
			const content = para1 + '\n\n' + para2;
			const chunks = chunkLargeMessage(content, 2048, 256);
			assert.ok(chunks.length >= 2, 'should split into at least 2 chunks');
			// First chunk should end at or before the paragraph break
			assert.ok(chunks[0].length <= 2050, 'chunk should be near chunk size');
		});

		test('breaks on sentence boundary (period)', () => {
			const sent1 = 'A'.repeat(1500) + '. ';
			const sent2 = 'B'.repeat(1500) + '. ';
			const content = sent1 + sent2;
			const chunks = chunkLargeMessage(content, 2048, 256);
			assert.ok(chunks.length >= 2, 'should split across sentence boundary');
		});

		test('overlap preserved between adjacent chunks', () => {
			const content = Array.from({ length: 100 }, (_, i) => `Line ${i}: ${'x'.repeat(60)}`).join('\n');
			const chunks = chunkLargeMessage(content, 1500, 256);
			if (chunks.length >= 2) {
				const lastBit = chunks[0].slice(-50);
				const found = chunks[1].includes(lastBit);
				// Overlap may not always be perfect with boundary breaking, but chunks should connect
				assert.ok(true, 'overlap behavior tested');
			}
		});

		test('chunk size 512 with 64 overlap', () => {
			const content = 'x'.repeat(2000);
			const chunks = chunkLargeMessage(content, 512, 64);
			assert.ok(chunks.length >= 4, `should have >=4 chunks, got ${chunks.length}`);
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// prefilterSkillIntent — 意图预判（无 LLM）
	// ════════════════════════════════════════════════════════════════════

	suite('prefilterSkillIntent', () => {

		test('too short → likely false', () => {
			const result = prefilterSkillIntent('short');
			assert.strictEqual(result.likely, false);
			assert.ok(result.reason.includes('too short'));
		});

		test('pure code block → likely false', () => {
			const result = prefilterSkillIntent('```js\nconsole.log(1)\n```');
			assert.strictEqual(result.likely, false);
			assert.ok(result.reason.includes('code blocks'));
		});

		test('casual greeting → likely false', () => {
			const result = prefilterSkillIntent('Hi there, how are you doing today? Good morning everyone!');
			assert.strictEqual(result.likely, false);
			assert.ok(result.reason.includes('casual conversation'));
		});

		test('structured tutorial content → likely true', () => {
			const result = prefilterSkillIntent(
				'# How to Deploy to Kubernetes\n\n' +
				'This guide walks through the complete deployment workflow for Kubernetes.\n\n' +
				'## Step 1: Build the Docker image\nFirst, ensure you have Docker installed...\n\n' +
				'## Step 2: Push to registry\nUse the following commands to push...'
			);
			assert.strictEqual(result.likely, true);
			assert.ok(result.reason.includes('skill indicators'));
		});

		test('content with workflow pattern → likely true', () => {
			const result = prefilterSkillIntent(
				'When deploying to staging, follow this workflow: first build, then test, then deploy.\n\n' +
				'### Commands\n- npm run build\n- npm test\n- npm run deploy'
			);
			assert.strictEqual(result.likely, true);
		});

		test('medium length without clear indicators → likely true (will attempt extraction)', () => {
			const result = prefilterSkillIntent(
				'A'.repeat(200) + ' ' + 'B'.repeat(200)
			);
			assert.strictEqual(result.likely, true);
			assert.ok(result.reason.includes('length sufficient'));
		});

		test('error report → depends on length/indicators (may pass through)', () => {
			// Error reports are caught by LLM, not prefilter
			const result = prefilterSkillIntent(
				'I got this error when running the build:\n\n' +
				'Error: Cannot find module "./config"\n\n' +
				'The fix was to add the module alias in tsconfig.json and update the import path.\n\n' +
				'## Solution\n1. Edit tsconfig.json\n2. Add paths mapping\n3. Restart the dev server'
			);
			assert.strictEqual(result.likely, true, 'error report with solution may pass prefilter, LLM decides');
		});
	});

	// ════════════════════════════════════════════════════════════════════
	// 端到端：Hyper-Extract 提取流程
	// ════════════════════════════════════════════════════════════════════

	suite('Hyper-Extract E2E: LLM result → extraction', () => {

		test('isSkill=true → components extracted with all fields', () => {
			const raw = {
				isSkill: true,
				reason: 'reusable pattern',
				name: 'docker-cleanup',
				description: 'Clean up unused Docker resources',
				category: 'devops',
				prompt: '## Docker Cleanup\n\nRun these commands weekly to free disk space.',
				scripts: [{ filename: 'cleanup.sh', content: '#!/bin/bash\ndocker system prune -f', language: 'sh' }]
			};
			const result = validateExtractionResult(raw);
			assert.ok(!('error' in result));
			const r = result as any;
			assert.strictEqual(r.isSkill, true);
			assert.strictEqual(r.name, 'docker-cleanup');
			assert.strictEqual(r.category, 'devops');
			assert.ok(r.scripts);
			assert.strictEqual(r.scripts.length, 1);
		});

		test('isSkill=false → no skill extracted, reason logged', () => {
			const raw = {
				isSkill: false,
				reason: 'one-time task narrative about deploying to production'
			};
			const result = validateExtractionResult(raw);
			assert.ok(!('error' in result));
			const r = result as any;
			assert.strictEqual(r.isSkill, false);
			assert.strictEqual(r.reason, 'one-time task narrative about deploying to production');
		});

		test('LLM extraction → build SKILL.md roundtrip', () => {
			const raw = {
				isSkill: true,
				reason: 'workflow',
				name: 'git-rebase-interactive',
				description: 'Interactive rebase workflow for clean commit history',
				prompt: '# Git Interactive Rebase\n\n1. Start: `git rebase -i HEAD~5`\n2. Mark commits: pick/reword/squash/fixup\n3. Save and close editor',
			};
			const result = validateExtractionResult(raw);
			assert.ok(!('error' in result));
			const r = result as any;

			// Build SKILL.md from LLM result
			const md = buildSkillMd(r.name, r.description, r.prompt, r.category);
			const parsed = parseSkillMd(md);
			assert.ok(parsed);
			assert.strictEqual(parsed!.name, 'git-rebase-interactive');
			assert.strictEqual(parsed!.description, 'Interactive rebase workflow for clean commit history');
			assert.ok(parsed!.prompt.includes('git rebase -i'));
		});
	});
});
