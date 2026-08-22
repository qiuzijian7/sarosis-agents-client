/*---------------------------------------------------------------------------------------------
 *  toolArgsJson.test.ts — 渲染层工具参数宽松解析单元测试。
 *
 *  回归目标（日志 1787311601345 + 用户截图「空白工具卡片」）：
 *    模型把制表符写成 `\x09` → 裸 JSON.parse 抛错 → filePath='' → 卡片标题区空白。
 *
 *  覆盖场景：
 *    1) 合法 JSON / 对象 / 空值直通
 *    2) 非法转义修复（\x09 / \d / \uZZ / 悬空反斜杠）
 *    3) 字符串内裸控制字符修复
 *    4) 流式截断自动闭合（未闭合引号 / 悬空 key / 未闭合括号）
 *    5) 字段级正则兜底（彻底非法 JSON 仍能捞出 filePath）
 *    6) 修复级别诊断（repair / partial 标记）
 *    7) 字符串外内容不被误改（转义修复只在字符串内生效）
 *
 *  运行方式:
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/browser/agentChat/toolArgsJson.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import {
	sanitizeJsonEscapes,
	autoCloseJson,
	scanStringFields,
	parseToolArgsLoose,
	parseToolArgsWithDiagnostics,
} from './toolArgsJson.js';

suite('toolArgsJson - 直通路径', () => {

	test('合法 JSON 原样解析，repair=none', () => {
		const r = parseToolArgsWithDiagnostics('{"filePath":"a/b.ts","content":"x"}');
		assert.strictEqual(r.repair, 'none');
		assert.strictEqual(r.partial, false);
		assert.strictEqual(r.args.filePath, 'a/b.ts');
	});

	test('对象形态直通，repair=object', () => {
		const r = parseToolArgsWithDiagnostics({ filePath: 'a.ts' });
		assert.strictEqual(r.repair, 'object');
		assert.strictEqual(r.args.filePath, 'a.ts');
	});

	test('空值 / 空串 → {}', () => {
		assert.deepStrictEqual(parseToolArgsLoose(undefined), {});
		assert.deepStrictEqual(parseToolArgsLoose(null), {});
		assert.deepStrictEqual(parseToolArgsLoose(''), {});
		assert.deepStrictEqual(parseToolArgsLoose('   '), {});
	});

	test('数组 / 数字等非对象形态 → {}', () => {
		assert.deepStrictEqual(parseToolArgsLoose([1, 2]), {});
		assert.deepStrictEqual(parseToolArgsLoose(42), {});
		assert.deepStrictEqual(parseToolArgsLoose('"just a string"'), {});
	});
});

suite('toolArgsJson - 非法转义修复', () => {

	test('核心回归：content 含 \\x09 时仍能拿到 filePath', () => {
		const raw = '{"filePath":"src/a.ts","content":"line1\\x09tabbed"}';
		// 前置断言：原生 JSON.parse 确实失败（否则本测试无意义）
		assert.throws(() => JSON.parse(raw));
		const r = parseToolArgsWithDiagnostics(raw);
		assert.strictEqual(r.repair, 'escapes');
		assert.strictEqual(r.partial, false);
		assert.strictEqual(r.args.filePath, 'src/a.ts');
		// 非法转义按字面保留（不猜测模型意图）
		assert.strictEqual(r.args.content, 'line1\\x09tabbed');
	});

	test('多种非法转义（\\d / \\p / \\x）一次性修复', () => {
		const raw = '{"pattern":"\\d+\\p{L}","path":"a\\x2Fb"}';
		const r = parseToolArgsWithDiagnostics(raw);
		assert.strictEqual(r.repair, 'escapes');
		assert.strictEqual(r.args.pattern, '\\d+\\p{L}');
		assert.strictEqual(r.args.path, 'a\\x2Fb');
	});

	test('\\u 后不足 4 位 hex → 按字面处理', () => {
		const r = parseToolArgsWithDiagnostics('{"a":"\\uZZ12"}');
		assert.strictEqual(r.repair, 'escapes');
		assert.strictEqual(r.args.a, '\\uZZ12');
	});

	test('合法 \\u 转义不被破坏', () => {
		const r = parseToolArgsWithDiagnostics('{"a":"\\u4e2d\\tx"}');
		assert.strictEqual(r.repair, 'none');
		assert.strictEqual(r.args.a, '中\tx');
	});

	test('字符串内裸控制字符（TAB / LF）被规范转义', () => {
		const raw = '{"content":"a\tb\nc"}';
		assert.throws(() => JSON.parse(raw));
		const r = parseToolArgsWithDiagnostics(raw);
		assert.strictEqual(r.repair, 'escapes');
		assert.strictEqual(r.args.content, 'a\tb\nc');
	});

	test('字符串外的空白/换行（合法 JSON 空白）不受影响', () => {
		const pretty = '{\n\t"filePath": "a.ts"\n}';
		assert.strictEqual(sanitizeJsonEscapes(pretty), pretty);
		assert.strictEqual(parseToolArgsWithDiagnostics(pretty).repair, 'none');
	});

	test('sanitizeJsonEscapes 对合法输入是恒等变换', () => {
		const legal = '{"a":"x\\ty","b":"q\\"q","c":"\\\\path\\\\to"}';
		assert.strictEqual(sanitizeJsonEscapes(legal), legal);
	});

	test('末尾悬空反斜杠被字面化（不吞掉后续补入的引号）', () => {
		assert.strictEqual(sanitizeJsonEscapes('{"a":"x\\'), '{"a":"x\\\\');
	});
});

suite('toolArgsJson - 流式截断自动闭合', () => {

	test('未闭合字符串 + 未闭合对象', () => {
		const r = parseToolArgsWithDiagnostics('{"filePath":"src/a.ts","content":"partial cont');
		assert.strictEqual(r.repair, 'autoclose');
		assert.strictEqual(r.args.filePath, 'src/a.ts');
		assert.strictEqual(r.args.content, 'partial cont');
	});

	test('截断在冒号后（悬空 key 被丢弃，已完成字段保留）', () => {
		const r = parseToolArgsWithDiagnostics('{"filePath":"a.ts","content":');
		assert.strictEqual(r.repair, 'autoclose');
		assert.strictEqual(r.args.filePath, 'a.ts');
		assert.strictEqual('content' in r.args, false);
	});

	test('截断在逗号后', () => {
		const r = parseToolArgsWithDiagnostics('{"filePath":"a.ts",');
		assert.strictEqual(r.repair, 'autoclose');
		assert.strictEqual(r.args.filePath, 'a.ts');
	});

	test('嵌套数组截断', () => {
		const r = parseToolArgsWithDiagnostics('{"files":["a.ts","b.ts"');
		assert.strictEqual(r.repair, 'autoclose');
		assert.deepStrictEqual(r.args.files, ['a.ts', 'b.ts']);
	});

	test('截断 + 非法转义组合（两级修复串联）', () => {
		const r = parseToolArgsWithDiagnostics('{"filePath":"a.ts","content":"x\\x09y');
		assert.strictEqual(r.repair, 'autoclose');
		assert.strictEqual(r.args.filePath, 'a.ts');
	});

	test('autoCloseJson 对完整 JSON 不做改动', () => {
		const complete = '{"a":1}';
		assert.strictEqual(autoCloseJson(complete), complete);
	});
});

suite('toolArgsJson - 字段级兜底扫描', () => {

	test('scanStringFields 捞出所有字符串字段', () => {
		const got = scanStringFields('{"filePath":"a.ts", "mode":"write", "n": 3}');
		assert.strictEqual(got.filePath, 'a.ts');
		assert.strictEqual(got.mode, 'write');
		assert.strictEqual('n' in got, false);
	});

	test('scanStringFields 反转义合法转义序列', () => {
		const got = scanStringFields('{"a":"x\\ty\\u4e2d"}');
		assert.strictEqual(got.a, 'x\ty中');
	});

	test('结构性损坏（缺闭合引号的 key）仍能捞出 filePath，标记 partial', () => {
		// 前两级修复无法还原结构（key 少了引号 → 非法且非截断）
		const raw = '{filePath:"src/a.ts", "content":"x"';
		const r = parseToolArgsWithDiagnostics(raw);
		assert.strictEqual(r.repair, 'scan');
		assert.strictEqual(r.partial, true);
		assert.strictEqual(r.args.content, 'x');
	});

	test('完全无字符串字段的垃圾输入 → failed + {}', () => {
		const r = parseToolArgsWithDiagnostics('<<<not json at all>>>');
		assert.strictEqual(r.repair, 'failed');
		assert.deepStrictEqual(r.args, {});
	});
});
