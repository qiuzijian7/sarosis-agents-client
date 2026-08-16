/*---------------------------------------------------------------------------------------------
 *  Unit tests for schemaLiteGraphNodes — the ComfyTV schema-stage LiteGraph
 *  class.
 *
 *  Covers the port type→color mapping and the node class factory. The node
 *  class intentionally does NOT override title_mode / drawSlots / slot
 *  position methods — LiteGraph's defaults handle title bar and port drawing
 *  on the canvas, matching ComfyTV's upstream behavior.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { createSchemaNodeClass, portTypeColor, isUsableNodeTitle } from '../../webview/src/features/workflowEditor/comfyHost/schemaLiteGraphNodes.js';
import { getDomFormWidget } from '../../webview/src/features/workflowEditor/comfyHost/domWidget.js';
import type { NodeSpec } from '../../webview/src/features/workflowEditor/comfyHost/registry.js';

suite('schemaLiteGraphNodes', () => {

	suite('isUsableNodeTitle', () => {
		test('rejects namespaced type strings', () => {
			// Legacy workflows persisted the node TYPE as its title; showing it
			// would leak internal implementation detail into the title bar.
			assert.strictEqual(isUsableNodeTitle('ComfyTV.ImageStage'), false);
			assert.strictEqual(isUsableNodeTitle('Saros.ModelImageGen'), false);
		});

		test('rejects single-character and empty titles', () => {
			// e.g. the truncated "t" seen after a bad round-trip.
			assert.strictEqual(isUsableNodeTitle('t'), false);
			assert.strictEqual(isUsableNodeTitle(''), false);
			assert.strictEqual(isUsableNodeTitle('   '), false);
			assert.strictEqual(isUsableNodeTitle(undefined), false);
		});

		test('rejects a title identical to the spec type', () => {
			assert.strictEqual(isUsableNodeTitle('ImageStage', 'ImageStage'), false);
		});

		test('keeps genuine titles, including short CJK renames', () => {
			assert.strictEqual(isUsableNodeTitle('Image Stage'), true);
			assert.strictEqual(isUsableNodeTitle('开始'), true);
			assert.strictEqual(isUsableNodeTitle('提示'), true);
			assert.strictEqual(isUsableNodeTitle('My Custom Node'), true);
		});
	});

	suite('portTypeColor', () => {
		test('known ComfyTV types map to the palette', () => {
			assert.strictEqual(portTypeColor('COMFYTV_IMAGE'), '#a855f7');
			assert.strictEqual(portTypeColor('COMFYTV_TEXT'), '#3b82f6');
			assert.strictEqual(portTypeColor('COMFYTV_VIDEO'), '#10b981');
			assert.strictEqual(portTypeColor('COMFYTV_AUDIO'), '#f59e0b');
			assert.strictEqual(portTypeColor('COMFYTV_MODEL'), '#ef4444');
		});

		test('generic fallbacks also resolve', () => {
			assert.strictEqual(portTypeColor('IMAGE'), '#a855f7');
			assert.strictEqual(portTypeColor('STRING'), '#3b82f6');
		});

		test('unknown type falls back to default green', () => {
			assert.strictEqual(portTypeColor('SOMETHING_NEW'), '#22c55e');
		});
	});

	suite('createSchemaNodeClass', () => {
		const spec: NodeSpec = {
			type: 'ComfyTV.ImageStage',
			kind: 'schema',
			title: 'Image Stage',
			category: 'comfyTV',
			inputs: [
				{ name: 'texts', type: 'COMFYTV_TEXT' },
				{ name: 'images', type: 'COMFYTV_IMAGE' },
			],
			outputs: [
				{ name: 'images', type: 'COMFYTV_IMAGES' },
				{ name: 'image', type: 'COMFYTV_IMAGE' },
			],
			color: '#e879f9',
		};

		test('adds inputs and outputs in declaration order', () => {
			const Cls = createSchemaNodeClass(spec);
			const node = new Cls();
			assert.strictEqual(node.inputs.length, 2);
			assert.strictEqual(node.outputs.length, 2);
			assert.strictEqual(node.inputs[0].name, 'texts');
			assert.strictEqual(node.inputs[1].name, 'images');
			assert.strictEqual(node.outputs[0].name, 'images');
			assert.strictEqual(node.outputs[1].name, 'image');
		});

		test('sets node color from spec', () => {
			const Cls = createSchemaNodeClass(spec);
			const node = new Cls();
			assert.strictEqual(node.color, '#e879f9');
			assert.strictEqual(node.boxcolor, '#e879f9');
		});

		test('exposes the spec title on both the class and the instance', () => {
			// LiteGraph's `configure()` falls back to `constructor.title` when a
			// serialized node has no title, and `getTitle()` reads it too — so the
			// static must carry the display name, not just the instance.
			const Cls = createSchemaNodeClass(spec);
			assert.strictEqual((Cls as unknown as { title: string }).title, 'Image Stage');
			assert.strictEqual(new Cls().title, 'Image Stage');
		});

		test('configure discards legacy type-string titles', () => {
			const Cls = createSchemaNodeClass(spec);
			const node = new Cls();
			node.configure({ id: 1, type: spec.type, title: 'ComfyTV.ImageStage' } as never);
			assert.strictEqual(node.title, 'Image Stage');
		});

		test('configure discards a truncated single-character title', () => {
			const Cls = createSchemaNodeClass(spec);
			const node = new Cls();
			node.configure({ id: 1, type: spec.type, title: 't' } as never);
			assert.strictEqual(node.title, 'Image Stage');
		});

		test('configure keeps a genuine user rename', () => {
			const Cls = createSchemaNodeClass(spec);
			const node = new Cls();
			node.configure({ id: 1, type: spec.type, title: '首图生成' } as never);
			assert.strictEqual(node.title, '首图生成');
		});

		test('minimum node size is enforced', () => {
			const Cls = createSchemaNodeClass(spec);
			const node = new Cls();
			assert.ok(node.size[0] >= 220);
			assert.ok(node.size[1] >= 300);
		});

		test('carries the addDOMWidget form widget (constructor + configure self-heal)', () => {
			const Cls = createSchemaNodeClass(spec);
			const node = new Cls();
			const w = getDomFormWidget(node as never);
			assert.ok(w, 'form widget attached by the constructor');
			assert.strictEqual(w!.type, 'dom');
			assert.strictEqual(w!.serialize, false, 'never persisted into the workflow JSON');
			// Legacy save round-trip: widgets never serialize → configure must
			// re-attach the form widget or the DOM card loses its layout anchor.
			node.widgets = undefined;
			node.configure({ id: 1, type: spec.type, title: 'Image Stage' } as never);
			assert.ok(getDomFormWidget(node as never), 're-attached on configure');
		});
	});
});
