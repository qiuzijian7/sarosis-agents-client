/*---------------------------------------------------------------------------------------------
 *  Unit tests for subflow — reusable sub-graph composition (P2).
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	buildSubflowFromGraph,
	getSubflowPorts,
	substituteSubflow,
	isValidSubflowConnection,
	flattenSubflows,
	type SubflowDefinition,
} from '../../webview/src/features/workflowEditor/comfyHost/subflow.js';

const nodes = [
	{ id: 'p1', type: 'Saros.Prompt', data: { label: '提示' } },
	{ id: 'g1', type: 'Saros.ModelImageGen', data: { label: '图像' } },
	{ id: 'outside', type: 'Saros.Prompt', data: { label: '外部' } },
];

const edges = [
	{ id: 'e1', source: 'p1', target: 'g1' },
	{ id: 'e-out', source: 'outside', target: 'g1' }, // crosses boundary
];

const portTypesFor = (type: string) => {
	if (type === 'Saros.Prompt') { return { inputs: ['SAROSIS_JSON'], outputs: ['TEXT'] }; }
	if (type === 'Saros.ModelImageGen') { return { inputs: ['TEXT'], outputs: ['IMAGE'] }; }
	return undefined;
};

suite('buildSubflowFromGraph', () => {

	test('keeps internal nodes and internal edges, drops boundary edges', () => {
		const def = buildSubflowFromGraph('sf-1', '子流程', nodes.slice(0, 2), edges);
		assert.strictEqual(def.nodes.length, 2);
		assert.deepStrictEqual(def.nodes.map(n => n.id), ['p1', 'g1']);
		assert.strictEqual(def.edges.length, 1, 'internal edge p1→g1 kept, boundary edge dropped');
		assert.strictEqual(def.edges[0].source, 'p1');
		assert.strictEqual(def.edges[0].target, 'g1');
	});

	test('derives entry and exit ids from internal topology', () => {
		const def = buildSubflowFromGraph('sf-2', '子流程', nodes.slice(0, 2), edges);
		// p1 has no incoming internal edge → entry; g1 has no outgoing → exit.
		assert.deepStrictEqual(def.entryIds, ['p1']);
		assert.deepStrictEqual(def.exitIds, ['g1']);
	});

	test('a single node is both entry and exit', () => {
		const def = buildSubflowFromGraph('sf-3', '单个', [nodes[1]], []);
		assert.deepStrictEqual(def.entryIds, ['g1']);
		assert.deepStrictEqual(def.exitIds, ['g1']);
	});

	test('isolated nodes are all entries and exits (no edges)', () => {
		const def = buildSubflowFromGraph('sf-4', '孤立', nodes, []);
		assert.deepStrictEqual(def.entryIds, ['p1', 'g1', 'outside']);
		assert.deepStrictEqual(def.exitIds, ['p1', 'g1', 'outside']);
	});
});

suite('getSubflowPorts', () => {

	test('entry node type drives input port type', () => {
		const def = buildSubflowFromGraph('sf-1', '子流程', nodes.slice(0, 2), edges);
		const ports = getSubflowPorts(def, portTypesFor);
		assert.strictEqual(ports.inputs.length, 1);
		assert.strictEqual(ports.inputs[0].name, 'p1');
		assert.strictEqual(ports.inputs[0].type, 'TEXT', 'entry output type becomes input port type');
		assert.strictEqual(ports.outputs.length, 1);
		assert.strictEqual(ports.outputs[0].name, 'g1');
		assert.strictEqual(ports.outputs[0].type, 'TEXT', 'exit input type becomes output port type');
	});

	test('unresolved types fall back to ANY', () => {
		const def = buildSubflowFromGraph('sf-x', '未知', [{ id: 'z', type: 'No.Such' }], []);
		const ports = getSubflowPorts(def, portTypesFor);
		assert.strictEqual(ports.inputs[0].type, 'ANY');
		assert.strictEqual(ports.outputs[0].type, 'ANY');
	});

	test('ports map back to internal node ids', () => {
		const def = buildSubflowFromGraph('sf-1', '子流程', nodes.slice(0, 2), edges);
		const ports = getSubflowPorts(def, portTypesFor);
		assert.strictEqual(ports.inputs[0].nodeId, 'p1');
		assert.strictEqual(ports.outputs[0].nodeId, 'g1');
	});
});

suite('isValidSubflowConnection', () => {

	test('type-compatible connections pass', () => {
		assert.strictEqual(isValidSubflowConnection('TEXT', 'TEXT', (a, b) => a === b), true);
		assert.strictEqual(isValidSubflowConnection('IMAGE', 'IMAGE', (a, b) => a === b), true);
	});

	test('incompatible types fail', () => {
		assert.strictEqual(isValidSubflowConnection('TEXT', 'IMAGE', (a, b) => a === b), false);
	});

	test('ANY matches anything', () => {
		assert.strictEqual(isValidSubflowConnection('ANY', 'IMAGE', (a, b) => a === b || a === 'ANY' || b === 'ANY'), true);
	});
});

suite('substituteSubflow', () => {

	function diamondDef(): SubflowDefinition {
		return {
			id: 'sf',
			name: '菱形',
			nodes: [
				{ id: 'a', type: 'Saros.Prompt', data: {} },
				{ id: 'b', type: 'Saros.ModelImageGen', data: {} },
				{ id: 'c', type: 'Saros.ModelImageGen', data: {} },
			],
			edges: [
				{ source: 'a', target: 'b' },
				{ source: 'a', target: 'c' },
			],
			entryIds: ['a'],
			exitIds: ['b', 'c'],
		};
	}

	test('expands internal nodes with prefixed ids and remaps external inputs', () => {
		const def = diamondDef();
		const r = substituteSubflow('sf-node', def, [
			{ source: 'ext-in', target: 'sf-node' },
			{ source: 'sf-node', target: 'ext-out' },
		], 'n1');
		assert.strictEqual(r.nodes.length, 3);
		assert.ok(r.nodes.every(n => n.id.startsWith('n1:')));
		// external → first entry (a) remapped.
		assert.strictEqual(r.remap.get('ext-in'), 'n1:a');
		// internal edges prefixed.
		assert.strictEqual(r.edges.filter(e => !e.source.startsWith('ext') && !e.target.startsWith('ext')).length, 2);
		// outgoing edge from first exit (b) to external target.
		assert.ok(r.edges.some(e => e.source === 'n1:b' && e.target === 'ext-out'));
	});

	test('empty external edges still produce the internal graph', () => {
		const def = diamondDef();
		const r = substituteSubflow('sf-node', def, [], 'n1');
		assert.strictEqual(r.nodes.length, 3);
		assert.strictEqual(r.edges.length, 2);
		assert.strictEqual(r.remap.size, 0);
	});

	test('def without entries/exits produces only the internal graph', () => {
		const def: SubflowDefinition = { id: 'sf', name: '空', nodes: [{ id: 'x', type: 'Saros.Prompt' }], edges: [], entryIds: [], exitIds: [] };
		const r = substituteSubflow('sf-node', def, [
			{ source: 'ext', target: 'sf-node' },
			{ source: 'sf-node', target: 'ext' },
		], 'n1');
		assert.strictEqual(r.nodes.length, 1);
		assert.strictEqual(r.edges.length, 0);
	});
});

suite('flattenSubflows', () => {

	function diamondDef(): SubflowDefinition {
		return {
			id: 'sf',
			name: '菱形',
			nodes: [
				{ id: 'a', type: 'Saros.Prompt', data: {} },
				{ id: 'b', type: 'Saros.ModelImageGen', data: {} },
				{ id: 'c', type: 'Saros.ModelImageGen', data: {} },
			],
			edges: [
				{ source: 'a', target: 'b' },
				{ source: 'a', target: 'c' },
			],
			entryIds: ['a'],
			exitIds: ['b', 'c'],
		};
	}

	test('graph without subflow nodes is returned unchanged', () => {
		const nodes = [{ id: 'p1', type: 'Saros.Prompt', data: {} }];
		const edges = [{ source: 'p1', target: 'x', id: 'e1' }];
		const r = flattenSubflows(nodes, edges);
		assert.strictEqual(r.nodes.length, 1);
		assert.deepStrictEqual(r.nodes[0].id, 'p1');
		assert.deepStrictEqual(r.edges, edges);
	});

	test('expands a subflow node into its internal graph with remapped boundary edges', () => {
		const def = diamondDef();
		const nodes = [
			{ id: 'ext-in', type: 'Saros.Prompt', data: { label: '外部入' } },
			{ id: 'sf1', type: 'Saros.Subflow', data: { subflow: def } },
			{ id: 'ext-out', type: 'Saros.ModelImageGen', data: { label: '外部出' } },
		];
		const edges = [
			{ id: 'in', source: 'ext-in', target: 'sf1' },
			{ id: 'out', source: 'sf1', target: 'ext-out' },
		];
		const r = flattenSubflows(nodes, edges);
		// 2 non-subflow + 3 internal.
		assert.strictEqual(r.nodes.length, 5);
		assert.ok(r.nodes.some(n => n.id === 'ext-in'));
		assert.ok(r.nodes.some(n => n.id === 'ext-out'));
		assert.ok(r.nodes.some(n => n.id === 'sf1:a'));
		assert.ok(r.nodes.some(n => n.id === 'sf1:b'));
		assert.ok(r.nodes.some(n => n.id === 'sf1:c'));
		// Subflow node itself removed.
		assert.ok(!r.nodes.some(n => n.id === 'sf1'));
		// Boundary edges remapped: ext-in → sf1:a, sf1:b → ext-out.
		assert.ok(r.edges.some(e => e.source === 'ext-in' && e.target === 'sf1:a'));
		assert.ok(r.edges.some(e => e.source === 'sf1:b' && e.target === 'ext-out'));
		// Internal edges prefixed.
		assert.ok(r.edges.some(e => e.source === 'sf1:a' && e.target === 'sf1:b'));
		assert.ok(r.edges.some(e => e.source === 'sf1:a' && e.target === 'sf1:c'));
	});

	test('multiple subflow nodes flatten independently', () => {
		const def1 = diamondDef();
		const def2: SubflowDefinition = {
			id: 'sf2', name: '小', nodes: [{ id: 'x', type: 'Saros.Prompt', data: {} }], edges: [], entryIds: ['x'], exitIds: ['x'],
		};
		const nodes = [
			{ id: 's1', type: 'Saros.Subflow', data: { subflow: def1 } },
			{ id: 's2', type: 'Saros.Subflow', data: { subflow: def2 } },
		];
		const r = flattenSubflows(nodes, []);
		assert.strictEqual(r.nodes.length, 4);
		assert.ok(r.nodes.some(n => n.id.startsWith('s1:')));
		assert.ok(r.nodes.some(n => n.id.startsWith('s2:')));
	});
});
