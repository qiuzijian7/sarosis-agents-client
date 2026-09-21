/*---------------------------------------------------------------------------------------------
 * Copyright (c) Sarosis. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `patch` 批量原子编辑回归测试（2026-09-21，对齐 pi `edit` 的 `edits[]`）。
 *
 * 动机（pi 对照事实）：pi 的 edit 一次调用改多处、全部对**原始内容**匹配、重叠拒绝、
 * **任一失败整批不落盘**。本仓此前只有单处 ⇒ 「改 3 个不相干位置」= 3 次调用 = 3 轮 LLM 往返。
 *
 * 本文件钉住五条不变量：
 *  1. **一次调用改多处**，结果与逐条编辑等价；
 *  2. **全部对原文匹配** ⇒ 顺序无关（打乱 edits 结果相同）；
 *  3. **原子**：任一条失败（未命中/多处命中/空 search/无变化/重叠）⇒ 整批失败，不返回内容；
 *  4. **相邻合法、相交拒绝**（相交有歧义：应先合并成一条 edit）；
 *  5. 行尾（CRLF/LF）行为与单条模式一致（只做确定性归一，其余差异一律报错不猜）。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/patchBatchEdit.test.ts
 */
import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { computeBatchPatch } from '../../common/patchMatcher.js';

suite('patch 批量原子编辑 — computeBatchPatch', () => {

	const FILE = 'a.ts';

	test('★★★ 一次调用改多处（3 个不相干位置）', () => {
		const original = ['import a from "a";', 'const x = 1;', 'function f() { return 1; }', 'export default f;'].join('\n');
		const out = computeBatchPatch(original, [
			{ search: 'import a from "a";', replace: 'import a from "a";\nimport b from "b";' },
			{ search: 'const x = 1;', replace: 'const x = 42;' },
			{ search: 'export default f;', replace: 'export default f;\nexport { b };' },
		], FILE);
		assert.strictEqual(out.ok, true);
		if (!out.ok) { return; }
		assert.strictEqual(out.replacedCount, 3);
		assert.ok(out.content.includes('import b from "b";'));
		assert.ok(out.content.includes('const x = 42;'));
		assert.ok(out.content.includes('export { b };'));
		assert.ok(!out.content.includes('const x = 1;'), '旧内容必须被替换掉 ✗');
	});

	test('★★★ 全部对**原文**匹配 ⇒ edits 顺序无关', () => {
		const original = 'AAA\nBBB\nCCC';
		const a = computeBatchPatch(original, [
			{ search: 'AAA', replace: '111' },
			{ search: 'CCC', replace: '333' },
		], FILE);
		const b = computeBatchPatch(original, [
			{ search: 'CCC', replace: '333' },
			{ search: 'AAA', replace: '111' },
		], FILE);
		assert.strictEqual(a.ok && b.ok, true);
		if (!a.ok || !b.ok) { return; }
		assert.strictEqual(a.content, b.content, '顺序不应影响结果（对原文匹配 + 逆序应用）✗');
		assert.strictEqual(a.content, '111\nBBB\n333');
	});

	test('★★★ 原子性：任一条未命中 ⇒ 整批失败，且点名是哪一条', () => {
		const original = 'AAA\nBBB';
		const out = computeBatchPatch(original, [
			{ search: 'AAA', replace: '111' },
			{ search: 'NOT_IN_FILE', replace: 'zzz' },
		], FILE);
		assert.strictEqual(out.ok, false);
		if (out.ok) { return; }
		assert.strictEqual(out.reason, 'not_found');
		assert.ok(/edits\[1\]/.test(out.message), '必须点名出问题的 edit 下标（1-based）✗');
		assert.ok(/Nothing was written/i.test(out.message), '必须说明整批未落盘（原子）✗');
	});

	test('★★★ 重叠区间被拒（有歧义，须合并成一条）', () => {
		const original = 'abcdefgh';
		const out = computeBatchPatch(original, [
			{ search: 'abcd', replace: 'X' },
			{ search: 'cdef', replace: 'Y' },
		], FILE);
		assert.strictEqual(out.ok, false);
		if (out.ok) { return; }
		assert.strictEqual(out.reason, 'overlapping_edits');
		assert.ok(/overlap/i.test(out.message) && /merge/i.test(out.message), '必须给出「合并成一条」的出路 ✗');
	});

	test('★ 相邻（首尾相接）**不算**重叠 —— 必须能改', () => {
		const original = 'abcdef';
		const out = computeBatchPatch(original, [
			{ search: 'abc', replace: 'X' },
			{ search: 'def', replace: 'Y' },
		], FILE);
		assert.strictEqual(out.ok, true);
		if (!out.ok) { return; }
		assert.strictEqual(out.content, 'XY');
	});

	test('★★ 多处命中（非唯一）被拒 —— 批量模式不提供 replace_all', () => {
		const out = computeBatchPatch('dup\ndup', [{ search: 'dup', replace: 'x' }], FILE);
		assert.strictEqual(out.ok, false);
		if (out.ok) { return; }
		assert.strictEqual(out.reason, 'multiple_occurrences');
		assert.ok(/exactly once/.test(out.message), '必须说明必须唯一 ✗');
	});

	test('★ 空 edits / 空 search / 无变化 三种入参错误各自报准', () => {
		const empty = computeBatchPatch('AAA', [], FILE);
		assert.strictEqual(empty.ok, false);
		if (!empty.ok) { assert.strictEqual(empty.reason, 'empty_edits'); }

		const emptySearch = computeBatchPatch('AAA', [{ search: '', replace: 'x' }], FILE);
		assert.strictEqual(emptySearch.ok, false);
		if (!emptySearch.ok) { assert.strictEqual(emptySearch.reason, 'empty_search'); }

		const noop = computeBatchPatch('AAA', [{ search: 'AAA', replace: 'AAA' }], FILE);
		assert.strictEqual(noop.ok, false);
		if (!noop.ok) { assert.strictEqual(noop.reason, 'identical_search_replace'); }
	});

	test('★★ CRLF 文件：LF 入参仍能命中，写回保持 CRLF', () => {
		const original = 'a\r\nb\r\nc';
		const out = computeBatchPatch(original, [{ search: 'a\nb', replace: 'a\nB' }], FILE);
		assert.strictEqual(out.ok, true);
		if (!out.ok) { return; }
		assert.strictEqual(out.lineEnding, 'CRLF');
		assert.strictEqual(out.lineEndingAdjusted, true, '必须如实回报「入参行尾被转换」✗');
		assert.strictEqual(out.content, 'a\r\nB\r\nc', '写回必须保持文件原行尾风格 ✗');
	});

	test('★ 中英混排 + 多行替换的区域行号可信', () => {
		const lines = Array.from({ length: 40 }, (_, i) => `line${i + 1}`);
		lines[0] = '头部中文';
		lines[39] = '尾部中文';
		const original = lines.join('\n');
		const out = computeBatchPatch(original, [
			{ search: '头部中文', replace: '头部中文改' },
			{ search: '尾部中文', replace: '尾部中文改' },
		], FILE);
		assert.strictEqual(out.ok, true);
		if (!out.ok) { return; }
		assert.strictEqual(out.editedLineStart, 1);
		assert.strictEqual(out.editedLineEnd, 40, '并集区间应覆盖到最后一处改动所在行 ✗');
		assert.ok(out.content.includes('头部中文改') && out.content.includes('尾部中文改'));
	});
});

/**
 * 接线钉（source-level）：批量模式必须在 handler 里真正接上，且文件写队列必须在
 * **唯一收口处**（executeTool）生效 —— 纯函数测试证明不了这两点。
 */
suite('patch 批量 + 写队列 — 接线钉', () => {

	const readSrc = (rel: string): string => {
		const abs = path.join(process.cwd(), rel);
		assert.ok(fs.existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
		return fs.readFileSync(abs, 'utf8');
	};
	/** 剥注释（本仓教训：注释里会刻意引用旧写法/旧日志作取证，连注释查会假红 ✓）。 */
	const code = (rel: string): string => readSrc(rel)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');

	const COMPAT = 'src/vs/sessions/contrib/agentStudio/browser/providers/tool/compatibilityTools.ts';
	const PROVIDER = 'src/vs/sessions/contrib/agentStudio/browser/providers/tool/builtinToolProvider.ts';

	test('★★★ patch handler：edits 必须在 schema 里 + 真正调用 computeBatchPatch + 模式互斥', () => {
		const src = code(COMPAT);
		assert.ok(src.includes("edits: { type: 'array'"), 'schema 必须有 edits ✗');
		assert.ok(src.includes('computeBatchPatch(original, batchEdits!, filePath)'),
			'handler 必须真的走批量纯函数 ✗');
		assert.ok(src.includes('BATCH mode) cannot be combined with "search" or "insert_line"'),
			'必须拒绝 edits 与 search/insert_line 混用（模式歧义）✗');
		assert.ok(src.includes('must be an ARRAY of { search, replace } objects'),
			'edits 是非 JSON 字符串时必须明确报错（不能静默当没传 ✗）');
		// 成功文案必须体现「一次调用、原子」
		assert.ok(src.includes('in ONE atomic batch.'), '成功回执必须说明是原子批量 ✗');
	});

	test('★★★ patch 成功回执必须附 unified diff（含 +A/-R 摘要）', () => {
		const src = code(COMPAT);
		assert.ok(src.includes('buildUnifiedDiff(original, outcome.content'),
			'回执必须基于「原文 → 新文」生成 diff（不能拿别的中间态）✗');
		assert.ok(src.includes('diffStat(original, outcome.content)'),
			'+A/-R 摘要必须与 diff 同源（否则数字与画面打架）✗');
		assert.ok(src.includes('Diff (${stat.added} added, ${stat.removed} removed)'),
			'必须给出改动规模摘要（免得模型自己数）✗');
		// 注意：源码里是模板串，反引号被转义 ⇒ 字面量是 `\`\`\`diff`（三个转义反引号），
		// 故这里按**字面**匹配，不能写 '```diff'（那样永远匹配不上，属自欺式断言 ✗）。
		assert.ok(src.includes('Diff (${stat.added}') && src.includes('\\`\\`\\`diff'),
			'diff 必须带语言标注放进代码块（可读性 + 不污染正文）✗');
		// 上限必须交给 unifiedDiff 内部（回执是辅助信息，不得顶爆上下文）
		assert.ok(src.includes('{ filePath }'), '必须传 filePath 生成 ---/+++ 头 ✗');
	});

	test('★★★ executeTool：文件写工具必须经 withFileMutationQueue（唯一收口处）', () => {
		const src = code(PROVIDER);
		assert.ok(src.includes('withFileMutationQueue(key, run)'),
			'executeTool 必须在同一文件键上串行执行写工具 ✗');
		assert.ok(src.includes('resolveToolMutationKey(toolCall.name, _parseToolArgsLenient(toolCall)'),
			'必须按工具名+入参解析队列键（才能只锁文件写工具）✗');
		assert.ok(src.includes('this.fileService.realpath(URI.file(p))'),
			'realpath 归一是必须的 —— 相对/绝对、分隔符、大小写、符号链接别名都要落到同一个键 ✗');
		assert.ok(src.includes('return key ? withFileMutationQueue(key, run) : run();'),
			'非写工具必须直通（不能给所有工具加锁）✗');
	});
});
