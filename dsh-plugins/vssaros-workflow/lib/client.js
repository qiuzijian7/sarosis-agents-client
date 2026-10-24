// 2026-10-24 touch：client.workbench.js：补 @container（S9 容器查询） ⇒ 入口置新（chunk 守卫按 mtime 判）。
// @vssaros/dsh-workflow — 客户端半（dsh web 的客户端插件）。
//
// 这是本仓**第二张工具卡** ✓，形态**逐条照**第一张（`dsh-plugins/vssaros-codebase/lib/client.js`，
// 已由 `p3-17` 端到端验通：进 boot 清单 ✓、文件可服务 ✓、含 loader 调用与工具卡槽 ✓）：
//   · `window.__ModuleLoader__.load({ id, factory })` —— dsh web 的客户端模块契约；
//   · 导出 `apply(ctx)` / `inject`（Cordis 客户端插件）；
//   · `ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name, key, priority }, Card))`
//     —— keyed 槽按**工具名**注册；`priority: -10` 遮蔽官方通用卡（与看板同口径）。
//
// 取值方式（README 5.09 的官方做法）：结构化数据由 Host 侧以
// **`workflow_engine_status_json: {…}` 文本行**出结果，客户端**解析那一行** ✓ ——
// 不去解析人读文案 ✗、不走 `meta` ✗、不走会话事件 ✗。那一行由 `p3-10`（Host 侧 render 产出）与
// `p3-17`（本文件可服务/在加载器清单里）两侧钉住 ✓。
//
// 分法照看板/第一张卡：**解析与摘取是纯函数**（不碰 React）⇒ 探针可直接调它们验 ✓。

window.__ModuleLoader__.load({
	id: '@vssaros/dsh-workflow',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require('react');

		/** keyed 槽：工具调用视图。 */
		const TOOL_SLOT = 'tool.call.toolview';
		/** 本卡接管的工具名（必须与 `lib/index.js` 里 `ctx.tools.register` 的名字**完全一致**）。 */
		const ENGINE_TOOL = 'workflow_engine_status';
		/** 遮蔽官方通用卡的优先级（负值优先，与看板同口径）。 */
		const CARD_PRIORITY = -10;
		/** 机器可读行的前缀（真源：`lib/index.js` 的 `render`；`p3-10` 逐字钉住）。 */
		const JSON_PREFIX = 'workflow_engine_status_json: ';

		function isRecord(value) {
			return typeof value === 'object' && value !== null && !Array.isArray(value);
		}

		/** 取出一次工具调用的"结果文本数组 / 是否报错"（与第一张卡同口径）。 */
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
		 * 机器行优先 ✓；解析不出来就回落到人读那一行 ✓（卡片不空白 ✗）。
		 */
		function summarize(block) {
			const { texts, isError } = parseBlock(block);
			let data;
			// ★ `meta` **优先**（报告 §5-11）：结构化元数据随会话日志持久化 ⇒ 卡片不再依赖解析人读文本 ✓。
			//   ⚠ 两类情形**必须**继续回落文本 ✗（所以下面那段解析留着 ✓，它现在只是兜底）：
			//     ① **旧日志**：本仓 5.09 之前写下的调用记录里没有 meta ✓（重放旧会话不能让卡片变空白 ✗）；
			//     ② **嵌套调用**：官方只为顶层调用计算 meta ✓（`dsh-client-ui-tool` 的 `read_image` 注释
			//        就写着 nested 调用不持久化 meta ✓）。
			if (isRecord(block) && isRecord(block.meta) && block.meta.shape === 'engine-status') {
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
		const loadOf = data => (isRecord(data) && isRecord(data.load) ? data.load : undefined);

		/**
		 * 卡片：`preparing`/`call` 阶段如实说"运行中…" ✓；结果阶段有机器行 ⇒ 结构化呈现（worker 自证 +
		 * 线程内加载那次的结果 ✓），没有 ⇒ 回落人读行 ✓。
		 *
		 * ⚠ 官方槽契约（`dsh-client-ui-tool/lib/types/client/contract/slots.d.ts`）：`phase` 为
		 * `preparing` / `call` / `result`，**只有 `result` 才带结果 `block`** ✓ ⇒ 早期阶段若按"结果"渲染
		 * 就会显示成"无结构化数据" ✗（看板卡一直是分开处理的 ✓，README 5.19）。
		 */
		function WorkflowEngineCard(props) {
			const h = react.createElement;
			if (props && props.phase && props.phase !== 'result') {
				return h('div', { style: { opacity: 0.7 } }, '运行中…');
			}
			const { data, humanLine, isError } = summarize(props && props.block);
			if (isError) {
				// ⚠ 同 codebase：这张卡跑在 **dsh 原生聊天页**里 ⇒ 用 dsh 的 `--dsw-alias-*`
				// （`doc/dsh-modules-conformance.html` §4-2），`--vscode-*` 在那界面里不存在 ✗；
				// 保留一层 vscode 回退，宿主若是 VsSaros 侧渲染则与从前一致 ✓。
				return h('div', { style: { color: 'var(--dsw-alias-state-error-primary, var(--vscode-errorForeground, #f48771))' } }, humanLine || '工作流引擎探测失败');
			}
			if (!data) {
				return h('div', null, humanLine || '工作流引擎（无结构化数据）');
			}
			const load = loadOf(data);
			const chips = [
				data.ok === true ? 'worker_threads 可用' : 'worker_threads 不可用',
				`threadId ${numberText(data.threadId)}`,
				`${numberText(data.ms)}ms`,
			].join(' · ');
			const loadLine = !load
				? '未做线程内加载'
				: load.ok === true
					? `线程内加载成功：#${String(load.id ?? '?')} ${String(load.name ?? '')}（${numberText(load.nodeCount)} 节点 / ${numberText(load.edgeCount)} 连接 / ${numberText(load.steps)} 步${load.empty === true ? '，空壳' : ''}）`
					: `线程内加载失败：${String(load.error ?? '未知原因')}`;
			return h('div', null,
				h('div', { style: { fontWeight: 600 } }, '工作流引擎探测'),
				h('div', { style: { opacity: 0.8 } }, chips),
				h('div', { style: { opacity: 0.7, fontSize: '0.9em' } }, loadLine));
		}

		/**
		 * 客户端插件体：把这张卡按**工具名**注册进 keyed 槽。
		 *
		 * ⚠ 必须在 **factory 内**、并经 `module.exports` 导出 —— **不能**写成文件顶层 `export` ✗：
		 * dsh web 的装载器只认 `factory` 的返回值（看板卡/第一张卡就是这个形态 ✓），顶层 `export`
		 * 既拿不到 factory 内的常量（真被调到就是 ReferenceError ✗），又会让文件不再是可用
		 * `new Function` 加载的经典脚本 ✗ ⇒ **卡片永远不会注册**（静默失效，README 5.15）。
		 */
		function apply(ctx) {
			let registered = false;
			let failure = '';
			try {
				ctx.slots.inject(TOOL_SLOT, () => ctx.slots.register({ name: TOOL_SLOT, key: ENGINE_TOOL, priority: CARD_PRIORITY }, WorkflowEngineCard));
				registered = true;
			} catch (e) {
				failure = String(e && e.message ? e.message : e);
				console.warn(`[vssaros-workflow] 卡片注册失败：${failure}`);
			}
			globalThis.__vssarosWorkflowClient = { loaded: true, registered, failure, slot: TOOL_SLOT, key: ENGINE_TOOL };
			// ★ 2026-10-22（工作台重构 §5 步骤 2）：**React 工作台**（`lib/client.workbench.js`）。
			//   它注册进宿主服务 `desktopWorkbenches`（身份 `vssaros/workflow`）⇒ dsh 窗口页签条里
			//   `/x/workflow/` 那一条自动从 iframe 换成宿主渲染 ✓；IDE 编辑区也会改开 'workbench' 视图
			//   （判据 = 清单 `dsh.client.inject` 含宿主包 ⇒ 见 `hasWorkbenchClient`）。
			//   ⚠ 子块文件名**必须**是 `client.<名字>.js`（装载器只认 `client.*.js` ⇒ 相对请求 `client-modules` 会拒）
			//     ⇒ 写成 `workbench.js` 会报 "invalid relative chunk request" ✗（真机踩过 ✓）。
			//   ★ 2026-10-22：**左右两档**（用户要求）—— 左列 = 工作流条目列表，右列 = 该条的画布；
			//     点左列任一条 ⇒ 右列换它的画布（只取画布的轻接口 `/api/canvas` ⇒ 不重搬整页 ✓）；
			//     窄容器也**保持左右**（不改成上下排）⇒ 左列收缩、画布那栏自己滚 ✓。
			//     （旧 SSR 页仍是"列表优先 + 画布折叠在页脚"——它是**窄侧栏**（330px）的退化形态，不在这条要求内 ✓）
			//   ⚠ 规矩：改过 `client.workbench.js` 之后，**要再动一下这个入口**（守卫查 mtime ⇒ 漏了必红 ✓）
			//     ⇒ 否则浏览器会一直吃缓存里的旧 chunk ⇒ 用户看到旧界面 ✗。
			//   ★ 2026-10-22（工作台 UI 统一，方案稿 §6.19）：组件已改用**共享层** `wb-*` 原语
			//     （宿主 `@vssaros/dsh-workbenches` 注入一份样式表）⇒ 颜色只走 `--dsw-alias-*` 令牌
			//     （明暗两套自动跟随），间距/圆角/字号只走 `--wb-*` 刻度；本包只留 3 行布局覆盖。
			//     守卫 `check-workbench-style.mjs` 钉住四条（无裸色值 / 宿主渲染标记 / ≥10 个 wb-* 类 / 工具条锚点唯一），
			//     已统一的包在它的 UNIFIED 白名单里 —— 每迁完一个就入列 ✓。
			//   ⚠ 迁移脚本改写文件后要**归一 CRLF**（仓库约定）+ **重新动入口 / 升版本**（守卫查 mtime）。
			//   ⚠ 装不上不许拖垮这张卡（try/catch + 留痕 ✓）：装载器没有 `require.async`（老运行时 / 探针的假 ctx）
			//     ⇒ 只丢 React 工作台，工具卡照常 ✓。
			try {
				if (typeof require.async !== 'function') {
					throw new Error('装载器没有 require.async（老运行时）');
				}
				require.async('./client.workbench.js')
					.then((part) => { if (part && typeof part.install === 'function') { part.install(ctx); } })
					.catch((e) => {
						const why = String((e && e.message) || e);
						globalThis.__vssarosWorkflowClient = Object.assign({}, globalThis.__vssarosWorkflowClient, { workbenchFailed: why });
						console.warn(`[vssaros-workflow] 工作台组件装载失败：${why}`);
					});
			} catch (e) {
				const why = String((e && e.message) || e);
				globalThis.__vssarosWorkflowClient = Object.assign({}, globalThis.__vssarosWorkflowClient, { workbenchFailed: why });
				console.warn(`[vssaros-workflow] 工作台组件装载失败：${why}`);
			}
			return undefined;
		}

		exports.apply = apply;
		// 硬依赖只留 `slots`（与看板同口径：Cordis 的 inject 是硬依赖，多列会让整个客户端插件不加载 ✗）。
		exports.inject = ['slots'];
		// 纯函数也导出：探针可以直接调它们验（与看板/第一张卡同一做法 ✓）。
		exports.parseBlock = parseBlock;
		exports.summarize = summarize;
		exports.WorkflowEngineCard = WorkflowEngineCard;
		exports.JSON_PREFIX = JSON_PREFIX;
		exports.ENGINE_TOOL = ENGINE_TOOL;
		exports.TOOL_SLOT = TOOL_SLOT;
		exports.CARD_PRIORITY = CARD_PRIORITY;
		return module.exports;
	},
});
