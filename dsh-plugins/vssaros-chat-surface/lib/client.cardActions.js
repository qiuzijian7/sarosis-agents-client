// @vssaros/dsh-chat-surface — 官方卡片上的**附加动作**（2026-10-13 用户要求）
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async("./client.cardActions.js") 取回本模块的 install()。
// 一个文件一个换皮点：并行改动各改各的文件，不再撞同一个 client.js。
//
// ── 为什么是"注入按钮"而不是改官方组件 ───────────────────────────────────────
// 这两枚动作官方**没有**，而我们又拿不到官方组件的 React 树（它们是 dsh 运行时里的组件 ✗）。
// 好在它们都打了稳定的 DOM 钩子（我们只认钩子，不认 hash 类名）：
//   · 终端块：`[data-terminal]`（`dsh-client-ui-primitives/lib/index.js:9371`），命令文本在
//     `[class*="command"]` 里（每行一个 span ⇒ 拼回多行 ✓，`:9393-9396`）；
//   · 交付卡：`[data-changed-files]`（`dsh-client-ui-deliverables/lib/client.js:1391`），**绝对路径**
//     在按钮 `aria-describedby` 指向的 hidden span 里（`:1408-1412` / `:1448-1452`）。
// ⇒ 用 MutationObserver 盯 DOM，给每张卡注入一枚小按钮（幂等：注入过的打 `data-vssaros-card-action`），
//   点击走页面桥 `openTerminal` / `reveal` ✓。所有 DOM 访问都包 try/catch：卡片结构变了就**不注入**，
//   绝不影响聊天本身 ✓。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.cardActions.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		/** 注入按钮的标记（幂等 + 让别的 chunk 能识别"这是我们自己的按钮"，见 client.fileCards.js）。 */
		const ACTION_ATTR = "data-vssaros-card-action";
		const ACTION_STYLE = {
			display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 6,
			padding: "1px 7px", borderRadius: 999, cursor: "pointer",
			border: "1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.18))",
			background: "transparent", color: "var(--dsw-alias-label-secondary, currentColor)",
			fontSize: 10.5, lineHeight: "16px", whiteSpace: "nowrap",
		};

		/** 拼出终端块里的命令（每行一个 `[class*="command"]` span）。取不到返回空串。 */
		function commandOf(block) {
			try {
				const parts = [];
				const nodes = block.querySelectorAll('[class*="command"]');
				for (const node of nodes) {
					const text = node.textContent === null || node.textContent === undefined ? "" : String(node.textContent);
					if (text) { parts.push(text); }
				}
				return parts.join("\n").trim();
			} catch { return ""; }
		}

		/** 交付卡里"第一个文件"的**绝对路径**（按钮的 `aria-describedby` → hidden span）。取不到返回空串。 */
		function firstPathOf(card) {
			try {
				const buttons = card.querySelectorAll("button[aria-describedby]");
				for (const button of buttons) {
					const id = button.getAttribute("aria-describedby");
					if (!id) { continue; }
					const described = document.getElementById(id);
					const text = described && described.textContent ? String(described.textContent).trim() : "";
					if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(text)) { return text; }
				}
				return "";
			} catch { return ""; }
		}

		/**
		 * 卡片里**被点的那一行**的绝对路径（`target` 必须是该行内部的元素）。
		 *
		 * 与 `firstPathOf` 的关键差别：**不做"回落到第一个文件"** ✗ —— 卡片头部/展开按钮也在这张卡里，
		 * 回落会变成"点哪里都打开第 1 个文件的 diff"（实测最容易踩的那种"看起来能用其实错位" ✗）。
		 * 解析不出具体行 ⇒ 返回空串 ⇒ 调用方**放行**（不拦事件，绝不让卡片变成死区 ✓）。
		 */
		function pathOfRow(card, target) {
			try {
				if (!target) { return ""; }
				const buttons = card.querySelectorAll("button[aria-describedby]");
				for (const button of buttons) {
					if (button !== target && !button.contains(target)) { continue; }
					const id = button.getAttribute("aria-describedby");
					const described = id ? document.getElementById(id) : null;
					const text = described && described.textContent ? String(described.textContent).trim() : "";
					return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(text) ? text : "";
				}
				return "";
			} catch { return ""; }
		}

		/** 造一枚小按钮（幂等标记由调用方打）。 */
		function actionButton(label, title, onClick) {
			const button = document.createElement("button");
			button.type = "button";
			button.setAttribute(ACTION_ATTR, "1");
			button.title = title;
			button.textContent = label;
			Object.assign(button.style, ACTION_STYLE);
			button.addEventListener("click", (e) => {
				// 拦掉冒泡：卡片本身也是按钮（点它会开右栏/换选中）⇒ 不拦就会出现"点一下干两件事"✗
				e.preventDefault();
				e.stopPropagation();
				onClick();
			}, true);
			return button;
		}

		function install(ctx, shell) {
			const state = shell.state;
			const bridge = shell.bridge;
			if (typeof document === "undefined") { return; }

			const fail = (what, err) => {
				const msg = String((err && err.message) || err);
				state.cardActionError = what + "：" + msg;
				try { if (bridge && bridge.notify) { bridge.notify("attention", what + "失败：" + msg); } } catch { /* 通知失败不回灌 */ }
			};

			// ── ① 终端块：「在终端打开」（把命令**填进** VsSaros 终端，不执行 ✓）──────────────────
			const decorateTerminals = () => {
				let blocks = [];
				try { blocks = Array.prototype.slice.call(document.querySelectorAll("[data-terminal]")); } catch { return; }
				for (const block of blocks) {
					try {
						if (block.querySelector("[" + ACTION_ATTR + "]")) { continue; }
						const command = commandOf(block);
						if (!command) { continue; }
						const button = actionButton("在终端打开", "把这条命令填进 VsSaros 终端（不自动执行，你按回车）", () => {
							if (!bridge || typeof bridge.openTerminal !== "function") { fail("在终端打开", "页面桥过旧（openTerminal 不可用）"); return; }
							try {
								Promise.resolve(bridge.openTerminal({ command })).then(
									() => { state.terminalsOpened = (state.terminalsOpened || 0) + 1; },
									(e) => fail("在终端打开", e));
							} catch (e) { fail("在终端打开", e); }
						});
						// 挂在官方那个"复制"按钮**旁边**（同一个 header 行，视觉一致 ✓）
						const copy = block.querySelector('[class*="copyButton"]');
						const host = copy && copy.parentElement ? copy.parentElement : block;
						if (copy && copy.parentElement === host) { host.insertBefore(button, copy); } else { host.appendChild(button); }
					} catch { /* 单张卡失败不影响别的 */ }
				}
			};

			// ── ② 交付卡：「定位」在 IDE 的资源管理器里找到这个文件 ✓ ───────────────────────────
			const decorateChangedFiles = () => {
				let cards = [];
				try { cards = Array.prototype.slice.call(document.querySelectorAll("[data-changed-files]")); } catch { return; }
				for (const card of cards) {
					try {
						// ★ 官方条目点击接管（2026-10-13 用户报障："点击卡片中的 item，没有在文本编辑器中
						//   显示修改对比"）：dsh 自己的行点击打开的是它**内部**的右侧预览列 ✗，而我们的
						//   chat-only UI 把那列隐藏了 ⇒ 用户端就是"点了没反应"。这里在**捕获阶段**接管：
						//   解析出被点行对应的绝对路径，走与「看改动」**同一通道**（showUncommittedDiff
						//   ⇒ 宿主转扩展命令做 HEAD ↔ 工作区 diff；失败会回退成打开文件 + 一条说明 ✓）。
						//   两条必须的收窄：① 只拦"确实解析出具体行"的点击（否则卡片头部/展开按钮
						//   也会被拦成"打开第 1 个文件的 diff" ✗）；② 放行我们自己注入的按钮 —— 捕获
						//   阶段先于目标自身的监听器 ✗，不排除就会把「定位」也改道成"打开 diff" ✗✗。
						if (!card.hasAttribute("data-vssaros-card-row-wired")) {
							card.setAttribute("data-vssaros-card-row-wired", "1");
							card.addEventListener("click", (e) => {
								const t = e.target;
								if (t && t.closest && t.closest("[" + ACTION_ATTR + "]")) { return; }   // ② 自家的按钮
								const rowPath = pathOfRow(card, t);
								if (!rowPath) { return; }                                               // ① 不是文件行 ⇒ 放行
								if (!bridge || typeof bridge.showUncommittedDiff !== "function") { return; }
								e.preventDefault();
								e.stopPropagation();
								try {
									Promise.resolve(bridge.showUncommittedDiff(rowPath)).then(
										() => { state.diffsOpened = (state.diffsOpened || 0) + 1; state.lastDiffPath = rowPath; },
										(err) => fail("打开改动", err));
								} catch (err) { fail("打开改动", err); }
							}, true);
						}
						if (card.querySelector("[" + ACTION_ATTR + "]")) { continue; }
						const pathNow = () => firstPathOf(card);
						const locate = actionButton("定位", "在 VsSaros 资源管理器里定位该文件（不打开编辑器、不抢焦点）", () => {
							const path = pathNow();
							if (!path) { fail("定位文件", "这张卡里取不到绝对路径"); return; }
							if (!bridge || typeof bridge.reveal !== "function") { fail("定位文件", "页面桥过旧（reveal 不可用）"); return; }
							try {
								Promise.resolve(bridge.reveal(path)).then(
									() => { state.reveals = (state.reveals || 0) + 1; state.lastRevealed = path; },
									(e) => fail("定位文件", e));
							} catch (e) { fail("定位文件", e); }
						});
						// 「看改动」（2026-10-13 用户要的"看 diff"）：打开 HEAD ↔ 工作区 的 diff。
						// 旧内容只有 git 知道 ⇒ 宿主转调扩展命令（工作台拿不到扩展宿主 API ✗）；
						// 没有未提交改动时宿主会回退成"直接打开文件 + 一条说明"，不会点了没反应 ✓。
						const showDiff = actionButton("看改动", "打开该文件的未提交改动 diff（HEAD ↔ 工作区；没有改动时会直接打开文件）", () => {
							const path = pathNow();
							if (!path) { fail("看改动", "这张卡里取不到绝对路径"); return; }
							if (!bridge || typeof bridge.showUncommittedDiff !== "function") { fail("看改动", "页面桥过旧（showUncommittedDiff 不可用）"); return; }
							try {
								Promise.resolve(bridge.showUncommittedDiff(path)).then(
									() => { state.diffsOpened = (state.diffsOpened || 0) + 1; state.lastDiffPath = path; },
									(e) => fail("看改动", e));
							} catch (e) { fail("看改动", e); }
						});
						const actions = document.createElement("span");
						actions.style.cssText = "display:inline-flex;align-items:center;gap:4px;margin-left:6px";
						actions.appendChild(locate);
						actions.appendChild(showDiff);
						card.appendChild(actions);
					} catch { /* 同上 */ }
				}
			};

			const decorate = () => { decorateTerminals(); decorateChangedFiles(); };
			decorate();
			// 卡片是随流式输出**增量**出现的 ⇒ 必须盯 DOM（只观察子树新增，不递归遍历整页 ✓）
			try {
				const observer = new MutationObserver(() => { decorate(); });
				observer.observe(document.body, { childList: true, subtree: true });
				state.cardActions = true;
			} catch (e) { state.cardActionError = String((e && e.message) || e); }
		}

		exports.install = install;
		exports.__test = { ACTION_ATTR, commandOf, firstPathOf, pathOfRow };
		return module.exports;
	}
});
