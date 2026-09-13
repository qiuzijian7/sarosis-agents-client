// A1/A2：清理 subagent-* 遗留的巨型 semantic/obs 键 + VACUUM。
// 根因：amPipeline.extractEpisodic 曾把整个 episodic 数组写回单个 key（'episodic'），
// 单值膨胀到 ~0.94MB，且 subagent agentId 唯一 → 211 个遗留 scope，共 ~188MB。
//
// 用法（先备份！）：
//   node extensions/agentmemory-memory/scripts/clean-semantic.mjs            # dry-run，只统计
//   node extensions/agentmemory-memory/scripts/clean-semantic.mjs --apply    # 执行（导出备份后删除 + VACUUM）
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const dbPath = process.argv[3] ?? join(homedir(), '.vssaros-dev', '.agentmemory', 'state_store.db');
const apply = process.argv.includes('--apply');
if (!existsSync(dbPath)) { console.error('db not found: ' + dbPath); process.exit(1); }

const sizeBefore = statSync(dbPath).size;
const db = new DatabaseSync(dbPath);

const targets = db.prepare(`
	SELECT scope, key, LENGTH(value) n FROM kv_store
	WHERE (scope LIKE 'mem:semantic:subagent-%' OR scope LIKE 'mem:obs:subagent-%')
	ORDER BY n DESC`).all();

let bytes = 0;
for (const t of targets) { bytes += t.n; }
console.log(`targets: ${targets.length} rows, ${(bytes / 1024 / 1024).toFixed(1)}MB`);
for (const t of targets.slice(0, 5)) { console.log(`  e.g. ${t.scope}/${t.key} ${(t.n / 1024).toFixed(0)}KB`); }

if (!apply) {
	console.log('dry-run: pass --apply to execute');
	db.close();
	process.exit(0);
}

// 删除前导出为 JSONL（保留可恢复性）
const dumpPath = dbPath.replace(/state_store\.db$/, `subagent-semantic-dump-${Date.now()}.jsonl`);
const lines = [];
for (const t of targets) {
	const row = db.prepare('SELECT value FROM kv_store WHERE scope=? AND key=?').get(t.scope, t.key);
	lines.push(JSON.stringify({ scope: t.scope, key: t.key, value: row?.value ?? null }));
}
writeFileSync(dumpPath, lines.join('\n'), 'utf8');
console.log(`dumped: ${dumpPath}`);

const del = db.prepare('DELETE FROM kv_store WHERE scope=? AND key=?');
let n = 0;
const tx = db.exec ? null : null;
db.exec('BEGIN');
try {
	for (const t of targets) { del.run(t.scope, t.key); n++; }
	db.exec('COMMIT');
} catch (e) {
	db.exec('ROLLBACK');
	throw e;
}
console.log(`deleted: ${n} rows`);

db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.exec('VACUUM');
db.close();

const sizeAfter = statSync(dbPath).size;
console.log(`db size: ${(sizeBefore / 1024 / 1024).toFixed(1)}MB -> ${(sizeAfter / 1024 / 1024).toFixed(1)}MB`);
