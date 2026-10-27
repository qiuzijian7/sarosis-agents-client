/*---------------------------------------------------------------------------------------------
 *  run-memory-checks.mjs — **记忆链路一键自检**（2026-10-26）
 *
 * ## 为什么要有它
 * 记忆相关的不变量散在 5 处（dsh 守卫 / 插件测试 / 引擎单测 / IDE 导航守卫），
 * 每次改动要手工记「跑哪几个」⇒ 必然漏（本次就漏过 `client.memory.js` 生成块漂移）。
 * ⇒ 一条命令全跑，输出表格 + 非零退出码，可直接进 CI。
 *
 * ## 覆盖（离线可跑，不需要重启 IDE）
 *  1. `check-memory-detail-react.mjs`      — 详情页 = React 二级页 + 单一真源/生成块一致 + 服务端复用 loadDetailModel
 *  2. `check-memory-provider-parity.mjs`   — IDE 调用的记忆方法 ⊆ proxy 实现（防 `?.()` 静默 no-op）
 *  3. `test/reactDetailSmoke.mjs`          — 详情页 **真渲染** 18 项（10 页签/空态/tier/筛选/固化计数）
 *  4. `test/turnDistill.test.mjs`          — 按回合摘要自动沉淀 6 项（阈值/去重/截断/压缩检查点）
 *  5. `test/writeScope.test.mjs`           — preset ⇒ 人设 ⇒ 写分区 6 项
 *  6. 引擎单测 `extensions/agentmemory-memory` 的 `npm run test:unit`（跨分区兜底 / observe / 作用域解析）
 *  7. `src/.../dshHarness/test/.../run-all-common-tests.mjs dshView`（导航守卫：主帧/子帧/手势/hash）
 *
 * 用法：
 *   node dsh-plugins/run-memory-checks.mjs            # 全跑
 *   node dsh-plugins/run-memory-checks.mjs --fast     # 跳过引擎单测（它要编译 ~11s）
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FAST = process.argv.includes('--fast');

const steps = [
  { name: '守卫：详情页 = React 二级页 + 生成块一致', cmd: 'node', args: [path.join('dsh-plugins', 'check-memory-detail-react.mjs')] },
  { name: '守卫：IDE 调用的记忆方法 ⊆ proxy', cmd: 'node', args: [path.join('dsh-plugins', 'check-memory-provider-parity.mjs')] },
  { name: '测试：详情页真渲染（18 项）', cmd: 'node', args: [path.join('dsh-plugins', 'vssaros-memory', 'test', 'reactDetailSmoke.mjs')] },
  { name: '测试：回合摘要自动沉淀（6 项）', cmd: 'node', args: [path.join('dsh-plugins', 'vssaros-memory', 'test', 'turnDistill.test.mjs')] },
  { name: '测试：回合观测（dsh 侧，7 项）', cmd: 'node', args: [path.join('dsh-plugins', 'vssaros-memory', 'test', 'turnObserve.test.mjs')] },
  { name: '测试：preset⇒人设⇒写分区（6 项）', cmd: 'node', args: [path.join('dsh-plugins', 'vssaros-memory', 'test', 'writeScope.test.mjs')] },
  {
    name: '单测：引擎（跨分区兜底 / observe / 作用域）',
    cmd: 'npm',
    args: ['--prefix', path.join('extensions', 'agentmemory-memory'), 'run', 'test:unit'],
    skip: FAST,
    skipReason: '--fast',
    timeout: 300_000,
  },
  {
    name: '单测：dsh 导航守卫（主帧/子帧/手势/hash）',
    cmd: 'node',
    args: [path.join('src', 'vs', 'sessions', 'contrib', 'dshHarness', 'test', 'common', 'run-all-common-tests.mjs'), 'dshView'],
    timeout: 180_000,
  },
];

const isWin = process.platform === 'win32';
const results = [];

for (const step of steps) {
  if (step.skip) {
    results.push({ name: step.name, ok: true, note: '跳过（' + step.skipReason + '）' });
    continue;
  }
  process.stdout.write('…… ' + step.name + ' ');
  const r = spawnSync(step.cmd, step.args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,          // dsh Host 无控制台 ⇒ 不加会闪窗（check-spawn-hide 判据）
    shell: isWin,               // Windows 下 npm 是 .cmd ⇒ 需要 shell
    timeout: step.timeout ?? 120_000,
  });
  const out = String(r.stdout ?? '') + String(r.stderr ?? '');
  const ok = r.status === 0;
  // 抓最后一行的“结论”（各测试都会打 ✓/✗ 或 passing/failing）
  const tail = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(-1)[0] ?? '';
  results.push({ name: step.name, ok, note: tail.slice(0, 110) });
  console.log(ok ? '✓' : '✗');
}

const width = Math.max(...results.map(r => r.name.length));
console.log('\n' + '═'.repeat(90));
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name.padEnd(width)}  ${r.note}`);
}
const failed = results.filter(r => !r.ok);
console.log('═'.repeat(90));
if (failed.length) {
  console.error(`✗ 记忆链路自检失败：${failed.length}/${results.length} 组未通过`);
  process.exit(1);
}
console.log(`✓ 记忆链路自检全部通过（${results.length} 组）`);
