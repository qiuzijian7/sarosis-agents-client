/*---------------------------------------------------------------------------------------------
 *  KbTreeDragAndDrop 拖拽移动单元测试
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IDragAndDropData } from '../../../../../base/browser/dnd.js';
import { KbTreeDragAndDrop } from '../../browser/views/knowledgeBase/kbTreeViewer.js';
import type { IKbNode, KbSection } from '../../browser/views/knowledgeBase/kbTypes.js';

/** 最小 fileService mock：仅实现 DnD 用到的 exists / move */
class MiniFs {
	private files = new Set<string>();
	moved: { from: string; to: string }[] = [];
	exists(uri: URI): Promise<boolean> { return Promise.resolve(this.files.has(uri.toString())); }
	async move(source: URI, target: URI): Promise<void> {
		this.files.delete(source.toString());
		this.moved.push({ from: source.toString(), to: target.toString() });
	}
	add(uri: URI): void { this.files.add(uri.toString()); }
	asIFileService(): any { return this; }
}

function node(uriStr: string, isDirectory = false): IKbNode {
	const uri = URI.parse(uriStr);
	return { kind: 'node', uri, name: uri.path.split('/').pop() ?? 'x', isDirectory, section: 'library', path: uriStr, status: undefined } as IKbNode;
}
function section(s: KbSection): any { return { kind: 'section', section: s, label: s }; }
function dndData(...nodes: IKbNode[]): IDragAndDropData { return { getData: () => nodes } as IDragAndDropData; }

function sectionUri(s: KbSection): URI {
	return URI.file(s === 'library' ? '/vault/库' : s === 'notes' ? '/vault/笔记' : '/vault/.review');
}
const EV = {} as DragEvent;

suite('AgentStudio - KbTreeDragAndDrop 拖拽移动', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function makeDnd(fs: MiniFs = new MiniFs()): { dnd: KbTreeDragAndDrop; fs: MiniFs } {
		const dnd = new KbTreeDragAndDrop(fs.asIFileService(), sectionUri, () => undefined);
		return { dnd, fs };
	}

	test('drop 到目录 → 移入该目录', async () => {
		const fs = new MiniFs();
		fs.add(URI.file('/vault/库/A.md'));
		const { dnd } = makeDnd(fs);
		await dnd.drop(dndData(node('file:///vault/%E5%BA%93/A.md')), node('file:///vault/%E5%BA%93/sub', true), undefined, undefined, EV);
		assert.strictEqual(fs.moved.length, 1);
		assert.ok(fs.moved[0].to.endsWith('/sub/A.md'), '目标路径应落在子目录内：' + fs.moved[0].to);
	});

	test('drop 到分区根 → 移入该分区根目录', async () => {
		const fs = new MiniFs();
		fs.add(URI.file('/vault/库/A.md'));
		const { dnd } = makeDnd(fs);
		await dnd.drop(dndData(node('file:///vault/%E5%BA%93/A.md')), section('notes'), undefined, undefined, EV);
		assert.strictEqual(fs.moved.length, 1);
		assert.ok(decodeURIComponent(fs.moved[0].to).endsWith('/笔记/A.md'), '应移入目标分区根：' + fs.moved[0].to);
	});

	test('drop 到自身所在目录 → 无操作', async () => {
		const fs = new MiniFs();
		fs.add(URI.file('/vault/库/sub/A.md'));
		const { dnd } = makeDnd(fs);
		await dnd.drop(dndData(node('file:///vault/%E5%BA%93/sub/A.md')), node('file:///vault/%E5%BA%93/sub', true), undefined, undefined, EV);
		assert.strictEqual(fs.moved.length, 0, '已在目标目录，不应移动');
	});

	test('drop 文件夹到其子孙目录 → 拒绝（无操作）', async () => {
		const fs = new MiniFs();
		fs.add(URI.file('/vault/库/parent'));
		const { dnd } = makeDnd(fs);
		await dnd.drop(dndData(node('file:///vault/%E5%BA%93/parent', true)), node('file:///vault/%E5%BA%93/parent/child', true), undefined, undefined, EV);
		assert.strictEqual(fs.moved.length, 0, '禁止移动到子孙目录');
	});

	test('onDragOver：目录/分区接受，文件拒绝，自身/子孙拒绝', () => {
		const { dnd } = makeDnd();
		const dragNode = node('file:///vault/%E5%BA%93/A.md');
		assert.ok(dnd.onDragOver(dndData(dragNode), node('file:///vault/%E5%BA%93/sub', true), undefined, undefined, EV), '目录应接受');
		assert.ok(dnd.onDragOver(dndData(dragNode), section('library'), undefined, undefined, EV), '分区应接受');
		assert.strictEqual(dnd.onDragOver(dndData(dragNode), node('file:///vault/%E5%BA%93/B.md'), undefined, undefined, EV), false, '文件目标应拒绝');
		assert.strictEqual(dnd.onDragOver(dndData(node('file:///vault/%E5%BA%93/sub/A.md')), node('file:///vault/%E5%BA%93/sub', true), undefined, undefined, EV), false, '自身目录应拒绝');
		assert.strictEqual(dnd.onDragOver(dndData(node('file:///vault/%E5%BA%93/parent', true)), node('file:///vault/%E5%BA%93/parent/child', true), undefined, undefined, EV), false, '子孙目录应拒绝');
	});

	test('getDragURI：分区返回 null（不可拖拽），文件返回 uri', () => {
		const { dnd } = makeDnd();
		assert.strictEqual(dnd.getDragURI(section('library')), null);
		assert.ok(dnd.getDragURI(node('file:///vault/%E5%BA%93/A.md')), '文件应返回 uri');
	});
});
