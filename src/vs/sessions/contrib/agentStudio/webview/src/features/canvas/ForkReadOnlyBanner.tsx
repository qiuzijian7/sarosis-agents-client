/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Fork Read-Only Banner
 *  Shown at the top of the canvas when in Fork (read-only) mode.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { useWorkspaceSessionStore } from '../../store/useWorkspaceSessionStore';

export function ForkReadOnlyBanner(): React.ReactElement | null {
	const { mode, activeSessionId, sessions, switchToRoot } = useWorkspaceSessionStore();

	if (mode !== 'fork' || !activeSessionId) {
		return null;
	}

	const activeSession = sessions.find(s => s.id === activeSessionId);
	const sessionName = activeSession?.name || activeSessionId;
	const statusText = activeSession?.status === 'running' ? '运行中' :
		activeSession?.status === 'completed' ? '已完成' :
			activeSession?.status === 'error' ? '出错' : '';

	return (
		<div className="fork-readonly-banner">
			<div className="fork-readonly-banner-content">
				<span className="fork-readonly-banner-icon">🔒</span>
				<span className="fork-readonly-banner-text">
					Fork 只读模式 — {sessionName}
					{statusText && <span className="fork-readonly-banner-status"> ({statusText})</span>}
				</span>
			</div>
			<button
				className="fork-readonly-banner-btn"
				onClick={() => switchToRoot()}
			>
				返回 Root 编辑
			</button>
		</div>
	);
}
