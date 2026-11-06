---
name: figma
description: 通过 Figma MCP 读取设计稿（布局/样式/变量/资源/Code Connect），实现设计到代码（design-to-code）。支持官方远程 Figma MCP 与社区 figma-developer-mcp。
activation: auto
match: ["figma", "设计稿", "设计转代码", "design to code", "design-to-code", "ui 实现", "ui实现", "ui还原", "还原设计", "切图"]
category: design
---

# Figma 设计转代码

把 Figma 设计稿还原为可运行的前端代码。核心原则：**先取上下文，再写代码；永远不要凭空猜测设计尺寸、颜色与间距。**

## 可用的 MCP 来源

本 skill 依赖 Figma MCP 已连接。有两种预置（任选其一，二者工具名不同）：

| 来源 | 传输 | 认证 | 主要工具 |
|------|------|------|----------|
| 官方 `figma`（推荐） | 远程 http | Figma OAuth | `get_design_context`、`get_variable_defs`、`get_code_connect_map`、`get_screenshot`、`get_metadata`、`get_code` |
| 社区 `figma-developer-mcp` | 本地 stdio | `FIGMA_API_KEY` | `get_figma_data`、`download_figma_images`、`get_code_connect` |

若 MCP 工具不可用，先检查服务器是否已连接（集成面板 → MCP → 对应连接器），再继续；不要在没有设计数据时硬编样式。

## 工作流

### Step 1 — 定位节点

从用户提供的 Figma 链接提取 `fileKey` 与 `nodeId`：

- URL 形如 `https://www.figma.com/design/<fileKey>/<name>?node-id=<nodeId>`
- `node-id` 中的 `-` 需替换为 `:`（如 `1-234` → `1:234`）；若有 `I` 前缀（instance id），一并带上。

官方远程 MCP 会自动基于当前选中的画布/节点工作；社区版需显式传 `fileKey` 与 `nodeId`。

### Step 2 — 读取设计上下文

- **官方**：先调 `get_design_context`（可带 `clientLanguages` / `clientFrameworks`，如 `["html","css","javascript"]`、`["react"]`），拿结构化布局 + 样式；需要变量时调 `get_variable_defs`；需要组件代码映射调 `get_code_connect_map` 或 `get_code`。
- **社区**：调 `get_figma_data(fileKey, nodeId, depth)`，返回简化后的节点树与样式；缺图片时调 `download_figma_images`。

先完整读完返回数据，理解层级（frame / group / component / text / image）后再动手。

### Step 3 — 还原布局与样式

1. **盒子结构**：把每个 frame/group 映射为语义化 HTML 标签（`header` / `nav` / `main` / `section` / `footer`），避免全用 `div`。
2. **布局**：优先 `flex` / `grid`；绝对定位只用于真正的覆盖层（badge、悬浮提示）。设计稿的 auto-layout 通常对应 flex。
3. **间距与尺寸**：严格沿用设计数据中的 padding / gap / width / height / radius，不要四舍五入「好看点」。
4. **颜色与字体**：变量（variables）优先 → CSS custom properties（`:root` 里定义）；颜色用设计值，字号/字重/行高照搬。
5. **响应式**：仅当设计稿有多断点或用户要求时才做响应式，否则 1:1 还原，避免过度发挥。

### Step 4 — 处理图片与图标

- 位图资源：社区版用 `download_figma_images` 下载；官方版可用 `get_screenshot` 获取视觉参考，导出资源走 Figma Export。
- 图标：优先映射到现有 icon 字体 / SVG 内联；无法复用再导出。
- 资源落地到项目的静态目录，引用相对路径。

### Step 5 — 校验

- 对照设计数据逐项核对：颜色、字号、间距、圆角、对齐。
- 如拿到截图，用视觉再核对一次关键区域（导航、卡片、按钮态）。
- 向用户报告：已还原哪些组件、哪些资源需要手动导出、与设计稿的已知差异。

## 注意事项

- **nodeId 是定位关键**：拿不到正确节点时会返回空或错误数据，先确认 node-id 转换正确。
- **不要混用两套工具名**：连的是官方就只用 `get_*` 系列，连的是社区就只用 `get_figma_data` / `download_figma_images`。
- **变量优先**：设计 token 应映射为项目可维护的 CSS variables / theme 对象，而不是散落的十六进制字面量。
- **Code Connect**：若设计稿已配置 Code Connect，优先用 `get_code`（官方）/ `get_code_connect`（社区）拿现成组件映射，而不是手写。
