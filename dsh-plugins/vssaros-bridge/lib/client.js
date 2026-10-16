// @vssaros/dsh-bridge — client half (P0 prototype), hand-written in the dsh client module format.
// Registers one control in the session header only when the VsSaros preload is present.
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const SLOT = "conversation.session.header.utilities";
		const name = "vssaros-bridge-client";
		const inject = ["slots"];
		function apply(ctx) {
			const bridge = window.vssarosDsh;
			const state = window.__vssarosBridgeClient = { loaded: true, surface: bridge ? bridge.surface : null, slots: [], react: react.version };
			if (!bridge) {
				return;
			}
			function VssarosPing() {
				return react.createElement("button", {
					type: "button",
					"data-vssaros": "ping",
					title: "VsSaros bridge",
					onClick: () => bridge.ping(),
				}, "VsSaros");
			}
			ctx.slots.inject(SLOT, () => {
				const dispose = ctx.slots.register({ name: SLOT, id: "vssaros-ping", order: -20 }, VssarosPing);
				state.slots.push(SLOT);
				return dispose;
			});
		}
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
