/**
 * ★ 2026-11-24：`installed-packages.json` 跨进程写锁守卫。
 * 跑法：node dsh-plugins/vssaros-marketplace/test/run-installed-ledger-lock-check.mjs
 *
 * 覆盖：能力探测降级（离线/老 Host）、真实锁获取与释放、**两个独立进程真并发**
 *       各写一条 → 两条都在（这是进程内串行队列覆盖不到的场景）、双端静态接线。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bindFoundation } from '../lib/foundationRef.js';
import { upsertInstalled, readInstalled } from '../lib/installedLedger.js';
import * as lockImpl from '../../vssaros-foundation/lib/lock.js';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const LIB = path.resolve(HERE, '..', 'lib');
const urlOf = p => pathToFileURL(p).href;

let passed = 0, failed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  OK  ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e?.message ?? e}`); console.error(`  NG  ${name}: ${e?.message ?? e}`); }
}

console.log('================================================');
console.log('  installed-packages.json 跨进程写锁 — 守卫');
console.log('================================================');

// ── A. 能力探测降级（未绑定 foundation ⇒ 行为与旧版一致）──────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-lock-'));
await check('未绑定 foundation ⇒ 降级可写、不抛、不残留 .lock', async () => {
  const root = path.join(tmp, 'degraded');
  await upsertInstalled(root, { kind: 'skill', storeId: 'a', version: '1.0.0' });
  const rows = await readInstalled(root);
  assert.equal(rows.length, 1);
  assert.equal(fs.existsSync(path.join(root, 'installed-packages.json.lock')), false);
});

// ── B. 注入真实锁后：正常写入 + 释放 ──────────────────────────
bindFoundation(lockImpl);
await check('注入 foundation 锁 ⇒ 写入成功且 .lock / .vssaros-tmp 均被清理', async () => {
  const root = path.join(tmp, 'locked');
  await upsertInstalled(root, { kind: 'skill', storeId: 'a', version: '1.0.0', packageName: '@x/a' });
  await upsertInstalled(root, { kind: 'skill', storeId: 'a', version: '1.1.0' });
  const rows = await readInstalled(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, '1.1.0');
  assert.equal(rows[0].packageName, '@x/a', '字段合并仍生效');
  assert.equal(fs.existsSync(path.join(root, 'installed-packages.json.lock')), false);
  assert.equal(fs.readdirSync(root).some(n => n.includes('.vssaros-tmp')), false);
});

// ── C. 两个独立进程真并发（核心）────────────────────────────
await check('两个独立进程并发 upsert 不同 storeId ⇒ 两条都在（无丢更新）', async () => {
  const root = path.join(tmp, 'concurrent');
  const worker = path.join(tmp, 'worker.mjs');
  fs.writeFileSync(worker, [
    `import { bindFoundation } from ${JSON.stringify(urlOf(path.join(LIB, 'foundationRef.js')))};`,
    `import * as lockImpl from ${JSON.stringify(urlOf(path.join(ROOT, 'dsh-plugins/vssaros-foundation/lib/lock.js')))};`,
    `import { upsertInstalled } from ${JSON.stringify(urlOf(path.join(LIB, 'installedLedger.js')))};`,
    'bindFoundation(lockImpl);',
    'await upsertInstalled(process.argv[2], { kind: "skill", storeId: process.argv[3], version: "1.0.0" });',
  ].join('\n'));
  await Promise.all([
    execFileAsync(process.execPath, [worker, root, 'from-host']),
    execFileAsync(process.execPath, [worker, root, 'from-ide']),
  ]);
  const rows = await readInstalled(root);
  assert.deepEqual(rows.map(r => r.storeId).sort(), ['from-host', 'from-ide'],
    `丢更新！实际：${JSON.stringify(rows.map(r => r.storeId))}`);
  assert.equal(fs.existsSync(path.join(root, 'installed-packages.json.lock')), false);
});

// ── D. 双端静态接线与协议一致性 ───────────────────────────────
await check('dsh 侧：serialized 外层 + 锁内 read→write + finally release', async () => {
  const s = fs.readFileSync(path.join(LIB, 'installedLedger.js'), 'utf8');
  assert.match(s, /function serialized\(/);
  assert.match(s, /function lockService\(/);
  assert.match(s, /svc\.acquireFileLock\(svc\.lockFileFor\(file\)/);
  assert.match(s, /if \(release\) \{ await release\(\); \}/);
  assert.equal((s.match(/acquireFileLock\(/g) || []).length, 2, 'upsert 与 remove 各一处');
});
await check('IDE 侧：3 个写点都包同一把锁', async () => {
  const s = fs.readFileSync(path.join(ROOT, 'src/vs/sessions/contrib/agentStudio/browser/marketplaceService.ts'), 'utf8');
  assert.equal((s.match(/acquireFileLock\(lockResourceFor\(installedFileUri\)/g) || []).length, 3);
  assert.equal((s.match(/await release\(\)/g) || []).length >= 3, true);
  assert.match(s, /from '\.\.\/common\/fileWriteLock\.js'/);
});
await check('双端锁协议常量一致（同一把 <file>.lock）', async () => {
  const dsh = fs.readFileSync(path.join(ROOT, 'dsh-plugins/vssaros-foundation/lib/lock.js'), 'utf8');
  const ide = fs.readFileSync(path.join(ROOT, 'src/vs/sessions/contrib/agentStudio/common/fileWriteLock.ts'), 'utf8');
  for (const [name, value] of [['SUFFIX', "'.lock'"], ['WAIT', '5000'], ['STALE', '15000'], ['POLL', '100'], ['HEARTBEAT', '2000']]) {
    assert.ok(dsh.includes(value), `dsh 缺 ${name}=${value}`);
    assert.ok(ide.includes(value), `IDE 缺 ${name}=${value}`);
  }
});
await check('out/ 自动编译产物含锁（若存在）', async () => {
  const p = path.join(ROOT, 'out/vs/sessions/contrib/agentStudio/browser/marketplaceService.js');
  if (!fs.existsSync(p)) { console.log('    -- out/ 无产物，跳过'); return; }
  assert.match(fs.readFileSync(p, 'utf8'), /acquireFileLock/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n================================================');
console.log(`  通过: ${passed}`);
console.log(`  失败: ${failed}`);
if (failures.length) { for (const f of failures) { console.log(`    - ${f}`); } }
console.log('================================================');
process.exit(failed > 0 ? 1 : 0);
