# Worktree 工作机制对比分析

> 上游 VS Code (`G:\CustomWorkspaces\AIProjects\vscode`) vs 本项目 (`vssaros-agents-client`)

---

## 1. 数据模型差异（根因）

### 上游 VS Code

```ts
// session.ts
interface ISessionGitRepository {
    readonly uri: URI;
    readonly workTreeUri: URI | undefined;  // ← worktree 标识
    readonly branchName?: string;
    readonly baseBranchName: string | undefined;
    readonly gitHubInfo: IObservable<IGitHubInfo | undefined>;
    // ... incomingChanges, outgoingChanges, etc.
}

interface ISessionFolder {
    readonly root: URI;
    readonly workingDirectory: URI;
    readonly name: string;
    readonly gitRepository?: ISessionGitRepository;  // ← git 信息嵌套在 folder 下
}

interface ISessionWorkspace {
    readonly uri: URI;
    readonly label: string;
    readonly folders: ISessionFolder[];  // ← folders 数组
    readonly requiresWorkspaceTrust: boolean;
    readonly isVirtualWorkspace: boolean;
}
```

### 本项目（fork）

```ts
// session.ts
interface ISessionRepository {
    readonly uri: URI;
    readonly workingDirectory: URI | undefined;  // ← worktree 标识（无 workTreeUri）
    readonly detail: string | undefined;
    readonly baseBranchName: string | undefined;
    readonly branchName?: string;
    // ... incomingChanges, outgoingChanges, etc.（直接平铺，无嵌套 gitRepository）
}

interface ISessionWorkspace {
    readonly label: string;
    readonly icon: ThemeIcon;
    readonly repositories: ISessionRepository[];  // ← repositories 数组（非 folders）
    readonly requiresWorkspaceTrust: boolean;
    // 无 uri, 无 isVirtualWorkspace
}
```

### 差异总结

| 维度 | 上游 | fork |
|------|------|------|
| workspace 顶层字段 | `folders: ISessionFolder[]` | `repositories: ISessionRepository[]` |
| workspace 有 `uri` | ✅ | ❌ |
| workspace 有 `isVirtualWorkspace` | ✅ | ❌ |
| git 信息组织 | 嵌套 `folder.gitRepository: ISessionGitRepository` | 平铺在 `ISessionRepository` 上 |
| worktree 标识字段 | `gitRepository.workTreeUri` | `repository.workingDirectory` |
| git 信息有 `gitHubInfo` observable | ✅ 在 `ISessionGitRepository` | ❌ 在 session 顶层 |
| folder 有 `name`/`description` | ✅ | ❌（repository 只有 `detail`） |

**影响**：所有消费 worktree 信息的代码路径都不同。上游用 `workspace.folders[0].gitRepository?.workTreeUri`，fork 用 `workspace.repositories[0]?.workingDirectory`。这导致从上游移植代码时需要适配层。

---

## 2. Worktree 创建机制

### 上游 VS Code

**创建位置**：`platform/agentHost/node/agentHostGitService.ts`（Node/服务端层）

```ts
// agentHostGitService.ts
async addWorktree(repositoryRoot: URI, worktree: URI, branchName: string, startPoint: string): Promise<void> {
    const resolvedStartPoint = await this._resolveRemoteTrackingBranch(repositoryRoot, startPoint) ?? startPoint;
    await this._runGit(repositoryRoot, ['-c', 'checkout.workers=0', 'worktree', 'add', '--no-track', '-b', branchName, worktree.fsPath, resolvedStartPoint], { timeout: 180_000, throwOnError: true });
}

async addExistingWorktree(repositoryRoot: URI, worktree: URI, branchName: string): Promise<void> { ... }
async removeWorktree(repositoryRoot: URI, worktree: URI): Promise<void> { ... }
async getWorktreeRoots(workingDirectory: URI): Promise<URI[]> { ... }
```

**路径规则**：`copilotAgent.ts`
```ts
export function getCopilotWorktreesRoot(repositoryRoot: URI): URI {
    return URI.joinPath(repositoryRoot, '..', `${basename(repositoryRoot.fsPath)}.worktrees`);
}
export function getCopilotWorktreeName(branchName: string): string {
    return branchName.replace(/\//g, '-');
}
```

**特点**：
- worktree 创建在 **agent-host 进程**（服务端），不在 workbench（客户端）
- 路径固定为 `../{repoName}.worktrees/{branchName-with-dashes}`
- 用 `--no-track` 避免自动设置 upstream
- 用 `checkout.workers=0` 禁用并行 checkout
- 支持 `addExistingWorktree`（已有 worktree 关联到 session）

### 本项目（fork）

**创建位置**：`sessions/contrib/worktree/browser/worktreeService.ts`（Browser 层）

```ts
// worktreeService.ts (基于 subagent 分析)
interface IWorktreeService {
    listWorktrees(repoPath: string): Promise<IWorktreeDetail[]>;
    createWorktree(info: ICreateWorktreeInfo): Promise<IWorktreeDetail>;
    removeWorktree(worktreePath: string, force?: boolean): Promise<void>;
    pruneWorktrees(repoPath: string): Promise<void>;
    resetWorktree(worktreePath: string): Promise<void>;
    // ...
}
```

**两阶段创建模式**（兼容 opencode）：
```ts
interface IWorktreeInfoOptions { name?: string; branch?: string; detached?: boolean; }
interface IWorktreeInfo { name: string; branch?: string; directory: string; }
```

**特点**：
- worktree 创建在 **workbench 进程**（客户端 Browser 层）
- 有完整的 CRUD + prune + reset 能力
- 支持两阶段创建（先返回 info，再实际创建）
- 有 `WorktreeStatus` 状态机（None/Pending/Ready/Failed）
- 有选中状态管理（`selectedWorktree` observable）

### 差异总结

| 维度 | 上游 | fork |
|------|------|------|
| 创建位置 | agent-host Node 进程 | workbench Browser 进程 |
| 路径规则 | `../{repo}.worktrees/{branch}` | 可配置（两阶段模式） |
| CRUD 完整度 | add/remove/list 基本操作 | add/remove/list/prune/reset + 选中状态 |
| 创建模式 | 单阶段 | 单阶段 + 两阶段（opencode 兼容） |
| 状态管理 | 无独立状态机 | `WorktreeStatus` (None/Pending/Ready/Failed) |
| `--no-track` | ✅ | 取决于实现 |
| `checkout.workers=0` | ✅ | 取决于实现 |
| UI 视图 | 无 | `WorktreeView` + `WorktreeDataProvider`（树视图） |

---

## 3. Worktree 管理子系统

### 上游 VS Code

**没有独立的 worktree 管理子系统**。worktree 相关功能分散在：
- `platform/agentHost/node/agentHostGitService.ts` — Git 操作
- `platform/agentHost/node/copilot/copilotAgent.ts` — 路径/命名规则
- `sessions/common/agentHostSessionWorkspace.ts` — workspace 构建

### 本项目（fork）

**有完整的 `contrib/worktree/` 子系统**（13 个 .ts 文件）：

| 文件 | 职责 |
|------|------|
| `common/worktreeTypes.ts` | 接口、枚举、常量（`IWorktreeDetail`、`WorktreeStatus`、`WorktreeCommands`） |
| `common/worktreeService.ts` | `IWorktreeService` 接口 |
| `common/worktreeCheckpointService.ts` | `IWorktreeCheckpointService` 接口 |
| `common/workspaceAdapter.ts` | `IWorkspaceAdapterService` 接口 |
| `browser/worktreeService.ts` | `WorktreeService` 主实现（CRUD + 状态 + 事件） |
| `browser/worktreeCheckpointServiceImpl.ts` | Checkpoint Browser 实现 |
| `node/worktreeCheckpointServiceImpl.ts` | Checkpoint Node 实现 |
| `browser/worktreeAdapterService.ts` | 基于 worktree 的工作区适配器 |
| `browser/worktreeView.ts` | `WorktreeViewPane` 视图面板 + 树渲染器 |
| `browser/worktreeDataProvider.ts` | `WorktreeTreeDataProvider` + 树数据项 |
| `browser/worktreeCheckpointCommands.ts` | Checkpoint 命令注册 |
| `browser/worktree.contribution.ts` | 服务单例注册 |
| `browser/worktreeCheckpoint.contribution.ts` | Checkpoint 命令注册入口 |

**fork 独有能力**：
1. **Worktree 树视图 UI**：在侧边栏展示所有 worktree，支持创建/删除/打开/重置/修剪操作
2. **Checkpoint 系统**：对 worktree 做 snapshot/restore（基于 git `captureWorkingTreeAsTree` + `commitTree` + `updateRef`）
3. **选中状态**：`selectedWorktree` observable 驱动 Changes 视图
4. **工作区适配器**：`WorktreeAdapterService` 适配 workspace folder 管理
5. **两阶段创建**：兼容 opencode 的 `IWorktreeInfoOptions` → `IWorktreeInfo` 模式

---

## 4. Session 绑定机制

### 上游 VS Code

```ts
// agentHostSessionWorkspace.ts
export function buildAgentHostSessionWorkspace(project, workingDirectory, options, gitHubInfo, gitState): ISessionWorkspace | undefined {
    const workTreeUri = extUri.isEqual(workingDirectory, project.uri) ? undefined : workingDirectory;
    return {
        folders: [{
            root: project.uri,
            workingDirectory: workingDirectory ?? project.uri,
            gitRepository: { uri: project.uri, workTreeUri, gitHubInfo, ...gitFields },
        }],
    };
}
```

**workTreeUri 语义**：当 `workingDirectory !== project.uri` 时，`workTreeUri = workingDirectory`，否则为 `undefined`。即"工作目录与项目根不同 = 在 worktree 中"。

### 本项目（fork）

session 的 `workspace.repositories[0].workingDirectory` 直接是 worktree 路径。没有单独的 `workTreeUri` 字段，也没有 `buildAgentHostSessionWorkspace` 等价的构建函数（在 provider 层直接构建）。

### 差异

| 维度 | 上游 | fork |
|------|------|------|
| worktree 标识 | `folders[0].gitRepository?.workTreeUri` | `repositories[0]?.workingDirectory` |
| workTreeUri 语义 | 工作目录 ≠ 项目根时才设值 | 无此字段，直接用 workingDirectory |
| workspace 构建 | `buildAgentHostSessionWorkspace()` 统一构建 | 各 provider 自行构建 |
| worktree 检测 | `!!workTreeUri` | `!!workingDirectory`（但 workingDirectory 总是有值，即使是主仓库） |

**重要**：fork 的 `workingDirectory` 在非 worktree 场景也有值（指向主仓库），因此不能像上游那样用 `!!workTreeUri` 来判断"是否在 worktree 中"。这是 dispatcher 适配时的关键差异。

---

## 5. 自动任务派发（WorktreeCreatedTaskDispatcher）

### 上游 VS Code

```ts
// worktreeCreatedTaskDispatcher.ts
if (!session.workspace.read(reader)?.folders.some(folder => !!folder.gitRepository?.workTreeUri)) {
    return;  // 等待 workTreeUri 出现
}
```

- 检测 `folders[0].gitRepository?.workTreeUri` 非空
- 用 `registerAutorunSelfDisposable` + `reader.dispose()` 实现一次性触发
- 有 `capabilities.runsWorktreeCreatedTasks` 避免双重执行
- 有 `AGENT_HOST_RUN_WORKTREE_CREATED_TASKS_SETTING` 配置开关

### 本项目（fork，刚移植）

```ts
// worktreeCreatedTaskDispatcher.ts
if (!workspace?.repositories.some(repo => !!repo.workingDirectory)) {
    return;  // 等待 workingDirectory 出现
}
```

- 检测 `repositories[0]?.workingDirectory` 非空
- 用外部 `dispatched` 标志 + `autorunDisposable.dispose()` 替代 `reader.dispose()`
- 有 `capabilities.runsWorktreeCreatedTasks`（刚添加）
- **没有** `IConfigurationService` 配置开关（已移除，因 fork 无 `isAgentHostProviderId`）
- **潜在问题**：`workingDirectory` 在非 worktree 场景也有值，可能导致 dispatcher 对非 worktree session 也触发

---

## 6. Checkpoint（检查点）机制

### 上游 VS Code

在 `AgentHostGitService` 中：
```ts
async captureWorkingTreeAsTree(workingDirectory: URI): Promise<string | undefined> { ... }
async commitTree(repositoryRoot: URI, treeOid: string, parentOid: string | undefined, message: string): Promise<string | undefined> { ... }
async updateRef(repositoryRoot: URI, ref: string, newOid: string): Promise<void> { ... }
async deleteRefs(repositoryRoot: URI, refs: readonly string[]): Promise<void> { ... }
async computeFileDiffsBetweenRefs(...): Promise<readonly ISessionFileDiff[] | undefined> { ... }
```

- 用临时 git index (`GIT_INDEX_FILE`) 捕获工作树状态
- `write-tree` 生成 tree object
- `commit-tree` 创建无 ref 的悬挂 commit
- `update-ref` 将 checkpoint ref 指向该 commit
- 支持两个 ref 之间的 diff 计算

### 本项目（fork）

有独立的 `IWorktreeCheckpointService` + 两套实现：
- `browser/worktreeCheckpointServiceImpl.ts` — Browser 端
- `node/worktreeCheckpointServiceImpl.ts` — Node 端

还有 `worktreeCheckpointCommands.ts` 注册 checkpoint 相关命令。

**差异**：fork 把 checkpoint 从 git service 中提取为独立服务，有 UI 命令入口。

---

## 7. Terminal 集成

### 上游 VS Code

`sessions/contrib/terminal/browser/sessionsTerminalContribution.ts` 中有 `AgentHostSessionTaskRunner`（terminal-based task runner），支持在 session 的 worktree cwd 中执行命令。

### 本项目（fork）

同样有 `sessionsTerminalContribution.ts`，但可能缺少 `AgentHostSessionTaskRunner`（fork 的 runner 目前只有 `WorkbenchSessionTaskRunner`）。

---

## 8. 完整差异矩阵

| 维度 | 上游 VS Code | 本项目 (fork) | 差异程度 |
|------|-------------|--------------|---------|
| **数据模型** | `folders[].gitRepository.workTreeUri` | `repositories[].workingDirectory` | 🔴 高（结构性） |
| **workspace 构建** | `buildAgentHostSessionWorkspace()` 统一 | 各 provider 自行构建 | 🟡 中 |
| **worktree 创建** | agent-host Node 进程 | workbench Browser 进程 | 🔴 高（进程不同） |
| **worktree CRUD** | 基本操作 | 完整 CRUD + prune + reset | 🟢 fork 更强 |
| **worktree UI** | 无 | 树视图 + 命令面板 | 🟢 fork 独有 |
| **Checkpoint** | 在 GitService 中 | 独立服务 + UI 命令 | 🟢 fork 更强 |
| **两阶段创建** | 无 | 有（opencode 兼容） | 🟢 fork 独有 |
| **状态管理** | 无 | WorktreeStatus 状态机 | 🟢 fork 独有 |
| **选中状态** | 无 | selectedWorktree observable | 🟢 fork 独有 |
| **自动任务派发** | 有（检测 workTreeUri） | 有（检测 workingDirectory） | 🟡 已适配但语义不同 |
| **runner 注册表** | 有（ISessionTaskRunnerRegistry） | 有（刚移植） | 🟢 已对齐 |
| **默认 runner** | WorkbenchSessionTaskRunner | WorkbenchSessionTaskRunner | 🟢 已对齐 |
| **AgentHost runner** | 有（terminal-based） | ❌ 缺失 | 🟡 中 |
| **preLaunch 自愈** | 有（build/lib/preLaunch.ts） | 有（从上游继承） | 🟢 已对齐 |
| **capabilities.runsWorktreeCreatedTasks** | 有 | 有（刚添加） | 🟢 已对齐 |
| **配置开关** | `chat.agentHost.runWorktreeCreatedTasks` | ❌ 已移除 | 🟡 低 |

---

## 9. 关键风险点

### 9.1 workingDirectory 语义问题

fork 的 `repositories[0].workingDirectory` 在非 worktree 场景也有值（指向主仓库），而上游的 `workTreeUri` 只在 worktree 场景才非空。这可能导致：

- `WorktreeCreatedTaskDispatcher` 对非 worktree session 也触发自动任务（误触发）
- `WorkbenchSessionTaskRunner.canRun()` 对主仓库 session 也返回 true（非预期）

**建议**：需要在 dispatcher 和 runner 中增加"是否真的是 worktree"的判断，例如检查 `workingDirectory` 是否与 `uri` 不同（类似上游 `workTreeUri` 的语义）。

### 9.2 进程模型差异

上游 worktree 创建在 agent-host Node 进程，fork 在 workbench Browser 进程。这意味着：
- 上游的 worktree 创建是服务端行为，不依赖 workbench 状态
- fork 的 worktree 创建依赖 workbench 的 terminal/file 服务

### 9.3 AgentHost runner 缺失

上游有 `AgentHostSessionTaskRunner`（在 terminal contribution 中），支持在 agent-host session 的 worktree 中远程执行任务。fork 目前只有 `WorkbenchSessionTaskRunner`（本地 worktree），对 agent-host session 可能无法正确执行任务。

---

## 10. 总结

| 方面 | 评价 |
|------|------|
| **fork 独有优势** | 完整的 worktree 管理 UI、检查点系统、两阶段创建、状态管理 |
| **fork 对齐上游** | runner registry、worktreeCreatedTaskDispatcher、capabilities 字段 |
| **fork 待改进** | workingDirectory 语义对齐、AgentHost runner、配置开关 |
| **结构性差异** | `folders[].gitRepository.workTreeUri` vs `repositories[].workingDirectory`，需要持续维护适配层 |

fork 在 worktree 管理能力上**强于上游**（有 UI、检查点、状态管理），但在与 session 数据模型的**对齐度上弱于上游**（数据结构差异导致每次移植上游代码都需要适配）。
