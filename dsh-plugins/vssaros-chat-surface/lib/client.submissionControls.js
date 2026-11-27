/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
window.__ModuleLoader__.load({
	chunk: "client.submissionControls.js",
	factory: require => {
		const react = require("react");
		const CANCELLED = "已撤销本次发送，草稿已保留。若 Host 已接收，请先检查消息队列，避免重复发送。";
		const TIMED_OUT = "发送未收到确认，已恢复编辑。请先检查消息队列再重试。";
		const EMPTY = Object.freeze({ sending: false, stopping: false, stopError: null });

		/** Settle through the official sink failure path, never mutate the input machine or draft store. */
		function createSubmissionControls({ timeoutMs = 40000 } = {}) {
			const pending = new Map();
			const snapshots = new Map();
			const listeners = new Set();
			const stopping = new Set();
			const errors = new Map();
			let disposed = false;
			const publish = sid => {
				const next = { sending: (pending.get(sid)?.size || 0) > 0, stopping: stopping.has(sid), stopError: errors.get(sid) || null };
				const before = snapshots.get(sid) || EMPTY;
				if (before.sending === next.sending && before.stopping === next.stopping && before.stopError === next.stopError) { return; }
				snapshots.set(sid, next);
				for (const listener of listeners) { listener(); }
			};
			const cancel = sid => {
				let count = 0;
				for (const operation of [...(pending.get(sid) || [])]) {
					if (!operation.accepted) { operation.controller.abort(new Error(CANCELLED)); count++; }
				}
				return count;
			};
			async function run(sid, signal, execute) {
				if (disposed) { throw new Error("发送上下文已释放，草稿未提交。"); }
				signal?.throwIfAborted();
				const operation = { controller: new AbortController(), accepted: false, abandon: undefined };
				const group = pending.get(sid) || new Set();
				group.add(operation); pending.set(sid, group); publish(sid);
				const untrack = () => { group.delete(operation); if (!group.size && pending.get(sid) === group) { pending.delete(sid); } publish(sid); };
				const onParentAbort = () => operation.controller.abort(signal.reason);
				signal?.addEventListener("abort", onParentAbort, { once: true });
				const timer = setTimeout(() => operation.controller.abort(new Error(TIMED_OUT)), timeoutMs);
				let abort;
				const cancelled = new Promise((_resolve, reject) => {
					abort = () => {
						if (operation.accepted) { return; }
						try { operation.abandon?.(); } catch { console.warn("[vssaros] failed to retire abandoned submission"); }
						untrack(); reject(operation.controller.signal.reason);
					};
					operation.controller.signal.addEventListener("abort", abort, { once: true });
				});
				try {
					return await Promise.race([cancelled, execute(operation, untrack)]);
				} finally {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onParentAbort);
					operation.controller.signal.removeEventListener("abort", abort);
					untrack();
					operation.controller.abort();
				}
			}
			return {
				subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
				getSnapshot: sid => snapshots.get(sid) || EMPTY,
				cancel,
				stopState(phase, meta) {
					if (meta?.endpoint !== "session/cancel" || !meta.sessionId) { return; }
					const sid = meta.sessionId;
					if (phase === "stopping") { cancel(sid); stopping.add(sid); errors.delete(sid); }
					else {
						stopping.delete(sid);
						if (phase === "accepted") { errors.delete(sid); }
						else { errors.set(sid, `停止失败：${meta.error || "Host 未接受停止请求"}。请重试。`); }
					}
					publish(sid);
				},
				send(original, receiver, session, text, ids, mode, signal, accept) {
					return run(session.sessionId, signal, (operation, untrack) => {
						let resolveAccepted;
						const accepted = new Promise(resolve => { resolveAccepted = resolve; });
						const methods = new Map();
						const routed = new Proxy(session, {
							get(target, key) {
								if (key === "beginSubmission") {
									return input => {
										operation.controller.signal.throwIfAborted();
										const handle = target.beginSubmission({ ...input, onAccept: () => {
											if (operation.controller.signal.aborted || operation.accepted) { return; }
											operation.accepted = true; untrack();
											input.onAccept?.(); resolveAccepted({ kind: "success" });
										} });
										operation.abandon = () => handle.abandon();
										return handle;
									};
								}
								const value = Reflect.get(target, key, target);
								if (typeof value !== "function") { return value; }
								if (!methods.has(key)) { methods.set(key, value.bind(target)); }
								return methods.get(key);
							},
						});
						const outcome = Reflect.apply(original, receiver, [routed, text, ids, mode, operation.controller.signal,
							() => { if (!operation.controller.signal.aborted) { accept?.(); } }]);
						return Promise.race([outcome, accepted]);
					});
				},
				serialize(original, receiver, sid, source, ref, signal) {
					return run(sid, signal, operation => Reflect.apply(original, receiver, [source, ref, operation.controller.signal]));
				},
				dispose() {
					disposed = true;
					for (const sid of [...pending.keys()]) { cancel(sid); }
					listeners.clear(); snapshots.clear(); errors.clear(); stopping.clear();
				},
			};
		}

		function install(ctx, shell) {
			ctx.effect(() => {
				const controls = createSubmissionControls();
				const unprovide = ctx.reflect.provide("vssarosSubmissionControls", controls);
				const stopSend = ctx.inject(["conversation"], scope => scope.effect(() => {
					const service = scope.get("conversation");
					const conversation = service[Symbol.for("cordis.original")] || service;
					const descriptor = Object.getOwnPropertyDescriptor(conversation, "sendSession");
					const original = conversation.sendSession;
					const send = function (...args) { return controls.send(original, this, ...args); };
					conversation.sendSession = send;
					return () => {
						if (conversation.sendSession !== send) { return; }
						if (descriptor) { Object.defineProperty(conversation, "sendSession", descriptor); }
						else { delete conversation.sendSession; }
					};
				}, "vssaros: cancellable submission"));
				const stopReferences = ctx.inject(["inputTriggers", "sessions"], scope => scope.effect(() => {
					const service = scope.get("inputTriggers");
					const triggers = service[Symbol.for("cordis.original")] || service;
					const descriptor = Object.getOwnPropertyDescriptor(triggers, "sessionOf");
					const original = triggers.sessionOf;
					const sessionOf = function (actx) {
						const controller = Reflect.apply(original, this, [actx]);
						const sid = scope.get("sessions").scopeOf(actx);
						if (!sid || !controller?.serializeReference) { return controller; }
						return new Proxy(controller, { get(target, key) {
							if (key === "serializeReference") { return (...args) => controls.serialize(target.serializeReference, target, sid, ...args); }
							const value = Reflect.get(target, key, target);
							return typeof value === "function" ? value.bind(target) : value;
						} });
					};
					triggers.sessionOf = sessionOf;
					return () => {
						if (triggers.sessionOf !== sessionOf) { return; }
						if (descriptor) { Object.defineProperty(triggers, "sessionOf", descriptor); }
						else { delete triggers.sessionOf; }
					};
				}, "vssaros: cancellable reference preparation"));

				function SubmissionControls({ sessionId, useSession }) {
					const state = react.useSyncExternalStore(controls.subscribe, () => controls.getSnapshot(sessionId));
					const running = useSession(session => session.running);
					const button = (label, onClick, disabled = false) => react.createElement("button", { type: "button", onClick, disabled,
						style: { padding: "3px 9px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l1, transparent)",
							background: "transparent", color: "var(--dsw-alias-label-primary, currentColor)", cursor: "pointer" } }, label);
					const stop = async () => {
						controls.cancel(sessionId);
						controls.stopState("stopping", { endpoint: "session/cancel", sessionId });
						try {
							const binding = ctx.get("sessions").binding(sessionId);
							if (!binding) { throw new Error("当前会话已释放"); }
							const result = await binding.session.cancel();
							if (!result.ok) { throw new Error(result.error.message); }
							controls.stopState("accepted", { endpoint: "session/cancel", sessionId });
						} catch (error) { controls.stopState("failed", { endpoint: "session/cancel", sessionId, error: String(error?.message || error) }); }
					};
					if (!state.sending && !state.stopping && !state.stopError) { return null; }
					return react.createElement("div", { "data-vssaros-submission-controls": sessionId, style: { flexShrink: 0, padding: "6px 12px", fontSize: 12,
						color: "var(--dsw-alias-label-secondary, currentColor)" } },
						state.stopError ? react.createElement("div", { role: "alert" }, state.stopError) : null,
						react.createElement("div", { role: "status", style: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" } },
							react.createElement("span", null, state.stopping ? "已请求停止，正在等待 Host 确认…"
								: state.sending ? "消息正在等待接收确认，草稿暂时只读。" : "停止尚未成功，可以重试；草稿可继续编辑。"),
							state.sending ? button("撤销发送，继续编辑", () => { controls.cancel(sessionId); }) : null,
							(running || state.stopError) ? button("停止当前轮", stop, state.stopping) : null));
				}
				const stopDock = ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
					name: "conversation.input.dock", id: "vssaros-submission-controls", order: -35,
				}, SubmissionControls));
				return async () => {
					controls.dispose();
					await Promise.all([stopDock?.(), stopReferences.dispose(), stopSend.dispose()]);
					unprovide();
				};
			}, "vssaros: submission controls");
		}
		return { install, __test: { createSubmissionControls } };
	},
});
