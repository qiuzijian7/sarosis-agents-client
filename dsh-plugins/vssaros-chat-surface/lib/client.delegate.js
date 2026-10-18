// @vssaros/dsh-chat-surface — 聊天框内「委派」dock（slot: conversation.input.dock，id `vssaros-delegate`，order 15）
// package-local chunk（契约同 client.todos.js）：主包 lib/client.js 用 require.async 取回本模块的 install()。
//
// ── 为什么加这一枚（2026-10-16，Agents 团队化方案 D 的「运行态」右半边；mockup doc/agents-mockup-d-combo.html）──
// 委派的**管理态**在左侧 agents 页（名册 + 详情页委派签）；但用户在聊天框里干活时看不到"后台还跑着几条
// 委派、哪条完成了" ✗。本 chunk 把 agents 插件的委派台账（/x/agents/api/assignments，同源 fetch ✓）
// 投成一枚 dock：运行中/刚完成的委任一屏可见，可追问、可中断。
//
// ── 三条硬约束（改这个文件前先读）─────────────────────────────────────────────
// ① **数据只读自 agents 插件 API**：台账真源在 @vssaros/dsh-agents（lib/assignments.js，内存态 ✓）；
//    本 chunk 不自建真相 ✗。API 不存在（老版本 agents ⇒ 404）⇒ **停止轮询并隐藏**，原因留痕
//    state.delegateApiMissing（不伪装成"没有委派" ✗ —— 那是"未知伪装成 0"的老坑）。
// ② **与官方同槽并存**：order 取 **15**（官方 todo=0 / goal=10 / queue=20 + 我们的 vssaros-todo=5
//    ⇒ 15 是唯一不 tie 的空档 ✓；守卫 check-chat-surface-chunks.mjs 会拦 tie ✓）。
// ③ **追问/中断是写动作**：走 POST api/assignments（action: ask/cancel），失败必须 bridge.notify
//    说出来，不静默 ✗（"点了没反应"是本仓查过多次的坑）。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.delegate.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const SLOT = "conversation.input.dock";
		const ENTRY_ID = "vssaros-delegate";
		// 官方 todo=0 / goal=10 / queue=20，我们的 vssaros-todo=5 ⇒ 15 不 tie（见文件头约束 ②）。
		const ENTRY_ORDER = 15;
		const API = "/x/agents/api/assignments";
		const POLL_MS = 6000;

		/** 状态图标（与 todos 同族：○/◐/✔ + ✕ 中断）。 */
		function statusIcon(status) {
			return status === "running" ? "◐" : status === "done" ? "✔" : status === "cancelled" ? "✕" : "○";
		}
		/** 头部计数文案：running 是"此刻在跑"，total 是台账条数。 */
		function headLabel(running, cap, total) {
			return "运行 " + running + "/" + cap + " · 共 " + total;
		}

		const CSS = {
			wrap: { padding: "6px 10px 2px", borderTop: "1px solid var(--dsw-alias-border-l1, #2f2f2f)" },
			head: {
				display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
				fontSize: 11.5, lineHeight: "18px", color: "var(--dsw-alias-label-secondary, currentColor)",
			},
			title: { fontWeight: 600, color: "var(--dsw-alias-label-primary, #e6e6e6)" },
			caret: { marginLeft: "auto", fontSize: 9, opacity: 0.7 },
			list: { margin: "6px 0 0", padding: 0, listStyle: "none" },
			item: {
				display: "flex", alignItems: "center", gap: 7, padding: "3px 6px", borderRadius: 4,
				fontSize: 11.5, lineHeight: "17px",
			},
			icon: { width: 13, flex: "0 0 auto", textAlign: "center", color: "var(--dsw-alias-label-secondary, currentColor)" },
			who: { flex: "0 0 auto", color: "var(--dsw-alias-label-secondary, currentColor)", maxWidth: 86, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			task: { flex: 1, minWidth: 0, color: "var(--dsw-alias-label-primary, #e6e6e6)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			taskDone: { flex: 1, minWidth: 0, opacity: 0.65, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			act: { marginLeft: "auto", fontSize: 10.5, color: "var(--dsw-alias-brand-primary, #3794ff)", cursor: "pointer", opacity: 0.85, flex: "0 0 auto" },
			actDanger: { marginLeft: 6, fontSize: 10.5, color: "var(--dsw-alias-error, #f48771)", cursor: "pointer", opacity: 0.9, flex: "0 0 auto" },
			note: { padding: "3px 6px 2px", fontSize: 10.5, opacity: 0.6 },
		};

		/** POST 一个动作（create 由 agents 页发起；这里只有 ask/cancel）。失败抛 Error（调用方 notify）。 */
		function postAction(body) {
			return fetch(API, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}).then((r) => r.json().catch(() => ({})).then((j) => {
				if (!r.ok) { throw new Error(j.error || ("HTTP " + r.status)); }
				return j;
			}));
		}

		function DelegateDock(props) {
			const state = props && props.__vssarosState;
			const bridge = props && props.__vssarosBridge;
			const [snap, setSnap] = react.useState(null);   // null=还没拿到；{apiMissing:true}=老版本 agents
			const [open, setOpen] = react.useState(true);
			const timerRef = react.useRef(0);

			react.useEffect(() => {
				let alive = true;
				const tick = () => {
					if (typeof document !== "undefined" && document.hidden) { return; }
					fetch(API).then((r) => {
						if (!alive) { return; }
						if (r.status === 404) {
							// 老版本 agents 没有这个 API：停轮询 + 隐藏 + 留痕（约束 ①）
							if (state) { state.delegateApiMissing = "HTTP 404（agents 插件过旧，无 /x/agents/api/assignments）"; }
							if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = 0; }
							setSnap({ apiMissing: true });
							return;
						}
						if (!r.ok) { return; } // 瞬时失败下轮再来
						r.json().then((j) => { if (alive) { setSnap(j); } }).catch(() => { /* 下轮再来 */ });
					}).catch(() => { /* 下轮再来 */ });
				};
				tick();
				timerRef.current = window.setInterval(tick, POLL_MS);
				return () => { alive = false; if (timerRef.current) { window.clearInterval(timerRef.current); } };
			}, []);

			if (!snap || snap.apiMissing) { return null; }
			const items = Array.isArray(snap.items) ? snap.items : [];
			if (items.length === 0) { return null; } // 没有委派就不占地方（与官方 todo 同款语义 ✓）

			const refresh = () => {
				fetch(API).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) { setSnap(j); } }).catch(() => { /* 下轮 */ });
			};
			const fail = (what) => (e) => {
				const msg = what + "失败：" + String((e && e.message) || e);
				if (state) { state.delegateLastError = msg; }
				try { if (bridge && bridge.notify) { bridge.notify("attention", msg); } } catch { /* 通知失败也不阻塞 ✓ */ }
			};
			const ask = (item) => {
				const text = window.prompt("追问内容（发到该委派的同一条会话）：");
				if (!text || !text.trim()) { return; }
				postAction({ action: "ask", id: item.id, message: text.trim() }).then(refresh).catch(fail("追问"));
			};
			const cancel = (item) => {
				if (!window.confirm("中断这条委派？（停掉其会话的当前回合）")) { return; }
				postAction({ action: "cancel", id: item.id }).then(refresh).catch(fail("中断"));
			};

			const rows = items.slice(0, 8).map((item) => {
				const running = item && item.status === "running";
				const task = String((item && item.task) || "");
				return react.createElement("li", { key: String(item.id), style: CSS.item, "data-vssaros-delegate-item": String(item.id) },
					react.createElement("span", { style: CSS.icon }, statusIcon(item.status)),
					react.createElement("span", { style: CSS.who, title: String(item.agentName || item.agentId) }, String(item.agentName || item.agentId)),
					react.createElement("span", { style: item.status === "done" ? CSS.taskDone : CSS.task, title: task },
						task.length > 42 ? task.slice(0, 42) + "…" : task),
					react.createElement("span", { style: CSS.act, onClick: () => ask(item) }, "追问"),
					running ? react.createElement("span", { style: CSS.actDanger, onClick: () => cancel(item) }, "中断") : null,
				);
			});
			return react.createElement("div", { style: CSS.wrap, "data-vssaros-delegate": "1" },
				react.createElement("div", { style: CSS.head, onClick: () => setOpen(!open) },
					react.createElement("span", { style: CSS.title }, "委派"),
					react.createElement("span", null, headLabel(snap.running || 0, snap.cap || 8, items.length)),
					react.createElement("span", { style: CSS.caret }, open ? "▲" : "▼"),
				),
				open ? react.createElement("ul", { style: CSS.list }, rows) : null,
				open ? react.createElement("div", { style: CSS.note },
					"数据来自 agents 插件委派台账（落盘持久化）；报告全文在各自会话日志。") : null,
			);
		}

		function install(ctx, shell) {
			const state = shell.state;
			const bridge = shell.bridge;
			const Wrapped = (props) => react.createElement(DelegateDock, Object.assign({}, props, {
				__vssarosState: state,
				__vssarosBridge: bridge,
			}));
			try {
				ctx.slots.inject(SLOT, () => ctx.slots.register(
					{ name: SLOT, id: ENTRY_ID, order: ENTRY_ORDER }, Wrapped));
				state.vssarosDelegateDock = true;
			} catch (e) {
				state.vssarosDelegateDockError = String((e && e.message) || e);
				// 注册失败必须说出来（只躺在自诊断字段里没人看得见 ✗，与 client.todos.js 同理由）
				if (bridge && bridge.notify) {
					bridge.notify("attention", "委派 dock 挂载失败（slot " + SLOT + "）：" + state.vssarosDelegateDockError);
				}
			}
		}

		exports.install = install;
		// 仅测试用：纯逻辑（状态图标 / 头部计数文案）
		exports.__test = { statusIcon, headLabel, ENTRY_ID, ENTRY_ORDER, SLOT };
		return module.exports;
	}
});
