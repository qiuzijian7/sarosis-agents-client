// @vssaros/dsh-imagegen — client half：聊天框里的**生图工具卡**。
//
// 为什么必须自己画：官方通用工具卡（`GenericToolCard`）只把结果内容**摊平成文本**
// ⇒ 聊天框里永远看不到图。官方的路子是"业务包把自己的 wire 工具名注册进 keyed 槽
// `tool.call.toolview`"（命中即**替换**通用行）—— 官方 `read_image` 那一行就是这么做的
// （`dsh-client-ui-tool/lib/client.js` 的 `readImageToolview`），我们照抄它的形状：
//
//   ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
//     name: "tool.call.toolview",
//     key: "image_generate",                       // ← wire 工具名（写错 ⇒ 静默不渲染）
//     children: { "tool.call.images": { kind: "single", scope: "session" } },
//   }, ImageRow));
//
// ★ `children` 那一行是**授权**：声明了 `tool.call.images` 这个子槽，我们这行里的
//   `renderSlot('tool.call.images', …)` 才被允许派发（官方原话："Declaring
//   `tool.call.images` as a child slot authorizes this entry's `renderSlot` to
//   dispatch the gallery"）。图片由**官方 attachment 插件**填进画廊，我们不自己拼
//   `data:` URL（那既撞 CSP 又绕开 attachment 生命周期）。
//
// 图的来源：工具结果里的 image 内容块（`{ type:'image', attachment }`）——
// 宿主半边用 `attachments.saveImage` 存好后由 `output.render` 放进结果里。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-imagegen",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const inject = ["slots"];

		/** 取工具结果里的内容块（settled 节点在 `block.content`；兼容旧形状的 `resultView.content`）。 */
		function contentOf(block) {
			if (!block || typeof block !== "object") { return []; }
			if (Array.isArray(block.content)) { return block.content; }
			const view = block.resultView;
			if (view && Array.isArray(view.content)) { return view.content; }
			return [];
		}

		/**
		 * 生图那一行：上面的说明文字 + 下面的图片画廊。
		 *
		 * `loadImage` 是**会话授权的加载器**（owner 带下来的）：图字节由 Host 鉴权后给出，
		 * 页面不自己拿 —— 这也是官方画廊组件的用法。
		 */
		function ImageRow(props) {
			const { block, renderSlot, loadImage } = props;
			const content = contentOf(block);
			const images = [];
			let caption = "";
			for (const part of content) {
				if (!part || typeof part !== "object") { continue; }
				if (part.type === "image" && part.attachment) {
					images.push({ attachment: part.attachment });
				} else if (part.type === "text" && typeof part.text === "string") {
					caption = caption ? caption + "\n" + part.text : part.text;
				}
			}
			if (images.length === 0) {
				// 还没结算（正在跑）或这次真没图：说人话，不要留一块空白。
				return React.createElement(
					"div",
					{ className: "vssaros-imagegen-row", "data-vssaros-imagegen": "pending" },
					caption || "正在生成图片…",
				);
			}
			return React.createElement(
				"div",
				{ className: "vssaros-imagegen-row", "data-vssaros-imagegen": "done" },
				caption
					? React.createElement("div", { className: "vssaros-imagegen-caption" }, caption)
					: null,
				typeof renderSlot === "function"
					? renderSlot("tool.call.images", { images, loadImage, align: "start" })
					: null,
			);
		}

		function apply(ctx) {
			ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
				name: "tool.call.toolview",
				key: "image_generate",
				children: {
					"tool.call.images": { kind: "single", scope: "session" },
				},
			}, ImageRow));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = "vssaros-imagegen-client";
		return module.exports;
	}
});
