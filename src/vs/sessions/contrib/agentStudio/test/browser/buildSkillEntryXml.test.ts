/*---------------------------------------------------------------------------------------------
 *  Unit tests for buildSkillEntryXml — the <available_skills> directory renderer.
 *
 *  Focus: the "双向打通" workflow annotation added to
 *  AgentDriverService.buildSystemPrompt. Verifies that workflow-sourced skills are
 *  tagged as EXECUTABLE (not prompt-injection) and that non-workflow skills are not.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { buildSkillEntryXml } from '../../browser/agentDriverService.js';
import type { ISkillDefinition } from '../../common/skills.js';

function makeSkill(overrides: Partial<ISkillDefinition>): ISkillDefinition {
	return {
		id: 'skill-1',
		name: 'Demo Skill',
		description: 'A demo skill for testing',
		activation: 'manual',
		prompt: 'do the thing',
		source: 'user',
		...overrides,
	} as ISkillDefinition;
}

suite('buildSkillEntryXml (双向打通 / workflow annotation)', () => {

	test('non-workflow skill: no <type>/<executable>/<workflow_id> tags', () => {
		const xml = buildSkillEntryXml(makeSkill({ source: 'user' }), false);
		assert.ok(xml.includes('<name>Demo Skill</name>'), 'should render name');
		assert.ok(xml.includes('<id>skill-1</id>'), 'should render id');
		assert.ok(xml.includes('<activation>manual</activation>'), 'should render activation');
		assert.ok(xml.includes('<description>A demo skill for testing</description>'), 'should render description');
		assert.ok(!xml.includes('<type>workflow</type>'), 'user skill must NOT be tagged workflow');
		assert.ok(!xml.includes('<executable>true</executable>'), 'user skill must NOT be executable');
		assert.ok(!xml.includes('<workflow_id>'), 'user skill must NOT carry workflow_id');
	});

	test('workflow skill: emits <type>workflow</type> + <executable>true</executable> + <workflow_id>', () => {
		const xml = buildSkillEntryXml(
			makeSkill({ source: 'workflow', workflowId: 'wf-42' }),
			false,
		);
		assert.ok(xml.includes('<type>workflow</type>'), 'workflow skill must be tagged <type>workflow</type>');
		assert.ok(xml.includes('<executable>true</executable>'), 'workflow skill must be executable');
		assert.ok(xml.includes('<workflow_id>wf-42</workflow_id>'), 'workflow skill must carry its workflow_id');
		// 仍应保留基础字段
		assert.ok(xml.includes('<id>skill-1</id>'), 'should still render id');
		assert.ok(xml.includes('<activation>manual</activation>'), 'should still render activation');
	});

	test('workflow skill without workflowId: emits <type>/<executable> but no <workflow_id>', () => {
		const xml = buildSkillEntryXml(makeSkill({ source: 'workflow' }), false);
		assert.ok(xml.includes('<type>workflow</type>'), 'should be tagged workflow');
		assert.ok(xml.includes('<executable>true</executable>'), 'should be executable');
		assert.ok(!xml.includes('<workflow_id>'), 'should omit <workflow_id> when workflowId is absent');
	});

	test('compact mode: omits <description> for workflow skill but keeps type/executable', () => {
		const xml = buildSkillEntryXml(
			makeSkill({ source: 'workflow', workflowId: 'wf-7', description: 'some long description that should be skipped' }),
			true,
		);
		assert.ok(!xml.includes('<description>'), 'compact mode must omit description');
		assert.ok(xml.includes('<type>workflow</type>'), 'compact must keep workflow tag');
		assert.ok(xml.includes('<executable>true</executable>'), 'compact must keep executable tag');
		assert.ok(xml.includes('<workflow_id>wf-7</workflow_id>'), 'compact must keep workflow_id');
	});

	test('description longer than 80 chars is truncated with ellipsis', () => {
		const longDesc = 'x'.repeat(200);
		const xml = buildSkillEntryXml(makeSkill({ source: 'user', description: longDesc }), false);
		const m = xml.match(/<description>(.*?)<\/description>/);
		assert.ok(m, 'description tag should exist');
		assert.strictEqual(m![1].length, 80, 'truncated description should be exactly 80 chars');
		assert.ok(m![1].endsWith('...'), 'truncated description should end with ellipsis');
	});

	test('supportFiles: renders <support_files> in non-compact mode', () => {
		const xml = buildSkillEntryXml(
			makeSkill({ source: 'user', supportFiles: ['references/api.md', 'scripts/run.py'] }),
			false,
		);
		assert.ok(xml.includes('<support_files>references/api.md, scripts/run.py</support_files>'), 'should render support files');
	});

	test('supportFiles: omitted in compact mode', () => {
		const xml = buildSkillEntryXml(
			makeSkill({ source: 'user', supportFiles: ['references/api.md'] }),
			true,
		);
		assert.ok(!xml.includes('<support_files>'), 'compact mode must omit support_files');
	});

	test('supportFiles: more than 10 files shows truncation suffix', () => {
		const files = Array.from({ length: 13 }, (_, i) => `references/f${i}.md`);
		const xml = buildSkillEntryXml(makeSkill({ source: 'user', supportFiles: files }), false);
		assert.ok(xml.includes('references/f9.md'), 'should show first 10 files');
		assert.ok(!xml.includes('references/f10.md'), 'should not show 11th file');
		assert.ok(xml.includes('(+3 more)'), 'should render truncation suffix');
	});

	test('no supportFiles: no <support_files> tag', () => {
		const xml = buildSkillEntryXml(makeSkill({ source: 'user' }), false);
		assert.ok(!xml.includes('<support_files>'), 'must not render support_files when absent');
	});
});
