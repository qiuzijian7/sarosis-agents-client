# Unreal 内置工具（`unreal_*`）

> **一句话**：Agent Studio 内置的 **7 个 `unreal_*` 工具**，让 LLM 直接驱动本机 Unreal Editor —— 执行编辑器内嵌 Python、内省 `unreal` API、反射导出对象属性、触发 C++ 构建（Live Coding / UBT）、检索 AssetRegistry。实现上只是编辑器侧 `BunnySeekAgent` 插件 bridge 的 HTTP 客户端（默认 `http://127.0.0.1:8765`），**跨机器无需任何路径配置**。
>
> 本文档分两部分：**一、简介**（对比其他方案存在的问题，以及我们如何解决）；**二、使用说明**（详细操作步骤）。

---

## 一、简介

### 1.1 它是什么

```
┌──────────────────────┐        HTTP (127.0.0.1:8765)        ┌────────────────────────────┐
│  Agent Studio        │                                     │  Unreal Editor 进程        │
│  （工具在 IDE 进程内）│                                     │                            │
│  unreal_health       │──── GET  /bridge/health         ───▶│  BunnySeekAgent 插件       │
│  unreal_exec         │──── POST /bridge/exec           ───▶│  + Python Editor Script    │
│  unreal_wait         │──── POST /bridge/wait_probe     ───▶│    Plugin                  │
│  unreal_help         │──── POST /bridge/help           ───▶│  + EditorScriptingUtilities│
│  unreal_dump         │──── POST /bridge/dump           ───▶│                            │
│  unreal_build        │──── POST /bridge/build          ───▶│  内嵌 Python 解释器        │
│  unreal_find_asset   │──── POST /bridge/find_asset     ───▶│  （GameThread 上执行）     │
└──────────────────────┘                                     └────────────────────────────┘
```

**关键设计点**：

- **不是 MCP，是 REST**：7 个工具本质是「**连接 + 执行 + 等待 + 内省**」四个原语的封装；真正的业务能力由运行时写出的 Python 决定。
- **统一 `callBridge`**：把「调用方 AbortSignal」与「工具自身超时计时器」合并为一个 `AbortController`，上层取消或工具超时都能干净中止，**不会挂死**。
- **失败不抛异常**：连接失败 / HTTP 错误 / 超时全部转成可读文本返回，对话不中断，LLM 据此可自行判断要让使用者打开编辑器。
- **传输分流**：优先走主进程 IPC（`vscode:webFetch`，用 Chromium `net.fetch`，避免打包版 CORS 拦截），无 IPC 时回退 renderer `fetch`。
- **可见性可靠**：工具集登记为 toolset `unreal`（`priority: Always`、`prefixes: ['unreal_']`、`deferrable: false`），**不受工具折叠与 focus 模式收窄影响**。

**7 个工具与默认超时**：

| 工具 | 端点 | 默认超时 | 一句话用途 |
| --- | --- | --- | --- |
| `unreal_health` | `GET /bridge/health` | 5s | Bridge 是否可达（状态 / 项目名 / PID / uptime） |
| `unreal_exec` | `POST /bridge/exec` | 120s | 在编辑器内嵌 Python 解释器（GameThread）上执行代码 |
| `unreal_wait` | `POST /bridge/wait_probe` | 最长 1800s | 等异步条件/日志，**不阻塞 GameThread** |
| `unreal_help` | `POST /bridge/help` | 30s | 内省 `unreal` 模块（docstring / 成员 / 签名） |
| `unreal_dump` | `POST /bridge/dump` | 60s | 反射递归导出对象全部编辑器属性为 JSON |
| `unreal_build` | `POST /bridge/build` | 900s | `live_coding` 热重载 或 `ubt` 完整构建 |
| `unreal_find_asset` | `POST /bridge/find_asset` | 60s | 检索 AssetRegistry（名称 / 路径 / 类型） |

> Agent 侧还配套一个 **聊天专用工具卡片**：`unreal_exec` 会以「执行代码」预览形式展示、卡片带 `UNREAL` 徽章、结果可折叠展开。

### 1.2 其他方案存在的问题

| 方案 | 存在的问题 |
| --- | --- |
| **让模型直接写 C++ / 手工改资产（无运行时通道）** | ① 无运行时反馈：改完不知道对象真实属性、不知道 API 真实签名，只能靠记忆臆造（Unreal Python/C++ API 面积极大，**幻觉类名/方法名错误率很高**）；② 改错了要重新编译 + 重开编辑器才知道；③ 读不到 Editor 内当前状态（关卡/资产/属性）。 |
| **在编辑器里手工点、手工跑脚本** | ① 无法与 LLM 的推理链路闭环，Agent 只能「说」不能「做」；② 每次都要人肉搬运命令行与参数；③ 长时任务（构建/导入）没人盯着，失败信息也拿不到。 |
| **命令行/自建脚本（UAT / UBT / `UnrealEditor-Cmd` / 独立 Python）** | ① 只能在编辑器**外部**跑，看不到编辑器内的实时状态，也无法直接操作已加载的关卡/资产；② 需要自己维护引擎路径与版本，跨机器要重新配；③ 输出是原始日志，Agent 需要额外解析；④ 编辑器内嵌解释器能做到的事（`EditorLevelLibrary`、Subsystem）在外部脚本里要绕路。 |
| **UE 官方 Unreal MCP（UE 5.8，`ModelContextProtocol`）** | ① 官方明确标注 **Experimental**，许多功能不完整、API 与数据格式随时可能变更；② 能力**受限于已注册的 Toolset**（SceneTools / ActorTools / MaterialInstanceTools…），未覆盖的能力要自己写 Toolset 并 `RefreshTools` 才能用；③ 数百个工具 schema 体积大，依赖内置 Tool Search 折叠缓解，否则上下文被撑爆；④ 所有 Tool 在 GameThread **串行**执行且未暴露分级超时机制；⑤ 无状态调用，跨次无法复用上下文变量；⑥ 主要面向「在其他 MCP 客户端里复用」，与本项目工作流集成需要额外配置。 |
| **通用代码 Agent 工具（grep / read_file / 文件扫描）面对 UE 巨型仓库** | ① UE 工程是 GB 级（引擎源码 + `Content` 资产 + `ThirdParty` 副本），全根 grep 实测**反复 60s 超时**（日志证据：双仓库 root 全量 rg 60s × 6 超时）；② 二进制资产（`.uasset` / `.umap`）无法被文本工具命中，视觉资产信息（`.uasset` 里的蓝图/网格）在文本层完全不可见；③ `Content`、`ThirdParty` 里的内容 grep 出来也没有价值。 |

### 1.3 我们如何解决

| 上游问题 | 我们的解法 |
| --- | --- |
| 无运行时反馈、幻觉 API | **两个专门的内省原语**：`unreal_help` 在编辑器内反射 `unreal` 模块的真实 docstring / 成员 / 签名（大类配 `filter` 收敛）；`unreal_dump` 用反射元数据递归导出对象的**每一个可达编辑器属性**（含手工 `get_editor_property` 循环容易漏掉的嵌套 USTRUCT）。工具描述里明确要求「**不确定 API 形状时先 help 再 exec**」—— 即「**先内省，后执行**」的黄金法则。 |
| 只能在编辑器外跑脚本 | **直接在编辑器进程内执行**：`unreal_exec` 跑在编辑器内嵌 Python 解释器的 **GameThread** 上，`unreal` 模块已预导入，可以直接操作已加载的关卡/资产/Subsystem。 |
| 跨机器要重新配引擎路径 | **零路径配置**：工具只知道 bridge 的 HTTP 地址（默认 `127.0.0.1:8765`），**不需要知道插件装在哪、引擎装在哪**，跨机器只改一个 URL 设置。 |
| 改完不知道错误 → 长时任务没人盯 | **分级超时 + 请求可中止**：health 5s / help 30s / dump、find_asset 60s / exec 120s / build 900s / wait 1800s，全部与调用方 AbortSignal 合并，超时与取消干净退出而非挂死。 |
| 「等一会儿」把编辑器冻住 | **`unreal_wait` 独立等待通道**：提供 `condition`（Python 表达式轮询）与 `log_pattern`（新增日志行正则）两条探测路径，谁先满足谁生效，超时预算默认 300s、最大 1800s —— **把等待从 GameThread 挪到轮询探针上，编辑器在等待期间保持可响应**。这是相对「在 exec 里 sleep」的核心优势（工具描述里也明确禁止 exec 内 sleep/忙等）。 |
| 长任务产物需要人工解析 | **`unreal_build` 双模式**：`live_coding` 编译 + 热重载 C++ 改动（秒级~分钟级，日常首选）；`ubt` 走完整 UnrealBuildTool 构建（保留 900s 超时）。两者都由工具直接触发并把结果文本化返回给模型。 |
| 二进制资产文本工具看不见 | **`unreal_find_asset` 走 AssetRegistry**：按名称/路径/类名检索视觉资产（Blueprint / StaticMesh…），补上「文本层看不到资产」的缺口。 |
| UE 巨型仓库把通用工具拖垮 | **UE 形态感知的多重防护**（1.5 节）：运行时 grep 对 UE 根自动叠加 `Content` / `ThirdParty` / `Documentation` / `Templates` / `FeaturePacks` / `Samples` / `Automation` 排除；`search_code` 在「UE 形态根 + 无任何收窄参数」时**直接拒绝全根扫描**并引导带 `path` / `filePattern` / `project` 重发；索引侧提供 UE 专用排除模板（`Binaries` / `Intermediate` / `Saved` / `DerivedDataCache`…）。 |
| 工具被折叠/收窄后「消失」 | **toolset 登记为 Always**（2026-09-21 修复）：此前 `unreal_` 未登记 → 兜底归 `utility`（Low + deferrable）→ 被 focus 模式整条剔除（日志实证 `tool_describe "unreal_exec" → Tool not found`）。现取 `Always` 的理由：UE 工具是**用户显式意图**（在 UE 项目里让 LLM 驱动编辑器），且 Always 不占 `MAX_VISIBLE_TOOLS` 软上限。 |

**仍然存在的取舍（诚实标注，不回避）**：

- **schema 弱**：`unreal_exec` 的 `code` 只是一个 string，没有参数结构 —— 模型不知道该传什么，错误只能靠运行时反馈。缓解手段是 `unreal_help` 内省（见 1.4 与官方 MCP 的定位差异）。
- **无限能力的代价是安全风险**：`unreal_exec` 等同授予编辑器内**完全 Python 权限**，无认证层（仅本机绑定 + 需要编辑器已启用插件）。请在受控环境使用，工具集本身不提供写操作审批。
- **只面向 Agent Studio**：非标准 MCP 客户端（Claude Code / Cursor 等）无法复用本工具集 —— 这类场景请改用官方 MCP（两者可并存，见 2.7）。

### 1.4 与 UE 官方 Unreal MCP 的定位差异

Epic 在 **UE 5.8** 引入官方 Unreal MCP（引擎内标识 `ModelContextProtocol`），把 MCP server **内嵌在编辑器进程**里，默认 `http://127.0.0.1:8000/mcp`。两者不是替代关系，而是**两种哲学**：

| | 本项目 `unreal_*`：**通用执行器** | 官方 Unreal MCP：**结构化能力目录** |
| --- | --- | --- |
| 本质 | 把编辑器当作**可编程 REPL**（连接/执行/等待/内省四原语） | 把编辑器功能**逐项声明为带类型的 Tool**（Toolset Registry） |
| 工具数量 | 固定 **7 个**（通用元工具） | **数百个**（动态提供），依赖 Tool Search 折叠控制体积 |
| 能力边界 | **无限**（受限于 Python API，不限于工具定义） | 受限于已注册 Toolset；未覆盖需自写 Toolset + `RefreshTools` |
| 未覆盖时怎么办 | 直接写 Python 绕过 | 写 Toolset 才能扩展 |
| schema 质量 | **弱**（`code` 是 string，无参数结构/校验） | **强**（类型提示 + docstring 自动反射为 JSON Schema） |
| 工具发现 | `unreal_help` / `unreal_dump` 运行时反射内省 | `list_toolsets` / `describe_toolset` / `call_tool` 三个元工具 |
| 线程与超时 | exec 在 GameThread；`unreal_wait` 轮询**不占 GameThread**；**分级超时 5s~30min** + 外部 signal 合并 | 全部 GameThread **串行**；未暴露等价分级超时 |
| 状态 | exec 命名空间**跨调用持久**（Jupyter 风格，可 `reset`） | 无状态调用 |
| 客户端 | 仅 Agent Studio 内置可用 | **任意 MCP 客户端**（Claude Code / Cursor / VS Code / Gemini / Codex / MCP Inspector） |
| 成熟度 | 稳定实现 | **Experimental**（功能不完整、API 可能变更） |
| cooked build | 否（需编辑器） | **可**（runtime 模块能在打包版本启动 server） |
| 安全模型 | 任意代码执行（等同完全 Python 权限） | 受限 Tool 集合（同样无认证层，仅本机绑定） |

> **两者都选择了「元工具 + 按需发现」对抗上下文膨胀**：官方默认 `bEnableToolSearch = true` 只广告 3 个元工具；本项目用 `unreal_help`「按需查 API」替代「预先把所有 Unreal API 塞进提示词」。
> 能力覆盖上：官方点名的能力（生成 Actor、配光、材质实例、Slate 检查、自动化测试）本项目都能**经 `unreal_exec` 曲线达成**；而**资产检索 / C++ 构建热重载 / 反射式属性导出**三项本项目有原生专用工具（`unreal_find_asset` / `unreal_build` / `unreal_dump`）。
> 完整 20 项对照表与选型建议见 `docs/Unreal工具使用说明.html` §6、§7。

### 1.5 与其它子系统的联动（UE 感知）

| 联动点 | 行为 | 证据 |
| --- | --- | --- |
| 运行时搜索排除 | 搜索根探测为 UE 形态（直下/一层子目录含 `Engine/` 或 `*.uproject`）时，自动叠加 `**/Content/**`、`**/ThirdParty/**`、`Documentation`、`Templates`、`FeaturePacks`、`Samples`、`Automation` 排除（**不排除 `Source` / `Plugins`**） | `browser/providers/tool/searchHelpers.ts` `UNREAL_EXTRA_EXCLUDE_GLOBS` |
| `search_code` 全根预检 | 搜索根是 UE 形态且未带 `path` / `filePattern` / `project` 时**拒绝执行**，返回引导文案（避免 60s 超时烧预算） | `browser/providers/tool/codebaseTools.ts` |
| 索引排除模板 | 项目模板 `unreal`（markers：`*.uproject`、`Engine`、`Binaries`、`Intermediate`）推荐 UE 排除清单；`UNREAL_EXCLUDE_DIRS`（Binaries / Intermediate / Programs / Saved / DerivedDataCache / ThirdParty / Plugins / Content / Config / Build） | `common/codebaseProjectTemplates.ts`、`common/codebaseIndexDefaults.ts` |
| 超大工程判定 | `_detectLargeProject` 命中 unreal 即判为「超大工程」，索引/检索给出对应提示 | `browser/providers/tool/codebaseTools.ts` |
| C++ 无 LSP 兜底 | 项目不含 clangd/cpptools 时，基于 tree-sitter 图谱注册 `cpp` 的「跳转定义 / 查找引用」，让 C++ 代码导航不依赖语言服务器 | `browser/codebaseGraphLanguageFeatures.contribution.ts` |
| focus 模式信号 | `CODE_PROJECT_MARKERS` 已声明 `*.uproject` → 'Unreal Engine'、`*.uplugin` → 'Unreal Engine plugin' 信号（当前只收集信号） | `common/focusMode.ts` |
| 结果预览修复 | `unreal_help` / `unreal_dump` 的 JSON 结果在卡片摘要里专门处理首个 `{` | `browser/toolResultPreview.ts` |

---

## 二、使用说明

### 2.1 前置条件（缺一不可）

1. **本机已安装并可运行 Unreal Editor**，且目标工程已用编辑器打开（**工具需要编辑器进程在线**）。
2. 在编辑器中启用以下插件（缺任一都可能导致工具不可用）：

| 插件 | 作用 |
| --- | --- |
| **BunnySeekAgent** | 提供 `/bridge/*` 端点（工具的真正对端） |
| **Python Editor Script Plugin** | 提供内嵌 Python 解释器（`unreal_exec` / `unreal_help` / `unreal_dump` 依赖） |
| **EditorScriptingUtilities** | 提供编辑器脚本 API（资产/关卡操作） |

3. （可选，但与代码类问题强相关）如需让 Agent 也能读代码结构，请对工程建立 Codebase 索引，并把「索引路径」收敛到源码子目录（UE 工程极易超大，详见 `doc/内置Codebase代码图谱-简介与使用说明.md` 的大仓库调优）。

> 上述插件启用后一般需要**重启编辑器**生效；bridge 监听端口以插件实际配置为准（默认 8765）。

### 2.2 配置 Bridge 地址（可选）

默认地址 `http://127.0.0.1:8765`，端口冲突时需要改：

1. 打开 **设置 → 工具配置 → Unreal Engine 工具**（分组图标 🎮，字段名「Bridge 地址」）。
2. 或直接在 `settings.json` 写：

```jsonc
{
  // 留空 = 回退内置默认 http://127.0.0.1:8765
  "sessions.agentStudio.unreal.bridgeUrl": "http://127.0.0.1:9000"
}
```

配置键：`sessions.agentStudio.unreal.bridgeUrl`（默认 `''`）；也接受 `http://localhost:8765` 这类写法，末尾多余的 `/` 会被自动剥离。

### 2.3 第一步永远是自检：`unreal_health`

在聊天里说：

```text
调用 unreal_health 看一下 Unreal bridge 是否在线
```

返回内容包含 status / 项目名 / PID / uptime ⇒ 说明链路通。**任何其它 `unreal_*` 工具失败时，都应先调它定位问题**（工具描述里也这么要求）。

### 2.4 七个工具详解

#### ① `unreal_health`（5s 超时，无参数）

```json
{}
```

检查 Bridge 可达性。使用 `_no_params` 占位属性（部分模型网关要求 object 至少一个属性，空 `properties: {}` 会被判为不兼容）。

#### ② `unreal_exec`（120s 超时，`code` 必填）

在编辑器内嵌 Python 解释器上执行代码（**GameThread**）；**状态跨调用持久**（Jupyter 风格），最后一个裸表达式的 `repr` 会被回显；`unreal` 已预导入。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `code` | string | ✅ | 要执行的 Python 源码，可跨多条语句 |
| `reset` | boolean | 可选 | `true` 时先丢弃此前所有全局变量再执行 |
| `timeout_seconds` | integer（min 1） | 可选 | 硬超时秒数，默认 60 |

```jsonc
// 基础：列出当前关卡中的 Actor
{ "code": "acts = unreal.EditorLevelLibrary.get_all_level_actors()\nlen(acts)" }

// 复用上一次调用的变量（状态持久）
{ "code": "[a.get_actor_label() for a in acts[:10]]" }

// 清空状态重新开始
{ "code": "acts = None", "reset": true }
```

> ⚠ **严禁 sleep / 忙等待**：exec 跑在 GameThread 上，阻塞会直接**冻结整个编辑器 UI**。需要等异步条件请用 `unreal_wait`。

#### ③ `unreal_wait`（最长 1800s）

等待异步 Unreal 条件且**不阻塞 GameThread**；`condition` 与 `log_pattern` 二者**谁先满足谁生效**。

| 参数 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| `condition` | string | 可选 | 在 `unreal_exec` 命名空间中求值的 Python 表达式，轮询到为真 |
| `log_pattern` | string | 可选 | 与新增项目日志行匹配的正则 |
| `timeout` | number | 可选 | 总等待预算（秒），默认 300，最大 1800 |
| `poll_interval` | number | 可选 | 探测间隔（秒），默认 2 |

```jsonc
// 等条件成立
{ "condition": "unreal.get_editor_subsystem(unreal.EditorActorSubsystem) is not None", "timeout": 600, "poll_interval": 3 }

// 等日志出现特定行
{ "log_pattern": "Build completed successfully", "timeout": 1200 }
```

#### ④ `unreal_help`（30s 超时）

内省编辑器中的 `unreal` 模块：返回指定符号的 docstring、成员与方法签名；空 `symbol` 返回顶层摘要。

| 参数 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| `symbol` | string | 可选 | 相对 `unreal` 模块的点分路径；空字符串返回顶层摘要 |
| `filter` | string | 可选 | 对成员名做大小写不敏感的子串过滤 |

```jsonc
{ "symbol": "" }
{ "symbol": "unreal.EditorLevelLibrary", "filter": "actor" }
```

> ⚠ Unreal 类动辄数百个成员，**大型类务必带 `filter`**，否则会淹没上下文窗口。不确定 API 形状时**先 help 再 exec**。

#### ⑤ `unreal_dump`（60s 超时，`code` 必填）

利用反射元数据**递归导出** UE 对象/结构体的每一个可达编辑器属性为 JSON（能捕获嵌套 USTRUCT）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `code` | string | ✅ | Python 代码，**最后一条语句必须是要导出的表达式** |
| `depth` | integer | 可选 | 嵌套值的递归深度 |

```jsonc
{ "code": "unreal.EditorLevelLibrary.get_all_level_actors()[0]", "depth": 4 }
```

> ⚠ 若最后一句写成赋值（`a = get_all_level_actors()[0]`）就没有可导出的表达式结果；应直接写表达式本身。

#### ⑥ `unreal_build`（900s 超时，`mode` 必填）

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `mode` | string（enum） | ✅ | `live_coding` = 编译并热重载 C++ 改动；`ubt` = 完整 UnrealBuildTool 构建 |

```jsonc
{ "mode": "live_coding" }   // 日常增量验证首选（秒级~分钟级）
{ "mode": "ubt" }           // 发布前 / 改了构建文件（可达数十分钟，工具侧预留 900s）
```

#### ⑦ `unreal_find_asset`（60s 超时）

在 AssetRegistry 中按名称或路径检索资产。**所有参数均可选**（无参调用返回默认结果集）。

| 参数 | 类型 | 可选 | 说明 |
| --- | --- | --- | --- |
| `name_contains` | string | 可选 | 资产名子串（**bridge 原生参数，优先使用**） |
| `search_term` | string | 可选 | `name_contains` 的别名（转发时映射为 `name_contains`） |
| `name` | string | 可选 | 资产名过滤 |
| `path` | string | 可选 | 包路径过滤，如 `/Game/BluePrints` |
| `class_names` | string[] | 可选 | 限定资产类型 |
| `max_results` | integer | 可选 | 返回命中数量上限 |

```jsonc
// 按路径 + 类型精确检索
{ "path": "/Game/BluePrints", "class_names": ["Blueprint", "StaticMesh"], "max_results": 20 }

// 模糊搜索
{ "name_contains": "Character" }
```

> ⚠ **参数名坑（已修）**：bridge 端要求至少一个 `name` / `name_contains` / `path` 类参数，**不认识 `search_term`** —— 只发 `search_term` 会返回 400（`provide at least one of …`）。现 schema 已补 `name_contains`（推荐），并保留 `search_term` 别名自动映射。

### 2.5 推荐调用序列（黄金法则：先内省，后执行）

1. **`unreal_health`** —— 确认 Bridge 在线，拿到项目名与 PID。
2. **`unreal_find_asset`** —— 定位目标资产，拿到确切路径。
3. **`unreal_help`**（配 `filter`）—— 确认 API 形状，避免凭记忆臆造 API。
4. **`unreal_dump`** —— 读取对象当前完整属性状态。
5. **`unreal_exec`** —— 执行修改。
6. **`unreal_wait`** —— 若改动触发异步任务（构建 / 导入 / 编译），用它等待。
7. **`unreal_build`** —— 需要编译 C++ 时调用。

> 第 3 步是防止「幻觉 API 名」的关键：Unreal Python API 面积极大，模型凭记忆写出的类名/方法名错误率很高，**一次 `unreal_help` 的成本远低于一次失败的 `unreal_exec`**。

**实战示例：批量修改资产属性**

```jsonc
1. unreal_find_asset  { "path": "/Game/Characters", "class_names": ["StaticMesh"], "max_results": 50 }
     → 拿到资产路径列表

2. unreal_help        { "symbol": "unreal.StaticMesh", "filter": "lod" }
     → 确认 LOD 相关 API 的准确名称与签名

3. unreal_dump        { "code": "unreal.load_asset('/Game/Characters/Hero')", "depth": 3 }
     → 查看当前属性值

4. unreal_exec        { "code": "..." }
     → 批量修改

5. unreal_wait        { "log_pattern": "Saved.*Hero", "timeout": 300 }
     → 等待保存完成
```

**可以直接对 Agent 说的话（示例）**：

```text
- 先 unreal_health 确认 Unreal 连上了，然后告诉我当前打开的是哪个工程
- 找出 /Game/Characters 下所有 StaticMesh，列出它们的 LOD 数量
- 帮我把当前关卡里所有 PointLight 的强度改成 2000
- 改完 C++ 后跑 live coding 热重载，并等编译完成的日志
- 我改了这个 MaterialInstance 的参数，dump 一下它现在的全部属性
```

### 2.6 超时分级与错误处理

**超时分级**（设计意图）：

| 工具 | 超时 | 设计意图 |
| --- | --- | --- |
| `unreal_health` | 5s | 健康检查应快速失败 |
| `unreal_help` | 30s | 反射内省，中等耗时 |
| `unreal_dump` / `unreal_find_asset` | 60s | 深递归 / AssetRegistry 查询 |
| `unreal_exec` | 120s | GameThread 执行，不宜过长 |
| `unreal_build` | 900s（15 分钟） | 完整 UBT 构建可达数十分钟 |
| `unreal_wait` | 1800s（30 分钟） | 长时异步等待专用通道 |

**四类错误形态**：

| 场景 | 返回文本 | 应对 |
| --- | --- | --- |
| HTTP 非 2xx | `[Unreal] <tool> failed: bridge returned HTTP <status>.` | 查看附带响应体（含发送 body 前 800 字），通常是 bridge 侧参数校验失败 |
| 工具超时 | `[Unreal] <tool> timed out after Ns.` | 缩小操作范围（减小 `depth`、加 `max_results`），或改用 `unreal_wait` |
| 连不上 Bridge | `[Unreal] <tool> cannot reach the Unreal bridge at <url>` | 启动编辑器并启用 BunnySeekAgent；核对端口配置 |
| 用户/上层取消 | `[Unreal] <tool> cancelled.` | 正常中断，无需处理 |

> 注：走主进程 IPC 通道时**不支持中途 AbortSignal 取消**（主进程 fetch 一旦发起不可中断），长耗时工具靠桥端/主进程各自兜底。

**连接失败排查清单**：

1. Unreal Editor 是否已启动？
2. `BunnySeekAgent` 插件是否已启用？
3. `Python Editor Script Plugin` 与 `EditorScriptingUtilities` 是否已启用？
4. Bridge 实际监听端口是多少？与设置里的 Bridge 地址是否一致？
5. 是否有其它服务占用了 8765 端口？

### 2.7 与官方 Unreal MCP 并存

官方 MCP（默认 `127.0.0.1:8000/mcp`）与本项目 Bridge（默认 `8765`）**监听不同端口，完全可以同时启用**：

- 日常**结构化**操作（生成 Actor、配光、材质实例）走官方 Toolset（schema 强、不易写错）；
- 遇到 **Toolset 未覆盖**、需要**长时异步等待**（`unreal_wait` 30 分钟预算 + GameThread 保护）、或需要**反射式深度排查**（`unreal_dump` 的嵌套 USTRUCT）时，用 `unreal_*` 兜底。

**优先用 `unreal_*` 的场景**：已在 Agent Studio 内工作不想额外配 MCP 客户端；任务需要官方 Toolset 之外的自定义 Python；需要长时等待；需要反射排查；关注上下文体积（仅 7 个工具 schema）。

### 2.8 安全注意事项

- `unreal_exec` **等同授予编辑器内完全 Python 权限**，且**无认证层**（仅本机绑定）。请只在可信环境使用，不要让它执行来源不明的外部内容。
- 工具集**不区分只读/写操作**，也不进入文件写操作审批队列 —— 模型一旦调用即直接转发给 bridge。需要「改前先看」时，请要求 Agent 先 `unreal_dump` 汇报再改（见 2.5 黄金法则）。
- `unreal_build` 会真实触发编译/热重载，可能造成编辑器短暂不可用。

### 2.9 排错速查

| 现象 | 排查 |
| --- | --- |
| 聊天里完全看不到 `unreal_*` 工具 | 确认使用当前版本（toolset `unreal` 登记为 Always 已修复「归 utility 被 focus 剔除」的历史问题）；仍不可见时可在聊天里要求 `tool_describe "unreal_exec"` 验证 |
| 工具返回「cannot reach bridge」 | 按 2.6 排查清单逐项确认（编辑器 / 插件 / 端口） |
| 返回 HTTP 400 | bridge 侧参数校验失败 —— 看返回体提示；`unreal_find_asset` 至少给 `name_contains` / `name` / `path` 之一 |
| 返回 timed out | 收窄范围：减小 `depth`、加 `max_results`、把长任务改走 `unreal_wait` |
| 编辑器界面卡死 | 说明有代码在 GameThread 上睡眠/忙等 —— 改造成 `unreal_exec` 设状态 + `unreal_wait` 等条件 |
| `unreal_help` 输出淹没上下文 | 加 `filter` 收敛成员 |
| `unreal_dump` 没输出 | 检查最后一句是否为表达式（不能是赋值语句） |
| 工具卡片只显示「执行代码」一栏 | 属正常：`unreal_exec` 用专用卡片展示代码预览，展开可见完整结果 |

---

## 附录：源码与文档索引

| 模块 | 路径（相对仓库根） |
| --- | --- |
| 工具实现（7 个工具 + `callBridge`） | `src/vs/sessions/contrib/agentStudio/browser/providers/tool/unrealTools.ts` |
| 注册入口 | `.../browser/providers/tool/builtinToolProvider.ts`（`_registerUnrealTools()`） |
| toolset 分类（Always） | `.../agentStudio/common/toolsetConfig.ts`（`id: 'unreal'`） |
| 设置键与注册 | `.../common/constants.ts`（`AGENT_STUDIO_UNREAL_BRIDGE_URL_SETTING`）、`.../browser/agentStudio.contribution.ts` |
| 设置面板（工具配置 → Unreal Engine 工具） | `.../browser/settingsEditorPane.ts` |
| 聊天工具卡片 | `src/vs/sessions/browser/agentChat/agentChatPanel.unrealCard.ts`、`.toolCards.ts`、`.base.ts`（`TOOL_UNREAL_TOOLS`） |
| 传输通道（主进程 webFetch） | `src/vs/code/electron-main/app.ts`（`vscode:webFetch`） |
| UE 感知：搜索排除 / 预检 | `.../providers/tool/searchHelpers.ts`、`.../providers/tool/codebaseTools.ts` |
| UE 感知：索引模板与排除清单 | `.../common/codebaseProjectTemplates.ts`、`.../common/codebaseIndexDefaults.ts` |
| C++ 无 LSP 兜底 | `.../browser/codebaseGraphLanguageFeatures.contribution.ts` |
| 测试 | `.../test/browser/unrealToolsBridge.test.ts`、`.../test/browser/unrealToolCard.test.ts` |
| 完整中文说明（含官方 MCP 20 项对照表） | `docs/Unreal工具使用说明.html` |
