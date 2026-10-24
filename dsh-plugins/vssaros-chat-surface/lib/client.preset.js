// @vssaros/dsh-chat-surface — **模式（preset）选择器**（hero 区）
//
// ── 为什么又自绘（2026-10-21 用户指令：「把 agent 定位成 Bot，不要让 agent 作为 preset 呈现」）──
// 官方 `AgentPresetSeat`（`@deepseek-ai/dsh-client-ui-agent-preset`）的菜单 = **roster 全量**
//   （`presetOptions()` 只过滤 `broken`，**没有按 kind 过滤**）⇒ 我们的 22 个内置 agent + 用户自建
//   agent 全部与"标准模式 / PTC 模式"并排出现在同一个下拉里 ⇒ 用户看到的是"模式 + 一堆 agent 混排"
//   ⇒ **官方 seat 无法满足"agent 不作为 preset 呈现"**（唯一的官方过滤维度是 broken，而 broken 的行
//   也不能被选中 ⇒ 不能拿它当"隐藏 agent"的开关）。
// ⇒ 因此这一格**由我们接管**：只列**模式类** preset（dsh 自带 4 个 + 我们的 3 个"档"），
//   agent 一律不进 ⇒ 它们改从「+」菜单 → **Bots** 入口选（对标 DeepSeekBot 的 PersonaBot：
//   bot 是"谁"，preset 是"怎么干" —— bot 不该以 preset 的身份出现 ✓）。
//
// ── 切换走**官方 remote API**，不走宿主页面桥（这是 0.2.177 之前那枚自绘 chip 失效的根因 ✗）──
//   `ctx.remote.agentPresets.select(sessionId, id)`（官方 seat 内部用的同一条，见
//   `dsh-client-ui-agent-preset/lib/client.js:2079`）⇒ 没有宿主桥的环境（dsh desktop / dsh 全窗）
//   **照样能切** ✓；`ctx.remote.agentPresets.list()` 取花名册（同官方）✓。
//   ⇒ 与官方 seat 的语义完全一致：**有当前会话 ⇒ 热切换（Host 拒绝会给原因）；无会话 ⇒ 只预选**
//   （下一个新任务用该模式）✓。
//
// ⚠ 与官方的差别：官方菜单每项带一行描述（内置 preset 走本地化文案）⇒ 我们拿不到那份本地化，
//   故**只显示能确证的信息**：名称 + roster 里的描述（我们的 3 个档有 ⇒ 显示；dsh 自带的 4 个没有
//   ⇒ 不显示第二行，避免"暂无描述。"这种空行）。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.preset.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		/** dsh 自带的 4 个模式（官方 preset id，无前缀）。 */
		const BUILTIN_MODES = ["standard", "ptc", "minimal", "cordis"];
		/** 我们的 2 个模式（官方模式的逐字副本 + 我们的模块行/工具面；见 `vssaros-agents/cordis.presets.yml`）。
		 *  ⚠ `vssaros-full`（标准档·全工具）**已退役**：它与标准模式**逐字相同、只差 denyTools 清单**
		 *   ⇒ "放开场景类工具"改由**一个运行期开关**承担（工具面预算从 preset 清单改为可切换）✓。 */
		const OUR_MODES = ["vssaros-standard", "vssaros-ptc"];
		/**
		 * 模式白名单（唯一真源 ⇒ 守卫会盯）—— **只有 4 个**（2026-10-21 用户拍板）：
		 *   `vssaros-standard`（标准模式（VsSaros））/ `vssaros-ptc`（PTC 模式（VsSaros））
		 *   / `minimal`（极简模式）/ `cordis`（创造模式）。
		 * ⚠ 官方的 `standard` / `ptc` **故意不列** —— 它们与我们的两个模式是同一件事的两种版本
		 *   （我们那份 = 官方副本 + 我们的能力模块 + 工具面预算）⇒ 并列只会让人分不清。
		 *   它们仍在 roster 里（可被 API / 命令面板选中），但**模式菜单里看不到** ✓。
		 * ⚠ 我们的 `vssaros-full`（标准档·全工具）也不列 —— 与标准模式只差 denyTools 清单，
		 *   "放开场景类工具"改由**一个开关**承担（工具面预算从 preset 清单改为运行期开关）。
		 * ★ 剩下的 roster 行一律是 agent（Bot）⇒ 不进这个菜单 ✓。
		 */
		const MODE_IDS = new Set([...OUR_MODES, "minimal", "cordis"]);
		/**
		 * dsh 自带 4 个模式的**本地化名 + 一句说明**。
		 *
		 * ⚠ 为什么自己写：官方那套本地化在 `dsh-client-ui-agent-preset` 包内部（`presetDisplayText`），
		 *   拿不到 ⇒ 直接用 roster 的 name 会退回**内部 id**（"standard / ptc / minimal / cordis" ✗
		 *   —— 用户一眼看不出是模式）。我们自己给一份中文名 + 一句说明 ⇒ 与界面语言一致 ✓。
		 *   （只写**简短说明**，不复刻官方的整段文案 ✓。）
		 */
		const BUILTIN_MODE_COPY = {
			standard: { name: "标准模式", desc: "通用档：代码、文件与资料，按需使用检索 / 编辑 / 终端等工具。" },
			ptc: { name: "PTC 模式", desc: "标准模式之上，工具以批量调用方式呈现，适合筛选 / 整理 / 汇总类任务。" },
			minimal: { name: "极简模式", desc: "只留终端与图片读取（知识库 / 记忆 / 看板等模块照常可用），适合测试与基线对比。" },
			cordis: { name: "创造模式", desc: "用对话定制 DSH —— 让 Agent 写插件、加功能；我们的知识库 / 记忆 / 看板等模块同样可用。" },
		};

		/**
		 * 只留模式（★ 本组件存在的全部理由）。
		 * ⚠ 放在 **factory 层**（不是 install 内）：守卫与单测都直接引用它 ⇒ 测的就是**真实实现**，
		 *   不会出现"导出的是一个副本、实现是另一个"的假绿 ✗（记忆：相对比较型断言会恒真 ⇒ 必须钉绝对期望值）。
		 */
		const modesOf = (presets) => (presets || []).filter((p) => p && MODE_IDS.has(String(p.id)));

		/** 已退役、但 roster 里仍在的我们的档（不进菜单；当前会话若挂在它上面要如实显示 ⇒ 不能冒充 Bot）。 */
		const RETIRED_MODES = ["vssaros-full"];

		/** 显示名 / 描述（factory 层 ⇒ 菜单渲染与 resolveCurrent 共用同一份 ✓）。 */
		const labelOf = (p) => {
			const id = String((p && p.id) || "");
			const copy = BUILTIN_MODE_COPY[id];
			if (copy) { return copy.name; }
			return String((p && (p.name || p.id)) || "");
		};
		const descOf = (p) => {
			const id = String((p && p.id) || "");
			const copy = BUILTIN_MODE_COPY[id];
			if (copy) { return copy.desc; }
			return (p && typeof p.description === "string" && p.description.trim()) ? p.description.trim() : "";
		};

		/**
		 * ★ P0-1（2026-10-22）：当前会话的 preset ⇒ chip 上显示什么。
		 * 旧实现 `modes.find(id === cur) || modes[0]`：会话跑的**不是**菜单里 4 个模式之一时（以 agent preset
		 *   打开的 Bot 会话 / 早先用官方 standard·ptc 建的老会话），chip 显示 **modes[0]** —— 按 roster 顺序就是
		 *   「极简模式」✗✗（菜单里也不打 ✓）⇒ 名不副实。
		 * 新实现：在**全量 roster** 里查当前 id，按种类给出真实名称：
		 *   · mode    菜单里的 4 个之一 ⇒ 显示其名；
		 *   · legacy  官方 standard/ptc、或已退役的 vssaros-full（不在菜单但真实存在）⇒ 显示其名 + 标注；
		 *   · bot     其余 roster 行（agent 在 dsh 内部以 preset 存在）⇒「Bot · 名字」；
		 *   · unknown roster 里查无此 id ⇒ 如实显示 id（**不冒充**任何模式）。
		 * 没有当前值（空白会话）⇒ 默认档（isDefault）⇒ 其次我们的标准模式 ⇒ 最后才是 menu[0]。
		 */
		const resolveCurrent = (presets, currentId, modes) => {
			const all = presets || [];
			const menu = modes || modesOf(all);
			const id = String(currentId || "");
			if (!id) {
				const d = menu.find((m) => m && m.isDefault)
					|| menu.find((m) => m && OUR_MODES.indexOf(String(m.id)) >= 0)
					|| menu[0];
				return d ? { id: String(d.id), kind: "mode", label: labelOf(d) } : { id: "", kind: "unknown", label: "" };
			}
			const inMenu = menu.find((m) => m && String(m.id) === id);
			if (inMenu) { return { id, kind: "mode", label: labelOf(inMenu) }; }
			const row = all.find((p) => p && String(p.id) === id);
			if (BUILTIN_MODE_COPY[id]) { return { id, kind: "legacy", label: BUILTIN_MODE_COPY[id].name + "（dsh 原生）" }; }
			if (RETIRED_MODES.indexOf(id) >= 0) { return { id, kind: "legacy", label: String((row && row.name) || id) }; }
			if (row) { return { id, kind: "bot", label: "Bot · " + String(row.name || row.id) }; }
			return { id, kind: "unknown", label: id };
		};

		function install(ctx, shell) {
			// ⚠ 无桥环境（dsh desktop / dsh 全窗）：`install(ctx, { bridge, state })` 里 **没有 fitMenu / menus**
			//   ⇒ 状态与夹视口都得自己兜底（否则菜单会溢出视口 ⇒ 下半截点不到 ✗）。
			const state = (shell && shell.state) || {};
			/**
			 * 夹视口：**优先用宿主给的 fitMenu**（与官方/其它 chunk 同一语义）。
			 * ⚠ 无壳时的兜底**必须返回"相对容器"的偏移**（菜单是 `position:absolute`，容器是
			 *   `position:relative`）—— 之前这里返回了**视口坐标** ⇒ 与容器偏移叠加 ⇒ 菜单飞到
			 *   **右下角**（2026-10-21 用户截图）✗✗。
			 */
			const fitMenu = (shell && typeof shell.fitMenu === "function")
				? shell.fitMenu
				: () => {
					const vh = (typeof window !== "undefined" && window.innerHeight) || 800;
					// 菜单在容器**下方**（CSS top:100%）⇒ 只夹高度；宽度固定由内容决定。
					return { left: 0, maxHeight: Math.max(160, Math.min(360, vh - 220)) };
				};

			/** 花名册（官方同源；失败如实记，不假装"没有模式"）。 */
			const loadRoster = () => {
				try {
					const remote = ctx.remote;
					if (!remote || !remote.agentPresets) {
						state.modeRosterError = "remote.agentPresets unavailable";
						return Promise.resolve([]);
					}
					return Promise.resolve(remote.agentPresets.list()).then((r) => {
						if (r && r.ok && r.value && Array.isArray(r.value.presets)) { return r.value.presets; }
						state.modeRosterError = "list not ok: " + JSON.stringify(r && r.error ? r.error : r).slice(0, 200);
						return [];
					}).catch((e) => { state.modeRosterError = String((e && e.message) || e); return []; });
				} catch (e) {
					state.modeRosterError = String((e && e.message) || e);
					return Promise.resolve([]);
				}
			};

			/** 只留模式（factory 层那个 —— 守卫与单测共用同一份实现 ✓）。 */

			/** 当前会话的 preset（宿主推来的 projection）。 */
			const readSummary = (sid) => {
				try {
					const list = ctx.sessions && ctx.sessions.list;
					const snap = list && list.getSnapshot();
					return sid && snap && snap.byId ? snap.byId[sid] : undefined;
				} catch { return undefined; }
			};
			const currentOf = (sid) => {
				const v = readSummary(sid) && readSummary(sid).projectionValues && readSummary(sid).projectionValues.agentPreset;
				return typeof v === "string" && v ? v : undefined;
			};

			/**
			 * ★ P0-2：Bot 入口（client.botEntry.js）的可见反馈 —— 两个 chunk 共享同一个 `state`
			 *   ⇒ 共享这个 store（形状 `{get,set,subscribe}` 与 botEntry 那边**完全一致**；谁先装谁建）✓。
			 */
			const botNotice = state.vssarosBotNotice || (() => {
				let value = null;
				const listeners = new Set();
				const store = {
					get: () => value,
					set: (v) => {
						value = v;
						for (const l of [...listeners]) { try { l(); } catch { /* 不连坐 */ } }
					},
					subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
				};
				state.vssarosBotNotice = store;
				return store;
			})();

			function ModeSeat(props) {
				const sid = props && props.sessionId ? props.sessionId : state.sessionId;
				const [presets, setPresets] = react.useState(null);
				const [open, setOpen] = react.useState(false);
				const [staged, setStaged] = react.useState("");
				const [err, setErr] = react.useState(null);
				const [busy, setBusy] = react.useState(false);
				const rootRef = react.useRef(null);
				const [note, setNote] = react.useState(() => botNotice.get());

				// ★ P0-2：订阅 Bot 入口的反馈（预选 / 已切换 / 失败原因）⇒ 显示在 chip 旁边；「已切换」6 秒后自动收起。
				react.useEffect(() => botNotice.subscribe(() => setNote(botNotice.get())), []);
				react.useEffect(() => {
					if (!note || note.kind !== "done") { return; }
					const t = setTimeout(() => { if (botNotice.get() === note) { botNotice.set(null); } }, 6000);
					return () => clearTimeout(t);
				}, [note]);

				react.useEffect(() => {
					let dead = false;
					loadRoster().then((list) => { if (!dead) { setPresets(list); } });
					return () => { dead = true; };
				}, []);

				// 点外面 / Esc 关闭。
				react.useEffect(() => {
					if (!open) { return; }
					const close = (ev) => {
						if (rootRef.current && ev.target && rootRef.current.contains(ev.target)) { return; }
						setOpen(false);
					};
					const esc = (ev) => { if (ev.key === "Escape") { setOpen(false); } };
					document.addEventListener("mousedown", close, true);
					document.addEventListener("keydown", esc, true);
					return () => {
						document.removeEventListener("mousedown", close, true);
						document.removeEventListener("keydown", esc, true);
					};
				}, [open]);

				// 菜单互斥（同 client.workspace.js：多菜单叠加时被裁的部分也像"被遮挡"）。
				react.useEffect(() => {
					if (!open || !shell.menus) { return; }
					shell.menus.closeOthers(MENU_ID);
					return shell.menus.register(MENU_ID, () => setOpen(false));
				}, [open]);

				if (!presets) { return null; }
				const modes = modesOf(presets);
				if (modes.length === 0) { return null; }
				// ★ P0-1：当前名称在**全量 roster** 里查（不再回落 modes[0] ⇒ 不会把 Bot 会话显示成「极简模式」✗）。
				const resolved = resolveCurrent(presets, staged || currentOf(sid), modes);
				const cur = resolved.id;
				const curLabel = resolved.label || cur;

				const pick = (id) => {
					if (id === cur || busy) { return; }
					setOpen(false);
					setStaged(id);
					setErr(null);
					// 无会话 ⇒ 只预选（官方同语义：下一个新任务用它）。
					if (!sid) { state.modeStaged = id; return; }
					setBusy(true);
					// ★ 官方机制（与官方 seat 内部同一条）⇒ 不依赖宿主桥 ⇒ 桌面/全窗也能切 ✓。
					Promise.resolve(ctx.remote.agentPresets.select(sid, id)).then((r) => {
						setBusy(false);
						if (r && r.ok) { state.modeSwitched = id; return; }
						const reason = (r && r.error && (r.error.message || (r.error.details && r.error.details.reason))) || "切换被拒绝";
						setErr(String(reason));
						state.modeSwitchError = String(reason);
					}).catch((e) => {
						setBusy(false);
						const f = String((e && e.message) || e);
						setErr(f);
						state.modeSwitchError = f;
					});
				};

				const children = [
					react.createElement("button", {
						key: "b",
						type: "button",
						"data-vssaros-mode-seat": "1",
						"aria-haspopup": "menu",
						"aria-expanded": open,
						disabled: busy,
						title: err || "选择模式（Agent 预设）",
						onClick: () => setOpen(!open),
						style: {
							display: "inline-flex", alignItems: "center", gap: 4,
							padding: "1px 8px", borderRadius: 999, cursor: busy ? "default" : "pointer",
							border: "1px solid " + (err ? "var(--dsw-alias-state-error-primary, #f85149)" : "var(--dsw-alias-border-l1, transparent)"),
							background: "var(--dsw-alias-bg-layer-1, transparent)",
							color: "var(--dsw-alias-label-secondary, currentColor)",
							fontSize: 11, lineHeight: "18px", whiteSpace: "nowrap",
						},
					}, "⬢ " + (busy ? "切换中…" : curLabel) + " ▾"),
				];
				if (note && note.text) {
					children.push(react.createElement("span", {
						key: "bot-note",
						"data-vssaros-bot-note": note.kind,
						title: note.text,
						onClick: () => { if (note.kind !== "staged") { botNotice.set(null); } },
						style: {
							fontSize: 11, lineHeight: "18px", maxWidth: 360, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
							cursor: note.kind === "staged" ? "default" : "pointer",
							color: note.kind === "error"
								? "var(--dsw-alias-state-error-primary, #f85149)"
								: "var(--dsw-alias-label-secondary, currentColor)",
						},
					}, (note.kind === "staged" ? "◷ " : note.kind === "done" ? "✓ " : "⚠ ") + note.text));
				}

				if (open) {
					const itemStyle = (m) => ({
						display: "flex", alignItems: "flex-start", gap: 8,
						width: "100%", padding: "6px 8px", border: "none", borderRadius: 7, cursor: "pointer",
						background: m.id === cur ? "var(--dsw-alias-bg-layer-2, transparent)" : "transparent",
						color: "var(--dsw-alias-label-primary, currentColor)",
						fontSize: 12, textAlign: "left",
					});
					const check = (m) => react.createElement("span", {
						key: "c",
						style: { flex: "0 0 14px", width: 14, color: m.id === cur ? "var(--dsw-alias-brand-primary, currentColor)" : "transparent" },
					}, "✓");
					// -- group: dsh built-in modes vs our "tiers" ------------------------------
					// Why group (2026-10-21 user report: "cannot tell these modes apart"):
					// the two groups are DIFFERENT dimensions:
					//   - dsh built-in 4 = tool-presentation / capability shape
					//     (general / batch-call / minimal / conversation-customizable);
					//   - our 3 tiers = OUR capability modules + tool-surface budget
					//     (knowledge base / memory / board mounted or not, how many tools hidden).
					// Flattened together the user just sees "7 modes" and cannot tell them apart.
					// ★ 2026-10-21：分组改成"**差异到底在哪**"（读码+实测的结论）：
					//   我们的 13 个模块**本来就注册在 host plane（全局）** ⇒ 官方 minimal/cordis 同样继承得到
					//   （知识库 / 记忆 / 看板 / 工作流 … 都可用 ✓）⇒ 真正的差别只有 preset 级覆盖这四项：
					//     ① 工具面预算（denyTools：藏 96 个工具 ⇒ 省 ~42k schema token）；② 上下文压缩三件套；
					//     ③ `working_directory` 工具；④ persona（我们删掉了带 {{cwd}} 的那行 ⇒ 由全局层接管）。
					//   ⇒ 标题就说这个差别，别让用户以为"原生模式 = 没有我们的能力" ✗。
					const groups = [
						{ key: "vssaros", title: "VsSaros 模式（工具面已收敛 + 上下文压缩）", items: modes.filter((m) => OUR_MODES.indexOf(String(m.id)) >= 0) },
						{ key: "dsh", title: "dsh 原生（工具全开、无额外压缩）", items: modes.filter((m) => OUR_MODES.indexOf(String(m.id)) < 0) },
					];
					const rows = [];
					for (const g of groups) {
						if (!g.items.length) { continue; }
						rows.push(react.createElement("div", {
							key: "g-" + g.key,
							"data-vssaros-mode-group": g.key,
							style: {
								padding: "6px 8px 2px", fontSize: 10, lineHeight: "14px",
								letterSpacing: ".04em",
								color: "var(--dsw-alias-label-tertiary, currentColor)", opacity: 0.85,
							},
						}, g.title));
						for (const m of g.items) {
							rows.push(react.createElement("button", {
								key: m.id,
								type: "button",
								role: "menuitem",
								"data-vssaros-mode-item": m.id,
								onClick: () => pick(m.id),
								style: itemStyle(m),
							},
								check(m),
								react.createElement("span", { style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } },
									react.createElement("span", { style: { fontWeight: m.id === cur ? 600 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, labelOf(m)),
									descOf(m) ? react.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, currentColor)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, descOf(m).slice(0, 48)) : null)));
						}
					}
					// ★ P0-1：当前会话不在 4 个模式里（Bot 会话 / 老模式）⇒ 菜单里没有 ✓ ⇒ 底部如实说明，
					//   并讲清"切换会发生什么"（agentPresets.select 换的是整个 preset ⇒ Bot 人设会随之卸下）。
					if (resolved.kind === "bot" || resolved.kind === "legacy" || resolved.kind === "unknown") {
						rows.push(react.createElement("div", {
							key: "cur-note",
							"data-vssaros-mode-note": resolved.kind,
							style: {
								margin: "4px 4px 0", padding: "6px 6px 2px", fontSize: 11, lineHeight: "15px",
								borderTop: "1px solid var(--dsw-alias-border-l1, transparent)",
								color: "var(--dsw-alias-label-secondary, currentColor)", maxWidth: 300, whiteSpace: "normal",
							},
						}, "当前会话：" + resolved.label + (resolved.kind === "bot"
							? "。选择上面的模式会让本会话改用该模式（Bot 人设随之卸下；只换人格请用「+」→ Bots）。"
							: "（不在模式菜单内）。选择上面的模式会让本会话改用该模式。")));
					}
					children.push(react.createElement("div", {
						key: "m",
						role: "menu",
						// ⚠ 锚点方向：本 chip 在输入框上方、页面中部 ⇒ 菜单**向右**展开（写 right:0 会越过左边缘被裁 ✗）。
						// ⚠ 夹视口时必须把**触发器矩形**交出去（只按整页高算 ⇒ 面板底部溢出、滚不到 ✗）。
						style: Object.assign({
							position: "absolute", top: "100%", left: 0, marginTop: 4, zIndex: 1000,
							padding: 5, borderRadius: 10,
							border: "1px solid var(--dsw-alias-border-l1, transparent)",
							background: "linear-gradient(var(--dsw-alias-bg-layer-1, transparent), var(--dsw-alias-bg-layer-1, transparent)), var(--dsw-alias-bg-base, #1e1e1e)",
							boxShadow: "0 8px 24px rgba(0,0,0,.35)",
						}, fitMenu(rootRef.current ? rootRef.current.getBoundingClientRect() : null)),
					}, ...rows));				}

				return react.createElement("span", { ref: rootRef, style: { position: "relative", display: "inline-flex", alignItems: "center", gap: 6 } }, ...children);
			}

			/** 菜单互斥 id（同 client.workspace.js）。 */
			const MENU_ID = "vssaros-mode-seat";

			// 注册到 hero 的模式槽（**遮蔽**官方 seat：官方会把 agent 一并列出来 ⇒ 违背本次口径 ✗）。
			const HERO_MODE_SLOT = "conversation.hero.agentPreset";
			try {
				ctx.slots.inject(HERO_MODE_SLOT, () =>
					ctx.slots.register({ name: HERO_MODE_SLOT, id: "vssaros-mode-seat-hero", priority: -10 }, ModeSeat));
				state.modeHero = true;
			} catch (e) {
				state.error = String((e && e.message) || e);
			}
		}
		exports.install = install;
		// 仅测试用：纯逻辑（模式白名单 / 过滤 / 名称）。
		exports.__test = { MODE_IDS, BUILTIN_MODES, OUR_MODES, modesOf, resolveCurrent };
		return module.exports;
	}
});

