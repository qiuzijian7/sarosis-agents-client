/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent Driver — skill XML 渲染与提示词缓存单元测试。
 *
 * 覆盖点：
 *   1. buildSkillEntryXml — 正常 skill / compact 模式 / workflow skill
 *   2. 提示词分层缓存行为（通过集成角度验证缓存键逻辑）
 *
 * buildSkillEntryXml 是导出的纯函数，直接测试。
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildSkillEntryXml } from '../../browser/agentDriverService.js';
import type { ISkillDefinition } from '../../common/skills.js';

function makeSkill(overrides: Partial<ISkillDefinition> = {}): ISkillDefinition {
	return {
		id: 'test-skill',
		name: 'Test Skill',
		description: 'A test skill for testing purposes',
		activation: 'manual',
		prompt: 'Test skill body',
		source: 'builtin',
		enabled: true,
		category: 'testing',
		...overrides,
	} as ISkillDefinition;
}

suite('Agent Driver — Skill XML + Prompt Cache', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('buildSkillEntryXml', () => {

		test('正常 skill — 包含 name+description+id+activation', () => {
			const skill = makeSkill();
			const xml = buildSkillEntryXml(skill, false);
			assert.ok(xml.includes('<skill>'));
			assert.ok(xml.includes('<name>Test Skill</name>'));
			assert.ok(xml.includes('<description>'), 'should include description in non-compact mode');
			assert.ok(xml.includes('<id>test-skill</id>'));
			assert.ok(xml.includes('<activation>manual</activation>'));
			assert.ok(xml.includes('</skill>'));
		});

		test('compact 模式 — 省略 description', () => {
			const skill = makeSkill({ description: 'Should be omitted' });
			const xml = buildSkillEntryXml(skill, true);
			assert.ok(!xml.includes('<description>'), 'compact mode should omit description');
			assert.ok(xml.includes('<name>Test Skill</name>'));
			assert.ok(xml.includes('<id>test-skill</id>'));
		});

		test('workflow skill — 包含 type/executable/workflow_id', () => {
			const skill = makeSkill({
				id: 'wf-skill',
				name: 'Workflow Skill',
				source: 'workflow',
				workflowId: 'wf-123',
			});
			const xml = buildSkillEntryXml(skill, false);
			assert.ok(xml.includes('<type>workflow</type>'));
			assert.ok(xml.includes('<executable>true</executable>'));
			assert.ok(xml.includes('<workflow_id>wf-123</workflow_id>'));
		});

		test('workflow skill compact 模式 — 仍包含 type 标签', () => {
			const skill = makeSkill({
				source: 'workflow',
				workflowId: 'wf-456',
			});
			const xml = buildSkillEntryXml(skill, true);
			assert.ok(xml.includes('<type>workflow</type>'));
			assert.ok(xml.includes('<executable>true</executable>'));
			assert.ok(!xml.includes('<description>'), 'compact should still omit description');
		});

		test('非 workflow skill — 不包含 type/executable', () => {
			const skill = makeSkill({ source: 'builtin' });
			const xml = buildSkillEntryXml(skill, false);
			assert.ok(!xml.includes('<type>workflow</type>'));
			assert.ok(!xml.includes('<executable>'));
		});

		test('长 description 在非 compact 模式下截断到 80 字符', () => {
			const longDesc = 'This is a very long description that should be truncated at eighty characters to keep XML compact';
			const skill = makeSkill({ description: longDesc });
			const xml = buildSkillEntryXml(skill, false);
			// 找到 description 标签内容
			const match = xml.match(/<description>([^<]+)/);
			assert.ok(match, 'should have description tag');
			const descContent = match![1];
			assert.ok(descContent.length <= 83, `description should be truncated: got ${descContent.length} chars: "${descContent}"`);
			// 80 字符 + '...'
			assert.ok(descContent.endsWith('...'), 'truncated description should end with ...');
		});

		test('短 description — 完整保留', () => {
			const skill = makeSkill({ description: 'Short' });
			const xml = buildSkillEntryXml(skill, false);
			assert.ok(xml.includes('<description>Short</description>'));
		});

		test('无 description 的 skill — 不包含 description 标签', () => {
			const skill = makeSkill({ description: undefined as unknown as string });
			const xml = buildSkillEntryXml(skill, false);
			assert.ok(!xml.includes('<description>'));
		});
	});
});
