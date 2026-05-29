import React, { memo, useMemo } from 'react';
import { ToolCallData } from './ToolCallCard';

/**
 * Progress Card Component - Void-inspired progress indication
 * 
 * Features:
 * - Spinner animation when tool is running
 * - Check icon when tool completes
 * - Progress message display
 * - Auto-hide when follow-up content arrives (reduces UI clutter)
 */
interface ProgressCardProps {
	toolCall: ToolCallData;
	message?: string;
	icon?: 'spinner' | 'check' | 'warning' | 'error';
}

export function ProgressCard({ 
	toolCall, 
	message = '执行中...', 
	icon = 'spinner' 
}: ProgressCardProps): React.ReactElement {
	const isRunning = toolCall.status === 'running';
	const isCompleted = toolCall.status === 'completed' && !toolCall.error;
	const isError = toolCall.status === 'error' || !!toolCall.error;
	const isWarning = toolCall.status === 'warning';

	// Determine icon based on status or prop
	const effectiveIcon = useMemo(() => {
		if (icon !== 'spinner') { return icon; }
		if (isError) { return 'error'; }
		if (isWarning) { return 'warning'; }
		if (isCompleted) { return 'check'; }
		return 'spinner';
	}, [icon, isRunning, isCompleted, isError, isWarning]);

	// Auto-hide logic: hide when follow-up content arrives
	// This reduces UI clutter and focuses attention on final results
	const shouldShow = useMemo(() => {
		// Always show if tool is still running
		if (isRunning) { return true; }
		
		// Show if there's no result yet (avoid flash)
		if (!toolCall.result && !toolCall.error) { return true; }
		
		// Hide when result arrives (let result card take over)
		return false;
	}, [isRunning, toolCall.result, toolCall.error]);

	if (!shouldShow) {
		return <></>;
	}

	const statusText = isRunning ? '工具执行中' : isCompleted ? '工具执行完成' : isError ? '工具执行出错' : '工具执行警告';
	const ariaLive = isRunning ? 'polite' : 'off';

	return (
		<div 
			className={`progress-card progress-card-${effectiveIcon}`}
			role="status"
			aria-live={ariaLive}
			aria-label={statusText}
		>
			<div className="progress-icon-container">
				{effectiveIcon === 'spinner' && (
					<svg 
						className="progress-spinner"
						width="16" 
						height="16" 
						viewBox="0 0 24 24" 
						fill="none" 
						stroke="currentColor" 
						strokeWidth="2"
					>
						<path d="M21 12a9 9 0 11-6.219-8.56" />
					</svg>
				)}
				
				{effectiveIcon === 'check' && (
					<svg 
						width="16" 
						height="16" 
						viewBox="0 0 24 24" 
						fill="none" 
						stroke="currentColor" 
						strokeWidth="2"
					>
						<polyline points="20 6 9 17 4 12" />
					</svg>
				)}
				
				{effectiveIcon === 'warning' && (
					<svg 
						width="16" 
						height="16" 
						viewBox="0 0 24 24" 
						fill="none" 
						stroke="currentColor" 
						strokeWidth="2"
					>
						<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
						<line x1="12" y1="9" x2="12" y2="13" />
						<line x1="12" y1="17" x2="12.01" y2="17" />
					</svg>
				)}
				
				{effectiveIcon === 'error' && (
					<svg 
						width="16" 
						height="16" 
						viewBox="0 0 24 24" 
						fill="none" 
						stroke="currentColor" 
						strokeWidth="2"
					>
						<circle cx="12" cy="12" r="10" />
						<line x1="15" y1="9" x2="9" y2="15" />
						<line x1="9" y1="9" x2="15" y2="15" />
					</svg>
				)}
			</div>
			
			<div className="progress-message">
				<span className="progress-message-text">
					{message}
				</span>
				
				{toolCall.duration && !isRunning && (
					<span className="progress-duration">
						{formatDuration(toolCall.duration)}
					</span>
				)}
			</div>
		</div>
	);
}

/**
 * Format duration for display
 */
function formatDuration(ms: number): string {
	if (ms < 1000) { return `${ms}ms`; }
	if (ms < 60000) { return `${(ms / 1000).toFixed(1)}s`; }
	return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

/**
 * Terminal Progress Card - Specialized for terminal commands
 * 
 * Features:
 * - Command being executed
 * - Live output streaming
 * - Exit code display
 */
interface TerminalProgressCardProps {
	toolCall: ToolCallData;
	command: string;
	output?: string;
}

export function TerminalProgressCard({ 
	toolCall, 
	command, 
	output 
}: TerminalProgressCardProps): React.ReactElement {
	const isRunning = toolCall.status === 'running';
	const exitCode = toolCall.exitCode;
	const isNonZeroExit = exitCode !== undefined && exitCode !== 0;

	return (
		<div className="progress-card progress-card-terminal">
			<div className="terminal-progress-header">
				<div className="terminal-progress-icon">
					{isRunning ? (
						<svg 
							className="progress-spinner"
							width="14" 
							height="14" 
							viewBox="0 0 24 24" 
							fill="none" 
							stroke="currentColor" 
							strokeWidth="2"
						>
							<path d="M21 12a9 9 0 11-6.219-8.56" />
						</svg>
					) : (
						<svg 
							width="14" 
							height="14" 
							viewBox="0 0 24 24" 
							fill="none" 
							stroke="currentColor" 
							strokeWidth="2"
						>
							<polyline points="20 6 9 17 4 12" />
						</svg>
					)}
				</div>
				
				<div className="terminal-progress-command">
					<span className="terminal-prompt">$</span>
					<code className="terminal-command-text">{command}</code>
				</div>
				
				{exitCode !== undefined && (
					<div className={`terminal-exit-code ${isNonZeroExit ? 'non-zero' : 'zero'}`}>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							{isNonZeroExit ? (
								<>
									<circle cx="12" cy="12" r="10" />
									<line x1="15" y1="9" x2="9" y2="15" />
									<line x1="9" y1="9" x2="15" y2="15" />
								</>
							) : (
								<polyline points="20 6 9 17 4 12" />
							)}
						</svg>
						<span>Exit {exitCode}</span>
					</div>
				)}
			</div>
			
			{/* Live Output */}
			{output && (
				<div className="terminal-progress-output">
					<pre className="terminal-output-text">{output}</pre>
				</div>
			)}
			
			{/* Running Indicator */}
			{isRunning && !output && (
				<div className="terminal-progress-running">
					<div className="terminal-running-dots">
						<span className="running-dot">●</span>
						<span className="running-dot">●</span>
						<span className="running-dot">●</span>
					</div>
					<span className="terminal-running-text">执行中...</span>
				</div>
			)}
		</div>
	);
}
