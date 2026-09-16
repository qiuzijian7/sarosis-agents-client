/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 任务栏 jump list「New Window」模式契约（2026-09-15）。
 *
 * 背景：该入口曾**默认**为「独立进程（多开）」—— `--instance <id>` + PowerShell 隐窗脚本。
 * 依据本项目调研 `doc/multi-instance-analysis.md` §3.2「共享面 ≫ 拆分面」与 §6.2 P3-2，
 * 已改为默认**原生模型 A（同进程内开新窗口）**，并保留设置项
 * `saros.window.newWindowMode: 'instance'` 作为逃生门。
 *
 * ⚠ 断言对着**源码文本**：`WorkspacesHistoryMainService` 依赖 Electron（`app.setJumpList`），
 * 无法在 node 单测里实例化。这里钉住的是「默认必须是原生形态」这个**非显然的决策**，
 * 以及逃生门/配置热生效不被后续改动悄悄破坏。
 */
suite('Jump-list New Window 模式契约', () => {

	const ROOT = process.cwd();
	const SERVICE = path.join(ROOT, 'src/vs/platform/workspaces/electron-main/workspacesHistoryMainService.ts');
	const CONTRIB = path.join(ROOT, 'src/vs/sessions/contrib/agentStudio/browser/agentStudio.contribution.ts');
	const WINDOWS_SVC = path.join(ROOT, 'src/vs/platform/windows/electron-main/windowsMainService.ts');

	/** 剥掉行注释与块注释 —— 注释里会**提到**被禁的写法（如 `app.isPackaged`），不能算命中。 */
	const readCode = (file: string) =>
		fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

	test('★★★ 默认分支必须是原生形态：process.execPath + --new-window', () => {
		const src = readCode(SERVICE);
		assert.ok(
			src.includes(`args: this.getNativeNewWindowArgs()`),
			'原生分支必须存在，且走 getNativeNewWindowArgs（built = `--new-window`；dev 另补 app 路径 + user-data-dir）',
		);
		assert.ok(
			src.includes('program: process.execPath'),
			'原生分支必须直接拉起 app 本体（而不是 powershell）—— 否则仍是独立进程',
		);
	});

	test('★★★ 只有显式 instance 才算多开；读配置失败必须回落原生', () => {
		const src = readCode(SERVICE);
		const at = src.indexOf('private getNewWindowMode()');
		assert.ok(at > 0, '应能找到 getNewWindowMode');
		const fn = src.slice(at, at + 700);
		assert.ok(fn.includes(`=== 'instance'`), '仅显式 instance 才走多开');
		assert.ok(fn.includes(`return 'window';`), '默认/非法值一律回落 window（原生）');
		assert.ok(fn.includes('catch'), '读配置失败必须回落 —— 不能因此让用户开不出窗口');
	});

	test('★★★ 逃生门必须保留：instance 模式仍走 PowerShell 脚本，且用 isBuilt 判断', () => {
		const src = readCode(SERVICE);
		assert.ok(src.includes('getNewWindowScriptArgs()'), '必须保留脚本参数构造（逃生门）');
		assert.ok(src.includes('WindowsPowerShell'), 'instance 分支必须仍走 powershell');
		assert.ok(src.includes('environmentMainService.isBuilt'), 'dev/built 判断必须用 isBuilt');
		assert.ok(
			!src.includes('app.isPackaged'),
			'不得用 app.isPackaged（dev 下 .build/electron/VsSaros.exe <appPath> 时它为 true ⇒ 误走打包分支）',
		);
	});

	test('★★ 设置必须已注册且有正确默认值（否则主进程读不到用户配置）', () => {
		const contrib = readCode(CONTRIB);
		assert.ok(contrib.includes(`'saros.window.newWindowMode'`), '必须注册该设置');
		assert.ok(contrib.includes(`enum: ['window', 'instance']`), '枚举必须是 window | instance');
		assert.ok(contrib.includes(`default: 'window'`), '默认必须是 window（原生模型 A）');
	});

	test('★★ 改设置必须**立即重建**跳转列表（逃生门要能随时切，不重启）', () => {
		const src = readCode(SERVICE);
		assert.ok(src.includes('onDidChangeConfiguration'), '必须监听配置变化');
		assert.ok(
			src.includes(`affectsConfiguration('saros.window.newWindowMode')`),
			'只应对该设置的变化重建跳转列表',
		);
		// 监听应挂在「跳转列表已建立」之后（即 handleWindowsJumpList 内），
		// 否则启动早期配置加载会触发一次无谓重建（跳转列表本身是延迟到 Eventually 才装的）。
		const start = src.indexOf('private async handleWindowsJumpList()');
		const end = src.indexOf('private async updateWindowsJumpList()');
		assert.ok(start > 0 && end > start, '应能定位 handleWindowsJumpList');
		assert.ok(
			src.slice(start, end).includes('onDidChangeConfiguration'),
			'配置监听必须放在 handleWindowsJumpList 内',
		);
	});

	test('★★★ dev（未 built）下原生模式必须补 app 路径 + user-data-dir', () => {
		// 为什么（2026-09-15 自查发现）：任务栏项由 explorer 拉起，**不继承** `code.bat` 设的
		// `VSCODE_DEV=1` ⇒ 新进程把数据目录算成 `~/.vssaros`（built 形态），而运行中的 dev 实例
		// 用的是 `~/.vssaros-dev` ⇒ 单实例管道 scope（`sha256(userDataPath)`）不一致
		// ⇒ **不会转发**，反而另起一个"没有你的 agent / 设置 / 工作区"的实例 ✗。
		// 另外 dev 下 electron 二进制需要 app 路径作为第一个参数。
		const src = readCode(SERVICE);
		const at = src.indexOf('private getNativeNewWindowArgs(): string {');
		assert.ok(at > 0, '应能找到 getNativeNewWindowArgs');
		const fn = src.slice(at, at + 900);
		assert.ok(fn.includes('isBuilt'), '必须按 isBuilt 分支（**不能**用 app.isPackaged）');
		assert.ok(fn.includes(`return '--new-window';`), 'built 形态：只需 --new-window');
		assert.ok(fn.includes('app.getAppPath()'), 'dev 必须带 app 路径（electron 二进制需它作第一个参数）');
		assert.ok(fn.includes('--user-data-dir'), 'dev 必须带 --user-data-dir（对齐单实例管道 scope）');
		assert.ok(fn.includes('userDataPath'), 'user-data-dir 必须是**运行中实例**的数据目录');
		// 原生分支必须真的用上它（否则上面全是死代码）
		assert.ok(src.includes('args: this.getNativeNewWindowArgs()'), '原生分支必须使用该构造');
	});

	test('★★★ 显式 --new-window（不带工作区）必须**原样放行** ⇒ 真的开新的空窗口', () => {
		// 根因（2026-09-16 日志实证 `20260916T100505\main.log`）：`launchMainService` 对
		// 「无位置参数 + --new-window」构造 `open({ forceNewWindow: true, forceEmpty: true })`；
		// 若 `ensureAgentsWindow` 的 case ③ 把它替换成「记住的工作区」并把 `forceEmpty` 丢掉，
		// 而那个工作区**通常已在当前窗口打开** ⇒ `open()` 里
		// `if (windowsOnWorkspace.some(...)) { continue; /* ignore folders that are already open */ }`
		// 会**跳过开窗** ⇒ 静默 no-op ✗（日志：`returned 1 window(s)` 且窗口数不变）。
		const src = readCode(WINDOWS_SVC);
		const idx = src.indexOf('private async ensureAgentsWindow(');
		assert.ok(idx > 0, '应能找到 ensureAgentsWindow');
		const body = src.slice(idx, idx + 5000);
		// ⚠ 锚点必须是**完整的 if 条件**：上面 diag 行里也有 `openConfig.cli?.['new-window']`，
		// 用它做锚会命中 diag（第一次实测就是这么失败的 ✗）。
		const guardAt = body.indexOf(`if (openConfig.cli?.['new-window'] && openConfig.forceEmpty`);
		assert.ok(guardAt > 0, '必须有「显式 --new-window 原样放行」的早退');
		const rememberAt = body.indexOf('reopening remembered');
		assert.ok(rememberAt > 0 && guardAt < rememberAt, '该早退必须早于 case ③（复用记住的工作区）');
		const guard = body.slice(Math.max(0, guardAt - 300), guardAt + 300);
		assert.ok(guard.includes('openConfig.forceEmpty'), '必须要求 forceEmpty（否则会抢走「带 folder 的新窗口」请求）');
		assert.ok(guard.includes('!requestedWorkspaceUri'), '带显式工作区时不得放行（应打开它）');
		assert.ok(guard.includes('!hasExplicitFolderRequest'), '带显式文件夹时不得放行');
		assert.ok(
			body.slice(guardAt, guardAt + 400).includes('return openConfig;'),
			'必须**原样返回** openConfig —— 只有这样 forceEmpty / urisToOpen 才不被改写',
		);
	});
});
