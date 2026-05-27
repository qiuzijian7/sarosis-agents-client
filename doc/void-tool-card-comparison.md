# Void vs Sarosis 聊天框工具卡片深度对比分析

> 生成日期：2026-05-27
> 分析范围：工具卡片渲染架构、状态可视化、布局策略、样式体系、交互设计

---

## 一、架构总览对比

### Void 工具卡片架构

```
_ChatBubble (调度器)
  │ role === 'tool' →
  ├── type === 'invalid_params' → <InvalidTool />
  ├── isBuiltInTool → builtinToolNameToComponent[toolName].resultWrapper
  │     ├── ReadFileWrapper
  │     ├── EditFileWrapper
  │     ├── RunCommandWrapper
  │     ├── CreateFileWrapper
  │     ├── DeleteFileWrapper
  │     ├── LsDirWrapper
  │     └── SearchWrapper
  └── MCP → <MCPToolWrapper>
  
  + type === 'tool_request' → <ToolRequestAcceptRejectButtons />
```

**核心特征**：每个内置工具一个**专用 Wrapper 组件**，工具结果直接嵌入消息列表（独立消息），审批按钮独立渲染。

### Sarosis 工具卡片架构

```
ToolCallCardRaw (调度器)
  │ Phantom 过滤 → renderType="None" / PHANTOM_TOOL_NAMES → null
  │ defaultShow === false → null
  │
  ├── renderType 分辨:
  │     ├── 'ListItems'  → <ListItemsRenderer />
  │     ├── 'RunTerminal' → <RunTerminalRenderer />
  │     ├── 'CodeApply'  → <CodeApplyRenderer />
  │     └── (其他/无)    → <GenericToolCallCard />
  │
  └── ToolDisplayRegistry.resolve() → emoji, label, detail, renderType

布局策略:
  ChatMessage → InterleavedMarkdownRenderer
    │ <!--TOOL_CARD:id--> placeholder → 精确定位
    │ 无 placeholder → 关键词匹配 + 均匀分布
    └── 工具卡片交织在 Markdown 文本中
```

**核心特征**：`renderType` 驱动调度 + 配置化 Registry + 交织布局。

---

## 二、工具状态可视化对比

### Void: 6 种工具子状态的渐进渲染

| 子状态 | 标题文本 | 内容区域 | 图标 | 交互 |
|--------|---------|---------|------|------|
| `invalid_params` | "Call {toolName}" | 错误信息 | ❌ | 无 |
| `tool_request` | "Call {toolName}..." | "(Awaiting user permission...)" | ⏳ | **批准/拒绝按钮** |
| `running_now` | "Calling {toolName}..."（蓝色加载态） | 工具参数预览 | 🔄 旋转 | 无 |
| `tool_error` | "Call {toolName}" | 错误结果内容 | ❌ | 无 |
| `success` | "Called {toolName}" | 工具结果内容 | ✅ | 展开/折叠 |
| `rejected` | "Call {toolName}" | "Permission denied by user" | ❌ | 无 |

**关键设计点**：
- `tool_request` 是唯一需要用户交互的状态，渲染 `ToolRequestAcceptRejectButtons`
- `running_now` 的标题用 `loadingTitleWrapper` 包裹，实现蓝色闪烁加载效果
- 即使 `autoApprove=true`，也先添加 `tool_request` 消息再自动继续（UI 加载态）
- 每种状态是**不可变消息**——状态变化通过替换整条消息实现

### Sarosis: 3 种状态的动态卡片

| 状态 | CSS class | 边框颜色 | 图标 | 动画 |
|------|----------|---------|------|------|
| `running` | `.running` | 蓝色 `rgba(59,130,246,0.3)` | 旋转弧线 SVG | `spin 1s linear infinite` |
| `completed` | `.completed` | 绿色 `rgba(74,222,128,0.2)` | ✓ 对勾 SVG | 无 |
| `error` | `.error` | 红色 `rgba(244,135,113,0.3)` | ✗ 叉号 SVG | 无 |

**关键设计点**：
- 工具卡片是**同一组件的状态切换**，不是替换消息
- `running` 状态显示"执行中..."三点跳动动画
- 无 `tool_request` / `rejected` / `invalid_params` 对应状态
- 工具审批由后端 `ToolApprovalService` 静默处理

### 对比

| 维度 | Void | Sarosis |
|------|------|---------|
| 状态数量 | 6 种 | 3 种 |
| 状态表示 | 不可变消息替换 | 同一卡片动态更新 |
| 审批 UI | 有（批准/拒绝按钮） | 无 |
| 参数校验 UI | 有（invalid_params 独立组件） | 无 |
| 拒绝状态 UI | 有（rejected + 拒绝文本） | 无 |
| 加载动画 | 标题蓝色闪烁 + 点动画 | 旋转图标 + 三点跳动 |

---

## 三、布局策略对比

### Void: 消息列表布局

Void 的工具消息是**独立的 ChatMessage**，在消息列表中按时间顺序排列：

```
[用户消息]
[助手消息] — "我来帮你读取文件"
[工具消息] — ✅ Read file: src/main.ts      ← 独立消息
[助手消息] — "文件内容如下..."
[工具消息] — ⏳ Edit file: src/main.ts      ← 独立消息，等待审批
[审批按钮] — [批准] [拒绝]                   ← 独立按钮行
```

**优势**：
- 工具调用和文本输出有清晰的视觉边界
- 每个工具状态都是独立的、不可变的消息，便于回溯
- Checkpoint 系统可精确记录每个工具状态

**劣势**：
- 工具消息占据独立的垂直空间，消息流较长
- 文本和工具调用之间的上下文关联被距离割裂

### Sarosis: 交织布局

Sarosis 的工具卡片**交织嵌入在助手文本内容中**：

```
[用户消息]
[助手消息]
  "我来帮你读取文件"
  ┌─────────────────────────┐
  │ 📄 读取文件  src/main.ts │  ← 交织在文本中
  └─────────────────────────┘
  "文件内容如下..."
  ┌─────────────────────────┐
  │ ✏️ 编辑文件  src/main.ts │  ← 交织在文本中
  └─────────────────────────┘
```

**交织定位机制**（两种模式）：

1. **Placeholder 精确定位**：后端在文本中插入 `<!--TOOL_CARD:tool_call_id-->`，前端解析后精确替换
2. **Fallback 模糊定位**：无 placeholder 时，将 Markdown 拆分为 parts，工具卡片均匀分布在 parts 之间

**优势**：
- 工具调用紧跟上下文，阅读体验连贯
- 消息流更紧凑，减少滚动
- Placeholder 机制让后端可精确控制卡片位置

**劣势**：
- Placeholder 系统增加前后端耦合
- 均匀分布的 Fallback 可能定位不准

---

## 四、工具类型特化渲染对比

### Void: 每工具专用 Wrapper

Void 为每个内置工具定义了**独立的 ResultWrapper 组件**：

| 工具 | Wrapper | 特殊渲染 |
|------|---------|---------|
| `read_file` | `ReadFileWrapper` | 文件内容 + 行号 + 搜索高亮 |
| `edit_file` | `EditFileWrapper` | Diff 视图 + Apply 按钮 |
| `run_command` | `RunCommandWrapper` | 终端输出样式 + 退出码 |
| `create_file_or_folder` | `CreateFileWrapper` | 文件内容预览 |
| `delete_file_or_folder` | `DeleteFileWrapper` | 确认信息 |
| `ls_dir` | `LsDirWrapper` | 文件列表 |
| `search_files` | `SearchWrapper` | 搜索结果列表 |

**MCP 工具**：统一使用 `MCPToolWrapper`，显示 MCP 服务器名 + 参数 + 结果。

**特殊能力**：
- **Apply Code Blocks**：`edit_file` 和 `create_file` 结果中的代码块有"Apply"悬浮按钮，可一键应用
- **行号高亮**：`read_file` 结果带行号，支持高亮指定行范围
- **搜索高亮**：`search_files` 结果支持搜索词高亮

### Sarosis: renderType 驱动的 3 种渲染器

Sarosis 通过 `renderType` 字段和 `ToolDisplayRegistry` 配置驱动渲染：

| renderType | 渲染器 | 适用工具 |
|-----------|--------|---------|
| `ListItems` | `ListItemsRenderer` | search_files, list_files, list_directory, grep, web_search |
| `RunTerminal` | `RunTerminalRenderer` | terminal, bash, exec, shell, run_command |
| `CodeApply` | `CodeApplyRenderer` | read_file, write_file, edit_file, edit, apply, apply_patch |
| (无/其他) | `GenericToolCallCard` | 所有其他工具 |

**renderType 解析优先级**：
```
1. provider 显式指定 (toolCall.renderType)
2. ToolDisplayRegistry 推断 (registry.renderType)
3. 结果内容自动检测 (parsed JSON 有 items → ListItems)
4. 降级到 GenericToolCallCard
```

**特殊能力**：
- **Knot Document 解析**：支持 Knot AG-UI 的 `<document>` 格式，提取 `sub_content`、`sub_content_event` 等字段
- **文件跳转**：CodeApply 和 Generic 卡片均有"查看文件"按钮，通过 `openFile()` 桥接 VS Code
- **结果截断与展开**：500 字符预览 → 5000 字符展开 → "显示全部"按钮

### 对比

| 维度 | Void | Sarosis |
|------|------|---------|
| 特化方式 | 每工具一个 Wrapper | renderType + 3 种渲染器 |
| 扩展方式 | 添加新 Wrapper 组件 | 添加 Registry 配置项 |
| MCP 工具 | 专用 MCPToolWrapper | 与内置工具统一 (Generic) |
| Apply 按钮 | 有（悬浮在代码块上） | 有（CodeApply 渲染器） |
| 行号 | 有 | 无 |
| 搜索高亮 | 有 | 无 |
| Knot 格式 | 不支持 | 支持 |
| 结果截断 | 无显式限制 | 500/5000/全部 三级 |

---

## 五、Phantom 工具过滤对比

### Void: 无 Phantom 概念

Void 的所有工具调用都渲染为可见消息。没有"隐藏工具"的概念。

### Sarosis: 三层 Phantom 过滤

Sarosis 引入了 Phantom 工具概念（UI 指示器工具，不应渲染为可见卡片）：

1. **入口过滤**（`streamHandler.ts`）：`render_type="none"` 的工具不进入 `toolCalls` 数组
2. **组件过滤**（`ChatMessage.tsx`）：`defaultShow === false` 或 `renderType.toLowerCase() === 'none'` 的过滤掉
3. **卡片过滤**（`ToolCallCard.tsx`）：`PHANTOM_TOOL_NAMES` 集合 + `renderType="none"` 双重检查

Phantom 工具列表：`task_planning`, `taskplanning`, `plan_task`, `plan_tasks`, `task_plan`, `planning`

---

## 六、ToolDisplayRegistry 配置驱动对比

### Void: 硬编码标题映射

Void 使用 `titleOfBuiltinToolName` 对象硬编码每个工具的标题：

```typescript
const titleOfBuiltinToolName = {
    'read_file': { done: 'Read file', proposed: 'Read file', running: loadingTitleWrapper('Reading file') },
    'edit_file': { done: 'Edited file', proposed: 'Edit file', running: loadingTitleWrapper('Editing file') },
    // ...
}
```

每个工具需要**3 种标题变体**（done / proposed / running），手动维护。

### Sarosis: 配置化 Registry

Sarosis 的 `ToolDisplayRegistry` 使用 JSON 配置：

```typescript
const TOOL_DISPLAY_CONFIG = {
    version: 1,
    fallback: { emoji: '🔧', detailKeys: [...] },
    tools: {
        read_file: { emoji: '📄', title: '读取文件', label: '读取文件', renderType: 'CodeApply', detailKeys: ['path'] },
        // ...
    }
}
```

**优势**：
- 新增工具只需添加配置项，无需修改组件代码
- `detailKeys` 自动从参数中提取摘要信息
- `actions` 支持基于 `args.action` 的子类型分辨
- `renderType` 推断链优雅降级

---

## 七、折叠/展开交互对比

### Void: 工具结果默认折叠

- 工具结果默认折叠，显示标题行（如"Read file: src/main.ts"）
- 点击展开显示完整结果
- 每个工具有独立的折叠状态
- Checkpoint 覆盖的工具消息变半透明 (`opacity-50`)

### Sarosis: 两种折叠模式

1. **GenericToolCallCard**：可折叠，点击标题行展开/折叠
   - 折叠态：图标 + 工具名 + 参数摘要 + 查看文件按钮 + 耗时 + 折叠箭头
   - 展开态：输入区（格式化 JSON + 复制按钮）+ 输出区（格式化结果 + 截断/展开 + 复制按钮）

2. **renderType 专用卡片**：**不可折叠**
   - 标题行 + 专用 body 直接展示
   - CSS class `tool-call-card-header-readonly`，cursor: default

---

## 八、样式体系对比

### Void 样式

- **颜色**：使用自定义颜色常量 `voidDarkGray`, `voidMidGray` 等
- **工具标题**：`ToolHeaderWrapper` 统一包裹，灰色背景 + 左侧蓝色边线
- **加载态**：`loadingTitleWrapper` 用 CSS animation 实现蓝色脉冲
- **Apply 按钮**：悬浮在代码块右上角，hover 时显示

### Sarosis 样式

- **颜色**：使用 VS Code CSS 变量 `var(--as-accent)`, `var(--as-success)` 等
- **边框颜色**：按状态动态切换
  - running: 蓝色 `rgba(59,130,246,0.3)`
  - completed: 绿色 `rgba(74,222,128,0.2)`
  - error: 红色 `rgba(244,135,113,0.3)`
- **图标颜色**：继承卡片状态 class，与边框颜色一致
- **交织间距**：`margin: 6px 0`，首尾卡片无额外间距
- **终端样式**：绿色 `$` 提示符 + 深色命令行背景 + 等宽字体
- **代码文件路径**：蓝色链接样式 + "查看文件"按钮

---

## 九、关键差异总结

| 维度 | Void | Sarosis | 评价 |
|------|------|---------|------|
| **布局** | 消息列表（独立消息） | 交织嵌入（Placeholder + Fallback） | Sarosis 阅读体验更好 |
| **状态** | 6 种不可变子状态 | 3 种动态状态 | Void 状态更精细 |
| **审批 UI** | 有（批准/拒绝按钮） | 无 | Void 安全性更好 |
| **特化渲染** | 每工具一个 Wrapper | renderType + 3 种渲染器 | Sarosis 扩展性更好 |
| **配置驱动** | 硬编码 | ToolDisplayRegistry | Sarosis 维护成本更低 |
| **Phantom 过滤** | 无 | 三层过滤 | Sarosis 更干净 |
| **Apply 功能** | 代码块悬浮 Apply 按钮 | CodeApply 渲染器 | Void 体验更自然 |
| **行号/搜索高亮** | 有 | 无 | Void 信息展示更丰富 |
| **结果截断** | 无 | 三级截断 | Sarosis 更适合长输出 |
| **MCP 工具** | 专用 Wrapper | 与内置统一 | Void 区分更清晰 |
| **Checkpoint 集成** | 有（半透明覆盖） | 无 | Void 有时间旅行支持 |

---

## 十、优化建议

### 高优先级

#### 1. 添加工具审批 UI

**现状**：Sarosis 的 `ToolApprovalService` 在后端静默处理审批，用户无感知。

**建议**：在 `ToolCallState` 中增加 `approval_required` 和 `rejected` 状态：

```typescript
// streamHandler.ts
interface ToolCallState {
    status: 'pending' | 'approval_required' | 'running' | 'completed' | 'error' | 'rejected';
    approvalCategory?: 'edits' | 'terminal' | 'mcp';
    approvalReason?: string;  // 如 "This tool will modify files"
}
```

在 `GenericToolCallCard` 中增加审批卡片：

```tsx
{toolCall.status === 'approval_required' && (
    <div className="tool-call-approval">
        <span className="tool-call-approval-text">
            {toolCall.approvalReason || '此操作需要您的批准'}
        </span>
        <button className="tool-call-approve" onClick={...}>批准</button>
        <button className="tool-call-reject" onClick={...}>拒绝</button>
    </div>
)}
```

#### 2. 增加工具参数校验失败状态

**现状**：Void 有 `invalid_params` 独立组件，Sarosis 没有。

**建议**：在 `ToolCallState.status` 中增加 `invalid_params` 状态，渲染为灰色警告卡片，显示工具名和错误信息。

#### 3. 为 ReadFile 添加行号显示

**现状**：Void 的 `ReadFileWrapper` 显示行号，Sarosis 的 `CodeApplyRenderer` 不显示。

**建议**：在 `CodeApplyRenderer` 中检测 `read_file` 工具，渲染带行号的代码块：

```tsx
{isReadFile && code && (
    <pre className="tool-call-code-with-lines">
        {code.split('\n').map((line, i) => (
            <div key={i}>
                <span className="line-number">{i + 1}</span>
                <span className="line-content">{line}</span>
            </div>
        ))}
    </pre>
)}
```

### 中优先级

#### 4. 添加 Apply Code Blocks 悬浮按钮

**现状**：Void 的代码块有"Apply"悬浮按钮，Sarosis 的 `CodeApplyRenderer` 有"查看文件"按钮但没有"Apply"。

**建议**：在 `CodeApplyRenderer` 的代码预览区添加"应用更改"悬浮按钮，调用后端 `applyCodeChange` 接口。

#### 5. renderType 专用卡片支持折叠

**现状**：renderType 卡片（ListItems / RunTerminal / CodeApply）不可折叠，长输出会占据大量空间。

**建议**：为 renderType 卡片添加折叠/展开逻辑，默认折叠输出区，仅显示标题行。

#### 6. MCP 工具视觉区分

**现状**：Void 对 MCP 工具有专用 `MCPToolWrapper`，显示 MCP 服务器名；Sarosis 的 MCP 工具与内置工具使用相同的 Generic 卡片。

**建议**：在 `ToolDisplayRegistry` 中增加 `isMcp` 标记，`GenericToolCallCard` 渲染时对 MCP 工具添加"MCP"标签和服务器名称。

### 低优先级

#### 7. 搜索结果高亮

**现状**：Void 的 `SearchWrapper` 支持搜索词高亮，Sarosis 的 `ListItemsRenderer` 不支持。

**建议**：在 `ListItemsRenderer` 中对 `search_*` 和 `grep` 工具的结果，高亮匹配的关键词。

#### 8. 工具耗时排序/分组

**建议**：当同一消息中有多个工具调用时，支持按耗时排序或按类型分组显示。

#### 9. 工具调用依赖链可视化

**建议**：当多个工具存在因果关系（如 read_file → edit_file），用连接线或缩进表示依赖关系。
