/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isPathInside } from '../../common/dshPageBridgeProtocol.js';
import { knowledgeBaseTrustRoots } from '../../common/dshKbTrust.js';

/**
 * 2026-10-15：用户报"点击知识库里的文件打不开 editorpane" —— 根因是页面桥对**工作区之外**的路径
 * 先弹一条带「打开」按钮的通知，而知识库默认就在工作区之外 ✗（`<数据根>/knowledge-base/…`）
 * ⇒ 这组测试钉住"哪些根算知识库、免掉那道确认"以及**信任面没有被放宽** ✓。
 *
 * ★ 2026-11-10（用户裁决「以 dsh 侧配置为准、移除 IDE 侧配置和逻辑」）：
 *   参数从 `(kbRootOverride, dataRoot, vaultPaths[])` 收敛为 `(dataRoot, dshConfiguredRoot?)`。
 *   IDE 幽灵设置与 storage customPath 不再是信任来源；`dshConfiguredRoot` 指 dsh 插件自持的
 *   `<数据根>/.kb-root.json` 里由聊天框工具卡写入的根目录。
 */
suite('dshHarness / 页面桥的知识库信任口径', () => {

	test('根集合 = dsh 侧配置根 ＋ 数据根缺省 `<数据根>/knowledge-base`；去重、忽略空白', () => {
		assert.deepStrictEqual(knowledgeBaseTrustRoots('C:\\data\\root'),
			['C:\\data\\root/knowledge-base'], '没配 dsh 根 ⇒ 用缺省（与插件侧 `kbRootOf` 的缺省同值 ✓）');
		assert.deepStrictEqual(knowledgeBaseTrustRoots('C:\\data\\root', 'D:\\kb'),
			['D:\\kb', 'C:\\data\\root/knowledge-base'],
			'配过 dsh 根就用它 —— ⚠ 同时**保留**缺省（两种布局都可能命中 ✓）');
		assert.deepStrictEqual(knowledgeBaseTrustRoots('C:\\data\\root\\'),
			['C:\\data\\root/knowledge-base'], '尾部反斜杠要被吃掉（否则拼出 `root//knowledge-base` ✗）');
		assert.deepStrictEqual(knowledgeBaseTrustRoots('C:\\data\\root', '   '),
			['C:\\data\\root/knowledge-base'], '只有空白的配置根要被忽略 ✓');
		assert.deepStrictEqual(knowledgeBaseTrustRoots('C:\\data\\root', 'C:\\data\\root/knowledge-base'),
			['C:\\data\\root/knowledge-base'], '配置根与缺省根同值 ⇒ 去重 ✓');
		assert.deepStrictEqual(knowledgeBaseTrustRoots(undefined, undefined), [], '什么都没有 ⇒ 空集合（fail-closed ✓）');
		assert.deepStrictEqual(knowledgeBaseTrustRoots('   ', '  '), [], '只有空白 ⇒ 同样空集合 ✓');
	});

	test('★ 信任面**只**覆盖这些根：知识库内免确认；同一用户目录下的其它文件、库根的兄弟目录仍要确认', () => {
		const roots = knowledgeBaseTrustRoots('C:\\Users\\u\\.vssaros-dev', 'E:\\VsSarosVault');
		// 正例（这两类就是"点了应该直接开"的）
		assert.ok(isPathInside('C:/Users/u/.vssaros-dev/knowledge-base/20260709063858-azbh1at/知识库列表/a.md', roots, true),
			'数据根里的笔记 ⇒ 免确认 ✓');
		assert.ok(isPathInside('E:\\VsSarosVault\\知识库列表\\a.md', roots, true),
			'dsh 侧配置根（工具卡选的那个文件夹）⇒ 免确认 ✓');
		// 负例（信任面**没有**被放宽 ✗）
		assert.ok(!isPathInside('C:\\Users\\u\\Documents\\x.md', roots, true),
			'同一个用户目录下的其它文件 ⇒ **仍要**确认 ✓（只信任知识库那几个根 ✓）');
		assert.ok(!isPathInside('C:\\Users\\u\\.vssaros-dev\\dsh-home\\startup.log', roots, true),
			'数据根**的兄弟**（不是 knowledge-base 底下）⇒ 仍要确认 ✓');
		assert.ok(!isPathInside('E:\\VsSarosVault-other\\a.md', roots, true),
			'配置根的兄弟目录（前缀相同）⇒ 仍要确认 ✓（按段边界判定 ✓）');
		assert.ok(!isPathInside('G:\\SarosWorkspace\\repo\\a.ts', roots, true),
			'工作区文件走工作区那条闸，不在这里判 ✓');
		assert.ok(!isPathInside('E:\\VsSarosVault\\a.md', [], true), '空集合 ⇒ 一律不信任 ✓');
	});
});
