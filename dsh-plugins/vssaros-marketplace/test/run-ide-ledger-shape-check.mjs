/**
 * ★ 2026-11-24：IDE 侧与 dsh 侧**双写同一份** installed-packages.json 的形状对齐守卫。
 * 跑法：node dsh-plugins/vssaros-marketplace/test/run-ide-ledger-shape-check.mjs
 *
 * 缺陷背景：IDE 侧 marketplaceService.upsertInstalled 以前直接 push(entry)，
 * 而 IInstalledEntry 只声明 6 个字段 ⇒ 覆盖条目时会抹掉 dsh 侧登记的
 * packageName / format / owner ⇒ 插件卸不掉、组合包级联卸载失灵。
 * 这里同时钉住 TS 源码与本机编译产物，防止「改了源码但产物没同步」。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const TS = path.join(ROOT, 'src/vs/sessions/contrib/agentStudio/browser/marketplaceService.ts');
const JS_REL = 'vs/sessions/contrib/agentStudio/browser/marketplaceService.js';

let passed = 0, failed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  OK  ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e?.message ?? e}`); console.error(`  NG  ${name}: ${e?.message ?? e}`); }
}

console.log('================================================');
console.log('  IDE 台账双写形状对齐 — 守卫');
console.log('================================================');

const ts = fs.readFileSync(TS, 'utf8');
// 只看 upsertInstalled 方法体，避免被其它段落的同名字段干扰
const upsertStart = ts.indexOf('private async upsertInstalled(');
const upsertEnd = ts.indexOf('private async removeInstalled(', upsertStart);
const tsUpsert = ts.slice(upsertStart, upsertEnd > upsertStart ? upsertEnd : undefined);

check('IInstalledEntry 声明 3 个与 dsh 侧对齐的扩展字段', () => {
  assert.match(ts, /packageName\?: string;/);
  assert.match(ts, /format\?: string;/);
  assert.match(ts, /owner\?: string;/);
});
check('upsertInstalled 找到被覆盖的旧条目', () => {
  assert.match(tsUpsert, /const prev = entries\.find\(/);
});
check('packageName / format 在本次没带时继承旧值', () => {
  assert.match(tsUpsert, /entry\.packageName \|\| prev\?\.packageName/);
  assert.match(tsUpsert, /entry\.format \|\| prev\?\.format/);
});
check('owner 刻意不继承（避免级联卸载误删）', () => {
  assert.doesNotMatch(tsUpsert, /prev\?\.owner/);
  assert.doesNotMatch(tsUpsert, /entry\.owner/);
});
check('坏数据（非数组）按空台账处理，不因 .filter 抛错', () => {
  assert.match(tsUpsert, /Array\.isArray\(parsed\)/);
});
check('写入的是合并后的条目，而不是原始 entry', () => {
  assert.match(tsUpsert, /entries\.push\(merged\)/);
  assert.doesNotMatch(tsUpsert, /entries\.push\(entry\)/);
});
check('readInstalled 仍是只读视图（不参与回写）', () => {
  assert.match(ts, /private async readInstalled\(\): Promise<IInstalledPackageInfo\[]>/);
});

// 编译产物（gitignore，不入库）：out 是可读 tsc 产物；out-build 是 minified 发布快照
// （方法名被 mangle 成 O/P，但属性名 packageName/format 不变 ⇒ 全文钉住新标记同样可靠）
for (const base of ['out', 'out-build']) {
  const p = path.join(ROOT, base, JS_REL);
  if (!fs.existsSync(p)) { console.log(`  --  ${base} 无产物（跳过）`); continue; }
  const js = fs.readFileSync(p, 'utf8');
  check(`${base} 编译产物已同步合并口径`, () => {
    assert.match(js, /const prev = entries\.find/);
    assert.match(js, /const merged = \{/);
    assert.match(js, /entries\.push\(merged\)/);
    assert.match(js, /Array\.isArray\(parsed\)/);
    assert.doesNotMatch(js, /entries\.push\(entry\)/);
    assert.doesNotMatch(js, /prev\?\.owner/);
  });
}

console.log('\n================================================');
console.log(`  通过: ${passed}`);
console.log(`  失败: ${failed}`);
if (failures.length) { for (const f of failures) { console.log(`    - ${f}`); } }
console.log('================================================');
process.exit(failed > 0 ? 1 : 0);
