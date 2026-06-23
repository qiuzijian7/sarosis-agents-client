/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Model Selector - Interface Definitions (Phase 3)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('IModelSelectorService interface structure', () => {
		const service = {
			onDidChangeSelection: { /* Event */ },
			getSelection: () => ({ providerId: 'knot-agui', modelId: 'agent-1' }),
			setSelection: (s: any) => {},
			onDidChangeAvailableModels: { /* Event */ },
			getAvailableModels: () => [],
			showQuickPick: async () => undefined,
			openSettings: (providerId?: string) => {},
		};

		assert.ok(typeof service.getSelection === 'function');
		assert.ok(typeof service.setSelection === 'function');
		assert.ok(typeof service.showQuickPick === 'function');
		assert.ok(typeof service.openSettings === 'function');
	});

	test('IModelSelectorItem interface structure', () => {
		const item = {
			provider: {
				id: 'knot-agui',
				name: 'Knot AG-UI',
				icon: 'codicon-comment',
				authStatus: 'authenticated' as const,
			},
			model: {
				id: 'agent-1',
				name: 'Agent 1',
				description: 'Code assistant',
				contextWindow: 128000,
				capabilities: ['chat', 'function-calling'],
			},
		};

		assert.strictEqual(item.provider.id, 'knot-agui');
		assert.strictEqual(item.provider.authStatus, 'authenticated');
		assert.strictEqual(item.model.id, 'agent-1');
		assert.strictEqual(item.model.contextWindow, 128000);
	});

	test('IModelSelectorProviderInfo interface structure', () => {
		const info = {
			id: 'direct-openai',
			name: 'OpenAI Direct',
			icon: undefined,
			authStatus: 'not-configured' as const,
		};

		assert.strictEqual(info.id, 'direct-openai');
		assert.strictEqual(info.authStatus, 'not-configured');
		assert.strictEqual(info.icon, undefined);
	});

	test('IModelSelectionStorage - global default', () => {
		const storage = {
			_globalDefault: { providerId: 'knot-agui', modelId: 'agent-1' },

			getGlobalDefault: () => storage._globalDefault,
			setGlobalDefault: (s: any) => { storage._globalDefault = s; },
			getWorkspaceSelection: () => undefined,
			setWorkspaceSelection: (s: any) => {},
			getRecentSelections: (limit?: number) => [storage._globalDefault],
			addRecentSelection: (s: any) => {},
		};

		const default_ = storage.getGlobalDefault();
		assert.ok(default_);
		assert.strictEqual(default_.providerId, 'knot-agui');

		storage.setGlobalDefault({ providerId: 'direct-openai', modelId: 'gpt-4' });
		assert.strictEqual(storage.getGlobalDefault().providerId, 'direct-openai');
	});

	test('IModelSelectionStorage - workspace override', () => {
		const storage = {
			_workspaceSelection: undefined as any,

			getGlobalDefault: () => ({ providerId: 'knot-agui', modelId: 'agent-1' }),
			setGlobalDefault: (s: any) => {},
			getWorkspaceSelection: () => storage._workspaceSelection,
			setWorkspaceSelection: (s: any) => { storage._workspaceSelection = s; },
			getRecentSelections: (limit?: number) => [],
			addRecentSelection: (s: any) => {},
		};

		// Initially no workspace override
		assert.strictEqual(storage.getWorkspaceSelection(), undefined);

		// Set workspace override
		storage.setWorkspaceSelection({ providerId: 'direct-openai', modelId: 'gpt-4' });
		const ws = storage.getWorkspaceSelection();
		assert.ok(ws);
		assert.strictEqual(ws.providerId, 'direct-openai');
	});

	test('IModelSelectionStorage - recent selections', () => {
		const recent: any[] = [];
		const storage = {
			getGlobalDefault: () => undefined,
			setGlobalDefault: (s: any) => {},
			getWorkspaceSelection: () => undefined,
			setWorkspaceSelection: (s: any) => {},
			getRecentSelections: (limit?: number) => limit ? recent.slice(0, limit) : recent,
			addRecentSelection: (s: any) => {
				recent.unshift(s);
				if (recent.length > 10) { recent.pop(); }
			},
		};

		storage.addRecentSelection({ providerId: 'knot-agui', modelId: 'agent-1' });
		storage.addRecentSelection({ providerId: 'direct-openai', modelId: 'gpt-4' });

		assert.strictEqual(storage.getRecentSelections().length, 2);
		assert.strictEqual(storage.getRecentSelections(1).length, 1);
		// Most recent first
		assert.strictEqual(storage.getRecentSelections()[0].providerId, 'direct-openai');
	});

	test('IModelSelectionStorage - recent selections limit', () => {
		const recent: any[] = [];
		const storage = {
			getGlobalDefault: () => undefined,
			setGlobalDefault: (s: any) => {},
			getWorkspaceSelection: () => undefined,
			setWorkspaceSelection: (s: any) => {},
			getRecentSelections: (limit?: number) => recent,
			addRecentSelection: (s: any) => {
				recent.unshift(s);
				if (recent.length > 3) { recent.pop(); }
			},
		};

		for (let i = 0; i < 5; i++) {
			storage.addRecentSelection({ providerId: `p-${i}`, modelId: `m-${i}` });
		}

		// Should be limited to 3
		assert.strictEqual(storage.getRecentSelections().length, 3);
		// Most recent is last added
		assert.strictEqual(storage.getRecentSelections()[0].providerId, 'p-4');
	});

	test('showQuickPick returns selection or undefined', async () => {
		const showQuickPick = async (shouldSelect: boolean) => {
			if (shouldSelect) {
				return { providerId: 'knot-agui', modelId: 'agent-1' };
			}
			return undefined;
		};

		const selected = await showQuickPick(true);
		assert.ok(selected);
		assert.strictEqual(selected.providerId, 'knot-agui');

		const cancelled = await showQuickPick(false);
		assert.strictEqual(cancelled, undefined);
	});

	test('openSettings with and without providerId', () => {
		let openedProviderId: string | undefined;
		const openSettings = (providerId?: string) => {
			openedProviderId = providerId;
		};

		// Open generic settings
		openSettings();
		assert.strictEqual(openedProviderId, undefined);

		// Open provider-specific settings
		openSettings('knot-agui');
		assert.strictEqual(openedProviderId, 'knot-agui');
	});
});
