/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import * as locks from '../../vssaros-foundation/lib/lock.js';
import { bindFoundation } from '../lib/foundationRef.js';
import { apply, ensureContentImportModel } from '../lib/index.js';
import { runCommand } from '../lib/core/run.js';
import { WHISPER_MODEL, WHISPER_MANIFEST_FILE, modelCachePath, ensureWhisperModel, validateModelSpec, verifyModelFile, readWhisperManifest } from '../lib/whisperModel.js';

bindFoundation({ ...locks, dataRootOf: config => config.dataRoot });
const bytes = Buffer.from('ggml-test-model-content');
const spec = { ...WHISPER_MODEL, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), urls: ['https://model.example/base.bin'] };

async function fixture(t) {
	const root = await fs.mkdtemp(join(tmpdir(), 'saros-whisper-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	return root;
}
function response(body = bytes, status = 200, headers = {}) {
	return new Response(body, { status, headers });
}

async function standardLayout(root, mode = 'standard') {
	const bin = join(root, 'saros/bin');
	await fs.mkdir(bin, { recursive: true });
	const models = join(root, 'saros/models');
	await fs.mkdir(models, { recursive: true });
	await fs.writeFile(join(models, WHISPER_MANIFEST_FILE), JSON.stringify({ schemaVersion: 1, mode, model: WHISPER_MODEL }));
	return bin;
}

test('fixed cache identity and URL constraints reject path traversal and insecure sources', () => {
	assert.throws(() => modelCachePath('relative', spec), /absolute/);
	assert.throws(() => validateModelSpec({ ...spec, fileName: '../outside' }), /specification/);
	assert.throws(() => validateModelSpec({ ...spec, sha256: '../outside' }), /specification/);
	assert.throws(() => validateModelSpec({ ...spec, urls: ['http://model.example/base.bin'] }), /HTTPS/);
	assert.throws(() => validateModelSpec({ ...spec, urls: ['https://user:secret@model.example/base.bin'] }), /credentials/);
});

test('download streams to temporary file, reports progress, validates hash and reuses cache offline', async t => {
	const root = await fixture(t);
	const events = [];
	let calls = 0;
	const file = await ensureWhisperModel(root, { spec, fetchImpl: async () => { calls++; return response(); }, onProgress: event => events.push(event) });
	assert.equal(file, modelCachePath(root, spec));
	assert.deepEqual(await fs.readFile(file), bytes);
	assert.equal(await verifyModelFile(file, spec), true);
	assert.ok(events.some(event => event.stage === 'downloading'));
	assert.equal(events.at(-1).stage, 'ready');
	const reused = await ensureWhisperModel(root, { spec, fetchImpl: () => { throw new Error('must not download'); } });
	assert.equal(reused, file);
	assert.equal(calls, 1);
	assert.deepEqual(await fs.readdir(dirname(file)), [spec.fileName]);
});

test('bad SHA/length preserve old cache until verified replacement and remove locks/partial files', async t => {
	const root = await fixture(t);
	const file = modelCachePath(root, spec);
	await fs.mkdir(dirname(file), { recursive: true });
	const old = Buffer.alloc(bytes.length, 1);
	await fs.writeFile(file, old);
	await assert.rejects(ensureWhisperModel(root, { spec, fetchImpl: async () => response(Buffer.alloc(bytes.length, 2)) }), /SHA256/);
	assert.deepEqual(await fs.readFile(file), old);
	assert.deepEqual(await fs.readdir(dirname(file)), [spec.fileName]);
	await assert.rejects(ensureWhisperModel(root, { spec, fetchImpl: async () => response(bytes, 200, { 'content-length': String(bytes.length + 1) }) }), /Content-Length/);
	assert.deepEqual(await fs.readFile(file), old);
	await ensureWhisperModel(root, { spec, fetchImpl: async () => response() });
	assert.deepEqual(await fs.readFile(file), bytes);
});

test('missing length still enforces exact byte budget and rejects truncated/oversized streams', async t => {
	const root = await fixture(t);
	await assert.rejects(ensureWhisperModel(root, { spec, fetchImpl: async () => response(bytes.subarray(0, 5)) }), /size\/SHA256/);
	await assert.rejects(ensureWhisperModel(root, { spec, fetchImpl: async () => response(Buffer.alloc(bytes.length + 1)) }), /exceeds expected/);
	assert.deepEqual(await fs.readdir(dirname(modelCachePath(root, spec))), []);
});

test('HTTP failure tries a mirror, insecure redirects are rejected', async t => {
	const root = await fixture(t);
	const mirror = { ...spec, urls: ['https://first.example/base.bin', 'https://second.example/base.bin'] };
	const requested = [];
	await ensureWhisperModel(root, { spec: mirror, fetchImpl: async address => {
		requested.push(address);
		return requested.length === 1 ? response('unavailable', 503) : response();
	} });
	assert.deepEqual(requested, mirror.urls);
	const second = await fixture(t);
	await assert.rejects(ensureWhisperModel(second, { spec, fetchImpl: async () => response(null, 302, { location: 'http://unsafe.example/model' }) }), /HTTPS/);
});

test('concurrent users serialize installation and fetch once', async t => {
	const root = await fixture(t);
	let calls = 0;
	const fetchImpl = async () => { calls++; await delay(70); return response(); };
	const results = await Promise.all([ensureWhisperModel(root, { spec, fetchImpl }), ensureWhisperModel(root, { spec, fetchImpl })]);
	assert.equal(calls, 1);
	assert.equal(results[0], results[1]);
});

test('cancelling a waiting installation does not remove another live lock', async t => {
	const root = await fixture(t);
	const file = modelCachePath(root, spec);
	await fs.mkdir(dirname(file), { recursive: true });
	const release = await locks.acquireFileLock(locks.lockFileFor(file));
	const controller = new AbortController();
	const pending = ensureWhisperModel(root, { spec, signal: controller.signal, fetchImpl: () => { throw new Error('should stay waiting'); } });
	await delay(30);
	controller.abort();
	await assert.rejects(pending, { name: 'AbortError' });
	assert.equal((await fs.stat(locks.lockFileFor(file))).isFile(), true);
	await release();
	assert.deepEqual(await fs.readdir(dirname(file)), []);
});

test('cancelled/timeout downloads leave no model, lock or partial and can retry', async t => {
	const root = await fixture(t);
	const controller = new AbortController();
	const fetchImpl = async (_url, { signal }) => {
		await delay(10000, undefined, { signal });
		return response();
	};
	const pending = ensureWhisperModel(root, { spec, fetchImpl, signal: controller.signal });
	await delay(30);
	controller.abort();
	await assert.rejects(pending, { name: 'AbortError' });
	assert.deepEqual(await fs.readdir(dirname(modelCachePath(root, spec))), []);
	await assert.rejects(ensureWhisperModel(root, { spec, fetchImpl, timeoutMs: 30 }), /timed out/);
	assert.deepEqual(await fs.readdir(dirname(modelCachePath(root, spec))), []);
	await ensureWhisperModel(root, { spec, fetchImpl: async () => response() });
});

test('linked cache targets are refused, outside data is not overwritten', async t => {
	const root = await fixture(t);
	const file = modelCachePath(root, spec);
	await fs.mkdir(dirname(file), { recursive: true });
	const outside = join(root, 'outside.bin');
	await fs.writeFile(outside, 'outside');
	await fs.link(outside, file);
	// A hardlink may be replaced atomically but must never be overwritten in place.
	await ensureWhisperModel(root, { spec, fetchImpl: async () => response() });
	assert.equal(await fs.readFile(outside, 'utf8'), 'outside');
	await fs.rm(file);
	await fs.mkdir(file);
	await assert.rejects(ensureWhisperModel(root, { spec, fetchImpl: async () => response() }), /regular file/);
});

test('content_import gets model only for standard mode, respects download opt-out and override', async t => {
	const root = await fixture(t);
	const bin = await standardLayout(root);
	const config = { dataRoot: root, binDir: bin };
	let installed = 0;
	const install = async (dataRoot, options) => {
		installed++;
		assert.equal(dataRoot, root);
		assert.equal(options.spec.sha256, WHISPER_MODEL.sha256);
		return 'verified-cache-model';
	};
	assert.equal(await ensureContentImportModel(config, { install }), 'verified-cache-model');
	assert.equal(installed, 1);
	assert.equal(await ensureContentImportModel(config, { allowDownload: false, install }), undefined);
	assert.equal(await ensureContentImportModel({ ...config, autoDownloadWhisperModel: false }, { install }), undefined);
	await standardLayout(root, 'offline');
	assert.equal(await ensureContentImportModel(config, { install }), undefined);
	assert.equal(installed, 1);
	assert.equal(await ensureContentImportModel({ ...config, whisperModel: '/custom/ggml.bin' }, { install }), '/custom/ggml.bin');
});

test('malformed/unpinned manifests fail closed rather than downloading unknown payloads', async t => {
	const root = await fixture(t);
	const bin = await standardLayout(root);
	const models = join(bin, '..', 'models');
	const manifest = { schemaVersion: 1, mode: 'standard', model: { ...WHISPER_MODEL, sha256: 'a'.repeat(64) } };
	await fs.writeFile(join(models, WHISPER_MANIFEST_FILE), JSON.stringify(manifest));
	await assert.rejects(readWhisperManifest(models), /pinned model/);
	await assert.rejects(ensureContentImportModel({ binDir: bin, dataRoot: root }, { install: () => { throw new Error('not reached'); } }), /pinned model/);
});

test('manifest discovery falls back from configured directory to environment directory', async t => {
	const root = await fixture(t);
	const bin = await standardLayout(root);
	const saved = process.env.VSSAROS_BIN_DIR;
	process.env.VSSAROS_BIN_DIR = bin;
	try {
		assert.equal(await ensureContentImportModel({ binDir: join(root, 'empty-bin'), dataRoot: root }, { install: async () => 'cached' }), 'cached');
	} finally {
		if (saved === undefined) { delete process.env.VSSAROS_BIN_DIR; } else { process.env.VSSAROS_BIN_DIR = saved; }
	}
});

test('model locks conservatively refuse stale reclaim and repeated release keeps the next owner', async t => {
	const root = await fixture(t);
	const file = join(root, 'model.lock');
	const stale = JSON.stringify({ pid: 99999999, at: '2000-01-01' });
	await fs.writeFile(file, stale);
	await fs.utimes(file, new Date(0), new Date(0));
	await assert.rejects(locks.acquireFileLock(file, { reclaimStale: false, waitMs: 40, pollMs: 10 }), /占用/);
	assert.equal(await fs.readFile(file, 'utf8'), stale);
	await fs.rm(file);
	const first = await locks.acquireFileLock(file);
	await first();
	const second = await locks.acquireFileLock(file);
	const owner = await fs.readFile(file, 'utf8');
	await first();
	assert.equal(await fs.readFile(file, 'utf8'), owner);
	await second();
});

test('subprocess and real content_import wrappers propagate cancellation', async t => {
	const controller = new AbortController();
	const command = runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
	await delay(40);
	controller.abort();
	await assert.rejects(command, { name: 'AbortError' });
	const root = await fixture(t);
	let definition;
	apply({
		effect: callback => callback(), on: () => () => {},
		inject: (dependencies, callback) => { if (dependencies.includes('tools')) { callback({ tools: { register: tool => { definition = tool; } } }); } },
	}, { dataRoot: root });
	await assert.rejects(definition.execute({ url: 'https://example.com', mode: 'write' }, { signal: controller.signal }), { name: 'AbortError' });
	await assert.rejects(definition.execute({ urls: ['https://example.com/a', 'https://example.com/b'], html: '<p>not written</p>', mode: 'write' }, { signal: controller.signal }), { name: 'AbortError' });
	assert.deepEqual(await fs.readdir(root), []);
});
