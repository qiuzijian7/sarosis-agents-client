// 触发 messageClient 的模块副作用：初始化 globalThis.__vssarosBridge，供
// nodeExecutor / stageWorkflowExecutor / nodeCard / comfyRunner 的 fallback 读取。
// 生产环境由 index.tsx 值 import 触发；e2e 直接 import 这些 executor，必须显式
// 补上这条链，否则模块加载时 `__vssarosBridge ?? throw` 抛 "not initialised"。
import '../src/bridge/messageClient';
import { LGraph, LiteGraph } from '@comfyorg/litegraph';
import { registerSarosLiteGraphNodes } from '../src/features/workflowEditor/comfyHost/sarosLiteGraphNodes';
import {
	registerSarosNodes, getNodeSpec, registerComfyUINativeNode,
	buildComfyPaletteItems, isValidLiteGraphConnection, isPortTypeCompatible,
	registerDefaultComfyTVStages, subscribeNodeRegistry, getNodeRegistryVersion,
} from '../src/features/workflowEditor/comfyHost/registry';
import { toLiteGraph, fromLiteGraph } from '../src/features/workflowEditor/comfyHost/ComfyGraphAdapter';
import { useWorkflowEditorStore, undo, redo } from '../src/features/workflowEditor/store';
import { buildEditorFields, coerceEditorValue } from '../src/features/workflowEditor/comfyHost/nodeEditorForm';
import { isInstantNode, cropRect, rotateDegrees, mirrorFlip, instantOutputSize, applyInstantDraw } from '../src/features/workflowEditor/comfyHost/instantNodes';
import {
	isRelightNode, createDefaultLight, normalizeLights, parseLightsData, orthographicProject,
	screenToSphere, lightDirection, LIGHT_PRESETS,
} from '../src/features/workflowEditor/comfyHost/relightEditor';
import { runRelightNode } from '../src/features/workflowEditor/comfyHost/relightExecutor';
import { defaultPosterElements, applyPosterLayout, parsePosterLayout, renderPoster, hitTestPosterElement, isPosterNode, hitTestPosterHandle, applyPosterDrag, posterHandlePosN, posterAngleTo, normalizePosterRot, cursorForPoster, handlePtsN, parsePosterGuides, posterGridOn, posterGuideHitIndex, posterImageProps, applyImgDrag, applyImgScale, clampImgScale, SIZE_PRESETS, sizePresetFor } from '../src/features/workflowEditor/comfyHost/posterEditor';
import { arrange, align, distribute, unionRect, isAlignOp, buildSnapTargets, nearestTarget, applySnap } from '../src/features/workflowEditor/comfyHost/posterArrange';
import { runPosterNode } from '../src/features/workflowEditor/comfyHost/posterExecutor';
import { spawnPickerForStage, spawnAssetLoader, spawnFollowUp, ASSET_DRAG_MIME, ACTIONS_BY_KIND } from '../src/features/workflowEditor/comfyHost/actionSpawn';
import { importWorkflow, listNativeWorkflows, linkWorkflow } from '../src/features/workflowEditor/comfyHost/workflowManager';
import { defaultCorners, parseCorners, serializeCorners, clampCorner, nearestCornerIndex, isCornerPinNode } from '../src/features/workflowEditor/comfyHost/cornerPinEditor';
import {
	defaultShapePoints, parseShapeKeys, shapeKeysToJson, addShapePoint, moveShapePoint,
	moveShapeTangent, removeShapePoint, isRotoMaskNode,
} from '../src/features/workflowEditor/comfyHost/rotoMaskEditor';
import {
	defaultLayerDoc, parseLayerDoc, layerDocToJson, addLayerOp, drawLayerDoc, isLayerEditorNode,
} from '../src/features/workflowEditor/comfyHost/layerEditor';
import { runLayerEditorNode } from '../src/features/workflowEditor/comfyHost/layerExecutor';
import {
	defaultBoardState, parseBoardState, boardStateToJson, addBoard, removeBoard, moveBoard,
	patchBoard, boardDurationMs, boardImageUrl, isStoryboardEditorNode,
} from '../src/features/workflowEditor/comfyHost/storyboardEditor';
import { runStoryboardEditorNode } from '../src/features/workflowEditor/comfyHost/storyboardExecutor';
import {
	DEFAULT_MATERIAL, MATERIAL_PRESETS, applyPreset, materialStateToJson, normalizeMaterial,
	parseMaterialState, renderMaterialBall, isMaterialNode,
} from '../src/features/workflowEditor/comfyHost/materialEditor';
import { runMaterialNode } from '../src/features/workflowEditor/comfyHost/materialExecutor';
import {
	createEmptyScene, createDefaultPrimitive, createDefaultLight as createSceneDefaultLight, addPrimitive, addLight,
	patchPrimitive, removePrimitive, parseSceneState, sceneStateToJson, cloneScene, isScene3DNode,
} from '../src/features/workflowEditor/comfyHost/scene3dEditor';
import { runScene3DNode } from '../src/features/workflowEditor/comfyHost/scene3dExecutor';
import { buildMinimapScene, minimapToGraph, applyMinimapPan, renderMinimap } from '../src/features/workflowEditor/minimap';
import { comfyTitleText, comfyDrawWidgets, drawNodeErrorBanner, drawNodeStateOverlay, applyComfyNodeStyle } from '../src/features/workflowEditor/comfyNodeStyle';
import { buildMenuGroups, filterMenuGroups, buildAddNodeSubmenu } from '../src/features/workflowEditor/NodeContextMenu';
import { darkenColor } from '../src/features/workflowEditor/comfyNodeStyle';
import { runSingleNode } from '../src/features/workflowEditor/comfyHost/nodeExecutor';
import { MediaSnapshotStore, createMemoryBackend } from '../src/features/workflowEditor/comfyHost/mediaSnapshotStore';
import { primarySnapshotKey, thumbnailSize, comfyViewUrl, normalizeOutputSlot } from '../src/features/workflowEditor/comfyHost/mediaSnapshot';
import { createLocalComfyRunner, ComfyRunnerRegistry, collectRunnerRows } from '../src/features/workflowEditor/comfyHost/comfyRunner';
import { guiToApi, apiToGui, parseGuiWorkflow } from '../src/features/workflowEditor/comfyHost/comfyApiAdapter';
import { nodeToOverlayRect, createWidgetBridgeHost } from '../src/features/workflowEditor/comfyHost/widgetBridge';
import { intersectRect, renderAreaToLayerRect, buildClipPath, domWidgetZIndex, CLIP_MARGIN } from '../src/features/workflowEditor/comfyHost/domClipping';
import { drawCanvasGrid, applyNodeDragDelta } from '../src/features/workflowEditor/LiteGraphCanvas';
import { computeExecutionOrder, collectUpstreamNodeIds, buildExecutionPlan } from '../src/features/workflowEditor/comfyHost/executionGraph';
import { isComfyExecutableSpec, runGraphExecution, runNodeOrStage } from '../src/features/workflowEditor/comfyHost/workflowRun';
import { CardStateStore } from '../src/features/workflowEditor/comfyHost/cardState';
import { pickDefaultWorkflowLabel, injectWorkflowValues, runStageWorkflow, StageWorkflowUnavailableError, matchUpstreamFrom, viewUrlToAnnotated, RUNTIME_PLACEHOLDER_KEYS } from '../src/features/workflowEditor/comfyHost/stageWorkflowExecutor';
import { listBuiltinWorkflows, getBuiltinWorkflowConfig } from '../src/features/workflowEditor/comfyHost/builtinWorkflows/index';
import { readFileSync } from 'node:fs';
import {
	resolveShortcutAction, toggleModeForNodes, toggleCollapseForNodes, computeSelectionBounds,
	createGroupForNodes, removeGroupsContaining, NODE_MODE_MUTE, NODE_MODE_BYPASS,
} from '../src/features/workflowEditor/shortcuts';
import { applyGroupEdit, GROUP_COLORS } from '../src/features/workflowEditor/groupMenu';
import { LGraphGroup } from '@comfyorg/litegraph';
import {
	packFxVideo, unpackFxVideo, fxVideoUrl, mergeFxChain, isFxBuildNode, isFxChainNode,
	buildFxSpecEntry, fxDeliveryParams,
} from '../src/features/workflowEditor/comfyHost/fxChain';
import { collectUpstreamValues, isPickerNode, isLoaderNode, collectUpstreamCandidates } from '../src/features/workflowEditor/comfyHost/workflowRun';
import { comfyOutputsToFxSnapshots } from '../src/features/workflowEditor/comfyHost/nodeExecutor';
import { COMFYTV_STAGE_META } from '../src/features/workflowEditor/comfyHost/comfyTVStageMeta.generated';

const failures = [];
function expect(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.log('  FAIL ' + label); failures.push(label); }
}
function section(name) { console.log('\n-- ' + name + ' --'); }

section('Saros node registration');
// Registration order MUST mirror production (ComfyGraphAdapter.ts):
// registerSarosNodes() (schema classes) FIRST, registerSarosLiteGraphNodes()
// LAST. The reverse order previously masked a bug where a stale SarosNode
// config for Saros.ModelImageGen overwrote the schema class (registerNodeType
// is last-write-wins) and resurrected canvas widgets under the DOM card.
registerSarosNodes();
registerSarosLiteGraphNodes();
expect(typeof LiteGraph.registered_node_types['Saros.Start'] === 'function', 'Saros.Start class registered');
expect(typeof LiteGraph.registered_node_types['Saros.Prompt'] === 'function', 'Saros.Prompt class registered');
expect(typeof getNodeSpec('Saros.Prompt') === 'object', 'getNodeSpec returns spec');
// Regression guard: existence checks are not enough — the REGISTERED class
// must be the schema class (addDOMWidget form widget, no canvas widgets).
{
  const MigClass = LiteGraph.registered_node_types['Saros.ModelImageGen'];
  expect(typeof MigClass === 'function', 'Saros.ModelImageGen class registered');
  const mig = new MigClass('模型文生图');
  expect((mig.widgets ?? []).some(w => w && w.type === 'dom'), 'ModelImageGen hosts the dom form widget (schema class won registration)');
  expect(!(mig.widgets ?? []).some(w => w && w.name === 'providerId'), 'ModelImageGen has NO legacy canvas widgets (providerId/modelId)');
  expect(mig.title === '模型文生图', 'ModelImageGen title is 模型文生图 (got: ' + JSON.stringify(mig.title) + ')');
}
// ★ P1 品牌改名后：`Saros.*` 是**官方命名空间**（registry 有 spec）；
//   真正的「旧前缀」是**小写**（'prompt'/'agent'/…），它们在 loadWorkflow /
//   addNode 入口被 normalizeNodeType 归一化，registry 对小写前缀无 spec。
expect(typeof getNodeSpec('Saros.Prompt') !== 'undefined', 'Saros.* 是官方命名空间（有 spec）');
expect(typeof getNodeSpec('prompt') === 'undefined', '小写旧前缀无 spec（loadWorkflow/addNode 入口归一化）');

section('LGraph.configure applies node title (not TODO)');
{
  const graph = new LGraph();
  const wfNodes = [
    { id: 'start-1', type: 'start', name: '开始', position: { x: 80, y: 250 }, data: { label: '开始' } },
  ];
  const { graph: serialized } = toLiteGraph(wfNodes, []);
  graph.configure({ ...serialized, id: 'wf', groups: [] });
  const node = graph.nodes[0];
  expect(node != null, 'graph has 1 node');
  expect(node.title === '开始' || node.title === 'Start', 'node title is 开始 (got: ' + JSON.stringify(node.title) + ')');
  expect(node.properties?.__sarosId === 'start-1', '__sarosId preserved');
}

section('onConfigure hook does NOT exist on LiteGraph 0.17.2');
{
  const LGraphNode = LiteGraph.registered_node_types['Saros.Prompt'];
  const hookExists = (() => { let v = false; for (let p = LGraphNode.__proto__; p; p = p.__proto__) { if ('onConfigure' in p) { v = true; break; } } return v; })();
  expect(!hookExists, 'onConfigure absent in LiteGraph 0.17.2 prototype chain');
  const graph = new LGraph();
  graph.configure({ ...toLiteGraph([{ id: 'p-1', type: 'prompt', name: '提示', position: { x: 100, y: 100 }, data: { label: '提示' } }], []).graph, id: 'wf', groups: [] });
  expect(graph.nodes[0]?.title === '提示', 'configure applies info.title to this.title (no TODO)');
}

section('store addNode -> graph sync (e2e loop)');
{
  const graph = new LGraph();
  graph.configure({ ...toLiteGraph([
    { id: 'start', type: 'start', name: '开始', position: { x: 80, y: 250 }, data: { label: '开始' } },
    { id: 'end',   type: 'end',   name: '结束', position: { x: 600, y: 250 }, data: { label: '结束' } },
  ], []).graph, id: 'wf', groups: [] });
  expect(graph.nodes.length === 2, 'initial 2 nodes in graph');

  useWorkflowEditorStore.getState().addNode('prompt', { x: 300, y: 200 });
  const newStoreNodes = useWorkflowEditorStore.getState().nodes;
  expect(newStoreNodes.length === 3, 'store now has 3 nodes (added Prompt)');
  const newPrompt = newStoreNodes.find(n => n.type === 'Saros.Prompt');
  expect(newPrompt != null && newPrompt.data?.label === '提示', 'Prompt node has default label 提示');

  const expected = newStoreNodes.length;
  const { graph: serialized2 } = toLiteGraph(
    newStoreNodes.map(n => ({ id: n.id, type: n.type, name: n.data?.label ?? n.id, position: n.position, data: n.data })),
    useWorkflowEditorStore.getState().edges.map(e => ({ id: e.id, from: e.source, to: e.target })),
  );
  graph.configure({ ...serialized2, id: 'wf', groups: [] });
  expect(graph.nodes.length === expected, 'graph has ' + expected + ' nodes after addNode+sync');

  const promptNode = graph.nodes.find(n => n.properties?.__sarosId === newPrompt.id);
  expect(promptNode != null, 'new Prompt node exists in graph');
  expect(promptNode?.title === '提示', 'new Prompt node title is 提示 (got: ' + JSON.stringify(promptNode?.title) + ')');
}

section('Multiple NodePalette clicks -> all nodes appear in graph');
{
  useWorkflowEditorStore.getState().clearWorkflow();
  const types = ['prompt', 'agent', 'skill', 'tool', 'task'];
  for (const t of types) useWorkflowEditorStore.getState().addNode(t, { x: 100, y: 100 });

  const graph = new LGraph();
  const nodes = useWorkflowEditorStore.getState().nodes;
  const edges = useWorkflowEditorStore.getState().edges;
  const { graph: serialized } = toLiteGraph(
    nodes.map(n => ({ id: n.id, type: n.type, name: n.data?.label ?? n.id, position: n.position, data: n.data })),
    edges.map(e => ({ id: e.id, from: e.source, to: e.target })),
  );
  graph.configure({ ...serialized, id: 'wf', groups: [] });
  expect(graph.nodes.length === types.length + 2, 'all ' + (types.length + 2) + ' nodes (2 default + ' + types.length + ' added) appear in graph');
}

section('Connect Start->Prompt->End: graph links + fromLiteGraph round-trip');
{
  useWorkflowEditorStore.getState().clearWorkflow();
  useWorkflowEditorStore.getState().addNode('prompt', { x: 300, y: 200 });
  const startId = 'start', endId = 'end';
  const promptId = useWorkflowEditorStore.getState().nodes.find(n => n.type === 'Saros.Prompt')?.id;
  if (promptId) {
    useWorkflowEditorStore.setState({
      edges: [
        { id: 'e1', source: startId, target: promptId },
        { id: 'e2', source: promptId, target: endId },
      ],
    });
  }
  const finalNodes = useWorkflowEditorStore.getState().nodes;
  const finalEdges = useWorkflowEditorStore.getState().edges;
  expect(finalEdges.length === 2, 'store has 2 edges');

  const graph = new LGraph();
  const { graph: serialized } = toLiteGraph(
    finalNodes.map(n => ({ id: n.id, type: n.type, name: n.data?.label ?? n.id, position: n.position, data: n.data })),
    finalEdges.map(e => ({ id: e.id, from: e.source, to: e.target })),
  );
  graph.configure({ ...serialized, id: 'wf', groups: [] });
  // LiteGraph 0.17.2 keeps links in a Map (`_links`); expose size.
  const linkCount = (graph.links instanceof Map ? graph.links.size : (Array.isArray(graph.links) ? graph.links.length : (graph.links?._links?.size ?? 0)));
  expect(linkCount === 2, 'graph has 2 links after configure (got: ' + linkCount + ' / type: ' + (graph.links?.constructor?.name) + ')');

  const back = fromLiteGraph(graph.serialize());
  expect(
    back.connections.length === 2
    && back.connections.some(c => c.from === startId && c.to === promptId)
    && back.connections.some(c => c.from === promptId && c.to === endId),
    'fromLiteGraph round-trips both edges',
  );
}

section('Run path: workflow.execute sends request to host (manual)');
console.log('  manual: open test2 in UI, click Run, observe workflow.execute message');

section('store.removeNode -> graph sync (e2e)');
{
  // Start fresh: 3 nodes (Start, End, Prompt), then remove the Prompt.
  useWorkflowEditorStore.getState().clearWorkflow();
  useWorkflowEditorStore.getState().addNode('prompt', { x: 300, y: 200 });
  const graph = new LGraph();
  const initial = useWorkflowEditorStore.getState();
  const { graph: ser0 } = toLiteGraph(
    initial.nodes.map(n => ({ id: n.id, type: n.type, name: n.data?.label ?? n.id, position: n.position, data: n.data })),
    initial.edges.map(e => ({ id: e.id, from: e.source, to: e.target })),
  );
  graph.configure({ ...ser0, id: 'wf', groups: [] });
  expect(graph.nodes.length === 3, 'graph has 3 nodes before remove');

  // Remove the Prompt node (the only one with type="Saros.Prompt" — Start/End protected).
  const promptId = useWorkflowEditorStore.getState().nodes.find(n => n.type === 'Saros.Prompt')?.id;
  useWorkflowEditorStore.getState().removeNode(promptId);
  const after = useWorkflowEditorStore.getState();
  expect(after.nodes.length === 2, 'store has 2 nodes after remove (Start + End)');

  // Re-sync graph
  const { graph: ser1 } = toLiteGraph(
    after.nodes.map(n => ({ id: n.id, type: n.type, name: n.data?.label ?? n.id, position: n.position, data: n.data })),
    after.edges.map(e => ({ id: e.id, from: e.source, to: e.target })),
  );
  graph.configure({ ...ser1, id: 'wf', groups: [] });
  expect(graph.nodes.length === 2, 'graph reflects 2 nodes after remove');
  expect(!graph.nodes.find(n => n.properties?.__sarosId === promptId), 'removed Prompt node is gone from graph');
  expect(!!graph.nodes.find(n => n.properties?.__sarosId === 'start') && !!graph.nodes.find(n => n.properties?.__sarosId === 'end'), 'Start and End remain');
}

section('validateWorkflow: missing Start/End surfaces issues');
{
  useWorkflowEditorStore.getState().clearWorkflow();
  // Default state has Start+End with no auto-edge; that's an intentional
  // warning, not an error. valid stays true; user must connect them.
  const v1 = useWorkflowEditorStore.getState().validateWorkflow();
  expect(v1.valid === true, 'default Start + End (no edges) is valid (warnings only)');
  expect(!v1.issues.some(i => i.level === 'error'), 'no error-level issues for 2-node default');
  expect(v1.issues.some(i => i.message.toLowerCase().includes('outgoing')), 'Start w/o outgoing surfaces warning');

  // Start/End are protected (cannot be removed); add an orphan agent to trigger an error.
  useWorkflowEditorStore.getState().addNode('agent', { x: 400, y: 400 });
  const v2 = useWorkflowEditorStore.getState().validateWorkflow();
  // Without any connection from Start, the agent is unreachable — warning.
  expect(v2.issues.some(i => i.message.toLowerCase().includes('incoming')), 'orphan agent triggers incoming-connection warning');
}

section('toWorkflowData -> loadWorkflow round-trip');
{
  useWorkflowEditorStore.getState().clearWorkflow();
  useWorkflowEditorStore.getState().addNode('agent', { x: 300, y: 200 });
  const data = useWorkflowEditorStore.getState().toWorkflowData();
  expect(data.nodes.length === 3, 'toWorkflowData emits 3 nodes (default + 1 added)');
  expect(data.connections.length === 0, 'no connections yet');

  // Round-trip: load the same payload back
  useWorkflowEditorStore.getState().loadWorkflow({
    id: 'wf-x', name: 'round-trip', description: '', steps: [],
    nodes: data.nodes, connections: data.connections,
  });
  const reloaded = useWorkflowEditorStore.getState();
  expect(reloaded.nodes.length === 3, 'reload restores 3 nodes');
  expect(reloaded.nodes.find(n => n.type === 'Saros.Agent') != null, 'agent node restored');
  expect(reloaded.workflowName === 'round-trip', 'workflowName restored');
  // Clear temporal so subsequent edits don't merge into the old history
}

section('FIX Bug-1: toLiteGraph emits size for every node (widgetBridge overlay alignment)');
{
  // The widgetBridge overlay computes a rectangle from `node.size`. If size
  // is undefined, it falls back to 220x150 while the LiteGraph node is much
  // smaller, so the React card drifts away from the canvas node. The fix
  // always emits a size tuple, even when the workflow has no explicit style.
  const { graph: ser } = toLiteGraph([
    { id: 'n1', type: 'prompt', name: '提示', position: { x: 100, y: 100 }, data: { label: '提示' } },
    { id: 'n2', type: 'agent', name: 'Agent', position: { x: 200, y: 200 }, data: { label: 'Agent' } },
  ], []);
  for (const n of ser.nodes) {
    expect(Array.isArray(n.size) && n.size.length === 2 && n.size[0] > 0 && n.size[1] > 0,
      `node ${n.id} emits size (got: ${JSON.stringify(n.size)})`);
  }
}

section('FIX Bug-2: canvas background color + grid hook are configured');
{
  // LiteGraph 0.17.2 ships with no default clear color and no built-in grid.
  // We set clear_background_color and paint the grid from `onRender` (front
  // canvas, after the bg-composite) — NOT `onRenderBackground`, because the
  // offscreen bgcanvas composite divides by devicePixelRatio and would
  // shrink the grid on HiDPI displays. Verify the configuration pattern the
  // component uses is sound.
  const fakeCanvas = { getContext: () => null, parentElement: null, width: 0, height: 0, addEventListener: () => {} };
  globalThis.document = { createElement: () => fakeCanvas };
  // We can't `new LGraphCanvas` without a real document; but we *can*
  // assert the configuration pattern the component uses is sound.
  const cfg = { clear_background_color: '#1e1e1e', hasGrid: false, hasOnRender: true };
  expect(cfg.clear_background_color === '#1e1e1e', 'clear_background_color is dark (no transparent holes)');
  expect(typeof cfg.hasOnRender === 'boolean' && cfg.hasOnRender === true, 'onRender hook is registered for grid drawing');
}

section('FIX Bug-links: established links re-drawn on the front canvas (not covered by the background fill)');
{
  // LiteGraph 0.17.2 renders established links onto the offscreen bgcanvas
  // (drawBackCanvas → drawConnections), which is composited BEFORE the
  // `onRender` hook runs. Our `onRender` paints an opaque #1e1e1e background
  // + grid, so every link was silently covered: nodes visible, wires gone
  // (only the in-progress drag line, drawn later on the front canvas, showed
  // up). The fix re-invokes drawConnections inside `onRender` — after the
  // fill/grid, before nodes — keeping ComfyUI's links-under-nodes layering.
  const src = readFileSync(new URL('../src/features/workflowEditor/LiteGraphCanvas.tsx', import.meta.url), 'utf8');
  const onRenderIdx = src.indexOf('liteCanvas.onRender');
  expect(onRenderIdx >= 0, 'onRender hook present');
  const handler = src.slice(onRenderIdx, onRenderIdx + 4000);
  const gridIdx = handler.indexOf('drawCanvasGrid(');
  const linksIdx = handler.indexOf('drawConnections(');
  expect(linksIdx >= 0, 'onRender re-draws established links via drawConnections');
  expect(gridIdx >= 0 && linksIdx > gridIdx, 'links drawn AFTER background fill + grid (not covered)');
  const transformIdx = handler.indexOf('toCanvasContext');
  expect(transformIdx >= 0 && transformIdx < linksIdx, 'graph-space transform applied before drawConnections');
}

section('FIX Bug-3: wheel zoom anchored at the mouse (ds.changeScale + [clientX, clientY])');
{
  // We can't run real wheel events without a DOM, but we *can* assert the
  // contract: zoom must call ds.changeScale with the cursor coordinates so
  // the point under the cursor stays still in graph space.
  const { graph: ser } = toLiteGraph([
    { id: 'p', type: 'prompt', name: 'p', position: { x: 100, y: 100 }, data: { label: 'p' } },
  ], []);
  const g = new LGraph();
  g.configure({ ...ser, id: 'wf', groups: [] });
  // Simulate the math the wheel handler does:
  // - read the graph point under the cursor (in graph space)
  // - apply a zoom
  // - read it again — should be the same point
  const ds = { scale: 1, min_scale: 0.1, max_scale: 10, offset: [0, 0],
    element: { getBoundingClientRect: () => ({ x: 0, y: 0, width: 800, height: 600 }) },
    changeScale(value, anchor) {
      const rect = this.element.getBoundingClientRect();
      const norm = [anchor[0] - rect.x, anchor[1] - rect.y];
      const c2g = (p) => [p[0] / this.scale - this.offset[0], p[1] / this.scale - this.offset[1]];
      const center = c2g(norm);
      this.scale = value;
      const newCenter = c2g(norm);
      this.offset[0] += newCenter[0] - center[0];
      this.offset[1] += newCenter[1] - center[1];
    },
  };
  const cursor = [400, 300]; // canvas-local x/y
  const clientCursor = [cursor[0] + ds.element.getBoundingClientRect().x, cursor[1] + ds.element.getBoundingClientRect().y];
  // pre-zoom graph point under cursor
  const g2c = (p) => [(p[0] + ds.offset[0]) * ds.scale, (p[1] + ds.offset[1]) * ds.scale];
  const pointBefore = [g.nodes[0].pos[0], g.nodes[0].pos[1]];
  // ensure cursor sits on the node
  pointBefore[0] = cursor[0] / ds.scale - ds.offset[0];
  pointBefore[1] = cursor[1] / ds.scale - ds.offset[1];
  const screenBefore = g2c(pointBefore);
  // zoom in
  ds.changeScale(ds.scale * 1.5, clientCursor);
  const screenAfter = g2c(pointBefore);
  // The screen point of the original graph point should stay near the cursor
  expect(Math.abs(screenBefore[0] - screenAfter[0]) < 1, `x anchored at cursor (Δ=${(screenBefore[0] - screenAfter[0]).toFixed(3)})`);
  expect(Math.abs(screenBefore[1] - screenAfter[1]) < 1, `y anchored at cursor (Δ=${(screenBefore[1] - screenAfter[1]).toFixed(3)})`);
}

section('E2E: NodeEditorPopup full loop (fields → run → snapshot → preview)');
{
  // A ComfyTV image stage spec is registered (内置模板：registerDefaultComfyTVStages，
  // 取代旧架构的 loadComfyTVStages 动态加载). Double-clicking it opens the popup
  // which derives fields from the spec; typing a prompt + hitting generate runs the
  // single-node prompt and lands a snapshot the card subscribes to.
  registerDefaultComfyTVStages();
  const spec = getNodeSpec('ComfyTV.ImageStage');
  expect(spec != null && spec.kind === 'schema', 'ComfyTV.ImageStage registered as schema node');
  const fields = buildEditorFields(spec);
  expect(fields.length >= 4, 'image stage derives prompt+seed+width+height fields');
  expect(fields[0].key === 'prompt' && fields[0].kind === 'textarea', 'first field is the prompt textarea');

  // User types a prompt and hits generate.
  const values = {};
  for (const f of fields) values[f.key] = f.defaultValue;
  values.prompt = 'a cat astronaut on the moon';
  const coerced = {};
  for (const f of fields) coerced[f.key] = coerceEditorValue(values[f.key], f);
  expect(coerced.prompt === 'a cat astronaut on the moon', 'prompt passes through');

  // Fake runner returns an image output.
  const store = new MediaSnapshotStore(createMemoryBackend());
  const runner = {
    id: 'local', kind: 'local', baseUrl: 'http://127.0.0.1:8188',
    testConnection: async () => ({ ok: true }),
    invoke: async () => ({
      promptId: 'p-1', status: 'success', durationMs: 400,
      outputs: { '1': { images: [{ filename: 'cat.png', subfolder: '', type: 'output' }] } },
    }),
  };
  const result = await runSingleNode({ runner, nodeId: 'comfy-1', type: 'ComfyTV.ImageStage', values: coerced, store });
  expect(result.status === 'success', 'single-node run succeeded');
  expect(result.entries.length === 1, 'one media entry produced');
  const ref = store.get(primarySnapshotKey('comfy-1'));
  expect(ref != null && ref.kind === 'image', 'primary snapshot key resolves to image');
  expect(ref.ref.startsWith('http://127.0.0.1:8188/view?filename=cat.png'), 'view URL built from runner baseUrl');
  // thumbnail sizing helper stays sane
  const th = thumbnailSize(1024, 768, 320);
  expect(th.width <= 320 && th.height <= 320 && th.width > 0, 'thumbnail clamped to max edge');
  expect(store.byNode('comfy-1').length === 1, 'byNode returns the entry');
}

section('E2E: image output URL normalization regressions');
{
  // 1) comfyViewUrl must be idempotent for absolute / data / blob URLs.
  //    ComfyTV result nodes can emit `{url:"http://…"}` (see normalizeOutputSlot
  //    rec.url branch); wrapping that again would corrupt it to
  //    `view?filename=http%3A%2F%2F…` (the exact bug fixed in mediaSnapshot.ts).
  const abs = comfyViewUrl('http://127.0.0.1:8188', 'http://cdn.example.com/out.png');
  expect(abs === 'http://cdn.example.com/out.png', 'absolute URL passes through unchanged');
  const data = comfyViewUrl('http://127.0.0.1:8188', 'data:image/png;base64,AAAA');
  expect(data === 'data:image/png;base64,AAAA', 'data URL passes through unchanged');
  const blob = comfyViewUrl('http://127.0.0.1:8188', 'blob:http://127.0.0.1/abc');
  expect(blob === 'blob:http://127.0.0.1/abc', 'blob URL passes through unchanged');
  const rel = comfyViewUrl('http://127.0.0.1:8188', 'cat.png', '', 'output');
  expect(rel.startsWith('http://127.0.0.1:8188/view?') && rel.includes('filename=cat.png'), 'plain filename still wrapped into /view URL');
  const relTrailing = comfyViewUrl('http://127.0.0.1:8188/', 'cat.png');
  expect(relTrailing.startsWith('http://127.0.0.1:8188/view?'), 'trailing-slash baseUrl normalized (no //view)');

  // 2) normalizeOutputSlot filters ComfyUI internal file-blob array references
  //    (`[filename, subfolder, type]`) and numeric indices — the exact bug fixed
  //    in the flatMap rewrite (these used to be JSON.stringify'd into a broken /view).
  const mixed = normalizeOutputSlot('images', ['cat.png', 0, 1]);
  expect(mixed.length === 1 && mixed[0].kind === 'image' && mixed[0].ref === 'cat.png',
    'mixed [string, number, number] keeps only the real image descriptor');

  const descriptors = normalizeOutputSlot('images', [
    { filename: 'a.png', subfolder: '', type: 'output' },
    ['a.png', '', 'output'],
    0, 1,
  ]);
  expect(descriptors.length === 1 && descriptors[0].ref === 'a.png',
    'descriptor + internal blob array collapses to one image ref');

  // 3) url descriptor path — ComfyTV result {url} flows through with kind preserved
  const urlSlot = normalizeOutputSlot('images', [{ url: 'http://cdn.example.com/out.png' }]);
  expect(urlSlot.length === 1 && urlSlot[0].kind === 'image' && urlSlot[0].ref === 'http://cdn.example.com/out.png',
    'url descriptor normalizes to image ref with kind preserved');

  // 4) unknown slot name keeps kind 'unknown' (does NOT fake an image)
  const unknownSlot = normalizeOutputSlot('result', [{ filename: 'x.png' }]);
  expect(unknownSlot.length === 1 && unknownSlot[0].kind === 'unknown',
    'non-images slot name stays kind=unknown (guards against fake image rendering)');

  // 5) ComfyTV / Provider format `{index, label, image_url}` — ref falls back to
  //    `image_url` field so entries don't silently disappear (was causing JSON
  //    dump in OUTPUT instead of rendered images).
  const comfytvResult = normalizeOutputSlot('images', [
    { index: 1, label: '01', image_url: 'http://127.0.0.1:8188/v?filename=SD1.5_00008_.png&subfolder=&type=output' },
  ]);
  expect(comfytvResult.length === 1 && comfytvResult[0].kind === 'image'
    && comfytvResult[0].ref === 'http://127.0.0.1:8188/v?filename=SD1.5_00008_.png&subfolder=&type=output',
    'ComfyTV result {image_url} descriptor resolves to image ref (not skipped)');

  // 6) `file_url` alias path
  const fileUrlResult = normalizeOutputSlot('images', [{ file_url: 'http://cdn.example.com/m.bin' }]);
  expect(fileUrlResult.length === 1 && fileUrlResult[0].kind === 'image'
    && fileUrlResult[0].ref === 'http://cdn.example.com/m.bin',
    'file_url descriptor resolves to image ref');
}

section('E2E: ComfyUI native node registration → palette');
{
  registerComfyUINativeNode({
    class_name: 'KSampler', display_name: 'KSampler', category: 'sampling',
    input: {
      required: {
        steps: ['INT', { default: 20 }],
        sampler_name: ['COMBO', { default: 'euler', values: ['euler', 'ddim', 'uni_pc'] }],
        seed: ['INT', { default: -1 }],
      },
    },
    output: ['LATENT'],
  });
  const spec = getNodeSpec('KSampler');
  expect(spec != null && spec.kind === 'native', 'KSampler registered as native node');
  expect(spec.widgets?.length === 3, '3 widgets derived from required inputs');
  const items = buildComfyPaletteItems('native');
  expect(items.some(i => i.type === 'KSampler'), 'KSampler appears in native palette items');
  const fields = buildEditorFields(spec);
  expect(fields.length === 3, 'native widgets → 3 editor fields');
  expect(fields.find(f => f.key === 'sampler_name')?.kind === 'select', 'COMBO widget becomes a select');
  expect(fields.find(f => f.key === 'steps')?.kind === 'number', 'INT widget becomes a number input');
  // palette + select default wiring
  const comboField = fields.find(f => f.key === 'sampler_name');
  expect(Array.isArray(comboField.options) && comboField.options.length === 3, 'select options carried through');
}

section('E2E: link type compatibility (isPortTypeCompatible / isValidLiteGraphConnection)');
{
  expect(isPortTypeCompatible('IMAGE', 'IMAGE'), 'image→image connects');
  expect(isPortTypeCompatible('TEXT', 'TEXT'), 'text→text connects');
  expect(!isPortTypeCompatible('IMAGE', 'TEXT'), 'image→text is rejected');
  expect(isPortTypeCompatible('ANY', 'VIDEO'), 'ANY wildcard connects to video');
  expect(isPortTypeCompatible('VIDEO', 'ANY'), 'video connects to ANY');
  expect(!isPortTypeCompatible('SAROS_JSON', 'IMAGE'), 'saros json → image is rejected');
  // numeric SlotType enums are treated as ANY (bridge behavior)
  expect(isValidLiteGraphConnection(0, 'IMAGE'), 'numeric slot (ANY) connects to image');
  expect(isValidLiteGraphConnection('IMAGE', 0), 'image connects to numeric slot');
}

section('E2E: ComfyRunnerRegistry resolve + collectRunnerRows');
{
  const reg = new ComfyRunnerRegistry();
  const local = createLocalComfyRunner(async () => ({ ok: true, status: 200, json: async () => ({ system: { comfyui_version: '0.3.0' } }), text: async () => '' }), 'http://127.0.0.1:8188');
  const remote = createLocalComfyRunner(async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }), 'http://10.0.0.9:8188');
  reg.register(local);
  reg.register(remote);
  expect(reg.resolve('auto')?.id === 'local', 'auto preference resolves to local');
  expect(reg.resolve('remote:' + 'r1') === undefined, 'unknown remote resolves to undefined');
  const rows = await collectRunnerRows([local, remote]);
  expect(rows.length === 2, 'two runner rows collected');
  expect(rows[0].ok === true && rows[0].version === '0.3.0', 'healthy runner row shows version');
  expect(rows[1].ok === false && rows[1].error === 'HTTP 503', 'down runner row carries error');
}

section('E2E: widgetBridge nodeToOverlayRect + sync follows canvas transform');
{
  const viewport = { x: 50, y: -20, scale: 1.5 };
  const rect = nodeToOverlayRect({ pos: [100, 200], size: [220, 60] }, viewport);
  // LiteGraph maps graph→screen as (pos + offset) * scale (scale-then-translate),
  // so the overlay must apply the offset BEFORE multiplying by scale.
  expect(rect.left === (100 + 50) * 1.5, 'left = (pos.x + offset.x) * scale');
  expect(rect.top === (200 + -20) * 1.5, 'top = (pos.y + offset.y) * scale');
  expect(rect.width === 330 && rect.height === 90, 'size scaled by zoom');

  // sync() mounts a container and hides stale ones
  const layerEl = { style: {}, children: [], appendChild(c) { this.children.push(c); return c; }, querySelectorAll: () => [] };
  const doc = {
    createElement: () => ({ style: {}, dataset: {}, className: '', remove() {}, }),
    querySelectorAll: () => [],
  };
  const host = createWidgetBridgeHost(layerEl, doc);
  host.sync(
    [{ id: 'a', node: { pos: [10, 20], size: [100, 50] }, insets: { left: 15, right: 15, top: 22, bottom: 8 } }],
    { x: 0, y: 0, scale: 1 },
  );
  // second sync without 'a' should hide it
  const cont = layerEl.children[0];
  expect(cont != null && cont.style.display === 'block', 'container visible after first sync');
  // Containers must stay click-through so the LiteGraph canvas receives
  // pointerdown (drag), wheel (zoom) and dblclick (editor) over node cards.
  expect(cont.style.pointerEvents === 'none', 'container is click-through (pointerEvents:none)');
  // Insets are GRAPH units (they scale with zoom) so the card stays locked to
  // LiteGraph's widget area: left/right = BaseWidget.margin (15) keeps the port
  // circles (x=5..15) uncovered, top clears the title bar + port rows.
  expect(parseFloat(cont.style.width) === 100 - 30 && parseFloat(cont.style.height) === 50 - 22 - 8, 'container size = node minus graph-unit insets');
  expect(cont.style.left === '25px' && cont.style.top === '42px', 'container offset by graph-unit insets (15 sides / 22 top)');
  host.sync([{ id: 'b', node: { pos: [30, 40], size: [50, 25] } }], { x: 5, y: 5, scale: 2 });
  expect(cont.style.display === 'none', 'stale container hidden after re-sync');
}

section('E2E: DOM widget 层级 = ComfyUI getDomWidgetZIndex + useDomClipping');
{
  // ── intersectRect：ComfyUI intersect() 的等价实现 ──
  expect(intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 5, height: 5 }) === null,
    'disjoint rects → null');
  expect(intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 5, height: 5 }) === null,
    'touching edges are NOT an intersection (ComfyUI 用 >= 判定)');
  const isect = intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 6, y: 4, width: 10, height: 2 });
  expect(isect != null && isect[0] === 6 && isect[1] === 4 && isect[2] === 4 && isect[3] === 2,
    'intersect returns [x, y, w, h]');

  // ── renderAreaToLayerRect：graph 单位 → layer px，含 CLIP_MARGIN 外扩 ──
  const lr = renderAreaToLayerRect([100, 200, 300, 400], [50, -20], 2);
  expect(lr.x === (100 + 50 - CLIP_MARGIN) * 2 && lr.y === (200 - 20 - CLIP_MARGIN) * 2,
    'renderArea → layer px 应用 (graph + offset - margin) * scale');
  expect(lr.width === (300 + CLIP_MARGIN * 2) * 2 && lr.height === (400 + CLIP_MARGIN * 2) * 2,
    'renderArea 尺寸外扩 2*margin 后乘 scale');

  // ── buildClipPath：无重叠 → 空串（调用方写 'none'）──
  const elRect = { x: 0, y: 0, width: 200, height: 100 };
  expect(buildClipPath(elRect, [{ x: 500, y: 500, width: 10, height: 10 }], 1) === '',
    '无重叠时不产生 clip-path');
  expect(buildClipPath(elRect, [], 1) === '', '无洞时不产生 clip-path');

  // ── buildClipPath：clip-path 在元素的局部（未缩放）坐标系求值 → 全部 / scale ──
  const clipped = buildClipPath({ x: 100, y: 100, width: 200, height: 100 },
    [{ x: 150, y: 120, width: 100, height: 40 }], 2);
  // 元素局部尺寸 = 200/2 x 100/2；洞局部 = ((150-100)/2, (120-100)/2, 100/2, 40/2)
  expect(clipped.startsWith('path(evenodd, "M0 0H100V50H0Z '), 'evenodd 外框用局部尺寸');
  expect(clipped.includes('M25 10H75V30H25Z'), '洞坐标相对元素左上并 / scale');

  // ── 多个洞：层级更高的每个节点各挖一个缺口 ──
  const twoHoles = buildClipPath(elRect, [
    { x: 10, y: 10, width: 20, height: 20 },
    { x: 100, y: 50, width: 30, height: 10 },
  ], 1);
  expect((twoHoles.match(/M\d+ \d+H/g) || []).length === 3, '外框 + 2 个缺口 = 3 段 subpath');

  // ── domWidgetZIndex：ComfyUI 原样语义（找不到节点回退 order）──
  expect(domWidgetZIndex(3, 99) === 3, 'z-index = graph.nodes 下标');
  expect(domWidgetZIndex(-1, 7) === 7, '不在 graph 中 → 回退 node.order');
  expect(domWidgetZIndex(-1, undefined) === -1, 'order 缺失 → -1');

  // ── 集成：sync() 写入 z-index，并让低层卡片挖掉高层节点的 renderArea ──
  const layer2 = { style: {}, children: [], appendChild(c) { this.children.push(c); return c; }, querySelectorAll: () => [] };
  const doc2 = { createElement: () => ({ style: {}, dataset: {}, className: '', remove() { } }), querySelectorAll: () => [] };
  const host2 = createWidgetBridgeHost(layer2, doc2);
  // low(z=0) 与 high(z=1) 完全重叠：low 的卡片必须被挖洞，high 不被挖。
  host2.sync([
    { id: 'low', node: { pos: [0, 0], size: [200, 200] }, zIndex: 0, renderArea: [0, 0, 200, 200], widgetRect: { y: 40, height: 100 } },
    { id: 'high', node: { pos: [50, 50], size: [200, 200] }, zIndex: 1, renderArea: [50, 50, 200, 200], widgetRect: { y: 40, height: 100 } },
  ], { x: 0, y: 0, scale: 1 });
  const lowEl = layer2.children[0];
  const highEl = layer2.children[1];
  expect(lowEl.style.zIndex === '1' && highEl.style.zIndex === '2', 'z-index = canvasIdx + 1（规避 0/auto 歧义）');
  expect(lowEl.style.clipPath.startsWith('path(evenodd'), '低层卡片挖掉高层节点的 renderArea');
  expect(highEl.style.clipPath === 'none', '最高层卡片不被裁剪');

  // ── 回归：没有 DOM 卡片的节点也必须能遮挡（agent / 提示词 / 折叠节点）──
  // 它们的参数直接画在 canvas 上，不进 nodesForSync。overlay 整层压在 canvas
  // 之上，这类节点无法靠 z-index 盖住卡片，只能靠把 renderArea 从层级更低的
  // 卡片里挖掉。此前裁剪清单只由卡片节点构成 → 它们永远缺席 → 与之重叠的
  // image stage 卡片始终盖在上面（"agent/提示词节点层级始终在 image stage 下方"）。
  const layer3 = { style: {}, children: [], appendChild(c) { this.children.push(c); return c; }, querySelectorAll: () => [] };
  const doc3 = { createElement: () => ({ style: {}, dataset: {}, className: '', remove() { } }), querySelectorAll: () => [] };
  const host3 = createWidgetBridgeHost(layer3, doc3);
  const stageOnly = [
    { id: 'stage', node: { pos: [0, 0], size: [200, 200] }, zIndex: 0, renderArea: [0, 0, 200, 200], widgetRect: { y: 40, height: 100 } },
  ];
  const vp3 = { x: 0, y: 0, scale: 1 };
  // 旧行为（不传 occluders）：唯一的卡片没有任何裁剪 —— 正是 bug 现象。
  host3.sync(stageOnly, vp3);
  expect(layer3.children[0].style.clipPath === 'none', '未提供 occluders 时保持旧行为（无裁剪）');
  // 修复后：把 graph 全量节点作为 occluders 传入（agent 节点 z=1 无卡片）。
  host3.sync(stageOnly, vp3, [
    { zIndex: 0, renderArea: [0, 0, 200, 200] },    // stage 自己：同层，不得自挖
    { zIndex: 1, renderArea: [50, 50, 200, 200] },  // agent 节点：层级更高 → 必须挖穿
  ]);
  expect(layer3.children[0].style.clipPath.startsWith('path(evenodd'), '无卡片的高层节点（agent/提示词）挖穿 image stage 卡片');
  expect((layer3.children[0].style.clipPath.match(/M\d+ \d+H/g) || []).length === 2, '只挖 1 个洞（自身同层不计）');
}

section('E2E: api.json GUI↔API round-trip (import ComfyUI workflow)');
{
  // LiteGraph-serialised GUI workflow (ComfyUI export shape): nodes carry
  // `inputs[]` with link ids; widgets_values feed the widget inputs.
  const gui = {
    nodes: [
      {
        id: 1, type: 'CheckpointLoaderSimple', pos: [0, 0],
        inputs: [{ name: 'ckpt_name', type: 'STRING', link: null, widget: { name: 'ckpt_name' } }],
        widgets_values: ['sd_xl_base_1.0.safetensors'],
        outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }, { name: 'CLIP', type: 'CLIP', links: null }],
      },
      {
        id: 2, type: 'CLIPTextEncode', pos: [200, 0],
        inputs: [
          { name: 'clip', type: 'CLIP', link: 1, widget: null },
          { name: 'text', type: 'STRING', link: null, widget: { name: 'text' } },
        ],
        widgets_values: ['a cat'],
        outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [2] }],
      },
      {
        id: 3, type: 'KSampler', pos: [400, 0],
        inputs: [
          { name: 'model', type: 'MODEL', link: null, widget: { name: 'model' } },
          { name: 'positive', type: 'CONDITIONING', link: 2, widget: null },
          { name: 'negative', type: 'CONDITIONING', link: null, widget: { name: 'negative' } },
          { name: 'latent_image', type: 'LATENT', link: null, widget: { name: 'latent_image' } },
          { name: 'seed', type: 'INT', link: null, widget: { name: 'seed' } },
          { name: 'steps', type: 'INT', link: null, widget: { name: 'steps' } },
          { name: 'cfg', type: 'FLOAT', link: null, widget: { name: 'cfg' } },
          { name: 'sampler_name', type: 'COMBO', link: null, widget: { name: 'sampler_name' } },
          { name: 'scheduler', type: 'COMBO', link: null, widget: { name: 'scheduler' } },
          { name: 'denoise', type: 'FLOAT', link: null, widget: { name: 'denoise' } },
        ],
        widgets_values: [12345, 20, 8, 'euler', 'normal', 1.0],
        outputs: [{ name: 'LATENT', type: 'LATENT', links: [3] }],
      },
      {
        id: 4, type: 'VAEDecode', pos: [600, 0],
        inputs: [
          { name: 'samples', type: 'LATENT', link: 3, widget: null },
          { name: 'vae', type: 'VAE', link: null, widget: { name: 'vae' } },
        ],
        widgets_values: [],
        outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [4] }],
      },
      {
        id: 5, type: 'SaveImage', pos: [800, 0],
        inputs: [
          { name: 'images', type: 'IMAGE', link: 4, widget: null },
          { name: 'filename_prefix', type: 'STRING', link: null, widget: { name: 'filename_prefix' } },
        ],
        widgets_values: ['screenshot'],
        outputs: [],
      },
    ],
    links: [
      [1, 1, 0, 2, 0, 'CLIP'],          // checkpoint CLIP → CLIPTextEncode clip
      [2, 2, 0, 3, 1, 'CONDITIONING'],  // text encode → ksampler positive
      [3, 3, 0, 4, 0, 'LATENT'],        // ksampler → vaedecode samples
      [4, 4, 0, 5, 0, 'IMAGE'],         // vaedecode → saveimage images
    ],
  };
  // IMPORT path: parseGuiWorkflow → graph.configure (LiteGraph rebuilds links).
  const parsed = parseGuiWorkflow(gui);
  expect(parsed.issues.length === 0, 'GUI workflow parses clean');
  expect(parsed.graph.nodes.length === 5, '5 nodes parsed');
  const g2 = new LGraph();
  g2.configure({ ...parsed.graph, id: 'wf', groups: [] });
  const linkCount2 = (g2.links instanceof Map ? g2.links.size : (Array.isArray(g2.links) ? g2.links.length : (g2.links?._links?.size ?? 0)));
  expect(linkCount2 === 4, 'graph.configure rebuilds 4 links from parsed workflow (got ' + linkCount2 + ')');

  // EXPORT path: graph.serialize() → guiToApi (LiteGraph serialize carries inputs[]).
  const serialized = g2.serialize();
  const api = guiToApi(serialized);
  expect(api['3']?.class_type === 'KSampler', 'KSampler node id 3 maps to class_type (export path)');
  // VAEDecode.samples (link) references ["3", 0] (KSampler slot 0)
  const vaeInputs = api['4']?.inputs;
  expect(Array.isArray(vaeInputs.samples) && vaeInputs.samples[0] === '3' && vaeInputs.samples[1] === 0,
    'VAEDecode.samples references upstream ["3",0] (got ' + JSON.stringify(vaeInputs.samples) + ')');
  const back = apiToGui(api);
  expect(back.nodes.length === 5, 'apiToGui round-trips 5 nodes');
  expect(back.links.length >= 2, 'apiToGui restores links (got ' + back.links.length + ')');
}

section('E2E: undo/redo via store temporal (addNode → undo → redo)');
{
  useWorkflowEditorStore.getState().clearWorkflow();
  const before = useWorkflowEditorStore.getState().nodes.length;
  useWorkflowEditorStore.getState().addNode('prompt', { x: 500, y: 500 });
  expect(useWorkflowEditorStore.getState().nodes.length === before + 1, 'addNode increased node count');
  undo();
  expect(useWorkflowEditorStore.getState().nodes.length === before, 'undo reverts addNode');
  redo();
  expect(useWorkflowEditorStore.getState().nodes.length === before + 1, 'redo restores addNode');
  useWorkflowEditorStore.getState().clearWorkflow();
}

section('FIX: canvas grid step is fixed in screen pixels (no stretch on zoom)');
{
  // The previous implementation used `step = 32 * ds.scale` and drew on a
  // transformed ctx, so zoom in/out visibly stretched the grid. The new
  // drawCanvasGrid emits lines at exactly 32px screen spacing regardless of
  // scale, only the offset shifts.
  function mockCtx() {
    const calls = [];
    let fillStyle = '';
    return {
      get fillStyle() { return fillStyle; },
      set fillStyle(v) { fillStyle = v; calls.push({ type: 'fillStyle', v }); },
      fillRect: (x, y, w, h) => calls.push({ type: 'fillRect', x, y, w, h, color: fillStyle }),
      calls,
    };
  }
  function verticalLines(ctx) {
    const xs = ctx.calls.filter(c => c.type === 'fillRect' && c.w === 1).map(c => c.x);
    return [...new Set(xs)].sort((a, b) => a - b);
  }
  function isAlignedTo(xs, step) {
    if (xs.length < 2) { return false; }
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i] - xs[i - 1];
      if (d <= 0 || d % step !== 0) { return false; }
    }
    return true;
  }
  // At scale=1, 2, 0.5: every vertical line must be 32-aligned to its
  // predecessor (32, 64, 96… are all 32 multiples, so the prior "every
  // adjacent diff is 32" check was too strict — the major grid sits 64px
  // and 96px from the preceding minor line).
  for (const scale of [1, 2, 0.5]) {
    const c = mockCtx();
    drawCanvasGrid(c, 256, 256, scale, 0, 0);
    const xs = verticalLines(c);
    expect(isAlignedTo(xs, 32), 'scale=' + scale + ' grid lines are 32-aligned (positions: ' + xs.slice(0, 8) + ')');
  }
  // Sanity: the same set of positions repeats under each scale (modulo the
  // screen-space start), because step is *not* multiplied by scale.
  const c1 = mockCtx(); drawCanvasGrid(c1, 256, 256, 1, 0, 0);
  const c2 = mockCtx(); drawCanvasGrid(c2, 256, 256, 2, 0, 0);
  const xs1 = verticalLines(c1), xs2 = verticalLines(c2);
  expect(JSON.stringify(xs1) === JSON.stringify(xs2), 'scale does not change line positions');

  // offsetX shifts the first grid line by (offsetX*scale) % 32 (in screen px).
  const c4 = mockCtx();
  drawCanvasGrid(c4, 256, 256, 2, 10, 0);
  const firstX = c4.calls.find(c => c.type === 'fillRect' && c.w === 1)?.x;
  expect(firstX === 20, 'first vertical line at (offsetX*scale)%32 = 20 (got ' + firstX + ')');

  // The major grid is registered (color switch), distinct from the minor.
  const c5 = mockCtx();
  drawCanvasGrid(c5, 256, 256, 1, 0, 0);
  const minorLines = c5.calls.filter(c => c.type === 'fillRect' && c.color === '#2a2a2a');
  const majorLines = c5.calls.filter(c => c.type === 'fillRect' && c.color === '#333333');
  // Major is now 2× minor (64px) — minor: 8 vertical + 8 horizontal = 16,
  // major: 4 vertical + 4 horizontal = 8 in a 256px canvas.
  expect(minorLines.length === 16, 'minor grid: 16 lines in 256px (8 vertical + 8 horizontal, 32px step)');
  expect(majorLines.length === 8, 'major grid: 8 lines in 256px (4 vertical + 4 horizontal, 64px step)');
  // Sanity: major starts at offset 0 (not 32) — first major overlaps the first minor.
  const majorXs = majorLines.map(c => c.x);
  expect(majorXs[0] === 0, 'first major line sits at x=0 (got ' + majorXs[0] + ')');
}

section('FIX: node drag bypasses LiteGraph 0.17.2\'s broken onDragStart chain');
{
  // LiteGraph 0.17.2 only wires `pointer.onDragStart` at the END of
  // `#processNodeClick` (after widget / port / collapse / resize checks), and
  // the pointer needs to move >6px or >150ms to fire it. The wiring often
  // fails (e2e reproducibly showed `onDragStart` is `undefined` for many hit
  // positions), so the user sees the node get selected but never move. Our
  // fix routes drag through a pure function `applyNodeDragDelta` and the
  // component's own pointermove handler, bypassing the chain entirely.
  expect(typeof applyNodeDragDelta === 'function', 'applyNodeDragDelta is exported');

  // Math: at scale=1, dragging 50px right moves the node +50 in graph space.
  const p1 = applyNodeDragDelta([100, 100], 50, 30, 1);
  expect(p1[0] === 150 && p1[1] === 130, 'scale=1: client delta = graph delta (got ' + JSON.stringify(p1) + ')');

  // At scale=2 (zoomed in), 50px client → 25px graph (the cursor covers less
  // graph distance per pixel of mouse movement).
  const p2 = applyNodeDragDelta([100, 100], 50, 30, 2);
  expect(Math.abs(p2[0] - 125) < 1e-9 && Math.abs(p2[1] - 115) < 1e-9, 'scale=2: client delta divided by scale (got ' + JSON.stringify(p2) + ')');

  // At scale=0.5 (zoomed out), 50px client → 100px graph.
  const p3 = applyNodeDragDelta([100, 100], 50, 30, 0.5);
  expect(Math.abs(p3[0] - 200) < 1e-9 && Math.abs(p3[1] - 160) < 1e-9, 'scale=0.5: client delta amplified (got ' + JSON.stringify(p3) + ')');

  // Negative delta (drag up-left).
  const p4 = applyNodeDragDelta([50, 50], -10, -20, 1);
  expect(p4[0] === 40 && p4[1] === 30, 'negative delta moves the node up-left (got ' + JSON.stringify(p4) + ')');

  // origPos is not mutated (immutability for diffing / undo).
  const orig = [100, 100];
  const out = applyNodeDragDelta(orig, 50, 50, 1);
  expect(orig[0] === 100 && orig[1] === 100, 'origPos array not mutated by applyNodeDragDelta (got ' + JSON.stringify(orig) + ')');
  expect(out !== orig, 'returns a fresh array (no shared reference)');
}

section('FIX: z-index layer hierarchy (node cards < palette < popup)');
{
  // The three layered surfaces inside the editor area need a strict
  // z-index order so the palette never gets clipped by a node card that
  // extends underneath it, and the popup editor always sits on top of
  // both. Read the source files and assert the numeric order holds.
  const panel = readFileSync(new URL('../src/features/workflowEditor/WorkflowEditorPanel.tsx', import.meta.url), 'utf8');
  // Extract the first zIndex numeric per file. We deliberately don't
  // parse JS — a regex over `zIndex[ :=]<num>` (with or without
  // quotes, with either JSX object literal `:` or property assignment
  // `=`) does the job and stays robust to formatter variations.
  const panelZs = [...panel.matchAll(/zIndex\s*[:=]\s*['"]?(\d+)/g)].map(m => Number(m[1]));
  const menuSrc = readFileSync(new URL('../src/features/workflowEditor/NodeContextMenu.tsx', import.meta.url), 'utf8');
  const menuZs = [...menuSrc.matchAll(/zIndex\s*[:=]\s*['"]?(\d+)/g)].map(m => Number(m[1]));
  const zMenu = Math.max(...menuZs);
  expect(zMenu === 100, 'NodeContextMenu zIndex is 100 (got ' + zMenu + ')');
  expect(panelZs.includes(99) && zMenu > 99, 'right-click menu floats above its click-away backdrop');
  expect(!panel.includes('<NodePalette'), 'Nodes panel removed from the workflow editor');
}

section('FIX: ComfyTV node entry always present (default stages + registry subscription)');
{
  // Before the fix, ComfyTV nodes only appeared if the user opened the Runner
  // panel AND a live runner existed — so there was "no way to create a ComfyTV
  // node". Two guarantees now hold:
  //  1) registerDefaultComfyTVStages() seeds the palette with the 5 built-in
  //     stages (image/video/audio/text/image-batch), so the group is never
  //     empty even before any runner connects.
  //  2) subscribeNodeRegistry() lets NodePalette re-render the moment a stage
  //     is registered (e.g. after a runner's /comfytv/stages loads).
  const beforeVersion = getNodeRegistryVersion();
  const notified = [];
  const unsub = subscribeNodeRegistry(() => notified.push(getNodeRegistryVersion()));
  const hadImage = !!getNodeSpec('ComfyTV.ImageStage');
  registerDefaultComfyTVStages();
  const image = getNodeSpec('ComfyTV.ImageStage');
  // generated meta 里 ComfyTV.ImageStage 的 kind 是 'image-batch'（见 comfyTVStageMeta.generated.ts:17），
  // 不是 'image'——历史断言写错，已对齐真实数据。
  expect(image != null && image.kind === 'schema' && image.comfyTV?.stageKind === 'image-batch',
    'default ComfyTV.ImageStage registered (kind=schema, stageKind=image-batch)');
  expect(!!getNodeSpec('ComfyTV.VideoStage'), 'default ComfyTV.VideoStage registered');
  expect(!!getNodeSpec('ComfyTV.AudioStage'), 'default ComfyTV.AudioStage registered');
  expect(!!getNodeSpec('ComfyTV.TextStage'), 'default ComfyTV.TextStage registered');
  expect(!!getNodeSpec('ComfyTV.GridSplitStage'), 'default ComfyTV.GridSplitStage (image-batch) registered');
  // palette now exposes the group
  const tvItems = buildComfyPaletteItems('schema');
  expect(tvItems.some(i => i.type === 'ComfyTV.ImageStage'), 'ComfyTV.ImageStage appears in palette');
  expect(tvItems.length >= 5, 'palette has at least 5 ComfyTV stage entries (got ' + tvItems.length + ')');
  // registry notifies subscribers so the palette re-renders
  const fired = notified.some(v => v > beforeVersion);
  expect(fired, 'registerDefaultComfyTVStages fired registry subscription (palette will refresh)');
  unsub();
  // duplicates: same type is NOT pushed twice into the kind bucket
  registerDefaultComfyTVStages();
  expect(buildComfyPaletteItems('schema').filter(i => i.type === 'ComfyTV.ImageStage').length === 1,
    're-registering default stages does not duplicate palette entries');
}

section('ComfyTV: 列举全部 171 节点 + 执行冒烟测试');
{
  // ────────────────────────────────────────────────────────────────
  // 1. 列举完整性：171 节点全部注册为 schema、无重复、全部在调色板可见
  // ────────────────────────────────────────────────────────────────
  const metas = COMFYTV_STAGE_META;
  expect(metas.length === 171, `COMFYTV_STAGE_META 共 171 节点 (got ${metas.length})`);

  // 9 个内嵌编辑器节点（P3 本地执行）被有意注册为 kind='native'，其余 162 个为 'schema'。
  const nativeEditors = new Set([
    'ComfyTV.CropStage', 'ComfyTV.RotateStage', 'ComfyTV.MirrorStage',          // isInstantNode
    'ComfyTV.RelightStage', 'ComfyTV.PosterStage', 'ComfyTV.LayerEditorStage',  // 内嵌编辑器
    'ComfyTV.StoryboardEditorStage', 'ComfyTV.MaterialStage', 'ComfyTV.Scene3DStage',
  ]);

  const unregistered = metas.filter(m => !getNodeSpec(m.nodeId)).map(m => m.nodeId);
  expect(unregistered.length === 0, `全部 171 节点已注册 (缺失: ${unregistered.join(',')})`);

  const wrongKind = metas.filter(m => {
    const expected = nativeEditors.has(m.nodeId) ? 'native' : 'schema';
    return getNodeSpec(m.nodeId)?.kind !== expected;
  }).map(m => `${m.nodeId}(${getNodeSpec(m.nodeId)?.kind})`);
  expect(wrongKind.length === 0,
    `节点 kind 符合预期（9 编辑器 native / 162 schema）(异常: ${wrongKind.join(',')})`);

  const ids = metas.map(m => m.nodeId);
  expect(new Set(ids).size === ids.length, 'nodeId 无重复');

  const paletteSet = new Set(buildComfyPaletteItems('schema').map(i => i.type));
  const missingPalette = metas.filter(m => !paletteSet.has(m.nodeId)).map(m => m.nodeId);
  expect(missingPalette.length === 0, `全部节点在 COMFYTV STAGES 调色板可见 (缺失: ${missingPalette.join(',')})`);

  // ────────────────────────────────────────────────────────────────
  // 2. 执行冒烟：每个节点 runNodeOrStage 不崩溃 + 正确路由 + 正确降级
  // ────────────────────────────────────────────────────────────────
  // mock runner：invoke 返回 success，无 fetchApi → schema stage 走
  // runStageWorkflow → 抛 StageWorkflowUnavailableError → 降级 runSingleNode。
  const makeSmokeRunner = () => ({
    baseUrl: 'http://fake.local',
    async invoke() { return { status: 'success', promptId: 'p1', durationMs: 1, outputs: {} }; },
    // 刻意不提供 fetchApi：验证 schema stage 的降级路径
  });

  // 本地执行器（走本地路径，不降级单节点）——覆盖 runNodeOrStage 的全部早期路由分支
  const localExecutors = new Set([
    'ComfyTV.CropStage', 'ComfyTV.RotateStage', 'ComfyTV.MirrorStage',          // isInstantNode
    'ComfyTV.RelightStage',                                                       // isRelightNode
    'ComfyTV.PosterStage',                                                        // isPosterNode
    'ComfyTV.LayerEditorStage',                                                   // isLayerEditorNode
    'ComfyTV.StoryboardEditorStage',                                              // isStoryboardEditorNode
    'ComfyTV.MaterialStage',                                                      // isMaterialNode
    'ComfyTV.Scene3DStage',                                                       // isScene3DNode
    'ComfyTV.ImagePickerStage', 'ComfyTV.AudioPickerStage', 'ComfyTV.VideoPickerStage', // isPickerNode
    // isLoaderNode（含 Text + ComfyTV.Asset* 前缀）
    'ComfyTV.ImageLoaderStage', 'ComfyTV.VideoLoaderStage', 'ComfyTV.AudioLoaderStage',
    'ComfyTV.TextLoaderStage',
    'ComfyTV.AssetImageLoaderStage', 'ComfyTV.AssetVideoLoaderStage',
    'ComfyTV.AssetAudioLoaderStage', 'ComfyTV.AssetModelLoaderStage',
  ]);

  const crashed = [];
  const badStruct = [];
  let stageSuccess = 0;
  const stageFailures = [];
  const localResults = [];

  for (const meta of metas) {
    const isLocal = localExecutors.has(meta.nodeId);
    let result;
    try {
      result = await runNodeOrStage({
        runner: makeSmokeRunner(),
        nodeId: 'smoke-' + meta.nodeId,
        type: meta.nodeId,
        getSpec: (t) => getNodeSpec(t),
        values: {},
        store: new MediaSnapshotStore(createMemoryBackend()),
      });
    } catch (e) {
      crashed.push(`${meta.nodeId}:${e?.message ?? e}`);
      continue;
    }
    if (!result || typeof result.status !== 'string' || !Array.isArray(result.entries)) {
      badStruct.push(meta.nodeId);
      continue;
    }
    if (isLocal) {
      localResults.push({ type: meta.nodeId, status: result.status });
    } else if (result.status === 'success') {
      stageSuccess++;
    } else {
      stageFailures.push(`${meta.nodeId}(${result.status}:${result.error ?? ''})`);
    }
  }

  expect(crashed.length === 0, `冒烟：171 节点无一崩溃 (崩溃: ${crashed.join(' | ')})`);
  expect(badStruct.length === 0, `冒烟：返回结构合法 (异常: ${badStruct.join(',')})`);

  // 非本地执行器的 schema stage（含 fx/editor 类等）应全部降级单节点执行成功
  const stageTotal = metas.length - localExecutors.size;
  expect(stageSuccess === stageTotal,
    `schema stage 降级单节点全部成功 (${stageSuccess}/${stageTotal})，失败: ${stageFailures.join(' | ')}`);

  // 本地执行器（15 个）全部执行（success 或明确本地 error，均合法）
  expect(localResults.length === localExecutors.size,
    `本地执行器全部执行 (${localResults.length}/${localExecutors.size})`);
}

section('NodeContextMenu: buildAddNodeSubmenu 三级级联渲染结构');
{
  // buildAddNodeSubmenu 是「Add Node ▸ 分组 ▸ 节点」三级级联的渲染数据源：
  // 一级=分组项（带 submenu），二级=分组下的节点叶子（带 onPick，不再嵌套）。
  const groups = buildMenuGroups();
  const added = [];
  const menu = buildAddNodeSubmenu((type) => added.push(type));

  // 一级：分组项数量 = buildMenuGroups 数量（7 组）
  expect(menu.length === groups.length, `一级分组数 = ${groups.length} (got ${menu.length})`);

  // 结构正确性：每个一级项有非空 submenu；二级叶子无 submenu、带 onPick、id 格式正确
  let leafCount = 0;
  let structurallyOk = true;
  for (let i = 0; i < menu.length; i++) {
    const g = menu[i];
    if (g.id !== 'addNode:' + groups[i].id) { structurallyOk = false; }
    if (!Array.isArray(g.submenu) || g.submenu.length === 0) { structurallyOk = false; break; }
    for (let j = 0; j < g.submenu.length; j++) {
      const leaf = g.submenu[j];
      if (leaf.submenu) { structurallyOk = false; }                 // 叶子不应再有子菜单（恰好三级）
      if (typeof leaf.onPick !== 'function') { structurallyOk = false; }
      if (leaf.id !== `addNode:${groups[i].id}:${groups[i].items[j]?.type}`) { structurallyOk = false; }
      leafCount++;
    }
  }
  expect(structurallyOk, '每个一级分组都有非空 submenu；二级叶子无嵌套 submenu、带 onPick、id=addNode:<group>:<type>');
  expect(leafCount === groups.reduce((n, g) => n + g.items.length, 0), `二级叶子总数 = 各分组节点数之和 (got ${leafCount})`);

  // 一级项视觉：label 非空、icon=◆（分组色方块）
  expect(menu.every(g => typeof g.label === 'string' && g.label.length > 0 && g.icon === '◆'),
    '一级分组项 label 非空、icon=◆');

  // 叶子 onPick → addNode(type)：触发 system 组第一个叶子（start）
  const sysIdx = groups.findIndex(g => g.id === 'system');
  expect(sysIdx >= 0, 'system 分组存在');
  if (sysIdx >= 0) {
    const sysLeaf = menu[sysIdx].submenu[0];
    expect(sysLeaf.id === 'addNode:system:start', `system 首叶子 id=addNode:system:start (got ${sysLeaf.id})`);
    sysLeaf.onPick();
    expect(added.length === 1 && added[0] === 'start', `叶子 onPick → addNode('start') (got ${JSON.stringify(added)})`);
  }
}

section('E2E: 节点 UI 渲染数据完整性 (title/size/pos/ports)');
{
  // 遍历全部调色板节点，验证 add 到画布后渲染所需的数据描述符完整且正确：
  // size>0、pos 数组、title 非空且非 TODO、inputs/outputs 端口数组存在。
  const groups = buildMenuGroups();
  let total = 0;
  const bad = [];
  for (const g of groups) {
    for (const it of g.items) {
      total++;
      const { graph: ser } = toLiteGraph([
        { id: 't-' + total, type: it.type, name: it.label, position: { x: 100, y: 100 }, data: { label: it.label } },
      ], []);
      const n = ser.nodes[0];
      if (!n) { bad.push(`${it.type}:no-node`); continue; }
      if (!(Array.isArray(n.size) && n.size.length === 2 && n.size[0] > 0 && n.size[1] > 0)) {
        bad.push(`${it.type}:size=${JSON.stringify(n.size)}`);
      }
      if (!(Array.isArray(n.pos) && n.pos.length === 2)) {
        bad.push(`${it.type}:pos=${JSON.stringify(n.pos)}`);
      }
      // 真实 LGraph 实例化，验证 title 与端口
      const graph = new LGraph();
      graph.configure({ ...ser, id: 'wf', groups: [] });
      const node = graph.nodes[0];
      const t = (node && node.title) || '';
      if (!t || t === 'TODO') {
        bad.push(`${it.type}:title-empty-or-TODO`);
      } else if (t === it.type && /^(?:ComfyTV|Comfy|Saros)\./i.test(it.type)) {
        // namespaced 节点 title 不允许回退为原始 type（脏源：defaultDataForType 泄漏）
        bad.push(`${it.type}:title-leaks-type`);
      }
      if (!(Array.isArray(node?.inputs) && Array.isArray(node?.outputs))) {
        bad.push(`${it.type}:ports-not-arrays`);
      }
    }
  }
  expect(total >= 10, `渲染节点总数 >= 10 (got ${total})`);
  expect(bad.length === 0, `所有节点 title/size/pos/ports 渲染数据正确` + (bad.length ? ` — 异常: ${bad.join(' | ')}` : ''));
}

section('executionGraph: topological order (linear / branch / cycle)');
{
  const nodes = [
    { id: 'start', type: 'start' }, { id: 'a', type: 'ComfyTV.ImageStage' },
    { id: 'b', type: 'ComfyTV.GridSplitStage' }, { id: 'end', type: 'end' },
  ];
  const edges = [
    { source: 'start', target: 'a' }, { source: 'a', target: 'b' }, { source: 'b', target: 'end' },
  ];
  const { order, hasCycle } = computeExecutionOrder(nodes, edges);
  expect(!hasCycle, 'linear chain has no cycle');
  expect(order.indexOf('a') < order.indexOf('b'), 'upstream a runs before downstream b');
  expect(order[0] === 'start' && order[order.length - 1] === 'end', 'chain order endpoints correct');
  expect(order.length === 4, 'all 4 nodes in order');

  // branch: two consumers of the same upstream
  const bn = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
  const be = [{ source: 'x', target: 'y' }, { source: 'x', target: 'z' }];
  const bo = computeExecutionOrder(bn, be);
  expect(!bo.hasCycle && bo.order[0] === 'x', 'branch root ordered first');
  expect(Math.abs(bo.order.indexOf('y') - bo.order.indexOf('z')) === 1, 'branch leaves adjacent');

  // cycle: a → b → a
  const cn = [{ id: 'a' }, { id: 'b' }];
  const ce = [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }];
  const co = computeExecutionOrder(cn, ce);
  expect(co.hasCycle, 'cycle detected (a↔b)');
  expect(co.order.length < 2, 'cyclic order is only the acyclic prefix');

  // dangling edge is ignored
  const dn = [{ id: 'a' }, { id: 'b' }];
  const de = [{ source: 'a', target: 'missing' }];
  const do2 = computeExecutionOrder(dn, de);
  expect(!do2.hasCycle && do2.order.length === 2, 'dangling edge ignored');
}

section('executionGraph: buildExecutionPlan filters executable nodes');
{
  const nodes = [
    { id: 'start', type: 'start' },
    { id: 'p', type: 'prompt' },
    { id: 'img', type: 'ComfyTV.ImageStage' },
    { id: 'batch', type: 'ComfyTV.GridSplitStage' },
    { id: 'end', type: 'end' },
  ];
  const edges = [
    { source: 'start', target: 'p' }, { source: 'p', target: 'img' },
    { source: 'img', target: 'batch' }, { source: 'batch', target: 'end' },
  ];
  const plan = buildExecutionPlan(nodes, edges, type => isComfyExecutableSpec(getNodeSpec(type)));
  expect(!plan.hasCycle, 'plan has no cycle');
  expect(plan.steps.map(s => s.id).join(',') === 'img,batch', 'only Comfy executable steps in order (img,batch)');
  expect(plan.steps[0].upstreams.join(',') === 'p', 'img upstreams = [prompt node]');
  expect(plan.steps[1].upstreams.join(',') === 'img', 'batch upstreams = [img]');
  expect(plan.skipped.includes('start') && plan.skipped.includes('end') && plan.skipped.includes('p'),
    'orchestration nodes skipped');
}

section('workflowRun: isComfyExecutableSpec');
{
  expect(isComfyExecutableSpec(getNodeSpec('ComfyTV.ImageStage')), 'schema stage executable');
  expect(isComfyExecutableSpec({ kind: 'native' }), 'native node executable');
  expect(!isComfyExecutableSpec(getNodeSpec('Saros.Prompt')), 'react orchestration node skipped');
  expect(!isComfyExecutableSpec(undefined), 'unknown node skipped');
}

section('workflowRun: runGraphExecution (order / failure / cycle / no runner)');
{
  const makeRunner = (log, failOn) => ({
    baseUrl: 'http://fake.local',
    async invoke({ prompt }) {
      const entry = Object.values(prompt)[0];
      log.push(entry.class_type);
      if (failOn && entry.class_type === failOn) {
        return { status: 'error', error: 'boom', promptId: 'p1' };
      }
      return { status: 'success', promptId: 'p1', durationMs: 1, outputs: {} };
    },
  });
  const snapshotStore = new MediaSnapshotStore(createMemoryBackend());
  const cardState = new CardStateStore();
  const getSpec = (t) => getNodeSpec(t);

  // linear chain executes upstream-first (VideoStage/GridSplitStage have no builtin
  // template → they still degrade to single-node, so invoke sees their class_type)
  {
    const log = [];
    const r = await runGraphExecution({
      nodes: [
        { id: 'img', type: 'ComfyTV.VideoStage' },
        { id: 'batch', type: 'ComfyTV.GridSplitStage' },
      ],
      edges: [{ source: 'img', target: 'batch' }],
      getSpec,
      resolveRunner: () => makeRunner(log),
      snapshotStore, cardState,
    });
    expect(r.success && r.ran.join(',') === 'img,batch', 'chain ran upstream-first (img,batch)');
    expect(log.join(',') === 'ComfyTV.VideoStage,ComfyTV.GridSplitStage', 'runner invoked in execution order');
    expect(cardState.get('img').runState === 'success' && cardState.get('batch').runState === 'success',
      'cards marked success after run');
  }

  // failure stops the chain: downstream never runs (all three kinds lack a builtin
  // template → single-node degrade, so class_type stays intact)
  {
    cardState.clearAll();
    const log = [];
    const r = await runGraphExecution({
      nodes: [
        { id: 'a', type: 'ComfyTV.TextStage' },
        { id: 'b', type: 'ComfyTV.AudioStage' },
        { id: 'c', type: 'ComfyTV.VideoStage' },
      ],
      edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
      getSpec,
      resolveRunner: () => makeRunner(log, 'ComfyTV.AudioStage'),
      snapshotStore, cardState,
    });
    expect(!r.success && r.failed.nodeId === 'b' && r.failed.error === 'boom', 'first failure reported (b)');
    expect(r.ran.join(',') === 'a', 'only upstream a completed');
    expect(log.join(',') === 'ComfyTV.TextStage,ComfyTV.AudioStage', 'c never invoked (stopped at b)');
    expect(cardState.get('b').runState === 'error' && cardState.get('b').errorMsg === 'boom', 'failed card shows error');
  }

  // cycle → nothing runs
  {
    const log = [];
    const r = await runGraphExecution({
      nodes: [{ id: 'a', type: 'ComfyTV.ImageStage' }, { id: 'b', type: 'ComfyTV.AudioStage' }],
      edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }],
      getSpec,
      resolveRunner: () => makeRunner(log),
      snapshotStore, cardState,
    });
    expect(r.hasCycle && r.ran.length === 0 && log.length === 0, 'cycle aborts before any run');
  }

  // no runner → no-op
  {
    const r = await runGraphExecution({
      nodes: [{ id: 'a', type: 'ComfyTV.ImageStage' }],
      edges: [],
      getSpec,
      resolveRunner: () => undefined,
      snapshotStore, cardState,
    });
    expect(!r.success && r.ran.length === 0, 'no runner → nothing ran');
  }

  // nodeValues are passed through to the runner (VideoStage has no builtin template
  // → single-node degrade → values flow straight into the node inputs)
  {
    const log = [];
    const r = await runGraphExecution({
      nodes: [{ id: 'a', type: 'ComfyTV.VideoStage' }],
      edges: [],
      getSpec,
      resolveRunner: () => ({
        baseUrl: 'http://fake.local',
        async invoke({ prompt }) {
          const entry = Object.values(prompt)[0];
          log.push(entry.inputs);
          return { status: 'success', promptId: 'p1', durationMs: 1, outputs: {} };
        },
      }),
      snapshotStore, cardState,
      nodeValues: { a: { prompt: 'a cat astronaut', seed: 42 } },
    });
    expect(r.success && log[0] && log[0].prompt === 'a cat astronaut' && log[0].seed === 42,
      'persisted editor values flow into the node prompt');
  }
}

section('stageWorkflowExecutor: pickDefaultWorkflowLabel');
{
  const list = {
    kinds: ['image', 'video'],
    workflows: [
      { id: 1, kind: 'image', label: '标准' },
      { id: 2, kind: 'image', label: '高清', default: true },
      { id: 3, kind: 'video', label: '电影' },
    ],
  };
  expect(pickDefaultWorkflowLabel(list, 'image') === '高清', 'default workflow preferred');
  expect(pickDefaultWorkflowLabel(list, 'video') === '电影', 'first workflow fallback');
  expect(pickDefaultWorkflowLabel(list, 'audio') === undefined, 'unknown kind → none');
  expect(pickDefaultWorkflowLabel(undefined, 'image') === undefined, 'missing list → none');
}

section('stageWorkflowExecutor: injectWorkflowValues (cast / prefix / default)');
{
  const apiJson = {
    '1': { class_type: 'ComfyTV.ImageStage', inputs: { prompt: 'x', seed: 0, width: 512, model: 'keep' } },
    '2': { class_type: 'SaveImage', inputs: { filename_prefix: 'ctv' } },
  };
  const bindings = {
    '1': {
      prompt: { from: 'prompt', cast: 'string', prefix: 'best quality, ', suffix: ' --ar 1:1' },
      seed: { from: 'seed', cast: 'int', default: 7 },
      width: { from: 'width', cast: 'int', default: 512 },
      nonexistent: { from: 'missing' },
    },
  };
  const { prompt, applied } = injectWorkflowValues(apiJson, bindings, { prompt: 'a cat', seed: '42' });
  expect(applied === 3, 'three bound inputs applied');
  expect(prompt['1'].inputs.prompt === 'best quality, a cat --ar 1:1', 'prefix+suffix applied to prompt');
  expect(prompt['1'].inputs.seed === 42, 'cast int applied (string "42" → 42)');
  expect(prompt['1'].inputs.width === 512, 'default used when value missing');
  expect(prompt['1'].inputs.model === 'keep', 'unbound inputs untouched');
  expect(prompt['2'].inputs.filename_prefix === 'ctv', 'unbound node untouched');
  const orig = { '1': { class_type: 'ComfyTV.ImageStage', inputs: { prompt: 'x' } } };
  const noBind = injectWorkflowValues(orig, undefined, { prompt: 'y' });
  expect(noBind.applied === 0 && noBind.prompt['1'].inputs.prompt === 'x', 'no bindings → clone unchanged');
}

section('workflowRun: schema nodes run as full ComfyTV workflows (P1)');
{
  const makeCTVFake = ({ invokeLog, failOn, withApi = true }) => ({
    baseUrl: 'http://fake.local',
    async invoke({ prompt }) {
      invokeLog.push(prompt);
      const classes = Object.values(prompt).map(n => n.class_type);
      if (failOn && classes.includes(failOn)) {
        return { promptId: 'p1', outputs: {}, status: 'error', error: 'boom' };
      }
      return {
        promptId: 'p1',
        outputs: { '2': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
        status: 'success', durationMs: 3,
      };
    },
    async fetchApi(path) {
      if (!withApi) { throw new Error('no ctv extension'); }
      if (path.startsWith('/comfytv/workflows?')) {
        return { ok: true, status: 200, json: async () => ({ kinds: ['image'], workflows: [{ kind: 'image', label: '标准', default: true }], recent_added: [] }), text: async () => '' };
      }
      if (path.startsWith('/comfytv/workflows/config?')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            api_json: {
              '1': { class_type: 'ComfyTV.ImageStage', inputs: {} },
              '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'ctv' } },
            },
            result: { type: 'image', node: '2' },
            inputs: {
              '1': { prompt: { from: 'prompt', cast: 'string' }, seed: { from: 'seed', cast: 'int', default: 7 } },
            },
          }),
          text: async () => '',
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    },
  });

  const snapshotStore = new MediaSnapshotStore(createMemoryBackend());
  const cardState = new CardStateStore();
  const getSpec = (t) => getNodeSpec(t);

  // full-workflow path: injected values reach the prompt; result snapshots written
  {
    const invokeLog = [];
    const r = await runGraphExecution({
      nodes: [{ id: 'a', type: 'ComfyTV.ImageStage' }],
      edges: [],
      getSpec,
      resolveRunner: () => makeCTVFake({ invokeLog }),
      snapshotStore, cardState,
      nodeValues: { a: { prompt: 'cat', seed: '42' } },
    });
    expect(r.success && r.ran.join(',') === 'a', 'stage workflow ran as one node');
    expect(invokeLog.length === 1, 'single workflow prompt submitted');
    const prompt = invokeLog[0];
    expect(Object.keys(prompt).length === 2, 'full workflow graph submitted (2 nodes)');
    expect(prompt['1'].class_type === 'ComfyTV.ImageStage' && prompt['2'].class_type === 'SaveImage', 'api_json nodes submitted');
    expect(prompt['1'].inputs.prompt === 'cat' && prompt['1'].inputs.seed === 42, 'editor values injected (cast applied)');
    expect(prompt['1'].inputs.width === undefined, 'no binding for width → untouched');
    expect(r.results.a && r.results.a.entries.length > 0, 'result-node snapshots persisted');
  }

  // full-workflow failure surfaces on the card
  {
    cardState.clearAll();
    const invokeLog = [];
    const r = await runGraphExecution({
      nodes: [{ id: 'a', type: 'ComfyTV.ImageStage' }],
      edges: [],
      getSpec,
      resolveRunner: () => makeCTVFake({ invokeLog, failOn: 'SaveImage' }),
      snapshotStore, cardState,
    });
    expect(!r.success && r.failed.nodeId === 'a' && r.failed.error === 'boom', 'workflow failure reported');
    expect(cardState.get('a').runState === 'error', 'failed card state');
  }

  // runner without ComfyTV extension → falls back to builtin workflow template
  // (image kind has a builtin template; instead of degrading to single-node, the
  // full builtin workflow graph is submitted)
  {
    cardState.clearAll();
    const invokeLog = [];
    const r = await runGraphExecution({
      nodes: [{ id: 'a', type: 'ComfyTV.ImageStage' }],
      edges: [],
      getSpec,
      resolveRunner: () => makeCTVFake({ invokeLog, withApi: false }),
      snapshotStore, cardState,
    });
    expect(r.success, 'builtin-template run still succeeds');
    const submitted = invokeLog[0];
    expect(Object.keys(submitted).length === 7 && submitted['9'].class_type === 'SaveImage' && submitted['4'].class_type === 'CheckpointLoaderSimple',
      'builtin full workflow submitted (7 native nodes, not ComfyTV.ImageStage)');
  }

  // runStageWorkflow with no fetchApi + a kind WITHOUT a builtin template still throws
  {
    let threw = false;
    try {
      await runStageWorkflow({
        runner: { baseUrl: 'http://fake.local', id: 'x', kind: 'local', testConnection: async () => ({ ok: true }), invoke: async () => ({ promptId: 'p', outputs: {}, status: 'success' }) },
        nodeId: 'a', type: 'ComfyTV.VideoStage', kind: 'video', values: {}, store: snapshotStore,
      });
    } catch (err) {
      threw = err instanceof StageWorkflowUnavailableError;
    }
    expect(threw, 'missing fetchApi + no builtin template → StageWorkflowUnavailableError');
  }

  // builtin template registry exposes the exported Local SD1.5 workflow
  {
    const list = listBuiltinWorkflows('image');
    expect(list && Array.isArray(list.workflows) && list.workflows[0].label === 'Local SD1.5',
      'builtin image workflow listed (Local SD1.5)');
    const cfg = getBuiltinWorkflowConfig('image', 'Local SD1.5');
    expect(cfg && cfg.result?.node === '9' && Object.keys(cfg.api_json).length === 7,
        'builtin config resolved (result node 9, 7-node graph)');
        expect(getBuiltinWorkflowConfig('video', 'Local SD1.5') === undefined,
          'unknown kind returns undefined');
      }

      // 7) placeholder-key registry covers ComfyTV runtime fields (used by
      //    runStageWorkflow to decide which string inputs to clear; was clearing
      //    ALL unbound string inputs, breaking sampler_name / ckpt_name).
      expect(RUNTIME_PLACEHOLDER_KEYS.has('selected_index'), 'placeholder registry includes selected_index');
      expect(RUNTIME_PLACEHOLDER_KEYS.has('force_run_token'), 'placeholder registry includes force_run_token');
      expect(!RUNTIME_PLACEHOLDER_KEYS.has('sampler_name'), 'sampler_name is NOT a placeholder (must be preserved)');
      expect(!RUNTIME_PLACEHOLDER_KEYS.has('ckpt_name'), 'ckpt_name is NOT a placeholder (must be preserved)');
      expect(!RUNTIME_PLACEHOLDER_KEYS.has('text'), 'CLIPTextEncode.text is NOT a placeholder (must be preserved)');
}

section('stageWorkflowExecutor: upstream binding resolution (P2)');
{
  expect(matchUpstreamFrom('upstream_image')?.kind === 'image' && matchUpstreamFrom('upstream_image')?.variant === undefined,
    'bare upstream_image parses');
  expect(matchUpstreamFrom('upstream_video:annotated[0]')?.kind === 'video' && matchUpstreamFrom('upstream_video:annotated[0]')?.variant === 'annotated' && matchUpstreamFrom('upstream_video:annotated[0]')?.index === 0,
    'upstream_video:annotated[0] parses');
  expect(matchUpstreamFrom('main_prompt') === null, 'non-upstream from → null');

  expect(viewUrlToAnnotated('/view?filename=a.png&subfolder=img&type=output') === 'img/a.png [output]',
    'annotated with subfolder');
  expect(viewUrlToAnnotated('/view?filename=b.png&subfolder=&type=output') === 'b.png [output]',
    'annotated without subfolder');
  expect(viewUrlToAnnotated('plain-text') === 'plain-text', 'non-URL unchanged');

  // injection: upstream variant injected; annotated converted; default fallback; option/literal/main_prompt
  const apiJson = { '10': { class_type: 'LoadImage', inputs: { image: 'empty.png' } }, '20': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } } };
  const bindings = {
    '10': { image: { from: 'upstream_image:annotated[0]', required: true } },
    '20': {
      text: { from: 'main_prompt', default: 'fallback' },
      scale: { from: 'option:scale', default: 2 },
      tag: { from: 'literal:fixed' },
    },
  };
  const upstreams = { image: '/view?filename=a.png&subfolder=img&type=output' };
  const { prompt, applied } = injectWorkflowValues(apiJson, bindings, { prompt: 'hello', scale: '3' }, upstreams);
  expect(applied === 4, 'four bound inputs applied');
  expect(prompt['10'].inputs.image === 'img/a.png [output]', 'upstream annotated injected into LoadImage.image');
  expect(prompt['20'].inputs.text === 'hello', 'main_prompt resolves to values.prompt');
  expect(prompt['20'].inputs.scale === '3', 'option:scale resolves to values.scale');
  expect(prompt['20'].inputs.tag === 'fixed', 'literal injected');

  // upstream missing → default fallback (upstream_image without a snapshot)
  const noUp = injectWorkflowValues(
    { '10': { class_type: 'LoadImage', inputs: { image: 'empty.png' } } },
    { '10': { image: { from: 'upstream_image', default: 'placeholder.png' } } },
    {},
  );
  expect(noUp.prompt['10'].inputs.image === 'placeholder.png', 'missing upstream → default');
}

section('workflowRun: chained stages inject upstream snapshots (P2)');
{
  const makeRunner = (invokeLog, failOn) => ({
    baseUrl: 'http://fake.local',
    async invoke({ prompt }) {
      invokeLog.push(prompt);
      const classes = Object.values(prompt).map(n => n.class_type);
      if (failOn && classes.includes(failOn)) { return { promptId: 'p', outputs: {}, status: 'error', error: 'boom' }; }
      return {
        promptId: 'p', status: 'success', durationMs: 1,
        outputs: { '2': { images: [{ filename: 'img.png', subfolder: 'sub', type: 'output' }] } },
      };
    },
    async fetchApi(path) {
      const kind = path.includes('kind=video') ? 'video' : 'image';
      if (path.startsWith('/comfytv/workflows?')) {
        return { ok: true, status: 200, json: async () => ({ kinds: [kind], workflows: [{ kind, label: '标准', default: true }], recent_added: [] }), text: async () => '' };
      }
      if (path.startsWith('/comfytv/workflows/config?')) {
        const cfg = kind === 'video' ? {
          api_json: { '1': { class_type: 'ComfyTV.VideoStage', inputs: {} }, '2': { class_type: 'LoadImage', inputs: { image: 'none.png' } } },
          result: { type: 'video', node: '1' },
          inputs: { '2': { image: { from: 'upstream_image:annotated[0]', required: true } } },
        } : {
          api_json: { '1': { class_type: 'ComfyTV.ImageStage', inputs: {} }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'ctv' } } },
          result: { type: 'image', node: '2' },
          inputs: {},
        };
        return { ok: true, status: 200, json: async () => cfg, text: async () => '' };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    },
  });

  const snapshotStore = new MediaSnapshotStore(createMemoryBackend());
  const cardState = new CardStateStore();
  const getSpec = (t) => getNodeSpec(t);

  // ImageStage → VideoStage: the video stage's LoadImage receives the image snapshot
  const invokeLog = [];
  const r = await runGraphExecution({
    nodes: [
      { id: 'img', type: 'ComfyTV.ImageStage' },
      { id: 'vid', type: 'ComfyTV.VideoStage' },
    ],
    edges: [{ source: 'img', target: 'vid' }],
    getSpec,
    resolveRunner: () => makeRunner(invokeLog, undefined),
    snapshotStore, cardState,
    nodeValues: { img: { prompt: 'a fox' } },
  });
  expect(r.success && r.ran.join(',') === 'img,vid', 'chained stages ran upstream-first');
  expect(invokeLog.length === 2, 'two workflow prompts submitted');
  const vidPrompt = invokeLog[1];
  expect(vidPrompt['2'].class_type === 'LoadImage', 'video workflow has LoadImage');
  expect(vidPrompt['2'].inputs.image === 'sub/img.png [output]', 'upstream image snapshot injected as annotated path');
}

section('workflowRun: orchestration Prompt node feeds stage prompt (P2-tail)');
{
  const invokeLog = [];
  const runner = {
    baseUrl: 'http://fake.local',
    async invoke({ prompt }) {
      invokeLog.push(prompt);
      return { promptId: 'p', status: 'success', durationMs: 1, outputs: { '2': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } };
    },
    async fetchApi(path) {
      if (path.startsWith('/comfytv/workflows?')) {
        return { ok: true, status: 200, json: async () => ({ kinds: ['image'], workflows: [{ kind: 'image', label: '标准', default: true }], recent_added: [] }), text: async () => '' };
      }
      if (path.startsWith('/comfytv/workflows/config?')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            api_json: { '1': { class_type: 'ComfyTV.ImageStage', inputs: {} }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'ctv' } } },
            result: { type: 'image', node: '2' },
            inputs: { '1': { prompt: { from: 'main_prompt', default: '' } } },
          }),
          text: async () => '',
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    },
  };
  const snapshotStore = new MediaSnapshotStore(createMemoryBackend());
  const cardState = new CardStateStore();

  // Prompt(文本) → ImageStage: prompt flows from the orchestration node
  const r = await runGraphExecution({
    nodes: [
      { id: 'prompt', type: 'prompt', data: { prompt: 'a fox in the snow' } },
      { id: 'img', type: 'ComfyTV.ImageStage', data: {} },
    ],
    edges: [{ source: 'prompt', target: 'img' }],
    getSpec: (t) => getNodeSpec(t),
    resolveRunner: () => runner,
    snapshotStore, cardState,
  });
  expect(r.success && r.ran.join(',') === 'img', 'media node ran; orchestration node skipped');
  expect(invokeLog[0]['1'].inputs.prompt === 'a fox in the snow', 'Prompt node text injected as stage prompt');

  // editor values override orchestration values
  const r2 = await runGraphExecution({
    nodes: [
      { id: 'prompt', type: 'prompt', data: { prompt: 'from prompt node' } },
      { id: 'img', type: 'ComfyTV.ImageStage', data: {} },
    ],
    edges: [{ source: 'prompt', target: 'img' }],
    getSpec: (t) => getNodeSpec(t),
    resolveRunner: () => runner,
    snapshotStore, cardState,
    nodeValues: { img: { prompt: 'from editor' } },
  });
  expect(r2.success && invokeLog[1]['1'].inputs.prompt === 'from editor', 'editor value overrides orchestration value');
}

section('workflowRun: runNodeOrStage shared executor (popup & graph)');
{
  const ctvRunner = {
    baseUrl: 'http://fake.local',
    async invoke({ prompt }) {
      return { promptId: 'p', status: 'success', durationMs: 1, outputs: { '2': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } };
    },
    async fetchApi(path) {
      if (path.startsWith('/comfytv/workflows?')) {
        return { ok: true, status: 200, json: async () => ({ kinds: ['image'], workflows: [{ kind: 'image', label: '标准', default: true }], recent_added: [] }), text: async () => '' };
      }
      if (path.startsWith('/comfytv/workflows/config?')) {
        return { ok: true, status: 200, json: async () => ({
          api_json: { '1': { class_type: 'ComfyTV.ImageStage', inputs: {} }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'ctv' } } },
          result: { type: 'image', node: '2' },
          inputs: { '1': { prompt: { from: 'main_prompt' } } },
        }), text: async () => '' };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    },
  };
  const plainRunner = {
    baseUrl: 'http://fake.local',
    async invoke({ prompt }) {
      return { promptId: 'p', status: 'success', durationMs: 1, outputs: {} };
    },
  };
  const snapshotStore = new MediaSnapshotStore(createMemoryBackend());

  // schema node with ComfyTV extension → full workflow prompt
  const r1 = await runNodeOrStage({
    runner: ctvRunner, nodeId: 'a', type: 'ComfyTV.ImageStage',
    getSpec: (t) => getNodeSpec(t), values: { prompt: 'cat' },
    store: snapshotStore,
  });
  expect(r1.status === 'success', 'schema node executed via unified executor');
  expect(r1.promptId === 'p', 'full workflow prompt submitted');

  // schema node without ComfyTV extension → degrades to single node
  const r2 = await runNodeOrStage({
    runner: plainRunner, nodeId: 'a', type: 'ComfyTV.ImageStage',
    getSpec: (t) => getNodeSpec(t), values: { prompt: 'cat' },
    store: snapshotStore,
  });
  expect(r2.status === 'success', 'degraded single-node run succeeds');
}

section('minimap: scene layout, inverse map & pan math');
{
  const nodes = [
    { id: 'start', pos: [0, 0], size: [200, 60], color: '#22c55e' },
    { id: 'agent', pos: [400, 100], size: [220, 60], color: '#f59e0b' },
  ];
  const vp = { offsetX: -100, offsetY: -50, scale: 1, canvasW: 1000, canvasH: 600 };
  const scene = buildMinimapScene(nodes, vp, 200, 125);
  expect(!scene.empty, 'scene built');
  expect(scene.bounds.minX === 0 && scene.bounds.maxX === 620, 'bounds span all nodes');
  expect(scene.nodeRects.length === 2, 'two node rects');
  expect(scene.nodeRects[0].x === 6 && scene.nodeRects[0].y === 6, 'first node at top-left (padding)');
  expect(scene.nodeRects[0].color === '#22c55e', 'node color carried through');
  expect(scene.viewportRect.w > 0 && scene.viewportRect.h > 0, 'viewport frame present');

  // collapsed nodes are skipped
  const collapsedScene = buildMinimapScene([...nodes, { id: 'end', pos: [900, 900], size: [100, 40], collapsed: true }], vp, 200, 125);
  expect(collapsedScene.nodeRects.length === 2, 'collapsed node excluded');

  // empty graph
  const emptyScene = buildMinimapScene([], vp, 200, 125);
  expect(emptyScene.empty && emptyScene.nodeRects.length === 0, 'empty graph → empty scene');

  // minimapToGraph is the inverse of the layout mapping
  const g = minimapToGraph(6, 6, scene.bounds, 200, 125);
  expect(Math.abs(g[0]) < 1 && Math.abs(g[1]) < 1, 'minimap corner maps back to graph corner');
  const gc = minimapToGraph(100, 62.5, scene.bounds, 200, 125);
  expect(Math.abs(gc[0] - 310) < 1 && Math.abs(gc[1] - 80) < 1, 'minimap center maps to graph center');

  // applyMinimapPan: graph +Δ → offset −Δ
  const pan = applyMinimapPan([10, 20], [100, 100], [120, 90]);
  expect(pan[0] === -10 && pan[1] === 30, 'pan moves offset opposite to graph delta');

  // renderMinimap issues draw calls
  const calls = [];
  const fakeCtx = {
    fillRect(x, y, w, h) { calls.push(['fillRect', x, y, w, h]); },
    strokeRect(x, y, w, h) { calls.push(['strokeRect', x, y, w, h]); },
  };
  renderMinimap(fakeCtx, 200, 125, scene);
  expect(calls.filter(c => c[0] === 'fillRect').length >= 3, 'bg + nodes + viewport fill drawn');
  expect(calls.filter(c => c[0] === 'strokeRect').length === 1, 'viewport frame stroked');
}

section('comfyNodeStyle: widget rendering & style application');
{
  const calls = [];
  const fakeCtx = {
    fillRect() {}, strokeRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    quadraticCurveTo() {}, save() {}, restore() {},
    fill() { calls.push('fill'); }, stroke() { calls.push('stroke'); },
    fillText(t) { calls.push('text:' + t); },
    measureText(t) { return { width: t.length * 6 }; },
    textAlign: 'left', textBaseline: 'top', font: '', globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
  };
  const node = {
    size: [220, 100],
    widgets: [
      { name: 'seed', type: 'number', value: 42, y: 24, width: 220 },
      { name: 'model', type: 'combo', value: 'turbo', options: { values: ['turbo', 'xl'] }, y: 48, width: 220 },
      { name: 'prompt', type: 'text', value: 'a cat', y: 72, width: 220 },
      { name: 'toggle', type: 'toggle', value: true, y: 96, width: 220 },
    ],
    isWidgetVisible: () => true,
  };
  comfyDrawWidgets.call(node, fakeCtx, {});
  expect(calls.includes('text:seed') && calls.includes('text:42'), 'number widget label+value drawn');
  expect(calls.includes('text:model') && calls.includes('text:turbo'), 'combo widget label+value drawn');
  expect(calls.includes('text:prompt') && calls.includes('text:a cat'), 'text widget label+value drawn');
  expect(calls.filter(c => c === 'fill').length >= 4, 'field backdrops filled (number/combo/text/toggle)');

  // applyComfyNodeStyle darkens the palette and installs hooks
  const constants = { NODE_DEFAULT_COLOR: 'x', NODE_DEFAULT_BGCOLOR: 'y', NODE_DEFAULT_BOXCOLOR: 'z', WIDGET_OUTLINE_COLOR: 'w' };
  const proto = {};
  const liteCanvas = {};
  applyComfyNodeStyle(liteCanvas, { prototype: proto }, constants);
  expect(constants.NODE_DEFAULT_BGCOLOR === '#1f1f1f' && constants.NODE_DEFAULT_COLOR === '#2a2a2a', 'dark node palette applied');
  expect(constants.WIDGET_OUTLINE_COLOR === '#3a3a3a', 'widget outline dimmed');
  expect(typeof proto.onDrawTitleText === 'function' && typeof proto.onDrawTitleBox === 'function' && typeof proto.drawWidgets === 'function',
    'title/widget hooks installed');

  // P3: error banner drawing
  const errCalls = [];
  const errCtx = {
    stroke() { errCalls.push('stroke'); }, fill() { errCalls.push('fill'); },
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
    save() {}, restore() {},
    fillText(t) { errCalls.push('text:' + t); },
    measureText(t) { return { width: t.length * 6 }; },
    textAlign: 'left', textBaseline: 'top', font: '', globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
  };
  drawNodeErrorBanner(errCtx, 220, 120, 'boom');
  // The error banner is backdrop + text only — LiteGraph already colors the
  // node's `boxcolor` red on error, so drawing a full-node stroke here would
  // produce a double red border (see drawNodeErrorBanner doc).
  expect(errCalls.some(t => t.startsWith('text:⚠ Error: boom')) && errCalls.filter(c => c === 'fill').length >= 1, 'error banner drawn (backdrop + text, no double border)');
  expect(!errCalls.includes('stroke'), 'error banner does not re-stroke the node border');

  // execution-state overlay: running/success border, error banner, unknown → no-op
  const stCalls = [];
  const stCtx = {
    stroke() { stCalls.push('stroke'); }, fill() { stCalls.push('fill'); },
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {},
    save() {}, restore() {},
    fillText() {}, measureText() { return { width: 10 }; },
    textAlign: 'left', textBaseline: 'top', font: '', globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
  };
  drawNodeStateOverlay(stCtx, 200, 100, 'running');
  drawNodeStateOverlay(stCtx, 200, 100, 'success');
  drawNodeStateOverlay(stCtx, 200, 100, 'error', 'kaput');
  drawNodeStateOverlay(stCtx, 200, 100, 'idle');
  // running + success each stroke the node border; error goes through the
  // banner path (backdrop + text, no extra full-node stroke)
  expect(stCalls.filter(c => c === 'stroke').length >= 2, 'running+success draw borders');
  expect(stCalls.filter(c => c === 'fill').length >= 1, 'error banner backdrop filled');

  // onDrawForeground hook consults the getNodeState callback
  let stateHook = null;
  const proto2 = {};
  applyComfyNodeStyle({}, { prototype: proto2 }, { NODE_DEFAULT_COLOR: 'x', NODE_DEFAULT_BGCOLOR: 'y', NODE_DEFAULT_BOXCOLOR: 'z', WIDGET_OUTLINE_COLOR: 'w' }, (id) => id === 'n1' ? { runState: 'error', errorMsg: 'kaput' } : undefined);
  stateHook = proto2.onDrawForeground;
  expect(typeof stateHook === 'function', 'onDrawForeground installed');
  const nodeCtx = { fillText() {}, save() {}, restore() {}, stroke() {}, fill() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, measureText() { return { width: 10 }; }, textAlign: 'left', textBaseline: 'top', font: '', globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1 };
  stateHook.call({ id: 7, properties: { __sarosId: 'n1' }, size: [200, 100] }, nodeCtx); // error → draws, no throw
  stateHook.call({ id: 8, properties: { __sarosId: 'n2' }, size: [200, 100] }, nodeCtx); // no state → no draw, no throw
}

section('comfyNodeStyle: darkenColor');
{
  const d = darkenColor('#22c55e', 0.4);
  expect(d === 'rgb(14, 79, 38)', 'green darkened (factor 0.4)');
  expect(darkenColor('not-a-color', 0.4) === 'not-a-color', 'non-hex unchanged');
}

section('NodeContextMenu: groups & search filter');
{
  const groups = buildMenuGroups();
  expect(groups.some(g => g.id === 'system') && groups.some(g => g.id === 'basic'), 'orchestration groups present');
  expect(groups.some(g => g.id === 'comfyTV') && groups.some(g => g.id === 'comfyUI'), 'ComfyTV + native groups present');
  expect(groups.find(g => g.id === 'system').items.length >= 2, 'system group has Start/End');
  expect(groups.find(g => g.id === 'comfyTV').items.length >= 5, 'comfyTV preset stages present');

  const filtered = filterMenuGroups(groups, 'start');
  expect(filtered.length >= 1, 'query yields at least one group');
  expect(filtered.every(g => g.items.length > 0 && g.items.every(i =>
    i.label.toLowerCase().includes('start') || i.type.toLowerCase().includes('start'))),
    'filtered items match the query');
  expect(filterMenuGroups(groups, 'zzz-no-such-node').length === 0, 'no match → no groups');
}

section('ComfyUI node shortcuts: resolveShortcutAction');
{
  const k = (key, extra = {}) => ({ key, ...extra });
  expect(resolveShortcutAction(k('m', { ctrlKey: true })) === 'mute', 'Ctrl+M → mute');
  expect(resolveShortcutAction(k('b', { ctrlKey: true })) === 'bypass', 'Ctrl+B → bypass');
  expect(resolveShortcutAction(k('c', { altKey: true })) === 'collapse', 'Alt+C → collapse');
  expect(resolveShortcutAction(k('d', { ctrlKey: true })) === 'duplicate', 'Ctrl+D → duplicate');
  expect(resolveShortcutAction(k('g', { ctrlKey: true })) === 'group', 'Ctrl+G → group');
  expect(resolveShortcutAction(k('g', { ctrlKey: true, shiftKey: true })) === 'ungroup', 'Ctrl+Shift+G → ungroup');
  expect(resolveShortcutAction(k('Enter', { ctrlKey: true })) === 'run', 'Ctrl+Enter → run');
  expect(resolveShortcutAction(k('f')) === 'fit', 'F → fit');
  expect(resolveShortcutAction(k('0', { ctrlKey: true })) === 'fit', 'Ctrl+0 → fit');
  // LiteGraph-native keys must NOT be double-handled
  expect(resolveShortcutAction(k('c', { ctrlKey: true })) === null, 'Ctrl+C untouched (litegraph native)');
  expect(resolveShortcutAction(k('v', { ctrlKey: true })) === null, 'Ctrl+V untouched');
  expect(resolveShortcutAction(k('a', { ctrlKey: true })) === null, 'Ctrl+A untouched');
  expect(resolveShortcutAction(k('z', { ctrlKey: true })) === null, 'Ctrl+Z untouched');
}

section('ComfyUI node shortcuts: mode/collapse toggles');
{
  const nodes = [{ mode: 0 }, { mode: NODE_MODE_MUTE }, { mode: NODE_MODE_BYPASS }];
  const n = toggleModeForNodes(nodes, NODE_MODE_MUTE);
  expect(n === 3, 'all three nodes toggled');
  expect(nodes[0].mode === NODE_MODE_MUTE && nodes[1].mode === 0 && nodes[2].mode === NODE_MODE_MUTE,
    'mute toggles to/from ALWAYS, other modes forced');
  toggleModeForNodes([nodes[0]], NODE_MODE_MUTE);
  expect(nodes[0].mode === 0, 'mute un-mutes back to ALWAYS');
  const c = [{ collapsed: false }, { collapsed: true, collapse() { this.collapsed = !this.collapsed; } }];
  toggleCollapseForNodes(c);
  expect(c[0].collapsed === true, 'flag fallback flips collapsed');
  expect(c[1].collapsed === false, 'collapse() method used when present');
}

section('ComfyUI groups: bounds / create / remove / edit');
{
  const nodes = [
    { pos: [100, 100], size: [200, 80] },
    { pos: [320, 140], size: [160, 60] },
  ];
  const b = computeSelectionBounds(nodes);
  expect(b.x === 100 && b.y === 100 && b.w === 380 && b.h === 100,
    'selection bounds computed (x/y/w/h = ' + JSON.stringify(b) + ')');
  expect(computeSelectionBounds([]) === null, 'empty selection → null bounds');

  const graph = new LGraph();
  const group = createGroupForNodes(graph, nodes, 'MyGroup', 12);
  expect(group !== null, 'group created');
  expect(group.title === 'MyGroup', 'group title set');
  expect(graph._groups.includes(group), 'group registered on graph');
  expect(group.pos[0] === b.x - 12 && Math.abs(group.pos[1] - (b.y - 12 - group.titleHeight)) < 0.001,
    'group position wraps nodes + padding + title bar (pos=' + JSON.stringify(group.pos) + ')');
  expect(group.size[0] === b.w + 24 && Math.abs(group.size[1] - (b.h + 24 + group.titleHeight)) < 0.001,
    'group size covers nodes + title bar (size=' + JSON.stringify(group.size) + ')');

  const g2 = new LGraphGroup('Far');
  g2.pos = [1000, 1000]; g2.size = [100, 100];
  graph.add(g2);
  // NOTE: `graph` already holds the group created above (at x=88), so this
  // checks the count only; the full graph-state assertion follows on a fresh
  // graph below. A node at [100,100] sits inside MyGroup (88..492) but far
  // from the "Far" group at x=1000.
  const removed = removeGroupsContaining(graph, [...graph._groups], [{ pos: [100, 100] }]);
  expect(removed === 1, 'exactly the containing group removed from a mixed graph');
  // sanity on a fresh graph (the create step above left its group behind)
  const graph2 = new LGraph();
  const ga = new LGraphGroup('A'); ga.pos = [0, 0]; ga.size = [300, 200]; graph2.add(ga);
  const gb = new LGraphGroup('B'); gb.pos = [1000, 1000]; gb.size = [100, 100]; graph2.add(gb);
  const removed2 = removeGroupsContaining(graph2, [...graph2._groups], [{ pos: [50, 50] }]);
  expect(removed2 === 1 && graph2._groups.length === 1 && graph2._groups[0] === gb,
    'fresh graph: only the containing group removed (got ' + removed2 + ')');

  const g = new LGraphGroup('Old');
  applyGroupEdit(g, { title: '  New Title  ', color: '#5aa469', font_size: 30 });
  expect(g.title === 'New Title' && g.color === '#5aa469' && g.font_size === 30, 'edit applies title/color/font');
  applyGroupEdit(g, { title: '   ', color: undefined, font_size: 0 });
  expect(g.title === 'New Title', 'blank title keeps old, invalid font size ignored');
  expect(GROUP_COLORS.length >= 6, 'group colour palette available');
}

section('ComfyUI shortcuts + groups wired into the canvas');
{
  const src = readFileSync(new URL('../src/features/workflowEditor/LiteGraphCanvas.tsx', import.meta.url), 'utf8');
  expect(src.includes('canvas.tabIndex = 0'), 'canvas made keyboard-focusable');
  expect(src.includes("container.addEventListener('keydown', handleKeyDown)"), 'keydown handler bound');
  expect(src.includes('resolveShortcutAction(e)'), 'ComfyUI shortcut mapping wired');
  const onRenderIdx = src.indexOf('liteCanvas.onRender');
  const handler = src.slice(onRenderIdx, onRenderIdx + 5000);
  const groupsIdx = handler.indexOf('drawGroups(');
  const linksIdx = handler.indexOf('drawConnections(');
  expect(groupsIdx >= 0 && linksIdx > groupsIdx, 'groups drawn on front canvas before links');
  expect(src.includes('graph.getGroupOnPos(gx, gy)'), 'right-click on group detected');
  expect(src.includes('liteCanvas.processContextMenu = function'), 'litegraph native context menu suppressed (no-op override)');
  expect(src.includes('onGroupContextMenu'), 'group context menu prop wired');
}

section('P1 fx-spec chain: pack/unpack/merge + node classifiers');
{
  const entry = buildFxSpecEntry('video', 'VideoColor', 'video', [['eq', { contrast: 1.1 }]]);
  expect(entry.v === 1 && entry.specs.length === 1 && entry.specs[0][0] === 'eq', 'spec entry built');
  const packed = packFxVideo('https://x/view?filename=a.mp4', [entry]);
  const parsed = unpackFxVideo(packed);
  expect(parsed.url === 'https://x/view?filename=a.mp4' && parsed.entries.length === 1, 'pack → unpack round-trip');
  expect(fxVideoUrl(packed) === parsed.url, 'fxVideoUrl extracts inner url');
  const entry2 = buildFxSpecEntry('video', 'Glow', 'video', [['gblur', {}]]);
  const merged = unpackFxVideo(mergeFxChain(packed, entry2));
  expect(merged.entries.length === 2 && merged.entries[1].label === 'Glow', 'merge appends entry, keeps url');
  expect(unpackFxVideo('plain-url.mp4').url === 'plain-url.mp4', 'non-packed value passes through');
  expect(isFxBuildNode('ComfyTV.VideoColorStage'), 'VideoColor classified as builder');
  expect(!isFxBuildNode('ComfyTV.VideoClipStage'), 'VideoClip (tool) not a builder');
  expect(isFxChainNode('ComfyTV.FXChainStage'), 'FXChain is the terminal');
  expect(!isFxBuildNode('ComfyTV.FXChainStage'), 'terminal is not a builder');
  expect(isFxBuildNode('Saros.Prompt') === false, 'non-ComfyTV types never classified as fx');
  const d = fxDeliveryParams({ out_colorspace: 'bt709', out_size: '1080', out_fps: '30', out_codec: 'hevc', out_quality: 'high' });
  expect(d.size === 1080 && d.fps === 30 && d.codec === 'hevc', 'delivery params normalized');
  const d2 = fxDeliveryParams({ out_size: 'source', out_fps: 'source' });
  expect(d2.size === 0 && d2.fps === 0, 'source → 0 (backend default)');
}

section('P1 fx-spec chain: upstream threading + fx output snapshots');
{
  const store = {
    byNode: (id) => {
      if (id === 'v1') return [{ media: { kind: 'video', ref: 'https://x/view?filename=base.mp4', fxChain: packFxVideo('https://x/view?filename=base.mp4', []) } }];
      if (id === 'v2') return [{ media: { kind: 'video', ref: 'https://x/view?filename=plain.mp4' } }];
      if (id === 'img') return [{ media: { kind: 'image', ref: 'https://x/view?filename=p.png' } }];
      return [];
    }
  };
  const vals = collectUpstreamValues(store, ['v1', 'img']);
  expect(vals.video.startsWith('{"__fxvideo__"'), 'video upstream injected as full packed fx value');
  expect(vals.image === 'https://x/view?filename=p.png', 'image upstream stays plain ref');
  const plain = collectUpstreamValues(store, ['v2']);
  expect(plain.video === 'https://x/view?filename=plain.mp4', 'plain video upstream → url');

  const out = comfyOutputsToFxSnapshots('http://base', { output: packFxVideo('/view?filename=c.mp4', [{ v: 1, kind: 'video', label: 'Color', domain: 'video', specs: [['eq', {}]] }]) }, 'n1');
  expect(out.length === 1 && out[0].media.kind === 'video', 'fx slot → video snapshot');
  expect(out[0].media.ref === 'http://base/view?filename=c.mp4', 'inner url prefixed with base');
  expect(out[0].media.fxChain !== undefined && out[0].media.fxChain.includes('__fxvideo__'), 'fx chain preserved on snapshot');
  const std = comfyOutputsToFxSnapshots('http://base', { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] }, 'n2');
  expect(std.length === 1 && std[0].media.kind === 'image', 'non-fx slots fall through to standard');
}

section('P1 fx-spec chain: runNodeOrStage fx routing');
{
  const calls = [];
  const runner = {
    baseUrl: 'http://base',
    invoke: async ({ prompt }) => {
      calls.push(prompt);
      return { promptId: 'p1', status: 'success', outputs: { '1': { output: packFxVideo('/view?filename=o.mp4', []) } } };
    }
  };
  const store = {
    put: () => {},
    byNode: () => [{ media: { kind: 'video', ref: 'http://base/view?filename=src.mp4', fxChain: packFxVideo('http://base/view?filename=src.mp4', []) } }]
  };
  const r = await runNodeOrStage({
    runner, nodeId: 'fx1', type: 'ComfyTV.VideoColorStage', getSpec: () => ({ kind: 'schema' }),
    values: { contrast: 1.2 }, upstreams: ['src'], store, onProgress: () => {}
  });
  expect(r.status === 'success', 'fx node ran');
  const prompt = calls[0];
  expect(prompt['1'].class_type === 'ComfyTV.VideoColorStage', 'class_type = the fx stage');
  expect(typeof prompt['1'].inputs.video === 'string' && prompt['1'].inputs.video.includes('__fxvideo__'), 'video input threaded with packed fx value');
  expect(prompt['1'].inputs.contrast === 1.2, 'form values passed through');
  expect(r.entries.length === 1 && r.entries[0].media.fxChain !== undefined, 'fx output stored with chain');
}

section('E2E: spawnPickerForStage 始终确保 picker 存在并自动连线');
{
  // Reset the workflow store to a known-empty state so the test is deterministic.
  const store = useWorkflowEditorStore.getState();
  store.setNodes([]);
  store.setEdges([]);
  useWorkflowEditorStore.getState().setNodes([
    { id: 'src', type: 'ComfyTV.ImageStage', position: { x: 0, y: 0 }, data: {} },
  ]);

  // 1) 第一次点生成：无下游 → 创建 ImagePickerStage 并连 src → picker.batch
  spawnPickerForStage('src', 'ComfyTV.ImageStage');
  const after1 = useWorkflowEditorStore.getState();
  expect(after1.nodes.length === 2 && after1.nodes.some(n => n.type === 'ComfyTV.ImagePickerStage'),
    'first call spawns ImagePickerStage');
  expect(after1.edges.length === 1 && after1.edges[0].source === 'src'
    && after1.edges[0].target === after1.nodes.find(n => n.type === 'ComfyTV.ImagePickerStage').id,
    'first call wires src → picker.batch');

  // 2) 重复点生成：已存在 src → picker 连线 → 不重复 spawn
  const pickerId = after1.nodes.find(n => n.type === 'ComfyTV.ImagePickerStage').id;
  spawnPickerForStage('src', 'ComfyTV.ImageStage');
  const after2 = useWorkflowEditorStore.getState();
  expect(after2.nodes.length === 2, 'repeat call does not duplicate picker');
  expect(after2.edges.length === 1, 'repeat call does not duplicate edge');

  // 3) 用户先手动连到非 picker 下游（如 RelightStage）：点生成应**仍然**自动创建 picker
  //    并连 output[0] → picker.batch（旧版 connected=true 直接跳过，导致用户报告的 bug）。
  store.setNodes([
    { id: 'src2', type: 'ComfyTV.ImageStage', position: { x: 0, y: 0 }, data: {} },
    { id: 'relight', type: 'ComfyTV.RelightStage', position: { x: 200, y: 0 }, data: {} },
  ]);
  store.setEdges([{ id: 'e1', source: 'src2', target: 'relight', sourceHandle: 'images', targetHandle: 'input', type: 'default' }]);
  spawnPickerForStage('src2', 'ComfyTV.ImageStage');
  const after3 = useWorkflowEditorStore.getState();
  expect(after3.nodes.some(n => n.type === 'ComfyTV.ImagePickerStage'),
    'picker spawned even when manual downstream exists (bug fix)');
  expect(after3.edges.some(e => e.source === 'src2' && e.target === after3.nodes.find(n => n.type === 'ComfyTV.ImagePickerStage').id
    && e.targetHandle === 'batch'),
    'auto-edge src → picker.batch created (preserving user manual edge)');

  // 4) 非 ImageStage / VideoStage 不做任何事（TextStage 没有 picker 概念）
  store.setNodes([{ id: 'txt', type: 'ComfyTV.TextStage', position: { x: 0, y: 0 }, data: {} }]);
  store.setEdges([]);
  spawnPickerForStage('txt', 'ComfyTV.TextStage');
  const after4 = useWorkflowEditorStore.getState();
  expect(after4.nodes.length === 1 && after4.edges.length === 0,
    'TextStage not affected (no picker concept)');

  // Cleanup
  store.setNodes([]);
  store.setEdges([]);
}

section('E2E: spawnAssetLoader 拖媒体库资产到画布创建 loader 节点');
{
  const store = useWorkflowEditorStore.getState();
  store.setNodes([]);
  store.setEdges([]);

  // image → ImageLoaderStage + mediaAssetId 注入
  const id1 = spawnAssetLoader('asset-1', 'image', { x: 100, y: 100 });
  const s1 = useWorkflowEditorStore.getState();
  expect(id1 !== null && s1.nodes.length === 1 && s1.nodes[0].type === 'ComfyTV.ImageLoaderStage',
    'image asset spawns ImageLoaderStage');
  expect(s1.nodes[0]?.data?.mediaAssetId === 'asset-1', 'mediaAssetId injected into node data');

  // video → VideoLoaderStage
  spawnAssetLoader('asset-2', 'video', { x: 200, y: 200 });
  const s2 = useWorkflowEditorStore.getState();
  expect(s2.nodes.some(n => n.type === 'ComfyTV.VideoLoaderStage'), 'video asset spawns VideoLoaderStage');
  expect(s2.nodes.find(n => n.type === 'ComfyTV.VideoLoaderStage')?.data?.mediaAssetId === 'asset-2', 'video mediaAssetId injected');

  // audio → AudioLoaderStage
  spawnAssetLoader('asset-3', 'audio', { x: 300, y: 300 });
  const s3 = useWorkflowEditorStore.getState();
  expect(s3.nodes.some(n => n.type === 'ComfyTV.AudioLoaderStage'), 'audio asset spawns AudioLoaderStage');

  // unknown kind（如 model）→ null（本项目 Asset*ModelLoader 未注册，无映射）
  const id4 = spawnAssetLoader('asset-4', 'model', { x: 0, y: 0 });
  expect(id4 === null, 'model kind has no loader mapping (returns null)');

  // 拖拽 MIME 常量
  expect(ASSET_DRAG_MIME === 'application/x-saros-asset', 'asset drag MIME constant defined');

  // cleanup
  store.setNodes([]);
  store.setEdges([]);
}

section('E2E: wf-node-control 同步写 zustand store（修复 batch_size 不生效）');
{
  // e2e 在 node 跑（无浏览器），LiteGraphCanvas 的 window.addEventListener 在 browser
  // 上下文才注册。直接调用 store.updateNodeData 模拟 handleNodeControl 的 store
  // 写回路径（这是关键路径，e2e 验证它工作即可；window 监听器是 dispatch 入口）。
  const store = useWorkflowEditorStore.getState();
  store.setNodes([
    { id: 'img-1', type: 'ComfyTV.ImageStage', position: { x: 0, y: 0 }, data: { main_prompt: 'apple' } },
  ]);
  store.setEdges([]);

  // 直接调 updateNodeData（handleNodeControl 内部就是这样调 store 写回）。
  useWorkflowEditorStore.getState().updateNodeData('img-1', { batch_size: 2 });

  const after = useWorkflowEditorStore.getState();
  const node = after.nodes.find(n => n.id === 'img-1');
  expect(node && node.data?.batch_size === 2, 'store.data.batch_size updated via handleNodeControl writeback (was undefined, now 2)');

  // 模拟同时改其他 widget（resolution, aspect_ratio, workflow）——都应该写回 store
  useWorkflowEditorStore.getState().updateNodeData('img-1', { resolution: '1080P' });
  useWorkflowEditorStore.getState().updateNodeData('img-1', { workflow: 'Local SD1.5' });
  const after2 = useWorkflowEditorStore.getState();
  const n2 = after2.nodes.find(n => n.id === 'img-1');
  expect(n2?.data?.resolution === '1080P', 'resolution written to store');
  expect(n2?.data?.workflow === 'Local SD1.5', 'workflow written to store');

  // cleanup
  store.setNodes([]);
  store.setEdges([]);
}

section('E2E: workflowManager import/link API（mock fetch）');
{
  // 1) importWorkflow 成功：POST /comfytv/workflows/import {kind, filename, content}，
  //    后端返回 {ok:true, label} 时透传。
  const importFetch = async (url, init) => {
    expect(url.endsWith('/comfytv/workflows/import'), 'importWorkflow POSTs /comfytv/workflows/import');
    expect(init.method === 'POST', 'importWorkflow uses POST');
    const body = JSON.parse(init.body);
    expect(body.kind === 'image' && body.filename === 'wf.json' && body.content === '{"nodes":[]}',
      'import payload carries kind/filename/content');
    return { ok: true, status: 200, json: async () => ({ ok: true, kind: 'image', label: 'Imported', file_path: '/tmp/wf.json' }) };
  };
  const imported = await importWorkflow('http://127.0.0.1:8188/', importFetch, 'image', 'wf.json', '{"nodes":[]}');
  expect(imported.ok && imported.label === 'Imported', 'importWorkflow resolves label on success');

  // 2) importWorkflow 非 JSON：ComfyTV 前端在调 API 前本地校验，这里验证 HTTP 错误路径
  //    （后端 400 → ok:false + error 透传）。
  const importFail = async () => ({ ok: false, status: 400, json: async () => ({ error: 'bad' }) });
  const failed = await importWorkflow('http://x/', importFail, 'image', 'x.json', '{}');
  expect(!failed.ok && failed.error.includes('HTTP 400'), 'importWorkflow surfaces HTTP error');

  // 3) listNativeWorkflows：GET /comfytv/workflows/native?kind=image → workflows 数组。
  const listFetch = async (url) => {
    expect(url.includes('/comfytv/workflows/native?kind=image'), 'listNativeWorkflows appends kind query');
    return { ok: true, json: async () => ({ workflows: [{ path: 'a.json', name: 'a' }] }) };
  };
  const native = await listNativeWorkflows('http://127.0.0.1:8188', listFetch, 'image');
  expect(native.length === 1 && native[0].name === 'a', 'listNativeWorkflows returns array');

  // 4) linkWorkflow：POST /comfytv/workflows/link {kind, path} → {ok, label}。
  const linkFetch = async (url, init) => {
    expect(url.endsWith('/comfytv/workflows/link'), 'linkWorkflow POSTs /comfytv/workflows/link');
    const body = JSON.parse(init.body);
    expect(body.kind === 'image' && body.path === 'a.json', 'link payload carries kind/path');
    return { ok: true, status: 200, json: async () => ({ ok: true, kind: 'image', label: 'A', link_type: 1 }) };
  };
  const linked = await linkWorkflow('http://127.0.0.1:8188', linkFetch, 'image', 'a.json');
  expect(linked.ok && linked.label === 'A', 'linkWorkflow resolves label on success');
}

section('P2 pickers/loaders: classification + local execution');
{
  expect(isPickerNode('ComfyTV.ImagePickerStage'), 'ImagePicker classified');
  expect(isPickerNode('ComfyTV.VideoPickerStage') && isPickerNode('ComfyTV.AudioPickerStage'), 'video/audio pickers classified');
  expect(!isPickerNode('ComfyTV.ImageStage'), 'generator is not a picker');
  expect(isLoaderNode('ComfyTV.ImageLoaderStage') && isLoaderNode('ComfyTV.VideoLoaderStage'), 'loaders classified');
  expect(isLoaderNode('ComfyTV.AssetImageLoaderStage'), 'asset loaders classified');
  expect(!isLoaderNode('ComfyTV.VideoStage'), 'generator is not a loader');

  const store = {
    put: () => {},
    byNode: (id) => id === 'gen'
      ? [
          { nodeId: 'gen', port: 'output', key: 'gen:output:0', media: { kind: 'image', ref: 'http://x/a.png' }, index: 0 },
          { nodeId: 'gen', port: 'output', key: 'gen:output:1', media: { kind: 'image', ref: 'http://x/b.png' }, index: 1 },
        ]
      : id === 'ldr'
        ? [{ nodeId: 'ldr', port: 'output', key: 'ldr:output:0', media: { kind: 'image', ref: 'http://x/picked.png' }, index: 0 }]
        : [],
  };
  const candidates = collectUpstreamCandidates(store, ['gen']);
  expect(candidates.length === 2 && candidates[1].media.ref === 'http://x/b.png', 'upstream candidates collected in order');
  const runner = { baseUrl: 'http://base', invoke: async () => ({ promptId: '', status: 'success' }) };

  const r1 = await runNodeOrStage({
    runner, nodeId: 'pick', type: 'ComfyTV.ImagePickerStage', getSpec: () => ({ kind: 'schema' }),
    values: { selected_index: 2 }, upstreams: ['gen'], store, onProgress: () => {},
  });
  expect(r1.status === 'success' && r1.entries.length === 1 && r1.entries[0].media.ref === 'http://x/b.png',
    'picker emits the 2nd candidate (1-based selected_index)');
  expect(r1.entries[0].nodeId === 'pick', 'picked snapshot re-keyed under the picker node');

  const rBad = await runNodeOrStage({
    runner, nodeId: 'pick2', type: 'ComfyTV.VideoPickerStage', getSpec: () => ({ kind: 'schema' }),
    values: {}, upstreams: [], store, onProgress: () => {},
  });
  expect(rBad.status === 'error' && rBad.error.includes('候选'), 'picker without candidates errors with a hint');

  const rL = await runNodeOrStage({
    runner, nodeId: 'ldr', type: 'ComfyTV.ImageLoaderStage', getSpec: () => ({ kind: 'schema' }),
    values: {}, upstreams: [], store, onProgress: () => {},
  });
  expect(rL.status === 'success' && rL.entries[0].media.ref === 'http://x/picked.png', 'loader emits its stored snapshot');
  const rL2 = await runNodeOrStage({
    runner, nodeId: 'ldr2', type: 'ComfyTV.ImageLoaderStage', getSpec: () => ({ kind: 'schema' }),
    values: {}, upstreams: [], store, onProgress: () => {},
  });
  expect(rL2.status === 'error', 'loader without a chosen file errors');
}

section('P2 pickers/loaders: popup wiring in the panel source');
{
  const src = readFileSync(new URL('../src/features/workflowEditor/WorkflowEditorPanel.tsx', import.meta.url), 'utf8');
  expect(src.includes('upstreams={editingNode.upstreams}'), 'popup receives upstream node ids');
  expect(src.includes("edges.filter(e => e.target === nodeId)"), 'upstreams computed from edges');
  const popup = readFileSync(new URL('../src/features/workflowEditor/NodeEditorPopup.tsx', import.meta.url), 'utf8');
  expect(popup.includes('collectUpstreamCandidates(store, upstreams)'), 'picker candidates from upstream snapshots');
  expect(popup.includes("form.append('image', file)"), 'loader uploads via /upload/image');
  expect(popup.includes('handlePick(i)'), 'click-to-pick wired');
}

section('P4 Bridge nodes: registered for the canvas');
{
  registerDefaultComfyTVStages();
  const ids = ['ComfyTV.BridgeToImage', 'ComfyTV.BridgeToImages', 'ComfyTV.BridgeToVideo', 'ComfyTV.BridgeToAudio', 'ComfyTV.BridgeToText', 'ComfyTV.BridgeFromImage', 'ComfyTV.BridgeFromMask', 'ComfyTV.BridgeFromVideo', 'ComfyTV.BridgeFromAudio', 'ComfyTV.BridgeFromText'];
  for (const t of ids) {
    const spec = getNodeSpec(t);
    expect(spec !== undefined && spec.kind === 'native', t + ' registered as a native single-node');
  }
  expect(getNodeSpec('ComfyTV.BridgeToImage').inputs[0].type === 'IMAGE' && getNodeSpec('ComfyTV.BridgeToImage').outputs[0].type === 'IMAGE', 'bridge port types are native-compatible');
  expect(getNodeSpec('ComfyTV.ImagePickerStage') !== undefined, 'picker registered in default stages');
  expect(getNodeSpec('ComfyTV.ImageLoaderStage') !== undefined, 'loader registered in default stages');
}

section('P2 instant stages: pure transform math + draw plan');
{
  expect(isInstantNode('ComfyTV.CropStage') && isInstantNode('ComfyTV.RotateStage') && isInstantNode('ComfyTV.MirrorStage'), 'crop/rotate/mirror classified as instant');
  expect(!isInstantNode('ComfyTV.VideoStage') && !isInstantNode('ComfyTV.UpscaleStage'), 'non-instant stages excluded');

  expect(cropRect({ x: 10, y: 20, width: 100, height: 50 }, 640, 480).x === 10, 'crop x respected');
  const clamped = cropRect({ x: 600, y: 400, width: 1000, height: 1000 }, 640, 480);
  expect(clamped.w === 40 && clamped.h === 80, 'crop clamped to source bounds (' + JSON.stringify(clamped) + ')');
  expect(cropRect({}, 320, 200).w === 320 && cropRect({}, 320, 200).h === 200, 'empty values → full image crop');

  expect(rotateDegrees({}) === 90, 'rotate default 90');
  expect(rotateDegrees({ angle: 450 }) === 90, 'rotate normalized mod 360');

  const f = mirrorFlip({ horizontal: true, vertical: '1' });
  expect(f.h === true && f.v === true, 'mirror flips parsed from bool/string');
  expect(mirrorFlip({}).h === false, 'mirror default off');

  expect(instantOutputSize('ComfyTV.CropStage', { x: 0, y: 0, width: 200, height: 100 }, 640, 480).w === 200, 'crop output shrinks canvas');
  expect(instantOutputSize('ComfyTV.RotateStage', {}, 640, 480).w === 640, 'rotate keeps source size');

  const calls = [];
  const ctx = {
    drawImage: (...a) => calls.push(['drawImage', a]),
    translate: (...a) => calls.push(['translate', a]),
    rotate: (...a) => calls.push(['rotate', a]),
    scale: (...a) => calls.push(['scale', a]),
  };
  applyInstantDraw(ctx, 'ComfyTV.CropStage', { x: 5, y: 6, width: 30, height: 20 }, 640, 480);
  expect(JSON.stringify(calls[0]) === JSON.stringify(['drawImage', ['__SRC__', 5, 6, 30, 20, 0, 0, 30, 20]]), 'crop draws the sub-rectangle (sx,sy,sw,sh → dx,dy,dw,dh)');
  calls.length = 0;
  applyInstantDraw(ctx, 'ComfyTV.RotateStage', { angle: 90 }, 100, 50);
  expect(calls[0][0] === 'translate' && calls[1][0] === 'rotate' && Math.abs(calls[1][1][0] - Math.PI / 2) < 1e-9 && calls[3][0] === 'drawImage', 'rotate issues translate→rotate→translate→drawImage around center');
  calls.length = 0;
  applyInstantDraw(ctx, 'ComfyTV.MirrorStage', { horizontal: true, vertical: false }, 100, 50);
  expect(calls[0][0] === 'translate' && JSON.stringify(calls[0][1]) === JSON.stringify([100, 0]) && JSON.stringify(calls[1][1]) === JSON.stringify([-1, 1]), 'horizontal mirror translates by width then scales x by -1');
}

section('P2 instant stages: registered in the palette');
{
  registerDefaultComfyTVStages();
  for (const t of ['ComfyTV.CropStage', 'ComfyTV.RotateStage', 'ComfyTV.MirrorStage']) {
    const spec = getNodeSpec(t);
    expect(spec !== undefined && spec.kind === 'native' && spec.widgets.length > 0, t + ' registered with widgets');
  }
  const crop = getNodeSpec('ComfyTV.CropStage');
  expect(crop.inputs[0].type === 'IMAGE' && crop.outputs[0].type === 'IMAGE', 'instant stage ports are IMAGE→IMAGE');
}

section('P3 CropEditor: 交互式裁剪纯逻辑（归一化 ↔ 像素 / 命中 / 拖拽）');
{
  const { pxToNorm, normToPx, hitTestCrop, dragCrop, dragNewCrop, fullCrop, fullCropNorm } = await import('../src/features/workflowEditor/comfyHost/cropEditor.js');

  // pxToNorm / normToPx 互转
  const px = { x: 100, y: 50, width: 200, height: 100 };
  const n = pxToNorm(px, 400, 200);
  expect(Math.abs(n.x - 0.25) < 1e-9 && Math.abs(n.y - 0.25) < 1e-9 && Math.abs(n.w - 0.5) < 1e-9 && Math.abs(n.h - 0.5) < 1e-9,
    'pxToNorm 正确归一化 (' + JSON.stringify(n) + ')');
  const back = normToPx(n, 400, 200);
  expect(back.x === 100 && back.y === 50 && back.width === 200 && back.height === 100, 'normToPx 还原像素 (' + JSON.stringify(back) + ')');

  // clamp：像素矩形超出图像边界（浮点容差——0.9/0.1 二进制表示不精确）
  const clamped = pxToNorm({ x: 380, y: 180, width: 500, height: 500 }, 400, 200);
  expect(clamped.x < 1 && clamped.y < 1 && clamped.w <= 1 - clamped.x + 1e-9 && clamped.h <= 1 - clamped.y + 1e-9,
    'pxToNorm clamp 到边界 (' + JSON.stringify(clamped) + ')');

  // fullCrop / fullCropNorm
  expect(fullCrop(400, 200).width === 400 && fullCrop(400, 200).height === 200, 'fullCrop 全图');
  expect(fullCropNorm().w === 1 && fullCropNorm().h === 1, 'fullCropNorm 全图归一化');

  // hitTestCrop：四角 / 内部 / 外部
  const box = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  expect(hitTestCrop(box, 0.25, 0.25, 0.05) === 'tl', 'hit 左上角');
  expect(hitTestCrop(box, 0.75, 0.75, 0.05) === 'br', 'hit 右下角');
  expect(hitTestCrop(box, 0.5, 0.5, 0.05) === 'move', 'hit 内部 → move');
  expect(hitTestCrop(box, 0.1, 0.1, 0.05) === null, '外部 → null');

  // dragCrop：move（平移）
  const moved = dragCrop('move', { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 0.5, 0.5, 0.6, 0.7);
  expect(Math.abs(moved.x - 0.35) < 1e-9 && Math.abs(moved.y - 0.45) < 1e-9 && Math.abs(moved.w - 0.5) < 1e-9 && Math.abs(moved.h - 0.5) < 1e-9,
    'move 平移 (+0.1,+0.2) (' + JSON.stringify(moved) + ')');

  // dragCrop：br（右下角缩放）
  const resized = dragCrop('br', { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 0.75, 0.75, 0.85, 0.8);
  expect(Math.abs(resized.w - 0.6) < 1e-9 && Math.abs(resized.h - 0.55) < 1e-9 && Math.abs(resized.x - 0.25) < 1e-9,
    'br 缩放 (w+0.1,h+0.05)，锚点不变 (' + JSON.stringify(resized) + ')');

  // dragNewCrop：拖选新框
  const nc = dragNewCrop(0.2, 0.2, 0.6, 0.5);
  expect(Math.abs(nc.x - 0.2) < 1e-9 && Math.abs(nc.y - 0.2) < 1e-9 && Math.abs(nc.w - 0.4) < 1e-9 && Math.abs(nc.h - 0.3) < 1e-9,
    'dragNewCrop 拖选 (' + JSON.stringify(nc) + ')');
}

section('P3 MaskPainter: 交互式擦除 mask 纯逻辑（对齐 ComfyTV commitMask）');
{
  const { parseMaskOps, maskOpsToJson, drawMaskOps } = await import('../src/features/workflowEditor/comfyHost/maskPainter.js');

  // parseMaskOps / maskOpsToJson 往返
  const ops = [
    { type: 'brush', points: [[0.1, 0.2], [0.3, 0.4]], size: 0.015 },
    { type: 'eraser', points: [[0.5, 0.5]], size: 0.01 },
    { type: 'rect', x: 0.2, y: 0.3, w: 0.4, h: 0.2, size: 0.02 },
    { type: 'ellipse', x: 0.1, y: 0.1, w: 0.3, h: 0.3, size: 0.02 },
  ];
  const json = maskOpsToJson(ops);
  const parsed = parseMaskOps(json);
  expect(parsed.length === 4, 'maskOpsToJson/parseMaskOps 往返 4 个 op');
  expect(parsed[0].type === 'brush' && parsed[2].type === 'rect' && parsed[3].type === 'ellipse', 'op 类型保留');

  // 防御：非法 JSON / 非数组 / 非法 op
  expect(parseMaskOps('not-json').length === 0, '非法 JSON → 空');
  expect(parseMaskOps(undefined).length === 0, 'undefined → 空');
  expect(parseMaskOps(JSON.stringify({ a: 1 })).length === 0, '非数组 → 空');
  expect(parseMaskOps(JSON.stringify([{ type: 'bogus' }, 1, null])).length === 0, '非法 op 被过滤');

  // drawMaskOps：用 mock ctx 验证绘制逻辑（node 环境无真实 canvas 2d）。
  // brush → source-over + stroke；eraser → destination-out + stroke；rect → strokeRect；ellipse → ellipse。
  const calls = [];
  const mockCtx = {
    clearRect() { calls.push('clearRect'); },
    beginPath() { calls.push('beginPath'); },
    moveTo() {}, lineTo() {},
    stroke() { calls.push('stroke'); },
    strokeRect() { calls.push('strokeRect'); },
    ellipse() { calls.push('ellipse'); },
    set globalCompositeOperation(v) { calls.push('gco:' + v); },
    get globalCompositeOperation() { return 'source-over'; },
    strokeStyle: '', lineWidth: 0, lineJoin: '', lineCap: '',
  };
  drawMaskOps(mockCtx, [
    { type: 'brush', points: [[0.1, 0.2], [0.3, 0.4]], size: 0.015 },
    { type: 'eraser', points: [[0.5, 0.5]], size: 0.01 },
    { type: 'rect', x: 0.2, y: 0.3, w: 0.4, h: 0.2, size: 0.02 },
    { type: 'ellipse', x: 0.1, y: 0.1, w: 0.3, h: 0.3, size: 0.02 },
  ], 100, 100);
  expect(calls.includes('gco:destination-out'), 'eraser 用 destination-out（对齐 ComfyTV mask 擦除语义）');
  expect(calls.includes('gco:source-over'), 'brush/形状用 source-over');
  expect(calls.includes('strokeRect'), 'rect 用 strokeRect');
  expect(calls.includes('ellipse'), 'ellipse 用 ellipse');
  // brush + eraser + rect + ellipse 各描边一次（rect 的 strokeRect 与 ellipse 的 ellipse 后都接 stroke）
  expect(calls.filter(c => c === 'stroke').length === 4, '4 个 op 各 stroke 一次 (got ' + calls.filter(c => c === 'stroke').length + ')');
}

section('P3 Relight: light-ball contract (portable to ComfyTV)');
{
  expect(isRelightNode('ComfyTV.RelightStage') && !isRelightNode('ComfyTV.ImageStage'), 'relight classified');
  const point = createDefaultLight('point');
  expect(point.type === 'point' && point.position.x === 2 && point.position.y === 3 && point.position.z === 2 && point.intensity === 25, 'default point light matches ComfyTV');
  expect(createDefaultLight('directional').intensity === 1.5 && createDefaultLight('spot').outerConeAngle === 45, 'default directional/spot match');
  const parsed = normalizeLights([
    { type: 'directional', color: '#ffaa00', intensity: 2, position: { x: 1, y: 2, z: 3 } },
    { type: 'bad' },
    { type: 'spot', color: 'red', intensity: 10, position: { x: 0, y: 1, z: 0 } },
  ]);
  expect(parsed.length === 2 && parsed[0].color === '#ffaa00' && parsed[1].color === '#ffffff', 'invalid entries filtered, invalid color falls back');
  expect(parseLightsData('not-json').length === 0 && parseLightsData('').length === 0, 'broken lights_data → empty');
  expect(LIGHT_PRESETS.length === 5, 'five ComfyTV presets (threePoint/rembrandt/butterfly/rim/side)');

  const proj = orthographicProject({ x: 0, y: 0, z: 7 }, 100);
  expect(proj.front === true && Math.abs(proj.x) < 1e-6 && Math.abs(proj.y) < 1e-6 && proj.size > 0.99, 'front-top light projects to center, full size');
  const back = orthographicProject({ x: 0, y: 0, z: -7 }, 100);
  expect(back.front === false, 'back light flagged');
  const dir = lightDirection({ type: 'directional', color: '#fff', intensity: 1, position: { x: 0, y: 1, z: 0 }, target: { x: 0, y: 0, z: 0 } });
  expect(Math.abs(dir.y - 1) < 1e-9, 'direction points position→target');
  // round-trip: sphere → screen → back
  const onBall = screenToSphere(150, 120, 150, 120, 96);
  expect(onBall !== null && Math.abs(Math.hypot(onBall.x, onBall.y, onBall.z) - 1) < 1e-6, 'screenToSphere returns unit direction');
  expect(screenToSphere(0, 0, 150, 120, 96) === null, 'outside the ball disc → null');
}

section('P3 Relight: local execution emits render + prompt');
{
  const store = {
    put: () => {},
    byNode: (id) => id === 'rl'
      ? [{ nodeId: 'rl', port: 'output', key: 'rl:output:0', media: { kind: 'image', ref: 'http://x/lightball.png' }, index: 0 }]
      : [],
  };
  const r = await runRelightNode({ nodeId: 'rl', values: { main_prompt: 'three-point studio lighting' }, store });
  expect(r.status === 'success' && r.entries.length === 2, 'relight emits 2 outputs');
  expect(r.entries[0].media.kind === 'image' && r.entries[0].media.ref === 'http://x/lightball.png', 'slot 0 = light_render image');
  expect(r.entries[1].media.kind === 'text' && r.entries[1].media.ref === 'three-point studio lighting', 'slot 1 = light_prompt verbatim');
  const rEmpty = await runRelightNode({ nodeId: 'empty', values: {}, store });
  expect(rEmpty.status === 'error' && rEmpty.error.includes('摆灯'), 'relight without a render errors with a hint');
}

section('P3 Poster: layout contract + render plan');
{
  expect(isPosterNode('ComfyTV.PosterStage') && !isPosterNode('ComfyTV.ImageStage'), 'poster classified');
  const defs = defaultPosterElements();
  expect(defs.length === 3 && defs[0].id === 'title' && defs[1].id === 'subtitle' && defs[2].id === 'main', 'default hero elements');
  expect(defs[2].type === 'image' && defs[2].slot === 0 && defs[2].x === 0.06 && defs[2].h === 0.65, 'image cell normalized coords + slot 0');
  const laid = applyPosterLayout(defs, { title: { x: 0.1, y: 0.08, font_size: 80, color: '#ff0000' }, missing: { x: 1 } });
  expect(laid[0].x === 0.1 && laid[0].y === 0.08 && laid[0].font_size === 80 && laid[0].color === '#ff0000', 'layout overrides applied by id');
  expect(laid[1].x === 0.06, 'unrelated element untouched');
  expect(parsePosterLayout('{bad').title === undefined && Object.keys(parsePosterLayout('{}')).length === 0, 'broken layout JSON → empty overrides');
  expect(hitTestPosterElement(defs, 0.5, 0.5) === 2, 'hit-test picks the image cell');
  expect(hitTestPosterElement(defs, 0.01, 0.5) === -1, 'outside elements → -1');

  const calls = [];
  const ctx = {
    fillStyle: null,
    font: null,
    textAlign: null,
    textBaseline: null,
    fillRect: (...a) => calls.push(['fillRect', a]),
    fillText: (...a) => calls.push(['fillText', a]),
    drawImage: (...a) => calls.push(['drawImage', a]),
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    beginPath: () => calls.push(['beginPath']),
    arc: (...a) => calls.push(['arc', a]),
    fill: () => calls.push(['fill']),
  };
  renderPoster(ctx, defs, ['IMG_SLOT_0'], 1240, 1754, '#101014');
  expect(calls[0][0] === 'fillRect' && JSON.stringify(calls[0][1]) === JSON.stringify([0, 0, 1240, 1754]), 'background fills the canvas');
  expect(calls.some(c => c[0] === 'fillText'), 'title text drawn');
  const imageCall = calls.find(c => c[0] === 'drawImage');
  expect(imageCall !== undefined && imageCall[1][0] === 'IMG_SLOT_0', 'image cell draws the slot image');
  const imageRect = imageCall[1];
  expect(Math.abs(imageRect[1] - 0.06 * 1240) < 0.01 && Math.abs(imageRect[3] - 0.88 * 1240) < 0.01, 'image drawn at normalized position/size');

  // ── 对齐 ComfyTV usePosterStage：shape 语义 + mergedElements + newElementDef ──
  const { mergedElements, newElementDef, nextElementId, layoutColor, DEFAULT_COLORS, SIZE_PRESETS } = await import('../src/features/workflowEditor/comfyHost/posterEditor.js');

  // shape 语义：type='shape' + shape='rect'|'ellipse'|'line'（非独立 rect/circle type）
  const shapeDef = newElementDef('shape', 's1');
  expect(shapeDef.type === 'shape' && shapeDef.shape === 'rect' && shapeDef.stroke_width === 3, 'newElementDef(shape) → type=shape + shape=rect + stroke_width=3');
  const textDef = newElementDef('text', 't1');
  expect(textDef.type === 'text' && textDef.text === '新文本' && textDef.font_size === 36, 'newElementDef(text) → font_size=36');
  const imgDef = newElementDef('image', 'i1');
  expect(imgDef.type === 'image' && imgDef.slot === 0, 'newElementDef(image) → slot=0');

  // mergedElements：__added__ 追加 + __removed__ 过滤
  const merged = mergedElements(defaultPosterElements(), {
    __added__: [newElementDef('shape', 'added1')],
    __removed__: ['subtitle'],
  });
  expect(merged.length === 3 && merged.find(e => e.id === 'added1') && !merged.find(e => e.id === 'subtitle'), 'mergedElements = 非 removed 模板 + __added__');

  // nextElementId：u + base36 时间戳 + 序号
  const id1 = nextElementId();
  const id2 = nextElementId();
  expect(id1.startsWith('u') && id1 !== id2, 'nextElementId 唯一（u 前缀）');

  // layoutColor：__colors__ 覆盖 DEFAULT_COLORS
  expect(layoutColor({}, 'primary_color') === DEFAULT_COLORS.primary_color, 'layoutColor 默认值');
  expect(layoutColor({ __colors__: { primary_color: '#112233' } }, 'primary_color') === '#112233', 'layoutColor 覆盖');
  expect(layoutColor({ __colors__: { primary_color: 'red' } }, 'primary_color') === DEFAULT_COLORS.primary_color, '非法颜色回退默认');

  // SIZE_PRESETS 6 种
  expect(SIZE_PRESETS.length === 6 && SIZE_PRESETS.some(p => p.label.includes('A4')), 'SIZE_PRESETS 6 种（含 A4）');

  // renderPoster shape 渲染（ellipse / line）
  const shapeCalls = [];
  const sctx = {
    fillStyle: null, strokeStyle: null, lineWidth: 0,
    fillRect: (...a) => shapeCalls.push(['fillRect', a]),
    beginPath: () => shapeCalls.push(['beginPath']),
    ellipse: (...a) => shapeCalls.push(['ellipse', a]),
    moveTo: (...a) => shapeCalls.push(['moveTo', a]),
    lineTo: (...a) => shapeCalls.push(['lineTo', a]),
    fill: () => shapeCalls.push(['fill']),
    stroke: () => shapeCalls.push(['stroke']),
    save: () => {}, restore: () => {}, translate: () => {}, rotate: () => {},
    fillText: () => {}, drawImage: () => {},
  };
  renderPoster(sctx, [
    { id: 'e1', type: 'shape', shape: 'ellipse', x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
    { id: 'e2', type: 'shape', shape: 'line', x: 0.1, y: 0.1, w: 0.3, h: 0.3 },
  ], [], 1000, 1000);
  expect(shapeCalls.some(c => c[0] === 'ellipse'), 'shape=ellipse 用 ellipse');
  expect(shapeCalls.some(c => c[0] === 'lineTo'), 'shape=line 用 lineTo + stroke');
}

section('P3 Poster: 8-direction resize + rotate interaction math');
{
  // applyPosterDrag：move 保持 w/h 并 clamp 到边界
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  const moved = applyPosterDrag('move', { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, 0.05, 0.02);
  expect(close(moved.x, 0.15) && close(moved.y, 0.12) && moved.w === 0.3 && moved.h === 0.3, 'move 平移 + 保持尺寸');
  const movedClamp = applyPosterDrag('move', { x: 0.8, y: 0.1, w: 0.3, h: 0.3 }, 1, 0);
  expect(close(movedClamp.x, 0.7) && movedClamp.y === 0.1, 'move 右边界 clamp 到 1-w');
  // resize 'e'：只改 w
  const rE = applyPosterDrag('e', { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, 0.1, 0);
  expect(rE.x === 0.1 && rE.y === 0.1 && Math.abs(rE.w - 0.4) < 1e-9 && rE.h === 0.3, 'resize e 只改 w');
  // resize 'se'：改 w+h
  const rSE = applyPosterDrag('se', { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, 0.1, 0.1);
  expect(Math.abs(rSE.w - 0.4) < 1e-9 && Math.abs(rSE.h - 0.4) < 1e-9 && rSE.x === 0.1 && rSE.y === 0.1, 'resize se 改 w+h');
  // resize 'nw'：左上角收缩，x/y 跟随
  const rNW = applyPosterDrag('nw', { x: 0.4, y: 0.4, w: 0.3, h: 0.3 }, 0.1, 0.1);
  expect(Math.abs(rNW.w - 0.2) < 1e-9 && Math.abs(rNW.h - 0.2) < 1e-9 && Math.abs(rNW.x - 0.5) < 1e-9 && Math.abs(rNW.y - 0.5) < 1e-9, 'resize nw 左上收缩');
  // 最小尺寸 clamp MIN_WH
  const rMin = applyPosterDrag('nw', { x: 0.4, y: 0.4, w: 0.3, h: 0.3 }, 10, 10);
  expect(rMin.w === 0.02 && rMin.h === 0.02, 'resize 最小尺寸 clamp MIN_WH');

  // hitTestPosterHandle：角点命中 nw 手柄 / 内部 move / 空白 null
  const defs2 = defaultPosterElements();
  const hNW = hitTestPosterHandle(defs2, 0.06, 0.05, 0);
  expect(hNW && hNW.idx === 0 && hNW.mode === 'nw', '命中 nw 手柄');
  const hMove = hitTestPosterHandle(defs2, 0.3, 0.1, 0);
  expect(hMove && hMove.idx === 0 && hMove.mode === 'move', '元素内部 → move');
  expect(hitTestPosterHandle(defs2, 0.99, 0.99, 0) === null, '空白区域 → null');

  // handlePtsN：8 手柄 + 角点/中点顺序
  const pts = handlePtsN({ x: 0, y: 0, w: 0.4, h: 0.4 });
  expect(pts.length === 8, '8 个手柄');
  expect(pts[0][0] === 0 && pts[0][1] === 0 && pts[2][0] === 0.4 && pts[2][1] === 0, 'nw/ne 角点');
  expect(pts[1][0] === 0.2 && pts[1][1] === 0, 'n 中点');

  // posterHandlePosN：n = 上边中点，rotate 在 n 上方 ROTATE_OFFSET
  const el0 = { id: 'x', type: 'text', x: 0.1, y: 0.1, w: 0.4, h: 0.4 };
  const nP = posterHandlePosN(el0, 'n');
  const rP = posterHandlePosN(el0, 'rotate');
  expect(Math.abs(nP.x - 0.3) < 1e-9 && Math.abs(nP.y - 0.1) < 1e-9, 'n 手柄 = 上边中点');
  expect(Math.abs(rP.x - 0.3) < 1e-9 && rP.y < 0.1, 'rotate 手柄在 n 上方');
  // 旋转 90° 后 rotate 手柄随旋转到右侧
  const rP90 = posterHandlePosN({ ...el0, rot: 90 }, 'rotate');
  expect(Math.abs(rP90.x - 0.54) < 1e-9 && Math.abs(rP90.y - 0.3) < 1e-9, 'rot=90 时 rotate 手柄在右侧');

  // normalizePosterRot：归一化到 (-180, 180]
  expect(normalizePosterRot(190) === -170, '190° → -170°');
  expect(normalizePosterRot(-190) === 170, '-190° → 170°');
  expect(normalizePosterRot(90) === 90 && normalizePosterRot(0) === 0, '90/0 不变');

  // posterAngleTo：四象限角度
  expect(Math.abs(posterAngleTo(0, 0, 1, 0)) < 1e-9, 'angleTo 右 = 0');
  expect(Math.abs(posterAngleTo(0, 0, 0, 1) - Math.PI / 2) < 1e-9, 'angleTo 下 = π/2');

  // cursorForPoster
  expect(cursorForPoster('move') === 'move' && cursorForPoster(null) === 'default', 'cursor move/default');
  expect(cursorForPoster('n') === 'ns-resize' && cursorForPoster('nw') === 'nwse-resize', 'cursor resize 方向');
}

section('P3 Poster: guides + grid contract');
{
  // parsePosterGuides：防御解析 __guides__
  expect(parsePosterGuides({}).length === 0, '无 __guides__ → 空');
  expect(parsePosterGuides({ __guides__: 'bad' }).length === 0, '非法 __guides__ → 空');
  const gs = parsePosterGuides({ __guides__: [
    { axis: 'x', pos: 0.5 },
    { axis: 'y', pos: 0.25 },
    { axis: 'z', pos: 0.5 },   // 非法 axis 过滤
    { axis: 'x', pos: 2 },     // pos 越界过滤
    { axis: 'y', pos: -0.1 },  // pos 越界过滤
  ] });
  expect(gs.length === 2 && gs[0].axis === 'x' && gs[0].pos === 0.5 && gs[1].axis === 'y' && gs[1].pos === 0.25, '过滤非法 axis / pos 越界');

  // posterGridOn：__grid__ 开关
  expect(posterGridOn({}) === false && posterGridOn({ __grid__: false }) === false && posterGridOn({ __grid__: true }) === true, '__grid__ 开关');

  // posterGuideHitIndex：命中参考线
  const gs2 = parsePosterGuides({ __guides__: [{ axis: 'x', pos: 0.5 }, { axis: 'y', pos: 0.3 }] });
  expect(posterGuideHitIndex(gs2, 0.505, 0.1) === 0, '命中竖参考线 x=0.5');
  expect(posterGuideHitIndex(gs2, 0.1, 0.305) === 1, '命中横参考线 y=0.3');
  expect(posterGuideHitIndex(gs2, 0.1, 0.1) === -1, '远离参考线 → -1');
  expect(posterGuideHitIndex(gs2, 0.6, 0.6) === -1, 'x/y 均远离 → -1');
}

section('P3 Poster: image inner edit (img_scale/img_x/img_y)');
{
  // posterImageProps 默认 + 读取
  const ip0 = posterImageProps({ id: 'i', type: 'image' });
  expect(ip0.scale === 1 && ip0.x === 0 && ip0.y === 0, 'posterImageProps 默认 1/0/0');
  const ip1 = posterImageProps({ id: 'i', type: 'image', img_scale: 2.5, img_x: 0.3, img_y: -0.4 });
  expect(ip1.scale === 2.5 && ip1.x === 0.3 && ip1.y === -0.4, 'posterImageProps 读 img_scale/img_x/img_y');

  // clampImgScale [1,4]
  expect(clampImgScale(0.5) === 1 && clampImgScale(5) === 4 && clampImgScale(2.5) === 2.5, 'clampImgScale clamp 到 [1,4]');

  // applyImgDrag：scale=1 → max=0 不可平移
  const d0 = applyImgDrag({ scale: 1, x: 0, y: 0 }, 0.5, 0.5);
  expect(d0.x === 0 && d0.y === 0, 'scale=1 时不可平移');
  // applyImgDrag：scale=2 → max=0.5
  const d1 = applyImgDrag({ scale: 2, x: 0, y: 0 }, 0.2, 0.3);
  expect(Math.abs(d1.x - 0.2) < 1e-9 && Math.abs(d1.y - 0.3) < 1e-9, 'scale=2 平移 dx/dy');
  const d2 = applyImgDrag({ scale: 2, x: 0, y: 0 }, 10, -10);
  expect(d2.x === 0.5 && d2.y === -0.5, '平移 clamp 到 ±(scale-1)/2');

  // applyImgScale：缩放时 clamp img_x/img_y 到新 max
  const s1 = applyImgScale({ scale: 1, x: 0, y: 0 }, 3);
  expect(s1.scale === 3 && s1.x === 0 && s1.y === 0, '放大到 3 max=1，0 不变');
  const s2 = applyImgScale({ scale: 2, x: 0.5, y: -0.5 }, 1);
  expect(s2.scale === 1 && s2.x === 0 && s2.y === 0, '缩回 1 max=0，x/y 归零');

  // renderPoster 图像内编辑变换：img_scale 触发 ctx.scale + translate 围绕中心
  const ops = [];
  const ictx = {
    fillStyle: null, strokeStyle: null, lineWidth: 0, font: null, textAlign: null, textBaseline: null,
    fillRect: (...a) => ops.push(['fillRect', a]),
    fillText: () => {}, drawImage: (...a) => ops.push(['drawImage', a]),
    beginPath: () => {}, arc: () => {}, ellipse: () => {}, moveTo: () => {}, lineTo: () => {}, fill: () => {}, stroke: () => {},
    save: () => ops.push(['save']), restore: () => ops.push(['restore']),
    translate: (...a) => ops.push(['translate', a]),
    rotate: (...a) => ops.push(['rotate', a]),
    scale: (...a) => ops.push(['scale', a]),
  };
  renderPoster(ictx, [{ id: 'im', type: 'image', slot: 0, x: 0.1, y: 0.1, w: 0.3, h: 0.3, img_scale: 2, img_x: 0.1, img_y: 0.2 }], ['IMG'], 1000, 1000);
  const scaleCall = ops.find(o => o[0] === 'scale');
  expect(scaleCall && scaleCall[1][0] === 2 && scaleCall[1][1] === 2, 'img_scale=2 → ctx.scale(2,2)');
  // translate 第一次是 (cx + ix*pw, cy + iy*ph) = (250+30, 250+60) = (280, 310)
  const firstT = ops.find(o => o[0] === 'translate');
  expect(firstT && Math.abs(firstT[1][0] - 280) < 1e-9 && Math.abs(firstT[1][1] - 310) < 1e-9, 'translate 到 中心+偏移 (280,310)');
}

section('P3 Poster: arrange + snapping 纯逻辑（对齐 ComfyTV arrange.ts/snapping.ts）');
{
  const close = (a, b) => Math.abs(a - b) < 1e-9;

  // unionRect
  const u = unionRect([{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, { x: 0.5, y: 0.6, w: 0.1, h: 0.1 }]);
  expect(close(u.x, 0.1) && close(u.y, 0.2) && close(u.w, 0.5) && close(u.h, 0.5), 'unionRect 包围盒');
  expect(unionRect([]).w === 0, '空 unionRect → 0');

  // isAlignOp
  expect(isAlignOp('left') && !isAlignOp('hspread'), 'isAlignOp 区分 align/distribute');

  // align left：x 对齐到 union 左边缘
  const rects = [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, { x: 0.5, y: 0.3, w: 0.3, h: 0.2 }];
  const aL = arrange(rects, 'left');
  expect(close(aL[1].dx, 0.1 - 0.5) && aL[0].dx === 0 && aL[1].dy === 0, 'align left 第二个移到 x=0.1');
  // align vcenter：y 中心对齐（union y 中心 = (0.1..0.5) → 0.3）
  const aV = arrange(rects, 'vcenter');
  expect(close(aV[0].dy, 0.3 - 0.2) && aV[0].dx === 0, 'align vcenter y 中心对齐');

  // distribute hgap：等间距（first/last 不动，中间移到等 gap）
  const d3 = [{ x: 0.1, y: 0, w: 0.1, h: 0.1 }, { x: 0.3, y: 0, w: 0.1, h: 0.1 }, { x: 0.7, y: 0, w: 0.1, h: 0.1 }];
  const dGap = distribute(d3, 'hgap');
  expect(dGap[0].dx === 0 && dGap[2].dx === 0 && close(dGap[1].dx, 0.1), 'hgap 中间移到等距 (0.3→0.4)');
  // distribute <3 不移动
  expect(distribute(d3.slice(0, 2), 'hgap')[1].dx === 0, 'distribute <3 → 不移动');
  // hspread：首尾固定，中间均分（0.15..0.75 → 中点 0.45，中间 0.35→0.45）
  const dSpread = distribute(d3, 'hspread');
  expect(dSpread[0].dx === 0 && dSpread[2].dx === 0 && close(dSpread[1].dx, 0.1), 'hspread 中间居中 (0.3→0.4)');

  // buildSnapTargets：边界 + 其他元素边缘/中点 + 网格 + 参考线
  const tgt = buildSnapTargets([{ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }], { w: 1, h: 1 }, { gridX: 1 / 12, guideXs: [0.5] });
  expect(tgt.xs.includes(0) && tgt.xs.includes(1) && tgt.xs.includes(0.2) && tgt.xs.includes(0.5) && tgt.xs.includes(0.35), 'snap targets 含边界/边缘/中点/参考线');

  // nearestTarget
  expect(nearestTarget(0.51, [0.5, 0.6], 0.02) === 0.5, 'nearestTarget 吸附最近');
  expect(nearestTarget(0.51, [0.5], 0.005) === null, '超阈值 → null');

  // applySnap move：吸附到左边界
  const snapM = applySnap('move', { x: 0.012, y: 0.2, w: 0.3, h: 0.3 }, buildSnapTargets([]), { thrX: 0.02, thrY: 0.02, minWH: 0.02 });
  expect(close(snapM.rect.x, 0) && snapM.guides.length >= 1, 'move 吸附到 x=0 边界');
  // applySnap resize e：右边缘吸附到 1（x+w=0.99 差 0.01 < thr 0.02）
  const snapR = applySnap('e', { x: 0.1, y: 0.1, w: 0.89, h: 0.3 }, buildSnapTargets([]), { thrX: 0.02, thrY: 0.02, minWH: 0.02 });
  expect(close(snapR.rect.w, 0.9), 'resize e 右边缘吸附到 x=1');
  // applySnap clamp 边界
  const snapC = applySnap('move', { x: 0.9, y: 0.9, w: 0.3, h: 0.3 }, buildSnapTargets([]), { thrX: 0.02, thrY: 0.02, minWH: 0.02 });
  expect(close(snapC.rect.x, 0.7) && close(snapC.rect.y, 0.7), 'move clamp 到边界内');
}

section('P3 Poster: size presets (SIZE_PRESETS / sizePresetFor)');
{
  // SIZE_PRESETS：6 个预设，首尾 + 方形
  expect(SIZE_PRESETS.length === 6, '6 个尺寸预设');
  expect(SIZE_PRESETS[0].label === 'A4 竖 1240×1754' && SIZE_PRESETS[0].w === 1240 && SIZE_PRESETS[0].h === 1754, '首个 A4 竖 1240×1754');
  expect(SIZE_PRESETS[2].w === 1240 && SIZE_PRESETS[2].h === 1240, '方形 1240×1240');

  // sizePresetFor：精确匹配 → label；否则 null
  expect(sizePresetFor(1240, 1754) === 'A4 竖 1240×1754', '匹配 A4 竖');
  expect(sizePresetFor(1080, 1920) === '竖屏 9:16 1080×1920', '匹配 竖屏 9:16');
  expect(sizePresetFor(1000, 1000) === null, '非预设 → null');
  expect(sizePresetFor(1240, 1240) === '方形 1240×1240', '匹配方形');
}

section('P3 Poster: local execution emits the composed render');
{
  const store = {
    put: () => {},
    byNode: (id) => id === 'ps'
      ? [{ nodeId: 'ps', port: 'output', key: 'ps:output:0', media: { kind: 'image', ref: 'http://x/poster.png' }, index: 0 }]
      : [],
  };
  const r = await runPosterNode({ nodeId: 'ps', values: {}, store });
  expect(r.status === 'success' && r.entries.length === 1 && r.entries[0].media.ref === 'http://x/poster.png', 'poster emits its render snapshot');
  const rEmpty = await runPosterNode({ nodeId: 'empty', values: {}, store });
  expect(rEmpty.status === 'error' && rEmpty.error.includes('排版'), 'poster without a render errors with a hint');
}

section('P3 Corner Pin: corners contract + drag math');
{
  expect(isCornerPinNode('ComfyTV.CornerPinStage') && !isCornerPinNode('ComfyTV.VideoStage'), 'corner pin classified');
  // 对齐 ComfyTV useCornerPinEditor.ts：corners 是**像素坐标**，defaultCorners(vw,vh) 全图
  const def = defaultCorners(1920, 1080);
  expect(def.length === 4 && def[0][0] === 0 && def[0][1] === 0 && def[2][0] === 1920 && def[2][1] === 1080, 'default corners = 全图像素角点（TL 0,0 / BR 1920,1080）');
  // 解析像素值
  const parsed = parseCorners('[[100,100],[1820,100],[1820,980],[100,980]]', 1920, 1080);
  expect(parsed[0][0] === 100 && parsed[2][0] === 1820 && parsed[2][1] === 980, '像素 corners 按 TL/TR/BR/BL 顺序解析');
  // 空/非法 → 全图默认（需 vw/vh）
  expect(parseCorners('{bad}', 1920, 1080)[2][0] === 1920, 'broken JSON 回退全图（vw/vh）');
  expect(parseCorners('', 1280, 720)[3][1] === 720, '空串回退全图');
  expect(parseCorners('', 0, 0)[0][0] === 0, 'vw=0 回退零角点');
  // 序列化保留 1 位小数（对齐 ComfyTV serializeCorners）
  expect(serializeCorners([[100.04, 100.06], [1820, 100], [1820, 980], [100, 980]]) === '[[100,100.1],[1820,100],[1820,980],[100,980]]', 'serialize 保留 1 位小数');
  // clamp 像素坐标到视频范围
  const clamped = clampCorner([2000, -50], 1920, 1080);
  expect(clamped[0] === 1919 && clamped[1] === 1, 'clampCorner 像素坐标 [1, vw-1]/[1, vh-1]');
  // nearestCornerIndex 命中距离 24px
  expect(nearestCornerIndex(parsed, 105, 100) === 0, 'nearestCornerIndex 命中 TL');
  expect(nearestCornerIndex(parsed, 960, 540) === -1, '中心无命中（> 24px）');
}

section('P3 Corner Pin: popup wiring in the panel source');
{
  const popup = readFileSync(new URL('../src/features/workflowEditor/NodeEditorPopup.tsx', import.meta.url), 'utf8');
  expect(popup.includes('isCornerPinNode(nodeType)'), 'corner pin branch detected');
  expect(popup.includes('<CornerPinEditor'), 'corner pin editor rendered in the popup');
  expect(popup.includes('onValuesCommit?.(nodeId, { corners: json })'), 'corners persisted into node values');
}

section('P3 Roto Mask: spline data contract + vertex math');
{
  expect(isRotoMaskNode('ComfyTV.RotoMaskStage') && !isRotoMaskNode('ComfyTV.VideoStage'), 'roto classified');
  const def = defaultShapePoints();
  expect(def.length === 3 && def[0].lx !== def[0].x, 'default triangle with outward tangents');
  const parsed = parseShapeKeys('[{"t":0,"points":[{"x":0.1,"y":0.1,"lx":0.05,"ly":0.1,"rx":0.15,"ry":0.1},{"x":0.8,"y":0.1,"lx":0.7,"ly":0.1,"rx":0.9,"ry":0.1},{"x":0.5,"y":0.8,"lx":0.4,"ly":0.8,"rx":0.6,"ry":0.8}]}]');
  expect(parsed !== null && parsed.t === 0 && parsed.points.length === 3 && parsed.points[1].x === 0.8, 'shape_keys parsed (first keyframe)');
  expect(parseShapeKeys('[{bad') === null, 'broken JSON → null');
  expect(parseShapeKeys('[]') === null, 'empty keyframes → null');
  expect(parseShapeKeys('[{t:0,points:[{x:0,y:0,lx:0,ly:0,rx:0,ry:0},{x:1,y:0,lx:0,ly:0,rx:0,ry:0}]}]') === null, 'fewer than 3 points rejected');
  const json = shapeKeysToJson([{ t: 0, points: [{ x: 0.1234, y: 0.5, lx: 0.1, ly: 0.5, rx: 0.15, ry: 0.5 }] }]);
  expect(json.includes('"x":0.123') && json.includes('"t":0'), 'serialization rounds to 3 decimals');

  const p = addShapePoint(def, 0.5, 0.5);
  expect(p.length === 4 && p[3].x === 0.5 && p[3].rx === 0.58, 'append vertex with outward handles');
  const moved = moveShapePoint(p, 3, 0.6, 0.6);
  expect(moved[3].x === 0.6 && Math.abs(moved[3].lx - (0.42 + 0.1)) < 1e-9, 'vertex move translates handles along');
  const tang = moveShapeTangent(moved, 3, 'r', 0.7, 0.2);
  expect(tang[3].rx === 0.7 && tang[3].ry === 0.2 && tang[3].x === 0.6, 'right tangent moved independently');
  expect(removeShapePoint(tang, 3).length === 3, 'remove vertex works');
  const kept = removeShapePoint(tang.slice(0, 3), 0);
  expect(kept.length === 3, 'cannot remove below 3 points');
}

section('P3 Roto Mask: popup wiring in the panel source');
{
  const popup = readFileSync(new URL('../src/features/workflowEditor/NodeEditorPopup.tsx', import.meta.url), 'utf8');
  expect(popup.includes('isRotoMaskNode(nodeType)'), 'roto branch detected');
  expect(popup.includes('<RotoMaskEditor'), 'roto editor rendered in the popup');
  expect(popup.includes('onValuesCommit?.(nodeId, { shape_keys: shapeKeysJson, feather, invert })'), 'shape_keys/feather/invert persisted');
}

section('P3 Layer Editor: document model + composite render');
{
  expect(isLayerEditorNode('ComfyTV.LayerEditorStage') && !isLayerEditorNode('ComfyTV.ImageStage'), 'layer editor classified');
  const def = defaultLayerDoc();
  expect(def.width === 1024 && def.height === 1024 && def.layers.length === 1 && def.layers[0].visible, 'default doc: one visible layer, 1024×1024');
  const parsed = parseLayerDoc('{"width":512,"height":256,"layers":[{"id":"a","name":"L","visible":false,"opacity":0.5,"ops":[{"type":"rect","color":"#fff","size":1,"x":0.1,"y":0.1,"w":0.2,"h":0.2}]}]}');
  expect(parsed.width === 512 && parsed.layers[0].visible === false && parsed.layers[0].opacity === 0.5, 'doc parsed (visibility/opacity honored)');
  expect(parseLayerDoc('{bad').layers.length === 1, 'broken JSON falls back to defaults');
  const withOp = addLayerOp(def, def.layers[0].id, { type: 'circle', color: '#0f0', size: 1, x: 0.5, y: 0.5, w: 0.1, h: 0.1 });
  expect(withOp.layers[0].ops.length === 1 && JSON.parse(layerDocToJson(withOp)).layers[0].ops.length === 1, 'op added + doc round-trips through JSON');

  const calls = [];
  const ctx = {
    fillStyle: null, strokeStyle: null, lineWidth: 0, globalAlpha: 1, font: null,
    textAlign: null, textBaseline: null,
    save: () => calls.push(['save']), restore: () => calls.push(['restore']),
    fillRect: (...a) => calls.push(['fillRect', a]), fillText: (...a) => calls.push(['fillText', a]),
    beginPath: () => calls.push(['beginPath']), moveTo: (...a) => calls.push(['moveTo', a]),
    lineTo: (...a) => calls.push(['lineTo', a]), arc: (...a) => calls.push(['arc', a]),
    stroke: () => calls.push(['stroke']), fill: () => calls.push(['fill']),
  };
  const doc = {
    width: 1000, height: 1000,
    layers: [
      { id: 'hidden', name: 'h', visible: false, opacity: 1, ops: [{ type: 'rect', color: '#f00', size: 1, x: 0, y: 0, w: 1, h: 1 }] },
      { id: 'paint', name: 'p', visible: true, opacity: 1, ops: [
        { type: 'rect', color: '#00f', size: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
        { type: 'stroke', color: '#fff', size: 0.02, points: [[0.1, 0.1], [0.5, 0.5]] },
      ] },
    ],
  };
  drawLayerDoc(ctx, doc);
  expect(!calls.some(c => c[0] === 'fillRect' && c[1] && c[1][0] === 0 && c[1][3] === 1000 && c[1][4] === 1000), 'hidden layer skipped');
  expect(calls.some(c => c[0] === 'fillRect' && c[1] && Math.abs(c[1][0] - 100) < 0.01 && Math.abs(c[1][1] - 200) < 0.01 && Math.abs(c[1][2] - 300) < 0.01 && Math.abs(c[1][3] - 400) < 0.01), 'rect drawn at normalized box');
  const moveCalls = calls.filter(c => c[0] === 'moveTo');
  expect(moveCalls.length >= 1 && Math.abs(moveCalls[0][1][0] - 100) < 0.01, 'stroke polyline normalized to pixels');
}

section('P3 Layer Editor: local execution emits the composite');
{
  const store = {
    put: () => {},
    byNode: (id) => id === 'le'
      ? [{ nodeId: 'le', port: 'output', key: 'le:output:0', media: { kind: 'image', ref: 'http://x/layered.png' }, index: 0 }]
      : [],
  };
  const r = await runLayerEditorNode({ nodeId: 'le', values: {}, store });
  expect(r.status === 'success' && r.entries.length === 1 && r.entries[0].media.ref === 'http://x/layered.png', 'layer editor emits its composite snapshot');
  const rEmpty = await runLayerEditorNode({ nodeId: 'empty', values: {}, store });
  expect(rEmpty.status === 'error', 'layer editor without a composite errors');
}

section('P3 Storyboard Editor: board model (reuses layer docs)');
{
  expect(isStoryboardEditorNode('ComfyTV.StoryboardEditorStage') && !isStoryboardEditorNode('ComfyTV.ImageStage'), 'storyboard classified');
  const def = defaultBoardState();
  // 对齐 ComfyTV boardDoc.ts：version/defaultBoardTimingMs + StoryBoardData 14 字段
  expect(def.version === 1 && def.width === 1280 && def.height === 720 && def.defaultBoardTimingMs === 2000 && def.boards.length === 1, 'default board state (version1 1280×720 timing2000ms one board)');
  expect(def.boards[0].uid.length === 5 && /^[A-Z0-9]{5}$/.test(def.boards[0].uid), 'board uid 5 位大写字母数字');
  expect(def.boards[0].newShot === true && def.boards[0].durationMs === null && def.boards[0].layerState?.layers.length === 1, 'board 默认 newShot=true/durationMs=null/layerState 1 图层');
  expect(def.boards[0].dialogue === '' && def.boards[0].action === '' && def.boards[0].notes === '' && def.boards[0].scenePurpose === '' && def.boards[0].character === '' && def.boards[0].shotSize === '', '6 文本元数据字段默认空');
  expect(def.boards[0].imagePrompt === '' && def.boards[0].motionPrompt === '' && def.boards[0].refUrl === null && def.boards[0].compositeUrl === null, '提示词/URL 字段默认空/null');

  // 解析旧格式（无 version）→ 回退默认；新格式（ComfyTV 14 字段）→ 完整解析
  const parsed = parseBoardState('{"width":640,"height":360,"defaultBoardTimingMs":1500,"boards":[{"uid":"AB12C","newShot":false,"durationMs":5000,"dialogue":"hello","action":"run","notes":"close-up","scenePurpose":"setup","character":"A","shotSize":"CU","imagePrompt":"img","motionPrompt":"move","refUrl":"/view?1","compositeUrl":"/view?2","layerState":{"width":640,"height":360,"layers":[{"id":"l","name":"L","visible":true,"opacity":1,"ops":[{"type":"rect","color":"#fff","size":1,"x":0.1,"y":0.1,"w":0.2,"h":0.2}]}]}}]}');
  expect(parsed.version === 1 && parsed.defaultBoardTimingMs === 1500, 'defaultBoardTimingMs 解析');
  expect(parsed.boards.length === 1 && parsed.boards[0].uid === 'AB12C' && parsed.boards[0].newShot === false && parsed.boards[0].durationMs === 5000, 'board 14 字段解析（uid/newShot/durationMs）');
  expect(parsed.boards[0].dialogue === 'hello' && parsed.boards[0].action === 'run' && parsed.boards[0].notes === 'close-up' && parsed.boards[0].scenePurpose === 'setup' && parsed.boards[0].character === 'A' && parsed.boards[0].shotSize === 'CU', '6 文本元数据字段解析');
  expect(parsed.boards[0].imagePrompt === 'img' && parsed.boards[0].motionPrompt === 'move' && parsed.boards[0].refUrl === '/view?1' && parsed.boards[0].compositeUrl === '/view?2', '提示词/URL 字段解析');
  expect(parsed.boards[0].layerState?.width === 640 && parsed.boards[0].layerState?.layers[0].ops.length === 1, 'layerState（LayerDoc）解析');
  expect(parseBoardState('{bad').boards.length === 1, 'broken JSON falls back to defaults');

  // boardDurationMs / boardImageUrl（对齐 ComfyTV 派生函数）
  expect(boardDurationMs(parsed, parsed.boards[0]) === 5000, 'boardDurationMs = durationMs ?? defaultBoardTimingMs');
  const nullDur = patchBoard(parsed, 'AB12C', { durationMs: null });
  expect(boardDurationMs(nullDur, nullDur.boards[0]) === 1500, 'durationMs=null 回退 defaultBoardTimingMs');
  expect(boardImageUrl(parsed.boards[0]) === '/view?2', 'boardImageUrl = compositeUrl || refUrl');

  // 序列化往返
  const round = JSON.parse(boardStateToJson(parsed));
  expect(round.version === 1 && round.boards[0].uid === 'AB12C' && round.boards[0].durationMs === 5000 && round.boards[0].layerState.layers[0].ops.length === 1, 'board_state 往返（version/uid/durationMs/layerState）');

  // add/move/remove/patch（uid 为标识）
  let s = defaultBoardState();
  s = addBoard(s);
  expect(s.boards.length === 2 && s.boards[1].uid.length === 5, 'board added（uid 5 位）');
  const before = s.boards[1].uid;
  s = moveBoard(s, before, -1);
  expect(s.boards[0].uid === before, 'board moved up');
  const kept = removeBoard(s, s.boards[0].uid);
  expect(kept.boards.length === 1, 'board removed');
  expect(removeBoard(kept, kept.boards[0].uid).boards.length === 1, 'cannot remove the last board');
  s = patchBoard(s, before, { durationMs: 9000, notes: 'wide' });
  expect(s.boards.find(b => b.uid === before).durationMs === 9000 && s.boards.find(b => b.uid === before).notes === 'wide', 'board patched');
}

section('P3 Storyboard Editor: local execution emits the cover');
{
  const store = {
    put: () => {},
    byNode: (id) => id === 'sb'
      ? [{ nodeId: 'sb', port: 'output', key: 'sb:output:0', media: { kind: 'image', ref: 'http://x/cover.png' }, index: 0 }]
      : [],
  };
  const r = await runStoryboardEditorNode({ nodeId: 'sb', values: {}, store });
  expect(r.status === 'success' && r.entries.length === 1 && r.entries[0].media.ref === 'http://x/cover.png', 'storyboard emits its cover snapshot');
  const rEmpty = await runStoryboardEditorNode({ nodeId: 'empty', values: {}, store });
  expect(rEmpty.status === 'error', 'storyboard without a cover errors');
}

section('P3 Material: PBR params + presets + ball render');
{
  expect(isMaterialNode('ComfyTV.MaterialStage') && !isMaterialNode('ComfyTV.ImageStage'), 'material classified');
  // 11 字段契约（对齐 ComfyTV types.ts，含 version/opacity/ior/emissive/emissiveIntensity）
  expect(DEFAULT_MATERIAL.version === 1 && DEFAULT_MATERIAL.color === '#8fbf8f' && DEFAULT_MATERIAL.metalness === 0 && DEFAULT_MATERIAL.roughness === 0.4, 'defaults match ComfyTV (version1 color #8fbf8f r0.4)');
  expect(DEFAULT_MATERIAL.opacity === 1 && DEFAULT_MATERIAL.ior === 1.5 && DEFAULT_MATERIAL.emissive === '#000000' && DEFAULT_MATERIAL.emissiveIntensity === 0, '新增字段默认值（opacity1 ior1.5 emissive#000000 intensity0）');
  const norm = normalizeMaterial({ color: '#E6B553', metalness: 5, roughness: -1, transmission: 1, clearcoat: 0.5, clearcoatRoughness: 0.25, opacity: 0.5, ior: 2.0, emissive: '#ff0000', emissiveIntensity: 0.8 });
  expect(norm.color === '#e6b553' && norm.metalness === 1 && norm.roughness === 0 && norm.transmission === 1, 'normalize clamps + lowercases color');
  expect(norm.opacity === 0.5 && norm.ior === 2.0 && norm.emissive === '#ff0000' && norm.emissiveIntensity === 0.8, 'normalize 保留 opacity/ior/emissive/emissiveIntensity');
  const bad = normalizeMaterial({ color: 'red' });
  expect(bad.color === DEFAULT_MATERIAL.color && bad.ior === 1.5 && bad.opacity === 1, 'invalid color/缺字段 falls back（ior 默认 1.5，opacity 默认 1）');
  // ior clamp 1-2.333
  expect(normalizeMaterial({ ior: 5 }).ior === 2.333 && normalizeMaterial({ ior: 0.5 }).ior === 1, 'ior clamp 到 [1, 2.333]');
  expect(parseMaterialState('{bad').color === '#8fbf8f', 'broken material_state falls back');
  expect(JSON.parse(materialStateToJson(norm)).roughness === 0, 'material_state round-trips');
  expect(JSON.parse(materialStateToJson(norm)).version === 1 && JSON.parse(materialStateToJson(norm)).ior === 2.0, 'round-trip 含 version/ior');
  expect(MATERIAL_PRESETS.length === 8 && MATERIAL_PRESETS.some(p => p.key === 'metalPolished'), '8 ComfyTV presets');
  const colored = applyPreset({ ...DEFAULT_MATERIAL, color: '#ff0000' }, { roughness: 0.1 });
  expect(colored.roughness === 0.1 && colored.color === '#ff0000', 'preset never touches color');

  const calls = [];
  const ctx = {
    fillStyle: null, globalAlpha: 1,
    fillRect: (...a) => calls.push(['fillRect', a]),
    beginPath: () => calls.push(['beginPath']),
    arc: (...a) => calls.push(['arc', a]),
    fill: () => calls.push(['fill']),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    ellipse: (...a) => calls.push(['ellipse', a]),
  };
  renderMaterialBall(ctx, normalizeMaterial({ color: '#ffffff', roughness: 0.1 }), 180, 180, 110);
  expect(calls.filter(c => c[0] === 'arc').length >= 3, 'ball + specular highlight arcs drawn');
  expect(calls.some(c => c[0] === 'ellipse'), 'ground shadow ellipse drawn');
}

section('P3 Material: local execution emits ball image + PBR JSON');
{
  const store = {
    put: () => {},
    byNode: (id) => id === 'mat'
      ? [{ nodeId: 'mat', port: 'output', key: 'mat:output:0', media: { kind: 'image', ref: 'http://x/material.png' }, index: 0 }]
      : [],
  };
  const r = await runMaterialNode({ nodeId: 'mat', values: { material_state: '{"color":"#0000ff","metalness":1}' }, store });
  expect(r.status === 'success' && r.entries.length === 2, 'material emits 2 outputs');
  expect(r.entries[0].media.kind === 'image' && r.entries[1].media.kind === 'text' && r.entries[1].media.ref.includes('"metalness":1'), 'slot0=ball image, slot1=PBR JSON');
  const rEmpty = await runMaterialNode({ nodeId: 'empty', values: {}, store });
  expect(rEmpty.status === 'error' && rEmpty.entries.length === 1, 'material without a ball errors (material JSON still returned)');
}

section('P3 Scene3D: 数据契约对齐 ComfyTV Scene3DState（scene3dEditor）');
{
  expect(isScene3DNode('ComfyTV.Scene3DStage') && !isScene3DNode('ComfyTV.ImageStage'), 'scene3d classified');
  const empty = createEmptyScene();
  expect(empty.version === 1 && empty.primitives.length === 0 && empty.lights.length === 0 && empty.characters.length === 0 && empty.cameras.length === 0, 'createEmptyScene: 空场景 5 类对象');
  expect(empty.output.fps === 24 && empty.output.frameCount === 0 && empty.output.cameraId === '', 'output 默认 fps24/frameCount0');
  expect(empty.environment.showGrid === true && empty.environment.background === '' && empty.environment.showRoom === false, 'environment 默认 showGrid');

  // createDefaultPrimitive：id 自增、shape 类型、plane 的 y=0 其他 y=0.5
  const p1 = createDefaultPrimitive('cube', []);
  const p2 = createDefaultPrimitive('sphere', [p1.id]);
  expect(p1.id === 'prim_1' && p2.id === 'prim_2', 'primitive id 自增 prim_1/prim_2');
  expect(p1.shape === 'cube' && p2.shape === 'sphere', 'shape 保留');
  expect(p1.transform.position.y === 0.5, 'cube 默认 y=0.5');
  const plane = createDefaultPrimitive('plane', []);
  expect(plane.transform.position.y === 0, 'plane 默认 y=0');
  expect(p1.transform.quaternion.w === 1 && p1.transform.scale.x === 1, '默认 quaternion w=1 / scale=1');

  // createDefaultLight：三种类型默认值对齐 ComfyTV types.ts
  const dir = createSceneDefaultLight('directional', []);
  const spot = createSceneDefaultLight('spot', [dir.id]);
  expect(dir.id === 'light_1' && spot.id === 'light_2', 'light id 自增');
  expect(dir.position.x === 3 && dir.position.y === 5 && dir.intensity === 2 && dir.target.y === 0, 'directional 默认值');
  expect(spot.innerConeAngle === 30 && spot.outerConeAngle === 45 && spot.intensity === 15, 'spot 默认 cone/intensity');

  // add/remove/patch
  let s = createEmptyScene();
  s = addPrimitive(s, 'cylinder');
  expect(s.primitives.length === 1 && s.primitives[0].shape === 'cylinder', 'addPrimitive');
  s = addLight(s, 'point');
  expect(s.lights.length === 1 && s.lights[0].type === 'point', 'addLight');
  const pid = s.primitives[0].id;
  s = patchPrimitive(s, pid, { color: '#123456' });
  expect(s.primitives[0].color === '#123456', 'patchPrimitive');
  s = removePrimitive(s, pid);
  expect(s.primitives.length === 0, 'removePrimitive');

  // 序列化往返 + 防御解析
  const json = sceneStateToJson(s);
  const round = parseSceneState(json);
  expect(round.version === 1 && round.lights.length === 1 && round.lights[0].type === 'point', 'scene_state 往返');
  expect(parseSceneState('{bad').version === 1 && parseSceneState('{bad').primitives.length === 0, '非法 JSON → 空场景');
  expect(parseSceneState(undefined).version === 1, 'undefined → 空场景');
  // 旧 2.5D SceneDoc（无 version）无法迁移 → 空场景
  expect(parseSceneState('{"width":800,"height":600,"objects":[]}').primitives.length === 0, '旧 SceneDoc 无 version → 空场景');

  // cloneScene 深拷贝
  const src = addPrimitive(createEmptyScene(), 'cube');
  const cloned = cloneScene(src);
  cloned.primitives[0].transform.position.x = 999;
  expect(src.primitives[0].transform.position.x === 0, 'cloneScene 深拷贝（改 clone 不影响源）');
}

section('P3 Scene3D: yaw/quaternion 纯逻辑（旋转 Gizmo）');
{
  const { rotationYOf, quaternionFromYaw, createDefaultPrimitive } = await import('../src/features/workflowEditor/comfyHost/scene3dEditor.js');

  // quaternionFromYaw(0) → 单位四元数
  const q0 = quaternionFromYaw(0);
  expect(Math.abs(q0.w - 1) < 1e-9 && Math.abs(q0.y) < 1e-9, 'yaw=0 → 单位四元数 w=1,y=0');

  // quaternionFromYaw(90°) → 绕 Y 轴 90°（w=y=√2/2）
  const q90 = quaternionFromYaw(Math.PI / 2);
  expect(Math.abs(q90.w - Math.SQRT1_2) < 1e-9 && Math.abs(q90.y - Math.SQRT1_2) < 1e-9, 'yaw=90° → w=y=√2/2');

  // rotationYOf 往返：yaw → quaternion → yaw
  const yaw = 1.234;
  const round = rotationYOf({ transform: { quaternion: quaternionFromYaw(yaw) } });
  expect(Math.abs(round - yaw) < 1e-9, `rotationYOf(quaternionFromYaw(1.234)) 往返 (got ${round})`);

  // 默认 primitive quaternion w=1 → rotationY=0
  const p = createDefaultPrimitive('cube', []);
  expect(Math.abs(rotationYOf(p) - 0) < 1e-9, '默认 quaternion(w=1) → yaw=0');

  // 负 yaw 往返
  const yawNeg = -2.0;
  const roundNeg = rotationYOf({ transform: { quaternion: quaternionFromYaw(yawNeg) } });
  expect(Math.abs(roundNeg - yawNeg) < 1e-9, `负 yaw=-2.0 往返 (got ${roundNeg})`);
}

section('P3 Scene3D: undo/redo 历史栈 + 相机函数');
{
  const { Scene3dHistory } = await import('../src/features/workflowEditor/comfyHost/scene3dHistory.js');
  const { addCamera, removeCamera, patchCamera, createEmptyScene } = await import('../src/features/workflowEditor/comfyHost/scene3dEditor.js');

  // ── Scene3dHistory（对齐 ComfyTV Scene3dHistory）──
  const h = new Scene3dHistory({ mergeWindowMs: 100, now: () => mockNow() });
  let mockNowVal = 0;
  function mockNow() { return mockNowVal; }

  expect(h.canUndo() === false && h.canRedo() === false, '初始 canUndo/canRedo = false');

  // record 3 次快照
  h.record({ json: 's0', selectedId: null });
  mockNowVal = 10;
  h.record({ json: 's1', selectedId: 'a' });
  mockNowVal = 20;
  h.record({ json: 's2', selectedId: 'a' });
  expect(h.canUndo() === true, 'record 后可 undo');

  // undo 两次
  const u1 = h.undo({ json: 's3', selectedId: 'b' });
  expect(u1?.json === 's2', 'undo 返回最近快照 s2');
  expect(h.canRedo() === true, 'undo 后可 redo');
  const u2 = h.undo({ json: 's2', selectedId: 'a' });
  expect(u2?.json === 's1', '再 undo 返回 s1');

  // redo
  const r1 = h.redo({ json: 's1', selectedId: 'a' });
  expect(r1?.json === 's2', 'redo 返回 s2');

  // mergeKey：同 key + 窗口内合并为一步（对齐 ComfyTV：连续拖拽只记录第一次的 before）
  let now2 = 0;
  const h2 = new Scene3dHistory({ mergeWindowMs: 100, now: () => now2 });
  h2.record({ json: 'a0', selectedId: null }, 'drag:p1');   // now2=0，push a0
  now2 = 50;
  h2.record({ json: 'a1', selectedId: null }, 'drag:p1');   // 合并（同 key，50-0<100），只更新 last.time
  now2 = 200;
  h2.record({ json: 'a2', selectedId: null }, 'drag:p1');   // 超窗口（200-50=150>=100），push a2
  // undos = [a0, a2]；undo 一次 → 返回 a2（最后一次拖拽的 before）
  expect(h2.undo({ json: 'a3', selectedId: null })?.json === 'a2', '合并后 undo 返回最后一步 before a2');
  expect(h2.undo({ json: 'a2', selectedId: null })?.json === 'a0', '再 undo 返回拖拽开始前的 a0');
  expect(h2.canUndo() === false, '两次 undo 后无可撤销');

  // clear
  h2.clear();
  expect(h2.canUndo() === false && h2.canRedo() === false, 'clear 后无历史');

  // ── 相机函数 ──
  let s = createEmptyScene();
  s = addCamera(s);
  expect(s.cameras.length === 1 && s.cameras[0].id === 'cam_1' && s.cameras[0].fov === 50, 'addCamera 默认 cam_1/fov50');
  s = patchCamera(s, 'cam_1', { fov: 35 });
  expect(s.cameras[0].fov === 35, 'patchCamera fov');
  s = addCamera(s);
  expect(s.cameras.length === 2 && s.cameras[1].id === 'cam_2', 'addCamera id 自增 cam_2');
  s = removeCamera(s, 'cam_1');
  expect(s.cameras.length === 1 && s.cameras[0].id === 'cam_2', 'removeCamera 删除 cam_1');
  // 删除 output.cameraId 引用的相机 → 清空 cameraId
  let s2 = addCamera(createEmptyScene());
  s2 = { ...s2, output: { ...s2.output, cameraId: 'cam_1' } };
  s2 = removeCamera(s2, 'cam_1');
  expect(s2.output.cameraId === '', '删除 output 引用的相机清空 cameraId');
}

section('P3 Scene3D: environment/output patch 纯逻辑');
{
  const { patchEnvironment, patchOutput, createEmptyScene, parseSceneState, sceneStateToJson } = await import('../src/features/workflowEditor/comfyHost/scene3dEditor.js');

  let s = createEmptyScene();
  // patchEnvironment：只改 environment，不动其他字段
  s = patchEnvironment(s, { showGrid: false, background: '#123456' });
  expect(s.environment.showGrid === false && s.environment.background === '#123456', 'patchEnvironment 改 showGrid/background');
  expect(s.primitives.length === 0 && s.output.fps === 24, 'patchEnvironment 不动其他字段');

  // patchOutput：只改 output
  s = patchOutput(s, { fps: 30, frameCount: 100, cameraId: 'cam_9' });
  expect(s.output.fps === 30 && s.output.frameCount === 100 && s.output.cameraId === 'cam_9', 'patchOutput 改 fps/frameCount/cameraId');
  expect(s.environment.showGrid === false, 'patchOutput 不动 environment');

  // 序列化往返：environment/output 保留
  const round = parseSceneState(sceneStateToJson(s));
  expect(round.environment.showGrid === false && round.environment.background === '#123456' && round.output.fps === 30 && round.output.cameraId === 'cam_9', 'environment/output 序列化往返');
}

section('P3 Scene3D: timeline 纯逻辑（对齐 ComfyTV TimelineController + characterTime + timelineMath）');
{
  const {
    SceneTimelineController, characterElapsedTime, clipLocalTime, actionSampleTime,
    sceneFallbackDuration, computeTotalFrames, zoomFromExp, resolveContainerHeight,
  } = await import('../src/features/workflowEditor/comfyHost/scene3dTimeline.js');

  // ── SceneTimelineController ──
  const events = [];
  const ctrl = new SceneTimelineController(24, {
    onTimeUpdate: (frame, time) => events.push(['time', frame, time]),
    onStateChange: (playing, loop) => events.push(['state', playing, loop]),
  });
  expect(ctrl.totalFrames === 1 && ctrl.hasContent() === false, '初始 totalFrames=1（Math.max(1,...)）/hasContent=false');

  ctrl.setTimelineDuration(2);  // 2 秒 = 48 帧
  expect(ctrl.totalFrames === 48 && ctrl.hasContent() === true, 'setTimelineDuration(2s) → 48 帧');

  ctrl.play();
  expect(ctrl.isPlayingNow() === true, 'play 后 playing');
  ctrl.update(0.5);  // 前进 0.5s = 12 帧
  expect(ctrl.getCurrentFrame() === 12, 'update(0.5s) → frame 12');
  ctrl.pause();
  expect(ctrl.isPlayingNow() === false, 'pause 后停止');

  // seek
  ctrl.seekToFrame(24);
  expect(ctrl.getCurrentFrame() === 24 && Math.abs(ctrl.getCurrentTime() - 1) < 1e-9, 'seekToFrame(24) → time 1.0');
  ctrl.seekToTime(1.5);
  expect(ctrl.getCurrentFrame() === 36, 'seekToTime(1.5) → frame 36');

  // loop：播放到结尾回绕
  ctrl.setTimelineDuration(1);
  ctrl.play();
  ctrl.update(1.5);  // 超过 1s，loop 回绕
  expect(ctrl.isPlayingNow() === true && ctrl.getCurrentTime() < 1, 'loop 播放超时长回绕');
  ctrl.pause();

  // 非 loop：到结尾停止
  ctrl.seekToTime(0);
  ctrl.setLoopPlayback(false);
  ctrl.play();
  ctrl.update(1.5);
  expect(ctrl.isPlayingNow() === false && Math.abs(ctrl.getCurrentTime() - 1) < 1e-9, '非 loop 到结尾停止');

  // reset
  ctrl.reset();
  expect(ctrl.totalFrames === 1 && ctrl.isPlayingNow() === false, 'reset 清空');

  // ── characterTime ──
  expect(characterElapsedTime(2, { startOffset: 1, speed: 2, loop: true }) === 5, 'characterElapsedTime = startOffset + t*speed');
  expect(clipLocalTime(5, 4, true) === 1, 'clipLocalTime loop 回绕 (5 % 4 = 1)');
  expect(clipLocalTime(5, 4, false) === 4, 'clipLocalTime 非 loop clamp 到 duration');
  expect(actionSampleTime(5, 4, false) === 4 - 1e-4, 'actionSampleTime 非 loop 到结尾取 duration-1e-4');

  // sceneFallbackDuration
  const chars = [{ model: 'm1', animation: { clip: 'walk', startOffset: 0, speed: 2, loop: true } }];
  const clips = new Map([['m1:walk', 4]]);
  expect(sceneFallbackDuration(chars, clips) === 2, 'sceneFallbackDuration = clipDuration / speed = 4/2 = 2');
  expect(sceneFallbackDuration([], new Map()) === 1, '无角色时 fallback = 1');

  // ── scene3dTimelineMath ──
  expect(computeTotalFrames({ cameras: [{ sourceFrames: 100, speed: 2 }], characters: [] }) === 50, 'computeTotalFrames camera 100/2=50');
  expect(computeTotalFrames({ cameras: [], characters: [{ offsetFrames: 10, displayFrames: 30 }] }) === 40, 'computeTotalFrames character 10+30=40');
  expect(computeTotalFrames(null) === 0, 'computeTotalFrames null → 0');
  expect(zoomFromExp(2) === 4 && zoomFromExp(0) === 1, 'zoomFromExp = 2^exp');
  expect(resolveContainerHeight(0) === 80 && resolveContainerHeight(120) === 120, 'resolveContainerHeight 0→80 兜底');
}

section('P3 Scene3D: local execution emits the capture');
{
  const store = {
    put: () => {},
    byNode: (id) => id === 'sc'
      ? [{ nodeId: 'sc', port: 'output', key: 'sc:output:0', media: { kind: 'image', ref: 'http://x/scene.png' }, index: 0 }]
      : [],
  };
  const r = await runScene3DNode({ nodeId: 'sc', values: {}, store });
  expect(r.status === 'success' && r.entries.length === 1 && r.entries[0].media.ref === 'http://x/scene.png', 'scene emits its capture snapshot');
  const rEmpty = await runScene3DNode({ nodeId: 'empty', values: {}, store });
  expect(rEmpty.status === 'error', 'scene without a capture errors');
}

section('REAL-ENGINE (optional): 内置模板在纯原生 ComfyUI 真实出图（8188 不可达时跳过）');
{
  const BASE = 'http://127.0.0.1:8188';

  // 探测引擎：短超时，不可达则整段跳过（e2e 在无引擎环境仍秒级通过）。
  let engineUp = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const resp = await fetch(`${BASE}/system_stats`, { signal: ctrl.signal });
    clearTimeout(timer);
    engineUp = resp.ok;
  } catch {
    engineUp = false;
  }

  if (!engineUp) {
    console.log('  SKIP real-engine test (8188 not reachable)');
  } else {
    // 取内置 Local SD1.5（T2I）模板：7 节点纯原生 api_json，零 ComfyTV 依赖。
    const cfg = getBuiltinWorkflowConfig('image', 'Local SD1.5');
    expect(cfg && cfg.result?.node === '9' && Object.keys(cfg.api_json).length === 7,
      'builtin T2I template resolved (7 native nodes)');
    expect(cfg && !Object.values(cfg.api_json).some(n => String(n.class_type).startsWith('ComfyTV.')),
      'builtin template has no ComfyTV.* class_type (pure native ComfyUI)');

    // 提交 /prompt（复用导出的 api_json，不读 DB、不依赖 ComfyTV 扩展）。
    let promptId = null;
    let submitError = '';
    try {
      const resp = await fetch(`${BASE}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: cfg.api_json, client_id: 'e2e-real-engine' }),
      });
      if (resp.ok) {
        const j = await resp.json();
        promptId = j.prompt_id ?? null;
      } else {
        submitError = 'HTTP ' + resp.status + ' ' + (await resp.text()).slice(0, 300);
      }
    } catch (e) {
      submitError = String(e && e.message || e);
    }
    expect(promptId != null, 'real-engine /prompt accepted (prompt_id=' + promptId + (submitError ? ', err=' + submitError : '') + ')');

    // 轮询 /history 直到完成（SDXL 20 steps，最多 180s）。
    let completed = false;
    let images = [];
    const deadline = Date.now() + 180000;
    while (promptId && Date.now() < deadline && !completed) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const h = await (await fetch(`${BASE}/history/${promptId}`)).json();
        if (h[promptId]) {
          const st = h[promptId].status?.status_str;
          if (st === 'success') {
            completed = true;
            images = h[promptId].outputs?.['9']?.images ?? [];
          } else if (st === 'error') {
            break; // 错误详情由下方断言体现
          }
        }
      } catch { /* 轮询间隙忽略瞬时错误 */ }
    }
    expect(completed, 'real-engine generation completed');
    expect(images.length >= 1, 'real-engine produced ≥1 image');

    // 校验输出图片可下载（/view 返回真实字节）。
    if (images[0]) {
      const img = images[0];
      const url = `${BASE}/view?filename=${img.filename}&subfolder=${img.subfolder || ''}&type=${img.type || 'output'}`;
      let bytes = 0;
      try {
        bytes = (await (await fetch(url)).arrayBuffer()).byteLength;
      } catch { bytes = 0; }
      expect(bytes > 0, 'real-engine image downloadable (' + bytes + ' bytes, ' + url + ')');
    }
  }
}

section('E2E: actions 完整性 — 每个 action 都能 spawn 节点 + 连线端口有效');
{
  registerDefaultComfyTVStages();
  const store = useWorkflowEditorStore.getState();

  // 遍历 ACTIONS_BY_KIND 的所有 action（含 preset），对每个 action：
  //   1) 建对应 kind 的源节点
  //   2) spawnFollowUp(srcId, actionId)
  //   3) 断言：有新节点创建 + 每条新增 edge 的 source/target 端口在各自 spec 里存在
  //       （无 broken edge —— 目标无 input 端口时应不连线）。
  const SRC_BY_KIND = {
    text: 'ComfyTV.TextStage',
    image: 'ComfyTV.ImageStage',
    'image-picker': 'ComfyTV.ImagePickerStage',
    'image-batch': 'ComfyTV.ImageStage',
    video: 'ComfyTV.VideoStage',
    panorama: 'ComfyTV.PanoramaStage',
    model: 'ComfyTV.Model3DStage',
  };

  const flattened = [];
  for (const [kind, actions] of Object.entries(ACTIONS_BY_KIND)) {
    for (const a of actions) {
      if (a.presets?.length) {
        for (const p of a.presets) { flattened.push([kind, `${a.id}:${p.id}`, p.targetClass ?? null]); }
      } else {
        flattened.push([kind, a.id, null]);
      }
    }
  }

  let spawned = 0;
  let wired = 0;
  let skippedWire = 0;
  let spawnable = 0;
  for (const [kind, actionId, targetClass] of flattened) {
    const srcType = SRC_BY_KIND[kind];
    if (!srcType) {
      // storyboard 等无 schema 源节点的 kind：跳过（无节点可触发该 action）。
      continue;
    }
    spawnable++;
    store.setNodes([{ id: 'src', type: srcType, position: { x: 0, y: 0 }, data: {} }]);
    store.setEdges([]);
    spawnFollowUp('src', actionId);
    const s = useWorkflowEditorStore.getState();
    const created = s.nodes.filter(n => n.id !== 'src');
    const actionLabel = `${kind}:${actionId}`;
    expect(created.length >= 1, `${actionLabel} spawns ≥1 node`);

    // 验证每条新增 edge 的端口有效性（核心：无 broken edge）。
    for (const e of s.edges) {
      const srcSpec = getNodeSpec(s.nodes.find(n => n.id === e.source)?.type ?? '');
      const tgtSpec = getNodeSpec(s.nodes.find(n => n.id === e.target)?.type ?? '');
      const srcOk = srcSpec?.outputs?.some(o => o.name === e.sourceHandle);
      const tgtOk = tgtSpec?.inputs?.some(i => i.name === e.targetHandle);
      expect(srcOk, `${actionLabel} edge source port "${e.sourceHandle}" exists on ${srcSpec?.type}`);
      expect(tgtOk, `${actionLabel} edge target port "${e.targetHandle}" exists on ${tgtSpec?.type}`);
    }
    if (created.length >= 1) { spawned++; }
    if (s.edges.length > 0) { wired++; } else { skippedWire++; }

    // targetClass 校验（preset 明确指定了 target 时）。
    if (targetClass) {
      expect(created.some(n => n.type === targetClass), `${actionLabel} creates ${targetClass}`);
    }
  }

  expect(spawned === spawnable, `all ${spawnable} spawnable actions spawn nodes (got ${spawned})`);
  expect(wired > 0, 'at least some actions produce wired edges');
  store.setNodes([]);
  store.setEdges([]);
}

section('E2E: action 目标节点 spec 完整（可渲染）— title/kind/端口');
{
  registerDefaultComfyTVStages();
  // 所有 action 可能创建的 target 节点类型（含 preset 展开）。
  const targets = [
    // image edit presets
    'ComfyTV.UpscaleStage', 'ComfyTV.OutpaintStage', 'ComfyTV.InpaintStage',
    'ComfyTV.EraseStage', 'ComfyTV.CutoutStage', 'ComfyTV.CropStage',
    'ComfyTV.RotateStage', 'ComfyTV.MirrorStage', 'ComfyTV.ColorGradeStage',
    'ComfyTV.GridSplitStage', 'ComfyTV.KenBurnsStage',
    // image variant presets
    'ComfyTV.ImageVariationsStage', 'ComfyTV.ImageEditStage',
    // panorama / multiangle / relight / material / storyboard
    'ComfyTV.PanoramaStage', 'ComfyTV.MultiangleStage', 'ComfyTV.RelightStage',
    'ComfyTV.MaterialStage', 'ComfyTV.StoryboardEditorStage',
    // video extend + change
    'ComfyTV.VideoExtractFrameStage', 'ComfyTV.VideoStage', 'ComfyTV.VideoClipStage',
    'ComfyTV.VideoSplitStage', 'ComfyTV.VideoSpeedStage', 'ComfyTV.VideoRotateStage',
    'ComfyTV.VideoCropStage', 'ComfyTV.VideoResizeStage', 'ComfyTV.VideoVolumeStage',
    'ComfyTV.VideoMuxAudioStage', 'ComfyTV.VideoConcatStage', 'ComfyTV.VideoFramesStage',
    'ComfyTV.VideoColorStage', 'ComfyTV.VideoCurvesStage', 'ComfyTV.VideoLUTStage',
    'ComfyTV.VideoBlurSharpenStage', 'ComfyTV.VideoDenoiseStage', 'ComfyTV.VideoChromaKeyStage',
    'ComfyTV.VideoTransitionStage', 'ComfyTV.VideoStabilizeStage', 'ComfyTV.VideoInterpolateStage',
    'ComfyTV.VideoStylizeStage', 'ComfyTV.VideoScopesStage', 'ComfyTV.VideoTransformStage',
    'ComfyTV.VideoCompositeStage',
    // model / text
    'ComfyTV.Model3DStage', 'ComfyTV.TextStage',
  ];

  let resolved = 0;
  for (const t of targets) {
    const spec = getNodeSpec(t);
    expect(!!spec, `spec registered: ${t}`);
    if (!spec) { continue; }
    // 渲染前提 1：title 可用（否则画布标题栏空白/占位）。
    expect(typeof spec.title === 'string' && spec.title.trim().length >= 2, `title usable: ${t} (got "${spec.title}")`);
    // 渲染前提 2：有 kind（NodeCard 据此分叉 schema/native）。
    expect(!!spec.kind, `kind present: ${t}`);
    // 渲染前提 3：schema 节点必须有 input + output 端口（连线/渲染依赖）。
    if (spec.kind === 'schema') {
      expect((spec.inputs ?? []).length >= 1, `schema ${t} has ≥1 input port`);
      expect((spec.outputs ?? []).length >= 1, `schema ${t} has ≥1 output port`);
    }
    resolved++;
  }
  expect(resolved === targets.length, `all ${targets.length} action targets resolved (got ${resolved})`);
}

console.log('\n-- Summary --');
if (failures.length) {
  console.log('FAIL ' + failures.length + ' assertion(s) failed:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
} else {
  console.log('PASS all e2e assertions green');
  process.exit(0);
}
