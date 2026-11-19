// @vssaros/dsh-kb-refs — client half: 在聊天输入框里注册一个「知识库」`@` 引用源（2026-10-14，P1-1 ＋ P1-2）。
//
// 取舍写清楚（都是刻意的，不是省略）：
//   ① 同源 HTTP：候选走 `/x/kb/api/references?q=`，附正文走 `/x/kb/api/doc?uri=`。
//      空 `@` 按更新时间列真实文章，关键词复用正文检索；目录、隐藏项和非 Markdown 不成为文章候选。
//      文章引用分组优先于文件与会话；原始 URI 由服务端提供，客户端不改写。
//   ② **默认引用 = 指针**（D2 的口径）：`ref` 就是服务端返回的 `uri` **原样** ——
//      `kb_read` 的参数注释原话是"文档 uri（kb_search 返回的那个）或 vault 内相对路径" ✓
//      ⇒ 客户端**一点路径改写都不做** ✓（不做就不会错；kb 页那个 `normUri` 的坑也就绕开了 ✓）。
//   ③ **"附正文" = 同一行的另一种引用种类**（P1-2）：`ref` 加一个**可逆**前缀 `body:`（`file:///…` 永不以
//      `body:` 开头 ⇒ 无歧义 ✓），正文在**提交期**（`codec.serialize`）才取 ⇒ "发送时快照"语义 ✓。
//      ★ 为什么**不**用 composer 的附件通道 ✗：`SubmitAttachment` 只有 `image` 与 `file`＋`receiptId` 两种，
//        receipt 由 composer 自己的上传流产生 ⇒ **引用源造不出附件** ✓（契约上根本没有这条路）。
//      ★ 为什么**做不了**"鼠标点 chip 切换" ✗：chip 的 `label`/`appearance`/`clipboardText` 是**插入期缓存**
//        （`Occurrence` 注释原话："insert-time cache"），而外面能做的插入只有
//        `slash/input-insert-reference` 与 `-text`（**都按 span**）⇒ 改已有 chip 没有可用的口子 ✓。
//        ⇒ 诚实的等价物是"**插入期选择**"：种类写进 `label`（chip 上就看得见「（附正文）」✓），
//        入口仅为 `@` / `@关键词` / `@+关键词`，不在输入工具栏挂独立知识库 chip。
//        聚合 `@` 菜单不绘制知识库面包屑，以免被误认为文件列表的当前范围。
//   ④ **失败策略分档**（不是一刀切）：候选失败一律静默 ✓（官方契约：某个域失败不影响其它域）；
//      而 `codec.serialize` 里 —— 指针引用**永不 reject**（P1-1 ✓）；**附正文引用失败就 reject** ——
//      契约原话是 "failure blocks the send — never a silent downgrade to the clipboard text" ✓。
//      正文才是这次引用**唯一的意义**所在，用户明确要了就不能悄悄降级成指针 ✗。
window.__ModuleLoader__.load({
	id: "@vssaros/dsh-kb-refs",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const NAME = "vssaros-kb-refs-client";
		/** 菜单分组标题也是它；同时是 `codec` 的路由键（pipeline 按 `source` 找回本 source）✓。 */
		const SOURCE_NAME = "知识库";
		const SEARCH_ROUTE = "/x/kb/api/references";
		/** 只读取正文；**与 `kb_read` 同一条围栏** ✓（kb 侧同一个 `readDoc`）。 */
		const DOC_ROUTE = "/x/kb/api/doc";
		/** 候选行上限（菜单是"选一次"，不是搜索结果页 ✓）。 */
		const MAX_ROWS = 12;
		/** Articles precede the default file/session group so bare @ makes them discoverable. */
		const GROUP_ORDER = -10;
		/** "附正文"的种类标记：`ref` 的前缀（可逆 ✓，`file:///…` 不会撞 ✓）。 */
		const ATTACH_PREFIX = "body:";
		/**
		 * "附正文"模式下，`@` 后紧跟的**模式前缀**：`@+关键词` ⇒ 附正文；`@关键词` ⇒ 指针（默认 ✓）。
		 * 为什么要有这么个前缀 ✗：插入期没有第二个"品种开关"的口子（见文件头 ③）⇒ 用查询前缀表达 ✓。
		 */
		const ATTACH_MARKER = "+";
		/**
		 * 单条"附正文"的字符上限（**不静默截断**：超了就如实写明 + 给出 `kb_read` 的退路 ✓）。
		 * ⚠ 这个上限是**本包独占**的：dsh 侧没有给"客户端引用"的共享预算表（`toolSearchAssembler` 那个 80
		 *   是**工具**面的、另一处治理）⇒ 将来若要统一，应该从"一处配置"而不是各包各写一个常数 ✗。
		 */
		const MAX_ATTACH_CHARS = 32 * 1024;

		/**
		 * 自证标记（本仓惯例 ✓）：把"插件真加载了、`registerSource` 真跑了"变成页面上**可观测的事实**。
		 * 为什么必须有它：这一跳写错了**不报错**（页面不崩、Host 不报），只能从"菜单里有没有我们那组"倒推 ✗；
		 * 而菜单要**有会话/composer**才出得来 ⇒ 在裸 Host（没配模型）里根本验证不到 ✓。
		 * 值：`'1'` = 注册成功；`'no-inputTriggers'` / `'error:…'` = 失败（**如实记原因**，不静默 ✗）。
		 */
		function mark(value) {
			try {
				if (document && document.documentElement) { document.documentElement.dataset.vssarosKbRefs = String(value); }
			} catch (e) { /* 无所谓 ✓ */ }
		}

		/** 这一条 ref 是"附正文"吗。 */
		const isAttachRef = ref => String(ref).slice(0, ATTACH_PREFIX.length) === ATTACH_PREFIX;
		/** 取出真正的 uri（两种种类都返回**服务端原样**的 uri ✓）。 */
		const uriOfRef = ref => { const s = String(ref); return isAttachRef(s) ? s.slice(ATTACH_PREFIX.length) : s; };
		/**
		 * 解析查询：`@+前 缀` ⇒ `{attach:true, query:关键词}`；`@关键词` ⇒ 指针模式 ✓。
		 * ⚠ 解析只作用于**用户输入层**（`req.query` 就是"`@` 与光标之间的文本" ✓）——
		 *   笔记正文里的 `@x` 永远走不到这里 ✓（Roo/Cline 踩过"被引用正文里的 `@` 误触发"的坑 ✓）。
		 */
		function parseQuery(query) {
			const text = String(query || "");
			if (text.charAt(0) !== ATTACH_MARKER) { return { attach: false, query: text.trim() }; }
			return { attach: true, query: text.slice(ATTACH_MARKER.length).trim() };
		}

		const LOCALE_NS = "vssaros.kbRefs";
		const zh = { title: "知识库", articles: "知识库文章", suffix: "（附正文）" };
		const en = { title: "Knowledge Base", articles: "Knowledge Articles", suffix: " (body included)" };
		let translate = key => zh[key];

		/** Display paths never change the URI handed to the reference codec. */
		function articlePath(item) {
			try {
				const parts = new URL(item.uri).pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part));
				const vaultIndex = parts.indexOf(String(item.vaultId || ""));
				const sectionIndex = parts.findIndex(part => part === "知识库列表" || part === "数据源");
				const start = vaultIndex >= 0 ? vaultIndex + 1 : (sectionIndex >= 0 ? sectionIndex : Math.max(0, parts.length - 2));
				return parts.slice(start).join("/");
			} catch { return String(item.title || ""); }
		}
		function articleCandidate(item, attach) {
			const path = articlePath(item);
			const vault = String(item.vaultName || item.vaultId || translate("title"));
			return {
				name: String(item.vaultId || vault) + "/" + path,
				label: String(item.title || path) + (attach ? translate("suffix") : ""),
				section: translate("articles"),
				icon: "file",
				description: [vault, path, String(item.snippet || "").replace(/\s+/g, " ").slice(0, 100)].filter(Boolean).join(" · "),
				value: (attach ? ATTACH_PREFIX : "") + item.uri,
			};
		}
		async function searchArticles(query, signal) {
			const res = await fetch(SEARCH_ROUTE + "?q=" + encodeURIComponent(query.trim()) + "&limit=" + MAX_ROWS, { credentials: "same-origin", signal });
			if (!res.ok) { throw new Error("HTTP " + res.status); }
			const body = await res.json();
			if (!body || body.ok === false || !Array.isArray(body.items)) { throw new Error("Invalid knowledge search response"); }
			return body.items.filter(item => item && typeof item.uri === "string" && item.uri).slice(0, MAX_ROWS);
		}
		async function candidates(_session, req) {
			const parsed = parseQuery(req && req.query);
			try {
				return (await searchArticles(parsed.query, req && req.signal)).map(item => articleCandidate(item, parsed.attach));
			} catch { return []; }
		}

		/**
		 * 行本体 pick = 把这一行解析成**原子引用**；面包屑的 drill = **换种类**（把查询改成那一档 ✓）。
		 * ⚠ 落进草稿与 span-CAS 由 pipeline 负责（契约原话："claim/insert outcomes are executed by the
		 * pipeline via the scoped input events" ✓）⇒ 我们**不自己碰 DOM / 不自己 emit 事件** ✓。
		 */
		function onPick(pick) {
			const candidate = pick && pick.candidate;
			const value = candidate && typeof candidate.value === "string" ? candidate.value : "";
			if (pick && pick.action === "drill") {
				// 面包屑 / Tab 下钻：`text` 是**新的查询文本**（trigger 留着 ⇒ menu 保持开着 ✓）
				return { text: value, continue: true };
			}
			if (!value) { return undefined; }
			// `value` 里已经带着种类（`candidates` 编好的 ✓）⇒ 这里**不再判断模式**（也判断不了 ✓）
			const attach = isAttachRef(value);
			return {
				insert: {
					source: SOURCE_NAME,
					ref: value,
					label: (candidate && candidate.label) || uriOfRef(value),
					appearance: "file",
					// 剪贴板/持久化投影：附正文那条**把种类一起写出来**（否则粘回去就只剩个路径，读者不知道
					// 当初是要带正文的 ✗）—— 但**不写** `body:` 那种内部前缀（粘出来像乱码 ✗）
					clipboardText: attach ? uriOfRef(value) + "（附正文）" : value,
				},
			};
		}

		/** 取正文：只读路由 + **与 `kb_read` 同一围栏** ✓；失败抛错（调用方决定降级还是阻断 ✓）。 */
		async function readBody(uri, signal) {
			const res = await fetch(DOC_ROUTE + "?uri=" + encodeURIComponent(uri), { credentials: "same-origin", signal: signal });
			if (!res.ok) { throw new Error("HTTP " + res.status); }
			const data = await res.json();
			if (!data || data.ok !== true) { throw new Error(String((data && data.error) || "读不到正文")); }
			return { content: String(data.content || ""), truncated: data.truncated === true };
		}

		const codec = {
			clipboardText: (ref) => {
				try {
					const s = String(ref);
					return isAttachRef(s) ? uriOfRef(s) + "（附正文）" : s;
				} catch (e) { return String(ref); }
			},
			/**
			 * 提交期展开成**模型可见文本**（D2 的"指针 + 工具"：把"要用 kb_read 读"讲给模型 ✓）。
			 * ★ 指针引用**永不 reject**：它没 reject 的理由（就算 kb 挂了，那条 uri 本身仍是有效信息 ✓），
			 *   而 reject 会**阻断整次发送**（conversation 的 sinkSerialized 对错误零容忍 ✗）。
			 * ★ 附正文引用**按契约 reject**：读不到正文就是**用户要的东西拿不到** ⇒ 不静默降级成指针 ✓
			 *   （契约原话 "never a silent downgrade"）。超长则**带标记截断**（也不静默 ✗）。
			 */
			serialize: async (ref, signal) => {
				try {
					const raw = String(ref);
					if (!isAttachRef(raw)) { return "@知识库 " + raw + "（指针引用：要正文请用 kb_read 读它）"; }
					const uri = uriOfRef(raw);
					let got;
					try {
						got = await readBody(uri, signal);
					} catch (e) {
						throw new Error("附正文引用拿不到正文：" + String((e && e.message) || e)
							+ "（笔记可能已被删除/移出库；可改用指针引用，或直接用 kb_read 读）");
					}
					const over = got.content.length > MAX_ATTACH_CHARS;
					const content = over ? got.content.slice(0, MAX_ATTACH_CHARS) : got.content;
					const cut = (over || got.truncated)
						? "\n…（正文过长，已截断；完整正文请用 kb_read 读 " + uri + "）"
						: "";
					return "@知识库 " + uri + "（附正文，提交时快照）：\n" + content + cut;
				} catch (e) {
					// ⚠ 这里**必须**继续抛（附正文的阻断语义就是它 ✓）——catch 只为把"内部前缀/uri"这类
					//   上下文补齐，不让用户看到 `body:` 这种内部形态 ✗
					throw e;
				}
			},
		};

		function header(_session, ctx) {
			const query = String((ctx && ctx.query) || "");
			const attach = query.charAt(0) === ATTACH_MARKER;
			const drilled = !!(ctx && ctx.drilled);
			return Object.freeze([
				Object.freeze({ label: translate("title"), value: "", current: !attach && !drilled }),
				Object.freeze({
					label: attach ? translate("articles") + translate("suffix") : ATTACH_MARKER + " " + translate("suffix"),
					value: attach ? "" : ATTACH_MARKER,
					current: attach && drilled,
				}),
			]);
		}

		function apply(ctx) {
			const inputTriggers = ctx.get("inputTriggers");
			if (!inputTriggers) { mark("no-inputTriggers"); return; }
			ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), "kb-refs: dictionaries");
			translate = ctx.locale.bind(LOCALE_NS);
			try {
				ctx.effect(() => inputTriggers.registerSource({
					trigger: "@", name: SOURCE_NAME, order: GROUP_ORDER, candidates, onPick, codec, header,
				}), "kb-refs: @ source");
				mark("1");
			} catch (e) {
				mark("error:" + String((e && e.message) || e).slice(0, 80));
			}
		}

		exports.apply = apply;
		exports.inject = ["inputTriggers", "locale"];
		exports.name = NAME;
		return module.exports;
	}
});
