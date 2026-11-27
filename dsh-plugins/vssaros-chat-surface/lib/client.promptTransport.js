/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
window.__ModuleLoader__.load({
	chunk: "client.promptTransport.js",
	factory: () => {
		const installed = new WeakMap();

		function createPromptRpcCall(rpc, original, promptBridge, onState, lifetime) {
			const pendingStops = new Map();
			const invoke = async (channel, endpoint, payload, signal) => {
				const stopping = endpoint === "session/cancel" && promptBridge.version >= 2;
				if (channel !== "/api" || (endpoint !== "session/prompt" && !stopping)) {
					return Reflect.apply(original, rpc, [channel, endpoint, payload, signal]);
				}
				const meta = { endpoint, sessionId: payload?.args?.request?.sessionId };
				if (lifetime) { signal = AbortSignal.any([lifetime, ...(signal ? [signal] : [])]); }
				signal?.throwIfAborted();
				const id = window.crypto.randomUUID();
				const body = JSON.stringify({ type: "client-request", rpcId: id, method: endpoint, payload });
				const controller = new AbortController();
				let onAbort;
				const aborted = new Promise((_resolve, reject) => {
					onAbort = () => {
						try { promptBridge.cancel(id); } catch { }
						reject(controller.signal.reason);
					};
					controller.signal.addEventListener("abort", onAbort, { once: true });
				});
				const cancel = () => controller.abort(signal.reason);
				signal?.addEventListener("abort", cancel, { once: true });
				const timer = setTimeout(() => controller.abort(new Error(stopping ? "停止请求超时，尚未确认当前轮已停止" : "dsh prompt: admission timed out")), stopping ? 12000 : 35000);
				onState?.(stopping ? "stopping" : "sending", meta);
				try {
					const text = await Promise.race([promptBridge.call(id, body), aborted]);
					controller.signal.throwIfAborted();
					const response = JSON.parse(text);
					if (response?.type !== "server-response" || response.rpcId !== id
						|| (response.result?.ok !== true && response.result?.ok !== false)) {
						throw new Error("dsh prompt: invalid Host receipt");
					}
					onState?.(response.result.ok ? "accepted" : "rejected", { ...meta, error: response.result.error?.message });
					return response.result;
				} catch (error) {
					onState?.("failed", { ...meta, error: String(error?.message || error) });
					throw error;
				} finally {
					clearTimeout(timer);
					signal?.removeEventListener("abort", cancel);
					controller.signal.removeEventListener("abort", onAbort);
				}
			};
			return (channel, endpoint, payload, signal) => {
				const sid = payload?.args?.request?.sessionId;
				if (channel !== "/api" || endpoint !== "session/cancel" || !(promptBridge.version >= 2) || !sid) {
					return invoke(channel, endpoint, payload, signal);
				}
				if (pendingStops.has(sid)) { return pendingStops.get(sid); }
				const pending = invoke(channel, endpoint, payload, signal);
				pendingStops.set(sid, pending);
				pending.finally(() => { if (pendingStops.get(sid) === pending) { pendingStops.delete(sid); } }).catch(() => {});
				return pending;
			};
		}

		function install(ctx, shell) {
			const promptBridge = window.vssarosDshPrompt;
			const rpc = ctx.get?.("connection")?.rpc;
			if (!rpc || typeof rpc.call !== "function" || typeof promptBridge?.call !== "function" || typeof promptBridge.cancel !== "function") { return; }
			if (installed.has(rpc)) { return; }
			ctx.effect(() => {
				const original = rpc.call;
				const lifetime = new AbortController();
				const call = createPromptRpcCall(rpc, original, promptBridge, (phase, meta) => {
					try {
						ctx.get?.("vssarosSubmissionControls")?.stopState(phase, meta);
						if (shell?.state) { shell.state.promptTransport = { carrier: "native-http", phase, ...meta }; }
					} catch { }
				}, lifetime.signal);
				rpc.call = call;
				installed.set(rpc, call);
				return () => {
					lifetime.abort(new Error("dsh prompt: client released"));
					if (rpc.call === call) { rpc.call = original; }
					installed.delete(rpc);
				};
			}, "vssaros: prompt transport");
		}

		return { install, __test: { createPromptRpcCall } };
	},
});
