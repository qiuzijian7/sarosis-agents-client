# 四类资源与商城交互的横向对比分析

> 日期：2026-06-23 ｜ 范围：vsSarosis 客户端中 skill / agent / mcp / knowledge 的设计现状与商城交互优化方案

---

## 一、现状横向对比

### 1.1 总览表

| 维度 | Skill | Agent | MCP | Knowledge |
|------|-------|-------|-----|-----------|
| **类型定义** | `ISkillDefinition` (skills.ts:41) | `Agent` (agentStudioTypes.ts:301) | `IMcpServerPreset` (bundledMcpPresets.ts:21) | ❌ 无 |
| **升级字段 version** | ✅ 已有 (skills.ts:67) | ❌ 无 | ❌ 无 | ❌ 无 |
| **溯源字段 storeId** | ✅ 已有 (skills.ts:69) | ❌ 无 | ❌ 无 | ❌ 无 |
| **更新 URL updateUrl** | ✅ 已有 (skills.ts:71) | ❌ 无 | ❌ 无 | ❌ 无 |
| **内容指纹 contentHash** | ✅ 已有 (skills.ts:63) | ❌ 无 | ❌ 无 | ❌ 无 |
| **来源标记 source** | ✅ 5 种 (skills.ts:55) | ✅ 4 种 `AgentSource` (types:203) | ❌ 无 | ❌ 无 |
| **本地存储** | `~/.saros/skills-library/{id}/SKILL.md` | `~/.saros/agents/custom/{id}/` + `custom-agents.json` | 平台 `IMcpService` 安装 + storageService 禁用列表 | ❌ 无 |
| **清单格式** | SKILL.md frontmatter | agent.json + agent.yaml + 引导 md | 声明式 command/args/url (无清单文件) | ❌ 无 |
| **注册表服务** | `ISkillRegistry` (reload✅) | `IAgentStudioService` (CRUD✅) | `IMcpService` (平台) | ❌ 无 |
| **安装服务** | ✅ `SkillInstallService` | ❌ 仅有导出格式 `AgentExportData` | ❌ 无独立服务 | ❌ 无 |
| **卸载** | ✅ `uninstallSkill` | ✅ `deleteAgent` | ✅ 平台移除 | ❌ 无 |
| **现有市场/hub** | ✅ `ISkillHubDefinition` 5 种源 + `BUILTIN_SKILL_HUBS` | ⚠️ `IAgentGalleryService` 仅本地模板 | ⚠️ `knotMcpMarket`(211条) + `BUNDLED_MCP_PRESETS`(16条) 分散 | ❌ 无 |
| **远程下载** | ✅ hub→SKILL.md 文本 | ❌ | ⚠️ 仅展示数据，无下载安装 | ❌ 无 |
| **版本升级检查** | ❌ 字段有但逻辑未实现 | ❌ | ❌ | ❌ |
| **商城交互适配度** | ★★★★★ | ★★☆☆☆ | ★☆☆☆☆ | ☆☆☆☆☆ |

### 1.2 各类详细分析

#### Skill — 最完备（★★★★★）

**优势**：
- 升级相关字段（version/storeId/updateUrl/contentHash/source）已全部预留
- 已有完整的 Hub 框架：`ISkillHubDefinition` 支持 5 种源类型（github/git/url/local/knot-bundle），内置 5 个 Hub
- 已有 `SkillInstallService`：installFromHub / installFromContent / installFromFile / uninstallSkill
- 安装后自动 `skillRegistry.reload()` 刷新
- SKILL.md frontmatter 天然支持扩展字段（storeId/version 写回）

**缺口**：
- `storeId/updateUrl/version` 字段虽定义但**无检查更新逻辑**（未实现轮询/比对）
- Hub 列表无 "marketplace" 类型（商城不是一种 Hub）
- 安装时不回写 storeId/version 到 frontmatter（失去升级溯源）
- 无 `installed-packages.json` 统一清单

#### Agent — 有基础缺服务（★★☆☆☆）

**优势**：
- `AgentExportData`（types:253）已是完整可移植格式（agent 定义 + agent.yaml + 5 个引导文件）
- `IAgentStudioService` 有完整 CRUD（createAgent 可用于导入）
- `AgentSource` 枚举含 `Imported`（为外部导入预留）

**缺口**：
- **无 version/storeId/contentHash 字段** — Agent 接口完全没有升级相关字段
- **无安装服务** — 有导出格式但无 import/install service（createAgent 是手动创建，非从包导入）
- `IAgentGalleryService` 仅本地 `AgentTemplate`，无远程源
- agent.yaml 无 version 字段（IAgentYaml types 中无 version）
- 无导出/导入 UI 流程

#### MCP — 数据分散无安装（★☆☆☆☆）

**优势**：
- 有两个市场数据源：`knotMcpMarket`（211 条 remote MCP）+ `BUNDLED_MCP_PRESETS`（16 条本地预设）
- `IMcpServerPreset` 定义了 command/args/url/envKeys 配置结构
- 通过平台 `IMcpService` 安装（integrationView.ts:1284 "Servers are now INSTALLED"）

**缺口**：
- **无 version/storeId/source 字段** — MCP 配置是声明式的，无版本概念
- **两个市场数据源不统一** — knotMcpMarket 和 BUNDLED_MCP_PRESETS 各自独立，无统一接口
- **无下载安装服务** — 市场数据仅展示，用户需手动复制配置
- 配置依赖平台 `IMcpService`（非文件存储），商城下载的 config.json 需转调 IMcpService 安装
- MCP 是「配置」而非「文件包」，tar.gz 打包意义不大（主要是 config.json + README）

#### Knowledge — 完全缺失（☆☆☆☆☆）

**缺口**：
- 无类型定义、无注册表、无存储、无安装、无市场
- 需从零设计：类型接口、存储目录、注册表、RAG 检索
- 商城交互需全新构建

---

## 二、差距分析：与商城交互的核心问题

### 问题 1：四类资源无统一的「包」抽象

商城服务端已统一为 `PackageManifest`（kind + id + version + files），但客户端四类资源各自为政：
- Skill 用 SKILL.md frontmatter
- Agent 用 AgentExportData JSON
- MCP 用 IMcpServerPreset 配置
- Knowledge 无

**导致**：`MarketplaceService.download()` 需按 kind 写 4 套安装逻辑，`publish()` 需 4 套打包逻辑，无法复用。

### 问题 2：升级溯源字段只有 Skill 有

只有 `ISkillDefinition` 预留了 version/storeId/updateUrl/contentHash。Agent/MCP/Knowledge 完全没有升级字段，导致：
- 下载安装后无法记录「这个资源来自商城哪个 storeId、哪个版本」
- 升级检查时无法批量比对（只有 skill 能提供 current version）

### 问题 3：安装服务只有 Skill 有

只有 `SkillInstallService` 实现了从外部源下载→落地→reload 的完整流程。Agent/MCP/Knowledge 无安装服务，`MarketplaceService.download()` 对这三类只能「解压到目录」但无法「注册到对应 registry」。

### 问题 4：MCP 的平台依赖

MCP 通过 vscode 平台 `IMcpService` 安装（非文件系统），商城下载的 MCP config.json 不能直接写文件，必须转调 `IMcpService` 的安装 API。这与其他三类（文件系统存储）机制不同。

### 问题 5：无统一已安装清单

没有 `installed-packages.json` 统一记录所有已安装资源（跨 kind）的 storeId/version。升级检查需遍历 4 个 registry 分别获取，且 Agent/MCP/Knowledge 根本拿不到 version。

---

## 三、优化方案

### 3.1 方案 A：统一包抽象 + 各类适配器（推荐）

引入统一的 `IPackageInstaller` 适配器模式，每类资源实现自己的安装/打包/注册逻辑，`MarketplaceService` 通过适配器统一调度。

```
IMarketplaceService
   └── download(storeId, version, kind)
          └── packageInstallerRegistry.get(kind).install(manifest, files)
                 ├── SkillInstaller    → 写 SKILL.md + ISkillRegistry.reload()
                 ├── AgentInstaller    → 写 agent.json/yaml + IAgentStudioService.createAgent()
                 ├── McpInstaller      → 转调 IMcpService.install(config)
                 └── KnowledgeInstaller→ 写 docs/ + 注册 IKnowledgeRegistry (新建)
```

**核心改动**：

1. **新增 `IPackageInstaller` 接口**（common/packageInstaller.ts）：
   ```ts
   export interface IPackageInstaller {
     readonly kind: PackageKind;
     install(manifest: PackageManifest, extractedDir: URI): Promise<IInstallResult>;
     pack(localId: string): Promise<{ buffer: VSBuffer; manifest: PackageManifest }>;
     getInstalledVersion(storeId: string): string | undefined;  // 供升级检查
   }
   ```

2. **新增 `IPackageInstallerRegistry`**：按 kind 注册 4 个 installer，`MarketplaceService` 查表调用。

3. **补齐 Agent 的升级字段**：在 `Agent` 接口加 `version?` / `storeId?`（可选，向后兼容），在 agent.yaml 加 `version`。

4. **新增 `IKnowledgeRegistry`**：从零设计知识库注册表（存储/检索/reload）。

5. **统一已安装清单** `~/.saros/installed-packages.json`：由各 installer 在 install 后写入，`MarketplaceService.checkUpgrades()` 统一读取。

### 3.2 方案 B：复用 Skill Hub 框架扩展（轻量）

不引入新抽象，而是把商城作为一种新的 Hub 类型嵌入现有 Skill Hub 框架，再为 Agent/MCP/Knowledge 各自实现类似 Hub 机制。

**问题**：Skill Hub 框架是 skill 专属（SKILL.md 格式），无法直接套用到 Agent/MCP/Knowledge。需为每类重复实现 hub 逻辑，违反 DRY。

### 3.3 方案 C：商城即唯一源（激进）

废弃现有 knotMcpMarket / BUNDLED_MCP_PRESETS / BUILTIN_SKILL_HUBS，全部迁移到商城服务端。客户端只保留 `MarketplaceService` 一个入口。

**问题**：破坏现有功能（GitHub skill hub 等社区源仍有价值），迁移成本高，且离线场景无法使用。

**推荐方案 A**：统一包抽象 + 适配器，既复用商城统一协议，又保留各类资源的差异化安装逻辑。

---

## 四、推荐架构（方案 A 详细设计）

### 4.1 分层

```
┌─────────────────────────────────────────────────────┐
│ IMarketplaceService (已有)                           │
│  login / listPackages / getPackage / checkUpgrades   │
│  download → 解压 tar.gz 到临时目录                    │
│  publish  ← 打包临时目录为 tar.gz                     │
└───────────────────┬─────────────────────────────────┘
                    │ 委托
┌───────────────────▼─────────────────────────────────┐
│ IPackageInstallerRegistry                            │
│  get(kind) → IPackageInstaller                       │
└──┬──────┬──────┬──────┬─────────────────────────────┘
   │      │      │      │
   ▼      ▼      ▼      ▼
 Skill   Agent   MCP   Knowledge
Installer Installer Installer Installer
   │      │      │      │
   ▼      ▼      ▼      ▼
ISkillRegistry  IAgentStudioService  IMcpService  IKnowledgeRegistry(新)
.reload()       .createAgent()       .install()   .register()
```

### 4.2 各类 Installer 实现要点

| Installer | install() 做什么 | pack() 做什么 | getInstalledVersion() |
|-----------|-----------------|--------------|----------------------|
| **SkillInstaller** | 复用 `SkillInstallService.installFromContent(SKILL.md)` + 回写 storeId/version 到 frontmatter | 读 SKILL.md → manifest + tar | 读 frontmatter.version |
| **AgentInstaller** | 解析 agent.json(AgentExportData) → `IAgentStudioService.createAgent()` + 写引导文件到 agentDir | 复用现有导出逻辑组装 AgentExportData → tar | 读 agent.yaml.version（需新增字段） |
| **McpInstaller** | 读 config.json → 转调 `IMcpService.install({command,args,env})` | 读 IMcpService 配置 → config.json + manifest → tar | MCP 无版本，返回 undefined（不参与升级） |
| **KnowledgeInstaller** | 写 docs/ + index.json 到 ~/.saros/knowledge-base/{id}/ → `IKnowledgeRegistry.register()` | 打包 docs/ + index.json → tar | 读 index.json.version |

### 4.3 升级检查统一化

```ts
// MarketplaceService.checkUpgrades() 改进
async checkUpgrades(): Promise<IUpgradeInfo[]> {
  // 统一从 installed-packages.json 读取，而非遍历各 registry
  const installed = await this.readInstalledManifest();  // ~/.saros/installed-packages.json
  return this.api('POST', '/upgrade/check', { items: installed });
}
```

各 Installer 在 `install()` 后自动写入 `installed-packages.json`：
```json
[
  { "kind": "skill", "storeId": "pdf-skill", "version": "1.0.0", "installedAt": "..." },
  { "kind": "agent", "storeId": "deep-researcher", "version": "1.1.0", "installedAt": "..." }
]
```

### 4.4 改造优先级

| 优先级 | 改造项 | 收益 | 工作量 |
|--------|--------|------|--------|
| P0 | 引入 `IPackageInstaller` + Registry | 统一调度基础 | 小 |
| P0 | SkillInstaller（复用 SkillInstallService） | 验证架构，skill 已最完备 | 小 |
| P1 | AgentInstaller + Agent 加 version/storeId 字段 | agent 可下载安装升级 | 中 |
| P1 | installed-packages.json 统一清单 + checkUpgrades 改进 | 升级检查统一 | 小 |
| P2 | KnowledgeInstaller + IKnowledgeRegistry | 补齐知识库 | 大（从零） |
| P2 | McpInstaller（转调 IMcpService） | mcp 可下载 | 中（平台依赖） |
| P3 | 回写 storeId/version 到各资源清单 | 溯源完整 | 小 |

---

## 五、关键结论

1. **Skill 是标杆**：升级字段最全、有安装服务、有 Hub 框架。商城交互应从 Skill 切入，验证统一架构后再推广。

2. **Agent 差一个安装服务**：有 `AgentExportData` 导出格式但无 import service，补一个 `AgentInstaller` + Agent 加 version 字段即可打通。

3. **MCP 最特殊**：配置是声明式 + 依赖平台 `IMcpService`，不能简单写文件。需 McpInstaller 转调平台 API，且 MCP 无版本概念（不参与升级检查，仅下载安装）。

4. **Knowledge 需从零建**：类型/存储/注册表/安装全缺，工作量最大，建议放 P2。

5. **统一抽象是关键**：引入 `IPackageInstaller` 适配器后，`MarketplaceService` 只需 `registry.get(kind).install()`，四类差异封装在各自 Installer 内，符合开闭原则。

6. **升级检查应基于统一清单**：`installed-packages.json` 而非遍历各 registry，因为 Agent/MCP 拿不到 version。
