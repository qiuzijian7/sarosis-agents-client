---
name: saroasis-platform
description: 萨罗斯管理平台（SaroasisStudioSystem / TAPD workspace 68880148）的只读查询脚本 —— 缺陷/需求的计数、列表、聚合、单条详情与评论、成员查人、状态码翻译、TAPD 链接。所有接口坑（page 翻页、current_owner、状态码、Hello world 假成功、206MB 大接口）都已固化在脚本里。查平台数据时优先用它，不要手写 Invoke-RestMethod。
version: 1.0.0
platforms: [win32, darwin, linux]
user-invocable: false
disable-model-invocation: false
---

# 萨罗斯管理平台查询脚本

只读、零依赖（Node 18+）。脚本在本技能目录下：`scripts/studio.mjs`。
**调用方式**（pwsh，路径用加载本技能时给出的 Base directory 拼）：

```powershell
node "<Base directory>\scripts\studio.mjs" <命令> [参数]
```

> 若中文乱码，在命令前加 `[Console]::OutputEncoding=[Text.Encoding]::UTF8;`

## 命令

| 命令 | 用途 | 说明 |
|---|---|---|
| `ping` | 平台在线 + 部署版本 | 第一次用先跑它 |
| `me [--alias 企微账号 \| --set 中文名]` | 查看 / 设置「我」 | 设好后 `--owner me` 可用；存在 `~/.vssaros/saroasis-studio.json` |
| `who <关键字>` | 成员表找人 | 中文名 / 企微账号 / 部门 / 职位都能搜 |
| `statuses bug\|story` | 状态码 ↔ 中文 ↔ 分组 | |
| `count bug\|story [筛选]` | **服务端计数**，~100ms | 回答"有多少"一律用它 |
| `stats bug\|story --by <维度> [筛选]` | 聚合 | `status` 走计数接口（精确）；其它维度取最新 `--max`（默认 3000）条聚合，不全会明确提示 |
| `list bug\|story [筛选] [--limit 50] [--links]` | 列表（markdown 表） | `--out x.json` 写全量文件；`--order "modified desc"` |
| `get bug\|story <单号> [--comments [N]] [--full]` | 单条详情 + 评论 | 描述 HTML 已转纯文本 |
| `url bug\|story <单号…>` | TAPD 链接 | |

维度（`--by`）：`status` / `owner` / `priority` / `severity` / `module` / `reporter` / `day` / `month` / `release`

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
node $S who zijianqiu                       # 企微账号 → TAPD 中文名
node $S me --alias zijianqiu                # 记住「我」（只需一次）
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
6. `/api/tapd/<不存在的路径>` 返回 `"Hello world from TAPD API"`（`status:1`，看起来像成功）—— 脚本当作错误。
7. 全项目缺陷 20 万+ 条，统计一律走 `/count`，不要拉全量。
8. `/api/bugs/by-team` ≈ 206 MB，脚本不碰，你也不要碰。
9. 缺陷优先级有两套值：手工单 `高/中/低`、自动化单 `high/medium/low`（`--priority` 只匹配给定的那一个）。

## 边界

- **只读**。改字段、发评论、流转状态 → 用 `tapd-skill`。
- 平台没有"当前页面在看什么"的接口，也不能操作用户的页面；需要口径时让用户贴地址栏链接或说明筛选条件。

## 自检（维护者）

```powershell
node "<Base directory>\test\run-studio-check.mjs"   # 离线（假 fetch），33 项
```
