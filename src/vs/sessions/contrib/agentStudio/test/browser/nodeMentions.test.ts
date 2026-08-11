/*---------------------------------------------------------------------------------------------
 *  Unit tests for nodeMentions — "@[node:label]" prompt reference syntax (P2).
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { resolveNodeMentions, NODE_MENTION_RE } from '../../webview/src/features/workflowEditor/comfyHost/nodeMentions.js';

const nodes = [
	{ id: 'p1', type: 'Sarosis.Prompt', data: { label: '风格提示' } },
	{ id: 'img1', type: 'Sarosis.ModelImageGen', data: { label: '参考图' } },
];

const lookup = (id: string) => {
	if (id === 'p1') { return [{ port: 'output', media: { kind: 'text', ref: 'neon cityscape' } }]; }
	if (id === 'img1') { return [{ port: 'image', media: { kind: 'image', ref: 'snap:img1:0' } }]; }
	return [];
};

suite('resolveNodeMentions', () => {

	test('replaces a text mention with the referenced snapshot text', () => {
		const r = resolveNodeMentions('make it @[node:风格提示] at night', nodes, { lookup });
		assert.strictEqual(r.text, 'make it neon cityscape at night');
		assert.deepStrictEqual(r.referenced, ['风格提示']);
		assert.deepStrictEqual(r.injected, ['neon cityscape']);
		assert.deepStrictEqual(r.images, []);
	});

	test('image mentions are collected as image refs and dropped from text', () => {
		const r = resolveNodeMentions('use @[node:参考图] as reference', nodes, { lookup });
		assert.strictEqual(r.text, 'use  as reference');
		assert.deepStrictEqual(r.images, ['snap:img1:0']);
		assert.deepStrictEqual(r.referenced, ['参考图']);
	});

	test('unresolved mentions stay in place', () => {
		const r = resolveNodeMentions('hello @[node:未知节点]', nodes, { lookup });
		assert.strictEqual(r.text, 'hello @[node:未知节点]');
		assert.deepStrictEqual(r.unresolved, ['未知节点']);
	});

	test('label matching is case-insensitive', () => {
		const r = resolveNodeMentions('@[node:风格提示]', nodes, { lookup });
		assert.strictEqual(r.text, 'neon cityscape');
	});

	test('id matching works directly', () => {
		const r = resolveNodeMentions('@[node:p1]', nodes, { lookup });
		assert.strictEqual(r.text, 'neon cityscape');
	});

	test('no mentions → text unchanged, empty results', () => {
		const r = resolveNodeMentions('plain prompt', nodes, { lookup });
		assert.strictEqual(r.text, 'plain prompt');
		assert.strictEqual(r.referenced.length, 0);
	});

	test('multiple mentions resolve in order', () => {
		const r = resolveNodeMentions('@[node:风格提示] + @[node:参考图] + done', nodes, { lookup });
		assert.strictEqual(r.text, 'neon cityscape +  + done');
		assert.deepStrictEqual(r.referenced, ['风格提示', '参考图']);
		assert.deepStrictEqual(r.injected, ['neon cityscape']);
		assert.deepStrictEqual(r.images, ['snap:img1:0']);
	});

	test('node without snapshots stays unresolved', () => {
		const r = resolveNodeMentions('@[node:风格提示]', nodes, { lookup: () => [] });
		assert.strictEqual(r.text, '@[node:风格提示]');
		assert.deepStrictEqual(r.unresolved, ['风格提示']);
	});

	test('regex matches the documented syntax', () => {
		const m = '@[node:foo]'.match(NODE_MENTION_RE);
		assert.ok(m && m.length === 1);
	});
});
