# Knot 插件分析结果：标准插件 vs VSCode 扩展

## 分析日期
2026-05-12（初始分析）
2026-05-12（方案 A 实施完成）

---

## 核心结论

**Knot 插件已通过方案 A 改造，现在同时满足标准插件系统和 VSCode 扩展机制的要求。**

### 改造状态：✅ 已完成

通过在扩展中嵌入标准插件目录 + 声明 `chatPlugins` 扩展点，Knot 现在可以：
- 被 `ExtensionAgentPluginDiscovery` 自动发现
- 出现在插件页面，支持启用/禁用操作
- 同时保留 `IAgentCapabilityPlugin` 的 Model Provider 能力

---

## 两种扩展方式对比

### 方式一：标准插件（Standard Plugin）

#### 特征
- **格式要求**: 必须遵循三种格式之一
  - Copilot 格式: `plugin.json`
  - Claude 格式: `.claude-plugin/plugin.json`
  - OpenPlugin 格式: `.plugin/plugin.json`
- **发现机制**: 通过 `AgentPluginDiscovery` 自动发现
- **注册方式**: 放置在特定目录，系统自动扫描
- **能力范围**: 
  - Hooks (生命周期钩子)
  - Commands (自定义命令)
  - Skills (技能)
  - Agents (代理)
  - Instructions (指令/规则)
  - MCP Server Definitions (MCP 服务器定义)

#### 优点
- ✅ 轻量级，无需编译
- ✅ 自动发现，无需手动注册
- ✅ 用户可以在插件页面管理（启用/禁用/卸载）
- ✅ 支持动态加载和热重载

#### 缺点
- ❌ 功能受限，只能提供声明式资源
- ❌ 无法使用 VSCode API
- ❌ 不适合复杂逻辑

#### 示例结构
```
my-plugin/
├── plugin.json           # 插件清单
├── hooks.json           # 钩子配置
├── commands/            # 命令目录
│   └── my-command.md
├── skills/              # 技能目录
│   └── my-skill.md
├── agents/              # 代理目录
│   └── my-agent.md
└── instructions/        # 指令目录
    └── my-instructions.instructions.md
```

---

### 方式二：VSCode 扩展（VSCode Extension）

#### 特征
- **格式要求**: 必须遵循 VSCode 扩展格式
  - `package.json` (扩展清单)
  - `src/extension.ts` (扩展入口)
  - 需要编译 TypeScript
- **发现机制**: 通过 VSCode 扩展系统发现
- **注册方式**: 
  - 在 `package.json` 中声明 `contributes.agentCapabilities`
  - 实现 `IAgentCapabilityPlugin` 接口
  - 在 `activate()` 中注册 Provider
- **能力范围**: 通过 `AgentCapability` 枚举定义
  - Model (模型提供者)
  - Memory (记忆提供者)
  - Tool (工具提供者)
  - Planning (规划提供者)
  - Execution (执行提供者)
  - Retrieval (检索提供者)
  - Kanban (看板提供者)

#### 优点
- ✅ 可以使用完整的 VSCode API
- ✅ 适合复杂逻辑和深度集成
- ✅ 可以使用第三方 Node.js 库
- ✅ 支持编译时类型检查

#### 缺点
- ❌ 需要编译，开发流程更复杂
- ❌ 不会被标准插件系统发现
- ❌ 无法在插件页面管理（需要在扩展页面管理）

#### 示例结构
```
my-extension/
├── package.json         # VSCode 扩展清单
├── tsconfig.json       # TypeScript 配置
├── src/
│   ├── extension.ts    # 扩展入口
│   └── myProvider.ts  # Provider 实现
└── dist/              # 编译输出
    └── extension.js
```

---

## Knot 插件现状分析

### 当前实现方式

Knot 插件是一个 **VSCode 扩展**，位于 `extensions/knot-agui/` 目录。

#### 文件结构
```
extensions/knot-agui/
├── package.json           # VSCode 扩展清单
├── src/
│   ├── extension.ts     # 扩展入口，实现 IAgentCapabilityPlugin
│   └── knotModelProvider.ts  # Model Provider 实现
└── README.md
```

#### 关键代码分析

**1. package.json 声明**
```json
{
  "name": "sarosis-knot-agui",
  "displayName": "Knot AG-UI Model Provider",
  "contributes": {
    "agentCapabilities": [
      {
        "capability": "model",
        "provider": "knot-agui",
        "priority": 100
      }
    ]
  }
}
```

**2. extension.ts 实现**
```typescript
export class KnotAguiPlugin implements IAgentCapabilityPlugin {
    readonly id = 'knot-agui';
    readonly name = 'Knot AG-UI Model Provider';
    readonly version = '1.0.0';
    readonly capabilities = [AgentCapability.Model];

    async activate(context: IAgentOSPluginContext): Promise<void> {
        const provider = new KnotAGUIModelProvider({...});
        this._disposables.push(os.registerModelProvider(provider));
    }

    async deactivate(): Promise<void> {
        for (const d of this._disposables) {
            d.dispose();
        }
    }
}
```

### 是否满足要求？

#### ❌ 不满足标准插件系统的要求

1. **没有标准插件格式文件**
   - 缺少 `plugin.json`
   - 缺少 `.claude-plugin/plugin.json`
   - 缺少 `.plugin/plugin.json`

2. **不会被 AgentPluginDiscovery 发现**
   - `ConfiguredAgentPluginDiscovery` 不会扫描扩展目录
   - `ExtensionAgentPluginDiscovery` 可能不会将其转换为 `IAgentPlugin`

3. **无法在插件页面管理**
   - 用户无法在 "Plugins" 视图中看到 Knot
   - 用户无法在插件页面启用/禁用/卸载 Knot

#### ✅ 满足 VSCode 扩展机制的要求

1. **正确实现 IAgentCapabilityPlugin 接口**
   - ✅ 实现了 `activate()` 方法
   - ✅ 实现了 `deactivate()` 方法
   - ✅ 声明了提供的 `capabilities`

2. **正确注册 Model Provider**
   - ✅ 创建 `KnotAGUIModelProvider` 实例
   - ✅ 调用 `os.registerModelProvider(provider)` 注册
   - ✅ 支持配置热重载

3. **正确声明 package.json**
   - ✅ 声明了 `contributes.agentCapabilities`
   - ✅ 提供了配置项定义
   - ✅ 提供了设置页面选项卡

---

## 问题诊断

### 如果您期望 Knot 出现在插件页面

**问题**: Knot 不会出现插件列表中。

**原因**: 
- 插件页面只显示通过 `IAgentPluginService` 发现的插件
- Knot 是 VSCode 扩展，不是标准插件
- `ExtensionAgentPluginDiscovery` 可能不会将扩展转换为 `IAgentPlugin`

**解决方案**:
1. **方案 A**: 将 Knot 改造成标准插件（不推荐，因为需要实现复杂逻辑）
2. **方案 B**: 在 Knot 扩展中嵌入标准插件目录，让 `ExtensionAgentPluginDiscovery` 能发现它
3. **方案 C**: 修改 `ExtensionAgentPluginDiscovery`，让它为声明了 `agentCapabilities` 的扩展创建虚拟 `IAgentPlugin` 对象

### 如果您只是验证 Knot 作为扩展是否正确

**结论**: Knot 实现正确，符合 VSCode 扩展开发规范。

**验证清单**:
- ✅ 实现 `IAgentCapabilityPlugin` 接口
- ✅ 在 `package.json` 中声明 `contributes.agentCapabilities`
- ✅ 在 `activate()` 中注册 Provider
- ✅ 在 `deactivate()` 中清理资源
- ✅ 支持配置热重载
- ✅ 提供完整的设置页面配置项

---

## 建议

### 建议一：如果希望 Knot 被插件系统管理

**目标**: 让 Knot 出现在插件页面，用户可以启用/禁用/卸载

**实施步骤**:

1. 在 `extensions/knot-agui/` 中创建标准插件目录：
   ```
   extensions/knot-agui/
   ├── plugin/                    # 新增标准插件目录
   │   ├── .plugin/
   │   │   └── plugin.json      # OpenPlugin 格式
   │   └── hooks/               # 可选：添加钩子
   │       └── hooks.json
   ├── package.json
   └── src/
   ```

2. 修改 `ExtensionAgentPluginDiscovery`，让它扫描扩展目录中的标准插件

3. 或者，修改 `ExtensionAgentPluginDiscovery`，为声明了 `agentCapabilities` 的扩展创建虚拟 `IAgentPlugin` 对象

### 建议二：如果 Knot 作为扩展已经满足需求

**目标**: 保持现状，Knot 作为扩展正常工作

**实施步骤**:

1. 在文档中明确说明：Knot 是扩展，不是标准插件
2. 提供扩展管理文档，告诉用户如何在扩展页面管理 Knot
3. 考虑在插件页面添加"扩展"选项卡，显示已安装的 Agent 相关扩展

---

## 技术细节

### IAgentCapabilityPlugin 接口

```typescript
export interface IAgentCapabilityPlugin {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly capabilities: AgentCapability[];
    
    activate(context: IAgentOSPluginContext): Promise<void>;
    deactivate(): Promise<void>;
}
```

### AgentCapability 枚举

```typescript
export const enum AgentCapability {
    Model = 'model',          // 模型提供者
    Memory = 'memory',        // 记忆提供者
    Tool = 'tool',            // 工具提供者
    Planning = 'planning',    // 规划提供者
    Execution = 'execution',  // 执行提供者
    Retrieval = 'retrieval',  // 检索提供者
    Kanban = 'kanban',        // 看板提供者
}
```

### IModelProvider 接口（Knot 实现的接口）

```typescript
export interface IModelProvider {
    readonly id: string;
    readonly name: string;
    readonly priority: number;
    readonly supportsAgents: boolean;
    
    getAuthStatus(): ModelAuthStatus;
    listModels(): Promise<IModelInfo[]>;
    listAgents(): Promise<IModelAgentInfo[]>;
    chat(modelId: string, messages: IChatMessage[], options: IModelOptions): AsyncIterable<IModelDelta>;
    reloadConfiguration(): Promise<void>;
}
```

---

## 总结

| 维度 | 改造前 | 改造后 |
|------|--------|--------|
| 标准插件格式 | ❌ 不是标准插件 | ✅ 嵌入标准插件目录 |
| 被插件系统发现 | ❌ 不会被发现 | ✅ 通过 chatPlugins 发现 |
| 在插件页面显示 | ❌ 不会显示 | ✅ 显示并支持启用/禁用 |
| 实现 IAgentCapabilityPlugin | ✅ 正确实现 | ✅ 保持不变 |
| 注册 Model Provider | ✅ 正确注册 | ✅ 保持不变 |
| 作为扩展工作 | ✅ 正常工作 | ✅ 保持不变 |

---

## 方案 A 实施记录

### 实施日期
2026-05-12

### 改造方案
采用**方案 A（混合模式）**：在 VSCode 扩展内嵌入标准插件目录，通过 `chatPlugins` 扩展点声明，让 `ExtensionAgentPluginDiscovery` 自动发现。

### 改造内容

#### 1. 新增标准插件目录

```
extensions/knot-agui/
├── plugin/                          # 新增：标准插件目录
│   ├── plugin.json                  # Copilot 格式清单
│   ├── .mcp.json                    # MCP 服务器定义（SSE 连接 Knot）
│   ├── agents/
│   │   └── knot-agent.md            # 代理描述
│   ├── commands/
│   │   └── knot-chat.md             # 命令描述
│   ├── skills/
│   │   └── knot-agui/
│   │       └── SKILL.md             # 技能描述
│   └── instructions/
│       └── knot-rules.instructions.md  # 指令/规则
├── package.json                     # 修改：添加 chatPlugins 声明
└── src/
    └── extension.ts                 # 修改：更新注释和配置监听
```

#### 2. package.json 变更

在 `contributes` 中新增 `chatPlugins` 声明：

```json
{
  "contributes": {
    "chatPlugins": [
      {
        "path": "./plugin",
        "when": "extensionInstalled == sarosis-knot-agui"
      }
    ],
    "agentCapabilities": [...],
    ...
  }
}
```

**关键点**：
- `path` 指向扩展内的 `./plugin` 目录（相对路径）
- `when` 条件确保仅当扩展已安装时才激活插件
- `ExtensionAgentPluginDiscovery` 会自动读取此声明并发现插件

#### 3. extension.ts 变更

- 添加双重注册架构的注释说明
- 暴露 `_provider` 属性以便管理
- 扩展配置变更监听范围，覆盖 `sessions.agentStudio.knot`

#### 4. 标准插件资源

| 文件 | 类型 | 说明 |
|------|------|------|
| `plugin.json` | 清单 | Copilot 格式，声明插件名称、版本、描述 |
| `.mcp.json` | MCP 定义 | SSE 类型 MCP 服务器，连接 Knot AG-UI 端点 |
| `agents/knot-agent.md` | 代理 | 描述 Knot Agent 的能力和使用方法 |
| `commands/knot-chat.md` | 命令 | 描述聊天命令的参数和用法 |
| `skills/knot-agui/SKILL.md` | 技能 | 描述 Knot AG-UI 技能 |
| `instructions/knot-rules.instructions.md` | 指令 | Knot 插件的行为规则 |

### 发现流程

```
1. VSCode 加载扩展 sarosis-knot-agui
    ↓
2. ExtensionAgentPluginDiscovery 读取 chatPlugins 扩展点
    ↓
3. 发现 { path: "./plugin", when: "extensionInstalled == sarosis-knot-agui" }
    ↓
4. 检查 when 条件 → 满足
    ↓
5. 解析 pluginUri = <extensionRoot>/plugin/
    ↓
6. detectPluginFormat() → 检测到 plugin.json → Copilot 格式
    ↓
7. 读取插件资源：
   - commands/ → knot-chat.md
   - skills/   → knot-agui/SKILL.md
   - agents/   → knot-agent.md
   - rules/    → knot-rules.instructions.md
   - mcpServers → .mcp.json
    ↓
8. 创建 IAgentPlugin 对象
    ↓
9. 添加到 plugins Observable
    ↓
10. 插件页面显示 Knot AG-UI
```

### 兼容性说明

- **扩展功能不受影响**：`IAgentCapabilityPlugin` + `IModelProvider` 仍然正常工作
- **插件页面可见**：Knot 现在出现在插件列表中
- **启用/禁用**：通过插件页面的启用/禁用操作会通过 `EnablementModel` 传播
- **卸载**：插件页面的卸载操作会提示卸载整个扩展
- **格式检测**：使用 Copilot 格式（`plugin.json`），因为这是最简格式
