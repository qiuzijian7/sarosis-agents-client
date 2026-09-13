/*---------------------------------------------------------------------------------------------
 *  codebaseGraphWorkerCode.test.ts — Worker 内嵌代码的语法自检。
 *
 *  为什么需要它：`buildWorkerCode()` 返回的是**字符串内嵌的 JS**（Blob URL 方式创建
 *  Worker），不受 tsgo / lint 检查——语法错误只会在运行时表现为「Worker 脚本求值失败」，
 *  现象是解析整体 fallback 主线程、日志里只有一句 init timeout，极难定位。
 *
 *  本测试用 `new Function(code)` 做**纯语法校验**（不执行），把这类错误提前到测试阶段。
 *
 *  运行：
 *    node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *        src/vs/sessions/contrib/agentStudio/test/browser/codebaseGraphWorkerCode.test.ts
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { buildWorkerCode } from '../../browser/codebaseGraphWorkerCode.js';

suite('CodebaseGraphWorkerCode (syntax self-check)', () => {

	test('generated worker code is syntactically valid JS', () => {
		// 用一段最小占位代替真实 tree-sitter.js（自检只关心模板拼接后的整体语法）
		const code = buildWorkerCode('/* tree-sitter.js placeholder */');
		assert.ok(code.length > 1000, 'worker code should be substantial');
		// 纯语法校验：不执行，仅解析
		assert.doesNotThrow(() => new Function(code), 'worker code must parse as valid JS');
	});

	test('worker code carries the AMD shim, AST map and message protocol', () => {
		const code = buildWorkerCode('/* placeholder */');
		// 契约性检查：这几处是 Worker 与主线程通信/解析的基础，改名即会破坏协议
		assert.ok(code.includes('self.define.amd'), 'AMD shim present');
		assert.ok(code.includes('AST_TO_NODE_TYPE'), 'AST node type map inlined');
		assert.ok(code.includes("'init-done'"), 'init-done protocol');
		assert.ok(code.includes("'parse-result'"), 'parse-result protocol');
	});

	test('interpolation of the real tree-sitter source does not break the template', () => {
		// 传入含反引号/美元符的"源码"，确认未被模板字符串错误解析
		const tricky = 'const tpl = `a${b}c`; // eslint-disable-line';
		const code = buildWorkerCode(tricky);
		assert.ok(code.includes(tricky), 'source must be inlined verbatim');
		assert.doesNotThrow(() => new Function(code), 'still valid JS with tricky source');
	});
});
