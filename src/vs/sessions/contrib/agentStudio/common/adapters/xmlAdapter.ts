/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * XML 格式适配器
 * 从模型输出的文本中提取 XML 格式的工具调用，转换为统一 ChatMessage 格式
 *
 * 支持的 XML 格式：
 * - <tool_call>name<script></script>  (Void/Agent-LLM format)
 * - <function_call>...</function_call>  (OpenClaw format)
 * - <tool_use>...</tool_use>  (Anthropic-like format)
 * - <invoke>...</invoke>  (Simple format)
 *
 * 也支持未闭合的 XML 标签（流式输出中常见）
 */

import { ChatMessage, AssistantMessage } from '../chatTypes.js';
import { XmlToolCall } from '../llmMessageTypes.js';

/**
 * 从文本中提取 XML 格式的工具调用
 * @param text 模型输出的文本（可能包含多个工具调用）
 * @returns 提取的工具调用列表
 */
export function extractXmlToolCalls(text: string): XmlToolCall[] {
	const results: XmlToolCall[] = [];

	// 正则1：闭合标签 <tag>...</tag>
	const closedRegex = /<(tool_call|function_call|tool_use|invoke|tool)\s*[^>]*>([\s\S]*?)<\/\1\s*>/gi;
	let match: RegExpExecArray | null;
	while ((match = closedRegex.exec(text)) !== null) {
		const tag = match[1];
		const inner = match[2];
		const parsed = parseXmlToolCallInner(tag, inner, match[0]);
		if (parsed) {
			results.push(parsed);
		}
	}

	// 正则2：未闭合标签 <tag>...（流式输出中常见）
	// 需要找到最后一个完整工具调用之后的未闭合部分
	const lastClosedEnd = results.length > 0 ? text.lastIndexOf('</') : -1;
	const remaining = lastClosedEnd >= 0 ? text.slice(lastClosedEnd) : text;

	const unclosedRegex = /<(tool_call|function_call|tool_use|invoke|tool)\s*[^>]*>([\s\S]*?)(?=<|$)/gi;
	while ((unclosedRegex.exec(remaining)) !== null) {
		// 这个正则比较复杂，暂时用简单方法
		break;
	}

	// 简单方法：用 indexOf 找 <tool 等标签
	const tagNames = ['tool_call', 'function_call', 'tool_use', 'invoke', 'tool'];
	for (const tagName of tagNames) {
		let idx = 0;
		while (idx < text.length) {
			const startIdx = text.indexOf(`<${tagName}`, idx);
			if (startIdx === -1) break;

			const endIdx = text.indexOf(`</${tagName}>`, startIdx);
			let rawXml: string;
			let inner: string;

			if (endIdx !== -1) {
				// 闭合标签
				rawXml = text.slice(startIdx, endIdx + `</${tagName}>`.length);
				inner = text.slice(startIdx + `<${tagName}>`.length, endIdx);
			} else {
				// 未闭合标签（到文本末尾或下一个 < 之前）
				const nextTagIdx = text.indexOf('<', startIdx + 1);
				const contentEnd = nextTagIdx !== -1 ? nextTagIdx : text.length;
				rawXml = text.slice(startIdx, contentEnd);
				inner = text.slice(startIdx + `<${tagName}>`.length, contentEnd);
			}

			const parsed = parseXmlToolCallInner(tagName, inner, rawXml);
			if (parsed) {
				results.push(parsed);
			}

			idx = startIdx + 1;
		}
	}

	return results;
}

function parseXmlToolCallInner(tag: string, inner: string, rawXml: string): XmlToolCall | null {
	// 尝试提取工具名称
	// 格式1：<tag>name args</tag> 或 <tag>name<script>args</script></tag>
	// 格式2：<tag name="xxx">...</tag>
	// 格式3：<tag><name>xxx</name>...</tag>

	let name = '';
	let args = '';

	// 尝试格式2：name 属性
	const nameAttrMatch = inner.match(/name\s*=\s*["']([^"']+)["']/);
	if (nameAttrMatch) {
		name = nameAttrMatch[1];
		args = inner.replace(/name\s*=\s*["'][^"']+["']/, '').trim();
	} else {
		// 尝试格式1：标签内容第一个词是名称
		const firstWordMatch = inner.match(/^(\w[\w_\-]*)\s*([\s\S]*)/);
		if (firstWordMatch) {
			name = firstWordMatch[1];
			args = firstWordMatch[2].trim();
		}
	}

	// 尝试解析 args 为 JSON
	if (args.startsWith('{') && args.endsWith('}')) {
		try {
			JSON.parse(args);
		} catch {
			// 不是有效 JSON，保持原样
		}
	}

	return {
		tag,
		name,
		arguments: args,
		rawXml,
	};
}

/**
 * 将 XML 工具调用转换为 ChatMessage 格式
 */
export function xmlToolCallsToChatMessages(xmlCalls: XmlToolCall[]): ChatMessage[] {
	const messages: ChatMessage[] = [];
	let assistantMsg: AssistantMessage | null = null;

	for (const xmlCall of xmlCalls) {
		// 创建 Assistant 消息（如果有文本内容）
		// XML 格式通常没有单独的文本内容，工具调用就是全部内容
		if (!assistantMsg) {
			assistantMsg = {
				role: 'assistant',
				content: '', // XML 格式通常没有文本内容
				reasoning: '',
				thinking: [],
				timestamp: Date.now(),
			};
			messages.push(assistantMsg);
		}

		// 创建 Tool 消息
		messages.push({
			role: 'tool',
			id: `xml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			name: xmlCall.name,
			params: parseXmlArgs(xmlCall.arguments),
			rawParams: { [xmlCall.name]: xmlCall.arguments },
			result: null,
			status: 'pending',
			timestamp: Date.now(),
		});
	}

	return messages;
}

function parseXmlArgs(argsStr: string): Record<string, unknown> {
	try {
		return JSON.parse(argsStr);
	} catch {
		// 不是 JSON，尝试解析为键值对
		const result: Record<string, unknown> = {};
		const kvRegex = /(\w+)\s*=\s*["']([^"']+)["']/g;
		let match: RegExpExecArray | null;
		while ((match = kvRegex.exec(argsStr)) !== null) {
			result[match[1]] = match[2];
		}
		if (Object.keys(result).length === 0) {
			result._raw = argsStr;
		}
		return result;
	}
}

/**
 * 从模型输出文本中提取工具调用并转换为 ChatMessage（一站式函数）
 */
export function parseModelOutputToChatMessages(text: string): ChatMessage[] {
	const xmlCalls = extractXmlToolCalls(text);
	if (xmlCalls.length === 0) {
		// 没有工具调用，返回纯文本消息
		return [{
			role: 'assistant',
			content: text,
			reasoning: '',
			thinking: [],
			timestamp: Date.now(),
		}];
	}

	return xmlToolCallsToChatMessages(xmlCalls);
}
