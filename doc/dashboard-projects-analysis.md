# AIProjects 目录 Dashboard 功能对比分析

> 调研日期：2026-06-26
> 调研范围：`G:\CustomWorkspaces\AIProjects` 下全部项目
> 目标：找出支持 Dashboard 的项目，对比功能，分析哪些适合 sarosis-agents-client（VS Code fork + AgentStudio）

---

## 一、支持 Dashboard 的项目清单

| 项目 | 语言/技术栈 | Dashboard 形态 | 成熟度 | 与本项目相关性 |
|------|------------|---------------|--------|--------------|
| **ECC** | Python/Node/Rust | GUI+Web+CLI+TUI 四套 | ★★★★★ | 高 |
| **Hermes-Agent** | Python(FastAPI)+React19 | Web SPA + 插件系统 | ★★★★★ | 高 |
| **headroom** | Python(FastAPI)+Alpine.js | Web 监控面板 | ★★★★ | 高 |
| **rudder** | React+TS+Express | Web 运维面板 | ★★★★★ | 极高 |
| **n8n** | Vue3+TS | Web Insights+AI Eval | ★★★★ | 中高 |
| **hivemind** | 纯 HTML+vis-network | 静态 HTML 面板 | ★★★ | 中 |
| **openclaw** | Lit Web Components | Web 控制面板 | ★★★★ | 中 |
| **swarms** | Python | 终端 ASCII 面板 | ★★ | 低 |
| **agentmemory** | TS | 网站截图资源 | ★ | 中 |
| **openhuman** | Rust | dashboard 目录 | ★★ | 低 |

---

## 二、各项目 Dashboard 功能详解

### 1. ECC — 最全面的 Dashboard 生态系统

ECC 包含 **4 套互补的 Dashboard**，覆盖桌面 GUI、Web、CLI、TUI 四种形态：

#### 1.1 Web Dashboard (`scripts/dashboard-web.js`)
- **展示**：Agents / Skills / Commands / Rules / MCPs / Hooks 六大面板
- **技术**：纯 Node.js http 模块，零第三方依赖，HTML/CSS/JS 全内联
- **特性**：
  - 11 种语言国际化（含中文简繁、日韩）
  - 深色/浅色主题切换（localStorage 持久化）
  - 全局搜索（分组建议下拉 + 键盘导航 + ⌘K 快捷键）
  - 最近浏览栏（最多 8 项）
  - Hash 路由详情页（`#/agents/xxx`）
  - 分类过滤器 + 一键复制命令
  - `/api/data` JSON API 端点
  - 响应式设计（768px/480px 断点）
- **数据流**：启动时同步扫描项目目录，解析 YAML frontmatter

#### 1.2 Rust TUI Dashboard (`ecc2/src/tui/dashboard.rs`, 543KB/15000+行)
- **5 个面板**：
  - **Sessions**：会话列表表格 + 统计（pending/running/idle/stale/completed/failed）+ 审批队列 + handoff backlog
  - **Output**：7 种模式（实时输出流 / 时间线 / 上下文图 / Worktree Diff / 冲突协议 / Git 状态 / Git Patch）
  - **Metrics**：Token Budget 仪表 + Cost Budget（美元）+ 详细指标
  - **Board**：看板视图
  - **Log**：工具日志（时间戳/工具名/耗时/风险分数/触发原因/输入输出摘要）
- **技术**：ratatui + crossterm + tokio（broadcast channel 实时更新）
- **特性**：Token/Cost 预算追踪+告警、多会话管理（parent/child）、审批队列、Worktree 健康监控、会话完成弹窗队列、桌面+Webhook 双通道通知、主题系统、面板可调大小

#### 1.3 Operator Readiness Dashboard (`scripts/operator-readiness-dashboard.js`)
- **展示**：18 项发布就绪检查 + MRR 增长基线 + Top Actions + Work Order
- **输出**：text / json / markdown（可直接嵌入 GitHub Issue/PR）
- **数据**：文档扫描 + GitHub API（PR/Issue/Discussion 实时状态）+ git 命令

#### 1.4 Skill Health Dashboard (`scripts/lib/skill-evolution/dashboard.js`)
- **4 个 ASCII 面板**：30 天成功率 sparkline + 失败模式聚类条形图 + 待审修订 + 版本历史
- **技术**：纯 Node.js，Unicode 方块字符绘制

### 2. Hermes-Agent — 插件化 Web Dashboard 框架

- **技术栈**：FastAPI + Uvicorn 后端 / React 19 + TypeScript + Vite + Tailwind CSS 4 前端
- **核心**：通过 `hermes dashboard` 命令启动的 Web SPA，支持多 Profile 切换

#### 插件系统架构
- **发现机制**：扫描 `plugins/*/dashboard/manifest.json`（bundled/User/Project 三来源）
- **manifest.json**：定义 name/label/icon/tab.path/slots/entry(JS)/css/api(Python)
- **后端挂载**：仅 bundled 插件的 `plugin_api.py` 被导入（安全限制），暴露 FastAPI APIRouter，挂载到 `/api/plugins/<name>/`
- **前端集成**：10 个命名插槽（backdrop/header-left/right/banner/sidebar/pre-main/post-main/footer-left/right/overlay）+ 路由覆盖 + 隐藏插件

#### 认证系统（多层级）
- **Loopback 模式**：进程级随机 token，注入 SPA HTML，`X-Hermes-Session-Token` header
- **OAuth/密码模式**：`DashboardAuthProvider` 抽象类，支持 PKCE + CSRF 保护的 OAuth 重定向 + 用户名密码登录 + Session cookie + WebSocket ticket

#### 内置插件
- **Kanban**：多 Agent 协作看板（拖拽卡片/评论/父子任务/工作流模板），SQLite WAL + 300ms 轮询 WebSocket 实时更新
- **Achievements**：Steam 风格成就系统（Agent Autonomy/Debugging Chaos/Vibe Coding/Hermes Native 四类，Copper→Olympian 五级），120s TTL 快照缓存
- **Strike Freedom Cockpit**：高达主题驾驶舱皮肤（YAML 主题 + slot 注入遥测面板）

### 3. headroom — AI 代理压缩监控面板

- **技术栈**：FastAPI + Tailwind CSS + Alpine.js + HTMX（单 HTML 文件 167KB）
- **定位**：Headroom 是 AI agent 上下文压缩层（减少 60-95% token），Dashboard 是其可观测性层

#### 展示内容
- **压缩统计**：输入/输出 token、节省 token、节省百分比、成本节省（美元）、请求数（总计/缓存命中/失败）、按 provider/model 分布
- **Agent 使用**：按 AI agent（Codex/Claude Code/Cursor/OpenClaw）分组，多层 fallback 分类（client tag > stack tag > model > provider）
- **前缀缓存**：缓存命中率、bust 次数、**Observed TTL Buckets**（5min vs 1h 分桶）、**Compression vs Cache** 净收益面板
- **历史趋势**：每日/每周/每月节省 sparkline
- **实时 Feed**：可切换的实时请求流

#### 数据模型
- 本地：`/stats?cached=1`（5 秒 TTL 快照缓存），从 compression store / telemetry collector / context tool stats 聚合
- 远程：Supabase `proxy_telemetry_v2`（原始）+ `dashboard_summary`（pg_cron 每小时刷新，RLS 匿名读取）

### 4. rudder — AI Agent 运维控制平面（最相关）

- **技术栈**：React + TypeScript + TanStack Query + Tailwind CSS + Express + Drizzle ORM
- **定位**：专为 AI Agent（如 Claude Code）设计的运维管理平台

#### 组织级 Dashboard
- **4 个指标卡片**：
  - Agents Enabled（活跃/运行/暂停/出错）
  - Tasks In Progress（进行中/待处理/阻塞）
  - Month Spend（月支出 + 预算利用率%）
  - Tokens Used（输入/缓存/输出分别显示）
- **4 个图表**：每日运行量堆叠柱状图 / 按优先级 Issue / 按状态 Issue / Token 消耗趋势
- **Skills 分析**：30 天全宽堆叠柱状图，hover 看单日技能明细（区分 loaded vs used skills）
- **Active Agents Panel**：实时运行 Agent + transcript 预览
- **Recent Activity / Tasks**：操作流和任务列表 + 实时 transcript 片段
- **Budget Incidents**：预算事件告警条
- **日期范围**：7天/15天/30天/自定义

#### Agent 详情页
- 单 Agent 维度：运行活动图 / Issue 分布 / 触发器分布 / 成功率图 / 技能使用图
- 实时 transcript 查看 + 预算策略明细

### 5. n8n — 工作流 Insights + AI 评估

- **技术栈**：Vue 3 + TypeScript + Vite + `@n8n/design-system`
- **Insights Dashboard**：
  - 5 核心指标（Total/Failed/Failure Rate/Time Saved/Avg Run Time）+ 偏差值趋势着色
  - 时间序列图表（自动调整粒度：小时/天/周）
  - 工作流分组表格 + 项目筛选 + 日期范围
- **AI Evaluation（企业版）**：
  - 指标体系：correctness / helpfulness / stringSimilarity / categorization / toolsUsed
  - 多 LLM Judge（OpenAI/Anthropic/Gemini/Azure/Bedrock/Ollama）
  - 评估向导 + 并发控制 + 测试用例级分析 + 历史趋势

### 6. hivemind — 轻量代码图 + KPI 面板

- **技术**：纯 HTML + 内联 CSS/JS，CDN 引入 vis-network@9.1.9
- **展示**：4 张 KPI 卡片（Token 节省 / Skills 数 / Memory 召回 / Sessions 数）+ 代码库力导向图（Barnes-Hut 物理引擎，节点按类型着色）
- **模式**：生成自包含 HTML 文件 / `--serve` loopback HTTP / 自动检测 SSH 切换 serve

### 7. openclaw — 实时控制管理界面

- **技术**：Lit Web Components + Gateway HTTP/WS 服务器
- **展示**：聊天 / 配置管理 / 执行审批（非数据可视化面板，是交互式控制台）
- **认证**：Token/密码/Tailscale/受信任代理，Token 通过 URL fragment 传递
- **特性**：macOS 原生窗口封装、TLS 支持、SSH 隧道提示

---

## 三、功能维度对比矩阵

| 功能维度 | ECC | Hermes | headroom | rudder | n8n | hivemind | openclaw |
|---------|-----|--------|----------|--------|-----|----------|----------|
| Agent 运行状态 | ✅ TUI | ✅ | ✅ | ✅✅ | ❌ | ✅ KPI | ✅ |
| Token/Cost 追踪 | ✅✅ | ❌ | ✅✅ | ✅✅ | ❌ | ✅ | ❌ |
| 会话管理 | ✅✅ | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ |
| Skills 使用分析 | ✅ | ✅ | ❌ | ✅✅ | ❌ | ✅ | ❌ |
| 代码库图可视化 | ❌ | ❌ | ❌ | ❌ | ❌ | ✅✅ | ❌ |
| 实时输出流 | ✅ | ✅ PTY | ✅ Feed | ✅ transcript | ❌ | ❌ | ✅ WS |
| 预算告警 | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| 审批队列 | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| 压缩/缓存指标 | ❌ | ❌ | ✅✅ | ❌ | ❌ | ❌ | ❌ |
| 插件化扩展 | ✅ skill | ✅✅ | ❌ | ✅ widget | ❌ | ❌ | ❌ |
| 多语言 i18n | ✅ 11语言 | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ |
| 主题系统 | ✅ | ✅ YAML | ✅ 暗亮 | ❌ | ❌ | ✅ dark | ❌ |
| 认证体系 | ❌ | ✅✅ OAuth | ❌ | ❌ | ❌ | ❌ | ✅✅ |
| 历史趋势图 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| AI 评估指标 | ❌ | ❌ | ❌ | ❌ | ✅✅ | ❌ | ❌ |
| WebSocket 实时 | ✅ broadcast | ✅✅ | ✅ 轮询 | ✅ | ❌ | ❌ | ✅ |

---

## 四、适合 sarosis-agents-client 的功能分析

### 本项目现状
- VS Code fork，AgentStudio 已有：AgentOS 执行路径、上下文压缩（ContextManager）、记忆系统（L0/L1）、代码库图谱（codebaseGraphViewerEditorPane）、商城集成
- 现有 `src/pages/Dashboard.js` 是碳排放看板（MUI+recharts），与 Agent 功能无关
- 代码库图谱查看器已有基础 stats（节点/边计数）

### 推荐引入的功能（按优先级排序）

#### P0 — 立即适合（与现有架构直接对齐）

| 功能 | 参考项目 | 理由 |
|------|---------|------|
| **Agent 运行监控面板** | rudder / ECC TUI | 本项目 AgentOSService 已有三条执行路径，缺少可视化监控。展示：活跃会话数、运行/空闲/失败状态、当前模型、token 消耗 |
| **Token/Cost 追踪仪表** | ECC TUI TokenMeter / rudder | ContextManager 已估算 token，AgentDriver 每轮记录消耗。增加：预算仪表盘、成本累计、超预算告警 |
| **上下文压缩指标** | headroom | ContextManager 已实现三段式压缩+anti-thrashing。展示：压缩前后 token 对比、节省百分比、压缩次数、low-effort 计数 |
| **Skills/MCP 使用分析** | rudder Skills Analytics | builtinToolProvider 已有 memory_remember/search 等工具，商城有 Skill 安装器。展示：工具调用频率、成功率、loaded vs used 区分 |

#### P1 — 近期适合（中等改造）

| 功能 | 参考项目 | 理由 |
|------|---------|------|
| **会话历史与回放** | ECC TUI Output / rudder transcript | AgentDriver 已有流式输出，可持久化会话日志。展示：历史会话列表、transcript 回放、关键决策标记 |
| **记忆系统仪表盘** | agentmemory / hivemind KPI | 已有 L0/L1 记忆写入路径。展示：记忆总数、按 type 分布（long_term/short_term）、L1 提取触发次数、memory_search 命中率 |
| **代码库图谱增强** | hivemind vis-network | codebaseGraphViewerEditorPane 已有 2D 图谱。借鉴 hivemind 的力导向布局、节点类型着色、KPI 卡片（节点/边/模块数） |
| **审批队列 UI** | ECC TUI / openclaw | ExecutionProvider 有 Plan 模式，可增加审批面板：待审批操作列表、批准/拒绝、风险分数显示 |

#### P2 — 中期适合（需要新基础设施）

| 功能 | 参考项目 | 理由 |
|------|---------|------|
| **Dashboard 插件系统** | Hermes manifest.json + slots | 本项目已有扩展系统（extensions/），可借鉴 Hermes 的 dashboard 插件 manifest + slot 注入模式，让第三方扩展贡献 Dashboard 面板 |
| **多语言 i18n** | ECC 11 语言 / n8n | 本项目面向腾讯内部，可先支持中英文。ECC 的 i18n 实现轻量（内联 JS 对象）|
| **预算管理与告警** | rudder Budget Incidents | 增加按项目/团队的预算配置、超支告警、审批流 |
| **AI 评估指标** | n8n AI Evaluation | 对 Agent 输出做自动化质量评估（correctness/helpfulness），多 LLM Judge |

#### P3 — 远期/可选

| 功能 | 参考项目 | 理由 |
|------|---------|------|
| **TUI 终端面板** | ECC Rust TUI | 本项目是 GUI IDE，TUI 必要性低，但 ratatui 的面板布局思路可借鉴 |
| **OAuth 认证** | Hermes OAuth / openclaw | 本项目已有 TOF 登录（ITofAuthService），Dashboard 若对外开放可复用 |
| **远程 Supabase 聚合** | headroom | 匿名遥测聚合到云端，展示全局使用统计。隐私敏感，需谨慎 |

---

## 五、推荐的技术实现方案

### 方案：VS Code 原生 Webview + DOM 混合 Dashboard

基于本项目特点（VS Code fork、TrustedHTML 限制、sandbox 限制），推荐：

```
AgentStudio Dashboard
├── 入口：AgentStudio 侧边栏新增 "Dashboard" 图标 → 打开 EditorPane
├── 实现：codebaseGraphViewerEditorPane.ts 同款模式（原生 DOM + <style> 注入）
├── 数据源：
│   ├── AgentOSService — 会话状态、token 消耗、执行路径
│   ├── ContextManager — 压缩指标
│   ├── CodebaseGraphService — 图谱统计
│   ├── MemoryService — 记忆统计
│   └── MarketplaceService — 已安装包统计
├── 布局（参考 rudder）：
│   ├── 顶部 4 KPI 卡片（活跃会话/Token 消耗/压缩节省/记忆条数）
│   ├── 中部图表区（Token 趋势线 + Skills 使用柱状图）
│   ├── 底部列表（最近会话 + 最近记忆提取）
│   └── 右侧告警栏（预算/异常）
├── 图表库：轻量内联 SVG（参考 rudder 自定义 SVG 柱状图）或 CDN Chart.js
├── 实时更新：EventEmitter 监听 AgentOSService 事件（非 WebSocket，进程内通信）
└── 主题：复用 VS Code CSS 变量（--vscode-*），自动适配暗/亮主题
```

### 不推荐
- **Hermes 式独立 FastAPI 服务器**：本项目是桌面 IDE，不需要独立 Web 服务器
- **ECC Rust TUI**：本项目是 GUI，TUI 无意义
- **headroom Supabase 远程聚合**：隐私敏感且需额外基础设施

---

## 六、总结

| 推荐优先级 | 功能 | 主要参考 | 预估工作量 |
|-----------|------|---------|-----------|
| P0 | Agent 运行监控 + Token/Cost 仪表 | rudder + ECC TUI | 3-5 人天 |
| P0 | 上下文压缩指标面板 | headroom | 2-3 人天 |
| P0 | Skills/MCP 使用分析 | rudder | 2-3 人天 |
| P1 | 会话历史与 transcript 回放 | ECC + rudder | 5-7 人天 |
| P1 | 记忆系统仪表盘 | hivemind KPI | 2-3 人天 |
| P1 | 代码库图谱 KPI 增强 | hivemind | 1-2 人天 |
| P2 | Dashboard 插件系统 | Hermes | 7-10 人天 |
| P2 | 预算管理与告警 | rudder | 3-5 人天 |

**核心结论**：**rudder** 是最直接参考（同为 AI Agent 运维），**ECC TUI** 的面板布局和 Token/Cost 追踪最成熟，**headroom** 的压缩指标设计最契合本项目的 ContextManager，**Hermes** 的插件系统适合远期扩展。建议 P0 阶段以 rudder 的卡片+图表布局为蓝本，用 VS Code 原生 DOM 实现。
