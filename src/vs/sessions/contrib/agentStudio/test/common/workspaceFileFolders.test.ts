/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `workspaceFileFolders` 的单测 —— 「把新 root 追加进 `.code-workspace`」的合并口径。
 *
 * 这是 2026-09-16 用户裁决（加根要真正写回原文件）后的**安全边界**：
 * 口径必须是"只增不改"，否则就会重演 09-14/15「用户手写 entries 被清空/裁掉」的事故 ✗。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/common/workspaceFileFolders.test.ts
 */

import assert from 'assert';
import {
	normalizeFolderPathForCompare,
	planAppendWorkspaceFolders,
	resolveFolderPath,
} from '../../common/workspaceFileFolders.js';

suite('workspaceFileFolders — 加根写回工作区文件的「只增不改」口径', () => {

	test('★★★ 只追加：既有 entries（相对路径 / name / uri）原样保留，一个新条目追加在末尾', () => {
		const existing = [
			{ path: 'app' },                                        // 相对文件目录
			{ path: 'F:\\shared\\lib', name: 'lib' },               // 绝对 + name
			{ uri: 'file:///f%3A/remote/other' },                   // uri 形态
		];
		const r = planAppendWorkspaceFolders(existing, ['f:\\ws\\newroot'], 'f:\\ws\\multi.code-workspace', true);

		assert.deepStrictEqual(
			r.folders.slice(0, existing.length),
			existing,
			'用户手写的既有条目必须**一个字节都不改**（顺序、字段、写法全保留）',
		);
		assert.deepStrictEqual(r.folders[existing.length], { path: 'newroot' }, '同目录之下写相对路径（正斜杠）');
		assert.deepStrictEqual(r.appended, ['f:\\ws\\newroot']);
	});

	test('★★★ 幂等：已声明过的 root（相对/大小写/尾斜杠不同）必须跳过 ⇒ appended 为空（调用方据此不写盘）', () => {
		const r = planAppendWorkspaceFolders(
			[{ path: 'app' }],
			['F:\\ws\\APP\\', 'f:\\other'],
			'f:\\ws\\m.code-workspace',
			true,
		);
		assert.deepStrictEqual(r.appended, ['f:\\other'], '`app` 已由相对条目声明过 ⇒ 必须跳过');
		assert.deepStrictEqual(r.folders, [{ path: 'app' }, { path: 'f:\\other' }], '目录外写绝对路径');
	});

	test('★★ 目录外/`..` 折返 ⇒ 写绝对路径（永不含歧义）', () => {
		const r = planAppendWorkspaceFolders([], ['f:\\ws\\..\\sibling'], 'f:\\ws\\m.code-workspace', true);
		assert.deepStrictEqual(r.appended, ['f:\\sibling'], '`..` 必须折叠');
		assert.deepStrictEqual(r.folders, [{ path: 'f:\\sibling' }], '不在工作区文件目录下 ⇒ 绝对路径');
	});

	test('★★ `uri` 形态的既有条目也要参与判重（否则会重复追加同一目录）', () => {
		const r = planAppendWorkspaceFolders(
			[{ uri: 'file:///f%3A/ws/app' }],
			['f:\\ws\\app'],
			'f:\\ws\\m.code-workspace',
			true,
		);
		assert.deepStrictEqual(r.appended, []);
		assert.deepStrictEqual(r.folders, [{ uri: 'file:///f%3A/ws/app' }]);
	});

	test('★ 大小写敏感平台（Linux）不得把 `app` 与 `APP` 当成同一个 root', () => {
		const r = planAppendWorkspaceFolders([{ path: 'app' }], ['/ws/APP'], '/ws/m.code-workspace', false);
		assert.deepStrictEqual(r.appended, ['/ws/APP']);
		assert.deepStrictEqual(r.folders, [{ path: 'app' }, { path: 'APP' }]);
	});

	test('★ 纯函数无副作用：传入的既有数组不被改写', () => {
		const existing = [{ path: 'app' }];
		planAppendWorkspaceFolders(existing, ['f:\\ws\\new'], 'f:\\ws\\m.code-workspace', true);
		assert.deepStrictEqual(existing, [{ path: 'app' }], '不得原地修改调用方的数组');
	});

	test('★ 路径工具：相对解析、尾斜杠归一、绝对路径规整', () => {
		assert.strictEqual(resolveFolderPath('f:\\ws', 'app'), 'f:\\ws\\app');
		assert.strictEqual(resolveFolderPath('f:\\ws', 'f:\\other\\'), 'f:\\other');
		assert.strictEqual(normalizeFolderPathForCompare('F:\\WS\\App\\', true), 'f:\\ws\\app');
	});
});
