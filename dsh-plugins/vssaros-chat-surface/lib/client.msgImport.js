// @vssaros/dsh-chat-surface — 消息底部的「导入到知识库」按钮（2026-10-29 用户要求）
//
// package-local chunk（dsh client-modules 契约）：主包 lib/client.js 用 require.async 取回本模块的 install()。
//
// ── 为什么是"注入按钮"而不是改官方组件 ─────────────────────────────────────────
// 消息底部那一排（复制 / 赞 / 踩 / 分享 / 用量 / 时间）是**官方组件**，我们拿不到它的 React 树。
// 好在官方那枚「复制」按钮打了稳定的 DOM 钩子：类名里含 copyButton
// （CSS-module 哈希类名形如 _copyButton_8z71b_132 ⇒ 选择器 [class*=copyButton] 命中 ✓）。
//
// ⇒ 用 MutationObserver 盯 DOM，给每条**助手消息**的底部注入一枚按钮（幂等：注入过的打
//   data-vssaros-kb-import），点击后把这条消息的正文写进当前知识库的「笔记/导入」目录。
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
					const t = (el.innerText || "").trim();
					if (t.length > best.length) { best = t; }
				}
				if (best.length > 30) { return best; }
				let t = (container.innerText || "").trim();
				const foot = (row && row.innerText ? row.innerText.trim() : "");
				if (foot && t.endsWith(foot)) { t = t.slice(0, t.length - foot.length).trim(); }
				return t;
			} catch { return ""; }
		}

		/**
		 * 找到这条消息的「容器」：从复制按钮往上走，取**第一个**既有足够正文、
		 * 又只含这一枚复制按钮的祖先（避免把整条会话都吞进来）。
		 */
		function containerOf(copyBtn) {
			try {
				let el = copyBtn.parentElement;
				let fallback = null;
				for (let i = 0; i < 8 && el; i++) {
					const copies = el.querySelectorAll(COPY_BTN).length;
					const text = (el.innerText || "").trim();
					if (!fallback && text.length > 120) { fallback = el; }
					if (copies === 1 && text.length > 120) { return el; }
					el = el.parentElement;
				}
				return fallback;
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

		/** 把消息正文写进知识库（笔记/导入/<标题>.md）。 */
		async function importToKb(text) {
			const vault = await activeVault();
			const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
			const title = safeName(lines[0] || "对话导入");
			const r = await fetch("/x/kb/api/new", {
				method: "POST", credentials: "same-origin",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ vaultId: vault.id, kind: "file", dir: "笔记/导入", name: title, text: text }),
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
								toast("已导入到知识库：" + (res.vault ? res.vault + " · " : "") + res.rel);
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
