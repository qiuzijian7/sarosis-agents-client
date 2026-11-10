// @vssaros/chat-surface — 设置 → 渠道（**F1 布局：表 + 行内手风琴**，2026-10-27 重设计）
//
// ── 为什么是这个形状 ──────────────────────────────────────────────────────
// dsh 设置弹窗总宽 620px，左导航占 128px ⇒ **内容区只有约 492px**。
// 所以：主表只能 5 列（平台 / 状态 / 绑定 / 待批 / 失败），
//       详情**在该行下方展开**（不跳页、不开抽屉、不做左右分栏）。
//
// 三条刻意的取舍（都是踩过的坑）：
//   ① **一次只展开一行**（手风琴）：492px 下同时展开两行会把列表顶出视野
//   ② 「入站」不占独立块，压成展开区顶部**一行工具条** —— 否则展开一个平台
//      就看不到其它平台了（第一版 mockup 实测）
//   ③ 展开区里的四块**按平台过滤**：绑定 / 待批准 / 最近失败 / 最近会话
//      以前是全局混在一张表里，用户在飞书行展开却看到 telegram 的失败记录
//
// ── 与后端的契约（不变）──────────────────────────────────────────────────
//   GET  /x/agents/api/bindings → { channels, channelDefs, bindings, inbounds,
//                                   pairings, deadLetters, recentChats,
//                                   feishuApps, inbounds.feishuApps（2026-11-04 多飞书应用）}
//   POST 同上 { action: 'inbound-start'|'inbound-stop'|'credentials'|'pairing-approve'|'dead-letters-clear'
//               |'feishu-app'（增改/删额外飞书应用）, ... }；飞书启停可带 `appId`（空 = 默认应用）
//
// ⚠ 分区壳必须用 `props.renderSlot(...)` 渲染子槽（写成 `props.children` ⇒ 导航项在、内容空白，
//   2026-10-27 真机踩过；`check-chat-surface-chunks.mjs` 第 ⑦ 条守着这条）。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.channel.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		const el = react.createElement;

	const SLOT_SECTION = "settings.section";
	const SLOT_ITEM = "settings.vssaros.channel.item";
	const SECTION_ID = "vssaros-channel";
	/* ★ 2026-11-09（用户报「渠道 → 绑定 → 去 Bots 配置 ⇒ 白屏」）：
	   Bots 工作台的 SSR 页面在 2026-11-03 已整体下线，Host 对该页面路径直接回 404。
	   旧实现把整页导航过去 ⇒ 白屏。现在 Bots 配置在聊天框侧栏「Bots」页签，
	   交接统一走 vssaros:open-bots 事件（监听方 client.workspaces.js，与欢迎卡 / 胶囊同口径）。
	   ⚠ 只删「页面路由」，下面的 API 前缀仍由 agents 插件提供，别一起动。 */
	const API = "/x/agents/api/bindings";

	const SOURCE_LABEL = {
		dsh: "本机 dsh 设置",
		config: "IDE 设置（兼容回落）",
		env: "环境变量",
	};

	/* ── 样式：全部走令牌 + 回退（裸色值不随主题切换）───────────────────── */
	const S = {
		wrap: { display: "flex", flexDirection: "column", gap: 10, minWidth: 0 },
		head: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" },
		h2: { margin: 0, fontSize: 14, fontWeight: 600 },
		sp: { flex: 1 },
		kpis: { display: "flex", gap: 5, flexWrap: "wrap" },
		kpi: {
			fontSize: 10.5, padding: "1px 7px", borderRadius: 999,
			border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))",
			background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08))",
			display: "flex", gap: 4, alignItems: "center",
		},
		btn: {
			font: "inherit", fontSize: 11, padding: "3px 9px", borderRadius: 6, cursor: "pointer",
			border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))",
			background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.1))",
			color: "inherit",
		},
		btnPrimary: {
			font: "inherit", fontSize: 11, padding: "3px 9px", borderRadius: 6, cursor: "pointer",
			border: "1px solid transparent", background: "var(--dsw-alias-brand-primary, #4c9aff)",
			color: "#fff", fontWeight: 600,
		},
		btnGhost: {
			font: "inherit", fontSize: 11, padding: "3px 9px", borderRadius: 6, cursor: "pointer",
			border: "1px solid transparent", background: "transparent", color: "inherit", opacity: 0.85,
		},
		table: { width: "100%", borderCollapse: "collapse", fontSize: 11.5, tableLayout: "auto" },
		th: {
			textAlign: "left", fontWeight: 600, fontSize: 10, padding: "5px 7px", whiteSpace: "nowrap",
			color: "var(--dsw-alias-label-tertiary, rgba(127,127,127,.95))",
			background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.06))",
			borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.26))",
		},
		td: {
			padding: "7px 7px", fontSize: 11.5, verticalAlign: "middle",
			borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.16))",
		},
		num: { textAlign: "right", fontVariantNumeric: "tabular-nums" },
		row: { cursor: "pointer" },
		rowOpen: { background: "var(--dsw-alias-bg-module-platform, rgba(76,154,255,.1))" },
		caret: { textAlign: "center", fontSize: 9, opacity: 0.6, width: 14 },
		detail: { padding: 0, background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.05))" },
		toolbar: {
			display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", padding: "6px 8px",
			borderBottom: "1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.24))",
			fontSize: 10.5, color: "var(--dsw-alias-label-tertiary, rgba(127,127,127,.95))",
		},
		dot: { width: 6, height: 6, borderRadius: "50%", flex: "none" },
		blocks: { display: "flex", flexDirection: "column", gap: 6, padding: "8px 8px 9px" },
		card: {
			border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.26))",
			borderRadius: 7, overflow: "hidden",
			background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.04))",
		},
		cap: {
			display: "flex", alignItems: "center", gap: 6, padding: "4px 8px",
			background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.1))",
			borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22))",
			fontSize: 10.5, fontWeight: 600,
		},
		cnt: {
			fontSize: 9.5, padding: "0 5px", borderRadius: 999, fontVariantNumeric: "tabular-nums",
			background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.18))",
			color: "var(--dsw-alias-label-secondary, inherit)",
		},
		fld: {
			display: "grid", gridTemplateColumns: "52px minmax(0,1fr)", gap: "4px 7px",
			padding: "6px 8px", alignItems: "center", fontSize: 10.5,
		},
		lbl: { color: "var(--dsw-alias-label-secondary, rgba(127,127,127,.95))" },
		input: {
			font: "inherit", fontSize: 10.5, padding: "3px 6px", borderRadius: 5, minWidth: 0,
			border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))",
			background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.08))",
			color: "inherit",
		},
		p: { margin: 0, fontSize: 11, lineHeight: 1.55 },
		small: { fontSize: 10, opacity: 0.75 },
		code: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 10 },
		badge: { fontSize: 9.5, padding: "0 5px", borderRadius: 999 },
	};

	const toneColor = (tone) => {
		if (tone === "ok") { return "var(--dsw-alias-state-success-primary, #3fb950)"; }
		if (tone === "warn") { return "var(--dsw-alias-state-warn-label, #d29922)"; }
		if (tone === "err") { return "var(--dsw-alias-state-error-primary, #f85149)"; }
		return undefined;
	};

	/**
	 * ★ 2026-11-09（用户报「点保存没反馈，输入的 App ID / Secret 没地方看」）：
	 * GET /x/agents/api/bindings 的 channels 数组是 describePlatforms() 的掩码视图 ——
	 * 非 secret 字段在 fields 对象里（打码），secret 只有平台级 hasSecret。
	 * 旧 UI 读的是 describeFeishu() 兼容视图才有的字段（这里恒 undefined）
	 * ⇒ 明明配好了也只显示「已配置 ·  · 来源」，用户看不到自己填了什么 ✗。
	 * ⚠ secret 明文**永不由接口返回**，这里也绝不拼明文，只报「已配置」。
	 */
	function credsSummaryOf(view, defFields) {
		const fields = (view && view.fields) || {};
		const parts = [];
		let hasSecretField = false;
		for (const f of defFields || []) {
			if (f.type === "select") { continue; }
			if (f.secret || f.type === "password") { hasSecretField = true; continue; }
			const val = String(fields[f.key] || "").trim();
			parts.push(String(f.label || f.key) + "：" + (val || "未配置"));
		}
		if (hasSecretField) {
			parts.push("密钥：" + (view && view.hasSecret ? "已配置（明文不回显）" : "未配置"));
		}
		return parts.join(" · ");
	}

	/* ── 状态文案（一处定义，表和工具条共用）────────────────────────────── */
	function statusOf(def, ch, inb) {
		if (!def.implemented) { return { text: "未接入", tone: "" }; }
		if (!ch.configured) { return { text: "未配置", tone: "" }; }
		/* 企业微信是**被动回调**（企业微信服务器来连我们）：没有「启动入站」这一步，
		   所以状态也不能报「未启动」—— 那会让人反复找一个不存在的按钮。 */
		if (def.inboundMode === "callback") { return { text: "已配置 · 等回调", tone: "" }; }
		const st = String((inb && inb.status) || "idle");
		if (st === "ready") { return { text: "已连接", tone: "ok" }; }
		if (st === "connecting") { return { text: "连接中…", tone: "warn" }; }
		if (st === "error") {
			/* ★ 2026-10-27 真机反馈：`unavailable`（缺依赖 / 缺凭据）是**不可恢复**的，
			   后端已不再重试（attempts 为 0）。这里再显示"第 0 次重试"会让用户以为在等就行。 */
			const n = Number((inb && inb.attempts) || 0);
			return n > 0
				? { text: "失败（第 " + String(n) + " 次重试）", tone: "err" }
				: { text: "无法启动（需处理）", tone: "err" };
		}
		if (st === "stopped") { return { text: "已停止", tone: "" }; }
		return { text: "未启动", tone: "warn" };
	}

	function inboundKindOf(def) {
		/* 传输方式由 imPlatforms 的 `inboundMode / inboundLabel` 声明（单一真源）。
		   按 key 硬编码时，discord 一接进来就显示空、企业微信还会凭空多出「启动入站」。 */
		if (!def) { return ""; }
		if (def.inboundLabel) { return String(def.inboundLabel); }
		if (def.inboundMode === "ws") { return "WS 长连接"; }
		if (def.inboundMode === "poll") { return "HTTP 长轮询"; }
		if (def.inboundMode === "callback") { return "被动回调"; }
		return "";
	}

	/** 有没有「启动入站」这一步（被动回调的没有）。老 Host 不带 inboundMode ⇒ 按已知平台回落。 */
	function startableOf(def) {
		if (!def) { return false; }
		if (def.inboundMode) { return def.inboundMode === "ws" || def.inboundMode === "poll"; }
		return def.key === "feishu" || def.key === "telegram" || def.key === "discord";
	}

	function ChannelPanel() {
		/**
		 * ★ 2026-11-04 多飞书应用：额外应用（不是默认那个）的连接状态。
		 * 数据来自 `inbounds.feishuApps[appId]`（与默认应用的网关同形：status / lastError / lastEventAt）。
		 */
		const appStatusOf = (inb) => {
			const s = String((inb && inb.status) || "idle");
			if (s === "ready") { return { text: "已连接", tone: "ok", active: true }; }
			if (s === "connecting") { return { text: "连接中…", tone: "warn", active: true }; }
			if (s === "error") { return { text: "失败", tone: "err", active: false }; }
			return { text: "未启动", tone: "", active: false };
		};
		const [state, setState] = react.useState({ status: "loading", data: null, error: "", busy: "", ok: "" });
		/** 各平台草稿：`{ [platform]: { [fieldKey]: value } }`（secret 不回填 ⇒ 留空 = 不改）。 */
		const [drafts, setDrafts] = react.useState({});
		/** 手风琴：一次只展开一个平台（'feishu' / 'telegram' / ... / ''）。 */
		const [open, setOpen] = react.useState("feishu");
		/** 「去 Bots 配置」的就地反馈（交接有没有人接住，都必须给用户明确指引，不静默）。 */
		const [botsHint, setBotsHint] = react.useState("");
		/** 凭据 / 额外飞书应用保存的**就地**反馈：全局 ok/error 在页面最底部 ⇒ 看着像「点了没反应」。 */
		const [credFeedback, setCredFeedback] = react.useState(null);
		const [appFeedback, setAppFeedback] = react.useState(null);

		const load = react.useCallback(() => {
			setState((s0) => ({ ...s0, status: "loading" }));
			fetch(API, { headers: { "cache-control": "no-cache" } })
				.then((r) => r.json().then((j) => ({ ok: r.ok, j })))
				.then(({ ok, j }) => {
					if (!ok) { throw new Error((j && j.error) || "HTTP"); }
					setState((s0) => ({ ...s0, status: "ready", data: j, error: "" }));
				})
				.catch((e) => setState({ status: "error", data: null, error: String((e && e.message) || e), busy: "", ok: "" }));
		}, []);

		react.useEffect(() => { load(); }, [load]);

		const post = (body, busyKey, okText, onResult) => {
			setState((s0) => ({ ...s0, busy: busyKey, ok: "", error: "" }));
			fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
				.then((r) => r.json().then((j) => ({ ok: r.ok, j })))
				.then(({ ok, j }) => {
					if (!ok || (j && j.error)) { throw new Error((j && j.error) || "HTTP"); }
					setState((s0) => ({ ...s0, busy: "", ok: okText || "" }));
					load();
					/* ★ 2026-11-09：把 POST 回包交给调用方做**就地**反馈（掩码视图，无 secret 明文）。 */
					if (onResult) { onResult({ ok: true, view: j }); }
				})
				.catch((e) => {
					setState((s0) => ({ ...s0, busy: "", error: String((e && e.message) || e) }));
					if (onResult) { onResult({ ok: false, error: String((e && e.message) || e) }); }
				});
		};

		/**
		 * 按平台启停入站。
		 * ⚠ `busy` 用 `action:platform` 作键 —— 否则点飞书的「启动」会把别的平台那行也变灰。
		 */
		const actPlatform = (action, platform) => post({ action, platform }, action + ":" + platform, "");

		/**
		 * 保存某平台凭据（写 dsh 侧 `<dataRoot>/agent-im-accounts.json`）。
		 * 留空的字段**不发**（服务端视为"不改"）⇒ 只改 appId 不会把 secret 清掉。
		 */
		const savePlatform = (platform, form, defFields) => {
			const payload = { action: "credentials", platform };
			for (const k of Object.keys(form || {})) {
				const val = String(form[k] == null ? "" : form[k]).trim();
				if (val) { payload[k] = val; }
			}
			setCredFeedback({ platform, status: "saving", text: "正在保存…" });
			post(payload, "credentials", "已保存（dsh 侧）：" + platform, (r) => {
				setCredFeedback({
					platform,
					status: r.ok ? "ok" : "err",
					text: r.ok ? "已保存到本机 dsh · " + credsSummaryOf(r.view, defFields) : "保存失败：" + r.error,
					view: r.ok ? r.view : null,
				});
			});
			setDrafts((d0) => ({ ...d0, [platform]: {} }));
		};

		/** 批准配对码（只写 DM 白名单，不碰群权限）。 */
		const approvePair = (code, platform) => post({ action: "pairing-approve", code, platform }, "pairing", "");

		/**
		 * 测试发送（2026-10-27）：用**真实适配器**给这条绑定发一条消息。
		 *
		 * ⚠ 服务端在"发不出去"时也回 200（`ok:false` + detail）—— 发送失败不是协议错误。
		 *   所以这里必须看 `j.ok`，不能只看 HTTP 状态码。
		 */
		const testOne = (id) => {
			setState((s0) => ({ ...s0, busy: "test:" + id, ok: "", error: "" }));
			fetch(API, {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "test", id }),
			})
				.then((r) => r.json().then((j) => ({ ok: r.ok, j })))
				.then(({ ok, j }) => {
					if (!ok || (j && j.error)) { throw new Error((j && j.error) || "HTTP"); }
					const detail = String(j.detail || j.reason || "");
					setState((s0) => ({
						...s0, busy: "",
						ok: j.ok ? ("✓ 测试消息已发出 · " + detail) : ("✗ 测试失败 · " + detail),
					}));
				})
				.catch((e) => setState((s0) => ({ ...s0, busy: "", ok: "✗ 测试失败 · " + String((e && e.message) || e) })));
		};

		/**
		 * ★ 2026-11-09：「去 Bots 配置」改走事件交接。
		 * 旧实现把整页导航到已下线的 Bots SSR 工作台（2026-11-03 下线）⇒ Host 回 404
		 * ⇒ 用户看到白屏。
		 * 现在与欢迎卡 / 胶囊逐字同口径：派发 vssaros:open-bots，由侧栏 Bots 页签切页签；
		 * 监听方会回填 handled 标记（窄轨形态没有可切的页签 ⇒ 不回填）。
		 * 两种情况都**就地给明确指引**：绝不整页导航、绝不静默。
		 */
		const handoffBots = () => {
			const detail = { action: "view", from: "channel", handled: false };
			try {
				if (typeof window !== "undefined" && typeof window.CustomEvent === "function") {
					window.dispatchEvent(new window.CustomEvent("vssaros:open-bots", { detail }));
				}
			} catch { /* 老环境没有 CustomEvent ⇒ 走下面的文字指引 */ }
			setBotsHint(detail.handled
				? "已切到左侧栏「Bots」页签；关闭本设置窗口即可查看 / 编辑 Bot 配置。"
				: "当前窗口没有可切换的 Bots 页签：请展开左侧栏 →「Bots」页签查看 / 编辑 Bot。");
		};

		const d = state.data || {};
		const defs = Array.isArray(d.channelDefs) ? d.channelDefs : [];
		const channels = Array.isArray(d.channels) ? d.channels : [];
		const bindings = Array.isArray(d.bindings) ? d.bindings : [];
		const pairings = Array.isArray(d.pairings) ? d.pairings : [];
		const dlItems = (d.deadLetters && Array.isArray(d.deadLetters.items)) ? d.deadLetters.items : [];
		const recentChats = Array.isArray(d.recentChats) ? d.recentChats : [];
		const inbounds = d.inbounds || {};
		/* 2026-11-04：全部飞书应用（默认在前，`isDefault`）+ 额外应用各自的连接状态 */
		const feishuApps = Array.isArray(d.feishuApps) ? d.feishuApps : [];
		const extraApps = feishuApps.filter((a) => a && !a.isDefault);
		const appInbounds = (inbounds && inbounds.feishuApps) || {};
		const appLabel = (id) => {
			const a = feishuApps.find((x) => x && x.appId === id);
			return a && a.name ? a.name + " · " + id : String(id || "");
		};

		const statusOf2 = (key) => channels.find((c) => c && c.key === key) || {};
		const bindingsOf = (key) => bindings.filter((b) => String(b.platform || "") === key);
		const pairingsOf = (key) => pairings.filter((p) => String(p.platform || "") === key);
		const dlqOf = (key) => dlItems.filter((x) => String(x.platform || "") === key);
		const recentOf = (key) => recentChats.filter((r) => String(r.platform || "") === key);

		/* 全局 KPI：一眼数清异常（D 的可数性，压成一行） */
		const connected = defs.filter((x) => statusOf(x, statusOf2(x.key), inbounds[x.key]).tone === "ok").length;
		const headNode = el("div", { style: S.head },
			el("h2", { style: S.h2 }, "渠道"),
			el("span", { style: S.sp }),
			el("button", { type: "button", style: S.btnGhost, "data-vssaros-channel-act": "reload", onClick: load }, "刷新"));

		const kpiNode = el("div", { style: S.kpis },
			el("span", { style: S.kpi }, el("span", { style: { color: toneColor("ok") } }, "已连接 "), el("b", null, String(connected))),
			el("span", { style: S.kpi }, "待批准 ", el("b", { style: { color: pairings.length ? toneColor("warn") : undefined } }, String(pairings.length))),
			el("span", { style: S.kpi }, "失败 ", el("b", { style: { color: dlItems.length ? toneColor("err") : undefined } }, String(dlItems.length))),
			el("span", { style: S.kpi }, "绑定 ", el("b", null, String(bindings.length))));

		/* ── 展开区（按平台过滤的四块）──────────────────────────────────── */
		const detailBlocks = (def) => {
			const key = def.key;
			const ch = statusOf2(key);
			const inb = inbounds[key] || null;
			const st = statusOf(def, ch, inb);
			const form = drafts[key] || {};
			const setField = (k, v) => setDrafts((d0) => ({ ...d0, [key]: { ...(d0[key] || {}), [k]: v } }));
			const bList = bindingsOf(key);
			const pList = pairingsOf(key);
			const fList = dlqOf(key);
			const rList = recentOf(key);

			const blocks = [];

			/* ① 凭据（按 channelDefs 的字段渲染；未接入不给表单 —— 填了不生效） */
			if (def.implemented) {
				const flds = def.fields || [];
				const chFields = (ch && ch.fields) || {};
				const fb = (credFeedback && credFeedback.platform === key) ? credFeedback : null;
				/* ★ 刚保存成功的回包优先：load() 还没回来时也能立刻看到掩码值（不是等下一次刷新）。 */
				const shown = (fb && fb.status === "ok" && fb.view) ? fb.view : ch;
				const currentLine = credsSummaryOf(shown, flds);
				blocks.push(el("div", { style: S.card, "data-vssaros-channel-creds": String(ch.source || "none") },
					el("div", { style: S.cap }, el("span", null, "凭据"), el("span", { style: S.sp }),
						el("button", {
							type: "button", style: S.btnPrimary, "data-vssaros-channel-act": "credentials",
							disabled: !!state.busy || !flds.length,
							onClick: () => savePlatform(key, form, flds),
						}, state.busy === "credentials" ? "保存中…" : "保存")),
					el("div", { style: S.fld },
						flds.map((f) => [
							el("label", { key: "l" + f.key, style: S.lbl }, String(f.label || f.key)),
							// ★ 2026-10-29（用户要求：飞书 channel 增加 groupPolicy 配置项）：
							//   原来是 `type === "password" ? password : text` ⇒ **只有文本/密码两种**，
							//   策略这种枚举字段只能手打（打错等于没配，且没有任何提示）✗
							//   ⇒ 支持 `type: "select"`（带 `options` + `default`）✓
							f.type === "select"
								? el("select", {
									key: "i" + f.key, style: S.input,
									"data-vssaros-channel-field": key + "." + f.key,
									value: String(form[f.key] ?? f.default ?? ""),
									onChange: (ev) => setField(f.key, ev.target.value),
								}, ...(f.options || []).map((o) => el("option", {
									key: "o" + o.value, value: String(o.value),
								}, String(o.label || o.value))))
								: el("input", {
									key: "i" + f.key, style: S.input,
									type: f.type === "password" ? "password" : "text",
									placeholder: (f.secret || f.type === "password")
									? (ch.hasSecret ? "已配置（明文不回显）· 留空 = 不改" : String(f.placeholder || "请填写"))
									: (String(chFields[f.key] || "").trim()
										? "当前：" + String(chFields[f.key]).trim() + " · 留空 = 不改"
										: String(f.placeholder || "")),
									"data-vssaros-channel-field": key + "." + f.key,
									value: String(form[f.key] || ""),
									onChange: (ev) => setField(f.key, ev.target.value),
								}),
						])),
					el("p", { style: { ...S.p, ...S.small, padding: "0 8px 7px" }, "data-vssaros-channel-creds-current": "1" },
						(ch.configured ? "当前生效：" : "当前状态：") + currentLine
							+ " · 来源：" + (SOURCE_LABEL[ch.source] || ch.source || "—")
							+ (ch.configured ? "" : " —— 填完点「保存」，再点上面的「启动入站」")),
					fb
						? el("p", {
							style: { ...S.p, ...S.small, padding: "0 8px 7px", color: fb.status === "err" ? toneColor("err") : fb.status === "ok" ? toneColor("ok") : undefined },
							"data-vssaros-channel-creds-result": fb.status,
						}, (fb.status === "ok" ? "✓ " : fb.status === "err" ? "✗ " : "") + fb.text)
						: null,
					el("p", { style: { ...S.p, ...S.small, padding: "0 8px 7px" } },
						"存在本机 dsh 侧（agent-im-accounts.json，仅本用户可读）；接口只回掩码值与「是否已配置」，不回 secret 明文。")));
			} else {
				blocks.push(el("div", { style: S.card },
					el("p", { style: { ...S.p, ...S.small, padding: "8px" } },
						"适配器尚未实现 —— 不给表单，避免「填了不生效」。")));
			}

			/* ①b ★ 2026-11-04 其他飞书应用：不同 Bot 可以用不同的飞书应用（各自 App ID / Secret）。
			   上面的「凭据」仍是**默认应用**（老绑定、不选应用的绑定都走它）；这里只管额外的。
			   ⚠ 同一个应用在整台机器上只能有一条长连接（飞书只把事件推给其中一条），
			     所以每个应用各自「启动 / 停止」，被别的客户端占着时服务端回 409 并写明是谁。 */
			if (key === "feishu" && def.implemented) {
				const af = drafts.feishuApp || {};
				const setApp = (k, v) => setDrafts((d0) => ({ ...d0, feishuApp: { ...(d0.feishuApp || {}), [k]: v } }));
				const known = extraApps.some((a) => a.appId === String(af.appId || "").trim());
				const saveApp = () => {
					const appId = String(af.appId || "").trim();
					const body = { action: "feishu-app", appId };
					if (String(af.appSecret || "").trim()) { body.appSecret = String(af.appSecret).trim(); }
					if (String(af.name || "").trim()) { body.name = String(af.name).trim(); }
					setAppFeedback({ status: "saving", text: "正在保存…" });
					post(body, "feishu-app", "已保存飞书应用：" + appId, (r) => {
						setAppFeedback({
							status: r.ok ? "ok" : "err",
							text: r.ok
								? "已保存应用 " + appId + "（App ID 会出现在上面的列表；Secret 不回显明文）"
								: "保存失败：" + r.error,
						});
					});
					setDrafts((d0) => ({ ...d0, feishuApp: {} }));
				};
				const removeApp = (appId) => {
					if (!window.confirm("删除飞书应用 " + appId + "？它的长连接会停掉；仍绑着它的会话将收不到也发不出消息。")) { return; }
					post({ action: "feishu-app", appId, remove: true }, "app-remove:" + appId, "已删除飞书应用：" + appId);
				};
				blocks.push(el("div", { style: S.card, "data-vssaros-feishu-apps": String(extraApps.length) },
					el("div", { style: S.cap }, el("span", null, "其他飞书应用"),
						el("span", { style: S.cnt }, String(extraApps.length)), el("span", { style: S.sp }),
						el("span", { style: { ...S.p, ...S.small, fontWeight: 400 } }, "绑定时可选；不选 = VsSaros助手")),
					extraApps.length
						? el("table", { style: S.table }, el("tbody", null, extraApps.map((a) => {
							const ast = appStatusOf(appInbounds[a.appId]);
							const ainb = appInbounds[a.appId] || null;
							return el("tr", { key: String(a.appId), "data-vssaros-feishu-app": String(a.appId), "data-vssaros-feishu-app-status": String((ainb && ainb.status) || "idle") },
								el("td", { style: S.td },
									el("div", null, a.name ? el("b", null, String(a.name) + " ") : null, el("span", { style: S.code }, String(a.appId))),
									el("div", { style: { ...S.p, ...S.small, color: toneColor(ast.tone) } },
										ast.text + (a.configured ? "" : " · 缺 App Secret")
										+ (ainb && ainb.lastEventAt ? " · 最近事件 " + new Date(ainb.lastEventAt).toTimeString().slice(0, 8) : "")
										+ (ainb && ainb.lastError && !ast.active ? " · " + String(ainb.lastError).slice(0, 80) : ""))),
								el("td", { style: { ...S.td, ...S.num, whiteSpace: "nowrap" } },
									ast.active
										? el("button", {
											type: "button", style: S.btn, "data-vssaros-feishu-app-stop": String(a.appId),
											disabled: !!state.busy,
											onClick: () => post({ action: "inbound-stop", platform: "feishu", appId: a.appId }, "app-stop:" + a.appId, ""),
										}, "停止")
										: el("button", {
											type: "button", style: S.btnPrimary, "data-vssaros-feishu-app-start": String(a.appId),
											disabled: !!state.busy || !a.configured,
											onClick: () => post({ action: "inbound-start", platform: "feishu", appId: a.appId }, "app-start:" + a.appId, ""),
										}, state.busy === "app-start:" + a.appId ? "启动中…" : "启动"),
									el("button", {
										type: "button", style: { ...S.btnGhost, marginLeft: 4 }, "data-vssaros-feishu-app-remove": String(a.appId),
										disabled: !!state.busy, onClick: () => removeApp(String(a.appId)),
									}, "删除")));
						})))
						: el("p", { style: { ...S.p, ...S.small, padding: "7px 8px" } }, "还没有额外的飞书应用。"),
					el("div", { style: { ...S.fld, borderTop: "1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.24))" } },
						el("label", { style: S.lbl }, "App ID"),
						el("input", {
							style: S.input, type: "text", placeholder: "cli_xxxxxxxx", "data-vssaros-feishu-app-field": "appId",
							value: String(af.appId || ""), onChange: (ev) => setApp("appId", ev.target.value),
						}),
						el("label", { style: S.lbl }, "App Secret"),
						el("input", {
							style: S.input, type: "password", "data-vssaros-feishu-app-field": "appSecret",
							placeholder: known ? "已配置 · 留空 = 不改" : "",
							value: String(af.appSecret || ""), onChange: (ev) => setApp("appSecret", ev.target.value),
						}),
						el("label", { style: S.lbl }, "名称"),
						el("input", {
							style: S.input, type: "text", placeholder: "可选，便于在绑定里认出", "data-vssaros-feishu-app-field": "name",
							value: String(af.name || ""), onChange: (ev) => setApp("name", ev.target.value),
						})),
					appFeedback
						? el("p", {
							style: { ...S.p, ...S.small, padding: "4px 8px 0", color: appFeedback.status === "err" ? toneColor("err") : appFeedback.status === "ok" ? toneColor("ok") : undefined },
							"data-vssaros-feishu-app-result": appFeedback.status,
						}, (appFeedback.status === "ok" ? "✓ " : appFeedback.status === "err" ? "✗ " : "") + appFeedback.text)
						: null,
					el("div", { style: { ...S.toolbar, borderBottom: 0 } },
						el("span", null, "每个应用只能在一台机器上连一次；dsh-superagent 填同一个 App ID 时会复用这里的 Secret。"),
						el("span", { style: S.sp }),
						el("button", {
							type: "button", style: S.btnPrimary, "data-vssaros-channel-act": "feishu-app",
							disabled: !!state.busy || !/^cli_[A-Za-z0-9]+$/.test(String(af.appId || "").trim())
								|| (!known && !String(af.appSecret || "").trim()),
							onClick: saveApp,
						}, state.busy === "feishu-app" ? "保存中…" : (known ? "更新" : "添加")))));
			}

			/* ② 该平台的绑定 */
			blocks.push(el("div", { style: S.card, "data-vssaros-channel-bindings": String(bList.length) },
				el("div", { style: S.cap }, el("span", null, "绑定"),
					el("span", { style: S.cnt }, String(bList.length)), el("span", { style: S.sp }),
					el("button", {
						type: "button", style: { ...S.btnGhost, whiteSpace: "nowrap" },
						"data-vssaros-channel-open-bots": "1",
						title: "到左侧栏「Bots」页签查看 / 编辑 Bot 配置",
						onClick: handoffBots,
					}, "去 Bots 配置")),
				botsHint
					? el("p", { style: { ...S.p, ...S.small, padding: "6px 8px" }, "data-vssaros-channel-bots-hint": "1" }, botsHint)
					: null,
				bList.length
					? el("table", { style: S.table }, el("tbody", null, bList.map((b) => el("tr", { key: String(b.id), "data-vssaros-channel-row": String(b.id) },
						el("td", { style: S.td },
							el("span", { style: S.code }, String(b.chatId || "")),
							el("span", { style: { ...S.p, ...S.small } }, " · " + String(b.targetKind === "group" ? "群" : "Bot") + " · " + String(b.targetId || "")),
							el("span", { style: { ...S.p, ...S.small } }, " · " + (b.enabled === false ? "停用" : "启用")),
							key === "feishu" && extraApps.length
								? el("span", { style: { ...S.p, ...S.small }, "data-vssaros-bind-app": String(b.appId || "") },
									" · " + (b.appId ? "应用 " + appLabel(b.appId) : "VsSaros助手"))
								: null,
							/* ★ 2026-10-27「测试发送」：点一下就知道这条出站通不通（用真实适配器） */
							el("button", {
								type: "button", style: { ...S.btnGhost, marginLeft: "4px" },
								"data-vssaros-bind-test": String(b.id),
								disabled: !!state.busy || b.enabled === false || b.direction === "in",
								title: b.direction === "in" ? "只入向的绑定没有出站通道" : "发一条测试消息",
								onClick: () => { void testOne(String(b.id)); },
							}, state.busy === "test:" + String(b.id) ? "发送中…" : "测试"))))))
					: el("p", { style: { ...S.p, ...S.small, padding: "7px 8px" } }, "还没有绑定这个平台的会话。")));

			/* ③ 待批准（pairing） */
			if (pList.length) {
				blocks.push(el("div", { style: S.card, "data-vssaros-pairings": String(pList.length) },
					el("div", { style: S.cap }, el("span", null, "待批准"),
						el("span", { style: { ...S.cnt, color: toneColor("warn") } }, String(pList.length)),
						el("span", { style: S.sp }),
						el("span", { style: { ...S.p, ...S.small } }, "批准只给私聊权限")),
					el("table", { style: S.table }, el("tbody", null, pList.map((p) => el("tr", { key: String(p.code), "data-vssaros-pair": String(p.code) },
						el("td", { style: S.td }, el("span", { style: S.code }, String(p.code))),
						el("td", { style: S.td }, String(p.userName || p.userId || "")),
						el("td", { style: { ...S.td, ...S.num } },
							el("button", {
								type: "button", style: S.btnPrimary, "data-vssaros-pair-approve": String(p.code),
								disabled: !!state.busy, onClick: () => approvePair(String(p.code), key),
							}, "批准"))))))));
			}

			/* ④ 最近失败（死信） */
			if (fList.length) {
				blocks.push(el("div", { style: S.card, "data-vssaros-dlq": String(fList.length) },
					el("div", { style: S.cap }, el("span", null, "最近失败"),
						el("span", { style: { ...S.cnt, color: toneColor("err") } }, String(fList.length)),
						el("span", { style: S.sp }),
						el("button", {
							type: "button", style: S.btnGhost, "data-vssaros-dlq-clear": key,
							disabled: !!state.busy, onClick: () => post({ action: "dead-letters-clear" }, "dlq", ""),
						}, "清空")),
					el("div", { "data-vssaros-dlq-rows": key },
						fList.slice(0, 6).map((x) => el("div", {
							key: String(x.id), "data-vssaros-dlq-row": String(x.reason),
							style: { ...S.p, ...S.small, padding: "4px 8px", display: "flex", gap: 6 },
						},
						el("code", { style: { ...S.code, color: toneColor("warn") } }, String(x.reason || "")),
						el("span", null, String(x.userName || x.userId || "")),
						el("span", { style: { ...S.code, opacity: 0.7, flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, String(x.text || "").slice(0, 40)),
						/* ★ 2026-10-29：一键把发送者加进该绑定的白名单。
						   "我发了消息 bot 没反应"最常见的答案就是"白名单没加我"（fail-closed）；
						   让用户抄 open_id 再回 Bots 里粘贴，这条排查链必断。 */
						x.userId ? el("button", {
							type: "button", style: S.btnGhost, "data-vssaros-dlq-allow": String(x.id),
							disabled: !!state.busy,
							title: "把这个发送者加进该绑定白名单（之后它发的消息才会被处理）",
							onClick: () => post({ action: "dead-letter-allow", id: String(x.id) }, "allow:" + String(x.id), ""),
						}, state.busy === "allow:" + String(x.id) ? "加入中…" : "加入白名单") : null)))));
			}

			/* ⑤ 该平台最近出现的会话（帮用户拿 chat_id 去绑定） */
			if (rList.length) {
				blocks.push(el("div", { style: S.card, "data-vssaros-recent": String(rList.length) },
					el("div", { style: S.cap }, el("span", null, "最近出现的会话"), el("span", { style: S.cnt }, String(rList.length))),
					el("table", { style: S.table }, el("tbody", null, rList.slice(0, 5).map((r) => el("tr", { key: String(r.appId || "") + ":" + String(r.chatId), "data-vssaros-recent-row": String(r.chatId) },
						el("td", { style: S.td }, el("span", { style: S.code }, String(r.chatId))),
						el("td", { style: S.td }, String(r.userName || "") + " · " + String(r.count || 1) + " 条"
							+ (r.appId ? " · 应用 " + appLabel(r.appId) : ""))))))));
			}

			const toolbarNode = el("div", { style: S.toolbar },
				el("span", { style: { ...S.dot, background: st.tone === "ok" ? toneColor("ok") : (st.tone === "err" ? toneColor("err") : "var(--dsw-alias-label-tertiary, rgba(127,127,127,.8))") } }),
				el("span", null, (inboundKindOf(def) ? inboundKindOf(def) + " · " : "") + st.text
					+ (inb && inb.lastEventAt ? " · 最近事件 " + new Date(inb.lastEventAt).toTimeString().slice(0, 8) : "")),
				el("span", { style: S.sp }),
				def.implemented && startableOf(def) && ch.configured && (st.text === "已连接" || st.text === "连接中…")
					? el("button", {
						type: "button", style: S.btn, "data-vssaros-inbound-stop": key,
						disabled: !!state.busy, onClick: () => actPlatform("inbound-stop", key),
					}, "停止")
					: null,
				def.implemented && startableOf(def) && ch.configured && !(st.text === "已连接" || st.text === "连接中…")
					? el("button", {
						type: "button", style: S.btnPrimary, "data-vssaros-inbound-start": key,
						disabled: !!state.busy, onClick: () => actPlatform("inbound-start", key),
					}, state.busy === "inbound-start:" + key ? "启动中…" : "启动入站")
					: null,
				inb && inb.lastError
					? el("span", { style: { ...S.p, ...S.small, color: toneColor("err") } }, String(inb.lastError).slice(0, 80))
					: null);

			return el("div", null, toolbarNode, el("div", { style: S.blocks }, blocks));
		};

		/* ── 主表（5 列 + caret）────────────────────────────────────────── */
		const rows = [];
		for (const def of defs) {
			const ch = statusOf2(def.key);
			const inb = inbounds[def.key] || null;
			const st = statusOf(def, ch, inb);
			const isOpen = open === def.key;
			const bN = bindingsOf(def.key).length;
			const pN = pairingsOf(def.key).length;
			const fN = dlqOf(def.key).length;
			rows.push(el("tr", {
				key: "r" + def.key,
				style: isOpen ? { ...S.row, ...S.rowOpen } : S.row,
				"data-vssaros-inbound": def.key,
				"data-vssaros-inbound-status": String((inb && inb.status) || "idle"),
				onClick: () => setOpen(isOpen ? "" : def.key),
			},
			el("td", { style: S.td },
				el("span", { style: { fontSize: 11 } }, String(def.icon || "") + " "),
				el("b", { style: { fontSize: 11.5 } }, String(def.label || def.key))),
			el("td", { style: { ...S.td, color: toneColor(st.tone), whiteSpace: "nowrap" } }, st.text),
			el("td", { style: { ...S.td, ...S.num } }, bN ? String(bN) : "—"),
			el("td", { style: { ...S.td, ...S.num, color: pN ? toneColor("warn") : undefined, fontWeight: pN ? 600 : undefined } }, pN ? String(pN) : "—"),
			el("td", { style: { ...S.td, ...S.num, color: fN ? toneColor("err") : undefined, fontWeight: fN ? 600 : undefined } }, fN ? String(fN) : "—"),
			el("td", { style: { ...S.td, ...S.caret } }, isOpen ? "▾" : "▸")));

			if (isOpen) {
				rows.push(el("tr", { key: "d" + def.key, "data-vssaros-detail": def.key },
					el("td", { style: S.detail, colSpan: 6 }, detailBlocks(def))));
			}
		}

		const tableNode = el("table", { style: S.table, "data-vssaros-inbounds": String(defs.length) },
			el("thead", null, el("tr", null,
				el("th", { style: S.th }, "平台"),
				el("th", { style: S.th }, "状态"),
				el("th", { style: { ...S.th, ...S.num } }, "绑定"),
				el("th", { style: { ...S.th, ...S.num } }, "待批"),
				el("th", { style: { ...S.th, ...S.num } }, "失败"),
				el("th", { style: S.th }, ""))),
			el("tbody", null, rows));

		const hintNode = el("p", { style: { ...S.p, ...S.small } },
			"点一行展开详情（一次只开一行）。凭据存本机 dsh 侧；出站用每条绑定自己的 webhook，不需要应用凭据。");

		return el("div", { style: S.wrap, "data-vssaros-channel": "" },
			headNode,
			kpiNode,
			tableNode,
			state.ok ? el("p", { style: { ...S.p, ...S.small, color: String(state.ok).startsWith("✗") ? toneColor("err") : toneColor("ok") }, "data-vssaros-channel-ok": "" }, String(state.ok)) : null,
			state.error ? el("p", { style: { ...S.p, ...S.small, color: toneColor("err") }, "data-vssaros-channel-error": "" }, "请求失败：" + String(state.error)) : null,
			hintNode);
	}

	/**
	 * 分区壳（左侧导航里那一项的内容区）。
	 *
	 * ⚠ 必须用 `props.renderSlot(slotName, {})` 渲染自己声明的子槽，写成 `props.children`
	 *   永远是 `null`（dsh 的 slots 不会把子槽当 children 传进来）⇒ 导航项在、内容空白。
	 *   与 `client.market.js` 的 `WorkbenchSection` 逐字同构。
	 */
	function ChannelSection(props) {
		const renderSlot = props && props.renderSlot;
		return el("div", null, renderSlot ? renderSlot(SLOT_ITEM, {}) : null);
	}

	function install(ctx) {
		/* ★ 2026-11-09（用户要求移除设置弹窗的「渠道」页签）：
		   飞书应用凭据/选型迁到各 Bot 设置页的「飞书配置」卡
		   （client.conversationViews.js 的 FeishuConfigCard），Channel 绑定卡也已在那里。
		   ⚠ 本文件仍留在 ALWAYS_CHUNKS：删清单项会让同批 Promise.all 的 9 个 chunk
		     一起失效，且多个静态守卫直接读本文件（删了会 ENOENT 崩溃）。
		     ⇒ 保留文件与导出，只是**不再注册分区**，等后续整包清理。 */
		return;
	}

	exports.install = install;
	exports.ChannelPanel = ChannelPanel;
	exports.ChannelSection = ChannelSection;
	exports.__sectionId = SECTION_ID;
	exports.__api = API;
	return module.exports;
	},
});
