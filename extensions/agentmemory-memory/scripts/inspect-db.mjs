// 只读统计 agentmemory KV 库（按 scope 分布），用于容量诊断。
// 用法：node extensions/agentmemory-memory/scripts/inspect-db.mjs [dbPath]
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';

const dbPath = process.argv[2] ?? join(homedir(), '.vssaros-dev', '.agentmemory', 'state_store.db');
const db = new DatabaseSync(dbPath, { readOnly: true });

const total = db.prepare('SELECT COUNT(*) c FROM kv_store').get();
console.log(`db=${dbPath}`);
console.log(`rows=${total.c}`);

const byScope = db.prepare(`
	SELECT scope, COUNT(*) c, SUM(LENGTH(value)) bytes
	FROM kv_store GROUP BY scope ORDER BY bytes DESC LIMIT 20`).all();
for (const r of byScope) {
	console.log(`  ${r.scope}: rows=${r.c} ${(r.bytes / 1024 / 1024).toFixed(2)}MB`);
}
const agents = db.prepare("SELECT COUNT(DISTINCT scope) c FROM kv_store WHERE scope LIKE 'mem:memories:%'").get();
console.log(`agents(with memories)=${agents.c}`);
db.close();
