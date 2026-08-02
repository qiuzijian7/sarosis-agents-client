/*---------------------------------------------------------------------------------------------
 *  Skill ID 计算（common/skillId.ts）— 单测
 *
 *  覆盖（对齐 Hermes-Agent 身份模型）：
 *  - slugifySkillId：slug 规则稳定性（大小写/空白/非法字符/连字符折叠/下划线保留）
 *  - isValidSkillId：显式 id 合法性（拦截路径穿越、大写、前导数字、空串）
 *  - resolveSkillId：显式 id 权威优先 + 非法显式 id 回退 slug
 *  - ensureNonEmptySkillId：空 slug 确定性哈希兜底
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	ensureNonEmptySkillId,
	isValidSkillId,
	resolveSkillId,
	slugifySkillId,
} from '../../common/skillId.js';

suite('Skill — skillId', () => {

	suite('slugifySkillId', () => {

		test('小写化 + 空白转连字符', () => {
			assert.strictEqual(slugifySkillId('My Skill'), 'my-skill');
			assert.strictEqual(slugifySkillId('Code  Review'), 'code-review');
		});

		test('移除非 [a-z0-9_-] 字符', () => {
			assert.strictEqual(slugifySkillId('My Skill!'), 'my-skill');
			assert.strictEqual(slugifySkillId('My Skill?'), 'my-skill');
			assert.strictEqual(slugifySkillId('a.b/c\\d'), 'abcd');
		});

		test('保留下划线（与 registry 历史规则一致，勿改）', () => {
			assert.strictEqual(slugifySkillId('my_skill'), 'my_skill');
		});

		test('折叠连续连字符', () => {
			assert.strictEqual(slugifySkillId('a - - b'), 'a-b');
		});

		test('trim 首尾空白', () => {
			assert.strictEqual(slugifySkillId('  padded  '), 'padded');
		});

		test('纯非 ASCII 名产出空串（调用方需兜底）', () => {
			assert.strictEqual(slugifySkillId('代码审查'), '');
		});
	});

	suite('isValidSkillId', () => {

		test('合法 id', () => {
			assert.ok(isValidSkillId('my-skill'));
			assert.ok(isValidSkillId('my_skill-2'));
			assert.ok(isValidSkillId('a'));
		});

		test('拦截路径穿越与危险字符', () => {
			assert.ok(!isValidSkillId('../evil'));
			assert.ok(!isValidSkillId('a/b'));
			assert.ok(!isValidSkillId('a\\b'));
		});

		test('拒绝大写 / 前导数字 / 前导连字符 / 空串', () => {
			assert.ok(!isValidSkillId('My-Skill'));
			assert.ok(!isValidSkillId('2cool'));
			assert.ok(!isValidSkillId('-lead'));
			assert.ok(!isValidSkillId(''));
		});
	});

	suite('resolveSkillId', () => {

		test('显式 id 合法时优先（权威键，对齐 Hermes identifier）', () => {
			assert.strictEqual(resolveSkillId('logger-a', 'Logger'), 'logger-a');
			// 同名技能可显式赋不同 id 共存
			assert.strictEqual(resolveSkillId('logger-b', 'Logger'), 'logger-b');
		});

		test('显式 id 归一化：trim + 小写', () => {
			assert.strictEqual(resolveSkillId('  My-Skill  ', 'whatever'), 'my-skill');
		});

		test('显式 id 非法时回退 name slug', () => {
			assert.strictEqual(resolveSkillId('../evil', 'My Skill'), 'my-skill');
			assert.strictEqual(resolveSkillId('2bad', 'My Skill'), 'my-skill');
		});

		test('无显式 id 时走 name slug', () => {
			assert.strictEqual(resolveSkillId(undefined, 'My Skill'), 'my-skill');
		});
	});

	suite('ensureNonEmptySkillId', () => {

		test('非空 id 原样通过', () => {
			assert.strictEqual(ensureNonEmptySkillId('my-skill', 'seed'), 'my-skill');
		});

		test('空 id 产出确定性 skill-<hash8> 兜底', () => {
			const a = ensureNonEmptySkillId('', '/some/dir::代码审查');
			const b = ensureNonEmptySkillId('', '/some/dir::代码审查');
			assert.strictEqual(a, b);
			assert.ok(/^skill-[0-9a-f]{8}$/.test(a));
		});

		test('不同种子产出不同兜底 id', () => {
			assert.notStrictEqual(
				ensureNonEmptySkillId('', '/dir/a::x'),
				ensureNonEmptySkillId('', '/dir/b::x'),
			);
		});
	});
});
