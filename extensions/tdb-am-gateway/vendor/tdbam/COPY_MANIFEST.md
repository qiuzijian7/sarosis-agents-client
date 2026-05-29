# TDB-AM Vendor Copy Manifest

> 本文档记录从上游 TencentDB-Agent-Memory 仓库复制源码到 sarosis 内嵌 vendor 目录的决策与改动。
>
> **维护准则**：每次同步上游或在 vendor 内做本地化改动，都必须在此处登记，否则上游升级时会 diff 失败。

---

## 1. 上游溯源

| 项 | 值 |
|---|---|
| 上游仓库 | `D:\UGit\TencentDB-Agent-Memory` |
| 上游远端 | （在上游仓库执行 `git remote -v` 自取） |
| 复制时基准版本 | `v0.3.5`（package.json 声明） |
| 复制时间 | 2026-05-21 |
| 复制工具 | PowerShell 一次性脚本（参见 README/CHANGELOG）|

---

## 2. 复制策略：方案 A（最小化复制）

**保留**（共 78 个 `.ts` 文件，约 1MB）：

| 路径 | 说明 |
|---|---|
| `src/config.ts` | 配置解析，TDB-AM 的总入口配置 |
| `src/core/conversation/` | L0 对话录制 |
| `src/core/hooks/` | auto-capture / auto-recall |
| `src/core/persona/` | L3 用户画像 |
| `src/core/profile/` | profile 同步 |
| `src/core/prompts/` | LLM prompts（dedup / extraction / persona / scene）|
| `src/core/record/` | L1 dedup / extractor / reader / writer |
| `src/core/report/` | reporter |
| `src/core/scene/` | L2 场景抽取与索引 |
| `src/core/seed/` | 种子数据 runtime（可后续考虑剔除）|
| `src/core/store/` | sqlite + bm25-local + factory + types（**已剔除 embedding/tcvdb**）|
| `src/core/tools/` | conversation-search / memory-search |
| `src/gateway/` | HTTP gateway（server.ts / config.ts / types.ts）|
| `src/offload/` 顶层 | reclaimer / state-manager / mmd-injector / 等 |
| `src/offload/hooks/` | after-tool-call / before-prompt-build / llm-input-l3 |
| `src/offload/pipelines/` | l2-mermaid |
| `src/adapters/standalone/` | host-adapter + llm-runner（独立模式适配）|
| `src/utils/` | 各类工具 |
| `index.ts` | 上游主入口（未来可作 sarosis adapter 模板） |
| `package.json` | 上游声明（**仅参考，sarosis 不会直接执行其 npm install**）|
| `LICENSE` | 上游许可证（保留以满足合规） |

**剔除**：

| 路径 | 剔除理由 | 对应决策 |
|---|---|---|
| `src/cli/` | sarosis 不需要独立 CLI（IDE 内嵌使用）| Q5/Q6 集成范围 |
| `src/adapters/openclaw/` | sarosis 不是 openclaw 宿主 | Q5/Q6 集成范围 |
| `src/offload/local-llm/` | 本地 LLM 推理（基于 node-llama-cpp）| Q4 = 完全跟随云端 Chat 模型 |
| `src/core/store/embedding.ts` | 向量嵌入（OpenAI/自托管 embedding 服务）| Q7 = A 关闭向量召回 |
| `src/core/store/tcvdb.ts` | 腾讯云向量数据库实现 | Q7 = A 关闭向量召回 |
| `src/core/store/tcvdb-client.ts` | 腾讯云向量数据库客户端 | Q7 = A 关闭向量召回 |
| `bin/` `scripts/` `hermes-plugin/` `assets/` `docker/` `*.md` | 部署脚本、Hermes Python 插件、文档、Docker、样图等外部集成产物 | sarosis 仅消费源码 |

**待办**：剔除导致的 `import` 引用残留需在阶段 2/3 修复（详见第 4 节）。

---

## 3. 本地化改动追踪（按决策项归类）

> 每次改动 vendor 内文件，请在此追加一条记录：`<决策项> | <文件路径> | <改动摘要> | <日期>`。

### Q7 — 关闭向量召回（删除 sqlite-vec / TCVDB）

| 文件 | 改动摘要 | 日期 |
|---|---|---|
| `src/core/store/factory.ts` | 完全重写：移除 `tcvdb` 分支与 `createEmbeddingService` 调用，固定走 sqlite + NoopEmbeddingService，强制 `dimensions=0` | 2026-05-21 ✅ |
| `src/core/store/sqlite.ts` | `init()` 内 `require("sqlite-vec")` 由 `if (dimensions > 0)` 守卫，`dimensions=0` 时跳过加载且**不进 degraded 模式**（保留 FTS5 完整功能；上游本身就有 vec0 表 deferred 设计）| 2026-05-21 ✅ |
| `src/core/store/embedding.ts` | **新建**：仅类型定义 + `NoopEmbeddingService` + 抛错版 `createEmbeddingService` stub，满足 8 处 `import type` | 2026-05-21 ✅ |
| `src/core/store/tcvdb.ts` / `tcvdb-client.ts` | 复制时已剔除（不再存在）| 2026-05-21 ✅ |

> **未做的改动**：`auto-recall.ts`、`l1-dedup.ts`、`l1-extractor.ts`、`l1-writer.ts`、`auto-capture.ts`、`memory-search.ts`、`conversation-search.ts`、`tdai-core.ts` 这 8 个文件**只 import 了类型**（`import type { EmbeddingService }`），Embedding stub 文件已满足类型契约，**无需修改业务文件**。这些文件运行时调用 `embedding.embed(...)` 会被 `NoopEmbeddingService` 抛错，但只要 hook 路径里没有真正调用向量 embed，就不会触发——`auto-recall.ts` 内的向量分支由 config.recallStrategy 控制，需在 sarosis 注入配置时显式关闭。

### Q8 — LLM-based 去重（替代向量去重）

| 文件 | 改动摘要 | 日期 |
|---|---|---|
| _未做_ | `src/core/record/l1-dedup.ts` 当前仍是上游"向量 cosine + LLM 兜底"混合逻辑。**Q8=A 表示完整对齐上游**——上游的 dedup 已经包含 LLM 路径，因此本块**实际不需要修改**，只需在 sarosis 注入配置时关掉 dedup 的向量分支（embedding 服务为 Noop 时 cosine 比较自动跳过）。| 2026-05-21 ⏭ 跳过 |

### Q10 — 禁用 jieba（改 unicode-regex fallback）

| 文件 | 改动摘要 | 日期 |
|---|---|---|
| `src/core/store/sqlite.ts` | `getJieba()` 函数内的 `require("@node-rs/jieba")` 已改为直接 `_jieba = null`，永久走 unicode-regex fallback | 2026-05-21 ✅ |
| _后续优化_ | 若中文召回精度不足，可在 fallback 路径接入 `segmentit`（纯 JS 分词），见 sqlite.ts ZH_STOP_WORDS 附近代码 | 待评估 |

### Q3/Q4 — LLM 调用接 sarosis Knot 桥（跟随当前 Chat 模型）

| 文件 | 改动摘要 | 日期 |
|---|---|---|
| `src/adapters/standalone/llm-runner.ts` | `run()` 内 `baseURL`/`apiKey`/`model` 改为优先读取环境变量 `TDBAM_LLM_BASE_URL` / `TDBAM_LLM_API_KEY` / `TDBAM_LLM_MODEL`，回退到 config。这样 sarosis inlineGateway 启动时即可注入 Knot 桥地址 + 登录态 token + 当前 Chat 模型 | 2026-05-21 ✅ |

### Q11 — 删除 BM25-local

| 文件 | 改动摘要 | 日期 |
|---|---|---|
| `src/core/store/bm25-local.ts` | **整体删除** | 2026-05-21 ✅ |
| `src/core/store/bm25-client.ts` | **顺手删除**（孤儿文件，HTTP 客户端到 Python BM25 sidecar，无引用方）| 2026-05-21 ✅ |
| `src/core/store/factory.ts` | 删除 `createBM25Encoder` 引用与 `bm25Encoder` StoreBundle 字段 | 2026-05-21 ✅ |

### 顶层 OpenClaw 入口处理

| 文件 | 改动摘要 | 日期 |
|---|---|---|
| `index.ts` → `index.openclaw.ts.bak` | 上游入口重度依赖 `openclaw/plugin-sdk/core` + `OpenClawHostAdapter` + cli。重命名为 `.bak` 防止 TypeScript 编译扫描，保留作参考。sarosis 会写自己的入口（`extensions/tdb-am-gateway/inlineGateway.ts`）。 | 2026-05-21 ✅ |
| `src/adapters/index.ts` | 删除 `./openclaw/index.js` 的 re-export，只保留 `./standalone/index.js` | 2026-05-21 ✅ |

### package.json 重写

| 文件 | 改动摘要 | 日期 |
|---|---|---|
| `package.json` | 改名为 `@sarosis/tdbam-vendor`，标 `private:true`，删除 `sqlite-vec` / `@node-rs/jieba` / `@tencentdb-agent-memory/tcvdb-text` / `tsx` / `undici` / `node-llama-cpp` / `opik` 等依赖，新增 `_sarosis` 元数据块记录每项删除理由 | 2026-05-21 ✅ |

### 其他—— sarosis 适配（待后续阶段）

| 文件 | 改动摘要 | 日期 |
|---|---|---|
| _待施工_ | `src/gateway/server.ts`：导出 `startServer(opts)` 函数式入口，让 inlineGateway 可直接 `await startServer(...)` 而不是 spawn 子进程 | ✅ 跳过：上游已是 class（TdaiGateway.start/stop），sarosis 直接 new + await start() 即可 |
| _待施工_ | `src/config.ts`：移除对外部 OpenClaw 配置目录的依赖，改读 sarosis 注入的配置对象 | ✅ 跳过：上游 loadGatewayConfig 已支持环境变量 + Partial<GatewayConfig> overrides |

### 阶段 4 编译期修复（让 vendor 通过 sarosis tsconfig 严格检查）

| 文件 | 改动摘要 | 日期 |
|---|---|---|
| `src/core/store/embedding.ts` | 扩展 stub：新增 `EmbeddingProviderInfo` 类型、`embedBatch`/`getDimensions`/`getProviderInfo` 方法；`embed`/`embedQuery` 返回类型从 `number[][]` 改为 `Float32Array`（匹配 vendor 真实使用面） | 2026-05-21 ✅ |
| `src/adapters/standalone/llm-runner.ts` | 删除 `compatibility: "compatible"` 字段（@ai-sdk/openai v3 已不支持该字段，默认即 OpenAI-compatible 模式）| 2026-05-21 ✅ |
| `src/offload/index.ts` | `LocalLlmClient` 改为本地 stub class（构造时抛错）+ 实现 `l1Summarize`/`l15Judge`/`l2Generate` 同样抛错。剔除上游 `import { LocalLlmClient } from "./local-llm/index.js"` | 2026-05-21 ✅ |
| `src/offload/session-registry.ts` | `private static _registryCounter = 0` 移到 instance field 之前，修复 TS2729 初始化前使用 | 2026-05-21 ✅ |
| `src/offload/state-manager.ts` | `private static _instanceCounter = 0` 移到 instance field 之前，修复 TS2729 初始化前使用 | 2026-05-21 ✅ |
| `src/utils/clean-context-runner.ts` | `OpenClawPluginApi` 改为 `type ... = any`（用 unknown 阻止索引访问，any 才能让 `OpenClawPluginApi["runtime"]["agent"]...` 通过）| 2026-05-21 ✅ |
| `src/core/hooks/auto-recall.ts` | `vectorStore.searchL1Hybrid({...})` 加非空断言 `searchL1Hybrid!(...)`（capability 守卫已确认存在但 TS 推断不到）| 2026-05-21 ✅ |

---

## 4. 当前已知问题（复制后立即可见）

复制完成后并已在阶段 2 修复的引用问题：

1. ~~`src/core/store/factory.ts` 引用了已删除的 `embedding.ts` / `tcvdb.ts` → 编译会报错~~ ✅ 已重写 factory.ts
2. ~~`src/adapters/index.ts` 引用了已删除的 `./openclaw/` → 编译会报错~~ ✅ 已重写 adapters/index.ts
3. ~~`src/index.ts` 顶层也可能存在 `local-llm` 引用~~ ✅ 顶层 index.ts 已重命名为 .bak（OpenClaw 入口与 sarosis 无关）
4. ~~所有 `@node-rs/jieba` 引用尚未替换~~ ✅ sqlite.ts 内 `getJieba()` 已永久禁用
5. ~~`package.json` 里的依赖尚未对齐到实际保留的代码~~ ✅ 已重写 package.json，标记 sarosis-vendored

**当前 vendor 内全部外部 NPM 依赖（来自 src 全量扫描）**：
- `ai`、`@ai-sdk/openai` — Vercel AI SDK
- `yaml` — gateway config 解析
- `js-tiktoken` — offload 模块 token 计数
- `json5` — hook policy 配置解析

**残余的 OpenClaw 类型/接口引用**（不影响 sarosis 主路径，但需要在阶段 3 处理）：
- `src/gateway/config.ts`、`src/utils/*` 等可能还有 `OpenClawPluginApi` 类型引用 — 待阶段 3 适配 sarosis 接口时统一收口
- `src/adapters/standalone/host-adapter.ts` 是否完全 host-neutral — 待阶段 3 验证

---

## 5. 上游同步流程（未来参考）

当上游发布新版本（如 v0.3.6）需要同步时：

1. `cd D:\UGit\TencentDB-Agent-Memory && git pull`
2. 在 sarosis 仓库 vendor 目录上方运行重复的复制脚本（同样的 exclude 规则）
3. 把本文档第 3 节登记的所有 _本地化改动_ 重新 apply（建议把每条改动维护成可重放的 patch 或 grep+sed 脚本）
4. 更新本文档第 1 节的"复制时基准版本"

---

*维护者：sarosis-agents-client / TDB-AM 集成团队*
