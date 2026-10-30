/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Configuration keys — feature toggles qiuzijian debug
export const AGENT_STUDIO_ENABLED_SETTING = 'sessions.agentStudio.enabled';
export const AGENT_STUDIO_DATA_PATH_SETTING = 'sessions.agentStudio.dataPath';
export const AGENT_STUDIO_CHAT_STREAM_LOG_ENABLED_SETTING = 'sessions.agentStudio.chatStreamLog.enabled';
export const AGENT_STUDIO_CHAT_STREAM_LOG_DUMP_TOOLS_SETTING = 'sessions.agentStudio.chatStreamLog.dumpTools';

// NOTE: AG-UI provider plugins (e.g. codebuddy-provider) define their own configuration
// keys in their extension's package.json (contributes.configuration) and are discovered at
// runtime via ISettingsTabRegistry (contributes.agentStudioSettingsTab). Do NOT add
// provider-specific config keys here — they belong to the plugin.

// Configuration keys — Preferences
export const AGENT_STUDIO_THEME_SETTING = 'sessions.agentStudio.preferences.theme';
export const AGENT_STUDIO_LANGUAGE_SETTING = 'sessions.agentStudio.preferences.language';
export const AGENT_STUDIO_RESPONSE_LANGUAGE_SETTING = 'sessions.agentStudio.preferences.responseLanguage';
export const AGENT_STUDIO_SEND_KEY_SETTING = 'sessions.agentStudio.preferences.sendKey';
export const AGENT_STUDIO_DEFAULT_PROVIDER_SETTING = 'sessions.agentStudio.preferences.defaultProvider';
export const AGENT_STUDIO_DEFAULT_MODEL_SETTING = 'sessions.agentStudio.preferences.defaultModel';
export const AGENT_STUDIO_DEFAULT_AGENT_SETTING = 'sessions.agentStudio.preferences.defaultAgent';
export const AGENT_STUDIO_BOT_NAME_SETTING = 'sessions.agentStudio.preferences.botName';
export const AGENT_STUDIO_SHOW_TOKEN_USAGE_SETTING = 'sessions.agentStudio.preferences.showTokenUsage';
export const AGENT_STUDIO_NOTIFICATION_SOUND_SETTING = 'sessions.agentStudio.preferences.notificationSound';
export const AGENT_STUDIO_BROWSER_NOTIFICATIONS_SETTING = 'sessions.agentStudio.preferences.browserNotifications';
export const AGENT_STUDIO_CHECK_UPDATES_SETTING = 'sessions.agentStudio.preferences.checkUpdates';

// Configuration keys — Skill Budget Limits
export const AGENT_STUDIO_SKILLS_MAX_IN_PROMPT_SETTING = 'sessions.agentStudio.skills.maxSkillsInPrompt';
export const AGENT_STUDIO_SKILLS_MAX_PROMPT_CHARS_SETTING = 'sessions.agentStudio.skills.maxSkillsPromptChars';
/** 是否将已存储的工作流作为「可执行型 skill」暴露给 agent（双向打通 A 向）。默认开启。 */
export const AGENT_STUDIO_SKILLS_INCLUDE_WORKFLOWS_SETTING = 'sessions.agentStudio.skills.includeWorkflows';

// Configuration keys — Tool Search（折叠阈值门控）
/**
 * Tool Search 折叠开关：`off` 从不折叠 / `on` 总是折叠 / `auto` 按阈值折叠。
 *
 * ★ 2026-09-11 补注册 schema：这两个键**一直**被 `agentOSService._getToolSearchConfig`
 * 读取，但从未在 `IConfigurationRegistry` 注册 → 设置 UI 里看不到、无补全，
 * 用户只能手写 `settings.json`（改错了也无提示）。
 */
export const AGENT_STUDIO_TOOL_SEARCH_ENABLED_SETTING = 'agentStudio.toolSearch.enabled';
/** Tool Search 自动折叠阈值（deferrable 工具 token 占上下文窗口的百分比，0–100）。 */
export const AGENT_STUDIO_TOOL_SEARCH_THRESHOLD_PCT_SETTING = 'agentStudio.toolSearch.thresholdPct';

/**
 * AgentMemory 检索库的**上下文注入总开关**（2026-10-20）。
 *
 * 管的是 `<agentmemory-context>`（agentmemory 网关库的策展块注入，默认**关**）。它与 Agents
 * 页签的「MEMORY.md 常驻注入」是**两套**互不写入的东西：
 *   · MEMORY.md 常驻 = `.agent.md` 的 `memory-chars`（dsh 插件侧，默认开）；
 *   · 本开关 = 检索库注入（IDE 侧，默认关；原先只能靠环境变量 AGENTMEMORY_INJECT_CONTEXT）。
 * 关着时召回走 `memory_search` / `memory_recall` 工具 —— capture（写入）通道始终常开。
 *
 * 读取方：`agentMemoryInjection.isMemoryInjectionEnabled`（经 `ITurnHostContext` 取）。
 * schema 注册在 `agentStudio.contribution.ts`。
 */
export const AGENT_STUDIO_MEMORY_INJECT_CONTEXT_SETTING = 'agentStudio.memory.injectContext';

/** Unreal Engine 工具的 bridge 基址。留空回退到内置默认 `http://127.0.0.1:8765`。 */
export const AGENT_STUDIO_UNREAL_BRIDGE_URL_SETTING = 'sessions.agentStudio.unreal.bridgeUrl';
/** Unreal Engine bridge 内置默认地址（配置留空时使用）。 */
export const AGENT_STUDIO_UNREAL_BRIDGE_URL_DEFAULT = 'http://127.0.0.1:8765';

// ── Configuration keys — web_search 多后端（P0-2，2026-09-24）────────────────
//
// 背景：`web_search` 原先只有 DuckDuckGo 一族。加 provider 抽象后，用户可切到托管 API
// （对 LLM 更友好、抗改版）或自建 SearXNG（可控、隐私好），而 keyless 的 DuckDuckGo
// 永远是链尾兜底。provider 实现与链路解析见
// `browser/providers/tool/webSearchProviders.ts`；缺省值 = 仅 DuckDuckGo，与加抽象
// 之前的行为逐字节一致（未知环境不回归）。

/** web_search 的后端选择：`auto` | `duckduckgo` | `searxng` | `tavily` | `brave` | `exa`。 */
export const AGENT_STUDIO_WEB_SEARCH_PROVIDER_SETTING = 'sessions.agentStudio.webSearch.provider';
/** 自建 SearXNG 实例基址（需实例开启 JSON 输出格式）。 */
export const AGENT_STUDIO_WEB_SEARCH_SEARXNG_URL_SETTING = 'sessions.agentStudio.webSearch.searxngUrl';
/** Tavily API key。 */
export const AGENT_STUDIO_WEB_SEARCH_TAVILY_KEY_SETTING = 'sessions.agentStudio.webSearch.tavilyApiKey';
/** Brave Search API key。 */
export const AGENT_STUDIO_WEB_SEARCH_BRAVE_KEY_SETTING = 'sessions.agentStudio.webSearch.braveApiKey';
/** Exa API key。 */
export const AGENT_STUDIO_WEB_SEARCH_EXA_KEY_SETTING = 'sessions.agentStudio.webSearch.exaApiKey';
/**
 * 是否启用 `web_extract` 的本地持久化页面缓存（P2，2026-09-24）。
 *
 * 默认开启。**只缓存页面正文，不缓存搜索结果** —— 后者的语义就是"最新"，缓存会废掉它
 * （详见 `browser/providers/tool/webPageCache.ts` 文件头）。缓存内容落在
 * `StorageScope.APPLICATION` + `StorageTarget.MACHINE`（跨工作区共享、不随设置同步）。
 */
export const AGENT_STUDIO_WEB_SEARCH_CACHE_ENABLED_SETTING = 'sessions.agentStudio.webSearch.cacheEnabled';

// ── Configuration keys — browser_* 工具（CDP 驱动真实 Chrome，P1-2，2026-09-24）──
//
// 背景：`browser_*` 6 个名字早已在 `CORE_TOOLS` 白名单与 bundled 定义库里，但
// `registerBundledTools` 把它们注册成 stub ⇒ `listTools` 跳过 ⇒ 模型永远看不到。
// 现接入 CDP 真实实现（主进程 `electron-main/browserCdpChannel.ts`）。
//
// ⚠ 这两个键**必须注册 schema**：本仓有过"键被读取但从未注册 → 设置 UI 里看不到、
// 无补全，用户只能手写 settings.json"的历史坑（见本文件 Tool Search 段注释）。

/** 是否把 browser_* 工具暴露给模型（关闭可省下 7 个 schema 的常驻体积）。 */
export const AGENT_STUDIO_BROWSER_CDP_ENABLED_SETTING = 'sessions.agentStudio.browserCdp.enabled';
/**
 * Chrome 远程调试端口（与 `--remote-debugging-port` 一致）。
 *
 * ⚠ 它**同时**决定两件事，改之前先读：
 *   ① 我们去**找**你浏览器的端口 —— 探测候选里排第一的就是它（`browserCdp.ts` 的
 *      `cdpEndpointCandidates`）；
 *   ② 我们**自行拉起**的专属实例跑在它 **+1** 上（`dedicatedPortFor`），
 *      也就是说这个端口本身永远留给你自己的浏览器。
 *
 * 为什么必须留出来：Chrome 那个 "Allow remote debugging for this browser instance" 开关**没有端口
 * 选项**，只会监听默认的 9222（IPv6 形态是 `[::1]:9222`）。专属实例若占着 9222，那条路（带你全部
 * 登录态）就被**静默**堵死 —— 更糟的是我们仍连得上该端口，于是模型驱动的是空 profile，
 * 表现为"它说我没登录"。
 */
export const AGENT_STUDIO_BROWSER_CDP_PORT_SETTING = 'sessions.agentStudio.browserCdp.port';

/**
 * 让 yt-dlp 借用**你浏览器里的登录态**（`--cookies-from-browser <browser>`）—— 2026-09-24。
 *
 * 取值：空串/缺省 = **关闭**；或 `chrome` / `edge` / `firefox` / `brave` / `chromium` /
 * `opera` / `safari` / `vivaldi` / `whale`（yt-dlp 支持的名字，代码里有白名单兜底）。
 *
 * ## 为什么需要它（默认关）
 *
 * `extract_video_frames` / `video_analyze` 走的是 **yt-dlp（独立 http 客户端）**，它**不共享**
 * 我们在浏览器里建立的登录态 ⇒ 小红书这类"需登录才给视频流"的站点一律
 * `下载视频失败（yt-dlp exit 1）`（实测），模型只能每次都自己绕（用 execute_code 拿直链）。
 * 开启后 yt-dlp 直接读本机浏览器的 cookie 去请求，属业界标准做法。
 *
 * ## 代价（如实写进设置说明）
 *
 * · 这是把你的**登录态**交给外部程序使用 —— 数据只在本机、不外传，但必须由**你显式开启**；
 * · 浏览器**正在运行**时它的 cookie 库可能被锁 ⇒ yt-dlp 会报错，需重试或临时关掉浏览器；
 * · 与「用你自己那个 Chrome 调试」是**两条独立的路**：那条解决"浏览器里能看到"，
 *   这条解决"yt-dlp 能抓到"。要拿到视频本体/字幕时，这条才是判据。
 */
export const AGENT_STUDIO_BROWSER_COOKIES_FROM_BROWSER_SETTING = 'sessions.agentStudio.browserCdp.cookiesFromBrowser';

/**
 * 当 Chrome 的调试端口不可达时，是否由 VsSaros **自己拉起一个可调试的 Chrome 实例**
 * （专属 profile + `--user-data-dir`，因此**不需要**用户手动开远程调试、也**不需要**勾那个同意框）。
 *
 * 触发时机是**第一次真正要用浏览器工具时**，不是启动时 —— 所以不会"一开 VsSaros 就弹浏览器"。
 * profile 落在 `~/.vssaros/browser-profile`，与你的日常 Chrome 隔离，登录一次后会留在里面累积。
 *
 * 端口是「Chrome 调试端口」**+1**（`dedicatedPortFor`）：那个端口要留给你自己的 Chrome
 * —— Chrome 自己的那个同意框没有端口选项，只会用 9222。
 *
 * 关掉它则退回"你手动在 Chrome 里开远程调试"的老路（工具在端口不可达时对模型不可见）。
 */
export const AGENT_STUDIO_BROWSER_CDP_LAUNCH_DEDICATED_SETTING = 'sessions.agentStudio.browserCdp.launchDedicated';
/**
 * 自动拉起的专属实例是否跑在**无头**（不显示窗口）模式。
 *
 * ⚠ 无头下**无法交互式登录** —— 想在专属 profile 里登录站点，必须先用有窗口模式登录一次
 * （登录态会留在 profile 里，之后切无头也能用）。所以默认关。
 *
 * 改动**在下次拉起该实例时生效**：已经在跑的那个不受影响（可以手动关掉它，或下次重启 VsSaros
 * 后由发现逻辑复用/重建）。刻意不做"改设置就自动关掉正在跑的浏览器" —— 那是用户可能正在用的窗口。
 */
export const AGENT_STUDIO_BROWSER_CDP_HEADLESS_SETTING = 'sessions.agentStudio.browserCdp.headless';

// 曾有一个 `browserCdp.autoOpenDebugSetup`（启动时自动打开 chrome://inspect 页面），2026-09-24 移除：
// Chrome 会忽略从命令行/外部程序传来的 chrome:// URL（--new-window / 带锚点 / URL 前置 / --app=
// 四种写法实测全部只开出空白 New Tab），也就是"打开那一页"根本做不到，留个开关只会误导。
// 实测细节见 common/chromeDebugSetup.ts 文件头。

// Configuration keys — Driver concurrency
export const AGENT_STUDIO_DRIVER_TURN_CONCURRENCY_LIMIT_SETTING = 'sessions.agentStudio.driver.turnConcurrencyLimit';

// Configuration keys — Chat UI Mode (React WebView vs Native DOM)
/** @deprecated NativeChatEditorPane 现在是唯一聊天渲染器，此设置不再生效。保留仅为向后兼容。 */
export const AGENT_STUDIO_USE_NATIVE_CHAT_SETTING = 'sessions.agentStudio.chat.useNativeChat';

// Configuration keys — Auxiliary Models
export const AGENT_STUDIO_AUX_VISION_PROVIDER = 'sessions.agentStudio.aux.vision.provider';
export const AGENT_STUDIO_AUX_VISION_MODEL = 'sessions.agentStudio.aux.vision.model';
export const AGENT_STUDIO_AUX_WEB_EXTRACT_PROVIDER = 'sessions.agentStudio.aux.webExtract.provider';
export const AGENT_STUDIO_AUX_WEB_EXTRACT_MODEL = 'sessions.agentStudio.aux.webExtract.model';
export const AGENT_STUDIO_AUX_SESSION_SEARCH_PROVIDER = 'sessions.agentStudio.aux.sessionSearch.provider';
export const AGENT_STUDIO_AUX_SESSION_SEARCH_MODEL = 'sessions.agentStudio.aux.sessionSearch.model';
export const AGENT_STUDIO_AUX_COMPRESSION_PROVIDER = 'sessions.agentStudio.aux.compression.provider';
export const AGENT_STUDIO_AUX_COMPRESSION_MODEL = 'sessions.agentStudio.aux.compression.model';
export const AGENT_STUDIO_AUX_GOAL_JUDGE_PROVIDER = 'sessions.agentStudio.aux.goalJudge.provider';
export const AGENT_STUDIO_AUX_GOAL_JUDGE_MODEL = 'sessions.agentStudio.aux.goalJudge.model';
export const AGENT_STUDIO_AUX_CURATOR_PROVIDER = 'sessions.agentStudio.aux.curator.provider';
export const AGENT_STUDIO_AUX_CURATOR_MODEL = 'sessions.agentStudio.aux.curator.model';
// Embedding（向量）辅助模型：知识库向量化 / RAG 索引构建的 provider / model / 维度。
// 这些键是知识库 & RAG embedding 的唯一来源，解除了对 knowledge-base-expert agent 的依赖。
// provider='auto' 时回退到全局 embedding.provider；默认 model=text-embedding-3-small，dimensions=512。
export const AGENT_STUDIO_AUX_EMBEDDING_PROVIDER = 'sessions.agentStudio.aux.embedding.provider';
export const AGENT_STUDIO_AUX_EMBEDDING_MODEL = 'sessions.agentStudio.aux.embedding.model';
export const AGENT_STUDIO_AUX_EMBEDDING_DIMENSIONS = 'sessions.agentStudio.aux.embedding.dimensions';

// Configuration keys — Image Generation（用户级默认，2026-09-10）
//
// 为什么需要它：agent 配置（.agent.md 的 imageModel/imageProviderId）是首选来源，
// 但**内置 agent 只读**（如 saros-claw，updateAgent 被拒）——用户在聊天框/设置页
// 选的图片模型无处持久化（localStorage 只在本 pane 生效，工具侧读不到）→
// image_generate 落到「自动路由」→ 取 customProviders 里**第一个**有
// supportsImageGen 的 provider（实测是 grnexus，而其网关不开放 Images API → 404）。
// 有了用户级默认后：agent 配置缺失时读这里，用户的选择才真正生效。
export const AGENT_STUDIO_IMAGE_GEN_PROVIDER = 'sessions.agentStudio.imageGen.provider';
export const AGENT_STUDIO_IMAGE_GEN_MODEL = 'sessions.agentStudio.imageGen.model';

// Configuration keys — Provider (API connections)
export const AGENT_STUDIO_PROVIDER_OPENROUTER_API_KEY = 'sessions.agentStudio.provider.openrouter.apiKey';
export const AGENT_STUDIO_PROVIDER_OPENROUTER_BASE_URL = 'sessions.agentStudio.provider.openrouter.baseUrl';
export const AGENT_STUDIO_PROVIDER_NOUS_API_KEY = 'sessions.agentStudio.provider.nous.apiKey';
export const AGENT_STUDIO_PROVIDER_NOUS_BASE_URL = 'sessions.agentStudio.provider.nous.baseUrl';
export const AGENT_STUDIO_PROVIDER_GEMINI_API_KEY = 'sessions.agentStudio.provider.gemini.apiKey';
export const AGENT_STUDIO_PROVIDER_GEMINI_BASE_URL = 'sessions.agentStudio.provider.gemini.baseUrl';
export const AGENT_STUDIO_PROVIDER_ANTHROPIC_API_KEY = 'sessions.agentStudio.provider.anthropic.apiKey';
export const AGENT_STUDIO_PROVIDER_ANTHROPIC_BASE_URL = 'sessions.agentStudio.provider.anthropic.baseUrl';
export const AGENT_STUDIO_PROVIDER_MAIN_API_KEY = 'sessions.agentStudio.provider.main.apiKey';
export const AGENT_STUDIO_PROVIDER_MAIN_BASE_URL = 'sessions.agentStudio.provider.main.baseUrl';
export const AGENT_STUDIO_PROVIDER_CUSTOM_API_KEY = 'sessions.agentStudio.provider.custom.apiKey';
export const AGENT_STUDIO_PROVIDER_CUSTOM_BASE_URL = 'sessions.agentStudio.provider.custom.baseUrl';
export const AGENT_STUDIO_PROVIDER_OLLAMA_API_KEY = 'sessions.agentStudio.provider.ollama.apiKey';
export const AGENT_STUDIO_PROVIDER_OLLAMA_BASE_URL = 'sessions.agentStudio.provider.ollama.baseUrl';
// UI 添加的自定义 provider 列表（Path B：自定义 provider 真正接入聊天模型系统）
export const AGENT_STUDIO_CUSTOM_PROVIDERS_SETTING = 'sessions.agentStudio.provider.customProviders';

// Configuration keys — Embedding (RAG vectorization provider layer)
// 方案A 主路径：复用现有 provider 密钥配置做 embedding；方案C 兜底：本地 transformers.js
export const AGENT_STUDIO_EMBEDDING_PROVIDER = 'sessions.agentStudio.embedding.provider';
export const AGENT_STUDIO_EMBEDDING_MODEL = 'sessions.agentStudio.embedding.model';
export const AGENT_STUDIO_EMBEDDING_DIMENSIONS = 'sessions.agentStudio.embedding.dimensions';
export const AGENT_STUDIO_EMBEDDING_API_KEY = 'sessions.agentStudio.embedding.apiKey';
export const AGENT_STUDIO_EMBEDDING_BASE_URL = 'sessions.agentStudio.embedding.baseUrl';

export const AGENT_STUDIO_EMBEDDING_LOCAL_ENABLED = 'sessions.agentStudio.embedding.local.enabled';
export const AGENT_STUDIO_EMBEDDING_LOCAL_MODEL = 'sessions.agentStudio.embedding.local.model';

/** 知识库 agentic 构建模式（**默认开启**）：「构建笔记」走 AgentDriverService（knowledge-base-expert agent + 技能注入 + 工具），失败回退直连管线。显式设为 false 可回退纯直连。 */
export const AGENT_STUDIO_KB_AGENTIC_BUILD = 'sessions.agentStudio.kb.agenticBuild';

// ── 知识库：飞书同步 ────────────────────────────────────────────────────────
/** 飞书同步总开关（默认关）。开启后设置面板展示完整同步配置，并可被定时任务读取。 */
export const AGENT_STUDIO_KB_FEISHU_SYNC_ENABLED = 'sessions.agentStudio.kb.feishu.enabled';
/**
 * 飞书 CLI（lark-cli）可执行路径：默认 `lark-cli`（走 PATH），安装在非标准位置时填完整路径。
 * 注：**同步脚本已内置随产品发布**（`resources/.agents/kb/feishu-sync.mjs`），
 * 不再暴露「脚本路径」配置项 —— 用户无需自备外部脚本。
 */
export const AGENT_STUDIO_KB_FEISHU_CLI_PATH = 'sessions.agentStudio.kb.feishu.cliPath';
/** 要同步的库内相对目录（多个用逗号分隔；留空 = 同步整个知识库）。 */
export const AGENT_STUDIO_KB_FEISHU_SYNC_SRC_DIRS = 'sessions.agentStudio.kb.feishu.srcDirs';
/** 同步目标位置：my_library（个人知识库）或指定文件夹 token。 */
export const AGENT_STUDIO_KB_FEISHU_SYNC_PARENT = 'sessions.agentStudio.kb.feishu.parent';
/** 远端被手工修改时的策略：overwrite（本地覆盖）| skip（跳过并记冲突）。 */
export const AGENT_STUDIO_KB_FEISHU_SYNC_ON_CONFLICT = 'sessions.agentStudio.kb.feishu.onConflict';
/** 每篇之间的间隔毫秒数（限流保护，默认 800）。 */
export const AGENT_STUDIO_KB_FEISHU_SYNC_INTERVAL = 'sessions.agentStudio.kb.feishu.interval';
/**
 * 定时同步开关（默认关）：是否允许 IDE 自动化任务（automation `kb`，工作日 10:00）
 * 自动执行增量同步。与总开关 `feishu.enabled` 是**与**关系 —— 两者都为 true 才会自动同步；
 * 手动「立即同步」不受此开关约束。
 */
export const AGENT_STUDIO_KB_FEISHU_AUTO_SYNC = 'sessions.agentStudio.kb.feishu.autoSync';

// ── 知识库：飞书同步 · 多类别 → 多知识库 ─────────────────────────────────────
/**
 * 类别层级深度：同步源目录下第 N 级目录作为一个「类别」，每个类别对应一个飞书知识库。
 * 0 = 不分类别（全部落到 `feishu.parent` 默认落点）。
 */
export const AGENT_STUDIO_KB_FEISHU_CATEGORY_DEPTH = 'sessions.agentStudio.kb.feishu.categoryDepth';
/** 未映射的类别是否自动创建同名飞书知识库（默认**开**）。 */
export const AGENT_STUDIO_KB_FEISHU_AUTO_CREATE_SPACES = 'sessions.agentStudio.kb.feishu.autoCreateSpaces';
/** 本地已删除的文档是否同时移除远端节点（默认**关**，安全）。 */
export const AGENT_STUDIO_KB_FEISHU_PRUNE_REMOTE = 'sessions.agentStudio.kb.feishu.pruneRemote';

// Configuration keys — CLI
export const AGENT_STUDIO_CLI_PATH_SETTING = 'sessions.agentStudio.cli.cliPath';
export const AGENT_STUDIO_CLI_DEFAULT_WORKDIR_SETTING = 'sessions.agentStudio.cli.defaultWorkdir';
export const AGENT_STUDIO_CLI_AUTO_CONNECT_SETTING = 'sessions.agentStudio.cli.autoConnect';
export const AGENT_STUDIO_CLI_SAVE_HISTORY_SETTING = 'sessions.agentStudio.cli.saveHistory';

// ViewContainer IDs
export const AGENT_STUDIO_CHATBAR_VIEW_CONTAINER_ID = 'agentStudio.chatBar';
export const AGENT_STUDIO_SIDEBAR_VIEW_CONTAINER_ID = 'agentStudio.sidebar';
export const AGENT_STUDIO_AUXBAR_VIEW_CONTAINER_ID = 'agentStudio.auxiliaryBar';

// View IDs
/** 内置主助理 Agent id（saros-claw / 助理）——工作流画布 Run 的默认执行 agent。 */
export const SAROS_CLAW_AGENT_ID = 'saros-claw';

export const AGENT_STUDIO_MAIN_VIEW_ID = 'agentStudio.mainView';
export const AGENT_STUDIO_CANVAS_VIEW_ID = 'agentStudio.canvasView';
export const AGENT_STUDIO_CHAT_VIEW_ID = 'agentStudio.chatView';
export const AGENT_STUDIO_TASKBOARD_VIEW_ID = 'agentStudio.taskBoardView';
export const AGENT_STUDIO_SESSIONS_VIEW_ID = 'agentStudio.sessionsView';
export const AGENT_STUDIO_WORKSPACES_VIEW_ID = 'agentStudio.workspacesView';
export const AGENT_STUDIO_DELEGATION_VIEW_ID = 'agentStudio.delegationView';

// Toolbar View IDs (left sidebar toolbar)
export const AGENT_STUDIO_TOOLBAR_VIEW_ID = 'agentStudio.toolbarView';
export const AGENT_STUDIO_CLAW_CHAT_VIEW_ID = 'agentStudio.clawChatView';
export const AGENT_STUDIO_WORKSPACE_VIEW_ID = 'agentStudio.workspaceView';
export const AGENT_STUDIO_PRESET_AGENT_VIEW_ID = 'agentStudio.presetAgentView';
export const AGENT_STUDIO_SKILLS_VIEW_ID = 'agentStudio.skillsView';
export const AGENT_STUDIO_TASKS_VIEW_ID = 'agentStudio.tasksView';
export const AGENT_STUDIO_SCHEDULE_VIEW_ID = 'agentStudio.scheduleView';
export const AGENT_STUDIO_TOOLS_VIEW_ID = 'agentStudio.toolsView';
export const AGENT_STUDIO_INTEGRATION_VIEW_ID = 'agentStudio.integrationView';
export const AGENT_STUDIO_CHANGES_VIEW_ID = 'agentStudio.changesView';
export const AGENT_STUDIO_SEARCH_VIEW_ID = 'agentStudio.searchView';
export const AGENT_STUDIO_PLUGINS_VIEW_ID = 'agentStudio.pluginsView';
export const AGENT_STUDIO_PERSONAL_VIEW_ID = 'agentStudio.personalView';
export const AGENT_STUDIO_SETTINGS_VIEW_ID = 'agentStudio.settingsView';
export const AGENT_STUDIO_PROVIDER_VIEW_ID = 'agentStudio.providerView';
export const AGENT_STUDIO_HEALTH_MONITOR_VIEW_ID = 'agentStudio.healthMonitorView';
export const AGENT_STUDIO_EVOLUTION_VIEW_ID = 'agentStudio.evolutionView';
export const AGENT_STUDIO_WORKFLOW_VIEW_ID = 'agentStudio.workflowView';
export const AGENT_STUDIO_CHANNEL_VIEW_ID = 'agentStudio.channelView';
export const AGENT_STUDIO_WIKI_VIEW_ID = 'agentStudio.wikiView';
export const AGENT_STUDIO_KB_VIEW_ID = 'agentStudio.knowledgeBaseView';
/**
 * 左侧栏「知识库」视图容器 id（2026-10-12 前显示名是「资料库」）—— 也是 activitybar 徽标的挂载点。
 * ⚠ 容器 id 一字未动（改它会丢用户已存的活动栏布局），只有显示名变。
 */
export const AGENT_STUDIO_KB_VIEW_CONTAINER_ID = 'agentStudio.knowledgeBase';
/**
 * 记忆库（独立工作台，2026-10-12 从「资料库」页的 mem tab 提升）的**视图 id**。
 *
 * 容器 id 在静态注册处写成字面量 `'agentStudio.memory'`（`dshActivityBarSource.test.ts`
 * 按字面量匹配静态注册，用记号常量会让那条表驱动守卫找不到 ⇒ 报「existing 没走
 * _registerModuleToolIcon」）；这里只留视图 id 常量。
 *
 * ⚠ 两个 id 都是**新建**的（绝不复用 kb 的）：容器 id 一旦改动，用户在
 * `workbench.activity.pinnedViewlets2` 里已存的活动栏布局就找不到它了（R1）。
 */
export const AGENT_STUDIO_MEMORY_VIEW_ID = 'agentStudio.memoryView';
/**
 * 媒体库（独立工作台，2026-10-12 从「资料库」页的 media tab 提升）的**视图 id**。
 * 容器 id 同样是注册处的字面量 `'agentStudio.media'`（理由见上）。
 */
export const AGENT_STUDIO_MEDIA_VIEW_ID = 'agentStudio.mediaView';
export const AGENT_STUDIO_CLASS_HIERARCHY_VIEW_ID = 'agentStudio.classHierarchyView';
export const AGENT_STUDIO_REFERENCES_VIEW_ID = 'agentStudio.referencesView';
export const AGENT_STUDIO_WIKI_ROOT_SETTING = 'agentStudio.wiki.root';
export const AGENT_STUDIO_WIKI_MAX_PROPOSAL_SETTING = 'agentStudio.wiki.maxProposalCount';
export const AGENT_STUDIO_WORKTREE_VIEW_ID = 'agentStudio.worktreeView';
export const AGENT_STUDIO_GRAPH_VIEW_ID = 'agentStudio.graphView';
export const AGENT_STUDIO_DASHBOARD_VIEW_ID = 'agentStudio.dashboardView';
/**
 * dsh 代码图谱容器的 page 宿主视图 id（`vssaros.dsh.codebase`，order 25）。
 * 容器走 `page-only`：`engine=dsh` 时这个视图挂 `DshPluginViewPane`（插件自托管 `/x/codebase/`）；
 * `engine=legacy` 时**故意不注册**——legacy 侧没有代码图谱视图（`agentStudio.graphView` 是 Git 提交历史图，
 * 不是代码图谱），硬塞一个静态入口只会多一个点了没东西的图标。
 */
export const AGENT_STUDIO_CODEBASE_VIEW_ID = 'vssaros.dsh.codebaseView';
/**
 * dsh 历史会话页容器的 page 宿主视图 id（`vssaros.dsh.sessions`，order 120）。
 * 容器走 `page-only`：`engine=dsh` 时这个视图挂 `DshPluginViewPane`（插件自托管 `/x/sessions/`）；
 * `engine=legacy` 时**故意不注册** —— legacy 侧的历史会话是那个**常驻容器** `sessionHistory.view`
 * （壳侧 DOM pane，容器 id / 视图 id 都不同）⇒ 两者并存，本格只负责"dsh 自绘那一版"的入口。
 */
export const AGENT_STUDIO_DSH_SESSIONS_VIEW_ID = 'vssaros.dsh.sessionsView';
/**
 * dsh 定时任务页容器的 page 宿主视图 id（`vssaros.dsh.scheduler`，order 95；重构 2.1）。
 * `page-only`：`engine=dsh` 时挂 `DshPluginViewPane`（插件自托管 `/x/scheduler/`）；
 * `engine=legacy` 时**故意不注册**——legacy 的自研调度器从未执行过（`agentSchedulerService.ts` 的
 * 生成器只 await 不迭代），没有静态对应物要并存。
 */
export const AGENT_STUDIO_SCHEDULER_VIEW_ID = 'vssaros.dsh.schedulerView';

/**
 * 画布工作台（2026-10-21）的侧栏视图 id。
 *
 * `engine=legacy` 时**故意不注册**——画布引擎（Excalidraw，3.4MB）随 dsh 插件走，
 * legacy 引擎侧没有画布可显示（注册一个打不开的图标 = 死按钮 ✗）。
 */
export const AGENT_STUDIO_DSH_IMAGEGEN_VIEW_ID = 'vssaros.dsh.imagegenView';

/**
 * 商城工作台（2026-10-22）的侧栏视图 id。
 *
 * `page-only`：`engine=dsh` 时挂 `DshPluginViewPane`（插件自托管 `/x/marketplace/`）；
 * `engine=legacy` 时**故意不注册** —— 商城的认证与安装链全在 dsh/IDE 侧
 * （商城 JWT 在 IDE 进程；装工作台必须走主进程 `dsh plugin add`）⇒ legacy 侧没有可承载的商城页 ✗。
 */
export const AGENT_STUDIO_DSH_MARKETPLACE_VIEW_ID = 'vssaros.dsh.marketplaceView';

/**
 * ★ 2026-10-30（用户要求「移除萨罗斯中转站工作台」）：
 *   中转站工作台的侧栏视图 id 已随之删除（`@vssaros/dsh-relay` 插件已卸载）。
 */

/*
 * 2026-10-30：三个容器此前**没有显式视图 id**，一直走 `moduleViewHostOf` 的派生兜底
 * （`vssaros.dsh.pv.<containerId>`）。源码守卫「每个可注册容器都备了 page 宿主」要求显式登记，
 * 且必须从 constants 里取字面值 ⇒ 这里把**兜底值原样**固化成常量：语义零变化
 * （同一串 id ⇒ 已持久化的布局/视图状态不丢），但 id 从此是写下来的，派生规则改字也带不走它们。
 */
export const AGENT_STUDIO_DSH_PARALLEL_VIEW_ID = 'vssaros.dsh.pv.vssaros.dsh.parallel';
export const AGENT_STUDIO_DSH_STUDIO_VIEW_ID = 'vssaros.dsh.pv.vssaros.dsh.studio';
// ★ 2026-10-30（用户要求「删除小红书工作台」）：`@vssaros/dsh-xhs-note` 已卸载 ⇒
//   `AGENT_STUDIO_DSH_XHSNOTE_VIEW_ID`（`vssaros.dsh.pv.vssaros.dsh.xhs-note`）随之删除。

// --- TOF (Taihu OA Framework) 登录配置 ---
// 对接 OAuthSystem 网关 (太湖 MCP 鉴权网关)
export const TOF_PAASID_SETTING = 'sessions.agentStudio.tof.paasid';
export const TOF_SITE_BASE_URL_SETTING = 'sessions.agentStudio.tof.siteBaseUrl';
export const TOF_GATEWAY_BASE_URL_SETTING = 'sessions.agentStudio.tof.gatewayBaseUrl';
export const TOF_LOGIN_TIMEOUT_SETTING = 'sessions.agentStudio.tof.loginTimeout';

/**
 * TOF 登录回调站点（单一事实源，2026-09-10）。
 *
 * 该域名承担登录回调：passport 登录成功 → 跳 `<此域名>/api/v1/auth/tof/callback?cb_port=…`。
 * **必须 DNS 可解析**，否则浏览器报 `DNS_PROBE_FINISHED_NXDOMAIN`（This site can't be reached），
 * 而本地 loopback server 只能干等到超时。
 *
 * 事故（2026-09-10）：本仓曾同时存在两个不同的默认值 —— workbench 侧
 * `http://vssaros.woa.com`（已无 DNS 记录）与扩展侧 `http://saroasis-mcp.woa.com`；
 * 因 workbench 的配置注册**优先**，未显式配置的环境一律走失效域名 → 登录必失败。
 * 现统一为本常量，并由单测锁定；扩展侧（独立 tsc 工程，无法 import 本文件）需手工同步：
 *   · extensions/tof-authentication/package.json → configuration…siteBaseUrl.default
 *   · extensions/tof-authentication/src/tofAuthProvider.ts → _getConfig 的 fallback
 */
export const TOF_DEFAULT_SITE_BASE_URL = 'http://saroasis-mcp.woa.com';

// Channel keys — ALL channels supported by OpenClaw
// Sources: ChannelsConfig explicit properties (9) + UI renderChannel switch (8)
//          + official-external-channel-catalog.json + extensions/ directories
export type ChannelKey =
	// Core channels (ChannelsConfig explicit properties + UI switch cases)
	| 'whatsapp' | 'telegram' | 'discord' | 'googlechat' | 'slack'
	| 'signal' | 'imessage' | 'nostr' | 'irc' | 'msteams'
	// Official plugin channels (from catalog + extensions/)
	| 'feishu' | 'line' | 'matrix' | 'mattermost' | 'nextcloud-talk'
	| 'qqbot' | 'synology-chat' | 'tlon' | 'twitch' | 'zalo' | 'zalouser'
	// External plugin channels (from catalog)
	| 'wecom' | 'yuanbao' | 'openclaw-weixin';

/**
 * Default channel display order — matches OpenClaw's resolveChannelOrder fallback
 * for core channels, then appends plugin channels by catalog order.
 */
export const CHANNEL_ORDER: ChannelKey[] = [
	// UI default 8
	'whatsapp', 'telegram', 'discord', 'googlechat', 'slack', 'signal', 'imessage', 'nostr',
	// ChannelsConfig extras
	'irc', 'msteams',
	// Official plugins (by catalog order)
	'feishu', 'line', 'matrix', 'mattermost', 'nextcloud-talk', 'qqbot',
	'synology-chat', 'tlon', 'twitch', 'zalo', 'zalouser',
	// External plugins
	'wecom', 'yuanbao', 'openclaw-weixin',
];

/** DM policy options shared across all channels */
export const DM_POLICY_OPTIONS = [
	{ value: 'pairing', label: 'Pairing（配对模式）' },
	{ value: 'allowlist', label: 'Allowlist（白名单）' },
	{ value: 'open', label: 'Open（开放）' },
	{ value: 'disabled', label: 'Disabled（禁用）' },
];

/** Group policy options shared across all channels */
export const GROUP_POLICY_OPTIONS = [
	{ value: 'allowlist', label: 'Allowlist（白名单）' },
	{ value: 'open', label: 'Open（开放）' },
	{ value: 'disabled', label: 'Disabled（禁用）' },
];

export interface IChannelDefinition {
	readonly key: ChannelKey;
	readonly label: string;
	readonly icon: string;
	readonly description: string;
	readonly selectionLabel: string;
	readonly detailLabel: string;
	readonly configFields: IChannelConfigField[];
	/** Aliases recognized by OpenClaw CLI */
	readonly aliases?: string[];
}

export interface IChannelConfigField {
	readonly key: string;
	readonly label: string;
	readonly description: string;
	readonly type: 'string' | 'password' | 'boolean' | 'number' | 'select' | 'textarea' | 'agent';
	readonly default: any;
	readonly placeholder?: string;
	readonly options?: { value: string; label: string }[];
}

/* ★ 2026-10-29：`commonFields()` 随 `CHANNEL_DEFINITIONS` 一起下线（渠道配置全在 dsh 侧）。
   它的字段全是 `sessions.channel.<ch>.*` —— 那批配置项已不再注册，留着它只会让人以为
   「IDE 侧还有渠道配置」。 */

/**
 * All channel definitions — strictly matching OpenClaw.
 * Core channels have detailed config fields matching types.channels.ts.
 * Plugin channels use generic config (plugin-owned schemas).
 */
/* ★★ 2026-10-29：IDE 侧的渠道配置清单**整体清空** —— 渠道能力全部收敛到 dsh 侧 ★★
 *
 * 为什么：dsh 侧插件（`dsh-plugins/vssaros-agents`）已实现完整渠道链路 ——
 *   凭据（dsh 设置 → 渠道）、入站长连接（飞书 WS / Telegram 轮询 / Discord Gateway）、
 *   绑定表（bot ⇄ IM 会话）、配对、白名单、死信、出站（webhook / 应用模式）。
 * 而 IDE 侧原本还会按这里的 `sessions.channel.*` 再起一套（飞书长连接等）⇒
 * **同一个飞书应用建两条长连接，事件只推给先连的那条** ⇒ dsh 侧永远收不到消息
 *（2026-10-29 真机：飞书里能收到回复，但那是 IDE 侧回的；Bots 工作台里没有会话）。
 * 两套实现并存不是冗余，是互相抢事件。
 *
 * 迁移去向：凭据 → dsh 设置 → 渠道；入站/出站 → dsh 侧插件；bot ⇄ IM 会话 → dsh 绑定表。
 * ⚠ 类型（IChannelDefinition / IChannelConfigField / ChannelKey）先留着：渠道品牌图标与
 *   状态徽章仍被别处引用；等那些一起下线后再删类型。
 */
export const CHANNEL_DEFINITIONS: IChannelDefinition[] = [];

// Panel types (passed to WebView to select which React component to render)
// 'agent-settings' renders AgentEditorPane in the editor area.
// 'settings' is rendered natively (no WebView) via SettingsEditorPane.
export type AgentStudioPanelType = 'chat' | 'taskboard' | 'workflow-editor' | 'agent-settings' | 'settings';

// Provider ID
export const AGENT_STUDIO_PROVIDER_ID = 'agentStudio';

// ContextKey names
export const AGENT_STUDIO_ACTIVE_CONTEXT_KEY = 'agentStudio.active';

// WebView
export const AGENT_STUDIO_WEBVIEW_TYPE = 'agentStudio.webview';

// Stable origin shared by all inline-mode Agent Studio webviews (chat panel +
// the off-screen pre-warm holder). VS Code defaults each webview to a random
// UUID origin, which forces Chromium to spawn a brand-new (cold) renderer
// process per panel — and during dev cold-start that spawn can stall 25-40s.
// By pinning a single stable origin, all these webviews share ONE renderer
// process, so once the persistent pre-warm holder has spawned it, the real
// chat panel reuses the already-hot process instead of spawning its own.
// NOTE: only safe to share across webviews that have identical service-worker
// state — we only apply it when disableServiceWorker is true (inline bundles).
export const AGENT_STUDIO_WEBVIEW_ORIGIN = 'agentstudio-shared-renderer';

// Data file names
export const DATA_FILE_WORKSPACES = 'workspaces.json';
export const DATA_FILE_DELEGATIONS = 'delegations.json';
export const DATA_FILE_SESSIONS = 'sessions.json';
export const DATA_FILE_CHAT_HISTORY = 'chat-history.json';
export const DATA_FILE_LAST_ACTIVE_WORKSPACE = 'last-active-workspace.json';
export const DATA_FILE_LAST_ACTIVE_AGENT = 'last-active-agent.json';
export const DATA_FILE_AGENT_BINDINGS = 'agent-bindings.json';

// Workspace-local data directory name (stored inside the workspace folder)
export const WORKSPACE_DATA_DIR = '.sarosworkspace';

// Agent instance directory name (stored inside .sarosworkspace/)
export const AGENTS_DIR = 'agents';

// Workspace Sessions (Forks) directory name (stored inside .sarosworkspace/)
export const WORKSPACE_SESSIONS_DIR = 'workspace_sessions';

// Agent instance bootstrap file names (inspired by OpenClaw workspace structure)
export const AGENT_CONFIG_FILE = 'agent.yaml';
export const AGENT_AGENTS_MD = 'AGENTS.md';
export const AGENT_SOUL_MD = 'SOUL.md';
export const AGENT_IDENTITY_MD = 'IDENTITY.md';
export const AGENT_TOOLS_MD = 'TOOLS.md';
export const AGENT_MEMORY_MD = 'MEMORY.md';
