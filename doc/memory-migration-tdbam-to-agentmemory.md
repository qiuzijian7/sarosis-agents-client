# 废弃 TDB-AM 改用 agentmemory 迁移评估方案

> **文档信息**
> - 创建时间：2026-06-26
> - 版本：v1.0
> - 评估目标：废弃 TDB-AM（TencentDB-Agent-Memory）框架，改用 [agentmemory](https://github.com/rohitg00/agentmemory) v0.9.27
> - 关联文档：`memory-optimization-plan-based-on-agentmemory.md`、`memory-optimization-tdbam-impact-assessment.md`、`Memory-Strategy.md`

---

## 一、现状：TDB-AM 集成架构

### 1.1 组件清单

当前 TDB-AM 由 **3 个内置扩展 + vendor 源码 + 主进程子进程** 组成：

| 组件 | 位置 | 作用 |
|------|------|------|
| `tdb-am-gateway` 扩展 | `extensions/tdb-am-gateway/` | Electron 主进程 fork `host.mjs` → 加载 vendor TdaiGateway → HTTP server `127.0.0.1:8420` |
| `tdb-am-memory` 扩展 | `extensions/tdb-am-memory/` | `TdbAmMemoryProvider`（priority=80）→ 桥接 `IMemoryProvider` → gateway HTTP API |
| `tdb-am-viewer` 扩展 | `extensions/tdb-am-viewer/` | 启动 KnotBridge（port 8421）→ OpenAI 兼容接口，供 vendor L1/L2/L3 调用 LLM |
| vendor 源码 | `extensions/tdb-am-gateway/vendor/tdbam/` | 从 TencentDB-Agent-Memory v0.3.5 复制，含 L0/L1/L2/L3 管线、FTS5、VectorStore |
| `product.json` 注册 | 根 `product.json` | `builtInExtensions` + `builtInExtensionsEnabledWithAutoUpdates` 声明 3 个扩展 |
| `agentStudio.contribution.ts` | 行 1344-1365 | 注册 `tdb-am-memory` 为 AgentCapability（capability=memory, priority=80） |
| `agentOSService.ts` | 行 91-115 | 并行 L1/L2/L3 管线（与 vendor pipeline-manager 重叠） |
| KnotBridge | `tdb-am-viewer/src/knotBridge.ts` | Knot → OpenAI 协议适配，vendor 通过它调 LLM |

### 1.2 数据流

```
用户对话
  → agentDriverService.ts (finally 块)
    → writeMemory(agentId, { type:'short_term', content: userMessage })
      → TdbAmMemoryProvider.writeMemory (priority=80 活跃)
        → 缓存 user，等待 assistant
        → POST /capture { user_content, assistant_content, session_key }
          → vendor TdaiGateway
            ├─ L0: l0-recorder.ts → SQLite + JSONL
            ├─ pipeline-manager.ts 调度
            │   ├─ L1: l1-extractor.ts → KnotBridge → LLM → 结构化记忆
            │   ├─ L2: scene-extractor.ts → 场景摘要
            │   └─ L3: persona-generator.ts → 人格画像
            └─ VectorStore: FTS5 + embedding 索引
```

### 1.3 端口占用

| 端口 | 进程 | 用途 |
|------|------|------|
| 8420 | TdaiGateway (host.mjs) | REST API（/capture, /recall, /search, /list, /inject, /distill） |
| 8421 | KnotBridge | OpenAI 兼容接口（vendor LLM 调用） |
| 8520 | Admin Server | /admin/health, /admin/sanitize |

---

## 二、目标：agentmemory 集成架构

### 2.1 agentmemory 组件

| 组件 | 说明 |
|------|------|
| `@agentmemory/agentmemory` | npm 包，CLI + REST server（port 3111）+ viewer（port 3113） |
| `@agentmemory/mcp` | MCP server shim（proxy 模式需要 server 运行，standalone 模式仅 7 工具） |
| iii-engine | Rust 二进制（port 3112 streams + 49134 WebSocket），agentmemory 依赖的运行时 |
| SQLite + KV | agentmemory 内置存储（无需外部 DB） |

### 2.2 端口占用（迁移后）

| 端口 | 进程 | 用途 |
|------|------|------|
| 3111 | agentmemory | REST API + MCP HTTP + /health |
| 3112 | iii-engine | 内部 streams（viewer 消费） |
| 3113 | agentmemory | 实时 viewer（可选，IDE 内可用 webview 替代） |
| 49134 | iii-engine | WebSocket（worker 注册 + OTEL） |

### 2.3 集成路径选择

| 路径 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **A. MCP Server** | 注册 `@agentmemory/mcp` 到 `~/.saros/mcp.json`，LLM 直接调 memory_save/recall 工具 | 复用现有 MCP 基础设施（codebaseMemoryMcpBootstrap 模式）；零 Provider 开发 | 无法控制 writeMemory 时机（LLM 主动调才写）；无 SessionMemoryProvider 兜底；standalone 仅 7 工具 |
| **B. 自定义 Provider** | 写 `AgentMemoryProvider`（priority=80）桥接 `IMemoryProvider` → agentmemory REST API | 完全替代 TdbAmMemoryProvider；自动写入（不依赖 LLM 主动调）；保留 SessionMemoryProvider 兜底 | 需开发 Provider；agentmemory REST API 与 TDB-AM 不同，需适配 |
| **C. 混合** | Provider（自动写入/召回）+ MCP（LLM 主动搜索/遗忘） | 两条路径互补：自动捕获走 Provider，LLM 按需搜索走 MCP | 复杂度高；需协调两条路径的数据一致性 |

**推荐路径 B**：与当前 TDB-AM 集成方式一致（Provider 模式），迁移成本最低，且保留 SessionMemoryProvider 兜底。MCP 工具可作为 P2 阶段补充。

---

## 三、迁移方案

### 3.1 需要移除的组件

| 组件 | 操作 | 理由 |
|------|------|------|
| `extensions/tdb-am-gateway/` | 删除整个目录 | agentmemory 自带 server，不需要 host.mjs + vendor |
| `extensions/tdb-am-memory/` | 删除整个目录 | 被 AgentMemoryProvider 替代 |
| `extensions/tdb-am-viewer/` | 删除整个目录 | agentmemory 自带 viewer（port 3113） |
| `product.json` 中 3 个 tdb-am 条目 | 从 `builtInExtensions` + `builtInExtensionsEnabledWithAutoUpdates` 移除 | 不再内置 |
| `agentStudio.contribution.ts` 行 1344-1365 | 移除 tdb-am-memory AgentCapability 注册 | 被 AgentMemoryProvider 替代 |
| `agentOSService.ts` L1/L2/L3 管线 | 禁用或移除 `triggerL1Extraction`/`triggerL2Extraction`/`triggerL3Extraction` | agentmemory 有自己的 4-tier consolidation pipeline |
| `memoryDetailEditorPane.ts` 中 TDB-AM 特有逻辑 | 移除端口 8420 检查 | 改为通过 IMemoryProvider 接口统一 |
| `tdbam.*` 配置项 | 从 `tdb-am-viewer/package.json` contributes.configuration 移除 | 不再需要 |

### 3.2 需要新增的组件

| 组件 | 位置 | 作用 |
|------|------|------|
| `extensions/agentmemory-gateway/` | 新建扩展 | Electron 主进程启动 agentmemory server（替代 host.mjs） |
| `extensions/agentmemory-gateway/host.mjs` | 新建 | spawn `npx @agentmemory/agentmemory` 或本地 iii-engine |
| `extensions/agentmemory-memory/` | 新建扩展 | `AgentMemoryProvider`（priority=80）桥接 IMemoryProvider → agentmemory REST |
| `agentmemory-memory/src/memoryProvider.ts` | 新建 | `AgentMemoryProvider` 实现 |
| `product.json` | 修改 | 添加 agentmemory-gateway + agentmemory-memory 到 builtInExtensions |
| `agentStudio.contribution.ts` | 修改 | 注册 agentmemory-memory 为 AgentCapability（priority=80） |
| iii-engine 二进制 | 安装到 `%USERPROFILE%\.local\bin\iii.exe` | agentmemory 运行时依赖 |
| `~/.saros/mcp.json` | 可选 | 注册 `@agentmemory/mcp`（P2 阶段，LLM 主动搜索用） |

### 3.3 AgentMemoryProvider 设计

替代 `TdbAmMemoryProvider`，桥接 `IMemoryProvider` → agentmemory REST API（port 3111）：

```typescript
// extensions/agentmemory-memory/src/memoryProvider.ts

const DEFAULT_AGENTMEMORY_URL = 'http://127.0.0.1:3111';

export class AgentMemoryProvider implements IMemoryProvider {
  readonly id = 'agentmemory';
  readonly name = 'AgentMemory';

  // ── loadContext: 召回记忆 ──
  // POST /agentmemory/smart-search → hybrid search (BM25 + vector + graph)
  // POST /agentmemory/context → 生成上下文块
  async loadContext(agentId, sessionId, query?, options?): Promise<IMemoryContext> {
    const project = this._deriveProject(agentId);

    if (query && query.trim()) {
      // 语义搜索召回
      const resp = await this._postJson('/agentmemory/smart-search', {
        project,
        query,
        limit: 10,
      });
      const longTerm = (resp?.results ?? []).map(r => ({
        id: r.observation.id,
        type: 'long_term' as const,
        content: this._formatObservation(r.observation),
        timestamp: new Date(r.observation.timestamp).getTime(),
        score: r.combinedScore,
        metadata: {
          source: 'agentmemory_smart_search',
          bm25Score: r.bm25Score,
          vectorScore: r.vectorScore,
          graphScore: r.graphScore,
        },
      }));
      return { shortTermMemories: [], longTermMemories: longTerm, systemPrompt: undefined };
    }

    // 无 query → 加载项目 profile
    const profile = await this._getJson(`/agentmemory/profile?project=${project}`);
    return {
      shortTermMemories: [],
      longTermMemories: profile ? [{
        id: `agentmemory-profile-${Date.now()}`,
        type: 'long_term',
        content: profile.summary || '',
        timestamp: Date.now(),
      }] : [],
      systemPrompt: undefined,
    };
  }

  // ── writeMemory: 捕获观察 ──
  // POST /agentmemory/observe → 记录观察
  // POST /agentmemory/remember → 保存长期记忆
  async writeMemory(agentId, entry): Promise<void> {
    const project = this._deriveProject(agentId);
    const sessionId = (entry.metadata?.['sessionId'] as string) ?? `agent:${agentId}`;

    if (entry.type === 'short_term') {
      // 短期记忆 → /observe（L0 捕获，触发自动压缩 + embedding）
      await this._postJson('/agentmemory/observe', {
        sessionId,
        project,
        hookType: 'post_tool_use',
        toolName: entry.metadata?.['toolName'] as string ?? 'conversation',
        toolOutput: entry.content,
        timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
      });
    } else {
      // 长期记忆 → /remember（直接写入 L1）
      await this._postJson('/agentmemory/remember', {
        project,
        sessionId,
        type: this._mapMemoryType(entry.metadata?.['type']),
        title: (entry.content ?? '').slice(0, 80),
        content: entry.content,
        concepts: (entry.metadata?.['concepts'] as string[]) ?? [],
        files: (entry.metadata?.['files'] as string[]) ?? [],
        importance: entry.importance ?? 5,
      });
    }
  }

  // ── searchMemory: 搜索记忆 ──
  async searchMemory(agentId, query): Promise<IMemoryEntry[]> {
    if (!query?.trim()) {
      // 空查询 → 列出最近记忆
      const resp = await this._getJson('/agentmemory/memories/latest');
      return (resp?.memories ?? []).map(m => ({
        id: m.id,
        type: 'long_term',
        content: m.content,
        timestamp: new Date(m.createdAt).getTime(),
      }));
    }
    const resp = await this._postJson('/agentmemory/smart-search', {
      project: this._deriveProject(agentId),
      query,
      limit: 20,
    });
    return (resp?.results ?? []).map(r => ({
      id: r.observation.id,
      type: 'long_term',
      content: this._formatObservation(r.observation),
      timestamp: new Date(r.observation.timestamp).getTime(),
      score: r.combinedScore,
    }));
  }

  private _deriveProject(agentId: string): string {
    return `agent:${agentId}`;
  }

  private _mapMemoryType(type?: string): string {
    const map: Record<string, string> = {
      'long_term': 'fact',
      'pattern': 'pattern',
      'preference': 'preference',
      'architecture': 'architecture',
      'bug': 'bug',
      'workflow': 'workflow',
    };
    return map[type ?? ''] ?? 'fact';
  }

  private _formatObservation(obs: any): string {
    const parts = [obs.title];
    if (obs.subtitle) parts.push(obs.subtitle);
    if (obs.facts?.length) parts.push(obs.facts.join('; '));
    if (obs.narrative) parts.push(obs.narrative);
    return parts.join('\n');
  }
}
```

### 3.4 agentmemory-gateway 扩展设计

替代 `tdb-am-gateway`，Electron 主进程启动 agentmemory server：

```javascript
// extensions/agentmemory-gateway/host/host.mjs

import { spawn } from 'node:child_process';
import * as path from 'node:path';

// agentmemory 可通过 npx 或本地安装启动
// 优先用本地安装的 iii-engine + agentmemory
const AGENTMEMORY_CMD = process.env.AGENTMEMORY_CMD || 'npx';
const AGENTMEMORY_ARGS = ['-y', '@agentmemory/agentmemory'];

const child = spawn(AGENTMEMORY_CMD, AGENTMEMORY_ARGS, {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    III_REST_PORT: '3111',
    AGENTMEMORY_VIEWER_PORT: '3113',
    // LLM provider: 复用项目已有的 Knot/CodeBuddy 网关
    OPENAI_BASE_URL: process.env.AGENTMEMORY_LLM_BASE_URL || 'http://127.0.0.1:8421/v1',
    OPENAI_API_KEY: process.env.AGENTMEMORY_LLM_API_KEY || 'saros-knot-bridge-token',
    OPENAI_MODEL: process.env.AGENTMEMORY_LLM_MODEL || 'knot-default',
    // 本地 embedding（离线免费）
    EMBEDDING_PROVIDER: 'local',
    // 数据目录
    AGENTMEMORY_EXPORT_ROOT: path.join(process.env.HOME || process.env.USERPROFILE, '.saros', '.agentmemory'),
  },
});

// 等待 server 就绪（轮询 /agentmemory/health）
// 输出结构化 JSON 行（与 host.mjs 相同协议）
```

---

## 四、数据迁移

### 4.1 TDB-AM 数据位置

```
~/.saros/.tdai/
├── conversations/          # L0 JSONL
│   └── YYYY-MM-DD.jsonl
├── l0_conversations.db      # L0 SQLite
├── records/                 # L1 结构化记忆
├── scene_blocks/            # L2 场景块
├── persona/                 # L3 人格
├── vectors.db               # FTS5 + embedding 索引
└── manifest.json
```

### 4.2 agentmemory 数据位置

```
~/.saros/.agentmemory/
├── sessions/                # 会话记录
├── observations/            # 观察记录
├── memories/                # 长期记忆
├── summaries/               # 会话摘要
├── graph/                   # 知识图谱
├── vectors/                 # 向量索引
└── snapshots/               # git 快照
```

### 4.3 迁移脚本

需要编写一次性迁移脚本 `scripts/migrate-tdbam-to-agentmemory.mjs`：

| TDB-AM 数据 | agentmemory 目标 | 迁移方式 |
|-------------|-----------------|----------|
| L0 conversations JSONL | `POST /agentmemory/observe`（逐条） | 脚本读取 JSONL → 调 REST API |
| L1 records | `POST /agentmemory/remember` | 脚本读取 records → 调 REST API |
| L2 scene_blocks | `POST /agentmemory/remember`（type=workflow） | 脚本读取 → 调 REST API |
| L3 persona | `POST /agentmemory/remember`（type=preference） | 脚本读取 → 调 REST API |
| vectors.db | 重建（agentmemory 启动时自动 reindex） | 无需迁移，启动后自动重建 |

**迁移策略**：
- 首次启动 agentmemory 后执行迁移脚本
- 迁移完成后保留 TDB-AM 数据目录（备份），不立即删除
- 确认无问题后手动清理 `~/.saros/.tdai/`

---

## 五、能力对比

### 5.1 迁移后能力变化

| 能力 | TDB-AM（当前） | agentmemory（迁移后） | 变化 |
|------|---------------|----------------------|------|
| **关键词搜索** | SQLite FTS5 | BM25（k1=1.2, b=0.75）+ 词干化 + 同义词 + CJK 分词 | ➕ 增强（BM25 比 FTS5 更可控） |
| **向量搜索** | KnotBridge → OpenAI embedding | 本地 all-MiniLM-L6-v2（384 维，离线免费） | ➕ 增强（离线、免费、无 API 依赖） |
| **图搜索** | ❌ 无 | 知识图谱 BFS 遍历 + 实体匹配 | ➕ 新增 |
| **混合搜索** | VectorStore 内部融合 | RRF（k=60）三流加权融合 | ➕ 增强（成熟 RRF 算法） |
| **L0 捕获** | auto-capture hook | 12 hook（SessionStart/PreToolUse/PostToolUse/Stop...） | ➕ 增强（更细粒度） |
| **L1 提取** | l1-extractor + pipeline-manager | compress + consolidation-pipeline | ➡️ 对等 |
| **L2 场景** | scene-extractor | episodic tier（会话摘要） | ➡️ 对等 |
| **L3 人格** | persona-generator | ❌ 无直接对应 | ➖ 退化（agentmemory 无 L3 人格层） |
| **4 层固化** | L0→L1→L2→L3 | Working→Episodic→Semantic→Procedural | ➕ 增强（Semantic + Procedural 是新层） |
| **记忆衰减** | ❌ 无 | Ebbinghaus 曲线 + auto-forget | ➕ 新增 |
| **矛盾检测** | l1-dedup（vector + keyword） | supersedes 链 + contradicts 关系 | ➕ 增强 |
| **隐私过滤** | stripUndefinedLiterals（仅 "undefined"） | 15+ 正则模式剥离 API key/secret/token | ➕ 显著增强 |
| **知识图谱** | ❌ 无 | 实体抽取 + BFS + 时态查询 | ➕ 新增 |
| **会话回放** | ❌ 无 | 时间线 scrub + play/pause | ➕ 新增 |
| **实时查看器** | TdbamViewPane（侧栏面板） | port 3113 viewer（web 应用） | ➡️ 对等（但形态不同） |
| **审计 trail** | ❌ 无 | 30+ 操作类型 audit entry | ➕ 新增 |
| **git 快照** | ❌ 无 | 版本/回滚/diff | ➕ 新增 |
| **团队记忆** | ❌ 无 | namespaced shared + private | ➕ 新增 |
| **基准测试** | ❌ 无 | LongMemEval-S R@5=95.2% | ➕ 新增 |
| **跨 agent** | ❌ 仅 VS Code 内 | MCP + REST（任何 MCP client） | ➕ 新增 |
| **Windows 支持** | ✅ Node 子进程 | ⚠️ iii-engine 需手动安装二进制 | ➖ 退化（Windows 需额外步骤） |
| **LLM 依赖** | KnotBridge（port 8421） | OpenAI 兼容接口（可复用 KnotBridge） | ➡️ 对等 |
| **测试覆盖** | vendor 内部测试 | 1,423+ 测试 | ➕ 增强 |

### 5.2 关键退化点

| 退化 | 影响 | 缓解措施 |
|------|------|----------|
| **L3 人格层缺失** | agentmemory 无 persona-generator，无法自动生成用户画像 | 用 agentmemory 的 `memory_remember`（type=preference）手动写入人格记忆；或在 AgentMemoryProvider 中增加 L3 逻辑 |
| **Windows iii-engine 安装** | 用户需手动下载 iii.exe 放到 PATH | 在 `agentmemory-gateway` 扩展中自动检测 + 一键安装（参考 codebaseMemoryMcpService 的安装流程） |
| **KnotBridge 兼容性** | agentmemory 期望 OpenAI 兼容接口，KnotBridge 已提供 | 复用现有 KnotBridge（port 8421），配置 `OPENAI_BASE_URL=http://127.0.0.1:8421/v1` |
| **端口变化** | 8420→3111, 8421 保留 | 需更新配置项 `agentmemory.gatewayPort` |

---

## 六、分阶段迁移计划

### Phase 0 — 准备（1 天）

| 任务 | 产出 |
|------|------|
| 安装 iii-engine 到开发环境 | `iii --version` 输出 0.11.2 |
| 本地启动 agentmemory 验证 | `npx @agentmemory/agentmemory` → http://localhost:3113 可访问 |
| 验证 KnotBridge 兼容性 | agentmemory 用 KnotBridge 调 LLM 成功 |
| 编写 AgentMemoryProvider 原型 | 能完成 loadContext + writeMemory + searchMemory |

### Phase 1 — 新增 agentmemory 集成（3 天）

| 任务 | 产出 |
|------|------|
| 创建 `extensions/agentmemory-gateway/` 扩展 | host.mjs 启动 agentmemory server |
| 创建 `extensions/agentmemory-memory/` 扩展 | AgentMemoryProvider 实现 |
| 注册到 `product.json` builtInExtensions | 2 个新扩展 |
| 注册到 `agentStudio.contribution.ts` | AgentCapability priority=80 |
| 配置项 `agentmemory.*` | gatewayPort, viewerPort, llmBaseUrl 等 |
| **TDB-AM 与 agentmemory 并行运行**（TDB-AM priority=80, agentmemory priority=70） | 验证 agentmemory 功能正常 |

### Phase 2 — 数据迁移 + 切换（2 天）

| 任务 | 产出 |
|------|------|
| 编写迁移脚本 `migrate-tdbam-to-agentmemory.mjs` | TDB-AM 数据导入 agentmemory |
| 执行迁移 | 迁移日志显示成功 |
| 切换 priority：agentmemory=80, TDB-AM 降为 50（或禁用） | agentmemory 成为活跃 Provider |
| 验证回归：记忆写入/搜索/召回正常 | 测试通过 |
| 禁用 agentOSService L1/L2/L3 管线 | 避免与 agentmemory consolidation 冲突 |

### Phase 3 — 清理 TDB-AM（1 天）

| 任务 | 产出 |
|------|------|
| 从 `product.json` 移除 3 个 tdb-am 扩展 | builtInExtensions 清理 |
| 从 `agentStudio.contribution.ts` 移除 tdb-am-memory 注册 | AgentCapability 清理 |
| 删除 `extensions/tdb-am-gateway/` | 目录删除 |
| 删除 `extensions/tdb-am-memory/` | 目录删除 |
| 删除 `extensions/tdb-am-viewer/` | 目录删除 |
| 移除 `agentOSService.ts` 中 L1/L2/L3 管线代码 | 代码清理 |
| 移除 `memoryDetailEditorPane.ts` 中 TDB-AM 特有逻辑 | 代码清理 |
| 保留 `~/.saros/.tdai/` 作为备份 | 数据备份 |

### Phase 4 — 增强（可选，3 天）

| 任务 | 产出 |
|------|------|
| 注册 `@agentmemory/mcp` 到 `~/.saros/mcp.json` | LLM 可主动调 memory_recall/memory_save |
| agentmemory viewer 集成到 IDE（webview 嵌入 port 3113） | 实时查看器 |
| 配置 auto-capture hooks（PreToolUse/PostToolUse） | 自动捕获 |
| 配置 memory decay + auto-forget | 记忆生命周期 |
| 配置 knowledge graph extraction | 知识图谱 |

---

## 七、风险评估

### 7.1 高风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| **iii-engine Windows 不兼容** | 中 | 高 — agentmemory 无法启动 | ① 自动检测 iii.exe + 一键安装 ② 降级到 SessionMemoryProvider ③ standalone MCP 模式（7 工具） |
| **数据迁移丢失** | 低 | 高 — 历史记忆不可恢复 | ① 迁移前备份 `~/.saros/.tdai/` ② 迁移脚本 dry-run 模式 ③ 迁移后对比记忆数量 |
| **agentmemory server 启动慢** | 中 | 中 — IDE 启动延迟 | ① 异步启动（不阻塞 IDE） ② 健康检查超时后降级到 SessionMemoryProvider |
| **KnotBridge 与 agentmemory 不兼容** | 低 | 高 — LLM 调用失败 | ① Phase 0 验证 ② agentmemory 支持 OPENAI_BASE_URL 自定义 ③ 可用本地 Ollama 替代 |

### 7.2 中风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| **agentmemory REST API 变更** | 低 | 中 — Provider 适配失效 | ① 锁定 agentmemory 版本 ② Provider 加 API 版本检查 |
| **iii-engine 版本锁定** | 中 | 中 — 升级风险 | ① pin iii-engine v0.11.2 ② 文档记录版本约束 |
| **L3 人格层缺失** | 高 | 低 — 用户体验退化 | ① 用 memory_remember(type=preference) 替代 ② 后续在 Provider 中补 L3 逻辑 |
| **端口冲突** | 低 | 低 — 启动失败 | 配置项可覆盖端口 |

### 7.3 低风险

| 风险 | 说明 |
|------|------|
| **vendor 源码删除后编译失败** | tdb-am 扩展删除后需重新编译 |
| **配置项残留** | tdbam.* 配置项需清理，但不影响功能 |
| **agentOSService L1/L2/L3 移除** | 已有 feature flag 控制 |

---

## 八、回滚方案

如果迁移后发现问题，可快速回滚：

### 8.1 快速回滚（< 5 分钟）

1. 从 `product.json` 恢复 3 个 tdb-am 扩展条目
2. 从 `agentStudio.contribution.ts` 恢复 tdb-am-memory 注册
3. 调整 priority：TDB-AM=80, agentmemory=50（或移除）
4. 重启 IDE

### 8.2 数据回滚

- TDB-AM 数据保留在 `~/.saros/.tdai/`（Phase 3 未删除）
- agentmemory 数据在 `~/.saros/.agentmemory/`（可保留或删除）

### 8.3 完全回滚

```bash
# 恢复 git 状态
git checkout HEAD -- product.json agentStudio.contribution.ts
# 重新编译
cd extensions/tdb-am-gateway && npm run compile
cd extensions/tdb-am-memory && npm run compile
cd extensions/tdb-am-viewer && npm run compile
```

---

## 九、成本估算

| 阶段 | 工时 | 人力 |
|------|------|------|
| Phase 0 准备 | 1 天 | 1 人 |
| Phase 1 新增集成 | 3 天 | 1 人 |
| Phase 2 数据迁移 + 切换 | 2 天 | 1 人 |
| Phase 3 清理 TDB-AM | 1 天 | 1 人 |
| Phase 4 增强（可选） | 3 天 | 1 人 |
| **合计** | **10 天**（不含 Phase 4） | |

---

## 十、决策矩阵

| 维度 | 保持 TDB-AM | 迁移到 agentmemory |
|------|-------------|-------------------|
| **搜索质量** | FTS5（够用但无图搜索） | BM25+Vector+Graph RRF（95.2% R@5） |
| **记忆生命周期** | 无衰减、无遗忘 | Ebbinghaus 衰减 + auto-forget |
| **隐私安全** | 仅剥离 "undefined" | 15+ 正则剥离 API key/secret |
| **知识图谱** | 无 | 实体 + 关系 + BFS |
| **可观测性** | TdbamViewPane（基础） | viewer 3113 + session replay + audit |
| **跨 agent** | 仅 VS Code | MCP + REST（任意 client） |
| **测试覆盖** | vendor 内部 | 1,423+ 测试 + 基准 |
| **Windows 支持** | ✅ 原生 | ⚠️ 需手动安装 iii-engine |
| **维护成本** | vendor 源码内嵌（无法升级） | npm 包（可升级） |
| **社区活跃度** | 内部项目 | 开源（Apache-2.0，活跃维护） |
| **LLM 依赖** | KnotBridge | OpenAI 兼容（可复用 KnotBridge） |
| **L3 人格** | ✅ 有 | ❌ 无（需自行补充） |
| **迁移成本** | — | 10 天 |

---

## 十一、结论与建议

### 11.1 建议：迁移到 agentmemory

**理由**：
1. **搜索质量显著提升**：BM25+Vector+Graph RRF 融合 vs FTS5，有 95.2% R@5 基准验证
2. **记忆生命周期完善**：衰减 + 遗忘 + 矛盾检测，解决 TDB-AM 记忆无限累积问题
3. **隐私安全补齐**：15+ 正则剥离 API key，解决 TDB-AM 仅剥离 "undefined" 的安全短板
4. **知识图谱新增**：实体 + 关系 + BFS，TDB-AM 完全没有
5. **可维护性提升**：npm 包可升级 vs vendor 源码内嵌无法升级
6. **社区生态**：开源 Apache-2.0，1,423+ 测试，活跃维护

### 11.2 迁移前提条件

1. **iii-engine Windows 安装自动化** — 必须解决，否则 Windows 用户无法使用
2. **Phase 0 验证通过** — 本地启动 agentmemory + KnotBridge 兼容性验证
3. **数据迁移脚本 dry-run 通过** — 确保不丢数据

### 11.3 迁移后待补充

1. **L3 人格层** — agentmemory 无此能力，需在 AgentMemoryProvider 中自行实现
2. **agentOSService L1/L2/L3 移除** — 避免与 agentmemory consolidation pipeline 冲突
3. **查看器适配** — 通过 IMemoryProvider 接口统一数据源

---

*本文档基于 TDB-AM 集成源码（`extensions/tdb-am-*/`、`vendor/tdbam/`、`agentOSService.ts`、`slotRegistry.ts`）和 agentmemory v0.9.27 源码分析编写。*
