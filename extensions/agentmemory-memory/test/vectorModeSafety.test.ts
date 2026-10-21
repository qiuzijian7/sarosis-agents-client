/*---------------------------------------------------------------------------------------------
 *  vectorModeSafety.test.ts — 向量索引的语义空间不许被增量写入打乱（2026-10-20）
 *
 *  背景（代码评估 P0-3）：旧 `VectorIndex.addText` 第一行是 `this._mode = 'trigram'`，而网关
 *  每次 `mem:memories` 写入都调它 ⇒ 一个已恢复为 model（真语义）的分区，只要写一条记忆：
 *    ① 一条 trigram 伪向量混进 model 空间；② **查询向量**也被切成 trigram ⇒
 *    整个分区的向量通道得分失去意义（直到下次重启全量重建）。
 *  这里钉住：model 模式下 addText 不写、不切 mode、返回 false（让调用方排队补 model 向量）；
 *  trigram 模式行为与改动前一致；只有 `resetToTrigram()`（整份重来）能把 mode 切回 trigram。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VectorIndex } from '../src/vectorIndex.js';

const modelVec = (seed: number): Float32Array => {
	const v = new Float32Array(384);
	for (let i = 0; i < v.length; i++) { v[i] = Math.sin(seed * 31 + i); }
	let n = 0;
	for (let i = 0; i < v.length; i++) { n += v[i] * v[i]; }
	n = Math.sqrt(n);
	for (let i = 0; i < v.length; i++) { v[i] /= n; }
	return v;
};

suite('向量 mode 安全（P0-3，2026-10-20）', () => {
	test('★ model 模式下 addText：不写伪向量、不切 mode、返回 false', () => {
		const vi = new VectorIndex();
		vi.addModelVector('m1', modelVec(1));
		vi.addModelVector('m2', modelVec(2));
		const wrote = vi.addText('new-1', '新写入的一条记忆');
		assert.strictEqual(wrote, false, '应提示调用方补 model 向量');
		assert.strictEqual(vi.mode, 'model', 'mode 不得被增量写入切回 trigram');
		assert.strictEqual(vi.size, 2, '不得混入 trigram 伪向量');
		assert.strictEqual(vi.has('new-1'), false);
	});

	test('★ model 模式下改写已有 id：保留原 model 向量（不重算、不降级）', () => {
		const vi = new VectorIndex();
		const original = modelVec(7);
		vi.addModelVector('keep', original);
		vi.addText('keep', '同一 id 的改写（strength/access 字段变化）');
		const exported = vi.exportVectors().find(e => e.id === 'keep');
		assert.ok(exported, '向量仍在');
		assert.strictEqual(exported!.vector[0], original[0], '仍是原来的 model 向量');
	});

	test('trigram 模式行为不变：写入、返回 true、mode 仍为 trigram', () => {
		const vi = new VectorIndex();
		assert.strictEqual(vi.addText('t1', 'alpha beta gamma'), true);
		assert.strictEqual(vi.mode, 'trigram');
		assert.strictEqual(vi.size, 1);
		assert.strictEqual(vi.has('t1'), true);
	});

	test('resetToTrigram：清空并切回 trigram（只有整份重来才允许）', () => {
		const vi = new VectorIndex();
		vi.addModelVector('m1', modelVec(3));
		vi.resetToTrigram();
		assert.strictEqual(vi.mode, 'trigram');
		assert.strictEqual(vi.size, 0);
		assert.strictEqual(vi.addText('t', 'after reset'), true);
		assert.strictEqual(vi.size, 1);
	});

	test('model 模式检索：查询走 model 分支（增量写入后 mode 仍为 model）', () => {
		const vi = new VectorIndex();
		vi.addModelVector('m1', modelVec(4));
		vi.addText('x', 'any');
		assert.strictEqual(vi.mode, 'model');
	});
});
