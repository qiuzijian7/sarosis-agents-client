/*---------------------------------------------------------------------------------------------
 *  hostBridge.ts —— **宿主桥**（piLoop 与本仓真实服务之间；doc §2/§5 的 P1 接线件）。
 *
 *  移植自（已删除的）piCore/piHostBridge.ts，并**改用 piLoop 的真实接口**（`createPiStreamFn`
 *  直接吃本仓 `IModelProvider`、`toAgentTool` 吃真实 `IToolDefinition`）。
 *
 *  为什么单独一层：被接线的 `turnHost.ts` / `agentOSService.ts` 正在经历 turnKernel 重构
 *  （并发会话，09-19 晚）—— 本层**不修改任何既有文件**，只"读"服务形状；真正的接线
 *  （挂贡献点 / 换 `executeAgentTurnDirect` 内核）在重构落定后由 P2 完成。
 *
 *  现场对拍（重启后，devtools / CDP `Runtime.evaluate`）：
 *    await __SAROSIS_PI_RUN('帮我读 package.json 的前 20 行并总结')
 *  再把同一句发进聊天框（legacy）⇒ 比对两份输出。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import type { IAgentChatMessage } from '../../../../browser/agentChat/agentChatTypes.js';
import type { IChatStreamDelta, IModelProvider, IToolCall } from '../../common/providers.js';
import { runAgentLoop } from './agentLoop.js';
import { createPiStreamFn } from './streamAdapter.js';
import { toAgentTool } from './toolAdapter.js';
import { createPiLoopEventMapper } from './eventAdapter.js';
import { parseArgs } from './kernelUtils.js';
import type { AgentLoopConfig, AgentMessage, AgentTool, AssistantContent, AssistantMessage, Message, Model, ToolResultMessage } from './types.js';

// ─────────────────────────── 历史转换 ───────────────────────────

/** 本仓聊天消息 → piLoop `AgentMessage[]`（user/system 直转；assistant 的 toolCalls 展开成块 + toolResult 回填）。 */
export function chatMessagesToPiMessages(messages: readonly IAgentChatMessage[]): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (const m of messages) {
		if (m.role === 'user') {
			out.push({ role: 'user', content: m.content ?? '', timestamp: m.timestamp ?? Date.now() } as AgentMessage);
		} else if (m.role === 'system') {
			out.push({ role: 'system', content: m.content ?? '', timestamp: m.timestamp ?? Date.now() } as unknown as AgentMessage);
		} else if (m.role === 'assistant') {
			const content: AssistantContent[] = [];
			if (m.thinking) { content.push({ type: 'thinking', thinking: m.thinking }); }
			if (m.content) { content.push({ type: 'text', text: m.content }); }
			const toolResults: ToolResultMessage[] = [];
			for (const tc of m.toolCalls ?? []) {
				const call = chatToolCallToPi(tc);
				if (!call) { continue; }
				content.push(call);
				const resultText = extractToolResultText(tc);
				if (resultText !== undefined) {
					toolResults.push({
						role: 'toolResult', toolCallId: call.id, toolName: call.name,
						content: [{ type: 'text', text: resultText }],
						isError: chatToolCallIsError(tc), timestamp: m.timestamp ?? Date.now(),
					} as ToolResultMessage);
				}
			}
			out.push({
				role: 'assistant', content,
				stopReason: toolResults.length > 0 ? 'toolUse' : 'stop',
			} as unknown as AssistantMessage);
			out.push(...(toolResults as unknown as AgentMessage[]));
		}
	}
	return out;
}

// ─────────────────────────── 只读工具集（对拍用，独立于热点工具链） ───────────────────────────

/**
 * 对拍用的**只读**最小工具集（file_read / file_exists）—— 直接走 `IFileService`，
 * **不经过**正在被重构的工具执行链。第一次现场对拍只需"流式 + 工具调用 + 续跑"的机械正确性。
 */
export function createReadOnlyPiTools(fileService: IFileService): AgentTool[] {
	const exec = async (toolCall: IToolCall, _signal: AbortSignal | undefined) => {
		const args = parseArgs(toolCall.arguments);
		const path = String(args['path'] ?? '');
		if (toolCall.name === 'file_exists') {
			const exists = await fileService.exists(URI.file(path));
			return { content: exists ? 'exists' : 'missing' };
		}
		const content = await fileService.readFile(URI.file(path));
		const text = content.value.toString();
		return { content: text.length > 64_000 ? text.slice(0, 64_000) + '\n…[截断]' : text };
	};
	return [
		toAgentTool(
			{ name: 'file_read', description: '读取一个文本文件的内容（对拍用，只读）。', inputSchema: { type: 'object', properties: { path: { type: 'string', description: '绝对路径' } }, required: ['path'] } },
			exec,
		),
		toAgentTool(
			{ name: 'file_exists', description: '检查一个路径是否存在（对拍用，只读）。', inputSchema: { type: 'object', properties: { path: { type: 'string', description: '绝对路径' } }, required: ['path'] } },
			exec,
		),
	];
}

// ─────────────────────────── 对拍全局入口 ───────────────────────────

/** 对拍结果摘要（返回给 devtools/CDP 调用方，也打进日志）。 */
export interface PiDualRunSummary {
	readonly deltaCount: number;
	readonly text: string;
	readonly toolCalls: readonly string[];
	readonly toolResults: readonly string[];
	readonly turns: number;
	readonly error?: string;
}

/**
 * 安装 `globalThis.__SAROSIS_PI_RUN`（对拍入口）。由 P2 的贡献点调用。
 * ⚠ 不写会话、不落盘：跑 piLoop 内核 + 本仓 IModelProvider + 只读工具，产出摘要。
 */
export function installPiLoopDualRunGlobal(deps: {
	readonly provider: IModelProvider;
	readonly modelId: string;
	readonly fileService: IFileService;
	readonly log: (msg: string) => void;
}): void {
	(globalThis as unknown as Record<string, unknown>)['__SAROSIS_PI_RUN'] = async (prompt: string): Promise<PiDualRunSummary> => {
		const t0 = Date.now();
		deps.log(`[PiDualRun] 开始（piLoop 内核）：${prompt.slice(0, 80)}`);
		const deltas: IChatStreamDelta[] = [];
		let error: string | undefined;
		try {
			const streamFn = createPiStreamFn(deps.provider, { modelId: deps.modelId });
			const model = { id: deps.modelId, name: deps.modelId, api: 'openai-completions', provider: 'saros' } as unknown as Model;
			const config: AgentLoopConfig = { model, convertToLlm: piLoopConvertToLlm };
			// ⚠ 2026-09-20 修正：piLoop 的 `TranscriptContext` 没有 systemPrompt 通道
			// （`normalizeTranscript` 只透传 messages，`createPiStreamFn` 也只转 messages）——
			// 此前把系统提示放在 `context.systemPrompt`，真模型请求里**根本没有它**
			// （对拍测试用 mock streamFn，暴露不出）。必须以 role:'system' 消息携带。
			const context = {
				messages: [{ role: 'system', content: '你是 Saros 的编码助手（对拍模式）。', timestamp: Date.now() } as unknown as AgentMessage],
				systemPrompt: '',
				tools: createReadOnlyPiTools(deps.fileService),
			};
			const mapEvent = createPiLoopEventMapper();
			await runAgentLoop(
				[{ role: 'user', content: prompt, timestamp: Date.now() } as AgentMessage],
				context,
				config,
				async (ev) => { for (const d of mapEvent(ev)) { deltas.push(d); } },
				undefined,
				streamFn,
			);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
		const summary: PiDualRunSummary = {
			deltaCount: deltas.length,
			text: deltas.filter(d => d.type === 'text').map(d => d.content ?? '').join(''),
			toolCalls: deltas.filter(d => d.type === 'tool_start').map(d => d.toolName ?? '?'),
			toolResults: deltas.filter(d => d.type === 'tool_result').map(d => (d.content ?? '').slice(0, 120)),
			turns: deltas.filter(d => d.type === 'assistant_turn').length,
			...(error ? { error } : {}),
		};
		deps.log(`[PiDualRun] 完成（${Date.now() - t0}ms）：${JSON.stringify({ ...summary, text: summary.text.slice(0, 200) })}`);
		return summary;
	};
	deps.log('[PiDualRun] 已安装 __SAROSIS_PI_RUN(prompt)（piLoop 内核 + IModelProvider + 只读工具；不写会话/不落盘）');
}

// ─────────────────────────── 内部小件 ───────────────────────────

/** piLoop `convertToLlm`：过滤自定义/UI-only 条目（契约：不能 throw ⇒ 丢弃而非抛错）。 */
export function piLoopConvertToLlm(messages: readonly AgentMessage[]): readonly Message[] {
	return messages.filter((m): m is Message => {
		const role = (m as { role?: string }).role;
		return role === 'system' || role === 'user' || role === 'assistant' || role === 'toolResult';
	}) as Message[];
}

// 工具参数归一已收口到 kernelUtils.parseArgs（2026-09-20 合并重复实现）。
// ⚠ 历史实证（保留教训）：`toAgentTool.execute` 交给 `ToolExecutor` 的
// `toolCall.arguments` 是**已解析对象**（piLoop 侧已 parse），只认字符串的实现会一律
// 退化成 `{}` ⇒ 只读工具的 `path` 丢失（`URI.file('')` ⇒ 报"is actually a directory"，
// 模型连试 7 次全败）。对象必须直传。

function chatToolCallToPi(tc: unknown): Extract<AssistantContent, { type: 'toolCall' }> | undefined {
	const t = tc as { id?: string; name?: string };
	if (!t?.id || !t.name) { return undefined; }
	return { type: 'toolCall', id: t.id, name: t.name, arguments: parseArgs((tc as { arguments?: unknown }).arguments) };
}

function extractToolResultText(tc: unknown): string | undefined {
	const r = (tc as { result?: unknown }).result;
	if (typeof r === 'string') { return r; }
	if (r && typeof r === 'object' && typeof (r as { text?: unknown }).text === 'string') { return (r as { text: string }).text; }
	return undefined;
}

function chatToolCallIsError(tc: unknown): boolean {
	const t = tc as { isError?: boolean; success?: boolean };
	return t.isError === true || t.success === false;
}
