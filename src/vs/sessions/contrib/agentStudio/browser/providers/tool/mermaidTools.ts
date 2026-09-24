/*──────────────────────────────────────────────────────────────
 * Mermaid 图示工具（renderMermaidDiagram）
 *
 * 让 LLM 可调用 Mermaid 渲染工具，将流程图/时序图等渲染后的 SVG
 * 嵌入聊天卡片中预览。支持用 title 参数显示图示标题。
 *
 * ★ 2026-09-24：从「只回显 markup」升级为「真实渲染 + 布局体检」。
 *   旧实现的 handler 无条件返回 "rendered successfully" —— 模型拿不到任何反馈，
 *   语法错的图在卡片里渲染失败（用户看到错误块），模型却以为画好了，且**不会重试**。
 *   现在：注入 `IMermaidInlineRenderer.renderToSvg` 做一次真渲染（与卡片同一引擎）
 *     · 失败 ⇒ 返回 mermaid 报错 + 修复检查表（模型据此改 markup 后重新调用）
 *     · 成功 ⇒ 顺带做布局体检（节点数/连线数/画布长宽比），超阈值时给出拆分/换方向建议
 *   ⚠ 渲染器本身不可用（bundle 缺失 / webview 起不来）时**不阻断**：记日志并按旧行为返回成功，
 *     否则一个基建问题会把所有画图请求都变成错误。
 *──────────────────────────────────────────────────────────────*/

import { IToolDefinition, IToolResultContent } from '../../../common/providers.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';

export const MERMAID_TOOL_NAME = 'renderMermaidDiagram';

export interface MermaidToolContext {
	register: (descriptor: { definition: IToolDefinition; handler: (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string) => Promise<IToolResultContent[] | { content: IToolResultContent[] }> }) => void;
	logService: ILogService;
	/**
	 * 真实渲染一次用于校验（宿主注入 `IMermaidInlineRenderer.renderToSvg`，与聊天卡片同一引擎）。
	 * 缺省 ⇒ 跳过校验，退化为旧行为（纯回显）——保证单测与未注入的调用方行为不变。
	 */
	render?: (markup: string, theme?: 'dark' | 'default') => Promise<string>;
}

/** 布局体检阈值（超过即给建议，不阻断渲染） */
const NODE_WARN = 20;
const EDGE_WARN = 30;
const ASPECT_WARN = 4;

/** 渲染器「基建不可用」的报错特征 —— 这类失败不归因到模型写的 markup，不能返回错误。 */
const RENDERER_INFRA_ERROR_MARKERS = ['渲染 bundle 不存在', '渲染 webview', '渲染超时', '渲染不可用'];

const FIX_CHECKLIST = [
	'- 首行必须是图类型关键字（graph TD / flowchart LR / sequenceDiagram / stateDiagram-v2 / classDiagram / erDiagram / gantt / pie / mindmap / timeline）',
	'- 标签内换行只能用 <br>（禁止 <br/> 与 <br />，末尾斜杠是硬语法错）',
	'- classDef / class 名禁用保留字：subgraph、end、graph、flowchart、default、style、click、linkStyle、class、classDef、direction',
	'- 每个 subgraph 必须有自己的 end（单独一行）',
	'- 含空格/括号/特殊字符的标签要加双引号：A["标签 (说明)"]；未加引号的括号会直接报错',
	'- 不要把 graph / flowchart 与 sequenceDiagram 语法混在一张图里',
].join('\n');

export interface IMermaidDiagramMetrics {
	/** 渲染出的节点数（非 flowchart 类图型拿不到 `class="node"` ⇒ 为 0，此时跳过体检） */
	nodes: number;
	/** 连线数 */
	edges: number;
	/** 画布宽度（viewBox 第 3 位；解析不到为 0） */
	width: number;
	/** 画布高度（viewBox 第 4 位；解析不到为 0） */
	height: number;
}

/**
 * 从渲染好的 SVG 里量「布局体检」需要的三个量。
 *
 * 计数口径（mermaid 12 实测，11 节点 / 12 连线的流程图）：`class="node` 出现 11 次、
 * 描边类名里的 `\bedge\b`（如 `edge-thickness-normal`）出现 12 次 ⇒ 与真实节点/连线数一致。
 * `\bedge\b` 不会命中 `edgeLabel` / `edgePath`（词边界后是字母），故无需额外排除。
 */
export function analyzeMermaidSvg(svg: string): IMermaidDiagramMetrics {
	const nodes = (svg.match(/class="node\b/g) ?? []).length;
	const edges = (svg.match(/class="[^"]*\bedge\b[^"]*"/g) ?? []).length;
	const vb = /viewBox="(-?[\d.]+)\s+(-?[\d.]+)\s+([\d.]+)\s+([\d.]+)"/.exec(svg);
	return {
		nodes,
		edges,
		width: vb ? Number(vb[3]) : 0,
		height: vb ? Number(vb[4]) : 0,
	};
}

/** 布局体检建议（空数组 = 无需建议）。只在量到节点时成立，故 nodes === 0 直接跳过。 */
export function layoutAdvice(m: IMermaidDiagramMetrics): string[] {
	if (m.nodes <= 0) {
		return [];
	}
	const advice: string[] = [];
	if (m.nodes > NODE_WARN) {
		advice.push(`节点 ${m.nodes} 个（建议 ≤ ${NODE_WARN}）：用 subgraph 按子系统分组，或拆成多张分主题的图。`);
	}
	if (m.edges > EDGE_WARN) {
		advice.push(`连线 ${m.edges} 条（建议 ≤ ${EDGE_WARN}）：合并同向连线、去掉冗余的返回边，交叉会明显减少。`);
	}
	if (m.width > 0 && m.height > 0) {
		const ratio = m.width / m.height;
		const size = `${Math.round(m.width)}×${Math.round(m.height)}`;
		if (ratio >= ASPECT_WARN) {
			advice.push(`画布偏宽（${size}，${ratio.toFixed(1)}:1）：改 TD（自上而下）或加 subgraph 分组更易读。`);
		} else if (ratio <= 1 / ASPECT_WARN) {
			advice.push(`画布偏长（${size}，1:${(1 / ratio).toFixed(1)}）：改 LR（自左向右）会更紧凑。`);
		}
	}
	return advice;
}

/**
 * 剥掉 ```mermaid 围栏。工具描述已明确要求「不要围栏」，但模型仍会偶发违反；
 * 围栏本身在 mermaid 语法里是非法字符 ⇒ 直接渲染失败（用户看到错误块）。
 */
export function unwrapMarkupFence(raw: string): string {
	let out = raw.trim();
	if (out.startsWith('```')) {
		out = out.replace(/^```[a-zA-Z]*[ \t]*\r?\n?/, '');
		out = out.replace(/\r?\n?```[ \t]*$/, '');
	}
	return out.trim();
}

function isRendererInfraError(message: string): boolean {
	return RENDERER_INFRA_ERROR_MARKERS.some(marker => message.includes(marker));
}

function renderFailureText(message: string): string {
	return [
		'[Mermaid] Error: 图示渲染失败，聊天卡片不会显示这张图。请按下述报错修正 markup 后**重新调用**本工具。',
		'',
		`Render error: ${message}`,
		'',
		'修复检查表：',
		FIX_CHECKLIST,
	].join('\n');
}

export function registerMermaidTools(ctx: MermaidToolContext): void {
	ctx.register({
		definition: {
			name: MERMAID_TOOL_NAME,
			description: 'IMPORTANT: Call this tool whenever the user asks you to draw a diagram, create a visual chart, or explain something with a diagram. This renders your Mermaid markup as a beautiful interactive SVG diagram in the chat.\n\nParameters:\n- `markup` (required): Mermaid markup string. Must start with the diagram type keyword (e.g., "graph TD\\nA-->B") without wrapping code fence. Escape newlines as \\n.\n- `title` (optional): Short title for the diagram shown in the card header (e.g., "System Architecture").\n\nWhen to use this tool:\n1. User says "画个图" / "visualize" / "diagram" / "流程图" / "时序图" / "架构图"\n2. You want to make a complex concept clear with a visual diagram\n3. User asks to explain something that would benefit from a visual representation\n\nSTRICT MERMAID SYNTAX RULES — violating any of these makes the diagram fail to render, so follow them exactly:\n- Do NOT wrap the markup in ```mermaid fenced blocks. Pass raw markup whose FIRST line is the diagram keyword (graph TD, flowchart LR, sequenceDiagram, etc.).\n- Line breaks INSIDE a node/edge label: use the HTML tag <br> ONLY. NEVER write <br/> or <br /> (self-closing) — the trailing slash is a hard syntax error in Mermaid.\n- classDef / class NAMES: NEVER use a Mermaid reserved keyword as a class name. Forbidden class names: subgraph, end, graph, flowchart, default, style, click, linkStyle, class, classDef, direction. If you want such a name, suffix it (e.g. subgraphCls, endCls).\n- Every `subgraph` MUST be closed by its own `end` on its own line.\n- Keep node IDs simple (ASCII letters, digits, underscore). Put labels with spaces, parentheses, or special chars inside double quotes: A["label with (parens) and spaces"].\n- Do NOT put unescaped parentheses or brackets inside an UNQUOTED label.\n- For sequence diagrams, use `participant A` and `A->>B: text`; do not mix graph and sequence syntax.\n\nREADABILITY / LAYOUT RULES — a diagram that renders but is unreadable is still a failure:\n- Keep ONE diagram to ONE idea: aim for <= 20 nodes. If the concept needs more, call this tool 2-3 times with smaller sub-diagrams (one per subsystem) instead of one giant chart.\n- Choose the direction by shape: deep chains/single flow use `TD` (top-down); wide comparisons or long pipelines use `LR` (left-right). Never leave the direction implicit when the layout would be extreme.\n- Group related nodes with `subgraph <name> ... end` — grouping is what keeps big diagrams legible, and it must always be closed with `end`.\n- Keep labels short (<= ~15 chars, Chinese <= 10 chars). Put details in your chat text, not in the node label.\n- Avoid bidirectional or redundant edges (A-->B and B-->A, or a return edge that just repeats the forward flow) — they are the main source of edge crossings.\n- Do NOT use `linkStyle` / `style` to hand-pick node colors: the default theme is already tuned for light/dark; custom colors usually clash with it.',
			inputSchema: {
				type: 'object',
				properties: {
					markup: {
						type: 'string',
						description: 'Mermaid markup string. Must start with the diagram type keyword (e.g., "graph TD\\nA-->B") without a wrapping code fence. Escape newlines as \\n.',
					},
					title: {
						type: 'string',
						description: 'Optional short title for the diagram, shown in the card header (e.g., "System Architecture", "Login Flow").',
					},
				},
				required: ['markup'],
			},
		},
		handler: async (args: Record<string, unknown>): Promise<IToolResultContent[]> => {
			// 回显用原文（保持既有行为：模型写的是 \n 转义就回显转义形态），
			// 渲染/校验用「还原换行 + 剥围栏」后的形态（与卡片的渲染口径一致）。
			const original = String(args.markup || '');
			const title = args.title ? String(args.title) : undefined;
			const markup = unwrapMarkupFence(original.replace(/\\n/g, '\n'));

			if (!markup.trim()) {
				return [{ type: 'text', text: '[Mermaid] Error: markup is required and cannot be empty.' }];
			}

			let advice: string[] = [];
			if (ctx.render) {
				try {
					const svg = await ctx.render(markup, 'default');
					if (!svg || svg.indexOf('<svg') === -1) {
						throw new Error('渲染器返回空 SVG');
					}
					advice = layoutAdvice(analyzeMermaidSvg(svg));
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					if (isRendererInfraError(message)) {
						// 基建问题（bundle 未构建 / webview 起不来）不该归因到模型：记日志，按旧行为放行。
						ctx.logService.warn(`[MermaidTools] renderer unavailable, skip validation: ${message}`);
					} else {
						ctx.logService.warn(`[MermaidTools] render validation failed: ${message}`);
						return [{ type: 'text', text: renderFailureText(message) }];
					}
				}
			}

			const responseText = title
				? `[Mermaid] Diagram "${title}" rendered successfully.\n\nTitle: ${title}\nMarkup:\n${original}`
				: `[Mermaid] Diagram rendered successfully.\n\nMarkup:\n${original}`;

			const fullText = advice.length > 0
				? `${responseText}\n\n布局体检（图示已渲染，以下为可读性建议，无需重画也可以）：\n${advice.map(a => `- ${a}`).join('\n')}`
				: responseText;

			return [{ type: 'text', text: fullText }];
		},
	});

	ctx.logService.info(`[MermaidTools] Registered ${MERMAID_TOOL_NAME} tool (validation=${ctx.render ? 'on' : 'off'})`);
}
