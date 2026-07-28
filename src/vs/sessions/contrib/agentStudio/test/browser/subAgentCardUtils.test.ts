/*---------------------------------------------------------------------------------------------
 *  subAgentCardUtils.test.ts
 *
 *  cleanTracePreview 回归（2026-07-25 UI 优化）：子代理执行过程的 args/result 预览
 *  常带 JSON 协议包装（[{"type":"text","text":…}]）或嵌套结构，直接展示会泄露
 *  `搜索内容[{"type":"text",…}]`、`"0": "[object]"` 这类原始包装。
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { cleanTracePreview, formatSubAgentTask } from '../../../../browser/agentChat/subAgentCardUtils.js';

suite('subAgentCardUtils', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('cleanTracePreview', () => {

		test('[{"type":"text","text":…}] 包装 → 提取内层文本', () => {
			const raw = '[{"type":"text","text":"(no matching files)"}]';
			assert.strictEqual(cleanTracePreview(raw, 120), '(no matching files)');
		});

		test('多个 text 块 → 拼接', () => {
			const raw = '[{"type":"text","text":"line1"},{"type":"text","text":"line2"}]';
			assert.strictEqual(cleanTracePreview(raw, 120), 'line1 line2');
		});

		test('嵌套 JSON 结果 → 语义键直取', () => {
			const raw = '{"content":"实际结果内容","meta":{"x":1}}';
			assert.strictEqual(cleanTracePreview(raw, 120), '实际结果内容');
		});

		test('对象 → key=value 紧凑展示，嵌套折叠', () => {
			const raw = '{"pattern":"*.cpp","path":"Source/GC","options":{"deep":true}}';
			assert.strictEqual(cleanTracePreview(raw, 120), 'pattern=*.cpp path=Source/GC options=[…]');
		});

		test('search_code 结果 {results:[...]} → 提取文件路径摘要（2026-07-27 "results=[object]" 修复）', () => {
			// 用户报告：subagent 卡片显示 results=[object] 无法阅读——results 数组
			// 是核心数据，折叠为 […]/[object] 后信息量为零。应提取 filePath:lineNo。
			const raw = JSON.stringify({
				results: [
					{ filePath: 'Engine/Source/Runtime/CoreUObject/Private/UObject/GarbageCollection.cpp', lineNo: 2330, text: '...' },
					{ filePath: 'Engine/Source/Runtime/CoreUObject/Public/UObject/GarbageCollection.h', lineNo: 42, text: '...' },
					{ filePath: 'Source/S1Game/GC/MyGCCustom.cpp', lineNo: 7, text: '...' },
					{ filePath: 'Source/S1Game/GC/Other.cpp', lineNo: 9, text: '...' },
				],
				total: 33, total_grep_matches: 33, truncated: false, mode: 'compact',
			});
			const out = cleanTracePreview(raw, 200);
			assert.ok(out.includes('GarbageCollection.cpp:2330'), `应含首个命中路径与行号，实际: ${out}`);
			assert.ok(out.includes('GarbageCollection.h:42'), `应含第二个命中，实际: ${out}`);
			assert.ok(out.includes('(33 项)'), `应含总数摘要，实际: ${out}`);
			assert.ok(!out.includes('[…]') && !out.includes('[object'), `不应折叠核心 results 数组，实际: ${out}`);
		});

		test('mode:files 结果 {files:[...]} → 路径摘要', () => {
			const raw = JSON.stringify({
				files: ['f:/UE5EA/Engine/Source/A.cpp', 'f:/UE5EA/Engine/Source/B.h', 'f:/UE5EA/Engine/Source/C.cpp', 'f:/UE5EA/Engine/Source/D.cpp'],
				total_files: 4, total_grep_matches: 4,
			});
			const out = cleanTracePreview(raw, 200);
			assert.ok(out.includes('A.cpp'), `应含文件路径，实际: ${out}`);
			assert.ok(out.includes('(4 项)'), `应含总数，实际: ${out}`);
		});

		test('search_code 结果的协议包装（[{"type":"text"}] 内嵌 results JSON）→ 双重解包', () => {
			// 真实数据链：handler 返回 IToolResultContent[]，text 内层才是 results JSON
			const inner = JSON.stringify({
				results: [{ filePath: 'src/foo.cpp', lineNo: 10, text: 'x' }],
				total: 1, mode: 'compact',
			});
			const raw = JSON.stringify([{ type: 'text', text: inner }]);
			const out = cleanTracePreview(raw, 200);
			assert.ok(out.includes('src/foo.cpp:10'), `协议包装内的 results 也应提取，实际: ${out}`);
		});

		test('数组对象（无 text 包装）→ 元素摘要 + 项数', () => {
			const raw = '[{"a":1},{"a":2},{"a":3},{"a":4}]';
			assert.strictEqual(cleanTracePreview(raw, 120), 'a=1, a=2, a=3, …(4 项)');
		});

		test('"0": "[object]" 型结构化截断残骸 → 可读化', () => {
			// truncateStructured 对数组结果产生的 {"0": "[object]"} 形态
			const raw = '{"0":"[object]"}';
			const out = cleanTracePreview(raw, 120);
			assert.ok(!out.includes('[object Object]'), '不应出现 [object Object]');
			assert.strictEqual(out, '[object]');
		});

		test('全数字键对象 {"0":"…","1":"…"} → 按数组处理（不显示索引键）', () => {
			// previewStructured 之前对 >maxLen 数组结果的畸形产物
			const raw = '{"0":"aaa","1":"bbb","2":"ccc"}';
			const out = cleanTracePreview(raw, 120);
			assert.strictEqual(out, 'aaa, bbb, ccc');
		});

		test('全数字键 + text 包装值 → 解包拼接', () => {
			const inner = { type: 'text', text: '搜索结果内容' };
			const raw = JSON.stringify({ '0': inner });
			const out = cleanTracePreview(raw, 120);
			assert.strictEqual(out, '搜索结果内容');
		});

		test('纯文本原样 + 空白折叠 + 截断省略号', () => {
			assert.strictEqual(cleanTracePreview('plain result', 120), 'plain result');
			assert.strictEqual(cleanTracePreview('a\nb\tc  d', 120), 'a b c d');
			const long = 'x'.repeat(200);
			const out = cleanTracePreview(long, 50);
			assert.strictEqual(out.length, 50);
			assert.ok(out.endsWith('…'));
		});

		test('非法 JSON 原样展示', () => {
			const raw = '{broken json…';
			assert.strictEqual(cleanTracePreview(raw, 120), '{broken json…');
		});

		test('真实案例：搜索结果与索引状态', () => {
			const r1 = cleanTracePreview('[{"type":"text","text":"f:\\\\GR\\\\Config\\\\WindowsEngine.ini:10: gc.AllowIncrementalReachab"}]', 60);
			assert.ok(r1.startsWith('f:\\GR\\Config'), `应提取内层路径文本，实际: ${r1}`);
			// 2026-07-27 递归清洗后：内层 JSON 继续可读化为 key=value（比原始 JSON 更可读）
			const r2 = cleanTracePreview('[{"type":"text","text":"{\\n \\"indexed\\": false, \\"project\\": \\"S1Game\\"}"}]', 120);
			assert.ok(r2.includes('indexed=false'), `内层 JSON 应可读化为 key=value，实际: ${r2}`);
		});
	});

	suite('formatSubAgentTask', () => {

		test('JSON 字符串任务 → 提取可读字段', () => {
			const task = '{"title":"查找 GC Worker 窃取核心源码","focus":"GCWorker.cpp"}';
			const out = formatSubAgentTask(task, 'explore');
			assert.ok(out.includes('查找 GC Worker 窃取核心源码'), `实际: ${out}`);
			assert.ok(!out.startsWith('{'), '不应显示原始 JSON');
		});
	});
});
