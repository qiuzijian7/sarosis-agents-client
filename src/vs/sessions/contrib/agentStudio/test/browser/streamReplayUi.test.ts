/*---------------------------------------------------------------------------------------------
 *  streamReplayUi.test.ts
 *
 *  基于流式记录数据（JSONL fixture / 内联场景）回放验证聊天框消息模型的正确性。
 *
 *  StreamReplayModel 是 nativeChatEditorPane 流式处理的「消息模型镜像」：
 *  复刻 _processDelta（text 段基线 / tool_start→parts / tool_args / tool_result /
 *  tool_end / subagent_batch / done 收尾）与 onDidSubAgentTrace 的合并语义
 *  （按 id last-write-wins + parentToolCallId 内部 ID → 真实 callId 重映射 +
 *  tc.subAgents 内嵌挂载），不涉 DOM。fixture 来自 agentStreamRecorder 的记录格式，
 *  保证「记录 → 回放 → 断言」闭环与线上数据形状一致。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { flattenMessageParts, type IMessagePart, type IToolCall } from '../../../../browser/agentChat/agentChatTypes.js';
import {
	formatEndLine, formatMetaLine, formatRecordLine, parseRecordFile, sanitizeDeltaForRecord,
	type IStreamRecordLine,
} from '../../browser/agentStreamRecorder.js';

// ─── 消息模型镜像（与 pane 流式处理规则对齐）─────────────────────────────

interface IReplayMsg {
	id: string;
	role: 'assistant';
	content: string;
	thinking?: string;
	parts: IMessagePart[];
	toolCalls?: IToolCall[];
	subAgents?: any[];
}

/**
 * 复刻 pane 的 delta → 消息模型规则（无 DOM 版本）。规则源：
 *  - _processDelta：text 增量/全量、_streamTextSegmentBase 分段、tool parts、done 收尾
 *  - onDidSubAgentTrace：id last-write-wins 合并 + _lastDelegateToolCallId 重映射
 */
class StreamReplayModel {
	readonly msg: IReplayMsg = { id: 'msg_replay', role: 'assistant', content: '', parts: [] };
	private _segmentBase = 0;
	private _lastDelegateToolCallId: string | undefined;

	applyDelta(delta: any): void {
		const msg = this.msg;
		switch (delta?.type) {
			case 'text': {
				const textContent = (delta.fullText !== undefined && delta.fullText.length >= msg.content.length)
					? delta.fullText
					: (msg.content + (delta.content ?? ''));
				msg.content = textContent;
				const segText = textContent.slice(this._segmentBase);
				const last = msg.parts[msg.parts.length - 1];
				if (last && last.kind === 'text') {
					(last as any).text = segText;
				} else if (segText.length > 0) {
					msg.parts.push({ kind: 'text', text: segText } as any);
				}
				break;
			}
			case 'thinking': {
				msg.thinking = delta.fullThinking !== undefined ? delta.fullThinking : ((msg.thinking ?? '') + (delta.content ?? ''));
				break;
			}
			case 'tool_start': {
				if (!msg.toolCalls) { msg.toolCalls = []; }
				const id = delta.toolCallId ?? `tool_${Date.now()}`;
				msg.toolCalls.push({
					id, name: delta.toolName ?? '', args: '', status: 'running',
					textPosition: typeof delta.textPosition === 'number' ? delta.textPosition : msg.content.length,
				} as IToolCall);
				if (delta.toolName === 'delegate_task' || delta.toolName === 'plan_explore') {
					this._lastDelegateToolCallId = id;
				}
				const tcRef = msg.toolCalls[msg.toolCalls.length - 1];
				msg.parts.push({ kind: 'tool', tool: tcRef } as any);
				this._segmentBase = msg.content.length;
				break;
			}
			case 'tool_args': {
				const tc = (msg.toolCalls ?? []).find(t => t.id === delta.toolCallId);
				if (tc) { tc.args = (tc.args ?? '') + (delta.content ?? ''); }
				break;
			}
			case 'tool_result': {
				const tc = (msg.toolCalls ?? []).find(t => t.id === delta.toolCallId) as any;
				if (tc) {
					tc.result = delta.content;
					if (tc.status === 'running') { tc.status = 'success'; }
				}
				break;
			}
			case 'tool_end': {
				const tc = (msg.toolCalls ?? []).find(t => t.id === delta.toolCallId) as any;
				if (tc) {
					tc.status = delta.success === false ? 'error' : 'success';
				}
				break;
			}
			case 'subagent_batch': {
				const saData = delta.subagentData as any[];
				if (!saData) { break; }
				if (delta.toolCallId) {
					for (const sa of saData) { if (sa) { sa.parentToolCallId = delta.toolCallId; } }
					const parentTc = (msg.toolCalls ?? []).find(t => t.id === delta.toolCallId) as any;
					if (parentTc) { parentTc.subAgents = saData; }
				}
				msg.subAgents = saData;
				break;
			}
			case 'done': {
				for (const tc of msg.toolCalls ?? []) {
					if (tc.status === 'running') { tc.status = 'success'; }
				}
				break;
			}
		}
	}

	/** 复刻 onDidSubAgentTrace 的合并 + 重映射 + 挂载语义（去掉 50ms throttle）。 */
	applySubAgentTrace(snapshot: { groupId?: string; subagentData?: any[] }): void {
		const msg = this.msg;
		const saData = snapshot?.subagentData;
		if (!saData || saData.length === 0) { return; }
		const merged = new Map<string, any>((msg.subAgents ?? []).map(s => [s.id, s]));
		for (const sa of saData) { if (sa?.id) { merged.set(sa.id, sa); } }
		msg.subAgents = [...merged.values()];
		this._remapAndAttachSubAgents();
	}

	/** 复刻 nativeChatEditorPane._remapAndAttachSubAgents（按内部 id 分组 → 各自 delegate 卡）。 */
	private _remapAndAttachSubAgents(): void {
		const msg = this.msg;
		const subAgents = (msg.subAgents ?? []) as any[];
		if (subAgents.length === 0) { return; }
		const delegateTcs = (msg.toolCalls ?? []).filter(
			(tc: any) => tc?.name === 'delegate_task' || tc?.name === 'plan_explore') as any[];
		if (delegateTcs.length === 0) { return; }
		const usedTc = new Set<string>();
		for (const sa of subAgents) {
			const pid = sa?.parentToolCallId;
			if (pid && delegateTcs.some(tc => tc.id === pid)) { usedTc.add(pid); }
		}
		const internalGroups = new Map<string, any[]>();
		for (const sa of subAgents) {
			const pid = sa?.parentToolCallId;
			if (!pid || delegateTcs.some(tc => tc.id === pid)) { continue; }
			let g = internalGroups.get(pid);
			if (!g) { g = []; internalGroups.set(pid, g); }
			g.push(sa);
		}
		for (const group of internalGroups.values()) {
			const probeTask = group[0]?.task;
			let target = delegateTcs.find(tc => !usedTc.has(tc.id)
				&& this._delegateTaskKeys(tc).some(k => this._taskKeyMatch(probeTask, k)));
			if (!target) { target = delegateTcs.find(tc => !usedTc.has(tc.id)); }
			if (!target && this._lastDelegateToolCallId) {
				target = delegateTcs.find(tc => tc.id === this._lastDelegateToolCallId);
			}
			if (target) {
				usedTc.add(target.id);
				for (const sa of group) { sa.parentToolCallId = target.id; }
			}
		}
		for (const tc of delegateTcs) {
			const own = subAgents.filter((s: any) => s?.parentToolCallId === tc.id);
			if (own.length > 0) { tc.subAgents = own; }
		}
	}

	private _delegateTaskKeys(tc: any): string[] {
		const keys: string[] = [];
		const raw = tc?.args;
		let a: any = undefined;
		if (typeof raw === 'string' && raw.length > 0) {
			try { a = JSON.parse(raw); } catch { keys.push(raw); }
		} else if (raw && typeof raw === 'object') { a = raw; }
		if (a) {
			if (typeof a.task === 'string') { keys.push(a.task); }
			if (Array.isArray(a.tasks)) {
				for (const t of a.tasks) { keys.push(typeof t === 'string' ? t : String(t?.task ?? t?.description ?? '')); }
			}
		}
		return keys.filter(k => k && k.length > 0);
	}

	private _taskKeyMatch(a: string | undefined, b: string | undefined): boolean {
		if (!a || !b) { return false; }
		const n = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
		const x = n(a), y = n(b);
		if (!x || !y) { return false; }
		const len = Math.min(x.length, y.length, 100);
		if (len < 8) { return x === y; }
		return x.slice(0, len) === y.slice(0, len);
	}

	/** 回放一条记录行（subagent_trace 走总线路径，其余走主流 delta 路径）。 */
	applyRecord(rec: IStreamRecordLine): void {
		const delta = rec.delta as any;
		if (delta?.type === 'subagent_trace') {
			this.applySubAgentTrace(delta);
		} else {
			this.applyDelta(delta);
		}
	}
}

function loadFixture(name: string): string {
	const p = path.resolve(process.cwd(), 'src/vs/sessions/contrib/agentStudio/test/fixtures/stream-records', name);
	return fs.readFileSync(p, 'utf8');
}

// ─── 测试 ────────────────────────────────────────────────────────────────

suite('Stream Replay UI', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── 记录器纯函数 ─────────────────────────────────────────────────

	suite('agentStreamRecorder pure fns', () => {

		test('formatRecordLine → parseRecordFile round-trip', () => {
			const text = [
				formatMetaLine({ agentId: 'a1', sessionId: 's1', startedAt: 1000 }),
				formatRecordLine(5, { type: 'text', content: 'hi' }),
				formatRecordLine(9, { type: 'tool_start', toolCallId: 't1', toolName: 'file_read' }),
				formatEndLine({ reason: 'done', durationMs: 9, deltaCount: 2 }),
			].join('\n') + '\n';
			const parsed = parseRecordFile(text);
			assert.strictEqual(parsed.meta?.agentId, 'a1');
			assert.strictEqual(parsed.records.length, 2);
			assert.strictEqual(parsed.records[0].type, 'text');
			assert.strictEqual((parsed.records[0].delta as any).content, 'hi');
			assert.strictEqual(parsed.end?.reason, 'done');
			assert.strictEqual(parsed.end?.deltaCount, 2);
		});

		test('parseRecordFile 容忍空行与坏行', () => {
			const text = '\n{"kind":"meta","agentId":"a"}\nnot-json\n\n{"kind":"delta","t":1,"type":"text","delta":{"type":"text","content":"x"}}\n';
			const parsed = parseRecordFile(text);
			assert.strictEqual(parsed.meta?.agentId, 'a');
			assert.strictEqual(parsed.records.length, 1);
		});

		test('sanitizeDeltaForRecord 截断超长字符串', () => {
			const long = 'x'.repeat(9000);
			const out = sanitizeDeltaForRecord({ type: 'tool_result', content: long }) as any;
			assert.ok(out.content.length < 9000);
			assert.ok(out.content.includes('[truncated'));
		});

		test('sanitizeDeltaForRecord 处理嵌套与数组', () => {
			const out = sanitizeDeltaForRecord({ a: [{ b: 'short' }] }) as any;
			assert.strictEqual(out.a[0].b, 'short');
			assert.strictEqual(sanitizeDeltaForRecord(null), null);
			assert.strictEqual(sanitizeDeltaForRecord('abc'), 'abc');
		});
	});

	// ─── fixture 回放：delegate_task × 3 子代理（真实会话原型）─────────

	suite('fixture: delegate-3subagents.jsonl', () => {
		const parsed = parseRecordFile(loadFixture('delegate-3subagents.jsonl'));

		test('fixture 结构完整（meta + 12 deltas + end）', () => {
			assert.strictEqual(parsed.meta?.agentId, 'gr-gc');
			assert.strictEqual(parsed.records.length, 12);
			assert.strictEqual(parsed.end?.reason, 'done');
			// t 单调不减
			for (let i = 1; i < parsed.records.length; i++) {
				assert.ok(parsed.records[i].t >= parsed.records[i - 1].t, `t[${i}] 应单调`);
			}
		});

		test('回放后：content 无重复、parts 扁平化与 content 一致', () => {
			const m = new StreamReplayModel();
			for (const rec of parsed.records) { m.applyRecord(rec); }

			const expected =
				'我来分析项目中 GC 增量可达性分析的工作窃取流程。先并行探索相关源码和配置。' +
				'三个子代理已完成探索，关键发现如下：';
			assert.strictEqual(m.msg.content, expected);
			// UI 渲染按 parts 顺序拼接的文本必须与 content 完全一致（无重复插入）
			const flat = flattenMessageParts(m.msg.parts);
			assert.strictEqual(flat.content, expected);
		});

		test('回放后：parts 顺序 [text, tool, text]，工具后文本段不含工具前文本', () => {
			const m = new StreamReplayModel();
			for (const rec of parsed.records) { m.applyRecord(rec); }

			const kinds = m.msg.parts.map(p => p.kind);
			assert.deepStrictEqual(kinds, ['text', 'tool', 'text']);
			const preText = (m.msg.parts[0] as any).text as string;
			const postText = (m.msg.parts[2] as any).text as string;
			assert.strictEqual(preText, '我来分析项目中 GC 增量可达性分析的工作窃取流程。先并行探索相关源码和配置。');
			assert.strictEqual(postText, '三个子代理已完成探索，关键发现如下：');
			// 回归（文字重复 bug）：工具后的 text part 不得重复包含工具前的文本
			assert.ok(!postText.includes('我来分析项目中'));
		});

		test('回放后：delegate_task 卡片内嵌 3 个子代理，trace 齐全', () => {
			const m = new StreamReplayModel();
			for (const rec of parsed.records) { m.applyRecord(rec); }

			const tc = (m.msg.toolCalls ?? []).find(t => t.name === 'delegate_task') as any;
			assert.ok(tc, '应有 delegate_task 工具卡');
			assert.strictEqual(tc.status, 'success');
			assert.ok(Array.isArray(tc.subAgents), '子代理应内嵌在工具卡上');
			assert.strictEqual(tc.subAgents.length, 3);

			// 每个子代理：done + output + toolTraces（卡片渲染"执行过程"区的数据源）
			for (const sa of tc.subAgents) {
				assert.strictEqual(sa.status, 'done', `${sa.id} 应 done`);
				assert.ok(sa.output?.length > 0, `${sa.id} 应有 output`);
				assert.ok(Array.isArray(sa.toolTraces) && sa.toolTraces.length > 0,
					`${sa.id} 应有 toolTraces —— 缺失则卡片只显示文本（本次修复的 bug）`);
				assert.ok(sa.toolTraces.every((t: any) => t.status === 'done'),
					`${sa.id} 所有 trace 应收敛为 done`);
			}
			// 关键工具名应在 trace 中出现（真实会话中子代理调用了这些工具）
			const allNames = tc.subAgents.flatMap((sa: any) => sa.toolTraces.map((t: any) => t.name));
			for (const expect of ['search_graph', 'file_read', 'search_files', 'get_architecture']) {
				assert.ok(allNames.includes(expect), `traces 应包含 ${expect}`);
			}
		});

		test('回放后：subagent 的内部 parentToolCallId 已重映射为真实 callId', () => {
			const m = new StreamReplayModel();
			for (const rec of parsed.records) { m.applyRecord(rec); }

			const tc = (m.msg.toolCalls ?? []).find(t => t.name === 'delegate_task')!;
			for (const sa of tc.subAgents!) {
				assert.strictEqual(sa.parentToolCallId, 'call_9f3a_delegate',
					'sa.parentToolCallId 应从内部 delegate_<ts> 重映射为真实 callId');
			}
			// msg.subAgents 与 tc.subAgents 同引用同步
			assert.strictEqual(m.msg.subAgents?.length, 3);
			assert.ok(m.msg.subAgents!.every(sa => sa.parentToolCallId === tc.id));
		});

		test('回放后：done 收尾把残留 running 工具收敛为 success', () => {
			const m = new StreamReplayModel();
			for (const rec of parsed.records) { m.applyRecord(rec); }
			assert.ok((m.msg.toolCalls ?? []).every(tc => tc.status !== 'running'));
		});
	});

	// ─── 内联场景：last-write-wins 语义刻画 ────────────────────────────

	suite('subagent_trace 合并语义', () => {

		test('同 id 快照 last-write-wins：终态快照替换流式快照', () => {
			const m = new StreamReplayModel();
			m.applyDelta({ type: 'tool_start', toolCallId: 'c1', toolName: 'delegate_task' });
			const base = { id: 'sa-1', task: 't', parentToolCallId: 'delegate_internal_1', toolTraces: [] };
			m.applySubAgentTrace({ subagentData: [{ ...base, status: 'running', toolTraces: [{ id: 'x', name: 'search_graph', status: 'running' }] }] });
			let sa = (m.msg.toolCalls![0] as any).subAgents[0];
			assert.strictEqual(sa.status, 'running');
			assert.strictEqual(sa.toolTraces.length, 1);
			// 终态快照（done，traces 已收敛）覆盖
			m.applySubAgentTrace({ subagentData: [{ ...base, status: 'done', output: 'done', toolTraces: [{ id: 'x', name: 'search_graph', status: 'done' }] }] });
			sa = (m.msg.toolCalls![0] as any).subAgents[0];
			assert.strictEqual(sa.status, 'done');
			assert.strictEqual(sa.output, 'done');
		});

		test('刻画：终态快照若丢 toolTraces 会覆盖流式丰富数据（handler 侧必须保证终态带 traces）', () => {
			const m = new StreamReplayModel();
			m.applyDelta({ type: 'tool_start', toolCallId: 'c1', toolName: 'delegate_task' });
			const base = { id: 'sa-1', task: 't', parentToolCallId: 'delegate_internal_1' };
			m.applySubAgentTrace({ subagentData: [{ ...base, status: 'running', toolTraces: [{ id: 'x', name: 'search_graph', status: 'running' }] }] });
			m.applySubAgentTrace({ subagentData: [{ ...base, status: 'done', output: 'text only', toolTraces: [] }] });
			const sa = (m.msg.toolCalls![0] as any).subAgents[0];
			// 这就是 2026-07-24 日志中"卡片只剩文本"的 UI 侧机理——
			// 修复在 handler 侧（resolveFinalToolTraces 流式优先），pane 合并语义不变。
			assert.strictEqual(sa.toolTraces.length, 0);
		});

		test('多 delegate_task：内部 id 分组 → 各自独立 delegate 卡（FIFO 未占用卡，不再全挤最后一张）', () => {
			// 2026-07-27 修复：旧行为把重映射作用于单值 _lastDelegateToolCallId，
			// 导致并行多 delegate 的 subagent 全挤到最后一张卡。现按内部 id 分组分配。
			const m = new StreamReplayModel();
			m.applyDelta({ type: 'tool_start', toolCallId: 'c1', toolName: 'delegate_task' });
			m.applyDelta({ type: 'tool_start', toolCallId: 'c2', toolName: 'delegate_task' });
			// 两个 subagent，各自不同的内部 parentToolCallId（无 task 匹配信息 → 走 FIFO）
			m.applySubAgentTrace({ subagentData: [
				{ id: 'sa-a', task: 'ta', status: 'running', parentToolCallId: 'delegate_internal_a', toolTraces: [] },
				{ id: 'sa-b', task: 'tb', status: 'running', parentToolCallId: 'delegate_internal_b', toolTraces: [] },
			] });
			const c1 = (m.msg.toolCalls ?? []).find(t => t.id === 'c1') as any;
			const c2 = (m.msg.toolCalls ?? []).find(t => t.id === 'c2') as any;
			assert.strictEqual(c1.subAgents?.length, 1, 'c1 应恰好挂 1 个 subagent');
			assert.strictEqual(c2.subAgents?.length, 1, 'c2 应恰好挂 1 个 subagent（不再为空/不再全挤到最后一张）');
			assert.notStrictEqual(c1.subAgents[0].id, c2.subAgents[0].id, '两张卡挂不同的 subagent');
		});

		test('多 delegate_task：按 task 文本精确匹配到对应卡片（乱序到达也正确）', () => {
			const m = new StreamReplayModel();
			// 两张卡，args 各带完整 task 文本
			m.applyDelta({ type: 'tool_start', toolCallId: 'cA', toolName: 'delegate_task' });
			m.applyDelta({ type: 'tool_args', toolCallId: 'cA', content: JSON.stringify({ task: 'Investigate the CORE GC architecture' }) });
			m.applyDelta({ type: 'tool_start', toolCallId: 'cB', toolName: 'delegate_task' });
			m.applyDelta({ type: 'tool_args', toolCallId: 'cB', content: JSON.stringify({ task: 'Investigate the CLUSTER and REFERENCE GRAPH' }) });
			// subagent 到达顺序与卡片顺序相反，但 task 匹配应把它们放对位置
			m.applySubAgentTrace({ subagentData: [
				{ id: 'sa-cluster', task: 'Investigate the CLUSTER and REFERENCE GRAPH mechanism', status: 'running', parentToolCallId: 'delegate_internal_2', toolTraces: [] },
				{ id: 'sa-core', task: 'Investigate the CORE GC architecture in this codebase', status: 'running', parentToolCallId: 'delegate_internal_1', toolTraces: [] },
			] });
			const cA = (m.msg.toolCalls ?? []).find(t => t.id === 'cA') as any;
			const cB = (m.msg.toolCalls ?? []).find(t => t.id === 'cB') as any;
			assert.strictEqual(cA.subAgents?.length, 1);
			assert.strictEqual(cA.subAgents[0].id, 'sa-core', 'CORE 卡应挂 CORE subagent');
			assert.strictEqual(cB.subAgents?.length, 1);
			assert.strictEqual(cB.subAgents[0].id, 'sa-cluster', 'CLUSTER 卡应挂 CLUSTER subagent');
		});

		test('单 delegate_task 批量 tasks：同内部 id 的多个 subagent 挂同一张卡', () => {
			const m = new StreamReplayModel();
			m.applyDelta({ type: 'tool_start', toolCallId: 'cX', toolName: 'delegate_task' });
			m.applySubAgentTrace({ subagentData: [
				{ id: 'sa-1', task: 't1', status: 'running', parentToolCallId: 'delegate_internal_x', toolTraces: [] },
				{ id: 'sa-2', task: 't2', status: 'running', parentToolCallId: 'delegate_internal_x', toolTraces: [] },
			] });
			const cX = (m.msg.toolCalls ?? []).find(t => t.id === 'cX') as any;
			assert.strictEqual(cX.subAgents?.length, 2, '同一 delegate 的批量 subagent 都挂在这一张卡');
		});
	});

	// ─── 内联场景：文本/工具交错 ────────────────────────────────────────

	suite('text/tool 交错分段', () => {

		test('text → tool → text：后段只含增量（_streamTextSegmentBase）', () => {
			const m = new StreamReplayModel();
			m.applyDelta({ type: 'text', content: '前置分析。' });
			m.applyDelta({ type: 'tool_start', toolCallId: 't1', toolName: 'file_read' });
			m.applyDelta({ type: 'tool_end', toolCallId: 't1', success: true });
			m.applyDelta({ type: 'text', content: '后置结论。' });
			const flat = flattenMessageParts(m.msg.parts);
			assert.strictEqual(flat.content, '前置分析。后置结论。');
			assert.deepStrictEqual(m.msg.parts.map(p => p.kind), ['text', 'tool', 'text']);
		});

		test('fullText 快照模式：长 fullText 直接替换', () => {
			const m = new StreamReplayModel();
			m.applyDelta({ type: 'text', content: 'abc' });
			m.applyDelta({ type: 'text', fullText: 'abcdef', content: '' });
			assert.strictEqual(m.msg.content, 'abcdef');
		});

		test('fullText 短于现有 content 时回退 append（防工具标签后缓冲重置清空内容）', () => {
			const m = new StreamReplayModel();
			m.applyDelta({ type: 'text', content: 'abcdef' });
			m.applyDelta({ type: 'text', fullText: 'xy', content: 'zzz' });
			assert.strictEqual(m.msg.content, 'abcdefzzz');
		});

		test('连续工具调用：每个 tool_start 重置段基线，文本不跨工具泄漏', () => {
			const m = new StreamReplayModel();
			m.applyDelta({ type: 'text', content: 'A' });
			m.applyDelta({ type: 'tool_start', toolCallId: 't1', toolName: 'search_files' });
			m.applyDelta({ type: 'tool_end', toolCallId: 't1', success: true });
			m.applyDelta({ type: 'text', content: 'B' });
			m.applyDelta({ type: 'tool_start', toolCallId: 't2', toolName: 'file_read' });
			m.applyDelta({ type: 'tool_end', toolCallId: 't2', success: true });
			m.applyDelta({ type: 'text', content: 'C' });
			const flat = flattenMessageParts(m.msg.parts);
			assert.strictEqual(flat.content, 'ABC');
			assert.deepStrictEqual(m.msg.parts.map(p => p.kind), ['text', 'tool', 'text', 'tool', 'text']);
			assert.strictEqual(flat.toolCalls.length, 2);
		});
	});
});
