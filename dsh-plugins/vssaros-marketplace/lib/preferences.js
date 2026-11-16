import { readFile, mkdir, unlink } from 'node:fs/promises';
import { isAbsolute, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { foundation } from './foundationRef.js';

const MAX_BYTES = 64 * 1024;
const KINDS = new Set(['agent', 'skill', 'mcp', 'workbench', 'knowledge', 'plugin']);
const SKINS = new Set(['native', 'decorative']);
const RESERVED_IDS = new Set(['all', '__proto__', 'prototype', 'constructor']);
const CHANGE_FIELDS = {
	setSkin: ['type', 'skin'], createGroup: ['type', 'id', 'name'], renameGroup: ['type', 'id', 'name'],
	deleteGroup: ['type', 'id'], favorite: ['type', 'groupId', 'item', 'saved'], import: ['type', 'groups'],
};
const defaults = () => ({ revision: 0, skin: 'native', groups: [{ id: 'default', name: '默认收藏', items: [] }] });
function invalid(message) { throw Object.assign(new Error(message), { code: 'invalid-preferences' }); }
function fields(value, allowed) {
	if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) { invalid('偏好输入必须是对象'); }
	const keys = Reflect.ownKeys(value);
	if (keys.length !== allowed.length || keys.some(key => !allowed.includes(key))) { invalid('偏好输入包含未知字段或缺少必填字段'); }
}
function boundedJSON(value) {
	let text;
	try { text = JSON.stringify(value); } catch { invalid('偏好输入无法序列化'); }
	if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) { invalid('偏好输入不得超过64KB'); }
	return text;
}
function revisionOf(value) {
	if (!Number.isSafeInteger(value) || value < 0) { invalid('expectedRevision/revision必须是非负安全整数'); }
}
function idOf(value) {
	if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) || RESERVED_IDS.has(value)) { invalid('收藏分组id不合法'); }
	return value;
}
function nameOf(value) {
	if (typeof value !== 'string' || !value.trim() || value.trim().length > 40 || /[\u0000-\u001f\u007f]/.test(value)) { invalid('分组名称须为1至40字且不含控制字符'); }
	return value.trim();
}
function itemOf(value) {
	if (typeof value !== 'string') { invalid('收藏条目须为kind:slug'); }
	const parts = value.split(':');
	if (parts.length !== 2 || !KINDS.has(parts[0]) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(parts[1]) || parts[1].includes('..')) { invalid('收藏条目的种类或slug不合法'); }
	return value;
}
function groupOf(value) {
	fields(value, ['id', 'name', 'items']);
	if (!Array.isArray(value.items) || value.items.length > 500) { invalid('收藏条目不得超过500个'); }
	return { id: idOf(value.id), name: nameOf(value.name), items: value.items.map(itemOf) };
}
function validateState(value) {
	fields(value, ['revision', 'skin', 'groups']);
	revisionOf(value.revision);
	if (!SKINS.has(value.skin)) { invalid('未知商城皮肤'); }
	if (!Array.isArray(value.groups) || !value.groups.length || value.groups.length > 20) { invalid('收藏分组须为1至20个'); }
	const ids = new Set(), names = new Set();
	let count = 0;
	const groups = value.groups.map(group => {
		const checked = groupOf(group);
		if (group.name !== checked.name || ids.has(checked.id) || names.has(checked.name) || new Set(checked.items).size !== checked.items.length) { invalid('偏好文件含重复分组、条目或不规范名称'); }
		ids.add(checked.id); names.add(checked.name); count += checked.items.length;
		return checked;
	});
	if (!ids.has('default') || count > 500) { invalid('须保留默认收藏分组，总条目不得超过500个'); }
	return { revision: value.revision, skin: value.skin, groups };
}
function targetOf({ dataRoot, endpoint } = {}) {
	if (typeof dataRoot !== 'string' || !isAbsolute(dataRoot) || dataRoot.includes('\0')) { invalid('dataRoot必须是绝对路径'); }
	let url;
	try {
		if (typeof endpoint !== 'string' || endpoint !== endpoint.trim() || !/^https?:\/\//i.test(endpoint)) { invalid('endpoint须为固定HTTP(S) URL'); }
		url = new URL(endpoint);
	} catch { invalid('endpoint须为固定HTTP(S) URL'); }
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) { invalid('endpoint不得含credentials且须为HTTP(S) URL'); }
	const hash = createHash('sha256').update(url.href).digest('hex');
	return join(dataRoot, 'marketplace', 'preferences', hash + '.json');
}
async function readAt(file) {
	let text;
	try { text = await readFile(file, 'utf8'); } catch (error) {
		if (error?.code === 'ENOENT') { return defaults(); }
		throw error;
	}
	if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) { invalid('偏好文件超过64KB'); }
	let value;
	try { value = JSON.parse(text); } catch { invalid('偏好文件JSON损坏，未覆盖'); }
	return validateState(value);
}
function changeOf(change) {
	boundedJSON(change);
	const type = change?.type;
	if (typeof type !== 'string' || !Object.hasOwn(CHANGE_FIELDS, type)) { invalid('未知偏好操作'); }
	fields(change, CHANGE_FIELDS[type]);
	switch (type) {
		case 'setSkin':
			if (!SKINS.has(change.skin)) { invalid('未知商城皮肤'); }
			return { type, skin: change.skin };
		case 'createGroup': case 'renameGroup':
			return { type, id: idOf(change.id), name: nameOf(change.name) };
		case 'deleteGroup': return { type, id: idOf(change.id) };
		case 'favorite':
			if (typeof change.saved !== 'boolean') { invalid('saved必须是布尔值'); }
			return { type, groupId: idOf(change.groupId), item: itemOf(change.item), saved: change.saved };
		case 'import':
			if (!Array.isArray(change.groups) || change.groups.length > 20) { invalid('导入分组不得超过20个'); }
			return { type, groups: change.groups.map(groupOf) };
	}
}
function applyChange(current, change) {
	const next = { ...current, groups: current.groups.map(group => ({ ...group, items: [...group.items] })) };
	const find = id => {
		const group = next.groups.find(entry => entry.id === id);
		if (!group) { invalid('收藏分组不存在'); }
		return group;
	};
	switch (change.type) {
		case 'setSkin': next.skin = change.skin; break;
		case 'createGroup':
			if (next.groups.some(group => group.id === change.id || group.name === change.name)) { invalid('收藏分组id或名称已存在'); }
			next.groups.push({ id: change.id, name: change.name, items: [] });
			break;
		case 'renameGroup':
			if (next.groups.some(group => group.id !== change.id && group.name === change.name)) { invalid('收藏分组名称已存在'); }
			find(change.id).name = change.name;
			break;
		case 'deleteGroup':
			if (change.id === 'default') { invalid('默认收藏分组不可删除'); }
			find(change.id);
			next.groups = next.groups.filter(group => group.id !== change.id);
			break;
		case 'favorite': {
			const group = find(change.groupId);
			if (change.saved) {
				if (!group.items.includes(change.item)) { group.items.push(change.item); }
			} else { group.items = group.items.filter(item => item !== change.item); }
			break;
		}
		case 'import':
			for (const incoming of change.groups) {
				let group = next.groups.find(entry => entry.id === incoming.id) ?? next.groups.find(entry => entry.name === incoming.name);
				if (!group) { group = { id: incoming.id, name: incoming.name, items: [] }; next.groups.push(group); }
				for (const item of incoming.items) { if (!group.items.includes(item)) { group.items.push(item); } }
			}
			break;
	}
	return validateState(next);
}

export async function readPreferences(options) {
	return readAt(targetOf(options));
}

export async function updatePreferences({ dataRoot, endpoint, expectedRevision, change } = {}) {
	const file = targetOf({ dataRoot, endpoint });
	revisionOf(expectedRevision);
	const operation = changeOf(change);
	const service = foundation();
	if (!['lockFileFor', 'acquireFileLock', 'atomicWriteFile'].every(key => typeof service[key] === 'function')) { throw new Error('foundation服务缺少偏好持久化API，未保存'); }
	await mkdir(dirname(file), { recursive: true });
	const release = await service.acquireFileLock(service.lockFileFor(file), { label: '商城偏好' });
	const tmpPostfix = '.' + randomUUID() + '.vssaros-tmp';
	try {
		const current = await readAt(file);
		if (current.revision !== expectedRevision) {
			throw Object.assign(new Error('商城偏好已被另一窗口更新，请重新读取'), { code: 'revision-conflict', current });
		}
		const next = applyChange(current, operation);
		if (JSON.stringify(next) === JSON.stringify(current)) { return current; }
		if (current.revision === Number.MAX_SAFE_INTEGER) { invalid('偏好revision已达上限'); }
		next.revision = current.revision + 1;
		await service.atomicWriteFile(file, boundedJSON(next), { tmpPostfix });
		return next;
	} finally {
		try { await unlink(`${file}.${process.pid}${tmpPostfix}`).catch(() => {}); } finally { await release(); }
	}
}
