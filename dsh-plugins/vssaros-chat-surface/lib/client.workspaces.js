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

		/**
		 * 选"当前会话"（高亮用）—— 纯函数（可单测 ✓）。
		 *
		 * ★ 2026-10-28（用户报障「左侧工作区中，切换会话 item，item 的高亮没有同步切换」）：
		 *   高亮原来**只看 `bridge.sessionId`** —— 那是**宿主绑给这个视图的会话**（一个窗口里
		 *   基本不变），而用户点列表里的 item 走的是官方 `uiWorkspace.openSession(sid)`
		 *   ⇒ **官方当前会话变了、宿主绑定没变** ⇒ 高亮永远钉在原来那条 ✗。
		 *   ⇒ 现在三个来源按优先级取：
		 *     ① official = 官方 selection store（`dsh.sessions.current` —— 官方自己记"当前会话"的地方）；
		 *     ② local    = 我们刚点的那条（**乐观高亮**：官方导航要几百毫秒才落地，先让用户看到反应 ✓）；
		 *     ③ bridged  = 宿主绑定的会话（兜底：官方还没初始化时用这个）。
		 *   ⚠ 只有**在册**的候选才配当"当前"：官方那条 selection 是**按 origin 持久化**的 ⇒
		 *     可能是**别的窗口**留下的会话 ⇒ 拿它高亮本窗口的列表就是假高亮 ✗ ⇒ 用 known 过滤 ✓。
		 */
		function pickCurrentSessionId(opts) {
			const o = opts || {};
			const official = o.official || null;
			const local = o.local || null;
			const bridged = o.bridged || null;
			const known = o.known || null;
			const has = (id) => {
				if (!id) { return false; }
				if (!known) { return true; }
				if (typeof known.has === "function") { return known.has(id); }
				return !!known[id];
			};
			if (has(official)) { return official; }
			if (has(local)) { return local; }
			if (has(bridged)) { return bridged; }
			// 都不在册 ⇒ 仍交出第一个有值的（上层据此"不高亮"而不是"高亮错的那条" ✓）
			return official || local || bridged || null;
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
			/**
			 * 读**官方**的"当前会话"（2026-10-28：高亮不同步的根因）。
			 *
			 * 官方 `UiWorkspaceService` 里有个持久化的 selection store（`dsh.sessions.current`），
			 * 官方自己用它记"当前打开的是哪条会话"（`replaceMain` / `openSession` 都会写它）。
			 * ⚠ 那个字段在官方源码里是**私有**的（TS private，运行期不存在）⇒ 读不到就**如实返回 null**
			 *   （上层会退回"我们刚点的那条"与宿主绑定）⇒ 官方哪天改了名，我们只是不高亮，不会崩 ✓。
			 */
			const readOfficialCurrent = () => {
				try {
					const uw = ctx.uiWorkspace;
					const sel = uw && uw.selection;
					if (sel && typeof sel.getSnapshot === "function") {
						const snap = sel.getSnapshot() || {};
						if (typeof snap.sessionId === "string" && snap.sessionId) { return snap.sessionId; }
					}
				} catch { /* 官方字段不存在/改名 ⇒ 回落 */ }
				return null;
			};
			/**
			 * 点侧栏里的会话 ⇒ 打开它。
			 *
			 * ★★ 2026-10-28（用户报「左侧工作区中，点击会话 item，没有打开对应会话」）：
			 *   原来这里**只调一次** `openSession`，失败就一句 `notify(warn)` —— 而桌面窗口
			 *   **没有宿主桥**（`bridge.notify` 空转）⇒ 用户看到的就是"点了完全没反应"✗✗。
			 *   而 `unknown session` / `is released` 是**预期内的瞬时态**（会话还没进 roster、
			 *   引用被回收），主包的 `navigate()` 对这两种错误会 retain + 轮询重试，
			 *   侧栏这条一次性路径从来不重试 ⇒ 只要第一次撞上就永久打不开。
			 *   ⇒ 现在：① 瞬时错误先 `sessions.retain` 再退避重试（最稳，与主包同口径）；
			 *            ② 每次失败**就地渲染**一行（`setMsg`，与「＋添加工作区」同一套可见性）；
			 *            ③ 成功则清掉那行，不残留噪声。
			 *
			 * @param setMsg 区内的就地提示回调（`{kind,text} | null`）；窗口模式唯一可见的反馈通道。
			 * @param setCurrent 乐观高亮回调（点哪条先亮哪条；打不开就撤回 ⇒ 不会高亮一条没打开的会话）。
			 */
			const openSession = (sid, setMsg, setCurrent) => {
				const RETRY_DELAYS = [300, 900, 2000];
				const say = (text, kind) => {
					state.openSessionError = kind === "error" ? text : null;
					try { if (typeof setMsg === "function") { setMsg(text ? { kind: kind || "note", text: text } : null); } } catch { /* 渲染失败不影响打开 */ }
				};
				// ★ 2026-10-28（高亮不同步）：**乐观高亮** —— 官方导航要几百毫秒才落地，
				//   先把点的那条点亮（用户点哪条哪条立刻有反应）⇒ 官方 selection 落地后由它接管 ✓。
				try { if (typeof setCurrent === "function") { setCurrent(sid); } } catch { /* 渲染失败不影响打开 */ }
				let attempt = 0;
				const transient = (msg) => /unknown session|is released|not found|no such/i.test(msg);
				const attemptOpen = () => {
					attempt++;
					const onRejected = (e) => {
						const msg = String((e && e.message) || e || "未知错误");
						state.lastOpenError = msg;
						state.openSessionTries = attempt;
						if (transient(msg) && attempt <= RETRY_DELAYS.length) {
							// 会话不在 roster / 引用被释放 ⇒ 先 retain 拿回引用，再退避重试（同主包口径）
							try {
								const svc = ctx.sessions;
								if (svc && typeof svc.retain === "function") { void Promise.resolve(svc.retain(sid)).catch(() => undefined); }
							} catch { /* 下一跳还会再试 */ }
							say("正在打开会话…（第 " + (attempt + 1) + " 次，会话还没就绪）", "note");
							try { window.setTimeout(attemptOpen, RETRY_DELAYS[attempt - 1]); } catch { /* 没有 setTimeout */ }
							return;
						}
						say("打开会话失败：" + msg, "error");
						notify("warn", "打开会话失败：" + msg);
						// ★ 2026-10-28：真的打不开 ⇒ 撤回乐观高亮（否则会一直亮着一条**没打开**的会话 ✗）
						try { if (typeof setCurrent === "function") { setCurrent(null); } } catch { /* 忽略 */ }
					};
					try {
						const r = ctx.uiWorkspace.openSession(sid);
						if (r && typeof r.then === "function") {
							r.then(() => { state.lastOpenError = null; say(null); }, onRejected);
						} else {
							say(null);
						}
					} catch (e) { onRejected(e); }
				};
				try {
					const ws = typeof ctx.get === "function" ? ctx.get("workspaces") : undefined;
					const snap = ws && ws.list ? ws.list.getSnapshot() : null;
					const owner = ((snap && snap.items) || []).filter((w) => w && Array.isArray(w.sessionIds) && w.sessionIds.indexOf(sid) >= 0)[0];
					// ★ 2026-10-20：不再先 `openWorkspace(owner)` —— 官方实现会 `sessions.create({ workspaceId })`
					//   **新建一条空会话**再导航过去（见 client.js alignWorkspace 的注释）。
					//   工作区由选中会话推出，直接 openSession 即可。`owner` 只用于诊断。
					state.lastOpenOwner = owner ? owner.workspaceId : null;
					attemptOpen();
				} catch (e) {
					const msg = String((e && e.message) || e);
					say("打开会话失败：" + msg, "error");
					notify("warn", "打开会话失败：" + msg);
				}
			};
			/**
			 * ＋ 菜单的两个动作共用的"说清楚"通道（**就地渲染**，不只靠 notify）。
			 *
			 * ★ 窗口模式（desktop）里**没有宿主桥** ⇒ `bridge.notify` 是空转 ⇒ 失败若只写
			 *   `state.*` 就是 100% 静默（用户看到的就是"点了没反应"）✗ ⇒ 必须在区里渲染一行 ✓。
			 */
			const makeSayer = (setMsg) => (text, kind) => {
				const isErr = kind === "error";
				state.addWorkspaceError = isErr ? text : null;
				state.addWorkspaceNote = isErr ? null : text;
				try { if (setMsg) { setMsg({ kind: isErr ? "error" : "note", text: String(text) }); } } catch { /* 渲染失败不影响别的 */ }
				notify(isErr ? "warn" : "info", text);
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
			//      ⇒ 现在错误**就地渲染**在区里（见 Browser 的 wsMsg），成功也写一行。
			const addWorkspace = (setMsg) => {
				const say = makeSayer(setMsg);
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

			/**
			 * 从 `.code-workspace` 文件**导入多根工作区**（2026-10-26，用户要求）。
			 *
			 * 为什么必须请 IDE 侧做：页面是浏览器上下文 ⇒ ① 读不了文件；② 没有**文件**选择器
			 *   （dsh 只有目录选择器）⇒ 选文件、解析 `folders[]`、落一条多根记录、把各根注册进 dsh，
			 *   全都要 IDE 侧的能力 ⇒ 走页面桥的 `importCodeWorkspace`（宿主转成 IDE 命令
			 *   `agentStudio.workspace.importCodeWorkspace`）。
			 *
			 * ⚠ 页面桥是**单向**的（只回 true）⇒ 这里拿不到"导入成功/失败" ⇒
			 *   ① 成功时只说"已请求导入，导入完成后会出现在下面"（真正成功由 IDE 通知 + 列表刷新体现）；
			 *   ② **没有桥**（官方 dsh desktop）⇒ 明确说清，不静默 ✗。
			 */
			const importCodeWorkspace = (setMsg) => {
				const say = makeSayer(setMsg);
				if (!bridge || typeof bridge.importCodeWorkspace !== "function") {
					say("当前环境不支持导入（这一版没有宿主桥，无法选 .code-workspace 文件）", "error");
					return;
				}
				try {
					void Promise.resolve(bridge.importCodeWorkspace()).then(() => {
						say("已请 IDE 侧选一个 .code-workspace 文件；导入完成后它会作为一个「N 个根」的工作区出现在下面", "note");
					}).catch((e) => {
						say("导入请求失败：" + String((e && e.message) || e), "error");
					});
				} catch (e) {
					say("导入请求失败：" + String((e && e.message) || e), "error");
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
				// ＋ 菜单里的条目（两个动作：加单目录 / 导入多根）
				menuItem: {
					display: "block", width: "100%", textAlign: "left", background: "none", border: "none",
					color: "inherit", cursor: "pointer", fontSize: 12, lineHeight: "1.4",
					padding: "6px 8px", borderRadius: 6,
				},
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
				// ＋ 菜单（两个动作：加单目录 / 从 .code-workspace 导入多根）；null = 关闭
				const [menu, setMenu] = react.useState(null); // {x, y}
				// ★ 2026-10-28（高亮不同步）：`localCurrent` = 我们刚点的会话（乐观高亮）；
				//   `officialTick` = 官方 selection 变化的计数（**读到新值也得重渲染**，否则高亮不动 ✗）。
				const [localCurrent, setLocalCurrent] = react.useState(null);
				const [officialTick, setOfficialTick] = react.useState(0);
				const hoverTimer = react.useRef(null);
				// 点外面 ⇒ 关菜单（与官方菜单同口径；不关就会"菜单糊在侧栏上"✗）
				react.useEffect(() => {
					if (!menu) { return undefined; }
					const onDown = (ev) => {
						try {
							const t = ev.target;
							if (t && t.closest && t.closest("[data-vssaros-ws-menu]")) { return; }
							setMenu(null);
						} catch { setMenu(null); }
					};
					const onKey = (ev) => { if (ev.key === "Escape") { setMenu(null); } };
					document.addEventListener("mousedown", onDown, true);
					document.addEventListener("keydown", onKey, true);
					return () => {
						document.removeEventListener("mousedown", onDown, true);
						document.removeEventListener("keydown", onKey, true);
					};
				}, [menu]);
				// ★ 2026-10-28：订阅官方 selection（当前会话）—— 官方导航一变就重渲染 ⇒ 高亮跟着动 ✓。
				//   官方那个字段是私有的 ⇒ 读不到就退化成"乐观高亮 + 宿主绑定"（不会崩 ✓）。
				react.useEffect(() => {
					let sub = null;
					try {
						const sel = ctx.uiWorkspace && ctx.uiWorkspace.selection;
						if (sel && typeof sel.subscribe === "function") {
							sub = sel.subscribe(() => setOfficialTick((n) => n + 1));
						}
					} catch { /* 官方字段改名了 ⇒ 靠乐观高亮顶着 */ }
					return () => { try { if (typeof sub === "function") { sub(); } } catch { /* 已释放 */ } };
				}, []);

				const sessSnap = readSessSnapshot();
				// ★ 2026-10-28（高亮不同步）：当前会话有三个来源，优先级见 pickCurrentSessionId 的注释。
				//   ① official = 官方 selection（官方自己记的"当前会话"）—— 用户点 item 后它会变 ✓
				//   ② local    = 我们刚点的那条（乐观高亮：官方导航落地前就先动 ✓）
				//   ③ bridged  = 宿主绑定的会话（兜底）
				const bridgedCurrent = bridge && bridge.sessionId ? bridge.sessionId : null;
				const knownIds = {};
				for (const it of (wsSnap && wsSnap.items) || []) {
					if (it && Array.isArray(it.sessionIds)) {
						for (const sid of it.sessionIds) { knownIds[sid] = true; }
					}
				}
				for (const sid of Object.keys((sessSnap && sessSnap.byId) || {})) { knownIds[sid] = true; }
				const currentId = pickCurrentSessionId({
					official: readOfficialCurrent(),
					local: localCurrent,
					bridged: bridgedCurrent,
					known: knownIds,
				});
				const rows = react.useMemo(() => buildSidebar({
					workspaces: (wsSnap && wsSnap.items) || [],
					records,
					sessionsById: (sessSnap && sessSnap.byId) || {},
					archivedIds: (sessSnap && sessSnap.archivedSessionIds) || [],
					currentSessionId: currentId,
				}), [wsSnap, records, sessSnap, currentId, officialTick]);

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
						// ★ 2026-10-26：它现在是一个**菜单**（两个动作：加单目录 / 从 .code-workspace 导入多根）。
						react.createElement("button", {
							style: Object.assign({}, S.iconBtn, { fontSize: 14, fontWeight: 600, minWidth: 18, textAlign: "center" }),
							title: "添加工作区…", "aria-label": "添加工作区", "aria-haspopup": "true",
							onClick: (e) => {
								try {
									const rect = e.currentTarget.getBoundingClientRect();
									// fixed 定位（不用 absolute）：侧栏列可能有 overflow ⇒ 绝对定位会被裁掉 ✗
									const w = typeof window !== "undefined" ? window.innerWidth : 0;
									const h = typeof window !== "undefined" ? window.innerHeight : 0;
									let x = rect.left - 180;
									let y = rect.bottom + 4;
									if (w > 0) { x = Math.max(8, Math.min(x, w - 220)); }
									if (h > 0) { y = Math.max(8, Math.min(y, h - 90)); }
									setMenu({ x, y });
								} catch { setMenu(null); }
							},
						}, "+"),
					),
					// ＋ 菜单本体（fixed 定位 ⇒ 不被侧栏的 overflow 裁掉 ✓）
					menu ? react.createElement("div", {
						"data-vssaros-ws-menu": "1",
						style: {
							position: "fixed", left: menu.x, top: menu.y, zIndex: 70, minWidth: 210, padding: "4px",
							borderRadius: 8, background: "var(--dsw-alias-bg-layer-2, #262626)",
							border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)",
							boxShadow: "0 12px 32px rgba(0,0,0,.5)", color: "var(--dsw-alias-label-primary, #e6e6e6)",
						},
					},
						react.createElement("button", {
							style: S.menuItem,
							onClick: () => { setMenu(null); addWorkspace(setWsMsg); },
						}, "添加工作区（单个目录）"),
						react.createElement("button", {
							style: S.menuItem,
							title: bridge && typeof bridge.importCodeWorkspace === "function" ? "" : "当前环境没有宿主桥，无法选 .code-workspace 文件",
							onClick: () => { setMenu(null); importCodeWorkspace(setWsMsg); },
						}, "从 .code-workspace 导入（多根）"),
					) : null,
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
										style: Object.assign({}, S.row, { paddingLeft: 30, fontSize: 12.5 }, s.isCurrent ? { background: "var(--dsw-alias-interactive-bg-active, rgba(91,140,255,.15))", color: "var(--dsw-alias-label-primary, #e6e6e6)" } : null),
										title: s.rootName ? s.rootName + " · " + s.id : s.id,
										onClick: () => openSession(s.id, setWsMsg, setLocalCurrent),
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
									style: Object.assign({}, S.row, { paddingLeft: 30, fontSize: 12.5 }, s.isCurrent ? { background: "var(--dsw-alias-interactive-bg-active, rgba(91,140,255,.15))", color: "var(--dsw-alias-label-primary, #e6e6e6)" } : null),
									title: s.id,
									onClick: () => openSession(s.id, setWsMsg, setLocalCurrent),
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
		exports.__test = { samePath, baseName, parseRecords, timeLabel, buildSidebar, nextCollapsed, pickCurrentSessionId };
		return module.exports;
	}
});
