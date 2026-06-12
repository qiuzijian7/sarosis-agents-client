/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Execution Timeline Panel (P4 v5b)
 *
 *  Bottom-anchored collapsible panel that shows a time-ordered log of all
 *  workflow events captured by the trace router (subagent_start / delta /
 *  subagent_end / ask_user / ask_user_end / execution_end).
 *
 *  Visual:
 *   - Each event is a one-line row: [time] [icon] [node name] [summary]
 *   - Color-coded by kind (running=blue, done=green, error=red, ask=purple)
 *   - Latest events at the bottom; auto-scrolls to bottom as new events come
 *   - Cap: 200 events per session (set in store)
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings */
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore, type LiveWorkflowEvent } from '../../store/useChatStore';

interface ExecutionTimelinePanelProps {
	sessionId: string;
	/** When false, the panel renders as collapsed header bar only. */
	defaultOpen?: boolean;
}

const KIND_META: Record<LiveWorkflowEvent['kind'], { icon: string; color: string; label: string }> = {
	subagent_start: { icon: '▶', color: 'var(--vscode-charts-blue, #60a5fa)', label: '开始' },
	delta: { icon: '⋯', color: 'var(--vscode-descriptionForeground, #999)', label: '流式' },
	subagent_end: { icon: '✓', color: 'var(--vscode-charts-green, #34d399)', label: '完成' },
	ask_user: { icon: '❓', color: 'var(--vscode-textPreformat-foreground, #c084fc)', label: '询问' },
	ask_user_end: { icon: '⊘', color: 'var(--vscode-charts-orange, #f59e0b)', label: '回答' },
	collect_variables: { icon: '📝', color: 'var(--vscode-charts-purple, #a78bfa)', label: '变量' },
	collect_variables_end: { icon: '✅', color: 'var(--vscode-charts-green, #34d399)', label: '提交' },
	execution_end: { icon: '⏹', color: 'var(--vscode-descriptionForeground, #999)', label: '结束' },
	breakpoint_hit: { icon: '◉', color: 'var(--vscode-charts-red, #f48771)', label: '断点' },
};

function formatTime(ts: number): string {
	const d = new Date(ts);
	return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0').slice(0, 2)}`;
}

function ExecutionTimelinePanelRaw({ sessionId, defaultOpen = true }: ExecutionTimelinePanelProps): React.ReactElement | null {
	const events = useChatStore(s => s.liveWorkflowEvents[sessionId] ?? []);
	const [open, setOpen] = useState<boolean>(defaultOpen);
	const [filter, setFilter] = useState<string>('');
	const listRef = useRef<HTMLDivElement>(null);

	// Auto-scroll to bottom on new events (only when already near bottom).
	useEffect(() => {
		if (!open || !listRef.current) { return; }
		const el = listRef.current;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
		if (nearBottom) {
			el.scrollTop = el.scrollHeight;
		}
	}, [events, open]);

	const filtered = useMemo(() => {
		if (!filter) { return events; }
		const lower = filter.toLowerCase();
		return events.filter(e =>
			(e.nodeName ?? e.nodeId).toLowerCase().includes(lower)
			|| (e.summary ?? '').toLowerCase().includes(lower)
			|| e.kind.toLowerCase().includes(lower)
		);
	}, [events, filter]);

	if (events.length === 0) {
		// Don't render the panel at all when there are no events (cleaner UX).
		return null;
	}

	return (
		<div className={`execution-timeline-panel ${open ? 'open' : 'collapsed'}`}>
			<div className="execution-timeline-header" onClick={() => setOpen(o => !o)}>
				<span className="execution-timeline-toggle">
					<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
						<polyline points={open ? '6 9 12 15 18 9' : '9 6 15 12 9 18'} />
					</svg>
				</span>
				<span className="execution-timeline-title">⏱ 执行时间线</span>
				<span className="execution-timeline-count">{events.length} 事件</span>
				{open && (
					<input
						className="execution-timeline-filter"
						placeholder="过滤节点/内容…"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						onClick={(e) => e.stopPropagation()}
					/>
				)}
			</div>
			{open && (
				<div className="execution-timeline-list" ref={listRef}>
					{filtered.map(ev => {
						const meta = KIND_META[ev.kind] ?? KIND_META.delta;
						return (
							<div key={ev.id} className="execution-timeline-row" style={{ borderLeftColor: meta.color }}>
								<span className="execution-timeline-time">{formatTime(ev.timestamp)}</span>
								<span className="execution-timeline-icon" style={{ color: meta.color }}>{meta.icon}</span>
								<span className="execution-timeline-kind" style={{ color: meta.color }}>{meta.label}</span>
								<span className="execution-timeline-node">{ev.nodeName ?? ev.nodeId}</span>
								{ev.summary && <span className="execution-timeline-summary">{ev.summary}</span>}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

export const ExecutionTimelinePanel = memo(ExecutionTimelinePanelRaw);
