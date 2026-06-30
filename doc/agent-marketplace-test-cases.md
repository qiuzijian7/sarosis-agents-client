# Agent 商城测试用例

> 覆盖 agent 上传、下载、更新、依赖检查（skill/mcp 不存在时的处理）全流程。

## 数据结构背景

### Agent 包结构（tar.gz）
```
package.tar.gz
├── manifest.json    # PackageManifest（包清单）
├── agent.json       # AgentExportData（agent 元数据 + 配置 + 引导文件）
└── AGENTS.md        # agent 操作指南（可选）
```

### manifest.json（PackageManifest）
```json
{
  "kind": "agent",
  "id": "coder",
  "name": "Coder",
  "version": "1.0.0",
  "description": "...",
  "category": "Development",
  "author": "saros",
  "files": ["agent.json", "AGENTS.md"],
  "skillRefs": ["code-review-skill"],
  "mcpRefs": ["filesystem-mcp"]
}
```

**新增字段**（向后兼容，可选）：
- `skillRefs: string[]` — 引用商城中 skill 包的 slug 列表
- `mcpRefs: string[]` — 引用商城中 mcp 包的 slug 列表

### agent.json（AgentExportData）
```json
{
  "version": 1,
  "exportedAt": "2026-06-30T00:00:00Z",
  "agent": {
    "id": "coder", "name": "Coder", "role": "Software Engineer",
    "model": "claude-sonnet-4-20250514", "skills": ["code-gen", "code-review"],
    "tools": ["write_to_file", "read_file"], "category": "Development",
    "systemPrompt": "...", "source": "custom"
  },
  "agentConfig": {},
  "files": { "agentsMd": "..." }
}
```

---

## 测试用例

### TC-01: 上传 Agent（正常流程）

**前置条件**：
- 客户端已登录商城
- 本地存在至少 1 个自定义 agent

**步骤**：
1. 打开 Agent 商城 editor view
2. 点击"⬆ 上传"按钮
3. 在对话框中选择本地 agent，输入版本号 `1.0.0` 和更新说明
4. 点击"发布"

**预期结果**：
- ✅ manifest.json 正确生成（kind=agent, id=slug, files=["agent.json"]）
- ✅ agent.json 正确生成（包含 agent 元数据 + skills + tools）
- ✅ tar.gz 打包成功
- ✅ API 上传成功，商城中可搜索到该 agent
- ✅ 上传后 agent 列表自动刷新

---

### TC-02: 下载/安装 Agent（正常流程）

**前置条件**：
- 商城中存在 agent 包（如 `coder`）
- 客户端未安装该 agent

**步骤**：
1. 打开 Agent 商城 editor view
2. 在卡片列表中找到 `coder` agent
3. 点击"⬇ 安装"按钮

**预期结果**：
- ✅ 按钮变为"⏳ 安装中"
- ✅ 下载 tar.gz 成功
- ✅ 解压并解析 agent.json
- ✅ `agentStudioService.createAgent()` 调用成功
- ✅ 按钮变为"✕ 删除"（已安装状态）
- ✅ `installed-packages.json` 中新增记录
- ✅ 通知"✅ Coder v1.0.0 安装成功"

---

### TC-03: 更新 Agent（版本升级）

**前置条件**：
- 客户端已安装 `coder` v1.0.0
- 商城中 `coder` 已更新到 v1.1.0

**步骤**：
1. 打开 Agent 商城 editor view
2. 等待升级检查完成（自动调用 `checkUpgrades`）
3. `coder` 卡片显示"⬆ 升级 v1.1.0"按钮
4. 点击升级按钮

**预期结果**：
- ✅ 按钮变为"⏳ 升级中"
- ✅ 下载 v1.1.0 成功
- ✅ agent 更新到 v1.1.0
- ✅ 按钮恢复为"✕ 删除"（已安装状态）
- ✅ 升级提示消失
- ✅ 通知"✅ Coder 已升级到 v1.1.0"

---

### TC-04: 安装 Agent 时关联的 Skill 不存在

**场景描述**：
Agent `coder` 的 manifest 中 `skillRefs: ["code-review-skill"]`，但客户端未安装 `code-review-skill`。

**前置条件**：
- 商城中存在 `coder` agent 和 `code-review-skill` skill
- 客户端未安装 `code-review-skill`

**步骤**：
1. 打开 Agent 商城，点击 `coder` 的"⬇ 安装"
2. 安装完成后，检查依赖

**预期结果**：
- ✅ Agent 安装成功
- ⚠️ 通知提示："⚠️ Coder 安装成功，但缺少以下 Skill 依赖：code-review-skill。点击安装依赖。"
- ✅ 卡片下方显示"⚠ 缺少 1 个 Skill 依赖"标签
- ✅ 点击标签可跳转到 Skill 商城安装缺失的 skill
- ✅ Skill 安装后，agent 卡片的依赖警告消失

**处理逻辑**：
```
安装 agent 后：
1. 读取 manifest 中的 skillRefs
2. 检查本地 ISkillRegistry 是否有匹配的 skill
3. 未匹配的 skill 加入 missingSkills 列表
4. 如果 missingSkills 非空，显示警告通知 + 卡片标签
```

---

### TC-05: 安装 Agent 时关联的 MCP 不存在

**场景描述**：
Agent `coder` 的 manifest 中 `mcpRefs: ["filesystem-mcp"]`，但客户端未安装 `filesystem-mcp`。

**前置条件**：
- 商城中存在 `coder` agent 和 `filesystem-mcp` MCP
- 客户端未安装 `filesystem-mcp`

**步骤**：
1. 打开 Agent 商城，点击 `coder` 的"⬇ 安装"
2. 安装完成后，检查依赖

**预期结果**：
- ✅ Agent 安装成功
- ⚠️ 通知提示："⚠️ Coder 安装成功，但缺少以下 MCP 依赖：filesystem-mcp。点击安装依赖。"
- ✅ 卡片下方显示"⚠ 缺少 1 个 MCP 依赖"标签
- ✅ 点击标签可跳转到 MCP 商城安装缺失的 MCP
- ✅ MCP 安装后，agent 卡片的依赖警告消失

**处理逻辑**：
```
安装 agent 后：
1. 读取 manifest 中的 mcpRefs
2. 检查本地 MCP 配置（~/.saros/mcp.json）是否有匹配的 MCP
3. 未匹配的 MCP 加入 missingMcp 列表
4. 如果 missingMcp 非空，显示警告通知 + 卡片标签
```

---

### TC-06: 上传 Agent 时关联的 Skill/MCP 不存在于商城

**场景描述**：
本地 agent 的 skills 中引用了 `custom-skill`，但商城中不存在该 skill 包。

**前置条件**：
- 客户端有一个本地 agent，其 manifest 中 `skillRefs: ["custom-skill"]`
- 商城中不存在 `custom-skill` skill 包

**步骤**：
1. 打开 Agent 商城，点击"⬆ 上传"
2. 选择该 agent，点击"发布"
3. 系统检查商城中是否存在 `custom-skill`

**预期结果（方案 A：警告但允许上传）**：
- ⚠️ 弹出确认对话框："以下依赖在商城中不存在：custom-skill。仍然上传？"
- ✅ 用户点击"仍然上传"后，agent 上传成功
- ✅ 上传的 agent manifest 中保留 `skillRefs: ["custom-skill"]`
- ✅ 其他用户安装该 agent 时会收到依赖缺失警告

**预期结果（方案 B：阻止上传）**：
- ❌ 弹出错误对话框："以下依赖在商城中不存在：custom-skill。请先上传依赖包。"
- ❌ 上传被阻止

**推荐方案 A**：允许上传但警告，因为 skill 可能通过其他方式安装（非商城）。

---

### TC-07: Agent 安装后依赖被卸载

**场景描述**：
Agent `coder` 已安装且关联了 `code-review-skill`，用户卸载了该 skill。

**步骤**：
1. 确保 `coder` agent 和 `code-review-skill` 都已安装
2. 打开 Skill 商城，卸载 `code-review-skill`
3. 回到 Agent 商城，查看 `coder` 卡片

**预期结果**：
- ✅ `coder` 卡片显示"⚠ 缺少 1 个 Skill 依赖"标签
- ✅ 标签可点击跳转到 Skill 商城重新安装

---

### TC-08: 批量安装 BUILTIN_PRESETS

**场景描述**：
通过种子脚本将 13 个 BUILTIN_PRESETS 上传到商城后，客户端批量安装。

**步骤**：
1. 运行种子脚本 `seed-agent-presets.mjs`
2. 打开 Agent 商城，确认 13 个预设全部显示
3. 逐个安装每个预设

**预期结果**：
- ✅ 13 个预设全部在商城中可见
- ✅ 每个预设安装后显示"已安装"状态
- ✅ 搜索和分类过滤正常工作

---

### TC-09: 卸载 Agent

**步骤**：
1. 在 Agent 商城中，点击已安装 agent 的"✕ 删除"按钮
2. 确认卸载

**预期结果**：
- ✅ 确认对话框弹出
- ✅ 确认后，本地 agent 目录被删除
- ✅ `installed-packages.json` 中记录被移除
- ✅ 卡片恢复为"⬇ 安装"状态
- ✅ 通知"✅ {name} 已卸载"

---

### TC-10: 自定义 Agent 创建

**步骤**：
1. 打开 Agent 商城，点击"✏ 自定义"
2. 输入名称、角色、描述、系统提示词
3. 点击"创建"

**预期结果**：
- ✅ `agentStudioService.createAgent()` 调用成功
- ✅ 本地 agent 列表刷新
- ✅ 通知"✅ Agent '{name}' 创建成功"
- ✅ 新 agent 可在"⬆ 上传"对话框中选择

---

## 依赖检查实现方案

### 1. Manifest 扩展

在 `PackageManifest` 中新增可选字段：
```typescript
interface PackageManifest {
  // ... 现有字段 ...
  /** Agent 依赖的 skill 包 slug 列表（仅 kind=agent 时有效） */
  skillRefs?: readonly string[];
  /** Agent 依赖的 mcp 包 slug 列表（仅 kind=agent 时有效） */
  mcpRefs?: readonly string[];
}
```

### 2. 安装时依赖检查（AgentInstaller.install）

```
安装 agent 后：
1. 从 manifest 中读取 skillRefs 和 mcpRefs
2. 检查本地 ISkillRegistry.getSkills() 是否包含每个 skillRef
3. 检查本地 MCP 配置是否包含每个 mcpRef
4. 返回 missingSkills 和 missingMcp 列表
5. AgentMarketEditorPane 根据缺失列表显示警告
```

### 3. 上传时依赖检查（AgentMarketEditorPane._showUploadDialog）

```
上传 agent 前：
1. 从 agent 的 skills 中提取可能的 skill 包引用
2. 调用 marketplaceService.listPackages({ kind: 'skill' }) 获取商城中所有 skill
3. 检查 agent 引用的 skill 是否在商城中存在
4. 如果不存在，弹出警告对话框（允许继续上传）
```

### 4. 卡片依赖状态显示

在 agent 卡片中增加依赖状态标签：
- ✅ 依赖完整：不显示标签
- ⚠️ 缺少依赖：显示"⚠ 缺少 N 个依赖"标签，可点击查看详情
