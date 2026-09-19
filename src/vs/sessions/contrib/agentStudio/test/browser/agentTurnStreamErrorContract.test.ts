/**
 * S3b 抽取的接线 + 行为契约 —— `handleTurnStreamError`（browser/turnLlmStream.ts）。
 *
 * ## 背景
 *
 * 原 catch 块（agentTurnExecutor.ts :2997-3090）内联在主循环里，无法单测：
 * 它同时做四件事——瞬态重试、溢出压缩重试、首 token 超时重试、致命失败收尾——
 * 且用 `continue` / `break` / `throw` 三种方式把控制流交回外层 `while`。
 *
 * 抽出后控制流改为 `CatchDisposition`（`retry` / `break-loop`），本文件锁住两件事：
 *   1. **接线**：executor 必须按 disposition 正确 translate 回 continue / break
 *      （漏掉 translate 会让重试静默失效——表现为"抖动即断线"，且不报错）。
 *   2. **行为**：四类异常各自走对分支，尤其是「瞬态错误不该吞掉 TimeoutError」
 *      与「溢出压缩只做一次」这两条既有语义。
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const BROWSER_DIR = 'src/vs/sessions/contrib/agentStudio/browser';
const EXECUTOR = `${BROWSER_DIR}/agentTurnExecutor.ts`;
const TURN_LLM_STREAM = `${BROWSER_DIR}/turnLlmStream.ts`;

function read(rel: string): string {
	return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

/** 去掉整行 `//` 注释，避免注释里的字样造成误判。 */
function stripLineComments(src: string): string {
	return src
		.split('\n')
		.filter(line => !/^\s*\/\//.test(line))
		.join('\n');
}

suite('S3b — 流异常处置段抽取（接线不变量）', () => {

	test('executor 从 turnLlmStream 导入 handleTurnStreamError', () => {
		const src = read(EXECUTOR);
		assert.ok(
			/handleTurnStreamError/.test(src),
			'executor 未导入/使用 handleTurnStreamError —— 抽取后必须接线',
		);
		assert.ok(
			/import\s*\{[^}]*handleTurnStreamError[^}]*\}\s*from\s*'\.\/turnLlmStream\.js'/.test(src),
			'handleTurnStreamError 必须来自 ./turnLlmStream.js',
		);
	});

	test('catch 块通过 yield* 委托（generator 语义，保证压缩事件流透传）', () => {
		const src = stripLineComments(read(EXECUTOR));
		assert.ok(
			/yield\*\s*handleTurnStreamError\s*\(/.test(src),
			'必须用 `yield*` 而非普通调用 —— 否则 compressContext 的 yield 会丢失',
		);
	});

	test('disposition 被 translate 回 continue / break（漏掉会让重试静默失效）', () => {
		const src = stripLineComments(read(EXECUTOR));
		assert.ok(
			/_catchDisposition\.kind\s*===\s*'retry'/.test(src),
			'未按 retry 分支 continue —— 瞬态错误将不再重试',
		);
		assert.ok(
			/if\s*\(\s*_catchDisposition\.kind\s*===\s*'retry'\s*\)\s*\{\s*\n\s*continue;\s*\n\s*\}\s*\n\s*break;/.test(src),
			'retry → continue 且其后 break 的形态被破坏',
		);
	});

	test('idle 超时仍向上抛（须冒泡到 _executeWithFallback 切备用模型）', () => {
		const src = stripLineComments(read(TURN_LLM_STREAM));
		assert.ok(
			/if\s*\(\s*isTimeout\s*\)\s*\{\s*\n\s*throw error;/.test(src),
			'idle 超时未 throw —— 备用模型切换链路会断',
		);
	});
});

suite('S3b — handleTurnStreamError 行为', () => {

	test('调用方以 compressContext(true) 强制压缩（绕过阈值判定）', () => {
		const src = stripLineComments(read(EXECUTOR));
		assert.ok(
			/compressContext:\s*_compressContextIfNeeded/.test(src),
			'必须把 _compressContextIfNeeded 作为 compressContext 注入',
		);
	});

	test('溢出压缩只做一次（overflowCompressionDone 单向置位）', () => {
		const src = stripLineComments(read(TURN_LLM_STREAM));
		assert.ok(
			/loopState\.overflowCompressionDone\s*=\s*true/.test(src),
			'溢出压缩未置位 done —— 会无限压缩重试',
		);
		assert.ok(
			/!loopState\.overflowCompressionDone/.test(src),
			'缺少 done 前置判定 —— 无法保证只压缩一次',
		);
	});

	test('瞬态重试受上限约束，且 TimeoutError 被排除在瞬态分支外', () => {
		const src = stripLineComments(read(TURN_LLM_STREAM));
		assert.ok(
			/!isTimeout\s*&&\s*isTransientStreamError\(error\)/.test(src),
			'瞬态分支未排除 TimeoutError —— 会与 fallback 切换语义冲突',
		);
		assert.ok(
			/deps\.retry\(\)\.transientError\s*<\s*TRANSIENT_ERROR_MAX_RETRIES/.test(src),
			'瞬态重试缺少上限判定',
		);
	});

	test('致命失败时为悬挂 tool_start 补发合成 tool_result + tool_end', () => {
		const src = stripLineComments(read(TURN_LLM_STREAM));
		assert.ok(
			/type:\s*'tool_result'[\s\S]{0,200}type:\s*'tool_end'/.test(src),
			'未补发 tool_end —— webview 会残留永不消失的 spinner',
		);
		assert.ok(
			/deps\.endedToolIds\.add\(orphanId\)/.test(src),
			'未登记 endedToolIds —— 同一 id 可能被重复补发',
		);
	});

	test('phase=error 通过回调回写（抽出后不持有 runState 引用）', () => {
		const src = stripLineComments(read(EXECUTOR));
		assert.ok(
			/setPhaseError:\s*\(\)\s*=>\s*\{[^}]*SET_PHASE[^}]*phase:\s*'error'/.test(src),
			'phase=error 未通过回调回写 —— runState 更新会丢失',
		);
	});
});
