/**
 * ★ 2026-11-24：外部源 `distribution.peerRange` 展示与「只提示、不阻断」兼容性提示守卫。
 * 跑法：node dsh-plugins/vssaros-marketplace/test/run-peer-range-preview-check.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { distributionWarnings, summarizeDistribution, finishPreview } from '../lib/preview.js';
import { peerRangeOf } from '../lib/npmLookup.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const LIB = path.resolve(HERE, '..', 'lib');
const SERVER = path.resolve(ROOT, '..', 'saros-marketplace');

let passed = 0, failed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  OK  ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e?.message ?? e}`); console.error(`  NG  ${name}: ${e?.message ?? e}`); }
}

console.log('================================================');
console.log('  peerRange 展示 / 兼容性提示 — 守卫');
console.log('================================================');

const dist = (peerRange) => ({ type: 'npm', name: '@x/wb', ...(peerRange ? { peerRange } : {}) });
const RANGE = '@deepseek-ai/dsh@>=0.1.7-0 <0.3.0-0';

// ── A. 展示 ────────────────────────────────────────────────
check('summarizeDistribution 把 peerRange 展成「宿主版本要求」', () => {
  const s = summarizeDistribution(dist(RANGE));
  assert.ok(s.fields.some(f => f.k === '宿主版本要求' && f.v === RANGE));
});
check('无 peerRange ⇒ 不新增字段（老商品形状不变）', () => {
  const s = summarizeDistribution({ type: 'github-source', name: 'a/b', commit: 'abc' });
  assert.equal(s.fields.some(f => f.k === '宿主版本要求'), false);
});
check('真实 peerRangeOf 输出可被展示', () => {
  const raw = peerRangeOf({ '@deepseek-ai/dsh': '>=0.1.7-0 <0.3.0-0', react: '^18' });
  assert.match(raw, /@deepseek-ai\/dsh@/);
  const s = summarizeDistribution(dist(raw));
  assert.equal(s.fields.find(f => f.k === '宿主版本要求').v, raw);
});

// ── B. 只提示、不阻断 ──────────────────────────────────────
check('不传宿主版本 ⇒ 不判定（向后兼容现有守卫）', () => {
  const pinned = distributionWarnings({ type: 'github-source', name: 'a/b', commit: 'abc' }, 'skill');
  assert.equal(pinned.length, 0);
  assert.equal(distributionWarnings(dist(RANGE), 'plugin').length, 0);
});
check('宿主 0.3.1 不满足 AND 区间 ⇒ warn 级，不是 danger', () => {
  const w = distributionWarnings(dist(RANGE), 'plugin', { runtimeVersion: '0.3.1' });
  const hit = w.filter(x => /不满足发布源登记/.test(x.text));
  assert.equal(hit.length, 1);
  assert.equal(hit[0].level, 'warn');
  assert.match(hit[0].text, /仅提示，不阻断安装/);
  assert.match(hit[0].text, /0\.3\.1/);
  assert.equal(w.some(x => x.level === 'danger'), false);
});
check('finishPreview 不因兼容性提示禁用安装按钮', () => {
  const r = finishPreview({ ok: true, warnings: distributionWarnings(dist(RANGE), 'plugin', { runtimeVersion: '0.3.1' }) }, null);
  assert.equal(r.blocked, false);
});
check('宿主 0.2.2-rc.5 满足区间 ⇒ 零额外告警', () => {
  assert.equal(distributionWarnings(dist(RANGE), 'plugin', { runtimeVersion: '0.2.2-rc.5' }).length, 0);
});
check('宿主过老（0.1.0）也被下界拦出提示', () => {
  assert.ok(distributionWarnings(dist(RANGE), 'plugin', { runtimeVersion: '0.1.0' }).some(x => /不满足发布源登记/.test(x.text)));
});

// ── C. 解析与保守口径 ──────────────────────────────────────
check('range 含空格 AND 不被误切成两个条目', () => {
  const w = distributionWarnings(dist(RANGE), 'plugin', { runtimeVersion: '0.3.1' });
  assert.equal(w.filter(x => /不满足发布源登记/.test(x.text)).length, 1);
});
check('多条 peer 只判 @deepseek-ai/dsh*，忽略其它包', () => {
  const raw = 'react@^18 @deepseek-ai/dsh@>=0.9.0 @deepseek-ai/dsh-app-boot@^0.2.0';
  const w = distributionWarnings(dist(raw), 'plugin', { runtimeVersion: '0.2.2-rc.5' });
  const hit = w.filter(x => /不满足发布源登记/.test(x.text));
  assert.equal(hit.length, 1, 'dsh 那条不满足；app-boot 的 ^0.2.0 满足，不该报');
  assert.match(hit[0].text, /@deepseek-ai\/dsh >=0\.9\.0/);
});
check('非 dsh peer（react）完全不判定', () => {
  assert.equal(distributionWarnings(dist('react@>=99'), 'plugin', { runtimeVersion: '0.2.2-rc.5' }).length, 0);
});
check('range 看不懂 ⇒ 不误报', () => {
  assert.equal(distributionWarnings(dist('@deepseek-ai/dsh@not-a-range'), 'plugin', { runtimeVersion: '0.2.2-rc.5' }).length, 0);
});
check('workspace:/file: 之类非 registry 值不误报', () => {
  assert.equal(distributionWarnings(dist('@deepseek-ai/dsh@workspace:^'), 'plugin', { runtimeVersion: '0.2.2-rc.5' }).length, 0);
});

// ── D. 纯函数性与接线 ──────────────────────────────────────
check('preview.js 保持纯函数（不读磁盘 / 不发网络）', () => {
  const s = fs.readFileSync(path.join(LIB, 'preview.js'), 'utf8');
  assert.doesNotMatch(s, /currentDshVersion\(/);
  assert.doesNotMatch(s, /readFile|fetch\(|writeFile/);
  assert.match(s, /import \{ satisfies \} from '\.\/hostVersion\.js'/);
});
check('index.js 注入宿主版本且只在可靠来源时判定', () => {
  const s = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');
  assert.match(s, /import \{ currentDshVersion \} from '\.\/hostVersion\.js'/);
  assert.match(s, /previewHostVersion/);
  assert.match(s, /hv\.source === 'process\.argv\[1\]' \|\| hv\.source === 'require\.resolve'/);
  assert.match(s, /distributionWarnings\(dist, kind, \{ runtimeVersion: previewHostVersion \}\)/);
});
check('预览仍只读（未引入任何落盘副作用）', () => {
  const s = fs.readFileSync(path.join(LIB, 'preview.js'), 'utf8');
  assert.doesNotMatch(s, /upsertInstalled|installBundle|registerMcpServer/);
});
check('服务端 DistributionSchema 已声明 peerRange（契约对齐）', () => {
  const p = path.join(SERVER, 'src/packages/parser.ts');
  if (!fs.existsSync(p)) { console.log('    -- 服务端仓不在同盘，跳过'); return; }
  assert.match(fs.readFileSync(p, 'utf8'), /peerRange:\s*z\.string\(\)\.optional\(\)/);
});

console.log('\n================================================');
console.log(`  通过: ${passed}`);
console.log(`  失败: ${failed}`);
if (failures.length) { for (const f of failures) { console.log(`    - ${f}`); } }
console.log('================================================');
process.exit(failed > 0 ? 1 : 0);
