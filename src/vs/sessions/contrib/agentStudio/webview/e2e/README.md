# LiteGraph Workflow Editor — E2E Integration Tests

Node-based e2e tests for the LiteGraph workflow editor (no real browser).
Bundles the source modules through esbuild and exercises the real store ↔
graph pipeline that `LiteGraphCanvas` uses at runtime.

## What it covers

- **Sarosis node registration** — `Sarosis.Start`, `Sarosis.Prompt` etc. are
  registered as real `LGraphNode` subclasses (not TODO placeholders).
- **`LGraph.configure` applies `info.title`** — node title is read from the
  serialized payload, not LiteGraph's `"TODO"` default. `__sarosisId` is
  preserved as a property for diff-based sync.
- **`onConfigure` hook does NOT exist in LiteGraph 0.17.2** — documents the
  trap that `sarosisLiteGraphNodes` historically relied on. The fix is to
  set `title` via `super(title)` and rely on the LGraphNode `configure(info)`
  reading `info.title`.
- **`store.addNode` → `graph.configure`** round-trip — when a user clicks a
  NodePalette entry, the new node ends up in the graph with the right title.
- **Diff-based store → graph sync** — position-only changes (drag) do not
  trigger a full re-configure (the previous bug wiped the in-flight drag
  state on every store update). Verified by the dedicated useEffect test in
  `LiteGraphCanvas.tsx`.
- **Multi-add** — 5 different node types added from NodePalette all appear
  in the graph (Start, End, Prompt, Agent, Skill, Tool, Task).
- **Start → Prompt → End edge round-trip** — `toLiteGraph` emits 2 links,
  `graph.links.size` is 2, `fromLiteGraph(graph.serialize())` round-trips
  both connections back into the workflow domain.
- **`store.removeNode` → graph sync** — removed nodes disappear from the
  graph; Start/End remain (they are protected by the store).
- **`validateWorkflow`** — default 2-node workflow is valid (warnings only);
  adding an orphan agent surfaces an "incoming connection" warning.
- **`toWorkflowData` → `loadWorkflow` round-trip** — the JSON the host
  persists and reloads is lossless.

### Cross-module integration (added 2026-08-10)

- **NodeEditorPopup full loop** — a ComfyTV image stage is registered
  (schema); `buildEditorFields` derives prompt+seed+width+height; typing a
  prompt and hitting generate runs the single-node api.json through a fake
  runner, and the resulting `/view` image URL lands in `MediaSnapshotStore`
  under `primarySnapshotKey(nodeId)` for the card thumbnail.
- **ComfyUI native registration** — `registerComfyUINativeNode` derives
  widgets from `input.required` (INT→number, COMBO→select); nodes appear in
  `buildComfyPaletteItems('native')` and produce editor fields.
- **Link type compatibility** — `isPortTypeCompatible` / 
  `isValidLiteGraphConnection`: identical types connect, ANY is a wildcard,
  mismatches (image→text) are rejected, numeric SlotType enums act as ANY.
- **Runner registry** — `ComfyRunnerRegistry.resolve` ('auto' → local) and
  `collectRunnerRows` aggregate health/version/error per runner.
- **widgetBridge geometry** — `nodeToOverlayRect` maps graph coords through
  the canvas transform (`pos*scale + offset`), and `createWidgetBridgeHost
  .sync()` hides stale containers when the node set shrinks.
- **api.json GUI↔API** — import path `parseGuiWorkflow → graph.configure`
  rebuilds 4 links; export path `graph.serialize() → guiToApi` resolves
  `VAEDecode.samples → ["3",0]` and `apiToGui` round-trips nodes+links.
- **undo/redo** — store temporal: `addNode` → `undo()` → `redo()` restores
  the node count.

### Regression caught by these tests

- `parseGuiWorkflow` previously **dropped `node.inputs`/`outputs`**, so an
  imported ComfyUI workflow re-exported as api.json **lost every connection**.
  Fixed to keep slot descriptors (ComfyGraphAdapter.ts + comfyApiAdapter.ts).
- `toLiteGraph` previously emitted no `size` for unstyled nodes, making the
  widgetBridge overlay card drift from the canvas node (220×150 default vs
  real ~60px node). Fixed to always emit a size tuple.

## Running

```bash
cd src/vs/sessions/contrib/agentStudio/webview
node e2e/run.mjs
```

The runner writes `e2e/bundle.mjs` (transient) and prints a PASS/FAIL line.

## Why a custom runner, not a browser?

- Real e2e (Puppeteer + vscode webview) requires the full VS Code host
  running in dev mode — outside the agent's reach in this environment.
- The data-model layer (LGraph + LGraphNode + workflow store) is the *only*
  place the bugs live; rendering is canvas-only and orthogonal.
- The tests directly call `LGraph.configure` with the payload that
  `LiteGraphCanvas.tsx` builds, so they cover the exact same code path
  that the React component uses at runtime.

## Files

- `e2e/entry.mjs` — scenarios.
- `e2e/run.mjs` — esbuild + spawn harness. Adds a `ts-js-resolve` plugin so
  relative `.js` imports can also resolve to `.ts` / `.tsx` source.
- `e2e/bundle.mjs` — generated; do not commit.
