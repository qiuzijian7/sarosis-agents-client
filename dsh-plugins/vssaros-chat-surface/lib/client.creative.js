// @vssaros/dsh-chat-surface — **创作模型三层行**（聊天框模型下拉框里的图片 / 视频 / 音频模型）
//
// ── 为什么是 DOM 注入（2026-10-22，用户定：方案 A + 所有 provider 经 dsh + 视觉风格 S2）──
//   官方**没有**给这个下拉框开插槽 —— 全部官方插槽只有 `conversation.input.model.label`
//   （只读、不可交互的内联标签）、`settings.models.*`、`plugins.*`、`tool.view.cordis`
//   ⇒ 想在里面加行，只能我们自己画。
//   **做法上的取舍**：官方那个菜单是 Radix 的（焦点陷阱 / 方向键 / 二级菜单按"主格子的 rect"定位）。
//   把官方两行换成我们画的（"接管"）会让官方的二级菜单失去锚点、键盘导航也断 ⇒
//   这里改成**在原菜单里追加**（官方两行原样不动，只在末尾加一个分组）：
//   视觉结果与"S2"稿一致，官方行为零风险 ✓（真正要接管时再说，改这个文件就行）。
//
// ── 数据从哪来（只有 dsh 侧 provider）────────────────────────────────────────────
//   `GET /x/vssaros-bridge/api/media/catalog` —— 按 provider 分组的全部媒体模型（含 dsh 侧还没接入的，
//   界面置灰并说明原因）+ 各类默认 + provider 状态。**没有"经 IDE"这条路**（用户已定）✓
//   `POST /x/vssaros-bridge/api/media/default` —— 记住某一类选了哪个模型 ⇒ 生成工具默认用它。
//
// ── 老桥插件（没有这个 API）──────────────────────────────────────────────────────
//   404 / 非 JSON ⇒ 一行都不加（界面上看不出我们存在过），也不反复探 ✓
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-chat-surface",
	chunk: "client.creative.js",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		void react;

		/** 官方那个菜单（实测：`div[role=menu][aria-label="模型与推理等级"]`，内含两个 menuitem）。 */
		const MENU_SELECTOR = '[role="menu"][aria-label="模型与推理等级"]';
		/** 创作模型目录 / 默认选择（bridge 插件的 HTTP 面）。 */
		const API = "/x/vssaros-bridge/api/media/";
		/** 我们的标记（菜单里已注入过就不再注入）。 */
		const MARK = "data-vssaros-creative";

		/**
		 * ★ 模型 chip 的模态分组（2026-10-23 定稿，方案 B「二级菜单」）。
		 *
		 * 形态：官方那行「模型」= **文字模型**（官方自己的二级列表，本身就带搜索）；
		 *   我们在它下面追加一个分组，装 **图片 / 视频 / 音频** 三行，每行点开是**我们自己的二级面板**
		 *   （`position:fixed`，按 provider 分组 + 搜索框 + 「共 N 个」footer）。
		 * ⇒ 「推理等级」只属于文字模型（它是官方那行的兄弟行，天然只在文字语境里出现），
		 *   我们这三行下面**不挂**推理等级 ✓
		 *
		 * ⚠ 为什么不把四类画成平级四行：官方菜单是 Radix 的（焦点陷阱 / 方向键 / 二级定位都靠
		 *   "主格子的 rect"）。接管它会让官方二级菜单失去锚点、键盘导航断掉（文件头的取舍说明）。
		 *   所以走「官方两行原样 + 我们追加一个分组」，语义与稿 B 一致（文字 vs 创作三类），视觉上分成两块。
		 *
		 * ⚠ 2026-10-23 曾因为"LLM 下拉不该混入创作模型"临时关掉过（`false`）；
		 *   现按用户定稿的方案 B 重新开启，并用分组标题明确"这是创作模型，不是语言模型"。
		 */
		const SHOW_IN_LLM_MENU = true;
		/** 目录缓存时长（菜单每次打开都会看一眼，别每次打网络）。 */
		const CATALOG_TTL_MS = 30_000;

		const KINDS = [
			{ id: "image", label: "图片模型", icon: "img" },
			{ id: "video", label: "视频模型", icon: "vid" },
			{ id: "audio", label: "音频模型", icon: "aud" },
		];

		const ICONS = {
			img: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.6" y="2.8" width="12.8" height="10.4" rx="2"/><circle cx="5.6" cy="6.3" r="1.1"/><path d="M2.2 11.4 5.7 8.3 8 10.2 10.3 8.4 13.8 11.4"/></svg>',
			vid: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.6" y="3.6" width="8.8" height="8.8" rx="1.6"/><path d="M10.4 7.1 14.4 5.1v5.8l-4-2z"/><path d="M5.4 6.7 8.5 8 5.4 9.3z"/></svg>',
			aud: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 6.3h2.3L8.4 3.5v9L5.5 9.7H3.2z"/><path d="M10.7 5.7a3.3 3.3 0 0 1 0 4.6M12.7 3.9a5.9 5.9 0 0 1 0 8.2"/></svg>',
			chev: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.2 4.2 10 8l-3.8 3.8"/></svg>',
		};

		// ── 纯函数（守卫直接断言；不碰 DOM）────────────────────────────────────────

		/**
		 * 这一个模型**现在能不能用**，不能用时给出人话原因。
		 * 空串 = 能用。四类原因：需登录 / 未在 dsh 侧配置 / 路由表还没接 / provider 明确失效。
		 */
		function reasonFor(model, provider) {
			if (!model || typeof model !== "object") { return "模型信息缺失"; }
			if (provider && provider.id === "lightai") {
				const st = provider.status || {};
				if (st.expired) { return "登录已失效，请在 设置 → 模型 → LightAI 重新登录"; }
				if (!st.signedIn) { return st.signingIn ? "正在登录 LightAI…" : "需登录 LightAI"; }
			}
			if (model.routable !== true) { return "dsh 侧还没接入这个模型"; }
			return "";
		}

		/** 目录 ⇒ `{ providers, defaults, picked }`（缺字段时给安全的空值，调用方不必判空）。 */
		function normalizeCatalog(json) {
			const providers = Array.isArray(json && json.providers) ? json.providers : [];
			return {
				providers: providers.filter(p => p && typeof p === "object" && p.id).map(p => ({
					id: String(p.id),
					name: String(p.name || p.id),
					route: String(p.route || "dsh 直连"),
					unit: String(p.unit || ""),
					status: p.status && typeof p.status === "object" ? p.status : {},
					kinds: p.kinds && typeof p.kinds === "object" ? p.kinds : {},
				})),
				defaults: (json && json.defaults && typeof json.defaults === "object") ? json.defaults : {},
				picked: (json && json.picked && typeof json.picked === "object") ? json.picked : {},
			};
		}

		/** 某一类下按 provider 分组后的可显示列表（空组丢掉；组内保持 catalog 的顺序）。 */
		function groupModels(catalog, kind) {
			const out = [];
			for (const provider of (catalog && catalog.providers) || []) {
				const models = Array.isArray(provider.kinds[kind]) ? provider.kinds[kind] : [];
				if (models.length === 0) { continue; }
				out.push({ provider, models });
			}
			return out;
		}

		/** 某一类当前选中的模型（`defaults[kind]` ⇒ 该 provider 的那个模型）；找不到返回 null。 */
		function selectedOf(catalog, kind) {
			const d = catalog && catalog.defaults && catalog.defaults[kind];
			if (!d || !d.model) { return null; }
			for (const provider of catalog.providers) {
				if (d.provider && provider.id !== d.provider) { continue; }
				const found = (provider.kinds[kind] || []).find(m => m && m.id === d.model);
				if (found) { return { provider, model: found }; }
			}
			return null;
		}

		/** 菜单里那三行的视图模型（行值 = 当前模型名；没有就"未选"）。 */
		function menuRows(catalog) {
			return KINDS.map(k => {
				const picked = selectedOf(catalog, k.id);
				return {
					kind: k.id,
					label: k.label,
					icon: k.icon,
					modelName: picked ? String(picked.model.name || picked.model.id) : "",
					providerName: picked ? picked.provider.name : "",
					// 整类都不能用（provider 没登录 / 全都没接入）⇒ 行上给个提示点
					blocked: groupModels(catalog, k.id).every(g => g.models.every(m => reasonFor(m, g.provider) !== "")),
				};
			});
		}

		/** 价格显示（灯火 / 按张）：没价的不显示。 */
		function priceText(model, provider) {
			if (!model || !Number.isFinite(model.price)) { return ""; }
			return String(model.price) + " " + String(model.unit || (provider && provider.unit) || "");
		}

		/** 搜索过滤（名字 / id / provider 名；大小写不敏感）。 */
		function matches(model, provider, q) {
			const kw = String(q || "").trim().toLowerCase();
			if (!kw) { return true; }
			const hay = [model && model.name, model && model.id, provider && provider.name].join(" ").toLowerCase();
			return hay.includes(kw);
		}

		// ── 样式（一次注入；色用 dsh 的主题变量，深浅色都对）──────────────────────────
		const CSS = `
[${MARK}-wrap]{display:block}
[${MARK}-row]{display:flex;align-items:center;gap:9px;width:100%;height:34px;padding:0 9px;border:0;background:transparent;border-radius:8px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary,#0f1115);cursor:pointer;text-align:left}
[${MARK}-row]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
[${MARK}-row] .vc-ico{width:15px;height:15px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary,#61666b)}
[${MARK}-row] .vc-ico svg{width:15px;height:15px}
[${MARK}-row] .vc-lb{flex:none}
[${MARK}-row] .vc-val{margin-left:auto;display:inline-flex;align-items:center;gap:5px;max-width:168px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#61666b);font-size:13px}
[${MARK}-row] .vc-chev{width:14px;height:14px;flex:none;display:inline-flex;color:var(--dsw-alias-label-tertiary,#81858c)}
[${MARK}-row] .vc-chev svg{width:14px;height:14px}
[${MARK}-row] .vc-none{color:var(--dsw-alias-label-tertiary,#81858c)}
[${MARK}-row] .vc-warn{width:6px;height:6px;border-radius:50%;background:#e8890c;flex:none}
[${MARK}-sep]{height:1px;background:var(--dsw-alias-border-l3,rgba(0,0,0,.08));margin:4px 6px}
[${MARK}-cap]{font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c);padding:6px 9px 3px}
[${MARK}-badge]{font-size:9.5px;line-height:14px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:4px;padding:0 4px;color:var(--dsw-alias-label-tertiary,#81858c);white-space:nowrap;flex:none}
[${MARK}-pop]{position:fixed;z-index:2147483000;width:326px;max-height:344px;display:none;flex-direction:column;background:var(--dsw-alias-surface-1,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:12px;box-shadow:rgba(0,0,0,.16) 0 8px 28px;padding:5px;color:var(--dsw-alias-label-primary,#0f1115)}
[${MARK}-pop][data-open]{display:flex}
[${MARK}-pop] .vc-sr{padding:3px 4px 6px}
[${MARK}-pop] input{width:100%;height:28px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:8px;background:var(--dsw-alias-surface-2,transparent);color:inherit;font:inherit;font-size:12px;padding:0 9px;outline:none}
[${MARK}-pop] .vc-list{overflow:auto;overflow-x:hidden;flex:1}
[${MARK}-pop] .vc-grp{display:flex;align-items:center;gap:6px;padding:7px 9px 3px;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#81858c)}
[${MARK}-pop] .vc-grp .vc-nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}
[${MARK}-pop] .vc-grp .vc-route{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:4px;padding:0 4px;font-size:9.5px;white-space:nowrap;flex:none}
[${MARK}-pop] .vc-grp .vc-st{margin-left:auto;display:inline-flex;align-items:center;gap:4px;font-size:10px;white-space:nowrap;flex:none}
[${MARK}-pop] .vc-dot{width:7px;height:7px;border-radius:50%;display:inline-block;background:#b4b8bf}
[${MARK}-pop] .vc-dot.ok{background:#22c55e}
[${MARK}-pop] .vc-dot.warn{background:#e8890c}
[${MARK}-pop] .vc-item{display:flex;align-items:center;gap:8px;width:100%;height:44px;padding:0 9px;border:0;background:transparent;border-radius:8px;font:inherit;cursor:pointer;text-align:left;color:inherit}
[${MARK}-pop] .vc-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
[${MARK}-pop] .vc-item[data-on]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
[${MARK}-pop] .vc-item[data-off]{opacity:.5;cursor:not-allowed}
[${MARK}-pop] .vc-thumb{width:26px;height:26px;border-radius:7px;flex:none;display:flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));color:var(--dsw-alias-label-tertiary,#81858c)}
[${MARK}-pop] .vc-thumb svg{width:14px;height:14px}
[${MARK}-pop] .vc-two{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px}
[${MARK}-pop] .vc-l1{display:flex;align-items:center;gap:6px;font-size:13px;min-width:0}
[${MARK}-pop] .vc-l1 .vc-nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
[${MARK}-pop] .vc-l2{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#81858c);font-family:ui-monospace,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
[${MARK}-pop] .vc-meta{margin-left:auto;flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c);text-align:right}
[${MARK}-pop] .vc-why{color:#e8890c;font-size:10.5px}
[${MARK}-pop] .vc-price{color:var(--dsw-alias-label-secondary,#61666b)}
[${MARK}-pop] .vc-foot{display:flex;align-items:center;gap:8px;padding:6px 9px 4px;border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));margin-top:4px;font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c)}
[${MARK}-pop] .vc-link{color:#2f6bff;cursor:pointer}
[${MARK}-toast]{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#222;color:#fff;font-size:12.5px;padding:9px 16px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.3);opacity:0;pointer-events:none;transition:opacity .18s;z-index:2147483001}
[${MARK}-toast][data-on]{opacity:1}
`;

		/** 转义（只用于纯文本位置；HTML 结构都是我们自己的字面量）。 */
		const esc = (value) => String(value == null ? "" : value).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

		// ── 运行时状态 ──────────────────────────────────────────────────────────
		const state = {
			installed: false,
			catalog: null,
			fetchedAt: 0,
			inflight: null,
			unavailable: false,   // 老桥插件：整个功能不出现
			openKind: "",
			q: "",
			busy: false,
			toastTimer: 0,
		};

		const authHeaders = (extra) => {
			const headers = Object.assign({ accept: "application/json" }, extra || {});
			try {
				const m = /[?&]token=([^&]+)/.exec((typeof location !== "undefined" && location.search) || "");
				if (m) { headers.authorization = "Bearer " + decodeURIComponent(m[1]); }
			} catch { /* 无 location */ }
			return headers;
		};

		function toast(text) {
			if (typeof document === "undefined" || !document.body) { return; }
			let el = document.querySelector("[" + MARK + "-toast]");
			if (!el) {
				el = document.createElement("div");
				el.setAttribute(MARK + "-toast", "1");
				document.body.appendChild(el);
			}
			el.textContent = String(text || "");
			el.setAttribute("data-on", "1");
			clearTimeout(state.toastTimer);
			state.toastTimer = setTimeout(() => el.removeAttribute("data-on"), 2400);
		}

		/** 拉目录（30s 内复用；并发只打一次）。 */
		function loadCatalog(force) {
			if (state.unavailable) { return Promise.resolve(null); }
			if (!force && state.catalog && Date.now() - state.fetchedAt < CATALOG_TTL_MS) { return Promise.resolve(state.catalog); }
			if (state.inflight) { return state.inflight; }
			state.inflight = fetch(API + "catalog", { headers: authHeaders() })
				.then(r => {
					// 老桥插件没有这个 API：404 或前缀路由回 HTML 状态页（200 非 JSON）⇒ 整个功能不出现
					const type = String((r.headers && r.headers.get && r.headers.get("content-type")) || "");
					if (r.status === 404 || !/json/i.test(type)) { state.unavailable = true; return null; }
					return r.json();
				})
				.then(json => {
					if (!json || json.ok !== true) { throw new Error(String((json && json.error) || "读取创作模型目录失败")); }
					state.catalog = normalizeCatalog(json);
					state.fetchedAt = Date.now();
					return state.catalog;
				})
				.catch(() => null)
				.then(catalog => { state.inflight = null; return catalog; });
			return state.inflight;
		}

		/** 选一个模型 ⇒ 记住（Host 侧落盘）⇒ 重画菜单行与列表。 */
		function pick(kind, providerId, modelId) {
			if (state.busy) { return; }
			state.busy = true;
			fetch(API + "default", {
				method: "POST",
				headers: authHeaders({ "content-type": "application/json" }),
				body: JSON.stringify({ kind, provider: providerId, model: modelId }),
			})
				.then(r => r.json().catch(() => null))
				.then(json => {
					if (!json || json.ok !== true) { throw new Error(String((json && json.error) || "保存失败")); }
					state.catalog = normalizeCatalog(json);
					state.fetchedAt = Date.now();
					state.openKind = "";
					renderMenuRows();
					closePop();
					// 选完就把下拉框收起来（与官方子菜单"选一个就关"一致）。
					// ⚠ 真机上不显式收的话，Radix 会在我们把弹层 DOM 拆掉的过程中**自己**关掉 ——
					//   有时关有时不关 ⇒ 显式发一次 Escape，行为确定 ✓（jsdom 里没有 Radix，守卫看不到这层）
					const menu = document.querySelector(MENU_SELECTOR);
					if (menu) { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); }
				})
				.catch(e => toast("没能选中：" + String((e && e.message) || e)))
				.then(() => { state.busy = false; });
		}

		// ── 菜单里的三行 ────────────────────────────────────────────────────────
		function renderMenuRows() {
			const wrap = document.querySelector("[" + MARK + "-wrap]");
			if (!wrap) { return; }
			const rows = menuRows(state.catalog);
			// ★ 分组标题点明"这不是语言模型"（用户曾在真机上把「图片模型」当聊天模型点）
			wrap.innerHTML = '<div ' + MARK + '-sep="1"></div><div ' + MARK + '-cap="1">创作模型 · 图片 / 视频 / 音频</div>'
				+ rows.map(row => {
					const value = row.modelName
						? '<span class="vc-val">' + esc(row.modelName)
							+ (row.providerName ? '<span ' + MARK + '-badge="1">' + esc(row.providerName) + "</span>" : "")
							+ '<span class="vc-chev">' + ICONS.chev + "</span></span>"
						: '<span class="vc-val"><span class="vc-none">未选</span><span class="vc-chev">' + ICONS.chev + "</span></span>";
					return '<button type="button" ' + MARK + '-row="1" data-kind="' + esc(row.kind) + '" role="menuitem">'
						+ '<span class="vc-ico">' + (ICONS[row.icon] || "") + "</span>"
						+ '<span class="vc-lb">' + esc(row.label) + "</span>"
						+ (row.blocked ? '<span class="vc-warn" title="这一类的模型现在都用不了"></span>' : "")
						+ value + "</button>";
				}).join("");
			// ★ 兜底绑定（2026-10-23 真机：分组渲染出来了，但**点行没反应**）。
			//   原本只靠 `install()` 里的文档级委托（`onDocClick`，捕获阶段）。实测这条路可能不命中：
			//   官方菜单是 Radix 的 **portal**，行节点在 body 下的容器里，而 Radix 自己的
			//   指针事件/DismissableLayer 可能先处理掉这次点击（表现为"点了没反应"），
			//   另一头 `scan()` 在菜单重渲染时还会 `closePop()` ⇒ 就算开了也会立刻被收掉。
			//   ⇒ 这里给每行**直接绑一次**，并停掉冒泡；与委托幂等（打标记防重复绑）。
			//   ⚠ `renderMenuRows` 会被多次调用，必须用标记去重，否则一次点击开两次面板。
			[].slice.call(wrap.querySelectorAll("[" + MARK + "-row]")).forEach((btn) => {
				if (btn.getAttribute(MARK + "-bound") === "1") { return; }
				btn.setAttribute(MARK + "-bound", "1");
				/**
				 * ★★ 关键（2026-10-23 自动测试抓到）：Radix 的 DismissableLayer 判定"点了外面"看的是
				 *   **pointerdown**，不是 click。只拦 click 的后果实测如下：
				 *     点「图片模型」→ 面板正常；点「视频模型」→ **整个菜单被关掉** ⇒ 挂载在菜单里的
				 *     我们的面板被连带卸载 ⇒ 表现为"点了没反应 / 二级页面不显示"（且无法稳定复现）。
				 *   ⇒ 必须在 pointerdown / mousedown 的**捕获阶段**就吃掉，并用 stopImmediatePropagation
				 *     挡掉 Radix 绑在同一节点上的监听。
				 */
				/**
				 * ⚠⚠ 只能绑**一个** `pointerdown`，并在它里面**直接打开面板**。
				 *
				 * 两次翻车记录（都是同一个坑的两面）：
				 *   ① 只绑 `click` ⇒ Radix 的 DismissableLayer 在 pointerdown 就判"点了外面"⇒ 菜单被关、
				 *      挂在菜单里的面板连带卸载 ⇒ 表现为"点了没反应"。
				 *   ② 于是加了 `pointerdown` 拦截（`preventDefault` + `stopImmediatePropagation`），
				 *      但**仍把开面板的逻辑留在 `click` 上** ⇒ `pointerdown.preventDefault()` 会**抑制
				 *      后续 click 的派发** ⇒ click 处理器根本不跑 ⇒ 三个二级页面全部打不开（用户报的就是这个）。
				 *
				 * ⇒ 正确做法：在 `pointerdown` 里一次做完"拦事件 + 开面板"，**不再依赖 click**。
				 */
				btn.addEventListener("pointerdown", (ev) => {
					ev.preventDefault();
					ev.stopPropagation();
					if (typeof ev.stopImmediatePropagation === "function") { ev.stopImmediatePropagation(); }
					const kind = btn.getAttribute("data-kind") || "";
					if (!kind) { return; }
					if (state.openKind === kind) { closePop(); return; }
					openKind(kind, btn);
				}, true);
			});
		}

		/** 真的把分组挂进官方菜单（幂等）。 */
		function appendWrap(menu) {
			// ★ 关闭态：LLM 菜单里一个创作模型节点都不挂（连 wrap 壳都不建 ⇒ 视觉与读屏都干净）。
			if (!SHOW_IN_LLM_MENU) { return; }
			if (!menu || state.unavailable || menu.querySelector("[" + MARK + "-wrap]")) { return; }
			const wrap = document.createElement("div");
			wrap.setAttribute(MARK + "-wrap", "1");
			// role=group：让读屏把"创作模型"当成一个子组，而不是插进官方那两行里
			wrap.setAttribute("role", "group");
			wrap.setAttribute("aria-label", "创作模型");
			menu.appendChild(wrap);
			renderMenuRows();
		}

		/**
		 * 在官方菜单里插入我们的分组（幂等）。
		 * ⚠ **先拿到目录才挂**：老桥插件（404）时如果"先挂再删"，`remove()` 会再触发 MutationObserver
		 *   ⇒ `scan()` 又把空壳挂回去 ⇒ append/remove **无限循环**（实测把守卫跑成超时）✗
		 */
		function injectIntoMenu(menu) {
			if (!menu || state.unavailable || menu.querySelector("[" + MARK + "-wrap]")) { return; }
			// 有缓存（30s 内看过一次）⇒ 同步画，菜单打开就没有空白期
			if (state.catalog) { appendWrap(menu); return; }
			void loadCatalog(false).then(catalog => {
				if (!catalog || state.unavailable || !menu.isConnected) { return; }   // 老桥 / 菜单已关
				appendWrap(menu);
			});
		}

		// ── 我们的二级列表（fixed 定位；不参与官方 Radix 的焦点/键盘）──────────────
		function closePop() {
			state.openKind = "";
			const pop = document.querySelector("[" + MARK + "-pop]");
			if (pop) { pop.removeAttribute("data-open"); pop.innerHTML = ""; }
		}

		/**
		 * 列表容器。
		 * ⚠ 必须挂在**官方菜单节点里**（而不是 body）：Radix 的菜单有"指针/焦点离开就关"的
		 *   DismissableLayer —— 浮层在 body 上时，一点它的搜索框，焦点离开菜单 ⇒ **整个下拉框自动关掉**
		 *   （真机实测：点了我们的行，菜单立刻消失 ✗）。挂成菜单的**DOM 子节点**后，
		 *   Radix 认为指针/焦点还在层内 ⇒ 不关；`position:fixed` 又能跳出菜单的 overflow 裁剪 ✓
		 */
		function ensurePop() {
			// ★ 一律挂 body（2026-10-23 自动测试改的，推翻了原来的做法）。
			//
			// 原来挂在官方菜单节点里，理由是让 Radix 认为"指针还在层内"从而不关闭菜单
			// （否则一点搜索框，整个下拉就关了）。但代价很大：**菜单一关，挂在里面的面板被连带卸载**
			// ⇒ 表现为"点某个模型类别，二级页面不显示"（实测点「视频模型」就这么消失，图片那次是侥幸）。
			//
			// 现在改成双保险：① 在类别行上用 pointerdown 捕获阶段吃掉事件 ⇒ Radix 不会关菜单；
			//                  ② 面板挂 body ⇒ 即使菜单关了，面板仍然在、仍然可操作。
			const host = document.body;
			let pop = host.querySelector("[" + MARK + "-pop]");
			if (!pop) {
				pop = document.createElement("div");
				pop.setAttribute(MARK + "-pop", "1");
				pop.setAttribute("role", "menu");
				host.appendChild(pop);
			}
			return pop;
		}

		/** 把列表摆到菜单右边（右边放不下就放左边），与触发行的顶对齐。 */
		function placePop(pop, rowEl) {
			/**
			 * ★ 锚点优先用 `state.anchorRect`（打开那一刻量的）：
			 *   菜单与我们的行可能已被 Radix 卸载 ⇒ 现场取值全是 0 ⇒ 面板会贴到左上角（实测症状）。
			 */
			let anchor = (state.anchorRect && state.anchorRect.width) ? state.anchorRect : null;
			if (!anchor) {
				const el = rowEl || findMenu().el;
				anchor = el ? el.getBoundingClientRect() : null;
			}
			if (!anchor || !anchor.width) {
				// 最后兜底：拿模型 chip（触发器）当锚点，至少落在右下角而不是左上角
				const chip = document.querySelector('[aria-haspopup="menu"]');
				anchor = chip ? chip.getBoundingClientRect() : null;
			}
			if (!anchor) { return; }
			/**
			 * ★★ 定位口径（2026-10-23 用户截图确认）：
			 *   · **底部紧贴 chip（模型触发器）的上沿**，留 8px 缝
			 *   · **右边缘与 chip 右边缘对齐**
			 *   · 上方装不下 ⇒ 改为从 chip 下方展开（不能跑到屏幕外）
			 *   ⇒ 所以锚点必须是 **chip**，不是菜单：菜单的 top 由官方算，底边与 chip 之间会有缝。
			 */
			const chip = (state.chipRect && state.chipRect.width) ? state.chipRect : null;
			const base = chip || anchor;
			const width = Math.min(360, Math.max(280, anchor.width || 360));
			// 高度上限：贴 chip 时，可用空间就是 chip 上沿到视口顶
			const avail = chip ? Math.max(180, chip.top - 16) : Math.max(180, window.innerHeight - 24);
			pop.style.maxHeight = Math.min(420, avail) + "px";
			const h = pop.offsetHeight || 320;
			let left = base.right - width;
			left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
			let top;
			if (chip) {
				top = chip.top - 8 - h;                    // 底部贴 chip 上沿
				if (top < 8) { top = chip.bottom + 8; }    // 上方放不下 ⇒ 往下展开
			} else {
				top = anchor.top;
				if (top + h > window.innerHeight - 8) { top = anchor.top - h - 8; }
			}
			top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
			pop.style.left = Math.round(left) + "px";
			pop.style.top = Math.round(top) + "px";
			pop.style.width = width + "px";
		}

		function renderPop(kind) {
			const pop = ensurePop();
			// 首次打开才自动聚焦搜索框（输入会触发重渲染，每次都 focus 会把光标位置重置）
			const wasOpen = pop.getAttribute("data-open") === "1";
			// ★ 只列出**已接入**的模型（2026-10-23 用户要求）。
			//   判据沿用原来的 `reasonFor(m, provider)`：返回非空 = dsh 侧还没接入这个模型。
			//   ⇒ 那种"能看不能选"的行从列表里去掉（纯噪音）；但**数量仍在 footer 如实报出**，
			//     不让人以为"这类就只有这么几个模型"（信息不丢，只是不占列表）。
			const allGroups = groupModels(state.catalog, kind);
			/**
			 * ★ 判定"是否已接入"。
			 *
			 * ⚠ 必须 try/catch（2026-10-23 回归修复）：原来 `reasonFor()` 只在**渲染每一行**时、
			 *   对**已过滤**的模型调用；加过滤后它被移到**所有模型**上 ⇒ 个别模型字段不全时它会抛错，
			 *   而异常发生在 `renderPop` 开头 ⇒ **整个面板渲染中断**（症状：点了图片/视频/音频，什么都不弹）✗
			 *   现在的口径：判不了就**照列**（宁可多显示一个，也不要让整块面板消失），并记账供 probe 查看。
			 */
			const usable = (m, p) => {
				try { return !reasonFor(m, p); } catch { state.filterErrors = (state.filterErrors || 0) + 1; return true; }
			};
			const groups = allGroups.map(g => ({
				provider: g.provider,
				models: g.models.filter(m => usable(m, g.provider) && matches(m, g.provider, state.q)),
			})).filter(g => g.models.length > 0);
			const totalAll = allGroups.reduce((n, g) => n + g.models.length, 0);
			const total = allGroups.reduce((n, g) => n + g.models.filter(m => usable(m, g.provider)).length, 0);
			const pending = totalAll - total;
			const shown = groups.reduce((n, g) => n + g.models.length, 0);
			const body = groups.length === 0
				? '<div class="vc-grp" style="padding:14px 9px">' + (state.q ? "没有匹配的模型" : "这一类还没有已接入的模型") + "</div>"
				: groups.map(g => {
					const st = g.provider.status || {};
					const dot = st.expired || st.signedIn === false
						? (st.signingIn ? "warn" : (st.expired ? "warn" : ""))
						: "ok";
					const label = st.expired ? "登录已失效" : (st.signedIn === false ? (st.signingIn ? "登录中" : "未登录") : "已登录");
					return '<div class="vc-grp"><span class="vc-nm">' + esc(g.provider.name) + "</span>"
						+ '<span class="vc-route">' + esc(g.provider.route) + "</span>"
						+ '<span class="vc-st"><span class="vc-dot ' + dot + '"></span>' + esc(label) + "</span></div>"
						+ g.models.map(m => {
							const why = reasonFor(m, g.provider);
							const picked = selectedOf(state.catalog, kind);
							const on = picked && picked.provider.id === g.provider.id && picked.model.id === m.id;
							const meta = why ? '<span class="vc-why">' + esc(why) + "</span>"
								: (priceText(m, g.provider) ? '<span class="vc-price">' + esc(priceText(m, g.provider)) + "</span>" : "");
							const sub = [m.id].concat(Array.isArray(m.tags) ? m.tags : []).join(" · ");
							return '<button type="button" class="vc-item"' + (on ? " data-on=\"1\"" : "") + (why ? " data-off=\"1\"" : "")
								+ ' aria-disabled="' + (why ? "true" : "false") + '" data-pick="' + esc(g.provider.id) + "|" + esc(m.id) + '">'
								+ '<span class="vc-thumb">' + (ICONS[KINDS.find(k => k.id === kind).icon] || "") + "</span>"
								+ '<span class="vc-two"><span class="vc-l1"><span class="vc-nm">' + esc(m.name || m.id) + "</span>"
								+ '<span ' + MARK + '-badge="1">' + esc(g.provider.name) + "</span></span>"
								+ '<span class="vc-l2">' + esc(sub) + "</span></span>"
								+ '<span class="vc-meta">' + meta + "</span></button>";
						}).join("");
				}).join("");
			pop.innerHTML = '<div class="vc-sr"><input data-q type="search" placeholder="搜索'
				+ esc((KINDS.find(k => k.id === kind) || {}).label || "模型") + '…" value="' + esc(state.q) + '" /></div>'
				+ '<div class="vc-list">' + body + "</div>"
				+ '<div class="vc-foot"><span>'
				+ (state.q
					? ('匹配 ' + shown + " 个")
					: ('可用 ' + total + " 个" + (pending > 0 ? (" · 另 " + pending + " 个未接入") : "")))
				+ "</span><span style=\"flex:1\"></span>"
				+ '<span class="vc-link" data-settings="1">在 设置 → 模型 里管理 ›</span></div>';
			pop.setAttribute("data-open", "1");
			// ★ 打开就能打关键词（官方模型菜单就是这个行为）。只在首次打开时聚焦。
			if (!wasOpen) {
				try {
					const q = pop.querySelector("[data-q]");
					if (q && typeof q.focus === "function") { q.focus(); }
				} catch { /* 极端环境 */ }
			}
			return pop;
		}

		function openKind(kind, rowEl) {
			state.openKind = kind;
			state.q = "";
			/**
			 * ★★ 锚点必须**在这一刻**量好并记住（2026-10-23 实测）。
			 *   Radix 在 pointerdown 之后就会把菜单卸载，之后菜单节点、我们注入的行**都不在 DOM 里**
			 *   ⇒ 再调 `getBoundingClientRect()` 得到全 0 ⇒ `left = 0 + gap` ⇒ **面板跑到屏幕最左边**
			 *   （用户截图：面板盖在左侧 hero 上，跟右下角的 chip 完全不对齐）。
			 */
			const anchorEl = findMenu().el || rowEl;
			state.anchorRect = anchorEl ? anchorEl.getBoundingClientRect() : null;
			/**
			 * ★ 还要记住 **chip（触发器）的 rect**：面板的定位口径是
			 *   「底部紧贴 chip 上沿 + 右边缘与 chip 对齐」（用户给了截图）。
			 *   菜单的 rect 做不到这件事（它的 top 由官方决定，底边可能与 chip 有缝）。
			 *
			 * ⚠ chip 只能在这一刻找：菜单卸载后 `aria-controls` 也会消失。
			 *   反查方式来自官方源码：chip 的 `aria-controls = \`${id}-menu\``（id 与菜单节点相同）。
			 */
			let chipEl = null;
			const menuEl = findMenu().el;
			if (menuEl && menuEl.id) {
				chipEl = document.querySelector('[aria-haspopup="menu"][aria-controls="' + menuEl.id + '"]');
			}
			if (!chipEl) {
				const all = [].slice.call(document.querySelectorAll('[aria-haspopup="menu"]'));
				chipEl = all.filter((e) => e.getAttribute("aria-expanded") === "true")[0] || null;
			}
			state.chipRect = chipEl ? chipEl.getBoundingClientRect() : null;
			let pop;
			try {
				pop = renderPop(kind);
			} catch (e) {
				// ★ 兜底：渲染出错也要**弹出面板并说明原因**，绝不允许"点了没反应"
				//   （2026-10-23 就是这么被报的：过滤阶段抛错 ⇒ 整个面板没渲染 ⇒ 三个二级页面全不显示）。
				const p = ensurePop();
				p.innerHTML = '<div class="vc-grp" style="padding:12px 9px;color:#c9a227">'
					+ "面板渲染失败：" + esc(String((e && e.message) || e)) + "</div>";
				p.setAttribute("data-open", "1");
				placePop(p, rowEl);
				return;
			}
			placePop(pop, rowEl);
			const input = pop.querySelector("input[data-q]");
			if (input) { input.focus(); }
		}

		// ── 事件 ────────────────────────────────────────────────────────────────
		function onDocClick(event) {
			const row = event.target && event.target.closest ? event.target.closest("[" + MARK + "-row]") : null;
			if (row) {
				event.preventDefault();
				event.stopPropagation();
				const kind = row.getAttribute("data-kind") || "";
				if (state.openKind === kind) { closePop(); return; }
				openKind(kind, row);
				return;
			}
			const pickEl = event.target && event.target.closest ? event.target.closest("[" + MARK + "-pop] [data-pick]") : null;
			if (pickEl) {
				event.preventDefault();
				event.stopPropagation();
				const parts = String(pickEl.getAttribute("data-pick") || "").split("|");
				const groups = groupModels(state.catalog, state.openKind);
				const hit = groups.map(g => ({ provider: g.provider, model: g.models.find(m => m.id === parts[1]) })).find(x => x.model && x.provider.id === parts[0]);
				const why = hit ? reasonFor(hit.model, hit.provider) : "模型信息缺失";
				if (why) { toast((hit ? String(hit.model.name || hit.model.id) + " 现在用不了：" : "") + why); return; }
				pick(state.openKind, parts[0], parts[1]);
				return;
			}
			if (event.target && event.target.closest && event.target.closest("[" + MARK + "-pop] [data-settings]")) {
				toast("在 设置 → 模型 → LightAI 里登录 / 查看模型");
				return;
			}
			// 点别处 / 点官方其他行 ⇒ 收起我们自己的列表
			if (state.openKind && event.target && event.target.closest && !event.target.closest("[" + MARK + "-pop]")) {
				if (!event.target.closest("[" + MARK + "-row]")) { closePop(); }
			}
		}

		function onKey(event) {
			if (event.key === "Escape" && state.openKind) { closePop(); }
		}

		function onInput(event) {
			const input = event.target;
			if (!input || !input.matches || !input.matches("[" + MARK + "-pop] input[data-q]")) { return; }
			state.q = input.value;
			const pop = document.querySelector("[" + MARK + "-pop]");
			if (!pop || !state.openKind) { return; }
			const fresh = renderPop(state.openKind);
			placePop(fresh, document.querySelector("[" + MARK + "-row][data-kind=\"" + state.openKind + "\"]"));
			const again = fresh.querySelector("input[data-q]");
			if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
		}

		/** 菜单出现/消失都走这里（Radix 每次打开都是新节点 ⇒ 靠观察，不缓存引用）。 */
		function scan() {
			if (typeof document === "undefined" || typeof document.querySelector !== "function") { return; }
			// ★ 不再只认中文 aria-label：那句文案是运行时从 i18n 语言包取的
			//   （runtime 的 js / json 里搜中文都搜不到 ⇒ 英文或改文案的环境下整条链路会静默哑掉）。
			//   findMenu() 先按 label 找，找不到再按**结构**找：
			//   排除我们自己的 pop，要求 role=menu 且 ≥2 个 menuitem、其中 ≥2 个带 chevron
			//   （官方那两行都是"还有下一级"，这个特征比文案稳定）。
			const found = findMenu();
			const menu = found.el;
			/**
			 * ★★ 当前**不是**模型菜单（例如权限菜单）⇒ 把之前注入的分组全部摘掉。
			 *
			 * 为什么必须在这里（而不是只清理"不在当前菜单里的"）：Radix 的 portal 容器会复用，
			 * 先开过模型菜单（注入过三行）再开权限菜单，同一个容器被复用 ⇒ 我们的 wrap 作为
			 * **遗留节点**留在权限菜单里（用户截图：权限菜单中出现「创作模型 · 图片/视频/音频」）。
			 * 而权限菜单不会被 `findMenu()` 返回（label 校验排掉了）⇒ 走的是 `!menu` 分支，
			 * 那段里的清理逻辑必须能处理"menu 为 null"。
			 */
			if (!menu) {
				[].slice.call(document.querySelectorAll("[" + MARK + "-wrap]")).forEach((w) => { w.remove(); });
			}
			if (!menu) {
				/**
				 * ★★ 菜单消失时**不要**清空面板（2026-10-23 自动测试定位到的真因）。
				 *
				 * 原来的 `closePop()` 在这里，后果是：Radix 在我们拦不住的时候（它在 **document 的捕获阶段**
				 * 处理 pointerdown，比绑在行上的捕获更早）会把菜单关掉 ⇒ 下一帧 `scan()` 发现菜单没了
				 * ⇒ 把刚渲染好的面板清成空壳（实测 `w:0 h:0 text:""`）⇒ 用户看到的就是"点了没反应"。
				 *
				 * ⇒ 现在：面板挂在 `body` 上，本来就和菜单是两个独立节点；菜单关了不该连坐。
				 *   面板的关闭交给：再点同一类别（toggle）/ 选中某个模型 / 点面板外。
				 */
				if (state.openKind) { return; }
				closePop();
				return;
			}
			/**
			 * ★★ 清掉"挂错地方"的注入分组（2026-10-24 用户报：**权限 chip 的菜单里仍有三行**）。
			 *
			 * 根因不是判据漏判，而是 **Radix 的 portal 容器复用**：先打开过模型菜单（我们注入过），
			 * 再打开权限菜单时同一个容器被复用 ⇒ 我们的 `[data-vssaros-creative-wrap]` 作为
			 * **遗留节点**留在里面（label 校验管不到"已经存在的节点"）。
			 * ⇒ 每次扫描都把"不在当前菜单里"的 wrap 摘掉。
			 */
			[].slice.call(document.querySelectorAll("[" + MARK + "-wrap]")).forEach((w) => {
				if (!menu.contains(w)) { w.remove(); }
			});

			injectIntoMenu(menu);
			if (state.openKind) {
				// 菜单还开着：列表跟着菜单走（滚动 / 重新定位后 rect 会变）
				const pop = document.querySelector("[" + MARK + "-pop]");
				const row = document.querySelector("[" + MARK + "-row][data-kind=\"" + state.openKind + "\"]");
				if (pop && row) { placePop(pop, row); }
			}
		}

		/**
		 * 找官方模型菜单。**多候选**：aria-label 的文案是运行时从 i18n 语言包取的
		 * （在 runtime 的 js/json 里搜中文都搜不到 ⇒ 别把中文写死当唯一判据）。
		 * 候选顺序：确切 aria-label（中文）→ 结构匹配（含多个 menuitem 且带 chevron 的 role=menu）。
		 */
		/**
		 * 找**一级**模型菜单（含「模型」「推理等级」两行的那个）。
		 *
		 * 三次被真机打回的经验，按顺序记下来（避免再退回去）：
		 *   ① 只按 `aria-label` 找 ⇒ 子菜单可能继承同一个 label ⇒ 曾把分组注入进 LLM 列表里 ✗
		 *   ② 用 DOM 祖先判层级（`closest('[role=menuitem]')`）⇒ Radix 子菜单是 **portal 兄弟节点**，
		 *      而且子菜单打开时主菜单已不在画面里 ⇒ 判不出来 ✗
		 *   ③ 用 "`textContent` 里有 › 的行数" 当判据 ⇒ **官方的 › 是 SVG 图标，不是文本** ⇒
		 *      chevron 计数恒为 0 ⇒ 连一级菜单也挡掉了（用户截图：只剩官方两行）✗✗
		 *
		 * ★ 现在：**行数少**才是这个菜单最本质的特征 —— 一级只有「模型」「推理等级」两行
		 *   （我们注入后最多 5 行），而 LLM 模型列表动辄 4–15 个模型。
		 *   判据顺序：label 含"模型" + 行数 ≤ 5 → 兜底：行数 2–3、每行右侧有箭头元素、且不含 ✓。
		 */
		/**
		 * 找**一级**模型菜单。
		 *
		 * ★★ 2026-10-23 读了官方源码（`@deepseek-ai/dsh-client-ui-model-selection/lib/client.js`，MIT）
		 *    之后改写的版本 —— 前三次返工全是"猜"出来的，源码给出了确定答案：
		 *
		 *   · 触发器：`aria-haspopup="menu"` + `aria-expanded` + **`aria-controls = \`${id}-menu\`**（仅展开时存在）
		 *   · 一级菜单：`role = pane === "model" ? "group" : "menu"`，`aria-label = t("menu.aria")`（模型与推理等级）
		 *   · **LLM 模型列表：`id = \`${id}-models\`` + `role="menu"` + `aria-label = t("menu.model")`**
		 *     ← 它的 label 里也含"模型"！这就是"按 label 找"必然要么注入错位置、要么两个都命中的根因 ✗
		 *
		 *   ⇒ 现在：① 用 `aria-controls` **反查**（最硬，id 精确）；② 按 label + **排除 `-models` 后缀**；
		 *           ③ 兜底：小菜单 + 每行有箭头元素 + 不含 ✓。
		 */
		function findMenu() {
			/**
			 * ⚠ 必须同时排除 `-pop`（我们的面板）和 `-wrap`（我们注入的那个分组本身）：
			 *   实测 wrap 是 `role="group" aria-label="创作模型"` + 3 行，而一级菜单是 5 行
			 *   ⇒ 兜底判据"取行数最少"会把 **wrap 当成一级菜单**（3 < 5）⇒ 自我注入死循环。
			 */
			const isOurs = (m) => m.hasAttribute(MARK + "-pop") || m.hasAttribute(MARK + "-wrap");
			/** ⚠ 源码级排除：`${id}-models` 是 LLM 模型列表的容器，它不是我们该注入的地方。 */
			const isModelList = (m) => /-models$/.test(m.id || "");
			const itemsOf = (m) => [].slice.call(m.querySelectorAll('[role="menuitem"], [role="option"]'));

			// ① 最硬：从触发器的 aria-controls 反查（源码里是 `${id}-menu`，只在展开时挂）
			const triggers = [].slice.call(document.querySelectorAll('[aria-haspopup="menu"][aria-controls]'));
			for (const t of triggers) {
				if (t.getAttribute("aria-expanded") !== "true") { continue; }
				const el = document.getElementById(String(t.getAttribute("aria-controls") || ""));
				/**
				 * ★★★ 必须校验 label（2026-10-24 用户报：**权限 chip 的菜单里也出现了创作模型三行**）。
				 *   根因：权限 chip 与模型 chip **具有相同的 DOM 契约** ——
				 *   `aria-haspopup="menu"` + `aria-controls="${id}-menu"` ⇒ 反查必然命中它。
				 *   ⇒ 只有 label 明确是"模型"菜单才认；权限/审批类一律排除。
				 */
				const lbl = String((el && el.getAttribute("aria-label")) || "");
				const notModelMenu = /权限|审批|permission|approval|access/i.test(lbl);
				const isModelMenu = /模型|model/i.test(lbl);
				if (el && !isOurs(el) && !isModelList(el) && isModelMenu && !notModelMenu) {
					return { el, via: "aria-controls", label: el.getAttribute("aria-label") || "", items: itemsOf(el).length };
				}
			}
			// ② label 含"模型" + 排除模型列表 + 行数少（取行数最少者：一级 2 行，注入后 5 行）
			const menus = [].slice.call(document.querySelectorAll('[role="menu"], [role="group"]'));
			let best = null;
			for (const m of menus) {
				if (isOurs(m) || isModelList(m)) { continue; }
				const label = m.getAttribute("aria-label") || "";
				if (!/模型/.test(label)) { continue; }
				const n = itemsOf(m).length;
				if (n > 5) { continue; }
				if (!best || n < best.items) { best = { el: m, via: "label+small", label, items: n }; }
			}
			if (best) { return best; }
			// ③ ~~兜底：小菜单 + 每行有箭头 + 不含 ✓~~ **已删除**（2026-10-24）。
			//    这条模糊判据正是"权限菜单被当成模型菜单"的通道：权限菜单通常 3 行、
			//    每行都带图标元素、且不含 ✓ ⇒ 完美符合旧兜底的条件。
			//    ⚠ 现在只认 label（`/模型|model/` 且排权限类）；英文环境也由 `/model/i` 覆盖。
			//      万一某天 label 变了导致不注入，**那是可接受的降级**——总比注入到别人的菜单里好。
			return { el: null, via: "none" };
		}

		/**
		 * ★ 排障出口（不依赖真机也能加）：把"三问"暴露出去 —— 菜单找到没 / 注入了没 / 面板开着没。
		 * 为什么需要：菜单相关的问题在真机上只能看到"点了没反应"，看不到是哪一步断的
		 * （选择器没命中？注入被 Radix 重渲染覆盖？二级面板被收掉？）。
		 */
		try {
			window.__vssarosCreative = {
				probe: () => {
					const found = findMenu();
					return {
						menuFound: !!found.el,
						menuVia: found.via,
						menuLabel: found.el ? (found.el.getAttribute("aria-label") || "") : (found.label || ""),
						wrapInjected: !!document.querySelector("[" + MARK + "-wrap]"),
						rowCount: document.querySelectorAll("[" + MARK + "-row]").length,
						popOpen: !!document.querySelector("[" + MARK + "-pop][data-open]"),
						openKind: state.openKind || "",
						catalogLoaded: !!state.catalog,
						unavailable: !!state.unavailable,
						partErrors: (window.__vssarosChatSurface && window.__vssarosChatSurface.partErrors) || null,
					};
				},
			};
		} catch { /* 极端环境没有 window */ }

		/**
		 * 装上（幂等）。**每一项都兜底**：chunk 会被各种环境装载（真页面 / 全窗 / 守卫的极简假 DOM），
		 * 任何一处抛错都会让整个部件挂掉 —— 宁可少一个能力，也不能连累聊天本体 ✓
		 */
		function install() {
			if (state.installed) { return; }
			state.installed = true;
			const doc = typeof document !== "undefined" ? document : null;
			if (!doc) { return; }
			try {
				const style = doc.createElement("style");
				style.setAttribute(MARK + "-style", "1");
				style.textContent = CSS;
				(doc.head || doc.documentElement).appendChild(style);
			} catch { /* 极简环境没有 head ⇒ 只是没有样式，不影响逻辑 */ }

			/**
			 * ★ 与**官方模型菜单统一**（2026-10-23 用户要求"统一二级页面的 UI 样式"）。
			 *
			 * 为什么单独一层而不是改上面的 CSS 常量：这些值是**照官方菜单量出来的**，
			 * 单独放一段便于"官方换皮时只调这一处"，也不会把原有布局规则搅乱。
			 * 实测对照（官方 一级菜单）：背景 #2b2b2b、边框 ≈ rgba(255,255,255,.09)、
			 * 圆角 ≈10px、行高 ≈32px、正文 12.5px、选中 = 淡蓝底（不是白底）。
			 *
			 * ⚠ 模型行比官方多一行副标题（id · tags）：不删信息，只把副标题压小压暗，
			 *   让主行的字重/字号/行高与官方一致 ⇒ 视觉上仍像官方那种"一行一项"。
			 */
			try {
				const uni = doc.createElement("style");
				uni.setAttribute(MARK + "-style", "2");
				uni.textContent = [
					"[" + MARK + "-pop]{background:#2b2b2b !important;border:1px solid rgba(255,255,255,.09) !important;border-radius:10px !important;padding:4px !important;box-shadow:0 12px 34px rgba(0,0,0,.5) !important}",
					"[" + MARK + "-pop] .vc-sr{padding:3px 3px 6px !important}",
					"[" + MARK + "-pop] .vc-sr input{background:#242424 !important;border:1px solid rgba(255,255,255,.10) !important;border-radius:7px !important;padding:5px 8px !important;font-size:12px !important;color:#e8e8e8 !important}",
					"[" + MARK + "-pop] .vc-sr input::placeholder{color:#8b8b8b !important}",
					"[" + MARK + "-pop] .vc-grp{padding:6px 8px 2px !important;font-size:11px !important;gap:6px !important}",
					"[" + MARK + "-pop] .vc-grp .vc-nm{color:#b8b8b8 !important;font-weight:600 !important}",
					"[" + MARK + "-pop] .vc-grp .vc-route{color:#7f7f7f !important}",
					"[" + MARK + "-pop] .vc-grp .vc-st{color:#8b8b8b !important}",
					"[" + MARK + "-pop] .vc-item{min-height:34px !important;border-radius:7px !important;padding:4px 8px !important;gap:8px !important}",
					"[" + MARK + "-pop] .vc-item .vc-l1{font-size:12.5px !important;line-height:1.35 !important;color:#e8e8e8 !important}",
					"[" + MARK + "-pop] .vc-item .vc-l2{font-size:10.5px !important;line-height:1.3 !important;color:#8b8b8b !important;margin-top:1px !important}",
					"[" + MARK + "-pop] .vc-item:hover{background:rgba(255,255,255,.07) !important}",
					"[" + MARK + "-pop] .vc-item[data-on]{background:rgba(77,170,252,.16) !important}",
					"[" + MARK + "-pop] .vc-item[data-off]{opacity:.55 !important}",
					"[" + MARK + "-pop] .vc-thumb{width:16px !important;height:16px !important;opacity:.85 !important}",
					"[" + MARK + "-pop] .vc-meta{gap:6px !important}",
					"[" + MARK + "-pop] .vc-why{color:#c9a227 !important;font-size:10.5px !important}",
					"[" + MARK + "-pop] .vc-price{color:#8b8b8b !important;font-size:10.5px !important}",
					"[" + MARK + "-pop] .vc-foot{padding:5px 8px 3px !important;font-size:11px !important;color:#8b8b8b !important;border-top:1px solid rgba(255,255,255,.07) !important}",
					"[" + MARK + "-pop] .vc-link{color:#4daafc !important}",
					// 我们注入的那三行也统一：行高 32px、正文 12.5px、右侧值用官方那种暗色
					"[" + MARK + "-cap]{color:#8b8b8b !important;font-size:11px !important;padding:8px 8px 3px !important}",
					"[" + MARK + "-row]{min-height:32px !important;border-radius:7px !important;font-size:12.5px !important;padding:0 8px !important;gap:8px !important}",
					"[" + MARK + "-row] .vc-lb{color:#e8e8e8 !important}",
					"[" + MARK + "-row] .vc-val{color:#8b8b8b !important;font-size:12px !important}",
					"[" + MARK + "-row]:hover{background:rgba(255,255,255,.07) !important}",
					"[" + MARK + "-row] .vc-chev{color:#8b8b8b !important}",
					"[" + MARK + "-badge]{font-size:9.5px !important;padding:0 4px !important;border-radius:3px !important;background:rgba(255,255,255,.08) !important;color:#a8a8a8 !important}",
					/**
					 * ★★ "三行只在**一级菜单**里出现"（2026-10-23 用户明确要求"希望分开"）。
					 *
					 * 判据来自官方源码（`lib/client.js`）：那个菜单容器是**同一个节点**在切 pane ——
					 *   `role: pane === "model" ? "group" : "menu"`
					 *   · `pane !== "model"`（一级：模型 / 推理等级两行） ⇒ `role="menu"` ⇒ 我们的三行显示 ✓
					 *   · `pane === "model"`（LLM 模型列表 + 搜索框）  ⇒ `role="group"` ⇒ 我们的三行**必须隐藏** ✗
					 *
					 * ⇒ 纯 CSS 就够：不需要 JS 参与，pane 来回切时显隐**自动**跟随（点模型消失、返回出现）。
					 * ⚠ 为什么不用 `[aria-label]` 判断：那个 label 在两种 pane 下是同一个值，区分不了。
					 */
					'[role="group"] > [' + MARK + '-wrap]{display:none !important}',
				].join("\n");
				(doc.head || doc.documentElement).appendChild(uni);
			} catch { /* 没有 head ⇒ 少一层视觉对齐，功能不受影响 */ }
			if (typeof doc.addEventListener === "function") {
				doc.addEventListener("click", onDocClick, true);
				doc.addEventListener("keydown", onKey, true);
				doc.addEventListener("input", onInput, true);
				/**
				 * 面板独立于菜单存活之后，必须自己判"点了外面"来收起（否则面板会一直挂着）。
				 * ⚠ 单独一条监听，不去改 `onDocClick`：那条里已经有两段 return（我们的行 / 选模型），
				 *   在里面插"点外面关闭"很容易把选取动作误判成外部点击。
				 * ⚠ 点我们自己的类别行不算"外面"（那是 toggle 入口）。
				 */
				doc.addEventListener("pointerdown", (ev) => {
					const popEl = document.querySelector("[" + MARK + "-pop][data-open]");
					if (!popEl) { return; }
					const t = ev.target;
					if (!t) { return; }
					if (popEl.contains(t)) { return; }
					if (typeof t.closest === "function" && t.closest("[" + MARK + "-row]")) { return; }
					closePop();
				}, true);
			}
			if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
				window.addEventListener("resize", () => { scan(); }, true);
			}
			// 官方菜单每次打开都是**新节点** ⇒ 只能观察；没有 MutationObserver 的环境就只扫这一次
			if (typeof MutationObserver === "function" && doc.body) {
				try {
					new MutationObserver(() => { scan(); }).observe(doc.body, { childList: true, subtree: true });
				} catch { /* 观察失败：菜单第一次打开时仍会注入（scan 自己跑过一次） */ }
			}
			scan();
		}

		exports.install = install;
		exports.__test = {
			KINDS, API, MENU_SELECTOR, MARK,
			reasonFor, normalizeCatalog, groupModels, selectedOf, menuRows, priceText, matches,
			// 守卫用：`scan` 是"菜单出现 ⇒ 注入"的入口（MutationObserver 在 jsdom 里也异步，
			// 直接调它能让断言不依赖调度顺序）
			scan, closePop, state,
		};
		return module.exports;
	}
});
