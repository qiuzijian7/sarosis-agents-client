/*---------------------------------------------------------------------------------------------
 *  pi 内核驱动器 —— 种子历史转换（2026-09-20 自 piTurnKernel.ts 拆出）。
 *
 *  legacy 循环消息 ⇄ piLoop `AgentMessage[]` 的双向转换器。压缩段、plan 拦截段、
 *  checkpoint 落盘都经这对函数往返；保真边界由 `piTurnKernel.test.ts` 的
 *  「pi⇄legacy 往返」用例钉住。
 *--------------------------------------------------------------------------------------------*/

import type { IToolCallInfo } from '../../common/providers.js';
import type { AgentRunMessage } from '../../common/agentRunState.js';
import type {
	AgentMessage,
	AssistantContent,
	AssistantMessage,
	ToolResultMessage,
} from './types.js';
import { asText, parseArgs } from './kernelUtils.js';

/**
 * ★★★ 2026-09-20（用户报「发送代码片段时，好像 llm 没有收到，回答与提问不匹配」✓）：
 * legacy 消息上的 `contentParts`（由 `agentDriverService.buildUserContentParts` 构建 ✓）
 * **内联着附件内容** —— 文本/日志/文件附件会拼成
 * `--- File: code-snippet.txt ---\n<内容>\n--- End of … ---` ✓。
 *
 * 但本转换器此前**只取 `content`** ✗ ⇒ **片段-only 消息**（用户没打文字、只有片段 ✓，
 * 此时 `content` 为空 ✗）到 pi 内核就变成**空 user 消息** ✗✓ ⇒ 模型凭空作答（答非所问 ✓）。
 * 真机取证：`vscode-app-1789910557666.log` —— `msgLen=0` ✓ 且全日志**没有**任何
 * `--- File:` 内联标记 ✓；同时 `[AgentOS] pi-kernel gate ON`（本 turn 走 piLoop ✓）
 * 而 `piLoop/` 里 `contentParts` **零命中** ✗✓。
 *
 * 修法：把 `contentParts` 的**文本块**并进 content ✓（pi 的 user 消息 content 是字符串 ✗，
 * 无法直接承载多模态 parts ✓）。纯文本 parts 本身已是「用户指令 + 附件上下文」的完整形态 ✓
 * （driver 侧保证首个文本块 = `wrapUserQuery(message)` ✓），故**优先取它、否则回落 `content`** ✓，
 * **不叠加** ⇒ 不会重复 ✗✓。
 */
function textIncludingAttachmentContext(m: AgentRunMessage): string {
	const parts = (m as { contentParts?: readonly { type?: string; text?: string }[] }).contentParts;
	if (Array.isArray(parts) && parts.length > 0) {
		const joined = parts
			.filter(p => p?.type === 'text' && typeof p.text === 'string')
			.map(p => p.text as string)
			.join('');
		if (joined.trim()) { return joined; }
	}
	return asText(m.content);
}

/**
 * legacy 循环消息（`{role, content, reasoning?, toolCalls?}` / `{role:'tool', content, toolCallId}`）
 * → piLoop `AgentMessage[]`。
 *
 * 与 `hostBridge.chatMessagesToPiMessages` 的差别：那个吃 **UI 消息**（`IAgentChatMessage`，
 * `toolCalls[].result` 内嵌），这个吃**循环消息**（tool 结果独立成条、靠 `toolCallId` 回挂）。
 * toolResult 的 `toolName` 由前文 assistant 的 toolCalls 按 id 反查（legacy tool 消息不存名字）。
 * 孤儿 tool 消息（无 toolCallId）丢弃 —— 留着会在下一轮请求构成协议错误（executor:2242 同款教训）。
 */
export function loopMessagesToPiMessages(messages: readonly AgentRunMessage[]): AgentMessage[] {
	const toolNameById = new Map<string, string>();
	const out: AgentMessage[] = [];
	for (const m of messages) {
		if (!m || typeof m !== 'object') { continue; }
		const role = m.role;
		if (role === 'user' || role === 'system') {
			// ★★★ 2026-09-20：user 消息带上附件上下文（见 `textIncludingAttachmentContext` ✓）；
			//   system 无附件语义 ⇒ 走 asText 即可 ✓
			out.push({
				role,
				content: role === 'user' ? textIncludingAttachmentContext(m) : asText(m.content),
				timestamp: Date.now(),
			} as unknown as AgentMessage);
			continue;
		}
		if (role === 'assistant') {
			const content: AssistantContent[] = [];
			const reasoning = m['reasoning'];
			if (typeof reasoning === 'string' && reasoning) { content.push({ type: 'thinking', thinking: reasoning }); }
			const text = asText(m.content);
			if (text) { content.push({ type: 'text', text }); }
			const calls = m['toolCalls'];
			let callCount = 0;
			if (Array.isArray(calls)) {
				for (const raw of calls) {
					const tc = raw as { id?: unknown; name?: unknown; arguments?: unknown };
					const id = typeof tc?.id === 'string' ? tc.id : '';
					const name = typeof tc?.name === 'string' ? tc.name : '';
					if (!id || !name) { continue; }
					toolNameById.set(id, name);
					content.push({ type: 'toolCall', id, name, arguments: parseArgs(tc.arguments) });
					callCount++;
				}
			}
			out.push({
				role: 'assistant', content,
				stopReason: callCount > 0 ? 'toolUse' : 'stop',
			} as unknown as AssistantMessage as AgentMessage);
			continue;
		}
		if (role === 'tool') {
			const toolCallId = typeof m['toolCallId'] === 'string' ? m['toolCallId'] as string : '';
			if (!toolCallId) { continue; }
			out.push({
				role: 'toolResult', toolCallId,
				toolName: toolNameById.get(toolCallId) ?? 'unknown',
				content: [{ type: 'text', text: asText(m.content) }],
				isError: false, timestamp: Date.now(),
			} as ToolResultMessage as unknown as AgentMessage);
		}
	}
	return out;
}

/**
 * `loopMessagesToPiMessages` 的**逆转换**（pi → legacy）—— 压缩段的输入缝。
 *
 * 保真边界（压缩关注的字段全保真）：role / content 文本 / reasoning / toolCalls
 * （arguments 回 JSON 字符串）/ toolCallId。丢弃：timestamp / usage / stopReason /
 * toolResult 的 toolName（legacy tool 消息本就不存名字）与 isError、pi 自定义消息
 * （不进 LLM 的 UI-only 条目，`piLoopConvertToLlm` 同样过滤它们 ⇒ 口径一致）。
 */
export function piMessagesToLoopMessages(messages: readonly AgentMessage[]): AgentRunMessage[] {
	const out: AgentRunMessage[] = [];
	for (const m of messages) {
		if (!m || typeof m !== 'object') { continue; }
		const role = (m as { role?: unknown }).role;
		if (role === 'user' || role === 'system') {
			out.push({ role, content: asText((m as { content?: unknown }).content) });
			continue;
		}
		if (role === 'assistant') {
			const msg: AgentRunMessage = { role: 'assistant', content: '' };
			const texts: string[] = [];
			const thinkings: string[] = [];
			const toolCalls: IToolCallInfo[] = [];
			const content = (m as { content?: unknown }).content;
			if (typeof content === 'string') {
				texts.push(content);
			} else if (Array.isArray(content)) {
				for (const block of content as Array<{ type?: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown }>) {
					if (block?.type === 'text' && typeof block.text === 'string') { texts.push(block.text); }
					else if (block?.type === 'thinking' && typeof block.thinking === 'string') { thinkings.push(block.thinking); }
					else if (block?.type === 'toolCall' && block.id && block.name) {
						toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.arguments ?? {}) });
					}
				}
			}
			msg.content = texts.join('');
			if (thinkings.length > 0) { msg['reasoning'] = thinkings.join(''); }
			if (toolCalls.length > 0) { msg['toolCalls'] = toolCalls; }
			out.push(msg);
			continue;
		}
		if (role === 'toolResult') {
			const tr = m as { toolCallId?: unknown; content?: unknown };
			const toolCallId = typeof tr.toolCallId === 'string' ? tr.toolCallId : '';
			if (!toolCallId) { continue; }
			out.push({ role: 'tool', content: asText(tr.content), toolCallId });
		}
		// 其余 role（customMessage 等 UI-only 条目）：与 piLoopConvertToLlm 同口径丢弃
	}
	return out;
}
