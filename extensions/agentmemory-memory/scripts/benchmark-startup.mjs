// 网关启动耗时基准：复制给定 db 到临时 dataDir → spawn host.mjs → 测 ready 时间。
// 用法：
//   node extensions/agentmemory-memory/scripts/benchmark-startup.mjs <dbPath> [label]
//
// ⚠️ 已知限制（2026-09-10）：对 WAL 模式库，**复制**到临时目录后启动会假死
// （即使同时复制 -wal/-shm）；但用**原始 dataDir** 启动时 6 秒即 ready。
// 因此本脚本的结果不可信——要测启动耗时，请直接指向原始 AGENTMEMORY_DATA_DIR 运行，
// 或改用「复制后执行 `PRAGMA wal_checkpoint(TRUNCATE)` + `PRAGMA journal_mode=DELETE`」再复制。
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const extRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hostPath = join(extRoot, '..', 'agentmemory-gateway', 'host', 'host.mjs');
const dbPath = process.argv[2];
const label = process.argv[3] ?? 'db';
if (!dbPath || !existsSync(dbPath)) { console.error('db not found'); process.exit(1); }

const dataDir = mkdtempSync(join(tmpdir(), 'am-bench-'));
copyFileSync(dbPath, join(dataDir, 'state_store.db'));
// ★ WAL 模式：必须同时复制 -wal / -shm，否则 SQLite 打开会卡住（首版脚本漏掉 → 假 TIMEOUT）
for (const suffix of ['-wal', '-shm']) {
	const src = dbPath + suffix;
	if (existsSync(src)) { copyFileSync(src, join(dataDir, 'state_store.db' + suffix)); }
}
const port = 33000 + Math.floor(Math.random() * 1000);

const env = {
	...process.env,
	AGENTMEMORY_PORT: String(port),
	AGENTMEMORY_DATA_DIR: dataDir,
	AGENTMEMORY_EXT_ROOT: join(extRoot, '..', 'agentmemory-memory'),
	AGENTMEMORY_SKILLS_DIR: join(dataDir, 'skills'),
};
delete env.NODE_OPTIONS;

const t0 = Date.now();
const child = spawn(process.execPath, [hostPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let readyMs = null;
child.stdout.on('data', d => {
	if (readyMs === null && d.toString().includes('"ready"')) { readyMs = Date.now() - t0; }
});

const deadline = Date.now() + 420000; // 7min 上限
while (readyMs === null && Date.now() < deadline) {
	await new Promise(r => setTimeout(r, 100));
}

console.log(`${label}: ${(dbPath.length, (await import('node:fs')).statSync(dbPath).size / 1024 / 1024).toFixed(1)}MB → ready in ${readyMs ?? 'TIMEOUT'}ms`);
try { child.kill(); } catch { /* ignore */ }
rmSync(dataDir, { recursive: true, force: true });
process.exit(readyMs === null ? 1 : 0);
