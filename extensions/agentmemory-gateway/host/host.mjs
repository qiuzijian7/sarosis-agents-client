/*---------------------------------------------------------------------------------------------
 *  AgentMemory persistence server — SQLite KV store (1:1 parity with agentmemory).
 *
 *  Replaces the old JSONL file server with a SQLite-backed KV store that mirrors
 *  the original agentmemory's StateKV architecture (iii-engine StateModule).
 *
 *  Storage: ~/.saros/.agentmemory/state_store.db (SQLite, WAL mode)
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
import { DatabaseSync } from 'node:sqlite';

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

async function main() {
	const port = parseInt(process.env.AGENTMEMORY_PORT || '3111', 10);
	const dataDir = resolveDataDir();
	fs.mkdirSync(dataDir, { recursive: true });

	// ── Initialize SQLite database ──────────────────────────────────────────
	const dbPath = path.join(dataDir, 'state_store.db');
	const db = new DatabaseSync(dbPath);

	// Enable WAL mode for concurrent read access
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA synchronous = NORMAL');
	db.exec('PRAGMA busy_timeout = 5000');

	// KV table — mirrors iii-engine StateModule structure
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

	emit('log', `${TAG} SQLite KV store ready: ${dbPath}`);

	// Prepared statements (reused for performance)
	const stmtGet = db.prepare('SELECT value FROM kv_store WHERE scope = ? AND key = ?');
	const stmtSet = db.prepare(`
		INSERT INTO kv_store (scope, key, value, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
	`);
	const stmtDelete = db.prepare('DELETE FROM kv_store WHERE scope = ? AND key = ?');
	const stmtListKeys = db.prepare('SELECT key FROM kv_store WHERE scope = ?');
	const stmtListAll = db.prepare('SELECT key, value FROM kv_store WHERE scope = ?');
	const stmtDeleteScope = db.prepare('DELETE FROM kv_store WHERE scope = ?');

	let pendingWrites = 0;

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
				res.end(JSON.stringify({ status: 'ok', dataDir, port, engine: 'sqlite' }));
				return;
			}

			// ── List all agents with data ─────────────────────────────────
			if (url.pathname === '/kv-list-agents' && req.method === 'GET') {
				const rows = db.prepare("SELECT DISTINCT scope FROM kv_store WHERE scope LIKE 'mem:long:%' AND length(value) > 1").all();
				const agents = rows.map(r => r.scope.replace('mem:long:', ''));
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(agents));
				return;
			}

			// ── SKILL.md file endpoints ────────────────────────────────────
			// Write SKILL.md: PUT /skill-md/<slug>
			// Delete SKILL.md: DELETE /skill-md/<slug>
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
						// Also try to remove the directory if empty
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
					const tx = db.exec('BEGIN');
					let written = 0;
					try {
						for (const item of data.agents) {
							const scope = sanitize(item.scope || `mem:${sanitize(item.agentId)}`);
							const key = sanitize(item.key || item.file);
							stmtSet.run(scope, key, item.content, Date.now());
							written++;
						}
						db.exec('COMMIT');
					} catch (err) {
						db.exec('ROLLBACK');
						throw err;
					}
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ ok: true, written }));
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
					const row = stmtGet.get(scope, key);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(row ? row.value : 'null');
					return;
				}

				if (req.method === 'PUT') {
					pendingWrites++;
					try {
						const chunks = [];
						for await (const chunk of req) { chunks.push(chunk); }
						const body = Buffer.concat(chunks).toString('utf8');
						stmtSet.run(scope, key, body, Date.now());
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ ok: true, bytes: body.length }));
					} finally {
						pendingWrites--;
					}
					return;
				}

				if (req.method === 'DELETE') {
					pendingWrites++;
					try {
						stmtDelete.run(scope, key);
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
					const rows = stmtListAll.all(scope);
					const result = {};
					for (const row of rows) {
						result[row.key] = row.value;
					}
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(result));
				} else {
					const rows = stmtListKeys.all(scope);
					const keys = rows.map(r => r.key);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(keys));
				}
				return;
			}

			// ── KV delete scope: DELETE /kv/<scope> ─────────────────────────
			if (kvListMatch && req.method === 'DELETE') {
				const scope = decodeURIComponent(kvListMatch[1]);
				pendingWrites++;
				try {
					stmtDeleteScope.run(scope);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ ok: true }));
				} finally {
					pendingWrites--;
				}
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

			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'not found' }));
		} catch (err) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: err.message }));
		}
	});

	server.listen(port, '127.0.0.1', () => {
		emit('ready', `KV store ready on port ${port}`, { port, dataDir, dbPath });
	});

	// Graceful shutdown
	const shutdown = (sig) => {
		emit('log', `${TAG} received ${sig}, shutting down... (pending writes: ${pendingWrites})`);
		setTimeout(() => {
			try {
				db.close();
				emit('log', `${TAG} database closed cleanly`);
			} catch (err) {
				emit('warn', `${TAG} database close error: ${err.message}`);
			}
			server.close(() => process.exit(0));
			setTimeout(() => process.exit(0), 2000);
		}, Math.min(pendingWrites * 100, 1000));
	};

	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
	emit('error', `${TAG} fatal: ${err.message}`, { stack: err.stack });
	process.exit(1);
});
