/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Orchestration Plan Modal
 *  A modal dialog wrapper for the orchestration plan view.
 *  Provides overlay, centered layout, and close behavior.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { OrchestrationPlanView } from './OrchestrationPlanView';

interface OrchestrationPlanModalProps {
	isOpen: boolean;
	onClose: () => void;
}

export function OrchestrationPlanModal({ isOpen, onClose }: OrchestrationPlanModalProps): React.ReactElement | null {
	if (!isOpen) { return null; }

	return (
		<div className="orch-modal-overlay" onClick={onClose}>
			<div className="orch-modal-content" onClick={(e) => e.stopPropagation()}>
				<OrchestrationPlanView onClose={onClose} />
			</div>
		</div>
	);
}
