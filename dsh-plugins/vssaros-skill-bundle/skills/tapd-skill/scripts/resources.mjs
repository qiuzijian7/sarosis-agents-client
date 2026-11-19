#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const SECRET = /token|secret|password|authorization|cookie|signature|credential|code_challenge|^code$|^state$/i;
const AUTH_HOST = /(?:^|\.)(?:passport\.woa\.com|login\.qq\.com)$/i;

export function redact(source) {
	if (!/^https?:\/\//i.test(source)) { return source; }
	try {
		const url = new URL(source);
		url.username = ''; url.password = '';
		if (AUTH_HOST.test(url.hostname)) { url.search = ''; }
		for (const key of [...url.searchParams.keys()]) {
			if (SECRET.test(key)) { url.searchParams.set(key, '[redacted]'); }
		}
		url.hash = '';
		return url.href;
	} catch { return '[invalid URL]'; }
}

export function classify(source) {
	if (/^https?:\/\//i.test(source)) {
		const url = new URL(source);
		if (url.hostname === 'perfdog.qq.com') { return 'perfdog'; }
		if (url.hostname === 'xperf.woa.com') { return 'deepperf'; }
		if (url.hostname === 'crashsight.qq.com') { return 'crashsight'; }
		if (/\.(?:utrace|etl|trace|perfetto)$/i.test(url.pathname)) { return 'trace'; }
		return 'attachments';
	}
	return 'trace';
}

const decodeHtml = text => text.replace(/&(?:amp|quot|apos|lt|gt);|&#(?:\d+|x[\da-f]+);/gi, entity => {
	const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
	if (named[entity.toLowerCase()]) { return named[entity.toLowerCase()]; }
	const hex = entity[2].toLowerCase() === 'x';
	const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
	return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
});

export function extractSources(input) {
	const result = new Set();
	const visit = value => {
		if (typeof value === 'string') {
			const text = decodeHtml(value.replace(/<(?:br\s*\/|br|\/p|\/div)>/gi, '\n'));
			for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
				result.add(match[0]);
			}
			const plain = text.replace(/<[^>]*>/g, '\n');
			for (const match of plain.matchAll(/(?:[a-z]:\\|\\\\)[^\r\n<>"|]+/gi)) {
				result.add(match[0].trim());
			}
		} else if (Array.isArray(value)) { value.forEach(visit); }
		else if (value && typeof value === 'object') { Object.values(value).forEach(visit); }
	};
	visit(input);
	return [...result];
}

class ResourceError extends Error {
	constructor(message, status = 'failed') { super(message); this.status = status; }
}

const safeName = source => {
	const name = /^https?:\/\//i.test(source) ? decodeURIComponent(basename(new URL(source).pathname)) : win32.basename(source);
	return (name || 'resource.bin').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || 'resource.bin';
};

async function hashFile(file) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) { hash.update(chunk); }
	return hash.digest('hex');
}

async function transfer(stream, file, maxBytes) {
	let bytes = 0;
	const hash = createHash('sha256');
	const counter = new Transform({
		transform(chunk, encoding, callback) {
			bytes += chunk.length;
			if (bytes > maxBytes) { callback(new ResourceError(`资源超过 ${maxBytes} 字节上限`)); return; }
			hash.update(chunk); callback(null, chunk);
		},
	});
	await pipeline(stream, counter, createWriteStream(file, { flags: 'wx' }));
	if (!bytes) { throw new ResourceError('资源内容为空'); }
	return { bytes, sha256: hash.digest('hex') };
}

async function validate(file, contentType) {
	const handle = await open(file, 'r');
	let prefix;
	try {
		const buffer = Buffer.alloc(65536);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		prefix = buffer.subarray(0, bytesRead).toString('utf8').replace(/^\uFEFF/, '').trimStart();
	} finally { await handle.close(); }
	if (/text\/html|application\/xhtml/i.test(contentType) || /^<(?:!doctype\s+html|html|head|body)\b/i.test(prefix)) {
		throw new ResourceError('响应为 HTML 页面（登录页或前端空壳），不是原始资源；需在授权浏览器导出', 'blocked');
	}
	const declaredJson = /json/i.test(contentType) || /\.json\.part$/i.test(file);
	if (declaredJson || /^[{[]/.test(prefix)) {
		let json;
		try { json = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
		catch {
			if (declaredJson) { throw new ResourceError('JSON 资源无法解析'); }
			return 'non-empty non-HTML bytes; SHA-256 verified (not declared JSON)';
		}
		const empty = json === null || (Array.isArray(json) && !json.length) || (typeof json === 'object' && !Object.keys(json).length)
			|| (Array.isArray(json?.data) && !json.data.length);
		const error = json?.ok === false || json?.success === false || json?.error || json?.status === 'error'
			|| (json?.code !== undefined && ![0, 200].includes(Number(json.code)));
		if (empty || error) { throw new ResourceError('JSON 响应为空或包含接口错误，不能作为业务数据'); }
		return 'JSON parsed; non-empty; no known error envelope';
	}
	return 'non-empty non-HTML bytes; SHA-256 verified (binary analysis not performed)';
}

async function download(source, directory, options) {
	const url = new URL(source);
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { throw new ResourceError('只允许无内嵌凭据的 HTTP(S) URL'); }
	const response = await options.fetchImpl(source, { signal: AbortSignal.timeout(options.timeoutMs), headers: { accept: '*/*' } });
	if ([401, 403].includes(response.status)) { await response.body?.cancel(); throw new ResourceError(`HTTP ${response.status}：需要登录或资源权限`, 'blocked'); }
	if (!response.ok) { await response.body?.cancel(); throw new ResourceError(`HTTP ${response.status}`); }
	const finalUrl = response.url || source;
	if (AUTH_HOST.test(new URL(finalUrl).hostname)) { await response.body?.cancel(); throw new ResourceError('请求跳转到登录站点，需要用户完成登录', 'blocked'); }
	if (!response.body) { throw new ResourceError('响应没有文件内容'); }
	const file = join(directory, `${randomUUID()}-${safeName(source)}`);
	const temp = `${file}.part`;
	try {
		const metadata = await transfer(Readable.fromWeb(response.body), temp, options.maxBytes);
		const contentType = response.headers.get('content-type') || '';
		const verification = await validate(temp, contentType);
		if (await hashFile(temp) !== metadata.sha256) { throw new ResourceError('本地文件 SHA-256 不一致'); }
		await rename(temp, file);
		return { file, ...metadata, contentType, finalUrl: redact(finalUrl), verification };
	} finally { await rm(temp, { force: true }); }
}

async function copySource(source, directory, options, item) {
	if (!isAbsolute(source)) { throw new ResourceError('文件路径必须是绝对路径'); }
	let info;
	try { info = await lstat(source); }
	catch (error) {
		if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) { throw new ResourceError(`路径不存在、映射盘不可见或无读取权限（${error.code}）`, 'blocked'); }
		throw error;
	}
	if (info.isSymbolicLink()) { throw new ResourceError('不自动跟随符号链接，请提供实际文件路径', 'blocked'); }
	const nested = relative(source, directory);
	if (info.isDirectory() && (!nested || (!nested.startsWith(`..${sep}`) && nested !== '..' && !isAbsolute(nested)))) {
		throw new ResourceError('目标目录不能放在源目录内');
	}
	const files = [];
	const scan = async file => {
		const stat = await lstat(file);
		if (stat.isSymbolicLink()) { throw new ResourceError('目录含符号链接，请确认下载范围', 'blocked'); }
		if (stat.isDirectory()) {
			for (const name of (await readdir(file)).sort()) { await scan(join(file, name)); }
		} else if (stat.isFile()) { files.push({ source: file, bytes: stat.size }); }
		else { throw new ResourceError('仅支持普通文件和目录'); }
	};
	await scan(source);
	const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
	if (!files.length || !totalBytes) { throw new ResourceError('源目录或文件为空'); }
	if (totalBytes > options.maxBytes) { throw new ResourceError('目录总大小超过上限，请确认范围或调整 --max-bytes', 'blocked'); }
	const target = join(directory, `${randomUUID()}-${safeName(source)}`);
	item.files = [];
	for (const entry of files) {
		const file = info.isDirectory() ? join(target, relative(source, entry.source)) : target;
		await mkdir(dirname(file), { recursive: true });
		const temp = `${file}.part`;
		try {
			const metadata = await transfer(createReadStream(entry.source), temp, options.maxBytes);
			if (metadata.bytes !== entry.bytes || await hashFile(entry.source) !== metadata.sha256 || await hashFile(temp) !== metadata.sha256) {
				throw new ResourceError('源和目标文件大小或 SHA-256 不一致');
			}
			await rename(temp, file);
			item.files.push({ relativePath: info.isDirectory() ? relative(source, entry.source) : basename(source), file, ...metadata });
		} finally { await rm(temp, { force: true }); }
	}
	return { file: target, bytes: totalBytes, fileCount: files.length, verification: 'source/target file count, relative paths, bytes and SHA-256 matched' };
}

export async function collectResources({ sources = [], out, fetchImpl = fetch, maxBytes = DEFAULT_MAX_BYTES, timeoutMs = 60000, dryRun = false } = {}) {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) { throw new Error('大小和超时必须为正整数'); }
	const directory = resolve(out || join(process.cwd(), '.codebuddy', 'downloads', 'tapd', `manual-test-${Date.now()}`));
	const items = [];
	for (const source of new Set(sources)) {
		const item = { source: redact(source), status: 'failed', ok: false, bytes: 0 };
		items.push(item);
		try {
			item.kind = classify(source);
			if (dryRun) { item.status = 'blocked'; item.reason = 'dry-run：未下载或验证任何文件'; continue; }
			const target = join(directory, item.kind);
			await mkdir(target, { recursive: true });
			const metadata = /^https?:\/\//i.test(source)
				? await download(source, target, { fetchImpl, maxBytes, timeoutMs })
				: await copySource(source, target, { maxBytes }, item);
			Object.assign(item, metadata, { status: 'success', ok: true });
		} catch (error) {
			item.status = item.files?.length ? 'partial' : error.status || 'failed';
			item.bytes = item.files?.reduce((sum, file) => sum + file.bytes, 0) || 0;
			item.reason = String(error.message || '资源下载失败').replace(/https?:\/\/[^\s"']+/gi, match => redact(match));
		}
	}
	const report = { ok: items.length > 0 && items.every(item => item.ok), out: directory, testedAt: new Date().toISOString(), dryRun, items };
	if (!dryRun) {
		await mkdir(directory, { recursive: true });
		report.manifest = join(directory, `manifest-${randomUUID()}.json`);
		await writeFile(report.manifest, JSON.stringify(report, null, 2), { flag: 'wx' });
	}
	return report;
}

export async function main(argv) {
	const sources = [];
	let input, out, maxBytes, timeoutMs, dryRun = false;
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === '--dry-run') { dryRun = true; continue; }
		if (flag === '--help') { return { ok: true, help: 'resources.mjs [--url <完整URL>] [--path <绝对路径>] [--input <bug详情JSON或文本>] --out <本地目录> [--max-bytes 209715200] [--timeout-ms 60000] [--dry-run]' }; }
		if (!['--url', '--path', '--input', '--out', '--max-bytes', '--timeout-ms'].includes(flag)) { throw new Error(`未知参数 ${flag}`); }
		const value = argv[++index];
		if (!value || value.startsWith('--')) { throw new Error(`${flag} 缺少参数`); }
		if (flag === '--url' || flag === '--path') { sources.push(value); }
		if (flag === '--input') { input = value; }
		if (flag === '--out') { out = value; }
		if (flag === '--max-bytes') { maxBytes = Number(value); }
		if (flag === '--timeout-ms') { timeoutMs = Number(value); }
	}
	if (input) {
		const text = await readFile(resolve(input), 'utf8');
		let value = text;
		try { value = JSON.parse(text); } catch { /* Plain text bug descriptions are also supported. */ }
		sources.push(...extractSources(value));
	}
	if (!sources.length) { throw new Error('未发现资源；请提供 --url、--path 或含资源的 --input'); }
	return collectResources({ sources, out, maxBytes, timeoutMs, dryRun });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const result = await main(process.argv.slice(2));
		process.stdout.write(`${JSON.stringify(result)}\n`);
		process.exitCode = result.ok ? 0 : 1;
	} catch (error) {
		process.stdout.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
		process.exitCode = 1;
	}
}
