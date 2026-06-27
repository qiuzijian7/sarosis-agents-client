/*---------------------------------------------------------------------------------------------
 *  DedupManager 单元测试
 *--------------------------------------------------------------------------------------------*/
import { DedupManager } from '../dedup.js';
import { describe, itAsync, assert, assertEqual } from './testRunner.js';

export function runDedupTests(): void {
describe('DedupManager', () => {
	itAsync('first content is not duplicate', async () => {
		const dm = new DedupManager();
		const isDup = await dm.isDuplicate('hello world');
		assert(!isDup, 'first check not duplicate');
		assertEqual(dm.size, 1, 'size is 1');
	});

	itAsync('same content is duplicate', async () => {
		const dm = new DedupManager();
		await dm.isDuplicate('test content');
		const isDup = await dm.isDuplicate('test content');
		assert(isDup, 'second check is duplicate');
	});

	itAsync('different content is not duplicate', async () => {
		const dm = new DedupManager();
		await dm.isDuplicate('content A');
		const isDup = await dm.isDuplicate('content B');
		assert(!isDup, 'different content not duplicate');
		assertEqual(dm.size, 2, 'size is 2');
	});

	itAsync('expired entries are cleaned', async () => {
		const dm = new DedupManager(50); // 50ms window
		await dm.isDuplicate('temp content');
		assertEqual(dm.size, 1, 'entry exists');
		await new Promise(r => setTimeout(r, 100));
		const isDup = await dm.isDuplicate('temp content');
		assert(!isDup, 'expired entry not duplicate');
	});

	itAsync('clear removes all entries', async () => {
		const dm = new DedupManager();
		await dm.isDuplicate('a');
		await dm.isDuplicate('b');
		dm.clear();
		assertEqual(dm.size, 0, 'cleared');
		// After clear, same content should not be duplicate
		const isDup = await dm.isDuplicate('a');
		assert(!isDup, 'not duplicate after clear');
	});

	itAsync('handles large content', async () => {
		const dm = new DedupManager();
		const large = 'x'.repeat(100000);
		const isDup = await dm.isDuplicate(large);
		assert(!isDup, 'large content handled');
		const isDup2 = await dm.isDuplicate(large);
		assert(isDup2, 'large content dedup works');
	});

	itAsync('unicode content dedup', async () => {
		const dm = new DedupManager();
		const unicode = '你好世界 🌍 θ λ ñ ü';
		await dm.isDuplicate(unicode);
		const isDup = await dm.isDuplicate(unicode);
		assert(isDup, 'unicode dedup works');
	});
});
}
