/*---------------------------------------------------------------------------------------------
 *  Unit tests for skillSourceLabel — the skill source → UI label mapping.
 *
 *  Focus: the `workflow` branch added for the "双向打通" (workflow-as-executable-skill)
 *  feature, plus full coverage of the other source kinds.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { skillSourceLabel } from '../../browser/skillSourceLabel.js';

suite('skillSourceLabel (双向打通 / workflow branch)', () => {

	const cases: Array<[Parameters<typeof skillSourceLabel>[0], string]> = [
		['builtin', '📦 内置技能'],
		['user', '📁 用户技能'],
		['marketplace', '☁️ 商城技能'],
		['extension', '🔌 扩展技能'],
		['memory', '🧠 内存技能'],
		['workflow', '⚙️ 工作流技能'],
	];

	for (const [source, expected] of cases) {
		test(`maps source='${source}' -> '${expected}'`, () => {
			assert.strictEqual(skillSourceLabel(source), expected);
		});
	}

	test('every source kind has a non-empty label (no fall-through / undefined)', () => {
		const all: Array<Parameters<typeof skillSourceLabel>[0]> = [
			'builtin', 'user', 'marketplace', 'extension', 'memory', 'workflow',
		];
		for (const s of all) {
			const label = skillSourceLabel(s);
			assert.strictEqual(typeof label, 'string', `label for '${s}' should be a string`);
			assert.ok(label.length > 0, `label for '${s}' should not be empty`);
		}
	});
});
