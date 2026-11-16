// @vssaros/dsh-bridge — client half, hand-written in the dsh client module format.
//
// ★ 2026-11-11（用户要求「dsh 侧聊天框 UI 右上角移除 VsSaros 按钮」）：
//   P0 原型那枚「VsSaros」连通性自检按钮（点一下只调页面桥的 ping）已从**真源**删除 ——
//   它不承担任何产品功能（会话绑定走 chat-surface 的 openSession，其余能力各有通路），
//   却会在 desktop 主栏（surface=full）露在会话头部右上角 ✗。
//   为什么以前没删干净：chat-surface 的 client.hideBridgePing.js 只做「同 id 遮蔽」，
//   而且它挂在 PART_CHUNKS（client.js 里 surface !== chat 就早退）⇒ full 形态根本不装载。
//   ⇒ 现在真源不注册；chat-surface 那层遮蔽移进 ALWAYS_CHUNKS，只作为**旧版本/缓存**的兜底。
//   本文件仍保留页面桥探针状态（channelProbe.ts 读 window.__vssarosBridgeClient.surface）。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		const name = "vssaros-bridge-client";
		const inject = ["slots"];
		function apply(ctx) {
			const bridge = window.vssarosDsh;
			window.__vssarosBridgeClient = { loaded: true, surface: bridge ? bridge.surface : null, slots: [], react: react.version };
		}
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
