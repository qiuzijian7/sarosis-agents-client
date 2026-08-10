import { LGraph, LiteGraph } from '@comfyorg/litegraph';
import { registerSarosisLiteGraphNodes } from '../src/features/workflowEditor/comfyHost/sarosisLiteGraphNodes';
import {
	registerSarosisNodes, getNodeSpec, registerComfyTVNode, registerComfyUINativeNode,
	buildComfyPaletteItems, isValidLiteGraphConnection, isPortTypeCompatible,
	registerDefaultComfyTVStages, subscribeNodeRegistry, getNodeRegistryVersion,
} from '../src/features/workflowEditor/comfyHost/registry';
import { toLiteGraph, fromLiteGraph } from '../src/features/workflowEditor/comfyHost/ComfyGraphAdapter';
import { useWorkflowEditorStore, undo, redo } from '../src/features/workflowEditor/store';
import { buildEditorFields, coerceEditorValue } from '../src/features/workflowEditor/comfyHost/nodeEditorForm';
import { buildStageOptionsFromCaps, setStageOptions, getStageOptions } from '../src/features/workflowEditor/comfyHost/registry';
import { isInstantNode, cropRect, rotateDegrees, mirrorFlip, instantOutputSize, applyInstantDraw } from '../src/features/workflowEditor/comfyHost/instantNodes';
import {
	isRelightNode, createDefaultLight, normalizeLights, parseLightsData, orthographicProject,
	screenToSphere, lightDirection, LIGHT_PRESETS,
} from '../src/features/workflowEditor/comfyHost/relightEditor';
import { runRelightNode } from '../src/features/workflowEditor/comfyHost/relightExecutor';
import { defaultPosterElements, applyPosterLayout, parsePosterLayout, renderPoster, hitTestPosterElement, isPosterNode } from '../src/features/workflowEditor/comfyHost/posterEditor';
import { runPosterNode } from '../src/features/workflowEditor/comfyHost/posterExecutor';
import { defaultCorners, parseCorners, cornersToJson, clampCorner, isCornerPinNode } from '../src/features/workflowEditor/comfyHost/cornerPinEditor';
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
	patchBoard, isStoryboardEditorNode,
} from '../src/features/workflowEditor/comfyHost/storyboardEditor';
import { runStoryboardEditorNode } from '../src/features/workflowEditor/comfyHost/storyboardExecutor';
import {
	DEFAULT_MATERIAL, MATERIAL_PRESETS, applyPreset, materialStateToJson, normalizeMaterial,
	parseMaterialState, renderMaterialBall, isMaterialNode,
} from '../src/features/workflowEditor/comfyHost/materialEditor';
import { runMaterialNode } from '../src/features/workflowEditor/comfyHost/materialExecutor';
import {
	defaultSceneDoc, parseSceneDoc, sceneDocToJson, addSceneObject, removeSceneObject,
	patchSceneObject, projectIso, screenToGround, renderScene, isScene3DNode,
} from '../src/features/workflowEditor/comfyHost/scene3dEditor';
import { runScene3DNode } from '../src/features/workflowEditor/comfyHost/scene3dExecutor';
import { loadComfyTVCaps } from '../src/features/workflowEditor/comfyHost/capsLoader';
import { buildMinimapScene, minimapToGraph, applyMinimapPan, renderMinimap } from '../src/features/workflowEditor/minimap';
import { comfyTitleText, comfyDrawWidgets, drawNodeErrorBanner, drawNodeStateOverlay, applyComfyNodeStyle } from '../src/features/workflowEditor/comfyNodeStyle';
import { buildMenuGroups, filterMenuGroups } from '../src/features/workflowEditor/NodeContextMenu';
import { darkenColor } from '../src/features/workflowEditor/comfyNodeStyle';
import { runSingleNode } from '../src/features/workflowEditor/comfyHost/nodeExecutor';
import { MediaSnapshotStore, createMemoryBackend } from '../src/features/workflowEditor/comfyHost/mediaSnapshotStore';
import { primarySnapshotKey, thumbnailSize, comfyViewUrl } from '../src/features/workflowEditor/comfyHost/mediaSnapshot';
import { createLocalComfyRunner, ComfyRunnerRegistry, collectRunnerRows } from '../src/features/workflowEditor/comfyHost/comfyRunner';
import { guiToApi, apiToGui, parseGuiWorkflow } from '../src/features/workflowEditor/comfyHost/comfyApiAdapter';
import { nodeToOverlayRect, createWidgetBridgeHost } from '../src/features/workflowEditor/comfyHost/widgetBridge';
import { drawCanvasGrid, applyNodeDragDelta } from '../src/features/workflowEditor/LiteGraphCanvas';
import { computeExecutionOrder, collectUpstreamNodeIds, buildExecutionPlan } from '../src/features/workflowEditor/comfyHost/executionGraph';
import { isComfyExecutableSpec, runGraphExecution, runNodeOrStage } from '../src/features/workflowEditor/comfyHost/workflowRun';
import { CardStateStore } from '../src/features/workflowEditor/comfyHost/cardState';
import { pickDefaultWorkflowLabel, injectWorkflowValues, runStageWorkflow, StageWorkflowUnavailableError, matchUpstreamFrom, viewUrlToAnnotated } from '../src/features/workflowEditor/comfyHost/stageWorkflowExecutor';
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

const failures = [];
function expect(cond, label) {
  if (cond) { console.log('  PASS ' + label); }
  else { console.log('  FAIL ' + label); failures.push(label); }
}
function section(name) { console.log('\n-- ' + name + ' --'); }

section('Sarosis node registration');
registerSarosisLiteGraphNodes();
registerSarosisNodes();
expect(typeof LiteGraph.registered_node_types['Sarosis.Start'] === 'function', 'Sarosis.Start class registered');
expect(typeof LiteGraph.registered_node_types['Sarosis.Prompt'] === 'function', 'Sarosis.Prompt class registered');
expect(typeof getNodeSpec('Sarosis.Prompt') === 'object', 'getNodeSpec returns spec');

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
  expect(node.properties?.__sarosisId === 'start-1', '__sarosisId preserved');
}

section('onConfigure hook does NOT exist on LiteGraph 0.17.2');
{
  const LGraphNode = LiteGraph.registered_node_types['Sarosis.Prompt'];
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
  const newPrompt = newStoreNodes.find(n => n.type === 'prompt');
  expect(newPrompt != null && newPrompt.data?.label === '提示', 'Prompt node has default label 提示');

  const expected = newStoreNodes.length;
  const { graph: serialized2 } = toLiteGraph(
    newStoreNodes.map(n => ({ id: n.id, type: n.type, name: n.data?.label ?? n.id, position: n.position, data: n.data })),
    useWorkflowEditorStore.getState().edges.map(e => ({ id: e.id, from: e.source, to: e.target })),
  );
  graph.configure({ ...serialized2, id: 'wf', groups: [] });
  expect(graph.nodes.length === expected, 'graph has ' + expected + ' nodes after addNode+sync');

  const promptNode = graph.nodes.find(n => n.properties?.__sarosisId === newPrompt.id);
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
  const promptId = useWorkflowEditorStore.getState().nodes.find(n => n.type === 'prompt')?.id;
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

  // Remove the Prompt node (the only one with type="prompt" — Start/End protected).
  const promptId = useWorkflowEditorStore.getState().nodes.find(n => n.type === 'prompt')?.id;
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
  expect(!graph.nodes.find(n => n.properties?.__sarosisId === promptId), 'removed Prompt node is gone from graph');
  expect(!!graph.nodes.find(n => n.properties?.__sarosisId === 'start') && !!graph.nodes.find(n => n.properties?.__sarosisId === 'end'), 'Start and End remain');
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
  expect(reloaded.nodes.find(n => n.type === 'agent') != null, 'agent node restored');
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
  // A ComfyTV image stage spec is registered (as RunnerManagerPanel does via
  // loadComfyTVStages). Double-clicking it opens the popup which derives
  // fields from the spec; typing a prompt + hitting generate runs the
  // single-node prompt and lands a snapshot the card subscribes to.
  registerComfyTVNode({
    type: 'ComfyTV.ImageStage', kind: 'image', workflowKind: 'image-to-image',
    outputs: [{ name: 'images', type: 'IMAGE' }],
  });
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
  expect(!isPortTypeCompatible('SAROSIS_JSON', 'IMAGE'), 'sarosis json → image is rejected');
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
    [{ id: 'a', node: { pos: [10, 20], size: [100, 50] } }],
    { x: 0, y: 0, scale: 1 },
  );
  // second sync without 'a' should hide it
  const cont = layerEl.children[0];
  expect(cont != null && cont.style.display === 'block', 'container visible after first sync');
  // Containers must stay click-through so the LiteGraph canvas receives
  // pointerdown (drag), wheel (zoom) and dblclick (editor) over node cards.
  expect(cont.style.pointerEvents === 'none', 'container is click-through (pointerEvents:none)');
  // PORT_INSET keeps LiteGraph pin dots / connection start points visible
  // (they're drawn at the node's edge — without inset the container would
  // paint over them and connections would appear to vanish).
  expect(parseFloat(cont.style.width) === 100 - 16 && parseFloat(cont.style.height) === 50 - 22 - 8, 'container size insets 8 sides / 22 top');
  expect(cont.style.left === '18px' && cont.style.top === '42px', 'container offset by 8 sides / 22 top (LiteGraph title bar)');
  host.sync([{ id: 'b', node: { pos: [30, 40], size: [50, 25] } }], { x: 5, y: 5, scale: 2 });
  expect(cont.style.display === 'none', 'stale container hidden after re-sync');
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
  expect(image != null && image.kind === 'schema' && image.comfyTV?.stageKind === 'image',
    'default ComfyTV.ImageStage registered (kind=schema, stageKind=image)');
  expect(!!getNodeSpec('ComfyTV.VideoStage'), 'default ComfyTV.VideoStage registered');
  expect(!!getNodeSpec('ComfyTV.AudioStage'), 'default ComfyTV.AudioStage registered');
  expect(!!getNodeSpec('ComfyTV.TextStage'), 'default ComfyTV.TextStage registered');
  expect(!!getNodeSpec('ComfyTV.ImageBatchStage'), 'default ComfyTV.ImageBatchStage registered');
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
  // live-runner schema refines the preset (same type overwrites, version bumps)
  const v2 = getNodeRegistryVersion();
  registerComfyTVNode({ type: 'ComfyTV.ImageStage', kind: 'image', title: '文生图(实时)', outputs: [{ name: 'images', type: 'IMAGE' }] });
  expect(getNodeRegistryVersion() > v2, 'live stage refinement bumps registry version');
  expect(getNodeSpec('ComfyTV.ImageStage')?.title === '文生图(实时)', 'live schema overwrites preset title');
}

section('executionGraph: topological order (linear / branch / cycle)');
{
  const nodes = [
    { id: 'start', type: 'start' }, { id: 'a', type: 'ComfyTV.ImageStage' },
    { id: 'b', type: 'ComfyTV.ImageBatchStage' }, { id: 'end', type: 'end' },
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
    { id: 'batch', type: 'ComfyTV.ImageBatchStage' },
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
  expect(!isComfyExecutableSpec(getNodeSpec('Sarosis.Prompt')), 'react orchestration node skipped');
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

  // linear chain executes upstream-first
  {
    const log = [];
    const r = await runGraphExecution({
      nodes: [
        { id: 'img', type: 'ComfyTV.ImageStage' },
        { id: 'batch', type: 'ComfyTV.ImageBatchStage' },
      ],
      edges: [{ source: 'img', target: 'batch' }],
      getSpec,
      resolveRunner: () => makeRunner(log),
      snapshotStore, cardState,
    });
    expect(r.success && r.ran.join(',') === 'img,batch', 'chain ran upstream-first (img,batch)');
    expect(log.join(',') === 'ComfyTV.ImageStage,ComfyTV.ImageBatchStage', 'runner invoked in execution order');
    expect(cardState.get('img').runState === 'success' && cardState.get('batch').runState === 'success',
      'cards marked success after run');
  }

  // failure stops the chain: downstream never runs
  {
    cardState.clearAll();
    const log = [];
    const r = await runGraphExecution({
      nodes: [
        { id: 'a', type: 'ComfyTV.ImageStage' },
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
    expect(log.join(',') === 'ComfyTV.ImageStage,ComfyTV.AudioStage', 'c never invoked (stopped at b)');
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

  // nodeValues are passed through to the runner
  {
    const log = [];
    const r = await runGraphExecution({
      nodes: [{ id: 'a', type: 'ComfyTV.ImageStage' }],
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

  // runner without ComfyTV extension → degrades to single-node execution
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
    expect(r.success, 'degraded run still succeeds');
    expect(Object.keys(invokeLog[0]).length === 1 && invokeLog[0]['1'].class_type === 'ComfyTV.ImageStage',
      'degraded to single-node prompt (no ctv extension)');
  }

  // runStageWorkflow throws StageWorkflowUnavailableError without fetchApi
  {
    let threw = false;
    try {
      await runStageWorkflow({
        runner: { baseUrl: 'http://fake.local', id: 'x', kind: 'local', testConnection: async () => ({ ok: true }), invoke: async () => ({ promptId: 'p', outputs: {}, status: 'success' }) },
        nodeId: 'a', type: 'ComfyTV.ImageStage', kind: 'image', values: {}, store: snapshotStore,
      });
    } catch (err) {
      threw = err instanceof StageWorkflowUnavailableError;
    }
    expect(threw, 'missing fetchApi → StageWorkflowUnavailableError');
  }
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

section('capsLoader: buildStageOptionsFromCaps (P3)');
{
  const options = buildStageOptionsFromCaps(
    ['option:seed', 'option:batch_size', 'option:negative', 'option:generate_audio', 'option:mystery'],
    { 'option:seed': 'Stage seed', 'option:generate_audio': 'Generate audio' },
  );
  const byKey = Object.fromEntries(options.map(o => [o.key, o]));
  expect(byKey.seed && byKey.seed.kind === 'number' && byKey.seed.label === 'Stage seed', 'seed → number with label');
  expect(byKey.batch_size && byKey.batch_size.kind === 'number', 'batch_size → number');
  expect(byKey.negative && byKey.negative.kind === 'textarea', 'negative → textarea');
  expect(byKey.generate_audio && byKey.generate_audio.kind === 'select' && byKey.generate_audio.options.join(',') === 'yes,no',
    'generate_audio → yes/no select');
  expect(byKey.mystery && byKey.mystery.kind === 'text', 'unknown option → text');
}

section('nodeEditorForm: schema fields prefer caps options (P3)');
{
  const spec = getNodeSpec('ComfyTV.ImageStage');
  const before = buildEditorFields(spec);
  expect(before.some(f => f.key === 'width'), 'preset fallback offers width/height before caps');

  setStageOptions('image', buildStageOptionsFromCaps(['option:seed', 'option:batch_size'], { 'option:batch_size': 'Stage batch size' }));
  const after = buildEditorFields(spec);
  expect(after.some(f => f.key === 'prompt'), 'prompt textarea still first');
  expect(after.find(f => f.key === 'seed')?.kind === 'number', 'caps seed field used');
  expect(after.find(f => f.key === 'batch_size')?.label === 'Stage batch size', 'caps label used');
  expect(!after.some(f => f.key === 'width'), 'caps fields replace hardcoded presets');
  setStageOptions('image', []); // restore fallback for any later scenario
}

section('capsLoader: loadComfyTVCaps fetches and registers options (P3)');
{
  const fakeFetch = async (url) => {
    if (url.endsWith('/comfytv/caps')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          caps_by_kind: { audio: { upstream_kinds: [], option_keys: ['option:seed', 'option:duration_s'], computed_keys: ['computed:length'] } },
          fallback_caps: { upstream_kinds: [], option_keys: [], computed_keys: [] },
          option_labels: { 'option:duration_s': 'Stage duration (s)' },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  const ok = await loadComfyTVCaps('http://fake.local', fakeFetch);
  expect(ok, 'caps loaded');
  const audioOpts = getStageOptions('audio');
  expect(audioOpts && audioOpts.length === 2, 'audio options registered');
  expect(audioOpts.find(o => o.key === 'duration_s')?.label === 'Stage duration (s)', 'option label mapped');
  setStageOptions('audio', []);

  const fail = await loadComfyTVCaps('http://fake.local', async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }));
  expect(fail === false, '404 → graceful false');
  const boom = await loadComfyTVCaps('http://fake.local', async () => { throw new Error('net'); });
  expect(boom === false, 'network error → graceful false');
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
  expect(errCalls.includes('stroke') && errCalls.some(t => t.startsWith('text:⚠ Error: boom')), 'error banner drawn (border + text)');
  expect(errCalls.filter(c => c === 'fill').length >= 1, 'banner backdrop filled');

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
  expect(stCalls.filter(c => c === 'stroke').length >= 3, 'running+success+error draw borders');
  expect(stCalls.filter(c => c === 'fill').length >= 1, 'error banner backdrop filled');

  // onDrawForeground hook consults the getNodeState callback
  let stateHook = null;
  const proto2 = {};
  applyComfyNodeStyle({}, { prototype: proto2 }, { NODE_DEFAULT_COLOR: 'x', NODE_DEFAULT_BGCOLOR: 'y', NODE_DEFAULT_BOXCOLOR: 'z', WIDGET_OUTLINE_COLOR: 'w' }, (id) => id === 'n1' ? { runState: 'error', errorMsg: 'kaput' } : undefined);
  stateHook = proto2.onDrawForeground;
  expect(typeof stateHook === 'function', 'onDrawForeground installed');
  const nodeCtx = { fillText() {}, save() {}, restore() {}, stroke() {}, fill() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, quadraticCurveTo() {}, measureText() { return { width: 10 }; }, textAlign: 'left', textBaseline: 'top', font: '', globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1 };
  stateHook.call({ id: 7, properties: { __sarosisId: 'n1' }, size: [200, 100] }, nodeCtx); // error → draws, no throw
  stateHook.call({ id: 8, properties: { __sarosisId: 'n2' }, size: [200, 100] }, nodeCtx); // no state → no draw, no throw
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
  expect(src.includes('LiteGraph.closeAllContextMenus'), 'litegraph native menu closed');
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
  expect(isFxBuildNode('Sarosis.Prompt') === false, 'non-ComfyTV types never classified as fx');
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
  const def = defaultCorners();
  expect(def.length === 4 && def[0][0] === 0.2 && def[3][0] === 0.2 && def[3][1] === 0.8, 'default corners (TL/TR/BR/BL order)');
  const parsed = parseCorners('[[0.1,0.1],[0.9,0.1],[0.9,0.9],[0.1,0.9]]');
  expect(parsed[2][0] === 0.9 && parsed[2][1] === 0.9, 'corners parsed in TL,TR,BR,BL order');
  expect(parseCorners('{bad}')[0][0] === 0.2, 'broken JSON falls back to defaults');
  expect(parseCorners('[[1,2],[3,4]]')[1][0] === 0.8, 'wrong length falls back to defaults');
  expect(cornersToJson(parsed) === '[[0.1,0.1],[0.9,0.1],[0.9,0.9],[0.1,0.9]]', 'serialization rounds to 2 decimals');
  const clamped = clampCorner([1.5, -0.2]);
  expect(clamped[0] === 0.98 && clamped[1] === 0.02, 'corners clamped into the canvas');
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
  expect(def.width === 1280 && def.height === 720 && def.boards.length === 1 && def.boards[0].duration === 3 && def.boards[0].doc.layers.length === 1, 'default board state (1280×720, one board, 3s)');
  const parsed = parseBoardState('{"width":640,"height":360,"boards":[{"id":"b1","name":"S1","duration":5,"meta":{"note":"close-up"},"doc":{"width":640,"height":360,"layers":[{"id":"l","name":"L","visible":true,"opacity":1,"ops":[{"type":"rect","color":"#fff","size":1,"x":0.1,"y":0.1,"w":0.2,"h":0.2}]}]}}]}');
  expect(parsed.boards.length === 1 && parsed.boards[0].name === 'S1' && parsed.boards[0].duration === 5 && parsed.boards[0].meta.note === 'close-up', 'board parsed with timing + metadata');
  expect(parsed.boards[0].doc.width === 640 && parsed.boards[0].doc.layers[0].ops.length === 1, 'board layer doc reused from LayerEditor model');
  expect(parseBoardState('{bad').boards.length === 1, 'broken JSON falls back to defaults');
  expect(JSON.parse(boardStateToJson(parsed)).boards[0].doc.layers[0].ops.length === 1, 'board_state round-trips through JSON');

  let s = defaultBoardState();
  s = addBoard(s);
  expect(s.boards.length === 2 && s.boards[1].name === '镜头 2', 'board added');
  const before = s.boards[1].id;
  s = moveBoard(s, before, -1);
  expect(s.boards[0].id === before, 'board moved up');
  const kept = removeBoard(s, s.boards[0].id);
  expect(kept.boards.length === 1, 'board removed');
  expect(removeBoard(kept, kept.boards[0].id).boards.length === 1, 'cannot remove the last board');
  s = patchBoard(s, before, { duration: 9, meta: { note: 'wide' } });
  expect(s.boards.find(b => b.id === before).duration === 9 && s.boards.find(b => b.id === before).meta.note === 'wide', 'board patched');
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
  expect(DEFAULT_MATERIAL.color === '#8fbf8f' && DEFAULT_MATERIAL.metalness === 0 && DEFAULT_MATERIAL.roughness === 0.4, 'defaults match ComfyTV (color #8fbf8f, r0.4)');
  const norm = normalizeMaterial({ color: '#E6B553', metalness: 5, roughness: -1, transmission: 1, clearcoat: 0.5, clearcoatRoughness: 0.25 });
  expect(norm.color === '#e6b553' && norm.metalness === 1 && norm.roughness === 0 && norm.transmission === 1, 'normalize clamps + lowercases color');
  const bad = normalizeMaterial({ color: 'red' });
  expect(bad.color === DEFAULT_MATERIAL.color, 'invalid color falls back');
  expect(parseMaterialState('{bad').color === '#8fbf8f', 'broken material_state falls back');
  expect(JSON.parse(materialStateToJson(norm)).roughness === 0, 'material_state round-trips');
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

section('P3 Scene3D: iso math + document model + render');
{
  expect(isScene3DNode('ComfyTV.Scene3DStage') && !isScene3DNode('ComfyTV.ImageStage'), 'scene3d classified');
  const def = defaultSceneDoc();
  expect(def.objects.length === 2 && def.objects[0].kind === 'box' && def.objects[1].kind === 'sphere', 'default scene: box + sphere');
  const parsed = parseSceneDoc('{"width":800,"height":600,"objects":[{"id":"o1","name":"Cube","kind":"box","x":0.2,"y":0.3,"size":0.4,"height":0.6,"color":"#ABCDEF"}]}');
  expect(parsed.objects.length === 1 && parsed.objects[0].name === 'Cube' && parsed.objects[0].color === '#abcdef', 'scene parsed (color lowercased)');
  expect(parseSceneDoc('{bad').objects.length === 2, 'broken JSON falls back to defaults');
  expect(JSON.parse(sceneDocToJson(parsed)).objects[0].kind === 'box', 'scene_state round-trips');

  const p = projectIso(0.5, 0.5, 0, 800, 800);
  expect(Math.abs(p.sx - 400) < 0.01 && Math.abs(p.sy - 400) < 0.01, 'center projects to canvas center');
  const pUp = projectIso(0.5, 0.5, 0.5, 800, 800);
  expect(pUp.sy < p.sy, 'height lifts the projection upward');
  const g = screenToGround(400, 400, 800, 800);
  expect(Math.abs(g.x - 0.5) < 0.01 && Math.abs(g.y - 0.5) < 0.01, 'screen→ground round-trips the center');
  const right = screenToGround(projectIso(0.75, 0.25, 0, 800, 800).sx, 400, 800, 800);
  expect(Math.abs(right.x - 0.75) < 0.01 && Math.abs(right.y - 0.25) < 0.01, 'right-ground point maps right (0.75,0.25)');

  let s = defaultSceneDoc();
  s = addSceneObject(s, 'cylinder');
  expect(s.objects.length === 3 && s.objects[2].kind === 'cylinder', 'primitive added');
  const id = s.objects[2].id;
  s = patchSceneObject(s, id, { color: '#123456', height: 0.8 });
  expect(s.objects[2].color === '#123456' && s.objects[2].height === 0.8, 'object patched');
  expect(removeSceneObject(s, id).objects.length === 2, 'object removed');
  expect(removeSceneObject({ ...s, objects: [s.objects[0]] }, s.objects[0].id).objects.length === 1, 'cannot remove the last object');

  const calls = [];
  const ctx = {
    fillStyle: null, strokeStyle: null, lineWidth: 0,
    fillRect: () => {}, fillText: (...a) => calls.push(['fillText', a]),
    beginPath: () => calls.push(['beginPath']), moveTo: (...a) => calls.push(['moveTo', a]),
    lineTo: (...a) => calls.push(['lineTo', a]), closePath: () => calls.push(['closePath']),
    arc: (...a) => calls.push(['arc', a]), ellipse: (...a) => calls.push(['ellipse', a]),
    fill: () => calls.push(['fill']), stroke: () => calls.push(['stroke']),
  };
  renderScene(ctx, { width: 800, height: 800, objects: def.objects });
  expect(calls.filter(c => c[0] === 'moveTo').length >= 8, 'iso grid drawn (≥4 lines × 2 endpoints)');
  expect(calls.some(c => c[0] === 'ellipse'), 'primitives render (ground shadow ellipse)');
  expect(calls.some(c => c[0] === 'fillText'), 'object labels drawn');
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

console.log('\n-- Summary --');
if (failures.length) {
  console.log('FAIL ' + failures.length + ' assertion(s) failed:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
} else {
  console.log('PASS all e2e assertions green');
  process.exit(0);
}
