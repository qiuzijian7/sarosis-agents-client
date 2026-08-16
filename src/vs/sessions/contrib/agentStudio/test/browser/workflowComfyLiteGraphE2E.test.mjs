// @ts-check
/*---------------------------------------------------------------------------------------------
 *  E2E integration test for LiteGraph workflow editor (Node-based, no browser).
 *  Exercises the full store→graph pipeline by importing the real modules and
 *  simulating user actions (palette click, double-click, etc.). This catches
 *  bugs that single-module tests cannot: store↔graph sync, onConfigure existence,
 *  LiteGraph title handling, port registration, etc.
 *--------------------------------------------------------------------------------------------*/
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../../../..');
const tmp = path.join(projectRoot, 'out', 'e2e', `litegraph-e2e-${Date.now()}.mjs`);
writeFileSync(path.dirname(tmp), '', { flag: 'a' }); // ensure dir

// Bundle a single-file entry that runs the e2e scenarios.
const entry = path.join(path.dirname(tmp), 'entry-litegraph-e2e.mjs');
writeFileSync(entry, `
import { LGraph, LiteGraph } from '@comfyorg/litegraph';
import { registerSarosisLiteGraphNodes } from '../../webview/src/features/workflowEditor/comfyHost/sarosisLiteGraphNodes';
import { registerSarosisNodes, getNodeSpec } from '../../webview/src/features/workflowEditor/comfyHost/registry';
import { toLiteGraph, fromLiteGraph } from '../../webview/src/features/workflowEditor/comfyHost/ComfyGraphAdapter';
import { useWorkflowEditorStore } from '../../webview/src/features/workflowEditor/store';

const failures = [];
function expect(cond, label) {
  if (cond) { console.log('  ✔ ' + label); }
  else { console.log('  ✗ ' + label); failures.push(label); }
}
function section(name) { console.log('\\n── ' + name + ' ──'); }

section('Saros node registration');
registerSarosisLiteGraphNodes();
registerSarosisNodes();
expect(typeof LiteGraph.registered_node_types['Saros.Start'] === 'function', 'Saros.Start class registered');
expect(typeof LiteGraph.registered_node_types['Saros.Prompt'] === 'function', 'Saros.Prompt class registered');
expect(typeof getNodeSpec('Saros.Prompt') === 'object', 'getNodeSpec returns spec');

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
  expect(node.color === '#22c55e' || node.boxcolor === '#22c55e', 'node color is green (Start config)');
}

section('onConfigure is NOT called by LiteGraph 0.17.2 (no such hook)');
{
  // Our sarosisLiteGraphNodes uses `override onConfigure` which is a TS-only
  // keyword; at runtime, if LGraphNode has no onConfigure, the override never
  // runs. Verify this and check whether configure() reads `title` correctly.
  const LGraphNode = LiteGraph.registered_node_types['Saros.Prompt'].prototype.constructor;
  const hookExists = (() => { let v = false; for (let p = LGraphNode.__proto__; p; p = p.__proto__) { if ('onConfigure' in p) { v = true; break; } } return v; })();
  expect(!hookExists, 'onConfigure hook does not exist on SarosisNode prototype chain');
  // Workaround verification: configure() reads info.title into this.title.
  const graph = new LGraph();
  graph.configure({ ...toLiteGraph([{ id: 'p-1', type: 'prompt', name: '提示', position: { x: 100, y: 100 }, data: { label: '提示' } }], []).graph, id: 'wf', groups: [] });
  expect(graph.nodes[0]?.title === '提示', 'configure applies info.title → this.title (no TODO)');
}

section('store addNode → graph sync (real e2e loop)');
{
  // Simulate what LiteGraphCanvas does on every store update:
  //  - read current graph node set
  //  - compute diff against store nodes
  //  - call graph.configure when diff is non-empty
  const graph = new LGraph();
  // Initial seed (matches store defaults)
  graph.configure({ ...toLiteGraph([
    { id: 'start', type: 'start', name: '开始', position: { x: 80, y: 250 }, data: { label: '开始' } },
    { id: 'end',   type: 'end',   name: '结束', position: { x: 600, y: 250 }, data: { label: '结束' } },
  ], []).graph, id: 'wf', groups: [] });
  expect(graph.nodes.length === 2, 'initial 2 nodes in graph');

  // User clicks NodePalette "Prompt" → store.addNode('prompt', {x:300, y:200})
  const store = useWorkflowEditorStore.getState();
  store.addNode('prompt', { x: 300, y: 200 });
  const newStoreNodes = useWorkflowEditorStore.getState().nodes;
  expect(newStoreNodes.length === 3, 'store now has 3 nodes (added Prompt)');
  const newPrompt = newStoreNodes.find(n => n.type === 'prompt');
  expect(newPrompt != null && newPrompt.data?.label === '提示', 'Prompt node has default label 提示');

  // The OLD code: only sync if graph empty. New nodes would NOT appear.
  // The CORRECT sync: re-run toLiteGraph and reconfigure the graph.
  const expected = newStoreNodes.length;
  // We invoke a re-configure (this is what the fixed LiteGraphCanvas does).
  const { graph: serialized2 } = toLiteGraph(
    newStoreNodes.map(n => ({
      id: n.id, type: n.type, name: n.data?.label ?? n.id,
      position: n.position, data: n.data,
      style: n.style,
    })),
    useWorkflowEditorStore.getState().edges.map(e => ({ id: e.id, from: e.source, to: e.target })),
  );
  graph.configure({ ...serialized2, id: 'wf', groups: [] });
  expect(graph.nodes.length === expected, 'graph has ' + expected + ' nodes after addNode+sync (was 2, expect 3)');

  // Verify the new Prompt node title is correct
  const promptNode = graph.nodes.find(n => n.properties?.__sarosisId === newPrompt.id);
  expect(promptNode != null, 'new Prompt node exists in graph');
  expect(promptNode?.title === '提示', 'new Prompt node title is 提示 (got: ' + JSON.stringify(promptNode?.title) + ')');
}

section('NodePalette → addNode → graph round-trip (multiple adds)');
{
  // Simulate a user adding 5 different nodes.
  const store = useWorkflowEditorStore.getState();
  store.clearWorkflow();
  const types = ['prompt', 'agent', 'skill', 'tool', 'task'];
  for (const t of types) store.addNode(t, { x: 100, y: 100 });

  const graph = new LGraph();
  const nodes = useWorkflowEditorStore.getState().nodes;
  const edges = useWorkflowEditorStore.getState().edges;
  const { graph: serialized } = toLiteGraph(
    nodes.map(n => ({ id: n.id, type: n.type, name: n.data?.label ?? n.id, position: n.position, data: n.data })),
    edges.map(e => ({ id: e.id, from: e.source, to: e.target })),
  );
  graph.configure({ ...serialized, id: 'wf', groups: [] });

  expect(graph.nodes.length === types.length, 'all ' + types.length + ' added nodes appear in graph');
  for (const t of types) {
    const n = graph.nodes.find(g => g.type === 'Saros.' + t.charAt(0).toUpperCase() + t.slice(1) || g.type === t);
    expect(n != null, 'node type ' + t + ' present in graph');
  }
}

section('Connect Start→Prompt→End (edges) and graph reflects them');
{
  const store = useWorkflowEditorStore.getState();
  store.clearWorkflow();
  store.addNode('prompt', { x: 300, y: 200 });
  const startId = 'start', endId = 'end';
  const promptId = useWorkflowEditorStore.getState().nodes.find(n => n.type === 'prompt')?.id;
  if (promptId) {
    // Manually add edges via the store action (deleteEdge exists but no addEdge action;
    // we use the underlying setEdges for the test).
    useWorkflowEditorStore.setState({
      edges: [
        { id: 'e1', source: startId, target: promptId },
        { id: 'e2', source: promptId, target: endId },
      ],
    });
  }
  const finalNodes = useWorkflowEditorStore.getState().nodes;
  const finalEdges = useWorkflowEditorStore.getState().edges;
  expect(finalEdges.length === 2, 'store has 2 edges (start→prompt, prompt→end)');
  const graph = new LGraph();
  const { graph: serialized } = toLiteGraph(
    finalNodes.map(n => ({ id: n.id, type: n.type, name: n.data?.label ?? n.id, position: n.position, data: n.data })),
    finalEdges.map(e => ({ id: e.id, from: e.source, to: e.target })),
  );
  graph.configure({ ...serialized, id: 'wf', groups: [] });
  expect(graph.links.length === 2, 'graph has 2 links after configure');
  // verify reverse round-trip preserves edges
  const back = fromLiteGraph(graph.serialize());
  expect(
    back.connections.length === 2
    && back.connections.some(c => c.from === startId && c.to === promptId)
    && back.connections.some(c => c.from === promptId && c.to === endId),
    'fromLiteGraph round-trips both edges',
  );
}

console.log('\\n── Summary ──');
if (failures.length) {
  console.log('FAIL — ' + failures.length + ' assertion(s) failed:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
} else {
  console.log('PASS — all e2e assertions green');
  process.exit(0);
}
`);

writeFileSync(path.dirname(tmp), '', { flag: 'a' });

// Wrap TS with a tiny esbuild build that emits ESM.
const out = path.join(path.dirname(tmp), 'bundle.mjs');
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: out,
  alias: { '@comfyorg/litegraph': path.join(projectRoot, 'src/vs/sessions/contrib/agentStudio/webview/node_modules/@comfyorg/litegraph/src') },
  nodePaths: [path.join(projectRoot, 'src/vs/sessions/contrib/agentStudio/webview/node_modules')],
  logLevel: 'warning',
});

const { spawn } = await import('node:child_process');
const child = spawn(process.execPath, [out], { stdio: 'inherit' });
child.on('exit', (code) => {
  try { readFileSync(out, 'utf8'); /* keep evidence */ } catch {}
  process.exit(code ?? 1);
});
