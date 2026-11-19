// @vssaros/dsh-chat-surface — hero worktree checkbox / 输入框信息 chip（2026-11-14）
// 稿面：doc/dsh-hero-worktree-checkbox-mockup.html（用户已确认「执行」）
//
// ── 三处 UI，一个共享状态 ──────────────────────────────────────────────────
//  · ① hero 聊天框上方：工作区 chip 右侧、preset chip 左侧的 worktree checkbox
//    （官方 WorkspaceChip 写死在 heroWorkspaceRow；我们的 hero 槽是 single ⇒
//     用 DOM 注入插到 **ModeSeat 的 `data-vssaros-mode-seat` 锚点之前**，位置精确 ✓）
//  · ② 输入框工具行的信息 chip：`conversation.input.left`（仓库已登记的多条目槽）。
//    ⚠ 官方 `＋ Full access` 在 `uV2eYG_dock`、`＋` 在 `uV2eYG_accessory`，两个容器；
//      页面侧没有 permission chip 的稳定锚点 ⇒ 本实现落在 input.left 工具行（视觉相邻），
//      不做上游 DOM 搬迁（搞不定也不该搞）。稿面已把这点列为待确认。
//  · ③ 会话 item 右侧标志：由 client.workspaces.js 的 renderSessionRow 读同一份状态渲染。
//
// ── 状态共享 ───────────────────────────────────────────────────────────────
//  chunk 之间不能互相 require（purity gate）⇒ 沿用本仓 worktree 推送的同款范式：
//  `document.documentElement.dataset.vssarosWorktreeChip` + DOM 事件。
//  插件晚于事件加载也能靠 dataset 读到初值 ✓。
//
// ── 诚实的边界（重要）─────────────────────────────────────────────────────
//  页面桥只有 `switchWorktree(path)`（切到**已存在**目录）与只读的 worktree 列表推送。
//  IDE 侧 `IWorktreeService` 虽有 createWorktree/removeWorktree，但 dsh 页面桥没暴露
//  ⇒ 本实现按**显式能力探测**调用 `bridge.createWorktree` / `bridge.removeWorktree`；
//  桥未提供时明确 notify 并回落到已有 worktree，**绝不假装创建成功**。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.worktreeChip.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const SLOT_INPUT = "conversation.input.left";
		const ENTRY_ID = "vssaros-wt-info-chip";
		const ENTRY_ORDER = 1; // AgentChip 是 0 ⇒ 取 1，不 tie ✓
		const CHIP_EVENT = "vssaros-wt-chip";
		const DATA_KEY = "vssarosWorktreeChip";
		const WORKTREE_EVENT = "vssaros-dsh-worktrees";
		const HERO_ANCHOR = '[data-vssaros-mode-seat="1"]'; // client.preset.js:332 的稳定锚点（仅 hero）
		// ★ 2026-11-14 真机「有会话页两处缺 worktree chip」：ModeSeat 只在 hero 空白屏渲染，
		//   header 态没有该锚点 ⇒ 旧 ensureHost 直接 return，会话页永远不出 checkbox，
		//   info chip 也因 dataset 状态一直为空而 return null。
		//   header 态的稳定锚点 = 工作区 chip（client.workspace.js:1452 的 data-vssaros-context-chip）。
		const HEADER_ANCHOR = '[data-vssaros-context-chip="1"]';
		const STYLE_TAG = "data-vssaros-wt-chip-style";
		const ROOT_ATTR = "data-vssaros-wt-checkbox";

		// ── 纯函数（守卫可断言） ─────────────────────────────────────────────
		const NAME_TYPES = ["feat", "fix", "refactor", "chore"];
		const NAME_WORDS = ["quick-followup", "temp-agent-run", "session-scratch", "short-task",
			"side-branch", "transient-fix", "oneoff-check", "draft-patch"];
		/** 行业惯例 Conventional Branch：`<type>/<kebab-slug>-<4hex>`；短 hash 防撞名。 */
		function makeWorktreeName(rand) {
			const r = typeof rand === "function" ? rand : Math.random;
			const t = NAME_TYPES[Math.floor(r() * NAME_TYPES.length) % NAME_TYPES.length];
			const w = NAME_WORDS[Math.floor(r() * NAME_WORDS.length) % NAME_WORDS.length];
			let h = Math.floor(r() * 0x10000).toString(16);
			while (h.length < 4) { h = "0" + h; }
			return t + "/" + w + "-" + h;
		}
		/** 宿主推送的列表 = 已跑过 `git worktree list` ⇒ 有条目即认为「有 git 仓库」。 */
		function parseWorktreeOptions(raw) {
			try {
				const list = raw ? JSON.parse(raw) : [];
				return Array.isArray(list) ? list.filter((w) => w && typeof w.path === "string" && w.path) : [];
			} catch { return []; }
		}
		function isGitEnabled(list) { return Array.isArray(list) && list.length > 0; }
		function optionLabel(w) {
			if (!w) { return "worktree"; }
			if (w.isMain === true) { return "主工作区"; }
			return (typeof w.name === "string" && w.name.trim()) || String(w.path || "").split(/[\\/]/).pop() || "worktree";
		}
		function readChip() {
			try {
				if (typeof document === "undefined" || !document.documentElement) { return null; }
				return parseChip(document.documentElement.dataset[DATA_KEY]);
			} catch { return null; }
		}
		function parseChip(raw) {
			try {
				const v = raw ? JSON.parse(raw) : null;
				return v && typeof v === "object" ? v : null;
			} catch { return null; }
		}
		function writeChip(next) {
			try {
				if (typeof document === "undefined" || !document.documentElement) { return; }
				document.documentElement.dataset[DATA_KEY] = next ? JSON.stringify(next) : "";
				if (typeof window !== "undefined" && window.dispatchEvent) {
					window.dispatchEvent(new Event(CHIP_EVENT));
				}
			} catch { /* 无 DOM：离线探针 */ }
		}

		function normalizeWorktreePath(path) {
			if (typeof path !== "string" || !path) { return ""; }
			const value = path.replace(/\\/g, "/").replace(/\/+$/, "");
			return /^[A-Za-z]:\//.test(value) || value.startsWith("//") ? value.toLowerCase() : value;
		}
		function activeForgeWorktreeOf(panel) {
			const checkout = panel && panel.checkout && panel.checkout.state === "ready" ? panel.checkout.checkout : null;
			if (!checkout || checkout.linked !== true || (panel.worktree && panel.worktree.missing)) { return null; }
			const root = normalizeWorktreePath(checkout.root);
			const cwd = normalizeWorktreePath(panel.directory);
			if (!root || !cwd || (cwd !== root && !cwd.startsWith(root + "/"))) { return null; }
			const name = checkout.branch || checkout.root.split(/[\\/]/).filter(Boolean).pop();
			return name ? { name, path: checkout.root, ephemeral: false } : null;
		}
		function activeWorktreeOf(cwd, pushed, selection) {
			if (typeof cwd !== "string" || !cwd) { return null; }
			const path = normalizeWorktreePath(cwd);
			const match = (Array.isArray(pushed) ? pushed : []).find((w) => w && normalizeWorktreePath(w.path) === path);
			if (match && match.isMain === true) { return null; }
			const selected = selection && selection.path && normalizeWorktreePath(selection.path) === path ? selection : null;
			if (!match && !selected) { return null; }
			const name = (match && typeof match.name === "string" && match.name.trim())
				|| (selected && selected.name) || cwd.split(/[\\/]/).filter(Boolean).pop();
			return name ? { name, path: cwd, ephemeral: !!(selected && selected.ephemeral) } : null;
		}

		// ── 样式（幂等注入） ─────────────────────────────────────────────────
		function injectStyle() {
			try {
				if (typeof document === "undefined" || document.querySelector("[" + STYLE_TAG + "]")) { return; }
				const st = document.createElement("style");
				st.setAttribute(STYLE_TAG, "1");
				st.textContent = ""
					// checkbox：对齐 ContextEntry / ModeSeat 的 999 圆角 chip
					+ ".vssaros-wt-check{position:relative;display:inline-flex;align-items:center;gap:5px;max-width:190px;height:22px;padding:1px 8px 1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,transparent);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary,currentColor);font:inherit;font-size:11px;line-height:18px;white-space:nowrap;cursor:pointer;user-select:none;overflow:hidden;flex:none}"
					+ ".vssaros-wt-check input{appearance:none;-webkit-appearance:none;width:12px;height:12px;flex:none;margin:0;border:1px solid var(--dsw-alias-border-l2,#3e3e3e);border-radius:3px;background:var(--dsw-alias-bg-base,transparent);position:relative;cursor:pointer}"
					+ ".vssaros-wt-check input:checked{background:#4176e6;background:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4176e6);border-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4176e6)}"
					+ ".vssaros-wt-check input:checked::after{content:'';position:absolute;left:3px;top:0;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(42deg)}"
					+ ".vssaros-wt-check[aria-disabled='true']{opacity:.45;cursor:not-allowed}"
					+ ".vssaros-wt-check[aria-disabled='true'] input{cursor:not-allowed}"
					+ ".vssaros-wt-check[aria-checked='true']{border-color:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4176e6);color:var(--dsw-alias-label-primary,currentColor);background:var(--dsw-alias-bg-layer-2,transparent)}"
					+ ".vssaros-wt-check .lb{overflow:hidden;text-overflow:ellipsis}"
					// 下拉：dshWbModeMenu 的真实数值
					+ ".vssaros-wt-menu{position:absolute;z-index:40;left:0;top:calc(100% + 5px);width:min(258px,calc(100vw - 24px));display:grid;grid-auto-rows:max-content;gap:2px;padding:5px;max-height:260px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2,#3e3e3e);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#1b1b1c);box-shadow:0 12px 28px rgba(0,0,0,.28)}"
					+ ".vssaros-wt-menu[hidden]{display:none}"
					+ ".vssaros-wt-opt{display:grid;grid-template-columns:18px minmax(0,1fr) 16px 16px;align-items:center;gap:8px;min-height:34px;padding:6px 8px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;text-align:left;cursor:pointer}"
					+ ".vssaros-wt-opt:hover,.vssaros-wt-opt:focus-visible{background:var(--dsw-alias-bg-layer-2,#262626);outline:none}"
					+ ".vssaros-wt-opt-new{border:1px dashed var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4176e6);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}"
					+ ".vssaros-wt-opt .lb{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
					+ ".vssaros-wt-opt .lb small{display:block;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary,#737373)}"
					+ ".vssaros-wt-opt .ck{font-size:12px;text-align:center}"
					+ ".vssaros-wt-new-tag{display:inline-block;margin-left:5px;padding:0 4px;border-radius:4px;background:rgba(226,160,63,.18);color:var(--dsw-alias-state-warn-primary,#e2a03f);font-size:9px;line-height:14px}"
					+ ".vssaros-wt-rename{width:16px;height:16px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary,#737373);font-size:11px;line-height:16px;text-align:center;cursor:pointer;padding:0}"
					+ ".vssaros-wt-rename:hover{background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.1))}"
					+ ".vssaros-wt-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1,#333)}"
					+ ".vssaros-wt-tip{display:none;position:absolute;top:calc(100% + 6px);right:0;z-index:41;width:max-content;max-width:220px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-label-primary,#e6e6e6);color:var(--dsw-alias-bg-base,#151517);font-size:11px;line-height:17px;box-shadow:0 6px 18px rgba(0,0,0,.18);pointer-events:none}"
					+ ".vssaros-wt-check:hover .vssaros-wt-tip{display:block}"
					// 输入框信息 chip
					+ ".vssaros-wt-info{display:inline-flex;align-items:center;gap:5px;height:20px;max-width:210px;padding:0 8px 0 6px;border-radius:999px;border:1px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4176e6);background:var(--dsw-alias-bg-layer-2,#262626);color:var(--dsw-alias-label-primary,#e6e6e6);font-size:10.5px;line-height:18px;white-space:nowrap;overflow:hidden}"
					+ ".vssaros-wt-info .nm{overflow:hidden;text-overflow:ellipsis;font-weight:600}"
					+ ".vssaros-wt-info .rt{flex:none;color:var(--dsw-alias-label-tertiary,#737373);font-size:10px}"
					+ ".vssaros-wt-info .eph{flex:none;padding:0 4px;border-radius:4px;background:rgba(226,160,63,.18);color:var(--dsw-alias-state-warn-primary,#e2a03f);font-size:9px;line-height:14px}"
					+ ".vssaros-wt-info{cursor:default;user-select:text}"
					// 会话 item 右侧标志（renderSessionRow 用）
					+ ".vssaros-ws-wt-badge{display:inline-flex;align-items:center;gap:5px;flex:none;height:20px;padding:0 7px 0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,#333);background:var(--dsw-alias-bg-layer-2,#262626);color:var(--dsw-alias-label-secondary,#a3a3a3);font-size:10px;line-height:18px;white-space:nowrap;margin-right:2px}"
					+ ".vssaros-ws-wt-badge[data-ephemeral='1']{border-style:dashed}"
					+ ".vssaros-ws-wt-badge b{font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6);max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
					+ ".vssaros-ws-wt-badge .ago{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#737373)}"
					+ ".vssaros-ws-row:hover .vssaros-ws-wt-badge,.vssaros-ws-row[data-menu-open='1'] .vssaros-ws-wt-badge{display:none}";
				document.head.appendChild(st);
			} catch { /* 无 document */ }
		}

		const BRANCH_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="4" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.3"/><circle cx="4" cy="12.5" r="1.6" stroke="currentColor" stroke-width="1.3"/><circle cx="12" cy="8" r="1.6" stroke="currentColor" stroke-width="1.3"/><path d="M4 5.1v5.8M5.6 3.5H8a4 4 0 0 1 4 4M5.6 12.5H8" stroke="currentColor" stroke-width="1.3"/></svg>';

		/** 当前可见的 worktree 选项（新增项永远第一、默认）。 */
		function buildOptions(pushed, newName) {
			const fresh = {
				id: "new", label: "新增 worktree", name: newName,
				path: "", ephemeral: true, isNew: true,
				hint: newName + " · 临时，提交完毕自动删除"
			};
			const rest = (Array.isArray(pushed) ? pushed : []).map((w) => ({
				id: "wt:" + w.path, label: optionLabel(w),
				name: (typeof w.branch === "string" && w.branch) || optionLabel(w),
				path: w.path, ephemeral: false, isNew: false,
				hint: w.path
			}));
			return [fresh].concat(rest);
		}

		function install(ctx, shell) {
			let officialForgeUi = false;
			try {
				officialForgeUi = typeof document !== "undefined" && !!document.documentElement
					&& document.documentElement.dataset.vssarosOfficialForgeUi === "1";
			} catch { /* 无 DOM：离线探针 */ }
			const singletonKey = "__vssarosWtChipSingleton";
			const state = shell.state;
			const bridge = shell.bridge;
			// ★★ 2026-11-14 真机「hero 出现两枚 worktree checkbox」：
			//   `apply` 会因 cordis 上下文重建重跑（client.js:395-396），`loadParts` 每次都
			//   **无条件**再调 `part.install(ctx, shell)`（client.js:1934-1941）。本函数所有状态
			//   （hostEl / menuEl / checked / selected）都在闭包里 ⇒ 第二个实例从 hostEl=null
			//   开始，对着同一个 anchor 又 insertBefore 一枚 ⇒ 两枚并排 ✗；还会重复注册槽条目、
			//   重复挂 window/document 监听与 MutationObserver，且两个实例状态分叉。
			//   ⇒ 全局单例：首次完整初始化；后续只刷新 bridge/state 引用、重新注册槽条目
			//     （apply 重建后槽表可能已清空），**绝不重复注入 DOM / 监听**。
			if (typeof window !== "undefined" && window[singletonKey]) {
				const inst = window[singletonKey];
				inst.bridge = bridge;
				inst.state = state;
				inst.ctx = ctx;
				inst.reinstalls = (inst.reinstalls || 0) + 1;
				try {
					ctx.slots.inject(SLOT_INPUT, () => ctx.slots.register(
						{ name: SLOT_INPUT, id: ENTRY_ID, order: ENTRY_ORDER }, inst.infoComp));
				} catch { /* 槽不可用时保留首次注册 */ }
				state.vssarosWtChip = inst.diag;
				state.vssarosWtChipReinstalls = inst.reinstalls;
				return;
			}
			let options = [];
			let selected = null;
			let checked = false;
			let newName = makeWorktreeName();
			let hostEl = null;
			let observer = null;
			let menuEl = null;
			// ★ 桥 26→27：页面桥是**单向**的，`createWorktree` 的返回值只是「命令已发出」。
			//   记下待创建的分支名，等宿主推送的快照料表里出现它再选中 + 切换（绝不假装成功）。
			let pendingCreate = null;

			const notify = (text) => {
				try {
					// apply 重跑后 bridge 可能换了实例 ⇒ 优先取单例里刷新的引用 ✓
					const inst = typeof window !== "undefined" ? window[singletonKey] : null;
					const b = (inst && inst.bridge) || bridge;
					if (b && typeof b.notify === "function") { b.notify("attention", text); }
				} catch { /* ignore */ }
			};
			const pushedOptions = () => {
				try {
					return parseWorktreeOptions(document.documentElement.dataset.vssarosWorktrees);
				} catch { return []; }
			};
			const gitEnabled = () => isGitEnabled(pushedOptions());

			function publish() {
				const next = checked && selected ? {
					checked: true, name: selected.name, path: selected.path,
					ephemeral: !!selected.ephemeral, isNew: !!selected.isNew
				} : null;
				writeChip(next);
			}

			// ── 真实 worktree 操作（显式能力探测） ───────────────────────────
			function applySelection(opt) {
				if (opt.isNew) {
					if (!bridge || typeof bridge.createWorktree !== "function") {
						notify("当前宿主不支持新建 worktree（页面桥缺 createWorktree）：请选择一个已有 worktree。");
						return false;
					}
					pendingCreate = opt.name;
					let created;
					try { created = bridge.createWorktree(opt.name); } catch (e) { pendingCreate = null; notify("新建 worktree 失败：" + String(e && e.message || e)); return false; }
					Promise.resolve(created).then((w) => {
						// 兼容「旧宿主 / 探针」确实返回路径的形态；单向桥返回 true ⇒ 不报错，
						// 交给 onPush（宿主快照推送）完成选中与切换。
						const path = w && (w.path || (w.detail && w.detail.path));
						if (!path) { return; }
						pendingCreate = null;
						selected = { id: opt.id, label: opt.label, name: opt.name, path: path, ephemeral: true, isNew: true };
						checked = true;
						if (typeof bridge.switchWorktree === "function") { void Promise.resolve(bridge.switchWorktree(path)).catch(() => {}); }
						publish(); renderHost();
					}, (e) => { pendingCreate = null; notify("新建 worktree 失败：" + String(e && e.message || e)); });
					return true;
				}
				if (!bridge || typeof bridge.switchWorktree !== "function") {
					notify("页面桥过旧：不支持切换 worktree（switchWorktree 缺失）");
					return false;
				}
				void Promise.resolve(bridge.switchWorktree(opt.path)).catch((e) => notify("切换 worktree 失败：" + String(e && e.message || e)));
				selected = opt;
				checked = true;
				publish(); renderHost();
				return true;
			}
			function clearSelection(reason) {
				if (selected && selected.ephemeral && bridge && typeof bridge.removeWorktree === "function") {
					void Promise.resolve(bridge.removeWorktree(selected.path)).catch(() => {});
				} else if (selected && selected.ephemeral && reason === "commit") {
					notify("临时 worktree 需由宿主删除（页面桥缺 removeWorktree）；本地状态已清除。");
				}
				pendingCreate = null;
				selected = null;
				checked = false;
				publish(); renderHost();
			}

			// ── 下拉 ───────────────────────────────────────────────────────
			function closeMenu() { if (menuEl) { menuEl.hidden = true; } }
			function renderMenu() {
				if (!menuEl) { return; }
				menuEl.innerHTML = "";
				options = buildOptions(pushedOptions(), newName);
				options.forEach((opt) => {
					const b = document.createElement("button");
					b.type = "button";
					b.className = "vssaros-wt-opt" + (opt.isNew ? " vssaros-wt-opt-new" : "");
					b.setAttribute("role", "menuitemradio");
					b.setAttribute("aria-checked", selected && selected.id === opt.id ? "true" : "false");
					b.setAttribute("data-wt-id", opt.id);
					const ico = document.createElement("span");
					ico.innerHTML = BRANCH_SVG;
					ico.style.color = opt.isNew ? "var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4176e6)" : "var(--dsw-alias-label-tertiary,#737373)";
					const lb = document.createElement("span"); lb.className = "lb"; lb.textContent = opt.label;
					if (opt.isNew) {
						const tag = document.createElement("span"); tag.className = "vssaros-wt-new-tag"; tag.textContent = "默认"; lb.appendChild(tag);
					}
					const sm = document.createElement("small"); sm.textContent = opt.hint; lb.appendChild(sm);
					const ck = document.createElement("span"); ck.className = "ck";
					ck.textContent = selected && selected.id === opt.id ? "✓" : "";
					b.appendChild(ico); b.appendChild(lb); b.appendChild(ck);
					if (opt.isNew) {
						const rn = document.createElement("button");
						rn.type = "button"; rn.className = "vssaros-wt-rename";
						rn.textContent = "↻"; rn.title = "换一个名字"; rn.setAttribute("data-rename", "1");
						rn.addEventListener("click", (e) => {
							e.stopPropagation();
							newName = makeWorktreeName();
							if (selected && selected.isNew) { selected = null; checked = false; publish(); }
							renderMenu(); renderHost();
						});
						b.appendChild(rn);
					}
					b.addEventListener("click", (e) => {
						if (e.target && e.target.closest && e.target.closest("[data-rename]")) { return; }
						e.stopPropagation();
						applySelection(opt);
						closeMenu();
					});
					menuEl.appendChild(b);
					if (opt.isNew) {
						const sep = document.createElement("div"); sep.className = "vssaros-wt-sep"; menuEl.appendChild(sep);
					}
				});
			}
			function openMenu() {
				if (!menuEl) { return; }
				renderMenu();
				menuEl.style.left = "";
				menuEl.hidden = false;
				try {
					const r = menuEl.getBoundingClientRect();
					const vw = window.innerWidth || 0;
					if (vw > 0 && r.right > vw - 8) { menuEl.style.left = Math.max(-r.width + 8, vw - 8 - r.right) + "px"; }
				} catch { /* 无布局信息 */ }
			}

			// ── hero checkbox：插到 ModeSeat 之前 ───────────────────────────
			function renderHost() {
				if (!hostEl || !hostEl.isConnected) { return; }
				const enabled = gitEnabled();
				hostEl.setAttribute("aria-disabled", enabled ? "false" : "true");
				hostEl.setAttribute("aria-checked", checked && enabled ? "true" : "false");
				hostEl.title = enabled
					? ("使用 worktree" + (selected ? "：" + selected.name + (selected.ephemeral ? "（临时，提交完毕自动删除）" : "") : ""))
					: "当前工作区不是 git 仓库，worktree 不可用";
				const input = hostEl.querySelector("input");
				if (input) { input.disabled = !enabled; input.checked = !!(enabled && checked); }
				const lb = hostEl.querySelector(".lb");
				if (lb) { lb.textContent = (checked && selected && enabled) ? ("worktree · " + selected.name) : "worktree"; }
				const tip = hostEl.querySelector(".vssaros-wt-tip");
				if (tip) { tip.textContent = enabled ? "使用 worktree：勾选后默认新增临时 worktree" : "当前工作区不是 git 仓库"; }
			}
			function ensureHost() {
				if (hostEl && hostEl.isConnected) { return hostEl; }
				if (typeof document === "undefined") { return null; }
				// hero 优先：preset chip 存在 ⇒ checkbox 插在它**之前**（工作区 chip 右侧、preset 左侧）。
				// 否则是有会话的 header 态 ⇒ 插在工作区 chip **之后**（同一 chip 簇的右侧）。
				const heroAnchor = document.querySelector(HERO_ANCHOR);
				const anchor = heroAnchor || document.querySelector(HEADER_ANCHOR);
				if (!anchor || !anchor.parentElement) { return null; }
				const el = document.createElement("label");
				el.setAttribute(ROOT_ATTR, "1");
				el.className = "vssaros-wt-check";
				el.innerHTML = '<input type="checkbox"><span class="ico">' + BRANCH_SVG + '</span><span class="lb">worktree</span><span class="vssaros-wt-tip"></span>';
				menuEl = document.createElement("div");
				menuEl.className = "vssaros-wt-menu";
				menuEl.setAttribute("role", "menu");
				menuEl.hidden = true;
				el.appendChild(menuEl);
				el.addEventListener("change", (e) => {
					if (!gitEnabled()) { e.preventDefault(); return; }
					if (!e.target.checked) { clearSelection("uncheck"); closeMenu(); return; }
					// 默认项：预选「新增 worktree」，但**不立刻创建**（创建在下拉点选时发生）
					newName = makeWorktreeName();
					options = buildOptions(pushedOptions(), newName);
					selected = null;
					checked = true;
					publish(); renderHost();
					openMenu();
				});
				if (heroAnchor) {
					anchor.parentElement.insertBefore(el, anchor);           // hero：preset chip 之前
				} else {
					anchor.parentElement.insertBefore(el, anchor.nextSibling); // header：工作区 chip 之后
				}
				hostEl = el;
				return el;
			}
			function ensureObserver() {
				if (observer || typeof MutationObserver === "undefined" || typeof document === "undefined") { return; }
				try {
					observer = new MutationObserver(() => {
						if (hostEl && hostEl.isConnected) { return; }
						hostEl = null; menuEl = null;
						if (ensureHost()) { renderHost(); }
					});
					observer.observe(document.body, { childList: true, subtree: true });
				} catch { /* ignore */ }
			}

			// ── 输入框信息 chip（React 组件） ───────────────────────────────
			/**
			 * ★ 2026-11-14 真机「hero 页面输入框里不显示 worktree chip」：
			 *   hero（空白会话屏）的 chip 簇上已经有那枚 worktree 胶囊了，输入框里再来一枚是重复，
			 *   而且 hero 还没有会话 ⇒ 没有「当前 worktree」可显示。
			 *   判据用官方 ModeSeat 的 DOM 锚点（hero 专属），不用 bridge.sessionId ——
			 *   后者在用户发出第一条消息后才变、且没有页面侧事件可订阅 ✗。
			 */
			const isHeroView = () => {
				try {
					return typeof document !== "undefined" && !!document.querySelector(HERO_ANCHOR);
				} catch { return false; }
			};
			function InfoChip(props) {
				const propSid = props && props.sessionId;
				const [boundSid, setBoundSid] = react.useState(propSid || null);
				const [, refresh] = react.useState(0);
				const [hero, setHero] = react.useState(isHeroView);
				const inst = typeof window !== "undefined" ? window[singletonKey] : null;
				const currentCtx = (inst && inst.ctx) || ctx;
				const currentState = (inst && inst.state) || state;
				let sessions = null;
				try { sessions = typeof currentCtx.get === "function" ? currentCtx.get("sessions") : null; } catch { /* 服务尚未就绪 */ }
				const sid = boundSid || currentState.sessionId || (inst && inst.bridge && inst.bridge.sessionId) || (bridge && bridge.sessionId);
				const [panel, setPanel] = react.useState(null);
				let forge = null;
				try { forge = officialForgeUi && typeof currentCtx.get === "function" ? currentCtx.get("remote.forgePanel") : null; } catch { /* 服务尚未就绪 */ }
				react.useEffect(() => {
					if (!officialForgeUi || hero || !sid || !forge || typeof forge.follow !== "function") { return; }
					let disposed = false;
					let stop = null;
					const follow = () => {
						if (stop) { stop(); }
						const controller = new AbortController();
						let stream = null;
						stop = () => { controller.abort(); if (stream && typeof stream.dispose === "function") { stream.dispose(); } };
						setPanel(null);
						void (async () => {
							try {
								stream = forge.follow(sid, controller.signal);
								for await (const frame of stream) {
									if (disposed || controller.signal.aborted) { break; }
									setPanel({ sessionId: sid, state: frame });
								}
							} catch (e) {
								if (!disposed && !controller.signal.aborted) { currentState.vssarosWtInfoChipError = String((e && e.message) || e); }
							} finally {
								if (!disposed && !controller.signal.aborted) { setPanel(null); }
							}
						})();
					};
					const reset = typeof currentCtx.on === "function" ? currentCtx.on("connection/reset", follow) : null;
					follow();
					return () => { disposed = true; if (typeof reset === "function") { reset(); } if (stop) { stop(); } };
				}, [sid, hero, forge, currentCtx]);
				react.useEffect(() => { setBoundSid(propSid || null); }, [propSid]);
				react.useEffect(() => {
					const on = () => refresh((n) => n + 1);
					const onRebind = (e) => {
						const sid = e && e.detail && e.detail.sessionId;
						if (typeof sid === "string" && sid) { setBoundSid(sid); }
						on();
					};
					window.addEventListener(CHIP_EVENT, on);
					document.addEventListener(WORKTREE_EVENT, on);
					document.addEventListener("vssaros-dsh-rebind", onRebind);
					const sub = sessions && sessions.list && typeof sessions.list.subscribe === "function"
						? sessions.list.subscribe(on) : null;
					const mo = window.MutationObserver ? new window.MutationObserver(() => {
						const v = isHeroView();
						setHero((prev) => (prev === v ? prev : v));
					}) : null;
					if (mo) { try { mo.observe(document.body, { childList: true, subtree: true }); } catch { /* 已卸载 */ } }
					return () => {
						window.removeEventListener(CHIP_EVENT, on);
						document.removeEventListener(WORKTREE_EVENT, on);
						document.removeEventListener("vssaros-dsh-rebind", onRebind);
						if (typeof sub === "function") { sub(); }
						if (mo) { mo.disconnect(); }
					};
				}, [sessions]);
				if (hero) { return null; }
				let cwd = null;
				try {
					const snapshot = sessions && sessions.list ? sessions.list.getSnapshot() : null;
					cwd = snapshot && snapshot.byId && snapshot.byId[sid] && snapshot.byId[sid].cwd;
				} catch { /* 只展示已确认的会话目录 */ }
				const active = officialForgeUi
					? activeForgeWorktreeOf(panel && panel.sessionId === sid ? panel.state : null)
					: activeWorktreeOf(cwd, pushedOptions(), readChip());
				if (!active) { return null; }
				return react.createElement("span", {
					className: "vssaros-wt-info", "data-vssaros-wt-info": "1",
					"data-vssaros-wt-readonly": "1",
					title: "当前 worktree：" + active.name + "\n" + active.path,
				},
					react.createElement("span", { dangerouslySetInnerHTML: { __html: BRANCH_SVG } }),
					react.createElement("span", { className: "nm" }, active.name),
					active.ephemeral ? react.createElement("span", { className: "eph" }, "临时") : null);
			}

			try {
				ctx.slots.inject(SLOT_INPUT, () => ctx.slots.register(
					{ name: SLOT_INPUT, id: ENTRY_ID, order: ENTRY_ORDER }, InfoChip));
				state.vssarosWtInfoChip = true;
			} catch (e) {
				state.vssarosWtInfoChipError = String((e && e.message) || e);
				notify("worktree 信息 chip 挂载失败（" + SLOT_INPUT + "）：" + state.vssarosWtInfoChipError);
			}

			injectStyle();
			if (officialForgeUi) {
				state.vssarosWtChip = { slot: SLOT_INPUT, id: ENTRY_ID, order: ENTRY_ORDER, readonly: true, source: "forgePanel" };
				window[singletonKey] = { bridge, state, ctx, infoComp: InfoChip, diag: state.vssarosWtChip, reinstalls: 0 };
				return;
			}
			ensureHost();
			renderHost();
			ensureObserver();

			// 宿主推送更新 ⇒ enable 态实时刷新；并认领单向桥的创建结果。
			const onPush = () => {
				if (pendingCreate) {
					const hit = pushedOptions().find((w) => w && w.isMain !== true
						&& (w.name === pendingCreate || w.branch === pendingCreate));
					if (hit && typeof hit.path === "string" && hit.path) {
						const name = pendingCreate;
						pendingCreate = null;
						selected = { id: "wt:" + hit.path, label: name, name: name, path: hit.path, ephemeral: true, isNew: true };
						checked = true;
						if (typeof bridge.switchWorktree === "function") { void Promise.resolve(bridge.switchWorktree(hit.path)).catch(() => {}); }
						publish();
					}
				}
				renderHost();
				if (!gitEnabled() && checked) { clearSelection("no-git"); closeMenu(); }
			};
			if (typeof document !== "undefined") { document.addEventListener(WORKTREE_EVENT, onPush); }
			const onOutside = (e) => {
				if (menuEl && !menuEl.hidden && !menuEl.contains(e.target) && hostEl && !hostEl.contains(e.target)) { closeMenu(); }
			};
			if (typeof document !== "undefined") { document.addEventListener("mousedown", onOutside, true); }
			const onKey = (e) => { if (e.key === "Escape") { closeMenu(); } };
			if (typeof window !== "undefined") { window.addEventListener("keydown", onKey, true); }
			// 「提交完毕」：页面侧能观测的信号是会话 turn 结束（commit 语义由宿主定义）。
			// 这里提供一个显式入口，宿主/其它 chunk 可派 `vssaros-wt-chip-commit` 触发临时项清理。
			const onCommit = () => { if (selected && selected.ephemeral) { clearSelection("commit"); closeMenu(); } };
			if (typeof window !== "undefined") { window.addEventListener("vssaros-wt-chip-commit", onCommit); }

			// 便于守卫/诊断读取（不暴露可变内部状态）
			state.vssarosWtChip = { slot: SLOT_INPUT, id: ENTRY_ID, order: ENTRY_ORDER, event: CHIP_EVENT,
				anchor: HERO_ANCHOR, headerAnchor: HEADER_ANCHOR };
			// ★ 全局单例落位（见 install 开头的去重说明）：后续 apply 重跑只换引用。
			if (typeof window !== "undefined") {
				window[singletonKey] = {
					bridge: bridge, state: state, ctx: ctx, infoComp: InfoChip,
					diag: state.vssarosWtChip, reinstalls: 0
				};
			}
		}

		exports.install = install;
		exports.__test = {
			makeWorktreeName, parseWorktreeOptions, isGitEnabled, optionLabel,
			parseChip, readChip, writeChip, buildOptions, activeWorktreeOf, activeForgeWorktreeOf,
			SLOT_INPUT, ENTRY_ID, ENTRY_ORDER, CHIP_EVENT, HERO_ANCHOR, HEADER_ANCHOR, ROOT_ATTR
		};
		return module.exports;
	}
});
