/*---------------------------------------------------------------------------------------------
 *  P1 同义归一（kbAliases）单元测试（纯函数）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { canonicalizeTitle, normalizeAliasKey, KB_ALIASES_FILE } from '../../browser/knowledge/kbAliases.js';

const aliases = { aliases: { '垃圾回收': ['GC机制', 'GC', 'GarbageCollection'] } };

suite('AgentStudio - kbAliases 同义归一', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizeAliasKey：小写 + 去空白/连字符/标点', () => {
		assert.strictEqual(normalizeAliasKey('GC 机制'), 'gc机制');
		assert.strictEqual(normalizeAliasKey('Garbage-Collection'), 'garbagecollection');
		assert.strictEqual(normalizeAliasKey(' 垃圾回收 '), '垃圾回收');
	});

	test('canonicalizeTitle：同义词归一到 canonical', () => {
		assert.strictEqual(canonicalizeTitle('GC 机制', aliases), '垃圾回收');
		assert.strictEqual(canonicalizeTitle('GC', aliases), '垃圾回收');
		assert.strictEqual(canonicalizeTitle('GarbageCollection', aliases), '垃圾回收');
	});

	test('canonicalizeTitle：canonical 自身保持稳定', () => {
		assert.strictEqual(canonicalizeTitle('垃圾回收', aliases), '垃圾回收');
	});

	test('canonicalizeTitle：无别名时以自身归一形式作 canonical', () => {
		assert.strictEqual(canonicalizeTitle('内存泄漏', aliases), '内存泄漏');
		assert.strictEqual(canonicalizeTitle('GC 机制', { aliases: {} }), 'gc机制');
	});

	test('canonicalizeTitle：空标题返回空', () => {
		assert.strictEqual(canonicalizeTitle('   ', aliases), '');
	});

	test('KB_ALIASES_FILE 默认文件名', () => {
		assert.strictEqual(KB_ALIASES_FILE, 'aliases.json');
	});
});
