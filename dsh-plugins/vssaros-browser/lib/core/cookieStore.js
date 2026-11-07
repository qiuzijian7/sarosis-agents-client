/**
 * Cookie 存档的**磁盘 I/O** —— 与 `core/cookies.js` 的纯逻辑分开。
 *
 * 为什么分开：纯逻辑那边要能被单测**不碰盘**地跑（域名匹配、净化、围栏这些都是安全相关的判定，
 * 必须每条都有用例）；这里只做"读一个文件 / 原子写一个文件"。混在一起会让"想测围栏就得准备临时目录"。
 *
 * 两条纪律：
 *  ① **不抛错**，一律返回判别式结果 —— "读不出来 / 写不进去"是调用方要如实告诉用户的状态
 *     （与 `core/cookies.js` 的 `parseCookieStoreEnvelope` 同纪律），不是异常。
 *  ② 写入走 **临时文件 + rename** 的原子替换：崩在中间不会留下半截 JSON（半截 JSON 的症状是
 *     "上次明明导出成功，这次读不出来"，最难归因）。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseCookieStoreEnvelope } from './cookies.js';

const messageOf = error => (error instanceof Error ? error.message : String(error));

/**
 * 读一个 cookie 存档并解析。
 * @returns 解析结果（判别式，见 `parseCookieStoreEnvelope`）；文件不存在时 `{ ok:false, reason:'missing-file' }`。
 */
export function readCookieStore(filePath) {
	if (!filePath) { return { ok: false, reason: 'no-path' }; }
	if (!existsSync(filePath)) { return { ok: false, reason: 'missing-file' }; }
	let text;
	try {
		text = readFileSync(filePath, 'utf8');
	} catch (error) {
		return { ok: false, reason: `read-failed(${messageOf(error)})` };
	}
	return parseCookieStoreEnvelope(text);
}

/**
 * 原子写一个 cookie 存档。
 *
 * ★ 2026-11-07（P3）：存档里是**活凭据** ⇒ 只许本人读写：文件 `0600`、新建目录 `0700`（临时文件一创建就是 0600，
 *   rename 保留权限；已有文件也再 chmod 一次）。⚠ Windows 忽略 POSIX mode —— 那里靠的是用户目录本来的 ACL
 *   （数据根在 `%USERPROFILE%` 下）；不加密（Node 没有内建的 DPAPI，不为它引原生模块），所以导出默认关、每次审批。
 * @returns `{ ok:true, path }` 或 `{ ok:false, reason }`。
 */
export function writeCookieStore(filePath, envelope) {
	if (!filePath) { return { ok: false, reason: 'no-path' }; }
	const tmp = `${filePath}.tmp`;
	try {
		mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
		writeFileSync(tmp, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
		renameSync(tmp, filePath);
		try { chmodSync(filePath, 0o600); } catch { /* 改不了权限不改变"写成功"的结论 */ }
		return { ok: true, path: filePath };
	} catch (error) {
		try { rmSync(tmp, { force: true }); } catch { /* 清理失败不该改变结论 */ }
		return { ok: false, reason: `write-failed(${messageOf(error)})` };
	}
}
