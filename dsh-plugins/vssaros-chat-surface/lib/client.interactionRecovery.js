/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.interactionRecovery.js",
	factory: require => {
		const react = require("react");
		const installed = new WeakSet();
		const GRACE_MS = 3000;

		/** Legacy blocking questions have no userQuestions projection; use the live, unsettled tool call. */
		function activeQuestionCalls(entries) {
			const active = new Map();
			for (const entry of entries || []) {
				if (entry.type !== "event") { continue; }
				const event = entry.event;
				if (event?.type === "turn/start" || event?.type === "turn/end") { active.clear(); }
				else if (event?.type === "tool/result") { active.delete(event.data?.callId); }
				else if (event?.type === "tool/call" && ["ask_user_question", "request_user_input"].includes(event.data?.name)
					&& typeof event.data.callId === "string") {
					active.set(event.data.callId, event.data);
				}
			}
			return [...active.keys()];
		}

		function panelVisible(seat) {
			if (!seat) { return false; }
			return [...seat.querySelectorAll("[data-question-key], [data-approval-key]")].some(panel => {
				for (let node = panel; node; node = node.parentElement) {
					const style = window.getComputedStyle(node);
					if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || node.hidden) { return false; }
					if (node === seat) { break; }
				}
				const rect = panel.getBoundingClientRect();
				return rect.width > 0 && rect.height > 0;
			});
		}

		/** Replay the Host's existing waterfall once; never send an answer or restart an Agent. */
		function createRecovery({ reconnect, reveal, now = Date.now, report = () => {} }) {
			const attempts = new Map();
			let current;
			const publish = (facts, phase, error) => {
				const value = { sessionId: facts.sessionId, callId: facts.callId, pendingKind: facts.pending?.kind || null,
					panelVisible: facts.visible, phase, attempts: attempts.get(facts.key) || 0, error: error || null };
				report(value);
				return value;
			};
			const restore = (facts, manual) => {
				try {
					if (manual && reveal(facts.sessionId, facts.pending?.callId || facts.callId)) {
						current.since = now();
						return publish(facts, "revealing");
					}
					attempts.set(facts.key, (attempts.get(facts.key) || 0) + 1);
					if (attempts.size > 32) { attempts.delete(attempts.keys().next().value); }
					reconnect();
					current.since = now();
					return publish(facts, "reconnecting");
				} catch (error) {
					return publish(facts, "failed", String(error?.message || error));
				}
			};
			return {
				check(facts) {
					if (!facts.callId || !facts.running) { current = undefined; report(null); return null; }
					if (facts.foreground === false) { return null; }
					facts = { ...facts, key: `${facts.sessionId}:${facts.callId}` };
					if (current?.key !== facts.key) { current = { key: facts.key, since: now() }; }
					if (facts.visible) { publish(facts, "visible"); return null; }
					if (facts.pending && !["question", "plan-review"].includes(facts.pending.kind)) { return null; }
					if (now() - current.since < GRACE_MS) { return null; }
					if (facts.connection !== "connected") { return publish(facts, "reconnecting"); }
					if (facts.projected && !facts.pending) { return publish(facts, "missing"); }
					if (!attempts.has(facts.key)) { return restore(facts, false); }
					return publish(facts, "missing");
				},
				retry(facts) {
					if (!facts.callId || !facts.running || facts.visible || facts.connection !== "connected"
						|| (facts.pending && !["question", "plan-review"].includes(facts.pending.kind))) { return null; }
					facts = { ...facts, key: `${facts.sessionId}:${facts.callId}` };
					if (current?.key !== facts.key) { current = { key: facts.key, since: now() }; }
					return restore(facts, true);
				},
			};
		}

		function install(ctx, shell) {
			const connection = ctx.get?.("connection");
			const sessions = ctx.get?.("sessions");
			const uiSession = ctx.get?.("uiSession");
			if (!connection?.reconnect || !sessions?.binding || !uiSession?.sessionStatus || installed.has(ctx)) { return; }
			installed.add(ctx);
			ctx.effect(() => () => installed.delete(ctx), "vssaros: interaction recovery registration");
			function InteractionRecovery({ sessionId }) {
				const root = react.useRef(null);
				const state = react.useRef(null);
				const recovery = react.useRef(null);
				const read = react.useRef(null);
				const [notice, setNotice] = react.useState(null);
				react.useEffect(() => {
					state.current = null;
					setNotice(null);
					if (!sessionId) { return; }
					let cachedWindow;
					let calls = [];
					const report = value => {
						try { if (shell?.state) { shell.state.interactionRecovery = value; } } catch { }
					};
					const machine = recovery.current = createRecovery({
						reconnect: () => { connection.reconnect(); console.warn("[vssaros] replaying missing question UI", sessionId); },
						reveal: (sid, callId) => ctx.get?.("userQuestionPanels")?.reveal(sid, callId) === true,
						report,
					});
					const facts = read.current = () => {
						const binding = sessions.binding(sessionId);
						const eventWindow = binding?.eventSource?.getSnapshot();
						if (eventWindow !== cachedWindow) { cachedWindow = eventWindow; calls = activeQuestionCalls(eventWindow?.entries); }
						return { sessionId, callId: calls.at(-1), running: binding?.session?.getSnapshot().running === true,
							foreground: root.current?.ownerDocument.visibilityState !== "hidden",
							projected: binding?.session?.projections?.faceOf("userQuestions").getSnapshot()?.active?.some(row => row.callId === calls.at(-1)) === true,
							pending: uiSession.sessionStatus.getSnapshot().get(sessionId)?.pendingInteraction,
							visible: panelVisible(root.current?.closest("[data-composer-seat]")),
							connection: connection.state?.getSnapshot() };
					};
					const update = value => {
						if (JSON.stringify(state.current) !== JSON.stringify(value)) { state.current = value; setNotice(value); }
					};
					const tick = () => {
						try { update(machine.check(facts())); }
						catch (error) { report({ sessionId, phase: "failed", error: String(error?.message || error) }); }
					};
					tick();
					const timer = setInterval(tick, 1000);
					return () => { clearInterval(timer); recovery.current = null; read.current = null; report(null); };
				}, [sessionId]);
				const retry = () => {
					const value = recovery.current?.retry(read.current?.() || {});
					state.current = value;
					setNotice(value);
				};
				return react.createElement("div", { ref: root, "data-vssaros-interaction-recovery": sessionId, style: { flexShrink: 0 } },
					notice ? react.createElement("div", { role: "status", style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", fontSize: 12,
						color: "var(--dsw-alias-label-secondary, currentColor)" } },
						react.createElement("span", null, notice.phase === "reconnecting" || notice.phase === "revealing"
							? "问答面板未显示，正在恢复交互通道…" : "仍在等待你的回答，但问答面板未显示。"),
						react.createElement("button", { type: "button", onClick: retry, disabled: notice.phase === "reconnecting" || notice.phase === "revealing",
							style: { flexShrink: 0, padding: "3px 8px", borderRadius: 6, cursor: "pointer", border: "1px solid var(--dsw-alias-border-l1, transparent)",
								background: "transparent", color: "var(--dsw-alias-label-primary, currentColor)" } }, "重新显示问题")) : null);
			}
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock", id: "vssaros-interaction-recovery", order: -40,
			}, InteractionRecovery));
		}
		return { install, __test: { activeQuestionCalls, panelVisible, createRecovery } };
	},
});
