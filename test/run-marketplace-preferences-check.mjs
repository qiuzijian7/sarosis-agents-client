import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createFoundationService } from '../dsh-plugins/vssaros-foundation/lib/index.js';
import { bindFoundation } from '../dsh-plugins/vssaros-marketplace/lib/foundationRef.js';
import { readPreferences, updatePreferences } from '../dsh-plugins/vssaros-marketplace/lib/preferences.js';

const endpoint = 'https://market.example.test/api';
const defaults = () => ({ revision: 0, skin: 'native', groups: [{ id: 'default', name: '默认收藏', items: [] }] });
let dataRoot;
let service;
const options = () => ({ dataRoot, endpoint });
const file = (url = endpoint) => join(dataRoot, 'marketplace', 'preferences', createHash('sha256').update(new URL(url).href).digest('hex') + '.json');
const update = (change, expectedRevision = 0) => updatePreferences({ ...options(), expectedRevision, change });
async function missing(path) { await assert.rejects(stat(path), { code: 'ENOENT' }); }
async function seed(text) { await mkdir(dirname(file()), { recursive: true }); await writeFile(file(), text); }
async function unchanged(change, expectedRevision = 0) {
	const before = await readFile(file(), 'utf8');
	await assert.rejects(update(change, expectedRevision));
	assert.equal(await readFile(file(), 'utf8'), before);
	assert.deepEqual(await readdir(dirname(file())), [file().split(/[\\/]/).at(-1)]);
}
beforeEach(async () => {
	dataRoot = await mkdtemp(join(tmpdir(), 'marketplace-preferences-'));
	service = createFoundationService();
	bindFoundation(service);
});
afterEach(async () => { bindFoundation(null); await rm(dataRoot, { recursive: true, force: true }); });

test('missing preferences return detached defaults without creating files', async () => {
	const first = await readPreferences(options());
	assert.deepEqual(first, defaults());
	first.groups[0].items.push('agent:ignored');
	assert.deepEqual(await readPreferences(options()), defaults());
	await missing(dirname(file()));
});
test('skin persists through foundation atomic write and returns exact state', async () => {
	const result = await update({ type: 'setSkin', skin: 'decorative' });
	assert.deepEqual(result, { ...defaults(), revision: 1, skin: 'decorative' });
	assert.deepEqual(await readPreferences(options()), result);
	assert.deepEqual(JSON.parse(await readFile(file(), 'utf8')), result);
	assert.deepEqual(await readdir(dirname(file())), [file().split(/[\\/]/).at(-1)]);
});
test('endpoint and dataRoot isolate state; canonical URL hashes share a location', async () => {
	await update({ type: 'setSkin', skin: 'decorative' });
	assert.deepEqual(await readPreferences({ ...options(), endpoint: endpoint + '/other' }), defaults());
	assert.deepEqual(await readPreferences({ ...options(), dataRoot: join(dataRoot, 'other') }), defaults());
	const base = { dataRoot, endpoint: 'https://second.example.test' };
	await updatePreferences({ ...base, expectedRevision: 0, change: { type: 'setSkin', skin: 'decorative' } });
	assert.equal((await readPreferences({ ...base, endpoint: base.endpoint + '/' })).skin, 'decorative');
});
test('group lifecycle and all supported favorite kinds', async () => {
	let current = await update({ type: 'createGroup', id: 'tools', name: '工具箱' });
	current = await update({ type: 'renameGroup', id: 'tools', name: '常用工具' }, current.revision);
	for (const kind of ['agent', 'skill', 'mcp', 'workbench', 'knowledge', 'plugin']) {
		current = await update({ type: 'favorite', groupId: 'tools', item: kind + ':demo-tool', saved: true }, current.revision);
	}
	assert.equal(current.groups[1].items.length, 6);
	current = await update({ type: 'favorite', groupId: 'tools', item: 'agent:demo-tool', saved: false }, current.revision);
	assert.equal(current.groups[1].items.length, 5);
	current = await update({ type: 'deleteGroup', id: 'tools' }, current.revision);
	assert.deepEqual(current.groups, defaults().groups);
});
test('no-op operations are idempotent including revision', async () => {
	assert.deepEqual(await update({ type: 'setSkin', skin: 'native' }), defaults());
	const change = { type: 'favorite', groupId: 'default', item: 'skill:demo', saved: true };
	const current = await update(change);
	assert.deepEqual(await update(change, current.revision), current);
	await unchanged({ type: 'deleteGroup', id: 'default' }, current.revision);
});
test('concurrent writers with the same revision yield one success and one current conflict', async () => {
	const outcomes = await Promise.allSettled([
		update({ type: 'createGroup', id: 'a', name: 'A' }),
		update({ type: 'createGroup', id: 'b', name: 'B' }),
	]);
	const winners = outcomes.filter(value => value.status === 'fulfilled');
	const losers = outcomes.filter(value => value.status === 'rejected');
	assert.equal(winners.length, 1);
	assert.equal(losers.length, 1);
	assert.equal(losers[0].reason.code, 'revision-conflict');
	assert.deepEqual(losers[0].reason.current, winners[0].value);
	assert.deepEqual(await readPreferences(options()), winners[0].value);
	await unchanged({ type: 'setSkin', skin: 'decorative' }, 0);
});
test('bad JSON and invalid stored schema are never silently repaired', async () => {
	for (const text of ['{broken', JSON.stringify({ ...defaults(), extra: true }), JSON.stringify({ ...defaults(), revision: -1 }), JSON.stringify({ ...defaults(), groups: [{ id: '../bad', name: 'bad', items: [] }] })]) {
		await seed(text);
		await assert.rejects(readPreferences(options()));
		await unchanged({ type: 'setSkin', skin: 'decorative' });
	}
});
test('import merges by id or name, preserves existing groups, and is idempotent', async () => {
	let current = await update({ type: 'createGroup', id: 'tools', name: '工具' });
	const change = { type: 'import', groups: [
		{ id: 'tools', name: '异名', items: ['agent:a'] },
		{ id: 'other', name: '工具', items: ['agent:a', 'skill:b'] },
		{ id: 'fresh', name: '新组', items: ['plugin:c'] },
		{ id: 'fresh', name: '新组', items: ['plugin:c', 'mcp:d'] },
	] };
	current = await update(change, current.revision);
	assert.deepEqual(current.groups, [...defaults().groups, { id: 'tools', name: '工具', items: ['agent:a', 'skill:b'] }, { id: 'fresh', name: '新组', items: ['plugin:c', 'mcp:d'] }]);
	assert.deepEqual(await update(change, current.revision), current);
});
test('unknown fields, operations, unsafe ids, invalid names, kinds and slugs reject without writes', async () => {
	await seed(JSON.stringify(defaults()));
	for (const change of [
		{ type: 'unknown' }, { type: 'setSkin', skin: 'native', extra: true }, { type: 'setSkin', skin: 'unknown' },
		{ type: 'createGroup', id: '../bad', name: 'name' }, { type: 'createGroup', id: '__proto__', name: 'name' },
		{ type: 'createGroup', id: 'all', name: 'name' }, { type: 'createGroup', id: 'x', name: ' ' },
		{ type: 'createGroup', id: 'x', name: 'x'.repeat(41) }, { type: 'renameGroup', id: 'missing', name: 'x' },
		{ type: 'favorite', groupId: 'missing', item: 'agent:a', saved: true },
		{ type: 'favorite', groupId: 'default', item: 'workflow:a', saved: true },
		...['agent:../a', 'agent:a/b', 'agent:a:tail', 'agent:<x>', 'agent:', 'agent:a?x', 'agent:a%2fb'].map(item => ({ type: 'favorite', groupId: 'default', item, saved: true })),
		{ type: 'favorite', groupId: 'default', item: 'agent:a', saved: 'true' },
		{ type: 'import', groups: [{ id: 'x', name: 'x', items: [], extra: 1 }] },
	]) { await unchanged(change); }
});
test('expectedRevision must be a nonnegative safe integer', async () => {
	await seed(JSON.stringify(defaults()));
	for (const revision of [undefined, null, -1, 0.5, '0', NaN, Number.MAX_SAFE_INTEGER + 1]) {
		const before = await readFile(file(), 'utf8');
		await assert.rejects(updatePreferences({ ...options(), expectedRevision: revision, change: { type: 'setSkin', skin: 'decorative' } }));
		assert.equal(await readFile(file(), 'utf8'), before);
	}
});
test('reject unsafe roots and endpoints before creating any path', async () => {
	for (const input of [{ dataRoot: 'relative', endpoint }, { dataRoot, endpoint: 'file:///tmp/x' }, { dataRoot, endpoint: 'https://user:secret@example.test' }, { dataRoot, endpoint: 'not-a-url' }, { dataRoot, endpoint: '//example.test' }]) {
		await assert.rejects(readPreferences(input));
		await assert.rejects(updatePreferences({ ...input, expectedRevision: 0, change: { type: 'setSkin', skin: 'decorative' } }));
	}
	assert.deepEqual(await readdir(dataRoot), []);
});
test('enforces twenty groups, five hundred items and sixty-four KB input', async () => {
	let current = await update({ type: 'import', groups: Array.from({ length: 19 }, (_, i) => ({ id: 'g' + i, name: '组' + i, items: [] })) });
	assert.equal(current.groups.length, 20);
	await unchanged({ type: 'createGroup', id: 'overflow', name: 'overflow' }, current.revision);
	current = await update({ type: 'import', groups: [{ id: 'default', name: '默认收藏', items: Array.from({ length: 500 }, (_, i) => 'agent:item-' + i) }] }, current.revision);
	await unchanged({ type: 'favorite', groupId: 'default', item: 'skill:overflow', saved: true }, current.revision);
	const oversized = { type: 'import', groups: [{ id: 'default', name: '默认收藏', items: Array(500).fill('agent:' + 'a'.repeat(128)) }] };
	assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > 65536);
	await unchanged(oversized, current.revision);
});
test('foundation absence permits a missing-file read but rejects saving without mkdir', async () => {
	bindFoundation(null);
	assert.deepEqual(await readPreferences(options()), defaults());
	await assert.rejects(update({ type: 'setSkin', skin: 'decorative' }), /foundation|服务/);
	assert.deepEqual(await readdir(dataRoot), []);
});
test('write failure releases true foundation lock, cleans owned tmp only, and preserves target', async () => {
	await seed(JSON.stringify(defaults()));
	const foreign = file() + '.foreign.tmp';
	await writeFile(foreign, 'foreign');
	bindFoundation({ ...service, atomicWriteFile: async (target, text, opts) => {
		await writeFile(`${target}.${process.pid}${opts.tmpPostfix}`, text);
		throw new Error('simulated write failure');
	} });
	await assert.rejects(update({ type: 'setSkin', skin: 'decorative' }), /simulated write failure/);
	assert.equal(await readFile(file(), 'utf8'), JSON.stringify(defaults()));
	await missing(service.lockFileFor(file()));
	assert.equal(await readFile(foreign, 'utf8'), 'foreign');
	assert.equal((await readdir(dirname(file()))).length, 2);
	bindFoundation(service);
	assert.equal((await update({ type: 'setSkin', skin: 'decorative' })).revision, 1);
});
