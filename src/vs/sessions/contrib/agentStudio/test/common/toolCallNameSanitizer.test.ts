/*---------------------------------------------------------------------------------------------
 *  toolCallNameSanitizer.test.ts — 工具名伪 XML 归一化（2026-09-21，真机取证）
 *
 *  铁证（`http-debug-2026-09-21.log` 的 SSE 原文）：
 *      "tool_calls":[{"id":"chatcmpl-tool-a38f49a6f8e1295b","type":"function",
 *        "function":{"name":"index_status</tool_call:6124c78e><tool_call:6124c78e>search_files",
 *                    "arguments":""}}]
 *      紧随的 chunk 携带 arguments={"pattern":"*ession*","mode":"files","path":...}
 *      ⇒ **args 属于最后一个 tag**（search_files）⇒ 归一化取最后一个合法 token 语义正确。
 *  此前坏名字一路走到 piLoop `prepareToolCall` → 「未找到名为…的工具」→ 白烧一轮 + 失败卡。
 *
 *  本文件钉住：
 *    ① 归一化助手的行为矩阵（合并名/单名+尾巴/纯标记/正常名/无合法 token）；
 *    ② 链路接线：LMBridge 唯一出口必须归一化（UI 卡/执行/落盘共用一条路径）；
 *    ③ piLoop `prepareToolCall` 对仍带标记的名字给**纠正指令**而非泛泛的「未找到」。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/common/toolCallNameSanitizer.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { hasPseudoXmlMarkers, sanitizeToolCallName } from '../../common/toolCallNameSanitizer.js';

suite('toolCallNameSanitizer —— 伪 XML 泄漏归一化', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('★★★ 真机案例：两个并行调用被粘成一个名字 ⇒ 取最后一个（args 属最后一个 tag）', () => {
		const r = sanitizeToolCallName('index_status</tool_call:6124c78e><tool_call:6124c78e>search_files');
		assert.strictEqual(r.name, 'search_files', '必须取最后一个合法 token ✗');
		assert.strictEqual(r.repaired, true);
		assert.strictEqual(r.tainted, true);
		assert.deepStrictEqual([...r.fragments], ['index_status', 'search_files'],
			'fragments 必须保留全部片段（日志/判读用）✗');
	});

	test('单名 + 尾巴标记 ⇒ 归一化为该名', () => {
		const r = sanitizeToolCallName('search_files</tool_call:6124c78e>');
		assert.strictEqual(r.name, 'search_files');
		assert.strictEqual(r.repaired, true);
		assert.strictEqual(r.tainted, true);
		assert.deepStrictEqual([...r.fragments], ['search_files']);
	});

	test('前置标记 ⇒ 取后续合法 token', () => {
		const r = sanitizeToolCallName('<tool_call:6124c78e>file_read');
		assert.strictEqual(r.name, 'file_read');
		assert.strictEqual(r.repaired, true);
	});

	test('数字 id 形态（`<tool_call:12>`）同样算标记', () => {
		const r = sanitizeToolCallName('search_code<tool_call:12>');
		assert.strictEqual(r.name, 'search_code');
		assert.strictEqual(r.repaired, true);
	});

	test('★ 有标记但无合法 token ⇒ 不猜测，保持原值（tainted=true，交调用方上报）', () => {
		const r = sanitizeToolCallName('</tool_call:6124c78e>');
		assert.strictEqual(r.name, '</tool_call:6124c78e>', '取不出合法 token 不得硬改 ✗');
		assert.strictEqual(r.repaired, false);
		assert.strictEqual(r.tainted, true);
	});

	test('正常名字一律不动（无标记、非 token 片段也不误伤）', () => {
		for (const n of ['search_files', 'index_status', 'mermaid_render', 'kb_topic_overviews']) {
			const r = sanitizeToolCallName(n);
			assert.strictEqual(r.name, n);
			assert.strictEqual(r.repaired, false);
			assert.strictEqual(r.tainted, false);
			assert.deepStrictEqual([...r.fragments], []);
		}
	});

	test('片段中的非 token 文本（如 `{`）不参与选择', () => {
		// 模型把 JSON 片头写进 name 的情形：只有合法 token 能当选
		const r = sanitizeToolCallName('index_status</tool_call:6124c78e>{');
		assert.strictEqual(r.name, 'index_status', '无合法 token 时不得取垃圾片段；这里 index_status 是唯一合法 token ✓');
	});

	test('hasPseudoXmlMarkers：只认 <tag:hexid> 形态，不误伤普通名字', () => {
		assert.strictEqual(hasPseudoXmlMarkers('index_status</tool_call:6124c78e>search_files'), true);
		assert.strictEqual(hasPseudoXmlMarkers('search_files'), false);
		assert.strictEqual(hasPseudoXmlMarkers('a<b>c'), false);
		assert.strictEqual(hasPseudoXmlMarkers(undefined), false);
		assert.strictEqual(hasPseudoXmlMarkers(''), false);
	});

	test('★★★ 链路接线：LMBridge 唯一出口必须归一化（UI/执行/落盘共用一条路径 ✓）', () => {
		const src = fs.readFileSync(path.join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/browser/languageModelsBridge.ts'), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		const idx = src.indexOf("case 'tool_use'");
		assert.ok(idx !== -1, '找不到 tool_use 分支 ✗');
		const block = src.slice(idx, idx + 2600);
		assert.ok(block.includes('sanitizeToolCallName(toolPart.name)'), 'LMBridge 必须归一化 toolPart.name ✗');
		assert.ok(block.includes('name: sanitizedName.name'), '归一化后的名字必须进 delta（不得再裸用 toolPart.name ✗）');
		assert.ok(block.includes('tool_call name 含伪 XML 标记'), '归一化必须留 WARN 可观测痕迹 ✗');
	});

	test('★★★ piLoop：仍带标记的未知名字 ⇒ 纠正指令（勿盲重试）而非泛泛「未找到」', () => {
		const src = fs.readFileSync(path.join(process.cwd(), 'src/vs/sessions/contrib/agentStudio/browser/piLoop/agentLoop.ts'), 'utf8')
			.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
		const idx = src.indexOf('if (!tool) {');
		assert.ok(idx !== -1, '找不到未知工具分支 ✗');
		const block = src.slice(idx, idx + 1200);
		assert.ok(block.includes('hasPseudoXmlMarkers(toolCall.name)'), '未知工具分支必须先查伪 XML 标记 ✗');
		assert.ok(block.includes('逐个重新发起调用'), '必须给出纠正指令（让模型改用原生逐个调用 ✗）');
		// 纠正分支必须在泛泛「未找到」之前
		const corrective = block.indexOf('hasPseudoXmlMarkers(toolCall.name)');
		const generic = block.indexOf('未找到名为');
		assert.ok(corrective !== -1 && generic !== -1 && corrective < generic, '纠正分支必须在泛泛报错之前 ✗');
	});
});
