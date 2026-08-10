/*---------------------------------------------------------------------------------------------
 *  WorkflowEditorPanel — main panel component for the workflow-editor webview.
 *
 *  Layout:
 *   ┌─────────────────────────────────────────┐
 *   │               Toolbar                    │
 *   ├─────────────────────────────────────────┤
 *   │  📝 任务描述：[        editable...       ] │
 *   ├─────────────────────────────────────────┤
 *   │ ┌──────────┐                            │
 *   │ │NodePalette│▶  ◀──────────┐            │
 *   │ │(overlay) │   WorkflowCanvas│          │
 *   │ └──────────┘               │            │
 *   └────────────────────────────┴────────────┘
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { LiteGraphCanvas, type LiteGraphCanvasHandle } from './LiteGraphCanvas';
import { NodeContextMenu, type NodeContextMenuState } from './NodeContextMenu';
import { GroupMenu, GroupEditPopup, applyGroupEdit, type GroupMenuState } from './groupMenu';
import { RunnerManagerPanel } from './RunnerManagerPanel';
import { NodeEditorPopup } from './NodeEditorPopup';
import { ComfyRunnerRegistry, createDefaultLocalRunner, collectRunnerRows } from './comfyHost/comfyRunner';
import { guiToApi } from './comfyHost/comfyApiAdapter';
import { registerDefaultComfyTVStages, getNodeSpec } from './comfyHost/registry';
import { isComfyExecutableSpec, runGraphExecution, runNodeOrStage } from './comfyHost/workflowRun';
import { buildExecutionPlan } from './comfyHost/executionGraph';
import { loadObjectInfoNodes } from './comfyHost/comfyObjectInfoLoader';
import { loadComfyTVStages } from './comfyHost/comfyTvLoader';
import { loadComfyTVCaps } from './comfyHost/capsLoader';
import { useWorkflowEditorStore, undo as doUndo, redo as doRedo } from './store';
import { sendRequest } from '../../bridge/messageClient';
import { useAgentStore } from '../../store/useAgentStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import type { IStoredWorkflow } from '../../types/workflowStorage';

export const WorkflowEditorPanel: React.FC = () => {
	// right-click "Add Node" menu (ComfyUI-style) — replaces the left Nodes panel
	const [ctxMenu, setCtxMenu] = useState<NodeContextMenuState | null>(null);
	// right-click on a group → group ops menu (rename/recolor/pin/remove)
	const [groupMenu, setGroupMenu] = useState<GroupMenuState | null>(null);
	const [groupEditOpen, setGroupEditOpen] = useState(false);
	const [editingDescription, setEditingDescription] = useState(false); // v41: multi-line edit toggle
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
	const [validationMsg, setValidationMsg] = useState<string | null>(null);

	// Canvas engine: LiteGraph (ComfyUI 底层框架) — ReactFlow 已移除，唯一引擎
	const [showRunners, setShowRunners] = useState(false);
	const comfyRegistryRef = useRef<InstanceType<typeof ComfyRunnerRegistry> | null>(null);
	if (!comfyRegistryRef.current) {
		comfyRegistryRef.current = new ComfyRunnerRegistry();
	}
	// 节点编辑器浮层：双击画布节点 → 打开（输入提示词 → 生成出图）
	const [editingNode, setEditingNode] = useState<{ nodeId: string; nodeType: string; upstreams: string[]; data?: Record<string, unknown> } | null>(null);
	const [runnerPreference, setRunnerPreference] = useState('auto');

	// P0: 全图 Comfy 执行状态（与 P3 host 执行状态分离）
	const [comfyRunState, setComfyRunState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
	const [comfyRunMsg, setComfyRunMsg] = useState<string | null>(null);
	// 双击弹窗提交的参数 → 全图执行时复用（nodeId → coerced values）
	const comfyRunValuesRef = useRef<Record<string, Record<string, unknown>>>({});

	// ── 挂载即加载：内置 ComfyTV 预设 + 自动探测本地 runner 能力 ──
	// NodePalette 订阅了 registry，所以这里注册的节点会立即出现在面板里。
	React.useEffect(() => {
		// 1) 默认 ComfyTV stages —— 保证即使无 runner 面板也有 ComfyTV 节点入口。
		registerDefaultComfyTVStages();
		// 2) 自动探测本地 ComfyUI（localhost:8188）并加载 object_info + stages。
		const registry = comfyRegistryRef.current!;
		if (!registry.get('local')) {
			registry.register(createDefaultLocalRunner());
		}
		let cancelled = false;
		(async () => {
			try {
				const rows = await collectRunnerRows(registry.list());
				const healthy = rows.find(r => r.ok);
				if (!healthy || cancelled) { return; }
				await Promise.allSettled([
					loadObjectInfoNodes(healthy.baseUrl),
					loadComfyTVStages(healthy.baseUrl),
					loadComfyTVCaps(healthy.baseUrl),
				]);
			} catch {
				// 无本地 ComfyUI 时静默 —— 默认 stages 已提供入口。
			}
		})();
		return () => { cancelled = true; };
	}, []);

	// LiteGraph 画布命令式句柄（导入/导出）
	const liteGraphRef = useRef<LiteGraphCanvasHandle | null>(null);
	const comfyFileInputRef = useRef<HTMLInputElement | null>(null);
	const [comfyImportMsg, setComfyImportMsg] = useState<string | null>(null);

	const handleComfyImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) { return; }
		try {
			const text = await file.text();
			const raw = JSON.parse(text);
			const issues = liteGraphRef.current?.importComfyWorkflow(raw) ?? ['canvas not ready'];
			setComfyImportMsg(issues.length ? `导入完成（${issues.length} 个警告）` : 'ComfyUI 工作流导入成功');
		} catch (err) {
			setComfyImportMsg(`导入失败：${err instanceof Error ? err.message : String(err)}`);
		} finally {
			if (comfyFileInputRef.current) { comfyFileInputRef.current.value = ''; }
		}
	}, []);

	const handleComfyExport = useCallback(() => {
		const wf = liteGraphRef.current?.exportApi();
		if (!wf) { setComfyImportMsg('画布为空，无可导出内容'); return; }
		const blob = new Blob([JSON.stringify(guiToApi(wf), null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'comfyui-api.json';
		a.click();
		URL.revokeObjectURL(url);
		setComfyImportMsg('已导出 api.json');
	}, []);

	// Execution state (P3: execution control UI)
	const [executionId, setExecutionId] = useState<string | null>(null);
	const [executionStatus, setExecutionStatus] = useState<string | null>(null);
	const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);

	// v12: ensure workspace store is populated so child components can read activeWorkspaceId
	const loadWorkspaces = useWorkspaceStore(s => s.loadWorkspaces);
	useEffect(() => {
		loadWorkspaces();
	}, [loadWorkspaces]);

	const loadWorkflow = useWorkflowEditorStore(s => s.loadWorkflow);
	const workflowId = useWorkflowEditorStore(s => s.workflowId);
	const workflowName = useWorkflowEditorStore(s => s.workflowName);
	const setWorkflowName = useWorkflowEditorStore(s => s.setWorkflowName);
	const workflowDescription = useWorkflowEditorStore(s => s.workflowDescription);
	const setWorkflowDescription = useWorkflowEditorStore(s => s.setWorkflowDescription);
	const toWorkflowData = useWorkflowEditorStore(s => s.toWorkflowData);
	const nodes = useWorkflowEditorStore(s => s.nodes);
	const edges = useWorkflowEditorStore(s => s.edges);
	const setDefaultAgentConfig = useWorkflowEditorStore(s => s.setDefaultAgentConfig);

	// Agents list (to look up the workflow's bound agent)
	const agents = useAgentStore(s => s.agents);

	// v18: When a workflow is loaded, auto-switch the chat panel to its bound agent.
	// Chat is now handled natively by NativeChatEditorPane — this is a no-op.
	const autoSwitchChatToWorkflowAgent = useCallback(async (_workflowAgentId: string) => {
		// No-op: chat panel auto-switching is handled natively.
	}, []);

	// Load initial data from the host-injected __AGENT_STUDIO_INITIAL_DATA__
	// Retry up to 20 times (total 2s) for cold-path webviews where the inline
	// script may not have executed before React's first render cycle.
	const [loadAttempt, setLoadAttempt] = useState(0);
	useEffect(() => {
		if (loaded) { return; }
		if (loadAttempt >= 20) { return; }

		const initialData = (window as unknown as Record<string, unknown>).__AGENT_STUDIO_INITIAL_DATA__ as
			{ type: string; workflow: IStoredWorkflow } | null | undefined;

		if (initialData?.type === 'workflow' && initialData.workflow) {
			loadWorkflow(initialData.workflow);
			setLoaded(true);
			// v18: auto-switch chat panel to workflow's bound agent
			if (initialData.workflow.agentId) {
				autoSwitchChatToWorkflowAgent(initialData.workflow.agentId);
			}
		} else if (!loaded && loadAttempt < 19) {
			// Data not ready yet — schedule retry (100ms intervals, up to 2s)
			const timer = setTimeout(() => setLoadAttempt(a => a + 1), 100);
			return () => clearTimeout(timer);
		}
	}, [loaded, loadAttempt, loadWorkflow, autoSwitchChatToWorkflowAgent]);

	// Sync default agent config from the workflow's bound agent.
	// When a new agent node is created, it inherits this agent's provider/model.
	useEffect(() => {
		const wf = (window as unknown as Record<string, unknown>).__AGENT_STUDIO_INITIAL_DATA__ as
			{ type: string; workflow: IStoredWorkflow } | null | undefined;
		if (!wf?.workflow?.agentId || !agents.length) { return; }

		const workflowAgent = agents.find(a => a.id === wf.workflow.agentId);
		if (workflowAgent) {
			setDefaultAgentConfig({
				agentId: workflowAgent.id,
				providerId: workflowAgent.providerId || '',
				modelId: workflowAgent.modelId || (typeof workflowAgent.model === 'string' ? workflowAgent.model as string : ''),
			});
		}
	}, [agents, loaded, setDefaultAgentConfig]);

	// Listen for AI-driven workflow changes pushed from Host
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent).detail as {
				workflow: IStoredWorkflow;
				description?: string;
			} | undefined;
			if (detail?.workflow) {
				console.log(`[WorkflowEditor] Received workflow.stateApplied → id=${detail.workflow.id}`);
				loadWorkflow(detail.workflow);
				// Re-sync default agent config from the reloaded workflow
				if (detail.workflow.agentId && agents.length) {
					const wfAgent = agents.find(a => a.id === detail.workflow.agentId);
					if (wfAgent) {
						setDefaultAgentConfig({
							agentId: wfAgent.id,
							providerId: wfAgent.providerId || '',
							modelId: wfAgent.modelId || (typeof wfAgent.model === 'string' ? wfAgent.model as string : ''),
						});
					}
					// v18: also auto-switch chat panel when workflow state is applied
					autoSwitchChatToWorkflowAgent(detail.workflow.agentId);
				}
			}
		};
		window.addEventListener('agentStudio:workflow-state-applied', handler);
		return () => window.removeEventListener('agentStudio:workflow-state-applied', handler);
	}, [loadWorkflow, agents, setDefaultAgentConfig, autoSwitchChatToWorkflowAgent]);

	// Keyboard shortcut: Ctrl+S to save
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === 's') {
				e.preventDefault();
				void handleSave();
			}
		};
		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	}, [nodes, edges, workflowId, workflowName]);

	// Listen for workflow execution updates from Host (P3: execution control)
	useEffect(() => {
		const handler = (e: Event) => {
			const detail = (e as CustomEvent).detail as {
				executionId: string;
				status: string;
				currentNodeId?: string;
				nodeStates: Record<string, {
					status: string;
					startTime?: string;
					endTime?: string;
					error?: string;
					output?: unknown;
				}>;
				breakpoints?: string[];
			} | undefined;
			
			if (detail) {
				console.log(`[WorkflowEditor] Received workflow.executionUpdate:`, detail);
				setExecutionId(detail.executionId);
				setExecutionStatus(detail.status);
				setCurrentNodeId(detail.currentNodeId || null);
				
				// Update store with execution state
				const { setExecutionState, setBreakpoints } = useWorkflowEditorStore.getState();
				setExecutionState(
					detail.executionId,
					detail.status as 'running' | 'paused' | 'completed' | 'failed' | 'cancelled',
					detail.currentNodeId || null,
					detail.nodeStates
				);
				
				if (detail.breakpoints) {
					setBreakpoints(detail.breakpoints);
				}
			}
		};
	
		window.addEventListener('agentStudio:workflow-execution-update', handler);
		return () => window.removeEventListener('agentStudio:workflow-execution-update', handler);
	}, []);

	const handleSave = useCallback(async () => {
		if (saving || !workflowId) { return; }
		setSaving(true);
		setSaveStatus('saving');
		try {
			const { nodes: gnodes, connections } = toWorkflowData();
			const state = useWorkflowEditorStore.getState();
			const name = state.workflowName;
			const description = state.workflowDescription;
			const result = await sendRequest('workflow.save', {
				workflow: {
					id: workflowId,
					nodes: gnodes,
					connections,
					name,
					description,
				},
			}) as { success: boolean };
			setSaveStatus(result?.success ? 'saved' : 'error');
		} catch {
			setSaveStatus('error');
		} finally {
			setSaving(false);
			setTimeout(() => setSaveStatus('idle'), 3000);
		}
	}, [saving, workflowId, toWorkflowData]);

	// ═══════════════════════════════════════════════════════════════════
	// v38: Auto-save — debounce-persist workflow after node/edge changes.
	// Without this, provider/model changes in agent nodes only live in
	// Zustand memory and are lost on reload. Fires 2s after the last edit.
	// ═══════════════════════════════════════════════════════════════════
	const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const autoSave = useCallback(async () => {
		const state = useWorkflowEditorStore.getState();
		if (!state.workflowId) { return; }
		try {
			const { nodes: gnodes, connections } = state.toWorkflowData();
			await sendRequest('workflow.save', {
				workflow: {
					id: state.workflowId,
					nodes: gnodes,
					connections,
					name: state.workflowName,
					description: state.workflowDescription,
				},
			});
		} catch {
			// Silently ignore auto-save errors (manual save still reports)
		}
	}, []);
	useEffect(() => {
		if (!loaded || !workflowId) { return; }
		clearTimeout(autoSaveTimerRef.current);
		autoSaveTimerRef.current = setTimeout(() => { autoSave(); }, 2000);
		return () => clearTimeout(autoSaveTimerRef.current);
	}, [nodes, edges, loaded, workflowId, autoSave]);

	// 卡片 ▶ 运行按钮（wf-node-run → onNodeRun）→ 单节点执行。
	// values 来自 node.data（= 画布 properties，内嵌控件已写回）。
	const runSingleSchemaNode = useCallback(async (nodeId: string, nodeType: string) => {
		const canvas = liteGraphRef.current;
		const runner = comfyRegistryRef.current?.resolve(runnerPreference);
		if (!canvas || !runner) {
			setComfyRunState('failed');
			setComfyRunMsg('未连接可用的 ComfyUI Runner');
			return;
		}
		const store = canvas.snapshotStore();
		if (!store) { return; }
		const state = useWorkflowEditorStore.getState();
		const node = state.nodes.find(n => n.id === nodeId);
		const values = (node?.data ?? {}) as Record<string, unknown>;
		setComfyRunState('running');
		setComfyRunMsg(null);
		const r = await runNodeOrStage({
			runner,
			nodeId,
			type: nodeType,
			getSpec: (t) => getNodeSpec(t),
			values,
			store,
			onProgress: (p) => {
				canvas.cardStateStore().set(nodeId, { runState: 'running', progress: p.progress ?? p.value ?? 50 });
			},
		});
		if (r.status === 'success') {
			setComfyRunState('done');
			setComfyRunMsg('节点执行完成');
			canvas.cardStateStore().set(nodeId, { runState: 'success', progress: 100, durationMs: r.durationMs });
		} else {
			setComfyRunState('failed');
			setComfyRunMsg(r.error ?? '执行失败');
			canvas.cardStateStore().set(nodeId, { runState: 'error', progress: 0, errorMsg: r.error ?? '执行失败' });
		}
	}, [runnerPreference]);

	const handleExecute = useCallback(async () => {
		if (!workflowId) { return; }
		// ── P0: Comfy 全图执行（画布包含可执行 Comfy 节点时优先）──
		const state = useWorkflowEditorStore.getState();
		const canvas = liteGraphRef.current;
		const plan = buildExecutionPlan(state.nodes, state.edges, type => isComfyExecutableSpec(getNodeSpec(type)));
		if (plan.steps.length > 0 && canvas) {
			const runner = comfyRegistryRef.current?.resolve(runnerPreference);
			if (!runner) {
				setComfyRunState('failed');
				setComfyRunMsg('画布包含 Comfy 节点，但未连接可用的 ComfyUI Runner');
				return;
			}
			setComfyRunState('running');
			setComfyRunMsg(null);
			if (plan.hasCycle) {
				setComfyRunState('failed');
				setComfyRunMsg('检测到环路，已中止执行');
				return;
			}
			const r = await runGraphExecution({
				nodes: state.nodes,
				edges: state.edges,
				getSpec: (t) => getNodeSpec(t),
				resolveRunner: () => runner,
				snapshotStore: canvas.snapshotStore()!,
				cardState: canvas.cardStateStore(),
				nodeValues: comfyRunValuesRef.current,
				onNodeStart: ({ id }) => setCurrentNodeId(id),
			});
			if (r.success) {
				setComfyRunState('done');
				setComfyRunMsg(`全图执行完成 · ${r.ran.length} 个节点`);
			} else if (r.failed) {
				setComfyRunState('failed');
				setComfyRunMsg(`执行失败：${r.failed.error}（节点 ${r.failed.nodeId}）`);
			} else {
				setComfyRunState('failed');
				setComfyRunMsg('执行中止');
			}
			return;
		}
		// ── P3: host Agent 执行（无可执行 Comfy 节点时回退）──
		try {
			const result = await sendRequest('workflow.execute', {
				workflowId,
			}) as { executionId: string };
			setExecutionId(result?.executionId || null);
			setExecutionStatus('running');

			// P4: host returns the owner-agent session info so the user can
			// jump straight into the chat panel where the live trace is rendered.
			const sessionInfo = (result as any)?.sessionInfo as
				| { workflowAgentId: string; sessionId: string; workflowName: string }
				| undefined;
			if (sessionInfo?.workflowAgentId && sessionInfo?.sessionId) {
				// Chat panel auto-switching is now handled natively by NativeChatEditorPane.
				// No webview action needed.
			}
		} catch (err) {
			console.error('[WorkflowEditor] Failed to execute workflow:', err);
		}
	}, [workflowId, runnerPreference]);

	const handlePause = useCallback(async () => {
		if (!executionId) { return; }
		try {
			await sendRequest('workflow.pause', { executionId });
		} catch (err) {
			console.error('[WorkflowEditor] Failed to pause workflow:', err);
		}
	}, [executionId]);

	const handleResume = useCallback(async () => {
		if (!executionId) { return; }
		try {
			// For now, resume with empty input (AskUser node will handle real input)
			await sendRequest('workflow.resume', { executionId, userInput: '' });
		} catch (err) {
			console.error('[WorkflowEditor] Failed to resume workflow:', err);
		}
	}, [executionId]);

	const handleCancel = useCallback(async () => {
		if (!executionId) { return; }
		try {
			await sendRequest('workflow.cancel', { executionId });
			setExecutionId(null);
			setExecutionStatus(null);
			setCurrentNodeId(null);
		} catch (err) {
			console.error('[WorkflowEditor] Failed to cancel workflow:', err);
		}
	}, [executionId]);

	const handleValidate = useCallback(() => {
		const result = useWorkflowEditorStore.getState().validateWorkflow();
		if (result.valid && result.issues.length === 0) {
			setValidationMsg('✓ Workflow is valid');
		} else {
			const errors = result.issues.filter(i => i.level === 'error').length;
			const warnings = result.issues.filter(i => i.level === 'warning').length;
			const first = result.issues[0]?.message ?? '';
			setValidationMsg(`${errors} error(s), ${warnings} warning(s) · ${first}`);
		}
		setTimeout(() => setValidationMsg(null), 5000);
	}, []);

	return (
		<div style={{
			width: '100%',
			height: '100%',
			display: 'flex',
			flexDirection: 'column',
			overflow: 'hidden',
		}}>
				{/* Toolbar */}
				<div style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '6px 12px',
					borderBottom: '1px solid var(--vscode-panel-border)',
					backgroundColor: 'var(--vscode-titleBar-activeBackground)',
				}}>
					<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
						<input
							type="text"
							value={workflowName}
							onChange={e => setWorkflowName(e.target.value)}
							placeholder="Workflow Name"
							style={{
								fontWeight: 600,
								fontSize: '13px',
								border: '1px solid transparent',
								borderRadius: '2px',
								background: 'transparent',
								color: 'var(--vscode-foreground)',
								padding: '2px 4px',
								width: '180px',
								outline: 'none',
							}}
							onFocus={e => {
								e.target.style.borderColor = 'var(--vscode-focusBorder)';
								e.target.style.background = 'var(--vscode-input-background)';
							}}
							onBlur={e => {
								e.target.style.borderColor = 'transparent';
								e.target.style.background = 'transparent';
							}}
						/>
						<span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)' }}>
							{nodes.length} nodes · {edges.length} connections
						</span>
					</div>
					<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
						<button
							onClick={() => setShowRunners(prev => !prev)}
							title="ComfyUI Runner 管理"
							style={{
								...iconBtnStyle,
								borderColor: showRunners ? 'var(--vscode-focusBorder)' : 'var(--vscode-panel-border)',
								backgroundColor: showRunners ? 'rgba(34,197,94,0.12)' : 'transparent',
								fontSize: '10px',
								width: 'auto',
								padding: '0 8px',
								fontFamily: 'inherit',
							}}
						>
							🖥 Runner
						</button>
						<button
							onClick={() => comfyFileInputRef.current?.click()}
							title="导入 ComfyUI 工作流 JSON"
							style={{ ...iconBtnStyle, borderColor: 'var(--vscode-panel-border)', fontSize: '10px', width: 'auto', padding: '0 8px', fontFamily: 'inherit' }}
						>
							⤵ 导入
						</button>
						<button
							onClick={handleComfyExport}
							title="导出为 ComfyUI api.json"
							style={{ ...iconBtnStyle, borderColor: 'var(--vscode-panel-border)', fontSize: '10px', width: 'auto', padding: '0 8px', fontFamily: 'inherit' }}
						>
							⤴ 导出 API
						</button>
						<input
							ref={comfyFileInputRef}
							type="file"
							accept=".json,application/json"
							style={{ display: 'none' }}
							onChange={handleComfyImportFile}
						/>
						<span style={{ fontSize: '11px', color: validationMsg?.startsWith('✓') ? '#22c55e' : validationMsg ? '#f59e0b' : saveStatus === 'saved' ? '#22c55e' : saveStatus === 'error' ? '#ef4444' : 'var(--vscode-descriptionForeground)' }}>
							{validationMsg
								? validationMsg
								: saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved!' : saveStatus === 'error' ? 'Save failed' : ''}
						</span>
						<button onClick={() => doUndo()} title="Undo (Ctrl+Z)" style={iconBtnStyle}>↶</button>
						<button onClick={() => doRedo()} title="Redo (Ctrl+Shift+Z)" style={iconBtnStyle}>↷</button>
						<button onClick={handleValidate} title="Validate workflow" style={iconBtnStyle}>✓</button>
						<button onClick={handleSave} disabled={saving}
							style={{
								padding: '4px 12px',
								border: '1px solid var(--vscode-button-border)',
								borderRadius: '4px',
								backgroundColor: 'var(--vscode-button-background)',
								color: 'var(--vscode-button-foreground)',
								cursor: saving ? 'not-allowed' : 'pointer',
								fontSize: '12px',
								opacity: saving ? 0.5 : 1,
							}}>
							{saving ? 'Saving...' : 'Save'}
						</button>
						{/* P0 Comfy 全图执行结果提示 */}
						{comfyRunMsg && (
							<span style={{ fontSize: '11px', color: comfyRunState === 'done' ? '#22c55e' : '#ef4444' }}>
								{comfyRunMsg}
							</span>
						)}
						{/* Execution control buttons (P3) */}
						{!executionStatus || executionStatus === 'completed' || executionStatus === 'failed' || executionStatus === 'cancelled' ? (
							<button
								onClick={handleExecute}
								disabled={comfyRunState === 'running'}
								title="Run workflow（画布含 Comfy 节点时全图顺序执行）"
								style={{
									padding: '4px 12px',
									border: '1px solid #22c55e',
									borderRadius: '4px',
									backgroundColor: '#22c55e',
									color: 'white',
									cursor: comfyRunState === 'running' ? 'wait' : 'pointer',
									fontSize: '12px',
									fontWeight: 600,
									opacity: comfyRunState === 'running' ? 0.6 : 1,
								}}>
								{comfyRunState === 'running' ? '运行中…' : comfyRunState === 'done' ? '✓ 完成' : comfyRunState === 'failed' ? '✕ 重试' : '▶ Run'}
							</button>
						) : executionStatus === 'running' ? (
							<>
								<button onClick={handlePause} title="Pause execution" style={{
									padding: '4px 12px',
									border: '1px solid #f59e0b',
									borderRadius: '4px',
									backgroundColor: '#f59e0b',
									color: 'white',
									cursor: 'pointer',
									fontSize: '12px',
									fontWeight: 600,
								}}>
									⏸ Pause
								</button>
								<button onClick={handleCancel} title="Cancel execution" style={{
									padding: '4px 12px',
									border: '1px solid #ef4444',
									borderRadius: '4px',
									backgroundColor: '#ef4444',
									color: 'white',
									cursor: 'pointer',
									fontSize: '12px',
									fontWeight: 600,
								}}>
									✕ Cancel
								</button>
							</>
						) : executionStatus === 'paused' ? (
							<>
								<button onClick={handleResume} title="Resume execution" style={{
									padding: '4px 12px',
									border: '1px solid #22c55e',
									borderRadius: '4px',
									backgroundColor: '#22c55e',
									color: 'white',
									cursor: 'pointer',
									fontSize: '12px',
									fontWeight: 600,
								}}>
									▶ Resume
								</button>
								<button onClick={handleCancel} title="Cancel execution" style={{
									padding: '4px 12px',
									border: '1px solid #ef4444',
									borderRadius: '4px',
									backgroundColor: '#ef4444',
									color: 'white',
									cursor: 'pointer',
									fontSize: '12px',
									fontWeight: 600,
								}}>
									✕ Cancel
								</button>
							</>
						) : null}
					</div>
				</div>

				{/* v41: Editable task description bar — single-line display, multi-line on click */}
				<div style={{
					display: 'flex',
					alignItems: editingDescription ? 'flex-start' : 'center',
					padding: editingDescription ? '6px 12px' : '4px 12px',
					borderBottom: '1px solid var(--vscode-panel-border)',
					backgroundColor: editingDescription
						? 'var(--vscode-input-background)'
						: 'var(--vscode-editor-background)',
					gap: '8px',
					transition: 'padding 0.12s ease, background-color 0.12s ease',
				}}>
					<span style={{
						fontSize: '11px',
						fontWeight: 500,
						color: 'var(--vscode-descriptionForeground)',
						whiteSpace: 'nowrap',
						flexShrink: 0,
						paddingTop: editingDescription ? '5px' : '0',
					}}>
						📝 任务描述
					</span>
					{!editingDescription ? (
						/* Default: single-line display, click to edit */
						<div
							onClick={() => setEditingDescription(true)}
							title="点击编辑任务描述"
							style={{
								flex: 1,
								padding: '3px 6px',
								fontSize: '12px',
								color: workflowDescription
									? 'var(--vscode-foreground)'
									: 'var(--vscode-descriptionForeground)',
								fontStyle: workflowDescription ? 'normal' : 'italic',
								cursor: 'text',
								borderRadius: '2px',
								border: '1px solid transparent',
								overflow: 'hidden',
								whiteSpace: 'nowrap',
								textOverflow: 'ellipsis',
								userSelect: 'none',
							}}
							onMouseEnter={e => {
								e.currentTarget.style.borderColor = 'var(--vscode-focusBorder)';
								e.currentTarget.style.background = 'var(--vscode-input-background)';
							}}
							onMouseLeave={e => {
								e.currentTarget.style.borderColor = 'transparent';
								e.currentTarget.style.background = 'transparent';
							}}
						>
							{workflowDescription || '描述这个工作流的任务目标与流程...'}
						</div>
					) : (
						/* Editing: multi-line textarea */
						<div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
							<textarea
								autoFocus
								value={workflowDescription}
								onChange={e => setWorkflowDescription(e.target.value)}
								placeholder="描述这个工作流的任务目标与流程..."
								rows={Math.max(2, (workflowDescription.match(/\n/g) || []).length + 1)}
								style={{
									width: '100%',
									border: '1px solid var(--vscode-focusBorder)',
									borderRadius: '2px',
									background: 'var(--vscode-input-background)',
									color: 'var(--vscode-foreground)',
									padding: '4px 8px',
									fontSize: '12px',
									lineHeight: 1.5,
									outline: 'none',
									resize: 'vertical',
									fontFamily: 'inherit',
									minHeight: '40px',
								}}
								onBlur={() => setEditingDescription(false)}
								onKeyDown={e => {
									// Escape collapses without saving changes beyond current value
									if (e.key === 'Escape') {
										(e.target as HTMLTextAreaElement).blur();
									}
								}}
							/>
							<div style={{
								fontSize: '10px',
								color: 'var(--vscode-descriptionForeground)',
								marginTop: '2px',
								paddingLeft: '2px',
							}}>
								Esc 退出编辑 · 支持多行描述
							</div>
						</div>
					)}
				</div>

				{/* Main area — canvas fills everything; nodes are added via right-click menu */}
			<div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>

				{/* Canvas — always fills the full area; engine is LiteGraph (ComfyUI) */}
				<div style={{ width: '100%', height: '100%' }}>
					<LiteGraphCanvas
						ref={liteGraphRef}
						className="wf-litegraph-host"
					onNodeDoubleClick={(nodeId, nodeType) => {
						// Double-click always opens the property editor — it never
						// executes the node (execution lives on the card ▶ button).
						const upstreams = edges.filter(e => e.target === nodeId).map(e => e.source);
						const node = nodes.find(n => n.id === nodeId);
						setEditingNode({ nodeId, nodeType, upstreams, data: node?.data });
					}}
					onNodeRun={(nodeId, nodeType) => {
						void runSingleSchemaNode(nodeId, nodeType);
					}}
						onCanvasContextMenu={(graphX, graphY, clientX, clientY) => {
							setCtxMenu({ graphX, graphY, clientX, clientY });
						}}
						onGroupContextMenu={(group, graphX, graphY, clientX, clientY) => {
							setCtxMenu(null);
							setGroupMenu({ group, clientX, clientY });
						}}
						onRequestRun={handleExecute}
					/>
					{/* ComfyUI-style right-click node menu */}
					{ctxMenu && (
						<>
							<div
								style={{
									position: 'fixed', inset: 0, zIndex: 99,
									background: 'transparent',
								}}
								onClick={() => setCtxMenu(null)}
								onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}
							/>
						<NodeContextMenu
							menu={ctxMenu}
							onPick={() => setCtxMenu(null)}
							onClose={() => setCtxMenu(null)}
						/>
					</>
				)}
				{/* ComfyUI-style group ops menu (right-click on a group) */}
				{groupMenu && (
					<>
						<div
							style={{ position: 'fixed', inset: 0, zIndex: 99, background: 'transparent' }}
							onClick={() => setGroupMenu(null)}
							onContextMenu={(e) => { e.preventDefault(); setGroupMenu(null); }}
						/>
						<GroupMenu
							menu={groupMenu}
							onEdit={() => setGroupEditOpen(true)}
							onPin={() => {
								const g = groupMenu.group;
								g.pinned ? g.unpin() : g.pin();
								setGroupMenu(null);
							}}
							onRemove={() => {
								liteGraphRef.current?.removeGroup(groupMenu.group);
								setGroupMenu(null);
							}}
							onClose={() => setGroupMenu(null)}
						/>
					</>
				)}
				{groupEditOpen && groupMenu && (
					<GroupEditPopup
						group={groupMenu.group}
						onSave={(edit) => {
							applyGroupEdit(groupMenu.group, edit);
							setGroupEditOpen(false);
							setGroupMenu(null);
						}}
						onClose={() => setGroupEditOpen(false)}
					/>
				)}
				{/* 节点编辑器浮层：双击节点 → 输入提示词 → 生成出图 */}
					{editingNode && liteGraphRef.current?.snapshotStore() && (
						<NodeEditorPopup
							nodeId={editingNode.nodeId}
							nodeType={editingNode.nodeType}
							runners={comfyRegistryRef.current!}
							store={liteGraphRef.current.snapshotStore()!}
							cardStateStore={liteGraphRef.current.cardStateStore()}
							preference={runnerPreference}
							initialData={editingNode.data}
							upstreams={editingNode.upstreams}
							onValuesCommit={(id, values) => {
						comfyRunValuesRef.current[id] = values;
						// Sarosis (react) nodes persist their parameters into node.data.
						const spec = getNodeSpec(editingNode.nodeType);
						if (spec?.kind === 'react') {
							useWorkflowEditorStore.getState().updateNodeData(id, values);
						}
					}}
							onClose={() => setEditingNode(null)}
							onSelectRunner={() => setShowRunners(true)}
						/>
					)}
					{comfyImportMsg && (
						<div style={{
							position: 'absolute', bottom: 12, left: 12, zIndex: 5,
							fontSize: 11, padding: '5px 10px', borderRadius: 4,
							background: 'var(--vscode-notifications-background)',
							border: '1px solid var(--vscode-panel-border)',
							color: 'var(--vscode-foreground)',
						}}>
							{comfyImportMsg}
							<button
								onClick={() => setComfyImportMsg(null)}
								style={{ marginLeft: 8, background: 'transparent', border: 'none', color: 'var(--vscode-foreground)', cursor: 'pointer', fontSize: 11 }}
							>✕</button>
						</div>
					)}
				</div>

				{/* Comfy Runner 管理面板浮层 */}
				{showRunners && comfyRegistryRef.current && (
					<div style={{
						position: 'absolute',
						top: 40,
						right: 12,
						zIndex: 30,
						width: 320,
						maxHeight: 'calc(100% - 60px)',
						overflowY: 'auto',
						borderRadius: 8,
						background: 'var(--vscode-sideBar-background)',
						border: '1px solid var(--vscode-panel-border)',
						boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
					}}>
					<RunnerManagerPanel
						registry={comfyRegistryRef.current}
						onRunnerResolved={setRunnerPreference}
					/>
				</div>
			)}
			</div>
		</div>
	);
};

const iconBtnStyle: React.CSSProperties = {
	width: '26px',
	height: '26px',
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	border: '1px solid var(--vscode-button-border)',
	borderRadius: '4px',
	backgroundColor: 'transparent',
	color: 'var(--vscode-foreground)',
	cursor: 'pointer',
	fontSize: '14px',
};

export default WorkflowEditorPanel;
