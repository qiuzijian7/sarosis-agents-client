/*---------------------------------------------------------------------------------------------
 *  AgentMemory persistence server — KV store (1:1 parity with agentmemory).
 *
 *  Backend selection (resilient across Node versions):
 *    - If `node:sqlite` is available (Node 22.5+), use a SQLite KV store
 *      backed by ~/.saros/.agentmemory/state_store.db (preserves existing data).
 *    - Otherwise (e.g. Electron 39 bundles Node 20.19, which has NO
 *      node:sqlite), fall back to a pure-JS KV store backed by
 *      ~/.saros/.agentmemory/kv_store.json.
 *
 *  This avoids the previous hard crash: `import { DatabaseSync } from
 *  'node:sqlite'` at module top-level throws on Node < 22.5, killing the
 *  gateway child → port 3111 never comes up → the renderer V2 provider
 *  silently no-op'd (looked like "V2 didn't take over").
 *
 *  Storage (SQLite):  ~/.saros/.agentmemory/state_store.db (WAL)
 *  Storage (JS-KV):   ~/.saros/.agentmemory/kv_store.json
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

function resolveDataDir() {
	const home = process.env.HOME || process.env.USERPROFILE || '.';
	return process.env.AGENTMEMORY_DATA_DIR || path.join(home, '.saros', '.agentmemory');
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
const indexByAgent = new Map();

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

// Per-request "current agent" so the BM25 getter knows which index to read.
let gatewayCurrentAgent = 'default';

function gatewayBm25Getter() {
	const idx = getAgentIndex(gatewayCurrentAgent);
	if (!idx) return null;
	return { size: idx.size, search: (q, l) => idx.search(q, l) };
}
const GATEWAY_VECTOR_NOOP = { available: false, size: 0, search: async () => [] };

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
		fnMod.setIndexGetters(() => gatewayBm25Getter(), () => GATEWAY_VECTOR_NOOP);
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
				const skillsDir = path.join(home, '.saros', 'skills', slug);
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
				// First arg is the agentId for almost every provider method;
				// the BM25 getter (gatewayBm25Getter) reads it per-request.
				gatewayCurrentAgent = (typeof arr[0] === 'string') ? arr[0] : 'default';
				const result = await providerInstance[method](...arr);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(result ?? null));
			} catch (err) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
			}
			return;
		}

		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'not found' }));
		} catch (err) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: err.message }));
		}
	});

	server.listen(port, '127.0.0.1', () => {
		emit('ready', `KV store ready on port ${port}`, { port, dataDir, engine: backendKind });
	});

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
