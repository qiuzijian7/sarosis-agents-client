/*---------------------------------------------------------------------------------------------
 *  sessionPersona 单测 —— 钉住人格表的容错解析与显示回退。
 *
 *  为什么必须有：解析失败会**静默**导致「所有会话都看不到人格标记」，
 *  这正是最难被发现的坏法（没有报错、也没有异常，只是什么都不显示）✗。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { parsePersonaMap, personaGlyphOf, personaLabelOf, personaSessionKey, writePersonaFact } from './sessionPersona.js';

suite('sessionPersona / parsePersonaMap', () => {

	test('正常表：保留 id / name，键按 agentId::sessionId 原样', () => {
		const map = parsePersonaMap('{"a::s1":{"id":"reviewer","name":"架构评审"},"a::s2":{"id":"perf"}}');
		assert.strictEqual(map.size, 2);
		assert.deepStrictEqual(map.get('a::s1'), { id: 'reviewer', name: '架构评审' });
		assert.deepStrictEqual(map.get('a::s2'), { id: 'perf', name: undefined });
	});

	test('name 为空串 / 非字符串 ⇒ 视为没有名字（回退到 id）', () => {
		const map = parsePersonaMap('{"k1":{"id":"x","name":""},"k2":{"id":"y","name":3}}');
		assert.strictEqual(map.get('k1')?.name, undefined);
		assert.strictEqual(map.get('k2')?.name, undefined);
		assert.strictEqual(personaLabelOf(map.get('k1')), 'x');
	});

	test('坏条目只丢自己，不牵连其它条目', () => {
		const map = parsePersonaMap('{"ok":{"id":"keep"},"noId":{"name":"坏"},"bad":42,"arr":[],"nul":null}');
		assert.deepStrictEqual([...map.keys()], ['ok']);
	});

	test('坏 JSON / 数组 / 空值 ⇒ 空表（侧栏不能整体空白）', () => {
		assert.strictEqual(parsePersonaMap('not json').size, 0);
		assert.strictEqual(parsePersonaMap('[{"id":"x"}]').size, 0);
		assert.strictEqual(parsePersonaMap('').size, 0);
		assert.strictEqual(parsePersonaMap(undefined).size, 0);
	});

	test('id 为空串的条目被丢弃（否则会渲染出一个没有名字的标记）', () => {
		assert.strictEqual(parsePersonaMap('{"k":{"id":""}}').size, 0);
	});
});

suite('sessionPersona / writePersonaFact（写入侧与读取侧同一份格式）', () => {

	test('写入一条：键是 agentId::sessionId，读回来一致', () => {
		const raw = writePersonaFact(undefined, personaSessionKey('saros', 'chat-1'), { id: 'reviewer', name: '架构评审' });
		assert.deepStrictEqual(parsePersonaMap(raw).get('saros::chat-1'), { id: 'reviewer', name: '架构评审' });
	});

	test('增量写：不动其它条目', () => {
		const before = '{"a::s1":{"id":"x"}}';
		const after = writePersonaFact(before, personaSessionKey('a', 's2'), { id: 'y' });
		assert.strictEqual(parsePersonaMap(after).get('a::s1')?.id, 'x');
		assert.strictEqual(parsePersonaMap(after).get('a::s2')?.id, 'y');
	});

	test('fact 缺席 ⇒ 删掉该条（= 跟随自带人设），其余保留', () => {
		const before = '{"a::s1":{"id":"x"},"a::s2":{"id":"y"}}';
		const after = writePersonaFact(before, personaSessionKey('a', 's1'), undefined);
		assert.strictEqual(parsePersonaMap(after).has('a::s1'), false);
		assert.strictEqual(parsePersonaMap(after).get('a::s2')?.id, 'y');
	});

	test('空键 / 没有 id 的事实 ⇒ 不写入（不产生没人认领的条目）', () => {
		assert.strictEqual(parsePersonaMap(writePersonaFact(undefined, '', { id: 'x' })).size, 0);
		assert.strictEqual(parsePersonaMap(writePersonaFact(undefined, 'a::s1', { id: '' })).size, 0);
	});

	test('坏表现场自愈：读不出来的条目被清掉，而不是被传播', () => {
		const after = writePersonaFact('{"bad":42,"noId":{"name":"无 id"}}', personaSessionKey('a', 's1'), { id: 'ok' });
		assert.deepStrictEqual([...parsePersonaMap(after).keys()], ['a::s1']);
	});
});

suite('sessionPersona / label & glyph', () => {

	test('显示名回退：name → id；没有事实 ⇒ 空串', () => {
		assert.strictEqual(personaLabelOf({ id: 'a', name: '  有名字  ' }), '有名字');
		assert.strictEqual(personaLabelOf({ id: 'a' }), 'a');
		assert.strictEqual(personaLabelOf(undefined), '');
	});

	test('字形回退：icon（emoji）→ 名字首字 → ?', () => {
		assert.strictEqual(personaGlyphOf('架构评审', '🧭'), '🧭');
		assert.strictEqual(personaGlyphOf('架构评审'), '架');
		assert.strictEqual(personaGlyphOf(''), '?');
		assert.strictEqual(personaGlyphOf('   ', '  '), '?');
	});

	test('非 BMP 首字不拆代理对（取的是整个字素，不是半个）', () => {
		const glyph = personaGlyphOf('𝕏-ray');
		assert.strictEqual(Array.from(glyph).length, 1);
		assert.strictEqual(glyph, '𝕏');
	});
});
