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
import type { SubAgentInfo } from '../../store/useChatStore';

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

// ─── Single Sub-Agent Row ─────────────────────────────────────────────────

interface SubAgentRowProps {
	agent: SubAgentInfo;
	isStreaming?: boolean;
}

function SubAgentRowRaw({ agent, isStreaming }: SubAgentRowProps): React.ReactElement {
	const [showOutput, setShowOutput] = useState(false);
	const config = SUB_AGENT_TYPE_CONFIG[agent.type] || SUB_AGENT_TYPE_CONFIG.general;
	const isRunning = agent.status === 'running';
	const isDone = agent.status === 'done';
	const isError = agent.status === 'error';

	// Truncate task description for display
	const taskDisplay = agent.task.length > 80
		? agent.task.substring(0, 80) + '...'
		: agent.task;

	// Truncate output preview
	const outputPreview = agent.output && agent.output.length > 200
		? agent.output.substring(0, 200) + '...'
		: agent.output;

	return (
		<div className={`subagent-row ${agent.status}`}>
			<div className="subagent-row-header">
				<span className="subagent-type-icon">{config.icon}</span>
				<span className="subagent-status-icon">
					<StatusIcon status={agent.status} />
				</span>
				<span className={`subagent-task ${isRunning ? 'shimmer' : ''}`}>
					{taskDisplay}
				</span>
				<span className={`subagent-type-badge type-${agent.type}`}>
					{config.label}
				</span>
			</div>

			{/* Progress text during execution */}
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

			{/* Error message */}
			{isError && agent.error && (
				<div className="subagent-error">{agent.error}</div>
			)}

			{/* Output preview (collapsed by default) */}
			{isDone && agent.output && (
				<div className="subagent-output">
					{showOutput ? (
						<div className="subagent-output-full">
							<pre>{agent.output}</pre>
							<button className="subagent-output-toggle" onClick={() => setShowOutput(false)}>
								▲ 收起
							</button>
						</div>
					) : (
						<div className="subagent-output-preview" onClick={() => setShowOutput(true)}>
							<span className="subagent-output-text">{outputPreview}</span>
							<button className="subagent-output-toggle">▼ 展开</button>
						</div>
					)}
				</div>
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
		const running = subAgents.filter(a => a.status === 'running').length;
		const done = subAgents.filter(a => a.status === 'done').length;
		const error = subAgents.filter(a => a.status === 'error').length;
		const total = subAgents.length;

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

	const anyRunning = subAgents.some(a => a.status === 'running');

	if (subAgents.length === 0) {
		return null;
	}

	// Single agent: compact card
	if (subAgents.length === 1) {
		const agent = subAgents[0];
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
