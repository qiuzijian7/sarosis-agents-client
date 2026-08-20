/*---------------------------------------------------------------------------------------------
 *  sarosLiteGraphNodes — real LiteGraph node classes for Saros custom node types.
 *
 *  Previously, Saros nodes (start/end/task/prompt/agent/skill/tool/ifElse/switch/
 *  askUser/group) were filtered out of the LiteGraph canvas because the engine had
 *  no node class for them and would render a giant empty rectangle. Here we register
 *  a real LGraphNode subclass per type so the engine can draw them natively:
 *   - title from node label/properties
 *   - input/output ports typed by our PortType vocabulary
 *   - per-type parameter widgets (prompt → prompt text, agent → agentId/model, …)
 *
 *  Widget values are mirrored into `this.properties`, which is the persistence
 *  channel shared with the store (toLiteGraph writes data → properties;
 *  fromLiteGraph reads properties → data). `onConfigure` re-hydrates widget
 *  values from the incoming properties so loading a workflow shows the params.
 *
 *  Registration is idempotent and mirrors `registerSarosNodes()` in registry.ts.
 *--------------------------------------------------------------------------------------------*/

import { LiteGraph, LGraphNode } from '@comfyorg/litegraph';
import { comfyDrawWidgets } from '../comfyNodeStyle.js';
import { getNodeSpec, SAROS_NODE_COLORS, ORCH_RICH_NODE_TYPES } from './registry.js';
import { useAgentStore } from '../../../store/useAgentStore.js';
import { usePicklistStore } from '../picklistStore.js';

/** Saros.* 节点里需要「富身份卡」增强的 type 集合。canvas 自绘（非 React）。 */
const IDENTITY_NODE_TYPES = new Set(['Saros.Agent', 'Saros.Skill', 'Saros.Tool']);
/** 身份卡行高（icon + name + role + 1 行 description + 徽章）。 */
const IDENTITY_CARD_H = 56;
/** 节点最小高度（原 LiteGraph widget 高度 + 身份卡）。 */
const IDENTITY_MIN_H = 110;

export interface SarosNodeConfig {
	type: string;
	title: string;
	color?: string;
	inputs?: Array<{ name: string; type: string }>;
	outputs?: Array<{ name: string; type: string }>;
	widgets?: Array<{ type: 'text' | 'button' | 'toggle'; name: string; value: unknown; multiline?: boolean; hidden?: boolean }>;
}

/**
 * ComfyTV 风格节点色板 —— 复用 registry 的**单一真源** `SAROS_NODE_COLORS`。
 *
 * ★ 这里曾经硬编码第二份色值，与 registry 的 spec color 漂移（同一节点在
 *   palette 图标与画布上颜色不一致）。现在统一从 registry 取。
 */
const SAROS_COLORS = SAROS_NODE_COLORS;

const NODE_CONFIGS: SarosNodeConfig[] = [
	// ★ 端口命名规范：通用数据端口用 `in` / `out`（原来输入输出**都叫 value**，
	//   截图里 Agent 节点左右两侧显示同一个 "value"，完全无语义）。
	//   ⚠ 但 **分支端口名不可改** —— `executionGraph.isEdgeActive` 按
	//   `edge.sourceHandle === branch` 路由（true/false/case-1..4/default），
	//   改名会让分支路由静默失效。
	// ★ Start 的 spec 有 2 个输出（out + COMFYTV_TEXT 桥的 text），class 原来只有
	//   1 个 → 槽位数不等，`syncNodePortsToSpec` 放弃同步，且画布上 text 桥端口
	//   根本不存在（无法直连 ComfyTV stage 的 texts/prompt）。补齐。
	{ type: 'Saros.Start', title: '开始', color: SAROS_COLORS.start, outputs: [{ name: 'out', type: 'SAROS_JSON' }, { name: 'text', type: 'COMFYTV_TEXT' }], widgets: [{ type: 'text', name: 'args', value: '{}' }] },
	{ type: 'Saros.End', title: '结束', color: SAROS_COLORS.end, inputs: [{ name: 'in', type: 'SAROS_JSON' }] },
	{ type: 'Saros.Task', title: '任务', color: SAROS_COLORS.task, inputs: [{ name: 'in', type: 'SAROS_JSON' }], outputs: [{ name: 'out', type: 'SAROS_JSON' }], widgets: [{ type: 'text', name: 'taskId', value: '' }] },
	// prompt 由 **DOM 富卡片**的 MentionTextarea 接管（复用 ImageStage 的 prompt
	// 输入框：@ 提及、自动高度、ComfyTV 配色）→ canvas widget 标 hidden，
	// 只保留 properties 持久化通道，避免「canvas 窄输入框 + DOM textarea」两套 UI。
	{ type: 'Saros.Prompt', title: '提示', color: SAROS_COLORS.prompt, inputs: [{ name: 'in', type: 'SAROS_JSON' }], outputs: [{ name: 'output', type: 'TEXT' }], widgets: [{ type: 'text', name: 'prompt', value: '', multiline: true, hidden: true }] },
	// agentId/skillName/toolName 走 NodeEditorPopup 的富选择器，canvas 上由
	// onDrawForeground 画身份卡 → widget 标 hidden（保留 properties 持久化通道，
	// 但不画空的文本框，避免「空框 + 身份卡」重复两套 UI）。
	{ type: 'Saros.Agent', title: 'Agent', color: SAROS_COLORS.agent, inputs: [{ name: 'in', type: 'SAROS_JSON' }], outputs: [{ name: 'out', type: 'SAROS_JSON' }], widgets: [{ type: 'text', name: 'agentId', value: '', hidden: true }] },
	{ type: 'Saros.Skill', title: 'Skill', color: SAROS_COLORS.skill, inputs: [{ name: 'in', type: 'SAROS_JSON' }], outputs: [{ name: 'out', type: 'SAROS_JSON' }], widgets: [{ type: 'text', name: 'skillName', value: '', hidden: true }] },
	{ type: 'Saros.Tool', title: 'Tool', color: SAROS_COLORS.tool, inputs: [{ name: 'in', type: 'SAROS_JSON' }], outputs: [{ name: 'out', type: 'SAROS_JSON' }], widgets: [{ type: 'text', name: 'toolName', value: '', hidden: true }] },
	{ type: 'Saros.IfElse', title: 'If/Else', color: SAROS_COLORS.ifElse, inputs: [{ name: 'in', type: 'SAROS_JSON' }], outputs: [{ name: 'true', type: 'SAROS_JSON' }, { name: 'false', type: 'SAROS_JSON' }], widgets: [{ type: 'text', name: 'evaluationTarget', value: '' }] },
	// ★ 缺陷修复：class 原来只有 1 个输出（'case'），而 registry spec 声明 5 个
	//   （case-1..4 + default）。`syncNodePortsToSpec` 在**槽位数不等时直接放弃**，
	//   于是画布上永远只有 1 个输出端口 —— case-2/3/4/default 根本无法连线。
	{ type: 'Saros.Switch', title: 'Switch', color: SAROS_COLORS.switch, inputs: [{ name: 'in', type: 'SAROS_JSON' }], outputs: [
		{ name: 'case-1', type: 'SAROS_JSON' }, { name: 'case-2', type: 'SAROS_JSON' },
		{ name: 'case-3', type: 'SAROS_JSON' }, { name: 'case-4', type: 'SAROS_JSON' },
		{ name: 'default', type: 'SAROS_JSON' },
	], widgets: [{ type: 'text', name: 'cases', value: '[]' }] },
	// ★ 缺陷修复：Merge / Parallel 在 registry 有 spec 但**没有 LiteGraph class**
	//   → 画布无法原生渲染这两类节点。补齐（端口/widget 与 spec 对齐）。
	{ type: 'Saros.Merge', title: '汇聚', color: SAROS_COLORS.merge, inputs: [{ name: 'inA', type: 'SAROS_JSON' }, { name: 'inB', type: 'SAROS_JSON' }], outputs: [{ name: 'out', type: 'SAROS_JSON' }], widgets: [{ type: 'text', name: 'mode', value: 'all' }] },
	{ type: 'Saros.Loop', title: '循环', color: SAROS_COLORS.loop, inputs: [{ name: 'in', type: 'SAROS_JSON' }], outputs: [{ name: 'out', type: 'SAROS_JSON' }], widgets: [{ type: 'text', name: 'items', value: '[]' }, { type: 'text', name: 'concurrency', value: 1 }] },
	{ type: 'Saros.Parallel', title: '并发', color: SAROS_COLORS.parallel, inputs: [{ name: 'in', type: 'SAROS_JSON' }], outputs: [{ name: 'out', type: 'SAROS_JSON' }], widgets: [{ type: 'text', name: 'items', value: '[]' }, { type: 'text', name: 'concurrency', value: 4 }] },
	{ type: 'Saros.AskUser', title: '询问', color: SAROS_COLORS.askUser, inputs: [{ name: 'in', type: 'SAROS_JSON' }], outputs: [{ name: 'answer', type: 'SAROS_JSON' }], widgets: [{ type: 'text', name: 'questionText', value: '' }] },
	{ type: 'Saros.Group', title: '分组', color: SAROS_COLORS.group },
	{ type: 'Saros.Subflow', title: '子流程', color: SAROS_COLORS.subflow, inputs: [{ name: 'in', type: 'SAROS_JSON' }], outputs: [{ name: 'out', type: 'SAROS_JSON' }] },
	{ type: 'Saros.ProviderPicker', title: 'Provider 选择', color: SAROS_COLORS.prompt, inputs: [], outputs: [{ name: 'config', type: 'TEXT' }], widgets: [
		{ type: 'text', name: 'providerId', value: '' },
		{ type: 'text', name: 'modelId', value: '' },
	] },
	// NOTE: Saros.ModelImageGen is deliberately NOT here. It migrated to a
	// schema node (kind='schema' + backendKind='provider', see registry.ts) and
	// gets its LiteGraph class from schemaLiteGraphNodes (canvas title/ports +
	// addDOMWidget form). A duplicate SarosNode config here would OVERWRITE
	// that class at registration time (registerNodeType: last write wins),
	// resurrecting the old canvas widgets (providerId/modelId/…) underneath
	// the DOM card — the "两层参数 UI" bug.
];

/** Build the LGraphNode subclass for a Saros node config. */
export function createSarosNodeClass(cfg: SarosNodeConfig): typeof LGraphNode {
	return class SarosNode extends LGraphNode {
		// LiteGraph's `configure()` does `if (!info.title) this.title =
		// this.constructor.title` — without a static title the instance title
		// gets wiped to undefined on every load (blank title bar).
		static override title = cfg.title;
		constructor() {
			super(cfg.title);
			this.color = cfg.color ?? '#888';
			this.boxcolor = cfg.color ?? '#888';
			for (const inp of cfg.inputs ?? []) {
				this.addInput(inp.name, inp.type, { label: inp.name } as never);
			}
			for (const out of cfg.outputs ?? []) {
				this.addOutput(out.name, out.type, { label: out.name } as never);
			}
			this._initWidgets();
			// ★ 身份卡节点：Saros.Agent/Skill/Tool 强制最小高度，容纳 onDrawForeground
			//   画的 icon+name+role+description（widget 区域下方 ~56px）。否则
			//   canvas 会被节点 box 边界裁切，身份卡显示不全。
			if (IDENTITY_NODE_TYPES.has(cfg.type)) {
				const h = Math.max(IDENTITY_MIN_H, this.size[1] || 0);
				this.size = [Math.max(this.size[0] || 0, 220), h];
			}
		}

		/** Create parameter widgets once (constructor). */
		private _initWidgets(): void {
			for (const w of cfg.widgets ?? []) {
				const current = (this.properties?.[w.name] as unknown) ?? w.value;
				// Persist widget edits back into properties AND notify the graph
				// so the store (graph.on_change → syncGraphToStore) picks the
				// parameter up on the next save.
				const commit = (v: unknown) => {
					this.properties[w.name] = v;
					this.graph?.change?.();
				};
				if (w.type === 'text') {
					const widget = this.addWidget('text', w.name, String(current), (v: string) => {
						commit(v);
					});
					if (w.multiline) {
						// ComfyUI-style multiline prompt widget (auto-expands).
						widget.options = { multiline: true };
					}
					// ★ hidden widget：保留 properties 持久化通道（commit 回写 +
					//   onConfigure 回填），但**不在 canvas 上画空文本框**。
					//   两个来源：
					//   ① 显式 `hidden: true`（agentId/skillName/toolName —— 取值走
					//      NodeEditorPopup 富选择器 + canvas 身份卡）；
					//   ② 节点在 ORCH_RICH_NODE_TYPES 中 —— 参数整体由 DOM 卡片
					//      绘制（ComfyTV 风格），canvas 再画一遍就是双份 UI。
					if (w.hidden || ORCH_RICH_NODE_TYPES.has(cfg.type)) {
						(widget as unknown as { hidden?: boolean }).hidden = true;
					}
				} else if (w.type === 'toggle') {
					this.addWidget('toggle', w.name, Boolean(current), (v: boolean) => {
						commit(v);
					});
				} else if (w.type === 'button') {
					this.addWidget('button', w.name, null, () => { /* no-op */ });
				}
			}
		}

		override onConfigure(config: Record<string, unknown>): void {
			super.onConfigure?.(config);
			const label = (config as Record<string, unknown>).title;
			if (typeof label === 'string' && label.length > 0) {
				this.title = label;
			}
			// Re-hydrate widget values from the incoming properties so a loaded
			// workflow shows its saved parameters on the canvas. We match widgets
			// by name and only update their value — the widgets themselves were
			// created once in the constructor (0.17.2 widget system).
			const props = this.properties ?? {};
			for (const widget of this.widgets ?? []) {
				const name = (widget as { name?: string }).name;
				if (name && name in props) {
					(widget as { value: unknown }).value = props[name];
				}
			}
		}

		/**
		 * Override `drawWidgets` on the Saros subclass instead of relying on
		 * the `LGraphNode.prototype.drawWidgets` patch from
		 * `applyComfyNodeStyle`. LiteGraph 0.17's subclass `extends LGraphNode`
		 * still resolves `drawWidgets` through the prototype chain, so the
		 * Saros nodes were double-painted — once by the original
		 * 0.17 `drawWidgets` (TextWidget.draw 渲染 label+value 文字，无背景框
		 * 的"参数面板上面一层") and once by our `comfyDrawWidgets` (字段框).
		 * Owning the override on the subclass guarantees a single render path.
		 */
		override drawWidgets(
			this: Parameters<typeof comfyDrawWidgets>[0],
			ctx: CanvasRenderingContext2D,
			options: unknown,
		): void {
			comfyDrawWidgets.call(this, ctx, options);
		}

		/**
		 * ★ Saros.Agent/Skill/Tool 身份卡 canvas 自绘：
		 *   节点本体（title + ports + widgets）画完后，LiteGraph 调用本钩子。
		 *   在 widget 区域下方画 icon + name + role + description（clamp 2 行）
		 *   + 分类/技能/工具徽章。LiteGraph 节点**不在 React 渲染路径**，不能用
		 *   hook → 用 zustand `useAgentStore.getState().agents` / `usePicklistStore
		 *   .getState().skills/tools` 同步取数（不订阅，避免每次重绘都触发 store 更新）。
		 *
		 *   这是「Saros.Agent/Skill/Tool 是 native LiteGraph 节点，NodeCard 富身份
		 *   卡（React overlay 节点专属）无效」的修复入口。
		 */
		override onDrawForeground(
			ctx: CanvasRenderingContext2D,
			_canvas: unknown,
		): void {
			if (!IDENTITY_NODE_TYPES.has(cfg.type)) { return; }
			// ★ DOM 富卡片接管时让位：挂了 `__saros_form` widget 说明该节点的 body
			//   由 DOM overlay（NodeCard）渲染（Saros.Agent 走这条路，身份卡 +
			//   provider/model + prompt 全在 DOM 层）。此时 canvas 再画一遍身份卡
			//   会与 DOM 卡重叠成花屏。谁接管谁负责 —— 用 widget 存在性做判据，
			//   自适应且无需维护第二份类型名单。
			if (this.widgets?.some(w => w?.name === '__saros_form')) { return; }
			const id = (this.properties?.[
				cfg.type === 'Saros.Agent' ? 'agentId' :
				cfg.type === 'Saros.Skill' ? 'skillName' : 'toolName'
			] as string) ?? '';
			if (!id) {
				// 未配置：画虚线占位框 + 「＋ 选择 …」引导（替代空白/贴边文字）
				const x0 = 8;
				const y0 = this._identityCardTop();
				const w = this.size[0] - 16;
				const h = 26;
				ctx.save();
				ctx.setLineDash([4, 3]);
				ctx.strokeStyle = 'rgba(255,255,255,0.22)';
				ctx.lineWidth = 1;
				ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h);
				ctx.setLineDash([]);
				ctx.fillStyle = '#8a8a8a';
				ctx.font = '10px "Segoe UI", system-ui, sans-serif';
				ctx.textBaseline = 'middle';
				ctx.textAlign = 'center';
				const label = cfg.type === 'Saros.Agent' ? 'Agent' : cfg.type === 'Saros.Skill' ? 'Skill' : 'Tool';
				ctx.fillText('＋ 选择 ' + label, x0 + w / 2, y0 + h / 2);
				ctx.restore();
				return;
			}
			// 从 zustand store 同步取数（不订阅）
			const palette = cfg.type === 'Saros.Agent'
				? { icon: '🤖', color: '#007acc', items: useAgentStore.getState().agents, find: (id: string) => useAgentStore.getState().agents.find(a => a.id === id) }
				: cfg.type === 'Saros.Skill'
					? { icon: '⚡', color: '#b180d7', items: usePicklistStore.getState().skills, find: (id: string) => usePicklistStore.getState().skills.find(s => s.id === id) }
					: { icon: '🔧', color: '#3fb950', items: usePicklistStore.getState().tools, find: (id: string) => usePicklistStore.getState().tools.find(t => t.id === id) };
			const found = palette.find(id);
			const icon = cfg.type === 'Saros.Agent' ? (found && 'icon' in found ? (found as { icon?: string }).icon : '🤖') : palette.icon;
			const name = found?.name ?? id;
			const role = cfg.type === 'Saros.Agent' && found ? ((found as { role?: string }).role ?? '') : '';
			const description = found?.description ?? '';

			// 身份卡顶边（端口行下方，不依赖 widget.last_y —— hidden widget 不参与
			// arrange，last_y 会是 undefined/陈旧值，导致卡片贴边或溢出节点底部）
			const y0 = this._identityCardTop();
			const x0 = 8;
			const w = this.size[0] - 16;

			// 背景框（轻底色 + 1px 边框），与节点颜色形成对比
			ctx.fillStyle = 'rgba(0,0,0,0.18)';
			ctx.fillRect(x0, y0, w, IDENTITY_CARD_H - 6);
			ctx.strokeStyle = palette.color + '55';
			ctx.lineWidth = 1;
			ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, IDENTITY_CARD_H - 7);

			// icon（emoji 用 fillText，跨平台兼容性可）
			ctx.font = '14px "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
			ctx.textBaseline = 'top';
			ctx.fillText(icon, x0 + 6, y0 + 5);

			// name（粗体，clamp 1 行）
			ctx.fillStyle = '#d4d4d4';
			ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
			ctx.fillText(this._truncateText(ctx, name, w - 32), x0 + 26, y0 + 5);

			// role（小字，蓝色，可选）
			if (role) {
				ctx.fillStyle = '#79b8ff';
				ctx.font = '9px "Segoe UI", system-ui, sans-serif';
				ctx.fillText(this._truncateText(ctx, role, w - 32), x0 + 26, y0 + 19);
			}

			// description（灰，clamp 2 行）
			if (description) {
				ctx.fillStyle = '#9a9a9a';
				ctx.font = '9px "Segoe UI", system-ui, sans-serif';
				const lines = this._wrapText(ctx, description, w - 12, 2);
				for (let i = 0; i < lines.length; i++) {
					ctx.fillText(lines[i], x0 + 6, y0 + 32 + i * 11);
				}
			}
		}

		/**
		 * 身份卡顶边 y（body 相对坐标）。
		 *
		 * ★ 不用 `widget.last_y` —— hidden widget 不参与 `arrange()`，`last_y`
		 *   是 undefined 或上一帧的陈旧值，会让卡片贴到节点底边甚至溢出（截图里
		 *   「＋ 选择 Agent」几乎压在边框上就是这个原因）。
		 *
		 * LiteGraph 0.17 坐标：节点内 y=0 = body 顶（标题栏画在 pos[1] **之上**），
		 * 端口第 i 行 y=(i+0.7)*20 → 端口区底部 ≈ rows*20。可见 widget 每行 ~24px。
		 */
		_identityCardTop(): number {
			const rows = Math.max(this.inputs?.length ?? 0, this.outputs?.length ?? 0);
			const visibleWidgets = (this.widgets ?? []).filter(
				w => !(w as unknown as { hidden?: boolean }).hidden,
			).length;
			return rows * 20 + visibleWidgets * 24 + 8;
		}

		/** Truncate text with ellipsis to fit maxWidth. */
		_truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
			if (ctx.measureText(text).width <= maxWidth) { return text; }
			let lo = 0, hi = text.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) { lo = mid + 1; } else { hi = mid; }
			}
			return text.slice(0, Math.max(0, lo - 1)) + '…';
		}

		/** Wrap text into at most maxLines lines. */
		_wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
			const result: string[] = [];
			let current = '';
			for (const ch of text) {
				const next = current + ch;
				if (ctx.measureText(next).width > maxWidth && current.length > 0) {
					result.push(current);
					current = ch;
					if (result.length >= maxLines) { break; }
				} else {
					current = next;
				}
			}
			if (current && result.length < maxLines) { result.push(current); }
			if (result.length === maxLines && text.length > 0) {
				const lastLine = result[maxLines - 1];
				if (ctx.measureText(text).width > maxWidth * maxLines) {
					result[maxLines - 1] = this._truncateText(ctx, lastLine, maxWidth);
				}
			}
			return result;
		}
	};
}

let registered = false;

/** Register all Saros node classes onto LiteGraph (idempotent). */
export function registerSarosLiteGraphNodes(): void {
	if (registered) { return; }
	for (const cfg of NODE_CONFIGS) {
		// Defensive: a node that migrated to kind='schema' owns its LiteGraph
		// class via schemaLiteGraphNodes (canvas title/ports + addDOMWidget
		// form). Never overwrite that registration — registerNodeType is
		// last-write-wins and we run after registerSarosNodes().
		if (getNodeSpec(cfg.type)?.kind === 'schema') { continue; }
		const cls = createSarosNodeClass(cfg);
		LiteGraph.registerNodeType(cfg.type, cls);
	}
	registered = true;
}

/** Reset registration (used by tests). */
export function unregisterSarosLiteGraphNodes(): void {
	for (const cfg of NODE_CONFIGS) {
		try {
			LiteGraph.unregisterNodeType(cfg.type);
		} catch {
			// node type not registered — ignore
		}
	}
	registered = false;
}

/** Public config list (tests + diagnostics). */
export function sarosNodeConfigs(): SarosNodeConfig[] {
	return NODE_CONFIGS;
}
