/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { verifyInstallers } from './pack-optimization.mjs';
import policy from './pack-policy.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORT = '.build/pack-reports/uploads.json';
const DEFAULT_SERVER = 'http://21.139.192.124:3030';

export function trustedDownloadBase(server, env = process.env) {
	const url = new URL(env.SAROS_RELEASE_DOWNLOAD_BASE_URL || server || env.SAROS_UPDATE_SERVER || DEFAULT_SERVER);
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
		throw new Error('Release download base must be an HTTP(S) origin without credentials, query or path');
	}
	return url.origin;
}

export function validateUploadResponse(response, installerReport, platform, base) {
	const allowed = policy.WINDOWS_ASSETS[0];
	if (installerReport.target !== 'user' || installerReport.artifacts?.length !== 1
		|| installerReport.artifacts[0].target !== allowed.target || installerReport.artifacts[0].platform !== allowed.platform
		|| installerReport.artifacts[0].rel !== allowed.rel) {
		throw new Error('Only the user installer can be published');
	}
	const artifact = installerReport.artifacts.find(item => item.platform === platform);
	if (!artifact || response?.ok !== true || response.platform !== platform
		|| response.version !== installerReport.commit || response.productVersion !== installerReport.productVersion
		|| !Number.isSafeInteger(response.size) || response.size !== artifact.size
		|| !/^[a-f0-9]{64}$/.test(response.sha256hash || '') || response.sha256hash !== artifact.sha256) {
		throw new Error(`Upload receipt does not match the verified installer: ${platform}`);
	}
	if (typeof response.archive !== 'string' || !response.archive) {
		throw new Error('Upload has no immutable archive; enable server archiving and retry (latest URL cannot be used for a historical Release)');
	}
	const url = new URL(response.archive);
	if (url.origin !== trustedDownloadBase(base, {}) || url.username || url.password || url.search || url.hash) {
		throw new Error('Archive URL does not belong to the trusted download origin');
	}
	const versionKey = String(installerReport.productVersion).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '') || 'unknown';
	const key = `${versionKey}--${platform}--${artifact.sha256}`;
	const serverNames = ['VsSarosUserSetup.exe'];
	if (!serverNames.some(name => url.pathname === `/downloads/archive/${key}/${name}`)) {
		throw new Error('Archive URL is not the expected version/platform/SHA256 path');
	}
	return { target: artifact.target, platform, rel: artifact.rel, kind: artifact.kind, name: path.basename(artifact.rel), size: artifact.size, sha256: artifact.sha256, url: url.href };
}

export function validateUploadReport(uploadReport, installerReport, base, { requireReady = true } = {}) {
	if (!uploadReport || uploadReport.schemaVersion !== 1 || uploadReport.commit !== installerReport.commit
		|| uploadReport.productVersion !== installerReport.productVersion || uploadReport.target !== installerReport.target
		|| uploadReport.mode !== installerReport.mode || uploadReport.downloadBase !== base
		|| !Array.isArray(uploadReport.artifacts) || (requireReady && uploadReport.ready !== true)) {
		throw new Error('Upload report is missing, incomplete or from a different build/mode/download origin');
	}
	const seen = new Set();
	const downloads = uploadReport.artifacts.map(item => {
		if (seen.has(item.platform)) { throw new Error('Duplicate platform in upload report'); }
		seen.add(item.platform);
		return validateUploadResponse({ ok: true, platform: item.platform, version: uploadReport.commit, productVersion: uploadReport.productVersion,
			size: item.size, sha256hash: item.sha256, archive: item.url }, installerReport, item.platform, base);
	});
	if (requireReady && (downloads.length !== installerReport.artifacts.length || installerReport.artifacts.some(item => !seen.has(item.platform)))) {
		throw new Error('Upload report is missing selected installers');
	}
	return downloads;
}

/** Probe one byte only; never downloads another full installer or forwards upload/GitLab credentials. */
export function probeArchive(download, { timeoutMs = 15000 } = {}) {
	return new Promise((resolve, reject) => {
		const address = new URL(download.url);
		if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) { throw new Error('Invalid archive probe URL'); }
		const transport = address.protocol === 'https:' ? https : http;
		let settled = false;
		let timer;
		const finish = error => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			if (error) { reject(error); } else { resolve(); }
		};
		const req = transport.get(address, { headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' } }, response => {
			if (response.statusCode !== 206 || response.headers['content-range'] !== `bytes 0-0/${download.size}`
				|| response.headers['content-length'] !== '1') {
				response.destroy();
				finish(new Error(`Archive probe failed (${response.statusCode}); expected one-byte range of ${download.size} bytes`));
				return;
			}
			let received = 0;
			response.on('data', chunk => {
				received += chunk.length;
				if (received > 1) { response.destroy(new Error('Archive range response exceeded one byte')); }
			});
			response.on('end', () => finish(received === 1 ? undefined : new Error('Archive probe returned truncated data')));
			response.on('error', finish);
			response.on('aborted', () => finish(new Error('Archive probe aborted')));
		});
		timer = setTimeout(() => req.destroy(new Error('Archive probe timed out')), timeoutMs);
		req.on('error', finish);
	});
}

export function validateUpdateFeedResponse(response, installerReport, download, base) {
	if (download.target !== 'user' || download.platform !== 'win32-x64-user') {
		throw new Error('Only the user update feed can be published');
	}
	if (!response || response.version !== installerReport.commit || response.productVersion !== installerReport.productVersion
		|| response.sha256hash !== download.sha256 || typeof response.url !== 'string') {
		throw new Error(`Update feed does not match the verified installer: ${download.platform}`);
	}
	const names = ['VsSarosUserSetup.exe'];
	const expectedUrls = [download.url, ...names.map(name => new URL(`/downloads/${name}`, base).href)];
	if (!expectedUrls.includes(response.url)) {
		throw new Error(`Update feed points to the wrong installer target or download origin: ${download.platform}`);
	}
}

/** Fetch metadata only, without credentials or redirects; a missing channel's 204 is never success. */
export async function probeUpdateFeed(download, installerReport, server, base, { timeoutMs = 15000 } = {}) {
	const endpoint = new URL(`/api/update/${encodeURIComponent(download.platform)}/saros/unknown`, trustedDownloadBase(server, {}));
	endpoint.searchParams.set('noversioncheck', 'true');
	const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'Cache-Control': 'no-cache' } });
	if (response.status !== 200) {
		await response.body?.cancel();
		throw new Error(`Update feed probe failed for ${download.platform}: HTTP ${response.status}, expected 200`);
	}
	const chunks = [];
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.length;
		if (size > 64 * 1024) { throw new Error('Update feed exceeded 64 KiB'); }
		chunks.push(chunk);
	}
	validateUpdateFeedResponse(JSON.parse(Buffer.concat(chunks).toString('utf8')), installerReport, download, base);
}

export function invalidateUpload(root = ROOT) {
	fs.rmSync(path.join(root, REPORT), { force: true });
}

function writeReport(root, report) {
	const file = path.join(root, REPORT);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.tmp`;
	try { fs.writeFileSync(temp, JSON.stringify(report, null, 2) + '\n', 'utf8'); fs.renameSync(temp, file); }
	finally { fs.rmSync(temp, { force: true }); }
}

export function recordUpload(root, installerReport, platform, response, base) {
	const file = path.join(root, REPORT);
	let previous;
	try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); }
	catch (error) { if (error.code !== 'ENOENT') { throw error; } }
	if (previous) { previous.ready = false; writeReport(root, previous); }
	const artifact = validateUploadResponse(response, installerReport, platform, base);
	const artifacts = previous ? validateUploadReport(previous, installerReport, base, { requireReady: false }).filter(item => item.platform !== platform) : [];
	artifacts.push(artifact);
	const report = { schemaVersion: 1, commit: installerReport.commit, productVersion: installerReport.productVersion,
		target: installerReport.target, mode: installerReport.mode, downloadBase: base, ready: false, artifacts };
	writeReport(root, report);
	return report;
}

export async function completeUpload(root, installerReport, base, probe = probeArchive, { updateServer = base, probeFeed = probeUpdateFeed } = {}) {
	const report = JSON.parse(fs.readFileSync(path.join(root, REPORT), 'utf8'));
	// Invalidate a previously completed report before performing any new checks/probes.
	report.ready = false;
	writeReport(root, report);
	const downloads = validateUploadReport({ ...report, ready: true }, installerReport, base);
	for (const download of downloads) {
		await probe(download);
		await probeFeed(download, installerReport, updateServer, base);
	}
	writeReport(root, { ...report, ready: true });
	return downloads;
}

export async function loadArchivedDownloads(root = ROOT, env = process.env, probe = probeArchive) {
	const installerReport = verifyInstallers(root, env);
	const base = trustedDownloadBase(undefined, env);
	const report = JSON.parse(fs.readFileSync(path.join(root, REPORT), 'utf8'));
	const downloads = validateUploadReport(report, installerReport, base);
	for (const download of downloads) { await probe(download); }
	return downloads.map(item => ({ ...item, sizeMB: (item.size / 1048576).toFixed(2) }));
}

async function main(args) {
	if (args[0] === '--invalidate-upload') { invalidateUpload(); return; }
	const installerReport = verifyInstallers(ROOT);
	if (args[0] === '--record-upload') {
		if (!args[1] || !args[2] || !args[3]) { throw new Error('--record-upload requires platform, response file and update server'); }
		const file = args[2];
		if (fs.statSync(file).size > 64 * 1024) { throw new Error('Upload response exceeded 64 KiB'); }
		const response = JSON.parse(fs.readFileSync(file, 'utf8'));
		recordUpload(ROOT, installerReport, args[1], response, trustedDownloadBase(args[3]));
		console.log(`[release-assets] verified upload archive: ${args[1]}`);
		return;
	}
	if (args[0] === '--complete-upload') {
		if (!args[1]) { throw new Error('--complete-upload requires update server'); }
		const base = trustedDownloadBase(args[1]);
		if (base.startsWith('http:')) { console.warn('[release-assets] HTTP archive transport is not authenticated; configure HTTPS for production'); }
		const downloads = await completeUpload(ROOT, installerReport, base, probeArchive, { updateServer: trustedDownloadBase(args[1], {}) });
		console.log(`[release-assets] ${downloads.length} installer archives and update feeds verified`);
		return;
	}
	throw new Error('Usage: --invalidate-upload | --record-upload <platform> <response-json> <server> | --complete-upload <server>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch(error => { console.error(`[release-assets] ${error.message}`); process.exitCode = 1; });
}
