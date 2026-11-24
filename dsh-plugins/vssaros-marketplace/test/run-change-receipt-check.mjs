/**
 * ★ 2026-11-24 P0：安装回执归一化（上游 ChangeResult 语义）行为守卫。
 * 跑法：node dsh-plugins/vssaros-marketplace/test/run-change-receipt-check.mjs
 *
 * 对齐上游 @deepseek-ai/dsh-plugin-manager/src/types.ts:171-176：
 *   application / restartReason / nextStep / stage / changed
 * 纯函数，不访问网络、不落盘、不触发重启。
 */
import assert from 'node:assert/strict';
import { toChangeReceipt } from '../lib/dispatch.js';

let passed = 0, failed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log(`  OK  ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e?.message ?? e}`); console.error(`  NG  ${name}: ${e?.message ?? e}`); }
}

console.log('================================================');
console.log('  ChangeResult 回执归一化 — 行为守卫');
console.log('================================================');

check('无重启标记 ⇒ applied，成功静默（nextStep=null）', () => {
  const r = toChangeReceipt({ ok: true, kind: 'skill', version: '1.0.0' }, { op: 'install' });
  assert.equal(r.application, 'applied');
  assert.equal(r.restartRequired, false);
  assert.equal(r.restartReason, null);
  assert.equal(r.nextStep, null);
  assert.equal(r.stage, 'install');
  assert.equal(r.changed, true);
});
check('布尔 restartRequired ⇒ restart-required + no-hmr + 明确 nextStep', () => {
  const r = toChangeReceipt({ ok: true, restartRequired: true }, { op: 'install' });
  assert.equal(r.application, 'restart-required');
  assert.equal(r.restartRequired, true);
  assert.equal(r.restartReason, 'no-hmr');
  assert.match(r.nextStep, /重启 Host 进程/);
  assert.match(r.nextStep, /不要只 Reload Window/);
  assert.match(r.nextStep, /我不会替你重启/);
});
check('上游 application=applied 优先于缺失的布尔', () => {
  const r = toChangeReceipt({ ok: true, application: 'applied' }, { op: 'install' });
  assert.equal(r.application, 'applied');
  assert.equal(r.nextStep, null);
});
check('application=restart-required + packageName ⇒ package-moved', () => {
  const r = toChangeReceipt({ ok: true, application: 'restart-required', packageName: '@x/wb', via: 'dsh' }, { op: 'install' });
  assert.equal(r.restartReason, 'package-moved');
  assert.match(r.nextStep, /工作台启动器/);
});
check('agentsRescan=restart ⇒ 升级为需重启并带出状态', () => {
  const r = toChangeReceipt({ ok: true, agentsRescan: 'restart' }, { op: 'install' });
  assert.equal(r.application, 'restart-required');
  assert.match(r.nextStep, /Agent 重扫状态：restart/);
});
check('agentsRescan=ok ⇒ 已即时生效，不弹重启', () => {
  const r = toChangeReceipt({ ok: true, agentsRescan: 'ok' }, { op: 'install' });
  assert.equal(r.application, 'applied');
  assert.equal(r.nextStep, null);
});
check('只有 mcpNote 且无需重启 ⇒ 成功静默（不生成 nextStep）', () => {
  const r = toChangeReceipt({ ok: true, mcpNote: '运行时挂载会自动连接' }, { op: 'install' });
  assert.equal(r.application, 'applied');
  assert.equal(r.nextStep, null);
});
check('需重启时把 mcpNote 并入 nextStep', () => {
  const r = toChangeReceipt({ ok: true, restartRequired: true, mcpNote: 'MCP 需要填环境变量' }, { op: 'install' });
  assert.match(r.nextStep, /MCP 需要填环境变量/);
});
check('失败回执 ⇒ application=failed，不生成重启提醒', () => {
  const r = toChangeReceipt({ ok: false, error: '下载失败' }, { op: 'install' });
  assert.equal(r.application, 'failed');
  assert.equal(r.restartRequired, false);
  assert.equal(r.nextStep, null);
});
check('stage 按 op 区分 install / remove / enable', () => {
  assert.equal(toChangeReceipt({ ok: true }, { op: 'install' }).stage, 'install');
  assert.equal(toChangeReceipt({ ok: true }, { op: 'uninstall' }).stage, 'remove');
  assert.equal(toChangeReceipt({ ok: true }, { op: 'set-plugin-enabled' }).stage, 'enable');
});
check('changed:false 与 overridden 不误报需重启', () => {
  const a = toChangeReceipt({ ok: true, changed: false }, { op: 'install' });
  assert.equal(a.changed, false);
  const b = toChangeReceipt({ ok: true, application: 'overridden' }, { op: 'install' });
  assert.equal(b.application, 'overridden');
  assert.equal(b.nextStep, null);
});
check('空回执不抛异常', () => {
  assert.equal(toChangeReceipt(null, {}).application, 'failed');
  assert.equal(toChangeReceipt(undefined, {}).application, 'failed');
});

console.log('\n================================================');
console.log(`  通过: ${passed}`);
console.log(`  失败: ${failed}`);
if (failures.length) { for (const f of failures) { console.log(`    - ${f}`); } }
console.log('================================================');
process.exit(failed > 0 ? 1 : 0);
