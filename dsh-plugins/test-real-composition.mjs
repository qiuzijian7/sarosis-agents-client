#!/usr/bin/env node
// test-real-composition.mjs — REAL-composition 测试矩阵（官方 docs/testing.md L39 政策落地）
//
// 与静态守卫的本质区别：用 dsh 官方 Loader（app-boot.boot）为每个插件真起一棵组合树
//   dsh-system-prompt → dsh-tools → 被测插件（本仓源码，非装机副本）
// 每插件三层断言：
//   ① boot 后条目全部 active（pending/失败即红——抓「缺服务静默挂起」类）
//   ② 模型可见面：声明的工具名全部 ctx.tools.get 得到（钉住模型可见契约）
//   ③ HMR-safety（官方 AGENTS.md L17）：dispose 该插件 fiber 后其工具全部移除
//
// 不覆盖的插件（附原因，勿删）：
//   vssaros-bridge   —— inject 8 个官方服务（webServer/agents/llm…），其行配置分散在 base/web-app
//                      bundle patch 里，进程内复刻等于重起整个 profile（≈60 插件），价值低且脆；
//                      该链由真机探针覆盖：poc/dsh-p0/p3-12-bridge-reverse / p3-20-bridge-session-start
//   vssaros-ide      —— 依赖 vssarosBridge（同上）；真机覆盖：p3-13-ide-plugin / p3-14-ide-e2e
//   vssaros-chat-surface / vssaros-kb-refs —— 价值在客户端 chunk，host 半无工具面
//   @tt-a1i/archify-dsh —— vendored 第三方，技能形态
//
// 用法：node dsh-plugins/test-real-composition.mjs [插件目录名...]
// 环境变量：DSH_RUNTIME_NM 覆盖运行时 node_modules（默认 ~/.vssaros-dev/dsh-runtime/最新版/）
import { mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir, homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)));

/** dir → 期望注册的工具名（空数组 = 只断言激活与干净 dispose） */
const MATRIX = {
  'vssaros-kanban': ['kanban_list', 'kanban_create', 'kanban_update', 'kanban_complete', 'kanban_decompose', 'kanban_swarm', 'kanban_specify', 'web_recipe_create', 'web_recipe_list', 'web_recipe_remove'],  // 重构 4：kanban_decompose（2026-10-16 起）
  'vssaros-kb': ['kb_list', 'kb_search', 'kb_reindex', 'kb_read', 'kb_topic_overviews', 'kb_feishu_sync'],
  'vssaros-codebase': ['codebase_overview', 'codebase_search', 'codebase_deps', 'codebase_hotspots', 'codebase_self_index'],
  'vssaros-memory': ['memory_remember', 'memory_recall', 'memory_search', 'memory_list'],
  'vssaros-workflow': ['workflow_list', 'workflow_get', 'workflow_update', 'workflow_engine_status'],
  'vssaros-dashboard': ['dashboard_session', 'dashboard_sessions'],
  'vssaros-skills': ['skill_manage', 'skill_search'],
  'vssaros-media': ['media_list', 'media_stats', 'image_generate', 'video_generate', 'text_to_speech', 'vision_analyze', 'video_analyze', 'extract_video_frames'],  // 重构 4：生成三件套 + 视觉/视频分析（2026-10-16 起不再是全只读）
  'vssaros-agents': ['agent_list', 'agent_message', 'agent_open_session'],
  'vssaros-browser': ['browser'],
  'vssaros-unreal': ['unreal_health', 'unreal_exec', 'unreal_build', 'unreal_dump', 'unreal_find_asset', 'unreal_wait', 'unreal_help'],
  'vssaros-web-content-import': ['content_import'],
  'vssaros-mcp': ['mcp_install', 'mcp_market_list'],  // 重构 4：mcp_install（2026-10-16 起不再是零工具）
  'vssaros-sessions': ['session_search'],  // 重构 4：session_search 工具（2026-10-16 起不再是零工具）
  // 重构 1.3：foundation 自身（无工具，只断言激活/服务在场/干净 dispose）。
  'vssaros-foundation': [],
  // 重构 2.1：定时任务薄壳（官方 dsh-schedule 的包装；无自有工具，schedule 走可选注入）。
  'vssaros-scheduler': [],
  // 重构 2.3：IM 渠道（无工具；loopback 适配器默认关 ⇒ 激活即验证接线）。
  'vssaros-channels': [],
  // 重构 2.4：Pocket Host 路由（无工具；无 token ⇒ 路由不注册，fail-closed ✓）。
  'vssaros-pocket': [],
};

const only = process.argv.slice(2);
const targets = only.length ? only : Object.keys(MATRIX);
for (const t of targets) if (!(t in MATRIX)) { console.error(`未知插件 ${t}（MATRIX 中登记为准）`); process.exit(2); }

const nm = process.env.DSH_RUNTIME_NM ?? (() => {
  const base = join(homedir(), '.vssaros-dev', 'dsh-runtime');
  const ver = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort().at(-1);
  return join(base, ver, 'node_modules');
})();
console.log(`运行时：${nm}`);

// 测试全程用 dev 数据根，绝不碰 ~/.vssaros 生产数据
process.env.VSSAROS_DATA_ROOT ??= join(homedir(), '.vssaros-dev');

const { boot } = await import(pathToFileURL(join(nm, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href);

let totalFail = 0;
for (const dir of targets) {
  const expected = MATRIX[dir];
  const entry = pathToFileURL(join(root, dir, 'lib', 'index.js')).href;
  console.log(`\n== ${dir}（期望工具 ${expected.length} 个）`);
  let failures = 0;
  const ok = (m) => console.log(`  ✓ ${m}`);
  const bad = (m) => { failures++; console.error(`  ✗ ${m}`); };

  const profile = mkdtempSync(join(tmpdir(), 'vssaros-rc-'));
  // 重构 1.3：foundation 先行（共享服务 `vssarosFoundation`），被测插件 inject 它 ⇒ 委托层才绑得上 ✓。
  const foundationEntry = pathToFileURL(join(root, 'vssaros-foundation', 'lib', 'index.js')).href;
  writeFileSync(join(profile, 'cordis.yml'), [
    '- id: system-prompt',
    '  name: "@deepseek-ai/dsh-system-prompt"',
    '- id: tools',
    '  name: "@deepseek-ai/dsh-tools"',
    '- id: foundation',
    `  name: "${foundationEntry}"`,
    '- id: plugin-under-test',
    `  name: "${entry}"`,
    '',
  ].join('\n'));

  let ctx;
  try {
    ctx = await boot(`rc:${dir}`, join(profile, 'cordis.yml'), undefined, undefined,
      pathToFileURL(nm + '/').href);
    ok('boot 通过（条目全部 active，无 pending）');
  } catch (err) {
    bad(`boot 失败：${String(err.message ?? err).split('\n')[0]}`);
    rmSync(profile, { recursive: true, force: true });
    totalFail += failures;
    continue;
  }

  for (const name of expected) {
    if (ctx.tools?.get(name)) ok(`工具已注册：${name}`);
    else bad(`工具未注册：${name}`);
  }

  // 重构 1.3：委托层真绑上了才算数——光"工具注册了"证明不了（绑定失败只在**调用**时才抛 ✗）。
  {
    if (dir === 'vssaros-foundation') {
      if (ctx.vssarosFoundation?.dataRootOf?.({ dataRoot: '/tmp/x' }) === '/tmp/x') ok('foundation 服务在场且 dataRootOf 可用');
      else bad('foundation 服务不在场或 dataRootOf 不可用');
      // 2026-10-17：运行期工作区上下文也必须**经服务**可用 —— 守 `provide` 那一步：
      // 进程内守卫（check-host-config.mjs）直接用 `createFoundationService()`，看不见"服务对象里
      // 漏了方法"这类错 ✗（那会让桥推到空气里：applied 还是 true ⇒ 最坏的一种静默 ✗）。
      const initial = ctx.vssarosFoundation?.workspaceContext?.();
      if (initial === undefined) ok('workspaceContext 初始为空（未推过 ⇒ 消费方回落 config ✓）');
      else bad(`workspaceContext 初始应为 undefined，实际 ${JSON.stringify(initial)}`);
      const stored = ctx.vssarosFoundation?.setWorkspaceContext?.({ workspaceId: 'rt-rc', relatedRoots: [] });
      if (stored?.workspaceId === 'rt-rc') ok('setWorkspaceContext 经服务生效（桥那条推的路径可达 ✓）');
      else bad('setWorkspaceContext 未经服务生效（provide 里漏了它，或实现不对）');
    } else if (!existsSync(join(root, dir, 'lib', 'foundationRef.js'))) {
      // 非消费插件（browser/unreal/mcp/agents 等还没接 foundation）⇒ 没有委托层，跳过。
      ok('非消费插件（无 foundationRef.js），跳过委托断言');
    } else {
      try {
        const ref = await import(pathToFileURL(join(root, dir, 'lib', 'foundationRef.js')).href);
        const got = ref.foundation().dataRootOf({ dataRoot: '/tmp/x' });
        if (got === '/tmp/x') ok('委托层已绑定（foundation().dataRootOf 通）');
        else bad(`委托层绑定后返回意外值：${got}`);
        // 2026-10-17：运行期工作区上下文必须**跨插件可见**（同一个 foundation 实例 ✓）——
        // 这就是"桥在 Host 里推一次 ⇒ 看板/记忆/图谱跟着走"的最小真组合证据 ✓。
        ctx.vssarosFoundation.setWorkspaceContext({ workspaceId: 'rt-rc', relatedRoots: [] });
        const seen = ref.foundation().workspaceContext?.()?.workspaceId;
        if (seen === 'rt-rc') ok('运行期上下文跨插件可见（桥推 ⇒ 委托层读得到 ✓）');
        else bad(`运行期上下文没跨插件可见：${seen}`);
        ctx.vssarosFoundation.clearWorkspaceContext();
      } catch (e) {
        bad(`委托层未绑定/不可用：${String(e?.message ?? e).slice(0, 120)}`);
      }
    }
  }

  const fiber = [...ctx.loader.entries()].find((e) => e.options?.name === entry)?.fiber;
  if (!fiber) {
    bad('找不到被测插件的 fiber（无法做 dispose 断言）');
  } else {
    await fiber.dispose();
    const remaining = expected.filter((n) => ctx.tools?.get(n));
    if (remaining.length === 0) ok('dispose 后工具全部移除（HMR-safety ✓）');
    else bad(`dispose 后仍残留工具：${remaining.join(', ')}`);
  }

  await ctx.fiber.dispose();
  rmSync(profile, { recursive: true, force: true });
  totalFail += failures;
}

console.log('');
if (totalFail) { console.error(`${totalFail} 个断言失败`); process.exit(1); }
console.log(`REAL-composition 矩阵全绿（${targets.length} 个插件）`);
