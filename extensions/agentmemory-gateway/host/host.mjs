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
import { Worker } from 'node:worker_threads';
import {
	INDEX_CACHE_VERSION,
	BM25_CACHE_FILE,
	VECTOR_CACHE_FILE,
	readCacheFile,
	writeCacheFile,
	validateCache,
	nextSaveDelayMs,
} from './indexCache.mjs';

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
/** P0-1（2026-09-19）：真语义 embedding 函数（与 VectorCtor 同源取；未加载则 null ⇒ 只走 trigram）。 */
let EmbedFn = null;
/** P1-1：`getEmbeddingProviderInfo`（vectorIndex.js 导出）—— 当前生效的 embedding provider（供 indexCache 记录/对比）。 */
let ProviderInfoFn = null;
const indexByAgent = new Map();
const vectorIndexByAgent = new Map();
/**
 * 待增量构建的 model 向量 id 集合（启动时从 model 制品恢复后记录，`buildModelVectorsIfEnabled` 消费）。
 * 语义 = 「库有但向量索引没有」的 id —— 可能是新写入的记忆，或上次构建被中断留下的缺口。
 * key = agentId，value = Set<id>。启动时清空，构建完对应 agent 后删除。
 */
const _pendingModelVectorIds = new Map();

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
				// P0-1：一并取出真语义 embed（可用性由 getPipeline 内部判；不可用时 embed 返回 null）
				if (typeof mod.embed === 'function') { EmbedFn = mod.embed; }
				// P1-1：一并取出 embedding provider 信息（供 indexCache 记录/对比 —— 切换 provider ⇒ 全量重建）
				if (typeof mod.getEmbeddingProviderInfo === 'function') { ProviderInfoFn = mod.getEmbeddingProviderInfo; }
				emit('info', `${TAG} ✅ VectorIndex loaded from ${c} (embed=${typeof EmbedFn === 'function' ? 'yes' : 'no'}, providerInfo=${typeof ProviderInfoFn === 'function' ? 'yes' : 'no'})`);
				return;
			}
		} catch (err) {
			emit('warn', `${TAG} VectorIndex load failed (${c}): ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	emit('warn', `${TAG} vectorIndex module not found; /search vector branch disabled (BM25-only).`);
}

// ── P0-1（2026-09-19）：真语义 embedding 的宿主侧适配 ────────────────────
// 背景（探针实测）：包默认入口 require('sharp')（本仓 node_modules 里装坏 ⇒ pipeline 恒不可用），
// 改走 dist 的 web/WASM 构建（不 require sharp、自带 ort-wasm-*.wasm）；而 web 构建还需要
// ① `self` 全局（扩展侧补）② **用 fetch 读文件** ⇒ Node 的 fetch 不支持 file:// ⇒ 在这里拦一层，
// 否则本地模型加载报 "fetch failed"。模型资产改为**预下载**（Node fetch 不走系统代理，实测拉不到）。
const AM_EXT_ROOT = process.env['AGENTMEMORY_EXT_ROOT']
	|| path.join(__dirname, '..', '..', 'agentmemory-memory');

/** 注入模型 / wasm 目录（扩展侧只读 env；renderer 读不到 env，故只对本进程有效）。 */
function setupEmbeddingPaths() {
	try {
		if (!process.env['AGENTMEMORY_MODEL_DIR']) {
			const home = process.env.HOME || process.env.USERPROFILE || '.';
			process.env['AGENTMEMORY_MODEL_DIR'] = path.join(home, '.agentmemory-models');
		}
		// ⚠ @xenova 会把 `localModelPath` 当 **URL 前缀**去 fetch：给裸 Windows 路径
		// （`C:/Users/...`）会直接 "fetch failed"。所以额外注入 file:// 形式（扩展侧优先用它）。
		if (!process.env['AGENTMEMORY_MODEL_URL']) {
			process.env['AGENTMEMORY_MODEL_URL'] = pathToFileURL(process.env['AGENTMEMORY_MODEL_DIR']).href;
		}
		if (!process.env['AGENTMEMORY_WASM_DIR']) {
			const wasmDir = path.join(AM_EXT_ROOT, 'node_modules', '@xenova', 'transformers', 'dist');
			process.env['AGENTMEMORY_WASM_DIR'] = pathToFileURL(wasmDir).href + '/';
		}
		emit('log', `${TAG} embedding paths: modelDir=${process.env['AGENTMEMORY_MODEL_DIR']} wasmDir=${process.env['AGENTMEMORY_WASM_DIR']}`);
	} catch (err) {
		emit('warn', `${TAG} setupEmbeddingPaths failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

let _fileFetchShimInstalled = false;
/** 让 `fetch('file://...')` 可读本地文件（@xenova 的 web 构建读模型/词表走这条路）。 */
function installFileFetchShim() {
	if (_fileFetchShimInstalled) return;
	_fileFetchShimInstalled = true;
	const origFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = async (input, init) => {
		try {
			const href = typeof input === 'string' ? input
				: input instanceof URL ? input.href
					: (input && typeof input.url === 'string') ? input.url : '';
			// 兼容三种形态：file:// URL、裸盘符路径（C:/x）、POSIX 绝对路径（/x）——
			// @xenova 在不同分支里可能直接传裸路径，这类 fetch 本来必然失败，拦下来读文件是纯增强。
			const isFileLike = href.startsWith('file://') || /^[A-Za-z]:[\\/]/.test(href) || href.startsWith('/');
			if (isFileLike) {
				const fsPath = href.startsWith('file://') ? fileURLToPath(href) : href;
				const body = await fs.promises.readFile(fsPath);
				// ⚠ .wasm 必须给 application/wasm：ONNX Runtime 走 `WebAssembly.instantiateStreaming`，
				// 错误的 Content-Type 会让它拒绝（或退化成非流式并失败）。
				const isWasm = /\.wasm$/i.test(fsPath);
				return new Response(body, {
					status: 200,
					headers: { 'Content-Type': isWasm ? 'application/wasm' : 'application/octet-stream' },
				});
			}
		} catch { /* 落到原 fetch：让真实错误浮出来，而不是被 shim 吞掉 */ }
		return origFetch(input, init);
	};
}

/** 用 trigram 把某 agent 的向量索引重建回来（model 构建全失败时的回退，避免"空索引 + mode=model"）。 */
function rebuildAgentVectorIndexTrigram(agentId, items) {
	const vi = getAgentVectorIndex(agentId);
	if (!vi) return 0;
	vi.clear();
	for (const it of items) { vi.addText(it.id, it.content); }
	return vi.size;
}

/**
 * P0-1：后台「真语义向量」构建（**默认开启**，2026-09-19 落地）。
 *
 * 决策：改为默认开（显式 `AGENTMEMORY_MODEL_EMBEDDING=off` 才关）。理由：① 模型已可自动下载
 * （xenova 首次 `EmbedFn` 调用触发，落 `cacheDir`，下次直接命中；默认走 hf-mirror.com）；② 下载
 * 与构建都在**后台**（本函数被 `void` 调用，不阻塞网关就绪与首轮可用），构建期间向量流仍是
 * trigram ⇒ 体验零变化；③ trigram 伪向量只能"查询与库同源"，检索质量远低于真语义（上游实测
 * LongMemEval R@5：BM25+真向量 95.2% vs BM25-only 86.2%，**向量贡献 +9pp**）。
 *
 * 失败路径（全部自动回退 trigram，不报错）：模型下载失败 / pipeline 初始化失败 /
 * 某 agent 构建出 0 条向量。
 *
 * 关键约束：`VectorIndex._mode` 是**实例级单值**（trigram 与 model 的余弦得分不可比）⇒ 必须
 * **逐 agent 先 clear 再全量写 model 向量**（原子切换），失败则该 agent 回退 trigram。
 * 完成后落盘（P0-2）⇒ 下次启动直接从制品恢复 model 向量，不必重算。
 */
// ─── P2-3：Model Vectors Worker（真语义向量构建搬出主线程）────────────────
/**
 * 常驻 Worker（model 向量构建搬出主线程，P2-3 2026-09-19）。
 * 背景：model 向量构建 ~240s（10033 doc）在**主线程**执行 ⇒ 阻塞 `/provider` 响应
 * （renderer 5s 超时误判风险）。搬进 Worker ⇒ 主线程只处理 HTTP 请求。
 * Worker 独立打开 SQLite（readonly，WAL 多连接读安全）+ 常驻复用模型加载；
 * 主线程逐 agent 串行发任务（`await` 完成再下一个）。
 * Worker spawn 失败 ⇒ 永久标记（`_modelVectorsWorkerFailed`）⇒ 回退主线程构建。
 */
let _modelVectorsWorker = null;
let _modelVectorsWorkerFailed = false;
function getModelVectorsWorker() {
	if (_modelVectorsWorker || _modelVectorsWorkerFailed) { return _modelVectorsWorker; }
	try {
		_modelVectorsWorker = new Worker(new URL('./modelVectorsWorker.mjs', import.meta.url), {
			workerData: {
				// ⚠ dataDir 是 resolveDataDir() 的局部变量（main() 里遮蔽）⇒ 模块级函数访问不到 ⇒ 直接调用 resolveDataDir()
				dbPath: path.join(resolveDataDir(), 'state_store.db'),
				extRoot: process.env['AGENTMEMORY_EXT_ROOT'],
			},
		});
		_modelVectorsWorker.on('message', (msg) => {
			if (msg.type === 'log') { emit('log', `${TAG} [worker] ${msg.msg}`); }
			else if (msg.type === 'warn') { emit('warn', `${TAG} [worker] ${msg.msg}`); }
			else if (msg.type === 'progress') { emit('log', `${TAG} [worker] ${msg.agentId}: ${msg.built}/${msg.total}`); }
		});
		_modelVectorsWorker.on('error', (err) => {
			emit('warn', `${TAG} [worker] error: ${err.message}`);
		});
		emit('log', `${TAG} [worker] spawned（model vectors 构建搬出主线程）`);
	} catch (err) {
		emit('warn', `${TAG} [worker] spawn failed（回退主线程构建）: ${err instanceof Error ? err.message : String(err)}`);
		_modelVectorsWorkerFailed = true;
		_modelVectorsWorker = null;
	}
	return _modelVectorsWorker;
}

/** 向 Worker 发任务并等完成（带超时；Worker 不可用时返回 null ⇒ 调用方回退主线程）。 */
function buildInWorker(agentId, scope, pendingIds) {
	return new Promise((resolve) => {
		const worker = getModelVectorsWorker();
		if (!worker) { resolve(null); return; }
		const onMsg = (msg) => {
			if (msg.type === 'done' && msg.agentId === agentId) {
				worker.off('message', onMsg);
				resolve(msg);
			}
		};
		worker.on('message', onMsg);
		worker.postMessage({ type: 'build', agentId, scope, pendingIds });
		// 超时保护（单个 agent 最长 5 分钟）
		setTimeout(() => { worker.off('message', onMsg); resolve({ type: 'done', agentId, error: 'worker timeout' }); }, 300_000);
	});
}

async function buildModelVectorsIfEnabled() {
	if (process.env['AGENTMEMORY_MODEL_EMBEDDING'] === 'off') return;
	if (typeof EmbedFn !== 'function') {
		emit('warn', `${TAG} [model-vectors] 真语义 embedding 默认开但 embed() 未加载（检查 modelDir/wasmDir 与模型文件是否齐；如需关闭请设 AGENTMEMORY_MODEL_EMBEDDING=off）`);
		return;
	}
	// P2-3：Worker 优先（搬出主线程）；Worker 不可用则回退主线程构建（下方原逻辑）。
	const useWorker = getModelVectorsWorker() !== null;
	const t0 = Date.now();
	let built = 0, failed = 0, done = 0;
	try {
		for (const scope of allMemoryScopes()) {
			const agentId = scope.slice('mem:memories:'.length);
			const items = [];
			for (const val of Object.values(listAll(scope))) {
				try {
					const obj = JSON.parse(val);
					if (obj && obj.content && obj.isLatest !== false && obj.deleted !== true) {
						items.push({ id: obj.id || '', content: obj.content });
					}
				} catch { /* skip */ }
			}
			if (items.length === 0) continue;
			const vi = getAgentVectorIndex(agentId);
			if (!vi) continue;

			// ─── P2-3：Worker 优先（搬出主线程；成功则 continue，失败落到下方主线程回退）───
			if (useWorker) {
				const wPending = _pendingModelVectorIds.get(agentId);
				const isIncremental = vi.mode === 'model';
				const pendingIds = isIncremental && wPending ? [...wPending] : undefined;
				const result = await buildInWorker(agentId, scope, pendingIds);
				if (result && !result.error && Array.isArray(result.vectors) && result.vectors.length > 0) {
					if (!isIncremental) { vi.clear(); } // 全量切换：清掉 trigram（原子切换，避免两种语义空间混存）
					vi.importVectors(result.vectors);
					vi.setMode('model');
					if (wPending) { _pendingModelVectorIds.delete(agentId); }
					done++;
					built += result.built ?? result.vectors.length;
					emit('log', `${TAG} [model-vectors] ${agentId}: ${result.vectors.length} doc in model mode (worker, failed=${result.failed ?? 0})`);
					continue;
				}
				if (result?.error) {
					emit('warn', `${TAG} [model-vectors] ${agentId}: worker failed (${result.error}) ⇒ 回退主线程构建`);
				}
				// Worker 失败/空 ⇒ 落到下方主线程回退（原逻辑）
			}

			// ★ 增量路径：model 制品已恢复（mode=model 且有 pending 记录）⇒ 只构建「库有但向量没有」的 id，
			//   **不 clear、不重算已有的**（全量 ~240s → 增量通常 <1s）。这是让"默认开启"可落地的关键：
			//   否则每次启动（库有写入 ⇒ 指纹 stale）都要重新全量构建 4 分钟。
			const pending = _pendingModelVectorIds.get(agentId);
			// ★ model 制品已恢复 ⇒ **绝不走全量**（否则每次都重新构建，把"恢复"变成"重建"，全量路径的
			//   `vi.clear()` 会丢掉刚恢复的向量）。pending 空 ⇒ 无需构建；pending 非空 ⇒ 增量补齐。
			if (vi.mode === 'model') {
				if (pending && pending.size > 0) {
					const toBuild = items.filter(it => pending.has(it.id));
					let ok = 0;
					for (let i = 0; i < toBuild.length; i++) {
						try {
							const vec = await EmbedFn(toBuild[i].content);
							if (vec && vec.length > 0) { vi.addModelVector(toBuild[i].id, vec); ok++; }
							else { failed++; }
						} catch { failed++; }
						if ((i + 1) % 20 === 0) { await new Promise(r => setImmediate(r)); }
					}
					_pendingModelVectorIds.delete(agentId);
					built += ok;
					emit('log', `${TAG} [model-vectors] ${agentId}: 增量 +${ok} doc（库 ${items.length} / 向量 ${vi.size}）failed=${toBuild.length - ok}`);
				} else {
					emit('log', `${TAG} [model-vectors] ${agentId}: model 制品已恢复（${vi.size} doc），无需构建`);
				}
				done++;
				continue;
			}

			// 全量路径（首次切换 trigram → model，或 model 制品为空/不存在）。
			vi.clear(); // 原子切换：先清掉 trigram，避免两种语义空间混存
			let ok = 0;
			for (let i = 0; i < items.length; i++) {
				try {
					const vec = await EmbedFn(items[i].content);
					if (vec && vec.length > 0) { vi.addModelVector(items[i].id, vec); ok++; }
					else { failed++; }
				} catch { failed++; }
				if ((i + 1) % 20 === 0) { await new Promise(r => setImmediate(r)); } // 让出事件循环（单线程网关）
				if ((i + 1) % 250 === 0) {
					emit('log', `${TAG} [model-vectors] ${agentId}: ${i + 1}/${items.length} built=${ok} mode=${vi.mode}`);
				}
			}
			if (vi.size === 0) {
				const back = rebuildAgentVectorIndexTrigram(agentId, items);
				emit('warn', `${TAG} [model-vectors] ${agentId}: 0 vector built ⇒ 回退 trigram（${back} doc）`);
			} else {
				done++;
				emit('log', `${TAG} [model-vectors] ${agentId}: ${vi.size} doc in model mode (failed=${items.length - ok})`);
			}
			built += ok;
		}
		void saveIndexCache('model-vectors');
		emit('log', `${TAG} [model-vectors] done: ${built} vector(s) across ${done} agent(s), failed=${failed}, ${Date.now() - t0}ms`);
	} catch (err) {
		emit('warn', `${TAG} [model-vectors] aborted: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// ─── 向量 index getter ──────────────────────────────────────────
// 注：VectorCtor 由启动时的 await resolveVectorModule() 预加载（main()）。
// 此处不再懒加载（async 无法在同步 getter 中 await），未加载则退化为 null → BM25-only。
const getAgentVectorIndex = (agentId) => {
	let vi = vectorIndexByAgent.get(agentId);
	if (!vi) {
		if (!VectorCtor) { return null; }
		// 注：此前传的是 `{ useTrigramFallback: true }`，但 VectorIndex 的构造签名是
		// `constructor(maxDocs?: number)` —— 对象会被 `Number.isFinite` 拒绝 ⇒ 一直走默认值。
		// 行为无变化（默认仍是 trigram），但别让它看起来像一个不存在的开关。
		vi = new VectorCtor();
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
		markIndexDirty(); // P0-2：索引内容已变 ⇒ 排队落盘
	} catch { /* not a memory object */ }
}

function indexMemoryDelete(scope, key, removedId) {
	const m = /^mem:memories:(.+)$/.exec(scope);
	if (!m || !BM25Ctor) return;
	const idx = getAgentIndex(m[1]);
	if (idx) { idx.remove(removedId || key); markIndexDirty(); }
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
		if (!vi) return;
		// 2026-09-19：与 BM25 路径**对齐 isLatest/deleted 语义**。此前增量写向量时不做此判断，
		// 而被 supersede 取代的旧条目只在 BM25 侧被移出 ⇒ 它仍能从**向量通道**被召回
		//（重建后消失、增量时残留 —— 双写不一致）。演练实测：3 条相似记忆 supersede 后
		// BM25=1 doc 而 vector=3 doc。
		if (obj.isLatest === false || obj.deleted === true) { vi.remove(obj.id); markIndexDirty(); return; }
		vi.addText(obj.id, content);  // trigram 同步 embedding（无需 transformers）
		markIndexDirty();
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
			markIndexDirty();
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
	rebuildBm25IndexesFromKV();
	rebuildVectorIndexesOnly();
}

/** 全量重建 BM25（逐 agent 一个索引实例）。返回文档数。 */
function rebuildBm25IndexesFromKV() {
	if (!BM25Ctor) return 0;
	let total = 0;
	try {
		indexByAgent.clear(); // scope 已消失的 agent 不能留下残留索引
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
	return total;
}

/** 全量重建向量索引（trigram fallback，无模型依赖，纯 CPU）。 */
function rebuildVectorIndexesOnly() {
	if (!VectorCtor) return 0;
	let viTotal = 0;
	try {
		vectorIndexByAgent.clear();
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
	return viTotal;
}

// ═══════════════════════════════════════════════════════════════════════════
// P0-2（2026-09-19）：索引制品缓存 —— 冷启动从「全量重建 4.2s」降为「读制品」
//
// 制品与判据详见 ./indexCache.mjs 顶部说明。这里只放"接进网关"的部分：
//   · 启动：tryLoadIndexCache() 命中 ⇒ 跳过重建；未命中 ⇒ 重建 + 立即落盘建缓存
//   · 运行：任何索引变更（入 InProcessKV 写/删）⇒ markIndexDirty() 排队落盘（节流）
//   · 退出：shutdown 时**同步**落盘一次（异步的活不到进程结束）
// ═══════════════════════════════════════════════════════════════════════════
const INDEX_SAVE_THROTTLE_MS = (() => {
	const n = Number(process.env['AGENTMEMORY_INDEX_SAVE_THROTTLE_MS']);
	return Number.isFinite(n) && n >= 0 ? n : 30_000;
})();
const INDEX_SAVE_MAX_DELAY_MS = (() => {
	const n = Number(process.env['AGENTMEMORY_INDEX_SAVE_MAX_DELAY_MS']);
	return Number.isFinite(n) && n > 0 ? n : 5 * 60_000;
})();
let _indexCacheCtx = null;
let _indexSaveTimer = null;
let _indexDirtySince = 0;

function setIndexCacheCtx(ctx) { _indexCacheCtx = ctx; }

/**
 * KV 指纹：rows 覆盖删除、maxUpdatedAt 覆盖写入/更新、sumLen 覆盖「同毫秒改写同长度值」。
 * 取不到指纹返回 null（⇒ 制品判为不可用 ⇒ 重建，宁可慢也不可用错索引）。
 */
function kvFingerprint() {
	try {
		if (backendKind === 'sqlite' && db) {
			const r = db.prepare(
				'SELECT COUNT(*) AS rows, IFNULL(MAX(updated_at), 0) AS maxUpdatedAt, IFNULL(SUM(LENGTH(value)), 0) AS sumLen FROM kv_store'
			).get();
			return { rows: Number(r?.rows ?? 0), maxUpdatedAt: Number(r?.maxUpdatedAt ?? 0), sumLen: Number(r?.sumLen ?? 0) };
		}
		let rows = 0, sumLen = 0;
		for (const m of store.values()) {
			for (const v of m.values()) { rows++; sumLen += typeof v === 'string' ? v.length : 0; }
		}
		return { rows, maxUpdatedAt: 0, sumLen };
	} catch (err) {
		emit('warn', `${TAG} kv fingerprint failed: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

/** 当前生效的 embedding provider（供 indexCache 记录/对比；未启用远端 provider 时为 null ⇒ 记为 'local'）。 */
function currentEmbeddingProvider() {
	try { return typeof ProviderInfoFn === 'function' ? ProviderInfoFn() : null; } catch { return null; }
}

/** 汇总将要落盘的制品内容（async / sync 两条路径共用）。返回 null 表示"不该落盘"。 */
function collectIndexCachePayload() {
	const fp = kvFingerprint();
	if (!fp) return null;
	const bm25Agents = {};
	let bm25Docs = 0;
	for (const [agentId, idx] of indexByAgent) {
		if (!idx || idx.size === 0) continue;
		bm25Agents[agentId] = idx.serializePayload();
		bm25Docs += idx.size;
	}
	// ★ 空索引绝不落盘：它会把一份可用制品覆盖成"加载成功但检索为空"
	//   （「本会话此刻不知道它」≠「它是空的」—— CodebaseGraph 99 字节空图事故同型）
	if (bm25Docs === 0) return null;

	const vecAgents = {};
	let vecDocs = 0, vecMode = 'trigram';
	for (const [agentId, vi] of vectorIndexByAgent) {
		if (!vi || vi.size === 0) continue;
		vecAgents[agentId] = vi.exportVectors();
		vecMode = vi.mode;
		vecDocs += vi.size;
	}

	return {
		fp, bm25Docs, bm25Agents, vecDocs, vecMode, vecAgents,
		bm25Obj: { version: INDEX_CACHE_VERSION, fingerprint: fp, builtAt: Date.now(), docs: bm25Docs, agents: bm25Agents },
		vectorObj: vecDocs > 0
			? { version: INDEX_CACHE_VERSION, fingerprint: fp, builtAt: Date.now(), docs: vecDocs, mode: vecMode, provider: currentEmbeddingProvider(), agents: vecAgents }
			: null,
	};
}

/** 落盘（异步 gzip，避免阻塞网关事件循环）。并发调用会被合并/重排，避免两次写同一制品。 */
let _indexSaveInFlight = false;
async function saveIndexCache(reason) {
	const ctx = _indexCacheCtx;
	if (!ctx) return;
	if (_indexSaveInFlight) {
		// 已有落盘在飞：稍后重试一次（不丢 dirty —— `_indexDirtySince` 保持非 0）
		if (!_indexSaveTimer) {
			_indexSaveTimer = setTimeout(() => {
				_indexSaveTimer = null;
				void saveIndexCache(reason + ':retry');
			}, 1000);
			_indexSaveTimer.unref?.();
		}
		return;
	}
	_indexSaveInFlight = true;
	const t0 = Date.now();
	try {
		const p = collectIndexCachePayload();
		if (!p) {
			emit('warn', `${TAG} index cache save skipped (${reason}): 0 doc or no fingerprint — 拒绝覆盖可能完好的制品`);
			return;
		}
		await writeCacheFile(ctx.bm25File(), p.bm25Obj);
		if (p.vectorObj) await writeCacheFile(ctx.vectorFile(), p.vectorObj);
		_indexDirtySince = 0;
		emit('log', `${TAG} index cache saved (${reason}) in ${Date.now() - t0}ms: bm25=${p.bm25Docs} doc/${Object.keys(p.bm25Agents).length} agent(s), vector=${p.vecDocs} doc (mode=${p.vecMode})`);
	} catch (err) {
		emit('warn', `${TAG} index cache save failed (${reason}): ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		_indexSaveInFlight = false;
	}
}

/** 落盘（同步）—— 仅供 shutdown；异步版本在进程退出前根本轮不到。 */
function saveIndexCacheSync(reason) {
	const ctx = _indexCacheCtx;
	if (!ctx) return;
	const t0 = Date.now();
	try {
		const p = collectIndexCachePayload();
		if (!p) { emit('warn', `${TAG} index cache save skipped (${reason}): 0 doc or no fingerprint`); return; }
		writeCacheFile(ctx.bm25File(), p.bm25Obj, { sync: true });
		if (p.vectorObj) writeCacheFile(ctx.vectorFile(), p.vectorObj, { sync: true });
		emit('log', `${TAG} index cache saved (${reason}, sync) in ${Date.now() - t0}ms: bm25=${p.bm25Docs} doc, vector=${p.vecDocs} doc`);
	} catch (err) {
		emit('warn', `${TAG} index cache save failed (${reason}): ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * 从制品恢复。返回 `{ bm25, vector }` —— **两者独立**：向量缺失只需重建向量
 * （trigram 重建是纯 CPU、很快），不必因此丢掉已经可用的 BM25。
 */
function tryLoadIndexCache() {
	const ctx = _indexCacheCtx;
	const result = { bm25: false, vector: false };
	_pendingModelVectorIds.clear(); // 每次启动重置（上次中断可能残留）
	let docs = 0, agents = 0; // BM25 恢复统计（vector 判定之后统一打日志用，须在函数作用域）
	if (!ctx) return result;
	const t0 = Date.now();
	const fp = ctx.fingerprint();
	let meta = null;
	try {
		meta = readCacheFile(ctx.bm25File());
	} catch (err) {
		emit('warn', `${TAG} index cache unreadable (${err instanceof Error ? err.message : String(err)}) — full rebuild`);
	}
	if (!meta) {
		emit('log', `${TAG} index cache absent — full rebuild`);
	} else {
		const verdict = validateCache(meta, fp, INDEX_CACHE_VERSION);
		if (verdict.ok) {
			for (const [agentId, payload] of Object.entries(meta.agents)) {
				const idx = getAgentIndex(agentId);
				if (idx && idx.deserializePayload(payload) && idx.size > 0) { docs += idx.size; agents++; }
			}
			// ★ 「加载成功 ≠ 有数据」：解压/解析都成功但一条都没有 ⇒ 仍然重建
			if (docs === 0) { emit('warn', `${TAG} index cache loaded but EMPTY — full rebuild`); }
			else { result.bm25 = true; }
		} else {
			emit('log', `${TAG} index cache stale — full rebuild (${verdict.reason})`);
		}
	}
	// ★★ vector 部分**独立**判定（**不随 BM25 的 unreadable/absent/stale 而跳过**）：
	//   BM25 全量重建便宜（~2.5s），可接受全量；model 向量全量重建 ~240s，**必须**独立于指纹，
	//   靠"按 id 集合增量"恢复 —— 否则每次启动（库有写入 ⇒ 指纹 stale）都要重新全量构建 4 分钟。

	try {
		const vmeta = readCacheFile(ctx.vectorFile());
		if (!vmeta) {
			emit('log', `${TAG} vector cache absent — will rebuild vectors`);
		} else if (vmeta.mode === 'model' && vmeta.agents && typeof vmeta.agents === 'object') {
			// P1-1：provider 一致性检查 —— 切换 provider（如本地 xenova → openrouter）⇒ 维度变化 ⇒
			//   制品向量与新查询向量**不同维度**（余弦得分无意义）⇒ **全量重建**（不走增量）。
			const cacheProvider = vmeta.provider ?? null;
			const nowProvider = currentEmbeddingProvider();
			if ((cacheProvider?.name ?? 'local') === (nowProvider?.name ?? 'local')) {
				// ★ model 制品与 BM25 指纹**解耦**（重建成本 ~240s vs ~2.5s，指纹对它太贵）：
				//   直接加载（不看指纹），按 id 集合做增量 —— 库有/制品无 ⇒ 记入 `_pendingModelVectorIds`
				//   待 `buildModelVectorsIfEnabled` 增量补齐；库无/制品有 ⇒ 移除（该记忆已删除）。
				//   已存在 id 的内容不变（记忆写入是 append-only：supersede 也是新建 id）。
				//   关键是 **result.vector = true** ⇒ 启动流程不会再触发 `rebuildVectorIndexesOnly()` 的全量 trigram 重建。
				let vdocs = 0, pendingTotal = 0;
				for (const [agentId, vectors] of Object.entries(vmeta.agents)) {
					const vi = getAgentVectorIndex(agentId);
					if (!vi || !Array.isArray(vectors)) continue;
					vi.setMode('model');
					const currentIds = new Set(Object.keys(listAll(`mem:memories:${agentId}`)));
					if (currentIds.size === 0) {
						// 制品里有这个 agent 但库里已无 ⇒ 清空其向量，**不记 pending** —— 那些记忆已不存在，
						// 否则会把"已删除 agent 的向量"误报成"待构建"（实测 pending=439 全来自这类残留）。
						vi.clear();
						continue;
					}
					const imported = vi.importVectors(vectors);
					const cachedIds = new Set();
					for (const entry of vectors) {
						cachedIds.add(entry.id);
						if (!currentIds.has(entry.id)) { vi.remove(entry.id); }
					}
					const missing = [];
					for (const id of currentIds) { if (!cachedIds.has(id)) { missing.push(id); } }
					if (missing.length > 0) { _pendingModelVectorIds.set(agentId, new Set(missing)); pendingTotal += missing.length; }
					vdocs += imported;
				}
				result.vector = true;
				emit('log', `${TAG} vector model cache loaded: ${vdocs} doc restored, ${pendingTotal} pending（增量构建）`);
			} else {
				emit('log', `${TAG} vector provider changed (cache=${cacheProvider?.name ?? 'local'}, now=${nowProvider?.name ?? 'local'}) — full rebuild`);
			}
		} else {
			// 老制品（trigram 或无 mode）⇒ 按指纹判定（同 BM25；trigram 重建便宜，可接受全量）。
			const vverdict = validateCache(vmeta, fp, INDEX_CACHE_VERSION);
			if (!vverdict.ok) {
				emit('log', `${TAG} vector cache stale (${vverdict.reason}) — will rebuild vectors`);
			} else {
				let vdocs = 0;
				for (const [agentId, vectors] of Object.entries(vmeta.agents)) {
					const vi = getAgentVectorIndex(agentId);
					if (!vi || !Array.isArray(vectors)) continue;
					vi.setMode(vmeta.mode); // 查询向量必须与库内向量同源
					vi.importVectors(vectors);
					vdocs += vi.size;
				}
				result.vector = vdocs > 0;
				if (!result.vector) { emit('warn', `${TAG} vector cache loaded but EMPTY — will rebuild vectors`); }
			}
		}
	} catch (err) {
		emit('warn', `${TAG} vector cache load failed (${err instanceof Error ? err.message : String(err)}) — will rebuild vectors`);
	}

	emit('log', `${TAG} index cache loaded in ${Date.now() - t0}ms: bm25=${docs} doc across ${agents} agent(s), vector=${result.vector ? 'restored' : 'missing'}`);
	return result;
}

/**
 * 索引变更后排队落盘。语义 = **节流**（首个变更排定一次，后续变更**不重置**计时器）：
 * 若用经典防抖，"每 10s 写一条记忆"就会让落盘永远不触发（=「只在 shutdown 保存」的变体）。
 * 超过 `INDEX_SAVE_MAX_DELAY_MS` 的待发落盘立即执行。
 */
function markIndexDirty() {
	if (!_indexCacheCtx) return;
	const now = Date.now();
	if (!_indexDirtySince) { _indexDirtySince = now; }
	if (_indexSaveTimer) {
		if (now - _indexDirtySince >= INDEX_SAVE_MAX_DELAY_MS) {
			clearTimeout(_indexSaveTimer);
			_indexSaveTimer = null;
			void saveIndexCache('max-delay');
		}
		return;
	}
	const delay = nextSaveDelayMs(_indexDirtySince, now, { debounceMs: INDEX_SAVE_THROTTLE_MS, maxDelayMs: INDEX_SAVE_MAX_DELAY_MS });
	_indexSaveTimer = setTimeout(() => {
		_indexSaveTimer = null;
		void saveIndexCache('throttle');
	}, delay);
	_indexSaveTimer.unref?.();
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
	installFileFetchShim(); // P0-1：@xenova 的 web 构建用 fetch 读本地模型文件（Node 不支持 file://）
	setupEmbeddingPaths();  // P0-1：注入 modelDir / wasmDir（扩展侧只读 env）
	await resolveVectorModule();  // 先加载向量索引模块，再重建（否则 VectorCtor 恒 null）

	// P0-2（2026-09-19）：先试制品缓存，未命中才全量重建（重建后立即建缓存）。
	// 判据与制品格式 ⇒ ./indexCache.mjs。这里只负责"接进启动流程"。
	setIndexCacheCtx({
		fingerprint: kvFingerprint,
		bm25File: () => path.join(dataDir, 'index', BM25_CACHE_FILE),
		vectorFile: () => path.join(dataDir, 'index', VECTOR_CACHE_FILE),
	});
	const indexCache = tryLoadIndexCache();
	if (!indexCache.bm25) { rebuildBm25IndexesFromKV(); }
	if (!indexCache.vector) { rebuildVectorIndexesOnly(); }
	if (!indexCache.bm25 || !indexCache.vector) {
		void saveIndexCache(indexCache.bm25 ? 'initial-vector-build' : 'initial-build');
	}

	// P0-1（**默认开启**，`AGENTMEMORY_MODEL_EMBEDDING=off` 才关）：后台构建真语义向量。
	// 不 await —— 启动可用性不受影响（BM25 已就绪）；完成后原子切换 mode 并落盘。
	void buildModelVectorsIfEnabled();
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
				// P0-2：索引制品必须在 db.close() **之前**落盘（指纹要查 kv_store）；
				// 且必须走同步版——异步的 await 在 process.exit 前根本轮不到。
				saveIndexCacheSync('shutdown');
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
