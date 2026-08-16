# Saros 团队共建：技能 / Agent / 知识图谱 实现方案

> 日期：2026-06-15 | 参考项目：Hivemind (Activeloop) | 目标：Saros Agents Client 多人协作扩展

---

## 一、设计目标与约束分析

### 1.1 核心设计目标

| 目标 | 说明 |
|------|------|
| 技能共建 | 团队成员可发布、拉取、协作编辑 Skill，自动传播到所有成员的 Agent |
| Agent 共建 | Agent 定义（Provider 配置、Hook、Prompt）可分享到团队空间，其它成员一键安装 |
| 知识图谱共建 | 代码库图谱可推送到团队共享，任何人拉取后在 Agent session 中可见 |

### 1.2 关键约束

| 约束 | 影响 | Hivemind 做法 | Saros 调整 |
|------|------|-------------|------------|
| Saros 是单用户桌面 App | 无天然的多用户模型 | 每个用户独立认证 | 需要用户身份标识（Gongfeng/企业微信）|
| Workspace 严格隔离 | 跨工作区数据不可见 | 无工作区概念 | 扩展 ISkillRegistry 支持 team source |
| 无云后端 | 必须自建或复用 | Deeplake SQL API | 使用 Gongfeng API / 轻量 Git 仓库 / 自定义 Server |
| VS Code 进程模型 | 后台服务需要分离进程 | `spawn detached` Worker | VS Code Extension Host 或分离 Node 进程 |

---

## 二、总体架构设计

### 2.1 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│                     WebView UI 层                           │
│  ┌──────────┬──────────┬──────────┬───────────────────────┐ │
│  │Skill Store│Agent Store│Team Panel│ Graph Explorer       │ │
│  └──────────┴──────────┴──────────┴───────────────────────┘ │
├─────────────────────────────────────────────────────────────┤
│                   Host 服务层                                │
│  ┌──────────────────────┬──────────────────────────────────┐│
│  │ ITeamRegistryService │ ITeamSyncService                 ││
│  │ - 团队创建/加入       │ - pull/push 引擎                  ││
│  │ - 成员管理            │ - 冲突检测 & 合并                  ││
│  │ - 权限控制            │ - Manifest 管理                   ││
│  ├──────────────────────┼──────────────────────────────────┤│
│  │ 扩展现有服务:         │ 新增服务:                         ││
│  │ ISkillRegistry       │ ITeamSkillStore                  ││
│  │   + source: 'team'   │ ITeamAgentStore                  ││
│  │ IAgentGalleryService │ ITeamGraphStore                  ││
│  │   + team templates   │ ITeamRuleStore                   ││
│  │ IMcpService          │                                  ││
│  │   + team MCP configs │                                  ││
│  └──────────────────────┴──────────────────────────────────┘│
├─────────────────────────────────────────────────────────────┤
│                   存储适配层 (Sync Backend)                   │
│  ┌─────────────┬──────────────┬────────────────────────────┐│
│  │ Git Backend  │ Gongfeng API │ Custom Server              ││
│  │ (最小可行)   │ (企业级)      │ (自托管)                    ││
│  └─────────────┴──────────────┴────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### 2.2 核心设计原则（源自 Hivemind）

| 原则 | Hivemind 实现 | Saros 采用 |
|------|-------------|------------|
| **Pull 优先** | SessionStart 自动 pull | Workspace 打开时自动 sync |
| **INSERT-only 版本化** | Rules/Skills 永不 UPDATE | Team 资源 INSERT-only，version 递增 |
| **Manifest 驱动** | `pulled.json` 追踪本地-远程映射 | `team-manifest.json` 管理同步状态 |
| **原子写入** | `.tmp → rename` | 同样模式 |
| **失败安全** | SessionStart 永不因 pull 失败而中断 | `enableTeamSync()` 静默吞错误 |
| **VFS 统一接口** | `~/.deeplake/memory/` 路径约定 | 扩展 ISkillRegistry 的 source 层级 |

---

## 三、团队技能共建

### 3.1 数据模型

```typescript
// 扩展现有 ISkillDefinition
export interface TeamSkillDefinition extends ISkillDefinition {
  source: 'team';                       // 新增来源类型
  team: {
    teamId: string;                     // 所属团队
    author: string;                     // 最初作者 (user@tencent.com)
    contributors: string[];             // 所有编辑者
    version: number;                    // 单调递增版本号
    publishedAt: string;                // ISO 时间戳
    scope: 'team' | 'public';           // team: 仅团队成员; public: 所有人
    originSkillId: string;              // 本地 skill 的原始 id (首次发布时设置)
  };
  contentHash: string;                  // SHA-256 of SKILL.md (去重 & 冲突检测)
}
```

### 3.2 存储结构

**本地 Manifest（追踪同步状态）：**
```
~/.saros/team/<teamId>/skill-manifest.json
```
```json
{
  "version": 1,
  "entries": [
    {
      "skillId": "deploy",
      "teamAuthor": "alice",
      "localPath": "~/.saros/skills-library/deploy--alice/SKILL.md",
      "remoteVersion": 3,
      "localVersion": 2,
      "contentHash": "abc123...",
      "lastPulled": "2026-06-15T10:00:00Z",
      "lastPushed": "2026-06-14T15:30:00Z"
    }
  ]
}
```

**远程存储（Git Backend 示例）：**
```
<saros-team-repo>/skills/
  ├── index.json              ← 所有技能的索引
  └── <skillId>--<author>/
      ├── SKILL.md            ← 最新版本内容
      └── history.jsonl       ← 版本历史 (INSERT-only)
```

### 3.3 Push 流程

```
用户操作: "发布技能 deploy 到团队"

1. 读取本地 SKILL.md
2. 计算 contentHash = sha256(content)
3. 检查 team-manifest.json:
   - 不存在 → 新发布
   - 存在且 remoteVersion >= localVersion → 建议先 pull
   - 存在且 contentHash 相同 → 无变化，跳过
4. 原子推送:
   a. 写入 skills/<id>--<user>/SKILL.md
   b. 追加 skills/<id>--<user>/history.jsonl:
      {"version": N, "contentHash": "...", "author": "alice", "ts": "..."}
   c. 更新 skills/index.json:
      {
        "deploy": {
          "latestVersion": N,
          "latestHash": "...",
          "author": "alice",
          "updatedAt": "..."
        }
      }
5. 更新本地 team-manifest.json (remoteVersion++, contentHash++)
6. 触发 ITeamSyncService.onTeamSkillPushed 事件
```

### 3.4 Pull 流程

```
触发: Workspace 打开 / 手动 Sync / 周期性 (30分钟)

1. 获取 skills/index.json
2. 逐条目比较 team-manifest.json:
   - 本地不存在 → 写入 (new)
   - remoteVersion > localVersion → 备份 .bak + 覆盖 (updated)
   - localVersion >= remoteVersion → 跳过 (current)
3. 写入 ~/.saros/skills-library/<id>--<author>/SKILL.md
4. 调用 ISkillRegistry.reloadTeams() → 扫描 team 目录
5. 触发 ITeamSyncService.onTeamSkillsSynced 事件
6. WebView 刷新 Skill 列表
```

### 3.5 冲突解决

```
场景: Alice 和 Bob 同时编辑 deploy 技能

检测:
  Alice push: local contentHash ≠ remote contentHash → 冲突

合并策略 (自动):
  1. 比较 Alice 的 baseVersion (push 前的 remote version)
  2. 如果 Alice 的 baseVersion == remote latest → 单方面更新 (无冲突)
  3. 如果 Alice 的 baseVersion < remote latest → 三方合并:
     - Alice 的 SKILL.md diff vs 共同祖先
     - Bob 的 SKILL.md diff vs 共同祖先
     - 尝试 line-based 3-way merge
     - 成功 → 自动合并 (new version)
     - 失败 → 标记冲突，通知双方用户手动解决

合并算法:
  function threeWayMerge(base, alice, bob):
    diffA = lineDiff(base, alice)  // Alice 的变更
    diffB = lineDiff(base, bob)    // Bob 的变更
    overlapping = findOverlap(diffA, diffB)
    if overlapping.isEmpty():
      return applyAll(diffA + diffB)  // 无冲突，全部应用
    else:
      return markedConflicts(merge(diffA, diffB))  // 标记冲突区域
```

### 3.6 服务接口定义

```typescript
// 新增服务: ITeamSkillStore
export const ITeamSkillStore = createDecorator<ITeamSkillStore>('teamSkillStore');

export interface ITeamSkillStore {
  // 发布到团队
  publishSkill(skillId: string, teamId: string): Promise<void>;

  // 从团队拉取
  pullSkills(teamId: string): Promise<TeamSkillSyncResult>;

  // 拉取单个技能
  pullSkill(skillId: string, teamId: string): Promise<void>;

  // 取消拉取 (本地删除团队技能)
  unpullSkill(skillId: string, teamId: string): Promise<void>;

  // 获取团队技能列表 (远程索引)
  listTeamSkills(teamId: string): Promise<TeamSkillIndex[]>;

  // 事件
  readonly onDidPublish: Event<{ skillId: string; teamId: string }>;
  readonly onDidPull: Event<{ skillId: string; author: string }>;
}
```

---

## 四、Agent 团队共建

### 4.1 数据模型

```typescript
// 扩展现有 Agent 定义，增加团队共享字段
export interface TeamAgentTemplate {
  // 继承自 AgentTemplate 的基础字段
  id: string;
  name: string;
  description: string;
  category: string;
  icon?: string;
  tags?: string[];

  // 团队特定字段
  team: {
    teamId: string;
    author: string;
    contributors: string[];
    version: number;
    publishedAt: string;
    scope: 'team' | 'public';
  };

  // Agent 完整配置 (可分享的内容)
  agentConfig: {
    // IAgentOSService 的 Provider 配置
    modelProvider: {
      providerId: string;       // e.g. 'knot', 'openai', 'anthropic'
      modelId: string;          // e.g. 'gpt-4', 'claude-sonnet-4-20250514'
      parameters?: Record<string, unknown>;
    };
    // Hook 配置
    hooks: IAgentHookEntry[];
    // System Prompt
    systemPrompt: string;
    // 工具启用状态
    toolsEnabled: Record<string, boolean>;
    // 技能引用 (skillId 列表 → 安装 Agent 时自动拉取)
    requiredSkills?: string[];
  };

  // 默认 AgentBinding 配置
  defaultBinding: {
    worktreePath?: string;
    memoryConfig?: { entries: MemoryEntry[] };
  };

  contentHash: string;
}
```

### 4.2 共享工作流

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Alice 的工作区 │     │   Team Store  │     │ Bob 的工作区   │
├──────────────┤     ├──────────────┤     ├──────────────┤
│              │     │              │     │              │
│ 1. 配置 Agent │     │              │     │              │
│    "Code     │     │              │     │              │
│     Reviewer"│     │              │     │              │
│              │     │              │     │              │
│ 2. 导出 →    │────→│ 3. 存储为     │────→│ 4. 自动同步   │
│    Agent     │     │   Template   │     │   (pull)      │
│    Template  │     │              │     │              │
│              │     │              │     │ 5. 一键安装   │
│              │     │              │     │   → 本地 Agent │
│              │     │              │     │   自动拉取     │
│              │     │              │     │   required     │
│              │     │              │     │   Skills       │
└──────────────┘     └──────────────┘     └──────────────┘
```

### 4.3 实现细节

**导出 Agent：**
```typescript
// AgentStudioService 新增方法
async exportAgentToTeam(agentId: string, teamId: string): Promise<void> {
  const agent = this.getAgent(agentId);
  const binding = this.getAgentBinding(agentId, this.activeWorkspaceId);

  const template: TeamAgentTemplate = {
    id: crypto.randomUUID(),
    name: agent.name,
    description: agent.description,
    category: agent.category || 'custom',
    icon: agent.icon,
    tags: agent.tags,

    team: {
      teamId,
      author: this.userService.getCurrentUser(),
      contributors: [this.userService.getCurrentUser()],
      version: 1,
      publishedAt: new Date().toISOString(),
      scope: 'team',
    },

    agentConfig: {
      modelProvider: {
        providerId: agent.modelProviderId,
        modelId: agent.modelId,
        parameters: agent.parameters,
      },
      hooks: agent.hooks || [],
      systemPrompt: agent.systemPrompt,
      toolsEnabled: binding?.toolsEnabled || {},
      requiredSkills: agent.requiredSkillIds || [],
    },

    defaultBinding: {
      memoryConfig: binding?.memoryConfig,
    },

    contentHash: this.computeHash(agent),
  };

  await this.teamAgentStore.publishTemplate(template);
}
```

**安装 Agent（拉取 + 自动安装依赖技能）：**
```typescript
async installTeamAgent(templateId: string, teamId: string): Promise<string> {
  // 1. 拉取模板
  const template = await this.teamAgentStore.pullTemplate(templateId, teamId);

  // 2. 自动拉取 requiredSkills
  if (template.agentConfig.requiredSkills?.length) {
    for (const skillId of template.agentConfig.requiredSkills) {
      await this.teamSkillStore.pullSkill(skillId, teamId);
    }
  }

  // 3. 创建本地 Agent 定义
  const agent = await this.createAgent({
    name: template.name,
    description: template.description,
    category: template.category,
    source: 'team',
    sourceTemplateId: templateId,
    modelProviderId: template.agentConfig.modelProvider.providerId,
    modelId: template.agentConfig.modelProvider.modelId,
    systemPrompt: template.agentConfig.systemPrompt,
    hooks: template.agentConfig.hooks,
  });

  // 4. 创建 AgentBinding
  await this.upsertAgentBinding({
    agentId: agent.id,
    workspaceId: this.activeWorkspaceId,
    toolsEnabled: template.agentConfig.toolsEnabled,
    memoryConfig: template.defaultBinding.memoryConfig,
  });

  return agent.id;
}
```

### 4.4 Agent Market 扩展

现有 `AgentMarketEditorPane` 从本地硬编码预设改为从 Team Store 动态加载：

```typescript
// agentMarketEditorPane.ts 改造
class AgentMarketEditorPane {
  // 原有: BUILTIN_PRESETS (本地硬编码)
  // 新增:
  private async loadTeamTemplates(): Promise<TeamAgentTemplate[]> {
    // 从 Team Store 拉取 index
    return await this.teamAgentStore.listTemplates(this.activeTeamId);
  }

  async renderMarketplace(): Promise<void> {
    const builtin = BUILTIN_PRESETS;
    const team = await this.loadTeamTemplates();

    // 合并展示，团队模板带 "Team" 徽标
    this.renderTemplates([...builtin, ...team]);
  }
}
```

---

## 五、知识图谱团队共建

### 5.1 数据模型

```typescript
// 扩展 Hivemind 的 GraphSnapshot 模型
export interface SharedGraphSnapshot {
  // 身份键
  teamId: string;
  repoSlug: string;
  commitSha: string;
  branch: string;

  // 内容
  snapshotJson: GraphSnapshot;     // 来自 Hivemind 的完整图谱

  // 元数据
  author: string;
  worktreePath?: string;
  createdAt: string;
  snapshotSha256: string;           // 规范 JSON 的 SHA-256 (排除了 observation)
  nodeCount: number;
  edgeCount: number;
  trigger: 'manual' | 'session-end' | 'post-commit' | 'pull';
}
```

### 5.2 存储结构

```
~/.saros/team/<teamId>/graphs/<repoSlug>/
  ├── snapshots/
  │   └── <commitSha>.json              ← 本地缓存的图谱快照
  ├── .cache/
  │   └── <contentSha256>.json          ← 逐文件提取缓存 (跨仓库共享)
  ├── history.jsonl                      ← 构建历史审计日志
  ├── .last-build.json                   ← 每个 worktree 的最新构建状态
  └── graph-manifest.json               ← 同步状态

~/.saros/team/<teamId>/graph-manifest.json:
{
  "entries": {
    "myproject/main": {
      "localSha": "abc123",
      "remoteSha": "def456",
      "lastPulled": "2026-06-15T10:00:00Z",
      "lastPushed": "2026-06-14T15:30:00Z"
    }
  }
}
```

### 5.3 Push 协议（借鉴 Hivemind SELECT-before-INSERT）

```
pushSnapshot(snapshot, teamId):

1. 计算 snapshotSha256 (仅稳定字段, 排除 observation)

2. 远程检查:
   SELECT snapshot_sha256 FROM team_graphs
   WHERE team_id = ? AND repo_slug = ? AND commit_sha = ? AND author = ?

3. 决策:
   a. 存在且 sha256 匹配 → already-current (幂等, 跳过)
   b. 存在但 sha256 不同 → drift (漂移)
      - 原因: 同一 commit 产生不同图谱 (提取器版本变更)
      - 处理: 记录警告日志, 不覆盖 (保护已有数据)
   c. 不存在 → INSERT 新行

4. 插入后验证:
   SELECT COUNT(*) WHERE ... → 如果 > 1 → 并发竞争 (可见但接受)

5. 更新本地 graph-manifest.json
```

### 5.4 Pull 协议

```
pullSnapshot(teamId, repoSlug):

1. HIVEMIND_GRAPH_PULL=0 → 跳过 (环境变量门控)

2. SELECT * FROM team_graphs
   WHERE team_id = ? AND repo_slug = ?
   ORDER BY created_at DESC LIMIT 1

3. 解析规则:
   a. 无远程行 → no-remote
   b. 本地 sha256 == 远程 sha256 → up-to-date
   c. 本地 timestamp > 远程 timestamp (同一 commit) → local-newer
   d. 否则 → pulled

4. 验证: 远程 sha256 必须与解析的 snapshotJson 计算值匹配

5. 原子写入: .json.tmp.{pid}.{ts} → rename → .json

6. 更新 .last-build.json + history.jsonl + graph-manifest.json
```

### 5.5 自动同步触发

| 时机 | 操作 | 条件 |
|------|------|------|
| **Workspace 打开** | spawnGraphPullWorker() | 分离进程, 30s 超时 |
| **git commit (post-commit hook)** | runBuildCommand() → pushSnapshot() | graph init 已安装钩子 |
| **Agent Session Stop** | decideGate() → runBuildCommand() | HEAD ≠ lastBuild, git diff 有源码变化 |
| **Agent SessionEnd** | 同上 | 同上 |

**Stop/SessionEnd 门控逻辑 (decideGate):**
```
1. HIVEMIND_GRAPH_ON_STOP=0 → 跳过
2. lastBuild 距现在 < 10 分钟 → 跳过 (防抖动)
3. HEAD == lastBuild.commit_sha → 跳过 (无新提交)
4. git diff --name-only (源码文件) 数量 < 1 → 跳过
5. 否则 → acquireBuildLock() → runBuildCommand("--trigger session-end")
```

### 5.6 VFS 文本管道暴露

```
Agent session 内通过 VFS 查询图谱:

cat ~/.saros/graph/<teamId>/<repoSlug>/index.md
  → 概览: commit, nodes, edges, top 10 files

cat ~/.saros/graph/<teamId>/<repoSlug>/query/<pattern>
  → 搜索节点 + 1-hop 展开 (最常用入口)

cat ~/.saros/graph/<teamId>/<repoSlug>/impact/<pattern>
  → 传递依赖分析 (爆炸半径)

cat ~/.saros/graph/<teamId>/<repoSlug>/neighborhood/<file>
  → 文件内符号 + 跨文件出入边
```

---

## 六、团队注册与权限

### 6.1 TeamRegistry 接口

```typescript
export const ITeamRegistry = createDecorator<ITeamRegistry>('teamRegistry');

export interface ITeamRegistry {
  // 团队生命周期
  createTeam(name: string, description?: string): Promise<ITeam>;
  joinTeam(inviteCode: string): Promise<ITeam>;
  leaveTeam(teamId: string): Promise<void>;
  deleteTeam(teamId: string): Promise<void>;  // 仅 owner

  // 成员管理
  getMembers(teamId: string): Promise<ITeamMember[]>;
  inviteMember(teamId: string, email: string, role: TeamRole): Promise<void>;
  removeMember(teamId: string, userId: string): Promise<void>;
  updateMemberRole(teamId: string, userId: string, role: TeamRole): Promise<void>;

  // 查询
  getMyTeams(): Promise<ITeam[]>;
  getTeam(teamId: string): Promise<ITeam | undefined>;

  // 事件
  readonly onDidChangeTeam: Event<{ teamId: string; reason: string }>;
}

export enum TeamRole {
  OWNER  = 'owner',    // 创建者, 管理成员 + 所有资源
  ADMIN  = 'admin',    // 管理员, 管理成员 + 所有资源
  MEMBER = 'member',   // 成员, 读写所有资源
  VIEWER = 'viewer',   // 观察者, 只读
}

export interface ITeam {
  id: string;
  name: string;
  description?: string;
  ownerId: string;
  createdAt: string;
  memberCount: number;
}

export interface ITeamMember {
  userId: string;       // e.g. qiuzijian@tencent.com
  displayName: string;
  role: TeamRole;
  joinedAt: string;
}
```

### 6.2 权限矩阵

| 操作 | OWNER | ADMIN | MEMBER | VIEWER |
|------|:-----:|:-----:|:------:|:------:|
| 查看团队技能 | ✅ | ✅ | ✅ | ✅ |
| 拉取团队技能 | ✅ | ✅ | ✅ | ✅ |
| 发布技能 | ✅ | ✅ | ✅ | ❌ |
| 编辑他人技能 | ✅ | ✅ | ❌ | ❌ |
| 删除团队技能 | ✅ | ✅ | ❌ | ❌ |
| 查看 Agent 模板 | ✅ | ✅ | ✅ | ✅ |
| 安装 Agent 模板 | ✅ | ✅ | ✅ | ✅ |
| 发布 Agent 模板 | ✅ | ✅ | ✅ | ❌ |
| 查看知识图谱 | ✅ | ✅ | ✅ | ✅ |
| 推送图谱 | ✅ | ✅ | ✅ | ❌ |
| 邀请成员 | ✅ | ✅ | ❌ | ❌ |
| 移除成员 | ✅ | ✅ | ❌ | ❌ |
| 删除团队 | ✅ | ❌ | ❌ | ❌ |

---

## 七、同步引擎设计

### 7.1 ITeamSyncService

```typescript
export const ITeamSyncService = createDecorator<ITeamSyncService>('teamSyncService');

export interface ITeamSyncService {
  // 全量同步
  syncAll(teamId: string): Promise<TeamSyncReport>;

  // 增量同步
  syncSkills(teamId: string): Promise<SyncResult>;
  syncAgents(teamId: string): Promise<SyncResult>;
  syncGraphs(teamId: string, repoSlug?: string): Promise<SyncResult>;

  // 自动同步配置
  enableAutoSync(teamId: string, intervalMs?: number): void;
  disableAutoSync(teamId: string): void;

  // 冲突管理
  getConflicts(teamId: string): Promise<SyncConflict[]>;
  resolveConflict(conflictId: string, resolution: 'local' | 'remote' | 'merged', mergedContent?: string): Promise<void>;

  // 事件
  readonly onDidSync: Event<TeamSyncReport>;
  readonly onDidConflict: Event<SyncConflict>;
}

export interface TeamSyncReport {
  teamId: string;
  timestamp: string;
  skills: SyncResult;
  agents: SyncResult;
  graphs: SyncResult;
  errors: SyncError[];
}

export interface SyncResult {
  pulled: number;
  pushed: number;
  skipped: number;
  conflicts: number;
}

export interface SyncConflict {
  id: string;
  resourceType: 'skill' | 'agent' | 'graph';
  resourceId: string;
  localVersion: number;
  remoteVersion: number;
  localContent: string;
  remoteContent: string;
  baseContent?: string;  // 共同祖先 (三方合并需要)
  canAutoMerge: boolean;
}
```

### 7.2 同步生命周期

```
Workspace 打开
  └── ITeamSyncService.enableAutoSync(teamId, 30min)
        └── Trigger: 立即 + 每 30 分钟
              ├── syncSkills(teamId)  → Pull 新技能 → ISkillRegistry.reloadTeams()
              ├── syncAgents(teamId)  → Pull 新模板 → update Agent Market cache
              └── syncGraphs(teamId)  → spawn pull workers → 异步

Agent Session Start
  └── 注入 Team Context:
        === TEAM RULES ===
        <team rules injected here>

        === TEAM SKILLS AVAILABLE ===
        <list of pulled team skills>

        === CODE GRAPH ===
        cat ~/.saros/graph/<teamId>/<repoSlug>/index.md

Agent Session End
  └── maybeAutoPush():
        - 检查本地技能是否有新的 team-eligible 变更
        - 检查 Agent 配置是否值得导出
        - 如果满足条件 → 提示用户 "发布到团队?"

技能编辑 (WebView)
  └── Save SKILL.md → detectChange()
        ├── isTeamSkill(skillId) → yes
        ├── 本地先存
        └── 用户手动 push 或自动 (根据设置)

git commit (post-commit hook)
  └── runBuildCommand() → pushSnapshot()
```

---

## 八、存储后端抽象

### 8.1 ITeamStoreBackend 接口

```typescript
export interface ITeamStoreBackend {
  // 团队管理
  createTeam(name: string): Promise<string>;
  getTeam(teamId: string): Promise<ITeam | null>;

  // 技能存储
  listSkillIndex(teamId: string): Promise<SkillIndexEntry[]>;
  getSkill(teamId: string, skillId: string, version?: number): Promise<TeamSkillDefinition>;
  putSkill(teamId: string, skill: TeamSkillDefinition): Promise<void>;
  getSkillHistory(teamId: string, skillId: string): Promise<SkillHistoryEntry[]>;

  // Agent 模板存储
  listAgentIndex(teamId: string): Promise<AgentTemplateIndexEntry[]>;
  getAgentTemplate(teamId: string, templateId: string): Promise<TeamAgentTemplate>;
  putAgentTemplate(teamId: string, template: TeamAgentTemplate): Promise<void>;

  // 图谱存储
  getGraphSnapshot(teamId: string, repoSlug: string, commitSha: string): Promise<GraphSnapshot | null>;
  putGraphSnapshot(teamId: string, snapshot: SharedGraphSnapshot): Promise<void>;
  listGraphSnapshots(teamId: string, repoSlug: string): Promise<GraphSnapshotMeta[]>;

  // 连接检测
  ping(): Promise<boolean>;
}
```

### 8.2 实现选项

| 后端 | 适用场景 | 优点 | 缺点 |
|------|---------|------|------|
| **Git Backend** (MVP) | 小团队 (< 10 人) | 零依赖，版本历史天然，冲突解决成熟 | 手动 push/pull，延迟高 |
| **Gongfeng API** | 腾讯内部 | 企业级认证，CI/CD 集成，Storage API | 依赖司内基础设施 |
| **Custom Server** | 大规模团队 | 实时 sync，WebSocket 推送，细粒度权限 | 需要运维 |

**MVP 推荐：Git Backend（参考 Hivemind 的 Git-based 文件存储）**

```
<saros-team-repo>/
  ├── team.json                  ← 团队元数据
  ├── members.json               ← 成员列表 + 角色
  ├── skills/
  │   ├── index.json
  │   └── <skillId>--<author>/
  │       ├── SKILL.md
  │       └── history.jsonl
  ├── agents/
  │   ├── index.json
  │   └── <templateId>/
  │       └── template.v<N>.json
  └── graphs/
      └── <repoSlug>/
          ├── index.json
          └── <commitSha>.json.gz   ← gzip 压缩 (图谱 JSON 可能 > 1MB)
```

---

## 九、WebView UI 扩展

### 9.1 新增 Panel 和 View

| UI 组件 | 位置 | 功能 |
|---------|------|------|
| **Team Panel** | 新增 ViewContainer | 团队列表、成员管理、邀请 |
| **Skill Store** | 现有 SkillView 扩展 + Tab | 浏览团队技能、一键安装 |
| **Agent Store** | 现有 AgentMarketEditorPane 扩展 | "Team" tab + "Community" tab |
| **Graph Explorer** | 新 Canvas View | 搜索节点、展开依赖、传递分析 |
| **Sync Status** | StatusBar widget | 显示上次同步时间、冲突数量 |

### 9.2 Zustand Store 扩展

```typescript
// store/useTeamStore.ts (新增)
export const useTeamStore = create<TeamStore>((set, get) => ({
  // 团队状态
  teams: [],
  activeTeamId: null,
  members: [],

  // 同步状态
  syncStatus: 'idle',  // idle | syncing | error
  lastSyncAt: null,
  pendingConflicts: [],

  // 技能商店
  teamSkills: [],      // 远程索引
  pulledSkills: [],    // 本地已安装的团队技能

  // Agent 模板
  teamTemplates: [],
  installedTemplates: [],

  // 操作
  setActiveTeam: (teamId) => { /* ... */ },
  pullSkills: () => { /* RPC → syncSkills */ },
  publishSkill: (skillId) => { /* RPC → publishSkill */ },
  installAgentTemplate: (templateId) => { /* RPC → installTeamAgent */ },
  resolveConflict: (conflictId, resolution) => { /* ... */ },
}));
```

---

## 十、安全设计

| 层面 | 机制 | 说明 |
|------|------|------|
| **认证** | 集成企业微信 / Gongfeng OAuth | 统一身份，无需单独注册 |
| **授权** | TeamRole (OWNER/ADMIN/MEMBER/VIEWER) | 资源级权限控制 |
| **内容安全** | SHA-256 校验 + 内容签名 | 防篡改，pull 时验证 |
| **路径安全** | `skillId` 禁止 `/`, `\`, `..` | 防路径遍历 |
| **Prompt 注入防护** | 技能/AI 输入中出现 `=== HIVEMIND RULES ===` 等标记时，替换 `\n` 为 `\n` 字面量 | 防注入虚假的系统指令 |
| **原子操作** | `.tmp → rename` 模式 | 防止写入中断产生损坏文件 |
| **本地备份** | pull 覆盖前自动创建 `.bak` 备份 | 可回滚到上一版本 |

---

## 十一、分阶段实施路线图

### Phase 1：基础设施 (2-3 周)

```
1. ITeamRegistry 服务 + 团队 CRUD
2. Git Backend 实现 (最小可行)
3. team.json / members.json 存储
4. 基础权限模型 (OWNER / MEMBER)
```

### Phase 2：技能共建 (3-4 周)

```
1. ITeamSkillStore + Git Backend 适配
2. ISkillRegistry 扩展: source='team'
3. 技能 Push / Pull / Unpull
4. 技能同步 Manifest
5. 冲突检测 + 三方合并
6. Skill Store WebView UI
7. 自动同步 (Workspace 打开 + 定时)
```

### Phase 3：Agent 共建 (2-3 周)

```
1. ITeamAgentStore
2. Agent 导出 → Team Template
3. Agent Template 安装 (含 requiredSkills 自动拉取)
4. Agent Market 扩展 (Team tab)
5. Agent 版本管理 (INSERT-only)
```

### Phase 4：知识图谱共建 (3-4 周)

```
1. Codebase Graph 集成 (tree-sitter 9 种语言)
2. ITeamGraphStore + Push/Pull 协议
3. Graph VFS 文本管道
4. Post-commit hook 自动构建
5. Graph Explorer WebView
6. 图谱跨团队对比 (diff)
```

### Phase 5：高级特性 (4-6 周)

```
1. 实时同步 (WebSocket 推送)
2. 通知系统 (技能更新 / Agent 发布 / 成员加入)
3. 跨团队技能传播 (pull from other teams)
4. Team Rules 系统
5. SkillOpt 反馈循环
6. 仪表盘 (KPI 追踪)
```

---

## 十二、关键设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 同步方向 | Pull-first (拉取优先) | Hivemind 证明了可靠性。SessionStart 自动 pull 但永远不因 pull 失败而中断 |
| 版本策略 | INSERT-only, 单调递增 version | 避免 UPDATE 丢失、冲突复杂化；完整审计追踪 |
| 存储后端 | 先 Git Backend, 后 Gongfeng | MVP 快速上线；Git 天然支持版本控制、冲突解决、分布 |
| 技能冲突 | 三方合并 + 标记冲突 | 比 CRDT 简单，比 last-write-wins 安全 |
| 图谱压缩 | gzip | 图谱 JSON 可达数 MB，gzip 压缩率 5-10x |
| 多 Agent 符号链接 | 不需要（VS Code 单 Agent） | Hivemind 的符号链接扇出是为多 Agent 设计的；Saros 是单一平台 |
| 团队目标管理 | 延后到 Phase 5 | 优先级低于技能/Agent/图谱 |

---

> 本文档覆盖了 Saros 团队共建的完整设计，包括数据模型、存储结构、同步协议、权限模型和 UI 扩展。核心设计哲学取自 Hivemind：**Pull-first 同步、INSERT-only 版本化、Manifest 驱动、原子写入、失败安全**，并针对 Saros 的 VS Code Fork 架构做了适配。
