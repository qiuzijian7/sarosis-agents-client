import React, { memo, useCallback, useState, useRef, useEffect } from 'react';
import { ToolCallData } from './ToolCallCard';
import { Tooltip } from './Tooltip';

/**
 * Confirmation Card Component - Void-inspired confirmation UI
 * 
 * Features:
 * - Title bar with tool name and icon
 * - Expandable message content
 * - Primary action button (Continue) with dropdown for auto-confirm options
 * - Secondary action button (Cancel)
 * - Security level indicator
 * - Accessibility: ARIA labels, keyboard navigation, focus management
 */
interface ConfirmationCardProps {
	toolCall: ToolCallData;
	title: string;
	message: string;
	onApprove: (decision: string) => void;
	onReject: () => void;
}

export function ConfirmationCard({ 
	toolCall, 
	title, 
	message, 
	onApprove, 
	onReject 
}: ConfirmationCardProps): React.ReactElement {
	const [expanded, setExpanded] = useState(false);
	const [showDropdown, setShowDropdown] = useState(false);
	const cardRef = useRef<HTMLDivElement>(null);
	const firstButtonRef = useRef<HTMLButtonElement>(null);

	const securityLevel = toolCall.securityLevel || 'safe';
	const securityLabel = securityLevel === 'dangerous' 
		? '危险操作' 
		: securityLevel === 'cautious' 
			? '需谨慎' 
			: '需确认';

	const handleApprove = useCallback((decision: string) => {
		onApprove(decision);
		setShowDropdown(false);
	}, [onApprove]);

	const handleReject = useCallback(() => {
		onReject();
	}, [onReject]);

	// Focus management: focus first button when dialog opens
	useEffect(() => {
		if (firstButtonRef.current) {
			firstButtonRef.current.focus();
		}
	}, []);

	// Close dropdown on Escape key
	const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === 'Escape') {
			if (showDropdown) {
				setShowDropdown(false);
				e.stopPropagation();
			}
		}
	}, [showDropdown]);

	return (
		<div 
			ref={cardRef}
			className={`confirmation-card confirmation-card-${securityLevel}`}
			role="alertdialog"
			aria-modal="true"
			aria-labelledby={`confirmation-title-${toolCall.id}`}
			aria-describedby={message ? `confirmation-message-${toolCall.id}` : undefined}
			onKeyDown={handleKeyDown}
		>
			{/* Title Bar */}
			<div className="confirmation-title-bar">
				<div className="confirmation-title-content">
					<svg 
						width="16" 
						height="16" 
						viewBox="0 0 24 24" 
						fill="none" 
						stroke="currentColor" 
						strokeWidth="2"
					>
						<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
					</svg>
					<span id={`confirmation-title-${toolCall.id}`} className="confirmation-title">{title}</span>
					<span className={`confirmation-security-badge security-${securityLevel}`}>
						{securityLabel}
					</span>
				</div>
				
			{message && (
				<Tooltip content={expanded ? '收起详情' : '展开详情'}>
					<button 
						className="confirmation-expand-btn"
						onClick={() => setExpanded(!expanded)}
						aria-expanded={expanded}
						aria-label={expanded ? '收起详情' : '展开详情'}
					>
						<svg 
							width="12" 
							height="12" 
							viewBox="0 0 24 24" 
							fill="none" 
							stroke="currentColor" 
							strokeWidth="2.5"
							style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.2s' }}
						>
							<polyline points="6 9 12 15 18 9" />
						</svg>
					</button>
				</Tooltip>
			)}
			</div>

			{/* Message Content (Expandable) */}
			{expanded && message && (
				<div id={`confirmation-message-${toolCall.id}`} className="confirmation-message">
					<div className="confirmation-message-content">
						{message}
					</div>
				</div>
			)}

			{/* Action Buttons */}
			<div className="confirmation-actions">
				<div className="confirmation-primary-action">
					<Tooltip content="仅允许此次执行">
						<button 
							ref={firstButtonRef}
							className="confirmation-btn confirmation-btn-approve"
							onClick={() => handleApprove('allow_once')}
							aria-label="继续 - 仅允许此次执行"
						>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<polyline points="20 6 9 17 4 12" />
						</svg>
						继续
					</button>
				</Tooltip>
					
					{/* Dropdown for auto-confirm options */}
					<div className="confirmation-dropdown-container">
						<Tooltip content="更多选项">
							<button 
								className="confirmation-dropdown-toggle"
								onClick={() => setShowDropdown(!showDropdown)}
								aria-haspopup="true"
								aria-expanded={showDropdown}
							>
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
								<polyline points="6 9 12 15 18 9" />
							</svg>
						</button>
					</Tooltip>
						
						{showDropdown && (
							<div className="confirmation-dropdown-menu">
								<button 
									className="confirmation-dropdown-item"
									onClick={() => handleApprove('allow_session')}
									aria-label="在此会话中允许 - 当前会话自动确认"
								>
									<span className="dropdown-item-label">在此会话中允许</span>
									<span className="dropdown-item-hint">当前会话自动确认</span>
								</button>
								<button 
									className="confirmation-dropdown-item"
									onClick={() => handleApprove('allow_workspace')}
									aria-label="在工作区中允许 - 当前工作区自动确认"
								>
									<span className="dropdown-item-label">在工作区中允许</span>
									<span className="dropdown-item-hint">当前工作区自动确认</span>
								</button>
								<button 
									className="confirmation-dropdown-item"
									onClick={() => handleApprove('allow_always')}
									aria-label="始终允许 - 全局自动确认此工具"
								>
									<span className="dropdown-item-label">始终允许</span>
									<span className="dropdown-item-hint">全局自动确认此工具</span>
								</button>
							</div>
						)}
					</div>
				</div>
				
				<Tooltip content="拒绝此工具调用">
				<button 
					className="confirmation-btn confirmation-btn-reject"
					onClick={handleReject}
					aria-label="取消 - 拒绝此工具调用"
				>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
					取消
				</button>
			</Tooltip>
		</div>
	</div>
	);
}

/**
 * Terminal Confirmation Card - Specialized for terminal commands
 * 
 * Features:
 * - Command preview in monospace font
 * - Risk assessment for terminal commands
 * - Same approval workflow as ConfirmationCard
 */
interface TerminalConfirmationCardProps {
	toolCall: ToolCallData;
	command: string;
	onApprove: (decision: string) => void;
	onReject: () => void;
}

export function TerminalConfirmationCard({ 
	toolCall, 
	command, 
	onApprove, 
	onReject 
}: TerminalConfirmationCardProps): React.ReactElement {
	const [showFullCommand, setShowFullCommand] = useState(false);
	
	const isLongCommand = command.length > 100;
	const displayCommand = !showFullCommand && isLongCommand 
		? command.substring(0, 100) + '...' 
		: command;

	return (
		<div className="confirmation-card confirmation-card-terminal">
			{/* Title Bar */}
			<div className="confirmation-title-bar">
				<div className="confirmation-title-content">
					<svg 
						width="16" 
						height="16" 
						viewBox="0 0 24 24" 
						fill="none" 
						stroke="currentColor" 
						strokeWidth="2"
					>
						<polyline points="4 17 10 11 4 5" />
						<line x1="12" y1="19" x2="20" y2="19" />
					</svg>
					<span className="confirmation-title">执行终端命令</span>
					<span className="confirmation-security-badge security-cautious">
						终端操作
					</span>
				</div>
			</div>

			{/* Command Preview */}
			<div className="confirmation-terminal-command">
				<div className="terminal-command-header">
					<span className="terminal-prompt">$</span>
					<code className="terminal-command-text">{displayCommand}</code>
				</div>
				{isLongCommand && (
					<button 
						className="terminal-show-more-btn"
						onClick={() => setShowFullCommand(!showFullCommand)}
					>
						{showFullCommand ? '收起' : '显示全部'}
					</button>
				)}
			</div>

			{/* Action Buttons */}
			<div className="confirmation-actions">
				<div className="confirmation-primary-action">
					<button 
						className="confirmation-btn confirmation-btn-approve"
						onClick={() => onApprove('allow_once')}
					>
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<polyline points="20 6 9 17 4 12" />
						</svg>
						执行
					</button>
					
				<Tooltip content="更多选项">
					<button 
						className="confirmation-dropdown-toggle"
						onClick={(e) => {
							e.currentTarget.nextElementSibling?.classList.toggle('show');
						}}
					>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<polyline points="6 9 12 15 18 9" />
						</svg>
					</button>
				</Tooltip>
					
					<div className="confirmation-dropdown-menu">
						<button 
							className="confirmation-dropdown-item"
							onClick={() => onApprove('allow_session')}
						>
							<span className="dropdown-item-label">在此会话中允许</span>
						</button>
						<button 
							className="confirmation-dropdown-item"
							onClick={() => onApprove('allow_workspace')}
						>
							<span className="dropdown-item-label">在工作区中允许</span>
						</button>
						<button 
							className="confirmation-dropdown-item"
							onClick={() => onApprove('allow_always')}
						>
							<span className="dropdown-item-label">始终允许</span>
						</button>
					</div>
				</div>
				
				<button 
					className="confirmation-btn confirmation-btn-reject"
					onClick={onReject}
				>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
					取消
				</button>
			</div>
		</div>
	);
}
