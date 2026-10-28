// 2026-10-24 touch：client.codebase.js 经变异测试改写后置新（chunk 守卫按 mtime 判）。
// 2026-10-24 touch：client.codebase.js：补 @container ⇒ 入口置新（chunk 守卫按 mtime 判）。
// @vssaros/dsh-codebase — 客户端半（dsh web 的客户端插件；也是本仓**第一张工具卡**）。
//
// 契约来源（README 5.01/5.02/5.09 ✓，全部照官方与看板样板抄，没有自创机制）：
//   · `window.__ModuleLoader__.load({ id, factory })` —— dsh web 的客户端模块契约；
//   · 导出 `apply(ctx)` / `inject`（Cordis 客户端插件）；
//   · 卡片注册：`ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name, key, priority }, Card))`
//     —— keyed 槽按**工具名**注册；`priority: -10` 遮蔽官方通用卡（与看板同口径）。
//
// 取值方式（★ 关键，README 5.09）：结构化数据由 Host 侧以 **`codebase_overview_json: {…}` 文本行**出结果，
// 客户端**解析那一行** ✓ —— 不去解析人读文案 ✗、不走 `meta` ✗、不走会话事件 ✗。
// 那一行的格式由 `p3-11`（Host 侧 render 产出）与 `p3-17`（本文件可服务/在加载器清单里）两侧钉住 ✓。
//
// 分法与看板一致：**解析与摘取是纯函数**（不碰 React）⇒ 探针可直接调它们验 ✓。

window.__ModuleLoader__.load({
	id: '@vssaros/dsh-codebase',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require('react');

		/** keyed 槽：工具调用视图。 */
		const TOOL_SLOT = 'tool.call.toolview';
		/** 本卡接管的工具名（必须与 `lib/index.js` 里 `ctx.tools.register` 的名字**完全一致**）。 */
		const OVERVIEW_TOOL = 'codebase_overview';
		/** 遮蔽官方通用卡的优先级（负值优先，与看板同口径）。 */
		const CARD_PRIORITY = -10;
		/** 机器可读行的前缀（真源：`lib/index.js` 的 `render`；`p3-11` 逐字钉住）。 */
		const JSON_PREFIX = 'codebase_overview_json: ';

		function isRecord(value) {
			return typeof value === 'object' && value !== null && !Array.isArray(value);
		}

		/** 取出一次工具调用的"结果文本数组 / 是否报错"（看板 `parseBlock` 的同口径子集）。 */
		function parseBlock(block) {
			const out = { texts: [], isError: false, toolName: undefined };
			if (!isRecord(block)) {
				return out;
			}
			out.isError = block.isError === true;
			if (isRecord(block.call) && typeof block.call.name === 'string') {
				out.toolName = block.call.name;
			}
			const content = block.content;
			if (Array.isArray(content)) {
				out.texts = content
					.map(part => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
					.filter(Boolean);
			}
			return out;
		}

		/**
		 * 从结果文本里摘出卡片要的字段（**纯函数** ⇒ 可被探针直接验 ✓）：
		 * 机器行优先 ✓，解析不出来就回落到"没有人读行"的降级形态 ✓（卡片仍显示人读那一行 ✓，不空白 ✗）。
		 */
		function summarize(block) {
			const { texts, isError } = parseBlock(block);
			let data;
			// ★ `meta` **优先**（报告 §5-11 / README 5.98，与第二张卡同款）：结构化元数据随会话日志持久化
			//   ⇒ 卡片不再依赖解析人读文本 ✓。⚠ 两类情形**必须**继续回落文本 ✗（所以下面那段解析留着 ✓）：
			//   ① **旧日志**：本仓 5.09 之前写下的调用记录里没有 meta ✓；② **嵌套调用**：官方只为顶层调用
			//   算 meta ✓（`dsh-client-ui-tool` 的 `read_image` 注释就是这么写的 ✓）。
			if (isRecord(block) && isRecord(block.meta) && block.meta.shape === 'codebase-overview') {
				data = block.meta;
			}
			for (const text of texts) {
				if (data !== undefined || !text.startsWith(JSON_PREFIX)) {
					continue;
				}
				try {
					const parsed = JSON.parse(text.slice(JSON_PREFIX.length));
					data = isRecord(parsed) ? parsed : undefined;
				} catch {
					data = undefined;
				}
			}
			const humanLine = texts.find(text => !text.startsWith(JSON_PREFIX)) ?? '';
			return { data, humanLine, isError };
		}

		const numberText = value => (typeof value === 'number' && Number.isFinite(value) ? String(value) : '未知');
		const bytesText = value => (typeof value === 'number' && value >= 0
			? (value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)}MB` : `${Math.round(value / 1024)}KB`)
			: '未知');

		/**
		 * 卡片：`preparing`/`call` 阶段如实说"运行中…" ✓；结果阶段有机器行 ⇒ 结构化呈现，没有 ⇒ 回落人读行 ✓。
		 *
		 * ⚠ 官方槽契约（`dsh-client-ui-tool/lib/types/client/contract/slots.d.ts`）：`phase` 为
		 * `preparing` / `call` / `result`，**只有 `result` 才带结果 `block`** ✓ ⇒ 早期阶段若按"结果"渲染
		 * 就会显示成"无结构化数据" ✗（看板卡一直是分开处理的 ✓，README 5.19）。
		 */
		function CodebaseOverviewCard(props) {
			const h = react.createElement;
			if (props && props.phase && props.phase !== 'result') {
				return h('div', { style: { opacity: 0.7 } }, '运行中…');
			}
			const { data, humanLine, isError } = summarize(props && props.block);
			if (isError) {
				// ⚠ 这张卡跑在 **dsh 原生聊天页**里（不是 VsSaros 的 WebContentsView）⇒ 主题变量必须用
				// dsh 的 `--dsw-alias-*`（`doc/dsh-modules-conformance.html` §4-2）；`--vscode-*` 在那个
				// 界面里**不存在**，只能靠回退色 ✗。保留一层 `--vscode-*` 回退：万一宿主是 VsSaros 侧渲染，
				// 行为与从前一致 ✓（双层回退是报告给的标准写法 ✓）。
				return h('div', { style: { color: 'var(--dsw-alias-state-error-primary, var(--vscode-errorForeground, #f48771))' } }, humanLine || '代码图谱查询失败');
			}
			if (!data) {
				return h('div', null, humanLine || '代码图谱（无结构化数据）');
			}
			const chips = [
				`${numberText(data.nodeCount)} 节点`,
				`${numberText(data.edgeCount)} 边`,
				data.project ? `project：${String(data.project)}` : 'project：未知',
				`图谱：${bytesText(data.graphBytes)}`,
			].join(' · ');
			return h('div', null,
				h('div', { style: { fontWeight: 600 } }, '代码图谱总览'),
				h('div', { style: { opacity: 0.8 } }, chips),
				h('div', { style: { opacity: 0.6, fontSize: '0.9em' } },
					`工作区：${data.workspaceRoot ? String(data.workspaceRoot) : '(未配置)'}`));
		}

		/**
		 * ★ 2026-10-27（用户报「codebase 的快捷键功能丢失：Alt+Shift+S」）
		 * ─────────────────────────────────────────────────────────────────────────
		 * **独立 dsh 客户端（桌面窗口）里补上 Alt+Shift+S** ⇒ 打开「代码库」工作台并聚焦检索框。
		 *
		 * 为什么是这里（真机取证，2026-10-27）：
		 *  · IDE（VS Code 底座）窗口里 `sarosis.findGraphSymbol` = Shift+Alt+S **一直有效** ——
		 *    CDP 真按一次会弹出 Find Symbol 模态；F1 面板里也有「Saros: Find Symbol in Codebase」✓
		 *    ⇒ IDE 侧**不是**丢的那一环，别去改它。
		 *  · "丢失"发生在 **dsh 桌面客户端**：它是纯网页（**没有** VS Code 的快捷键/命令面板）⇒
		 *    在那儿按 Alt+Shift+S 或 F1 都毫无反应 ⇒ 用户侧的观感就是"快捷键功能没了" ✓。
		 *
		 * ⚠ 与 IDE 侧**不会重复触发**（两条独立理由，任何一条成立就够）：
		 *  ① IDE 内嵌的 dsh 视图里，我们的 preload 在 window capture 阶段就 `stopPropagation`
		 *     （`src/vs/sessions/contrib/dshHarness/electron-browser/preload-dshView.ts`）⇒
		 *     本监听挂在 document capture 上，**根本收不到该按键** ✓；
		 *  ② 再加 `window.vssarosDsh` 判据兜底：该标记只由 IDE 侧 preload 用 contextBridge 注入
		 *     （桌面窗口的官方客户端页没有它）⇒ IDE 宿主视图里一律让路给 IDE 的 keybinding ✓。
		 *
		 * 行为对齐 IDE 侧那条命令的**用途**（按名字检索符号），但落在 **dsh 真源**上
		 * （工作台「代码库」的检索框 = `data-codebase-q`）⇒ 不依赖 IDE 进程 ✓。
		 */
		const WORKBENCH_ID = 'vssaros/codebase';
		/** 检索框锚点（与 `lib/client.codebase.js` 里那处同名字段保持一致）。 */
		const SEARCH_INPUT_SELECTOR = '[data-codebase-q]';
		/** 聚焦重试上限（面板是异步渲染的 ⇒ 轮询几秒，认不中就不聚焦，不报错）。 */
		const FOCUS_RETRY_LIMIT = 30;
		const FOCUS_RETRY_MS = 100;

		/** 在 IDE 宿主视图里吗？（`window.vssarosDsh` 只由 IDE 侧 preload 注入 ✓） */
		function isInsideIdeView() {
			try {
				return typeof window !== 'undefined' && !!window.vssarosDsh;
			} catch (e) {
				return false;
			}
		}

		/** 聚焦「代码库」工作台里的检索框；当前不在该页 ⇒ 返回 false（不报错 ✓）。 */
		function focusSearchInput() {
			try {
				const el = document.querySelector(SEARCH_INPUT_SELECTOR);
				if (!el || typeof el.focus !== 'function') { return false; }
				el.focus();
				return true;
			} catch (e) {
				return false;
			}
		}

		/**
		 * 打开「代码库」工作台。
		 *
		 * ⚠ `desktopWorkbenches` 是**可选**宿主服务（桌面客户端才有）⇒ 用 `ctx.get` + try/catch
		 * （与 `client.market.js` 同口径），**不能**写进 `exports.inject`（那会让整个客户端插件
		 * 在没有该服务的宿主里不加载 ✗）。
		 */
		function openCodebaseWorkbench(ctx) {
			let svc = null;
			try {
				svc = ctx && typeof ctx.get === 'function' ? ctx.get('desktopWorkbenches') : null;
			} catch (e) {
				svc = null;
			}
			if (!svc || typeof svc.open !== 'function') { return false; }
			try {
				if (typeof svc.has === 'function' && !svc.has(WORKBENCH_ID)) { return false; }
				return !!svc.open(WORKBENCH_ID);
			} catch (e) {
				return false;
			}
		}

		/** 装 Alt+Shift+S ⇒ 打开「代码库」工作台 + 聚焦检索框（已在页内则只聚焦 ✓）。 */
		function installFindSymbolShortcut(ctx) {
			if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') { return; }
			document.addEventListener('keydown', (event) => {
				if (isInsideIdeView()) { return; } // IDE 内 ⇒ 让给 IDE 自己的 keybinding（不重复 ✓）
				if (!event || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) { return; }
				// 键名或物理键位任一命中即可（部分布局下 Alt+Shift+S 产出的 key 不是 's' ⇒ 按 code 更稳 ✓）
				const keyName = String(event.key || '').toLowerCase();
				const keyCode = String(event.code || '');
				if (keyName !== 's' && keyCode !== 'KeyS') { return; }
				// 抢在输入框把 Alt+Shift+S 当字符插入之前 ⇒ 阻止默认行为 ✓
				if (typeof event.preventDefault === 'function') { event.preventDefault(); }
				if (typeof event.stopPropagation === 'function') { event.stopPropagation(); }
				const opened = openCodebaseWorkbench(ctx);
				if (!opened) {
					// ★ 不静默：没有 desktopWorkbenches 宿主服务（老运行时）⇒ 如实说清，不假装成功 ✓
					console.warn('[vssaros-codebase] Alt+Shift+S：没有 desktopWorkbenches 宿主服务，未能打开「代码库」工作台');
				}
				let tries = 0;
				const tick = () => {
					if (focusSearchInput()) { return; }
					tries += 1;
					if (tries < FOCUS_RETRY_LIMIT) { setTimeout(tick, FOCUS_RETRY_MS); }
				};
				setTimeout(tick, FOCUS_RETRY_MS);
			}, true);
		}

		/**
		 * 客户端插件体：把这张卡按**工具名**注册进 keyed 槽。
		 *
		 * ⚠ 必须在 **factory 内**、并经 `module.exports` 导出 —— **不能**写成文件顶层 `export` ✗：
		 * dsh web 的装载器只认 `factory` 的返回值（已验通的看板卡就是这个形态 ✓），顶层 `export`
		 * 既拿不到 factory 内的常量（真被调到就是 ReferenceError ✗），又会让文件不再是可用
		 * `new Function` 加载的经典脚本 ✗ ⇒ **卡片永远不会注册**（静默失效，README 5.15）。
		 */
		function apply(ctx) {
			let registered = false;
			let failure = '';
			try {
				ctx.slots.inject(TOOL_SLOT, () => ctx.slots.register({ name: TOOL_SLOT, key: OVERVIEW_TOOL, priority: CARD_PRIORITY }, CodebaseOverviewCard));
				registered = true;
			} catch (e) {
				failure = String(e && e.message ? e.message : e);
				console.warn(`[vssaros-codebase] 卡片注册失败：${failure}`);
			}
			// ★ 2026-10-27：装 Alt+Shift+S 快捷键（独立 dsh 客户端用；IDE 内让路给 IDE 自己那条）✓
			installFindSymbolShortcut(ctx);
			// 页面自诊断（与看板 `__vssarosKanbanClient` 同一套）：**apply 真的跑过**才是"工具卡能渲染"的
			// 前提，而"文件可服务 / 在 boot 清单里"只是**必要**条件（README 5.15 的教训 ✓）。
			globalThis.__vssarosCodebaseClient = { loaded: true, registered, failure, slot: TOOL_SLOT, key: OVERVIEW_TOOL };
			// ★ 2026-10-22（工作台重构 §5 步骤 2）：**React 工作台**（`lib/client.codebase.js`）。
			//   注册进宿主服务 `desktopWorkbenches`（身份 `vssaros/codebase`）⇒ dsh 窗口页签条里
			//   `/x/codebase/` 那一条自动从 iframe 换成宿主渲染 ✓；IDE 编辑区也会改开 'workbench' 视图。
			//   ⚠ 子块文件名**必须**是 `client.<名字>.js`（装载器只认 `client.*.js`）；装不上不许拖垮这张卡 ✓。
			//   ⚠ 改过子块要**再动一下这个入口**（守卫查 mtime），且**版本号必须是最后一次改动的动作**。
			//   工作台内容：四张统计卡（Nodes / Edges / Files / Last Index）+ 检索（按名/按文件）+ 结果列表
			//   （点一条看依赖）+ Projects + 形状查询 + 诊断（折叠，`data-vssaros-codebase-*` 锚点照旧 ✓）
			//   + 「图谱页 →」（`?view=graph` 那页**留在 SSR**：它要全量图 + 交互，不是这一版的活 ✓）。
			//   ★ 2026-10-22（UI 统一 §6.19）：组件改用**共享层** `wb-*` 原语（宿主注入一份样式表）——
			//     自写 CSS 从 38 行压到 26 行（只留统计卡四色强调 / 检索控件 / 节点行 / 键值对）；
			//     顺带修掉**不存在的令牌名**（`--dsw-alias-border-l2` / `-label-link`）⇒ 那两处之前从没跟随主题 ✗。
			//   ⚠ 统计卡带 `data-vssaros-codebase-stat` 锚点：统计卡与"区块卡"都是 `wb-card` ⇒ **类名数不出张数**
			//     （迁移当场数出 5 张）⇒ 机器锚点一律用 `data-*`，与样式解耦。
			try {
				if (typeof require.async !== 'function') { throw new Error('装载器没有 require.async（老运行时）'); }
				require.async('./client.codebase.js')
					.then((part) => { if (part && typeof part.install === 'function') { part.install(ctx); } })
					.catch((e) => {
						const why = String((e && e.message) || e);
						globalThis.__vssarosCodebaseClient = Object.assign({}, globalThis.__vssarosCodebaseClient, { workbenchFailed: why });
						console.warn(`[vssaros-codebase] 工作台组件装载失败：${why}`);
					});
			} catch (e) {
				const why = String((e && e.message) || e);
				globalThis.__vssarosCodebaseClient = Object.assign({}, globalThis.__vssarosCodebaseClient, { workbenchFailed: why });
				console.warn(`[vssaros-codebase] 工作台组件装载失败：${why}`);
			}
			return undefined;
		}

		exports.apply = apply;
		// 硬依赖只留 `slots`（与看板同口径：Cordis 的 inject 是硬依赖，多列会让整个客户端插件不加载 ✗）。
		exports.inject = ['slots'];
		// 纯函数也导出：探针可以直接调它们验（与看板同一做法 ✓）。
		exports.parseBlock = parseBlock;
		exports.summarize = summarize;
		exports.CodebaseOverviewCard = CodebaseOverviewCard;
		exports.JSON_PREFIX = JSON_PREFIX;
		exports.OVERVIEW_TOOL = OVERVIEW_TOOL;
		exports.TOOL_SLOT = TOOL_SLOT;
		exports.CARD_PRIORITY = CARD_PRIORITY;
		return module.exports;
	},
});
