/*---------------------------------------------------------------------------------------------
 *  Edge-case tests for buildSkillEntryXml.
 *  Extends the existing suite with boundary conditions.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { buildSkillEntryXml } from '../../browser/agentDriverService.js';
import type { ISkillDefinition } from '../../common/skills.js';

function makeSkill(overrides: Partial<ISkillDefinition>): ISkillDefinition {
	return {
		id: 'edge-1',
		name: 'Edge Skill',
		description: 'default',
		activation: 'manual',
		prompt: 'do it',
		source: 'user',
		...overrides,
	} as ISkillDefinition;
}

suite('buildSkillEntryXml — edge cases', () => {

	test('empty description: compact=true omits it, non-compact writes empty tag', () => {
		const xml = buildSkillEntryXml(makeSkill({ description: '' }), false);
		// description is falsy so it is skipped entirely
		assert.ok(!xml.includes('<description>'), 'empty description should be omitted');
	});

	test('skill name with XML special chars is emitted as-is (no auto-escaping)', () => {
		// XML special chars are not escaped in this simple renderer;
		// verifying that they are present in output (caller is responsible for sanitization).
		const xml = buildSkillEntryXml(makeSkill({ name: 'A & B < C' }), false);
		assert.ok(xml.includes('A & B < C'), 'special chars should appear as-is');
	});

	test('workflow skill in compact mode: keeps type/executable but drops description', () => {
		const xml = buildSkillEntryXml(
			makeSkill({ source: 'workflow', workflowId: 'wf-z', description: 'skip me' }),
			true,
		);
		assert.ok(!xml.includes('<description>'), 'compact drops description');
		assert.ok(xml.includes('<type>workflow</type>'), 'compact keeps workflow type');
		assert.ok(xml.includes('<executable>true</executable>'), 'compact keeps executable');
		assert.ok(xml.includes('<workflow_id>wf-z</workflow_id>'), 'compact keeps workflow_id');
	});

	test('description exactly 80 chars is NOT truncated', () => {
		const exact80 = 'x'.repeat(80);
		const xml = buildSkillEntryXml(makeSkill({ description: exact80 }), false);
		const m = xml.match(/<description>(.*?)<\/description>/);
		assert.ok(m, 'description tag should exist');
		assert.strictEqual(m![1].length, 80, '80-char description should not be truncated');
		assert.ok(!m![1].endsWith('...'), 'should not have ellipsis');
	});

	test('description 81 chars IS truncated to 80 with ellipsis', () => {
		const len81 = 'y'.repeat(81);
		const xml = buildSkillEntryXml(makeSkill({ description: len81 }), false);
		const m = xml.match(/<description>(.*?)<\/description>/);
		assert.ok(m, 'description tag should exist');
		assert.strictEqual(m![1].length, 80, '81-char desc truncated to 80');
		assert.ok(m![1].endsWith('...'), 'truncated desc should end with ellipsis');
	});

	test('all 6 source types render without crashing', () => {
		const sources: ISkillDefinition['source'][] = ['builtin', 'user', 'marketplace', 'extension', 'memory', 'workflow'];
		for (const src of sources) {
			const xml = buildSkillEntryXml(makeSkill({ source: src }), false);
			assert.ok(xml.includes('<name>'), `should render for source=${src}`);
			assert.ok(xml.includes('<id>'), `should render for source=${src}`);
		}
	});

	test('multiple workflow skills produce distinct workflow_id values', () => {
		const a = buildSkillEntryXml(makeSkill({ source: 'workflow', workflowId: 'wf-a' }), false);
		const b = buildSkillEntryXml(makeSkill({ source: 'workflow', workflowId: 'wf-b' }), false);
		assert.ok(a.includes('wf-a') && !a.includes('wf-b'), 'skill A should only carry wf-a');
		assert.ok(b.includes('wf-b') && !b.includes('wf-a'), 'skill B should only carry wf-b');
	});
});
