// @vssaros/dsh-imagegen — client half：聊天框里的**生图工具卡**。
//
// ── 为什么必须自己画（2026-10-22 实锤）────────────────────────────────
// 官方通用工具卡（`GenericToolCard`）只把结果内容**摊平成文本** ⇒ 聊天框里永远看不到图。
// 官方的路子是"业务包把自己的 wire 工具名注册进 keyed 槽 `tool.call.toolview`"
// （命中即**替换**通用行）—— 官方 `read_image` 那一行就是这么做的。
//
// ★★ **2026-10-22 的坑（踩过并已修）**：
//   官方 `read-image-toolview` **声明了** child 槽位 `tool.call.images`；
//   而 child 槽位**只能被声明一次** —— 第二个声明者**直接抛错**（无宽恕逻辑）：
//     packages/client/ui-slots/src/index.ts:823-830
//       if (childRec?.spec) throw new Error(`slot "${childKey}" is already declared (...)`)
//   我们原来也声明了它 ⇒ 真机日志（~/.vssaros-dev/logs/*/main.log）：
//     Uncaught Error: slot "tool.call.images" is already declared (by ... (read-image-toolview))
//   ⇒ **我们的 client 插件注册失败** ⇒ 聊天框里生图只剩一段文字，图出不来。
//
//   官方给的两条出路（注释原文）："must reuse this entry or own a distinct slot"。
//   现实可行的是**own a distinct slot**；而我们**连 distinct slot 都不需要** ——
//   官方画廊组件在 `@deepseek-ai/dsh-client-ui-attachment/client` 里，**客户端基座不暴露**
//   （基座只给 react / react-dom / cordis / zod / react-virtual / dsh-client-store /
//     dsh-client-ui-slots / dsh-client-ui-primitives / dsh-client-ui-dockkit），
//   ⇒ 拿不到官方 `MessageImages` ⇒ **直接自己画**（缩略图 + 灯箱）最省事、零依赖风险。
//   ⇒ 所以本文件：**不声明任何 children**，也不用 `renderSlot`（没有槽位 ⇒ 不会与官方抢声明）。
//
// ── 聊天卡的三件事（Xcode 感）─────────────────────────────────────────
//   ① **图能出来**：从工具结果的 `image` 内容块拿 attachment ⇒ 用 owner 带来的
//      `loadImage`（会话授权的加载器）换 URL ⇒ 渲染。
//   ② **版本切换**：同一条出图线索的若干版归一族（宿主账本 `group`）⇒
//      `GET /x/imagegen/api/versions?attachment=<id>` 拿全族 ⇒ chip 切版本。
//   ③ **原位重生成**：`POST /x/imagegen/api/regenerate`（同族再出一版）⇒
//      走的是**同一条**宿主生图链路（凭据/审批只有一份真源）⇒ **在原卡片上**出，不新增卡片。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-imagegen",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const h = React.createElement;
		const useState = React.useState;
		const useEffect = React.useEffect;
		const inject = ["slots"];

		/** 宿主 API 前缀（与工作台页面同源 ⇒ 直接 fetch）。 */
		const API = "/x/imagegen/api";

		/** 取工具结果里的内容块（settled 节点在 `block.content`；兼容旧形状的 `resultView.content`）。 */
		function contentOf(block) {
			if (!block || typeof block !== "object") { return []; }
			if (Array.isArray(block.content)) { return block.content; }
			const view = block.resultView;
			if (view && Array.isArray(view.content)) { return view.content; }
			return [];
		}

		/** 一张图（可能多张）⇒ attachment 列表。 */
		function attachmentsOf(block) {
			const out = [];
			for (const part of contentOf(block)) {
				if (part && part.type === "image" && part.attachment) { out.push(part.attachment); }
			}
			return out;
		}

		/** 结果里的文本信封（模型可见那段；我们用它当图注）。 */
		function captionOf(block) {
			let text = "";
			for (const part of contentOf(block)) {
				if (part && part.type === "text" && typeof part.text === "string") {
					text = text ? text + "\n" + part.text : part.text;
				}
			}
			return text;
		}

		/**
		 * 生图那一行：说明文字 + 图 + 版本条 + 动作行 + 原位重生成。
		 */
		function ImageRow(props) {
			const { block, loadImage } = props;
			const attachments = attachmentsOf(block);
			const caption = captionOf(block);
			const firstId = attachments.length ? attachments[0].attachmentId : "";

			const [versions, setVersions] = useState([]);
			const [group, setGroup] = useState("");
			const [index, setIndex] = useState(0);
			const [urls, setUrls] = useState([]);
			const [busy, setBusy] = useState(false);
			const [editing, setEditing] = useState(false);
			const [draft, setDraft] = useState("");
			const [note, setNote] = useState("");
			const [lightbox, setLightbox] = useState(null);

			/* ① 拉版本族（认附件 id ⇒ 客户端手里只有这个）。 */
			useEffect(() => {
				if (!firstId) { return undefined; }
				let alive = true;
				fetch(API + "/versions?attachment=" + encodeURIComponent(firstId))
					.then(r => r.json())
					.then(j => {
						if (!alive || !j || !j.ok || !Array.isArray(j.versions)) { return; }
						setVersions(j.versions);
						setGroup(j.group || "");
						const at = j.versions.findIndex(v => v.id === j.current);
						setIndex(at >= 0 ? at : j.versions.length - 1);
					})
					.catch(() => { /* 拉不到版本族就退化成"只有当前这张" */ });
				return () => { alive = false; };
			}, [firstId]);

			/* ② 当前版本的图 URL：优先用 owner 的会话授权加载器，失败回落宿主字节路由。 */
			useEffect(() => {
				const v = versions[index];
				if (!v) { return undefined; }
				let alive = true;
				const put = (url) => {
					if (!alive) { return; }
					setUrls(prev => {
						const next = prev.slice();
						next[index] = url || "";
						return next;
					});
				};
				if (v.attachment && typeof loadImage === "function") {
					let p;
					try { p = loadImage(v.attachment); } catch (e) { p = Promise.reject(e); }
					Promise.resolve(p).then(url => put(url)).catch(() => put(v.url || ""));
					return () => { alive = false; };
				}
				put(v.url || "");
				return () => { alive = false; };
			}, [versions, index, loadImage]);

			/* ②b ★ 兜底：**拿不到版本族**（Host 重启后内存账本清空 / 老会话 / 图来自别的会话）
			 *   ⇒ 直接用内容块里的 attachment 逐个 `loadImage`。
			 *   ⚠ 真机 2026-10-24 事故：原来只有版本族那条路会填 urls ⇒ 重启后 versions 为空
			 *     ⇒ `<img src="">` ⇒ **用户看到"图没了"**（其实图还在 attachment 存储里，只是卡没去拿）。
			 *   ⇒ 图字节的**真源是 attachment**（持久），账本只是"最近出图"的内存索引（Host 重启即失）。 */
			useEffect(() => {
				if (versions.length > 0) { return undefined; }
				if (attachments.length === 0) { return undefined; }
				let alive = true;
				attachments.forEach((att, i) => {
					let p;
					try {
						p = typeof loadImage === "function"
							? loadImage(att)
							: Promise.reject(new Error("没有会话授权的图片加载器"));
					} catch (e) {
						p = Promise.reject(e);
					}
					Promise.resolve(p)
						.then(url => {
							if (!alive) { return; }
							setUrls(prev => {
								const next = prev.slice();
								next[i] = url || "";
								return next;
							});
						})
						.catch(() => { /* 加载失败就留空；卡片会说"正在生成"以外的话，不假装有图 */ });
				});
				return () => { alive = false; };
			}, [versions.length, firstId, loadImage]);

			/* ③ 原位重生成（同族再出一版）。 */
			const regenerate = () => {
				if (busy) { return; }
				const current = versions[index];
				const prompt = String(draft || (current && current.prompt) || caption || "").trim();
				if (!prompt) { setNote("没有画面描述可改"); return; }
				setBusy(true);
				setEditing(false);
				fetch(API + "/regenerate", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ group, prompt }),
				})
					.then(r => r.json())
					.then(j => {
						if (!j || !j.ok) {
							setNote(String((j && j.error) || "重生成失败"));
							return;
						}
						const vs = Array.isArray(j.versions) && j.versions.length
							? j.versions
							: (j.image ? versions.concat([j.image]) : versions);
						setVersions(vs);
						if (j.group) { setGroup(j.group); }
						setIndex(vs.length - 1);
						setNote("已出第 " + vs.length + " 版");
					})
					.catch(e => setNote("重生成失败：" + String((e && e.message) || e)))
					.then(() => setBusy(false));
			};

			/* ④ 存到工作区（宿主已有这条路：内容寻址 + 原子写）。 */
			const saveToWorkspace = () => {
				const current = versions[index];
				if (!current) { return; }
				fetch(API + "/save", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: current.id }),
				})
					.then(r => r.json())
					.then(j => setNote(j && j.ok ? "已存到工作区" : String((j && j.error) || "保存失败")))
					.catch(e => setNote("保存失败：" + String((e && e.message) || e)));
			};

			if (attachments.length === 0) {
				/* 还没结算（正在跑）或这次真没图：说人话，不要留一块空白。 */
				return h("div", { className: "vssaros-imagegen-row", "data-vssaros-imagegen": "pending" },
					caption || "正在生成图片…");
			}

			const current = versions[index];
			// ★ 无版本族时（重启后账本清空）退回"内容块里第一张图" ⇒ 「打开大图」仍有东西可开。
			const url = urls[index] || (current && current.url) || urls[0] || "";
			const meta = current
				? [current.provider, current.model].filter(Boolean).join(" / ") + (current.width ? " · " + current.width + "×" + current.height : "")
				: "";

			return h("div", { className: "vssaros-imagegen-row", "data-vssaros-imagegen": "done" },
				h("div", { className: "vssaros-imagegen-caption" },
					h("div", { className: "vssaros-imagegen-prompt" }, (current && current.prompt) || caption),
					meta ? h("div", { className: "vssaros-imagegen-meta" }, meta) : null),
				h("div", { className: "vssaros-imagegen-shots" },
					versions.length
						? versions.map((v, i) => h("div", {
							key: v.id,
							className: "vssaros-imagegen-shot" + (busy && i === index ? " busy" : ""),
							onClick: () => {
								const u = urls[i] || v.url || "";
								if (u) { setLightbox({ url: u, caption: v.prompt || "" }); }
							},
						},
							h("img", { src: urls[i] || v.url || "", alt: "生成结果 " + (i + 1) }),
							h("span", { className: "vssaros-imagegen-badge" }, "v" + (i + 1)),
							busy && i === index ? h("div", { className: "vssaros-imagegen-spin" }, "生成中…") : null))
						: attachments.map((att, i) => h("div", {
							key: att.attachmentId || String(i),
							className: "vssaros-imagegen-shot",
						}, h("img", { src: urls[i] || "", alt: "生成结果 " + (i + 1) })))),
				versions.length > 1
					? h("div", { className: "vssaros-imagegen-versions" },
						h("span", { className: "vssaros-imagegen-lab" }, "版本"),
						versions.map((v, i) => h("button", {
							key: v.id,
							type: "button",
							className: "vssaros-imagegen-vchip",
							"aria-pressed": String(i === index),
							onClick: () => setIndex(i),
						}, "v" + (i + 1))),
						h("span", { className: "vssaros-imagegen-count" }, "共 " + versions.length + " 版"))
					: null,
				h("div", { className: "vssaros-imagegen-actions" },
					h("button", {
						type: "button",
						className: "vssaros-imagegen-btn",
						onClick: () => {
							const v = versions[index];
							setDraft(String((v && v.prompt) || caption || ""));
							setEditing(true);
						},
					}, "重新生成"),
					h("button", {
						type: "button",
						className: "vssaros-imagegen-btn",
						onClick: () => { if (url) { setLightbox({ url, caption: (current && current.prompt) || "" }); } },
					}, "打开大图"),
					h("button", { type: "button", className: "vssaros-imagegen-btn", onClick: saveToWorkspace }, "存入工作区"),
					h("button", {
						type: "button",
						className: "vssaros-imagegen-btn",
						onClick: () => setNote("这张图已自动落到画布（打开画布工作台可见）"),
					}, "送入画布"),
					note ? h("span", { className: "vssaros-imagegen-note" }, note) : null),
				editing
					? h("div", { className: "vssaros-imagegen-editor" },
						h("textarea", {
							value: draft,
							onChange: e => setDraft(e.target.value),
							spellCheck: false,
						}),
						h("div", { className: "vssaros-imagegen-editor-row" },
							h("button", { type: "button", className: "vssaros-imagegen-btn primary", onClick: regenerate }, "在这个卡片上重生成"),
							h("button", { type: "button", className: "vssaros-imagegen-btn", onClick: () => setEditing(false) }, "取消"),
							h("span", { className: "vssaros-imagegen-hint" }, "不改描述直接生成＝同一张卡再出一版")))
					: null,
				lightbox
					? h("div", {
						className: "vssaros-imagegen-lightbox",
						onClick: () => setLightbox(null),
					},
						h("button", { type: "button", className: "vssaros-imagegen-lb-close", onClick: () => setLightbox(null) }, "关闭 (Esc)"),
						h("img", { src: lightbox.url, alt: "原图预览" }),
						lightbox.caption ? h("div", { className: "vssaros-imagegen-lb-cap" }, lightbox.caption) : null)
					: null);
		}

		/**
		 * 卡片样式：随插件注入一份 <style>（客户端插件没有 CSS module 通道）。
		 * 令牌顺序：`--dsw-alias-*`（dsh 原生界面唯一真实可用的那套）→ `--vscode-*`（老 Host / VS Code
		 *   侧壳里才有）→ 写死回退色。⚠ 2026-10-28：之前只写 `--vscode-*`，而 dsh 原生界面里**没有**
		 *   这些变量 ⇒ 全部落进写死的 fallback（#999 / #3c3c3c / #0e639c），浅色深色都不跟随且不报错 ✗。
		 */
		function injectStyles() {
			if (typeof document === "undefined" || !document.head) { return; }
			if (document.getElementById("vssaros-imagegen-style")) { return; }
			const style = document.createElement("style");
			style.id = "vssaros-imagegen-style";
			style.textContent = [
				".vssaros-imagegen-row{display:flex;flex-direction:column;gap:8px;padding:8px 0;}",
				".vssaros-imagegen-caption{display:flex;flex-direction:column;gap:2px;}",
				".vssaros-imagegen-prompt{color:var(--dsw-alias-label-primary,var(--vscode-foreground,inherit));word-break:break-word;}",
				".vssaros-imagegen-meta{color:var(--dsw-alias-label-secondary,var(--vscode-descriptionForeground,#999));font-size:.92em;}",
				".vssaros-imagegen-shots{display:flex;flex-wrap:wrap;gap:8px;}",
				".vssaros-imagegen-shot{position:relative;display:inline-block;border:1px solid var(--dsw-alias-border-l2,var(--vscode-panel-border,#3c3c3c));border-radius:6px;overflow:hidden;cursor:zoom-in;background:#000;}",
				".vssaros-imagegen-shot img{display:block;width:220px;height:auto;}",
				".vssaros-imagegen-shot.busy img{filter:grayscale(.7) brightness(.5);}",
				".vssaros-imagegen-badge{position:absolute;left:6px;top:6px;background:rgba(0,0,0,.62);color:#fff;font-size:10px;padding:1px 6px;border-radius:3px;}",
				".vssaros-imagegen-spin{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;}",
				".vssaros-imagegen-versions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}",
				".vssaros-imagegen-lab,.vssaros-imagegen-count,.vssaros-imagegen-note,.vssaros-imagegen-hint{color:var(--dsw-alias-label-secondary,var(--vscode-descriptionForeground,#999));font-size:.9em;}",
				".vssaros-imagegen-vchip{border:1px solid var(--dsw-alias-border-l2,var(--vscode-button-border,transparent));background:transparent;color:var(--dsw-alias-label-primary,var(--vscode-foreground,inherit));border-radius:999px;padding:2px 10px;font-size:.9em;cursor:pointer;}",
				".vssaros-imagegen-vchip[aria-pressed=true]{background:var(--dsw-alias-button-primary-fill,var(--vscode-button-background,#0e639c));color:var(--dsw-alias-label-primary-inverted,var(--vscode-button-foreground,#fff));}",
				".vssaros-imagegen-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}",
				".vssaros-imagegen-btn{background:transparent;color:var(--dsw-alias-label-primary,var(--vscode-button-secondaryForeground,inherit));border:1px solid var(--dsw-alias-border-l2,var(--vscode-button-border,transparent));border-radius:4px;padding:3px 10px;font-size:.92em;cursor:pointer;}",
				".vssaros-imagegen-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--vscode-toolbar-hoverBackground,rgba(255,255,255,.08)));}",
				".vssaros-imagegen-btn.primary{background:var(--dsw-alias-button-primary-fill,var(--vscode-button-background,#0e639c));color:var(--dsw-alias-label-primary-inverted,var(--vscode-button-foreground,#fff));}",
				".vssaros-imagegen-editor{display:flex;flex-direction:column;gap:6px;}",
				".vssaros-imagegen-editor textarea{width:100%;min-height:60px;background:var(--dsw-alias-bg-layer-2,var(--vscode-input-background,#3c3c3c));color:var(--dsw-alias-label-primary,var(--vscode-input-foreground,#ccc));border:1px solid var(--dsw-alias-border-l2,var(--vscode-input-border,transparent));border-radius:4px;padding:6px;font:inherit;resize:vertical;}",
				".vssaros-imagegen-editor-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
				".vssaros-imagegen-lightbox{position:fixed;inset:0;background:rgba(0,0,0,.86);display:flex;align-items:center;justify-content:center;z-index:9999;padding:40px;}",
				".vssaros-imagegen-lightbox img{max-width:92vw;max-height:86vh;border-radius:4px;}",
				".vssaros-imagegen-lb-close{position:absolute;top:16px;right:20px;background:transparent;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 10px;cursor:pointer;}",
				".vssaros-imagegen-lb-cap{position:absolute;bottom:14px;left:0;right:0;text-align:center;color:#bbb;font-size:12px;}",
			].join("");
			document.head.appendChild(style);
		}

		function apply(ctx) {
			injectStyles();
			/* ★ 故意**不声明 children** ⇒ 不会与官方 `tool.call.images` 抢 child 声明
			 *   （抢了会在注册时抛错 ⇒ 整个 client 插件起不来 ⇒ 图出不来）。
			 *
			 * ★★ 2026-10-23 真机测出来的缺口：**两张生图工具都要挂同一张卡**。
			 *   标准档（VsSaros）的 `denyTools` 里有 `image_*` ⇒ `image_generate` 被隐藏，
			 *   模型只剩 `generate_images`（批量，不匹配 `image_*`）⇒ 只绑 `image_generate`
			 *   的话标准档里**永远看不到图**（模型说"未知工具 image_generate"，改用
			 *   generate_images 出图则走官方通用卡 ⇒ 只剩文本）。两个工具产出的内容块
			 *   完全同形（text + image）⇒ 共用同一个 `ImageRow` ✓。 */
			for (const toolName of ["image_generate", "generate_images"]) {
				ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
					name: "tool.call.toolview",
					key: toolName,
				}, ImageRow));
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = "vssaros-imagegen-client";
		return module.exports;
	}
});
