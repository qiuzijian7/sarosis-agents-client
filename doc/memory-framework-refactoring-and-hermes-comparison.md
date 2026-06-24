# Saros 记忆框架重构总结与 Hermes 对比

## 文档信息
- **创建时间**: 2026-06-23
- **版本**: v1.0
- **作者**: AI Assistant
- **适用范围**: Saros Agents Client 记忆系统设计参考

---

## 一、重构后的 Saros 记忆框架

### 1.1 核心设计理念

重构后的记忆系统基于以下核心原则：

1. **基于 Agent 管理**：记忆完全基于 `agentId` 管理，不依赖工作区
2. **跨工作区共享**：同一个 Agent 在不同工作区中共享同一份记忆
3. **统一命名规范**：所有相关命名统一为 `saros`（替换旧 `sarosis`）
4. **全局存储根目录**：使用 `IEnvironmentService.userRoamingDataHome` 作为根目录

### 1.2 存储架构

#### 1.2.1 文件布局

```
<userRoamingDataHome>/.saros/memory/<agentId>/
├── short-term.jsonl    # 短期记忆（环形缓冲，默认200条上限）
└── long-term.jsonl     # 长期记忆（无上限）
```

**路径说明**：
- `<userRoamingDataHome>`：桌面端等价 `%APPDATA%/Code-OSS-Dev/User`，Web 端是 indexedDB-backed 路径
- `<agentId>`：Agent 唯一标识，特殊字符自动替换为下划线
- 文件格式：JSONL（JSON Lines），每行一个 JSON 对象

#### 1.2.2 记忆层级

| 层级 | 文件 | 容量策略 | 用途 |
|------|------|----------|------|
| 短期记忆 | `short-term.jsonl` | 环形缓冲，FIFO 丢弃，默认 200 条 | 最近对话上下文、临时信息 |
| 长期记忆 | `long-term.jsonl` | 无上限，追加写入 | 重要事实、用户偏好、学习成果 |

### 1.3 核心接口与实现

#### 1.3.1 IMemoryProvider 接口

```typescript
export interface IMemoryProvider {
  id: string;
  name: string;
  
  // 加载记忆上下文
  loadContext(agentId: string, sessionId: string): Promise<IMemoryContext>;
  
  // 写入记忆条目
  writeMemory(agentId: string, entry: IMemoryEntry): Promise<void>;
  
  // 搜索记忆
  searchMemory(agentId: string, query: string): Promise<IMemoryEntry[]>;
}
```

#### 1.3.2 IMemoryEntry 结构

```typescript
export interface IMemoryEntry {
  id: string;
  type: 'short_term' | 'long_term';
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}
```

#### 1.3.3 SessionMemoryProvider 实现特性

1. **写入优化**：
   - 文件 < 1 MB 时直接全量重写
   - 文件 > 1 MB 时走追加写
   - 避免 `VSBuffer.concat` 多次拷贝大文件

2. **短期记忆管理**：
   - 环形容量上限（默认 200 条）
   - 超出按 FIFO 丢弃
   - 每次写入重新读写整个文件（保证顺序）

3. **搜索功能**：
   - 支持 `tag:foo` / `type:short` 形式的简易过滤前缀
   - 文本匹配（大小写不敏感）
   - 按时间戳降序排序

4. **系统提示构建**：
   - 自动从长期记忆和短期记忆构建系统提示
   - 长期记忆取最后 10 条
   - 短期记忆取最后 15 条
   - 每条内容截断到 240 字符

### 1.4 记忆召回作用域

#### 1.4.1 配置结构

```typescript
export interface AgentMemoryConfig {
  enabled: boolean;
  maxEntries: number;
  strategy: 'summary' | 'full' | 'sliding_window';
  windowSize?: number;
  
  /**
   * 召回作用域：
   *   - 'agent'   → 仅当前 Agent 的 L1 记忆（最严格隔离）
   *   - 'global'  → 整个记忆库（跨 Agent 共享）
   */
  scope?: 'agent' | 'global';
  
  entries: Array<{
    id: string;
    key: string;
    value: string;
    category?: string;
    createdAt?: string;
    updatedAt?: string;
  }>;
}
```

#### 1.4.2 作用域说明

| 作用域 | 说明 | 使用场景 |
|--------|------|----------|
| `agent` | 仅加载当前 Agent 自己的记忆 | 需要严格隔离的场景（默认） |
| `global` | 加载所有 Agent 的记忆 | 需要跨 Agent 知识共享的场景 |

**注意**：原设计中的 `workspace` 作用域已被移除，因为记忆系统已改为完全基于 Agent 管理。

### 1.5 Agent ID 与 User ID 的概念差异

#### 1.5.1 Agent ID

- **定义**：Agent 的唯一标识符
- **作用**：区分不同的 Agent 实例（如 coder、planner、reviewer）
- **记忆隔离**：基于 `agentId` 进行记忆隔离
- **跨工作区**：同一 `agentId` 在不同工作区共享记忆
- **示例**：`coder`、`planner-v2`、`my-custom-agent`

#### 1.5.2 User ID（未来扩展）

- **定义**：用户的唯一标识符
- **作用**：区分不同的用户（多用户环境）
- **记忆隔离**：未来可能支持基于 `userId` 的记忆隔离
- **当前状态**：项目中尚未明确实现 `userId` 概念
- **设计建议**：
  - 单用户场景：无需 `userId`，直接使用 `agentId` 管理记忆
  - 多用户场景：存储路径改为 `<userRoamingDataHome>/saros/memory/<userId>/<agentId>/`

### 1.6 预设 Agent 存储路径优化

#### 1.6.1 优化前（存在问题）

1. **命名不一致**：
   - 全局数据根目录名为 `agent-studio`
   - 与统一命名 `saros` 冲突

2. **路径 BUG**：
   - 旧 `LocalFileMemory` 使用相对路径存储记忆
   - 导致路径不确定、跨工作区无法共享

#### 1.6.2 优化后（当前实现）

1. **统一命名**：
   - 全局数据根目录：`.saros`（隐藏目录形式）
   - 记忆存储路径：`<userRoamingDataHome>/.saros/memory/<agentId>/`

2. **绝对路径**：
   - 使用 `URI.joinPath(this.environmentService.userRoamingDataHome, '.saros', 'memory', safe, fileName)`
   - 确保跨平台、跨 web/desktop 都可用

3. **安全的 Agent ID**：
  - 过滤特殊字符：`agentId.replace(/[^A-Za-z0-9_.-]/g, '_')`
  - 防止路径注入攻击

---

## 二、Hermes 记忆系统分析

### 2.1 Hermes 简介

**Hermes Agent** 是 **Nous Research** 于 2026 年 2 月发布的开源 AI Agent 框架，核心特性包括：

- **自我进化**：具备自动学习进化能力
- **持久记忆**：记住用户偏好、项目、环境以及所学知识
- **技能自动学习**：将成功的工作流转化为可复用技能
- **模型无关**：支持 200+ 大模型
- **多平台适配**：接入 15+ 消息平台（Telegram、Discord、Slack 等）

### 2.2 Hermes 记忆系统架构

#### 2.2.1 存储布局（基于代码分析）

**核心存储路径**（`tools/memory_tool.py` 第 55-57 行）：
```python
def get_memory_dir() -> Path:
    """Return the profile-scoped memories directory."""
    return get_hermes_home() / "memories"
```

**实际文件结构**：
```
~/.hermes/memories/
├── MEMORY.md          # Agent 的个人笔记和观察（长期记忆）
└── USER.md            # 关于用户的信息（用户画像）
```

**文件格式细节**：
- **格式**：Markdown (`.md`)，非 JSONL
- **条目分隔符**：`§` (SECTION SIGN, U+00A7)
- **字符限制**（`tools/memory_tool.py` 第 124 行）：
  - `MEMORY.md`：2200 字符
  - `USER.md`：1375 字符

**读取逻辑**（`tools/memory_tool.py` 第 626-645 行）：
```python
@staticmethod
def _read_file(path: Path) -> List[str]:
    """Read a memory file and split into entries."""
    if not path.exists():
        return []
    raw = path.read_text(encoding="utf-8")
    
    # 使用 ENTRY_DELIMITER (§) 分割条目
    entries = [e.strip() for e in raw.split(ENTRY_DELIMITER)]
    return [e for e in entries if e]
```

**写入逻辑**（`tools/memory_tool.py` 第 702-731 行）：
- 原子写入：先写临时文件，再重命名
- 文件锁定：跨平台文件锁（Unix: `fcntl`, Windows: `msvcrt`）
- 持久化：`fsync` 确保数据写入磁盘

#### 2.2.2 记忆管理方式

**内置记忆系统**（`tools/memory_tool.py` 第 124 行）：
```python
class MemoryStore:
    def __init__(self, memory_char_limit: int = 2200, user_char_limit: int = 1375):
        self.memory_char_limit = memory_char_limit  # MEMORY.md 限制
        self.user_char_limit = user_char_limit      # USER.md 限制
```

**管理方式**：
1. **工具驱动**：Agent 通过 `memory` 工具管理记忆
   - `remember`：添加或更新记忆
   - `remembers`：批量添加记忆
   - `forget`：删除记忆
   - `context`：查看当前记忆上下文

2. **操作类型**：
   - 添加新条目（追加到文件末尾）
   - 替换现有条目（按索引或内容匹配）
   - 删除条目（按索引）

3. **注入时机**：会话开始时加载（`load_from_disk()`）
   - 冻结快照模式：会话期间记忆不变
   - 下次会话生效：中途写入只在下次会话开始时效

4. **快照机制**（`tools/memory_tool.py` 第 567-578 行）：
```python
def format_for_system_prompt(self, target: str) -> Optional[str]:
    """
    Return the frozen snapshot for system prompt injection.
    
    This returns the state captured at load_from_disk() time, NOT the live
    state. Mid-session writes do not affect this. This keeps
    the KV cache prefix stable across turns.
    """
```

#### 2.2.3 外部记忆提供商（向量检索）

Hermes 支持外部记忆提供商，提供向量检索能力（`agent/system_prompt.py`）：

| 提供商 | 类型 | 特性 |
|--------|------|------|
| **Honcho** | 向量数据库 | 语义搜索、用户画像 |
| **Hindsight** | 向量数据库 | 长期记忆检索 |
| **Mem0** | 向量数据库 | 记忆管理、自动提取 |
| **Supermemory** | 向量数据库 | 高性能向量检索 |

**注入方式**（`agent/system_prompt.py` 第 423-443 行）：
```python
# 外部记忆提供商的系统提示块
if agent._memory_manager:
    _ext_mem_block = agent._memory_manager.build_system_prompt()
    if _ext_mem_block:
        volatile_parts.append(_ext_mem_block)
```

### 2.3 Hermes 记忆系统实际实现

**修正说明**：经代码分析，Hermes 并未实现最初公开资料中提到的"四层内存系统（L0-L3）"，而是采用了更实用的**双文件设计**：

| 文件 | 用途 | 字符限制 | 注入位置 |
|------|------|----------|----------|
| `MEMORY.md` | Agent 的长期记忆（观察、事实、经验） | 2200 字符 | `<memory_context>` 块 |
| `USER.md` | 用户画像（偏好、沟通风格、背景） | 1375 字符 | `<user_context>` 块 |

**与公开资料的差异**：
- ❌ **未实现**：四层内存系统（L0-L3）
- ✅ **已实现**：双文件设计 + 外部向量记忆提供商
- ✅ **已实现**：冻结快照注入（保证 KV cache 稳定）

**设计优势**：
1. **简单有效**：Markdown 格式人类可读、可编辑
2. **字符限制**：防止记忆膨胀，强制 Agent 精简重要内容
3. **外部扩展**：通过向量数据库提供商实现语义检索
4. **冻结语义**：会话期间记忆不变，避免上下文抖动

---

## 三、Saros 与 Hermes 记忆系统对比

### 3.1 架构对比

| 维度 | Saros | Hermes | 备注 |
|------|-------|--------|------|
| **记忆管理单位** | 基于 Agent（`agentId`） | 基于 Agent + Profile | Hermes 支持多 Profile 隔离 |
| **跨工作区共享** | ✅ 原生支持（同一 Agent 跨工作区共享记忆） | ✅ 支持（基于 Agent 管理） | 通过 `~/.hermes/memories/` 共享 |
| **存储位置** | `<userRoamingDataHome>/.saros/memory/` | `~/.hermes/memories/` | Hermes 路径硬编码 |
| **文件格式** | JSONL（每行一个 JSON） | Markdown（`.md`，使用 `§` 分隔符） | Hermes 格式人类可读 |
| **层级设计** | 两层（短期 + 长期） | 双文件设计（MEMORY.md + USER.md） | Hermes 未实现四层架构 |
| **字符限制** | 无限制（依赖环形缓冲） | MEMORY.md: 2200 字符, USER.md: 1375 字符 | Hermes 强制精简 |
| **向量检索** | ❌ 当前未实现（计划中） | ✅ 通过外部提供商（Mem0, Honcho 等） | Saros 计划实现 |

### 3.2 记忆注入方式对比

| 维度 | Saros | Hermes |
|------|-------|--------|
| **注入时机** | 每次请求加载（通过 `loadContext`） | 会话开始时以冻结快照注入 |
| **注入形式** | 作为 `IMemoryContext.systemPrompt` 注入 | 作为系统提示的一部分注入 |
| **动态更新** | ✅ 支持（每次请求重新加载） | ❌ 不支持（快照机制，会话期间不变） |
| **更新方式** | 自动（基于写入策略） | 手动（通过 `memory` 工具） |

**分析**：

1. **Saros 的优势**：
   - 动态更新：每次请求都重新加载记忆，能立即反映最新的记忆变化
   - 自动化：无需 Agent 主动调用工具，由框架自动管理

2. **Hermes 的优势**：
   - 快照稳定性：会话期间记忆不变，避免对话过程中的上下文抖动
   - 显式控制：Agent 通过工具显式管理记忆，更可控

3. **改进建议**：
   - Saros 可以增加**会话级缓存**，避免同一会话内的重复加载
   - 提供**显式记忆管理工具**，让 Agent 能主动添加/删除记忆

### 3.3 记忆召回作用域对比

| 维度 | Saros | Hermes | 备注 |
|------|-------|--------|------|
| **作用域选项** | `agent`（仅当前 Agent）、`global`（跨 Agent 共享） | Profile 级隔离 | Hermes 通过 `--profile` 实现 |
| **隔离粒度** | Agent 级 | Profile 级 + Agent 级 | Hermes 先按 Profile 隔离，再按 Agent |
| **跨 Agent 共享** | ✅ 支持（通过 `global` 作用域） | ❌ 不支持（设计理念不同） | Hermes 强调 Agent 独立性 |
| **多用户支持** | ❌ 当前未实现 | ✅ 通过 Profile 实现 | Hermes 的 Profile 类似用户隔离 |

**Hermes Profile 机制**：
- 启动参数：`--profile <name>`
- 存储路径：`~/.hermes/profiles/<name>/memories/`
- 用途：隔离不同用户或不同项目的记忆

**分析**：
- Saros 的 `global` 作用域设计适合单用户多 Agent 场景
- Hermes 的 Profile 设计适合多用户或多项目场景
- 两者设计理念不同，各有优势

### 3.4 记忆写入策略对比

| 维度 | Saros | Hermes | 备注 |
|------|-------|--------|------|
| **短期记忆** | 环形缓冲（FIFO，默认 200 条） | 内置 MemoryStore（会话级） | Hermes 短期记忆在内存中 |
| **长期记忆** | 无上限，追加写入 JSONL | Markdown 文件（2200 字符限制） | Hermes 有字符限制 |
| **写入触发** | 自动（框架调用 `writeMemory`） | 手动（Agent 调用 `remember` 工具） | 设计理念不同 |
| **去重策略** | ❌ 当前未实现 | ✅ 条目级替换（按索引或内容匹配） | Hermes 支持更新现有条目 |
| **原子写入** | ❌ 当前未实现 | ✅ 临时文件 + 重命名 + fsync | Hermes 保证数据一致性 |
| **文件锁定** | ❌ 当前未实现 | ✅ 跨平台文件锁（fcntl/msvcrt） | Hermes 支持并发安全 |

**Hermes 写入流程**（`tools/memory_tool.py`）：
1. 读取现有条目（`_read_file`）
2. 添加/替换/删除条目
3. 写入临时文件（`tempfile.mkstemp`）
4. `fsync` 确保持久化
5. 原子重命名（`atomic_replace`）

**分析**：
- Saros 的自动写入策略更适合 VS Code 集成场景（用户无需关心记忆管理）
- Hermes 的手动工具策略更适合长期在线的 AI 工作系统（Agent 自主决策）
- Hermes 的写入安全性更高（原子写入 + 文件锁）

### 3.5 搜索与检索对比

| 维度 | Saros | Hermes | 备注 |
|------|-------|--------|------|
| **文本搜索** | ✅ 支持（`searchMemory`，大小写不敏感） | ✅ 支持（工具查询 + 外部向量检索） | Hermes 两种方式 |
| **标签过滤** | ✅ 支持（`tag:foo` 前缀） | ❌ 未实现 | Hermes 无标签系统 |
| **类型过滤** | ✅ 支持（`type:short` / `type:long` 前缀） | ✅ 支持（MEMORY.md vs USER.md） | 文件级分类 |
| **向量检索** | ❌ 当前未实现（计划中） | ✅ 通过外部提供商（Mem0, Honcho 等） | Hermes 依赖外部服务 |
| **时间范围过滤** | ❌ 当前未实现 | ❌ 未实现 | 两者都缺失 |
| **语义搜索** | ❌ 当前未实现 | ✅ 外部提供商支持 | 核心差异 |

**Hermes 检索方式**：
1. **内置检索**：Agent 调用 `context` 工具查看当前记忆
2. **向量检索**：通过外部提供商（Mem0, Honcho）实现语义搜索
3. **关键词匹配**：在 `MEMORY.md` 和 `USER.md` 中搜索

**改进建议（Saros）**：
- 增加向量检索能力（使用 `sqlite-vec` 或类似方案）
- 增加时间范围过滤（`after:2026-01-01`、`before:2026-06-01`）
- 增加重要性评分（让 Agent 能标记重要记忆）
- 考虑支持外部向量数据库提供商（类似 Hermes）

### 3.6 多用户与多工作区对比

| 维度 | Saros | Hermes | 备注 |
|------|-------|--------|------|
| **多用户支持** | ❌ 当前未实现（单用户） | ✅ 通过 Profile 实现 | Hermes 的 Profile 类似多用户 |
| **多工作区支持** | ✅ 原生支持（同一 Agent 跨工作区共享记忆） | ❌ 未实现 | 设计理念不同 |
| **工作区隔离** | ❌ 已移除（改为基于 Agent 管理） | N/A | Hermes 无工作区概念 |
| **Profile 机制** | ❌ 未实现 | ✅ 支持（`--profile <name>`） | Hermes 的核心特性 |

**Hermes Profile 机制**：
- **用途**：隔离不同用户、项目或场景的记忆
- **启动方式**：`hermes --profile work`、`hermes --profile personal`
- **存储路径**：`~/.hermes/profiles/<name>/memories/`
- **隔离级别**：完全隔离，不同 Profile 之间无法共享记忆

**设计理念差异**：
- **Saros**：面向 VS Code 多工作区场景，强调跨工作区共享
- **Hermes**：面向多平台部署（Telegram、Discord 等），强调用户/项目隔离

### 3.7 开源与生态对比

| 维度 | Saros | Hermes |
|------|-------|--------|
| **开源状态** | 内部项目（计划中开源） | ✅ 已开源（2026 年 2 月发布） |
| **GitHub Stars** | - | 61K+（截至 2026 年 4 月） |
| **文档完整性** | 中等（有设计文档，实现文档待完善） | 高（有完整用户指南和 API 文档） |
| **社区活跃度** | 低（内部项目） | 高（有中文社区、技术博客等） |

---

## 四、Saros 记忆框架改进建议

基于与 Hermes 的对比分析，提出以下改进建议：

### 4.1 短期改进（1-2 周）

1. **增加会话级缓存**：
   - 避免同一会话内的重复加载
   - 缓存失效策略：记忆写入时失效

2. **增加显式记忆管理工具**：
   - 提供 `add_memory`、`search_memory`、`delete_memory` 等工具
   - 让 Agent 能主动管理记忆

3. **增加时间范围过滤**：
   - 支持 `after:2026-01-01`、`before:2026-06-01` 前缀
   - 支持 `recent:7d`（最近 7 天）快捷方式

### 4.2 中期改进（1-2 月）

1. **实现向量检索**：
   - 使用 `sqlite-vec` 存储向量
   - 支持语义搜索（而不仅是文本匹配）

2. **增加重要性评分**：
   - 每条记忆有一个 `importance` 字段（0-10）
   - 搜索时按重要性排序

3. **增加记忆去重**：
   - 写入时检测相似内容
   - 避免重复记忆占用空间

### 4.3 长期改进（3-6 月）

1. **实现四层记忆架构**：
   - L0：原始对话层（现有 `short-term.jsonl`）
   - L1：原子事实层（从对话中提取关键信息）
   - L2：场景层（特定场景的知识）
   - L3：人格层（Agent 的个性和行为模式）

2. **支持多用户**：
   - 存储路径改为 `<userId>/<agentId>` 两层结构
   - 增加用户认证和权限管理

3. **记忆导出与导入**：
   - 支持将记忆导出为 JSON 文件
   - 支持从 JSON 文件导入记忆
   - 便于记忆迁移和备份

---

## 五、总结

### 5.1 Saros 记忆框架优势

1. **跨工作区共享**：同一 Agent 在不同工作区共享记忆，提升用户体验（Hermes 不支持）
2. **自动管理**：无需 Agent 主动调用工具，由框架自动管理（Hermes 需手动调用 `remember` 工具）
3. **动态更新**：每次请求重新加载记忆，立即反映最新变化（Hermes 采用冻结快照，会话期间不变）
4. **灵活作用域**：支持 `agent` 和 `global` 两种作用域，满足不同场景需求
5. **VS Code 深度集成**：利用 VS Code 的 `IFileService` 和 `IEnvironmentService`，确保跨平台兼容性
6. **无字符限制**：JSONL 格式无字符限制（Hermes 有 2200/1375 字符限制）

### 5.2 与 Hermes 的差距

1. **开源生态**：Hermes 已开源并获得社区广泛关注（61K+ Stars），Saros 仍是内部项目
2. **文档完整性**：Hermes 有完整的用户指南和 API 文档，Saros 的文档有待完善
3. **向量检索**：Hermes 通过外部提供商（Mem0, Honcho 等）实现向量检索，Saros 当前仅支持文本匹配
4. **写入安全性**：Hermes 实现了原子写入 + 文件锁 + fsync，Saros 当前未实现
5. **多用户支持**：Hermes 通过 Profile 机制支持多用户隔离，Saros 当前仅支持单用户
6. **记忆管理工具**：Hermes 提供 `remember`、`remembers`、`forget`、`context` 等工具，Saros 当前未提供

### 5.3 核心设计理念差异

| 维度 | Saros | Hermes |
|------|-------|--------|
| **设计目标** | VS Code 集成，自动化记忆管理 | 多平台部署，Agent 自主决策 |
| **记忆更新** | 动态更新（每次请求重载） | 冻结快照（会话期间不变） |
| **写入方式** | 自动（框架管理） | 手动（Agent 调用工具） |
| **字符限制** | 无限制 | 2200/1375 字符限制 |
| **多工作区** | ✅ 原生支持 | ❌ 未实现 |
| **多用户** | ❌ 当前未实现 | ✅ 通过 Profile 实现 |

### 5.4 下一步行动

#### 短期改进（1-2 周）
1. **增加会话级缓存**：避免同一会话内的重复加载，提升性能
2. **实现原子写入**：参考 Hermes，使用临时文件 + 重命名确保写入安全
3. **增加文件锁**：支持并发安全（Windows: `msvcrt`, Unix: `fcntl`）
4. **完善文档**：编写完整的内存框架设计文档和实现指南

#### 中期改进（1-2 月）
1. **实现向量检索**：参考 Hermes 的外部提供商模式，支持 Mem0、Honcho 等
2. **增加记忆管理工具**：提供 `add_memory`、`search_memory`、`delete_memory` 等工具
3. **支持外部向量数据库**：类似 Hermes 的 `memory_manager` 接口
4. **增加字符限制**：防止记忆膨胀（可选，参考 Hermes）

#### 长期改进（3-6 月）
1. **支持多用户**：参考 Hermes 的 Profile 机制，实现多用户隔离
2. **开源准备**：清理代码、补充测试用例、编写贡献指南
3. **社区建设**：建立技术博客、中文社区，吸引更多开发者参与
4. **性能优化**：实现增量写入、向量索引、缓存优化

---

## 附录

### A. 参考资料

1. [Hermes Agent 官方文档](https://hermes-doc.aigc.green/)
2. [Hermes Agent 中文社区](https://hermesagent.org.cn/)
3. [Hermes Agent GitHub](https://github.com/NousResearch/Hermes-Agent)
4. [TencentDB-Agent-Memory 开源项目](https://github.com/Tencent/)
5. [Saros Agents Client 代码库](.)

### B. Hermes 关键代码文件

| 文件 | 路径（相对 Hermes 项目根目录） | 说明 |
|------|--------------------------------|------|
| **记忆工具** | `tools/memory_tool.py` | 核心记忆管理逻辑（MemoryStore 类） |
| **系统提示构建** | `agent/system_prompt.py` | 记忆注入到系统提示的逻辑 |
| **记忆配置** | `config/memory_config.py` | 记忆系统配置 |
| **外部记忆接口** | `memory/` | 外部向量数据库提供商接口 |

**关键函数和类**：
- `MemoryStore.load_from_disk()` - 从磁盘加载记忆（冻结快照）
- `MemoryStore.format_for_system_prompt()` - 格式化记忆用于系统提示
- `MemoryStore._read_file()` - 读取记忆文件（按 `§` 分割）
- `MemoryStore._write_file()` - 写入记忆文件（原子写入）
- `MemoryStore._file_lock()` - 文件锁（跨平台）

### C. Saros 相关文件

- `src/vs/sessions/contrib/agentStudio/browser/providers/memory/sessionMemoryProvider.ts` - 核心记忆提供者
- `src/vs/sessions/common/agentStudioTypes.ts` - 记忆相关类型定义
- `src/vs/sessions/common/providers.ts` - Provider 接口定义
- `src/vs/sessions/contrib/agentStudio/browser/agentStudioService.ts` - 全局数据管理
- `doc/memory-storage-design.md` - 记忆存储设计方案
- `doc/memory-injection-flow.md` - 记忆注入流程文档

### D. 核心差异总结

| 维度 | Saros | Hermes | 建议 |
|------|-------|--------|------|
| **文件格式** | JSONL | Markdown（`§` 分隔） | Saros 可添加 Markdown 导出 |
| **字符限制** | 无 | 2200/1375 | Saros 可添加可选限制 |
| **原子写入** | ❌ | ✅ | Saros 应实现 |
| **文件锁** | ❌ | ✅ | Saros 应实现 |
| **向量检索** | ❌ | ✅（外部） | Saros 应实现 |
| **多用户** | ❌ | ✅（Profile） | Saros 长期实现 |
| **冻结快照** | ❌（动态加载） | ✅ | Saros 可考虑可选缓存 |

---

**文档结束**
