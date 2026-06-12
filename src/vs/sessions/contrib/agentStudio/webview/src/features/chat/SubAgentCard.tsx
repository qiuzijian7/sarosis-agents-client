/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Sub-Agent Card Component
 *
 *  Displays sub-agent execution status in the chat, optimized for
 *  parallel execution visualization. Inspired by VS Code's
 *  ChatSubagentContentPart (chatSubagentContentPart.ts).
 *
 *  Key features:
 *  - Parallel batch grouping (multiple sub-agents in one card)
 *  - Collapsible header with agent type icon + task summary
 *  - Running shimmer animation (VS Code pattern)
 *  - Per-agent status indicators (running/done/error)
 *  - Progress text during execution
 *  - Result preview on completion
 *  - Smart auto-expand/collapse behavior
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings */
import React, { memo, useMemo, useState } from 'react';
import type { SubAgentInfo, SubAgentToolCallTrace } from '../../store/useChatStore';
import { MarkdownRenderer } from './MarkdownRenderer';

// ─── Sub-agent type configuration ─────────────────────────────────────────

const SUB_AGENT_TYPE_CONFIG: Record<string, { icon: string; label: string; color: string }> = {
	explore: { icon: '🔍', label: '探索', color: '#60a5fa' },
	general: { icon: '⚙️', label: '通用', color: '#34d399' },
	scout: { icon: '🌐', label: '研究', color: '#c084fc' },
};

// ─── Status icon helpers ──────────────────────────────────────────────────

function StatusIcon({ status }: { status: SubAgentInfo['status'] }): React.ReactElement {
	switch (status) {
		case 'running':
			return (
				<svg className="subagent-spinner" width="14" height="14" viewBox="0 0 24 24"
					fill="none" stroke="currentColor" strokeWidth="2.5">
					<path d="M21 12a9 9 0 11-6.219-8.56" />
				</svg>
			);
		case 'done':
			return (
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.5">
					<polyline points="20 6 9 17 4 12" />
				</svg>
			);
		case 'error':
			return (
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f48771" strokeWidth="2.5">
					<circle cx="12" cy="12" r="10" />
					<line x1="15" y1="9" x2="9" y2="15" />
					<line x1="9" y1="9" x2="15" y2="15" />
				</svg>
			);
		case 'cancelled':
			return (
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6c757d" strokeWidth="2">
					<rect x="6" y="6" width="12" height="12" rx="2" />
				</svg>
			);
		default: // pending
			return (
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6c757d" strokeWidth="2">
					<circle cx="12" cy="12" r="10" />
				</svg>
			);
	}
}

// ─── P4 v3: Thinking Block ────────────────────────────────────────────────
// Collapsible thinking/reasoning panel inside a sub-agent row. Uses
// MarkdownRenderer so model-emitted ```code fences``` and lists render.

interface SubAgentThinkingBlockProps {
	thinking: string;
	isStreaming?: boolean;
	/** Default-open when streaming, default-closed otherwise. */
	defaultOpen?: boolean;
}

function SubAgentThinkingBlockRaw({
	thinking,
	isStreaming,
	defaultOpen,
}: SubAgentThinkingBlockProps): React.ReactElement {
	// Auto-open while streaming; honour caller override; default closed on completion.
	const [open, setOpen] = useState<boolean>(defaultOpen ?? !!isStreaming);
	const preview = thinking.length > 80 ? thinking.substring(0, 80) + '…' : thinking;

	return (
		<div className={`subagent-thinking ${isStreaming ? 'streaming' : ''}`}>
			<div
				className="subagent-thinking-header"
				onClick={() => setOpen(o => !o)}
				role="button"
				aria-expanded={open}
			>
				<span className="subagent-thinking-icon">💭</span>
				<span className={`subagent-thinking-title ${isStreaming ? 'shimmer' : ''}`}>
					{isStreaming ? '思考中…' : '思考过程'}
				</span>
				{!open && (
					<span className="subagent-thinking-preview">{preview}</span>
				)}
				<span className={`subagent-thinking-toggle ${open ? '' : 'collapsed'}`}>
					<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
						<polyline points="6 9 12 15 18 9" />
					</svg>
				</span>
			</div>
			{open && (
				<div className="subagent-thinking-body">
					<MarkdownRenderer content={thinking} className="thinking-stream markdown-body" />
				</div>
			)}
		</div>
	);
}

const SubAgentThinkingBlock = memo(SubAgentThinkingBlockRaw);

// ─── P4 v3: Tool Trace Block ──────────────────────────────────────────────
// Collapsible list of lightweight tool-call rows inside a sub-agent row.
// Each row shows status icon + tool name; click to expand arguments + result.

interface SubAgentToolTraceBlockProps {
	tools: SubAgentToolCallTrace[];
	isStreaming?: boolean;
	/** Agent (subagent) name to display in the header. */
	agentName?: string;
}

function SubAgentToolTraceBlockRaw({
	tools,
	isStreaming,
	agentName,
}: SubAgentToolTraceBlockProps): React.ReactElement {
	const [open, setOpen] = useState<boolean>(false);
	const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

	const summary = useMemo(() => {
		const running = tools.filter(t => t.status === 'running').length;
		const done = tools.filter(t => t.status === 'done').length;
		const error = tools.filter(t => t.status === 'error').length;
		const parts: string[] = [];
		if (running > 0) { parts.push(`${running} 运行`); }
		if (done > 0) { parts.push(`${done} 完成`); }
		if (error > 0) { parts.push(`${error} 失败`); }
		return parts.length > 0 ? parts.join(' · ') : `${tools.length} 个`;
	}, [tools]);

	const toggleTool = (id: string) => {
		setExpandedTools(prev => {
			const next = new Set(prev);
			if (next.has(id)) { next.delete(id); } else { next.add(id); }
			return next;
		});
	};

	return (
		<div className="subagent-tool-trace">
			<div
				className="subagent-tool-trace-header"
				onClick={() => setOpen(o => !o)}
				role="button"
				aria-expanded={open}
			>
				<span className="subagent-tool-trace-icon">🔧</span>
				<span className="subagent-tool-trace-title">
					{agentName ? `${agentName} · 工具调用` : '工具调用'}
				</span>
				<span className="subagent-tool-trace-summary">{summary}</span>
				<span className={`subagent-tool-trace-toggle ${open ? '' : 'collapsed'}`}>
					<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
						<polyline points="6 9 12 15 18 9" />
					</svg>
				</span>
			</div>
			{open && (
				<div className="subagent-tool-trace-body">
					{tools.map(tool => {
						const isToolOpen = expandedTools.has(tool.id);
						const status = tool.status ?? 'done';
						return (
							<div key={tool.id} className={`subagent-tool-row status-${status}`}>
								<div
									className="subagent-tool-row-header"
									onClick={() => toggleTool(tool.id)}
									role="button"
									aria-expanded={isToolOpen}
								>
									<span className="subagent-tool-status-icon">
										{status === 'running' && (
											<svg className="subagent-spinner" width="11" height="11" viewBox="0 0 24 24"
												fill="none" stroke="currentColor" strokeWidth="2.5">
												<path d="M21 12a9 9 0 11-6.219-8.56" />
											</svg>
										)}
										{status === 'done' && (
											<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.5">
												<polyline points="20 6 9 17 4 12" />
											</svg>
										)}
										{status === 'error' && (
											<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#f48771" strokeWidth="2.5">
												<circle cx="12" cy="12" r="10" />
												<line x1="15" y1="9" x2="9" y2="15" />
												<line x1="9" y1="9" x2="15" y2="15" />
											</svg>
										)}
										{(status === 'pending' || !status) && (
											<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#6c757d" strokeWidth="2">
												<circle cx="12" cy="12" r="10" />
											</svg>
										)}
									</span>
									<span className="subagent-tool-name">{tool.name}</span>
									{isToolOpen && <span className="subagent-tool-detail-spacer" />}
									<span className={`subagent-tool-chevron ${isToolOpen ? 'expanded' : ''}`}>
										<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
											<polyline points="9 6 15 12 9 18" />
										</svg>
									</span>
								</div>
								{isToolOpen && (
									<div className="subagent-tool-row-body">
										{tool.arguments && (
											<div className="subagent-tool-args">
												<div className="subagent-tool-detail-label">参数</div>
												<pre>{tool.arguments}</pre>
											</div>
										)}
										{tool.result !== undefined && tool.result !== null && tool.result !== '' && (
											<div className="subagent-tool-result">
												<div className="subagent-tool-detail-label">结果</div>
												<pre>{typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2)}</pre>
											</div>
										)}
										{!tool.arguments && (tool.result === undefined || tool.result === null || tool.result === '') && (
											<div className="subagent-tool-empty">(无参数/结果)</div>
										)}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

const SubAgentToolTraceBlock = memo(SubAgentToolTraceBlockRaw);

// ─── P4 v24: Output / Stream Block ────────────────────────────────────────
// Collapsible card that wraps the LLM streaming content (delta text
// accumulated during agent execution, plus the final output). Mirrors the
// visual style of SubAgentThinkingBlock / SubAgentToolTraceBlock (header
// + chevron + collapsible body) so the streamed content no longer renders
// as an un-collapsible `<pre>` block taking up the full chat width.
//
// Why this exists: previously the agent's streamed text was rendered via
// a flat `subagent-output` block (only when `isDone`) with a small
// `▼ 展开` text-button — visually inconsistent with the
// thinking/tool-trace cards and, when expanded, a wall of text that
// pushed all other sub-agent cards out of the viewport. The new block:
//   - Uses the same "tool card" visual language (border-left accent +
//     icon + title + chevron + collapsible body) as the sibling blocks
//   - Auto-opens while streaming so the user sees the content live
//   - Auto-collapses on completion (header stays visible with a preview)
//   - Body content is rendered through MarkdownRenderer so the model's
//     ```code fences``` and bullet lists render correctly.
//
// The block derives its `isStreaming` state from the agent status; it
// renders the streamed text both during and after execution (the
// LiveWorkflowTraceView already maps `streamedText` to `output` as a
// fallback so the same field is populated in both phases).

interface SubAgentOutputBlockProps {
	content: string;
	isStreaming?: boolean;
	/** When true, force-open regardless of streaming state (for the
	 *  rare case where the parent wants the body permanently visible). */
	defaultOpen?: boolean;
}

function SubAgentOutputBlockRaw({
	content,
	isStreaming,
	defaultOpen,
}: SubAgentOutputBlockProps): React.ReactElement {
	// Auto-open while streaming; honour caller override; default closed on
	// completion so the chat panel doesn't get overwhelmed by the model's
	// full response when many sub-agents run in parallel.
	const [open, setOpen] = useState<boolean>(defaultOpen ?? !!isStreaming);
	const preview = content.length > 80 ? content.substring(0, 80) + '…' : content;

	return (
		<div className={`subagent-output-block ${isStreaming ? 'streaming' : ''}`}>
			<div
				className="subagent-output-block-header"
				onClick={() => setOpen(o => !o)}
				role="button"
				aria-expanded={open}
			>
				<span className="subagent-output-block-icon">💬</span>
				<span className={`subagent-output-block-title ${isStreaming ? 'shimmer' : ''}`}>
					{isStreaming ? '生成中…' : '响应内容'}
				</span>
				{!open && (
					<span className="subagent-output-block-preview">{preview}</span>
				)}
				<span className={`subagent-output-block-toggle ${open ? '' : 'collapsed'}`}>
					<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
						<polyline points="6 9 12 15 18 9" />
					</svg>
				</span>
			</div>
			{open && (
				<div className="subagent-output-block-body">
					<MarkdownRenderer content={content} className="output-stream markdown-body" />
				</div>
			)}
		</div>
	);
}

const SubAgentOutputBlock = memo(SubAgentOutputBlockRaw);

// ─── Single Sub-Agent Row ─────────────────────────────────────────────────

interface SubAgentRowProps {
	agent: SubAgentInfo;
	isStreaming?: boolean;
}

function SubAgentRowRaw({ agent, isStreaming }: SubAgentRowProps): React.ReactElement {
	const config = SUB_AGENT_TYPE_CONFIG[agent.type] || SUB_AGENT_TYPE_CONFIG.general;
	const isRunning = agent.status === 'running';
	const isDone = agent.status === 'done';
	const isError = agent.status === 'error';

	// Truncate task description for display
	const taskDisplay = agent.task.length > 80
		? agent.task.substring(0, 80) + '...'
		: agent.task;

	// v24: prefer `streamedText` (the live, growing delta content) when
	// running so the user sees the LLM's response stream into the card.
	// Fall back to `output` for the post-completion case. The new
	// `SubAgentOutputBlock` renders this in a proper "tool card" visual
	// style (header + chevron + collapsible body) consistent with the
	// sibling thinking/tool-trace cards. We deliberately don't use the
	// old `subagent-output-preview` / `subagent-output-full` flat layout
	// any more — that style was an un-collapsible wall of text that
	// pushed sibling sub-agent cards out of the viewport.
	const streamContent: string = isRunning
		? (agent.streamedText ?? agent.output ?? '')
		: (agent.output ?? agent.streamedText ?? '');

	return (
		<div className={`subagent-row ${agent.status}`}>
			<div className="subagent-row-header">
				<span className="subagent-type-icon">{config.icon}</span>
				<span className="subagent-status-icon">
					<StatusIcon status={agent.status} />
				</span>
				{/* v26: prefer `name` (workflow node label, e.g. "在控制台打印
				    一个hello world" / the agent's own name for agent-type
				    nodes); fall back to a short slice of `task` so the row
				    header never goes blank. The previous render was just
				    `{agent.name}` which produced an empty span when the
				    field was missing. */}
				<span className="subagent-name">
					{agent.name || (agent.task ? agent.task.substring(0, 40) : agent.id)}
				</span>
				<span className={`subagent-task ${isRunning ? 'shimmer' : ''}`}>
					{taskDisplay}
				</span>
				<span className={`subagent-type-badge type-${agent.type}`}>
					{config.label}
				</span>
			</div>

			{/* Progress text during execution (kept for short-status
			    feedback; the SubAgentOutputBlock below carries the full
			    stream content). */}
			{isRunning && agent.progress && (
				<div className="subagent-progress">
					<span className="subagent-progress-dots">
						<span className="typing-dot">●</span>
						<span className="typing-dot">●</span>
						<span className="typing-dot">●</span>
					</span>
					<span className="subagent-progress-text">{agent.progress}</span>
				</div>
			)}

			{/* P4 v3: Thinking block (collapsible, auto-open while streaming) */}
			{agent.thinking && agent.thinking.length > 0 && (
				<SubAgentThinkingBlock
					thinking={agent.thinking}
					isStreaming={isRunning}
				/>
			)}

			{/* P4 v3: Tool trace block (collapsible list of tool calls) */}
			{agent.toolTrace && agent.toolTrace.length > 0 && (
				<SubAgentToolTraceBlock
					tools={agent.toolTrace}
					isStreaming={isRunning}
					agentName={agent.name}
				/>
			)}

			{/* Error message */}
			{isError && agent.error && (
				<div className="subagent-error">{agent.error}</div>
			)}

			{/* v24: Collapsible output / stream card. Renders for BOTH
			    running (uses streamedText fallback) and done (uses output
			    fallback) so the user can review the full LLM response in
			    a consistent "tool card" visual style. Empty when both
			    fields are empty (e.g. node hasn't produced text yet). */}
			{streamContent && streamContent.length > 0 && (
				<SubAgentOutputBlock
					content={streamContent}
					isStreaming={isRunning}
				/>
			)}
		</div>
	);
}

const SubAgentRow = memo(SubAgentRowRaw);

// ─── Sub-Agent Group Card (parallel batch) ────────────────────────────────

interface SubAgentCardProps {
	/** Sub-agents to display (may be from one or multiple parallel batches) */
	subAgents: SubAgentInfo[];
	/** Whether the parent stream is still active */
	isStreaming?: boolean;
}

function SubAgentCardRaw({ subAgents, isStreaming = false }: SubAgentCardProps): React.ReactElement | null {
	const [expanded, setExpanded] = useState(true);

	// Group sub-agents by groupId (parallel batches), or put all together
	const groups = useMemo(() => {
		const groupMap = new Map<string, SubAgentInfo[]>();
		for (const agent of subAgents) {
			const key = agent.groupId ?? 'default';
			if (!groupMap.has(key)) {
				groupMap.set(key, []);
			}
			groupMap.get(key)!.push(agent);
		}
		return Array.from(groupMap.entries());
	}, [subAgents]);

	// Compute overall status summary
	const summary = useMemo(() => {
		const safeSubAgents = subAgents.filter((a): a is NonNullable<typeof a> => a != null);
		const running = safeSubAgents.filter(a => a.status === 'running').length;
		const done = safeSubAgents.filter(a => a.status === 'done').length;
		const error = safeSubAgents.filter(a => a.status === 'error').length;
		const total = safeSubAgents.length;

		if (running > 0) {
			return `${running}/${total} 执行中`;
		}
		if (done === total) {
			return `全部完成 (${total})`;
		}
		if (error > 0 && done + error === total) {
			return `${done} 完成, ${error} 失败`;
		}
		return `${done}/${total} 完成`;
	}, [subAgents]);

	const anyRunning = subAgents.some(a => a && a.status === 'running');

	if (subAgents.length === 0) {
		return null;
	}

	// Single agent: compact card
	if (subAgents.length === 1) {
		const agent = subAgents[0];
		if (!agent) { return null; }
		const config = SUB_AGENT_TYPE_CONFIG[agent.type] || SUB_AGENT_TYPE_CONFIG.general;
		return (
			<div className={`subagent-card single ${anyRunning ? 'active' : ''}`}>
				<div className="subagent-card-header" onClick={() => setExpanded(!expanded)}
					role="button" aria-expanded={expanded}>
					<span className="subagent-card-icon">
						{anyRunning ? (
							<svg className="subagent-spinner" width="14" height="14" viewBox="0 0 24 24"
								fill="none" stroke={config.color} strokeWidth="2.5">
								<path d="M21 12a9 9 0 11-6.219-8.56" />
							</svg>
						) : (
							<span>{config.icon}</span>
						)}
					</span>
					<span className={`subagent-card-title ${anyRunning ? 'shimmer' : ''}`}>
						{config.label} Agent
					</span>
					<span className="subagent-card-summary">{summary}</span>
					<span className={`subagent-card-toggle ${expanded ? '' : 'collapsed'}`}>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
							<polyline points="6 9 12 15 18 9" />
						</svg>
					</span>
				</div>
				{expanded && (
					<div className="subagent-card-body">
						<SubAgentRow agent={agent} isStreaming={isStreaming} />
					</div>
				)}
			</div>
		);
	}

	// Multiple agents: grouped parallel card
	return (
		<div className={`subagent-card parallel ${anyRunning ? 'active' : ''}`}>
			<div className="subagent-card-header" onClick={() => setExpanded(!expanded)}
				role="button" aria-expanded={expanded}>
				<span className="subagent-card-icon">
					{anyRunning ? (
						<svg className="subagent-spinner" width="14" height="14" viewBox="0 0 24 24"
							fill="none" stroke="currentColor" strokeWidth="2.5">
							<path d="M21 12a9 9 0 11-6.219-8.56" />
						</svg>
					) : (
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2" />
							<circle cx="9" cy="7" r="4" />
							<path d="M23 21v-2a4 4 0 00-3-3.87" />
							<path d="M16 3.13a4 4 0 010 7.75" />
						</svg>
					)}
				</span>
				<span className={`subagent-card-title ${anyRunning ? 'shimmer' : ''}`}>
					并行执行
				</span>
				<span className="subagent-card-summary">{summary}</span>
				<span className={`subagent-card-toggle ${expanded ? '' : 'collapsed'}`}>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
						<polyline points="6 9 12 15 18 9" />
					</svg>
				</span>
			</div>
			{expanded && (
				<div className="subagent-card-body">
					{groups.map(([groupId, agents]) => (
						<div key={groupId} className="subagent-group">
							{agents.length > 1 && (
								<div className="subagent-group-label">
									批次 {groupId === 'default' ? '' : groupId} ({agents.length} 个任务)
								</div>
							)}
							{agents.map(agent => (
								<SubAgentRow key={agent.id} agent={agent} isStreaming={isStreaming} />
							))}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export const SubAgentCard = memo(SubAgentCardRaw);
