/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { classify, collectResources, extractSources, main, redact } from '../scripts/resources.mjs';

const bytes = Buffer.from([0, 1, 255, 12, 83, 72]);
const digest = value => createHash('sha256').update(value).digest('hex');

async function withOut(run) {
	const root = await mkdtemp(join(tmpdir(), 'tapd-resources-'));
	try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

const response = (body, type = 'application/octet-stream', status = 200) => new Response(body, { status, headers: { 'content-type': type } });

for (const [url, kind] of [
	['https://perfdog.qq.com/case_detail/1?queryToken=test', 'perfdog'],
	['https://xperf.woa.com/charts/flame/graph?record_id=1', 'deepperf'],
	['https://crashsight.qq.com/crash-reporting/crashes/1/2/report?pid=10', 'crashsight'],
	['https://example.test/测试.utrace', 'trace'],
]) {
	test(`classify and download ${kind} binary export`, () => withOut(async out => {
		let requested;
		const report = await collectResources({ sources: [url], out, fetchImpl: async (source, options) => {
			requested = source;
			assert.equal(options.headers.authorization, undefined);
			assert.equal(options.headers.cookie, undefined);
			return response(bytes);
		} });
		assert.equal(requested, url);
		assert.equal(report.ok, true);
		assert.equal(report.items[0].kind, kind);
		assert.equal(report.items[0].sha256, digest(bytes));
		assert.deepEqual(await readFile(report.items[0].file), bytes);
		assert.equal(JSON.parse(await readFile(report.manifest, 'utf8')).ok, true);
	}));
}

test('extract rich text, comments, attachments and literal Chinese path without decoding URL parameters', () => {
	const url = 'https://xperf.woa.com/charts/flame/graph?record_id=4768&geometry=%257B%2522type%2522%257D&selected_frames=1';
	const trace = 'P:\\1性能相关文件\\Trace文件\\7.23多人\\2060+8700-限100帧\\2x2 BR';
	assert.deepEqual(extractSources({ description: `<a href="${url.replaceAll('&', '&amp;')}">火焰图</a><br>${trace}<br>`,
		comments: [{ description: url }], attachments: [{ download_url: 'https://files.test/a.zip' }] }), [url, trace, 'https://files.test/a.zip']);
});

test('redact sharing and authentication secrets without changing identifiers', () => {
	const value = redact('https://perfdog.qq.com/case_detail/1?queryToken=DO_NOT_LOG&record_id=2');
	assert.ok(!value.includes('DO_NOT_LOG'));
	assert.ok(value.includes('record_id=2'));
	assert.equal(redact('https://std.passport.woa.com/login?url=secret&state=secret'), 'https://std.passport.woa.com/login');
});

for (const body of ['<!doctype html><html>OA登录</html>', '<html>SPA shell</html>']) {
	test(`reject HTML even when mislabeled as binary: ${body.slice(0, 15)}`, () => withOut(async out => {
		const report = await collectResources({ sources: ['https://example.test/data.zip'], out, fetchImpl: async () => response(body) });
		assert.equal(report.ok, false);
		assert.equal(report.items[0].status, 'blocked');
		assert.equal(report.items[0].file, undefined);
		assert.deepEqual(await readdir(join(out, 'attachments')), []);
	}));
}

test('reject HTML content type and final OA redirect', () => withOut(async out => {
	const html = await collectResources({ sources: ['https://example.test/export'], out, fetchImpl: async () => response('shell', 'text/html') });
	const redirect = await collectResources({ sources: ['https://xperf.woa.com/export'], out, fetchImpl: async () => {
		const res = response('login');
		Object.defineProperty(res, 'url', { value: 'https://std.passport.woa.com/login?state=secret' });
		return res;
	} });
	assert.equal(html.items[0].status, 'blocked');
	assert.equal(redirect.items[0].status, 'blocked');
	assert.ok(!JSON.stringify(redirect).includes('state=secret'));
}));

for (const status of [401, 403, 404, 500]) {
	test(`HTTP ${status} is never successful`, () => withOut(async out => {
		const report = await collectResources({ sources: ['https://example.test/file'], out, fetchImpl: async () => response('error', 'text/plain', status) });
		assert.equal(report.ok, false);
		assert.equal(report.items[0].status, [401, 403].includes(status) ? 'blocked' : 'failed');
	}));
}

for (const body of ['', '{}', '[]', '{"ok":false}', '{"code":401}', '{invalid']) {
	test(`reject empty or invalid/error content: ${body}`, () => withOut(async out => {
		const report = await collectResources({ sources: ['https://example.test/data.json'], out, fetchImpl: async () => response(body, 'application/json') });
		assert.equal(report.ok, false);
		assert.equal(report.items[0].status, 'failed');
	}));
}

test('timestamped log is not mistaken for invalid JSON', () => withOut(async out => {
	const log = '[2026-11-18 19:44:00] Trace captured';
	const report = await collectResources({ sources: ['https://example.test/game.log'], out, fetchImpl: async () => response(log, 'text/plain') });
	assert.equal(report.ok, true);
	assert.equal(await readFile(report.items[0].file, 'utf8'), log);
}));

for (const body of ['{"data":[]}', '{"code":"401"}']) {
	test(`reject empty business data or string error code: ${body}`, () => withOut(async out => {
		const report = await collectResources({ sources: ['https://example.test/file'], out, fetchImpl: async () => response(body, 'application/json') });
		assert.equal(report.ok, false);
	}));
}

test('valid exported JSON parses and preserves frame context', () => withOut(async out => {
	const report = await collectResources({ sources: ['https://xperf.woa.com/data?record_id=4768&selected_frames=1'], out,
		fetchImpl: async () => response('{"record_id":4768,"frames":[1884]}', 'application/json') });
	assert.equal(report.ok, true);
	assert.ok(report.items[0].source.includes('selected_frames=1'));
	assert.ok(report.items[0].verification.includes('JSON parsed'));
}));

test('UTF-8 BOM JSON export is validated without modifying bytes', () => withOut(async out => {
	const body = '\uFEFF{"frames":[1884]}';
	const report = await collectResources({ sources: ['https://xperf.woa.com/export.json'], out, fetchImpl: async () => response(body, 'application/json') });
	assert.equal(report.ok, true);
	assert.equal(await readFile(report.items[0].file, 'utf8'), body);
}));

test('streaming limit removes partial output', () => withOut(async out => {
	const report = await collectResources({ sources: ['https://example.test/file'], out, maxBytes: 2, fetchImpl: async () => response(bytes) });
	assert.equal(report.ok, false);
	assert.deepEqual(await readdir(join(out, 'attachments')), []);
}));

test('a stream failure is not successful and later resources still download', () => withOut(async out => {
	const report = await collectResources({ sources: ['https://example.test/broken', 'https://example.test/working'], out, fetchImpl: async url => {
		if (url.endsWith('working')) { return response(bytes); }
		return response(new ReadableStream({ start(controller) { controller.error(new Error('interrupted')); } }));
	} });
	assert.equal(report.ok, false);
	assert.deepEqual(report.items.map(item => item.status), ['failed', 'success']);
	assert.ok(!(await readdir(join(out, 'attachments'))).some(name => name.endsWith('.part')));
}));

test('same basenames and repeated invocations never overwrite evidence', () => withOut(async out => {
	const sources = ['https://a.test/data.bin', 'https://b.test/data.bin'];
	const first = await collectResources({ sources, out, fetchImpl: async () => response(bytes) });
	const second = await collectResources({ sources, out, fetchImpl: async () => response(bytes) });
	assert.equal(new Set([...first.items, ...second.items].map(item => item.file)).size, 4);
	assert.notEqual(first.manifest, second.manifest);
}));

test('copy Chinese directory with spaces and verify every file hash', () => withOut(async root => {
	const source = join(root, '2060+8700-限100帧', '2x2 BR');
	await mkdir(join(source, '子目录'), { recursive: true });
	await writeFile(join(source, '测试.utrace'), bytes);
	await writeFile(join(source, '子目录', '日志.txt'), '测试日志');
	const report = await collectResources({ sources: [source], out: join(root, 'local') });
	assert.equal(report.ok, true);
	assert.equal(report.items[0].fileCount, 2);
	for (const file of report.items[0].files) { assert.equal(file.sha256, digest(await readFile(file.file))); }
	assert.deepEqual(await readFile(join(source, '测试.utrace')), bytes);
}));

test('missing path is blocked, empty directory fails, and directory size limit blocks', () => withOut(async root => {
	const empty = join(root, 'empty');
	await mkdir(empty);
	const report = await collectResources({ sources: [join(root, 'missing'), empty], out: join(root, 'local') });
	assert.deepEqual(report.items.map(item => item.status), ['blocked', 'failed']);
	await writeFile(join(empty, 'file'), bytes);
	const limited = await collectResources({ sources: [empty], out: join(root, 'limited'), maxBytes: 2 });
	assert.equal(limited.items[0].status, 'blocked');
}));

test('reject destination inside source and symlinks', () => withOut(async root => {
	const source = join(root, 'source');
	await mkdir(source);
	await writeFile(join(source, 'data'), bytes);
	const nested = await collectResources({ sources: [source], out: join(source, 'out') });
	assert.equal(nested.ok, false);
	await symlink(source, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
	const linked = await collectResources({ sources: [join(root, 'link')], out: join(root, 'local') });
	assert.equal(linked.items[0].status, 'blocked');
}));

test('dry-run and an empty collection cannot report downloaded resources', () => withOut(async out => {
	const report = await collectResources({ sources: ['https://example.test/file'], out, dryRun: true, fetchImpl: () => { throw new Error('must not fetch'); } });
	assert.equal(report.ok, false);
	assert.equal(report.items[0].bytes, 0);
	assert.deepEqual(await readdir(out), []);
	assert.equal((await collectResources({ out })).ok, false);
}));

test('CLI accepts bug JSON and rejects no sources or invalid options', () => withOut(async root => {
	const input = join(root, 'bug.json');
	await writeFile(input, JSON.stringify({ description: 'https://example.test/file?queryToken=secret' }));
	const report = await main(['--input', input, '--out', root, '--dry-run']);
	assert.equal(report.items.length, 1);
	assert.ok(!JSON.stringify(report).includes('queryToken=secret'));
	await assert.rejects(main([]), /未发现资源/);
	await assert.rejects(main(['--url']), /缺少参数/);
	await assert.rejects(collectResources({ maxBytes: -1 }), /正整数/);
}));

test('real local HTTP download, redirect, binary hash and 200 login rejection', () => withOut(async out => {
	const server = createServer((request, res) => {
		if (request.url === '/redirect') { res.writeHead(302, { location: '/data' }); res.end(); }
		else if (request.url === '/data') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(bytes); }
		else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>Login</html>'); }
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	try {
		const base = `http://127.0.0.1:${server.address().port}`;
		const report = await collectResources({ sources: [`${base}/redirect`, `${base}/login`], out });
		assert.deepEqual(report.items.map(item => item.status), ['success', 'blocked']);
		assert.equal(report.items[0].sha256, digest(bytes));
		assert.equal(report.items[0].finalUrl, `${base}/data`);
	} finally { await new Promise(resolve => server.close(resolve)); }
}));
