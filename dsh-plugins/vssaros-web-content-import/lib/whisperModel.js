/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, statfs } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { acquireFileLock, lockFileFor } from './lock.js';

export const WHISPER_MODEL = Object.freeze({
	id: 'whisper-base', fileName: 'ggml-base.bin', size: 147951465,
	sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
	urls: Object.freeze([
		'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
		'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
	]),
});
export const WHISPER_MANIFEST_FILE = 'ggml-base.manifest.json';

export function validateModelSpec(spec) {
	if (!spec || spec.id !== 'whisper-base' || spec.fileName !== 'ggml-base.bin'
		|| !Number.isSafeInteger(spec.size) || spec.size < 4 || spec.size > 512 * 1024 * 1024
		|| !/^[a-f0-9]{64}$/.test(spec.sha256) || !Array.isArray(spec.urls) || spec.urls.length < 1 || spec.urls.length > 3) {
		throw new Error('Invalid Whisper model specification');
	}
	for (const address of spec.urls) { validateDownloadUrl(address); }
	return spec;
}

function validateDownloadUrl(address) {
	const url = new URL(address);
	if (url.protocol !== 'https:' || url.username || url.password) { throw new Error('Whisper downloads require HTTPS without credentials'); }
	return url;
}

export function modelCachePath(dataRoot, spec = WHISPER_MODEL) {
	validateModelSpec(spec);
	if (!isAbsolute(dataRoot)) { throw new Error('Whisper data root must be absolute'); }
	return join(dataRoot, 'components', 'whisper', spec.sha256, spec.fileName);
}

export async function readWhisperManifest(modelsDir) {
	let text;
	try { text = await readFile(join(modelsDir, WHISPER_MANIFEST_FILE), 'utf8'); }
	catch (error) { if (error.code === 'ENOENT') { return undefined; } throw error; }
	const manifest = JSON.parse(text);
	if (manifest.schemaVersion !== 1 || !['standard', 'offline'].includes(manifest.mode)
		|| manifest.model?.sha256 !== WHISPER_MODEL.sha256 || manifest.model?.size !== WHISPER_MODEL.size) {
		throw new Error('Whisper manifest does not match the pinned model');
	}
	validateModelSpec(manifest.model);
	return manifest;
}

export async function verifyModelFile(file, spec = WHISPER_MODEL, signal) {
	validateModelSpec(spec);
	signal?.throwIfAborted();
	let info;
	try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') { return false; } throw error; }
	if (!info.isFile() || info.isSymbolicLink() || info.size !== spec.size) { return false; }
	const hash = createHash('sha256');
	const stream = createReadStream(file, { signal });
	for await (const chunk of stream) { hash.update(chunk); }
	return hash.digest('hex') === spec.sha256;
}

async function ensureDirectory(directory) {
	await mkdir(directory, { recursive: true });
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink()) { throw new Error('Whisper cache directory must not be a link'); }
}

async function fetchModel(address, fetchImpl, signal) {
	let url = validateDownloadUrl(address);
	for (let redirect = 0; redirect <= 5; redirect++) {
		const response = await fetchImpl(url.href, { signal, redirect: 'manual', headers: { 'accept-encoding': 'identity' } });
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			await response.body?.cancel();
			const location = response.headers.get('location');
			if (!location) { throw new Error('Whisper download redirect is missing Location'); }
			url = validateDownloadUrl(new URL(location, url).href);
			continue;
		}
		if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Whisper download HTTP ${response.status}`); }
		return response;
	}
	throw new Error('Whisper download has too many redirects');
}

/** Fixed model only; runtime tools cannot supply an arbitrary download URL or output path. */
export async function ensureWhisperModel(dataRoot, {
	spec = WHISPER_MODEL, signal, onProgress = () => {}, fetchImpl = globalThis.fetch,
	acquireLock = acquireFileLock, timeoutMs = 600000,
} = {}) {
	const file = modelCachePath(dataRoot, spec);
	const report = event => { try { onProgress(event); } catch { /* progress must not corrupt the transaction */ } };
	if (await verifyModelFile(file, spec, signal)) { report({ stage: 'ready', received: spec.size, total: spec.size }); return file; }
	const abort = new AbortController();
	const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
	const timer = setTimeout(() => abort.abort(new Error('Whisper model installation timed out')), timeoutMs);
	let release;
	let temporary;
	try {
		for (const directory of [dataRoot, join(dataRoot, 'components'), join(dataRoot, 'components/whisper'), join(dataRoot, 'components/whisper', spec.sha256)]) {
			combined.throwIfAborted();
			await ensureDirectory(directory);
		}
		report({ stage: 'waiting', received: 0, total: spec.size });
		release = await acquireLock(lockFileFor(file), { label: 'Whisper 模型', waitMs: timeoutMs, signal: combined, reclaimStale: false });
		combined.throwIfAborted();
		if (await verifyModelFile(file, spec, combined)) { report({ stage: 'ready', received: spec.size, total: spec.size }); return file; }
		const info = await lstat(file).catch(error => { if (error.code !== 'ENOENT') { throw error; } return undefined; });
		if (info && (!info.isFile() || info.isSymbolicLink())) { throw new Error('Whisper cache target must be a regular file'); }
		const space = await statfs(join(dataRoot, 'components/whisper')).catch(() => undefined);
		if (space && space.bavail * space.bsize < spec.size * 1.1) { throw new Error('Insufficient disk space for Whisper model'); }
		temporary = await mkdtemp(join(dataRoot, 'components/whisper', spec.sha256, '.download-'));
		const partial = join(temporary, spec.fileName + '.part');
		let lastError;
		for (const address of spec.urls) {
			combined.throwIfAborted();
			let handle;
			let reader;
			try {
				const response = await fetchModel(address, fetchImpl, combined);
				reader = response.body.getReader();
				const declared = response.headers.get('content-length');
				if (declared !== null && Number(declared) !== spec.size) { throw new Error('Whisper model Content-Length mismatch'); }
				handle = await open(partial, 'w', 0o600);
				const hash = createHash('sha256');
				let received = 0;
				report({ stage: 'downloading', received, total: spec.size });
				for (;;) {
					combined.throwIfAborted();
					const { done, value } = await reader.read();
					if (done) { break; }
					received += value.byteLength;
					if (received > spec.size) { throw new Error('Whisper download exceeds expected size'); }
					hash.update(value);
					await handle.writeFile(value);
					report({ stage: 'downloading', received, total: spec.size });
				}
				if (received !== spec.size || hash.digest('hex') !== spec.sha256) { throw new Error('Whisper model size/SHA256 mismatch'); }
				await handle.sync();
				await handle.close();
				handle = undefined;
				combined.throwIfAborted();
				await rename(partial, file);
				report({ stage: 'ready', received: spec.size, total: spec.size });
				return file;
			} catch (error) {
				lastError = error;
				combined.throwIfAborted();
				report({ stage: 'retrying', received: 0, total: spec.size });
			} finally {
				await reader?.cancel().catch(() => {});
				await handle?.close();
				await rm(partial, { force: true });
			}
		}
		throw lastError || new Error('Whisper model download failed');
	} finally {
		clearTimeout(timer);
		try {
			if (temporary) { await rm(temporary, { recursive: true, force: true }); }
		} finally { await release?.(); }
	}
}
