import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { validatePluginResources, PLUGIN_SEMVER_RE } from './pluginPackage.js';

const gunzipAsync = promisify(gunzip);
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const cstr = buffer => buffer.subarray(0, buffer.indexOf(0) < 0 ? buffer.length : buffer.indexOf(0)).toString('utf8').trim();

function safeName(raw) {
	if (!raw || raw.includes('\\') || raw.includes('\0') || raw.startsWith('/') || raw.includes(':') || raw.split('/').includes('..')) { throw new Error(`插件包路径不合法或越界：${raw}`); }
	const path = raw.replace(/^\.\//, '');
	if (!path || path.split('/').some(part => !part || part === '.')) { throw new Error(`插件包路径不合法：${raw}`); }
	return path;
}

function readTar(buffer) {
	const entries = [];
	let offset = 0;
	let longName;
	while (offset + 512 <= buffer.length) {
		const header = buffer.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) { break; }
		const sizeText = cstr(header.subarray(124, 136));
		if (!/^[0-7]*$/.test(sizeText)) { throw new Error('tar size 不合法'); }
		const size = Number.parseInt(sizeText || '0', 8);
		if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES) { throw new Error('插件包单文件太大或 size 不合法'); }
		const start = offset + 512;
		const end = start + size;
		if (end > buffer.length) { throw new Error('tar 内容被截断'); }
		const type = String.fromCharCode(header[156] || 48);
		if (!['0', '\0', '5', 'L'].includes(type)) { throw new Error('插件包不允许链接、特殊文件或未解析的扩展头'); }
		const prefix = cstr(header.subarray(345, 500));
		const name = cstr(header.subarray(0, 100));
		if (type === 'L') {
			if (longName !== undefined) { throw new Error('tar 长文件名扩展重复'); }
			longName = buffer.subarray(start, end).toString('utf8').replace(/\0+$/, '');
		} else {
			const path = longName ?? (prefix ? `${prefix}/${name}` : name);
			longName = undefined;
			if (type !== '5') { entries.push({ name: safeName(path), data: buffer.subarray(start, end) }); }
			else { safeName(path.replace(/\/$/, '')); }
		}
		offset = start + Math.ceil(size / 512) * 512;
	}
	if (longName !== undefined) { throw new Error('tar 长文件名扩展没有对应文件'); }
	const root = entries[0]?.name.split('/')[0];
	const normalized = root && entries.every(entry => entry.name.startsWith(`${root}/`))
		? entries.map(entry => ({ ...entry, name: safeName(entry.name.slice(root.length + 1)) })) : entries;
	const seen = new Set();
	let totalBytes = 0;
	for (const entry of normalized) {
		if (seen.has(entry.name)) { throw new Error(`包内文件重复：${entry.name}`); }
		seen.add(entry.name);
		totalBytes += entry.data.length;
		if (totalBytes > MAX_EXTRACTED_BYTES) { throw new Error('插件包解压后太大'); }
	}
	return { entries: normalized, totalBytes };
}

/** 纯内存静态检查；不执行插件、不写文件、不要求页面客户端。 */
export async function inspectArchive(buffer) {
	if (!Buffer.isBuffer(buffer) || !buffer.length) { throw new Error('包内容为空'); }
	if (buffer.length > MAX_ARCHIVE_BYTES) { throw new Error('插件压缩包太大'); }
	const tar = await gunzipAsync(buffer, { maxOutputLength: MAX_EXTRACTED_BYTES + 8 * 1024 * 1024 });
	const { entries, totalBytes } = readTar(tar);
	const files = new Map(entries.map(entry => [entry.name, entry.data]));
	if (!files.has('package.json')) { throw new Error('包里没有 package.json'); }
	const manifest = JSON.parse(files.get('package.json').toString('utf8'));
	if (!PACKAGE_NAME_RE.test(manifest.name ?? '')) { throw new Error('插件包名不合法'); }
	if (typeof manifest.version !== 'string' || !PLUGIN_SEMVER_RE.test(manifest.version)) { throw new Error('插件版本不是完整 SemVer'); }
	const patch = manifest.dsh?.bundle?.patch;
	const patches = Array.isArray(patch) ? patch : [patch];
	if (!patches.length || patches.some(path => typeof path !== 'string' || !files.has(safeName(path)))) { throw new Error('缺少或不存在声明的 dsh.bundle.patch'); }
	const main = manifest.exports?.['.'] ?? manifest.main;
	if (typeof main !== 'string' || !files.has(safeName(main))) { throw new Error('缺少插件 Host 入口'); }
	const plan = validatePluginResources(manifest, entries);
	const client = manifest.exports?.['./client'];
	const hasClient = typeof client === 'string' && files.has(safeName(client));
	return { name: manifest.name, version: manifest.version, manifest, entries, totalBytes, archiveBytes: buffer.length, hasClient, plan };
}
