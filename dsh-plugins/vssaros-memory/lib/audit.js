// @vssaros/dsh-memory — audit I/O（主机侧）：账本落盘、轮转、读回。
//
// 存储位置（用户 2026-10-12 拍板）：**插件侧 JSONL** ✓
//   `<数据根>/memory-audit/audit.jsonl`
//   为什么是独立子目录、而不是网关的 `.agentmemory/`：那是**网关**的数据目录，它会做压缩 /
//   清理 / 索引重建 ⇒ 插件往里塞文件会与它的生命周期假设打架 ✗（也违反既有的"单写者是网关"
//   不变量：插件对 `.agentmemory/` 应当只读）。
//
// 数据根口径与 6 个模块**逐字节同形**（`check-host-config.mjs` 的 B2 契约守着）。
// ⚠ memory 模块**先前没有**数据根概念（它只认网关 URL）—— 这是本轮新引入的 ✓；
//   壳已把 `VSSAROS_DATA_ROOT` 注入 Host 子进程（`dshHostSupervisor.ts:557` 的注释与实测 L3 都在），
//   ⇒ dev 实例不会往**生产**目录写账本（2026-10-11 那类"dev 读生产"事故的同型防线 ✓）。
//
// ⚠ 并发假设（**如实写明**）：多个 Host 进程（多窗口）可能同时追加同一文件。这里依赖
//   `appendFile` 的 `O_APPEND` 语义在单行 < 4 KB 时是原子的（POSIX 的 PIPE_BUF 保证；
//   Windows 上也以追加打开 ⇒ 实践可行）。**没有**加锁 —— 若将来出现交错行，应按行长度设限
//   或改成"每进程一个文件"，而不是给这个只增账本上文件锁（那会引入新的卡死面 ✗）。

import { appendFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AUDIT_DIR_NAME, AUDIT_FILE_NAME, AUDIT_MAX_BYTES_DEFAULT, rotationSuffixOf, shouldRotate } from './core/audit.js';

export function dataRootOf(config) {
	const configured = typeof config?.dataRoot === 'string' ? config.dataRoot.trim() : '';
	if (configured) {
		return configured;
	}
	const fromEnv = typeof process.env.VSSAROS_DATA_ROOT === 'string' ? process.env.VSSAROS_DATA_ROOT.trim() : '';
	return fromEnv || join(homedir(), '.vssaros');
}

/** 账本目录：`<数据根>/memory-audit`。 */
export function auditDirOf(config) {
	return join(dataRootOf(config), AUDIT_DIR_NAME);
}

/** 账本文件：`<数据根>/memory-audit/audit.jsonl`。 */
export function auditFileOf(config) {
	return join(auditDirOf(config), AUDIT_FILE_NAME);
}

/** 归档保留份数（默认 3）。 */
const KEEP_ARCHIVES = 3;

/**
 * 建一个账本写入器（**失败绝不抛出** —— 见 `core/audit.js` 的纪律 ②）。
 *
 * @param {object} config - 插件 config。
 * @param {{logger?: {warn?: Function}, maxBytes?: number}} [deps] - {logger, maxBytes}（探针用 maxBytes 压小阈值来断言轮转）。
 * @returns {{append: (row: object) => Promise<boolean>, file: () => string, dir: () => string, failures: () => number}} 写入器。
 */
export function createAuditWriter(config, deps = {}) {
	let failures = 0;
	let warnedOnce = false;
	const maxBytes = Number.isFinite(deps.maxBytes) && deps.maxBytes > 0 ? deps.maxBytes : AUDIT_MAX_BYTES_DEFAULT;

	const warnOnce = error => {
		failures++;
		if (warnedOnce) { return; }
		warnedOnce = true;
		// 只喊一次：账本持续写不动时每轮都喊会把 Host 日志刷满 ✗（本仓有"60s 节流"的先例 ✓）
		try {
			deps.logger?.warn?.(`[vssaros-memory] 审计账本写入失败（后续同类失败不再重复报告）：${error?.message ?? error}`);
		} catch { /* 记录失败这件事本身绝不再抛 ✓ */ }
	};

	/** 超阈值就把当前文件改名归档；归档只保留最近 `KEEP_ARCHIVES` 份。 */
	async function maybeRotate(file) {
		let bytes = 0;
		try { bytes = (await stat(file)).size; } catch { return; }
		if (!shouldRotate({ bytes, maxBytes })) { return; }
		const dir = auditDirOf(config);
		await rename(file, `${file}.${rotationSuffixOf(Date.now())}`);
		// 按文件名排序 == 按时间排序（后缀是可排序格式 ✓）
		const archives = (await readdir(dir)).filter(n => n.startsWith(`${AUDIT_FILE_NAME}.`)).sort();
		for (const stale of archives.slice(0, Math.max(0, archives.length - KEEP_ARCHIVES))) {
			await rm(join(dir, stale), { force: true });
		}
	}

	return {
		file: () => auditFileOf(config),
		dir: () => auditDirOf(config),
		failures: () => failures,
		/** 追加一行（`row` 由 `core/audit.js` 的 `buildAuditRow` 组装；这里是"只写不管"的落盘）。 */
		async append(row) {
			try {
				await mkdir(auditDirOf(config), { recursive: true });
				const file = auditFileOf(config);
				await maybeRotate(file);
				await appendFile(file, `${JSON.stringify(row)}\n`, 'utf8');
				return true;
			} catch (error) {
				warnOnce(error);
				return false;
			}
		},
	};
}

/**
 * 读回账本（跨会话查询用）—— 返回**最新**的 N 条，按时间顺序排列（最早的在前）。
 *
 * 解析失败的行走 `unparsable` 计数返回（**不静默丢** ✗）：账本被外部编辑器截断过、
 * 或将来格式变更时，"少了几行"必须看得见 ✓。
 *
 * @param {object} config - 插件 config。
 * @param {{limit?: number}} [options] - {limit}。
 * @returns {Promise<{rows: object[], unparsable: number, file: string}>} 读回结果。
 */
export async function readAudit(config, options = {}) {
	const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 50;
	const file = auditFileOf(config);
	let raw = '';
	try {
		raw = await readFile(file, 'utf8');
	} catch {
		return { rows: [], unparsable: 0, file };
	}
	const lines = raw.split('\n').filter(line => line.trim().length > 0);
	const tail = lines.slice(-limit);
	const rows = [];
	let unparsable = 0;
	for (const line of tail) {
		try { rows.push(JSON.parse(line)); } catch { unparsable++; }
	}
	return { rows, unparsable, file };
}
