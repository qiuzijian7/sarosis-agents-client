/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Auto-Plan Dialog
 *--------------------------------------------------------------------------------------------*/

import React, { useRef, useState, useCallback } from 'react';
import { useDelegationStore } from '../../store/useDelegationStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';

interface AutoPlanDialogProps {
	onClose: () => void;
}

export function AutoPlanDialog({ onClose }: AutoPlanDialogProps): React.ReactElement {
	const mouseDownOnOverlay = useRef(false);
	const { executePlan, isLoading } = useDelegationStore();
	const { activeWorkspaceId } = useWorkspaceStore();
	const [goal, setGoal] = useState('');

	const handleExecute = useCallback(async () => {
		if (!goal.trim() || !activeWorkspaceId) { return; }
		try {
			await executePlan(goal, activeWorkspaceId);
			onClose();
		} catch (err) {
			console.error('Auto-plan failed:', err);
		}
	}, [goal, activeWorkspaceId, executePlan, onClose]);

	return (
		<div
			className="agent-form-overlay"
			onMouseDown={(e) => { mouseDownOnOverlay.current = e.target === e.currentTarget; }}
			onClick={(e) => {
				if (e.target === e.currentTarget && mouseDownOnOverlay.current) {
					onClose();
				}
			}}
		>
			<div className="agent-form" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '500px' }}>
				<h3 style={{ margin: '0 0 8px', fontSize: '14px' }}>Auto-Plan</h3>
				<p style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)', marginBottom: '16px' }}>
					Describe your goal. AI will decompose it into tasks and assign them to agents.
				</p>

				<div className="form-field">
					<label>Goal</label>
					<textarea
						value={goal}
						onChange={(e) => setGoal(e.target.value)}
						rows={4}
						placeholder="e.g. Build a user authentication system with login, signup, and password reset..."
						autoFocus
					/>
				</div>

				<div className="form-actions">
					<button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
					<button
						type="button"
						className="btn-primary"
						onClick={handleExecute}
						disabled={isLoading || !goal.trim() || !activeWorkspaceId}
					>
						{isLoading ? 'Planning...' : 'Execute Plan'}
					</button>
				</div>
			</div>
		</div>
	);
}
