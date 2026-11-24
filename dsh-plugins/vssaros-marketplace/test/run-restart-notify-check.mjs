/**
 * ★ 2026-11-24：`nextStep` → IDE 通知条（marketplace op:'notify' 旁路）行为守卫。
 * 跑法：node dsh-plugins/vssaros-marketplace/test/run-restart-notify-check.mjs
 *
 * 覆盖：Host 侧工具只在「需重启」时才发通知、结构化字段跨进程、可选 dep 降级、
 *       IDE 侧 capability 分支的形状校验与服务落点。零网络、零 Host。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marketToolDefinitions } from '../lib/agentTools.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const LIB = path.resolve(HERE, '..', 'lib');
const IDE_CAP = path.join(ROOT, 'src/vs/sessions/contrib/dshHarness/common/dshIdeCapabilities.ts');
const IDE_SVC = path.join(ROOT, 'src/vs/sessions/contrib/dshHarness/electron-browser/dshHarnessService.ts');

let passed = 0, failed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  OK  ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e?.message ?? e}`); console.error(`  NG  ${name}: ${e?.message ?? e}`); }
}

function defs(extra = {}) {
  return marketToolDefinitions({
    inspectGithubRepo: async () => ({}),
    publishDistribution: async () => ({}),
    installPackage: async () => ({ ok: true, kind: 'plugin', version: '1.0.0', restartRequired: true }),
    market: () => ({ list: async () => ({ items: [], total: 0 }), detail: async () => ({}) }),
    ...extra,
  }).find(d => d.name === 'market_install');
}

console.log('================================================');
console.log('  nextStep → IDE 通知条 — 行为守卫');
console.log('================================================');

// ── A. Host 侧工具触发条件与 payload ─────────────────────────
await check('需重启 ⇒ 调 notifyRestart 一次，带结构化字段', async () => {
  const calls = [];
  const tool = defs({ notifyRestart: async (p) => { calls.push(p); return true; } });
  const r = await tool.execute({ slug: 'x' });
  // 通知是 fire-and-forget，等一个微任务轮次
  await Promise.resolve();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'warn');
  assert.equal(calls[0].application, 'restart-required');
  assert.equal(calls[0].restartReason, 'no-hmr');
  assert.match(calls[0].text, /已安装/);
  assert.match(calls[0].nextStep, /重启 Host 进程/);
  assert.equal(r.application, 'restart-required');
});
await check('applied（成功即时生效）⇒ 不发通知（对齐上游「成功不显示 toast」）', async () => {
  const calls = [];
  const tool = marketToolDefinitions({
    inspectGithubRepo: async () => ({}), publishDistribution: async () => ({}),
    installPackage: async () => ({ ok: true, kind: 'skill', version: '1.0.0' }),
    market: () => ({ list: async () => ({ items: [] }), detail: async () => ({}) }),
    notifyRestart: async (p) => { calls.push(p); return true; },
  }).find(d => d.name === 'market_install');
  await tool.execute({ slug: 'x' });
  await Promise.resolve();
  assert.equal(calls.length, 0);
});
await check('dep 缺失 ⇒ 静默降级，安装回执不受影响', async () => {
  const tool = defs();
  const r = await tool.execute({ slug: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.application, 'restart-required');
});
await check('notifyRestart 抛同步异常 ⇒ 不破坏安装结果', async () => {
  const tool = defs({ notifyRestart: () => { throw new Error('bridge down'); } });
  const r = await tool.execute({ slug: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.restartNotice.kind, 'warn');
});
await check('notifyRestart 返回 rejected Promise ⇒ 不产生未处理拒绝', async () => {
  const tool = defs({ notifyRestart: async () => { throw new Error('IDE rejected'); } });
  const r = await tool.execute({ slug: 'x' });
  await new Promise(res => setTimeout(res, 20));
  assert.equal(r.ok, true);
});
await check('notifyRestart 返回非 Promise ⇒ 也不抛', async () => {
  const tool = defs({ notifyRestart: () => false });
  const r = await tool.execute({ slug: 'x' });
  assert.equal(r.ok, true);
});

// ── B. 插件侧与 IDE 侧静态接线 ───────────────────────────────
await check('agentTools deps 声明 notifyRestart 且只在 restartNotice 时调用', async () => {
  const a = fs.readFileSync(path.join(LIB, 'agentTools.js'), 'utf8');
  assert.match(a, /notifyRestart \} = deps/);
  assert.match(a, /if \(restartNotice && typeof notifyRestart === 'function'\)/);
  assert.match(a, /Promise\.resolve\(notifyRestart/);
});
await check('index.js 注入 notifyRestart，复用 marketplace capability', async () => {
  const i = fs.readFileSync(path.join(LIB, 'index.js'), 'utf8');
  assert.match(i, /notifyRestart: async \(payload\)/);
  assert.match(i, /capability: 'marketplace'/);
  assert.match(i, /params: \{ op: 'notify', \.\.\.payload \}/);
  assert.match(i, /if \(!bridge \|\| typeof bridge\.callIDE !== 'function'\) \{ return false; \}/);
});
await check('IDE 能力环境新增 showNotification 可选成员', async () => {
  const t = fs.readFileSync(IDE_CAP, 'utf8');
  assert.match(t, /showNotification\?\(request:/);
  assert.match(t, /readonly kind: 'info' \| 'warn'/);
});
await check('marketplace case 的 notify 旁路在写类确认之前且限长', async () => {
  const t = fs.readFileSync(IDE_CAP, 'utf8');
  const start = t.indexOf("case 'marketplace':");
  const body = t.slice(start, t.indexOf('case ', start + 20));
  const notifyAt = body.indexOf("if (op === 'notify')");
  const writeAt = body.indexOf('const WRITE_OPS');
  assert.ok(notifyAt >= 0, '缺少 notify 分支');
  assert.ok(notifyAt < writeAt, 'notify 必须在 WRITE_OPS 之前，避免走 confirmUserAction');
  assert.match(body, /kind !== 'info' && kind !== 'warn'/);
  assert.match(body, /!text\.trim\(\)/);
  assert.match(body, /text\.slice\(0, 500\)/);
  assert.match(body, /return \{ op, ok: true, notified: true \}/);
});
await check('dshHarnessService 注入 INotificationService 并实现落点', async () => {
  const s = fs.readFileSync(IDE_SVC, 'utf8');
  assert.match(s, /@INotificationService private readonly _notifications/);
  assert.match(s, /showNotification: r =>/);
  assert.match(s, /r\.kind === 'warn' \? Severity\.Warning : Severity\.Info/);
  assert.match(s, /`DSH: \$\{r\.text\}`/);
  assert.match(s, /source: 'DeepSeek Harness'/);
});
await check('out/ 自动编译产物已包含 notify 旁路（若存在）', async () => {
  const p = path.join(ROOT, 'out/vs/sessions/contrib/dshHarness/common/dshIdeCapabilities.js');
  if (!fs.existsSync(p)) { console.log('    -- out/ 无该产物，跳过'); return; }
  const js = fs.readFileSync(p, 'utf8');
  assert.match(js, /op === "notify"|op === 'notify'/);
  assert.match(js, /notified: true/);
});

console.log('\n================================================');
console.log(`  通过: ${passed}`);
console.log(`  失败: ${failed}`);
if (failures.length) { for (const f of failures) { console.log(`    - ${f}`); } }
console.log('================================================');
process.exit(failed > 0 ? 1 : 0);
