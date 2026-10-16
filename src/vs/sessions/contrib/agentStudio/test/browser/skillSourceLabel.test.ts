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
		// 项目级（P1，2026-10-13）：工作区自带的技能，标签必须与用户技能**可区分** ——
		// 否则用户分不清"这技能是我装的还是这个仓库自带的" ✗（两个来源的覆盖语义完全不同）
		['project', '🗂️ 项目技能'],
		['user', '📁 用户技能'],
		['marketplace', '☁️ 商城技能'],
		['extension', '🔌 扩展技能'],
		// 插件自带技能（P2，2026-10-13）：来自 dsh 插件包里的 `skills/`（如 `@tt-a1i/archify-dsh`）。
		// 必须与"内置"和"扩展"都区分开：它的所有者是**插件包**（只读、随插件升级），
		// 说成内置会让人以为随产品走、说成扩展又和 extension 撞词 ✗
		['plugin', '🧩 插件技能'],
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
			'builtin', 'project', 'user', 'marketplace', 'extension', 'plugin', 'memory', 'workflow',
		];
		for (const s of all) {
			const label = skillSourceLabel(s);
			assert.strictEqual(typeof label, 'string', `label for '${s}' should be a string`);
			assert.ok(label.length > 0, `label for '${s}' should not be empty`);
		}
	});
});
