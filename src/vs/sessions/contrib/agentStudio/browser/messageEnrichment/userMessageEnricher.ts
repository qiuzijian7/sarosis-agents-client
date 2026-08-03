/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * User Message XML 标签化系统（对齐 CodeBuddy 格式）。
 *
 * 核心原则：
 *   1. 所有标签为**同级兄弟关系**，不是嵌套关系。
 *   2. 标签按顺序排在用户原始消息之前。
 *   3. 部分标签内部包含子标签（如 `<rules>` 内含 `<agent_requestable_workspace_rules>`），
 *      子标签的拼写由 Provider 自行负责，组合器不介入。
 *   4. 每个标签可通过 `description` 属性告知模型该标签的含义。
 *   5. 新增标签 = 实现 IUserMessageTagProvider + 注册到 providers 数组。
 *
 * 输出格式（参考 CodeBuddy）：
 *   <user_info>
 *   OS Version: win32
 *   Shell: PowerShell (Core)
 *   ...
 *   </user_info>
 *
 *   <rules>
 *   The rules section has a number of possible rules...
 *   <agent_requestable_workspace_rules description="...">...content...</agent_requestable_workspace_rules>
 *   <memories description="...">...content...</memories>
 *   </rules>
 *
 *   <git_status>...</git_status>
 *   <project_context>...</project_context>
 *   ...
 *
 *   {actual user query}
 */

import { IAgentTurnRequest } from '../../common/providers.js';
import type { Agent } from '../../../../common/agentStudioTypes.js';

// ═══════════════════════════════════════════════════════════════════════════
// 接口
// ═══════════════════════════════════════════════════════════════════════════

/** 单次 enrich 的上下文，provider 可从中取所需数据。 */
export interface IEnrichContext {
	readonly request: IAgentTurnRequest;
	readonly agent?: Agent;
	/** 线程安全的 AbortSignal（enrich 阶段可随时被取消）。 */
	readonly signal?: AbortSignal;
}

/**
 * 用户消息 XML 标签的产出器。
 * 每个 provider 负责一个顶级标签，返回 null 表示本轮不产出。
 *
 * 契约：
 *   - buildContent 返回的字符串是标签的**完整内容**（含内部子标签和文本）。
 *   - 组合器仅负责在外部包 `<tagName description="...">` 和 `</tagName>`。
 *   - Provider 内部如需拼子标签，请使用辅助函数 `tag()`（从 builtinTagProviders.ts 导出）。
 *   - 返回的内容不应包含未转义的裸 XML 标记字符（`<>&`）。
 */
export interface IUserMessageTagProvider {
	/** 标签名（XML 标签名）。 */
	readonly tagName: string;
	/**
	 * 标签的 description 属性值（会以 `description="..."` 形式出现在开标签上）。
	 * 对于无描述需求的顶级标签（如 user_info），设置为空字符串。
	 */
	readonly tagDescription: string;
	/**
	 * 返回此标签的 XML 内容（含内部子标签）。
	 * 返回 null / undefined / '' 表示本轮不产出此标签。
	 */
	buildContent(ctx: IEnrichContext): Promise<string | null> | string | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 组合器
// ═══════════════════════════════════════════════════════════════════════════

const SAFE_XML_RE = /[<>&]/g;
const SAFE_XML_MAP: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;' };

function escapeXmlAttr(s: string): string {
	return s.replace(/"/g, '&quot;').replace(SAFE_XML_RE, ch => SAFE_XML_MAP[ch] || ch);
}

/**
 * 把各个 provider 产出的内容组合为完整的富化用户消息。
 *
 * 所有标签为同级兄弟，输出格式：
 *   <tag1 description="...">content1</tag1>
 *   <tag2 description="...">content2</tag2>
 *   ...
 *
 *   {原始 userContent}
 */
function composeEnrichedMessage(
	providerOutputs: Array<{ tagName: string; tagDescription: string; content: string }>,
	userContent: string,
): string {
	if (providerOutputs.length === 0) { return userContent; }

	const parts: string[] = [];
	for (const { tagName, tagDescription, content } of providerOutputs) {
		const descAttr = tagDescription ? ` description="${escapeXmlAttr(tagDescription)}"` : '';
		parts.push(`<${tagName}${descAttr}>`);
		parts.push(content);
		parts.push(`</${tagName}>`);
	}
	parts.push('', userContent);
	return parts.join('\n');
}

/**
 * 用户消息 XML 标签化组合器。
 *
 * 使用示例：
 *   const enricher = new UserMessageEnricher([...providers]);
 *   const enriched = await enricher.enrich(originalUserContent, ctx);
 */
export class UserMessageEnricher {
	constructor(private readonly _providers: readonly IUserMessageTagProvider[]) { }

	async enrich(userContent: string, ctx: IEnrichContext): Promise<string> {
		const outputs: Array<{ tagName: string; tagDescription: string; content: string }> = [];

		for (const provider of this._providers) {
			ctx.signal?.throwIfAborted();
			try {
				const content = await provider.buildContent(ctx);
				if (content && content.trim()) {
					outputs.push({
						tagName: provider.tagName,
						tagDescription: provider.tagDescription,
						content,
					});
				}
			} catch (err) {
				// 单个 provider 失败不阻断整体
			}
		}

		return composeEnrichedMessage(outputs, userContent);
	}
}
