/*---------------------------------------------------------------------------------------------
 *  Unit tests for pluginLoader — URL plugin system lifecycle (P2).
 *  Pure: module loading is injected, so no dynamic import / network needed.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import {
	loadPlugin,
	unloadPlugin,
	validatePluginManifest,
	namespaceType,
	buildSpecExtras,
	isPluginLoaded,
	getLoadedPluginIds,
	getPluginNodeRunner,
	type PluginManifest,
	type PluginModule,
} from '../../webview/src/features/workflowEditor/comfyHost/pluginLoader.js';
import { getNodeSpec, registerSarosisNodes } from '../../webview/src/features/workflowEditor/comfyHost/registry.js';

// Clean registry before each run (avoid leaking plugin node types across tests).
suiteSetup(() => { registerSarosisNodes(); });

function fakeModule(registerBody?: (api: unknown) => void): PluginModule {
	// A module whose register() calls defineNode with the given defs.
	const { defineNode, ...rest } = {};
	void defineNode; void rest;
	return {
		register: registerBody ?? ((api: any) => {
			api.defineNode({
				name: 'Vignette',
				label: '暗角',
				category: 'retouch',
				inputs: [{ name: 'image', type: 'IMAGE' }],
				outputs: [{ name: 'image', type: 'IMAGE' }],
				fields: [
					{ key: 'intensity', label: '强度', kind: 'number', defaultValue: 0.5 },
					{ key: 'mode', label: '模式', kind: 'select', options: ['soft', 'hard'], defaultValue: 'soft' },
				],
			});
			api.defineNode({ name: 'Grain', inputs: [], outputs: [{ name: 'image', type: 'IMAGE' }] });
		}),
	};
}

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
	return { pluginId: 'retouch-pro', name: 'Retouch Pro', version: '1.0.0', scriptURL: 'https://cdn.example.com/retouch.js', ...overrides };
}

suite('validatePluginManifest', () => {

	test('accepts a valid manifest', () => {
		assert.strictEqual(validatePluginManifest(manifest()), null);
	});

	test('rejects empty / invalid pluginId', () => {
		assert.ok(validatePluginManifest(manifest({ pluginId: '' })));
		assert.ok(validatePluginManifest(manifest({ pluginId: '1bad' })));
		assert.ok(validatePluginManifest(manifest({ pluginId: 'a'.repeat(65) })));
	});

	test('rejects non-http scriptURL', () => {
		assert.ok(validatePluginManifest(manifest({ scriptURL: 'file:///x.js' })));
		assert.ok(validatePluginManifest(manifest({ scriptURL: 'relative/path.js' })));
	});

	test('rejects missing name/version', () => {
		assert.ok(validatePluginManifest(manifest({ name: '' })));
		assert.ok(validatePluginManifest(manifest({ version: '' })));
	});
});

suite('namespaceType', () => {
	test('prefixes the bare name with the plugin id', () => {
		assert.strictEqual(namespaceType('retouch-pro', 'Vignette'), 'retouch-pro:Vignette');
	});
});

suite('loadPlugin', () => {

	test('loads a plugin and registers namespaced node types', async () => {
		const r = await loadPlugin(manifest(), {
			loadModule: async () => fakeModule(),
			createStorage: () => new Map<string, string>() as never,
		});
		assert.strictEqual(r.manifest.pluginId, 'retouch-pro');
		assert.deepStrictEqual(r.registered.sort(), ['retouch-pro:Grain', 'retouch-pro:Vignette'].sort());
		assert.strictEqual(r.replaced, false);
		assert.strictEqual(isPluginLoaded('retouch-pro'), true);

		const spec = getNodeSpec('retouch-pro:Vignette');
		assert.ok(spec, 'namespaced node registered');
		assert.strictEqual(spec!.title, '暗角');
		assert.strictEqual(spec!.kind, 'native');
		assert.strictEqual(spec!.category, 'retouch');
		assert.strictEqual(spec!.inputs[0].type, 'IMAGE');
		// widgets built from fields
		assert.strictEqual(spec!.widgets?.length, 2);
		assert.strictEqual(spec!.widgets![0].name, 'intensity');
		assert.strictEqual(spec!.widgets![0].type, 'number');
	});

	test('reload with same pluginId replaces previous version', async () => {
		await loadPlugin(manifest({ version: '1.0.0' }), { loadModule: async () => fakeModule() });
		const r = await loadPlugin(manifest({ version: '2.0.0' }), { loadModule: async () => fakeModule() });
		assert.strictEqual(r.replaced, true);
		assert.strictEqual(getLoadedPluginIds().filter(x => x === 'retouch-pro').length, 1);
	});

	test('register throwing rolls back every node it registered', async () => {
		await assert.rejects(
			loadPlugin(manifest({ pluginId: 'broken' }), {
				loadModule: async () => ({
					register: (api: any) => {
						api.defineNode({ name: 'A' });
						api.defineNode({ name: 'B' });
						throw new Error('boom');
					},
				}),
			}),
			/回滚/,
		);
		// Rolled back → neither node registered.
		assert.strictEqual(getNodeSpec('broken:A'), undefined);
		assert.strictEqual(getNodeSpec('broken:B'), undefined);
		assert.strictEqual(isPluginLoaded('broken'), false);
	});

	test('duplicate bare names inside one plugin throw', async () => {
		await assert.rejects(
			loadPlugin(manifest({ pluginId: 'dup' }), {
				loadModule: async () => ({
					register: (api: any) => {
						api.defineNode({ name: 'X' });
						api.defineNode({ name: 'X' });
					},
				}),
			}),
			/重复定义/,
		);
	});

	test('plugin registering no nodes throws', async () => {
		await assert.rejects(
			loadPlugin(manifest({ pluginId: 'empty' }), { loadModule: async () => ({ register: () => { } }) }),
			/未注册任何节点/,
		);
	});

	test('module without register() throws', async () => {
		await assert.rejects(
			loadPlugin(manifest({ pluginId: 'badmod' }), { loadModule: async () => ({}) }),
			/register\(api\)/,
		);
	});

	test('invalid manifest is rejected before any load', async () => {
		await assert.rejects(
			loadPlugin(manifest({ scriptURL: 'file:///x.js' }), { loadModule: async () => fakeModule() }),
			/仅允许 http/,
		);
	});
});

suite('plugin node runtime hooks (onRun)', () => {

	test('onRun hook is registered per node type and survives load', async () => {
		const runner = async () => ({ intensity: 1 });
		await loadPlugin(manifest({ pluginId: 'hooky' }), {
			loadModule: async () => ({
				register: (api: any) => {
					api.defineNode({ name: 'Hooked', onRun: runner });
				},
			}),
		});
		const resolved = getPluginNodeRunner('hooky:Hooked');
		assert.strictEqual(resolved, runner);
	});

	test('onRun hook is cleared on unload', async () => {
		await loadPlugin(manifest({ pluginId: 'hooky' }), {
			loadModule: async () => ({
				register: (api: any) => {
					api.defineNode({ name: 'Hooked', onRun: async () => ({}) });
				},
			}),
		});
		unloadPlugin('hooky');
		assert.strictEqual(getPluginNodeRunner('hooky:Hooked'), undefined);
	});

	test('onRun hook is cleared when register() rolls back', async () => {
		await assert.rejects(
			loadPlugin(manifest({ pluginId: 'hooky-bad' }), {
				loadModule: async () => ({
					register: (api: any) => {
						api.defineNode({ name: 'A', onRun: async () => ({}) });
						throw new Error('boom');
					},
				}),
			}),
			/回滚/,
		);
		assert.strictEqual(getPluginNodeRunner('hooky-bad:A'), undefined);
	});

	test('unknown plugin node type has no runner', () => {
		assert.strictEqual(getPluginNodeRunner('no-such:Node'), undefined);
	});
});

suite('unloadPlugin', () => {

	test('prunes every node type the plugin registered', async () => {
		await loadPlugin(manifest(), { loadModule: async () => fakeModule() });
		const n = unloadPlugin('retouch-pro');
		assert.strictEqual(n, 2);
		assert.strictEqual(getNodeSpec('retouch-pro:Vignette'), undefined);
		assert.strictEqual(getNodeSpec('retouch-pro:Grain'), undefined);
		assert.strictEqual(isPluginLoaded('retouch-pro'), false);
	});

	test('unloading an unloaded plugin is a no-op', () => {
		assert.strictEqual(unloadPlugin('never-loaded'), 0);
	});
});

suite('buildSpecExtras', () => {

	test('maps fields to native widgets with defaults', () => {
		const extras = buildSpecExtras({
			name: 'X',
			fields: [
				{ key: 'a', label: 'A', kind: 'number', defaultValue: 3 },
				{ key: 'b', label: 'B', kind: 'select', options: ['x', 'y'] },
				{ key: 'c', label: 'C', kind: 'boolean' },
				{ key: 'd', label: 'D', kind: 'textarea' },
			],
		});
		assert.strictEqual(extras.widgets?.length, 4);
		assert.deepStrictEqual(extras.widgets![0], { name: 'a', label: 'A', type: 'number', default: 3 });
		assert.deepStrictEqual(extras.widgets![1], { name: 'b', label: 'B', type: 'combo', options: ['x', 'y'] });
		assert.strictEqual(extras.widgets![2].type, 'toggle');
		assert.strictEqual(extras.widgets![3].type, 'text');
	});

	test('no fields → no widgets', () => {
		assert.deepStrictEqual(buildSpecExtras({ name: 'X' }), {});
	});
});
