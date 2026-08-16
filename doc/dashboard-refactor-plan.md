# Dashboard 数据层重构方案 — 支持用户自定义样式

> 日期：2026-07-01
> 目标：解耦数据/布局/样式三层，支持用户通过配置文件自定义 Dashboard 面板布局和视觉样式

---

## 一、当前架构问题

### 1.1 数据层问题

| 问题 | 影响 |
|------|------|
| KPI 卡片定义硬编码在 `_buildData()` | 新增 KPI 需改代码，无法配置 |
| Token 趋势图 SVG path 坐标写死 | 图表永远显示假数据 |
| `tokenByModel` 只按输入/缓存/输出拆分 | 无法按真实模型分布 |
| `cacheLostTokens` 硬编码为 0 | 压缩 vs 缓存对比无意义 |
| 会话的 `tokens` 和 `turns` 始终为 0 | 会话列表无深度信息 |
| `budgets` 始终为空数组 | 预算面板已被代码图谱替代 |
| 日期范围 `setDateRange` 不影响数据 | 时间切换无实际效果 |

### 1.2 渲染层问题

| 问题 | 影响 |
|------|------|
| 全部内联样式 `style.cssText` | 无法自定义样式，代码冗长 |
| `el()` 和 `svgEl()` 辅助函数在 EditorPane 和 ViewPane 中重复 | 维护困难 |
| `STATUS_COLORS` / `STATUS_LABELS` 常量重复 | 修改需同步两处 |
| `_render()` 全量清空重建 DOM | 刷新时闪烁、无增量更新 |
| Token 趋势图 SVG path 损坏 | 图表不显示或显示错误 |
| 面板顺序/可见性硬编码 | 用户无法隐藏/重排面板 |

### 1.3 架构耦合问题

```
当前: Service 直接构建 KPI 对象（含 label/value/color/breakdown）
      ↓
      EditorPane 直接读取 KPI 对象渲染 DOM
      ↓
      ViewPane 也直接读取 KPI 对象渲染

问题: 数据准备和 UI 展示耦合在一起
```

---

## 二、重构架构设计

### 2.1 三层分离架构

```
┌─────────────────────────────────────────────────────────────┐
│                    数据层 (Data Layer)                       │
│  DashboardDataProvider — 纯数据采集，无 UI 概念               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │OS Stats  │ │Sessions  │ │Memory    │ │Graph     │  ...   │
│  │Provider  │ │Provider  │ │Provider  │ │Provider  │        │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘        │
│       └──────────┬┴──────────┬┴──────────┬──┘               │
│                  ▼           ▼           ▼                   │
│           DashboardDataCollector (聚合原始指标)              │
└────────────────────────┬────────────────────────────────────┘
                         │ IDashboardMetrics (原始数据)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    布局层 (Layout Layer)                     │
│  DashboardLayoutProvider — 根据配置编排面板                  │
│  ┌──────────────────────────────────────────────┐           │
│  │  dashboard-layout.json (用户配置)              │           │
│  │  { panels: [...], kpis: [...], theme: {...} } │           │
│  └──────────────────┬───────────────────────────┘           │
│                     ▼                                       │
│  IDashboardPanel[] — 面板定义（类型+数据源+布局位置）          │
└────────────────────────┬────────────────────────────────────┘
                         │ IDashboardRenderData (面板+数据)
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                    样式层 (Style Layer)                      │
│  DashboardStyleRegistry — CSS 变量 + 主题系统                │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │ default.theme.ts │  │ user.theme.json  │                 │
│  └──────────────────┘  └──────────────────┘                 │
│  → 注入为 :root CSS 变量 + dashboard CSS 类                   │
│  → EditorPane/ViewPane 只用 CSS 类，不用内联样式              │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 核心接口设计

```typescript
// ─── 数据层：原始指标（无 UI 概念）──────────────────────────

interface IDashboardMetrics {
  osStats: IAgentOSDashboardStats;
  sessions: IDashboardSessionRaw[];
  memory: IDashboardMemoryRaw;
  graph: IDashboardGraphRaw;
  timestamp: number;
}

// ─── 布局层：面板定义 ──────────────────────────────────────

interface IDashboardPanelDef {
  /** 唯一 ID */
  id: string;
  /** 面板类型：决定用哪个渲染器 */
  type: 'kpi-grid' | 'token-trend' | 'skills-usage' | 'alerts' 
      | 'compression' | 'sessions' | 'memory-tiers' | 'graph-stats'
      | 'token-distribution' | 'custom';
  /** 显示标题 */
  title: string;
  /** 副标题 */
  subtitle?: string;
  /** 布局区域 */
  region: 'header' | 'kpi-row' | 'main-left' | 'main-center' | 'main-right'
        | 'middle' | 'bottom-left' | 'bottom-right';
  /** 是否可见 */
  visible: boolean;
  /** 显示顺序 */
  order: number;
  /** 数据源标识（供 DataCollector 路由） */
  dataSource: string;
  /** 面板专属配置 */
  config?: Record<string, unknown>;
}

// ─── KPI 定义（从代码移到配置）──────────────────────────────

interface IKpiDef {
  id: string;
  label: string;
  /** 数据源字段路径，如 "osStats.totalInputTokens" */
  dataSource: string;
  /** 值转换函数名 */
  formatter?: 'number' | 'k-tokens' | 'percent' | 'count' | 'auto';
  /** 单位 */
  unit?: string;
  /** 颜色（CSS 变量名或 hex） */
  color: string;
  /** 图标（codicon 名称） */
  icon?: string;
  /** 是否显示 breakdown */
  showBreakdown?: boolean;
}

// ─── 样式层：主题定义 ──────────────────────────────────────

interface IDashboardTheme {
  /** 颜色方案 */
  colors: {
    accent: string;       // 主色调
    chartColors: string[]; // 图表颜色序列
    statusColors: {       // 状态色
      running: string;
      idle: string;
      failed: string;
      completed: string;
      stopped: string;
    };
    kpiColors: {          // KPI 主题色
      primary: string;
      secondary: string;
      success: string;
      warning: string;
      danger: string;
      info: string;
    };
  };
  /** 布局参数 */
  layout: {
    kpiColumns: number;     // KPI 卡片列数
    mainGridColumns: string; // 主区域 grid-template-columns
    bottomGridColumns: string;
    gap: string;            // 面板间距
    panelRadius: string;    // 面板圆角
  };
  /** 字体 */
  typography: {
    kpiValueSize: string;
    panelTitleSize: string;
    bodySize: string;
  };
}

// ─── 完整布局配置 ──────────────────────────────────────────

interface IDashboardLayoutConfig {
  version: string;
  theme: IDashboardTheme;
  panels: IDashboardPanelDef[];
  kpis: IKpiDef[];
  /** 日期范围默认值 */
  defaultDateRange: 'today' | '7d' | '30d' | 'all';
  /** 自动刷新间隔（毫秒，0=禁用） */
  autoRefreshMs: number;
}
```

### 2.3 默认配置文件

**路径**：`~/.saros/dashboard-config.json`

```json
{
  "version": "1.0",
  "theme": {
    "colors": {
      "accent": "var(--vscode-button-background)",
      "chartColors": ["#0078d4", "#4ec9b0", "#dcdcaa", "#ce9178", "#c586c0"],
      "statusColors": {
        "running": "#4ec9b0",
        "idle": "#dcdcaa",
        "failed": "#f48771",
        "completed": "#89d185",
        "stopped": "#c586c0"
      }
    },
    "layout": {
      "kpiColumns": 5,
      "mainGridColumns": "1fr 1fr 320px",
      "bottomGridColumns": "1fr 1fr",
      "gap": "16px",
      "panelRadius": "6px"
    }
  },
  "panels": [
    {
      "id": "graph-stats",
      "type": "graph-stats",
      "title": "代码图谱统计",
      "region": "bottom-left",
      "visible": true,
      "order": 1,
      "dataSource": "graph"
    },
    {
      "id": "token-trend",
      "type": "token-trend",
      "title": "Token 使用趋势",
      "region": "main-left",
      "visible": true,
      "order": 1,
      "dataSource": "osStats"
    },
    {
      "id": "skills-usage",
      "type": "skills-usage",
      "title": "Skills / MCP 使用分析",
      "region": "main-center",
      "visible": true,
      "order": 2,
      "dataSource": "osStats.toolCallCounts"
    },
    {
      "id": "alerts",
      "type": "alerts",
      "title": "告警与通知",
      "region": "main-right",
      "visible": true,
      "order": 3,
      "dataSource": "derived"
    },
    {
      "id": "compression",
      "type": "compression",
      "title": "上下文压缩指标",
      "region": "middle",
      "visible": true,
      "order": 1,
      "dataSource": "osStats.compression"
    },
    {
      "id": "sessions",
      "type": "sessions",
      "title": "会话列表",
      "region": "bottom-left",
      "visible": true,
      "order": 2,
      "dataSource": "sessions"
    },
    {
      "id": "memory-tiers",
      "type": "memory-tiers",
      "title": "记忆统计 (4-Tier)",
      "region": "bottom-right",
      "visible": true,
      "order": 1,
      "dataSource": "memory"
    },
    {
      "id": "token-distribution",
      "type": "token-distribution",
      "title": "Token 分布",
      "region": "bottom-right",
      "visible": true,
      "order": 2,
      "dataSource": "osStats"
    }
  ],
  "kpis": [
    {
      "id": "graph",
      "label": "代码图谱",
      "dataSource": "graph.nodes",
      "formatter": "number",
      "color": "var(--vscode-button-background)",
      "icon": "codicon-graph",
      "showBreakdown": true
    },
    {
      "id": "sessions",
      "label": "会话总数",
      "dataSource": "sessions.length",
      "formatter": "count",
      "color": "#4ec9b0",
      "icon": "codicon-comment-discussion"
    },
    {
      "id": "tokens",
      "label": "Token 消耗",
      "dataSource": "osStats.totalTokens",
      "formatter": "k-tokens",
      "unit": "K",
      "color": "#dcdcaa",
      "icon": "codicon-pulse"
    },
    {
      "id": "compression",
      "label": "压缩节省",
      "dataSource": "compression.savedPercent",
      "formatter": "percent",
      "color": "#ce9178",
      "icon": "codicon-compress"
    },
    {
      "id": "memory",
      "label": "记忆 (4-Tier)",
      "dataSource": "memory.total",
      "formatter": "count",
      "color": "#c586c0",
      "icon": "codicon-database"
    }
  ],
  "defaultDateRange": "7d",
  "autoRefreshMs": 10000
}
```

---

## 三、重构步骤（分 4 阶段）

### 阶段 1：提取样式层（CSS 变量 + 类系统）

**目标**：将内联样式全部替换为 CSS 类 + 变量

**新建文件**：
- `browser/dashboard/styles/dashboard.css` — 所有 Dashboard CSS 类
- `browser/dashboard/dashboardThemeService.ts` — 主题服务

**修改文件**：
- `agentStudioDashboardEditorPane.ts` — 移除所有 `style.cssText`，改用 `classList`
- `views/agentStudioDashboardView.ts` — 同上

**关键 CSS 结构**：
```css
.agent-studio-dashboard {
  --dash-gap: 16px;
  --dash-panel-radius: 6px;
  --dash-kpi-columns: 5;
  --dash-chart-1: #0078d4;
  --dash-chart-2: #4ec9b0;
  --dash-status-running: #4ec9b0;
  /* ... */
}

.dash-kpi-card { /* ... */ }
.dash-panel { /* ... */ }
.dash-panel-header { /* ... */ }
.dash-skill-bar { /* ... */ }
.dash-session-item { /* ... */ }
.dash-alert-item { /* ... */ }
.dash-donut { /* ... */ }
```

**工作量**：3-4 人天

### 阶段 2：提取布局层（面板配置化）

**目标**：面板定义从代码移到配置，支持面板增删/排序/隐藏

**新建文件**：
- `browser/dashboard/dashboardLayoutService.ts` — 布局服务，加载/解析配置
- `browser/dashboard/dashboardConfig.ts` — 配置接口定义 + 默认配置
- `browser/dashboard/panels/` — 每个面板类型的独立渲染器
  - `KpiGridRenderer.ts`
  - `TokenTrendRenderer.ts`
  - `SkillsUsageRenderer.ts`
  - `AlertsRenderer.ts`
  - `CompressionRenderer.ts`
  - `SessionsRenderer.ts`
  - `MemoryTiersRenderer.ts`
  - `GraphStatsRenderer.ts`
  - `TokenDistributionRenderer.ts`
- `browser/dashboard/dashboardPanelRegistry.ts` — 面板渲染器注册表

**修改文件**：
- `agentStudioDashboardEditorPane.ts` — 改为按布局配置渲染面板，不再硬编码区域

**面板渲染器接口**：
```typescript
interface IDashboardPanelRenderer {
  /** 面板类型 */
  type: string;
  /** 渲染面板内容 */
  render(data: IDashboardMetrics, panelDef: IDashboardPanelDef, container: HTMLElement): void;
  /** 面板是否可用（数据源就绪） */
  isAvailable(data: IDashboardMetrics): boolean;
}
```

**工作量**：5-7 人天

### 阶段 3：数据层重构（指标采集 + 时间过滤）

**目标**：分离数据采集和 UI 准备，支持时间范围过滤

**新建文件**：
- `browser/dashboard/data/dashboardDataCollector.ts` — 替代当前 `agentStudioDashboardService.ts` 的 `_buildData()`
- `browser/dashboard/data/metricsHistory.ts` — 时间序列数据存储（支持 7d/30d 趋势图）

**修改文件**：
- `agentStudioDashboardService.ts` — 简化为数据收集器 + 事件分发器，不再构建 UI 对象（KPI/alerts 等）
- `agentOSService.ts` — 增加时间戳记录到 token 追踪，支持按时间范围过滤

**关键改进**：
- Token 趋势图改用真实历史数据（`metricsHistory` 按天/小时桶存储）
- 日期范围切换实际过滤数据
- KPI 值通过 `dataSource` 路径表达式从 `IDashboardMetrics` 中提取

**工作量**：4-5 人天

### 阶段 4：用户自定义样式 UI

**目标**：提供设置界面让用户自定义 Dashboard

**新建文件**：
- `browser/dashboard/dashboardSettingsEditorPane.ts` — Dashboard 设置编辑器
- `browser/dashboard/dashboardSettingsEditorInput.ts`

**功能**：
- 主题颜色选择器（VS Code 颜色拾取器）
- 面板拖拽排序
- 面板显示/隐藏切换
- KPI 卡片增删/重排
- 布局参数调节（列数、间距、圆角）
- 导入/导出配置 JSON

**修改文件**：
- `agentStudioDashboardEditorPane.ts` — 添加设置按钮到 header

**工作量**：5-7 人天

---

## 四、目录结构

```
src/vs/sessions/contrib/agentStudio/browser/dashboard/
├── styles/
│   ├── dashboard.css              # 主样式
│   └── dashboard-themes.css       # 预设主题
├── data/
│   ├── dashboardDatabase.ts       # SQLite 数据库服务（sql.js）
│   ├── dashboardDataCollector.ts  # 数据采集聚合
│   └── metricsHistory.ts          # 时间序列查询（基于 DB）
├── panels/
│   ├── dashboardPanelRegistry.ts  # 面板注册表
│   ├── KpiGridRenderer.ts         # KPI 卡片网格
│   ├── TokenTrendRenderer.ts      # Token 趋势折线图
│   ├── SkillsUsageRenderer.ts     # Skills 使用条形图
│   ├── AlertsRenderer.ts          # 告警通知
│   ├── CompressionRenderer.ts     # 压缩指标
│   ├── SessionsRenderer.ts        # 会话列表
│   ├── MemoryTiersRenderer.ts     # 记忆 4-Tier
│   ├── GraphStatsRenderer.ts      # 代码图谱统计
│   └── TokenDistributionRenderer.ts # Token 分布甜甜圈
├── dashboardConfig.ts             # 配置接口 + 默认值
├── dashboardLayoutService.ts      # 布局服务（加载/解析/保存配置到 DB）
├── dashboardThemeService.ts       # 主题服务（CSS 变量注入）
└── dashboardSettingsEditorPane.ts # 设置编辑器
```

---

## 五、数据流对比

### 当前数据流
```
AgentOSService → DashboardService._buildData()
  → 硬编码构建 5 个 KPI 对象 (含 label/color/breakdown)
  → 硬编码构建告警列表
  → 硬编码构建 tokenByModel
  → fire onDidChangeData(IDashboardData)
    → EditorPane._render()
      → 按硬编码顺序渲染 6 个区域
      → 每个元素内联 style.cssText
```

### 重构后数据流
```
AgentOSService → DataCollector.collectMetrics()
  → 纯数据: {osStats, sessions, memory, graph} (无 UI 概念)
  → fire onMetricsChanged(IDashboardMetrics)

LayoutService.getRenderData()
  → 读取 dashboard-config.json
  → 按 panels 配置过滤/排序面板
  → 按 kpis 配置从 metrics 提取值
  → 返回 IDashboardRenderData {panels[], kpis[], theme}

ThemeService.applyTheme(theme)
  → 注入 CSS 变量到容器 :root

EditorPane.render(renderData)
  → 遍历 panels[] → 查找对应 PanelRenderer → render()
  → 所有元素用 CSS 类，不用内联样式
```

---

## 六、优先级排序

| 阶段 | 内容 | 工作量 | 优先级 | 价值 |
|------|------|--------|--------|------|
| 1 | 样式层提取 (CSS 变量) | 3-4 天 | P0 | 消除 90% 内联样式，为自定义样式铺路 |
| 2 | 面板配置化 | 5-7 天 | P0 | 面板增删/排序/隐藏 |
| 3 | 数据层重构 | 4-5 天 | P1 | 真实趋势图 + 时间过滤 |
| 4 | 自定义样式 UI | 5-7 天 | P2 | 完整用户自定义能力 |

**总计**：17-23 人天

---

## 七、风险与注意事项

1. **TrustedHTML 限制**：所有 DOM 操作仍需用 `createElement` + `appendChild`，不能用 `innerHTML`
2. **sql.js WASM 加载**：WASM 文件 ~1.2MB，首次加载需 1-2 秒。方案：惰性初始化（首次打开 Dashboard 时才加载），加载后驻留内存
3. **sql.js 全库 flush**：每次保存将整个数据库 `export()` 写入磁盘。数据库增大后 flush 耗时增加。方案：定期 `VACUUM` + 旧数据清理控制文件大小
4. **CSS 文件加载**：VS Code 扩展中 CSS 文件需通过 `import './styles/dashboard.css'` 方式加载（副作用导入）
5. **配置兼容**：`dashboard_config` 表的 `panels`/`kpis`/`theme` 值使用 JSON 存储，版本迁移通过 `migrateConfig()` 在加载时执行
6. **面板渲染器解耦**：每个渲染器应独立可测试，不依赖其他渲染器
7. **性能**：`_render()` 全量重建改为增量更新（仅更新变化的数值），减少 DOM 操作
8. **数据库迁移**：未来 schema 变更通过 `PRAGMA user_version` + 迁移脚本管理
9. **旧数据迁移**：从 `dashboard-stats.json` 迁移到 SQLite：启动时检测旧文件存在 → 读取 → 插入 `cumulative_stats` 表 → 重命名为 `.bak`

---

## 八、数据层持久化方案

### 8.1 当前持久化机制（已实现）

AgentOSService 已实现 `~/.saros/dashboard-stats.json` 持久化：
- **加载**：构造函数中 `_loadDashboardStats()` 异步读取
- **保存**：`_scheduleSave()` 2 秒防抖，5 个埋点触发（token/compression/tools/L1/L2/L3）
- **退出**：dispose 回调中立即保存

**局限性**：
- 只存累计值，无时间序列（无法画趋势图）
- 无按天/小时桶（日期范围切换无效果）
- 无自定义面板数据存储

### 8.2 重构后持久化架构

所有 Dashboard 数据存储在 SQLite 数据库中，路径 `~/.saros/dashboard/`：

```
~/.saros/dashboard/
└── dashboard.db              # 单一 SQLite 数据库文件，包含所有 Dashboard 数据
```

**技术选型**：`sql.js`（SQLite WASM 编译），纯 JavaScript，无 native 依赖，可在 renderer 进程中运行。

```typescript
import initSqlJs from 'sql.js';

// 初始化（WASM 文件从 CDN 或本地加载）
const SQL = await initSqlJs({ locateFile: file => `https://sql.js.org/dist/${file}` });
const db = new SQL.Database(); // 空数据库，或从 Uint8Array 加载
```

**数据库 Schema**：

```sql
-- 累计统计表（替代 dashboard-stats.json）
CREATE TABLE IF NOT EXISTS cumulative_stats (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 时间序列快照表（替代 dashboard-snapshots.jsonl）
CREATE TABLE IF NOT EXISTS metrics_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,           -- ISO 8601 时间戳
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  compression_count INTEGER DEFAULT 0,
  memory_total INTEGER DEFAULT 0,
  graph_nodes INTEGER DEFAULT 0,
  session_count INTEGER DEFAULT 0,
  active_model TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON metrics_snapshots(ts);

-- 工具调用计数表（替代 toolCallCounts Map 序列化）
CREATE TABLE IF NOT EXISTS tool_call_stats (
  tool_name TEXT PRIMARY KEY,
  call_count INTEGER DEFAULT 0,
  last_called TEXT
);

-- 布局配置表（替代 dashboard-config.json）
CREATE TABLE IF NOT EXISTS dashboard_config (
  key   TEXT PRIMARY KEY,   -- 'panels' | 'kpis' | 'theme' | 'settings'
  value TEXT NOT NULL,       -- JSON 字符串
  updated_at TEXT NOT NULL
);

-- 自定义面板数据表（替代 dashboard-custom-data.json）
CREATE TABLE IF NOT EXISTS custom_panel_data (
  panel_id TEXT PRIMARY KEY,
  source_id TEXT,
  data TEXT NOT NULL,        -- JSON 字符串
  last_updated TEXT NOT NULL
);

-- 数据源注册表
CREATE TABLE IF NOT EXISTS custom_data_sources (
  source_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  interval_ms INTEGER DEFAULT 0,
  last_collected TEXT
);
```

**DashboardDatabaseService 实现**：

```typescript
import initSqlJs, { Database } from 'sql.js';
import { VSBuffer } from 'vs/base/common/buffer';

const DB_PATH = '~/.saros/dashboard/dashboard.db';
const SCHEMA_VERSION = 1;

class DashboardDatabaseService extends Disposable {
  private _db: Database | undefined;
  private _fileUri: URI;
  private _saveTimer: ReturnType<typeof setTimeout> | undefined;
  private _dirty = false;

  constructor(
    @IFileService private readonly _fileService: IFileService,
    @IPathService private readonly _pathService: IPathService,
    @ILogService private readonly _logService: ILogService,
  ) {
    super();
  }

  // ─── 初始化 ─────────────────────────────────────────────

  async init(): Promise<void> {
    const userHome = await this._pathService.userHome();
    const dirUri = URI.joinPath(userHome, '.saros', 'dashboard');
    this._fileUri = URI.joinPath(dirUri, 'dashboard.db');

    // 确保目录存在
    try { await this._fileService.createFolder(dirUri); } catch { /* exists */ }

    // 加载 sql.js WASM
    const SQL = await initSqlJs({ locateFile: f => `https://sql.js.org/dist/${f}` });

    // 尝试从文件加载已有数据库
    try {
      const content = await this._fileService.readFile(this._fileUri);
      const data = new Uint8Array(content.value.buffer);
      this._db = new SQL.Database(data);
      this._logService.info('[DashboardDB] Database loaded from disk');
    } catch {
      // 文件不存在 → 创建新数据库
      this._db = new SQL.Database();
      this._createSchema();
      this._logService.info('[DashboardDB] New database created');
    }

    // 确保 schema 存在（兼容旧文件）
    this._createSchema();

    // 退出时保存
    this._register({
      dispose: () => {
        if (this._saveTimer) { clearTimeout(this._saveTimer); }
        this._flushToDisk().catch(() => {});
      },
    });
  }

  // ─── Schema 创建 ────────────────────────────────────────

  private _createSchema(): void {
    if (!this._db) { return; }
    this._db.run(`
      CREATE TABLE IF NOT EXISTS cumulative_stats (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metrics_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cached_tokens INTEGER DEFAULT 0,
        compression_count INTEGER DEFAULT 0,
        memory_total INTEGER DEFAULT 0,
        graph_nodes INTEGER DEFAULT 0,
        session_count INTEGER DEFAULT 0,
        active_model TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON metrics_snapshots(ts);
      CREATE TABLE IF NOT EXISTS tool_call_stats (
        tool_name TEXT PRIMARY KEY,
        call_count INTEGER DEFAULT 0,
        last_called TEXT
      );
      CREATE TABLE IF NOT EXISTS dashboard_config (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS custom_panel_data (
        panel_id TEXT PRIMARY KEY,
        source_id TEXT,
        data TEXT NOT NULL,
        last_updated TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS custom_data_sources (
        source_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        interval_ms INTEGER DEFAULT 0,
        last_collected TEXT
      );
    `);
  }

  // ─── 累计统计 CRUD ──────────────────────────────────────

  getStat(key: string): string | null {
    const result = this._db?.exec('SELECT value FROM cumulative_stats WHERE key = ?', [key]);
    return result && result.length > 0 ? result[0].values[0][0] as string : null;
  }

  setStat(key: string, value: string): void {
    this._db?.run(
      'INSERT OR REPLACE INTO cumulative_stats (key, value, updated_at) VALUES (?, ?, ?)',
      [key, value, new Date().toISOString()]
    );
    this._scheduleFlush();
  }

  getAllStats(): Record<string, string> {
    const result = this._db?.exec('SELECT key, value FROM cumulative_stats');
    const stats: Record<string, string> = {};
    if (result && result.length > 0) {
      for (const row of result[0].values) {
        stats[row[0] as string] = row[1] as string;
      }
    }
    return stats;
  }

  // ─── 时间序列快照 ────────────────────────────────────────

  insertSnapshot(snap: IMetricsSnapshot): void {
    this._db?.run(
      `INSERT INTO metrics_snapshots
       (ts, input_tokens, output_tokens, cached_tokens, compression_count,
        memory_total, graph_nodes, session_count, active_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [snap.ts, snap.inputTokens, snap.outputTokens, snap.cachedTokens,
       snap.compressionCount, snap.memoryTotal, snap.graphNodes,
       snap.sessionCount, snap.activeModel ?? '']
    );
    this._scheduleFlush();
  }

  querySnapshots(rangeMs: number): IMetricsSnapshot[] {
    const cutoff = new Date(Date.now() - rangeMs).toISOString();
    const result = this._db?.exec(
      'SELECT * FROM metrics_snapshots WHERE ts > ? ORDER BY ts ASC',
      [cutoff]
    );
    if (!result || result.length === 0) { return []; }
    const cols = result[0].columns;
    return result[0].values.map(row => {
      const obj: any = {};
      cols.forEach((c, i) => { obj[c] = row[i]; });
      return obj as IMetricsSnapshot;
    });
  }

  // 清理超过 90 天的快照
  cleanupOldSnapshots(): void {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    this._db?.run('DELETE FROM metrics_snapshots WHERE ts < ?', [cutoff]);
    this._scheduleFlush();
  }

  // 按天聚合（趋势图降采样）
  dailyBuckets(rangeMs: number): IDailyBucket[] {
    const cutoff = new Date(Date.now() - rangeMs).toISOString();
    const result = this._db?.exec(
      `SELECT DATE(ts) as day,
              MAX(input_tokens) as input_tokens,
              MAX(output_tokens) as output_tokens,
              MAX(cached_tokens) as cached_tokens,
              MAX(compression_count) as compression_count,
              MAX(memory_total) as memory_total,
              MAX(graph_nodes) as graph_nodes,
              MAX(session_count) as session_count
       FROM metrics_snapshots
       WHERE ts > ?
       GROUP BY DATE(ts)
       ORDER BY day ASC`,
      [cutoff]
    );
    if (!result || result.length === 0) { return []; }
    const cols = result[0].columns;
    return result[0].values.map(row => {
      const obj: any = {};
      cols.forEach((c, i) => { obj[c] = row[i]; });
      return obj as IDailyBucket;
    });
  }

  // ─── 工具调用统计 ────────────────────────────────────────

  getToolCallCounts(): Map<string, number> {
    const result = this._db?.exec('SELECT tool_name, call_count FROM tool_call_stats');
    const map = new Map<string, number>();
    if (result && result.length > 0) {
      for (const row of result[0].values) {
        map.set(row[0] as string, row[1] as number);
      }
    }
    return map;
  }

  incrementToolCall(toolName: string): void {
    this._db?.run(
      `INSERT INTO tool_call_stats (tool_name, call_count, last_called)
       VALUES (?, 1, ?)
       ON CONFLICT(tool_name)
       DO UPDATE SET call_count = call_count + 1, last_called = ?`,
      [toolName, new Date().toISOString(), new Date().toISOString()]
    );
    this._scheduleFlush();
  }

  // ─── 配置 CRUD ───────────────────────────────────────────

  getConfig(key: string): unknown | null {
    const result = this._db?.exec(
      'SELECT value FROM dashboard_config WHERE key = ?', [key]
    );
    if (!result || result.length === 0) { return null; }
    try { return JSON.parse(result[0].values[0][0] as string); }
    catch { return null; }
  }

  setConfig(key: string, value: unknown): void {
    this._db?.run(
      'INSERT OR REPLACE INTO dashboard_config (key, value, updated_at) VALUES (?, ?, ?)',
      [key, JSON.stringify(value), new Date().toISOString()]
    );
    this._scheduleFlush();
  }

  // ─── 自定义面板数据 ──────────────────────────────────────

  getCustomData(panelId: string): Record<string, unknown> | null {
    const result = this._db?.exec(
      'SELECT data FROM custom_panel_data WHERE panel_id = ?', [panelId]
    );
    if (!result || result.length === 0) { return null; }
    try { return JSON.parse(result[0].values[0][0] as string); }
    catch { return null; }
  }

  setCustomData(panelId: string, sourceId: string, data: Record<string, unknown>): void {
    this._db?.run(
      `INSERT OR REPLACE INTO custom_panel_data (panel_id, source_id, data, last_updated)
       VALUES (?, ?, ?, ?)`,
      [panelId, sourceId, JSON.stringify(data), new Date().toISOString()]
    );
    this._scheduleFlush();
  }

  // ─── 持久化到磁盘 ────────────────────────────────────────

  private _scheduleFlush(): void {
    this._dirty = true;
    if (this._saveTimer) { clearTimeout(this._saveTimer); }
    this._saveTimer = setTimeout(() => {
      this._flushToDisk().catch(err => {
        this._logService.warn('[DashboardDB] Flush failed:', err);
      });
    }, 2000); // 2 秒防抖
  }

  private async _flushToDisk(): Promise<void> {
    if (!this._db || !this._dirty) { return; }
    const data = this._db.export(); // Uint8Array
    await this._fileService.writeFile(this._fileUri, VSBuffer.wrap(data));
    this._dirty = false;
  }
}
```

### sql.js 集成说明

**依赖**：`sql.js`（~1.2MB WASM），npm 安装：
```bash
npm install sql.js
```

**WASM 加载**：
- 开发环境：从 `node_modules/sql.js/dist/` 加载本地文件
- 生产环境：将 `sql-wasm.wasm` 打包到 `extensions/tdb-am-memory/` 中随安装包分发

```typescript
// 开发环境加载
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';

const SQL = await initSqlJs({ locateFile: () => wasmUrl });
```

**替代方案（若 sql.js 不适用）**：
- 渲染进程通过 IPC 委托主进程操作 `better-sqlite3`（需修改 `app.ts`）
- 使用 `absurd-sql`（IndexedDB 后端的 SQLite）

### 8.3 时间序列持久化（`dashboard-snapshots.jsonl`）

**目的**：支持趋势图、日期范围过滤、历史对比

**格式**：JSONL（JSON Lines），每行一条快照，追加写入避免全量重写

```jsonl
{"ts":"2026-07-01T10:00:00Z","inputTokens":521000,"outputTokens":123000,"cachedTokens":203000,"compressionCount":28,"memoryTotal":1284,"graphNodes":16338,"sessionCount":5}
{"ts":"2026-07-01T11:00:00Z","inputTokens":687000,"outputTokens":156000,"cachedTokens":245000,"compressionCount":31,"memoryTotal":1302,"graphNodes":16338,"sessionCount":6}
{"ts":"2026-07-01T12:00:00Z","inputTokens":847000,"outputTokens":178000,"cachedTokens":267000,"compressionCount":35,"memoryTotal":1356,"graphNodes":16338,"sessionCount":7}
```

**采集策略**：

```typescript
interface IMetricsSnapshot {
  /** 快照时间戳（ISO 8601） */
  ts: string;
  /** 累计输入 Token */
  inputTokens: number;
  /** 累计输出 Token */
  outputTokens: number;
  /** 累计缓存 Token */
  cachedTokens: number;
  /** 压缩总次数 */
  compressionCount: number;
  /** 记忆总条数 */
  memoryTotal: number;
  /** 代码图谱节点数 */
  graphNodes: number;
  /** 活跃会话数 */
  sessionCount: number;
}
```

**写入时机**：
- 每 5 分钟定时采集一次（`setInterval`）
- 每次 `executeAgentTurn` 完成后
- IDE 退出时（dispose）
- 控制台命令 `agentStudio.dashboard.snapshot` 手动触发

**清理策略**：
- 保留最近 90 天的数据
- 超过 90 天的行在加载时过滤
- 文件超过 1MB 时触发压缩（按天聚合，保留每天最后一个快照）

**MetricsHistoryService 实现**：

```typescript
class MetricsHistoryService {
  private _snapshots: IMetricsSnapshot[] = [];
  private _filePath: URI;
  private _flushTimer: ReturnType<typeof setTimeout> | undefined;
  private _pendingAppend = '';

  // 加载历史数据（启动时）
  async load(): Promise<void> {
    const content = await this._fileService.readFile(this._filePath);
    const lines = content.value.toString().split('\n').filter(Boolean);
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000; // 90 天前
    this._snapshots = lines
      .map(line => JSON.parse(line) as IMetricsSnapshot)
      .filter(s => new Date(s.ts).getTime() > cutoff);
  }

  // 采集快照（定时 + 事件触发）
  async snapshot(metrics: IDashboardMetrics): Promise<void> {
    const snap: IMetricsSnapshot = {
      ts: new Date().toISOString(),
      inputTokens: metrics.osStats.totalInputTokens,
      outputTokens: metrics.osStats.totalOutputTokens,
      cachedTokens: metrics.osStats.totalCachedTokens,
      compressionCount: metrics.osStats.compressionCount,
      memoryTotal: metrics.memory.total,
      graphNodes: metrics.graph.nodes,
      sessionCount: metrics.sessions.length,
    };
    this._snapshots.push(snap);
    this._pendingAppend += JSON.stringify(snap) + '\n';
    this._scheduleFlush();
  }

  // 查询时间范围数据（趋势图用）
  queryRange(range: 'today' | '7d' | '30d' | 'all'): IMetricsSnapshot[] {
    const now = Date.now();
    const cutoffMs = range === 'today' ? 24*60*60*1000
                   : range === '7d' ? 7*24*60*60*1000
                   : range === '30d' ? 30*24*60*60*1000
                   : Infinity;
    const cutoff = now - cutoffMs;
    return this._snapshots.filter(s => new Date(s.ts).getTime() > cutoff);
  }

  // 按天聚合（趋势图降采样）
  dailyBuckets(range: 'today' | '7d' | '30d' | 'all'): IDailyBucket[] {
    const snaps = this.queryRange(range);
    const buckets = new Map<string, IMetricsSnapshot[]>();
    for (const s of snaps) {
      const day = s.ts.slice(0, 10); // YYYY-MM-DD
      if (!buckets.has(day)) { buckets.set(day, []); }
      buckets.get(day)!.push(s);
    }
    // 每天取最后一个快照（最终值）
    return Array.from(buckets.entries()).map(([day, snaps]) => ({
      day, ...snaps[snaps.length - 1],
    }));
  }

  // 防抖写入（追加模式，不全量重写）
  private _scheduleFlush(): void {
    if (this._flushTimer) { clearTimeout(this._flushTimer); }
    this._flushTimer = setTimeout(() => {
      const data = this._pendingAppend;
      this._pendingAppend = '';
      this._fileService.writeFile(
        this._filePath,
        VSBuffer.fromString(data),
        { atomic: false } // 追加模式
      ).catch(() => {});
    }, 5000); // 5 秒防抖
  }
}
```

### 8.4 累计统计持久化（`dashboard-stats.json`，保留现有）

**当前格式**（已实现，保持兼容）：
```json
{
  "totalInputTokens": 847000,
  "totalOutputTokens": 178000,
  "totalCachedTokens": 267000,
  "compressionCount": 35,
  "compressionIneffectiveCount": 3,
  "compressionBeforeTokens": 2240000,
  "compressionAfterTokens": 828000,
  "l1ExtractionCount": 12,
  "l2ExtractionCount": 3,
  "l3ExtractionCount": 1,
  "toolCallCounts": { "read_file": 231, "edit_file": 178 },
  "savedAt": "2026-07-01T10:00:00Z"
}
```

**改动**：无，保留现有 `AgentOSService._saveDashboardStats()` 机制。

### 8.5 配置文件持久化（`dashboard-config.json`）

**用途**：用户自定义的 Dashboard 布局/主题/KPI 配置

**加载策略**：

```typescript
class DashboardLayoutService {
  private _config: IDashboardLayoutConfig;
  private _configPath: URI;
  private _watcher: IDisposable | undefined;

  constructor() {
    this._config = DEFAULT_DASHBOARD_CONFIG; // 代码内置默认值
  }

  async load(): Promise<void> {
    try {
      const content = await this._fileService.readFile(this._configPath);
      const userConfig = JSON.parse(content.value.toString());
      // 深度合并：用户配置覆盖默认值，但缺失字段用默认值补全
      this._config = this._mergeConfig(DEFAULT_DASHBOARD_CONFIG, userConfig);
      this._logService.info('[Dashboard] Config loaded:', {
        panels: this._config.panels.length,
        kpis: this._config.kpis.length,
        theme: this._config.theme.layout.kpiColumns + ' columns',
      });
    } catch {
      // 文件不存在 → 用默认配置，并写入默认配置文件
      this._config = DEFAULT_DASHBOARD_CONFIG;
      await this._saveDefault();
    }
    // 监听文件变化（用户外部编辑配置文件时热重载）
    this._watcher = this._fileService.watch(this._configPath);
    this._watcher.onDidChange(() => this.load());
  }

  async save(config: IDashboardLayoutConfig): Promise<void> {
    this._config = config;
    await this._fileService.writeFile(
      this._configPath,
      VSBuffer.fromString(JSON.stringify(config, null, 2)),
    );
    this._onDidChangeConfig.fire(config);
  }

  // 深度合并配置（用户值覆盖默认值，嵌套对象递归合并）
  private _mergeConfig(defaults: any, user: any): any {
    if (typeof defaults !== 'object' || defaults === null) { return user ?? defaults; }
    if (Array.isArray(defaults)) { return user ?? defaults; }
    const result = { ...defaults };
    for (const key of Object.keys(user)) {
      if (typeof defaults[key] === 'object' && typeof user[key] === 'object') {
        result[key] = this._mergeConfig(defaults[key], user[key]);
      } else {
        result[key] = user[key];
      }
    }
    return result;
  }
}
```

**配置文件版本兼容**：

```typescript
// 配置迁移
function migrateConfig(raw: unknown): IDashboardLayoutConfig {
  const config = raw as any;
  if (!config.version || config.version < '1.0') {
    // v0 → v1: 添加默认面板
    config.panels = DEFAULT_DASHBOARD_CONFIG.panels;
    config.kpis = DEFAULT_DASHBOARD_CONFIG.kpis;
  }
  if (config.version < '1.1') {
    // v1.0 → v1.1: 新增字段
    config.theme.colors.kpiColors = config.theme.colors.kpiColors ?? DEFAULT_THEME.colors.kpiColors;
  }
  config.version = CURRENT_CONFIG_VERSION;
  return config;
}
```

---

## 九、自定义 Dashboard 数据存储方案

### 9.1 自定义面板数据存储（`dashboard-custom-data.json`）

**用途**：用户自定义面板可能需要额外数据源（如自定义统计、外部 API 结果）

**格式**：
```json
{
  "version": "1.0",
  "panels": {
    "my-custom-counter": {
      "type": "custom",
      "data": {
        "label": "今日提交数",
        "value": 12,
        "target": 20,
        "unit": "次",
        "color": "#4ec9b0"
      },
      "lastUpdated": "2026-07-01T10:00:00Z"
    },
    "my-api-metrics": {
      "type": "custom",
      "data": {
        "label": "API QPS",
        "value": 342,
        "unit": "req/s",
        "history": [300, 310, 325, 340, 342]
      },
      "lastUpdated": "2026-07-01T10:00:00Z"
    }
  }
}
```

### 9.2 自定义面板渲染器

```typescript
// 自定义面板渲染器 — 支持用户注册
class CustomPanelRenderer implements IDashboardPanelRenderer {
  readonly type = 'custom';

  render(data: IDashboardMetrics, panelDef: IDashboardPanelDef, container: HTMLElement): void {
    const customData = (panelDef.config?.['customData']) as Record<string, unknown> | undefined;
    if (!customData) {
      container.appendChild(this._el('div', 'dash-empty', '未配置自定义数据'));
      return;
    }

    const label = customData['label'] as string ?? panelDef.title;
    const value = customData['value'] as number ?? 0;
    const unit = customData['unit'] as string ?? '';
    const color = customData['color'] as string ?? 'var(--vscode-button-background)';

    const card = this._el('div', 'dash-custom-card');
    // ... 渲染自定义卡片
    container.appendChild(card);
  }

  isAvailable(data: IDashboardMetrics): boolean {
    return true; // 自定义面板始终可用
  }

  private _el(tag: string, className: string, text?: string): HTMLElement {
    const e = document.createElement(tag);
    e.className = className;
    if (text) { e.textContent = text; }
    return e;
  }
}
```

### 9.3 自定义数据源注册 API

```typescript
// 扩展或其他模块可通过 API 注册自定义数据源
interface ICustomDataSource {
  /** 唯一 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** 采集数据（异步） */
  collect(): Promise<Record<string, unknown>>;
  /** 采集间隔（毫秒，0=手动） */
  interval?: number;
}

// DashboardService 暴露的注册 API
interface IAgentStudioDashboardService {
  // ... 现有方法

  /** 注册自定义数据源 */
  registerCustomDataSource(source: ICustomDataSource): IDisposable;

  /** 获取自定义数据 */
  getCustomData(sourceId: string): Record<string, unknown> | undefined;
}
```

### 9.4 自定义面板配置示例

用户在 `dashboard-config.json` 中添加自定义面板：

```json
{
  "panels": [
    // ... 内置面板 ...
    {
      "id": "git-commits-today",
      "type": "custom",
      "title": "今日提交",
      "region": "bottom-left",
      "visible": true,
      "order": 3,
      "dataSource": "custom:git-commits",
      "config": {
        "customData": {
          "label": "今日提交数",
          "unit": "次",
          "color": "#4ec9b0",
          "showTrend": true
        }
      }
    }
  ]
}
```

扩展注册数据源：

```typescript
// 在扩展 activate 中注册
dashboardService.registerCustomDataSource({
  id: 'git-commits',
  name: 'Git Commits Today',
  interval: 60_000, // 每分钟采集一次
  async collect(): Promise<Record<string, unknown>> {
    const count = await countCommitsToday();
    return { label: '今日提交数', value: count, unit: '次', color: '#4ec9b0' };
  },
});
```

---

## 十、完整存储架构总结

```
~/.saros/dashboard/
│
└── dashboard.db              # [SQLite 数据库] 所有 Dashboard 数据
    │
    ├── cumulative_stats       # 累计统计表
    │   ├── 读写时机: 防抖保存(2s) + dispose
    │   ├── Key-Value 格式: key=totalInputTokens, value="847000"
    │   └── 数据: totalInputTokens, compressionCount, l1ExtractionCount, ...
    │
    ├── metrics_snapshots      # 时间序列快照表
    │   ├── 读写时机: 定时(5min) + 事件触发 + dispose
    │   ├── 格式: 每行一条快照 (ts, input_tokens, output_tokens, ...)
    │   ├── 索引: idx_snapshots_ts (按时间查询)
    │   ├── 保留: 90 天 (cleanupOldSnapshots 定期清理)
    │   └── 用途: 趋势图、日期范围过滤、dailyBuckets 降采样
    │
    ├── tool_call_stats        # 工具调用统计表
    │   ├── 读写时机: incrementToolCall() 实时 + 防抖保存
    │   ├── 格式: tool_name=PRIMARY KEY, call_count, last_called
    │   └── UPSERT: INSERT ON CONFLICT DO UPDATE
    │
    ├── dashboard_config       # 布局配置表
    │   ├── 读写时机: 启动加载 + 文件监听热重载 + 设置编辑器保存
    │   ├── Key-Value 格式: key='panels'|'kpis'|'theme'|'settings', value=JSON
    │   └── 合并: 深度合并默认值 + 用户值
    │
    ├── custom_panel_data      # 自定义面板数据表
    │   ├── 读写时机: 数据源采集时保存
    │   ├── 格式: panel_id=PRIMARY KEY, source_id, data(JSON), last_updated
    │   └── 用途: 自定义面板的数据持久化
    │
    └── custom_data_sources    # 数据源注册表
        ├── 格式: source_id=PRIMARY KEY, name, interval_ms, last_collected
        └── 用途: 追踪已注册的自定义数据源
```

### 各表性能特征

| 表 | 行数估算 | 写入频率 | IO 模式 |
|------|---------|---------|---------|
| `cumulative_stats` | ~15 行 | 2s 防抖 | UPSERT + 全库 flush |
| `metrics_snapshots` | ~12K/年 | 5min 定时 | INSERT（追加行） |
| `tool_call_stats` | ~20 行 | 实时 | UPSERT + 防抖 |
| `dashboard_config` | ~4 行 | 用户手动 | UPSERT + flush |
| `custom_panel_data` | ~10 行 | 数据源采集 | UPSERT + 防抖 |
| `custom_data_sources` | ~5 行 | 注册时 | INSERT/UPDATE |

**全库 flush**：sql.js 是内存数据库，`_flushToDisk()` 将整个数据库 `export()` 为 `Uint8Array` 写入 `dashboard.db` 文件。2 秒防抖确保不频繁 IO。

**WASM 加载**：`sql.js` WASM 文件 (~1.2MB) 仅在首次打开 Dashboard 时加载一次，之后驻留内存。

### 数据一致性策略

1. **加载顺序**：`DashboardDatabaseService.init()` → 打开/创建 `~/.saros/dashboard/dashboard.db` → `_createSchema()` 确保表存在
2. **原子写入**：`_flushToDisk()` 先写 `.tmp` 文件再 rename（需在 fileService 中实现原子重命名）
3. **容错**：数据库文件损坏时 → 备份 `dashboard.db.corrupt` → 创建新数据库
4. **防数据丢失**：sql.js 是内存数据库，每次 `_scheduleFlush()` 将全库 `export()` 写入磁盘。2 秒防抖确保即使 IDE 崩溃也只丢失最后 2 秒的内存变更
5. **事务**：多表操作使用 `db.run('BEGIN; ...; COMMIT;')` 确保原子性

### 配置热重载

```typescript
// 监听 dashboard.db 文件变化（用户外部操作数据库时）
this._register(this._fileService.watch(this._fileUri));
this._register(this._fileService.onDidFilesChange(e => {
  if (e.affects(this._fileUri)) {
    this._reloadFromDisk().catch(err => {
      this._logService.warn('[DashboardDB] Hot-reload failed:', err);
    });
  }
}));
```

### 6. **性能优化**：
- 快照表按时间范围查询使用 `idx_snapshots_ts` 索引
- `dailyBuckets` 使用 SQL `GROUP BY DATE(ts)` 在数据库层完成聚合
- 旧数据清理用 `DELETE FROM metrics_snapshots WHERE ts < ?` + `VACUUM`

---

## 十一、优先级更新

| 阶段 | 内容 | 工作量 | 优先级 | 新增内容 |
|------|------|--------|--------|---------|
| 1 | 样式层提取 | 3-4 天 | P0 | 不变 |
| 2 | 面板配置化 + 配置持久化 | 6-8 天 | P0 | **+ dashboard-config.json 加载/保存/热重载/迁移** |
| 3 | 数据层重构 + 时间序列持久化 | 6-8 天 | P1 | **+ dashboard-snapshots.jsonl 采集/查询/清理 + 趋势图真实数据** |
| 4 | 自定义样式 UI + 自定义数据源 API | 7-9 天 | P2 | **+ 自定义数据源注册 API + dashboard-custom-data.json** |

**总计**：22-29 人天（原 17-23 人天，增加持久化和自定义数据源）
