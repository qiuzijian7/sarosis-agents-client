/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 页面桥 v1：dsh 页面（WebContentsView）里的 `window.vssarosDsh` ↔ VsSaros（方案第 4.4、5.5、13.2 节）。
 *
 * 安全模型：同一页面里的**第三方**前端插件也能调用 `window.vssarosDsh`，页面内无法可靠识别调用方，
 * 因此这里只允许低风险的界面命令（打开 / 定位文件、通知），参数逐项校验；写入、执行类能力不走页面桥。
 * 主进程再校验调用来自该视图的顶层 frame 且 origin 等于当前 Host。
 *
 * ⚠ 2026-10-15 口径修订（用户点头，知识库下拉的**增删**）：`kbAddVault` / `kbRemoveVault` 确实会**写**
 *   （改 IDE 清单 / 删库目录），但**页面依旧拿不到任何直接写能力** —— 两条都要求宿主弹**原生**对话框
 *   （选目录 / 确认框），用户按下去之后才由 VsSaros 侧落盘 ✓；页面能做的只是"把真源那两步请出来" ✓。
 *   其余写入类（改文件内容、执行命令）仍然一律不走桥 ✗ —— 这条线没有被放宽。
 */

/**
 * 桥梁协议版本。**加/删/改命令必须一起 bump**（页面侧可据此判断宿主支不支持某条命令 ✓；
 * 2026-10-13：`2 → 3`，新增 `openModulePage` —— 侧栏插件页请求"在编辑区打开我自己"；
 * 2026-10-14：`4 → 5`，新增 `insertChatReference` —— 工作台页把一条引用推进当前 dsh 聊天草稿）；
 * 2026-10-14：`5 → 6`，新增 `openAgentSettings` —— dsh 的 Agents 页（`/x/agents`）行内「设置」打开该 bot 的
 *   VsSaros Agent 设置编辑器页（页面自己开不了编辑器 ⇒ 与 `openAgentMarket` 同源）。
 * 2026-10-15：`6 → 7`，新增 `openKbSettings` / `openKbGraph` —— dsh 的知识库页顶部两个按钮
 *   （用户报"缺设置按钮 / 缺关系图谱按钮" ✓）：两个面板都是中间栏 EditorPane，而 dsh 页面没有中间栏
 *   ⇒ 交宿主；宿主侧只**转成 IDE 自己的命令**（`agentStudio.kb.openSettings` / `.openGraph` ✓，
 *   面板本体的构造要视图状态 ⇒ 不在这里 new ✗）。
 * 2026-10-15：`7 → 8`，新增 `kbAddVault` / `kbRemoveVault` —— 知识库下拉的**增删**（用户要求
 *   "参考原知识库 view 加增删功能" ✓）。两条同样只**转成 IDE 自己的命令**（`agentStudio.kb.addVault` /
 *   `.removeVault` ✓ ⇒ 视图公开动作 ⇒ 真源 `configFolderAsVault()` / `removeVault()` ✓）；
 *   ⚠ 与上面几条的区别：这两条会**改数据**，所以真源那两步各自带的**原生对话框**（选目录 / 确认框）
 *   就是这条线的闸 —— 详见文件头的 2026-10-15 修订 ✓。
 * 2026-10-15：`8 → 9`，新增 `openSkillMarket` —— dsh 的**集成页**（`/x/skills/`）那个置顶主入口按钮
 *   改为**打开 VsSaros 的技能商城**（`SkillMarketEditorInput` 编辑器页；用户 2026-10-15 选定）。
 *   与 `openAgentMarket` 同源：**页面自己开不了编辑器** ⇒ 交宿主；宿主只**转成 IDE 自己的命令**
 *   （`agentStudio.openSkillMarket`），不新增任何写能力 ✓。
 * 2026-10-15：`9 → 10`，新增 `openResourceSettings` —— 「工具」页（`/x/skills/`，原「集成」页）里
 *   **技能行 / MCP 行**的「设置」齿轮（用户要求"技能/mcp item 中增加设置按钮，点击后打开 editorpane 修改" ✓）：
 *   技能 → 资源管理详情页（`showDetailOnly('skill', id)`：改 `SKILL.md` / 启停 / 卸载都在那页 ✓）；
 *   MCP → 打开**真源文件** `<数据根>/mcp.json`（⚠ IDE 那套 MCP 页读的是 `{root}/mcp/<slug>/config.json`，
 *   是**另一条通道** ⇒ 指过去会"看到另一个列表"✗，所以这里刻意不用它）。
 *   两条都只是"把 IDE 自己的界面显示出来" ✓（不在宿主里 new 编辑器输入、不新增写能力 ✓）。
 * 2026-10-16：`10 → 11`，新增 `switchWorkspace` —— dsh 聊天页的工作区下拉里点**别的工作区**
 *   时，除了在该根目录起会话，还要让 **IDE 窗口原地进那个工作区**（多根一起进、不重载窗口）。
 *   用户 2026-10-16 报障："点击其他工作区后，没有切换对应的工作区" ⇒ 补齐这一条 ✓。
 *   ⚠ 它**只**做"窗口进工作区"；起/接管会话仍走既有的 `switchWorktree(path)`（两条命令各管一件事 ✓）。
 * 2026-10-19：`11 → 12`，新增 `kbFeishuSync` —— dsh 知识库页右上「同步飞书」按钮**真的开始同步**
 *   （用户报："点击后只打开了设置，没有开始同步" ✗）。宿主转成 IDE 命令 `agentStudio.kb.feishuSync`，
 *   那条命令照真源 `_syncFeishuFromToolbar` 走（未启用 ⇒ 通知 + 定位「飞书同步」分组；已启用 ⇒
 *   `feishuSync('apply')` ⇒ 在集成终端里跑 `scripts/feishu-sync.mjs`，输出可见）。
 *   ⚠ 少数**有副作用**的命令之一（会写飞书文档）：触发点只有用户亲手点的那一下，协议不引入任何
 *   自动/隐式触发路径 ✓。
 * 2026-10-19：`12 → 13`，`openSession` 增加**可选** `cwd` —— 会话历史插件页双击条目时把它带上来，
 *   宿主据此先 `session.start({cwd, sessionId})` **幂等接管**再换绑。为什么非加不可（真机日志实证）：
 *   历史会话通常不在 Host 的 live 集合里，只换绑的话页面 `openSession` 报
 *   `sessions.retain: unknown session`，界面永久停在「正在打开会话…（已等待 441 秒）」
 *   ⇒ 用户看到的就是"双击会话 item 打不开对应的聊天框"✗。**纯增量字段**（老页面不传 = 老行为）。
 * 2026-10-19：`13 → 14`，新增 `renameSession` —— 会话历史插件页右键「重命名会话」。
 *   改名只能由**聊天页**做（`ctx.sessions.rename` 在客户端）⇒ 宿主转交；没有聊天框绑着该会话时，
 *   宿主先按 `openSession` 同款把它绑上（含 `session.start` 幂等接管）再改名。
 * 2026-10-19：`14 → 15`，新增 `openMediaGallery` —— dsh 媒体库页的「打开媒体库」按钮
 *   （用户要求"媒体库统一成一个 editor pane"）。取代原来的 `openModulePage('/x/media/')`：
 *   那条只是把 dsh 自己的**文本列表页**放大，给不出缩略图 / 收藏 / 分组 / 标签 / 清理能力。
 * 2026-10-21：`15 → 16`，新增 `focusIde` —— dsh **桌面窗口**（composed desktop，`surface=chat` 且保留
 *   官方 chrome）侧栏底部的「IDE」入口：把 VsSaros 的 **IDE 主窗口**提到前台。
 *   为什么必须有这条：F5 启动后默认显示的就是那个桌面窗口（`sessions.dshHarness.openDesktopOnStartup`），
 *   用户需要一条**回得去**的路 —— 页面（WebContentsView）拿不到窗口级 API（`window.focus()` 只能激活
 *   自己所在的窗口 ⇒ 对"回到另一个窗口"无效 ✗）⇒ 只能请宿主代劳 ✓（纯界面命令，不新增任何写能力 ✓）。
 * ⚠ `test/common/dshPageBridge.test.ts` 会拿这个常量去对账 preload 里的 `bridgeVersion`，
 *   只改一边必红 ✓（这正是它存在的意义）。
 *
 * 2026-10-21：`16 → 17`，新增 `signInIde` / `signOutIde` —— dsh **窗口**里的登录按钮**接管 IDE 的登录**：
 *   ① 页面 → IDE：点「登录」⇒ 宿主请 IDE 的 `ITofAuthService.login()`（开系统浏览器走 TOF/OA）✓；
 *   ② IDE → 页面：登录态（用户/工号/团队）经 `DSH_PAGE_IPC_AUTH` **推**给页面 ⇒ 窗口里的那一行
 *      与 IDE **始终一致** ✓（推 ⇒ 不参与版本对账；命令 ⇒ 参与 ✓）。
 *   ⚠ dsh 自己的 DeepSeek 账号（`records["deepseek-account-platform/default"]`）**保持独立**：它的
 *     grant 载荷/issuer 与 IDE 的 TOF 票据不是一回事（顶替会被启动自删）⇒ 我们只是让**窗口里那一行**
 *     显示 IDE 的账号，dsh 自己的账号能力照旧保留（见 `client.account.js` 的注释 ✓）。
 *
 * 2026-10-21：`17 → 18`，新增 `openSettings` / `openFeedback` —— 窗口**左下角账号菜单**的两条菜单项
 *   （用户给的参照布局：设置 / 意见反馈 / 退出登录 + 账号 chip）。两者都只是"请 IDE 打开某个界面"，
 *   页面既不能指定设置项、也不能附带任何内容 ⇒ 无参、无写能力 ✓。
 */
export const DSH_PAGE_BRIDGE_VERSION = 18;

/** preload → 主进程的 IPC 通道（经 webContents.ipc，作用域限于该视图）。 */
export const DSH_PAGE_IPC_INVOKE = 'vssaros:dsh:page';
export const DSH_PAGE_IPC_KEYDOWN = 'vssaros:dsh:keydown';
/** preload 从 `process.argv` 读取 surface 标记的前缀（经 webPreferences.additionalArguments 传入）。 */
export const DSH_PAGE_SURFACE_ARG = '--vssaros-dsh-surface=';
/** 同上：本视图绑定的 dsh 会话 id（chatId → `vssaros-chat-<chatId>`，方案 7.x）。 */
export const DSH_PAGE_SESSION_ARG = '--vssaros-dsh-session=';
/**
 * 同上：本视图在 VsSaros 侧的 viewId（`surface=plugin-page` 时供插件页面自识别与诊断；
 * 路由本身由页面 `location.pathname` 决定，不重复传）。
 */
export const DSH_PAGE_VIEW_ARG = '--vssaros-dsh-view=';
/**
 * 同上（2026-10-22）：`surface=workbench` 视图要打开的**模块路由**（`/x/<module>/`）。
 * 视图本身加载 dsh 客户端根路径 `/`（URL 逐字符同官方），路由只能经这条参数交给页面；
 * 页面据此调 `desktopWorkbenches.open('vssaros/<module>')`，宿主不在时退回 `<route>?surface=editor`。
 */
export const DSH_PAGE_WORKBENCH_ARG = '--vssaros-dsh-workbench=';

/** 工作台 → 页面的主题推送通道（负载经 {@link validateThemeTokens} 校验；方案 5.13.2 P2）。 */
export const DSH_PAGE_IPC_THEME = 'vssaros:dsh:theme';
/** preload 与页面插件之间的 DOM 事件名（共享 DOM 跨隔离世界可达）。 */
export const DSH_PAGE_THEME_EVENT = 'vssaros-dsh-theme';

/** 工作台 → 页面的「插入文件引用」通道（方案 5.5 `onInsertReference(path, startLine, endLine)`）。 */
export const DSH_PAGE_IPC_INSERT = 'vssaros:dsh:insert';
/** 同上：preload 派发给页面插件的 DOM 事件名。 */
export const DSH_PAGE_INSERT_EVENT = 'vssaros-dsh-insert';

/**
 * 工作台 → 页面的 **worktree 列表**推送通道（dsh 聊天 header 的 worktree 下拉用；机制与主题逐字同款）。
 *
 * 为什么是"推送"而不是"页面查询"：页面桥 `DSH_PAGE_IPC_INVOKE` 是**单向**的 —— 主进程 handle 只回
 * `true`/`'pong'`，页面拿不到任何返回值（见 `dshViewHost.ts` 的 INVOKE 处理）⇒ 页面要一份宿主数据，
 * 只有两条路：推送（本常量；主题/rebind 都走这条）或同源 HTTP 路由（如 `@vssaros/dsh-agents` 的
 * `/x/agents/...`）。worktree 是**宿主侧**的 git 事实（`IWorktreeService`，dsh Host 进程不感知它）
 * ⇒ 只能推送 ✓。
 */
export const DSH_PAGE_IPC_WORKTREES = 'vssaros:dsh:worktrees';
/** 同上：preload 派发给页面插件的 DOM 事件名（`detail` = {@link IDshWorktreeOption}[]）。 */
export const DSH_PAGE_WORKTREES_EVENT = 'vssaros-dsh-worktrees';

/**
 * 推给页面的 worktree 选项（**只含展示必需字段** —— 页面用不上 git 内部信息，少传就少泄漏）。
 */
export interface IDshWorktreeOption {
	/** 绝对路径（= 可以拿来给新会话当 `cwd` 的目录）。 */
	readonly path: string;
	/** 展示名（分支名或 detached 短 hash）。 */
	readonly name: string;
	readonly branch?: string;
	/** git 主工作区（通常就是当前 IDE 工作区目录本身）。 */
	readonly isMain: boolean;
}

/** 列表上限：这是下拉框，超过这个数用户也选不过来（同时防"推一个超大数组"）。 */
export const DSH_WORKTREE_OPTION_LIMIT = 50;

/**
 * 校验 worktree 列表（主进程发出前校验一次；preload 与页面共享 DOM，而 `dataset` 是字符串 ⇒
 * 页面侧解析时形状要能信任）。任一项不合法 ⇒ `undefined`（**整批丢弃**，不掺半份脏数据进 UI）。
 */
export function validateWorktreeOptions(raw: unknown): IDshWorktreeOption[] | undefined {
	if (!Array.isArray(raw) || raw.length > DSH_WORKTREE_OPTION_LIMIT) { return undefined; }
	const out: IDshWorktreeOption[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') { return undefined; }
		const r = item as Record<string, unknown>;
		if (typeof r.path !== 'string' || !isAbsoluteFsPath(r.path)) { return undefined; }
		if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 200) { return undefined; }
		if (r.branch !== undefined && (typeof r.branch !== 'string' || r.branch.length > 200)) { return undefined; }
		out.push({
			path: r.path,
			name: r.name,
			...(typeof r.branch === 'string' ? { branch: r.branch } : {}),
			isMain: r.isMain === true,
		});
	}
	return out;
}

/**
 * 工作台 → 页面的 **IDE 工作区记录**推送通道（多根工作区；2026-10-16，用户拍板稿 C）。
 *
 * 为什么非有这条不可：dsh 的工作区模型**只能是单目录**（`WorkspaceCreateRequest = { path }`，
 * 见 `@deepseek-ai/dsh-api-workspace-controller`），宿主上报时把 IDE 侧一个多根工作区的各根
 * **摊平**成 N 条记录（`dshHarness.contribution.ts` 的 `_collect()`）⇒ 页面光看 `workspaces.list()`
 * 只能看到"三个互不相干的工作区"，**不知道它们其实是同一个窗口的三个根** ✗
 * （用户报的"工作区 UI 不对"的根因之一）。
 * 而"哪几条属于同一个工作区 / 哪个是主根 / 有没有 `.code-workspace` 身份"只有 IDE 侧记录知道
 * （`Workspace.relatedFolders` / `codeWorkspacePath`）⇒ 只能由宿主推 ✓（页面桥是**单向**的：
 * `DSH_PAGE_IPC_INVOKE` 只回 `true`/`'pong'`，页面拿不到任何返回值 ✓）。
 *
 * ⚠ 页面**不许把它当第二套真源**：下拉框的条目仍然来自 `workspaces.list()`（会话归属、切换命令都认它 ✓），
 *   这条推送只回答"该把哪几条合成一组、组里哪个是主根"✓。推送没到（旧宿主 / 服务未就绪）⇒
 *   页面回落到"一条记录一行"，与加这条之前**逐字相同** ✓。
 * 机制与 {@link DSH_PAGE_IPC_WORKTREES} 逐字同款（preload 写 `dataset` + 派 DOM 事件）；
 * ⚠ 这是**推送**不是命令 ⇒ 不参与 `DSH_PAGE_BRIDGE_VERSION` 的对账（页面按"dataset 里有没有"判断
 *   宿主是否会推 ✓，与主题 / worktree 两条同口径 ✓）。
 */
export const DSH_PAGE_IPC_WORKSPACES = 'vssaros:dsh:workspaces';
/** 同上：preload 派发给页面插件的 DOM 事件名（`detail` = {@link IDshWorkspaceOption}[]）。 */
export const DSH_PAGE_WORKSPACES_EVENT = 'vssaros-dsh-workspaces';

/**
 * **IDE 登录态**推给 dsh 页面的通道（2026-10-21）。
 *
 * 为什么要它：dsh 窗口底部那行「账号」要**显示 IDE 的登录**（TOF/OA）并与 IDE **保持一致** ⇒
 * 窗口里登录/登出后、或在 IDE 那边登录/登出后，窗口必须立刻跟上 ⇒ 只能**推**（页面桥是单向的 ✓）。
 * 机制与 {@link DSH_PAGE_IPC_WORKSPACES} 逐字同款（preload 写 `dataset` + 派 DOM 事件）✓。
 * ⚠ 这是**推送**不是命令 ⇒ 不参与 `DSH_PAGE_BRIDGE_VERSION` 的对账 ✓。
 */
export const DSH_PAGE_IPC_AUTH = 'vssaros:dsh:auth';
/** 同上：preload 派发给页面插件的 DOM 事件名（`detail` = {@link IDshAuthOption}）。 */
export const DSH_PAGE_AUTH_EVENT = 'vssaros-dsh-auth';

/**
 * IDE 侧登录态的**展示投影**（只含展示必需字段 —— 票据/token 绝不下发到页面 ✗）。
 *
 * ⚠ 只给"谁登录了"，**不给**凭据：页面拿到的任何东西都不该能被用来冒充该用户（凭据留在 IDE/Host 侧 ✓）。
 */
export interface IDshAuthOption {
	/** 是否已登录（false ⇒ 其余字段无意义）。 */
	readonly signedIn: boolean;
	/** 登录名（工号 / 账号名）；未登录时为空串。 */
	readonly loginName?: string;
	/** 工号（staff_id）；没有则空串。 */
	readonly staffId?: string;
	/** 团队名；没有则空串。 */
	readonly team?: string;
	/**
	 * **最近一次登录/登出失败的原因**（2026-10-21 新增）。
	 *
	 * 为什么需要：页面桥是**单向**的（只回 true）⇒ 登录失败时页面**收不到任何回执** ⇒
	 * 用户看到的还是"未登录"，而真实原因（浏览器被关 / 网关超时 / 账号被拒）只落在 IDE 日志里
	 *   ⇒ 页面只能干等超时兜底（本仓"点了没反应"的高频形态）✗ ⇒ 失败必须**可见** ✓。
	 *
	 * ⚠ 只给**一句人话**（≤200 字符）：不含堆栈、路径、票据等敏感内容 ✓。
	 * ⚠ 这是**推送**不是命令 ⇒ 不参与 `DSH_PAGE_BRIDGE_VERSION` 的对账 ✓（与登录态同款）。
	 */
	readonly error?: string;
}

/** 校验 {@link IDshAuthOption} 的形状（推送载荷 ⇒ 宿主侧只收"形状对"的，别的丢弃）。 */
export function validateAuthOption(raw: unknown): IDshAuthOption | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const r = raw as Record<string, unknown>;
	if (typeof r.signedIn !== 'boolean') {
		return undefined;
	}
	const str = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 64) : '');
	const out: IDshAuthOption = {
		signedIn: r.signedIn,
		loginName: str(r.loginName),
		staffId: str(r.staffId),
		team: str(r.team),
	};
	// 失败原因：**有才带**（空串当作没有 ⇒ 页面不会显示一个空的错误条 ✗）
	const err = typeof r.error === 'string' ? r.error.trim().slice(0, 200) : '';
	if (err) {
		return { ...out, error: err };
	}
	return out;
}

/** 多根工作区里的一个根（**只含展示必需字段** —— 页面拿不到 IDE 记录的其余部分 ✓）。 */
export interface IDshWorkspaceRootOption {
	/** 绝对路径（= 可以拿来给新会话当 `cwd` 的目录）。 */
	readonly path: string;
	/** 展示名（目录名）。 */
	readonly name: string;
	/** 主根 = 宿主给 dsh 登记的那一条（`Workspace.path`）⇒ 页面拿它当"整组默认 cwd" ✓。 */
	readonly isPrimary: boolean;
}

/** 推给页面的 IDE 工作区记录（含各根；2026-10-16 多根工作区专稿）。 */
export interface IDshWorkspaceOption {
	/** IDE 侧工作区 id（`Workspace.id`）。⚠ 仅供分组的 React key 与诊断，**不是** dsh 的 workspaceId ✓。 */
	readonly id: string;
	/** 展示名（`Workspace.name`）。 */
	readonly name: string;
	/** 各根（含主根；顺序即展示顺序，第一项恒为主根）。 */
	readonly roots: readonly IDshWorkspaceRootOption[];
	/**
	 * 来源 `.code-workspace` 文件路径（有就如实显示）。
	 * ⚠ 本轮**只读展示**（用户拍板 ④-i）：页面不许拿它去"打开 / 切换工作区" ——
	 *   `.code-workspace` + sideview 关联那条链是另一刀 ✓。
	 */
	readonly codeWorkspacePath?: string;
}

/** 列表上限：工作区不会很多，但推送是外部输入面 ⇒ 给个硬上限（与 `DSH_WORKTREE_OPTION_LIMIT` 同口径）。 */
export const DSH_WORKSPACE_OPTION_LIMIT = 30;
/** 单个工作区的根上限（再多也不该有几十个根；超了**整批丢弃**，不掺半份脏数据 ✓）。 */
export const DSH_WORKSPACE_ROOT_LIMIT = 16;

/**
 * 校验 IDE 工作区列表（主进程发出前校验一次；preload 与页面共享 DOM，而 `dataset` 是字符串 ⇒
 * 页面侧解析时形状要能信任）。任一项不合法 ⇒ `undefined`（**整批丢弃**，与 worktree 同口径 ✓）。
 */
export function validateWorkspaceOptions(raw: unknown): IDshWorkspaceOption[] | undefined {
	if (!Array.isArray(raw) || raw.length > DSH_WORKSPACE_OPTION_LIMIT) { return undefined; }
	const out: IDshWorkspaceOption[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') { return undefined; }
		const r = item as Record<string, unknown>;
		if (typeof r.id !== 'string' || !r.id.trim() || r.id.length > 200) { return undefined; }
		if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 200) { return undefined; }
		if (r.codeWorkspacePath !== undefined) {
			// 身份文件：必须是**绝对路径**（不做"文件是否真的存在"的查询 —— 页面桥不做 fs ✓）
			if (typeof r.codeWorkspacePath !== 'string' || !isAbsoluteFsPath(r.codeWorkspacePath)) { return undefined; }
		}
		if (!Array.isArray(r.roots) || r.roots.length === 0 || r.roots.length > DSH_WORKSPACE_ROOT_LIMIT) { return undefined; }
		const roots: IDshWorkspaceRootOption[] = [];
		for (const rawRoot of r.roots) {
			if (!rawRoot || typeof rawRoot !== 'object') { return undefined; }
			const rr = rawRoot as Record<string, unknown>;
			if (typeof rr.path !== 'string' || !isAbsoluteFsPath(rr.path)) { return undefined; }
			if (typeof rr.name !== 'string' || !rr.name.trim() || rr.name.length > 200) { return undefined; }
			roots.push({ path: rr.path, name: rr.name, isPrimary: rr.isPrimary === true });
		}
		out.push({
			id: r.id,
			name: r.name,
			roots,
			...(typeof r.codeWorkspacePath === 'string' ? { codeWorkspacePath: r.codeWorkspacePath } : {}),
		});
	}
	return out;
}

/**
 * 工作台 → 页面的「重绑会话」通道（方案 5.15：已有会话切 preset = 换到该 preset 的专属会话）。
 * 视图创建后 additionalArguments 不可变，换绑只能走运行时消息：preload 收到后派 DOM 事件，
 * chat-surface 监听并 `openSession` 新会话。视图重载（reload/渲染进程重建）后宿主按 slot
 * 上记录的最新 sessionId 重发一次，页面幂等处理。
 */
export const DSH_PAGE_IPC_REBIND = 'vssaros:dsh:rebind';
/** 同上：preload 派发给页面插件的 DOM 事件名。 */
export const DSH_PAGE_REBIND_EVENT = 'vssaros-dsh-rebind';

/**
 * 会话重命名（外层页签 → 页面）——与 rebind 同机制的反向消息：
 * 宿主在编辑器标签上发起重命名、拿到新标题后经此推给页面，preload 派 DOM 事件，
 * chat-surface（`client.sessionLabel.js`）调 dsh 的 `ctx.sessions.rename(sessionId, title)`，
 * 完成后派 `vssaros-dsh-renamed` 回执。只承载展示文本，不传会话内容。
 */
export const DSH_PAGE_IPC_RENAME = 'vssaros:dsh:rename';
/** 同上：preload 派发给页面插件的 DOM 事件名（须与 client.sessionLabel.js 的监听名一致）。 */
export const DSH_PAGE_RENAME_EVENT = 'vssaros-dsh-rename';

/**
 * ★ 2026-10-19（A1 第 4 步）：改名的**回执**（页面 → 工作台）。
 *
 * 为什么要有这一条：上面的 `DSH_PAGE_IPC_RENAME` 是单向推送，调用方（会话侧栏）**无从知道
 * 改成了没有** ⇒ 只能乐观刷新 = 假成功 ✗。而 `dshPageBridgeProtocol.ts:79` 那条桥是
 * **没有语义返回值**的（只回 `true` / `'pong'`）⇒ 不能拿它当回执。
 * ⇒ 与 rebind / rename 同机制的**反向**消息：页面改完派 `vssaros-dsh-renamed`（成功带 title、
 * 失败带 error），preload 收到后经这条上送主进程，主进程 fire `kind:'renamed'` 的页面事件。
 *
 * ⚠ 频道名与事件名：IPC 用 `vssaros:dsh:renamed`，DOM 事件仍叫 `vssaros-dsh-renamed`
 * （页面 `client.sessionLabel.js:69/73` 已经在派这个名字 ⇒ 不能改）。
 */
export const DSH_PAGE_IPC_RENAMED = 'vssaros:dsh:renamed';
/** 同上：页面插件派发的 DOM 事件名（须与 client.sessionLabel.js 的派发名一致）。 */
export const DSH_PAGE_RENAMED_EVENT = 'vssaros-dsh-renamed';

/**
 * 计费样本推送（主进程的计费探针代理 → 页面）——与上面几条同机制的反向消息：
 * 代理在链路上从网关响应里读到 `usage.credit` 后，宿主把样本推给视图，preload 派 DOM 事件，
 * chat-surface（`client.usage.js`）按**回合时间窗**归属并渲染「积分」chip。
 *
 * 只承载展示数值与归属线索（route/model/at/credit/status），不含会话内容、不含任何凭据。
 */
export const DSH_PAGE_IPC_CREDIT = 'vssaros:dsh:credit';
/** 同上：preload 派发给页面插件的 DOM 事件名（须与 client.usage.js 的监听名一致）。 */
export const DSH_PAGE_CREDIT_EVENT = 'vssaros-dsh-credit';

/**
 * 一次 LLM 响应的计费样本（与主进程 `IDshCreditSample` 同形；页面侧只读展示）。
 *
 * ⚠ 主进程**只能广播**：代理看到的是回环 HTTP 请求（只有 route/model，没有会话身份），
 * 无从判断属于哪个视图 ⇒ **归属留给页面**按回合时间窗 + provider/model 过滤（`creditInWindow`）。
 */
export interface IDshCreditPush {
	/** dsh 路由名（`vssaros-<id>`）；它同时是 dsh 侧 provider id，故可与 `tokenUsage.routes[].provider` 对齐。 */
	readonly route: string;
	/** 请求体里的模型 id（尽力而为，代理从请求体头部解析）。 */
	readonly model?: string;
	/** 网关上报的积分；**缺省 = 该响应没有积分字段**（与"积分 0"必须区分）。 */
	readonly credit?: number;
	/** 该响应的 HTTP 状态（诊断用）。 */
	readonly status?: number;
	/** 抓到的时间（epoch ms，与页面 `turn.start.time` 同一时钟）。 */
	readonly at: number;
}

/** 插入引用的负载：工作区内相对路径（posix 形态）或绝对路径 + 可选行号区间（编辑器右键「发送到聊天」）。 */
export interface IDshInsertReference {
	readonly path: string;
	readonly startLine?: number;
	readonly endLine?: number;
}

/** 引用路径：绝对 fs 路径，或干净的 posix 相对路径（无盘符 / 前导斜杠 / 反斜杠 / `..` 段 / NUL）。 */
function isReferencePath(p: string): boolean {
	if (!p || p.length > 1024 || p.includes('\0')) {
		return false;
	}
	if (isAbsoluteFsPath(p)) {
		return true;
	}
	return !/^[a-zA-Z]:/.test(p) && !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..');
}

export function validateInsertReference(value: unknown): value is IDshInsertReference {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const v = value as Record<string, unknown>;
	if (typeof v.path !== 'string' || !isReferencePath(v.path)) {
		return false;
	}
	for (const key of ['startLine', 'endLine'] as const) {
		const n = v[key];
		if (n !== undefined && (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1_000_000)) {
			return false;
		}
	}
	const { startLine, endLine } = v as { startLine?: number; endLine?: number };
	return startLine === undefined || endLine === undefined || startLine <= endLine;
}
/** 同上：聊天框里"只保留聊天 UI"标记（方案 5.13）。 */
export const DSH_PAGE_CHAT_ONLY_ARG = '--vssaros-dsh-chat-only=';

/**
 * 聊天框专用样式（方案 5.13）：隐藏 dsh 自己的侧边栏（含品牌 logo 行、会话列表、文件 / 工作区 /
 * 浏览器 / 终端 / 文档预览）与右侧栏（轨迹 / 任务 / 交付物），并把三栏栅格收成单栏。
 *
 * **为什么是"隐藏"而不是"停用插件"**：实测停用这些前端插件会让客户端 boot 失败 —— 聊天本身依赖
 * 它们提供的服务（`locale`、`configForm`、`sidebarRight`、`uiWorkspace` 分别来自设置类、侧栏与
 * 工作区插件），23 个条目会 pending 在等待里（探针里有守卫断言）。所以保留插件、只隐藏界面。
 *
 * 选择器用 dsh 布局的 `data-slot` / `data-*` 属性（不是哈希类名）；preload 里是同样内容的字面量，
 * 由单测比对（preload 不能 import 本模块）。
 */
export const DSH_CHAT_ONLY_CSS = [
	// ★★ 2026-10-19（用户报「右侧缺少用户消息定位 UI，官方 dsh 里有」）：
	//   **只隐藏左侧栏**（品牌行 + 会话列表 —— IDE 那边已经有会话历史了）。
	//   右侧栏（**轨迹** / 任务 / 交付物）**必须保留**：轨迹里的"交互式时间概览"就是
	//   用户说的"用户消息定位"（官方 `dsh-client-ui-trajectory`，按轮次的时间线 + 点击定位）。
	//   从前把 `[data-slot="rightbar"]` 一起 display:none 了 ⇒ 那个入口整个消失 ✗
	'[data-slot="sidebar"] { display: none !important; }',
	// 栅格：左列 0、中间弹性、**右列 auto**。右栏处于折叠态时宽度是 0 ⇒ auto 列不占地方，
	// 默认布局与从前一致；用户点"展开右栏"按钮才把轨迹拉出来（可控，不是强塞宽度 ✓）。
	// 锚点必须是 layout frame 本身：`div:has(> [data-shell-overlay])` —— overlayLayer 是它的直接子元素。
	// 不能锚 `[data-sidebar-collapsed]`：该属性只在侧栏折叠态存在，展开时缺失 ⇒ 左列会留白。
	'div:has(> [data-shell-overlay]) { grid-template-columns: 0 minmax(0, 1fr) auto !important; }',
	// ⚠ 从前这里还有一条 `[data-sidebar-right-expand] { display: none !important; }`
	//   （"右侧栏折叠时那个展开按钮一并隐藏"）—— 现在**必须去掉**：那是把右栏拉回来的唯一入口，
	//   去掉它等于"右栏还在但用户永远打不开"（等于没恢复 ✗）。
].join('\n');

export type DshPageCommand =
	| { readonly method: 'ping' }
	| { readonly method: 'openFile'; readonly path: string; readonly startLine?: number; readonly endLine?: number }
	| { readonly method: 'openMarkdown'; readonly text: string; readonly title?: string }
	| { readonly method: 'reveal'; readonly path: string }
	| { readonly method: 'notify'; readonly kind: 'info' | 'done' | 'attention'; readonly text: string }
	| { readonly method: 'switchPreset'; readonly presetId: string }
	/**
	 * 把本视图切到**指定的 dsh 会话**（chat-surface 的「历史会话」菜单）。
	 *
	 * 为什么不页面侧直接 `uiWorkspace.openSession`：本视图绑定的会话 id 是**宿主持有的事实**
	 * （`dshViewHost` 的 slot.sessionId，用于 rename 推送与 preset 映射）。页面私自切换会让两边
	 * 分叉 ⇒ 走宿主：宿主校验 id（`isDshChatSessionId`）后走**既有的 rebind 通路**下发，
	 * 页面侧沿用 `vssaros-dsh-rebind` 处理（对齐工作区 + openSession），与 preset 切换完全同源。
	 *
	 * `agentPreset` 可选：页面从会话快照里读到该会话的 preset，宿主据此同步自己的 preset 记账
	 * （不传则宿主不动 preset 状态）。
	 *
	 * `cwd` 可选（2026-10-19 新增）：这条会话的**工作目录**（页面从会话快照里读到）。
	 * 为什么需要它：历史会话在 Host 那边可能**不在 live 集合里**（只有磁盘上的投影缓存），
	 * 此时页面 `openSession` 必报 `sessions.retain: unknown session`、界面永远停在
	 * 「正在打开会话…（已等待 N 秒）」。宿主拿到 cwd 就能先 `session.start({cwd, sessionId})`
	 * **幂等接管**这条会话（把它拉活），再做换绑 ⇒ 历史会话才真的打得开。
	 * ⚠ 不带 cwd 时宿主只能按老路换绑（界面仍可能打不开）——所以页面**应当**能拿到就带上。
	 */
	| { readonly method: 'openSession'; readonly sessionId: string; readonly agentPreset?: string; readonly cwd?: string }
	/**
	 * **重命名一条 dsh 会话**（2026-10-19，桥 `13 → 14`；会话历史插件页右键「重命名会话」）。
	 *
	 * 为什么必须交宿主：改名只有**页面**能做（dsh 的 `ctx.sessions.rename` 在聊天页的客户端里），
	 * 而插件页没有 dsh 客户端上下文 ⇒ 宿主把请求转给"正在显示这条会话的聊天视图"
	 * （`dshViewHost` → IPC → preload → chat-surface 的 `ctx.sessions.rename`），
	 * 成功/失败由页面的 `vssaros-dsh-renamed` 回执告知（见 `IDshSessionRenamedResult`）。
	 *
	 * `cwd` / `agentPreset` 可选：这条会话当前**没在任何聊天框里打开**时，宿主可以顺手把它
	 * 绑到一个聊天视图上（`openSession` 同款：先 `session.start` 幂等接管）再改名 ——
	 * 否则"没有聊天框"就只能拒绝，用户会觉得"重命名功能坏了"。
	 */
	| { readonly method: 'renameSession'; readonly sessionId: string; readonly title: string; readonly agentPreset?: string; readonly cwd?: string }
	/**
	 * 把**当前这个插件页**在 VsSaros 的**编辑区**里打开（2026-10-13 新增，桥版本 `2 → 3`）。
	 *
	 * 为什么需要走宿主：侧栏里的插件页是「摘要 + 入口」（如「主页」的侧栏版 `?surface=sideview`），
	 * 完整版由**编辑区**承载，而**页面自己开不了编辑器** ⇒ 请宿主代劳 ✓。
	 *
	 * `route` = 页面自己的 `location.pathname`（如 `/x/dashboard/`）；宿主拿它查模块页表
	 * （**白名单**：只认 `DSH_MODULE_PAGES` 里的路由 ⇒ 页面无法借这条命令打开任意地址 ✗）。
	 */
	| { readonly method: 'openModulePage'; readonly route: string }
/**
 * 请宿主打开**知识库设置**页（2026-10-15 新增，桥版本 `6 → 7`）。
 *
 * 与 `openModulePage` 同一句理由 ✓：dsh 侧的知识库页面**没有中间栏**，而设置是 VsSaros 的中间栏
 * EditorPane（`KbSettingsEditorPane` ✓）⇒ 页面自己开不了 ⇒ 交宿主 ✓。
 * 与 `openAgentSettings` 同源：宿主只负责把 **IDE 自己的界面**显示出来 ✓（**不新增任何写能力** ✓）。
 *
 * `focusSection` 故意**不收** ✗：真源设置页的 5 个分组各有深链（目录 / 构建方式 / Embedding /
 * 飞书同步 / 状态 ✓），而 dsh 页面现在只会说"打开设置" ✓ —— 等真的要深链再加参数（少一个参数
 * 就少一处校验 ✓；加参数要一起 bump 版本 ✓）。
 */
| { readonly method: 'openKbSettings' }
/** 同上：请宿主打开**知识库关系图谱**（中间栏 EditorPane `KnowledgeBaseGraphEditorPane` ✓）。 */
| { readonly method: 'openKbGraph' }
/**
 * 请宿主**开始同步飞书**（2026-10-19 新增，桥 `11 → 12`；用户报"点了同步飞书按钮只打开设置，不开始同步"）。
 *
 * 为什么必须交宿主：同步 = 在**集成终端**里跑 `scripts/feishu-sync.mjs`（分钟级、输出要用户可见），
 * dsh 页面既没有终端、也不该自带写通道 ✗ ⇒ 只能转成 IDE 命令 `agentStudio.kb.feishuSync` ✓
 * （那条命令内部照真源 `_syncFeishuFromToolbar` 走：**未启用 ⇒ 通知 + 打开设置的「飞书同步」分组**；
 *   已启用 ⇒ `feishuSync('apply')`）—— 与 `openKbSettings` 同一套"命令 ⇒ 服务方法"的实现 ✓。
 *
 * **无参数**：同步哪个库 / dry-run 还是 apply 都由 IDE 侧判定 ✓（页面不得指定 ✓，少一处校验面）。
 * ⚠ 这条是**有副作用**的少数命令之一（会写飞书文档）—— 但触发点是用户**亲手点的按钮**，
 *   与真源工具栏按钮同一语义 ✓；协议因此**不新增任何隐式/自动触发路径**（只有点击这一条路）。
 */
| { readonly method: 'kbFeishuSync' }
/**
 * 请宿主**添加一个知识库**（把某个文件夹配置成知识库；2026-10-15 新增，桥 `7 → 8`）。
 *
 * 真源那一步是 `configFolderAsVault()`（`knowledgeBaseView.ts:1635-1654` ✓）：**原生选目录** →
 * 写 IDE 清单（`agentStudio.kb.vaults`）→ 在所选目录下建 `库`/`笔记` → 激活 ✓。
 * 页面**开不了系统选择器、也写不了 IDE storage** ✗ ⇒ 这一跳只能交宿主 ✓（与 `openKbSettings` 同源：
 * 命令 → 视图公开动作 ⇒ 同一份实现 ✓）。
 *
 * **无参数**：选哪个目录由**用户在原生对话框里**决定 ✓ —— 页面不得指定路径 ✗（协议不接受任何路径参数，
 * 因此不存在"页面把任意目录塞进知识库清单"这条能力 ✓）。
 */
| { readonly method: 'kbAddVault' }
/**
 * 请宿主**删除一个知识库及其全部内容**（2026-10-15 新增，桥 `7 → 8`）。
 *
 * ★ **裁决变更（2026-10-15，用户明确点头）**：库级删除 = **永久删除**（照真源 ✓），而页面里**文件行**
 *   的删除仍然是"移入备份（可逆）"✗ —— 两条并存，所以页面文案必须说清是哪一种 ✓。
 * 真源那一步是 `removeVault()`（`knowledgeBaseView.ts:1069-1087` ✓）：**原生确认框**（原文
 *   `确定删除知识库「{0}」及其全部内容？` ✓）→ `fileService.del(recursive)` → 移出清单 → 切到下一个库 ✓。
 * `vaultId` 只放**形状**；权威校验在宿主（必须命中 IDE 清单里的某个库 ⇒ 页面无法借它删任意路径 ✓）。
 */
| { readonly method: 'kbRemoveVault'; readonly vaultId: string }
	/**
	 * 「固定到活动栏」/「从活动栏隐藏」（2026-10-13，主页的「工作台」组件）。
	 *
	 * ⚠ 这是**单向动作**：dsh 侧**读不到** IDE 的 pin / 显隐状态（用户选的是"dsh 侧自己枚举"这条路 ✗
	 *   零新通道）⇒ 页面**不回显**结果，所以命令名是"设成 true"而不是"切换" ✓
	 *   （切换语义要求页面知道当前值 ⇒ 那必须走"IDE 写数据根"那条通道 ✗）。
	 * 白名单与 `openModulePage` 同一套：`route` 必须是模块页表里的路由 ✓。
	 */
	| { readonly method: 'setWorkbenchPinned'; readonly route: string; readonly pinned: boolean }
	| { readonly method: 'setWorkbenchHidden'; readonly route: string; readonly hidden: boolean }
	/**
	 * 本会话**人格事实**上报（2026-10-12）：chat-surface 的「人格（本会话）」chip 切完（或读到时）上报，
	 * 供 VsSaros 侧的历史会话 sideview 显示人格标记。
	 *
	 * 为什么必须经宿主：人格的真源是 dsh 的投影（`vssaros-persona`，由 `@vssaros/dsh-agents` 注册），
	 * 而 sideview 是 VsSaros 的天气面板 —— 页面里知道 `personaId`，宿主才知道**壳侧的会话身份**
	 * （dsh 会话 id → `agentId::sessionId`）。两边只有宿主能 join，页面自己写不了那个键。
	 *
	 * `sessionId` 由 preload 注入（本视图绑定的 dsh 会话），页面不传；
	 * `personaId: null` = **跟随 Agent 自带人设**（挂载期事实，不是"未知"）⇒ 宿主删掉壳侧那条；
	 * `applicable: false` = 本 preset 里没有"人设段"（如 dsh 自带的 `standard`）⇒ 不显示标记。
	 */
	| { readonly method: 'sessionPersona'; readonly sessionId: string | null; readonly personaId: string | null; readonly name?: string; readonly applicable?: boolean }
	/**
	 * 新建一个聊天页签（header 的「新建会话」）。
	 *
	 * 为什么必须由宿主做：VsSaros 的"新建会话"语义是**新开一个对话编辑器页签**
	 * （原生面板 `_onNewSession` 同义），页面无法创建编辑器；宿主执行既有的
	 * `agentStudio.newChatInEditor`（引擎设置是 dsh ⇒ 新页签仍是 dsh 聊天）。
	 * 页面侧若直接 `ctx.uiWorkspace.startSession()` 只会清掉当前选中会话，
	 * 而宿主 slot 仍指着旧会话 ⇒ 两边分叉，故不采用。
	 */
	| { readonly method: 'newChat'; readonly agentPreset?: string }
	/**
	 * **本页签内**新建会话（dsh 聊天 header 的「＋ 新建会话」，2026-10-12 用户要求）。
	 *
	 * 与 {@link newChat} 的区别只在**落在哪里**：这里不新建编辑器，而是给**当前页签**换一个全新的
	 * dsh 会话（历史独立，preset 与 cwd 沿用当前值）—— 宿主派生带 `--new-<nonce>` 的 id →
	 * `session.start` → `rebindSession` 回推。仍然必须经宿主：会话绑定是宿主的事实，
	 * 页面自己 `uiWorkspace.startSession()` 会让两边分叉 ✗。
	 */
	| { readonly method: 'newSession' }
	/**
	 * 在 VsSaros 的**集成终端**里打开一个终端，并把命令**填进去（不执行）**。
	 *
	 * ⚠ 安全口径（这条为什么不是 `runInTerminal`）：本协议的安全模型是"只允许低风险的界面命令
	 * （打开 / 定位文件、通知）"—— 页面里**任何第三方前端插件**都能调 `window.vssarosDsh.*`，
	 * 而"替用户执行命令"属于执行类能力 ✗✗。所以这里只 `sendText(command, false)`：
	 * 用户始终是最后那个"按下回车的人"✓，同时"一键重现跑过的命令"这个诉求仍然成立 ✓。
	 *
	 * `cwd` 可选（绝对路径，缺省用 IDE 当前工作区）；`command` 可选（多行允许，长度上限见校验）。
	 */
	| { readonly method: 'openTerminal'; readonly cwd?: string; readonly command?: string }
	/**
	 * 打开某文件「**未提交改动**」的 diff（HEAD ↔ 工作区）。
	 *
	 * 为什么需要：交付卡片上那句"看改动"官方是开 dsh 右栏（被 chat-only CSS 裁掉 ⇒ 点了没反应 ✗），
	 * 而 IDE 侧的 `showDiff` 能力要**两个文件路径**（本轮改动的旧内容只存在于 dsh 内存里 ✗）⇒
	 * 唯一现成的旧内容来源是 **git 的 HEAD 版本** ✓。
	 * 实现走扩展命令 `agentStudio.openUncommittedDiff`（工作台拿不到扩展宿主 API ⇒ 必须由扩展代劳 ✓）；
	 * 该文件没有未提交改动时回退成**直接打开文件** + 一条说明（不允许"点了没反应" ✗）。
	 */
	| { readonly method: 'showUncommittedDiff'; readonly path: string }
	/**
	 * 把**当前会话**切到另一个 worktree（dsh 聊天 header 的 worktree 下拉；方案 C）。
	 *
	 * 语义与代价（宿主实现见 `dshChatInstanceHost._doSwitchWorktree`）：dsh 的会话 cwd 在 `session.start`
	 * 时定死、桥面无"改已有会话 cwd"的方法 ⇒ 换目录**只能新开会话**（历史独立），而 **preset 沿用当前值**
	 * （用户选的 agent 不丢，但它会在新会话里重新装配）。所以 UI 必须如实告诉用户"会新建会话"
	 * —— 这不是"只换个目录"。
	 *
	 * 为什么走宿主：会话绑定（slot.sessionId + 派生 id + rebind）是宿主持有的事实；页面自己
	 * `uiWorkspace.openWorkspace` 只会切页面选择，`session.start` 根本没发生 ⇒ 两边分叉 ✗。
	 *
	 * ★ 2026-10-14：**两个入口共用这一条命令** —— worktree 下拉，以及「切换工作区」
	 *   （`client.workspace.js` 的工作区 chip）。工作区切换在宿主侧就是"换目录 ⇒ 新会话"
	 *   （`dshChatInstanceHost._doSwitchWorktree`；`_isWorktreeDir` 只判"是不是本窗口主工作区"，
	 *   对任意非主目录都成立 ✓）⇒ 不新增同义命令（多一个入口只会各自漂移 ✗）。
	 *   ⚠ 该 chip 原来页面自己调 `ctx.uiWorkspace.openWorkspace(id)`，正是上面那句"两边分叉 ✗"的情形。
	 */
	| { readonly method: 'switchWorktree'; readonly path: string }
	/**
	 * 会话标题上报（外层页签）：chat-surface 在页面侧读到 dsh 会话标题后调
	 * `window.vssarosDsh.sessionTitle(title)` 上报，宿主据此更新 VsSaros 编辑器标签文案。
	 * `title: null` = 暂无标题（页面侧删除了该事实）⇒ 宿主回落原标签。只承载纯文本，不传会话内容。
	 */
	| { readonly method: 'sessionTitle'; readonly sessionId: string | null; readonly title: string | null }
	/**
	 * 打开 **Agent 商城**（输入框 Agents 面板的底部动作）。
	 *
	 * 为什么必须由宿主做：商城是 VsSaros 的**编辑器页**（命令 `agentStudio.openMarket`，见
	 * `agentStudio.contribution.ts` 的 "Open Agent Market"），dsh 页面无法创建编辑器 ⇒ 与 `newChat` 同源。
	 */
	| { readonly method: 'openAgentMarket' }
/**
 * 打开 **技能商城**（VsSaros 的 `SkillMarketEditorInput` 编辑器页）。
 *
 * 为什么必须由宿主做：与 `openAgentMarket` 同源 —— 商城是 VsSaros 的**编辑器页**，
 * dsh 页面（WebContentsView）无法创建编辑器 ⇒ 请宿主代劳 ✓。
 * 触发点：dsh **集成页**（`/x/skills/`，容器 `agentStudio.integration`）的置顶主入口按钮
 * （2026-10-15 用户选定「打开 IDE 的技能商城」）。宿主只**转成 IDE 自己的命令**
 * （`agentStudio.openSkillMarket`）⇒ 页面侧依旧拿不到任何写能力 ✓（安装/卸载都发生在商城页里、
 * 由用户在那页操作 ✓）。
 */
| { readonly method: 'openSkillMarket' }
/**
 * 打开 **VsSaros 的媒体库**（`MediaGalleryEditorPane`，编辑区页；2026-10-19，桥 `14 → 15`）。
 *
 * 为什么必须经宿主：与 `openSkillMarket` 同源 —— 媒体库是 VsSaros 的原生 `EditorPane`
 * （`MediaGalleryEditorInput`），dsh 页面（WebContentsView）创建不了编辑器 ✓。
 *
 * 触发点：dsh 媒体库页 `/x/media/` 的置顶「打开媒体库」按钮。**取代**了原先那条
 * `openModulePage('/x/media/')`（那只是把 dsh 自己的列表页放大，给不出缩略图/收藏/分组/标签）。
 * 无参（没有可被伪造的输入；打开的是"全库"视图，不带工作流上下文 ✓）。
 */
| { readonly method: 'openMediaGallery' }
/**
 * 把 **VsSaros 的 IDE 主窗口**提到前台（2026-10-21 新增，桥 `15 → 16`）。
 *
 * 触发点：dsh **桌面窗口**（composed desktop）侧栏底部那行「VsSaros · N 个工作区 · M 条会话」——
 * 它现在就是「回到 IDE」的入口（用户 2026-10-21 要求"窗口版中增加 IDE 入口可以进入 VsSaros 界面"）。
 *
 * 为什么必须经宿主：页面是 WebContentsView 里的 dsh 前端，**拿不到窗口级 API**；
 * `window.focus()` 只能激活它自己所在的那个窗口 ⇒ 对"回到另一个窗口"完全无效 ✗。
 *
 * 无参（没有可被伪造的输入 ✓）；宿主侧只做 `focusWindow`，不关窗、不改任何状态 ⇒
 * 桌面窗口仍在原处，用户可以随时再切回来 ✓（不做成"关闭桌面窗口"是刻意的：关了就回不去）。
 */
| { readonly method: 'focusIde' }
	/**
	 * 打开 **Agent 花名册 / 管理**（输入框 Agents 面板的底部动作）。
	 *
	 * 说明：dsh 侧那份只读花名册页（`vssaros-agents` 的 `/x/agents`）在宿主里**没有承载容器**
	 * （本视图是固定路由），所以打开 VsSaros 原生的 Agent 列表视图（`agentStudio.presetAgent.focus`），
	 * 失败回落资源管理页（`agentStudio.openResourceManager`）。两者都是既有命令，不新增宿主实现。
	 */
	| { readonly method: 'openAgentRoster' }
/**
 * **工作台页 → 聊天草稿**：把一条引用推进**当前活动的那个 dsh 聊天框**（2026-10-14，桥 `4 → 5`）。
 *
 * 为什么必须经宿主（两条都是实测事实，不是推测）：
 * ① **页面桥是单向的** —— `DSH_PAGE_IPC_INVOKE` 在主进程只回 `true`/`'pong'`，页面拿不到任何返回值；
 * ② **插件页拿不到会话身份** —— plugin-page 创建时 `sessionId` 显式传 `undefined`
 *    （`dshPluginPageEditorPane.ts` / `dshPluginViewPane.ts`），所以 `api.sessionId === null`
 *    ⇒ "该投给哪个聊天视图"只有宿主能定（`IDshHarnessService.activeChatViewId`）。
 *
 * ⚠ 与 `DSH_PAGE_IPC_INSERT`（host → page，方向相反）**不是同一条**：那条是宿主把引用推给**页面自身**
 * （编辑器右键 → 聊天页插件）；这条是工作台页把引用推给**另一个视图**（聊天框）。两者共用同一个
 * 负载形状 {@link IDshInsertReference}，但**落点不同**，别互相顶替。
 */
| { readonly method: 'insertChatReference'; readonly path: string; readonly startLine?: number; readonly endLine?: number }
/**
 * 打开**某个 bot 的 Agent 设置**编辑器页（dsh 的 Agents 页 `/x/agents` 行内「设置」）。
 *
 * 为什么必须经宿主：与 `openAgentMarket` 同源 —— 编辑器页只有 VsSaros 能创建，页面（WebContentsView）不行。
 * ⚠ 安全模型没被放宽：这条命令**只负责"把 IDE 自己的设置界面显示出来"**，写入仍然发生在 VsSaros 的
 *   设置页里、由用户点保存 ⇒ 页面侧依旧拿不到任何写入能力 ✓（见本文件头部的安全模型）。
 *
 * `agentId` 的口径 = `.agent.md` 所在**目录名**，与 VsSaros 的 `Agent.id` 天然同值
 * （`agentStudioService.getAgents()` 三级合并里 `agents/{id}/.agent.md`、内置源
 * `resources/.agents/agents/{id}/.agent.md` 的 `{id}` 就是它）⇒ **不需要映射表**。
 * `name` 只是缺 id 时的提示文案（展示文本，不参与身份判定）。
 */
| { readonly method: 'openAgentSettings'; readonly agentId: string; readonly name?: string }
/**
 * 打开某个**资源条目的设置**（「工具」页（`/x/skills/`）行内齿轮；2026-10-15 新增，桥 `9 → 10`）。
 *
 * 两条落点的取舍（都试过才这么定 ✓）：
 *   · `kind: 'skill'` ⇒ **资源管理详情页**（`ResourceManagerEditorInput` + `showDetailOnly('skill', id)`）——
 *     那页已有"编辑 SKILL.md / 启停 / 卸载"，是技能真正能改的地方 ✓（`integrationView` 侧栏点行也是这条 ✓）。
 *   · `kind: 'mcp'` ⇒ **打开发真源文件** `<数据根>/mcp.json`。⚠ 不用 IDE 那个 MCP 管理页是**刻意的**：
 *     它读的是 `{root}/mcp/<slug>/config.json` 再同步进 VS Code 配置，而 dsh 侧挂载读的是这份**扁平的**
 *     `mcp.json`（页面自己也把它的路径印在诊断行上）⇒ 指到那个页会"点了设置、看到另一个列表" ✗。
 *
 * `id` 的口径：技能 = 技能目录名（`<数据根>/skills/<id>`）；MCP = `mcp.json` 里的 server 名。
 * 只校验**形状**（"是否真的存在"由落点那一侧回答：技能详情页对不存在的 id 显示空表单、mcp.json 打开后
 * 用户自己看得见 ✓）—— 页面桥不做 fs 查询 ✓。
 */
| { readonly method: 'openResourceSettings'; readonly kind: 'skill' | 'mcp'; readonly id: string }
/**
 * 让 **IDE 窗口原地进**某个工作区（多根一起进、不重载窗口；2026-10-16，桥 `10 → 11`）。
 *
 * 为什么要有这条：dsh 聊天页的工作区下拉现在会把"被宿主编排成 N 条记录的多根工作区"合成一行
 * （见 `DSH_PAGE_IPC_WORKSPACES`），用户点它**期望**的是"进这个工作区"，而不只是"在这个目录起一段会话"
 * —— 后者会让左边的资源管理器 / 标题 / SCM 全停在旧工作区，用户看到的就是"点了没反应" ✗（用户报障原话）。
 *
 * 口径：`workspaceId` = **IDE 侧** `Workspace.id`（不是 dsh 的 workspaceId ✗，两者没有映射关系）。
 * 宿主只把它转成 IDE 自己的命令（`agentStudio.workspace.activate`），**不**在这里自己改窗口 folders
 * —— folder 列表的合法写者只有少数几处（`workspaceFolderWriters.test.ts` 的 ALLOWED_FOLDER_WRITERS），
 * 且历史上"追加式注入 folder"引发过跨工作区污染（见 `sourceControl.contribution.ts` 的事故记录）✗。
 */
| { readonly method: 'switchWorkspace'; readonly workspaceId: string }
	/**
	 * 请 **IDE 侧**登录（2026-10-21，桥 `16 → 17`）：dsh 窗口里的「登录」按钮**不自己登录**，
	 * 而是请 IDE 走它那套账号流程（TOF/OA：开系统浏览器）⇒ 窗口与 IDE **同一份登录态** ✓。
	 *
	 * ⚠ 无参：页面**不能**指定"登录成谁 / 登出谁"（那是 IDE 侧账号服务的事 ✗）⇒ 只表达意图 ✓。
	 * ⚠ 页面桥是**单向**的（只回 true）⇒ 登录结果**不回传**；窗口那一行的状态由 IDE 推
	 *   （`DSH_PAGE_IPC_AUTH`）⇒ 不猜、不缓存 ✓。
	 */
	| { readonly method: 'signInIde' }
	/** 同上：登出（IDE 侧账号服务执行）。 */
	| { readonly method: 'signOutIde' }
	/**
	 * 打开 **IDE 的设置页**（2026-10-21 新增，桥 `17 → 18`）。
	 *
	 * 触发点：dsh 窗口**左下角**账号菜单（`client.account.js` 的弹层）里的「⚙ 设置」——
	 * 用户给的参照布局就是这个账号菜单（设置 / 意见反馈 / 退出登录 + 账号 chip）。
	 *
	 * 为什么经宿主：dsh 页面（WebContentsView）里没有 IDE 的设置编辑器；`Ctrl+,` 只在 IDE 窗口内有效
	 * ⇒ 只有宿主能执行 `workbench.action.openSettings` ✓。无参（页面不能指定"打开哪一条设置"）。
	 */
	| { readonly method: 'openSettings' }
	/**
	 * 打开 **IDE 的意见反馈**（2026-10-21 新增，桥 `17 → 18`，与 `openSettings` 同批）。
	 *
	 * 触发点：同一个账号菜单里的「✈ 意见反馈」。宿主执行 `workbench.action.openIssueReporter`
	 * （带环境/扩展信息的标准反馈通道，比丢一个 URL 靠谱 ✓）。无参。
	 */
	| { readonly method: 'openFeedback' };

/**
 * **不需要 IDE 主窗口露面**的页面桥命令（2026-10-21 新增；原先是 `dshHarness.contribution.ts` 里的私有静态集，
 * 提到 common 是为了**能被单测钉住** —— 私有静态集没人能断言，等于没有守卫 ✗）。
 *
 * 背景：启动时若把 IDE 主窗口收进了任务栏（`openDesktopOnStartup`，"F5 只看到 dsh 窗口"），
 * 而命令作用在看不见的窗口上 ⇒ 用户看到的就是"点了没反应"（本仓高频缺陷形态）⇒ 所以凡是要让
 * IDE 出界面的命令，到达时先把主窗口还原到前台（`DshPageCommandContribution._handle` 开头）。
 *
 * ⚠ 用**黑名单**（这份名单）而不是白名单：新增的桥命令默认按"要给 IDE 出界面"处理，
 *   忘登记只会多还原一次窗口，不会变成"点了没反应" ✓。
 *
 * ★★ 2026-10-21（用户原话："窗口模式下，点击登录会切换到 ide 模式，要求不切换，在当前模式下，直接登录"）：
 *   `signInIde` / `signOutIde` 登记进这份名单 ⇒ 窗口里点「登录」**不再**把 IDE 主窗口拉到前台 ✓。
 *   为什么它们**不需要** IDE 界面：TOF/OA 登录全程在**扩展宿主 + 系统浏览器**里完成
 *   （`extensions/tof-authentication`：起 loopback server → `env.openExternal` 开浏览器 → 等回调 →
 *   `fetchWhoami`），IDE 窗口既不弹窗也不需要被看见 ⇒ 登录能在**当前窗口里原地完成** ✓。
 *   登录结果由 IDE 通过 `DSH_PAGE_IPC_AUTH` **推**回页面（状态是推的 ⇒ 不会说谎 ✓），
 *   页面那行「登录」/「退出登录」随即翻转。
 */
export const DSH_PAGE_COMMANDS_WITHOUT_IDE_UI: ReadonlySet<Exclude<DshPageCommand['method'], 'ping'>> = new Set([
	'notify',                    // 只是 IDE 的通知条（在收起的窗口里弹也无所谓）
	'focusIde',                  // 本身就是"回 IDE"，由下面自己的分支处理
	'insertChatReference',       // 投给活动聊天框
	'sessionTitle', 'sessionPersona',   // 页面 → 工作台的上报
	'switchPreset', 'newSession',       // 聊天宿主自己换绑 / 本页新会话
	'switchWorktree', 'switchWorkspace', // 宿主侧起会话 / 换工作区（无 IDE 界面变化）
	'kbFeishuSync', 'kbAddVault', 'kbRemoveVault', // 数据动作（原生对话框自带前台）
	'signInIde', 'signOutIde',   // ★ 账号动作：浏览器里登录，IDE 窗口不必露面 ⇒ 不许切模式 ✗
]);

export interface IDshPageKeyEvent {
	readonly key: string;
	readonly keyCode: number;
	readonly code: string;
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly metaKey: boolean;
	readonly repeat: boolean;
}

/** 主进程 → renderer 的视图事件（经 DSH_HARNESS_CHANNEL 的 onDidPageEvent）。 */
export type DshPageEvent =
	| { readonly viewId: string; readonly kind: 'command'; readonly command: Exclude<DshPageCommand, { method: 'ping' }> }
	| { readonly viewId: string; readonly kind: 'keydown'; readonly event: IDshPageKeyEvent }
	| { readonly viewId: string; readonly kind: 'focus' }
	/**
	 * ★ 2026-10-19：改名**回执**（页面 → 工作台）。
	 * `error` 有值 = 页面侧改名失败（含 `ctx.sessions.rename` 不可用、dsh 拒绝）；调用方必须看它，
	 * 不能把"命令已发出"当成"改成功了" ✗（上一次踩坑就是这么来的：桥无返回值 + 乐观刷新）。
	 */
	| { readonly viewId: string; readonly kind: 'renamed'; readonly sessionId: string; readonly title?: string; readonly error?: string };

const MAX_PATH = 4096;
const MAX_TEXT = 500;
const MAX_LINE = 10_000_000;

function isPath(v: unknown): v is string {
	return typeof v === 'string' && v.length > 0 && v.length <= MAX_PATH && !v.includes('\0');
}

function isLine(v: unknown): v is number {
	return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_LINE;
}

/** 绝对路径：POSIX `/x`、Windows `C:\x` / `C:/x`、UNC `\\server\share`。不接受相对路径与 URI。 */
export function isAbsoluteFsPath(p: string): boolean {
	return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p);
}

/**
 * 校验并规范化页面传来的命令；不合法返回 undefined（调用被静默拒绝，只记日志）。
 * 只拷贝白名单字段，页面多塞的属性不会穿过桥。
 */
export function validatePageCommand(raw: unknown): DshPageCommand | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const r = raw as Record<string, unknown>;
	switch (r.method) {
		case 'ping':
			return { method: 'ping' };
		case 'openFile': {
			if (!isPath(r.path) || !isAbsoluteFsPath(r.path)) {
				return undefined;
			}
			const startLine = r.startLine === undefined ? undefined : isLine(r.startLine) ? r.startLine : null;
			const endLine = r.endLine === undefined ? undefined : isLine(r.endLine) ? r.endLine : null;
			if (startLine === null || endLine === null || (endLine !== undefined && (startLine === undefined || endLine < startLine))) {
				return undefined;
			}
			return { method: 'openFile', path: r.path, startLine, endLine };
		}
		case 'openMarkdown': {
			// 计划审阅等"内容在内存里"的 markdown（2026-10-15：dsh 开在它的右侧栏 plan-review tab，
			//   我们壳没有侧栏 ⇒ 改投 IDE 编辑器区的 untitled 页 ✓）。text 必须非空 string + 512KB 上限
			//   （页面是外部输入面 ✓）；title 超形就丢（不为个标题把整份文档拒掉 ✗）。
			if (typeof r.text !== 'string' || r.text.length === 0 || r.text.length > 512 * 1024) {
				return undefined;
			}
			const title = typeof r.title === 'string' && r.title.length > 0 && r.title.length <= 200 ? r.title : undefined;
			return { method: 'openMarkdown', text: r.text, title };
		}
		case 'reveal':
			return isPath(r.path) && isAbsoluteFsPath(r.path) ? { method: 'reveal', path: r.path } : undefined;
		case 'notify': {
			if ((r.kind !== 'info' && r.kind !== 'done' && r.kind !== 'attention') || typeof r.text !== 'string' || !r.text.trim()) {
				return undefined;
			}
			return { method: 'notify', kind: r.kind, text: r.text.slice(0, MAX_TEXT) };
		}
		case 'sessionTitle': {
			// 标题只承载展示文本：会话 id 允许 null（页面还没绑定会话时），标题长度按 MAX_TEXT 截断。
			const sid = r.sessionId === null || r.sessionId === undefined
				? null
				: (typeof r.sessionId === 'string' && r.sessionId.length <= 200 ? r.sessionId : undefined);
			if (sid === undefined) {
				return undefined;
			}
			if (r.title === null || r.title === undefined) {
				return { method: 'sessionTitle', sessionId: sid, title: null };
			}
			if (typeof r.title !== 'string') {
				return undefined;
			}
			const title = r.title.trim();
			return { method: 'sessionTitle', sessionId: sid, title: title ? title.slice(0, MAX_TEXT) : null };
		}
		case 'sessionPersona': {
			// 与会话标题同口径：`sessionId` 由 preload 注入（null = 本视图还没绑会话）；
			// 人格 id 是**另一个 agent 的 id** ⇒ 与 openSession 的 agentPreset 同一字符集。
			const sid = r.sessionId === null || r.sessionId === undefined
				? null
				: (typeof r.sessionId === 'string' && r.sessionId.length <= 200 ? r.sessionId : undefined);
			if (sid === undefined) {
				return undefined;
			}
			const personaId = r.personaId === null || r.personaId === undefined
				? null
				: (typeof r.personaId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.personaId) ? r.personaId : undefined);
			if (personaId === undefined) {
				return undefined;
			}
			// 显示名是可选的展示文本：非字符串 / 空白 ⇒ 缺席（回落到 personaId，与 `personaLabelOf` 同口径）。
			const name = typeof r.name !== 'string' || !r.name.trim() ? undefined : r.name.trim().slice(0, MAX_TEXT);
			// `applicable` 只收布尔；非布尔当**未知**（不猜"适用" —— 猜错会让侧栏显示一个不存在的人格标记 ✗）。
			const applicable = typeof r.applicable === 'boolean' ? r.applicable : undefined;
			return {
				method: 'sessionPersona', sessionId: sid, personaId,
				...(name === undefined ? {} : { name }),
				...(applicable === undefined ? {} : { applicable }),
			};
		}
		case 'showUncommittedDiff': {
			// 与 openFile / reveal 同口径：**绝对路径**、拒控制字符（工作台按 fsPath 交给扩展命令 ✓）
			if (typeof r.path !== 'string' || !isAbsoluteFsPath(r.path) || r.path.length > 1024) {
				return undefined;
			}
			if (/[\u0000-\u001f]/.test(r.path)) {
				return undefined;
			}
			return { method: 'showUncommittedDiff', path: r.path };
		}
		case 'openTerminal': {
			// cwd 可选、必须是**绝对路径**（与 openFile/reveal 同口径：相对路径的基准在页面里不可靠）；
			// command 可选、允许换行（多行命令），但有长度上限 + 拒绝 NUL（NUL 进终端会截断文本）。
			const cwd = r.cwd;
			if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsoluteFsPath(cwd) || cwd.length > 1024)) {
				return undefined;
			}
			const text = r.command;
			if (text !== undefined) {
				if (typeof text !== 'string' || text.length > 2000 || text.indexOf('\u0000') >= 0) {
					return undefined;
				}
			}
			return { method: 'openTerminal', ...(cwd !== undefined ? { cwd } : {}), ...(text !== undefined ? { command: text } : {}) };
		}
		case 'switchWorkspace': {
			// ⚠ 它**不是路径**（是 IDE registry 的查找键）⇒ 刻意**不**套 `isAbsoluteFsPath` / 路径字符集：
			//   `Workspace.id` 由工作区名派生（可能是中文 / 空格，如 `我的仓-abc12`）⇒ 按路径收紧会把合法
			//   工作区全拒掉 ✗（那又变成"点了没反应" ✓）。只放形状：非空 + 长度 + 无控制字符。
			//   "这个 id 存不存在"由 IDE 侧命令回答（找不到就**如实抛**，宿主记 warn ✓）—— 页面桥不做 registry 查询 ✓。
			if (typeof r.workspaceId !== 'string') {
				return undefined;
			}
			const workspaceId = r.workspaceId.trim();
			if (!workspaceId || workspaceId.length > 200 || /[\u0000-\u001f]/.test(workspaceId)) {
				return undefined;
			}
			return { method: 'switchWorkspace', workspaceId };
		}
		case 'newSession': {
			// 「＋ 新建会话」= 给**当前页签**换一段新对话：不需要任何参数（id 由宿主派生）。
			// 与其它分支同口径：多余字段一律丢掉 ✓ —— 漏了这个 case 会让整条命令被**静默丢弃**
			// （页面点了没反应，而日志里什么都没有 ✗，2026-10-12 加该方法时特意补的第一处）。
			return { method: 'newSession' };
		}
		case 'newChat': {
			// `agentPreset` 可选（2026-10-11）：带它 = "在该 preset 下新建一个会话"（Commands 的 Preset 行）。
			// 校验口径与 openSession 的 agentPreset 完全一致（dsh preset id 字符集）。
			if (r.agentPreset === undefined) {
				return { method: 'newChat' };
			}
			if (typeof r.agentPreset !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.agentPreset)) {
				return undefined;
			}
			return { method: 'newChat', agentPreset: r.agentPreset };
		}
		case 'switchWorktree': {
			// 只收**绝对路径**（与 openFile/reveal 同口径）：相对路径的基准在页面里不可靠，
			// 而宿主会拿它当 `session.start` 的 `cwd` ⇒ 必须是一个确定的目录。
			// 真正的权威校验在宿主（比对主工作区路径、决定要不要加 `--wt-` 段）。
			if (typeof r.path !== 'string' || !isAbsoluteFsPath(r.path) || r.path.length > 1024) {
				return undefined;
			}
			// 控制字符（NUL 等）不是合法文件系统路径，而宿主会把它交给 `session.start` / git
			// ⇒ 一律拒（`isAbsoluteFsPath` 只判形状，管不到这些）。
			if (/[\u0000-\u001f]/.test(r.path)) {
				return undefined;
			}
			return { method: 'switchWorktree', path: r.path };
		}
		case 'openSession': {
			// 只放形状（真正的权威校验在宿主：`isDshChatSessionId`）；preset / cwd 允许缺省。
			if (typeof r.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(r.sessionId)) {
				return undefined;
			}
			if (r.agentPreset !== undefined && (typeof r.agentPreset !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.agentPreset))) {
				return undefined;
			}
			// `cwd`（2026-10-19）：绝对路径形状；带控制字符 / 非绝对路径一律拒（宿主会拿它去 session.start）。
			if (r.cwd !== undefined && (typeof r.cwd !== 'string' || !isAbsoluteFsPath(r.cwd) || /[\u0000-\u001f]/.test(r.cwd))) {
				return undefined;
			}
			return {
				method: 'openSession',
				sessionId: r.sessionId,
				...(r.agentPreset === undefined ? {} : { agentPreset: r.agentPreset }),
				...(r.cwd === undefined ? {} : { cwd: r.cwd }),
			};
		}
		case 'renameSession': {
			// 改名：id/preset/cwd 与 openSession 同一套形状；`title` 是**用户输入** ⇒ 必须收紧
			//   （非空、去首尾空白后仍非空、上限 120、拒控制字符 —— dsh 侧 `session/title-invalid` 会拒，
			//   但桥这层先挡能给出更早、更清楚的拒绝）。
			if (typeof r.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(r.sessionId)) {
				return undefined;
			}
			if (typeof r.title !== 'string') {
				return undefined;
			}
			const title = r.title.trim();
			if (!title || title.length > 120 || /[\u0000-\u001f]/.test(title)) {
				return undefined;
			}
			if (r.agentPreset !== undefined && (typeof r.agentPreset !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.agentPreset))) {
				return undefined;
			}
			if (r.cwd !== undefined && (typeof r.cwd !== 'string' || !isAbsoluteFsPath(r.cwd) || /[\u0000-\u001f]/.test(r.cwd))) {
				return undefined;
			}
			return {
				method: 'renameSession',
				sessionId: r.sessionId,
				title,
				...(r.agentPreset === undefined ? {} : { agentPreset: r.agentPreset }),
				...(r.cwd === undefined ? {} : { cwd: r.cwd }),
			};
		}
		case 'switchPreset': {
			// dsh preset id：字母数字开头，可含 . _ -（如 standard/ptc/cordis/自定义）；拒绝路径字符与空白。
			if (typeof r.presetId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.presetId)) {
				return undefined;
			}
			return { method: 'switchPreset', presetId: r.presetId };
			}
			case 'openModulePage': {
			// 只放**形状**（站内绝对路径）；**权威校验在宿主**：必须是 `DSH_MODULE_PAGES` 里的路由 ✓。
			// ⚠ 形状这关也要真挡：允许字符集里含 `.` 与 `/` ⇒ 不显式拒 `..` 的话 `/x/../y` 会**通过** ✗
			//   （第一版就漏了这条，被用例抓住 ✓）。口径与 `dshPluginPage.ts: validatePluginRoute` 一致：
			//   末尾允许空段（`/x/y/`），中间空段 / `.` / `..` / 查询串 / 井号 / 反斜杠 / 空白一律拒 ✗。
			if (typeof r.route !== 'string' || r.route.length > 200 || !/^\/[A-Za-z0-9._~\/-]+$/.test(r.route) || r.route.startsWith('//')) {
				return undefined;
			}
			const segs = r.route.slice(1).split('/');
			if (segs.some((seg, i) => seg === '.' || seg === '..' || (seg === '' && i !== segs.length - 1))) {
				return undefined;
			}
			return { method: 'openModulePage', route: r.route };
			}
			case 'setWorkbenchPinned':
			case 'setWorkbenchHidden': {
			// 与 `openModulePage` **同一套形状校验**（站内绝对路径）＋ **同一个宿主白名单** ✓
			//（形状这关必须真挡 `..`：允许字符集里含 `.` 和 `/`，不显式拒的话 `/x/../y` 会通过 ✗）
			if (typeof r.route !== 'string' || r.route.length > 200 || !/^\/[A-Za-z0-9._~\/-]+$/.test(r.route) || r.route.startsWith('//')) {
				return undefined;
			}
			const segs = r.route.slice(1).split('/');
			if (segs.some((seg, i) => seg === '.' || seg === '..' || (seg === '' && i !== segs.length - 1))) {
				return undefined;
			}
			// 布尔值必须是**真的布尔**（"设成 true"语义 ⇒ 不接受省略/字符串 ✓）
			const flag = r.method === 'setWorkbenchPinned' ? r.pinned : r.hidden;
			if (typeof flag !== 'boolean') {
				return undefined;
			}
			return r.method === 'setWorkbenchPinned'
				? { method: 'setWorkbenchPinned', route: r.route, pinned: flag }
				: { method: 'setWorkbenchHidden', route: r.route, hidden: flag };
			}
			case 'insertChatReference': {
			// 形状判据**与 `IDshInsertReference` 同一套**（绝对 fs 路径或干净的 posix 相对路径 + 行号整数边界 + 区间有序）
			// ⇒ 直接复用那个校验器，别在这里另写一份（两份必分叉 ✗）。
			// ⚠ 不能把 `r` 直接喂给谓词：`r` 是 `Record<string, unknown>`（带索引签名），谓词在它身上窄化不成立
			//   （tsgo 实测报 "Property 'path' does not exist on type 'true'"）⇒ 先过一趟 `unknown` 局部变量。
			const candidate: unknown = r;
			if (!validateInsertReference(candidate)) {
				return undefined;
			}
			return {
				method: 'insertChatReference',
				path: candidate.path,
				...(candidate.startLine === undefined ? {} : { startLine: candidate.startLine }),
				...(candidate.endLine === undefined ? {} : { endLine: candidate.endLine }),
			};
			}
			case 'openKbSettings':
			// ⚠ 2026-10-15 补：这条与下面一条（第 41 刀加的，桥 `6 → 7`）**当时漏了这个 case** ✗ ⇒ 落到 default
			//   被**静默丢弃** ⇒ 宿主 handler 永远收不到 ⇒ ⚙ / 🕸 两个按钮在真机上"点了没反应" ✓
			//   （与下面 `newSession` 那条注释警告的是**同一个**失效形态 ✗ —— 页面侧无感、日志里也什么都没有）。
			//   ⇒ 现在由 `test/common/dshPageBridge.test.ts` 的**全族扫描守卫**钉住：协议里声明的每条命令
			//     都必须在这里有 case，漏一条即红 ✓。
			return { method: 'openKbSettings' };
		case 'openKbGraph':
			return { method: 'openKbGraph' };
		case 'kbFeishuSync':
			// 桥 `11 → 12`（2026-10-19）：页面「同步飞书」按钮 ⇒ 宿主转 `agentStudio.kb.feishuSync`。
			// ⚠ 与上面两条同一个教训：**协议声明了就必须有 case**（漏了会落到 default 被静默丢弃，
			//   真机表现是"点了没反应"✗）—— 由 dshPageBridge.test.ts 的全族扫描守卫钉住。
			return { method: 'kbFeishuSync' };
		case 'kbAddVault':
			// 知识库增删（桥 `7 → 8`，2026-10-15）。`kbAddVault` **无参**（选哪个目录由用户在原生对话框里定 ✓）。
			return { method: 'kbAddVault' };
		case 'kbRemoveVault': {
			// 只放**形状**（与 agentId / personaId 同一套字符集 ✓）；"这个库存不存在"由宿主视图回答
			// （页面桥不做 storage 查询 ✓，也不允许页面借它删任意路径 ✓ —— 宿主只按自己的清单找库）。
			// ⚠ 别把 id 形态焊死成"21 位时间戳"✗：真源 `newVaultId()` 现在是那个形状，但那是 IDE 内部事实 ✓。
			if (typeof r.vaultId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.vaultId)) {
				return undefined;
			}
			return { method: 'kbRemoveVault', vaultId: r.vaultId };
		}
		case 'openAgentMarket':
			return { method: 'openAgentMarket' };
		// 无参命令（与 openAgentMarket 同一形态：没有可伪造的入参 ⇒ 不需要形状校验 ✓）
		case 'openSkillMarket':
			return { method: 'openSkillMarket' };
		// 桥 `14 → 15`（2026-10-19）：无参命令（与上面两条同形态）。
		case 'openMediaGallery':
			return { method: 'openMediaGallery' };
		// 桥 `15 → 16`（2026-10-21）：回到 IDE 主窗口。无参（与上面三条同形态）。
		// ⚠ 协议声明了就必须有 case —— 漏了会落到 default 被**静默丢弃**（真机表现"点了没反应"✗），
		//   由 dshPageBridge.test.ts 的全族扫描守卫钉住。
		case 'focusIde':
			return { method: 'focusIde' };
		// 桥 `16 → 17`（2026-10-21）：登录/登出**接管 IDE 的账号**（TOF/OA）。
		// ⚠ 协议声明了就必须有 case —— 漏了会落到 default 被**静默丢弃**（真机表现"点了没反应"✗），
		//   由 dshPageBridge.test.ts 的全族扫描守卫钉住 ✓。
		case 'signInIde':
			return { method: 'signInIde' };
		case 'signOutIde':
			return { method: 'signOutIde' };
		// 桥 `17 → 18`（2026-10-21）：左下角账号菜单里的「设置 / 意见反馈」。无参（同上）。
		case 'openSettings':
			return { method: 'openSettings' };
		case 'openFeedback':
			return { method: 'openFeedback' };
			case 'openAgentRoster':
			return { method: 'openAgentRoster' };
			case 'openAgentSettings': {
			// agentId 走 agent id 字符集（= `.agent.md` 目录名，与 `sessionPersona` 的 personaId 同一套：
			// 字母数字开头、可含 `. _ -`、长度 64 内）；`name` 是纯展示文本、按 MAX_TEXT 截断。
			// ⚠ 这里只把**形状**；"这个 id 是否真的存在"由设置页自己回答（打开一个不存在的 id 会显示空表单，
			//   不会写盘 ✓）—— 页面桥不做 fs 查询。
			if (typeof r.agentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.agentId)) {
				return undefined;
			}
			const name = typeof r.name !== 'string' || !r.name.trim() ? undefined : r.name.trim().slice(0, MAX_TEXT);
			return name === undefined
				? { method: 'openAgentSettings', agentId: r.agentId }
				: { method: 'openAgentSettings', agentId: r.agentId, name };
		}
		case 'openResourceSettings': {
			// 桥 `9 → 10`（2026-10-15）。kind 是**封闭集**（两类落点各不同 ⇒ 不含"别的资源"这种含糊值 ✗）；
			// id 只校验形状：技能走技能目录名那套字符集（与 openAgentSettings 的 agentId 同口径 ✓），
			// MCP 放宽一点（server 名可能出现 `:`/`@`，如 `foo:bar`、`@scope/pkg` 风格的自定义名 ✓）。
			const kind = r.kind === 'skill' || r.kind === 'mcp' ? r.kind : undefined;
			if (!kind || typeof r.id !== 'string') {
				return undefined;
			}
			const ok = kind === 'skill'
				? /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.id)
				: /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/.test(r.id);
			return ok ? { method: 'openResourceSettings', kind, id: r.id } : undefined;
		}
		default:
		return undefined;
	}
}

export function validateKeyEvent(raw: unknown): IDshPageKeyEvent | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const r = raw as Record<string, unknown>;
	if (typeof r.key !== 'string' || r.key.length > 32 || typeof r.code !== 'string' || r.code.length > 32 || typeof r.keyCode !== 'number') {
		return undefined;
	}
	const b = (v: unknown) => v === true;
	return { key: r.key, keyCode: r.keyCode, code: r.code, ctrlKey: b(r.ctrlKey), shiftKey: b(r.shiftKey), altKey: b(r.altKey), metaKey: b(r.metaKey), repeat: b(r.repeat) };
}

/** 判断路径是否位于某个根目录之内（大小写按平台；只做字符串前缀判定，调用方传入已规范化的路径）。 */
export function isPathInside(child: string, roots: readonly string[], caseInsensitive: boolean): boolean {
	const norm = (p: string) => {
		const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
		return caseInsensitive ? s.toLowerCase() : s;
	};
	const c = norm(child);
	return roots.some(root => {
		const r = norm(root);
		return r.length > 0 && (c === r || c.startsWith(r + '/'));
	});
}
