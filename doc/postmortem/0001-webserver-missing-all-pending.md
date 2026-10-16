# 0001 webServer 缺失导致全部模块插件永久 pending

**日期**：2026-10 上旬（poc/dsh-p0/README.md 4.79 / 4.96 节）
**状态**：已修复 + 已加守卫

## 现象
bridge / chat-surface / codebase / memory 等模块插件全部"装了但没反应"，无报错。

## 根因
cordis 的 inject pending 语义：服务未满足时 fiber **静默挂起**。`@deepseek-ai/dsh-web-app` 提供 `webServer`/`connection` 两个服务，当时伴生插件安装顺序把它排在了依赖者之后且它本身未装上，导致所有 `inject: [webServer, ...]` 的插件永远 pending。pending 不产生任何错误日志，排查成本极高。

## 修复
`dshHostSupervisor.ts` 启动时建立显式有序安装表，web-app **先装**（L700-731，注释点名此坑）。

## 永久守卫 / 教训
- 静态 `inject` 收窄到 `['tools']`；`webServer`/`connection` 一律 `ctx.inject([...], page => ...)` 软注入（headless profile 下工具仍可用）。唯一例外 `vssaros-bridge`。
- 守卫已进 `dshPluginPackages` 静态检查。
- **教训**：cordis 里「缺依赖 = 静默挂起」不是 bug 是语义；诊断手段是看 roster broken 行，不是等报错。
