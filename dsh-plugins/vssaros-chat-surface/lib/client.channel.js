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
//                                   pairings, deadLetters, recentChats }
//   POST 同上 { action: 'inbound-start'|'inbound-stop'|'credentials'|'pairing-approve'|'dead-letters-clear', ... }
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
	const BOTS_ROUTE = "/x/agents/";
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
		const [state, setState] = react.useState({ status: "loading", data: null, error: "", busy: "", ok: "" });
		/** 各平台草稿：`{ [platform]: { [fieldKey]: value } }`（secret 不回填 ⇒ 留空 = 不改）。 */
		const [drafts, setDrafts] = react.useState({});
		/** 手风琴：一次只展开一个平台（'feishu' / 'telegram' / ... / ''）。 */
		const [open, setOpen] = react.useState("feishu");

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

		const post = (body, busyKey, okText) => {
			setState((s0) => ({ ...s0, busy: busyKey, ok: "", error: "" }));
			fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
				.then((r) => r.json().then((j) => ({ ok: r.ok, j })))
				.then(({ ok, j }) => {
					if (!ok || (j && j.error)) { throw new Error((j && j.error) || "HTTP"); }
					setState((s0) => ({ ...s0, busy: "", ok: okText || "" }));
					load();
				})
				.catch((e) => setState((s0) => ({ ...s0, busy: "", error: String((e && e.message) || e) })));
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
		const savePlatform = (platform, form) => {
			const payload = { action: "credentials", platform };
			for (const k of Object.keys(form || {})) {
				const val = String(form[k] == null ? "" : form[k]).trim();
				if (val) { payload[k] = val; }
			}
			post(payload, "credentials", "已保存（dsh 侧）：" + platform);
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

		const d = state.data || {};
		const defs = Array.isArray(d.channelDefs) ? d.channelDefs : [];
		const channels = Array.isArray(d.channels) ? d.channels : [];
		const bindings = Array.isArray(d.bindings) ? d.bindings : [];
		const pairings = Array.isArray(d.pairings) ? d.pairings : [];
		const dlItems = (d.deadLetters && Array.isArray(d.deadLetters.items)) ? d.deadLetters.items : [];
		const recentChats = Array.isArray(d.recentChats) ? d.recentChats : [];
		const inbounds = d.inbounds || {};

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
				blocks.push(el("div", { style: S.card, "data-vssaros-channel-creds": String(ch.source || "none") },
					el("div", { style: S.cap }, el("span", null, "凭据"), el("span", { style: S.sp }),
						el("button", {
							type: "button", style: S.btnPrimary, "data-vssaros-channel-act": "credentials",
							disabled: !!state.busy || !(def.fields || []).length,
							onClick: () => savePlatform(key, form),
						}, state.busy === "credentials" ? "保存中…" : "保存")),
					el("div", { style: S.fld },
						(def.fields || []).map((f) => [
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
									placeholder: (f.secret && ch.hasSecret) ? "已配置 · 留空 = 不改" : String(f.placeholder || ""),
									"data-vssaros-channel-field": key + "." + f.key,
									value: String(form[f.key] || ""),
									onChange: (ev) => setField(f.key, ev.target.value),
								}),
						])),
					el("p", { style: { ...S.p, ...S.small, padding: "0 8px 7px" } },
						ch.configured
							? "已配置 · " + String(ch.appIdMasked || "") + " · 来源：" + (SOURCE_LABEL[ch.source] || ch.source || "—")
							: "未配置 —— 填完点「保存」，再点上面的「启动入站」。"),
					el("p", { style: { ...S.p, ...S.small, padding: "0 8px 7px" } },
						"存在本机 dsh 侧（agent-im-accounts.json，仅本用户可读）；接口只回「是否已配置」，不回 secret。")));
			} else {
				blocks.push(el("div", { style: S.card },
					el("p", { style: { ...S.p, ...S.small, padding: "8px" } },
						"适配器尚未实现 —— 不给表单，避免「填了不生效」。")));
			}

			/* ② 该平台的绑定 */
			blocks.push(el("div", { style: S.card, "data-vssaros-channel-bindings": String(bList.length) },
				el("div", { style: S.cap }, el("span", null, "绑定"),
					el("span", { style: S.cnt }, String(bList.length)), el("span", { style: S.sp }),
					el("button", { type: "button", style: S.btnGhost, onClick: () => { window.location.assign(BOTS_ROUTE); } }, "去 Bots 配")),
				bList.length
					? el("table", { style: S.table }, el("tbody", null, bList.map((b) => el("tr", { key: String(b.id), "data-vssaros-channel-row": String(b.id) },
						el("td", { style: S.td },
							el("span", { style: S.code }, String(b.chatId || "")),
							el("span", { style: { ...S.p, ...S.small } }, " · " + String(b.targetKind === "group" ? "群" : "Bot") + " · " + String(b.targetId || "")),
							el("span", { style: { ...S.p, ...S.small } }, " · " + (b.enabled === false ? "停用" : "启用")),
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
					el("table", { style: S.table }, el("tbody", null, rList.slice(0, 5).map((r) => el("tr", { key: String(r.chatId), "data-vssaros-recent-row": String(r.chatId) },
						el("td", { style: S.td }, el("span", { style: S.code }, String(r.chatId))),
						el("td", { style: S.td }, String(r.userName || "") + " · " + String(r.count || 1) + " 条")))))));
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
		if (!ctx || !ctx.slots) { return; }
		ctx.slots.inject(SLOT_SECTION, () => ctx.slots.register({
			name: SLOT_SECTION,
			id: SECTION_ID,
			order: 21,
			label: () => "渠道",
			children: { [SLOT_ITEM]: { kind: "list", scope: "root" } },
		}, ChannelSection));
		ctx.slots.inject(SLOT_ITEM, () => ctx.slots.register(
			{ name: SLOT_ITEM, id: "panel", order: 0 },
			ChannelPanel,
		));
	}

	exports.install = install;
	exports.ChannelPanel = ChannelPanel;
	exports.ChannelSection = ChannelSection;
	exports.__sectionId = SECTION_ID;
	exports.__api = API;
	return module.exports;
	},
});
