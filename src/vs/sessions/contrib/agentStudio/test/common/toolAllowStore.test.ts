/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工具授权表（`~/.vssaros/tool-allow.json`）的纯逻辑回归测试（2026-09-13）。
 *
 * ## 为什么从 VS Code 设置搬到文件
 * 旧实现把 `workspace` 作用域经 `ConfigurationTarget.WORKSPACE` 写进
 * **`<workspace>/.vscode/settings.json`** ——
 *   ① 违反本项目约定（数据一律放 `.vssaros/`，见 `sarosPaths` 模块注释）；
 *   ② 该文件在**工作区内、模型可写** ⇒ **「被约束者可以改写约束」**（自己给自己授权）。
 * 现统一存 `~/.vssaros/tool-allow.json`，而 `.vssaros/` 已被 `writeDenyList` 硬拒。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/common/toolAllowStore.test.ts
 */

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	emptyToolAllowFile, parseToolAllowFile, serializeToolAllowFile,
	entriesFor, allEntriesFor, addEntry, removeEntry, migrateLegacyEntries, autoApproveFor,
} from '../../common/toolAllowStore.js';
import { DEFAULT_AUTO_APPROVE } from '../../common/toolApprovalPolicy.js';

suite('toolAllowStore — 授权表文件（~/.vssaros/tool-allow.json）', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * ★★ v2（2026-09-13）：类别档位。
	 *
	 * 核心语义：**「缺省」≠「显式选了默认值」**。
	 *   · 缺省   → 跟随 `DEFAULT_AUTO_APPROVE` 常量（将来翻转默认值能惠及这些用户）；
	 *   · 显式写 → 用户自己的选择，不被默认值变更影响。
	 * 若在 `emptyToolAllowFile` 里把默认值物化，第一次落盘就会把「没选过」变成
	 * 「选过兼容档」，Phase 2 翻转默认值时这批用户会被落下。
	 */
	suite('★ v2 autoApprove（类别档位）', () => {

		test('★★ 空表不物化 autoApprove（缺省才能跟随将来的默认值变更）', () => {
			const empty = emptyToolAllowFile();
			assert.strictEqual(empty.version, 2, '版本升到 2');
			assert.strictEqual(empty.autoApprove, undefined, '不得把默认值写进文件');
		});

		test('★★ v1 文件解析后仍**不写入**该字段，且旧授权条目不丢', () => {
			const v1 = JSON.stringify({ version: 1, global: ['terminal::git status*'], workspaces: { ws1: ['file_write'] } });
			const parsed = parseToolAllowFile(v1);
			assert.strictEqual(parsed.autoApprove, undefined, '缺省保持缺省');
			assert.deepStrictEqual([...parsed.global], ['terminal::git status*']);
			assert.deepStrictEqual([...(parsed.workspaces['ws1'] ?? [])], ['file_write']);
			// 缺省 → 跟随默认常量
			assert.deepStrictEqual({ ...autoApproveFor(parsed) }, { ...DEFAULT_AUTO_APPROVE });
		});

		test('★★ 显式档位被保留；坏档位退化为默认（绝不把坏数据解释成放行）', () => {
			const text = JSON.stringify({
				version: 2,
				autoApprove: { edit: 'ask', execute: 'bogus', read: 42 },
				global: [], workspaces: {},
			});
			const parsed = parseToolAllowFile(text);
			assert.strictEqual(parsed.autoApprove?.['edit'], 'ask', '合法值保留');
			assert.strictEqual(parsed.autoApprove?.['execute'], DEFAULT_AUTO_APPROVE['execute'], '坏值退化');
			assert.strictEqual(parsed.autoApprove?.['read'], DEFAULT_AUTO_APPROVE['read'], '非字符串退化');
		});

		test('★ 序列化保留 autoApprove（存在时）', () => {
			const f = parseToolAllowFile(JSON.stringify({
				version: 2, autoApprove: { edit: 'ask' }, global: [], workspaces: {},
			}));
			assert.ok(serializeToolAllowFile(f).includes('"edit": "ask"'), '落盘后用户的选择不丢');
		});
	});

	test('★★ 宽容解析：空 / 坏 JSON / 形态不符一律退化为空表', () => {
		// 授权表是**安全状态**：宁可退回「无任何授权」（重新弹窗），
		// 也不要把坏数据解释成授权。
		for (const t of [undefined, '', 'not json at all', '[]', 'null', '{"global":"x"}', '{}']) {
			const f = parseToolAllowFile(t);
			assert.deepStrictEqual(f.global, [], `global 应为空：${t}`);
			assert.deepStrictEqual(f.workspaces, {}, `workspaces 应为空：${t}`);
		}
	});

	test('★ 解析有效文件，并过滤空串 / 非字符串项', () => {
		const f = parseToolAllowFile(JSON.stringify({
			version: 1,
			global: ['terminal', '', 42, 'file_write'],
			workspaces: { ws1: ['patch', null], ws2: [] },
		}));
		assert.deepStrictEqual(f.global, ['terminal', 'file_write']);
		assert.deepStrictEqual(f.workspaces, { ws1: ['patch'] }, '空数组的工作区应被省略');
	});

	test('★★ 两个作用域互不串味：allEntriesFor = 全局 + 当前工作区', () => {
		let f = emptyToolAllowFile();
		f = addEntry(f, 'global', 'ws1', 'terminal');
		f = addEntry(f, 'workspace', 'ws1', 'file_write');
		f = addEntry(f, 'workspace', 'ws2', 'patch');

		assert.deepStrictEqual(allEntriesFor(f, 'ws1'), ['terminal', 'file_write']);
		assert.deepStrictEqual(allEntriesFor(f, 'ws2'), ['terminal', 'patch']);
		assert.deepStrictEqual(allEntriesFor(f, 'ws3'), ['terminal'], '别的工区只继承全局');
		assert.deepStrictEqual(entriesFor(f, 'workspace', 'ws1'), ['file_write'], 'entriesFor 不含全局');
		assert.deepStrictEqual(entriesFor(f, 'global', 'ws1'), ['terminal']);
	});

	test('★ 新增幂等（不产生重复项）', () => {
		let f = emptyToolAllowFile();
		f = addEntry(f, 'workspace', 'ws1', 'file_write');
		f = addEntry(f, 'workspace', 'ws1', 'file_write');
		f = addEntry(f, 'global', 'ws1', 'terminal');
		f = addEntry(f, 'global', 'ws1', 'terminal');
		assert.deepStrictEqual(f.workspaces['ws1'], ['file_write']);
		assert.deepStrictEqual(f.global, ['terminal']);
	});

	test('★★ 撤销清**两个**作用域（语义：以后都重新问）', () => {
		let f = emptyToolAllowFile();
		f = addEntry(f, 'global', 'ws1', 'terminal');
		f = addEntry(f, 'workspace', 'ws1', 'terminal');
		f = addEntry(f, 'workspace', 'ws1', 'file_write');

		const after = removeEntry(f, 'terminal');
		assert.deepStrictEqual(after.global, [], '全局里的同名条目也要清');
		assert.deepStrictEqual(after.workspaces['ws1'], ['file_write'], '其余条目不受影响');
	});

	test('★★ 迁移旧 VS Code 设置：全局 / 工作区各归其位，且幂等', () => {
		const once = migrateLegacyEntries(emptyToolAllowFile(), ['terminal'], ['file_write'], 'ws1');
		assert.deepStrictEqual(once.global, ['terminal']);
		assert.deepStrictEqual(once.workspaces['ws1'], ['file_write']);

		const twice = migrateLegacyEntries(once, ['terminal'], ['file_write'], 'ws1');
		assert.deepStrictEqual(twice, once, '重复迁移不得产生重复项（迁移可能被重试）');
	});

	test('★ 序列化 → 解析 往返稳定', () => {
		let f = emptyToolAllowFile();
		f = addEntry(f, 'global', 'ws1', 'terminal::git status*');
		f = addEntry(f, 'workspace', 'ws1', 'file_write');
		assert.deepStrictEqual(parseToolAllowFile(serializeToolAllowFile(f)), f);
	});

	test('★ 纯函数：不改入参', () => {
		const base = emptyToolAllowFile();
		const added = addEntry(base, 'global', 'ws1', 'terminal');
		const removed = removeEntry(added, 'terminal');
		assert.deepStrictEqual(base.global, [], 'addEntry 不得改入参');
		assert.notStrictEqual(added, base);
		assert.deepStrictEqual(removed.global, []);
	});
});
