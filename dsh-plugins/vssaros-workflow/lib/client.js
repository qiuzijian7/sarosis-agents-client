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
