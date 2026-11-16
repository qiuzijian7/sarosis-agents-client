import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { readPreferences, updatePreferences } from '../lib/preferences.js';
import { bindFoundation } from '../lib/foundationRef.js';
import { createFoundationService } from '../../vssaros-foundation/lib/index.js';

const endpoint = 'https://market.example.test';
const fileOf = root => join(root, 'marketplace', 'preferences', createHash('sha256').update(new URL(endpoint).href).digest('hex') + '.json');
async function fixture(fn) {
	const root = await mkdtemp(join(tmpdir(), 'vssaros-market-preferences-'));
	bindFoundation(createFoundationService());
	try { await fn({ dataRoot: root, endpoint }); } finally { bindFoundation(null); await rm(root, { recursive: true, force: true }); }
}

test('默认读取不落盘，收藏/分组/皮肤可回读，默认组不能删', async () => fixture(async args => {
	assert.deepEqual(await readPreferences(args), { revision: 0, skin: 'native', groups: [{ id: 'default', name: '默认收藏', items: [] }] });
	assert.deepEqual(await readdir(args.dataRoot), []);
	let value = await updatePreferences({ ...args, expectedRevision: 0, change: { type: 'setSkin', skin: 'decorative' } });
	value = await updatePreferences({ ...args, expectedRevision: value.revision, change: { type: 'createGroup', id: 'learn', name: '学习' } });
	value = await updatePreferences({ ...args, expectedRevision: value.revision, change: { type: 'favorite', groupId: 'learn', item: 'skill:rederive', saved: true } });
	assert.deepEqual(await readPreferences(args), value);
	assert.equal(value.skin, 'decorative'); assert.deepEqual(value.groups[1].items, ['skill:rederive']);
	await assert.rejects(updatePreferences({ ...args, expectedRevision: value.revision, change: { type: 'deleteGroup', id: 'default' } }), /默认/);
}));

test('并发相同 revision 只一方写入，另一方获可恢复 current', async () => fixture(async args => {
	const results = await Promise.allSettled(['a', 'b'].map(id => updatePreferences({ ...args, expectedRevision: 0, change: { type: 'createGroup', id, name: id } })));
	assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
	const failure = results.find(r => r.status === 'rejected').reason;
	assert.equal(failure.code, 'revision-conflict'); assert.equal(failure.current.revision, 1);
	const groups = (await readPreferences(args)).groups; assert.equal(groups.length, 2);
	assert.equal((await readdir(join(args.dataRoot, 'marketplace', 'preferences'))).some(f => f.endsWith('.lock') || f.endsWith('.vssaros-tmp')), false);
}));

test('数据根与 endpoint 隔离；尾斜线规范化', async () => fixture(async args => {
	await updatePreferences({ ...args, expectedRevision: 0, change: { type: 'setSkin', skin: 'decorative' } });
	assert.equal((await readPreferences({ ...args, endpoint: endpoint + '/' })).skin, 'decorative');
	assert.equal((await readPreferences({ ...args, endpoint: 'https://other.example.test' })).skin, 'native');
	assert.equal((await readPreferences({ ...args, dataRoot: join(args.dataRoot, 'second') })).skin, 'native');
}));

test('非法字段/越界路径/超大清单/错误来源一律不覆盖', async () => fixture(async args => {
	const value = await updatePreferences({ ...args, expectedRevision: 0, change: { type: 'setSkin', skin: 'native' } });
	for (const change of [
		{ type: 'setSkin', skin: 'unknown' }, { type: 'setSkin', skin: 'native', admin: true },
		{ type: 'favorite', groupId: 'default', item: 'skill:../private', saved: true },
		{ type: 'createGroup', id: '__proto__', name: 'reserved' },
		{ type: 'createGroup', id: 'name', name: 'x'.repeat(41) },
		{ type: 'import', groups: Array.from({ length: 21 }, (_, i) => ({ id: 'g' + i, name: 'g' + i, items: [] })) },
		{ type: 'import', groups: [{ id: 'default', name: '默认收藏', items: Array.from({ length: 501 }, (_, i) => 'skill:s' + i) }] }
	]) { await assert.rejects(updatePreferences({ ...args, expectedRevision: value.revision, change })); }
	for (const url of ['file:///private', 'https://user:secret@market.example.test']) { await assert.rejects(readPreferences({ ...args, endpoint: url })); }
	assert.deepEqual(await readPreferences(args), value);
}));

test('坏 JSON 和错误结构严格报错，原文件字节不变', async () => fixture(async args => {
	await updatePreferences({ ...args, expectedRevision: 0, change: { type: 'setSkin', skin: 'decorative' } });
	for (const text of ['{broken', 'null', '{"revision":0,"skin":"native","groups":[null]}']) {
		await writeFile(fileOf(args.dataRoot), text);
		await assert.rejects(readPreferences(args));
		await assert.rejects(updatePreferences({ ...args, expectedRevision: 0, change: { type: 'setSkin', skin: 'native' } }));
		assert.equal(await readFile(fileOf(args.dataRoot), 'utf8'), text);
	}
}));

test('收藏清单合并幂等，不增重复条目，删除组不触碰资源', async () => fixture(async args => {
	const change = { type: 'import', groups: [{ id: 'learn', name: '学习', items: ['skill:rederive', 'mcp:server'] }] };
	let value = await updatePreferences({ ...args, expectedRevision: 0, change });
	const again = await updatePreferences({ ...args, expectedRevision: value.revision, change }); assert.deepEqual(again, value);
	value = await updatePreferences({ ...args, expectedRevision: value.revision, change: { type: 'renameGroup', id: 'learn', name: '研究' } });
	value = await updatePreferences({ ...args, expectedRevision: value.revision, change: { type: 'deleteGroup', id: 'learn' } });
	assert.equal(value.groups.length, 1); assert.deepEqual(await readdir(args.dataRoot), ['marketplace']);
}));

test('写失败清理独占临时文件并释放锁；缺基础服务不假装保存', async () => fixture(async args => {
	const real = createFoundationService(); let released = false;
	bindFoundation({ ...real, acquireFileLock: async (...values) => { const release = await real.acquireFileLock(...values); return async () => { released = true; await release(); }; },
		atomicWriteFile: async (file, text, options) => { await writeFile(file + '.' + process.pid + options.tmpPostfix, text); throw new Error('write-failed'); } });
	await assert.rejects(updatePreferences({ ...args, expectedRevision: 0, change: { type: 'setSkin', skin: 'decorative' } }), /write-failed/);
	assert.equal(released, true); assert.deepEqual(await readdir(join(args.dataRoot, 'marketplace', 'preferences')), []);
	bindFoundation(null); await assert.rejects(updatePreferences({ ...args, expectedRevision: 0, change: { type: 'setSkin', skin: 'decorative' } }));
}));
