/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Tool Call Card Component
 *  Expandable card showing tool name, status, formatted arguments and results.
 *  Ref: sarosis-webui EmployeeChat.tsx ToolCallCard pattern
 *--------------------------------------------------------------------------------------------*/

import React, { memo, useMemo, useState } from 'react';

export interface ToolCallData {
	id: string;
	name: string;
	arguments: string;
	result?: string;
	status: string;
}

interface ToolCallCardProps {
	toolCall: ToolCallData;
}

function ToolCallCardRaw({ toolCall }: ToolCallCardProps): React.ReactElement {
	const [expanded, setExpanded] = useState(false);
	const isRunning = toolCall.status === 'running';

	// Cache formatted JSON to avoid re-parsing on every render
	const formattedArgs = useMemo(() => {
		const raw = toolCall.arguments || '';
		if (!raw) return '';
		try {
			return JSON.stringify(JSON.parse(raw), null, 2);
		} catch {
			return raw;
		}
	}, [toolCall.arguments]);

	const formattedResult = useMemo(() => {
		const raw = toolCall.result || '';
		if (!raw) return '';
		try {
			return JSON.stringify(JSON.parse(raw), null, 2);
		} catch {
			return raw;
		}
	}, [toolCall.result]);

	return (
		<div className={`tool-call-card ${isRunning ? 'running' : 'completed'}`}>
			<div className="tool-call-card-header" onClick={() => setExpanded(!expanded)}>
				<span className="tool-call-icon">
					{isRunning ? (
						<svg className="tool-spinner" width="12" height="12" viewBox="0 0 24 24"
							fill="none" stroke="currentColor" strokeWidth="2.5">
							<path d="M21 12a9 9 0 11-6.219-8.56" />
						</svg>
					) : (
						<svg width="12" height="12" viewBox="0 0 24 24"
							fill="none" stroke="currentColor" strokeWidth="2.5">
							<polyline points="20 6 9 17 4 12" />
						</svg>
					)}
				</span>
				<span className="tool-call-card-name">{toolCall.name}</span>
				<span className={`tool-call-card-toggle ${expanded ? '' : 'collapsed'}`}>▼</span>
			</div>
			{expanded && (
				<div className="tool-call-card-body">
					{formattedArgs && formattedArgs !== '{}' && (
						<div className="tool-call-section">
							<div className="tool-call-section-title">参数</div>
							<pre className="tool-call-code">{formattedArgs}</pre>
						</div>
					)}
					{formattedResult && (
						<div className="tool-call-section">
							<div className="tool-call-section-title">结果</div>
							<pre className="tool-call-code">{formattedResult}</pre>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

export const ToolCallCard = memo(ToolCallCardRaw);
