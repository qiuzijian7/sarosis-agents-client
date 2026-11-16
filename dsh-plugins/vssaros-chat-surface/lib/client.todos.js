// @vssaros/dsh-chat-surface — 聊天框任务定位入口（slot: conversation.input.dock，id `vssaros-todo`，order -1）
// ★ 2026-11-13（用户选方案 C）：order 从 5 挪到 -1 ⇒ 排在官方 TodoPanel(0) **之前**，
//   让官方任务卡成为 dock 里最后一个可见条目、直接贴输入框；原来 5 会独占一行插在
//   卡片与输入框之间，撑出一条空白带（真机截图「任务卡离输入框间隔太大」）。
// package-local chunk（契约同 client.sessions.js）：主包 lib/client.js 用 require.async("./client.todos.js")
// 取回本模块的 install()。一个文件一个换皮点：并行改动各改各的文件，不再撞同一个 client.js。
//
// ── 为什么加这一枚（2026-10-14 用户要求；调研见 doc/subagent-todo-solution-plan.md §5 P0-1）──
// dsh 自带的 `TodoPanel` 就挂在**同一个槽**（`dsh-client-ui-conversation:17748-17759`，id `todo`、order 0），
// 但它只能整体折叠 —— **单项点击没有任何反应**（那一版 `li` 根本没有 onClick，`:17723-17735`）。
// 2026-11-13：移除第二份展开清单，仅保留「定位当前任务」按钮；进度列表由官方 TodoPanel 唯一展示。
// 仍只读取 `todos`（主人是 `dsh-tool-todo`），不修改任务或执行状态。
//
// ── 三条硬约束（改这个文件前先读）─────────────────────────────────────────────
// ① **数据只读自投影**：`props.useProjection("todos")`。它是槽作用域注入的**标准 props**，
//    不是 require 得到的模块 ✗（`dsh-client-ui-session` 用 declare module 合成的，
//    见该包 `lib/types/client/index.d.ts:77-83`）；本插件只允许 `require("react")`
//    （其他说明符不在 boot graph 里 ⇒ 会抛，见 dsh-client-modules 的 purity gate）。
//    `todos === null` = **从未写过**（不许显示成 `0 / 0` ✗ —— 这是"未知伪装成 0"的老坑），
//    `[]` / 有值 = 最近一次整表快照（`dsh-tool-todo/lib/types/types.d.ts:36,44`）。
// ② **与官方同槽并存**：id 用 `vssaros-todo`、order 取 **-1**（欢迎卡 -5 < -1 < 官方 todo=0，
//    同时避开 goal=10、queue=20）。官方那枚**保持原样**（视觉用户已熟悉，dsh 升级跟着官升 ✓）。
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
		 * 我们的：`vssaros-bot-welcome`=**-5** / `vssaros-delegate`=15 / `vssaros-workflow-run`=25 …
		 * ⇒ 取 **-1**：落在欢迎卡与官方 TodoPanel 之间，与任何一条都不 tie ✓。
		 *
		 * ★ 2026-11-13（用户选方案 C）：从 **5** 挪到 **-1**。原来排在官方 todo(0) 之后，
		 *   「定位当前任务」独占一行插在任务卡与输入框之间 ⇒ 截图里那条明显空白带 ✗。
		 *   现在官方 TodoPanel 成为最后一个可见 dock 条目，直接贴输入框 ✓。
		 *   ⚠ 边界：工作流执行条(25) / 群成员条(30) 有内容时仍排在卡片之后，那种场景间隔会回来。
		 *
		 * ⚠ 2026-10-14 修正：我们最初取的是 **10** —— 与官方 `goal` **真 tie** ✗（顺序无保证、且不报错 ✗）。
		 *   当时守卫没报警，是因为它的官方占位表**漏登记了 `goal`** ✓（补登后立刻红 ✓）。
		 *   tie 的后果是"谁先谁后看注册时机"，用户会看到两条 dock 时而换位 ✓ —— 这类漂移最难查 ✓。
		 */
		const ENTRY_ORDER = -1;
		/** 定位高亮的持续时间（ms）——够看见即可，别留永久样式（会有"这行被选中了"的错觉 ✗）。 */
		const FLASH_MS = 1400;

		/** 定位范围只取该按钮所属的官方会话滚动区，不回退到整个页面。 */
		function historyScope(el) {
			return el && typeof el.closest === "function" ? el.closest('[data-conversation-scroll]') : null;
		}

		/** 在本会话历史内找最后一个叶子文本命中，排除 composer、官方当前任务和本插件入口。 */
		function locateByText(root, text) {
			const scope = root;
			if (!scope || !text) { return null; }
			let hit = null;
			try {
				const leaves = scope.querySelectorAll("*");
				for (let i = 0; i < leaves.length; i++) {
					const el = leaves[i];
					if (!el || el.childElementCount !== 0) { continue; }
					if (el.closest('[data-conversation-region="composer"], [data-composer-seat], [data-testid="todo-panel"], [data-vssaros-todo]')) { continue; }
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

		/** 当前任务优先进行中，其次待处理；全完成或未知时不占据输入区。 */
		function currentTodo(list) {
			if (!Array.isArray(list)) { return null; }
			const valid = (item) => item && typeof item.content === "string" && item.content.trim();
			return list.find(item => valid(item) && item.status === "in_progress")
				|| list.find(item => valid(item) && item.status === "pending") || null;
		}

		const TODO_CSS = {
			wrap: { display: "flex", justifyContent: "flex-end", padding: "2px 10px", minWidth: 0 },
			button: { font: "inherit", fontSize: 12, lineHeight: "20px", padding: "4px 8px", borderRadius: 6,
				border: "1px solid var(--dsw-alias-border-l1, currentColor)", background: "transparent",
				color: "var(--dsw-alias-label-secondary, currentColor)", cursor: "pointer", maxWidth: "100%" },
		};

		/** 只读的历史定位入口；当前任务清单由官方 TodoPanel 唯一显示。 */
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
			const anchor = react.useRef(null);
			react.useEffect(() => {
				if (state) { state.todosEntries = list ? list.length : null; }
			}, [list, state]);
			const target = currentTodo(list);
			if (!target) { return null; }
			const jump = (item) => {
				const text = String((item && item.content) || "").trim();
				if (!text) { return; }
				const hit = locateByText(historyScope(anchor.current), text);
				if (hit) {
					const reduced = typeof window.matchMedia === "function" && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
					try { hit.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" }); } catch { hit.scrollIntoView(); }
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
			return react.createElement("div", { style: TODO_CSS.wrap, "data-vssaros-todo": "1" },
				react.createElement("button", { type: "button", ref: anchor, style: TODO_CSS.button,
					title: "定位当前任务在本会话中的历史记录：" + target.content,
					onClick: () => jump(target),
				}, "定位当前任务"),
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
					bridge.notify("attention", "任务定位入口挂载失败（slot " + SLOT + "）：" + state.vssarosTodoDockError);
				}
			}
		}

		exports.install = install;
		exports.__test = { locateByText, historyScope, currentTodo, TodosDock, ENTRY_ID, ENTRY_ORDER, SLOT };
		return module.exports;
	}
});
