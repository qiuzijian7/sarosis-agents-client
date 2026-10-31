// @vssaros/dsh-chat-surface — 交付卡片：点「Edited <文件>」→ **在 VsSaros 的编辑器区打开该文件**
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async("./client.fileCards.js") 取回本模块的 install()。
// 一个文件一个换皮点：并行改动各改各的文件，不再撞同一个 client.js。
//
// ── 为什么需要（2026-10-12 用户报障）─────────────────────────────────────────
// 聊天流里的「Edited README.md / Preview in sidebar」是 dsh 官方交付卡片
// （`@deepseek-ai/dsh-client-ui-deliverables` 的 `ChangedFiles`）：它的按钮 onClick 是
// `openReview(0)` —— **打开右侧栏的「本轮改动」审阅**。而 VsSaros 聊天框用 chat-only CSS 把右侧栏
// 整个裁掉了（`dshPageBridgeProtocol.ts` 的 DSH_CHAT_ONLY_CSS）⇒ 点了**界面上什么都不会发生** ✗✗。
// 用户要的是"在 IDE 的文本编辑器区打开这个文件"，所以这里把点击接管过来走页面桥 `openFile` ✓。
//
// ── 路径从哪来（不猜）───────────────────────────────────────────────────────
// 官方卡片把**绝对路径**渲染在一个 `hidden` 的 span 里，按钮用 `aria-describedby` 指向它：
//   · 单文件卡片：`<button class=…header aria-describedby={id}>` + `<span id={id} hidden>{resolveWorkspacePath(cwd, file.path)}</span>`
//   · 多文件每行：`aria-describedby={id-index}` + 对应 `hidden` span（同上）
// （依据：`dsh-client-ui-deliverables/lib/client.js:1408-1412` 与 `:1448-1452`）
// ⇒ 读那个 span 的文本就是宿主 `openFile` 需要的**绝对路径** ✓（`validatePageCommand` 只收绝对路径）。
// 取不到路径就**什么都不做**（保留 dsh 原行为）并把计数记进诊断字段 —— 宁可不动，也不打开错文件 ✓。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.fileCards.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		/** 官方交付卡片的 DOM 钩子（`data-changed-files` 是它自己打的标记，比 class 稳）。 */
		const CARD_SELECTOR = "[data-changed-files]";

		/**
		 * 从一个按钮上取**绝对路径**：优先 `aria-describedby` 指向的隐藏 span（官方就是那么渲染的 ✓），
		 * 取不到返回空串（调用方据此放弃接管）。
		 */
		function absolutePathOf(button) {
			try {
				const id = button && typeof button.getAttribute === "function"
					? button.getAttribute("aria-describedby")
					: "";
				if (!id) { return ""; }
				const described = document.getElementById(id);
				const text = described && described.textContent ? String(described.textContent).trim() : "";
				// 形状校验：必须是绝对路径（Windows 盘符 / UNC / 类 Unix 根）—— 与宿主侧校验同口径 ✓
				return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(text) ? text : "";
			} catch {
				return "";
			}
		}

		/**
		 * 多文件卡里**第一个文件**的绝对路径（同一套 hidden-span 约定，只是从 `li` 行按钮上取）。
		 *
		 * 为什么需要（2026-10-13 消死点）：多文件卡的**头部**按钮没有 `aria-describedby`（它表达的是
		 * "看本轮改动"），官方据此去开被 chat-only CSS 裁掉的右栏 ⇒ 界面上毫无反应 ✗。
		 * 退一步打开第一行那个文件，比"点了没反应"强 ✓。
		 */
		function firstRowPathOf(card) {
			try {
				const buttons = card.querySelectorAll("li button[aria-describedby]");
				for (const button of buttons) {
					const path = absolutePathOf(button);
					if (path) { return path; }
				}
				return "";
			} catch { return ""; }
		}

		/**
		 * 解析 `dsh-resource://file/…` 地址（语法依据：`dsh-api-workspace-files/lib/client.js:295-334` ✓）。
		 * 返回 `{ path, sessionId }`（path 可能是**会话相对**的 —— 调用方用该会话的 cwd 拼绝对 ✓），
		 * 不是 file 地址返回 null ✓。
		 */
		function parseFileAddress(address) {
			try {
				const PREFIX = "dsh-resource://file/";
				if (typeof address !== "string" || address.indexOf(PREFIX) !== 0) { return null; }
				const body0 = address.slice(PREFIX.length);
				const q = body0.search(/[?#]/);
				const body = q === -1 ? body0 : body0.slice(0, q);
				const seg = body.split("/");
				const scope = seg.shift();
				if (scope === "session") {
					const id = seg.shift();
					if (!id) { return null; }
					return { sessionId: decodeURIComponent(id), path: seg.map(decodeURIComponent).join("/") };
				}
				if (scope === "absolute") {
					const unc = seg[0] === "" && seg.length > 1;
					const parts = (unc ? seg.slice(1) : seg).map(decodeURIComponent);
					if (!parts.length || !parts[0]) { return null; }
					if (unc) { return { path: "//" + parts.join("/") }; }
					if (/^[A-Za-z]:$/.test(parts[0])) { return { path: parts.join("/") }; }   // C:/…
					return { path: "/" + parts.join("/") };
				}
				return null;
			} catch { return null; }
		}

		/**
		 * ★ 2026-10-15（中枢接管"开侧栏"）：dsh 里所有"开侧栏"都汇到 `sidebarRight.openResource`
		 *   （`dsh-client-ui-chat/lib/client.js:12426-12427` ✓ —— 工具卡文件名链接、交付卡预览、
		 *   计划审阅、子代理侧栏…全走它 ✓），而我们壳的侧栏被裁 ⇒ 全是死按钮 ✗。
		 *   在这里包一层：`dsh-resource://file/**` → 桥 `openFile`（IDE 编辑器 ✓）；其余 → 如实通知
		 *   （"点了没反应"是死按钮的最坏形态 ✗ —— 至少要说一句 ✓）。
		 *   ⚠ 为什么在服务层而不是 DOM：工具卡 fileLink 的路径在 React 闭包里、DOM 拿不到 ✗ ——
		 *   这个方法是所有"开侧栏"的唯一总闸 ✓。任何意外 ⇒ 回落官方行为（绝不弄坏别人的功能 ✓）。
		 */
		function wrapSidebarRight(ctx, state, bridge) {
			try {
				const sr = ctx && typeof ctx.get === "function" ? ctx.get("sidebarRight") : undefined;
				if (!sr || typeof sr.openResource !== "function") { state.sidebarWrapSkipped = "no sidebarRight service"; return; }
				if (sr.openResource.__vssarosWrapped) { return; }   // 幂等（install 可能被多次调用 ✓）
				const orig = sr.openResource.bind(sr);
				const cwdOf = (sessionId) => {
					try {
						const list = ctx.sessions && ctx.sessions.list;
						const snap = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : undefined;
						const hit = snap && snap.byId ? snap.byId[sessionId] : undefined;
						return hit && hit.cwd ? String(hit.cwd) : "";
					} catch { return ""; }
				};
				const wrapped = function (address, options) {
					try {
						const parsed = parseFileAddress(address);
						if (parsed) {
							let path = String(parsed.path || "");
							if (!/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(path) && parsed.sessionId) {
								const cwd = cwdOf(parsed.sessionId);
								if (cwd) { path = cwd.replace(/[\\/]+$/, "") + "/" + path; }
							}
							const line = options && options.params && typeof options.params.line === "number" ? options.params.line : undefined;
							if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(path) && bridge && typeof bridge.openFile === "function") {
								state.fileLinksOpened = (state.fileLinksOpened || 0) + 1;
								state.lastFileLinkOpened = path;
								Promise.resolve(bridge.openFile(path, line === undefined ? undefined : { startLine: line })).then(undefined, (e) => {
									state.lastFileCardError = String((e && e.message) || e);
								});
								return Promise.resolve();
							}
							// 是 file 地址但取不到绝对路径/桥太旧 ⇒ 记一笔 + 如实告知（不静默 ✗）
							state.fileLinksSkipped = (state.fileLinksSkipped || 0) + 1;
							try { if (bridge && bridge.notify) { bridge.notify("info", "这个文件链接本来开在 dsh 侧栏（壳里没有），且路径解析不出绝对形式——已拦下。"); } } catch { /* */ }
							return Promise.resolve();
						}
						// ★★ 2026-10-30（用户要求「在右侧栏显示本轮改动」）：**放行给官方**。
						//   `changes-review` 是 deliverables 注册的右栏 tab kind（`dsh-client-ui-deliverables`
						//   的 `sidebarRightTabs.register({kind:"changes-review"})` + `sidebar.right.pane.tab`），
						//   而**右栏在 IDE 与 desktop 两种形态下都保留**（CHAT_ONLY_CSS 只藏左栏）⇒
						//   从前那句「壳里没有侧栏 ⇒ 只弹提示」是**过期前提**（2026-10-19 恢复右栏后没跟着改）✗。
						//   现在原样交给官方：地址合法 ⇒ 官方自己开右栏 tab（desktop = 原生；IDE = 用户明确要的
						//   "在右侧栏看改动"）。任何异常仍由外层 catch 回落 `orig` ✓。
						if (typeof address === "string" && address.indexOf("dsh-resource://changes-review/") === 0) {
							state.changesReviewOpened = (state.changesReviewOpened || 0) + 1;
							return orig(address, options);
						}
						// ★ 2026-10-15 第二刀：两类"非文件但可落地"的资源 ✓
						//   · 计划**审阅预览**：markdown 直接随 params 带（dsh-client-ui-plan:683-686 ✓）→ IDE 编辑器 ✓
						//   · 子代理"侧栏打开子会话"：地址里带 childSessionId（dsh-client-ui-subagent:698-703 ✓）→
						//     **经宿主**切会话（bridge.openSession —— 页面禁止私切，见 client.subagents.js:13-15 ✓）
						if (typeof address === "string" && address.indexOf("dsh-resource://plan-review/") === 0) {
							const review = options && options.params && options.params.planReview;
							const md = review && typeof review.markdown === "string" ? review.markdown : "";
							if (md && bridge && typeof bridge.openMarkdown === "function") {
								state.planPreviewsOpened = (state.planPreviewsOpened || 0) + 1;
								Promise.resolve(bridge.openMarkdown(md, typeof review.title === "string" ? review.title : undefined)).then(undefined, (e) => {
									state.lastFileCardError = String((e && e.message) || e);
								});
								return Promise.resolve();
							}
							state.sidebarBlocked = (state.sidebarBlocked || 0) + 1;
							try { if (bridge && bridge.notify) { bridge.notify("info", "计划预览需要较新的页面桥（openMarkdown 不可用）——重启后生效。"); } } catch { /* */ }
							return Promise.resolve();
						}
						if (typeof address === "string" && address.indexOf("dsh-resource://subagentchat/session/") === 0) {
							const rest = address.slice("dsh-resource://subagentchat/session/".length);
							const q = rest.search(/[?#]/);
							const childId = decodeURIComponent(q === -1 ? rest : rest.slice(0, q));
							if (childId && bridge && typeof bridge.openSession === "function") {
								state.subagentSwitches = (state.subagentSwitches || 0) + 1;
								Promise.resolve(bridge.openSession(childId)).then(undefined, (e) => {
									state.lastFileCardError = String((e && e.message) || e);
								});
								return Promise.resolve();
							}
							state.sidebarBlocked = (state.sidebarBlocked || 0) + 1;
							try { if (bridge && bridge.notify) { bridge.notify("info", "子代理会话切换需要较新的页面桥（openSession 不可用）——重启后生效。"); } } catch { /* */ }
							return Promise.resolve();
						}
						// ★ 2026-10-15 第三刀：裸计划卡「打开计划」（plan/<sid>/<callId>）—— 内容不在地址里 ✗，
						//   照抄官方 provider 的取法（remote.follow 会话快照 → exit_plan_mode 的 callId →
						//   arguments.plan；dsh-client-ui-plan:240-263 + planResourceProvider ✓）。
						if (typeof address === "string" && address.indexOf("dsh-resource://plan/") === 0 && address.indexOf("dsh-resource://plan-review/") !== 0) {
							openPlainPlan(ctx, state, bridge, address);
							return Promise.resolve();
						}
						// 其余非文件资源（changes-review / 浏览器 tab…）：壳里没有侧栏 ⇒ 如实告知 ✓
						state.sidebarBlocked = (state.sidebarBlocked || 0) + 1;
						try { if (bridge && bridge.notify) { bridge.notify("info", "这个面板开在 dsh 侧栏里，VsSaros 壳没有侧栏——文件类的已改投编辑器区，其余陆续接。"); } } catch { /* */ }
						return Promise.resolve();
					} catch (e) {
						// 任何意外 ⇒ 回落官方行为（开隐藏侧栏也比抛错强 ✓ —— 绝不把别人的功能弄坏 ✓）
						try { return orig(address, options); } catch { return Promise.resolve(); }
					}
				};
				wrapped.__vssarosWrapped = true;
				sr.openResource = wrapped;
				state.sidebarWrapped = true;
			} catch (e) { state.sidebarWrapError = String((e && e.message) || e); }
		}

		/** 裸计划地址取不到内容时的统一口径：记一笔 + 如实通知（不静默 ✗）。 */
		function notifyPlanUnavailable(state, bridge) {
			state.sidebarBlocked = (state.sidebarBlocked || 0) + 1;
			try { if (bridge && bridge.notify) { bridge.notify("info", "这份计划的内容没能从会话记录里取出来——官方是开在侧栏的。"); } } catch { /* */ }
		}

		/** 与官方 `submittedPlan` 同口径：records 里找 exit_plan_mode + callId ⇒ arguments.plan（markdown）✓ */
		function findPlanMarkdown(records, callId) {
			try {
				for (const rec of records || []) {
					const ev = rec && (rec.event || rec);   // 记录形态宽容一点 ✓
					if (!ev || (ev.type !== "tool/call" && ev.type !== "tool/ptc-dispatch-start" && ev.type !== "tool/ptc-dispatch")) { continue; }
					const data = ev.data;
					if (!data || data.name !== "exit_plan_mode") { continue; }
					const id = ev.type === "tool/call" ? data.callId : data.subCallId;
					if (id !== callId) { continue; }
					let args = data.arguments;
					if (typeof args === "string") { try { args = JSON.parse(args); } catch { continue; } }
					const md = args && typeof args.plan === "string" ? args.plan : "";
					if (!md) { continue; }
					const titleMatch = /^#\s+(\S[^\r\n]*)/.exec(md.trim());
					return { text: md, title: titleMatch ? titleMatch[1] : undefined };
				}
				return null;
			} catch { return null; }
		}

		/** 裸「打开计划」：地址里只有 (session, callId) ⇒ 经 remote.follow 取会话快照自己找 ✓ */
		function openPlainPlan(ctx, state, bridge, address) {
			try {
				const m = /^dsh-resource:\/\/plan\/([^?#]+)$/.exec(address);
				if (!m) { notifyPlanUnavailable(state, bridge); return; }
				const parts = m[1].split("/").map(decodeURIComponent);
				let sessionAddress = null;
				let callId = "";
				if (parts.length === 2) { sessionAddress = { kind: "session", sessionId: parts[0] }; callId = parts[1]; }
				else if (parts.length === 5 && parts[0] === "subagent") { sessionAddress = { kind: "subagent", parentSessionId: parts[1], childSessionId: parts[2], mode: parts[3] }; callId = parts[4]; }
				const remote = ctx && ctx.remote && ctx.remote.session;
				if (!sessionAddress || !callId || !remote || typeof remote.follow !== "function" || !bridge || typeof bridge.openMarkdown !== "function") {
					notifyPlanUnavailable(state, bridge);
					return;
				}
				state.planLoads = (state.planLoads || 0) + 1;
				(async () => {
					try {
						let records = null;
						for await (const frame of remote.follow({ address: sessionAddress })) {
							if (frame && frame.type === "snapshot") { records = frame.records; break; }
						}
						const md = records ? findPlanMarkdown(records, callId) : null;
						if (md) {
							state.planPreviewsOpened = (state.planPreviewsOpened || 0) + 1;
							Promise.resolve(bridge.openMarkdown(md.text, md.title)).then(undefined, (e) => {
								state.lastFileCardError = String((e && e.message) || e);
							});
						} else {
							notifyPlanUnavailable(state, bridge);
						}
					} catch (e) {
						state.lastFileCardError = String((e && e.message) || e);
						notifyPlanUnavailable(state, bridge);
					}
				})();
			} catch { notifyPlanUnavailable(state, bridge); }
		}

		function install(ctx, shell) {
			const state = shell.state;
			const bridge = shell.bridge;
			// ★★ 2026-10-30（用户要求「desktop 用 dsh 原生交互、IDE 用 IDE 交互」）：
			//   desktop 窗口（`chatOnly=0`）**整段不装**：
			//     ① 服务层 `openResource` 不再包（官方右栏自己开文件预览 / 本轮改动 / 计划 / 子会话）；
			//     ② document 级 capture 不注册（交付卡卡头点击回到官方 `openReview`）。
			//   从前这两处都只判"有没有桥"，而 desktop 视图**也有桥**（同一份 preload，chatOnly=0）
			//   ⇒ 桌面窗口里点卡头会被改道成"在 IDE 打开第一个文件" ✗（正是要修的）。
			//   判据由入口算好放 `shell.ide`（单一真相，见 client.js 的 isIdeChatView）。
			if (!shell.ide) {
				state.fileCards = false;
				state.fileCardsSkipped = "desktop 窗口（chatOnly=0）：交付卡/文件链接保留 dsh 原生右栏行为";
				return;
			}
			wrapSidebarRight(ctx, state, bridge);
			// capture 阶段：必须**先于** React 的合成事件拿到点击，才能拦住官方那个"开右侧栏审阅"的动作 ✓
			document.addEventListener("click", (e) => {
				try {
					const target = e.target;
					if (!target || typeof target.closest !== "function") { return; }
					if (!target.closest(CARD_SELECTOR)) { return; }
					// 我们自己在卡片上注入的动作按钮（见 client.cardActions.js）走各自的通路 ⇒ 这里让开 ✓
					// （不让开的话，"定位"会被本处理器吃掉、当成"打开文件"✗）
					if (target.closest("[data-vssaros-card-action]")) { return; }
					const button = target.closest("button");
					if (!button) { return; }
					// ★ 2026-10-15（修潜伏冲突）：**行**（在 li 里的按钮）让给 client.cardActions.js 的
					//   showUncommittedDiff 通道（2026-10-13 的意图 ✓ —— 此前被本处理器的 document 级捕获 +
					//   stopPropagation 遮蔽 ⇒ "行点击开 diff"从未生效 ✗）。本处理器只管**卡头**
					//   （不在 li 里的按钮：单文件卡头 / 多文件"看本轮改动"头 ✓）。
					if (button.closest("li")) { return; }
					// ★★ 2026-10-30（用户要求「希望打开右侧栏，在右侧栏中显示本轮改动」）：**卡头放行**。
					//   官方 `ChangedFiles` 的卡头 / 单文件卡头 onClick = `openReview(0)` →
					//   `sidebarRight.openResource("dsh-resource://changes-review/…")` ⇒ 右栏「本轮改动」审阅；
					//   而右栏在 IDE 与 desktop **两种形态下都保留**（CHAT_ONLY_CSS 只藏左栏）⇒
					//   从前"改成打开第一个文件"依据的是"壳里没有右栏"的过期前提 ✗，而且它
					//   `stopPropagation` 掉官方 onClick ⇒ 服务层那条 changes-review 放行分支**永远走不到** ✗✗。
					//   现在卡头原样交给官方（多文件 = 本轮全部改动；单文件 = 该文件的本轮 diff）；
					//   本处理器只保留「行放行」（`button.closest("li")`）与诊断计数。
					state.fileCardHeadersPassed = (state.fileCardHeadersPassed || 0) + 1;
					return;
				} catch { /* 收卡片点击绝不影响聊天本身 */ }
			}, true);
			state.fileCards = true;
		}

		exports.install = install;
		return module.exports;
	}
});
