---
name: tapd-skill
description: "当提及 TAPD 需求/缺陷/任务/迭代/等内容或包含 tapd.woa.com 链接时使用。不适用于：TAPD 管理后台配置、权限管理、项目创建与管理、流水线与持续集成等场景。"
homepage: https://api.tapd.cn
metadata:
  version: "0.3.0"
tier: extended
---

# TAPD Open API（随包凭据，直接调用）

本技能**只走 TAPD Open API**（`https://api.tapd.cn`）：不需要配置外部服务、不需要本人登录、不需要个人访问令牌。

## 调用入口

```bash
node "<skillDir>/scripts/tapd-api.mjs" <命令> [参数]
```

`<skillDir>` 用加载本技能时给出的 **Base directory 绝对路径**替换（会话 cwd 不是技能目录，别写相对路径）。
脚本零依赖（Node 18+ 自带 fetch），stdout **恒为一个 JSON 对象**：

- 成功：`{"ok":true,"command":"list","credential":"Basic TAPD_CLIENT_ID/SECRET (shipped API account)","count":N,"shown":"GET /bugs?…","data":…}`
- 失败：`{"ok":false,"error":"…"}`，退出码 1。`shown` 是本次请求的口径，回答里可以引用它。

## 凭据（随包，开箱即用）

- 安装包自带 TAPD 接入应用（`TAPD_CLIENT_ID` + `TAPD_CLIENT_SECRET`），**装完即可操作 TAPD**。
- 优先级：环境变量 > 凭据文件 > 随包账号。可覆盖的键：`TAPD_CLIENT_ID` / `TAPD_CLIENT_SECRET`、`TAPD_API_USER` / `TAPD_API_PWD`、`TAPD_API_TOKEN`、`DSH_SUPERAGENT_TAPD_BEARER` / `DSH_SUPERAGENT_TAPD_USER` / `DSH_SUPERAGENT_TAPD_PASSWORD`。
- 凭据文件：`<DSH_HOME>/tapd.env`，或用 `TAPD_ENV_FILE` / `DSH_SUPERAGENT_TAPD_ENV_FILE` 指向已有的 `.env`（`KEY=VALUE`，只读取白名单键）。
- 停用随包账号：设置 `DSH_SUPERAGENT_TAPD_BUNDLED=off` 后必须自己提供凭据。
- 凭据只用于构造 `Authorization` 头，脚本输出**不含任何明文密钥**；`status` 命令可随时验证连通性与当前账号类型。
- 私有化/代理地址：`--base <URL>` 或环境变量 `TAPD_API_BASE`；项目 ID：`--workspace <ID>` 或 `TAPD_WORKSPACE_ID`（默认 GR 项目 `68880148`）。

## 命令

| 命令 | 用途 |
|---|---|
| `status` | 验证凭据与连通性（`/quickstart/testauth`），第一次用先跑它 |
| `list <story\|bug\|task>` | 列表；`--limit 30`、`--page N`、`--field k=v`（可重复） |
| `get <kind> <单号>` | 详情；`--comments N` 同时取评论 |
| `count <kind>` | 服务端精确计数，回答「有多少」一律用它 |
| `create <kind> --name <标题>` | 创建；其它字段用 `--field k=v` |
| `update <kind> <单号> --field k=v` | 更新（必须给单号，至少一个字段） |
| `comment <kind> <单号> --description <HTML>` | 发评论；`--author <署名>` 可选 |
| `statuses <bug\|story>` | 状态码 ↔ 中文（`/workflows/status_map`） |
| `iterations` | 迭代列表 |
| `fields <kind>` | 字段配置（`/…/fields_info`） |
| `raw <GET\|POST> <路径> [k=v …]` | 任意 Open API 路径；删除等非常用操作走这里 |
| `help` | 完整用法 |

通用参数：`--workspace`、`--base`、`--field`、`--pretty`（缩进输出）、`--confirm`（写操作显式确认）。

## 调用示例

```bash
node "<skillDir>/scripts/tapd-api.mjs" status
node "<skillDir>/scripts/tapd-api.mjs" list bug --field current_owner=邱子鉴 --limit 10
node "<skillDir>/scripts/tapd-api.mjs" get bug 1168880148001266165 --comments 5
node "<skillDir>/scripts/tapd-api.mjs" count story --field status=open
node "<skillDir>/scripts/tapd-api.mjs" create story --name "新需求" --field owner=邱子鉴
node "<skillDir>/scripts/tapd-api.mjs" update bug 1168880148001266165 --field status=resolved
node "<skillDir>/scripts/tapd-api.mjs" comment bug 1168880148001266165 --description "<p>已修复</p>"
```

## ⚠️ 高危操作确认

`create` / `update` / `comment` 属于普通写操作，可直接执行；但**删除、批量修改（一次影响多条记录）、以及一切 `raw` 的 POST** 必须先向用户展示操作摘要并确认。`raw` 的写/删除路径**强制**带 `--confirm`，否则 CLI 直接拒绝。

- 写字段白名单由 CLI 校验：`name` / `title` / `description` / `owner` / `current_owner` / `priority` / `severity` / `status` / `module` / `release_id` / `iteration_id` / `begin` / `due` / `effort` / `label` / `parent_id` 等。白名单外一律拒绝，不要绕过去手写请求。
- `description` 是 TAPD 富文本（HTML）：只做局部增补，保留原有图片 / 附件标记。
- 写操作完成后要**回读确认**（`get` 一次），不要假定成功。

## 已从真机事故固化的坑

1. 翻页只能用 `page`；传 `offset` 会被忽略、永远返回第 1 页 —— CLI 直接拒绝 `offset`。
2. 缺陷负责人字段是 `current_owner`；需求才是 `owner`。传错字段 TAPD 会**静默忽略并返回全项目数据**。
3. 负责人值形如 `邱子鉴;` / `邱子鉴;蒋小川;`，查询时不要带分号。
4. 不存在的路径会返回 HTTP 200 + `"Hello world from TAPD API"`（看起来像成功）—— CLI 当成「接口不存在」报错。
5. 19 位长 ID 必须当字符串传，不要做数字运算。
6. 状态码要翻译：`rejected` = 主干待回归（不是「拒绝」）、`status_1` = 无效关闭、`status_8` = 分支待回归。

## 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| `TAPD 拒绝了凭据（HTTP 401/403）` | 环境变量/凭据文件覆盖了随包账号且值不对 | 检查覆盖的键，或清空后重跑 `status` |
| `接口不存在：… Hello world` | Open API 路径写错 | 用 `raw` 时按开放平台文档核对路径 |
| `请求失败（网络或超时）` | 内网到 api.tapd.cn 不通 | 检查网络，或用 `--base` 指向可达地址 |
| `不允许写字段「x」` | 字段名拼错 | 用 `fields <kind>` 查真实字段，白名单外不要硬写 |
