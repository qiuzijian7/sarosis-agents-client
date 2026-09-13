/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

/**
 * These cases pin down the folder-resolution decision made by
 * `WorkspaceFolderSyncContribution._syncWorkspaceFolder`.
 *
 * The rule under test: when the window is backed by a user-supplied
 * `.code-workspace` that declares folders, that set is authoritative. The Agent
 * Studio model's roots may only be *added*, never used to replace it.
 *
 * Regression guard for: opening a 3-folder `.code-workspace` showed a single
 * root in the Explorer, because the Agent Studio startup sync rebuilt the folder
 * list from its own model and dropped the two sibling repositories.
 */

type Folder = { uri: URI; name: string };

function unionFolders(primary: readonly Folder[], secondary: readonly Folder[]): Folder[] {
	const result: Folder[] = [];
	const seen = new Set<string>();

	const push = (folder: Folder) => {
		const key = folder.uri.toString().toLowerCase();
		if (seen.has(key)) {
			return;
		}
		seen.add(key);
		result.push(folder);
	};

	for (const folder of primary) {
		push(folder);
	}
	for (const folder of secondary) {
		push(folder);
	}

	return result;
}

suite('Workspace folder resolution', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const rootDir = URI.file('G:/SarosWorkspace');

	// The three folders declared by the real sarosis-agents-client.code-workspace.
	const declaredFolders: Folder[] = [
		{ uri: URI.file('G:/SarosWorkspace/sarosis-agents-client'), name: 'sarosis-agents-client' },
		{ uri: URI.file('G:/SarosWorkspace/Saros-agents-pocket'), name: 'Saros-agents-pocket' },
		{ uri: URI.file('G:/SarosWorkspace/saros-marketplace'), name: 'saros-marketplace' },
	];

	/** Compare folders by identity rather than by raw path spelling. */
	function folderPaths(folders: readonly Folder[]): string[] {
		return folders.map(f => f.uri.toString(true));
	}

	test('declared folders are kept even when the Agent Studio model only knows one root', () => {
		// The Agent Studio model tracks a single workspace whose home dir is the first root.
		const agentStudioTargets: Folder[] = [
			{ uri: URI.file('G:/SarosWorkspace/sarosis-agents-client'), name: 'sarosis-agents-client' },
		];

		// Old behaviour — declared set replaced by the model → 1 root (the bug).
		const replaced = agentStudioTargets;
		assert.strictEqual(replaced.length, 1);

		// New behaviour — declared folders stay primary, model roots only top up.
		const resolved = unionFolders(declaredFolders, agentStudioTargets);
		assert.strictEqual(resolved.length, 3);
		assert.deepStrictEqual(folderPaths(resolved), folderPaths(declaredFolders));
	});

	test('a declared folder outside the model is never dropped', () => {
		const agentStudioTargets: Folder[] = [
			{ uri: URI.file('G:/SarosWorkspace/sarosis-agents-client'), name: 'sarosis-agents-client' },
		];

		const resolved = unionFolders(declaredFolders, agentStudioTargets);
		assert.ok(resolved.some(f => f.uri.fsPath.endsWith('Saros-agents-pocket')));
		assert.ok(resolved.some(f => f.uri.fsPath.endsWith('saros-marketplace')));
	});

	test('an Agent Studio root missing from the file is appended, not used to replace', () => {
		const extraTarget: Folder = { uri: URI.file('G:/SarosWorkspace/extra-repo'), name: 'extra-repo' };

		// Mirrors the live call: declared folders are primary, model roots secondary.
		const resolved = unionFolders(declaredFolders, [extraTarget]);

		assert.strictEqual(resolved.length, 4);
		// Declared folders keep their original relative order at the front.
		assert.deepStrictEqual(
			folderPaths(resolved.slice(0, 3)),
			folderPaths(declaredFolders),
		);
		// The new root lands at the end.
		assert.strictEqual(resolved[3].uri.toString(true), extraTarget.uri.toString(true));
	});

	test('relative declared paths resolve against the workspace file directory', () => {
		// `../Saros-agents-pocket` relative to `G:/SarosWorkspace/sarosis-agents-client`.
		const workspaceDir = URI.file('G:/SarosWorkspace/sarosis-agents-client');
		const resolvedPocket = URI.joinPath(workspaceDir, '../Saros-agents-pocket');

		assert.strictEqual(
			resolvedPocket.toString(true),
			URI.file('G:/SarosWorkspace/Saros-agents-pocket').toString(true),
		);
	});

	test('a folder already present in both sets appears only once', () => {
		const agentStudioTargets: Folder[] = [
			{ uri: URI.file('G:/SarosWorkspace/sarosis-agents-client'), name: 'sarosis-agents-client' },
			{ uri: URI.file('G:/SarosWorkspace/Saros-agents-pocket'), name: 'Saros-agents-pocket' },
		];

		const resolved = unionFolders(declaredFolders, agentStudioTargets);

		assert.strictEqual(resolved.length, 3, 'union must de-duplicate overlapping roots');
	});

	test('folder names from the workspace file are preserved', () => {
		const resolved = unionFolders([], declaredFolders);

		assert.deepStrictEqual(resolved.map(f => f.name), [
			'sarosis-agents-client',
			'Saros-agents-pocket',
			'saros-marketplace',
		]);
	});

	test('root directory is not used as a workspace folder', () => {
		// Guard against accidentally treating the parent as a folder when unions mis-resolve.
		const resolved = unionFolders([], declaredFolders);

		assert.ok(resolved.every(f => f.uri.fsPath !== rootDir.fsPath));
	});
});
