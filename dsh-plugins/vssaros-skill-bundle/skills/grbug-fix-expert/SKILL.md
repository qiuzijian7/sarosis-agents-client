---
name: grbug-fix-expert
description: "GRBug 修复专家：从 TAPD 缺陷单驱动一次完整的修复。适用于 GR/TAPD bug 单、Crash 签名、EXCEPTION_ACCESS_VIOLATION、性能 trace/utrace、日志分析、P4 new pending changelist、修复报告。串起取单 → 证据下载 → 根因分析 → 修复 → HTML 报告 → P4 checkout 与 CL 命名六个阶段；不适用于 TAPD 需求/任务/迭代管理、TAPD 后台配置、流水线配置。"
activation: auto
match: ["GRBug", "TAPD bug", "缺陷单", "复制源码关键字", "EXCEPTION_ACCESS_VIOLATION", "crash 日志", "utrace", "性能 trace", "pending changelist", "P4 CL 描述", "修复报告"]
category: development
recommended_tools: ["pwsh", "read", "write", "skill_search", "read_skill"]
tier: extended
---

# GRBug 修复专家

一个 GR/TAPD 缺陷单进来后，按六个阶段推进。**每一步都先确认产物落盘，再进入下一步**；拿不到的证据、连不上的内网系统、没跑过的验证，一律在报告里写明，不推断、不编造。

## 流程总览

| 阶段 | 输入 | 动作 | 产物 |
|---|---|---|---|
| ① 取单 | TAPD bug 号 / 链接 / 「复制源码关键字」文本 | `tapd-skill` 取详情与评论；`keyword.mjs` 解析关联串 | `keyword.json` |
| ② 证据 | bug 描述里的异常详情地址、附件 URL | `evidence.mjs` 下载日志 / trace 到会话工作区 | `grbug-evidence/bug-<id>/` + `evidence.json` |
| ③ 分析 | 日志 / 堆栈 / trace | Crash 看模块+偏移+调用栈；性能问题先看 trace 是否落地 | 根因结论（写进报告） |
| ④ 修复 | 根因 | 改代码、编译/复现验证 | 改动文件列表 |
| ⑤ 报告 | ①–④ 产物 | `report.mjs` 渲染自包含 HTML | `reports/grbug-<id>.html` |
| ⑥ P4 | 关键字描述 + 改动文件 | `p4-cl.mjs` 新建 pending CL、签出文件 | 新 pending changelist |

## ① 取单与「复制源码关键字」

TAPD 详情页右上角菜单 →「复制源码关键字」，得到形如：

```
--bug=1281129 --user=邱子鉴 【Crash】【release】【影响设备数:1】EXCEPTION_ACCESS_VIOLATION_WRITE ntdll.dll pc 0x48389 RtlTryAcquireSRWLockExclusive (:0)[amd64:Windows https://www.tapd.cn/68880148/s/5967448
```

先读单子，再解析关键字：

```bash
node "<tapdSkillDir>/scripts/tapd-api.mjs" get bug <单号> --comments 20
node "<skillDir>/scripts/keyword.mjs" "<复制得到的整段文本>"
```

`keyword.mjs` 输出 `bug / user / workspace / tags / title / crash / description`；`description` 是规范化后的 P4 CL 描述（保留 `--bug=` 关联，去掉末尾短链）。**没有这段文本时**，用 `get` 返回的 `title`、`creator`、单号与页面 URL 自行拼成同格式，并在报告里注明「关键字为拼装，非菜单原始值」。

`crash: true` ⇒ 按崩溃单走；`tags` 含 `release`、标题含 `EXCEPTION_`/`ACCESS_VIOLATION` ⇒ 优先找堆栈与模块偏移。

## ② 证据下载（日志 / 附件 / Trace）

bug 描述里的「异常详情地址」、评论与附件是证据来源。先拿附件 URL（TAPD Open API 的附件接口，走 `raw`，只读）：

```bash
node "<tapdSkillDir>/scripts/tapd-api.mjs" raw GET /files/get_files --entry_type bug --entry_id <单号>
node "<skillDir>/scripts/evidence.mjs" --bug <单号> --url "<附件或日志 URL>" --url "<另一个 URL>"
```

- 脚本按扩展名/URL 归类 `log` / `trace` / `other`，落盘到**会话工作区** `grbug-evidence/bug-<id>/`，记录大小与 sha256。
- **性能问题**：`.utrace` / `.etl` / `.perfetto` 这类 trace 必须下载到本地；脚本只落地与登记，**不做二进制解析**。分析用 UnrealInsights / WPA / 项目自带的 trace 分析脚本，把结论填进报告的 `traceConclusion`。仓库里没有通用 `.utrace` 分析器，不要假设它存在。
- **CrashSight / crash-reporting 内网报表需要登录态**：脚本不带 cookie，也不会伪造数据。下载失败会记 `ok:false` + `reason`，并生成 `manual` 提示。此时请人工在浏览器导出报表/日志到同一目录，再继续；报告里必须写明「该证据由人工导出」。

## ③ 根因分析

- Crash：`EXCEPTION_ACCESS_VIOLATION_WRITE` + `ntdll.dll!RtlTryAcquireSRWLockExclusive` 这类签名先判断是野指针/已释放锁/多线程竞争，而不是直接给「加锁」结论；结合源码与调用栈定位，必要时用 `systematic-debugging`。
- 性能：先看 trace 是否真的落盘（`evidence.json.perf`）；没有 trace 就明确写「缺 trace，结论待补」，不要用猜测填性能数字。
- 输出一句话根因 + 支撑证据文件名，作为报告 `analysis`。

## ④ 修复与验证

改动文件逐个记录绝对路径；编译、复现、回归至少说明跑了哪一条、结果如何。**没验证就写「未验证」**，报告第 5 节会原样呈现。

## ⑤ 生成 HTML 报告

把 ①–④ 汇总成 JSON（字段全可选，缺失显示「未提供」）：

```json
{ "bug":"1281129", "user":"邱子鉴", "title":"…", "url":"…", "tags":["Crash"], "crash":true,
  "evidence":{"items":[…],"manual":[…]}, "analysis":"…", "traceConclusion":"…",
  "fix":{"files":["…"],"summary":"…"}, "verification":"…", "changelist":12345 }
```

```bash
node "<skillDir>/scripts/report.mjs" --input <summary.json> --out reports/grbug-1281129.html
```

报告是单文件、UTF-8、无外部依赖，包含单子信息、证据表、根因、修复、验证、CL 与已知限制。

## ⑥ P4 checkout 与 new pending changelist

**CL 描述 = ① 解析出的 `description`**（即「复制源码关键字」提取的内容，保留 `--bug=<id>`）。默认 dry-run，确认后加 `--execute`：

```bash
node "<skillDir>/scripts/p4-cl.mjs" --description "<keyword.description>" --file "<改动文件>" --dry-run
node "<skillDir>/scripts/p4-cl.mjs" --description "<keyword.description>" --file "<改动文件>" --execute
```

执行链：`p4 change -o` → 替换 `Description:` → `p4 change -i` 建新 CL → `p4 edit -c <CL> <file>` 签出 → `p4 opened -c <CL>` 复核。

纪律：
- 只走 guarded p4 白名单（`change -o/-i`、`edit`、`reopen`、`opened`）；**绝不 `p4 submit`**，也不带 `change -f/-u/-U/-t`。
- 只签出本单实际修改的文件；不在 `DSH_SUPERAGENT_P4_PATHS` 允许路径内的文件不要签出。
- 创建 CL 失败或解析不出 CL 号时，如实报出并提示用 `p4 opened -c <CL>` 检查，不要重复创建。

## 已知限制（不要越界承诺）

- 无 CrashSight / `crash-reporting` 客户端、无 minidump/pdb 符号解析、无通用 `.utrace`/`.etl` 分析器；这些环节是**人工步骤或外部工具**。
- 无模型级 `tapd_get_bug` / `trace_analyze` / `p4_new_cl` 工具；本技能用 `tapd-skill` CLI 与随包脚本完成，工具名均真实存在。
- 「复制源码关键字」是 TAPD 页面菜单产物，API 不返回该文本；拿不到时按 ① 拼装并注明。
- 证据/报告一律写会话工作区，不写技能目录、不写宿主安装目录。
- 本技能不提交代码、不改 TAPD 状态、不发评论；需要时由人确认后单独执行。

## 自检

```bash
node "<skillDir>/scripts/keyword.mjs" --self-test
node "<skillDir>/scripts/evidence.mjs" --self-test
node "<skillDir>/scripts/p4-cl.mjs" --self-test
node "<skillDir>/scripts/report.mjs" --self-test
```
