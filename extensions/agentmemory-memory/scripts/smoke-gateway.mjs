// P0/P1 修复的网关端到端冒烟测试（无需启动完整 app）：
//   spawn host.mjs（独立 Node 进程，AGENTMEMORY_EXT_ROOT 指向编译产物）→ HTTP 断言 → 重启 → 持久化断言。
// 覆盖：/health、writeMemory→searchMemory（BM25 索引同步）、/kv-list-agents 前缀修复、
//       DELETE 索引同步、404 语义（P0-2 副产物）、/mesh 503（P0-2）、graphBuild 持久化（P1-7）、
//       [mem-summary] 健康度行（P1-9）、重启后数据与索引重建。
// 运行：node extensions/agentmemory-memory/scripts/smoke-gateway.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/** A4 用例：在网关启动前，直接向 db 注入「超期 subagent 数据」与「超阈值单值」 */
function seedPruneFixtures(dataDir) {
	const dbPath = join(dataDir, 'state_store.db');
	if (!existsSync(dbPath)) { return 0; }
	const db = new DatabaseSync(dbPath);
	db.exec(`CREATE TABLE IF NOT EXISTS kv_store (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT, updated_at INTEGER, PRIMARY KEY (scope, key))`);
	const old = Date.now() - 30 * 86400000;
	db.prepare('INSERT OR REPLACE INTO kv_store(scope,key,value,updated_at) VALUES(?,?,?,?)')
		.run('mem:obs:subagent-benchmark-old', 'o1', '{"content":"stale"}', old);
	db.prepare('INSERT OR REPLACE INTO kv_store(scope,key,value,updated_at) VALUES(?,?,?,?)')
		.run('mem:semantic:subagent-benchmark-old', 'episodic', JSON.stringify([{ id: 'epi_old', createdAt: '2026-01-01T00:00:00Z' }]), old);
	db.prepare('INSERT OR REPLACE INTO kv_store(scope,key,value,updated_at) VALUES(?,?,?,?)')
		.run('mem:semantic:keepme', 'epi_fresh', JSON.stringify({ id: 'epi_fresh', createdAt: new Date().toISOString() }), Date.now());
	// 超阈值（>256KB）单值
	db.prepare('INSERT OR REPLACE INTO kv_store(scope,key,value,updated_at) VALUES(?,?,?,?)')
		.run('mem:obs:subagent-benchmark-big', 'big', JSON.stringify({ blob: 'x'.repeat(400 * 1024) }), Date.now());
	const n = db.prepare('SELECT COUNT(*) c FROM kv_store').get().c;
	db.close();
	return n;
}

function assertPruned(dataDir) {
	const dbPath = join(dataDir, 'state_store.db');
	if (!existsSync(dbPath)) { return { ok: false, why: 'no db' }; }
	const db = new DatabaseSync(dbPath, { readOnly: true });
	const stale = db.prepare("SELECT COUNT(*) c FROM kv_store WHERE scope LIKE '%subagent-benchmark-old%'").get().c;
	const big = db.prepare("SELECT COUNT(*) c FROM kv_store WHERE scope = 'mem:obs:subagent-benchmark-big'").get().c;
	const fresh = db.prepare("SELECT COUNT(*) c FROM kv_store WHERE scope = 'mem:semantic:keepme'").get().c;
	db.close();
	return { ok: stale === 0 && big === 0 && fresh === 1, stale, big, fresh };
}

// scripts/ → 扩展根 agentmemory-memory
const extRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const hostPath = join(extRoot, '..', 'agentmemory-gateway', 'host', 'host.mjs');
const port = 32123;
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), 'am-smoke-'));
const AGENT = 'smoke-agent';

const env = {
	...process.env,
	AGENTMEMORY_PORT: String(port),
	AGENTMEMORY_DATA_DIR: dataDir,
	AGENTMEMORY_EXT_ROOT: extRoot,
	AGENTMEMORY_SKILLS_DIR: join(dataDir, 'skills'),
};
// CodeBuddy 注入的 node-language-shim（genie）会干扰子进程 node —— 剥离
delete env.NODE_OPTIONS;

let logs = '';
let child = null;

function start() {
	child = spawn(process.execPath, [hostPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
	child.stdout.on('data', d => { logs += d; });
	child.stderr.on('data', d => { logs += d; });
}

async function waitReady(timeoutMs = 25000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`${base}/health`);
			if (r.ok) return true;
		} catch { /* not up yet */ }
		await new Promise(r => setTimeout(r, 300));
	}
	throw new Error(`gateway not ready in ${timeoutMs}ms\n--- logs ---\n${logs.slice(-2000)}`);
}

function stop() {
	return new Promise(resolve => {
		if (!child || child.exitCode !== null) { resolve(); return; }
		child.on('exit', resolve);
		child.kill();
		setTimeout(resolve, 3000);
	});
}

async function req(method, path, body) {
	const raw = typeof body === 'string' ? body : (body !== undefined ? JSON.stringify(body) : undefined);
	const r = await fetch(`${base}${path}`, {
		method,
		headers: raw !== undefined ? { 'Content-Type': 'application/json' } : undefined,
		body: raw,
	});
	const text = await r.text();
	let json = null;
	try { json = JSON.parse(text); } catch { json = text; }
	return { status: r.status, json };
}

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
	if (cond) { pass++; console.log(`  ✔ ${name}`); }
	else { fail++; console.log(`  ✗ ${name} ${detail}`); }
}

const MEM = (id, content) => ({ id, type: 'fact', content, timestamp: Date.now() });

async function main() {
	// ═══════════ 第一进程：功能断言 ═══════════
	start();
	console.log('▶ Phase 1: 功能断言');
	check('gateway ready', await waitReady());

	check('P0-2 副产物: 未知路径 → 404（而非 500）', (await req('GET', '/definitely-not-a-route')).status === 404);
	check('P0-2: /mesh/receive 无 secret → 503（路由可达）', (await req('POST', '/mesh/receive', {})).status === 503);

	const w1 = await req('POST', '/provider/writeMemory', { args: [AGENT, MEM('smoke-1', 'The smoke gateway keyword is BANANA42 for retrieval')] });
	check('writeMemory ok', w1.status === 200 && w1.json?.ok?.success !== false, JSON.stringify(w1.json).slice(0, 120));
	// graph 抽取需要可识别实体（FILE_RE 文件路径 / CONCEPT_RE 技术词）
	await req('POST', '/provider/writeMemory', { args: [AGENT, MEM('smoke-graph', 'src/auth.ts uses jwt middleware for authentication')] });

	const s1 = await req('POST', '/provider/searchMemory', { args: [AGENT, 'BANANA42'] });
	check('searchMemory 命中（BM25 写路径同步）', s1.status === 200 && Array.isArray(s1.json) && s1.json.some(m => m.id === 'smoke-1'), JSON.stringify(s1.json)?.slice(0, 120));

	check('kv-list-agents 含 agent（死前缀修复）', (await req('GET', '/kv-list-agents')).json.includes(AGENT));

	await req('PUT', `/kv/${encodeURIComponent('mem:memories:' + AGENT)}/smoke-del`, JSON.stringify({ id: 'smoke-del', type: 'fact', content: 'DELETABLE unique zebra token qqq777', timestamp: Date.now() }));
	const s2 = await req('POST', '/provider/searchMemory', { args: [AGENT, 'qqq777'] });
	check('HTTP /kv PUT 后可检索（向量双写不破坏 BM25）', Array.isArray(s2.json) && s2.json.some(m => m.id === 'smoke-del'));
	await req('DELETE', `/kv/${encodeURIComponent('mem:memories:' + AGENT)}/smoke-del`);
	const s3 = await req('POST', '/provider/searchMemory', { args: [AGENT, 'qqq777'] });
	check('HTTP /kv DELETE 后不可检索（索引同步移除）', Array.isArray(s3.json) && !s3.json.some(m => m.id === 'smoke-del'));

	const gb = await req('POST', '/provider/graphBuild', { args: [AGENT] });
	check('P1-7: graphBuild 产出节点', gb.status === 200 && (gb.json?.nodes ?? 0) > 0, JSON.stringify(gb.json).slice(0, 120));
	const gn = await req('GET', `/kv/${encodeURIComponent('mem:graph:nodes:' + AGENT)}/current`);
	check('P1-7: 图谱已持久化到 KV.graphNodes', gn.status === 200 && Array.isArray(gn.json) && gn.json.length > 0);

	await new Promise(r => setTimeout(r, 5500)); // 等启动 5s 的健康度输出
	check('P1-9: [mem-summary] 健康度行已输出', logs.includes('[mem-summary]'), 'logs tail: ' + logs.slice(-200));
	// A2：容量监控（db 体积 + 最大单值）——曾因 host.mjs 无裸 join 导入而静默输出 0
	const capLine = logs.split('\n').find(l => l.includes('[mem-summary]')) ?? '';
	const capMatch = /db=([\d.]+)MB maxValue=(\d+)KB/.exec(capLine.replace(/\\\\/g, ''));
	check('A2: 健康度行含容量指标且 db>0', !!capMatch && Number(capMatch[1]) > 0, capLine.slice(0, 160));

	// ═══════════ 重启：持久化断言（P1-7 / 数据目录复用）═══════════
	console.log('▶ Phase 2: 重启后持久化断言');
	await stop();
	logs = '';
	// A4：重启前注入「超期 subagent 数据 + 超阈值单值」，重启时启动剪枝应清除它们
	seedPruneFixtures(dataDir);
	start();
	check('gateway 重启 ready', await waitReady());
	const pruned = assertPruned(dataDir);
	check('A4: 超期 subagent 数据被剪枝', pruned.stale === 0, JSON.stringify(pruned));
	check('A4: 超阈值单值被剪枝', pruned.big === 0, JSON.stringify(pruned));
	check('A4: 正常数据未被误删', pruned.fresh === 1, JSON.stringify(pruned));
	check('重启后 kv-list-agents 保留', (await req('GET', '/kv-list-agents')).json.includes(AGENT));
	check('P1-7: 重启后图谱 KV 仍在', ((await req('GET', `/kv/${encodeURIComponent('mem:graph:nodes:' + AGENT)}/current`)).json || []).length > 0);
	const s4 = await req('POST', '/provider/searchMemory', { args: [AGENT, 'BANANA42'] });
	check('重启后 searchMemory 仍命中（索引重建）', Array.isArray(s4.json) && s4.json.some(m => m.id === 'smoke-1'));
	await new Promise(r => setTimeout(r, 5500));
	check('P1-9: 重启后 [mem-summary] 再次输出', logs.includes('[mem-summary]'));

	// ═══════════ 收尾 ═══════════
	await stop();
	rmSync(dataDir, { recursive: true, force: true });
	console.log(`\n══════════ Smoke Results: ${pass} passed, ${fail} failed ══════════`);
	if (fail > 0) { console.log('--- gateway logs (tail) ---\n' + logs.slice(-1500)); }
}

main().catch(err => {
	console.error('Fatal:', err);
	try { child?.kill(); } catch { /* ignore */ }
	rmSync(dataDir, { recursive: true, force: true });
	process.exit(1);
});
