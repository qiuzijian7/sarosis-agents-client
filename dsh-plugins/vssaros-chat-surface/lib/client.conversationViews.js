// @vssaros/dsh-chat-surface — 会话区视图页签「记忆 / 技能 / 待办 / 记忆设置」
// （2026-11-02 用户要求；参照 dsh-memory-evolve 的 conversation.view 页签布局）
//
// ── 槽与顺序 ────────────────────────────────────────────────────────────────
// `conversation.view` 是 **list 槽**（声明在 `conversation.session` 的 children，
// `dsh-client-ui-conversation/lib/client.js:19796-19801`），官方占用两条：
//   · `chat`       order **0**（`dsh-client-ui-chat/lib/client.js:13222-13233`）
//   · `trajectory` order **10**（`dsh-client-ui-trajectory/lib/client.js:8205-8238`）
// ⇒ 我们取 20/30/40/50，稳定落在「轨迹」右侧，且与官方零 tie。
// ⚠ 官方只在「开发者工具」开启时才渲染 `trajectory`（conversation:19560）；关掉时
//   我们的 4 个页签直接接在「对话」后面 —— 这是官方开关的语义，我们不干预。
//
// ── 这一批的口径（2026-11-02 用户拍板「A：骨架 + 记忆页签可用」）──────────────
//   · 4 个页签全部注册出来（机制先跑通、可见）；
//   · 记忆：顶部「工作区 | Bot」分段（2026-11-02 第二批：记忆 = Bot × 工作区 两层）——
//       工作区 = 会话 cwd 所在 git 根的记忆（`/x/agents/api/workspace-memory`），默认选中，
//               普通会话也有；可首次建立、可整篇编辑；多根工作区可切根；
//       Bot    = 只在 Bot 会话可选，真实数据只读浏览 + 「打开完整页」；
//   · 技能：列表 + 搜索 + 原始启用徽标（数据源 `/x/skills/api/skills`）；
//   · 待办：官方 `todos` 投影的完整清单（与 dock 那枚同一份数据，只读）；
//   · 记忆设置：同样分段；工作区写 scope.json，Bot 走 `/x/agents/api/memory` 的 set-limits；
//     记忆设置：同样分段；工作区写 scope.json，Bot 走 `/x/agents/api/memory` 的 set-limits；
//     回合末自动提交（P2 起可写，全局偏好 /x/agents/api/memory-prefs）；AgentMemory 待审数只读。
//
// ── 渲染写法（别改成"逗号前置"的长参数列表）────────────────────────────────
// 本文件统一用 **children 数组**（`kids.push(...)` + `createElement(type, props, kids)`）：
// 之前那版用 `, cond ? a : b` 串在参数列表里，一处多写 `))` 就整包语法错误，
// 而守卫只报"编译失败"、看不出是哪个页签（2026-11-02 踩过一次）。
//
// ── 为什么都走同源 fetch，不 require 别的 chunk ────────────────────────────
// 插件只允许 `require("react")`（dsh-client-modules 的 purity gate）；跨 chunk 只能
// 走 window/事件（见 client.botSettingsBtn.js 的契约），而这里的数据源全是同源 HTTP，
// 直接 fetch 最省事、也不会与 vssaros-agents / vssaros-skills 的页面抢状态 ✓。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.conversationViews.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const SLOT = "conversation.view";
		/** preset 前缀与 4 个**模式** preset（与 client.capsule.js / client.agents.js 同口径，别各写一套）。 */
		const VSSAROS_PREFIX = "vssaros-";
		/* vssaros:bot-identity v1 —— 逐字副本，真源 vssaros-agents/lib/core/botIdentity.js（守卫 dsh-plugins/check-bot-identity.mjs） */
		const BOT_MODE_PRESET_IDS = ["standard", "ptc", "minimal", "cordis", "vssaros-standard", "vssaros-ptc", "vssaros-full", "vssaros-minimal", "vssaros-cordis"];
		/** 是不是"可能属于某个 bot"的 preset（vssaros- 前缀且不是模式 preset）。 */
		function isBotPresetId(presetId) {
			const id = String(presetId || "").trim();
			return id.indexOf("vssaros-") === 0 && id.length > 8 && BOT_MODE_PRESET_IDS.indexOf(id) < 0;
		}
		/** 会话属于哪个 bot：身份记录（presetId 与当前一致才采信）> 按 preset 推断（botId=null，调用方用花名册反查）。 */
		function sessionBotOf(projectionValues) {
			const pv = projectionValues || {};
			const presetId = String(pv.agentPreset || "").trim();
			if (!isBotPresetId(presetId)) { return { isBot: false, botId: null, presetId: presetId, source: "none" }; }
			const rec = pv["vssaros-bot"];
			const recBot = rec && typeof rec.botId === "string" ? rec.botId.trim() : "";
			if (recBot && String(rec.presetId || "").trim() === presetId) {
				return { isBot: true, botId: recBot, presetId: presetId, source: "record" };
			}
			return { isBot: true, botId: null, presetId: presetId, source: "preset" };
		}
		/* /vssaros:bot-identity */
		/** 官方占位（守卫会与 check-chat-surface-chunks.mjs 的 OFFICIAL_ENTRIES 对账）。 */
		const OFFICIAL = { chat: 0, trajectory: 10 };
		// ★ 2026-11-03（用户要求）：bot 配置统一进「设置」页签，放**整排最右端**（官方 chat 0 / trajectory 10
		//   ⇒ 60 在 记忆20/技能30/待办40 之后）；原「记忆设置」(50) 已并入这个页签，不再单独存在。
		const ORDERS = { memory: 20, skills: 30, todo: 40, settings: 60 };
		const IDS = {
			memory: "vssaros-memory",
			skills: "vssaros-skills",
			todo: "vssaros-todo",
			// 沿用旧右栏页签的 id：一个会话里只会有一个「Bot 设置」入口，不存在与右侧栏并存的情况
			settings: "vssaros-bot-settings",
		};
		/** 技能一次最多渲染多少条（技能库可能几百条；不做虚拟滚动就得有上限，且**要说出来**）。 */
		const SKILL_RENDER_LIMIT = 200;

		// ── 样式：全部走 dsh 设计 token（深浅色自动适配），写法同 client.todos.js ──
		const C = {
			root: {
				display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0,
				overflow: "auto", padding: "10px 14px 16px", boxSizing: "border-box", gap: 10,
				fontSize: 12.5, lineHeight: "19px",
				color: "var(--dsw-alias-label-primary, currentColor)",
			},
			row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
			col: { display: "flex", flexDirection: "column", gap: 6 },
			grow: { flex: "1 1 auto" },
			card: {
				border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.24))",
				borderRadius: 8, padding: "9px 12px",
				background: "var(--dsw-alias-bg-layer-1, transparent)",
			},
			sub: { color: "var(--dsw-alias-label-secondary, rgba(128,128,128,.9))", fontSize: 11.5 },
			tiny: { color: "var(--dsw-alias-label-tertiary, rgba(128,128,128,.8))", fontSize: 11 },
			title: { fontWeight: 600, fontSize: 13 },
			badge: {
				display: "inline-flex", alignItems: "center", padding: "0 7px", borderRadius: 999,
				fontSize: 10.5, lineHeight: "17px",
				border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.24))",
				color: "var(--dsw-alias-label-secondary, currentColor)",
			},
			badgeOn: {
				display: "inline-flex", alignItems: "center", padding: "0 7px", borderRadius: 999,
				fontSize: 10.5, lineHeight: "17px",
				border: "1px solid var(--dsw-alias-brand-primary, #3794ff)",
				color: "var(--dsw-alias-brand-primary, #3794ff)",
			},
			btn: {
				appearance: "none", cursor: "pointer", padding: "2px 10px", borderRadius: 6,
				border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))",
				background: "var(--dsw-alias-bg-layer-2, transparent)",
				color: "var(--dsw-alias-label-primary, currentColor)", fontSize: 11.5, lineHeight: "19px",
			},
			btnPrimary: {
				appearance: "none", cursor: "pointer", padding: "2px 12px", borderRadius: 6,
				border: "1px solid var(--dsw-alias-brand-primary, #3794ff)",
				background: "var(--dsw-alias-brand-primary, #3794ff)",
				color: "#fff", fontSize: 11.5, lineHeight: "19px", fontWeight: 600,
			},
			bar: {
				height: 4, borderRadius: 2, overflow: "hidden", flex: "0 0 auto",
				background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.24))",
			},
			barFill: { display: "block", height: "100%", background: "var(--dsw-alias-brand-primary, #10b981)" },
			item: {
				padding: "5px 8px", borderRadius: 6,
				border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))",
			},
			input: {
				padding: "2px 8px", borderRadius: 6, fontSize: 11.5, lineHeight: "19px",
				border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))",
				background: "var(--dsw-alias-bg-layer-2, transparent)",
				color: "var(--dsw-alias-label-primary, currentColor)",
			},
			err: { color: "var(--dsw-alias-state-error-primary, #e5534b)", fontSize: 11.5 },
			list: { display: "flex", flexDirection: "column", gap: 6, margin: 0, padding: 0, listStyle: "none" },
		};

		/** 跑的是不是**我们的 agent**（与 client.capsule.js / client.botSettingsBtn.js 同判据）。 */
		function isAgentPreset(presetId) {
			return isBotPresetId(presetId);
		}

		/** 会话 → agentId（`vssaros-<id>` 的 preset）；取不到返回空串（调用方必须显式处理）。 */
		function agentIdOf(ctx, sessionId) {
			try {
				const list = ctx && ctx.sessions && ctx.sessions.list;
				const snap = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : null;
				const summary = sessionId && snap && snap.byId ? snap.byId[sessionId] : undefined;
				// 身份记录优先（权威 botId）；老会话没记录 ⇒ 退回去前缀
				const bot = sessionBotOf(summary && summary.projectionValues);
				return bot.isBot ? (bot.botId || bot.presetId.slice(VSSAROS_PREFIX.length)) : "";
			} catch {
				return "";
			}
		}

		/** 订阅会话列表（agent 变化 / 重绑都要重算 agentId）。 */
		function useSessionsTick(ctx) {
			const [, force] = react.useState(0);
			react.useEffect(() => {
				let off;
				try {
					const list = ctx && ctx.sessions && ctx.sessions.list;
					if (list && typeof list.subscribe === "function") {
						off = list.subscribe(() => force((n) => n + 1));
					}
				} catch {
					off = undefined;
				}
				return () => {
					try { if (typeof off === "function") { off(); } } catch { /* 退订失败无妨 */ }
				};
			}, [ctx]);
		}

		function getJson(url) {
			return fetch(url, { credentials: "same-origin", headers: { accept: "application/json" } })
				.then((res) => res.json().catch(() => null).then((body) => {
					if (!res.ok) {
						throw new Error(body && body.error ? String(body.error) : "HTTP " + res.status);
					}
					if (!body) { throw new Error("响应不是 JSON"); }
					return body;
				}));
		}

		function postJson(url, body) {
			return fetch(url, {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify(body || {}),
			}).then((res) => res.json().catch(() => null).then((data) => {
				if (!res.ok) {
					throw new Error(data && data.error ? String(data.error) : "HTTP " + res.status);
				}
				if (!data) { throw new Error("响应不是 JSON"); }
				return data;
			}));
		}

		/**
		 * 打开一个 dsh 页面：优先宿主桥（IDE 内开页），否则新标签（dsh desktop / 纯浏览器）。
		 * 两路都失败要**明确说出来**（"点了没反应"是本仓查过多次的坑 ✗）。
		 */
		function openPage(bridge, path, say) {
			try {
				if (bridge && typeof bridge.openModulePage === "function") {
					Promise.resolve(bridge.openModulePage(path)).catch((e) => say("打开页面失败：" + String((e && e.message) || e)));
					return;
				}
			} catch (e) {
				say("打开页面失败：" + String((e && e.message) || e));
				return;
			}
			try {
				const w = window.open(path, "_blank", "noopener");
				if (!w) { say("浏览器拦截了新标签页，请手动打开：" + path); }
			} catch (e) {
				say("打开页面失败：" + String((e && e.message) || e));
			}
		}

		/**
		 * 把 MEMORY.md 切成可渲染的行（标题 / 列表项 / 普通段落）。
		 * 跳过 HTML 注释块（模板里那段说明是给 agent 看的，展示时是噪音）。
		 */
		function parseMemory(text) {
			const out = [];
			let inComment = false;
			for (const raw of String(text == null ? "" : text).split("\n")) {
				let line = raw;
				if (inComment) {
					const end = line.indexOf("-->");
					if (end < 0) { continue; }
					inComment = false;
					line = line.slice(end + 3);
				}
				const start = line.indexOf("<!--");
				if (start >= 0) {
					const end = line.indexOf("-->", start + 4);
					if (end < 0) { inComment = true; line = line.slice(0, start); }
					else { line = line.slice(0, start) + line.slice(end + 3); }
				}
				const trimmed = line.replace(/\s+$/, "");
				if (!trimmed.trim()) { continue; }
				if (/^\s{0,3}#{1,6}\s/.test(trimmed)) {
					out.push({ kind: "head", text: trimmed.replace(/^\s{0,3}#{1,6}\s*/, "") });
					continue;
				}
				if (/^\s*[-*+]\s+/.test(trimmed)) {
					out.push({ kind: "item", text: trimmed.replace(/^\s*[-*+]\s+/, "") });
					continue;
				}
				out.push({ kind: "text", text: trimmed.trim() });
			}
			return out;
		}

		/** 字节数 → 人类可读（只用于"文件多大"，不参与任何判定）。 */
		function sizeLabel(bytes) {
			const n = Number(bytes);
			if (!Number.isFinite(n) || n <= 0) { return "0 B"; }
			if (n < 1024) { return n + " B"; }
			if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + " KB"; }
			return (n / 1024 / 1024).toFixed(1) + " MB";
		}

		/**
		 * 数据加载三态（loading / error / data）+ 手动 reload。
		 * ⚠ 错误**必须**由调用方渲染出来（静默失败是本仓反复踩的坑）。
		 */
		function useLoader(load, deps) {
			const [state, setState] = react.useState({ loading: true, error: "", data: null });
			const [tick, setTick] = react.useState(0);
			const key = JSON.stringify(deps || []);
			react.useEffect(() => {
				let alive = true;
				setState((prev) => ({ loading: true, error: "", data: prev.data }));
				Promise.resolve()
					.then(() => load())
					.then((data) => { if (alive) { setState({ loading: false, error: "", data }); } })
					.catch((e) => { if (alive) { setState({ loading: false, error: String((e && e.message) || e), data: null }); } });
				return () => { alive = false; };
			}, [key, tick]);
			return [state, () => setTick((n) => n + 1)];
		}

		/** 小工具：带 key 的元素数组（children 数组直接交给 createElement，React 认 key）。 */
		function kids(list) {
			return list.filter((x) => x !== null && x !== undefined && x !== false);
		}

		// ── 工作区（会话 cwd）────────────────────────────────────────────────────
		// 「当前工作区 / 当前根」只认 `sessions.byId[sid].cwd`（宿主持有的硬事实）：
		// 工作区快照里的 sessionIds 会与 cwd 分叉（2026-10-28 事故，见 client.workspaces.js 的 rootOfSession）。

		/** 会话 → cwd；取不到返回空串。 */
		function cwdOf(ctx, sessionId) {
			try {
				const list = ctx && ctx.sessions && ctx.sessions.list;
				const snap = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : null;
				const summary = sessionId && snap && snap.byId ? snap.byId[sessionId] : undefined;
				return summary && typeof summary.cwd === "string" ? summary.cwd : "";
			} catch {
				return "";
			}
		}

		function normPath(p) {
			return String(p || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
		}
		function baseName(p) {
			const s = String(p || "").replace(/[\\/]+$/, "");
			const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
			return i >= 0 ? s.slice(i + 1) : s;
		}
		/** a 是否等于 b 或在 b 之下（Windows 口径：大小写不敏感、分隔符统一）。 */
		function isUnder(a, b) {
			const x = normPath(a);
			const y = normPath(b);
			return !!x && !!y && (x === y || x.startsWith(y + "\\"));
		}

		/**
		 * 会话所在工作区的根列表（多根工作区 ⇒ 每个根一份记忆，页签里可切换）。
		 * 数据源 = 宿主写在 `<html data-vssaros-workspaces>` 的工作区记录（与 client.workspaces.js 同一份）；
		 * 读不到（dsh 纯浏览器 / 桌面窗口没有那份记录）⇒ 只有会话 cwd 这一个选项。
		 * 每个选项的 `cwd` 是交给 Host 解析身份的路径：会话所在的根传**会话 cwd**（子目录会话也落到同一个
		 * git 根），其它根传根路径本身。
		 * @returns {{ name: string, cwd: string, current: boolean }[]}
		 */
		function rootOptionsFor(cwd) {
			if (!cwd) { return []; }
			const own = { name: baseName(cwd) || cwd, cwd, current: true };
			let records = [];
			try {
				const raw = typeof document !== "undefined" && document.documentElement
					? document.documentElement.dataset.vssarosWorkspaces : "";
				const parsed = raw ? JSON.parse(raw) : [];
				records = Array.isArray(parsed) ? parsed : [];
			} catch {
				records = [];
			}
			for (const rec of records) {
				const roots = rec && Array.isArray(rec.roots)
					? rec.roots.filter((r) => r && typeof r.path === "string" && r.path) : [];
				const mine = roots.find((r) => isUnder(cwd, r.path));
				if (!mine || roots.length < 2) { continue; }
				return roots.map((r) => {
					const isMine = r === mine;
					const name = (typeof r.name === "string" && r.name.trim()) ? r.name.trim() : baseName(r.path);
					return { name, cwd: isMine ? cwd : r.path, current: isMine };
				});
			}
			return [own];
		}

		/** 分段切换（工作区 / Bot）。disabled 的那一段要说明为什么不可选。 */
		function Segment(props) {
			return react.createElement("div", { style: Object.assign({}, C.row, { gap: 4 }) },
				props.options.map((o) => react.createElement("button", {
					key: o.value,
					type: "button",
					disabled: !!o.disabled,
					title: o.title || "",
					style: Object.assign({}, props.value === o.value ? C.btnPrimary : C.btn, o.disabled ? { opacity: 0.45, cursor: "not-allowed" } : {}),
					onClick: () => { if (!o.disabled) { props.onChange(o.value); } },
				}, o.label)));
		}

		/** 宿主插件太旧时，接口 404 —— 说清楚原因与解法，别只甩一个 HTTP 码。 */
		function explainLoadError(message) {
			const m = String(message || "");
			if (/404|unknown route/i.test(m)) {
				return m + "（需要 @vssaros/dsh-agents ≥ 0.2.310；装好后重启 app 才生效）";
			}
			return m;
		}

		const WS_API = "/x/agents/api/workspace-memory";
		const PREFS_API = "/x/agents/api/memory-prefs";

		const MEM_API = "/x/agents/api/memory";

		/**
		 * 记忆历史（★ 2026-11-03 P3：不用再跳「完整页」）。
		 * 数据源 = 与演化页同一个 `/x/agents/api/memory?agent=ws.<key>`（log / rev / against / restore），
		 * 所以这里只是另一个视图，不是另一套实现。默认折叠，展开才发请求（读口一次要起几条 git 子进程）。
		 *
		 * 回滚语义（Host 侧 `restoreMemoryFile`，只追加不改写历史）：先把未提交改动落成一条提交，
		 * 再写回旧内容并再提交一条 ⇒ 任何一步都能再回去。仍然加一道二次确认，并如实写出会恢复/移除多少行。
		 */
		function MemoryHistoryPanel(props) {
			const say = props.say;
			const scopeId = props.scopeId;
			const [open, setOpen] = react.useState(false);
			const [sel, setSel] = react.useState("");
			const [confirming, setConfirming] = react.useState(false);
			const [busy, setBusy] = react.useState(false);
			const [err, setErr] = react.useState("");
			const listUrl = open && scopeId ? MEM_API + "?agent=" + encodeURIComponent(scopeId) + "&limit=15&nonce=" + String(props.version || 0) : "";
			const [list, reloadList] = useLoader(() => (listUrl ? getJson(listUrl) : Promise.resolve(null)), [listUrl]);
			const revUrl = open && sel
				? MEM_API + "?agent=" + encodeURIComponent(scopeId) + "&rev=" + encodeURIComponent(sel) + "&against=working&file=MEMORY.md"
				: "";
			const [rev] = useLoader(() => (revUrl ? getJson(revUrl) : Promise.resolve(null)), [revUrl]);
			react.useEffect(() => { setSel(""); setConfirming(false); setErr(""); }, [scopeId]);

			const toggle = react.createElement("button", {
				key: "tg", type: "button", style: C.btn, onClick: () => setOpen(!open),
				title: "记忆目录自己的提交历史：看某一版、回滚到某一版",
			}, open ? "收起历史" : "展开历史");
			if (!open) {
				return react.createElement("div", { style: C.row }, kids([toggle]));
			}

			const commits = list.data && Array.isArray(list.data.log) ? list.data.log : [];
			const diff = rev.data && rev.data.diff ? rev.data.diff : null;
			const restore = () => {
				setBusy(true);
				setErr("");
				postJson(MEM_API, { agent: scopeId, action: "restore", rev: sel, file: "MEMORY.md" })
					.then(() => {
						if (say) { say("已回滚到 " + sel + "（回滚前的内容已另存为一条提交，可再回到）"); }
						setConfirming(false);
						setSel("");
						reloadList();
						if (props.onChanged) { props.onChanged(); }
					})
					.catch((e) => setErr("回滚失败：" + explainLoadError(String((e && e.message) || e))))
					.then(() => setBusy(false));
			};

			let detail = null;
			if (sel) {
				if (rev.error) {
					detail = react.createElement("div", { key: "d", style: C.err }, "读取这一版失败：" + explainLoadError(rev.error));
				} else if (!rev.data) {
					detail = react.createElement("div", { key: "d", style: C.tiny }, "正在读取这一版…");
				} else {
					const restoreN = diff ? (Number(diff.removed) || 0) : 0;  // del：历史版有、当前没有 ⇒ 回滚会恢复
					const dropN = diff ? (Number(diff.added) || 0) : 0;       // add：当前有、历史版没有 ⇒ 回滚会移除
					const changed = diff ? (diff.rows || []).filter((r) => r.type !== "same").slice(0, 60) : [];
					detail = react.createElement("div", { key: "d", style: C.card }, kids([
						react.createElement("div", { key: "t", style: C.row }, kids([
							react.createElement("span", { key: "n", style: C.title }, "版本 " + sel),
							react.createElement("span", { key: "c", style: C.badge }, "回滚会恢复 " + restoreN + " 行 · 移除 " + dropN + " 行"),
							react.createElement("span", { key: "sp", style: C.grow }),
							confirming
								? kids([
									react.createElement("button", { key: "x", type: "button", style: C.btn, disabled: busy, onClick: () => setConfirming(false) }, "取消"),
									react.createElement("button", { key: "o", type: "button", style: C.btnPrimary, disabled: busy, onClick: restore }, busy ? "回滚中…" : "确认回滚"),
								])
								: react.createElement("button", {
									key: "r", type: "button", style: C.btn, disabled: busy || (restoreN === 0 && dropN === 0),
									title: restoreN === 0 && dropN === 0 ? "这一版与当前内容相同，无需回滚" : "",
									onClick: () => setConfirming(true),
								}, "回滚到这一版"),
						])),
						confirming
							? react.createElement("div", { key: "w", style: Object.assign({}, C.tiny, { marginTop: 4 }) },
								"确认后：当前未提交的改动会先存成一条提交，再把 MEMORY.md 写回这一版并再提交一条——历史只追加，之后还能回到现在这个状态。")
							: null,
						changed.length === 0
							? react.createElement("div", { key: "same", style: Object.assign({}, C.sub, { marginTop: 4 }) }, "这一版与当前内容完全相同。")
							: react.createElement("div", { key: "rows", style: Object.assign({}, C.list, { marginTop: 6 }) },
								changed.map((r, i) => react.createElement("div", {
									key: "r" + i,
									style: Object.assign({}, C.item, {
										fontFamily: "var(--dsw-alias-font-mono, ui-monospace, Consolas, monospace)",
										color: r.type === "del" ? "var(--dsw-alias-label-success, #3fb950)" : "var(--dsw-alias-label-danger, #f85149)",
									}),
								// 条目自带 Markdown 列表符（"- [日期] …"）⇒ 去掉，否则显示成 "+ - …" / "- - …" 很难读
								}, (r.type === "del" ? "+ " : "- ") + String(r.text).replace(/^\s*[-*+]\s+/, "")))),
						diff && (diff.rows || []).filter((r) => r.type !== "same").length > 60
							? react.createElement("div", { key: "more", style: C.tiny }, "只显示前 60 处差异；完整对比在「完整页」。")
							: null,
						react.createElement("div", { key: "legend", style: Object.assign({}, C.tiny, { marginTop: 4 }) },
							"+ 绿色：这一版有、当前没有（回滚会恢复） · - 红色：当前有、这一版没有（回滚会移除）"),
					]));
				}
			}

			return react.createElement("div", { style: C.col }, kids([
				react.createElement("div", { key: "h", style: C.row }, kids([
					react.createElement("span", { key: "t", style: C.title }, "历史"),
					react.createElement("span", { key: "sp", style: C.grow }),
					react.createElement("button", { key: "rf", type: "button", style: C.btn, onClick: reloadList }, "刷新"),
					toggle,
				])),
				list.error
					? react.createElement("div", { key: "e", style: C.err }, "读取历史失败：" + explainLoadError(list.error))
					: !list.data
						? react.createElement("div", { key: "l", style: C.tiny }, "正在读取历史…")
						: commits.length === 0
							? react.createElement("div", { key: "z", style: C.sub }, "还没有提交。")
							: react.createElement("div", { key: "list", style: C.list },
								commits.map((c) => react.createElement("div", {
									key: c.hash,
									style: Object.assign({}, C.item, {
										display: "flex", gap: 8, alignItems: "center", cursor: "pointer",
										outline: sel === c.hash ? "1px solid var(--dsw-alias-border-focus, #6e7681)" : "none",
									}),
									onClick: () => { setSel(sel === c.hash ? "" : c.hash); setConfirming(false); setErr(""); },
								}, kids([
									react.createElement("span", { key: "h", style: C.badge }, String(c.hash)),
									react.createElement("span", { key: "s", style: C.grow }, String(c.subject || "")),
									react.createElement("span", { key: "d", style: C.tiny }, String(c.date || "")),
								])))),
				err ? react.createElement("div", { key: "err", style: C.err }, err) : null,
				detail,
			]));
		}

		/** 工作区记忆面板（读 + 人工整篇编辑 + 首次建立）。 */
		function WorkspaceMemoryPane(props) {
			const say = props.say;
			const cwd = props.cwd;
			const url = cwd ? WS_API + "?cwd=" + encodeURIComponent(cwd) : "";
			const [state, reload] = useLoader(() => (url ? getJson(url) : Promise.resolve(null)), [url]);
			const [editing, setEditing] = react.useState(false);
			const [draft, setDraft] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [err, setErr] = react.useState("");
			react.useEffect(() => { setEditing(false); setErr(""); }, [url]);

			if (!cwd) {
				return react.createElement("div", { style: C.card }, kids([
					react.createElement("div", { key: "t", style: C.title }, "这个会话还没有工作目录"),
					react.createElement("div", { key: "s", style: Object.assign({}, C.sub, { marginTop: 6 }) },
						"工作区记忆按会话的工作目录（所在 git 仓库）存放 ⇒ 先在输入框上方选一个工作区再开会话。"),
				]));
			}

			const data = state.data;
			const post = (body, okText) => {
				setBusy(true);
				setErr("");
				return postJson(WS_API, Object.assign({ cwd }, body))
					.then(() => { if (okText) { say(okText); } setEditing(false); reload(); })
					.catch((e) => setErr(String((e && e.message) || e)))
					.then(() => setBusy(false));
			};

			if (state.error) {
				return react.createElement("div", { style: C.card }, kids([
					react.createElement("div", { key: "e", style: C.err }, "读取失败：" + explainLoadError(state.error)),
					react.createElement("button", { key: "r", type: "button", style: Object.assign({}, C.btn, { marginTop: 8 }), onClick: reload }, "重试"),
				]));
			}
			if (!data) {
				return react.createElement("div", { style: C.tiny }, state.loading ? "正在读取工作区记忆…" : "");
			}

			const ws = data.workspace || {};
			const limits = data.limits || {};
			const usage = data.usage || {};
			const limit = Number(limits.chars) || 0;
			const used = Number(usage.chars) || 0;
			const over = limit > 0 && used > limit;
			const pct = limit > 0 ? Math.min(100, Math.round((Math.min(used, limit) / limit) * 100)) : 0;
			const runtime = data.runtime || {};

			const gitInfo = data.git || {};
			const head = react.createElement("div", { key: "head", style: C.row }, kids([
				react.createElement("span", { key: "n", style: C.title }, String(ws.name || "工作区")),
				react.createElement("span", { key: "g", style: C.badge, title: String(ws.remote || "") },
					ws.isGit ? "git 仓库" : "非 git 目录"),
				react.createElement("span", { key: "u", style: limit > 0 ? C.badgeOn : C.badge },
					limit > 0 ? ("注入 " + used + " / " + limit + " 字符") : "注入已关闭"),
				react.createElement("span", { key: "m", style: C.badge },
					limits.mode === "live" ? "live（每轮刷新）" : "session（会话内冻结）"),
				// 记忆自己的版本历史（2026-11-03）：已提交几次、还有几处没提交。没启用 Git 就不画（不假装有历史）
				data.exists && gitInfo.enabled
					? react.createElement("span", {
						key: "v", style: Number(gitInfo.dirty) > 0 ? C.badgeOn : C.badge,
						title: "记忆目录自己的 Git 历史（回合结束自动落一条提交，可在完整页回滚）",
					}, "历史 " + (Number(gitInfo.commits) || 0) + (Number(gitInfo.dirty) > 0 ? " · 未提交 " + Number(gitInfo.dirty) : ""))
					: null,
				react.createElement("span", { key: "sp", style: C.grow }),
				react.createElement("button", { key: "r", type: "button", style: C.btn, disabled: busy, onClick: reload }, "刷新"),
				data.exists && !editing
					? react.createElement("button", {
						key: "e", type: "button", style: C.btn, disabled: busy,
						onClick: () => { setDraft(String(data.text || "")); setEditing(true); },
					}, "编辑")
					: null,
				data.exists && data.scopeId && props.bridge
					? react.createElement("button", {
						key: "f", type: "button", style: C.btn,
						onClick: () => openPage(props.bridge, "/x/agents/memory/" + encodeURIComponent(data.scopeId), say),
						title: "打开完整记忆演化页（提交历史 / 版本 / 分支 / 备份 / 回滚）",
					}, "完整页")
					: null,
			]));

			const rootLine = react.createElement("div", { key: "root", style: C.tiny }, kids([
				"归属：" + String(ws.root || ""),
				ws.cwd && normPath(ws.cwd) !== normPath(ws.root) ? "（会话目录 " + baseName(ws.cwd) + " 归到 git 根）" : "",
			]).join(""));

			const bar = limit > 0
				? react.createElement("div", { key: "bar", style: C.bar, title: "已用 " + used + " / 上限 " + limit },
					react.createElement("i", {
						style: Object.assign({}, C.barFill, {
							width: pct + "%",
							background: over ? "var(--dsw-alias-label-warning, #d29922)" : C.barFill.background,
						}),
					}))
				: null;
			const overNote = over
				? react.createElement("div", { key: "over", style: C.tiny },
					"超出上限 " + (used - limit) + " 字符 ⇒ 只有前 " + limit + " 字符会注入（后面的 AI 看不到）。")
				: null;

			let body;
			if (!data.exists) {
				// 搬家 / 改名 / 另一台机器 clone 到不同路径 ⇒ 路径变了 ⇒ 旧记忆"断链"。
				// 只列"同 remote、旧根已不存在"的候选，由人点确认（复制不是移动，旧的不删）。
				const claimable = Array.isArray(data.claimable) ? data.claimable : [];
				const claimCard = claimable.length > 0
					? react.createElement("div", { key: "claim", style: C.card }, kids([
						react.createElement("div", { key: "t", style: C.title }, "发现这个仓库以前的记忆"),
						react.createElement("div", { key: "s", style: Object.assign({}, C.sub, { margin: "4px 0 8px" }) },
							"下面这些记忆属于同一个 git 远端，但原来的目录在本机已经不存在（搬家 / 改名 / 换了机器）。认领会把它复制过来，原来的不会被删除。"),
						react.createElement("div", { key: "l", style: C.list },
							claimable.map((c) => react.createElement("div", { key: c.key, style: Object.assign({}, C.item, { display: "flex", gap: 8, alignItems: "center" }) }, kids([
								react.createElement("span", { key: "n", style: C.grow, title: String(c.root || "") },
									String(c.name || c.key) + " · " + (Number(c.chars) || 0) + " 字符 · 原路径 " + String(c.root || "?")),
								react.createElement("button", {
									key: "b", type: "button", style: C.btnPrimary, disabled: busy,
									onClick: () => { void post({ action: "claim", from: c.key }, "已认领旧记忆"); },
								}, busy ? "认领中…" : "认领"),
							])))),
					]))
					: null;
				body = react.createElement("div", { key: "empty", style: C.col }, kids([
					claimCard,
					react.createElement("div", { key: "card", style: C.card }, kids([
						react.createElement("div", { key: "t", style: C.title }, "这个工作区还没有记忆"),
						react.createElement("div", { key: "s", style: Object.assign({}, C.sub, { marginTop: 6 }) },
							"AI 发现值得长期记住的项目约定 / 决策 / 踩坑时，会用 workspace_memory 工具写进来；"
							+ "这个工作区里的所有会话（普通会话与 Bot 会话）都会在开场注入它。"),
						react.createElement("button", {
							key: "b", type: "button", style: Object.assign({}, C.btnPrimary, { marginTop: 8 }), disabled: busy,
							onClick: () => { void post({ action: "init" }, "已建立工作区记忆"); },
						}, busy ? "建立中…" : "新建工作区记忆"),
					])),
				]));
			} else if (editing) {
				body = react.createElement("div", { key: "edit", style: C.col }, kids([
					react.createElement("textarea", {
						key: "ta",
						value: draft,
						disabled: busy,
						onChange: (e) => setDraft(e && e.target ? e.target.value : ""),
						style: Object.assign({}, C.input, {
							width: "100%", minHeight: 220, boxSizing: "border-box",
							fontFamily: "var(--dsw-alias-font-mono, ui-monospace, Consolas, monospace)", lineHeight: "18px",
						}),
					}),
					react.createElement("div", { key: "ops", style: C.row }, kids([
						react.createElement("span", { key: "c", style: C.tiny }, draft.length + " / " + (Number(limits.max) || 20000) + " 字符"),
						react.createElement("span", { key: "sp", style: C.grow }),
						react.createElement("button", { key: "x", type: "button", style: C.btn, disabled: busy, onClick: () => setEditing(false) }, "取消"),
						react.createElement("button", {
							key: "s", type: "button", style: C.btnPrimary, disabled: busy,
							onClick: () => { void post({ action: "write", text: draft }, "工作区记忆已保存（新会话生效）"); },
						}, busy ? "保存中…" : "保存"),
					])),
				]));
			} else {
				const lines = parseMemory(data.text);
				body = lines.length === 0
					? react.createElement("div", { key: "none", style: C.card },
						react.createElement("div", { style: C.sub }, "还没有条目（点「编辑」手写，或让 AI 用 workspace_memory 工具追加）。"))
					: react.createElement("div", { key: "list", style: C.list },
						lines.map((ln, i) => {
							if (ln.kind === "head") {
								return react.createElement("div", { key: "h" + i, style: Object.assign({}, C.title, { marginTop: i > 0 ? 4 : 0 }) }, ln.text);
							}
							if (ln.kind === "item") {
								return react.createElement("div", { key: "i" + i, style: Object.assign({}, C.item, { display: "flex", gap: 8 }) }, kids([
									react.createElement("span", { key: "m", style: C.sub }, "•"),
									react.createElement("span", { key: "x", style: C.grow }, ln.text),
								]));
							}
							return react.createElement("div", { key: "t" + i, style: C.sub }, ln.text);
						}));
			}

			const errNote = err ? react.createElement("div", { key: "err", style: C.err }, err) : null;
			const sectionOff = runtime.order === undefined || runtime.order === null;
			const foot = react.createElement("div", { key: "foot", style: C.tiny },
				sectionOff
					? "⚠ 注入 section 没有在这个 Host 里注册（插件版本旧或 systemPrompt 服务缺席）⇒ 目前只能查看，不会注入。"
					: "所有会话共享；改动在新会话生效（当前会话的快照已冻结以保证 prompt 缓存命中）。存放：" + String(data.dir || ""));

			// 历史：只在记忆已建立、Git 已启用、且不在编辑态时给（编辑中回滚会让草稿与文件错位）
			const history = data.exists && gitInfo.enabled && data.scopeId && !editing
				? react.createElement(MemoryHistoryPanel, {
					key: "hist", scopeId: data.scopeId, say, version: gitInfo.commits, onChanged: reload,
				})
				: null;

			return react.createElement("div", { style: C.col }, kids([head, rootLine, bar, overNote, errNote, body, history, foot]));
		}

		/**
		 * 「回合末自动提交」开关卡（★ 2026-11-03 P2：从只读变可写）。
		 * 开关是**全局偏好**（`<数据根>/memory-prefs.json`，Bot 记忆与工作区记忆共用），改完立刻生效、不用重启：
		 * 回合结束时 Host 把这一轮的记忆改动落成一条 Git 提交，演化图才有真实节奏。
		 * `git` / `turns` 由所在面板传入（Bot 面板与工作区面板各自的仓库状态）；没有就只画开关。
		 */
		function AutoCommitCard(props) {
			const say = props.say;
			const git = props.git || null;
			const [state, reload] = useLoader(() => getJson(PREFS_API), []);
			const [busy, setBusy] = react.useState(false);
			const [err, setErr] = react.useState("");
			const data = state.data;
			const on = data ? data.autoCommit === true : null;
			const toggle = () => {
				if (on === null) { return; }
				setBusy(true);
				setErr("");
				postJson(PREFS_API, { autoCommit: !on })
					.then(() => { if (say) { say(!on ? "已开启回合末自动提交" : "已关闭回合末自动提交"); } reload(); })
					.catch((e) => setErr("保存失败：" + explainLoadError(String((e && e.message) || e))))
					.then(() => setBusy(false));
			};
			const sourceNote = data && data.source === "config"
				? "（当前由插件配置 memoryAutoCommit:false 关闭；在这里点开启会覆盖它）"
				: data && data.source === "pref" ? "（你设置的）" : "（默认）";
			let detail;
			if (state.error) {
				detail = react.createElement("div", { key: "d", style: Object.assign({}, C.err, { marginTop: 4 }) }, "读取失败：" + explainLoadError(state.error));
			} else if (git && git.enabled) {
				detail = react.createElement("div", { key: "d", style: Object.assign({}, C.sub, { marginTop: 4 }) },
					"这份记忆已有 " + (Number(git.commits) || 0) + " 条历史，" + (Number(git.dirty) > 0 ? "还有 " + Number(git.dirty) + " 处未提交" : "没有未提交的改动")
					+ "；本次运行已自动提交 " + (Number(props.turns) || 0) + " 次。");
			} else if (props.exists === false) {
				detail = react.createElement("div", { key: "d", style: Object.assign({}, C.sub, { marginTop: 4 }) }, "记忆还没建立 ⇒ 暂时没有可提交的历史。");
			} else {
				detail = react.createElement("div", { key: "d", style: Object.assign({}, C.sub, { marginTop: 4 }) }, "记忆目录还没有 Git 化（第一次写入或打开「完整页」时会自动建立）。");
			}
			return react.createElement("div", { style: C.card }, kids([
				react.createElement("div", { key: "r", style: C.row }, kids([
					react.createElement("span", { key: "t", style: C.title }, "回合末自动提交快照"),
					on === null ? null : react.createElement("span", { key: "s", style: on ? C.badgeOn : C.badge }, on ? "开" : "关"),
					react.createElement("span", { key: "sp", style: C.grow }),
					react.createElement("button", {
						key: "b", type: "button", style: on ? C.btn : C.btnPrimary, disabled: busy || on === null, onClick: toggle,
					}, busy ? "保存中…" : (on ? "关闭" : "开启")),
				])),
				detail,
				err ? react.createElement("div", { key: "e", style: Object.assign({}, C.err, { marginTop: 4 }) }, err) : null,
				react.createElement("div", { key: "h", style: Object.assign({}, C.tiny, { marginTop: 4 }) },
					"全局开关，Bot 记忆与工作区记忆共用 " + sourceNote + "。关闭后改动仍会备份，只是不再自动落提交。"),
			]));
		}

		/** 工作区记忆的注入口径（写 scope.json，不碰正文）。 */
		function WorkspaceSettingsPane(props) {
			const say = props.say;
			const cwd = props.cwd;
			const url = cwd ? WS_API + "?cwd=" + encodeURIComponent(cwd) : "";
			const [state, reload] = useLoader(() => (url ? getJson(url) : Promise.resolve(null)), [url]);
			const [chars, setChars] = react.useState(null);
			const [mode, setMode] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [err, setErr] = react.useState("");
			const data = state.data;
			const initializedFor = react.useRef("");
			react.useEffect(() => {
				if (!data || initializedFor.current === url) { return; }
				initializedFor.current = url;
				const l = data.limits || {};
				setChars(String(Number(l.chars) || 0));
				setMode(l.mode === "live" ? "live" : "session");
			}, [data, url]);

			if (!cwd) {
				return react.createElement("div", { style: C.card },
					react.createElement("div", { style: C.sub }, "这个会话还没有工作目录 ⇒ 没有工作区记忆可设置。"));
			}
			if (state.error) {
				return react.createElement("div", { style: C.card },
					react.createElement("div", { style: C.err }, "读取失败：" + explainLoadError(state.error)));
			}
			const ws = (data && data.workspace) || {};
			const save = () => {
				const n = Number(String(chars).trim());
				if (!Number.isFinite(n) || (n !== 0 && (n < 512 || n > 20000))) {
					setErr("注入上限要是数字：0（关闭）或 512~20000 之间");
					return;
				}
				setSaving(true);
				setErr("");
				postJson(WS_API, { cwd, action: "set-limits", chars: Math.trunc(n), mode })
					.then(() => { say("工作区记忆口径已保存（新会话生效）"); reload(); })
					.catch((e) => setErr("保存失败：" + String((e && e.message) || e)))
					.then(() => setSaving(false));
			};
			return react.createElement("div", { style: C.col }, kids([
				react.createElement("div", { key: "limits", style: C.card }, kids([
					react.createElement("div", { key: "t", style: C.row }, kids([
						react.createElement("span", { key: "n", style: C.title }, "工作区「" + String(ws.name || baseName(cwd)) + "」注入"),
						react.createElement("span", { key: "sp", style: C.grow }),
						react.createElement("button", { key: "s", type: "button", style: C.btnPrimary, disabled: saving || !data, onClick: save }, saving ? "保存中…" : "保存"),
					])),
					react.createElement("div", { key: "d", style: Object.assign({}, C.sub, { margin: "4px 0 8px" }) },
						"工作区 MEMORY.md 的前 N 个字符注入到本工作区的**所有**会话（Bot 会话里排在 Bot 记忆之后）。0 = 关闭；范围 512~20000。"),
					react.createElement("div", { key: "r1", style: C.row }, kids([
						react.createElement("span", { key: "l", style: C.sub }, "上限"),
						react.createElement("input", {
							key: "in", style: Object.assign({}, C.input, { width: 90 }),
							type: "number", min: 0, max: 20000, step: 256,
							value: chars === null ? "" : chars, disabled: saving || !data,
							onChange: (e) => setChars(e && e.target ? e.target.value : ""),
						}),
						react.createElement("span", { key: "u", style: C.tiny }, "字符"),
					])),
					react.createElement("div", { key: "r2", style: Object.assign({}, C.row, { marginTop: 8 }) }, kids([
						react.createElement("span", { key: "l", style: C.sub }, "模式"),
						react.createElement("button", { key: "s", type: "button", style: mode === "session" ? C.btnPrimary : C.btn, disabled: saving || !data, onClick: () => setMode("session") }, "session（会话内冻结）"),
						react.createElement("button", { key: "v", type: "button", style: mode === "live" ? C.btnPrimary : C.btn, disabled: saving || !data, onClick: () => setMode("live") }, "live（每轮刷新）"),
					])),
					err ? react.createElement("div", { key: "e", style: Object.assign({}, C.err, { marginTop: 6 }) }, err) : null,
					react.createElement("div", { key: "f", style: Object.assign({}, C.tiny, { marginTop: 6 }) },
						"存在工作区记忆目录的 scope.json 里（不改仓库里的任何文件）。"),
				])),
				// 回合末自动提交：全局开关（Bot 记忆与工作区记忆共用），下面带这个工作区自己的历史统计
				react.createElement(AutoCommitCard, {
					key: "auto", say, git: data && data.exists ? data.git : null,
					turns: data && data.autoCommit ? data.autoCommit.turns : 0,
					exists: !!(data && data.exists),
				}),
			]));
		}

		/** 记忆页 / 记忆设置页顶部：「工作区 | Bot」分段 + 多根工作区的根选择。 */
		function useScopePicker(ctx, sessionId) {
			useSessionsTick(ctx);
			const agentId = agentIdOf(ctx, sessionId);
			const cwd = cwdOf(ctx, sessionId);
			const roots = rootOptionsFor(cwd);
			const [scope, setScope] = react.useState("workspace");
			const [rootCwd, setRootCwd] = react.useState("");
			// 会话换了 ⇒ 回到默认（工作区 + 会话自己的根）
			react.useEffect(() => { setScope("workspace"); setRootCwd(""); }, [sessionId]);
			const effectiveScope = scope === "bot" && !agentId ? "workspace" : scope;
			const picked = roots.find((r) => r.cwd === rootCwd) || roots.find((r) => r.current) || roots[0];
			const bar = react.createElement("div", { key: "scope", style: C.row }, kids([
				react.createElement(Segment, {
					key: "seg",
					value: effectiveScope,
					onChange: setScope,
					options: [
						{ value: "workspace", label: "工作区" },
						{
							value: "bot", label: agentId ? ("Bot · " + agentId) : "Bot",
							disabled: !agentId,
							title: agentId ? "" : "当前会话没有选 Bot（preset 不是 vssaros-*）⇒ 没有 Bot 记忆",
						},
					],
				}),
				effectiveScope === "workspace" && roots.length > 1
					? react.createElement("span", { key: "sep", style: C.tiny }, "根：")
					: null,
				effectiveScope === "workspace" && roots.length > 1
					? react.createElement(Segment, {
						key: "roots",
						value: picked ? picked.cwd : "",
						onChange: setRootCwd,
						options: roots.map((r) => ({ value: r.cwd, label: r.name + (r.current ? "（当前）" : ""), title: r.cwd })),
					})
					: null,
			]));
			return { agentId, scope: effectiveScope, cwd: picked ? picked.cwd : "", bar };
		}

		/** 记忆页签：默认看工作区记忆；有 Bot 时可切到 Bot 记忆。 */
		function MemoryView(props) {
			const ctx = props.__vssarosCtx;
			const sessionId = props.sessionId || "";
			const pick = useScopePicker(ctx, sessionId);
			const pane = pick.scope === "bot"
				? react.createElement(BotMemoryPane, Object.assign({}, props, { key: "bot", agentId: pick.agentId }))
				: react.createElement(WorkspaceMemoryPane, { key: "ws:" + pick.cwd, cwd: pick.cwd, say: props.__vssarosSay, bridge: props.__vssarosBridge });
			return react.createElement("div", { style: C.root, "data-vssaros-view": "memory", "data-vssaros-memory-scope": pick.scope },
				kids([pick.bar, pane]));
		}

		/**
		 * 「VsSaros Memory 模块」设置卡（★ 2026-11-03：两套页签合并）。
		 * 原 evolve 的独立「Vssaros Memory 设置」页签已下线，它的运行时配置能力
		 * 通过同源 /memory-evolve/api/config 接进本页，避免第二套页签。
		 * 指南 / 待确认建议仍在 evolve 的「记忆」页签内，不在这里重复。
		 */
		const MEM_CONFIG_API = "/memory-evolve/api/config";
		const MEM_UPDATE_API = "/memory-evolve/api/update/status";
		const MEM_TOGGLES = [
			{ key: "perTurnProjectWrites", label: "每轮写项目进展" },
			{ key: "perTurnDailyWrites", label: "每轮写今日日志" },
			{ key: "perTurnKeyWrites", label: "每轮提交 KEY 建议" },
			{ key: "perTurnWriteGuard", label: "写入守卫" },
			{ key: "reviewEnabled", label: "记忆审查" },
			{ key: "todoEnabled", label: "待办模块" },
			{ key: "notifyEnabled", label: "通知" },
		];
		function MemoryModuleCard(props) {
			const say = props.say;
			const [state, reload] = useLoader(() => getJson(MEM_CONFIG_API), []);
			const [ver] = useLoader(() => getJson(MEM_UPDATE_API), []);
			const [busy, setBusy] = react.useState(false);
			const [err, setErr] = react.useState("");
			const cfg = state.data && state.data.config ? state.data.config : null;
			const toggle = (key) => {
				if (!cfg) { return; }
				setBusy(true);
				setErr("");
				postJson(MEM_CONFIG_API, { patch: { [key]: !(cfg[key] === true) } })
					.then(() => { if (say) { say("记忆模块配置已更新：" + key); } reload(); })
					.catch((e) => setErr("保存失败：" + explainLoadError(String((e && e.message) || e))))
					.then(() => setBusy(false));
			};
			const version = ver.data && ver.data.status ? String(ver.data.status) : "";
			return react.createElement("div", { style: C.card, "data-vssaros-view": "memory-module-settings" }, kids([
				react.createElement("div", { key: "h", style: C.row }, kids([
					react.createElement("span", { key: "t", style: C.title }, "VsSaros Memory 模块"),
					react.createElement("span", { key: "sp", style: C.grow }),
					version ? react.createElement("span", { key: "v", style: C.badge }, "更新状态：" + version) : null,
				])),
				state.error ? react.createElement("div", { key: "e", style: C.err }, "读取失败：" + explainLoadError(state.error)) : null,
				err ? react.createElement("div", { key: "e2", style: C.err }, err) : null,
				...MEM_TOGGLES.map((m) => react.createElement("div", { key: m.key, style: C.row }, kids([
					react.createElement("span", { key: "t", style: C.sub }, m.label),
					react.createElement("span", { key: "sp", style: C.grow }),
					react.createElement("button", {
						key: "b", type: "button", disabled: busy || !cfg,
						style: cfg && cfg[m.key] === true ? C.btnPrimary : C.btn,
						onClick: () => toggle(m.key),
					}, cfg ? (cfg[m.key] === true ? "开" : "关") : "—"),
				]))),
				react.createElement("div", { key: "n", style: Object.assign({}, C.tiny, { marginTop: 4 }) },
					"原「Vssaros Memory 设置」页签已并入此处；指南、待确认建议与版本详情在「记忆」页签内。"),
			]));
		}

		/** 设置页签：同样按「工作区 | Bot」分段；AgentMemory 卡两段都显示。 */
		function SettingsView(props) {
			const ctx = props.__vssarosCtx;
			const sessionId = props.sessionId || "";
			const pick = useScopePicker(ctx, sessionId);
			const pane = pick.scope === "bot"
				? react.createElement(BotSettingsPane, Object.assign({}, props, { key: "bot", agentId: pick.agentId }))
				: react.createElement(WorkspaceSettingsPane, { key: "ws:" + pick.cwd, cwd: pick.cwd, say: props.__vssarosSay });
			return react.createElement("div", { style: C.root, "data-vssaros-view": "bot-settings", "data-vssaros-memory-scope": pick.scope },
				kids([
					pick.bar,
					// ★ 2026-11-03：Bot 配置（名称/描述/角色/模型/人设/技能）→ 只有 Bot 段才有
					pick.scope === "bot" && pick.agentId
						? react.createElement(BotConfigCard, { key: "cfg", agentId: pick.agentId, say: props.__vssarosSay })
						: null,
					pane,
					// ★ 2026-11-03：evolve 的「Vssaros Memory 设置」页签并入本页（全局卡，两段都显示）
					react.createElement(MemoryModuleCard, { key: "mem-module", say: props.__vssarosSay }),
				]));
		}

		/**
		 * Bot 配置卡（★ 2026-11-03，替代已下线的「Bot 设置」右侧栏面板与完整页设置）：
		 * 读 `GET /x/agents/api/agents?id=` 拿 `.agent.md` 的完整草稿，写 `POST /x/agents/api/agents {action:'update', id, draft}`。
		 * ⚠ 只提交用户改过的**文本字段**；`id` 不可改（文件名即身份）。
		 */
		function BotConfigCard(props) {
			const agentId = props.agentId || "";
			const say = props.say;
			const url = agentId ? "/x/agents/api/agents?id=" + encodeURIComponent(agentId) : "";
			const [state, reload] = useLoader(() => (url ? getJson(url) : Promise.resolve(null)), [url]);
			const [draft, setDraft] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [note, setNote] = react.useState("");
			const [err, setErr] = react.useState("");
			const initializedFor = react.useRef("");
			const data = state.data;
			const loaded = data && data.draft ? data.draft : null;
			react.useEffect(() => {
				if (!loaded || initializedFor.current === url) { return; }
				initializedFor.current = url;
				setDraft({
					name: String(loaded.name || ""),
					description: String(loaded.description || ""),
					role: String(loaded.role || ""),
					model: String(loaded.model || ""),
					skills: String(loaded.skills || ""),
					persona: String(loaded.persona || ""),
				});
				setErr("");
				setNote("");
			}, [loaded, url]);

			if (!agentId) {
				return null;
			}
			if (!draft) {
				return react.createElement("div", { style: C.card }, kids([
					react.createElement("div", { key: "t", style: C.title }, "Bot 配置"),
					react.createElement("div", { key: "s", style: Object.assign({}, C.sub, { marginTop: 6 }) },
						state.error ? ("读取失败：" + state.error) : "读取中…"),
				]));
			}
			const field = (key, label, placeholder, multiline, rows) => react.createElement("div", { key, style: { marginTop: 8 } },
				react.createElement("div", { style: Object.assign({}, C.tiny, { marginBottom: 3 }) }, label),
				react.createElement(multiline ? "textarea" : "input", {
					style: Object.assign({}, C.input, { width: "100%", boxSizing: "border-box" }, multiline ? { minHeight: rows || 72, resize: "vertical" } : {}),
					value: draft[key],
					placeholder: placeholder || "",
					["data-vssaros-botcfg-" + key]: "1",
					disabled: saving,
					onChange: (e) => {
						const v = e && e.target ? e.target.value : "";
						setDraft((d) => Object.assign({}, d || {}, { [key]: v }));
						setNote("");
						setErr("");
					},
				}));

			const save = () => {
				setSaving(true);
				setErr("");
				setNote("");
				// 只发这些字段（draft 的其余字段由 host 保留）
				const body = {
					action: "update",
					id: agentId,
					draft: {
						name: String(draft.name || "").trim(),
						description: String(draft.description || "").trim(),
						role: String(draft.role || "").trim(),
						model: String(draft.model || "").trim(),
						skills: String(draft.skills || "").trim(),
						persona: String(draft.persona || ""),
					},
				};
				postJson("/x/agents/api/agents", body).then(
					() => {
						setNote("已保存到 .agent.md。人设改动对**新会话**生效（已有会话的工具与模型已锁定）。");
						reload();
					},
					(e) => setErr("保存失败：" + String((e && e.message) || e)),
				).then(() => setSaving(false));
			};

			return react.createElement("div", { style: C.card, "data-vssaros-botcfg": agentId }, kids([
				react.createElement("div", { key: "r", style: C.row }, kids([
					react.createElement("span", { key: "t", style: C.title }, "Bot 配置"),
					react.createElement("span", { key: "b", style: C.badge }, agentId),
					react.createElement("span", { key: "sp", style: C.grow }),
					react.createElement("button", { key: "r2", type: "button", style: C.btn, disabled: saving, onClick: () => { reload(); } }, "刷新"),
					react.createElement("button", { key: "s", type: "button", style: C.btnPrimary, disabled: saving, onClick: save }, saving ? "保存中…" : "保存"),
				])),
				react.createElement("div", { key: "d", style: Object.assign({}, C.sub, { marginTop: 4 }) },
					"写回该 Bot 的 .agent.md（名称 / 描述 / 角色 / 模型 / 技能 / 人设）。id 不可改，它就是目录名。"),
				field("name", "名称", "例如 代码审阅员"),
				field("description", "描述（一行）", "在名册 / 欢迎卡里显示"),
				field("role", "角色标签", "例如 检索 / 审阅"),
				field("model", "模型", "provider/model（如 vssaros-codebuddy/hy4）；留空 = 跟随默认"),
				field("skills", "技能（逗号分隔）", "anysearch, analysis"),
				field("persona", "人设正文（Markdown）", "你就是……", true, 160),
				err ? react.createElement("div", { key: "e", style: Object.assign({}, C.err, { marginTop: 6 }) }, err) : null,
				note ? react.createElement("div", { key: "n", style: Object.assign({}, C.tiny, { marginTop: 6 }) }, note) : null,
			]));
		}

		// ══════════════════════════════════════════════════════════════════════
		// 1. 记忆 · Bot 那一段（工作区那一段见上方 WorkspaceMemoryPane）
		// ══════════════════════════════════════════════════════════════════════
		function BotMemoryPane(props) {
			const bridge = props.__vssarosBridge;
			const say = props.__vssarosSay;
			const agentId = props.agentId || "";
			const [file, setFile] = react.useState("MEMORY.md");
			const url = agentId
				? "/x/agents/api/memory?agent=" + encodeURIComponent(agentId) + "&file=" + encodeURIComponent(file)
				: "";
			const [state, reload] = useLoader(() => (url ? getJson(url) : Promise.resolve(null)), [url]);

			if (!agentId) {
				return react.createElement("div", { style: C.card }, kids([
					react.createElement("div", { key: "t", style: C.title }, "当前会话没有选 Bot"),
					react.createElement("div", { key: "s", style: Object.assign({}, C.sub, { marginTop: 6 }) },
						"Bot 记忆按 Bot 存（preset 是 vssaros-*）；项目相关的记忆看「工作区」那一段。"),
				]));
			}

			const data = state.data;
			const limits = (data && data.limits) || {};
			const usage = (data && data.usage) || {};
			const git = (data && data.git) || {};
			const files = (data && data.files) || [];
			const limit = Number(limits.chars) || 0;
			const used = Number(usage.chars) || 0;
			const injected = Number(usage.injected) || 0;
			const over = limit > 0 && used > limit;
			const pct = limit > 0 ? Math.min(100, Math.round((Math.min(used, limit) / limit) * 100)) : 0;
			const lines = parseMemory(data && data.content && data.content.text);

			const head = react.createElement("div", { key: "head", style: C.row }, kids([
				react.createElement("span", { key: "t", style: C.title }, "Bot 记忆"),
				react.createElement("span", { key: "bot", style: C.badge }, "Bot " + agentId),
				react.createElement("span", { key: "usage", style: limit > 0 ? C.badgeOn : C.badge },
					limit > 0 ? ("注入 " + used + " / " + limit + " 字符") : "注入已关闭"),
				react.createElement("span", { key: "mode", style: C.badge },
					limits.mode === "live" ? "live（每轮刷新）" : "session（会话内冻结）"),
				react.createElement("span", { key: "sp", style: C.grow }),
				react.createElement("button", { key: "reload", type: "button", style: C.btn, onClick: reload, title: "重新读取" }, "刷新"),
				react.createElement("button", {
					key: "full", type: "button", style: C.btn,
					onClick: () => openPage(bridge, "/x/agents/memory/" + encodeURIComponent(agentId), say),
					title: "打开完整记忆演化页（版本 / 分支 / 备份 / 回滚）",
				}, "完整页"),
			]));

			const usageBar = limit > 0
				? react.createElement("div", { key: "bar", style: C.bar, title: "已用 " + used + " / 上限 " + limit },
					react.createElement("i", {
						style: Object.assign({}, C.barFill, {
							width: pct + "%",
							background: over ? "var(--dsw-alias-state-warn-label, #d29922)" : C.barFill.background,
						}),
					}))
				: react.createElement("div", { key: "bar", style: C.tiny },
					"注入上限为 0 ⇒ MEMORY.md 不会进入 system prompt（在「记忆设置」里调）。");

			const overNote = over
				? react.createElement("div", { key: "over", style: C.tiny },
					"超出上限 " + (used - limit) + " 字符 ⇒ 实际注入只有前 " + injected + " 字符（后面的内容 AI 看不到）。")
				: null;

			const gitRow = react.createElement("div", { key: "git", style: C.row }, kids([
				react.createElement("span", { key: "s", style: C.sub }, git.enabled ? "Git 记忆仓" : "未启用 Git 化"),
				git.enabled ? react.createElement("span", { key: "b", style: C.badge }, "分支 " + String(git.branch || "main")) : null,
				git.enabled ? react.createElement("span", { key: "c", style: C.badge }, "提交 " + (Number(git.commits) || 0)) : null,
				git.enabled
					? react.createElement("span", { key: "d", style: Number(git.dirty) > 0 ? C.badgeOn : C.badge }, "未提交 " + (Number(git.dirty) || 0))
					: null,
				git.note ? react.createElement("span", { key: "n", style: C.tiny }, String(git.note)) : null,
			]));

			const fileRow = files.length > 0
				? react.createElement("div", { key: "files", style: C.row },
					files.map((f) => react.createElement("button", {
						key: String(f.name),
						type: "button",
						style: String(f.name) === file ? C.btnPrimary : C.btn,
						onClick: () => setFile(String(f.name)),
						title: String(f.name || "") + " · " + sizeLabel(f.size),
					}, String(f.name))))
				: null;

			const errorCard = state.error
				? react.createElement("div", { key: "err", style: C.card },
					react.createElement("div", { style: C.err }, "读取失败：" + state.error))
				: null;

			const loadingNote = state.loading && !data
				? react.createElement("div", { key: "load", style: C.tiny }, "正在读取记忆…")
				: null;

			let body = null;
			if (data) {
				if (lines.length === 0) {
					body = react.createElement("div", { key: "empty", style: C.card }, kids([
						react.createElement("div", { key: "s", style: C.sub }, "这个文件还是空的。"),
						react.createElement("div", { key: "h", style: Object.assign({}, C.tiny, { marginTop: 6 }) },
							"写入请在「完整页」或用文件工具 —— 本页只读，避免破坏格式。"),
					]));
				} else {
					body = react.createElement("div", { key: "body", style: C.list },
						lines.map((ln, i) => {
							if (ln.kind === "head") {
								return react.createElement("div", {
									key: "h" + i,
									style: Object.assign({}, C.title, { marginTop: i > 0 ? 4 : 0 }),
								}, ln.text);
							}
							if (ln.kind === "item") {
								return react.createElement("div", {
									key: "i" + i,
									style: Object.assign({}, C.item, { display: "flex", gap: 8 }),
								}, kids([
									react.createElement("span", { key: "m", style: C.sub }, "•"),
									react.createElement("span", { key: "x", style: C.grow }, ln.text),
								]));
							}
							return react.createElement("div", { key: "t" + i, style: C.sub }, ln.text);
						}));
				}
			}

			const footNote = react.createElement("div", { key: "foot", style: C.tiny },
				"只读预览（写入走完整页，或让 Bot 用 workspace_memory 工具 scope=bot）。改动在**新会话**生效：当前会话的快照已冻结以保证 prompt 缓存命中。");

			return react.createElement("div", { style: C.col },
				kids([head, usageBar, overNote, gitRow, fileRow, errorCard, loadingNote, body, footNote]));
		}

		// ══════════════════════════════════════════════════════════════════════
		// 2. 技能
		// ══════════════════════════════════════════════════════════════════════
		function SkillsView(props) {
			const bridge = props.__vssarosBridge;
			const say = props.__vssarosSay;
			const [query, setQuery] = react.useState("");
			const [state, reload] = useLoader(() => getJson("/x/skills/api/skills"), []);
			const data = state.data;
			const all = (data && Array.isArray(data.skills)) ? data.skills : [];
			const q = query.trim().toLowerCase();
			const hit = q
				? all.filter((s) => (String(s.name || "") + " " + String(s.description || "")).toLowerCase().indexOf(q) >= 0)
				: all;
			const shown = hit.slice(0, SKILL_RENDER_LIMIT);

			const head = react.createElement("div", { key: "head", style: C.row }, kids([
				react.createElement("span", { key: "t", style: C.title }, "技能"),
				data ? react.createElement("span", { key: "c", style: C.badge }, "共 " + all.length) : null,
				q ? react.createElement("span", { key: "q", style: C.badgeOn }, "匹配 " + hit.length) : null,
				react.createElement("span", { key: "sp", style: C.grow }),
				react.createElement("button", { key: "r", type: "button", style: C.btn, onClick: reload }, "刷新"),
				react.createElement("button", {
					key: "open", type: "button", style: C.btn,
					onClick: () => openPage(bridge, "/x/skills/", say),
				}, "打开技能库"),
			]));

			const search = react.createElement("input", {
				key: "search",
				style: Object.assign({}, C.input, { width: "100%" }),
				placeholder: "按名称 / 描述搜索……",
				value: query,
				onChange: (e) => setQuery(e && e.target ? e.target.value : ""),
			});

			const errorNote = state.error
				? react.createElement("div", { key: "err", style: C.err }, "读取失败：" + state.error)
				: null;
			const loadingNote = state.loading && !data
				? react.createElement("div", { key: "load", style: C.tiny }, "正在扫描技能库…")
				: null;
			const rootNote = data && data.root
				? react.createElement("div", { key: "root", style: C.tiny }, "来源：" + String(data.root))
				: null;

			let listNode = null;
			if (shown.length === 0 && data) {
				listNode = react.createElement("div", { key: "empty", style: C.card },
					react.createElement("div", { style: C.sub },
						q ? "没有匹配的技能。" : "技能库是空的（把方法沉淀成技能后会出现在这里）。"));
			} else {
				listNode = react.createElement("div", { key: "list", style: C.list },
					shown.map((s) => react.createElement("div", { key: String(s.name), style: C.item }, kids([
						react.createElement("div", { key: "r", style: C.row }, kids([
							react.createElement("span", { key: "n", style: { fontWeight: 600 } }, String(s.name || "")),
							s.activation
								? react.createElement("span", { key: "a", style: C.badge },
									String(typeof s.activation === "string" ? s.activation : "已注册"))
								: null,
						])),
						s.description
							? react.createElement("div", { key: "d", style: C.sub }, String(s.description))
							: null,
					]))));
			}

			const moreNote = hit.length > shown.length
				? react.createElement("div", { key: "more", style: C.tiny },
					"只显示前 " + SKILL_RENDER_LIMIT + " 条（共 " + hit.length + "）—— 用搜索缩小范围，或打开技能库。")
				: null;

			const footNote = react.createElement("div", { key: "foot", style: C.tiny },
				"本页只读：「启用 / 禁用 / 编辑正文」在技能库里做，避免两处各写一套。");

			return react.createElement("div", { style: C.root, "data-vssaros-view": "skills" },
				kids([head, search, errorNote, loadingNote, rootNote, listNode, moreNote, footNote]));
		}

		// ══════════════════════════════════════════════════════════════════════
		// 3. 待办（官方 todos 投影，只读）
		// ══════════════════════════════════════════════════════════════════════
		/** 从某元素往上找**可滚动的**祖先（对话区）；找不到返回 null。 */
		function scrollableAncestor(el) {
			let node = el;
			while (node && node !== document.body) {
				try {
					const s = window.getComputedStyle(node);
					if (s && (s.overflowY === "auto" || s.overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
						return node;
					}
				} catch { /* 取样式失败继续往上 */ }
				node = node.parentElement;
			}
			return null;
		}

		/** 在对话区按**文本**找叶子元素（只认叶子，否则命中的是整段历史的容器）。 */
		function locateByText(root, text) {
			const scope = root || document;
			if (!scope || !text) { return null; }
			let hit = null;
			try {
				const leaves = scope.querySelectorAll("*");
				for (let i = 0; i < leaves.length; i++) {
					const el = leaves[i];
					if (!el || el.childElementCount !== 0) { continue; }
					const t = (el.textContent || "").trim();
					if (t && t.indexOf(text) >= 0) { hit = el; }
				}
			} catch { /* 遍历失败按没找到处理 */ }
			return hit;
		}

		function flash(el) {
			try {
				const prev = el.style.outline;
				el.style.outline = "2px solid var(--dsw-alias-brand-primary, #3794ff)";
				el.style.outlineOffset = "2px";
				window.setTimeout(() => {
					try { el.style.outline = prev; el.style.outlineOffset = ""; } catch { /* 元素已移除 */ }
				}, 1400);
			} catch { /* 高亮失败不影响滚动 */ }
		}

		const TODO_GROUPS = [
			{ key: "in_progress", label: "进行中", mark: "◐" },
			{ key: "pending", label: "待处理", mark: "○" },
			{ key: "completed", label: "已完成", mark: "✔" },
		];

		function TodoView(props) {
			const say = props.__vssarosSay;
			const useProjection = props.useProjection;
			const hasProjection = typeof useProjection === "function";
			let todos;
			try {
				todos = hasProjection ? useProjection("todos") : undefined;
			} catch {
				todos = undefined;
			}
			const list = Array.isArray(todos) ? todos : null;

			const jump = (item) => {
				const text = String((item && item.content) || "").trim();
				if (!text) { return; }
				const hit = locateByText(scrollableAncestor(document.querySelector("[data-vssaros-css]")) || document, text)
					|| locateByText(document, text);
				if (hit) {
					try { hit.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { hit.scrollIntoView(); }
					flash(hit);
					return;
				}
				say("未在对话里定位到这条任务（可能属于更早的会话，或工具卡已折叠）：" + text);
			};

			if (!hasProjection) {
				// ⚠ 不能把它显示成"还没有任务清单" —— 那是"未知伪装成空"（本仓反复踩的坑 ✗）
				return react.createElement("div", { style: C.root, "data-vssaros-view": "todo" }, kids([
					react.createElement("div", { key: "card", style: C.card }, kids([
						react.createElement("div", { key: "t", style: C.title }, "这个窗口读不到会话投影"),
						react.createElement("div", { key: "s", style: Object.assign({}, C.sub, { marginTop: 6 }) },
							"槽 props 里没有 useProjection（dsh 版本或宿主形态不支持）⇒ 无法展示任务清单，这不是「0 个任务」。"),
					])),
				]));
			}

			if (!list) {
				return react.createElement("div", { style: C.root, "data-vssaros-view": "todo" }, kids([
					react.createElement("div", { key: "card", style: C.card }, kids([
						react.createElement("div", { key: "t", style: C.title }, "还没有任务清单"),
						react.createElement("div", { key: "s", style: Object.assign({}, C.sub, { marginTop: 6 }) },
							"这份清单由 AI 用官方的 todo 工具写入（每轮自动更新）。本会话还没写过 ⇒ 没有数据，不是「0 个任务」。"),
					])),
				]));
			}

			const done = list.filter((t) => t && t.status === "completed").length;
			const pct = list.length > 0 ? Math.round((done / list.length) * 100) : 0;

			const head = react.createElement("div", { key: "head", style: C.row }, kids([
				react.createElement("span", { key: "t", style: C.title }, "任务清单"),
				react.createElement("span", { key: "c", style: C.badge }, done + " / " + list.length + " 已完成"),
				react.createElement("span", { key: "sp", style: C.grow }),
				react.createElement("span", { key: "hint", style: C.tiny }, "点条目定位到写它的那次对话"),
			]));

			const bar = react.createElement("div", { key: "bar", style: C.bar },
				react.createElement("i", { style: Object.assign({}, C.barFill, { width: pct + "%" }) }));

			let body = null;
			if (list.length === 0) {
				body = react.createElement("div", { key: "empty", style: C.card },
					react.createElement("div", { style: C.sub }, "清单是空的。"));
			} else {
				body = react.createElement("div", { key: "body", style: C.list },
					TODO_GROUPS.map((g) => {
						const rows = list.filter((t) => {
							const s = t && t.status;
							if (g.key === "pending") { return s !== "in_progress" && s !== "completed"; }
							return s === g.key;
						});
						if (rows.length === 0) { return null; }
						return react.createElement("div", { key: g.key, style: C.col }, kids([
							react.createElement("div", { key: "l", style: C.tiny }, g.label + "（" + rows.length + "）"),
							react.createElement("div", { key: "rows", style: C.col },
								rows.map((t, i) => react.createElement("div", {
									key: g.key + i,
									style: Object.assign({}, C.item, { cursor: "pointer", display: "flex", gap: 8 }),
									onClick: () => jump(t),
									title: "点击定位到写这条任务的那次对话",
								}, kids([
									react.createElement("span", { key: "m", style: C.sub }, g.mark),
									react.createElement("span", {
										key: "x",
										style: g.key === "completed"
											? Object.assign({}, C.sub, { textDecoration: "line-through", opacity: 0.7 })
											: C.grow,
									}, String((t && t.content) || "")),
								]))),
							),
						]));
					}));
			}

			const footNote = react.createElement("div", { key: "foot", style: C.tiny },
				"数据来自 dsh 会话投影（只读）；增删由 AI 的 todo 工具完成。");

			return react.createElement("div", { style: C.root, "data-vssaros-view": "todo" },
				kids([head, bar, body, footNote]));
		}

		// ══════════════════════════════════════════════════════════════════════
		// 4. 记忆设置 · Bot 那一段（工作区那一段见上方 WorkspaceSettingsPane）
		// ══════════════════════════════════════════════════════════════════════
		// 2026-11-03：AgentMemoryCard（网关记忆库卡片 + /x/memory/api/inbox 收件箱）随整套记忆体系下线移除。
		function BotSettingsPane(props) {
			const agentId = props.agentId || "";
			const url = agentId ? "/x/agents/api/memory?agent=" + encodeURIComponent(agentId) : "";
			const [state, reload] = useLoader(() => (url ? getJson(url) : Promise.resolve(null)), [url]);
			// 表单草稿：只在**首次**拿到数据时初始化（之后是用户的输入，别抢）
			const [chars, setChars] = react.useState(null);
			const [mode, setMode] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [note, setNote] = react.useState("");
			const [err, setErr] = react.useState("");
			const data = state.data;
			const limits = (data && data.limits) || {};
			// 按 **url** 记录已初始化过的对象：切 Bot 要重置表单，同一 Bot 点「刷新」不许覆盖用户正在改的值。
			const initializedFor = react.useRef("");
			react.useEffect(() => {
				if (!data || initializedFor.current === url) { return; }
				initializedFor.current = url;
				setChars(String(Number(limits.chars) || 0));
				setMode(limits.mode === "live" ? "live" : "session");
			}, [data, url]);

			if (!agentId) {
				return react.createElement("div", { style: C.card }, kids([
					react.createElement("div", { key: "t", style: C.title }, "没有可设置的 Bot"),
					react.createElement("div", { key: "s", style: Object.assign({}, C.sub, { marginTop: 6 }) },
						"Bot 记忆的口径写在 Bot 的 .agent.md 里 ⇒ 当前会话不是我们的 Bot；工作区记忆在「工作区」那一段设置。"),
				]));
			}

			const save = () => {
				const n = Number(String(chars).trim());
				if (!Number.isFinite(n) || (n !== 0 && (n < 512 || n > 20000))) {
					setErr("注入上限要是数字：0（关闭）或 512~20000 之间");
					setNote("");
					return;
				}
				setSaving(true);
				setErr("");
				setNote("");
				postJson("/x/agents/api/memory", { agent: agentId, action: "set-limits", chars: Math.trunc(n), mode })
					.then(() => {
						setNote("已保存。注入口径对**新会话**生效（当前会话的快照已冻结）。");
						reload();
					})
					.catch((e) => setErr("保存失败：" + String((e && e.message) || e)))
					.then(() => setSaving(false));
			};

			const auto = (data && data.autoCommit) || {};
			const git = (data && data.git) || {};

			const head = react.createElement("div", { key: "head", style: C.row }, kids([
				react.createElement("span", { key: "t", style: C.title }, "Bot 记忆设置"),
				react.createElement("span", { key: "b", style: C.badge }, "Bot " + agentId),
				react.createElement("span", { key: "sp", style: C.grow }),
				react.createElement("button", {
					key: "r", type: "button", style: C.btn,
					onClick: () => { reload(); },
				}, "刷新"),
			]));

			const errorNote = state.error
				? react.createElement("div", { key: "err", style: C.err }, "读取失败：" + state.error)
				: null;

			// ① 注入上限 + 模式
			const injectCard = react.createElement("div", { key: "inject", style: C.card }, kids([
				react.createElement("div", { key: "t", style: C.title }, "注入到 system prompt"),
				react.createElement("div", { key: "d", style: Object.assign({}, C.sub, { margin: "4px 0 8px" }) },
					"MEMORY.md 的前 N 个字符会拼在人设段尾部。0 = 关闭注入；范围 512~20000。"),
				react.createElement("div", { key: "row1", style: C.row }, kids([
					react.createElement("span", { key: "l", style: C.sub }, "上限"),
					react.createElement("input", {
						key: "in",
						style: Object.assign({}, C.input, { width: 90 }),
						type: "number", min: 0, max: 20000, step: 256,
						value: chars === null ? "" : chars,
						disabled: saving || !data,
						onChange: (e) => setChars(e && e.target ? e.target.value : ""),
					}),
					react.createElement("span", { key: "u", style: C.tiny }, "字符"),
					react.createElement("span", { key: "sp", style: C.grow }),
					react.createElement("button", {
						key: "save", type: "button", style: C.btnPrimary,
						disabled: saving || !data, onClick: save,
					}, saving ? "保存中…" : "保存"),
				])),
				react.createElement("div", { key: "row2", style: Object.assign({}, C.row, { marginTop: 8 }) }, kids([
					react.createElement("span", { key: "l", style: C.sub }, "模式"),
					react.createElement("button", {
						key: "session", type: "button",
						style: mode === "session" ? C.btnPrimary : C.btn,
						disabled: saving || !data,
						onClick: () => setMode("session"),
					}, "session（会话内冻结）"),
					react.createElement("button", {
						key: "live", type: "button",
						style: mode === "live" ? C.btnPrimary : C.btn,
						disabled: saving || !data,
						onClick: () => setMode("live"),
					}, "live（每轮刷新）"),
				])),
				react.createElement("div", { key: "hint", style: Object.assign({}, C.tiny, { marginTop: 6 }) },
					"session 命中 prompt 缓存（改动要新会话才生效）；live 改完下一轮就生效，但每轮都可能丢掉前缀缓存。"),
				err ? react.createElement("div", { key: "e", style: Object.assign({}, C.err, { marginTop: 6 }) }, err) : null,
				note ? react.createElement("div", { key: "n", style: Object.assign({}, C.tiny, { marginTop: 6 }) }, note) : null,
				limits.runtime
					? react.createElement("div", { key: "rt", style: Object.assign({}, C.tiny, { marginTop: 6 }) },
						"已装配：" + String(limits.runtime.chars) + " 字符 · " + String(limits.runtime.mode)
						+ " · 冻结会话 " + String(limits.runtime.frozenSessions)
						+ " · 服务 " + String(limits.runtime.served) + " 次")
					: null,
			]));

			// ② 回合末自动提交：全局可写开关（P2），与工作区记忆共用；git / turns 是这个 Bot 自己的仓库状态
			const autoCard = react.createElement(AutoCommitCard, {
				key: "auto", say: props.__vssarosSay, git, turns: auto.turns,
			});

			// ③ AgentMemory 卡已抽成 AgentMemoryCard（工作区 / Bot 两段共用，由 SettingsView 渲染一次）

			const footNote = react.createElement("div", { key: "foot", style: C.tiny },
				"每一项都写进 Bot 的 .agent.md（memory-chars / memory-mode），改完会让该 Bot 的 preset 重新注册。");

			return react.createElement("div", { style: C.col },
				kids([head, errorNote, injectCard, autoCard, footNote]));
		}

		// ══════════════════════════════════════════════════════════════════════

		/** 把 ctx / bridge / say 透给组件：槽 owner 只注入自己的标准 props（同 client.todos.js 做法）。 */
		function wrap(Comp, ctx, bridge, say) {
			return function Wrapped(props) {
				return react.createElement(Comp, Object.assign({}, props, {
					__vssarosCtx: ctx,
					__vssarosBridge: bridge,
					__vssarosSay: say,
				}));
			};
		}

		/**
		 * @param {any} ctx 插件上下文（cordis）
		 * @param {any} shell 主包传下来的外壳：{bridge,state,...}
		 */
		function install(ctx, shell) {
			const state = (shell && shell.state) || {};
			const bridge = shell && shell.bridge;
			const say = (text) => {
				try {
					if (bridge && bridge.notify) { bridge.notify("attention", text); }
				} catch { /* 通知失败不阻塞 */ }
			};
			// 2026-11-03（用户要求：两套页签合并）：「记忆 / 技能 / 待办」由内置
			// @vssaros/dsh-memory 插件提供（分层记忆 KEY.md / 项目日志 / 技能库 / 结构化待办），
			// 本外壳不再重复注册同名页签；只保留唯一的「设置」，并把 evolve 的
			// 「Vssaros Memory 设置」能力以同源 API 接进 SettingsView（见 MemoryModuleCard）。
			// ⚠ ORDERS / IDS 常量保持不变：check-chat-surface-chunks.mjs 对它们有硬断言。
			const views = [
				{ key: "settings", label: "设置", order: ORDERS.settings, Comp: SettingsView },
			];
			for (const view of views) {
				try {
					ctx.slots.inject(SLOT, () => ctx.slots.register({
						name: SLOT,
						id: IDS[view.key],
						order: view.order,
						// label 用函数：语言/文案变化时 owner 会重新求值（与官方同形）
						label: () => view.label,
						// ⚠ 条目 inject 的第一个参数是 **sessionId**（官方 chat / trajectory 同形）；
						//   这里只做"把 sessionId 递进组件"的搬运，不碰 ctx 的其它服务 ——
						//   拿不到绑定也不能抛（抛了整个页签消失 ✗）。
						inject: (sessionId) => ({ sessionId }),
					}, wrap(view.Comp, ctx, bridge, say)));
					state["vssarosConversationView_" + view.key] = true;
				} catch (e) {
					const msg = String((e && e.message) || e);
					state["vssarosConversationViewError_" + view.key] = msg;
					say("页签「" + view.label + "」挂载失败（slot " + SLOT + "）：" + msg);
				}
			}
		}

		exports.install = install;
		// 仅测试/守卫用：纯逻辑与契约常量
		exports.__test = {
			SLOT, IDS, ORDERS, OFFICIAL, WS_API,
			isAgentPreset, agentIdOf, cwdOf, isUnder, rootOptionsFor, parseMemory, sizeLabel, explainLoadError, TODO_GROUPS,
		};
		return module.exports;
	},
});
