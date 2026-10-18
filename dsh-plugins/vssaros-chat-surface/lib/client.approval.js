// @vssaros/dsh-chat-surface — 审批卡遮蔽（conversation.composer chain）
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async("./client.approval.js") 取回本模块的 install()。
// 一个文件一个换皮点：并行改动各改各的文件，不再撞同一个 client.js。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.approval.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		/**
		 * 安装本部件：注册 slot / 注入样式。ctx = 插件上下文；shell = 入口侧共享状态
		 * （bridge / state / sessionId / mark / rebind）。段内代码与拆分前逐字一致。
		 */
		function install(ctx, shell) {
			const state = shell.state;
			const bridge = shell.bridge;
				// ── 审批卡遮蔽（方案 5.14 批次 4a）────────────────────────────────────
				// 官方审批 UI 注册在 conversation.composer（chain 槽，priority 1 + select 审批时接管）。
				// 我们注册同一槽、priority 0（升序更先试 → 遮蔽官方）+ 同样的 select（仅审批时接管），
				// 重绘成 VsSaros 风格卡。放行/拒绝仍走 dsh 原生审批流（pending.answer(decision)）。
				// 保留 data-approval-key 与按钮文案，供 e2e 与其他消费者定位（不承接 4b 的脏文件检查）。
				const APPROVAL_COMPOSER_SLOT = "conversation.composer";
				// ── 「存为模板」（2026-10-16，方案 D 的 P2）───────────────────────────────
				// 命中 = agents 插件的审批模板（/x/agents/api/approval-templates）：之后该过闸工具自动放行。
				// 边界如实：① 只覆盖 agents 插件自己的 WRITE_TOOLS（API 的 tools 封闭集说了算，
				//   本 chunk 不硬编码名单 ✓）；② 老版本 agents（404）⇒ 按钮不出现（不伪装 ✗）；
				//   ③ 存失败 ⇒ 不替用户回答审批（answer 只在存成功后才发 ✓）。
				const TEMPLATES_API = "/x/agents/api/approval-templates";
				let templatable = null; // null=未取过；[]=API 不存在；[...]=可模板化的工具封闭集
				function loadTemplatable(done) {
					if (templatable !== null) { done(templatable); return; }
					fetch(TEMPLATES_API).then((r) => (r.ok ? r.json() : null)).then((j) => {
						templatable = Array.isArray(j && j.tools) ? j.tools : [];
						done(templatable);
					}).catch(() => { templatable = []; done(templatable); });
				}
				function VssarosApprovalCard(props) {
					const pending = props.matched;
					const [answered, setAnswered] = react.useState(false);
					const [canTemplate, setCanTemplate] = react.useState(false);
					react.useEffect(() => {
						const tool = pending && pending.toolName;
						if (!tool) { setCanTemplate(false); return; }
						let alive = true;
						loadTemplatable((tools) => { if (alive) { setCanTemplate(tools.indexOf(tool) >= 0); } });
						return () => { alive = false; };
					}, [pending && pending.toolName]);
					const answer = (outcome) => {
						if (answered || !pending || !pending.answerable) { return; }
						setAnswered(true);
						Promise.resolve(pending.answer(outcome)).catch(() => { setAnswered(false); });
					};
					// 存模板 ⇒ 本次也放行（存失败 ⇒ 不动审批，用户照旧手动点 ✓）
					const saveTemplate = () => {
						const tool = pending && pending.toolName;
						if (!tool || answered) { return; }
						const reasonText = pending ? (pending.reason || "") : "";
						fetch(TEMPLATES_API, {
							method: "POST", headers: { "content-type": "application/json" },
							body: JSON.stringify({ action: "add", tool, note: String(reasonText).slice(0, 120) }),
						}).then((r) => r.json().catch(() => ({})).then((j) => {
							if (!r.ok) { throw new Error(j.error || ("HTTP " + r.status)); }
							answer("allowed-once");
						})).catch((e) => {
							const msg = "存审批模板失败（本次未放行，请手动选择）：" + String((e && e.message) || e);
							if (state) { state.approvalTemplateError = msg; }
							try { if (bridge && bridge.notify) { bridge.notify("attention", msg); } } catch { /* 通知失败不阻塞 ✓ */ }
						});
					};
					const reason = pending ? (pending.reason || (pending.displayReason && (pending.displayReason.zh || pending.displayReason.en))) : undefined;
					const btn = (label, onClick, primary) => react.createElement("button", {
						type: "button", disabled: answered, onClick,
						style: {
							fontSize: 12, padding: "3px 12px", borderRadius: 6, cursor: "pointer",
							border: "1px solid " + (primary ? "var(--dsw-alias-brand-primary, transparent)" : "var(--dsw-alias-border-l1, transparent)"),
							background: primary ? "var(--dsw-alias-brand-primary, rgba(88,166,255,.18))" : "transparent",
							color: primary ? "var(--dsw-alias-label-primary-inverted, #fff)" : "var(--dsw-alias-label-primary, currentColor)",
						},
					}, label);
					return react.createElement("div", {
						"data-approval-key": pending ? pending.key : undefined,
						"data-vssaros-approval": "1",
						style: { padding: "8px 16px 12px", display: "flex", flexDirection: "column", alignItems: "center" },
					}, react.createElement("div", {
						style: {
							width: "100%", maxWidth: 720,
							border: "1px solid var(--dsw-alias-state-warn-secondary, var(--dsw-alias-border-l1, transparent))",
							borderRadius: 12, overflow: "hidden",
							background: "var(--dsw-alias-bg-layer-1, transparent)",
						},
					},
						react.createElement("div", {
							style: { background: "var(--dsw-alias-state-warn-tertiary, rgba(210,153,34,.12))", color: "var(--dsw-alias-state-warn-primary, #d29922)", padding: "10px 16px", fontSize: 13, display: "flex", alignItems: "center", gap: 8 },
						}, "⚠ 需要授权"),
						react.createElement("div", { style: { padding: "12px 16px 0", display: "flex", flexDirection: "column", gap: 6 } },
							react.createElement("div", { style: { color: "var(--dsw-alias-label-primary, currentColor)", fontSize: 15, fontWeight: 500 } }, "工具 " + ((pending && pending.toolName) || "?") + " 请求授权"),
							reason ? react.createElement("div", { style: { color: "var(--dsw-alias-label-tertiary, currentColor)", fontFamily: "ui-monospace, monospace", fontSize: 13, wordBreak: "break-all" } }, reason) : null,
						),
						react.createElement("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8, padding: "14px 16px" } },
							canTemplate ? (() => {
								const b = btn("存为模板，以后放行", saveTemplate, false);
								// 探针锚点直接挂按钮上（e2e 按它定位；btn() 不带 attrs ⇒ 包一层）
								return react.createElement("span", { "data-vssaros-approval-template": pending.toolName }, b);
							})() : null,
							btn("拒绝", () => answer("rejected"), false),
							btn("允许一次", () => answer("allowed-once"), true),
						),
					));
				}
				try {
					ctx.slots.inject(APPROVAL_COMPOSER_SLOT, () => ctx.slots.register({
						name: APPROVAL_COMPOSER_SLOT,
						priority: 0,
						select: ({ pendingInteraction }) => (pendingInteraction && pendingInteraction.kind === "approval") ? pendingInteraction : null,
					}, VssarosApprovalCard));
					state.approvalCard = true;
				} catch (e) {
					state.error = String((e && e.message) || e);
				}
		}
		exports.install = install;
		return module.exports;
	}
});
