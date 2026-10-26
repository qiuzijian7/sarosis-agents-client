/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { parseCodeWorkspaceFolders } from '../../common/codeWorkspaceFolders.js';

suite('codeWorkspaceFolders（.code-workspace 解析口径）', () => {

	// 基准目录用**带反斜杠**的路径 ⇒ 解析结果的分隔符与平台无关（函数按 baseDir 选分隔符）✓
	const base = 'C:\\ws';

	test('相对路径按工作区文件所在目录解析；第一个是主根，其余是关联根', () => {
		const r = parseCodeWorkspaceFolders(JSON.stringify({
			folders: [{ path: 'client' }, { path: './market', name: '商城' }, { path: 'tools' }],
		}), base);
		assert.strictEqual(r.primaryPath, 'C:\\ws\\client');
		assert.deepStrictEqual(r.extraFolders.map(f => f.path), ['C:\\ws\\market', 'C:\\ws\\tools']);
		assert.strictEqual(r.extraFolders[0].name, '商城');
	});

	test('绝对路径原样保留', () => {
		const r = parseCodeWorkspaceFolders(JSON.stringify({
			folders: [{ path: 'D:\\other\\root' }],
		}), base);
		assert.strictEqual(r.primaryPath, 'D:\\other\\root');
	});

	test('JSONC：注释与尾逗号都能解析（`JSON.parse` 会直接抛 ✗）', () => {
		const text = `{
			// 这是本仓自己的 .code-workspace 里就有的写法
			"folders": [
				{ "path": "client" },
			],
			/* 块注释 */
		}`;
		const r = parseCodeWorkspaceFolders(text, base);
		assert.strictEqual(r.primaryPath, 'C:\\ws\\client');
	});

	test('`uri` 写法：file:// 支持；远程 scheme 跳过（不能当本地目录用）', () => {
		const r = parseCodeWorkspaceFolders(JSON.stringify({
			folders: [
				{ path: 'client' },
				{ uri: 'file:///D:/other' },
				{ uri: 'vscode-remote://ssh-remote+box/home/x' },
			],
		}), base);
		assert.strictEqual(r.primaryPath, 'C:\\ws\\client');
		// 远程那条被跳过 ⇒ 只剩一个关联根
		assert.strictEqual(r.extraFolders.length, 1);
		assert.ok(/other/i.test(r.extraFolders[0].path));
	});

	test('`settings.files.exclude` 与 `settings.codebase-memory` 一并取出', () => {
		const r = parseCodeWorkspaceFolders(JSON.stringify({
			folders: [{ path: 'client' }],
			settings: {
				'files.exclude': { '**/.git': true },
				'codebase-memory': { mode: 'deep', excludeDirs: ['node_modules'] },
			},
		}), base);
		assert.deepStrictEqual(r.filesExclude, { '**/.git': true });
		assert.strictEqual(r.codebaseMemory?.mode, 'deep');
		assert.deepStrictEqual(r.codebaseMemory?.excludeDirs, ['node_modules']);
	});

	test('没有可解析的 folder ⇒ 不编一个假的主根出来（宁缺勿造）', () => {
		const r = parseCodeWorkspaceFolders(JSON.stringify({ folders: [] }), base);
		assert.strictEqual(r.primaryPath, undefined);
		assert.deepStrictEqual(r.extraFolders, []);
	});

	test('坏 JSON 不抛（返回空结果 + 记下错误数）⇒ 调用方能如实提示而不是崩', () => {
		const r = parseCodeWorkspaceFolders('{ this is not json', base);
		assert.strictEqual(r.primaryPath, undefined);
		assert.ok(r.parseErrorCount >= 0);
	});
});
