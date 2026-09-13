/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resolveSyncWorkspaceFolders, unionWorkspaceFolders, type WorkspaceFolderDescriptor } from '../../browser/workspaceFolderSync.js';

/**
 * 产品规则：**`agent-sessions.code-workspace`（兜底工作区文件）不应持有 folders**。
 *
 * 该文件由 agents 窗口独占管理，却先后承载不同的 Agent Studio 工作区。一旦把 folder
 * 写进去，切换工作区时旧 root 会经由 `declaredFolders`（上次写盘）与 `currentFolders`
 * （内存）被并集带回来，再写回磁盘 → **不同工作区互相污染，且跨重启累积**。
 *
 * 实测后果：一个与当前工作区毫无关系的 UE5EA（87.6 万节点图谱）被一起加载并起
 * watcher，renderer 堆到 2.6GB 后 UI 卡死。
 *
 * 所以兜底文件走 **替换** 语义；用户自带的 `.code-workspace` 仍走 **并集**
 * （它声明的 folders 是权威集合，只增不减）。
 */
suite('Workspace folder sync — fallback file must not accumulate folders', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const keyOf = (uri: URI): string => uri.toString().toLowerCase();

	const wsA: WorkspaceFolderDescriptor = { uri: URI.file('G:/SarosWorkspace/sarosis-agents-client'), name: 'sarosis-agents-client' };
	const wsB: WorkspaceFolderDescriptor = { uri: URI.file('F:/GR_qiuzijian_main/UE5EA'), name: 'UE5EA' };
	const wsC: WorkspaceFolderDescriptor = { uri: URI.file('F:/GR_qiuzijian_main/S1Game'), name: 'S1Game' };

	const paths = (folders: readonly WorkspaceFolderDescriptor[]): string[] => folders.map(f => f.uri.fsPath);

	test('fallback 文件：切到新工作区后只保留该工作区的 roots（不带回上一个工作区）', () => {
		const result = resolveSyncWorkspaceFolders(true, [wsC], [wsA, wsB], [wsA, wsB], keyOf);
		assert.deepStrictEqual(paths(result), [wsC.uri.fsPath]);
	});

	test('fallback 文件：即使磁盘与内存里都残留旧 folder 也全部丢弃', () => {
		const result = resolveSyncWorkspaceFolders(true, [], [wsA, wsB, wsC], [wsA, wsB], keyOf);
		assert.deepStrictEqual(paths(result), []);
	});

	test('用户自带 .code-workspace：声明的 folders 为权威集合，Agent Studio roots 只做追加', () => {
		const result = resolveSyncWorkspaceFolders(false, [wsC], [wsA, wsB], [wsA], keyOf);
		assert.deepStrictEqual(paths(result), [wsA.uri.fsPath, wsB.uri.fsPath, wsC.uri.fsPath]);
	});

	test('unionWorkspaceFolders：primary 顺序优先，secondary 去重后追加（忽略大小写与盘符大小写）', () => {
		const dup: WorkspaceFolderDescriptor = { uri: URI.file('g:/sarosworkspace/sarosis-agents-client'), name: 'dup' };
		const result = unionWorkspaceFolders([wsA, wsB], [dup, wsC], keyOf);
		assert.deepStrictEqual(paths(result), [wsA.uri.fsPath, wsB.uri.fsPath, wsC.uri.fsPath]);
	});
});
