# Browser-Use 项目架构分析

> 版本：0.12.6 | Python >=3.11 | MIT License
>
> 生成日期：2026-05-18

---

## 1. 项目概述

**Browser-Use** 是一个 AI 浏览器自动化库，使 LLM 驱动的 Agent 能够自主浏览网页、与页面元素交互并完成复杂任务。其核心架构通过 CDP（Chrome DevTools Protocol）直接控制 Chromium 浏览器，结合 DOM 处理和 LLM 推理实现闭环自动化。

**核心能力：**
- LLM 驱动的自主浏览器操作
- 多 LLM 提供商支持（OpenAI、Anthropic、Google、Groq、Ollama 等 16+）
- 基于 CDP 的细粒度浏览器控制（非 Playwright 封装）
- 三树合并的 DOM 增强（DOM + Accessibility + Snapshot）
- 事件驱动的 Watchdog 浏览器管理
- MCP 双模式集成（Server / Client）
- 自定义工具扩展、敏感数据保护、循环检测、消息压缩
- CLI / TUI / Sandbox 多种运行模式

---

## 2. 项目结构

```
browser-use/
├── browser_use/                  # 核心库
│   ├── agent/                    # Agent 核心（编排、提示、状态管理）
│   ├── browser/                  # 浏览器会话管理（CDP、Watchdog、Profile）
│   ├── actor/                    # 底层 CDP 操作（Page、Element、Mouse）
│   ├── dom/                      # DOM 增强处理（三树合并、序列化、可见性）
│   ├── tools/                    # 动作注册表与工具系统
│   ├── llm/                      # LLM 抽象层（16+ 提供商）
│   ├── mcp/                      # MCP 集成（Server/Client/Controller）
│   ├── controller/               # 向后兼容别名（已合并到 Tools）
│   ├── integrations/             # 外部集成（Gmail）
│   ├── sandbox/                  # 远程沙箱执行
│   ├── skills/                   # 预构建技能服务
│   ├── telemetry/                # 匿名遥测（PostHog）
│   ├── tokens/                   # Token 成本追踪
│   ├── filesystem/               # Agent 文件系统抽象
│   ├── screenshots/              # 截图存储服务
│   ├── sync/                     # 云端事件同步
│   └── skill_cli/                # CLI 工具集
├── examples/                     # 示例代码（11 个分类）
├── tests/                        # 测试套件
├── skills/                       # Skill 定义文件（Markdown）
├── docker/                       # Docker 配置
├── static/                       # 静态资源
├── pyproject.toml                # 项目配置
└── README.md
```

---

## 3. 核心架构

### 3.1 整体数据流

```
用户任务 ──→ Agent.run()
               │
               ├─→ 准备上下文（BrowserState + DOMState + 截图）
               │
               ├─→ LLM 推理 → AgentOutput（思考/评估/计划/动作）
               │
               ├─→ 执行动作列表（Tools/Registry 分发）
               │         │
               │         └─→ BrowserSession（EventBus → Watchdog）
               │                   │
               │                   └─→ CDP 命令 → Chromium
               │
               ├─→ 后处理（历史记录、Judge 评估、截图存储、消息压缩）
               │
               └─→ 循环直到完成或达到 max_steps
```

### 3.2 Agent 模块

**文件：** `browser_use/agent/`

#### Agent 类 (`service.py`)

泛型设计 `Agent[Context, AgentStructuredOutput]`，是系统的核心编排器。

**主循环 (`run` 方法)：**
1. 初始化信号处理器（Ctrl+C 暂停/恢复/强制退出）
2. 发出 `CreateAgentSessionEvent` / `CreateAgentTaskEvent`
3. 启动 `BrowserSession` 并注册 Watchdog
4. 执行初始动作（如自动从任务中提取 URL 导航）
5. 进入 `while n_steps <= max_steps` 循环

**单步执行 (`step` 方法) 三阶段：**

| 阶段 | 方法 | 职责 |
|------|------|------|
| Phase 1 | `_prepare_context()` | 获取浏览器状态（含截图）、更新动作模型、构建消息上下文、检测循环 |
| Phase 2 | `_get_next_action()` + `_execute_actions()` | LLM 推理 → 执行动作列表 |
| Phase 3 | `_post_process()` | 记录历史、Judge 评估、存储截图、消息压缩 |

**AgentState 状态管理：**
```python
class AgentState:
    n_steps: int
    consecutive_failures: int
    paused: bool
    stopped: bool
    last_result: list[ActionResult] | None
    last_model_output: AgentOutput | None
    plan: str | None
    loop_detector: ActionLoopDetector
    message_manager_state: MessageManagerState
```

**LLM 输出结构 (`AgentOutput`)：**
```python
class AgentOutput:
    thinking: str                    # 思考过程
    evaluation_previous_goal: str    # 评估上一步
    memory: str                      # 跨步记忆
    next_goal: str                   # 下一步目标
    plan_update: str | None          # 计划更新
    current_plan_item: str | None    # 当前计划项
    action: list[ActionModel]        # 动作列表（支持每步多个）
```

**三种输出模式：**
- **标准模式**：完整 thinking/evaluation/next_goal
- **Flash 模式**：仅 memory + action（适用于 browser-use 微调模型，跳过评估和思考）
- **No-thinking 模式**：去掉 thinking 字段

#### 关键子系统

**循环检测 (`ActionLoopDetector`)：**
- 基于动作哈希的滑动窗口
- 检测重复动作和页面停滞
- 渐进式提醒：5/8/12 次重复时 escalating nudge

**消息压缩 (`MessageCompactionSettings`)：**
- 对话过长时，用 LLM 摘要旧历史
- 减少上下文 token 消耗

**Judge 系统：**
- 任务完成后用独立 LLM 判断执行轨迹
- 输出 `JudgementResult`（verdict、failure_reason、impossible_task 等）

**敏感数据保护：**
- 支持 `<secret>placeholder</secret>` 标签
- 执行时替换为真实值
- 支持 TOTP 2FA 代码生成

**Prompt 系统 (`prompts.py`)：**
- `SystemPrompt` — 根据模型类型选择不同系统提示模板
- `AgentMessagePrompt` — 构建用户消息（浏览器状态、文件系统、步骤信息、计划、敏感数据）
- 支持视觉模式（附带截图）

---

### 3.3 Browser 模块

**文件：** `browser_use/browser/`

#### BrowserSession (`session.py`)

事件驱动的浏览器会话管理器，两层架构：
- **高层**：EventBus 事件处理（供 Agent/Tools 使用）
- **底层**：直接 CDP 调用（通过 cdp_use 库）

**核心组件：**
- `bubus.EventBus` — 事件总线
- `cdp_use.CDPClient` — CDP 通信
- 支持本地浏览器和云端浏览器

#### EventBus 事件体系 (`events.py`)

| 事件类别 | 事件 |
|----------|------|
| 高层动作 | `NavigateToUrlEvent`, `ClickElementEvent`, `TypeTextEvent`, `ScrollEvent`, `SwitchTabEvent`, `CloseTabEvent` |
| 生命周期 | `BrowserStartEvent`, `BrowserStopEvent`, `BrowserConnectedEvent`, `BrowserStoppedEvent` |
| 导航 | `NavigationStartedEvent`, `NavigationCompleteEvent` |
| 下载 | `DownloadStartedEvent`, `DownloadProgressEvent`, `FileDownloadedEvent` |
| 存储 | `SaveStorageStateEvent`, `LoadStorageStateEvent` |
| CAPTCHA | `CaptchaSolverStartedEvent`, `CaptchaSolverFinishedEvent` |

每个事件都有可配置的超时时间（支持环境变量覆盖）。

#### Watchdog 系统

Watchdog 是事件驱动的监控组件，自动注册 `on_EventTypeName` 方法作为事件处理器。

| Watchdog | 文件大小 | 职责 |
|----------|----------|------|
| `DefaultActionWatchdog` | 132KB | 核心动作处理：点击、输入、滚动、导航等 |
| `DownloadsWatchdog` | 53KB | 文件下载管理，PDF 自动下载 |
| `DomWatchdog` | 35KB | DOM 状态变更检测和通知 |
| `LocalBrowserWatchdog` | 19KB | 本地浏览器进程管理 |
| `CrashWatchdog` | 13KB | 浏览器崩溃检测和恢复 |
| `AboutblankWatchdog` | 9KB | about:blank 页面管理 |
| `CaptchaWatchdog` | 7KB | CAPTCHA 检测和等待 |
| `SecurityWatchdog` | 9KB | 安全策略（域过滤、IP 阻断） |
| `PermissionsWatchdog` | - | 浏览器权限管理 |
| `PopupsWatchdog` | 6KB | 弹窗和 JS 对话框处理 |
| `RecordingWatchdog` | 8KB | HAR 录制 |
| `ScreenshotWatchdog` | 3KB | 截图管理 |
| `StorageStateWatchdog` | 13KB | Cookie/localStorage 状态持久化 |

#### BrowserProfile (`profile.py`)

丰富的浏览器配置，包括：
- Chrome 启动参数自动生成和去重
- 显示尺寸自动检测（macOS: AppKit, Linux/Windows: screeninfo）
- 扩展管理（uBlock Origin、Cookie 处理器、ClearURLs）
- 代理、安全设置、Docker 优化
- 无头/有头模式、确定性渲染

---

### 3.4 DOM 模块

**文件：** `browser_use/dom/`

#### DOM 处理流水线

```
CDP 数据采集 → 三树合并 → 可见性过滤 → 序列化 → LLM 表示
```

**Step 1 - 数据采集（三棵树同时获取）：**

| 树 | CDP 方法 | 数据 |
|----|----------|------|
| 快照树 | `DOMSnapshot.captureSnapshot` | 布局、样式、边界框、paint order |
| DOM 树 | `DOM.getDocument` | 节点结构、属性、iframe content document、shadow DOM |
| 无障碍树 | `Accessibility.getFullAXTree` | 角色、名称、属性，支持多帧合并 |

**Step 2 - 树合并 → `EnhancedDOMTreeNode`：**

每个节点包含：
- DOM 数据：node_id, tag, attributes, parent/children, iframe content_document, shadow_roots
- AX 数据：role, name, description, properties（checked/selected/disabled）
- Snapshot 数据：bounds, clientRects, scrollRects, computed_styles, paint_order

**Step 3 - 可见性过滤：**
- `is_element_visible_according_to_all_parents()` — 多层 iframe 坐标变换 + 视口交叉检测 + CSS 可见性检查

**Step 4 - 序列化：**

| 序列化器 | 用途 |
|----------|------|
| `DOMTreeSerializer` | 为 LLM 生成带索引的交互元素文本表示 |
| `DOMEvalSerializer` | 评估/评审用的完整 HTML 结构表示 |
| `ClickableElementDetector` | 检测可交互元素 |
| `PaintOrderFiltering` | 基于 paint order 过滤被遮挡元素 |

**输出 `SerializedDOMState`：**
- `_root: SimplifiedNode` — 简化节点树
- `selector_map: dict[int, EnhancedDOMTreeNode]` — 索引到节点的映射
- `llm_representation()` — 供 LLM 消费的文本格式

**关键特性：**
- 支持 Shadow DOM（open/closed）和跨域 iframe
- 稳定哈希（`compute_stable_hash`，过滤动态 CSS 类）用于历史重放匹配
- 滚动信息计算（scroll_info、pages_above/below）
- 自动检测可滚动元素（CDP 检测 + CSS 分析增强检测）

---

### 3.5 Tools 模块

**文件：** `browser_use/tools/`

#### Registry 注册机制 (`registry/service.py`)

```python
@registry.action(description='点击元素', param_model=ClickElementAction, domains=['*.example.com'])
async def click_element(params: ClickElementAction, browser_session: BrowserSession):
    ...
```

**设计特点：**
- 装饰器注册，支持两种函数签名模式（Pydantic param_model 或自动推断）
- **特殊参数注入**：`browser_session`、`page_extraction_llm`、`file_system`、`cdp_client`、`available_file_paths` 等按名称自动注入
- **域过滤**：`domains` 参数限制动作只在特定 URL 上可用
- `terminates_sequence=True` 的动作会中止多动作序列

#### 默认动作列表

| 类别 | 动作 | 参数模型 |
|------|------|----------|
| 导航 | `search`, `navigate`, `go_back`, `go_forward`, `wait` | SearchAction, NavigateAction 等 |
| 页面交互 | `click`, `input`, `upload_file`, `scroll`, `send_keys`, `find_text` | ClickElementAction, InputTextAction 等 |
| JS 执行 | `evaluate` | EvaluateAction |
| 标签管理 | `switch_tab`, `close_tab` | SwitchTabAction, CloseTabAction |
| 内容提取 | `extract` | ExtractAction |
| 视觉分析 | `screenshot` | ScreenshotAction |
| 表单控件 | `get_dropdown_options`, `select_dropdown_option` | GetDropdownOptionsAction 等 |
| 文件操作 | `write_file`, `read_file`, `replace_file` | WriteFileAction, ReadFileAction 等 |
| 任务完成 | `done` | DoneAction |
| 高级 | `save_as_pdf`, `search_page`, `find_elements`, `structured_output` | 各自的 Action 模型 |

#### ActionResult 结构

```python
class ActionResult:
    is_done: bool = False
    success: bool = True
    error: str | None = None
    extracted_content: str | None = None
    long_term_memory: str | None = None
    include_extracted_content_only_once: bool = False
    attachments: list[str] = []
    images: list[str] = []
    judgement: JudgementResult | None = None
    metadata: dict = {}
```

---

### 3.6 LLM 模块

**文件：** `browser_use/llm/`

#### 抽象接口

```python
class BaseChatModel(Protocol):
    model: str
    provider: str
    name: str

    async def ainvoke(
        self,
        messages: list[BaseMessage],
        output_format: type[BaseModel] | None = None
    ) -> ChatInvokeCompletion: ...
```

#### 支持的提供商（16+）

| 提供商 | 类名 | 文件 |
|--------|------|------|
| OpenAI | `ChatOpenAI` | `openai/chat.py` |
| Azure OpenAI | `ChatAzureOpenAI` | `azure/chat.py` |
| Google Gemini | `ChatGoogle` | `google/chat.py` |
| Anthropic | `ChatAnthropic` | `anthropic/chat.py` |
| AWS Bedrock (Anthropic) | `ChatAnthropicBedrock` | `aws/chat_anthropic.py` |
| AWS Bedrock (Native) | `ChatAWSBedrock` | `aws/chat_bedrock.py` |
| DeepSeek | `ChatDeepSeek` | `deepseek/chat.py` |
| Groq | `ChatGroq` | `groq/chat.py` |
| Mistral | `ChatMistral` | `mistral/chat.py` |
| Ollama | `ChatOllama` | `ollama/chat.py` |
| OpenRouter | `ChatOpenRouter` | `openrouter/chat.py` |
| LiteLLM | (via litellm) | `litellm/chat.py` |
| Cerebras | `ChatCerebras` | `cerebras/chat.py` |
| OCI | `ChatOCIRaw` | `oci_raw/chat.py` |
| Vercel | `ChatVercel` | `vercel/chat.py` |
| Browser Use | `ChatBrowserUse` | `browser_use/chat.py` |

**关键机制：**
- **懒加载**：`__init__.py` 使用 `__getattr__` 延迟导入，避免加载所有 SDK
- **模型实例工厂** (`models.py`)：`get_llm_by_name("azure_gpt_4_1_mini")` 从环境变量自动配置
- **SchemaOptimizer** (`schema.py`)：优化 Pydantic 模型的 JSON Schema（扁平化 $ref/$defs、OpenAI strict mode 兼容、Gemini 优化）

---

### 3.7 MCP 模块

**文件：** `browser_use/mcp/`

#### MCP Client (`client.py`)

连接外部 MCP 服务器，动态发现工具并注册为 browser-use 动作：
- 通过 stdio transport 连接
- 将 MCP tool schema 转换为 Pydantic 模型
- 包装 MCP 调用为 `ActionResult`
- 支持工具过滤、前缀命名

#### MCP Server (`server.py`)

`BrowserUseServer` 暴露浏览器自动化能力给 MCP 客户端：
- 工具：`browser_navigate`, `browser_click`, `browser_type`, `browser_get_state`, `browser_extract_content`, `browser_screenshot`, `browser_scroll`, `browser_go_back` 等
- `retry_with_browser_use_agent` — 兜底工具，用完整 Agent 重试
- 通过 EventBus 分发事件到 BrowserSession

#### MCP Controller (`controller.py`)

`MCPToolWrapper` — 轻量级 MCP 工具集成，直接连接 Registry。

---

### 3.8 其他模块

| 模块 | 路径 | 职责 |
|------|------|------|
| **actor/** | `actor/page.py`, `element.py`, `mouse.py` | 底层 CDP 操作封装：页面级操作、元素操作、鼠标操作 |
| **controller/** | `__init__.py` | 向后兼容别名，实际功能已合并到 Tools |
| **integrations/** | `integrations/gmail/` | Gmail 集成（OAuth + 自定义动作） |
| **sandbox/** | `sandbox/sandbox.py` | 远程沙箱执行（cloudpickle 序列化 + SSE 事件流） |
| **skills/** | `skills/service.py` | 预构建技能服务（从 API 获取/执行） |
| **telemetry/** | `telemetry/service.py` | 匿名遥测（PostHog，可禁用） |
| **tokens/** | `tokens/service.py` | LLM token 使用量和成本追踪 |
| **filesystem/** | `filesystem/file_system.py` | Agent 文件系统抽象（Txt/Md/Csv/Docx/Json 等） |
| **screenshots/** | `screenshots/service.py` | 截图磁盘存储（base64 编解码） |
| **sync/** | `sync/service.py` | 云端事件同步（设备 OAuth + HTTP） |
| **skill_cli/** | `skill_cli/main.py` | CLI 工具集（浏览器管理、会话管理、Python 执行等） |

---

## 4. 核心设计模式

### 4.1 事件驱动架构

BrowserSession 基于 `bubus.EventBus`，所有浏览器操作通过事件分发，Watchdog 作为事件处理器实现关注点分离。

```python
# 事件发布
await self.event_bus.emit(NavigateToUrlEvent(url=url))

# Watchdog 自动注册处理器
class DefaultActionWatchdog(WatchdogBase):
    async def on_NavigateToUrlEvent(self, event: NavigateToUrlEvent):
        # 处理导航
        ...
```

### 4.2 CDP 直接控制

绕过 Playwright，直接使用 Chrome DevTools Protocol（cdp_use 库），实现更细粒度的浏览器控制。

```python
# CDP 调用示例
cdp_client.send.DOMSnapshot.captureSnapshot(params=...)
cdp_client.send.Target.attachToTarget(params=ActivateTargetParameters(...))
cdp_client.register.Browser.downloadWillBegin(callback_func)
```

### 4.3 Registry 模式

动作通过装饰器注册，支持参数自动推断、特殊参数注入、域过滤。

```python
@tools.action('Ask human for help with a question')
async def ask_human(question: str, browser_session: BrowserSession) -> ActionResult:
    answer = input(f'{question} > ')
    return ActionResult(extracted_content=f'The human responded with: {answer}')
```

### 4.4 三树合并 DOM 处理

同时利用 DOM 树、AX 树、Snapshot 树，生成 LLM 友好的交互元素表示。这是 Browser-Use 的核心竞争力之一，相比简单的 HTML 解析，能更准确地识别可交互元素和元素可见性。

### 4.5 渐进式循环检测

不阻断动作执行，而是通过 nudge 消息引导 LLM 改变策略。在 5/8/12 次重复时递增提醒强度。

### 4.6 消息压缩

长对话自动压缩以节省 token，使用 LLM 摘要旧历史。

### 4.7 Judge 系统

任务完成后，独立 LLM 评估执行轨迹的正确性，输出结构化评判结果。

---

## 5. 依赖关系

### 核心依赖

| 包 | 版本 | 用途 |
|----|------|------|
| `pydantic` | 2.12.5 | 数据模型、验证、Schema 生成 |
| `cdp-use` | 1.4.5 | CDP 协议类型化接口 |
| `bubus` | 1.5.6 | 事件总线 |
| `openai` | 2.16.0 | OpenAI LLM SDK |
| `anthropic` | 0.76.0 | Anthropic LLM SDK |
| `google-genai` | 1.65.0 | Google Gemini SDK |
| `groq` | 1.0.0 | Groq LLM SDK |
| `ollama` | 0.6.1 | Ollama 本地模型 SDK |
| `mcp` | 1.26.0 | Model Context Protocol |
| `pillow` | 12.2.0 | 图像处理（截图） |
| `aiohttp` | 3.13.4 | 异步 HTTP |
| `httpx` | 0.28.1 | 同步/异步 HTTP |
| `cloudpickle` | 3.1.2 | 函数序列化（沙箱） |
| `markdownify` | 1.2.2 | HTML → Markdown 转换 |
| `pyotp` | 2.9.0 | TOTP 2FA 代码生成 |
| `rich` | 14.3.1 | 终端格式化（CLI） |
| `click` | 8.3.1 | CLI 参数解析 |

### 可选依赖

| 组 | 包 |
|----|-----|
| cli | textual==7.4.0 |
| aws | boto3==1.42.37 |
| oci | oci==2.166.0 |
| video | imageio[ffmpeg]==2.37.2, numpy==2.4.1 |

---

## 6. 测试体系

```
tests/
├── agent_tasks/          # Agent 任务 YAML 配置
├── mind2web_data/        # Mind2Web 基准数据
├── scripts/              # 调试脚本
└── ci/                   # CI 核心测试集
    ├── browser/          # 浏览器集成测试（CDP、导航、截图、标签页）
    ├── infrastructure/   # 基础设施测试（注册表、文件系统）
    ├── interactions/     # 交互测试（自动完成、下拉框、单选按钮）
    ├── models/           # LLM 模型测试（各提供商）
    ├── security/         # 安全测试（域过滤、IP 阻断、敏感数据）
    └── conftest.py       # Pytest 配置和 fixtures
```

**测试原则：**
- 不使用 mock，始终使用真实对象（LLM 除外）
- 不使用远程 URL，使用 pytest-httpserver 搭建本地测试服务器
- 现代 pytest-asyncio：无需 `@pytest.mark.asyncio` 装饰器
- 通过的测试移入 `tests/ci/` 作为 CI 默认集

---

## 7. 示例分类

```
examples/
├── apps/                 # 应用示例
├── browser/              # 浏览器控制示例
├── cloud/                # 云端使用示例
├── custom-functions/     # 自定义函数示例
├── features/             # 功能演示
├── file_system/          # 文件系统示例
├── getting_started/      # 入门教程
├── integrations/         # 集成示例
├── models/               # 模型配置示例
├── observability/        # 可观测性示例
├── sandbox/              # 沙箱示例
├── ui/                   # UI 示例
├── use-cases/            # 用例集合
├── simple.py             # 最简示例
└── demo_mode_example.py  # 演示模式示例
```

---

## 8. 代码风格

- **异步优先**：全部使用 async Python
- **缩进**：使用 Tab，不用空格
- **类型标注**：Python 3.12+ 风格（`str | None` 而非 `Optional[str]`）
- **数据模型**：Pydantic v2，`model_config = ConfigDict(extra='forbid', ...)`
- **ID 生成**：`uuid7str` 而非 UUID4
- **文件组织**：主逻辑在 `service.py`，模型在 `views.py`
- **日志分离**：所有控制台日志逻辑放在 `_log_...` 前缀方法中
- **Linter**：ruff（line-length=130，tab 缩进）
- **类型检查**：pyright（basic 模式）

---

## 9. 架构图

```
┌──────────────────────────────────────────────────────────┐
│                        用户代码                           │
│  Agent(task=..., llm=..., browser=..., tools=...)        │
└──────────────────────┬───────────────────────────────────┘
                       │
          ┌────────────▼────────────┐
          │      Agent Service      │
          │  ┌───────────────────┐  │
          │  │   MessageManager  │  │
          │  │  (对话历史管理)    │  │
          │  └───────────────────┘  │
          │  ┌───────────────────┐  │
          │  │  ActionLoopDetect │  │
          │  │  (循环检测)        │  │
          │  └───────────────────┘  │
          │  ┌───────────────────┐  │
          │  │  Judge System     │  │
          │  │  (执行评估)        │  │
          │  └───────────────────┘  │
          └───┬─────────────┬───────┘
              │             │
    ┌─────────▼───┐  ┌─────▼──────────┐
    │  LLM Layer  │  │  Tools/Registry │
    │ (16+ 提供商) │  │  (动作注册表)   │
    └─────────────┘  └──────┬─────────┘
                            │
              ┌─────────────▼─────────────┐
              │     BrowserSession        │
              │  ┌──────────────────────┐ │
              │  │    bubus EventBus    │ │
              │  └──────────┬───────────┘ │
              │  ┌──────────▼───────────┐ │
              │  │   Watchdog System    │ │
              │  │ ┌──────────────────┐ │ │
              │  │ │DefaultAction WD  │ │ │
              │  │ │Downloads WD      │ │ │
              │  │ │Dom WD            │ │ │
              │  │ │Crash WD          │ │ │
              │  │ │Security WD       │ │ │
              │  │ │Popups WD         │ │ │
              │  │ │...               │ │ │
              │  │ └──────────────────┘ │ │
              │  ┌──────────────────────┐ │
              │  │   DomService         │ │
              │  │ (DOM+AX+Snapshot合并)│ │
              │  └──────────────────────┘ │
              └──────────────┬────────────┘
                             │
                    ┌────────▼────────┐
                    │   cdp_use CDP   │
                    │   Client/Session│
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │    Chromium      │
                    └─────────────────┘
```

---

## 10. 与 Saros Agents 的集成参考

基于以上分析，browser-use 的以下设计模式和架构思路可供 sarosis-agents-client 项目参考：

1. **事件驱动架构**：使用 EventBus + Watchdog 实现关注点分离，适合浏览器会话管理
2. **Registry 模式**：装饰器注册工具/动作，支持参数自动推断和特殊参数注入
3. **三树合并 DOM 处理**：DOM + Accessibility + Snapshot 三源数据融合，显著提升元素识别准确性
4. **渐进式循环检测**：不阻断执行，而是通过 nudge 引导 LLM 改变策略
5. **LLM 抽象层**：Protocol 接口 + 懒加载 + Schema 优化，支持多提供商
6. **MCP 双模式集成**：同时支持作为 Server 暴露能力和作为 Client 消费外部工具
7. **敏感数据保护**：`<secret>` 标签 + TOTP 生成，确保密码等不进入 LLM 上下文
8. **消息压缩**：长对话自动摘要，节省 token 成本
9. **Judge 系统**：独立评估执行轨迹，提升任务完成质量
