/*──────────────────────────────────────────────────────────────
 * Draw.io 图示工具（renderDrawioDiagram）
 *
 * 2026-09-11 补全：此前 drawio 是**半成品** —— 渲染器
 * （`drawioInlineRenderer.ts`）、聊天卡片（`agentChatPanel.drawioCard.ts`）、
 * 预览命令（`_drawio-chat.openPreview`）、构建脚本（`esbuild.drawio-inline.mjs`）
 * 全部就绪，**唯独缺这个工具 handler**（`browser/providers/tool/` 下有
 * `mermaidTools.ts` 却没有 `drawioTools.ts`）。
 *
 * 后果：`bundledTools.ts` 里的 `renderDrawioDiagram` 定义因 `ctx.hasTool()` 未命中
 * 而被注册成 **stub**（`isStub → listTools` 跳过）→ **模型根本看不到该工具**，
 * 整条 drawio 链路（渲染器 / 卡片 / 预览）成了永远走不到的**死代码**。
 *
 * 本文件与 `mermaidTools.ts` **完全对称**（同一套注册上下文、同样的「回显 +
 * 由卡片渲染」策略）—— 渲染不由 handler 负责：handler 只回显 source 供 LLM
 * 阅读与讨论，实际 SVG 渲染由 `agentChatPanel.drawioCard.ts` 通过
 * `_agentStudio.renderDrawioSvg` 命令完成。
 *──────────────────────────────────────────────────────────────*/

import { IToolDefinition, IToolResultContent } from '../../../common/providers.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';

export const DRAWIO_TOOL_NAME = 'renderDrawioDiagram';

/**
 * mxGraphModel 根元素探测。
 *
 * ★ 刻意**不**要求「以 `<mxGraphModel` 开头」：drawio 的实际导出形态有多种 ——
 * 可能带 XML 声明（`<?xml version="1.0" encoding="UTF-8"?>`）、可能有前导空白 /
 * BOM、也可能被 `<mxfile><diagram>` 包裹。用「包含根元素」做判据可避免把**合法**
 * 输入误拒（误拒比漏放更糟：模型拿到错误提示后会放弃整张图）。
 */
const MXGRAPH_ROOT_RE = /<mxGraphModel[\s>]/i;

export interface DrawioToolContext {
	register: (descriptor: { definition: IToolDefinition; handler: (args: Record<string, unknown>, signal?: AbortSignal, agentId?: string) => Promise<IToolResultContent[] | { content: IToolResultContent[] }> }) => void;
	logService: ILogService;
}

export function registerDrawioTools(ctx: DrawioToolContext): void {
	ctx.register({
		definition: {
			name: DRAWIO_TOOL_NAME,
			description: 'IMPORTANT: Call this tool whenever the user provides a Draw.io / diagrams.net (mxGraphModel XML) diagram and wants it rendered as a read-only SVG preview inside the chat. Use for architecture diagrams, flowcharts, network topologies, and any drawio-format source. When the user says "drawio"/"mxGraph"/"diagrams.net"/"架构图(drawio)" and supplies raw XML, call this tool with the mxGraphModel XML.\n\nParameters:\n- `source` (required): Raw Draw.io mxGraphModel XML string (must contain the `<mxGraphModel>` root element of a diagrams.net export). Do NOT wrap it in a code fence.\n- `title` (optional): Short title shown in the card header (e.g., "System Architecture").\n\nWhen to use this tool:\n1. User pastes / attaches drawio XML (starts with `<mxGraphModel` or is wrapped in `<mxfile><diagram>`)\n2. User says "drawio" / "mxGraph" / "diagrams.net" / "架构图(drawio)"\n\nNOTE: Mermaid syntax (graph TD / sequenceDiagram / ...) must go to `renderMermaidDiagram` instead — the two renderers are NOT interchangeable (drawio source is mxGraphModel XML, not Mermaid text).',
			inputSchema: {
				type: 'object',
				properties: {
					source: {
						type: 'string',
						description: 'Raw Draw.io mxGraphModel XML string. Must contain the `<mxGraphModel` root element of a diagrams.net diagram export. No wrapping code fence.',
					},
					title: {
						type: 'string',
						description: 'Optional short title for the diagram, shown in the card header (e.g., "System Architecture", "Network Topology").',
					},
				},
				required: ['source'],
			},
		},
		handler: async (args: Record<string, unknown>): Promise<IToolResultContent[]> => {
			const source = String(args.source || '');
			const title = args.title ? String(args.title) : undefined;

			if (!source.trim()) {
				return [{ type: 'text', text: '[Drawio] Error: source is required and cannot be empty.' }];
			}

			// 早失败：格式不对时立刻给出可操作的指引，而不是让卡片渲染阶段抛错
			// （那时模型已经拿不到修正机会，用户只看到一个失败卡片）。
			if (!MXGRAPH_ROOT_RE.test(source)) {
				return [{
					type: 'text',
					text: '[Drawio] Error: source does not look like Draw.io mxGraphModel XML — the `<mxGraphModel>` root element was not found.\n'
						+ 'Pass the raw XML exported from diagrams.net / draw.io (it must contain `<mxGraphModel ...>`), without a code fence.\n'
						+ 'If you meant to draw a diagram from text syntax (graph TD / sequenceDiagram / ...), call `renderMermaidDiagram` instead.',
				}];
			}

			// 与 mermaid 同策略：回显原始 source（LLM 可以看到并讨论），title 由卡片读取。
			const responseText = title
				? `[Drawio] Diagram "${title}" rendered successfully.\n\nTitle: ${title}\nSource:\n${source}`
				: `[Drawio] Diagram rendered successfully.\n\nSource:\n${source}`;

			return [{ type: 'text', text: responseText }];
		},
	});

	ctx.logService.info('[DrawioTools] Registered renderDrawioDiagram tool');
}
