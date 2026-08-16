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
import type { LGraphNode } from '@comfyorg/litegraph';
import { LiteGraphCanvas, type LiteGraphCanvasHandle } from './LiteGraphCanvas';
import { NodeContextMenu, type NodeContextMenuState, buildAddNodeSubmenu } from './NodeContextMenu';
import { NodeActionsMenu, type NodeActionsMenuState } from './NodeActionsMenu';
import { buildNodeActions, buildCanvasActions, buildGroupActions, buildPortDisconnectAction, MENU_TEXT, type NodeActionsContext } from './menuItems';
import { GroupEditPopup, applyGroupEdit } from './groupMenu';
import { RunnerManagerPanel } from './RunnerManagerPanel';
import { NodeEditorPopup } from './NodeEditorPopup';

import { setActiveRunnerRegistry, setActiveRunnerPreference } from './comfyHost/runnerContext';
import { MediaGallery } from './MediaGallery';
import { ComfyRunnerRegistry, createDefaultLocalRunner, collectRunnerRows } from './comfyHost/comfyRunner';
import { guiToApi, stripSarosNodesForExport } from './comfyHost/comfyApiAdapter';
import { registerDefaultComfyTVStages, getNodeSpec } from './comfyHost/registry';
import { getRunnerStatusStore } from './comfyHost/runnerStatusStore';
import { spawnPickerForStage, spawnFollowUp } from './comfyHost/actionSpawn';
import { isComfyExecutableSpec, isExecutableSpec, isPickerNode, runGraphExecution, runNodeOrStage, resolveFirstImageGenDefaults, defaultResolveLoadImageRef } from './comfyHost/workflowRun';
import { buildExecutionPlan } from './comfyHost/executionGraph';
import { applyCanvasOps, type CanvasModel, type CanvasNode, type CanvasEdge, type CanvasOp } from './comfyHost/canvasOps';
import { buildGenerateFlow } from './comfyHost/generateFlow';
import { computeDagLayout } from './comfyHost/dagLayout';
import { buildSubflowFromGraph } from './comfyHost/subflow';
import { PluginManagerPanel } from './PluginManagerPanel';
import { TaskProgressPanel } from './TaskProgressPanel';
import { DependencyGuide } from './DependencyGuide';
import { getTaskStore } from './comfyHost/taskStore';
import { runReversePrompt } from './comfyHost/reversePromptRun';
import { loadObjectInfoNodes } from './comfyHost/comfyObjectInfoLoader';
import { useWorkflowEditorStore, undo as doUndo, redo as doRedo, pauseTracking, resumeTracking, type WorkflowEditorNode, type WorkflowEditorEdge } from './store';
import { sendRequest, createComfyFetch } from '../../bridge/messageClient';
import { useAgentStore } from '../../store/useAgentStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProviderStore, type ProviderInfo } from '../../store/useProviderStore';
import type { IStoredWorkflow } from '../../types/workflowStorage';

export const WorkflowEditorPanel: React.FC = () => {
	// right-click "Add Node" menu (ComfyUI-style) — replaces the left Nodes panel
	const [ctxMenu, setCtxMenu] = useState<NodeContextMenuState | null>(null);
	// right-click on a group → group ops menu (M2: pin/title/color/font/remove)
	const [groupMenu, setGroupMenu] = useState<NodeActionsMenuState | null>(null);
	// right-click on a node → node actions menu (M1: run/edit/clone/colors/remove)
	const [nodeMenu, setNodeMenu] = useState<NodeActionsMenuState | null>(null);
	// right-click on the canvas → canvas actions menu (Add Node… / run / reset view)
	const [canvasMenu, setCanvasMenu] = useState<NodeActionsMenuState | null>(null);
	// right-click on a connection → link menu (M2: disconnect)
	const [linkMenu, setLinkMenu] = useState<NodeActionsMenuState | null>(null);
	// group edit popup target + initial focus (opened from the group menu)
	const [groupEditTarget, setGroupEditTarget] = useState<LGraphGroup | null>(null);
	const [groupEditFocus, setGroupEditFocus] = useState<'title' | 'font'>('title');
	const [editingDescription, setEditingDescription] = useState(false); // v41: multi-line edit toggle
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
	const [validationMsg, setValidationMsg] = useState<string | null>(null);

	// 方案A：webview 直连优先（ComfyUI 需 --enable-cors-header），失败自动降级
	// 主进程代理——createComfyFetch 按 origin 探测 CORS 后路由，无需手工干预。
	const comfyFetchRef = useRef<typeof fetch | null>(null);
	if (!comfyFetchRef.current) {
		comfyFetchRef.current = createComfyFetch('http://127.0.0.1:8188');
	}

	// Canvas engine: LiteGraph (ComfyUI 底层框架) — ReactFlow 已移除，唯一引擎
	const [showRunners, setShowRunners] = useState(false);
	const [showMediaLibrary, setShowMediaLibrary] = useState(false);
	const comfyRegistryRef = useRef<InstanceType<typeof ComfyRunnerRegistry> | null>(null);
	if (!comfyRegistryRef.current) {
		comfyRegistryRef.current = new ComfyRunnerRegistry();
	}
	// 节点编辑器浮层：双击画布节点 → 打开（输入提示词 → 生成出图）
	// snapshotKey = stageUid（快照归档键）；upstreams 也是归档键（弹窗只用它们
	// 做 store.byNode 查询），二者都由画布层的 stageUidOf 解析。
	const [editingNode, setEditingNode] = useState<{ nodeId: string; nodeType: string; snapshotKey?: string; upstreams: string[]; data?: Record<string, unknown> } | null>(null);
	// 内联重命名：右键 Rename → 在节点标题栏位置显示 <input>（对齐 ComfyUI/ComfyTV 行为）。
	// { node } 引用保持有效：rename 期间用户不会删除该节点（菜单已关闭、canvas 无操作）。
	const [renamingNode, setRenamingNode] = useState<{ node: LGraphNode; screenX: number; screenY: number } | null>(null);
	const renameInputRef = useRef<HTMLInputElement>(null);
	const [runnerPreference, setRunnerPreference] = useState('auto');

	// 全局 runner 单例：NodeCard 内嵌编辑器（MaskPainter「应用 mask」上传）读此上下文，
	// 无需跨 LiteGraphCanvas → createNodeCard → NodeCard 三层传 prop。
	useEffect(() => {
		setActiveRunnerRegistry(comfyRegistryRef.current);
		return () => setActiveRunnerRegistry(null);
	}, []);
	useEffect(() => {
		setActiveRunnerPreference(runnerPreference);
	}, [runnerPreference]);

	// P0: 全图 Comfy 执行状态（与 P3 host 执行状态分离）
	const [comfyRunState, setComfyRunState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
	const [comfyRunMsg, setComfyRunMsg] = useState<string | null>(null);
	// P1: 并行执行模式（同层无依赖节点并发；Comfy 后端步骤仍串行）
	const [comfyRunParallel, setComfyRunParallel] = useState(false);
	// P2: 插件管理面板开关
	const [showPluginManager, setShowPluginManager] = useState(false);
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
			registry.register(createDefaultLocalRunner(comfyFetchRef.current as never));
		}
		let cancelled = false;
		(async () => {
			try {
				const rows = await collectRunnerRows(registry.list());
				const healthy = rows.find(r => r.ok);
				// P2 engine-ready gate: publish runner readiness so schema/native
				// cards can show a "disconnected" placeholder instead of an
				// executable (but doomed) run button.
				getRunnerStatusStore().setReady(!!healthy, healthy?.baseUrl);
				if (!healthy || cancelled) { return; }
				// 完全不依赖 ComfyTV 后端 API：节点定义走内置 comfyTVStageMeta.generated.ts，
				// 出图走内置 workflow 模板（builtinWorkflows/）。这里只拉 ComfyUI 原生
				// /object_info（注册可拖拽的原生节点），不再拉 /comfytv/stages、/comfytv/caps。
				await loadObjectInfoNodes(healthy.baseUrl, comfyFetchRef.current as never);
			} catch {
				// 无本地 ComfyUI 时静默 —— 默认 stages 已提供入口。
				getRunnerStatusStore().setReady(false);
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
		// Provider/编排节点没有 ComfyUI class_type —— 导出前剔除，避免生成
		// 无法在 ComfyUI 运行的 api.json（如 Saros.ModelImageGen）。
		const { workflow, skipped } = stripSarosNodesForExport(wf, t => {
			const spec = getNodeSpec(t);
			return spec?.kind === 'react' || spec?.kind === 'llm';
		});
		if (skipped.length) {
			setComfyImportMsg(`已跳过 ${skipped.length} 个非 Comfy 节点：${skipped.join(', ')}`);
		}
		const blob = new Blob([JSON.stringify(guiToApi(workflow), null, 2)], { type: 'application/json' });
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
	// 右键 "添加节点" 菜单（NodeContextMenu 的 buildAddNodeSubmenu）需要 store.addNode
	// 作为真源——之前漏掉了 destructure，导致 (type) => addNode(...) 抛 ReferenceError，
	// 点击菜单项静默失败、不创建节点。
	const addNode = useWorkflowEditorStore(s => s.addNode);

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

	// Agent-driven canvas (P0): apply canvas ops pushed from the host (from
	// canvas_apply_ops / canvas_generate tools) and reply with the result.
	useEffect(() => {
		const handler = async (e: Event) => {
			const detail = (e as CustomEvent).detail as {
				requestId: string;
				ops: Array<Record<string, unknown>>;
			} | undefined;
			if (!detail?.requestId || !Array.isArray(detail.ops)) { return; }
			try {
				const state = useWorkflowEditorStore.getState();
				const providers = useProviderStore.getState().providers;
				// P0: batch = single undo step. Pause zundo tracking around the whole
				// batch so multiple setNodes/setEdges collapse into ONE undo entry.
				pauseTracking();
				let result;
				try {
					result = applyCanvasOpsToStore(state, detail.ops, providers, {
						undo: () => doUndo(),
						redo: () => doRedo(),
					});
				} finally {
					resumeTracking();
				}
				// Attach a canvas state snapshot so the host's <canvas_context>
				// tag can inject node results into the next user message (P0).
				const canvasContext = buildCanvasContextSnapshot(state, liteGraphRef.current?.cardStateStore?.());
				await sendRequest('workflow.canvasOpsResult', {
					requestId: detail.requestId,
					result,
					workflowId: useWorkflowEditorStore.getState().workflowId ?? undefined,
					canvasContext,
				});
				// P0: canvas_generate with run:true → trigger full-graph execution.
				const wantsRun = detail.ops.some(o =>
					o.op === 'add_node' && o.type === '__generate_flow__' && (o.data as Record<string, unknown> | undefined)?.run === true);
				if (wantsRun && result.ok) { executeRef.current(); }
				// P2: canvas_generate with layout:true → auto-layout after applying.
				const wantsLayout = detail.ops.some(o =>
					o.op === 'add_node' && o.type === '__generate_flow__' && (o.data as Record<string, unknown> | undefined)?.layout === true);
				if (wantsLayout && result.ok) { autoLayoutRef.current(); }
				// P2: __reverse_prompt__ → describe an upstream image back into the
				// node's prompt (async RPC). The op is special: it does NOT mutate
				// the canvas model via applyCanvasOps; it runs the reverse-prompt
				// pipeline and writes the result into the target node.
				const reverseOp = detail.ops.find(o =>
					o.op === 'add_node' && o.type === '__reverse_prompt__');
				if (reverseOp) {
					const target = String((reverseOp.data as Record<string, unknown> | undefined)?.target ?? reverseOp.id ?? '');
					const revResult = await runReversePrompt({
						target,
						store: liteGraphRef.current?.snapshotStore() as never,
						nodes: useWorkflowEditorStore.getState().nodes as never,
						edges: useWorkflowEditorStore.getState().edges as never,
						providers: useProviderStore.getState().providers as never,
						reversePrompt: (args) => sendRequest('reversePrompt.generate', args, 60_000),
					});
					if (revResult.ok && revResult.nodeId && revResult.prompt) {
						const s = useWorkflowEditorStore.getState();
						pauseTracking();
						try {
							s.setNodes(s.nodes.map(n =>
								n.id === revResult.nodeId ? { ...n, data: { ...n.data, prompt: revResult.prompt! } } : n) as never);
						} finally {
							resumeTracking();
						}
						const ctx = buildCanvasContextSnapshot(useWorkflowEditorStore.getState(), liteGraphRef.current?.cardStateStore?.());
						void sendRequest('workflow.canvasOpsResult', {
							requestId: detail.requestId,
							result: { ok: true, model: { nodes: [], edges: [] }, results: [{ opIndex: 0, summary: `已反推提示词：${revResult.prompt.slice(0, 80)}${revResult.prompt.length > 80 ? '…' : ''}` }] },
							workflowId: useWorkflowEditorStore.getState().workflowId ?? undefined,
							canvasContext: ctx,
						});
					} else {
						void sendRequest('workflow.canvasOpsResult', {
							requestId: detail.requestId,
							result: { ok: false, error: revResult.error, model: { nodes: [], edges: [] }, results: [] },
						});
					}
				}
			} catch (err) {
				console.error('[WorkflowEditor] canvas ops apply failed', err);
				void sendRequest('workflow.canvasOpsResult', {
					requestId: detail.requestId,
					result: {
						ok: false,
						error: err instanceof Error ? err.message : String(err),
					},
				});
			}
		};
		window.addEventListener('agentStudio:workflow-canvas-ops', handler as EventListener);
		return () => window.removeEventListener('agentStudio:workflow-canvas-ops', handler as EventListener);
	}, []);

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
	const runSingleSchemaNode = useCallback(async (nodeId: string, nodeType: string, stageUid?: string) => {
		// eslint-disable-next-line no-console
		console.warn('[runSingleSchemaNode] start ' + JSON.stringify({ nodeId, nodeType, stageUid }));
		const canvas = liteGraphRef.current;
		// Provider 后端节点（ModelImageGen）经 imagegen.generate RPC 执行，
		// 不需要 ComfyUI runner；只有 Comfy 后端节点才要求 runner 在线。
		const spec = getNodeSpec(nodeType);
		const isProviderNode = spec?.backendKind === 'provider' || spec?.kind === 'llm';
		const runner = isProviderNode ? undefined : comfyRegistryRef.current?.resolve(runnerPreference);
		if (!canvas || (!isProviderNode && !runner)) {
			// eslint-disable-next-line no-console
			console.warn('[runSingleSchemaNode] no canvas/runner ' + JSON.stringify({ hasCanvas: !!canvas, isProviderNode, hasRunner: !!runner }));
			setComfyRunState('failed');
			setComfyRunMsg(isProviderNode ? '未连接可用的 Provider' : '未连接可用的 ComfyUI Runner');
			return;
		}
		const store = canvas.snapshotStore();
		if (!store) {
			// eslint-disable-next-line no-console
			console.warn('[runSingleSchemaNode] no snapshotStore');
			return;
		}
		// 引擎就绪实时探测：runnerStatus.ready 只在面板 mount 时探测一次，引擎后
		// 启动后卡片仍停在「未连接引擎」。点击运行时重新 testConnection，成功即
		// 翻转全局 ready 状态并继续执行，失败则给出明确的启动指引（而非直接抛
		// ERR_CONNECTION_REFUSED 让按钮显得「没反应」）。
		if (runner) {
			// eslint-disable-next-line no-console
			console.warn('[runSingleSchemaNode] probing runner ' + runner.baseUrl);
			const probe = await runner.testConnection();
			if (!probe.ok) {
				getRunnerStatusStore().setReady(false);
				const detail = probe.error ?? '连接失败';
				// eslint-disable-next-line no-console
				console.warn('[runSingleSchemaNode] runner unreachable ' + JSON.stringify({ baseUrl: runner.baseUrl, error: detail }));
				setComfyRunState('failed');
				setComfyRunMsg('未连接 ComfyUI 引擎');
				canvas.cardStateStore().set(nodeId, {
					runState: 'error', progress: 0,
					errorMsg: `无法连接 ${runner.baseUrl}（${detail}）。请点击工具栏「🖥 Runner」→「▶ 启动 ComfyUI（--enable-cors-header）」，启动后回到本节点重新点击运行。`,
				});
				return;
			}
			getRunnerStatusStore().setReady(true, runner.baseUrl);
		}
		const state = useWorkflowEditorStore.getState();
		const node = state.nodes.find(n => n.id === nodeId);
		const values = (node?.data ?? {}) as Record<string, unknown>;
		// 单节点运行也要带上直接上游（edges 中 target === nodeId 的 source），否则
		// runStageWorkflow → collectUpstreamRefs 拿不到上游图 → upstream_image:annotated
		// binding 注入失败，Upscale/Erase 等消费节点报 "Invalid image file: example.png"
		//（LoadImage 保持模板默认 example.png 不变）。与双击编辑路径 line 1212 同款算法。
		// ★ 上游 id 必须映射成**快照归档键**（stageUid）：executor 侧只用它做
		//   `store.byNode(...)` 查询，传 nodeId 会查不到按 uid 归档的新快照 →
		//   下游节点读不到上游刚生成的图。
		const upstreams = state.edges
			.filter(e => e.target === nodeId)
			.map(e => canvas.stageUidOf(e.source) ?? e.source);
		// 归档键：onNodeRun 已带 stageUid；右键菜单 Run 没有 → 从画布补齐。
		const snapKey = stageUid ?? canvas.stageUidOf(nodeId) ?? nodeId;
		// ComfyTV auto-picker: running an ImageStage / VideoStage with no
		// downstream link spawns the matching picker stage and wires output[0]
		// → picker.batch (faithful to useStageNode.onRunRequest).
		spawnPickerForStage(nodeId, nodeType);
		setComfyRunState('running');
		setComfyRunMsg(null);
		// 任务进度面板：注册出图任务（单节点），onProgress 实时回填进度。
		const taskId = getTaskStore().add('generate', nodeType, { message: '排队中…' });
		getTaskStore().start(taskId, '提交到 ComfyUI…');
		// 立即把卡片状态置为 running（按钮变 cancel + RunProgress 出现）。原因：
		// runNodeOrStage → runStageWorkflow → runner.invoke 的 onProgress 只在
		// ComfyUI /history 返回 status_str 既非 success 也非 error 时才回调；快速出图
		// (SDXL 5-10s) 下首轮轮询就 break 到 success 分支，onProgress 一次都没触发，
		// cardState 保持 'idle' → 按钮一直「生成批图」、OUTPUT 永不显示（因为
		// showOutput=runState==='success'）、用户感觉「点了没反应」。先设 running 兜底。
		canvas.cardStateStore().set(nodeId, { runState: 'running', progress: 0 });
		// eslint-disable-next-line no-console
		console.warn('[runSingleSchemaNode] invoking runNodeOrStage ' + JSON.stringify({ nodeId, nodeType, specKind: spec?.kind, backendKind: spec?.backendKind }));
		const r = await runNodeOrStage({
			// Provider 节点不读 runner；Comfy 节点在此前已确保 runner 存在。
			runner: runner as unknown as Parameters<typeof runNodeOrStage>[0]['runner'],
			nodeId,
			// ★ 快照归档键 = stageUid（与 nodeCard 读侧一致）。缺省回退 nodeId，
			//   保证「写入 nodeId、读取 stageUid」的不一致不再发生。
			snapshotKey: snapKey,
			type: nodeType,
			getSpec: (t) => getNodeSpec(t),
			values,
			upstreams,
			store,
			onProgress: (p) => {
				const prog = p.progress ?? p.value ?? 50;
				canvas.cardStateStore().set(nodeId, { runState: 'running', progress: prog });
				getTaskStore().update(taskId, { progress: prog, message: '生成中…' });
			},
		});
		if (r.status === 'success') {
				setComfyRunState('done');
				setComfyRunMsg('节点执行完成');
				canvas.cardStateStore().set(nodeId, { runState: 'success', progress: 100, durationMs: r.durationMs });
				getTaskStore().finish(taskId, true, `完成 · ${r.durationMs ? `${r.durationMs}ms` : ''}`);
				// 先把本节点的输出快照存入 store（picker 执行时需要通过 store.byNode 查找上游数据）。
				// 注意：各 executor 内部（runStageWorkflow/runSingleNode 等）已经调用过 store.put()，
				// 此处二次 put 会创建递增 index 的副本条目（同一 ref）。仅对非 picker 节点做 skipImport
				// 以避免重复媒体库导入；picker 条目已在 runPickerNode 内以 skipImport=true 存入。
				for (const entry of r.entries) { store.put(entry, true /* skipImport — executor 已导入 */); }
				// 自动执行已连接的 ImagePicker，把本节点生成的结果填充进 picker，
				// 使其立即显示缩略图（ComfyTV 的 onRunRequest 只负责连线，不刷新 picker 内容）。
				const pickerTarget = state.edges
					.filter(e => e.source === nodeId)
					.map(e => state.nodes.find(n => n.id === e.target))
					.find(n => n && isPickerNode(n.type));
				if (pickerTarget) {
					runNodeOrStage({
						runner: runner as unknown as Parameters<typeof runNodeOrStage>[0]['runner'],
						nodeId: pickerTarget.id,
						// picker 也按归档键写入/读取，否则它自己的 OUTPUT 不刷新。
						snapshotKey: canvas.stageUidOf(pickerTarget.id) ?? pickerTarget.id,
						type: pickerTarget.type,
						getSpec: (t) => getNodeSpec(t),
						values: {},
						// 上游即刚跑完的本节点 —— 传归档键，picker 才能收集到候选。
						upstreams: [snapKey],
						store,
						onProgress: () => {},
					}).then(pr => {
						if (pr.status === 'success') {
							// Picker 条目已在 runPickerNode 内以 skipImport=true 存入，此处跳过导入。
							for (const e of pr.entries) { store.put(e, true /* skipImport */); }
						}
					}).catch(() => {});
				}
			} else {
				setComfyRunState('failed');
				// Toolbar 只显示简短结果；完整错误（含 ComfyUI 后端 JSON body）已写入卡片 ErrorBanner。
				setComfyRunMsg(`节点失败（详细原因见卡片）`);
				canvas.cardStateStore().set(nodeId, { runState: 'error', progress: 0, errorMsg: r.error ?? '执行失败' });
				getTaskStore().finish(taskId, false, r.error ?? '执行失败');
			}
	}, [runnerPreference]);

	// Latest handleExecute — the canvas-ops listener (stable effect) calls this
	// when canvas_generate is issued with run:true (P0 closure).
	const executeRef = useRef<() => void>(() => { });
	executeRef.current = () => { void handleExecute(); };

	// Latest handleAutoLayout — the canvas-ops listener calls this when a batch
	// requests auto-layout (canvas_generate layout:true, P2).
	// P2: auto-layout — recompute node positions via computeDagLayout (layered
	// Kahn) and apply to the store. Wrapped in pause/resume so it's one undo step.
	const handleAutoLayout = useCallback(() => {
		const state = useWorkflowEditorStore.getState();
		if (state.nodes.length === 0) { return; }
		const layout = computeDagLayout(
			state.nodes.map(n => ({ id: n.id })),
			state.edges.map(e => ({ source: e.source, target: e.target })),
		);
		const nodes = state.nodes.map(n => {
			const pos = layout.get(n.id);
			return pos ? { ...n, position: { ...n.position, x: pos.x, y: pos.y } } : n;
		});
		pauseTracking();
		try { state.setNodes(nodes); } finally { resumeTracking(); }
	}, []);

	// Latest handleAutoLayout — the canvas-ops listener calls this when a batch
	// requests auto-layout (canvas_generate layout:true, P2). Assigned AFTER the
	// useCallback declaration to avoid a TDZ reference on first render.
	const autoLayoutRef = useRef<() => void>(() => { });
	autoLayoutRef.current = () => handleAutoLayout();

	// P2: wrap the currently selected nodes into a Subflow composition node.
	// Uses buildSubflowFromGraph (pure) + replaces the selected nodes with a
	// single Saros.Subflow node carrying data.subflow. Original nodes are
	// preserved inside the subflow definition (flattenSubflows expands them
	// back at execution time).
	const handleWrapSubflow = useCallback(() => {
		const canvas = liteGraphRef.current;
		if (!canvas) { return; }
		const selected = canvas.getSelectedNodes();
		if (selected.length < 2) {
			// A single-node subflow is allowed but rarely useful; keep it minimal.
			return;
		}
		const state = useWorkflowEditorStore.getState();
		const allNodes = state.nodes;
		const allEdges = state.edges;
		const subflow = buildSubflowFromGraph(
			`subflow-${Date.now()}`,
			'组合',
			selected.map(s => ({ id: s.id, type: s.type, data: s.data })),
			allEdges.map(e => ({ source: e.source, target: e.target })),
		);
		// Replace selected nodes with a single subflow node; rewire edges that
		// crossed the boundary to/from the subflow node.
		const selectedIds = new Set(selected.map(s => s.id));
		const anchorNode = state.nodes.find(n => n.id === selected[0].id);
		const subflowNode: CanvasNode = {
			id: subflow.id,
			type: 'Saros.Subflow',
			position: anchorNode?.position ?? { x: 0, y: 0 },
			data: { label: subflow.name, subflow },
		};
		const keptNodes = state.nodes.filter(n => !selectedIds.has(n.id));
		const newEdges = state.edges
			.filter(e => !(selectedIds.has(e.source) && selectedIds.has(e.target)))
			.map(e => {
				if (selectedIds.has(e.source)) { return { ...e, source: subflow.id }; }
				if (selectedIds.has(e.target)) { return { ...e, target: subflow.id }; }
				return e;
			});
		pauseTracking();
		try {
			state.setNodes([...keptNodes, subflowNode] as never);
			state.setEdges(newEdges as never);
		} finally {
			resumeTracking();
		}
	}, []);

	const handleExecute = useCallback(async () => {
		if (!workflowId) { return; }
		// ── P0: Comfy + Provider 全图执行（画布包含可执行节点时优先）──
		// 可执行 = schema/native（ComfyUI runner）+ llm（imagegen.generate RPC）。
		const state = useWorkflowEditorStore.getState();
		const canvas = liteGraphRef.current;
		const plan = buildExecutionPlan(state.nodes, state.edges, type => isExecutableSpec(getNodeSpec(type)));
		if (plan.steps.length > 0 && canvas) {
			const needsRunner = plan.steps.some(s => isComfyExecutableSpec(getNodeSpec(s.type)));
			const runner = needsRunner ? comfyRegistryRef.current?.resolve(runnerPreference) : undefined;
			if (needsRunner && !runner) {
				setComfyRunState('failed');
				setComfyRunMsg('画布包含 Comfy 节点，但未连接可用的 ComfyUI Runner');
				return;
			}
			setComfyRunState('running');
			setComfyRunMsg(null);
			// 任务进度面板：注册全图出图任务，onNodeStart 实时回填当前节点。
			const taskStoreId = getTaskStore().add('generate', `工作流 · ${workflowName || workflowId}`, { message: '排队中…' });
			getTaskStore().start(taskStoreId, '构建执行计划…');
			if (plan.hasCycle) {
				setComfyRunState('failed');
				setComfyRunMsg('检测到环路，已中止执行');
				getTaskStore().finish(taskStoreId, false, '检测到环路');
				return;
			}
			const r = await runGraphExecution({
				nodes: state.nodes,
				edges: state.edges,
				getSpec: (t) => getNodeSpec(t),
				resolveRunner: () => runner,
				snapshotStore: canvas.snapshotStore()!,
				cardState: canvas.cardStateStore(),
				// ★ 全图 Run 的快照归档键解析器（= stageUid）。缺了它就是
				//   「写 nodeId、卡片读 uid」→ 全图跑成功但所有 OUTPUT 不刷新。
				snapshotKeyOf: (id) => canvas.stageUidOf(id),
				nodeValues: comfyRunValuesRef.current,
				onNodeStart: ({ id }) => {
					setCurrentNodeId(id);
					getTaskStore().update(taskStoreId, { message: `执行节点 ${id}…` });
				},
				sendImageGen: (payload) => sendRequest('imagegen.generate', payload, 180_000),
				resolveImageGenDefaults: async () =>
					resolveFirstImageGenDefaults(useProviderStore.getState().providers),
				resolveLoadImageRef: defaultResolveLoadImageRef(runner, comfyFetchRef.current as never),
				fetchImpl: comfyFetchRef.current as never,
				mode: comfyRunParallel ? 'parallel' : 'serial',
				parallelConcurrency: 4,
				taskId: `run-${Date.now()}`,
			});
			if (r.success) {
				setComfyRunState('done');
				setComfyRunMsg(`全图执行完成 · ${r.ran.length} 个节点`);
				getTaskStore().finish(taskStoreId, true, `完成 · ${r.ran.length} 个节点`);
			} else if (r.failed) {
				setComfyRunState('failed');
				// Toolbar 仅显示简短摘要；完整错误（ComfyUI 后端 JSON body）已写入节点卡片 ErrorBanner。
				setComfyRunMsg(`执行失败（节点 ${r.failed.nodeId}，详细原因见卡片）`);
				getTaskStore().finish(taskStoreId, false, `节点 ${r.failed.nodeId} 失败`);
			} else {
				setComfyRunState('failed');
				setComfyRunMsg('执行中止');
				getTaskStore().finish(taskStoreId, false, '执行中止');
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
		<>
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
							onClick={() => setShowMediaLibrary(true)}
							title="媒体库（生成图片资产管理）"
							style={{
								...iconBtnStyle,
								borderColor: showMediaLibrary ? 'var(--vscode-focusBorder)' : 'var(--vscode-panel-border)',
								backgroundColor: showMediaLibrary ? 'rgba(99,102,241,0.12)' : 'transparent',
								fontSize: '10px',
								width: 'auto',
								padding: '0 8px',
								fontFamily: 'inherit',
							}}
						>
							🖼 媒体库
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
						{/* P0 Comfy 全图执行结果提示（仅简短摘要；详细错误在节点卡片 ErrorBanner） */}
						{comfyRunMsg && (
							<span
								title={comfyRunMsg}
								style={{
									fontSize: '11px',
									color: comfyRunState === 'done' ? '#22c55e' : '#ef4444',
									maxWidth: 220,
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									whiteSpace: 'nowrap',
									flexShrink: 0,
								}}
							>
								{comfyRunMsg}
							</span>
						)}
						{/* P1: 并行执行开关（同层无依赖节点并发；Comfy 后端步骤仍串行） */}
						<label title="并行执行：同层无依赖节点并发运行（provider/本地节点共用 4 并发；ComfyUI 后端步骤保持串行）"
							style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#9ca3af', cursor: 'pointer', userSelect: 'none' }}>
							<input
								type="checkbox"
								checked={comfyRunParallel}
								onChange={e => setComfyRunParallel(e.target.checked)}
								style={{ cursor: 'pointer' }}
							/>
							并行
						</label>
						{/* P2: 自动布局（Kahn 分层 → 列布局，一步 undo） */}
						<button
							onClick={handleAutoLayout}
							disabled={comfyRunState === 'running'}
							title="自动布局：按依赖分层排列节点（拓扑列布局，可撤销）"
							style={{
								padding: '4px 10px',
								border: '1px solid #3b82f6',
								borderRadius: '4px',
								backgroundColor: 'transparent',
								color: '#60a5fa',
								cursor: 'pointer',
								fontSize: '12px',
							}}>
							自动布局
						</button>
						{/* P2: 封装为 Subflow（选中 ≥2 节点 → 组合为可复用子图，执行时展平） */}
						<button
							onClick={handleWrapSubflow}
							disabled={comfyRunState === 'running'}
							title="封装为 Subflow：把当前选中的节点组合为可复用子图（执行时自动展平，可撤销）"
							style={{
								padding: '4px 10px',
								border: '1px solid #8b5cf6',
								borderRadius: '4px',
								backgroundColor: 'transparent',
								color: '#a78bfa',
								cursor: 'pointer',
								fontSize: '12px',
							}}>
							封装 Subflow
						</button>
						{/* P2: 插件管理（URL 安装/卸载/重载） */}
						<button
							onClick={() => setShowPluginManager(true)}
							title="管理画布插件（URL 安装 / 卸载）"
							style={{
								padding: '4px 10px',
								border: '1px solid #f59e0b',
								borderRadius: '4px',
								backgroundColor: 'transparent',
								color: '#fbbf24',
								cursor: 'pointer',
								fontSize: '12px',
							}}>
							插件
						</button>
						{/* Execution control buttons (P3) */}
						{!executionStatus || executionStatus === 'completed' || executionStatus === 'failed' || executionStatus === 'cancelled' ? (
							<button
								onClick={handleExecute}
								disabled={comfyRunState === 'running'}
								title="Run workflow（画布含 Comfy 节点时全图执行；勾选「并行」后同层节点并发）"
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
					workflowId={workflowId}
					onNodeDoubleClick={(nodeId, nodeType) => {
						// Double-click always opens the property editor — it never
						// executes the node (execution lives on the card ▶ button).
						// 上游 + 自身都换成快照归档键（stageUid），与卡片读侧一致。
						const uidOf = (id: string) => liteGraphRef.current?.stageUidOf(id) ?? id;
						const upstreams = edges.filter(e => e.target === nodeId).map(e => uidOf(e.source));
						const node = nodes.find(n => n.id === nodeId);
						setEditingNode({ nodeId, nodeType, snapshotKey: uidOf(nodeId), upstreams, data: node?.data });
					}}
					onNodeRun={(nodeId, nodeType, stageUid) => {
						void runSingleSchemaNode(nodeId, nodeType, stageUid);
					}}
						onCanvasContextMenu={(graphX, graphY, clientX, clientY) => {
							setCtxMenu(null);
							setNodeMenu(null);
							setGroupMenu(null);
							setLinkMenu(null);
							// Canvas right-click → actions menu; "Add Node…" opens the search.
							// Clipboard: litegraph backs its clipboard with the
							// "litegrapheditor_clipboard" localStorage key.
							const canPaste = typeof window !== 'undefined' && !!window.localStorage?.getItem('litegrapheditor_clipboard');
							// 复刻 ComfyUI：Add Node 二级级联菜单（sampling/loaders/conditioning/...）。
							// store.addNode 是真源（同时驱动 LiteGraph 与 reactive state）。
							const addNodeSubmenu = buildAddNodeSubmenu(
								(type) => addNode(type, { x: graphX, y: graphY })
							);
							const items = buildCanvasActions(
								{ selectedCount: liteGraphRef.current?.getSelectedNodes().length ?? 0, canPaste, addNodeSubmenu },
								{
									openNodeSearch: () => setCtxMenu({ graphX, graphY, clientX, clientY }),
									paste: () => liteGraphRef.current?.pasteFromClipboard(),
									addGroup: () => liteGraphRef.current?.addGroupAt(graphX, graphY),
																	runWorkflow: handleExecute,
																	resetView: () => liteGraphRef.current?.resetView(),
																	alignSelected: () => liteGraphRef.current?.alignSelected(),
																	// ComfyUI menu layout: convert-to-group / manage-groups
																	// / templates stay disabled (no sub-graph engine yet).
																	convertToGroup: () => liteGraphRef.current?.alignSelected(),
																	manageGroups: () => undefined,
																	saveSelectedAsTemplate: () => undefined,
																	openNodeTemplates: () => undefined,
																},
															);
															setCanvasMenu({ clientX, clientY, title: MENU_TEXT.canvas, items });
						}}
						onGroupContextMenu={(group, graphX, graphY, clientX, clientY) => {
							setCtxMenu(null);
							setNodeMenu(null);
							setLinkMenu(null);
							// Group menu mirrors litegraph group.getMenuOptions:
							// Pin ┄ Title / Color / Font size ┄ Remove.
							setGroupMenu({
								clientX, clientY, title: `Group · ${group.title}`,
								items: buildGroupActions(
									{ pinned: !!group.pinned, title: group.title },
									{
										togglePin: () => { if (group.pinned) { group.unpin(); } else { group.pin(); } setGroupMenu(null); },
										editTitle: () => { setGroupEditTarget(group); setGroupEditFocus('title'); setGroupMenu(null); },
										editFont: () => { setGroupEditTarget(group); setGroupEditFocus('font'); setGroupMenu(null); },
										setColor: (color) => { group.color = color; setGroupMenu(null); },
										remove: () => { liteGraphRef.current?.removeGroup(group); setGroupMenu(null); },
									},
								),
							});
						}}
						onLinkContextMenu={(link, graphX, graphY, clientX, clientY) => {
							setCtxMenu(null);
							setNodeMenu(null);
							setGroupMenu(null);
							setLinkMenu({
								clientX, clientY, title: MENU_TEXT.link,
								items: [{
									id: 'disconnectLink', label: MENU_TEXT.disconnectLink, icon: '✂', danger: true,
									onPick: () => { liteGraphRef.current?.removeLink(link.id); setLinkMenu(null); },
								}],
							});
						}}
						onNodeContextMenu={(node, graphX, graphY, clientX, clientY) => {
							setCtxMenu(null);
							setGroupMenu(null);
							setLinkMenu(null);
							const spec = getNodeSpec(node.type);
							const kind = spec?.kind === 'schema' ? 'schema'
								: spec?.kind === 'native' ? 'native' : 'legacy';
							const ctx: NodeActionsContext = {
								type: node.type,
								title: node.title || node.type,
								kind,
								pinned: !!node.flags?.pin,
								collapsed: !!node.collapsed,
								canRun: kind === 'schema',
							};
							const sarosId = String((node.properties as Record<string, unknown> | undefined)?.['__sarosId'] ?? node.id);
							const nodeType = node.type;
							const openEditor = () => {
								const uidOf = (id: string) => liteGraphRef.current?.stageUidOf(id) ?? id;
								const upstreams = edges.filter(e => e.target === sarosId).map(e => uidOf(e.source));
								const data = (node.properties as Record<string, unknown> | undefined)?.['__data'] as Record<string, unknown> | undefined;
								setEditingNode({ nodeId: sarosId, nodeType, snapshotKey: uidOf(sarosId), upstreams, data });
							};
							// 内联重命名：在节点标题栏位置显示 <input>（对齐 ComfyUI/ComfyTV 的 Rename 行为）。
							// 通过 canvas.convertOffsetToCanvas 将节点原点（标题栏左上角）映射到画布像素坐标。
							const startInlineRename = () => {
								const canvas = liteGraphRef.current?.canvasInstance();
								if (!canvas) return;
								// 标题栏在 node.pos[1] 上方（LiteGraph 0.17 坐标系），convertOffsetToCanvas → 画布内像素坐标
								const [sx, sy] = canvas.convertOffsetToCanvas?.(node.pos) ?? [0, 0];
								setRenamingNode({ node, screenX: sx, screenY: sy });
							};
							const items = buildNodeActions(ctx, {
								run: () => { void runSingleSchemaNode(sarosId, nodeType); },
								editTitle: startInlineRename,
								toggleCollapse: () => { if (node.collapsed) { node.expand(); } else { node.collapse(); } },
								togglePin: () => { if (node.flags?.pin) { node.unpin(); } else { node.pin(); } },
								clone: () => { liteGraphRef.current?.cloneNode(node.id); },
								setColor: (color, bgcolor) => {
							// 对齐 LiteGraph LGraphNode.setColorOption：同时设置前景色和背景色
							if (!color) {
								delete node.color;
								delete node.bgcolor;
							} else {
								node.color = color;
								if (bgcolor) { node.bgcolor = bgcolor; }
							}
							node.setDirtyCanvas?.(true, true);
						},
								openProperties: openEditor,
								remove: () => { node.remove(); },
							});
							// Right-click on a connected port → prepend "disconnect".
							const slotHit = node.getSlotInPosition?.(graphX, graphY) as { input?: boolean; slot?: number } | undefined;
							if (slotHit && typeof slotHit.slot === 'number') {
								const idx = slotHit.slot;
								const inputSlots = node.inputs as Array<{ link?: number }> | undefined;
								const outputSlots = node.outputs as Array<{ links?: number[] }> | undefined;
								if (slotHit.input) {
									const linkId = inputSlots?.[idx]?.link;
									if (linkId) {
										items.unshift(
											buildPortDisconnectAction({ input: true, slot: idx, links: [linkId] },
												() => liteGraphRef.current?.removeLink(linkId)),
											{ id: 'sepPort', separator: true, label: '', onPick: () => undefined },
										);
									}
								} else {
									const links = outputSlots?.[idx]?.links ?? [];
									if (links.length > 0) {
										items.unshift(
											buildPortDisconnectAction({ input: false, slot: idx, links },
												() => { for (const l of links) { liteGraphRef.current?.removeLink(l); } }),
											{ id: 'sepPort', separator: true, label: '', onPick: () => undefined },
										);
									}
								}
							}
							setNodeMenu({ clientX, clientY, title: ctx.title, items });
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
								onClick={(e) => {
									const target = e.target as HTMLElement;
									if (!target.closest('[data-saros-menu]')) {
										setCtxMenu(null);
									}
								}}
								onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}
							/>
						<NodeContextMenu
							menu={ctxMenu}
							onPick={() => setCtxMenu(null)}
							onClose={() => setCtxMenu(null)}
						/>
					</>
				)}
				{/* Actions menus (node / canvas / link / group) — one shared overlay */}
				{(nodeMenu || canvasMenu || linkMenu || groupMenu) && (
					<>
						<div
							style={{ position: 'fixed', inset: 0, zIndex: 99, background: 'transparent' }}
							onClick={(e) => {
								// Only close when clicking outside the menu itself.
								// Without this guard the backdrop swallows every click
								// (including on menu items at zIndex 100) → buttons appear dead.
								const target = e.target as HTMLElement;
								if (!target.closest('[role="menu"]')) {
									setNodeMenu(null); setCanvasMenu(null); setLinkMenu(null); setGroupMenu(null);
								}
							}}
							onContextMenu={(e) => { e.preventDefault(); setNodeMenu(null); setCanvasMenu(null); setLinkMenu(null); setGroupMenu(null); }}
						/>
						{nodeMenu && <NodeActionsMenu menu={nodeMenu} onClose={() => setNodeMenu(null)} />}
						{canvasMenu && <NodeActionsMenu menu={canvasMenu} onClose={() => setCanvasMenu(null)} />}
						{linkMenu && <NodeActionsMenu menu={linkMenu} onClose={() => setLinkMenu(null)} />}
						{groupMenu && <NodeActionsMenu menu={groupMenu} onClose={() => setGroupMenu(null)} />}
					</>
				)}
				{groupEditTarget && (
					<GroupEditPopup
						group={groupEditTarget}
						initialFocus={groupEditFocus}
						onSave={(edit) => {
							applyGroupEdit(groupEditTarget, edit);
							setGroupEditTarget(null);
						}}
						onClose={() => setGroupEditTarget(null)}
					/>
				)}
				{/* 节点编辑器浮层：双击节点 → 输入提示词 → 生成出图 */}
					{editingNode && liteGraphRef.current?.snapshotStore() && (
						<NodeEditorPopup
							nodeId={editingNode.nodeId}
							nodeType={editingNode.nodeType}
							snapshotKey={editingNode.snapshotKey}
							runners={comfyRegistryRef.current!}
							store={liteGraphRef.current.snapshotStore()!}
							cardStateStore={liteGraphRef.current.cardStateStore()}
							preference={runnerPreference}
							initialData={editingNode.data}
							upstreams={editingNode.upstreams}
							onValuesCommit={(id, values) => {
						comfyRunValuesRef.current[id] = values;
						// Saros (react) nodes persist their parameters into node.data.
						const spec = getNodeSpec(editingNode.nodeType);
						if (spec?.kind === 'react') {
							useWorkflowEditorStore.getState().updateNodeData(id, values);
						}
					}}
							onClose={() => setEditingNode(null)}
							onSelectRunner={() => setShowRunners(true)}
							/>
							)}

				{/* 内联重命名输入：右键 Rename → 在节点标题栏位置显示 <input> */}
				{renamingNode && (
					<input
						ref={renameInputRef}
						defaultValue={renamingNode.node.title ?? ''}
						autoFocus
						style={{
							position: 'absolute',
							left: renamingNode.screenX,
							top: renamingNode.screenY,
							minWidth: '120px',
							width: `${Math.max(120, (renamingNode.node.size?.[0] ?? 200) * (liteGraphRef.current?.canvasInstance()?.ds.scale ?? 1))}px`,
							height: '22px',
							border: '1px solid var(--vscode-focusBorder)',
							borderRadius: '2px',
							backgroundColor: 'var(--vscode-input-background)',
							color: 'var(--vscode-foreground)',
							fontSize: '12px',
							fontFamily: 'var(--vscode-font-family, system-ui, sans-serif)',
							padding: '0 6px',
							outline: 'none',
							boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
							zIndex: 100000,
						}}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								const val = (e.target as HTMLInputElement).value.trim();
								if (val) { renamingNode.node.title = val; renamingNode.node.setDirtyCanvas?.(true, true); }
								setRenamingNode(null);
							} else if (e.key === 'Escape') {
								setRenamingNode(null);
							}
						}}
						onBlur={() => setRenamingNode(null)}
					/>
				)}

							{/* 媒体库（生成图片管理 P1）：按当前 workflow 过滤 + 全库 */}
					{showMediaLibrary && (
						<MediaGallery
							workflowId={workflowId}
							onClose={() => setShowMediaLibrary(false)}
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

			{/* 右上角：依赖引导 + 任务进度面板（安装 / 下载 / 出图），参考 ComfyUI Queue */}
			<div style={{ position: 'absolute', top: 12, right: 12, zIndex: 40, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
				<DependencyGuide />
				<TaskProgressPanel />
			</div>
			</div>
		</div>
		{/* P2: 插件管理面板 */}
		{showPluginManager && (
			<PluginManagerPanel onClose={() => setShowPluginManager(false)} />
		)}
	</>
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

/**
 * Apply an Agent-driven canvas ops batch to the workflow editor store.
 * Pure (DOM-free) so it is unit-testable:
 *  - `__generate_flow__` ops are expanded via buildGenerateFlow.
 *  - all other ops run through applyCanvasOps atomically.
 * Returns the result shape mirrored in host-side canvasOpsBridge.ts.
 */
export interface CanvasOpsCallbacks {
	/** P0: single-step undo of the last applied batch (zundo temporal). */
	undo?: () => void;
	redo?: () => void;
}

export function applyCanvasOpsToStore(
	state: {
		nodes: WorkflowEditorNode[];
		edges: WorkflowEditorEdge[];
		setNodes: (nodes: WorkflowEditorNode[]) => void;
		setEdges: (edges: WorkflowEditorEdge[]) => void;
	},
	ops: Array<Record<string, unknown>>,
	providers?: ProviderInfo[],
	callbacks: CanvasOpsCallbacks = {},
): {
	model: { nodes: CanvasNode[]; edges: CanvasEdge[] };
	results: Array<{ opIndex: number; summary: string; ids?: string[] }>;
	ok: boolean;
	error?: string;
	failedOpIndex?: number;
	selectedNodeId?: string | null;
} {
	// P0: undo/redo ops are handled directly (zundo temporal), no model mutation.
	const undoOp = ops.find(o => o.op === 'undo');
	if (undoOp) {
		callbacks.undo?.();
		const s = useWorkflowEditorStore.getState();
		return {
			model: { nodes: s.nodes as never, edges: s.edges as never },
			results: [{ opIndex: ops.indexOf(undoOp), summary: '已撤销上一步画布操作' }],
			ok: true,
		};
	}
	const redoOp = ops.find(o => o.op === 'redo');
	if (redoOp) {
		callbacks.redo?.();
		const s = useWorkflowEditorStore.getState();
		return {
			model: { nodes: s.nodes as never, edges: s.edges as never },
			results: [{ opIndex: ops.indexOf(redoOp), summary: '已重做画布操作' }],
			ok: true,
		};
	}
	// Build the current canvas model from the store.
	const model: CanvasModel = {
		nodes: state.nodes.map(n => ({
			id: n.id,
			type: n.type,
			position: n.position,
			data: n.data ?? {},
		})),
		edges: state.edges.map(e => ({
			id: e.id,
			source: e.source,
			target: e.target,
			sourceHandle: e.sourceHandle,
			targetHandle: e.targetHandle,
		})),
	};

	// Expand a __generate_flow__ op (from canvas_generate) into real nodes/edges.
	const generateFlowOps = ops.filter(o => o.op === 'add_node' && o.type === '__generate_flow__');
	if (generateFlowOps.length > 0) {
		const gf = generateFlowOps[0];
		const data = (gf.data ?? {}) as Record<string, unknown>;
		const goal = String(data.goal ?? '');
		const providersList = providers ?? [];
		const flow = buildGenerateFlow(goal, {
			providerId: typeof data.providerId === 'string' ? data.providerId : undefined,
			modelId: typeof data.modelId === 'string' ? data.modelId : undefined,
			providers: providersList,
			negativePrompt: typeof data.negativePrompt === 'string' ? data.negativePrompt : undefined,
			size: typeof data.size === 'string' ? data.size : undefined,
			variants: Array.isArray(data.variants) ? data.variants as Array<{ prompt?: string; label?: string }> : undefined,
			existing: { nodes: model.nodes, edges: model.edges },
		});
		const merged: CanvasModel = { nodes: flow.nodes, edges: flow.edges };
		state.setNodes(merged.nodes as unknown as WorkflowEditorNode[]);
		state.setEdges(merged.edges as unknown as WorkflowEditorEdge[]);
		return {
			model: merged,
			results: [{
				opIndex: 0,
				summary: `已生成画布流程：${flow.entryIds.length} 个图像节点（${flow.promptIds.length} 个提示节点）已创建并连线`,
				ids: [...flow.promptIds, ...flow.entryIds],
			}],
			ok: true,
		};
	}

	// Regular ops: atomic batch via applyCanvasOps.
	const result = applyCanvasOps(model, ops as CanvasOp[]);
	if (result.ok) {
		state.setNodes(result.model.nodes as unknown as WorkflowEditorNode[]);
		state.setEdges(result.model.edges as unknown as WorkflowEditorEdge[]);
	}
	return result;
}

/**
 * Build a canvas context snapshot from the current store + card states.
 * Pure and DOM-free — unit-testable. Card state is optional; without it nodes
 * report 'idle' (the host still gets the node inventory for the Agent).
 */
export function buildCanvasContextSnapshot(
	state: {
		nodes: WorkflowEditorNode[];
		edges: WorkflowEditorEdge[];
		workflowId?: string;
	},
	cardStateStore?: { get(nodeId: string): { runState: string; progress?: number; errorMsg?: string; durationMs?: number } },
): {
	workflowId: string;
	nodes: Array<{ id: string; label: string; type: string; runState: string; errorMsg?: string; durationMs?: number }>;
	edges: Array<{ id: string; source: string; target: string; sourceHandle?: string; targetHandle?: string }>;
	lastOpsSummary: string[];
	updatedAt: string;
} {
	const nodes = state.nodes.map(n => {
		const cs = cardStateStore?.get(n.id);
		return {
			id: n.id,
			label: typeof n.data?.label === 'string' && n.data.label ? n.data.label : n.id,
			type: n.type,
			runState: cs?.runState ?? 'idle',
			...(cs?.errorMsg ? { errorMsg: cs.errorMsg } : {}),
			...(cs?.durationMs != null ? { durationMs: cs.durationMs } : {}),
		};
	});
	return {
		workflowId: state.workflowId ?? 'default',
		nodes,
		edges: state.edges.map(e => ({
			id: e.id,
			source: e.source,
			target: e.target,
			...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
			...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
		})),
		lastOpsSummary: [],
		updatedAt: new Date().toISOString(),
	};
}

export default WorkflowEditorPanel;
