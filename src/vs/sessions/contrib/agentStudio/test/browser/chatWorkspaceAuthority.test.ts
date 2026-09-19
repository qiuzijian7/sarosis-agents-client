/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「聊天输入框顶部的工作区/worktree 选择 = LLM 工作区真源」的契约测试。
 *
 * 事故（用户 2026-09-16 报「LLM 读到的 workspace 路径是错的，应该以输入框顶部的配置为准」）：
 *   ① 顶部下拉 `onSelectWorkspace` **只写面板本地字段** ✗ ⇒ 选择到不了工具链；
 *   ② turn 解析 workspace 只认 `getSession(sessionId).workspaceId`（兜底全局游标）✗
 *      ⇒ 用户在顶部换工作区对 LLM 无效；且 worktree binding 按该 workspaceId 查 ⇒ worktree 一起错；
 *   ③ `_buildWorkspaceContext` 还用**窗口 folder** 覆盖提示词工作根并**回写 registry** ✗。
 * 修：会话级覆盖（服务层）+ 解析优先级 + 提示词守卫 + 面板回写。本测试钉住这四点。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/chatWorkspaceAuthority.test.ts
 */

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

suite('聊天输入框顶部的 workspace/worktree 选择 = 真源', () => {

	const ROOT = process.cwd();
	const DRIVER = path.join(ROOT, 'src/vs/sessions/contrib/agentStudio/browser/agentDriverService.ts');
	const PANEL = path.join(ROOT, 'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts');
	const IFACE = path.join(ROOT, 'src/vs/sessions/common/agentStudioService.ts');
	const IMPL = path.join(ROOT, 'src/vs/sessions/contrib/agentStudio/browser/agentStudioService.ts');

	/** 只剥行注释（块注释里会**提到**被禁写法，剥了才不误报）。 */
	const readCode = (file: string) =>
		fs.readFileSync(file, 'utf8').replace(/^[ \t]*\/\/.*$/gm, '');

	test('★★★ 面板选择必须落进服务层（不再只写面板本地字段）', () => {
		const src = readCode(PANEL);
		const at = src.indexOf('onSelectWorkspace: async (');
		assert.ok(at > 0, '应能找到 onSelectWorkspace');
		const body = src.slice(at, at + 900);
		assert.ok(
			body.includes('setSessionWorkspaceOverride('),
			'顶部下拉的选择必须写进服务层 —— 否则工具链永远看不到（这正是事故①）✗',
		);
		assert.ok(body.includes('_currentSessionId'), '必须按**当前会话**记录覆盖');
	});

	test('★★★ workspace 解析优先级：会话覆盖 > 会话记录 > 全局游标', () => {
		const src = readCode(DRIVER);
		const at = src.indexOf('private async _resolveWorkspaceId(');
		assert.ok(at > 0, '应能找到 _resolveWorkspaceId');
		const body = src.slice(at, at + 900);
		const overrideAt = body.indexOf('getSessionWorkspaceOverride(');
		const sessionAt = body.indexOf('getSession(sessionId)');
		const activeAt = body.indexOf('getActiveWorkspaceId()');
		assert.ok(overrideAt > 0, '必须读取会话级覆盖（真源）');
		assert.ok(sessionAt > 0, '会话记录仍是次优先');
		assert.ok(activeAt > 0, '全局游标仍是最后兜底');
		assert.ok(
			overrideAt < sessionAt && sessionAt < activeAt,
			'顺序必须是「会话覆盖 → 会话记录 → 全局游标」（事故②就是这里缺了第一档）✗',
		);
	});

	test('★★★ 提示词工作根：会话有显式选择时**不得**被窗口 folder 覆盖/回写', () => {
		const src = readCode(DRIVER);
		const at = src.indexOf('let workspaceRoot = workspace.path;');
		assert.ok(at > 0, '应能找到提示词工作根构造处');
		const body = src.slice(at, at + 2000);
		assert.ok(
			body.includes('getSessionWorkspaceOverride(sessionId)'),
			'必须识别「本会话有显式选择」',
		);
		const gateAt = body.indexOf('explicitWorkspaceChoice');
		const writeAt = body.indexOf('updateWorkspace(workspaceId, { path: vsCodeFolder })');
		assert.ok(gateAt > 0, '必须有 explicitWorkspaceChoice 守卫');
		assert.ok(writeAt > 0, '窗口 folder 的兜底同步仍应存在（无显式选择时）');
		assert.ok(
			body.includes('!explicitWorkspaceChoice && vsCodeFolder'),
			'回写 registry 的条件必须带 `!explicitWorkspaceChoice` —— 有显式选择时回写会污染用户记录 ✗',
		);
	});

	test('★★ 覆盖必须是「会话级 + 内存态 + 不改会话归属」', () => {
		const iface = readCode(IFACE);
		assert.ok(iface.includes('setSessionWorkspaceOverride(sessionId: string'), '接口必须声明 setSessionWorkspaceOverride');
		assert.ok(iface.includes('getSessionWorkspaceOverride(sessionId: string | undefined)'), '接口必须声明 getter');

		const impl = readCode(IMPL);
		assert.ok(impl.includes('_sessionWorkspaceOverrides = new Map<string, string>()'), '实现用会话→workspace 的内存表');
		const at = impl.indexOf('setSessionWorkspaceOverride(sessionId: string');
		const body = impl.slice(at, at + 700);
		assert.ok(body.includes('_sessionWorkspaceOverrides.set('), '必须写入覆盖');
		assert.ok(
			!body.includes('updateSession(') && !body.includes('updateWorkspace('),
			'不得篡改会话/工作区记录 —— 覆盖只作用于本次会话运行期 ✗',
		);
	});
});
