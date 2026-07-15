/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  binaryVectorStore.test.ts — .kvindex 紧凑二进制序列化单元测试（无联网）。
 *
 *  覆盖 serializeVectorIndexBinary / deserializeVectorIndexBinary：
 *   1. 往返（round-trip）：多块、多 tag、roots、向量（Float32 有损精度用容差）、文本、维度。
 *   2. 向量维度对齐：块向量短于 dimensions 时补 0；为空时补齐为 dimensions 长度的零向量。
 *   3. tag 去重表：相同 tag 多块共享、不同 tag 各自保留。
 *   4. 魔数 "KVID" 校验；版本不符 / 魔数不符 / 截断 / 空输入 → 返回 null。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { serializeVectorIndexBinary, deserializeVectorIndexBinary } from './binaryVectorStore.js';
import type { IKbVectorChunk, IKbVectorIndexData } from './kbVectorIndex.js';
import type { KbSection } from './kbTypes.js';

const SECTION: KbSection = 'notes';

function approxArray(a: number[], b: number[], eps = 1e-5): void {
	assert.strictEqual(a.length, b.length, `长度应一致：${a.length} vs ${b.length}`);
	for (let i = 0; i < a.length; i++) {
		assert.ok(Math.abs(a[i] - b[i]) < eps, `元素[${i}] ${a[i]} ≈ ${b[i]}`);
	}
}

function makeData(): IKbVectorIndexData {
	return {
		v: 1,
		tag: 'openai/text-embedding-3-small@512',
		dimensions: 3,
		builtAt: 1700000000000,
		roots: [
			{ uri: 'file:///vault/notes', section: SECTION },
			{ uri: 'file:///vault/lib', section: 'library' },
		],
		chunks: [
			{
				id: 'file:///vault/notes/a.md#0',
				docId: 'file:///vault/notes/a.md',
				docName: 'a.md',
				section: SECTION,
				text: 'hello world',
				vector: [0.1, 0.2, 0.3],
				tag: 'openai/text-embedding-3-small@512',
				start: 0,
			},
			{
				id: 'file:///vault/notes/b.md#12',
				docId: 'file:///vault/notes/b.md',
				docName: 'b.md',
				section: SECTION,
				text: 'another chunk with 中文',
				vector: [-0.5, 0.0, 1.25],
				tag: 'openai/text-embedding-3-small@512',
				start: 12,
			},
			{
				id: 'file:///vault/lib/c.md#5',
				docId: 'file:///vault/lib/c.md',
				docName: 'c.md',
				section: 'library',
				text: 'different provider chunk',
				vector: [0.9, -0.9, 0.0],
				tag: 'local/Xenova-all-MiniLM-L6-v2@384',
				start: 5,
			},
		],
	};
}

describe('binaryVectorStore', () => {

	describe('round-trip', () => {
		it('多块/多 tag/roots 往返无损（向量容差）', () => {
			const data = makeData();
			const bin = serializeVectorIndexBinary(data);
			assert.ok(bin instanceof Uint8Array);

			const out = deserializeVectorIndexBinary(bin);
			assert.ok(out, '应成功反序列化');
			assert.strictEqual(out!.v, 1);
			assert.strictEqual(out!.dimensions, data.dimensions);
			assert.strictEqual(out!.tag, data.tag);
			assert.strictEqual(out!.builtAt, data.builtAt);
			assert.strictEqual(out!.roots.length, data.roots.length);
			assert.strictEqual(out!.roots[0].uri, data.roots[0].uri);
			assert.strictEqual(out!.roots[1].section, 'library');
			assert.strictEqual(out!.chunks.length, data.chunks.length);

			for (let i = 0; i < data.chunks.length; i++) {
				const a = data.chunks[i];
				const b: IKbVectorChunk = out!.chunks[i];
				assert.strictEqual(b.id, a.id);
				assert.strictEqual(b.docId, a.docId);
				assert.strictEqual(b.docName, a.docName);
				assert.strictEqual(b.section, a.section);
				assert.strictEqual(b.text, a.text);
				assert.strictEqual(b.tag, a.tag);
				assert.strictEqual(b.start, a.start);
				approxArray(b.vector, a.vector);
			}
		});

		it('块向量短于 dimensions 时补齐为 0', () => {
			const data = makeData();
			data.dimensions = 4;
			data.chunks[0].vector = [0.5]; // 仅 1 维，应补齐到 4 维
			const out = deserializeVectorIndexBinary(serializeVectorIndexBinary(data));
			assert.ok(out);
			assert.strictEqual(out!.chunks[0].vector.length, 4);
			approxArray(out!.chunks[0].vector, [0.5, 0, 0, 0]);
		});

		it('块向量为空时恢复为 dimensions 长度零向量', () => {
			const data = makeData();
			data.dimensions = 3;
			data.chunks[0].vector = [];
			const out = deserializeVectorIndexBinary(serializeVectorIndexBinary(data));
			assert.ok(out);
			assert.deepStrictEqual(out!.chunks[0].vector, [0, 0, 0]);
		});

		it('空 chunks 仍可往返（仅 header/roots）', () => {
			const data: IKbVectorIndexData = {
				v: 1, tag: '', dimensions: 0, builtAt: 1, roots: [], chunks: [],
			};
			const out = deserializeVectorIndexBinary(serializeVectorIndexBinary(data));
			assert.ok(out);
			assert.strictEqual(out!.chunks.length, 0);
			assert.strictEqual(out!.dimensions, 0);
		});
	});

	describe('tag 去重表', () => {
		it('多块共享 tag 与不同 tag 均正确还原', () => {
			const data = makeData();
			const out = deserializeVectorIndexBinary(serializeVectorIndexBinary(data));
			assert.ok(out);
			// 同 tag
			assert.strictEqual(out!.chunks[0].tag, 'openai/text-embedding-3-small@512');
			assert.strictEqual(out!.chunks[1].tag, 'openai/text-embedding-3-small@512');
			// 异 tag
			assert.strictEqual(out!.chunks[2].tag, 'local/Xenova-all-MiniLM-L6-v2@384');
		});

		it('所有块 tag 与索引级 tag 不一致时仍按块 tag 还原', () => {
			const data = makeData();
			data.tag = 'some-index-level-tag';
			data.chunks.forEach(c => { c.tag = 'per-chunk-tag'; });
			const out = deserializeVectorIndexBinary(serializeVectorIndexBinary(data));
			assert.ok(out);
			assert.strictEqual(out!.tag, 'some-index-level-tag');
			assert.ok(out!.chunks.every(c => c.tag === 'per-chunk-tag'));
		});
	});

	describe('校验与容错', () => {
		it('输出前 4 字节为魔数 "KVID"（小端存储）', () => {
			const bin = serializeVectorIndexBinary(makeData());
			// w.u32(MAGIC=0x4b564944) → setUint32(...,true) 小端序
			// → 内存中: [0x44(D), 0x49(I), 0x56(V), 0x4b(K)]
			assert.strictEqual(bin[0], 0x44); // D
			assert.strictEqual(bin[1], 0x49); // I
			assert.strictEqual(bin[2], 0x56); // V
			assert.strictEqual(bin[3], 0x4b); // K
		});

		it('版本不符返回 null', () => {
			const bin = serializeVectorIndexBinary(makeData());
			const bad = bin.slice();
			bad[4] = 99; bad[5] = 0; // version u16 改为 99
			assert.strictEqual(deserializeVectorIndexBinary(bad), null);
		});

		it('魔数不符返回 null', () => {
			const bin = serializeVectorIndexBinary(makeData());
			const bad = bin.slice();
			bad[0] = 0x00; bad[1] = 0x00; bad[2] = 0x00; bad[3] = 0x00;
			assert.strictEqual(deserializeVectorIndexBinary(bad), null);
		});

		it('截断 / 空输入返回 null', () => {
			const bin = serializeVectorIndexBinary(makeData());
			assert.strictEqual(deserializeVectorIndexBinary(bin.subarray(0, 10)), null);
			assert.strictEqual(deserializeVectorIndexBinary(new Uint8Array(0)), null);
		});
	});
});
