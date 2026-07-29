/*---------------------------------------------------------------------------------------------
 *  AgentMemory persistence server — KV store (1:1 parity with agentmemory).
 *
 *  Backend selection (resilient across Node versions):
 *    - If `node:sqlite` is available (Node 22.5+), use a SQLite KV store
 *      backed by ~/.vssaros/.agentmemory/state_store.db (preserves existing data).
 *    - Otherwise (e.g. Electron 39 bundles Node 20.19, which has NO
 *      node:sqlite), fall back to a pure-JS KV store backed by
 *      ~/.vssaros/.agentmemory/kv_store.json.
 *
 *  This avoids the previous hard crash: `import { DatabaseSync } from
 *  'node:sqlite'` at module top-level throws on Node < 22.5, killing the
 *  gateway child → port 3111 never comes up → the renderer V2 provider
 *  silently no-op'd (looked like "V2 didn't take over").
 *
 *  Storage (SQLite):  ~/.vssaros(-dev)/.agentmemory/state_store.db (WAL)
 *  Storage (JS-KV):   ~/.vssaros(-dev)/.agentmemory/kv_store.json
 *  （数据根目录由主进程经 AGENTMEMORY_DATA_DIR 注入 = <userDataPath>/.agentmemory；
 *    独立运行时回退 ~/.vssaros(-dev)/.agentmemory（dev 模式下主进程 userDataPath
 *    为 ~/.vssaros-dev，见下 sarosDataFolderName），并自动迁移旧的 ~/.saros/.agentmemory。）
 *
 *  Endpoints:
 *    GET  /health                         → health check
 *    POST /flush-all                       → batch flush (for beforeunload)
 *
 *  KV endpoints (scope-based, mirrors iii-engine state::get/set/list/delete):
 *    GET  /kv/<scope>/<key>               → read value (returns null if missing)
 *    PUT  /kv/<scope>/<key>               → write value (upsert)
 *    DELETE /kv/<scope>/<key>             → delete value
 *    GET  /kv/<scope>                     → list all keys in scope
 *    GET  /kv/<scope>?values=true         → list all key-value pairs in scope
 *
 *  Legacy file endpoints (backward compatibility + data migration):
 *    GET  /mem/<agentId>/<file>           → read file
 *    PUT  /mem/<agentId>/<file>           → write file
 *
 *  Started by saros Electron main process (startAgentMemoryGateway in app.ts).
 *--------------------------------------------------------------------------------------------*/

import http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TAG = '[agentmemory-store]';

function emit(kind, msg, extra = {}) {
	const obj = { kind, msg, ts: new Date().toISOString(), ...extra };
	process.stdout.write(JSON.stringify(obj) + '\n');
}

// ── 记忆操作请求日志 ─────────────────────────────────────────
// 写操作全量打印（写入是记忆系统的关键事件，频率低）；
// 读操作采样打印（每 25 次 1 条）防止刷屏；
// AGENTMEMORY_LOG_VERBOSE=1 时全部打印（排障模式）。
const LOG_VERBOSE = process.env.AGENTMEMORY_LOG_VERBOSE === '1';
const WRITE_METHODS = new Set([
	'writeMemory', 'forgetMemory', 'reinforceMemory', 'setSlot', 'removeAgent',
	'coreMemoryAdd', 'coreMemoryRemove', 'lessonSave', 'addLesson', 'deleteLesson',
	'addSkill', 'updateSkill', 'deleteSkill', 'writeSkillFile', 'deleteSkillFile',
	'updateMemory', 'deleteMemory',
	'writeAllSkillFiles', 'onGitCommit', 'triggerHook', 'runMaintenanceSweep',
]);
let readCallCount = 0;
function clip(v, n = 60) {
	const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
	return (s && s.length > n) ? s.slice(0, n) + '…' : (s ?? '');
}
function describeProviderArgs(method, args) {
	try {
		switch (method) {
			case 'writeMemory': {
				const e = args[1] ?? {};
				return `type=${e.type ?? '?'} len=${(e.content ?? '').length}${e.metadata?.memoryType ? ' mt=' + e.metadata.memoryType : ''}`;
			}
			case 'searchMemory': return `query="${clip(args[1], 40)}"`;
			case 'loadContext': return `session=${args[1] ?? ''}${args[2] ? ' query="' + clip(args[2], 30) + '"' : ''}`;
			case 'forgetMemory': case 'reinforceMemory': return `memId=${clip(args[1], 24)}`;
			case 'setSlot': case 'getSlot': return `slot=${args[1] ?? '?'}`;
			case 'recallFormatted': return `query="${clip(args[1], 40)}"`;
			default: return '';
		}
	} catch { return ''; }
}
function summarizeProviderResult(result) {
	try {
		if (result === undefined || result === null) return 'ok';
		if (Array.isArray(result)) return `${result.length} items`;
		if (typeof result === 'object') {
			const r = result;
			if (Array.isArray(r.longTermMemories) || Array.isArray(r.shortTermMemories)) {
				return `short=${(r.shortTermMemories ?? []).length} long=${(r.longTermMemories ?? []).length} sys=${(r.systemPrompt ?? '').length}c`;
			}
			return `{${Object.keys(r).slice(0, 5).join(',')}}`;
		}
		return clip(result, 40);
	} catch { return ''; }
}
function logProviderCall(method, args, result) {
	try {
		const agentId = typeof args[0] === 'string' ? args[0] : '-';
		const detail = describeProviderArgs(method, args);
		if (WRITE_METHODS.has(method)) {
			emit('log', `[provider] ${method} agent=${agentId} ${detail} → ${summarizeProviderResult(result)}`);
			return;
		}
		readCallCount++;
		if (LOG_VERBOSE || readCallCount % 25 === 1) {
			emit('log', `[provider] ${method} agent=${agentId} ${detail} → ${summarizeProviderResult(result)} (sampled, total reads=${readCallCount})`);
		}
	} catch { /* 日志绝不影响请求 */ }
}

// Dev mode follows the product layer's `-dev` dataFolderName so that memory /
// skills stay in the SAME data dir as the rest of the app. The main process
// already injects AGENTMEMORY_DATA_DIR / AGENTMEMORY_SKILLS_DIR from
// userDataPath (= <home>/.vssaros-dev in dev); these helpers only affect the
// standalone fallback (when those env vars are absent) and the legacy ~/.saros
// migration target. VSCODE_DEV is the same flag product.ts uses to pick
// `.vssaros-dev` over `.vssaros`.
function isDevMode() {
	return !!process.env.VSCODE_DEV;
}
function sarosDataFolderName() {
	return isDevMode() ? '.vssaros-dev' : '.vssaros';
}

function resolveDataDir() {
	const home = process.env.HOME || process.env.USERPROFILE || '.';
	if (process.env.AGENTMEMORY_DATA_DIR) {
		return process.env.AGENTMEMORY_DATA_DIR;
	}
	const dataDir = path.join(home, sarosDataFolderName(), '.agentmemory');
	// 历史默认路径为 ~/.saros/.agentmemory —— 若旧目录存在而新目录不存在，
	// 做一次性迁移（同分区 rename，失败则忽略：新数据仍写入新目录）。
	// 迁移目标跟随上述 dev/prod 目录（dev 下即 ~/.vssaros-dev/.agentmemory）。
	try {
		const legacyDir = path.join(home, '.saros', '.agentmemory');
		if (fs.existsSync(legacyDir) && !fs.existsSync(dataDir)) {
			fs.mkdirSync(path.dirname(dataDir), { recursive: true });
			fs.renameSync(legacyDir, dataDir);
			emit('log', `migrated legacy data dir ${legacyDir} -> ${dataDir}`);
		}
	} catch (e) {
		emit('log', `legacy data dir migration skipped: ${e?.message ?? e}`);
	}
	return dataDir;
}

function sanitize(str) {
	return str.replace(/[^A-Za-z0-9_.:-]/g, '_');
}

// ── Backend: try SQLite, fall back to pure-JS KV ────────────────────────
// Selected once at startup. All KV ops go through the backend interface so the
// HTTP layer is backend-agnostic.

let backendKind = 'unknown';
let db = null;            // SQLite DatabaseSync instance (sqlite backend)
let store = null;        // Map<scope, Map<key, value>> (js backend)
let storeFile = '';      // json path (js backend)

async function initBackend(dataDir) {
	// Dynamic import is wrapped so a missing module does NOT crash the process.
	try {
		const sqlite = await import('node:sqlite');
		const dbPath = path.join(dataDir, 'state_store.db');
		db = new sqlite.DatabaseSync(dbPath);
		db.exec('PRAGMA journal_mode = WAL');
		db.exec('PRAGMA synchronous = NORMAL');
		db.exec('PRAGMA busy_timeout = 5000');
		db.exec(`
			CREATE TABLE IF NOT EXISTS kv_store (
				scope     TEXT NOT NULL,
				key       TEXT NOT NULL,
				value     TEXT,
				updated_at INTEGER,
				PRIMARY KEY (scope, key)
			)
		`);
		db.exec('CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv_store(scope)');
		backendKind = 'sqlite';
		emit('log', `${TAG} SQLite KV store ready: ${dbPath}`);
		return;
	} catch (err) {
		emit('log', `${TAG} node:sqlite unavailable (${(err instanceof Error ? err.message : String(err))}); falling back to pure-JS KV`);
	}

	// ── Pure-JS KV fallback ──────────────────────────────────────────────
	store = new Map();
	storeFile = path.join(dataDir, 'kv_store.json');
	loadJsStore();
	backendKind = 'js-kv';
	emit('log', `${TAG} pure-JS KV store ready: ${storeFile}`);
}

// ── SQLite prepared statements (lazily created after db is set) ─────────────
let stmtGet, stmtSet, stmtDelete, stmtListKeys, stmtListAll, stmtDeleteScope;
function ensureSqliteStmts() {
	if (stmtGet) return;
	stmtGet = db.prepare('SELECT value FROM kv_store WHERE scope = ? AND key = ?');
	stmtSet = db.prepare(`
		INSERT INTO kv_store (scope, key, value, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
	`);
	stmtDelete = db.prepare('DELETE FROM kv_store WHERE scope = ? AND key = ?');
	stmtListKeys = db.prepare('SELECT key FROM kv_store WHERE scope = ?');
	stmtListAll = db.prepare('SELECT key, value FROM kv_store WHERE scope = ?');
	stmtDeleteScope = db.prepare('DELETE FROM kv_store WHERE scope = ?');
}

// ── Pure-JS store helpers ─────────────────────────────────────────────────
function loadJsStore() {
	if (!fs.existsSync(storeFile)) return;
	try {
		const obj = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
		for (const [scope, m] of Object.entries(obj)) {
			const mm = new Map();
			for (const [k, v] of Object.entries(m)) mm.set(k, v);
			store.set(scope, mm);
		}
		emit('log', `${TAG} loaded KV store: ${Object.keys(obj).length} scope(s) from ${storeFile}`);
	} catch (err) {
		emit('warn', `${TAG} failed to load store (starting empty): ${err instanceof Error ? err.message : String(err)}`);
	}
}

function persistJsStore() {
	const obj = {};
	for (const [scope, m] of store) {
		obj[scope] = Object.fromEntries(m);
	}
	const tmp = storeFile + `.tmp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
	fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
	fs.renameSync(tmp, storeFile);
}

// ── Unified KV interface ──────────────────────────────────────────────────
function getKV(scope, key) {
	if (backendKind === 'sqlite') {
		const row = stmtGet.get(scope, key);
		return row ? row.value : undefined;
	}
	return store.get(scope)?.get(key);
}

function setKV(scope, key, value) {
	if (backendKind === 'sqlite') {
		stmtSet.run(scope, key, value, Date.now());
		return;
	}
	let m = store.get(scope);
	if (!m) { m = new Map(); store.set(scope, m); }
	m.set(key, value);
	persistJsStore();
}

function delKV(scope, key) {
	if (backendKind === 'sqlite') {
		stmtDelete.run(scope, key);
		return;
	}
	const m = store.get(scope);
	if (m) {
		m.delete(key);
		if (m.size === 0) store.delete(scope);
	}
	persistJsStore();
}

function listKeys(scope) {
	if (backendKind === 'sqlite') {
		const rows = stmtListKeys.all(scope);
		return rows.map(r => r.key);
	}
	const m = store.get(scope);
	return m ? [...m.keys()] : [];
}

function listAll(scope) {
	if (backendKind === 'sqlite') {
		const rows = stmtListAll.all(scope);
		const result = {};
		for (const row of rows) result[row.key] = row.value;
		return result;
	}
	const m = store.get(scope);
	if (!m) return {};
	const o = {};
	for (const [k, v] of m) o[k] = v;
	return o;
}

function listAgents() {
	const agents = new Set();
	const prefix = 'mem:long:';
	if (backendKind === 'sqlite') {
		const rows = db.prepare("SELECT DISTINCT scope FROM kv_store WHERE scope LIKE 'mem:long:%' AND length(value) > 1").all();
		for (const r of rows) agents.add(r.scope.replace(prefix, ''));
		return [...agents];
	}
	for (const scope of store.keys()) {
		if (scope.startsWith(prefix)) agents.add(scope.slice(prefix.length));
	}
	return [...agents];
}

function deleteScope(scope) {
	if (backendKind === 'sqlite') {
		stmtDeleteScope.run(scope);
		return;
	}
	store.delete(scope);
	persistJsStore();
}

function flushAllItems(items) {
	for (const item of items) {
		const scope = sanitize(item.scope || `mem:${sanitize(item.agentId)}`);
		const key = sanitize(item.key || item.file);
		setKV(scope, key, item.content);
	}
}

// ── Search index (BM25) — lives in the MAIN process ──────────────────────
// Plan C: the index + search were moved OUT of the renderer's 4GB-limited
// isolate into this gateway. The renderer V2 provider is now a pure fetch
// client (see agentMemoryProviderV2.ts). The gateway imports the SAME compiled
// bm25Index.js from the sibling agentmemory-memory extension (single source of
// truth, zero porting). On startup we rebuild the index from KV; on every
// PUT/DELETE of a mem:memories:<agentId> value we update it incrementally.
let BM25Ctor = null;
let VectorCtor = null;
const indexByAgent = new Map();
const vectorIndexByAgent = new Map();

async function resolveBm25Module() {
	const extRoot = process.env['AGENTMEMORY_EXT_ROOT'];
	const candidates = [
		extRoot ? path.join(extRoot, 'out', 'bm25Index.js') : null,
		// host.mjs 位于 <extRoot>/agentmemory-gateway/host/；兄弟扩展在
		// <extRoot>/agentmemory-memory/out/，向上 2 级即到 extensions/。
		path.join(__dirname, '..', '..', 'agentmemory-memory', 'out', 'bm25Index.js'),
		path.join(__dirname, '..', '..', '..', 'extensions', 'agentmemory-memory', 'out', 'bm25Index.js'),
	].filter(Boolean);
	for (const c of candidates) {
		if (!fs.existsSync(c)) continue;
		try {
			// out/package.json is {"type":"module"} → ESM dynamic import.
			// Windows 上动态 import 必须使用 file:// URL（裸绝对路径会报错）。
			const mod = await import(pathToFileURL(c).href);
			const Ctor = mod.BM25Index || (mod.default && mod.default.BM25Index);
			if (Ctor) { emit('log', `${TAG} BM25 module loaded: ${c}`); return Ctor; }
		} catch (err) {
			emit('warn', `${TAG} BM25 load failed (${c}): ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	emit('warn', `${TAG} BM25 module not found; /search returns empty, renderer falls back to KV scan.`);
	return null;
}

// ─── 向量索引模块（trigram fallback，无需 @xenova/transformers） ───
// 对齐 resolveBm25Module 的 ESM 动态 import + 多候选路径解析。
async function resolveVectorModule() {
	if (VectorCtor) { return; }
	const extRoot = process.env['AGENTMEMORY_EXT_ROOT'];
	const candidates = [
		extRoot ? path.join(extRoot, 'out', 'vectorIndex.js') : null,
		// host.mjs 位于 <extRoot>/agentmemory-gateway/host/；兄弟扩展在
		// <extRoot>/agentmemory-memory/out/，向上 2 级即到 extensions/。
		path.join(__dirname, '..', '..', 'agentmemory-memory', 'out', 'vectorIndex.js'),
		path.join(__dirname, '..', '..', '..', 'extensions', 'agentmemory-memory', 'out', 'vectorIndex.js'),
	].filter(Boolean);
	for (const c of candidates) {
		if (!fs.existsSync(c)) { continue; }
		try {
			// out/package.json is {"type":"module"} → ESM dynamic import（Windows 必须 file:// URL）。
			const mod = await import(pathToFileURL(c).href);
			VectorCtor = mod.VectorIndex || (mod.default && mod.default.VectorIndex) || mod.default;
			if (VectorCtor) {
				emit('info', `${TAG} ✅ VectorIndex loaded from ${c}`);
				return;
			}
		} catch (err) {
			emit('warn', `${TAG} VectorIndex load failed (${c}): ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	emit('warn', `${TAG} vectorIndex module not found; /search vector branch disabled (BM25-only).`);
}

// ─── 向量 index getter ──────────────────────────────────────────
// 注：VectorCtor 由启动时的 await resolveVectorModule() 预加载（main()）。
// 此处不再懒加载（async 无法在同步 getter 中 await），未加载则退化为 null → BM25-only。
const getAgentVectorIndex = (agentId) => {
	let vi = vectorIndexByAgent.get(agentId);
	if (!vi) {
		if (!VectorCtor) { return null; }
		vi = new VectorCtor({ useTrigramFallback: true });
		vectorIndexByAgent.set(agentId, vi);
	}
	return vi;
};

const gatewayVectorGetter = (agentId) => {
	const vi = vectorIndexByAgent.get(agentId);
	if (!vi || vi.size === 0) {
		return { available: false, size: 0, search: async () => [] };
	}
	return {
		available: true,
		get size() { return vi.size; },
		search: async (query, limit) => {
			return vi.search(query, limit);
		},
	};
};

function getAgentIndex(agentId) {
	let idx = indexByAgent.get(agentId);
	if (!idx && BM25Ctor) { idx = new BM25Ctor(); indexByAgent.set(agentId, idx); }
	return idx;
}

function indexMemoryPut(scope, key, bodyText) {
	const m = /^mem:memories:(.+)$/.exec(scope);
	if (!m || !BM25Ctor) return;
	const agentId = m[1];
	try {
		const obj = JSON.parse(bodyText);
		if (!obj || typeof obj !== 'object' || !obj.content) return;
		const id = obj.id || key;
		const idx = getAgentIndex(agentId);
		if (obj.isLatest === false || obj.deleted === true) idx.remove(id);
		else idx.add(id, obj.content);
	} catch { /* not a memory object */ }
}

function indexMemoryDelete(scope, key, removedId) {
	const m = /^mem:memories:(.+)$/.exec(scope);
	if (!m || !BM25Ctor) return;
	const idx = getAgentIndex(m[1]);
	if (idx) idx.remove(removedId || key);
}

// ── 向量索引同步（与 BM25 一起保持 Incremental） ──────────────
function indexMemoryPutVector(scope, key, body) {
	if (!VectorCtor) return;
	try {
		const m = /^mem:memories:(.+)$/.exec(scope);
		if (!m) return;
		const obj = JSON.parse(body);
		if (!obj || !obj.id) return;
		const content = obj.content || obj.text || obj.summary || '';
		if (!content) return;
		const vi = getAgentVectorIndex(m[1]);
		if (vi) { vi.addText(obj.id, content); }  // trigram 同步 embedding（无需 transformers）
	} catch { /* not a memory object */ }
}

function indexMemoryDeleteVector(scope, key, removedId) {
	if (!VectorCtor) return;
	try {
		const m = /^mem:memories:(.+)$/.exec(scope);
		if (!m) return;
		const vi = getAgentVectorIndex(m[1]);
		// VectorIndex may not expose remove; skip if abs sent
		if (vi && removedId && typeof vi.remove === 'function') {
			vi.remove(removedId);
		}
	} catch { /* not a memory object */ }
}

// ── Opt1: In-Process KV adapter (Provider engine now runs HERE) ──────────
// Mirrors the renderer StateKV interface but calls the gateway's internal KV
// store + BM25 index directly (no self-loop HTTP). Writes also keep the BM25
// index in sync. This is what lets AgentMemoryProviderV2 execute in-process.
class InProcessKV {
	async ensureConnected() { /* noop */ }
	async get(scope, key) {
		const raw = getKV(scope, key);
		if (raw === undefined || raw === null) return null;
		if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return null; } }
		return raw;
	}
	async set(scope, key, value) {
		const body = JSON.stringify(value ?? null);
		setKV(scope, key, body);
		indexMemoryPut(scope, key, body);
		indexMemoryPutVector(scope, key, body);
	}
	async delete(scope, key) {
		let removedId;
		try {
			const ex = getKV(scope, key);
			const obj = typeof ex === 'string' ? JSON.parse(ex) : ex;
			removedId = obj?.id;
		} catch { /* ignore */ }
		delKV(scope, key);
		indexMemoryDelete(scope, key, removedId);
		indexMemoryDeleteVector(scope, key, removedId);
	}
	async list(scope) {
		const obj = listAll(scope);
		const out = [];
		for (const v of Object.values(obj)) {
			if (typeof v === 'string') {
				try { const p = JSON.parse(v); if (p !== null) out.push(p); } catch { /* skip */ }
			} else if (v !== null && v !== undefined) {
				out.push(v);
			}
		}
		return out;
	}
	async listKeys(scope) { return listKeys(scope); }
	async listScopes(prefix) { return listScopesByPrefix(prefix); }
	async clearScope(scope) {
		for (const k of listKeys(scope)) delKV(scope, k);
	}
	dispose() { /* noop */ }
}

// 2026-07-25 P1 并发安全：BM25 getter 按 agentId 参数取索引。
// 此前经模块级 gatewayCurrentAgent 可变字段传递 agent 身份——/provider/*
// 并发请求互相覆盖（请求 A 的 searchMemories 可能读到请求 B 的 agent 索引，
// 跨 agent 召回泄漏）。agentId 现由 amFunctions.searchMemories 显式传入。
function gatewayBm25Getter(agentId) {
	const idx = getAgentIndex(agentId || 'default');
	if (!idx) return null;
	return { size: idx.size, search: (q, l) => idx.search(q, l) };
}

let providerInstance = null;
// Methods that must NOT be reachable over /provider/* (private / event-only).
const PROVIDER_METHOD_BLACKLIST = new Set([
	'constructor', 'dispose', 'onMemoryWritten', 'onMemoryWriteFailed',
	'_ensureServer', '_on', '_emit', '_serverStats', '_healthChecked',
	'_lastHealthCheckAt', '_serverAvailable',
]);

// Load the REAL AgentMemoryProviderV2 (engine + IMemoryProvider) into THIS
// process and wire its index getters to the in-process BM25 index. The
// engine closure (amFunctions + amPipeline + amSlots + ...) is pure-node
// safe, so a dynamic import of the sibling extension's compiled out/ works.
async function loadProvider() {
	try {
		const extRoot = process.env['AGENTMEMORY_EXT_ROOT'];
		const candidates = [
			extRoot ? path.join(extRoot, 'out', 'agentMemoryProviderV2.js') : null,
			extRoot ? path.join(extRoot, 'out', 'amFunctions.js') : null,
			// host.mjs 位于 <extRoot>/agentmemory-gateway/host/；兄弟扩展在
			// <extRoot>/agentmemory-memory/out/，向上 2 级即到 extensions/。
			path.join(__dirname, '..', '..', 'agentmemory-memory', 'out', 'agentMemoryProviderV2.js'),
			path.join(__dirname, '..', '..', 'agentmemory-memory', 'out', 'amFunctions.js'),
		].filter(Boolean);
		let fnMod = null, provMod = null;
		for (const c of candidates) {
			if (!fs.existsSync(c)) continue;
			if (!fnMod && c.endsWith('amFunctions.js')) {
				try { fnMod = await import(pathToFileURL(c).href); } catch { /* try next */ }
			}
			if (!provMod && c.endsWith('agentMemoryProviderV2.js')) {
				try { provMod = await import(pathToFileURL(c).href); }
				catch (e) { emit('warn', `${TAG} provider load failed (${c}): ${e?.message}`); }
			}
			if (fnMod && provMod) break;
		}
		if (!fnMod || !provMod || !provMod.AgentMemoryProviderV2) {
			emit('warn', `${TAG} AgentMemoryProviderV2 not loaded; /provider/* returns 404 (renderer proxy degrades to no-op).`);
			return;
		}
		// amFunctions is cached by resolved URL, so this mutates the SAME
		// _getBM25Index closure the provider's searchMemories reads.
		// agentId 由 searchMemories 逐调用显式传入（并发安全）；
		// vector getter 同步修复——此前绑死 'default'，非 default agent 的向量召回恒为空。
		fnMod.setIndexGetters((agentId) => gatewayBm25Getter(agentId), (agentId) => gatewayVectorGetter(agentId || 'default'));
		providerInstance = new provMod.AgentMemoryProviderV2({ kv: new InProcessKV(), hosted: true });
		emit('log', `${TAG} AgentMemoryProviderV2 hosted in-process (Opt1): engine + IMemoryProvider now run in the gateway.`);
	} catch (err) {
		emit('warn', `${TAG} provider load error: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function allMemoryScopes() {
	const out = [];
	if (backendKind === 'sqlite') {
		const rows = db.prepare("SELECT DISTINCT scope FROM kv_store WHERE scope LIKE 'mem:memories:%'").all();
		for (const r of rows) out.push(r.scope);
	} else {
		for (const s of store.keys()) if (s.startsWith('mem:memories:')) out.push(s);
	}
	return out;
}

// 通用 scope 枚举：列出以 prefix 开头的所有 scope。
// 用于 provider.listAllAgentsWithData / searchAllAgents 跨 agent 枚举。
function listScopesByPrefix(prefix) {
	const out = [];
	if (backendKind === 'sqlite') {
		const rows = db.prepare("SELECT DISTINCT scope FROM kv_store WHERE scope LIKE ?").all(prefix + '%');
		for (const r of rows) out.push(r.scope);
	} else {
		for (const s of store.keys()) if (s.startsWith(prefix)) out.push(s);
	}
	return out;
}

async function rebuildIndexesFromKV() {
	if (!BM25Ctor) return;
	let total = 0;
	try {
		const scopes = allMemoryScopes();
		for (const scope of scopes) {
			const agentId = scope.slice('mem:memories:'.length);
			const idx = getAgentIndex(agentId);
			idx.clear();
			const all = listAll(scope);
			for (const val of Object.values(all)) {
				try {
					const obj = JSON.parse(val);
					if (obj && obj.content && obj.isLatest !== false && obj.deleted !== true) {
						idx.add(obj.id || '', obj.content);
						total++;
					}
				} catch { /* skip */ }
			}
		}
		emit('log', `${TAG} rebuilt BM25 index: ${total} doc(s) across ${scopes.length} agent(s)`);
	} catch (err) {
		emit('warn', `${TAG} index rebuild partial: ${err instanceof Error ? err.message : String(err)}`);
	}

	// 并行重建向量索引（trigram fallback，无模型依赖）
	if (VectorCtor) {
		let viTotal = 0;
		try {
			const scopes = allMemoryScopes();
			for (const scope of scopes) {
				const agentId = scope.slice('mem:memories:'.length);
				const vi = getAgentVectorIndex(agentId);
				if (!vi) continue;
				if (typeof vi.clear === 'function') vi.clear();
				const all = listAll(scope);
				for (const val of Object.values(all)) {
					try {
						const obj = JSON.parse(val);
						if (obj && obj.content && obj.isLatest !== false && obj.deleted !== true) {
							vi.addText(obj.id || '', obj.content);
							viTotal++;
						}
					} catch { /* skip */ }
				}
			}
			emit('log', `${TAG} rebuilt vector index: ${viTotal} doc(s) across ${scopes.length} agent(s) (trigram fallback)`);
		} catch (err) { emit('warn', `${TAG} vector index rebuild failed: ${err instanceof Error ? err.message : String(err)}`); }
	}
}

async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	return Buffer.concat(chunks).toString('utf8');
}

// pendingWrites is kept for graceful-shutdown accounting only.
let pendingWrites = 0;

async function main() {
	const port = parseInt(process.env.AGENTMEMORY_PORT || '3111', 10);
	const dataDir = resolveDataDir();
	fs.mkdirSync(dataDir, { recursive: true });

	await initBackend(dataDir);
	if (backendKind === 'sqlite') ensureSqliteStmts();

	// Plan C: load the BM25 index module (from the sibling agentmemory-memory
	// extension's compiled output) and rebuild the in-process index from KV.
	BM25Ctor = await resolveBm25Module();
	await resolveVectorModule();  // 先加载向量索引模块，再重建（否则 VectorCtor 恒 null）
	await rebuildIndexesFromKV();

	// Opt1: host the REAL AgentMemoryProviderV2 (engine + IMemoryProvider)
	// in this process. The renderer extension is now a thin proxy.
	await loadProvider();

	const server = http.createServer(async (req, res) => {
		// CORS
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

		if (req.method === 'OPTIONS') {
			res.writeHead(204);
			res.end();
			return;
		}

		try {
			const url = new URL(req.url, `http://localhost:${port}`);

			// ── Health check ─────────────────────────────────────────────────
			if (url.pathname === '/health') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ status: 'ok', dataDir, port, engine: backendKind }));
				return;
			}

			// ── List all agents with data ─────────────────────────────────
			if (url.pathname === '/kv-list-agents' && req.method === 'GET') {
				const agents = listAgents();
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(agents));
				return;
			}

			// ── List scopes by prefix (agent enumeration for provider) ──
			if (url.pathname === '/scopes' && req.method === 'GET') {
				const prefix = url.searchParams.get('prefix') || '';
				const scopes = listScopesByPrefix(prefix);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(scopes));
				return;
			}

			// ── SKILL.md file endpoints ────────────────────────────────────
			const skillMatch = url.pathname.match(/^\/skill-md\/([^/]+)$/);
			if (skillMatch) {
				const slug = sanitize(skillMatch[1]);
			const home = process.env.HOME || process.env.USERPROFILE || '.';
			// 与渲染进程 skillRegistryService 读取路径一致（~/.vssaros(-dev)/skills/）；
			// 主进程注入 AGENTMEMORY_SKILLS_DIR = <userDataPath>/skills（dev 下为
			// ~/.vssaros-dev/skills）。缺失注入时回退到 dev 感知目录。
			const skillsRoot = process.env.AGENTMEMORY_SKILLS_DIR || path.join(home, sarosDataFolderName(), 'skills');
				const skillsDir = path.join(skillsRoot, slug);
				const skillFile = path.join(skillsDir, 'SKILL.md');

				if (req.method === 'PUT') {
					pendingWrites++;
					try {
						const chunks = [];
						for await (const chunk of req) { chunks.push(chunk); }
						const body = Buffer.concat(chunks).toString('utf8');
						fs.mkdirSync(skillsDir, { recursive: true });
						const tmpPath = skillFile + `.tmp_${Date.now()}`;
						fs.writeFileSync(tmpPath, body, 'utf8');
						fs.renameSync(tmpPath, skillFile);
						emit('log', `${TAG} wrote SKILL.md: ${skillFile} (${body.length} bytes)`);
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ ok: true, path: skillFile, bytes: body.length }));
					} catch (err) {
						res.writeHead(500, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: err.message }));
					} finally {
						pendingWrites--;
					}
					return;
				}

				if (req.method === 'DELETE') {
					pendingWrites++;
					try {
						let deleted = false;
						if (fs.existsSync(skillFile)) {
							fs.unlinkSync(skillFile);
							deleted = true;
						}
						try { fs.rmdirSync(skillsDir); } catch { /* not empty, ignore */ }
						emit('log', `${TAG} deleted SKILL.md: ${skillFile}`);
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ ok: true, deleted, path: skillFile }));
					} catch (err) {
						res.writeHead(500, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: err.message }));
					} finally {
						pendingWrites--;
					}
					return;
				}

				if (req.method === 'GET') {
					try {
						if (fs.existsSync(skillFile)) {
							const content = fs.readFileSync(skillFile, 'utf8');
							res.writeHead(200, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({ exists: true, content, path: skillFile }));
						} else {
							res.writeHead(200, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({ exists: false }));
						}
					} catch (err) {
						res.writeHead(500, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: err.message }));
					}
					return;
				}
			}

			// ── Batch flush (for beforeunload) ──────────────────────────────
			if (url.pathname === '/flush-all' && req.method === 'POST') {
				const chunks = [];
				for await (const chunk of req) { chunks.push(chunk); }
				const body = Buffer.concat(chunks).toString('utf8');
				pendingWrites++;
				try {
					const data = JSON.parse(body);
					flushAllItems(data.agents || []);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ ok: true, written: (data.agents || []).length }));
				} catch (err) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: err.message }));
				} finally {
					pendingWrites--;
				}
				return;
			}

			// ── KV endpoints: /kv/<scope>/<key> ─────────────────────────────
			const kvMatch = url.pathname.match(/^\/kv\/([^/]+)\/([^/]+)$/);
			if (kvMatch) {
				const scope = decodeURIComponent(kvMatch[1]);
				const key = decodeURIComponent(kvMatch[2]);

				if (req.method === 'GET') {
					const value = getKV(scope, key);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(value !== undefined ? value : 'null');
					return;
				}

				if (req.method === 'PUT') {
					pendingWrites++;
					try {
						const chunks = [];
						for await (const chunk of req) { chunks.push(chunk); }
						const body = Buffer.concat(chunks).toString('utf8');
						setKV(scope, key, body);
						indexMemoryPut(scope, key, body);
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ ok: true, bytes: body.length }));
					} finally {
						pendingWrites--;
					}
					return;
				}

				if (req.method === 'DELETE') {
					pendingWrites++;
					let removedId;
					try {
						const existing = getKV(scope, key);
						try { removedId = existing ? JSON.parse(existing).id : undefined; } catch { /* ignore */ }
					} catch { /* ignore */ }
					try {
						delKV(scope, key);
						indexMemoryDelete(scope, key, removedId);
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ ok: true }));
					} finally {
						pendingWrites--;
					}
					return;
				}

				res.writeHead(405, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'method not allowed' }));
				return;
			}

			// ── KV list endpoint: /kv/<scope> ───────────────────────────────
			const kvListMatch = url.pathname.match(/^\/kv\/([^/]+)$/);
			if (kvListMatch && req.method === 'GET') {
				const scope = decodeURIComponent(kvListMatch[1]);
				const wantValues = url.searchParams.get('values') === 'true';
				if (wantValues) {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(listAll(scope)));
				} else {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(listKeys(scope)));
				}
				return;
			}

			// ── KV delete scope: DELETE /kv/<scope> ─────────────────────────
			if (kvListMatch && req.method === 'DELETE') {
				const scope = decodeURIComponent(kvListMatch[1]);
				pendingWrites++;
				try {
					deleteScope(scope);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ ok: true }));
				} finally {
					pendingWrites--;
				}
				return;
			}

			// ── Search endpoint (Plan C: BM25 lives here; renderer is a fetch client) ──
			const searchMatch = url.pathname.match(/^\/search\/(.+)$/);
			if (searchMatch && req.method === 'POST') {
				const agentId = decodeURIComponent(searchMatch[1]);
				try {
					const body = await readBody(req);
					const { query, limit } = JSON.parse(body || '{}');
					const idx = getAgentIndex(agentId);
					const results = (idx && query) ? idx.search(query, limit || 20).map(r => ({ id: r.id, score: r.score })) : [];
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(results));
				} catch (err) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
				}
				return;
			}

			const statsMatch = url.pathname.match(/^\/stats\/(.+)$/);
			if (statsMatch && req.method === 'GET') {
				const agentId = decodeURIComponent(statsMatch[1]);
				const idx = getAgentIndex(agentId);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ indexSize: idx ? idx.size : 0, serverAvailable: true }));
				return;
			}

			// ── Legacy file endpoints (backward compat + migration) ─────────
			const memMatch = url.pathname.match(/^\/mem\/([^/]+)\/(.+)$/);
			if (memMatch) {
				const agentId = sanitize(memMatch[1]);
				const fileName = sanitize(memMatch[2]);
				const agentDir = path.join(dataDir, agentId);
				const filePath = path.join(agentDir, fileName);

				if (!filePath.startsWith(path.resolve(agentDir))) {
					res.writeHead(403, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'forbidden' }));
					return;
				}

				if (req.method === 'GET') {
					try {
						const content = fs.readFileSync(filePath, 'utf8');
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(content);
					} catch (err) {
						if (err.code === 'ENOENT') {
							res.writeHead(200, { 'Content-Type': 'application/json' });
							res.end('[]');
						} else {
							res.writeHead(500, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({ error: err.message }));
						}
					}
					return;
				}

				if (req.method === 'PUT') {
					pendingWrites++;
					try {
						const chunks = [];
						for await (const chunk of req) { chunks.push(chunk); }
						const body = Buffer.concat(chunks).toString('utf8');
						fs.mkdirSync(agentDir, { recursive: true });
						const tmpPath = filePath + `.tmp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
						fs.writeFileSync(tmpPath, body, 'utf8');
						fs.renameSync(tmpPath, filePath);
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ ok: true, bytes: body.length }));
					} finally {
						pendingWrites--;
					}
					return;
				}
			}

		// ── Provider RPC (Opt1: real IMemoryProvider runs in the gateway) ──
		const provMatch = url.pathname.match(/^\/provider\/([^/]+)$/);
		if (provMatch && req.method === 'POST') {
			const method = decodeURIComponent(provMatch[1]);
			if (!providerInstance || PROVIDER_METHOD_BLACKLIST.has(method) || typeof providerInstance[method] !== 'function') {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'unknown provider method', method }));
				return;
			}
			try {
				const body = await readBody(req);
				const { args } = JSON.parse(body || '{}');
				const arr = Array.isArray(args) ? args : [];
				// agentId 不再经模块级可变字段传递——provider 方法内部沿参数链
				// 显式下传至索引 getter（2026-07-25 P1 并发安全）。
				const result = await providerInstance[method](...arr);
				logProviderCall(method, arr, result);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				// void 方法（writeMemory/forgetMemory/setSlot…）返回 undefined ——
				// 若直接序列化为 null，renderer 代理的 `_call` 会把"成功"误判为 falsy，
				// 导致 writeMemory 后本地 'memory_written' 事件不发出、UI 不自动刷新。
				// 统一包装为 { ok: true } 表示调用成功。
				res.end(JSON.stringify(result === undefined ? { ok: true } : (result ?? null)));
			} catch (err) {
				emit('error', `[provider] ${method} FAILED: ${err instanceof Error ? err.message : String(err)}`);
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			}
			return;
		}

		// ── Mesh 联邦同步（2026-07-26，复刻原版 /agentmemory/mesh/receive|export）──
		// 鉴权：AGENTMEMORY_SECRET 未配置 → 503（同步禁用）；
		// 已配置 → 要求 Bearer 匹配（401）。跨机使用需 AGENTMEMORY_HOST=0.0.0.0 绑定。
		if (url === '/mesh/receive' || url.startsWith('/mesh/receive?') || url === '/mesh/export' || url.startsWith('/mesh/export?')) {
			const secret = process.env.AGENTMEMORY_SECRET;
			if (!secret) {
				res.writeHead(503, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'mesh sync requires AGENTMEMORY_SECRET' }));
				return;
			}
			const auth = req.headers['authorization'] ?? '';
			if (auth !== `Bearer ${secret}`) {
				res.writeHead(401, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'unauthorized' }));
				return;
			}
			if (!providerInstance) {
				res.writeHead(503, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'provider not ready' }));
				return;
			}
			const urlObj = new URL(req.url, 'http://localhost');
			const agent = urlObj.searchParams.get('agent') || 'default';
			try {
				if (url.startsWith('/mesh/receive') && req.method === 'POST') {
					const body = await readBody(req);
					const payload = JSON.parse(body || '{}');
					const result = await providerInstance.meshReceive(agent, payload);
					emit('log', `[mesh] receive agent=${agent} accepted=${result?.accepted ?? 0}`);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(result ?? { accepted: 0 }));
					return;
				}
				if (url.startsWith('/mesh/export') && req.method === 'GET') {
					const since = urlObj.searchParams.get('since') || undefined;
					const scopesParam = urlObj.searchParams.get('scopes');
					const scopes = scopesParam ? scopesParam.split(',').map(s => s.trim()).filter(Boolean) : undefined;
					const result = await providerInstance.meshExport(agent, scopes, since);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(result ?? {}));
					return;
				}
				res.writeHead(405, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'method not allowed' }));
				return;
			} catch (err) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
				return;
			}
		}

		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'not found' }));
		} catch (err) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: err.message }));
		}
	});

	// AGENTMEMORY_HOST：默认 127.0.0.1（仅本机）。mesh 跨机联邦需显式绑定
	// 0.0.0.0 并配置 AGENTMEMORY_SECRET（/mesh/* 路由强制 Bearer 鉴权）。
	const bindHost = process.env.AGENTMEMORY_HOST || '127.0.0.1';
	server.listen(port, bindHost, () => {
		emit('ready', `KV store ready on port ${port}`, { port, dataDir, engine: backendKind, host: bindHost });
	});

	// ── 定期维护清扫（Opt1：弥补 ConsolidationPipeline 无自动触发的缺口）──
	// 每 N 分钟对所有 agent 执行一次全量清扫 + 技能提取 + 自动晶化。
	// 保证即使 renderer 不手动触发，gateway 侧也会周期运行。
	const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
	let _sweeping = false; // 防重叠
	const runScheduledSweep = async () => {
		if (_sweeping || !providerInstance) return;
		_sweeping = true;
		try {
			const scopes = allMemoryScopes();
			if (scopes.length === 0) return;
			emit('log', `${TAG} scheduled sweep starting for ${scopes.length} agent(s)`);
			for (const scope of scopes) {
				const agentId = scope.slice('mem:memories:'.length);
				if (!agentId) continue;
				try {
					const r = await providerInstance.runMaintenanceSweep(agentId);
					if (r.skillExtracted) {
						emit('log', `${TAG} sweep: skill extracted for ${agentId} → ${r.skillExtracted.title}`);
					}
				} catch (err) {
					emit('warn', `${TAG} sweep failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		} finally {
			_sweeping = false;
		}
	};
	// 首次延迟 30s 再启动周期清扫（给 provider 加载和索引重建留足时间），
	// 之后每 SWEEP_INTERVAL_MS 执行一次。
	setTimeout(() => { runScheduledSweep(); setInterval(runScheduledSweep, SWEEP_INTERVAL_MS); }, 30_000);
	emit('log', `${TAG} sweep scheduler registered (interval=${SWEEP_INTERVAL_MS}ms, initial delay=30s)`);

	// Graceful shutdown
	const shutdown = (sig) => {
		emit('log', `${TAG} received ${sig}, shutting down... (pending writes: ${pendingWrites})`);
		setTimeout(() => {
			try {
				if (backendKind === 'js-kv') persistJsStore();
				if (db) db.close();
				emit('log', `${TAG} database closed cleanly`);
			} catch (err) {
				emit('warn', `${TAG} database close error: ${err instanceof Error ? err.message : String(err)}`);
			}
			server.close(() => process.exit(0));
			setTimeout(() => process.exit(0), 2000);
		}, Math.min(pendingWrites * 100, 1000));
	};

	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
	emit('error', `${TAG} fatal: ${err instanceof Error ? err.message : String(err)}`, { stack: err instanceof Error ? err.stack : undefined });
	process.exit(1);
});
