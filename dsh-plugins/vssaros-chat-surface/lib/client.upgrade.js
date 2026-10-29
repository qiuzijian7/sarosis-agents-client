// @vssaros/dsh-chat-surface — **desktop 窗口的「更新」入口**（2026-10-23）
//
// ── 为什么要有它 ──────────────────────────────────────────────────────────────
//   desktop 模式下用户只看得到 dsh 页面：随包插件的「升级到 vX」只在 IDE 插件中心里，
//   dsh 运行时的版本/通道只在设置项，应用本身也没有更新提示 ⇒ 用 desktop 模式的人
//   根本不知道"有 3 项该升级"（用户报障："desktop 窗口下，缺少升级入口"）。
//
// ── 数据从哪来（页面桥单向 ⇒ 只能宿主推）───────────────────────────────────────
//   `document.documentElement.dataset.vssarosUpgrade` + DOM 事件 `vssaros-dsh-upgrade`
//   —— 载荷是**全量快照**：`{ at, app, runtime, bundled[], error? }`（见 dshPageBridgeProtocol）。
//   我们只发**命令**：`upgradeRefresh` / `upgradeBundled(name)` / `upgradeApp`。
//
// ── 位置 ────────────────────────────────────────────────────────────────────
//   侧栏底部、账号 chip **上方**一行（与 V1 稿一致）。用 `shell.overlay` 槽自己定位，
//   不抢官方 panellist 的点击语义（官方那种行点一下 = 切中栏面板，而这里要弹面板）✓
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.upgrade.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");

		const MARK = "data-vssaros-upgrade";
		/** 官方账号 chip（client.account.js 写的锚点）—— 我们这行贴在它上面。 */
		const ANCHOR = "[data-vssaros-account-chip]";
		const ROW_H = 30;
		const GAP = 6;

		const CSS = `
/* ⚠ 这行是 overlay 覆盖在官方侧栏上 ⇒ **必须不透明**：透明时背后的状态文字会透上来糊成一片
   （2026-10-23 用户报障"更新按钮为透明背景，导致和后面的文字有重叠"）。 */
[${MARK}-row]{position:fixed;z-index:2147482000;display:flex;align-items:center;gap:8px;height:${ROW_H}px;
  padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));
  background:var(--dsw-alias-bg-layer-1,#262626);cursor:pointer;
  font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary,#e8e9ec);white-space:nowrap;overflow:hidden}
[${MARK}-row]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
[${MARK}-row][data-hot="1"]{border-color:var(--dsw-alias-brand-primary,#4a8cff);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a8cff) 16%,var(--dsw-alias-bg-layer-1,#262626))}
[${MARK}-row] .vu-ico{flex:none;font-size:13px;line-height:1}
[${MARK}-row] .vu-n{margin-left:auto;font-size:11px;font-weight:600;color:var(--dsw-alias-brand-primary,#4a8cff)}
[${MARK}-row] .vu-muted{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c)}

[${MARK}-pop]{position:fixed;z-index:2147482100;width:396px;max-height:min(560px,calc(100vh - 80px));overflow:auto;
  border-radius:12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));
  background:var(--dsw-alias-bg-layer-2,#1c1d21);color:var(--dsw-alias-label-primary,#e8e9ec);
  box-shadow:0 18px 48px rgba(0,0,0,.5);font:inherit;font-size:12.5px}
[${MARK}-pop] .vu-hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22))}
[${MARK}-pop] .vu-hd b{font-size:12.5px}
[${MARK}-pop] .vu-x{margin-left:auto;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);cursor:pointer;font-size:13px}
[${MARK}-pop] .vu-meta{padding:7px 12px;color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));display:flex;gap:10px;flex-wrap:wrap}
[${MARK}-pop] .vu-sec{display:flex;align-items:center;gap:8px;padding:9px 12px 3px;font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c)}
[${MARK}-pop] .vu-sec .vu-sp{flex:1}
[${MARK}-pop] .vu-row{display:flex;align-items:center;gap:8px;padding:6px 12px}
[${MARK}-pop] .vu-nm{font-family:ui-monospace,Consolas,monospace;font-size:11.5px}
[${MARK}-pop] .vu-vs{color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px}
[${MARK}-pop] .vu-vs b{color:var(--dsw-alias-label-secondary,#a9adb6);font-weight:600}
[${MARK}-pop] .vu-sp{flex:1}
[${MARK}-pop] .vu-tag{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:4px;padding:0 4px;font-size:9.5px;color:var(--dsw-alias-label-tertiary,#81858c)}
[${MARK}-pop] .vu-tag[data-miss="1"]{border-color:#d9a33a;color:#d9a33a}
[${MARK}-pop] .vu-btn{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.35));background:transparent;color:inherit;
  border-radius:6px;padding:3px 9px;font-size:11.5px;cursor:pointer;font:inherit}
[${MARK}-pop] .vu-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
[${MARK}-pop] .vu-btn[data-primary="1"]{border-color:var(--dsw-alias-brand-primary,#4a8cff);background:var(--dsw-alias-brand-primary,#4a8cff);color:#fff;font-weight:600}
[${MARK}-pop] .vu-btn:disabled{opacity:.5;cursor:default}
[${MARK}-pop] .vu-ft{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18));
  color:var(--dsw-alias-label-tertiary,#81858c);font-size:11px}
[${MARK}-pop] .vu-lk{color:var(--dsw-alias-brand-primary,#4a8cff);cursor:pointer}
[${MARK}-pop] .vu-err{padding:7px 12px;color:#e05a4f;font-size:11.5px}
[${MARK}-pop] .vu-empty{padding:12px;text-align:center;color:var(--dsw-alias-label-tertiary,#81858c);font-size:11.5px}
`;

		/** 解析宿主推来的快照（坏数据一律当"没数据"，不要半截 UI）。 */
		function readState() {
			try {
				const raw = document.documentElement && document.documentElement.dataset
					? document.documentElement.dataset.vssarosUpgrade : null;
				if (!raw) { return null; }
				const s = JSON.parse(raw);
				return s && typeof s === "object" ? s : null;
			} catch { return null; }
		}

		/** 页面桥（preload 注入）；老宿主没有这几个方法 ⇒ 整块不渲染（界面上看不出我们存在过）。 */
		function bridge() {
			const b = typeof window !== "undefined" ? window.vssarosDsh : null;
			return b && typeof b.upgradeRefresh === "function" ? b : null;
		}

		const pendingRows = s => (s && Array.isArray(s.bundled) ? s.bundled : [])
			.filter(r => r && (r.state === "missing" || r.state === "upgradable"));
		/**
		 * ★★ 2026-10-26（用户："改成只算升级"）：**计数 / 徽标 / 这一行的显隐，只认"可升级"**。
		 *
		 * 为什么改：原来把"未安装"也算一项 ⇒ 本机永远显示「2 项可用」，点进去按钮却是「安装」，
		 * 而且每次发新版随包插件都会把这一行顶出来 —— 用户要的是"有没有**新版**要升"这个信号 ✓。
		 * ⚠ **未安装的仍然列在面板里**（有自己的「安装」按钮），只是不参与计数、不足以单独把这一行顶出来。
		 *   要装未安装的：打开面板（有升级项时）/ IDE 插件中心，两条路都还在。
		 */
		const upgradableRows = s => (s && Array.isArray(s.bundled) ? s.bundled : [])
			.filter(r => r && r.state === "upgradable");
		/** 商城资产（技能 / MCP / 智能体 / 工作流 / 工作台）：宿主已经筛成"只含可升级的" ✓ */
		const assetRows = s => (s && Array.isArray(s.assets) ? s.assets : []);
		/**
		 * 应用（IDE）自身是否可升级（2026-10-29）。
		 *
		 * 为什么要单列：之前 `totalPending` 只数"随包插件 + 商城资产"，**应用更新被漏掉了**
		 * ⇒ 左下角那行在"只有应用有新版"时显示"已最新"，用户完全看不到信号 ✗
		 * （真机：本地 2.2.26207 / 源上 2.2.26208，就是这么被吞掉的）。
		 * ⚠ 只认 `action === "upgrade"`：`downgrade`（源比本地旧）**不算**可升级，
		 *   否则点「一键升级」就变成"一键降级"（那正是 `decideAppUpdate` 要拦的情况）。
		 */
		const appUpgradable = s => !!(s && s.app && s.app.action === "upgrade");
		// 「待升级」= 可升级的随包插件 + 可升级的商城资产 + **应用自身可升级**
		const totalPending = s => upgradableRows(s).length + assetRows(s).length + (appUpgradable(s) ? 1 : 0);
		const KIND_LABEL = { skill: "技能", mcp: "MCP", agent: "智能体", workflow: "工作流", workbench: "工作台" };
		const KIND_ORDER = ["skill", "mcp", "agent", "workflow", "workbench"];
		const busyOf = s => (s && s.app && s.app.busy) || "";
		const actionText = s => {
			const app = (s && s.app) || {};
			const busy = app.busy;
			if (busy === "checking") { return "正在检查更新源…"; }
			if (busy === "downloading") { return "下载中…"; }
			if (busy === "installing") { return "正在安装，马上重启…"; }
			if (app.error) { return "检查失败"; }
			if (app.action === "upgrade") { return `可升级到 `; }
			if (app.action === "downgrade") { return "已是最新"; }
			if (app.action === "uptodate") { return "已是最新"; }
			return "还没检查";
		};

		/** 侧栏那一行（贴在账号 chip 上方）。 */
		function Row(props) {
			const s = props.state;
			// 徽标数 = 随包插件 + 商城资产（用户要的是"总共几项该升"，不是只算插件）
			const n = totalPending(s);
			return react.createElement("button", {
				[MARK + "-row"]: "1",
				"data-hot": n > 0 ? "1" : "0",
				title: n > 0 ? `更新：${n} 项可用` : "更新：已是最新",
				style: props.pos,
				onClick: () => props.onToggle(),
			},
				react.createElement("span", { className: "vu-ico" }, "↑"),
				react.createElement("span", null, "更新"),
				n > 0 ? react.createElement("span", { className: "vu-n" }, `${n} 项可用`)
					: react.createElement("span", { className: "vu-muted" }, "已最新"),
			);
		}

		function bundledRows(s, onOne) {
			const rows = pendingRows(s);
			if (!rows.length) {
				return react.createElement("div", { className: "vu-empty" }, "随包插件都是最新的");
			}
			return rows.map(r => react.createElement("div", { className: "vu-row", key: r.name },
				react.createElement("span", { className: "vu-nm" }, r.name),
				react.createElement("span", { className: "vu-vs" },
					r.installedVersion ? `${r.installedVersion} → ` : "",
					react.createElement("b", null, r.version)),
				react.createElement("span", { className: "vu-tag", "data-miss": r.state === "missing" ? "1" : "0" },
					r.state === "missing" ? "未安装" : "可升级"),
				react.createElement("span", { className: "vu-sp" }),
				react.createElement("button", {
					className: "vu-btn",
					"data-primary": r.state === "missing" ? "1" : "0",
					onClick: () => onOne(r.name),
				}, r.state === "missing" ? "安装" : "升级"),
			));
		}

		/** 资产那一段：五类汇总 + 可升级项（技能/工作流由 dsh 侧升 ⇒ 不画按钮，标一行说明）。 */
		function assetsSection(s, onAsset) {
			const rows = assetRows(s);
			const note = s && s.assetsNote;
			const counts = {};
			for (const k of KIND_ORDER) { counts[k] = 0; }
			for (const r of rows) { if (counts[r.kind] !== undefined) { counts[r.kind] += 1; } }
			const summary = KIND_ORDER.map(k => react.createElement("span", {
				key: k,
				style: counts[k] ? { color: "var(--dsw-alias-brand-primary,#4a8cff)", fontWeight: 600 } : { opacity: .6 },
			}, `${KIND_LABEL[k]} ${counts[k]}`)).reduce((acc, el, i) => (i ? acc.concat([react.createElement("span", { key: "sep" + i, style: { opacity: .35 } }, "·"), el]) : [el]), []);

			return [
				react.createElement("div", { className: "vu-sec", key: "asset-sec" },
					react.createElement("span", null, "资产（技能 / MCP / 智能体 / 工作流 / 工作台）"),
					react.createElement("span", { className: "vu-sp" }),
					react.createElement("span", null, rows.length ? `${rows.length} 项可升级` : "已最新")),
				react.createElement("div", { className: "vu-row", key: "asset-sum", style: { gap: 6, fontSize: 11.5 } }, summary),
				note ? react.createElement("div", { className: "vu-err", key: "asset-note", style: { color: "var(--dsw-alias-label-tertiary,#81858c)" } }, note) : null,
				...rows.map((r, i) => react.createElement("div", { className: "vu-row", key: `asset-${r.kind}-${r.name}-${i}` },
					react.createElement("span", { className: "vu-tag" }, KIND_LABEL[r.kind] || r.kind),
					react.createElement("span", { className: "vu-nm" }, r.name),
					react.createElement("span", { className: "vu-vs" },
						r.current ? `${r.current} → ` : "",
						react.createElement("b", null, r.latest)),
					react.createElement("span", { className: "vu-sp" }),
					r.via === "dsh"
						? react.createElement("span", { className: "vu-tag", title: "技能 / 工作流由 dsh 侧升级（在商城页操作）" }, "dsh 侧升级")
						: react.createElement("button", { className: "vu-btn", onClick: () => onAsset(r.kind, r.name) }, "升级"))),
			];
		}

		/** 面板（四段：随包插件 / 资产 / dsh 运行时 / 应用）。 */
		function Panel(props) {
			const s = props.state;
			// ⚠ 两个数要分开（2026-10-26「只算升级」）：
			//   `nAll` = 面板里**列出来**的行数（含未安装，所以标题写"项待处理"对得上）；
			//   `nUp`  = 真正**能升级**的数量（"全部升级"只跑这些；未安装的各自点「安装」）。
			const nAll = pendingRows(s).length;
			const nUp = upgradableRows(s).length;
			const app = (s && s.app) || {};
			const busy = busyOf(s);
			const appDisabled = !!busy || app.action === "uptodate";
			return react.createElement("div", { [MARK + "-pop"]: "1", style: props.pos },
				react.createElement("div", { className: "vu-hd" },
					react.createElement("span", null, "↑"),
					react.createElement("b", null, "系统与更新"),
					react.createElement("button", { className: "vu-x", onClick: () => props.onToggle(), title: "关闭" }, "✕")),
				react.createElement("div", { className: "vu-meta" },
					react.createElement("span", null, "应用 ", react.createElement("b", null, app.current || "—")),
					react.createElement("span", null, "dsh ", react.createElement("b", null, (s && s.runtime && s.runtime.current) || "—")),
					react.createElement("span", null, `${(s && s.bundled ? s.bundled.length : 0)} 个随包插件`)),
				react.createElement("div", { className: "vu-sec" },
					react.createElement("span", null, "随包插件"),
					react.createElement("span", null, nAll ? `${nAll} 项待处理${nAll !== nUp ? `（可升级 ${nUp}）` : ""}` : "已最新"),
					react.createElement("span", { className: "vu-sp" }),
					react.createElement("button", {
						className: "vu-btn", "data-primary": "1", disabled: !nUp || !!busy,
						onClick: () => props.onAll(),
					}, nUp ? `全部升级（${nUp}）` : "无可升级")),
				bundledRows(s, props.onOne),
				...assetsSection(s, props.onAsset),
				react.createElement("div", { className: "vu-sec" },
					react.createElement("span", null, "dsh 运行时"),
					react.createElement("span", { className: "vu-sp" }),
					react.createElement("span", { className: "vu-tag" }, (s && s.runtime && s.runtime.channel) || "stable")),
				react.createElement("div", { className: "vu-row" },
					react.createElement("span", { className: "vu-nm" }, (s && s.runtime && s.runtime.current) || "—"),
					react.createElement("span", { className: "vu-vs" }, "跟随应用升级（本版不支持单独切版本）")),
				react.createElement("div", { className: "vu-sec" },
					react.createElement("span", null, "应用（IDE）"),
					react.createElement("span", { className: "vu-sp" }),
					react.createElement("span", { className: "vu-tag" }, "win32 · saros")),
				react.createElement("div", { className: "vu-row" },
					react.createElement("span", { className: "vu-nm" }, app.current || "—"),
					react.createElement("span", { className: "vu-vs" },
						app.action === "upgrade" && app.remote ? ["可升级到 ", react.createElement("b", null, app.remote)] : actionText(s)),
					react.createElement("span", { className: "vu-sp" }),
					react.createElement("button", {
						className: "vu-btn", "data-primary": "1", disabled: appDisabled,
						onClick: () => props.onApp(),
					}, busy === "downloading" ? "下载中…" : busy === "installing" ? "安装中…" : busy === "checking" ? "检查中…"
						: app.action === "uptodate" || app.action === "downgrade" ? "已是最新" : "一键升级")),
				app.error ? react.createElement("div", { className: "vu-err" }, app.error) : null,
				s && s.error ? react.createElement("div", { className: "vu-err" }, s.error) : null,
				react.createElement("div", { className: "vu-ft" },
					react.createElement("span", null, "检查于 ", new Date((s && s.at) || Date.now()).toLocaleTimeString()),
					react.createElement("span", { className: "vu-sp" }),
					react.createElement("span", { className: "vu-lk", onClick: () => props.onRefresh() }, "检查更新")),
			);
		}

		/** 定位：行贴在账号 chip 上方；面板贴在行上方（右对齐），放不下就往下放。 */
		/**
		 * 官方侧栏底部、账号 chip **上方**那行灰色状态（「N 个工作区 · N 条会话」）。
		 *
		 * ★ 2026-10-23（用户报「更新按钮为透明背景，导致和后面的文字有重叠」）：
		 *   我们这行原先只按 chip 定位 ⇒ 正好压在状态行上，加上透明背景 ⇒ 两行文字糊在一起 ✗。
		 *   这里把状态行找出来，锚点抬到**它的顶部**（找不到就退回 chip 顶部，行为与旧版一致）。
		 *
		 * 判据尽量宽容：只认"短文本 + 含『个工作区 / 条会话 / 个会话』+ 紧贴在 chip 上方"的叶子元素，
		 * 避免误把会话列表项当成它（那些更长、且离 chip 更远）。
		 */
		function footerStatusTop(chipRect) {
			try {
				const RE = /(个工作区|条会话|个会话)/;
				let best = null;
				const all = document.querySelectorAll("div,span,p");
				for (let i = 0; i < all.length; i++) {
					const el = all[i];
					if (el.children && el.children.length > 2) { continue; }   // 只看叶子文本
					const t = (el.textContent || "").trim();
					if (!t || t.length > 40 || !RE.test(t)) { continue; }
					const r = el.getBoundingClientRect();
					if (r.height < 8 || r.width < 20) { continue; }
					if (r.bottom > chipRect.top + 2) { continue; }              // 必须在 chip 上方
					if (chipRect.top - r.bottom > 64) { continue; }             // 且就在它上面（远离的不算）
					best = best === null ? r.top : Math.min(best, r.top);
				}
				return best;
			} catch { return null; }
		}

		function measure() {
			const chip = document.querySelector(ANCHOR);
			const chipRect = chip ? chip.getBoundingClientRect() : null;
			const winW = window.innerWidth || 1200;
			const winH = window.innerHeight || 800;
			const width = chipRect ? Math.max(160, Math.round(chipRect.width)) : 200;
			const left = chipRect ? Math.round(chipRect.left) : 8;
			// 锚点：状态行顶部 > chip 顶部（★ 别压在状态行上）
			const statusTop = chipRect ? footerStatusTop(chipRect) : null;
			const anchorTop = statusTop !== null ? statusTop : (chipRect ? chipRect.top : null);
			const bottom = anchorTop !== null ? Math.round(winH - anchorTop + GAP) : 56;
			return {
				row: { left, width, bottom, height: ROW_H },
				pop: { left, width: 396, bottom: bottom + ROW_H + GAP },
				room: { winW, winH },
			};
		}

		/** 悬浮入口的整体（行 + 面板）。状态变化靠 dataset + 事件驱动。 */
		function UpgradeHost() {
			const [, force] = react.useState(0);
			const [open, setOpen] = react.useState(false);
			const [geo, setGeo] = react.useState(measure);

			react.useEffect(() => {
				const update = () => { setGeo(measure()); force(v => v + 1); };
				document.addEventListener("vssaros-dsh-upgrade", update);
				window.addEventListener("resize", update);
				const timer = window.setInterval(() => setGeo(measure()), 1000);
				update();
				return () => {
					document.removeEventListener("vssaros-dsh-upgrade", update);
					window.removeEventListener("resize", update);
					window.clearInterval(timer);
				};
			}, []);

			const b = bridge();
			const state = readState();
			// 老宿主（没有那三个方法）⇒ 整块不渲染：界面上不要出现一个点了没反应的入口 ✗
			if (!b) { return null; }

			// ★★ 2026-10-23（用户："如果没有可升级的内容，则不用显示 更新UI"）：
			//   **没有可升级的东西就整块不出现**（不是显示一行"已最新"占地方 ✗）。
			//   判据三条：随包插件/资产有可升级项、应用有新版、或正在跑升级/检查。
			//   ⚠ 面板开着时**不隐藏**（否则用户点开、刚升完最后一个，面板会凭空消失 ✗）；
			//   关掉面板后若确实没内容 ⇒ 下一次渲染就消失 ✓。
			//   ⚠ 还没收到任何状态（`state === null`，通常是宿主刚起来还没推）⇒ 也先不显示，
			//     避免"闪一下空入口再消失"。
			const pendingCount = totalPending(state);
			const appNew = !!(state && state.app && state.app.action === "upgrade");
			const busyNow = !!(state && state.app && state.app.busy);
			if (!open && pendingCount === 0 && !appNew && !busyNow) {
				return null;
			}

			const call = fn => {
				try { const r = fn(); if (r && typeof r.catch === "function") { r.catch(() => undefined); } } catch { /* 下一轮状态会纠正 */ }
			};

			const rowPos = {
				left: geo.row.left, width: geo.row.width, bottom: geo.row.bottom, height: geo.row.height,
			};
			const popLeft = Math.max(8, Math.min(geo.pop.left, geo.room.winW - geo.pop.width - 8));
			const popPos = { left: popLeft, width: geo.pop.width, bottom: geo.pop.bottom };

			return react.createElement(react.Fragment, null,
				react.createElement(Row, {
					state, pos: rowPos,
					onToggle: () => {
						const next = !open;
						setOpen(next);
						// 打开面板时请宿主重算一份（带联网检查）—— 别让用户看到上次开机的旧快照
						if (next) { call(() => b.upgradeRefresh()); }
					},
				}),
				open ? react.createElement(Panel, {
					state, pos: popPos,
					onToggle: () => setOpen(false),
					onRefresh: () => call(() => b.upgradeRefresh()),
					onOne: name => call(() => b.upgradeBundled(name)),
					// 资产升级：只有 IDE 侧那三类有按钮（技能/工作流由 dsh 侧升，页面不画按钮）
					onAsset: (kind, slug) => call(() => b.upgradeAsset(kind, slug)),
					onAll: () => {
						// ⚠ 只跑**可升级**的（2026-10-26）：未安装的不属于"升级"，各自点「安装」✓
						for (const r of upgradableRows(state)) { call(() => b.upgradeBundled(r.name)); }
						for (const a of assetRows(state)) {
							if (a.via === 'ide') { call(() => b.upgradeAsset(a.kind, a.name)); }
						}
					},
					onApp: () => call(() => b.upgradeApp()),
				}) : null,
			);
		}

		/** 装样式（幂等）。 */
		function ensureCss() {
			if (typeof document === "undefined" || document.querySelector("[" + MARK + "-style]")) { return; }
			try {
				const el = document.createElement("style");
				el.setAttribute(MARK + "-style", "1");
				el.textContent = CSS;
				(document.head || document.documentElement).appendChild(el);
			} catch { /* 没有 head：只是没样式，不影响逻辑 */ }
		}

		return {
			install(ctx) {
				// ⚠ 每一项都兜底：这个 chunk 会被各种环境装载（真页面 / 全窗 / 守卫的极简假 DOM），
				//   任何一处抛错都不能连累聊天本体 ✓
				try {
					ensureCss();
					const slots = ctx && ctx.slots;
					if (!slots || typeof slots.inject !== "function") { return; }
					slots.inject("shell.overlay", () => slots.register(
						// order 102：排在页签条（100）之后，互不依赖 ✓
						{ name: "shell.overlay", id: "vssaros-upgrade", order: 102 },
						UpgradeHost,
					));
				} catch { /* 装不上就不出现入口（聊天本体不受影响） */ }
			},
			__test: { readState, pendingRows, upgradableRows, totalPending, actionText, MARK, ROW_H },
		};
	},
});
