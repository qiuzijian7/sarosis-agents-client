// A2：把正式 agent 的旧格式 `episodic` 数组键迁移为逐条独立 key，并删除 mem:index 残留。
//
// 背景：旧 extractEpisodic 把整个 episodic 数组写回单个 key（'<agent>/episodic'），
// 现有 12 个正式 agent 各 ~900KB。这些是**有效固化历史**，不能删，只能解开：
//   数组 → 逐条 kv（保留最近 MAX_KEEP 条），随后删除数组键。
// mem:index:bm25:* 是历史索引分片（当前代码零引用，KV.bm25Index 无写入点）→ 直接删除。
//
// 用法：
//   node extensions/agentmemory-memory/scripts/migrate-semantic.mjs           # dry-run
//   node extensions/agentmemory-memory/scripts/migrate-semantic.mjs --apply    # 执行
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const dbPath = process.argv[2] && !process.argv[2].startsWith('--')
	? process.argv[2]
	: join(homedir(), '.vssaros-dev', '.agentmemory', 'state_store.db');
const apply = process.argv.includes('--apply');
const MAX_KEEP = 100;

if (!existsSync(dbPath)) { console.error('db not found: ' + dbPath); process.exit(1); }
const sizeBefore = statSync(dbPath).size;
const db = new DatabaseSync(dbPath);

const arrayKeys = db.prepare("SELECT scope, key, LENGTH(value) n FROM kv_store WHERE scope LIKE 'mem:semantic:%' AND key='episodic'").all();
const indexRows = db.prepare("SELECT COUNT(*) c, SUM(LENGTH(value)) bytes FROM kv_store WHERE scope LIKE 'mem:index%'").get();
console.log(`array keys: ${arrayKeys.length} (${(arrayKeys.reduce((s, r) => s + r.n, 0) / 1024 / 1024).toFixed(1)}MB)`);
console.log(`mem:index rows: ${indexRows.c} (${((indexRows.bytes ?? 0) / 1024 / 1024).toFixed(1)}MB, zero-code-ref → delete)`);

// 诊断：数组长度与元素类型（历史数据存在嵌套数组/超深结构 → JSON.stringify 栈溢出）
for (const r of arrayKeys.slice(0, 4)) {
	const row = db.prepare('SELECT value FROM kv_store WHERE scope=? AND key=?').get(r.scope, r.key);
	try {
		const arr = JSON.parse(row.value);
		const kinds = {};
		for (const e of (Array.isArray(arr) ? arr : [])) {
			const k = Array.isArray(e) ? 'array' : (e === null ? 'null' : typeof e);
			kinds[k] = (kinds[k] ?? 0) + 1;
		}
		let depth = 0;
		let probe = arr;
		while (Array.isArray(probe) && probe.length > 0 && depth < 1000) { probe = probe[0]; depth++; }
		console.log(`  ${r.scope}: len=${Array.isArray(arr) ? arr.length : 'not-array'} nestingDepth=${depth} kinds=${JSON.stringify(kinds)}`);
	} catch (e) {
		console.log(`  ${r.scope}: parse failed ${e.message}`);
	}
}

if (!apply) { console.log('dry-run: pass --apply'); db.close(); process.exit(0); }

db.exec('BEGIN');
try {
	let migrated = 0, written = 0, skipped = 0;
	for (const r of arrayKeys) {
		const row = db.prepare('SELECT value FROM kv_store WHERE scope=? AND key=?').get(r.scope, r.key);
		let arr;
		try { arr = JSON.parse(row.value); } catch { continue; }
		if (!Array.isArray(arr)) { continue; }
		// 旧实现每次固化都 [...existing, ep]（existing 是 list 全量）→ N 次固化 =
		// N 层嵌套数组，同一批 episode 被重复存储 N 遍（这正是体积爆炸来源）。
		// 迭代式深度展开（避免递归栈溢出）+ 按 id 去重。
		const flat = [];
		const stack = [arr];
		while (stack.length > 0) {
			const cur = stack.pop();
			if (Array.isArray(cur)) { for (const e of cur) { stack.push(e); } continue; }
			if (cur && typeof cur === 'object') { flat.push(cur); } else { skipped++; }
		}
		const byId = new Map();
		for (const e of flat) {
			const id = typeof e?.id === 'string' && e.id.startsWith('epi') ? e.id : null;
			if (id) { if (!byId.has(id)) { byId.set(id, e); } } else { byId.set(`__anon_${byId.size}`, e); }
		}
		const deduped = [...byId.values()];
		const keep = deduped.slice(-MAX_KEEP);
		let i = 0;
		for (const ep of keep) {
			let json;
			try { json = JSON.stringify(ep); } catch { skipped++; continue; }  // 深嵌套/环 → 跳过
			const id = (typeof ep.id === 'string' && ep.id.startsWith('epi'))
				? ep.id
				: `epi_migrated_${Date.now().toString(36)}_${i++}`;
			db.prepare('INSERT OR REPLACE INTO kv_store(scope, key, value, updated_at) VALUES(?,?,?,?)')
				.run(r.scope, id, json, Date.now());
			written++;
		}
		db.prepare('DELETE FROM kv_store WHERE scope=? AND key=?').run(r.scope, r.key);
		migrated++;
	}
	const delIdx = db.prepare("DELETE FROM kv_store WHERE scope LIKE 'mem:index%'").run();
	db.exec('COMMIT');
	console.log(`migrated: ${migrated} array keys → ${written} entries (skipped bad: ${skipped}); deleted index rows: ${delIdx.changes}`);
} catch (e) {
	db.exec('ROLLBACK');
	throw e;
}

db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.exec('VACUUM');
db.close();
console.log(`db size: ${(sizeBefore / 1024 / 1024).toFixed(1)}MB -> ${(statSync(dbPath).size / 1024 / 1024).toFixed(1)}MB`);
