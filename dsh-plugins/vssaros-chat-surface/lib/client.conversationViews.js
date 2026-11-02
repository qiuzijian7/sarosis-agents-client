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
//   · 记忆：真实数据只读浏览（用量 / 注入口径 / Git 状态 / 文件 / 条目）+「打开完整页」；
//   · 技能：列表 + 搜索 + 原始启用徽标（数据源 `/x/skills/api/skills`）；
//   · 待办：官方 `todos` 投影的完整清单（与 dock 那枚同一份数据，只读）；
//   · 记忆设置：注入上限 / 注入模式**可改**（走 `/x/agents/api/memory` 的 set-limits）；
//     回合末自动提交与 AgentMemory 待审数本轮**只读**（写口在下一批，见各块注释）。
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
		const MODE_PRESETS = ["standard", "ptc", "minimal", "cordis"];
		/** 官方占位（守卫会与 check-chat-surface-chunks.mjs 的 OFFICIAL_ENTRIES 对账）。 */
		const OFFICIAL = { chat: 0, trajectory: 10 };
		const ORDERS = { memory: 20, skills: 30, todo: 40, settings: 50 };
		const IDS = {
			memory: "vssaros-memory",
			skills: "vssaros-skills",
			todo: "vssaros-todo",
			settings: "vssaros-memory-settings",
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
			const id = String(presetId || "");
			return id.startsWith(VSSAROS_PREFIX) && MODE_PRESETS.indexOf(id.slice(VSSAROS_PREFIX.length)) < 0;
		}

		/** 会话 → agentId（`vssaros-<id>` 的 preset）；取不到返回空串（调用方必须显式处理）。 */
		function agentIdOf(ctx, sessionId) {
			try {
				const list = ctx && ctx.sessions && ctx.sessions.list;
				const snap = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : null;
				const summary = sessionId && snap && snap.byId ? snap.byId[sessionId] : undefined;
				const presetId = summary && summary.projectionValues && summary.projectionValues.agentPreset;
				return isAgentPreset(presetId) ? String(presetId).slice(VSSAROS_PREFIX.length) : "";
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

		// ══════════════════════════════════════════════════════════════════════
		// 1. 记忆
		// ══════════════════════════════════════════════════════════════════════
		function MemoryView(props) {
			const ctx = props.__vssarosCtx;
			const bridge = props.__vssarosBridge;
			const say = props.__vssarosSay;
			const sessionId = props.sessionId || "";
			useSessionsTick(ctx);
			const agentId = agentIdOf(ctx, sessionId);
			const [file, setFile] = react.useState("MEMORY.md");
			const url = agentId
				? "/x/agents/api/memory?agent=" + encodeURIComponent(agentId) + "&file=" + encodeURIComponent(file)
				: "";
			const [state, reload] = useLoader(() => (url ? getJson(url) : Promise.resolve(null)), [url]);

			if (!agentId) {
				return react.createElement("div", { style: C.root }, kids([
					react.createElement("div", { key: "card", style: C.card }, kids([
						react.createElement("div", { key: "t", style: C.title }, "记忆按 Bot 隔离"),
						react.createElement("div", { key: "s", style: Object.assign({}, C.sub, { marginTop: 6 }) },
							"当前会话没有关联我们的 Bot（preset 不是 vssaros-*）⇒ 没有对应的记忆目录。"),
						react.createElement("div", { key: "h", style: Object.assign({}, C.tiny, { marginTop: 6 }) },
							"在「Bot 设置」里给会话换一个 Bot，或从 Bots 列表新建一个会话再回来。"),
					])),
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
				react.createElement("span", { key: "t", style: C.title }, "记忆"),
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
				"只读预览（写入走完整页 / 文件工具）。改动在**新会话**生效：当前会话的快照已冻结以保证 prompt 缓存命中。");

			return react.createElement("div", { style: C.root, "data-vssaros-view": "memory" },
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
		// 4. 记忆设置
		// ══════════════════════════════════════════════════════════════════════
		function SettingsView(props) {
			const ctx = props.__vssarosCtx;
			const bridge = props.__vssarosBridge;
			const say = props.__vssarosSay;
			const sessionId = props.sessionId || "";
			useSessionsTick(ctx);
			const agentId = agentIdOf(ctx, sessionId);
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

			// 待审草稿数（vssaros-memory 的收件箱；网关离线时如实显示读不到）
			const [inbox, reloadInbox] = useLoader(
				() => getJson("/x/memory/api/inbox").catch((e) => ({ __error: String((e && e.message) || e) })),
				[],
			);
			const inboxData = inbox.data;
			const inboxError = (inboxData && inboxData.__error) || inbox.error || "";
			const pending = inboxData && inboxData.counts && Number.isFinite(Number(inboxData.counts.pending))
				? Number(inboxData.counts.pending)
				: null;

			if (!agentId) {
				return react.createElement("div", { style: C.root }, kids([
					react.createElement("div", { key: "card", style: C.card }, kids([
						react.createElement("div", { key: "t", style: C.title }, "没有可设置的 Bot"),
						react.createElement("div", { key: "s", style: Object.assign({}, C.sub, { marginTop: 6 }) },
							"记忆口径按 Bot 存（写在 Bot 的 .agent.md 里）⇒ 当前会话不是我们的 Bot，没有可改的项。"),
					])),
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
				react.createElement("span", { key: "t", style: C.title }, "记忆设置"),
				react.createElement("span", { key: "b", style: C.badge }, "Bot " + agentId),
				react.createElement("span", { key: "sp", style: C.grow }),
				react.createElement("button", {
					key: "r", type: "button", style: C.btn,
					onClick: () => { reload(); reloadInbox(); },
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

			// ② 回合末自动提交（本轮只读 —— 写口要落 Host 侧偏好，下一批接）
			const autoCard = react.createElement("div", { key: "auto", style: C.card }, kids([
				react.createElement("div", { key: "r", style: C.row }, kids([
					react.createElement("span", { key: "t", style: C.title }, "回合末自动提交快照"),
					react.createElement("span", { key: "s", style: auto.on ? C.badgeOn : C.badge }, auto.on ? "开" : "关"),
					react.createElement("span", { key: "sp", style: C.grow }),
					git.enabled
						? react.createElement("span", { key: "c", style: C.badge }, "已提交 " + (Number(auto.turns) || 0) + " 次")
						: null,
				])),
				react.createElement("div", { key: "d", style: Object.assign({}, C.sub, { marginTop: 4 }) },
					git.enabled
						? ("当前未提交 " + (Number(git.dirty) || 0) + " 个文件。开启后每个回合结束自动落一条提交，演化图才有真实节奏。")
						: "记忆目录还没 Git 化 ⇒ 没有可提交的历史（在「完整页」里启用）。"),
				react.createElement("div", { key: "h", style: Object.assign({}, C.tiny, { marginTop: 4 }) },
					"开关在插件 patch 的 memoryAutoCommit（默认开）；本轮先只读展示，写口在下一批。"),
			]));

			// ③ AgentMemory（网关记忆库）
			const amCard = react.createElement("div", { key: "am", style: C.card }, kids([
				react.createElement("div", { key: "r", style: C.row }, kids([
					react.createElement("span", { key: "t", style: C.title }, "AgentMemory 记忆库"),
					pending === null
						? react.createElement("span", { key: "p", style: C.badge }, "待审数未知")
						: react.createElement("span", { key: "p", style: pending > 0 ? C.badgeOn : C.badge }, "待审草稿 " + pending),
					react.createElement("span", { key: "sp", style: C.grow }),
					react.createElement("button", {
						key: "open", type: "button", style: C.btn,
						onClick: () => openPage(bridge, "/x/memory/", say),
					}, "打开记忆库"),
				])),
				inboxError
					? react.createElement("div", { key: "e", style: Object.assign({}, C.err, { marginTop: 4 }) }, "读取收件箱失败：" + inboxError)
					: null,
				react.createElement("div", { key: "d", style: Object.assign({}, C.sub, { marginTop: 4 }) },
					"网关记忆库（向量 / BM25 / 图谱检索）与本页的 MEMORY.md 是两套：前者靠 memory_* 工具按需检索，后者常驻注入。"),
				react.createElement("div", { key: "h", style: Object.assign({}, C.tiny, { marginTop: 4 }) },
					"注入开关在 IDE 设置 agentStudio.memory.injectContext（默认关）；待审草稿在记忆库的收件箱里逐条采纳。"),
			]));

			const footNote = react.createElement("div", { key: "foot", style: C.tiny },
				"每一项都写进 Bot 的 .agent.md（memory-chars / memory-mode），改完会让该 Bot 的 preset 重新注册。");

			return react.createElement("div", { style: C.root, "data-vssaros-view": "memory-settings" },
				kids([head, errorNote, injectCard, autoCard, amCard, footNote]));
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
			const views = [
				{ key: "memory", label: "记忆", order: ORDERS.memory, Comp: MemoryView },
				{ key: "skills", label: "技能", order: ORDERS.skills, Comp: SkillsView },
				{ key: "todo", label: "待办", order: ORDERS.todo, Comp: TodoView },
				{ key: "settings", label: "记忆设置", order: ORDERS.settings, Comp: SettingsView },
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
			SLOT, IDS, ORDERS, OFFICIAL,
			isAgentPreset, agentIdOf, parseMemory, sizeLabel, TODO_GROUPS,
		};
		return module.exports;
	},
});
