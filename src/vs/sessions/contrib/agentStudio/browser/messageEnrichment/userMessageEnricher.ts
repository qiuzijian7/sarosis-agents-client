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
import { summarizeProviderError, type IEnrichTagStat } from '../../common/promptDiagnostics.js';

/** 富化结果 + 逐标签统计（供调用方打 `[PromptEnrich]` 日志）。 */
export interface IEnrichResult {
	readonly enriched: string;
	readonly stats: ReadonlyArray<IEnrichTagStat>;
}

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
 *   const result = await enricher.enrichWithStats(originalUserContent, ctx);
 */
export class UserMessageEnricher {
	constructor(private readonly _providers: readonly IUserMessageTagProvider[]) { }

	/**
	 * 富化并返回**逐标签统计**。
	 *
	 * ⚠ 为什么需要 stats（2026-08-22）：原实现里 provider 抛错走 `catch {}`
	 * **完全静默**，某个标签没出现时无法区分「本轮真无内容」与「provider 抛错被
	 * 吞掉」——8 个标签任一坏掉都是无声的。调用方据此打 `[PromptEnrich]` 日志。
	 */
	async enrichWithStats(userContent: string, ctx: IEnrichContext): Promise<IEnrichResult> {
		const outputs: Array<{ tagName: string; tagDescription: string; content: string }> = [];
		const stats: IEnrichTagStat[] = [];

		for (const provider of this._providers) {
			// abort 属于「整体取消」而非「单 provider 失败」，直接向上抛（不记 stats）。
			ctx.signal?.throwIfAborted();
			try {
				const content = await provider.buildContent(ctx);
				if (content && content.trim()) {
					outputs.push({
						tagName: provider.tagName,
						tagDescription: provider.tagDescription,
						content,
					});
					stats.push({ tagName: provider.tagName, chars: content.length, failed: false, empty: false });
				} else {
					// 空产出是**合法**情况（如本轮无 git 变更、无工作区规则），
					// 与失败区分开记录，避免把正常留白当成缺陷去排查。
					stats.push({ tagName: provider.tagName, chars: 0, failed: false, empty: true });
				}
			} catch (err) {
				// 单个 provider 失败不阻断整体（保持原行为），但**必须留痕**。
				stats.push({
					tagName: provider.tagName,
					chars: 0,
					failed: true,
					empty: true,
					error: summarizeProviderError(err),
				});
			}
		}

		return { enriched: composeEnrichedMessage(outputs, userContent), stats };
	}

	/** 兼容旧调用点：只要富化结果，不要统计。 */
	async enrich(userContent: string, ctx: IEnrichContext): Promise<string> {
		return (await this.enrichWithStats(userContent, ctx)).enriched;
	}
}
