// @vssaros/dsh-chat-surface — 会话区视图页签「记忆 / 技能 / 待办 / 记忆设置」
// （2026-11-02 用户要求；参照 dsh-memory-evolve 的 conversation.view 页签布局）
//
// ── 槽与顺序 ────────────────────────────────────────────────────────────────
// `conversation.view` 是 **list 槽**（声明在 `conversation.session` 的 children，
// `dsh-client-ui-conversation/lib/client.js:19796-19801`），官方占用两条：
//   · `chat`       order **0**（`dsh-client-ui-chat/lib/client.js:13222-13233`）
//   · `trajectory` order **10**（`dsh-client-ui-trajectory/lib/client.js:8205-8238`）
// ⇒ 我们取 20/30/40/50，稳定落在「轨迹」右侧，且与官方零 tie。
// ⚠ 官方只在「开发者工具」开启时才渲染 `trajectory`（conversation:19560）；关掉时
//   我们的 4 个页签直接接在「对话」后面 —— 这是官方开关的语义，我们不干预。
//
// ── 这一批的口径（2026-11-02 用户拍板「A：骨架 + 记忆页签可用」）──────────────
//   · 4 个页签全部注册出来（机制先跑通、可见）；
//   · 记忆：2026-11-06 起「记忆」页签由 @vssaros/dsh-memory 提供（Bot / 工作区记忆已并入它的 bot / key 轨），
//     本 chunk 不再注册记忆页签；设置页的 Bot 段只保留「Bot 记忆 · 版本历史」卡；
//   · 技能：列表 + 搜索 + 原始启用徽标（数据源 `/x/skills/api/skills`）；
//   · 待办：官方 `todos` 投影的完整清单（与 dock 那枚同一份数据，只读）；
//   · 设置：「本会话」（工作区 | Bot 分段、Bot 配置卡、Bot 记忆版本历史）+「全局」（VsSaros Memory 配置面板）。
//
// ── 渲染写法（别改成"逗号前置"的长参数列表）────────────────────────────────
// 本文件统一用 **children 数组**（`kids.push(...)` + `createElement(type, props, kids)`）：
// 之前那版用 `, cond ? a : b` 串在参数列表里，一处多写 `))` 就整包语法错误，
// 而守卫只报"编译失败"、看不出是哪个页签（2026-11-02 踩过一次）。
//
// ── 为什么都走同源 fetch，不 require 别的 chunk ────────────────────────────
// 插件只允许 `require("react")`（dsh-client-modules 的 purity gate）；跨 chunk 只能
// 走 window/事件（见 client.botSettingsBtn.js 的契约），而这里的数据源全是同源 HTTP，
// 直接 fetch 最省事、也不会与 vssaros-agents / vssaros-skills 的页面抢状态 ✓。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.conversationViews.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const SLOT = "conversation.view";
		/** preset 前缀与 4 个**模式** preset（与 client.capsule.js / client.agents.js 同口径，别各写一套）。 */
		const VSSAROS_PREFIX = "vssaros-";
		/* vssaros:bot-identity v1 —— 逐字副本，真源 vssaros-agents/lib/core/botIdentity.js（守卫 dsh-plugins/check-bot-identity.mjs） */
		const BOT_MODE_PRESET_IDS = ["standard", "ptc", "minimal", "cordis", "vssaros-standard", "vssaros-ptc", "vssaros-full", "vssaros-minimal", "vssaros-cordis"];
		/** 是不是"可能属于某个 bot"的 preset（vssaros- 前缀且不是模式 preset）。 */
		function isBotPresetId(presetId) {
			const id = String(presetId || "").trim();
			return id.indexOf("vssaros-") === 0 && id.length > 8 && BOT_MODE_PRESET_IDS.indexOf(id) < 0;
		}
		/** 会话属于哪个 bot：身份记录（presetId 与当前一致才采信）> 按 preset 推断（botId=null，调用方用花名册反查）。 */
		function sessionBotOf(projectionValues) {
			const pv = projectionValues || {};
			const presetId = String(pv.agentPreset || "").trim();
			if (!isBotPresetId(presetId)) { return { isBot: false, botId: null, presetId: presetId, source: "none" }; }
			const rec = pv["vssaros-bot"];
			const recBot = rec && typeof rec.botId === "string" ? rec.botId.trim() : "";
			if (recBot && String(rec.presetId || "").trim() === presetId) {
				return { isBot: true, botId: recBot, presetId: presetId, source: "record" };
			}
			return { isBot: true, botId: null, presetId: presetId, source: "preset" };
		}
		/* /vssaros:bot-identity */
		/** 官方占位（守卫会与 check-chat-surface-chunks.mjs 的 OFFICIAL_ENTRIES 对账）。 */
		const OFFICIAL = { chat: 0, trajectory: 10 };
		// ★ 2026-11-03（用户要求）：bot 配置统一进「设置」页签，放**整排最右端**（官方 chat 0 / trajectory 10
		//   ⇒ 60 在 记忆20/技能30/待办40 之后）；原「记忆设置」(50) 已并入这个页签，不再单独存在。
		const ORDERS = { memory: 20, skills: 30, todo: 40, settings: 60 };
		const IDS = {
			memory: "vssaros-memory",
			skills: "vssaros-skills",
			todo: "vssaros-todo",
			// 沿用旧右栏页签的 id：一个会话里只会有一个「Bot 设置」入口，不存在与右侧栏并存的情况
			settings: "vssaros-bot-settings",
		};
		/** 技能一次最多渲染多少条（技能库可能几百条；不做虚拟滚动就得有上限，且**要说出来**）。 */
		const SKILL_RENDER_LIMIT = 200;

		// ── 样式：全部走 dsh 设计 token（深浅色自动适配），写法同 client.todos.js ──
		const C = {
			root: {
				display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0,
				overflow: "auto", padding: "10px 14px 16px", boxSizing: "border-box", gap: 10,
				fontSize: 12.5, lineHeight: "19px",
				color: "var(--dsw-alias-label-primary, currentColor)",
			},
			row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
			col: { display: "flex", flexDirection: "column", gap: 6 },
			grow: { flex: "1 1 auto" },
			card: {
				border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.24))",
				borderRadius: 8, padding: "9px 12px",
				background: "var(--dsw-alias-bg-layer-1, transparent)",
			},
			sub: { color: "var(--dsw-alias-label-secondary, rgba(128,128,128,.9))", fontSize: 11.5 },
			tiny: { color: "var(--dsw-alias-label-tertiary, rgba(128,128,128,.8))", fontSize: 11 },
			title: { fontWeight: 600, fontSize: 13 },
			badge: {
				display: "inline-flex", alignItems: "center", padding: "0 7px", borderRadius: 999,
				fontSize: 10.5, lineHeight: "17px",
				border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.24))",
				color: "var(--dsw-alias-label-secondary, currentColor)",
			},
			badgeOn: {
				display: "inline-flex", alignItems: "center", padding: "0 7px", borderRadius: 999,
				fontSize: 10.5, lineHeight: "17px",
				border: "1px solid var(--dsw-alias-brand-primary, #3794ff)",
				color: "var(--dsw-alias-brand-primary, #3794ff)",
			},
			btn: {
				appearance: "none", cursor: "pointer", padding: "2px 10px", borderRadius: 6,
				border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))",
				background: "var(--dsw-alias-bg-layer-2, transparent)",
				color: "var(--dsw-alias-label-primary, currentColor)", fontSize: 11.5, lineHeight: "19px",
			},
			btnPrimary: {
				appearance: "none", cursor: "pointer", padding: "2px 12px", borderRadius: 6,
				border: "1px solid var(--dsw-alias-brand-primary, #3794ff)",
				background: "var(--dsw-alias-brand-primary, #3794ff)",
				// 文字色必须跟主题走：暗色主题的 brand-primary 接近白色，写死 #fff 会白字白底（2026-11-04 实测）。
				color: "var(--dsw-alias-label-primary-foreground, #fff)", fontSize: 11.5, lineHeight: "19px", fontWeight: 600,
			},
			bar: {
				height: 4, borderRadius: 2, overflow: "hidden", flex: "0 0 auto",
				background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.24))",
			},
			barFill: { display: "block", height: "100%", background: "var(--dsw-alias-brand-primary, #10b981)" },
			item: {
				padding: "5px 8px", borderRadius: 6,
				border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))",
			},
			input: {
				padding: "2px 8px", borderRadius: 6, fontSize: 11.5, lineHeight: "19px",
				border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))",
				background: "var(--dsw-alias-bg-layer-2, transparent)",
				color: "var(--dsw-alias-label-primary, currentColor)",
			},
			err: { color: "var(--dsw-alias-state-error-primary, #e5534b)", fontSize: 11.5 },
			list: { display: "flex", flexDirection: "column", gap: 6, margin: 0, padding: 0, listStyle: "none" },
		};

		/** 跑的是不是**我们的 agent**（与 client.capsule.js / client.botSettingsBtn.js 同判据）。 */
		function isAgentPreset(presetId) {
			return isBotPresetId(presetId);
		}

		/** 会话 → agentId（`vssaros-<id>` 的 preset）；取不到返回空串（调用方必须显式处理）。 */
		function agentIdOf(ctx, sessionId) {
			try {
				const list = ctx && ctx.sessions && ctx.sessions.list;
				const snap = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : null;
				const summary = sessionId && snap && snap.byId ? snap.byId[sessionId] : undefined;
				// 身份记录优先（权威 botId）；老会话没记录 ⇒ 退回去前缀
				const bot = sessionBotOf(summary && summary.projectionValues);
				return bot.isBot ? (bot.botId || bot.presetId.slice(VSSAROS_PREFIX.length)) : "";
			} catch {
				return "";
			}
		}

		/** 订阅会话列表（agent 变化 / 重绑都要重算 agentId）。 */
		function useSessionsTick(ctx) {
			const [, force] = react.useState(0);
			react.useEffect(() => {
				let off;
				try {
					const list = ctx && ctx.sessions && ctx.sessions.list;
					if (list && typeof list.subscribe === "function") {
						off = list.subscribe(() => force((n) => n + 1));
					}
				} catch {
					off = undefined;
				}
				return () => {
					try { if (typeof off === "function") { off(); } } catch { /* 退订失败无妨 */ }
				};
			}, [ctx]);
		}

		function getJson(url) {
			return fetch(url, { credentials: "same-origin", headers: { accept: "application/json" } })
				.then((res) => res.json().catch(() => null).then((body) => {
					if (!res.ok) {
						throw new Error(body && body.error ? String(body.error) : "HTTP " + res.status);
					}
					if (!body) { throw new Error("响应不是 JSON"); }
					return body;
				}));
		}

		function postJson(url, body) {
			return fetch(url, {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify(body || {}),
			}).then((res) => res.json().catch(() => null).then((data) => {
				if (!res.ok) {
					throw new Error(data && data.error ? String(data.error) : "HTTP " + res.status);
				}
				if (!data) { throw new Error("响应不是 JSON"); }
				return data;
			}));
		}

		/**
		 * 打开一个 dsh 页面：优先宿主桥（IDE 内开页），否则新标签（dsh desktop / 纯浏览器）。
		 * 两路都失败要**明确说出来**（"点了没反应"是本仓查过多次的坑 ✗）。
		 */
		function openPage(bridge, path, say) {
			try {
				if (bridge && typeof bridge.openModulePage === "function") {
					Promise.resolve(bridge.openModulePage(path)).catch((e) => say("打开页面失败：" + String((e && e.message) || e)));
					return;
				}
			} catch (e) {
				say("打开页面失败：" + String((e && e.message) || e));
				return;
			}
			try {
				const w = window.open(path, "_blank", "noopener");
				if (!w) { say("浏览器拦截了新标签页，请手动打开：" + path); }
			} catch (e) {
				say("打开页面失败：" + String((e && e.message) || e));
			}
		}

		/**
		 * 把 MEMORY.md 切成可渲染的行（标题 / 列表项 / 普通段落）。
		 * 跳过 HTML 注释块（模板里那段说明是给 agent 看的，展示时是噪音）。
		 */
		function parseMemory(text) {
			const out = [];
			let inComment = false;
			for (const raw of String(text == null ? "" : text).split("\n")) {
				let line = raw;
				if (inComment) {
					const end = line.indexOf("-->");
					if (end < 0) { continue; }
					inComment = false;
					line = line.slice(end + 3);
				}
				const start = line.indexOf("<!--");
				if (start >= 0) {
					const end = line.indexOf("-->", start + 4);
					if (end < 0) { inComment = true; line = line.slice(0, start); }
					else { line = line.slice(0, start) + line.slice(end + 3); }
				}
				const trimmed = line.replace(/\s+$/, "");
				if (!trimmed.trim()) { continue; }
				if (/^\s{0,3}#{1,6}\s/.test(trimmed)) {
					out.push({ kind: "head", text: trimmed.replace(/^\s{0,3}#{1,6}\s*/, "") });
					continue;
				}
				if (/^\s*[-*+]\s+/.test(trimmed)) {
					out.push({ kind: "item", text: trimmed.replace(/^\s*[-*+]\s+/, "") });
					continue;
				}
				out.push({ kind: "text", text: trimmed.trim() });
			}
			return out;
		}

		/** 字节数 → 人类可读（只用于"文件多大"，不参与任何判定）。 */
		function sizeLabel(bytes) {
			const n = Number(bytes);
			if (!Number.isFinite(n) || n <= 0) { return "0 B"; }
			if (n < 1024) { return n + " B"; }
			if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + " KB"; }
			return (n / 1024 / 1024).toFixed(1) + " MB";
		}

		/**
		 * 数据加载三态（loading / error / data）+ 手动 reload。
		 * ⚠ 错误**必须**由调用方渲染出来（静默失败是本仓反复踩的坑）。
		 */
		function useLoader(load, deps) {
			const [state, setState] = react.useState({ loading: true, error: "", data: null });
			const [tick, setTick] = react.useState(0);
			const key = JSON.stringify(deps || []);
			react.useEffect(() => {
				let alive = true;
				setState((prev) => ({ loading: true, error: "", data: prev.data }));
				Promise.resolve()
					.then(() => load())
					.then((data) => { if (alive) { setState({ loading: false, error: "", data }); } })
					.catch((e) => { if (alive) { setState({ loading: false, error: String((e && e.message) || e), data: null }); } });
				return () => { alive = false; };
			}, [key, tick]);
			return [state, () => setTick((n) => n + 1)];
		}

		/** 小工具：带 key 的元素数组（children 数组直接交给 createElement，React 认 key）。 */
		function kids(list) {
			return list.filter((x) => x !== null && x !== undefined && x !== false);
		}

		// ── Markdown → React 元素（2026-11-06，用户报「对话 UI 中 markdown 内容没有正确显示」）────────────
		// 群工具卡里成员的回复是 Markdown（**粗体**、`代码`、列表、表格、代码块），原来按纯文本 pre-wrap 显示。
		// 官方的 `MarkdownText`（dsh-client-ui-primitives）在插件 chunk 里拿不到（只许 require("react")）⇒ 这里自带一个
		// 轻量渲染器。纪律：
		//   · **只产 React 元素**，不用 innerHTML ⇒ 文本天然转义，没有 XSS 面；
		//   · 链接只放行 http(s) / mailto，其余（javascript: 等）按原文显示；
		//   · 段内换行保留成 <br>（聊天回复常靠换行排版：「① …\n② …」，CommonMark 会把它们并成一行）；
		//   · 粗体 / 斜体不套 CommonMark 的左右侧规则：`**已对齐**：`、`**中文（括号）**中文` 这类 CJK 写法照样加粗。
		const MD_MAX_CHARS = 60000;
		const MD = {
			code: { fontFamily: "var(--dsw-font-mono, ui-monospace, SFMono-Regular, Consolas, monospace)", fontSize: "0.92em", padding: "0 4px", borderRadius: 4,
				background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14))" },
			pre: { margin: "4px 0", padding: "8px 10px", borderRadius: 6, overflowX: "auto", whiteSpace: "pre", fontSize: 12, lineHeight: "18px",
				fontFamily: "var(--dsw-font-mono, ui-monospace, SFMono-Regular, Consolas, monospace)", background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14))" },
			p: { margin: "2px 0" },
			list: { margin: "2px 0", paddingLeft: 22 },
			li: { margin: "1px 0" },
			quote: { margin: "4px 0", padding: "0 0 0 10px", borderLeft: "3px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))",
				color: "var(--dsw-alias-label-secondary, inherit)" },
			hr: { border: 0, borderTop: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))", margin: "8px 0" },
			table: { borderCollapse: "collapse", margin: "4px 0", fontSize: 12 },
			cell: { border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))", padding: "3px 8px", textAlign: "left", verticalAlign: "top" },
			link: { color: "var(--dsw-alias-brand-primary, #3794ff)" },
		};
		const HEADING_SIZES = [16, 15, 14, 13.5, 13, 13];
		/** 行内：`代码`、**粗体** / __粗体__、*斜体*、~~删除线~~、[文字](链接)。纯函数（输入文本 ⇒ React 节点数组）。 */
		function mdInline(text, keyBase) {
			const s = String(text || "");
			const out = [];
			let buf = "";
			let n = 0;
			const key = () => keyBase + "." + (n++);
			const flush = () => { if (buf) { out.push(buf); buf = ""; } };
			let i = 0;
			while (i < s.length) {
				const ch = s[i];
				if (ch === "\\" && i + 1 < s.length && /[\\`*_~\[\]()#>|!-]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
				if (ch === "`") {
					let run = 1;
					while (s[i + run] === "`") { run++; }
					const fence = "`".repeat(run);
					const end = s.indexOf(fence, i + run);
					if (end > i) {
						flush();
						let body = s.slice(i + run, end);
						if (/^ .* $/.test(body) && body.trim()) { body = body.slice(1, -1); }
						out.push(react.createElement("code", { key: key(), style: MD.code }, body));
						i = end + run;
						continue;
					}
					buf += fence; i += run; continue;
				}
				const pair = (mark, tag, style) => {
					if (!s.startsWith(mark, i)) { return false; }
					const end = s.indexOf(mark, i + mark.length);
					if (end <= i + mark.length || /^\s/.test(s[i + mark.length])) { return false; }
					flush();
					const k = key();
					out.push(react.createElement(tag, { key: k, style }, mdInline(s.slice(i + mark.length, end), k)));
					i = end + mark.length;
					return true;
				};
				if (pair("**", "strong", { fontWeight: 600 }) || pair("__", "strong", { fontWeight: 600 }) || pair("~~", "del", null)) { continue; }
				if (ch === "*" && pair("*", "em", null)) { continue; }
				if (ch === "[") {
					const m = /^\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(s.slice(i));
					if (m) {
						flush();
						const k = key();
						const href = m[2];
						out.push(/^(https?:|mailto:)/i.test(href)
							? react.createElement("a", { key: k, href, target: "_blank", rel: "noopener noreferrer", style: MD.link }, mdInline(m[1], k))
							: react.createElement("span", { key: k }, m[0]));
						i += m[0].length;
						continue;
					}
				}
				buf += ch; i++;
			}
			flush();
			return out;
		}
		const MD_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
		const MD_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
		const MD_HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
		const MD_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
		const MD_QUOTE = /^\s{0,3}>\s?(.*)$/;
		const MD_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
		const mdCells = (line) => String(line).trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
		const mdStartsBlock = (line, next) => MD_FENCE.test(line) || MD_HEADING.test(line) || MD_HR.test(line) || MD_ITEM.test(line) || MD_QUOTE.test(line)
			|| (line.indexOf("|") >= 0 && next !== undefined && MD_TABLE_SEP.test(next));
		/** 块级：代码块、标题、分隔线、引用、（嵌套）列表、表格、段落。纯函数（行数组 ⇒ React 节点数组）。 */
		function mdBlocks(lines, keyBase) {
			const out = [];
			let n = 0;
			const key = () => keyBase + "/" + (n++);
			let i = 0;
			while (i < lines.length) {
				const line = lines[i];
				if (!line.trim()) { i++; continue; }
				const fence = MD_FENCE.exec(line);
				if (fence) {
					const close = new RegExp("^\\s{0,3}" + fence[1][0] + "{" + fence[1].length + ",}\\s*$");
					const body = [];
					i++;
					while (i < lines.length && !close.test(lines[i])) { body.push(lines[i]); i++; }
					i++;
					out.push(react.createElement("pre", { key: key(), style: MD.pre, "data-lang": fence[2] || undefined }, react.createElement("code", null, body.join("\n"))));
					continue;
				}
				const heading = MD_HEADING.exec(line);
				if (heading) {
					const k = key();
					out.push(react.createElement("div", { key: k, role: "heading", "aria-level": heading[1].length,
						style: { fontWeight: 600, fontSize: HEADING_SIZES[heading[1].length - 1], margin: "6px 0 2px" } }, mdInline(heading[2], k)));
					i++;
					continue;
				}
				if (MD_HR.test(line)) {
					out.push(react.createElement("hr", { key: key(), style: MD.hr }));
					i++;
					continue;
				}
				if (MD_QUOTE.test(line)) {
					const body = [];
					while (i < lines.length && MD_QUOTE.test(lines[i])) { body.push(MD_QUOTE.exec(lines[i])[1]); i++; }
					const k = key();
					out.push(react.createElement("blockquote", { key: k, style: MD.quote }, mdBlocks(body, k)));
					continue;
				}
				if (line.indexOf("|") >= 0 && i + 1 < lines.length && MD_TABLE_SEP.test(lines[i + 1])) {
					const head = mdCells(line);
					const rows = [];
					i += 2;
					while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") >= 0) { rows.push(mdCells(lines[i])); i++; }
					const k = key();
					out.push(react.createElement("div", { key: k, style: { overflowX: "auto" } },
						react.createElement("table", { style: MD.table }, [
							react.createElement("thead", { key: "h" }, react.createElement("tr", null,
								head.map((c, j) => react.createElement("th", { key: j, style: Object.assign({}, MD.cell, { fontWeight: 600 }) }, mdInline(c, k + "h" + j))))),
							react.createElement("tbody", { key: "b" }, rows.map((r, ri) => react.createElement("tr", { key: ri },
								head.map((_, j) => react.createElement("td", { key: j, style: MD.cell }, mdInline(r[j] || "", k + "r" + ri + "c" + j)))))),
						])));
					continue;
				}
				const item = MD_ITEM.exec(line);
				if (item) {
					const base = item[1].length;
					const ordered = /\d/.test(item[2]);
					const items = [];
					while (i < lines.length) {
						const cur = lines[i];
						const m = MD_ITEM.exec(cur);
						if (m && m[1].length <= base + 1 && /\d/.test(m[2]) === ordered) {
							items.push({ marker: m[2], lines: [m[3]] });
							i++;
							continue;
						}
						if (m && m[1].length <= base + 1) { break; }   // 另一种列表 ⇒ 另起
						if (!cur.trim()) {
							let j = i + 1;
							while (j < lines.length && !lines[j].trim()) { j++; }
							const nm = j < lines.length ? MD_ITEM.exec(lines[j]) : null;
							const indented = j < lines.length && /^\s+/.test(lines[j]) && (lines[j].match(/^\s*/)[0].length > base);
							if ((nm && nm[1].length <= base + 1 && /\d/.test(nm[2]) === ordered) || indented) { items[items.length - 1].lines.push(""); i++; continue; }
							break;
						}
						const indent = cur.match(/^\s*/)[0].length;
						if (indent > base) { items[items.length - 1].lines.push(cur.slice(Math.min(indent, base + 2))); i++; continue; }
						if (!mdStartsBlock(cur, lines[i + 1])) { items[items.length - 1].lines.push(cur.trim()); i++; continue; }   // 惰性续行
						break;
					}
					const k = key();
					const start = ordered ? parseInt(items[0].marker, 10) : undefined;
					out.push(react.createElement(ordered ? "ol" : "ul", { key: k, style: MD.list, ...(ordered && start !== 1 ? { start } : {}) },
						items.map((it, j) => {
							const task = /^\[([ xX])\]\s+/.exec(it.lines[0]);
							if (task) { it.lines[0] = it.lines[0].slice(task[0].length); }
							const body = mdBlocks(it.lines, k + "i" + j);
							const inner = body.length === 1 && body[0] && body[0].type === "p" ? body[0].props.children : body;
							return react.createElement("li", { key: j, style: Object.assign({}, MD.li, task ? { listStyle: "none", marginLeft: -18 } : null) },
								task ? [react.createElement("span", { key: "t", "aria-hidden": "true" }, task[1] === " " ? "☐ " : "☑ ")].concat(inner) : inner);
						})));
					continue;
				}
				const para = [];
				while (i < lines.length && lines[i].trim() && (para.length === 0 || !mdStartsBlock(lines[i], lines[i + 1]))) { para.push(lines[i].trim()); i++; }
				const k = key();
				const children = [];
				para.forEach((l, j) => { if (j) { children.push(react.createElement("br", { key: "br" + j })); } children.push(...mdInline(l, k + "l" + j)); });
				out.push(react.createElement("p", { key: k, style: MD.p }, children));
			}
			return out;
		}
		/** 一段 Markdown ⇒ React 节点（超长 ⇒ 按纯文本显示，免得卡住渲染）。 */
		function markdownNodes(text) {
			const s = String(text || "");
			if (s.length > MD_MAX_CHARS) { return [react.createElement("div", { key: "raw", style: { whiteSpace: "pre-wrap" } }, s)]; }
			return mdBlocks(s.replace(/\r\n?/g, "\n").split("\n"), "md");
		}

		// ── 工作区（会话 cwd）────────────────────────────────────────────────────
		// 「当前工作区 / 当前根」只认 `sessions.byId[sid].cwd`（宿主持有的硬事实）：
		// 工作区快照里的 sessionIds 会与 cwd 分叉（2026-10-28 事故，见 client.workspaces.js 的 rootOfSession）。

		/** 会话 → cwd；取不到返回空串。 */
		function cwdOf(ctx, sessionId) {
			try {
				const list = ctx && ctx.sessions && ctx.sessions.list;
				const snap = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : null;
				const summary = sessionId && snap && snap.byId ? snap.byId[sessionId] : undefined;
				return summary && typeof summary.cwd === "string" ? summary.cwd : "";
			} catch {
				return "";
			}
		}

		function normPath(p) {
			return String(p || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
		}
		function baseName(p) {
			const s = String(p || "").replace(/[\\/]+$/, "");
			const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
			return i >= 0 ? s.slice(i + 1) : s;
		}
		/** a 是否等于 b 或在 b 之下（Windows 口径：大小写不敏感、分隔符统一）。 */
		function isUnder(a, b) {
			const x = normPath(a);
			const y = normPath(b);
			return !!x && !!y && (x === y || x.startsWith(y + "\\"));
		}

		/**
		 * 会话所在工作区的根列表（多根工作区 ⇒ 每个根一份记忆，页签里可切换）。
		 * 数据源 = 宿主写在 `<html data-vssaros-workspaces>` 的工作区记录（与 client.workspaces.js 同一份）；
		 * 读不到（dsh 纯浏览器 / 桌面窗口没有那份记录）⇒ 只有会话 cwd 这一个选项。
		 * 每个选项的 `cwd` 是交给 Host 解析身份的路径：会话所在的根传**会话 cwd**（子目录会话也落到同一个
		 * git 根），其它根传根路径本身。
		 * @returns {{ name: string, cwd: string, current: boolean }[]}
		 */
		function rootOptionsFor(cwd) {
			if (!cwd) { return []; }
			const own = { name: baseName(cwd) || cwd, cwd, current: true };
			let records = [];
			try {
				const raw = typeof document !== "undefined" && document.documentElement
					? document.documentElement.dataset.vssarosWorkspaces : "";
				const parsed = raw ? JSON.parse(raw) : [];
				records = Array.isArray(parsed) ? parsed : [];
			} catch {
				records = [];
			}
			for (const rec of records) {
				const roots = rec && Array.isArray(rec.roots)
					? rec.roots.filter((r) => r && typeof r.path === "string" && r.path) : [];
				const mine = roots.find((r) => isUnder(cwd, r.path));
				if (!mine || roots.length < 2) { continue; }
				return roots.map((r) => {
					const isMine = r === mine;
					const name = (typeof r.name === "string" && r.name.trim()) ? r.name.trim() : baseName(r.path);
					return { name, cwd: isMine ? cwd : r.path, current: isMine };
				});
			}
			return [own];
		}

		/** 分段切换（工作区 / Bot）。disabled 的那一段要说明为什么不可选。 */
		function Segment(props) {
			return react.createElement("div", { style: Object.assign({}, C.row, { gap: 4 }) },
				props.options.map((o) => react.createElement("button", {
					key: o.value,
					type: "button",
					disabled: !!o.disabled,
					title: o.title || "",
					style: Object.assign({}, props.value === o.value ? C.btnPrimary : C.btn, o.disabled ? { opacity: 0.45, cursor: "not-allowed" } : {}),
					onClick: () => { if (!o.disabled) { props.onChange(o.value); } },
				}, o.label)));
		}

		/** 宿主插件太旧时，接口 404 —— 说清楚原因与解法，别只甩一个 HTTP 码。 */
		function explainLoadError(message) {
			const m = String(message || "");
			if (/404|unknown route/i.test(m)) {
				return m + "（需要 @vssaros/dsh-agents ≥ 0.2.310；装好后重启 app 才生效）";
			}
			return m;
		}

		/**
		 * 记忆历史（★ 2026-11-03 P3；2026-11-06 起只服务统一记忆的 bot 轨：props.api 必填）。
		 * 数据源 = props.api（现在只有 @vssaros/dsh-memory 的 /memory-evolve/api/bot-history；响应 log / diff），
		 * 所以这里只是另一个视图，不是另一套实现。默认折叠，展开才发请求（读口一次要起几条 git 子进程）。
		 *
		 * 回滚语义（Host 侧 `restoreMemoryFile`，只追加不改写历史）：先把未提交改动落成一条提交，
		 * 再写回旧内容并再提交一条 ⇒ 任何一步都能再回去。仍然加一道二次确认，并如实写出会恢复/移除多少行。
		 */
		function MemoryHistoryPanel(props) {
			const say = props.say;
			const scopeId = props.scopeId;
			const [open, setOpen] = react.useState(false);
			const [sel, setSel] = react.useState("");
			const [confirming, setConfirming] = react.useState(false);
			const [busy, setBusy] = react.useState(false);
			const [err, setErr] = react.useState("");
			// ★ 2026-11-05：api / scopeParam 参数化 —— Bot 记忆并入 @vssaros/dsh-memory 后，同一个面板也读它的
			//   /memory-evolve/api/bot-history?sessionId=（响应同形：log / diff）。缺省仍是 dsh-agents 旧接口（回滚开关用）。
			const api = props.api;
			const scopeParam = props.scopeParam || "agent";
			const scopeQuery = api + "?" + scopeParam + "=" + encodeURIComponent(scopeId || "");
			const listUrl = open && scopeId ? scopeQuery + "&limit=15&nonce=" + String(props.version || 0) : "";
			const [list, reloadList] = useLoader(() => (listUrl ? getJson(listUrl) : Promise.resolve(null)), [listUrl]);
			const revUrl = open && sel
				? scopeQuery + "&rev=" + encodeURIComponent(sel) + "&against=working&file=MEMORY.md"
				: "";
			const [rev] = useLoader(() => (revUrl ? getJson(revUrl) : Promise.resolve(null)), [revUrl]);
			react.useEffect(() => { setSel(""); setConfirming(false); setErr(""); }, [scopeId]);

			const toggle = react.createElement("button", {
				key: "tg", type: "button", style: C.btn, onClick: () => setOpen(!open),
				title: "记忆目录自己的提交历史：看某一版、回滚到某一版",
			}, open ? "收起历史" : "展开历史");
			if (!open) {
				return react.createElement("div", { style: C.row }, kids([toggle]));
			}

			const commits = list.data && Array.isArray(list.data.log) ? list.data.log : [];
			const diff = rev.data && rev.data.diff ? rev.data.diff : null;
			const restore = () => {
				setBusy(true);
				setErr("");
				postJson(api, { [scopeParam]: scopeId, action: "restore", rev: sel, file: "MEMORY.md" })
					.then(() => {
						if (say) { say("已回滚到 " + sel + "（回滚前的内容已另存为一条提交，可再回到）"); }
						setConfirming(false);
						setSel("");
						reloadList();
						if (props.onChanged) { props.onChanged(); }
					})
					.catch((e) => setErr("回滚失败：" + explainLoadError(String((e && e.message) || e))))
					.then(() => setBusy(false));
			};

			let detail = null;
			if (sel) {
				if (rev.error) {
					detail = react.createElement("div", { key: "d", style: C.err }, "读取这一版失败：" + explainLoadError(rev.error));
				} else if (!rev.data) {
					detail = react.createElement("div", { key: "d", style: C.tiny }, "正在读取这一版…");
				} else {
					const restoreN = diff ? (Number(diff.removed) || 0) : 0;  // del：历史版有、当前没有 ⇒ 回滚会恢复
					const dropN = diff ? (Number(diff.added) || 0) : 0;       // add：当前有、历史版没有 ⇒ 回滚会移除
					const changed = diff ? (diff.rows || []).filter((r) => r.type !== "same").slice(0, 60) : [];
					detail = react.createElement("div", { key: "d", style: C.card }, kids([
						react.createElement("div", { key: "t", style: C.row }, kids([
							react.createElement("span", { key: "n", style: C.title }, "版本 " + sel),
							react.createElement("span", { key: "c", style: C.badge }, "回滚会恢复 " + restoreN + (props.api ? " 条" : " 行") + " · 移除 " + dropN + (props.api ? " 条" : " 行")),
							react.createElement("span", { key: "sp", style: C.grow }),
							confirming
								? kids([
									react.createElement("button", { key: "x", type: "button", style: C.btn, disabled: busy, onClick: () => setConfirming(false) }, "取消"),
									react.createElement("button", { key: "o", type: "button", style: C.btnPrimary, disabled: busy, onClick: restore }, busy ? "回滚中…" : "确认回滚"),
								])
								: react.createElement("button", {
									key: "r", type: "button", style: C.btn, disabled: busy || (restoreN === 0 && dropN === 0),
									title: restoreN === 0 && dropN === 0 ? "这一版与当前内容相同，无需回滚" : "",
									onClick: () => setConfirming(true),
								}, "回滚到这一版"),
						])),
						confirming
							? react.createElement("div", { key: "w", style: Object.assign({}, C.tiny, { marginTop: 4 }) },
								"确认后：当前未提交的改动会先存成一条提交，再把 MEMORY.md 写回这一版并再提交一条——历史只追加，之后还能回到现在这个状态。")
							: null,
						changed.length === 0
							? react.createElement("div", { key: "same", style: Object.assign({}, C.sub, { marginTop: 4 }) }, "这一版与当前内容完全相同。")
							: react.createElement("div", { key: "rows", style: Object.assign({}, C.list, { marginTop: 6 }) },
								changed.map((r, i) => react.createElement("div", {
									key: "r" + i,
									style: Object.assign({}, C.item, {
										fontFamily: "ui-monospace, Consolas, monospace",
										color: r.type === "del" ? "var(--dsw-alias-state-success-primary, #3fb950)" : "var(--dsw-alias-state-error-primary, #f85149)",
									}),
									// 条目自带 Markdown 列表符（"- [日期] …"）⇒ 去掉，否则显示成 "+ - …" / "- - …" 很难读
								}, (r.type === "del" ? "+ " : "- ") + String(r.text).replace(/^\s*[-*+]\s+/, "")))),
						diff && (diff.rows || []).filter((r) => r.type !== "same").length > 60
							? react.createElement("div", { key: "more", style: C.tiny }, (props.api ? "只显示前 60 处差异。" : "只显示前 60 处差异；完整对比在「完整页」。"))
							: null,
						react.createElement("div", { key: "legend", style: Object.assign({}, C.tiny, { marginTop: 4 }) },
							"+ 绿色：这一版有、当前没有（回滚会恢复） · - 红色：当前有、这一版没有（回滚会移除）"),
					]));
				}
			}

			return react.createElement("div", { style: C.col }, kids([
				react.createElement("div", { key: "h", style: C.row }, kids([
					react.createElement("span", { key: "t", style: C.title }, "历史"),
					react.createElement("span", { key: "sp", style: C.grow }),
					react.createElement("button", { key: "rf", type: "button", style: C.btn, onClick: reloadList }, "刷新"),
					toggle,
				])),
				list.error
					? react.createElement("div", { key: "e", style: C.err }, "读取历史失败：" + explainLoadError(list.error))
					: !list.data
						? react.createElement("div", { key: "l", style: C.tiny }, "正在读取历史…")
						: commits.length === 0
							? react.createElement("div", { key: "z", style: C.sub }, "还没有提交。")
							: react.createElement("div", { key: "list", style: C.list },
								commits.map((c) => react.createElement("div", {
									key: c.hash,
									style: Object.assign({}, C.item, {
										display: "flex", gap: 8, alignItems: "center", cursor: "pointer",
										outline: sel === c.hash ? "1px solid var(--dsw-alias-state-business-primary, #6e7681)" : "none",
									}),
									onClick: () => { setSel(sel === c.hash ? "" : c.hash); setConfirming(false); setErr(""); },
								}, kids([
									react.createElement("span", { key: "h", style: C.badge }, String(c.hash)),
									react.createElement("span", { key: "s", style: C.grow }, String(c.subject || "")),
									react.createElement("span", { key: "d", style: C.tiny }, String(c.date || "")),
								])))),
								list.data && list.data.legacy
					? react.createElement("div", { key: "legacy", style: C.tiny }, "旧版（dsh-agents）的历史已另存为只读的 legacy-history.bundle，与 Bot 记忆在同一目录。")
					: null,
err ? react.createElement("div", { key: "err", style: C.err }, err) : null,
				detail,
			]));
		}

				/**
		 * Bot 记忆 · 版本历史（★ 2026-11-05「记忆收敛」S2）：Bot 记忆在 @vssaros/dsh-memory 的 bot 轨，
		 * 每次写入后自动落一条 git 提交；这里看某一版与当前的差异、二次确认后回滚（历史只追加）。
		 * 条目本身在「记忆」页签的「Bot 记忆」行里看和改。按会话定位 Bot（与记忆插件同一判据）。
		 */
		const BOT_HISTORY_API = "/memory-evolve/api/bot-history";
		function BotMemoryHistoryCard(props) {
			return react.createElement("div", { style: C.card, "data-vssaros-view": "bot-memory-history" }, kids([
				react.createElement("div", { key: "t", style: C.title }, "Bot 记忆 · 版本历史"),
				react.createElement("div", { key: "s", style: Object.assign({}, C.sub, { marginTop: 4, marginBottom: 6 }) },
					"每次写入 Bot 记忆后自动保存一个版本，可以对比某一版与当前内容并回滚。条目在「记忆」页签里查看和编辑。"),
				react.createElement(MemoryHistoryPanel, { key: "p", api: BOT_HISTORY_API, scopeParam: "sessionId", scopeId: props.sessionId, say: props.say }),
			]));
		}

		/** 记忆页 / 记忆设置页顶部：「工作区 | Bot」分段 + 多根工作区的根选择。 */
		function useScopePicker(ctx, sessionId) {
			useSessionsTick(ctx);
			const agentId = agentIdOf(ctx, sessionId);
			const cwd = cwdOf(ctx, sessionId);
			const roots = rootOptionsFor(cwd);
			const [scope, setScope] = react.useState("workspace");
			const [rootCwd, setRootCwd] = react.useState("");
			// 会话换了 ⇒ 回到默认（工作区 + 会话自己的根）
			react.useEffect(() => { setScope("workspace"); setRootCwd(""); }, [sessionId]);
			const effectiveScope = scope === "bot" && !agentId ? "workspace" : scope;
			const picked = roots.find((r) => r.cwd === rootCwd) || roots.find((r) => r.current) || roots[0];
			const bar = react.createElement("div", { key: "scope", style: C.row }, kids([
				react.createElement(Segment, {
					key: "seg",
					value: effectiveScope,
					onChange: setScope,
					options: [
						{ value: "workspace", label: "工作区" },
						{
							value: "bot", label: agentId ? ("Bot · " + agentId) : "Bot",
							disabled: !agentId,
							title: agentId ? "" : "当前会话没有选 Bot（preset 不是 vssaros-*）⇒ 没有 Bot 记忆",
						},
					],
				}),
				effectiveScope === "workspace" && roots.length > 1
					? react.createElement("span", { key: "sep", style: C.tiny }, "根：")
					: null,
				effectiveScope === "workspace" && roots.length > 1
					? react.createElement(Segment, {
						key: "roots",
						value: picked ? picked.cwd : "",
						onChange: setRootCwd,
						options: roots.map((r) => ({ value: r.cwd, label: r.name + (r.current ? "（当前）" : ""), title: r.cwd })),
					})
					: null,
			]));
			return { agentId, scope: effectiveScope, cwd: picked ? picked.cwd : "", bar };
		}

		/**
		 * 「VsSaros Memory 模块」配置面板（★ 2026-11-03 两套页签合并；2026-11-04 扩成完整面板）。
		 * 原 evolve「设置」页签的「配置」子页全部运行时键都在这里（同源 /memory-evolve/api/config），
		 * 插件报错里的「请在『设置』Tab 的『配置』里打开 X」指的就是这里。
		 * 分组表外的新键自动落进「其它」组 ⇒ 上游加了开关也不会在 UI 上消失。
		 * 被 lockedOffKeys 锁定的项（响应里的 `locked`）显示为只读。
		 * 指南 / 待确认建议在 evolve 的「记忆」页签内，不在这里重复。
		 */
		const MEM_CONFIG_API = "/memory-evolve/api/config";
		const MEM_UPDATE_API = "/memory-evolve/api/update/status";
		const MEM_GROUPS = [
			{
				id: "write", title: "每轮写入", open: true, hint: "快照按这些开关要求模型在回合末写记忆；每开一项，每个回合就多一次工具调用。", fields: [
					{ key: "perTurnProjectWrites", label: "每轮写项目进展", hint: "target=project · 按项目累积的进展记录" },
					{ key: "perTurnDailyWrites", label: "每轮写今日日志", hint: "target=daily · 按日期滚动的工作日志" },
					{ key: "perTurnKeyWrites", label: "按需写项目关键记忆", hint: "target=key · 本轮出现重要项目事实（约定/决策/架构/踩坑）时写一条；写入方式见下一项" },
					// ★ 2026-11-05：key 轨 add 的去向（原 dsh-agents 的 workspace_memory 是直写，并入后默认仍直写）
					{ key: "keyWriteMode", label: "项目关键记忆写入方式", hint: "子代理写入始终进待确认队列；队列在「记忆」页签里确认", type: "enum", options: [["direct", "主会话直接写入"], ["queue", "全部进待确认队列"]] },
					{ key: "perTurnWriteGuard", label: "漏写提醒", hint: "连续 N 轮没写就在快照里提醒；只在开了上面两项时有意义" },
					{ key: "writeGuardThreshold", dep: "perTurnWriteGuard", label: "漏写提醒阈值", unit: "轮", type: "int", min: 1 },
				]
			},
			{
				id: "review", title: "记忆审查", fields: [
					{ key: "reviewEnabled", label: "回合内记忆审查", hint: "每隔几轮让模型回顾对话，提炼值得长期保留的内容" },
					{ key: "reviewInterval", dep: "reviewEnabled", label: "审查间隔", unit: "轮", type: "int", min: 1 },
					{ key: "reviewMode", dep: "reviewEnabled", label: "审查结果处理", type: "enum", options: [["suggest", "提建议，人工确认"], ["auto", "直接写入"]] },
					{ key: "skillReviewEnabled", label: "新技能直接生效", hint: "关闭时新技能先进入待确认队列" },
				]
			},
			{
				id: "key", title: "记忆注入", fields: [
					{ key: "keyProgressiveDisclosure", label: "注入方式", hint: "条目多时只注入摘要，模型按需再读全文", type: "enum", options: [["off", "始终全文"], ["auto", "按数据量自动"], ["on", "始终摘要"]] },
					{ key: "keyFullInjectThreshold", label: "全文注入条数上限", unit: "条", type: "int", min: 1 },
					{ key: "keyFullInjectCharLimit", label: "全文注入字符上限", unit: "字符", type: "int", min: 1 },
					// ★ 2026-11-05「记忆收敛成一套」：原 Bot 设置里的「注入到 system prompt」上限并到这里（全局，所有 Bot 共用）
					{ key: "botMemoryCharLimit", label: "Bot 记忆注入上限", hint: "Bot 会话注入该 Bot 自己的记忆（target=bot），按整条截断；0 = 不注入", unit: "字符", type: "int", min: 0 },
				]
			},
			{
				id: "modules", title: "功能模块", open: true, fields: [
					{ key: "todoEnabled", label: "待办", hint: "dtodo 工具与「待办」页签" },
					{ key: "modelsEnabled", label: "模型设置" },
					{ key: "promptsEnabled", label: "提示词库" },
					{ key: "bookmarkEnabled", label: "会话书签" },
					{ key: "uiSettingsEnabled", label: "界面增强" },
					{ key: "sessionEnabled", label: "会话编排", hint: "让模型创建、调度其它会话" },
					{ key: "sessionSearchEnabled", label: "会话搜索", hint: "检索历史会话内容" },
					{ key: "sessionImageQueryEnabled", label: "会话图片查询" },
					{ key: "notifyEnabled", label: "渠道通知" },
					{ key: "channelSendEnabled", label: "渠道直发" },
					{ key: "broadcastEnabled", label: "会话广播", hint: "会话之间互发消息" },
					{ key: "broadcastImageEnabled", dep: "broadcastEnabled", label: "广播允许带图片" },
					{ key: "wsCoordEnabled", label: "工作区协调", hint: "多个会话同时改同一工作区时互相知会" },
					{ key: "wsCoordEnforceWrite", dep: "wsCoordEnabled", label: "工作区协调：写入前强制检查" },
					{ key: "wsCoordSnapshot", dep: "wsCoordEnabled", label: "工作区协调：注入快照" },
				]
			},
			{
				id: "advisor", title: "Advisor 评审", fields: [
					{ key: "advisorEnabled", label: "启用 Advisor", hint: "另一个模型旁听会话并给出评审意见" },
					{ key: "advisorPanelEnabled", dep: "advisorEnabled", label: "显示悬浮面板" },
					{ key: "advisorInfoInject", dep: "advisorEnabled", label: "注入 info 级意见" },
					{ key: "advisorProvider", dep: "advisorEnabled", label: "供应商", hint: "留空 = 跟随会话", placeholder: "跟随会话", type: "str", nullable: true },
					{ key: "advisorModel", dep: "advisorEnabled", label: "模型", hint: "留空 = 跟随会话", placeholder: "跟随会话", type: "str", nullable: true },
					{ key: "advisorSteerSeverities", dep: "advisorEnabled", label: "会打断会话的级别", type: "multi", options: [["nit", "nit"], ["concern", "concern"], ["blocker", "blocker"]] },
					{ key: "advisorImmuneTurns", dep: "advisorEnabled", label: "开局免评回合数", unit: "轮", type: "int", min: 0 },
					{ key: "advisorMaxMessages", dep: "advisorEnabled", label: "每次带入消息数上限", unit: "条", type: "int", min: 0 },
					{ key: "advisorMaxQueued", dep: "advisorEnabled", label: "排队上限", unit: "条", type: "int", min: 0 },
					{ key: "advisorCallTimeoutMs", dep: "advisorEnabled", label: "调用超时", unit: "毫秒", type: "int", min: 1 },
					{ key: "advisorSystemPrompt", dep: "advisorEnabled", label: "系统提示词", hint: "留空使用默认提示词", type: "text" },
				]
			},
			{
				id: "unverified", title: "未通过 Windows 验证的模块", hint: "上游测试在 Windows 上未通过，已锁定为关闭。", fields: [
					{ key: "canvasEnabled", label: "无限画板" },
					{ key: "coiEnabled", label: "CLI 调度（COI）" },
					{ key: "syncEnabled", label: "记忆同步" },
					{ key: "searchDocsEnabled", label: "本地文件搜索" },
					{ key: "searchDocsMode", dep: "searchDocsEnabled", label: "本地文件搜索范围", type: "enum", nullable: true, options: [["", "默认（跟随开关）"], ["all", "文件名 + 内容"], ["filename", "仅文件名"], ["content", "仅内容"], ["off", "关闭"]] },
				]
			},
		];
		const MEM_KNOWN = new Set(MEM_GROUPS.flatMap((g) => g.fields.map((f) => f.key)).concat(["memoryTabEnabled"]));
		// 控件统一 26px 高；边框用 border-l3（border-l1 只有 4% 透明度，输入框几乎看不出能编辑）
		const MEM_INPUT = {
			height: 26, padding: "0 8px", borderRadius: 6, fontSize: 12, boxSizing: "border-box",
			border: "1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))",
			background: "var(--dsw-alias-bg-layer-2, transparent)",
			color: "var(--dsw-alias-label-primary, currentColor)",
		};
		const MEM_S = {
			head: { display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" },
			headText: { display: "flex", flexDirection: "column", gap: 2, flex: "1 1 200px", minWidth: 0 },
			headTools: { display: "flex", alignItems: "center", gap: 8, flex: "0 1 auto" },
			group: { borderTop: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2))", marginTop: 10, paddingTop: 6 },
			// display:flex 会去掉 Chromium 的原生三角，改用自绘箭头（能跟主题色走）
			summary: { display: "flex", alignItems: "center", gap: 6, cursor: "pointer", listStyle: "none", userSelect: "none", padding: "4px 0" },
			chevron: { display: "inline-block", width: 12, textAlign: "center", fontSize: 9, color: "var(--dsw-alias-label-tertiary, currentColor)", transition: "transform .12s" },
			groupTitle: { fontWeight: 600, fontSize: 12.5 },
			meta: { color: "var(--dsw-alias-label-tertiary, rgba(128,128,128,.8))", fontSize: 11 },
			groupHint: { color: "var(--dsw-alias-label-tertiary, rgba(128,128,128,.8))", fontSize: 11, lineHeight: "16px", padding: "0 0 4px 18px" },
			row: { display: "flex", alignItems: "center", gap: 12, padding: "7px 0 7px 18px", minHeight: 34, boxSizing: "border-box", borderTop: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.12))" },
			labelBox: { display: "flex", flexDirection: "column", gap: 2, flex: "1 1 auto", minWidth: 0 },
			label: { color: "var(--dsw-alias-label-primary, currentColor)", fontSize: 12, lineHeight: "18px" },
			hint: { color: "var(--dsw-alias-label-tertiary, rgba(128,128,128,.8))", fontSize: 11, lineHeight: "16px" },
			ctl: { display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto" },
			unit: { color: "var(--dsw-alias-label-tertiary, rgba(128,128,128,.8))", fontSize: 11 },
			saved: { color: "var(--dsw-alias-state-success-primary, #3fb950)", fontSize: 11 },
			lock: {
				display: "inline-flex", alignItems: "center", padding: "0 6px", borderRadius: 999, fontSize: 10.5, lineHeight: "16px", marginLeft: 6, verticalAlign: "1px",
				background: "var(--dsw-alias-state-warn-tertiary, rgba(255,170,0,.15))", color: "var(--dsw-alias-state-warn-label, #b8860b)",
			},
		};

		/** 作用域分区标题（「本会话」/「全局」），细线延伸到右侧。 */
		function SectionLabel(props) {
			return react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, marginTop: 4 } }, kids([
				react.createElement("span", { key: "t", style: { fontSize: 11, fontWeight: 600, color: "var(--dsw-alias-label-tertiary, rgba(128,128,128,.8))", whiteSpace: "nowrap" } }, props.text),
				react.createElement("span", { key: "l", style: { flex: "1 1 auto", height: 1, background: "var(--dsw-alias-border-l2, rgba(128,128,128,.2))" } }),
			]));
		}

		/**
		 * 开关：状态即控件（role=switch + aria-checked），旁边带「开 / 关」文字。
		 * 关态轨道用 label-caption（亮：中灰 / 暗：深灰），border-l 系列太淡、白色滑块看不清。
		 */
		function MemSwitch(props) {
			const on = props.checked === true;
			const disabled = !!props.disabled;
			return react.createElement("button", {
				type: "button", role: "switch", "aria-checked": on ? "true" : "false", "aria-label": props.label || "",
				disabled, title: props.title || "",
				onClick: () => { if (!disabled) { props.onChange(!on); } },
				style: {
					display: "inline-flex", alignItems: "center", gap: 6, padding: 0, margin: 0, border: "none", background: "transparent",
					cursor: disabled ? "not-allowed" : "pointer", color: "inherit", font: "inherit",
				},
			}, kids([
				react.createElement("span", {
					key: "tr", "aria-hidden": "true",
					style: {
						position: "relative", display: "inline-block", width: 30, height: 18, borderRadius: 9, flex: "0 0 auto", transition: "background .15s",
						background: on ? "var(--dsw-alias-brand-primary, #3794ff)" : "var(--dsw-alias-label-caption, rgba(128,128,128,.5))",
					},
				}, react.createElement("span", {
					style: {
						position: "absolute", top: 2, left: on ? 14 : 2, width: 14, height: 14, borderRadius: "50%", transition: "left .15s",
						boxShadow: "0 1px 2px rgba(0,0,0,.25)",
						// 关态滑块用卡片底色：switch-thumb 在暗色下是中灰，压在中灰轨道上几乎看不出位置
						background: on ? "var(--dsw-alias-label-primary-foreground, #fff)" : "var(--dsw-alias-bg-layer-1, #fff)",
					},
				})),
				react.createElement("span", {
					key: "tx",
					style: { fontSize: 11.5, minWidth: 14, color: on ? "var(--dsw-alias-label-primary, currentColor)" : "var(--dsw-alias-label-tertiary, rgba(128,128,128,.8))" },
				}, on ? "开" : "关"),
			]));
		}

		/** 推断「其它」组里未登记键的控件类型（只读展示数组/对象，避免误改）。 */
		function memFieldFor(key, value) {
			if (typeof value === "boolean") { return { key, label: key }; }
			if (typeof value === "number") { return { key, label: key, type: "int", min: 0 }; }
			if (typeof value === "string" || value === null) { return { key, label: key, type: "str", nullable: value === null }; }
			return { key, label: key, type: "readonly" };
		}

		/**
		 * 单个配置项：左侧标签 + 常驻说明（不再藏在 title 悬停里），右侧控件 + 单位 + 保存状态；
		 * 出错时错误写在这一行下面（页面很长，顶部横幅在底部改动时看不到）。
		 * 数字/文本先在本地编辑，失焦或回车才提交（避免每敲一个字就保存一次）。
		 */
		function MemField(props) {
			const f = props.field;
			const value = props.value;
			const locked = props.locked;
			const disabled = props.pending || locked;
			const type = f.type || "bool";
			const [draft, setDraft] = react.useState(value === null || value === undefined ? "" : String(value));
			react.useEffect(() => { setDraft(value === null || value === undefined ? "" : String(value)); }, [value]);
			// raw：失焦/回车时直接取输入框当前值。
			const commitText = (raw) => {
				const text = typeof raw === "string" ? raw : draft;
				const cur = value === null || value === undefined ? "" : String(value);
				if (text === cur) { return; }
				if (type === "int") {
					const n = Number(text);
					if (text.trim() === "" || !Number.isInteger(n) || n < (f.min ?? 0)) {
						props.onError(f.label + "：必须是 ≥ " + (f.min ?? 0) + " 的整数");
						setDraft(cur);
						return;
					}
					props.onSave(f.key, n);
					return;
				}
				props.onSave(f.key, f.nullable && text.trim() === "" ? null : text);
			};
			const labelBox = react.createElement("div", { key: "lb", style: MEM_S.labelBox }, kids([
				react.createElement("span", { key: "l", style: MEM_S.label, title: f.key }, kids([
					f.label,
					locked ? react.createElement("span", { key: "lk", style: MEM_S.lock }, "已锁定") : null,
				])),
				f.hint ? react.createElement("span", { key: "h", style: MEM_S.hint }, f.hint) : null,
				// 父开关关着时这项不起作用 —— 仍可预先调好，只是说清楚
				props.depOff ? react.createElement("span", { key: "dp", style: MEM_S.hint }, "需先开启「" + props.depOff + "」才生效") : null,
				props.error ? react.createElement("span", { key: "e", style: C.err, role: "alert" }, props.error) : null,
			]));
			const status = props.pending
				? react.createElement("span", { key: "st", style: MEM_S.unit }, "保存中…")
				: props.saved ? react.createElement("span", { key: "st", style: MEM_S.saved }, "已保存") : null;
			const rowStyle = Object.assign({}, MEM_S.row, props.first ? { borderTop: "none" } : {}, locked ? { opacity: 0.62 } : props.depOff ? { opacity: 0.72 } : {});

			if (type === "text") {
				return react.createElement("div", {
					style: Object.assign({}, rowStyle, { flexDirection: "column", alignItems: "stretch", gap: 6 }), "data-vssaros-memcfg": f.key,
				}, kids([
					labelBox,
					react.createElement("textarea", {
						key: "t", disabled, rows: 4, "aria-label": f.label,
						style: Object.assign({}, MEM_INPUT, { height: "auto", minHeight: 72, padding: "6px 8px", width: "100%", resize: "vertical", fontFamily: "inherit", lineHeight: "18px" }),
						value: draft, onChange: (e) => setDraft(e.target.value),
					}),
					react.createElement("div", { key: "b", style: Object.assign({}, MEM_S.ctl, { justifyContent: "flex-end" }) }, kids([
						status,
						react.createElement("button", { key: "s", type: "button", disabled: disabled || draft === (value || ""), style: C.btn, onClick: () => commitText() }, "保存"),
					])),
				]));
			}

			let control;
			if (type === "bool") {
				control = react.createElement(MemSwitch, {
					key: "c", checked: value === true, disabled, label: f.label,
					title: locked ? "已锁定：该功能未通过当前平台验证" : "",
					onChange: (next) => props.onSave(f.key, next),
				});
			} else if (type === "enum") {
				control = react.createElement("select", {
					key: "c", disabled, "aria-label": f.label, style: Object.assign({}, MEM_INPUT, { paddingRight: 4, maxWidth: 200 }),
					value: value === null || value === undefined ? "" : String(value),
					onChange: (e) => props.onSave(f.key, f.nullable && e.target.value === "" ? null : e.target.value),
				}, f.options.map(([v, l]) => react.createElement("option", { key: v, value: v }, l)));
			} else if (type === "multi") {
				const cur = Array.isArray(value) ? value : [];
				control = react.createElement("span", { key: "c", style: Object.assign({}, C.row, { gap: 10 }) }, f.options.map(([v, l]) => react.createElement("label", {
					key: v, style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, cursor: disabled ? "not-allowed" : "pointer" },
				}, kids([
					react.createElement("input", {
						key: "c", type: "checkbox", disabled, checked: cur.includes(v), style: { margin: 0, accentColor: "var(--dsw-alias-brand-primary, #3794ff)" },
						onChange: () => {
							const next = cur.includes(v) ? cur.filter((x) => x !== v) : cur.concat([v]);
							if (next.length === 0) { props.onError(f.label + "：至少保留一项"); return; }
							props.onSave(f.key, next);
						},
					}),
					l,
				]))));
			} else if (type === "readonly") {
				control = react.createElement("span", { key: "c", style: C.tiny }, JSON.stringify(value));
			} else {
				control = react.createElement("input", {
					key: "c", disabled, "aria-label": f.label, type: type === "int" ? "number" : "text", min: type === "int" ? (f.min ?? 0) : undefined,
					style: Object.assign({}, MEM_INPUT, { width: type === "int" ? 88 : 180, textAlign: type === "int" ? "right" : "left" }),
					value: draft, placeholder: f.placeholder || "",
					onChange: (e) => setDraft(e.target.value),
					onBlur: (e) => commitText(e.target.value),
					onKeyDown: (e) => { if (e.key === "Enter") { e.target.blur(); } },
				});
			}
			return react.createElement("div", { style: rowStyle, "data-vssaros-memcfg": f.key }, kids([
				labelBox,
				react.createElement("div", { key: "ct", style: MEM_S.ctl }, kids([
					status,
					control,
					f.unit ? react.createElement("span", { key: "u", style: MEM_S.unit }, f.unit) : null,
				])),
			]));
		}

		function MemoryModuleCard(props) {
			const say = props.say;
			const [state, reload] = useLoader(() => getJson(MEM_CONFIG_API), []);
			const [ver] = useLoader(() => getJson(MEM_UPDATE_API), []);
			const [saved, setSaved] = react.useState(null);
			// 只锁正在保存的那一项（以前一保存就把 43 项全部禁用，整卡闪一下）
			const [pendingKey, setPendingKey] = react.useState("");
			const [savedKey, setSavedKey] = react.useState("");
			const [fieldErr, setFieldErr] = react.useState({ key: "", msg: "" });
			const [query, setQuery] = react.useState("");
			const [openMap, setOpenMap] = react.useState(() => Object.fromEntries(MEM_GROUPS.map((g) => [g.id, g.open === true])));
			const timer = react.useRef(null);
			react.useEffect(() => () => { if (timer.current) { clearTimeout(timer.current); } }, []);
			const cfg = saved || (state.data && state.data.config ? state.data.config : null);
			const locked = new Set(state.data && Array.isArray(state.data.locked) ? state.data.locked : []);
			const save = (key, value) => {
				setPendingKey(key);
				setFieldErr({ key: "", msg: "" });
				postJson(MEM_CONFIG_API, { patch: { [key]: value } })
					.then((body) => {
						// POST 回的是**完整运行时配置**（含 memoryDir / toolName 等静态键）。只合并 GET 时就有的键，
						// 否则静态键会混进「其它」组，点它们必然 400（2026-11-04 真机发现）。
						const base = cfg || {};
						if (body && body.config) { setSaved(Object.fromEntries(Object.keys(base).map((k) => [k, k in body.config ? body.config[k] : base[k]]))); } else { reload(); }
						setSavedKey(key);
						if (timer.current) { clearTimeout(timer.current); }
						timer.current = setTimeout(() => setSavedKey(""), 1600);
						if (say) { say("记忆模块配置已更新：" + key); }
					})
					.catch((e) => setFieldErr({ key, msg: "保存失败：" + explainLoadError(String((e && e.message) || e)) }))
					.then(() => setPendingKey(""));
			};
			const status = ver.data && ver.data.status ? String(ver.data.status) : "";
			const q = query.trim().toLowerCase();
			const matches = (f) => !q || [f.label, f.key, f.hint || "", f.unit || ""].some((s) => String(s).toLowerCase().includes(q));
			const extra = cfg ? Object.keys(cfg).filter((k) => !MEM_KNOWN.has(k)).sort().map((k) => memFieldFor(k, cfg[k])) : [];
			const groups = extra.length > 0 ? MEM_GROUPS.concat([{ id: "other", title: "其它", fields: extra }]) : MEM_GROUPS;
			let shown = 0;
			const labelOf = (key) => { for (const g of MEM_GROUPS) { const hit = g.fields.find((x) => x.key === key); if (hit) { return hit.label; } } return key; };
			const groupEls = cfg ? groups.map((g) => {
				const all = g.fields.filter((f) => f.key in cfg);
				const fields = all.filter(matches);
				if (fields.length === 0) { return null; }
				shown += fields.length;
				const open = q ? true : openMap[g.id] === true;
				// 组标题右侧显示「已开 n / m」（以前的「(15)」只是项数，看不出开了几个）
				const bools = all.filter((f) => (f.type || "bool") === "bool");
				const lockedBools = bools.filter((f) => locked.has(f.key)).length;
				const meta = bools.length > 0 && lockedBools === bools.length
					? "已锁定"
					: bools.length > 0 ? "已开 " + bools.filter((f) => cfg[f.key] === true).length + " / " + bools.length : all.length + " 项";
				return react.createElement("details", {
					key: g.id, open, style: MEM_S.group, "data-vssaros-memcfg-group": g.id,
					onToggle: (e) => { if (!q) { const o = e.currentTarget.open; setOpenMap((m) => Object.assign({}, m, { [g.id]: o })); } },
				}, kids([
					react.createElement("summary", { key: "s", style: MEM_S.summary }, kids([
						react.createElement("span", { key: "c", "aria-hidden": "true", style: Object.assign({}, MEM_S.chevron, { transform: open ? "rotate(90deg)" : "none" }) }, "▶"),
						react.createElement("span", { key: "t", style: MEM_S.groupTitle }, g.title),
						react.createElement("span", { key: "sp", style: C.grow }),
						react.createElement("span", { key: "m", style: MEM_S.meta }, q ? "匹配 " + fields.length + " 项" : meta),
					])),
					g.hint ? react.createElement("div", { key: "h", style: MEM_S.groupHint }, g.hint) : null,
					react.createElement("div", { key: "f" }, fields.map((f, i) => react.createElement(MemField, {
						key: f.key, field: f, value: cfg[f.key], locked: locked.has(f.key), first: i === 0,
						depOff: f.dep && !locked.has(f.key) && cfg[f.dep] !== true ? labelOf(f.dep) : "",
						pending: pendingKey === f.key, saved: savedKey === f.key,
						error: fieldErr.key === f.key ? fieldErr.msg : "",
						onSave: save, onError: (m) => setFieldErr({ key: f.key, msg: m }),
					}))),
				]));
			}) : [];
			return react.createElement("div", { style: C.card, "data-vssaros-view": "memory-module-settings" }, kids([
				react.createElement("div", { key: "h", style: MEM_S.head }, kids([
					react.createElement("div", { key: "tx", style: MEM_S.headText }, kids([
						react.createElement("span", { key: "t", style: C.title }, "记忆模块"),
						react.createElement("span", { key: "s", style: MEM_S.hint }, "改动即时生效并持久化。指南与待确认的记忆建议在「记忆」页签。"),
					])),
					react.createElement("div", { key: "tools", style: MEM_S.headTools }, kids([
						react.createElement("input", {
							key: "q", type: "search", placeholder: "搜索设置", "aria-label": "搜索记忆模块设置", value: query,
							"data-vssaros-memcfg-search": "1",
							style: Object.assign({}, MEM_INPUT, { width: 160 }),
							onChange: (e) => setQuery(e.target.value),
						}),
						status ? react.createElement("span", { key: "v", style: C.badge, title: "内置插件随 VsSaros 一起更新" }, status === "unsupported" ? "随 VsSaros 更新" : "更新状态：" + status) : null,
					])),
				])),
				state.loading && !cfg ? react.createElement("div", { key: "ld", style: Object.assign({}, C.tiny, { marginTop: 8 }) }, "加载中…") : null,
				state.error ? react.createElement("div", { key: "e", style: Object.assign({}, C.err, { marginTop: 8 }) }, "读取失败：" + explainLoadError(state.error)) : null,
				...groupEls.filter(Boolean),
				cfg && q && shown === 0
					? react.createElement("div", { key: "nm", style: Object.assign({}, C.tiny, { marginTop: 10 }) }, "没有匹配「" + query.trim() + "」的设置项。")
					: null,
			]));
		}

		// ── 多 bot 群聊（★ 2026-11-05；运行时在 vssaros-agents lib/rooms.js）──────────────────────────
		//   · 「设置」页签：群会话显示**群设置卡**（群名 / 群公告 / 谁来回答 / 管理员 / 成员 / 侧栏 / 删除），
		//     不再出现 Bot 分段（群会话不是任何一个 bot 的会话）。
		//   · 群会话里的 `group_relay` 工具调用（群会话从不调模型，见 rooms.js）由 GroupRelayView 画成成员气泡：
		//     跑的过程中按 callId 轮询 `/x/agents/api/rooms?progress=`，结束后读工具结果 JSON。
		/* vssaros:room v1 —— 逐字副本，真源 vssaros-agents/lib/core/rooms.js 的 ROOM_PROJECTION_KEY / ROOM_RELAY_TOOL */
		const ROOM_PROJECTION_KEY = "vssaros-room";
		const ROOM_RELAY_TOOL = "group_relay";
		/* /vssaros:room */
		const ROOMS_API = "/x/agents/api/rooms";
		/** 全局浮层把 `?active=1` 的进度广播给 composer 上方的只读 MemberDock（不再开一条轮询）。 */
		const GROUP_PROGRESS_EVENT = "vssaros-group-progress";
		/** composer dock 可见/卸载时通知全局浮层：打开群/成员会话后右栏不再叠「已发到…」tip。 */
		const GROUP_DOCK_VISIBILITY_EVENT = "vssaros-group-composer-dock-visibility";
		/**
		 * ★ 2026-11-06 统一轮次状态（与 vssaros-agents core/rooms.js `roundStatusOf`、client.workspaces.js `groupRoundStatus` 逐字一致）。
		 * 服务端已给 `status` 就直接用；旧数据才按同一规则推断。check-bots-rooms.mjs 用同一张用例表钉三处一致。
		 */
		const GROUP_ROUND_LABELS = { sent: "已发到群", replying: "正在回答", done: "已完成", cut: "已中断", failed: "执行失败" };
		function groupRoundStatus(round) {
			const r = round && typeof round === "object" ? round : {};
			if (GROUP_ROUND_LABELS[r.status]) { return r.status; }
			const events = Array.isArray(r.events) ? r.events : [];
			if (r.interrupted || r.phase === "cut" || events.some((event) => event && event.kind === "cut")) { return "cut"; }
			if (!r.done) {
				const speaking = Array.isArray(r.speaking) ? r.speaking.length : 0;
				return speaking > 0 ? "replying" : "sent";
			}
			return r.error ? "failed" : "done";
		}
		const MEMBER_DOCK_SLOT = "conversation.input.dock";
		const MEMBER_DOCK_ID = "vssaros-group-members";
		/** 官方 todo=0 / goal=10 / queue=20；本项目 -5 / 5 / 15 / 25 ⇒ 30 不 tie。 */
		const MEMBER_DOCK_ORDER = 30;
		/**
		 * ★ 2026-11-05：composer 上方的 DS Bot 式活动行 / queue-steer 提示。
		 * 与 GroupMemberDock 同一个 dock 条目渲染，不另占 order，不改官方 composer。
		 */
		function ensureGroupFlowStyle() {
			try {
				if (typeof document === "undefined" || !document.head) { return; }
				if (document.head.querySelector("[data-vssaros-group-flow-style]")) { return; }
				const st = document.createElement("style");
				st.setAttribute("data-vssaros-group-flow-style", "1");
				st.textContent = [
					"@keyframes vssaros-group-flow-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}",
					"@keyframes vssaros-group-flow-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}",
					"[data-vssaros-group-composer-flow]{display:flex;flex-wrap:wrap;align-items:center;gap:6px;width:100%;margin-top:2px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l3, transparent);animation:vssaros-group-flow-in .18s ease-out both}",
					"[data-vssaros-group-composer-flow] [data-vssaros-group-composer-activity-text]{color:transparent;background:linear-gradient(90deg,var(--dsw-alias-label-tertiary) 0%,var(--dsw-alias-label-primary) 55%,var(--dsw-alias-label-tertiary) 100%);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;animation:vssaros-group-flow-shimmer 2.2s steps(60) infinite;font-weight:600}",
					"[data-vssaros-group-composer-flow] [data-vssaros-group-composer-queue-hint]{color:var(--dsw-alias-label-tertiary)}",
					"[data-vssaros-group-composer-flow] [data-vssaros-group-composer-event]{color:var(--dsw-alias-label-secondary)}",
					"@media (prefers-reduced-motion:reduce){[data-vssaros-group-composer-flow]{animation:none}[data-vssaros-group-composer-flow] [data-vssaros-group-composer-activity-text]{animation:none;background:none;color:var(--dsw-alias-label-primary)}}",
				].join("");
				document.head.appendChild(st);
			} catch { /* 没有 head ⇒ 文本仍可读 */ }
		}
		/** 维护「当前有哪些群/成员会话已显示 composer dock」，并广播给全局浮层让它让位。 */
		function setGroupComposerDockVisibility(roomId, role, visible) {
			try {
				const win = typeof window !== "undefined" ? window : null;
				if (!win) { return; }
				const key = String(roomId || "");
				if (!key) { return; }
				const docked = new Set(Array.isArray(win.__vssarosGroupComposerDocks) ? win.__vssarosGroupComposerDocks.map(String) : []);
				if (visible) { docked.add(key); } else { docked.delete(key); }
				win.__vssarosGroupComposerDocks = [...docked];
				const Ctor = win.CustomEvent || (typeof CustomEvent !== "undefined" ? CustomEvent : null);
				if (Ctor) { win.dispatchEvent(new Ctor(GROUP_DOCK_VISIBILITY_EVENT, { detail: { schema: 1, visible: !!visible && !!key, roomId: key, role: String(role || "") } })); }
			} catch { /* 无 window / CustomEvent ⇒ 浮层保持原行为 */ }
		}
		/**
		 * ★ 2026-11-06 composer 上方那行提示：只说**群语义**，按键交给官方。
		 *   官方输入框已经按用户设置给出正确按键（默认 Enter 排队；有排队时占位符是「Cmd/Ctrl+Enter 插话发送全部排队消息」，
		 *   排队 dock 每行有「插话发送」），之前这里写的「空输入 Enter 可插入当前回合」按键是错的（空草稿 Enter 官方什么都不做）。
		 *   群语义（rooms.js 核实）：
		 *   · 群会话：不论排队还是插话，新消息都要等本轮 group_relay 结束、下一次合成调用时才交给成员；
		 *   · 成员会话：插话进入它这一回合 ⇒ 它在群里的回复会带上；排队消息是之后的新回合，群里收不到；
		 *     人在成员会话里发的话不会转进群（只有群会话的消息进群收件箱）；
		 *   · 其它会话：这个输入框与群无关 ⇒ 不给提示。
		 */
		function groupComposerHintOf(role, running) {
			if (role === "room") { return running ? "新消息会在本轮结束后再交给群成员" : "可继续在这里给群聊发消息"; }
			if (role === "member") {
				return running ? "插话会进入这位成员本轮的工作，它在群里的回复会带上；排队的消息在本轮之后单独处理，不进群聊"
					: "在这里发的消息只给这位成员，不会转到群里";
			}
			return "";
		}
		/** 从 `?active=1` 轮次和当前会话投影推导 composer 活动行；纯函数，便于守卫断言。 */
		function groupComposerFlowOf(active, mark) {
			const rounds = Array.isArray(active) ? active : [];
			const roomId = String((mark && mark.roomId) || "");
			const run = (roomId && rounds.find((item) => item && item.roomId === roomId)) || rounds[0];
			if (!run) { return null; }
			const status = groupRoundStatus(run);
			const state = status === "failed" ? "error" : status === "cut" ? "cut" : status === "done" ? "done" : "running";
			const speaking = Array.isArray(run.speaking) ? run.speaking : [];
			const replies = (Array.isArray(run.replies) ? run.replies : []).filter((r) => !r || !r.kind);
			const events = Array.isArray(run.events) ? run.events : [];
			const lastEvent = events.length ? events[events.length - 1] : null;
			const seconds = run.startedAt ? Math.max(0, Math.round((((run.finishedAt || Date.now()) - run.startedAt) / 1000) || 0)) : 0;
			const activity = state === "error" ? "执行失败" : state === "cut" ? "本轮被中断 · " + replies.length + " 条回复已保留"
				: state === "done" ? "本轮完成 · " + replies.length + " 条回复 · 用时 " + seconds + "s"
					: speaking.length ? speaking.join("、") + " 正在输入…" : "群成员还在工作…";
			const queueHint = groupComposerHintOf(String((mark && mark.role) || "observer"), state === "running");
			return {
				state, status, statusLabel: run.statusLabel || GROUP_ROUND_LABELS[status],
				role: String((mark && mark.role) || "observer"), roomId: String(run.roomId || roomId || ""),
				roomName: String(run.roomName || ""), activity, queueHint,
				activityKind: state === "running" ? (speaking.length ? "typing" : "status") : state,
				eventKind: String((lastEvent && lastEvent.kind) || ""), eventText: lastEvent ? statusNodeText(lastEvent) : "",
			};
		}
		/** 会话 → 群标记（`{ roomId, role, botId? }`；不是群里的会话 ⇒ null）。 */
		function roomMarkOfSession(ctx, sessionId) {
			try {
				const list = ctx && ctx.sessions && ctx.sessions.list;
				const snap = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : null;
				const summary = sessionId && snap && snap.byId ? snap.byId[sessionId] : undefined;
				const mark = summary && summary.projectionValues ? summary.projectionValues[ROOM_PROJECTION_KEY] : null;
				return mark && typeof mark.roomId === "string" && mark.roomId ? mark : null;
			} catch { return null; }
		}
		/** 读 `group_relay` 工具结果（文本 JSON）⇒ 回复 / 状态节点 / 错误；读不出 ⇒ null。纯函数。 */
		function parseRelayResult(block) {
			try {
				const parts = block && Array.isArray(block.content) ? block.content : [];
				const text = parts.filter((p) => p && p.type === "text").map((p) => p.text).join("");
				if (!text) { return null; }
				const data = JSON.parse(text);
				if (!data || typeof data !== "object") { return null; }
				const base = {
					replies: Array.isArray(data.replies) ? data.replies : [],
					passed: Array.isArray(data.passed) ? data.passed : [],
					failed: Array.isArray(data.failed) ? data.failed : [],
					events: Array.isArray(data.events) ? data.events : [],
					room: data.room || null, callId: String(data.callId || ""), startedAt: data.startedAt || 0,
					finishedAt: data.finishedAt || 0, done: true,
					phase: String(data.phase || (data.interrupted ? "cut" : "done")), interrupted: !!data.interrupted,
				};
				return data.error ? { ...base, error: String(data.error) } : base;
			} catch { return null; }
		}
		/** 状态节点文案（DS Bot 同词表）；后端给了 text 就用后端口径。纯函数。 */
		function statusNodeText(event) {
			const kind = String((event && event.kind) || "failed");
			if (event && event.text) { return String(event.text); }
			const map = {
				working: "成员正在工作…", missed: "成员没能按时回答", failed: "成员执行失败", passed: "成员没有补充",
				paused: "群聊本轮暂停", resumed: "群聊本轮继续", cut: "群聊本轮被中断", done: "群聊本轮完成",
				approval: "成员在等你批准",
			};
			return map[kind] || kind;
		}
		/**
		 * ★ 2026-11-06（对齐 DS Bot「等你审批」）：群成员等人确认的工具调用，在群会话的工具卡与成员栏上直接批。
		 * 数据是轮次的 `approvals`（vssaros-agents rooms.js `decideApproval`）；回答 = POST { action:'approve', id, choice }。
		 * 回答后不本地删行：等下一次进度（轮询 / 广播）里它消失，避免「点了但其实没生效」。
		 */
		function GroupApprovals(props) {
			const list = Array.isArray(props && props.approvals) ? props.approvals.filter((a) => a && a.id) : [];
			const [busy, setBusy] = react.useState("");
			const [err, setErr] = react.useState("");
			if (!list.length) { return null; }
			const answer = (item, choice) => {
				setBusy(item.id + ":" + choice); setErr("");
				postJson(ROOMS_API, { action: "approve", id: item.id, choice }).then(
					() => setBusy(""),
					(e) => { setBusy(""); setErr(String((e && e.message) || e)); },
				);
			};
			return react.createElement("div", { style: Object.assign({}, C.col, { gap: 6 }), "data-vssaros-group-approvals": String(list.length) }, kids([
				...list.map((item) => react.createElement("div", {
					key: item.id, "data-vssaros-group-approval": item.id, "data-vssaros-group-approval-bot": String(item.botId || ""),
					style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 8,
						border: "1px solid var(--dsw-alias-state-warn-primary, #e2a03f)" },
				}, kids([
					react.createElement("span", { key: "t", style: { flex: "1 1 220px", minWidth: 0, wordBreak: "break-word" } },
						"【等你批准 #" + String(item.code || "") + "】" + String(item.name || "成员") + " 要运行：" + String(item.detail || item.tool || "")),
					react.createElement("button", { key: "a", type: "button", style: C.btnPrimary, disabled: !!busy, "data-act": "group-approval-allow",
						onClick: () => answer(item, "allow") }, busy === item.id + ":allow" ? "处理中…" : "允许"),
					react.createElement("button", { key: "r", type: "button", style: C.btn, disabled: !!busy, "data-act": "group-approval-reject",
						onClick: () => answer(item, "reject") }, busy === item.id + ":reject" ? "处理中…" : "拒绝"),
				]))),
				err ? react.createElement("div", { key: "e", style: C.err }, err) : null,
			]));
		}
		/** 群设置的改动（只带改了的字段）。纯函数。 */
		function roomPatch(room, draft) {
			const out = {};
			if (!room || !draft) { return out; }
			const curName = room.named === false ? "" : String(room.name || "");
			if (String(draft.name || "").trim() !== curName) { out.name = String(draft.name || "").trim(); }
			if (String(draft.notice || "") !== String(room.notice || "")) { out.notice = String(draft.notice || ""); }
			if (draft.mode !== room.mode) { out.mode = draft.mode; }
			if ((draft.admin || null) !== (room.admin || null)) { out.admin = draft.admin; }
			const ids = (room.members || []).map((m) => m.id);
			if (ids.join("\n") !== (draft.members || []).join("\n")) { out.members = draft.members.slice(); }
			return out;
		}
		const ROOM_MODE_LABELS = [
			{ id: "admin", label: "管理员主持", hint: "普通消息先给管理员，由管理员用 @名字 点名其他成员。" },
			{ id: "everyone", label: "所有人", hint: "每位成员轮流回答，管理员先说。" },
		];

		/** 「设置」页签里的群设置卡。 */
		function RoomSettingsCard(props) {
			const roomId = props.roomId || "";
			const say = props.say;
			const [state, reload] = useLoader(() => getJson(ROOMS_API + "?id=" + encodeURIComponent(roomId)), [roomId]);
			const [roster] = useLoader(() => getJson("/x/agents/api/home").then((j) => (Array.isArray(j && j.agents) ? j.agents : [])), []);
			const room = state.data && state.data.room ? state.data.room : null;
			const [draft, setDraft] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [err, setErr] = react.useState("");
			const [confirmDel, setConfirmDel] = react.useState(false);
			const [adding, setAdding] = react.useState("");
			react.useEffect(() => {
				if (!room) { return; }
				setDraft({ name: room.named === false ? "" : room.name, notice: room.notice || "", mode: room.mode, admin: room.admin,
					members: (room.members || []).map((m) => m.id) });
			}, [room && JSON.stringify(room)]);
			if (!room || !draft) {
				return react.createElement("div", { style: C.card, "data-vssaros-room-settings": "loading" }, kids([
					react.createElement("div", { key: "t", style: C.title }, "群设置"),
					react.createElement("div", { key: "s", style: Object.assign({}, C.sub, { marginTop: 6 }) }, state.error ? "读取失败：" + state.error : "读取中…"),
				]));
			}
			const nameOf = (id) => {
				const hit = (room.members || []).filter((m) => m.id === id)[0] || ((roster.data || []).filter((a) => a && a.id === id)[0]);
				return String((hit && hit.name) || id);
			};
			const patch = roomPatch(room, draft);
			const dirty = Object.keys(patch).length > 0;
			const post = (body, done) => {
				setBusy(true); setErr("");
				return postJson(ROOMS_API, Object.assign({ id: roomId }, body)).then(
					(j) => { setBusy(false); reload(); if (done) { done(j); } },
					(e) => { setBusy(false); setErr(String((e && e.message) || e)); },
				);
			};
			const save = () => post(Object.assign({ action: "update" }, patch), () => { if (say) { say("群设置已保存"); } });
			const candidates = (roster.data || []).filter((a) => a && a.registered !== false && !a.external && draft.members.indexOf(a.id) < 0);
			const field = (label, el) => react.createElement("div", { key: "f:" + label, style: { marginTop: 8 } }, kids([
				react.createElement("div", { key: "l", style: Object.assign({}, C.tiny, { marginBottom: 3 }) }, label), el]));
			return react.createElement("div", { style: C.card, "data-vssaros-room-settings": roomId }, kids([
				react.createElement("div", { key: "t", style: C.row }, kids([
					react.createElement("span", { key: "a", style: C.title }, "群设置"),
					react.createElement("span", { key: "b", style: C.badge }, draft.members.length + " 位成员"),
					room.admin ? react.createElement("span", { key: "c", style: C.badge }, "管理员 " + nameOf(room.admin)) : null,
				])),
				field("群名", react.createElement("input", {
					key: "n", style: Object.assign({}, C.input, { width: "100%", boxSizing: "border-box" }), value: draft.name, maxLength: 60,
					placeholder: "留空 = 按成员命名", "data-vssaros-room-name": "1", disabled: busy,
					onChange: (e) => setDraft(Object.assign({}, draft, { name: e.target.value })),
				})),
				field("群公告（每位成员发言前都会读到的共同说明）", react.createElement("textarea", {
					key: "o", style: Object.assign({}, C.input, { width: "100%", boxSizing: "border-box", minHeight: 64, resize: "vertical" }), value: draft.notice,
					maxLength: 2000, "data-vssaros-room-notice": "1", disabled: busy,
					onChange: (e) => setDraft(Object.assign({}, draft, { notice: e.target.value })),
				})),
				field("谁来回答", react.createElement("div", { key: "m", style: C.col }, ROOM_MODE_LABELS.map((m) => react.createElement("label", {
					key: m.id, style: Object.assign({}, C.row, { cursor: "pointer" }), "data-vssaros-room-mode": m.id,
				}, kids([
					react.createElement("input", { key: "r", type: "radio", name: "room-mode-" + roomId, checked: draft.mode === m.id, disabled: busy,
						onChange: () => setDraft(Object.assign({}, draft, { mode: m.id })) }),
					react.createElement("span", { key: "l" }, m.label),
					react.createElement("span", { key: "h", style: C.tiny }, m.hint),
				]))))),
				field("成员", react.createElement("ul", { key: "ms", style: C.list }, draft.members.map((id) => react.createElement("li", {
					key: id, style: Object.assign({}, C.item, C.row), "data-vssaros-room-member": id,
				}, kids([
					react.createElement("span", { key: "n", style: C.grow }, nameOf(id)),
					draft.admin === id ? react.createElement("span", { key: "a", style: C.badgeOn }, "管理员")
						: react.createElement("button", { key: "s", type: "button", style: C.btn, disabled: busy,
							onClick: () => setDraft(Object.assign({}, draft, { admin: id })) }, "设为管理员"),
					draft.members.length > 2 ? react.createElement("button", { key: "x", type: "button", style: C.btn, disabled: busy, "data-act": "room-member-remove",
						onClick: () => {
							const members = draft.members.filter((m) => m !== id);
							setDraft(Object.assign({}, draft, { members, admin: draft.admin === id ? members[0] : draft.admin }));
						} }, "移出") : null,
				]))))),
				candidates.length ? react.createElement("div", { key: "add", style: Object.assign({}, C.row, { marginTop: 6 }) }, kids([
					react.createElement("select", { key: "s", style: C.input, value: adding, "data-vssaros-room-add": "1", disabled: busy,
						onChange: (e) => setAdding(e.target.value) }, [react.createElement("option", { key: "", value: "" }, "添加成员…")]
						.concat(candidates.map((a) => react.createElement("option", { key: a.id, value: a.id }, String(a.name || a.id))))),
					react.createElement("button", { key: "b", type: "button", style: C.btn, disabled: busy || !adding,
						onClick: () => { setDraft(Object.assign({}, draft, { members: draft.members.concat([adding]) })); setAdding(""); } }, "添加"),
				])) : null,
				react.createElement("div", { key: "save", style: Object.assign({}, C.row, { marginTop: 10 }) }, kids([
					react.createElement("button", { key: "s", type: "button", style: C.btnPrimary, disabled: busy || !dirty, "data-act": "room-save", onClick: save }, busy ? "保存中…" : "保存"),
					dirty ? react.createElement("button", { key: "r", type: "button", style: C.btn, disabled: busy,
						onClick: () => setDraft({ name: room.named === false ? "" : room.name, notice: room.notice || "", mode: room.mode, admin: room.admin,
							members: (room.members || []).map((m) => m.id) }) }, "撤销改动") : null,
					err ? react.createElement("span", { key: "e", style: C.err }, err) : null,
				])),
				field("侧栏", react.createElement("div", { key: "f", style: C.row }, kids([
					react.createElement("label", { key: "p", style: C.row }, kids([
						react.createElement("input", { key: "c", type: "checkbox", checked: room.pinned === true, disabled: busy, "data-vssaros-room-pin": "1",
							onChange: (e) => post({ action: "flags", pinned: e.target.checked }) }),
						react.createElement("span", { key: "l" }, "置顶"),
					])),
					react.createElement("label", { key: "h", style: C.row }, kids([
						react.createElement("input", { key: "c", type: "checkbox", checked: room.hidden === true, disabled: busy, "data-vssaros-room-hide": "1",
							onChange: (e) => post({ action: "flags", hidden: e.target.checked }) }),
						react.createElement("span", { key: "l" }, "从侧栏隐藏"),
					])),
				]))),
				field("管理", confirmDel
					? react.createElement("div", { key: "d", style: C.row }, kids([
						react.createElement("span", { key: "q", style: C.sub }, "删除后群会话与成员的群内会话会被归档，确定？"),
						react.createElement("button", { key: "y", type: "button", style: Object.assign({}, C.btn, { color: "var(--dsw-alias-state-error-primary, #e5534b)" }), disabled: busy,
							"data-act": "room-delete-confirm", onClick: () => post({ action: "delete" }, () => { if (say) { say("群聊已删除"); } }) }, "删除"),
						react.createElement("button", { key: "n", type: "button", style: C.btn, onClick: () => setConfirmDel(false) }, "取消"),
					]))
					: react.createElement("button", { key: "d", type: "button", style: Object.assign({}, C.btn, { color: "var(--dsw-alias-state-error-primary, #e5534b)" }),
						"data-act": "room-delete", onClick: () => setConfirmDel(true) }, "删除群聊…")),
			]));
		}

		/** 连续多少次拿不到进度（`progress:null`）就判定状态已丢失并停止轮询（重启前的旧调用 / 超过保留期）。 */
		const RELAY_LOST_AFTER = 5;
		/**
		 * ★ 2026-11-06 DSH 重启时给悬空 tool-call 补的收尾结果（`dsh-session` repair：`isError` + 英文说明，
		 * 「The tool call was interrupted …」）。它不是我们的 JSON ⇒ 群聊这一轮的真实回复要从
		 * `?progress=`（agents 侧对被中断轮次做了按群归档）补全。纯函数。
		 */
		function isHostInterruptedResult(block) {
			try {
				if (!block || typeof block !== "object") { return false; }
				const parts = Array.isArray(block.content) ? block.content : [];
				const text = parts.filter((p) => p && p.type === "text").map((p) => p.text).join("").trim();
				if (!text || text.startsWith("{")) { return false; }
				return !!block.isError || /tool call was interrupted|outcome is unknown|no result was durably recorded/i.test(text);
			} catch { return false; }
		}
		/** 群会话里 `group_relay` 工具调用的卡：成员气泡（运行中轮询进度，结束读结果）。 */
		function GroupRelayView(props) {
			const settled = props.phase === "result" ? parseRelayResult(props.block) : null;
			const hostCut = props.phase === "result" && !settled && isHostInterruptedResult(props.block);
			const callId = props.callId || "";
			const lostAfter = Number(props.lostAfterPolls) > 0 ? Number(props.lostAfterPolls) : RELAY_LOST_AFTER;
			const pollMs = Number(props.pollMs) > 0 ? Number(props.pollMs) : 1000;
			const [live, setLive] = react.useState(null);
			const [lost, setLost] = react.useState(false);
			const liveDone = !!(live && live.done);
			react.useEffect(() => {
				if (settled || liveDone || lost || !callId) { return undefined; }
				let alive = true;
				let timer = null;
				let finished = false;
				let misses = 0;
				const poll = () => {
					getJson(ROOMS_API + "?progress=" + encodeURIComponent(callId)).then(
						(j) => {
							if (!alive) { return; }
							const next = j && j.progress ? j.progress : null;
							if (next) { misses = 0; } else if (j && j.ok) { misses += 1; }
							if (!next && misses >= lostAfter) { finished = true; setLost(true); return; }
							finished = !!(next && next.done);
							if (next) { setLive(next); }
						},
						() => undefined, // 网络错误不算「丢失」，继续重试
					).finally(() => {
						if (!alive || finished) { return; }
						timer = setTimeout(poll, typeof document !== "undefined" && document.hidden ? Math.max(5000, pollMs) : pollMs);
					});
				};
				poll();
				return () => { alive = false; if (timer) { clearTimeout(timer); } };
			}, [callId, !!settled, liveDone, lost]);
			const done = !!settled || liveDone || lost;
			const data = settled || live || { replies: [], passed: [], failed: [], speaking: [] };
			const bubble = (r, i) => react.createElement("div", { key: "r" + i, style: { display: "flex", gap: 8, alignItems: "flex-start" }, "data-vssaros-group-reply": String(r.botId || r.name || i) }, kids([
				react.createElement("span", { key: "a", style: { width: 24, height: 24, flex: "0 0 24px", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center",
					fontSize: 11, fontWeight: 700, color: "var(--dsw-alias-label-primary-foreground, #fff)", background: "var(--dsw-alias-brand-primary, #4d7cfe)" } },
				String(r.name || "?").slice(0, 1)),
				react.createElement("div", { key: "b", style: { minWidth: 0, flex: "1 1 auto" } }, kids([
					react.createElement("div", { key: "n", style: C.tiny }, String(r.name || "") + (typeof r.ms === "number" ? " · " + Math.max(1, Math.round(r.ms / 1000)) + "s" : "")),
					// ★ 2026-11-06：成员回复按 Markdown 渲染（原来 pre-wrap 纯文本 ⇒ `**` / 反引号 / 列表符原样露出来）
					react.createElement("div", { key: "t", "data-vssaros-md": "1", style: Object.assign({}, C.item, { wordBreak: "break-word", lineHeight: "20px" }) }, markdownNodes(String(r.text || ""))),
				])),
			]));
			const replies = (data.replies || []).filter((r) => !r || !r.kind);
			const speaking = data.speaking || [], passed = data.passed || [], failed = data.failed || [];
			const events = data.events || [], error = String(data.error || "");
			const roundStatus = lost && !settled && !live ? (hostCut ? "cut" : "lost")
				: groupRoundStatus(Object.assign({}, data, { done: done || !!data.done }, hostCut && !live ? { interrupted: true } : {}));
			const interrupted = roundStatus === "cut";
			const seconds = data.startedAt ? Math.max(0, Math.round((((data.finishedAt || Date.now()) - data.startedAt) / 1000) || 0)) : null;
			const doneText = roundStatus === "lost" ? "执行状态已丢失（可能因重启或超过保留时间），本轮结果无法再读取"
				: hostCut && !live ? "群聊本轮被重启打断，这一轮的成员回复已无法读取"
				: (interrupted ? "群聊本轮被中断" : "群聊本轮已完成") + " · " + replies.length + " 条回复"
					+ (seconds !== null ? " · 用时 " + seconds + "s" : "") + (failed.length ? " · " + failed.length + " 位成员没能回答" : "");
			return react.createElement("div", {
				style: Object.assign({}, C.col, { gap: 8, margin: "4px 0" }),
				"data-vssaros-group-relay": roundStatus === "lost" ? "lost" : done ? "done" : "running", "data-vssaros-group-relay-done": done ? "1" : "0",
				"data-vssaros-group-relay-interrupted": interrupted ? "1" : "0",
				"data-vssaros-group-relay-round-status": roundStatus,
			}, kids([
				...replies.map(bubble),
				...events.map((event, i) => react.createElement("div", {
					key: "ev" + i, style: /^(failed|missed|cut)$/.test(String(event && event.kind)) ? C.err : C.tiny,
					"data-vssaros-group-relay-status-node": String((event && event.kind) || "failed"),
				}, statusNodeText(event))),
				!done ? react.createElement(GroupApprovals, { key: "ap", approvals: data.approvals }) : null,
				speaking.length ? react.createElement("div", { key: "s", style: C.tiny }, speaking.join("、") + " 正在输入…") : null,
				!done ? react.createElement("div", { key: "run", style: C.tiny, "data-vssaros-group-relay-status": "running" },
					replies.length || speaking.length ? "群成员还在工作…" : "正在把消息交给群成员…") : null,
				done ? react.createElement("div", { key: "done", style: roundStatus === "lost" ? C.err : C.tiny, "data-vssaros-group-relay-status": roundStatus === "lost" ? "lost" : "done" }, doneText) : null,
				passed.length ? react.createElement("div", { key: "p", style: C.tiny }, "没有补充：" + passed.join("、")) : null,
				...failed.map((f, i) => react.createElement("div", { key: "f" + i, style: C.err }, String(f.name || "") + " 没能回答：" + String(f.reason || ""))),
				error ? react.createElement("div", { key: "e", style: C.err }, error) : null,
				done && roundStatus !== "lost" && !error && !replies.length && !failed.length && !passed.length && !events.length
					? react.createElement("div", { key: "z", style: C.tiny }, "这条消息没有叫到任何成员。") : null,
			]));
		}

		/**
		 * 只读 MemberDock：composer 上方显示当前群谁在说 / 谁已回 / 谁失败 / 最新状态节点。
		 * 数据来自全局浮层广播的 `vssaros-group-progress`，不再开一条轮询；本批不含审批/停止按钮。
		 */
		function GroupMemberDock(props) {
			const initial = () => {
				try {
					return typeof window !== "undefined" && Array.isArray(window.__vssarosGroupProgress) ? window.__vssarosGroupProgress : [];
				} catch { return []; }
			};
			const [active, setActive] = react.useState(initial);
			react.useEffect(() => {
				const win = typeof window !== "undefined" ? window : null;
				if (!win || typeof win.addEventListener !== "function") { return undefined; }
				const onProgress = (ev) => setActive(Array.isArray(ev && ev.detail && ev.detail.active) ? ev.detail.active : []);
				win.addEventListener(GROUP_PROGRESS_EVENT, onProgress);
				return () => { try { win.removeEventListener(GROUP_PROGRESS_EVENT, onProgress); } catch { /* 已释放 */ } };
			}, []);
			const ctx = props && props.__vssarosCtx;
			const sessionId = String((props && props.sessionId) || "");
			const mark = roomMarkOfSession(ctx, sessionId);
			const roomId = String((mark && mark.roomId) || sessionId || "");
			const current = active.find((item) => roomId && item && item.roomId === roomId) || active[0];
			const flow = groupComposerFlowOf(active, mark);
			const dockVisible = !!current && !!flow;
			const dockRole = String((mark && mark.role) || (flow && flow.role) || "");
			react.useEffect(() => {
				setGroupComposerDockVisibility(roomId, dockRole, dockVisible);
				return () => setGroupComposerDockVisibility(roomId, dockRole, false);
			}, [roomId, dockRole, dockVisible]);
			if (!current || !flow) { return null; }
			const speaking = Array.isArray(current.speaking) ? current.speaking : [];
			const replies = (Array.isArray(current.replies) ? current.replies : []).filter((r) => !r || !r.kind);
			const events = Array.isArray(current.events) ? current.events : [];
			const failed = Array.isArray(current.failed) ? current.failed : [];
			const passed = Array.isArray(current.passed) ? current.passed : [];
			const pills = [];
			const add = (name, state, label) => {
				const key = String(name || "").trim();
				if (!key || pills.some((p) => p.name === key)) { return; }
				pills.push({ name: key, state, label });
			};
			const waiting = Array.isArray(current.approvals) ? current.approvals : [];
			for (const item of waiting) { add(item && item.name, "approval", "等你审批"); }
			for (const name of speaking) { add(name, "speaking", "正在输入"); }
			for (const event of events) {
				if (!event || !event.name) { continue; }
				const kind = String(event.kind || "");
				const state = /^(failed|missed|cut)$/.test(kind) ? "failed" : kind === "working" ? "speaking"
					: kind === "passed" ? "passed" : "waiting";
				add(event.name, state, statusNodeText(event).slice(0, 18));
			}
			for (const reply of replies) { add(reply && reply.name, "replied", "已回复"); }
			for (const item of failed) { add(item && item.name, "failed", "未回答"); }
			for (const name of passed) { add(name, "passed", "无补充"); }
			const lastEvent = events.length ? events[events.length - 1] : null;
			const roundStatus = groupRoundStatus(current);
			const status = current.statusLabel || GROUP_ROUND_LABELS[roundStatus];
			return react.createElement("section", {
				"data-vssaros-group-member-dock": "1", "data-vssaros-group-member-room": String(current.roomId || ""),
				"data-vssaros-group-member-status": roundStatus === "failed" ? "error" : roundStatus === "cut" ? "cut" : current.done ? "done" : "running",
				"data-vssaros-group-member-round-status": roundStatus,
				"aria-label": "群成员执行状态", role: "status",
				style: {
					display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, margin: "2px 10px 8px",
					padding: "6px 8px", borderRadius: 9, border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))",
					background: "var(--dsw-alias-bg-layer-2, rgba(32,32,32,.92))", color: "var(--dsw-alias-label-primary, inherit)",
					fontSize: 11,
				},
			}, kids([
				react.createElement("span", { key: "g", style: { fontWeight: 600, maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
					"群聊 · " + String(current.roomName || current.roomId || "")),
				react.createElement("span", { key: "s", style: { color: roundStatus === "failed" || roundStatus === "cut" ? "var(--dsw-alias-state-error-primary, #f14c4c)" : roundStatus === "done" ? "var(--dsw-alias-state-success-primary, #4ac26b)" : "var(--dsw-alias-state-warn-primary, #e2a03f)" } }, status),
				...pills.slice(0, 8).map((pill, i) => react.createElement("span", {
					key: "m" + i, "data-vssaros-group-member": pill.name, "data-vssaros-group-member-state": pill.state,
					title: pill.name + " · " + pill.label,
					style: {
						borderRadius: 999, padding: "2px 7px", border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))",
						color: pill.state === "failed" ? "var(--dsw-alias-state-error-primary, #f14c4c)" : "inherit",
						whiteSpace: "nowrap", maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis",
					},
				}, pill.name + " · " + pill.label)),
				lastEvent && lastEvent.text ? react.createElement("span", {
					key: "e", style: { color: "var(--dsw-alias-label-tertiary, #999)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 240 },
					"data-vssaros-group-member-event": String(lastEvent.kind || ""),
				}, String(lastEvent.text).slice(0, 60)) : null,
				react.createElement("div", {
					key: "flow", "data-vssaros-group-composer-flow": "1", "data-vssaros-group-composer-role": flow.role,
					"data-vssaros-group-composer-state": flow.state, "data-vssaros-group-composer-activity": flow.activityKind,
					"data-vssaros-group-composer-event": flow.eventKind, "data-vssaros-group-composer-queue-hint": "1",
				}, kids([
					react.createElement("span", { key: "a", "data-vssaros-group-composer-activity-text": "1" }, flow.activity),
					flow.queueHint ? react.createElement("span", { key: "q", "data-vssaros-group-composer-queue-hint-text": "1" }, flow.queueHint) : null,
					flow.eventText ? react.createElement("span", { key: "ev", "data-vssaros-group-composer-event-text": "1" }, String(flow.eventText).slice(0, 80)) : null,
				])),
				current.error ? react.createElement("span", { key: "err", style: C.err }, String(current.error).slice(0, 120)) : null,
				// 不看本轮是否结束：群不再等的成员（迟到）也可能在干活中途请求审批
				waiting.length ? react.createElement("div", { key: "ap", style: { flex: "1 1 100%" } },
					react.createElement(GroupApprovals, { approvals: waiting })) : null,
			]));
		}

		/** 设置页签：同样按「工作区 | Bot」分段；AgentMemory 卡两段都显示。 */
		function SettingsView(props) {
			const ctx = props.__vssarosCtx;
			const sessionId = props.sessionId || "";
			const pick = useScopePicker(ctx, sessionId);
			// ★ 2026-11-05 群会话：顶部是群设置卡，没有 Bot 分段（群会话不属于任何一个 bot）
			const room = roomMarkOfSession(ctx, sessionId);
			if (room && room.role === "room") {
				return react.createElement("div", { style: C.root, "data-vssaros-view": "bot-settings", "data-vssaros-memory-scope": "room" },
					kids([
						react.createElement(SectionLabel, { key: "sec-room", text: "本群" }),
						react.createElement(RoomSettingsCard, { key: "room", roomId: room.roomId, say: props.__vssarosSay }),
						react.createElement(SectionLabel, { key: "sec-global", text: "全局（所有会话与工作区共用）" }),
						react.createElement(MemoryModuleCard, { key: "mem-module", say: props.__vssarosSay }),
					]));
			}
			// 记忆条目在「记忆」页签（@vssaros/dsh-memory）；Bot 记忆注入上限在全局「记忆注入」组。
			return react.createElement("div", { style: C.root, "data-vssaros-view": "bot-settings", "data-vssaros-memory-scope": pick.scope },
				kids([
					// 作用域分区：上半部分随「工作区 | Bot」切换，下半部分是全局设置 —— 不标出来就像分段在管整页
					react.createElement(SectionLabel, { key: "sec-scope", text: "本会话" }),
					pick.bar,
					// ★ 2026-11-03：Bot 配置（名称/描述/角色/模型/人设/技能）→ 只有 Bot 段才有
					pick.scope === "bot" && pick.agentId
						? react.createElement(BotConfigCard, { key: "cfg", agentId: pick.agentId, say: props.__vssarosSay })
						: null,
					// ★ 2026-11-05「记忆收敛」S2：Bot 记忆的版本历史（数据在 @vssaros/dsh-memory 的 bot 轨）
					pick.scope === "bot" && pick.agentId
						? react.createElement(BotMemoryHistoryCard, { key: "bot-hist", sessionId: sessionId, say: props.__vssarosSay })
						: null,
					react.createElement(SectionLabel, { key: "sec-global", text: "全局（所有会话与工作区共用）" }),
					// ★ 2026-11-03：evolve 的「Vssaros Memory 设置」页签并入本页（全局卡，两段都显示）
					react.createElement(MemoryModuleCard, { key: "mem-module", say: props.__vssarosSay }),
				]));
		}

		/**
		 * Bot 配置卡（★ 2026-11-03，替代已下线的「Bot 设置」右侧栏面板与完整页设置）：
		 * 读 `GET /x/agents/api/agents?id=` 拿 `.agent.md` 的完整草稿，写 `POST /x/agents/api/agents {action:'update', id, draft}`。
		 * ⚠ 只提交用户改过的**文本字段**；`id` 不可改（文件名即身份）。
		 */
		function BotConfigCard(props) {
			const agentId = props.agentId || "";
			const say = props.say;
			const url = agentId ? "/x/agents/api/agents?id=" + encodeURIComponent(agentId) : "";
			const [state, reload] = useLoader(() => (url ? getJson(url) : Promise.resolve(null)), [url]);
			const [draft, setDraft] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [note, setNote] = react.useState("");
			const [err, setErr] = react.useState("");
			const initializedFor = react.useRef("");
			const data = state.data;
			const loaded = data && data.draft ? data.draft : null;
			react.useEffect(() => {
				if (!loaded || initializedFor.current === url) { return; }
				initializedFor.current = url;
				setDraft({
					name: String(loaded.name || ""),
					description: String(loaded.description || ""),
					role: String(loaded.role || ""),
					model: String(loaded.model || ""),
					skills: String(loaded.skills || ""),
					persona: String(loaded.persona || ""),
				});
				setErr("");
				setNote("");
			}, [loaded, url]);

			if (!agentId) {
				return null;
			}
			if (!draft) {
				return react.createElement("div", { style: C.card }, kids([
					react.createElement("div", { key: "t", style: C.title }, "Bot 配置"),
					react.createElement("div", { key: "s", style: Object.assign({}, C.sub, { marginTop: 6 }) },
						state.error ? ("读取失败：" + state.error) : "读取中…"),
				]));
			}
			const field = (key, label, placeholder, multiline, rows) => react.createElement("div", { key, style: { marginTop: 8 } },
				react.createElement("div", { style: Object.assign({}, C.tiny, { marginBottom: 3 }) }, label),
				react.createElement(multiline ? "textarea" : "input", {
					style: Object.assign({}, C.input, { width: "100%", boxSizing: "border-box" }, multiline ? { minHeight: rows || 72, resize: "vertical" } : {}),
					value: draft[key],
					placeholder: placeholder || "",
					["data-vssaros-botcfg-" + key]: "1",
					disabled: saving,
					onChange: (e) => {
						const v = e && e.target ? e.target.value : "";
						setDraft((d) => Object.assign({}, d || {}, { [key]: v }));
						setNote("");
						setErr("");
					},
				}));

			const save = () => {
				setSaving(true);
				setErr("");
				setNote("");
				// 只发这些字段（draft 的其余字段由 host 保留）
				const body = {
					action: "update",
					id: agentId,
					draft: {
						name: String(draft.name || "").trim(),
						description: String(draft.description || "").trim(),
						role: String(draft.role || "").trim(),
						model: String(draft.model || "").trim(),
						skills: String(draft.skills || "").trim(),
						persona: String(draft.persona || ""),
					},
				};
				postJson("/x/agents/api/agents", body).then(
					() => {
						setNote("已保存到 .agent.md。人设改动对**新会话**生效（已有会话的工具与模型已锁定）。");
						reload();
					},
					(e) => setErr("保存失败：" + String((e && e.message) || e)),
				).then(() => setSaving(false));
			};

			return react.createElement("div", { style: C.card, "data-vssaros-botcfg": agentId }, kids([
				react.createElement("div", { key: "r", style: C.row }, kids([
					react.createElement("span", { key: "t", style: C.title }, "Bot 配置"),
					react.createElement("span", { key: "b", style: C.badge }, agentId),
					react.createElement("span", { key: "sp", style: C.grow }),
					react.createElement("button", { key: "r2", type: "button", style: C.btn, disabled: saving, onClick: () => { reload(); } }, "刷新"),
					react.createElement("button", { key: "s", type: "button", style: C.btnPrimary, disabled: saving, onClick: save }, saving ? "保存中…" : "保存"),
				])),
				react.createElement("div", { key: "d", style: Object.assign({}, C.sub, { marginTop: 4 }) },
					"写回该 Bot 的 .agent.md（名称 / 描述 / 角色 / 模型 / 技能 / 人设）。id 不可改，它就是目录名。"),
				field("name", "名称", "例如 代码审阅员"),
				field("description", "描述（一行）", "在名册 / 欢迎卡里显示"),
				field("role", "角色标签", "例如 检索 / 审阅"),
				field("model", "模型", "provider/model（如 vssaros-codebuddy/hy4）；留空 = 跟随默认"),
				field("skills", "技能（逗号分隔）", "anysearch, analysis"),
				field("persona", "人设正文（Markdown）", "你就是……", true, 160),
				err ? react.createElement("div", { key: "e", style: Object.assign({}, C.err, { marginTop: 6 }) }, err) : null,
				note ? react.createElement("div", { key: "n", style: Object.assign({}, C.tiny, { marginTop: 6 }) }, note) : null,
			]));
		}

		// ══════════════════════════════════════════════════════════════════════
		// 2. 技能
		// ══════════════════════════════════════════════════════════════════════
		function SkillsView(props) {
			const bridge = props.__vssarosBridge;
			const say = props.__vssarosSay;
			const [query, setQuery] = react.useState("");
			const [state, reload] = useLoader(() => getJson("/x/skills/api/skills"), []);
			const data = state.data;
			const all = (data && Array.isArray(data.skills)) ? data.skills : [];
			const q = query.trim().toLowerCase();
			const hit = q
				? all.filter((s) => (String(s.name || "") + " " + String(s.description || "")).toLowerCase().indexOf(q) >= 0)
				: all;
			const shown = hit.slice(0, SKILL_RENDER_LIMIT);

			const head = react.createElement("div", { key: "head", style: C.row }, kids([
				react.createElement("span", { key: "t", style: C.title }, "技能"),
				data ? react.createElement("span", { key: "c", style: C.badge }, "共 " + all.length) : null,
				q ? react.createElement("span", { key: "q", style: C.badgeOn }, "匹配 " + hit.length) : null,
				react.createElement("span", { key: "sp", style: C.grow }),
				react.createElement("button", { key: "r", type: "button", style: C.btn, onClick: reload }, "刷新"),
				react.createElement("button", {
					key: "open", type: "button", style: C.btn,
					onClick: () => openPage(bridge, "/x/skills/", say),
				}, "打开技能库"),
			]));

			const search = react.createElement("input", {
				key: "search",
				style: Object.assign({}, C.input, { width: "100%" }),
				placeholder: "按名称 / 描述搜索……",
				value: query,
				onChange: (e) => setQuery(e && e.target ? e.target.value : ""),
			});

			const errorNote = state.error
				? react.createElement("div", { key: "err", style: C.err }, "读取失败：" + state.error)
				: null;
			const loadingNote = state.loading && !data
				? react.createElement("div", { key: "load", style: C.tiny }, "正在扫描技能库…")
				: null;
			const rootNote = data && data.root
				? react.createElement("div", { key: "root", style: C.tiny }, "来源：" + String(data.root))
				: null;

			let listNode = null;
			if (shown.length === 0 && data) {
				listNode = react.createElement("div", { key: "empty", style: C.card },
					react.createElement("div", { style: C.sub },
						q ? "没有匹配的技能。" : "技能库是空的（把方法沉淀成技能后会出现在这里）。"));
			} else {
				listNode = react.createElement("div", { key: "list", style: C.list },
					shown.map((s) => react.createElement("div", { key: String(s.name), style: C.item }, kids([
						react.createElement("div", { key: "r", style: C.row }, kids([
							react.createElement("span", { key: "n", style: { fontWeight: 600 } }, String(s.name || "")),
							s.activation
								? react.createElement("span", { key: "a", style: C.badge },
									String(typeof s.activation === "string" ? s.activation : "已注册"))
								: null,
						])),
						s.description
							? react.createElement("div", { key: "d", style: C.sub }, String(s.description))
							: null,
					]))));
			}

			const moreNote = hit.length > shown.length
				? react.createElement("div", { key: "more", style: C.tiny },
					"只显示前 " + SKILL_RENDER_LIMIT + " 条（共 " + hit.length + "）—— 用搜索缩小范围，或打开技能库。")
				: null;

			const footNote = react.createElement("div", { key: "foot", style: C.tiny },
				"本页只读：「启用 / 禁用 / 编辑正文」在技能库里做，避免两处各写一套。");

			return react.createElement("div", { style: C.root, "data-vssaros-view": "skills" },
				kids([head, search, errorNote, loadingNote, rootNote, listNode, moreNote, footNote]));
		}

		// ══════════════════════════════════════════════════════════════════════
		// 3. 待办（官方 todos 投影，只读）
		// ══════════════════════════════════════════════════════════════════════
		/** 从某元素往上找**可滚动的**祖先（对话区）；找不到返回 null。 */
		function scrollableAncestor(el) {
			let node = el;
			while (node && node !== document.body) {
				try {
					const s = window.getComputedStyle(node);
					if (s && (s.overflowY === "auto" || s.overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
						return node;
					}
				} catch { /* 取样式失败继续往上 */ }
				node = node.parentElement;
			}
			return null;
		}

		/** 在对话区按**文本**找叶子元素（只认叶子，否则命中的是整段历史的容器）。 */
		function locateByText(root, text) {
			const scope = root || document;
			if (!scope || !text) { return null; }
			let hit = null;
			try {
				const leaves = scope.querySelectorAll("*");
				for (let i = 0; i < leaves.length; i++) {
					const el = leaves[i];
					if (!el || el.childElementCount !== 0) { continue; }
					const t = (el.textContent || "").trim();
					if (t && t.indexOf(text) >= 0) { hit = el; }
				}
			} catch { /* 遍历失败按没找到处理 */ }
			return hit;
		}

		function flash(el) {
			try {
				const prev = el.style.outline;
				el.style.outline = "2px solid var(--dsw-alias-brand-primary, #3794ff)";
				el.style.outlineOffset = "2px";
				window.setTimeout(() => {
					try { el.style.outline = prev; el.style.outlineOffset = ""; } catch { /* 元素已移除 */ }
				}, 1400);
			} catch { /* 高亮失败不影响滚动 */ }
		}

		const TODO_GROUPS = [
			{ key: "in_progress", label: "进行中", mark: "◐" },
			{ key: "pending", label: "待处理", mark: "○" },
			{ key: "completed", label: "已完成", mark: "✔" },
		];

		function TodoView(props) {
			const say = props.__vssarosSay;
			const useProjection = props.useProjection;
			const hasProjection = typeof useProjection === "function";
			let todos;
			try {
				todos = hasProjection ? useProjection("todos") : undefined;
			} catch {
				todos = undefined;
			}
			const list = Array.isArray(todos) ? todos : null;

			const jump = (item) => {
				const text = String((item && item.content) || "").trim();
				if (!text) { return; }
				const hit = locateByText(scrollableAncestor(document.querySelector("[data-vssaros-css]")) || document, text)
					|| locateByText(document, text);
				if (hit) {
					try { hit.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { hit.scrollIntoView(); }
					flash(hit);
					return;
				}
				say("未在对话里定位到这条任务（可能属于更早的会话，或工具卡已折叠）：" + text);
			};

			if (!hasProjection) {
				// ⚠ 不能把它显示成"还没有任务清单" —— 那是"未知伪装成空"（本仓反复踩的坑 ✗）
				return react.createElement("div", { style: C.root, "data-vssaros-view": "todo" }, kids([
					react.createElement("div", { key: "card", style: C.card }, kids([
						react.createElement("div", { key: "t", style: C.title }, "这个窗口读不到会话投影"),
						react.createElement("div", { key: "s", style: Object.assign({}, C.sub, { marginTop: 6 }) },
							"槽 props 里没有 useProjection（dsh 版本或宿主形态不支持）⇒ 无法展示任务清单，这不是「0 个任务」。"),
					])),
				]));
			}

			if (!list) {
				return react.createElement("div", { style: C.root, "data-vssaros-view": "todo" }, kids([
					react.createElement("div", { key: "card", style: C.card }, kids([
						react.createElement("div", { key: "t", style: C.title }, "还没有任务清单"),
						react.createElement("div", { key: "s", style: Object.assign({}, C.sub, { marginTop: 6 }) },
							"这份清单由 AI 用官方的 todo 工具写入（每轮自动更新）。本会话还没写过 ⇒ 没有数据，不是「0 个任务」。"),
					])),
				]));
			}

			const done = list.filter((t) => t && t.status === "completed").length;
			const pct = list.length > 0 ? Math.round((done / list.length) * 100) : 0;

			const head = react.createElement("div", { key: "head", style: C.row }, kids([
				react.createElement("span", { key: "t", style: C.title }, "任务清单"),
				react.createElement("span", { key: "c", style: C.badge }, done + " / " + list.length + " 已完成"),
				react.createElement("span", { key: "sp", style: C.grow }),
				react.createElement("span", { key: "hint", style: C.tiny }, "点条目定位到写它的那次对话"),
			]));

			const bar = react.createElement("div", { key: "bar", style: C.bar },
				react.createElement("i", { style: Object.assign({}, C.barFill, { width: pct + "%" }) }));

			let body = null;
			if (list.length === 0) {
				body = react.createElement("div", { key: "empty", style: C.card },
					react.createElement("div", { style: C.sub }, "清单是空的。"));
			} else {
				body = react.createElement("div", { key: "body", style: C.list },
					TODO_GROUPS.map((g) => {
						const rows = list.filter((t) => {
							const s = t && t.status;
							if (g.key === "pending") { return s !== "in_progress" && s !== "completed"; }
							return s === g.key;
						});
						if (rows.length === 0) { return null; }
						return react.createElement("div", { key: g.key, style: C.col }, kids([
							react.createElement("div", { key: "l", style: C.tiny }, g.label + "（" + rows.length + "）"),
							react.createElement("div", { key: "rows", style: C.col },
								rows.map((t, i) => react.createElement("div", {
									key: g.key + i,
									style: Object.assign({}, C.item, { cursor: "pointer", display: "flex", gap: 8 }),
									onClick: () => jump(t),
									title: "点击定位到写这条任务的那次对话",
								}, kids([
									react.createElement("span", { key: "m", style: C.sub }, g.mark),
									react.createElement("span", {
										key: "x",
										style: g.key === "completed"
											? Object.assign({}, C.sub, { textDecoration: "line-through", opacity: 0.7 })
											: C.grow,
									}, String((t && t.content) || "")),
								]))),
							),
						]));
					}));
			}

			const footNote = react.createElement("div", { key: "foot", style: C.tiny },
				"数据来自 dsh 会话投影（只读）；增删由 AI 的 todo 工具完成。");

			return react.createElement("div", { style: C.root, "data-vssaros-view": "todo" },
				kids([head, bar, body, footNote]));
		}

		// ══════════════════════════════════════════════════════════════════════

		/** 把 ctx / bridge / say 透给组件：槽 owner 只注入自己的标准 props（同 client.todos.js 做法）。 */
		function wrap(Comp, ctx, bridge, say) {
			return function Wrapped(props) {
				return react.createElement(Comp, Object.assign({}, props, {
					__vssarosCtx: ctx,
					__vssarosBridge: bridge,
					__vssarosSay: say,
				}));
			};
		}

		/**
		 * @param {any} ctx 插件上下文（cordis）
		 * @param {any} shell 主包传下来的外壳：{bridge,state,...}
		 */
		function install(ctx, shell) {
			const state = (shell && shell.state) || {};
			const bridge = shell && shell.bridge;
			const say = (text) => {
				try {
					if (bridge && bridge.notify) { bridge.notify("attention", text); }
				} catch { /* 通知失败不阻塞 */ }
			};
			// ★ 2026-11-05：composer 活动行 / shimmer / 入场动画，一次性幂等注入。
			ensureGroupFlowStyle();
			// 2026-11-03（用户要求：两套页签合并）：「记忆 / 技能 / 待办」由内置
			// @vssaros/dsh-memory 插件提供（分层记忆 KEY.md / 项目日志 / 技能库 / 结构化待办），
			// 本外壳不再重复注册同名页签；只保留唯一的「设置」，并把 evolve 的
			// 「Vssaros Memory 设置」能力以同源 API 接进 SettingsView（见 MemoryModuleCard）。
			// ⚠ ORDERS / IDS 常量保持不变：check-chat-surface-chunks.mjs 对它们有硬断言。
			const views = [
				{ key: "settings", label: "设置", order: ORDERS.settings, Comp: SettingsView },
			];
			for (const view of views) {
				try {
					ctx.slots.inject(SLOT, () => ctx.slots.register({
						name: SLOT,
						id: IDS[view.key],
						order: view.order,
						// label 用函数：语言/文案变化时 owner 会重新求值（与官方同形）
						label: () => view.label,
						// ⚠ 条目 inject 的第一个参数是 **sessionId**（官方 chat / trajectory 同形）；
						//   这里只做"把 sessionId 递进组件"的搬运，不碰 ctx 的其它服务 ——
						//   拿不到绑定也不能抛（抛了整个页签消失 ✗）。
						inject: (sessionId) => ({ sessionId }),
					}, wrap(view.Comp, ctx, bridge, say)));
					state["vssarosConversationView_" + view.key] = true;
				} catch (e) {
					const msg = String((e && e.message) || e);
					state["vssarosConversationViewError_" + view.key] = msg;
					say("页签「" + view.label + "」挂载失败（slot " + SLOT + "）：" + msg);
				}
			}
			// ★ 2026-11-05 群会话里的 `group_relay` 调用 ⇒ 成员气泡（不注册就是一张看不懂的通用工具卡）
			try {
				ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({ name: "tool.call.toolview", key: ROOM_RELAY_TOOL }, GroupRelayView));
				state.vssarosGroupRelayView = true;
			} catch (e) {
				state.vssarosGroupRelayViewError = String((e && e.message) || e);
			}
			// ★ 2026-11-05：composer 上方只读 MemberDock；order 30 避开官方 0/10/20 与本项目 -5/5/15/25。
			//   inject 把 sessionId 递进组件，wrap 把 ctx 递进组件 ⇒ 可区分群会话 / bot 影子会话。
			try {
				ctx.slots.inject(MEMBER_DOCK_SLOT, () => ctx.slots.register(
					{ name: MEMBER_DOCK_SLOT, id: MEMBER_DOCK_ID, order: MEMBER_DOCK_ORDER,
						inject: (sessionId) => ({ sessionId }) }, wrap(GroupMemberDock, ctx, bridge, say)));
				state.vssarosGroupMemberDock = true;
			} catch (e) {
				state.vssarosGroupMemberDockError = String((e && e.message) || e);
			}
		}

		exports.install = install;
		// 仅测试/守卫用：纯逻辑与契约常量
		exports.__test = {
			SLOT, IDS, ORDERS, OFFICIAL,
			isAgentPreset, agentIdOf, cwdOf, isUnder, rootOptionsFor, parseMemory, sizeLabel, explainLoadError, TODO_GROUPS,
			MemoryModuleCard, MEM_GROUPS, SettingsView,
			// ★ 2026-11-05 多 bot 群聊：群标记 / 工具结果解析 / 设置改动 / 两个组件
			ROOM_PROJECTION_KEY, ROOM_RELAY_TOOL, ROOMS_API, roomMarkOfSession, parseRelayResult, roomPatch, RoomSettingsCard, GroupRelayView,
			// ★ 2026-11-05 第一批：状态节点 + 只读 MemberDock
			GROUP_PROGRESS_EVENT, GROUP_DOCK_VISIBILITY_EVENT, MEMBER_DOCK_SLOT, MEMBER_DOCK_ID, MEMBER_DOCK_ORDER, statusNodeText, groupComposerFlowOf, GroupMemberDock,
			GROUP_ROUND_LABELS, groupRoundStatus, RELAY_LOST_AFTER, groupComposerHintOf, isHostInterruptedResult,
			// ★ 2026-11-06：群回复的 Markdown 渲染
			markdownNodes,
		};
		return module.exports;
	},
});
