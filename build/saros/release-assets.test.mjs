/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import policy from './pack-policy.cjs';
import links from './release-links.cjs';
import { trustedDownloadBase, validateUploadResponse, validateUploadReport, recordUpload, completeUpload, probeArchive, invalidateUpload } from './release-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = 'https://downloads.example';
const REPORT_PATH = '.build/pack-reports/uploads.json';
const installer = {
	schemaVersion: 1, commit: 'a'.repeat(40), productVersion: '2.2.26241', mode: 'standard', target: 'both',
	artifacts: policy.WINDOWS_ASSETS.map(asset => ({ ...asset, size: 11 * 1048576, sha256: asset.target === 'user' ? 'b'.repeat(64) : 'c'.repeat(64) })),
};

function receipt(artifact = installer.artifacts[0], base = BASE, report = installer) {
	const name = artifact.target === 'user' ? 'VsSarosUserSetup.exe' : 'VsSarosisSetup.exe';
	return { ok: true, platform: artifact.platform, version: report.commit, productVersion: report.productVersion,
		size: artifact.size, sha256hash: artifact.sha256,
		url: `${base}/downloads/${name}`,
		archive: `${base}/downloads/archive/${report.productVersion}--${artifact.platform}--${artifact.sha256}/${name}` };
}

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saros-release-assets-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

function assertOrdered(source, first, second, message = 'required tokens are missing or out of order') {
	const a = source.indexOf(first);
	const b = source.indexOf(second);
	assert.ok(a >= 0 && b >= 0 && a < b, `${message}: ${first}@${a}, ${second}@${b}`);
}

async function serve(t, handler) {
	const server = http.createServer(handler);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
	return `http://127.0.0.1:${server.address().port}`;
}

test('trusted origins reject credentials/paths and allow explicit public download host', () => {
	assert.equal(trustedDownloadBase('http://internal.example:3030', {}), 'http://internal.example:3030');
	assert.equal(trustedDownloadBase('http://internal.example:3030', { SAROS_RELEASE_DOWNLOAD_BASE_URL: BASE }), BASE);
	for (const base of ['file:///tmp', 'https://user:secret@downloads.example', `${BASE}/prefix`, `${BASE}?token=secret`]) {
		assert.throws(() => trustedDownloadBase(base, {}));
	}
});

test('upload receipt must match platform/commit/version/size/hash and immutable archive', () => {
	const original = receipt();
	assert.equal(validateUploadResponse(original, installer, original.platform, BASE).name, 'VsSarosUserSetup.exe');
	const system = receipt(installer.artifacts[1]);
	assert.equal(validateUploadResponse(system, installer, system.platform, BASE).name, 'VsSarosSetup.exe');
	for (const patch of [{ ok: false }, { platform: 'wrong' }, { version: 'd'.repeat(40) }, { productVersion: 'other' }, { size: 0 }, { size: original.size + 1 }, { sha256hash: '0'.repeat(64) }]) {
		assert.throws(() => validateUploadResponse({ ...original, ...patch }, installer, original.platform, BASE), /does not match/);
	}
	for (const archive of [null, '', original.url]) {
		assert.throws(() => validateUploadResponse({ ...original, archive }, installer, original.platform, BASE), /archive|path/);
	}
	for (const archive of [original.archive.replace(BASE, 'https://evil.example'), original.archive + '?token=x', original.archive + '#x', original.archive.replace('2.2.26241--', '2.2.1--'), original.archive.replace('/VsSarosUserSetup.exe', '/other.exe')]) {
		assert.throws(() => validateUploadResponse({ ...original, archive }, installer, original.platform, BASE), /origin|path/);
	}
});

test('partial/old/mode-changed/duplicated reports cannot become complete Release assets', async t => {
	const root = fixture(t);
	const first = recordUpload(root, installer, installer.artifacts[0].platform, receipt(), BASE);
	assert.throws(() => validateUploadReport(first, installer, BASE), /incomplete/);
	await assert.rejects(completeUpload(root, installer, BASE, async () => {}), /missing selected/);
	const second = recordUpload(root, installer, installer.artifacts[1].platform, receipt(installer.artifacts[1]), BASE);
	for (const patch of [{ mode: 'offline' }, { target: 'user' }, { commit: 'd'.repeat(40) }, { productVersion: 'other' }, { artifacts: [second.artifacts[0], second.artifacts[0]] }]) {
		assert.throws(() => validateUploadReport({ ...second, ready: true, ...patch }, installer, BASE));
	}
	let count = 0;
	await completeUpload(root, installer, BASE, async () => { count++; });
	assert.equal(count, 2);
	const ready = JSON.parse(fs.readFileSync(path.join(root, REPORT_PATH), 'utf8'));
	assert.equal(validateUploadReport(ready, installer, BASE).length, 2);
	assert.throws(() => recordUpload(root, installer, installer.artifacts[0].platform, { ...receipt(), archive: null }, BASE), /no immutable/);
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, REPORT_PATH), 'utf8')).ready, false);
	invalidateUpload(root);
	assert.equal(fs.existsSync(path.join(root, REPORT_PATH)), false);
});

test('failed archive probing invalidates an earlier successful receipt', async t => {
	const root = fixture(t);
	for (const artifact of installer.artifacts) { recordUpload(root, installer, artifact.platform, receipt(artifact), BASE); }
	await completeUpload(root, installer, BASE, async () => {});
	await assert.rejects(completeUpload(root, installer, BASE, async () => { throw new Error('archive missing'); }), /archive missing/);
	assert.equal(JSON.parse(fs.readFileSync(path.join(root, REPORT_PATH), 'utf8')).ready, false);
});

test('archive probes use one-byte range, no auth, no redirects/full downloads', async t => {
	const base = await serve(t, (req, res) => {
		assert.equal(req.headers.range, 'bytes=0-0');
		assert.equal(req.headers.authorization, undefined);
		assert.equal(req.headers['x-upload-token'], undefined);
		if (req.url === '/good') { res.writeHead(206, { 'Content-Length': '1', 'Content-Range': 'bytes 0-0/1000' }); res.end('M'); }
		else if (req.url === '/wrong-size') { res.writeHead(206, { 'Content-Length': '1', 'Content-Range': 'bytes 0-0/999' }); res.end('M'); }
		else if (req.url === '/redirect') { res.writeHead(302, { Location: '/good' }); res.end(); }
		else if (req.url === '/stall') { res.writeHead(206, { 'Content-Length': '1', 'Content-Range': 'bytes 0-0/1000' }); res.flushHeaders(); }
		else { res.writeHead(200, { 'Content-Length': '1000' }); res.end('X'.repeat(1000)); }
	});
	await probeArchive({ url: base + '/good', size: 1000 });
	for (const route of ['/wrong-size', '/redirect', '/full']) { await assert.rejects(probeArchive({ url: base + route, size: 1000 }), /probe failed/); }
	await assert.rejects(probeArchive({ url: base + '/stall', size: 1000 }, { timeoutMs: 50 }), /timed out|aborted/);
});

function gitlabFake({ byTag = false, failWrites = false, ignoreWrites = false } = {}) {
	let entries = [];
	const calls = [];
	const curl = (method, url, options) => {
		calls.push({ method, url, json: options.json });
		if (byTag && url.includes('/releases/42/')) { return { status: 404 }; }
		if (method === 'GET') { return { status: 200, data: entries.map(item => ({ ...item })) }; }
		if (failWrites) { return { status: 401, data: { message: 'Unauthorized' } }; }
		if (!ignoreWrites) {
			if (method === 'PUT') { const id = Number(url.split('/').at(-1)); entries = entries.map(item => item.id === id ? { ...item, ...options.json } : item); }
			else { entries.push({ id: entries.length + 1, ...options.json }); }
		}
		return { status: method === 'PUT' ? 200 : 201 };
	};
	return { curl, calls, set: value => { entries = value; }, get: () => entries };
}
const LINK_OPTIONS = { api: 'https://gitlab.example/api', project: '1', releaseId: 42, tag: 'v2.2.26241', headers: {} };
const desired = [{ name: 'VsSarosUserSetup.exe', url: 'https://downloads.example/archive/user' }, { name: 'VsSarosSetup.exe', url: 'https://downloads.example/archive/system' }];

test('both repositories create asset links, update same-name stale URL, and reruns are idempotent', () => {
	for (const project of ['1790708', '1764429']) {
		const fake = gitlabFake();
		fake.set([{ id: 7, name: desired[0].name, url: 'https://old.example/uploads/file' }]);
		links.ensureReleaseLinks(fake.curl, { ...LINK_OPTIONS, project }, desired);
		assert.equal(fake.get().find(item => item.id === 7).url, desired[0].url);
		assert.ok(fake.calls.some(call => call.method === 'PUT'));
		assert.ok(fake.calls.some(call => call.method === 'POST'));
		const written = fake.calls.filter(call => call.method !== 'GET').length;
		links.ensureReleaseLinks(fake.curl, { ...LINK_OPTIONS, project }, desired);
		assert.equal(fake.calls.filter(call => call.method !== 'GET').length, written);
	}
});

test('woa id/tag fallback works for GET/POST/PUT and verifies exact names and URLs', () => {
	const fake = gitlabFake({ byTag: true });
	fake.set([{ id: 7, name: desired[0].name, url: 'https://old.example/file' }]);
	links.ensureReleaseLinks(fake.curl, LINK_OPTIONS, desired);
	for (const method of ['GET', 'PUT', 'POST']) { assert.ok(fake.calls.some(call => call.method === method && call.url.includes(`/releases/${LINK_OPTIONS.tag}/`))); }
	assert.throws(() => links.assertExpectedLinks({}, desired), /array/);
	assert.throws(() => links.assertExpectedLinks([{ ...desired[0], url: 'wrong' }, desired[1]], desired), /wrong URL/);
	assert.throws(() => links.assertExpectedLinks([desired[0], desired[0], desired[1]], desired), /duplicated/);
});

test('failed or ignored remote writes never pass Release verification', () => {
	assert.throws(() => links.ensureReleaseLinks(gitlabFake({ failWrites: true }).curl, LINK_OPTIONS, desired), /HTTP 401/);
	assert.throws(() => links.ensureReleaseLinks(gitlabFake({ ignoreWrites: true }).curl, LINK_OPTIONS, desired), /missing/);
	assert.throws(() => links.ensureReleaseLinks(gitlabFake().curl, LINK_OPTIONS, []), /nonempty/);
});

test('real update server archives upload once and immutable URL survives latest replacement', async t => {
	const root = fixture(t);
	const reservation = http.createServer();
	reservation.listen(0, '127.0.0.1');
	await once(reservation, 'listening');
	const port = reservation.address().port;
	await new Promise(resolve => reservation.close(resolve));
	const base = `http://127.0.0.1:${port}`;
	const child = spawn(process.execPath, [path.join(ROOT, 'deploy-package/update-server/server.mjs')], {
		env: { ...process.env, PORT: String(port), GH_REPO: '', PUBLIC_BASE_URL: base,
			MANIFEST_PATH: path.join(root, 'manifest.json'), VERSIONS_PATH: path.join(root, 'versions.json'), DOWNLOADS_DIR: path.join(root, 'downloads'),
			ARCHIVE_DIR: path.join(root, 'downloads/archive'), ARCHIVE_ENABLED: '1', UPLOAD_TOKEN: 'test-only', MAX_DOWNLOAD_SIZE: '2147483648', MAX_UPLOAD_SIZE: '2147483648' }, stdio: ['ignore', 'pipe', 'pipe'],
	});
	child.stdout?.resume();
	child.stderr?.resume();
	child.on('error', () => {});
	const closed = new Promise(resolve => child.once('close', resolve));
	t.after(async () => {
		if (child.exitCode === null) { child.kill(); }
		child.stdout?.destroy();
		child.stderr?.destroy();
		await closed;
	});
	let started = false;
	for (let i = 0; i < 100; i++) {
		try { const health = await fetch(base + '/health', { signal: AbortSignal.timeout(500) }); if (health.ok) { started = true; break; } } catch { /* starting */ }
		await delay(30);
	}
	assert.equal(started, true);
	const payload = Buffer.alloc(10 * 1048576, 1);
	const artifact = { ...installer.artifacts[0], size: payload.length, sha256: crypto.createHash('sha256').update(payload).digest('hex') };
	const single = { ...installer, target: 'user', artifacts: [artifact] };
	const uploadUrl = base + `/admin/upload?platform=${artifact.platform}&commit=${single.commit}&productVersion=${single.productVersion}`;
	const uploaded = await fetch(uploadUrl, { method: 'POST', headers: { 'X-Upload-Token': 'test-only', 'Content-Type': 'application/octet-stream' }, body: payload, signal: AbortSignal.timeout(30000) });
	assert.equal(uploaded.status, 200);
	const result = await uploaded.json();
	const download = validateUploadResponse(result, single, artifact.platform, base);
	recordUpload(root, single, artifact.platform, result, base);
	await completeUpload(root, single, base);
	const replacement = await fetch(uploadUrl, { method: 'POST', headers: { 'X-Upload-Token': 'test-only' }, body: Buffer.from('new-latest'), signal: AbortSignal.timeout(30000) });
	assert.equal(replacement.status, 200);
	const firstByte = await fetch(download.url, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(30000) });
	assert.equal(firstByte.status, 206);
	assert.equal(Buffer.from(await firstByte.arrayBuffer())[0], 1);
	await probeArchive(download);
	const sparseArchive = path.join(root, 'downloads/archive', 'large-test', 'VsSarosUserSetup.exe');
	fs.mkdirSync(path.dirname(sparseArchive), { recursive: true });
	const fd = fs.openSync(sparseArchive, 'w');
	try { fs.ftruncateSync(fd, 763 * 1048576); } finally { fs.closeSync(fd); }
	await probeArchive({ url: base + '/downloads/archive/large-test/VsSarosUserSetup.exe', size: 763 * 1048576 });
});

test('publication consumes archives before git writes and upload preserves/validates response JSON', () => {
	const release = fs.readFileSync(path.join(ROOT, 'build/saros/create-release.cjs'), 'utf8');
	assertOrdered(release, 'archivedDownloads = await loadArchivedDownloads', 'const changelog = buildChangelog');
	assertOrdered(release, 'assertReleaseVersion(version,', 'const changelog = buildChangelog');
	assert.match(release, /IS_WIN \? archivedDownloads : \[\]/);
	assert.match(release, /ensureReleaseLinks\(curl, \{ api: GITLAB_API, project: GITLAB_PROJECT,/);
	assert.match(release, /ensureReleaseLinks\(curl, \{ api: GITLAB_API, project: GITLAB_MAIN_PROJECT,/);
	const upload = fs.readFileSync(path.join(ROOT, 'deploy-package/scripts/bk-pipeline-upload.ps1'), 'utf8');
	assert.match(upload, /"-o", \$responseFile/);
	assertOrdered(upload, '--invalidate-upload', '--check-exes');
	assert.match(upload, /--record-upload \$platform \$responseFile \$UpdateServer/);
	assert.match(upload, /--complete-upload \$UpdateServer/);
	const generate = fs.readFileSync(path.join(ROOT, '.ci/scripts/generate-exe.ps1'), 'utf8');
	assertOrdered(generate, "'.build/pack-reports/uploads.json'", 'if (-not (Test-Path $gulp))');
	assertOrdered(generate, '--check-seed', 'node --test');
	assertOrdered(generate, '--check-staging', 'node --test');
	assertOrdered(generate, '--check-model', 'node --test');
	assert.match(generate, /--test-timeout=\d+/);
	assert.match(generate, /\$setupAssets = ConvertFrom-Json/);
	assert.match(release, /GITLAB_MAIN_PROJECT\}\/repository\/tags\?tag_name=.*&ref=\$\{buildCommit\}/);
});

test('release version and annotated/lightweight tags must match the verified build', () => {
	const commit = 'a'.repeat(40);
	const tag = 'v2.2.26241';
	links.assertReleaseVersion('2.2.26241', '2.2.26241');
	assert.throws(() => links.assertReleaseVersion('2.2.26242', '2.2.26241'), /differs/);
	links.assertTagCommit(`${commit}\trefs/tags/${tag}`, tag, commit);
	links.assertTagCommit(`${'b'.repeat(40)}\trefs/tags/${tag}\n${commit}\trefs/tags/${tag}^{}`, tag, commit);
	assert.throws(() => links.assertTagCommit(`${'b'.repeat(40)}\trefs/tags/${tag}`, tag, commit), /does not point/);
	assert.throws(() => links.assertTagCommit(`${commit}\trefs/tags/${tag}\n${'b'.repeat(40)}\trefs/tags/${tag}^{}`, tag, commit), /does not point/);
	assert.throws(() => links.assertTagCommit('', tag, commit), /does not point/);
});
