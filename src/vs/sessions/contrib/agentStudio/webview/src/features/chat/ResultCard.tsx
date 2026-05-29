import React, { memo, useCallback, useMemo, useState } from 'react';
import { ToolCallData } from './ToolCallCard';
import { Tooltip } from './Tooltip';

/**
 * Result Card Component - Void-inspired result display
 * 
 * Features:
 * - Formatted result content (JSON, text, Markdown)
 * - Collapsible sections for large results
 * - "Show more" button for truncated content
 * - Copy button for result text
 * - Error state styling
 * - Support for list/table representations
 */
interface ResultCardProps {
	toolCall: ToolCallData;
	maxDisplayLength?: number;
}

const DEFAULT_MAX_LENGTH = 5000;

export function ResultCard({ 
	toolCall, 
	maxDisplayLength = DEFAULT_MAX_LENGTH 
}: ResultCardProps): React.ReactElement {
	const [showFull, setShowFull] = useState(false);
	const [copied, setCopied] = useState(false);

	// Parse and format result
	const formattedResult = useMemo(() => {
		const raw = toolCall.result || '';
		if (!raw) { return null; }
		
		try {
			// Try to parse as JSON
			const parsed = JSON.parse(raw);
			
			// If it's an array, format as list
			if (Array.isArray(parsed)) {
				return {
					type: 'array' as const,
					data: parsed,
					formatted: JSON.stringify(parsed, null, 2)
				};
			}
			
			// If it's an object, check for special formats
			if (typeof parsed === 'object' && parsed !== null) {
				// Check for items/list (ListItems format)
				if (parsed.items && Array.isArray(parsed.items)) {
					return {
						type: 'list' as const,
						data: parsed.items,
						formatted: JSON.stringify(parsed.items, null, 2)
					};
				}
				
				// Check for content/result/output fields
				const contentFields = ['content', 'result', 'output', 'data', 'message'];
				for (const field of contentFields) {
					if (parsed[field] !== undefined) {
						const value = parsed[field];
						if (typeof value === 'string') {
							return {
								type: 'text' as const,
								data: value,
								formatted: value
							};
						} else if (Array.isArray(value)) {
							return {
								type: 'array' as const,
								data: value,
								formatted: JSON.stringify(value, null, 2)
							};
						}
					}
				}
				
				// Fallback: format object
				return {
					type: 'object' as const,
					data: parsed,
					formatted: JSON.stringify(parsed, null, 2)
				};
			}
			
			// Primitive value
			return {
				type: 'text' as const,
				data: String(parsed),
				formatted: String(parsed)
			};
			
		} catch {
			// Not JSON, treat as plain text
			return {
				type: 'text' as const,
				data: raw,
				formatted: raw
			};
		}
	}, [toolCall.result]);

	const isError = toolCall.status === 'error' || !!toolCall.error;
	const isLongResult = formattedResult && formattedResult.formatted.length > maxDisplayLength;
	const displayResult = showFull || !isLongResult
		? formattedResult?.formatted || ''
		: (formattedResult?.formatted || '').substring(0, maxDisplayLength) + '\n...';

	const handleCopy = useCallback(() => {
		const text = formattedResult?.formatted || '';
		navigator.clipboard?.writeText(text).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}).catch(() => {});
	}, [formattedResult]);

	const handleToggleShow = useCallback(() => {
		setShowFull(!showFull);
	}, [showFull]);

	if (!formattedResult) {
		return <></>;
	}

	const cardTitle = isError ? '错误详情' : '执行结果';
	const cardDescribedBy = isError && toolCall.error ? `result-error-content-${toolCall.id}` : undefined;

	return (
		<div 
			className={`result-card ${isError ? 'result-card-error' : ''}`}
			role="region"
			aria-label={cardTitle}
			aria-describedby={cardDescribedBy}
		>
			{/* Header */}
			<div className="result-card-header">
				<div className="result-card-title">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
						{isError ? (
							<>
								<circle cx="12" cy="12" r="10" />
								<line x1="15" y1="9" x2="9" y2="15" />
								<line x1="9" y1="9" x2="15" y2="15" />
							</>
						) : (
							<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
						)}
					</svg>
					<span className="result-card-title-text">
						{isError ? '错误详情' : '执行结果'}
					</span>
				</div>
				
			<div className="result-card-actions">
				<Tooltip content="复制结果">
					<button 
						className="result-card-copy-btn"
						onClick={handleCopy}
						aria-label={copied ? '已复制到剪贴板' : '复制结果到剪贴板'}
						aria-live="polite"
					>
						{copied ? '✓ 已复制' : '📋 复制'}
					</button>
				</Tooltip>
			</div>
		</div>

			{/* Content */}
			<div className="result-card-content">
				{formattedResult.type === 'list' && (
					<ResultList items={formattedResult.data} />
				)}
				
				{(formattedResult.type === 'text' || formattedResult.type === 'object') && (
					<pre className={`result-text ${isError ? 'error-text' : ''}`}>
						{displayResult}
					</pre>
				)}
				
				{formattedResult.type === 'array' && (
					<ResultList items={formattedResult.data} />
				)}
				
				{isLongResult && (
					<button 
						className="result-show-more-btn"
						onClick={handleToggleShow}
						aria-expanded={showFull}
						aria-label={showFull ? '收起结果' : '显示全部结果'}
					>
						{showFull 
							? `▲ 收起 (${formattedResult.formatted.length} 字符)`
							: `▼ 显示全部 (${formattedResult.formatted.length} 字符)`
						}
					</button>
				)}
			</div>

			{/* Error Details */}
			{toolCall.error && (
				<div className="result-error-section">
					<div className="result-error-header">
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
							<circle cx="12" cy="12" r="10" />
							<line x1="15" y1="9" x2="9" y2="15" />
							<line x1="9" y1="9" x2="15" y2="15" />
						</svg>
						<span className="result-error-title">错误信息</span>
					</div>
					<pre className="result-error-content">{toolCall.error}</pre>
				</div>
			)}
		</div>
	);
}

/**
 * Result List Component - Renders array data as a list
 */
interface ResultListProps {
	items: any[];
}

function ResultList({ items }: ResultListProps): React.ReactElement {
	if (!Array.isArray(items) || items.length === 0) {
		return <div className="result-list-empty">（无结果）</div>;
	}

	return (
		<div className="result-list">
			<ul className="result-list-items">
				{items.map((item, idx) => (
					<ResultListItem key={idx} item={item} index={idx} />
				))}
			</ul>
		</div>
	);
}

/**
 * Result List Item Component - Renders a single item
 */
interface ResultListItemProps {
	item: any;
	index: number;
}

function ResultListItem({ item, index }: ResultListItemProps): React.ReactElement {
	const isObject = item !== null && typeof item === 'object';
	const displayContent = isObject 
		? (item.content || item.text || item.name || item.title || JSON.stringify(item))
		: String(item);

	const contentType = isObject ? (item.type || 'default') : 'text';
	const isClickable = isObject && (item.onClick || item.url || item.path);

	const handleClick = useCallback(() => {
		if (item.onClick) {
			item.onClick();
		} else if (item.url) {
			window.open(item.url, '_blank');
		} else if (item.path) {
			// Open file in editor
			console.log('[ResultListItem] Open file:', item.path);
		}
	}, [item]);

	return (
		<Tooltip content={isClickable ? '点击打开' : ''}>
			<li 
				className={`result-list-item ${isClickable ? 'clickable' : ''}`}
				onClick={isClickable ? handleClick : undefined}
			>
				<span className="result-list-item-bullet">
					{contentType === 'file' ? '📄' : contentType === 'directory' ? '📁' : '•'}
				</span>
				<span className="result-list-item-content">
					{typeof displayContent === 'string' ? displayContent : JSON.stringify(displayContent)}
				</span>
				{item.suffix && (
					<span className="result-list-item-suffix">{item.suffix}</span>
				)}
			</li>
		</Tooltip>
	);
}
