# 团队研发流水线（`dsh-teamflow-workbench`）

一句话需求到验收交付：分诊/PRD/设计/开发/QA/验收，带证据门禁与人工闸

## 形态

- 注册式工作台：左列表 / 右详情，颜色与尺寸全走共享层（`wb-*` + `--dsw-alias-*`）。
- 取数：`GET /x/teamflow/?format=json`（与 SSR 共用同一次装配）。

## 本地验证与安装

```bash
node ./test/run-teamflow-check.mjs     # 包内自检
pnpm pack                                   # 产出 .tgz（宿主不代构建）
```

装上：让 Agent 调 `install_local_workbench({ path: "<.tgz 绝对路径>" })`（会弹一次确认）。
`application` 为 `restart-required` 时**重启 Harness** 后，在工作台启动器（右键侧栏「工作台」）里出现。
重启之前启动器会提示“已安装，重启 Harness 后出现”，那是预期，不是失败。

> 身份：`local:dsh-teamflow-workbench`（由描述符的 `package` 字段派生）。外部包**不需要**登记任何宿主表。
