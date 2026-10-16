/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * WebContentsView 池：承载由 dsh Host 下发的官方 Web Client（方案第 5.2、7.1 节）。
 *
 * 参照上游 `platform/browserView/electron-main/browserView.ts` 独立实现（不改上游文件）：
 * - 独立 partition、sandbox + contextIsolation、无 Node；
 * - 只允许停留在当前 Host 的 origin；新窗口与外链交给系统浏览器；
 * - 按 windowId 在主窗口与 aux 窗口之间重新挂载（layout 时检测）；
 * - 权限请求一律拒绝。
 * P0-3 验证：同一 partition 内 token 换得的 Cookie 被多视图共享，不需要认证代理。
 */

import { session as electronSession, shell, webContents, WebContentsView, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type Session } from 'electron';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { FileAccess } from '../../../../base/common/network.js';
import { IAuxiliaryWindowsMainService } from '../../../../platform/auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWindowsMainService } from '../../../../platform/windows/electron-main/windows.js';
import { isSameOrigin } from '../common/dshCli.js';
import { DSH_VIEW_PARTITION, DshColorScheme, DshViewSurface, IDshViewBounds, IDshViewInfo } from '../common/dshHarness.js';
import { resolveViewUrl } from '../common/dshPluginPage.js';
import { IViewLoadRetryState, newViewLoadRetryState, onDocumentFinishedLoad, onMainFrameNavigated, planLoadRetry, resetViewLoadRetry, shouldResetRetryBudget, VIEW_LOAD_MAX_RETRIES, withAuthRetry } from '../common/dshViewLoadRetry.js';
import { DSH_PAGE_CHAT_ONLY_ARG, DSH_PAGE_IPC_CREDIT, DSH_PAGE_IPC_INSERT, DSH_PAGE_IPC_INVOKE, DSH_PAGE_IPC_KEYDOWN, DSH_PAGE_IPC_REBIND, DSH_PAGE_IPC_RENAME, DSH_PAGE_IPC_THEME, DSH_PAGE_IPC_WORKTREES, DSH_PAGE_SESSION_ARG, DSH_PAGE_SURFACE_ARG, DSH_PAGE_VIEW_ARG, DshPageEvent, IDshCreditPush, IDshInsertReference, IDshWorktreeOption, validateKeyEvent, validatePageCommand } from '../common/dshPageBridgeProtocol.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { backgroundForPageSurface, DshThemeTokens, IDshViewBackgrounds } from '../common/dshThemeBridge.js';
import { IIdeViewSlotForTargeting } from '../common/dshIdeTargeting.js';
import { IDshHostConnection } from './dshHostSupervisor.js';

const PRELOAD = 'vs/sessions/contrib/dshHarness/electron-browser/preload-dshView.js';

/** 页面健康看门狗：体检间隔（见 `_checkPageAlive`）。 */
const PAGE_WATCH_INTERVAL_MS = 15_000;
/** 连续几次判定"页面空白"才动手（避开路由切换/渲染中间态，防误伤）。 */
const PAGE_BLANK_STRIKES = 3;
/** 因白屏自动重载的次数上限（防"白屏 → 重载 → 又白屏"的循环）。 */
const PAGE_MAX_BLANK_RELOADS = 2;
/**
 * 页面是否"活着"的探针：**渲染进程在，但 DOM 里连 composer / 消息节点都没有** = 白屏或认证失败页。
 *
 * 锚点：`[data-composer-card]`（官方 composer 卡片的 data 钩子，我们的皮肤层一直用它 ✓ 不依赖 hash 类名）
 * 或任一 `[data-chat-flow-kind]` 消息节点（会话里已经有内容时也算活着 ✓）。
 *
 * ⚠ 2026-10-12 实测教训：这里**曾经**写成
 * `… || (window.__vssarosChatSurface && window.__vssarosChatSurface.loaded)`，
 * 而那个标志是**我们自己**插件写的 —— 认证失败页里插件照样加载、它照样是 true ⇒ 探针判"活着"，
 * 看门狗**一次都不触发**（日志实证：用户白屏时段内没有任何 `looks blank` 行）✗✗。
 * 判据必须是"**应用可用**"的信号，不能是"我们的插件加载了"。
 */
const PAGE_ALIVE_PROBE = '!!(document.querySelector("[data-composer-card]") || document.querySelector("[data-chat-flow-kind]"))';
/**
 * 白屏现场诊断：把**页面自己**的可观测量抓回日志（没有 DevTools 也能事后查）。
 *
 * 为什么需要：用户报"聊天框一定时间后白屏"，而 IDE 日志、Host 日志**都零痕迹**（Host 活着、
 * 视图没被隐藏、没有加载失败）⇒ 唯一能问的就只剩"页面自己现在是什么样"。
 * 抓的量都是**一眼能判断到哪一步**的：URL / readyState / body 子节点数 / 关键 DOM 钩子是否在 /
 * chat-surface 自报状态（`loaded`·`error`·`partErrors`）/ style 与 script 数量（判断"应用到底渲染了没"）。
 */
const PAGE_BLANK_DIAGNOSTIC = `(() => { try {
  const s = window.__vssarosChatSurface || {};
  const b = document.body;
  return JSON.stringify({
    href: location.href,
    readyState: document.readyState,
    title: document.title,
    bodyChildren: b ? b.children.length : -1,
    // 顶层 DOM 骨架（tag + class 前 40 字）：判断"应用根在不在、是空的还是根本没渲染"的最小可见物。
    // 2026-10-12 实测：bodyText 空 + bodyChildren=3 时，只有这一项能区分"根在但没内容"与"根本没有应用根"。
    bodySkeleton: b ? Array.prototype.slice.call(b.children, 0, 6).map(function (c) { return c.tagName + "." + String(c.className || "").slice(0, 40); }) : [],
    bodyText: b ? String(b.innerText || "").replace(/\\s+/g, " ").slice(0, 120) : "",
    bodyDataset: b ? Object.keys(b.dataset).slice(0, 20) : [],
    hasComposer: !!document.querySelector("[data-composer-card]"),
    styleTags: document.querySelectorAll("style").length,
    scripts: document.querySelectorAll("script[src]").length,
    // ★ 页面侧 JS 错误（chat-surface 装的环形缓冲，见 client.js）：**应用自己的**异常原文。
    // 2026-10-12 白屏只看到 bodyText:""（应用整片不渲染）时，这里就是唯一能回答"为什么"的东西。
    jsErrors: Array.isArray(window.__vssarosJsErrors) ? window.__vssarosJsErrors.slice(-5) : [],
    // ★ 页面**这一版** chat-surface chunk 有哪些字段 —— 用来一眼判定"页面跑的是不是最新 chunk"。
    // 2026-10-12 实测教训：lastOpenError 为 null 而 error 非 null，就说明页面跑的是**旧 chunk**
    // （新代码两个字段一起写）；只靠"有没有报错"根本分不出"代码旧"与"真的没出错" ✗。
    // ⚠ 本段是**模板字符串**：注释里绝不能出现反引号（会提前闭合字符串 ⇒ 整个文件语法错）。
    surfaceFields: Object.keys(s).sort(),
    surface: {
      loaded: s.loaded === true, opened: s.opened === true,
      // error = 当前是否坏着（成功打开时会清空）；lastError / lastOpenError = 历史留档 ✓
      error: s.error || null, lastError: s.lastError || null, lastOpenError: s.lastOpenError || null,
      attempts: s.attempts || 0, openRetries: s.openRetries || 0, openGiveUps: s.openGiveUps || 0,
      rebinds: s.rebinds || 0, workspaceError: s.workspaceError || null,
      sessionId: s.sessionId || null, partErrors: s.partErrors || null
    }
  });
} catch (e) { return "diag failed: " + String((e && e.message) || e); } })()`;

/**
 * 页面就绪后的**页面侧自证**（一次性，见 `_reportPageSurface`）：把"数据到了没 / chip 渲染了没"直接打进日志。
 *
 * 为什么必须有（2026-10-13 复盘"没有显示 worktree ui"）：主进程那行
 * `replayed N worktree option(s) after page load` 只证明**我们发出去了** —— 从"发出"到"用户看得见"
 * 还隔着两层：preload 把负载写进 `documentElement.dataset`、页面再按 `list.length === 0` 决定渲染
 * （见 `dsh-plugins/vssaros-chat-surface/lib/client.workspace.js:308-311`）。上一轮我们能证的只有第一层，
 * 后一层全靠猜 ✗。这条探针**一次读全**：`worktrees`/`worktreeItems` = 负载到没到页面，
 * `worktreeChip` = 真实 DOM 里有没有那枚 chip ⇒ 下次"UI 没出来"能一眼归因到哪一层 ✓。
 *
 * ⚠ 本段是**模板字符串**：里面不能出现反引号（会提前闭合字符串 ⇒ 整个文件语法错，已踩过一次）。
 */
const PAGE_SURFACE_REPORT = `(() => { try {
  const s = window.__vssarosChatSurface || {};
  const d = (document.documentElement && document.documentElement.dataset) || {};
  const raw = d.vssarosWorktrees || "";
  return JSON.stringify({
    worktrees: raw.length,
    worktreeItems: (raw.match(/\"path\"/g) || []).length,
    // ★ 2026-10-15：两枚 chip（🗂 工作区 / 🌿 worktree）已**合并**为单枚入口
    //   （client.workspace.js 的 vssaros-context-entry，方案 C：单 chip + 可搜索面板）
    //   ⇒ 自证只认这一个标记 ✓（旧的两个标记不再存在 ✗，认它们会永远 false ⇒ 假告警）。
    // ⚠ 本段是**模板字符串**：注释里绝不能出现反引号 ✗（会提前闭合 ⇒ 整个文件语法错；
    //   2026-10-15 我又踩了一次，被 tsgo 的 TS1005 当场抓到 ✓）。
    contextChip: !!document.querySelector("[data-vssaros-context-chip]"),
    presetChip: !!document.querySelector("[data-vssaros-preset-chip]"),
    // ★ 卡片动作自证（2026-10-13 用户报「点定位 / 点条目没反应」）：
    //   页面侧本来就记着计数与最近一次失败原因（client.cardActions.js 的 state.reveals /
    //   diffsOpened / lastDiffPath / terminalsOpened / cardActionError），但从前只在页面 state 里
    //   ⇒ 用户报"点了没反应"时我们连"点击到底到没到页面"都答不出，只能猜 ✗。
    //   数字 = 点了且桥调用成功（数字不动 = 没点到 / 桥调用失败 ⇒ 看 cardActionError）
    //   cardActionError = 页面侧 fail() 记的原因（它会同时弹一条 attention 通知 ✓）
    cardActions: s.cardActions === true,
    cardActionError: s.cardActionError || null,
    reveals: s.reveals || 0, lastRevealed: s.lastRevealed || null,
    diffsOpened: s.diffsOpened || 0, lastDiffPath: s.lastDiffPath || null,
    terminalsOpened: s.terminalsOpened || 0,
    // ★ 2026-10-13（用户报「Agent 人格读取失败（…不可达或未授权）—— chip 只有在选中过 agent 后才显示」）：
    //   agent chip 在不在 + 它报的是谁 + **读人格失败的真原因**，一起进快照 ⇒ 这类问题一眼归因 ✓
    //   （旧版这三样都没有：真原因只躺在页面 state 里，用户和我都只能看那句笼统通知 ✗）
    agentChip: !!document.querySelector("[data-vssaros-agent-chip]"),
    agentChipSource: s.agentChipSource || null, agentChipLabel: s.agentChipLabel || null,
    agentPreset: s.agentPreset || null, personaProbeError: s.personaProbeError || null,
    // ★ 2026-10-14（用户第二次问"chat-surface 是否缺少子智能体下拉 / 任务列表那两块 UI 的插件"）：
    //   加一条"页面**实际加载了哪些我们的 chunk**" —— 这是"插件改了却没生效"的唯一直接证据 ✓
    //   （当时的现象：仓库里源码 0.2.68 有两枚新 chunk，而页面上那两块 UI 一个都不在 ⇒ 只能靠
    //   state 字段形状 + 已装目录名**反向推**出"跑的是 0.2.66"，绕了一大圈 ✗）。
    //   为什么做在**宿主侧**、不写在插件里 ✗：那正是要诊断的东西 —— 插件旧的时候它自己也报不出
    //   版本（标记与被诊断对象一起缺失 ⇒ 盲区闭环 ✗）。这里读的是页面**真实发出的请求**，
    //   与插件新旧无关 ✓。
    //   为什么不用版本号：实测 chunk URL 形如 /plugins/@vssaros/dsh-chat-surface/client.hero.js?rev=…
    //   —— 路径里**没有版本** ✗（rev 是安装指纹，反推不出 semver ✗）⇒ 用"chunk 文件名集合"当代际
    //   证据（有没有 client.todos.js 比版本号更直接 ✓，chunk 名就是 PART_CHUNKS 里的那些名字 ✓）。
    ourChunks: (function () {
      try {
        var seen = [];
        var res = (typeof performance !== "undefined" && performance.getEntriesByType)
          ? (performance.getEntriesByType("resource") || []) : [];
        for (var i = 0; i < res.length; i++) {
          var n = String((res[i] && res[i].name) || "");
          if (n.indexOf("/@vssaros/dsh-chat-surface/") < 0) { continue; }
          var f = n.split("/").pop().split("?")[0];
          if (f && seen.indexOf(f) < 0) { seen.push(f); }
        }
        seen.sort();
        return seen;
      } catch (e) { return null; }
    })(),
    composer: !!document.querySelector("[data-composer-card]"),
    opened: s.opened === true, sessionId: s.sessionId || null
  });
} catch (e) { return "report failed: " + String((e && e.message) || e); } })()`;

/** 页面就绪到跑 {@link PAGE_SURFACE_REPORT} 的延时：给 dsh 应用把首屏（含插件 chunk）渲染完的时间。 */
const PAGE_SURFACE_REPORT_DELAY_MS = 4_000;

/**
 * 页面侧自证的**轮询间隔**：15 秒（只在快照**变化**时写日志 ⇒ 不吵 ✓）。
 *
 * 为什么要轮询而不是"就绪后跑一次"：用户是**几分钟后**才去点卡片上的「定位 / 看改动 / 在终端打开」的
 * ✗ ⇒ 一次性探针永远采不到那些点击（计数停在 0）⇒ 等于白加 ✗（2026-10-13 自查出来的设计缺陷）。
 * 现在：首次仍在 {@link PAGE_SURFACE_REPORT_DELAY_MS} 后跑，之后每 15 秒采一次，**内容没变就不写日志**
 * （`lastSurfaceReport` 比对 ✓）⇒ 点击、失败、chip 出现/消失都会被记下来，而安静的页面不产生噪声 ✓。
 */
const PAGE_SURFACE_REPORT_INTERVAL_MS = 15_000;
/**
 * 客户端连接抖动的**静默判稳窗口**（2026-10-15）：末次抖动后这么久没有新抖动，才报"已稳定"。
 * 依据：两个实例实测 dsh 退避阶梯的最大间隔 ≈9.6s（retry #1…#7 ✓）⇒ 20s 留一倍余量 ✓。
 * ⚠ 别用"自证快照能刷新"当判据 ✗ —— 快照走主进程→渲染进程的 executeJavaScript，与
 *   页面↔Host 的客户端连接是**两条通道** ✗（第一版就这么错的：+34.9s 早报"已稳定"，
 *   实际又抖到 +50s ✗）。
 */
const CONN_CHURN_QUIET_MS = 20_000;

/**
 * 认证 cookie 的续期间隔（见 `_refreshAuth`）：3 分钟。
 * 取这么密是因为它只是本机回环的一次请求（不跟随 303，只取 Set-Cookie），代价可忽略；
 * 而 dsh 的 cookie TTL 由 `maxAgeDays` 配置（`dsh-client-connection/lib/index.js:296`），我们不去猜它。
 */
const AUTH_REFRESH_INTERVAL_MS = 3 * 60_000;

interface IViewSlot {
	readonly id: string;
	readonly view: WebContentsView;
	readonly ownerWindowId: number;
	readonly surface: DshViewSurface;
	/** `surface=plugin-page` 的插件路由（方案 6.3）；其他 surface 为空。 */
	readonly route?: string;
	/**
	 * 插件页的承载表面（`sideview` / `editor`）：拼进页面 URL 的 `?surface=<值>`，让插件挑选渲染版本。
	 * ⚠ 与 `route` 分开存：`route` 必须保持"不含查询串"（`validatePluginRoute` 的口径）✓。
	 */
	readonly pageSurface?: string;
	attachedTo: BrowserWindow | undefined;
	visible: boolean;
	/**
	 * 加载重试预算 + "上一次主 frame 导航的状态码"（有界重试的真源，见 `common/dshViewLoadRetry.ts`）。
	 *
	 * 为什么要有上限：`did-fail-load` / `render-process-gone` 原来各自"只补一次"或"每次都补"——
	 * 前者一旦补的那次也失败就是**永久白屏**（用户只能看到一片空白的聊天框；2026-10-12 实测报障
	 * "dsh 聊天框启动后又消失了"），后者在页面持续崩溃时会变成**崩溃循环** ✗。
	 *
	 * 为什么还要记"上一次导航的状态码"：401 的**错误文档**也会走完 `did-finish-load`，在那里无条件
	 * 复位预算会把有界重试退化成 500ms 一次的无限循环（2026-10-12 实测 449 条 `retry 1/3`）✗。
	 */
	retry: IViewLoadRetryState;
	/**
	 * 页面健康看门狗定时器（**只在聊天页**、且首次加载成功后才挂）。
	 *
	 * 为什么需要：2026-10-12 用户报"dsh 聊天框**一定时间后**就白屏了"，而 IDE 日志里**零痕迹**
	 * （没有 did-fail-load、没有 401、没有 render-process-gone，Host 也一直活着）—— 即
	 * **页面侧**自己白掉了（dsh 应用内部的流/状态断了），而我们原来没有任何机制把它救回来，
	 * 用户只能重开 IDE ✗。这条看门狗就是那个缺失的出口。
	 */
	 watchdog?: ReturnType<typeof setInterval>;
	 /**
	 * **客户端连接抖动**记账（2026-10-15 加，用户报"初次启动该页面卡了一段时间才加载出 session"）。
	 *
	 * 实测这才是首启最后一段**可感知**等待：页面在 `ready+3.9s` 就加载完（`replayed … after page load` ✓）、
	 * `ready+7.9s` 连我们的合并入口 chip 都在（`contextChip: true` ✓），而后 dsh 客户端连接
	 * **阶梯重连 7 次直到 `ready+32.4s`**（退避 1/2/3/6/9/15s ✗），session 数据要等它稳下来才出来 ✓。
	 * ⇒ 不把这段记成一行账，就会误判成"页面加载慢 / 插件没生效" ✗（两者都已证伪 ✓）。
	 *
	 * ⚠ 只记账，**不动** dsh 的重试策略（那是官方 `dsh-client-connection` 的退避行为，改它=改别人的策略 ✗）。
	 */
	 connChurn?: { count: number; firstAt: number; lastAt: number; lastRetry: number; timer?: ReturnType<typeof setTimeout> };
	 /** 抖动小结只打一次（否则每 15 秒一轮的快照都会重复打同一句 ✗）。 */
	 connChurnReported?: boolean;
	/** 计费样本已回放到本次页面加载（页面池是活推送、重载即清零 ✗ ⇒ 每次导航补一遍；did-navigate 复位 ✓）。 */
	creditsReplayedAt?: number;
	/** 连续判定"页面空白"的次数（满 `PAGE_BLANK_STRIKES` 才重载）。 */
	blankChecks?: number;
	/** 已因白屏自动重载几次（上限 `PAGE_MAX_BLANK_RELOADS`，防循环）。 */
	blankReloads?: number;
	/**
	 * 已经为"这一轮白屏"报过现场（diagnostics + error）——**给放弃之后降噪**。
	 *
	 * 为什么必须降噪：2026-10-12 实测白屏持续了 45 分钟 ⇒ 每 45 秒一条相同的 `blank diagnostics` +
	 * `stays blank …` —— 几十条同义行把真正要看的上下文（Host / session.start / reload）全埋了 ✗。
	 * 页面活过来（或换 Host 重载）时复位 ✓。
	 */
	blankReported?: boolean;
	/**
	 * 最近一次推送的 **worktree 列表 / 主题 token 快照 —— 页面就绪后补发用**。
	 *
	 * 为什么必须缓存补发（2026-10-13 用户报障"**没有显示 worktree ui**"）：渲染进程在
	 * `DshHarnessService.createView()` 的 `.then()` 里立刻推一次，而那一刻页面**刚开始加载**、
	 * preload 的 `ipcRenderer.on` 尚未注册 ⇒ 这条 `send` 被 Electron **静默丢弃** ✗ ⇒ 页面
	 * `documentElement.dataset.vssarosWorktrees` 永远是 undefined ⇒ 那枚 chip 的
	 * `if (list.length === 0) return null` 恒成立 ⇒ **UI 一直不出现，且日志里零痕迹**
	 * （成功/失败都不打：失败走 `trace`）✗✗ —— 用户报障、我们只能靠猜，就是这么来的。
	 *
	 * 现在：主进程留快照，在 `did-finish-load`（页面真正就绪）时**补发一次** ✓；
	 * 顺带覆盖"页面重载 / 白屏自愈之后"——那之后同样需要这两份数据 ✓。
	 */
	lastWorktrees?: readonly IDshWorktreeOption[];
	lastThemeTokens?: DshThemeTokens;
	lastColorScheme?: DshColorScheme;
	/** 最近一次页面侧自证的**原文**（见 `_reportPageSurface`）：内容没变就不再写日志 ⇒ 低频轮询也不吵 ✓。 */
	lastSurfaceReport?: string;
	/**
	 * 页面 console 里去重过的消息（只用于**降噪**：同一句错误反复刷屏时只留第一次）。
	 * 见 `_wire` 里的 `console-message` 处理器。
	 */
	consoleSeen?: Set<string>;
	/** 当前绑定的 dsh 会话（surface=chat；rebind 会更新，视图重载后按它重发）。 */
	sessionId?: string;
	/** 目标 palette 模式（IDE 主题的 light/dark；create / pushTheme 设置）。 */
	colorScheme?: DshColorScheme;
	/**
	 * 视图底色候选（2026-10-13：修「初次打开侧栏视图会白屏一下」）。
	 *
	 * 渲染进程在 `createView` / `pushTheme` 时把「侧栏底色 + 编辑器底色」一起推来；
	 * 本进程按 `pageSurface` 挑一个，**建视图时就** `setBackgroundColor` ⇒ 页面画出第一帧之前
	 * 也不会露出 Electron 的默认白 ✗（原生视图盖在 DOM 上，用 CSS 挡不住 ✓）。
	 */
	backgrounds?: IDshViewBackgrounds;
	/** 已经过 emulation 对齐的模式（幂等用）。 */
	emulatedScheme?: DshColorScheme;
}

const OFFSCREEN = { x: -10000, y: -10000, width: 1024, height: 768 };

export class DshViewHost extends Disposable {

	/**
	 * dsh 视图用过的 Session（`session` getter 首次取用时登记）—— 供 `app.ts` 全局 `will-navigate` 守卫识别 dsh 视图。
	 *
	 * ★ 2026-10-15（用户报「记忆库『查看完整记忆』点了没反应」）：主进程日志每点一次就是一行
	 *   `webContents#will-navigate: Prevented webcontent navigation` ——`app.ts` 的 `web-contents-created`
	 *   对**所有** webContents 一律 `preventDefault`（只豁免了集成浏览器）⇒ 本类 `will-navigate` 里的
	 *   "同源放行"**从未生效** ✗ ⇒ 插件页的 `<a href>` / `<form method=get|post>` / `location.href` 全部静默失效。
	 *   ⇒ 与 `BrowserViewMainService.isBrowserViewWebContents` 同一范式：按 Session 识别、全局守卫跳过，
	 *   导航权限**完全交给本类**的守卫（同源 = Host 环回 origin 才放行；跨源 ⇒ 拒 + 外部打开；重定向同样只认同源 ✓）。
	 */
	private static readonly _knownSessions = new WeakSet<Session>();

	static isDshViewWebContents(contents: Electron.WebContents): boolean {
		return DshViewHost._knownSessions.has(contents.session);
	}

	private readonly _views = new Map<string, IViewSlot>();
	/** 认证 cookie 续期定时器（见 `_refreshAuth`；`setConnection` 重挂，断连时清掉）。 */
	private _authTimer: ReturnType<typeof setInterval> | undefined;
	/** 本连接内是否已成功续期过一次（`setConnection` 复位）——只用于"成功也留一行痕" ✓。 */
	private _authRefreshed = false;
	private readonly _watchedWindows = new Set<BrowserWindow>();
	private _session: Session | undefined;
	private _connection: IDshHostConnection | undefined;

	private readonly _onDidPageEvent = this._register(new Emitter<DshPageEvent>());
	readonly onDidPageEvent: Event<DshPageEvent> = this._onDidPageEvent.event;

	constructor(
		private readonly _windowsMainService: IWindowsMainService,
		private readonly _auxiliaryWindowsMainService: IAuxiliaryWindowsMainService,
		private readonly _logService: ILogService,
		/** 测试可替换；默认为 out 目录下编译好的 preload。 */
		private readonly _preloadPath: string = FileAccess.asFileUri(PRELOAD).fsPath,
	) {
		super();
	}

	private get session(): Session {
		if (!this._session) {
			// 仅测试使用：可用环境变量换成分区，避免多次运行共用持久分区里累积的 dsh-auth Cookie。
			const ses = electronSession.fromPartition(process.env.DSH_TEST_VIEW_PARTITION || DSH_VIEW_PARTITION);
			// 权限默认全拒；例外只有两个，且都只放行我们自己的 dsh Host（环回 origin）：
			// ① `media`：语音输入（voice-input bundle 的本地 SenseVoice）需要麦克风；
			// ② ★ 2026-10-15 剪贴板**写**（用户报"聊天框 copy 按钮点击没反应"）：CDP 实测 ——
			//    dsh 的复制按钮走 `navigator.clipboard.writeText`（**无降级** ✗），而本 partition 默认
			//    拒绝 ⇒ `permissions.query('clipboard-write')="denied"` + `writeText` 抛 NotAllowedError
			//    + `execCommand('copy')` 也 false ⇒ 静默失败 ✗✓。我们的皮**没有**吞点击
			//    （click path 全在 dsh 自己的 DOM、defaultPrevented=false ✓）⇒ 只能在这里放行。
			//    Chromium 新名 `clipboard-sanitized-write` / 旧名 `clipboard-write` 都要 ✓。
			const isOurHost = (requestingUrl?: string) =>
				!!this._connection && !!requestingUrl && requestingUrl.startsWith(this._connection.origin);
			const allow = (permission: string, requestingUrl?: string) =>
				isOurHost(requestingUrl) && (permission === 'media' || permission === 'clipboard-write' || permission === 'clipboard-sanitized-write');
			ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
				const d = details as { requestingUrl?: string } | undefined;
				callback(allow(permission, d?.requestingUrl));
			});
			ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allow(permission, requestingOrigin));
			DshViewHost._knownSessions.add(ses);
			this._session = ses;
		}
		return this._session;
	}

	/** Host 起停或重启（端口会变）时调用；已有视图重新加载到新的 Host，或在 Host 停止时清空页面。 */
	setConnection(connection: IDshHostConnection | undefined): void {
		const changed = connection?.origin !== this._connection?.origin;
		this._connection = connection;
		// 认证 cookie 续期定时器：连接（重）建立就重挂，断开就停 —— 见 `_refreshAuth` 的缘由。
		if (this._authTimer !== undefined) {
			clearInterval(this._authTimer);
			this._authTimer = undefined;
		}
		this._authRefreshed = false;
		if (connection) {
			this._authTimer = setInterval(() => void this._refreshAuth(), AUTH_REFRESH_INTERVAL_MS);
			this._authTimer.unref?.();
		}
		if (!changed) {
			return;
		}
		for (const slot of this._views.values()) {
			// 换了连接（Host 重启/换端口）= 认证 secret 与 authority 都变了 ⇒ 旧 cookie **必然作废**
			// （cookie 形如 `v1.<payload>.<hmac(secret)>`，payload 带 authority：`dsh-client-connection/lib/index.js:296-322`；
			//  而 cookie 按 **domain** 存、不区分端口 ⇒ 新端口的请求会把旧 cookie 一起带上、被判无效 ✗）。
			// ⇒ 这次重载**直接切到带 token 的 authUrl**，省掉"先 401 再补救"的一跳与那一瞬的认证错误页 ✓。
			slot.retry = withAuthRetry(resetViewLoadRetry());
			if (connection) {
				void this._load(slot);
			} else if (!slot.view.webContents.isDestroyed()) {
				void slot.view.webContents.loadURL('about:blank');
			}
		}
	}

	has(viewId: string): boolean {
		return this._views.has(viewId);
	}

	/**
	 * 视图槽位的**快照**（只取"定位这次 IDE 请求该投给哪个窗口"需要的两格）。
	 *
	 * 请求里带 `sessionId`（Host 侧从 `exec.agent.session.id` 取）时，这里就能答出"正在跑这个会话的
	 * 窗口是哪个"；策略在 `common/dshIdeTargeting.ts`（纯逻辑、可单测）。
	 */
	viewSlots(): readonly IIdeViewSlotForTargeting[] {
		return [...this._views.values()].map(slot => ({
			ownerWindowId: slot.ownerWindowId,
			...(slot.sessionId === undefined ? {} : { sessionId: slot.sessionId }),
		}));
	}

	/**
	 * 把一条通知**定向**投给某个窗口（`channel` 上的 `notification`）。
	 *
	 * 与 `IWindowsMainService.sendToFocused` 用的是同一条原语（`ICodeWindow.sendWhenReady`：
	 * 窗口就绪才发）。窗口已经不在了（用户关了它）⇒ `false`，调用方据此**退回广播**，
	 * 不让这次能力请求挂在"发给了一个不存在的窗口"上。
	 */
	sendToWindow(windowId: number, channel: string, notification: string, payload: unknown): boolean {
		// 用 `getWindowById`（与 `_windowById` 同一个原语）：主窗口都能解出来，辅助窗口解不出时返回 false
		// ⇒ 调用方退回广播（辅助窗口里的 dsh 视图很少见，不值得为它多一条投递路径）。
		const window = this._windowsMainService.getWindowById(windowId);
		if (!window) {
			return false;
		}
		try {
			window.sendWhenReady(channel, CancellationToken.None, notification, payload);
			return true;
		} catch (e) {
			this._logService.warn(`[dshHarness] 定向投递到窗口 ${windowId} 失败：${String((e as Error)?.message ?? e)}`);
			return false;
		}
	}

	create(viewId: string, ownerWindowId: number, surface: DshViewSurface, chatOnlyUi = true, sessionId?: string, colorScheme?: DshColorScheme, route?: string, pageSurface?: string, backgrounds?: IDshViewBackgrounds): void {
		if (this._views.has(viewId)) {
			return;
		}
		if (sessionId) {
			const other = this._sessionBoundInOtherWindow(sessionId, ownerWindowId);
			if (other) {
				// **只警告、不阻止**：这条路是派生规则落到了同一会话（两个窗口开同一工作区必然如此），
				// 拦住它等于第二个窗口的聊天面板整个打不开（`createView` 失败 ⇒ pane 停在占位状态）。
				// 代价说清楚：那个会话的 IDE 能力请求会被拒绝（README 4.49）。
				this._logService.warn(`[dshHarness] 会话 ${sessionId} 已在窗口 ${other.ownerWindowId} 打开，本窗口 ${ownerWindowId} 也开了同一个：该会话的 IDE 能力请求会被拒绝（分不清该落在哪）`);
			}
		}
		const view = new WebContentsView({
			webPreferences: {
				session: this.session,
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true,
				webviewTag: false,
				spellcheck: false,
				preload: this._preloadPath,
				additionalArguments: [`${DSH_PAGE_SURFACE_ARG}${surface}`, `${DSH_PAGE_CHAT_ONLY_ARG}${chatOnlyUi ? '1' : '0'}`, `${DSH_PAGE_SESSION_ARG}${sessionId ?? ''}`, `${DSH_PAGE_VIEW_ARG}${viewId}`],
			},
		});
		view.setBounds(OFFSCREEN);
		view.setVisible(false);
		const slot: IViewSlot = { id: viewId, view, ownerWindowId, surface, route: surface === 'plugin-page' ? route : undefined, pageSurface: surface === 'plugin-page' ? pageSurface : undefined, attachedTo: undefined, visible: false, retry: newViewLoadRetryState(), blankChecks: 0, blankReloads: 0, colorScheme, sessionId: sessionId || undefined, backgrounds };
		// ★ 染色必须在**任何一次 attach / setVisible(true) 之前**（否则中间那几毫秒照样露白 ✗）
		this._applyViewBackground(slot);
		this._wire(slot);
		this._views.set(viewId, slot);
		if (this._connection) {
			void this._load(slot);
		}
	}

	layout(viewId: string, bounds: IDshViewBounds): void {
		const slot = this._views.get(viewId);
		if (!slot) {
			return;
		}
		if (slot.attachedTo?.id !== bounds.windowId || slot.attachedTo.isDestroyed()) {
			const target = this._windowById(bounds.windowId);
			if (target) {
				if (slot.attachedTo && !slot.attachedTo.isDestroyed()) {
					slot.attachedTo.contentView.removeChildView(slot.view);
				}
				target.contentView.addChildView(slot.view);
				slot.attachedTo = target;
				this._watchWindow(target);
			}
		}
		slot.view.setBounds({
			x: Math.round(bounds.x * bounds.zoomFactor),
			y: Math.round(bounds.y * bounds.zoomFactor),
			width: Math.max(0, Math.round(bounds.width * bounds.zoomFactor)),
			height: Math.max(0, Math.round(bounds.height * bounds.zoomFactor)),
		});
	}

	setVisible(viewId: string, visible: boolean): void {
		const slot = this._views.get(viewId);
		if (!slot || slot.visible === visible) {
			return;
		}
		slot.visible = visible;
		slot.view.setVisible(visible);
		if (!visible) {
			slot.view.setBounds(OFFSCREEN);
		}
	}

	/**
	 * **抓一帧 + 把视图藏起来**（一次主进程内的原子操作），返回那一帧（JPEG dataURL；抓不到 `undefined`）。
	 *
	 * 为什么需要（2026-10-15 用户报：鼠标 hover 活动栏的 workspace 图标，侧栏 sideview 内容消失）：
	 * 原生视图永远盖在 DOM 之上 ⇒ 要让 tooltip / 菜单**看得见**就只能把视图藏起来
	 * （`dshPluginViewPane._checkOverlays` 干的就是这件事，真机取证：注入一个 `.monaco-hover`
	 * 250ms 内 `data-overlay=true, data-shown=false` ✓）。而藏起来那一刻，那一块只剩一个
	 * **占位 div** ⇒ 贴一帧回占位，观感才是"内容一直在 + 浮层浮在上面" ✓。
	 *
	 * ⚠ **为什么必须合成一步（2026-10-15 真机复测的第二次失败）**：如果渲染侧先发"抓帧"、再发"藏起来"
	 * 两条 IPC，两者在主进程里**赛跑** —— `capturePage()` 是异步的（要等合成器给帧），而 `setVisible(false)`
	 * + `setBounds(OFFSCREEN)` 一旦先落地，抓到的就是**离屏空帧**（实测：`bgImage` 恒为 `none`，
	 * 表现与"完全没做这件事"一样 ✗）。所以顺序必须由主进程**在一个函数里**保证：先抓（此刻视图还可见
	 * ⇒ 一定是真画面），再藏 ✓。
	 *
	 * 失败一律 `undefined`（视图没了 / 抓图抛错）——**但让位照样执行**（浮层可见性优先于好看：
	 * 藏起来 + 主题底色，仍然比"浮层被原生视图盖住"强 ✓）。
	 */
	async captureAndHide(viewId: string): Promise<string | undefined> {
		const slot = this._views.get(viewId);
		const webContents = slot?.view.webContents;
		let frame: string | undefined;
		if (webContents && !webContents.isDestroyed()) {
			try {
				const image = await webContents.capturePage();
				if (!image.isEmpty()) {
					frame = `data:image/jpeg;base64,${image.toJPEG(82).toString('base64')}`;
				}
			} catch (e) {
				this._logService.trace(`[dshHarness] captureAndHide(${viewId}) capture failed: ${String((e as Error)?.message ?? e)}`);
			}
		}
		this.setVisible(viewId, false);
		return frame;
	}

	focus(viewId: string): void {
		const slot = this._views.get(viewId);
		if (slot?.visible && !slot.view.webContents.isDestroyed()) {
			slot.view.webContents.focus();
		}
	}

	/** 向页面推主题 token 覆盖层（方案 5.13.2 P2）；**先留快照**，页面未就绪时由 did-finish-load 补发（见 IViewSlot 注释）。 */
	pushTheme(viewId: string, tokens: DshThemeTokens, colorScheme?: DshColorScheme, backgrounds?: IDshViewBackgrounds): void {
		const slot = this._views.get(viewId);
		if (!slot) {
			return;
		}
		slot.lastThemeTokens = tokens;
		if (colorScheme) {
			slot.lastColorScheme = colorScheme;
			slot.colorScheme = colorScheme;
			void this._emulateColorScheme(slot, colorScheme);
		}
		// ★ 主题变了 ⇒ 原生视图底色也要跟着变（否则切到浅色主题后，未画出第一帧的视图还是深色 ✗）
		if (backgrounds) {
			slot.backgrounds = backgrounds;
			this._applyViewBackground(slot);
		}
		if (!slot.view.webContents.isDestroyed()) {
			slot.view.webContents.send(DSH_PAGE_IPC_THEME, tokens);
		}
	}

	/**
	 * 把视图底色刷成**当前主题对应位置**的颜色（2026-10-13：修「初次打开侧栏视图白屏一下」）。
	 *
	 * 位置判据只有 `pageSurface`（`'editor'` = 编辑器区；其余 = 侧栏 —— chat / sessions / full 都落在侧栏 ✓）。
	 * 取不到色（主题没给 `sideBar.background` 之类的极端情况）⇒ **什么都不做**（保持上一次的值，而不是退回白 ✗）。
	 */
	private _applyViewBackground(slot: IViewSlot): void {
		if (slot.view.webContents.isDestroyed()) {
			return;
		}
		const color = backgroundForPageSurface(slot.backgrounds, slot.pageSurface);
		if (!color) {
			return;
		}
		slot.view.setBackgroundColor(color);
	}

	/**
	 * 周期性把 dsh 的认证 cookie 在**视图分区**里续上：用同一个 `authUrl`（带 token）发一次请求，
	 * Host 会 303 并 `Set-Cookie`（`dsh-client-connection/lib/index.js:296` 的 `dsh-auth-*`）。
	 *
	 * 为什么必须这么做（2026-10-12 用户报障 + 截图实证）：聊天页会变成**纯黑底一行灰字**
	 * `dsh web authentication required; reopen the URL printed by dsh web.` —— 页面在、Host 也在，
	 * **只是那份 cookie 失效了**；而 dsh 客户端遇到 401 只会显示这句提示，**既不重试也不产生导航**
	 * ⇒ 我们既有的 `did-navigate(401)` 恢复路径永远碰不到 ✗，用户只能"重开 IDE"（日志佐证：重启后
	 * 复用**同一个** Host、同一个 authUrl 就恢复 ⇒ token 一直有效，失效的只有 cookie ✓）。
	 * 定时续期等于把"用户重启 IDE"这件事自动化；看门狗（`_checkPageAlive`）是漏网时的兜底 ✓。
	 */
	private async _refreshAuth(): Promise<void> {
		const conn = this._connection;
		if (!conn) {
			return;
		}
		try {
			// ⚠⚠ **必须 `redirect: 'follow'`**（2026-10-12 日志实证的坑）：上一版写 `redirect: 'manual'`，
			// 而 Electron 的 `net.fetch` 对 manual 的语义是"**取消**这次重定向并 reject"⇒ 每 3 分钟一条
			// `[dshHarness] auth refresh failed: Redirect was cancelled`，dsh 的 303 **永远走不完**、
			// `Set-Cookie` 落不到分区 ⇒ 续期形同没写（cookie 一直用旧的 ⇒ 到点就被 dsh 判未认证）✗✗。
			// 跟随 303 只是多下载一次应用外壳 HTML（本机回环、3 分钟一次，可忽略），换来 cookie 真的续上 ✓。
			const res = await this.session.fetch(conn.authUrl, { redirect: 'follow' });
			const cookies = await this.session.cookies.get({ url: conn.origin }).catch(() => []);
			const auth = cookies.filter(c => c.name.startsWith('dsh-auth')).length;
			if (res.status >= 400) {
				this._logService.warn(`[dshHarness] auth refresh got HTTP ${res.status} (dsh-auth cookies: ${auth})— cookie 可能已失效，页面会显示 authentication required`);
				return;
			}
			// 成功只打一次（每次换连接复位）：这是"续期到底有没有真的落 cookie"的唯一自证 ✓
			if (!this._authRefreshed) {
				this._authRefreshed = true;
				this._logService.info(`[dshHarness] auth cookie refreshed (HTTP ${res.status}, dsh-auth cookies: ${auth})`);
			}
		} catch (e) {
			this._logService.warn(`[dshHarness] auth refresh failed: ${String((e as Error)?.message ?? e)}`);
		}
	}

	/**
	 * 向页面推 worktree 列表（dsh 聊天 header 的 worktree 下拉用；机制同 {@link pushTheme}）。
	 * 页面未加载/已销毁时静默丢弃 —— 推送是**幂等快照**，视图建立时（`createView` 之后）会再推一次 ✓。
	 */
	pushWorktrees(viewId: string, options: readonly IDshWorktreeOption[]): void {
		const slot = this._views.get(viewId);
		if (!slot) {
			return;
		}
		// 先留快照：此刻页面很可能还没就绪（渲染进程是在 createView().then() 里立刻推的，
		// preload 监听尚未注册 ⇒ send 会被丢弃）⇒ 靠 did-finish-load 补发 ✓（见 IViewSlot 注释）。
		slot.lastWorktrees = options;
		if (!slot.view.webContents.isDestroyed()) {
			slot.view.webContents.send(DSH_PAGE_IPC_WORKTREES, options);
		}
	}

	/**
	 * 把页面的 prefers-color-scheme 对齐到 IDE 主题的 light/dark（方案 5.13.2 主题模式对齐）。
	 * dsh 的弹层 / 圆角 / 字体等**非 alias** token 跟随 palette 模式（`body[data-ds-dark-theme]`），
	 * overrideTokens 只覆盖 alias 层（校验只放行 `--dsw-alias-*`）、够不到它们；emulation 不写 dsh
	 * 偏好，且按幂等跳过重复设置。debugger 被占用（如打开 DevTools）时降级为仅 token 覆盖。
	 */
	private async _emulateColorScheme(slot: IViewSlot, scheme: DshColorScheme): Promise<void> {
		if (slot.emulatedScheme === scheme) {
			return;
		}
		const wc = slot.view.webContents;
		if (wc.isDestroyed()) {
			return;
		}
		try {
			if (!wc.debugger.isAttached()) {
				wc.debugger.attach('1.3');
			}
			// 超时兜底：debugger 命令在页面未就绪（about:blank）时可能挂起，超时后放弃，交给 dom-ready / 下次推送再补。
			await Promise.race([
				wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }),
				new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('emulate timeout')), 1500)),
			]);
			slot.emulatedScheme = scheme;
		} catch (e) {
			this._logService.warn(`[dshHarness] emulate prefers-color-scheme failed for ${slot.id}: ${String((e as Error)?.message ?? e)}`);
		}
	}

	/** 向页面发「插入文件引用」（方案 5.5 onInsertReference）。 */
	insertReference(viewId: string, reference: IDshInsertReference): void {
		const slot = this._views.get(viewId);
		if (slot && !slot.view.webContents.isDestroyed()) {
			slot.view.webContents.send(DSH_PAGE_IPC_INSERT, reference);
		}
	}

	/**
	 * 同一个会话是否已经绑在**另一个窗口**的视图上（`undefined` = 没有）。
	 *
	 * 为什么会有这种状态：会话 id 是 `vssaros-chat-<chatId>`（**不含窗口号**），而视图 id 是
	 * `dsh-chat-w<窗口号>-<chatId>`（含）。所以"同一工作区开两个窗口"会自然派生**同一个会话**。
	 * 这时一次 IDE 能力请求就分不清该落在哪个窗口 ⇒ 那种请求会被**明确拒绝**（见
	 * `common/dshIdeTargeting.ts` 与通道里的 `_requestIdeInRenderer`）。
	 * 同窗口内多个视图绑同一会话**不算冲突**（都指向同一个窗口，定向仍然唯一）。
	 */
	private _sessionBoundInOtherWindow(sessionId: string, ownWindowId: number): IViewSlot | undefined {
		for (const slot of this._views.values()) {
			if (slot.surface === 'chat' && slot.sessionId === sessionId && slot.ownerWindowId !== ownWindowId) {
				return slot;
			}
		}
		return undefined;
	}

	/**
	 * 重绑视图到另一个 dsh 会话（方案 5.15 切 preset）：更新 slot 记录并推给页面；
	 * 页面重载（reload / 渲染进程重建）后 dom-ready 会按 slot 记录重发，保持绑定不回落。
	 *
	 * **拒绝**绑到"另一个窗口已经在用的会话"（README 4.49）：这一步是**显式**指定一个会话
	 * （preset 切换 / 历史会话菜单 / 换 worktree），不像 `create` 那样由派生规则自动落到同一 id ⇒
	 * 拒绝的代价只是"这次换绑不生效、面板留在原会话"，而放过的代价是留下一个分不清归属的绑定。
	 */
	rebindSession(viewId: string, sessionId: string): void {
		const slot = this._views.get(viewId);
		if (!slot || slot.surface !== 'chat') {
			return;
		}
		const other = this._sessionBoundInOtherWindow(sessionId, slot.ownerWindowId);
		if (other) {
			const message = `会话 ${sessionId} 已在窗口 ${other.ownerWindowId} 打开：同一个会话不能同时绑到两个窗口（否则 IDE 能力分不清该落在哪）。请先关掉那个窗口里的该会话，或改选别的会话`;
			this._logService.warn(`[dshHarness] 拒绝重绑视图 ${viewId}：${message}`);
			throw new Error(message);
		}
		slot.sessionId = sessionId;
		if (!slot.view.webContents.isDestroyed()) {
			slot.view.webContents.send(DSH_PAGE_IPC_REBIND, { sessionId });
		}
	}

	/**
	 * 把「重命名会话」请求推给页面（页面侧调 dsh 的 `ctx.sessions.rename`）。
	 * 与 rebindSession 同机制同约束：只推给 chat 视图、webContents 未销毁时才发；
	 * 负载只承载展示文本（标题），不传会话内容。
	 */
	renameSession(viewId: string, title: string): void {
		const slot = this._views.get(viewId);
		if (!slot || slot.surface !== 'chat') {
			return;
		}
		if (!slot.view.webContents.isDestroyed()) {
			slot.view.webContents.send(DSH_PAGE_IPC_RENAME, { title });
		}
	}

	/**
	 * 把一个计费样本推给**所有 chat 视图**（计费探针代理抓到的 `usage.credit`）。
	 *
	 * 为什么广播而不是定向：代理看到的是回环 HTTP 请求（只有 route/model，没有会话身份），主进程
	 * 无从判断它属于哪个视图 ⇒ 归属交给页面按**回合时间窗**做（`client.usage.js` 的 `creditInWindow`，
	 * 并用 provider/model 过滤掉其它会话的请求）。要做到精确定向需要 dsh 在请求里带会话 id，
	 * 而 pi-ai 的 openai-completions compat 目前没有会话亲和头。
	 */
	/** 计费样本回放源（channel 注入 ✓）：视图自证就绪后补发给页面（页面侧样本池是"活推送"，重载即清零 ✗）。 */
	private _creditReplaySource: (() => readonly IDshCreditPush[]) | undefined;
	setCreditReplaySource(source: () => readonly IDshCreditPush[]): void {
		this._creditReplaySource = source;
	}

	pushCredit(sample: IDshCreditPush): void {
		for (const slot of this._views.values()) {
			if (slot.surface !== 'chat' || slot.view.webContents.isDestroyed()) {
				continue;
			}
			slot.view.webContents.send(DSH_PAGE_IPC_CREDIT, sample);
		}
	}

	reload(viewId: string): void {
		const slot = this._views.get(viewId);
		if (slot) {
			slot.retry = resetViewLoadRetry();   // 手动重载 = 新一轮，重新给足重试机会（否则一次失败后手动重载也不再有救）
			void this._load(slot);
		}
	}

	disposeView(viewId: string): void {
		const slot = this._views.get(viewId);
		if (slot?.watchdog !== undefined) {
			clearInterval(slot.watchdog);
			slot.watchdog = undefined;
		}
		// 抖动判稳的定时器也要清（否则视图没了还会去打那行小结 ✗；回调里虽有 _views 检查兜底，但别把垃圾留着 ✓）
		if (slot?.connChurn?.timer) {
			clearTimeout(slot.connChurn.timer);
			slot.connChurn.timer = undefined;
		}
		if (!slot) {
			return;
		}
		this._views.delete(viewId);
		if (slot.attachedTo && !slot.attachedTo.isDestroyed()) {
			slot.attachedTo.contentView.removeChildView(slot.view);
		}
		if (!slot.view.webContents.isDestroyed()) {
			slot.view.webContents.close({ waitForBeforeUnload: false });
		}
	}

	/**
	 * 渲染进程重载或窗口关闭后，回收该窗口**上一个 renderer 留下的**视图（它的 pane 已经不存在）。
	 *
	 * `keep` = 当前 renderer 自己创建的视图 id（`DshHarnessService._ownViews`）：**必须保留**。
	 * 这条不是优化而是修 bug——Host 被抢先启动后，聊天视图在工作台启动早期就建好了，而回收命令
	 * 在工作台 `Eventually` 相位才跑，无条件清空会把**当前**视图也一起销毁：用户看到"聊天框一闪就没了"。
	 */
	disposeViewsOfWindow(windowId: number, keep?: readonly string[]): number {
		const keepSet = new Set(keep ?? []);
		let n = 0;
		for (const slot of [...this._views.values()]) {
			if (keepSet.has(slot.id)) {
				continue;
			}
			if (slot.ownerWindowId === windowId || slot.attachedTo?.id === windowId) {
				this.disposeView(slot.id);
				n++;
			}
		}
		return n;
	}

	get size(): number {
		return this._views.size;
	}

	/** 诊断：视图池现状（不含 URL，避免泄露端口外的任何页面信息）。 */
	describe(): IDshViewInfo[] {
		return [...this._views.values()].map(s => ({
			viewId: s.id,
			surface: s.surface,
			...(s.route ? { route: s.route } : {}),
			ownerWindowId: s.ownerWindowId,
			attachedWindowId: s.attachedTo && !s.attachedTo.isDestroyed() ? s.attachedTo.id : undefined,
			visible: s.visible,
			nativeVisible: s.view.getVisible(),
			bounds: s.view.getBounds(),
		}));
	}

	// ─── 内部 ────────────────────────────────────────────────────────────────

	/**
	 * 已有 Cookie 时直接加载 origin（plugin-page 时带上插件路由）；Host 重启后旧 Cookie 可能失效（401），
	 * 此时用带 token 的认证 URL 再试一次（token 交换同样落到该路由上）。
	 */
	private async _load(slot: IViewSlot): Promise<void> {
		const conn = this._connection;
		if (!conn || slot.view.webContents.isDestroyed()) {
			return;
		}
		// 这条链"要重新认证"（换 Host/401/白屏看门狗置了 `retriedAuth`）时，先用 `session.fetch(authUrl)`
		// 把 cookie **可靠地**提交进分区（303 follow 会同步落 cookie，见 `_refreshAuth` 的实证注释），
		// 再按"cookie 已在"选 URL。⚠ 不要再赌 `loadURL(authUrl)` 的 HTTP 重定向去给 webview 写 cookie ——
		// 2026-10-13 用户报"聊天框空白"：Host 重启后那一步写了但没生效 ⇒ 永远 401 ⇒ 白屏（探针也复现）。
		if (slot.retry.retriedAuth) {
			await this.session.fetch(conn.authUrl, { redirect: 'follow' })
				.catch(() => { /* fetch 失败就交给下面的 loadURL（回退 authUrl）与有界重试兜底 */ });
		}
		const cookies = await this.session.cookies.get({ url: conn.origin }).catch(() => []);
		const hasAuth = cookies.some(c => c.name.startsWith('dsh-auth'));
		const url = resolveViewUrl({
			origin: conn.origin,
			authUrl: conn.authUrl,
			route: slot.route ?? '/',
			// `retriedAuth` 的链上面已用 fetch 重建过 cookie ⇒ 这里直接按"cookie 是否在"选：在就裸
			// origin（省一跳重定向），不在（fetch 也失败）才回退带 token 的 authUrl。
			hasAuth,
			// 承载表面 → `?surface=<值>`（只对插件页生效，官方 Web Client 那条路逐字符不变 ✓）
			surface: slot.pageSurface,
		});
		try {
			await slot.view.webContents.loadURL(url);
		} catch (e) {
			// loadURL 在重定向、被导航替换时会 reject（ERR_ABORTED），不是真正的失败。
			// Electron 这个错误可能只带 errno:-3 而没有 code（实测消息形如 " (-3) loading '…'"），
			// 两种形态都要认，否则良性中断会被记成失败、掩盖真正的失败。
			const err = e as { code?: string; errno?: number };
			const benign = err?.code === 'ERR_ABORTED' || err?.errno === -3;
			const disposed = this._views.get(slot.id) !== slot || slot.view.webContents.isDestroyed();
			if (!benign && !disposed) {
				this._logService.warn(`[dshHarness] view ${slot.id} load failed: ${String((e as Error)?.message ?? e).replace(/token=[^\s&]+/g, 'token=<redacted>')}`);
			}
		}
	}

	/**
	 * 主 frame 加载失败 / 401 / 渲染进程崩溃后的**有界重试**（线性退避：500/1000/1500ms）。
	 *
	 * `useAuthUrl`：把这次重试切到带 token 的 `authUrl`（`_load` 依据 `slot.retry.retriedAuth` 选 URL）——
	 * 401 与加载失败通常就是"cookie 失效/未建立"，带 token 是唯一有效的补法。
	 * 计数与"何时复位预算"的判据都在 `common/dshViewLoadRetry.ts`（纯逻辑 + 单测）：**只有"上一次
	 * 主 frame 导航不是 401"才算加载成功**。曾经在 `did-finish-load` 里无条件复位 ⇒ 401 的错误文档
	 * 把重试变成 500ms 一次的无限循环（2026-10-12 实测 449 条 `retry 1/3`，计数永远是 1）✗。
	 * 超过上限后**明确报 error 并停手**（不再重试 ⇒ 不会崩溃循环），但留下一句可查的日志：
	 * "白屏 + 日志里什么都没有"是更早一版最难查的形态（用户只看到一片空白，我们这边零线索 ✗）。
	 */
	private _retryLoad(slot: IViewSlot, reason: string, useAuthUrl = false): void {
		if (this._views.get(slot.id) !== slot || slot.view.webContents.isDestroyed()) {
			return;
		}
		const plan = planLoadRetry(slot.retry, { useAuthUrl });
		slot.retry = plan.state;
		if (!plan.retry) {
			this._logService.error(`[dshHarness] view ${slot.id} still blank after ${VIEW_LOAD_MAX_RETRIES} retries (${reason}) — 不再自动重试；请重开该页签或重启 Host（DevTools 可看页面异常）`);
			return;
		}
		this._logService.info(`[dshHarness] view ${slot.id} load retry ${plan.attempt}/${VIEW_LOAD_MAX_RETRIES} in ${plan.delayMs}ms (${reason})`);
		setTimeout(() => {
			if (this._views.get(slot.id) === slot && !slot.view.webContents.isDestroyed()) {
				void this._load(slot);
			}
		}, plan.delayMs);
	}

	/**
	 * 挂上"页面白屏"看门狗（**聊天页专用**，幂等；首次加载成功后由 `did-finish-load` 调用）。
	 *
	 * 起因（2026-10-12 用户报障："dsh 聊天框**一定时间后**就白屏了"）：排查时 IDE 日志里什么都没有
	 * —— 没有 `did-fail-load`、没有 401 导航、没有 `render-process-gone`，Host 进程与它的 HTTP 也一直活着
	 * ⇒ 是**页面侧**自己白掉的（dsh 应用内部的流/状态断了），而当时**没有任何机制把它救回来**，
	 * 用户只能重开 IDE（日志时间线佐证：17:39:39 的 `bridge closed` 是用户因白屏重启时的正常退出产物，
	 * 紧接着 17:40:19 就是新实例）✗。
	 *
	 * 判据：**渲染进程活着，但 DOM 里连 composer 都没有**（`PAGE_ALIVE_PROBE`）⇒ 连续
	 * `PAGE_BLANK_STRIKES` 次（≈45s）就重载一次，最多 `PAGE_MAX_BLANK_RELOADS` 次（防循环）。
	 * 重载会顺带走既有的认证回退链（cookie → `authUrl` 带 token），所以"cookie 过期型白屏"也被覆盖 ✓。
	 */
	/**
	 * 页面就绪后**补发**最近一次推送的快照（worktree / 主题）。
	 *
	 * 为什么必须有这一步：渲染进程的推送发生在 `createView().then()` —— 那一刻页面刚开始加载、
	 * preload 的 `ipcRenderer.on` 还没注册 ⇒ `webContents.send` 被**静默丢弃** ✗。表现就是
	 * "worktree 那枚 chip 从来不出现"（页面里列表恒为空 ⇒ 组件按设计 `return null`），
	 * 而日志里既没有成功行也没有失败行（失败走 `trace`）⇒ 报障时只能靠猜 ✗✗。
	 * 覆盖 `did-finish-load`（含普通重载与白屏自愈后的重载）⇒ 每次页面就绪都能拿到数据 ✓。
	 * 重复补发是安全的：preload 收到就写 dataset + 派 DOM 事件，页面按幂等快照处理 ✓。
	 */
	private _replayPushedSnapshots(slot: IViewSlot): void {
		const wc = slot.view.webContents;
		if (wc.isDestroyed()) {
			return;
		}
		try {
			if (slot.lastWorktrees) {
				wc.send(DSH_PAGE_IPC_WORKTREES, slot.lastWorktrees);
				this._logService.info(`[dshHarness] view ${slot.id} replayed ${slot.lastWorktrees.length} worktree option(s) after page load`);
			}
			if (slot.lastThemeTokens) {
				wc.send(DSH_PAGE_IPC_THEME, slot.lastThemeTokens);
			}
		} catch (e) {
			this._logService.trace(`[dshHarness] view ${slot.id} replay failed: ${String((e as Error)?.message ?? e)}`);
		}
	}

	/**
	 * 延时跑一次 {@link PAGE_SURFACE_REPORT} 并把结果写进日志（见该常量的注释）。
	 *
	 * 口径：**数据到了页面、但 chip 没渲染** ⇒ 升为 `warn`（这是"用户报 UI 没出来"时唯一要看的信号，
	 * 别的组合都是正常态：没数据没 chip 是对的）；其余打 `info` 一行 ✓。
	 */
	private async _reportPageSurface(slot: IViewSlot, delayMs: number): Promise<void> {
		await new Promise<void>(resolve => setTimeout(resolve, delayMs));
		if (this._views.get(slot.id) !== slot || slot.view.webContents.isDestroyed()) {
			return;
		}
		try {
			const text = String(await slot.view.webContents.executeJavaScript(PAGE_SURFACE_REPORT, true));
			// ★ 2026-10-15（用户报"积分 chip 一直 —"）：自证成功 = 页面里我们的 chunk 已挂载（监听器在 ✓）
			//   ⇒ 此刻把最近的计费样本**补发**一遍 —— 页面侧池是"活推送"、重载即清零 ✗，历史回合的
			//   「积分」chip 靠这次补发点亮 ✓。每次导航只补一次（`did-navigate` 复位 ✓；重复补发会
			//   重复计数 ✗ —— 页面是按时间窗求和的）。
			if (!slot.creditsReplayedAt && this._creditReplaySource) {
				slot.creditsReplayedAt = Date.now();
				const backlog = this._creditReplaySource();
				for (const sample of backlog) {
					slot.view.webContents.send(DSH_PAGE_IPC_CREDIT, sample);
				}
				if (backlog.length) {
					this._logService.info(`[dshHarness] view ${slot.id} 回放 ${backlog.length} 条积分样本（页面重载清空页面侧池 ⇒ 就绪补发 ✓）`);
				}
			}
			if (slot.lastSurfaceReport !== text) {
				// 只在**快照变化**时写日志 ⇒ 15 秒一轮也不吵，而"用户点了一下"必然让计数变化 ⇒ 一定被记下 ✓
				slot.lastSurfaceReport = text;
				const items = /"worktreeItems":(\d+)/.exec(text);
				const chip = /"contextChip":(true|false)/.exec(text);
				// 卡片动作的失败原因（页面 `fail()` 写进 state.cardActionError）——含引号也吃得下
				const cardErr = /"cardActionError":"((?:[^"\\]|\\.)*)"/.exec(text);
				if (items && chip && Number(items[1]) > 0 && chip[1] === 'false') {
					this._logService.warn(`[dshHarness] view ${slot.id} worktree 数据已到页面但合并入口未渲染（页面侧问题，见 client.workspace.js 的「两组长都空才不渲染」口径）: ${text}`);
				} else if (cardErr) {
					// ★ 卡片动作在页面侧失败过（2026-10-13）：这是"点了没反应"的**页面侧**答案 ——
					//   从前这类失败只弹一条通知、日志里什么都没有 ✗ ⇒ 现在升为 warn 并带上完整快照 ✓。
					this._logService.warn(`[dshHarness] view ${slot.id} 卡片动作在页面侧失败: ${cardErr[1]} —— 完整快照: ${text}`);
				} else {
					this._logService.info(`[dshHarness] view ${slot.id} page surface: ${text}`);
				}
				}
		} catch (e) {
			this._logService.trace(`[dshHarness] view ${slot.id} surface report failed: ${String((e as Error)?.message ?? e)}`);
		}
		// 继续轮询：视图还在就续期（被关掉/换掉时上面已 return ⇒ 定时器自然停 ✓）
		if (this._views.get(slot.id) === slot) {
			setTimeout(() => void this._reportPageSurface(slot, PAGE_SURFACE_REPORT_INTERVAL_MS), PAGE_SURFACE_REPORT_INTERVAL_MS);
		}
	}

	private _startPageWatchdog(slot: IViewSlot): void {
		if (slot.surface !== 'chat' || slot.watchdog !== undefined) {
			return;
		}
		slot.watchdog = setInterval(() => void this._checkPageAlive(slot), PAGE_WATCH_INTERVAL_MS);
		slot.watchdog.unref?.();
	}

	/** 看门狗的一次体检（见 `_startPageWatchdog` 的判据与阈值）。 */
	private async _checkPageAlive(slot: IViewSlot): Promise<void> {
		if (this._views.get(slot.id) !== slot || slot.view.webContents.isDestroyed()) {
			return;
		}
		// 隐藏的视图不体检（后台页不占资源、也不该被重载打断）；恢复可见时计数从头开始。
		if (!slot.visible) {
			slot.blankChecks = 0;
			return;
		}
		let alive: boolean;
		try {
			alive = (await slot.view.webContents.executeJavaScript(PAGE_ALIVE_PROBE, true)) === true;
		} catch {
			// 探测本身失败（正在导航 / DOM 还没就绪 / 连接丢了）⇒ 不算白屏，交给既有的加载失败链处理。
			return;
		}
		if (alive) {
			slot.blankChecks = 0;
			slot.blankReported = false;   // 活了 ⇒ 允许下一轮白屏重新报现场 ✓
			return;
		}
		slot.blankChecks = (slot.blankChecks ?? 0) + 1;
		if (slot.blankChecks < PAGE_BLANK_STRIKES) {
			return;
		}
		slot.blankChecks = 0;
		// 已经为这一轮报过现场（含"放弃"）⇒ 不再每 45 秒刷同样的 diagnostics + error
		// （2026-10-12 实测：白屏持续 45 分钟 ⇒ 几十条同义行把要看的上下文全埋了 ✗）。
		if (slot.blankReported) {
			return;
		}
		// 先留现场（白屏往往复现不了，事后只能靠这一段）：把页面可观测量写进日志 ✓
		try {
			const diag = await slot.view.webContents.executeJavaScript(PAGE_BLANK_DIAGNOSTIC, true);
			this._logService.warn(`[dshHarness] view ${slot.id} blank diagnostics: ${String(diag).slice(0, 800)}`);
		} catch { /* 抓不到就算了，不影响"是否重载"的决定 */ }
		slot.blankReloads = (slot.blankReloads ?? 0) + 1;
		if (slot.blankReloads > PAGE_MAX_BLANK_RELOADS) {
			slot.blankReported = true;
			this._logService.error(`[dshHarness] view ${slot.id} stays blank after ${PAGE_MAX_BLANK_RELOADS} auto reloads — 停手；请重开该页签或重启 Host`);
			return;
		}
		this._logService.warn(`[dshHarness] view ${slot.id} looks blank (no composer in the page DOM for ~${PAGE_BLANK_STRIKES * PAGE_WATCH_INTERVAL_MS / 1000}s) — reloading (${slot.blankReloads}/${PAGE_MAX_BLANK_RELOADS})`);
		// 白屏最常见的形态是"认证失效"（页面显示 `dsh web authentication required…`，2026-10-12 用户截图）⇒
		// 这次重载**直接用带 token 的 authUrl**（`_load` 依据 `retry.retriedAuth` 选 URL），跳过注定 401 的 cookie 尝试 ✓。
		slot.retry = withAuthRetry(slot.retry);
		void this._load(slot);
	}

	private _wire(slot: IViewSlot): void {
		const wc = slot.view.webContents;
		/**
		 * **页面自己的 console**（error / warning）直接进 IDE 日志 —— 这是白屏排查里最可靠的一只眼睛。
		 *
		 * 为什么不用页面插件自报（`window.__vssarosJsErrors`）：2026-10-12 实测踩到 —— 那份自报代码
		 * **自己都可能没装进页面**（安装步骤按版本号判"要不要拷"，版本没变就不拷）⇒ 于是又回到
		 * "白屏 + 零线索"，而 `jsErrors: []` 是**假空**（其实采集器压根不在）✗✗。
		 * `console-message` 是渲染进程产生、主进程接收的，**与页面跑了哪一版插件无关** ✓✓。
		 *
		 * 只记 warning/error（info 级噪音不进日志），并按内容去重（同一句反复刷时只留第一次 ——
		 * 用户已经抱怨过"日志被同义行埋掉"）。
		 */
		wc.on('console-message', (event: unknown, level?: number, message?: string, line?: number, sourceId?: string) => {
			// Electron 新旧两种签名都认：旧 = (event, level:number, message, line, sourceId)；
			// 新 = 单个 event 对象（level 是 'info'|'warning'|'error' 等字符串）。
			const e = event as { level?: string | number; message?: string; lineNumber?: number; sourceId?: string } | undefined;
			const rawLevel = e && typeof e.level !== 'undefined' ? e.level : level;
			const text = String((e && e.message) ?? message ?? '').replace(/\s+/g, ' ').trim();
			if (!text) { return; }
			// ★ 2026-10-15：dsh 客户端的「连接阶梯重连」单独记一笔账（上面 `connChurn` 的注释有实测数据 ✓）。
			//   为什么要在**去重之前**记：原句按 `retry #N` 每次都不同 ⇒ 去重拦不住（会刷 7 行 ✗）；
			//   这里把 N 次压成"第几次 + 距首次多久"两件事，既足够定位、又不淹日志 ✓。
			const churn = /\[connection\] connection lost, retry #(\d+)/.exec(text);
			if (churn) {
				const now = Date.now();
				const c = slot.connChurn ?? (slot.connChurn = { count: 0, firstAt: now, lastAt: now, lastRetry: 0 });
				c.count++;
				c.lastAt = now;
				c.lastRetry = Number(churn[1]) || c.lastRetry;
				const secs = Math.round((now - c.firstAt) / 100) / 10;
				this._logService.warn(`[dshHarness] view ${slot.id} 客户端连接抖动：第 ${c.count} 次重试（dsh 原报 retry #${c.lastRetry}），距首次已 ${secs}s —— 页面本身早已就绪，卡的是这条链路 ✓`);
				// ★ 2026-10-15（判据修正）：第一版把"自证快照能刷新"当成链路稳定 ⇒ 实测在抖动未停时就
				//   早报（+34.9s 报"已稳定 3 次/2.7s"，实际又抖到 +50s ✗）—— 快照走的是主进程→渲染
				//   进程的 executeJavaScript，与页面↔Host 的客户端连接是**两条通道** ✗。
				//   改为**静默收口**：每次抖动（重）起一个 CONN_CHURN_QUIET_MS 定时器，窗口内没有新抖动
				//   才算稳 ✓（实测退避阶梯最大间隔 ≈9.6s，取 20s 留足余量 ✓）。
				if (c.timer) { clearTimeout(c.timer); }
				c.timer = setTimeout(() => {
					// 视图没了/已报过就静默放弃（disposeView 也会 clearTimeout 兜底 ✓；unref ⇒ 不拖住进程 ✓）
					if (this._views.get(slot.id) !== slot || slot.connChurnReported) { return; }
					slot.connChurnReported = true;
					const totalSecs = Math.round((c.lastAt - c.firstAt) / 100) / 10;
					this._logService.info(`[dshHarness] view ${slot.id} 客户端连接已稳定：共抖动 ${c.count} 次 / 历时 ${totalSecs}s（末次抖动后静默 ${CONN_CHURN_QUIET_MS / 1000}s 判稳 ✓）—— 这段就是首启"卡了一段时间才出 session"的全部来源 ✓`);
				}, CONN_CHURN_QUIET_MS);
				c.timer.unref?.();
				return;
				}
			const isError = rawLevel === 3 || rawLevel === 'error';
			const isWarn = rawLevel === 2 || rawLevel === 'warning';
			if (!isError && !isWarn) { return; }
			const src = (e && e.sourceId) ?? sourceId;
			const ln = (e && e.lineNumber) ?? line;
			const seen = slot.consoleSeen ?? (slot.consoleSeen = new Set<string>());
			const key = (isError ? 'E' : 'W') + text;
			if (seen.has(key)) { return; }
			seen.add(key);
			const where = src ? ` @ ${String(src).slice(-60)}:${ln ?? 0}` : '';
			const line2 = `[dshHarness] page console(${isError ? 'error' : 'warn'}) ${slot.id}: ${text.slice(0, 300)}${where}`;
			if (isError) { this._logService.error(line2); } else { this._logService.warn(line2); }
		});
		wc.setWindowOpenHandler(({ url }) => {
			this._openExternal(url);
			return { action: 'deny' };
		});
		wc.on('will-navigate', (event, url) => {
			if (!this._connection || !isSameOrigin(url, this._connection.origin)) {
				event.preventDefault();
				this._openExternal(url);
			}
		});
		wc.on('will-redirect', (event, url) => {
			if (!this._connection || !isSameOrigin(url, this._connection.origin)) {
				event.preventDefault();
			}
		});
		wc.on('did-navigate', (_event, url, httpResponseCode) => {
			// 先记账：`did-finish-load` 要按"这次主 frame 导航拿到的状态码"决定算不算加载成功
			// （401 的错误文档也会走 did-finish-load —— 见 common/dshViewLoadRetry.ts 的缘由）。
			slot.retry = onMainFrameNavigated(slot.retry, httpResponseCode);
			// 新一次导航 ⇒ 页面侧样本池又空了 ⇒ 就绪后要重新回放（见 _reportPageSurface 的补发块 ✓）；
			// 不复位就会"只回放第一次"，重载后历史回合又变回"积分 —" ✗。
			slot.creditsReplayedAt = undefined;
			if (httpResponseCode === 401 && this._connection && isSameOrigin(url, this._connection.origin)) {
				// cookie 失效/未建立 ⇒ 换带 token 的 authUrl 重试（有界，见 _retryLoad）。
				this._retryLoad(slot, 'HTTP 401', true);
			}
		});
		wc.on('render-process-gone', (_event, details) => {
			this._logService.warn(`[dshHarness] view ${slot.id} renderer gone: ${details.reason}`);
			if (details.reason !== 'clean-exit') {
				this._retryLoad(slot, `renderer gone: ${details.reason}`);
			}
		});
		// 主 frame 加载失败 / 401 / 渲染进程崩溃：统一走**有界重试**（退避 + 超限报错，见 _retryLoad）。
		// 旧实现的两个坑（2026-10-12 用户报"聊天框启动后又消失了"）：`did-fail-load` **只补一次**
		// （补的那次再失败就永久白屏，且日志里一片安静 ✗）；`render-process-gone` **每次都补**
		// （页面持续崩时变成崩溃循环 ✗）。
		wc.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
			if (!isMainFrame) {
				return;
			}
			this._retryLoad(slot, `load failed (${errorCode} ${errorDescription})`, true);
		});
		// **真的**加载成功 ⇒ 复位重试预算：下一次偶发失败仍能拿到完整的 3 次机会
		// （不复位的话"白天失败过一次"会让之后所有失败都没有重试 ✗）。
		// 但 401 的错误文档同样会走 did-finish-load ⇒ 那里必须**保留**预算，否则有界重试变无限循环
		// （2026-10-12 实测 449 条 `retry 1/3`，计数永远是 1）——判据见 common/dshViewLoadRetry.ts。
		wc.on('did-finish-load', () => {
			if (shouldResetRetryBudget(slot.retry)) {
				slot.retry = onDocumentFinishedLoad(slot.retry);
			} else {
				this._logService.trace(`[dshHarness] view ${slot.id} finished a ${slot.retry.lastNavigationCode} document — 保留重试预算 (${slot.retry.loadFailures}/${VIEW_LOAD_MAX_RETRIES})`);
			}
			slot.blankChecks = 0;
			// ★ 页面**就绪**了 ⇒ 补发渲染进程早先推来的快照（那时 preload 还没注册监听 ⇒ 被丢弃）✓
			this._replayPushedSnapshots(slot);
			// ★ 稍后自证一次"页面侧到底渲染出什么"（一次性；只有聊天页有 worktree/preset 这些 chip）✓
			if (slot.surface === 'chat') {
				void this._reportPageSurface(slot, PAGE_SURFACE_REPORT_DELAY_MS);
			}
			// 首次加载成功后才开始体检：启动期的 DOM 中间态不该被当成白屏。
			this._startPageWatchdog(slot);
		});
		wc.on('focus', () => this._onDidPageEvent.fire({ viewId: slot.id, kind: 'focus' }));

		// palette 模式对齐：页面 DOM 就绪后（此时 debugger 可用）再 emulation prefers-color-scheme，
		// 避免在 about:blank 上挂起。emulatedScheme 幂等，did-navigate 401 重载等重复触发安全。
		wc.on('dom-ready', () => {
			if (slot.colorScheme) {
				void this._emulateColorScheme(slot, slot.colorScheme);
			}
			// 重载后启动参数里的会话 id 是创建时的旧值：按 slot 记录重发重绑（页面幂等处理）。
			if (slot.surface === 'chat' && slot.sessionId) {
				wc.send(DSH_PAGE_IPC_REBIND, { sessionId: slot.sessionId });
			}
		});

		// 页面桥：IPC 作用域限于该视图的 webContents；再校验来自顶层 frame 且 origin 等于当前 Host。
		wc.ipc.handle(DSH_PAGE_IPC_INVOKE, (event, raw) => {
			if (!this._isTrustedSender(event)) {
				throw new Error('vssarosDsh: untrusted sender');
			}
			const command = validatePageCommand(raw);
			if (!command) {
				this._logService.warn(`[dshHarness] view ${slot.id} rejected page command ${JSON.stringify((raw as { method?: unknown })?.method ?? null)}`);
				throw new Error('vssarosDsh: invalid command');
			}
			if (command.method === 'ping') {
				return 'pong';
			}
			this._onDidPageEvent.fire({ viewId: slot.id, kind: 'command', command });
			return true;
		});
		wc.ipc.on(DSH_PAGE_IPC_KEYDOWN, (event, raw) => {
			const key = this._isTrustedSender(event) ? validateKeyEvent(raw) : undefined;
			if (key) {
				this._onDidPageEvent.fire({ viewId: slot.id, kind: 'keydown', event: key });
			}
		});
	}

	private _isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
		const frame = event.senderFrame;
		return !!frame && !!this._connection && frame.parent === null && frame.origin === this._connection.origin;
	}

	/** 窗口关闭时回收挂在它上面的视图（aux 窗口关闭不会经过 renderer 的 clearInput）。 */
	private _watchWindow(win: BrowserWindow): void {
		if (this._watchedWindows.has(win)) {
			return;
		}
		this._watchedWindows.add(win);
		const id = win.id;
		win.once('closed', () => {
			this._watchedWindows.delete(win);
			for (const slot of [...this._views.values()]) {
				if (slot.attachedTo === win) {
					slot.attachedTo = undefined;
					this.disposeView(slot.id);
				}
			}
			this._logService.trace(`[dshHarness] window ${id} closed; views reclaimed`);
		});
	}

	private _openExternal(url: string): void {
		try {
			const u = new URL(url);
			if (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:') {
				void shell.openExternal(u.href);
			}
		} catch { /* ignore malformed */ }
	}

	private _windowById(windowId: number): BrowserWindow | undefined {
		const code = this._windowsMainService.getWindowById(windowId)?.win;
		if (code) {
			return code;
		}
		const contents = webContents.fromId(windowId);
		return contents ? this._auxiliaryWindowsMainService.getWindowByWebContents(contents)?.win ?? undefined : undefined;
	}

	override dispose(): void {
		for (const id of [...this._views.keys()]) {
			this.disposeView(id);
		}
		super.dispose();
	}
}
