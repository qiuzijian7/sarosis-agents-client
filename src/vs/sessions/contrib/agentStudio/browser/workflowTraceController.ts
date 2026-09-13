/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkflowExecutionService } from '../common/workflowExecutionService.js';
import { IAgentChatService } from '../../../common/agentStudioService.js';
import type { IChatPanel } from '../../../browser/agentChat/iChatPanel.js';
import { validateWorkflowTrace } from './workflow/traceContract.js';
import type { ILiveWorkflowAskUser, ILiveWorkflowPickerSelect, ILiveWorkflowNodeInteraction, ILiveWorkflowExecution, ILiveWorkflowEvent, ILiveCollectVariable } from '../../../browser/agentChat/agentChatTypes.js';
import type { IAgentChatMessage } from '../../../browser/agentChat/agentChatTypes.js';

/**
 * Interface for the pane to interact with the controller.
 * The pane implements this to provide callbacks the controller needs.
 */
export interface IWorkflowPaneCallbacks {
	readonly chatPanel: IChatPanel | undefined;
	readonly currentAgentId: string | null;
	readonly currentSessionId: string | null;
	onWorkflowAgentChanged(agentId: string, sessionId: string): void;
	onWorkflowEnded(): void;
	adaptHistoryMessages(messages: any[]): IAgentChatMessage[];
	activateCheckpointSession(agentId: string, sessionId: string): void;
	refreshSessionList(): Promise<void>;
}

/**
 * WorkflowTraceController — manages live workflow execution state and
 * renders workflow trace cards (subagents, events, collect variables,
 * ask-user prompts) in the chat panel.
 *
 * Extracted from NativeChatEditorPane to reduce its size and isolate
 * the complex workflow trace state machine (subagent_start/end, delta,
 * collect_variables, ask_user, execution_end).
 *
 * Lifecycle: created in NativeChatEditorPane._initChatPanel(), disposed
 * when the pane is disposed (via _register).
 */
/**
 * 把「增量格子」（`node_progress` 的 `media`）**合并**进卡片已有的快照列表。
 *
 * 由来（2026-09-11 用户需求「动态表情包节点，输出一个就显示一个」）：画布执行器逐格归档，
 * 每产出一格就随进度带一条 `media`（**增量**：同一格只报一次）→ 卡片据此在节点**尚未结束**
 * 时逐个显示已产出的格子（此前只在 `subagent_end` 拿到整份快照 → 9 格全跑完才出图 ✗）。
 *
 * ⚠ 必须**合并**不能替换 ✗ —— 增量只带一格，整体替换会把已显示的格刷掉。
 * 去重按 `ref`（data URL 每次生成都不同 → 同格重生成会追加新条目，符合「每格都保留」语义）；
 * 节点结束时 `_handleSubagentEnd` 用整份快照覆盖 → 最终与画布状态一致 ✓。
 *
 * 纯函数（可单测）。
 */
export function mergeSnapshotMedia(
	cur: ReadonlyArray<Record<string, unknown>>,
	media: { ref?: unknown; kind?: unknown; port?: unknown },
): Array<Record<string, unknown>> {
	const ref = media?.ref;
	if (typeof ref !== 'string' || !ref) { return cur.slice(); }
	if (cur.some(x => x['ref'] === ref)) { return cur.slice(); }
	return [
		...cur,
		{
			port: typeof media.port === 'string' ? media.port : 'output',
			kind: typeof media.kind === 'string' ? media.kind : 'image',
			ref,
		},
	];
}

/** 单条媒体 ref 的**落盘**上限（字符数；data URL 的 base64 长度 ≈ 字节数 × 4/3）。 */
export const PERSIST_MEDIA_REF_MAX = 500_000;
/**
 * 每个节点**落盘**的累计字符上限。
 *
 * ★ 取 3MB ≈ 改造前的最坏情况（6 条 × 500KB）—— 即「加了缩略图优先后，落盘体积
 *   不会比之前更大」✓（缩略图 ~60KB × 9 ≈ 540KB，远在预算内 ✓）。
 */
export const PERSIST_MEDIA_TOTAL_MAX = 3_000_000;
/**
 * 每个节点**落盘**的条数上限。
 *
 * ★ 6 → 12（2026-09-13 用户需求「重启后也要看全 9 张」）：条数不再是唯一的体积闸门
 *   （累计预算才是），条数上限只用于挡住「超多小图」把历史撑爆 ✗。
 */
export const PERSIST_MEDIA_MAX = 12;

/** 落盘副本可用的媒体形状（`meta.thumb` = 执行器写入的首帧缩略图）。 */
interface IPersistMediaLike {
	port?: string;
	kind?: string;
	ref?: string;
	meta?: Record<string, unknown>;
}

/**
 * 单条媒体的**落盘 ref**：优先缩略图，其次原图；两者都不可用 → `undefined`（丢弃）。
 *
 * ★ 缩略图优先（2026-09-13 用户需求「重启后也要看全 9 张」）：GIF 原图 data URL ≈ 488KB
 *   字符，9 格 ≈ 4.4MB → 被累计预算裁到 6 格 ✗；首帧缩略图（`meta.thumb`，240×240 PNG）
 *   ≈ 60KB，9 格 ≈ 540KB → **全部落盘** ✓✓。代价：历史卡显示**静态首帧**而非动图 ✗
 *   （活卡不受影响，仍是动图 ✓）—— 这是刻意的体积取舍。
 */
export function persistRefFor(entry: IPersistMediaLike): string | undefined {
	const thumb = typeof entry.meta?.['thumb'] === 'string' ? entry.meta['thumb'] : '';
	if (thumb && thumb.length <= PERSIST_MEDIA_REF_MAX) { return thumb; }
	const full = typeof entry.ref === 'string' ? entry.ref : '';
	if (full && full.length <= PERSIST_MEDIA_REF_MAX) { return full; }
	return undefined;
}

/**
 * 节点媒体快照的**落盘裁剪**（纯函数；可单测）。
 *
 * ★ 为什么要裁剪：媒体节点 snapshot 的 ref 常是 data URL（单张数百 KB），13 张表情包
 *   全量入历史会让会话文件膨胀到数 MB。落盘副本受三重约束：
 *   ① 单条 ref ≤ `PERSIST_MEDIA_REF_MAX`（**优先改用 `meta.thumb` 缩略图** ✓）；
 *   ② 累计 ref ≤ `PERSIST_MEDIA_TOTAL_MAX`（至少保留 1 条 —— 预算再紧也要有可看的产物 ✓）；
 *   ③ 条数 ≤ `PERSIST_MEDIA_MAX`。
 *
 * ★ 优先落盘**阶段产物**（2026-09-11 两阶段 / 2026-09-12 三阶段）：AnimatedEmoji 每格
 *   有三条（video 绿幕原片 / matte 抠像结果 / output GIF）——不筛的话上限只够存少数几格，
 *   重启后卡片几乎看不到结果 ✗。优先级：output（③ GIF）→ matte（② 抠像）→ 其余；
 *   **排除 video**（mp4 data URL 数 MB，必然超上限被丢弃，且聊天卡也不渲染它）。
 *
 * ★★ **只能用于落盘**（2026-09-12 修用户报障「9 格生成成功，但聊天卡只显示 6 张 GIF」）：
 *   此前这份裁剪结果**同时**被用于活卡刷新（`_handleExecutionEnd` 的 Step 1 / Step 3
 *   安全网）✗ —— 于是工作流一结束，活卡就被替换成只剩 6 条的裁剪副本（9 格 → 6 格）✗✗。
 *   活卡必须用 `this._subAgents` 的**全量**快照 ✓。
 */
export function trimSnapshotForPersist<T extends IPersistMediaLike>(
	snapshot: ReadonlyArray<T>,
): Array<T> {
	if (snapshot.length === 0) { return []; }
	const finals = snapshot.filter(m => m.port === 'output');
	const mattes = snapshot.filter(m => m.port === 'matte');
	const source = finals.length > 0 ? finals
		: mattes.length > 0 ? mattes
			: snapshot.filter(m => m.port !== 'video');
	const out: Array<T> = [];
	let total = 0;
	for (const m of source) {
		if (out.length >= PERSIST_MEDIA_MAX) { break; }
		const ref = persistRefFor(m);
		if (ref === undefined) { continue; }   // 无可用 ref（含超单条上限）→ 丢弃
		// 累计预算（**至少保留 1 条**：`out.length > 0` 才判预算，否则极端情况下会一条都不剩 ✗）
		if (out.length > 0 && total + ref.length > PERSIST_MEDIA_TOTAL_MAX) { break; }
		out.push(ref === m.ref ? m : ({ ...m, ref } as T));
		total += ref.length;
	}
	return out;
}

export class WorkflowTraceController extends Disposable {

	private _execId: string | null = null;
	private _msgId: string | null = null;
	/** root trace 携带的 owner sessionId：终态快照持久化的兜底归属（pane 侧可能已切换）。 */
	private _ownerSessionId: string | null = null;
	/** root trace 携带的工作流名（终态快照标题兜底，避免渲染成空名）。 */
	private _workflowName = '';
	private _subAgents: any[] = [];
	/**
	 * 孤儿 `subagent_end` 去重表（2026-09-13）：收到找不到节点卡的 end 事件时记一行
	 * 日志（每个 nodeId 只报一次，避免刷屏）。此前是**静默忽略** → 「节点失败了但卡片
	 * 没反应」这类问题完全无迹可循。
	 */
	private readonly _orphanEndWarned = new Set<string>();
	private _events: ILiveWorkflowEvent[] = [];
	private _collectVars: Record<string, ILiveCollectVariable> = {};
	private _askUsers: ILiveWorkflowAskUser[] = [];
	/** ImagePicker 交互选择卡（2026-09-11 用户需求）：执行到 picker 阶段时暂停等用户多选。 */
	private _pickerSelects: ILiveWorkflowPickerSelect[] = [];
	/** 节点交互表单卡（2026-09-11 框架）：任意节点执行前声明表单，用户提交后才执行。 */
	private _nodeInteractions: ILiveWorkflowNodeInteraction[] = [];

	/** 已告警过的 trace 契约违规签名（按签名去重，避免刷屏）。 */
	private readonly _traceViolationWarned = new Set<string>();
	private _ready = false;
	private _deltaRefreshTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly _workflowExecutionService: IWorkflowExecutionService,
		private readonly _chatService: IAgentChatService,
		private readonly _logService: ILogService,
	) {
		super();
	}

	/**
	 * Start listening for workflow execution traces.
	 * Must be called after the controller is created and the pane is ready.
	 */
	start(callbacks: IWorkflowPaneCallbacks): void {
		this._register(this._workflowExecutionService.onDidExecutionTrace(async (trace) => {
			await this._handleTrace(trace as any, callbacks);
		}));
	}

	/**
	 * trace 契约校验（2026-09-11 质量评估 P2）：发送端（多处 `.fire`）与消费端
	 * （下方 switch）之间**无编译期连接** —— 字段名写错 / 必填漏传 / kind 拼错都会
	 * 静默失效（卡片不出现、进度不动，排查成本极高）。这里在唯一 dispatch 单点做
	 * 非破坏性校验：只记日志（按签名去重，不刷屏），**绝不抛出、不阻断执行**。
	 */
	private _assertTraceContract(trace: unknown): void {
		const r = validateWorkflowTrace(trace);
		if (r.ok) { return; }
		const sig = r.signature || 'unknown';
		if (this._traceViolationWarned.has(sig)) { return; }
		this._traceViolationWarned.add(sig);
		const t = (trace ?? {}) as Record<string, unknown>;
		const details = r.violations.map(v => v.detail).join('; ');
		if (r.unknownKind) {
			this._logService.warn(
				`[WorkflowTrace] 契约漂移：${details}（消费端 switch 未覆盖 → 该事件被静默丢弃）`,
			);
		} else {
			this._logService.warn(
				`[WorkflowTrace] 契约违规 kind=${String(t['kind'])} nodeId=${String(t['nodeId'] ?? '-')} → ${details}`,
			);
		}
	}

	private async _handleTrace(trace: any, cb: IWorkflowPaneCallbacks): Promise<void> {
		this._assertTraceContract(trace);

		const isWorkflowRoot = trace.kind === 'subagent_start' && trace.nodeId === '__workflow__';
		const isCurrentExecution = this._execId && trace.executionId === this._execId;
		if (!isWorkflowRoot && !isCurrentExecution && cb.currentSessionId && trace.sessionId && trace.sessionId !== cb.currentSessionId) {
			return;
		}

		switch (trace.kind) {
			case 'subagent_start':
				await this._handleSubagentStart(trace, cb);
				break;
			case 'collect_variables':
				this._handleCollectVariables(trace);
				break;
			case 'collect_variables_end':
				this._handleCollectVariablesEnd(trace);
				break;
			case 'delta':
				this._handleDelta(trace, cb);
				break;
			case 'subagent_end':
				this._handleSubagentEnd(trace);
				break;
			case 'ask_user':
				this._handleAskUser(trace, cb);
				break;
			case 'ask_user_end':
				this._handleAskUserEnd(trace, cb);
				break;
			// ★ 已移除 picker_select / picker_select_end 分支（2026-09-13）：契约表不再登记
			//   这两个 kind（全仓**无发射端** —— ImagePicker 家族经 2026-09-11「单链路改造」
			//   归一为 comfyStage，交互由 `node_interaction` 的 `applyMode:'snapshot'` 承载）。
			//   而契约测试做「controller 分支 ↔ 契约表」交叉校验 → 留着分支会让测试失败 ✗。
			//   注：`_pickerSelects` 字段与 markPickerSelected/rollbackPickerSelect **保留**
			//   （历史消息渲染 + native 侧回调仍在调用）。
			case 'node_interaction':
				this._handleNodeInteraction(trace, cb);
				break;
			case 'node_interaction_end':
				this._handleNodeInteractionEnd(trace, cb);
				break;
			case 'node_progress':
				this._handleNodeProgress(trace, cb);
				break;
			case 'node_values_changed':
				this._handleNodeValuesChanged(trace, cb);
				break;
			case 'execution_end':
				this._handleExecutionEnd(trace, cb);
				break;
		}
	}

	private async _handleSubagentStart(trace: any, cb: IWorkflowPaneCallbacks): Promise<void> {
		if (trace.nodeId === '__workflow__') {
			const { workflowAgentId, sessionId, nodeName } = trace;
			this._logService.debug(`[WorkflowTrace] Workflow started: agent=${workflowAgentId}, session=${sessionId}, name=${nodeName}`);
			cb.onWorkflowAgentChanged(workflowAgentId, sessionId);
			this._execId = trace.executionId;
			this._ownerSessionId = sessionId ?? null;
			// ★ 工作流名记录（2026-09-10）：终态快照此前从 events 反查 `__workflow__`
			//   nodeName，取不到时标题渲染成「▶ **** — 执行失败」。root trace 直接带
			//   名字，这里留存最可靠。
			this._workflowName = nodeName ?? '';
			this._msgId = `wf_live_${trace.executionId}`;
			this._subAgents = [];
			this._events = [];
			this._collectVars = {};
			this._askUsers = [];
			this._pickerSelects = [];
			this._nodeInteractions = [];
			this._ready = false;

			const panel = cb.chatPanel;
			if (panel) {
				panel.setSending(true);
				panel.setStreamPhase('llm_streaming');
				panel.setStreamTextBuffer('');
				panel.setStreamThinkingBuffer('');
			}

			try {
				const history = await this._chatService.getHistory(workflowAgentId, sessionId);
				cb.chatPanel?.setMessages(cb.adaptHistoryMessages(history));
				cb.activateCheckpointSession(workflowAgentId, sessionId);
				await cb.refreshSessionList();
			} catch (err) {
				this._logService.info('[WorkflowTrace] Failed to load workflow session history:', err);
			}

			// Add live workflow assistant message
			cb.chatPanel?.addMessage({
				id: this._msgId!,
				role: 'assistant',
				content: `▶ **${nodeName}** — 执行中...`,
				timestamp: Date.now(),
				isStreaming: true,
				workflowExecutions: {
					[trace.executionId]: {
						executionId: trace.executionId,
						workflowName: nodeName,
						status: 'running' as const,
						subAgents: this._subAgents,
						startTime: Date.now(),
					},
				},
				workflowEvents: this._events,
				...(Object.keys(this._collectVars).length > 0 ? { collectVariables: this._collectVars } : {}),
			} as any);
			this._ready = true;

			// ★ 无条件补渲染（2026-09-10）：此前仅 subAgents 非空才刷新，导致
			//   「root 处理期间到达、被 _ready 守卫丢弃」的 askUsers/collectVars
			//   永远补不回来（竞态窗口内的任何 live 状态都被漏掉）。这里统一补一次。
			this._refreshMessage(cb);
		} else {
			// Non-root subagent
			this._logService.debug(`[WorkflowTrace] subagent_start: node=${trace.nodeId}, name=${trace.nodeName}, type=${trace.nodeType}`);

			if (!this._msgId || !this._execId) {
				// Fallback: auto-initialize if root event was missed
				this._logService.info(`[WorkflowTrace] subagent_start without root — auto-initializing (execId=${trace.executionId})`);
				this._execId = trace.executionId;
				this._msgId = `wf_live_${trace.executionId}`;
				this._subAgents = [];
				this._events = [];
				this._collectVars = {};
				this._askUsers = [];
			this._pickerSelects = [];
			this._nodeInteractions = [];
				this._ready = false;
				const panel = cb.chatPanel;
				if (panel) {
					panel.setSending(true);
					panel.setStreamPhase('llm_streaming');
					panel.setStreamTextBuffer('');
					panel.setStreamThinkingBuffer('');
				}
				if (trace.workflowAgentId) { cb.onWorkflowAgentChanged(trace.workflowAgentId, trace.sessionId); }
				panel?.addMessage({
					id: this._msgId!,
					role: 'assistant',
					content: `▶ **${trace.nodeName || trace.nodeId}** — 执行中...`,
					timestamp: Date.now(),
					isStreaming: true,
					workflowExecutions: {
						[trace.executionId]: {
							executionId: trace.executionId,
							workflowName: trace.nodeName || trace.nodeId,
							status: 'running' as const,
							subAgents: this._subAgents,
							startTime: Date.now(),
						},
					},
					workflowEvents: this._events,
				} as any);
				this._ready = true;
			}

			this._subAgents.push({
				id: trace.nodeId,
				name: trace.nodeName,
				type: trace.nodeType,
				task: trace.task,
				// ★ P0 修复（2026-09-13）：透传 host 推导的图标（缺省时渲染层回退旧表）。
				...(typeof trace.icon === 'string' && trace.icon ? { icon: trace.icon } : {}),
				status: 'running' as const,
				startTime: Date.now(),
			});
			this._events.push({
				id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
				executionId: trace.executionId,
				sessionId: trace.sessionId,
				timestamp: Date.now(),
				kind: 'subagent_start' as const,
				nodeId: trace.nodeId,
				nodeName: trace.nodeName,
				nodeType: trace.nodeType,
			});
			this._refreshMessage(cb);
		}
	}

	private _handleCollectVariables(trace: any): void {
		this._events.push({
			id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			executionId: trace.executionId,
			sessionId: trace.sessionId,
			timestamp: Date.now(),
			kind: 'collect_variables' as const,
			nodeId: '',
		});
		this._collectVars[trace.executionId] = {
			id: trace.executionId,
			executionId: trace.executionId,
			variables: trace.variables,
			values: {},
			status: 'pending' as const,
			createdAt: Date.now(),
		};
	}

	private _handleCollectVariablesEnd(trace: any): void {
		this._events.push({
			id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			executionId: trace.executionId,
			sessionId: trace.sessionId,
			timestamp: Date.now(),
			kind: 'collect_variables_end' as const,
			nodeId: '',
			status: trace.status,
		});
		this._collectVars[trace.executionId] = {
			id: trace.executionId,
			executionId: trace.executionId,
			variables: [],
			values: {},
			status: (trace.status === 'submitted' ? 'submitted' : 'skipped') as 'submitted' | 'skipped',
			createdAt: Date.now(),
		};
	}

	private _handleDelta(trace: any, cb: IWorkflowPaneCallbacks): void {
		const d = trace.delta as any;
		const sa = this._subAgents.find(s => s.id === trace.nodeId);

		if (d) {
			const panel = cb.chatPanel;
			if (d.type === 'text') {
				panel?.setStreamPhase('llm_streaming');
			} else if (d.type === 'thinking') {
				panel?.setStreamPhase('llm_streaming');
			} else if (d.type === 'tool_start' || d.type === 'tool_args' || d.type === 'tool_end' || d.type === 'tool_result') {
				panel?.setStreamPhase('tool_executing');
			}
			if (d.type === 'usage' && d.usage) {
				panel?.setStreamUsage({
					input: d.usage.inputTokens ?? 0,
					output: d.usage.outputTokens ?? 0,
					seen: true,
				});
			}
		}

		if (sa && d) {
			if (d.type === 'text' && d.content) {
				sa.streamedText = (sa.streamedText ?? '') + d.content;
				cb.chatPanel?.setStreamTextBuffer(sa.streamedText);
			} else if (d.type === 'thinking' && d.content) {
				sa.streamedThinking = (sa.streamedThinking ?? '') + d.content;
				cb.chatPanel?.setStreamThinkingBuffer(sa.streamedThinking ?? '');
			} else if (d.type === 'tool_start') {
				sa.toolCalls = sa.toolCalls ?? [];
				sa.toolCalls.push({
					id: d.toolCallId ?? d.id ?? `tc_${Date.now()}`,
					name: d.toolName ?? d.name ?? '',
					status: 'running',
					args: d.arguments ?? d.args ?? '',
				});
			} else if (d.type === 'tool_args') {
				const tc = sa.toolCalls?.find((t: any) => t.id === (d.toolCallId ?? d.id));
				if (tc) { tc.args = (tc.args ?? '') + (d.content ?? d.arguments ?? d.args ?? ''); }
			} else if (d.type === 'tool_end') {
				const tc = sa.toolCalls?.find((t: any) => t.id === (d.toolCallId ?? d.id));
				if (tc) { tc.status = 'done'; tc.result = d.content ?? d.result ?? ''; }
			} else if (d.type === 'tool_result') {
				const tc = sa.toolCalls?.find((t: any) => t.id === (d.toolCallId ?? d.id));
				if (tc) {
					tc.result = d.content ?? d.result ?? '';
					if (tc.status === 'running') { tc.status = 'done'; }
				}
			}
		}
		this._scheduleDeltaRefresh(cb);
	}

	private _handleSubagentEnd(trace: any): void {
		const sa = this._subAgents.find(s => s.id === trace.nodeId);
		if (sa) {
			sa.status = trace.status === 'done' ? 'done' as const : trace.status === 'cancelled' ? 'cancelled' as const : 'error' as const;
			sa.output = trace.output;
			sa.error = trace.error;
			sa.endTime = Date.now();
			// ★ 媒体快照（2026-09-10）：节点卡据此渲染生成结果缩略图
			//   （StatEmojiStage 等媒体节点的 output 只是引用文本）。
			if (Array.isArray(trace.snapshot) && trace.snapshot.length > 0) {
				(sa as { snapshot?: unknown }).snapshot = trace.snapshot;
			}
		} else if (!this._orphanEndWarned.has(String(trace.nodeId))) {
			// ★ 排障线索（2026-09-13）：此前这里是**静默** `if (sa)` —— 「节点失败了但卡片
			//   没有任何反应」这类问题完全无迹可循。现在按 nodeId 去重记一行日志。
			//   最常见原因：该节点不在 FLOW 链上（从未发过 subagent_start），
			//   或在 catch 路径下发了 end 但 start 被 FLOW 过滤掉（过滤规则不对称）。
			this._orphanEndWarned.add(String(trace.nodeId));
			this._logService.warn(
				`[WorkflowTrace] subagent_end 找不到对应节点卡：nodeId=${trace.nodeId} status=${trace.status} ` +
				`（该节点可能不在 FLOW 链上，或 subagent_start 被过滤 → 此 end 事件被忽略）`,
			);
		}
	}

	/**
	 * 节点交互表单（2026-09-11 用户需求：**通用框架**）：任意节点执行前声明表单，
	 * 卡片按 schema 动态渲染（数字/下拉/文本/开关/m×n/列表），用户提交后才执行该节点。
	 */
	private _handleNodeInteraction(trace: any, cb: IWorkflowPaneCallbacks): void {
		const id = `${trace.executionId}:${trace.nodeId}`;
		this._logService.info(
			`[WorkflowTrace] _handleNodeInteraction: id=${id} title=${trace.title ?? ''} ` +
			`fields=${Array.isArray(trace.fields) ? trace.fields.length : 0}`,
		);
		if (!this._nodeInteractions.some(n => n.id === id)) {
			this._nodeInteractions.push({
				id,
				executionId: trace.executionId,
				nodeId: trace.nodeId,
				nodeName: trace.nodeName ?? trace.nodeId,
				stageClass: typeof trace.stageClass === 'string' ? trace.stageClass : undefined,
				title: typeof trace.title === 'string' && trace.title ? trace.title : '节点配置',
				description: typeof trace.description === 'string' ? trace.description : undefined,
				submitLabel: typeof trace.submitLabel === 'string' ? trace.submitLabel : undefined,
				fields: Array.isArray(trace.fields) ? trace.fields : [],
				initialValues: (trace.initialValues && typeof trace.initialValues === 'object') ? trace.initialValues : {},
				status: 'pending',
				createdAt: Date.now(),
			});
		}
		this._refreshMessage(cb);
	}

	private _handleNodeInteractionEnd(trace: any, cb: IWorkflowPaneCallbacks): void {
		const id = `${trace.executionId}:${trace.nodeId}`;
		const ni = this._nodeInteractions.find(n => n.id === id);
		if (ni) {
			ni.status = trace.status === 'submitted' ? 'submitted' : 'skipped';
			if (trace.values && typeof trace.values === 'object') {
				ni.submittedValues = trace.values;
			}
		}
		this._refreshMessage(cb);
	}

	/**
	 * 逐格/逐帧生成进度（2026-09-11 用户需求：「画布中生成进度实时更新到对应阶段的卡片」）。
	 *
	 * 此前 host 已在发 `node_progress`（workflowExecutionService 的 delegate onProgress，
	 * 画布 direct stage run 的进度也经它回流），但本 controller 的 switch **没有该分支**
	 * → trace 被静默丢弃 → 阶段卡只有 spinner、无百分比 ✗。
	 *
	 * 现把进度写到对应 subAgent（按 `nodeId === subAgent.id` 匹配）并刷新卡片。
	 */
	private _handleNodeProgress(trace: any, cb: IWorkflowPaneCallbacks): void {
		const nodeId = typeof trace.nodeId === 'string' ? trace.nodeId : '';
		const progress = Number(trace.progress);
		if (!nodeId || !Number.isFinite(progress)) { return; }
		const sa = this._subAgents.find(s => s.id === nodeId);
		if (!sa) { return; }   // 进度先于 subagent_start 到达（竞态）→ 丢弃，后续帧会补
		sa.progress = Math.max(0, Math.min(100, progress));
		if (typeof trace.message === 'string' && trace.message) { sa.progressMessage = trace.message; }
		// ★ 逐格媒体回流（2026-09-11 用户需求「动态表情包节点，输出一个就显示一个」）：
		//   画布每产出一格就随进度带一条 `media`（增量，同格只报一次）→ 这里**合并**进
		//   `sa.snapshot`，于是节点**尚未结束**卡片就能逐个显示已产出的格子 ✓。
		//   ⚠ 必须**合并**不能替换 ✗ —— 增量只带一格，整体替换会把已显示的格刷掉；
		//   节点结束时 `_handleSubagentEnd` 会用整份快照覆盖，两者最终一致 ✓。
		const media = trace.media as { ref?: unknown; kind?: unknown; port?: unknown } | undefined;
		if (media && typeof media.ref === 'string' && media.ref) {
			const cur = Array.isArray((sa as { snapshot?: unknown }).snapshot)
				? ((sa as { snapshot?: Array<Record<string, unknown>> }).snapshot as Array<Record<string, unknown>>)
				: [];
			(sa as { snapshot?: unknown }).snapshot = mergeSnapshotMedia(cur, media);
		}
		this._refreshMessage(cb);
	}

	/**
	 * 画布节点值变更回流（2026-09-11 用户需求：卡片数据 ↔ 画布节点 UI 始终同步）。
	 *
	 * 用户在**画布**上改控件 → host 转发到此 → 把新值合并进该节点**待配置**交互卡的
	 * 字段初值（卡片输入框随画布变化 ✓）。
	 *
	 * ★★ **单向**：只更新卡片，**绝不回写画布** → 与「卡片→画布」（表单提交时 update_node）
	 *   不构成回环 ✓（回环会表现为两处数值反复互相覆盖、界面抖动 ✗）。
	 */
	private _handleNodeValuesChanged(trace: any, cb: IWorkflowPaneCallbacks): void {
		const nodeId = typeof trace.nodeId === 'string' ? trace.nodeId : '';
		const values = trace.values;
		if (!nodeId || !values || typeof values !== 'object') { return; }
		let touched = false;
		for (const ni of this._nodeInteractions) {
			if ((ni as { nodeId?: string }).nodeId !== nodeId) { continue; }
			const cur = (ni as { initialValues?: Record<string, unknown> }).initialValues ?? {};
			(ni as { initialValues?: Record<string, unknown> }).initialValues = {
				...cur,
				...(values as Record<string, unknown>),
			};
			touched = true;
		}
		if (touched) { this._refreshMessage(cb); }
	}

	/** 乐观标记已提交（卡片点击提交后立即反馈），失败可 rollbackNodeInteraction。 */
	markNodeInteractionSubmitted(id: string, values: Record<string, unknown>): void {
		const ni = this._nodeInteractions.find(n => n.id === id);
		if (ni) {
			ni.status = 'submitted';
			ni.submittedValues = values;
		}
	}

	rollbackNodeInteraction(id: string): void {
		const ni = this._nodeInteractions.find(n => n.id === id);
		if (ni && ni.status === 'submitted') { ni.status = 'pending'; }
	}

	/** Get current node interaction forms (for UI rendering). */
	getNodeInteractions(): ILiveWorkflowNodeInteraction[] {
		return this._nodeInteractions;
	}

	// ★ 已移除 `_handlePickerSelect` / `_handlePickerSelectEnd`（2026-09-13）：
	//   对应 trace kind 全仓无发射端（见 switch 处注释），方法无调用者。
	//   下方 markPickerSelected / rollbackPickerSelect 保留 —— native 侧回调
	//   （nativeChatEditorPane 的 onPickerSelectSubmit）仍在调用它们。

	/**
	 * 乐观标记已选择（卡片点击「确认选择」后立即反馈），随后由调用方 resume 执行。
	 * 失败时可 rollbackPickerSelect 回滚。
	 *
	 * ⚠ 2026-09-13：`_pickerSelects` 现无 trace 写入源（picker_select 已无发射端）
	 * → 该方法实际是**空操作**。保留是为了不改动 native 侧调用点；若后续确认
	 * ImagePicker 交互完全由 node_interaction 承载，可连同 `_pickerSelects` 一并清理。
	 */
	markPickerSelected(id: string, refs: string[]): void {
		const ps = this._pickerSelects.find(p => p.id === id);
		if (ps) {
			(ps as { status: string }).status = 'answered';
			(ps as { selectedRefs: string[] }).selectedRefs = refs;
			(ps as { selection?: string[] }).selection = refs;
		}
	}

	rollbackPickerSelect(id: string): void {
		const ps = this._pickerSelects.find(p => p.id === id);
		if (ps && (ps.status as string) === 'answered') {
			(ps as { status: string }).status = 'pending';
		}
	}

	/** Get current picker selections (for UI rendering). */
	getPickerSelects(): ILiveWorkflowPickerSelect[] {
		return this._pickerSelects;
	}

	private _handleAskUser(trace: any, cb: IWorkflowPaneCallbacks): void {
		const askId = `${trace.executionId}:${trace.nodeId}`;
		// ★ 观测面（2026-09-10）：确认 ask_user 事件到达 native 链 + 当前 pane 归属，
		//   供「提问卡不显示」在 renderer.log 中一次判定（console 不进日志）。
		this._logService.info(
			`[WorkflowTrace] _handleAskUser: id=${askId} msgId=${this._msgId ?? 'null'} execId=${this._execId ?? 'null'} ` +
			`ready=${this._ready} session=${trace.sessionId} currentSession=${cb.currentSessionId ?? 'null'}`,
		);
		if (!this._askUsers.some(a => a.id === askId)) {
			this._askUsers.push({
				id: askId,
				executionId: trace.executionId,
				nodeId: trace.nodeId,
				nodeName: trace.nodeName ?? trace.nodeId,
				question: trace.question ?? '',
				options: trace.options ?? [],
				multiSelect: trace.multiSelect ?? false,
				// ★ D3：允许自由输入（透传自 AskUser 节点的 data.allowCustom / customLabel）
				allowCustom: trace.allowCustom ?? false,
				customLabel: trace.customLabel ?? '',
				fields: trace.fields ?? [],
				// ★ 多问题（2026-09-11）：非空 → 卡片按单页渲染全部问题
				questions: Array.isArray(trace.questions) && trace.questions.length > 0 ? trace.questions : undefined,
				selectedIndices: [],
				status: 'pending',
				createdAt: Date.now(),
				});
		}
		this._events.push({
			id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			executionId: trace.executionId,
			sessionId: trace.sessionId,
			timestamp: Date.now(),
			kind: 'ask_user' as const,
			nodeId: trace.nodeId,
			nodeName: trace.nodeName,
			summary: `❓ ${trace.question?.substring(0, 60) ?? ''}`,
		});
		// ★ AskUser 交互卡必须在**工作流工具卡内部**实时渲染（用户要求 2026-09-10）：
		//   此前只写内部数组不刷新消息 → 卡片上看不到问题，工作流看似「卡死」。
		this._scheduleDeltaRefresh(cb);
	}

	private _handleAskUserEnd(trace: any, cb: IWorkflowPaneCallbacks): void {
		const askId = `${trace.executionId}:${trace.nodeId}`;
		const status = (trace.status as 'answered' | 'cancelled' | 'expired') ?? 'answered';
		if (status !== 'answered') {
			this._askUsers = this._askUsers.map(a =>
				a.id === askId && a.status === 'pending'
					? { ...a, status, answeredAt: Date.now() }
					: a
			);
		}
		this._events.push({
			id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			executionId: trace.executionId,
			sessionId: trace.sessionId,
			timestamp: Date.now(),
			kind: 'ask_user_end' as const,
			nodeId: trace.nodeId,
			status: trace.status,
			summary: `已${status === 'answered' ? '回答' : status === 'cancelled' ? '取消' : '过期'}`,
		});
		// ★ 回答后刷新：卡片内 AskUser 交互态 → 已回答态，工作流随即恢复执行。
		this._scheduleDeltaRefresh(cb);
	}

	private _handleExecutionEnd(trace: any, cb: IWorkflowPaneCallbacks): void {
		const snapExecId = this._execId;
		const snapMsgId = this._msgId;
		const snapEvents = this._events.slice();
		// ★★ 两套子代理快照，**用途严格分开**（2026-09-12 修用户报障「9 格生成成功，但
		//   聊天卡只显示 6 张 GIF」）：
		//     · `snapSubAgentsLive`   = **全量** → 只用于**活卡刷新**（Step 1 / Step 3）；
		//     · `snapSubAgentsPersist`= 裁剪 → 只用于**落盘**（Step 3.5）。
		//   此前只有一份（裁剪版）且两处都用 ✗ —— 工作流一结束，活卡就被换成只剩 6 条的
		//   裁剪副本：9 格产物在卡上只剩 6 格（用户实测：9 格生成成功却只显示 6 张 GIF）✗✗。
		//   裁剪本身是对的（data URL 单张数百 KB，全量落盘会让会话文件膨胀到数 MB），
		//   错的是**把裁剪结果喂给了活卡** ✗。
		const snapSubAgentsLive = this._subAgents.slice();
		const snapSubAgentsPersist = this._subAgents.map(sa => {
			const snap = (sa as { snapshot?: Array<{ kind: string; ref: string; port?: string }> }).snapshot;
			if (!snap || snap.length === 0) { return sa; }
			return { ...sa, snapshot: trimSnapshotForPersist(snap) } as typeof sa;
		});
		const snapWorkflowName = (() => {
			const we = snapEvents.find(e => e.kind === 'subagent_start' && e.nodeId === '__workflow__');
			return we?.nodeName || this._workflowName || snapExecId || '工作流';
		})();
		const finalStatus = trace.status === 'completed' ? 'completed' as const
			: trace.status === 'failed' ? 'failed' as const
				: 'cancelled' as const;
		// ★ P2-2 修复（2026-09-13）：真实耗时与节点统计（由 host 在 execution_end 携带）。
		//   此前终态刷新写的是 `startTime: Date.now(), endTime: Date.now()` —— 起止同一
		//   时刻 → 卡片耗时**恒显示 0.0s** ✗。durationMs 缺失时（旧 host / 编排链）
		//   退化为 0 秒，与旧行为一致（不引入新的空态）。
		const endMs = Date.now();
		const stats: NonNullable<ILiveWorkflowExecution['stats']> = {
			...(typeof trace.durationMs === 'number' && Number.isFinite(trace.durationMs) ? { durationMs: trace.durationMs } : {}),
			...(typeof trace.doneCount === 'number' ? { doneCount: trace.doneCount } : {}),
			...(typeof trace.errorCount === 'number' ? { errorCount: trace.errorCount } : {}),
			...(typeof trace.cancelledCount === 'number' ? { cancelledCount: trace.cancelledCount } : {}),
			...(typeof trace.skippedCount === 'number' ? { skippedCount: trace.skippedCount } : {}),
		};
		const startMs = stats.durationMs !== undefined ? endMs - stats.durationMs : endMs;
		const statsPatch = Object.keys(stats).length > 0 ? { stats } : {};

		// Step 1: Update live card to final status
		//   ★ 用**全量**快照（`snapSubAgentsLive`）：活卡要展示全部产物（9 格就是 9 张）✓
		//     —— 用裁剪版会让卡上少掉几格（2026-09-12 用户报障的根因）✗。
		this._refreshMessage(cb, {
			workflowExecutions: snapExecId ? {
				[snapExecId]: {
					executionId: snapExecId,
					workflowName: snapWorkflowName,
					status: finalStatus,
					subAgents: snapSubAgentsLive,
					startTime: startMs,
					endTime: endMs,
					...statsPatch,
				},
			} : undefined,
		});

		// Step 2: Reset chat input state
		const panel = cb.chatPanel;
		panel?.setSending(false);
		panel?.setStreamPhase('idle');
		panel?.setStreamTextBuffer('');
		panel?.setStreamThinkingBuffer('');
		panel?.setStreamUsage(null);

		// Step 3: Safety-net delayed refresh
		if (snapExecId && snapMsgId && panel) {
			requestAnimationFrame(() => {
				panel.updateMessage(snapMsgId, {
					isStreaming: false,
					workflowExecutions: {
						[snapExecId]: {
							executionId: snapExecId,
							workflowName: snapWorkflowName,
							status: finalStatus,
							// ★ 同样是**活卡**刷新 → 必须全量（见上方 snapSubAgentsLive 注释）✓
							subAgents: snapSubAgentsLive,
							startTime: startMs,
							endTime: endMs,
							...statsPatch,
						},
					},
					workflowEvents: snapEvents,
				} as any);
			});
		}

		// ★ Step 3.5: 终态快照持久化（2026-09-10 修复「重启后工作流卡片丢失」）：
		//   活卡消息（wf_live_*）只存在于面板内存，从不写入 agentChatService 历史
		//   ——重启后历史加载只剩纯文本，全部节点卡/AskUser 卡/时间线蒸发。
		//   此处把最终快照（终态 + 节点链 + 事件 + AskUser 卡）以独立 id
		//   （wf_run_*，与 webview 侧命名对齐）append 进历史；appendMessage
		//   对已存在 id 幂等。恢复渲染链（deriveUiMessageParts）已支持
		//   workflowExecutions/askUsers 字段反序列化。
		const snapAskUsers = this._askUsers.slice();
		// ★ ImagePicker 选择卡同持久化（2026-09-11）：重启后仍能看到「已选择 N 张」。
		const snapPickerSelects = this._pickerSelects.slice();
		// ★ 节点交互表单同持久化（2026-09-11 框架）：重启后仍能看到「已配置」摘要。
		const snapNodeInteractions = this._nodeInteractions.slice();
		const persistSessionId = cb.currentSessionId ?? this._ownerSessionId;
		if (snapExecId && cb.currentAgentId && persistSessionId) {
			const persistMsg = {
				id: `wf_run_${snapExecId}`,
				role: 'assistant' as const,
				content: `▶ **${snapWorkflowName}** — ${finalStatus === 'completed' ? '执行完成' : finalStatus === 'failed' ? '执行失败' : '已取消'}`,
				// ★ 必须带 agentSessionId（2026-09-10 修复「重启后卡片丢失」真因）：
				//   appendMessage 的跨会话泄漏守卫会**静默丢弃**无 agentSessionId 的
				//   非 system 消息（agentChatService:1287）——批次 76 首版没带，快照
				//   从未落盘。历史是 per-session 加载的，归属必须正确。
				agentSessionId: persistSessionId,
				timestamp: new Date().toISOString(),
				workflowExecutions: {
					[snapExecId]: {
						executionId: snapExecId,
						workflowName: snapWorkflowName,
						status: finalStatus,
						// ★ **落盘副本**用裁剪版（`snapSubAgentsPersist`）：data URL 单张数百 KB，
						//   全量入历史会让会话文件膨胀到数 MB ✗（只影响重启后的历史卡，
						//   活卡不受影响 —— 见 snapSubAgentsLive 注释）✓。
						subAgents: snapSubAgentsPersist,
						startTime: startMs,
						endTime: endMs,
						...statsPatch,
					},
				},
				workflowEvents: snapEvents,
				...(snapAskUsers.length > 0 ? { askUsers: snapAskUsers } : {}),
				...(snapPickerSelects.length > 0 ? { pickerSelects: snapPickerSelects } : {}),
				...(snapNodeInteractions.length > 0 ? { nodeInteractions: snapNodeInteractions } : {}),
			} as any;
			try {
				this._logService.info(`[WorkflowTrace] persisting workflow card ${persistMsg.id} → agent=${cb.currentAgentId} session=${persistSessionId} status=${finalStatus} nodes=${snapSubAgentsPersist.length} askUsers=${snapAskUsers.length}`);
				this._chatService.appendMessage(cb.currentAgentId, persistMsg).catch(
					(e: unknown) => this._logService.warn(`[WorkflowTrace] persist workflow card failed: ${e instanceof Error ? e.message : String(e)}`),
				);
			} catch (e) {
				this._logService.warn(`[WorkflowTrace] persist workflow card failed: ${e instanceof Error ? e.message : String(e)}`);
			}
		} else {
			// ★ 可观测（2026-09-10）：缺 agentId/sessionId 时快照无法归属会话 →
			//   跳过并明示，否则「重启后卡片消失」只能靠猜。
			this._logService.warn(`[WorkflowTrace] skip persisting workflow card: execId=${snapExecId ?? 'null'} agent=${cb.currentAgentId ?? 'null'} session=${persistSessionId ?? 'null'}`);
		}

		// Step 4: Clear live state
		this._execId = null;
		this._msgId = null;
		this._ownerSessionId = null;
		this._subAgents = [];
		this._events = [];
		this._collectVars = {};
		this._askUsers = [];
		this._pickerSelects = [];
		this._nodeInteractions = [];
		this._ready = false;

		cb.onWorkflowEnded();
	}

	/** Throttled refresh for delta events (100ms coalescing). */
	private _scheduleDeltaRefresh(cb: IWorkflowPaneCallbacks): void {
		if (this._deltaRefreshTimer) { return; }
		this._deltaRefreshTimer = setTimeout(() => {
			this._deltaRefreshTimer = null;
			this._refreshMessage(cb);
		}, 100);
	}

	/** Update the live workflow message in the chat panel. */
	private _refreshMessage(cb: IWorkflowPaneCallbacks, overrides?: Record<string, unknown>): void {
		if (this._deltaRefreshTimer) {
			clearTimeout(this._deltaRefreshTimer);
			this._deltaRefreshTimer = null;
		}
		// ★ 去掉 _ready 守卫（2026-09-10 日志实锤 ready=false）：trace 是 **async 逐个
		//   await 处理**，ask_user 可能在 root 处理完成（_ready=true 在 root 末尾）之前
		//   到达 → 守卫直接 return → 提问卡永不渲染（此后无新刷新触发它）。
		//   msgId/execId 已由 root 设置，updateMessage 对未渲染的 id 是安全 no-op，
		//   故只需这两个条件。
		if (!this._msgId || !this._execId) { return; }
		const updates: Record<string, unknown> = {
			workflowExecutions: {
				[this._execId]: {
					executionId: this._execId,
					workflowName: '',
					status: 'running' as const,
					subAgents: this._subAgents,
					startTime: Date.now(),
				} as ILiveWorkflowExecution,
			},
			workflowEvents: this._events,
			...(Object.keys(this._collectVars).length > 0 ? { collectVariables: this._collectVars } : {}),
			...(this._askUsers.length > 0 ? { askUsers: this._askUsers } : {}),
			...(this._pickerSelects.length > 0 ? { pickerSelects: this._pickerSelects } : {}),
			...(this._nodeInteractions.length > 0 ? { nodeInteractions: this._nodeInteractions } : {}),
			...overrides,
		};
		cb.chatPanel?.updateMessage(this._msgId, updates);
	}

	/** Cancel the current workflow execution. */
	cancelExecution(): void {
		if (this._execId) {
			this._workflowExecutionService.cancelExecution(this._execId).catch(err => {
				this._logService.error('[WorkflowTrace] cancelExecution failed:', err);
			});
		}
	}

	/** Submit workflow variables. */
	submitVariables(executionId: string, values: Record<string, string>): void {
		this._workflowExecutionService.submitWorkflowVariables(executionId, values).catch(err => {
			this._logService.error('[WorkflowTrace] submitVariables failed:', err);
		});
	}

	/** Resume a paused workflow execution (AskUser response). */
	resumeExecution(executionId: string, selection: string | string[]): Promise<void> {
		return this._workflowExecutionService.resumeExecution(executionId, selection);
	}

	/** Get current ask-user prompts (for UI rendering). */
	getAskUsers(): ILiveWorkflowAskUser[] {
		return this._askUsers;
	}

	/** Mark an AskUser as answered (optimistic UI update). */
	markAskUserAnswered(askUserId: string, selection: string | string[]): void {
		this._askUsers = this._askUsers.map(a =>
			a.id === askUserId
				? { ...a, status: 'answered' as const, selection, answeredAt: Date.now() }
				: a
		);
	}

	/** Rollback an AskUser to pending (on resume failure). */
	rollbackAskUser(askUserId: string): void {
		this._askUsers = this._askUsers.map(a =>
			a.id === askUserId
				? { ...a, status: 'pending' as const, selection: undefined, answeredAt: undefined }
				: a
		);
	}

	override dispose(): void {
		if (this._deltaRefreshTimer) {
			clearTimeout(this._deltaRefreshTimer);
			this._deltaRefreshTimer = null;
		}
		super.dispose();
	}
}
