// @vssaros/dsh-chat-surface — 消息底部的「导入到知识库」按钮（2026-10-29 用户要求）
//
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async 取回本模块的 install()。
//
// ── 为什么是"注入按钮"而不是改官方组件 ─────────────────────────────────────────
// 消息底部那一排（复制 / 赞 / 踩 / 分享 / 用量 / 时间）是**官方组件**，我们拿不到它的 React 树。
// 好在官方那枚「复制」按钮有**语义**钩子：消息底栏那枚是
//   <button class="xzv4MW_action" aria-label="复制">      ← class 是 CSS-module 哈希，**没有** copyButton
//   （copyButton 是**终端块**的类名 —— 拿它去找消息底栏会命中 0 个 ⇒ 按钮永远不出现，2026-10-29 真机踩过）
//   所在行 <div class="xzv4MW_actions">，行尾有 <span class="xzv4MW_endInfo">用量 … tok</span>
// ⇒ 定位用两条**语义**锚点：① 按钮 aria-label/title 含「复制 / Copy」；② 行内有 [class*="endInfo"]（消息底栏标志）。
//
// ⇒ 用 MutationObserver 盯 DOM，给每条**助手消息**的底部注入一枚按钮（幂等：注入过的打
//   data-vssaros-kb-import），点击后把这条消息的正文写进当前知识库的「库/raw」原始素材区
//   （★ 2026-10-29 用户要求；服务端只放开了 <vault>/库/raw/** 这一个受控可写子区，「库」区其余分类仍只读）。
//   所有 DOM 访问都包 try/catch：官方结构变了就**不注入**，绝不影响聊天本身 ✓。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.msgImport.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		/** 注入按钮的标记（幂等）。 */
		const BTN_ATTR = "data-vssaros-kb-import";

		/*
		 * ★ 2026-10-29（真机：按钮**根本没出现**）：原先用 [class*="copyButton"] 找官方复制钮 ——
		 *   那是**终端块**里的复制钮类名；**消息底栏**的复制钮实测是：
		 *     <button class="xzv4MW_action" aria-label="复制">      ← 类名是哈希，**没有** copyButton
		 *     所在行：<div class="xzv4MW_actions TS9iAW_actions">
		 *       └ <span class="xzv4MW_endInfo">用量 41.3K tok</span>  ← 消息底栏的标志
		 *   ⇒ 改用两条**语义**锚点（不依赖中文文案、不依赖哈希类名）：
		 *     ① 按钮的 aria-label/title 含「复制 / Copy」；
		 *     ② 所在行里有 [class*="endInfo"]（消息底栏的尾部信息：用量 + 时间）。
		 *   只满足 ① 的行（工具块、行内只有 2 个子元素那种）**不注入**，避免污染别处。
		 */
		const COPY_BTN = 'button[aria-label="复制"], button[aria-label*="复制"], button[title*="复制"], button[aria-label*="Copy" i], button[title*="Copy" i]';
		const ROW_END = '[class*="endInfo"]';
		const BTN_STYLE = [
			"display:inline-flex", "align-items:center", "gap:4px", "margin-left:8px",
			"padding:1px 8px", "border-radius:999px", "cursor:pointer",
			"border:1px solid var(--dsw-alias-border-l1, rgba(255,255,255,.18))",
			"background:transparent", "color:var(--dsw-alias-label-secondary, currentColor)",
			"font-size:10.5px", "line-height:16px", "white-space:nowrap",
		].join(";");

		/** 底部提示（不打断操作）。 */
		function toast(text, kind) {
			try {
				const el = document.createElement("div");
				el.setAttribute("data-vssaros-kb-toast", "1");
				el.style.cssText = [
					"position:fixed", "left:50%", "bottom:28px", "transform:translateX(-50%)",
					"z-index:9999", "max-width:70%", "padding:8px 14px", "border-radius:6px",
					"font-size:12px", "line-height:1.5", "pointer-events:none",
					"color:#fff", "white-space:pre-wrap",
					"background:" + (kind === "err" ? "rgba(180,40,40,.95)" : "rgba(30,30,30,.95)"),
					"border:1px solid rgba(255,255,255,.18)",
				].join(";");
				el.textContent = text;
				document.body.appendChild(el);
				setTimeout(() => { try { el.remove(); } catch { /* ignore */ } }, kind === "err" ? 6000 : 3200);
			} catch { /* ignore */ }
		}

		/** 去掉文件名里的非法字符（服务端也会校验，这里先洗一遍）。 */
		/**
		 * 导入文件的**规整命名**：对话导入-<时间戳>.md（★ 2026-10-29 用户要求）。
		 *   秒级 ⇒ 同一分钟内连导两次也不撞名（服务端同名会自动加 (1)/(2)，这里直接避免）。
		 *   用**本地时间**（用户看着最直观）✓。
		 */
		function stampOf(d = new Date()) {
			const p = (n) => String(n).padStart(2, '0');
			return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate())
				+ '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
		}

		function safeName(s) {
			return String(s || "").replace(/[\\/:*?"<>|]/g, " ").trim().slice(0, 60) || "未命名";
		}

		/** 从消息容器里取正文（优先 markdown/prose 容器，退回整块文本并去掉底部那行）。 */
		function messageTextOf(container, row) {
			try {
				const cands = [...container.querySelectorAll(
					'[class*="markdown"],[class*="prose"],[class*="messageContent"],[class*="content"],[class*="body"]',
				)];
				let best = "";
				for (const el of cands) {
					const t = textOf(el);
					if (t.length > best.length) { best = t; }
				}
				if (best.length > 30) { return best; }
				let t = textOf(container);
				const foot = textOf(row);
				if (foot && t.endsWith(foot)) { t = t.slice(0, t.length - foot.length).trim(); }
				return t;
			} catch { return ""; }
		}

		/**
		 * 找到这条消息的「容器」：从复制按钮往上走，取**第一个**既有足够正文、
		 * 又只含这一枚复制按钮的祖先（避免把整条会话都吞进来）。
		 */
		/**
		 * 取元素的纯文本。
		 *
		 * ★ 2026-10-29（真机：按钮没注入 / 取文全空）：**不能用 innerText** ——
		 *   innerText 只对**已渲染**的元素有值；隐藏的 WebContentsView（页签在后台）里
		 *   它一律返回空串 ⇒ 判定"没正文"⇒ 按钮不注入 / 导入内容为空。
		 *   ⇒ 统一用 textContent（不受可见性影响）+ 压空白。
		 */
		const textOf = (el) => String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();

		function containerOf(copyBtn) {
			try {
				let el = copyBtn.parentElement;
				const rowText = ((copyBtn.parentElement && copyBtn.parentElement.textContent) || '').trim();
				for (let i = 0; i < 8 && el; i++) {
					const text = textOf(el);
					// 去掉底栏那行的文字 ⇒ 剩下的才是"这条消息的正文"
					const body = (rowText && text.endsWith(rowText)) ? text.slice(0, text.length - rowText).trim() : text;
					/*
					 * ★ 2026-10-29（真机：短消息时取文爬到了**页面级** ⇒ 导进去的是页面 hero 文本）：
					 *   老判据是"正文 > 120 字" ⇒ 短消息不满足 ⇒ 一路爬到 <body>。
					 *   ⇒ 改成：**最近的**有正文的祖先就是消息块（> 8 字即可）；
					 *     太大（> 20000 字）说明爬到会话层了 ⇒ 放弃（宁可不导，也不导错）。
					 */
					if (body.length > 8) {
						return body.length > 20000 ? null : el;
					}
					el = el.parentElement;
				}
				return null;
			} catch { return null; }
		}

		/** 当前激活的知识库（拿不到 ⇒ 提示用户先开一个库）。 */
		async function activeVault() {
			const r = await fetch("/x/kb/api/view-data", { credentials: "same-origin" });
			const b = await r.json();
			const d = (b && b.data) ? b.data : b;
			const vaults = (d && d.vaults) || [];
			const id = (d && d.activeVaultId) || (vaults[0] && vaults[0].id) || "";
			if (!id) { throw new Error("还没有知识库（请先在知识库里载入一个文件夹）"); }
			return { id: id, name: (d && d.vaultName) || (vaults.find((v) => v.id === id) || {}).name || "" };
		}

		/** 把消息正文写进知识库（库/raw/<标题>.md —— ★ 2026-10-29 用户要求）。 */
		async function importToKb(text) {
			const vault = await activeVault();
			const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
			// ★ 2026-10-29（用户要求）：统一命名「对话导入-<时间戳>.md」，不再用消息首行当文件名。
			const stamp = stampOf();
			const title = '对话导入-' + stamp;
			// 消息首行留作**正文里的 H1**（文件名已规整，标题仍是原来那行更有用 ✓）
			const firstLine = String(lines[0] ?? '').trim();
			const body = (firstLine && firstLine.length <= 80 && firstLine.charAt(0) !== '#')
				? '# ' + firstLine + '\n\n' + text : text;
			const r = await fetch("/x/kb/api/new", {
				method: "POST", credentials: "same-origin",
				headers: { "content-type": "application/json" },
				// ★ 2026-10-29（用户要求）：导入落到**库/raw**（原始素材区），不是「笔记/导入」。
				//   「库」区其余分类仍只读 ⇒ 服务端只放开了 <vault>/库/raw/** 这一个受控可写子区。
				body: JSON.stringify({ vaultId: vault.id, kind: "file", dir: "库/raw", name: title, text: body }),
			});
			const b = await r.json();
			if (!b || b.ok === false) { throw new Error((b && b.error) || "写入失败"); }
			return { vault: vault.name, rel: b.rel };
		}

		function install() {
			if (typeof document === "undefined") { return; }

			const decorate = () => {
				try {
					const copies = [...document.querySelectorAll(COPY_BTN)];
					for (const copy of copies) {
						if (!copy || !copy.parentElement) { continue; }
						const row = copy.closest('[class*="actions"]') || copy.parentElement;
						// 必须是**消息底栏**（行内有 endInfo：用量 / 时间）⇒ 别处不注入
						if (!row.querySelector(ROW_END)) { continue; }
						if (row.querySelector("[" + BTN_ATTR + "]")) { continue; }
						const container = containerOf(copy);
						if (!container) { continue; }

						const btn = document.createElement("button");
						btn.type = "button";
						btn.setAttribute(BTN_ATTR, "1");
						btn.setAttribute("aria-label", "导入到知识库");
						btn.title = "把这条消息存进知识库（笔记/导入）";
						btn.style.cssText = BTN_STYLE;
						btn.textContent = "导入到知识库";
						btn.addEventListener("click", (ev) => {
							ev.preventDefault();
							ev.stopPropagation();
							const text = messageTextOf(container, row);
							if (!text || text.length < 5) { toast("这条消息没有正文可导入", "err"); return; }
							btn.disabled = true;
							btn.textContent = "导入中…";
							importToKb(text).then((res) => {
								btn.disabled = false;
								btn.textContent = "导入到知识库";
								toast("已导入到知识库（库/raw）：" + (res.vault ? res.vault + " · " : "") + res.rel);
							}).catch((e) => {
								btn.disabled = false;
								btn.textContent = "导入到知识库";
								toast("导入失败：" + String((e && e.message) || e), "err");
							});
						});
						row.insertBefore(btn, copy.nextSibling);
					}
				} catch { /* 官方结构变了就不注入，绝不影响聊天 */ }
			};

			decorate();
			// 消息是随流式输出**增量**出现的 ⇒ 必须盯 DOM
			try {
				const observer = new MutationObserver(() => { decorate(); });
				observer.observe(document.body, { childList: true, subtree: true });
			} catch { /* ignore */ }
		}

		exports.install = install;
		exports.__test = { BTN_ATTR, messageTextOf, containerOf, safeName };
		return module.exports;
	}
});
