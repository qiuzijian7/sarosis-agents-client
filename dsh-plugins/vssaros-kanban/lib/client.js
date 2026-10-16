// @vssaros/dsh-kanban — client half：看板工具卡（`tool.call.toolview`）
//
// 为什么需要它：`kanban_*` 工具的回执对模型是好的，对人是**一堵 JSON / 长文本**——
// `kanban_list` 一次可能带几十条任务。这里把同一份数据重绘成一张紧凑卡（列 / 优先级 / 看板 / 条数），
// **原始文本一个字符都不丢**（折叠在下面，点开就有）。
//
// 形态照抄 `@vssaros/dsh-chat-surface/lib/client.tools.js`（本仓库已验证的手写 dsh 客户端插件）：
//   · `window.__ModuleLoader__.load({ id, factory })`——dsh web 的客户端模块契约；
//   · 导出 `apply(ctx)` / `inject`（Cordis 客户端插件）；
//   · `slots.inject(SLOT, () => slots.register({name, key, priority}, Component))`——keyed 槽按
//     **工具名**注册；`priority: -10` 遮蔽官方通用卡（负值优先，与写文件卡同一手）；
//     组件崩溃时槽会 abdicate 回落到官方卡，所以这里的风险是"卡片没生效"，不是"看不到结果"。
//
// 一个文件一个部件：本模块目前只有这一张卡。（部件变多时按 chat-surface 的做法拆 `client.*.js` chunk。）
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-kanban',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require('react');

		/** keyed 槽：工具调用视图。 */
		const TOOL_SLOT = 'tool.call.toolview';
		/** 我们接管的工具名（必须与 `lib/index.js` 里 `ctx.tools.register` 的名字**完全一致**；探针钉住）。 */
		const KANBAN_TOOLS = [
			'kanban_list', 'kanban_create', 'kanban_update',
			// 动词族（README 4.69）：一个都不能漏——漏了那个动词就会用官方通用卡渲染，
			// 同一份看板数据在两处长得不一样。探针按"卡片 key == 模块注册名"钉住这一条。
			'kanban_show', 'kanban_complete', 'kanban_block', 'kanban_unblock',
			'kanban_heartbeat', 'kanban_comment', 'kanban_link',
		];
		/** 遮蔽官方卡的优先级（负值优先，与写文件卡同口径）。 */
		const CARD_PRIORITY = -10;
		/**
		 * `kanban_list` 渲染文本的**首行**格式（真源：`lib/index.js` 的 `renderTaskList` ⇒
		 * `看板任务：返回 N / 命中 M`）。探针既钉这条正则、也钉上游那句模板，任一侧改动都会先红。
		 */
		const LIST_HEADER = /^看板任务：返回 (\d+) \/ 命中 (\d+)/;

		function isRecord(value) {
			return typeof value === 'object' && value !== null && !Array.isArray(value);
		}

		/** 取出一次工具调用的"参数对象 + 结果文本 + 是否报错"。phase 在 props 上（block 上没有）。 */
		function parseBlock(block, phase) {
			const out = { args: null, text: '', isError: false };
			if (!isRecord(block)) {
				return out;
			}
			let raw = null;
			if (phase === 'result') {
				out.isError = block.isError === true;
				raw = isRecord(block.call) ? block.call.argsRaw : null;
				const content = block.content;
				if (Array.isArray(content)) {
					out.text = content
						.map(part => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
						.filter(Boolean)
						.join('\n');
				}
			} else {
				raw = block.argsRaw;
			}
			try {
				const parsed = raw ? JSON.parse(raw) : null;
				out.args = isRecord(parsed) ? parsed : null;
			} catch {
				out.args = null;
			}
			return out;
		}

		/**
		 * 写入类工具（`EXPECTED_TOOLS` 去掉两个只读的 `kanban_list` / `kanban_show`）。
		 * 卡片据此标"已写入" ✓ —— 判据是**工具名本身**（结构化 ✓），不解析回执文案 ✗（README 5.102）。
		 */
		const WRITE_TOOLS = [
			'kanban_create', 'kanban_update', 'kanban_complete', 'kanban_block',
			'kanban_unblock', 'kanban_heartbeat', 'kanban_comment', 'kanban_link',
		];

		/**
		 * 把一次看板工具调用摘成卡片要的那几个字段（**纯函数**，不碰 React ⇒ 可被探针直接验）。
		 * 只读**可靠**的东西：① `meta`（结构化元数据 ✓，随会话日志持久化 ✓）；② 参数（结构化 ✓）；
		 * ③ 工具名（结构化 ✓ —— "是不是写入类"由它判定 ✓）；结果文本**只用于展示与人读回落** ✓
		 * （`renderTaskList` 的稳定头 / create·update 的单行 ✓）：其余原文一律透传给折叠区，不猜、不截断 ✓。
		 */
		function summarize(toolName, block, phase) {
			const { args, text, isError } = parseBlock(block, phase);

			const lines = text.split('\n').filter(line => line.trim().length > 0);
			const chips = [];
			if (args) {
				if (typeof args.status === 'string' && args.status) { chips.push(`列：${args.status}`); }
				if (typeof args.priority === 'string' && args.priority) { chips.push(`优先级：${args.priority}`); }
				if (typeof args.boardId === 'string' && args.boardId) { chips.push(`看板：${args.boardId}`); }
				if (typeof args.workspaceId === 'string' && args.workspaceId) { chips.push(`工作区：${args.workspaceId}`); }
				if (typeof args.query === 'string' && args.query) { chips.push(`查询：${args.query}`); }
				if (typeof args.limit === 'number') { chips.push(`上限：${args.limit}`); }
				if (typeof args.title === 'string' && args.title) { chips.unshift(args.title); }
			}
			// ★ `meta` **优先**（报告 §5-11 / README 5.101）：计数不再靠正则抠**人读首行** ✗
			// （此前 `LIST_HEADER` 一旦不匹配，卡片就**静默**少一块 ✓）。⚠ 两类情形**必须**继续回落首行 ✗
			// （所以下面那段解析留着 ✓）：① **旧日志**（本仓 5.101 之前写下的调用没有 meta ✓）；
			// ② **嵌套调用**（官方只为顶层调用算 meta ✓）。
			// ⚠ 位置有讲究：必须在 `if (args)` **之后** ✓ —— meta 分支也要带上参数 chips（列/上限… ✓），
			// 且 `chips` 是 `const`（放前面会撞 TDZ ✗）。这条错我自己在探针上撞过一次 ✓。
			if (isRecord(block) && isRecord(block.meta) && block.meta.shape === 'kanban-list'
				&& typeof block.meta.count === 'number' && typeof block.meta.total === 'number') {
				return { chips, head: `返回 ${block.meta.count} 条 / 命中 ${block.meta.total} 条`, listed: block.meta.count, raw: text, isError };
			}
			const head = lines.length ? lines[0] : '';
			const match = head.match(LIST_HEADER);
			if (match) {
				// 计数可靠地来自首行（上游模板被钉住）；行数减去首行 = 实际列出的任务数
				return { chips, head: `返回 ${match[1]} 条 / 命中 ${match[2]} 条`, listed: Math.max(0, lines.length - 1), raw: text, isError };
			}
			// ★ `created` **不解析人读文本**（报告 §5-11 / README 5.102）：那条旧正则想表达的正是两件
			// **结构化**的事 ✓ —— "是不是写入类工具"由 `toolName` 决定 ✓（卡片本就有全 10 个工具的名字 ✓）、
			// "这次成不成"由 `isError` 决定 ✓（失败时模块自己给 isError ✓）。旧正则会在模块改回执文案时
			// **静默**失效 ✗（这正是第三张卡最后一处人读文本依赖 ✓）。
			// ⚠ 仍要留"只有 result 阶段"这条：running 时 head 是"运行中…" ✓，不该标成已写入 ✓。
			const writeDone = phase === 'result' && isError !== true && WRITE_TOOLS.includes(toolName);
			return { chips, head: head || (phase === 'result' ? '(没有文本结果)' : '运行中…'), listed: null, raw: text, isError, ...(writeDone ? { created: true } : {}) };
		}

		const WRAP_STYLE = { margin: '6px 0 0', fontSize: 12, borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))', overflow: 'hidden' };
		const TITLE_STYLE = { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', fontWeight: 600, background: 'var(--dsw-alias-bg-base, transparent)' };
		const CHIP_STYLE = { fontSize: 11, fontWeight: 400, padding: '1px 6px', borderRadius: 999, background: 'var(--dsw-alias-bg-elevated, rgba(127,127,127,.12))', color: 'var(--dsw-alias-label-secondary, currentColor)' };
		const HEAD_STYLE = { padding: '0 8px 6px', color: 'var(--dsw-alias-label-secondary, currentColor)' };
		const RAW_STYLE = {
			fontFamily: 'var(--dsw-alias-font-mono, ui-monospace, monospace)', fontSize: 11, margin: 0,
			padding: '6px 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
			borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25))',
			color: 'var(--dsw-alias-label-secondary, currentColor)',
		};
		const LINK_BUTTON_STYLE = { fontSize: 11, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--dsw-alias-label-link, currentColor)' };

		/** 卡片本体（React.createElement 手写，不引入 JSX 构建）。 */
		function KanbanToolCard(props) {
			const disclosure = props.useDisclosure ? props.useDisclosure() : { expanded: false, toggle: () => {} };
			const info = summarize(props.toolName, props.block, props.phase);
			const label = {
				kanban_list: '看板任务', kanban_create: '新建卡片', kanban_update: '更新卡片',
				kanban_show: '卡片详情', kanban_complete: '完成卡片', kanban_block: '阻塞卡片',
				kanban_unblock: '解除阻塞', kanban_heartbeat: '进展心跳', kanban_comment: '卡片评论',
				kanban_link: '建立依赖',
			}[props.toolName] ?? '看板';
			const children = [
				react.createElement('div', { key: 'title', style: TITLE_STYLE }, [
					react.createElement('span', { key: 'tool' }, `🧩 ${label}`),
					...info.chips.map((chip, index) => react.createElement('span', { key: `chip${index}`, style: CHIP_STYLE }, chip)),
					info.isError ? react.createElement('span', { key: 'err', style: CHIP_STYLE }, '失败') : null,
					// 原文永远可达：折叠区是"更省地方"，不是"藏起来"
					info.raw ? react.createElement('button', { key: 'raw', style: LINK_BUTTON_STYLE, onClick: disclosure.toggle },
						disclosure.expanded ? '收起原始结果' : '查看原始结果') : null,
				]),
				react.createElement('div', { key: 'head', style: HEAD_STYLE },
					info.listed === null ? info.head : `${info.head}${info.listed ? `（列出 ${info.listed} 条）` : ''}`),
				disclosure.expanded && info.raw ? react.createElement('pre', { key: 'raw', style: RAW_STYLE }, info.raw) : null,
			];
			// 稳定 DOM 钩子（e2e / 页面自诊断用）：不依赖哈希类名或文案，断言"这张卡是我们的、管哪个工具"。
			// 与 chat-surface 的 `data-vssaros-fs-tool` 同一约定。
			return react.createElement('div', {
				style: WRAP_STYLE,
				'data-vssaros-kanban-card': '1',
				'data-vssaros-kanban-tool': props.toolName ?? '',
				'data-vssaros-kanban-phase': props.phase ?? '',
			}, children.filter(Boolean));
		}

		/**
		 * 客户端插件体：把这张卡按**工具名**注册进 keyed 槽。
		 * 注册失败只影响这张卡（槽回落到官方卡），所以每个 key 各自 try，一个失败不连累其它。
		 */
		function apply(ctx) {
			const failures = [];
			const registered = [];
			for (const key of KANBAN_TOOLS) {
				try {
					ctx.slots.inject(TOOL_SLOT, () => ctx.slots.register({ name: TOOL_SLOT, key, priority: CARD_PRIORITY }, KanbanToolCard));
					registered.push(key);
				} catch (e) {
					failures.push(`${key}: ${String(e && e.message ? e.message : e)}`);
				}
			}
			if (failures.length) {
				console.warn(`[vssaros-kanban] 卡片注册失败：${failures.join('；')}`);
			}
			// 页面自诊断（e2e 用）：**客户端插件真的被加载并 apply 过**是"工具卡能渲染"的前提，
			// 而"文件可服务/在 boot 清单里"只是必要条件（P3-17 证的是那一半）。与 chat-surface / bridge
			// 客户端同一套做法（`window.__vssarosChatSurface` / `window.__vssarosBridgeClient`）。
			globalThis.__vssarosKanbanClient = { loaded: true, registered, failures, slot: TOOL_SLOT };
			return undefined;
		}

		// 硬依赖只留 `slots`：拿不到槽就没有这张卡，但不该让整个客户端插件不 apply（Cordis 的 inject 数组
		// 是硬依赖，未就绪就整个不加载——本仓库在 chat-surface 那边踩过，所以宁可少列也别多列）。
		const inject = ['slots'];

		exports.apply = apply;
		exports.inject = inject;
		// 探针用：摘要逻辑是**纯函数**，拆出来就能在 Node 里直接验（浏览器运行时没人读这个字段）
		exports.__test = { summarize, parseBlock, KANBAN_TOOLS, TOOL_SLOT, CARD_PRIORITY, LIST_HEADER };
		return module.exports;
	},
});
