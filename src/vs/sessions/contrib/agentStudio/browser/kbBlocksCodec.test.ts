/*---------------------------------------------------------------------------------------------
 *  Unit tests for the `.bsdoc` sidecar codec used by KbBlocksEditorPane.
 *
 *  Run with:  node src/vs/sessions/contrib/agentStudio/browser/run-kbblockscodec-tests.mjs
 *  (bundles kbBlocksCodec.ts + this file via esbuild, then executes under node:test)
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashMd, parseBsdoc, makeBsdocEnvelope, sidecarPath, serializeBacklinks } from './kbBlocksCodec.js';

test('hashMd: deterministic and stable for identical input', () => {
	const a = hashMd('# Hello\nworld');
	const b = hashMd('# Hello\nworld');
	assert.strictEqual(a, b);
	assert.match(a, /^[0-9a-f]+$/);
});

test('hashMd: differs for different content', () => {
	assert.notStrictEqual(hashMd('alpha'), hashMd('beta'));
});

test('hashMd: empty string has a stable non-empty hash', () => {
	assert.strictEqual(hashMd(''), hashMd(''));
	assert.notStrictEqual(hashMd(''), '');
});

test('parseBsdoc: reads envelope (snapshot + srcHash, legacy=false)', () => {
	const raw = JSON.stringify({ v: 1, srcHash: 'abcd', snapshot: 'c2hvcHQ=' });
	const p = parseBsdoc(raw);
	assert.strictEqual(p.legacy, false);
	assert.strictEqual(p.snapshot, 'c2hvcHQ=');
	assert.strictEqual(p.srcHash, 'abcd');
});

test('parseBsdoc: tolerates legacy raw-base64 sidecar (legacy=true)', () => {
	const p = parseBsdoc('  c2hvcHQ=  ');
	assert.strictEqual(p.legacy, true);
	assert.strictEqual(p.snapshot, 'c2hvcHQ=');
	assert.strictEqual(p.srcHash, undefined);
});

test('parseBsdoc: malformed JSON falls back to legacy base64', () => {
	const p = parseBsdoc('{not valid json but not starting with brace?');
	assert.strictEqual(p.legacy, true);
	assert.strictEqual(p.snapshot, '{not valid json but not starting with brace?');
});

test('makeBsdocEnvelope + parseBsdoc: round-trips', () => {
	const env = makeBsdocEnvelope('snapshotBase64', 'deadbeef');
	const parsed = parseBsdoc(env);
	assert.strictEqual(parsed.legacy, false);
	assert.strictEqual(parsed.snapshot, 'snapshotBase64');
	assert.strictEqual(parsed.srcHash, 'deadbeef');
	const reParsed = JSON.parse(env) as { v: number };
	assert.strictEqual(reParsed.v, 1);
});

test('sidecarPath: appends .bsdoc to any note path', () => {
	assert.strictEqual(sidecarPath('/a/b/note.md'), '/a/b/note.md.bsdoc');
	assert.strictEqual(sidecarPath('note.md'), 'note.md.bsdoc');
});

test('serializeBacklinks: flattens URIs to strings (ref + mention)', () => {
	const fakeUri = { toString: () => 'file:///vault/notes/other.md' };
	const result = serializeBacklinks({
		backlinks: [
			{ uri: fakeUri, name: 'other.md', snippet: 'see [[note]]', type: 'ref' },
			{ uri: 'file:///vault/notes/third.md', name: 'third.md', snippet: 'link', type: 'mention' },
		],
		backmentions: [{ uri: fakeUri, name: 'other.md', snippet: 'mention text' }],
	});
	assert.strictEqual(result.backlinks.length, 2);
	assert.strictEqual(result.backlinks[0].uri, 'file:///vault/notes/other.md');
	assert.strictEqual(result.backlinks[0].type, 'ref');
	assert.strictEqual(result.backlinks[1].type, 'mention');
	assert.strictEqual(result.backmentions.length, 1);
	assert.strictEqual(result.backmentions[0].uri, 'file:///vault/notes/other.md');
});

test('serializeBacklinks: tolerates empty / missing result', () => {
	const empty = serializeBacklinks({ backlinks: [], backmentions: [] });
	assert.deepStrictEqual(empty, { backlinks: [], backmentions: [] });
	const undef = serializeBacklinks(undefined as never);
	assert.deepStrictEqual(undef, { backlinks: [], backmentions: [] });
});

test('serializeBacklinks: defaults missing type to ref', () => {
	const result = serializeBacklinks({ backlinks: [{ uri: 'x', name: 'n', snippet: 's' }], backmentions: [] });
	assert.strictEqual(result.backlinks[0].type, 'ref');
});
