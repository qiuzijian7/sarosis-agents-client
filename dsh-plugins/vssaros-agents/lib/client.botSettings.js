// @vssaros/dsh-agents — **右侧栏「Bot 设置」页签**（2026-11-02，Bots 工作台重构第 2 步）
//
// 为什么要有这个 chunk：用户 2026-11-02 定的形态是「点 bot ⇒ 中栏就是 dsh 聊天框，
//   中栏右上角 ⚙ ⇒ **官方那根可伸缩右侧栏**里显示设置页」。设置不再占工作台页面，
//   而是右侧栏（`sidebarRight`）里的一个页签，和 🧠记忆 / 📤委派 / 各工作台页签并列。
//
// ── 契约（跨 chunk，两处都按字面量写，守卫会比对）──────────────────────────────
//   · 页签 id / kind：`vssaros-bot-settings`
//   · 槽：`sidebar.right.pane.tab`（keyed / session）
//   · 目标 bot：`window.__vssarosBotSettings = { id, name }` + `window.dispatchEvent(
//     new CustomEvent("vssaros-bot-settings-target"))`
//     —— 为什么用全局 + 事件而不是改协议：点 ⚙ 的是 chat-surface 的 chunk，两个 chunk 同页同
//        JS 上下文（跨插件，不能互相 require）⇒ 全局是唯一零协议通道；事件只用来让**已经打开**的
//        面板换人（否则页签开着也不会重渲染 ✗）。
//   · 打开链路（chat-surface 侧）：点官方 `[data-sidebar-right-expand]` 撑开右栏 →
//     `ctx.sidebarRight.openTab('vssaros-bot-settings')`（与本插件打开工作台页签同一条 ✓）
//
// ── 数据面（只走现成 GET/POST，不新造接口）────────────────────────────────────
//   读：`GET  /x/agents/api/agents?id=<id>` → { draft: { name, description, role, model, persona, skills, … } }
//       `GET  /x/agents/api/home`          → agents[]（registered / toolCount / personaBytes）+ home[id]（会话数）
//       `GET  /x/agents/api/groups`        → 群清单（members 里含这个 bot 的就是它的「渠道」）
//   写：`POST /x/agents/api/agents { action:'update', id, draft }`（整份重写；写名字时必须带 name）
//       `POST /x/agents/api/agents { action:'resetModel', id }` / `{ action:'set-subagent', id, enabled }`
//
// ── 诚实边界 ────────────────────────────────────────────────────────────────
//   · **版本**（记忆库 Git 历史）与 **渠道绑定**（飞书凭据在 IDE 主进程）这一版只给"去完整页"，
//     不在这里画假控件 —— 与工作台设置页的口径一致（那边也是"没后端支撑就如实标待接"）。
//   · Turn Budget 后端没有写口 ⇒ 不出现可编辑控件。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-agents",
	chunk: "client.botSettings.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		const h = react.createElement;
		const { useState, useEffect, useCallback } = react;

		const API = "/x/agents/api";
		/** 页签 id / kind（与 chat-surface 的打开语句逐字一致，守卫比对）。 */
		const TAB_ID = "vssaros-bot-settings";
		const SLOT = "sidebar.right.pane.tab";
		const TARGET_GLOBAL = "__vssarosBotSettings";
		const TARGET_EVENT = "vssaros-bot-settings-target";
		/** 分区（chip 行；短名，320px 里放得下 —— 面板页签条已经被工作台页签占着了）。 */
		const CHIPS = [
			{ k: "basic", label: "基本" },
			{ k: "prompt", label: "人设" },
			{ k: "runtime", label: "运行时" },
			{ k: "versions", label: "版本" },
			{ k: "skills", label: "技能" },
			{ k: "channel", label: "渠道" },
		];

		/** 读当前目标 bot（全局；点 ⚙ 或点侧栏 bot 行都会写它）。 */
		function readTarget() {
			try {
				const v = typeof window !== "undefined" ? window[TARGET_GLOBAL] : null;
				if (v && typeof v.id === "string" && v.id) { return { id: v.id, name: String(v.name || v.id) }; }
			} catch { /* 读不到就按"没选"处理 */ }
			return null;
		}

		const getJson = (url, init) => Promise.resolve(fetch(url, Object.assign({ headers: { accept: "application/json" } }, init || {})))
			.then((r) => r.json().then((j) => ({ ok: r.ok && (!j || j.ok !== false), j: j || {} })));

		/* ══════════ 面板 ══════════ */
		function BotSettingsPanel() {
			const [target, setTarget] = useState(readTarget);
			const [chip, setChip] = useState("basic");
			const [draft, setDraft] = useState(null);      // 服务端 draft（写回时以它为底）
			const [summary, setSummary] = useState(null);  // /api/home 里这一行（registered / toolCount / 会话数）
			const [groups, setGroups] = useState([]);      // 它参与的群（= dsh 侧的「渠道」）
			const [status, setStatus] = useState("idle");  // idle | loading | ready | error
			const [err, setErr] = useState("");
			const [ok, setOk] = useState("");
			const [busy, setBusy] = useState(false);
			// 表单值（受控；载入 draft 时灌一次，用户改了以用户为准）
			const [form, setForm] = useState({ name: "", description: "", role: "", model: "", persona: "" });
			const [skillsPool, setSkillsPool] = useState([]);
			const [skillPick, setSkillPick] = useState([]);

			// 目标变化（点 ⚙ 换 bot）⇒ 重渲染；面板已经开着时靠事件通知 ✓
			useEffect(() => {
				const onTarget = () => setTarget(readTarget());
				window.addEventListener(TARGET_EVENT, onTarget);
				return () => window.removeEventListener(TARGET_EVENT, onTarget);
			}, []);

			const load = useCallback(() => {
				const cur = readTarget();
				if (!cur) { setStatus("idle"); return; }
				setStatus("loading"); setErr(""); setOk("");
				void Promise.all([
					getJson(API + "/agents?id=" + encodeURIComponent(cur.id)).catch((e) => ({ ok: false, j: { error: String((e && e.message) || e) } })),
					getJson(API + "/home").catch(() => ({ ok: false, j: {} })),
					getJson(API + "/groups").catch(() => ({ ok: false, j: {} })),
					getJson("/x/skills/api/skills").catch(() => ({ ok: false, j: {} })),
				]).then(([one, homeRes, groupsRes, skillsRes]) => {
					if (!one.ok) {
						setStatus("error");
						setErr(String((one.j && one.j.error) || "读不到这个 bot 的配置"));
						return;
					}
					const d = (one.j && one.j.draft) || {};
					setDraft(d);
					setForm({
						name: String(d.name || cur.name || ""),
						description: String(d.description || ""),
						role: String(d.role || ""),
						model: String(d.model || ""),
						persona: String(d.persona || ""),
					});
					const pick = String(d.skills || "").split(",").map((s) => s.trim()).filter(Boolean);
					setSkillPick(pick);
					const pool = (skillsRes.ok && Array.isArray(skillsRes.j.skills)) ? skillsRes.j.skills : [];
					setSkillsPool(pool);
					const agents = (homeRes.ok && Array.isArray(homeRes.j.agents)) ? homeRes.j.agents : [];
					const row = agents.filter((a) => a && a.id === cur.id)[0] || null;
					const hm = (homeRes.ok && homeRes.j.home && homeRes.j.home[cur.id]) || {};
					setSummary(row ? Object.assign({}, row, {
						sessionsTotal: typeof hm.sessionsTotal === "number" ? hm.sessionsTotal : null,
					}) : null);
					const list = (groupsRes.ok && Array.isArray(groupsRes.j.groups)) ? groupsRes.j.groups : [];
					setGroups(list.filter((g) => g && Array.isArray(g.members) && g.members.indexOf(cur.id) >= 0));
					setStatus("ready");
				});
			}, []);

			useEffect(() => {
				if (!target) { setStatus("idle"); return; }
				load();
			}, [target && target.id, load]);

			/** 写回（整份 draft 语义：update 是"重写 .agent.md"，所以每次都要把 name 带上） */
			const save = (patch, okText) => {
				if (!target || busy) { return; }
				const body = {
					action: "update", id: target.id,
					draft: Object.assign({
						name: String(form.name || target.name || target.id),
						description: form.description,
						role: form.role,
						model: form.model,
						persona: form.persona,
						skills: (patch && patch.skills) !== undefined ? patch.skills : skillPick.join(","),
					}, patch || {}),
				};
				setBusy(true); setErr(""); setOk("");
				void getJson(API + "/agents", {
					method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
				}).then((r) => {
					if (!r.ok) { throw new Error((r.j && r.j.error) || "保存失败"); }
					setOk(okText || "已保存");
					load();
				}).catch((e) => setErr(String((e && e.message) || e))).then(() => setBusy(false));
			};

			/* ── 样式（只走 --dsw-alias-* 令牌；不写裸色）── */
			const S = {
				wrap: { display: "flex", flexDirection: "column", minHeight: 0, height: "100%", color: "var(--dsw-alias-label-primary, #e6e6e6)" },
				hd: { flex: "0 0 auto", display: "flex", alignItems: "center", gap: 7, padding: "9px 10px 8px 12px", borderBottom: "1px solid var(--dsw-alias-border-l1, #383838)" },
				av: { width: 22, height: 22, borderRadius: 7, flex: "0 0 auto", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#fff", background: "var(--dsw-alias-brand-primary, #4d7cfe)" },
				ttl: { minWidth: 0, display: "flex", flexDirection: "column" },
				nm: { fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
				sub: { fontSize: 10.5, color: "var(--dsw-alias-label-tertiary, #737373)" },
				sp: { flex: "1 1 auto" },
				iconBtn: { width: 24, height: 24, display: "inline-flex", alignItems: "center", justifyContent: "center", border: "1px solid transparent", borderRadius: 6, background: "transparent", color: "var(--dsw-alias-label-secondary, #a3a3a3)", cursor: "pointer", fontSize: 12 },
				chips: { flex: "0 0 auto", display: "flex", gap: 4, padding: "8px 10px 2px", overflowX: "auto" },
				chip: { height: 22, padding: "0 8px", borderRadius: 6, flex: "0 0 auto", whiteSpace: "nowrap", cursor: "pointer", font: "inherit", fontSize: 11, border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)", background: "transparent", color: "var(--dsw-alias-label-tertiary, #737373)" },
				chipOn: { border: "1px solid var(--dsw-alias-brand-primary, #4d7cfe)", background: "var(--dsw-alias-bg-layer-3, #2f2f2f)", color: "var(--dsw-alias-label-primary, #e6e6e6)", fontWeight: 600 },
				body: { flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "10px 12px 18px", display: "flex", flexDirection: "column", gap: 10 },
				fld: { display: "flex", flexDirection: "column", gap: 4 },
				lb: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #a3a3a3)" },
				inp: { height: 28, padding: "0 9px", width: "100%", borderRadius: 7, fontSize: 12, color: "inherit", background: "var(--dsw-alias-bg-layer-1, #262626)", border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)" },
				ta: { width: "100%", minHeight: 150, padding: "8px 9px", borderRadius: 7, fontSize: 11.5, lineHeight: 1.6, color: "inherit", background: "var(--dsw-alias-bg-layer-1, #262626)", border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)", resize: "vertical", fontFamily: "Consolas, ui-monospace, monospace" },
				hint: { fontSize: 10.5, lineHeight: 1.6, color: "var(--dsw-alias-label-tertiary, #737373)" },
				kv: { display: "flex", gap: 8, fontSize: 11.5, alignItems: "baseline" },
				kvk: { flex: "0 0 60px", color: "var(--dsw-alias-label-tertiary, #737373)" },
				btnRow: { display: "flex", gap: 7, alignItems: "center" },
				btn: { height: 28, padding: "0 12px", borderRadius: 7, fontSize: 12, cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)", background: "var(--dsw-alias-bg-layer-1, #262626)", color: "inherit" },
				btnPri: { height: 28, padding: "0 12px", borderRadius: 7, fontSize: 12, cursor: "pointer", border: "1px solid var(--dsw-alias-brand-primary, #4d7cfe)", background: "var(--dsw-alias-brand-primary, #4d7cfe)", color: "#fff", fontWeight: 600 },
				chk: { display: "flex", alignItems: "flex-start", gap: 7, fontSize: 12, padding: "3px 0", color: "var(--dsw-alias-label-secondary, #a3a3a3)" },
				okTxt: { fontSize: 11, color: "var(--dsw-alias-state-success-primary, #39b56a)" },
				errTxt: { fontSize: 11, color: "var(--dsw-alias-state-error-primary, #e05252)", whiteSpace: "normal" },
				row: { display: "flex", alignItems: "center", gap: 7, fontSize: 12, padding: "4px 0", color: "var(--dsw-alias-label-secondary, #a3a3a3)" },
				tag: { fontSize: 9.5, padding: "0 5px", borderRadius: 4, border: "1px solid var(--dsw-alias-border-l2, #3e3e3e)", color: "var(--dsw-alias-label-tertiary, #737373)", flex: "0 0 auto" },
			};

			const setF = (k, v) => setForm((f) => Object.assign({}, f, { [k]: v }));
			const openFullPage = () => {
				try {
					const bridge = window.vssarosDsh;
					if (bridge && typeof bridge.openModulePage === "function") { void bridge.openModulePage("/x/agents/"); return; }
				} catch { /* 落到提示 */ }
				setErr("当前宿主不支持打开完整页（需要桥版本 3+）");
			};

			if (!target || status === "idle") {
				return h("div", { style: S.wrap, "data-vssaros-bot-settings": "empty" },
					h("div", { style: Object.assign({}, S.body, { gap: 8 }) },
						h("div", { style: { fontSize: 12.5, fontWeight: 600 } }, "Bot 设置"),
						h("div", { style: S.hint },
							"在左侧栏「Bots」页签里点一个 bot，或点聊天框右上角的 ⚙ —— 这里会显示它的设置。"),
						h("div", { style: S.hint },
							"（设置页跟着当前选中的 bot 走；切 bot 不需要重开页签。）")));
			}

			const name = String(form.name || target.name || target.id);
			const body = (() => {
				if (status === "loading" && !draft) { return h("div", { style: S.hint }, "正在读取配置…"); }
				if (status === "error") { return h("div", { style: S.errTxt }, err); }
				if (chip === "basic") {
					return h(react.Fragment, null,
						h("div", { style: S.kv }, h("span", { style: S.kvk }, "id"), h("code", { style: { fontSize: 11 } }, target.id + "（不可改）")),
						fld("名字", "name", "例如：Code Architect"),
						fld("描述", "description", "一句话说明它擅长什么"),
						fld("角色", "role", "例如：架构设计"),
						fld("模型", "model", "留空 = 跟随默认模型（provider/model）"),
						h("div", { style: S.btnRow },
							h("button", { type: "button", style: S.btnPri, disabled: busy, onClick: () => save({}, "已保存基本信息") }, busy ? "保存中…" : "💾 保存")),
						h("div", { style: S.hint }, "保存会重写整个 .agent.md（未改的字段沿用当前值），改完立刻重新注册 preset。"));
				}
				if (chip === "prompt") {
					return h(react.Fragment, null,
						h("div", { style: S.fld },
							h("span", { style: S.lb }, "System Prompt（.agent.md 正文）"),
							h("textarea", { style: S.ta, value: form.persona, onChange: (e) => setF("persona", e.target.value) })),
						h("div", { style: S.btnRow },
							h("button", { type: "button", style: S.btnPri, disabled: busy, onClick: () => save({}, "人设已保存") }, busy ? "保存中…" : "💾 保存人设"),
							h("span", { style: S.hint }, String(form.persona.length) + " 字"),
							h("button", { type: "button", style: S.btn, disabled: busy, onClick: () => load() }, "↻ 重新读取")));
				}
				if (chip === "runtime") {
					const reg = summary ? summary.registered !== false : null;
					const tools = summary && typeof summary.toolCount === "number" ? summary.toolCount : null;
					const sess = summary && summary.sessionsTotal != null ? summary.sessionsTotal : null;
					return h(react.Fragment, null,
						kvRow("模型", String(form.model || "跟随默认模型")),
						kvRow("预设", "vssaros-" + target.id),
						kvRow("注册", reg === null ? "（读不到）" : (reg ? "已注册" : "未注册（花名册里没有它的 preset）")),
						kvRow("工具", tools === null ? "（读不到）" : tools + " 个"),
						kvRow("会话", sess === null ? "（读不到）" : sess + " 个"),
						h("div", { style: S.btnRow },
							h("button", {
								type: "button", style: S.btn, disabled: busy,
								onClick: () => {
									setBusy(true); setErr(""); setOk("");
									void getJson(API + "/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "resetModel", id: target.id }) })
										.then((r) => { if (!r.ok) { throw new Error((r.j && r.j.error) || "失败"); } setOk("已改为跟随默认模型"); load(); })
										.catch((e) => setErr(String((e && e.message) || e))).then(() => setBusy(false));
								},
							}, "↺ 改为跟随默认模型")),
						h("div", { style: S.hint }, "Turn Budget（每回合最大迭代）后端还没有写口 ⇒ 这里不画假控件。"));
				}
				if (chip === "versions") {
					return h(react.Fragment, null,
						h("div", { style: S.hint }, "版本 = 这个 bot 记忆库（MEMORY.md）的 Git 历史，快照 / 回滚都在完整页。"),
						h("div", { style: S.btnRow }, h("button", { type: "button", style: S.btn, onClick: openFullPage }, "在完整页看版本 ↗")));
				}
				if (chip === "skills") {
					const pool = skillsPool.length ? skillsPool : [];
					const toggle = (id) => setSkillPick((cur) => (cur.indexOf(id) >= 0 ? cur.filter((x) => x !== id) : cur.concat([id])));
					return h(react.Fragment, null,
						h("div", { style: S.lb }, "技能（写进 .agent.md 的 skills:，逗号分隔）"),
						pool.length
							? pool.map((s) => {
								const id = String((s && (s.name || s.id)) || "");
								if (!id) { return null; }
								const on = skillPick.indexOf(id) >= 0;
								return h("div", { key: id, style: S.chk, role: "checkbox", "aria-checked": on ? "true" : "false", "data-vssaros-skill": id, onClick: () => toggle(id) },
									h("span", { style: { width: 13, height: 13, marginTop: 2, flex: "0 0 auto", borderRadius: 3, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: "#fff", background: on ? "var(--dsw-alias-brand-primary, #4d7cfe)" : "transparent", border: on ? "1px solid var(--dsw-alias-brand-primary, #4d7cfe)" : "1px solid var(--dsw-alias-border-l2, #3e3e3e)" } }, on ? "✓" : ""),
									h("span", null, id, s && s.description ? h("small", { style: Object.assign({}, S.hint, { display: "block" }) }, String(s.description).slice(0, 60)) : null));
							})
							: h("div", { style: S.hint }, "读不到技能池（/x/skills/api/skills）—— 插件没装或 Host 没起。"),
						h("div", { style: S.btnRow },
							h("button", { type: "button", style: S.btnPri, disabled: busy, onClick: () => save({ skills: skillPick.join(",") }, "技能已保存") }, busy ? "保存中…" : "💾 保存")),
						h("div", { style: S.hint }, "勾选会写进 .agent.md 的 skills:；保存后立刻重新注册 preset。"));
				}
				// channel
				return h(react.Fragment, null,
					h("div", { style: S.hint }, "dsh 侧的「渠道」= 群聊：把 bot 加进群，它就能在群里被点名。飞书 / 外部 IM 的凭据在 IDE 主进程（TOF 登录态），不在这一侧。"),
					groups.length
						? groups.map((g) => h("div", { key: String(g.id), style: S.row },
							h("span", null, "👥"),
							h("span", { style: { flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, String(g.name || g.id)),
							h("span", { style: S.tag }, (g.mode === "open" ? "全员响应" : "@ 唤醒"))))
						: h("div", { style: S.hint }, "它还没加入任何群。"),
					h("div", { style: S.btnRow }, h("button", { type: "button", style: S.btn, onClick: openFullPage }, "去群聊页管理 ↗")));
			})();

			function fld(label, key, placeholder) {
				return h("label", { style: S.fld, key },
					h("span", { style: S.lb }, label),
					h("input", {
						style: S.inp, value: form[key] || "", placeholder: placeholder || "",
						"data-vssaros-bot-field": key,
						onChange: (e) => setF(key, e.target.value),
					}));
			}
			function kvRow(k, v) {
				return h("div", { style: S.kv, key: k }, h("span", { style: S.kvk }, k), h("span", null, v));
			}

			return h("div", { style: S.wrap, "data-vssaros-bot-settings": target.id, "data-vssaros-bot-settings-chip": chip },
				h("div", { style: S.hd },
					h("span", { style: S.av }, name.slice(0, 1)),
					h("span", { style: S.ttl },
						h("span", { style: S.nm }, name),
						h("span", { style: S.sub }, "Bot 设置 · " + target.id)),
					h("span", { style: S.sp }),
					h("button", { type: "button", style: S.iconBtn, title: "重新读取", onClick: () => load() }, "⟳")),
				h("div", { style: S.chips, role: "tablist" },
					CHIPS.map((c) => h("button", {
						key: c.k, type: "button", role: "tab", "data-vssaros-bot-chip": c.k,
						"aria-selected": chip === c.k ? "true" : "false",
						style: Object.assign({}, S.chip, chip === c.k ? S.chipOn : null),
						onClick: () => { setChip(c.k); setOk(""); setErr(""); },
					}, c.label))),
				h("div", { style: S.body },
					err ? h("div", { style: S.errTxt, "data-vssaros-bot-err": "" }, err) : null,
					ok ? h("div", { style: S.okTxt, "data-vssaros-bot-ok": "" }, ok) : null,
					body));
		}

		function install(ctx) {
			try {
				// ⚠ 服务必须从 **scoped（child）ctx** 读：`ctx.inject` 只是"声明取用"，
				//   父 ctx 上没有这两个服务（同 vssaros-workflow 的 `ctx.inject([...], c => c.xxx)` 口径）。
				ctx.inject(["slots", "sidebarRightTabs"], (c) => {
					// 页签类型（宿主按 kind 派发；与本插件工作台页签同一条通路）
					try {
						c.effect(() => c.sidebarRightTabs.register({
							id: TAB_ID, kind: TAB_ID, priority: "extension", title: () => "Bot 设置",
						}), "vssaros-bot-settings-type");
					} catch (e) { console.warn("[vssaros-agents] Bot 设置页签类型注册失败：" + String((e && e.message) || e)); }
					// 页签内容（keyed / session）
					try {
						c.slots.inject(SLOT, () => c.slots.register({ name: SLOT, key: TAB_ID }, BotSettingsPanel));
					} catch (e) { console.warn("[vssaros-agents] Bot 设置面板注册失败：" + String((e && e.message) || e)); }
				});
			} catch (e) {
				console.warn("[vssaros-agents] Bot 设置安装失败：" + String((e && e.message) || e));
			}
		}

		exports.install = install;
		// 仅测试用：守卫直接断言 id / kind / 槽与"目标全局 + 事件"这套跨 chunk 契约
		exports.__test = { TAB_ID, SLOT, TARGET_GLOBAL, TARGET_EVENT, CHIPS, readTarget };
		return module.exports;
	},
});
