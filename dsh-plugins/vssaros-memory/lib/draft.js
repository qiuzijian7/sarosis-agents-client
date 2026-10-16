// @vssaros/dsh-memory — draft I/O（主机侧）：自动沉淀候选的草稿落盘与读回。
//
// 存储位置：`<数据根>/memory-drafts/drafts.jsonl` —— 与审计账本**同级但分家**
// （目录推导与 `lib/audit.js` 逐字节同形：都走同一个 `dataRootOf`，`check-host-config.mjs` 的
//  B2 契约守着这个口径 ✓）。为什么**不**放网关的 `.agentmemory/`：那是**网关**的数据目录，
// 插件对它应当只读（"单写者是网关"是既存不变量 ✓）。
//
// 为什么是"草稿"而不是直接写长期层：见 `core/distill.js` 文件头的约束 ②（自动提取必然有误，
// 直写＝把错误喂给之后每一轮 ✗）。草稿等用户显式提升 —— 与我们给 `skill_manage` 定的同一条判据 ✓。
//
// ⚠ 并发假设与审计账本**完全一致**（追加写 + 单行 < 4 KB 的原子性），**不加锁** ✓
//（给这个只增文件上文件锁会引入新的卡死面 ✗）。
// ⚠ 失败绝不抛出（照 audit 的纪律 ②）：草稿丢了不影响任何主流程 —— 尤其它跑在
// `agent/turn-stopping` 之后的后台里，那里**任何一个未捕获异常都不该冒到会话层** ✓。

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataRootOf } from './audit.js';
import { DRAFT_DIR_NAME, DRAFT_FILE_NAME, DRAFT_MAX_ROWS_DEFAULT, DRAFT_TTL_MS_DEFAULT, buildDraftRow, pruneDrafts, seenDigestsOf, shouldCompactDrafts } from './core/distill.js';

/** 草稿目录：`<数据根>/memory-drafts`。 */
export function draftDirOf(config) {
	return join(dataRootOf(config), DRAFT_DIR_NAME);
}

/** 草稿文件：`<数据根>/memory-drafts/drafts.jsonl`。 */
export function draftFileOf(config) {
	return join(draftDirOf(config), DRAFT_FILE_NAME);
}

/** 读回行数上限：草稿是"待办"性质 ⇒ 只关心最近的若干条（防长驻实例把整个文件读进内存 ✗）。 */
export const DRAFT_READ_LIMIT = 200;

/**
 * 把 JSONL 正文解析成行数组（**逐行容错**：坏行丢弃，不让一行坏数据带走整个草稿区 ✓）。
 * @param {string} text - 文件正文。
 * @returns {object[]} 行对象。
 */
export function parseDraftLines(text) {
	if (typeof text !== 'string' || !text) { return []; }
	const out = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) { continue; }
		try {
			const row = JSON.parse(trimmed);
			if (row && typeof row === 'object' && typeof row.digest === 'string' && row.digest) { out.push(row); }
		} catch { /* 坏行丢掉：草稿区不该因为一行坏了就整块读不出来 ✓ */ }
	}
	return out;
}

/**
 * 建一个草稿读写器（**失败绝不抛出** —— 见文件头纪律）。
 *
 * @param {object} config - 插件 config。
 * @param {{logger?: {warn?: Function}, readLimit?: number}} [deps] - 依赖注入（探针可压小 readLimit）。
 * @returns {{append: (rows: readonly object[]) => Promise<number>, read: () => Promise<object[]>, seen: () => Promise<Set<string>>,
 *   failures: () => number, file: () => string, dir: () => string}} 读写器。
 */
export function createDraftStore(config, deps = {}) {
	const file = draftFileOf(config);
	const dir = draftDirOf(config);
	const readLimit = Number.isInteger(deps.readLimit) && deps.readLimit > 0 ? deps.readLimit : DRAFT_READ_LIMIT;
	// 治理参数可注入：探针把上限压到 3 就能断言压缩路径 ✓（生产走默认值 ✓）
	const maxRows = Number.isInteger(deps.maxRows) && deps.maxRows > 0 ? deps.maxRows : DRAFT_MAX_ROWS_DEFAULT;
	const ttlMs = Number.isFinite(deps.ttlMs) && deps.ttlMs > 0 ? deps.ttlMs : DRAFT_TTL_MS_DEFAULT;
	let failures = 0;
	let warnedOnce = false;
	/** 压缩次数与累计丢弃条数（探针/页面自诊断："治理到底跑了没有"必须可观测 ✓）。 */
	let compactions = 0;
	let droppedTotal = 0;

	const warnOnce = error => {
		failures++;
		if (warnedOnce) { return; }
		warnedOnce = true;
		// 只喊一次：持续写不动时每回合都喊会把 Host 日志刷满 ✗（照 audit 的同一条先例 ✓）
		try {
			deps.logger?.warn?.(`[vssaros-memory] 草稿写入失败（后续同类失败不再重复报告）：${error?.message ?? error}`);
		} catch { /* 记录失败这件事本身绝不再抛 ✓ */ }
	};

	/**
	 * 原子重写整份草稿（临时文件 + `rename`）—— 中途崩了也不会留下**半截**草稿 ✓
	 *（`appendFile` 追加不怕崩，但"压缩"是替换整份，必须原子 ✓）。
	 */
	async function compact(rows) {
		const tmp = `${file}.tmp-${process.pid}`;
		await writeFile(tmp, rows.length ? `${rows.map(row => JSON.stringify(row)).join('\n')}\n` : '', 'utf8');
		await rename(tmp, file);
		compactions++;
	}

	/** 追一批草稿行（已是 `buildDraftRow` 的形状）；返回实际写入条数（失败返回 0）。 */
	async function append(rows) {
		const list = Array.isArray(rows) ? rows.filter(row => row && typeof row.digest === 'string' && row.digest) : [];
		if (list.length === 0) { return 0; }
		try {
			await mkdir(dir, { recursive: true });
			await appendFile(file, `${list.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf8');
			// ★ 治理（2026-10-13）：草稿**只增**且是**待办**性质 ⇒ 会无限长（审计账本的同类问题，
			// 那边靠轮转归档 ✓；草稿过期直接丢 ✓，理由见 `core/distill.js` 的 `pruneDrafts`）。
			// ⚠ 先追加、**后**判断该不该压缩（顺序很重要）：这样"压缩失败"最坏只是草稿没瘦身，
			// 而**刚写进去的那批一定已经在文件里** ✓（反过来先压缩再追加，压缩一失败就等于把这批丢了 ✗）。
			// ⚠ 整段吞异常：治理是**后台的自我维护**，它绝不该让"本次沉淀"看起来失败 ✓。
			try {
				const existing = parseDraftLines(await readFile(file, 'utf8'));
				const now = Date.now();
				if (shouldCompactDrafts(existing, { now, maxRows, ttlMs })) {
					const { kept, droppedByTtl, droppedByLimit } = pruneDrafts(existing, { now, maxRows, ttlMs });
					await compact(kept);
					droppedTotal += droppedByTtl + droppedByLimit;
				}
			} catch (error) {
				warnOnce(error);
			}
			return list.length;
		} catch (error) {
			warnOnce(error);
			return 0;
		}
	}

	/** 读回草稿（最近 `readLimit` 条；文件不存在 ⇒ 空数组，**不是**错误 ✓）。 */
	async function read() {
		try {
			const text = await readFile(file, 'utf8');
			const rows = parseDraftLines(text);
			return rows.length > readLimit ? rows.slice(-readLimit) : rows;
		} catch {
			return [];
		}
	}

	/** 已见过的指纹（去重表；给 `extractCandidates` 用 ✓）。 */
	async function seen() {
		return seenDigestsOf(await read());
	}

	/**
	 * 改一条草稿的状态（`draft` → `promoted` / `rejected`）——**原子重写**整份 ✓。
	 *
	 * ⚠ 为什么用"读-改-写整份"而不是"追加一条状态变更行"：草稿是**待办**（`read()` 只返回行本身，
	 * 没有"按时间回放状态"的语义 ✓）⇒ 追加状态行会让每次读回都要做一次折叠（复杂且容易错 ✗）。
	 * 而草稿量小（上限 500 ✓）⇒ 整份重写的代价可以接受 ✓。
	 *
	 * @param {string} id - 草稿 id。
	 * @param {string} status - 目标状态（`DRAFT_STATUSES` 之一）。
	 * @returns {Promise<{ok: boolean, row?: object, error?: string}>} 结果。
	 */
	async function mark(id, status) {
		if (typeof id !== 'string' || !id) { return { ok: false, error: 'id 为空' }; }
		try {
			const rows = parseDraftLines(await readFile(file, 'utf8'));
			const index = rows.findIndex(row => row.id === id);
			if (index === -1) { return { ok: false, error: `草稿不存在：${id}` }; }
			const updated = [...rows.slice(0, index), { ...rows[index], status, updatedAt: Date.now() }, ...rows.slice(index + 1)];
			await compact(updated);
			return { ok: true, row: updated[index] };
		} catch (error) {
			warnOnce(error);
			return { ok: false, error: String(error?.message ?? error) };
		}
	}

	return {
		append,
		read,
		seen,
		mark,
		failures: () => failures,
		file: () => file,
		dir: () => dir,
		/** 治理自诊断（页面/探针）：压缩了几次、累计丢了几条 ✓（"没产出"与"没治理"要分得清 ✓）。 */
		stats: () => ({ compactions, dropped: droppedTotal, maxRows, ttlMs }),
	};
}

/**
 * 把候选转成待落盘的行（`buildDraftRow` 的薄包装，**纯函数**，便于探针直接用 ✓）。
 * @param {readonly object[]} candidates - `extractCandidates` 的产物。
 * @param {{status?: string}} [options] - 初始状态。
 * @returns {object[]} 待落盘行。
 */
export function draftRowsOf(candidates, options = {}) {
	return (Array.isArray(candidates) ? candidates : []).map(candidate => buildDraftRow(candidate, options));
}
