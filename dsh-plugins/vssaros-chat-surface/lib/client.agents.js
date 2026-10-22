// @vssaros/dsh-chat-surface — 「+」菜单新增 **Agents** 行 + Agents 选择面板 + 输入框 agent chip
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async("./client.agents.js") 取回本模块的 install()。
//
// ── 设计定稿（2026-10-11，方案① / 会话级 / 商城不独立分组）────────────────────────
//   ① 「+」菜单里加一行 Agents：走 ui-commands 的**贡献行** API —— `ctx.commandUi.register(contribution)`
//      （服务 `CommandUiRuntime`，`dsh-client-ui-commands/lib/client.js:751/771/816`）。
//      菜单候选 = **官方命令目录 + contributions**（同文件 `:909-918`）⇒ `+` 菜单与手打 `/` 都会出现 ✓。
//      行名（`vssaros-agents`）不得与官方命令名撞：文档说明"与 host 命令重名会在候选合成时 **fail loud**"；
//      行名不在 `SECTION_ROWS` 里 ⇒ 自动归入 **Commands 段**（`sectionRows` `:711-724`，落在 Export 之后）。
//
//      ⚠ **走过的错路（别再回去）**：先用了 `ctx.inputTriggers.registerSource({ trigger: "/" })` ——
//      打 `/` 能看到，但 **`+` 菜单永远看不到**：加号是 `inputTriggers.toggleSource("command", …)`，
//      **只开官方那一个源**（`dsh-client-ui-conversation/lib/client.js:18410`）⇒ 第三方源进不去 ✗
//      （用户实测截图："commands 中缺少 agents 项"）。
//
//   ② 选择列表用**官方 popup**（`ui.kind = "popupSelect"`），不自绘：
//      官方 popup **自带搜索框**（`ui-commands:1340` `popup.setSearch`，文案可由 `searchLabels` 定制 ✓），
//      而 `SelectOption` 原生支持 `group`（分组标题）/`detail`（副文本）/`active`（打开时高亮停靠 = 当前 Agent）
//      ⇒ 我们要的列表形态官方全有（`lib/types/client/contract.d.ts` 的 `PopupSelectSpec`/`SelectOption`）。
//      ⚠ 也**不是**官方 drill：drill 会给行硬加 "进入目录 / Tab" 提示（`input-trigger:1174-1195`，那是给
//      `@` 目录选择器写的文案）✗。
//      自绘那套（`conversation.input.overlay` 里的面板）只留给 **chip 点击** 用（chip 不在菜单里，
//      没有 command token 可承载官方 popup）。
//
//   ③ 输入框 chip 挂 `conversation.input.left`：官方工具行的 DOM 顺序是
//      `[permission][plan]` → `input.left` → （右侧）`[input.right][input.model]`
//      （`dsh-client-ui-conversation/lib/client.js:17520-17532`）⇒ 本槽天然就在 **permission 下拉框右侧**。
//      permission 自己是 **single** 槽（`conversation.input.permission`），不能并列，所以这才是正解。
//
//   ④ **会话级**语义：选中/清除都走页面桥 `switchPreset(id)`（宿主 rebind 到该 preset 的专属会话），
//      复用 `client.preset.js` 验证过的通路 —— 不新开协议、不新造状态。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.agents.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		/** dsh 自带 preset（无 `vssaros-` 前缀）；用于分组显示。 */
		const BUILTIN_PRESETS = ["standard", "ptc", "minimal", "cordis"];
		/** VsSaros agent 的 preset id 前缀（见 `vssaros-agents/lib/core/agents.js` 的 PRESET_ID_PREFIX）。 */
		const VSSAROS_PREFIX = "vssaros-";
/**
 * 委派专用 preset（`vssaros-<id>-assign`）：由 agents 插件的 `model-assignment` 派生，
 * 与本体同人格、只换模型 ⇒ **不进用户可见的花名册 / 选择器**（否则像"凭空多了一个 agent"）。
 * 口径与 `vssaros-agents/lib/core/agents.js assignmentPresetIdOf` 保持一致（后缀 `-assign`）。
 */
const ASSIGN_PRESET_RE = /^vssaros-.+-assign$/;

/**
 * 用户可见的 agent preset 集合 —— **唯一真源是插件的 `/api/agents`**（它按内置白名单过滤）。
 *
 * 为什么不在前端抄一份白名单：内置 agent 的取舍会变（哪天又要把某个内置放出来），抄两份必然漂。
 * 缓存 60s（花名册打开/切会话都会用到，别每次都打一个请求）；任何失败（404/网络/无 fetch 的
 * 单测环境）都返回 `null` ⇒ 调用方**原样展示**（fail-open：宁可多列，也不把用户自己的 agent 藏掉）。
 */
let visiblePresetsCache = { at: 0, ids: null };
const loadVisiblePresetIds = () => {
	const now = Date.now();
	if (visiblePresetsCache.ids && now - visiblePresetsCache.at < 60_000) {
		return Promise.resolve(visiblePresetsCache.ids);
	}
	if (typeof fetch !== "function") { return Promise.resolve(null); }
	try {
		return fetch("/x/agents/api/agents", { headers: { accept: "application/json" } })
			.then((r) => (r && r.ok ? r.json() : null))
			.then((data) => {
				const list = data && Array.isArray(data.agents) ? data.agents : null;
				if (!list) { return null; }
				const ids = new Set(list.map((a) => VSSAROS_PREFIX + String((a && a.id) || "")));
				visiblePresetsCache = { at: Date.now(), ids };
				return ids;
			})
			.catch(() => null);
	} catch (e) {
		return Promise.resolve(null);
	}
};
		/** 清除 chip 时切回的基座 preset（会话 id 后缀 = preset，基座即无后缀会话）。 */
		const BASE_PRESET = "standard";
		/** 菜单行名：必须唯一且不与官方命令名冲突（见文件头 ①）。 */
		const ROW_NAME = "vssaros-agents";
		/** 空态提示行的 id（不是 preset ⇒ 选中它只解释原因，不切会话）。 */
		const HINT_ID = "__vssaros-agents-hint__";
		/** 菜单互斥用 id（见 client.js 的 createMenuCoordinator）。 */
		const MENU_ID = "vssaros-agents";
		const SLOT_CHIP = "conversation.input.left";
		const SLOT_PANEL = "conversation.input.overlay";
		const SLOT_HEADER = "conversation.session.header.actions";
		/**
		 * 人格路由读失败时的**重试**上限与间隔（2026-10-13 用户报"人格读取失败"）。
		 *
		 * 为什么必须重试：页面挂载常常早于会话注册进 Host 的 `state.agents` ⇒ 路由回 `会话不在运行：<id>`（400 ✓），
		 * 那是**时序**而不是故障 ✗。上限 8 次 × 1.5s ≈ 12s，够 agent 注册完；之后仍失败就照实报一次 ✓。
		 * （间隔可用 `shell.personaRetryMs` 注入 ⇒ 单测不必等真定时器 ✓）
		 */
		const PERSONA_PROBE_MAX_RETRIES = 8;
		const PERSONA_PROBE_RETRY_MS = 1500;

		/**
		 * 读失败是否**时序性**（= 稍后会好，不该报成"不可达/未授权"✗）。
		 * 反面：401/403（真未授权）、404（路由真不在）⇒ 不重试、直接照实报 ✓。
		 */
		const isTransientPersonaError = (err) => /会话不在运行|Failed to fetch|NetworkError|ECONNREFUSED|fetch failed|unavailable/i.test(String(err || ""));

		/**
		 * 人格热切换的请求体（纯函数）。
		 *
		 * ⚠ 必须留在 **factory 层**：`exports.__test` 在 install 之外引用它（`install` 内的局部 const
		 * 在那里不可见 ⇒ 整块求值抛 ReferenceError、后续注册全不执行 —— 实测踩过，9 条用例级联红 ✗）。
		 */
		const personaRequest = (sid, presetId) => ({ sessionId: String(sid || ""), presetId: String(presetId || "") });

		/** 分组与来源徽标：vssaros- 前缀 = 我们的 agent（本地目录 / 商城下载**同一目录**，故不独立分组，只打徽标）。 */
		function sourceOf(preset) {
			const id = String((preset && preset.id) || "");
			if (id.startsWith(VSSAROS_PREFIX)) { return BUILTIN_PRESETS.includes(id) ? "builtin" : "mine"; }
			return BUILTIN_PRESETS.includes(id) ? "builtin" : "builtin";
		}
		function rowLabel(preset) {
			return String((preset && (preset.name || preset.id)) || "");
		}
		function rowKey(preset) {
			return String((preset && preset.id) || "");
		}
		/** 当前会话的 preset（宿主推来的 projection；与 client.preset.js 同一判据）。 */
		function currentPreset(summary) {
			const v = summary && summary.projectionValues && summary.projectionValues.agentPreset;
			return typeof v === "string" && v ? v : undefined;
		}
		/**
		 * 从官方注入的 CSS 里认出 preset 标签的**模块类名**（形如 `SVAs4q_label`）。
		 *
		 * 为什么要现读而不是硬编码：CSS-module 的哈希前缀随 dsh 版本变（`SVAs4q_` 是 0.2.0-rc.2 的值），
		 * 硬编码会在升级后**静默失效** —— 要么藏不掉 agent 名、要么把别的元素一起藏了 ✗。
		 * 官方是把 `AgentPresetLabel.module.css` 作为 `<style data-plugin-css="…/AgentPresetLabel.module.css">`
		 * 注入的（见该包 `client.js:325-334`），所以我们从 `data-plugin-css` 认它、再从 CSS 文本里取类名 ✓。
		 */
		function findOfficialPresetLabelClass(doc) {
			try {
				if (!doc || typeof doc.querySelectorAll !== "function") { return null; }
				const styles = doc.querySelectorAll("style[data-plugin-css]");
				for (const s of styles) {
					const id = (s && s.dataset && s.dataset.pluginCss) || "";
					if (String(id).indexOf("AgentPresetLabel") < 0) { continue; }
					const m = /\.([A-Za-z0-9_-]+_label)\b/.exec(String(s.textContent || ""));
					if (m) { return m[1]; }
				}
			} catch { /* 取不到就当没有（调用方会退回自绘标签） */ }
			return null;
		}

		/** 隐藏官方标签的规则（纯函数，便于断言）：只在"当前跑的是我们的 agent"时生效。 */
		function presetLabelHideCss(labelClass) {
			return "body[data-vssaros-agent-preset=\"1\"] ." + labelClass + "{display:none!important}";
		}

		/** 关键词过滤（名字 / id / 描述）。 */
		function matches(preset, query) {
			if (!query) { return true; }
			const q = query.toLowerCase();
			return [preset && preset.id, preset && preset.name, preset && preset.description]
				.filter(Boolean).join(" ").toLowerCase().includes(q);
		}

		/** 极小的订阅式 store：触发菜单的 onPick 与浮层/chip 之间通信（避免模块级可变状态）。 */
		function createStore() {
			let open = false;
			const listeners = new Set();
			const emit = () => { listeners.forEach((fn) => { try { fn(); } catch { /* 单个订阅者异常不影响其它 */ } }); };
			return {
				isOpen: () => open,
				setOpen(next) { if (open !== next) { open = next; emit(); } },
				subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
			};
		}

		function install(ctx, shell) {
			const state = shell.state;
			const bridge = shell.bridge;
			const store = createStore();
			// 面板开合状态的把手（诊断 + 单测用）：挂到 state 上，便于探针/测试在不渲染 chip 的情况下
			// 直接开面板（假 React 会把 chip 与面板的 hook 槽共享 ⇒ 两个组件同 harness 渲染会互相污染）。
			state.agentsPanelStore = store;

			/**
			 * Agents 行图标（菜单行 `icon` 字段）。
			 *
			 * 为什么自己画：菜单行的图标有两条分支（`input-trigger:1154-1160`）——
			 * `typeof icon === "string"` 走官方 `ReferenceIconRegular{kind}`，但那个 kind 是
			 * **代码文件类型表**（`CODE_FILE_ARTWORK`：angular/clojure…），没有 "agent" 这类取值；
			 * 另一条分支把 `icon` 当 **React 组件**渲染（`jsx(icon, { size: 14 })`）⇒ 我们传自己的。
			 * 用 `currentColor` 描边，主题切换自动跟随；不引入官方 icon set 的版本耦合。
			 */
			function AgentsIcon(props) {
				const size = (props && props.size) || 14;
				return react.createElement("svg", {
					width: size, height: size, viewBox: "0 0 16 16", fill: "none",
					stroke: "currentColor", strokeWidth: 1.2, strokeLinecap: "round", strokeLinejoin: "round",
					"aria-hidden": "true",
				},
					react.createElement("circle", { key: "h", cx: 8, cy: 5.2, r: 2.6 }),
					react.createElement("path", { key: "b", d: "M2.9 14c.6-2.8 2.7-4.3 5.1-4.3s4.5 1.5 5.1 4.3" }),
				);
			}

			const readSummary = (sid) => {
				try {
					const list = ctx.sessions && ctx.sessions.list;
					const snap = list && list.getSnapshot();
					return sid && snap && snap.byId ? snap.byId[sid] : undefined;
				} catch { return undefined; }
			};
			const subscribeSessions = (fn) => {
				try {
					const list = ctx.sessions && ctx.sessions.list;
					if (list && typeof list.subscribe === "function") { return list.subscribe(fn); }
				} catch { /* 订阅失败只影响刷新，不影响首帧 */ }
				return () => undefined;
			};
			const loadRoster = () => {
				try {
					const remote = ctx.remote;
					if (!remote || !remote.agentPresets) {
						state.agentsRosterError = "remote.agentPresets unavailable";
						return Promise.resolve([]);
					}
					return Promise.resolve(remote.agentPresets.list()).then((r) => {
						if (r && r.ok && r.value && Array.isArray(r.value.presets)) {
							// ⚠ 不丢弃 `broken`：dsh 的花名册会留"带诊断的失败行"（加载失败的 preset 也在列表里），
							// 上一版把它们 filter 掉 ⇒ 用户看到的是"某个 Agent 凭空消失"，没有任何线索
							// （2026-10-11 实测：`@vssaros/dsh-agents` 未装进 profile 时，弹层只剩内置 4 个，
							// 排查只能靠读 profile 的 package.json）。改为**照实列出 + 「不可用」徽标**。
							// ★ 委派专用 preset（`<preset>-assign`，见 vssaros-agents 的 `model-assignment`）**不进用户列表**：
							// 它是内部派生行（同人格、只是换了便宜模型给委派跑），列出来会让用户以为多了一个 Agent，
							// 而且选它换人格没有意义（人格与本体完全相同）。诊断计数留着，便于自证里对账。
							const raw = r.value.presets.filter((p) => p && rowKey(p));
							const all = raw.filter((p) => !ASSIGN_PRESET_RE.test(rowKey(p)));
							state.assignmentPresetsHidden = raw.length - all.length;
							// ★ 2026-10-19：只列**插件认为该给用户看**的 agent（内置目录里 coder/tester/助理 那些
							// 是内部子代理角色，插件已在 `/api/agents` 侧过滤成白名单）。拿不到列表 ⇒ **原样展示**
							// （fail-open：宁可多列，也不因为一次请求失败把用户自己的 agent 藏掉）。
							return loadVisiblePresetIds().then((ids) => {
								const shown = ids ? all.filter((p) => ids.has(rowKey(p))) : all;
								state.builtinAgentsHidden = all.length - shown.length;
								state.agentsRoster = shown.length;
								state.agentsRosterBroken = shown.filter((p) => p.broken === true).length;
								// 分来源计数（诊断用：一眼看出"VsSaros agent 一个都没注册"是环境问题而非 UI 问题）。
								state.agentsRosterSources = { builtin: 0, mine: 0 };
								for (const p of shown) { state.agentsRosterSources[sourceOf(p) === "mine" ? "mine" : "builtin"]++; }
								return shown;
							});
						}
						state.agentsRosterError = "list not ok: " + JSON.stringify((r && r.error) || r).slice(0, 200);
						return [];
					}, (e) => {
						state.agentsRosterError = String((e && e.message) || e);
						return [];
					});
				} catch (e) {
					state.agentsRosterError = String((e && e.message) || e);
					return Promise.resolve([]);
				}
			};
			/** 用 roster 的 isDefault 找出基座 id（拿不到就退回 BASE_PRESET）。 */
			const baseIdOf = (roster) => {
				const d = (roster || []).find((p) => p && p.isDefault === true);
				return rowKey(d) || BASE_PRESET;
			};
			const switchTo = (id, onDone) => {
				if (!bridge || !bridge.switchPreset) {
					state.agentsError = "page bridge too old (switchPreset unavailable)";
					return;
				}
				Promise.resolve(bridge.switchPreset(id)).then(
					() => { state.agentsSwitches = (state.agentsSwitches || 0) + 1; if (onDone) { onDone(null); } },
					(e) => { const f = String((e && e.message) || e); state.agentsError = f; if (onDone) { onDone(f); } },
				);
			};

			// ── 两条命令行的分工（2026-10-11 用户要求）──────────────────────────────────
			//   · **Preset 行**（`vssaros-presets`）：换 preset = 换会话组合（工具 / 模型 / skills，
			//     首回合后 Host 就锁定）⇒ 只能**新建一个会话**（新建页签并绑到该 preset 的会话）。
			//   · **Agents 行**（`vssaros-agents`）：换 agent = **只换人格**（提示词内容，会话内可变）
			//     ⇒ **在当前会话里继续**，不动会话绑定、不动工具/模型。
			// 依据：agents 模块的 `POST /x/agents/api/persona`（`agent/inject` → 投影 `vssaros-persona`
			// → 人设段函数形式下一次装配取新值；见 `dsh-plugins/vssaros-agents/lib/index.js` 文件头）。

			/**
			 * **仅切换人格**（当前会话继续）：POST 到 agents 模块自己的路由 `/x/agents/api/persona`。
			 *
			 * 鉴权（2026-10-11 实测的关键一环）：Host 对**所有**路径都要凭据 —— 无凭据一律 401
			 * （`connection.requestRejection`；我用 curl 验过：带外壳 `?token=` 换来的 cookie 才通）。
			 * 而 WebContentsView 的会话是否共享那份 cookie **不确定** ✗ ⇒ 这里把 URL 上的 token
			 * 一起带上，并在失败时**换一种形态重试一次**（带 token ↔ 不带），两种都失败才报错。
			 */
			const switchPersona = (sid, presetId, onDone) => {
				postPersona(sid, personaRequest(sid, presetId), (err) => {
					if (err) { failPersona("切换人格失败：" + err, onDone); return; }
					state.agentsPersonaSwitches = (state.agentsPersonaSwitches || 0) + 1;
					state.agentsPersona = presetId;
					// ★ 写入成功后**立刻用本地已知信息点亮 chip**（名字从花名册取），不等任何"读"路径 ——
					// 2026-10-11 实测：写入成功、但读（投影/GET）都拿不到 ⇒ 界面无反应且无报错 ✗；
					// 读路径只用于**刷新页面后**恢复（投影 → 本地存档 → 路由，取不到就不显示 ✓ 不假装）。
					setPersona(sid, { personaId: presetId, name: presetId });
					Promise.resolve(loadRoster()).then((roster) => {
						const row = (roster || []).find((p) => rowKey(p) === presetId);
						const label = row ? rowLabel(row) : presetId;
						setPersona(sid, { personaId: presetId, name: label });
					// 方案 C：合并 chip 的后缀（`· <人格名>`）读的是人格 chunk 的 store ⇒ 切换成功后同步刷它，
					// 否则要等下一次 rebind 才更新（"点了没反应"的又一种形态 ✗）。
					const pk = state.vssarosPersona;
					if (pk && typeof pk.refresh === "function") { void pk.refresh(sid); }
						// 成功也要**说出来**：用户看不到 chip 时无法区分"没生效"与"UI 没刷新"（实测踩过 ✗）。
						if (bridge && bridge.notify) { bridge.notify("done", "已切换人格：" + label + "（当前会话继续）"); }
					}, () => {
						if (bridge && bridge.notify) { bridge.notify("done", "已切换人格：" + presetId + "（当前会话继续）"); }
					});
					if (onDone) { onDone(null); }
				});
			};

			/** 清除人格（＝回到 preset 自带人设；会话继续，不换绑）。 */
			const clearPersona = (sid, onDone) => {
				if (!sid) { if (onDone) { onDone("no session"); } return; }
				postPersona(sid, { sessionId: String(sid), clear: true }, (err) => {
					if (err) {
						if (bridge && bridge.notify) { bridge.notify("attention", "清除人格失败：" + err); }
						if (onDone) { onDone(err); }
						return;
					}
					setPersona(sid, null);
					// 同上：清除后同步人格 store（后缀回到 `· 人格默认` ✓）
					const pk = state.vssarosPersona;
					if (pk && typeof pk.refresh === "function") { void pk.refresh(sid); }
					if (onDone) { onDone(null); }
				});
			};

			// ── 人格状态：与"会话 preset"**分开**存 ──────────────────────────────────────
			// 切人格只改提示词内容、**不动会话** ⇒ 会话的 `projectionValues.agentPreset` 仍是基座 ✗。
			// 2026-10-11 用户实测："选了 agent 之后没有反应" —— 根因就是 composer 那枚 chip 当时按
			// "会话 preset 是 vssaros-*"判可见性，而那个条件在新模型下**永远不成立** ✗。
			// 所以这里自存一份人格：会话投影（最权威）→ 本次运行缓存 → localStorage 存档，三级兜底 ✓。
			const personas = {};
			const personaSubs = new Set();
			const bumpPersonas = () => { for (const f of [...personaSubs]) { try { f(); } catch { /* 单个订阅者出错不影响别人 */ } } };

			/** localStorage 存档前缀（按会话 id）：刷新页面后 chip 还在 ✓（Host 侧读不到时的兜底）。 */
			const PERSONA_STORE_PREFIX = "vssaros.persona.";
			const storePersona = (sid, value) => {
				try {
					if (typeof localStorage === "undefined") { return; }
					if (value) { localStorage.setItem(PERSONA_STORE_PREFIX + sid, JSON.stringify(value)); }
					else { localStorage.removeItem(PERSONA_STORE_PREFIX + sid); }
				} catch { /* 隐私模式 / 配额满：只是不落盘，不影响本次会话 ✓ */ }
			};
			const storedPersona = (sid) => {
				try {
					if (typeof localStorage === "undefined") { return undefined; }
					const raw = localStorage.getItem(PERSONA_STORE_PREFIX + sid);
					if (!raw) { return undefined; }
					const v = JSON.parse(raw);
					return (v && typeof v.personaId === "string" && v.personaId)
						? { personaId: v.personaId, name: v.name || v.personaId }
						: undefined;
				} catch { return undefined; }
			};

			const personaOf = (sid) => (sid && personas[sid]) || undefined;
			const setPersona = (sid, value) => {
				if (!sid) { return; }
				personas[sid] = value || undefined;
				storePersona(sid, value);
				bumpPersonas();
			};
			const fetchImpl = () => ((shell && typeof shell.fetch === "function")
				? shell.fetch
				: (typeof fetch === "function" ? fetch : undefined));
			/** 人格投影 key：agents 模块注册的 `vssaros-persona`（值 = `{personaId, name, atSeq}` ✓）。 */
			const PERSONA_PROJECTION_KEY = "vssaros-persona";

			/**
			 * **首选**人格来源：会话快照里的投影。
			 *
			 * 为什么优先它：投影是 dsh 客户端**本身就有**的数据（agents 模块用
			 * `sessionProjections.register` 注册 ✓），读它不发请求、不怕路由被 `requestRejection` 拦 ✗，
			 * 而且会话一变（切换落成 `agent/inbox/spliced` ✓）就会触发我们已有的 `subscribeSessions` 重渲染
			 * ⇒ chip 自动出现 ✓✓。2026-10-11 实测：只靠路由 GET 时 chip 一直不出现（探测失败被我写成静默 ✗）。
			 */
			const personaFromSummary = (sid) => {
				const summary = readSummary(sid);
				const raw = summary && summary.projectionValues ? summary.projectionValues[PERSONA_PROJECTION_KEY] : undefined;
				if (!raw || typeof raw !== "object") { return undefined; }
				const id = raw.personaId;
				return (typeof id === "string" && id) ? { personaId: id, name: raw.name || id } : undefined;
			};

			/** chip 的解析顺序：投影（最权威）→ 本次运行缓存 → 本地存档。 */
			const personaKnown = (sid) => personaFromSummary(sid) || personaOf(sid) || storedPersona(sid);

			/**
			 * 该会话**跑的是不是我们的 agent**（宿主推来的 `agentPreset` 投影，preset id 前缀 `vssaros-` ✓）。
			 *
			 * 为什么需要它（2026-10-13 用户报"chip 只有在选中过 agent 后才显示"）：人格投影**只反映"切换过"** ✗
			 * （`emptyPersonaState` ⇒ `personaId: null` ✓），而"会话跑的是哪个 agent"是**另一件事** ✓ ——
			 * 用 `vssaros-standard` 起的会话明明有 agent，chip 却因为没有切换记录而整枚不渲染 ✗✗。
			 * 本文件里 `PresetHeaderLabel` 的注释早就写着两者"互补：agent chip 只在跑 VsSaros agent 时显示" ✓
			 * —— 是**代码漂移**了 ✗，这里把它对齐回那条判据 ✓。
			 */
			const sessionAgentPreset = (sid) => {
				const id = currentPreset(readSummary(sid));
				return (typeof id === "string" && id && sourceOf({ id }) === "mine") ? id : undefined;
			};

			/** preset id（`vssaros-<slug>`）→ 兜底显示名（花名册还没到时用；去掉我们的前缀 ✓）。 */
			const agentLabelFromPresetId = (presetId) => String(presetId || "").replace(/^vssaros-/, "");

			/**
			 * 是不是**模式 preset**（`vssaros-standard` = 官方 `standard` 的逐字副本 + 我们的模块行，
			 * 见 `dsh-plugins/vssaros-agents/cordis.presets.yml` 与它的生成器 `preset-sync.mjs` ✓）。
			 *
			 * 为什么要分出来（2026-10-13 用户报两处 UI 问题）：这个 preset 是**模式**而不是"某个 agent" ✗ ——
			 * 旧口径把它当 agent ⇒ composer 的 chip 冒出内部 id `vssaros-standard` ✗✗，而头部本该报"当前模式"
			 * 的标签又被"跑我们的 agent 就藏"这条规则一起藏掉 ✗✗。现在的分工：
			 *   · **模式**（本函数命中）⇒ 头部 `PresetHeaderLabel` 报（文案来自 preset 的 `name` ✓）；
			 *   · **agent**（我们的其它 preset）⇒ composer 的 `AgentChip` 报 ✓；
			 *   · 两者都不显示的情况：dsh 自带 preset 之外的未知 id（保持原样 ✓）。
			 * ⚠ 判据按 `BUILTIN_PRESETS` 推导（不是写死 `vssaros-standard`）⇒ 将来同步了别的官方预设
			 *   （`vssaros-ptc` 等）也自动归到"模式" ✓。
			 */
			const isModePreset = (presetId) => !!presetId && BUILTIN_PRESETS.some((base) => presetId === VSSAROS_PREFIX + base);

			/** 人格路由（agents 模块自带；与页面同在 dsh web server 上）。 */
			const PERSONA_ROUTE = "/x/agents/api/persona";

			/**
			 * 外壳 URL 上的 token（`?token=…`）：Host 的 `requestRejection` **对所有路径都要凭据**，
			 * 而页面里那份 cookie 属于 WebContentsView 的会话、是否共享不确定 ✗ ⇒ 把 token 一并带上
			 * 是最省事的第二条凭据路。`shell.token` 可注入（单测），缺省从 `location.search` 取。
			 */
			const authToken = () => {
				try {
					if (shell && typeof shell.token === "string" && shell.token) { return shell.token; }
					if (typeof location === "undefined" || !location.search) { return ""; }
					return new URLSearchParams(location.search).get("token") || "";
				} catch { return ""; }
			};

			/** 组装人格路由 URL（`withToken` 决定带不带 token；GET 再带 sessionId）。 */
			const personaUrl = (sid, withToken) => {
				const params = new URLSearchParams();
				if (withToken) {
					const token = authToken();
					if (token) { params.set("token", token); }
				}
				if (sid) { params.set("sessionId", String(sid)); }
				const query = params.toString();
				return PERSONA_ROUTE + (query ? "?" + query : "");
			};

			/** 写失败的统一出口：记状态 + 弹一次通知（弹层没有错误位，静默失败最难查 ✗）。 */
			const failPersona = (msg, onDone) => {
				state.agentsError = msg;
				if (bridge && bridge.notify) { bridge.notify("attention", msg); }
				if (onDone) { onDone(msg); }
			};

			/**
			 * 把 `ok:false` 的响应变成**带原因的错误串**（`HTTP 400：会话不在运行，无法热切换：…`）。
			 *
			 * 为什么非要读正文：这条路由把"为什么拒绝"写在**正文**里（400 + 纯文本原因，见
			 * `dsh-plugins/vssaros-agents/lib/index.js` 的路由 catch），状态码本身没有信息量 ——
			 * 2026-10-11 用户看到的正是「切换人格失败：HTTP 400」这种零信息错误 ✗。
			 * 没有 `text()` 的实现（单测的假 fetch）自动退回纯状态码 ✓。
			 */
			const httpErrorText = (r) => {
				const status = (r && r.status) || "?";
				let read;
				try {
					read = (r && typeof r.text === "function") ? r.text() : "";
				} catch { read = ""; }
				return Promise.resolve(read).then(
					(t) => {
						// 正文压成一行再截断：400 的正文可能带换行/堆栈，通知里要能一眼读完。
						const text = String(t || "").trim().replace(/\s+/g, " ").slice(0, 200);
						return "HTTP " + status + (text ? "：" + text : "");
					},
					() => "HTTP " + status,
				);
			};

			/**
			 * POST 人格路由：**先带 token，失败再退一次不带 token**（两种凭据形态都试过才认失败）。
			 *
			 * 为什么要重试：Host 只认"token 或 cookie"其中之一，而两种形态在不同环境里谁有效不一致
			 * （2026-10-11 实测：无凭据时**所有**路径 401 ✓；带外壳 cookie 时路由正常 ✓）。
			 * 多一次请求，换掉"靠猜" ✓。token 不存在时两次等价（无害）。
			 */
			const postPersona = (sid, body, onDone) => {
				const impl = fetchImpl();
				if (!impl) { onDone("fetch unavailable"); return; }
				const attempt = (withToken) => Promise.resolve()
					.then(() => impl(personaUrl(sid, withToken), {
						method: "POST",
						credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body || {}),
					}))
					// ★ **把响应正文带回来**：这条路由的 400 正文里写的就是原因原话（`会话不在运行，无法热切换：…`
					//   / `未知 preset：…` / `需要 sessionId` —— 见 `dsh-plugins/vssaros-agents/lib/index.js` 的
					//   switchPersona 抛错点）。上一版只留 `HTTP 400` ⇒ 2026-10-11 用户看到的提示是
					//   「切换人格失败：HTTP 400」，信息量为零、只能再猜一轮 ✗。
					.then((r) => (r && r.ok === false ? httpErrorText(r) : null),
						(e) => String((e && e.message) || e));
				attempt(true).then((err1) => {
					if (err1 === null) { onDone(null); return; }
					attempt(false).then((err2) => { onDone(err2 === null ? null : (err2 || err1)); });
				});
			};

			/**
			 * 读该会话当前人格（**探测**性质：失败按"没有人格/读不到"处理，只在调用方要求时提示）。
			 *
			 * 与写同款：带 token / 不带 token 各试一次；**读失败不动缓存**（别把"读不到"当成"已清除" ✗）。
			 */
			const loadPersona = (sid, onDone) => {
				const impl = fetchImpl();
				if (!impl || !sid) { if (onDone) { onDone(undefined); } return; }
				// 重试节流可注入（单测要它=0 ⇒ 不必等真定时器 ✓）；缺省给一个"够 agent 注册完"的量级 ✓
				const retryMs = (shell && typeof shell.personaRetryMs === "number") ? shell.personaRetryMs : PERSONA_PROBE_RETRY_MS;
				const attempt = (withToken) => Promise.resolve()
					.then(() => impl(personaUrl(sid, withToken), { credentials: "same-origin" }))
					.then((r) => {
						// 读失败也要带原因（正文里的「会话不在运行：…」是下一步排查的路标）。
						if (r && r.ok === false) { return httpErrorText(r).then((t) => { throw new Error(t); }); }
						return (r && typeof r.json === "function") ? r.json() : undefined;
					})
					.then((v) => ({ ok: true, value: v }), (e) => ({ ok: false, error: String((e && e.message) || e) }));
				attempt(true).then((a) => (a.ok ? a : attempt(false))).then((a) => {
					if (!a.ok) {
						state.personaProbeError = a.error;
						// ★ 2026-10-13：**时序性失败要重试，且不许报成"未授权"** ✗ ——
						//   页面挂载往往早于 agent 注册进 `state.agents` ⇒ 路由回 `会话不在运行：<id>`（400 ✓），
						//   那不是"不可达/未授权"✗。上一版只试一次 + 立刻弹笼统通知 ⇒ 用户看到的正是那条误导信息 ✗
						//   （真原因一直躺在 `state.personaProbeError` 里，却没人能看到 ✓）。
						const tries = (state.personaProbeRetries = (state.personaProbeRetries || 0) + 1);
						if (isTransientPersonaError(a.error) && tries <= PERSONA_PROBE_MAX_RETRIES) {
							setTimeout(() => { loadPersona(sid, onDone); }, retryMs);
						}
						if (onDone) { onDone(undefined); }
						return;
					}
					// 读成功 ⇒ 清掉失败痕迹（自证里不该留旧错误 ☠）
					state.personaProbeError = null;
					state.personaProbeRetries = 0;
					const v = a.value;
					const value = v && v.personaId ? { personaId: v.personaId, name: v.name || v.personaId } : null;
					setPersona(sid, value);
					if (onDone) { onDone(value); }
				});
			};

			/** 切换 preset = **新建一个会话**（宿主开新页签并绑到该 preset 的专属会话）。 */
			const newSessionWithPreset = (presetId, onDone) => {
				if (!presetId) { return; }
				if (!bridge || typeof bridge.newChat !== "function") {
					const msg = "page bridge too old (newChat unavailable)";
					state.agentsError = msg;
					if (onDone) { onDone(msg); }
					return;
				}
				Promise.resolve(bridge.newChat(presetId)).then(
					() => { state.presetNewChats = (state.presetNewChats || 0) + 1; if (onDone) { onDone(null); } },
					(e) => { const f = String((e && e.message) || e); state.agentsError = f; if (onDone) { onDone(f); } },
				);
			};

			/**
			 * 头部 preset 标签（**兜底路径**：读不到官方 CSS 类名、无法"官方渲染 + 按需隐藏"时才注册 ✓）。
			 *
			 * 可见性（与输入框那枚 `AgentChip` **互补** ✓）：
			 *   · **模式 preset**（`vssaros-standard` 等 = 官方预设逐字副本）⇒ **显示** ✓（用户要的 "standard mode ui" ✓）；
			 *   · **真 agent**（我们的其它 preset）⇒ 不显示 ✗（agent 名归 composer 那枚 chip 报 ✓，2026-10-11 要求 ✓）；
			 *   · dsh 自带 preset ⇒ 显示 ✓（原口径 ✓）。
			 * 生产路径下本组件**不会**注册（官方标签自己渲染 ✓ + 用 `body[data-vssaros-agent-preset]` 标记按需隐藏 ✓，
			 * 见 `applyMarker` —— 那里的判据与这里必须一致 ✗）。
			 *
			 * ⚠ 定义必须留在 `install()` 内：`readSummary` / `subscribeSessions` / `loadRoster` 都是 `install`
			 * 的局部 const（放在 factory 层会 ReferenceError —— 实测踩过一次 ✗）。
			 */
			function PresetHeaderLabel(props) {
				const sid = (props && props.sessionId) || state.sessionId;
				const [, force] = react.useState(0);
				const [roster, setRoster] = react.useState(null);
				react.useEffect(() => { let dead = false; loadRoster().then((r) => { if (!dead) { setRoster(r); } }); return () => { dead = true; }; }, []);
				react.useEffect(() => subscribeSessions(() => force((n) => n + 1)), []);
				if (!sid) { return null; }
				const current = currentPreset(readSummary(sid));
				// 会话没有 preset 投影 ⇒ 官方标签同样不渲染（保持同一口径，别在这里"补"一个默认值）。
				if (!current) { return null; }
				// 跑的是**我们的 agent** ⇒ 本标签不显示（agent 名归 composer 那枚 chip 报 ✓）；
				// ★ 2026-10-13：**模式 preset**（`vssaros-standard` 等 = 官方预设逐字副本）要显示 ✓ ——
				//   它代表"当前模式"，没有别的地方报它 ✗（用户报"header 缺 standard mode ui" ✓）。
				//   文案优先级：花名册的 `name`（生成器已给 `name: standard` ✓）→ 去掉 `vssaros-` 前缀的 id ✓。
				if (sourceOf({ id: current }) === "mine" && !isModePreset(current)) { return null; }
				const row = (roster || []).find((p) => rowKey(p) === current);
				return react.createElement("span", {
					"data-vssaros-preset-label": "1",
					title: (row && row.description) || "当前模式 / Agent preset",
					style: {
						display: "inline-flex", alignItems: "center", gap: 4, height: 22, padding: "0 6px",
						borderRadius: 4, background: "var(--dsw-alias-fill-tsp-secondary, transparent)",
						color: "var(--dsw-alias-label-tertiary, currentColor)", fontSize: 12, lineHeight: "22px",
						whiteSpace: "nowrap", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis",
					},
				}, "⬢ " + (row ? rowLabel(row) : agentLabelFromPresetId(current)));
			}

			/** 选择面板：搜索 + 分组列表 + 底部动作。挂载在 `conversation.input.overlay`（composer 卡内浮层）。 */
			function AgentsPanel() {
				const [roster, setRoster] = react.useState(null);
				const [query, setQuery] = react.useState("");
				const [rev, setRev] = react.useState(0);
				const [busy, setBusy] = react.useState(false);
				const [err, setErr] = react.useState(null);
				const rootRef = react.useRef(null);
				react.useEffect(() => { let dead = false; loadRoster().then((r) => { if (!dead) { setRoster(r); } }); return () => { dead = true; }; }, []);
				// 打开状态来自 store（触发菜单的行 onPick 会把 store 打开）。
				react.useEffect(() => store.subscribe(() => setRev(rev + 1)), [rev]);
				react.useEffect(() => subscribeSessions(() => setRev(rev + 1)), [rev]);
				// 方案 C：人格段的「当前是哪个 / 适不适用」来自人格 chunk 的 store ⇒ 订阅它（读回/切换都刷新 ✓）
				react.useEffect(() => {
					const ps = state.vssarosPersona && state.vssarosPersona.store;
					if (!ps || typeof ps.subscribe !== "function") { return undefined; }
					const off = ps.subscribe(() => setRev(rev + 1));
					return () => { if (typeof off === "function") { off(); } };
				}, [rev]);
				const open = store.isOpen();
				react.useEffect(() => {
					if (!open) { return; }
					const close = (ev) => {
						if (rootRef.current && ev.target && rootRef.current.contains(ev.target)) { return; }
						store.setOpen(false);
					};
					const esc = (ev) => { if (ev.key === "Escape") { store.setOpen(false); } };
					document.addEventListener("mousedown", close, true);
					document.addEventListener("keydown", esc, true);
					return () => {
						document.removeEventListener("mousedown", close, true);
						document.removeEventListener("keydown", esc, true);
					};
				}, [open, rev]);
				react.useEffect(() => {
					if (!open || !shell.menus) { return; }
					shell.menus.closeOthers(MENU_ID);
					return shell.menus.register(MENU_ID, () => store.setOpen(false));
				}, [open, rev]);
				if (!open) { return null; }
				const sid = state.sessionId;
				const summary = readSummary(sid);
				const current = currentPreset(summary);
				const all = roster || [];
				// 本面板 = **Agent 选择器**（由 composer 那枚 chip 打开）⇒ 只列 VsSaros agent ✓。
				// dsh 自带 preset 的选择在 hero 那枚 **preset chip** 的下拉里（那边只列内置 ✓，用户 2026-10-11 要求）。
				// 两个面各管一边：chip→本面板换**人格**，preset 下拉换**会话组合**。
				const list = all.filter((p) => matches(p, query.trim()));
				const mine = list.filter((p) => sourceOf(p) === "mine");
				const pick = (id) => {
				if (busy) { return; }
				setBusy(true); setErr(null);
				// ★ 面板里选 agent = **仅换人格**（会话继续），与 `+` 菜单的 Agent 行同一条路。
				switchPersona(sid, id, (f) => {
					setBusy(false);
					if (f) { setErr(f); } else { store.setOpen(false); }
				});
				};
				// ⚠ 一律用 `...children` 展开（不要传数组）：本仓测试装配件按扁平的 props.children 遍历，
				// 嵌一层数组会让 find* 找不到里层节点（实测踩过），React 侧两种写法等价。
				const row = (p, key) => react.createElement("button", {
					key: "a-" + key,
					type: "button",
					"data-vssaros-agent-item": rowKey(p),
					// 方案 C：同一行同时是"人格候选"（属性契约沿用原 persona 面板 ✓，e2e 仍按它点行）
					"data-vssaros-persona-item": rowKey(p),
					onClick: () => pick(rowKey(p)),
					style: Object.assign({
						display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left",
						padding: "6px 8px", border: 0, borderRadius: 8, cursor: "pointer",
						background: "transparent", color: "var(--dsw-alias-label-primary, currentColor)", fontSize: 12,
					}, shell.menus && shell.menus.itemHover ? shell.menus.itemHover() : {}),
				},
					react.createElement("span", {
						key: "av", style: {
							width: 18, height: 18, flex: "0 0 18px", borderRadius: 5, display: "inline-flex",
							alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 600,
							color: "#14151a", background: sourceOf(p) === "mine" ? "#c08bff" : "#8aa0c0",
						},
					}, rowLabel(p).slice(0, 1).toUpperCase()),
					react.createElement("span", { key: "tx", style: { flex: "1 1 auto", minWidth: 0 } },
						react.createElement("span", {
							key: "t1", style: { display: "flex", alignItems: "center", gap: 6 },
						},
							react.createElement("span", { key: "n", style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, rowLabel(p)),
							rowKey(p) === current ? react.createElement("span", { key: "c", style: { color: "var(--dsw-alias-brand-primary, #4c9aff)" } }, "✓") : null,
						),
						p && p.description ? react.createElement("span", {
							key: "t2", style: {
								display: "block", color: "var(--dsw-alias-label-secondary, #999)", fontSize: 11.5, marginTop: 1,
								overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
							},
						}, p.description) : null,
					),
					react.createElement("span", {
						key: "src", style: {
							flex: "0 0 auto", fontSize: 10, color: "var(--dsw-alias-label-secondary, #999)",
							border: "1px solid var(--dsw-alias-border-l1, transparent)", borderRadius: 999, padding: "0 6px",
						},
					}, sourceOf(p) === "mine" ? "我的" : "内置"),
				);
				const head = (text) => react.createElement("div", {
					key: "gh-" + text,
					style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #999)", padding: "6px 9px 4px", letterSpacing: ".02em" },
				}, text);
				const action = (key, text, onClick) => react.createElement("button", {
					key, type: "button", onClick, "data-vssaros-agents-action": key, style: {
						display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
						padding: "8px 9px", marginTop: 4, border: 0, borderTop: "1px solid var(--dsw-alias-border-l1, transparent)",
						background: "transparent", color: "var(--dsw-alias-label-secondary, currentColor)",
						fontSize: 12, cursor: "pointer",
					},
				}, text);
				const hint = (text, key) => react.createElement("div", {
					key: "h-" + key,
					style: {
						padding: "6px 9px", color: "var(--dsw-alias-label-secondary, #999)",
						fontSize: 11, lineHeight: 1.45, borderTop: "1px solid var(--dsw-alias-border-l1, transparent)",
					},
				}, text);
				// ── 方案 C（2026-10-17 用户拍板）：原「人格 chip + 人格面板」合并进本面板 ──────────────
				// 依据：两颗 chip 都在做同一件事 —— 都走 `POST /x/agents/api/persona` 换**本会话人格**
				// （agent 行 → `switchPersona`，人格面板行 → 同一接口），只是文案分别强调"是谁/是否覆盖"。
				// 合并后：chip 一颗（`◉ PPT 专家 · 人格默认`，见 AgentChip），面板一个（本面板）。
				// ⚠ 属性契约沿用原 persona 面板：`data-vssaros-persona-panel`（本段根）、
				//   `data-vssaros-persona-item`（每一行 —— 与 agent 行是同一批）、
				//   `data-vssaros-persona-clear`（「跟随 Agent 自带人设」一行）⇒ 真机 e2e 的 persona UI 段不用改 ✓。
				const pk = state.vssarosPersona || null;
				const pStore = pk && pk.store ? pk.store : null;
				const personaApplicable = !!(pStore && pStore.applicable === true);
				const personaCur = personaApplicable && pStore.current && pStore.current.personaId ? pStore.current.personaId : null;
				const personaClear = react.createElement("button", {
					key: "persona-clear", type: "button", disabled: busy || personaCur === null,
					"data-vssaros-persona-clear": "1",
					onClick: () => {
						if (busy) { return; }
						setBusy(true); setErr(null);
						clearPersona(sid, (f) => {
							setBusy(false);
							if (f) { setErr(f); } else { store.setOpen(false); }
						});
					},
					style: {
						display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
						padding: "7px 9px", border: 0, borderTop: "1px solid var(--dsw-alias-border-l1, transparent)",
						background: "transparent", color: "var(--dsw-alias-label-secondary, currentColor)",
						fontSize: 12, cursor: personaCur === null ? "default" : "pointer",
					},
				}, (pk && pk.FOLLOW_LABEL ? pk.FOLLOW_LABEL : "跟随 Agent 自带人设") + (personaCur === null ? "（当前）" : ""));
				const personaSection = personaApplicable ? react.createElement("div", {
					key: "persona-sec",
					"data-vssaros-persona-panel": "1",
				},
					head("人格 · 本会话（工具与模型不变）"),
					...mine.map((p, i) => row(p, "m" + i)),
					personaClear,
					hint(pk.HINT_PERSONA || "只改提示词人设：留在当前会话（历史保留），工具与模型不变。", "p1"),
					hint(pk.HINT_AGENT || "要换工具/模型（换 Agent）请用 Agents 面板——那会切到它的专属会话，历史各自独立。", "p2"),
				) : null;
				const children = [
					react.createElement("div", {
						key: "search",
						style: {
							display: "flex", alignItems: "center", gap: 7, padding: "7px 9px",
							borderBottom: "1px solid var(--dsw-alias-border-l1, transparent)", margin: "0 3px 4px",
							color: "var(--dsw-alias-label-secondary, #999)", fontSize: 12.5,
						},
					},
						react.createElement("span", { key: "i" }, "🔍"),
						react.createElement("input", {
							key: "q",
							autoFocus: true,
							// ⚠ 本面板 = **Agent 选择器**（只列 VsSaros agent）：文案必须说 Agent。
							// 上一版这里照抄了 preset 行的占位符（"搜索 preset（dsh 自带）"）⇒ 面板里明明是
							// 「我的 Agent」5 条，却让用户去搜 preset（2026-10-11 用户截图实测 ✗）。
							"data-vssaros-agents-search": "1",
							placeholder: "搜索 Bot",
							value: query,
							onChange: (e) => setQuery(e.target.value),
							style: {
								flex: "1 1 auto", background: "transparent", border: 0, outline: "none",
								color: "var(--dsw-alias-label-primary, currentColor)", fontSize: 12.5, fontFamily: "inherit",
							},
						})),
					// 只列 VsSaros agent（见上面 `list` 处的注释）；空态给出可照做的下一步。
					// 方案 C：人设段真的存在时，这批行就是**人格候选**（包在 `data-vssaros-persona-panel` 里）；
					// 不存在时（如 dsh 自带 preset）退回原来的「我的 Agent」列表（那时换人格没有可观测变化 ✗）。
					personaSection || (mine.length ? head("我的 Agent") : null),
					...(personaSection ? [] : mine.map((p, i) => row(p, "m" + i))),
					mine.length === 0 && !query.trim() ? react.createElement("div", {
						key: "mine-hint",
						"data-vssaros-agents-hint": "mine",
						style: { padding: "6px 9px 8px", color: "var(--dsw-alias-label-secondary, #999)", fontSize: 11.5, lineHeight: 1.5 },
					}, "未检测到 VsSaros Agent —— 插件中心 → 随包插件 → agents：安装并启用后，这里会列出 ~/.vssaros/agents 下的全部 Agent。") : null,
					list.length === 0 ? react.createElement("div", {
						key: "empty", style: { padding: "10px 9px", color: "var(--dsw-alias-label-secondary, #999)", fontSize: 12 },
					}, "没有匹配的 Agent") : null,
					// 底部两个动作都走**宿主**（页面开不了编辑器）：命令见 dshPageBridgeProtocol 的
					// openAgentMarket / openAgentRoster —— 宿主分别执行 `agentStudio.openMarket` 与
					// `agentStudio.presetAgent.focus`（回落 `agentStudio.openResourceManager`）。
					action("shop", "↗ 打开 Agent 商城", () => {
						store.setOpen(false);
						if (bridge && bridge.openAgentMarket) { Promise.resolve(bridge.openAgentMarket()).catch(() => undefined); }
						else if (bridge && bridge.notify) { bridge.notify("info", "页面桥太旧：无法打开 Agent 商城"); }
					}),
					action("manage", "⚙ 管理 Agent…", () => {
						store.setOpen(false);
						if (bridge && bridge.openAgentRoster) { Promise.resolve(bridge.openAgentRoster()).catch(() => undefined); }
						else if (bridge && bridge.notify) { bridge.notify("info", "页面桥太旧：无法打开 Agent 列表"); }
					}),
					err ? react.createElement("div", {
						key: "err", style: { padding: "6px 9px", color: "var(--dsw-alias-state-error-primary, #e0574a)", fontSize: 11.5 },
					}, err) : null,
				];
				return react.createElement("div", {
					ref: rootRef,
					"data-vssaros-agents-panel": "1",
					role: "menu",
					style: Object.assign({
						position: "absolute", left: 12, bottom: "calc(100% + 4px)", width: 300, zIndex: 1000,
						maxHeight: 320, overflowY: "auto", padding: 4, borderRadius: 12,
						border: "1px solid var(--dsw-alias-border-l1, transparent)",
						background: "linear-gradient(var(--dsw-alias-bg-layer-1, transparent), var(--dsw-alias-bg-layer-1, transparent)), var(--dsw-alias-bg-base, #1e1e1e)",
						boxShadow: "0 18px 44px rgba(0,0,0,.6)",
						// ⚠ 向上展开（`bottom:100%`）⇒ **不能用** fitMenu 那个"整页 − 72"的高度：
						//   它假定菜单从页面顶部往下长 ⇒ 这里会算出 ~780px 而可用只有几百 ⇒ 面板顶部
						//   （含首行）落到视口外**且滚不到** ✗。也**不能**用它的向上口径：本面板拿不到
						//   触发器（`rootRef` 挂的是面板自己）⇒ 给一个**确定的**上限最实在，且这一句必须在
						//   fitMenu **之后**（从前它在前 ⇒ 被 fit 覆盖掉，等于没写 ✗ —— 2026-10-16 一并修）。
					}, shell.fitMenu ? shell.fitMenu() : {}, { maxHeight: 320 }),
				}, ...children);
			}

			/**
			 * 输入框 chip（**permission 下拉框右侧** ✓ `conversation.input.left`）：显示当前 agent
			 * （会话跑的那个人格 / agent）。点主体 = 打开选择面板；`✕` = 清除会话内人格（会话继续，只有切换过才给）。
			 *
			 * ⚠ 2026-10-11 → 2026-10-13 的口径（完整翻案史写在下面渲染处，改前先读）：
			 * 曾经用"该会话有人格"当可见性判据 —— 那等于"必须先手动切换过一次"✗（投影初始就是没有人格 ✓），
			 * 于是 `vssaros-standard` 起的会话明明有 agent 却整枚不显示 ✗（用户本次报障 ✓）。
			 */
			function AgentChip(props) {
				const sid = (props && props.sessionId) || state.sessionId;
				const [, force] = react.useState(0);
				const [busy, setBusy] = react.useState(false);
				/** 花名册（只在"没切换过人格、要靠 preset 报 agent 显示名"时才拉 ✓）。 */
				const [roster, setRoster] = react.useState(null);
				// 花名册：只在"没切换过人格、需要靠 preset 报 agent 名"时才拉 ✓（切换过的用投影里的人名 ✓）
				react.useEffect(() => {
					let dead = false;
					try {
						if (sid && !personaKnown(sid) && sessionAgentPreset(sid)) {
							loadRoster().then((r) => { if (!dead) { setRoster(r); } }, () => undefined);
						}
					} catch { /* 拿不到就退回 preset id 去前缀（下同） */ }
					return () => { dead = true; };
				}, [sid]);
				react.useEffect(() => {
					if (!sid) { return undefined; }
					const bump = () => force((n) => n + 1);
					personaSubs.add(bump);
					const off = subscribeSessions(bump);   // 投影一变（切换落成事件）就重渲染 ⇒ chip 自动出现 ✓
					// 方案 C：chip 后缀（`· 人格默认` / `· <人格名>`）来自人格 chunk 的 store ⇒ 订阅它，
					// 读接口回来 / 切换成功后 chip 文案自动跟上（不订阅就只能等下一次会话投影事件）。
					const pStore = state.vssarosPersona && state.vssarosPersona.store;
					const offP = pStore && typeof pStore.subscribe === "function" ? pStore.subscribe(bump) : undefined;
					loadPersona(sid, (v) => {         // 路由兜底读一次（投影没暴露时仍有救 ✓）
						// **读失败**（≠ "没有人格"）且**本地也没有任何依据**时才说一次 —— 这正是
						// "选完没反应"最难查的一环：2026-10-11 实测页面没开 CDP，只能靠这句自报 ✗。
						// `undefined` = 探测失败；`null` = 探测成功但没有指定人格（正常，不报）。
						if (v !== undefined || personaKnown(sid)) { return; }
						const err = state.personaProbeError || "未知原因";
						// ★ 2026-10-13：**时序性失败且还有重试额度 ⇒ 不说话**（挂载早于 agent 注册是常态 ✗）；
						//   而且文案必须带**真实原因** —— 上一版那句"（不可达或未授权）"是我编的笼统话 ✗，
						//   真原因（`会话不在运行：<id>` / `HTTP 401：…`）一直躺在 state 里没人看 ✓。
						const retries = state.personaProbeRetries || 0;
						if (isTransientPersonaError(err) && retries <= PERSONA_PROBE_MAX_RETRIES) {
							state.personaProbeSuppressed = (state.personaProbeSuppressed || 0) + 1;
							return;
						}
						if (state.personaProbeWarned !== sid) {
							state.personaProbeWarned = sid;
							if (bridge && bridge.notify) { bridge.notify("attention", "Agent 人格读取失败：" + err + "（已重试 " + retries + " 次）—— 会话仍可用：chip 上的人设可能不是最新的，重开该会话可再试"); }
						}
					});
					return () => {
						personaSubs.delete(bump);
						if (typeof off === "function") { off(); }
						if (typeof offP === "function") { offP(); }
					};
				}, [sid]);
				// ⚠ `sid` 缺失是**静默黑洞**：组件返回 null、上面的 effect 也提前返回 ⇒ 界面上既没有 chip
				// 也没有任何提示（2026-10-11 实测"什么通知都没有"）。所以这一例也要自报一次。
				if (!sid) {
					if (state.chipNoSessionWarned !== true && bridge && bridge.notify) {
						state.chipNoSessionWarned = true;
						state.chipNoSession = true;
						bridge.notify("attention", "Agent chip 已挂载，但拿不到当前会话 id（bridge.sessionId / state.sessionId 都是空）⇒ 不显示");
					}
					return null;
				}
				// 三级兜底：会话投影（最权威 ✓）→ 本次运行缓存 → localStorage 存档（刷新后仍在 ✓）。
				const persona = personaKnown(sid);
				// ★ 2026-10-13（用户报"chip 只有在选中过 agent 后才显示"）：可见性判据回归**本文件注释写明的那条** ——
				//   "跑的是 VsSaros agent" ✓（人格投影只反映**切换过**✗ ⇒ 用它当判据会让 `vssaros-standard` 起的会话
				//   明明有 agent 却整枚不渲染 ✗✗，而 `PresetHeaderLabel` 的注释早就写着两者按这条互补 ✓）。
				// 翻案史（别再来回改，先读这段）：
				//   · 最初（v0.2.33 前）按"会话 preset 是 vssaros-*"判可见 —— 但当时**选 agent = 换会话**；
				//     改成人格热切换后 preset 归属不再随选择变化 ⇒ "选完没反应" ✗；
				//   · 2026-10-11 先改成 `personaTruthy` 判可见、排查期又临时无条件渲染虚线「选择 Agent」；
				//     同日晚按用户要求（原话"移除输入框中的「选择 agent」按钮"）**撤回占位按钮** ✓ ——
				//     ⚠ 那条要求的本意是"不要一个**邀请你去选**的占位" ✗，**不是**"隐藏当前 agent" ✗✗（本次修复的正是这个误读）。
				//   · 入口不丢：「+」菜单的 Commands →「Agent」行仍在（同一功能，见本文件 ① 的注册处 ✓）。
				const presetId = sessionAgentPreset(sid);
				// ⚠ **模式 preset 不出 chip** ✓（2026-10-13 用户报"输入框里不该显示 vssaros-standard" ✗）：
				//   它是"当前模式"，由头部 `PresetHeaderLabel` 报 ✓；composer 这枚只报"哪个 agent" ✓。
				if (!persona && (!presetId || isModePreset(presetId))) { return null; }
				const row = presetId ? (roster || []).find((p) => rowKey(p) === presetId) : undefined;
				const label = persona ? (persona.name || persona.personaId) : (row ? rowLabel(row) : agentLabelFromPresetId(presetId));
				// ── 方案 C（2026-10-17 用户拍板）：与人格 chip **合并成一颗** ────────────────────────
				// 两颗 chip 本来都在做"本会话换人格"（同一接口），文案里又都出现 Agent ⇒ 读起来重复。
				// 现在只有这一颗：`◉ PPT 专家 · 人格默认`（后缀**只在"本会话人设段真的存在"时**出现，
				// 判据仍是人格读接口的 `rendered`；`standard` 这类 preset 上不显示后缀，避免误导 ✓）。
				// 属性契约不变：`data-vssaros-persona-chip*` 由本 chip 继承（e2e / 页面自证照旧可读 ✓）。
				const pk = state.vssarosPersona || null;
				const pStore = pk && pk.store ? pk.store : null;
				const personaApplicable = !!(pStore && pStore.applicable === true);
				const personaCur = personaApplicable && pStore.current && pStore.current.personaId ? pStore.current.personaId : "";
				const personaSuffix = personaApplicable && typeof pk.suffixLabel === "function" ? pk.suffixLabel() : "";
				state.chipShown = (state.chipShown || 0) + 1;
				// 自证用（页面自证探针会读它们 ⇒ "chip 为什么没出来"不再只能靠猜 ✓）
				state.agentChipLabel = label + personaSuffix;
				state.agentChipSource = persona ? "persona" : "preset";
				state.chipPersonaApplicable = personaApplicable;
				state.chipPersonaId = personaCur || null;
				if (presetId) { state.agentPreset = presetId; }
				const chipRootProps = {
					"data-vssaros-agent-chip": "1",
					"data-vssaros-chip-persona": personaCur,
					style: {
						display: "inline-flex", alignItems: "center", gap: 6, height: 22, padding: "0 5px 0 8px",
						borderRadius: 999, border: "1px solid rgba(192,139,255,.45)", background: "rgba(192,139,255,.12)",
						color: "var(--dsw-alias-label-primary, currentColor)", fontSize: 11.5, whiteSpace: "nowrap",
					},
				};
				const chipOpenProps = {};
				if (personaApplicable) {
					chipRootProps["data-vssaros-persona-chip"] = "1";
					chipRootProps["data-vssaros-persona-current"] = personaCur;
					chipOpenProps["data-vssaros-persona-chip-open"] = "1";
				}
				return react.createElement("span", chipRootProps,
					react.createElement("button", Object.assign({
						key: "b", type: "button",
						title: "换 Agent / 人格（只换人设，当前会话继续）——「人格默认」= 跟随 Agent 自带人设；要换工具或模型请新开会话",
						disabled: busy,
						"data-vssaros-agent-chip-open": "1",
						onClick: () => store.setOpen(true),
						style: {
							display: "inline-flex", alignItems: "center", gap: 5, border: 0, background: "transparent",
							color: "inherit", fontSize: 11.5, cursor: "pointer", padding: 0,
						},
					}, chipOpenProps), react.createElement("span", { key: "i", style: { color: "#c08bff", fontSize: 12 } }, "◉"), label + personaSuffix),
					// ✕ 只在**真的切换过人格**时给：没切换过时它无处可清（显示它就成了"占位按钮"✗）
					persona ? react.createElement("button", {
						key: "x", type: "button", title: "清除人格（回到 preset 自带人设）", disabled: busy,
						"data-vssaros-agent-chip-remove": "1",
						onClick: () => { setBusy(true); clearPersona(sid, () => setBusy(false)); },
						style: {
							border: 0, background: "transparent", color: "var(--dsw-alias-label-secondary, #999)",
							cursor: "pointer", fontSize: 12, lineHeight: 1, padding: "2px 3px", borderRadius: 999,
						},
					}, "✕") : null,
				);
			}

			// ── ①「+」菜单新增 Agents 行（**ui-commands 的贡献行**，不是 trigger 源）──────────
			// ⚠ 上一版走错了路（实测菜单里没有 Agents 行）：`ctx.inputTriggers.registerSource`
			//   在**手打 `/`** 时会出现，但 **`+` 按钮根本看不到它** —— 加号是
			//   `inputTriggers.toggleSource("command", …)`，**只开官方那一个源**
			//   （`dsh-client-ui-conversation/lib/client.js:18410`）⇒ 任何第三方源都进不了加号菜单 ✗。
			//
			// 正门：ui-commands 自己的**贡献行** `ctx.commandUi.register(contribution)`
			//   （服务 `CommandUiRuntime`：`dsh-client-ui-commands/lib/client.js:751/771/816`）。
			//   菜单候选 = **官方命令目录 + contributions**（同文件 `:909-918`）⇒ 加号菜单与 `/` 都有 ✓；
			//   行名不在它的 `SECTION_ROWS` 里 ⇒ 自动落进 **Commands 段**（`sectionRows` `:711-724`）✓。
			//   而且 `ui` 用 `PopupSelectSpec`：官方 popup **自带搜索框**（`popup.setSearch` `:1340`），
			//   `SelectOption` 支持 `group`（分组标题）/`detail`（副文本）/`active`（当前项高亮）
			//   —— 我们要的列表形态官方全有，**不必自绘**（自绘那套只留给 chip 点击）。
			const commandUi = typeof ctx.get === "function" ? ctx.get("commandUi") : undefined;
			if (commandUi && typeof commandUi.register === "function") {
				const contribution = {
					// 行名（不带斜杠）：与 host 命令重名会在候选合成时 **fail loud**（官方文档原话），
					// 所以用带前缀的唯一名，菜单上显示的是 `label`。
					name: ROW_NAME,
					// 2026-10-11 与「Preset」行拆开后：本行 = **仅换人格**（当前会话继续）。
					// ★ 2026-10-21（用户指令「把 agent 定位成一个 Bot（PersonaBot）」）：这一行**不再叫 Agent**
					//   —— agent 在 dsh 内部仍以 preset 形式存在（技术必需），但**用户可见的身份是"Bot"**
					//   （对标 DeepSeekBot 的 PersonaBot：bot 是"谁"，preset 是"怎么干"）⇒
					//   模式入口（hero 那枚）**只列模式**，agent 一律不进（见 client.preset.js）✓。
					label: () => "Bots",
					description: () => "选择 Bot（PersonaBot）：只换人格，当前会话继续",

					icon: AgentsIcon,
					available: () => true,
					ui: {
						kind: "popupSelect",
						searchMode: "substring",
						searchLabels: () => ({
							placeholder: "搜索 Bot",
							empty: "没有可用的 Bot",
							noResults: "没有匹配的 Bot",
						}),
						// 每次打开现读花名册（`:909-918` 的候选也是每轮现读 ⇒ 新装/新下的 Agent 立即出现）。
						options: () => loadRoster().then((roster) => {
							const current = currentPreset(readSummary(state.sessionId));
							// **只列 VsSaros agent**（2026-10-11 用户要求）：内置 preset（`BUILTIN_PRESETS` =
							// standard / ptc / minimal / cordis）不在这里出现 —— 本弹层的语义收窄成"选一个 VsSaros Agent"，
							// 内置项由 dsh 官方自己的入口管（我们既没能力也没必要在这里复刻它们）。
							// ⚠ 诊断字段（`agentsRoster*`）仍然统计**完整花名册**：过滤只作用于这一层展示，
							// 否则"内置在、我的不在"这类现场会被过滤掉、以后查不出来 ✗。
							const rows = roster.filter((p) => sourceOf(p) === "mine").map((p) => {
								const broken = p.broken === true;
								// detail 优先用 Agent 自己的描述；加载失败时补一句原因（不假装它没存在过）。
								const detail = broken ? "该 Agent 加载失败（preset 未就绪）" : (typeof p.description === "string" ? p.description : undefined);
								return {
									id: rowKey(p),
									label: rowLabel(p),
									...(detail ? { detail } : {}),
									badge: broken ? "不可用" : "我的",
									group: { name: "mine", label: "我的 Agent" },
									// active = 当前会话正在跑的 preset（官方：面板打开时高亮停在这一行 ⇒ 直接回车即"确认当前值"）。
									...(rowKey(p) === current ? { active: true } : {}),
								};
							});
							// 空态提示：一个 VsSaros agent 都没注册时，**明说原因与下一步**（而不是弹层空着）。
							// 不给 badge：官方把 badge 渲染成上标小字，和这行长 detail 挤在一起会互相咬
							// （2026-10-11 截图实测）；行文案本身已经说了"未检测到"，再加「未启用」是重复。
							if (rows.length === 0) {
								rows.push({
									id: HINT_ID,
									label: "未检测到 VsSaros Agent",
									detail: "插件中心 → 随包插件 → agents：安装并启用后，这里会列出 ~/.vssaros/agents 下的全部 Agent",
									group: { name: "mine", label: "我的 Agent" },
								});
							}
							state.agentsOptions = rows.length;
							return rows;
						}),
						onSelect: (option, params) => {
							const id = option && option.id;
							// 空态提示行不是 preset：只说清原因，不切会话（切一个不存在的 preset 只会报错）。
							if (id === HINT_ID) {
								state.agentsHintSeen = true;
								if (bridge && bridge.notify) { bridge.notify("info", "未检测到 VsSaros Agent：请在 VsSaros 插件中心启用 agents 模块"); }
								return;
							}
							// ★ **仅切换人格**（2026-10-11 用户要求）：不再 switchPreset（那会换绑到别的会话），
							// 而是往**当前会话**注入人格切换指令 ⇒ 会话继续、工具/模型不变。
							switchPersona((params && params.sessionId) || state.sessionId, id);
						},
					},
				};
				try {
					if (typeof ctx.effect === "function") { ctx.effect(() => commandUi.register(contribution), "vssaros agents: command contribution"); }
					else { commandUi.register(contribution); }
					state.agentsContribution = true;
				} catch (e) {
					state.agentsContributionError = String((e && e.message) || e);
				}
			} else {
				state.agentsContributionError = "commandUi service unavailable";
			}

			// ── ②「Preset」行：**切换 preset = 新建一个会话**（2026-10-11 用户要求）──────────────
			// 与「Agent」行严格分工：preset 决定会话组合（工具 / 模型 / skills，首回合后 Host 锁定）⇒ 只能
			// 新开会话；agent 只换人格（提示词内容）⇒ 当前会话继续。两行各管一边，免得"同一个动作两种后果"。
			/** Preset 行图标：六边形描边（与 chip 上的 ⬢ 同形），与 Agent 行的人像图标区分开。 */
			function PresetIcon(props) {
				const size = (props && props.size) || 14;
				return react.createElement("svg", {
					width: size, height: size, viewBox: "0 0 16 16", fill: "none",
					stroke: "currentColor", strokeWidth: 1.2, strokeLinejoin: "round", "aria-hidden": "true",
				}, react.createElement("path", { d: "M8 1.6 13.6 4.8v6.4L8 14.4 2.4 11.2V4.8z" }));
			}
			if (commandUi && typeof commandUi.register === "function") {
				const presetContribution = {
					name: "vssaros-presets",
					label: () => "Preset",
					description: () => "切换 Agent preset（新建一个会话）",
					icon: PresetIcon,
					available: () => true,
					ui: {
						kind: "popupSelect",
						searchMode: "substring",
						searchLabels: () => ({
							placeholder: "搜索 preset",
							empty: "没有可选的 preset",
							noResults: "没有匹配的 preset",
						}),
						// 只列 dsh 自带 preset（与 hero 那个 preset 下拉同一口径）；VsSaros agent 归「Agent」行。
						options: () => loadRoster().then((roster) => {
							const current = currentPreset(readSummary(state.sessionId));
							return roster
								.filter((p) => sourceOf(p) !== "mine")
								.map((p) => ({
									id: rowKey(p),
									label: rowLabel(p),
									...(typeof p.description === "string" && p.description ? { detail: p.description } : {}),
									group: { name: "builtin", label: "dsh 自带 preset" },
									...(rowKey(p) === current ? { active: true } : {}),
								}));
						}),
						// ★ 切换 preset = **新建一个会话**（宿主 `bridge.newChat(presetId)`：开新页签并绑该 preset）。
						onSelect: (option) => { newSessionWithPreset(option && option.id); },
					},
				};
				try {
					if (typeof ctx.effect === "function") { ctx.effect(() => commandUi.register(presetContribution), "vssaros presets: command contribution"); }
					else { commandUi.register(presetContribution); }
					state.presetsContribution = true;
				} catch (e) {
					state.presetsContributionError = String((e && e.message) || e);
				}
			} else {
				state.presetsContributionError = "commandUi service unavailable";
			}

			// ── ③④ 输入框 chip（permission 右侧）+ 面板挂载点 ───────────────────────
			try {
				ctx.slots.inject(SLOT_CHIP, () => ctx.slots.register(
					{ name: SLOT_CHIP, id: "vssaros-agent-chip", order: 0 }, AgentChip));
				state.agentsChip = true;
			} catch (e) {
				state.agentsChipError = String((e && e.message) || e);
				// **注册失败要说出来**：`agentsChipError` 只躺在自诊断字段里，而页面没开 CDP 时没人看得见 ✗
				// （2026-10-11 排查"chip 一直不显示"时无法区分"没注册"和"注册了但没人格"）。
				if (bridge && bridge.notify) { bridge.notify("attention", "Agent chip 挂载失败（slot " + SLOT_CHIP + "）：" + state.agentsChipError); }
			}
			try {
				ctx.slots.inject(SLOT_PANEL, () => ctx.slots.register(
					{ name: SLOT_PANEL, id: "vssaros-agents-panel", order: 0 }, AgentsPanel));
				state.agentsPanel = true;
			} catch (e) {
				state.agentsPanelError = String((e && e.message) || e);
			}
			// ── ⑤ 头部 preset 标签：**交回官方渲染**，只在"跑的是 VsSaros agent"时把它藏起来 ──────────
			// 2026-10-12 用户要求（截图红线那枚）：`standard` 要用**官方插件**的形态 —— 官方
			// `AgentPresetLabel`（`dsh-client-ui-agent-preset:355-375`）= 图标 + `title` hover 提示
			// （`text?.description ?? t("headerHint")`），而且它的 `useSessions/useAgentPresets/load/t`
			// 都是注册时 `inject: labelInjected` 注进来的。我们上一版"同 id + 更低 priority 接管"会把官方
			// 组件整个换掉 ⇒ 官方形态与 hover 提示全丢 ✗（截图里只剩我们自绘的 `⬢ standard`）。
			//
			// ⚠ 但不能直接不接管：官方对**所有** preset 都渲染（只有 `preset === undefined` 才返回 null），
			// 而 VsSaros agent 的 preset name **就是 agent 名** ⇒ 头部会冒出 agent 名
			// （2026-10-11 用户要求不要；那个名字归 composer 的 AgentChip 报）。
			// ⇒ 采取"**官方渲染 + 按需隐藏**"：用官方自己注入的 CSS 模块类名生成一条
			// `body[data-vssaros-agent-preset="1"] .<label>{display:none}`，标记跟着当前会话更新。
			// 类名读不到（dsh 改了注入方式）⇒ **退回自绘标签** —— 宁可少 hover 提示，也不能漏出 agent 名 ✓。
			try {
				const labelClass = typeof document === "undefined" ? null : findOfficialPresetLabelClass(document);
				if (labelClass) {
					state.officialPresetLabel = true;
					state.officialPresetLabelClass = labelClass;
					try {
						const tagId = "vssaros/hide-official-preset-label";
						if (!document.querySelector('style[data-vssaros-css="' + tagId + '"]')) {
							const tag = document.createElement("style");
							tag.dataset.vssarosCss = tagId;
							tag.textContent = presetLabelHideCss(labelClass);
							(document.head || document.documentElement).appendChild(tag);
						}
						state.presetLabelHideCss = tagId;
					} catch (e) {
						state.presetLabelHideError = String((e && e.message) || e);
					}
					// 标记：跟着会话快照走（订阅服务本身，不额外注册组件占槽位）。
					const applyMarker = () => {
						try {
							const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
							const snap = sessions && sessions.list ? sessions.list.getSnapshot() : null;
							const row = snap && snap.byId && state.sessionId ? snap.byId[state.sessionId] : null;
							const id = currentPreset(row);
							// ★ 2026-10-13：**模式 preset 不算"我们的 agent"** ✗ —— 它（`vssaros-standard`）要**留在头部**：
							//   官方那枚标签会显示它的 `name`（生成器已给 `name: standard` ✓）⇒ 这正是用户要的
							//   "standard mode ui" ✓。旧条件对任何 `vssaros-` 前缀都藏 ⇒ 头部整片空白 ✗✗。
							//   仍然藏的只有**真 agent**（agent 名归 composer 的 AgentChip 报 ✓，2026-10-11 要求 ✓）。
							const mine = !!id && sourceOf({ id }) === "mine" && !isModePreset(id);
							if (!document.body) { return; }
							if (mine) { document.body.dataset.vssarosAgentPreset = "1"; }
							else { delete document.body.dataset.vssarosAgentPreset; }
							state.presetLabelHidden = mine;
						} catch (e) {
							state.presetLabelMarkError = String((e && e.message) || e);
						}
					};
					applyMarker();
					try {
						const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
						if (sessions && sessions.list && typeof sessions.list.subscribe === "function") {
							sessions.list.subscribe(applyMarker);
						}
					} catch { /* 订阅不上 ⇒ 只按当前状态标一次（最坏是标记晚一拍） */ }
				} else {
					// 退回：自绘标签（同 id + 更低 priority 接管），行为与 2026-10-11 版一致。
					ctx.slots.inject(SLOT_HEADER, () => ctx.slots.register(
						{ name: SLOT_HEADER, id: "agent-preset", order: -10, priority: -1 }, PresetHeaderLabel));
					state.officialPresetLabel = false;
					state.presetLabelFallback = true;
				}
			} catch (e) {
				state.agentsPresetLabelError = String((e && e.message) || e);
			}
		}
		exports.install = install;
		// 仅测试用：纯逻辑（分组/判定/过滤/商店）。
		exports.__test = { sourceOf, rowLabel, rowKey, currentPreset, matches, createStore, BUILTIN_PRESETS, BASE_PRESET, ROW_NAME, SLOT_CHIP, SLOT_PANEL, SLOT_HEADER, personaRequest, findOfficialPresetLabelClass, presetLabelHideCss };
		return module.exports;
	}
});
