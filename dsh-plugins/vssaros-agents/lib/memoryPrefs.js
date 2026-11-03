// @vssaros/dsh-agents — 记忆偏好（2026-11-03）
//
// 为什么要有它：「回合末自动提交」原来只能靠插件 patch 里的 `memoryAutoCommit` 开关，
// 用户在聊天框「记忆设置」里点不动（只读展示）。偏好必须能在运行期由人改，并且**立刻生效**，
// 所以落一个小文件 `<数据根>/memory-prefs.json`，优先级：偏好文件 > 插件 config > 缺省（开）。
//
// 为什么同步读 + mtime 缓存：`memoryAutoCommitOnTurn` 在回合钩子里被同步调用（热路径），
// 不能每次都读盘解析；稳态只有一次 stat。
// 为什么是**全局**一个开关而不是每个记忆各一个：用户的诉求是"演化链要不要自动落点"，
// 这是对所有记忆（Bot 的 + 工作区的）一致的偏好，分开存只会让人对不上。

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataRootOf } from './store.js';

export const MEMORY_PREFS_FILE = 'memory-prefs.json';

/** 偏好文件的绝对路径。 */
export function memoryPrefsPathOf(config) {
	return join(dataRootOf(config), MEMORY_PREFS_FILE);
}

let cache = { file: '', mtimeMs: -1, size: -1, value: {} };

/**
 * 读偏好（同步、带缓存）。文件不存在 / 坏 JSON ⇒ `{}`（等于"没有覆盖"，回落到 config）。
 * 只认已知键、只认布尔：手改成别的类型当没写，绝不把乱值带进判定。
 */
export function readMemoryPrefs(config) {
	const file = memoryPrefsPathOf(config);
	let info;
	try { info = statSync(file); } catch {
		cache = { file, mtimeMs: -1, size: -1, value: {} };
		return {};
	}
	if (cache.file === file && cache.mtimeMs === info.mtimeMs && cache.size === info.size) {
		return cache.value;
	}
	let value = {};
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8'));
		if (parsed && typeof parsed === 'object') {
			if (typeof parsed.autoCommit === 'boolean') { value.autoCommit = parsed.autoCommit; }
		}
	} catch {
		value = {};
	}
	cache = { file, mtimeMs: info.mtimeMs, size: info.size, value };
	return value;
}

/**
 * 改偏好（只接受 `autoCommit: boolean`）。其它键直接忽略，类型不对抛 400。
 * @returns 写入后的完整偏好
 */
export function setMemoryPrefs(config, patch) {
	const next = { ...readMemoryPrefs(config) };
	if (patch && Object.prototype.hasOwnProperty.call(patch, 'autoCommit')) {
		if (typeof patch.autoCommit !== 'boolean') {
			throw Object.assign(new Error('autoCommit 要是 true / false'), { httpStatus: 400 });
		}
		next.autoCommit = patch.autoCommit;
	}
	const file = memoryPrefsPathOf(config);
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp.${process.pid}.${Date.now().toString(36)}`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
	renameSync(tmp, file);
	cache = { file: '', mtimeMs: -1, size: -1, value: {} };
	return readMemoryPrefs(config);
}
