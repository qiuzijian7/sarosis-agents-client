/*---------------------------------------------------------------------------------------------
 *  agentChatPanel.searchResultParse.test.ts — 搜索结果解析纯函数单元测试。
 *
 *  覆盖场景（基于搜索工具返回的原始数据格式）：
 *    1) 标准 grep 风格 `file:line: content`（Windows/Unix/盘符）
 *    2) search_files 纯文件列表 + 摘要行过滤
 *    3) 用户报告的非文件行（引号包裹 / (Xms) 时间标注 / 管道符表格行）
 *    4) search_graph TOON 表格格式过滤
 *    5) 无匹配结果返回 null（卡片不可展开）
 *    6) 结构化 JSON results[] / content-block 数组
 *
 *  运行方式:
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/browser/agentChat/agentChatPanel.searchResultParse.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import {
	basenameOf,
	extToTypeOf,
	splitGrepPath,
	isValidFilePath,
	parseSearchResultItems,
} from './agentChatPanel.searchResultParse.js';

suite('searchResultParse - 标准 grep 格式', () => {
	test('Windows 绝对路径 file:line:content 提取文件与行号', () => {
		const raw = 'G:/CustomWorkspaces/AIProjects/sarosis-agents-client/src/vs/foo.ts:42:  const x = matched';
		const sp = splitGrepPath(raw);
		assert.strictEqual(sp.path, 'G:/CustomWorkspaces/AIProjects/sarosis-agents-client/src/vs/foo.ts');
		assert.strictEqual(sp.line, 42);
	});

	test('Unix 风格路径 file:line:content', () => {
		const sp = splitGrepPath('/home/user/repo/src/bar.py:10: def foo():');
		assert.strictEqual(sp.path, '/home/user/repo/src/bar.py');
		assert.strictEqual(sp.line, 10);
	});

	test('盘符冒号不被误判为行号分隔符', () => {
		const sp = splitGrepPath('C:\\repo\\src\\bar.py');
		assert.strictEqual(sp.path, 'C:\\repo\\src\\bar.py');
		assert.strictEqual(sp.line, undefined);
	});

	test('basenameOf / extToTypeOf 基础', () => {
		assert.strictEqual(basenameOf('G:/a/b/c.ts'), 'c.ts');
		assert.strictEqual(extToTypeOf('c.ts'), 'ts');
		assert.strictEqual(extToTypeOf('note.md'), 'md');
	});
});

suite('searchResultParse - 纯文件列表（search_files files_only）', () => {
	test('过滤摘要行 [共 N 个文件]', () => {
		const input = JSON.stringify([
			'G:/path/a.ts',
			'G:/path/b.ts',
			'[共 5 个文件]',
		]);
		const items = parseSearchResultItems(input, 'search_files');
		assert.ok(items, '应解析出两项文件');
		assert.strictEqual(items!.length, 2);
		assert.strictEqual(items![0].name, 'a.ts');
		assert.strictEqual(items![1].name, 'b.ts');
	});

	test('过滤摘要行 [共 N 条匹配]', () => {
		const input = JSON.stringify([
			'G:/path/a.ts:42: x',
			'[共 42 条匹配]',
		]);
		const items = parseSearchResultItems(input, 'search_code');
		assert.ok(items);
		assert.strictEqual(items!.length, 1);
		assert.strictEqual(items![0].name, 'a.ts');
		assert.strictEqual(items![0].lineStart, 42);
	});
});

suite('searchResultParse - 用户报告的非文件行过滤', () => {
	// 复现用户日志中搜索工具返回的原始数据混合格式
	const userRawData = JSON.stringify([
		'2026-07-22_vrjij3.md',
		"33 -- 'WindowsEngine.ini' L10",
		"34 - 'gc.IncrementalReachabilityTimeLimit=0.002' (2ms 时间片)",
		"44 - 'DefaultEngine.ini' 'gc.AllowIncrementalReachability=0'",
		"55 - | '**操作**' | 'WindowsEngine.ini' | 中设 'gc.IncrementalReachabilityTimeLimit=0.004' (4ms) |",
	]);

	test('仅保留真实文件名，非文件内容行被全部过滤', () => {
		const items = parseSearchResultItems(userRawData, 'search_files');
		assert.ok(items, '应解析出文件项');
		// 只有 2026-07-22_vrjij3.md 是真实文件路径，其余均被过滤
		assert.strictEqual(items!.length, 1);
		assert.strictEqual(items![0].name, '2026-07-22_vrjij3.md');
	});

	test('引号包裹的路径被过滤', () => {
		assert.strictEqual(isValidFilePath("'WindowsEngine.ini'", 'WindowsEngine.ini'), false);
	});

	test('含 (Xms) 时间标注的行被过滤', () => {
		const raw = "34 - 'gc.IncrementalReachabilityTimeLimit=0.002' (2ms 时间片)";
		assert.strictEqual(isValidFilePath(raw, raw), false);
	});

	test('管道符表格行被过滤', () => {
		const raw = "| '**操作**' | 'WindowsEngine.ini' |";
		assert.strictEqual(isValidFilePath(raw, raw), false);
	});

	test('-- 分隔的内容行被过滤', () => {
		const raw = "33 -- 'WindowsEngine.ini' L10";
		// splitGrepPath 会截取到 .ini，但 raw 仍含引号包裹特征
		assert.strictEqual(isValidFilePath(raw, 'WindowsEngine.ini'), false);
	});
});

suite('searchResultParse - TOON 表格格式（search_graph / trace_path）', () => {
	test('管道符分隔的表头/数据行全部过滤', () => {
		const input = JSON.stringify([
			'| file | line |',
			'| G:/a.ts | 10 |',
			'[共 2 条匹配]',
		]);
		const items = parseSearchResultItems(input, 'trace_path');
		// 表头、数据行、摘要行均非文件路径 → 解析为空
		assert.strictEqual(items, null);
	});
});

suite('searchResultParse - 无匹配结果', () => {
	test('(no matches) 返回空数组', () => {
		const items = parseSearchResultItems('(no matches)', 'search_code');
		// 现在 densified 文本解析识别 "无结果" 并返回空数组（便于卡片展开显示占位）
		assert.ok(Array.isArray(items) && items!.length === 0);
	});

	test('(no matching files) 返回空数组', () => {
		const items = parseSearchResultItems('(no matching files)', 'search_files');
		assert.ok(Array.isArray(items) && items!.length === 0);
	});

	test('空字符串返回 null', () => {
		assert.strictEqual(parseSearchResultItems('', 'search_code'), null);
	});
});

suite('searchResultParse - densified 分组格式（search_files content 模式）', () => {
	// 复现 search_files 返回的 content-block + densified 格式
	const densifiedText = `FastReferenceCollector.h
  34: class FWorkCoordinator;
  7733: FWorkerContext* TryStartWorking(int32 WorkerIndex)

GarbageCollection.cpp
  7691: class FWorkCoordinator
  8030: if (FWorkerContext* Context = WorkCoordinator->TryStartWorking(idx))

[共 11 个文件]`;

	const contentBlock = JSON.stringify([
		{ type: 'text', text: densifiedText },
	]);

	test('densified: 匹配行正确归属到文件，内容行不遗漏', () => {
		const items = parseSearchResultItems(contentBlock, 'search_files');
		assert.ok(items, '应解析出文件匹配项');
		// FastReferenceCollector.h: 2 matches
		assert.strictEqual(items!.length, 4, '总共 4 条匹配');
		assert.strictEqual(items![0].name, 'FastReferenceCollector.h');
		assert.strictEqual(items![0].lineStart, 34);
		assert.strictEqual(items![1].name, 'FastReferenceCollector.h');
		assert.strictEqual(items![1].lineStart, 7733);
		assert.strictEqual(items![2].name, 'GarbageCollection.cpp');
		assert.strictEqual(items![2].lineStart, 7691);
		assert.strictEqual(items![3].name, 'GarbageCollection.cpp');
		assert.strictEqual(items![3].lineStart, 8030);
	});

	test('densified: 摘要行 [共 N 个文件] 不产生额外条目', () => {
		const items = parseSearchResultItems(contentBlock, 'search_files');
		assert.ok(items);
		assert.strictEqual(items!.length, 4);
	});

	test('densified: 纯文本（非 JSON 包裹）也能正确解析', () => {
		const items = parseSearchResultItems(densifiedText, 'search_files');
		assert.ok(items, '纯文本 densified 应能解析');
		assert.strictEqual(items!.length, 4);
		assert.strictEqual(items![0].name, 'FastReferenceCollector.h');
		assert.strictEqual(items![0].path, 'FastReferenceCollector.h');
	});

	test('densified: 无行号的非缩进行被当作文件分支（纯文件列表兼容）', () => {
		const plainList = JSON.stringify([
			{ type: 'text', text: 'G:/path/a.ts\nG:/path/b.ts\n[共 2 个文件]' },
		]);
		const items = parseSearchResultItems(plainList, 'search_files');
		assert.ok(items);
		assert.strictEqual(items!.length, 2);
		assert.strictEqual(items![0].name, 'a.ts');
		assert.strictEqual(items![1].name, 'b.ts');
	});

	test('densified: 无结果 (no matches) 返回空数组可用', () => {
		const emptyInput = JSON.stringify([
			{ type: 'text', text: '(no matches)' },
		]);
		const items = parseSearchResultItems(emptyInput, 'search_files');
		assert.ok(Array.isArray(items) && items!.length === 0, '应返回空数组（表示无结果但可展开）');
	});

	test('densified: 文件名为完整路径的匹配项正确提取', () => {
		const pathInput = JSON.stringify([
			{ type: 'text', text: 'src/vs/sessions/browser/agentChat/agentChatPanel.ts\n  42: const x = 1;\n  99: return null;\n\n[共 1 个文件]' },
		]);
		const items = parseSearchResultItems(pathInput, 'search_files');
		assert.ok(items);
		assert.strictEqual(items!.length, 2);
		assert.strictEqual(items![0].name, 'agentChatPanel.ts');
		assert.strictEqual(items![0].path, 'src/vs/sessions/browser/agentChat/agentChatPanel.ts');
	});
});

suite('searchResultParse - 结构化 JSON', () => {
	test('search_code results[] 提取文件路径与行号', () => {
		const input = JSON.stringify({
			results: [
				{ file: 'G:/a.ts', line: 10 },
				{ file: 'G:/b.ts', line: 20 },
			],
		});
		const items = parseSearchResultItems(input, 'search_code');
		assert.ok(items);
		assert.strictEqual(items!.length, 2);
		assert.strictEqual(items![0].path, 'G:/a.ts');
		assert.strictEqual(items![0].lineStart, 10);
		assert.strictEqual(items![1].path, 'G:/b.ts');
		assert.strictEqual(items![1].lineStart, 20);
	});

	test('content-block 数组形态（search_files 后端）', () => {
		const input = JSON.stringify([
			{ type: 'text', text: 'G:/a.ts:10: x' },
			{ type: 'text', text: 'G:/b.ts:20: y' },
		]);
		const items = parseSearchResultItems(input, 'search_files');
		assert.ok(items);
		assert.strictEqual(items!.length, 2);
		assert.strictEqual(items![0].path, 'G:/a.ts');
		assert.strictEqual(items![0].lineStart, 10);
		assert.strictEqual(items![1].path, 'G:/b.ts');
		assert.strictEqual(items![1].lineStart, 20);
	});

	test('对象数组带 path/line 字段', () => {
		const input = JSON.stringify([
			{ path: 'G:/x.ts', line: 5 },
			{ name: 'custom', path: 'G:/y.ts', start_line: 8 },
		]);
		const items = parseSearchResultItems(input, 'search_code');
		assert.ok(items);
		assert.strictEqual(items!.length, 2);
		assert.strictEqual(items![0].path, 'G:/x.ts');
		assert.strictEqual(items![0].lineStart, 5);
		assert.strictEqual(items![1].name, 'custom');
		assert.strictEqual(items![1].lineStart, 8);
	});
});
