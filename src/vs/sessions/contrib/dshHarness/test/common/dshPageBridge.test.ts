/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from '../../../../../base/common/path.js';
import {
	DSH_CHAT_ONLY_CSS, DSH_PAGE_BRIDGE_VERSION, DSH_PAGE_CHAT_ONLY_ARG, DSH_PAGE_INSERT_EVENT, DSH_PAGE_IPC_INSERT, DSH_PAGE_IPC_INVOKE, DSH_PAGE_IPC_KEYDOWN, DSH_PAGE_IPC_REBIND, DSH_PAGE_IPC_THEME, DSH_PAGE_REBIND_EVENT, DSH_PAGE_SESSION_ARG, DSH_PAGE_SURFACE_ARG, DSH_PAGE_THEME_EVENT, DSH_PAGE_VIEW_ARG,
	DSH_PAGE_IPC_WORKTREES, DSH_PAGE_WORKTREES_EVENT, DSH_WORKTREE_OPTION_LIMIT,
	DSH_PAGE_IPC_WORKSPACES, DSH_PAGE_WORKSPACES_EVENT, DSH_WORKSPACE_OPTION_LIMIT, DSH_WORKSPACE_ROOT_LIMIT,
	isAbsoluteFsPath, isPathInside, validateInsertReference, validateKeyEvent, validatePageCommand, validateWorkspaceOptions, validateWorktreeOptions,
} from '../../common/dshPageBridgeProtocol.js';
import { dshChatNewSessionId, dshChatPresetSessionId, dshChatSessionId, dshChatWorktreeSessionId, isDshChatSessionId, resolvePresetSessionId, sanitizeDshIdPart } from '../../common/dshChatSession.js';

suite('dshHarness / page bridge', () => {

	test('only whitelisted methods pass, extra fields are dropped', () => {
		assert.deepStrictEqual(validatePageCommand({ method: 'ping', evil: 1 }), { method: 'ping' });
		assert.strictEqual(validatePageCommand({ method: 'writeFile', path: '/x' }), undefined);
		assert.strictEqual(validatePageCommand({ method: 'runCommand', command: 'rm -rf /' }), undefined);
		assert.strictEqual(validatePageCommand(null), undefined);
		assert.strictEqual(validatePageCommand('openFile'), undefined);
		const cmd = validatePageCommand({ method: 'openFile', path: 'C:\\repo\\a.ts', startLine: 3, endLine: 5, exec: 'x' });
		assert.deepStrictEqual(cmd, { method: 'openFile', path: 'C:\\repo\\a.ts', startLine: 3, endLine: 5 });
	});

	test('openFile / reveal require absolute paths and sane ranges', () => {
		for (const bad of ['a.ts', './a.ts', '../etc/passwd', 'file:///etc/passwd', 'https://x/a', '', 'C:\\a\0b']) {
			assert.strictEqual(validatePageCommand({ method: 'openFile', path: bad }), undefined, bad);
			assert.strictEqual(validatePageCommand({ method: 'reveal', path: bad }), undefined, bad);
		}
		assert.strictEqual(validatePageCommand({ method: 'openFile', path: '/a', startLine: 0 }), undefined);
		assert.strictEqual(validatePageCommand({ method: 'openFile', path: '/a', startLine: 1.5 }), undefined);
		assert.strictEqual(validatePageCommand({ method: 'openFile', path: '/a', endLine: 4 }), undefined, 'endLine without startLine');
		assert.strictEqual(validatePageCommand({ method: 'openFile', path: '/a', startLine: 9, endLine: 4 }), undefined);
		assert.deepStrictEqual(validatePageCommand({ method: 'openFile', path: '/a' }), { method: 'openFile', path: '/a', startLine: undefined, endLine: undefined });
		assert.ok(isAbsoluteFsPath('\\\\server\\share\\x'));
		assert.ok(isAbsoluteFsPath('D:/x'));
	});

	test('notify: enum kind, non-empty text, truncated to 500 chars', () => {
		assert.strictEqual(validatePageCommand({ method: 'notify', kind: 'error', text: 'x' }), undefined);
		assert.strictEqual(validatePageCommand({ method: 'notify', kind: 'info', text: '   ' }), undefined);
		const n = validatePageCommand({ method: 'notify', kind: 'done', text: 'y'.repeat(2000) });
		assert.strictEqual(n?.method === 'notify' && n.text.length, 500);
	});

	test('switchPreset: preset id charset whitelist (方案 5.15)', () => {
		assert.deepStrictEqual(validatePageCommand({ method: 'switchPreset', presetId: 'standard' }), { method: 'switchPreset', presetId: 'standard' });
		assert.deepStrictEqual(validatePageCommand({ method: 'switchPreset', presetId: 'my-preset_v2.1' }), { method: 'switchPreset', presetId: 'my-preset_v2.1' });
		for (const bad of ['', ' preset', 'a b', '../x', 'a/b', 'a\\b', '-lead', 'x'.repeat(65), 'a\0b']) {
			assert.strictEqual(validatePageCommand({ method: 'switchPreset', presetId: bad }), undefined, bad);
		}
		assert.strictEqual(validatePageCommand({ method: 'switchPreset' }), undefined);
	});

	test('newSession：无参白名单（漏了会被静默丢弃 ⇒ 点了没反应）', () => {
		// 2026-10-12：dsh 聊天 header 的「＋ 新建会话」改成**本页签内**新建（用户要求）。
		// 这条钉住两件事：① 命令在**校验器白名单**里（`validatePageCommand` 是白名单，
		// 漏 case 会让命令被静默丢弃 —— 页面点了没反应、日志里什么都没有 ✗）；
		// ② 多余的字段被丢掉（与其它分支同口径 ✓）。
		assert.deepStrictEqual(validatePageCommand({ method: 'newSession', evil: 1 }), { method: 'newSession' });
		assert.deepStrictEqual(validatePageCommand({ method: 'newSession' }), { method: 'newSession' });

		// id 派生：必须是合法会话 id 形态，且**同一 chatId 每次不同**（否则"再点一次"还是回到同一段对话 ✗）。
		const a = dshChatNewSessionId('chat-1', 'm1');
		const b = dshChatNewSessionId('chat-1', 'm2');
		assert.ok(isDshChatSessionId(a), `派生 id 必须是合法会话 id：${a}`);
		assert.notStrictEqual(a, b, '不同 nonce 必须不同会话');
		assert.ok(a.indexOf(dshChatSessionId('chat-1') + '--new-') === 0, '挂在同一 chatId 的会话族下（便于按页签排查）');
		assert.ok(isDshChatSessionId(dshChatNewSessionId('session-history-sess_mu21tmwy_ygx8dy', 'x1')),
			'历史页签那种带下划线的 chatId 也要被规范化成合法 id');
	});

	test('openTerminal：cwd 必须绝对、command 有上限；页面桥**只填空不执行**', () => {
		// 2026-10-13：工具卡里"跑过的命令"要能一键在 VsSaros 终端重现。协议侧刻意**不做 runInTerminal**
		// （页面里任何第三方前端插件都能调页面桥 ⇒ 替用户执行命令属于执行类能力 ✗✗）——
		// 只 `sendText(command, false)`：命令填进去，回车由用户按 ✓。这条钉住校验口径。
		assert.deepStrictEqual(validatePageCommand({ method: 'openTerminal' }), { method: 'openTerminal' });
		assert.deepStrictEqual(
			validatePageCommand({ method: 'openTerminal', cwd: 'G:\\repo\\wt', command: 'npm test', evil: 1 }),
			{ method: 'openTerminal', cwd: 'G:\\repo\\wt', command: 'npm test' },
			'多余字段丢掉、可选字段透传');
		assert.deepStrictEqual(validatePageCommand({ method: 'openTerminal', command: 'a\nb' }),
			{ method: 'openTerminal', command: 'a\nb' }, '多行命令允许（多行脚本常见）');
		for (const bad of ['relative/x', './x', '', 42, null]) {
			assert.strictEqual(validatePageCommand({ method: 'openTerminal', cwd: bad }), undefined, `cwd 非法：${String(bad)}`);
		}
		assert.strictEqual(validatePageCommand({ method: 'openTerminal', command: 'x'.repeat(2001) }), undefined, 'command 超长拒收');
		assert.strictEqual(validatePageCommand({ method: 'openTerminal', command: 'echo hi\u0000rm -rf /' }), undefined, 'NUL 拒收');
	});

	test('showUncommittedDiff：只收绝对路径（工作台按 fsPath 交给扩展命令）', () => {
		// 2026-10-13：交付卡的「看改动」= HEAD ↔ 工作区 diff。旧内容只有 git 知道，工作台拿不到
		// 扩展宿主 API ⇒ 走扩展命令 `agentStudio.openUncommittedDiff`（见协议注释 ✓）。
		assert.deepStrictEqual(validatePageCommand({ method: 'showUncommittedDiff', path: 'G:\\repo\\a.ts', evil: 1 }),
			{ method: 'showUncommittedDiff', path: 'G:\\repo\\a.ts' }, '多余字段丢掉');
		for (const bad of ['a.ts', './a.ts', '', 'C:\\a\0b', 42, null]) {
			assert.strictEqual(validatePageCommand({ method: 'showUncommittedDiff', path: bad }), undefined, `非法 path：${String(bad)}`);
		}
	});

	test('openModulePage：只收"站内绝对路径"形状（真正的白名单在宿主：必须是模块页表里的路由）', () => {
		// 2026-10-13：侧栏插件页点「打开完整主页」→ 请求宿主把它在**编辑区**打开（桥 `2 → 3`）。
		// ⚠ 这里只把**形状**，宿主再按 `DSH_MODULE_PAGES` 核对 —— 页面里任何**第三方**前端插件都能调
		//   `window.vssarosDsh.*`，少了宿主那层白名单就等于给了它"打开任意页面"的能力 ✗。
		assert.deepStrictEqual(validatePageCommand({ method: 'openModulePage', route: '/x/dashboard/', evil: 1 }),
			{ method: 'openModulePage', route: '/x/dashboard/' }, '多余字段丢掉');
		assert.deepStrictEqual(validatePageCommand({ method: 'openModulePage', route: '/x/kb' }),
			{ method: 'openModulePage', route: '/x/kb' }, '无尾斜杠也收（宿主两侧比对）');
		for (const bad of ['', 'x/y', '//evil.example/x', '/x/../y', '/..', '/x//y', '/x/y?token=1', '/x/y#f', '/x\\y', '/x/ y', '/'.repeat(201), 42, null, undefined]) {
			assert.strictEqual(validatePageCommand({ method: 'openModulePage', route: bad as unknown as string }), undefined, `非法 route：${String(bad)}`);
		}
		assert.strictEqual(validatePageCommand({ method: 'openModulePage' }), undefined, '缺 route 拒收');
	});

	test('setWorkbenchPinned / setWorkbenchHidden：形状与白名单同 openModulePage，且布尔必须是**真布尔**', () => {
		// 2026-10-13：主页「工作台」组件的两个**单向动作**（dsh 侧读不到 IDE 的 pin / 显隐状态 ⇒
		// 命令是"设成 true"而不是"切换" ✓）。⚠ 这两个动作改的是 IDE 活动栏状态 ⇒ 宿主白名单更关键。
		assert.deepStrictEqual(validatePageCommand({ method: 'setWorkbenchPinned', route: '/x/dashboard/', pinned: true, evil: 1 }),
			{ method: 'setWorkbenchPinned', route: '/x/dashboard/', pinned: true }, '多余字段丢掉');
		assert.deepStrictEqual(validatePageCommand({ method: 'setWorkbenchHidden', route: '/x/kb', hidden: true }),
			{ method: 'setWorkbenchHidden', route: '/x/kb', hidden: true }, '无尾斜杠也收（宿主两侧比对）');
		for (const bad of ['', 'x/y', '//evil.example/x', '/x/../y', '/..', '/x//y', '/x/y?token=1', '/x\\y', 42, null, undefined]) {
			assert.strictEqual(validatePageCommand({ method: 'setWorkbenchPinned', route: bad as unknown as string, pinned: true }), undefined, `非法 route：${String(bad)}`);
			assert.strictEqual(validatePageCommand({ method: 'setWorkbenchHidden', route: bad as unknown as string, hidden: true }), undefined, `非法 route：${String(bad)}`);
		}
		for (const bad of ['true', 1, 0, null, undefined]) {
			assert.strictEqual(validatePageCommand({ method: 'setWorkbenchPinned', route: '/x/kb/', pinned: bad }), undefined, `pinned 必须真布尔：${String(bad)}`);
			assert.strictEqual(validatePageCommand({ method: 'setWorkbenchHidden', route: '/x/kb/', hidden: bad }), undefined, `hidden 必须真布尔：${String(bad)}`);
		}
	});

	test('insertChatReference：形状与 `IDshInsertReference` **同源**，方向相反（页面 → 聊天草稿）', () => {
		// 2026-10-14（桥 `4 → 5`）：工作台**页面**把一条引用推进**当前活动的 dsh 聊天草稿**。
		// ⚠ 与 host → page 的 `DSH_PAGE_IPC_INSERT` **不是同一条**（那条投给页面自身，这条投给另一个视图）
		//   ⇒ 本用例存在的意义：**两条路的负载判据必须同源**（实现里直接复用 `validateInsertReference`），
		//   否则会出现"页面发的路径能过、编辑器右键发的过不了"这种静默分叉 ✗。
		assert.deepStrictEqual(validatePageCommand({ method: 'insertChatReference', path: 'src/a.ts', startLine: 2, endLine: 3, evil: 1 }),
			{ method: 'insertChatReference', path: 'src/a.ts', startLine: 2, endLine: 3 }, '多余字段丢掉');
		// kb 在工作区**之外**（数据根）⇒ 绝对路径必须收；行号可省（整篇引用）。
		assert.deepStrictEqual(validatePageCommand({ method: 'insertChatReference', path: 'G:\\vssaros-dev\\knowledge-base\\笔记\\a.md' }),
			{ method: 'insertChatReference', path: 'G:\\vssaros-dev\\knowledge-base\\笔记\\a.md' }, '绝对路径 + 无行号');
		for (const bad of ['', '../a.ts', 'a/../b.ts', 'a\\b.ts', 'C:relative.ts', 42, null, undefined]) {
			assert.strictEqual(validatePageCommand({ method: 'insertChatReference', path: bad as unknown as string }), undefined, `非法 path：${String(bad)}`);
		}
		assert.strictEqual(validatePageCommand({ method: 'insertChatReference', path: '/a.ts', startLine: 9, endLine: 3 }), undefined, '反向区间拒收');
		assert.strictEqual(validatePageCommand({ method: 'insertChatReference' }), undefined, '缺 path 拒收');
	});

	test('openAgentSettings：agentId 走 agent id 字符集（= `.agent.md` 目录名），name 是可选展示文本（桥 `5 → 6`）', () => {
		// 2026-10-14：dsh 的 Agents 页（`/x/agents`）行内「设置」→ 打开该 bot 的 VsSaros Agent 设置编辑器页。
		// ⚠ 这条命令的安全面 = **只把 IDE 自己的设置界面显示出来**（写入仍发生在设置页里、由用户点保存）
		//   ⇒ 形状校验与其它"打开类"命令同口径：字符集白名单 + 展示文本截断 + 多余字段丢掉 ✓。
		assert.deepStrictEqual(validatePageCommand({ method: 'openAgentSettings', agentId: 'code-reviewer', evil: 1 }),
			{ method: 'openAgentSettings', agentId: 'code-reviewer' }, '多余字段丢掉；name 缺席就不带');
		assert.deepStrictEqual(
			validatePageCommand({ method: 'openAgentSettings', agentId: 'builtin-goal-workflow', name: 'Goal Execution Workflow' }),
			{ method: 'openAgentSettings', agentId: 'builtin-goal-workflow', name: 'Goal Execution Workflow' });
		assert.deepStrictEqual(validatePageCommand({ method: 'openAgentSettings', agentId: 'a.b_c-1', name: '  x  ' }),
			{ method: 'openAgentSettings', agentId: 'a.b_c-1', name: 'x' }, 'name 去空白');
		const longName = validatePageCommand({ method: 'openAgentSettings', agentId: 'a', name: 'n'.repeat(2000) });
		assert.strictEqual(longName?.method === 'openAgentSettings' && longName.name?.length, 500, 'name 截断到 MAX_TEXT');
		// 空名 / 非字符串名 = **缺席**（不是空串）——否则编辑页标签会出现空标题
		assert.deepStrictEqual(validatePageCommand({ method: 'openAgentSettings', agentId: 'a', name: '   ' }),
			{ method: 'openAgentSettings', agentId: 'a' });
		for (const bad of ['', '-lead', 'a b', 'a/b', 'a\\b', '../x', 'x'.repeat(65), 42, null, undefined]) {
			assert.strictEqual(validatePageCommand({ method: 'openAgentSettings', agentId: bad as unknown as string }), undefined, `非法 agentId：${String(bad)}`);
		}
		assert.strictEqual(validatePageCommand({ method: 'openAgentSettings' }), undefined, '缺 agentId 拒收');
	});

	test('key events are shape-checked', () => {
		assert.deepStrictEqual(validateKeyEvent({ key: 'p', keyCode: 80, code: 'KeyP', ctrlKey: true, shiftKey: 'yes' }),
			{ key: 'p', keyCode: 80, code: 'KeyP', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, repeat: false });
		assert.strictEqual(validateKeyEvent({ key: 'x'.repeat(100), keyCode: 1, code: 'a' }), undefined);
		assert.strictEqual(validateKeyEvent({ key: 'p', code: 'KeyP' }), undefined);
	});

	test('switchWorktree：只收绝对路径（宿主会拿它当 session.start 的 cwd）', () => {
		assert.deepStrictEqual(validatePageCommand({ method: 'switchWorktree', path: 'G:\\Repo-wt\\feature-auth', evil: 1 }),
			{ method: 'switchWorktree', path: 'G:\\Repo-wt\\feature-auth' }, '多余字段被丢掉');
		for (const bad of ['', 'relative/x', './x', '../x', 'file:///x', 'https://x/y', 'C:\\a\0b', 42, null]) {
			assert.strictEqual(validatePageCommand({ method: 'switchWorktree', path: bad }), undefined, String(bad));
		}
		assert.strictEqual(validatePageCommand({ method: 'switchWorktree' }), undefined);
	});

	test('worktree 会话 id：确定性 + 不撞 + 仍是合法 id（方案 C）', () => {
		// 为什么这三条必须成立：换 worktree = 新会话（dsh 的 cwd 在 session.start 时定死），
		// 而"切回来"靠的正是**同一个 id 的幂等接管** ⇒ 派生必须确定性；撞了就是"两个目录共用一段历史"✗。
		const a = dshChatWorktreeSessionId('chat1', 'vssaros-dev-expert', 'G:\\Repo-wt\\feature-auth');
		assert.strictEqual(a, dshChatWorktreeSessionId('chat1', 'vssaros-dev-expert', 'G:\\Repo-wt\\feature-auth'),
			'同一 (chat, preset, 目录) 必须派生出同一个 id');
		assert.ok(isDshChatSessionId(a), `必须是合法会话 id（rebind 校验同一形态）：${a}`);
		assert.ok(a.startsWith('vssaros-chat-chat1--vssaros-dev-expert--wt-'), a);
		assert.notStrictEqual(
			dshChatWorktreeSessionId('chat1', 'p', 'G:\\Repo-wt\\feature-auth'),
			dshChatWorktreeSessionId('chat1', 'p', 'G:\\other\\feature-auth'),
			'同名不同父目录**不得**撞（id 里带短哈希就是为了这个）');
		const base = dshChatWorktreeSessionId('chat1', undefined, 'G:\\Repo-wt\\x');
		assert.ok(/^vssaros-chat-chat1--wt-/.test(base) && isDshChatSessionId(base), `基座 preset 也要带 worktree 段：${base}`);
		// 主工作区在宿主侧**不加** worktree 段（向后兼容：主干历史留在老会话里）
		assert.strictEqual(dshChatSessionId('chat1'), 'vssaros-chat-chat1');
		// 归一：Windows 上同一目录的两种写法得同一个 id（大小写 + 分隔符）
		assert.strictEqual(
			dshChatWorktreeSessionId('c', 'p', 'C:\\Repo-Wt\\A'),
			dshChatWorktreeSessionId('c', 'p', 'c:/repo-wt/a'));
	});

	test('worktree 列表负载：只放行展示必需字段，任一项脏则整批丢弃', () => {
		// 页面桥是**单向**的 ⇒ worktree 只能由宿主推（见 DSH_PAGE_IPC_WORKTREES 的注释）。
		// 主进程发出前校验一次；preload 会把它写进 `dataset`（字符串）并被页面当作可信数据解析 ⇒
		// 形状必须收紧：绝对路径 + 有限长度的名字/分支 + 上限条数。
		assert.deepStrictEqual(
			validateWorktreeOptions([{ path: 'G:\\repo\\wt-a', name: 'wt-a', branch: 'worktree/a', isMain: false, hash: 'deadbeef' }]),
			[{ path: 'G:\\repo\\wt-a', name: 'wt-a', branch: 'worktree/a', isMain: false }],
			'只保留展示必需字段（git 内部信息不外传）');
		assert.deepStrictEqual(validateWorktreeOptions([{ path: '/repo', name: 'main', isMain: true }]),
			[{ path: '/repo', name: 'main', isMain: true }], 'detached（无 branch）也要能过');
		// 整批丢弃：任一项不合法都不掺半份脏数据进 UI。
		assert.strictEqual(validateWorktreeOptions([{ path: 'relative/x', name: 'x', isMain: false }]), undefined, '相对路径');
		assert.strictEqual(validateWorktreeOptions([{ path: '/repo', name: '   ', isMain: false }]), undefined, '空名字');
		assert.strictEqual(validateWorktreeOptions([{ path: '/repo', name: 'x'.repeat(201), isMain: false }]), undefined, '名字过长');
		assert.strictEqual(validateWorktreeOptions([{ path: '/repo', name: 'x', branch: 'b'.repeat(201) }]), undefined, '分支过长');
		assert.strictEqual(validateWorktreeOptions([{ path: '/repo', name: 'x' }, null]), undefined, '数组里有脏项');
		assert.strictEqual(validateWorktreeOptions([{ path: '/repo', name: 'x', isMain: 'yes' }])?.[0].isMain, false,
			'isMain 非布尔 ⇒ 归 false（不当作 true）');
		assert.strictEqual(validateWorktreeOptions('nope'), undefined);
		assert.strictEqual(validateWorktreeOptions(new Array(DSH_WORKTREE_OPTION_LIMIT + 1).fill({ path: '/repo', name: 'x' })), undefined,
			`超过 ${DSH_WORKTREE_OPTION_LIMIT} 条整批丢弃`);
	});

	test('★ IDE 工作区记录负载（多根工作区，2026-10-16）：各根 + .code-workspace 实名，脏则整批丢弃', () => {
		// 为什么这条推送存在：dsh 的工作区模型**只能单目录**，宿主把多根工作区**摊平**成 N 条记录
		// ⇒ 页面只看 `workspaces.list()` 就分不出"这 3 条其实是同一个窗口的 3 个根" ✗
		// （用户报的"工作区 UI 不对"根因）。记录里的各根只能从 IDE 侧推过去 ✓。
		// 与 worktree 同口径：主进程发出前校验一次（`dataset` 是字符串、页面当可信数据解析 ✓）。
		assert.deepStrictEqual(
			validateWorkspaceOptions([{
				id: 'ide-1', name: 'multi',
				roots: [{ path: 'G:\\ws\\main', name: 'main', isPrimary: true }, { path: 'G:\\ws\\lib', name: 'lib', isPrimary: false, junk: 1 }],
				codeWorkspacePath: 'G:\\ws\\multi.code-workspace', extra: 'x',
			}]),
			[{
				id: 'ide-1', name: 'multi',
				roots: [{ path: 'G:\\ws\\main', name: 'main', isPrimary: true }, { path: 'G:\\ws\\lib', name: 'lib', isPrimary: false }],
				codeWorkspacePath: 'G:\\ws\\multi.code-workspace',
			}],
			'只保留展示必需字段（IDEA 记录的其余部分不外传 ✓；多余字段丢掉 ✓）');
		// 单根 + 无 .code-workspace 也要能过（不是只有多根才推 —— 单根同样要走分组那条路 ✓）
		assert.deepStrictEqual(validateWorkspaceOptions([{ id: 'a', name: 'a', roots: [{ path: '/repo', name: 'repo' }] }]),
			[{ id: 'a', name: 'a', roots: [{ path: '/repo', name: 'repo', isPrimary: false }] }],
			'单根合法；isPrimary 非布尔 ⇒ 归 false（不当作 true ✓）');
		// 整批丢弃：任一项不合法都不掺半份脏数据进 UI（与 worktree 同口径 ✓）
		assert.strictEqual(validateWorkspaceOptions([{ id: 'a', name: 'a', roots: [] }]), undefined, '**一个根都没有** ⇒ 整批丢');
		assert.strictEqual(validateWorkspaceOptions([{ id: '', name: 'a', roots: [{ path: '/r', name: 'r' }] }]), undefined, '空 id');
		assert.strictEqual(validateWorkspaceOptions([{ id: 'a', name: '  ', roots: [{ path: '/r', name: 'r' }] }]), undefined, '空名字');
		assert.strictEqual(validateWorkspaceOptions([{ id: 'a', name: 'a', roots: [{ path: 'relative', name: 'r' }] }]), undefined, '相对路径的根');
		assert.strictEqual(validateWorkspaceOptions([{ id: 'a', name: 'a', roots: [{ path: '/r', name: '' }] }]), undefined, '空根名');
		assert.strictEqual(validateWorkspaceOptions([{ id: 'a', name: 'a', roots: [{ path: '/r', name: 'r' }], codeWorkspacePath: 'x/y.code-workspace' }]), undefined,
			'.code-workspace 必须是绝对路径（相对路径到页面里无从解释 ✗）');
		assert.strictEqual(validateWorkspaceOptions([{ id: 'a', name: 'a', roots: [{ path: '/r', name: 'r' }, null] }]), undefined, '数组里有脏项');
		assert.strictEqual(validateWorkspaceOptions('nope'), undefined);
		assert.strictEqual(
			validateWorkspaceOptions([{ id: 'a', name: 'a', roots: new Array(DSH_WORKSPACE_ROOT_LIMIT + 1).fill({ path: '/r', name: 'r' }) }]), undefined,
			`单工作区超过 ${DSH_WORKSPACE_ROOT_LIMIT} 个根整批丢弃`);
		assert.strictEqual(
			validateWorkspaceOptions(new Array(DSH_WORKSPACE_OPTION_LIMIT + 1).fill({ id: 'a', name: 'a', roots: [{ path: '/r', name: 'r' }] })), undefined,
			`超过 ${DSH_WORKSPACE_OPTION_LIMIT} 条整批丢弃`);
	});

	test('★ switchWorkspace（桥 10 → 11）：只放形状 —— 它是 IDE registry 的键，不是路径', () => {
		// 2026-10-16 用户报障「点击其他工作区后，没有切换对应的工作区」⇒ 新增这条命令让 IDE 窗口原地进该工作区。
		// ⚠ 参数是 **IDE 侧** `Workspace.id`（不是 dsh 的 workspaceId ✗，两者没有映射关系）。
		// ⚠ 它**不是路径** ⇒ 刻意不套 `isAbsoluteFsPath` / 路径字符集：`Workspace.id` 由工作区名派生，
		//   可能是中文/空格（如 `我的仓-abc12`）⇒ 按路径收紧会把合法工作区全拒掉、又变成"点了没反应" ✗。
		assert.deepStrictEqual(validatePageCommand({ method: 'switchWorkspace', workspaceId: 'sarosis-agents-client-ncshv', evil: 1 }),
			{ method: 'switchWorkspace', workspaceId: 'sarosis-agents-client-ncshv' }, '多余字段丢掉 ✓');
		assert.deepStrictEqual(validatePageCommand({ method: 'switchWorkspace', workspaceId: '我的仓-abc12' }),
			{ method: 'switchWorkspace', workspaceId: '我的仓-abc12' },
			'中文/带短后缀的 id 必须放行（按路径字符集收紧会全拒 ⇒ 那又变成"点了没反应" ✗）');
		assert.deepStrictEqual(validatePageCommand({ method: 'switchWorkspace', workspaceId: '  padded-id  ' }),
			{ method: 'switchWorkspace', workspaceId: 'padded-id' }, '首尾空白裁掉（registry 查找是按精确值的 ✓）');
		for (const bad of ['', '   ', 'a\u0000b', 'a\u001fb', 'x'.repeat(201), 42, null, undefined]) {
			assert.strictEqual(validatePageCommand({ method: 'switchWorkspace', workspaceId: bad as unknown as string }), undefined,
				`非法 workspaceId：${String(bad)}`);
		}
		assert.strictEqual(validatePageCommand({ method: 'switchWorkspace' }), undefined, '缺 workspaceId 拒收');
	});

	test('isPathInside: prefix on segment boundaries, platform case rules', () => {
		assert.ok(isPathInside('C:\\Repo\\src\\a.ts', ['c:\\repo'], true));
		assert.ok(!isPathInside('C:\\Repo\\src\\a.ts', ['c:\\repo'], false));
		assert.ok(!isPathInside('/repo-other/a.ts', ['/repo'], false), 'sibling with shared prefix is outside');
		assert.ok(isPathInside('/repo', ['/repo/'], false));
		assert.ok(!isPathInside('/a', [''], false));
	});

	test('preload constants match the protocol (the preload cannot import it)', () => {
		const repo = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();
		const src = readFileSync(join(repo, 'src', 'vs', 'sessions', 'contrib', 'dshHarness', 'electron-browser', 'preload-dshView.ts'), 'utf8');
		for (const c of [DSH_PAGE_IPC_INVOKE, DSH_PAGE_IPC_KEYDOWN, DSH_PAGE_IPC_THEME, DSH_PAGE_IPC_INSERT, DSH_PAGE_IPC_WORKTREES, DSH_PAGE_SURFACE_ARG, DSH_PAGE_CHAT_ONLY_ARG, DSH_PAGE_SESSION_ARG, DSH_PAGE_VIEW_ARG, DSH_PAGE_THEME_EVENT, DSH_PAGE_INSERT_EVENT, DSH_PAGE_WORKTREES_EVENT, DSH_PAGE_IPC_REBIND, DSH_PAGE_REBIND_EVENT,
			// 多根工作区（2026-10-16）：IDE 工作区记录那条推送也要在 preload 里有对应通道 ✓
			DSH_PAGE_IPC_WORKSPACES, DSH_PAGE_WORKSPACES_EVENT]) {
			assert.ok(src.includes(`'${c}'`), `preload must use ${c}`);
		}
		// plugin-page 的插件页面要能自识别是哪个视图（路由由 location.pathname 决定）。
		assert.ok(src.includes('viewId: viewId || null'), 'preload must expose viewId on the page bridge');
		// 桥版本号必须与协议常量同步（方案 5.15 的 switchPreset/rebind 是 v2 引入）。
		assert.ok(src.includes(`bridgeVersion: ${DSH_PAGE_BRIDGE_VERSION}`), `preload bridgeVersion must be ${DSH_PAGE_BRIDGE_VERSION}`);
		// ★ 跨层对账（多根工作区，2026-10-16）：`dataset` 的**键名**与页面监听的**事件名**都是字符串字面量，
		//   preload / 页面各写一份（页面是插件 chunk，不能 import 协议）⇒ 只改一边就会"宿主推了、页面读不到"
		//   且**两边都不报错** ✗（这就是 worktree 那条推送 2026-10-13 的病根形态）⇒ 在这里钉住 ✓。
		const wsChunk = readFileSync(join(repo, 'dsh-plugins', 'vssaros-chat-surface', 'lib', 'client.workspace.js'), 'utf8');
		assert.ok(src.includes('dataset.vssarosWorkspaces = JSON.stringify(list)'), 'preload 必须把 IDE 工作区记录写进 dataset（键名 = vssarosWorkspaces）');
		assert.ok(wsChunk.includes('dataset.vssarosWorkspaces'), '页面必须从**同一个** dataset 键读（键名对不上 ⇒ 多根永远不出现 ✗）');
		assert.ok(wsChunk.includes(`"${DSH_PAGE_WORKSPACES_EVENT}"`), `页面监听的事件名必须与 ${DSH_PAGE_WORKSPACES_EVENT} 同值`);
		assert.ok(src.includes(`'${DSH_PAGE_WORKSPACES_EVENT}'`), 'preload 派发的事件名必须与协议常量同值');
		// 聊天框裁剪样式（方案 5.13）是 preload 里的字面量，必须与常量逐条一致。
		for (const rule of DSH_CHAT_ONLY_CSS.split('\n')) {
			assert.ok(src.includes(rule), `preload must inject the rule: ${rule}`);
		}
		// 只在聊天框里裁剪，且不改动 data-* 以外的选择器假设（用 data-slot / data-* 属性）。
		assert.ok(/surface === 'chat' && chatOnly/.test(src), 'preload must apply the trim only for the chat surface');
		assert.ok(DSH_CHAT_ONLY_CSS.includes('[data-slot="sidebar"]') && DSH_CHAT_ONLY_CSS.includes('[data-slot="rightbar"]'));
		assert.ok(!/^\s*(import|export)\s/m.test(src), 'preload must stay an import/export-free script');
	});

	test('知识库增删：kbAddVault 无参白名单；kbRemoveVault 只收库 id 形状（桥 7 → 8）', () => {
		// 2026-10-15：用户要求"参考原知识库 view 给下拉框加增删" ⇒ 两条命令。⚠ 它们**会改数据**，
		// 但页面依旧拿不到直接写能力：闸在真源那两步自带的**原生对话框**上（选目录 / 确认框 ✓，
		// 见协议头部的 2026-10-15 修订）。
		assert.deepStrictEqual(validatePageCommand({ method: 'kbAddVault', path: 'C:\\evil', evil: 1 }), { method: 'kbAddVault' },
			'无参：目录只能由用户在原生对话框里定 ⇒ 页面塞进来的路径必须被丢掉 ✗');
		assert.deepStrictEqual(validatePageCommand({ method: 'kbRemoveVault', vaultId: '20260709063858-azbh1at', evil: 1 }),
			{ method: 'kbRemoveVault', vaultId: '20260709063858-azbh1at' }, '多余字段丢掉');
		for (const bad of ['', ' ', '../x', 'a/b', 'a\\b', '-lead', 'x'.repeat(65), 42, null, undefined]) {
			assert.strictEqual(validatePageCommand({ method: 'kbRemoveVault', vaultId: bad as unknown as string }), undefined, `非法 vaultId：${String(bad)}`);
		}
		assert.strictEqual(validatePageCommand({ method: 'kbRemoveVault' }), undefined, '缺 vaultId 拒收');
	});

	test('★★ 页面用 `openHostPanel` 时：方法名必须在协议里 ＋ 要求的桥版本不得高于宿主提供的（否则按钮永远只弹"不支持" ✗）', () => {
		// 2026-10-16：接线守卫 ③ 是按 `bridge.<x>(` / `window.vssarosDsh.<x>(` 这两种**字面形态**采集的，
		// 而 kb 页走的是 `openHostPanel("<方法名>", …)` —— 方法名那时是**字符串**，③ 明确扫不到 ✗
		// （它的注释也写了"动态取法不该扫，由协议/preload 对账覆盖" —— 但那份**对账原本不存在** ✓）。
		// ⇒ 本守卫把这两件事补上：
		//   ① 字符串方法名必须在 `DshPageCommand` 联合里（写错一个字母 ⇒ 真机上永远弹"不支持" ✗）；
		//   ② 页面要求的版本 `≤ DSH_PAGE_BRIDGE_VERSION`（页面比宿主新 ⇒ 按钮**永远**只弹提示 ✗✗）。
		// ⚠ 采集面**自限定**为"用了这个 helper 的页面"（不是硬编码清单 ✓）：将来哪个模块抄了这个 helper，
		//   它自动被覆盖；没抄的页面不走 needVersion 语义，自然不该被它管 ✓。
		// ⚠ 排除：`vssaros-bridge` 里也有个 `bridgeVersion` —— 那是**它自己**那条桥协议的常量，不是页面桥 ✗。
		const repo = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();
		const pluginRoot = join(repo, 'dsh-plugins');
		// ⚠ 调用**全都要收**（含没带版本参数、走默认门槛的那些 ✓）—— 只收"带版本"的会让
		//   `openHostPanel("openKbSetting", …)` 这种**方法名写错**漏检 ✗（反向突变 M1 就是这么假绿的 ✓）。
		const calls: { page: string; method: string; need?: number }[] = [];
		const defaults: { page: string; need: number }[] = [];
		let scanned = 0;
		for (const entry of readdirSync(pluginRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) { continue; }
			const page = join(pluginRoot, entry.name, 'lib', 'index.js');
			if (!existsSync(page)) { continue; }
			const src = readFileSync(page, 'utf8');
			if (!src.includes('openHostPanel(')) { continue; }
			scanned++;
			// `openHostPanel("<方法>", "<标签>"[, <版本>][, arg])`
			for (const m of src.matchAll(/openHostPanel\(\s*['"]([A-Za-z]+)['"]([^)]*)\)/g)) {
				const argVersion = /,\s*(\d+)\s*(?:,|$)/.exec(m[2]);
				calls.push({ page: entry.name, method: m[1], need: argVersion ? Number(argVersion[1]) : undefined });
			}
			// helper 内部的**默认**门槛（不带版本参数的调用走它 ✓）：`var need = needVersion || <版本>`
			const def = /var need = needVersion \|\| (\d+)/.exec(src);
			if (def) { defaults.push({ page: entry.name, need: Number(def[1]) }); }
		}
		// 防空跑：至少扫到一个页面、认出 ≥2 个调用点、且拿到 helper 的默认门槛
		assert.ok(scanned >= 1, `没有任何页面在用 \`openHostPanel\` ⇒ 采集面失效（这条守卫会变成空跑 ✗）`);
		assert.ok(calls.length >= 2 && defaults.length >= 1,
			`只认出 ${calls.length} 个调用点 / ${defaults.length} 个默认门槛 ⇒ 采集面缩水（写法变了就更新本守卫 ✗）`);

		// ① 字符串方法名必须真在协议里（③ 看不到这一类 ✗）
		const proto = readFileSync(join(repo, 'src', 'vs', 'sessions', 'contrib', 'dshHarness', 'common', 'dshPageBridgeProtocol.ts'), 'utf8');
		const unionStart = proto.indexOf('export type DshPageCommand');
		const unionEnd = proto.indexOf('export interface IDshPageKeyEvent');
		assert.ok(unionStart > 0 && unionEnd > unionStart, '协议里的 `DshPageCommand` 锚点变了 ⇒ 更新本守卫 ✗');
		const declared = new Set(Array.from(proto.slice(unionStart, unionEnd).matchAll(/method:\s*'([A-Za-z]+)'/g), m => m[1]));
		assert.ok(declared.size >= 20, `声明面只读到 ${declared.size} 条命令 ⇒ 采集面失效 ✗`);
		const phantom = calls.filter(c => !declared.has(c.method)).map(c => `${c.page}: ${c.method}`);
		assert.deepStrictEqual(phantom, [],
			'这些"字符串方法名"不在协议联合里 ⇒ 宿主**永远收不到**（点了没反应/只弹不支持）✗：\n' + phantom.join('\n'));

		// ② 页面要求的版本不得高于宿主提供的版本（显式门槛与 helper 默认门槛都要管 ✓）
		const explicit = calls.filter((c): c is { page: string; method: string; need: number } => c.need !== undefined);
		const tooHigh = [...explicit, ...defaults].filter(g => g.need > DSH_PAGE_BRIDGE_VERSION)
			.map(g => `${g.page}: 要求 ${g.need} > 宿主 ${DSH_PAGE_BRIDGE_VERSION}${'method' in g ? ` (${(g as { method: string }).method})` : ' (helper 默认门槛)'}`);
		assert.deepStrictEqual(tooHigh, [],
			'页面要求的桥版本比宿主高 ⇒ 这些按钮**永远**只会弹"这个宿主还不支持…"（假可用 ✗）：\n' + tooHigh.join('\n'));
	});

	test('★★ 全族守卫：协议里声明的**每条**命令都必须在 validatePageCommand 里有 case', () => {
		// 为什么必须有这条（2026-10-15 抓到真 bug ✗）：第 41 刀加 `openKbSettings` / `openKbGraph` 时
		// **漏了 case** ⇒ 落到 default 被**静默丢弃** ⇒ 宿主 handler 永远收不到 ⇒ ⚙ / 🕸 两个按钮在
		// 真机上"点了没反应"（页面侧无感、日志里也什么都没有）—— 与 `newSession` 那条注释警告的是
		// **同一个**失效形态，靠人眼盯不住 ⇒ 改成按**源码文本**扫两端：
		//   声明面 = `DshPageCommand` 联合里出现的 `method: '<名>'`
		//   实现面 = `validatePageCommand` 里出现的 `case '<名>':`
		// 两者必须**相等**（少了 = 静默丢弃 ✗；多了 = 死代码，一并要求清掉 ✓）。
		const repo = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();
		const src = readFileSync(join(repo, 'src', 'vs', 'sessions', 'contrib', 'dshHarness', 'common', 'dshPageBridgeProtocol.ts'), 'utf8');
		const unionStart = src.indexOf('export type DshPageCommand');
		const unionEnd = src.indexOf('export interface IDshPageKeyEvent');
		assert.ok(unionStart > 0 && unionEnd > unionStart,
			'协议里应当能找到 `DshPageCommand` 联合与它后面的 `IDshPageKeyEvent`（锚点变了就更新这条守卫 ✗ —— 别让它变成空跑）');
		const declared = new Set(Array.from(src.slice(unionStart, unionEnd).matchAll(/method:\s*'([A-Za-z]+)'/g), m => m[1]));
		const validateStart = src.indexOf('export function validatePageCommand');
		const validateEnd = src.indexOf('export function validateKeyEvent');
		assert.ok(validateStart > 0 && validateEnd > validateStart, '应当能找到 validatePageCommand / validateKeyEvent 两个锚点');
		const handled = new Set(Array.from(src.slice(validateStart, validateEnd).matchAll(/case\s*'([A-Za-z]+)':/g), m => m[1]));
		// ⚠ 先自证"没空跑"（采集面读太少 ⇒ 正则/锚点失效 ⇒ 这条守卫会静默变绿 ✗）
		assert.ok(declared.size >= 20, `声明面只读到 ${declared.size} 条命令 ⇒ 多半是采集面失效（这条守卫会变成空跑 ✗）`);
		const missing = [...declared].filter(m => !handled.has(m)).sort();
		const extra = [...handled].filter(m => !declared.has(m)).sort();
		assert.deepStrictEqual(missing, [], `这些命令声明了却没有 case（会被**静默丢弃** ⇒ 页面点了没反应）: ${missing.join(', ')}`);
		assert.deepStrictEqual(extra, [], `这些 case 不在协议联合里（死代码）: ${extra.join(', ')}`);
	});
});

suite('dshPageBridgeProtocol / insertReference（onInsertReference 负载）', () => {
	test('接受绝对路径、工作区内 posix 相对路径与合法行号区间', () => {
		assert.ok(validateInsertReference({ path: 'G:\\repo\\src\\a.ts' }));
		assert.ok(validateInsertReference({ path: '/repo/src/a.ts', startLine: 2, endLine: 3 }));
		assert.ok(validateInsertReference({ path: '/repo/src/a.ts', startLine: 5 }));
		assert.ok(validateInsertReference({ path: 'src/a.ts' }));
		assert.ok(validateInsertReference({ path: 'src/deep/a.ts', startLine: 1, endLine: 2 }));
	});

	test('拒绝脏相对路径、畸形行号与反向区间', () => {
		assert.ok(!validateInsertReference(undefined));
		assert.ok(!validateInsertReference({}));
		assert.ok(!validateInsertReference({ path: '' }));
		assert.ok(!validateInsertReference({ path: 'a\\b.ts' }));
		assert.ok(!validateInsertReference({ path: '../a.ts' }));
		assert.ok(!validateInsertReference({ path: 'a/../b.ts' }));
		assert.ok(!validateInsertReference({ path: 'C:relative.ts' }));
		assert.ok(!validateInsertReference({ path: '/a.ts', startLine: 0 }));
		assert.ok(!validateInsertReference({ path: '/a.ts', startLine: 1.5 }));
		assert.ok(!validateInsertReference({ path: '/a.ts', startLine: '3' }));
		assert.ok(!validateInsertReference({ path: '/a.ts', startLine: 9, endLine: 3 }));
	});
});

suite('dshChatSession / preset 会话 id 派生（方案 5.15.2）', () => {
	test('基座会话 id 与既有规则一致（无后缀、小写、仅 [a-z0-9-]）', () => {
		assert.strictEqual(dshChatSessionId('default'), 'vssaros-chat-default');
		assert.strictEqual(dshChatSessionId('chat-1791618174410-23i8vz'), 'vssaros-chat-chat-1791618174410-23i8vz');
		assert.strictEqual(dshChatSessionId('My Chat_X'), 'vssaros-chat-my-chat-x');
	});

	test('preset 专属会话 id = 基座 id + --preset（确定性）', () => {
		assert.strictEqual(dshChatPresetSessionId('default', 'ptc'), 'vssaros-chat-default--ptc');
		assert.strictEqual(dshChatPresetSessionId('default', 'PTC'), 'vssaros-chat-default--ptc');
		assert.strictEqual(dshChatPresetSessionId('a', 'my preset'), 'vssaros-chat-a--my-preset');
	});

	test('resolvePresetSessionId：已知映射 > 基座 preset > 派生', () => {
		const known = new Map([['ptc', 'vssaros-chat-c1--ptc']]);
		assert.strictEqual(resolvePresetSessionId('c1', 'ptc', { known }), 'vssaros-chat-c1--ptc');
		// 基座 preset 回到无后缀 id（保住原历史）
		assert.strictEqual(resolvePresetSessionId('c1', 'standard', { basePreset: 'standard' }), 'vssaros-chat-c1');
		// 未知基座 + 未知 preset → 确定性派生
		assert.strictEqual(resolvePresetSessionId('c1', 'cordis', { basePreset: 'standard' }), 'vssaros-chat-c1--cordis');
		// 基座未知时同 id 也派生（习得前的窄窗口，幂等接管自愈）
		assert.strictEqual(resolvePresetSessionId('c1', 'standard', {}), 'vssaros-chat-c1--standard');
	});

	test('isDshChatSessionId 只认派生形态', () => {
		assert.ok(isDshChatSessionId('vssaros-chat-default'));
		assert.ok(isDshChatSessionId('vssaros-chat-default--ptc'));
		assert.ok(!isDshChatSessionId('vssaros-chat-'));
		assert.ok(!isDshChatSessionId('vssaros-chat-A')); // 大写不在派生输出里
		assert.ok(!isDshChatSessionId('session-123'));
		assert.ok(!isDshChatSessionId('vssaros-chat-' + 'a'.repeat(200)));
		assert.ok(!isDshChatSessionId(42));
	});

	test('sanitizeDshIdPart：去掉首尾连字符、折叠非法字符', () => {
		assert.strictEqual(sanitizeDshIdPart('PTC'), 'ptc');
		assert.strictEqual(sanitizeDshIdPart('--a b--'), 'a-b');
	});
});
