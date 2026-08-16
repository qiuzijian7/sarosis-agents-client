/* Unit tests for the cross-layer connection gate (P1 — doc/workflow-pipeline-fusion-design.md).
 * Pure logic, no DOM / no React / no LiteGraph singleton.
 * Run with: node test/run-crosslayer.mjs  (esbuild-bundles this file then executes it). */

import { nodeLayer, canConnectLayers, type NodeKind, type NodeLayer } from '../src/features/workflowEditor/comfyHost/registry';

let passed = 0;
let failed = 0;

function eq(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) { passed++; }
	else { failed++; console.error(`✗ ${label}\n   expected: ${e}\n   actual:   ${a}`); }
}

// ─── nodeLayer: kind → layer ────────────────────────────────────────────────
eq(nodeLayer('react'), 'orchestration', 'react → orchestration');
eq(nodeLayer('llm'), 'orchestration', 'llm → orchestration');
eq(nodeLayer('schema'), 'bridge', 'schema → bridge');
eq(nodeLayer('native'), 'media', 'native → media');

// ─── canConnectLayers: 4 kinds × 4 kinds = 16 combinations ──────────────────
const kinds: NodeKind[] = ['react', 'llm', 'schema', 'native'];
// expected[srcKind][dstKind] — 'orchestration'↔'media' is forbidden (must route via bridge).
const expected: Record<NodeKind, Record<NodeKind, boolean>> = {
	react:   { react: true, llm: true, schema: true, native: false },
	llm:     { react: true, llm: true, schema: true, native: false },
	schema:  { react: true, llm: true, schema: true, native: true },
	native:  { react: false, llm: false, schema: true, native: true },
};

for (const src of kinds) {
	for (const dst of kinds) {
		eq(
			canConnectLayers(src, dst),
			expected[src][dst],
			`canConnectLayers(${src}, ${dst})`,
		);
	}
}

// ─── Explicit sanity: the forbidden cross-layer pair + the allowed route ────
eq(canConnectLayers('react', 'native'), false, 'react → native is forbidden');
eq(canConnectLayers('native', 'react'), false, 'native → react is forbidden');
eq(canConnectLayers('llm', 'native'), false, 'llm → native is forbidden');
eq(canConnectLayers('react', 'schema'), true, 'react → schema (bridge) allowed');
eq(canConnectLayers('schema', 'native'), true, 'schema → native (bridge) allowed');

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
