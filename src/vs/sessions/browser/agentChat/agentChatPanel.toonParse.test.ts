/*---------------------------------------------------------------------------------------------
 *  agentChatPanel.toonParse.test.ts — TOON 格式解析测试。
 *
 *  基于 LLM 流式输出（tool_result 缓存数据）验证搜索工具 TOON 格式的正确解析。
 *  数据格式模拟真实 LLM 工具返回：[{type:'text', text:'TOON ...'}]
 *
 *  运行方式:
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/browser/agentChat/agentChatPanel.toonParse.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import {
	parseToonGraphData,
	parseToonTraceData,
} from './agentChatPanel.searchResultParse.js';

// ── 模拟 LLM 流式输出缓存数据 ─────────────────────────────────────────

/** 模拟 tool_result 的 JSON 包装格式（agentChatPanel 实际存储格式） */
function _wrapToonToonText(toonText: string): string {
	return JSON.stringify([{ type: 'text', text: toonText }]);
}

/** 从 tool_result 缓存数据提取纯文本（模拟 _toolResultText） */
function _extractText(toolResult: string): string {
	try {
		const parsed = JSON.parse(toolResult);
		if (Array.isArray(parsed) && parsed[0]?.type === 'text') {
			return parsed[0].text;
		}
		return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
	} catch {
		return toolResult;
	}
}

// ════════════════════════════════════════════════════════════════════════
// search_graph TOON 数据（来自真实 LLM 输出）
// ════════════════════════════════════════════════════════════════════════

const SEARCH_GRAPH_BASIC = `TOON search_graph: total=22 returned=10 hasMore=true
#|type|qn|loc|in|out
1|function|GC::ProcessAsync|f:/GR_qiuzijian/S1Game/Source/GarbageCollection/GarbageCollection.cpp:123|3|1
2|function|GC::SpinUntilAllStopped|f:/GR_qiuzijian/S1Game/Source/GarbageCollection/GarbageCollection.cpp:456|2|0
3|function|PerformReachabilityAnalysisPass|f:/GR_qiuzijian/S1Game/Source/GarbageCollection/GarbageCollection.cpp:789|5|2
4|function|GC::ConditionalCollectGarbage|f:/GR_qiuzijian/S1Game/Source/GarbageCollection/GarbageCollection.cpp:234|1|1
5|function|GC::ProcessAsyncDeferred|f:/GR_qiuzijian/S1Game/Source/GarbageCollection/GarbageCollection.cpp:145|0|0`;

const SEARCH_GRAPH_SEMANTIC = `TOON search_graph: total=15 returned=10 hasMore=true
#|type|qn|loc|in|out
1|function|GC::ProcessAsync|f:/GR_qiuzijian/S1Game/Source/GarbageCollection/GarbageCollection.cpp:123|3|1
2|class|FGarbageCollector|f:/GR_qiuzijian/S1Game/Source/GarbageCollection/GarbageCollection.h:45|8|2
semantic_results:
#|type|qn|loc|score|relevance
s1|class|GCObjectRef|f:/GR_qiuzijian/S1Game/Source/GarbageCollection/GarbageCollection.h:78|0.92|high
s2|struct|FGCReferenceFinder|f:/GR_qiuzijian/S1Game/Source/GarbageCollection/GarbageCollection.h:112|0.87|medium
s3|method|MarkAsReachable|f:/GR_qiuzijian/S1Game/Source/ObjectBaseUtility/ObjectBaseUtility.cpp:456|0.75|medium`;

const SEARCH_GRAPH_WITH_SUMMARY = `TOON search_graph: total=3 returned=3 hasMore=false
#|type|qn|loc|in|out|summary
1|function|GC::ProcessAsync|f:/path/GarbageCollection.cpp:123|3|1|Enqueue async GC request to the worker thread queue
2|function|GC::SpinUntilAllStopped|f:/path/GarbageCollection.cpp:456|2|0|Block until all GC worker threads complete current task
3|class|FGarbageCollector|f:/path/GarbageCollection.h:45|8|2|Core GC coordinator managing incremental collection phases`;

const SEARCH_GRAPH_EMPTY = `TOON search_graph: total=0 returned=0 hasMore=false`;

// ════════════════════════════════════════════════════════════════════════
// trace_path TOON 数据
// ════════════════════════════════════════════════════════════════════════

const TRACE_PATH_BASIC = `TOON trace_path: found=true hops=5 depth=3 hasCycle=false from=GC::ProcessAsync to=UObjectBaseUtility::MarkAsReachable
d|type|qn|loc
0|Method|GC::ProcessAsync|f:/GR_qiuzijian/S1Game/Source/GarbageCollection/GarbageCollection.cpp:123
1|Method|GC::ConditionalCollectGarbage|f:/GR_qiuzijian/S1Game/Source/GarbageCollection/GarbageCollection.cpp:234
2|Method|FGarbageCollector::CollectGarbageIncremental|f:/GR_qiuzijian/S1Game/Source/GarbageCollection/GarbageCollection.cpp:456
3|Method|FReferenceFinder::PerformReachabilityAnalysis|f:/GR_qiuzijian/S1Game/Source/GarbageCollection/GarbageCollection.cpp:789
4|Method|UObjectBaseUtility::MarkAsReachable|f:/GR_qiuzijian/S1Game/Source/ObjectBaseUtility/ObjectBaseUtility.cpp:456`;

const TRACE_PATH_RISK = `TOON trace_path: found=true hops=3 depth=2 hasCycle=false from=GC::ProcessAsync to=FWorkBlockifier::Process
d|type|qn|loc|edge_type|risk
0|Method|GC::ProcessAsync|f:/path/GarbageCollection.cpp:123||Low
1|Method|FGarbageCollector::CollectGarbageIncremental|f:/path/GarbageCollection.cpp:456|CALLS|Med
2|Method|FWorkBlockifier::Process|f:/path/WorkBlockifier.cpp:67|CALLS|High`;

const TRACE_PATH_CYCLE = `TOON trace_path: found=true hops=2 depth=1 hasCycle=true from=A::Foo to=A::Foo
d|type|qn|loc|edge_type|risk
0|Method|A::Foo|f:/path/Foo.cpp:10||Low
1|Method|A::Bar|f:/path/Bar.cpp:20|CALLS|Med
2|Method|A::Foo|f:/path/Foo.cpp:10|CALLS|Low`;

const TRACE_PATH_NOT_FOUND = `TOON trace_path: found=false hops=0 depth=0 from=Unknown to=Unknown`;

// ════════════════════════════════════════════════════════════════════════
// 测试套件
// ════════════════════════════════════════════════════════════════════════

suite('toonParse - search_graph TOON 基础解析', () => {

	test('TOON 头行元数据解析', () => {
		const data = parseToonGraphData(SEARCH_GRAPH_BASIC)!;
		assert.ok(data, '应解析出数据');
		assert.strictEqual(data.total, 22);
		assert.strictEqual(data.returned, 10);
		assert.strictEqual(data.hasMore, true);
	});

	test('节点字段正确提取（rank/name/type/filePath/startLine）', () => {
		const data = parseToonGraphData(SEARCH_GRAPH_BASIC)!;
		assert.strictEqual(data.nodes.length, 5);

		const first = data.nodes[0];
		assert.strictEqual(first.rank, 1);
		assert.strictEqual(first.name, 'GC::ProcessAsync');
		assert.strictEqual(first.type, 'function');
		assert.strictEqual(first.filePath, 'f:/GR_qiuzijian/S1Game/Source/GarbageCollection/GarbageCollection.cpp');
		assert.strictEqual(first.startLine, 123);
		assert.strictEqual(first.inDegree, 3);
		assert.strictEqual(first.outDegree, 1);
	});

	test('BM25 分数按 rank 递减', () => {
		// 使用两个不同文件的 TOON 来测试分数递减
		const text = `TOON search_graph: total=2 returned=2 hasMore=false
#|type|qn|loc|in|out
1|function|A::Foo|f:/path/First.cpp:10|0|0
2|function|B::Bar|f:/path/Second.cpp:20|0|0`;
		const data = parseToonGraphData(text)!;
		assert.ok(data.scores, '应有 scores');
		const s1 = data.scores!['f:/path/First.cpp'];
		const s2 = data.scores!['f:/path/Second.cpp'];
		assert.ok(s1 !== undefined && s2 !== undefined);
		assert.ok(s1 > s2, `rank 1 分数 ${s1} 应 > rank 2 分数 ${s2}`);
	});

	test('空结果（total=0）返回空节点数组', () => {
		const data = parseToonGraphData(SEARCH_GRAPH_EMPTY)!;
		assert.ok(data, '空结果也应返回数据对象');
		assert.strictEqual(data.total, 0);
		assert.strictEqual(data.nodes.length, 0);
		assert.strictEqual(data.hasMore, false);
	});

	test('非 TOON 格式返回 null', () => {
		assert.strictEqual(parseToonGraphData('not a TOON string'), null);
		assert.strictEqual(parseToonGraphData(''), null);
		assert.strictEqual(parseToonGraphData('TOON wrong_format: foo=bar'), null);
	});

	test('trace_path 被正确拒绝（不是 search_graph）', () => {
		assert.strictEqual(parseToonGraphData(TRACE_PATH_BASIC), null);
	});
});

suite('toonParse - search_graph semantic_results', () => {

	test('semantic_results 区块正确解析', () => {
		const data = parseToonGraphData(SEARCH_GRAPH_SEMANTIC)!;
		assert.ok(data.semanticResults, '应有 semanticResults');
		assert.strictEqual(data.semanticResults!.length, 3);

		const first = data.semanticResults![0];
		assert.strictEqual(first.rank, 1);
		assert.strictEqual(first.name, 'GCObjectRef');
		assert.strictEqual(first.type, 'class');
		assert.strictEqual(first.filePath, 'f:/GR_qiuzijian/S1Game/Source/GarbageCollection/GarbageCollection.h');
		assert.strictEqual(first.startLine, 78);
		assert.strictEqual(first.score, 0.92);
	});

	test('主节点与 semantic 节点分离', () => {
		const data = parseToonGraphData(SEARCH_GRAPH_SEMANTIC)!;
		assert.strictEqual(data.nodes.length, 2, '主节点应有 2 个');
		assert.strictEqual(data.semanticResults!.length, 3, 'semantic 应有 3 个');
	});

	test('semantic 摘要条数据', () => {
		const data = parseToonGraphData(SEARCH_GRAPH_SEMANTIC)!;
		assert.strictEqual(data.returned, 10);
		assert.strictEqual(data.hasMore, true);
	});
});

suite('toonParse - search_graph summary 列', () => {

	test('带 summary 列的节点正确解析', () => {
		const data = parseToonGraphData(SEARCH_GRAPH_WITH_SUMMARY)!;
		assert.strictEqual(data.nodes.length, 3);
		assert.strictEqual(data.nodes[0].summary, 'Enqueue async GC request to the worker thread queue');
		assert.strictEqual(data.nodes[1].summary, 'Block until all GC worker threads complete current task');
		assert.strictEqual(data.nodes[2].summary, 'Core GC coordinator managing incremental collection phases');
	});
});

suite('toonParse - trace_path TOON 基础解析', () => {

	test('TOON 头行元数据解析', () => {
		const data = parseToonTraceData(TRACE_PATH_BASIC)!;
		assert.ok(data, '应解析出数据');
		assert.strictEqual(data.found, true);
		assert.strictEqual(data.hops, 5);
		assert.strictEqual(data.depth, 3);
		assert.strictEqual(data.hasCycle, false);
		assert.strictEqual(data.from, 'GC::ProcessAsync');
		assert.strictEqual(data.to, 'UObjectBaseUtility::MarkAsReachable');
	});

	test('hop 字段正确提取（depth/name/type/filePath/startLine）', () => {
		const data = parseToonTraceData(TRACE_PATH_BASIC)!;
		assert.strictEqual(data.hopList.length, 5);

		const first = data.hopList[0];
		assert.strictEqual(first.depth, 0);
		assert.strictEqual(first.name, 'GC::ProcessAsync');
		assert.strictEqual(first.type, 'Method');
		assert.strictEqual(first.filePath, 'f:/GR_qiuzijian/S1Game/Source/GarbageCollection/GarbageCollection.cpp');
		assert.strictEqual(first.startLine, 123);
	});

	test('hop 链 depth 递增', () => {
		const data = parseToonTraceData(TRACE_PATH_BASIC)!;
		for (let i = 1; i < data.hopList.length; i++) {
			assert.ok(data.hopList[i].depth > data.hopList[i - 1].depth,
				`hop[${i}].depth=${data.hopList[i].depth} 应 > hop[${i-1}].depth=${data.hopList[i-1].depth}`);
		}
	});

	test('非 TOON 格式返回 null', () => {
		assert.strictEqual(parseToonTraceData('not a TOON string'), null);
		assert.strictEqual(parseToonTraceData(SEARCH_GRAPH_BASIC), null);
	});
});

suite('toonParse - trace_path 风险与边类型', () => {

	test('risk 标签正确解析', () => {
		const data = parseToonTraceData(TRACE_PATH_RISK)!;
		assert.strictEqual(data.hopList.length, 3);
		assert.strictEqual(data.hopList[0].risk, 'Low');
		assert.strictEqual(data.hopList[1].risk, 'Med');
		assert.strictEqual(data.hopList[2].risk, 'High');
	});

	test('edge_type 正确解析', () => {
		const data = parseToonTraceData(TRACE_PATH_RISK)!;
		assert.strictEqual(data.hopList[1].edgeType, 'CALLS');
		assert.strictEqual(data.hopList[2].edgeType, 'CALLS');
	});

	test('hasCycle 循环检测', () => {
		const data = parseToonTraceData(TRACE_PATH_CYCLE)!;
		assert.strictEqual(data.hasCycle, true);
	});

	test('not found 状态', () => {
		const data = parseToonTraceData(TRACE_PATH_NOT_FOUND)!;
		assert.ok(data);
		assert.strictEqual(data.found, false);
		assert.strictEqual(data.hopList.length, 0);
	});
});

suite('toonParse - LLM 流式输出端到端', () => {

	test('JSON 包裹的 TOON 搜索结果被正确提取和解析', () => {
		const wrapped = _wrapToonToonText(SEARCH_GRAPH_BASIC);
		const extracted = _extractText(wrapped);
		const data = parseToonGraphData(extracted)!;

		assert.ok(data, '从 LLM 输出提取的文本应解析出数据');
		assert.strictEqual(data.nodes.length, 5);
		assert.strictEqual(data.nodes[0].name, 'GC::ProcessAsync');
		assert.strictEqual(data.hasMore, true);
	});

	test('JSON 包裹的 TOON trace_path 被正确提取和解析', () => {
		const wrapped = _wrapToonToonText(TRACE_PATH_BASIC);
		const extracted = _extractText(wrapped);
		const data = parseToonTraceData(extracted)!;

		assert.ok(data);
		assert.strictEqual(data.hopList.length, 5);
		assert.strictEqual(data.hopList[0].name, 'GC::ProcessAsync');
	});

	test('search_graph 不被 trace_path 解析器误解析', () => {
		const extracted = _extractText(_wrapToonToonText(SEARCH_GRAPH_BASIC));
		assert.strictEqual(parseToonTraceData(extracted), null);
	});

	test('trace_path 不被 search_graph 解析器误解析', () => {
		const extracted = _extractText(_wrapToonToonText(TRACE_PATH_BASIC));
		assert.strictEqual(parseToonGraphData(extracted), null);
	});
});

suite('toonParse - 边界情况', () => {

	test('文件路径含空格', () => {
		const text = `TOON search_graph: total=1 returned=1 hasMore=false
#|type|qn|loc|in|out
1|function|MyClass::Method|f:/My Project/src/My File.cpp:42|0|0`;
		const data = parseToonGraphData(text)!;
		assert.strictEqual(data.nodes.length, 1);
		assert.strictEqual(data.nodes[0].filePath, 'f:/My Project/src/My File.cpp');
		assert.strictEqual(data.nodes[0].startLine, 42);
	});

	test('startLine 为 -（无行号）', () => {
		const text = `TOON search_graph: total=1 returned=1 hasMore=false
#|type|qn|loc|in|out
1|function|MyClass::Method|f:/path/File.cpp:-|0|0`;
		const data = parseToonGraphData(text)!;
		assert.strictEqual(data.nodes.length, 1);
		assert.strictEqual(data.nodes[0].startLine, 0);
	});

	test('in/out degree 为 0', () => {
		const data = parseToonGraphData(SEARCH_GRAPH_BASIC)!;
		const last = data.nodes[4]; // GC::ProcessAsyncDeferred in=0 out=0
		assert.strictEqual(last.inDegree, 0);
		assert.strictEqual(last.outDegree, 0);
	});

	test('rank 从 1 开始递增', () => {
		const data = parseToonGraphData(SEARCH_GRAPH_BASIC)!;
		for (let i = 0; i < data.nodes.length; i++) {
			assert.strictEqual(data.nodes[i].rank, i + 1);
		}
	});

	test('特殊字符（引号）在 QN 中', () => {
		const text = `TOON search_graph: total=1 returned=1 hasMore=false
#|type|qn|loc|in|out
1|function|MyClass::Method<"T">|f:/path/File.cpp:10|0|0`;
		const data = parseToonGraphData(text)!;
		assert.strictEqual(data.nodes[0].name, 'MyClass::Method<"T">');
	});
});


