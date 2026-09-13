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

// ── P1-14（2026-09-11）：网关日志落盘 ────────────────────────────────
// 背景：主进程 spawn 网关时未捕获 stdout → [mem-prune]/[mem-summary]/sweep/请求日志
// 在用户日志里完全不可见（排障时只能手动 spawn + 重定向 stdout 才能看到，
// 例如「sweep 独占 21s」就是靠这个手段定位的）。现由网关自写 dataDir/gateway.log。
// 注意：本函数不得调用 resolveDataDir()——emit 会在 resolveDataDir 内部被调用（迁移日志），
// 会递归。此处直接按同一规则推导路径。
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;
let _logFilePath; // undefined=未解析；null=不可用
let _logBytes = 0;
function gatewayLogPath() {
	if (_logFilePath !== undefined) { return _logFilePath; }
	try {
		const home = process.env.HOME || process.env.USERPROFILE || '.';
		const dir = process.env.AGENTMEMORY_DATA_DIR
			|| path.join(home, isDevMode() ? '.vssaros-dev' : '.vssaros', '.agentmemory');
		_logFilePath = path.join(dir, 'gateway.log');
		try { _logBytes = fs.statSync(_logFilePath).size; } catch { _logBytes = 0; }
	} catch { _logFilePath = null; }
	return _logFilePath;
}
function appendGatewayLog(line) {
	const p = gatewayLogPath();
	if (!p) { return; }
	try {
		// 简单轮转：超 5MB 时归档为 gateway.log.1（覆盖上一份），避免无限增长
		if (_logBytes > LOG_FILE_MAX_BYTES) {
			try { fs.renameSync(p, p + '.1'); } catch { /* ignore */ }
			_logBytes = 0;
		}
		fs.appendFileSync(p, line);
		_logBytes += line.length;
	} catch { /* 日志失败绝不影响主流程 */ }
}

function emit(kind, msg, extra = {}) {
	const obj = { kind, msg, ts: new Date().toISOString(), ...extra };
	const line = JSON.stringify(obj) + '\n';
	process.stdout.write(line);
	appendGatewayLog(line);
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
	// 2026-09-09 修复：前缀此前是已废弃的 'mem:long:'（amSchema 无此 scope）→ 恒返回 []。
	// 现对齐当前 episodic scope 'mem:memories:<agentId>'。
	const agents = new Set();
	const prefix = 'mem:memories:';
	if (backendKind === 'sqlite') {
		const rows = db.prepare("SELECT DISTINCT scope FROM kv_store WHERE scope LIKE 'mem:memories:%' AND length(value) > 1").all();
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
		return { available: false, size: 0, mode: 'trigram', search: async () => [] };
	}
	// P1-6(b)：透出 mode（trigram 伪向量 / model 真语义），检索融合层据此定权
	return {
		available: true,
		get size() { return vi.size; },
		mode: vi.mode,
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

// ── A4（2026-09-10）：孤儿/超期数据剪枝（防容量再次失控）─────────────
// 背景：实测库曾达 343MB，其中 188MB 是 subagent-* 的 semantic/obs（一次性子代理会话，
// agentId 唯一 → 永不清理），另有 17MB 无代码引用的 mem:index 残留。
// 引擎侧容量守卫（amPipeline MAX_EPISODES_PER_AGENT）只对**被访问**的 agent 生效，
// subagent scope 固化后不再被访问 → 必须由网关侧定期剪枝。
const PRUNE_TTL_MS = (() => {
	const d = Number(process.env['AGENTMEMORY_PRUNE_TTL_DAYS']);
	return Number.isFinite(d) && d > 0 ? d * 86400000 : 7 * 86400000;
})();
const PRUNE_MAX_VALUE_BYTES = (() => {
	const kb = Number(process.env['AGENTMEMORY_PRUNE_MAX_VALUE_KB']);
	return Number.isFinite(kb) && kb > 0 ? kb * 1024 : 256 * 1024;
})();
let _lastPruneAt = 0;

function pruneOrphanData(force = false) {
	if (backendKind !== 'sqlite' || !db) { return; }
	const now = Date.now();
	if (!force && now - _lastPruneAt < 24 * 3600 * 1000) { return; }
	_lastPruneAt = now;
	try {
		// ① 超期 subagent 会话数据（semantic 固化 + obs 观察暂存 + memories episodic 条目）
		// 2026-09-10 扩展：mem:memories:subagent-% 此前不在剪枝范围（实测 5309 行/7.9MB
		// 一次性 episodic 永久滞留）。注意 SQL 直删会留下 BM25/向量索引残留条目，
		// 但 subagent scope 固化后不再被检索，且重启全量重建即消除——可接受。
		const stale = db.prepare(
			"DELETE FROM kv_store WHERE (scope LIKE 'mem:semantic:subagent-%' OR scope LIKE 'mem:obs:subagent-%' OR scope LIKE 'mem:memories:subagent-%')"
			+ ' AND (updated_at IS NULL OR updated_at < ?)').run(now - PRUNE_TTL_MS);
		// ② 旧格式巨型键 / 超阈值单值（旧 extractEpisodic 的数组键 'episodic' 可深达千层）
		const oversized = db.prepare(
			"DELETE FROM kv_store WHERE (scope LIKE 'mem:semantic:%' OR scope LIKE 'mem:obs:%' OR scope LIKE 'mem:index%')"
			+ " AND (key = 'episodic' OR LENGTH(value) > ?)").run(PRUNE_MAX_VALUE_BYTES);

		// ③ 遗留 scope（2026-09-11）：V1 时代产物——当前 amSchema 的 KV 定义里已无
		//    vector / short / long / episodic 四族（无任何代码读取），实测滞留约 1.5MB
		//    （458KB 的 mem:vector:coder 等正是「OVERSIZED」告警的来源，此前提示 "run prune"
		//    但 prune 并不覆盖这些 scope → 文案误导）。
		const legacy = db.prepare(
			"DELETE FROM kv_store WHERE (scope LIKE 'mem:vector:%' OR scope LIKE 'mem:short:%' OR scope LIKE 'mem:long:%' OR scope LIKE 'mem:episodic:%')"
			+ ' AND (updated_at IS NULL OR updated_at < ?)').run(now - PRUNE_TTL_MS);

		// ④ retention 分数残留（2026-09-11）：retentionScore 每轮 sweep 全量重写**活跃**条目
		//    的分数 → 超期行必为孤儿（被替代/已删记忆的残留，无代码会读）。
		//    实测该 scope 40237 行 / 7.4MB，是库内第二大族。
		const staleScores = db.prepare(
			"DELETE FROM kv_store WHERE scope LIKE 'mem:retention:%' AND (updated_at IS NULL OR updated_at < ?)"
		).run(now - 7 * 86400000);

		// ⑤（2026-09-11 撤回）曾尝试「死 agent 的派生数据清理」：以「既无 memories 也无
		//    semantic/obs」判定 agent 已死，清理其 graph/index/retention 等派生 scope。
		//    实测**误判**：只写 graph（P1-7 图谱持久化）或只写 index 的 agent 会被判死 →
		//    冒烟用例「重启后图谱 KV 仍在」失败。收益仅 69 行（0.03%），风险不成比例，故撤回。
		//    若将来重做：活跃判据必须覆盖**全部内容型 scope**（graph/lessons/procedural/
		//    crystals/core-memory/summaries…），且各 scope 族的 agent 段位置不同
		//    （mem:obs:<agent>:<sid> 在前、mem:graph:nodes:<agent> 在后），不可用统一切分。

		const removed = (stale.changes ?? 0) + (oversized.changes ?? 0) + (legacy.changes ?? 0) + (staleScores.changes ?? 0);
		if (removed > 0) {
			// 轻量回收 WAL；完整 VACUUM 会锁库，留给手工维护
			try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
			emit('log', `[mem-prune] removed ${removed} row(s): stale-subagent=${stale.changes ?? 0} oversized/legacy=${oversized.changes ?? 0} v1-legacy=${legacy.changes ?? 0} stale-scores=${staleScores.changes ?? 0}`);
		}
	} catch (err) {
		emit('warn', `[mem-prune] failed: ${err instanceof Error ? err.message : String(err)}`);
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
	// A4：启动即剪枝一次（subagent 遗留/旧格式巨型键），之后每 24h 由 sweep 触发
	pruneOrphanData(true);

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
						// 2026-09-09 修复：HTTP 写路径此前只更新 BM25 不更新向量索引，
						// 与 InProcessKV.set（双写）行为不一致 → 经 HTTP 写入的记忆检索不到向量流。
						indexMemoryPutVector(scope, key, body);
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
						// 2026-09-09 修复：与 PUT 对称，删除时同步移除向量索引
						indexMemoryDeleteVector(scope, key, removedId);
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
					// 2026-09-09 修复：删除整个 scope 前先从 BM25/向量索引移除条目
					//（此前索引残留已删记忆，直到下次启动全量重建才消失）。
					if (/^mem:memories:(.+)$/.test(scope)) {
						for (const k of listKeys(scope)) {
							let removedId;
							try { removedId = JSON.parse(getKV(scope, k) ?? 'null')?.id; } catch { /* ignore */ }
							indexMemoryDelete(scope, k, removedId);
							indexMemoryDeleteVector(scope, k, removedId);
						}
					}
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
		// 2026-09-09 修复：url 是 URL 对象（上方 new URL），此前对它做字符串相等比较/
		// 调 .startsWith 抛 TypeError 被外层 catch 兜成 500 → /mesh/* 永不可达，
		// 且所有未匹配路径返回 500 而非 404。现统一用 url.pathname 判定。
		const meshPath = url.pathname;
		if (meshPath === '/mesh/receive' || meshPath === '/mesh/export') {
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
			const agent = url.searchParams.get('agent') || 'default';
			try {
				if (meshPath === '/mesh/receive' && req.method === 'POST') {
					const body = await readBody(req);
					const payload = JSON.parse(body || '{}');
					const result = await providerInstance.meshReceive(agent, payload);
					emit('log', `[mesh] receive agent=${agent} accepted=${result?.accepted ?? 0}`);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(result ?? { accepted: 0 }));
					return;
				}
				if (meshPath === '/mesh/export' && req.method === 'GET') {
					const since = url.searchParams.get('since') || undefined;
					const scopesParam = url.searchParams.get('scopes');
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
		// 启动后 5s 输出一次各 agent 健康度（不等首轮清扫）
		setTimeout(() => {
			try {
				for (const scope of allMemoryScopes()) { logMemSummary(scope.slice('mem:memories:'.length)); }
			} catch { /* ignore */ }
		}, 5000);
	});

	// ── 定期维护清扫（Opt1：弥补 ConsolidationPipeline 无自动触发的缺口）──
	// 每 N 分钟对所有 agent 执行一次全量清扫 + 技能提取 + 自动晶化。
	// 保证即使 renderer 不手动触发，gateway 侧也会周期运行。
	const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
	let _sweeping = false; // 防重叠
	/** P1-12：每轮 sweep 最多处理的 agent 数（游标轮转，防单轮长阻塞） */
	const SWEEP_MAX_AGENTS_PER_TICK = 5;
	let _sweepCursor = 0;

	// ── P1-9（2026-09-09）：检索健康度诊断行（对齐 codebase 图谱 [summary] 模式）──
	// 每轮清扫后打一行：indexed/total < 90% → ⚠ DEFICIENT（warn）。
	// 背景：伪向量降级/索引 FIFO 淘汰/双写不一致等问题此前零信号——
	// 「有降级路径 ≠ 主路径可用」，降级必须有健康度出口。
	const MEM_SUMMARY_MIN_RATIO = 0.9;

	/** 库级容量统计（60s 缓存——最大单值需全表扫描，不宜每 agent 都算） */
	let _dbStats = { at: 0, sizeMB: 0, maxValueKB: 0 };
	function getDbStats() {
		const now = Date.now();
		if (now - _dbStats.at < 60_000) { return _dbStats; }
		let sizeMB = 0, maxValueKB = 0;
		try {
			// 注意：本文件只 `import * as path`，没有裸 join —— 必须 path.join
			const files = backendKind === 'sqlite'
				? [path.join(dataDir, 'state_store.db'), path.join(dataDir, 'state_store.db-wal')]
				: [path.join(dataDir, 'kv_store.json')];
			for (const f of files) {
				try { sizeMB += fs.statSync(f).size / (1024 * 1024); } catch { /* ignore */ }
			}
			if (backendKind === 'sqlite' && db) {
				const r = db.prepare('SELECT MAX(LENGTH(value)) n FROM kv_store').get();
				maxValueKB = Math.round((r?.n ?? 0) / 1024);
			}
		} catch { /* ignore */ }
		_dbStats = { at: now, sizeMB: Number(sizeMB.toFixed(1)), maxValueKB };
		return _dbStats;
	}

	function logMemSummary(agentId) {
		if (!agentId) return;
		try {
			const scope = `mem:memories:${agentId}`;
			const values = listAll(scope);
			let total = 0;
			for (const v of Object.values(values)) {
				try {
					const o = typeof v === 'string' ? JSON.parse(v) : v;
					if (o && o.content && o.isLatest !== false && o.deleted !== true) { total++; }
				} catch { /* skip non-memory value */ }
			}
			const idx = indexByAgent.get(agentId);
			const indexed = idx ? idx.size : 0;
			const evicted = idx && typeof idx.evictedCount === 'number' ? idx.evictedCount : 0;
			const vi = vectorIndexByAgent.get(agentId);
			const vectorSize = vi ? vi.size : 0;
			const stats = getDbStats();
			const deficient = total > 0 && indexed < Math.ceil(total * MEM_SUMMARY_MIN_RATIO);
			// 容量告警：单值超剪枝阈值（默认 256KB）或库超 500MB
			const oversized = stats.maxValueKB > (PRUNE_MAX_VALUE_BYTES / 1024);
			const bloated = stats.sizeMB > 500;
			const bad = deficient || oversized || bloated;
			const notes = [
				deficient ? 'DEFICIENT — memory unreachable from search index (rebuild or raise AGENTMEMORY_BM25_MAX_DOCS)' : null,
				oversized ? `OVERSIZED value ${stats.maxValueKB}KB (>${Math.round(PRUNE_MAX_VALUE_BYTES / 1024)}KB) — legacy array key? run prune` : null,
				bloated ? `DB ${stats.sizeMB}MB >500MB — run VACUUM / prune` : null,
			].filter(Boolean).join('; ');
			emit(bad ? 'warn' : 'log',
				`[mem-summary] agent=${agentId} indexed=${indexed}/${total} evicted=${evicted} | vector=${vectorSize} | db=${stats.sizeMB}MB maxValue=${stats.maxValueKB}KB | ${bad ? '⚠ ' + notes : '✓ ok'}`);
		} catch (err) {
			// 诊断绝不打断清扫
			emit('log', `[mem-summary] agent=${agentId} diagnostic failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const runScheduledSweep = async () => {
		// A4：剪枝（内部 24h 节流）先于清扫，避免清扫扫描刚被删的数据
		pruneOrphanData();
		if (_sweeping || !providerInstance) return;
		_sweeping = true;
		try {
			const scopes = allMemoryScopes();
			if (scopes.length === 0) return;
			// P1-12（2026-09-11）：分片 + 让出事件循环。
			// 背景：实测用户日志出现 observe/triggerHook/onTaskCompleted 同时 5s 超时——
			// 引擎侧 runFullSweep 内含数千次**同步** sqlite 调用（retentionScore 逐条
			// getAccessLog + 全量写回），一次扫全部 agent 会让网关事件循环长时间独占，
			// HTTP 请求排队超时 → renderer 误判 UNREACHABLE。
			// 现每轮最多处理 SWEEP_MAX_AGENTS_PER_TICK 个（游标轮转），且 agent 之间
			// 让出事件循环，把单次阻塞窗口从"全部 agent"压到"1 个 agent"。
			const tick = scopes.slice(_sweepCursor, _sweepCursor + SWEEP_MAX_AGENTS_PER_TICK);
			_sweepCursor = (_sweepCursor + tick.length) >= scopes.length ? 0 : _sweepCursor + tick.length;
			emit('log', `${TAG} scheduled sweep: ${tick.length}/${scopes.length} agent(s) (cursor→${_sweepCursor})`);
			for (const scope of tick) {
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
				logMemSummary(agentId);
				// 让出事件循环：给并发 HTTP 请求插队机会
				await new Promise(r => setImmediate(r));
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
