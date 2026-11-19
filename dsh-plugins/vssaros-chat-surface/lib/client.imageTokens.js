// @vssaros/dsh-chat-surface — 聊天正文 `@image:name` 文本 chip（P4 资源承载）
// 只装饰官方 React 渲染后的纯文本节点，不碰官方工具卡 / 资源路由 / 组件树。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.imageTokens.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const CHIP_ATTR = "data-vssaros-image-token";
		const TOKEN_RE = /@image:([^\s]+)/g;
		const SKIP_SEL = '[data-chat-flow-kind="tool-call"],[data-terminal],[data-changed-files],code,pre,a,button,[' + CHIP_ATTR + ']';

		/** 纯函数：文本 ⇒ 片段数组，零 DOM、可单测。 */
		function splitImageTokenText(text) {
			const value = String(text || "");
			const out = [];
			const re = new RegExp(TOKEN_RE.source, "g");
			let last = 0;
			let match;
			while ((match = re.exec(value))) {
				if (match.index > last) { out.push(Object.freeze({ text: value.slice(last, match.index) })); }
				out.push(Object.freeze({ text: match[0], token: match[0] }));
				last = match.index + match[0].length;
			}
			if (last < value.length) { out.push(Object.freeze({ text: value.slice(last) })); }
			return Object.freeze(out);
		}

		/** 只处理 root 内 TEXT_NODE；幂等；不使用 HTML 字符串注入；不进 React/工具卡子树。 */
		function decorateImageTokens(root) {
			if (!root || typeof document === "undefined" || typeof document.createTreeWalker !== "function") { return 0; }
			const filter = typeof window !== "undefined" && window.NodeFilter ? window.NodeFilter.SHOW_TEXT : 4;
			const walker = document.createTreeWalker(root, filter);
			const hits = [];
			while (walker.nextNode()) {
				const node = walker.currentNode;
				const parent = node && node.parentElement;
				if (!parent || (typeof parent.closest === "function" && parent.closest(SKIP_SEL))) { continue; }
				if (!/@image:([^\s]+)/.test(node.nodeValue || "")) { continue; }
				hits.push(node);
			}
			let made = 0;
			for (const node of hits) {
				const fragment = document.createDocumentFragment();
				for (const part of splitImageTokenText(node.nodeValue)) {
					if (!part.token) { fragment.appendChild(document.createTextNode(part.text)); continue; }
					const span = document.createElement("span");
					span.setAttribute(CHIP_ATTR, part.token);
					span.setAttribute("role", "button");
					span.setAttribute("tabindex", "0");
					span.textContent = part.text;
					span.addEventListener("click", (event) => {
						event.preventDefault();
						event.stopPropagation();
						const open = globalThis.__vssarosOpenImageReference;
						if (typeof open === "function") { open(part.token); }
					}, true);
					fragment.appendChild(span);
				}
				if (node.parentNode) { node.parentNode.replaceChild(fragment, node); }
				made += 1;
			}
			return made;
		}

		function install(ctx, shell) {
			const state = shell && shell.state ? shell.state : null;
			if (typeof document === "undefined") { return; }
			const root = document.querySelector("[data-chat-flow]") || document.body;
			const decorate = () => { try { decorateImageTokens(root); } catch { /* 官方 DOM 结构变化时不影响聊天 */ } };
			decorate();
			try {
				const observer = new MutationObserver(decorate);
				observer.observe(document.body, { childList: true, subtree: true });
				if (state) { state.imageTokenChips = true; }
			} catch (error) {
				if (state) { state.imageTokenError = String((error && error.message) || error); }
			}
		}

		exports.install = install;
		exports.__test = Object.freeze({ CHIP_ATTR, splitImageTokenText, decorateImageTokens });
		return module.exports;
	}
});
