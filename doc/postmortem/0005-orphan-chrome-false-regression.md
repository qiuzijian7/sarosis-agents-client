# 0005 孤儿 headless Chrome 造成 E2E「假回归」

**日期**：2026-10（见记忆 feedback_orphan_chrome_false_regression）
**状态**：流程已立

## 现象
E2E 真机探针从 2.5s 正常跌到 20s 超时，疑似代码回归。

## 根因
之前探针运行残留的孤儿 headless Chrome 进程占着调试端口/资源，新一轮探针连上的是旧实例或争抢资源。改动代码前先怀疑代码是错的——环境问题会伪装成产品回归。

## 修复
- 探针 `finally` 块必须 `taskkill /T` 清理 spawn 的进程树
- 排查顺序纪律：E2E 异常先查进程（`Get-Process chrome/msedge`），再怀疑被测代码

## 永久守卫 / 教训
- 对应官方纪律：`packages/AGENTS.md` L18「spec 并发运行，端口/路径/子进程都要有 teardown 归属；只在单独跑时过的 spec 是 spec 缺陷」。
- **教训**：真机探针的失败分两类——探针自身污染 vs 产品缺陷；先自证探针（feedback_probe_selfcheck），再下产品结论。
