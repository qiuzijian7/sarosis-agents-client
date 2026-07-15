/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License.
 *
 *  tokenEmbedder.test.ts — token 级切块 + 均值池化单元测试（无联网）。
 *
 *  覆盖：
 *   1. estimateTokens — 字符级近似（ASCII ~4 字符/token，CJK 更保守）。
 *   2. splitByTokens — 不超限原样返回；超限切分为多段（边界回退到空白）。
 *   3. embedWithPooling — 输出与输入同长度同序；空白回填零向量；超长文本做
 *      running-mean 聚合（与手工子段均值一致）。
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { estimateTokens, splitByTokens, embedWithPooling } from './tokenEmbedder.js';

describe('tokenEmbedder', () => {

	describe('estimateTokens', () => {
		it('空文本为 0', () => {
			assert.strictEqual(estimateTokens(''), 0);
			assert.strictEqual(estimateTokens('   '), 0);
		});

		it('ASCII 约 4 字符/token', () => {
			const ascii = 'a'.repeat(400);
			assert.strictEqual(estimateTokens(ascii), Math.ceil(400 / 4));
		});

		it('CJK 按 ~1.6 字符/token 折算', () => {
			const cjk = '中'.repeat(16);
			assert.strictEqual(estimateTokens(cjk), Math.ceil(16 / 1.6));
		});

		it('混合文本取两种估算的较大值', () => {
			const mixed = 'a'.repeat(400) + '中'.repeat(16);
			// 与内部实现一致：max(ceil(416/4), ceil(400/4)+ceil(16/1.6))
			const expected = Math.max(Math.ceil(416 / 4), Math.ceil(400 / 4) + Math.ceil(16 / 1.6));
			assert.strictEqual(estimateTokens(mixed), expected);
		});
	});

	describe('splitByTokens', () => {
		it('不超限文本原样返回单段', () => {
			const t = 'hello world '.repeat(10);
			assert.deepStrictEqual(splitByTokens(t, 8191), [t]);
		});

		it('超限文本切分为多段且每段显著更短', () => {
			const t = 'a'.repeat(40000);
			const parts = splitByTokens(t, 8191);
			assert.ok(parts.length >= 2, '应被切成多段');
			for (const p of parts) {
				assert.ok(p.length < 40000, '每段应远短于原文');
			}
			// 拼接（无重叠）应覆盖原文绝大部分。
			assert.ok(parts.join('').length >= 40000 - 2000);
		});

		it('含空白边界时不在词内硬切', () => {
			// 构造一个刚好超限、且窗口尾部落在词中间的文本，验证回退到空白边界。
			const t = 'token '.repeat(12000);   // 约 72000 字符，远超上限
			const parts = splitByTokens(t, 8191);
			assert.ok(parts.length >= 2);
			for (const p of parts) {
				assert.ok(p.endsWith('token ') || p.endsWith('token'), '段尾应落在词边界');
			}
		});

		it('空文本返回空数组', () => {
			assert.deepStrictEqual(splitByTokens('', 8191), []);
		});
	});

	describe('embedWithPooling', () => {
		it('输出长度与输入对齐，且空白文本回填零向量', async () => {
			const dim = 3;
			const embedFn = async (texts: string[]): Promise<number[][]> =>
				texts.map(t => [t.length % dim, (t.length % 7), (t.length % 5)]);
			const out = await embedWithPooling(embedFn, ['abc', '', 'defg'], { maxTokens: 8191 });
			assert.strictEqual(out.length, 3);
			// 非空白文本：向量与直接 embed 一致（未触发切分）。
			assert.deepStrictEqual(out[0], [0, 3, 3]);
			// 空白文本：零向量（维度由首个非空向量探测）。
			assert.deepStrictEqual(out[1], [0, 0, 0]);
			assert.deepStrictEqual(out[2], [1, 4, 4]);
		});

		it('超长文本做均值池化（与子段均值一致）', async () => {
			const embedFn = async (texts: string[]): Promise<number[][]> =>
				texts.map(t => [t.length]);
			const long = 'a'.repeat(40000);
			const pooled = (await embedWithPooling(embedFn, [long], { maxTokens: 8191, maxBatchSize: 64 }))[0];
			// 手工按相同方式切块并求均值，验证 running-mean 聚合正确。
			const parts = splitByTokens(long, 8191);
			const sub = await embedFn(parts);
			const expected = sub.reduce((s, v) => s + v[0], 0) / sub.length;
			assert.ok(Math.abs(pooled[0] - expected) < 1e-6, `pooled=${pooled[0]} expected=${expected}`);
		});

		it('分批调用（maxBatchSize）仍保持顺序与对齐', async () => {
			const calls: number[][] = [];
			const embedFn = async (texts: string[]): Promise<number[][]> => {
				calls.push(texts.map(t => t.length));
				return texts.map(t => [t.length]);
			};
			const texts = Array.from({ length: 10 }, (_, i) => 'x'.repeat(i + 1));
			const out = await embedWithPooling(embedFn, texts, { maxTokens: 8191, maxBatchSize: 3 });
			assert.strictEqual(out.length, texts.length);
			for (let i = 0; i < texts.length; i++) {
				assert.deepStrictEqual(out[i], [texts[i].length]);
			}
			// 分批次数 = ceil(10/3) = 4
			assert.strictEqual(calls.length, 4);
			// 每段长度序列应与原始文本长度序列一致（按批拼接后等于原序列）。
			const flat = calls.flat();
			assert.deepStrictEqual(flat, texts.map(t => t.length));
		});

		it('全部为空白文本时返回与输入等长的零向量数组', async () => {
			const embedFn = async (texts: string[]): Promise<number[][]> =>
				texts.map(t => [t.length]);
			const out = await embedWithPooling(embedFn, ['', '  ', '\n'], { maxTokens: 8191 });
			assert.strictEqual(out.length, 3);
			for (const v of out) {
				assert.deepStrictEqual(v, []);
			}
		});

		it('overlapTokens 仅影响切块重叠，不改变输出长度对齐与确定性', async () => {
			const embedFn = async (texts: string[]): Promise<number[][]> =>
				texts.map(t => [t.length / 10]);
			const long = 'a'.repeat(40000);
			// 不开重叠
			const pooled0 = (await embedWithPooling(embedFn, [long], { maxTokens: 8191, overlapTokens: 0 }))[0];
			// 开启重叠（子块重叠，但聚合后仍应落在原文粒度 = 1 个向量）
			const pooled1 = (await embedWithPooling(embedFn, [long], { maxTokens: 8191, overlapTokens: 50 }))[0];
			assert.strictEqual(pooled0.length, 1);
			assert.strictEqual(pooled1.length, 1);
			// 重叠会改变均值（更多子段参与），但必须是一个有限数值且不抛错。
			assert.ok(Number.isFinite(pooled1[0]));
			// 确定性：同参数两次应一致。
			const again = (await embedWithPooling(embedFn, [long], { maxTokens: 8191, overlapTokens: 50 }))[0];
			assert.strictEqual(pooled1[0], again[0]);
		});

		it('子向量维度不一致（变长）仍安全聚合不抛错', async () => {
			// 模拟超长文本被 splitByTokens 切分后，各子段按自身长度返回不同维向量。
			const embedFn = async (texts: string[]): Promise<number[][]> =>
				texts.map(t => Array.from({ length: t.length % 5 + 1 }, (_, i) => i + 1));
			const long = 'a'.repeat(40000);
			const out = await embedWithPooling(embedFn, [long], { maxTokens: 8191, maxBatchSize: 64 });
			assert.strictEqual(out.length, 1);
			assert.ok(Array.isArray(out[0]));
			assert.ok(out[0].every(d => Number.isFinite(d)), '聚合结果应均为有限数');
		});

		it('多输入混合：空白 + 普通 + 超长，输出与输入对齐', async () => {
			const embedFn = async (texts: string[]): Promise<number[][]> =>
				texts.map(t => [t.length, Math.round(t.length / 2)]);
			const long = 'b'.repeat(40000);
			const out = await embedWithPooling(embedFn, ['short', '', long, 'another'], { maxTokens: 8191 });
			assert.strictEqual(out.length, 4);
			// 'short'.length=5  → [5, Math.round(5/2)] = [5, 3]
			assert.deepStrictEqual(out[0], [5, 3]);
			assert.deepStrictEqual(out[1], [0, 0]); // 空白 → 零向量（dim 由首个有效向量探测）
			assert.ok(Array.isArray(out[2]) && out[2].length === 2);
			// 'another'.length=7 → [7, Math.round(7/2)] = [7, 4]
			assert.deepStrictEqual(out[3], [7, 4]);
		});
	});
});
