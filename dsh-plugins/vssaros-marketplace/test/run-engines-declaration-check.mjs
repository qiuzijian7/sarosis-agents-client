/**
 * ★ 2026-11-24：发布端 `engines.dsh` 声明 → 安装端 preflight 门禁 端到端守卫。
 * 跑法：node dsh-plugins/vssaros-marketplace/test/run-engines-declaration-check.mjs
 *
 * 覆盖：常量真源一致性、satisfies 的 AND 语义（上界不再被吞）、真实
 *       preparePublishBundle 产出的包能被门禁正确判定（ok / incompatible / unknown）、
 *       老包仍放行、注入的 package.json 不落盘污染资源目录。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preparePublishBundle } from '../lib/publisher.js';
import { satisfies } from '../lib/hostVersion.js';
import { preflightCompatibility } from '../lib/installPreflight.js';
import { unpackBundle } from '../lib/installers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const LIB = path.resolve(HERE, '..', 'lib');
const PLUGIN_PKG = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8'));
const RANGE = PLUGIN_PKG.peerDependencies['@deepseek-ai/dsh'];

let passed = 0, failed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  OK  ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e?.message ?? e}`); console.error(`  NG  ${name}: ${e?.message ?? e}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-engines-'));
async function publishSkill(id, withAuthorPkg = false) {
  const dataRoot = path.join(tmp, 'root-' + id);
  const dir = path.join(dataRoot, 'skills', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${id}\nversion: 1.0.0\n---\n# ${id}\n`);
  if (withAuthorPkg) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'author-written', engines: { node: '>=18' } }));
  }
  return preparePublishBundle({ dataRoot, kind: 'skill', localId: id, version: '1.0.0' });
}

console.log('================================================');
console.log('  engines.dsh 声明 → preflight 门禁 — 端到端守卫');
console.log('================================================');

// ── A. 常量真源 ────────────────────────────────────────────
await check('发布端常量与本插件 peerDependencies 逐字一致', async () => {
  const pub = fs.readFileSync(path.join(LIB, 'publisher.js'), 'utf8');
  assert.ok(RANGE, 'package.json 缺 @deepseek-ai/dsh peerDependency');
  assert.ok(pub.includes(`const DSH_SUPPORTED_RANGE = '${RANGE}';`), '常量与 peerDependencies 漂移');
});

// ── B. satisfies 的 AND 语义（否则上界被静默吞掉）────────────
await check('AND 区间：0.2.2-rc.5 满足、0.3.1 与 0.1.0 不满足', async () => {
  assert.equal(satisfies('0.2.2-rc.5', RANGE), true);
  assert.equal(satisfies('0.3.1', RANGE), false, '0.3.x 必须被上界拦住');
  assert.equal(satisfies('0.1.0', RANGE), false, '过老宿主必须被下界拦住');
});
await check('|| 分段与单比较器仍兼容', async () => {
  assert.equal(satisfies('1.5.0', '^1.0.0 || ^2.0.0'), true);
  assert.equal(satisfies('3.0.0', '^1.0.0 || ^2.0.0'), false);
  assert.equal(satisfies('1.2.3', '>=1.0.0'), true);
  assert.equal(satisfies('1.2.3', 'not-a-range'), null);
  assert.equal(satisfies('', RANGE), null);
});

// ── C. 真实发布包 ──────────────────────────────────────────
let prepared;
await check('真实 preparePublishBundle 注入恰好一份 package.json', async () => {
  prepared = await publishSkill('demo');
  const pkgs = prepared.files.filter(f => f.path === 'package.json');
  assert.equal(pkgs.length, 1);
  const body = JSON.parse(pkgs[0].data.toString('utf8'));
  assert.equal(body.engines.dsh, RANGE);
  assert.equal(body.private, true);
  assert.equal(body.version, '1.0.0');
  assert.ok(prepared.manifest.files.includes('package.json'));
  assert.equal(prepared.manifest.files.filter(p => p === 'manifest.json').length, 0, 'manifest.json 由末尾追加，不该重复计入');
});
await check('作者自带 package.json 被替换（不出现同路径两条）', async () => {
  const p = await publishSkill('author', true);
  const pkgs = p.files.filter(f => f.path === 'package.json');
  assert.equal(pkgs.length, 1);
  const body = JSON.parse(pkgs[0].data.toString('utf8'));
  assert.equal(body.engines.dsh, RANGE);
  assert.equal(body.name, 'author', 'name 用 localId，不沿用作者那份');
});
await check('打包字节确定性不受注入影响', async () => {
  const a = await publishSkill('d1');
  const b = await publishSkill('d1');
  assert.ok(a.gzBuffer.equals(b.gzBuffer), '同内容必须产出相同字节');
});

// ── D. 端到端：发布包 → preflight 门禁 ───────────────────────
await check('解包后门禁判为 ok（当前宿主在区间内）', async () => {
  const { files } = await unpackBundle(prepared.gzBuffer);
  const r = preflightCompatibility({ files, runtimeVersion: '0.2.2-rc.5' });
  assert.equal(r.status, 'ok');
  assert.equal(r.requirements['engines.dsh'], RANGE);
});
await check('解包后门禁判为 incompatible（0.3.1 宿主被拦）', async () => {
  const { files } = await unpackBundle(prepared.gzBuffer);
  const r = preflightCompatibility({ files, runtimeVersion: '0.3.1' });
  assert.equal(r.status, 'incompatible');
  assert.equal(r.code, 'E_INCOMPATIBLE_DSH');
  assert.match(r.message, /当前宿主 dsh 为 0\.3\.1/);
});
await check('读不到宿主版本 / 老包无声明 ⇒ unknown 放行（向后兼容）', async () => {
  const { files } = await unpackBundle(prepared.gzBuffer);
  assert.equal(preflightCompatibility({ files, runtimeVersion: '' }).status, 'unknown');
  const old = files.filter(f => f.path !== 'package.json');
  assert.equal(preflightCompatibility({ files: old, runtimeVersion: '0.3.1' }).status, 'unknown');
});

// ── E. 安装端不落盘污染 ─────────────────────────────────────
await check('注入的 package.json 被 runtimeFiles 过滤，不写进资源目录', async () => {
  const { installBundle } = await import('../lib/installers.js');
  const root = path.join(tmp, 'install-root');
  // 用「无 engines 声明」的 package.json ⇒ 门禁 unknown 放行，避免依赖本机宿主版本
  const files = [
    { path: 'SKILL.md', data: Buffer.from('---\nname: x\nversion: 1.0.0\n---\n# x\n') },
    { path: 'manifest.json', data: Buffer.from(JSON.stringify({ kind: 'skill', id: 'x', version: '1.0.0' })) },
    { path: 'package.json', data: Buffer.from(JSON.stringify({ name: 'x', private: true })) },
  ];
  await installBundle({ dataRoot: root, kind: 'skill', storeId: 'x', version: '1.0.0', files });
  const dest = path.join(root, 'skills', 'x');
  assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')), '入口文件应落盘');
  assert.equal(fs.existsSync(path.join(dest, 'package.json')), false, '兼容性声明不能污染资源目录');
  assert.equal(fs.existsSync(path.join(dest, 'manifest.json')), false, 'manifest 也不能落盘');
});
await check('四处过滤与组合包 META_FILES 已接线（静态契约）', async () => {
  const ins = fs.readFileSync(path.join(LIB, 'installers.js'), 'utf8');
  assert.equal((ins.match(/f\.path !== 'package\.json'/g) || []).length >= 3, true);
  const comp = fs.readFileSync(path.join(LIB, 'components.js'), 'utf8');
  assert.match(comp, /META_FILES = new Set\(\['manifest\.json', COMPONENTS_FILE, 'package\.json'\]\)/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n================================================');
console.log(`  通过: ${passed}`);
console.log(`  失败: ${failed}`);
if (failures.length) { for (const f of failures) { console.log(`    - ${f}`); } }
console.log('================================================');
process.exit(failed > 0 ? 1 : 0);
