/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * piLoop **对拍测试**（2026-09-19，合并后）——"第一版对拍数据"。
 *
 * 方法：同一份 `IModelDelta` 夹具，分别过两条路径，比对**可观测序列**（type/content/toolName/success）：
 *   · legacy 形状：按 `executeAgentTurnDirect` 的 delta 构造约定手工复现的映射（金标准）；
 *   · piLoop 路径：`createPiStreamFn(fakeProvider)` → **真跑 piLoop 内核**（`runAgentLoop`）→ `eventAdapter`。
 *
 * ⚠ 时序约定（对拍中确认的）：`assistant_turn` 在**消息定稿时**（工具执行**之前**）发出 ——
 *   这与 executor 的契约一致（先把本轮 assistant 消息定格，再执行工具）；piLoop 的
 *   `message_end` 正好在此刻触发（这一点 piLoop 比上游 pi 更贴合本仓契约）。
 */
import assert from 'assert';
import type { IChatStreamDelta, IModelDelta, IModelProvider } from '../../common/providers.js';
import { runAgentLoop } from '../../browser/piLoop/agentLoop.js';
import { createPiStreamFn } from '../../browser/piLoop/streamAdapter.js';
import { toAgentTool } from '../../browser/piLoop/toolAdapter.js';
import { createPiLoopEventMapper } from '../../browser/piLoop/eventAdapter.js';
import { piLoopConvertToLlm, createReadOnlyPiTools } from '../../browser/piLoop/hostBridge.js';
import type { AgentMessage, Model } from '../../browser/piLoop/types.js';

const fakeModel = { id: 'test-model', name: 'test', api: 'openai-completions', provider: 'saros' } as unknown as Model;

/** 夹具：两轮（文本 + 工具调用 ⇒ 工具后文本收尾）。 */
function makeFixture(): () => AsyncIterable<IModelDelta> {
	let call = 0;
	return async function* () {
		call++;
		if (call === 1) {
			yield { type: 'text', content: '先读文件。' };
			yield { type: 'tool_call', toolCall: { id: 'call_1', name: 'file_read', arguments: '{"path":"/tmp/a"}' } };
			yield { type: 'done', finishReason: 'tool_calls' };
		} else {
			yield { type: 'text', content: '读完了：内容是 X。' };
			yield { type: 'done', finishReason: 'stop' };
		}
	};
}

/** legacy 形状（手工复现 executor 的 delta 约定 + 时序，作"金标准"）。 */
async function legacyMapping(fixture: () => AsyncIterable<IModelDelta>): Promise<IChatStreamDelta[]> {
	const deltas: IChatStreamDelta[] = [];
	// turn 1：流式
	let text = '';
	let toolCallId = '';
	let toolName = '';
	for await (const d of fixture()) {
		if (d.type === 'text') { text += d.content ?? ''; deltas.push({ type: 'text', content: d.content } as IChatStreamDelta); }
		else if (d.type === 'thinking') { deltas.push({ type: 'thinking', content: d.content } as IChatStreamDelta); }
		else if (d.type === 'tool_call' && d.toolCall) {
			toolCallId = d.toolCall.id; toolName = d.toolCall.name;
			deltas.push({ type: 'tool_start', content: '', toolCallId, toolName } as IChatStreamDelta);
			// 对齐 executor:1924 的真实行为：tool_start 后随发 tool_args（JSON 字符串）
			deltas.push({ type: 'tool_args', content: d.toolCall.arguments ?? '', toolCallId } as IChatStreamDelta);
		}
	}
	// assistant_turn：消息定稿时发出（**先于**工具执行）——对齐 executor 契约
	deltas.push({ type: 'assistant_turn', content: text, metadata: { toolCallIds: [toolCallId] } } as IChatStreamDelta);
	// 工具执行
	deltas.push({ type: 'tool_result', content: 'FILE_BODY_X', toolCallId, toolName } as IChatStreamDelta);
	deltas.push({ type: 'tool_end', toolCallId, success: true } as IChatStreamDelta);
	// turn 2
	let text2 = '';
	for await (const d of fixture()) { if (d.type === 'text') { text2 += d.content ?? ''; deltas.push({ type: 'text', content: d.content } as IChatStreamDelta); } }
	deltas.push({ type: 'assistant_turn', content: text2, metadata: { toolCallIds: [] } } as IChatStreamDelta);
	deltas.push({ type: 'done' } as IChatStreamDelta);
	return deltas;
}

/** piLoop 路径（真跑内核）。capturedOpts 供调用方断言「工具定义送达模型层」。 */
async function piLoopPath(fixture: () => AsyncIterable<IModelDelta>, capturedOpts?: { value: unknown }): Promise<IChatStreamDelta[]> {
	const fakeProvider = {
		chat: (_id: string, _msgs: unknown, opts: unknown) => { if (capturedOpts) { capturedOpts.value = opts; } return fixture(); },
	} as unknown as IModelProvider;
	const tool = toAgentTool(
		{ name: 'file_read', description: '读文件', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
		async () => ({ content: 'FILE_BODY_X' }),
	);
	const deltas: IChatStreamDelta[] = [];
	const streamFn = createPiStreamFn(fakeProvider, { modelId: 'test-model' });
	const mapEvent = createPiLoopEventMapper();
	await runAgentLoop(
		[{ role: 'user', content: 'hi', timestamp: Date.now() } as AgentMessage],
		{ messages: [], systemPrompt: 'sys', tools: [tool] },
		{ model: fakeModel, convertToLlm: piLoopConvertToLlm },
		async (ev) => { for (const d of mapEvent(ev)) { deltas.push(d); } },
		undefined,
		streamFn,
	);
	return deltas;
}

/** 可观测序列（对拍的比较基准）。 */
function observable(deltas: readonly IChatStreamDelta[]): string {
	return deltas.map(d => {
		switch (d.type) {
			case 'text': return `text:${d.content}`;
			case 'thinking': return `thinking:${d.content}`;
			case 'tool_start': return `tool_start:${d.toolName}`;
			case 'tool_args': return `tool_args:${d.content}`;
			case 'tool_result': return `tool_result:${d.content}`;
			case 'tool_end': return `tool_end:${d.success}`;
			case 'assistant_turn': return `assistant_turn:${d.content}`;
			case 'done': return 'done';
			default: return d.type;
		}
	}).join(' > ');
}

suite('piLoop 对拍（同一夹具，两条路径的可观测序列必须一致）', () => {
	test('legacy 形状 ≡ piLoop 路径（文本/工具/结果/assistant_turn/done，含时序）', async () => {
		const legacy = observable(await legacyMapping(makeFixture()));
		const pi = observable(await piLoopPath(makeFixture()));

		assert.strictEqual(pi, legacy, `对拍不一致：\nlegacy: ${legacy}\npiLoop: ${pi}`);

		// 顺带钉住关键断言（防"两侧同错"）：
		assert.ok(legacy.includes('text:先读文件。'), '第一轮文本');
		assert.ok(legacy.includes('tool_start:file_read'), '工具调用');
		assert.ok(legacy.includes('assistant_turn:先读文件。'), 'assistant_turn（消息定稿时）');
		assert.ok(legacy.includes('tool_result:FILE_BODY_X'), '工具结果');
		assert.ok(legacy.includes('text:读完了：内容是 X。'), '第二轮文本（工具后自动续跑）');
		assert.ok(legacy.endsWith('done'), 'done 收尾');
		// 时序：assistant_turn(定稿) 必须**先于** tool_result
		assert.ok(
			legacy.indexOf('assistant_turn:先读文件。') < legacy.indexOf('tool_result:FILE_BODY_X'),
			'assistant_turn 必须先于 tool_result（消息定稿在前，工具执行在后）',
		);
	});

	test('工具定义随 TranscriptContext.tools 送达模型层（2026-09-20 真机实证过的送达缺陷回归钉）', async () => {
		const capturedOpts: { value: unknown } = { value: undefined };
		await piLoopPath(makeFixture(), capturedOpts);

		const tools = (capturedOpts.value as { tools?: Array<{ name: string; inputSchema?: unknown }> })?.tools;
		assert.ok(Array.isArray(tools) && tools.length === 1, `provider.chat 应收到 1 个工具定义，实收: ${JSON.stringify(tools)}`);
		assert.strictEqual(tools![0]!.name, 'file_read');
		assert.ok(tools![0]!.inputSchema, 'inputSchema 应透传（native function calling 依赖它）');
	});

	test('hostBridge 只读工具：arguments 为已解析对象时 path 不丢（真机实证：曾退化成空串 ⇒ 报"是目录"）', async () => {
		const seen: string[] = [];
		const fakeFs = {
			exists: async (uri: { fsPath: string }) => { seen.push('exists:' + uri.fsPath); return true; },
			readFile: async (uri: { fsPath: string }) => { seen.push('read:' + uri.fsPath); return { value: { toString: () => 'PKG_BODY' } }; },
		};
		const tools = createReadOnlyPiTools(fakeFs as never);
		const fileRead = tools.find(t => t.name === 'file_read')!;

		const r = await fileRead.execute('c1', { path: 'g:/SarosWorkspace/sarosis-agents-client/package.json' }, undefined, undefined);

		assert.ok(seen.some(s => s.includes('package.json')), `readFile 应收到真实 path，实收: ${JSON.stringify(seen)}`);
		assert.strictEqual((r.content as Array<{ text: string }>)[0]!.text, 'PKG_BODY');
	});
});
