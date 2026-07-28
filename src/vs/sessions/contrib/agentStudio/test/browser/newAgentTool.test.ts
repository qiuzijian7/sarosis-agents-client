/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * new_agent 工具测试 — TDD 风格。
 *
 * 测试 handleNewAgentTool + slugifyAgentName 纯函数，验证：
 *   - Slug 化命名规则（name → slug，id 与 slug 一致，无随机后缀）
 *   - 必填字段校验
 *   - 可选字段传递
 *   - 默认值处理
 *   - 异常处理
 *   - 返回格式
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { handleNewAgentTool, slugifyAgentName } from '../../browser/providers/tool/delegationTools.js';
import type { IAgentStudioService } from '../../../../common/agentStudioService.js';
import type { Agent } from '../../../../common/agentStudioTypes.js';

// ─── Mock ────────────────────────────────────────────────────────────────────

class MockAgentStudioService implements Pick<IAgentStudioService, 'createAgent'> {
	readonly createAgentCalls: Partial<Agent>[] = [];

	async createAgent(data: Partial<Agent>): Promise<Agent> {
		this.createAgentCalls.push({ ...data });
		const now = new Date().toISOString();
		// Use the caller-provided id (slug name) rather than generating a random one
		return {
			id: data.id || `agent_${Date.now()}`,
			name: data.name || 'New Agent',
			role: data.role || 'assistant',
			description: data.description || '',
			icon: data.icon || '🤖',
			model: data.model || 'claude-sonnet-4-20250514',
			skills: data.skills || [],
			tools: data.tools,
			category: data.category || 'General',
		systemPrompt: data.systemPrompt,
		temperature: data.temperature,
		source: 'custom',
			createdAt: now,
			updatedAt: now,
		} as Agent;
	}
}

class ThrowingMockStudioService implements Pick<IAgentStudioService, 'createAgent'> {
	async createAgent(_data: Partial<Agent>): Promise<Agent> {
		throw new Error('Disk full');
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseResult(content: { type: string; text?: string }[]): any {
	assert.strictEqual(content.length, 1);
	assert.strictEqual(content[0].type, 'text');
	assert.ok(content[0].text, 'text content should not be empty');
	return JSON.parse(content[0].text!);
}

/** 原始输入（含空格和大写），用于测试 slug 化行为 */
const VALID_RAW_INPUT = {
	name: 'Code Reviewer',
	role: 'Reviewer',
	description: 'Reviews code for bugs and best practices',
};

/** slug 化后的期望名称 */
const EXPECTED_SLUG_NAME = 'code-reviewer';

// ─── Tests ────────────────────────────────────────────────────────────────────

suite('new_agent Tool', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ═══════════════════════════════════════════════════════════════════════════
	// slugifyAgentName 单元测试
	// ═══════════════════════════════════════════════════════════════════════════

	test('S1: slugifyAgentName — basic conversion', () => {
		assert.strictEqual(slugifyAgentName('Code Reviewer'), 'code-reviewer');
		assert.strictEqual(slugifyAgentName('My Coding Agent'), 'my-coding-agent');
		assert.strictEqual(slugifyAgentName('  Leading/ Trailing  '), 'leading-trailing');
	});

	test('S2: slugifyAgentName — special characters removed', () => {
		assert.strictEqual(slugifyAgentName('UI/UX Designer'), 'uiux-designer');
		assert.strictEqual(slugifyAgentName('Test@#$%Agent'), 'testagent');
		assert.strictEqual(slugifyAgentName('Hello_World'), 'hello-world');
	});

	test('S3: slugifyAgentName — dedup hyphens and trim', () => {
		assert.strictEqual(slugifyAgentName('a---b--c'), 'a-b-c');
		assert.strictEqual(slugifyAgentName('-leading-dash'), 'leading-dash');
		assert.strictEqual(slugifyAgentName('trailing-dash-'), 'trailing-dash');
	});

	test('S4: slugifyAgentName — empty / only special chars fallback', () => {
		assert.ok(slugifyAgentName('').startsWith('agent-'), 'empty input should return fallback slug');
		assert.ok(slugifyAgentName('!@#$%').startsWith('agent-'), 'special chars should return fallback slug');
		assert.ok(slugifyAgentName('   ').startsWith('agent-'), 'whitespace should return fallback slug');
	});

	test('S5: slugifyAgentName — length limit (40 chars)', () => {
		const longName = 'This Is A Very Long Agent Name That Exceeds Forty Characters Limit For Sure';
		const result = slugifyAgentName(longName);
		assert.ok(result.length <= 40);
		assert.strictEqual(result, 'this-is-a-very-long-agent-name-that-exce');
	});

	// ═══════════════════════════════════════════════════════════════════════════
	// handleNewAgentTool 核心测试
	// ═══════════════════════════════════════════════════════════════════════════

	// ── T1: 基本创建 — 仅必填字段（验证 name 保留原始输入，id 为 slug） ──
	test('T1: creates agent with original name and slug id', async () => {
		const mock = new MockAgentStudioService();
		const result = await handleNewAgentTool(VALID_RAW_INPUT, mock);

		const parsed = parseResult(result);
		assert.strictEqual(parsed.success, true);
		assert.strictEqual(parsed.id, EXPECTED_SLUG_NAME, 'id should equal slug name');
		assert.strictEqual(parsed.name, 'Code Reviewer', 'name should be original human-readable name');
	assert.strictEqual(parsed.role, 'Reviewer');

	assert.strictEqual(mock.createAgentCalls.length, 1);
		const call = mock.createAgentCalls[0];
		assert.strictEqual(call.id, EXPECTED_SLUG_NAME, 'id passed to createAgent should be slug');
		assert.strictEqual(call.name, 'Code Reviewer', 'name should be original');
		assert.strictEqual(call.role, 'Reviewer');
		assert.strictEqual(call.source, 'custom');
	});

	// ── T1.5: 验证 id 无随机后缀 ───────────────────────────────────────────
	test('T1.5: id contains no random suffix (clean slug only)', async () => {
		const mock = new MockAgentStudioService();
		const result = await handleNewAgentTool(
			{ name: 'Security Auditor', role: 'Auditor', description: 'Audits security' },
			mock,
		);

		const parsed = parseResult(result);
		assert.strictEqual(parsed.id, 'security-auditor');
		// id 不应包含随机字符串（如 x7k2m）
		assert.ok(!/-\w{5}$/.test(parsed.id), `id should not have random suffix: ${parsed.id}`);
		assert.strictEqual(mock.createAgentCalls[0].id, 'security-auditor');
	});

	// ── T1.6: 纯特殊字符 name → slug 为随机回退 id（而非失败） ──────────
	test('T1.6: generates fallback id when name slugifies to empty string', async () => {
		const mock = new MockAgentStudioService();
		const result = await handleNewAgentTool(
			{ name: '!@#$%', role: 'Tester', description: 'Test' },
			mock,
		);

		const parsed = parseResult(result);
		assert.strictEqual(parsed.success, true, 'should succeed with fallback id');
		assert.ok(parsed.id.startsWith('agent-'), `id should have fallback prefix: ${parsed.id}`);
		assert.strictEqual(parsed.name, '!@#$%', 'name should keep original input');
		assert.strictEqual(mock.createAgentCalls[0].name, '!@#$%');
	});

	// ── T2: 缺少 name ────────────────────────────────────────────────────────
	test('T2: fails when name is missing', async () => {
		const mock = new MockAgentStudioService();
		const result = await handleNewAgentTool(
			{ role: 'Developer', description: 'Writes code' },
			mock,
		);

		const parsed = parseResult(result);
		assert.strictEqual(parsed.success, false);
		assert.ok(parsed.error.toLowerCase().includes('name'));
		assert.strictEqual(mock.createAgentCalls.length, 0);
	});

	// ── T3: 缺少 role ────────────────────────────────────────────────────────
	test('T3: fails when role is missing', async () => {
		const mock = new MockAgentStudioService();
		const result = await handleNewAgentTool(
			{ name: 'Coder', description: 'Writes code' },
			mock,
		);

		const parsed = parseResult(result);
		assert.strictEqual(parsed.success, false);
		assert.ok(parsed.error.toLowerCase().includes('role'));
		assert.strictEqual(mock.createAgentCalls.length, 0);
	});

	// ── T4: 缺少 description ─────────────────────────────────────────────────
	test('T4: fails when description is missing', async () => {
		const mock = new MockAgentStudioService();
		const result = await handleNewAgentTool(
			{ name: 'Coder', role: 'Developer' },
			mock,
		);

		const parsed = parseResult(result);
		assert.strictEqual(parsed.success, false);
		assert.ok(parsed.error.toLowerCase().includes('description'));
		assert.strictEqual(mock.createAgentCalls.length, 0);
	});

	// ── T5: 带 systemPrompt（用户覆盖默认）────────────────────────────────
	test('T5: uses user-provided systemPrompt instead of default', async () => {
		const mock = new MockAgentStudioService();
		await handleNewAgentTool(
			{ ...VALID_RAW_INPUT, systemPrompt: 'You are a meticulous reviewer.' },
			mock,
		);

		assert.strictEqual(mock.createAgentCalls[0].systemPrompt, 'You are a meticulous reviewer.');
	});

	// ── T5.5: 默认 systemPrompt 自动生成 ───────────────────────────────────
	test('T5.5: auto-generates default systemPrompt from role + description', async () => {
		const mock = new MockAgentStudioService();
		await handleNewAgentTool(VALID_RAW_INPUT, mock);

		assert.strictEqual(
			mock.createAgentCalls[0].systemPrompt,
			'You are a Reviewer. Reviews code for bugs and best practices',
		);
	});

	// ── T6: 带 model ──────────────────────────────────────────────────────────
	test('T6: passes model to createAgent', async () => {
		const mock = new MockAgentStudioService();
		await handleNewAgentTool(
			{ ...VALID_RAW_INPUT, model: 'gpt-4o' },
			mock,
		);

		assert.strictEqual(mock.createAgentCalls[0].model, 'gpt-4o');
	});

	// ── T7: 带 tools 列表 ────────────────────────────────────────────────────
	test('T7: passes tools array to createAgent', async () => {
		const mock = new MockAgentStudioService();
		const tools = ['read_file', 'write_to_file', 'search_files'];
		await handleNewAgentTool({ ...VALID_RAW_INPUT, tools }, mock);

		assert.deepStrictEqual(mock.createAgentCalls[0].tools, tools);
	});

	// ── T8: 带 skills 列表 ───────────────────────────────────────────────────
	test('T8: passes skills array to createAgent', async () => {
		const mock = new MockAgentStudioService();
		const skills = ['pdf', 'xlsx'];
		await handleNewAgentTool({ ...VALID_RAW_INPUT, skills }, mock);

		assert.deepStrictEqual(mock.createAgentCalls[0].skills, skills);
	});



	// ── T11: createAgent 抛异常 ───────────────────────────────────────────────
	test('T11: returns error when createAgent throws', async () => {
		const mock = new ThrowingMockStudioService();
		const result = await handleNewAgentTool(VALID_RAW_INPUT, mock);

		const parsed = parseResult(result);
		assert.strictEqual(parsed.success, false);
		assert.ok(parsed.error.includes('Disk full'));
	});

	// ── T12: 返回格式验证 ────────────────────────────────────────────────────
	test('T12: returns valid IToolResultContent format including systemPrompt', async () => {
		const mock = new MockAgentStudioService();
		const result = await handleNewAgentTool(VALID_RAW_INPUT, mock);

		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].type, 'text');
		assert.ok(typeof result[0].text === 'string');

		const parsed = JSON.parse(result[0].text!);
		assert.ok(parsed.id, 'should have id');
		assert.ok(parsed.name, 'should have name');
		assert.ok(parsed.role, 'should have role');
		assert.strictEqual(parsed.systemPrompt, 'You are a Reviewer. Reviews code for bugs and best practices',
			'return JSON should include systemPrompt field');
		assert.ok(parsed.message, 'should have a human-readable message');
	});

	// ── T13: category 默认值 ─────────────────────────────────────────────────
	test('T13: does not pass category when not provided (service defaults to General)', async () => {
		const mock = new MockAgentStudioService();
		await handleNewAgentTool(VALID_RAW_INPUT, mock);

		assert.strictEqual(mock.createAgentCalls[0].category, undefined);
	});

	// ── T14: icon 未传时不传递 ───────────────────────────────────────────────
	test('T14: does not pass icon when not provided (service defaults to robot emoji)', async () => {
		const mock = new MockAgentStudioService();
		await handleNewAgentTool(VALID_RAW_INPUT, mock);

		assert.strictEqual(mock.createAgentCalls[0].icon, undefined);
	});

	// ── T15: 所有可选字段同时传递 ────────────────────────────────────────────
	test('T15: passes all optional fields together', async () => {
		const mock = new MockAgentStudioService();
		await handleNewAgentTool({
			...VALID_RAW_INPUT,
			systemPrompt: 'You are an expert.',
			model: 'gpt-4o',
			tools: ['read_file'],
			skills: ['pdf'],
			category: 'Testing',
		}, mock);

		const call = mock.createAgentCalls[0];
		assert.strictEqual(call.systemPrompt, 'You are an expert.');
		assert.strictEqual(call.model, 'gpt-4o');
		assert.deepStrictEqual(call.tools, ['read_file']);
		assert.deepStrictEqual(call.skills, ['pdf']);
		assert.strictEqual(call.category, 'Testing');
	});

	// ── T16: 空字符串 name 被视为缺失 ──────────────────────────────────────
	test('T16: treats empty string name as missing', async () => {
		const mock = new MockAgentStudioService();
		const result = await handleNewAgentTool(
			{ name: '', role: 'Developer', description: 'Writes code' },
			mock,
		);

		const parsed = parseResult(result);
		assert.strictEqual(parsed.success, false);
		assert.ok(parsed.error.toLowerCase().includes('name'));
		assert.strictEqual(mock.createAgentCalls.length, 0);
	});

	// ── T17: 多词 name slug 化验证 ─────────────────────────────────────────
	test('T17: slugifies id but keeps original name', async () => {
		const mock = new MockAgentStudioService();
		const result = await handleNewAgentTool(
			{ name: 'Senior Backend_Developer', role: 'Developer', description: 'Backend dev' },
			mock,
		);

		const parsed = parseResult(result);
		assert.strictEqual(parsed.name, 'Senior Backend_Developer', 'name should be original');
		assert.strictEqual(parsed.id, 'senior-backend-developer', 'id should be slugified');
		assert.strictEqual(mock.createAgentCalls[0].name, 'Senior Backend_Developer', 'name should be original');
		assert.strictEqual(mock.createAgentCalls[0].id, 'senior-backend-developer', 'id should be slugified');
	});
});
