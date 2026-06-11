/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - AskUser Card Component (P4 v4)
 *
 *  Interactive card rendered in the workflow owner agent's chat when the
 *  workflow reaches an AskUser node. Lets the user pick one or several
 *  options (depending on `multiSelect`) and submit them back to the host
 *  via `workflow.resume`.
 *
 *  Visual states (driven by `entry.status`):
 *    - pending    : interactive option buttons + submit
 *    - answered   : read-only "✓ 已选择: <labels>" summary
 *    - cancelled  : read-only "已取消" badge
 *    - expired    : read-only "已过期" badge (AskUser failed)
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-unexternalized-strings */
import React, { memo, useCallback, useMemo } from 'react';
import type { LiveWorkflowAskUser, IAskUserOption } from '../../store/useChatStore';

interface AskUserCardProps {
	askUser: LiveWorkflowAskUser;
	/** Click handler: receives option labels (one or many). */
	onSubmit: (selection: string | string[]) => void;
	/** Click handler: user toggles an option index (pure UI state). */
	onSelectionChange: (selectedIndices: number[]) => void;
}

function AskUserCardRaw({ askUser, onSubmit, onSelectionChange }: AskUserCardProps): React.ReactElement {
	const isPending = askUser.status === 'pending';
	const isAnswered = askUser.status === 'answered';
	const isCancelled = askUser.status === 'cancelled' || askUser.status === 'expired';

	// Memoize the labels for the current selection (used in answered view).
	const selectedLabels = useMemo(() => {
		return askUser.selectedIndices
			.map(i => askUser.options[i]?.label)
			.filter((l): l is string => !!l);
	}, [askUser.selectedIndices, askUser.options]);

	const canSubmit = isPending && askUser.selectedIndices.length > 0;

	const handleOptionClick = useCallback((idx: number) => {
		if (!isPending) { return; }
		if (askUser.multiSelect) {
			// Toggle: add or remove from selection.
			const has = askUser.selectedIndices.includes(idx);
			const next = has
				? askUser.selectedIndices.filter(i => i !== idx)
				: [...askUser.selectedIndices, idx].sort((a, b) => a - b);
			onSelectionChange(next);
		} else {
			// Single-select: replace.
			onSelectionChange([idx]);
		}
	}, [askUser.multiSelect, askUser.selectedIndices, isPending, onSelectionChange]);

	const handleSubmit = useCallback(() => {
		if (!canSubmit) { return; }
		if (askUser.multiSelect) {
			onSubmit(selectedLabels);
		} else {
			// Single-select must always have exactly one label.
			onSubmit(selectedLabels[0] ?? '');
		}
	}, [canSubmit, askUser.multiSelect, selectedLabels, onSubmit]);

	// ── Header (icon + node name + status badge) ──
	const headerStatus = isPending
		? { icon: '❓', label: '需要输入', color: 'var(--vscode-charts-blue, #60a5fa)' }
		: isAnswered
			? { icon: '✓', label: '已回答', color: 'var(--vscode-charts-green, #34d399)' }
			: isCancelled
				? { icon: '⊘', label: askUser.status === 'cancelled' ? '已取消' : '已过期', color: 'var(--as-fg-secondary, #6c757d)' }
				: { icon: '?', label: '', color: '' };

	return (
		<div className={`askuser-card ${askUser.status}`}>
			<div className="askuser-card-header">
				<span className="askuser-card-icon" style={{ color: headerStatus.color }}>
					{headerStatus.icon}
				</span>
				<span className="askuser-card-title">
					{askUser.nodeName}
				</span>
				<span className="askuser-card-status" style={{ color: headerStatus.color }}>
					{headerStatus.label}
				</span>
			</div>

			{/* Question */}
			<div className="askuser-card-question">
				{askUser.question}
			</div>

			{/* Options (interactive only while pending) */}
			{isPending && (
				<div className={`askuser-options ${askUser.multiSelect ? 'multi' : 'single'}`}>
					{askUser.options.map((opt, idx) => {
						const isSelected = askUser.selectedIndices.includes(idx);
						return (
							<button
								key={idx}
								className={`askuser-option ${isSelected ? 'selected' : ''}`}
								onClick={() => handleOptionClick(idx)}
								type="button"
							>
								<span className="askuser-option-marker">
									{askUser.multiSelect
										? (isSelected ? '☑' : '☐')
										: (isSelected ? '●' : '○')}
								</span>
								<span className="askuser-option-body">
									<span className="askuser-option-label">{opt.label}</span>
									{opt.description && (
										<span className="askuser-option-description">{opt.description}</span>
									)}
								</span>
							</button>
						);
					})}
				</div>
			)}

			{/* Answered summary (read-only) */}
			{isAnswered && (
				<div className="askuser-answer">
					<div className="askuser-answer-label">已选择:</div>
					<div className="askuser-answer-values">
						{(Array.isArray(askUser.selection) ? askUser.selection : [askUser.selection])
							.filter((s): s is string => typeof s === 'string' && s.length > 0)
							.map((s, i) => (
								<span key={i} className="askuser-answer-chip">{s}</span>
							))}
					</div>
				</div>
			)}

			{/* Submit button (only when pending with selection) */}
			{isPending && (
				<div className="askuser-actions">
					<button
						className="askuser-submit"
						disabled={!canSubmit}
						onClick={handleSubmit}
						type="button"
					>
						{askUser.multiSelect ? `提交选择 (${askUser.selectedIndices.length})` : '提交'}
					</button>
				</div>
			)}
		</div>
	);
}

export const AskUserCard = memo(AskUserCardRaw);
