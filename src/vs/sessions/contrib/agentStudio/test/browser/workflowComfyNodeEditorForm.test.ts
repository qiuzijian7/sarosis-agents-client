/*---------------------------------------------------------------------------------------------
 *  Unit tests for nodeEditorForm — derive node editor fields from NodeSpec.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	buildEditorFields,
	coerceEditorValue,
	buildSarosisEditorFields,
	sarosisDataToValues,
	sarosisValuesToData,
	type EditorField,
} from '../../webview/src/features/workflowEditor/comfyHost/nodeEditorForm.js';
import type { NodeSpec } from '../../webview/src/features/workflowEditor/comfyHost/registry.js';

function spec(partial: Partial<NodeSpec>): NodeSpec {
	return {
		type: 'X.Y', kind: 'schema', title: 'T', category: 'comfyTV', inputs: [], outputs: [],
		...partial,
	};
}

suite('nodeEditorForm', () => {

	suite('buildEditorFields', () => {

		test('schema stage always gets a prompt textarea first', () => {
			const fields = buildEditorFields(spec({ kind: 'schema', comfyTV: { stageKind: 'image' } }));
			assert.ok(fields.length >= 1);
			assert.strictEqual(fields[0].key, 'prompt');
			assert.strictEqual(fields[0].kind, 'textarea');
		});

		test('image stage gets seed/width/height after prompt', () => {
			const fields = buildEditorFields(spec({ kind: 'schema', comfyTV: { stageKind: 'image' } }));
			const keys = fields.map(f => f.key);
			assert.ok(keys.includes('seed'));
			assert.ok(keys.includes('width'));
			assert.ok(keys.includes('height'));
		});

		test('video stage gets fps + frames', () => {
			const fields = buildEditorFields(spec({ kind: 'schema', comfyTV: { stageKind: 'video' } }));
			const keys = fields.map(f => f.key);
			assert.ok(keys.includes('fps'));
			assert.ok(keys.includes('frames'));
		});

		test('unknown stage kind falls back to image field set', () => {
			const fields = buildEditorFields(spec({ kind: 'schema', comfyTV: { stageKind: 'weird' } }));
			assert.ok(fields.some(f => f.key === 'seed'));
		});

		test('excludePrompt suppresses the prompt field', () => {
			const fields = buildEditorFields(spec({ kind: 'schema', comfyTV: { stageKind: 'image' } }), true);
			assert.ok(!fields.some(f => f.key === 'prompt'));
		});

		test('provider-backend schema node (ModelImageGen) gets provider/model combo fields', () => {
			// Saros.ModelImageGen is kind='schema' + backendKind='provider' with
			// widgets [provider, model, seed, width, height, steps, prompt]. Its
			// editor must render provider → ProviderModelSelect, model →
			// providerModel (linked to the provider), numbers for seed/width/height.
			const fields = buildEditorFields(spec({
				kind: 'schema',
				backendKind: 'provider',
				widgets: [
					{ name: 'provider', type: 'COMBO', default: '' },
					{ name: 'model', type: 'COMBO', default: '' },
					{ name: 'seed', type: 'INT', default: -1 },
					{ name: 'width', type: 'INT', default: 1024 },
					{ name: 'prompt', type: 'TEXT', default: '' },
				],
			}));
			const provider = fields.find(f => f.key === 'provider');
			const model = fields.find(f => f.key === 'model');
			assert.ok(provider, 'provider field exists');
			assert.strictEqual(provider.kind, 'provider');
			assert.ok(model, 'model field exists');
			assert.strictEqual(model.kind, 'providerModel');
			assert.ok(fields.some(f => f.key === 'seed' && f.kind === 'number'));
			assert.ok(fields.some(f => f.key === 'width' && f.kind === 'number'));
			// prompt kept at the front, not duplicated from widgets.
			assert.strictEqual(fields[0].key, 'prompt');
			assert.strictEqual(fields.filter(f => f.key === 'prompt').length, 1);
		});

		test('native node renders widgets: combo → select, int → number, string → text', () => {
			const native = spec({
				kind: 'native',
				widgets: [
					{ name: 'sampler', type: 'COMBO', options: ['euler', 'ddim'] },
					{ name: 'steps', type: 'INT', default: 20 },
					{ name: 'notes', type: 'STRING', default: 'hi' },
				],
			});
			const fields = buildEditorFields(native);
			assert.strictEqual(fields.length, 3);
			assert.strictEqual(fields[0].kind, 'select');
			assert.deepStrictEqual(fields[0].options, ['euler', 'ddim']);
			assert.strictEqual(fields[1].kind, 'number');
			assert.strictEqual(fields[1].defaultValue, 20);
			assert.strictEqual(fields[2].kind, 'text');
		});

		test('undefined spec → empty fields', () => {
			assert.deepStrictEqual(buildEditorFields(undefined), []);
		});

		test('react (Saros) spec → per-type parameter fields', () => {
			const prompt = buildEditorFields(spec({ type: 'Saros.Prompt', kind: 'react' }));
			assert.ok(prompt.some(f => f.key === 'prompt' && f.kind === 'textarea'));
			assert.ok(prompt.some(f => f.key === 'variables'));
			const agent = buildEditorFields(spec({ type: 'Saros.Agent', kind: 'react' }));
			assert.ok(agent.some(f => f.key === 'agentId'));
			assert.ok(agent.some(f => f.key === 'providerId'));
			const ifElse = buildEditorFields(spec({ type: 'Saros.IfElse', kind: 'react' }));
			assert.ok(ifElse.some(f => f.key === 'evaluationTarget'));
			assert.ok(ifElse.some(f => f.key === 'branches'));
			const askUser = buildEditorFields(spec({ type: 'Saros.AskUser', kind: 'react' }));
			assert.ok(askUser.some(f => f.key === 'questionText'));
			assert.ok(askUser.some(f => f.key === 'options' && f.kind === 'textarea'));
		});

		test('unknown react type → no fields', () => {
			assert.deepStrictEqual(buildEditorFields(spec({ type: 'Saros.Unknown', kind: 'react' })), []);
		});
	});

	suite('Saros field converters', () => {

		test('sarosisDataToValues stringifies JSON fields and maps agentConfig', () => {
			const values = sarosisDataToValues('Saros.Agent', {
				agentId: 'code',
				agentConfig: { providerId: 'p', modelId: 'm' },
				prompt: 'hello',
			});
			assert.strictEqual(values.agentId, 'code');
			assert.strictEqual(values.providerId, 'p');
			assert.strictEqual(values.modelId, 'm');
			assert.strictEqual(values.prompt, 'hello');
		});

		test('sarosisDataToValues falls back to defaults for missing fields', () => {
			const values = sarosisDataToValues('Saros.Prompt', undefined);
			assert.strictEqual(values.prompt, '');
			assert.strictEqual(values.variables, '{}');
		});

		test('sarosisValuesToData parses JSON fields and rebuilds agentConfig', () => {
			const data = sarosisValuesToData('Saros.Agent', {
				agentId: 'code',
				providerId: 'p',
				modelId: 'm',
				prompt: 'hi',
			});
			assert.deepStrictEqual(data.agentConfig, { providerId: 'p', modelId: 'm' });
			assert.strictEqual(data.prompt, 'hi');
		});

		test('sarosisValuesToData keeps invalid JSON as the raw string', () => {
			const data = sarosisValuesToData('Saros.Skill', { skillName: 's', skillArgs: 'not-json' });
			assert.strictEqual(data.skillArgs, 'not-json');
		});

		test('sarosisValuesToData multiSelect string → boolean', () => {
			const data = sarosisValuesToData('Saros.AskUser', { questionText: 'q', options: '[]', multiSelect: 'yes' });
			assert.strictEqual(data.multiSelect, true);
			assert.deepStrictEqual(data.options, []);
		});
	});

	suite('coerceEditorValue', () => {

		test('number fields coerce to Number and guard NaN', () => {
			const field: EditorField = { key: 'seed', label: 'Seed', kind: 'number', defaultValue: -1 };
			assert.strictEqual(coerceEditorValue('42', field), 42);
			assert.strictEqual(coerceEditorValue('abc', field), -1);
		});

		test('negative seed stays -1', () => {
			const field: EditorField = { key: 'seed', label: 'Seed', kind: 'number', defaultValue: -1 };
			assert.strictEqual(coerceEditorValue('-5', field), -1);
		});

		test('non-seed negative numbers are preserved', () => {
			const field: EditorField = { key: 'cfg', label: 'CFG', kind: 'number', defaultValue: 7 };
			assert.strictEqual(coerceEditorValue('-2', field), -2);
		});

		test('text/textarea values stringify', () => {
			const field: EditorField = { key: 'prompt', label: '提示词', kind: 'textarea', defaultValue: '' };
			assert.strictEqual(coerceEditorValue('a cat', field), 'a cat');
			assert.strictEqual(coerceEditorValue(undefined, field), '');
		});
	});

	suite('ProviderPicker fields', () => {

		test('react ProviderPicker spec → provider + providerModel fields', () => {
			const fields = buildEditorFields(spec({ type: 'Saros.ProviderPicker', kind: 'react' }));
			const provider = fields.find(f => f.key === 'providerId');
			const model = fields.find(f => f.key === 'modelId');
			assert.ok(provider, 'expected providerId field');
			assert.strictEqual(provider!.kind, 'provider');
			assert.ok(model, 'expected modelId field');
			assert.strictEqual(model!.kind, 'providerModel');
		});

		test('ProviderPicker persists providerId/modelId flat (no agentConfig)', () => {
			const data = sarosisValuesToData('Saros.ProviderPicker', { providerId: 'openrouter', modelId: 'flux' });
			assert.strictEqual(data.providerId, 'openrouter');
			assert.strictEqual(data.modelId, 'flux');
			assert.strictEqual(data.agentConfig, undefined);
		});

		test('ProviderPicker round-trips through sarosisDataToValues', () => {
			const values = sarosisDataToValues('Saros.ProviderPicker', { providerId: 'openrouter', modelId: 'flux' });
			assert.strictEqual(values.providerId, 'openrouter');
			assert.strictEqual(values.modelId, 'flux');
		});

		test('Agent still uses agentConfig (regression guard)', () => {
			const data = sarosisValuesToData('Saros.Agent', { providerId: 'p', modelId: 'm' });
			assert.deepStrictEqual(data.agentConfig, { providerId: 'p', modelId: 'm' });
			assert.strictEqual(data.providerId, undefined);
		});
	});
});
