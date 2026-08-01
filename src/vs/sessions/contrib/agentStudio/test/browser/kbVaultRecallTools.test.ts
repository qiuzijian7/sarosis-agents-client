/*---------------------------------------------------------------------------------------------
 *  kbVaultRecallTools 单元测试 —— 系统 B 的 `kb_search` 工具。
 *
 *  只断言确定性契约（是否调用了哪条通道、URI 去重、降级路径、参数裁剪），
 *  不断言语义排名顺序（依赖真实 embedding，非确定性）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { registerKbVaultRecallTools } from '../../browser/providers/tool/kbVaultRecallTools.js';

type ToolResult = { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> };

interface IFakeKernelOptions {
	hasVault?: boolean;
	vectorBuilt?: boolean;
	fulltext?: Array<{ uri: string; title: string; snippet: string; score: number }>;
	vector?: Array<{ docId: string; docName: string; text: string; score: number }>;
	fulltextThrows?: boolean;
	vectorThrows?: boolean;
}

class FakeKernel {
	calls: string[] = [];
	constructor(private readonly o: IFakeKernelOptions) { }
	hasActiveVault(): boolean { return this.o.hasVault !== false; }
	getVectorStatus(): { built: boolean } { return { built: this.o.vectorBuilt === true }; }
	async searchFulltext(_q: string, _limit: number): Promise<unknown[]> {
		this.calls.push('fulltext');
		if (this.o.fulltextThrows) { throw new Error('boom-fulltext'); }
		return this.o.fulltext ?? [];
	}
	async searchVector(_q: string, _limit: number): Promise<unknown[]> {
		this.calls.push('vector');
		if (this.o.vectorThrows) { throw new Error('boom-vector'); }
		return this.o.vector ?? [];
	}
}

/** 注册工具并返回 { handler, definition, kernel }。 */
function setup(o: IFakeKernelOptions) {
	const kernel = new FakeKernel(o);
	const warnings: string[] = [];
	let captured: any;
	registerKbVaultRecallTools({
		register: (reg: any) => { captured = reg; return { dispose(): void { } }; },
		kernelService: kernel as any,
		logService: { warn: (m: string) => { warnings.push(m); } },
	});
	assert.ok(captured, 'kb_search 未被注册');
	return {
		kernel,
		warnings,
		definition: captured.definition,
		run: (args: Record<string, unknown>): Promise<ToolResult | Array<{ type: string; text?: string }>> =>
			captured.handler(args),
	};
}

function textOf(res: ToolResult | Array<{ type: string; text?: string }>): string {
	const arr = Array.isArray(res) ? res : res.content;
	return arr.map(c => c.text ?? '').join('\n');
}

function detailsOf(res: ToolResult | Array<{ type: string; text?: string }>): Record<string, unknown> | undefined {
	return Array.isArray(res) ? undefined : res.details;
}

const FT = (n: number) => Array.from({ length: n }, (_, i) => ({
	uri: `file:///vault/ft-${i}.md`, title: `FT ${i}`, snippet: `fulltext body ${i}`, score: 1 - i * 0.01,
}));

const VEC = (n: number) => Array.from({ length: n }, (_, i) => ({
	docId: `file:///vault/vec-${i}.md`, docName: `VEC ${i}`, text: `semantic body ${i}`, score: 0.9 - i * 0.01,
}));

suite('AgentStudio - kbVaultRecallTools (kb_search)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('工具定义：名称 / category / required 参数', () => {
		const { definition } = setup({});
		assert.strictEqual(definition.name, 'kb_search');
		assert.strictEqual(definition.category, 'knowledge');
		assert.deepStrictEqual(definition.inputSchema.required, ['query']);
		assert.ok(definition.inputSchema.properties.mode.enum.includes('hybrid'));
	});

	test('空 query 直接返回提示，不触碰内核', async () => {
		const t = setup({});
		const res = await t.run({ query: '   ' });
		assert.match(textOf(res), /query/);
		assert.deepStrictEqual(t.kernel.calls, []);
	});

	test('无激活 Vault 时返回引导文本而非抛错', async () => {
		const t = setup({ hasVault: false, fulltext: FT(3) });
		const res = await t.run({ query: 'x' });
		assert.match(textOf(res), /没有已打开的知识库/);
		assert.deepStrictEqual(t.kernel.calls, [], '无 vault 时不应发起检索');
	});

	test('mode=fulltext 只走 BM25 通道', async () => {
		const t = setup({ fulltext: FT(2), vectorBuilt: true, vector: VEC(2) });
		const res = await t.run({ query: 'x', mode: 'fulltext' });
		assert.deepStrictEqual(t.kernel.calls, ['fulltext']);
		assert.strictEqual(detailsOf(res)?.mode, 'fulltext');
		assert.strictEqual(detailsOf(res)?.count, 2);
	});

	test('hybrid + 向量索引未构建 → 只出全文结果，不调 searchVector', async () => {
		const t = setup({ fulltext: FT(3), vectorBuilt: false });
		const res = await t.run({ query: 'x' });
		assert.deepStrictEqual(t.kernel.calls, ['fulltext']);
		const hits = detailsOf(res)?.hits as Array<{ source: string }>;
		assert.strictEqual(hits.length, 3);
		assert.ok(hits.every(h => h.source === 'fulltext'));
	});

	test('mode=semantic 但向量未构建 → 明确提示，不静默返回空', async () => {
		const t = setup({ vectorBuilt: false, fulltext: FT(3) });
		const res = await t.run({ query: 'x', mode: 'semantic' });
		assert.deepStrictEqual(t.kernel.calls, [], 'semantic 模式不应回落到全文通道');
		assert.match(textOf(res), /语义索引尚未构建/);
	});

	test('hybrid 融合：同 URI 只出现一次', async () => {
		const shared = 'file:///vault/same.md';
		const t = setup({
			vectorBuilt: true,
			fulltext: [
				{ uri: shared, title: 'Same', snippet: 'ft', score: 0.8 },
				{ uri: 'file:///vault/a.md', title: 'A', snippet: 'ft-a', score: 0.7 },
			],
			vector: [
				{ docId: shared, docName: 'Same', text: 'semantic longer body', score: 0.95 },
				{ docId: 'file:///vault/b.md', docName: 'B', text: 'vec-b', score: 0.6 },
			],
		});
		const res = await t.run({ query: 'x' });
		const hits = detailsOf(res)?.hits as Array<{ uri: string; snippet: string }>;
		assert.strictEqual(hits.length, 3, '2+2 命中、1 条重合 → 3 条');
		assert.strictEqual(new Set(hits.map(h => h.uri)).size, 3);
		const same = hits.find(h => h.uri === shared)!;
		assert.strictEqual(same.snippet, 'semantic longer body', '重合命中应保留更完整的语义片段');
	});

	test('hybrid 下向量通道抛错 → 降级为全文结果并附说明', async () => {
		const t = setup({ vectorBuilt: true, vectorThrows: true, fulltext: FT(2) });
		const res = await t.run({ query: 'x' });
		assert.deepStrictEqual(t.kernel.calls, ['fulltext', 'vector']);
		assert.strictEqual(detailsOf(res)?.count, 2);
		assert.match(textOf(res), /语义检索失败/);
		assert.strictEqual(t.warnings.length, 1);
	});

	test('hybrid 下全文通道抛错 → 仍返回语义结果', async () => {
		const t = setup({ vectorBuilt: true, fulltextThrows: true, vector: VEC(2) });
		const res = await t.run({ query: 'x' });
		assert.strictEqual(detailsOf(res)?.count, 2);
		assert.match(textOf(res), /全文检索失败/);
	});

	test('limit 归一化：非法值回落默认、超上限裁剪到 50', async () => {
		const t = setup({ fulltext: FT(60) });
		const bad = await t.run({ query: 'x', limit: -3 });
		assert.strictEqual(detailsOf(bad)?.count, 10);
		const big = await t.run({ query: 'x', limit: 999 });
		assert.strictEqual(detailsOf(big)?.count, 50);
	});

	test('非法 mode 回落 hybrid', async () => {
		const t = setup({ fulltext: FT(1), vectorBuilt: false });
		const res = await t.run({ query: 'x', mode: 'nonsense' });
		assert.strictEqual(detailsOf(res)?.mode, 'hybrid');
	});

	test('零命中返回可执行引导，而非空字符串', async () => {
		const t = setup({ fulltext: [], vectorBuilt: false });
		const res = await t.run({ query: 'zzz' });
		assert.strictEqual(detailsOf(res), undefined);
		assert.match(textOf(res), /未找到与「zzz」相关的内容/);
		assert.match(textOf(res), /search_files/);
	});
});
