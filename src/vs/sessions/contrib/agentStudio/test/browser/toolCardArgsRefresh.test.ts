/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「args 后到」工具卡刷新决策回归测试（2026-08-22，日志 1787363991734）。
 *
 * 事故：`tool_start` 与 `tool_args` 是两个独立 delta，建卡时 args 为空 → 终端族卡片
 * 渲染「执行中…」占位符；args 后到时 status 仍是 running → 卡片整个执行期间不刷新
 * （日志里一次 execute_code 跑了 30.5s，用户看了 30 秒空卡）。
 *
 * 最关键的断言是**自限性**：占位符消失后必须立刻停止刷新，否则会从「一次补齐」
 * 退化成每帧整卡重建 —— 那是比空卡更严重的抖动。
 */

import assert from 'assert';
import {
	needsArgsDrivenRebuild, argsResolveCommand, argsResolveFilePath,
} from '../../../../browser/agentChat/toolCardArgsRefresh.js';

const noPlaceholder = { hasEmptyCommandPlaceholder: false, hasUnresolvedPathPlaceholder: false };
const cmdPlaceholder = { hasEmptyCommandPlaceholder: true, hasUnresolvedPathPlaceholder: false };
const pathPlaceholder = { hasEmptyCommandPlaceholder: false, hasUnresolvedPathPlaceholder: true };

suite('toolCardArgsRefresh — argsResolveCommand', () => {

	test('识别终端族的三种命令字段名', () => {
		assert.strictEqual(argsResolveCommand({ command: 'npx tsc' }), true, 'command');
		assert.strictEqual(argsResolveCommand({ cmd: 'ls -la' }), true, 'cmd');
		assert.strictEqual(argsResolveCommand({ code: 'print(1)' }), true, 'code');
	});

	test('★ execute_code 的真实参数名是 command（日志中的空卡就是这个工具）', () => {
		// compatibilityTools.ts 的 inputSchema：required: ['command']
		assert.strictEqual(argsResolveCommand({ command: 'python3 scripts/x.py', cwd: '/g/x', timeout: 30 }), true);
	});

	test('空对象 / 空串 / 非字符串 → false', () => {
		assert.strictEqual(argsResolveCommand({}), false);
		assert.strictEqual(argsResolveCommand({ command: '' }), false);
		assert.strictEqual(argsResolveCommand({ command: 123 as unknown as string }), false);
		assert.strictEqual(argsResolveCommand({ cwd: '/g/x' }), false, '只有 cwd 不足以渲染命令行');
	});
});

suite('toolCardArgsRefresh — argsResolveFilePath', () => {

	test('识别写文件族的各种路径字段名', () => {
		for (const k of ['filePath', 'path', 'file', 'filepath', 'file_path', 'target_file', 'uri']) {
			assert.strictEqual(argsResolveFilePath({ [k]: 'src/a.ts' }), true, k);
		}
	});

	test('空对象 / 空串 → false', () => {
		assert.strictEqual(argsResolveFilePath({}), false);
		assert.strictEqual(argsResolveFilePath({ filePath: '' }), false);
		assert.strictEqual(argsResolveFilePath({ content: 'x' }), false, '只有 content 无法渲染标题');
	});
});

suite('toolCardArgsRefresh — needsArgsDrivenRebuild', () => {

	test('★ 日志场景：终端卡处于占位态且 args 已到 → 需要补齐一次', () => {
		assert.strictEqual(
			needsArgsDrivenRebuild(cmdPlaceholder, { command: 'python3 - <<\'PY\'\nimport re\nPY' }), true);
	});

	test('★★ 自限性：占位符已消失 → 绝不再刷新（否则退化成每帧整卡重建）', () => {
		assert.strictEqual(
			needsArgsDrivenRebuild(noPlaceholder, { command: 'npx tsc --noEmit' }), false,
			'这是防止「修抖动反而更抖」的关键断言');
	});

	test('★ 占位态但 args 仍为空（args 还没到）→ 不刷新，避免空转重建', () => {
		assert.strictEqual(needsArgsDrivenRebuild(cmdPlaceholder, {}), false);
		assert.strictEqual(needsArgsDrivenRebuild(cmdPlaceholder, { cwd: '/g/x' }), false);
	});

	test('写文件卡：路径占位态 + args 已含路径 → 刷新', () => {
		assert.strictEqual(needsArgsDrivenRebuild(pathPlaceholder, { filePath: 'src/a.ts' }), true);
	});

	test('写文件卡：路径占位态但 args 只有 content → 不刷新', () => {
		assert.strictEqual(needsArgsDrivenRebuild(pathPlaceholder, { content: 'hello' }), false);
	});

	test('★ 字段族不串门：命令占位态遇到只有 filePath 的 args → 不刷新', () => {
		// 否则会反复重建却填不上命令，形成每帧空转
		assert.strictEqual(needsArgsDrivenRebuild(cmdPlaceholder, { filePath: 'src/a.ts' }), false);
		assert.strictEqual(needsArgsDrivenRebuild(pathPlaceholder, { command: 'ls' }), false);
	});

	test('两种占位符同时存在时任一可填即刷新', () => {
		const both = { hasEmptyCommandPlaceholder: true, hasUnresolvedPathPlaceholder: true };
		assert.strictEqual(needsArgsDrivenRebuild(both, { command: 'ls' }), true);
		assert.strictEqual(needsArgsDrivenRebuild(both, { path: 'a.ts' }), true);
		assert.strictEqual(needsArgsDrivenRebuild(both, {}), false);
	});

	test('★ 完整时序推演：建卡(空) → args 到达(补一次) → 后续帧(不再刷新)', () => {
		// step 1: tool_start，args 空，卡片渲染占位符
		assert.strictEqual(needsArgsDrivenRebuild(cmdPlaceholder, {}), false, 'step1 无可填内容');
		// step 2: tool_args 到达 → 补齐一次
		assert.strictEqual(needsArgsDrivenRebuild(cmdPlaceholder, { command: 'npx tsc' }), true, 'step2 补齐');
		// step 3: 重建后占位符消失，后续每帧都不再触发
		for (let frame = 0; frame < 60; frame++) {
			assert.strictEqual(
				needsArgsDrivenRebuild(noPlaceholder, { command: 'npx tsc' }), false,
				`step3 frame ${frame} 必须零重建`);
		}
	});
});
