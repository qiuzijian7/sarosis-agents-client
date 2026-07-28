# Hyper-Extract 项目分析 + Embedding 配置指南

> 分析对象：`G:\CustomWorkspaces\AIProjects\Hyper-Extract`（v0.3.0, Apache-2.0）
> 分析日期：2026-07-19
> 关联：上一篇《如何建立给 LLM 使用的知识库》的"开源项目选型"补充

---

## 一、Hyper-Extract 是什么

一句话定位：**用一条命令把非结构化文档变成"强类型知识摘要（Knowledge Abstract）"的 LLM 知识抽取框架**。

它和上一篇讲的"RAG 问答"定位不同——Hyper-Extract 偏**知识结构化抽取**（实体/关系/图谱/超图/时空图），抽取出的摘要既可以用 `he search` / `he ask` 做语义检索问答，也可以导出成 Obsidian 仓库、或经 MCP 暴露给 Agent。可以理解为 RAG 链路里**"离线建库 + 结构化索引"**那一端的专业化工具。

### 核心能力

| 能力 | 说明 |
|---|---|
| 8 种知识结构体（Auto-Types） | List / Set / Model(Pydantic) / Graph / Hypergraph / Temporal Graph / Spatial Graph / Spatio-Temporal Graph |
| 10+ 抽取引擎（Methods） | KG-Gen、GraphRAG、LightRAG、Hyper-RAG、Cog-RAG、iText2KG、ATOM 等开箱即用 |
| 80+ YAML 模板（Templates） | 金融 / 法律 / 医疗 / 中医 / 工业 / 通用 6 大领域，零代码抽取 |
| 增量演化 | 随时喂新文档，扩展/精炼已有知识库（`he clean` 可清索引） |
| Obsidian 导出 | 任意图谱 → `[[wikilinks]]` 互联的 Markdown 笔记库 |
| MCP Server | `he-mcp` 把知识摘要暴露给 Claude Desktop / IDE Agent（只读 + 导出） |

### 与 GraphRAG / LightRAG 的差异化（官方对比）

| 特性 | GraphRAG | LightRAG | **Hyper-Extract** |
|---|:---:|:---:|:---:|
| 知识图谱 | ✅ | ✅ | ✅ |
| 时序图 | ✅ | ❌ | ✅ |
| 空间图 | ❌ | ❌ | ✅ |
| 超图 | ❌ | ❌ | ✅ |
| 领域模板 | ❌ | ❌ | ✅（80+） |
| 交互式 CLI | ✅ | ❌ | ✅ |
| 多语言 | ✅ | ❌ | ✅ |

### 技术栈（来自 pyproject.toml）

- **编排**：`langchain` / `langchain-community` / `langchain-openai`（OpenAI 兼容抽象）
- **向量与检索**：`faiss-cpu`（向量索引）、`semhash`（文本去重）
- **类型系统**：`pydantic`、`ontomem` / `ontosight`（本体/记忆层）
- **CLI**：`typer` + `rich`
- **配置**：`python-dotenv` + `tomli-w`（TOML 持久化）
- 可选扩展：`langchain-anthropic`（anthropic）、`langchain-google-genai`（google）、`mcp`（MCP Server）

> 注意：项目**没有**独立的向量数据库依赖（Milvus/Qdrant 之类），语义检索走本地 **FAISS + 内存索引**，适合个人/中小规模知识库；超大规模需自行迁移存储层。

---

## 二、三层架构

```
┌─────────────────────────────────────────────┐
│  Templates（80+ YAML 预设，6 大领域）          │  ← 零代码入口
├─────────────────────────────────────────────┤
│  Methods（抽取算法）                          │
│  KG-Gen / GraphRAG / LightRAG / Hyper-RAG …  │
├─────────────────────────────────────────────┤
│  Auto-Types（8 种强类型结构体）               │
│  Model / List / Set / Graph / Hypergraph …   │
└─────────────────────────────────────────────┘
```

模板用 YAML 声明 `output`（字段、`type`）、`identifiers`（实体/关系去重键），引擎据此驱动 LLM 做结构化输出，再落地为对应类型对象。

---

## 三、Embedding 在 Hyper-Extract 中的角色

Embedding 不是"问答时才用"，而是贯穿**建库与查询**两端：

1. **建库（离线）**：抽取出的实体/关系/片段文本被向量化，写入 FAISS 索引（配合 `semhash` 去重）。
2. **查询（在线）**：`he search`（语义检索）、`he ask`（RAG 问答）把查询向量化后做相似度召回。

因此 **Embedder 配置错误会同时拖垮建库和查询**，且**更换 Embedding 模型后必须重建知识库索引**（`he clean` → 重新 `he parse`），否则向量维度不匹配。

---

## 四、如何配置 Embedding（重点）

### 4.1 配置入口（三层 API）

| 层级 | 用法 | 适用 |
|---|---|---|
| Python 统一创建 | `create_client(llm=..., embedder=..., api_key=...)` | 代码集成 |
| Python 单独创建 | `create_embedder(spec, api_key=...)` | 只用 Embedder |
| 读配置文件 | `get_client()` → 读 `~/.he/config.toml` | 复用 CLI 配置 |
| CLI 持久化 | `he config embedder ...` | 命令行/长期配置 |
| 环境变量 | `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `ANTHROPIC_API_KEY` | 快速覆盖 |

### 4.2 字符串简写语法

```
provider:model@url
```
- `"bailian"` → 仅 provider，用预设默认值
- `"bailian:text-embedding-v4"` → provider + model，用预设 URL
- `"vllm:bge-m3@http://localhost:8001/v1"` → 完整指定（本地必须显式 base_url）

也支持 dict 形式：`{"provider": "bailian", "model": "text-embedding-v4", "api_key": "sk-..."}`。

### 4.3 内置 Provider 预设（Embedder 默认值）

| provider | base_url | 默认 embedder 模型 | 备注 |
|---|---|---|---|
| `openai` | `https://api.openai.com/v1` | `text-embedding-3-small` | 官方端点走 `OpenAIEmbeddings` |
| `bailian` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `text-embedding-v4` | 阿里云百炼，**中文强** |
| `vllm` | 需显式指定 | 无默认，**必须给 model + base_url** | 本地部署 |
| `anthropic` / `claude` | 无 | **无（不支持 Embedding）** | 需另配 OpenAI 兼容 embedder |

> ⚠️ **Anthropic 没有 Embedding API**。用 Claude 做 LLM 时，必须单独配一个 OpenAI 兼容的 embedder，例如：
> `create_client(llm="anthropic", embedder="openai:text-embedding-3-small", ...)`

### 4.4 两条 Embedder 代码路径（关键实现细节）

`create_embedder()` 内部按 `base_url` 分流，这决定了行为差异：

- **`OpenAIEmbeddings`**（langchain_openai）—— **仅当 `base_url == https://api.openai.com/v1`** 时走此路径。它用 tiktoken 预分词、**发送整数 token 列表**给 API（官方支持）。
- **`CompatibleEmbeddings`**（项目自定义类）—— **其他所有 OpenAI 兼容端点**（bailian / vllm / ollama / LiteLLM 等）都走这里。它**始终发送字符串**，并内置了若干兼容性处理：
  - `max_batch_size` 默认 **10**（很多兼容服务端上限为 10，如百炼；超出会 400）
  - 用 tiktoken 对超长文本**分块**（单块上限 `embedding_ctx_length` 默认 8191 token）
  - 多块文本取**真实均值**（非相邻两两平均，避免长文本偏向末块）
  - **空串回填零向量**，绝不把空字符串发给 API（百炼会拒）

> 含义：**只有直连 OpenAI 官方才用原生类，其余一律走 CompatibleEmbeddings**。配置本地/国内模型时，这条路径的批次与分块逻辑是保障稳定的关键。

### 4.5 可调参数（以 kwargs 透传给 Embedder）

| 参数 | 默认值 | 说明 |
|---|---|---|
| `max_batch_size` | `10` | 每次请求最大输入条数；百炼等须 ≤10 |
| `chunk_size` | 同 `max_batch_size` | 旧别名 |
| `embedding_ctx_length` | `8191` | 单条文本最大 token 数（分块依据） |
| `max_retries` | `2` | API 失败重试次数 |

示例（提高批次以加速本地 vLLM）：
```python
emb = create_embedder(
    "vllm:bge-m3@http://localhost:8001/v1",
    api_key="dummy",
    max_batch_size=32,      # 本地可放宽
    embedding_ctx_length=8191,
)
```

---

## 五、配置示例（按场景）

### 场景 1：本地 vLLM + bge-m3（中文 / 离线，数据不出本机）
```python
from hyperextract import create_client
llm, emb = create_client(
    llm="vllm:Qwen3.5-9B@http://localhost:8000/v1",
    embedder="vllm:bge-m3@http://localhost:8001/v1",
    api_key="dummy",
)
```
> bge-m3 多语言（含中文）效果好、1024 维，支持 dense/sparse/colbert 混合检索。

### 场景 2：阿里云百炼 text-embedding-v4（中文云端，省心）
```python
llm, emb = create_client("bailian", api_key="sk-...")
# embedder 自动取 text-embedding-v4，base_url 用预设
```

### 场景 3：OpenAI 官方（英文为主）
```python
llm, emb = create_client("openai", api_key="sk-...")
# embedder = text-embedding-3-small
```

### 场景 4：Claude 做 LLM + 独立 Embedder
```python
from hyperextract import create_client
llm, emb = create_client(
    llm="anthropic",
    embedder="openai:text-embedding-3-small",
    api_key="sk-ant-...",
)
# 需先 pip install 'hyperextract[anthropic]'
```

### 场景 5：CLI 持久化（推荐长期使用）
```bash
# 交互式
he config init

# 或显式设置 Embedder
he config embedder \
  --provider vllm \
  --model bge-m3 \
  --base-url http://localhost:8001/v1 \
  --api-key dummy

# 查看 / 清除
he config embedder --show
he config embedder --unset
```
写入 `~/.he/config.toml`：
```toml
[llm]
provider = "vllm"
model = "Qwen3.5-9B"
api_key = "dummy"
base_url = "http://localhost:8000/v1"

[embedder]
provider = "vllm"
model = "bge-m3"
api_key = "dummy"
base_url = "http://localhost:8001/v1"
```
之后 Python 侧直接 `get_client()` 即可复用。

---

## 六、Embedding 选型与避坑建议

**选型（中文优先）**
- 中文 / 多语言：**bge-m3**（本地 vLLM）或 **百炼 text-embedding-v4**（云端）。
- 纯英文 / 已有 OpenAI：text-embedding-3-small（便宜）或 3-large（更强）。
- 备选中文模型（经 vLLM / 兼容端点）：`bge-large-zh`、`bce-embedding`（网易有道）。

**避坑清单**
1. **Anthropic 不能当 embedder** —— 一定配独立 OpenAI 兼容 embedder。
2. **换 embedder 模型后必须重建 KA 索引** —— 维度变了，旧向量无法对齐；`he clean` 后重新 `he parse`。
3. **百炼等兼容服务批次上限 10** —— 代码已默认 10，别盲目调大；本地 vLLM 可放宽到 32+。
4. **vllm 必须显式 base_url** —— 预设里是 `None`，不给会报 "requires explicit base_url"。
5. **api_key 兜底** —— 兼容端点大多可用 `dummy`；不设置会回退读 `OPENAI_API_KEY`，缺失则报错。
6. **长文本自动分块取均值** —— 单条超过 8191 token 会被切分，最终向量是各块均值，召回质量依赖切块策略。

---

## 七、与上一篇"知识库选型"的衔接

Hyper-Extract 不是 Dify/RAGFlow 那种"对话产品"，而是**结构化知识抽取 + 轻量语义检索**的开发者框架。在你搭建 LLM 知识库时，它的定位是：

- **补充 RAG 的"建库质量"一环**：把杂乱文档抽成图谱/超图，比纯文本切片更适合多跳推理、实体关系问答。
- **可嵌入现有系统**：通过 `create_client` / `get_client` 做 Python 集成，或用 `he-mcp` 把知识摘要喂给 Agent（如你的 sarosis-agents-client 中的 Agent 体系）。
- **与向量库搭配**：若规模超出 FAISS 内存索引，可把它产出的结构化数据 + 自管 Embedding，落到 Milvus/Qdrant 做生产级检索。

> 一句话：上一篇讲的是"RAG 知识库全景与开源选型"，Hyper-Extract 是其中**"结构化抽取引擎"**这一细分品类里特性最全的开源选项。
