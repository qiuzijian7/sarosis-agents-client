// @vssaros/dsh-workbenches — 工作台状态存储（state.json）。
//
// 照搬 dsh-desktop `packages/dsh-desktop-workbenches/state.mjs`（MIT，Copyright (c) 2026 DataElement，
// 见本包 THIRD_PARTY.md）。逻辑**不改**，只做两处适配：
//   · 去掉"旧 workbenchId → owner/repo"的迁移分支（我们没有历史数据要迁）；
//   · 身份格式放宽到同时接受 `vssaros/<module>`（内置保留命名空间，与 `owner/repo` 同形，正则天然覆盖）。
//
// 关键语义（必须保持，守卫 `test/run-workbenches-check.mjs` 逐条钉住）：
//   · 一个会话最多属于一个工作台；既有归属**不可改、不可删**；
//   · 新归属只能指向已添加（added）的工作台；
//   · 删除工作台必须保留它的笔记与工作区可见性；
//   · revision 乐观锁：写入方 revision ≠ 磁盘 revision ⇒ 409；
//   · 原子写（临时文件 wx + 0o600 + rename）；读到损坏数据 ⇒ 报 500，**绝不静默重置**。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_STATE_BYTES = 1024 * 1024;

export class StateError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.status = status;
	}
}

const fail = message => { throw new StateError(message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(value)
	&& !['__proto__', 'prototype', 'constructor'].includes(value);
/** `owner/repo`（第三方，小写）或 `vssaros/<module>`（内置）。 */
export const validWorkbenchId = value => typeof value === 'string'
	&& /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(value) && value.length <= 255;

export function emptyState() {
	return { version: 1, added: [], pinned: [], favorites: [], active: null, sessionBindings: {}, recentSessions: {}, notes: {}, hiddenWorkspaces: {} };
}

export function validateState(value, previous) {
	if (!isObject(value) || value.version !== 1) { fail('不支持的工作台状态版本。'); }
	if (Object.keys(value).some(key => !Object.hasOwn(emptyState(), key))) { fail('工作台状态里有未知字段。'); }
	for (const key of ['added', 'pinned', 'favorites']) {
		if (!Array.isArray(value[key]) || !value[key].every(validWorkbenchId) || new Set(value[key]).size !== value[key].length) {
			fail(`${key} 里的工作台身份不合法。`);
		}
	}
	if (value.pinned.some(id => !value.added.includes(id))) { fail('置顶的工作台必须已添加。'); }
	if (value.active !== null && (!validWorkbenchId(value.active) || !value.added.includes(value.active))) { fail('当前工作台必须已添加。'); }
	if (!isObject(value.sessionBindings) || !Object.entries(value.sessionBindings).every(([session, owner]) => validId(session) && validWorkbenchId(owner))) { fail('sessionBindings 不合法。'); }
	if (!isObject(value.recentSessions) || !Object.entries(value.recentSessions).every(([owner, session]) => validWorkbenchId(owner) && validId(session))) { fail('recentSessions 不合法。'); }
	if (!isObject(value.notes) || !Object.entries(value.notes).every(([owner, note]) => validWorkbenchId(owner) && typeof note === 'string' && note.length <= 200000)) { fail('notes 不合法。'); }
	if (!isObject(value.hiddenWorkspaces) || !Object.entries(value.hiddenWorkspaces).every(([owner, workspaces]) =>
		validWorkbenchId(owner) && Array.isArray(workspaces) && workspaces.every(validId) && new Set(workspaces).size === workspaces.length)) {
		fail('hiddenWorkspaces 不合法。');
	}
	for (const [workbench, session] of Object.entries(value.recentSessions)) {
		if (value.sessionBindings[session] !== workbench) { fail('最近会话必须属于它的工作台。'); }
	}
	if (previous) {
		for (const [session, owner] of Object.entries(previous.sessionBindings)) {
			if (value.sessionBindings[session] !== owner) { fail('不能改变或删除已有会话的工作台归属。'); }
		}
		for (const [session, owner] of Object.entries(value.sessionBindings)) {
			if (!Object.hasOwn(previous.sessionBindings, session) && !value.added.includes(owner)) { fail('新的会话归属只能指向已添加的工作台。'); }
		}
		for (const id of Object.keys(previous.notes)) {
			if (!Object.hasOwn(value.notes, id)) { fail('移除工作台时必须保留它的笔记。'); }
		}
		for (const id of Object.keys(previous.hiddenWorkspaces)) {
			if (!Object.hasOwn(value.hiddenWorkspaces, id)) { fail('移除工作台时必须保留它的工作区可见性设置。'); }
		}
	}
	if (Buffer.byteLength(JSON.stringify(value)) > MAX_STATE_BYTES - 100) { fail('工作台状态太大。'); }
	return structuredClone(value);
}

/** 同一 Host 实例内所有读写共用一个队列；每次都读盘 ⇒ 损坏数据会被报出来而不是被静默覆盖。 */
export function createStateStore(root) {
	const path = join(root, 'state.json');
	let pending = Promise.resolve();
	const queue = operation => {
		const result = pending.then(operation);
		pending = result.catch(() => { });
		return result;
	};
	async function read() {
		let raw;
		try {
			raw = await readFile(path);
		} catch (error) {
			if (error.code === 'ENOENT') { return { revision: 0, state: emptyState() }; }
			throw error;
		}
		try {
			if (raw.length > MAX_STATE_BYTES) { throw new Error('超过大小上限'); }
			const saved = JSON.parse(raw.toString('utf8'));
			if (!Number.isSafeInteger(saved.revision) || saved.revision < 0) { throw new Error('revision 不合法'); }
			return { revision: saved.revision, state: validateState(saved.state) };
		} catch {
			throw new StateError('已保存的工作台状态已损坏：先修复或恢复 state.json，再保存。', 500);
		}
	}
	const write = input => {
		// 入队前先快照，调用方之后改对象不会影响进行中的写入
		const payload = structuredClone(input);
		return queue(async () => {
			if (!isObject(payload) || !Number.isSafeInteger(payload.revision) || payload.revision < 0) { fail('需要合法的 revision。'); }
			const current = await read();
			if (payload.revision !== current.revision) { throw new StateError('工作台状态已在别处更新，请重新加载后再保存。', 409); }
			if (current.revision === Number.MAX_SAFE_INTEGER) { throw new StateError('工作台状态 revision 已用尽。', 500); }
			const next = { revision: current.revision + 1, state: validateState(payload.state, current.state) };
			await mkdir(root, { recursive: true });
			const temporary = join(root, `.state-${randomUUID()}.tmp`);
			try {
				await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
				await rename(temporary, path);
			} finally {
				await rm(temporary, { force: true });
			}
			return next;
		});
	};
	return { read: () => queue(read), write };
}
