/*---------------------------------------------------------------------------------------------
 *  searchTruncationHonesty — 搜索结果「被截断」时必须**诚实标注**。
 *
 *  由来（2026-09-11 排查「静默失效」）：
 *    `searchContent` 的 ripgrep 路径设了 `maxResults: 5000`；命中上限时
 *    `ISearchComplete.limitHit === true`、结果被截断。但 `_formatSearchComplete`
 *    **从不读 limitHit**（全模块零引用），三个输出分支一律按「全量」报告总数
 *    （如 footer `[共 N 条匹配]`）→ 模型认定「匹配就这些」。
 *
 *    而走查（ripgrep 不可用）路径**早已**有 `budgetExhausted` 标注
 *    （"SEARCH BUDGET EXHAUSTED, coverage incomplete"）—— 主路径反而更不诚实，
 *    与本文件注释明确反对的「让模型得出『代码里没有』的错误结论」属同一类错误。
 *    已修为：`limitHit` 时统一追加 TRUNCATED 说明。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { SearchHelpers } from '../../browser/providers/tool/searchHelpers.js';

suite('search_content 截断诚实化（limitHit）', () => {

	/** 造一个只返回固定 ISearchComplete 的 SearchHelpers（fileService 全 stub）。 */
	const makeHelpers = (result: { results?: unknown[]; limitHit?: boolean; isDirectory?: boolean; content?: string }) => {
		const isDirectory = result.isDirectory ?? true;
		const fileService = {
			async resolve() { return { isDirectory, children: [] }; },
			async readFile() { return { value: { toString: () => result.content ?? '', buffer: new Uint8Array() } }; },
		};
		const searchService = {
			async textSearch() { return { results: result.results ?? [], limitHit: result.limitHit, messages: [] }; },
			async fileSearch() { return { results: [], messages: [] }; },
		};
		const logService = { info() { }, warn() { }, error() { }, debug() { }, trace() { } };
		return new SearchHelpers(fileService as never, searchService as never, logService as never);
	};

	/** 一条命中（'match' 输出模式所需的 ISearchComplete 形状）。 */
	const oneHit = () => ([{
		resource: URI.file('/repo/src/a.ts'),
		results: [{ rangeLocations: [{ source: { startLineNumber: 3 } }], previewText: 'const foo = 1;' }],
	}]);

	test('★ limitHit=true → 输出必须标注 TRUNCATED（不能伪装成完整结果）', async () => {
		const out = await makeHelpers({ results: oneHit(), limitHit: true })
			.searchContent('/repo', 'foo', undefined, 50, 0, 'content', 0);
		assert.ok(out.includes('const foo = 1;'), '命中内容应保留');
		assert.ok(out.includes('TRUNCATED'), `应标注结果被截断，实际输出：${out}`);
	});

	test('limitHit=false → 不出现截断标注（避免噪音）', async () => {
		const out = await makeHelpers({ results: oneHit(), limitHit: false })
			.searchContent('/repo', 'foo', undefined, 50, 0, 'content', 0);
		assert.ok(out.includes('const foo = 1;'));
		assert.ok(!out.includes('TRUNCATED'), `不应标注截断，实际输出：${out}`);
	});

	test('★ limitHit=true 且 0 命中 → 也要标注（「无匹配」与「截断后无匹配」不可混同）', async () => {
		const out = await makeHelpers({ results: [], limitHit: true })
			.searchContent('/repo', 'foo', undefined, 50, 0, 'content', 0);
		assert.ok(out.includes('(no matches)'), `应说明无匹配，实际：${out}`);
		assert.ok(out.includes('TRUNCATED'), `同时应说明是截断后的无匹配，实际：${out}`);
	});

	test('files_only 模式同样受截断标注覆盖', async () => {
		const out = await makeHelpers({ results: oneHit(), limitHit: true })
			.searchContent('/repo', 'foo', undefined, 50, 0, 'files_only', 0);
		assert.ok(out.includes('TRUNCATED'), `files_only 也应标注，实际：${out}`);
	});
});

// ── 单文件搜索（_grepSingleFile）：同一类诚实性要求 ──────────────────────────
//   此前有两处静默削弱：① >256 KiB 只搜前 256 KiB（后半段命中凭空消失）；
//   ② signal 中断时直接 break 返回**部分**结果而不说明。
suite('search_content 单文件：截断 / 中断诚实化', () => {

	const makeFileHelpers = (content: string) => {
		const fileService = {
			async resolve() { return { isDirectory: false, children: [] }; },
			async readFile() { return { value: { toString: () => content, buffer: new Uint8Array() } }; },
		};
		const searchService = {
			async textSearch() { throw new Error('单文件路径不应走 ripgrep'); },
			async fileSearch() { return { results: [], messages: [] }; },
		};
		const logService = { info() { }, warn() { }, error() { }, debug() { }, trace() { } };
		return new SearchHelpers(fileService as never, searchService as never, logService as never);
	};

	test('★ 文件 >256 KiB：命中落在 256 KiB 之后 → 必须标注「只搜了前 256 KiB」', async () => {
		// 前半段（>256 KiB）无命中，NEEDLE 放在截断点之后
		const content = 'x'.repeat(256 * 1024 + 64) + '\nNEEDLE_BEYOND_CAP\n';
		const out = await makeFileHelpers(content)
			.searchContent('/repo/big.txt', 'NEEDLE_BEYOND_CAP', undefined, 50, 0, 'content', 0);
		assert.ok(out.includes('(no matches)'), `截断点后确实搜不到，实际：${out}`);
		assert.ok(out.includes('256 KiB'), `必须说明是截断导致，而不是「文件里没有」，实际：${out}`);
	});

	test('文件 <256 KiB：不产生截断噪音', async () => {
		const out = await makeFileHelpers('a\nfoo\nb\n')
			.searchContent('/repo/small.txt', 'foo', undefined, 50, 0, 'content', 0);
		assert.ok(out.includes('foo'));
		assert.ok(!out.includes('256 KiB'), `小文件不应标注截断，实际：${out}`);
	});

	test('★ 搜索被中断（signal 已 abort）→ 必须标注结果 PARTIAL', async () => {
		const ac = new AbortController();
		ac.abort();
		const out = await makeFileHelpers('a\nfoo\nb\nfoo\n')
			.searchContent('/repo/a.txt', 'foo', undefined, 50, 0, 'content', 0, ac.signal);
		assert.ok(out.includes('PARTIAL'), `中断导致的部分结果必须标注，实际：${out}`);
	});
});

// ── 走查（ripgrep 降级）路径：两处静默削弱必须披露（2026-09-11）──────────────
//   `_walkAndGrep` 此前有两处**静默**削弱，均不计数不披露：
//     ① 超 512 KiB 的文件被整份 `continue` 跳过（内部命中完全未搜）；
//     ② 超 256 KiB 的文件只搜前 256 KiB（后半段命中凭空消失）。
//   于是裸报的 `(no matches)` 可能是**谎报**，会被 tool-hint 包装成
//   "symbols likely do not exist" → 模型得出「代码里没有」的错误结论。
//   另：引擎降级（ripgrep 不可用）此前只在「0 命中」分支披露，**有结果时完全
//   不提**，模型无从判断覆盖面已被削弱。
suite('search_content 走查降级路径：削弱披露', () => {

	/** 造「ripgrep 不可用 + 可控文件树」的 SearchHelpers（textSearch 恒抛 ENOENT → 走 walk）。 */
	const makeWalkHelpers = (files: Array<{ name: string; size?: number; content: string }>) => {
		const fileService = {
			async resolve(uri: URI) {
				const p = uri.fsPath.replace(/\\/g, '/');
				if (p === '/repo') {
					return {
						isDirectory: true,
						children: files.map(f => ({
							name: f.name, isDirectory: false, isFile: true, size: f.size,
							resource: URI.file(`/repo/${f.name}`),
						})),
					};
				}
				return { isDirectory: false, children: [] };
			},
			async readFile(uri: URI) {
				const p = uri.fsPath.replace(/\\/g, '/');
				const text = files.find(f => `/repo/${f.name}` === p)?.content ?? '';
				return { value: { toString: () => text, buffer: new Uint8Array([65, 66, 67]) } };
			},
		};
		const searchService = {
			async textSearch() { throw new Error('spawn rg.exe ENOENT'); },
			async fileSearch() { throw new Error('spawn rg.exe ENOENT'); },
		};
		const logService = { info() { }, warn() { }, error() { }, debug() { }, trace() { } };
		return new SearchHelpers(fileService as never, searchService as never, logService as never);
	};

	const KIB = 1024;
	const filler = (n: number) => 'x'.repeat(n);

	test('★ >512 KiB 文件被跳过 → 有结果时也必须披露 SKIPPED', async () => {
		const out = await makeWalkHelpers([
			{ name: 'small.ts', content: 'const NEEDLE = 1;\n' },
			{ name: 'huge.ts', size: 600 * KIB, content: 'const NEEDLE = 2;\n' },
		]).searchContent('/repo', 'NEEDLE', undefined, 50, 0, 'content', 0);
		assert.ok(out.includes('small.ts'), `正常文件应命中，实际：${out}`);
		assert.ok(!out.includes('huge.ts'), '超 512 KiB 的文件本就不读');
		assert.ok(/SKIPPED entirely/.test(out), `必须披露有文件被整份跳过，实际：${out}`);
	});

	test('★ 命中只在 256 KiB 之后 → 绝不能裸报 "(no matches)"（那是谎报）', async () => {
		const out = await makeWalkHelpers([
			{ name: 'big.ts', content: filler(300 * KIB) + '\nconst NEEDLE_LATE = 1;\n' },
		]).searchContent('/repo', 'NEEDLE_LATE', undefined, 50, 0, 'content', 0);
		assert.ok(out.includes('COVERAGE INCOMPLETE'), `应说明覆盖不完整而非「没有」，实际：${out}`);
		assert.ok(/256 KiB/.test(out), `应披露 256 KiB 截断，实际：${out}`);
	});

	test('截断文件的前半段命中 → 有结果且同时披露截断', async () => {
		const out = await makeWalkHelpers([
			{ name: 'big.ts', content: 'const NEEDLE_EARLY = 1;\n' + filler(300 * KIB) },
		]).searchContent('/repo', 'NEEDLE_EARLY', undefined, 50, 0, 'content', 0);
		assert.ok(out.includes('NEEDLE_EARLY'), `前半段命中应保留，实际：${out}`);
		assert.ok(/256 KiB/.test(out), `同时必须披露截断，实际：${out}`);
	});

	test('★ 降级态有结果时也要披露 engine degraded（此前仅 0 命中分支披露）', async () => {
		const out = await makeWalkHelpers([
			{ name: 'small.ts', content: 'const NEEDLE = 1;\n' },
		]).searchContent('/repo', 'NEEDLE', undefined, 50, 0, 'content', 0);
		assert.ok(out.includes('NEEDLE'), '应有命中');
		assert.ok(/degraded/i.test(out), `有结果时也要说明引擎已降级，实际：${out}`);
	});

	test('无削弱时不得产生 SKIPPED / 256 KiB 噪音', async () => {
		const out = await makeWalkHelpers([
			{ name: 'a.ts', content: 'const NEEDLE = 1;\n' },
		]).searchContent('/repo', 'NEEDLE', undefined, 50, 0, 'content', 0);
		assert.ok(!/SKIPPED entirely/.test(out), `不应有跳过噪音，实际：${out}`);
		assert.ok(!/256 KiB/.test(out), `不应有截断噪音，实际：${out}`);
	});

	test('★ 遍历被 abort → 必须标注结果 PARTIAL（不能假装搜完了）', async () => {
		const helpers = makeWalkHelpers([
			{ name: 'a.ts', content: 'const NEEDLE = 1;\n' },
		]);
		// 先跑一次建立降级态（_ripgrepBroken=true）：否则 abort 会在 ripgrep 分支
		// 抛 CancellationError 向上传播，根本进不了走查路径。
		await helpers.searchContent('/repo', 'NEEDLE', undefined, 50, 0, 'content', 0);
		const ac = new AbortController();
		ac.abort();
		const out = await helpers.searchContent('/repo', 'NEEDLE', undefined, 50, 0, 'content', 0, ac.signal);
		assert.ok(out.includes('PARTIAL'), `中断导致的整体不完整必须标注，实际：${out}`);
	});
});

// ── 文件名搜索（search_files）走查路径：预算耗尽必须披露（2026-09-11）─────────
//   `_nodeFileSearch` 与内容搜索的 `_walkAndGrep` 是**同族路径**，但预算耗尽时
//   裸报 "(no matching files)" —— 会被 tool-hint 包装成「没有这个文件」，
//   而实际只是没搜完（本仓高频的「修了一半」：上轮只修了内容搜索那条）。
suite('search_files 走查路径：预算耗尽披露', () => {

	/** 造「ripgrep 不可用 + 可控文件树」的 SearchHelpers（fileSearch 恒抛 ENOENT → 走 walk）。 */
	const makeFileHelpers = (children: Array<{ name: string }>) => {
		const fileService = {
			async resolve(uri: URI) {
				const p = uri.fsPath.replace(/\\/g, '/');
				if (p === '/repo') {
					return {
						isDirectory: true,
						children: children.map(c => ({
							name: c.name, isDirectory: false, isFile: true, size: 10, mtime: 1000,
							resource: URI.file(`/repo/${c.name}`),
						})),
					};
				}
				return { isDirectory: false, children: [] };
			},
			async readFile() { return { value: { toString: () => '', buffer: new Uint8Array() } }; },
		};
		const searchService = {
			async textSearch() { throw new Error('spawn rg.exe ENOENT'); },
			async fileSearch() { throw new Error('spawn rg.exe ENOENT'); },
		};
		const logService = { info() { }, warn() { }, error() { }, debug() { }, trace() { } };
		return new SearchHelpers(fileService as never, searchService as never, logService as never);
	};

	/** 5001 个文件 > MAX_VISIT(5000) → 遍历在预算处截断。 */
	const overBudgetTree = () => Array.from({ length: 5001 }, (_, i) => ({ name: `f${i}.ts` }));

	test('★ 命中为 0 且预算耗尽 → 绝不能裸报 "(no matching files)"', async () => {
		const out = await makeFileHelpers(overBudgetTree())
			.searchFilesByGlob('/repo', '*.nomatch', 50, 0);
		assert.ok(out.includes('COVERAGE INCOMPLETE'), `应说明覆盖不完整而非「没有这个文件」，实际：${out}`);
		assert.ok(/budget exhausted/.test(out), `应披露预算耗尽，实际：${out}`);
	});

	test('有命中但预算耗尽 → 同样披露（结果可能不完整）', async () => {
		const out = await makeFileHelpers(overBudgetTree())
			.searchFilesByGlob('/repo', '*.ts', 50, 0);
		assert.ok(out.includes('f0.ts'), `应有命中，实际：${out.slice(0, 200)}`);
		assert.ok(/budget exhausted/.test(out), `必须披露结果可能不完整，实际：${out.slice(-300)}`);
	});

	test('未耗尽时不得产生预算噪音', async () => {
		const out = await makeFileHelpers([{ name: 'a.ts' }, { name: 'b.txt' }])
			.searchFilesByGlob('/repo', '*.ts', 50, 0);
		assert.ok(out.includes('a.ts'), `应命中，实际：${out}`);
		assert.ok(!/budget exhausted/.test(out), `不应有预算噪音，实际：${out}`);
	});
});
