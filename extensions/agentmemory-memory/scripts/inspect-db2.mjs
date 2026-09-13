// 按 scope 前缀聚合 + 单条极值，定位容量异常（只读）
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';

const dbPath = process.argv[2] ?? join(homedir(), '.vssaros-dev', '.agentmemory', 'state_store.db');
const db = new DatabaseSync(dbPath, { readOnly: true });

const groups = db.prepare(`
	SELECT SUBSTR(scope, 1, INSTR(scope, ':') - 1) || ':' || SUBSTR(scope, INSTR(scope, ':') + 1, INSTR(SUBSTR(scope, INSTR(scope, ':') + 1), ':') - 1) AS prefix,
	       COUNT(*) c, SUM(LENGTH(value)) bytes
	FROM kv_store GROUP BY prefix ORDER BY bytes DESC`).all();
console.log('== 按 scope 前缀聚合 ==');
for (const g of groups) {
	console.log(`  ${g.prefix || '(other)'}: rows=${g.c} ${(g.bytes / 1024 / 1024).toFixed(1)}MB`);
}

console.log('== 单条最大值 TOP 8 ==');
for (const r of db.prepare('SELECT scope, key, LENGTH(value) n FROM kv_store ORDER BY n DESC LIMIT 8').all()) {
	console.log(`  ${r.scope}/${r.key}: ${(r.n / 1024).toFixed(0)}KB`);
}

console.log('== subagent semantic 条目数 ==');
const sub = db.prepare("SELECT COUNT(*) c, SUM(LENGTH(value)) bytes FROM kv_store WHERE scope LIKE 'mem:semantic:subagent-%'").get();
console.log(`  rows=${sub.c} ${((sub.bytes ?? 0) / 1024 / 1024).toFixed(1)}MB`);
const semAll = db.prepare("SELECT COUNT(*) c, SUM(LENGTH(value)) bytes FROM kv_store WHERE scope LIKE 'mem:semantic:%'").get();
console.log(`  (all semantic) rows=${semAll.c} ${((semAll.bytes ?? 0) / 1024 / 1024).toFixed(1)}MB`);
db.close();
