/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sources = [path.join(here, 'server.mjs'), path.resolve(here, '../../../deploy-package/update-server/server.mjs')];
const userCommit = 'a'.repeat(40);
const systemCommit = 'b'.repeat(40);

async function startServer(t, source) {
	const root = fs.mkdtempSync(path.join(here, '.update-test-'));
	const manifestPath = path.join(root, 'manifest.json');
	const reservation = http.createServer();
	reservation.listen(0, '127.0.0.1');
	await once(reservation, 'listening');
	const port = reservation.address().port;
	await new Promise(resolve => reservation.close(resolve));
	const base = `http://127.0.0.1:${port}`;
	let stamp = Date.now();
	const writeManifest = value => {
		fs.writeFileSync(manifestPath, value, 'utf8');
		const time = new Date(stamp += 1000);
		fs.utimesSync(manifestPath, time, time);
	};
	const manifest = {
		'win32-x64-user': { version: userCommit, productVersion: '2.2.26277', url: `${base}/downloads/VsSarosUserSetup.exe`, sha256hash: 'c'.repeat(64) },
		'win32-x64': { version: systemCommit, productVersion: '2.2.26229', url: `${base}/downloads/VsSarosSetup.exe`, sha256hash: 'd'.repeat(64) },
	};
	writeManifest(JSON.stringify(manifest));
	const child = spawn(process.execPath, [source], {
		cwd: root,
		env: { ...process.env, PORT: String(port), GH_REPO: '', GH_TOKEN: '', PUBLIC_BASE_URL: base,
			MANIFEST_PATH: manifestPath, VERSIONS_PATH: path.join(root, 'versions.json'), DOWNLOADS_DIR: path.join(root, 'downloads'),
			ARCHIVE_DIR: path.join(root, 'downloads/archive'), UPLOAD_TOKEN: 'test-only' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let logs = '';
	const capture = chunk => { logs = (logs + String(chunk)).slice(-12000); };
	child.stdout.on('data', capture);
	child.stderr.on('data', capture);
	child.on('error', error => capture(error.message));
	t.after(async () => {
		try {
			if (child.exitCode === null && child.signalCode === null) {
				const closed = once(child, 'close');
				child.kill();
				const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
				try { await closed; } finally { clearTimeout(timer); }
			}
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		}
	});
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
			if (response.ok) { return { base, manifest, writeManifest }; }
		} catch { /* server is starting */ }
		if (child.exitCode !== null || child.signalCode !== null) { break; }
		await delay(30);
	}
	assert.fail(`Update server did not start: ${logs}`);
}

for (const source of sources) {
	test(`update protocol: ${path.relative(here, source)}`, async t => {
		const { base, manifest, writeManifest } = await startServer(t, source);
		const request = (platform, commit = 'unknown', query = '', headers = {}) => fetch(
			`${base}/api/update/${platform}/saros/${commit}${query}`, { headers, signal: AbortSignal.timeout(5000) },
		);
		for (const platform of ['win32-x64-user']) {
			const response = await request(platform);
			assert.equal(response.status, 200);
			assert.match(response.headers.get('cache-control'), /no-store/);
			const body = await response.json();
			assert.equal(body.productVersion, manifest[platform].productVersion);
			assert.equal(body.url, manifest[platform].url);
			assert.equal((await request(platform, manifest[platform].version)).status, 204);
			const forced = await request(platform, manifest[platform].version, '?noversioncheck=true');
			assert.equal(forced.status, 200);
			assert.equal((await forced.json()).productVersion, manifest[platform].productVersion);
		}
		const sameVersionHeaders = { 'User-Agent': 'Code/2.2.26277 Electron/test' };
		assert.equal((await request('win32-x64-user', 'unknown', '', sameVersionHeaders)).status, 204);
		assert.equal((await request('win32-x64-user', userCommit, '?noversioncheck=true', sameVersionHeaders)).status, 200);
		assert.equal((await request('win32-x64-user', userCommit, '?noversioncheck=false')).status, 204);
		const oldVersionHeaders = { 'User-Agent': 'Code/2.2.26276 Electron/test' };
		assert.equal((await request('win32-x64-user', userCommit, '', oldVersionHeaders)).status, 200);
		assert.equal((await request('win32-x64-user', userCommit, '', sameVersionHeaders)).status, 204);
		for (const platform of ['win32-x64', 'win32-arm64', 'win32-ia32']) {
			const response = await request(platform, 'unknown', '?noversioncheck=true');
			assert.equal(response.status, 410);
			assert.match(response.headers.get('cache-control'), /no-store/);
			const body = await response.json();
			assert.equal(body.code, 'SYSTEM_CHANNEL_RETIRED');
			assert.equal(body.url, undefined);
			const uploaded = await fetch(`${base}/admin/upload?platform=${platform}&commit=${userCommit}&productVersion=2.2.26277`, {
				method: 'POST', headers: { 'X-Upload-Token': 'test-only' }, body: 'rejected',
			});
			assert.equal(uploaded.status, 400);
			if (source.includes('deploy-package')) {
				const changed = await fetch(`${base}/admin/manifest?platform=${platform}&commit=${userCommit}&productVersion=2.2.26277`, {
					method: 'POST', headers: { 'X-Upload-Token': 'test-only' },
				});
				assert.equal(changed.status, 400);
			}
		}
		assert.equal((await request('win32-x64-archive')).status, 404);
		assert.equal((await request('win32-arm64-user')).status, 404);
		writeManifest(JSON.stringify({ 'win32-x64-user': manifest['win32-x64-user'] }));
		assert.equal((await request('win32-x64')).status, 410);
		assert.equal((await request('win32-x64-user')).status, 200);
		for (const patch of [{ productVersion: '' }, { version: '' }, { url: 'file:///setup.exe' }]) {
			writeManifest(JSON.stringify({ 'win32-x64-user': { ...manifest['win32-x64-user'], ...patch } }));
			assert.equal((await request('win32-x64-user', userCommit, '?noversioncheck=true')).status, 502);
		}
		for (const malformed of ['{invalid', 'null', '[]']) {
			writeManifest(malformed);
			const response = await request('win32-x64-user');
			assert.equal(response.status, 503);
			assert.match(response.headers.get('cache-control'), /no-store/);
		}
	});

	test(`GitHub lookup failures are not no-update: ${path.relative(here, source)}`, async () => {
		const text = fs.readFileSync(source, 'utf8');
		const body = text.slice(text.indexOf('async function readFromGitHub('), text.indexOf('const server = http.createServer'));
		const context = {
			GH_REPO: 'test/repository', GH_TOKEN: '', AbortSignal,
			ASSET_NAME_BY_PLATFORM: { 'win32-x64-user': 'VsSarosUserSetup' },
			archiveExt: () => '.exe', console: { error() {} },
			fetch: async () => ({ ok: false, status: 503 }),
		};
		const read = vm.runInNewContext(`${body}\nreadFromGitHub`, context);
		await assert.rejects(read('win32-x64-user'), /HTTP 503/);
		context.fetch = async () => ({ ok: true, json: async () => ({ body: `commit: ${userCommit}`, tag_name: 'v2.2.26277',
			assets: [{ name: 'VsSarosUserSetup.exe', browser_download_url: 'https://downloads.example/user.exe' }] }) });
		assert.equal((await read('win32-x64-user')).productVersion, '2.2.26277');
		assert.equal(await read('win32-x64'), null);
	});
}

for (const source of [path.join(here, 'worker.js'), path.resolve(here, '../../../deploy-package/update-server/worker.js')]) {
	test(`worker refuses retired system before any upstream request: ${path.relative(here, source)}`, async () => {
		const text = fs.readFileSync(source, 'utf8').replace('export default', 'const worker =');
		const worker = vm.runInNewContext(`${text}\nworker`, { URL, Response, fetch: async () => { assert.fail('System channel must not query upstream'); } });
		for (const platform of ['win32-x64', 'win32-arm64', 'win32-ia32']) {
			const response = await worker.fetch({ url: `https://updates.example/api/update/${platform}/saros/unknown` }, { GH_REPO: 'test/repository' });
			assert.equal(response.status, 410);
			assert.match(response.headers.get('cache-control'), /no-store/);
			const body = await response.json();
			assert.equal(body.code, 'SYSTEM_CHANNEL_RETIRED');
			assert.equal(body.url, undefined);
		}
	});
}

for (const source of [path.join(here, 'gen-manifest.mjs'), path.resolve(here, '../../../deploy-package/update-server/gen-manifest.mjs')]) {
	test(`manifest CLI refuses system without touching manifests: ${path.relative(here, source)}`, async () => {
		const file = path.join(path.dirname(source), 'manifest.json');
		const original = fs.readFileSync(file, 'utf8');
		const child = spawn(process.execPath, [source, '--platform', 'win32-x64', '--exe', 'missing.exe', '--version', '2.2.26277', '--url', 'https://downloads.example/VsSarosSetup.exe'], { stdio: ['ignore', 'pipe', 'pipe'] });
		let error = '';
		child.stderr.on('data', data => { error += data; });
		const [code] = await once(child, 'close');
		assert.equal(code, 1);
		assert.match(error, /Only Windows user/);
		assert.equal(fs.readFileSync(file, 'utf8'), original);
	});
}
