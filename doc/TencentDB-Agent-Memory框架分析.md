# TencentDB-Agent-Memory 框架分析

> 分析时间：2026-05-18  
> 项目路径：G:\CustomWorkspaces\AIProjects\TencentDB-Agent-Memory框架

---

## 一、项目概述

**项目名称**: TencentDB-Agent-Memory（腾讯数据库 Agent 记忆系统）

**项目定位**: 一个为 AI Agent 设计的**四层记忆系统插件**，通过符号化短期记忆和分层式长期记忆，解决 Agent 在长程任务中的上下文累积和记忆检索问题。

**核心价值主张**:
- 让 Agent 记住该记的，让人专注创造和判断
- 拒绝暴力历史堆砌，抛弃不可逆的暴力摘要
- 记忆不是黑盒，所有信息 100% 可找回、可恢复

---

## 二、项目结构

```
TencentDB-Agent-Memory/
├── index.ts                          # 主入口，OpenClaw 插件注册
├── package.json                      # 项目配置和依赖
├── tsdown.config.ts                  # 构建配置（ESM 格式）
├── vitest.config.ts                  # 测试配置
├── openclaw.plugin.json             # OpenClaw 插件清单和配置 Schema
├── README.md / README_CN.md         # 中英文文档
├── CHANGELOG.md                     # 版本历史
├── CONTRIBUTING.md                  # 贡献指南
│
├── src/                            # 核心源代码
│   ├── config.ts                   # 配置解析和类型定义
│   ├── index.ts                    # 主入口（薄壳层）
│   │
│   ├── core/                       # 核心记忆引擎（宿主无关）
│   │   ├── tdai-core.ts           # TdaiCore 主类
│   │   ├── types.ts               # 核心类型定义
│   │   ├── conversation/          # L0 对话录制
│   │   │   └── l0-recorder.ts
│   │   ├── hooks/                 # 自动捕获和召回
│   │   │   ├── auto-capture.ts   # L0 自动捕获
│   │   │   └── auto-recall.ts    # L1/L2/L3 自动召回
│   │   ├── record/               # L1 记录管理
│   │   │   ├── l1-extractor.ts   # LLM 提取
│   │   │   ├── l1-dedup.ts      # 向量去重
│   │   │   └── l1-writer.ts     # L1 写入
│   │   ├── scene/                # L2 场景块
│   │   │   ├── scene-extractor.ts
│   │   │   └── scene-index.ts
│   │   ├── persona/              # L3 用户画像
│   │   │   ├── persona-generator.ts
│   │   │   └── profile-sync.ts
│   │   ├── store/                # 存储层
│   │   │   ├── types.ts          # IMemoryStore 接口
│   │   │   ├── sqlite.ts         # SQLite + sqlite-vec 实现
│   │   │   ├── tcvdb.ts         # 腾讯云向量数据库
│   │   │   ├── embedding.ts      # Embedding 服务
│   │   │   └── factory.ts        # 存储工厂
│   │   ├── tools/                # Agent 工具
│   │   │   ├── memory-search.ts
│   │   │   └── conversation-search.ts
│   │   └── prompts/             # LLM 提示词模板
│   │
│   ├── offload/                   # 上下文卸载模块（短期记忆）
│   │   ├── index.ts              # 模块入口
│   │   ├── state-manager.ts      # 状态管理
│   │   ├── storage.ts            # 卸载存储
│   │   ├── mmd-injector.ts      # Mermaid 注入
│   │   ├── hooks/               # OpenClaw 钩子
│   │   │   ├── after-tool-call.ts
│   │   │   └── llm-input-l3.ts  # L3 压缩
│   │   └── pipelines/           # L1/L2 处理管道
│   │
│   ├── adapters/                  # 宿主适配器（架构关键）
│   │   ├── openclaw/            # OpenClaw 适配
│   │   │   ├── host-adapter.ts
│   │   │   └── llm-runner.ts
│   │   └── standalone/          # 独立/网关适配
│   │       ├── host-adapter.ts
│   │       └── llm-runner.ts
│   │
│   ├── gateway/                   # HTTP Gateway 服务
│   │   ├── server.ts            # Express 服务器
│   │   └── config.ts
│   │
│   ├── cli/                       # CLI 命令
│   │   └── index.ts
│   │
│   └── utils/                     # 工具类
│       ├── pipeline-manager.ts    # L1/L2/L3 调度器
│       ├── pipeline-factory.ts    # 管道工厂
│       ├── memory-cleaner.ts      # 数据清理
│       ├── checkpoint.ts          # 检查点管理
│       └── sanitize.ts           # 文本清理
│
├── hermes-plugin/                  # Hermes Agent Python 插件
│   └── memory/memory_tencentdb/
│       ├── __init__.py           # Python 记忆提供者
│       ├── client.py             # Gateway SDK 客户端
│       └── supervisor.py         # Gateway 进程管理
│
├── docker/                        # Docker 部署
│   └── opensource/
│
├── scripts/                       # 运维脚本
│   ├── README.memory-tencentdb-ctl.md
│   └── openclaw-after-tool-call-messages.patch.sh
│
└── assets/                        # 文档图片
    └── images/
```

---

## 三、核心架构：四层记忆系统

### 3.1 分层记忆金字塔

```
L3 Persona（用户画像）
    ↑ 归纳
L2 Scenario（场景块）
    ↑ 抽取
L1 Atom（结构化事实）
    ↑ 提取
L0 Conversation（原始对话）
```

### 3.2 各层职责

| 层级 | 名称 | 内容 | 存储方式 | 用途 |
|:---:|:---:|---|---|---|
| **L0** | Conversation | 原始对话 JSONL | 文件系统 + SQLite FTS5 | 完整回溯，100% 可恢复 |
| **L1** | Atom | 结构化事实（三元组） | 向量数据库 + FTS5 | 精确事实检索 |
| **L2** | Scenario | 场景块（主题聚合） | 向量数据库 + FTS5 | 上下文感知回忆 |
| **L3** | Persona | 用户画像（偏好/习惯） | SQLite KV | 个性化系统提示 |

### 3.3 核心流程

**写入流程（Capture）**:
```
用户消息 → L0 录制 → [工具调用结束] → L1 提取（LLM）→ L1 去重（向量）→ L1 写入
                                              ↓
                                      [每 N 轮] → L2 场景聚合（LLM）
                                              ↓
                                      [会话结束] → L3 画像更新（LLM）
```

**读取流程（Recall）**:
```
Agent 请求 → 查询 L3（用户偏好）→ 查询 L2（相关场景）→ 查询 L1（事实）
                                              ↓
                                    组装到系统提示 → 注入上下文
```

---

## 四、短期记忆：上下文卸载（Offload）

除了四层长期记忆，项目还提供**短期记忆**方案，解决上下文窗口限制：

### 4.1 符号化卸载

将工具输出等大量内容替换为**符号引用**，而非简单截断：

```typescript
// 卸载前
工具返回：<大量数据>...</大量数据>

// 卸载后
[OFFLOAD:tool_output_abc123](# "共 5432 字，已于 14:32 卸载。引用时自动恢复")
```

### 4.2 三大卸载策略

| 策略 | 说明 | 适用场景 |
|---|---|---|
| **被动卸载** | 上下文超限时触发 | 通用 |
| **主动卸载** | Agent 主动调用 `offload_context` 工具 | Agent 自主管理 |
| **L3 压缩** | 用 LLM 将历史压缩为摘要 | 保留语义，节省 token |

### 4.3 Mermaid 图保护

自动检测 Mermaid 图表，防止卸载破坏图表语法。

---

## 五、技术栈

### 5.1 核心依赖

| 类别 | 技术 | 用途 |
|---|---|---|
| **运行时** | TypeScript + Node.js | 主逻辑 |
| **向量数据库** | sqlite-vec（本地）/ 腾讯云向量数据库（云端） | 向量存储和检索 |
| **全文搜索** | SQLite FTS5 | 关键词搜索 |
| **Embedding** | OpenAI API / 自定义端点 | 向量化 |
| **LLM 调用** | 适配宿主的 LLM Runner | 提取/聚合/压缩 |
| **插件框架** | OpenClaw | 宿主集成 |
| **HTTP 服务** | Express | Gateway 模式 |

### 5.2 存储后端

- **SQLite + sqlite-vec**：本地轻量级方案，适合单机部署
- **腾讯云向量数据库（TCVDB）**：云端分布式方案，适合生产环境

---

## 六、集成方式

### 6.1 OpenClaw 插件模式（主推）

```json
// openclaw.config.json
{
  "plugins": ["tencentdb-agent-memory"],
  "tencentdbAgentMemory": {
    "enable": true,
    "storage": { "type": "sqlite", "path": "./memory.db" },
    "embedding": { "provider": "openai", "model": "text-embedding-3-small" }
  }
}
```

### 6.2 Gateway 模式（远程）

启动 HTTP 网关，供多个 Agent 实例共享记忆：

```bash
npm run gateway
```

### 6.3 Hermes Agent 插件

提供 Python 插件，可直接集成到 Hermes Agent 框架。

---

## 七、核心特性总结

| 特性 | 说明 |
|---|---|
| **四层记忆** | L0~L3 分层存储，从原始对话到用户画像 |
| **100% 可恢复** | L0 完整录制，不依赖摘要 |
| **向量 + FTS5 双检索** | 语义搜索 + 关键词搜索互补 |
| **上下文卸载** | 符号化引用，不丢信息 |
| **多存储后端** | SQLite 本地 / TCVDB 云端 |
| **宿主无关核心** | core/ 层不依赖任何宿主 |
| **HOT 记忆** | 最近 N 轮对话常驻上下文 |
| **检查点** | 标记重要位置，支持回溯 |

---

## 八、与当前项目的关联启示

分析该框架对 `saros-agents-client` 项目的启示：

1. **分层记忆设计**：可为 Agent Studio 引入类似 L0~L3 的分层记忆机制
2. **上下文管理**：Offload 模块的符号化卸载思路可用于解决长对话上下文溢出问题
3. **插件化架构**：`adapters/` 层的设计值得借鉴，可实现与多宿主的解耦
4. **向量检索能力**：可引入类似 sqlite-vec 的本地向量检索能力
5. **工具化记忆操作**：`memory-search` 等工具的设计可作为 Skill 设计的参考

---

*文档由 CodeBuddy AI 自动生成，基于项目源码分析*
