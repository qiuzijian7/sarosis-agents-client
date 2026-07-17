# Worktree 自动任务派发优化方案

> 状态：设计文档（仅方案 + 测试用例，未实施）
> 目标：将上游 VS Code 的 `WorktreeCreatedTaskDispatcher` 机制移植到 `vssaros-agents-client`，实现"创建 worktree 即自动 install+watch/编译"的闭环。
> 范围：`src/vs/sessions/contrib/chat/browser` 下的会话任务系统。

---

## 1. 执行摘要

当前 fork 已经具备：
- `sessionsTasksService.ts`：读写 `tasks.json`，识别 `inAgents` 任务。
- `runScriptAction.ts`：标题栏 Run 按钮、F5 绑定、`worktreeCreated` 任务分组、Browser 验证。
- `tasks.json`：已有 `Install & Watch` 任务标记 `runOn: worktreeCreated`。

但缺少关键一环：**自动派发器**。`runOn: worktreeCreated` 的任务只在 UI 上被分类展示，不会在 worktree 创建时自动执行。用户仍需手动开窗口、建 junction、跑 `npm run watch`。

本方案计划：
1. 引入 `ISessionTaskRunnerRegistry` + `WorkbenchSessionTaskRunner` 抽象，让 `runTask` 返回可停止句柄；
2. 改造 `SessionsTasksService` 以支持 runner 分发和 `getSessionTasksOnce`；
3. 新增 `WorktreeCreatedTaskDispatcher`，在 session 检测到 `workTreeUri` 时自动执行所有 `worktreeCreated` 任务；
4. 在 session 归档/移除时自动 dispose 长驻进程句柄，避免泄漏。

实现后，worktree 开发流程将变为：
> Agent 创建 worktree → 自动触发 `Install & Watch` → 用户修改源码 → watch 自动增量编译 → 按 F5 运行 → 浏览器/终端/断点验证。

---

## 2. 现状分析（Gap Analysis）

### 2.1 已存在的文件与能力

| 文件 | 状态 | 说明 |
|------|------|------|
| `sessionsTasksService.ts` | 部分可用 | 已支持 `inAgents` 任务读取、pin/browser、任务 CRUD；但 `runTask` 直接调用 `ITaskService.run` 且返回 `void`，没有 runner 抽象，也没有 `getSessionTasksOnce`。 |
| `runScriptAction.ts` | 基本完整 | 已支持 F5 绑定、Run split-button、worktreeCreated 分组、Browser 验证。 |
| `chat.contribution.ts` | 已注册 | 已注册 `RunScriptContribution` 和 `SessionsTasksService`。 |
| `.vscode/tasks.json` | 已配置 | 有 `Install & Watch` 任务，但 `runOn: worktreeCreated` 无人消费。 |

### 2.2 缺失文件

| 文件 | 上游路径 | 作用 |
|------|----------|------|
| `sessionTaskRunner.ts` | `vscode/src/vs/sessions/contrib/chat/browser/sessionTaskRunner.ts` | 定义 `ISessionTaskRunner` 接口和 `ISessionTaskRunnerRegistry`。 |
| `workbenchSessionTaskRunner.ts` | `vscode/src/vs/sessions/contrib/chat/browser/workbenchSessionTaskRunner.ts` | 默认 workbench runner：用 `ITaskService` 在本地 worktree 跑任务，并返回 `terminate` 句柄。 |
| `registerDefaultSessionTaskRunners.ts` | `vscode/src/vs/sessions/contrib/chat/browser/registerDefaultSessionTaskRunners.ts` | 注册默认 workbench runner。 |
| `worktreeCreatedTaskDispatcher.ts` | `vscode/src/vs/sessions/contrib/chat/browser/worktreeCreatedTaskDispatcher.ts` | 核心：自动派发 worktreeCreated 任务并管理句柄。 |

### 2.3 关键差异

| 维度 | 上游 | 当前 fork |
|------|------|-----------|
| `runTask` 返回值 | `Promise<IDisposable \| undefined>` | `Promise<void>` |
| 任务执行器 | 通过 `ISessionTaskRunnerRegistry` 分发 | 直接调用 `ITaskService` |
| 长驻任务停止 | dispatcher 持有句柄，session 归档时 dispose | 无 |
| 自动派发 | 有 `WorktreeCreatedTaskDispatcher` | 无 |
| `getSessionTasksOnce` | 有，避免共享 observable 并发问题 | 无 |

### 2.4 为什么必须改 `runTask` 返回值

`worktreeCreated` 任务通常是 `npm run watch` 这类长驻进程。dispatcher 需要：
- 在任务启动后拿到**可停止句柄**；
- 当 session 被归档（isArchived）或移除时调用 `dispose()` 停止 watch，避免进程泄漏。

当前 `runTask` 返回 `void`，无法回收句柄，因此必须引入 runner 抽象。

---

## 3. 设计目标

1. **自动**：worktree 创建后自动执行 `runOn: worktreeCreated` 任务，无需手动操作。
2. **可停止**：长驻任务（watch、dev server）在 session 归档/移除时自动停止。
3. **可扩展**：runner 注册表允许后续接入 agent-host runner（远程 worktree 环境）。
4. **最小侵入**：复用现有 `ITaskService` 路径作为默认 runner，不大改 `runScriptAction.ts` 和 UI 逻辑。
5. **可测试**：每个新增组件都有单元测试，dispatcher 有集成测试。

---

## 4. 总体架构

```mermaid
flowchart TD
    subgraph SessionLayer [会话层]
        S1[ISessionsManagementService]
        S2[ISession.workspace.repositories[0].gitRepository.workTreeUri]
    end

    subgraph TaskLayer [任务层]
        T1[SessionsTasksService]
        T2[getSessionTasksOnce]
        T3[runTask -> ISessionTaskRunnerRegistry]
    end

    subgraph RunnerLayer [Runner 层]
        R1[SessionTaskRunnerRegistry]
        R2[WorkbenchSessionTaskRunner<br/>priority=0, 用 ITaskService]
        R3[未来: AgentHostSessionTaskRunner<br/>priority=100]
    end

    subgraph DispatcherLayer [派发层]
        D1[WorktreeCreatedTaskDispatcher]
        D2[按 sessionId 持有 DisposableMap]
        D3[session.isArchived 时 dispose 句柄]
    end

    S1 -->|onDidStartSession| D1
    S2 -->|检测到 workTreeUri| D1
    D1 -->|getSessionTasksOnce| T1
    D1 -->|runTask| T1
    T1 -->|getRunner| R1
    R1 -->|选最高 priority| R2
    R2 -->|启动 + terminate 句柄| T1
    T1 -->|返回 handle| D1
    D1 -->|存句柄| D2
    S1 -->|onDidChangeSessions removed| D2
    S1 -->|isArchived| D3
```

---

## 5. 详细设计

### 5.1 新增 `sessionTaskRunner.ts`

定义两个接口：

```ts
export interface ISessionTaskRunner {
    readonly id: string;
    readonly priority: number;
    canRun(session: ISession): boolean;
    runTask(task: ITaskEntry, session: ISession): Promise<IDisposable | undefined>;
}

export interface ISessionTaskRunnerRegistry {
    readonly _serviceBrand: undefined;
    register(runner: ISessionTaskRunner): IDisposable;
    getRunner(session: ISession): ISessionTaskRunner | undefined;
}

export class SessionTaskRunnerRegistry implements ISessionTaskRunnerRegistry {
    private readonly _runners: ISessionTaskRunner[] = [];
    register(runner: ISessionTaskRunner): IDisposable { ... }
    getRunner(session: ISession): ISessionTaskRunner | undefined { ... }
}
```

要点：
- `priority` 越高越优先；同优先级按注册顺序后注册胜出。
- `canRun` 用于区分不同 runtime（本地文件 worktree vs 远程 agent host）。
- `runTask` 返回的 `IDisposable` 负责停止任务进程。

### 5.2 改造 `SessionsTasksService`

#### 接口变更

```ts
export interface ISessionsTasksService {
    readonly onDidRunTask: Event<ISessionTaskRunEvent>;

    getSessionTasks(session: ISession): IObservable<readonly ISessionTaskWithTarget[]>;
    getSessionTasksOnce(session: ISession): Promise<readonly ISessionTaskWithTarget[]>;
    getAllTasks(session: ISession): Promise<readonly ISessionTaskWithTarget[]>;
    getNonSessionTasks(session: ISession): Promise<readonly INonSessionTaskEntry[]>;

    runTask(task: ITaskEntry, session: ISession): Promise<IDisposable | undefined>;

    // ... 保持原有 pin/browser/CRUD 方法不变
}
```

#### 构造函数变更

```diff
 constructor(
     @IFileService private readonly _fileService: IFileService,
     @IJSONEditingService private readonly _jsonEditingService: IJSONEditingService,
     @IPreferencesService private readonly _preferencesService: IPreferencesService,
-    @ITaskService private readonly _taskService: ITaskService,
+    @ISessionTaskRunnerRegistry private readonly _taskRunnerRegistry: ISessionTaskRunnerRegistry,
     @IStorageService private readonly _storageService: IStorageService,
 ) {
     super();
+    this._onDidRunTask = this._register(new Emitter<ISessionTaskRunEvent>());
     ...
 }
```

#### `runTask` 实现变更

```ts
async runTask(task: ITaskEntry, session: ISession): Promise<IDisposable | undefined> {
    const runner = this._taskRunnerRegistry.getRunner(session);
    if (!runner) {
        return undefined;
    }
    const handle = await runner.runTask(task, session);
    this._onDidRunTask.fire({ task, session });
    return handle;
}
```

#### 新增 `getSessionTasksOnce` / `getAllTasks`

提取一个公共方法 `_readTasksFromBothTargets(session, predicate)`：

```ts
async getSessionTasksOnce(session: ISession): Promise<readonly ISessionTaskWithTarget[]> {
    return this._readTasksFromBothTargets(session, t => !!t.inAgents);
}

async getAllTasks(session: ISession): Promise<readonly ISessionTaskWithTarget[]> {
    return this._readTasksFromBothTargets(session, () => true);
}

private async _readTasksFromBothTargets(
    session: ISession,
    predicate: (task: ITaskEntry) => boolean
): Promise<ISessionTaskWithTarget[]> {
    const result: ISessionTaskWithTarget[] = [];
    for (const target of (['workspace', 'user'] as TaskStorageTarget[])) {
        const uri = this._getTasksJsonUri(session, target);
        if (!uri) continue;
        const json = await this._readTasksJson(uri);
        for (const task of json.tasks ?? []) {
            if (predicate(task) && this._isSupportedTask(task)) {
                result.push({ task, target });
            }
        }
    }
    return result;
}
```

注意：当前 `getSessionTasks` 使用共享 observable `_sessionTasks`，在并发为多个 session 读取时可能互相覆盖。`getSessionTasksOnce` 不碰共享 observable，专供 dispatcher 使用。

### 5.3 新增 `workbenchSessionTaskRunner.ts`

```ts
export class WorkbenchSessionTaskRunner implements ISessionTaskRunner {
    readonly id = 'workbench';
    readonly priority = 0;

    constructor(
        @ITaskService private readonly _taskService: ITaskService,
        @IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
    ) { }

    canRun(session: ISession): boolean {
        const cwd = this._getCwd(session);
        if (!cwd || cwd.scheme !== Schemas.file) {
            return false;
        }
        return !!this._workspaceContextService.getWorkspaceFolder(cwd);
    }

    async runTask(task: ITaskEntry, session: ISession): Promise<IDisposable | undefined> {
        const cwd = this._getCwd(session);
        if (!cwd) return undefined;
        const workspaceFolder = this._workspaceContextService.getWorkspaceFolder(cwd);
        if (!workspaceFolder) return undefined;

        const resolved = await this._taskService.getTask(workspaceFolder, task.label);
        if (!resolved) return undefined;

        await this._taskService.run(resolved, undefined, TaskRunSource.User);

        return toDisposable(() => {
            this._taskService.terminate(resolved);
        });
    }

    private _getCwd(session: ISession) {
        const repo = session.workspace.get()?.folders[0];
        return repo?.workingDirectory ?? repo?.root;
    }
}
```

要点：
- 仅对本地文件 scheme 且已加载为 workspace folder 的 session 生效。
- `terminate` 用于停止 watch 等长驻任务。

### 5.4 新增 `registerDefaultSessionTaskRunners.ts`

```ts
export class RegisterDefaultSessionTaskRunnersContribution extends Disposable implements IWorkbenchContribution {
    static readonly ID = 'workbench.contrib.sessions.registerDefaultTaskRunners';

    constructor(
        @IInstantiationService instantiationService: IInstantiationService,
        @ISessionTaskRunnerRegistry registry: ISessionTaskRunnerRegistry,
    ) {
        super();
        const runner = instantiationService.createInstance(WorkbenchSessionTaskRunner);
        this._register(registry.register(runner));
    }
}
```

### 5.5 新增 `worktreeCreatedTaskDispatcher.ts`

```ts
export class WorktreeCreatedTaskDispatcher extends Disposable implements IWorkbenchContribution {
    static readonly ID = 'workbench.contrib.sessions.worktreeCreatedTaskDispatcher';

    private readonly _sessionDisposables = this._register(new DisposableMap<string>());

    constructor(
        @ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
        @ISessionsTasksService private readonly _sessionsTasksService: ISessionsTasksService,
        @IConfigurationService private readonly _configurationService: IConfigurationService,
        @ILogService private readonly _logService: ILogService,
    ) {
        super();
        this._register(this._sessionsManagementService.onDidStartSession(session => this._trackSession(session)));
        this._register(this._sessionsManagementService.onDidChangeSessions(e => this._onDidRemoveSessions(e.removed)));
    }

    private _onDidRemoveSessions(removed: readonly ISession[]): void {
        for (const session of removed) {
            this._sessionDisposables.deleteAndDispose(session.sessionId);
        }
    }

    private _trackSession(session: ISession): void {
        if (session.capabilities.runsWorktreeCreatedTasks) {
            return; // 服务端已自行处理
        }
        if (this._sessionDisposables.get(session.sessionId)) {
            return;
        }

        const store = new DisposableStore();
        this._sessionDisposables.set(session.sessionId, store);

        const taskHandles = store.add(new DisposableStore());

        registerAutorunSelfDisposable(store, reader => {
            if (session.loading.read(reader)) return;
            if (session.status.read(reader) === SessionStatus.Untitled) return;
            if (!session.workspace.read(reader)?.folders.some(folder => !!folder.gitRepository?.workTreeUri)) return;
            reader.dispose();
            this._dispatchWorktreeCreatedTasks(session, taskHandles);
        });

        store.add(autorun(reader => {
            if (session.isArchived.read(reader)) {
                taskHandles.clear();
            }
        }));
    }

    private async _dispatchWorktreeCreatedTasks(session: ISession, taskHandles: DisposableStore): Promise<void> {
        if (isAgentHostProviderId(session.providerId) &&
            !this._configurationService.getValue<boolean>(AGENT_HOST_RUN_WORKTREE_CREATED_TASKS_SETTING)) {
            return;
        }

        let tasks;
        try {
            tasks = await this._sessionsTasksService.getSessionTasksOnce(session);
        } catch (err) {
            this._logService.warn(...);
            return;
        }

        for (const { task } of tasks) {
            if (task.runOptions?.runOn !== 'worktreeCreated') continue;

            try {
                const handle = await this._sessionsTasksService.runTask(task, session);
                if (handle) {
                    if (session.isArchived.get()) {
                        handle.dispose();
                    } else {
                        taskHandles.add(handle);
                    }
                }
            } catch (err) {
                this._logService.warn(...);
            }
        }
    }
}
```

关键行为：
- 只在新 session 上跟踪，不追溯已存在 session（避免重跑）。
- 监听 `loading` / `status` / `workspace.folders.gitRepository.workTreeUri`，三者就绪才触发。
- 触发后调用 `getSessionTasksOnce` 读取任务，只跑 `runOn === 'worktreeCreated'` 的任务。
- 拿到句柄后，若 session 已归档则立即 dispose，否则加入 `taskHandles`。
- session 归档时 `taskHandles.clear()` 会自动 dispose 所有 watch 进程。
- session 移除时 `_sessionDisposables.deleteAndDispose(...)` 清理整个 store。

### 5.6 新增配置项

在 `src/vs/sessions/contrib/chat/browser` 中暴露设置：

```ts
export const AGENT_HOST_RUN_WORKTREE_CREATED_TASKS_SETTING = 'chat.agentHost.runWorktreeCreatedTasks';
```

注册点（可选，若 fork 已有配置系统）：

```ts
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
    id: 'chat',
    properties: {
        [AGENT_HOST_RUN_WORKTREE_CREATED_TASKS_SETTING]: {
            type: 'boolean',
            default: true,
            description: localize('worktreeCreatedTasks', "Automatically run tasks marked 'runOn: worktreeCreated' when a new agent worktree is created."),
        }
    }
});
```

### 5.7 注册点调整

在 `chat.contribution.ts` 中：

```diff
 import { ISessionsTasksService, SessionsTasksService } from './sessionsTasksService.js';
 import { RunScriptContribution } from './runScriptAction.js';
+import { ISessionTaskRunnerRegistry, SessionTaskRunnerRegistry } from './sessionTaskRunner.js';
+import { RegisterDefaultSessionTaskRunnersContribution } from './registerDefaultSessionTaskRunners.js';
+import { WorktreeCreatedTaskDispatcher } from './worktreeCreatedTaskDispatcher.js';

 // ...

 registerWorkbenchContribution2(RunScriptContribution.ID, RunScriptContribution, WorkbenchPhase.AfterRestored);
+registerWorkbenchContribution2(RegisterDefaultSessionTaskRunnersContribution.ID, RegisterDefaultSessionTaskRunnersContribution, WorkbenchPhase.AfterRestored);
+registerWorkbenchContribution2(WorktreeCreatedTaskDispatcher.ID, WorktreeCreatedTaskDispatcher, WorkbenchPhase.AfterRestored);
 registerWorkbenchContribution2(SessionsOpenerParticipantContribution.ID, SessionsOpenerParticipantContribution, WorkbenchPhase.BlockStartup);

 // register services
 registerSingleton(ISessionsTasksService, SessionsTasksService, InstantiationType.Delayed);
+registerSingleton(ISessionTaskRunnerRegistry, SessionTaskRunnerRegistry, InstantiationType.Eager);
```

注意：
- `ISessionTaskRunnerRegistry` 需要 Eager 实例化，因为 contribution 注册时就要用到。
- `SessionsTasksService` 仍可为 Delayed，但它在第一次被注入时会依赖 registry。

### 5.8 兼容性处理

由于 `runTask` 返回类型从 `void` 变为 `IDisposable | undefined`，所有调用点需要适配：

| 调用点 | 当前代码 | 适配方式 |
|--------|--------|----------|
| `runScriptAction.ts:231` | `await this._sessionsConfigService.runTask(task, session);` | 无需逻辑改动，忽略返回值即可。 |
| `runScriptAction.ts:240` | 同上 | 同上。 |
| `runScriptAction.ts:729` | 同上 | 同上。 |
| `runScriptAction.ts:753` | 同上 | 同上。 |

所有调用点都是 `await` 但不使用返回值，因此只需要把接口签名改过来即可编译通过。

---

## 6. 文件改动清单

### 6.1 新增文件

| 文件路径 | 说明 |
|----------|------|
| `src/vs/sessions/contrib/chat/browser/sessionTaskRunner.ts` | Runner 接口与注册表。 |
| `src/vs/sessions/contrib/chat/browser/workbenchSessionTaskRunner.ts` | 默认 workbench runner。 |
| `src/vs/sessions/contrib/chat/browser/registerDefaultSessionTaskRunners.ts` | 注册默认 runner 的 contribution。 |
| `src/vs/sessions/contrib/chat/browser/worktreeCreatedTaskDispatcher.ts` | 核心自动派发器。 |
| `src/vs/sessions/contrib/chat/test/browser/worktreeCreatedTaskDispatcher.test.ts` | dispatcher 单元测试。 |
| `src/vs/sessions/contrib/chat/test/browser/sessionTaskRunner.test.ts` | registry 单元测试。 |
| `src/vs/sessions/contrib/chat/test/browser/sessionsTaskService.test.ts` | 改造后 task service 单元测试。 |

### 6.2 修改文件

| 文件路径 | 改动点 |
|----------|--------|
| `src/vs/sessions/contrib/chat/browser/sessionsTasksService.ts` | 注入 `ISessionTaskRunnerRegistry` 替代 `ITaskService`；`runTask` 返回 `IDisposable \| undefined`；新增 `getSessionTasksOnce`/`getAllTasks`/`onDidRunTask`；新增 `_readTasksFromBothTargets`。 |
| `src/vs/sessions/contrib/chat/browser/chat.contribution.ts` | 注册 `ISessionTaskRunnerRegistry`、默认 runner contribution、dispatcher contribution。 |
| `src/vs/sessions/contrib/chat/browser/runScriptAction.ts` | 无需逻辑改动，但需编译通过（接口签名已兼容）。 |
| `src/vs/sessions/contrib/chat/test/browser/runScriptAction.test.ts` | 如有 mock，需补充 `onDidRunTask`/`getSessionTasksOnce` stub。 |

---

## 7. 测试用例

### 7.1 单元测试：`SessionTaskRunnerRegistry`

**文件**：`src/vs/sessions/contrib/chat/test/browser/sessionTaskRunner.test.ts`

| 用例 | 输入 | 预期 |
|------|------|------|
| 注册单一 runner | 注册一个 `priority=0` 且 `canRun=true` 的 runner | `getRunner` 返回该 runner |
| 按 priority 选择 | 注册 `priority=0` 和 `priority=100` 两个 runner | `getRunner` 返回 priority=100 |
| 同 priority 后注册胜出 | 注册 A(priority=0)、B(priority=0) | 返回 B |
| `canRun=false` 被跳过 | 注册 A(canRun=false)、B(canRun=true) | 返回 B |
| 无 runner 返回 undefined | 空注册表 | `getRunner` 返回 undefined |
| 注销 runner | 注册 A 后 dispose 返回的 IDisposable | `getRunner` 返回 undefined |

### 7.2 单元测试：`WorkbenchSessionTaskRunner`

| 用例 | 输入 | 预期 |
|------|------|------|
| 本地文件 worktree 可运行 | session.workspace.folders[0].root = `file:///repo/.worktrees/feat` 且已加载为 workspace folder | `canRun` 返回 true |
| 非 file scheme 不可运行 | root = `vscode-remote://...` | `canRun` 返回 false |
| 未加载为 workspace folder 不可运行 | root 不在 workspace folders 中 | `canRun` 返回 false |
| 运行任务返回 terminate 句柄 | mock `ITaskService.getTask` 返回 task，mock `run` 成功 | `runTask` 返回 IDisposable，调用 dispose 时触发 `terminate` |
| 任务未找到 | `ITaskService.getTask` 返回 undefined | `runTask` 返回 undefined |

### 7.3 单元测试：`SessionsTasksService`（改造后）

| 用例 | 输入 | 预期 |
|------|------|------|
| `getSessionTasksOnce` 读取 workspace + user | workspace 和 user tasks.json 各一个 inAgents 任务 | 返回两个任务，target 正确 |
| `getSessionTasksOnce` 不污染共享 observable | 连续为 session A、B 调用 | `_sessionTasks` 不被覆盖 |
| `getAllTasks` 返回所有任务 | 两个 inAgents + 一个非 inAgents | 返回三个任务 |
| `runTask` 通过 registry 分发 | mock registry 返回 runner | runner.runTask 被调用，并触发 `onDidRunTask` |
| `runTask` 返回 runner 句柄 | mock runner 返回 IDisposable | `runTask` 返回相同 IDisposable |
| `runTask` 无 runner 返回 undefined | registry 返回 undefined | 返回 undefined，不触发 `onDidRunTask` |

### 7.4 集成测试：`WorktreeCreatedTaskDispatcher`

**文件**：`src/vs/sessions/contrib/chat/test/browser/worktreeCreatedTaskDispatcher.test.ts`

#### 测试用例 1：检测到 worktree 后自动派发 worktreeCreated 任务

```ts
test('dispatches worktreeCreated tasks when workTreeUri becomes available', async () => {
    const session = createMockSession({
        sessionId: 's1',
        providerId: 'someProvider',
        loading: false,
        status: SessionStatus.Active,
        isArchived: false,
        workspace: { folders: [ { root: uri, gitRepository: { workTreeUri: uri } } ] }
    });

    const tasksService = {
        getSessionTasksOnce: sinon.stub().resolves([
            { task: { label: 'Install & Watch', runOptions: { runOn: 'worktreeCreated' } }, target: 'workspace' },
            { task: { label: 'Quick Compile', runOptions: { runOn: 'default' } }, target: 'workspace' }
        ]),
        runTask: sinon.stub().resolves({ dispose: () => {} })
    };

    const dispatcher = new WorktreeCreatedTaskDispatcher(sessionsManagement, tasksService, configService, logService);

    // 模拟 session 启动事件
    onDidStartSessionEmitter.fire(session);

    await waitForMicrotasks();

    expect(tasksService.getSessionTasksOnce.calledOnceWith(session)).toBe(true);
    expect(tasksService.runTask.calledOnce).toBe(true);
    expect(tasksService.runTask.firstCall.args[0].label).toBe('Install & Watch');
});
```

#### 测试用例 2：不派发非 worktreeCreated 任务

输入：两个任务，一个 `runOn: 'worktreeCreated'`，一个 `runOn: 'default'`。
预期：只调用一次 `runTask`，且是 `worktreeCreated` 那个。

#### 测试用例 3：session 归档时 dispose 句柄

输入：派发了一个返回 IDisposable 的任务，随后 session.isArchived 变为 true。
预期：`dispose` 被调用一次。

#### 测试用例 4：session 移除时清理资源

输入：session 已派发任务，随后 `onDidChangeSessions` 报告该 session 被移除。
预期：与该 session 关联的 DisposableStore 被 dispose。

#### 测试用例 5：不追溯已存在 session

输入：dispatcher 创建前已存在的 session，随后被加入 management service。
预期：不触发派发（因为 `onDidStartSession` 只对新 session 触发）。

#### 测试用例 6：capabilities.runsWorktreeCreatedTasks 为 true 时跳过

输入：session.capabilities.runsWorktreeCreatedTasks = true。
预期：不读取任务、不调用 runTask。

#### 测试用例 7：配置关闭时 agent host session 跳过

输入：session.providerId 为 agent host provider，配置 `chat.agentHost.runWorktreeCreatedTasks` = false。
预期：不派发。

#### 测试用例 8：workTreeUri 未就绪时不派发

输入：session.loading = true。
预期：不派发；loading 变为 false 且 workTreeUri 出现后才派发。

#### 测试用例 9：已归档 session 派发时立即 dispose

输入：派发时 `session.isArchived.get()` 已经为 true。
预期：即使 runTask 返回句柄，也立即调用 dispose，不加入 taskHandles。

### 7.5 E2E / 手动测试清单

| 步骤 | 操作 | 通过标准 |
|------|------|----------|
| 1 | 在 chat 中创建新 session，触发 worktree 创建 | 新 worktree 目录出现 |
| 2 | 观察终端/任务输出 | `Install & Watch` 自动开始执行（`npm ci` 或 `npm run watch`） |
| 3 | 等待 `npm run watch` 完成首次编译 | `out/` 目录生成 |
| 4 | 修改 worktree 中 `src/` 文件 | 终端显示 watch 增量编译 |
| 5 | 按 F5 | 启动该 worktree 的 Electron 开发版 |
| 6 | 验证修改 | UI 行为或日志反映修改 |
| 7 | 将 session 归档 | watch 进程被终止（终端显示停止） |
| 8 | 切换新 session（新 worktree） | 重复步骤 2-7，无端口冲突 |

---

## 8. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| `runTask` 返回类型变更导致编译失败 | 中 | 搜索所有调用点（目前仅 `runScriptAction.ts` 4 处），确认均可忽略返回值。 |
| 自动 `npm ci` 太慢/失败 | 中 | 保留配置开关 `chat.agentHost.runWorktreeCreatedTasks`，用户可关闭；后续可优化为 junction 复用依赖。 |
| 多个 worktree 同时 watch 导致资源占用高 | 中 | 当前架构同一时间只活跃一个 session；归档时自动 stop。 |
| `ITaskService.terminate` 无法停止某些任务 | 低 | 使用 VS Code 内置任务终止机制，对于无法终止的进程，session 移除时 dispose store 会释放其他资源。 |
| 与现有 `runScriptAction` 冲突 | 低 | `runTask` 签名兼容，UI 逻辑不变。 |
| 依赖注入循环 | 低 | `ISessionTaskRunnerRegistry` 为 Eager，无外部依赖；`SessionsTasksService` 注入它，无循环。 |

---

## 9. 实施步骤（建议顺序）

1. **新增 `sessionTaskRunner.ts`**：定义接口和注册表。
2. **新增 `workbenchSessionTaskRunner.ts`**：实现默认 runner。
3. **改造 `sessionsTasksService.ts`**：
   - 替换 `ITaskService` 依赖为 `ISessionTaskRunnerRegistry`；
   - 修改 `runTask` 签名与实现；
   - 新增 `getSessionTasksOnce`/`getAllTasks`/`onDidRunTask`。
4. **新增 `registerDefaultSessionTaskRunners.ts`**：注册 workbench runner。
5. **新增 `worktreeCreatedTaskDispatcher.ts`**：核心派发器。
6. **修改 `chat.contribution.ts`**：注册 registry、runner、dispatcher。
7. **运行编译**：`npm run compile`，修复类型错误。
8. **编写测试**：按第 7 节实现单元测试和集成测试。
9. **运行测试**：`npm run test-node` 或 `npm run test-browser` 对应测试文件。
10. **E2E 验证**：按第 7.5 节手动验证。

---

## 10. 验收标准

- [ ] 新增 `sessionTaskRunner.ts`、`workbenchSessionTaskRunner.ts`、`registerDefaultSessionTaskRunners.ts`、`worktreeCreatedTaskDispatcher.ts` 四个文件。
- [ ] `sessionsTasksService.ts` 中 `runTask` 返回 `Promise<IDisposable | undefined>`，且 `runScriptAction.ts` 无需逻辑改动即可编译。
- [ ] `chat.contribution.ts` 正确注册 runner registry 和 dispatcher。
- [ ] 新 session 创建 worktree 后，`runOn: worktreeCreated` 任务自动执行。
- [ ] session 归档时，watch 等长驻任务被终止。
- [ ] 单元测试覆盖 registry、runner、task service、dispatcher 的核心路径。
- [ ] 通过 `tsgo` 或 `npm run compile` 全项目编译检查。

---

*本文档为设计阶段产物，未修改任何源码。确认方案后，可进入 Craft 模式按第 9 节顺序实施。*
