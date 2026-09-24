/*---------------------------------------------------------------------------------------------
 *  知识库内文件判定（`vaultRootsOf` 纯函数）单元测试 —— 2026-09-24
 *
 *  需求（用户）：**打开的文件路径若在知识库中，就用知识库专用 editorpane 打开 `.md`**。
 *  「在库内」的目录集合由 `vaultRootsOf` 从 vault 清单解析：vault 根（customPath → path →
 *  kbRoot/id）＋ 关联的外部文件夹（`linkedFolders`）＋ 工作区分组目录（`linkedWorkspaces`）。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/kbVaultRoots.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import { URI } from '../../../../../base/common/uri.js';
import { vaultRootsOf } from '../../browser/knowledge/kbVaultState.js';
import { IKbVault } from '../../browser/views/knowledgeBase/kbTypes.js';

/** 造一个满足 IKbVault 的条目（测试只关心「根目录相关」字段，其余给缺省值）。 */
function vault(o: Record<string, unknown>): IKbVault {
	return { id: 'v1', name: 'v', icon: '', sort: 0, sortMode: 'name', closed: false, path: '', ...o } as unknown as IKbVault;
}

const KB_ROOT = URI.file('C:\\kb');
/** 归一成「小写 + 正斜杠」便于跨平台断言。 */
const fps = (roots: URI[]): string[] => roots.map(r => r.fsPath.replace(/\\/g, '/').toLowerCase());

suite('知识库内文件判定（vaultRootsOf）', () => {

	test('customPath（外部配置的知识库根）优先于 path', () => {
		const roots = vaultRootsOf([
			vault({ id: 'a', customPath: 'E:\\VsSarosVault', path: 'C:\\kb\\a' }),
		], KB_ROOT);
		assert.deepStrictEqual(fps(roots), ['e:/vssarosvault']);
	});

	test('无 customPath ⇒ 用 path（清单里已解析的根）', () => {
		const roots = vaultRootsOf([vault({ id: 'a', path: 'D:\\notes' })], KB_ROOT);
		assert.deepStrictEqual(fps(roots), ['d:/notes']);
	});

	test('两者皆无 ⇒ 回退默认布局 kbRoot/id', () => {
		const roots = vaultRootsOf([vault({ id: '20260922123131-abc' })], KB_ROOT);
		assert.deepStrictEqual(fps(roots), fps([URI.joinPath(KB_ROOT, '20260922123131-abc')]));
	});

	test('已关闭的库被跳过（不再算作「在库内」）', () => {
		assert.deepStrictEqual(vaultRootsOf([vault({ id: 'a', path: 'D:\\notes', closed: true })], KB_ROOT), []);
	});

	test('缺 id / null 条目被跳过（清单损坏时不抛错）', () => {
		const roots = vaultRootsOf([
			vault({ id: '' }),
			null as unknown as IKbVault,
			vault({ id: 'ok', path: 'D:\\notes' }),
		], KB_ROOT);
		assert.deepStrictEqual(fps(roots), ['d:/notes']);
	});

	test('空 / undefined 清单 ⇒ 空数组', () => {
		assert.deepStrictEqual(vaultRootsOf([], KB_ROOT), []);
		assert.deepStrictEqual(vaultRootsOf(undefined, KB_ROOT), []);
		assert.deepStrictEqual(vaultRootsOf(null, KB_ROOT), []);
	});

	test('路径两端空白被裁剪（storage 里可能带空白）', () => {
		const roots = vaultRootsOf([vault({ id: 'a', customPath: '  E:\\VsSarosVault  ' })], KB_ROOT);
		assert.deepStrictEqual(fps(roots), ['e:/vssarosvault']);
	});

	test('关联的外部文件夹（linkedFolders）计入知识库', () => {
		const roots = vaultRootsOf([
			vault({ id: 'a', path: 'D:\\notes', linkedFolders: ['E:\\shared\\docs', '  ', 'F:\\ext'] }),
		], KB_ROOT);
		assert.deepStrictEqual(fps(roots), ['d:/notes', 'e:/shared/docs', 'f:/ext']);
	});

	test('工作区分组目录（linkedWorkspaces[].folders）计入知识库', () => {
		const roots = vaultRootsOf([
			vault({
				id: 'a', path: 'D:\\notes',
				linkedWorkspaces: [{ name: 'ws', wsUri: 'file:///w.code-workspace', folders: ['G:\\proj\\one', 'G:\\proj\\two'] }],
			}),
		], KB_ROOT);
		assert.deepStrictEqual(fps(roots), ['d:/notes', 'g:/proj/one', 'g:/proj/two']);
	});

	test('多库：按清单顺序逐个输出（顺序稳定，便于诊断日志对照）', () => {
		const roots = vaultRootsOf([
			vault({ id: 'a', path: 'D:\\one' }),
			vault({ id: 'b', path: 'D:\\two', linkedFolders: ['D:\\two-ext'] }),
		], KB_ROOT);
		assert.deepStrictEqual(fps(roots), ['d:/one', 'd:/two', 'd:/two-ext']);
	});
});
