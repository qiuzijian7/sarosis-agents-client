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

import React, { useState, useMemo } from 'react';

// ─── Icon Components (inline SVG for self-contained component) ──────────────

function ChevronRight({ className, size = 14 }: { className?: string; size?: number }) {
	return (
		<svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
			<polyline points="9 18 15 12 9 6" />
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
