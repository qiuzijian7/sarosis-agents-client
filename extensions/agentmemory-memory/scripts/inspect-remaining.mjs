// 列出剩余巨型键与 mem:index 残留（只读）
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';

const dbPath = process.argv[2] ?? join(homedir(), '.vssaros-dev', '.agentmemory', 'state_store.db');
const db = new DatabaseSync(dbPath, { readOnly: true });

console.log('== 剩余 mem:semantic 键 ==');
for (const r of db.prepare("SELECT scope, key, LENGTH(value) n FROM kv_store WHERE scope LIKE 'mem:semantic:%' ORDER BY n DESC").all()) {
	console.log(`  ${r.scope}/${r.key}: ${(r.n / 1024).toFixed(0)}KB`);
}

console.log('== mem:index 残留 ==');
const idx = db.prepare("SELECT COUNT(*) c, SUM(LENGTH(value)) bytes FROM kv_store WHERE scope LIKE 'mem:index%'").get();
console.log(`  rows=${idx.c} ${((idx.bytes ?? 0) / 1024 / 1024).toFixed(1)}MB`);
for (const r of db.prepare("SELECT scope, key, LENGTH(value) n FROM kv_store WHERE scope LIKE 'mem:index%' ORDER BY n DESC LIMIT 5").all()) {
	console.log(`  ${r.scope}/${r.key}: ${(r.n / 1024).toFixed(0)}KB`);
}

console.log('== 全库 TOP5 单值 ==');
for (const r of db.prepare('SELECT scope, key, LENGTH(value) n FROM kv_store ORDER BY n DESC LIMIT 5').all()) {
	console.log(`  ${r.scope}/${r.key}: ${(r.n / 1024).toFixed(0)}KB`);
}
db.close();
