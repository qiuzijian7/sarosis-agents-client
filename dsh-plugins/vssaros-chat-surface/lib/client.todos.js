// @vssaros/dsh-chat-surface — 聊天框内「任务清单」（slot: conversation.input.dock，id `vssaros-todo`，order 10）
// package-local chunk（契约同 client.sessions.js）：主包 lib/client.js 用 require.async("./client.todos.js")
// 取回本模块的 install()。一个文件一个换皮点：并行改动各改各的文件，不再撞同一个 client.js。
//
// ── 为什么加这一枚（2026-10-14 用户要求；调研见 doc/subagent-todo-solution-plan.md §5 P0-1）──
// dsh 自带的 `TodoPanel` 就挂在**同一个槽**（`dsh-client-ui-conversation:17748-17759`，id `todo`、order 0），
// 但它只能整体折叠 —— **单项点击没有任何反应**（那一版 `li` 根本没有 onClick，`:17723-17735`）。
// 用户在聊天框里看得到进度，却"跳不到写这条任务的那次对话" ✗。本 chunk 只做一件事：把**同一份投影**
// （`todos`，主人是 `dsh-tool-todo`）再渲染一份**可定位**的清单 —— 数据只读、**不新建真相** ✓。
//
// ── 三条硬约束（改这个文件前先读）─────────────────────────────────────────────
// ① **数据只读自投影**：`props.useProjection("todos")`。它是槽作用域注入的**标准 props**，
//    不是 require 得到的模块 ✗（`dsh-client-ui-session` 用 declare module 合成的，
//    见该包 `lib/types/client/index.d.ts:77-83`）；本插件只允许 `require("react")`
//    （其他说明符不在 boot graph 里 ⇒ 会抛，见 dsh-client-modules 的 purity gate）。
//    `todos === null` = **从未写过**（不许显示成 `0 / 0` ✗ —— 这是"未知伪装成 0"的老坑），
//    `[]` / 有值 = 最近一次整表快照（`dsh-tool-todo/lib/types/types.d.ts:36,44`）。
// ② **与官方同槽并存**：id 用 `vssaros-todo`、order 取 **10**（官方 `todo`=0、`queue`=20 ⇒ 中间空档 ✓）。
//    官方那枚**保持原样**（它的视觉用户已熟悉，且 dsh 升级时跟着官升 ✓）。
// ③ **单项定位不依赖任何 id**：`TodoItem` 只有 `{content, status}`（该包明确 "no id, priority, or
//    activeForm"，`:14-16`）⇒ 只能按**文本**在对话里找（找到就滚过去闪一下）。**找不到要明确说出来**
//    （`bridge.notify`），不许静默 ✗ —— "点了没反应"是本仓查过多次的坑（见 client.cardActions.js 头注释）。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.todos.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const SLOT = "conversation.input.dock";
		const ENTRY_ID = "vssaros-todo";
		/**
		 * 官方在这一槽的占位：`todo`=**0** / `goal`=**10** / `queue`=**20**（`dsh-client-ui-goal/lib/client.js:557-561` ✓）
		 * ⇒ 取 **5**：唯一与三者都不 tie 且仍靠近官方 todo 的空档 ✓。
		 *
		 * ⚠ 2026-10-14 修正：我们最初取的是 **10** —— 与官方 `goal` **真 tie** ✗（顺序无保证、且不报错 ✗）。
		 *   当时守卫没报警，是因为它的官方占位表**漏登记了 `goal`** ✓（补登后立刻红 ✓）。
		 *   tie 的后果是"谁先谁后看注册时机"，用户会看到两条 dock 时而换位 ✓ —— 这类漂移最难查 ✓。
		 */
		const ENTRY_ORDER = 5;
		/** 定位高亮的持续时间（ms）——够看见即可，别留永久样式（会有"这行被选中了"的错觉 ✗）。 */
		const FLASH_MS = 1400;

		/** 从某元素往上找**可滚动的**祖先（对话区）。找不到 ⇒ 返回 null（调用方退回 document）。 */
		function scrollableAncestor(el) {
			let node = el;
			while (node && node !== document.body) {
				try {
					const s = window.getComputedStyle(node);
					if (s && (s.overflowY === "auto" || s.overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
						return node;
					}
				} catch { /* 取样式失败就继续往上找 ✓ */ }
				node = node.parentElement;
			}
			return null;
		}

		/**
		 * 在 `root` 里按**文本**找这条任务的落点。
		 *
		 * 只匹配**叶子元素**（`childElementCount === 0`）：否则命中的会是包含整段历史的容器，
		 * 滚过去等于没滚 ✗。返回**最后一个**命中（任务清单是"整表替换"语义 ⇒ 最后一次写的更靠近
		 * 当前进度 ✓）。`root` 为 null 时退到 `document`。
		 */
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
			} catch { /* 遍历失败按"没找到"处理 ✓ */ }
			return hit;
		}

		/** 给命中的元素闪一下（用 inline outline，结束即撤 —— 不留任何持久标记 ✓）。 */
		function flash(el) {
			try {
				const prev = el.style.outline;
				el.style.outline = "2px solid var(--dsw-alias-brand-primary, #3794ff)";
				el.style.outlineOffset = "2px";
				window.setTimeout(() => {
					try { el.style.outline = prev; el.style.outlineOffset = ""; } catch { /* 元素已被移除 ✓ */ }
				}, FLASH_MS);
			} catch { /* 高亮失败不影响滚动 ✓ */ }
		}

		/** 进度文案：`null`/空表由调用方早退，这里只处理有内容的两态 ✓。 */
		function progressLabel(done, total) {
			return "任务 " + done + " / " + total + " 已完成";
		}

		const TODO_CSS = {
			wrap: { padding: "6px 10px 2px", borderTop: "1px solid var(--dsw-alias-border-l1, #2f2f2f)" },
			head: {
				display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
				fontSize: 11.5, lineHeight: "18px", color: "var(--dsw-alias-label-secondary, currentColor)",
			},
			title: { fontWeight: 600, color: "var(--dsw-alias-label-primary, #e6e6e6)" },
			caret: { marginLeft: "auto", fontSize: 9, opacity: 0.7 },
			bar: { height: 3, borderRadius: 2, background: "rgba(255,255,255,.10)", margin: "6px 0 0", overflow: "hidden" },
			barFill: { display: "block", height: "100%", background: "var(--dsw-alias-brand-primary, #10b981)" },
			list: { margin: "6px 0 0", padding: 0, listStyle: "none" },
			item: {
				display: "flex", alignItems: "center", gap: 7, padding: "3px 6px", borderRadius: 4,
				fontSize: 11.5, lineHeight: "17px", cursor: "pointer",
			},
			icon: { width: 13, flex: "0 0 auto", textAlign: "center", color: "var(--dsw-alias-label-secondary, currentColor)" },
			textDone: { textDecoration: "line-through", opacity: 0.6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			textDoing: { color: "var(--dsw-alias-label-primary, #e6e6e6)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			textTodo: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			go: { marginLeft: "auto", fontSize: 10.5, color: "var(--dsw-alias-brand-primary, #3794ff)", opacity: 0.85, flex: "0 0 auto" },
			note: { padding: "3px 6px 2px", fontSize: 10.5, opacity: 0.6 },
		};

		/**
		 * 任务清单（dock 内的一枚）。
		 *
		 * 与官方那枚的关系：**并列**，不替代 ✓。差异只有一点 —— 每条**可点**（定位到写它的那次对话）。
		 * 默认展开与否按"有没有进行中的任务"决定（有 ⇒ 展开，进度是用户此刻最想看的 ✓）。
		 */
		function TodosDock(props) {
			const state = props && props.__vssarosState;
			const bridge = props && props.__vssarosBridge;
			const useProjection = props && props.useProjection;
			let todos = undefined;
			try {
				todos = typeof useProjection === "function" ? useProjection("todos") : undefined;
			} catch (e) {
				if (state) { state.todosReadError = String((e && e.message) || e); }
				todos = undefined;
			}
			const list = Array.isArray(todos) ? todos : null;
			const firstRunRef = react.useRef(true);
			const [open, setOpen] = react.useState(false);
			react.useEffect(() => {
				if (!firstRunRef.current) { return; }
				firstRunRef.current = false;
				// 只在**首次**拿到数据时决定初始展开态（之后是用户的心思，别抢 ✗）
				const doing = !!list && list.some((t) => t && t.status === "in_progress");
				if (doing) { setOpen(true); }
				if (state && list) { state.todosEntries = list.length; }
			}, [list]);
			if (!list || list.length === 0) {
				// null = 未知（从未写过）/ 空表 ⇒ 不占地方 ✓（官方同款语义：也不显示 ✓）
				return null;
			}
			const done = list.filter((t) => t && t.status === "completed").length;
			const jump = (item) => {
				const text = String((item && item.content) || "").trim();
				if (!text) { return; }
				const hit = locateByText(scrollableAncestor(document.querySelector('[data-vssaros-css]')) || document, text)
					|| locateByText(document, text);
				if (hit) {
					try { hit.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { hit.scrollIntoView(); }
					flash(hit);
					if (state) { state.todoJumps = (state.todoJumps || 0) + 1; state.lastTodoJumped = text; }
					return;
				}
				if (state) { state.todoJumpMisses = (state.todoJumpMisses || 0) + 1; }
				try {
					if (bridge && bridge.notify) {
						bridge.notify("attention", "未在对话里定位到这条任务（可能属于更早的会话，或该工具卡已被折叠）：" + text);
					}
				} catch { /* 通知失败也不阻塞 ✓ */ }
			};
			const rows = list.map((item, i) => {
				const s = item && item.status;
				const isDone = s === "completed";
				const isDoing = s === "in_progress";
				return react.createElement("li", {
					key: "t" + i,
					style: TODO_CSS.item,
					title: "点击定位到写这条任务的那次对话",
					onClick: () => jump(item),
					onMouseEnter: (e) => { try { e.currentTarget.style.background = "rgba(255,255,255,.05)"; } catch { /* 无妨 */ } },
					onMouseLeave: (e) => { try { e.currentTarget.style.background = "transparent"; } catch { /* 无妨 */ } },
				},
					react.createElement("span", { style: TODO_CSS.icon }, isDone ? "✔" : isDoing ? "◐" : "○"),
					react.createElement("span", {
						style: isDone ? TODO_CSS.textDone : isDoing ? TODO_CSS.textDoing : TODO_CSS.textTodo,
					}, String((item && item.content) || "")),
					react.createElement("span", { style: TODO_CSS.go }, "定位"),
				);
			});
			return react.createElement("div", { style: TODO_CSS.wrap, "data-vssaros-todo": "1" },
				react.createElement("div", {
					style: TODO_CSS.head,
					onClick: () => setOpen(!open),
				},
					react.createElement("span", { style: TODO_CSS.title }, "任务"),
					react.createElement("span", null, progressLabel(done, list.length)),
					react.createElement("span", { style: TODO_CSS.caret }, open ? "▲" : "▼"),
				),
				react.createElement("div", { style: TODO_CSS.bar },
					react.createElement("i", { style: Object.assign({}, TODO_CSS.barFill, { width: Math.round((done / list.length) * 100) + "%" }) })),
				open ? react.createElement("ul", { style: TODO_CSS.list }, rows) : null,
				open ? react.createElement("div", { style: TODO_CSS.note },
					"数据来自 dsh 会话投影（只读）；「定位」按文本回到写它的那次对话。") : null,
			);
		}

		/**
		 * @param {any} ctx  插件上下文（cordis）
		 * @param {any} shell 主包传下来的外壳：{bridge,state,sessionId,mark,rebind,fitMenu,menus}
		 */
		function install(ctx, shell) {
			const state = shell.state;
			const bridge = shell.bridge;
			// 把 state / bridge 透给组件：槽 owner 只注入它的标准 props，
			// 而"失败要留痕"这件事只有我们能做 ⇒ 组件里要拿得到 state ✓
			// （不改 owner 的 props 形状：用我们自己的 __vssaros* 前缀字段包一层 ✓）
			const Wrapped = (props) => react.createElement(TodosDock, Object.assign({}, props, {
				__vssarosState: state,
				__vssarosBridge: bridge,
			}));
			try {
				ctx.slots.inject(SLOT, () => ctx.slots.register(
					{ name: SLOT, id: ENTRY_ID, order: ENTRY_ORDER }, Wrapped));
				state.vssarosTodoDock = true;
			} catch (e) {
				state.vssarosTodoDockError = String((e && e.message) || e);
				// 注册失败必须说出来（只躺在自诊断字段里没人看得见 ✗，与 client.agents.js:1005-1010 同理由）
				if (bridge && bridge.notify) {
					bridge.notify("attention", "任务清单挂载失败（slot " + SLOT + "）：" + state.vssarosTodoDockError);
				}
			}
		}

		exports.install = install;
		// 仅测试用：纯逻辑（按文本定位 / 滚动祖先查找 / 进度文案）
		exports.__test = { locateByText, scrollableAncestor, progressLabel, ENTRY_ID, ENTRY_ORDER, SLOT };
		return module.exports;
	}
});
