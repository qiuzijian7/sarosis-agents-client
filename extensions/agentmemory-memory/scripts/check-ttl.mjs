// 查看 subagent-* 键的时间分布，用于确定安全 TTL（只读）
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';

const db = new DatabaseSync(join(homedir(), '.vssaros-dev', '.agentmemory', 'state_store.db'), { readOnly: true });
const now = Date.now();
const rows = db.prepare(`
	SELECT CASE
		WHEN updated_at IS NULL THEN 'null'
		WHEN updated_at > ? THEN '0-1d'
		WHEN updated_at > ? THEN '1-3d'
		WHEN updated_at > ? THEN '3-7d'
		WHEN updated_at > ? THEN '7-30d'
		ELSE '>30d' END AS bucket,
		COUNT(*) c, SUM(LENGTH(value)) bytes
	FROM kv_store
	WHERE scope LIKE 'mem:semantic:subagent-%' OR scope LIKE 'mem:obs:subagent-%'
	GROUP BY bucket`).all(now - 864e5, now - 3 * 864e5, now - 7 * 864e5, now - 30 * 864e5);
for (const r of rows) { console.log(`  ${r.bucket}: rows=${r.c} ${((r.bytes ?? 0) / 1024 / 1024).toFixed(1)}MB`); }
const maxTs = db.prepare("SELECT MAX(updated_at) m, MIN(updated_at) mn FROM kv_store WHERE scope LIKE '%subagent-%'").get();
console.log(`updated_at range: ${maxTs.mn ? new Date(maxTs.mn).toISOString() : 'n/a'} .. ${maxTs.m ? new Date(maxTs.m).toISOString() : 'n/a'}`);
db.close();
