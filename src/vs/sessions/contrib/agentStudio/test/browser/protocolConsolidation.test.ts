/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 协议解析收敛守卫：node 与 renderer 必须共用 `common/protocols/sseParsers.ts`。
 *
 * 背景（2026-09-19 实测）：同一套 SSE 解析逻辑曾存在**三份逐行重复的拷贝** ——
 *   - `common/protocols/sseParsers.ts`（抽出后**无人调用**，是死代码）
 *   - `node/llmBridgeNode.ts`          （5 个 `_` 前缀私有函数，活跃）
 *   - `browser/builtInBYOKModelProvider.ts`（5 个 `private _` 方法，活跃）
 * 后果：修 bug 要改三处；且三份已经漂移 ——
 *   renderer 版的 `_extractUsage` **不产出 `reasoning`**（common 版产出），
 *   渲染进程因而丢失推理 token 计数，而这条路径没有任何测试覆盖。
 *
 * 修复：删除 node/renderer 两份私有拷贝，两侧改 import common 版；
 * renderer 独有的日志（KV-cache 命中 / fallback 解析失败）改为通过
 * `onCacheHit` / `onParseError` 回调注入，能力不因收敛而丢失。
 *
 * 本测试用源码文本断言固化「不得再长出私有拷贝」——
 * 无法 import 这两个文件（`browser/` 依赖 DOM、`node/` 依赖 electron），故断言文本。
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/** 测试被打包进临时 .cjs，`__dirname` 指向临时目录，故从 cwd（仓库根）解析。 */
const STUDIO = path.resolve(
	process.cwd(),
	'src/vs/sessions/contrib/agentStudio',
);

function readStudioFile(relativePath: string): string {
	return fs.readFileSync(path.join(STUDIO, relativePath), 'utf8');
}

/**
 * 解析函数的「定义」形态（而非调用）。
 *
 * 同时匹配私有/导出的定义写法，避免漏判：
 *   `export function extractUsage(` / `function _extractUsage(` / `private _extractUsage(`
 */
const PARSER_DEFINITION_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
	{ name: 'extractJsonPayload', pattern: /^\s*(?:export\s+)?function\s+_?extractJsonPayload\s*\(|^\s*private\s+_?extractJsonPayload\s*\(/m },
	{ name: 'extractUsage', pattern: /^\s*(?:export\s+)?function\s+_?extractUsage\s*\(|^\s*private\s+_?extractUsage\s*\(/m },
	{ name: 'parseContentFromJson', pattern: /^\s*(?:export\s+)?function\s+_?parseContentFromJson\s*\(|^\s*private\s+_?parseContentFromJson\s*\(/m },
	{ name: 'parseToolCall', pattern: /^\s*(?:export\s+)?function\s+_?parseToolCall\s*\(|^\s*private\s+_?parseToolCall\s*\(/m },
	{ name: 'processRemainingBuffer', pattern: /^\s*(?:export\s+)?function\s+_?processRemainingBuffer\s*\(|^\s*private\s+_?processRemainingBuffer\s*\(/m },
	{ name: 'parseFullJsonFallback', pattern: /^\s*(?:export\s+)?function\s+_?parseFullJsonFallback\s*\(|^\s*private\s+_?parseFullJsonFallback\s*\(/m },
];

suite('协议解析收敛 — common 单一实现', () => {

	for (const { relativePath, label } of [
		{ relativePath: 'node/llmBridgeNode.ts', label: 'node/llmBridgeNode.ts' },
		{ relativePath: 'browser/builtInBYOKModelProvider.ts', label: 'browser/builtInBYOKModelProvider.ts' },
	]) {
		test(`★ ${label} 不得再定义私有解析函数（必须复用 common 版）`, () => {
			const source = readStudioFile(relativePath);
			const offenders = PARSER_DEFINITION_PATTERNS
				.filter(({ pattern }) => pattern.test(source))
				.map(({ name }) => name);

			assert.deepStrictEqual(
				offenders, [],
				`${label} 重新出现了私有解析函数：${offenders.join(', ')}\n` +
				'这些实现必须来自 common/protocols/sseParsers.js —— ' +
				'历史上三份拷贝已经漂移（renderer 版丢失 reasoning token 计数）。',
			);
		});

		test(`★ ${label} 必须复用 common 版（直接 import 解析器，或 import common 编排）`, () => {
			const source = readStudioFile(relativePath);
			// ⚠ 2026-10-14 修：原先只认"直接 import `../common/protocols/sseParsers.js`"。此后编排又
			//   下沉了一层：renderer 现在 import 的是 `runChatStream.js`（重试退避 → 读流 → 解析 → done
			//   收尾，与主进程路径**共用同一实现**）+ `requestBuilder.js`，真正解析的那几个函数由 common
			//   内部 import ⇒ 这是**更深的收敛**，不是回退 ✓（判据写死成"必须直接 import sseParsers"
			//   会把更彻底的收敛误判成红 ✗）。这里改认"落到 common/protocols 的任一入口"✓，
			//   并**另用一条断言钉住那条链**（见下面 suite：编排层自己必须 import sseParsers）✓。
			assert.ok(
				/from\s+'\.\.\/common\/protocols\/(?:sseParsers|runChatStream|requestBuilder)\.js'/.test(source),
				`${label} 未复用 common/protocols 的解析/编排 —— 收敛已回退。`,
			);
		});
	}

	test('★ common 版是唯一的解析实现来源', () => {
		const source = readStudioFile('common/protocols/sseParsers.ts');
		const missing = PARSER_DEFINITION_PATTERNS
			.filter(({ pattern }) => !pattern.test(source))
			.map(({ name }) => name);

		assert.deepStrictEqual(
			missing, [],
			`common/protocols/sseParsers.ts 缺少这些实现：${missing.join(', ')}`,
		);
	});

	suite('收敛不得丢失能力（renderer 独有行为已改为回调注入）', () => {

		test('★ 收敛链不许断：common 编排层自己必须 import `./sseParsers.js`', () => {
			// 上面那条已放宽为"import 任一 common/protocols 入口"（编排下沉后 renderer 不再直接引用
			// 解析器 ✓）⇒ **这条负责钉住链的另一半**：编排层必须真的落到 sseParsers，否则"renderer 只
			// import 编排"会变成"没人用 common 解析器"、两边又能各自长出私有实现 ✗。
			for (const rel of ['common/protocols/runChatStream.ts', 'common/protocols/protocolRegistry.ts']) {
				assert.ok(
					/from\s+'\.\/sseParsers\.js'/.test(readStudioFile(rel)),
					`${rel} 必须 import './sseParsers.js' —— 它是解析层的唯一上游，断了收敛链就名存实亡 ✗`,
				);
			}
		});

		test('★ common 版 extractUsage 必须产出 reasoning token（renderer 旧版曾丢失）', () => {
			const source = readStudioFile('common/protocols/sseParsers.ts');
			assert.ok(
				/reasoning/.test(source),
				'extractUsage 必须解析 completion_tokens_details.reasoning_tokens；' +
				'renderer 的旧私有实现缺这一项，收敛时应以其为基准会丢失推理 token 计数。',
			);
		});

		test('★ processRemainingBuffer 必须接受 onCacheHit（renderer 的 KV-cache 日志靠它）', () => {
			const source = readStudioFile('common/protocols/sseParsers.ts');
			const fnStart = source.indexOf('export function processRemainingBuffer');
			assert.ok(fnStart >= 0, '未找到 processRemainingBuffer');
			const signature = source.slice(fnStart, source.indexOf('): IModelDelta[]', fnStart));
			assert.ok(
				/onCacheHit/.test(signature),
				'processRemainingBuffer 必须暴露 onCacheHit 参数，' +
				'否则 renderer 的 KV-cache 命中日志会静默消失。',
			);
		});

		test('★ parseFullJsonFallback 必须接受 onParseError（renderer 的失败诊断靠它）', () => {
			const source = readStudioFile('common/protocols/sseParsers.ts');
			const fnStart = source.indexOf('export function parseFullJsonFallback');
			assert.ok(fnStart >= 0, '未找到 parseFullJsonFallback');
			const signature = source.slice(fnStart, source.indexOf('): IModelDelta[]', fnStart));
			assert.ok(
				/onParseError/.test(signature),
				'parseFullJsonFallback 必须暴露 onParseError 参数，' +
				'否则 renderer 的「网关返回了什么」诊断日志会静默消失。',
			);
		});

		test('renderer 通过实例绑定的回调注入日志（箭头函数，避免 this 丢失）', () => {
			const source = readStudioFile('browser/builtInBYOKModelProvider.ts');
			assert.ok(
				/private readonly _logCacheHit = \(/.test(source),
				'_logCacheHit 必须是箭头函数属性：传裸方法引用给 extractUsage 会丢失 this。',
			);
			assert.ok(
				/this\._logCacheHit/.test(source),
				'_logCacheHit 必须实际注入到解析调用中。',
			);
		});
	});
});
