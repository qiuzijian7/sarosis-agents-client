/*---------------------------------------------------------------------------------------------
 *  SkillExtractor 单元测试 — 技能提取、去重、SKILL.md 生成
 *--------------------------------------------------------------------------------------------*/
import {
	SkillExtractor,
	type ExtractedSkill,
	type SkillExtractInput,
	generateSlug,
	generateSkillMd,
} from '../skillExtract.js';
import { describe, it, itAsync, assert, assertEqual } from './testRunner.js';

function makeInput(overrides?: Partial<SkillExtractInput>): SkillExtractInput {
	return {
		sessionId: 'test-session-001',
		summary: {
			title: '修复 TypeScript 编译错误',
			narrative: '通过分析 tsconfig.json 和修复类型声明解决了编译错误',
			keyDecisions: ['decided to use strict mode'],
			filesModified: ['src/index.ts'],
			toolsUsed: ['tsc', 'eslint'],
		},
		observations: [
			{ content: 'Encountered TypeScript compile error in index.ts', type: 'error', importance: 8, timestamp: 1 },
			{ content: 'Analyzed tsconfig.json settings', type: 'analysis', importance: 6, timestamp: 2 },
			{ content: 'Fixed type declaration in interface', type: 'fix', importance: 7, timestamp: 3 },
			{ content: 'Ran tsc to verify fix deployed successfully', type: 'test', importance: 5, timestamp: 4 },
			{ content: 'Verified build passes with no errors', type: 'verification', importance: 6, timestamp: 5 },
		],
		...overrides,
	};
}

export function runSkillExtractTests(): void {
describe('generateSlug', () => {
	it('Chinese keywords mapped to English', () => {
		const slug = generateSlug('修复 TypeScript 编译错误');
		assert(slug.includes('fix'), `contains fix: "${slug}"`);
		assert(slug.includes('compile'), `contains compile: "${slug}"`);
	});

	it('removes Chinese characters', () => {
		const slug = generateSlug('部署配置');
		assert(!/[\u4e00-\u9fff]/.test(slug), `no Chinese: "${slug}"`);
		assert(slug.includes('deploy'), `contains deploy: "${slug}"`);
		assert(slug.includes('config'), `contains config: "${slug}"`);
	});

	it('special chars replaced with hyphens', () => {
		const slug = generateSlug('Fix: The "Bug" #1!');
		assert(/^[a-z0-9-]+$/.test(slug), `url-safe: "${slug}"`);
	});

	it('limits length to 60 chars', () => {
		const long = 'A Very Long Title That Exceeds The Sixty Character Limit For Sure Yes Indeed';
		const slug = generateSlug(long);
		assert(slug.length <= 60, `length ${slug.length} <= 60: "${slug}"`);
	});

	it('fallback for all-Chinese title with no mapping', () => {
		const slug = generateSlug('自定义标题');
		assert(slug.length > 0, `non-empty fallback: "${slug}"`);
	});
});

describe('generateSkillMd', () => {
	it('generates valid SKILL.md with frontmatter', () => {
		const skill: ExtractedSkill = {
			id: 'skill-test-1',
			trigger: '当遇到编译错误时',
			title: '修复编译错误',
			steps: ['分析错误信息', '检查配置文件', '修复类型声明'],
			expectedOutcome: '编译通过',
			tags: ['typescript', 'compile'],
			sourceSessionId: 'sess-1',
			confidence: 0.8,
			usageCount: 0,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			slug: 'fix-compile-errors',
		};
		const md = generateSkillMd(skill);
		assert(md.startsWith('---\n'), 'starts with frontmatter');
		assert(md.includes('name: fix-compile-errors'), 'has name');
		assert(md.includes('version: 1.0.0'), 'has version');
		assert(md.includes('# 修复编译错误'), 'has title heading');
		assert(md.includes('## 触发条件'), 'has trigger section');
		assert(md.includes('## 执行步骤'), 'has steps section');
		assert(md.includes('## 预期结果'), 'has expected outcome section');
	});

	it('auto-generates slug if missing', () => {
		const skill: ExtractedSkill = {
			id: 'skill-test-2',
			trigger: 'trigger',
			title: 'Deploy Config',
			steps: ['step1', 'step2'],
			expectedOutcome: 'done',
			tags: [],
			sourceSessionId: 'sess-2',
			confidence: 0.5,
			usageCount: 0,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		const md = generateSkillMd(skill);
		assert(md.includes('name: deploy-config'), `auto slug in md: ${md.split('\n')[1]}`);
	});

	it('numbered steps format', () => {
		const skill: ExtractedSkill = {
			id: 'skill-test-3',
			trigger: 't',
			title: 'Test',
			steps: ['First', 'Second', 'Third'],
			expectedOutcome: 'ok',
			tags: [],
			sourceSessionId: 's',
			confidence: 0.5,
			usageCount: 0,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			slug: 'test',
		};
		const md = generateSkillMd(skill);
		assert(md.includes('1. First'), 'step 1');
		assert(md.includes('2. Second'), 'step 2');
		assert(md.includes('3. Third'), 'step 3');
	});
});

describe('SkillExtractor.extract', () => {
	it('extracts skill from valid session', () => {
		const se = new SkillExtractor();
		const skill = se.extract(makeInput());
		assert(skill !== null, 'skill extracted');
		assert(skill!.steps.length >= 2, `has steps: ${skill!.steps.length}`);
		assert(skill!.confidence > 0, `has confidence: ${skill!.confidence}`);
		assert(skill!.slug !== undefined, 'has slug');
		assert(skill!.skillMdWritten === false, 'not yet written');
	});

	it('returns null for too few observations', () => {
		const se = new SkillExtractor();
		const skill = se.extract(makeInput({
			observations: [{ content: 'only one', type: 'x', importance: 5, timestamp: 1 }],
		}));
		assert(skill === null, 'null for < 3 observations');
	});

	it('returns null when no triggers detected', () => {
		const se = new SkillExtractor();
		const skill = se.extract(makeInput({
			summary: {
				title: '普通会话',
				narrative: '这是一次普通的对话，没有特殊关键词',
				keyDecisions: [],
				filesModified: [],
				toolsUsed: [],
			},
			observations: [
				{ content: 'hello there', type: 'chat', importance: 5, timestamp: 1 },
				{ content: 'how are you', type: 'chat', importance: 5, timestamp: 2 },
				{ content: 'goodbye now', type: 'chat', importance: 5, timestamp: 3 },
			],
		}));
		assert(skill === null, 'null when no triggers');
	});

	it('fingerprint dedup reinforces existing skill', () => {
		const se = new SkillExtractor();
		const input = makeInput();
		const skill1 = se.extract(input);
		assert(skill1 !== null, 'first extraction');
		const originalConfidence = skill1!.confidence;
		const originalUsage = skill1!.usageCount;

		// Same title + trigger → should reinforce, not create new
		const skill2 = se.extract(input);
		assert(skill2 !== null, 'second extraction');
		assertEqual(skill2!.id, skill1!.id, 'same skill ID (reinforced)');
		assert(skill2!.usageCount === originalUsage + 1, `usage incremented: ${skill2!.usageCount}`);
		assert(skill2!.confidence >= originalConfidence, `confidence reinforced: ${skill2!.confidence} >= ${originalConfidence}`);
	});

	it('different sessions with same pattern reinforce', () => {
		const se = new SkillExtractor();
		const s1 = se.extract(makeInput({ sessionId: 'sess-A' }));
		const s2 = se.extract(makeInput({ sessionId: 'sess-B' }));
		assert(s1 !== null && s2 !== null, 'both extracted');
		assertEqual(s1!.id, s2!.id, 'same skill (dedup)');
	});
});

describe('SkillExtractor CRUD', () => {
	it('get returns null for unknown id', () => {
		const se = new SkillExtractor();
		assert(se.get('nonexistent') === null, 'null for unknown');
	});

	it('list returns sorted by confidence', () => {
		const se = new SkillExtractor();
		se.extract(makeInput());
		const list = se.list();
		assert(list.length > 0, 'has skills');
		for (let i = 1; i < list.length; i++) {
			assert(list[i - 1].confidence >= list[i].confidence, 'sorted desc');
		}
	});

	it('list filters by minConfidence', () => {
		const se = new SkillExtractor();
		se.extract(makeInput());
		const all = se.list();
		const minConf = all[0].confidence;
		const filtered = se.list({ minConfidence: minConf + 0.01 });
		assert(filtered.length < all.length || all.length <= 1, 'filtered or single');
	});

	it('search matches title and tags', () => {
		const se = new SkillExtractor();
		se.extract(makeInput());
		const results = se.search('typescript');
		assert(results.length > 0, 'found by keyword');
	});

	it('delete removes skill', () => {
		const se = new SkillExtractor();
		const skill = se.extract(makeInput());
		assert(skill !== null, 'extracted');
		const deleted = se.delete(skill!.id);
		assert(deleted, 'delete returns true');
		assert(se.get(skill!.id) === null, 'no longer found');
	});

	it('update modifies skill and resets skillMdWritten', () => {
		const se = new SkillExtractor();
		const skill = se.extract(makeInput());
		assert(skill !== null, 'extracted');
		const originalSlug = skill!.slug;

		// Simulate it was written
		se.markWritten(skill!.id);
		const written = se.get(skill!.id);
		assert(written!.skillMdWritten === true, 'marked as written');

		// Update should reset skillMdWritten
		const updated = se.update(skill!.id, { title: 'Updated Title' });
		assert(updated !== null, 'update returns skill');
		assertEqual(updated!.title, 'Updated Title', 'title updated');
		assert(updated!.skillMdWritten === false, 'skillMdWritten reset after update');
		assert(updated!.slug !== originalSlug, `slug regenerated: "${updated!.slug}" !== "${originalSlug}"`);
	});

	it('markWritten sets flag', () => {
		const se = new SkillExtractor();
		const skill = se.extract(makeInput());
		assert(skill !== null, 'extracted');
		assert(skill!.skillMdWritten === false, 'initially false');
		const ok = se.markWritten(skill!.id);
		assert(ok, 'markWritten returns true');
		assert(se.get(skill!.id)!.skillMdWritten === true, 'now true');
	});

	it('markUsed increments usageCount', () => {
		const se = new SkillExtractor();
		const skill = se.extract(makeInput());
		assert(skill !== null, 'extracted');
		const before = skill!.usageCount;
		se.markUsed(skill!.id);
		const after = se.get(skill!.id)!;
		assert(after.usageCount === before + 1, `usage incremented: ${after.usageCount}`);
	});

	it('getStats returns aggregate stats', () => {
		const se = new SkillExtractor();
		se.extract(makeInput());
		const stats = se.getStats();
		assert(stats.totalSkills > 0, `totalSkills: ${stats.totalSkills}`);
		assert(stats.avgConfidence > 0, `avgConfidence: ${stats.avgConfidence}`);
		assert(stats.avgSteps > 0, `avgSteps: ${stats.avgSteps}`);
	});

	it('clear removes all skills', () => {
		const se = new SkillExtractor();
		se.extract(makeInput());
		assert(se.list().length > 0, 'has skills');
		se.clear();
		assertEqual(se.list().length, 0, 'cleared');
		assertEqual(se.getStats().totalSkills, 0, 'stats show 0');
	});
});
}
