/*---------------------------------------------------------------------------------------------
 *  Unit tests for the plugin manager panel helpers (P2).
 *  pluginIdFromUrl is a pure function — the React component itself is UI-only
 *  (covered by the bundle build + manual e2e).
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { pluginIdFromUrl } from '../../webview/src/features/workflowEditor/PluginManagerPanel.js';

suite('pluginIdFromUrl', () => {

	test('derives id from hostname + script basename', () => {
		assert.strictEqual(pluginIdFromUrl('https://cdn.example.com/retouch.js'), 'cdn-example-com-retouch');
	});

	test('strips .mjs extension', () => {
		assert.strictEqual(pluginIdFromUrl('https://x.com/plugins/vignette.mjs'), 'x-com-vignette');
	});

	test('handles query/hash and paths', () => {
		assert.strictEqual(
			pluginIdFromUrl('https://cdn.example.com/a/b/my-plugin.js?v=2'),
			'cdn-example-com-my-plugin',
		);
	});

	test('sanitizes illegal characters', () => {
		assert.strictEqual(pluginIdFromUrl('https://c.d/re_touch!.js'), 'c-d-re-touch');
	});

	test('falls back when URL is invalid', () => {
		const id = pluginIdFromUrl('not-a-url');
		assert.ok(id.startsWith('plugin-'), `expected fallback id, got ${id}`);
	});

	test('ensures the id starts with a letter', () => {
		const id = pluginIdFromUrl('https://123.example.com/x.js');
		assert.ok(/^[a-z]/.test(id), `expected leading letter, got ${id}`);
	});

	test('clamps to 64 chars', () => {
		const longHost = 'a'.repeat(80);
		const id = pluginIdFromUrl(`https://${longHost}.com/x.js`);
		assert.ok(id.length <= 64, `expected ≤64 chars, got ${id.length}`);
	});
});
