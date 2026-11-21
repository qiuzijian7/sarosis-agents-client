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

		/**
		 * ★ 2026-11-21：模式清单**不再写死在页面里**。
		 * dsh 的 `agentPresets.list()` roster 把 Agent(Bot) 与模式混成同一种条目，且没有 kind/source
		 * 字段（官方 seat 自己也靠 id 白名单）⇒ 改由 **Host 汇总各插件 package.json 的
		 * `vssarosModePresets` 声明**，经同源 `/x/chat-surface/api/modes-list` 下发。
		 * 这里只认下发的数据：加/改一个模式只需改那个插件的声明，前端代码与守卫都不动。
		 * ⚠ 路由挂在 dsh 自己的 webServer 上 ⇒ dsh desktop / 全窗（无 VsSaros 控制桥）同源可用。
		 */
		const MODE_LIST_API = "/x/chat-surface/api/modes-list";
		/** 分组标题只是展示文案，不含任何 preset id；catalog 里出现新 group 时按 key 兜底显示。 */
		const GROUP_TITLES = {
			vssaros: "VsSaros 模式（工具面已收敛 + 上下文压缩）",
			dsh: "dsh 原生（不含 VsSaros 工具面收敛）",
			"third-party": "第三方模式（随包内置）",
		};

		/** 把下发的声明表编成索引（纯函数 ⇒ 守卫直接测真实实现，不用复制一份）。 */
		const modeIndex = (catalog) => {
			const rows = (Array.isArray(catalog) ? catalog : []).filter((r) => r && typeof r.id === "string" && r.id.trim());
			const byId = new Map(rows.map((r) => [String(r.id), r]));
			const visible = new Set(rows.filter((r) => r.visible !== false).map((r) => String(r.id)));
			const groupOrder = [];
			const groups = new Map();
			for (const r of rows) {
				if (r.visible === false) { continue; }
				const key = String(r.group || "other");
				if (!groups.has(key)) { groups.set(key, new Set()); groupOrder.push(key); }
				groups.get(key).add(String(r.id));
			}
			return { rows, byId, visible, groupOrder, groups };
		};

		/**
		 * ★ 2026-11-21 修正：catalog 拿不到时**不编造菜单**。
		 * 旧实现按「roster 里 name 缺失」猜官方内置：但 `vssaros-standard` / `vssaros-ptc` /
		 * 第三方档都带 name ⇒ 降级会丢掉它们，反而把声明为 `visible:false` 的官方档放出来，
		 * 3 组塌成 1 组，用户看到的是一份**错误**的菜单（比没有菜单更危险）。
		 * ⇒ 现在返回空索引，由 ModeSeat 渲染一条只读的「模式列表不可用」提示，不冒充任何档。
		 */
		const fallbackIndex = () => modeIndex([]);

		/** 只留下发目录里 visible 的模式；roster 其余行一律是 Agent(Bot) ⇒ 不进菜单。 */
		const modesOf = (presets, index) => {
			const idx = index || modeIndex([]);
			return (presets || []).filter((p) => p && idx.visible.has(String(p.id)));
		};

		/** 显示名 / 描述：目录优先（中文本地化），其余回落 roster。 */
		const labelOf = (p, index) => {
			const id = String((p && p.id) || "");
			const declared = index && index.byId.get(id);
			if (declared && declared.label) { return String(declared.label); }
			return String((p && (p.name || p.id)) || "");
		};
		const descOf = (p, index) => {
			const id = String((p && p.id) || "");
			const declared = index && index.byId.get(id);
			if (declared && declared.desc) { return String(declared.desc); }
			return (p && typeof p.description === "string" && p.description.trim()) ? p.description.trim() : "";
		};

		/**
		 * ★ P0-1（2026-10-22）：当前会话的 preset ⇒ chip 上显示什么。
		 * 旧实现 `modes.find(id === cur) || modes[0]` 会把 Bot 会话显示成菜单第一项 ✗。
		 * 现在按**下发目录**分种类（全都是数据，无 id 硬编码）：
		 *   · mode    目录里 visible 且在 roster 里 ⇒ 显示目录的 label；
		 *   · legacy  目录里声明但 visible:false（隐藏的官方档）⇒ 显示其名 + 标注；
		 *   · bot     其余 roster 行 ⇒「Bot · 名字」；
		 *   · unknown roster 里查无此 id ⇒ 如实显示 id。
		 * 没有当前值（空白会话）⇒ 默认档（isDefault）⇒ 其次 vssaros 组 ⇒ 最后 menu[0]。
		 */
		const resolveCurrent = (presets, currentId, modes, index) => {
			const all = presets || [];
			const idx = index || modeIndex([]);
			const menu = modes || modesOf(all, idx);
			const id = String(currentId || "");
			if (!id) {
				const d = menu.find((m) => m && m.isDefault)
					|| menu.find((m) => m && idx.groups.get("vssaros") && idx.groups.get("vssaros").has(String(m.id)))
					|| menu[0];
				return d ? { id: String(d.id), kind: "mode", label: labelOf(d, idx) } : { id: "", kind: "unknown", label: "" };
			}
			const inMenu = menu.find((m) => m && String(m.id) === id);
			if (inMenu) { return { id, kind: "mode", label: labelOf(inMenu, idx) }; }
			const row = all.find((p) => p && String(p.id) === id);
			const declared = idx.byId.get(id);
			if (declared) {
				const suffix = declared.group === "dsh" ? "（dsh 原生）" : "";
				return { id, kind: "legacy", label: String(declared.label || (row && row.name) || id) + suffix };
			}
			if (row) { return { id, kind: "bot", label: "Bot · " + String(row.name || row.id) }; }
			return { id, kind: "unknown", label: id };
		};

		/**
	 * 把弹层的**视口位置**夹进视口（纯函数 ⇒ 可单测 ✓；与 client.capsule.js **同一份口径** ✓）。
	 *
	 * ★ 2026-10-28（用户报障「点 preset chip，弹出框 UI 位置错误」）：
	 *   模式菜单原来只写 `left: 0`（贴 chip 左缘向右展开）⇒ **没有夹视口** ⇒ chip 靠右时
	 *   菜单越出右缘被裁（与 capsule 菜单"越左缘"是同一族坑）⇒ 一次全改 ✓。
	 *
	 * @param anchor 触发器矩形（视口坐标）：{left, right, bottom}
	 * @param size 菜单尺寸：{w, h}
	 * @param viewport：{vw, vh}
	 * @param align 倾向：'right' = 右缘贴 chip 右缘；'left' = 左缘贴 chip 左缘
	 */
	function fitMenuBox(anchor, size, viewport, align) {
		const vw = viewport && viewport.vw ? viewport.vw : 0;
		const vh = viewport && viewport.vh ? viewport.vh : 0;
		const w = size && size.w ? size.w : 0;
		const h = size && size.h ? size.h : 0;
		// 量不到锚点/视口 ⇒ 交出零值由调用方回落（**不猜**位置 ✗）
		if (!anchor || !vw) { return { left: 0, top: 0 }; }
		let left = align === "left" ? anchor.left : anchor.right - w;
		if (left < 8) { left = 8; }                                   // 不越左缘
		if (left + w > vw - 8) { left = Math.max(8, vw - 8 - w); }    // 不越右缘
		let top = anchor.bottom + 4;
		if (vh && top + h > vh - 8) { top = Math.max(8, vh - 8 - h); } // 下方不够就往上收
		return { left: Math.round(left), top: Math.round(top) };
	}

	/**
	 * 菜单 style 的**位置部分**（纯函数 ⇒ 可单测）。
	 *
	 * ★ 2026-11-19（用户报障「模式下拉框 UI 位置错误」）：模式 chip 走 `ALWAYS_CHUNKS`，
	 *   `install(ctx, { bridge, state })` **没有 shell.fitMenu** ⇒ 走本文件的兜底，而兜底仍返回
	 *   旧 `absolute` 口径的 `left: 0`；它写在 `Object.assign` 最后 ⇒ **覆盖**了 `box.left`
	 *   （`position: fixed` 的**视口坐标**）⇒ 菜单被钉在视口最左缘（截图里菜单跑到 chip 左边、
	 *   盖住会话列表），`top` 却还是 chip 下方 ⇒ 看着就是"整体错位"✗✗。
	 *
	 * ⇒ `fitMenu` 只准给**尺寸 / 溢出**；位置字段一律剥掉，再由 `box` 最后拍板 ✓。
	 * @param box `{left, top}` 视口坐标（fitMenuBox 的输出）；null / 零值 = 还没量到
	 * @param fit `fitMenu(...)` 的结果（maxWidth / maxHeight / overflow…）
	 */
	function menuPositionStyle(box, fit) {
		const s = Object.assign({}, fit || {});
		// 位置字段一律不认（含宿主 fitMenu 万一哪天也返回 left）⇒ 不许覆盖视口坐标 ✗
		delete s.left; delete s.right; delete s.top; delete s.bottom;
		if (box && (box.left || box.top)) {
			s.left = box.left; s.top = box.top; s.marginTop = 0; s.visibility = "visible";
		} else {
			// 首帧还没量到：先藏一帧（不许用 left:0 / top:"100%" ⇒ fixed 下会闪到视口左下角 ✗）
			s.left = 0; s.top = 0; s.marginTop = 0; s.visibility = "hidden";
		}
		return s;
	}

	function install(ctx, shell) {
			// ⚠ 无桥环境（dsh desktop / dsh 全窗）：`install(ctx, { bridge, state })` 里 **没有 fitMenu / menus**
			//   ⇒ 状态与夹视口都得自己兜底（否则菜单会溢出视口 ⇒ 下半截点不到 ✗）。
			const state = (shell && shell.state) || {};
			/**
			 * 夹视口：**优先用宿主给的 fitMenu**（与官方/其它 chunk 同一语义）。
			 * ⚠ 无壳时（模式 chip 走 ALWAYS_CHUNKS，`install(ctx, { bridge, state })` 没有 shell）
			 *   兜底只给**尺寸 / 溢出**：菜单现在是 `position: fixed` + **视口坐标**，位置统一由
			 *   `menuPositionStyle(box, …)` 拍板。旧口径在这里返回过「相对容器偏移」(2026-10-21)
			 *   和 `left: 0` (2026-11-19)，两代都把菜单甩到了错误位置 ✗✗。
			 */
			const fitMenu = (shell && typeof shell.fitMenu === "function")
				? shell.fitMenu
				: (anchor) => {
					const vw = (typeof window !== "undefined" && window.innerWidth) || 0;
					const vh = (typeof window !== "undefined" && window.innerHeight) || 800;
					// ⚠ 只给**尺寸 / 溢出**，绝不给 left/top：菜单已改 `position: fixed` + 视口坐标，
					//   旧兜底那句 left 是 absolute 口径 ⇒ 会把菜单钉到视口最左缘 ✗✗
					//   （2026-11-19 用户报障「模式下拉框 UI 位置错误」）。
					const bottom = anchor && typeof anchor.bottom === "number" ? anchor.bottom : 220;
					const s = {
						overflowY: "auto", overflowX: "hidden",
						maxHeight: Math.max(160, Math.min(360, vh - bottom - 16)),
					};
					// 菜单比视口还宽时，只夹 left 也没用 ⇒ 宽度也夹住（描述行自带 ellipsis ✓）
					if (vw > 0) { s.maxWidth = Math.max(160, vw - 24) + "px"; }
					return s;
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

			/** 模式目录：Host 汇总各插件 `vssarosModePresets` 声明后下发（同源，无桥环境也可用）。
			 *  拿不到 → 返回空数组，ModeSeat 用 `fallbackIndex` 降级并如实记一句，不假装成功。 */
			const loadCatalog = () => {
				if (typeof fetch !== "function") {
					state.modeCatalogError = "fetch unavailable";
					return Promise.resolve([]);
				}
				return Promise.resolve(fetch(MODE_LIST_API, { credentials: "same-origin", cache: "no-store" }))
					.then((r) => (r && r.ok && typeof r.json === "function" ? r.json() : null))
					.then((v) => (v && v.ok && Array.isArray(v.modes) ? v.modes : []))
					.catch((e) => { state.modeCatalogError = String((e && e.message) || e); return []; });
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
				const [catalog, setCatalog] = react.useState(null);
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
					Promise.all([loadRoster(), loadCatalog()]).then(([list, rows]) => {
						if (dead) { return; }
						setPresets(list);
						setCatalog(rows);
					});
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
				// ★ 2026-10-28（与 client.capsule.js 同一类坑，一起改）：菜单原来只写
				//   `left: 0`（贴着 chip 左缘向右展开）⇒ **没有夹视口** ⇒ chip 靠右时菜单越出右缘被裁 ✗
				//   （用户报的"弹出框 UI 位置错误"就是这一族：菜单被视口裁掉一半）。
				//   ⇒ 量一次菜单真实尺寸，把位置**夹进视口**（左右都不许越界）✓。
				//   ⚠ 位置是**视口坐标**（菜单 `position: fixed`）⇒ 不是相对 chip 容器的偏移 ✓。
				// ★ 2026-11-19：定位改走 layout effect（浏览器绘制前算完）⇒ 首帧不会先闪到别处 ✗；
				//   合并样式时也不许让 fitMenu 的旧 `left: 0` 盖掉这份坐标（见 menuPositionStyle）。
				const menuRef = react.useRef(null);
				const [box, setBox] = react.useState(null); // {left, top} 视口坐标
				const usePlaceEffect = react.useLayoutEffect || react.useEffect;
				usePlaceEffect(() => {
					if (!open) { setBox(null); return undefined; }
					const place = () => {
						try {
							const chip = rootRef.current; const menu = menuRef.current;
							if (!chip || !menu || typeof chip.getBoundingClientRect !== "function") { return; }
							const cr = chip.getBoundingClientRect();
							const mr = typeof menu.getBoundingClientRect === "function" ? menu.getBoundingClientRect() : null;
							const vw = typeof window !== "undefined" ? window.innerWidth : 0;
							const vh = typeof window !== "undefined" ? window.innerHeight : 0;
							if (!vw) { return; }   // 量不到视口 ⇒ 保持隐藏，不猜位置 ✗
							const mw = mr && mr.width ? mr.width : 300;
							const mh = mr && mr.height ? mr.height : 240;
							// ★ 夹进视口（纯函数口径，与 client.capsule.js 同一份逻辑 ✓）
							//   ⇒ 坐标是**视口坐标**（配 position: fixed 用）⇒ 不再减容器偏移 ✓
							const pos = fitMenuBox({ left: cr.left, right: cr.right, bottom: cr.bottom }, { w: mw, h: mh }, { vw, vh }, "left");
							setBox({ left: pos.left, top: pos.top });
						} catch { /* 量不到就保持默认位置 */ }
					};
					place();
					const t = setTimeout(place, 60);   // 内容稳定后再量一次（宽度会变）✓
					if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
						window.addEventListener("resize", place);
						return () => { clearTimeout(t); window.removeEventListener("resize", place); };
					}
					return () => { clearTimeout(t); };
				}, [open]);

				if (!presets || !catalog) { return null; }
				// 目录为空（端点不可用 / 老构建）⇒ **不编造菜单**：只显示一枚只读 chip + 原因。
				// 旧实现会按 roster 猜出一份错误菜单（丢 VsSaros 档、放出隐藏官方档）⇒ 已废弃。
				if (catalog.length === 0) {
					const row = (presets || []).find((p) => p && String(p.id) === String(staged || currentOf(sid)));
					return react.createElement("button", {
						type: "button",
						"data-vssaros-mode-seat": "1",
						disabled: true,
						title: state.modeCatalogError || "模式列表不可用（Host 未下发目录）⇒ 请刷新页面或重启 dsh Host",
						style: {
							display: "inline-flex", alignItems: "center", gap: 4,
							padding: "1px 8px", borderRadius: 999, cursor: "default",
							border: "1px solid var(--dsw-alias-state-error-primary, #f85149)",
							background: "transparent", color: "var(--dsw-alias-label-secondary, currentColor)",
							fontSize: 11, lineHeight: "18px", whiteSpace: "nowrap",
						},
					}, "⬢ " + (row ? String(row.name || row.id) : "模式") + " ⚠");
				}
				const idx = modeIndex(catalog);
				const modes = modesOf(presets, idx);
				if (modes.length === 0) { return null; }
				// ★ P0-1：当前名称在**全量 roster** 里查（不再回落 modes[0] ⇒ 不会把 Bot 会话冒充成模式 ✗）。
				const resolved = resolveCurrent(presets, staged || currentOf(sid), modes, idx);
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
					// -- 分组：完全由下发目录的 `group` 决定 ------------------------------------
					// 历史背景（2026-10-21 用户报「分不清模式」）：dsh 原生档与 VsSaros 档是两个不同维度，
					// 摊平了用户只看到一串模式 ⇒ 按「差异在哪」分组。2026-11-21 起组名与成员都来自
					// `vssarosModePresets` 声明（新增一组不必改这里），标题只是展示文案、按 key 兜底。
					const groups = idx.groupOrder.map((key) => ({
						key,
						title: GROUP_TITLES[key] || "其他模式",
						items: modes.filter((m) => idx.groups.get(key).has(String(m.id))),
					}));
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
									react.createElement("span", { style: { fontWeight: m.id === cur ? 600 : 400, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, labelOf(m, idx)),
									descOf(m, idx) ? react.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary, currentColor)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, descOf(m, idx).slice(0, 48)) : null)));
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
						ref: menuRef,
						// ⚠ 锚点方向：本 chip 在输入框上方、页面中部 ⇒ 菜单**向右**展开（写右对齐会越过左边缘被裁 ✗）。
						// ⚠ 夹视口时必须把**触发器矩形**交出去（只按整页高算 ⇒ 面板底部溢出、滚不到 ✗）。
						// ★ 2026-10-28：位置改由「夹进视口」的效果算（`box`，**视口坐标**）⇒ 不再只写 `left: 0`
						//   （那样 chip 靠右时菜单越出右缘、被裁一半 ✗ —— 与 capsule 菜单同一族坑）。
						// ⚠ **`position: fixed`**：absolute + zIndex 只在**祖先层叠上下文**内比较 ⇒ 菜单会被
						//   dsh 自己的浮层/页签条压住 ⇒ 看起来"层级错误"✗（与工作区菜单同口径 ✓）。
						// ★ 2026-11-19：`fitMenu` 的结果只当**尺寸**用，位置由 menuPositionStyle(box) 最后拍板
						//   （旧兜底返回 `left: 0` ⇒ 覆盖 fixed 的视口坐标 ⇒ 菜单飞到视口最左缘 ✗✗）。
						style: Object.assign({
							position: "fixed",
							zIndex: 1000,
							padding: 5, borderRadius: 10,
							border: "1px solid var(--dsw-alias-border-l1, transparent)",
							background: "linear-gradient(var(--dsw-alias-bg-layer-1, transparent), var(--dsw-alias-bg-layer-1, transparent)), var(--dsw-alias-bg-base, #1e1e1e)",
							boxShadow: "0 8px 24px rgba(0,0,0,.35)",
						}, menuPositionStyle(box, fitMenu(rootRef.current ? rootRef.current.getBoundingClientRect() : null))),
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
		exports.__test = { MODE_LIST_API, GROUP_TITLES, modeIndex, fallbackIndex, modesOf, labelOf, descOf, resolveCurrent, fitMenuBox, menuPositionStyle };
		return module.exports;
	}
});

