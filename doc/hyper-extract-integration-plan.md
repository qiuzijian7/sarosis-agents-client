# Hyper-Extract 深度分析与接入 sarosis-agents-client 方案

> 分析对象：`G:\CustomWorkspaces\AIProjects\Hyper-Extract`（Python，LLM 驱动的知识抽取/检索框架，v0.3.0，Apache-2.0）
> 目标项目：`sarosis-agents-client`（TypeScript VS Code fork，内置 agentStudio / MCP / Embedding / 图谱）
> 结论先行：**推荐「方案 A（MCP 桥接）」作为零侵入 MVP，再视需要演进到「方案 B（内置 kb_* 工具 + 本地 Python 服务）」**。两者都复用本项目已有的 MCP 与工具注册设施，无需自建适配层。

---

## 一、Hyper-Extract 核心架构

Hyper-Extract 采用**三层架构**，把"非结构化文本 → 强类型结构化知识 → 向量索引 → 语义检索/RAG"串成一条流水线。

| 层 | 位置 | 职责 |
|---|---|---|
| **AutoTypes** | `hyperextract/types/*` | 8 种强类型知识原语（Model/List/Set/Graph/Hypergraph/Temporal/Spatial/SpatioTemporal） |
| **Methods** | `hyperextract/methods/*` | 10+ 抽取算法（GraphRAG/LightRAG/HyperRAG/iText2KG/KG-Gen/Atom…），注册表模式 |
| **Templates** | `hyperextract/templates/presets/` + `utils/template_engine/*` | 80+ YAML 领域预设，动态生成 AutoType |

### 核心数据流（以 AutoGraph 为例）
```
原始文本
  → RecursiveCharacterTextSplitter 切分 (chunk_size=2048, overlap=256)
  → LLM 批量结构化抽取 (langchain with_structured_output，max_concurrency=max_workers)
       ├─ one_stage：单次抽取 nodes+edges
       └─ two_stage：先抽 nodes，再以 nodes 为上下文抽 edges（更准）
  → _prune_dangling_edges：剪枝悬挂边，保证"边两端必须存在节点"
  → OMem.merge：按 key 去重合并（支持 LLM 智能合并 MergeStrategy.LLM.BALANCED）
  → dump：data.json + metadata.json + index/ (FAISS)
```

关键基类：`hyperextract/types/base.py` 的 `BaseAutoType`，定义了统一的生命周期钩子（抽取/合并/索引/检索/序列化），各 AutoType 只需实现 `_init_data_state / _set_data_state / _update_data_state / _init_index_state / build_index / search / dump_index / load_index / merge_batch_data`。

---

## 二、核心功能拆解

### 2.1 知识库构建（Knowledge Base Construction）

| 能力 | 实现要点 | 文件 |
|---|---|---|
| 长文本切分 | `RecursiveCharacterTextSplitter`，中英文分隔符；单 chunk 直接抽，多 chunk 并发 batch | `types/base.py` L83-87, L248-302 |
| 结构化抽取 | LangChain `llm.with_structured_output(schema)`，失败结果 `_filter_none_results` 容错 | `types/base.py` L77-80, L304-332 |
| **去重合并** | `ontomem.OMem` + `MergeStrategy`（LLM 智能合并 / 简单合并）；支持增量 `feed_text` 与 `__add__` 合并 | `types/graph.py` L250-293, L669-748 |
| 图一致性 | `_prune_dangling_edges` 剪枝悬挂边 | `types/graph.py` L624-665 |
| 8 种结构 | Model（一文档→一对象）、List（多独立项）、Set（去重实体注册表）、Graph/Hypergraph/Temporal/Spatial/SpatioTemporal | `types/__init__.py` |
| 序列化 | `data.json`（知识）+ `metadata.json`（模板/语言/时间戳）+ `index/`（FAISS 向量），`load` 可无损恢复 | `types/base.py` L514-666 |

### 2.2 检索（Retrieval）

| 能力 | 实现要点 |
|---|---|
| 向量索引 | `OMem.build_index()` 内部用 **FAISS**（CPU）建立 node/edge 两套索引；支持 `node_fields_for_index` 字段选择 |
| 语义检索 | `search(query, top_k_nodes, top_k_edges)` 返回 `(nodes, edges)` 元组；索引未建则抛错提示 build_index |
| **RAG 问答** | `chat(query, top_k)`：检索 → 组织为 `=== Relevant Nodes/Edges ===` context → LLM 生成答案；检索结果注入 `additional_kwargs` |
| 增量演进 | `feed_text` 新文档后 `clear_index()`，下次检索自动重建，无需全量重抽 |

检索是**只读、低成本**操作（仅 embedding + 向量相似度），与**构建（重 LLM 调用）** 解耦——这是接入设计的关键。

### 2.3 抽取算法（Methods）
`methods/registry.py` 用注册表管理 10 个算法（`graph_rag/light_rag/hyper_rag/hypergraph_rag/cog_rag/itext2kg/itext2kg_star/kg_gen/atom`），每个标注 `autotype`（graph/hypergraph）。`TemplateFactory.create_method` 按名实例化。这些算法本质是**不同的 prompt 策略 + schema**，底层仍复用 AutoType 引擎。

### 2.4 模板系统
`utils/template_engine/`：`YAML → TemplateCfg → TemplateFactory` 动态生成对应 AutoType。多语言（`localize_template` 取 `lang` 版本 prompt）。80+ 预设覆盖金融/法律/医疗/中医/工业/通用。

### 2.5 多 Provider 客户端
`utils/client.py`：`provider:model@url` 简写（openai / bailian / vllm / anthropic）。`CompatibleEmbeddings` 解决 OpenAI 兼容端点的 batch 上限与多 chunk 均值 embedding。Anthropic 只有 LLM、需配对 OpenAI 兼容 embedder。

### 2.6 MCP Server（关键接入点）
`hyperextract/mcp_server.py`：`he-mcp`（stdio）暴露 5 个**只读**工具：`list_templates / info / search / ask(RAG) / export_obsidian`。LLM/embedder 从 `~/.he/config.toml` 读取。这正好与 agent 生态对接。

---

## 三、本项目（sarosis-agents-client）现状对应

| Hyper-Extract 能力 | 本项目已有对应 | 缺口 / 接入点 |
|---|---|---|
| LLM 调用（OpenAI 格式） | `BuiltInBYOKModelProvider`（`browser/builtInBYOKModelProvider.ts`），原生 OpenAI 兼容，可配 vLLM/Gemini 端点 | 无独立 JSON-Schema 结构化输出封装，但 tool_calls 已可作结构化机制 |
| Embedding 生成 | `IAiEmbeddingVectorService`（`workbench/services/aiEmbeddingVector/common/aiEmbeddingVectorService.ts`）+ 提案 API `vscode.proposed.embeddings.d.ts` | 只生成向量，**无向量索引/相似度检索** |
| FAISS / 向量检索 | `VectorMemory`（`agentStudio/browser/providers/memory/vectorMemory.ts`）为 **TF-IDF 简化版**，注释明言"后续可替换为真实向量库（Pinecone/Chroma）" | **正是 Hyper-Extract FAISS 的自然替换点** |
| 知识图谱 | `ICodebaseGraphService`（tree-sitter 代码图谱） | 互补而非冲突 |
| RAG 检索注入 | `tool_search/tool_describe/tool_call` 桥接 + `memoryProvider.loadContext` | 新增 `kb_*` 工具即可 |
| **MCP 服务器** | **原生支持**：`.mcp.json` 发现（`workbench/contrib/mcp/common/discovery/workspaceDotMcpDiscovery.ts`，Claude 格式 `{ "mcpServers": {...} }`）+ `bundledMcpPresets.ts`（已有 uvx 预设如 fetch/time） | 声明 server 即可，工具自动进 agent 池 |
| 工具注册 | `BuiltinToolProvider._tools`（`Map<string, IToolDescriptor>`，`browser/providers/tool/builtinToolProvider.ts` L264），含 `_registerMemoryTools/_registerSkillTools/_registerCodebaseTools` 等 | 新 `kb_*` 工具组只需向 Map 注入 descriptor |
| 持久化 | `.saros/memory/<agentId>/*.jsonl`（`sessionMemoryProvider.ts`）+ `IStorageService` + `IFileService` | 复用 `IFileService` 落盘知识库目录 |

**结论**：本项目已具备 LLM、Embedding、MCP、工具注册、持久化全部基座；缺口仅在"**向量索引/语义检索**"与"**LLM 驱动的知识抽取**"两步，而这两步恰是 Hyper-Extract 的核心。

---

## 四、兼容 / 接入方案（三档）

### 方案 A — MCP 桥接（推荐 MVP，零侵入）
把 Hyper-Extract 的 `he-mcp` 作为 MCP server 接入。
- **做法**：在 workspace 根 `.mcp.json` 添加，或向 `bundledMcpPresets.ts` 的 `FALLBACK_PRESETS` 增加一项：
  ```jsonc
  // .mcp.json
  { "mcpServers": { "hyper-extract": {
      "command": "uvx",
      "args": ["--with", "hyperextract[mcp]", "he-mcp"]
  } } }
  ```
  或在 `bundledMcpPresets.ts` 增加：
  ```ts
  { id: "hyper-extract", name: "Hyper-Extract",
    description: "知识库语义检索与 RAG",
    transportType: "stdio", command: "uvx",
    args: ["--with", "hyperextract[mcp]", "he-mcp"] }
  ```
- **生效路径**：MCP 服务 → `mcp` toolset → `tool_search/tool_call` 桥接 → agent 工具池。Agent 可经 `search`/`ask` 直接查询已构建的知识库。
- **优点**：零代码改动、复用原生 MCP、HE 升级即同步。
- **局限**：①工具只读（search/ask），知识库**构建仍需外部用 `he parse` CLI 预先完成**；②依赖用户机器有 `uv` + Python 3.11+；③配置（`~/.he/config.toml` 的 LLM/Embedder）需在 HE 侧单独设。

### 方案 B — 内置 `kb_*` 工具 + 本地 Python 服务（深度集成）
在 TS 侧注册一组内置工具，真正把"构建 + 检索"都纳入 agent 工作流。
- **Python 后端**：封装一个轻量服务（FastAPI 或薄壳子进程），对 Hyper-Extract 的 `Template`/`AutoGraph` 暴露 `parse(text, template) / build_index / search / ask / status / export_obsidian`。建议用 FastAPI（HTTP），便于跨进程、避免每次冷启动 Python。
- **TS 工具注册**：在 `builtinToolProvider.ts` 新增 `_registerKnowledgeBaseTools()`，向 `_tools` 注入：
  - `kb_build`（喂文档 + 选模板 → 构建/增量 feed 知识库）
  - `kb_search`（语义检索 nodes/edges）
  - `kb_ask`（RAG 问答）
  - `kb_status`（info：节点/边计数 + 索引状态）
  - 归属新 toolset `knowledge`（在 `toolsetConfig.ts` 的 `TOOLSET_DEFINITIONS` 增加）。
- **持久化**：知识库目录落到 `.saros/kb/<kbId>/`（data.json + metadata.json + index/），用 `IFileService` 读写；配置复用 `~/.he/config.toml` 或本项目已有的 provider 配置。
- **VectorMemory 替换（可选增强）**：把 `vectorMemory.ts` 的 TF-IDF 余弦替换为 HE/FAISS 索引，或让 `kb_search` 直接服务 `memoryProvider.loadContext` 的语义召回。
- **优点**：完整读写闭环、工具随 agent 编排、不依赖外部手动建库。
- **代价**：需维护一个 Python 后端进程/子进程，以及 TS↔Py 的协议。

### 方案 C — TS 移植核心算法（彻底但成本高）
用 LangChain.js + `faiss-node`/已有 `IAiEmbeddingVectorService` 重写 `BaseAutoType`/`OMem` 核心（结构化抽取 + 去重 + FAISS 索引 + RAG）。
- **优点**：纯 TS、无 Python 运行时依赖、与本项目 LLM/Embedding 深度同源。
- **代价**：需重写 8 种 AutoType + OMem 合并策略 + 80+ 模板语义，工作量最大；HE 的持续更新难以同步。

---

## 五、推荐落地路径

```
Phase 0  环境准备
  - 在 agentStudio 配置/文档里说明 Python 3.11+ / uv 运行时要求
  - 约定知识库根目录（.saros/kb/ 或 workspace 指定目录）

Phase 1  MVP：方案 A（MCP 桥接，1-2 天）
  - bundledMcpPresets 增加 hyper-extract 预设（uvx he-mcp）
  - 在 resources/.agents/mcp-presets/*.json 增加对应 JSON（运行时 loadMcpPresetsFromResources）
  - 验证：agent 经 tool_call 调 search/ask 命中已建知识库
  - 提供 README：用户用 `he parse <doc> -t <template> -o <kb>` 预先建库

Phase 2  深度：方案 B（内置 kb_* 工具，3-5 天）
  - 封装 Python 后端（FastAPI wrap Hyper-Extract）
  - builtinToolProvider 注册 kb_build/kb_search/kb_ask/kb_status + knowledge toolset
  - IFileService 落盘 .saros/kb/<kbId>/
  - 在 memoryProvider.loadContext 接入 kb_search 做语义召回（可选）

Phase 3  增强（可选）
  - 用 FAISS 索引替换 VectorMemory TF-IDF
  - 与 ICodebaseGraphService 代码图谱互补（文档知识 vs 代码知识）
```

---

## 六、风险与注意事项

1. **Python 运行时分发**：方案 A/B 都需 `uv`+Python。可选把 `he-mcp` 及依赖打包进部署包，或首次使用时引导安装（参考现有 `bundledMcpPresets` 用 `npx`/`uvx` 拉取的思路）。
2. **Provider 配置一致性**：HE 侧 LLM/Embedder 与本项目 agent 用的模型需一致（尤其 embedding 维度、base_url、api_key），否则索引与检索向量空间不匹配。
3. **索引路径与生命周期**：`build_index` 与数据分离（data.json 变 → 索引失效）。增量 `feed_text` 后需 `clear_index()` 再重建——工具层要管理这个状态。
4. **RAG 上下文注入点**：`ask` 自带 RAG，但若要接入本项目 `memoryProvider.loadContext` 的语义召回，需明确注入位置（已有 FTS5/embedding 匹配注释）。
5. **只读 MCP 的安全边界**：`he-mcp` 明确"read + export only，不创建/修改/删除 KA"——符合 agent 最小权限原则，方案 A 天然安全。
6. **许可证**：Hyper-Extract 为 Apache-2.0，可商用/再分发；作为外部进程/MCP 调用不构成代码 copyleft 传染。

---

## 七、关键文件速查

**Hyper-Extract**
- 引擎基类：`hyperextract/types/base.py`
- 图类型（最复杂）：`hyperextract/types/graph.py`
- 方法注册表：`hyperextract/methods/registry.py`
- 模板工厂：`hyperextract/utils/template_engine/factory.py`
- 客户端/Provider：`hyperextract/utils/client.py`
- MCP Server：`hyperextract/mcp_server.py`
- 依赖：`ontomem`(OMem 向量记忆/合并)、`ontosight`(图谱可视化)、`faiss-cpu`、`langchain`

**本项目（接入点）**
- MCP 预设：`src/vs/sessions/contrib/agentStudio/common/bundled-tools/bundledMcpPresets.ts`
- `.mcp.json` 发现：`src/vs/workbench/contrib/mcp/common/discovery/workspaceDotMcpDiscovery.ts`
- 工具注册：`src/vs/sessions/contrib/agentStudio/browser/providers/tool/builtinToolProvider.ts`
- 工具集配置：`src/vs/sessions/contrib/agentStudio/common/toolsetConfig.ts`
- 向量记忆（待替换）：`src/vs/sessions/contrib/agentStudio/browser/providers/memory/vectorMemory.ts`
- Embedding 服务：`src/vs/workbench/services/aiEmbeddingVector/common/aiEmbeddingVectorService.ts`
- 记忆持久化：`src/vs/sessions/contrib/agentStudio/browser/providers/memory/sessionMemoryProvider.ts`
