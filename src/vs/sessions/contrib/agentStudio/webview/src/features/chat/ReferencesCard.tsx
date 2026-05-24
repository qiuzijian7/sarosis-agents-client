/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - References Card Component
 *
 *  Displays references used by AI (files, code snippets, etc.)
 *  Mirrors VS Code's chatReferencesContentPart.ts pattern
 *--------------------------------------------------------------------------------------------*/

import React, { memo } from 'react';

export interface ReferenceItem {
	id: string;
	kind: 'file' | 'code' | 'url' | 'symbol' | 'text';
	name: string;
	uri?: string;
	range?: { startLine: number; startCol: number; endLine: number; endCol: number };
	description?: string;
	state?: 'not-modified' | 'modified' | 'pending' | 'excluded';
}

interface ReferencesCardProps {
	references: ReferenceItem[];
	title?: string;
	defaultExpanded?: boolean;
	onReferenceClick?: (ref: ReferenceItem) => void;
}

export const ReferencesCard = memo(function ReferencesCard({
	references,
	title,
	defaultExpanded = false,
	onReferenceClick,
}: ReferencesCardProps): React.ReactElement {
	const [isExpanded, setIsExpanded] = React.useState(defaultExpanded);

	if (!references || references.length === 0) {
		return <></>;
	}

	const displayTitle = title || (references.length > 1 ? `使用了 ${references.length} 个引用` : '使用了 1 个引用');

	const getIcon = (kind: ReferenceItem['kind']): string => {
		switch (kind) {
			case 'file': return '📄';
			case 'code': return '📝';
			case 'url': return '🔗';
			case 'symbol': return '🔧';
			case 'text': return '📋';
			default: return '📎';
		}
	};

	const getStateBadge = (state?: ReferenceItem['state']): React.ReactNode => {
		if (!state || state === 'not-modified') { return null; }
		const badges: Record<string, { label: string; className: string }> = {
			'modified': { label: '已修改', className: 'state-modified' },
			'pending': { label: '待处理', className: 'state-pending' },
			'excluded': { label: '已排除', className: 'state-excluded' },
		};
		const badge = badges[state];
		return <span className={`reference-state-badge ${badge.className}`}>{badge.label}</span>;
	};

	return (
		<div className="references-card">
			<div
				className="references-header"
				onClick={() => setIsExpanded(!isExpanded)}
				role="button"
				aria-expanded={isExpanded}
			>
				<span className="references-icon">📚</span>
				<span className="references-title">{displayTitle}</span>
				<span className={`references-toggle ${isExpanded ? '' : 'collapsed'}`}>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
						<polyline points="6 9 12 15 18 9" />
					</svg>
				</span>
			</div>
			{isExpanded && (
				<div className="references-list">
					{references.map((ref) => (
						<div
							key={ref.id}
							className={`reference-item ${ref.state || ''}`}
							onClick={() => onReferenceClick?.(ref)}
							role="button"
							tabIndex={0}
							onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { onReferenceClick?.(ref); } }}
						>
							<span className="reference-icon">{getIcon(ref.kind)}</span>
							<span className="reference-name">{ref.name}</span>
							{ref.description && (
								<span className="reference-description">{ref.description}</span>
							)}
							{getStateBadge(ref.state)}
						</div>
					))}
				</div>
			)}
		</div>
	);
});
