/*---------------------------------------------------------------------------------------------
 *  Unit tests for the LiteGraph node registry facade (comfyHost/registry.ts).
 *  Covers the three-tier registration (react / schema / native), port-type
 *  compatibility, and spec validation.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	registerNodeSpec,
	unregisterNodeSpec,
	getNodeSpec,
	getSpecsByKind,
	getAllSpecs,
	validateNodeSpec,
	isPortTypeCompatible,
	isValidLiteGraphConnection,
	buildComfyPaletteItems,
	registerSarosisNodes,
	registerComfyTVNode,
	registerComfyUINativeNode,
	normalizePortType,
} from '../../webview/src/features/workflowEditor/comfyHost/registry.js';

suite('comfyHost registry', () => {

	suite('registerNodeSpec / lookup', () => {

		test('registers and retrieves a spec', () => {
			registerNodeSpec({ type: 'Test.A', kind: 'react', title: 'A', category: 'x', inputs: [], outputs: [] });
			const spec = getNodeSpec('Test.A');
			assert.ok(spec, 'spec should exist');
			assert.strictEqual(spec!.type, 'Test.A');
		});

		test('unregister removes from both maps', () => {
			registerNodeSpec({ type: 'Test.B', kind: 'react', title: 'B', category: 'x', inputs: [], outputs: [] });
			assert.ok(getNodeSpec('Test.B'));
			unregisterNodeSpec('Test.B');
			assert.strictEqual(getNodeSpec('Test.B'), undefined);
			assert.strictEqual(getSpecsByKind('react').some(s => s.type === 'Test.B'), false);
		});

		test('getSpecsByKind groups by kind', () => {
			registerNodeSpec({ type: 'K.Native', kind: 'native', title: 'N', category: 'c', inputs: [], outputs: [] });
			registerNodeSpec({ type: 'K.Schema', kind: 'schema', title: 'S', category: 'c', inputs: [], outputs: [] });
			const natives = getSpecsByKind('native');
			const schemas = getSpecsByKind('schema');
			assert.ok(natives.some(s => s.type === 'K.Native'));
			assert.ok(schemas.some(s => s.type === 'K.Schema'));
			assert.ok(!natives.some(s => s.type === 'K.Schema'));
		});

		test('getAllSpecs returns flat list', () => {
			registerNodeSpec({ type: 'Flat.A', kind: 'react', title: 'A', category: 'x', inputs: [], outputs: [] });
			assert.ok(getAllSpecs().some(s => s.type === 'Flat.A'));
		});
	});

	suite('validateNodeSpec', () => {

		test('flags un-namespaced type', () => {
			const issues = validateNodeSpec({ type: 'NoDot', kind: 'react', title: 'x', category: 'c', inputs: [], outputs: [] });
			assert.ok(issues.length > 0, 'should flag missing namespace');
		});

		test('flags duplicate port names', () => {
			const issues = validateNodeSpec({
				type: 'Dup.Node', kind: 'react', title: 'x', category: 'c',
				inputs: [{ name: 'value', type: 'ANY' }],
				outputs: [{ name: 'value', type: 'ANY' }],
			});
			assert.ok(issues.some(i => i.includes('duplicate port')));
		});

		test('passes a clean spec', () => {
			const issues = validateNodeSpec({
				type: 'Good.Node', kind: 'react', title: 'x', category: 'c',
				inputs: [{ name: 'in', type: 'TEXT' }],
				outputs: [{ name: 'out', type: 'IMAGE' }],
			});
			assert.deepStrictEqual(issues, []);
		});
	});

	suite('isPortTypeCompatible', () => {

		test('identical types connect', () => {
			assert.strictEqual(isPortTypeCompatible('IMAGE', 'IMAGE'), true);
			assert.strictEqual(isPortTypeCompatible('TEXT', 'TEXT'), true);
		});

		test('ANY is wildcard', () => {
			assert.strictEqual(isPortTypeCompatible('ANY', 'IMAGE'), true);
			assert.strictEqual(isPortTypeCompatible('AUDIO', 'ANY'), true);
		});

		test('mismatched non-ANY types reject', () => {
			assert.strictEqual(isPortTypeCompatible('IMAGE', 'AUDIO'), false);
			assert.strictEqual(isPortTypeCompatible('TEXT', 'SAROSIS_JSON'), false);
		});
	});

	suite('isValidLiteGraphConnection (ISlotType bridge)', () => {

		test('string slot types use the compatibility matrix', () => {
			assert.strictEqual(isValidLiteGraphConnection('IMAGE', 'IMAGE'), true);
			assert.strictEqual(isValidLiteGraphConnection('IMAGE', 'AUDIO'), false);
			assert.strictEqual(isValidLiteGraphConnection('ANY', 'VIDEO'), true);
		});

		test('numeric slot types (SlotType enum) are treated as ANY wildcard', () => {
			assert.strictEqual(isValidLiteGraphConnection(0, 'IMAGE'), true);
			assert.strictEqual(isValidLiteGraphConnection(1, 2), true);
		});
	});

	suite('registerSarosisNodes', () => {

		test('registers all 11 Sarosis node types', () => {
			registerSarosisNodes();
			const types = ['Sarosis.Start', 'Sarosis.End', 'Sarosis.Task', 'Sarosis.Prompt', 'Sarosis.Agent',
				'Sarosis.Skill', 'Sarosis.Tool', 'Sarosis.IfElse', 'Sarosis.Switch', 'Sarosis.AskUser', 'Sarosis.Group'];
			for (const t of types) {
				assert.ok(getNodeSpec(t), `missing ${t}`);
			}
		});

		test('IfElse has true/false output ports', () => {
			const spec = getNodeSpec('Sarosis.IfElse');
			assert.ok(spec);
			assert.deepStrictEqual(spec!.outputs.map(p => p.name), ['true', 'false']);
		});
	});

	suite('registerComfyTVNode (schema → React, no Vue)', () => {

		test('registers a stage from schema with normalized ports', () => {
			registerComfyTVNode({
				type: 'ComfyTV.ImageStage',
				kind: 'image',
				workflowKind: 'image',
				inputs: [{ name: 'main_prompt', type: 'text' }],
				outputs: [{ name: 'image', type: 'image' }],
				title: '文生图',
			});
			const spec = getNodeSpec('ComfyTV.ImageStage');
			assert.ok(spec);
			assert.strictEqual(spec!.kind, 'schema');
			assert.strictEqual(spec!.inputs[0].type, 'TEXT');
			assert.strictEqual(spec!.outputs[0].type, 'IMAGE');
			assert.strictEqual(spec!.comfyTV?.stageKind, 'image');
		});

		test('does not require a Vue runtime (kind is schema)', () => {
			registerComfyTVNode({ type: 'ComfyTV.TTSStage', outputs: [{ name: 'audio' }] });
			const spec = getNodeSpec('ComfyTV.TTSStage');
			assert.strictEqual(spec!.kind, 'schema');
		});
	});

	suite('registerComfyUINativeNode (object_info)', () => {

		test('derives inputs/outputs and widgets from object_info', () => {
			registerComfyUINativeNode({
				class_name: 'KSampler',
				display_name: 'KSampler',
				category: 'sampling',
				input: {
					required: {
						seed: ['INT', { default: 0 }],
						steps: ['INT', { default: 20 }],
						sampler_name: ['COMBO', { values: ['euler', 'dpmpp_2m'] }],
						model: ['MODEL'],
					},
				},
				output: ['LATENT'],
				output_name: ['LATENT'],
			});
			const spec = getNodeSpec('KSampler');
			assert.ok(spec);
			assert.strictEqual(spec!.kind, 'native');
			assert.strictEqual(spec!.inputs[0].name, 'seed');
			assert.strictEqual(spec!.outputs[0].type, 'ANY');
			assert.strictEqual(spec!.widgets!.length, 4);
			const combo = spec!.widgets!.find(w => w.name === 'sampler_name');
			assert.deepStrictEqual(combo!.options, ['euler', 'dpmpp_2m']);
		});
	});

	suite('normalizePortType', () => {

		test('maps known types and falls back to ANY', () => {
			assert.strictEqual(normalizePortType('image'), 'IMAGE');
			assert.strictEqual(normalizePortType('IMAGE'), 'IMAGE');
			assert.strictEqual(normalizePortType('video'), 'VIDEO');
			assert.strictEqual(normalizePortType('audio'), 'AUDIO');
			assert.strictEqual(normalizePortType('json'), 'SAROSIS_JSON');
			assert.strictEqual(normalizePortType('weird'), 'ANY');
		});
	});

	suite('buildComfyPaletteItems', () => {

		test('maps schema nodes to palette items', () => {
			unregisterNodeSpec('PaletteTV.A');
			registerComfyTVNode({ type: 'PaletteTV.A', kind: 'image', title: '文生图', outputs: [{ name: 'image' }] });
			const items = buildComfyPaletteItems('schema');
			const a = items.find(i => i.type === 'PaletteTV.A');
			assert.ok(a);
			assert.strictEqual(a!.label, '文生图');
			assert.match(a!.description, /ComfyTV stage/);
			unregisterNodeSpec('PaletteTV.A');
		});

		test('maps native nodes to palette items', () => {
			unregisterNodeSpec('PaletteNative.A');
			registerComfyUINativeNode({ class_name: 'PaletteNative.A', output: ['IMAGE'], output_name: ['IMAGE'] });
			const items = buildComfyPaletteItems('native');
			const a = items.find(i => i.type === 'PaletteNative.A');
			assert.ok(a);
			assert.match(a!.description, /ComfyUI 原生/);
			assert.strictEqual(a!.icon, '🧩');
			unregisterNodeSpec('PaletteNative.A');
		});

		test('empty when nothing registered for a kind', () => {
			// ensure no 'schema' specs remain
			for (const s of [...getSpecsByKind('schema')]) { unregisterNodeSpec(s.type); }
			assert.deepStrictEqual(buildComfyPaletteItems('schema'), []);
		});
	});
});
