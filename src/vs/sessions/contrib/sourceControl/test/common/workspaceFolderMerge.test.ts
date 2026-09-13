/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { folderListsMatch, mergeWorkspaceFolders, normalizeFolderKey } from '../../common/workspaceFolderMerge.js';

suite('workspaceFolderMerge', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const folder = (fsPath: string, name?: string) => ({ uri: { fsPath }, name: name ?? fsPath });

	test('normalizeFolderKey ignores separators, case and trailing slashes', () => {
		assert.strictEqual(normalizeFolderKey('G:\\SarosWorkspace\\repo\\'), normalizeFolderKey('g:/sarosworkspace/repo'));
		assert.strictEqual(normalizeFolderKey('C:\\Users\\Me'), normalizeFolderKey('c:/users/me'));
	});

	test('normalizeFolderKey keeps distinct paths distinct', () => {
		assert.notStrictEqual(normalizeFolderKey('g:/a'), normalizeFolderKey('g:/b'));
	});

	test('merging a single SCM root preserves a multi-root declared folder list', () => {
		// Regression: the agents window opens a 3-folder `.code-workspace`, then the
		// SCM sync for the active workspace injected only 1 root and wiped the rest.
		const current = [
			folder('g:/SarosWorkspace/sarosis-agents-client', 'sarosis-agents-client'),
			folder('g:/SarosWorkspace/Saros-agents-pocket', 'Saros-agents-pocket'),
			folder('g:/SarosWorkspace/saros-marketplace', 'saros-marketplace'),
		];
		const targets = [folder('g:/SarosWorkspace/sarosis-agents-client', 'sarosis-agents-client')];

		const merged = mergeWorkspaceFolders(current, targets);

		assert.strictEqual(merged.length, 3);
		assert.deepStrictEqual(
			merged.map(f => f.name),
			['sarosis-agents-client', 'Saros-agents-pocket', 'saros-marketplace'],
		);
	});

	test('a missing SCM root is appended, keeping existing folders in place', () => {
		const current = [folder('g:/a', 'a'), folder('g:/b', 'b')];
		const targets = [folder('g:/c', 'c')];

		const merged = mergeWorkspaceFolders(current, targets);

		assert.deepStrictEqual(merged.map(f => f.name), ['a', 'b', 'c']);
	});

	test('an already-present SCM root does not duplicate', () => {
		const current = [folder('g:/a', 'a'), folder('g:/b', 'b')];
		const targets = [folder('G:\\a\\', 'a-other-name')];

		const merged = mergeWorkspaceFolders(current, targets);

		assert.strictEqual(merged.length, 2);
		assert.strictEqual(merged[0].name, 'a', 'existing folder entry wins');
	});

	test('duplicate targets collapse to one root', () => {
		const merged = mergeWorkspaceFolders([], [folder('g:/a', 'a'), folder('g:/a/', 'a-again')]);
		assert.strictEqual(merged.length, 1);
	});

	test('duplicate current folders collapse to one root', () => {
		const merged = mergeWorkspaceFolders([folder('g:/a', 'a'), folder('G:\\a', 'a-again')], []);
		assert.strictEqual(merged.length, 1);
	});

	test('an empty current list yields exactly the targets', () => {
		const merged = mergeWorkspaceFolders([], [folder('g:/a', 'a'), folder('g:/b', 'b')]);
		assert.deepStrictEqual(merged.map(f => f.name), ['a', 'b']);
	});

	test('an empty target list leaves the current list untouched', () => {
		const current = [folder('g:/a', 'a'), folder('g:/b', 'b')];
		const merged = mergeWorkspaceFolders(current, []);
		assert.deepStrictEqual(merged.map(f => f.name), ['a', 'b']);
	});

	test('folderListsMatch detects an identical set', () => {
		const current = [folder('g:/a', 'a'), folder('g:/b', 'b')];
		assert.strictEqual(folderListsMatch(current, [folder('G:\\a', 'x'), folder('g:/b/', 'y')]), true);
	});

	test('folderListsMatch detects a differing length', () => {
		const current = [folder('g:/a', 'a'), folder('g:/b', 'b')];
		assert.strictEqual(folderListsMatch(current, [folder('g:/a', 'a')]), false);
	});

	test('folderListsMatch detects a differing order', () => {
		const current = [folder('g:/a', 'a'), folder('g:/b', 'b')];
		assert.strictEqual(folderListsMatch(current, [folder('g:/b', 'b'), folder('g:/a', 'a')]), false);
	});

	test('folderListsMatch detects a differing membership', () => {
		const current = [folder('g:/a', 'a'), folder('g:/b', 'b')];
		assert.strictEqual(folderListsMatch(current, [folder('g:/a', 'a'), folder('g:/c', 'c')]), false);
	});
});
