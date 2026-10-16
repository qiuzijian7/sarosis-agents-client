/**
 * 存储存档的**磁盘 I/O** —— 与 `core/storage.js` 的纯逻辑分开（同 `cookieStore.js` 与 `cookies.js` 的关系）。
 *
 * 两条纪律照抄 cookie 那一份（它们都是"崩在中间 / 读不出来"的归因成本最高的地方）：
 *  ① **不抛错**，一律返回判别式结果；
 *  ② 写入走 **临时文件 + rename** 的原子替换（半截 JSON 的症状是"上次明明导出成功，这次读不出来"）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseStorageEnvelope } from './storage.js';

const messageOf = error => (error instanceof Error ? error.message : String(error));

/**
 * 读一个存储存档并解析。
 * @returns 判别式结果（见 `parseStorageEnvelope`）；文件不存在时 `{ ok:false, reason:'missing-file' }`。
 */
export function readStorageStore(filePath) {
	if (!filePath) { return { ok: false, reason: 'no-path' }; }
	if (!existsSync(filePath)) { return { ok: false, reason: 'missing-file' }; }
	let text;
	try {
		text = readFileSync(filePath, 'utf8');
	} catch (error) {
		return { ok: false, reason: `read-failed(${messageOf(error)})` };
	}
	return parseStorageEnvelope(text);
}

/** 原子写一个存储存档：`{ ok:true, path }` 或 `{ ok:false, reason }`。 */
export function writeStorageStore(filePath, envelope) {
	if (!filePath) { return { ok: false, reason: 'no-path' }; }
	const tmp = `${filePath}.tmp`;
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(tmp, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
		renameSync(tmp, filePath);
		return { ok: true, path: filePath };
	} catch (error) {
		try { rmSync(tmp, { force: true }); } catch { /* 清理失败不该改变结论 */ }
		return { ok: false, reason: `write-failed(${messageOf(error)})` };
	}
}
