/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - ToolHeaderWrapper Component
 *
 *  Replicated from Void's ToolHeaderWrapper (SidebarChat.tsx lines 781-902)
 *  A reusable collapsible wrapper for all tool cards.
 *
 *  Features:
 *  - Collapsible header with icon, title, description
 *  - Error/rejected state indicators
 *  - Info tooltip support
 *  - Dropdown children with smooth animation
 *  - Controlled (isOpen prop) or uncontrolled (internal state) modes
 *
 *  Ref: Void sidebar-tsx/SidebarChat.tsx (ToolHeaderWrapper)
 *--------------------------------------------------------------------------------------------*/

import React, { useState, useMemo, useEffect } from 'react';

// ─── Icon Components (inline SVG for self-contained component) ──────────────

function ChevronRight({ className, size = 14 }: { className?: string; size?: number }) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
			<polyline points="9 18 15 12 9 6" />
		</svg>
	);
}

/** Spinner icon for running state (Void: animated rotate). */
function Spinner({ className, size = 14 }: { className?: string; size?: number }) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
			<path d="M21 12a9 9 0 11-6.219-8.56" />
		</svg>
	);
}

/** Check icon for success state. */
function Check({ className, size = 14 }: { className?: string; size?: number }) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
			<polyline points="20 6 9 17 4 12" />
		</svg>
	);
}

function CircleEllipsis({ className, size = 14 }: { className?: string; size?: number }) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
			<circle cx="12" cy="12" r="10" />
			<line x1="12" y1="16" x2="12" y2="12" />
			<line x1="12" y1="8" x2="12.01" y2="8" />
		</svg>
	);
}

function AlertTriangle({ className, size = 14 }: { className?: string; size?: number }) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
			<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
			<line x1="12" y1="9" x2="12" y2="13" />
			<line x1="12" y1="17" x2="12.01" y2="17" />
		</svg>
	);
}

function Ban({ className, size = 14 }: { className?: string; size?: number }) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
			<circle cx="12" cy="12" r="10" />
			<line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
		</svg>
	);
}

// ─── ToolHeaderParams (matches Void's ToolHeaderParams) ──────────────────────

export interface ToolHeaderParams {
	icon?: React.ReactNode;
	title: React.ReactNode;
	desc1: React.ReactNode;
	desc1OnClick?: () => void;
	desc1Info?: string;
	desc2?: React.ReactNode;
	isError?: boolean;
	info?: string;
	numResults?: number;
	hasNextPage?: boolean;
	children?: React.ReactNode;
	bottomChildren?: React.ReactNode;
	onClick?: () => void;
	desc2OnClick?: () => void;
	isOpen?: boolean;
	isRejected?: boolean;
	/** running state — shows animated spinner on the right */
	isRunning?: boolean;
	/** success state — shows a subtle check icon on the right */
	isSuccess?: boolean;
	className?: string; // applies to the main content
	// Extra HTML attributes (for accessibility etc.)
	role?: string;
	ariaLive?: 'off' | 'polite' | 'assertive';
	ariaLabel?: string;
	ariaDescribedBy?: string;
	ariaLabelledBy?: string;
	ariaModal?: boolean;
	onKeyDown?: (e: React.KeyboardEvent) => void;
}

// ─── ToolHeaderWrapper Component ───────────────────────────────────────────

export function ToolHeaderWrapper({
	icon,
	title,
	desc1,
	desc1OnClick,
	desc1Info,
	desc2,
	numResults,
	hasNextPage,
	children,
	info,
	bottomChildren,
	isError,
	onClick,
	desc2OnClick,
	isOpen,
	isRejected,
	isRunning,
	isSuccess,
	className,
	...rest
}: ToolHeaderParams): React.ReactElement {
	const [isOpen_, setIsOpen] = useState(false);
	const isExpanded = isOpen !== undefined ? isOpen : isOpen_;

	const isDropdown = children !== undefined; // null allows dropdown
	const isClickable = !!(isDropdown || onClick);

	const isDesc1Clickable = !!desc1OnClick;

	const desc1HTML = useMemo(() => {
		const dataAttrs: Record<string, string> = {};
		if (desc1Info) {
			dataAttrs['data-tooltip-content'] = desc1Info;
			dataAttrs['data-tooltip-placement'] = 'top';
		}
		return (
			<span
				className={`tool-header-desc1 ${isDesc1Clickable ? 'tool-header-desc1-clickable' : ''}`}
				onClick={desc1OnClick}
				{...dataAttrs}
			>
				{desc1}
			</span>
		);
	}, [desc1, isDesc1Clickable, desc1OnClick, desc1Info]);

	return (
		<div {...rest} className={`tool-header-wrapper ${className ?? ''}`}>
			{/* header */}
			<div className="tool-header">
				<div className={`tool-header-row ${isRejected ? 'tool-header-row-rejected' : ''}`}>
					{/* left */}
					<div className="tool-header-left">
						{icon && <span className="tool-header-icon">{icon}</span>}
						<div // container for title + desc1
							className={`tool-header-title-container ${isClickable ? 'tool-header-title-clickable' : ''}`}
							onClick={() => {
								if (isDropdown) { setIsOpen(v => !v); }
								if (onClick) { onClick(); }
							}}
						>
							{isDropdown && (
								<ChevronRight
									className={`tool-header-chevron ${isExpanded ? 'tool-header-chevron-expanded' : ''}`}
									size={14}
								/>
							)}
							<span className="tool-header-title">{title}</span>
							{!isDesc1Clickable && desc1HTML}
						</div>
						{isDesc1Clickable && desc1HTML}
					</div>

					{/* right */}
					<div className="tool-header-right">
						{info && (
							<CircleEllipsis
								className="tool-header-info-icon"
								size={14}
							/>
						)}

						{isRunning && (
							<Spinner
								className="tool-header-spinner-icon"
								size={14}
							/>
						)}
						{isError && (
							<AlertTriangle
								className="tool-header-error-icon"
								size={14}
							/>
						)}
						{isRejected && (
							<Ban
								className="tool-header-rejected-icon"
								size={14}
							/>
						)}
						{isSuccess && !isError && !isRejected && !isRunning && (
							<Check
								className="tool-header-success-icon"
								size={14}
							/>
						)}
						{desc2 && (
							<span className="tool-header-desc2" onClick={desc2OnClick}>
								{desc2}
							</span>
						)}
						{numResults !== undefined && (
							<span className="tool-header-num-results">
								{`${numResults}${hasNextPage ? '+' : ''} result${numResults !== 1 ? 's' : ''}`}
							</span>
						)}
					</div>
				</div>
			</div>
			{/* children (dropdown content) */}
			<div className={`tool-header-children ${isExpanded ? 'tool-header-children-expanded' : ''}`}>
				{children}
			</div>
			{bottomChildren}
		</div>
	);
}

// ─── IconLoading: animated dots ('.' → '..' → '...') ─────────────────────────
// Ref: Void IconLoading (SidebarChat.tsx line 123)

export function IconLoading({ className = '' }: { className?: string }): React.ReactElement {
	const [loadingText, setLoadingText] = useState('.');
	useEffect(() => {
		const id = setInterval(() => {
			setLoadingText(prev => (prev === '...' ? '.' : prev + '.'));
		}, 300);
		return () => clearInterval(id);
	}, []);
	return <span className={`tool-header-loading-dots ${className}`}>{loadingText}</span>;
}

// ─── LoadingTitle: wraps a title node with trailing loading dots ─────────────
// Ref: Void loadingTitleWrapper (SidebarChat.tsx line 1398)

export function LoadingTitle({ children }: { children: React.ReactNode }): React.ReactElement {
	return (
		<span className="tool-header-loading-title">
			{children}
			<IconLoading />
		</span>
	);
}

// ─── ToolChildrenWrapper: dropdown content container ─────────────────────────
// Ref: Void ToolChildrenWrapper (SidebarChat.tsx line 1640)

export function ToolChildrenWrapper({
	children,
	className,
	withBackground,
}: {
	children: React.ReactNode;
	className?: string;
	withBackground?: boolean;
}): React.ReactElement {
	return (
		<div className={`tool-children-wrapper ${withBackground ? 'tool-children-bg' : ''} ${className ?? ''}`}>
			<div className="tool-children-wrapper-inner">{children}</div>
		</div>
	);
}

// ─── CodeChildren: selectable code/text content area ─────────────────────────
// Ref: Void CodeChildren (SidebarChat.tsx line 1647)

export function CodeChildren({
	children,
	className,
}: {
	children: React.ReactNode;
	className?: string;
}): React.ReactElement {
	return (
		<div className={`tool-code-children ${className ?? ''}`}>
			<div className="tool-code-children-selectable">{children}</div>
		</div>
	);
}

// ─── ListableToolItem: clickable list row with bullet ────────────────────────
// Ref: Void ListableToolItem (SidebarChat.tsx line 1655)

export function ListableToolItem({
	name,
	onClick,
	isSmall,
	className,
	showDot = true,
}: {
	name: React.ReactNode;
	onClick?: () => void;
	isSmall?: boolean;
	className?: string;
	showDot?: boolean;
}): React.ReactElement {
	return (
		<div
			className={`tool-listable-item ${onClick ? 'tool-listable-item-clickable' : ''} ${className ?? ''}`}
			onClick={onClick}
		>
			{showDot !== false && (
				<div className="tool-listable-item-dot">
					<svg viewBox="0 0 100 40"><rect x="0" y="15" width="100" height="10" /></svg>
				</div>
			)}
			<div className={isSmall ? 'tool-listable-item-small' : ''}>{name}</div>
		</div>
	);
}

// ─── BottomChildren: collapsible error / lint area below the card ────────────
// Ref: Void BottomChildren (SidebarChat.tsx line 1694)

export function BottomChildren({
	children,
	title,
}: {
	children: React.ReactNode;
	title: string;
}): React.ReactElement | null {
	const [isOpen, setIsOpen] = useState(false);
	if (!children) { return null; }
	return (
		<div className="tool-bottom-children">
			<div
				className="tool-bottom-children-header"
				onClick={() => setIsOpen(o => !o)}
			>
				<ChevronRight
					className={`tool-bottom-children-chevron ${isOpen ? 'tool-bottom-children-chevron-open' : ''}`}
					size={12}
				/>
				<span className="tool-bottom-children-title">{title}</span>
			</div>
			<div className={`tool-bottom-children-body ${isOpen ? 'tool-bottom-children-body-open' : ''}`}>
				<div className="tool-bottom-children-content">{children}</div>
			</div>
		</div>
	);
}
