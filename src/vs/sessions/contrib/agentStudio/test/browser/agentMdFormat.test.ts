/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * agent.md 格式转换（YAML frontmatter + Markdown body）单元测试。
 *
 * 覆盖点：
 *   1. buildAgentMd — 最小 agent / 完整字段 / 嵌套对象 / 空值省略
 *   2. parseAgentMd — 正常解析 / 缺失 id 返回 null / 损坏 YAML 返回 null / 无 --- 返回 null
 *   3. 往返一致性 — buildAgentMd → parseAgentMd → 字段一致
 *
 * 依赖 `js-yaml`（项目已安装但无 @types，此处不涉及类型声明问题）。
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildAgentMd, parseAgentMd } from '../../common/agentMdFormat.js';
import type { Agent } from '../../../common/agentStudioTypes.js';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
	return {
		id: 'agent-test-001',
		name: 'Test Agent',
		role: 'assistant',
		description: '',
		icon: '🤖',
		model: 'claude-sonnet-4-20250514',
		skills: [],
		category: 'General',
		source: 'custom',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	} as Agent;
}

suite('Agent Studio - Agent Markdown Format', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('buildAgentMd', () => {

		test('最小 agent（仅必填字段）→ 生成有效 agent.md', () => {
			const agent = makeAgent();
			const md = buildAgentMd(agent);
			assert.ok(md.startsWith('---'));
			assert.ok(md.includes('id: agent-test-001'));
			assert.ok(md.includes('name: Test Agent'));
		});

		test('完整字段 agent → frontmatter 包含所有非默认值', () => {
			const agent = makeAgent({
				description: 'A full-featured agent',
				icon: '🚀',
				model: 'gpt-4o',
				category: 'DevOps',
				owner: 'taihu:staffid:123456',
				version: '2.1.0',
				storeId: 'store-abc',
				skills: ['code-review', 'tdd'],
				tools: ['read_file', 'web_search'],
				temperature: 0.7,
				status: 'idle' as Agent['status'],
				sortOrder: 10,
				createdAt: '2026-06-01T00:00:00.000Z',
				updatedAt: '2026-07-01T00:00:00.000Z',
			});
			const md = buildAgentMd(agent);

			// 必填字段
			assert.ok(md.includes('id: agent-test-001'));
			assert.ok(md.includes('name: Test Agent'));
			// ★ role 为默认值 'assistant' 时不写入（对齐 VS Code 标准：默认值省略）
			assert.ok(!md.includes('role:'), 'default role should be omitted');
			assert.ok(md.includes('source: custom'));
			// 非默认值字段
			assert.ok(md.includes('description:'), 'should have description');
			assert.ok(md.includes('🚀'), 'should have icon');
			assert.ok(md.includes('gpt-4o'), 'should have model');
			assert.ok(md.includes('DevOps'), 'should have category');
			assert.ok(md.includes('taihu:staffid:123456'), 'should have owner');
			assert.ok(md.includes('2.1.0'), 'should have version');
			assert.ok(md.includes('store-abc'), 'should have storeId');
			assert.ok(md.includes('code-review'), 'should have skills');
			assert.ok(md.includes('read_file'), 'should have tools');
			assert.ok(md.includes('0.7'), 'should have temperature');
			assert.ok(md.includes('10'), 'should have sortOrder');
		});

		test('空值字段自动省略 — 图标为 🤖 不写入', () => {
			const agent = makeAgent({ icon: '🤖' });
			const md = buildAgentMd(agent);
			// 默认图标不写入
			assert.ok(!md.includes('icon: 🤖'), 'default icon should be omitted');
		});

		test('空值字段自动省略 — category 为 General 不写入', () => {
			const agent = makeAgent({ category: 'General' });
			const md = buildAgentMd(agent);
			assert.ok(!md.includes('category: General'), 'default category should be omitted');
		});

		test('空 skills/tools 不写入', () => {
			const agent = makeAgent({ skills: [], tools: undefined });
			const md = buildAgentMd(agent);
			assert.ok(!md.includes('skills:'), 'empty skills should be omitted');
		});

		test('嵌套对象字段正确序列化 — handOffs', () => {
			const agent = makeAgent({
				handOffs: [
					{ targetAgentId: 'agent-b', description: 'Hand off to B', condition: 'User asks about B' },
				],
			});
			const md = buildAgentMd(agent);
			// ★ VS Code 标准字段用 lowercase `handoffs`（PromptHeaderAttributes.handOffs = 'handoffs'）
			assert.ok(md.includes('handoffs:'));
			assert.ok(md.includes('agent-b'));
			assert.ok(md.includes('Hand off to B'));
			// ★ 对象数组元素必须序列化为字段，而非 '[object Object]'
			assert.ok(!md.includes('[object Object]'), 'handOffs 对象不得退化为 [object Object]');
		});

		test('systemPrompt 作为 Markdown body 写入', () => {
			const agent = makeAgent({
				systemPrompt: '## Rules\n\n- Always be polite\n- Never invent facts',
			});
			const md = buildAgentMd(agent);
			assert.ok(md.includes('## Rules'));
			assert.ok(md.includes('Always be polite'));
			// ★ 新格式无 trailing `---`：`---\n<yaml>\n---\n\n<body>`，仅 2 个分隔符
			//   （frontmatter 起始 + 结束），split('---') 得 3 段。
			const parts = md.split('---');
			assert.strictEqual(parts.length, 3, 'should have 2 dashes separators (frontmatter open/close)');
			});
	});

	suite('parseAgentMd', () => {

		test('解析最小 agent.md', () => {
			const md = [
				'---',
				'id: agent-001',
				'name: Minimal Agent',
				'role: assistant',
				'source: custom',
				'createdAt: "2026-01-01T00:00:00.000Z"',
				'updatedAt: "2026-01-01T00:00:00.000Z"',
				'---',
				'',
				'System prompt here',
			].join('\n');

			const result = parseAgentMd(md);
			assert.ok(result, 'should parse successfully');
			assert.strictEqual(result!.agent.id, 'agent-001');
			assert.strictEqual(result!.agent.name, 'Minimal Agent');
			assert.strictEqual(result!.agent.source, 'custom');
			assert.strictEqual(result!.systemPrompt, 'System prompt here');
		});

		test('解析含数组字段的 agent.md', () => {
			const md = [
				'---',
				'id: agent-002',
				'name: Skill Agent',
				'role: assistant',
				'source: custom',
				'skills:',
				'  - code-review',
				'  - tdd',
				'tools:',
				'  - read_file',
				'  - web_search',
				'createdAt: "2026-01-01T00:00:00.000Z"',
				'updatedAt: "2026-01-01T00:00:00.000Z"',
				'---',
				'',
				'Prompt body',
			].join('\n');

			const result = parseAgentMd(md);
			assert.ok(result);
			assert.deepStrictEqual(result!.agent.skills, ['code-review', 'tdd']);
			assert.deepStrictEqual(result!.agent.tools, ['read_file', 'web_search']);
		});

		test('缺失 id → 回退 name slug 化（兼容纯 VS Code 格式 agent.md）', () => {
			const md = [
				'---',
				'name: No ID Agent',
				'source: custom',
				'---',
			].join('\n');
			// ★ 实现已放宽 id 要求：无 id 时用 name slug 化回退（不再返回 null）
			const result = parseAgentMd(md);
			assert.ok(result, '无 id 时应回退 name slug 而非返回 null');
			assert.strictEqual(result!.agent.id, 'no-id-agent');
			assert.strictEqual(result!.agent.name, 'No ID Agent');
		});

		test('无 YAML frontmatter（不以 --- 开头）返回 null', () => {
			assert.strictEqual(parseAgentMd('# Just markdown'), null);
			assert.strictEqual(parseAgentMd(''), null);
		});

		test('损坏的 YAML 返回 null', () => {
			// ★ VS Code 内置 yaml 解析器对 `bad:: double colon` 这类会容错（当成值以冒号
			//   开头）；真正触发 parse error 的是未闭合结构（数组/对象/非法缩进）。
			const md = [
				'---',
				'id: agent-ok',
				'skills: [a, b',
				'---',
			].join('\n');
			assert.strictEqual(parseAgentMd(md), null);
		});

		test('解析内联数组（一行 [a, b] 格式）', () => {
			const md = [
				'---',
				'id: agent-003',
				'name: Inline Array Agent',
				'role: assistant',
				'source: custom',
				"skills: [code-review, tdd]",
				'createdAt: "2026-01-01T00:00:00.000Z"',
				'updatedAt: "2026-01-01T00:00:00.000Z"',
				'---',
			].join('\n');

			const result = parseAgentMd(md);
			assert.ok(result);
			assert.deepStrictEqual(result!.agent.skills, ['code-review', 'tdd']);
		});
	});

	suite('往返一致性 (round-trip)', () => {

		test('最小 agent buildAgentMd → parseAgentMd → 字段一致', () => {
			const agent = makeAgent();
			const md = buildAgentMd(agent);
			const parsed = parseAgentMd(md);
			assert.ok(parsed);
			assert.strictEqual(parsed!.agent.id, agent.id);
			assert.strictEqual(parsed!.agent.name, agent.name);
			assert.strictEqual(parsed!.agent.source, agent.source);
		});

		test('完整字段 agent 往返', () => {
			const agent = makeAgent({
				description: 'Full agent',
				icon: '🔧',
				model: 'claude-opus',
				category: 'Testing',
				owner: 'taihu:staffid:999',
				version: '1.0.0',
				storeId: 'store-xyz',
				skills: ['code-review'],
				tools: ['read_file'],
				temperature: 0.5,
				sortOrder: 5,
				createdAt: '2026-01-02T00:00:00.000Z',
				updatedAt: '2026-01-02T00:00:00.000Z',
			});
			const md = buildAgentMd(agent);
			const parsed = parseAgentMd(md);
			assert.ok(parsed);
			assert.strictEqual(parsed!.agent.id, 'agent-test-001');
			assert.strictEqual(parsed!.agent.owner, 'taihu:staffid:999');
			assert.deepStrictEqual(parsed!.agent.skills, ['code-review']);
			assert.strictEqual(parsed!.agent.temperature, 0.5);
			assert.strictEqual(parsed!.agent.sortOrder, 5);
		});

		test('含 systemPrompt 的 agent 往返 — body 保持不变', () => {
			const prompt = '## Rules\n\n1. Always test\n2. Never skip lint';
			const agent = makeAgent({ systemPrompt: prompt });
			const md = buildAgentMd(agent);
			const parsed = parseAgentMd(md);
			assert.ok(parsed);
			assert.strictEqual(parsed!.systemPrompt, prompt);
		});

		test('含嵌套 handOffs 的 agent 往返', () => {
			const agent = makeAgent({
				handOffs: [
					{ targetAgentId: 'agent-b', description: 'For B tasks', condition: 'user asks B' },
				],
			});
			const md = buildAgentMd(agent);
			const parsed = parseAgentMd(md);
			assert.ok(parsed);
			assert.ok(parsed!.agent.handOffs);
			assert.strictEqual(parsed!.agent.handOffs!.length, 1);
			assert.strictEqual(parsed!.agent.handOffs![0].targetAgentId, 'agent-b');
		});
	});
});
