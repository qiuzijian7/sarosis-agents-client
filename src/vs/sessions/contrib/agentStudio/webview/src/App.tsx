/*---------------------------------------------------------------------------------------------
 *  Agent Studio WebView - Root App Component
 *  Renders non-chat panels (workflow-editor, agent-settings, taskboard).
 *  Chat is handled natively by NativeChatEditorPane — the webview no longer
 *  renders a chat panel.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useState, useCallback, Component } from 'react';
import { useWorkspaceStore } from './store/useWorkspaceStore';

// Lazy-load the workflow editor — it pulls in LiteGraph (~large input) which is
// only needed when the user actually opens the workflow editor panel.
const WorkflowEditorPanel = React.lazy(() => import('./features/workflowEditor/WorkflowEditorPanel'));
import { useAgentStore } from './store/useAgentStore';
import { useProviderStore } from './store/useProviderStore';

// Read the panel type injected by the VS Code host
type PanelType = 'chat' | 'taskboard' | 'workflow-editor' | 'agent-settings' | '__pooled__' | undefined;
const initialPanelType: PanelType = (window as any).__AGENT_STUDIO_PANEL_TYPE__ as PanelType;

/* ── Error Boundary for debugging render crashes ─────────────── */
interface ErrorBoundaryProps {
	children: React.ReactNode;
	panelType: string;
}
interface ErrorBoundaryState {
	hasError: boolean;
	error: Error | null;
}
class PanelErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	constructor(props: ErrorBoundaryProps) {
		super(props);
		this.state = { hasError: false, error: null };
	}
	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { hasError: true, error };
	}
	componentDidCatch(error: Error, info: React.ErrorInfo): void {
		console.error(`[${this.props.panelType}] React render error:`, error, info);
	}
	render(): React.ReactNode {
		if (this.state.hasError) {
			return (
				<div style={{ padding: 20, color: '#f48771', fontFamily: 'monospace', fontSize: 12 }}>
					<h3>{this.props.panelType} Render Error</h3>
					<pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
						{this.state.error?.message}
						{'\n\n'}
						{this.state.error?.stack}
					</pre>
				</div>
			);
		}
		return this.props.children;
	}
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * Independent panel components (rendered when panelType is set)
 * ═══════════════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════════════
 * App entry — routes to the correct panel based on panelType.
 * panelType is reactive: when a pooled webview is activated via the
 * 'agentStudio:pool-activate' custom event, the App re-renders with the
 * real panel type.
 * ═══════════════════════════════════════════════════════════════════════════════ */

export function App(): React.ReactElement {
	const [panelType, setPanelType] = useState<PanelType>(initialPanelType);
	const [initialData, setInitialData] = useState<unknown>(
		(window as any).__AGENT_STUDIO_INITIAL_DATA__ ?? null
	);

	useEffect(() => {
		const onPoolActivate = (e: Event) => {
			const detail = (e as CustomEvent).detail as { panelType?: PanelType; initialData?: unknown };
			const newType = detail?.panelType ?? undefined;
			// Update the global so any code that reads it directly still works
			(window as any).__AGENT_STUDIO_PANEL_TYPE__ = newType;
			if (detail?.initialData !== undefined) {
				(window as any).__AGENT_STUDIO_INITIAL_DATA__ = detail.initialData;
				setInitialData(detail.initialData);
			}
			setPanelType(newType === '__pooled__' ? undefined : newType);
		};
		window.addEventListener('agentStudio:pool-activate', onPoolActivate);
		return () => window.removeEventListener('agentStudio:pool-activate', onPoolActivate);
	}, []);

	// While pooled (waiting for activation), render nothing meaningful
	if (panelType === '__pooled__') {
		return (
			<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--vscode-descriptionForeground)' }}>
				<span style={{ fontSize: 13, opacity: 0.7 }}>Agent Studio (warming...)</span>
			</div>
		);
	}

	switch (panelType) {
		// 5.2（2026-10-17）：taskboard / agent-settings 面板已退役（webview 里删了——它们已有
		// 插件页替代：vssaros-kanban 的看板页 + vssaros-agents 的设置页 ✓；webviewController 的
		// panelType='taskboard'/'agent-settings' 没有触发方 ✓——死代码）。workflow-editor 保留（D6）。
		case 'workflow-editor':
			return (
				<div className="panel-standalone" style={{ width: '100vw', height: '100vh' }}>
					<PanelErrorBoundary panelType="WorkflowEditorPanel">
						<React.Suspense fallback={<div style={{ padding: 20, color: 'var(--vscode-descriptionForeground)' }}>Loading workflow editor...</div>}>
							<WorkflowEditorPanel />
						</React.Suspense>
					</PanelErrorBoundary>
				</div>
			);
		default:
			// Chat is now handled natively by NativeChatEditorPane.
			// If we reach here, the webview was activated without a valid panel type.
			return (
				<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--vscode-descriptionForeground)' }}>
					<span style={{ fontSize: 13, opacity: 0.7 }}>Agent Studio</span>
				</div>
			);
	}
}
