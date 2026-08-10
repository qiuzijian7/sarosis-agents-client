/*---------------------------------------------------------------------------------------------
 *  Unit tests for imageGenBackendRegistry — backend registry + auto-routing.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	ImageGenBackendRegistry,
	resolveBackendPreference,
} from '../../webview/src/features/workflowEditor/comfyHost/imageGenBackendRegistry.js';
import type { IImageGenBackend } from '../../webview/src/features/workflowEditor/comfyHost/imageGenBackend.js';

function backend(id: string, kind: 'provider' | 'comfy'): IImageGenBackend {
	return {
		id,
		kind,
		label: id,
		async testConnection() { return { ok: true }; },
		async generate() { return { media: [] }; },
	};
}

suite('imageGenBackendRegistry — registry', () => {

	test('register/get/list/unregister round-trip', () => {
		const reg = new ImageGenBackendRegistry();
		reg.register(backend('p1', 'provider'));
		reg.register(backend('c1', 'comfy'));
		assert.strictEqual(reg.get('p1')?.kind, 'provider');
		assert.strictEqual(reg.list().length, 2);
		assert.strictEqual(reg.unregister('p1'), true);
		assert.strictEqual(reg.get('p1'), undefined);
		assert.strictEqual(reg.unregister('p1'), false);
	});

	test('firstOfKind returns the first matching backend', () => {
		const reg = new ImageGenBackendRegistry();
		reg.register(backend('c2', 'comfy'));
		reg.register(backend('p1', 'provider'));
		reg.register(backend('c1', 'comfy'));
		assert.strictEqual(reg.firstOfKind('comfy')?.id, 'c2');
		assert.strictEqual(reg.firstOfKind('provider')?.id, 'p1');
	});
});

suite('imageGenBackendRegistry — resolveBackendPreference', () => {

	const reg = new ImageGenBackendRegistry();
	reg.register(backend('p1', 'provider'));
	reg.register(backend('c1', 'comfy'));

	const get = (id: string) => reg.get(id);
	const list = () => reg.list();
	const byKind = (k: 'provider' | 'comfy') => reg.firstOfKind(k);

	test('undefined / auto → provider by default', () => {
		assert.strictEqual(resolveBackendPreference(undefined, get, list, byKind)?.id, 'p1');
		assert.strictEqual(resolveBackendPreference('auto', get, list, byKind)?.id, 'p1');
	});

	test('explicit provider:<id> / comfy:<id>', () => {
		assert.strictEqual(resolveBackendPreference('provider:p1', get, list, byKind)?.id, 'p1');
		assert.strictEqual(resolveBackendPreference('comfy:c1', get, list, byKind)?.id, 'c1');
	});

	test('bare id lookup', () => {
		assert.strictEqual(resolveBackendPreference('c1', get, list, byKind)?.id, 'c1');
	});

	test('unknown preference falls back to kind', () => {
		assert.strictEqual(resolveBackendPreference('provider:missing', get, list, byKind)?.id, 'p1');
		assert.strictEqual(resolveBackendPreference('comfy:missing', get, list, byKind)?.id, 'c1');
	});

	test('empty registry → undefined', () => {
		const empty = new ImageGenBackendRegistry();
		assert.strictEqual(resolveBackendPreference('auto', empty.get.bind(empty), empty.list.bind(empty), empty.firstOfKind.bind(empty)), undefined);
	});
});

suite('imageGenBackendRegistry — resolve / resolveForNode', () => {

	function buildReg(): ImageGenBackendRegistry {
		const reg = new ImageGenBackendRegistry();
		reg.register(backend('p1', 'provider'));
		reg.register(backend('c1', 'comfy'));
		return reg;
	}

	test('resolve honors explicit preference', () => {
		const reg = buildReg();
		assert.strictEqual(reg.resolve('comfy:c1')?.id, 'c1');
		assert.strictEqual(reg.resolve('provider:p1')?.id, 'p1');
	});

	test('auto + txt2img → provider', () => {
		const reg = buildReg();
		assert.strictEqual(reg.resolveForNode('auto', false)?.id, 'p1');
		assert.strictEqual(reg.resolveForNode(undefined, false)?.id, 'p1');
	});

	test('auto + img2img (upstream image) → comfy', () => {
		const reg = buildReg();
		assert.strictEqual(reg.resolveForNode('auto', true)?.id, 'c1');
	});

	test('explicit preference beats auto-routing even for img2img', () => {
		const reg = buildReg();
		assert.strictEqual(reg.resolveForNode('provider:p1', true)?.id, 'p1');
	});

	test('no provider available → img2img falls back to comfy; txt2img falls back to comfy', () => {
		const reg = new ImageGenBackendRegistry();
		reg.register(backend('c1', 'comfy'));
		assert.strictEqual(reg.resolveForNode('auto', false)?.id, 'c1');
		assert.strictEqual(reg.resolveForNode('auto', true)?.id, 'c1');
	});

	test('empty registry → undefined', () => {
		const reg = new ImageGenBackendRegistry();
		assert.strictEqual(reg.resolveForNode('auto', false), undefined);
		assert.strictEqual(reg.resolve('provider:p1'), undefined);
	});
});
