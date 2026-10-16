/*---------------------------------------------------------------------------------------------
 *  skill_search 的 BM25 检索（IDE 侧）—— 补上一条**此前完全没有**的覆盖。
 *
 *  2026-10-12 核查：`agentStudio/test` 下搜 `bm25|skill_search` **零命中** ✗ ⇒ 这段算法
 *  （`browser/providers/tool/skillTools.ts:16-52` 的 `bm25Score` / `tokenize`，与 179-254 的 handler）
 *  从未被任何测试碰过。
 *
 *  **为什么这张表要和 dsh 侧一模一样**：dsh 侧有一份**同口径移植**
 *  （`dsh-plugins/vssaros-skills/lib/core/skillSearch.js`，服务 dsh 的 `skill_search` 工具 ——
 *  技能检索正是"工具/技能/MCP 都归 dsh 侧"里补上的那一层）。方案 6.9 方案 C：契约共享、实现各自一份
 *  （`src/vs` 不得 import 插件包）⇒ **唯一的对齐机制就是两侧钉同一张黄金表**：
 *  本文件的期望值与 `poc/dsh-p0/scripts/p3-04-skills-plugin.mjs` 的检索那几条**逐条相同**
 *  （0.69 / 1.39 / limit 缺省 3 / `match:` 不参与检索 / 空查询要报错）。
 *
 *  ⚠ 刻意**不改生产代码**：BM25 是模块私有（未导出）⇒ 这里经 `registerSkillTools()` 注册后拿
 *  **捕获到的 handler** 驱动，测的是真实链路（而不是"把算式抄一份来测自己" ✗）。
 *
 *  两处**有意保留的行为差异**（都在下面钉住，免得以后当成 bug 查）：
 *  ① 空查询：IDE 返回 `{success:false,error:'query is required'}`（不抛）；dsh 侧 **throw**（工具错误）；
 *  ② 同分排序：IDE 用**注册顺序**（稳定排序）；dsh 侧按 **id 字典序**（扫描顺序已排序 ⇒ 实际等价）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { registerSkillTools, type SkillToolContext } from '../../browser/providers/tool/skillTools.js';
import type { IToolDescriptor } from '../../browser/providers/tool/toolRegistry.js';
import type { IToolResultContent } from '../../common/providers.js';
import type { ISkillDefinition } from '../../common/skills.js';

/** `skill_search` 返回体（只列本文件用到的字段）。 */
interface ISearchResult {
	readonly success: boolean;
	readonly query?: string;
	readonly matches: ReadonlyArray<{ skill_id: string; name: string; description: string; score: number }>;
	readonly error?: string;
	readonly message?: string;
}

/**
 * 最小 fake ctx：只提供 `skill_search` 真正用到的两个成员（`register` + `skillRegistry`）。
 * `skillManagerTool` / `logService` / `environmentService` 是**别的**工具（skill_manage / read_skill 等）
 * 的依赖 ⇒ 不提供；若哪天它们在**注册期**被读到，这里会立刻抛（那本身就是有价值的信息 ✓）。
 */
function capture(skills: readonly ISkillDefinition[]) {
	const registered: IToolDescriptor[] = [];
	const ctx = {
		register: (descriptor: IToolDescriptor) => { registered.push(descriptor); },
		skillRegistry: {
			getSkills: () => skills,
			getSkill: (id: string) => skills.find(s => s.id === id),
		},
		// ⚠ `registerSkillTools` 会在**注册期**打一行 info（`skillTools.ts:338` 的
		// "[BuiltinTools] _registerSkillTools: … registered"）⇒ fake 必须提供 `logService`。
		// 第一版没给 ⇒ 12 条**全红**、错是 "reading 'info'" ✓ —— 这正是"注册期读不到的东西就立刻抛"的价值：
		// 它把隐式依赖显式化了 ✓（比"缺日志就静默跳过"好，那种会让测试与真机行为悄悄分叉 ✗）。
		logService: { info: () => { }, warn: () => { }, error: () => { }, debug: () => { }, trace: () => { } },
	} as unknown as SkillToolContext;
	registerSkillTools(ctx);

	const tool = registered.find(r => r.definition.name === 'skill_search');
	assert.ok(tool, 'skill_search 必须被注册（一旦改名，这里就会红 ✓）');

	return {
		registered,
		/** 调一次 `skill_search`：handler 返回 `[{type:'text',text}]`，正文是 JSON 串。 */
		call: async (args: Record<string, unknown>): Promise<ISearchResult> => {
			const result = await tool!.handler(args);
			const parts: readonly IToolResultContent[] = Array.isArray(result) ? result : result.content;
			const text = parts.filter(p => p.type === 'text').map(p => p.text ?? '').join('');
			return JSON.parse(text) as ISearchResult;
		},
	};
}

function skill(id: string, description: string, extra: Partial<ISkillDefinition> = {}): ISkillDefinition {
	return {
		id,
		name: id,
		description,
		activation: 'manual',
		prompt: `# ${id}\n正文（不参与检索 ✓）`,
		source: 'user',
		enabled: true,
		...extra,
	};
}

suite('skill_search BM25 (IDE 侧 / 与 dsh 移植同口径)', () => {

	// 与 p3-04 完全同形的两个技能：`code-review`（3 个 token）与 `docs-writer`（3 个 token）⇒
	// totalDocs=2、avgDocLen=3 ⇒ 分数可**手算复核**：idf=ln((2-1+0.5)/(1+0.5)+1)=ln2≈0.6931、长度归一=1。
	const two = [skill('code-review', '代码评审清单与常见缺陷模式', { activation: 'auto' }), skill('docs-writer', '写用户文档的结构与语气指南')];

	test('★ 单关键词命中：score 0.69（与 dsh 侧 p3-04 同一个数）', async () => {
		const r = await capture(two).call({ query: 'code' });
		assert.strictEqual(r.success, true);
		assert.deepStrictEqual(r.matches.map(m => [m.skill_id, m.score]), [['code-review', 0.69]]);
	});

	test('★ 两个关键词各贡献一次 ⇒ 1.39（≈ 2×0.6931 四舍五入）', async () => {
		const r = await capture(two).call({ query: 'code review' });
		assert.deepStrictEqual(r.matches.map(m => [m.skill_id, m.score]), [['code-review', 1.39]]);
	});

	test('大小写不敏感（分词先 toLowerCase）', async () => {
		const upper = await capture(two).call({ query: 'CODE REVIEW' });
		assert.deepStrictEqual(upper.matches.map(m => m.skill_id), ['code-review']);
	});

	test('★ 只写在 frontmatter `match:` 里的词检索不到（索引只建在 name/description/id 上）', async () => {
		// `match: ['评审']` 是 auto 模式的关键词，**不**进检索索引 —— 这是与 dsh 侧一致的口径 ✓
		const withMatch = [skill('code-review', '代码评审清单与常见缺陷模式', { activation: 'auto', match: ['评审', 'review'] }), skill('docs-writer', '写用户文档的结构与语气指南')];
		const r = await capture(withMatch).call({ query: '评审' });
		assert.strictEqual(r.matches.length, 0, '`评审` 是整段中文描述的一个 token 的子串 ⇒ 不该命中');
	});

	test('中文描述整段成一个 token（逐字切、无词边界）⇒ 子串查询命中不了', async () => {
		const r = await capture(two).call({ query: '代码评审清单与常见缺陷模式' });
		assert.deepStrictEqual(r.matches.map(m => m.skill_id), ['code-review'], '整段相同则命中 ✓');
	});

	test('★ 正文（prompt）不参与检索：改 prompt 不影响结果，改 description 影响', async () => {
		const a = await capture([skill('s-one', '平台无关的描述', { prompt: 'alpha beta gamma' })]).call({ query: 'alpha' });
		assert.strictEqual(a.matches.length, 0, 'prompt 里的词不该命中 ⇒ 索引只建在 name/description/id ✓');
		const b = await capture([skill('s-one', 'alpha beta gamma')]).call({ query: 'alpha' });
		assert.deepStrictEqual(b.matches.map(m => m.skill_id), ['s-one']);
	});

	test('enabled:false 的技能被排除（handler 里的 filter 不是摆设）', async () => {
		const r = await capture([skill('off-one', 'alpha topic', { enabled: false }), skill('on-one', 'alpha topic')]).call({ query: 'alpha' });
		assert.deepStrictEqual(r.matches.map(m => m.skill_id), ['on-one']);
	});

	test('★ 空查询：返回错误对象而**不抛**（与 dsh 侧的 throw 是**有意差异**，见文件头）', async () => {
		for (const q of ['', '   ']) {
			const r = await capture(two).call({ query: q });
			assert.strictEqual(r.success, false, `query=${JSON.stringify(q)}`);
			assert.strictEqual(r.error, 'query is required');
		}
	});

	test('技能目录为空 ⇒ 成功的空结果 + 可读提示（不是错误 ✗）', async () => {
		const r = await capture([]).call({ query: 'code' });
		assert.strictEqual(r.success, true);
		assert.deepStrictEqual(r.matches, []);
		assert.strictEqual(r.message, 'No skills installed');
	});

	test('有技能但无命中 ⇒ 提示里带查询词（方便模型换词）', async () => {
		const r = await capture(two).call({ query: 'zzz-nothing' });
		assert.deepStrictEqual(r.matches, []);
		assert.ok(/No skills match/.test(String(r.message)), String(r.message));
	});

	test('★ limit：缺省 3、下限夹到 1、上限不缩小（5 个同分技能）', async () => {
		// 刻意**逆字典序**传入：IDE 用注册顺序做稳定排序 ⇒ 输出顺序 == 传入顺序 ✓
		const five = ['alpha-e', 'alpha-c', 'alpha-a', 'alpha-d', 'alpha-b'].map(id => skill(id, 'alpha topic'));
		const all = await capture(five).call({ query: 'alpha', limit: 100 });
		assert.strictEqual(all.matches.length, 5, '上限 10 不该把 5 条缩掉');
		const def = await capture(five).call({ query: 'alpha' });
		assert.deepStrictEqual(def.matches.map(m => m.skill_id), ['alpha-e', 'alpha-c', 'alpha-a'], '缺省 3 条 + 注册顺序');
		const zero = await capture(five).call({ query: 'alpha', limit: 0 });
		assert.strictEqual(zero.matches.length, 1, 'limit=0 夹到下界 1');
	});

	test('★ 文档长度归一真的生效（长短文档同命中时短的排前面）—— 这条钉住 BM25 的 b=0.75', async () => {
		// ⚠ 上面那两条（0.69 / 1.39）用的两个技能 **token 数相同**（3/3）⇒ 长度归一恒为 1 ✗
		// ⇒ 它们证明不了 `b` 参与运算。这条用**不等长**的文档把归一化钉住：
		//   A `short-doc`：name+id 给 {short, doc} + description `alpha` ⇒ 3 个 token
		//   B `long-doc` ：{long, doc} + 6 个词 ⇒ 8 个 token ⇒ avgDocLen=(3+8)/2=5.5、totalDocs=2
		//   两者都含 `alpha` ⇒ idf 相同 = ln((2-1+0.5)/(1+0.5)+1) = ln2 ≈ 0.6931
		//   A: tfNorm=2.2/(1+1.2*(0.25+0.75*3/5.5))=1.2284 ⇒ 0.8515 ⇒ 0.85
		//   B: tfNorm=2.2/(1+1.2*(0.25+0.75*8/5.5))=0.8432 ⇒ 0.5845 ⇒ 0.58
		const uneven = [skill('short-doc', 'alpha'), skill('long-doc', 'alpha beta gamma delta epsilon zeta')];
		const r = await capture(uneven).call({ query: 'alpha' });
		assert.deepStrictEqual(r.matches.map(m => [m.skill_id, m.score]), [['short-doc', 0.85], ['long-doc', 0.58]],
			'长度归一一旦被改（b 或 tfNorm 公式），这两个数就会变 ✓');
	});

	test('★ 分词丢掉长度 < 2 的碎片（单字符名/描述 ⇒ 一个 token 都不剩：任何查询都不命中，且不崩）', async () => {
		// `x` / `p` 都是单字符 ⇒ 被 `.filter(w => w.length >= 2)` 滤掉 ⇒ 文档 0 个 token、avgDocLen=0。
		// 去掉那个 filter ⇒ `p` 会命中 ⇒ 这条立刻变红 ✓（顺带证明 avgDocLen=0 这条路径**不会**除零崩掉 ✓：
		// 空 token 集不可能 `has(term)` ⇒ 除号那步根本走不到 ✓）。
		const single = [skill('x', 'p')];
		for (const q of ['p', 'x', 'px']) {
			const r = await capture(single).call({ query: q });
			assert.deepStrictEqual(r.matches, [], `query=${JSON.stringify(q)} 不该命中（单字符不是 token ✓）`);
		}
	});

	test('★ 返回形状：skill_id / name / description / score（两位小数），且带 query 回显', async () => {
		const r = await capture(two).call({ query: 'code' });
		assert.strictEqual(r.query, 'code');
		const [m] = r.matches;
		assert.deepStrictEqual(Object.keys(m).sort(), ['description', 'name', 'score', 'skill_id']);
		assert.strictEqual(m.name, 'code-review');
		assert.strictEqual(m.description, '代码评审清单与常见缺陷模式');
		assert.strictEqual(Number(m.score.toFixed(2)), m.score);
	});
});
