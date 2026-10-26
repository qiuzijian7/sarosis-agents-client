# 目录结构、打包与部署

## 一个工作台插件的完整样子

```
dsh-plugins/vssaros-<module>/
├── package.json           ← 清单（main / exports / files / dsh）
├── cordis.patch.yml       ← 插件进运行时的唯一入口
├── README.md              ← 可选：给人看
├── lib/
│   ├── index.js           ← Host 半：服务、路由、数据读写
│   ├── client.js          ← 客户端入口：apply(ctx) + 注册工作台
│   ├── client.<name>.js   ← 客户端子块：面板实现（chunk 形状）
│   ├── vendor/            ← 可选：需要自带 React 时放这里（市场包用过）
│   └── page.css           ← 可选：自托管页面样式
├── test/
│   └── run-<module>-check.mjs   ← 本包自检（推荐，进 npm run check:dsh-plugins）
└── skills/<skill>/        ← 可选：插件自带技能
```

真实样例（可直接打开对照）：

- 最小注册式：`dsh-plugins/vssaros-kanban/lib/client.kanban.js`
- 带 AI 助手右栏：`dsh-plugins/vssaros-agents/lib/client.agents.js`（对话在中栏）、`dsh-plugins/vssaros-marketplace/lib/workbench.js`（右栏 + 伸缩，**样例**）
- iframe 托管页 + 助手：`dsh-plugins/vssaros-studio/lib/client.js`

## 共享层在哪

| 东西 | 位置 |
|---|---|
| `wb-*` 原语样式 | `dsh-plugins/vssaros-workbenches/lib/client.ui.js`（宿主全局注入，工作台不用再 import） |
| 工作台框架（Frame / 注册表 / dock） | `dsh-plugins/vssaros-workbenches/lib/client.js` |
| 对话停靠（`props.conversation`） | 同上 `ConversationMount`（约 L436） |

## 从开发目录到运行时

1. 插件源码在 `dsh-plugins/vssaros-<module>/`。
2. 部署即复制到 profile 的 `node_modules/@vssaros/dsh-<module>/`：

```powershell
$nm = "$env:USERPROFILE\.vssaros-dev\dsh-home\profiles\vssaros\node_modules\@vssaros"
Copy-Item "dsh-plugins\vssaros-tasks\lib\client.tasks.js" "$nm\dsh-tasks\lib\client.tasks.js" -Force
```

3. **改客户端代码后要刷新前端 chunk**（F5）；改 Host 半 / 清单 / `cordis.patch.yml` 则要**重启 dsh 窗口或 IDE**。
4. 打包（正式发布）时 `files` 里没列到的文件不会进包 —— 新加子块记得同步 `files`。

## 版本与 mtime 规则

- 加了子块或改了子块内容 ⇒ `package.json` 的 `version` 必须变（`check-chat-surface-chunks.mjs` 用它 + mtime 判断）。
- 只改入口、不动子块时也要 `touch` 入口，避免"入口比子块旧"。
- 浏览器端按版本做缓存区分，不升版本会继续吃旧 chunk。

## 外开（在系统浏览器打开）与深链

**不用每个工作台各写一遍**：按钮由外壳 `vssaros-workbenches` 的 `Frame` 统一渲染，
所有注册式工作台自动都有。它与「AI 助手展开」合并成 **S2 一体条**（`.vssWbActions`，
右边缘垂直居中、整组可拖）：

```
.vssWbActions  (data-vssaros-wb-actions=<id>)
 ├─ «  data-vssaros-wb-assist          仅当助手栏收起时显示
 ├─ ── .wbDivider
 └─ ↗  data-vssaros-wb-open-external   常显
```

详见 `assistant-collapse.md`（伸缩 + 一体条契约）。

链接形如：

```
http://127.0.0.1:6474/?token=<服务端现签的进程 token>#wb=vssaros%2Fstudio&alone=1
```

**`alone=1`**：外开只显示工作台 —— 前端打开工作台后调 `ctx.layout.toggleSidebar()` 收起左侧会话栏。
- 只能用 `toggleSidebar()`：`setSidebar(px)` 会被 `clampWidth(px, 264, 420)` 夹住，**关不掉**；
  store 初始 `sidebar` 固定 280，所以新窗口 toggle 一次必定归零。
- 收起后是 **56px 图标栏**（`computeColumns` 的 `collapsedWidth` 默认 56），不是完全消失；
  传 0 才完全隐藏，但那是 macOS desktop 的用法，web 版插件无法改。
- 客户端 `openWorkbenchInBrowser` 会给链接补齐 `alone=1`（服务端没升版本也能用）。
- 排查：`window.__vssarosWbDeepLink.sidebarCollapsed / sidebarError`。

⚠ **token 必须由服务端现签**，不能从 `location.search` 里抄。
`?token=` 只在"还没有有效 Cookie"时用，认证完会换成 Cookie；外开是**另一个浏览器**（没有那份 Cookie），
而 webview 里的 token 早已被消费掉 ⇒ 用本地 token 拼出来必然 401/白屏（2026-10-26 真机 bug：编辑器里打开是空白）。

正确做法（已实现）：服务端加一个路由，用 `connection.authenticatedUrl(origin + '/')` 现签：

```js
// dsh-plugins/vssaros-workbenches/lib/index.js
ctx.connection.fetch.register({
	path: `${PREFIX}/link`, methods: ['GET'],
	async fetch(request) {
		const reqUrl = new URL(request.url, 'http://dsh.internal');
		const origin = `${reqUrl.protocol}//${reqUrl.host}`;      // 用请求自身的 authority
		return Response.json({ url: ctx.connection.authenticatedUrl(origin + '/') + '#wb=' + encodeURIComponent(wb) });
	},
});
```

客户端**挂载时预取**这个链接（点击时必须同步 `window.open`，`await` 之后会被弹窗拦截器拦掉），
失败才回落本地拼。

- 工作台走 **hash**：Host 的 302 会丢掉 query，但浏览器会保留 hash。
- token 从当前 `location.search` 抄；拿不到就不带（浏览器里可能已有登录态）。
- 落地解析在 `parseDeepLinkWorkbench(search, hash, pending)`，优先级 **hash > query > localStorage 标记**；
  幂等，读 localStorage 后立即删除，避免下次普通打开被切走。
- 用户点了没反应（弹窗被拦截）⇒ 按钮 `data-state="blocked"` 变橙，再点一次即可。
- 真机排查：`window.__vssarosWbOpenExternal`（拼出的 URL）、`window.__vssarosWbOpenExternalError`、
  `window.__vssarosWbDeepLink`（深链消费过程）。

**注意**：AI 助手在 web 版同样会渲染（同一个 dsh 前端 + `props.conversation`），
所以「外开」看到的是完整工作台；而 iframe 型工作台（studio/marketplace）的站点内容是另外加载的，
外开链接打开的是 **dsh 工作台**而不是裸站点页。

## 数据落盘

- 一律 `<DSH 数据根>/<plugin-id>/…`；**卸载插件不删数据**。
- 能"文件即数据"就不要造数据库（可迁移、可被任意编辑器打开）。
- 取数函数只写一次，SSR 页与 React 工作台共用（否则「页面说 32、工作台说 30」）。
- 写操作走 CAS 或串行化；同一实体动作要能防重复点（`Set<id>` busy）。

## IDE 侧还要登记什么（视需求）

- 活动栏图标 / 侧栏启动器：`src/vs/sessions/contrib/dshHarness/...`（描述符与清单必须逐字一致）。
- 新插件的模块容器：`dshModuleContainers.ts`。
- 数据根覆盖层：`dshCli.ts` 的 `renderDataRootOverlay` 名单。
- 改完跑 `node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs`。
