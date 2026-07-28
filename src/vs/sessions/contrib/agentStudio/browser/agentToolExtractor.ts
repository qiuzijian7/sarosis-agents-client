/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent Tool Extractor — 从 LLM 文本输出中提取工具调用。
 *
 * 从 agentOSService.ts 抽出 13 个方法（~741 行），零 this 状态依赖，
 * 仅通过 ToolExtractorDeps 注入 ILogService 做日志。
 *
 * 支持 7 种提取策略（按优先级）：
 *   1. code-block JSON（```json ... ```）
 *   2. raw JSON 对象
 *   3. XML 格式（<tool_call>, <function_call>, <tool_use>, <invoke>）
 *   4. Bracket 格式（[TOOL_CALL]...[/TOOL_CALL]）
 *   5. ReAct 格式（Action: ...\nAction Input: ...）
 *   6. Python 函数调用（tool_name(arg1="val1")）
 *   7. 纯 JSON 参数 + thinking 推断工具名（qwen 兼容）
 *
 * 所有提取结果经过白名单过滤（enabledTools）。
 */

import { ILogService } from '../../../../platform/log/common/log.js';
import { IToolDefinition, IToolCallInfo } from '../common/providers.js';
import { repairToolArguments } from './toolCallUtils.js';
import { SurroundingsRemover } from '../common/toolExtractionUtils.js';

export interface ToolExtractorDeps {
	readonly logService: ILogService;
}

/**
 * 从 LLM 文本中提取工具调用（7 种策略，按优先级级联）。
 * @param deps 依赖注入（仅 logService）
 * @param text 模型输出文本
 * @param thinkingContent 模型 reasoning/thinking 内容（用于策略 7 推断工具名）
 * @param enabledTools 当前启用的工具列表（用于白名单过滤 + 参数推断）
 */
export function extractToolCallsFromText(
	deps: ToolExtractorDeps,
	text: string,
	thinkingContent?: string,
	enabledTools?: IToolDefinition[]
): IToolCallInfo[] {
	const results: IToolCallInfo[] = [];
	if (!text || text.length < 5) { return results; }

	// 构建工具名白名单 Set — 用于过滤 Python function-call 格式提取时的误匹配
	const enabledToolNames = enabledTools ? new Set(enabledTools.map(t => t.name)) : undefined;

	deps.logService.info(`[AgentOS] _tryExtractToolCallsFromText: attempting extraction from ${text.length} chars (thinking: ${thinkingContent?.length ?? 0} chars)`);

	// 1. 尝试从 ```json 代码块中提取（支持嵌套大括号）
	const codeBlockRegex = /```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```/g;
	let match: RegExpExecArray | null;
	while ((match = codeBlockRegex.exec(text)) !== null) {
		const blockContent = match[1].trim();
		if (!blockContent.startsWith('{')) { continue; }
		try {
			const parsed = JSON.parse(blockContent);
			const tc = parseSingleToolCall(deps, parsed, enabledTools);
			if (tc) {
				deps.logService.info(`[AgentOS] _tryExtractToolCallsFromText: found tool call in code block: ${tc.name}`);
				results.push(tc);
			}
		} catch { /* ignore parse error */ }
	}

	// 2. 如果没找到代码块，尝试从文本中提取 JSON 对象（支持嵌套）
	if (results.length === 0) {
		const extracted = extractJsonObjects(text);
		for (const jsonStr of extracted) {
			try {
				const parsed = JSON.parse(jsonStr);
				const tc = parseSingleToolCall(deps, parsed, enabledTools);
				if (tc) {
					deps.logService.info(`[AgentOS] _tryExtractToolCallsFromText: found tool call in raw JSON: ${tc.name}`);
					results.push(tc);
				}
			} catch { /* ignore parse error */ }
		}
	}

	// 3. XML 格式: <tool_call>...</tool_call> 或 <function_call>...</function_call>
	if (results.length === 0) {
		const hasXmlTags = /<(?:tool_call|function_call|tool_use|invoke|tool)[\s>]/i.test(text);
		deps.logService.info(`[AgentOS] _tryExtractToolCallsFromText: XML extraction attempt, hasXmlTags=${hasXmlTags}, textLen=${text.length}`);
		const xmlResults = extractToolCallsFromXml(deps, text);
		if (xmlResults.length > 0) {
			deps.logService.info(`[AgentOS] _tryExtractToolCallsFromText: found ${xmlResults.length} tool call(s) in XML format`);
			results.push(...xmlResults);
		}
	}

	// 4. Bracket 格式: [TOOL_CALL]...[/TOOL_CALL] 或 [tool_call]...[/tool_call]
	if (results.length === 0) {
		const bracketResults = extractToolCallsFromBrackets(deps, text);
		if (bracketResults.length > 0) {
			deps.logService.info(`[AgentOS] _tryExtractToolCallsFromText: found ${bracketResults.length} tool call(s) in bracket format`);
			results.push(...bracketResults);
		}
	}

	// 5. ReAct 格式: Action: tool_name\nAction Input: {...}
	if (results.length === 0) {
		const reactResults = extractToolCallsFromReAct(text);
		if (reactResults.length > 0) {
			deps.logService.info(`[AgentOS] _tryExtractToolCallsFromText: found ${reactResults.length} tool call(s) in ReAct format`);
			results.push(...reactResults);
		}
	}

	// 6. Python 函数调用格式: tool_name(arg1="val1", arg2="val2")
	if (results.length === 0) {
		const pythonResults = extractToolCallsFromPythonSyntax(deps, text, enabledToolNames);
		if (pythonResults.length > 0) {
			deps.logService.info(`[AgentOS] _tryExtractToolCallsFromText: found ${pythonResults.length} tool call(s) in Python function-call format`);
			results.push(...pythonResults);
		}
	}

	// 7. 如果仍未找到，尝试将整个 content 解析为 JSON 参数对象，
	//    并从 thinking 中提取工具名称（兼容 qwen 等模型：thinking 包含意图，content 只有参数）
	if (results.length === 0) {
		const trimmed = text.trim();
		if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
			try {
				const parsed = JSON.parse(trimmed);
				const tc = parseSingleToolCall(deps, parsed, enabledTools);
				if (tc) {
					results.push(tc);
				} else if (thinkingContent) {
					const toolName = extractToolNameFromThinking(thinkingContent);
					if (toolName) {
						deps.logService.info(`[AgentOS] _tryExtractToolCallsFromText: inferred tool '${toolName}' from thinking, args from content`);
						results.push({
							id: `extracted_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
							name: toolName,
							arguments: trimmed,
						});
					}
				}
			} catch { /* not valid JSON */ }
		}
	}

	// ─── 统一白名单过滤 ──────────────────────────────────────────
	// 所有提取路径（JSON/XML/Bracket/ReAct/Python）的最终结果都需要通过白名单。
	if (enabledToolNames && enabledToolNames.size > 0 && results.length > 0) {
		const before = results.length;
		const filtered = results.filter(tc => {
			if (enabledToolNames!.has(tc.name)) { return true; }
			deps.logService.info(`[AgentOS] _tryExtractToolCallsFromText: filtered out "${tc.name}" (not in enabled tools)`);
			return false;
		});
		if (filtered.length < before) {
			deps.logService.info(`[AgentOS] _tryExtractToolCallsFromText: whitelist filtered ${before} → ${filtered.length} tool calls`);
		}
		results.length = 0;
		results.push(...filtered);
	}

	if (results.length > 0) {
		deps.logService.info(`[AgentOS] _tryExtractToolCallsFromText: extracted ${results.length} tool call(s) from ${text.length} chars`);
	} else {
		deps.logService.info(`[AgentOS] _tryExtractToolCallsFromText: no tool calls found in text: ${text.slice(0, 200)}`);
	}
	return results;
}

// ─── Strategy 3: XML 格式提取 ──────────────────────────────────────

function extractToolCallsFromXml(deps: ToolExtractorDeps, text: string): IToolCallInfo[] {
	const results: IToolCallInfo[] = [];
	const xmlTags = ['tool_call', 'function_call', 'tool_use', 'invoke', 'tool'];

	for (const tag of xmlTags) {
		// 1. 先匹配闭合标签: <tool_call>...</tool_call>
		const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
		let match: RegExpExecArray | null;
		while ((match = regex.exec(text)) !== null) {
			const fullMatch = match[0];
			const content = match[1].trim();
			deps.logService.info(`[AgentOS] _extractToolCallsFromXml: found <${tag}> tag (closed), contentLen=${content.length}, contentPreview=${content.substring(0, 120)}`);
			if (tag === 'tool') {
				const parsed = parseToolXMLFormat(deps, content);
				if (parsed) { results.push(parsed); }
				else { deps.logService.info(`[AgentOS] _extractToolCallsFromXml: _parseToolXMLFormat returned null for <tool> tag`); }
				continue;
			}
			const openTagMatch = fullMatch.match(new RegExp(`^<${tag}[^>]*\\bname\\s*=\\s*["']([^"']+)["'][^>]*>`));
			if (openTagMatch) {
				const toolName = openTagMatch[1];
				deps.logService.info(`[AgentOS] _extractToolCallsFromXml: found tool name from open tag: ${toolName}`);
				let args = '{}';
				try {
					const paramRegex = /<parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([^<]*)<\/parameter>/gi;
					let paramMatch: RegExpExecArray | null;
					const argsObj: Record<string, string> = {};
					while ((paramMatch = paramRegex.exec(content)) !== null) {
						argsObj[paramMatch[1]] = paramMatch[2];
					}
					if (Object.keys(argsObj).length > 0) {
						args = JSON.stringify(argsObj);
					}
				} catch { /* ignore */ }
				results.push({
					id: `xml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					name: toolName,
					arguments: args,
				});
				continue;
			}
			processXmlTagContent(deps, content, results, tag);
		}

		// 2. 兜底: 匹配未闭合标签
		const hasClosingTag = new RegExp(`</${tag}>`, 'i').test(text);
		if (!hasClosingTag) {
			const unclosedRegex = new RegExp(`<${tag}[^>]*>([\\w_\\-]+)(?=\\s*(?:<|$))`, 'gi');
			let unclosedMatch: RegExpExecArray | null;
			while ((unclosedMatch = unclosedRegex.exec(text)) !== null) {
				const content = unclosedMatch[1].trim();
				deps.logService.info(`[AgentOS] _extractToolCallsFromXml: found <${tag}> tag (unclosed), content="${content}"`);
				processXmlTagContent(deps, content, results, tag);
			}
		}
	}
	return results;
}

function tryParseXmlWithSurroundingsRemover(content: string): { name: string; args: string } | null {
	try {
		const pm = new SurroundingsRemover(content);
		const allowedNames = ['name', 'tool_name', 'tool', 'function'];
		let toolName: string | null = null;
		const argsStr = '{}';

		const thinkEnd = pm.value().indexOf('</think>');
		if (thinkEnd !== -1) {
			pm.j = thinkEnd - 1;
		}

		for (const n of allowedNames) {
			const found = pm.removePrefix(`<${n}>`);
			if (found) {
				toolName = n;
				const endIdx = pm.value().indexOf(`</${n}>`);
				if (endIdx !== -1) {
					pm.i = endIdx + `</${n}>`.length;
				}
				break;
			}
		}

		if (!toolName) {
			const attrMatch = pm.value().match(/(?:name|tool|function)\s*[:=]\s*["']?(\w+)["']?/i);
			if (attrMatch) {
				toolName = attrMatch[1];
			}
		}

		if (!toolName) { return null; }

		return { name: toolName, args: argsStr };
	} catch {
		return null;
	}
}

function processXmlTagContent(deps: ToolExtractorDeps, content: string, results: IToolCallInfo[], tag: string): void {
	if (content.startsWith('{')) {
		try {
			const parsed = JSON.parse(content);
			const tc = parseSingleToolCall(deps, parsed);
			if (tc) { results.push(tc); }
		} catch { /* ignore */ }
	} else {
		const cleanContent = content.split(/\s*<\//)[0].trim();

		const argsFromNested: Record<string, string> = {};
		const nestedArgRegex = /<arg_key>\s*([^<]+?)\s*<\/arg_key>\s*<arg_value>\s*([^<]*?)\s*<\/arg_value>/gi;
		let nMatch: RegExpExecArray | null;
		while ((nMatch = nestedArgRegex.exec(content)) !== null) {
			argsFromNested[nMatch[1].trim()] = nMatch[2].trim();
		}

		const xmlParsed = tryParseXmlWithSurroundingsRemover(cleanContent);
		if (xmlParsed) {
			deps.logService.info(`[AgentOS] _processXmlTagContent: parsed via SurroundingsRemover: name=${xmlParsed.name}`);
			results.push({
				id: `xml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				name: xmlParsed.name,
				arguments: xmlParsed.args === '{}' && Object.keys(argsFromNested).length > 0
					? JSON.stringify(argsFromNested)
					: xmlParsed.args,
			});
			return;
		}

		const nameMatch = cleanContent.match(/(?:name|tool|function)\s*[:=]\s*["']?(\w+)["']?/i);
		const argsMatch = cleanContent.match(/(?:arguments?|params?|input)\s*[:=]\s*({[\s\S]*})/i);
		if (nameMatch) {
			let args = '{}';
			if (argsMatch) {
				try { JSON.parse(argsMatch[1]); args = argsMatch[1]; } catch { /* use default */ }
			} else if (Object.keys(argsFromNested).length > 0) {
				args = JSON.stringify(argsFromNested);
			}
			results.push({
				id: `xml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				name: nameMatch[1],
				arguments: args,
			});
		} else if (/^[\w_\-]+$/.test(cleanContent)) {
			deps.logService.info(`[AgentOS] _extractToolCallsFromXml: treating content as raw tool name: "${cleanContent}"`);
			results.push({
				id: `xml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				name: cleanContent,
				arguments: Object.keys(argsFromNested).length > 0 ? JSON.stringify(argsFromNested) : '{}',
			});
		} else {
			deps.logService.info(`[AgentOS] _extractToolCallsFromXml: unprocessable content for <${tag}>: "${cleanContent.substring(0, 60)}"`);
		}
	}
}

// ─── Strategy 4: Bracket 格式提取 ─────────────────────────────────

function extractToolCallsFromBrackets(deps: ToolExtractorDeps, text: string): IToolCallInfo[] {
	const results: IToolCallInfo[] = [];
	const bracketTags = ['TOOL_CALL', 'FUNCTION', 'TOOL', 'ACTION'];

	for (const tag of bracketTags) {
		const regex = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[/${tag}\\]`, 'gi');
		let match: RegExpExecArray | null;
		while ((match = regex.exec(text)) !== null) {
			const content = match[1].trim();
			if (content.startsWith('{')) {
				try {
					const parsed = JSON.parse(content);
					const tc = parseSingleToolCall(deps, parsed);
					if (tc) { results.push(tc); }
				} catch { /* ignore */ }
			} else if (/^[\w_\-]+$/.test(content)) {
				deps.logService.info(`[AgentOS] _extractToolCallsFromBrackets: treating content as raw tool name: "${content}"`);
				results.push({
					id: `bracket_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					name: content,
					arguments: '{}',
				});
			}
		}
	}
	return results;
}

// ─── Strategy 5: ReAct 格式提取 ───────────────────────────────────

function extractToolCallsFromReAct(text: string): IToolCallInfo[] {
	const results: IToolCallInfo[] = [];
	const reactPattern = /Action\s*:\s*(\w+)\s*\n+\s*Action\s*Input\s*:\s*([\s\S]*?)(?=\n\s*(?:Observation|Action|Thought)|\n\n|$)/gi;
	let match: RegExpExecArray | null;
	while ((match = reactPattern.exec(text)) !== null) {
		const toolName = match[1].trim();
		let argsStr = match[2].trim();
		if (!argsStr.startsWith('{')) {
			argsStr = `{"input": ${JSON.stringify(argsStr)}}`;
		} else {
			try { JSON.parse(argsStr); } catch {
				argsStr = `{"input": ${JSON.stringify(argsStr)}}`;
			}
		}
		results.push({
			id: `react_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			name: toolName,
			arguments: argsStr,
		});
	}
	return results;
}

// ─── Strategy 6: Python 函数调用格式提取 ──────────────────────────

function extractToolCallsFromPythonSyntax(
	deps: ToolExtractorDeps,
	text: string,
	enabledTools?: Set<string>
): IToolCallInfo[] {
	const results: IToolCallInfo[] = [];

	const codeBlockRegex = /```(?:python|Python)?\s*\n([\s\S]*?)\n\s*```/g;
	const codeBlocks: string[] = [];
	let cbMatch: RegExpExecArray | null;
	while ((cbMatch = codeBlockRegex.exec(text)) !== null) {
		codeBlocks.push(cbMatch[1].trim());
	}

	const candidates = codeBlocks.length > 0 ? codeBlocks : [text];

	for (const candidate of candidates) {
		const funcCallPattern = /(\w+)\s*\(([\s\S]*?)\)/g;
		let fcMatch: RegExpExecArray | null;
		while ((fcMatch = funcCallPattern.exec(candidate)) !== null) {
			const funcName = fcMatch[1];
			const argsStr = fcMatch[2].trim();

			const skipNames = new Set(['print', 'len', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
				'type', 'isinstance', 'range', 'enumerate', 'zip', 'map', 'filter', 'sorted',
				'if', 'for', 'while', 'with', 'class', 'def', 'return', 'import', 'from',
				'true', 'false', 'none', 'null', 'self', 'super']);
			if (skipNames.has(funcName.toLowerCase())) { continue; }

			if (enabledTools && enabledTools.size > 0) {
				if (!enabledTools.has(funcName)) { continue; }
			} else {
				deps.logService.warn(`[AgentOS] _extractToolCallsFromPythonSyntax: enabledTools is empty, cannot filter "${funcName}"`);
			}

			const args = parsePythonKwargs(argsStr);
			if (args && Object.keys(args).length > 0) {
				results.push({
					id: `pyfunc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					name: funcName,
					arguments: JSON.stringify(args),
				});
			} else if (args !== null) {
				results.push({
					id: `pyfunc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
					name: funcName,
					arguments: '{}',
				});
			}
		}
	}

	return results;
}

function parsePythonKwargs(argsStr: string): Record<string, unknown> | null {
	if (!argsStr || argsStr.trim() === '') { return {}; }

	const trimmed = argsStr.trim();
	if (trimmed.startsWith('{')) {
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch { /* not valid JSON, continue parsing */ }
	}

	const result: Record<string, unknown> = {};
	let i = 0;
	const len = argsStr.length;

	while (i < len) {
		while (i < len && (argsStr[i] === ' ' || argsStr[i] === '\t' || argsStr[i] === '\n' || argsStr[i] === ',')) { i++; }
		if (i >= len) { break; }

		const keyStart = i;
		while (i < len && /[\w_]/.test(argsStr[i])) { i++; }
		const key = argsStr.slice(keyStart, i);
		if (!key) { break; }

		while (i < len && argsStr[i] === ' ') { i++; }
		if (i >= len || argsStr[i] !== '=') { return null; }
		i++;
		while (i < len && argsStr[i] === ' ') { i++; }
		if (i >= len) { break; }

		if (argsStr[i] === '"' || argsStr[i] === "'") {
			const quote = argsStr[i];
			i++;
			let value = '';
			while (i < len && argsStr[i] !== quote) {
				if (argsStr[i] === '\\' && i + 1 < len) {
					const next = argsStr[i + 1];
					if (next === 'n') { value += '\n'; i += 2; }
					else if (next === 't') { value += '\t'; i += 2; }
					else if (next === quote) { value += quote; i += 2; }
					else if (next === '\\') { value += '\\'; i += 2; }
					else { value += next; i += 2; }
				} else {
					value += argsStr[i];
					i++;
				}
			}
			if (i < len) { i++; }
			result[key] = value;
		} else if (argsStr[i] === '{' || argsStr[i] === '[') {
			const open = argsStr[i];
			const close = open === '{' ? '}' : ']';
			let depth = 0;
			const jsonStart = i;
			while (i < len) {
				if (argsStr[i] === open) { depth++; }
				else if (argsStr[i] === close) { depth--; }
				i++;
				if (depth === 0) { break; }
			}
			try {
				result[key] = JSON.parse(argsStr.slice(jsonStart, i));
			} catch {
				result[key] = argsStr.slice(jsonStart, i);
			}
		} else {
			const valStart = i;
			while (i < len && argsStr[i] !== ',' && argsStr[i] !== ' ' && argsStr[i] !== '\n' && argsStr[i] !== ')') { i++; }
			const rawVal = argsStr.slice(valStart, i).trim();
			if (rawVal === 'True' || rawVal === 'true') { result[key] = true; }
			else if (rawVal === 'False' || rawVal === 'false') { result[key] = false; }
			else if (rawVal === 'None' || rawVal === 'null') { result[key] = null; }
			else if (/^-?\d+(\.\d+)?$/.test(rawVal)) { result[key] = Number(rawVal); }
			else { result[key] = rawVal; }
		}
	}

	return Object.keys(result).length > 0 ? result : null;
}

// ─── Strategy 7: thinking 推断工具名 ──────────────────────────────

function extractToolNameFromThinking(thinking: string): string | null {
	if (!thinking) { return null; }

	const zhMatch = thinking.match(/(?:使用|调用|用)\s*[`'""]?(\w+)[`'""]?\s*(?:工具|来|命令)/);
	if (zhMatch) { return zhMatch[1]; }

	const enMatch = thinking.match(/(?:use|call|invoke|using)\s+(?:the\s+)?[`'""]?(\w+)[`'""]?\s*(?:tool|function|command)?/i);
	if (enMatch) { return enMatch[1]; }

	const knownToolPattern = /\b(terminal|file_read|file_write|execute_command|search_files?|list_files?|run_command|shell|bash|exec)\b/i;
	const knownMatch = thinking.match(knownToolPattern);
	if (knownMatch) { return knownMatch[1].toLowerCase(); }

	return null;
}

// ─── JSON 提取工具 ───────────────────────────────────────────────

function extractJsonObjects(text: string): string[] {
	const results: string[] = [];
	let i = 0;
	while (i < text.length) {
		if (text[i] === '{') {
			let depth = 0;
			let inString = false;
			let escape = false;
			const start = i;
			let found = false;
			for (let j = i; j < text.length; j++) {
				const ch = text[j];
				if (escape) { escape = false; continue; }
				if (ch === '\\' && inString) { escape = true; continue; }
				if (ch === '"' && !escape) { inString = !inString; continue; }
				if (inString) { continue; }
				if (ch === '{') { depth++; }
				else if (ch === '}') {
					depth--;
					if (depth === 0) {
						const candidate = text.slice(start, j + 1);
						if (/["'](?:tool_name|tool|function|name)["']\s*:/i.test(candidate) &&
							/["'](?:arguments|args|parameters|params|command)["']\s*:/i.test(candidate)) {
							results.push(candidate);
						}
						i = j + 1;
						found = true;
						break;
					}
				}
			}
			if (!found) { i = start + 1; }
		} else {
			i++;
		}
	}
	return results;
}

// ─── <tool> 标签特殊格式解析 ─────────────────────────────────────

function parseToolXMLFormat(deps: ToolExtractorDeps, content: string): IToolCallInfo | null {
	// 格式 B：<tool_call> 子标签
	const toolCallMatch = content.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
	if (toolCallMatch) {
		try {
			const header = JSON.parse(toolCallMatch[1].trim());
			const args = extractToolDocument(content);
			deps.logService.info(`[AgentOS] _parseToolXMLFormat format B (tool_call): name=${header.name}`);
			return {
				id: header.tool_call_id || header.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				name: header.name || header.tool_name || header.tool || '',
				arguments: args ? JSON.stringify(args) : '{}',
				displayName: header.display_name,
				renderType: header.render_type,
				defaultShow: header.default_show !== false,
			};
		} catch (e) {
			deps.logService.info(`[AgentOS] _parseToolXMLFormat format B parse error: ${e}`);
		}
	}

	// 格式 A：▷ 头部
	const headerMatch = content.match(/[▷►]\s*(\{[\s\S]*?\})\s*\n/);
	if (!headerMatch) {
		const plainJsonMatch = content.match(/^(\{[^<]*?\})\s*\n/);
		if (!plainJsonMatch) {
			deps.logService.info(`[AgentOS] _parseToolXMLFormat: no format matched, content preview=${content.substring(0, 120)}`);
			return null;
		}
		try {
			const header = JSON.parse(plainJsonMatch[1]);
			const args = extractToolDocument(content);
			deps.logService.info(`[AgentOS] _parseToolXMLFormat format A (plain JSON): name=${header.name}`);
			return {
				id: header.tool_call_id || header.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				name: header.name || header.tool_name || header.tool || '',
				arguments: args ? JSON.stringify(args) : '{}',
				displayName: header.display_name,
				renderType: header.render_type,
				defaultShow: header.default_show !== false,
			};
		} catch { return null; }
	}

	try {
		const header = JSON.parse(headerMatch[1]);
		const args = extractToolDocument(content);
		deps.logService.info(`[AgentOS] _parseToolXMLFormat format A (▷ prefix): name=${header.name}`);
		return {
			id: header.tool_call_id || header.id || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			name: header.name || header.tool_name || header.tool || '',
			arguments: args ? JSON.stringify(args) : '{}',
			displayName: header.display_name,
			renderType: header.render_type,
			defaultShow: header.default_show !== false,
		};
	} catch {
		return null;
	}
}

function extractToolDocument(content: string): Record<string, unknown> | null {
	const docMatch = content.match(/<document>([\s\S]*?)<\/document>/);
	if (!docMatch) { return null; }
	try {
		return JSON.parse(docMatch[1].trim());
	} catch {
		return null;
	}
}

// ─── 单个工具调用解析（OpenClaw 式多字段回退）────────────────────

/**
 * 解析单个 JSON 对象为 IToolCallInfo。
 * 支持多字段回退：
 *  - Name: tool_name → function → name → tool
 *  - Args: arguments → args → parameters → params → input (Anthropic)
 *  - ID: id → tool_use_id → toolUseId → tool_call_id
 *
 * 还支持纯参数 JSON 推断：模型只输出参数（如 {"command": "pwd"}），
 * 通过匹配启用的工具 schema 推断工具名。
 */
function parseSingleToolCall(
	deps: ToolExtractorDeps,
	parsed: any,
	enabledTools?: IToolDefinition[]
): IToolCallInfo | null {
	let name = parsed.tool_name || parsed.function || parsed.name || parsed.tool;

	// Fallback 1: {"toolName": {"arg": "val"}} format
	if (!name || typeof name !== 'string') {
		const keys = Object.keys(parsed);
		const reserved = new Set(['id', 'tool_use_id', 'toolUseId', 'tool_call_id']);
		const candidateKeys = keys.filter(k => !reserved.has(k));
		if (candidateKeys.length === 1 && typeof parsed[candidateKeys[0]] === 'object' && parsed[candidateKeys[0]] !== null && !Array.isArray(parsed[candidateKeys[0]])) {
			name = candidateKeys[0];
			return {
				id: `extracted_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
				name,
				arguments: JSON.stringify(parsed[name]),
			};
		}
	}

	// Fallback 2: argument-only JSON — infer tool name from parameter keys
	if (!name && enabledTools && enabledTools.length > 0) {
		const parsedKeys = Object.keys(parsed).filter(k => !['id', 'tool_use_id', 'toolUseId', 'tool_call_id'].includes(k));
		if (parsedKeys.length > 0) {
			let bestMatch: { tool: IToolDefinition; score: number } | null = null;
			for (const tool of enabledTools) {
				const schemaKeys = Object.keys((tool.inputSchema as any)?.properties || {});
				const requiredKeys: string[] = (tool.inputSchema as any)?.required || [];
				let score = 0;
				for (const key of parsedKeys) {
					if (schemaKeys.includes(key)) { score += 2; }
					if (requiredKeys.includes(key)) { score += 3; }
				}
				if (score > 0 && (!bestMatch || score > bestMatch.score)) {
					bestMatch = { tool, score };
				}
			}
			if (bestMatch && bestMatch.score >= 3) {
				name = bestMatch.tool.name;
				deps.logService.info(`[AgentOS] Inferred tool name '${name}' from parameter keys [${parsedKeys.join(', ')}] (score=${bestMatch.score})`);
			}
		}
	}

	if (!name || typeof name !== 'string') {
		return null;
	}

	// Use OpenClaw-style multi-field resolution for arguments
	let rawArgs = parsed.arguments || parsed.args || parsed.parameters || parsed.params || parsed.input;

	// Fallback: some models put args at top-level
	if (!rawArgs || (typeof rawArgs === 'object' && Object.keys(rawArgs).length === 0)) {
		const reservedKeys = new Set(['tool_name', 'function', 'name', 'tool', 'id', 'tool_use_id', 'toolUseId', 'tool_call_id']);
		const inferredArgs: Record<string, any> = {};
		for (const key of Object.keys(parsed)) {
			if (!reservedKeys.has(key)) {
				inferredArgs[key] = parsed[key];
			}
		}
		if (Object.keys(inferredArgs).length > 0) {
			rawArgs = inferredArgs;
		}
	}
	if (!rawArgs) { rawArgs = {}; }

	let argsStr: string;
	if (typeof rawArgs === 'string') {
		const repaired = repairToolArguments(rawArgs);
		argsStr = repaired ? JSON.stringify(repaired) : rawArgs;
	} else if (typeof rawArgs === 'object' && rawArgs !== null) {
		argsStr = JSON.stringify(rawArgs);
	} else {
		argsStr = '{}';
	}

	const id = parsed.id || parsed.tool_use_id || parsed.toolUseId || parsed.tool_call_id
		|| `extracted_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

	return { id: String(id), name, arguments: argsStr };
}
