---
name: saroasis-platform
description: TAPD Open API 只读查询脚本（GR 项目 workspace 68880148）—— 缺陷/需求的计数、列表、聚合、单条详情与评论、状态码翻译、TAPD 链接。所有接口坑（page 翻页、current_owner、状态码、Hello world 假成功）都已固化在脚本里。查 TAPD 数据时优先用它，不要手写 Invoke-RestMethod。
version: 1.1.0
platforms: [win32, darwin, linux]
user-invocable: false
disable-model-invocation: false
tier: extended
---

# TAPD Open API 只读查询脚本

只读、零依赖（Node 18+）。**直连 `https://api.tapd.cn`**，不再经过内网管理平台代理；脚本在本技能目录下：`scripts/studio.mjs`。
**调用方式**（pwsh，路径用加载本技能时给出的 Base directory 拼）：

```powershell
node "<Base directory>\scripts\studio.mjs" <命令> [参数]
```

> 若中文乱码，在命令前加 `[Console]::OutputEncoding=[Text.Encoding]::UTF8;`

## 凭据（随包，开箱即用）

- 安装包自带 TAPD 接入应用（`TAPD_CLIENT_ID` + `TAPD_CLIENT_SECRET`），**无需登录、无需个人访问令牌**；每次请求自动带 `Authorization` 与 `Accept: application/json`。
- 覆盖顺序：环境变量 > `<DSH_HOME>/tapd.env`（或 `TAPD_ENV_FILE` 指向的文件）> 随包账号。可覆盖键：`TAPD_CLIENT_ID` / `TAPD_CLIENT_SECRET`、`TAPD_API_USER` / `TAPD_API_PWD`、`TAPD_API_TOKEN`、`DSH_SUPERAGENT_TAPD_*`。
- 停用随包账号：`DSH_SUPERAGENT_TAPD_BUNDLED=off`。
- 其它配置：`TAPD_WORKSPACE_ID`（默认 68880148）、`TAPD_API_BASE`（默认 https://api.tapd.cn）、`TAPD_ME`（「我」的中文名）。
- 凭据只用于构造请求头，脚本输出**不含明文密钥**；先跑 `ping` 可验证连通性与当前凭据。

## 命令

| 命令 | 用途 | 说明 |
|---|---|---|
| `ping` | TAPD 连通性 + 当前凭据 | 第一次用先跑它（`/quickstart/testauth`） |
| `me [--set 中文名]` | 查看 / 设置「我」 | 设好后 `--owner me` 可用；存在 `~/.vssaros/saroasis-studio.json` |
| `statuses bug\|story` | 状态码 ↔ 中文 ↔ 分组 | |
| `count bug\|story [筛选]` | **服务端计数**，~100ms | 回答"有多少"一律用它 |
| `stats bug\|story --by <维度> [筛选]` | 聚合 | `status` 走计数接口（精确）；其它维度取最新 `--max`（默认 3000）条聚合，不全会明确提示 |
| `list bug\|story [筛选] [--limit 50] [--links]` | 列表（markdown 表） | `--out x.json` 写全量文件；`--order "modified desc"` |
| `get bug\|story <单号> [--comments [N]] [--full]` | 单条详情 + 评论 | 描述 HTML 已转纯文本 |
| `url bug\|story <单号…>` | TAPD 链接 | |

维度（`--by`）：`status` / `owner` / `priority` / `severity` / `module` / `reporter` / `day` / `month` / `release`

> `who` 与 `me --alias` 已下线：成员表是已移除的内网平台代理私有接口，TAPD Open API 没有对应能力。需要找人时直接问用户 TAPD 中文名，用 `me --set` 记住。

## 筛选参数

| 参数 | 含义 |
|---|---|
| `--owner <中文名\|me>` | 缺陷自动用 `current_owner`、需求用 `owner`；模糊匹配，多负责人的单也能命中 |
| `--status <分组\|码\|中文>` | 分组：`open`（= 全部 − done）/ `todo` / `regress` / `suspended` / `done`；逗号多选 |
| `--since` / `--until YYYY-MM-DD` | 按创建时间（含首尾） |
| `--q <关键字>` | 标题模糊匹配 |
| `--severity` `--priority` `--module` `--reporter` `--release` `--iteration` | 原样透传 |
| `--param key=value` | 其它 TAPD 字段（可重复） |

缺陷状态分组：`todo` = 新建/修复中/重新打开 · `regress` = 已修复/分支验证完成/分支待回归/**主干待回归**（`rejected`）· `done` = 已完成/验收完成/主干验收完成/无效关闭（`status_1`）。

## 常用配方

```powershell
$S = "<Base directory>\scripts\studio.mjs"
node $S ping
node $S me --set 邱子鉴                        # 记住「我」（只需一次）
node $S count bug --owner me --status todo  # 我名下待处理多少
node $S list  bug --owner me --status todo --links
node $S stats bug --by status --owner me    # 我的单按状态
node $S stats bug --by owner --since 2026-10-20 --status todo --top 15
node $S get   bug 1168880148001266165 --comments 5
```

## 输出约定

- 每次结果最后一行是 **`> 口径：GET …`**（接口 + 参数 + 数据时间）—— 回答里的数字要能指回这一行。
- 失败以 `✗` 开头、退出码 1，消息里写了原因和下一步；**按提示处理，不要换别的方式绕**。
- 单次输出上限约 120 KB，超了会截断并提示；大结果用 `--out 文件.json`。

## 已固化在脚本里的坑（不需要你再处理，但要知道为什么）

1. 翻页只能用 `page`；`offset` 被服务端忽略、永远返回第 1 页（曾把 200 条重复 40 次当成 8000 条）。脚本禁止传 `offset`。
2. 默认排序是 id 正序（2024 年老单）；脚本默认 `order=created desc`。
3. 缺陷负责人字段是 `current_owner`；`owner=` 会被**静默忽略**并返回全项目数据。脚本禁止对缺陷传 `owner`。
4. 负责人值形如 `邱子鉴;` / `邱子鉴;蒋小川;`，查询时不要带分号（带了反而少：459 → 386）。
5. 状态码必须翻译：`rejected` = 主干待回归（不是"拒绝"）、`status_1` = 无效关闭、`status_8` = 分支待回归。
6. 不存在的 Open API 路径返回 `"Hello world from TAPD API"`（`status:1`，看起来像成功）—— 脚本当作错误。
7. 全项目缺陷 20 万+ 条，统计一律走 `/count`，不要拉全量。
8. 19 位长 ID 必须按字符串处理，不要做数字运算。
9. 缺陷优先级有两套值：手工单 `高/中/低`、自动化单 `high/medium/low`（`--priority` 只匹配给定的那一个）。

## 边界

- **只读**。改字段、发评论、流转状态 → 用 `tapd-skill` 的 Open API CLI（同一套随包凭据）。
- 不能操作用户的页面；需要口径时让用户贴地址栏链接或说明筛选条件。

## 自检（维护者）

```powershell
node "<Base directory>\test\run-studio-check.mjs"   # 离线（假 fetch）
```
