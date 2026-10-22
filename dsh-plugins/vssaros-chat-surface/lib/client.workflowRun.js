// @vssaros/dsh-chat-surface — 聊天框内「工作流执行」进度条
// （slot: conversation.input.dock，id `vssaros-workflow-run`）
//
// ── 为什么加这一枚（2026-10-20，mockup 见 doc/workflow-run-progress-mockup.html 方案 B）──
// 用户在**工作流页**点 ▶ 之后，聊天框里什么都看不到：`/x/workflow/api/run` 是同步 await，
// 只有"开始/完成"两个时间点（`dsh-plugins/vssaros-workflow/lib/index.js`）。所以本 chunk 消费
// Host 新加的 `GET /x/workflow/api/run/status`（引擎每步 emit ⇒ 内存运行态）——
// 数据是**只读观测面**，真源仍是 checkpoint ✓，本文件不新建任何真相。
//
// ── 硬约束（改之前先读）──────────────────────────────────────────────────────────
// ① 只允许 `require("react")`（其余说明符不在 boot graph 里 ⇒ 抛；dsh-client-modules 的 purity gate）。
// ② **没有 running 就 return null**：dock 是输入区，不该被一条"上次跑完了"的痕迹常驻占位 ✗。
// ③ 轮询是**自管理**的：Host 不在 / 路由没注册（旧版本插件）⇒ fetch 失败**静默**，不刷 console ✗
//    （聊天页在旧 Host 下也要能用）。
// ④ 数据形状来自 Host（`listRunStates`）：`{ executionId, workflowId, name, status, total, done,
//    currentNodeId, cancelling, nodes: [{id, type, label, status, error?}] }`。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.workflowRun.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const SLOT = "conversation.input.dock";
		const ENTRY_ID = "vssaros-workflow-run";
		/**
		 * 官方在这一槽的占位：`todo`=0 / `goal`=10 / `queue`=20
		 * 我们的三枚：`vssaros-bot-welcome`=-5 / `vssaros-todo`=5 / `vssaros-delegate`=15
		 * ⇒ 取 **25**：排在最后，不与任何一条 tie，也不打断官方那三枚的语义顺序 ✓
		 * （tie 的后果是"谁先谁后看注册时机"，用户会看到两条 dock 时而换位 —— 本仓踩过 ✗）
		 */
		const ENTRY_ORDER = 25;
		/** 有 running 时的轮询间隔（1s 级足够；不上 SSE —— 数据小、省长连接的生命周期管理）。 */
		const POLL_RUNNING_MS = 1500;
		/** 空闲时的轮询间隔（只为了"别在执行开始后 6 秒才出现"）。 */
		const POLL_IDLE_MS = 6000;
		const STATUS_API = "/x/workflow/api/run/status";

		/** 进度百分比（纯函数，可测）：total 为 0 时给 0，不除零。 */
		function progressOf(run) {
			const total = Number(run && run.total);
			const done = Number(run && run.done);
			if (!Number.isFinite(total) || total <= 0) { return 0; }
			const safeDone = Number.isFinite(done) && done > 0 ? done : 0;
			return Math.max(0, Math.min(100, Math.round((safeDone / total) * 100)));
		}

		/** 当前节点（优先 currentNodeId；没有就从节点表里找第一个 running）。 */
		function currentNodeOf(run) {
			const nodes = Array.isArray(run && run.nodes) ? run.nodes : [];
			const byId = nodes.find((n) => n && run && n.id === run.currentNodeId);
			if (byId) { return byId; }
			return nodes.find((n) => n && n.status === "running") || null;
		}

		/**
		 * 一句话摘要（头行右侧）：`3/6 · 生成表情包` / `已完成` / `已取消` / `失败`。
		 *
		 * ⚠ `cancelling` **不在这里表达**（2026-10-20 真渲染验收抓到）：停止态已经由**按钮文案**
		 *   「正在停止…」表达，摘要再写一遍 ⇒ 同一行出现两个「正在停止…」，看着像卡住/重复渲染 ✗。
		 *   摘要只负责"跑到哪了"，控制态交给控件 —— 这条由守卫的"全树只出现一次"钉住 ✓。
		 */
		function summaryOf(run) {
			if (!run) { return ""; }
			const total = Number(run.total) || (Array.isArray(run.nodes) ? run.nodes.length : 0);
			const done = Number(run.done) || 0;
			if (run.status === "running") {
				const node = currentNodeOf(run);
				const head = done + "/" + total;

				return node ? head + " · " + String(node.label || node.id || "") : head;
			}
			if (run.status === "completed") { return "已完成 " + done + "/" + total; }
			if (run.status === "cancelled") { return "已取消（" + done + "/" + total + "）"; }
			if (run.status === "failed") {
				const bad = (Array.isArray(run.nodes) ? run.nodes : []).find((n) => n && n.status === "failed");
				return "失败" + (bad ? "：" + String(bad.label || bad.id || "") : "");
			}
			return String(run.status || "");
		}

		const CANCEL_API = "/x/workflow/api/run/cancel";

		const CSS = {
			wrap: { padding: "6px 10px 2px", borderTop: "1px solid var(--dsw-alias-border-l1, #2f2f2f)" },
			stop: {
				flex: "0 0 auto", font: "inherit", fontSize: 10.5, lineHeight: "16px",
				padding: "0 6px", borderRadius: 4, cursor: "pointer",
				background: "transparent", color: "var(--dsw-alias-label-secondary, currentColor)",
				border: "1px solid var(--dsw-alias-border-l1, #4a4a4a)",
			},
			head: {
				display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
				fontSize: 11.5, lineHeight: "18px", color: "var(--dsw-alias-label-secondary, currentColor)",
			},
			title: { fontWeight: 600, color: "var(--dsw-alias-label-primary, #e6e6e6)" },
			meta: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			more: { fontSize: 10.5, opacity: 0.65, flex: "0 0 auto" },
			caret: { marginLeft: "auto", fontSize: 9, opacity: 0.7, flex: "0 0 auto" },
			bar: { height: 3, borderRadius: 2, background: "rgba(255,255,255,.10)", margin: "6px 0 0", overflow: "hidden" },
			barFill: { display: "block", height: "100%", background: "var(--dsw-alias-brand-primary, #3794ff)", transition: "width .25s ease" },
			barDone: { background: "var(--dsw-alias-state-success-primary, #2ea043)" },
			barBad: { background: "var(--dsw-alias-state-error-primary, #f85149)" },
			list: { margin: "6px 0 0", padding: 0, listStyle: "none" },
			item: { display: "flex", alignItems: "center", gap: 7, padding: "2px 6px", fontSize: 11.5, lineHeight: "17px" },
			icon: { width: 13, flex: "0 0 auto", textAlign: "center" },
			label: { flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			state: { fontSize: 10.5, opacity: 0.7, flex: "0 0 auto" },
			note: { padding: "3px 6px 2px", fontSize: 10.5, opacity: 0.6 },
		};

		const ICON = { pending: "·", running: "▶", completed: "✔", failed: "✕", cancelled: "⊘", skipped: "⤼" };
		const STATE_TEXT = { pending: "等待", running: "执行中", completed: "完成", failed: "失败", cancelled: "已取消", skipped: "跳过" };

		/**
		 * 轮询运行态。返回 stop()。失败**静默**（旧 Host / 桥不在时聊天页照常可用）。
		 * `onChange(runs)` 只在**内容变了**的时候回调（避免每 1.5s 无谓 setState）。
		 */
		function startPolling(onChange) {
			let stopped = false;
			let timer = null;
			let last = "";
			const tick = async () => {
				if (stopped) { return; }
				let delay = POLL_IDLE_MS;
				try {
					const res = await fetch(STATUS_API, { credentials: "same-origin", cache: "no-store" });
					if (res.ok) {
						const data = await res.json();
						const runs = Array.isArray(data && data.runs) ? data.runs : [];
						const running = runs.filter((r) => r && r.status === "running");
						// 只关心「正在跑的」与「最近一条」：dock 不该变成历史列表 ✓
						const payload = running.length > 0 ? running : runs.slice(0, 1);
						const text = JSON.stringify(payload);
						if (text !== last) { last = text; onChange(payload); }
						if (running.length > 0) { delay = POLL_RUNNING_MS; }
					}
				} catch {
					// Host 不在 / 路由未注册（旧插件）⇒ 静默（约束 ③）
				}
				if (!stopped) { timer = setTimeout(tick, delay); }
			};
			tick();
			return () => { stopped = true; if (timer) { clearTimeout(timer); } };
		}

		/**
		 * dock 的**视图**（纯函数：状态进 ⇒ element tree 出）。
		 *
		 * 为什么抽出来（2026-10-20）：组件本体依赖 `useState`/`useEffect`，而守卫里的 React 是**替身**
		 * （不渲染、不跑 effect）⇒ "停止按钮在不在 / 进度条多宽 / 停止中文案"这类断言只能落到
		 * **源码正则**上（弱，改个变量名就骗过去了 ✗）。抽成纯函数后守卫能直接调它、遍历返回的树断言 ✓。
		 */
		function renderDock(input) {
			const run = input.run;
			const extra = Number(input.extra) || 0;
			const open = input.open === true;
			const stoppingNow = input.stopping === true || run.cancelling === true;
			const percent = progressOf(run);
			const fill = Object.assign({}, CSS.barFill, { width: percent + "%" });
			const nodes = Array.isArray(run.nodes) ? run.nodes : [];
			const rows = nodes.map((node, i) => {
				const status = String(node && node.status || "pending");
				const isBad = status === "failed";
				return react.createElement("li", { key: "n" + i, style: CSS.item, title: String(node && node.type || "") },
					react.createElement("span", {
						style: Object.assign({}, CSS.icon, {
							color: status === "completed" ? "var(--dsw-alias-state-success-primary, #2ea043)"
								: status === "running" ? "var(--dsw-alias-brand-primary, #3794ff)"
									: isBad ? "var(--dsw-alias-state-error-primary, #f85149)"
										: "inherit",
						}),
					}, ICON[status] || "·"),
					react.createElement("span", { style: CSS.label }, String(node && (node.label || node.id) || "")),
					react.createElement("span", { style: CSS.state }, isBad && node && node.error ? "失败" : (STATE_TEXT[status] || status)));
			});
			return react.createElement("div", { style: CSS.wrap, "data-vssaros-workflow-run": "1" },
				react.createElement("div", { style: CSS.head, onClick: input.onToggle },
					react.createElement("span", { style: CSS.title }, "工作流"),
					react.createElement("span", { style: CSS.meta }, summaryOf(run)),
					extra > 0 ? react.createElement("span", { style: CSS.more }, "+" + extra) : null,
					react.createElement("button", {
						type: "button",
						style: Object.assign({}, CSS.stop, stoppingNow ? { opacity: 0.6, cursor: "default" } : {}),
						title: "停止：当前节点结束后不再继续（正在跑的节点会被尽力中断）",
						onClick: input.onStop,
						disabled: stoppingNow,
						"data-vssaros-workflow-stop": "1",
					}, stoppingNow ? "正在停止…" : "停止"),
					react.createElement("span", { style: CSS.caret }, open ? "▲" : "▼"),
				),
				react.createElement("div", { style: CSS.bar },
					react.createElement("i", { style: fill })),
				open ? react.createElement("ul", { style: CSS.list }, rows) : null,
				open ? react.createElement("div", { style: CSS.note },
					"只读观测：数据来自 Host 的运行态（执行真源是 checkpoint）。") : null);
		}

		/** dock 里的一枚：只在有 running 时出现；点开看节点清单。 */
		function WorkflowRunDock(props) {
			const state = props && props.__vssarosState;
			const bridge = props && props.__vssarosBridge;
			const [runs, setRuns] = react.useState([]);
			const [open, setOpen] = react.useState(false);
			/** 本地"正在发停止请求"：点完到下一次轮询（1.5s）之间要有反馈，否则像没点上 ✗ */
			const [stopping, setStopping] = react.useState(false);
			react.useEffect(() => {
				const stop = startPolling((next) => {
					setRuns(next);
					// 轮询结果已经不是 running ⇒ 停止请求生效了（清本地乐观态）
					if (!next.some((r) => r && r.status === "running" && r.cancelling)) { setStopping(false); }
					if (state) { state.workflowRunPolls = (state.workflowRunPolls || 0) + 1; }
				});
				return stop;
			}, []);
			// 只在「有正在跑的」时才占位（约束 ②）。`cancelling` 仍算 running（要让用户看见"正在停止"）。
			const running = runs.filter((r) => r && r.status === "running");
			if (running.length === 0) { return null; }
			const run = running[0];
			const extra = running.length - 1;
			// 停止：**后端先答应，再如实回报**。点下去立刻变"正在停止…"（乐观反馈），
			// 失败就把乐观态撤回并通知（不假装成功 —— 本仓反复踩过"点了没反应/假成功"）。
			const stop = (ev) => {
				if (ev && ev.stopPropagation) { ev.stopPropagation(); }
				if (stopping) { return; }
				setStopping(true);
				fetch(CANCEL_API, {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ executionId: run.executionId }),
				})
					.then((res) => res.json().catch(() => ({})).then((data) => ({
						ok: res.ok && !!(data && data.ok === true),
						error: (data && data.error) || ("HTTP " + res.status),
					})))
					.then((out) => {
						if (out.ok) { return; }
						setStopping(false);
						if (bridge && bridge.notify) { bridge.notify("attention", "停止工作流失败：" + String(out.error)); }
					})
					.catch((e) => {
						setStopping(false);
						if (bridge && bridge.notify) { bridge.notify("attention", "停止工作流失败：" + String((e && e.message) || e)); }
					});
			};
			return renderDock({
				run,
				extra,
				open,
				stopping,
				onToggle: () => setOpen(!open),
				onStop: stop,
			});
		}

		function install(ctx, shell) {
			const state = shell.state;
			const bridge = shell.bridge;
			const Wrapped = (props) => react.createElement(WorkflowRunDock, Object.assign({}, props, {
				__vssarosState: state,
				// 停止失败要**说出来**（"点了没反应"是本仓查过多次的坑）⇒ 组件里要拿得到 bridge.notify
				__vssarosBridge: bridge,
			}));
			try {
				ctx.slots.inject(SLOT, () => ctx.slots.register(
					{ name: SLOT, id: ENTRY_ID, order: ENTRY_ORDER }, Wrapped));
				state.vssarosWorkflowRunDock = true;
			} catch (e) {
				state.vssarosWorkflowRunDockError = String((e && e.message) || e);
				if (bridge && bridge.notify) {
					bridge.notify("attention", "工作流进度条挂载失败（slot " + SLOT + "）：" + state.vssarosWorkflowRunDockError);
				}
			}
		}

		exports.install = install;
		// 仅测试用：纯逻辑（进度 / 当前节点 / 摘要）+ **视图**（renderDock 可直接断言 element tree）
		// + 组件本体（守卫用它钉"空态不占位"：没有 running 时必须 return null）。
		exports.__test = {
			progressOf, currentNodeOf, summaryOf, startPolling, renderDock, WorkflowRunDock,
			ENTRY_ID, ENTRY_ORDER, SLOT, STATUS_API, CANCEL_API,
		};
		return module.exports;
	}
});
