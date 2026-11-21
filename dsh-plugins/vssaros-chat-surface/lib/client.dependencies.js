// @vssaros/dsh-chat-surface — dsh 左侧栏底部「设置」→「依赖与组件」分区。
//
// 这是 dsh 官方设置弹窗的 settings.section，不是会话视图里的「设置」页签。
// 宿主桥只负责状态/安装意图；实际路径探测、winget/brew/apt 安装和 managed 包下载
// 都在主进程 DshComponentManager 里完成。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.dependencies.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		const h = react.createElement;

		const SLOT_SECTION = "settings.section";
		const SECTION_ID = "vssaros-dependencies";
		const SECTION_ORDER = 30;
		let pageBridge;

		const S = {
			wrap: { display: "flex", flexDirection: "column", gap: 12, minWidth: 0 },
			head: { display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" },
			title: { margin: 0, fontSize: 15, fontWeight: 650, lineHeight: "22px" },
			sub: { margin: 0, fontSize: 11.5, lineHeight: "18px", color: "var(--dsw-alias-label-secondary, currentColor)" },
			badge: { fontSize: 10.5, padding: "0 7px", borderRadius: 999, border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))", color: "var(--dsw-alias-label-secondary, currentColor)" },
			card: { border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.26))", borderRadius: 8, padding: 10, background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,.04))" },
			flow: { display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 5, alignItems: "stretch" },
			step: { minWidth: 0, padding: "7px 6px", borderRadius: 7, border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))", background: "var(--dsw-alias-bg-layer-1, transparent)" },
			stepNo: { width: 18, height: 18, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "var(--dsw-alias-label-primary-foreground, #fff)", background: "var(--dsw-alias-brand-primary, #3794ff)" },
			stepTitle: { display: "block", marginTop: 4, fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			stepHint: { display: "block", marginTop: 1, fontSize: 9.5, lineHeight: "13px", color: "var(--dsw-alias-label-tertiary, rgba(127,127,127,.85))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			rows: { display: "flex", flexDirection: "column", gap: 7 },
			row: { padding: "8px 9px", borderRadius: 7, border: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.22))", background: "var(--dsw-alias-bg-layer-1, transparent)" },
			rowTop: { display: "flex", alignItems: "center", gap: 8 },
			name: { flex: "1 1 auto", minWidth: 0, fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			meta: { marginTop: 3, fontSize: 10.5, lineHeight: "15px", color: "var(--dsw-alias-label-secondary, currentColor)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			path: { marginTop: 2, fontSize: 9.5, lineHeight: "14px", color: "var(--dsw-alias-label-tertiary, rgba(127,127,127,.85))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			btn: { font: "inherit", fontSize: 11, lineHeight: "18px", padding: "3px 9px", borderRadius: 6, cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))", background: "var(--dsw-alias-bg-layer-2, transparent)", color: "inherit", flex: "0 0 auto" },
			btnDisabled: { opacity: .55, cursor: "default" },
			bar: { height: 4, marginTop: 6, borderRadius: 999, overflow: "hidden", background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.22))" },
			barFill: { display: "block", height: "100%", background: "var(--dsw-alias-brand-primary, #3794ff)", transition: "width .2s ease" },
			err: { marginTop: 5, fontSize: 10.5, lineHeight: "15px", color: "var(--dsw-alias-state-error-primary, #d9534f)" },
			note: { margin: 0, fontSize: 10.5, lineHeight: "16px", color: "var(--dsw-alias-label-tertiary, rgba(127,127,127,.9))" },
		};

		const FLOW = [
			{ key: "detect", title: "检测", hint: "多路径 / PATH" },
			{ key: "source", title: "官方源", hint: "winget / brew / apt" },
			{ key: "install", title: "安装", hint: "用户级 / 授权" },
			{ key: "verify", title: "校验", hint: "版本 / SHA256" },
			{ key: "ready", title: "生效", hint: "重启 Host" },
		];
		const LABELS = {
			ready: "已就绪", bundled: "随包可用", installing: "安装中",
			"needs-consent": "需要授权", unavailable: "源不可用", error: "安装失败", missing: "未安装",
		};

		/**
		 * dsh 设置弹窗中的分区内容。
		 * `pageBridge` 由 ALWAYS_CHUNKS 的 install(ctx, {bridge}) 注入；独立 dsh 窗口没有
		 * 页面桥时仍展示流程，但按钮会如实提示不可用。
		 */
		function DependenciesSection() {
			const [items, setItems] = react.useState([]);
			const [pending, setPending] = react.useState("");
			const [error, setError] = react.useState("");

			const load = () => {
				if (!pageBridge || typeof pageBridge.componentsStatus !== "function") {
					setError("当前宿主没有组件管理桥（需要页面桥 29+）；独立 dsh 窗口请使用完整离线包或在 IDE 聊天框安装");
					return;
				}
				Promise.resolve(pageBridge.componentsStatus()).then(
					(list) => { setItems(Array.isArray(list) ? list : []); setError(""); },
					(e) => setError(String((e && e.message) || e)));
			};
			react.useEffect(() => {
				load();
				const timer = setInterval(load, 2000);
				return () => clearInterval(timer);
			}, []);

			const install = (id, allowElevation) => {
				if (!pageBridge || typeof pageBridge.installComponent !== "function") {
					setError("当前宿主没有组件安装桥（需要页面桥 29+）");
					return;
				}
				setPending(id);
				setError("");
				let settled = false;
				const timer = setTimeout(() => {
					if (settled) { return; }
					settled = true;
					setPending("");
					setError("安装请求 15 秒没有返回；请重启 dsh 或确认宿主组件管理器已加载");
				}, 15_000);
				const finish = (list) => {
					if (settled) { return; }
					settled = true;
					clearTimeout(timer);
					setPending("");
					if (Array.isArray(list)) {
						setItems(list);
						setError("");
					} else {
						setError("宿主未返回组件状态；安装可能尚未开始");
					}
				};
				Promise.resolve(pageBridge.installComponent(id, allowElevation === true)).then(
					finish,
					(e) => { if (!settled) { settled = true; clearTimeout(timer); setPending(""); setError(String((e && e.message) || e)); } });
			};

			const steps = FLOW.map((step, index) => h("div", { key: step.key, style: S.step },
				h("span", { style: { display: "flex", alignItems: "center", gap: 5 } },
					h("span", { style: S.stepNo }, String(index + 1)),
					h("span", { style: { fontSize: 9.5, color: "var(--dsw-alias-label-tertiary, rgba(127,127,127,.85))" } }, "STEP")),
				h("span", { style: S.stepTitle }, step.title),
				h("span", { style: S.stepHint }, step.hint)));

			const rows = items.length ? items.map((item) => {
				const state = item && item.state ? item.state : "missing";
				const done = state === "ready" || state === "bundled";
				const installing = state === "installing" || pending === item.id;
				const unavailable = state === "unavailable";
				const canRefresh = unavailable && item.id !== "loading";
				const canInstall = !done && !installing && !unavailable && item.id !== "loading";
				const size = Number(item && item.size) > 0 ? `${(Number(item.size) / 1024 / 1024).toFixed(1)} MiB` : "";
				const meta = [LABELS[state] || state, item && item.source, item && item.version, size].filter(Boolean).join(" · ");
				const progress = Math.max(0, Math.min(100, Number(item && item.progress) || 0));
				return h("div", { key: item.id, style: S.row, "data-vssaros-dependency": item.id },
					h("div", { style: S.rowTop },
						h("span", { style: S.name }, item.label || item.id),
						h("button", {
							type: "button", disabled: !canInstall && !canRefresh,
							onClick: () => unavailable ? load() : install(item.id, state === "needs-consent"),
							style: (canInstall || canRefresh) ? S.btn : Object.assign({}, S.btn, S.btnDisabled),
						}, installing ? "安装中…" : done ? "已就绪" : unavailable ? "重新检测" : state === "needs-consent" ? "授权安装" : "安装")),
					h("div", { style: S.meta }, meta),
					installing ? h("div", { style: S.bar }, h("span", { style: Object.assign({}, S.barFill, { width: `${progress}%` }) })) : null,
					item && item.error ? h("div", { style: S.err, role: "alert" }, item.error) : null,
					item && item.installedPath ? h("div", { style: S.path, title: item.installedPath }, item.installedPath) : null);
			}) : [h("div", { key: "loading", style: S.note }, "正在读取组件状态…")];

			return h("div", { style: S.wrap, "data-vssaros-dependencies-section": "1" },
				h("div", { style: S.head },
					h("h2", { style: S.title }, "依赖与组件"),
					h("span", { style: S.badge }, "官方源优先")),
				h("p", { style: S.sub }, "媒体工具使用各 OS 官方包管理器；Office Python 随安装包分发；Whisper 模型从 HuggingFace 官方源下载，不再依赖 VsSaros 组件服务器。"),
				h("div", { style: S.card }, h("div", { style: S.flow }, steps)),
				error ? h("div", { style: S.err, role: "alert" }, error) : null,
				h("div", { style: S.rows }, rows),
				h("p", { style: S.note }, "媒体工具安装后需重启 dsh Host 才会进入 Host PATH（Vox 可直接使用）；Office 随包运行时同样在重启 Host 后生效。"));
		}

		function install(ctx, shell) {
			pageBridge = shell && shell.bridge;
			try {
				ctx.slots.inject(SLOT_SECTION, () => ctx.slots.register({
					name: SLOT_SECTION,
					id: SECTION_ID,
					order: SECTION_ORDER,
					label: () => "依赖与组件",
				}, DependenciesSection));
				// 旧 Host 不渲染 icon 槽；新 Host 在设置左导航显示齿轮。
				ctx.slots.inject("settings.section.icon", () => ctx.slots.register({
					name: "settings.section.icon",
					id: SECTION_ID,
					order: SECTION_ORDER,
					label: () => "依赖与组件",
				}, () => h("span", { "aria-hidden": "true", style: { fontSize: 13 } }, "⚙")));
			} catch (e) {
				try { console.error("[vssaros] 依赖与组件设置分区注册失败：" + String((e && e.message) || e)); } catch { /* 无 console */ }
			}
		}

		exports.install = install;
		exports.__sectionId = SECTION_ID;
		return module.exports;
	},
});
