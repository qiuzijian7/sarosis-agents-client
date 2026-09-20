/*---------------------------------------------------------------------------------------------
 * piHostBridge.ts —— **宿主桥**（piCore 与我方真实服务之间；doc §2/§5 的 P1 接线件）。
 *
 * 为什么单独一层（而不是把接线写进 adapter）：
 *   · `turnHost.ts` / `agentOSService.ts` 正在经历 turnKernel 重构（并发会话，09-19 晚）——
 *     **本层刻意用结构化接口（structural typing）而不 import 那些热点文件的类型**，
 *     让它们怎么重构都不影响本层编译；真正的接线在重构落定后由 P2 完成（届时把结构化口
 *     换成真实类型即可，本层签名不变）。
 *   · 本层**不修改任何既有文件**：只"读"我方服务的形状，产出 piCore 需要的三个口
 *     （模型流源 / 只读工具集 / 历史转换 + 对拍全局入口）。
 *
 * P1 现场对拍的用法（重启后，devtools / CDP `Runtime.evaluate`）：
 *   await __SAROSIS_PI_RUN('帮我读 package.json 的前 20 行并总结')
 *   —— 走 pi 内核 + 我方 LMBridge + 只读工具；把同一句在聊天框（legacy）里发一遍 ⇒ 对拍。
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import type { IAgentChatMessage } from '../../../../browser/agentChat/agentChatTypes.js';
import type { IChatStreamDelta, IModelDelta, IModelOptions } from '../../common/providers.js';
import { runPiCraftTurn } from './piTurnDriver.js';
import { toPiAgentTool } from './toolAdapter.js';
import type { SarosModelStreamSource } from './streamFnAdapter.js';
import type { AgentMessage, AgentTool, AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from './piCoreTypes.js';

// ─────────────────────────── 模型流桥 ───────────────────────────

/** 我方 LMBridge 的 chat 形状（结构化接口 ⇒ 不依赖热点文件的类型）。 */
export interface ILmChatFn {
	(modelId: string, messages: IAgentChatMessage[], options: IModelOptions, context?: unknown): AsyncIterable<IModelDelta>;
}

/** 把我方 LMBridge 的 `chat()` 包装成 piCore 的 `SarosModelStreamSource`。 */
export function createLmBridgeStreamSource(chat: ILmChatFn, modelId: string): SarosModelStreamSource {
	return async function* (req) {
		const messages = piMessagesToChatMessages(req.messages);
		const options: IModelOptions = {
			systemPrompt: req.systemPrompt,
			tools: piToolsToToolDefs(req.tools),
			// TODO(P2 接线)：signal 透传（IModelOptions 是否支持 signal 待接 LMBridge 时核实；
			// P0 由 StreamFnAdapter 逐 delta 检查 signal.aborted 兜底）。
		};
		yield* chat(modelId, messages, options);
	};
}

// ─────────────────────────── 历史转换 ───────────────────────────

/** 我方聊天消息 → pi `AgentMessage[]`（user/system 直转；assistant 的 toolCalls 展开成块）。 */
export function chatMessagesToPiMessages(messages: readonly IAgentChatMessage[]): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (const m of messages) {
		if (m.role === 'user') {
			out.push({ role: 'user', content: m.content ?? '', timestamp: m.timestamp ?? Date.now() });
		} else if (m.role === 'system') {
			out.push({ role: 'system', content: m.content ?? '', timestamp: m.timestamp ?? Date.now() } as AgentMessage);
		} else if (m.role === 'assistant') {
			const content: AssistantMessage['content'] = [];
			if (m.thinking) { content.push({ type: 'thinking', thinking: m.thinking }); }
			if (m.content) { content.push({ type: 'text', text: m.content }); }
			const toolResults: ToolResultMessage[] = [];
			for (const tc of m.toolCalls ?? []) {
				const call = toolCallToPi(tc);
				if (call) {
					content.push(call);
					const resultText = extractToolResultText(tc);
					if (resultText !== undefined) {
						toolResults.push({
							role: 'toolResult', toolCallId: call.id, toolName: call.name,
							content: [{ type: 'text', text: resultText }],
							isError: toolCallIsError(tc), timestamp: m.timestamp ?? Date.now(),
						});
					}
				}
			}
			out.push({
				role: 'assistant', content,
				api: 'openai-completions', provider: 'saros', model: 'unknown',
				usage: emptyUsage(), stopReason: toolResults.length > 0 ? 'toolUse' : 'stop',
				timestamp: m.timestamp ?? Date.now(),
			} as AssistantMessage);
			out.push(...toolResults);
		}
	}
	return out;
}

/** pi `Message[]`（convertToLlm 后的 LLM 形状）→ 我方 `IAgentChatMessage[]`（喂给 LMBridge.chat）。 */
export function piMessagesToChatMessages(messages: readonly unknown[]): IAgentChatMessage[] {
	const out: IAgentChatMessage[] = [];
	for (const raw of messages) {
		const m = raw as Partial<Message> & { role?: string };
		if (m.role === 'user') {
			out.push({ id: `pi-${out.length}`, role: 'user', content: piContentToText(m.content), timestamp: Date.now() });
		} else if (m.role === 'system') {
			out.push({ id: `pi-${out.length}`, role: 'system', content: piContentToText(m.content), timestamp: Date.now() });
		} else if (m.role === 'assistant') {
			const a = m as AssistantMessage;
			const text = a.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
			const thinking = a.content.filter(b => b.type === 'thinking').map(b => (b as { thinking: string }).thinking).join('');
			const toolCalls = a.content.filter(b => b.type === 'toolCall').map(b => b as ToolCall);
			out.push({
				id: `pi-${out.length}`, role: 'assistant', content: text, timestamp: Date.now(),
				...(thinking ? { thinking } : {}),
				...(toolCalls.length ? { toolCalls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) })) } : {}),
			} as IAgentChatMessage);
		} else if (m.role === 'toolResult') {
			// 我方 IAgentChatMessage 无 toolResult 角色 ⇒ 折进最近一条 assistant 的 toolCalls（按 id 对位）。
			const tr = m as ToolResultMessage;
			for (let i = out.length - 1; i >= 0; i--) {
				const last = out[i];
				const tc = last.toolCalls?.find(t => t.id === tr.toolCallId);
				if (tc) {
					(tc as { result?: string }).result = tr.content.map(c => (c as { text?: string }).text ?? '').join('\n');
					break;
				}
			}
		}
	}
	return out;
}

// ─────────────────────────── 只读工具集（对拍用，独立于热点工具链） ───────────────────────────

/**
 * 对拍用的**只读**最小工具集（file_read / search_files）—— 直接走 `IFileService`，
 * **不经过**正在被重构的工具执行链（`compatibilityTools` / 审批 / 护栏）。
 * 用途：第一次现场对拍只需"流式 + 工具调用 + 续跑"的机械正确性，只读工具足够且安全。
 */
export function createReadOnlyPiTools(fileService: IFileService): AgentTool[] {
	return [
		toPiAgentTool(
			{
				name: 'file_read', label: '读文件',
				description: '读取一个文本文件的内容（对拍用，只读）。',
				parameters: { type: 'object', properties: { path: { type: 'string', description: '绝对路径' } }, required: ['path'] },
			},
			async (_name, args) => {
				const uri = URI.file(String(args['path'] ?? ''));
				const content = await fileService.readFile(uri);
				const text = content.value.toString();
				return { content: text.length > 64_000 ? text.slice(0, 64_000) + '\n…[截断]' : text };
			},
		),
		toPiAgentTool(
			{
				name: 'file_exists', label: '文件存在性',
				description: '检查一个路径是否存在（对拍用，只读）。',
				parameters: { type: 'object', properties: { path: { type: 'string', description: '绝对路径' } }, required: ['path'] },
			},
			async (_name, args) => {
				const exists = await fileService.exists(URI.file(String(args['path'] ?? '')));
				return { content: exists ? 'exists' : 'missing' };
			},
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
 * 安装 `globalThis.__SAROSIS_PI_RUN`（对拍入口）。由 P2 的贡献点调用（见 README）。
 *
 * ⚠ 本函数**不改任何状态**：跑 pi 内核、收集 delta、产出摘要；不写会话、不落盘。
 */
export function installPiDualRunGlobal(deps: {
	readonly chat: ILmChatFn;
	readonly modelId: string;
	readonly fileService: IFileService;
	readonly log: (msg: string) => void;
}): void {
	(globalThis as unknown as Record<string, unknown>)['__SAROSIS_PI_RUN'] = async (prompt: string): Promise<PiDualRunSummary> => {
		const t0 = Date.now();
		deps.log(`[PiDualRun] 开始（pi 内核）：${prompt.slice(0, 80)}`);
		const deltas: IChatStreamDelta[] = [];
		let error: string | undefined;
		try {
			const source = createLmBridgeStreamSource(deps.chat, deps.modelId);
			const model = { id: deps.modelId, name: deps.modelId, api: 'openai-completions', provider: 'saros' } as unknown as Model;
			for await (const d of runPiCraftTurn({
				model,
				systemPrompt: '你是 Saros 的编码助手（对拍模式）。',
				prompt,
				tools: createReadOnlyPiTools(deps.fileService),
				modelStream: source,
			})) {
				deltas.push(d);
			}
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
	deps.log('[PiDualRun] 已安装 __SAROSIS_PI_RUN(prompt)（pi 内核 + LMBridge + 只读工具；不写会话/不落盘）');
}

// ─────────────────────────── 内部小件 ───────────────────────────

function piContentToText(content: unknown): string {
	if (typeof content === 'string') { return content; }
	if (!Array.isArray(content)) { return ''; }
	return content.map(c => (c && typeof c === 'object' && (c as { type?: string }).type === 'text') ? String((c as { text?: unknown }).text ?? '') : '').join('');
}

function piToolsToToolDefs(tools: readonly unknown[] | undefined): IModelOptions['tools'] {
	if (!tools?.length) { return undefined; }
	return (tools as readonly { name: string; description?: string; parameters?: Record<string, unknown> }[]).map(t => ({
		name: t.name,
		description: t.description ?? '',
		parameters: t.parameters ?? { type: 'object', properties: {} },
	})) as unknown as IModelOptions['tools'];
}

function toolCallToPi(tc: unknown): ToolCall | undefined {
	const t = tc as { id?: string; name?: string; arguments?: unknown };
	if (!t?.id || !t.name) { return undefined; }
	let args: Record<string, unknown> = {};
	if (typeof t.arguments === 'string') { try { const v = JSON.parse(t.arguments); if (v && typeof v === 'object' && !Array.isArray(v)) { args = v as Record<string, unknown>; } } catch { /* 保留 {} */ } }
	else if (t.arguments && typeof t.arguments === 'object') { args = t.arguments as Record<string, unknown>; }
	return { type: 'toolCall', id: t.id, name: t.name, arguments: args };
}

function extractToolResultText(tc: unknown): string | undefined {
	const r = (tc as { result?: unknown }).result;
	if (typeof r === 'string') { return r; }
	if (r && typeof r === 'object' && typeof (r as { text?: unknown }).text === 'string') { return (r as { text: string }).text; }
	return undefined;
}

function toolCallIsError(tc: unknown): boolean {
	const t = tc as { isError?: boolean; success?: boolean };
	return t.isError === true || t.success === false;
}

function emptyUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
