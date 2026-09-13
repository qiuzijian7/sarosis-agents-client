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

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import type { LGraphNode, LLink, LGraphGroup, Point } from '@comfyorg/litegraph';
import { LiteGraphCanvas, type LiteGraphCanvasHandle } from './LiteGraphCanvas';
import { NodeContextMenu, type NodeContextMenuState, buildAddNodeSubmenu } from './NodeContextMenu';
import { NodeActionsMenu, type NodeActionsMenuState } from './NodeActionsMenu';
import { buildNodeActions, buildCanvasActions, buildGroupActions, buildPortDisconnectAction, buildLinkActions, MENU_TEXT, type NodeActionsContext } from './menuItems';
import { GroupEditPopup, applyGroupEdit } from './groupMenu';
import { RunnerManagerPanel } from './RunnerManagerPanel';
import { NodeEditorPopup } from './NodeEditorPopup';
import { MindMapPanel } from '../mindmap/MindMapPanel';

import { setActiveRunnerRegistry, setActiveRunnerPreference } from './comfyHost/runnerContext';
import { MediaGallery } from './MediaGallery';
import { ComfyRunnerRegistry, createDefaultLocalRunner, collectRunnerRows } from './comfyHost/comfyRunner';
import { guiToApi, stripSarosNodesForExport } from './comfyHost/comfyApiAdapter';
import { registerDefaultComfyTVStages, getNodeSpec } from './comfyHost/registry';
import { getRunnerStatusStore } from './comfyHost/runnerStatusStore';
import { spawnPickerForStage, spawnFollowUp } from './comfyHost/actionSpawn';
import { isComfyExecutableSpec, isExecutableSpec, isPickerNode, isLoaderNode, makeFlowEdgeClassifier, runGraphExecution, runNodeOrStage, resolveFirstImageGenDefaults, resolveMediaAssetUrl, defaultResolveLoadImageRef, type AskUserSendFn, type AskUserPayload } from './comfyHost/workflowRun';
import { buildExecutionPlan, resolveStartScope } from './comfyHost/executionGraph';
import { exportCanvasToWorkflowScript } from './comfyHost/canvasExport';
import { registerStageRunner, unregisterStageRunner, registerDirectStageRunner, unregisterDirectStageRunner, materializeSnapshotEntry, activeStore, type DirectStageRunResult } from './comfyHost/workflowSnapshotBridgeWebview';
import { applyCanvasOps, buildPickerSelectionPatch, type CanvasModel, type CanvasNode, type CanvasEdge, type CanvasOp } from './comfyHost/canvasOps';
// ★ 池顺序对齐（2026-09-12）：ref→池序号映射必须与卡片网格/物化同用 mergeImagePool。
import { mergeImagePool, type MediaSnapshotEntry } from './comfyHost/mediaSnapshot';
import { buildGenerateFlow } from './comfyHost/generateFlow';
import { computeDagLayout } from './comfyHost/dagLayout';
import { buildSubflowFromGraph } from './comfyHost/subflow';
import { PluginManagerPanel } from './PluginManagerPanel';
import { TaskProgressPanel } from './TaskProgressPanel';
import { DependencyGuide } from './DependencyGuide';
import { getTaskStore } from './comfyHost/taskStore';
import { formatProgressPct } from './comfyHost/progressFormat';
import { runReversePrompt } from './comfyHost/reversePromptRun';
import { loadObjectInfoNodes } from './comfyHost/comfyObjectInfoLoader';
import { useWorkflowEditorStore, undo as doUndo, redo as doRedo, pauseTracking, resumeTracking, type WorkflowEditorNode, type WorkflowEditorEdge } from './store';
import { sendRequest, createComfyFetch } from '../../bridge/messageClient';
import { useAgentStore } from '../../store/useAgentStore';
import { usePicklistStore } from './picklistStore';
import { collectWriteStepIds } from './comfyHost/writeStepIds';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useProviderStore, type ProviderInfo } from '../../store/useProviderStore';
import type { IStoredWorkflow } from '../../types/workflowStorage';

/**
 * ★ 编排节点集合（脚本域原生表达）。这些节点只有「直接执行」脚本路径才完整
 * 支持——全图 Comfy Run（handleExecute）只跑 Comfy/Provider 节点，会**静默跳过**
 * 它们（这就是「运行工作流没从 start 开始 / prompt 参数没生效」的根因）。
 * 工具栏「▶ 运行」据此智能路由：含编排节点 → 脚本执行；纯 Comfy → 全图 Run。
 * 不含 Saros.ModelImageGen/ProviderPicker（Provider 执行节点，全图 Run 能跑）。
 */
const ORCHESTRATION_NODE_TYPES = new Set<string>([
	'Saros.Start', 'Saros.End', 'Saros.Task', 'Saros.Prompt', 'Saros.Agent',
	'Saros.Skill', 'Saros.Tool', 'Saros.IfElse', 'Saros.Switch', 'Saros.AskUser',
	'Saros.Group', 'Saros.Subflow',
]);

/**
 * 模块级节点运行 AbortController 映射。
 *
 * runSingleSchemaNode 启动时存入（nodeId → controller），完成/失败/取消时清除。
 * nodeCard 的「取消」按钮 dispatch `wf-node-abort` 事件 → LiteGraphCanvas 调用
 * abortNodeRun(nodeId) → controller.abort() → ComfyUI 轮询检测 signal.aborted 停止。
 */
const _nodeAbortMap = new Map<string, AbortController>();
/** 中止指定节点的当前运行（由 LiteGraphCanvas 的 wf-node-abort 监听器调用）。 */
export function abortNodeRun(nodeId: string): boolean {
	const ctrl = _nodeAbortMap.get(nodeId);
	if (!ctrl) { return false; }
	ctrl.abort();
	_nodeAbortMap.delete(nodeId);
	return true;
}

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
	// M4c 直接执行：绕过 LLM 决策，确定性触发 workflow 引擎（结果展示在代码视图结果区）
	const [execScriptResult, setExecScriptResult] = useState<{ status: 'idle' | 'running' | 'done' | 'error'; value?: unknown; agentsStarted?: number; projectionText?: string; error?: string }>({ status: 'idle' });

	// 方案A：webview 直连优先（ComfyUI 需 --enable-cors-header），失败自动降级
	// 主进程代理——createComfyFetch 按 origin 探测 CORS 后路由，无需手工干预。
	const comfyFetchRef = useRef<typeof fetch | null>(null);
	if (!comfyFetchRef.current) {
		comfyFetchRef.current = createComfyFetch('http://127.0.0.1:8188');
	}

	// Canvas engine: LiteGraph (ComfyUI 底层框架) — ReactFlow 已移除，唯一引擎
	const [showRunners, setShowRunners] = useState(false);
	const [showMediaLibrary, setShowMediaLibrary] = useState(false);
	// 点击 Runner 面板外部 → 自动关闭（面板容器 + 开关按钮两个 ref，点击开关按钮本身不触发关闭）
	const runnerPanelRef = useRef<HTMLDivElement>(null);
	const runnerBtnRef = useRef<HTMLButtonElement>(null);
	const comfyRegistryRef = useRef<InstanceType<typeof ComfyRunnerRegistry> | null>(null);
	if (!comfyRegistryRef.current) {
		comfyRegistryRef.current = new ComfyRunnerRegistry();
	}
	// ★ 点击 ComfyUI Runners 面板外部 → 自动关闭（对齐下拉菜单/浮层交互惯例）。
	// 用 pointerdown（比 click 更早触发，也覆盖触屏）；面板内或开关按钮内点击不关闭。
	React.useEffect(() => {
		if (!showRunners) { return; }
		const onPointerDown = (ev: PointerEvent) => {
			const target = ev.target as Node | null;
			if (!target) { return; }
			if (runnerPanelRef.current?.contains(target)) { return; }
			if (runnerBtnRef.current?.contains(target)) { return; }
			setShowRunners(false);
		};
		// ★ capture 阶段：LiteGraph 画布/节点 DOM 层的 pointerdown 会被
		//   stopPropagation（dragPointerDown 平移/中点菜单分支），bubble 阶段
		//   监听收不到 → 点击画布空白/节点 UI 不关闭。capture 阶段在事件到达
		//   LiteGraph 之前先触发，必定能收到。
		document.addEventListener('pointerdown', onPointerDown, true);
		return () => document.removeEventListener('pointerdown', onPointerDown, true);
	}, [showRunners]);
	// 节点编辑器浮层：双击画布节点 → 打开（输入提示词 → 生成出图）
	// snapshotKey = stageUid（快照归档键）；upstreams 也是归档键（弹窗只用它们
	// 做 store.byNode 查询），二者都由画布层的 stageUidOf 解析。
	const [editingNode, setEditingNode] = useState<{ nodeId: string; nodeType: string; snapshotKey?: string; upstreams: string[]; data?: Record<string, unknown> } | null>(null);
	// 内联重命名：右键 Rename → 在节点标题栏位置显示 <input>（对齐 ComfyUI/ComfyTV 行为）。
	// { node } 引用保持有效：rename 期间用户不会删除该节点（菜单已关闭、canvas 无操作）。
	const [renamingNode, setRenamingNode] = useState<{ node: LGraphNode; screenX: number; screenY: number } | null>(null);
	const renameInputRef = useRef<HTMLInputElement>(null);
	const [runnerPreference, setRunnerPreference] = useState('auto');

	// ★ 工作流 Session（2026-09-11 用户需求）：画布内切换入口 —— 不同 session 隔离
	//   生成内容（快照库作用域），切换即刷新画布卡片；列表来自 host（sessions.json）。
	//   注：切换 handler 定义在 `workflowId` 声明之后（下方），避免 TDZ。
	const [wfSessions, setWfSessions] = useState<Array<{ id: string; name: string; runCount?: number }>>([]);
	const [activeWfSession, setActiveWfSession] = useState<string>('default');

	// 全局 runner 单例：NodeCard 内嵌编辑器（MaskPainter「应用 mask」上传）读此上下文，
	// 无需跨 LiteGraphCanvas → createNodeCard → NodeCard 三层传 prop。
	useEffect(() => {
		setActiveRunnerRegistry(comfyRegistryRef.current);
		return () => setActiveRunnerRegistry(null);
	}, []);
	useEffect(() => {
		setActiveRunnerPreference(runnerPreference);
	}, [runnerPreference]);

	// ★ 打开画布 → 拉取该工作流的 session 列表（见下方 workflowId 声明之后）。

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

	/**
	 * 本地文件导入工作流（2026-09-11 缺口补齐）。
	 *
	 * 与 `handleComfyImportFile` 的**本质区别**：后者把 ComfyUI 画布 JSON 导进
	 * **当前画布**（不新建工作流、不进列表）；本项把工作流 JSON 导入为**新的
	 * 工作流实体**（落盘 + 出现在左侧列表）。webview 无法访问宿主文件系统 →
	 * host 侧弹原生对话框（`workflow.importFile`）。
	 */
	const handleImportWorkflowFile = useCallback(async () => {
		setValidationMsg('⏳ 请选择工作流 JSON 文件…');
		try {
			const r = await sendRequest('workflow.importFile', {}, 120_000) as {
				ok: boolean; workflowId?: string; name?: string; warnings?: string[];
				cancelled?: boolean; error?: string;
			};
			if (r?.cancelled) { setValidationMsg(null); return; }
			if (r?.ok) {
				const warn = r.warnings?.length ? `（${r.warnings.length} 条提示：${r.warnings[0]}）` : '';
				setValidationMsg(`✓ 已导入「${r.name ?? ''}」${warn} · 可在左侧工作流列表打开`);
			} else {
				setValidationMsg(`导入失败：${r?.error ?? '未知错误'}`);
			}
		} catch (err) {
			setValidationMsg(`导入失败：${err instanceof Error ? err.message : String(err)}`);
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

	/**
	 * 导出为**工作流 JSON 文件**（2026-09-11 闭环补齐 —— `handleImportWorkflowFile` 的逆操作）。
	 *
	 * 为什么需要：此前导出侧只有两项，都不产出「可再导入的工作流」——
	 *  `handleComfyExport` 剔除全部编排节点（产物只对 ComfyUI 有意义）、
	 *  「直接执行」根本不产出文件。于是同事间分享 / 备份 / 换机迁移全部断链：
	 *  拿到了文件也导不回来（导入侧只认工作流 JSON）。
	 *
	 * 数据来源（两处合并，各取所长）：
	 *  - **画布最新态** ← `store.toWorkflowData()`（webview 是画布编辑真源，含尚未
	 *    保存的编辑）；
	 *  - **元信息** ← `__AGENT_STUDIO_INITIAL_DATA__.workflow`（完整 `IStoredWorkflow`：
	 *    version / category / tags / useGuide / author 等，画布侧不编辑这些字段）。
	 *
	 * ★ 产出形状 = `IStoredWorkflow` 序列化 → 与 `parseWorkflowImportFile` 的识别字段
	 * （name / id / nodes / steps / connections）**完全同构**，即「导出即导入的逆操作」。
	 * 该契约由 `test/browser/workflowFileImport.test.ts` 的 round-trip 用例锁定——
	 * 改动本函数或导入侧时，两侧任一处漂移都会被测试抓住。
	 */
	const handleWorkflowExport = useCallback(() => {
		const state = useWorkflowEditorStore.getState();
		const { nodes, connections } = state.toWorkflowData();
		if (nodes.length === 0) { setComfyImportMsg('画布为空，无可导出内容'); return; }
		const base = ((window as unknown as Record<string, unknown>).__AGENT_STUDIO_INITIAL_DATA__ as
			{ type?: string; workflow?: IStoredWorkflow } | null | undefined)?.workflow ?? {} as IStoredWorkflow;
		const name = state.workflowName || base.name || '未命名工作流';
		// ★ **白名单**（与 browser 侧 `workflowFileExport.buildWorkflowExportPayload`
		// 同构）：不做整实体展开 —— `workspaceId` / `updatedAt` / `source`（内置标记）
		// 等不应随文件迁移（导入方是另一个工作区，副本也不该继承「内置」身份，
		// 否则列表会显示错误的内置角标）。
		// webview 无法 import browser 侧模块（值 import 零先例）→ 此处内联；
		// 两侧形状一致性由 `workflowFileExport.test.ts` 的 round-trip 用例守护。
		const payload: Record<string, unknown> = {
			id: state.workflowId || base.id,
			name,
			description: state.workflowDescription || base.description || '',
			steps: base.steps ?? [],
			nodes,
			connections,
		};
		if (base.presetId) { payload.presetId = base.presetId; }
		if (base.agentId) { payload.agentId = base.agentId; }
		if (state.workflowBreakpoints.length > 0) { payload.breakpoints = state.workflowBreakpoints; }
		if (base.version) { payload.version = base.version; }
		if (base.category) { payload.category = base.category; }
		if (base.author) { payload.author = base.author; }
		if (base.visibility) { payload.visibility = base.visibility; }
		if (base.tags && base.tags.length > 0) { payload.tags = base.tags; }
		if (base.useGuide) { payload.useGuide = base.useGuide; }
		const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		// 文件名清洗（与 browser 侧 `workflowFileExport.workflowExportFileName`
		// **同规则**）：Windows 非法字符 `\ / : * ? " < > |` → `-`，**再去首尾
		// 连字符**（否则名为 `///` 的工作流会导出成 `---.workflow.json`），空则
		// 回落 workflowId → `workflow`。中文名保留。
		const fileBase = name.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/^-+|-+$/g, '').trim()
			|| (state.workflowId || '').trim() || 'workflow';
		a.download = `${fileBase}.workflow.json`;
		a.click();
		URL.revokeObjectURL(url);
		setComfyImportMsg(`已导出工作流 JSON（${nodes.length} 节点 / ${connections.length} 连线）`);
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

	// ★ 工作流 Session 切换（2026-09-11 用户需求）：**必须定义在 workflowId 之后**
	//   （上方声明）—— 此前定义在组件顶部会触发 TDZ「Cannot access 'workflowId'
	//   before initialization」导致整个面板崩溃。切换 = 快照库换作用域（卡片随之
	//   重渲染）+ 通知 host 记录最近使用。
	const handleWfSessionChange = useCallback((sid: string) => {
		if (!sid) { return; }
		setActiveWfSession(sid);
		liteGraphRef.current?.snapshotStore()?.setActiveSession(sid);
		if (workflowId) {
			void sendRequest('workflow.sessions.select', { workflowId, sessionId: sid }).catch(() => { /* best-effort */ });
		}
	}, [workflowId]);

	// ★ 重命名当前会话（2026-09-11 用户需求）：只改显示名 —— 不动 session id
	//   （id 是快照库的隔离 key 前缀 `{sid}::` 与产物目录名，改名会让已有产物失联），
	//   也不动 updatedAt（列表顺序派生自它）。host 返回更新后的完整列表，直接刷新下拉。
	const handleWfSessionRename = useCallback(async () => {
		if (!workflowId || !activeWfSession) { return; }
		const current = wfSessions.find(s => s.id === activeWfSession);
		const input = window.prompt('重命名会话', current?.name ?? activeWfSession);
		if (input === null) { return; }                       // 用户取消
		const name = input.trim();
		if (!name || name === current?.name) { return; }      // 空名/未变化 → 不打扰 host
		try {
			const res = await sendRequest('workflow.sessions.rename', {
				workflowId, sessionId: activeWfSession, name,
			}) as { ok?: boolean; sessions?: Array<{ id: string; name: string; runCount?: number }> };
			if (res?.sessions) { setWfSessions(res.sessions); }
		} catch { /* best-effort：失败时保留旧名 */ }
	}, [workflowId, activeWfSession, wfSessions]);

	// ★ 打开画布 → 拉取该工作流的 session 列表，并把快照库切到默认（最近使用）
	//   session（2026-09-11 用户需求）：画布展示「当前会话」的产物。
	useEffect(() => {
		if (!workflowId) { return; }
		let cancelled = false;
		(async () => {
			try {
				const res = await sendRequest('workflow.sessions.list', { workflowId }) as {
					sessions?: Array<{ id: string; name: string; runCount?: number }>;
					activeSessionId?: string;
				};
				if (cancelled) { return; }
				setWfSessions(res?.sessions ?? []);
				const active = res?.activeSessionId || 'default';
				setActiveWfSession(active);
				liteGraphRef.current?.snapshotStore()?.setActiveSession(active);
			} catch {
				/* 无 session 索引时保持 default（旧行为） */
			}
		})();
		return () => { cancelled = true; };
	}, [workflowId]);
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
			// ★ P2（2026-09-13）：独立 tab 打开时（WorkflowNodeEditorPane 传入
			//   `focusNodeId`），加载完成后自动打开该节点的**全屏编辑器**。
			//   浮层状态在 nodeCard 内部（每张卡片自己的 state），故用 window 事件
			//   通知 —— 与项目既有 `wf-node-*` 事件模式一致，避免把 focusNodeId
			//   层层传进 LiteGraphCanvas → createNodeCard。
			//   派发三次（300/900/1800ms）：画布挂载 + syncOverlay 建卡耗时不定，
			//   早到的派发会被忽略（nodeCard 此时还没监听）；重复派发无害
			//   （已全屏时 setState(true) 是幂等 no-op）。
			const focusNodeId = (initialData as { focusNodeId?: unknown }).focusNodeId;
			if (typeof focusNodeId === 'string' && focusNodeId) {
				for (const delay of [300, 900, 1800]) {
					setTimeout(() => {
						window.dispatchEvent(new CustomEvent('wf-node-fullscreen', { detail: { nodeId: focusNodeId } }));
					}, delay);
				}
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
				// ★ auto-save 不产生 git 版本（版本历史 = 用户有意义的检查点）。
				// 否则执行期间节点微调/updatedAt 时间戳每次变化 → autoCommit 版本爆炸。
				autoSave: true,
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
	const runSingleSchemaNode = useCallback(async (nodeId: string, nodeType: string, stageUid?: string, onProgress?: (progress: number, message?: string) => void, failLoud = false, signal?: AbortSignal) => {
		// eslint-disable-next-line no-console
		console.warn('[runSingleSchemaNode] start ' + JSON.stringify({ nodeId, nodeType, stageUid }));
		const canvas = liteGraphRef.current;
		// Provider 后端节点（ModelImageGen）经 imagegen.generate RPC 执行，
		// 不需要 ComfyUI runner；只有 Comfy 后端节点才要求 runner 在线。
		const spec = getNodeSpec(nodeType);
		// ★ 渠道感知的 runner 判定（2026-09-04）：
		//   - Saros.AnimatedEmoji：注册为 backendKind='provider'，但 values.backend===
		//     'comfyui' 时走 ComfyUI 视频工作流 → 需要 runner（否则 resolveImageRef
		//     读 runner.baseUrl 崩溃）。
		//   - ComfyTV.StatEmojiStage / DynEmojiStage：**无 backendKind**（调度恒认为
		//     需要 runner），但其 values.backend==='provider' 时纯走 RPC → 不需要
		//     runner——否则 ComfyUI 未启动时 provider 渠道被探测卡死（渠道互锁）。
		const nodeDataEarly = (useWorkflowEditorStore.getState().nodes.find(n => n.id === nodeId)?.data ?? {}) as Record<string, unknown>;
		const wantsComfyui = nodeDataEarly.backend === 'comfyui';
		const wantsProvider = nodeDataEarly.backend === 'provider';
		const isEmojiStage = nodeType === 'ComfyTV.StatEmojiStage' || nodeType === 'ComfyTV.DynEmojiStage';
		const isProviderNode = wantsComfyui ? false
			: wantsProvider && isEmojiStage ? true
				: (spec?.backendKind === 'provider' || spec?.kind === 'llm');
		const runner = isProviderNode ? undefined : comfyRegistryRef.current?.resolve(runnerPreference);
		if (!canvas || (!isProviderNode && !runner)) {
			// eslint-disable-next-line no-console
			console.warn('[runSingleSchemaNode] no canvas/runner ' + JSON.stringify({ hasCanvas: !!canvas, isProviderNode, hasRunner: !!runner }));
			const msg = isProviderNode ? '未连接可用的 Provider' : '未连接可用的 ComfyUI Runner';
			setComfyRunState('failed');
			setComfyRunMsg(msg);
			// ★ failLoud：stage() 桥必须拿到明确错误快速失败（否则上游拿到 undefined
			//   后走「无输出快照」的模糊错误）；卡片 ▶ 按钮保持静默（UI 状态已反映）。
			if (failLoud) { throw new Error(`stage(): ${msg}`); }
			return;
		}
		const store = canvas.snapshotStore();
		if (!store) {
			// eslint-disable-next-line no-console
			console.warn('[runSingleSchemaNode] no snapshotStore');
			if (failLoud) { throw new Error('stage(): 快照库不可用'); }
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
				if (failLoud) { throw new Error(`stage(): 无法连接 ComfyUI 引擎（${detail}）`); }
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
		// 入边表（含 sourceHandle）：多输出口节点（如静态表情包 images/image）的
		// 下游按源端口区分消费语义（转动态表情包：image 口=仅图集；images 口=独立格）。
		const inbound = state.edges
			.filter(e => e.target === nodeId)
			.map(e => ({
				source: canvas.stageUidOf(e.source) ?? e.source,
				targetHandle: e.targetHandle ?? undefined,
				sourceHandle: e.sourceHandle ?? undefined,
			}));
		// ★ 立即置 running（2026-09-02）：必须在 loader 预物化**之前**——预物化的
		//   resolveMediaAssetUrl 是异步 fetch，放在它后面会让「点击 → 按钮变取消」
		//   间隔数百 ms（拖资产场景更久），用户感觉点了没反应、还会再点（触发防
		//   重复守卫）。先落状态再物化，按钮瞬变「取消」。
		canvas.cardStateStore().set(nodeId, { runState: 'running', progress: 0 });
		// ★ 上游 loader 预物化（2026-09-02）：LoadImage 等 no-Run loader 语义是
		//   「选图即用」（对齐 ComfyUI LoadImage 直觉），但快照只有**运行 loader
		//   节点**才写入 store —— 用户连上 loader 直接跑下游 → 下游
		//   collectUpstreamRefs 拿不到图（表情包参考图丢失根因）。这里在运行前
		//   把直接上游 loader 的选值（mediaAssetId / properties.image / directRef）
		//   物化成快照；已有快照（运行过）则跳过。对所有消费 loader 的节点通用。
		for (const upId of upstreams) {
			const upNode = state.nodes.find(n => n.id === upId);
			const upType = String(upNode?.type ?? '');
			if (!isLoaderNode(upType)) { continue; }
			const upUid = canvas.stageUidOf(upId) ?? upId;
			if (!store || store.byNode(upUid).length > 0) { continue; }
			const upValues = (upNode?.data ?? {}) as Record<string, unknown>;
			const mediaAssetId = typeof upValues.mediaAssetId === 'string' ? upValues.mediaAssetId : '';
			const kind: 'image' | 'video' | 'audio' | 'text' = upType.includes('Video') ? 'video'
				: upType.includes('Audio') ? 'audio'
				: upType.includes('Text') ? 'text' : 'image';
			let ref = '';
			if (mediaAssetId) {
				ref = (await resolveMediaAssetUrl(mediaAssetId)) ?? '';
			}
			if (!ref && kind === 'text' && typeof upValues.text === 'string' && upValues.text) {
				ref = upValues.text;
			}
			if (!ref && typeof upValues.image === 'string' && upValues.image) { ref = upValues.image; }
			if (!ref && typeof upValues.directRef === 'string' && upValues.directRef) { ref = upValues.directRef; }
			if (!ref) { continue; }
			store.put(
				{ nodeId: upUid, port: 'output', key: `${upUid}:output:0`, media: { kind, ref }, index: 0 },
				true /* skipImport */,
			);
			// eslint-disable-next-line no-console
			console.warn(`[runSingleSchemaNode] loader pre-materialized ${upType} → ${upUid} (${kind})`);
		}
		// 归档键：onNodeRun 已带 stageUid；右键菜单 Run 没有 → 从画布补齐。
		const snapKey = stageUid ?? canvas.stageUidOf(nodeId) ?? nodeId;
		// ★ 防重复运行 + 立即置 running + AbortController 占位（2026-09-02）：
		//   三件事必须在**预物化 await 之前**——否则（a）await 期间二次点击可穿过
		//   守卫启动并发运行；（b）按钮要等 resolveMediaAssetUrl fetch 才变「取消」。
		//   此前连点「生成」会启动 N 个并发 runNodeOrStage，各自的 AbortController
		//   在 _nodeAbortMap 同 key 互相覆盖 → 旧 controller 泄漏且不可取消、任务
		//   面板出现多条「进行中」、图像生成费用×N。编辑器内嵌按钮（表情包/动态
		//   表情等）与卡片 ▶ 都经过这里，守卫一处全覆盖。
		//   ★ 守卫还必须在 taskStore.add 之前：被拒的重复运行不得残留任务行。
		if (_nodeAbortMap.has(nodeId)) {
			// eslint-disable-next-line no-console
			console.warn('[runSingleSchemaNode] already running, ignore ' + JSON.stringify({ nodeId, nodeType }));
			canvas.cardStateStore().set(nodeId, { runState: 'running', progress: 0 });
			if (failLoud) { throw new Error('stage(): 节点已在运行中'); }
			return;
		}
		canvas.cardStateStore().set(nodeId, { runState: 'running', progress: 0 });
		// AbortController 占位（守卫与执行共用同一实例；取消/完成时 delete）
		const abortCtrl = new AbortController();
		_nodeAbortMap.set(nodeId, abortCtrl);
		// ★ 外部中止信号联动（2026-09-11）：stage() 直跑被 host 放弃（空闲超时 / 取消）时，
		//   同样中止本地执行 —— 否则画布仍会跑完（僵尸），聊天/脚本却已判失败 ✗。
		if (signal) {
			if (signal.aborted) { abortCtrl.abort(); }
			else { signal.addEventListener('abort', () => abortCtrl.abort(), { once: true }); }
		}
		spawnPickerForStage(nodeId, nodeType);
		setComfyRunState('running');
		setComfyRunMsg(null);
		// 任务进度面板：注册出图任务（单节点），onProgress 实时回填进度。
		// nodeId 关联 → 面板行内「取消」按钮可调 abortNodeRun 中止本任务。
		const taskId = getTaskStore().add('generate', nodeType, { message: '排队中…', nodeId });
		getTaskStore().start(taskId, '提交到 ComfyUI…');
		// eslint-disable-next-line no-console
		console.warn('[runSingleSchemaNode] invoking runNodeOrStage ' + JSON.stringify({ nodeId, nodeType, specKind: spec?.kind, backendKind: spec?.backendKind }));
		let r: Awaited<ReturnType<typeof runNodeOrStage>>;
		try {
			r = await runNodeOrStage({
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
				inbound,
				store,
				signal: abortCtrl.signal,
				onProgress: (p) => {
					const prog = p.progress ?? p.value ?? 50;
					// message（如「AI 抠图模型下载中 12/176MB」）透传到卡片 caption 与任务行。
					const msg = (p as { message?: string }).message;
					canvas.cardStateStore().set(nodeId, { runState: 'running', progress: prog, ...(msg ? { message: msg } : {}) });
					getTaskStore().update(taskId, { progress: prog, message: msg || '生成中…' });
					// ★ stage() 桥进度回推：ComfyUI 生成进度 → host 聊天工具卡。
					//   ★ 兜底文案的百分比必须 `formatProgressPct`（2026-09-12 用户需求
					//     「生成的进度最多显示小数点后2位」）：`value/max*100` 是无限小数，
					//     直接插值会显示成「生成中 45.45454545454546%」✗。
					onProgress?.(prog, msg || `生成中 ${formatProgressPct(prog)}%`);
				},
				// ★ 单节点执行也需注入 imagegen RPC 通道（ModelImageGen 等 provider 后端节点依赖）。
				sendImageGen: (payload) => sendRequest('imagegen.generate', payload, 180_000),
				// 视频 / 3D 生成节点 RPC（Saros.ModelVideoGen / Saros.Model3DGen）。
				// 视频生成耗时长（1-5 分钟），超时放宽到 10 分钟。
				sendVideoGen: (payload) => sendRequest('videogen.generate', payload, 600_000),
				sendModel3DGen: (payload) => sendRequest('modelgen.generate', payload, 600_000),
				// 文本生成节点 RPC（Saros.TextGen）：provider.chat 流式聚合，chat 通常秒级返回
				sendTextGen: (payload) => sendRequest('textgen.generate', payload, 180_000),
				// 音频生成节点 RPC（Saros.AudioGen）：音乐类生成可达数分钟
				sendAudioGen: (payload) => sendRequest('audiogen.generate', payload, 600_000),
			});
		} catch (err) {
			// ★ 任何 executor 内部未捕获异常（如 ReferenceError、RPC reject 未被
			//   executor 自身 catch）都必须落到节点卡片 ErrorBanner，否则「点运行
			//   没反应、UI 无报错」。与下方 r.status!=='success' 分支保持一致。
			_nodeAbortMap.delete(nodeId);
			const errMsg = err instanceof Error ? err.message : String(err);
			setComfyRunState('failed');
			setComfyRunMsg('节点失败（详细原因见卡片）');
			canvas.cardStateStore().set(nodeId, { runState: 'error', progress: 0, errorMsg: errMsg });
			getTaskStore().finish(taskId, false, errMsg);
			if (failLoud) { throw new Error(`stage(): 节点执行失败（${errMsg}）`); }
			return;
		}
		// ★ 运行结束（成功/失败/取消）→ 清理 abort 控制器
		_nodeAbortMap.delete(nodeId);
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
				// ★ failLoud：stage() 桥拿到真实执行失败立即回程（而非等「无输出快照」模糊错误）。
				if (failLoud) { throw new Error(`stage(): 节点执行失败（${r.error ?? '未知错误'}）`); }
			}
			}, [runnerPreference]);

	// ── P0 stage() 桥：脚本域驱动画布媒体节点执行 ─────────────────────────
	// 动态工作流脚本里 `await stage("uid")` → host → 本 runner → runSingleSchemaNode
	// （画布 Run 的同一执行器）→ ComfyUI 真正生成 → 读回快照物化返回。
	// 这打通了「脚本域 ↔ 画布域」割裂：之前媒体节点在导出脚本里只能是 null 占位。
	const runStageForScript = useCallback(async (stageUid: string, overrides?: Record<string, unknown>, onProgress?: (progress: number, message?: string) => void, signal?: AbortSignal): Promise<unknown> => {
		const canvas = liteGraphRef.current;
		if (!canvas) { throw new Error('画布未就绪：stage() 无法执行'); }
		const state = useWorkflowEditorStore.getState();
		// stageUid → nodeId 反查（stageUid 即节点 __sarosId；回退按 nodeId 直配）
		const target = state.nodes.find(n => canvas.stageUidOf(n.id) === stageUid)
			?? state.nodes.find(n => n.id === stageUid);
		if (!target) {
			throw new Error(`stage(): 画布上找不到 uid="${stageUid}" 的节点（请确认脚本里的 uid 与画布一致）`);
		}
		// overrides → 写入节点 values（画布执行读 comfyRunValuesRef + node.data）
		if (overrides && Object.keys(overrides).length > 0) {
			comfyRunValuesRef.current[target.id] = {
				...(comfyRunValuesRef.current[target.id] ?? {}),
				...overrides,
			};
		}
		await runSingleSchemaNode(target.id, target.type, stageUid, onProgress, true /* failLoud：脚本域必须拿到明确失败 */, signal);
		// 执行完读回快照并物化（与 nodeOutput 同构，脚本可统一消费）
		const store = canvas.snapshotStore();
		if (!store) { throw new Error('stage(): 快照库不可用'); }
		const entries = store.byNode(stageUid);
		if (entries.length === 0) {
			throw new Error(`stage(): 节点 "${stageUid}" 执行后无输出快照（可能执行失败，详见画布卡片错误信息）`);
		}
		return materializeSnapshotEntry(entries[entries.length - 1].media);
	}, [runSingleSchemaNode]);

	// 注册 stage runner（与 registerSnapshotSource 同策略：后注册者=活跃画布）
	useEffect(() => {
		const key = workflowId ?? 'default';
		registerStageRunner(key, runStageForScript);
		return () => unregisterStageRunner(key);
	}, [workflowId, runStageForScript]);

	// ── Direct stage run 桥（存储工作流 ComfyStage → 画布，按 stageClass + values 直跑）──
	// 存储工作流 DAG（browser 侧）的 ComfyStage 节点没有画布 stageUid，只有 stageClass
	// （如 `ComfyTV.StatEmojiStage` / `ComfyTV.DynEmojiStage`）。此 runner 按 stageClass
	// 直接调 runNodeOrStage（与 runSingleSchemaNode 同一执行器），把表情包等媒体节点
	// 真正跑起来，并回传
	// outputs + snapshot 媒体引用给 browser → 聊天卡渲染。
	const runStageByClass = useCallback(async (
		stageClass: string,
		values: Record<string, unknown>,
		images: string[] | undefined,
		onProgress: (progress: number, message?: string) => void,
		originNodeId?: string,
		// ★ 上游节点 id（2026-09-11）：传给 runNodeOrStage 供其从快照库取上游快照 ——
		//   逐格图生视频（Saros.AnimatedEmoji）的参考图正是上游 StatEmojiStage 的格子
		//   快照。此前硬编码 upstreams: [] → 报「动态表情包制作需要上游参考图输入」。
		upstreams?: string[],
		// ★ 工作流 session（2026-09-11 用户需求：session 隔离）：据此切换快照库作用域，
		//   不同聊天会话生成的内容互不可见。
		workflowSessionId?: string,
		// ★ 中止信号（2026-09-11）：host 放弃该直跑（空闲超时）时触发 → 透传进
		//   runNodeOrStage 让画布真正停下（执行层早已支持，见 NodeExecutionInput.signal）。
		//   否则「聊天报失败、画布仍在跑并在稍后出图」的僵尸 ✗。
		signal?: AbortSignal,
	): Promise<DirectStageRunResult> => {
		// ★ 等画布 mount（2026-09-10 日志实锤）：direct stage run 重放到达时 webview
		//   已就绪（首条消息），但 LiteGraphCanvas React 组件尚未 mount → liteGraphRef
		//   仍 null。原代码立即抛「画布未打开」→ 节点 fail → cascade skip 下游。
		//   改为短轮询（≤3s，每 100ms），mount 后立即继续，给 React 渲染窗口。
		const canvasWaitDeadline = Date.now() + 3_000;
		let canvas = liteGraphRef.current;
		while (!canvas && Date.now() < canvasWaitDeadline) {
			await new Promise<void>(r => setTimeout(r, 100));
			canvas = liteGraphRef.current;
		}
		if (!canvas) { throw new Error('画布未就绪：ComfyStage 无法执行（mount 超时 3s）'); }
		const store = canvas.snapshotStore();
		if (!store) { throw new Error('ComfyStage：快照库不可用'); }
		// ★ 切换快照库 session 作用域（2026-09-11 用户需求：session 隔离）：
		//   同工作流不同聊天会话 → 不同 session → 归档 key 前缀不同 → 生成内容隔离；
		//   切换后 notify → 画布卡片按新 session 重渲染（只显示本会话产物）。
		if (workflowSessionId) { store.setActiveSession(workflowSessionId); }
		const spec = getNodeSpec(stageClass);
		const isProviderNode = spec?.backendKind === 'provider' || spec?.kind === 'llm';
		// ★ 按需启动 runner（2026-09-10 用户需求）：不依赖 ComfyUI 算力的 stage
		//   不需要 runner 连接——本地 stage（Loader/Picker 家族：读写本地文件、
		//   素材库、拖拽资产）纯本地执行，此前因 spec 默认 backendKind='comfy'
		//   被要求 runner → 未启动 ComfyUI 时整条工作流失败（ImageLoader 实测）。
		const isLocalStage = /(LoaderStage|PickerStage)$/.test(stageClass);
		const needsRunner = !isProviderNode && !isLocalStage;
		const runner = needsRunner ? comfyRegistryRef.current?.resolve(runnerPreference) : undefined;
		if (needsRunner && !runner) {
			throw new Error('未连接可用的 ComfyUI Runner（请先启动 ComfyUI）');
		}
		if (runner) {
			const probe = await runner.testConnection();
			if (!probe.ok) {
				getRunnerStatusStore().setReady(false);
				throw new Error(`无法连接 ComfyUI 引擎（${probe.error ?? '连接失败'}）`);
			}
			getRunnerStatusStore().setReady(true, runner.baseUrl);
		} else {
			console.log(`[DirectStageRun] ${stageClass}: 本地 stage（无需 ComfyUI runner），跳过连接探测`);
		}
		// ★ snapKey 用**原节点 id**（2026-09-10 用户反馈「节点已有默认图片却报未选择」）：
		//   此前用新生成的 `direct-*` 查询必然为空 → 误报「请先在节点弹窗中选择文件」。
		//   originNodeId 由 host 透传（delegate 的 node.id）；缺失时才回退临时 id（旧行为）。
		const nodeId = originNodeId || `direct-${stageClass}-${Date.now().toString(36)}`;
		// ★★ 归档键必须用 **stageUid**（2026-09-11 修 bug：聊天驱动执行时画布不实时刷新）：
		//   画布节点卡按 `stageUid` 读快照（nodeCard 的 snapKey），而此前这里把
		//   `snapshotKey` 直接设成 originNodeId（DAG 节点 id，形如
		//   `ComfyTV.StatEmojiStage-1788782920357-1`）→ 产出写在 nodeId 名下，
		//   卡片按 stageUid 读**永远看不到** → 左侧画布无实时数据（右侧聊天卡正常，
		//   因为聊天卡走 host 侧 executionState）。
		//   ⚠ `store.registerAlias(nodeId, stageUid)` 只解决「按 nodeId 查 → 命中
		//   stageUid 名下」，**不反向**（`nodeKeyPrefixes` = `[nodeId, aliasUid]`），
		//   故**写入必须直接用 stageUid**。
		//   与仓库既有约定一致：runSingleSchemaNode（L770-772）/ NodeEditorPopup /
		//   runPickerNode 均注明「归档键 = stageUid，必须与卡片读侧一致，否则 OUTPUT 不刷新」。
		const snapKey = originNodeId ? (canvas.stageUidOf(originNodeId) ?? originNodeId) : nodeId;
		// 参考图：images[0] 注入 `image` 端口（EmojiStage 参考图绑定消费）。
		const mergedValues: Record<string, unknown> = { ...values };
		if (images && images.length > 0 && !mergedValues['image']) {
			mergedValues['image'] = images[0];
		}
		// ★ 画布节点卡「运行中」实时同步（2026-09-11 用户需求：工作流执行过程中画布
		//   要实时显示生成图像与节点状态）：聊天触发（headless/direct stage run）此前
		//   只更新聊天侧卡片，**画布卡片状态不变**（runState 仅在画布内运行路径写入）。
		//   这里在开跑前置 running，进度/成功/失败分别在 onProgress 与结果分支同步。
		//   生成图本身由 runNodeOrStage 逐格写入 MediaSnapshotStore，nodeCard 经
		//   useSyncExternalStore 订阅 → 缩略图自动实时出现。
		canvas.cardStateStore()?.set(nodeId, { runState: 'running', progress: 0, message: '执行中…' });
		const r = await runNodeOrStage({
			runner: runner as unknown as Parameters<typeof runNodeOrStage>[0]['runner'],
			nodeId,
			snapshotKey: snapKey,
			type: stageClass,
			getSpec: (t) => getNodeSpec(t),
			values: mergedValues,
			// ★ 上游节点 id（2026-09-11）：此前恒为 [] → 依赖上游快照的 stage
			//   （Saros.AnimatedEmoji 逐格图生视频）取不到参考图而报错。
			upstreams: upstreams ?? [],
			store,
			// ★ 中止信号（2026-09-11）：host 空闲超时后请求取消 → 画布立即停止生成。
			signal,
			onProgress: (p) => {
				const prog = p.progress ?? p.value ?? 50;
				// ★ 执行器自带文案优先（2026-09-12 修）：此前恒用「生成中 X%」把
				//   执行器的 message 丢掉 ✗ —— 而 AnimatedEmoji 等执行器发的是
				//   「阶段① 生成视频 · 格 3（3/9）生成中…」，聊天卡片的**阶段链**
				//   正是靠文案里的 `阶段①/②/③` 标记推断「当前跑到哪一阶段」
				//   （见 agentChat/subAgentCardUtils.parseAnimatedEmojiStage）⇒ 丢弃
				//   文案会让阶段链永远推断不出当前阶段 ✗，用户只看到一个没有意义的
				//   百分比。现在：有 message 用 message，无则退回「生成中 X%」。
				//   ★ 百分比必须 `formatProgressPct`（用户需求：最多 2 位小数）。
				const msg = (p as { message?: string }).message;
				onProgress(prog, msg || `生成中 ${formatProgressPct(prog)}%`);
				// ★ 画布节点卡进度实时同步（2026-09-11 用户需求）：聊天触发（headless）
				//   执行时画布卡片此前不刷新，这里把进度写进 CardStateStore。
				canvas.cardStateStore()?.set(nodeId, { runState: 'running', progress: prog, message: msg || `生成中 ${formatProgressPct(prog)}%` });
			},
			// ★ provider RPC 通道注入（2026-09-10 日志实锤）：Saros.AnimatedEmoji /
			//   ModelVideoGen / ModelImageGen / Model3DGen / TextGen / AudioGen 等
			//   **provider 后端节点**依赖这些通道（runAnimatedEmoji 无 sendVideoGen
			//   直接报「Provider 视频生成通道未注入（videogen.generate）」）。画布内
			//   执行路径一直有注入，direct stage run（聊天触发存储工作流）此前漏了 →
			//   同一节点画布能跑、聊天触发必失败。超时与画布路径保持一致。
			sendVideoGen: (payload) => sendRequest('videogen.generate', payload, 600_000),
			sendImageGen: (payload) => sendRequest('imagegen.generate', payload, 180_000),
			sendModel3DGen: (payload) => sendRequest('modelgen.generate', payload, 600_000),
			sendTextGen: (payload) => sendRequest('textgen.generate', payload, 180_000),
			sendAudioGen: (payload) => sendRequest('audiogen.generate', payload, 600_000),
		});
		if (r.status !== 'success') {
			// ★ 画布节点卡失败态（2026-09-11）：聊天触发执行时同步到画布。
			canvas.cardStateStore()?.set(nodeId, { runState: 'error', progress: 0, errorMsg: r.error ?? 'stage 执行失败' });
			return { status: 'error', error: r.error ?? 'stage 执行失败', outputs: {} };
		}
		const entries = store.byNode(nodeId);
		const snapshot: DirectStageRunResult['snapshot'] = entries.map((e) => ({
			port: e.port,
			kind: e.media.kind,
			ref: e.media.ref,
			...(e.media.meta ? { meta: e.media.meta } : {}),
		}));
		const outputs: Record<string, unknown> = {
			images: entries.filter(e => e.media.kind === 'image').map(e => e.media.ref),
			videos: entries.filter(e => e.media.kind === 'video').map(e => e.media.ref),
		};
		// ★ 画布节点卡完成态（2026-09-11）：生成图已由 runNodeOrStage 写入快照库，
		//   nodeCard 经 useSyncExternalStore 订阅 → 缩略图自动实时出现；这里补状态。
		canvas.cardStateStore()?.set(nodeId, { runState: 'success', progress: 100, finishedAt: Date.now() });
		return {
			status: 'success',
			outputs,
			snapshot,
			summary: `已完成 ${entries.length} 个输出`,
		};
	}, [runnerPreference]);

	useEffect(() => {
		const key = workflowId ?? 'default';
		registerDirectStageRunner(key, runStageByClass);
		return () => unregisterDirectStageRunner(key);
	}, [workflowId, runStageByClass]);

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

	// P1: Saros.AskUser 交互弹窗。askUserFn 返回一个 Promise，用户点击选项后
	// resolve（单选=label 字符串，多选=label 数组；**params 模式=键值对象**，跳过=空对象）；
	// 取消/超时 → 弹窗关闭但图执行因 AbortSignal 由 handleCancel 统一中止（或 executor 抛错）。
	const [askUserDialog, setAskUserDialog] = useState<AskUserPayload | null>(null);
	const askUserResolveRef = useRef<((v: string | string[] | Record<string, string>) => void) | null>(null);
	const [askUserSelected, setAskUserSelected] = useState<Set<string>>(new Set());
	// ★ params 动态参数表单的填写值（key → 用户输入）
	const [askUserParamValues, setAskUserParamValues] = useState<Record<string, string>>({});
	const askUserFn: AskUserSendFn = useCallback((payload) => new Promise<string | string[] | Record<string, string>>((resolve) => {
		askUserResolveRef.current = resolve;
		setAskUserSelected(new Set());
		setAskUserParamValues({});
		setAskUserDialog(payload);
	}), []);
	const submitAskUser = useCallback(() => {
		if (!askUserDialog) { return; }
		const sel = [...askUserSelected];
		const resolve = askUserResolveRef.current;
		if (resolve) {
			resolve(askUserDialog.multiSelect ? sel : (sel[0] ?? ''));
		}
		askUserResolveRef.current = null;
		setAskUserDialog(null);
	}, [askUserDialog, askUserSelected]);
	// ★ params 模式提交：键值对象直接反馈（空字段保留空串——下游可判断）
	const submitAskUserParams = useCallback(() => {
		const resolve = askUserResolveRef.current;
		if (resolve) { resolve({ ...askUserParamValues }); }
		askUserResolveRef.current = null;
		setAskUserDialog(null);
	}, [askUserParamValues]);
	const toggleAskUserOption = useCallback((label: string) => {
		setAskUserSelected(prev => {
			const next = new Set(prev);
			if (askUserDialog?.multiSelect) {
				if (next.has(label)) { next.delete(label); } else { next.add(label); }
			} else {
				next.clear();
				next.add(label);
			}
			return next;
		});
	}, [askUserDialog]);

	// W1b: Start 运行时参数面板——运行前若图含 Saros.Start 且 args 非空，弹窗
	// 让用户覆盖默认值；确认返回覆盖对象、取消返回 null（中止本次运行）。
	const [startArgsDialog, setStartArgsDialog] = useState<Array<{ key: string; value: string }> | null>(null);
	const startArgsResolveRef = useRef<((v: Record<string, unknown> | null) => void) | null>(null);
	const promptStartArgs = useCallback((nodes: CanvasNode[]): Promise<Record<string, unknown> | null> => {
		const args: Record<string, unknown> = {};
		for (const n of nodes) {
			if (n.type !== 'Saros.Start') { continue; }
			const raw = (n.data as Record<string, unknown> | undefined)?.args;
			let obj: unknown = raw;
			if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch { continue; } }
			if (obj && typeof obj === 'object' && !Array.isArray(obj)) { Object.assign(args, obj as Record<string, unknown>); }
		}
		const keys = Object.keys(args);
		if (keys.length === 0) { return Promise.resolve({}); }
		return new Promise(resolve => {
			startArgsResolveRef.current = resolve;
			setStartArgsDialog(keys.map(k => {
				const v = args[k];
				return { key: k, value: typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '') };
			}));
		});
	}, []);
	const submitStartArgs = useCallback(() => {
		const resolve = startArgsResolveRef.current;
		if (!resolve || !startArgsDialog) { return; }
		const out: Record<string, unknown> = {};
		for (const row of startArgsDialog) {
			const s = row.value;
			if (s === 'true') { out[row.key] = true; }
			else if (s === 'false') { out[row.key] = false; }
			else if (s !== '' && !Number.isNaN(Number(s))) { out[row.key] = Number(s); }
			else { out[row.key] = s; }
		}
		startArgsResolveRef.current = null;
		setStartArgsDialog(null);
		resolve(out);
	}, [startArgsDialog]);
	const cancelStartArgs = useCallback(() => {
		const resolve = startArgsResolveRef.current;
		startArgsResolveRef.current = null;
		setStartArgsDialog(null);
		resolve?.(null);
	}, []);
	const updateStartArgRow = useCallback((i: number, value: string) => {
		setStartArgsDialog(prev => prev ? prev.map((r, idx) => idx === i ? { ...r, value } : r) : prev);
	}, []);

	// W5b: wrap the currently selected nodes into a Saros.Loop iteration body.
	// 复用 buildSubflowFromGraph（SubflowDefinition 同构）→ data.loopBody；
	// 执行时 runLoopNodeExecutor 逐项跑 body（见 workflowRun.ts）。
	const handleWrapLoop = useCallback((loopType: 'Saros.Loop' | 'Saros.Parallel') => {
		const canvas = liteGraphRef.current;
		if (!canvas) { return; }
		const selected = canvas.getSelectedNodes();
		if (selected.length < 1) { return; }
		const state = useWorkflowEditorStore.getState();
		const loopBody = buildSubflowFromGraph(
			`loop-${Date.now()}`,
			loopType === 'Saros.Loop' ? '循环体' : '并发体',
			selected.map(s => ({ id: s.id, type: s.type, data: s.data })),
			state.edges.map(e => ({ source: e.source, target: e.target })),
		);
		const selectedIds = new Set(selected.map(s => s.id));
		const anchorNode = state.nodes.find(n => n.id === selected[0].id);
		const loopNode: CanvasNode = {
			id: loopBody.id,
			type: loopType,
			position: anchorNode?.position ?? { x: 0, y: 0 },
			data: { label: loopType === 'Saros.Loop' ? '循环' : '并发', loopBody },
		};
		const keptNodes = state.nodes.filter(n => !selectedIds.has(n.id));
		const newEdges = state.edges
			.filter(e => !(selectedIds.has(e.source) && selectedIds.has(e.target)))
			.map(e => {
				if (selectedIds.has(e.source)) { return { ...e, source: loopBody.id }; }
				if (selectedIds.has(e.target)) { return { ...e, target: loopBody.id }; }
				return e;
			});
		pauseTracking();
		try {
			state.setNodes([...keptNodes, loopNode] as never);
			state.setEdges(newEdges as never);
		} finally {
			resumeTracking();
		}
	}, []);

// 共享：把一条连线渲染成 linkMenu（复用 buildLinkActions + NodeActionsMenu）。
// 右键（onLinkContextMenu）与左键点连线中点圆点（onLinkHandleClick，
// 对齐 ComfyUI：hover 连线中点显示圆点 → 左键弹出菜单）都走这里，
// 避免两处各自内联导致 buildLinkActions 漂移成死代码。
const openLinkMenu = useCallback(
	(link: LLink, graphX: number, graphY: number, clientX: number, clientY: number) => {
		setCtxMenu(null);
		setNodeMenu(null);
		setGroupMenu(null);
		setLinkMenu({
			clientX, clientY, title: MENU_TEXT.link,
			items: buildLinkActions(
				{
					linkId: link.id,
					isTyped: !!(link as unknown as { isTyped?: boolean }).isTyped,
					color: (link as unknown as { color?: string }).color || undefined,
					addNodeSubmenu: buildAddNodeSubmenu((type) => addNode(type, { x: graphX, y: graphY })),
				},
				{
					disconnect: () => { liteGraphRef.current?.removeLink(link.id); setLinkMenu(null); },
					delete: () => { liteGraphRef.current?.deleteLink(link.id); setLinkMenu(null); },
					rename: () => {
						const current = (link as unknown as { name?: string; type?: string }).name
							|| (link as unknown as { type?: string }).type || '';
						const next = window.prompt(MENU_TEXT.renameLink, current);
						if (next != null && next !== current) {
							liteGraphRef.current?.renameLink(link.id, next);
						}
						setLinkMenu(null);
					},
					setColor: (color: string) => {
						liteGraphRef.current?.setLinkColor(link.id, color);
						setLinkMenu(null);
					},
					// 本项目连线中点支持 Add Node（搜索式插入）；Add Reroute 暂无图编辑能力 → 菜单项禁用占位。
					openNodeSearch: () => { setLinkMenu(null); setCtxMenu({ graphX, graphY, clientX, clientY }); },
					addReroute: undefined,
				},
			),
		});
	},
	[liteGraphRef, setCtxMenu, setNodeMenu, setGroupMenu, setLinkMenu, buildAddNodeSubmenu, addNode],
);

const handleExecute = useCallback(async () => {
		if (!workflowId) { return; }
		// ── P0: Comfy + Provider 全图执行（画布包含可执行节点时优先）──
		// 可执行 = schema/native（ComfyUI runner）+ llm（imagegen.generate RPC）。
		const state = useWorkflowEditorStore.getState();
		const canvas = liteGraphRef.current;
		// W7: 预检计划必须与 runGraphExecution 用**同一个** Start 作用域裁剪 ——
		// 否则「图里有可执行节点但都不在 Start 作用域内」时，这里判定 steps>0 进入
		// 全图 Run，执行器却一个节点都不跑（静默空转）。
		const startScope = resolveStartScope(state.nodes, state.edges);
		const plan = buildExecutionPlan(state.nodes, state.edges, type => isExecutableSpec(getNodeSpec(type)), startScope.scope, makeFlowEdgeClassifier(state.nodes as never, getNodeSpec));
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
			// W1b: Start 运行时参数面板——图含 Start 且有参数 → 弹窗；取消则中止。
			const startArgsOverride = await promptStartArgs(state.nodes);
			if (startArgsOverride === null) {
				setComfyRunState('idle');
				getTaskStore().finish(taskStoreId, false, '已取消（参数面板）');
				return;
			}
			// P0① 写能力信号 → 同层至多一个写者（写者独占一层，不占并发槽空等）。
			// 能力值来自 host：agents.list / tools.list 的 `writeCapable`（webview 不 import common/）。
			const agents = useAgentStore.getState().agents;
			const toolItems = usePicklistStore.getState().tools;
			const writeStepIds = collectWriteStepIds(state.nodes, {
				agentWriteCapable: (agentId) => agents.find(a => a.id === agentId)?.writeCapable,
				toolWriteCapable: (toolName) => toolItems.find(t => t.id === toolName || t.name === toolName)?.writeCapable,
			});
			const r = await runGraphExecution({
				startArgsOverride,
				writeStepIds,
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
				// 视频 / 3D 生成节点 RPC（Saros.ModelVideoGen / Saros.Model3DGen，超时 10 分钟）
				sendVideoGen: (payload) => sendRequest('videogen.generate', payload, 600_000),
				sendModel3DGen: (payload) => sendRequest('modelgen.generate', payload, 600_000),
				// 文本生成节点 RPC（Saros.TextGen）：provider.chat 流式聚合
				sendTextGen: (payload) => sendRequest('textgen.generate', payload, 180_000),
				// 音频生成节点 RPC（Saros.AudioGen）
				sendAudioGen: (payload) => sendRequest('audiogen.generate', payload, 600_000),
			// M3: Saros.Agent 编排节点 → workflow.runAgentNode（browser 侧 startWorkflowChild 桥）
			runAgentNode: (payload, timeoutMs) => sendRequest('workflow.runAgentNode', payload, timeoutMs ?? 600_000),
			// P1: Saros.AskUser 交互节点 → renderer 侧模态弹窗（暂停图执行等用户选择）
			askUser: askUserFn,
				resolveImageGenDefaults: async () =>
					resolveFirstImageGenDefaults(useProviderStore.getState().providers),
				resolveLoadImageRef: defaultResolveLoadImageRef(runner!, comfyFetchRef.current as never),
				fetchImpl: comfyFetchRef.current as never,
				mode: comfyRunParallel ? 'parallel' : 'serial',
				parallelConcurrency: 4,
				taskId: `run-${Date.now()}`,
			});
			if (r.success) {
				setComfyRunState('done');
				// W7: 入口语义可见化 —— 让用户一眼看出本次是「从 Start 起跑」还是全图，
				// 以及有多少节点因未接入 Start 被排除（否则「少跑了节点」会被当成 bug）。
				const scopeNote = r.startScope?.scoped
					? '从 Start 起'
					: r.startScope?.degraded ? '全图（Start 未接业务节点）' : '全图';
				const outNote = r.outOfScopeIds.length > 0 ? ` · 未接入 Start ${r.outOfScopeIds.length}` : '';
				setComfyRunMsg(`执行完成（${scopeNote}）· ${r.ran.length} 个节点${r.skippedIds.length > 0 ? ` · 跳过 ${r.skippedIds.length}` : ''}${outNote}`);
				getTaskStore().finish(taskStoreId, true, `完成 · ${r.ran.length} 个节点`);
				// W6: 激活路径标绿 / gate 未命中分支置灰
				canvas.markRouteEdges?.(r.ran, r.skippedIds);
			} else if (r.failed) {
				setComfyRunState('failed');
				// Toolbar 仅显示简短摘要；完整错误（ComfyUI 后端 JSON body）已写入节点卡片 ErrorBanner。
				setComfyRunMsg(`执行失败（节点 ${r.failed.nodeId}，详细原因见卡片）`);
				getTaskStore().finish(taskStoreId, false, `节点 ${r.failed.nodeId} 失败`);
				canvas.markRouteEdges?.(r.ran, r.skippedIds);
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

	// M4c: 画布「直接执行」—— 绕过 LLM 决策，确定性触发 workflow 引擎执行导出脚本。
	// 运行过程（子代理卡片/进度/结果）在聊天框以合成 workflow 工具卡展示，由 host 侧
	// fire requestWorkflowDirectRun / workflowDirectRunResult 事件驱动；本侧只发 RPC 并提示状态。
	const handleExecuteScript = useCallback(async () => {
		const state = useWorkflowEditorStore.getState();
		// ★ 读 Start 节点 args（与全图 Run 一致）：图含 Saros.Start 且 args 非空时
		// 弹参数面板让用户覆盖，确认后作为 workflow args 注入脚本（脚本内 args.key
		// 引用）；取消则中止。此前 `args: {}` 硬编码 → Start 的 prompt 参数「没生效」。
		const startArgs = await promptStartArgs(state.nodes as never);
		if (startArgs === null) {
			setValidationMsg('已取消（参数面板）');
			return;
		}
		let gen;
		try {
			gen = exportCanvasToWorkflowScript({
				nodes: state.nodes as never,
				edges: state.edges as never,
				getNodeValue: (id: string) => {
					const node = state.nodes.find(n => n.id === id);
					const data = (node?.data ?? {}) as Record<string, unknown>;
					return { ...data, ...(comfyRunValuesRef.current[id] ?? {}) } as Record<string, unknown>;
				},
				// P0：媒体节点导出为 await stage("uid") —— 真正驱动 ComfyUI 生成
				getStageUid: (id: string) => liteGraphRef.current?.stageUidOf(id),
				workflowName: state.workflowName,
			});
		} catch (err) {
			setValidationMsg(`脚本生成失败：${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		if (!gen.script) {
			setValidationMsg('导出脚本为空（无可执行的编排节点）');
			return;
		}
		setExecScriptResult({ status: 'running' });
		setValidationMsg('⏳ 正在执行动态工作流（运行过程见聊天框工具卡片）…');
		try {
			const res = await sendRequest('workflow.executeScript', {
				meta: gen.meta,
				script: gen.script,
				args: startArgs,
			}, 0) as { ok: boolean; value?: unknown; agentsStarted?: number; projectionText?: string; error?: string };
			if (res?.ok) {
				setExecScriptResult({ status: 'done', value: res.value, agentsStarted: res.agentsStarted, projectionText: res.projectionText });
				setValidationMsg(`✓ 执行完成（${res.agentsStarted ?? 0} agents）`);
			} else {
				setExecScriptResult({ status: 'error', error: res?.error });
				setValidationMsg(`执行失败：${res?.error ?? '未知错误'}`);
			}
		} catch (err) {
			setExecScriptResult({ status: 'error', error: err instanceof Error ? err.message : String(err) });
			setValidationMsg(`执行失败：${err instanceof Error ? err.message : String(err)}`);
		}
	}, [setValidationMsg, promptStartArgs]);

	// ★ 智能路由（W7 统一入口语义）：工具栏「▶ 运行」按图的成分选执行通道，但
	// **两条通道现在都从 Saros.Start 起跑**（resolveStartScope 单一真源）：
	//   · 含编排节点（Start/Prompt/Agent/IfElse…）→ 脚本路径（Dynamic Workflow
	//     引擎：Start 参数面板 + phase 进度 + 聊天框工具卡）
	//   · 纯 Comfy/Provider 画布 → 全图 Run（保留并行模式）
	// 图无 Start、或 Start 未接业务节点（无出边 / 只连 End）→ 退化为全图执行，
	// 与存量图行为一致（并在提示里说明，避免「少跑了节点」被误判为 bug）。
	const handleRun = useCallback(() => {
		const state = useWorkflowEditorStore.getState();
		const hasOrchestration = state.nodes.some(n => ORCHESTRATION_NODE_TYPES.has(n.type));
		if (hasOrchestration) {
			void handleExecuteScript();
		} else {
			void handleExecute();
		}
	}, [handleExecuteScript, handleExecute]);

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

	// ═══════════════════════════════════════════════════════════════
	// v2 单行工具栏：发布状态（pill + 发布 ▾ 下拉），宿主侧 RPC 见
	// agentStudioWebviewController 的 workflow.publishState/publish/upgrade。
	// ═══════════════════════════════════════════════════════════════
	type PublishState = { state: 'unpublished' | 'upToDate' | 'localModified' | 'serverNewer' | 'serverOnly'; localVersion?: string; serverVersion?: string };
	const [publishState, setPublishState] = useState<PublishState | null>(null);
	const [openMenu, setOpenMenu] = useState<'import' | 'export' | 'canvas' | 'publish' | null>(null);
	const [deleteConfirm, setDeleteConfirm] = useState(false);
	const [descCollapsed, setDescCollapsed] = useState(false);

	// ★ 会话机制一次性说明条（2026-09-11，方案 A 落地）：
	//   明确「会话隔离什么 / 共享什么」，消除「改了节点，其他会话怎么办」的困惑。
	//   全局一次（不带 workflowId —— 说明内容与具体工作流无关），点「知道了」后
	//   写 localStorage 不再出现。lazy 初始化避免首帧闪烁；localStorage 不可用时
	//   取 false（宁可不展示，也不要每次打开都重复打扰）。
	const [sessionHintVisible, setSessionHintVisible] = useState(() => {
		try { return localStorage.getItem('saros:wfSessionScopeHintDismissed') !== '1'; }
		catch { return false; }
	});
	const dismissSessionHint = useCallback(() => {
		setSessionHintVisible(false);
		try { localStorage.setItem('saros:wfSessionScopeHintDismissed', '1'); } catch { /* ignore */ }
	}, []);

	const refreshPublishState = useCallback(async () => {
		if (!workflowId) { return; }
		try {
			const r = await sendRequest('workflow.publishState', { workflowId }) as PublishState;
			setPublishState(r ?? null);
		} catch { setPublishState(null); }
	}, [workflowId]);
	useEffect(() => { void refreshPublishState(); }, [refreshPublishState, loaded]);

	const handlePublish = useCallback(async () => {
		if (!workflowId) { return; }
		setOpenMenu(null);
		try {
			const r = await sendRequest('workflow.publish', { workflowId }, 600_000) as { ok: boolean; version?: string };
			setValidationMsg(r?.ok ? `✓ 已发布 v${r.version ?? ''}` : '已取消发布');
		} catch { setValidationMsg('发布失败'); }
		void refreshPublishState();
	}, [workflowId, refreshPublishState]);

	const handleUpgrade = useCallback(async () => {
		if (!workflowId || !publishState?.serverVersion) { return; }
		const target = publishState.serverVersion;
		setOpenMenu(null);
		try {
			const r = await sendRequest('workflow.upgrade', { workflowId, serverVersion: target }, 300_000) as { ok: boolean; error?: string };
			setValidationMsg(r?.ok ? `✓ 已升级到 v${target}` : `升级失败：${r?.error ?? '未知错误'}`);
		} catch { setValidationMsg('升级失败'); }
		void refreshPublishState();
	}, [workflowId, publishState]);

	const handleVersionHistory = useCallback(() => {
		setOpenMenu(null);
		void sendRequest('workflow.versionHistory', {});
	}, []);

	const handleDeleteWorkflow = useCallback(() => {
		if (!workflowId) { return; }
		void sendRequest('workflow.deleteWorkflow', { workflowId });
		setOpenMenu(null);
		setDeleteConfirm(false);
	}, [workflowId]);

	// 发布 pill 文案 + 配色（v2 单行工具栏左段）
	const pillText = !publishState ? '同步中'
		: publishState.state === 'unpublished' ? (publishState.localVersion ? `未发布 v${publishState.localVersion}` : '未发布')
		: publishState.state === 'upToDate' ? `v${publishState.localVersion ?? ''}`
		: publishState.state === 'localModified' ? `v${publishState.localVersion} 已修改`
		: publishState.state === 'serverNewer' ? `v${publishState.localVersion ?? ''} → v${publishState.serverVersion}`
		: `商城 v${publishState.serverVersion ?? ''}`;
	const pillCls = !publishState || publishState.state === 'unpublished' ? 'unpublished'
		: publishState.state === 'upToDate' || publishState.state === 'serverOnly' ? 'ok'
		: publishState.state === 'localModified' ? 'modified' : 'newer';
	const saveText = saveStatus === 'saving' ? '保存中…' : saveStatus === 'saved' ? '已保存' : saveStatus === 'error' ? '保存失败' : '已自动保存';
	const saveCls = saveStatus === 'saving' ? 'saving' : saveStatus === 'saved' ? 'saved' : saveStatus === 'error' ? 'error' : '';

	// ═══════════════════════════════════════════════════════════════
	// 图 ⇄ 脚本 切换（v3）：视图模式 + 代码只读投影。
	// 脚本由 exportCanvasToWorkflowScript（M4a 同一生成器）从画布实时生成，
	// 订阅 store nodes/edges → 500ms 防抖刷新；永不回写画布（模式 A 只读投影）。
	// ═══════════════════════════════════════════════════════════════
	const [viewMode, setViewMode] = useState<'canvas' | 'split' | 'code' | 'mindmap'>('canvas');
	const [projectedScript, setProjectedScript] = useState<string>('');
	const [scriptSynced, setScriptSynced] = useState(0);
	// 行锚点：displayScript 行号(1-based) ↔ 画布 nodeId（带外通道，不写进脚本）。
	const [scriptAnchors, setScriptAnchors] = useState<ReadonlyArray<{ line: number; nodeId: string; kind: 'decl' | 'ref' }>>([]);
	// 行号 → nodeId 快查（渲染每行时判断是否可点击）
	const anchorByLine = useMemo(() => {
		const m = new Map<number, string>();
		for (const a of scriptAnchors) { if (!m.has(a.line)) { m.set(a.line, a.nodeId); } }
		return m;
	}, [scriptAnchors]);
	// 当前高亮的投影行（点击定位 / 画布选中反查）
	const [activeScriptLine, setActiveScriptLine] = useState(0);
	const scriptTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	// 分栏比例（0.2–0.8）+ 拖动句柄
	const [splitRatio, setSplitRatio] = useState(0.5);
	const mainFlexRef = useRef<HTMLDivElement | null>(null);
	const canvasHostRef = useRef<HTMLDivElement | null>(null);
	const dragSplitter = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		const host = mainFlexRef.current;
		if (!host) { return; }
		const total = host.getBoundingClientRect().width;
		const startX = e.clientX;
		const startRatio = splitRatio;
		const move = (ev: MouseEvent) => {
			const r = Math.min(0.8, Math.max(0.2, startRatio + (ev.clientX - startX) / total));
			setSplitRatio(r);
		};
		const up = () => {
			document.removeEventListener('mousemove', move);
			document.removeEventListener('mouseup', up);
		};
		document.addEventListener('mousemove', move);
		document.addEventListener('mouseup', up);
	}, [splitRatio]);

	useEffect(() => {
		if (viewMode === 'canvas') { return; }
		clearTimeout(scriptTimerRef.current);
		scriptTimerRef.current = setTimeout(() => {
			try {
				const state = useWorkflowEditorStore.getState();
				const r = exportCanvasToWorkflowScript({
					nodes: state.nodes as never,
					edges: state.edges as never,
					// node.data（默认/持久化值）打底，comfyRunValuesRef（属性面板实时值）优先
					getNodeValue: (id: string) => {
						const node = state.nodes.find(n => n.id === id);
						const data = (node?.data ?? {}) as Record<string, unknown>;
						return { ...data, ...(comfyRunValuesRef.current[id] ?? {}) } as Record<string, unknown>;
					},
					// P0：媒体节点导出为 await stage("uid") —— 真正驱动 ComfyUI 生成
					getStageUid: (id: string) => liteGraphRef.current?.stageUidOf(id),
					workflowName: state.workflowName,
				});
				setProjectedScript(r.displayScript);
				setScriptAnchors(r.anchors);
				setScriptSynced(Date.now());
			} catch {
				// 投影生成失败时保持上一次内容（只读视图，不阻塞编辑）
			}
		}, 500);
		return () => clearTimeout(scriptTimerRef.current);
	}, [nodes, edges, viewMode, workflowName]);

	// 代码投影 → 画布定位：点击带锚点的行 → 选中并居中对应画布节点。
	// split 模式下画布同屏可见，效果最好；code 单栏模式先切回 split 再定位。
	const revealNodeFromLine = useCallback((line: number) => {
		const nodeId = anchorByLine.get(line);
		if (!nodeId) { return; }
		setActiveScriptLine(line);
		if (viewMode === 'code') { setViewMode('split'); }
		// 切模式后画布需要一帧完成挂载/布局，再定位（否则量测到 0 尺寸）
		requestAnimationFrame(() => {
			const ok = liteGraphRef.current?.revealNode(nodeId);
			if (!ok) { setActiveScriptLine(0); }
		});
	}, [anchorByLine, viewMode]);

	// 画布 → 代码投影 反向定位：分栏同屏时，点选画布节点 → 高亮并滚到对应脚本行。
	// 复用既有 getSelectedNodes()（不改画布事件体系）；pointerup 后选中态才稳定。
	const codeBodyRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (viewMode !== 'split') { return; }
		const host = canvasHostRef.current;
		if (!host) { return; }
		const onUp = () => {
			requestAnimationFrame(() => {
				const sel = liteGraphRef.current?.getSelectedNodes?.() ?? [];
				if (sel.length !== 1) { return; }
				const nodeId = sel[0].id;
				// 优先跳「声明行」（UID 表条目 / gate 的 if-else 行只是引用）
				const decl = scriptAnchors.find(a => a.nodeId === nodeId && a.kind === 'decl')
					?? scriptAnchors.find(a => a.nodeId === nodeId);
				if (!decl) { return; }
				setActiveScriptLine(decl.line);
				const rows = codeBodyRef.current?.children;
				(rows?.[decl.line - 1] as HTMLElement | undefined)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
			});
		};
		host.addEventListener('pointerup', onUp);
		return () => host.removeEventListener('pointerup', onUp);
	}, [viewMode, scriptAnchors]);

	// Ctrl+Shift+V：图 ⇄ 代码来回切换（分栏态回到上次的单栏）
	useEffect(() => {
		const handler = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v') {
				e.preventDefault();
				setViewMode(m => (m === 'code' ? 'canvas' : 'code'));
			}
		};
		window.addEventListener('keydown', handler);
		return () => window.removeEventListener('keydown', handler);
	}, []);

	const handleCopyScript = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(projectedScript);
			setValidationMsg('✓ 脚本已复制到剪贴板');
		} catch {
			setValidationMsg('复制失败（剪贴板不可用）');
		}
		setTimeout(() => setValidationMsg(null), 3000);
	}, [projectedScript]);

	return (
		<>
		<div style={{
			width: '100%',
			height: '100%',
			display: 'flex',
			flexDirection: 'column',
			overflow: 'hidden',
		}}>
				{/* v3 两行工具栏：单行塞 16+ 元素必然重叠，按「频率分层」拆两行。
				    行1 = 身份(name/pill/stats/save) + 运行锚点(msg/Run)；
				    行2 = 视图切换 + 编辑(undo/redo/校验 + 4 下拉) + 面板(并行 + 3 入口)。 */}
				<div className="wft-bar">
					{comfyRunState === 'running' && <div className="wft-progress" />}
					{openMenu && (
						<div style={{ position: 'fixed', inset: 0, zIndex: 299 }} onClick={() => { setOpenMenu(null); setDeleteConfirm(false); }}
							onContextMenu={e => { e.preventDefault(); setOpenMenu(null); }} />
					)}

					{/* ── 行1 ── */}
					<div className="wft-row">
					{/* 左段：身份 + 发布状态 + 自动保存（marginRight:auto 推到行1 末端） */}
					<div className="wft-seg" style={{ marginRight: 'auto' }}>
						<input
							className="wft-name"
							type="text"
							value={workflowName}
							onChange={e => setWorkflowName(e.target.value)}
							placeholder="Workflow Name"
							spellCheck={false}
						/>
						<span className={`wft-pill ${pillCls}`} title="发布状态（与商城版本对比）"><span className="pd" />{pillText}</span>
						<span className="wft-stats">{nodes.length} 节点 · {edges.length} 连接</span>
						<span className={`wft-save ${saveCls}`}><span className="sd" />{saveText}</span>
						{descCollapsed && (
							<button className="wft-btn icon" title="展开任务描述" onClick={() => setDescCollapsed(false)}>📝</button>
						)}
					</div>

					{/* 行1 右段：运行消息 + Run 状态机（锚点，恒可见） */}
					<div className="wft-seg">
						{(validationMsg || comfyRunMsg) && (
							<span
								className={'wft-msg' + ((comfyRunState === 'done' || validationMsg?.startsWith('✓')) ? ' ok' : ' err')}
								title={validationMsg ?? comfyRunMsg ?? ''}
							>
								{validationMsg || comfyRunMsg}
							</span>
						)}
						{comfyRunState === 'running' ? (
							<button className="wft-run running" disabled><span className="wft-spin" />运行中…</button>
						) : executionStatus === 'running' ? (
							<>
								<button className="wft-btn icon" onClick={handlePause} title="暂停执行">⏸</button>
								<button className="wft-run cancel" onClick={handleCancel} title="中止执行">✕ 中止</button>
							</>
						) : executionStatus === 'paused' ? (
							<button className="wft-run" onClick={handleResume} title="继续执行">▶ 继续</button>
						) : (
							<button
								className={'wft-run' + (comfyRunState === 'done' ? ' done' : comfyRunState === 'failed' ? ' failed' : '')}
								onClick={handleRun}
								disabled={!workflowId}
								title="运行工作流：含编排节点（Start/Agent/IfElse 等）走脚本执行（读 Start 参数、聊天框工具卡展示进度）；纯 Comfy 节点走全图执行（并行）"
							>
								{comfyRunState === 'done' ? '✓ 完成' : comfyRunState === 'failed' ? '↻ 重试' : '▶ 运行'}
							</button>
						)}
					</div>
					</div>{/* /wft-row 行1 */}

					{/* ── 行2：视图切换 + 编辑 + 面板 ── */}
					<div className="wft-row">
						{/* v3 图⇄脚本 分段控件 */}
						<div className="wft-vswitch" role="tablist" aria-label="视图模式">
							<button className={viewMode === 'canvas' ? 'on' : ''} title="画布视图（节点图编辑，唯一编辑真源）" onClick={() => setViewMode('canvas')}>⊞ 图</button>
							<button className={viewMode === 'split' ? 'on' : ''} title="左右分栏：画布 + 脚本并排（可拖分隔条）" onClick={() => setViewMode('split')}>⫿ 分栏</button>
							<button className={viewMode === 'code' ? 'on' : ''} title="脚本视图：画布的只读投影（Ctrl+Shift+V）" onClick={() => setViewMode('code')}>&lt;/&gt; 代码<span className="vs-kbd">⌃⇧V</span></button>
						</div>
						<span className="wft-divider" />

					{/* ── 中段：编辑操作 ── */}
					<div className="wft-seg">
						<button className="wft-btn icon" onClick={() => doUndo()} title="撤销 (Ctrl+Z)">↶</button>
						<button className="wft-btn icon" onClick={() => doRedo()} title="重做 (Ctrl+Shift+Z)">↷</button>
						<span className="wft-divider" />
						<button className="wft-btn icon" onClick={handleValidate} title="校验工作流">✓</button>
						<span className="wft-divider" />

						{/* 导入 ▾ */}
						<div className="wft-dd">
							<button className="wft-btn" title="导入外部工作流" onClick={() => setOpenMenu(m => m === 'import' ? null : 'import')}>
								⤵ 导入 <span className="caret">▾</span>
							</button>
							{openMenu === 'import' && (
								<div className="wft-menu">
									<div className="wft-mi-head">导入为新工作流</div>
									<button className="wft-mi" onClick={() => { setOpenMenu(null); void handleImportWorkflowFile(); }}>
										<span className="mi-icon">🗂</span>
										<span className="mi-label">工作流 JSON 文件<span className="mi-hint">落盘为独立工作流 · 出现在左侧列表</span></span>
									</button>
									<div className="wft-mi-head">导入到当前画布</div>
									<button className="wft-mi" onClick={() => { setOpenMenu(null); comfyFileInputRef.current?.click(); }}>
										<span className="mi-icon">📄</span>
										<span className="mi-label">ComfyUI 工作流 JSON<span className="mi-hint">替换/合并当前画布内容</span></span>
									</button>
								</div>
							)}
						</div>

						{/* 导出 ▾（两个导出合一出口） */}
						<div className="wft-dd">
							<button className="wft-btn" title="导出工作流" onClick={() => setOpenMenu(m => m === 'export' ? null : 'export')}>
								⤴ 导出 <span className="caret">▾</span>
							</button>
							{openMenu === 'export' && (
								<div className="wft-menu">
									<div className="wft-mi-head">导出</div>
									<button className="wft-mi" onClick={() => { setOpenMenu(null); setViewMode('code'); void handleExecuteScript(); }}>
										<span className="mi-icon">▶</span>
										<span className="mi-label">直接执行<span className="mi-hint">绕过 LLM 决策，运行过程在聊天框工具卡片展示</span></span>
									</button>
									<button className="wft-mi" onClick={() => { setOpenMenu(null); handleWorkflowExport(); }}>
										<span className="mi-icon">🗂</span>
										<span className="mi-label">工作流 JSON 文件<span className="mi-hint">完整工作流 · 可再次导入（分享 / 备份 / 迁移）</span></span>
									</button>
									<button className="wft-mi" onClick={() => { setOpenMenu(null); handleComfyExport(); }}>
										<span className="mi-icon">🧬</span>
										<span className="mi-label">ComfyUI api.json<span className="mi-hint">仅 Comfy 节点 · 剔除编排节点</span></span>
									</button>
								</div>
							)}
						</div>

						{/* 媒体库（原「⊞ 画布 ▾」位置：移除画布整理下拉，直接接入媒体库，是工具栏唯一入口）。
						    注：原下拉里的「对齐选中节点」「重置视图」已在右键菜单里有等价入口
						    （menuItems.ts: align / resetView）；「自动布局」「封装 Subflow/Loop/Parallel」
						    仅此一处入口，本改动会一并丢失，后续需要时请找回。 */}
						<button className="wft-btn" title="媒体库（生成图片资产管理）" onClick={() => setShowMediaLibrary(true)}>
							🖼 媒体库
						</button>

						{/* 发布 ▾（原顶栏：上传/升级/版本历史/删除） */}
						<div className="wft-dd">
							<button className="wft-btn" title="发布 / 版本 / 删除" onClick={() => { setOpenMenu(m => m === 'publish' ? null : 'publish'); setDeleteConfirm(false); }}>
								⬆ 发布 <span className="caret">▾</span>
							</button>
							{openMenu === 'publish' && (
								<div className="wft-menu right">
									<div className="wft-mi-head">发布</div>
									{publishState?.state === 'unpublished' && (
										<button className="wft-mi" onClick={() => void handlePublish()}>
											<span className="mi-icon">📤</span><span className="mi-label">上传发布<span className="mi-hint">发布到商城</span></span>
										</button>
									)}
									{publishState?.state === 'localModified' && (
										<button className="wft-mi" onClick={() => void handlePublish()}>
											<span className="mi-icon">📤</span><span className="mi-label">上传更新<span className="mi-hint">v{publishState.localVersion} → v{publishState.serverVersion}</span></span>
										</button>
									)}
									{publishState?.state === 'serverNewer' && (
										<button className="wft-mi" onClick={() => void handleUpgrade()}>
											<span className="mi-icon">⬆</span><span className="mi-label">升级到 v{publishState.serverVersion}<span className="mi-hint">从商城下载最新版</span></span>
										</button>
									)}
									<div className="wft-mi-sep" />
									<button className="wft-mi" onClick={handleVersionHistory}>
										<span className="mi-icon">🕐</span><span className="mi-label">版本历史</span>
									</button>
									{!deleteConfirm ? (
										<button className="wft-mi danger" onClick={() => setDeleteConfirm(true)}>
											<span className="mi-icon">🗑</span><span className="mi-label">删除工作流</span>
										</button>
									) : (
										<div className="wft-del-confirm">
											<span className="dc-text">确认删除？</span>
											<button className="dc-btn dc-ok" onClick={handleDeleteWorkflow}>删除</button>
											<button className="dc-btn dc-cancel" onClick={() => setDeleteConfirm(false)}>取消</button>
										</div>
									)}
								</div>
							)}
						</div>

						<input
							ref={comfyFileInputRef}
							type="file"
							accept=".json,application/json"
							style={{ display: 'none' }}
							onChange={handleComfyImportFile}
						/>
					</div>

					{/* 行2 右段：并行 toggle + 面板入口（marginLeft:auto 推到行2 末端） */}
					<div className="wft-seg" style={{ marginLeft: 'auto' }}>
						<span
							className={'wft-toggle' + (comfyRunParallel ? ' on' : '')}
							title="并行执行：同层无依赖节点并发（provider/本地节点共用 4 并发；ComfyUI 后端步骤保持串行）"
							onClick={() => setComfyRunParallel(v => !v)}
						>
							<span className="tk" />并行
						</span>
						<span className="wft-divider" />
						{/* ★ 工作流 Session 选择器（2026-09-11 用户需求）：不同会话生成的内容
						    相互隔离；切换即刷新画布卡片（快照库换作用域）。 */}
						<select
							className="wft-session-select"
							title={'工作流会话：只隔离各自「生成的内容」（产物 / 缩略图）；节点参数与连线是所有会话共用的工作流定义——改一次，全部会话生效。'}
							value={activeWfSession}
							onChange={e => handleWfSessionChange(e.target.value)}
							style={{ fontSize: 11, maxWidth: 160, padding: '2px 4px' }}
						>
							{wfSessions.length === 0 ? (
								<option value={activeWfSession}>{activeWfSession === 'default' ? '默认会话' : activeWfSession}</option>
							) : null}
							{wfSessions.map(s => (
								<option key={s.id} value={s.id}>{s.name}{s.runCount ? ` · ${s.runCount} 次` : ''}</option>
							))}
						</select>
						{/* ★ 重命名当前会话（2026-09-11 用户需求）：仅改显示名，不影响产物隔离 */}
						<button
							className="wft-btn icon"
							title="重命名当前会话"
							onClick={() => { void handleWfSessionRename(); }}
						>✏️</button>
						<button ref={runnerBtnRef} className={'wft-btn icon' + (showRunners ? ' panel-on' : '')} title="ComfyUI Runner 管理" onClick={() => setShowRunners(v => !v)}>🖥</button>
						<button className="wft-btn icon" title="插件管理（URL 安装 / 卸载 / 重载）" onClick={() => setShowPluginManager(true)}>🧩</button>
					</div>
					</div>{/* /wft-row 行2 */}
				</div>

				{/* 任务描述栏（v2：可折叠副行；折叠后从单行工具栏的 📝 按钮展开） */}
				{!descCollapsed && (
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
					{!editingDescription && (
						<button className="wft-btn icon" title="折叠任务描述栏" onClick={() => setDescCollapsed(true)}>▴</button>
					)}
				</div>
				)}

				{/* ★ 会话机制一次性说明条（2026-09-11，方案 A 落地）：把「隔离什么 /
				    共享什么」讲清楚——会话只隔离生成的内容，节点参数与连线是共用定义。
				    全局一次（localStorage），点「知道了」后不再出现。 */}
				{sessionHintVisible && (
					<div className="wft-session-hint" role="note">
						<span className="wft-session-hint-icon">💡</span>
						<span className="wft-session-hint-text">
							<b>会话</b>只隔离各自<u>生成的内容</u>（产物 / 缩略图）；
							<b>节点参数与连线</b>是所有会话<u>共用</u>的工作流定义 —— 改一次，全部会话生效。
						</span>
						<button
							className="wft-session-hint-close"
							onClick={dismissSessionHint}
							title="不再提示"
						>知道了</button>
					</div>
				)}

				{/* Main area — v3: flex 容器 = 画布 │ 分隔条 │ 代码投影；nodes 经右键菜单添加 */}
			<div className="wf-main-flex" ref={mainFlexRef}>

				{/* Canvas — LiteGraph 引擎（唯一编辑真源）。code 模式宽度收到 0 但保留
				    DOM（引擎实例/撤销栈存活），切回时 ResizeObserver 自动恢复尺寸。 */}
				<div
					ref={canvasHostRef}
					className="wf-canvas-host"
					style={
						viewMode === 'code' ? { flex: '0 0 0px' }
						: viewMode === 'split' ? { flex: `0 0 ${splitRatio * 100}%` }
						: { flex: '1 1 100%' }
					}
				>
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
							// ★ 节点落在右键点击处（graphX/graphY 是 graph 坐标），且
							//   **创建后立即关闭菜单**（对齐 ComfyUI：pick 即 commit）。
							//   否则级联叶子的 onPick 只 addNode、canvasMenu 不关，
							//   而 overlay 的 role="menu" 保护又阻止点击菜单项关闭 →
							//   菜单一直悬在画布上。
							const addNodeSubmenu = buildAddNodeSubmenu(
								(type) => {
									addNode(type, { x: graphX, y: graphY });
									setCanvasMenu(null);
								}
							);
							const items = buildCanvasActions(
								{ selectedCount: liteGraphRef.current?.getSelectedNodes().length ?? 0, canPaste, addNodeSubmenu },
								{
									// 搜索浮窗（submenu 缺省时的退化路径）：先关 canvas
									// 菜单再开搜索，避免两个菜单叠加。
									openNodeSearch: () => { setCanvasMenu(null); setCtxMenu({ graphX, graphY, clientX, clientY }); },
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
						onLinkContextMenu={(link, graphX, graphY, clientX, clientY) => openLinkMenu(link, graphX, graphY, clientX, clientY)}
						onLinkHandleClick={(link, graphX, graphY, clientX, clientY) => openLinkMenu(link, graphX, graphY, clientX, clientY)}
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
								pinned: !!node.flags?.pinned,
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
								const [sx, sy] = canvas.convertOffsetToCanvas?.(node.pos, [0, 0]) ?? [0, 0];
								setRenamingNode({ node, screenX: sx, screenY: sy });
							};
							const items = buildNodeActions(ctx, {
								run: () => { void runSingleSchemaNode(sarosId, nodeType); },
								editTitle: startInlineRename,
								toggleCollapse: () => { if (node.collapsed) { node.collapse(false); } else { node.collapse(true); } },
								togglePin: () => { if (node.flags?.pinned) { node.unpin(); } else { node.pin(); } },
								clone: () => { node.clone(); },
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
								remove: () => { liteGraphRef.current?.canvasInstance()?.graph?.remove(node); },
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
						onCanvasDoubleClick={(graphX, graphY, clientX, clientY) => {
							// ★ ComfyUI 交互：双击空白打开节点搜索框（NodeContextMenu）。
							//   先关掉所有其它菜单，避免叠加。
							setCanvasMenu(null);
							setNodeMenu(null);
							setGroupMenu(null);
							setLinkMenu(null);
							setCtxMenu({ graphX, graphY, clientX, clientY });
						}}
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
							ghostMode
							onPick={(type) => {
								// ★ FollowCursor：选节点后关闭搜索框，进入 ghost 落位模式
								//   （节点跟随光标，点击画布落位，Esc/右键取消）。
								setCtxMenu(null);
								liteGraphRef.current?.beginGhostPlace(type, ctxMenu.graphX, ctxMenu.graphY);
							}}
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
							// 兜底：确保 store 一定写入（下面的事件若因节点不在画布被丢弃，
							// 至少执行链路的数据源已更新 —— 与原行为一致）。
							useWorkflowEditorStore.getState().updateNodeData(id, values);
							// ★ P2b（2026-09-13）：再逐字段派发统一写入口 `wf-node-control`，
							//   补上原先缺失的两件事：
							//     ① 写 LiteGraph `node.properties`（画布/序列化真源）——
							//        原来只写 store，弹窗改完画布上的值不同步；
							//     ② 经 applyNodeControl(origin='canvas') → scheduleNotifyHost
							//        → host 广播给其它窗口（画布 tab ↔ 节点编辑器 tab）。
							//   300ms 节流在 scheduleNotifyHost 内已有，批量提交不会打爆通道。
							for (const [name, value] of Object.entries(values)) {
								window.dispatchEvent(new CustomEvent('wf-node-control', { detail: { nodeId: id, name, value } }));
							}
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

					{/* v3 分栏分隔条（仅 split 模式） */}
					{viewMode === 'split' && (
						<div className="wf-splitter" onMouseDown={dragSplitter} title="拖动调整分栏比例" />
					)}

					{/* v3 代码只读投影面板（split / code 模式）。内容由画布经
					    exportCanvasToWorkflowScript 防抖生成，永不回写。 */}
					{viewMode !== 'canvas' && (
						<div className="wf-code-pane" style={viewMode === 'split' ? { flex: '1 1 auto' } : { flex: '1 1 100%' }}>
							<div className="wf-code-head">
								<span className="ro-badge">🔒 只读投影</span>
								<span className="file-name">{(workflowName || 'workflow').replace(/\s+/g, '-')}.workflow.mjs</span>
								<span className="sync-note" title={scriptSynced ? `最近同步 ${new Date(scriptSynced).toLocaleTimeString()}` : ''}>
									由画布生成 · 画布变更自动刷新{scriptAnchors.length > 0 ? ' · 点击带竖条的行定位节点' : ''}
								</span>
								<span className="spacer" />
								<button className="act-btn" onClick={() => void handleCopyScript()} disabled={!projectedScript} title="复制脚本到剪贴板">⧉ 复制</button>
								<button className="act-btn run" onClick={() => void handleExecuteScript()} disabled={execScriptResult.status === 'running' || !projectedScript} title="绕过 LLM 决策，运行过程在聊天框工具卡片展示">
									{execScriptResult.status === 'running' ? '⏳ 执行中…' : '▶ 直接执行'}
								</button>
							</div>
							<div className="wf-code-body" ref={codeBodyRef}>
								{projectedScript
									? projectedScript.split('\n').map((line, i) => {
										const lineNo = i + 1;
										const anchored = anchorByLine.get(lineNo);
										const cls = ['wf-code-row'];
										if (anchored) { cls.push('anchored'); }
										if (activeScriptLine === lineNo) { cls.push('active'); }
										return (
											<div
												className={cls.join(' ')}
												key={i}
												{...(anchored
													? {
														onClick: () => revealNodeFromLine(lineNo),
														title: '点击定位到画布节点',
														role: 'button',
														tabIndex: 0,
														onKeyDown: (e: React.KeyboardEvent) => {
															if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); revealNodeFromLine(lineNo); }
														},
													}
													: {})}
											>
												<span className="ln">{lineNo}</span>
												<span className="cl" dangerouslySetInnerHTML={{ __html: highlightScriptLine(line) }} />
											</div>
										);
									})
									: (
										<div className="wf-code-empty">
											正在从画布生成脚本投影…<br />
											<span style={{ opacity: 0.7 }}>画布为空时无内容。切换回「⊞ 图」添加节点。</span>
										</div>
									)}
							</div>
						</div>
					)}

					{/* 思维导图视图：从画布 Saros.MindMap* 节点派生（与 store 同源）。
					    仅在 viewMode==='mindmap' 时挂载；其余模式不渲染，避免空跑布局。 */}
					{viewMode === 'mindmap' && (
						<div className="wf-mindmap-pane" style={{ flex: '1 1 100%' }}>
							<MindMapPanel active={viewMode === 'mindmap'} />
						</div>
					)}

				{/* Comfy Runner 管理面板浮层 */}
				{showRunners && comfyRegistryRef.current && (
					<div ref={runnerPanelRef} style={{
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
		{/* W1b: Start 运行时参数面板 */}
		{startArgsDialog && (
			<div style={{
				position: 'fixed', inset: 0, zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center',
				background: 'rgba(0,0,0,0.45)',
			}} onClick={cancelStartArgs}>
				<div style={{
					background: 'var(--vscode-menu-background, #252526)', border: '1px solid var(--vscode-menu-border, #454545)',
					borderRadius: 8, boxShadow: '0 18px 60px rgba(0,0,0,0.5)', width: 440, maxWidth: '90vw', padding: '16px 18px',
				}} onClick={e => e.stopPropagation()}>
					<div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>⚙️ 工作流输入参数</div>
					<div style={{ fontSize: 11.5, color: 'var(--vscode-descriptionForeground)', marginBottom: 12, lineHeight: 1.6 }}>
						来自 Start 节点的输入契约。留空/默认值可直接运行，此处可覆盖本次运行参数（图内用 <code style={{ fontFamily: 'var(--monospace, monospace)' }}>{'{{args.key}}'}</code> 引用）。
					</div>
					<div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14, maxHeight: 320, overflowY: 'auto' }}>
						{startArgsDialog.map((row, i) => (
							<div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
								<label style={{ flex: '0 0 38%', fontSize: 11, color: 'var(--vscode-foreground)', fontFamily: 'var(--monospace, monospace)' }}>{row.key}</label>
								<input
									value={row.value}
									onChange={e => updateStartArgRow(i, e.target.value)}
									placeholder="值（支持数字/true/false/字符串）"
									style={{
										flex: 1, padding: '5px 8px', fontSize: 11, fontFamily: 'inherit',
										background: 'var(--vscode-input-background)', color: 'var(--vscode-foreground)',
										border: '1px solid var(--vscode-input-border)', borderRadius: 4, outline: 'none',
									}}
								/>
							</div>
						))}
					</div>
					<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
						<button onClick={cancelStartArgs} style={{ fontSize: 12, cursor: 'pointer', border: '1px solid var(--vscode-panel-border)', background: 'transparent', color: 'var(--vscode-foreground)', borderRadius: 4, padding: '4px 12px', fontFamily: 'inherit' }}>
							取消
						</button>
						<button onClick={submitStartArgs} style={{ fontSize: 12, cursor: 'pointer', border: '1px solid #22c55e', background: '#22c55e', color: '#fff', borderRadius: 4, padding: '4px 14px', fontFamily: 'inherit', fontWeight: 600 }}>
							▶ 运行
						</button>
					</div>
				</div>
			</div>
		)}
		{/* P1: Saros.AskUser 交互弹窗（图执行暂停点） */}
		{askUserDialog && (
			<div style={{
				position: 'fixed', inset: 0, zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center',
				background: 'rgba(0,0,0,0.45)',
			}} onClick={() => { /* 点击遮罩不关闭：AskUser 是阻塞执行点 */ }}>
				<div style={{
					background: 'var(--vscode-menu-background, #252526)', border: '1px solid var(--vscode-menu-border, #454545)',
					borderRadius: 8, boxShadow: '0 18px 60px rgba(0,0,0,0.5)', width: 420, maxWidth: '90vw', padding: '16px 18px',
				}} onClick={e => e.stopPropagation()}>
					<div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>🙋 需要你的输入</div>
					<div style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)', marginBottom: 14, lineHeight: 1.6 }}>{askUserDialog.question}</div>
					{askUserDialog.params && askUserDialog.params.length > 0 ? (
						// ★ params 动态参数表单：渲染输入框（text/number/textarea/image），
						//   提交后以键值对象反馈给工作流（AskUser 输出 SAROS_JSON）。
						<div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
							{askUserDialog.params.map(p => (
								<label key={p.key} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: 'var(--vscode-foreground)' }}>
									<span>{p.label}</span>
									{/* ★ image 字段（2026-09-10）：文件选择 + 缩略图预览，值 = data URL
									    ——与 browser 侧 confirmCards 的 kind='image' 同语义，
									      下游媒体端口（参考图等）可直接消费。 */}
									{p.type === 'image' ? (
										<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
											<input
												type="file"
												accept="image/*"
												onChange={e => {
													const file = e.target.files?.[0];
													if (!file) { return; }
													const reader = new FileReader();
													reader.onload = () => {
														if (typeof reader.result !== 'string') { return; }
														setAskUserParamValues(prev => ({ ...prev, [p.key]: reader.result as string }));
													};
													reader.readAsDataURL(file);
												}}
												style={{ flex: 1, fontSize: 11 }}
											/>
											{askUserParamValues[p.key] ? (
												<img
													src={askUserParamValues[p.key]}
													alt=""
													style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 4, border: '1px solid var(--vscode-panel-border)' }}
												/>
											) : null}
										</div>
									) : p.type === 'textarea' ? (
										<textarea
											rows={3}
											value={askUserParamValues[p.key] ?? ''}
											onChange={e => setAskUserParamValues(prev => ({ ...prev, [p.key]: e.target.value }))}
											style={{ fontFamily: 'inherit', fontSize: 12, padding: '5px 8px', borderRadius: 4, border: '1px solid var(--vscode-panel-border)', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', resize: 'vertical' }}
										/>
									) : (
										<input
											type={p.type === 'number' ? 'number' : 'text'}
											value={askUserParamValues[p.key] ?? ''}
											onChange={e => setAskUserParamValues(prev => ({ ...prev, [p.key]: e.target.value }))}
											style={{ fontFamily: 'inherit', fontSize: 12, padding: '5px 8px', borderRadius: 4, border: '1px solid var(--vscode-panel-border)', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)' }}
										/>
									)}
								</label>
							))}
						</div>
					) : (
						<div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
							{askUserDialog.options.map(o => {
								const active = askUserSelected.has(o.label);
								return (
									<button key={o.label} onClick={() => toggleAskUserOption(o.label)} style={{
										display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', width: '100%',
										padding: '8px 11px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
										background: active ? 'var(--vscode-menu-selectionBackground, #094771)' : 'transparent',
										border: `1px solid ${active ? 'var(--vscode-focusBorder, #007fd4)' : 'var(--vscode-panel-border)'}`,
										color: 'var(--vscode-foreground)',
									}}>
										<span style={{ width: 16, flexShrink: 0, color: active ? '#3fb950' : 'var(--vscode-descriptionForeground)' }}>
											{askUserDialog.multiSelect ? (active ? '☑' : '☐') : (active ? '◉' : '○')}
										</span>
										<span style={{ flex: 1 }}>{o.label}</span>
										{o.description && <span style={{ fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>{o.description}</span>}
									</button>
								);
							})}
						</div>
					)}
					<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
						<button onClick={() => { askUserResolveRef.current?.(askUserDialog.params?.length ? {} : ''); askUserResolveRef.current = null; setAskUserDialog(null); }}
							style={{ fontSize: 12, cursor: 'pointer', border: '1px solid var(--vscode-panel-border)', background: 'transparent', color: 'var(--vscode-foreground)', borderRadius: 4, padding: '4px 12px', fontFamily: 'inherit' }}>
							跳过
						</button>
						{askUserDialog.params && askUserDialog.params.length > 0 ? (
							<button onClick={submitAskUserParams}
								style={{ fontSize: 12, cursor: 'pointer', border: '1px solid #22c55e', background: '#22c55e', color: '#fff', borderRadius: 4, padding: '4px 14px', fontFamily: 'inherit', fontWeight: 600 }}>
								提交
							</button>
						) : (
							<button onClick={submitAskUser} disabled={askUserSelected.size === 0}
								style={{ fontSize: 12, cursor: askUserSelected.size ? 'pointer' : 'not-allowed', border: '1px solid #22c55e', background: '#22c55e', color: '#fff', borderRadius: 4, padding: '4px 14px', fontFamily: 'inherit', fontWeight: 600, opacity: askUserSelected.size ? 1 : 0.5 }}>
								{askUserDialog.multiSelect ? `确认选择 (${askUserSelected.size})` : '确认'}
							</button>
						)}
					</div>
				</div>
			</div>
		)}
	</>
);
};

/**
 * v3 代码投影轻量语法高亮（单行、单遍 token 替换，只读展示足够）：
 * 注释 / 字符串 / 关键字 三类着色，escape 后不再引入额外 HTML。
 */
function highlightScriptLine(line: string): string {
	const esc = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	const rx = /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\b(export|const|let|var|await|async|function|return|if|else|for|of|in|new|throw|try|catch|typeof)\b/g;
	return esc.replace(rx, (m, cm, st, kw) =>
		cm ? `<span class="wf-tk-cm">${cm}</span>`
		: st ? `<span class="wf-tk-st">${st}</span>`
		: `<span class="wf-tk-kw">${kw}</span>`);
}

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

	// ★ picker 选中同步（2026-09-11 用户需求）：聊天卡勾选 ImagePicker 候选 → 写回画布节点选中态。
	//   `select_picker_refs` 必须在这里**预处理**成 `update_node` 补丁 —— ref→池序号的映射需要
	//   快照库（池 = 直接上游的归档 + 顺序），而 `applyCanvasOps` 是**纯函数、无 store** ✗
	//   （同 `__generate_flow__` 的预处理范式）。
	const pickerOps = ops.filter(o => o.op === 'select_picker_refs');
	const restOps = ops.filter(o => o.op !== 'select_picker_refs');
	const preOps: Array<Record<string, unknown>> = [];
	if (pickerOps.length > 0) {
		const store = activeStore();
		for (const po of pickerOps) {
			const refs = Array.isArray(po.refs) ? (po.refs as string[]) : [];
			const node = model.nodes.find(n => n.id === String(po.node ?? ''));
			if (!node || refs.length === 0) { continue; }
			// ★★ 池顺序必须与**画布卡片网格 / 物化**完全一致（2026-09-12 修用户实测
			//   「聊天框选中的图像和工作流节点中同步显示的选中图像不一致」）：
			//   卡片池 = `mergeImagePool(pickerOutputs)`（**新图在前** + 去重），
			//   而这里此前用 `store.byNode(uid)` 的原序（index 升序 = **旧图在前**）✗
			//   ⇒ 序号整体**反了** ⇒ 画布高亮到**另一组格子** ✗，且物化出的 refs 也错 ✗
			//   （下游 AnimatedEmoji 的「引用」跟着错/空 ✗）。
			//   ⚠ 三处必须同序：卡片网格（nodeCard PickerPoolGrid）、
			//     LiteGraphCanvas 的「选中即物化」、以及这里的 ref→序号映射。
			const raw: MediaSnapshotEntry[] = [];
			for (const uid of model.edges.filter(e => e.target === node.id).map(e => e.source)) {
				for (const entry of (store?.byNode(uid) ?? [])) {
					if (entry?.media?.kind === 'image') { raw.push(entry); }
				}
			}
			const poolRefs = mergeImagePool(raw).map(e => e.media.ref);
			const patch = buildPickerSelectionPatch(refs, poolRefs);
			if (Object.keys(patch).length > 0) {
				preOps.push({ op: 'update_node', node: node.id, patch });
			}
		}
	}

	// Regular ops: atomic batch via applyCanvasOps.
	const result = applyCanvasOps(model, [...preOps, ...restOps] as CanvasOp[]);
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
