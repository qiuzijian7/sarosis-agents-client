/*──────────────────────────────────────────────────────────────
 * Mermaid 图示工具（renderMermaidDiagram）
 *
 * 让 LLM 可调用 Mermaid 渲染工具，将流程图/时序图等渲染后的 SVG
 * 嵌入聊天卡片中预览。支持用 title 参数显示图示标题。
 *──────────────────────────────────────────────────────────────*/

import { IToolDefinition, IToolResultContent } from '../../../common/providers.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';

export const MERMAID_TOOL_NAME = 'renderMermaidDiagram';

export interface MermaidToolContext {
	register: (descriptor: { definition: IToolDefinition; handler: (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string) => Promise<IToolResultContent[] | { content: IToolResultContent[] }> }) => void;
	logService: ILogService;
}

export function registerMermaidTools(ctx: MermaidToolContext): void {
	ctx.register({
		definition: {
			name: MERMAID_TOOL_NAME,
			description: 'IMPORTANT: Call this tool whenever the user asks you to draw a diagram, create a visual chart, or explain something with a diagram. This renders your Mermaid markup as a beautiful interactive SVG diagram in the chat.\n\nParameters:\n- `markup` (required): Mermaid markup string. Must start with the diagram type keyword (e.g., "graph TD\\nA-->B") without wrapping code fence. Escape newlines as \\n.\n- `title` (optional): Short title for the diagram shown in the card header (e.g., "System Architecture").\n\nWhen to use this tool:\n1. User says "画个图" / "visualize" / "diagram" / "流程图" / "时序图" / "架构图"\n2. You want to make a complex concept clear with a visual diagram\n3. User asks to explain something that would benefit from a visual representation\n\nSTRICT MERMAID SYNTAX RULES — violating any of these makes the diagram fail to render, so follow them exactly:\n- Do NOT wrap the markup in ```mermaid fenced blocks. Pass raw markup whose FIRST line is the diagram keyword (graph TD, flowchart LR, sequenceDiagram, etc.).\n- Line breaks INSIDE a node/edge label: use the HTML tag <br> ONLY. NEVER write <br/> or <br /> (self-closing) — the trailing slash is a hard syntax error in Mermaid.\n- classDef / class NAMES: NEVER use a Mermaid reserved keyword as a class name. Forbidden class names: subgraph, end, graph, flowchart, default, style, click, linkStyle, class, classDef, direction. If you want such a name, suffix it (e.g. subgraphCls, endCls).\n- Every `subgraph` MUST be closed by its own `end` on its own line.\n- Keep node IDs simple (ASCII letters, digits, underscore). Put labels with spaces, parentheses, or special chars inside double quotes: A["label with (parens) and spaces"].\n- Do NOT put unescaped parentheses or brackets inside an UNQUOTED label.\n- For sequence diagrams, use `participant A` and `A->>B: text`; do not mix graph and sequence syntax.',
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
			const markup = String(args.markup || '');
			const title = args.title ? String(args.title) : undefined;

			if (!markup.trim()) {
				return [{ type: 'text', text: '[Mermaid] Error: markup is required and cannot be empty.' }];
			}

			// 返回原始 markup（LLM 可以看到并讨论），同时携带 title 给卡片渲染
			const responseText = title
				? `[Mermaid] Diagram "${title}" rendered successfully.\n\nTitle: ${title}\nMarkup:\n${markup}`
				: `[Mermaid] Diagram rendered successfully.\n\nMarkup:\n${markup}`;

			return [{ type: 'text', text: responseText }];
		},
	});

	ctx.logService.info('[MermaidTools] Registered renderMermaidDiagram tool');
}

