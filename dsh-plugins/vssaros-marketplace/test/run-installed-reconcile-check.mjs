/**
 * ★ 2026-11-24：本机「已安装台账」只读对账 + 台账字段合并兜底 行为守卫。
 * 跑法：node dsh-plugins/vssaros-marketplace/test/run-installed-reconcile-check.mjs
 *
 * 零网络、零 Host，只用临时目录；不触碰用户数据根。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileInstalled } from '../lib/installedReconcile.js';
import { upsertInstalled, readInstalled } from '../lib/installedLedger.js';

let passed = 0, failed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  OK  ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e?.message ?? e}`); console.error(`  NG  ${name}: ${e?.message ?? e}`); }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-reconcile-'));
function makeRoot(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  return root;
}
function putSkill(root, id, version = '1.0.0') {
  const dir = path.join(root, 'skills', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${id}\nversion: ${version}\n---\n# ${id}\n`);
}

console.log('================================================');
console.log('  本机台账对账 / 字段合并 — 行为守卫');
console.log('================================================');

await check('无 dataRoot ⇒ 空报告，不抛', async () => {
  const r = await reconcileInstalled({ dataRoot: '', entries: [{ kind: 'skill', storeId: 'x' }] });
  assert.equal(r.scanned, 0);
  assert.equal(r.ghostCount, 0);
  assert.ok(r.checkedAt);
});
await check('磁盘有落地物 ⇒ installed', async () => {
  const root = makeRoot('installed');
  putSkill(root, 'a');
  const r = await reconcileInstalled({ dataRoot: root, entries: [{ kind: 'skill', storeId: 'a', version: '1.0.0' }] });
  assert.equal(r.scanned, 1);
  assert.equal(r.installed, 1);
  assert.equal(r.ghostCount, 0);
});
await check('台账有、磁盘没有 ⇒ ghost（幽灵条目）', async () => {
  const root = makeRoot('ghost');
  const r = await reconcileInstalled({ dataRoot: root, entries: [{ kind: 'skill', storeId: 'gone', version: '1.0.0' }] });
  assert.equal(r.ghostCount, 1);
  assert.deepEqual(r.ghosts, ['skill:gone']);
  assert.equal(r.installed, 0);
});
await check('plugin/workbench 没有可查落地物 ⇒ 不误报 ghost', async () => {
  const root = makeRoot('plugin');
  const r = await reconcileInstalled({ dataRoot: root, entries: [{ kind: 'plugin', storeId: 'wb', version: '1.0.0', packageName: '@x/wb' }] });
  assert.equal(r.ghostCount, 0);
  assert.equal(r.installed, 1);
});
await check('同 kind+storeId 重复 ⇒ duplicateKeys', async () => {
  const root = makeRoot('dup');
  putSkill(root, 'a');
  const r = await reconcileInstalled({ dataRoot: root, entries: [
    { kind: 'skill', storeId: 'a', version: '1' }, { kind: 'skill', storeId: 'a', version: '2' },
  ] });
  assert.equal(r.duplicateCount, 1);
  assert.deepEqual(r.duplicateKeys, ['skill:a']);
});
await check('plugin 缺 packageName / 缺 version ⇒ fieldDrift', async () => {
  const root = makeRoot('drift');
  const r = await reconcileInstalled({ dataRoot: root, entries: [{ kind: 'plugin', storeId: 'x' }] });
  assert.equal(r.fieldDriftCount, 1);
  assert.deepEqual(r.fieldDrift[0].issues, ['missing:packageName', 'missing:version']);
});
await check('owner 指向已不存在的父包 ⇒ orphanOwners', async () => {
  const root = makeRoot('owner');
  putSkill(root, 'component');
  const r = await reconcileInstalled({ dataRoot: root, entries: [
    { kind: 'skill', storeId: 'component', version: '1', owner: 'deleted-bot' },
  ] });
  assert.equal(r.orphanOwnerCount, 1);
  assert.deepEqual(r.orphanOwners, ['skill:component']);
});
await check('磁盘有目录但台账无 ⇒ orphanDirs（只读列出）', async () => {
  const root = makeRoot('orphan');
  putSkill(root, 'manual');
  const r = await reconcileInstalled({ dataRoot: root, entries: [] });
  assert.equal(r.orphanDirCount, 1);
  assert.deepEqual(r.orphanDirs, ['skill:manual']);
});
await check('报告明细有上限，不会被 100+ 幽灵撑爆', async () => {
  const root = makeRoot('many');
  const entries = Array.from({ length: 60 }, (_, i) => ({ kind: 'skill', storeId: `ghost-${i}`, version: '1' }));
  const r = await reconcileInstalled({ dataRoot: root, entries });
  assert.equal(r.ghostCount, 60);
  assert.equal(r.ghosts.length, 20);
  assert.equal(r.scanned, 60);
});
await check('坏台账（传入空数组）不抛，且报告可读', async () => {
  const root = makeRoot('bad');
  const r = await reconcileInstalled({ dataRoot: root, entries: null });
  assert.equal(r.scanned, 0);
});

// ── 字段合并兜底：IDE 侧双写只映射 6 字段，dsh 侧 upsert 不能再丢扩展字段 ──
await check('二次 upsert 不带 packageName/format ⇒ 保留旧值', async () => {
  const root = makeRoot('merge');
  await upsertInstalled(root, { kind: 'plugin', storeId: 'wb', version: '1.0.0', packageName: '@x/wb', format: 'envelope' });
  await upsertInstalled(root, { kind: 'plugin', storeId: 'wb', version: '1.1.0' });
  const rows = await readInstalled(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, '1.1.0');
  assert.equal(rows[0].packageName, '@x/wb');
  assert.equal(rows[0].format, 'envelope');
});
await check('显式传入新 packageName 以新值为准', async () => {
  const root = makeRoot('merge2');
  await upsertInstalled(root, { kind: 'plugin', storeId: 'wb', version: '1', packageName: '@x/old' });
  await upsertInstalled(root, { kind: 'plugin', storeId: 'wb', version: '2', packageName: '@x/new' });
  const rows = await readInstalled(root);
  assert.equal(rows[0].packageName, '@x/new');
});
await check('不同 kind 同 storeId 互不干扰', async () => {
  const root = makeRoot('merge3');
  await upsertInstalled(root, { kind: 'plugin', storeId: 'same', version: '1', packageName: '@x/p' });
  await upsertInstalled(root, { kind: 'skill', storeId: 'same', version: '2' });
  const rows = await readInstalled(root);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.kind === 'skill').packageName, undefined);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n================================================');
console.log(`  通过: ${passed}`);
console.log(`  失败: ${failed}`);
if (failures.length) { for (const f of failures) { console.log(`    - ${f}`); } }
console.log('================================================');
process.exit(failed > 0 ? 1 : 0);
