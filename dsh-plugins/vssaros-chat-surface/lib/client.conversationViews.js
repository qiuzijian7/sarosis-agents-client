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
			/* ★ 2026-11-09：左栏 Bots 页签右键「编辑 Bot」先打开该 Bot 会话与「设置」页签，
			   再派 `vssaros:open-bot-config` ⇒ 这里把分段直接落到 Bot，不用用户再手点一次。
			   `detail.handled` 回填给派发方（未挂载 / 老 chunk 时它会给明确文字指引，不静默）。 */
			react.useEffect(() => {
				const onOpenBotConfig = (ev) => {
					const d = ev && ev.detail;
					if (!d || String(d.sessionId) !== String(sessionId)) { return; }
					if (agentId) { setScope("bot"); d.handled = true; }
				};
				try {
					window.addEventListener("vssaros:open-bot-config", onOpenBotConfig);
					return () => { try { window.removeEventListener("vssaros:open-bot-config", onOpenBotConfig); } catch { /* 忽略 */ } };
				} catch { return undefined; }
			}, [sessionId, agentId]);
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
			const asks = Array.isArray(run.asks) ? run.asks.filter(Boolean) : [];
			const waitingAsk = status === "done" && asks.length > 0;
			const busy = Array.isArray(run.busy) ? run.busy.filter(Boolean) : [];
			const background = status === "done" && !waitingAsk && busy.length > 0;
			const state = status === "failed" ? "error" : status === "cut" ? "cut" : waitingAsk ? "waiting" : background ? "background" : status === "done" ? "done" : "running";
			const speaking = Array.isArray(run.speaking) ? run.speaking : [];
			const replies = (Array.isArray(run.replies) ? run.replies : []).filter((r) => !r || !r.kind);
			const events = Array.isArray(run.events) ? run.events : [];
			const lastEvent = events.length ? events[events.length - 1] : null;
			const seconds = run.startedAt ? Math.max(0, Math.round((((run.finishedAt || Date.now()) - run.startedAt) / 1000) || 0)) : 0;
			const activity = state === "error" ? "执行失败" : state === "cut" ? "本轮被中断 · " + replies.length + " 条回复已保留"
				: state === "waiting" ? "等你选择：" + asks.map((a) => String(a.name || "成员") + " 的 " + ((a.questions || []).length || 1) + " 个问题").join("；")
				: state === "background" ? busy.join("、") + " 还在后台干活，干完会把结果发到群里"
				: state === "done" ? "本轮完成 · " + replies.length + " 条回复 · 用时 " + seconds + "s"
					: speaking.length ? speaking.join("、") + " 正在输入…" : "群成员还在工作…";
			const queueHint = groupComposerHintOf(String((mark && mark.role) || "observer"), state === "running");
			return {
				state, status, statusLabel: run.statusLabel || GROUP_ROUND_LABELS[status],
				role: String((mark && mark.role) || "observer"), roomId: String(run.roomId || roomId || ""),
				roomName: String(run.roomName || ""), activity, queueHint,
				activityKind: state === "running" ? (speaking.length ? "typing" : "status") : state,
				// 等人选择时不重复「群聊本轮完成」：这正是用户要的「不要说完了」
				eventKind: String((lastEvent && lastEvent.kind) || ""), eventText: lastEvent && state !== "waiting" && state !== "background" ? statusNodeText(lastEvent) : "",
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
				approval: "成员在等你批准", ask: "成员在等你选择",
			};
			return map[kind] || kind;
		}
		/** 选择卡草稿 ⇒ 能提交的答案和还差几题（纯函数）。单选：自填优先，选项只留一个。 */
		function askDraftResult(ask, draft) {
			const answers = [];
			let missing = 0;
			for (const q of (ask && ask.questions) || []) {
				const d = (draft && draft[q.id]) || {};
				const selected = Array.isArray(d.selected) ? d.selected : [];
				const custom = String(d.custom || "").trim();
				if (!selected.length && !custom) { missing += 1; continue; }
				answers.push(Object.assign({ id: q.id, selected: q.multiSelect ? selected : (custom ? [] : selected.slice(0, 1)) }, custom ? { custom } : {}));
			}
			return { answers, missing };
		}
		/** 「全部按推荐」的答案；有一题没标推荐 ⇒ null（按钮不出）。纯函数。 */
		function askRecommendedAnswers(ask) {
			const answers = [];
			for (const q of (ask && ask.questions) || []) {
				const picks = (q.options || []).filter((o) => o && o.recommended).map((o) => o.label);
				if (!picks.length) { return null; }
				answers.push({ id: q.id, selected: q.multiSelect ? picks : picks.slice(0, 1) });
			}
			return answers.length ? answers : null;
		}
		/**
		 * ★ 2026-11-07 群聊选择卡（服务端见 vssaros-agents `lib/core/asks.js`）：成员调 `group_ask` 后，群聊输入框上方出这张卡。
		 * 回答 = POST { action:'ask-answer', id, answers } / { action:'ask-answer', id, skip:true }。
		 * 提交后不本地删卡：等下一次进度里它消失（和审批条同一口径），避免「点了但其实没生效」。
		 */
		function GroupAskCard(props) {
			const ask = props.ask;
			const questions = Array.isArray(ask.questions) ? ask.questions : [];
			const [draft, setDraft] = react.useState({});
			const [busy, setBusy] = react.useState("");
			const [err, setErr] = react.useState("");
			const post = (kind, payload) => {
				setBusy(kind); setErr("");
				postJson(ROOMS_API, Object.assign({ action: "ask-answer", id: ask.id }, payload)).then(
					() => setBusy("sent"),
					(e) => { setBusy(""); setErr(String((e && e.message) || e)); },
				);
			};
			const { answers, missing } = askDraftResult(ask, draft);
			const recommended = askRecommendedAnswers(ask);
			const instant = questions.length === 1 && !questions[0].multiSelect;
			const pick = (q, label) => {
				const cur = draft[q.id] || {};
				const selected = Array.isArray(cur.selected) ? cur.selected : [];
				const nextSelected = q.multiSelect
					? (selected.includes(label) ? selected.filter((x) => x !== label) : [...selected, label])
					: [label];
				setDraft(Object.assign({}, draft, { [q.id]: { selected: nextSelected, custom: q.multiSelect ? cur.custom : "" } }));
				// 只有一道单选题：点一下就是答案（对齐 DS Bot 的卡）
				if (instant) { post("submit", { answers: [{ id: q.id, selected: [label] }] }); }
			};
			const write = (q, value) => {
				const cur = draft[q.id] || {};
				setDraft(Object.assign({}, draft, { [q.id]: { selected: q.multiSelect ? (cur.selected || []) : (value.trim() ? [] : (cur.selected || [])), custom: value } }));
			};
			const submit = () => { if (!busy && !missing) { post("submit", { answers }); } };
			const brand = "var(--dsw-alias-brand-primary, #4d7cfe)";
			const warn = "var(--dsw-alias-state-warn-primary, #e2a03f)";
			return react.createElement("div", {
				"data-vssaros-group-ask": ask.id, "data-vssaros-group-ask-bot": String(ask.botId || ""), role: "group",
				"aria-label": String(ask.name || "成员") + " 等你选择",
				style: { display: "flex", flexDirection: "column", gap: 8, padding: "8px 10px", borderRadius: 8, border: "1px solid " + warn },
			}, kids([
				react.createElement("div", { key: "h", style: { fontWeight: 600, fontSize: 12 } },
					String(ask.name || "成员") + " 等你选择" + (questions.length > 1 ? "（" + questions.length + " 个问题）" : "")),
				...questions.map((q, index) => {
					const d = draft[q.id] || {};
					const selected = Array.isArray(d.selected) ? d.selected : [];
					return react.createElement("div", { key: q.id, "data-vssaros-group-ask-question": q.id, style: Object.assign({}, C.col, { gap: 4 }) }, kids([
						react.createElement("div", { key: "q", style: { wordBreak: "break-word" } },
							(questions.length > 1 ? (index + 1) + ". " : "") + (q.header ? q.header + "：" : "") + String(q.question || "")
							+ (q.multiSelect ? "（可多选）" : "")),
						q.detail ? react.createElement("div", { key: "d", style: C.tiny }, String(q.detail)) : null,
						react.createElement("div", { key: "o", style: { display: "flex", flexWrap: "wrap", gap: 6 } },
							(q.options || []).map((o) => {
								const on = selected.includes(o.label);
								return react.createElement("button", {
									key: o.label, type: "button", disabled: !!busy, "aria-pressed": on ? "true" : "false",
									"data-vssaros-group-ask-option": o.label, title: o.description || o.label,
									style: Object.assign({}, C.btn, { whiteSpace: "normal", textAlign: "left", height: "auto", maxWidth: "100%" },
										on ? { borderColor: brand, color: brand, fontWeight: 600 } : null),
									onClick: () => pick(q, o.label),
								}, kids([
									react.createElement("span", { key: "l" }, o.label),
									o.recommended ? react.createElement("span", { key: "r", "data-vssaros-group-ask-recommended": "1", style: { marginLeft: 6, fontSize: 10.5, color: warn } }, "推荐") : null,
									o.description ? react.createElement("div", { key: "d", style: C.tiny }, o.description) : null,
								]));
							})),
						q.allowCustom ? react.createElement("input", {
							key: "c", type: "text", disabled: !!busy, placeholder: "或者自己写…", value: String(d.custom || ""),
							"data-vssaros-group-ask-custom": q.id,
							style: { font: "inherit", fontSize: 11.5, padding: "3px 6px", borderRadius: 6, background: "transparent", color: "inherit",
								border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))" },
							onChange: (e) => write(q, e.target.value),
							onKeyDown: (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); submit(); } },
						}) : null,
					]));
				}),
				react.createElement("div", { key: "a", style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 } }, kids([
					// 只有一道单选题时点选项就提交；但自己写的答案还要一个提交按钮
					!instant || String((draft[questions[0] && questions[0].id] || {}).custom || "").trim()
						? react.createElement("button", { key: "s", type: "button", style: C.btnPrimary, disabled: !!busy || missing > 0, "data-act": "group-ask-submit", onClick: submit },
							busy === "submit" ? "提交中…" : busy === "sent" ? "已提交" : missing > 0 ? "还差 " + missing + " 题" : "提交")
						: null,
					recommended ? react.createElement("button", { key: "r", type: "button", style: C.btn, disabled: !!busy, "data-act": "group-ask-recommended",
						onClick: () => post("recommended", { answers: recommended }) }, busy === "recommended" ? "提交中…" : "全部按推荐") : null,
					react.createElement("button", { key: "k", type: "button", style: C.btn, disabled: !!busy, "data-act": "group-ask-skip",
						onClick: () => post("skip", { skip: true }) }, busy === "skip" ? "提交中…" : "跳过"),
					props.hint ? react.createElement("span", { key: "t", style: C.tiny }, String(props.hint)) : null,
				])),
				err ? react.createElement("div", { key: "e", style: C.err }, err) : null,
			]));
		}
		function GroupAsks(props) {
			const list = Array.isArray(props && props.asks) ? props.asks.filter((a) => a && a.id) : [];
			if (!list.length) { return null; }
			return react.createElement("div", { style: Object.assign({}, C.col, { gap: 6, maxHeight: 340, overflow: "auto" }), "data-vssaros-group-asks": String(list.length) },
				list.map((ask) => react.createElement(GroupAskCard, { key: ask.id, ask, hint: props.hint })));
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
		/** 群设置的改动（只带改了的字段）。纯函数；新增字段按同源 diff。 */
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
			// ★ 2026-11-10 群设置弹层复刻：四档唤醒策略 / 阈值 / 头像 / 加入需确认 / 成员上限
			const wake = String(draft.wakeMode || "");
			const oldWake = String(room.wakeMode || "");
			if (wake && wake !== oldWake) { out.wakeMode = wake; }
			if (JSON.stringify(draft.wake || {}) !== JSON.stringify(room.wake || {})) { out.wake = draft.wake; }
			if (String(draft.avatar || "") !== String(room.avatar || "")) { out.avatar = draft.avatar || ""; }
			if (!!draft.requireApproval !== !!room.requireApproval) { out.requireApproval = !!draft.requireApproval; }
			if (Number(draft.memberMax || 0) !== Number(room.memberMax || 0)) { out.memberMax = Number(draft.memberMax || 0) || undefined; }
			return out;
		}
		/** 四档唤醒策略（DS Bot 的 all / mentions / digest / silent 同款文案）。 */
		const WAKE_MODE_OPTIONS = [
			{ id: "all", label: "全员派发", hint: "每条消息都派给所有成员，适合头脑风暴" },
			{ id: "mentions", label: "仅 @ 派发", hint: "只发被 @ 的成员；一个都没 @ 就留一条系统提示、不派发" },
			{ id: "digest", label: "汇总派发", hint: "消息先攒着，满 N 条再汇总派发一次" },
			{ id: "silent", label: "静默收件", hint: "只进群记录，不唤醒任何成员（@ 也不唤醒）" },
		];
		/** 旧两档 → 四档（与后端 normalizeWakeMode 同口径）。 */
		function normWakeMode(m) {
			const s = String(m || "");
			if (s === "admin" || s === "open") { return "mentions"; }
			if (s === "everyone") { return "all"; }
			return WAKE_MODE_OPTIONS.some((o) => o.id === s) ? s : "mentions";
		}
		/**
		 * 群设置弹层样式（逐项对齐 `poc/dsh-p0/mockups/group-chat.html` L146-174）：
		 * 440px / radius 10 / 遮罩 .5 / 头部与底栏分隔线 / .opt 圆点卡片 / .btn 三态。
		 * 颜色全部走 dsw alias 令牌（跟随 dsh 明暗主题），不写死近灰不透明表面色。
		 */
		const D = {
			mask: { position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 120 },
			dlg: { width: 440, maxWidth: "92vw", maxHeight: "86vh", display: "flex", flexDirection: "column",
				background: "var(--dsw-alias-bg-layer-2, #252526)", border: "1px solid var(--dsw-alias-border-l2, #4a4a4a)",
				borderRadius: 10, boxShadow: "0 16px 48px rgba(0,0,0,.55)", color: "var(--dsw-alias-label-primary, #cccccc)", fontSize: 13 },
			head: { padding: "12px 14px", fontSize: 13, borderBottom: "1px solid var(--dsw-alias-border-l1, #3c3c3c)", display: "flex", alignItems: "center", gap: 8, flex: "none" },
			body: { padding: "12px 14px", overflow: "auto", flex: "1 1 auto", minHeight: 0 },
			foot: { padding: "10px 14px", borderTop: "1px solid var(--dsw-alias-border-l1, #3c3c3c)", display: "flex", gap: 8, alignItems: "center", flex: "none" },
			field: { marginBottom: 10 },
			label: { display: "block", fontSize: 11.5, color: "var(--dsw-alias-label-tertiary, #9d9d9d)", marginBottom: 4 },
			input: { width: "100%", boxSizing: "border-box", background: "var(--dsw-alias-bg-layer-1, #1e1e1e)",
				border: "1px solid var(--dsw-alias-border-l1, #3c3c3c)", borderRadius: 6, padding: "6px 8px", color: "inherit", outline: "none", fontSize: 12 },
			btn: { padding: "5px 12px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, #4a4a4a)", background: "transparent", color: "inherit", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" },
			primary: { background: "var(--dsw-alias-brand-primary, #0e639c)", borderColor: "transparent", color: "#fff" },
			danger: { background: "#a1262a", borderColor: "transparent", color: "#fff" },
			opt: { display: "flex", gap: 8, alignItems: "flex-start", padding: "7px 8px", border: "1px solid var(--dsw-alias-border-l1, #3c3c3c)", borderRadius: 7, marginBottom: 6, cursor: "pointer", width: "100%", textAlign: "left", background: "transparent", color: "inherit" },
			optOn: { borderColor: "var(--dsw-alias-brand-primary, #0e639c)", background: "rgba(14,99,156,.12)" },
			rd: { width: 14, height: 14, borderRadius: "50%", border: "1px solid var(--dsw-alias-border-l2, #4a4a4a)", flex: "none", marginTop: 2, position: "relative" },
			rdDot: { position: "absolute", inset: 3, borderRadius: "50%", background: "var(--dsw-alias-brand-primary, #0e639c)" },
			optTitle: { fontSize: 12, fontWeight: 600 },
			optDesc: { fontSize: 11, color: "var(--dsw-alias-label-dimmed, #6f6f6f)" },
			note: { fontSize: 11, color: "var(--dsw-alias-label-dimmed, #6f6f6f)", marginTop: 6 },
			avatar: { width: 36, height: 36, borderRadius: 9, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", fontSize: 12, fontWeight: 600, color: "#fff" },
			spacer: { flex: "1 1 auto" },
			badge: { fontSize: 11, padding: "1px 6px", borderRadius: 5, border: "1px solid var(--dsw-alias-border-l2, #4a4a4a)" },
		};

		/**
		 * ★ 2026-11-10 群设置弹层（复刻 `poc/dsh-p0/mockups/group-chat.html` L321-373 + L146-174）。
		 * `dialog:true`（中栏独立页 / 右栏）⇒ 全屏遮罩 + 440px 居中对话框；会话内「设置」页签 ⇒ 同款卡片。
		 * 新增：四档唤醒策略、群头像、加入需确认 / 待确认区、清空记录、解散群聊。
		 * ⚠ 保留历史 data 锚点（room-settings / room-notice / room-member / room-save）供守卫断言。
		 */
		function RoomSettingsCard(props) {
			const roomId = props.roomId || "";
			const say = props.say;
			const dialog = props.dialog === true;
			/**
			 * ★ 2026-11-10：右栏页签（dialog=false / embedded）里必须**内联铺满**，
			 *   不能再用 440px 固定宽 + 阴影（会溢出 380px 右栏，还盖住整个窗口）。
			 *   中栏独立页仍用 D.dlg + 遮罩（DS Bot 弹层基线）。
			 */
			const dlgStyle = dialog ? D.dlg : Object.assign({}, D.dlg, {
				width: "100%", maxWidth: "100%", maxHeight: "none", height: "100%",
				border: 0, borderRadius: 0, boxShadow: "none", background: "transparent",
			});
			const [state, reload] = useLoader(() => getJson(ROOMS_API + "?id=" + encodeURIComponent(roomId)), [roomId]);
			const [roster] = useLoader(() => getJson("/x/agents/api/home").then((j) => (Array.isArray(j && j.agents) ? j.agents : [])), []);
			const room = state.data && state.data.room ? state.data.room : null;
			const [draft, setDraft] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [err, setErr] = react.useState("");
			const [confirmDel, setConfirmDel] = react.useState(false);
			const [adding, setAdding] = react.useState("");
			const closedRef = react.useRef(false);
			const fileRef = react.useRef(null);
			const close = () => {
				if (props && typeof props.onClose === "function") { try { props.onClose(); return; } catch { /* 回落 */ } }
				try {
					const fn = typeof window !== "undefined" ? window.__vssarosClosePageTab : null;
					if (typeof fn === "function") { fn("room-settings:" + roomId); return; }
				} catch { /* noop */ }
				closedRef.current = true;
				setDraft(null);
			};
			react.useEffect(() => {
				if (!dialog || typeof document === "undefined") { return undefined; }
				const onKey = (e) => { if (e.key === "Escape") { close(); } };
				document.addEventListener("keydown", onKey, true);
				return () => { try { document.removeEventListener("keydown", onKey, true); } catch { /* noop */ } };
			}, [dialog, roomId]);
			react.useEffect(() => {
				if (!room) { return; }
				closedRef.current = false;
				setDraft({
					name: room.named === false ? "" : room.name, notice: room.notice || "", mode: room.mode, admin: room.admin,
					members: (room.members || []).map((m) => m.id),
					wakeMode: normWakeMode(room.wakeMode || room.mode),
					wake: { count: Number(room.wake && room.wake.count) || 5, intervalSeconds: Number(room.wake && room.wake.intervalSeconds) || 30 },
					avatar: String(room.avatar || ""),
					requireApproval: room.requireApproval === true,
					memberMax: Number(room.memberMax) || 0,
				});
			}, [room && JSON.stringify(room)]);
			if (!room || !draft) {
				const loading = react.createElement("div", { style: dlgStyle, "data-vssaros-room-settings": "loading" }, kids([
					react.createElement("div", { key: "t", style: D.head }, "群设置"),
					react.createElement("div", { key: "s", style: Object.assign({}, D.body, D.note) }, state.error ? "读取失败：" + state.error : "读取中…"),
				]));
				return dialog ? react.createElement("div", { style: D.mask, "data-vssaros-room-dialog": roomId }, loading) : loading;
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
			const reset = () => {
				setDraft({
					name: room.named === false ? "" : room.name, notice: room.notice || "", mode: room.mode, admin: room.admin,
					members: (room.members || []).map((m) => m.id),
					wakeMode: normWakeMode(room.wakeMode || room.mode),
					wake: { count: Number(room.wake && room.wake.count) || 5, intervalSeconds: Number(room.wake && room.wake.intervalSeconds) || 30 },
					avatar: String(room.avatar || ""), requireApproval: room.requireApproval === true,
					memberMax: Number(room.memberMax) || 0,
				});
				setErr("");
			};
			const set = (key, value) => setDraft(Object.assign({}, draft, { [key]: value }));
			const field = (label, el, key) => react.createElement("div", { key: "f:" + (key || label), style: D.field }, kids([
				react.createElement("div", { key: "l", style: D.label }, label), el]));
			/** 群头像：居中裁方 128×128，data URI；只收 png/jpeg/webp，≤96KB（超了降质量）。 */
			const onAvatar = (e) => {
				const file = e.target.files && e.target.files[0];
				try { e.target.value = ""; } catch { /* 允许重复选同一文件 */ }
				if (!file) { return; }
				if (!/^image\/(png|jpeg|webp)$/.test(String(file.type || ""))) { setErr("群头像只收 png / jpeg / webp"); return; }
				try {
					const reader = new FileReader();
					reader.onerror = () => setErr("读不出这张图");
					reader.onload = () => {
						const img = new Image();
						img.onerror = () => setErr("读不出这张图（格式不支持？）");
						img.onload = () => {
							const s = Math.min(img.width, img.height);
							const cv = document.createElement("canvas");
							cv.width = 128; cv.height = 128;
							const g = cv.getContext("2d");
							if (g) { g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128); }
							let uri = cv.toDataURL("image/png");
							if (uri.length > 131072 + 64) { uri = cv.toDataURL("image/jpeg", 0.7); }
							if (uri.length > 131072 + 64) { setErr("群头像超过 96KB，请换一张更小的图"); return; }
							set("avatar", uri); setErr("");
						};
						img.src = String(reader.result || "");
					};
					reader.readAsDataURL(file);
				} catch (e2) { setErr("头像处理失败：" + String((e2 && e2.message) || e2)); }
			};
			const candidates = (roster.data || []).filter((a) => a && a.registered !== false && !a.external && draft.members.indexOf(a.id) < 0);
			const pending = Array.isArray(room.pending) ? room.pending : [];
			const body = react.createElement("div", { key: "b", style: D.body }, kids([
				field("群名", react.createElement("input", {
					key: "n", style: D.input, value: draft.name, maxLength: 60, placeholder: "留空 = 按成员命名",
					"data-vssaros-room-name": "1", disabled: busy,
					onChange: (e) => set("name", e.target.value),
				}), "name"),
				react.createElement("div", { key: "approval", style: D.field }, kids([
					react.createElement("label", { key: "l", style: Object.assign({}, D.label, { display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }) }, kids([
						react.createElement("input", { key: "c", type: "checkbox", checked: draft.requireApproval, disabled: busy,
							style: { width: "auto", margin: 0 }, "data-vssaros-room-approval": "1",
							onChange: (e) => set("requireApproval", e.target.checked) }),
						react.createElement("span", { key: "t" }, "加入需确认"),
					])),
					react.createElement("div", { key: "n", style: D.note }, "打开后：被邀请的成员先进「待确认」区，你点 ✓ 才真正进群（防误拉）。"),
				])),
				field("群头像（方形）", react.createElement("div", { key: "a", style: { display: "flex", gap: 10, alignItems: "center" } }, kids([
					react.createElement("span", { key: "v", style: Object.assign({}, D.avatar, { background: "var(--dsw-alias-brand-primary, #4d7cfe)" }),
						"data-vssaros-room-avatar": "1" }, draft.avatar
						? react.createElement("img", { src: draft.avatar, alt: "群头像", style: { width: "100%", height: "100%", objectFit: "cover", display: "block" } })
						: String(room.name || "群").slice(0, 1)),
					react.createElement("input", { key: "f", type: "file", accept: "image/png,image/jpeg,image/webp", ref: fileRef,
						style: { display: "none" }, "data-vssaros-room-avatar-file": "1", onChange: onAvatar }),
					react.createElement("button", { key: "p", type: "button", style: D.btn, disabled: busy, "data-act": "room-avatar-pick",
						onClick: () => { if (fileRef.current && typeof fileRef.current.click === "function") { fileRef.current.click(); } } }, "选择图片…"),
					react.createElement("button", { key: "x", type: "button", style: D.btn, disabled: busy || !draft.avatar, "data-act": "room-avatar-clear",
						onClick: () => set("avatar", "") }, "移除"),
				])), "avatar"),
				react.createElement("div", { key: "an", style: D.note }, "居中裁成方形并缩到 128×128；只收 png/jpeg/webp 且 ≤96KB（超了自动降质量重压）。"),
				field("群公告（每位成员发言前都会读到的共同说明）", react.createElement("textarea", {
					key: "o", style: Object.assign({}, D.input, { minHeight: 56, resize: "vertical" }), value: draft.notice,
					maxLength: 2000, "data-vssaros-room-notice": "1", disabled: busy,
					onChange: (e) => set("notice", e.target.value),
				}), "notice"),
				react.createElement("div", { key: "wakeLabel", style: Object.assign({}, D.label, { marginTop: 10, marginBottom: 6 }) }, "唤醒策略"),
				react.createElement("div", { key: "wake", style: { marginBottom: 6 } }, WAKE_MODE_OPTIONS.map((m) => {
					const on = draft.wakeMode === m.id;
					return react.createElement("button", {
						key: m.id, type: "button", style: Object.assign({}, D.opt, on ? D.optOn : null),
						"data-vssaros-room-wake": m.id, "aria-pressed": on ? "true" : "false",
						onClick: () => set("wakeMode", m.id),
					}, kids([
						react.createElement("span", { key: "r", style: Object.assign({}, D.rd, on ? { borderColor: "var(--dsw-alias-brand-primary, #0e639c)" } : null) },
							on ? react.createElement("span", { style: D.rdDot }) : null),
						react.createElement("span", { key: "t" }, kids([
							react.createElement("div", { key: "b", style: D.optTitle }, m.label),
							react.createElement("div", { key: "d", style: D.optDesc }, m.hint),
						])),
					]));
				})),
				draft.wakeMode === "digest" ? react.createElement("div", { key: "wakeBox", style: { display: "flex", gap: 8, marginTop: 8 },
					"data-vssaros-room-wake-box": "1" }, kids([
					react.createElement("div", { key: "c", style: { flex: 1 } }, kids([
						react.createElement("div", { key: "l", style: D.label }, "条数（1–100）"),
						react.createElement("input", { key: "i", type: "number", min: 1, max: 100, style: D.input, value: draft.wake.count,
							"data-vssaros-room-wake-count": "1", disabled: busy,
							onChange: (e) => set("wake", Object.assign({}, draft.wake, { count: e.target.value })) }),
					])),
					react.createElement("div", { key: "s", style: { flex: 1 } }, kids([
						react.createElement("div", { key: "l", style: D.label }, "最长等待（秒）"),
						react.createElement("input", { key: "i", type: "number", min: 1, max: 3600, style: D.input, value: draft.wake.intervalSeconds,
							"data-vssaros-room-wake-interval": "1", disabled: busy,
							onChange: (e) => set("wake", Object.assign({}, draft.wake, { intervalSeconds: e.target.value })) }),
					])),
				])) : null,
				react.createElement("div", { key: "wakeNote", style: D.note }, "四档名与 DeepSeekBot 的 all / mentions / digest / silent 一一对应；旧值 admin → mentions、everyone → all 自动归一化。"),
				field("成员（" + draft.members.length + " 位）", react.createElement("ul", { key: "ms", style: { listStyle: "none", margin: 0, padding: 0 } },
					draft.members.map((id) => react.createElement("li", {
						key: id, style: Object.assign({}, D.opt, { alignItems: "center", marginBottom: 4, cursor: "default" }),
						"data-vssaros-room-member": id,
					}, kids([
						react.createElement("span", { key: "n", style: { flex: "1 1 auto" } }, nameOf(id)),
						draft.admin === id ? react.createElement("span", { key: "a", style: D.badge }, "管理员")
							: react.createElement("button", { key: "s", type: "button", style: D.btn, disabled: busy,
								onClick: () => set("admin", id) }, "设为管理员"),
						draft.members.length > 2 ? react.createElement("button", { key: "x", type: "button", style: D.btn, disabled: busy, "data-act": "room-member-remove",
							onClick: () => {
								const members = draft.members.filter((m) => m !== id);
								setDraft(Object.assign({}, draft, { members, admin: draft.admin === id ? members[0] : draft.admin }));
							} }, "移出") : null,
					])))), "members"),
				pending.length ? field("待确认", react.createElement("ul", { key: "pd", style: { listStyle: "none", margin: 0, padding: 0 } },
					pending.map((id) => react.createElement("li", { key: id, style: Object.assign({}, D.opt, { alignItems: "center", marginBottom: 4, cursor: "default" }),
						"data-vssaros-room-pending": id }, kids([
						react.createElement("span", { key: "n", style: { flex: "1 1 auto" } }, nameOf(id)),
						react.createElement("button", { key: "y", type: "button", style: D.btn, disabled: busy, "data-act": "room-join-confirm",
							onClick: () => post({ action: "confirm-join", botId: id, allow: true }) }, "✓ 同意"),
						react.createElement("button", { key: "n2", type: "button", style: D.btn, disabled: busy, "data-act": "room-join-reject",
							onClick: () => post({ action: "confirm-join", botId: id, allow: false }) }, "✕"),
					])))), "pending") : null,
				candidates.length ? react.createElement("div", { key: "add", style: Object.assign({}, D.field, { display: "flex", gap: 8, alignItems: "center" }) }, kids([
					react.createElement("select", { key: "s", style: D.input, value: adding, "data-vssaros-room-add": "1", disabled: busy,
						onChange: (e) => setAdding(e.target.value) }, [react.createElement("option", { key: "", value: "" }, "添加成员…")]
						.concat(candidates.map((a) => react.createElement("option", { key: a.id, value: a.id }, String(a.name || a.id))))),
					react.createElement("button", { key: "b", type: "button", style: D.btn, disabled: busy || !adding, "data-act": "room-invite",
						onClick: () => { post({ action: "invite", botId: adding }); setAdding(""); } }, "邀请"),
				])) : null,
				field("侧栏", react.createElement("div", { key: "f", style: { display: "flex", gap: 12 } }, kids([
					react.createElement("label", { key: "p", style: { display: "flex", gap: 6, alignItems: "center" } }, kids([
						react.createElement("input", { key: "c", type: "checkbox", checked: room.pinned === true, disabled: busy, "data-vssaros-room-pin": "1",
							onChange: (e) => post({ action: "flags", pinned: e.target.checked }) }),
						react.createElement("span", { key: "l" }, "置顶"),
					])),
					react.createElement("label", { key: "h", style: { display: "flex", gap: 6, alignItems: "center" } }, kids([
						react.createElement("input", { key: "c", type: "checkbox", checked: room.hidden === true, disabled: busy, "data-vssaros-room-hide": "1",
							onChange: (e) => post({ action: "flags", hidden: e.target.checked }) }),
						react.createElement("span", { key: "l" }, "从侧栏隐藏"),
					])),
				])), "sidebar"),
				/* ★ 2026-11-10：群设置里增加 Channel 绑定 —— IM 会话的消息转投到这个群，
				   群答复回传该 IM 会话。绑定走自己的接口，不塞进「保存」按钮的 roomPatch。 */
				react.createElement(BotChannelBindingsCard, {
					key: "channel-bindings", targetKind: "group", targetId: roomId,
				}),
				err ? react.createElement("div", { key: "e", style: Object.assign({}, D.note, { color: "var(--dsw-alias-state-error-primary, #e5534b)" }) }, err) : null,
			]));
			const head = react.createElement("div", { key: "h", style: D.head }, kids([
				react.createElement("span", { key: "t", style: { fontWeight: 600 } }, "群设置"),
				react.createElement("span", { key: "b", style: D.badge }, draft.members.length + " 位成员"),
				react.createElement("span", { key: "s", style: D.spacer }),
				react.createElement("button", { key: "x", type: "button", title: "关闭群设置", "aria-label": "关闭群设置",
					"data-vssaros-room-settings-close": roomId, onClick: close,
					style: { width: 26, height: 26, borderRadius: 6, border: 0, background: "transparent", cursor: "pointer", color: "inherit", fontSize: 13 } }, "✕"),
			]));
			const foot = react.createElement("div", { key: "f", style: D.foot }, kids([
				react.createElement("button", { key: "c", type: "button", style: D.btn, disabled: busy, "data-act": "room-clear",
					onClick: () => post({ action: "clear" }, () => { if (say) { say("群内记录已清空"); } }) }, "清空记录"),
				confirmDel
					? react.createElement("div", { key: "d", style: { display: "flex", gap: 6, alignItems: "center" } }, kids([
						react.createElement("span", { key: "q", style: D.note }, "解散后群会话与成员的群内会话会归档，确定？"),
						react.createElement("button", { key: "y", type: "button", style: Object.assign({}, D.btn, D.danger), disabled: busy,
							"data-act": "room-delete-confirm", onClick: () => post({ action: "dissolve" }, () => { if (say) { say("群聊已解散"); } }) }, "确定解散"),
						react.createElement("button", { key: "n", type: "button", style: D.btn, onClick: () => setConfirmDel(false) }, "取消"),
					]))
					: react.createElement("button", { key: "d", type: "button", style: Object.assign({}, D.btn, D.danger), disabled: busy,
						"data-act": "room-delete", onClick: () => setConfirmDel(true) }, "解散群聊"),
				react.createElement("span", { key: "sp", style: D.spacer }),
				react.createElement("button", { key: "x", type: "button", style: D.btn, onClick: close }, "取消"),
				react.createElement("button", { key: "s", type: "button", style: Object.assign({}, D.btn, D.primary), disabled: busy || !dirty,
					"data-act": "room-save", onClick: save }, busy ? "保存中…" : "保存"),
			]));
			// ⚠ 锚点必须挂在**整个对话框**上：头部 / 内容 / 底栏都是它的子节点，
			//   守卫按 [data-vssaros-room-settings] 查卡片后会再找底栏的 room-save。
			const content = react.createElement("div", { key: "dlg", style: dlgStyle, "data-vssaros-room-settings": roomId }, [head, body, foot]);
			return dialog
				? react.createElement("div", { key: "mask", style: D.mask, "data-vssaros-room-dialog": roomId,
					onClick: (e) => { if (e.target === e.currentTarget) { close(); } } }, content)
				: content;
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
			// ★ 2026-11-07：别的会话也要知道有卡在等 ⇒ 没有本群轮次时，优先显示有卡的那个群
			const hasAsks = (item) => !!item && Array.isArray(item.asks) && item.asks.length > 0;
			const ordered = [...active.filter(hasAsks), ...active.filter((item) => !hasAsks(item))];
			const current = ordered.find((item) => roomId && item && item.roomId === roomId) || ordered[0];
			const flow = groupComposerFlowOf(ordered, mark);
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
			const asks = Array.isArray(current.asks) ? current.asks.filter(Boolean) : [];
			const inThisRoom = !!roomId && String(current.roomId || "") === roomId;
			for (const item of asks) { add(item && item.name, "ask", "等你选择"); }
			const busy = Array.isArray(current.busy) ? current.busy.filter(Boolean) : [];
			for (const name of busy) { add(name, "background", "后台干活"); }
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
				react.createElement("span", { key: "s", style: { color: roundStatus === "failed" || roundStatus === "cut" ? "var(--dsw-alias-state-error-primary, #f14c4c)" : roundStatus === "done" && !asks.length && !busy.length ? "var(--dsw-alias-state-success-primary, #4ac26b)" : "var(--dsw-alias-state-warn-primary, #e2a03f)" } }, status),
				...pills.slice(0, 8).map((pill, i) => react.createElement("span", {
					key: "m" + i, "data-vssaros-group-member": pill.name, "data-vssaros-group-member-state": pill.state,
					title: pill.name + " · " + pill.label,
					style: {
						borderRadius: 999, padding: "2px 7px", border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))",
						color: pill.state === "failed" ? "var(--dsw-alias-state-error-primary, #f14c4c)" : "inherit",
						whiteSpace: "nowrap", maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis",
					},
				}, pill.name + " · " + pill.label)),
				lastEvent && lastEvent.text && !((asks.length || busy.length) && lastEvent.kind === "done") ? react.createElement("span", {
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
				// ★ 2026-11-07 选择卡：群会话 / 成员会话里直接答；别的会话只提示，点了去群里（不在别人的输入框上方摊开一张表单）
				asks.length && inThisRoom ? react.createElement("div", { key: "ask", style: { flex: "1 1 100%" } },
					react.createElement(GroupAsks, { asks, hint: dockRole === "room" ? "也可以直接在下面打字回复，算作回答" : "" })) : null,
				asks.length && !inThisRoom ? react.createElement("div", { key: "ask-n", "data-vssaros-group-ask-notice": String(current.roomId || ""),
					style: { flex: "1 1 100%", display: "flex", alignItems: "center", gap: 6 } }, kids([
					react.createElement("span", { key: "t", style: { flex: "1 1 auto", minWidth: 0 } },
						asks.map((a) => String(a.name || "成员") + " 在等你选择").join("；") + "（" + String(current.roomName || "群聊") + "）"),
					react.createElement("button", { key: "b", type: "button", style: C.btnPrimary, "data-act": "group-ask-open", onClick: () => {
						try {
							const id = String(current.roomId);
							// ★ 2026-11-10：跨 chunk 旁路打开群也要更新「记住的群」，否则 Host 仍按旧群放宽转投。
							//   优先走 client.workspaces.js 注册的桥；没装时回落写盘 + 广播（键/事件与该 chunk 同源）。
							const win = typeof window !== "undefined" ? window : null;
							if (win && typeof win.__vssarosSelectRoom === "function") { win.__vssarosSelectRoom(id); }
							else {
								try { if (typeof localStorage !== "undefined") { localStorage.setItem("vssaros.chatSurface.selectedRoom.v1", id); } } catch { /* 隐私模式 */ }
								try {
									const Ctor = win && (win.Event || (typeof Event !== "undefined" ? Event : null));
									if (Ctor) { win.dispatchEvent(new Ctor("vssaros-ws-selected-room")); }
								} catch { /* 事件不可用 ⇒ 下次渲染才看到 */ }
							}
							ctx.uiWorkspace.openSession(id);
						} catch { /* 打开失败：提示还在 */ }
					} }, "去选择"),
				])) : null,
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
		/**
		 * Bot ↔ Channel 绑定卡（2026-11-09）：绑定表在 vssaros-agents 里以「渠道为主键」存，
		 * `targetKind:'agent' + targetId` 反向指向 Bot；这里按当前 agentId 过滤出它的绑定，
		 * 并提供人可操作的新建 / 启停 / 删除。后端 assertHuman 与 fail-closed 白名单语义不变，
		 * 平台清单只从 `channelDefs`（imPlatforms 单一真源）渲染，客户端不写死平台 key。
		 */

		/* ★ 2026-11-10 用户选方案 A（`design/channel-binding-mockups/a-compact.html`）：
		 * ① 标题下约 150 字说明收进 ⓘ 富卡；② 绑定 item 拆成「身份 / 状态 / 操作」+
		 *    「chat_id / 标签」两行；③ 新建表单默认折叠，字段说明也走短 ⓘ，
		 *    超长 placeholder 不再承载文档。
		 * ⚠ tip 用 React state 显隐（dsh chunk 不注入全局 <style>），bubble 常驻 DOM
		 *   ⇒ 读屏可读、键盘可聚焦；且不叠原生 title（避免两个浮层）。
		 */
		const BOTBIND_HELP = [
			"把 IM 会话绑定到这个 Bot；一条绑定 = 一个应用 + 一个 chat_id。",
			"只有人能创建 / 修改 / 删除，模型不能代劳。",
			"入站白名单留空 = 拒绝所有入站（fail-closed）。",
			"飞书可在此选应用或添加新应用。",
			"群策略 groupPolicy 默认 open：群里仍需 @ 机器人。",
		];
		const B = {
			list: { display: "flex", flexDirection: "column", gap: 6, marginTop: 10 },
			row: { border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.24))", borderRadius: 7,
				background: "var(--dsw-alias-bg-layer-1, transparent)", padding: "7px 9px" },
			top: { display: "flex", alignItems: "center", gap: 7 },
			ico: { width: 24, height: 24, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", flex: "none",
				background: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))",
				color: "var(--dsw-alias-brand-primary, #3794ff)" },
			icoOff: { color: "var(--dsw-alias-label-tertiary, rgba(128,128,128,.8))", background: "transparent",
				border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.24))" },
			name: { fontSize: 12.5, fontWeight: 600 },
			meta: { display: "flex", alignItems: "center", gap: 6, marginTop: 5, paddingLeft: 31, flexWrap: "wrap" },
			cid: { maxWidth: 168, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
				fontFamily: "ui-monospace, Consolas, monospace", fontSize: 11,
				color: "var(--dsw-alias-label-secondary, currentColor)" },
			chip: { display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 6px", borderRadius: 5,
				border: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.24))", fontSize: 10.5,
				color: "var(--dsw-alias-label-secondary, currentColor)", whiteSpace: "nowrap" },
			chipOn: { color: "var(--dsw-alias-state-success-primary, #3fb27f)", borderColor: "var(--dsw-alias-state-success-primary, #3fb27f)" },
			chipOff: { color: "var(--dsw-alias-label-tertiary, rgba(128,128,128,.8))" },
			chipBrand: { color: "var(--dsw-alias-brand-primary, #3794ff)", borderColor: "var(--dsw-alias-brand-primary, #3794ff)" },
			dot: { width: 7, height: 7, borderRadius: "50%", background: "var(--dsw-alias-label-tertiary, rgba(128,128,128,.8))", flex: "none" },
			dotOn: { background: "var(--dsw-alias-state-success-primary, #3fb27f)" },
			iconBtn: { width: 24, height: 24, display: "inline-flex", alignItems: "center", justifyContent: "center",
				border: "1px solid transparent", borderRadius: 6, background: "transparent",
				color: "var(--dsw-alias-label-secondary, currentColor)", cursor: "pointer", padding: 0, flex: "none" },
			iconBtnDanger: { color: "var(--dsw-alias-state-error-primary, #e5534b)" },
			tipWrap: { position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center",
				width: 18, height: 18, borderRadius: "50%", cursor: "help", flex: "none",
				color: "var(--dsw-alias-label-secondary, currentColor)" },
			tipBubble: { position: "absolute", top: 22, right: -8, width: 288, maxWidth: "78vw", zIndex: 50,
				padding: "9px 11px", borderRadius: 8,
				background: "var(--dsw-alias-bg-layer-2, #252526)",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
				boxShadow: "0 12px 28px rgba(0,0,0,.4)",
				color: "var(--dsw-alias-label-primary, currentColor)", fontSize: 11.5, lineHeight: "1.65",
				fontWeight: 400, textAlign: "left", whiteSpace: "normal", cursor: "auto" },
			tipBubbleLeft: { right: "auto", left: -8 },
			tipTitle: { display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 },
			tipList: { margin: 0, paddingLeft: 15 },
			newToggle: { marginTop: 10, width: "100%", boxSizing: "border-box",
				border: "1px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.35))", borderRadius: 7,
				background: "transparent", color: "var(--dsw-alias-label-secondary, currentColor)",
				font: "inherit", fontSize: 11.5, padding: "6px", cursor: "pointer" },
			form: { marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.24))",
				display: "flex", flexDirection: "column", gap: 7 },
			field: { display: "flex", alignItems: "center", gap: 6, fontSize: 11,
				color: "var(--dsw-alias-label-secondary, currentColor)" },
			fieldLabel: { flex: "0 0 74px" },
			input: { flex: "1 1 auto", minWidth: 0, width: "100%", boxSizing: "border-box",
				font: "inherit", fontSize: 11.5, padding: "4px 7px", borderRadius: 6,
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
				background: "var(--dsw-alias-bg-layer-1, transparent)", color: "inherit", outline: "none" },
		};
		const BIND_ICON = {
			msg: "M4 5h16v11H9l-5 4V5z",
			pause: "M9 6v12M15 6v12",
			play: "M8 5l10 7-10 7V5z",
			trash: "M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13",
			refresh: "M19 8a7 7 0 1 0 1 6M19 4v4h-4",
			chevronDown: "M6 9l6 6 6-6",
			chevronUp: "M6 15l6-6 6 6",
		};
		/** 线性 SVG 图标（不用 emoji 当图标）。 */
		function bindIcon(kind, size) {
			return react.createElement("svg", {
				width: size || 14, height: size || 14, viewBox: "0 0 24 24", "aria-hidden": "true",
				fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round",
				style: { display: "block" },
			}, react.createElement("path", { d: BIND_ICON[kind] || BIND_ICON.msg }));
		}
		/** ⓘ tip：hover / 键盘 focus 都展开；富卡常驻 DOM（读屏可读），不叠原生 title。 */
		function BotbindTip(props) {
			const [open, setOpen] = react.useState(false);
			const anchor = props.anchor || "data-vssaros-botbind-tip";
			return react.createElement("span", {
				[anchor]: props.name || "1",
				tabIndex: 0, role: "button", "aria-label": props.label || "说明",
				style: B.tipWrap,
				onMouseEnter: () => setOpen(true), onMouseLeave: () => setOpen(false),
				onFocus: () => setOpen(true), onBlur: () => setOpen(false),
				// ★ 已绑定行整行可点展开 ⇒ tip / 面板内点击不许冒泡，避免点 ⓘ 却把编辑收起
				onClick: (e) => { try { e.stopPropagation(); } catch { /* 合成事件 */ } },
			}, kids([
				react.createElement("svg", { key: "i", width: 14, height: 14, viewBox: "0 0 24 24", "aria-hidden": "true",
					fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", style: { display: "block" } }, kids([
					react.createElement("circle", { key: "c", cx: 12, cy: 12, r: 9 }),
					react.createElement("path", { key: "p", d: "M12 10.5v6M12 7.4v.2", strokeWidth: 1.9 }),
				])),
				react.createElement("span", { key: "b", role: "tooltip",
					style: Object.assign({}, B.tipBubble, props.left ? B.tipBubbleLeft : null, {
						opacity: open ? 1 : 0, visibility: open ? "visible" : "hidden",
						pointerEvents: open ? "auto" : "none",
					}) }, props.children),
			]));
		}
		function directionLabelOf(d) { return d === "in" ? "仅入站" : d === "out" ? "仅出站" : "双向"; }

		function BotChannelBindingsCard(props) {
			/* ★ 2026-11-10：同一张卡复用于 Bot 设置（agent）与群设置（group）。
			   `agentId` 仍是所有锚点/守卫依赖的变量名，群模式下取 targetId（= roomId）。 */
			const targetKind = String(props.targetKind || "agent");
			const agentId = props.agentId || props.targetId || "";
			const [state, reload] = useLoader(() => getJson("/x/agents/api/bindings"), []);
			const [busy, setBusy] = react.useState("");
			const [err, setErr] = react.useState("");
			/* ★ 2026-11-10：保存/创建的成功反馈要看得见（原来只有错误，成功也像「没反应」）。 */
			const [notice, setNotice] = react.useState("");
			const [form, setForm] = react.useState({ platform: "", chatId: "", chatType: "group", direction: "both", allowFrom: "", groupPolicy: "", appId: "", newAppId: "", newAppSecret: "", newAppName: "" });
			// ★ 方案 A：新建表单默认折叠（右栏 380px 里不再一上来就铺 8 个字段）
			const [showNew, setShowNew] = react.useState(false);
			// ★ 2026-11-10：已绑定 item 展开编辑；同一时刻只展开一条。
			const [expandedId, setExpandedId] = react.useState("");
			const [editDraft, setEditDraft] = react.useState(null);
			const data = state.data || {};
			const defs = Array.isArray(data.channelDefs) ? data.channelDefs : [];
			const all = Array.isArray(data.bindings) ? data.bindings : [];
			const mine = all.filter((b) => String(b.targetKind || "agent") === targetKind && String(b.targetId || "") === agentId);
			const defOf = (key) => defs.find((d) => String(d.key) === String(key));
			/* ★ 2026-11-10（用户报「新增飞书应用里缺少 groupPolicy」）：
			   groupPolicy 的真源是 imPlatforms.js 的 feishu.fields（select + options + default），
			   而真正生效的判定在 channelPolicy.js / bindings.js 的 **binding 级**。
			   ⚠ 别把它塞进 action:'feishu-app'：saveFeishuApp 只存 appSecret/name，存了不生效
			     = 假入口。⇒ 放在新建绑定表单，随 action:'create' 一起落盘（normalizeBinding 已支持）。 */
			const groupPolicyDef = (() => {
				const d = defOf("feishu");
				return d && Array.isArray(d.fields) ? d.fields.find((f) => String(f.key) === "groupPolicy") : null;
			})();
			const groupPolicyOptions = ((groupPolicyDef && groupPolicyDef.options) || [])
				.map((o) => ({ value: String(o.value), label: String(o.label || o.value) }));
			const groupPolicyValue = String(form.groupPolicy || (groupPolicyDef && groupPolicyDef.default) || "open");
			const labelOf = (key) => { const d = defOf(key); return d ? String(d.label || d.key) : String(key); };
			const hintOf = (key) => { const d = defOf(key); return d ? String(d.chatIdHint || "") : ""; };
			const set = (key, value) => setForm((f) => Object.assign({}, f || {}, { [key]: value }));
			react.useEffect(() => {
				if (!form.platform && defs.length) {
					const first = defs.find((d) => d.implemented !== false) || defs[0];
					set("platform", String(first.key));
				}
			}, [defs.length, form.platform]);
			const run = (body, tag) => {
				setBusy(tag);
				setErr(""); setNotice("");
				postJson("/x/agents/api/bindings", Object.assign({ actor: { kind: "human" } }, body)).then(
					() => {
						setBusy("");
						if (body.action === "create") {
							set("chatId", ""); set("allowFrom", "");
							setNotice("✓ 已创建绑定");
						}
						reload();
					},
					(e) => { setBusy(""); setErr(String((e && e.message) || e)); },
				);
			};
			// `onChange` 可注入：新建表单默认写 form，已绑定 item 的编辑面板写 editDraft。
			const input = (key, value, placeholder, type, onChange) => react.createElement("input", {
				style: B.input,
				type: type || "text", value: value, placeholder: placeholder || "", disabled: !!busy,
				["data-vssaros-botbind-" + key]: "1",
				onChange: onChange || ((e) => set(key, e && e.target ? e.target.value : "")),
			});
			const select = (key, value, options, onChange) => react.createElement("select", {
				style: B.input,
				value: value, disabled: !!busy, ["data-vssaros-botbind-" + key]: "1",
				onChange: onChange || ((e) => set(key, e && e.target ? e.target.value : "")),
			}, options.map((o) => react.createElement("option", { key: o.value, value: o.value, disabled: !!o.disabled }, o.label)));
			const platformOptions = defs.map((d) => ({
				value: String(d.key), label: String(d.label || d.key) + (d.implemented === false ? "（暂未接入）" : ""),
			}));
			/* ★ 2026-11-10（用户要求：飞书应用选择并入 Channel 绑定，移除独立「飞书配置」卡）：
			   数据源 = GET /x/agents/api/bindings 的 feishuApps（describeFeishuApps 掩码视图，
			   只有 hasSecret / name，绝不含 secret 明文）。空 = 默认应用；__new__ = 就地新增。 */
			const feishuApps = Array.isArray(data.feishuApps) ? data.feishuApps : [];
			const appLabel = (id) => {
				if (!id) { return "VsSaros助手"; }
				const a = feishuApps.find((x) => String(x.appId) === String(id));
				return a && a.name ? String(a.name) : String(id);
			};
			/* ★ 2026-11-10（用户要求）：内置默认应用对外统一使用产品名「VsSaros助手」。 */
			const appOptions = [{ value: "", label: "VsSaros助手" }].concat(
				feishuApps.filter((a) => !a.isDefault).map((a) => ({
					value: String(a.appId || ""), disabled: !a.hasSecret,
					label: (a.name ? String(a.name) + " · " : "") + String(a.appId || "") + (a.hasSecret ? "" : "（缺 App Secret）"),
				}))
			);
			appOptions.push({ value: "__new__", label: "+ 添加新应用（App ID / App Secret）" });
			/**
			 * 保存新应用并选用，返回 appId（失败返回 null）。
			 *
			 * ★ 2026-11-10（真机「点了创建绑定没反应」）：原来选了「+ 添加新应用」时创建按钮被
			 *   静默 disabled，界面上没有任何说明；用户填完 App ID / Secret 后点创建完全无响应。
			 *   ⇒ 现在做成可被创建流程复用的异步函数：创建绑定时自动先跑这一步。
			 */
			const addApp = async () => {
				const id = String(form.newAppId || "").trim();
				const secret = String(form.newAppSecret || "").trim();
				if (!/^cli_[A-Za-z0-9]{4,64}$/.test(id) || !secret) {
					setErr("请填合法 App ID（cli_…）与 App Secret"); return null;
				}
				/* 内置默认应用不能再新增一份（后端 saveFeishuApp 会 409）：先说清出处，别让用户白填。 */
				const def = feishuApps.find((a) => a.isDefault);
				if (def && id === String(def.appId || "").trim()) {
					setErr("这是 VsSaros助手（内置默认应用）：请在上面的「应用」下拉里直接选「VsSaros助手」，不用新增。");
					return null;
				}
				setBusy("app"); setErr(""); setNotice("");
				try {
					await postJson("/x/agents/api/bindings", {
						actor: { kind: "human" }, action: "feishu-app", appId: id,
						appSecret: secret, name: String(form.newAppName || "").trim(),
					});
					set("newAppId", ""); set("newAppSecret", ""); set("newAppName", "");
					set("appId", id); reload();
					setNotice("✓ 已保存应用 " + id + " 并选用");
					return id;
				} catch (e) {
					setErr(String((e && e.message) || e));
					return null;
				} finally {
					setBusy("");
				}
			};
			/* ★ 只允许「没选平台 / 没填 chat_id / 正在忙」禁用创建按钮；
			   选了「+ 添加新应用」不再禁用（改为点击时自动先保存应用）。 */
			const createDisabled = !!busy || !String(form.chatId || "").trim() || !form.platform;
			/* 显式传 appId：set("appId", id) 是异步的，不能在这一轮闭包里读还没刷新的 form。 */
			const createBody = (appIdOverride) => ({
				action: "create", targetKind: targetKind, targetId: agentId, platform: form.platform,
				...(form.platform === "feishu" && String(appIdOverride ?? form.appId)
					&& String(appIdOverride ?? form.appId) !== "__new__"
					? { appId: String(appIdOverride ?? form.appId) } : {}),
				...(form.platform === "feishu" && groupPolicyOptions.length ? { groupPolicy: groupPolicyValue } : {}),
				chatId: String(form.chatId || "").trim(), chatType: form.chatType, direction: form.direction,
				allowFrom: String(form.allowFrom || "").split(/[,，\n]/).map((s) => s.trim()).filter(Boolean),
			});
			/** 表单行：短标签 + 控件 + 可选 ⓘ（字段说明不再塞进 placeholder）。 */
			const fieldRow = (label, control, tip) => react.createElement("div", { key: "f:" + label, style: B.field }, kids([
				react.createElement("span", { key: "l", style: B.fieldLabel }, label),
				tip || null,
				react.createElement("span", { key: "c", style: { flex: "1 1 auto", minWidth: 0, display: "flex" } }, control),
			]));
			/** ★ 2026-11-10：展开 / 收起某条绑定的就地编辑；draft 从该条绑定回填（没有 GET ?id= 单条接口）。 */
			const toggleEdit = (b) => {
				const id = String(b.id);
				if (expandedId === id) { setExpandedId(""); setEditDraft(null); return; }
				const gp = String(b.groupPolicy || "");
				const d = String(b.direction || "");
				setExpandedId(id);
				setEditDraft({
					chatId: String(b.chatId || ""),
					chatType: b.chatType === "group" ? "group" : "p2p",
					direction: ["both", "in", "out"].indexOf(d) >= 0 ? d : "both",
					groupPolicy: groupPolicyOptions.some((o) => o.value === gp) ? gp
						: String((groupPolicyDef && groupPolicyDef.default) || (groupPolicyOptions[0] && groupPolicyOptions[0].value) || ""),
					appId: String(b.appId || ""),
					allowFrom: Array.isArray(b.allowFrom) ? b.allowFrom.join(", ") : String(b.allowFrom || ""),
				});
			};
			const editSet = (key, value) => setEditDraft((d) => Object.assign({}, d || {}, { [key]: value }));
			/** 保存：bindings 的 update 是**局部更新**，只发允许改的字段；成功后 run() 会 reload() 走 GET。 */
			const saveEdit = (b) => {
				if (!editDraft) { return; }
				const id = String(b.id);
				const chatId = String(editDraft.chatId || "").trim();
				if (!chatId) { setErr("chat_id 不能为空"); return; }
				// ⚠ 绝不回传 targetId / platform / enabled / 派生视图字段；
				//   POST 返回值里的 bindings 未掩码（含明文密钥），一律靠 reload() 重新 GET。
				const editPatch = {
					action: "update", id,
					chatId, chatType: editDraft.chatType, direction: editDraft.direction,
					allowFrom: String(editDraft.allowFrom || "").split(/[,，\n]/).map((s) => s.trim()).filter(Boolean),
				};
				if (String(b.platform) === "feishu") {
					editPatch.appId = String(editDraft.appId || "");
					if (groupPolicyOptions.length && editDraft.groupPolicy) { editPatch.groupPolicy = String(editDraft.groupPolicy); }
				}
				run(editPatch, "edit:" + id);
				setExpandedId(""); setEditDraft(null);
			};
			/** 方案 A：行 1 = 平台 / 状态 / 操作；行 2 = chat_id 摘要 + 标签；点行展开就地编辑。 */
			const rows = mine.map((b) => {
				const id = String(b.id);
				const on = b.enabled !== false;
				const cid = String(b.chatId || "");
				const short = cid.length > 24 ? cid.slice(0, 12) + "…" + cid.slice(-8) : cid;
				const expanded = expandedId === id && !!editDraft;
				const stop = (e) => { try { e.stopPropagation(); } catch { /* 合成事件 */ } };
				const onEdit = (key) => (e) => editSet(key, e && e.target ? e.target.value : "");
				const row = react.createElement("div", {
					key: id, style: B.row, "data-vssaros-botbind-row": id,
					"data-vssaros-botbind-expanded": expanded ? "1" : "0",
					tabIndex: 0, role: "button", "aria-expanded": expanded ? "true" : "false",
					"aria-label": "编辑绑定 " + labelOf(b.platform) + " " + cid,
					onClick: () => toggleEdit(b),
					onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleEdit(b); } },
				}, [
					react.createElement("div", { key: "top", style: B.top, "data-vssaros-botbind-row-top": id }, kids([
						react.createElement("span", { key: "i", style: Object.assign({}, B.ico, on ? null : B.icoOff) }, bindIcon("msg", 14)),
						react.createElement("span", { key: "n", style: B.name }, labelOf(b.platform)),
						// 状态：颜色 + 文字双编码（色盲 / 浅色主题下也能分辨）
						react.createElement("span", { key: "s", style: Object.assign({}, B.chip, on ? B.chipOn : B.chipOff) }, kids([
							react.createElement("span", { key: "d", style: Object.assign({}, B.dot, on ? B.dotOn : null) }),
							on ? "启用" : "停用",
						])),
						react.createElement("span", { key: "sp", style: C.grow }),
						react.createElement("button", {
							key: "t", type: "button", style: B.iconBtn, disabled: !!busy,
							"aria-label": on ? "停用" : "启用", title: on ? "停用" : "启用",
							"data-vssaros-botbind-toggle": id,
							onClick: (e) => { stop(e); run({ action: "update", id, enabled: !on }, "toggle:" + id); },
						}, busy === "toggle:" + id ? bindIcon("refresh", 14) : bindIcon(on ? "pause" : "play", 14)),
						react.createElement("button", {
							key: "d", type: "button", style: Object.assign({}, B.iconBtn, B.iconBtnDanger), disabled: !!busy,
							"aria-label": "删除", title: "删除", "data-vssaros-botbind-delete": id,
							onClick: (e) => {
								stop(e);
								if (window.confirm(targetKind === "group"
								? "删除这条 Channel 绑定？该 IM 会话将不再转投到这个群。"
								: "删除这条 Channel 绑定？该会话将不再路由到这个 Bot。")) {
									run({ action: "delete", id }, "delete:" + id);
								}
							},
						}, bindIcon("trash", 14)),
						// ★ 2026-11-10：明确的展开 / 收起控件（整行也可点）
						react.createElement("button", {
							key: "e", type: "button", style: B.iconBtn, disabled: !!busy,
							"aria-label": expanded ? "收起编辑" : "展开编辑", title: expanded ? "收起编辑" : "展开编辑",
							"data-vssaros-botbind-edit-toggle": id,
							onClick: (e) => { stop(e); toggleEdit(b); },
						}, bindIcon(expanded ? "chevronUp" : "chevronDown", 14)),
					])),
					react.createElement("div", { key: "meta", style: B.meta, "data-vssaros-botbind-row-meta": id }, kids([
						react.createElement("span", { key: "cid", style: B.cid, "data-vssaros-botbind-row-cid": id }, short),
						react.createElement(BotbindTip, { key: "tip", name: "chatid-" + id, label: "完整 chat_id", left: true },
							react.createElement("span", null, cid)),
						react.createElement("span", { key: "t", style: B.chip }, b.chatType === "group" ? "群聊" : "私聊"),
						react.createElement("span", { key: "dir", style: B.chip }, directionLabelOf(b.direction)),
						b.platform === "feishu"
							? react.createElement("span", { key: "app", style: Object.assign({}, B.chip, B.chipBrand) }, appLabel(b.appId || ""))
							: null,
					])),
				]);
				if (!expanded) { return row; }
				const ed = editDraft;
				const editOptions = appOptions.filter((o) => o.value !== "__new__");
				const panel = react.createElement("div", {
					key: "edit:" + id, style: Object.assign({}, B.form, { marginTop: -2, marginBottom: 6,
						padding: "8px 10px", border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
						borderRadius: 7, background: "var(--dsw-alias-bg-layer-1, transparent)", whiteSpace: "normal" }),
					"data-vssaros-botbind-edit": id, onClick: stop,
				}, kids([
					fieldRow("chat_id", input("edit-chatId", ed.chatId, "oc_… / ou_…", undefined, onEdit("chatId")),
						react.createElement(BotbindTip, { key: "t", name: "editChatId", label: "chat_id 说明", left: true },
							hintOf(b.platform) || "飞书群填 oc_…、私聊填 ou_…。")),
					b.platform === "feishu" ? fieldRow("应用", select("edit-appId", ed.appId, editOptions, onEdit("appId"))) : null,
					fieldRow("类型", select("edit-chatType", ed.chatType, [{ value: "group", label: "群聊（需 @ 机器人）" }, { value: "p2p", label: "私聊" }], onEdit("chatType"))),
					b.platform === "feishu" && groupPolicyOptions.length
						? fieldRow("群策略", select("edit-group-policy", ed.groupPolicy, groupPolicyOptions, onEdit("groupPolicy")),
							react.createElement(BotbindTip, { key: "t", name: "editGroupPolicy", label: "群策略说明", left: true },
								"groupPolicy 默认 open：群里仍需 @ 机器人；其余档位按渠道定义。"))
						: null,
					fieldRow("方向", select("edit-direction", ed.direction, [{ value: "both", label: "双向" }, { value: "in", label: "仅入站" }, { value: "out", label: "仅出站" }], onEdit("direction"))),
					fieldRow("白名单", input("edit-allow-from", ed.allowFrom, "userId, userId …", undefined, onEdit("allowFrom")),
						react.createElement(BotbindTip, { key: "t", name: "editAllowFrom", label: "白名单说明", left: true },
							"逗号分隔 userId；留空 = 拒绝所有入站（fail-closed）。")),
					react.createElement("div", { key: "ops", style: { display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 2 } }, kids([
						react.createElement("button", { key: "c", type: "button", style: C.btn, disabled: !!busy,
							"data-vssaros-botbind-edit-cancel": id,
							onClick: (e) => { stop(e); setExpandedId(""); setEditDraft(null); } }, "取消"),
						react.createElement("button", { key: "s", type: "button", style: C.btnPrimary, disabled: !!busy,
							"data-vssaros-botbind-edit-save": id,
							onClick: (e) => { stop(e); saveEdit(b); } }, busy === "edit:" + id ? "保存中…" : "保存"),
					])),
				]));
				return react.createElement(react.Fragment, { key: id }, [row, panel]);
			});
			return react.createElement("div", {
				style: Object.assign({}, C.card, { marginTop: 10 }), "data-vssaros-botbind": agentId,
				"data-vssaros-bind-kind": targetKind,
			}, kids([
				react.createElement("div", { key: "r", style: C.row }, kids([
					react.createElement("span", { key: "t", style: C.title }, "Channel 绑定"),
					react.createElement("span", { key: "b", style: C.badge }, String(mine.length) + " 条"),
					react.createElement(BotbindTip, { key: "help", anchor: "data-vssaros-botbind-help", name: "channel", label: "Channel 绑定说明" }, kids([
						react.createElement("b", { key: "h", style: B.tipTitle }, "Channel 绑定说明"),
						react.createElement("ul", { key: "u", style: B.tipList },
							BOTBIND_HELP.map((s, i) => react.createElement("li", { key: i }, s))),
					])),
					react.createElement("span", { key: "sp", style: C.grow }),
					react.createElement("button", { key: "reload", type: "button", style: B.iconBtn, disabled: !!busy,
						"aria-label": "刷新", title: "刷新", onClick: () => reload() }, bindIcon("refresh", 14)),
				])),
				state.error ? react.createElement("div", { key: "le", style: Object.assign({}, C.err, { marginTop: 6 }) }, "读取失败：" + String(state.error)) : null,
				// ★ 卡片级错误：编辑保存失败时表单已收起，错误仍要看得见（不能只挂在展开的表单里）
				err ? react.createElement("div", { key: "e", style: Object.assign({}, C.err, { marginTop: 6 }) }, err) : null,
				notice ? react.createElement("div", { key: "n", style: Object.assign({}, C.tiny, { marginTop: 6 }),
					"data-vssaros-botbind-notice": "1" }, notice) : null,
				rows.length ? react.createElement("div", { key: "rows", style: B.list }, ...rows) : react.createElement("div", {
					key: "empty", style: Object.assign({}, C.tiny, { marginTop: 6 }),
				}, targetKind === "group" ? "这个群还没有绑定任何会话。" : "这个 Bot 还没有绑定任何会话。"),
				react.createElement("button", {
					key: "new", type: "button", style: B.newToggle,
					"data-vssaros-botbind-new-toggle": "1", onClick: () => setShowNew((v) => !v),
				}, showNew ? "− 收起" : "+ 新建绑定"),
				showNew ? react.createElement("div", { key: "form", style: B.form }, kids([
					fieldRow("平台", select("platform", form.platform, platformOptions)),
					form.platform === "feishu" ? fieldRow("应用", select("appId", form.appId, appOptions)) : null,
					form.platform === "feishu" && form.appId === "__new__"
						? react.createElement("div", { key: "newapp", style: B.form }, kids([
							input("newAppId", form.newAppId, "cli_…（开放平台 → 凭证与基础信息）"),
							input("newAppSecret", form.newAppSecret, "App Secret（只写不读）", "password"),
							input("newAppName", form.newAppName, "名称（可选）"),
							react.createElement("button", {
								key: "addapp", type: "button", style: C.btn,
								"data-vssaros-botbind-add-app": "1", disabled: !!busy, onClick: addApp,
							}, busy === "app" ? "添加中…" : "保存应用并选用"),
							react.createElement("div", { key: "newhint", style: C.tiny },
								"也可以直接点最下面的创建按钮：会先保存这个应用，再创建绑定。内置默认应用请直接在「应用」下拉里选 VsSaros助手。"),
						])) : null,
					fieldRow("chat_id", input("chatId", form.chatId, "oc_… / ou_…"),
						react.createElement(BotbindTip, { key: "t", name: "chatId", label: "chat_id 说明", left: true },
							hintOf(form.platform) || "飞书群填 oc_…、私聊填 ou_…；在「设置 — 渠道」展开飞书管理可复制。")),
					fieldRow("类型", select("chatType", form.chatType, [{ value: "group", label: "群聊（需 @ 机器人）" }, { value: "p2p", label: "私聊" }])),
					form.platform === "feishu" && groupPolicyOptions.length
						? fieldRow("群策略", select("groupPolicy", groupPolicyValue, groupPolicyOptions),
							react.createElement(BotbindTip, { key: "t", name: "groupPolicy", label: "群策略说明", left: true },
								"groupPolicy 默认 open：群里仍需 @ 机器人；其余档位按渠道定义。"))
						: null,
					fieldRow("方向", select("direction", form.direction, [{ value: "both", label: "双向" }, { value: "in", label: "仅入站" }, { value: "out", label: "仅出站" }])),
					fieldRow("白名单", input("allowFrom", form.allowFrom, "userId, userId …"),
						react.createElement(BotbindTip, { key: "t", name: "allowFrom", label: "白名单说明", left: true },
							"逗号分隔 userId；留空 = 拒绝所有入站（fail-closed）。")),
					react.createElement("button", {
						key: "go", type: "button",
						style: Object.assign({}, C.btnPrimary, { marginTop: 6, alignSelf: "flex-end" },
							createDisabled ? { opacity: 0.45, cursor: "not-allowed" } : {}),
						"data-vssaros-botbind-create": "1",
						disabled: createDisabled,
						title: createDisabled ? "先选平台并填 chat_id"
							: (form.platform === "feishu" && form.appId === "__new__" ? "会先保存上面的新应用，再创建绑定" : ""),
						onClick: () => { void (async () => {
							let appId = form.appId;
							/* ★ 选了「+ 添加新应用」⇒ 一步到位：先存应用，再用它的 id 建绑定。
							   addApp 失败已就地写明原因（含内置默认应用不能重复添加），这里直接停。 */
							if (form.platform === "feishu" && appId === "__new__") {
								const saved = await addApp();
								if (!saved) { return; }
								appId = saved;
							}
							run(createBody(appId), "create");
						})(); },
					}, busy === "create" ? "创建中…"
						: (form.platform === "feishu" && form.appId === "__new__" ? "保存应用并创建绑定" : "创建绑定")),
				])) : null,
			]));
		}


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
					(res) => {
						// ★ 2026-11-09：host 回 registered:false 时不能假装保存成功 —— 列表会按 registered 隐藏这个 bot。
						if (res && res.registered === false) {
							setErr("已写入 .agent.md，但 preset 未注册（点了也开不了会话）：" + String(res.syncError || "同步 preset 失败") + "。请稍后重试，或到 Bots 页签 ＋ → 刷新名册");
						} else {
							setNote("已保存到 .agent.md。人设改动对**新会话**生效（已有会话的工具与模型已锁定）。");
						}
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
				// 本地 Agent 引擎徽标：该 Bot 的 .agent.md model 指向本地 CLI 时显示引擎名。
				// 与 badge.js / client.settings.js 同形，check-local-agent-badge.mjs 静态对账。
				(() => {
					const BADGES = { "vssaros-codex-cli": "Codex CLI", "vssaros-claude-code": "Claude Code", "vssaros-opencode": "OpenCode", "vssaros-kimi-cli": "Kimi CLI", "vssaros-hermes-cli": "Hermes Agent", "vssaros-gemini-cli": "Gemini CLI" };
					const value = String(draft.model == null ? "" : draft.model).trim().toLowerCase();
					let badge;
					if (value.indexOf("vssaros-") === 0) {
						const route = value.split("/")[0];
						badge = Object.prototype.hasOwnProperty.call(BADGES, route) ? BADGES[route]
							: (route.indexOf("vssaros-acp-") === 0 ? "自定义 ACP Agent" : undefined);
					}
					return badge ? react.createElement("div", {
						key: "local-agent-badge", "data-vssaros-local-agent-badge": "1",
						style: Object.assign({}, C.tiny, { marginTop: 4 }),
					}, "本地 Agent 引擎：" + badge + "（CLI 自带登录与套餐）") : null;
				})(),
				field("skills", "技能（逗号分隔）", "anysearch, analysis"),
				field("persona", "人设正文（Markdown）", "你就是……", true, 160),
				err ? react.createElement("div", { key: "e", style: Object.assign({}, C.err, { marginTop: 6 }) }, err) : null,
				note ? react.createElement("div", { key: "n", style: Object.assign({}, C.tiny, { marginTop: 6 }) }, note) : null,
				/* ★ 2026-11-10：飞书应用选择并入下面的 Channel 绑定卡，独立的「飞书配置」卡已移除。 */
				react.createElement(BotChannelBindingsCard, { key: "channel-bindings", agentId: agentId }),
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
			// ★ 2026-11-09：官方右栏「群设置」独立页签（用户要求）；失败只影响这一个 tab，
			//   菜单侧有中栏自绘页签兜底。放在最前面 ⇒ 用户点菜单时 open/close API 一定已挂上。
			try { installRightRoomSettings(ctx); } catch { /* 注册失败不拖垮会话视图 */ }
			// ★ 2026-11-10：hero 下的「Bot 设置」右侧栏页签（root overlay，不依赖 session）
			try { installRightBotSettings(ctx); } catch { /* 注册失败只影响这一个页签 */ }
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
		/**
		 * ★ 2026-11-09（用户要求）：「群设置」不再复用会话内的「设置」子页签，改为在
		 *   独立页签里开一整页。页签条由 client.workbenchNav.js 画（自带 ✕），这里的
		 *   页内也放一枚「✕ 关闭」按钮 ⇒ 两种关闭入口都可用。
		 *
		 * 为什么放在本 chunk：RoomSettingsCard 就在这里（群名 / 公告 / 谁来回答 / 成员），
		 *   同源 getJson/postJson 与样式常量都现成 ⇒ 不新建 chunk、不改 PART_CHUNKS、
		 *   不重复实现一份群设置表单 ✓。
		 *
		 * 组件登记到 `window.__vssarosPageComponents`（2026-11-02 已有的组件页签机制）：
		 *   页签 `comp: 'vssaros-room-settings'` + `props.roomId` ⇒ 中栏页签条按 key 取回渲染。
		 */
		const ROOM_SETTINGS_PAGE_COMP = "vssaros-room-settings";
		/**
		 * ★ 2026-11-09 追加（用户：「在右侧栏中，弹出一个独立页展示」）：官方右栏页签。
		 *   `sidebar.right.pane.tab` 是 **session 作用域 + keyed slot**：body 由 kind 派发，
		 *   插件组件拿不到 `navigation.params`（官方 `useTabInfo` 只在 slot 内部可用），
		 *   ⇒ 用 factory 级 `rightRoomTarget` + 自定义事件把 roomId 递给 body。
		 *   `sidebarRight.openTab()` 在无会话在屏时会 throws（service.d.ts 原话 fails loudly）
		 *   ⇒ 打开失败必须返回 false，由 client.workspaces.js 回落中栏自绘页签（不白点）。
		 */
		const ROOM_SETTINGS_RIGHT_KIND = "vssaros-room-settings-right";
		const ROOM_SETTINGS_RIGHT_SLOT = "sidebar.right.pane.tab";
		const ROOM_SETTINGS_TARGET_EVENT = "vssaros-room-settings-target";
		let rightRoomTarget = { roomId: "", name: "" };
		/**
		 * 群设置独立页 / 右栏页签体共用。
		 * ★ 2026-11-10：`embedded=true`（官方右栏页签）⇒ 内联铺满、不铺遮罩、不重复页头，
		 *   与「编辑 Bot」的 RightBotSettingsPane 同形态；中栏独立页仍用 440px 遮罩弹层。
		 */
		function RoomSettingsPage(props) {
			const roomId = String((props && props.roomId) || "");
			const embedded = !!(props && props.embedded);
			const tabId = String((props && props.tabId) || "room-settings:" + roomId);
			const close = () => {
				// 右栏形态：交给宿主 `sidebarRight.close(tab.id)`；中栏形态：关自绘页签。
				if (props && typeof props.onClose === "function") {
					try { props.onClose(tabId); return; } catch { /* 宿主关不掉 ⇒ 还有官方 strip 的 ✕ */ }
				}
				try {
					const fn = typeof window !== "undefined" ? window.__vssarosClosePageTab : null;
					if (typeof fn === "function") { fn(tabId); return; }
				} catch { /* 宿主没暴露 ⇒ 用页签条的 ✕ */ }
				// 兜底：没有关闭 API 时，至少把整列收起（不假装关掉了）
				try { if (typeof window !== "undefined") { window.dispatchEvent(new CustomEvent("vssaros-wb-tabs-change")); } } catch { /* noop */ }
			};
			// embedded 时不再自绘页头：RoomSettingsCard 自带头部 + ✕（避免两个标题 / 两个 ✕）
			const bar = embedded ? null : react.createElement("div", {
				style: { display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
					borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))", flex: "none" },
			}, [
				react.createElement("span", { key: "i", style: { fontSize: 15 } }, "⚙"),
				react.createElement("span", { key: "t", style: { fontSize: 14, fontWeight: 600, flex: "1 1 auto" } }, "群设置"),
				react.createElement("button", {
					key: "x", type: "button", title: "关闭群设置", "aria-label": "关闭群设置",
					"data-vssaros-room-settings-close": tabId, onClick: close,
					style: { border: 0, background: "transparent", cursor: "pointer", fontSize: 16,
						lineHeight: "24px", padding: "0 6px", color: "inherit", opacity: .75 },
				}, "✕"),
			]);
			return react.createElement("div", {
				// ⚠ 锚点挂外层：embedded 时不渲染 bar，守卫仍按它判断「切群后重画了」
				"data-vssaros-room-settings-page": roomId,
				style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0,
					overflow: "auto", background: "var(--dsw-alias-bg-module-platform, transparent)" },
			}, [bar, react.createElement("div", {
				key: "b", style: embedded
					? { flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }
					: { flex: "1 1 auto", minHeight: 0, overflow: "auto", padding: "12px 14px" },
			}, react.createElement(RoomSettingsCard, { key: roomId, roomId, say: props && props.say,
				dialog: !embedded, embedded, onClose: close }))]);
		}

		/**
		 * ★ 2026-11-09：Bot 配置**独立页**（修 hero 下「编辑 Bot」点了没反应）。
		 *
		 * 根因：右栏「设置」页签是 `conversation.view` = session 作用域的 slot，
		 *   hero（"探索未至之境"空会话屏）没有会话在屏 ⇒ 这个 slot 结构上不渲染 ⇒
		 *   SettingsView / useScopePicker 根本没挂载 ⇒ `vssaros:open-bot-config` 事件无人接住，
		 *   `binding(sid).activate` 也对不存在的绑定静默失败。旧实现靠 openSession + 定时器去赌，必然落空。
		 *
		 * 修法：改用中栏独立页签（root/面板级，`__vssarosOpenPageTab`，群设置同款、hero 下已验证可用），
		 *   按 **agentId** 直接渲染 BotConfigCard —— 它自带 `/x/agents/api/agents?id=` 读写，
		 *   不需要 sessionId、不需要 preset 派生、不需要 activate/事件。
		 */
		const BOT_CONFIG_PAGE_COMP = "vssaros-bot-config";
		function BotConfigPage(props) {
			const agentId = String((props && props.agentId) || "");
			const name = String((props && props.name) || agentId);
			const tabId = String((props && props.tabId) || "bot-config:" + agentId);
			const close = () => {
				if (props && typeof props.onClose === "function") {
					try { props.onClose(tabId); return; } catch { /* 回落到自绘页签关闭 */ }
				}
				try {
					const fn = typeof window !== "undefined" ? window.__vssarosClosePageTab : null;
					if (typeof fn === "function") { fn(tabId); return; }
				} catch { /* noop */ }
				try { if (typeof window !== "undefined") { window.dispatchEvent(new CustomEvent("vssaros-wb-tabs-change")); } } catch { /* noop */ }
			};
			const bar = react.createElement("div", {
				style: { display: "flex", alignItems: "center", gap: 8, padding: "10px 14px",
					borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))", flex: "none" },
				"data-vssaros-bot-config-page": agentId,
			}, [
				react.createElement("span", { key: "i", style: { fontSize: 15 } }, "⚙"),
				react.createElement("span", { key: "t", style: { fontSize: 14, fontWeight: 600, flex: "1 1 auto" } },
					"Bot 配置 · " + name.slice(0, 24)),
				react.createElement("button", {
					key: "x", type: "button", title: "关闭 Bot 配置", "aria-label": "关闭 Bot 配置",
					"data-vssaros-bot-config-close": tabId, onClick: close,
					style: { border: 0, background: "transparent", cursor: "pointer", fontSize: 16,
						lineHeight: "24px", padding: "0 6px", color: "inherit", opacity: .75 },
				}, "✕"),
			]);
			return react.createElement("div", {
				style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0,
					overflow: "auto", background: "var(--dsw-alias-bg-module-platform, transparent)" },
			}, [bar, react.createElement("div", { key: "b", style: { flex: "1 1 auto", minHeight: 0, overflow: "auto", padding: "12px 14px" } },
				react.createElement(BotConfigCard, { key: agentId, agentId, say: props && props.say }))]);
		}
		try {
			const w = typeof window !== "undefined" ? window : null;
			if (w) {
				if (!w.__vssarosPageComponents || typeof w.__vssarosPageComponents !== "object") { w.__vssarosPageComponents = {}; }
				w.__vssarosPageComponents[ROOM_SETTINGS_PAGE_COMP] = RoomSettingsPage;
				w.__vssarosPageComponents[BOT_CONFIG_PAGE_COMP] = BotConfigPage;
				// 组件晚于页签条注册 ⇒ 通知页签条重画（workbenchNav 订阅 TAB_CHANGE_EVENT）
				w.dispatchEvent(new CustomEvent("vssaros-wb-tabs-change"));
			}
		} catch { /* 宿主无 window ⇒ 页签条回落 iframe，不留死页签 */ }

		/** 官方右栏页签体：跟着 factory 级目标群重画（切群时 open 侧发事件）。 */
		function RightRoomSettingsPane() {
			const [target, setTarget] = react.useState(rightRoomTarget);
			react.useEffect(() => {
				if (typeof window === "undefined" || typeof window.addEventListener !== "function") { return undefined; }
				const onChange = () => setTarget(Object.assign({}, rightRoomTarget));
				window.addEventListener(ROOM_SETTINGS_TARGET_EVENT, onChange);
				return () => { try { window.removeEventListener(ROOM_SETTINGS_TARGET_EVENT, onChange); } catch { /* noop */ } };
			}, []);
			const close = () => {
				try {
					const fn = typeof window !== "undefined" ? window.__vssarosCloseRightRoomSettings : null;
					if (typeof fn === "function") { fn(); }
				} catch { /* 还有官方 strip 自带的「关闭」 */ }
			};
			const empty = react.createElement("div", {
				style: { padding: "14px", opacity: .7, fontSize: 13 },
				"data-vssaros-right-room-settings-empty": "1",
			}, "从左侧 Bots 页签的群菜单里点「群设置」");
			// ★ 2026-11-10：右栏页签走 embedded 内联（同「编辑 Bot」），不再铺居中遮罩弹层
			return target.roomId
				? react.createElement(RoomSettingsPage, { key: target.roomId, roomId: target.roomId,
					tabId: "right:" + target.roomId, embedded: true, onClose: close })
				: empty;
		}
		/** 注册官方右栏页签（类型 + keyed body），并暴露跨 chunk 的 open / close API。 */
		function installRightRoomSettings(ctx) {
			const noteFail = (tag, e) => {
				try { console.warn("[vssaros] 群设置右栏注册失败（" + tag + "）：" + String((e && e.message) || e)); } catch { /* 无 console */ }
				return null;
			};
			// ① 页签类型（与 client.rightbarBrowser.js 同款；effect 包裹 ⇒ 重复挂载不会把别人拖垮）
			try {
				const registerType = () => {
					const tabs = ctx && ctx.sidebarRightTabs;
					if (tabs && typeof tabs.register === "function") {
						return tabs.register({
							id: ROOM_SETTINGS_RIGHT_KIND, kind: ROOM_SETTINGS_RIGHT_KIND, priority: "extension",
							// thunk：每次用都重读 ⇒ 切群后页签标题跟着变（不写死群名）
							title: () => rightRoomTarget.name ? "群设置 · " + String(rightRoomTarget.name).slice(0, 24) : "群设置",
						});
					}
					return undefined;
				};
				if (ctx && typeof ctx.effect === "function") {
					ctx.effect(() => { const dispose = registerType(); return typeof dispose === "function" ? dispose : undefined; },
						"vssaros-room-settings-right:type");
				} else { registerType(); }
			} catch (e) { noteFail("type", e); }
			// ② 页签体：keyed slot，key 必须等于 tab kind（session 作用域 ⇒ 撞 key 不许外抛）
			try {
				ctx.slots.inject(ROOM_SETTINGS_RIGHT_SLOT, () => {
					try { return ctx.slots.register({ name: ROOM_SETTINGS_RIGHT_SLOT, key: ROOM_SETTINGS_RIGHT_KIND }, RightRoomSettingsPane); }
					catch (e) { return noteFail("body", e); }
				});
			} catch (e) { noteFail("inject", e); }
			// ③ 打开：★ 2026-11-10 纠偏 —— **不再用 `mounted.getSnapshot()` 预判**。
			//   那是本仓测试桩自造的口径，误杀了 hero 的 blank session；真机 hero 下官方「开始」
			//   guide 就渲染在 `sidebar.right.pane.tab`，右栏 seat 是挂载着的。
			//   官方 `require()` 只会在「全局工作台面板占住 main / store 尚未 minted」时抛
			//   ⇒ 同步 try `openTab`，抛了才返回 false 让菜单回落；绝不异步吞异常（会「点了没反应」）。
			const openRight = (sid, name) => {
				const sr = ctx && ctx.sidebarRight;
				if (!sr || typeof sr.openTab !== "function") { return false; }
				// 先设 target + 派事件：即便下面 openTab 失败，title / body 也已是这次点的群，
				// 回落中栏后不会串到上一次的目标。
				rightRoomTarget = { roomId: String(sid || ""), name: String(name || "") };
				// 用 `w.CustomEvent || globalThis.CustomEvent`：老宿主 / jsdom 里裸 `new CustomEvent`
				// 可能抛 ReferenceError ⇒ 事件发不出去 ⇒ 已挂载的页签体不重画（一直显示上一次的群）。
				try {
					const w = typeof window !== "undefined" ? window : null;
					const Ctor = w && (w.CustomEvent || (typeof CustomEvent !== "undefined" ? CustomEvent : null));
					if (Ctor) { w.dispatchEvent(new Ctor(ROOM_SETTINGS_TARGET_EVENT)); }
				} catch { /* noop */ }
				try { sr.openTab(ROOM_SETTINGS_RIGHT_KIND); } catch { return false; }
				// `openTab` 官方自带展开（service.d.ts）；用户点击后再点一次展开按钮只作可见性兜底，
				// 绝不在入口启动时自动展开（会播种多余「开始」页并按 session 持久化）。
				const expand = typeof document !== "undefined" ? document.querySelector("[data-sidebar-right-expand]") : null;
				if (expand && typeof expand.click === "function") { try { expand.click(); } catch { /* noop */ } }
				return true;
			};
			const closeRight = () => {
				const sr = ctx && ctx.sidebarRight;
				if (!sr || typeof sr.close !== "function") { return false; }
				let tabId = "";
				try { const active = typeof sr.active === "function" ? sr.active() : null; tabId = active && active.id ? String(active.id) : ""; } catch { /* noop */ }
				if (!tabId) { return false; }
				try { sr.close(tabId); return true; } catch { return false; }
			};
			try {
				const w = typeof window !== "undefined" ? window : null;
				if (w) { w.__vssarosOpenRightRoomSettings = openRight; w.__vssarosCloseRightRoomSettings = closeRight; }
			} catch { /* window 不可写 */ }
			return { openRight, closeRight };
		}

		// ── ★ 2026-11-10：「Bot 设置」**官方右栏页签**（可关闭，与「开始」并列）──────────
		// 用户要求：hero 下右侧栏里单独一个带 ✕ 的**页签**，不是覆盖式浮层。
		// ⚠ 纠偏：上一轮把「conversation.view 设置页签在 hero 不渲染」误推成「右栏 session
		//   槽在 hero 不渲染」，自绘了 shell.overlay + position:fixed 浮层（盖住官方 strip）。
		//   真机 hero 下官方「开始」guide 就渲染在 `sidebar.right.pane.tab` ⇒ 该槽可用。
		// ⇒ 走官方两段式：`sidebarRightTabs.register`（类型）+ keyed body（内容）+
		//   `sidebarRight.openTab(kind)`；官方 DockLayout strip 自带 ✕，
		//   「开始」是 sole docked guide 永不关 ⇒ 天然与设置页签并列。
		const BOT_SETTINGS_RIGHT_KIND = "vssaros-bot-settings-right";
		const BOT_SETTINGS_RIGHT_SLOT = "sidebar.right.pane.tab";
		const BOT_SETTINGS_TARGET_EVENT = "vssaros-bot-settings-target";
		let rightBotTarget = { botId: "", name: "" };
		/** 设目标 + 派事件：已挂载的 body 跟着重画（切 Bot 时不停在第一次点的那个）。 */
		function setRightBotTarget(next) {
			rightBotTarget = next;
			try {
				const w = typeof window !== "undefined" ? window : null;
				const Ctor = w && (w.CustomEvent || (typeof CustomEvent !== "undefined" ? CustomEvent : null));
				if (Ctor) { w.dispatchEvent(new Ctor(BOT_SETTINGS_TARGET_EVENT)); }
			} catch { /* 老宿主 / jsdom 裸 CustomEvent 可能抛 */ }
		}
		/** 官方右栏页签体：工厂级 target 驱动；页头 ✕ 是官方 strip 之外的页内入口。 */
		function RightBotSettingsPane() {
			const [target, setTarget] = react.useState(rightBotTarget);
			react.useEffect(() => {
				if (typeof window === "undefined" || typeof window.addEventListener !== "function") { return undefined; }
				const onChange = () => setTarget(Object.assign({}, rightBotTarget));
				window.addEventListener(BOT_SETTINGS_TARGET_EVENT, onChange);
				return () => { try { window.removeEventListener(BOT_SETTINGS_TARGET_EVENT, onChange); } catch { /* noop */ } };
			}, []);
			const close = () => {
				// 先让官方 strip 关掉这个页签（guide 不会被关），再清本地目标
				try {
					const fn = typeof window !== "undefined" ? window.__vssarosCloseRightBotSettings : null;
					if (typeof fn === "function") { fn(); }
				} catch { /* 还有官方 strip 自带的 ✕ */ }
				setRightBotTarget({ botId: "", name: "" });
				setTarget({ botId: "", name: "" });
			};
			const empty = react.createElement("div", {
				style: { padding: 14, opacity: .7, fontSize: 13 },
				"data-vssaros-right-bot-settings-empty": "1",
			}, "从左侧 Bots 页签的菜单里点「编辑 Bot」");
			if (!target.botId) { return empty; }
			const bar = react.createElement("div", {
				key: "h", "data-vssaros-right-bot-settings-tab": target.botId,
				style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", flex: "none",
					borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))",
					background: "var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08))" },
			}, [
				react.createElement("span", { key: "i", style: { fontSize: 14 } }, "⚙"),
				react.createElement("span", { key: "t", style: { flex: "1 1 auto", fontWeight: 600, fontSize: 12.5,
					overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
					"Bot 设置 · " + String(target.name || target.botId).slice(0, 24)),
				react.createElement("button", {
					key: "x", type: "button", title: "关闭 Bot 设置", "aria-label": "关闭 Bot 设置",
					"data-vssaros-right-bot-settings-close": target.botId, onClick: close,
					style: { border: 0, background: "transparent", cursor: "pointer", fontSize: 15,
						lineHeight: "22px", padding: "0 6px", color: "inherit", opacity: .8 },
				}, "✕"),
			]);
			return react.createElement("div", {
				key: "pane", "data-vssaros-right-bot-settings": target.botId,
				style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0,
					overflow: "auto", background: "var(--dsw-alias-bg-module-platform, transparent)" },
			}, [bar, react.createElement("div", {
				key: "b", style: { flex: "1 1 auto", minHeight: 0, overflow: "auto", padding: "12px 14px" },
			}, react.createElement(BotConfigCard, { key: target.botId, agentId: target.botId }))]);
		}
		/** 注册官方右栏页签（类型 + keyed body）并暴露跨 chunk 的 open / close API。 */
		function installRightBotSettings(ctx) {
			// ① 类型：id === kind ⇒ keyed body 的 key 直接用它（tab-registry.d.ts）
			try {
				const registerType = () => {
					const tabs = ctx && ctx.sidebarRightTabs;
					if (tabs && typeof tabs.register === "function") {
						return tabs.register({
							id: BOT_SETTINGS_RIGHT_KIND, kind: BOT_SETTINGS_RIGHT_KIND, priority: "extension",
							// thunk：切 Bot 后页签标题跟着变
							title: () => rightBotTarget.name ? "Bot 设置 · " + String(rightBotTarget.name).slice(0, 24) : "Bot 设置",
						});
					}
					return undefined;
				};
				if (ctx && typeof ctx.effect === "function") {
					ctx.effect(() => { const d = registerType(); return typeof d === "function" ? d : undefined; },
						"vssaros-bot-settings-right:type");
				} else { registerType(); }
			} catch { /* 注册失败不拖垮会话视图 */ }
			// ② keyed body：与群设置不同 kind ⇒ 两个页签互不覆盖
			try {
				ctx.slots.inject(BOT_SETTINGS_RIGHT_SLOT, () => {
					try { return ctx.slots.register({ name: BOT_SETTINGS_RIGHT_SLOT, key: BOT_SETTINGS_RIGHT_KIND }, RightBotSettingsPane); }
					catch { return null; }
				});
			} catch { /* 撞 key 不外抛 */ }
			// ③ 打开：同步 try openTab，官方 require() 抛了才返回 false 让菜单回落（不用 mounted 预判）
			const openRight = (botId, name) => {
				const id = String(botId || "").trim();
				if (!id) { return false; }
				const sr = ctx && ctx.sidebarRight;
				if (!sr || typeof sr.openTab !== "function") { return false; }
				setRightBotTarget({ botId: id, name: String(name || id) });
				try { sr.openTab(BOT_SETTINGS_RIGHT_KIND); } catch { return false; }
				const expand = typeof document !== "undefined" ? document.querySelector("[data-sidebar-right-expand]") : null;
				if (expand && typeof expand.click === "function") { try { expand.click(); } catch { /* noop */ } }
				return true;
			};
			const closeRight = () => {
				setRightBotTarget({ botId: "", name: "" });
				const sr = ctx && ctx.sidebarRight;
				if (!sr || typeof sr.close !== "function") { return false; }
				let tabId = "";
				try { const active = typeof sr.active === "function" ? sr.active() : null; tabId = active && active.id ? String(active.id) : ""; } catch { /* noop */ }
				if (!tabId) { return false; }
				try { sr.close(tabId); return true; } catch { return false; }
			};
			try {
				const w = typeof window !== "undefined" ? window : null;
				if (w) { w.__vssarosOpenRightBotSettings = openRight; w.__vssarosCloseRightBotSettings = closeRight; }
			} catch { /* window 不可写 ⇒ 菜单侧回落中栏独立页 */ }
			return { openRight, closeRight };
		}

		exports.__test = {
			ROOM_SETTINGS_RIGHT_KIND, ROOM_SETTINGS_RIGHT_SLOT, ROOM_SETTINGS_TARGET_EVENT,
			RightRoomSettingsPane, installRightRoomSettings,
			rightRoomTargetOf: () => Object.assign({}, rightRoomTarget),
			SLOT, IDS, ORDERS, OFFICIAL,
			isAgentPreset, agentIdOf, cwdOf, isUnder, rootOptionsFor, parseMemory, sizeLabel, explainLoadError, TODO_GROUPS,
			MemoryModuleCard, MEM_GROUPS, SettingsView,
			// ★ 2026-11-05 多 bot 群聊：群标记 / 工具结果解析 / 设置改动 / 两个组件
			ROOM_SETTINGS_PAGE_COMP, RoomSettingsPage,
			// ★ 2026-11-10 方案 A：Channel 绑定卡导出供真实渲染桩单测
			BotChannelBindingsCard, BOTBIND_HELP,
			// ★ 2026-11-09：Bot 配置独立页（中栏回落）
			BOT_CONFIG_PAGE_COMP, BotConfigPage,
			// ★ 2026-11-10：hero 下「编辑 Bot」的官方右栏设置页签（strip 自带 ✕，可关闭）
			BOT_SETTINGS_RIGHT_KIND, BOT_SETTINGS_RIGHT_SLOT, BOT_SETTINGS_TARGET_EVENT,
			RightBotSettingsPane, installRightBotSettings,
			rightBotTargetOf: () => Object.assign({}, rightBotTarget),
			ROOM_PROJECTION_KEY, ROOM_RELAY_TOOL, ROOMS_API, roomMarkOfSession, parseRelayResult, roomPatch, RoomSettingsCard, GroupRelayView,
			// ★ 2026-11-05 第一批：状态节点 + 只读 MemberDock
			GROUP_PROGRESS_EVENT, GROUP_DOCK_VISIBILITY_EVENT, MEMBER_DOCK_SLOT, MEMBER_DOCK_ID, MEMBER_DOCK_ORDER, statusNodeText, groupComposerFlowOf, GroupMemberDock,
			askDraftResult, askRecommendedAnswers, GroupAsks,
			GROUP_ROUND_LABELS, groupRoundStatus, RELAY_LOST_AFTER, groupComposerHintOf, isHostInterruptedResult,
			// ★ 2026-11-06：群回复的 Markdown 渲染
			markdownNodes,
		};
		return module.exports;
	},
});
