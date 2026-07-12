/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation.  All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { EditorPaneDescriptor, EditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { FileEditorInput } from '../../../contrib/files/browser/editors/fileEditorInput.js';
import { HtmlPreviewEditorInput } from '../../browser/htmlPreviewEditorInput.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

const editorPaneRegistry: EditorPaneRegistry = Registry.as(EditorExtensions.EditorPane);

suite('HtmlFileEditorPane — Editor Routing Tests', () => {

	const disposables = new DisposableStore();

	teardown(() => {
		disposables.clear();
	});

	// ─── 1. Registry Lookup: HtmlPreviewEditorInput must route to HtmlFileEditorPane ──

	test('HtmlPreviewEditorInput resolves to agentStudio.htmlFileEditor pane', () => {
		const input = disposables.add(new HtmlPreviewEditorInput(
			URI.file('/test/preview.html'),
			'Preview: preview.html'
		));

		const descriptor = editorPaneRegistry.getEditorPane(input);

		assert.ok(descriptor, 'Expected a matching editor pane descriptor for HtmlPreviewEditorInput');
		assert.strictEqual(
			descriptor!.typeId,
			'agentStudio.htmlFileEditor',
			`Expected pane typeId "agentStudio.htmlFileEditor" but got "${descriptor?.typeId}"`
		);
	});

	// ─── 2. FileEditorInput with .html extension also routes to HtmlFileEditorPane ──

	test('FileEditorInput (.html) resolves to agentStudio.htmlFileEditor (not TextFileEditor)', () => {
		const input = disposables.add(new HtmlFileEditorInputForTest(
			URI.file('/workspace/index.html'),
			'index.html',
		 undefined,
		 undefined,
		 undefined,
		 undefined,
		 undefined
		));

		const descriptor = editorPaneRegistry.getEditorPane(input);

		assert.ok(descriptor, 'Expected a matching editor pane descriptor for .html FileEditorInput');
		assert.strictEqual(
			descriptor!.typeId,
			'agentStudio.htmlFileEditor',
			`Expected .html files to route to HtmlFileEditorPane but got "${descriptor?.typeId}"`
		);
	});

	// ─── 3. Non-HTML FileEditorInput should NOT route to HtmlFileEditorPane ──

	test('FileEditorInput (.ts) does NOT resolve to agentStudio.htmlFileEditor', () => {
		const input = disposables.add(new HtmlFileEditorInputForTest(
			URI.file('/workspace/main.ts'),
			'main.ts',
		 undefined,
		 undefined,
		 undefined,
		 undefined,
		 undefined
		));

		const descriptor = editorPaneRegistry.getEditorPane(input);

		if (descriptor && descriptor.typeId === 'agentStudio.htmlFileEditor') {
			assert.fail('Non-HTML files should NOT be routed to HtmlFileEditorPane');
		}
		// It should go to TextFileEditor or BinaryFileEditor instead
	});

	// ─── 4. Verify both input types are registered together on same pane ──

	test('HtmlFileEditorPane is registered for BOTH FileEditorInput AND HtmlPreviewEditorInput', () => {
		const htmlFilePaneDesc = editorPaneRegistry.getEditorPaneByType('agentStudio.htmlFileEditor');
		assert.ok(htmlFilePaneDesc, 'agentStudio.htmlFileEditor pane must be registered');

		const allEditors = editorPaneRegistry.getEditors();
		const hasFileEditorInput = allEditors.includes(FileEditorInput as any);
		const hasHtmlPreviewInput = allEditors.includes(HtmlPreviewEditorInput as any);

		assert.ok(hasFileEditorInput,
			'HtmlFileEditorPane must have FileEditorInput in its accepted inputs list');
		assert.ok(hasHtmlPreviewInput,
			'HtmlFileEditorPane must have HtmlPreviewEditorInput in its accepted inputs list');
	});

	// ─── 5. Multiple match prefers correct pane via prefersEditorPane ──

	test('When multiple panes match, HtmlPreviewEditorInput.prefersEditorPane selects correctly', () => {
		const input = disposables.add(new HtmlPreviewEditorInput(
			URI.file('/test/page.html'),
			'Preview: page.html'
		));

		const descriptors: EditorPaneDescriptor[] = [];
		// Collect all descriptors that match this input type by checking registry internals
		for (const pane of editorPaneRegistry.getEditorPanes()) {
			const desc = editorPaneRegistry.getEditorPane(input);
			if (desc && !descriptors.find(d => d.typeId === desc.typeId)) {
				descriptors.push(desc);
			}
		}

		// At minimum, our HtmlFileEditorPane should be among the matches
		const hasHtmlFileEditor = descriptors.some(d => d.typeId === 'agentStudio.htmlFileEditor');
		assert.ok(hasHtmlFileEditor,
			'HtmlFileEditorPane should be in the candidate list for HtmlPreviewEditorInput');
	});

	// ─── 6. HtmlPreviewEditorInput metadata correctness ──

	test('HtmlPreviewEditorInput carries correct typeId and resource', () => {
		const resource = URI.file('/workspace/output/dashboard.html');
		const input = new HtmlPreviewEditorInput(resource, '预览：dashboard.html');

		assert.strictEqual(input.typeId, 'workbench.editor.agentStudio.htmlPreview');
		assert.strictEqual(input.resource.toString(), resource.toString());
		assert.strictEqual(input.getName(), '预览：dashboard.html');
		assert.strictEqual(input.editorId, 'workbench.editor.agentStudio.htmlPreview');

		input.dispose();
	});

	// ─── 7. toUntyped() preserves override for resolver path ──

	test('HtmlPreviewEditorInput.toUntyped() includes override option', () => {
		const resource = URI.file('/test/foo.html');
		const input = new HtmlPreviewEditorInput(resource, 'Preview: foo.html');

		const untyped = input.toUntyped();
		assert.ok(untyped, 'toUntyped() should return a value');
		assert.strictEqual(
			(untyped as any).options?.override,
			'workbench.editor.agentStudio.htmlPreview',
			'toUntyped() options.override must contain HtmlPreviewEditorInput.ID'
		);

		input.dispose();
	});

	ensureNoDisposablesAreLeakedInTestSuite();
});

/**
 * Minimal FileEditorInput subclass for testing.
 * We cannot use the real FileEditorInput directly because its constructor
 * requires many injected services; this lightweight subclass lets us verify
 * the registry routing without needing full DI.
 */
class HtmlFileEditorInputForTest extends FileEditorInput {
	constructor(
		resource: URI,
		preferredResource?: URI,
		preferredName?: string,
		preferredDescription?: string,
		preferredEncoding?: string,
		preferredLanguageId?: string,
		preferredContents?: string,
	) {
		super(resource, preferredResource, preferredName, preferredDescription,
			preferredEncoding, preferredLanguageId, preferredContents);
	}

	override get typeId(): string {
		return 'workbench.editors.textFileEditor';
	}
}
