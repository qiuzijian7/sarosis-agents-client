// @vssaros/dsh-agents — 从 AgentMemory 网关库**生成 MEMORY.md 草稿**（只读；落盘仍由人按「保存」）。
//
// 为什么只做"草稿"而不是直接写：
//   本页签的纪律是「模型没有记忆写口、提交只能人按」（见 memory.js 头注释 ③）。从检索库拉来的条目
//   是**未经审阅**的内容，直接写进常驻前缀等于让库自己改自己的小抄 —— 人必须能先看一眼再决定。
//
// 为什么这里要一个网关客户端（而不是复用 vssaros-memory 插件）：
//   两个插件是**同级的独立包**，彼此没有依赖；为了一次只读查询引入服务定位/事件总线不划算。
//   契约只有一条（`POST {base}/provider/searchMemory`，信封 `{args:[agentId, query, limit]}`），
//   与 `dsh-plugins/vssaros-memory/lib/gateway.js` 的 `search()` 逐字一致（那边有真机钉死的注释）。
//
// ⚠ **不猜端口**：地址只从这四处来 —— config.agentMemoryGatewayUrl → VSSAROS_MEMORY_GATEWAY_URL
//   → AGENTMEMORY_URL → AGENTMEMORY_PORT。全缺 ⇒ 明确报"未配置"，绝不试 3111/3112
//   （猜错会读到**别人的库**，那比"这次没导入"严重得多）。
import { renameWithRetry } from './atomicWrite.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { MEMORY_CHARS_MAX } from './core/memoryLimits.js';
import { readMemoryFile } from './memory.js';
import { dataRootOf } from './store.js';

/** 网关是本地进程：超过这个时间就是它坏了（与 memory 插件的 5s 同口径）。 */
const TIMEOUT_MS = 5000;
/** 草稿默认取多少条（常驻前缀很小，40 条已经足够让人挑）。 */
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

/**
 * 解析记忆网关地址：`config.agentMemoryGatewayUrl` → `VSSAROS_MEMORY_GATEWAY_URL`
 * → `AGENTMEMORY_URL` → `http://127.0.0.1:<AGENTMEMORY_PORT>`。都缺 ⇒ `null`。
 *
 * 后两个名字来自 IDE 主进程（`app.ts._initAgentMemoryEndpoint()` 写进环境，Host 作为子进程继承）；
 * 前两个是我们自己/记忆插件的口径。**只读，不重算端口规则**（真源在 IDE 侧）。
 */
export function agentMemoryGatewayUrl(config, env = process.env) {
	const configured = typeof config?.agentMemoryGatewayUrl === 'string' ? config.agentMemoryGatewayUrl.trim() : '';
	if (configured) {
		return configured.replace(/\/+$/, '');
	}
	for (const key of ['VSSAROS_MEMORY_GATEWAY_URL', 'AGENTMEMORY_URL']) {
		const value = typeof env?.[key] === 'string' ? env[key].trim() : '';
		if (value) {
			return value.replace(/\/+$/, '');
		}
	}
	const port = Number.parseInt(String(env?.AGENTMEMORY_PORT ?? '').trim(), 10);
	return Number.isInteger(port) && port > 0 && port < 65536 ? `http://127.0.0.1:${port}` : null;
}

/** 归一化条数（缺省 40，夹到 (0, 100]）。 */
export function clampImportLimit(value) {
	const n = typeof value === 'string' ? Number(value.trim()) : value;
	if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
		return DEFAULT_LIMIT;
	}
	return Math.min(MAX_LIMIT, Math.trunc(n));
}

async function providerCall(base, method, args) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(`${base}/provider/${encodeURIComponent(method)}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ args: Array.isArray(args) ? args : [args] }),
			signal: ctrl.signal,
		});
		const text = await res.text();
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} ${res.statusText}：${text.slice(0, 200)}`);
		}
		return text ? JSON.parse(text) : null;
	} catch (e) {
		if (e?.name === 'AbortError') {
			throw new Error(`记忆网关 ${TIMEOUT_MS}ms 未响应（${base}）`);
		}
		throw e;
	} finally {
		clearTimeout(timer);
	}
}

/** 把一条记忆压成一行 Markdown（内容里的换行/连续空白折叠，避免一条记忆占一整屏）。 */
function lineOf(entry, index) {
	const type = String(entry?.type ?? 'note').trim() || 'note';
	const content = String(entry?.content ?? '').replace(/\s+/g, ' ').trim();
	if (!content) {
		return '';
	}
	const id = String(entry?.id ?? '').slice(0, 8);
	return `${index + 1}. [${type}] ${content}${id ? `（${id}）` : ''}`;
}

/**
 * 拉一批条目并拼成 `MEMORY.md` 草稿（**不落盘**）。
 *
 * @returns `{ draft, count, truncated, gateway }`
 * @throws 网关未配置 / 不可达 / 返回形状不认识 —— 一律如实报错（不返回空草稿冒充成功）
 */
export async function importMemoryDraft(config, agentId, options = {}) {
	// `options.env` 只为可测：不给就按 process.env（生产路径），测试传 `{}` 排除本机环境干扰
	const base = agentMemoryGatewayUrl(config, options?.env);
	if (!base) {
		throw Object.assign(
			new Error('记忆网关未配置：找不到 AGENTMEMORY_URL / AGENTMEMORY_PORT / VSSAROS_MEMORY_GATEWAY_URL'
				+ '（不猜端口 —— 猜错会读到另一个网关的库）。若是独立部署，可给本插件配 agentMemoryGatewayUrl。'),
			{ httpStatus: 400 },
		);
	}
	const limit = clampImportLimit(options?.limit);
	// 空 query ⇒ searchMemory **全量列出**（与 memory 插件的 memory_list 同一条真机结论：
	// 宿主路由 /search/<agentId> 空查询会回 []，且没有 content ⇒ 不能用）
	const reply = await providerCall(base, 'searchMemory', [String(agentId ?? ''), '', limit]);
	if (reply !== null && !Array.isArray(reply)) {
		throw new Error(`记忆网关返回的形状不认识（期望数组，收到 ${typeof reply}）—— 拒绝拼一份可能骗人的草稿`);
	}
	const items = (reply ?? []).filter(entry => entry && typeof entry === 'object');
	const lines = [];
	for (const entry of items) {
		const line = lineOf(entry, lines.length);
		if (line) {
			lines.push(line);
		}
	}
	if (!lines.length) {
		// 空库是合法状态，但**不是**"导入成功"：如实说，让页面提示用户
		return { draft: '', count: 0, truncated: false, gateway: base, empty: true };
	}
	const header = [
		'# 记忆索引',
		'',
		`> 草稿：从 AgentMemory 检索库导入 ${lines.length} 条（**未保存**）。请删改后按「保存」；`
			+ '保存后要留版本再按「提交快照」。',
		'',
	].join('\n');
	let draft = `${header}${lines.join('\n')}\n`;
	let truncated = false;
	if (draft.length > MEMORY_CHARS_MAX) {
		draft = `${draft.slice(0, MEMORY_CHARS_MAX)}\n…（已截断：上限 ${MEMORY_CHARS_MAX} 字符）`;
		truncated = true;
	}
	return { draft, count: lines.length, truncated, gateway: base };
}

/**
 * 列出 AgentMemory 的**候选条目** + 网关状态（2026-10-27，记忆页签的只读候选块）。
 *
 * 与 `importMemoryDraft` 的差别：
 *   · 那个返回**拼好的整份草稿**（适合"一键导入"）
 *   · 这个返回**逐条数组 + 状态**（适合勾选）—— 用户常常只想挑其中两条
 *
 * ⚠ **不抛**：它是"可选增强"，网关离线绝不能让「记忆」页签整体报错。
 *   三态用 `state` 表达：`online` / `offline` / `unconfigured`（页面据此显示一行状态）。
 * ⚠ 仍然**不猜端口**（走 `agentMemoryGatewayUrl` 的四处来源）。
 */
/**
 * 从任意对象里挑第一个有值的字段（**防御式解析**）。
 *
 * 为什么必须这样：`crystalList` / `governanceAuditQuery` 的返回形状**没有类型定义**
 * （`vssaros-memory/lib/gateway.js` 只标了 `⇒ items`），不同版本的字段名可能不同。
 * 硬写 `x.title` 在字段改名后就变成"全是空字符串"，而页面会显示成"有 N 条但看不到内容"——
 * 那比"没有"更难查。所以：挑常见名 + 挑不到就明确回报，不静默。
 */
function pickField(obj, keys) {
	if (!obj || typeof obj !== 'object') { return ''; }
	for (const k of keys) {
		const v = obj[k];
		if (typeof v === 'string' && v.trim()) { return v.trim(); }
		if (typeof v === 'number' && Number.isFinite(v)) { return String(v); }
	}
	return '';
}

/**
 * 结晶（crystals）与治理审计（audit）—— 给「演化」页签用，**只读**。
 *
 * 与 `candidates` 分开的原因：这三者来自不同网关方法、量级也不同
 * （crystals 通常几条，audit 可能上千），合成一个响应会让页面为了看结晶也拖审计。
 *
 * ⚠ 仍然**不抛**（三态）；两条调用用 `Promise.all` 并发，任一条失败不影响另一条。
 */
export async function listAgentMemoryExtras(config, agentId, options = {}) {
	const base = agentMemoryGatewayUrl(config, options?.env);
	if (!base) {
		return { state: 'unconfigured', gateway: null, crystals: [], audit: [], errors: [] };
	}
	const id = String(agentId ?? '');
	const one = async (method, args, mapOne) => {
		try {
			const reply = await providerCall(base, method, args);
			const arr = Array.isArray(reply)
				? reply
				: (Array.isArray(reply?.items) ? reply.items : []);
			const items = arr.map(mapOne).filter(Boolean);
			return { ok: true, items, raw: arr.length };
		} catch (e) {
			return { ok: false, items: [], raw: 0, error: String((e && e.message) || e) };
		}
	};
	const [crystals, audit] = await Promise.all([
		one('crystalList', [id], (x, i) => {
			const title = pickField(x, ['title', 'name', 'summary', 'label', 'content', 'text']);
			if (!title) { return null; }
			return {
				id: pickField(x, ['id', 'crystalId']) || '#' + i,
				title: title.replace(/\s+/g, ' ').slice(0, 120),
				at: pickField(x, ['at', 'createdAt', 'updatedAt', 'timestamp', 'ts']),
			};
		}),
		one('governanceAuditQuery', [id, {}], (x, i) => {
			const action = pickField(x, ['action', 'op', 'kind', 'type']);
			if (!action) { return null; }
			return {
				id: pickField(x, ['id']) || '#' + i,
				action,
				target: pickField(x, ['target', 'targetId', 'itemId', 'targetType']),
				at: pickField(x, ['at', 'timestamp', 'createdAt', 'ts']),
			};
		}),
	]);
	const state = (crystals.ok || audit.ok) ? 'online' : 'offline';
	return {
		state,
		gateway: base,
		crystals: crystals.items,
		audit: audit.items,
		/* 拿到了数组却一条都解析不出 ⇒ 形状变了（不静默：页面据此提示"字段不认识"） */
		warn: [
			crystals.raw > 0 && crystals.items.length === 0 ? 'crystalList 返回 ' + crystals.raw + ' 条但字段不认识' : '',
			audit.raw > 0 && audit.items.length === 0 ? 'governanceAuditQuery 返回 ' + audit.raw + ' 条但字段不认识' : '',
		].filter(Boolean),
		errors: [crystals.error, audit.error].filter(Boolean),
	};
}

export async function listAgentMemoryCandidates(config, agentId, options = {}) {
	const base = agentMemoryGatewayUrl(config, options?.env);
	if (!base) {
		return { state: 'unconfigured', gateway: null, items: [] };
	}
	const limit = clampImportLimit(options?.limit);
	try {
		const reply = await providerCall(base, 'searchMemory', [String(agentId ?? ''), '', limit]);
		if (reply !== null && !Array.isArray(reply)) {
			throw new Error(`形状不认识（期望数组，收到 ${typeof reply}）`);
		}
		const items = (reply ?? [])
			.filter((e) => e && typeof e === 'object')
			.map((e, i) => ({
				id: String(e.id ?? '#' + i),
				type: String(e.type ?? 'note').trim() || 'note',
				content: String(e.content ?? '').replace(/\s+/g, ' ').trim(),
				at: String(e.createdAt ?? e.at ?? e.timestamp ?? ''),
			}))
			.filter((x) => x.content);
		return { state: 'online', gateway: base, items };
	} catch (e) {
		return { state: 'offline', gateway: base, items: [], error: String((e && e.message) || e) };
	}
}

/* ══ 单向派生：MEMORY.md → AgentMemory（2026-10-27，C 档）═════════════════════
 *
 * 为什么是**单向**而不是双向同步：
 *   `MEMORY.md` 会被注入 system prompt，它必须是**可审阅、可 diff、可回滚**的唯一真源；
 *   如果库能反写文件，那就变成"检索结果自己改自己的小抄"（未审阅内容进前缀）。
 *   ⇒ 文件 → 库，只增不改；库永远不反向改文件。
 *
 * 为什么要去重：用户会重复点「同步」。不去重的话每次点都往库里灌一遍，
 *   检索结果里全是同一条的多个副本（比不写更糟）。
 *   去重状态单独存 `<dataRoot>/agent-memory-sync.json`，**不写进记忆目录**
 *   （记忆目录是 git 工作树，塞状态文件会让 `git status` 永远脏）。 */

const SYNC_FILE = 'agent-memory-sync.json';
const SYNC_MAX_HASHES = 500;
const SYNC_MAX_ENTRIES = 200;
const SYNC_MAX_PER_RUN = 50;
const ENTRY_MAX_CHARS = 500;

function hashOf(text) {
	return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 从 `MEMORY.md` 正文里抽"条目"（`- xxx` / `* xxx` / `1. xxx`）。
 *
 * 忽略：空行、标题（`#`）、引用（`>`）、表格（`|`）、HTML 注释块。
 * 为什么连注释块也要跳过：我们的模板与"从 AgentMemory 导入"都会写注释，
 * 把注释当记忆写进库等于往检索结果里灌噪音。
 */
export function parseMemoryEntries(text, options = {}) {
	const cap = Math.min(SYNC_MAX_ENTRIES, Math.max(1, Number(options.max) || SYNC_MAX_ENTRIES));
	const out = [];
	let inComment = false;
	for (const line of String(text ?? '').split(/\r?\n/)) {
		const t = line.trim();
		if (!t) { continue; }
		if (inComment) {
			if (t.includes('-->')) { inComment = false; }
			continue;
		}
		if (t.startsWith('<!--')) {
			if (!t.includes('-->')) { inComment = true; }
			continue;
		}
		if (t.startsWith('#') || t.startsWith('>') || t.startsWith('|')) { continue; }
		const m = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(t);
		if (!m) { continue; }
		const content = m[1].replace(/\s+/g, ' ').trim();
		if (!content) { continue; }
		out.push({ type: 'note', content: content.slice(0, ENTRY_MAX_CHARS) });
		if (out.length >= cap) { break; }
	}
	return out;
}

async function readSyncState(config, agentId) {
	const file = join(dataRootOf(config), SYNC_FILE);
	try {
		const j = JSON.parse(await readFile(file, 'utf8'));
		const agents = (j && j.agents) || {};
		const a = agents[String(agentId)] || {};
		return {
			file,
			agents,
			hashes: Array.isArray(a.hashes) ? a.hashes.filter((h) => typeof h === 'string') : [],
			at: Number(a.at) || 0,
		};
	} catch {
		return { file, agents: {}, hashes: [], at: 0 };
	}
}

async function writeSyncState(state, agentId, hashes) {
	const agents = { ...state.agents, [String(agentId)]: { hashes, at: Date.now() } };
	try {
		await mkdir(dirname(state.file), { recursive: true });
	} catch { /* 目录已存在 */ }
	try {
		await writeFile(state.file + '.tmp', JSON.stringify({ version: 1, agents }, null, 2), 'utf8');
		await renameWithRetry(state.file + '.tmp', state.file);
	} catch { /* 状态写不进去不致命：下次会重复写几条，比中断同步好 */ }
}

/**
 * 把 `MEMORY.md` 的条目**单向**写进 AgentMemory（只增不改）。
 *
 * @returns `{ state, added, skipped, failed, total, gateway }`
 *   · `skipped` = 之前同步过（hash 命中）
 *   · `failed`  = 逐条失败原因（一条失败不影响其它）
 * ⚠ 不抛：网关离线用 `state:'offline'` 表达（与 candidates 同口径）。
 */
export async function syncMemoryToAgentMemory(config, agentId, options = {}) {
	const base = agentMemoryGatewayUrl(config, options?.env);
	if (!base) {
		return { state: 'unconfigured', gateway: null, added: 0, skipped: 0, failed: [], total: 0 };
	}
	const id = String(agentId ?? '');
	const mem = await readMemoryFile(config, id, 'MEMORY.md').catch(() => null);
	const entries = parseMemoryEntries(String((mem && mem.text) || ''), { max: options.max });
	if (!entries.length) {
		return { state: 'online', gateway: base, added: 0, skipped: 0, failed: [], total: 0, empty: true };
	}
	const st = await readSyncState(config, id);
	const seen = new Set(st.hashes);
	const budget = Math.min(SYNC_MAX_PER_RUN, Math.max(1, Number(options.limit) || SYNC_MAX_PER_RUN));
	let added = 0;
	let skipped = 0;
	const failed = [];
	const newHashes = [];
	for (const e of entries) {
		const h = hashOf(e.content);
		if (seen.has(h)) { skipped += 1; continue; }
		if (added >= budget) { break; }
		try {
			await providerCall(base, 'writeMemory', [id, { type: e.type, content: e.content }]);
			added += 1;
			newHashes.push(h);
		} catch (err) {
			failed.push({ content: e.content.slice(0, 40), error: String((err && err.message) || err) });
		}
	}
	if (newHashes.length) {
		/* 新的在前、有界：只保留最近 500 条的指纹 */
		await writeSyncState(st, id, [...newHashes, ...st.hashes].slice(0, SYNC_MAX_HASHES));
	}
	return { state: 'online', gateway: base, added, skipped, failed, total: entries.length };
}
