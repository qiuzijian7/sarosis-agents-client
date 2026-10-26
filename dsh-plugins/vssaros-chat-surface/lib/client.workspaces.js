// @vssaros/dsh-chat-surface — 侧栏 Workspaces 区：多根工作区「单条目 + hover 详情卡」
//（稿 1，2026-10-17 用户拍板；mockup doc/dsh-multiroot-single-item-mockup.html，
// 效果图 doc/mockup-images/single-item-1.png；4 稿对比 doc/dsh-sidebar-multiroot-variants-mockup.html）
// package-local chunk（契约同 client.sessions.js）：主包用 require.async 取回 install()。
//
// ── 为什么替换官方整区（sidebar.workspaces，single/root）────────────────────
// dsh 的工作区模型只能单目录，宿主上报时把 IDE 多根工作区的各根**摊平**成 N 条记录
// ⇒ 官方 WorkspaceBrowser 里同一工作区出现 N 次（真机截图实证：UE5EA×2 / S1Game×2）✗。
// 修法 = 用 `priority: -10` 遮蔽官方占用者（升序取最低者渲染，同 hero.workspace 先例 ✓），
// 换成本组件：
//   · 多根工作区只显示**一行**（名字 + 「N 个根」徽标），会话直接挂在条目下、按时间排序；
//   · hover 条目弹**详情卡**：每个根的完整路径 / 是否主根 / 会话数，当前会话 cwd 所在根标绿框；
//   · 会话行的根标注按稿 1：**只有非主根**的会话才带根名小标签（VS Code「仅多根才加前缀」的
//     降噪口径 ✓）；
//   · 没被任何 IDE 记录认领的 dsh 条目保持**平铺**（回落契约，与 client.workspace.js 的
//     buildTree 同口径 ✓）；
//   · 搜索框（条目多时）、＋添加工作区（官方同一条链：uiWorkspace.pickDirectory + workspaces.create ✓）。
// ⚠ 代价（拍板过的范围）：官方区的会话行菜单（pin/rename/fork/archive）本版**不带**。
// ⚠ chat-only 形态侧栏整列被 CSS 裁掉 ⇒ 本区只在全窗可见；chat 形态注册是无害空转 ✓。
//
// ── 2026-10-26（用户报障：「窗口模式下工作区的 ＋ 点了没反应」+「工作区下有大量空会话」）──
// ① ＋按钮原来**三重静默失败**（窗口模式尤其致命）：
//    a) 取选择器用 `ctx.remote.directoryPicker` —— 官方 client-ui-workspace 的 inject 里
//       **声明了** "remote" + "remote.directoryPicker"，我们**只声明了** "remote" ⇒ 这个名字
//       不是我们的服务（动态 client 门面读不到）⇒ picker 恒 undefined ⇒ 直接早退。
//       ⇒ 改走**已声明**的 `ctx.uiWorkspace.pickDirectory()`（官方同一份能力；本仓
//         vssaros-workbenches 早就在用这条 ✓）。
//    b) 老代码读 `res.value.path`，而 `pickDirectory()` 返回的是**路径字符串**
//       （原生 picker 的 value 就是 path）⇒ 恒 undefined ⇒ 选完目录也什么都不做。
//    c) 失败只写 `state.addWorkspaceError`，而**它从来没被渲染过**（全仓只有赋值）⇒
//       100% 静默；且窗口模式**没有宿主桥**（`window.vssarosDsh` 不存在）⇒ 连
//       `bridge.notify` 也是空转 ⇒ 用户只看到"点了没反应"。⇒ 现在错误**就地渲染**。
// ② 空会话：官方 roster 的每条会话带 `blank` 位（dsh-api-session-controller/types/list.js），
//    官方侧栏同样按 `!row.blank` 过滤 ⇒ 我们照做（当前会话例外）⇒ 列表不再被空会话刷屏。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.workspaces.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const SLOT = "sidebar.workspaces";
		const WORKSPACE_EVENT = "vssaros-dsh-workspaces";
		const HOVER_DELAY_MS = 350;

		// ── 纯逻辑（__test 可直接断言）────────────────────────────────────────
		function samePath(a, b) {
			if (!a || !b) { return false; }
			const n = (p) => String(p).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
			return n(a) === n(b);
		}
		function baseName(p) {
			const s = String(p || "").replace(/[\\/]+$/, "");
			const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
			return i >= 0 ? s.slice(i + 1) : s;
		}
		/** 与 client.workspace.js 的 parseWorkspaces 同形（chunk 间不共享代码，各持一份小实现 ✓）。 */
		function parseRecords(raw) {
			let list = null;
			try { list = raw ? JSON.parse(raw) : null; } catch { return []; }
			if (!Array.isArray(list)) { return []; }
			const out = [];
			for (const w of list) {
				if (!w || typeof w !== "object" || typeof w.id !== "string" || !w.id) { continue; }
				const roots = (Array.isArray(w.roots) ? w.roots : [])
					.filter((r) => r && typeof r.path === "string" && r.path)
					.map((r) => ({
						path: r.path,
						name: (typeof r.name === "string" && r.name.trim()) ? r.name.trim() : baseName(r.path),
						isPrimary: r.isPrimary === true,
					}));
				if (roots.length === 0) { continue; }
				out.push({
					id: w.id,
					name: (typeof w.name === "string" && w.name.trim()) ? w.name.trim() : (baseName(roots[0].path) || roots[0].path),
					roots,
					codeWorkspacePath: (typeof w.codeWorkspacePath === "string" && w.codeWorkspacePath) ? w.codeWorkspacePath : null,
				});
			}
			return out;
		}
		function readRecords() {
			try {
				if (typeof document === "undefined" || !document.documentElement) { return []; }
				return parseRecords(document.documentElement.dataset.vssarosWorkspaces);
			} catch { return []; }
		}
		/**
		 * 折叠状态切换（2026-10-17 真机 bug 的修复）。
		 *
		 * 约定：`collapsed[key] === true` 才算折叠（undefined / false 都是展开）。
		 * ★ 第一版写的是 `set(key, !isOpen)`：`isOpen = collapsed[key] !== true` ⇒ 展开态点击
		 *   写入 **false**（= 显式展开），永远写不进 true ⇒ **点了无法收缩** ✗（真机实证）。
		 *   正确写法是"把当前 isOpen 存进去"（展开 ⇒ true 折叠；折叠 ⇒ false 展开）。
		 *   相对比较型断言救不了这种 bug（两次取值恒相反）⇒ 守卫 ⑤ 钉**绝对期望值** ✓。
		 */
		function nextCollapsed(collapsed, key) {
			const cur = collapsed && collapsed[key] === true;
			return Object.assign({}, collapsed, { [key]: !cur });
		}
		function timeLabel(at) {
			if (!at) { return ""; }
			const s = Math.max(0, Math.round((Date.now() - at) / 1000));
			if (s < 60) { return "刚刚"; }
			const m = Math.floor(s / 60);
			if (m < 60) { return m + " 分钟"; }
			const h = Math.floor(m / 60);
			if (h < 24) { return h + " 小时"; }
			return Math.floor(h / 24) + " 天";
		}
		/**
		 * 收敛成渲染模型（模块作用域 ⇒ __test 直接断言；回落契约见文件头）。
		 * 返回 [{ kind: "group", record, sessions: [{id,title,at,rootName,isPrimaryRoot,isCurrent}] }
		 *        | { kind: "flat", item, sessions: [...] }]。
		 * 会话归属：dsh 快照条目的 sessionIds（真源 ✓）；条目按路径被记录认领 ⇒ 该条目的会话
		 * 都算这一组的；会话的根标签 = 它所在条目的 path 命中记录的哪个根。
		 */
		/**
		 * 会话显示标题（2026-10-21，用户：左栏要像 dsh-desktop ⇒ 不许整列 `session-xxxx`）。
		 *
		 * 真机症状：`s.title` 在本部署里**普遍为空**（标题插件没产出）⇒ 原实现直接回落 `sid`，
		 * 于是每行都是 `session-1eaede4-…`。这里按「有就用、没有就取摘要」的顺序找：
		 *   ① `title` ② `summary.displayTitle`（官方会话头用的就是它）
		 *   ③ `firstUserMessage` / `preview` / `lastMessage` ④ 最后才回落 id（宁可难看也不编造 ✓）
		 * 上限 48 字：侧栏只有 ~244px，再长也会被 CSS 省略号吞掉，先截断省一次布局 ✓。
		 */
		function titleOf(s, sid) {
			const pick = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
			const summary = (s && s.summary) || {};
			const raw = pick(s && s.title) || pick(summary.displayTitle)
				|| pick(s && s.firstUserMessage) || pick(s && s.firstUserMessageText)
				|| pick(s && s.preview) || pick(s && s.lastMessage);
			if (!raw) { return sid; }
			const flat = raw.replace(/[\r\n\t]+/g, " ").trim();
			return flat.length > 48 ? flat.slice(0, 48) + "…" : flat;
		}

		function buildSidebar(options) {
			const items = (options && options.workspaces) || [];
			const records = (options && options.records) || [];
			const byId = (options && options.sessionsById) || {};
			const archived = (options && options.archivedIds) || [];
			const currentId = (options && options.currentSessionId) || null;
			const claimed = {};
			const rows = [];
			const mkSess = (sid, rootName, isPrimaryRoot) => {
				const s = byId[sid] || {};
				return {
					id: sid,
					// 标题：title → summary.displayTitle → 首条消息摘要 → id（见 titleOf 的注释）
					title: titleOf(s, sid),
					at: (typeof s.updatedAt === "number" && s.updatedAt) || (typeof s.createdAt === "number" && s.createdAt) || 0,
					rootName: rootName || null,
					isPrimaryRoot: isPrimaryRoot !== false,
					isCurrent: sid === currentId,
					archived: archived.indexOf(sid) >= 0,
					// ★ 空会话（官方 roster 的 `blank` 位：这条会话没有任何对话内容）。
					//   官方侧栏同样按它过滤（`!row.archived && !row.blank`）⇒ 我们同口径 ✓。
					blank: s.blank === true,
				};
			};
			const sortSess = (list) => list.some((s) => s.at > 0)
				? list.sort((s1, s2) => (s2.at - s1.at) || (s1.id < s2.id ? -1 : 1))
				: list;
			for (const rec of records) {
				const members = items.filter((it) => it && it.workspaceId && !claimed[it.workspaceId]
					&& rec.roots.some((r) => samePath(r.path, it.path)));
				for (const m of members) { claimed[m.workspaceId] = true; }
				const sessions = [];
				let hiddenBlanks = 0;
				for (const m of members) {
					const root = rec.roots.filter((r) => samePath(r.path, m.path))[0];
					for (const sid of (Array.isArray(m.sessionIds) ? m.sessionIds : [])) {
						// 稿 1 降噪：只有**非主根**会话才带根名标签（守卫 ⑤ 钉住 ✓）
						const s = mkSess(sid, root && !root.isPrimary ? root.name : null, root ? root.isPrimary : true);
						if (s.archived) { continue; }
						// ★ 空会话不显示（2026-10-26 用户报「工作区下有大量空会话」）：
						//   这些会话一条消息都没有、标题只能回落到 id ⇒ 在列表里是纯噪音
						//   （本机实测 1931 条会话里 1813 条是这种空壳）⇒ 隐藏并**计数**
						//   （诚实披露，不装作没有）。★ 当前会话永远显示（哪怕它是空的）。
						if (s.blank && !s.isCurrent) { hiddenBlanks += 1; continue; }
						sessions.push(s);
					}
				}
				rows.push({ kind: "group", record: rec, sessions: sortSess(sessions), hiddenBlanks });
			}
			for (const it of items) {
				if (!it || !it.workspaceId || claimed[it.workspaceId]) { continue; }
				const sessions = [];
				let hiddenBlanks = 0;
				for (const sid of (Array.isArray(it.sessionIds) ? it.sessionIds : [])) {
					const s = mkSess(sid, null, true);
					if (s.archived) { continue; }
					if (s.blank && !s.isCurrent) { hiddenBlanks += 1; continue; }
					sessions.push(s);
				}
				rows.push({
					kind: "flat",
					label: (typeof it.name === "string" && it.name.trim()) ? it.name.trim() : (baseName(it.path) || it.workspaceId),
					path: it.path || null,
					sessions: sortSess(sessions),
					hiddenBlanks,
				});
			}
			return rows;
		}

		function install(ctx, shell) {
			const bridge = shell && shell.bridge;
			const state = shell && shell.state ? shell.state : {};

			const readWsSnapshot = () => {
				try {
					const ws = typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
					return ws && ws.list ? ws.list.getSnapshot() : null;
				} catch (e) { state.workspaceError = String((e && e.message) || e); return null; }
			};
			const readSessSnapshot = () => {
				try {
					const ss = ctx.sessions && ctx.sessions.list;
					return ss ? ss.getSnapshot() : null;
				} catch (e) { state.sessionListError = String((e && e.message) || e); return null; }
			};
			/**
			 * 打开一个会话（2026-10-17 真机：**点 session item 没反应**）。
			 *
			 * 病根：hero / 冷启动时客户端 roster 尚未载入该会话，直接 `openSession` 会抛
			 * `sessions.retain: unknown session`（chat 主包的同款注释已记过），而我们把它
			 * 吞进 `state.error` ⇒ 界面上**完全没反应** ✗。
			 * 修法：① 先按 workspaces 快照找到会话的归属工作区，`openWorkspace`（它会把会话
			 * 载入 roster —— 与 chat 主包 `alignWorkspace` 同一顺序 ✓）再 `openSession`；
			 * ② 任何失败都经 bridge.notify **说出来**（不许静默 ✗）。
			 */
			const notify = (kind, text) => {
				try { if (bridge && typeof bridge.notify === "function") { bridge.notify(kind, text); } } catch { /* 通知失败不影响别的 */ }
			};
			const openSession = (sid) => {
				// ★ 2026-10-18：`openSession` 是 **Promise** —— 不接住 ⇒ 失败静默（"点 session 没反应" ✓）
				const doOpen = () => {
					const fail = (e) => {
						const msg = String((e && e.message) || e);
						state.lastOpenError = msg;
						notify("warn", "打开会话失败：" + msg);
					};
					try {
						const r = ctx.uiWorkspace.openSession(sid);
						if (r && typeof r.then === "function") { r.then(undefined, fail); }
					} catch (e) { fail(e); }
				};
				try {
					const ws = typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
					const snap = ws && ws.list ? ws.list.getSnapshot() : null;
					const owner = ((snap && snap.items) || []).filter((w) => w && Array.isArray(w.sessionIds) && w.sessionIds.indexOf(sid) >= 0)[0];
					// ★ 2026-10-20：不再先 `openWorkspace(owner)` —— 官方实现会 `sessions.create({ workspaceId })`
					//   **新建一条空会话**再导航过去（见 client.js alignWorkspace 的注释）。
					//   工作区由选中会话推出，直接 openSession 即可。`owner` 只用于诊断。
					state.lastOpenOwner = owner ? owner.workspaceId : null;
					doOpen();
				} catch (e) {
					notify("warn", "打开会话失败：" + String((e && e.message) || e));
				}
			};
			// ＋ 添加工作区：官方同一条链（uiWorkspace.pickDirectory → workspaces.create）✓
			// 两个服务都不进 inject（硬依赖教训 ✓），读不到就**如实说清**、不静默。
			//
			// ★ 2026-10-26（窗口模式点了没反应）—— 原来这条链有**三处**各自能静默失败：
			//   ① `ctx.remote.directoryPicker`：官方 client-ui-workspace 的 inject 里声明了
			//      "remote" **和** "remote.directoryPicker"，我们只声明了 "remote" ⇒ 后者不是
			//      我们的服务（动态 client 门面读不到）⇒ picker 恒 undefined ⇒ 直接早退。
			//      ⇒ 改用**已声明**的 `ctx.uiWorkspace.pickDirectory()`（官方同一份能力；
			//        本仓 vssaros-workbenches 早就在用这条 ✓）。
			//   ② 返回形状：`pickDirectory()` 返回的是**路径字符串**（原生 picker 的 value 就是
			//      path），老代码读 `res.value.path` ⇒ 恒 undefined ⇒ 选完也什么都不做。
			//   ③ 失败只写 `state.addWorkspaceError`，而它**从来没被渲染** ⇒ 100% 静默；
			//      且窗口模式没有宿主桥（`window.vssarosDsh` 不存在）⇒ `bridge.notify` 也是空转。
			//      ⇒ 现在错误**就地渲染**在区里（见 Browser 的 wsError），成功也写一行。
			const addWorkspace = (setError) => {
				const say = (text, kind) => {
					state.addWorkspaceError = kind === "error" ? text : null;
					state.addWorkspaceNote = kind === "error" ? null : text;
					try { if (setError) { setError({ kind: kind === "error" ? "error" : "note", text: String(text) }); } } catch { /* 渲染失败不影响别的 */ }
					notify(kind === "error" ? "warn" : "info", text);
				};
				try {
					const uw = ctx.uiWorkspace;
					const ws = typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
					if (!uw || typeof uw.pickDirectory !== "function") {
						say("添加工作区失败：宿主没有目录选择器（uiWorkspace.pickDirectory 不可用）", "error");
						return;
					}
					if (!ws || typeof ws.create !== "function") {
						say("添加工作区失败：workspaces 服务不可用", "error");
						return;
					}
					void Promise.resolve(uw.pickDirectory()).then((picked) => {
						// 取消 = 用户主动关闭 ⇒ 不算错误，但也**要说清**（否则像"点了没反应"）。
						if (typeof picked !== "string" || !picked) {
							say("已取消选择目录（未添加工作区）", "note");
							return undefined;
						}
						return Promise.resolve(ws.create({ path: picked })).then(() => {
							say("已添加工作区：" + picked, "note");
						});
					}).catch((e) => {
						say("添加工作区失败：" + String((e && e.message) || e), "error");
					});
				} catch (e) {
					say("添加工作区失败：" + String((e && e.message) || e), "error");
				}
			};

			function useData() {
				const [wsSnap, setWsSnap] = react.useState(readWsSnapshot);
				const [, setTick] = react.useState(0);
				const [records, setRecords] = react.useState(readRecords);
				react.useEffect(() => {
					let sub = null;
					try {
						const ws = typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
						if (ws && ws.list && typeof ws.list.subscribe === "function") {
							sub = ws.list.subscribe(() => setWsSnap(readWsSnapshot()));
						}
					} catch (e) { state.workspaceError = String((e && e.message) || e); }
					return () => { try { if (typeof sub === "function") { sub(); } } catch { /* 已释放 */ } };
				}, []);
				react.useEffect(() => {
					let sub = null;
					try {
						const ss = ctx.sessions && ctx.sessions.list;
						if (ss && typeof ss.subscribe === "function") {
							sub = ss.subscribe(() => setTick((n) => n + 1));
						}
					} catch (e) { state.sessionListError = String((e && e.message) || e); }
					return () => { try { if (typeof sub === "function") { sub(); } } catch { /* 已释放 */ } };
				}, []);
				// ★ 会话 roster 的**拉取**（2026-10-17 真机）：`sessions.list` 的 `phase` 默认 `pending`
				//   （官方注释："items 为空不等于没有会话，而是**什么都没到**"），拉取由官方侧栏
				//   WorkspaceBrowser 触发 —— 而**本组件就是替换它的那个** ⇒ 必须自己触发，
				//   否则 roster 恒空：会话标题只能回落到 id、`openSession` 恒 unknown session ✗✗。
				react.useEffect(() => {
					try {
						// ⚠ 服务面方法名是 `refresh()`（不是 refreshList —— 后者只在 manager 上，
						//   2026-10-17 实测写错名字时被 typeof 判空静默跳过 ✓）。
						const svc = ctx.sessions;
						const fn = svc && (typeof svc.refresh === "function" ? svc.refresh
							: typeof svc.refreshList === "function" ? svc.refreshList : null);
						if (fn) {
							state.rosterRefreshVia = fn === svc.refresh ? "refresh" : "refreshList";
							void Promise.resolve(fn.call(svc)).catch((e) => {
								state.rosterRefreshError = String((e && e.message) || e);
							});
						}
					} catch (e) { state.rosterRefreshError = String((e && e.message) || e); }
				}, []);
				react.useEffect(() => {
					if (typeof document === "undefined") { return undefined; }
					const onPush = () => setRecords(readRecords());
					document.addEventListener(WORKSPACE_EVENT, onPush);
					return () => document.removeEventListener(WORKSPACE_EVENT, onPush);
				}, []);
				return { wsSnap, records };
			}

			// ── 样式（dsh alias token + 硬兜底 ✓）────────────────────────────────
			const S = {
				head: { display: "flex", alignItems: "center", gap: 10, height: 30, padding: "0 4px 0 8px", marginTop: 8, color: "var(--dsw-alias-label-secondary, #a3a3a3)", flex: "0 0 auto" },
				headT: { flex: "1 1 auto", fontSize: 12.5 },
				iconBtn: { background: "none", border: "none", color: "inherit", cursor: "pointer", padding: "2px 4px", borderRadius: 4, fontSize: 12, lineHeight: 1 },
				list: { flex: "1 1 auto", minHeight: 0, overflowY: "auto" },
				row: { display: "flex", alignItems: "center", gap: 7, minHeight: 28, padding: "3px 8px", borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap", color: "var(--dsw-alias-label-secondary, #a3a3a3)" },
				lbl: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
				// 时间戳降为 10px（2026-10-21 对齐 dsh-desktop：它是次要信息，别跟标题抢视线）
				meta: { fontSize: 10, color: "var(--dsw-alias-label-tertiary, #737373)", flex: "0 0 auto", opacity: .9 },
				badge: { fontSize: 10, lineHeight: "15px", padding: "0 6px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, #383838)", color: "var(--dsw-alias-label-tertiary, #737373)", flex: "0 0 auto" },
				rtag: { fontSize: 10, lineHeight: "15px", padding: "0 6px", borderRadius: 4, border: "1px solid var(--dsw-alias-border-l2, #383838)", color: "var(--dsw-alias-label-tertiary, #737373)", flex: "0 0 auto", maxWidth: 74, overflow: "hidden", textOverflow: "ellipsis" },
				card: {
					position: "fixed", zIndex: 60, width: 380, padding: "12px 12px 10px", borderRadius: 12,
					background: "var(--dsw-alias-bg-layer-2, #262626)", border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)",
					boxShadow: "0 16px 40px rgba(0,0,0,.6)", color: "var(--dsw-alias-label-primary, #e6e6e6)",
				},
				search: { width: "100%", margin: "2px 0 6px", padding: "4px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, #383838)", background: "var(--dsw-alias-bg-layer-1, #262626)", color: "inherit", fontSize: 12, outline: "none" },
			};

			/** hover 详情卡（fixed 定位到条目右侧；夹进视口——WebContentsView 外会被裁 ✗）。 */
			function HoverCard(props) {
				const rec = props.record;
				const sessionsPerRoot = rec.roots.map((rt, i) => props.sessions.filter((s) => (s.rootName || rt.name) === rt.name && (rt.isPrimary ? !s.rootName || s.rootName === rt.name : true)).length);
				return react.createElement("div", { style: Object.assign({}, S.card, { left: props.x, top: props.y }) },
					react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
						react.createElement("b", { style: { fontSize: 14 } }, rec.name),
						react.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #737373)" } }, "多根工作区 · " + rec.roots.length + " 个根"),
					),
					rec.codeWorkspacePath ? react.createElement("div", { style: { fontFamily: "Consolas, monospace", fontSize: 11, color: "var(--dsw-alias-label-tertiary, #737373)", margin: "3px 0 8px" } }, rec.codeWorkspacePath) : null,
					rec.roots.map((rt, i) => {
						const cur = rt.path && props.currentRootPath && samePath(rt.path, props.currentRootPath);
						return react.createElement("div", {
							key: rt.path, style: {
								display: "grid", gridTemplateColumns: "1fr auto", gap: "2px 8px", padding: "7px 8px", borderRadius: 8, marginTop: 2,
								background: cur ? "rgba(67,184,96,.08)" : "transparent", outline: cur ? "1px solid rgba(67,184,96,.35)" : "none",
							},
						},
							react.createElement("span", { style: { fontWeight: 600, display: "flex", alignItems: "center", gap: 6, minWidth: 0 } },
								rt.name,
								rt.isPrimary ? react.createElement("span", { style: { fontSize: 10, fontWeight: 400, color: "var(--dsw-alias-label-tertiary, #737373)", border: "1px solid var(--dsw-alias-border-l2, #383838)", borderRadius: 4, padding: "0 4px", lineHeight: "14px" } }, "主根") : null,
								cur ? react.createElement("span", { style: { fontSize: 10.5, fontWeight: 400, color: "#43b860" } }, "● 当前会话") : null,
							),
							react.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #737373)" } }, sessionsPerRoot[i] + " 个会话"),
							react.createElement("span", { style: { gridColumn: "1 / 3", fontFamily: "Consolas, monospace", fontSize: 11, color: "var(--dsw-alias-label-secondary, #a3a3a3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, rt.path),
						);
					}),
					react.createElement("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l1, #353535)", marginTop: 8, paddingTop: 8, fontSize: 11, color: "var(--dsw-alias-label-tertiary, #737373)" } },
						"新建会话默认在主根；切根用聊天输入框下方的工作区入口"),
				);
			}

			function Browser(props) {
				const wide = !props || props.wide !== false;
				const { wsSnap, records } = useData();
				const [query, setQuery] = react.useState("");
				const [searchOn, setSearchOn] = react.useState(false);
				const [collapsed, setCollapsed] = react.useState({});
				const [hover, setHover] = react.useState(null); // {key, x, y}
				// ★ 2026-10-26：＋按钮的成败**必须看得见**（窗口模式没有宿主桥 ⇒ notify 是空转）
				const [wsMsg, setWsMsg] = react.useState(null); // {kind:'error'|'note', text}
				const hoverTimer = react.useRef(null);

				const sessSnap = readSessSnapshot();
				const currentId = bridge && bridge.sessionId ? bridge.sessionId : null;
				const rows = react.useMemo(() => buildSidebar({
					workspaces: (wsSnap && wsSnap.items) || [],
					records,
					sessionsById: (sessSnap && sessSnap.byId) || {},
					archivedIds: (sessSnap && sessSnap.archivedSessionIds) || [],
					currentSessionId: currentId,
				}), [wsSnap, records, sessSnap, currentId]);

				// 当前会话 cwd 所在根的路径（详情卡绿框用）：当前会话的 dsh 条目 path。
				let currentRootPath = null;
				for (const it of (wsSnap && wsSnap.items) || []) {
					if (it && Array.isArray(it.sessionIds) && currentId && it.sessionIds.indexOf(currentId) >= 0) {
						currentRootPath = it.path || null;
						break;
					}
				}

				const q = query.trim().toLowerCase();
				const matchRow = (row) => !q
					|| (row.kind === "group" ? row.record.name : row.label).toLowerCase().indexOf(q) >= 0
					|| row.sessions.some((s) => s.title.toLowerCase().indexOf(q) >= 0);
				const shown = rows.filter(matchRow);
				const totalRows = rows.reduce((n, r2) => n + 1 + r2.sessions.length, 0);
				const withSearch = totalRows > 8;
				// ★ 被隐藏的空会话总数（所有工作区，含折叠的）—— 诚实披露，不装作没有。
				const hiddenBlanks = rows.reduce((n, r2) => n + (r2.hiddenBlanks || 0), 0);

				if (!wide) {
					// 窄轨（rail）形态：与官方一致，一枚图标，点击展开侧栏。
					return react.createElement("button", {
						style: Object.assign({}, S.iconBtn, { fontSize: 16, padding: 6 }),
						title: "Workspaces",
						onClick: () => { try { props.expandSidebar(); } catch { /* 可选 */ } },
					}, "🗀");
				}

				const openHover = (key, e) => {
					const rect = e.currentTarget.getBoundingClientRect();
					if (hoverTimer.current) { clearTimeout(hoverTimer.current); }
					hoverTimer.current = setTimeout(() => {
						const w = typeof window !== "undefined" ? window.innerWidth : 0;
						const h = typeof window !== "undefined" ? window.innerHeight : 0;
						let x = rect.right + 10;
						let y = rect.top - 6;
						if (w > 0) { x = Math.max(8, Math.min(x, w - 396)); }
						if (h > 0) { y = Math.max(8, Math.min(y, h - 320)); }
						setHover({ key, x, y });
					}, HOVER_DELAY_MS);
				};
				const closeHover = () => {
					if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = null; }
					setHover(null);
				};

				return react.createElement("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto" } },
					react.createElement("div", { style: S.head },
						// 2026-10-18：与官方中文 UI 对齐（此前写死英文 `Workspaces`，弹窗里和
				// 「新会话 / 插件 / 自动化任务」并排显得割裂 ✓）
				react.createElement("span", { style: S.headT }, "工作区"),
						withSearch ? react.createElement("button", { style: S.iconBtn, title: "搜索工作区 / 会话", "aria-label": "搜索工作区 / 会话", onClick: () => setSearchOn(!searchOn) }, "🔍") : null,
						// ★ 用 ASCII "+"：原来的全角「＋」(U+FF0B) 在某些渲染环境**没有字形**
						//   ⇒ 界面上是一个豆腐块（用户截图里那个方框就是它）⇒ 点了像"没反应" ✓
						react.createElement("button", {
							style: Object.assign({}, S.iconBtn, { fontSize: 14, fontWeight: 600, minWidth: 18, textAlign: "center" }),
							title: "添加工作区…", "aria-label": "添加工作区", onClick: () => addWorkspace(setWsMsg),
						}, "+"),
					),
					// ★ 2026-10-26：＋ 的成败**就地可见**（窗口模式没有宿主桥 ⇒ notify 是空转）
					wsMsg ? react.createElement("div", {
						style: {
							fontSize: 11, lineHeight: "1.5", padding: "2px 8px 4px", whiteSpace: "normal",
							color: wsMsg.kind === "error" ? "#f48771" : "var(--dsw-alias-label-tertiary, #737373)",
						},
					}, wsMsg.text) : null,
					// 空会话已隐藏 ⇒ 说清数量（不装作没有）
					hiddenBlanks > 0 ? react.createElement("div", {
						style: { fontSize: 10.5, padding: "0 8px 3px", color: "var(--dsw-alias-label-tertiary, #737373)" },
					}, "已隐藏 " + hiddenBlanks + " 条空会话") : null,
					searchOn && withSearch ? react.createElement("input", {
						style: S.search, placeholder: "搜索工作区 / 会话…", value: query,
						onChange: (e) => setQuery(e.target.value),
					}) : null,
					react.createElement("div", { style: S.list },
						shown.length === 0 ? react.createElement("div", { style: { padding: "10px 8px", fontSize: 12, color: "var(--dsw-alias-label-tertiary, #737373)" } }, "暂无工作区") : null,
						shown.map((row) => {
							if (row.kind === "group") {
								const key = row.record.id;
								const isOpen = collapsed[key] !== true;
								return react.createElement("div", { key },
									react.createElement("div", {
										style: Object.assign({}, S.row, { color: "var(--dsw-alias-label-primary, #e6e6e6)" }),
										onClick: () => setCollapsed(nextCollapsed(collapsed, key)),
										onMouseEnter: (e) => openHover(key, e),
										onMouseLeave: closeHover,
									},
										react.createElement("span", { style: { width: 10, fontSize: 8, color: "var(--dsw-alias-label-tertiary, #737373)", flex: "0 0 auto" } }, isOpen ? "▼" : "▶"),
										react.createElement("span", { style: Object.assign({}, S.lbl, { fontWeight: 600 }) }, row.record.name),
										react.createElement("span", { style: S.badge }, row.record.roots.length + " 个根"),
									),
									isOpen ? row.sessions.map((s) => react.createElement("div", {
										key: s.id,
										style: Object.assign({}, S.row, { paddingLeft: 30, fontSize: 12.5 }, s.isCurrent ? { background: "var(--dsw-alias-bg-selected, rgba(91,140,255,.15))", color: "var(--dsw-alias-label-primary, #e6e6e6)" } : null),
										title: s.rootName ? s.rootName + " · " + s.id : s.id,
										onClick: () => openSession(s.id),
									},
										react.createElement("span", { style: S.lbl }, s.title),
										// 稿 1：只有**非主根**的会话才带根名标签 ✓
										s.rootName && !s.isPrimaryRoot ? react.createElement("span", { style: S.rtag }, s.rootName) : null,
										react.createElement("span", { style: S.meta }, timeLabel(s.at)),
									)) : null,
								);
							}
							// 回落：未被 IDE 记录认领的 dsh 条目，平铺（与官方形态一致 ✓）
							const key = "flat:" + row.label;
							const isOpen = collapsed[key] !== true;
							return react.createElement("div", { key },
								react.createElement("div", {
									style: Object.assign({}, S.row, { color: "var(--dsw-alias-label-primary, #e6e6e6)" }),
									onClick: () => setCollapsed(nextCollapsed(collapsed, key)),
								},
									react.createElement("span", { style: { width: 10, fontSize: 8, color: "var(--dsw-alias-label-tertiary, #737373)", flex: "0 0 auto" } }, isOpen ? "▼" : "▶"),
									react.createElement("span", { style: Object.assign({}, S.lbl, { fontWeight: 600 }) }, row.label),
								),
								isOpen ? row.sessions.map((s) => react.createElement("div", {
									key: s.id,
									style: Object.assign({}, S.row, { paddingLeft: 30, fontSize: 12.5 }, s.isCurrent ? { background: "var(--dsw-alias-bg-selected, rgba(91,140,255,.15))", color: "var(--dsw-alias-label-primary, #e6e6e6)" } : null),
									title: s.id,
									onClick: () => openSession(s.id),
								},
									react.createElement("span", { style: S.lbl }, s.title),
									react.createElement("span", { style: S.meta }, timeLabel(s.at)),
								)) : null,
							);
						}),
					),
					hover && (() => {
						const row = rows.filter((r2) => r2.kind === "group" && r2.record.id === hover.key)[0];
						return row ? react.createElement(HoverCard, { record: row.record, sessions: row.sessions, currentRootPath, x: hover.x, y: hover.y }) : null;
					})(),
				);
			}

			// 遮蔽官方 WorkspaceBrowser（升序取最低 priority 渲染；同 hero.workspace 的 -10 先例 ✓）。
			try {
				ctx.slots.inject(SLOT, () => ctx.slots.register(
					{ name: SLOT, id: "vssaros-workspaces", priority: -10 }, Browser));
				state.workspacesReplaced = true;
			} catch (e) {
				state.workspacesError = String((e && e.message) || e);
			}
		}

		exports.install = install;
		// 仅测试用：分组收敛 / 路径比较 / 时间文案的纯逻辑（插件装载只读 install）。
		exports.__test = { samePath, baseName, parseRecords, timeLabel, buildSidebar, nextCollapsed };
		return module.exports;
	}
});
