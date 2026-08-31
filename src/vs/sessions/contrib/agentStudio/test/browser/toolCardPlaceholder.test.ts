/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for tool card placeholder logic in the streaming pipeline.
 *
 * These tests verify that:
 *  1. `_replaceToolBlocksWithPlaceholders` correctly converts <tool>/<tool_result>/<custom>
 *     blocks into <!--TOOL_CARD:id--> placeholders
 *  2. The placeholder + sanitizer pipeline preserves HTML comment placeholders
 *  3. End-to-end streaming simulation produces correct interleaved text+card output
 *
 * The backend method `_replaceToolBlocksWithPlaceholders` is private, so we replicate
 * its core regex logic here for unit testing. The integration tests use the public
 * `sanitizeAssistantVisibleText` and `isEntirelyToolCallContent` functions.
 */

import * as assert from 'assert';
import {
	sanitizeAssistantVisibleText,
	isEntirelyToolCallContent,
} from '../../common/assistantVisibleText.js';
import { locateTaggedIdXmlTags } from '../../common/agentRunState.js';

// ════════════════════════════════════════════════════════════════════════════════
// § Replicated placeholder replacement logic (mirrors AgentOSService._replaceToolBlocksWithPlaceholders)
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Mirrors AgentOSService._replaceToolBlocksWithPlaceholders for testing.
 * - <tool>...</tool>              → <!--TOOL_CARD:tool_call_id-->
 * - <tool_result>...</tool_result>→ <!--TOOL_CARD:tool_call_id-->
 * - <custom>...</custom>          → removed
 */
function replaceToolBlocksWithPlaceholders(text: string): string {
	if (!text) { return text; }
	let result = text;

	// 1. Replace <tool>...</tool> blocks
	const toolBlockRe = /<tool\b[^>]*>([\s\S]*?)<\/tool>/gi;
	result = result.replace(toolBlockRe, (_match, inner) => {
		const idMatch = /"tool_call_id"\s*:\s*"([^"]+)"/.exec(inner);
		if (idMatch) {
			return `<!--TOOL_CARD:${idMatch[1]}-->`;
		}
		return '';
	});

	// 2. Replace <tool_result>...</tool_result> blocks
	const toolResultRe = /<tool_result\b([^>]*)>([\s\S]*?)<\/tool_result>/gi;
	result = result.replace(toolResultRe, (_match, attrs) => {
		const idAttrMatch = /\btool_call_id=["']([^"']+)["']/.exec(attrs);
		if (idAttrMatch) {
			return `<!--TOOL_CARD:${idAttrMatch[1]}-->`;
		}
		return '';
	});

	// 3. Remove <custom>...</custom> blocks
	result = result.replace(/<custom\b[^>]*>([\s\S]*?)<\/custom>/gi, '');

	return result;
}

/**
 * Mirrors the full pipeline in AgentOSService:
 *   replaceToolBlocksWithPlaceholders → isEntirelyToolCallContent → sanitizeAssistantVisibleText
 */
function fullContentPipeline(text: string): string {
	if (!text) { return text; }

	let content = replaceToolBlocksWithPlaceholders(text);

	if (isEntirelyToolCallContent(content)) {
		return '';
	}

	const cleaned = sanitizeAssistantVisibleText(content, 'streaming');
	return cleaned.length < 5 ? '' : cleaned;
}

/**
 * Simulates the frontend InterleavedMarkdownRenderer placeholder parsing.
 * Returns an ordered list of { type: 'text' | 'card', value: string }.
 */
function parseInterleavedOutput(processedText: string, toolCallIds: string[]): Array<{ type: 'text' | 'card'; value: string }> {
	const result: Array<{ type: 'text' | 'card'; value: string }> = [];
	const TOOL_CARD_RE = /<!--TOOL_CARD:([^>]+)-->/g;
	const renderedIds = new Set<string>();

	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = TOOL_CARD_RE.exec(processedText)) !== null) {
		const textBefore = processedText.slice(lastIndex, match.index);
		if (textBefore.trim()) {
			result.push({ type: 'text', value: textBefore.trim() });
		}

		const toolCallId = match[1].trim();
		if (!renderedIds.has(toolCallId) && toolCallIds.includes(toolCallId)) {
			result.push({ type: 'card', value: toolCallId });
			renderedIds.add(toolCallId);
		}

		lastIndex = match.index + match[0].length;
	}

	// Text after last placeholder
	const textAfter = processedText.slice(lastIndex);
	if (textAfter.trim()) {
		result.push({ type: 'text', value: textAfter.trim() });
	}

	// Append orphan cards (cards not matched by any placeholder)
	for (const id of toolCallIds) {
		if (!renderedIds.has(id)) {
			result.push({ type: 'card', value: id });
			renderedIds.add(id);
		}
	}

	return result;
}


// ════════════════════════════════════════════════════════════════════════════════
// § Test Suite: replaceToolBlocksWithPlaceholders (Unit)
// ════════════════════════════════════════════════════════════════════════════════

suite('replaceToolBlocksWithPlaceholders', () => {

	test('replaces <tool> block with placeholder', () => {
		const input = '<tool>\n   ▷\n    {"tool_call_id":"abc-123","name":"list_dir","display_name":"查找目录中"}\n   ▷\n</tool>';
		const result = replaceToolBlocksWithPlaceholders(input);
		assert.strictEqual(result, '<!--TOOL_CARD:abc-123-->');
	});

	test('replaces <tool> block with surrounding text', () => {
		const input = '我来帮你分析。\n<tool>\n   ▷\n    {"tool_call_id":"abc-123","name":"list_dir"}\n   ▷\n</tool>\n分析结果如下。';
		const result = replaceToolBlocksWithPlaceholders(input);
		assert.strictEqual(result, '我来帮你分析。\n<!--TOOL_CARD:abc-123-->\n分析结果如下。');
	});

	test('replaces <tool_result> block with tool_call_id attribute', () => {
		const input = '<tool_result tool_call_id="abc-123">\n  {"items": []}\n</tool_result>';
		const result = replaceToolBlocksWithPlaceholders(input);
		assert.strictEqual(result, '<!--TOOL_CARD:abc-123-->');
	});

	test('removes <tool_result> without tool_call_id attribute', () => {
		const input = 'Before\n<tool_result>\n  {"items": []}\n</tool_result>\nAfter';
		const result = replaceToolBlocksWithPlaceholders(input);
		assert.strictEqual(result, 'Before\n\nAfter');
	});

	test('removes <custom> blocks entirely', () => {
		const input = '<tool>\n   ▷\n    {"tool_call_id":"abc-123","name":"task_planning"}\n   ▷\n</tool>\n<custom>\n  {"tool_call_id":"abc-123","type":"remove-tool"}\n</custom>\n我来帮你。';
		const result = replaceToolBlocksWithPlaceholders(input);
		// <custom> removal leaves a blank line, which is fine — sanitizer will clean it
		assert.ok(result.includes('<!--TOOL_CARD:abc-123-->'));
		assert.ok(result.includes('我来帮你。'));
		assert.ok(!result.includes('<custom>'));
	});

	test('removes <tool> block without tool_call_id', () => {
		const input = 'Text before\n<tool>\n  some content without id\n</tool>\nText after';
		const result = replaceToolBlocksWithPlaceholders(input);
		assert.strictEqual(result, 'Text before\n\nText after');
	});

	test('handles multiple <tool> blocks', () => {
		const input = 'Start\n<tool>\n   ▷\n    {"tool_call_id":"id-1","name":"task_planning"}\n   ▷\n</tool>\nMiddle text\n<tool>\n   ▷\n    {"tool_call_id":"id-2","name":"list_dir"}\n   ▷\n</tool>\nEnd';
		const result = replaceToolBlocksWithPlaceholders(input);
		assert.strictEqual(result, 'Start\n<!--TOOL_CARD:id-1-->\nMiddle text\n<!--TOOL_CARD:id-2-->\nEnd');
	});

	test('handles <tool> + <document> + <tool_result> pattern', () => {
		const input = '我来帮你。\n<tool>\n   ▷\n    {"tool_call_id":"chatcmpl-tool-85a35a97","name":"list_dir","display_name":"查找目录中","render_type":"ListItems"}\n   ▷\n  <document>\n    {"path":"g:\\\\workspace2","sub_content":"g:\\\\workspace2"}\n  </document>\n</tool>\n<tool_result>\n  {"items":[]}\n</tool_result>\n分析完毕。';
		const result = replaceToolBlocksWithPlaceholders(input);
		assert.strictEqual(result, '我来帮你。\n<!--TOOL_CARD:chatcmpl-tool-85a35a97-->\n\n分析完毕。');
	});

	test('handles <tool> + <tool_result> with matching tool_call_id', () => {
		const input = 'Before\n<tool>\n   ▷\n    {"tool_call_id":"call-001","name":"read_file"}\n   ▷\n</tool>\n<tool_result tool_call_id="call-001">\n  File content here\n</tool_result>\nAfter';
		const result = replaceToolBlocksWithPlaceholders(input);
		assert.strictEqual(result, 'Before\n<!--TOOL_CARD:call-001-->\n<!--TOOL_CARD:call-001-->\nAfter');
	});

	test('preserves text with no tool blocks', () => {
		const input = 'Hello world, this is a normal response without any tool calls.';
		const result = replaceToolBlocksWithPlaceholders(input);
		assert.strictEqual(result, input);
	});

	test('handles empty string', () => {
		assert.strictEqual(replaceToolBlocksWithPlaceholders(''), '');
	});

	test('handles <custom> block with remove-tool directive (Knot AG-UI pattern)', () => {
		const input = '<tool>\n   ▷\n    {"tool_call_id":"a1a392cb-ff30-4dff-b686-c1b4b044cfdc","name":"task_planning","display_name":"任务规划中","render_type":"None","default_show":false}\n   ▷\n</tool>\n<custom>\n  {"tool_call_id":"a1a392cb-ff30-4dff-b686-c1b4b044cfdc","type":"remove-tool"}\n</custom>\n我来帮你分析当前工作路径下的文件内容。首先让我查看当前工作目录的结构。';
		const result = replaceToolBlocksWithPlaceholders(input);
		// <custom> removal leaves blank lines, but the placeholder and text are correct
		assert.ok(result.includes('<!--TOOL_CARD:a1a392cb-ff30-4dff-b686-c1b4b044cfdc-->'));
		assert.ok(result.includes('我来帮你分析当前工作路径下的文件内容'));
		assert.ok(!result.includes('<custom>'));
	});
});


// ════════════════════════════════════════════════════════════════════════════════
// § Test Suite: Integration - Placeholder + Sanitizer Pipeline
// ════════════════════════════════════════════════════════════════════════════════

suite('Integration - Placeholder + Sanitizer Pipeline', () => {

	test('HTML comment placeholders survive sanitizeAssistantVisibleText (streaming)', () => {
		const withPlaceholders = '我来帮你分析。\n<!--TOOL_CARD:abc-123-->\n分析结果如下。';
		const sanitized = sanitizeAssistantVisibleText(withPlaceholders, 'streaming');
		assert.ok(sanitized.includes('<!--TOOL_CARD:abc-123-->'));
	});

	test('HTML comment placeholders survive sanitizeAssistantVisibleText (delivery)', () => {
		const withPlaceholders = 'Some text\n<!--TOOL_CARD:xyz-789-->\nMore text';
		const sanitized = sanitizeAssistantVisibleText(withPlaceholders, 'delivery');
		assert.ok(sanitized.includes('<!--TOOL_CARD:xyz-789-->'));
	});

	test('full pipeline: Knot AG-UI streaming with tool+custom+text', () => {
		const llmOutput = `<tool>
   ▷
    {"tool_call_id":"a1a392cb-ff30-4dff-b686-c1b4b044cfdc","name":"task_planning","display_name":"任务规划中","render_type":"None","default_show":false}
   ▷
</tool>
<custom>
  {"tool_call_id":"a1a392cb-ff30-4dff-b686-c1b4b044cfdc","type":"remove-tool"}
</custom>
我来帮你分析当前工作路径下的文件内容。首先让我查看当前工作目录的结构。
<tool>
   ▷
    {"tool_call_id":"chatcmpl-tool-85a35a97e87a2aac","name":"list_dir","display_name":"查找目录中","render_type":"ListItems","default_show":false}
   ▷
  <document>
    {"path":"g:\\\\workspace2","sub_content":"g:\\\\workspace2","sub_content_tip":"g:\\\\workspace2"}
  </document>
</tool>
<tool_result>
  {"items":[{"content":".gitignore","item_type":"file"}]}
</tool_result>
我看到当前工作目录 g:\\workspace2 主要包含以下内容：`;

		const result = fullContentPipeline(llmOutput);

		// Both placeholders should be present
		assert.ok(result.includes('<!--TOOL_CARD:a1a392cb-ff30-4dff-b686-c1b4b044cfdc-->'));
		assert.ok(result.includes('<!--TOOL_CARD:chatcmpl-tool-85a35a97e87a2aac-->'));
		// Text segments should be present
		assert.ok(result.includes('我来帮你分析'));
		assert.ok(result.includes('我看到当前工作目录'));

		// Order: card1 → text1 → card2 → text2
		const idx1 = result.indexOf('<!--TOOL_CARD:a1a392cb');
		const idxText1 = result.indexOf('我来帮你分析');
		const idx2 = result.indexOf('<!--TOOL_CARD:chatcmpl-tool');
		const idxText2 = result.indexOf('我看到当前工作目录');
		assert.ok(idx1 < idxText1, `Expected idx1(${idx1}) < idxText1(${idxText1})`);
		assert.ok(idxText1 < idx2, `Expected idxText1(${idxText1}) < idx2(${idx2})`);
		assert.ok(idx2 < idxText2, `Expected idx2(${idx2}) < idxText2(${idxText2})`);
	});

	test('full pipeline: only tool blocks, no prose → placeholder preserved', () => {
		const llmOutput = '<tool>\n   ▷\n    {"tool_call_id":"only-tool","name":"read_file"}\n   ▷\n</tool>';
		const result = fullContentPipeline(llmOutput);
		assert.ok(result.includes('<!--TOOL_CARD:only-tool-->'));
	});

	test('full pipeline: mixed prose and tool blocks', () => {
		const llmOutput = 'Let me check the files.\n<tool>\n   ▷\n    {"tool_call_id":"tool-1","name":"list_dir"}\n   ▷\n</tool>\nHere are the results.';
		const result = fullContentPipeline(llmOutput);
		assert.ok(result.includes('<!--TOOL_CARD:tool-1-->'));
		assert.ok(result.includes('Let me check'));
		assert.ok(result.includes('Here are the results'));
	});

	test('full pipeline: <tool_result> with tool_call_id attribute preserved as placeholder', () => {
		const llmOutput = 'Before\n<tool>\n   ▷\n    {"tool_call_id":"call-x","name":"read_file"}\n   ▷\n</tool>\n<tool_result tool_call_id="call-x">\n  File contents\n</tool_result>\nAfter analysis.';
		const result = fullContentPipeline(llmOutput);
		const count = (result.match(/<!--TOOL_CARD:call-x-->/g) || []).length;
		assert.ok(count >= 1, `Expected at least 1 placeholder, got ${count}`);
		assert.ok(result.includes('Before'));
		assert.ok(result.includes('After analysis'));
	});

	test('sanitizer does not strip HTML comments from placeholder', () => {
		const placeholder = '<!--TOOL_CARD:test-id-123-->';
		const result = sanitizeAssistantVisibleText(placeholder, 'streaming');
		assert.strictEqual(result, placeholder);
	});

	test('isEntirelyToolCallContent returns false when text has placeholders + prose', () => {
		const text = '<!--TOOL_CARD:abc-->Some meaningful text here';
		assert.strictEqual(isEntirelyToolCallContent(text), false);
	});

	test('a lone placeholder is not classified as tool call content', () => {
		const text = '<!--TOOL_CARD:abc-->';
		assert.strictEqual(isEntirelyToolCallContent(text), false);
	});
});


// ════════════════════════════════════════════════════════════════════════════════
// § Test Suite: End-to-End Streaming Simulation
// ════════════════════════════════════════════════════════════════════════════════

suite('E2E Streaming Simulation', () => {

	test('Knot AG-UI bug scenario: tool cards should be interleaved, not at bottom', () => {
		const llmOutput = `<tool>
   ▷
    {"tool_call_id":"a1a392cb-ff30-4dff-b686-c1b4b044cfdc","name":"task_planning","display_name":"任务规划中","render_type":"None","default_show":false}
   ▷
</tool>
<custom>
  {"tool_call_id":"a1a392cb-ff30-4dff-b686-c1b4b044cfdc","type":"remove-tool"}
</custom>
我来帮你分析当前工作路径下的文件内容。首先让我查看当前工作目录的结构。
<tool>
   ▷
    {"tool_call_id":"chatcmpl-tool-85a35a97e87a2aac","name":"list_dir","display_name":"查找目录中","render_type":"ListItems","default_show":false}
   ▷
  <document>
    {"path":"g:\\\\workspace2","sub_content":"g:\\\\workspace2","sub_content_tip":"g:\\\\workspace2"}
  </document>
</tool>
<tool_result>
  {"items":[{"content":".gitignore","item_type":"file"}]}
</tool_result>
我看到当前工作目录 g:\\workspace2 主要包含以下内容：`;

		// Step 1: Replace placeholders (always, even if assistantToolCalls is populated)
		const afterReplace = replaceToolBlocksWithPlaceholders(llmOutput);

		// Step 2: Sanitize
		const afterSanitize = sanitizeAssistantVisibleText(afterReplace, 'streaming');

		// Step 3: Parse interleaved output (frontend simulation)
		const toolCallIds = [
			'a1a392cb-ff30-4dff-b686-c1b4b044cfdc',
			'chatcmpl-tool-85a35a97e87a2aac',
		];
		const interleaved = parseInterleavedOutput(afterSanitize, toolCallIds);

		assert.ok(interleaved.length >= 3, `Expected at least 3 elements, got ${interleaved.length}`);

		// Find positions
		const card1Idx = interleaved.findIndex(e => e.type === 'card' && e.value === 'a1a392cb-ff30-4dff-b686-c1b4b044cfdc');
		const text1Idx = interleaved.findIndex(e => e.type === 'text' && e.value.includes('我来帮你分析'));
		const card2Idx = interleaved.findIndex(e => e.type === 'card' && e.value === 'chatcmpl-tool-85a35a97e87a2aac');
		const text2Idx = interleaved.findIndex(e => e.type === 'text' && e.value.includes('我看到当前工作目录'));

		assert.ok(card1Idx >= 0, 'card1Idx not found');
		assert.ok(text1Idx >= 0, 'text1Idx not found');
		assert.ok(card2Idx >= 0, 'card2Idx not found');
		assert.ok(text2Idx >= 0, 'text2Idx not found');

		// THE KEY ASSERTION: Cards must be interleaved, not all at the bottom
		assert.ok(card1Idx < text1Idx, `Expected card1Idx(${card1Idx}) < text1Idx(${text1Idx})`);
		assert.ok(text1Idx < card2Idx, `Expected text1Idx(${text1Idx}) < card2Idx(${card2Idx})`);
		assert.ok(card2Idx < text2Idx, `Expected card2Idx(${card2Idx}) < text2Idx(${text2Idx})`);
	});

	test('OpenAI streaming + XML embedding: both paths handled', () => {
		const textWithXml = 'Checking the directory now.\n<tool>\n   ▷\n    {"tool_call_id":"stream-tool-1","name":"list_dir"}\n   ▷\n</tool>\nDone checking.';

		const afterReplace = replaceToolBlocksWithPlaceholders(textWithXml);
		const afterSanitize = sanitizeAssistantVisibleText(afterReplace, 'streaming');

		assert.ok(afterSanitize.includes('<!--TOOL_CARD:stream-tool-1-->'));
		assert.ok(afterSanitize.includes('Checking the directory'));
		assert.ok(afterSanitize.includes('Done checking'));
	});

	test('Streaming chunks: incremental content build-up', () => {
		const chunks = [
			'Let me',
			' check that.\n<tool>\n',
			'   ▷\n    {"tool_call_id":"inc-1","name":"read_file"}\n   ▷\n</tool>\n',
			'Here is the result.',
		];

		let accumulated = '';
		for (const chunk of chunks) {
			accumulated += chunk;
		}

		const result = fullContentPipeline(accumulated);
		assert.ok(result.includes('<!--TOOL_CARD:inc-1-->'));
		assert.ok(result.includes('check that'));
		assert.ok(result.includes('Here is the result'));
	});

	test('Multiple tool calls in sequence with interleaved text', () => {
		const llmOutput = `Step 1: Planning
<tool>
   ▷
    {"tool_call_id":"step-1","name":"plan","display_name":"规划中"}
   ▷
</tool>
<custom>
  {"tool_call_id":"step-1","type":"remove-tool"}
</custom>
Step 2: Searching
<tool>
   ▷
    {"tool_call_id":"step-2","name":"search","display_name":"搜索中"}
   ▷
</tool>
<custom>
  {"tool_call_id":"step-2","type":"remove-tool"}
</custom>
Step 3: Reading
<tool>
   ▷
    {"tool_call_id":"step-3","name":"read_file","display_name":"读取中"}
   ▷
</tool>
Final summary here.`;

		const result = fullContentPipeline(llmOutput);
		const toolIds = ['step-1', 'step-2', 'step-3'];
		const interleaved = parseInterleavedOutput(result, toolIds);

		// All three cards should be present
		assert.ok(interleaved.some(e => e.type === 'card' && e.value === 'step-1'));
		assert.ok(interleaved.some(e => e.type === 'card' && e.value === 'step-2'));
		assert.ok(interleaved.some(e => e.type === 'card' && e.value === 'step-3'));

		// Verify no adjacent cards (each should have text between them)
		for (let i = 1; i < interleaved.length; i++) {
			if (interleaved[i].type === 'card' && interleaved[i - 1].type === 'card') {
				const seq = interleaved.map(e => e.type === 'card' ? `CARD:${e.value}` : 'TEXT').join(' → ');
				assert.fail(`Adjacent cards at positions ${i - 1} and ${i} — missing interleaving text! Sequence: ${seq}`);
			}
		}
	});

	test('Orphan card fallback: cards without placeholders append to end', () => {
		const textOnly = 'I will read the file now.';
		const processed = fullContentPipeline(textOnly);
		const toolCallIds = ['orphan-tool-1'];

		const interleaved = parseInterleavedOutput(processed, toolCallIds);
		const lastElement = interleaved[interleaved.length - 1];
		assert.strictEqual(lastElement.type, 'card');
		assert.strictEqual(lastElement.value, 'orphan-tool-1');
	});

	test('content_replace is always emitted when assistantContent exists', () => {
		const content = 'Text before\n<tool>\n   ▷\n    {"tool_call_id":"dual-1","name":"list_dir"}\n   ▷\n</tool>\nText after';
		const result = fullContentPipeline(content);

		assert.ok(result.includes('<!--TOOL_CARD:dual-1-->'));
		assert.ok(!result.includes('<tool>'));
		assert.ok(!result.includes('</tool>'));
	});

	test('Document sub-elements inside <tool> are properly cleaned', () => {
		const content = `<tool>
   ▷
    {"tool_call_id":"doc-tool","name":"list_dir","display_name":"查找目录中","render_type":"ListItems"}
   ▷
  <document>
    {"path":"g:\\\\workspace2","sub_content":"g:\\\\workspace2"}
  </document>
</tool>
Here are the results.`;

		const afterReplace = replaceToolBlocksWithPlaceholders(content);
		assert.ok(!afterReplace.includes('<document>'));
		assert.ok(afterReplace.includes('<!--TOOL_CARD:doc-tool-->'));

		const afterSanitize = sanitizeAssistantVisibleText(afterReplace, 'streaming');
		assert.ok(afterSanitize.includes('<!--TOOL_CARD:doc-tool-->'));
		assert.ok(afterSanitize.includes('Here are the results'));
	});
});

// ════════════════════════════════════════════════════════════════════════════════
// § `<tag:id>` 伪标签剥离
//   日志 1788011997897 实证：`tool_sep` 不在剥离名单里，从未能被剥离，
//   一路残留进历史并**逐轮累积**（L8944 两条 → L9282 四条），
//   导致 sanitize 后仍有大量残留（原 973c → 600c）。
// ════════════════════════════════════════════════════════════════════════════════

suite('Tagged-id pseudo XML stripping', () => {

	const ID = '6124c78e';

	test('剥离全部已知变体，残留标签必须为 0', () => {
		// 依据日志 snippet 重建：模型讨论 "Hermes's `tool` role replay" 时举例写下伪 XML
		const text =
			'op exit and Hermes\'s `tool` role replay.' +
			`<tool_calls:${ID}>\n` +
			`<tool_call:${ID}>file_read<tool_sep:${ID}>\n` +
			'path G:\\CustomWorkspaces\\AIProjects\\opencode\n' +
			`<tool_call:${ID}>search_files<tool_sep:${ID}>\n` +
			`<tool_sep:${ID}>\n` +
			'Then Hermes replays it via the `tool` role.';
		const out = sanitizeAssistantVisibleText(text, 'streaming');
		assert.strictEqual(locateTaggedIdXmlTags(out, 20).length, 0, 'no tag may survive sanitize');
		// 只剥标签，不删内容 —— 删除标签间内容会误伤正常讨论
		assert.ok(out.includes('file_read'), 'content between tags must survive');
		assert.ok(out.includes('Hermes'), 'surrounding prose must survive');
	});

	test('仅有 tool_sep 时也不得早退（原守卫漏检场景）', () => {
		// 原早退守卫 TOOL_CALL_XML_QUICK_RE 是标签名**白名单**，其中**不含 tool_sep**，
		// 纯 tool_sep 文本会命中早退直接返回，一个都剥不掉。
		const out = sanitizeAssistantVisibleText('some prose <tool_sep:' + ID + '> and more', 'streaming');
		assert.strictEqual(locateTaggedIdXmlTags(out, 5).length, 0, 'lone tool_sep must be stripped');
		assert.ok(out.includes('some prose'), 'prose must survive');
	});

	test('未知变体也能剥离（按形态而非名单）', () => {
		// 逐个枚举标签名永远追不上模型的新变体（tool_sep 就是漏掉的那个），
		// 故必须按 `<tag:id>` **形态**整体剥离。
		for (const t of ['<foo:123456>', '<my_tag:deadbeef>', '<ns.tag:abc123>']) {
			const out = sanitizeAssistantVisibleText('a ' + t + ' b', 'streaming');
			assert.strictEqual(locateTaggedIdXmlTags(out, 5).length, 0, `${t} must be stripped`);
		}
	});

	test('正常内容不得被改动（展示文本，误删代价高）', () => {
		for (const t of [
			'visit <http://example.com:8080> now',
			'<a href="x">link</a>',
			'meeting at 12:30 sharp',
			'const x = List<String>();',
			'The tool calls: 3 functions were invoked.',
			'使用 tool_calls 字段发起调用',
		]) {
			assert.strictEqual(sanitizeAssistantVisibleText(t, 'streaming'), t, `must not alter: ${t}`);
		}
	});

	test('讨论性散文应完整保留（避免误伤正常讨论）', () => {
		const prose = 'Hermes replays tool results via the `tool` role, while openclaw uses `tool_result`.';
		assert.strictEqual(sanitizeAssistantVisibleText(prose, 'streaming'), prose);
	});

	// ══════════════════════════════════════════════════════════════════════════
	// 代码区保护：模型**举例讨论**调用格式是正当内容，不得抹掉
	// 参照 openclaw `src/shared/text/code-regions.ts`（其测试明确断言
	// "preserves ... inside inline and fenced code"）。
	// 本项目的伪 XML 泄漏恰恰高发于「模型在对比几个项目的提示词格式」这类
	// 讨论场景 —— 此时用户想看的就是那段示例，抹掉等于删答案。
	// ══════════════════════════════════════════════════════════════════════════

	test('围栏代码块内的伪 XML 示例必须保留（那是用户要看的答案）', () => {
		const fenced = [
			'Hermes 用的是这种写法：',
			'```xml',
			`<tool_calls:${ID}>`,
			`<tool_call:${ID}>file_read<tool_sep:${ID}>`,
			'</tool_calls>',
			'```',
			'以上是它的格式。',
		].join('\n');
		const out = sanitizeAssistantVisibleText(fenced, 'streaming');
		assert.ok(out.includes(`<tool_calls:${ID}>`), 'fenced example must survive');
		assert.ok(out.includes(`<tool_sep:${ID}>`), 'fenced tool_sep must survive');
		assert.ok(out.includes('以上是它的格式。'), 'prose after fence must survive');
	});

	test('行内代码内的伪 XML 示例必须保留', () => {
		const inline = 'openclaw 用 `' + `<arg_key:${ID}>` + '` 标记参数名。';
		const out = sanitizeAssistantVisibleText(inline, 'streaming');
		assert.ok(out.includes(`<arg_key:${ID}>`), 'inline example must survive');
	});

	test('★ 代码区保护不得削弱正文剥离（回归防线）', () => {
		// 加保护最容易犯的错是「保护过头」—— 连正文里的真泄漏一起放过。
		// 本例同时有「正文泄漏」与「代码块示例」，二者必须被区别对待：
		// 前者要剥、后者要留。此用例是该机制的生死线。
		const mixed =
			'我打算读取文件 <tool_calls:' + ID + '>\n' +
			'```\n<tool_call:' + ID + '>example</tool_call>\n```\n' +
			'结束。';
		const out = sanitizeAssistantVisibleText(mixed, 'streaming');
		assert.ok(!out.includes('<tool_calls:' + ID + '>'), 'leak in prose must still be stripped');
		assert.ok(out.includes('<tool_call:' + ID + '>example</tool_call>'), 'fenced example must still survive');
	});

	test('未闭合围栏：自围栏起至文末均视为代码区', () => {
		// 流式场景常见：围栏尚未闭合就已被截断层，此时尾部内容应受保护，
		// 否则会出现「代码块内容被拦腰截断」的残缺展示。
		const text = '例如：\n```xml\n' + `<tool_sep:${ID}>`;
		const out = sanitizeAssistantVisibleText(text, 'streaming');
		assert.ok(out.includes(`<tool_sep:${ID}>`), 'unclosed fence must protect to EOF');
	});
});
