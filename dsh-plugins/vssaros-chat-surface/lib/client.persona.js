// @vssaros/dsh-chat-surface — 「人格（本会话）」的**数据与动作**（package-local chunk）。
// 主包 lib/client.js 用 require.async("./client.persona.js") 取回本模块的 install()。
// ⚠ 2026-10-17 方案 C 起：**不再自己出 chip / 面板**（并入 `client.agents.js` 的 Agent chip +
//   AgentsPanel，见下方 install() 里的 kit 段）；本 chunk 只负责读人格、切人格、清除、发布 dataset 事实。
//
// ── 语义定稿（2026-10-11；依据 `poc/dsh-p0/README.md` 4.40 与"agent vs 人格"边界调研）──────────
//   两档语义**必须分开呈现**，因为它们改的东西不同：
//
//   ① **换人格（本会话）**（本 chunk）= 只改**提示词人设**：
//      留在当前会话（历史保留）、工具/模型/skills 不变、切换事实落 dsh 已登记事件（可重放）。
//      实现：`@vssaros/dsh-agents` 的 `POST /x/agents/api/persona`（聊天页与它**同源**，
//      直接 fetch；不经 IDE/宿主，也不新建会话/视图）。
//
//   ② **换 Agent（新会话）**（Agents 面板）= 换 preset **组合**：
//      切到该 Agent 的专属会话（`vssaros-chat-<chatId>--<presetId>`，历史各自独立，切回可见原对话）、
//      工具/模型可能一起变。本 chunk **不重复实现**，只做文案提示与入口指引
//      （同一个概念一个入口：那个人口归 Agents 面板）。
//
//   ⚠ 为什么 chip 要**条件渲染**：人设段（`vssaros-agent-persona`）只注册在 VsSaros 自己的 preset
//   作用域里。在 `standard` 这类 dsh 自带 preset 上"切人格"不会有任何可观测变化 ⇒ 那会**误导**用户。
//   判据用读接口的 `rendered` 字段（它由插件在**当前 preset 作用域**装配一次提示词后才会有）——
//   比读 `agentPreset` 投影更准：它直接说明"这个会话里人格段真的存在"。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.persona.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const SLOT_CHIP = "conversation.input.left";
		const SLOT_PANEL = "conversation.input.overlay";
		const CHIP_ID = "vssaros-persona-chip";
		const PANEL_ID = "vssaros-persona-panel";
		const MENU_ID = "vssaros-persona";
		/** 插件侧接口（与聊天页同源；见 `@vssaros/dsh-agents` 的 /x/agents 路由）。 */
		const API_PERSONA = "/x/agents/api/persona";
		const API_AGENTS = "/x/agents/api/agents";

		/** 两档语义的用户可见说明（文案规范落地处；改文案先改这里）。 */
		const HINT_PERSONA = "只改提示词人设：留在当前会话（历史保留），工具与模型不变。";
		const HINT_AGENT = "要换工具/模型（换 Agent）请用 Agents 面板——那会切到它的专属会话，历史各自独立。";
		const FOLLOW_LABEL = "跟随 Agent 自带人设";

		/** fetch 包装：拿 status + 解析后的 body（失败也返回，不抛）。 */
		const call = (path, init) => Promise.resolve()
			.then(() => fetch(path, init))
			.then(async (res) => {
				const text = await res.text();
				let body;
				try { body = JSON.parse(text); } catch { body = text; }
				return { status: res.status, ok: res.ok, body };
			}, (e) => ({ status: -1, ok: false, body: String((e && e.message) || e) }));

		const personaApi = (sid) => call(API_PERSONA + "?sessionId=" + encodeURIComponent(sid));
		const switchApi = (sid, personaId) => call(API_PERSONA, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(personaId === null ? { sessionId: sid, clear: true } : { sessionId: sid, personaId }),
		});

		/**
		 * 极简 store（与 client.agents.js 同形）：只在本 chunk 内共享，菜单互斥由 shell.menus 管。
		 */
		function createStore() {
			const listeners = new Set();
			const store = {
				open: false,
				error: null,
				busy: false,
				/** 当前人格 `{ personaId, name, atSeq, rendered }`；`null` = 还没读到或会话不在运行。 */
				current: null,
				/** 该会话是否"人设段真的存在"（= 跑的是 VsSaros agent）：undefined 未探明 / true / false。 */
				applicable: undefined,
				agents: [],
				subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
				emit() { for (const fn of [...listeners]) { try { fn(); } catch { /* 单个订阅者出错不影响其它 */ } } },
				set(patch) { Object.assign(store, patch); store.emit(); },
			};
			return store;
		}

		/**
		 * 把「本会话人格」发布成 **DOM 事实**（`dataset.vssarosSessionPersona`）—— 供 VsSaros 侧的历史会话
		 * sideview 显示人格标记（`sessionHistoryView.personaBySession`）。
		 *
		 * 为什么走 DOM 事实、而不是页↔宿主协议：**那条协议正被另一条改动流重构**
		 * （`client.sessionLabel.js:5` 的原话），而且协议侧 `validatePageCommand`
		 * 漏一个 case 会让整条命令被**静默丢弃**（页面点了没反应、日志里也什么都没有）。
		 * 于是沿用 `dataset.vssarosSessionTitle`（sessionLabel）的既有先例：同通道、同纪律 ——
		 * **尽力而为，写不进去不影响页面自身**。
		 *
		 * 载荷 `{sessionId, personaId, name, applicable}`：
		 *  · `sessionId` = dsh 会话 id ⇒ 宿主拿它 join 自己的槽位事实，才能落到壳侧的 `agentId::sessionId` 键；
		 *  · `personaId === null` = **跟随 Agent 自带人设**（这是挂载期的事实，不是"未知"）
		 *    ⇒ 宿主据此**删掉**壳侧该键，否则旧 chip 会一直挂着；
		 *  · `applicable === false` = 本 preset 里根本没有"人设段"（如 dsh 自带的 `standard`）
		 *    ⇒ 这时切人格没有任何可观测变化，宿主也不该显示标记。
		 *
		 * 只在**变化时**写（`refresh` 会被挂载 / 重绑反复调用）。
		 *
		 * ⚠ **宿主侧那一半尚未接通**（本文件只负责发布）：宿主需像读标题那样读这个 dataset，
		 * 按 `sessionId` 解析出壳侧的 `agentId::sessionId`，再写 `sessionHistoryView.personaBySession`
		 * （PROFILE/USER；pane 已按该键渲染，见 `sessionHistoryView.ts:1812`）。
		 */
		// ⚠ `state` 必须**当参数传进来**：本函数定义在 `install()` 之外（模块作用域），那里没有 `state`
		// —— 2026-10-12 实测它在页面里抛 `Uncaught (in promise) ReferenceError: state is not defined`
		// （宿主日志 `page console(error) … client.persona.js:112`，由本轮的 console 采集抓到）✗。
		const publishPersonaFact = (state, sid, body, applicable, bridge) => {
			const fact = {
				sessionId: sid,
				personaId: body && typeof body.personaId === "string" && body.personaId ? body.personaId : null,
				name: body && typeof body.name === "string" && body.name ? body.name : null,
				applicable: applicable === true,
			};
			const text = JSON.stringify(fact);
			if (text === state.personaFactReported) { return; }
			state.personaFactReported = text;
			try {
				document.documentElement.dataset.vssarosSessionPersona = text;
			} catch { /* DOM 事实尽力而为：写不进去不影响面板本身的渲染 */ }
			// 上报宿主（preload 桥 `sessionPersona`）：宿主才知道**壳侧的会话身份**，由它写 sideview 读的那个键。
			// 与 sessionLabel 同口径：老桥没这个方法就静默跳过 —— dataset 仍作为兜底事实存在。
			try {
				if (bridge && typeof bridge.sessionPersona === "function") { bridge.sessionPersona(fact.personaId, fact.name, fact.applicable); }
			} catch { /* 上报失败不回灌面板状态 */ }
		};

		function install(ctx, shell) {
			const { state, bridge, menus } = shell;
			const store = createStore();

			/** 读当前人格 + 探"本会话是否适用"（`rendered` 有值 ⇒ 人设段在该 preset 作用域里存在）。 */
			const refresh = (sid) => {
				if (!sid) { store.set({ current: null, applicable: false }); return Promise.resolve(null); }
				return personaApi(sid).then((r) => {
					if (r.status !== 200 || !r.body || typeof r.body !== "object") {
						// 读失败 ⇒ **不动**已发布的事实（一次瞬时的读取失败不该把已知事实抹成未知）。
						store.set({ current: null, applicable: false, error: r.status === 200 ? null : String(r.body).slice(0, 160) });
						return null;
					}
					const applicable = !!(r.body.rendered && typeof r.body.rendered.head === "string");
					store.set({ current: { personaId: r.body.personaId ?? null, name: r.body.name ?? null, atSeq: r.body.atSeq ?? -1, rendered: r.body.rendered }, applicable, error: null });
					publishPersonaFact(state, sid, r.body, applicable, bridge);
					return r.body;
				});
			};
			const loadAgents = () => call(API_AGENTS).then((r) => {
				const list = r.status === 200 && r.body && Array.isArray(r.body.agents) ? r.body.agents : [];
				store.set({ agents: list.filter((a) => a && a.id && a.registered !== false) });
				return store.agents;
			}, () => store.set({ agents: [] }));

			const doSwitch = (personaId) => {
				const sid = state.sessionId;
				if (!sid) { store.set({ error: "没有绑定的会话" }); return; }
				store.set({ busy: true, error: null });
				switchApi(sid, personaId).then((r) => {
					if (r.status !== 200) {
						store.set({ busy: false, error: String(r.body).slice(0, 200) || ("HTTP " + r.status) });
						return;
					}
					store.set({ busy: false, open: false });
					menus.register(MENU_ID, null);
					if (bridge && bridge.notify) {
						const name = r.body && r.body.name ? r.body.name : FOLLOW_LABEL;
						bridge.notify("info", "人格已切换（本会话）：" + name + "　·　工具与模型不变");
					}
					return refresh(sid);
				});
			};

			// 会话重绑（切 preset/打开历史会话）后重探。**读事件 detail**，不读 state.sessionId：
			// shell 自己也在听这个事件（它负责写 state.sessionId），谁先注册不确定 ⇒ 读自己带的值才稳。
			document.addEventListener("vssaros-dsh-rebind", (e) => {
				const sid = e && e.detail && typeof e.detail.sessionId === "string" ? e.detail.sessionId : state.sessionId;
				void refresh(sid);
			});
			void refresh(state.sessionId);

			// ── 方案 C（2026-10-17 用户拍板）：chip 与面板 **合并进 Agent chip / AgentsPanel** ────────
			// 依据：两颗 chip 实际在做同一件事 —— 都走 `POST /x/agents/api/persona` 换**本会话人格**：
			//   · agent chip 报"这条会话是谁"（agent 名 / 已切换的人格名）
			//   · persona chip 报"人格是否被覆盖"（默认 = 跟随 Agent 自带人设）
			// 合并后只有一颗 `P PPT 专家 · 人格默认 ▾`（由 `client.agents.js` 的 AgentChip 渲染，
			// 面板 = 它的 AgentsPanel，其中人格段带 `data-vssaros-persona-*` 属性契约）。
			// ⇒ 本 chunk 继续负责**数据与动作**（读人格、切人格、清除、发布 dataset 事实），不再自己出 UI。
			// ⚠ 属性契约**保持原样**（合并 chip 继承 `data-vssaros-persona-chip*`；AgentsPanel 的人格段
			//   继承 `data-vssaros-persona-panel / -item / -clear`）⇒ 真机 e2e 的 persona UI 一段无需改 ✓。
			// 回滚：删掉下面这段 kit，并恢复文件末尾被注释掉的两个 `ctx.slots.inject` 即可。
			try {
				state.vssarosPersona = {
					store,
					refresh,
					loadAgents,
					clear: () => doSwitch(null),
					switchTo: (id) => doSwitch(id),
					/** 合并 chip 的文案片段：`· 人格默认` / `· <人格名>`（不适用时为空串）。 */
					suffixLabel: () => {
						if (store.applicable !== true) { return ""; }
						const cur = store.current;
						return " · " + (cur && cur.personaId ? (cur.name || cur.personaId) : "人格默认");
					},
					FOLLOW_LABEL, HINT_PERSONA, HINT_AGENT,
				};
				state.personaMerged = true;
				state.personaChip = false;
				state.personaPanel = false;
			} catch (e) {
				state.personaKitError = String((e && e.message) || e);
			}

			/** 输入框 chip：只有"本会话人设段存在"时才出现（否则会误导）。 */
			function PersonaChip(props) {
				const sid = (props && props.sessionId) || state.sessionId;
				const [, force] = react.useState(0);
				react.useEffect(() => store.subscribe(() => force((n) => n + 1)), []);
				react.useEffect(() => { void refresh(sid); }, [sid]);
				if (!sid || store.applicable !== true) { return null; }
				const current = store.current;
				const label = current && current.name ? current.name : FOLLOW_LABEL;
				return react.createElement("span", {
					"data-vssaros-persona-chip": "1",
					"data-vssaros-persona-current": current && current.personaId ? current.personaId : "",
					style: {
						display: "inline-flex", alignItems: "center", gap: 5, height: 22, padding: "0 8px",
						borderRadius: 999, border: "1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.18))",
						background: "transparent", color: "var(--dsw-alias-label-secondary, currentColor)",
						fontSize: 11.5, whiteSpace: "nowrap",
					},
				},
					react.createElement("button", {
						key: "b", type: "button", title: "换人格（本会话）—— 只改人设，工具与模型不变",
						"data-vssaros-persona-chip-open": "1",
						onClick: () => { menus.closeOthers(MENU_ID); menus.register(MENU_ID, () => store.set({ open: false })); store.set({ open: true }); void loadAgents(); },
						style: { display: "inline-flex", alignItems: "center", gap: 5, border: 0, background: "transparent", color: "inherit", fontSize: 11.5, cursor: "pointer", padding: 0 },
					},
						react.createElement("span", { key: "i", style: { color: "#7ad0a5", fontSize: 12 } }, "✦"),
						"人格：" + label,
					),
				);
			}

			/** 面板（self-drawn，挂在 composer 的 overlay 槽；与 Agents 面板靠 shell.menus 互斥）。 */
			function PersonaPanel(props) {
				const sid = (props && props.sessionId) || state.sessionId;
				const [, force] = react.useState(0);
				react.useEffect(() => store.subscribe(() => force((n) => n + 1)), []);
				if (!store.open || store.applicable !== true) { return null; }
				const currentId = store.current && store.current.personaId ? store.current.personaId : null;
				const row = (a) => react.createElement("button", {
					key: "p-" + a.id, type: "button", disabled: store.busy,
					"data-vssaros-persona-item": a.id,
					onClick: () => doSwitch(a.id),
					style: {
						display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
						padding: "7px 9px", border: 0, borderTop: "1px solid var(--dsw-alias-border-l1, transparent)",
						background: "transparent", color: "var(--dsw-alias-label-primary, currentColor)",
						fontSize: 12.5, cursor: "pointer",
					},
				},
					react.createElement("span", { key: "n", style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, a.name || a.id),
					a.id === currentId ? react.createElement("span", { key: "c", style: { color: "var(--dsw-alias-brand-primary, #4c9aff)" } }, "✓ 当前") : null,
				);
				const clearRow = react.createElement("button", {
					key: "clear", type: "button", disabled: store.busy || currentId === null,
					"data-vssaros-persona-clear": "1",
					onClick: () => doSwitch(null),
					style: {
						display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
						padding: "7px 9px", border: 0, borderTop: "1px solid var(--dsw-alias-border-l1, transparent)",
						background: "transparent", color: "var(--dsw-alias-label-secondary, currentColor)",
						fontSize: 12.5, cursor: currentId === null ? "default" : "pointer",
					},
				}, FOLLOW_LABEL);
				const hint = (text, key) => react.createElement("div", {
					key, style: { padding: "6px 9px", color: "var(--dsw-alias-label-secondary, #999)", fontSize: 11, lineHeight: 1.45, borderTop: "1px solid var(--dsw-alias-border-l1, transparent)" },
				}, text);
				return react.createElement("div", {
					"data-vssaros-persona-panel": "1",
					style: Object.assign({
						position: "absolute", bottom: "calc(100% + 6px)", left: 0, zIndex: 30,
						background: "var(--dsw-alias-bg-overlay, #23252b)", border: "1px solid var(--dsw-alias-border-l1, #3a3d45)",
						borderRadius: 8, boxShadow: "0 6px 24px rgba(0,0,0,.35)", padding: "4px 0",
						// ⚠ 向上展开（`bottom:100%`）⇒ fitMenu 那个"整页 − 72"的高度在这里**不成立**
						//   （它假定菜单从页面顶部往下长）⇒ 必须给确定上限，否则面板顶部会落到视口外且滚不到 ✗；
						//   这一句同理要排在 fitMenu **之后**（见 client.agents.js 的注释 ✓）。
						}, shell.fitMenu(), { maxHeight: 320 }),
				},
					react.createElement("div", {
						key: "head", style: { padding: "7px 9px 5px", fontSize: 11, letterSpacing: ".02em", color: "var(--dsw-alias-label-secondary, #999)" },
					}, "人格 · 本会话（工具与模型不变）"),
					...store.agents.map(row),
					clearRow,
					hint(HINT_PERSONA, "h1"),
					hint(HINT_AGENT, "h2"),
					store.error ? hint("⚠ " + store.error, "err") : null,
				);
			}

			// ⚠ 方案 C 起**不再注册**这两块 UI（人格 chip / 人格面板）：
			//   · chip 合并进 `client.agents.js` 的 AgentChip（属性 `data-vssaros-persona-chip*` 由它继承）
			//   · 面板合并进它的 AgentsPanel（人格段带 `data-vssaros-persona-panel/-item/-clear`）
			//   上面两个组件实现**保留**（未注册）以便回滚：把这两段注册恢复、删掉 kit 段即可。
			//   `state.personaMerged === true` 时，页面自证里 `personaChip=false` 属**预期**，不是故障。
			state.personaChipError = state.personaChipError || undefined;
			state.personaPanelError = state.personaPanelError || undefined;
		}
		exports.install = install;
		// 仅测试用：纯逻辑（两档文案/接口拼装）。
		exports.__test = { HINT_PERSONA, HINT_AGENT, FOLLOW_LABEL, createStore };
		return module.exports;
	},
});
