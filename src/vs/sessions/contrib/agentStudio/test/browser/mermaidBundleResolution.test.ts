/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

/**
 * Pins down the bundle-location resolution used by the hidden Mermaid renderer.
 *
 * Regression guard for: the chat card's "图表" (chart) tab rendered blank while
 * the sidebar preview worked. The renderer resolved a single hard-coded path
 * under `appRoot`, but the mermaid bundle is built next to the sources — sibling
 * to `out/` — and never copied into `out/`, so the lookup always missed.
 *
 * These cases mirror `MermaidInlineRenderer._bundleCandidates()`.
 */

const RENDER_BUNDLE_SEGMENTS = ['extensions', 'mermaid-chat-features', 'chat-webview-out', 'index-render-inline.js'];

function bundleCandidates(appRoot: string): string[] {
	const rootUri = URI.file(appRoot);
	return [
		URI.joinPath(rootUri, '..', ...RENDER_BUNDLE_SEGMENTS).fsPath.replace(/\\/g, '/'),
		URI.joinPath(rootUri, ...RENDER_BUNDLE_SEGMENTS).fsPath.replace(/\\/g, '/'),
	];
}

suite('Mermaid render bundle resolution', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('dev layout: bundle is resolved as a sibling of the app root', () => {
		// appRoot is `<repo>/out` at runtime; the bundle lives at `<repo>/extensions/...`.
		const candidates = bundleCandidates('G:/SarosWorkspace/sarosis-agents-client/out');

		assert.strictEqual(
			candidates[0].toLowerCase(),
			'g:/sarosworkspace/sarosis-agents-client/extensions/mermaid-chat-features/chat-webview-out/index-render-inline.js',
		);
	});

	test('packaged layout: app-root copy is the fallback', () => {
		const candidates = bundleCandidates('/opt/app/resources/app');

		assert.ok(candidates[1].endsWith('/opt/app/resources/app/extensions/mermaid-chat-features/chat-webview-out/index-render-inline.js'));
	});

	test('the source-adjacent candidate is tried before the app-root one', () => {
		const candidates = bundleCandidates('/repo/out');

		assert.ok(candidates[0].indexOf('/repo/extensions/') !== -1, 'first candidate must sit next to the sources');
		assert.ok(candidates[1].indexOf('/repo/out/extensions/') !== -1, 'second candidate must sit inside the app root');
	});

	test('both candidates are distinct paths', () => {
		const candidates = bundleCandidates('/repo/out');

		assert.strictEqual(candidates.length, 2);
		assert.notStrictEqual(candidates[0], candidates[1]);
	});

	test('resolution does not depend on a trailing separator', () => {
		const withSlash = bundleCandidates('/repo/out/');
		const withoutSlash = bundleCandidates('/repo/out');

		assert.deepStrictEqual(withSlash, withoutSlash);
	});
});
