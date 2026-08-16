# Saros Agents Client - 插件系统架构分析

## 目录
1. [概述](#概述)
2. [插件系统架构](#插件系统架构)
3. [插件格式支持](#插件格式支持)
4. [插件发现机制](#插件发现机制)
5. [插件服务实现](#插件服务实现)
6. [插件市场服务](#插件市场服务)
7. [插件UI实现](#插件ui实现)
8. [插件列表获取流程](#插件列表获取流程)
9. [插件安装与管理](#插件安装与管理)
10. [扩展机制](#扩展机制)

---

## 概述

Saros Agents Client 采用了一套灵活的插件系统架构，支持多种插件格式和多种发现机制。插件系统允许扩展 AI 代理的功能，包括添加自定义命令、技能、钩子（hooks）、指令和 MCP 服务器定义。

### 核心特性
- **多格式支持**: 支持 Copilot、Claude 和 OpenPlugin 三种插件格式
- **多源发现**: 支持从配置、市场、扩展和 CLI 等多种来源发现插件
- **动态加载**: 基于 Observable 机制实现插件的动态发现和更新
- **生命周期管理**: 支持插件的启用、禁用、安装、卸载等操作

---

## 插件系统架构

### 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                    UI 展示层                                  │
│  - AgentPluginsView (插件列表视图)                            │
│  - AgentPluginEditor (插件编辑器)                              │
│  - PluginsViewPane (Agent Studio 插件面板)                    │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                  服务层                                        │
│  - IAgentPluginService (插件服务接口)                        │
│  - IPluginMarketplaceService (市场服务接口)                   │
│  - IPluginInstallService (安装服务接口)                       │
│  - IAgentPluginRepositoryService (仓库服务接口)               │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                 发现层                                        │
│  - ConfiguredAgentPluginDiscovery (配置发现)                  │
│  - MarketplaceAgentPluginDiscovery (市场发现)                 │
│  - ExtensionAgentPluginDiscovery (扩展发现)                    │
│  - CopilotCliAgentPluginDiscovery (CLI发现)                  │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                 解析层                                        │
│  - pluginParsers.ts (插件解析器)                             │
│  - 支持格式: Copilot/Claude/OpenPlugin                      │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                 源层                                          │
│  - GitHub/GitUrl/Npm/Pip/RelativePath                        │
└─────────────────────────────────────────────────────────────────┘
```

### 关键文件位置

| 组件 | 文件路径 |
|------|---------|
| 插件服务接口 | `src/vs/workbench/contrib/chat/common/plugins/agentPluginService.ts` |
| 插件服务实现 | `src/vs/workbench/contrib/chat/common/plugins/agentPluginServiceImpl.ts` |
| 插件解析器 | `src/vs/platform/agentPlugins/common/pluginParsers.ts` |
| 插件市场服务 | `src/vs/workbench/contrib/chat/common/plugins/pluginMarketplaceService.ts` |
| 插件安装服务 | `src/vs/workbench/contrib/chat/common/plugins/pluginInstallService.ts` |
| 插件视图 | `src/vs/workbench/contrib/chat/browser/agentPluginsView.ts` |
| Agent Studio 插件视图 | `src/vs/sessions/contrib/agentStudio/browser/views/pluginsView.ts` |

---

## 插件格式支持

### 支持的插件格式

插件系统支持三种插件格式，通过 `PluginFormat` 枚举定义：

```typescript
// 文件位置: src/vs/platform/agentPlugins/common/pluginParsers.ts

export const enum PluginFormat {
    Copilot,    // plugin.json
    Claude,     // .claude-plugin/plugin.json
    OpenPlugin  // .plugin/plugin.json
}
```

### 格式检测逻辑

系统通过 `detectPluginFormat()` 函数自动检测插件格式：

```typescript
// 文件位置: src/vs/platform/agentPlugins/common/pluginParsers.ts

export async function detectPluginFormat(pluginUri: URI, fileService: IFileService): Promise<IPluginFormatConfig> {
    // 1. 优先检查 OpenPlugin 格式 (._plugin/plugin.json)
    if (await pathExists(joinPath(pluginUri, '.plugin', 'plugin.json'), fileService)) {
        return OPEN_PLUGIN_FORMAT;
    }

    // 2. 检查是否在 .claude 目录或存在 Claude 格式
    const isInClaudeDirectory = pluginUri.path.split('/').includes('.claude');
    if (isInClaudeDirectory || await pathExists(joinPath(pluginUri, '.claude-plugin', 'plugin.json'), fileService)) {
        return CLAUDE_FORMAT;
    }

    // 3. 默认 Copilot 格式
    return COPILOT_FORMAT;
}
```

### 格式配置

每种格式有对应的配置对象，定义了解析规则：

```typescript
// Copilot 格式
const COPILOT_FORMAT: IPluginFormatConfig = {
    format: PluginFormat.Copilot,
    manifestPath: 'plugin.json',
    hookConfigPath: 'hooks.json',
    pluginRootToken: undefined,
    pluginRootEnvVar: undefined,
    parseHooks(hookUri, json, _pluginUri, workspaceRoot, userHome) {
        return parseHooksJson(hookUri, json, workspaceRoot, userHome);
    },
};

// Claude 格式
const CLAUDE_FORMAT: IPluginFormatConfig = {
    format: PluginFormat.Claude,
    manifestPath: '.claude-plugin/plugin.json',
    hookConfigPath: 'hooks/hooks.json',
    pluginRootToken: '${CLAUDE_PLUGIN_ROOT}',
    pluginRootEnvVar: 'CLAUDE_PLUGIN_ROOT',
    parseHooks(hookUri, json, pluginUri, workspaceRoot, userHome) {
        return interpolateHookPluginRoot(hookUri, json, pluginUri, workspaceRoot, userHome, '${CLAUDE_PLUGIN_ROOT}', 'CLAUDE_PLUGIN_ROOT');
    },
};

// OpenPlugin 格式
const OPEN_PLUGIN_FORMAT: IPluginFormatConfig = {
    format: PluginFormat.OpenPlugin,
    manifestPath: '.plugin/plugin.json',
    hookConfigPath: 'hooks/hooks.json',
    pluginRootToken: '${PLUGIN_ROOT}',
    pluginRootEnvVar: 'PLUGIN_ROOT',
    parseHooks(hookUri, json, pluginUri, workspaceRoot, userHome) {
        return interpolateHookPluginRoot(hookUri, json, pluginUri, workspaceRoot, userHome, '${PLUGIN_ROOT}', 'PLUGIN_ROOT');
    },
};
```

---

## 插件发现机制

### 发现器架构

插件发现采用**策略模式**，每种来源有独立的发现器。所有发现器都实现 `IAgentPluginDiscovery` 接口：

```typescript
// 文件位置: src/vs/workbench/contrib/chat/common/plugins/agentPluginService.ts

export interface IAgentPluginDiscovery extends IDisposable {
    readonly plugins: IObservable<readonly IAgentPlugin[]>;
    start(enablementModel: IEnablementModel): void;
}
```

### 发现器注册

发现器通过 `AgentPluginDiscoveryRegistry` 注册：

```typescript
// 文件位置: src/vs/workbench/contrib/chat/common/plugins/agentPluginService.ts

class AgentPluginDiscoveryRegistry {
    private readonly _discovery: SyncDescriptor0<IAgentPluginDiscovery>[] = [];

    register(descriptor: SyncDescriptor0<IAgentPluginDiscovery>): void {
        this._discovery.push(descriptor);
    }

    getAll(): readonly SyncDescriptor0<IAgentPluginDiscovery>[] {
        return this._discovery;
    }
}

export const agentPluginDiscoveryRegistry = new AgentPluginDiscoveryRegistry();
```

### 各类发现器

#### 1. ConfiguredAgentPluginDiscovery - 配置发现的插件

从 `chat.pluginLocations` 配置中读取插件路径：

```typescript
// 伪代码示例
class ConfiguredAgentPluginDiscovery extends AbstractAgentPluginDiscovery {
    private readonly _pluginLocationsConfig: IObservable<Record<string, boolean>>;

    protected override async _discoverPluginSources(): Promise<readonly IPluginSource[]> {
        const config = this._pluginLocationsConfig.get();
        const userHome = await this._getUserHome();

        for (const [path, enabled] of Object.entries(config)) {
            if (!path.trim() || enabled === false) continue;
            const resources = this._resolvePluginPath(path.trim(), userHome);
            // ... 解析并返回插件源
        }
    }
}
```

#### 2. MarketplaceAgentPluginDiscovery - 市场安装的插件

从市场安装的插件目录中发现插件：

```typescript
// 伪代码示例
class MarketplaceAgentPluginDiscovery extends AbstractAgentPluginDiscovery {
    protected override async _discoverPluginSources(): Promise<readonly IPluginSource[]> {
        const installed = this._pluginMarketplaceService.installedPlugins.get();

        for (const entry of installed) {
            // 从安装目录中发现插件
        }
    }
}
```

#### 3. ExtensionAgentPluginDiscovery - 扩展发现的插件

从已安装的 VSCode 扩展中发现插件：

```typescript
// 伪代码示例
class ExtensionAgentPluginDiscovery extends AbstractAgentPluginDiscovery {
    protected override async _discoverPluginSources(): Promise<readonly IPluginSource[]> {
        const extensions = this._extensionsWorkbenchService.local;

        for (const ext of extensions) {
            // 检查扩展是否包含插件
        }
    }
}
```

#### 4. CopilotCliAgentPluginDiscovery - CLI 发现的插件

从 Copilot CLI 配置的插件目录中发现插件。

### 发现器启动流程

在 `AgentPluginService` 中启动所有注册的发现器：

```typescript
// 文件位置: src/vs/workbench/contrib/chat/common/plugins/agentPluginServiceImpl.ts

export class AgentPluginService extends Disposable implements IAgentPluginService {
    constructor(
        @IInstantiationService instantiationService: IInstantiationService,
        @IConfigurationService configurationService: IConfigurationService,
        @IStorageService storageService: IStorageService,
    ) {
        super();

        this.enablementModel = this._register(new EnablementModel('agentPlugins.enablement', storageService));

        const pluginsEnabled = observableConfigValue(ChatConfiguration.PluginsEnabled, true, configurationService);

        const discoveries: IAgentPluginDiscovery[] = [];
        for (const descriptor of agentPluginDiscoveryRegistry.getAll()) {
            const discovery = instantiationService.createInstance(descriptor);
            this._register(discovery);
            discoveries.push(discovery);
            discovery.start(this.enablementModel);
        }

        this.plugins = derived(read => {
            if (!pluginsEnabled.read(read)) {
                return [];
            }
            return this._dedupeAndSort(discoveries.flatMap(d => d.plugins.read(read)));
        });
    }
}
```

---

## 插件服务实现

### IAgentPlugin 接口

定义插件的核心属性：

```typescript
// 文件位置: src/vs/workbench/contrib/chat/common/plugins/agentPluginService.ts

export interface IAgentPlugin {
    readonly uri: URI;
    /** 插件显示名称 */
    readonly label: string;
    readonly enablement: IObservable<ContributionEnablementState>;
    /** 从发现源中移除插件 */
    remove(): void;

    /** 插件包含的资源 */
    readonly hooks: IObservable<readonly IAgentPluginHook[]>;
    readonly commands: IObservable<readonly IAgentPluginCommand[]>;
    readonly skills: IObservable<readonly IAgentPluginSkill[]>;
    readonly agents: IObservable<readonly IAgentPluginAgent[]>;
    readonly instructions: IObservable<readonly IAgentPluginInstruction[]>;
    readonly mcpServerDefinitions: IObservable<readonly IAgentPluginMcpServerDefinition[]>;

    /** 是否从市场安装 */
    readonly fromMarketplace?: IMarketplacePlugin;
}
```

### 插件资源类型

插件可以包含以下类型的资源：

| 资源类型 | 接口 | 说明 |
|---------|------|------|
| Hooks | `IAgentPluginHook` | 生命周期钩子，在特定事件时执行 |
| Commands | `IAgentPluginCommand` | 自定义命令 |
| Skills | `IAgentPluginSkill` | 技能定义 |
| Agents | `IAgentPluginAgent` | 代理定义 |
| Instructions | `IAgentPluginInstruction` | 指令/规则文件 |
| MCP Servers | `IAgentPluginMcpServerDefinition` | MCP 服务器定义 |

### 插件解析流程

`AbstractAgentPluginDiscovery` 提供了插件解析的通用逻辑：

```typescript
// 文件位置: src/vs/workbench/contrib/chat/common/plugins/agentPluginServiceImpl.ts

export abstract class AbstractAgentPluginDiscovery extends Disposable implements IAgentPluginDiscovery {

    private async _discoverAndBuildPlugins(): Promise<readonly IAgentPlugin[]> {
        const sources = await this._discoverPluginSources();
        const plugins: IAgentPlugin[] = [];
        const seenPluginUris = new Set<string>();

        for (const source of sources) {
            const key = source.uri.toString();
            if (!seenPluginUris.has(key)) {
                seenPluginUris.add(key);
                const format = await detectPluginFormat(source.uri, this._fileService);
                plugins.push(this._toPlugin(source.uri, format, source.fromMarketplace, source.repositoryUri, () => source.remove()));
            }
        }

        this._disposePluginEntriesExcept(seenPluginUris);
        plugins.sort((a, b) => a.uri.toString().localeCompare(b.uri.toString()));
        return plugins;
    }

    private _toPlugin(uri: URI, format: IPluginFormatConfig, fromMarketplace: IMarketplacePlugin | undefined, repositoryUri: URI | undefined, removeCallback: () => void): IAgentPlugin {
        // 创建插件对象，设置 Observable 属性
        // 监听文件系统变化，动态更新插件资源
    }
}
```

---

## 插件市场服务

### IMarketplacePlugin 接口

定义市场插件的属性：

```typescript
// 文件位置: src/vs/workbench/contrib/chat/common/plugins/pluginMarketplaceService.ts

export interface IMarketplacePlugin {
    readonly name: string;
    readonly description: string;
    readonly version: string;
    /** 插件在仓库中的子目录 */
    readonly source: string;
    /** 结构化源描述符，指示如何获取/安装插件 */
    readonly sourceDescriptor: IPluginSourceDescriptor;
    /** 市场标签，显示在 UI 和插件来源中 */
    readonly marketplace: string;
    /** 用于克隆/更新/安装位置解析的规范引用 */
    readonly marketplaceReference: IMarketplaceReference;
    /** 插件来源的市场类型 */
    readonly marketplaceType: MarketplaceType;
    readonly readmeUri?: URI;
}
```

### 插件源类型

支持多种插件源类型：

```typescript
export const enum PluginSourceKind {
    RelativePath = 'relativePath',
    GitHub = 'github',
    GitUrl = 'url',
    Npm = 'npm',
    Pip = 'pip',
}

export type IPluginSourceDescriptor =
    | IRelativePathPluginSource
    | IGitHubPluginSource
    | IGitUrlPluginSource
    | INpmPluginSource
    | IPipPluginSource;
```

### 市场服务接口

```typescript
export interface IPluginMarketplaceService {
    readonly _serviceBrand: undefined;
    readonly onDidChangeMarketplaces: Event<void>;
    /** 已安装的插件，由存储支持 */
    readonly installedPlugins: IObservable<readonly IMarketplaceInstalledPlugin[]>;
    /** 是否有可用更新 */
    readonly hasUpdatesAvailable: IObservable<boolean>;
    /** 最后一次获取插件的结果快照 */
    readonly lastFetchedPlugins: IObservable<readonly IMarketplacePlugin[]>;
    /** 推荐的插件 */
    readonly recommendedPlugins: IObservable<ReadonlySet<string>>;

    /** 获取市场插件列表 */
    fetchMarketplacePlugins(token: CancellationToken): Promise<IMarketplacePlugin[]>;
    /** 获取插件元数据 */
    getMarketplacePluginMetadata(pluginUri: URI): IMarketplacePlugin | undefined;
    /** 添加已安装插件 */
    addInstalledPlugin(pluginUri: URI, plugin: IMarketplacePlugin): void;
    /** 移除已安装插件 */
    removeInstalledPlugin(pluginUri: URI): void;
}
```

### 市场定义文件

市场定义文件可以是以下格式（按优先级）：

```typescript
const MARKETPLACE_DEFINITIONS: { type: MarketplaceType; path: string }[] = [
    { type: MarketplaceType.OpenPlugin, path: 'marketplace.json' },
    { type: MarketplaceType.Claude, path: '.claude/marketplace.json' },
    { type: MarketplaceType.Copilot, path: '.github/.copilot/marketplace.json' },
];
```

---

## 插件UI实现

### AgentPluginsView - 主插件视图

这是显示插件列表的主要视图组件：

```typescript
// 文件位置: src/vs/workbench/contrib/chat/browser/agentPluginsView.ts

class AgentPluginsView extends ... {

    // 渲染插件列表
    private renderPluginsList(plugins: IAgentPlugin[]): void {
        // 使用 WorkbenchPagedList 渲染分页列表
        // 每个插件显示：名称、描述、状态、操作按钮
    }

    // 创建插件操作
    private getPluginActions(plugin: IAgentPlugin): IAction[] {
        // 启用/禁用
        // 安装/卸载
        // 查看详情
        // 更新
    }
}
```

### 插件列表项结构

```typescript
interface IAgentPluginItem {
    kind: AgentPluginItemKind;
    name: string;
    description: string;
    // ... 其他属性
}

enum AgentPluginItemKind {
    Installed,      // 已安装插件
    Marketplace,    // 市场插件
}
```

### UI 渲染流程

1. **创建视图**: `AgentPluginsView` 创建插件列表视图
2. **绑定数据**: 绑定到 `IAgentPluginService.plugins` Observable
3. **渲染列表**: 使用 `WorkbenchPagedList` 渲染分页列表
4. **操作处理**: 为每个插件项创建操作按钮（启用/禁用/安装/卸载/更新）

---

## 插件列表获取流程

### 完整流程图

```
用户打开插件页面
    ↓
AgentPluginsView 初始化
    ↓
读取 IAgentPluginService.plugins Observable
    ↓
触发 AgentPluginService.plugins 重新计算
    ↓
调用所有发现器的 plugins Observable
    ↓
每个发现器执行 _discoverPluginSources()
    ↓
发现插件源 (IPluginSource[])
    ↓
调用 _discoverAndBuildPlugins()
    ↓
对每个插件源:
    - 检测插件格式 (detectPluginFormat)
    - 解析插件资源 (hooks, commands, skills, etc.)
    - 创建 IAgentPlugin 对象
    ↓
去重和排序插件列表
    ↓
更新 plugins Observable
    ↓
UI 自动更新显示插件列表
```

### 详细步骤

#### 步骤 1: 打开插件页面

用户点击插件图标或执行插件相关命令，打开插件视图。

#### 步骤 2: 视图初始化

```typescript
// AgentPluginsView 构造函数
constructor(
    options: IViewletViewOptions,
    @IAgentPluginService private readonly pluginService: IAgentPluginService,
    // ... 其他依赖
) {
    super(options);
    // 监听插件列表变化
    this._register(autorun(reader => {
        const plugins = this.pluginService.plugins.read(reader);
        this._renderPlugins(plugins);
    }));
}
```

#### 步骤 3: 触发插件发现

当 `AgentPluginService.plugins` 被读取时，会自动触发所有发现器的发现流程：

```typescript
this.plugins = derived(read => {
    if (!pluginsEnabled.read(read)) {
        return [];
    }
    return this._dedupeAndSort(discoveries.flatMap(d => d.plugins.read(read)));
});
```

#### 步骤 4: 发现器执行发现

每个发现器执行 `_discoverPluginSources()` 方法：

```typescript
// 以 ConfiguredAgentPluginDiscovery 为例
protected override async _discoverPluginSources(): Promise<readonly IPluginSource[]> {
    const config = this._pluginLocationsConfig.get();
    const userHome = await this._getUserHome();
    const sources: IPluginSource[] = [];

    for (const [path, enabled] of Object.entries(config)) {
        if (!path.trim() || enabled === false) continue;
        const resolvedPath = this._resolvePluginPath(path.trim(), userHome);
        const uri = URI.file(resolvedPath);

        if (await this._pathExists(uri)) {
            sources.push({
                uri,
                fromMarketplace: undefined,
                remove: () => this._removePluginLocation(path),
            });
        }
    }

    return sources;
}
```

#### 步骤 5: 解析插件

发现插件源后，调用 `_discoverAndBuildPlugins()` 解析插件：

```typescript
private async _discoverAndBuildPlugins(): Promise<readonly IAgentPlugin[]> {
    const sources = await this._discoverPluginSources();
    const plugins: IAgentPlugin[] = [];

    for (const source of sources) {
        const format = await detectPluginFormat(source.uri, this._fileService);
        const plugin = this._toPlugin(source.uri, format, source.fromMarketplace, source.repositoryUri, () => source.remove());
        plugins.push(plugin);
    }

    return plugins;
}
```

#### 步骤 6: 更新 UI

插件列表更新后，UI 自动刷新：

```typescript
private _renderPlugins(plugins: IAgentPlugin[]): void {
    // 清空列表
    this.listView.splice(0, this.listView.length);

    // 添加插件项
    const items = plugins.map(p => installedPluginToItem(p, this.labelService));
    this.listView.splice(0, 0, items);
}
```

---

## 插件安装与管理

### 插件安装流程

1. **从市场获取插件列表**: 调用 `IPluginMarketplaceService.fetchMarketplacePlugins()`
2. **选择插件**: 用户从市场插件列表中选择要安装的插件
3. **下载插件**: 根据 `sourceDescriptor` 下载插件（从 GitHub、NPM 等）
4. **安装插件**: 将插件复制到安装目录
5. **注册插件**: 调用 `IPluginMarketplaceService.addInstalledPlugin()`
6. **刷新发现**: 市场发现器自动发现新安装的插件

### 插件卸载流程

1. **用户触发卸载**: 点击卸载按钮
2. **调用移除**: 调用 `IAgentPlugin.remove()` 方法
3. **从市场移除**: 调用 `IPluginMarketplaceService.removeInstalledPlugin()`
4. **删除文件**: 删除插件安装目录
5. **刷新发现**: 发现器自动更新插件列表

### 插件启用/禁用

插件启用状态由 `EnablementModel` 管理：

```typescript
// 启用插件
this.enablementModel.setEnabled(pluginUri.toString(), true);

// 禁用插件
this.enablementModel.setEnabled(pluginUri.toString(), false);
```

启用状态存储在 `IStorageService` 中，持久化到本地存储。

---

## 扩展机制

### 如何扩展插件系统

#### 1. 添加新的发现器

要添加新的插件发现源，需要：

1. 创建发现器类，继承 `AbstractAgentPluginDiscovery`
2. 实现 `_discoverPluginSources()` 方法
3. 注册发现器到 `agentPluginDiscoveryRegistry`

```typescript
// 示例: 创建自定义发现器
class CustomAgentPluginDiscovery extends AbstractAgentPluginDiscovery {
    protected override async _discoverPluginSources(): Promise<readonly IPluginSource[]> {
        // 实现自定义发现逻辑
        return [];
    }

    public start(enablementModel: IEnablementModel): void {
        this._enablementModel = enablementModel;
        this._register(this._fileService.onDidFilesChange(() => this._refreshPlugins()));
        this._refreshPlugins();
    }
}

// 注册发现器
agentPluginDiscoveryRegistry.register(new SyncDescriptor(CustomAgentPluginDiscovery));
```

#### 2. 支持新的插件格式

要支持新的插件格式，需要：

1. 在 `PluginFormat` 枚举中添加新格式
2. 创建格式配置对象 (`IPluginFormatConfig`)
3. 在 `detectPluginFormat()` 中添加格式检测逻辑
4. 实现格式特定的解析逻辑

```typescript
// 示例: 添加新格式
export const enum PluginFormat {
    Copilot,
    Claude,
    OpenPlugin,
    CustomFormat,  // 新格式
}

const CUSTOM_FORMAT: IPluginFormatConfig = {
    format: PluginFormat.CustomFormat,
    manifestPath: 'custom-plugin.json',
    hookConfigPath: 'hooks/custom-hooks.json',
    pluginRootToken: '${CUSTOM_PLUGIN_ROOT}',
    pluginRootEnvVar: 'CUSTOM_PLUGIN_ROOT',
    parseHooks(hookUri, json, pluginUri, workspaceRoot, userHome) {
        // 实现自定义钩子解析逻辑
        return [];
    },
};

export async function detectPluginFormat(pluginUri: URI, fileService: IFileService): Promise<IPluginFormatConfig> {
    // 检查新格式
    if (await pathExists(joinPath(pluginUri, 'custom-plugin.json'), fileService)) {
        return CUSTOM_FORMAT;
    }

    // ... 其他格式检查
}
```

#### 3. 扩展插件资源类型

要支持新的插件资源类型，需要：

1. 在 `IAgentPlugin` 接口中添加新的 Observable 属性
2. 在 `_toPlugin()` 方法中实现资源发现逻辑
3. 在插件解析器中实现资源解析逻辑

```typescript
// 示例: 添加新资源类型
export interface IAgentPlugin {
    // ... 现有属性

    /** 新资源类型 */
    readonly customResources: IObservable<readonly ICustomResource[]>;
}

// 在 _toPlugin() 中添加
const customResources = observeComponent(
    'customResources',
    d => this._readCustomResources(d),
);

return {
    // ... 现有属性
    customResources,
};
```

---

## 总结

Saros Agents Client 的插件系统是一个高度模块化、可扩展的架构：

### 核心设计原则
1. **策略模式**: 使用发现器策略支持多种插件来源
2. **观察者模式**: 基于 Observable 实现动态更新
3. **依赖注入**: 使用 VSCode 的依赖注入框架
4. **可扩展性**: 易于添加新的发现器和格式支持

### 关键技术
- **Observable**: 实现响应式和动态更新
- **文件系统监听**: 实时监听插件目录变化
- **格式检测**: 自动检测插件格式
- **去重排序**: 确保插件列表的唯一性和有序性

### 扩展点
1. **发现器**: 添加新的插件发现源
2. **格式**: 支持新的插件格式
3. **资源类型**: 支持新的插件资源类型
4. **UI**: 自定义插件视图和交互

---

## 附录

### A. 相关文件清单

| 文件路径 | 说明 |
|---------|------|
| `src/vs/platform/agentPlugins/common/pluginParsers.ts` | 插件解析器 |
| `src/vs/workbench/contrib/chat/common/plugins/agentPluginService.ts` | 插件服务接口 |
| `src/vs/workbench/contrib/chat/common/plugins/agentPluginServiceImpl.ts` | 插件服务实现 |
| `src/vs/workbench/contrib/chat/common/plugins/pluginMarketplaceService.ts` | 市场服务 |
| `src/vs/workbench/contrib/chat/common/plugins/pluginInstallService.ts` | 安装服务 |
| `src/vs/workbench/contrib/chat/browser/agentPluginsView.ts` | 插件视图 |
| `src/vs/workbench/contrib/chat/browser/agentPluginEditor/agentPluginEditor.ts` | 插件编辑器 |
| `src/vs/sessions/contrib/agentStudio/browser/views/pluginsView.ts` | Agent Studio 插件视图 |

### B. 关键接口清单

| 接口 | 说明 |
|------|------|
| `IAgentPlugin` | 插件接口 |
| `IAgentPluginService` | 插件服务接口 |
| `IAgentPluginDiscovery` | 插件发现器接口 |
| `IPluginMarketplaceService` | 插件市场服务接口 |
| `IPluginInstallService` | 插件安装服务接口 |
| `IParsedHookCommand` | 解析后的钩子命令 |
| `IMcpServerDefinition` | MCP 服务器定义 |

### C. 插件格式对比

| 特性 | Copilot | Claude | OpenPlugin |
|------|---------|--------|------------|
| 清单文件 | `plugin.json` | `.claude-plugin/plugin.json` | `._plugin/plugin.json` |
| 钩子配置 | `hooks.json` | `hooks/hooks.json` | `hooks/hooks.json` |
| 插件根令牌 | 无 | `${CLAUDE_PLUGIN_ROOT}` | `${PLUGIN_ROOT}` |
| 环境变量 | 无 | `CLAUDE_PLUGIN_ROOT` | `PLUGIN_ROOT` |

---

**文档版本**: 1.0
**生成时间**: 2026-05-12
**作者**: AI Assistant
