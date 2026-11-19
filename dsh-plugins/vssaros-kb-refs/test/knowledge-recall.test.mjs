// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

import '../../../poc/dsh-p0/scripts/lib.mjs';
import { apply } from '../../vssaros-kb/lib/index.js';
import { NOTES_DIR, LIBRARY_DIR } from '../../vssaros-kb/lib/core/kb.js';
import { rebuildKernelCache } from '../../vssaros-kb/lib/core/kbKernelBuild.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const keyword = '量子纠缠';
const title = '量子纠缠笔记';
const bodyMarker = 'QENTANGLEMENT_SENTINEL_8274';

test('知识库文章检索与 @ 引用', async t => {
	const parent = join(repo, 'poc/dsh-p0/.out/kb-refs-regression');
	await mkdir(parent, { recursive: true });
	const fixture = await mkdtemp(join(parent, 'run-'));
	const kbRoot = join(fixture, 'vaults');
	const vaultId = '20260101000000-cccccc1';
	const vault = join(kbRoot, vaultId);
	const note = join(vault, NOTES_DIR, '物理', `${title}.md`);
	const content = `---\ntype: concept\ntags: [物理]\n---\n\n# ${title}\n\n${keyword} 是两粒子间的非定域关联。\n${bodyMarker}\n`;
	await mkdir(dirname(note), { recursive: true });
	await mkdir(join(vault, LIBRARY_DIR), { recursive: true });
	await writeFile(note, content);
	await writeFile(join(fixture, 'outside.md'), 'OUTSIDE_SENTINEL');
	await rebuildKernelCache(vault);

	const tools = new Map();
	const routes = [];
	const disposers = [];
	const services = {
		tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
		webServer: { register: route => { routes.push(route); return () => {}; } },
		connection: { requestRejection: () => undefined },
		vssarosFoundation: globalThis.__VSSAROS_FOUNDATION__,
	};
	const ctx = {
		...services,
		get: name => services[name],
		effect: fn => { const disposer = fn(); if (typeof disposer === 'function') { disposers.push(disposer); } },
		on: () => () => {},
		inject: (names, callback) => names.every(name => name in services) ? callback(ctx) : undefined,
	};
	apply(ctx, { dataRoot: fixture, kbRoot, autoReindex: false });
	const server = createServer((req, res) => {
		Promise.resolve(routes[0].handler(req, res)).catch(error => {
			res.writeHead(500, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ ok: false, error: error.message }));
		});
	});
	await new Promise(ready => server.listen(0, '127.0.0.1', ready));
	const origin = `http://127.0.0.1:${server.address().port}`;
	let source;
	let client;
	let failFetch = false;
	let failBody = false;
	let requests = 0;
	const slots = new Map();
	const dom = { documentElement: { dataset: {} } };
	const code = await readFile(join(repo, 'dsh-plugins/vssaros-kb-refs/lib/client.js'), 'utf8');
	runInNewContext(code, {
		window: { __ModuleLoader__: { load: definition => { client = definition.factory(() => undefined); } } },
		document: dom,
		URL,
		fetch: (url, options) => {
			requests++;
			if (failFetch) { return Promise.reject(new Error('offline')); }
			if (failBody && url.startsWith('/x/kb/api/doc')) { return Promise.resolve(new Response('{}', { status: 503 })); }
			return fetch(new URL(url, origin), options);
		},
	});
	let dictionaries;
	const clientCtx = {
		get: () => ({ registerSource: value => { source = value; return () => {}; } }),
		effect: fn => { const disposer = fn(); if (typeof disposer === 'function') { disposers.push(disposer); } },
		locale: { register: (_name, values) => { dictionaries = values; return () => {}; }, bind: () => key => dictionaries.zh[key] },
		slots: { inject: (_name, callback) => callback(), register: entry => { slots.set(entry.id, entry); return () => {}; } },
	};
	clientCtx.inject = (_names, callback) => callback(clientCtx);
	client.apply(clientCtx);
	const search = tools.get('kb_search');
	const read = tools.get('kb_read');
	const render = value => search.output.render({}, value).map(part => part.text).join('\n');
	const uri = pathToFileURL(note).href;
	const candidates = query => source.candidates({}, { query });

	try {
		await t.test('index 检索命中且模型回执保留可读取的 URI', async () => {
			const result = await search.execute({ query: title });
			assert.deepEqual({ mode: result.mode, count: result.count, uriVisible: render(result).includes(result.items[0].uri) }, { mode: 'index', count: 1, uriVisible: true });
		});
		await t.test('fulltext 命中正文词并返回 URI 和片段', async () => {
			const result = await search.execute({ query: bodyMarker, mode: 'fulltext' });
			assert.deepEqual({ mode: result.mode, count: result.count, uriVisible: render(result).includes(result.items[0].uri), bodyVisible: result.items[0].snippet.includes(bodyMarker) }, { mode: 'fulltext', count: 1, uriVisible: true, bodyVisible: true });
		});
		await t.test('index 零命中自动回退 fulltext', async () => {
			const result = await search.execute({ query: bodyMarker });
			assert.deepEqual({ mode: result.mode, fallback: result.fallbackFrom, count: result.count }, { mode: 'fulltext', fallback: 'index', count: 1 });
		});
		await t.test('检索 URI 可以原样交给 kb_read', async () => {
			const result = await search.execute({ query: title });
			assert.equal((await read.execute({ uri: result.items[0].uri })).content, content);
		});
		await t.test('按标签与类型过滤', async () => {
			assert.deepEqual([(await search.execute({ tag: '物理' })).count, (await search.execute({ type: 'concept' })).count, (await search.execute({ type: 'comparison' })).count], [1, 1, 0]);
		});
		await t.test('无命中和错误参数显式区分', async () => {
			assert.equal((await search.execute({ query: 'ZZZNOMATCHQ9481', mode: 'fulltext' })).count, 0);
			await assert.rejects(search.execute({ mode: 'fulltext' }), /非空的 query/);
			await assert.rejects(search.execute({ vaultId: '../../escape' }), /形态不合法/);
		});
		await t.test('kb_read 拒绝库外 URI', async () => {
			await assert.rejects(read.execute({ uri: pathToFileURL(join(fixture, 'outside.md')).href }), /拒绝读取库外文件/);
		});
		await t.test('@ 源成功注册', () => {
			assert.deepEqual([source.trigger, source.name, dom.documentElement.dataset.vssarosKbRefs], ['@', '知识库', '1']);
		});
		await t.test('仅输入 @ 即显示知识库文章，并优先于文件分组', async () => {
			const rows = await candidates('');
			assert.deepEqual([rows.length, rows[0].label, rows[0].section, source.order < 0], [1, title, '知识库文章', true]);
			const pick = source.onPick({ action: 'pick', candidate: rows[0] }).insert;
			assert.equal((await read.execute({ uri: pick.ref })).content, content);
		});
		await t.test('仅输入 @+ 也能选文章且采用附正文引用', async () => {
			const rows = await candidates('+');
			const pick = source.onPick({ action: 'pick', candidate: rows[0] }).insert;
			assert.deepEqual([rows.length, rows[0].label, pick.ref.startsWith('body:file:')], [1, title + '（附正文）', true]);
		});
		await t.test('空 @ 包含未索引的新文章，不包含目录、隐藏项或非 Markdown', async () => {
			const fresh = join(vault, NOTES_DIR, '物理', '新文章.md');
			const noise = join(vault, NOTES_DIR, '.archive');
			await mkdir(noise, { recursive: true });
			await writeFile(join(noise, 'hidden.md'), 'hidden');
			await writeFile(join(vault, NOTES_DIR, '物理', 'data.json'), '{}');
			await writeFile(fresh, '# 新文章');
			await utimes(fresh, new Date('2030-01-01'), new Date('2030-01-01'));
			const rows = await candidates('');
			assert.deepEqual(Array.from(rows, row => row.label), ['新文章', title]);
			const limited = await (await fetch(origin + '/x/kb/api/references?limit=1')).json();
			assert.deepEqual([limited.items.length, limited.totalHits, limited.items[0].title], [1, 2, '新文章']);
			await rm(fresh);
			await rm(noise, { recursive: true, force: true });
			await rm(join(vault, NOTES_DIR, '物理', 'data.json'));
		});
		await t.test('文章候选接口只读且校验 vault，旧全文接口仍拒绝空词', async () => {
			const post = await fetch(origin + '/x/kb/api/references', { method: 'POST' });
			const invalid = await fetch(origin + '/x/kb/api/references?vault=../../escape');
			const old = await fetch(origin + '/x/kb/api/search?q=');
			assert.deepEqual([post.status, invalid.status, old.status], [405, 400, 400]);
		});
		await t.test('@关键词 候选与原子引用保留原始 URI', async () => {
			const rows = await candidates(keyword);
			const pick = source.onPick({ candidate: rows[0], action: 'pick' }).insert;
			assert.deepEqual([rows.length, rows[0].label, pick.source, pick.ref, pick.clipboardText, rows[0].section, rows[0].name.includes('file:')], [1, title, '知识库', rows[0].value, rows[0].value, '知识库文章', false]);
		});
		await t.test('指针提交无需取正文并提示 kb_read', async () => {
			const before = requests;
			const text = await source.codec.serialize(uri);
			assert.deepEqual([text.includes(uri), text.includes('kb_read'), text.includes(bodyMarker), requests === before], [true, true, false, true]);
		});
		await t.test('@+关键词 标识附正文并生成提交快照', async () => {
			const rows = await candidates('+' + keyword);
			const pick = source.onPick({ candidate: rows[0], action: 'pick' }).insert;
			const text = await source.codec.serialize(pick.ref);
			assert.deepEqual([rows[0].label, pick.ref.startsWith('body:'), text.includes('提交时快照'), text.includes(content), text.includes('body:file:')], [title + '（附正文）', true, true, true, false]);
		});
		await t.test('附正文读取的是发送时内容而非选择时内容', async () => {
			const rows = await candidates('+' + keyword);
			await writeFile(note, content + '\nSEND_TIME_SENTINEL');
			assert.ok((await source.codec.serialize(rows[0].value)).includes('SEND_TIME_SENTINEL'));
			await writeFile(note, content);
		});
		await t.test('正文过长有明确截断标记', async () => {
			await writeFile(note, 'x'.repeat(40000));
			const text = await source.codec.serialize('body:' + uri);
			assert.deepEqual([text.includes('已截断'), text.includes('kb_read'), text.includes('x'.repeat(32769))], [true, true, false]);
			await writeFile(note, content);
		});
		await t.test('正文接口失败阻断序列化，不静默退为指针', async () => {
			failBody = true;
			await assert.rejects(source.codec.serialize('body:' + uri), /附正文引用拿不到正文：HTTP 503/);
			failBody = false;
		});
		await t.test('附正文模式也不能绕过路径围栏', async () => {
			await assert.rejects(source.codec.serialize('body:' + pathToFileURL(join(fixture, 'outside.md')).href), /附正文引用拿不到正文/);
		});
		await t.test('候选请求失败静默返回空，不影响其他来源', async () => {
			failFetch = true;
			assert.equal((await candidates(keyword)).length, 0);
			failFetch = false;
		});
		await t.test('聚合菜单不再挂载误导性知识库面包屑', () => {
			assert.deepEqual([source.header, source.codec.clipboardText('body:' + uri)], [undefined, uri + '（附正文）']);
		});
		await t.test('仅注册 @ 来源，不挂载输入工具栏知识库 chip 或独立浮层', () => {
			assert.equal(slots.size, 0);
			assert.equal(code.includes('data-vssaros-kb-picker-launcher'), false);
		});
		await t.test('本地化字典覆盖中英文相同键集合', () => {
			assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort());
		});
	} finally {
		for (const dispose of disposers.reverse()) { dispose(); }
		await new Promise(ready => server.close(ready));
		await rm(fixture, { recursive: true, force: true });
	}
});
