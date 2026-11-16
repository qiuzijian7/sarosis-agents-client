import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { packTarGzFromMap, listTarGzEntries } from './tar.js';

export const PLUGIN_ENVELOPE_FORMAT = 'vssaros-workbench-plugin';
export const CAPABILITY_PLUGIN_FORMAT = 'vssaros-capability-plugin';
export const isPluginEnvelope = manifest => [PLUGIN_ENVELOPE_FORMAT, CAPABILITY_PLUGIN_FORMAT].includes(manifest?.format);
const kindForProfile = profile => profile === 'bot' ? 'agent' : profile === 'workbench' ? 'workbench' : '';
const MAX_BYTES = 10 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const validSlug = slug => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug);

function requireInspector(inspect) {
	if (typeof inspect !== 'function') { throw new Error('工作台包校验服务未就绪，请更新工作台宿主插件'); }
}
function requireExternalPackage(name) {
	if (/^@(vssaros|deepseek-ai)\//.test(name)) { throw new Error('商城上传包不能占用内置插件包名'); }
}

/** 外层适配商城 manifest 契约；内层 npm tgz 保持逐字节不变。 */
export async function createPluginEnvelope({ gzBuffer, localId, version, kind = 'workbench', inspect, meta = {} }) {
	requireInspector(inspect);
	if (!validSlug(localId)) { throw new Error('商城 slug 不合法'); }
	const info = await inspect(gzBuffer);
	requireExternalPackage(info.name);
	if (!info.plan) { throw new Error('插件包必须有资源清单'); }
	const profile = info.plan.profile ?? 'workbench';
	if (kindForProfile(profile) !== kind) { throw new Error('插件 profile 与商品类型不一致'); }
	if (profile === 'workbench' && !info.hasClient) { throw new Error('工作台包必须有页面入口'); }
	if (info.version !== version) { throw new Error('插件版本与商城版本不一致'); }
	const summary = Object.fromEntries(Object.entries(info.plan.resources).map(([key, rows]) => [key, rows.length]));
	const manifest = {
		kind, id: localId, version, name: meta.name || info.plan.workbench?.title || info.name,
		format: profile === 'bot' ? CAPABILITY_PLUGIN_FORMAT : PLUGIN_ENVELOPE_FORMAT, formatVersion: 1, files: ['plugin.tgz'],
		plugin: { name: info.name, version, profile, primaryBot: info.plan.primaryBot, sha256: digest(gzBuffer), resources: summary },
	};
	const envelope = packTarGzFromMap({ 'manifest.json': JSON.stringify(manifest), 'plugin.tgz': gzBuffer });
	if (envelope.length > MAX_BYTES) { throw new Error('商城工作台包超过 10 MiB'); }
	return { manifest, gzBuffer: envelope, sha256: digest(envelope), files: ['manifest.json', 'plugin.tgz'] };
}

export async function unpackPluginEnvelope({ gzBuffer, slug, version, kind, expectedSha256, inspect }) {
	requireInspector(inspect);
	if (!Buffer.isBuffer(gzBuffer) || !gzBuffer.length || gzBuffer.length > MAX_BYTES) { throw new Error('工作台商城包大小不合法'); }
	if (expectedSha256 && digest(gzBuffer) !== expectedSha256.toLowerCase()) { throw new Error('商城包 sha256 校验失败'); }
	const parsed = await listTarGzEntries(gzBuffer, { maxBytes: 12 * 1024 * 1024 });
	const files = parsed.files;
	if (files.length !== 2 || files.filter(f => f.path === 'manifest.json').length !== 1 || files.filter(f => f.path === 'plugin.tgz').length !== 1) {
		throw new Error('商城工作台包必须仅包含 manifest.json 和 plugin.tgz');
	}
	const manifest = JSON.parse(files.find(f => f.path === 'manifest.json').data.toString('utf8'));
	if (!isPluginEnvelope(manifest) || manifest.formatVersion !== 1 || !['agent', 'workbench'].includes(manifest.kind)
		|| (kind !== undefined && manifest.kind !== kind) || (manifest.format === PLUGIN_ENVELOPE_FORMAT && manifest.kind !== 'workbench')
		|| manifest.id !== slug || manifest.version !== version) { throw new Error('商城插件包类型或清单与商品不一致'); }
	const pluginBuffer = files.find(f => f.path === 'plugin.tgz').data;
	if (digest(pluginBuffer) !== manifest.plugin?.sha256) { throw new Error('插件包 sha256 校验失败'); }
	const info = await inspect(pluginBuffer);
	requireExternalPackage(info.name);
	const profile = info.plan?.profile ?? 'workbench';
	if (!info.plan || (profile === 'workbench' && !info.hasClient) || kindForProfile(profile) !== manifest.kind
		|| (manifest.plugin.profile !== undefined && manifest.plugin.profile !== profile) || info.name !== manifest.plugin.name || info.version !== version) {
		throw new Error('插件内容与发布清单类型不一致');
	}
	const resources = Object.fromEntries(Object.entries(info.plan.resources).map(([key, rows]) => [key, rows.length]));
	if (!manifest.plugin.resources || Object.keys(manifest.plugin.resources).length !== Object.keys(resources).length
		|| Object.entries(resources).some(([key, count]) => manifest.plugin.resources[key] !== count)) { throw new Error('插件资源摘要与包内声明不一致'); }
	return { pluginBuffer, packageName: info.name, version, plan: info.plan, manifest, entries: info.entries };
}

export async function installPluginEnvelope({ dataRoot, gzBuffer, slug, version, kind, expectedSha256, inspect, pluginManager, ownedPackageName }) {
	if (!dataRoot || !validSlug(slug)) { throw new Error('工作台安装需要有效数据根与商品标识'); }
	if (typeof pluginManager?.installBundle !== 'function') { throw new Error('插件管理服务未就绪，未安装'); }
	const info = await unpackPluginEnvelope({ gzBuffer, slug, version, kind, expectedSha256, inspect });
	if (typeof pluginManager.listBundles === 'function') {
		const bundles = await pluginManager.listBundles();
		if (bundles.some(row => row.name === info.packageName && row.installed === true) && ownedPackageName !== info.packageName) {
			throw new Error('插件包名已由其他来源安装，不能覆盖');
		}
	}
	const hash = digest(info.pluginBuffer);
	const directory = join(resolve(dataRoot), 'plugin-archives', hash);
	await mkdir(directory, { recursive: true });
	const archivePath = join(directory, 'plugin.tgz');
	let exists = false;
	try {
		if (digest(await readFile(archivePath)) !== hash) { throw new Error('已缓存插件包损坏'); }
		exists = true;
	} catch (error) { if (error.code !== 'ENOENT') { throw error; } }
	if (!exists) {
		const staging = join(directory, `${randomUUID()}.tmp`);
		try { await writeFile(staging, info.pluginBuffer); await rename(staging, archivePath); }
		finally { await rm(staging, { force: true }); }
	}
	const result = await pluginManager.installBundle(`file:${archivePath}`, { enabled: true });
	if (!result || result.error || result.ok === false || !['applied', 'restart-required'].includes(result.application)) {
		return { ok: false, application: result?.application ?? 'failed', error: result?.error ?? '插件管理器未确认安装生效', archivePath };
	}
	return { ok: true, application: result.application, changed: result.changed !== false, restartRequired: result.application === 'restart-required',
		packageName: info.packageName, version, archivePath, format: info.manifest.format, profile: info.plan.profile ?? 'workbench',
		resources: info.manifest.plugin.resources, ...(info.plan.profile === 'bot' ? { bot: 'unverified' } : { workbench: 'unverified' }) };
}
