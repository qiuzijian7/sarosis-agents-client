/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 工作区 folder 写入点的「唯一性」不变量 —— **源码级**断言（2026-09-14）。
 *
 * ## 为什么需要这个文件
 *
 * VS Code 的 folder 列表（`IWorkspaceContextService.getWorkspace().folders`）只能由
 * `IWorkspaceEditingService.{addFolders,updateFolders,removeFolders}` 改动。
 * 2026-09-14 实测：sessions 侧**有 4 个独立写入者**在改同一份列表 ——
 *
 *   ① `agentStudio/browser/workspaceFolderSync.ts`        registry 驱动（replace / union）
 *   ② `sessions/contrib/workspace/browser/workspaceFolderManagement.ts`  活动会话驱动
 *   ③ `sessions/contrib/sourceControl/browser/sourceControl.contribution.ts`  SCM 多仓驱动
 *   ④ `sessions/browser/parts/projectBarPart.ts`          项目栏点击驱动
 *
 * 后果（全部实测到过）：
 *   · 用户手写 3 个 folder 的 `.code-workspace` 只显示 1 个（写入者互相覆盖）；
 *   · 切换会话 / 点项目栏会**回写用户的 `.code-workspace`**（把多根裁成单根）；
 *   · ②③ 各自重复发明了「哪些 folder 是文件声明的」判断（`_isDeclaredFolder` /
 *     `_mergeWorkspaceFolders`），与 ① 的 `unionWorkspaceFolders` 同源却各写一份 ——
 *     按本仓的经验（「同一规则出现在 N 处 ⇒ 一定会漂移」）这已经漂移了。
 *
 * ## 这个不变量守什么
 *
 * 守「**写入点的数量与位置**」。重构（方案 B' Step 1~2）的目标是把写入者收敛成 1 个
 * router，其余模块只能「请求」而不能直接写。收敛过程中每完成一处，就把该文件从
 * `ALLOWED_FOLDER_WRITERS` 里挪走 —— 清单即进度表，且任何人新增写入点会当场失败。
 *
 * 这类缺陷**单测测不出来**：每个写入者自己的逻辑都是对的，错的是「有几个人在写」。
 * 手法与 `guardrailWiring.test.ts` 一致（扫源码 + 剥行注释）。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/workspaceFolderWriters.test.ts
 */

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/** 扫描根 —— sessions 侧全部代码（含 agentStudio）。 */
const SESSIONS = 'src/vs/sessions';

/** folder 列表的三个写入 API（唯一能改 `workspace.folders` 的入口）。 */
const WRITE_CALLS = ['addFolders(', 'updateFolders(', 'removeFolders('] as const;

/**
 * ★ 允许直接写 folder 列表的文件（相对 {@link SESSIONS}）。
 *
 * 目标终态：**只剩一个 router**。每完成一处收敛就从这里删掉对应条目。
 * 新增条目必须在此写明理由 —— 默认答案是「不要新增，改为向 router 发请求」。
 */
const ALLOWED_FOLDER_WRITERS: readonly { readonly file: string; readonly why: string }[] = [
	{
		file: 'contrib/workspace/browser/workspaceFolderRouterImpl.ts',
		why: '★ IWorkspaceFolderRouter 的实现 —— folder 列表的唯一写入者（方案 B\' Step 2 终态）',
	},
	{
		file: 'contrib/agentStudio/browser/workspaceFolderSync.ts',
		why: '旧方向（registry→窗口）的回滚路径，仅当设置为 registry-drives-window 时才执行',
	},
	// ── 收敛记录（2026-09-14 Step 2 完成）─────────────────────────────
	// · `contrib/workspace/browser/workspaceFolderManagement.ts` —— 经核查是**死代码**
	//   （全仓无 import / 注册点，contribution 从未实例化），已删除。
	// · `contrib/sourceControl/browser/sourceControl.contribution.ts` —— 改为
	//   `workspaceFolderRouter.ensureFolders(targets, 'scm-workspace-sync')`。
	// · `browser/parts/projectBarPart.ts` —— 改为 `hostService.openWindow(..., { forceReuseWindow: true })`
	//   （原生「打开工作区/文件夹」语义，用户 2026-09-14 裁决），不再改 folder 列表。
	//
	// 注：`services/workspace/browser/workspaceContextService.ts` 是
	// `IWorkspaceEditingService` 的**实现体**（方法定义），不是调用方 ——
	// 判据要求「带接收者」的调用形态，因此它天然不会被扫到，无需登记。
];

/**
 * 去掉**整行** `//` 注释 —— 源码级不变量只看代码。
 *
 * 刻意不剥块注释：`/\/\*[\s\S]*?\*\//` 会被源码里非注释的 `/*` 序列带偏，
 * 实测能把整段代码吃掉（详见 `guardrailWiring.test.ts` 的同名函数注释）。
 */
function stripComments(src: string): string {
	return src.replace(/^[ \t]*\/\/.*$/gm, '');
}

/** 递归列出目录下所有 `.ts`（跳过测试文件本身，避免测试里的示例代码被当成写入点）。 */
function listSourceFiles(absDir: string, relPrefix = ''): string[] {
	const result: string[] = [];
	for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
		const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			// `test/` 下的文件不参与 —— 它们不是产品代码。
			if (entry.name === 'test' || entry.name === 'node_modules') {
				continue;
			}
			result.push(...listSourceFiles(path.join(absDir, entry.name), rel));
			continue;
		}
		if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
			result.push(rel);
		}
	}
	return result;
}

/**
 * 找出所有**直接调用** folder 写入 API 的文件。
 *
 * 判据刻意用 `workspaceEditingService.<call>` 这种「带接收者」的形态：
 * 只写 `addFolders(` 会把接口声明、实现体的方法定义也算进来。
 */
function findFolderWriters(): string[] {
	const root = path.join(process.cwd(), SESSIONS);
	assert.ok(fs.existsSync(root), `扫描根不存在（路径基准变了？）：${root}`);

	const writers: string[] = [];
	for (const rel of listSourceFiles(root)) {
		const src = stripComments(fs.readFileSync(path.join(root, rel), 'utf8'));
		const hit = WRITE_CALLS.some(call =>
			src.includes(`workspaceEditingService.${call}`) ||
			src.includes(`WorkspaceEditingService.${call}`),
		);
		if (hit) {
			writers.push(rel);
		}
	}
	return writers.sort();
}

suite('Workspace folder writers — 写入点唯一性不变量', () => {

	test('元测试：扫描确实生效（能找到已知的写入者，路径基准未失效）', () => {
		const writers = findFolderWriters();
		assert.ok(
			writers.length > 0,
			'一个 folder 写入点都没扫到 —— 判据或扫描根失效了（不是"已经收敛完成"）',
		);
		assert.ok(
			writers.includes('contrib/agentStudio/browser/workspaceFolderSync.ts'),
			`应能扫到同步器本身，实际扫到：${writers.join(', ')}`,
		);
	});

	test('★★ 不得新增未登记的 folder 写入点（新增请改为向 router 发请求）', () => {
		const writers = findFolderWriters();
		const allowed = new Set(ALLOWED_FOLDER_WRITERS.map(w => w.file));
		const unexpected = writers.filter(w => !allowed.has(w));
		assert.deepStrictEqual(
			unexpected,
			[],
			'出现了未登记的 folder 写入点。folder 列表必须由单一 router 写入，' +
			'否则会与其它写入者互相覆盖（2026-09-14 实测：多根 .code-workspace 被裁成单根）。' +
			`未登记：${unexpected.join(', ')}`,
		);
	});

	test('★ 清单不得腐烂：登记项必须真的还在写（收敛完成后要同步删除条目）', () => {
		const writers = new Set(findFolderWriters());
		const stale = ALLOWED_FOLDER_WRITERS
			.filter(w => !writers.has(w.file))
			.map(w => w.file);
		assert.deepStrictEqual(
			stale,
			[],
			'这些文件已不再直接写 folder 列表（很可能收敛完成了），' +
			`请把它们从 ALLOWED_FOLDER_WRITERS 里删除：${stale.join(', ')}`,
		);
	});

	test('★★ 收敛已完成：不得再有「待收敛」写入者（基线 0，只允许保持）', () => {
		// 进度：启动时 3（②③④）→ 删死代码后 2 → Step 2 完成后 **0**。
		// 现在清单里只剩 router（唯一写入者）与旧方向的回滚路径。
		// 任何新增的「待收敛」条目都意味着又有人绕过 router 直接写 —— 当场失败。
		const pending = ALLOWED_FOLDER_WRITERS.filter(w => w.why.startsWith('待收敛'));
		assert.deepStrictEqual(
			pending.map(w => w.file),
			[],
			'不得再新增直接写 folder 列表的模块，请改为调用 IWorkspaceFolderRouter.ensureFolders()',
		);
	});

	test('★★ router 必须是唯一写入者（除旧方向回滚路径外）', () => {
		const writers = findFolderWriters();
		const unexpected = writers.filter(w =>
			w !== 'contrib/workspace/browser/workspaceFolderRouterImpl.ts' &&
			w !== 'contrib/agentStudio/browser/workspaceFolderSync.ts',
		);
		assert.deepStrictEqual(
			unexpected,
			[],
			`folder 写入必须收口到 router，实际还有：${unexpected.join(', ')}`,
		);
	});

	test('★ SCM 同步与项目栏必须走 router / openWindow（不得回退成直接写）', () => {
		const scm = fs.readFileSync(
			path.join(process.cwd(), SESSIONS, 'contrib/sourceControl/browser/sourceControl.contribution.ts'),
			'utf8',
		);
		assert.ok(
			stripComments(scm).includes('workspaceFolderRouter.ensureFolders('),
			'SCM 同步应通过 router 请求 folder 在场',
		);

		const bar = stripComments(fs.readFileSync(
			path.join(process.cwd(), SESSIONS, 'browser/parts/projectBarPart.ts'),
			'utf8',
		));
		assert.ok(
			bar.includes('hostService.openWindow('),
			'项目栏切项目应走原生「打开工作区/文件夹」语义',
		);
		assert.ok(
			bar.includes('forceReuseWindow: true'),
			'按 2026-09-14 用户裁决：切换项目复用当前窗口',
		);
	});

	test('★★ 兜底工作区文件不得再作为任何「判据」使用（只能当 configPath 容器）', () => {
		// 2026-09-14 事故：`isSessionsWindow` 曾用「workspace.configPath === agentSessionsWorkspace」
		// 判定，导致用户用自己的 `.code-workspace` 打开时窗口退化成**标准 VS Code 界面**
		// （该标志决定加载 sessions.html 还是 workbench.html，见 windowImpl.ts）。
		//
		// 结论：`agentSessionsWorkspace` 只是「窗口需要一个 configPath」的兜底容器，
		// **不表达任何语义**。此断言防止同类判据复活。
		const abs = path.join(process.cwd(), 'src/vs/platform/windows/electron-main/windowsMainService.ts');
		assert.ok(fs.existsSync(abs), `源码文件不存在（路径基准变了？）：${abs}`);
		const src = stripComments(fs.readFileSync(abs, 'utf8'));

		const marker = 'isSessionsWindow:';
		const idx = src.indexOf(marker);
		assert.ok(idx > 0, '应能找到 isSessionsWindow 的赋值处');
		const line = src.slice(idx, src.indexOf('\n', idx));
		assert.ok(
			line.includes('isEmbeddedApp'),
			`isSessionsWindow 必须由「是否 agents 应用」决定（isEmbeddedApp），实际：${line.trim()}`,
		);
		assert.ok(
			!line.includes('agentSessionsWorkspace'),
			`isSessionsWindow 不得再用兜底工作区文件做判据，实际：${line.trim()}`,
		);
	});
});

suite('Workspace 三态与原生命令 — 方案 B\' Step 3 不变量', () => {

	const WINDOWS_MAIN = 'src/vs/platform/windows/electron-main/windowsMainService.ts';
	const WORKSPACE_ACTIONS = 'src/vs/workbench/browser/actions/workspaceActions.ts';

	function readAbs(rel: string): string {
		const abs = path.join(process.cwd(), rel);
		assert.ok(fs.existsSync(abs), `源码文件不存在（路径基准变了？）：${abs}`);
		return stripComments(fs.readFileSync(abs, 'utf8'));
	}

	test('★★ agents 窗口支持 EMPTY 态（不得再无条件塞一个工作区文件）', () => {
		const src = readAbs(WINDOWS_MAIN);
		assert.ok(
			src.includes('urisToOpen: []'),
			'`ensureAgentsWindow` 必须有一条「空窗口」出口 —— 否则 WorkbenchState 恒为 WORKSPACE，' +
			'「关闭工作区 / 打开文件夹 / 另存为工作区」等原生动作全部失去意义',
		);
	});

	test('★★ 兜底工作区文件不得再被主动创建（已降级为可选）', () => {
		const src = readAbs(WINDOWS_MAIN);
		// 旧实现：兜底文件不存在时 `writeFile(..., '{"folders": []}')` 主动造一个，
		// 于是每个新用户都被塞进 WORKSPACE 态。现在只在它**已存在**时沿用。
		assert.ok(
			!src.includes(`JSON.stringify({ folders: [] }`),
			'不得再主动创建兜底工作区文件；只有当它已存在于磁盘时才沿用（兼容老用户）',
		);
	});

	test('★ 显式请求的文件夹要原样放行（单文件夹工作区）', () => {
		const src = readAbs(WINDOWS_MAIN);
		assert.ok(
			src.includes('_hasExplicitFolderRequest('),
			'应能识别「显式请求打开文件夹」并原样放行给标准 open() 流程',
		);
	});

	test('★★ 7 个原生 workspace 命令必须在 agents 窗口可用（不得再整体屏蔽）', () => {
		const src = readAbs(WORKSPACE_ACTIONS);
		assert.ok(
			!src.includes('IsSessionsWindowContext'),
			'`workspaceActions.ts` 不得再用 IsSessionsWindowContext 屏蔽命令 —— ' +
			'Open Workspace / Close Workspace / Add·Remove Folder / Save As / Duplicate 是用户自救入口',
		);
		// 正向：这些 action 仍然存在（防「为了让断言过而把命令删掉」）。
		for (const id of [
			'workbench.action.openWorkspace',
			'workbench.action.closeFolder',
			'workbench.action.addRootFolder',
			'workbench.action.removeRootFolder',
			'workbench.action.saveWorkspaceAs',
			'workbench.action.duplicateWorkspaceInNewWindow',
			'workbench.action.openWorkspaceConfigFile',
		]) {
			assert.ok(src.includes(id), `命令 ${id} 应仍然注册`);
		}
	});

	test('★ 显式打开的工作区要进「最近打开」（用户自救入口）', () => {
		const src = readAbs(WINDOWS_MAIN);
		assert.ok(
			src.includes('noRecentEntry: false'),
			'用户显式打开的工作区必须写入 Open Recent；自动恢复的路径才用 noRecentEntry: true',
		);
	});
});

suite('跨工作区污染防线 — 2026-09-14 事故不变量', () => {

	const SYNC = path.join(process.cwd(), SESSIONS, 'contrib/agentStudio/browser/workspaceFolderSync.ts');
	const SCM = path.join(process.cwd(), SESSIONS, 'contrib/sourceControl/browser/sourceControl.contribution.ts');
	const SIDEBAR = path.join(process.cwd(), SESSIONS, 'browser/parts/sidebarPart.ts');
	const AGENT_STUDIO = path.join(process.cwd(), SESSIONS, 'contrib/agentStudio/browser/agentStudioService.ts');
	const POLICY = path.join(process.cwd(), SESSIONS, 'contrib/agentStudio/common/workspaceFolderSyncPolicy.ts');

	test('★★ SCM 同步在「窗口为真源」方向下不得注入 folder（污染源头）', () => {
		// 事故复盘：`_syncWorkspaceFolder` 由 onDidChangeActiveWorkspace 驱动 + 追加式合并（只加不减）
		// ⇒ 切到别的工作区就把它的 root（含 87.6 万节点的 UE5EA）追加进当前窗口，且**落盘**到
		// 用户手写的 `.code-workspace`（实测 3 个 folder 被改成 5 个）。
		const src = stripComments(fs.readFileSync(SCM, 'utf8'));
		const idx = src.indexOf('ensureFolders(');
		assert.ok(idx > 0, '应能找到 ensureFolders 调用处');
		// 该调用必须被方向判定包裹 —— 只在旧方向（registry 驱动）下才允许注入。
		const before = src.slice(Math.max(0, idx - 400), idx);
		assert.ok(
			before.includes(`'registry-drives-window'`),
			'SCM 的 ensureFolders 必须仅在 registry-drives-window 方向下执行，否则会跨工作区污染 folder 列表',
		);
	});

	test('★★ 切换活动工作区时不得反向投影（会把旧工作区的 folder 写进新记录）', () => {
		// 实测：切到 `sarosis-agents-client-uf2z3` 的同一毫秒写入了 relatedFolders=4，
		// 其中含另一个工作区的 S1Game / UE5EA。
		const src = stripComments(fs.readFileSync(SYNC, 'utf8'));
		const marker = '_syncWorkspaceFolder(workspaceId: string | undefined)';
		const idx = src.indexOf(marker);
		assert.ok(idx > 0, '应能找到 _syncWorkspaceFolder 定义');
		// 取方法开头到第一个 return 为止的「跳过分支」，其中不得再调用反向投影。
		const head = src.slice(idx, idx + 900);
		assert.ok(
			!head.includes('_projectWindowFoldersToRegistry('),
			'onDidChangeActiveWorkspace 路径上不得调用反向投影 —— 此刻 folder 列表仍属上一个工作区',
		);
	});

	test('★★ 反向投影必须带工作区身份守卫', () => {
		// 2026-09-15（P0）升级：判据从「窗口主 root == 记录 path」两个字符串
		// 换成 `matchWorkspaceIdentity(记录, 窗口身份)` —— 三级判据
		// （工作区文件 > 主 root > root 集合）。
		// 旧判据在「记录 path 是 .code-workspace 文件」时**恒不匹配** ⇒ 守卫恒跳过 ⇒
		// 记录永不同步（多根丢失的真因之一）。
		const src = stripComments(fs.readFileSync(SYNC, 'utf8'));
		assert.ok(
			src.includes('matchWorkspaceIdentity('),
			'反向投影前必须做完整身份匹配，否则会把 A 窗口的 folder 写进 B 工作区',
		);
	});

	test('★ 删除工作区必须真的弹确认（函数名不能撒谎）', () => {
		// 原实现 `_confirmDeleteWorkspace` 名字带 confirm，实际直接调 deleteWorkspace，
		// 点一下 `×` 就永久删掉记录，零挽回。
		const src = stripComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const idx = src.indexOf('_confirmDeleteWorkspace(ws: Workspace)');
		assert.ok(idx > 0, '应能找到 _confirmDeleteWorkspace 定义');
		const body = src.slice(idx, idx + 1800);
		const confirmAt = body.indexOf('.confirm(');
		const deleteAt = body.indexOf('deleteWorkspace(');
		assert.ok(confirmAt > 0, '删除工作区前必须调用 dialogService.confirm()');
		assert.ok(
			confirmAt < deleteAt,
			'confirm() 必须在 deleteWorkspace() 之前 —— 否则等于先删后问',
		);
		assert.ok(
			body.includes('if (!confirmed)'),
			'必须在用户取消时提前 return',
		);
	});

	test('★★ 「转空工作区」只能开空窗口，不得用 removeFolders 清 folder', () => {
		// 用户 2026-09-15 选择「删当前工作区 → 窗口一并关闭」。
		// 致命坑：用 `removeFolders(全部)` 实现会被标准 WorkspaceService **回写 .code-workspace**，
		// 等于清空用户手写的 folders —— 与 09-14 那起「用户资产被改坏」事故同一条路。
		const src = stripComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const idx = src.indexOf('_confirmDeleteWorkspace(ws: Workspace)');
		const body = src.slice(idx, idx + 2600);
		assert.ok(
			body.includes('openWindow({ forceReuseWindow: true })'),
			'转空工作区必须走 hostService.openWindow({ forceReuseWindow: true })',
		);
		assert.ok(
			!body.includes('removeFolders(') && !body.includes('updateFolders('),
			'删除工作区流程中不得出现 removeFolders/updateFolders —— 会回写用户的 .code-workspace',
		);
	});

	test('★ 关工作区时必须清 last-user-workspace.json（否则重启复活）', () => {
		const src = stripComments(fs.readFileSync(SIDEBAR, 'utf8'));
		assert.ok(
			src.includes(`'last-user-workspace.json'`),
			'必须清掉 remembered 工作区文件，否则下次启动会把已删的工作区又打开一遍',
		);
	});

	test('★★ 切换工作区必须真的换 folder（只翻 registry 游标 ⇒ sideview 不刷新）', () => {
		// 2026-09-15 用户日志铁证：下拉切换 6 次，每行 window folder 列表完全一致，
		// 且 onDidChangeWorkspaceFolders 出现 0 次 —— 原生 Explorer 无变化可刷。
		// 侧栏三个入口原先都只调 setActiveWorkspace。
		const src = stripComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const idx = src.indexOf('_switchWorkspace(ws: Workspace, entry: string)');
		assert.ok(idx > 0, '应能找到 _switchWorkspace 定义');
		const body = src.slice(idx, idx + 4000);

		// 首选路径 = 内存替换（用户 2026-09-15 裁决：不重载窗口）。
		assert.ok(
			body.includes('_getInMemoryFolderReplacer()') && body.includes('replaceInMemory('),
			'切换工作区必须优先走内存内 folder 替换（否则要么重载窗口、要么 sideview 不刷新）',
		);
		// 回退路径必须保留（标准 IDE 窗口没有该接缝）。
		assert.ok(
			body.includes('openWindow(openables, { forceReuseWindow: true })'),
			'拿不到内存接缝时必须回退 openWindow —— 不能静默什么都不做',
		);
		// 必须有解析 roots 的一步：否则多根工作区切过去只剩 1 个根。
		assert.ok(
			src.includes('_resolveWorkspaceRoots('),
			'必须解析出全部 root（.code-workspace 的多 folder / relatedFolders）',
		);

		// 三个入口都必须接到 _switchWorkspace 上，不能有漏网的 setActiveWorkspace-only 入口。
		for (const entry of ['sidebar-dropdown', 'sidebar-open-folder', 'sidebar-open-file']) {
			assert.ok(
				src.includes(`'${entry}'`),
				`入口 ${entry} 必须走 _switchWorkspace（带上 entry 标识便于日志定位）`,
			);
		}

		// ★★ 切换前必须**重新取回**记录：`createWorkspace()`/`updateWorkspace()` 的返回值
		// 拿在「addRelatedFolder() 补 relatedFolders 之前」⇒ 用它切换只会解析出 1 个 root。
		// 日志实证：`entry=sidebar-open-file | extraFolders=2 | ... roots=1`。
		const staleCount = (src.match(/_switchWorkspace\(target,/g) ?? []).length;
		assert.strictEqual(
			staleCount, 0,
			'不得把 createWorkspace/updateWorkspace 的返回值直接交给 _switchWorkspace —— 它可能还没带上 relatedFolders',
		);
		assert.ok(
			(src.match(/this\._workspaces\.find\(w => w\.id === target\.id\)/g) ?? []).length >= 2,
			'「打开文件夹」「打开工作区文件」两个入口都必须先重新取回记录再切换',
		);
	});

	test('★★ 内存替换必须不落盘（否则回写用户 .code-workspace，即 09-14 事故）', () => {
		// 用户 2026-09-15 选方案 A：在标准 WorkspaceService 加内存替换接缝，
		// 「复用 folder 记账，唯独不落盘」。这条断言钉死「不落盘」。
		const CONFIG_SERVICE = path.join(process.cwd(), 'src/vs/workbench/services/configuration/browser/configurationService.ts');
		const src = stripComments(fs.readFileSync(CONFIG_SERVICE, 'utf8'));
		const idx = src.indexOf('doReplaceWorkspaceFoldersInMemory(folders: IWorkspaceFolderCreationData[])');
		assert.ok(idx > 0, '应能找到 doReplaceWorkspaceFoldersInMemory 定义');
		const body = src.slice(idx, idx + 1600);

		assert.ok(
			body.includes('updateWorkspaceConfiguration('),
			'必须复用 updateWorkspaceConfiguration() 的记账（folder 配置模型增删 + will/did 事件）',
		);
		for (const forbidden of ['setFolders(', 'jsonEditingService', 'writeFile']) {
			assert.ok(
				!body.includes(forbidden),
				`内存替换不得出现 ${forbidden} —— 那会回写用户的 .code-workspace 文件`,
			);
		}
	});

	test('★ 切换必须支持 relatedFolders → 多 root（自动合成多根工作区）', () => {
		// 回退路径：main 进程 windowsMainService.ts:1141-1160 —— urisToOpen 非空
		// （API 调用）时，多个 folderUri 会被自动合成 untitled 多根工作区。
		const src = stripComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const idx = src.indexOf('_buildWorkspaceOpenables(ws: Workspace, roots: URI[])');
		assert.ok(idx > 0, '应能找到 _buildWorkspaceOpenables 定义');
		const body = src.slice(idx, idx + 900);
		assert.ok(
			body.includes('hasWorkspaceFileExtension'),
			'path 指向 .code-workspace 文件时必须用 workspaceUri 打开（保留多根与文件关联）',
		);
		assert.ok(
			body.includes('roots.map('),
			'目录形态必须把**全部** root 展开成 folderUri，否则切过去会丢掉附加 root',
		);

		// 解析 roots 的那一步必须覆盖 relatedFolders（目录形态）与文件内的 folders（文件形态）。
		const rootsIdx = src.indexOf('_resolveWorkspaceRoots(ws: Workspace)');
		assert.ok(rootsIdx > 0, '应能找到 _resolveWorkspaceRoots 定义');
		const rootsBody = src.slice(rootsIdx, rootsIdx + 1400);
		assert.ok(
			rootsBody.includes('relatedFolders'),
			'目录形态必须把 relatedFolders 一并作为 root',
		);
		assert.ok(
			rootsBody.includes('_resolveCodeWorkspaceFolders'),
			'.code-workspace 形态必须读文件里的全部 folder（JSONC）',
		);
	});

	test('★★ 启动补齐多根必须带「真子集」闸门（防覆盖用户显式打开的工作区）', () => {
		// 启动工作区来自 `last-user-workspace.json`（只存一个路径）⇒ 需要按当前
		// Agent Studio 工作区补齐 relatedFolders。但**不能无条件**补：
		// 若窗口打开的是另一个工作区/用户显式打开的 .code-workspace，覆盖会误伤。
		const src = stripComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const idx = src.indexOf('_applyActiveWorkspaceRootsOnStartup()');
		assert.ok(idx > 0, '应能找到 _applyActiveWorkspaceRootsOnStartup 定义');
		const body = src.slice(idx, idx + 2600);

		assert.ok(
			body.includes('isStrictSubset'),
			'必须有「窗口 roots 是工作区 roots 的真子集」判定',
		);
		assert.ok(
			body.includes('targetKeys.has(key)'),
			'子集判定必须逐个 root 比对（而非只看数量）',
		);
		assert.ok(
			body.includes('currentKeys.length < targetKeys.size'),
			'必须要求**严格更小** —— 相等时无需动作',
		);
		assert.ok(
			body.includes('_getInMemoryFolderReplacer()'),
			'补齐必须走内存替换（不重载窗口、不写文件）',
		);
		// 与切换一致：不得用 removeFolders/updateFolders（会回写用户工作区文件）。
		assert.ok(
			!body.includes('removeFolders(') && !body.includes('updateFolders('),
			'启动补齐不得出现 removeFolders/updateFolders',
		);
	});

	test('★★ 原地换工作区不得调用原生 enterWorkspace（它会重写用户 .code-workspace）', () => {
		// `IWorkspaceEditingService.enterWorkspace()` 内部（从 FOLDER 态进入时）会调
		// `migrateWorkspaceSettings()` → `doCopyWorkspaceSettings()`，末行是
		// `jsonEditingService.write(toWorkspace.configPath, [{path:['settings'],…}])`
		// ⇒ **重写用户 `.code-workspace` 的 settings 块**（2026-09-14 那类事故）。
		// 且它会 stop/start 扩展宿主（用户 2026-09-15 要求去掉）。
		// 因此必须自己走 `configurationService.initialize(identifier)`（只做核心那一步）。
		const src = stripComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const idx = src.indexOf('_enterWorkspaceFile(fileUri: URI, entry: string, wsId: string)');
		assert.ok(idx > 0, '应能找到 _enterWorkspaceFile 定义');
		const body = src.slice(idx, idx + 2600);

		assert.ok(
			!body.includes('enterWorkspace('),
			'不得调用原生 enterWorkspace —— 会重写用户 .code-workspace 的 settings 且重启扩展宿主',
		);
		assert.ok(
			body.includes('configurationService.initialize(identifier)'),
			'必须用 configurationService.initialize() 原地换工作区（不重载、不重启扩展宿主）',
		);
		assert.ok(
			body.includes('getWorkspaceIdentifier(fileUri)'),
			'必须先用 workspacesService 取工作区标识',
		);
	});
});

suite('SidebarPart 布局 — 「底部留白」不变量（2026-09-15）', () => {

	const SIDEBAR = path.join(process.cwd(), SESSIONS, 'browser/parts/sidebarPart.ts');

	test('★★ 展开态必须纠正 layoutContents 的 contentSize（否则内容区矮 70px）', () => {
		// 根因：`PartLayout.layout()`（workbench/browser/part.ts:213-253）用硬编码常量
		// titleSize=35（hasTitle）/ headerSize=35（headerVisible）算 contentSize。
		// 而 sessions 侧栏展开态里标题被 `display:none`、图标条在 **grid column 1**（侧列）
		// ⇒ 两者都不占纵向空间，却各被扣 35px。
		// 真机日志：height=997 → titleSize=35, headerSize=35 → contentSize=927 ⇒ 底部留白 70px。
		const src = stripComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const idx = src.indexOf('layoutContents(width: number, height: number)');
		assert.ok(idx > 0, 'SidebarPart 必须覆写 layoutContents() 来纠正 contentSize');
		const body = src.slice(idx, idx + 2000);
		// ★ 2026-09-15 校准：原先断言「只在展开态纠正（`_contentCollapsed`）」，
		// 但源码随后**刻意删掉了**那个提前 return —— 真机实测该守卫会让纠正**从不执行**
		// （`PartLayout.layout()` 写的偏小值成为最终值 ⇒ 底部留白 70px 复发）。
		// 折叠态无需特殊对待：那时 `.content` 本就 `display:none`，纠正高度没有视觉影响。
		// ⇒ 现在的正确不变量是「**不得**因折叠态提前 return」。
		const layoutBody = src.slice(idx, idx + 900);
		assert.ok(
			!layoutBody.includes('if (this._contentCollapsed)') || !layoutBody.includes('return result;'),
			'不得因折叠态提前 return —— 那会让下面的 contentSize 纠正从不执行（实测回归）',
		);
		assert.ok(
			body.includes('new Dimension(width, contentHeight)'),
			'contentSize 必须用**实测高度**，不得直接用入参 height',
		);
		assert.ok(
			body.includes('size(this.contentArea'),
			'必须同时覆盖 PartLayout 刚内联上去的偏小高度',
		);
		// ★ 2026-09-15 校准（源码随后改成"从 DOM 实测反推"）：入参 `height` 是**内容区高度**
		// （已减去标题区）⇒ 直接拿它当"部件满高"会算出 1287（部件实高 1325），留白照旧。
		// 现在必须用**矩形相减**（`offsetTop` 会被 offsetParent 带偏，实测拿到 ~70 ✗）。
		assert.ok(body.includes('getBoundingClientRect()'), '必须用 DOM 矩形实测反推真实可用高度');
		assert.ok(
			body.includes('partRect.bottom - contentRect.top'),
			'必须用矩形相减（用 offsetTop 会被 offsetParent 带偏 ⇒ 等于没修）',
		);
		assert.ok(body.includes('height + result.titleSize.height'), 'DOM 未就绪时必须有兜底（把标题区加回来）');
	});
});

suite('P0 工作区身份收口 — 按身份 upsert 不变量（2026-09-15）', () => {

	const SYNC = path.join(process.cwd(), SESSIONS, 'contrib/agentStudio/browser/workspaceFolderSync.ts');
	const AGENT_STUDIO = path.join(process.cwd(), SESSIONS, 'contrib/agentStudio/browser/agentStudioService.ts');
	const SIDEBAR = path.join(process.cwd(), SESSIONS, 'browser/parts/sidebarPart.ts');
	const POLICY = path.join(process.cwd(), SESSIONS, 'contrib/agentStudio/common/workspaceFolderSyncPolicy.ts');

	test('★★★ 投影前必须**先按身份 upsert**，再读 activeWorkspaceId（顺序不可颠倒）', () => {
		// 顺序颠倒的后果：`activeWorkspaceId` 可能指向无关记录（启动兜底），
		// 而身份守卫会把它拦掉 ⇒ 记录永远不同步（多根丢失 / 记录不更新的真因）。
		const src = stripComments(fs.readFileSync(SYNC, 'utf8'));
		// ⚠ 锚点必须落在**方法定义**上：`_projectWindowFoldersToRegistry()` 这个字符串
		// 在构造函数里也出现（事件回调），先命中的话切片会从回调处开始、顺序断言必错。
		const body = src.slice(src.indexOf('_projectWindowFoldersToRegistry(): Promise<void>'));
		const ensureAt = body.indexOf('ensureWorkspaceForWindow(');
		const activeAt = body.indexOf('getActiveWorkspaceId()');
		assert.ok(ensureAt > 0, '必须调用 ensureWorkspaceForWindow');
		assert.ok(activeAt > 0, '仍需读取 activeWorkspaceId 作为兜底');
		assert.ok(
			ensureAt < activeAt,
			'ensureWorkspaceForWindow 必须在 getActiveWorkspaceId() **之前** —— 否则兜底到无关记录后守卫会拦掉投影',
		);
	});

	test('★★ upsert 必须幂等：先按身份查找，命中即返回（不新建、不写盘）', () => {
		const src = stripComments(fs.readFileSync(AGENT_STUDIO, 'utf8'));
		const idx = src.indexOf('async ensureWorkspaceForWindow(');
		assert.ok(idx > 0, '应能找到 ensureWorkspaceForWindow 定义');
		const body = src.slice(idx, idx + 2600);
		const findAt = body.indexOf('findWorkspaceByIdentity(');
		const pushAt = body.indexOf('workspaces.push(');
		assert.ok(findAt > 0, '必须先用 findWorkspaceByIdentity 查找');
		assert.ok(findAt < pushAt, '查找必须在 push 之前 —— 否则每次启动都会新建重复记录');
		assert.ok(
			body.slice(findAt, pushAt).includes('return found.record'),
			'命中已存在记录时必须直接返回（幂等）',
		);
	});

	test('★ upsert 对空窗口 / 无主 root 必须拒绝建记录', () => {
		// 空窗口没有可绑定的东西；无主 root 的记录是"path-less 陷阱"
		// （`resolveDefaultActiveWorkspaceId` 明确会跳过它们，建出来只会造成困惑）。
		const src = stripComments(fs.readFileSync(AGENT_STUDIO, 'utf8'));
		const idx = src.indexOf('async ensureWorkspaceForWindow(');
		const head = src.slice(idx, idx + 900);
		assert.ok(head.includes('if (!identity.codeWorkspacePath && identity.folderPaths.length === 0)'), '空窗口必须直接返回');
		assert.ok(head.includes('if (!projection.path)'), '无主 root 必须直接返回');
	});

	test('★★ 新建记录必须把工作区身份显式写进去（否则下次启动又靠猜）', () => {
		const src = stripComments(fs.readFileSync(AGENT_STUDIO, 'utf8'));
		const idx = src.indexOf('async ensureWorkspaceForWindow(');
		const body = src.slice(idx, idx + 2600);
		assert.ok(
			body.includes('codeWorkspacePath: identity.codeWorkspacePath'),
			'必须写入 codeWorkspacePath —— 它是「这个工作区源自哪个 .code-workspace 文件」的唯一显式记录',
		);
		assert.ok(
			body.includes('relatedFolders: projection.relatedFolders'),
			'必须把其余 root 写入 relatedFolders（多根恢复的依据）',
		);
	});

	test('★★ 删除判定必须走完整身份匹配（不得退回「窗口主root vs 记录path」）', () => {
		// 旧版比字符串：记录 path 是 .code-workspace 文件时恒不匹配 ⇒ 删了当前工作区却不关窗口。
		const policy = stripComments(fs.readFileSync(POLICY, 'utf8'));
		const idx = policy.indexOf('export function planWindowOnDeleteWorkspace(');
		assert.ok(idx > 0, '应能找到 planWindowOnDeleteWorkspace');
		const body = policy.slice(idx, idx + 900);
		assert.ok(
			body.includes('matchWorkspaceIdentity(deletedRecord, windowIdentity)'),
			'删除判定必须用完整身份匹配（文件 > 主 root > root 集合）',
		);
	});

	test('★ sidebarPart 必须传**窗口身份**而非单个 root 路径', () => {
		const src = stripComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const idx = src.indexOf('planWindowOnDeleteWorkspace(');
		assert.ok(idx > 0, '应能找到调用点');
		// 身份构造在调用点**之前**几行 ⇒ 取调用点前后的窗口，不能只往后切。
		const call = src.slice(Math.max(0, idx - 400), idx + 200);
		assert.ok(
			call.includes('workspaceIdentityFromWindow('),
			'必须构造完整窗口身份传入 —— 否则文件态工作区删除后不会关窗口',
		);
	});
});

suite('工作区下拉框重构不变量（2026-09-15）', () => {

	const SIDEBAR = path.join(process.cwd(), SESSIONS, 'browser/parts/sidebarPart.ts');
	const CSS = path.join(process.cwd(), SESSIONS, 'browser/parts/media/sidebarPart.css');

	/**
	 * 剥掉**行注释与块注释**。
	 *
	 * ⚠ 本文件共用的 `stripComments` 只剥行注释 ⇒ 块注释里的说明文字会被当成代码。
	 * 本套件的负向断言（「不得出现 X」）正是被它坑到过：`sidebarPart.ts` 里一段
	 * `/** … *\/` 的说明提到了「不重载窗口」，于是断言假失败。
	 * 这里用更彻底的版本，**只作用于本套件**（不动共用实现，避免翻转其它断言）。
	 *
	 * ★ 共用实现**刻意**不剥块注释（有实测依据：块注释正则会被非注释的 `/*` 带偏、
	 * 把代码整段吃掉 ⇒ 正向断言乱报）—— 见 `guardrailWiring.test.ts` 同名函数的注释。
	 * **别去"顺手修"它**；需要负向断言时就在本套件内用这个严格版。
	 */
	function stripAllComments(src: string): string {
		return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
	}

	/** 取某个方法体：从**定义**处到下一个同级成员（避免命中调用点 —— 本轮踩过两次）。 */
	function bodyOf(src: string, definition: string, span = 2400): string {
		const idx = src.indexOf(definition);
		assert.ok(idx > 0, `应能找到定义：${definition}`);
		return src.slice(idx, idx + span);
	}

	test('★★★ 状态必须按身份分组（✓ 曾只表示 registry 游标，与窗口会错配）', () => {
		// 判据必须与反向投影守卫、删除判定**同源**（`matchWorkspaceIdentity`），
		// 否则同一件事在三个地方有三种答案。
		const src = stripAllComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const body = bodyOf(src, 'private _renderWorkspaceList(): void');
		assert.ok(
			body.includes('matchWorkspaceIdentity('),
			'分组判据必须用 matchWorkspaceIdentity（与 P0 身份模型同源）',
		);
		assert.ok(body.includes('本窗口正在打开'), '必须有「本窗口正在打开」分组');
		assert.ok(body.includes('其他工作区'), '必须有「其他工作区」分组');
	});

	test('★★ 必须显示「仅注册表选中」与「本窗口」的区别（● / ○ 两种标记）', () => {
		const src = stripAllComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const body = bodyOf(src, 'private _createWorkspaceItemEl(ws: Workspace, openHere: boolean): void');
		assert.ok(body.includes("'●'") && body.includes("'○'"), '两种状态必须视觉可区分');
	});

	test('★★★ 不得出现「重载窗口」提示（用户 2026-09-15 裁决）', () => {
		// `_switchWorkspace` 现在优先走原生 `enterWorkspace`（不重载）与内存内 folder 替换
		// （不重载），只有拿不到内存接缝时才回退 `openWindow` ⇒ 标出来是误导。
		const src = stripAllComments(fs.readFileSync(SIDEBAR, 'utf8'));
		assert.ok(!src.includes('重载窗口'), '不得显示「重载窗口」文案');
		assert.ok(!src.includes('reload the window'), '不得用英文文案暗示切换会重载');
	});

	test('★★ 搜索必须**按需**（默认隐藏 + 阈值）', () => {
		const src = stripAllComments(fs.readFileSync(SIDEBAR, 'utf8'));
		assert.ok(src.includes('WORKSPACE_SEARCH_THRESHOLD'), '必须有展开阈值常量');
		// 初始必须隐藏（否则又变回"2 条记录也占一整行"）。
		assert.ok(
			src.includes(`searchRow.style.display = 'none'`),
			'搜索行初始必须隐藏',
		);
		assert.ok(
			src.includes('_showWorkspaceSearch(this._workspaces.length >'),
			'打开面板时按记录数决定是否展开搜索',
		);
	});

	test('★★★ 键盘处理必须在**面板未打开时提前返回**（否则会吞掉编辑器按键）', () => {
		// 尤其 `/`：若不加这个前置判断，在文档里输入斜杠会被吞掉。
		const src = stripAllComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const idx = src.indexOf(`addDisposableListener(document, EventType.KEY_DOWN`);
		assert.ok(idx > 0, '应能找到键盘导航注册处');
		const body = src.slice(idx, idx + 1800);
		assert.ok(
			body.includes(`dropdown.style.display === 'none'`),
			'面板未打开时必须立刻 return',
		);
		assert.ok(
			body.indexOf(`dropdown.style.display === 'none'`) < body.indexOf(`e.key === '/'`),
			'提前返回必须发生在 `/` 分支**之前**',
		);
		for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
			assert.ok(body.includes(`'${key}'`), `必须支持 ${key}`);
		}
	});

	test('★★ 删除按钮 title 必须说清后果（删本窗口那条会转空工作区）', () => {
		const src = stripAllComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const body = bodyOf(src, 'private _createWorkspaceItemEl(ws: Workspace, openHere: boolean): void');
		assert.ok(body.includes('本窗口将转为「无工作区」'), '本窗口那条的 title 必须写明会转空工作区');
		assert.ok(body.includes('磁盘文件不动'), '其他记录的 title 必须写明不动磁盘文件');
	});

	test('★ 路径必须挂 title（做了中间截断，完整值要能读到）', () => {
		const src = stripAllComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const body = bodyOf(src, 'private _createWorkspaceItemEl(ws: Workspace, openHere: boolean): void');
		assert.ok(body.includes('pathSpan.title = ws.path'), '路径必须挂完整值到 title');
	});

	test('★★ CSS：路径中间截断 + 删除按钮默认隐藏（两条都是"非显然"的实现细节）', () => {
		const css = fs.readFileSync(CSS, 'utf8');
		// `direction: rtl` 让溢出发生在左侧 ⇒ 保留尾段目录名（辨识度最高的部分）。
		const pathAt = css.indexOf('.sidebar-toolbar .ws-item-path {');
		assert.ok(pathAt > 0, '应能找到 .ws-item-path 规则');
		assert.ok(css.slice(pathAt, pathAt + 400).includes('direction: rtl'), '.ws-item-path 必须用 rtl 做中间截断');
		// 删除按钮默认隐藏，仅 hover / 键盘高亮时出现。
		const delAt = css.indexOf('.sidebar-toolbar .ws-delete-btn {');
		assert.ok(delAt > 0, '应能找到 .ws-delete-btn 规则');
		assert.ok(css.slice(delAt, delAt + 300).includes('display: none'), '.ws-delete-btn 默认必须隐藏');
		assert.ok(
			css.includes('.ws-dropdown-item:hover .ws-delete-btn'),
			'必须保留 hover 显示删除按钮的规则',
		);
		// 键盘高亮必须与 hover 同视觉。
		assert.ok(css.includes('.ws-dropdown-item.kb'), '必须为键盘高亮定义样式');
	});
});

suite('切换工作区污染（2026-09-15 20:41 事故）', () => {

	const SIDEBAR = path.join(process.cwd(), SESSIONS, 'browser/parts/sidebarPart.ts');
	const CONFIG_SVC = path.join(process.cwd(), 'src/vs/workbench/services/configuration/browser/configurationService.ts');

	function stripAllComments(src: string): string {
		return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
	}

	function bodyOf(src: string, definition: string): string {
		const idx = src.indexOf(definition);
		assert.ok(idx > 0, `应能找到定义：${definition}`);
		const after = idx + definition.length;
		const nextMember = src.slice(after).search(/\n\t(?:private |protected |public )?(?:static )?(?:readonly )?(?:async )?[A-Za-z_$][\w$]*\s*[(:<]/);
		return nextMember >= 0 ? src.slice(idx, after + nextMember) : src.slice(idx);
	}

	test('★★★ 内存内换 folder 后必须**清掉过期的 workspace.configuration**', () => {
		// `updateWorkspaceConfiguration()` 只换 `workspace.folders`，不碰 `configuration`
		// ⇒ 从文件态工作区切到「无文件工作区」后，窗口仍自称在旧工作区文件上
		// ⇒ `matchWorkspaceIdentity()` 第 ① 级判据被过期路径骗到 ⇒ 反向投影把新工作区的
		// root 写进旧记录（跨工作区污染）+ 游标对齐把 active 切回去（来回翻转 ⇒ 图谱反复重载 ⇒ 卡死）。
		const src = stripAllComments(fs.readFileSync(CONFIG_SVC, 'utf8'));
		const body = bodyOf(src, 'private async doReplaceWorkspaceFoldersInMemory');
		const updateAt = body.indexOf('updateWorkspaceConfiguration(');
		const clearAt = body.indexOf('this.workspace.configuration = null');
		assert.ok(updateAt > 0, '应能找到 updateWorkspaceConfiguration 调用');
		assert.ok(clearAt > 0, '必须在换 folder 之后清掉 configuration —— 否则窗口身份是过期值');
		assert.ok(clearAt > updateAt, '清理必须发生在 updateWorkspaceConfiguration **之后**');
	});

	test('★★★ 自愈通道必须能用**文件**校正被写坏的 `path`', () => {
		// 20:41 实测：反向投影把 `path=f:\…\S1Game` 写进了本仓记录，
		// 而 `codeWorkspacePath` 因展开赋值存活 ⇒ 记录自相矛盾。以文件为准校正。
		const src = stripAllComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const body = bodyOf(src, 'private async _recoverWorkspaceFileIdentity(): Promise<void>');
		assert.ok(body.includes('fixing primary root'), '必须有「以文件校正 path」的分支');
		assert.ok(
			body.includes('updateWorkspace(ws.id, { path: result.primaryPath })'),
			'必须把文件解析出的主 root 写回记录',
		);

		// ⚠ 该分支**不得**碰 `relatedFolders` —— 它可能含用户手动关联的目录
		// （`addRelatedFolder`），强制覆盖会销毁用户数据；且 root 解析已改为文件优先，不依赖它。
		// 切片必须**止于该分支自己的 `continue;`** —— 多切一点就会吃到下一个分支（情形 B 会用
		// relatedFolders），那是断言写错而不是实现违规（本轮实测踩到）。
		const fixAt = body.indexOf('fixing primary root');
		const branchEnd = body.indexOf('continue;', fixAt);
		assert.ok(branchEnd > fixAt, '应能找到该分支的结束点');
		const branch = body.slice(fixAt, branchEnd);
		assert.ok(
			!branch.includes('relatedFolders'),
			'校正 path 的分支不得触碰 relatedFolders（可能含用户手动关联的目录）',
		);
	});

	test('★★ 不得靠「加严身份匹配」来兜这个洞（会误伤启动早期 folders 为空的窗口）', () => {
		// 曾在 `matchWorkspaceIdentity` 第 ① 级（两边文件相同）上加「folder 必须相交」的想法，
		// 但启动早期窗口可能 **configuration 已就绪而 folders 还没应用** ⇒ 相交判定为假
		// ⇒ 身份匹配失败 ⇒ P0 的启动解析/投影全废。故修在**状态源头**（上面那条），不动判据。
		const policy = stripAllComments(
			fs.readFileSync(path.join(process.cwd(), SESSIONS, 'contrib/agentStudio/common/workspaceFolderSyncPolicy.ts'), 'utf8'),
		);
		const idx = policy.indexOf('export function matchWorkspaceIdentity(');
		assert.ok(idx > 0, '应能找到 matchWorkspaceIdentity');
		const body = policy.slice(idx, idx + 1400);
		assert.ok(
			!body.includes('folderPaths.length === 0'),
			'不得在判据里加「folders 为空就不算同一个工作区」—— 启动早期会误伤',
		);
	});
});

suite('启动进入工作区文件态（2026-09-15 用户裁决）', () => {

	const SIDEBAR = path.join(process.cwd(), SESSIONS, 'browser/parts/sidebarPart.ts');

	function stripAllComments(src: string): string {
		return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
	}

	function bodyOf(src: string, definition: string): string {
		const idx = src.indexOf(definition);
		assert.ok(idx > 0, `应能找到定义：${definition}`);
		const after = idx + definition.length;
		const nextMember = src.slice(after).search(/\n\t(?:private |protected |public )?(?:static )?(?:readonly )?(?:async )?[A-Za-z_$][\w$]*\s*[(:<]/);
		return nextMember >= 0 ? src.slice(idx, after + nextMember) : src.slice(idx);
	}

	test('★★★ 启动时必须先尝试进入文件态，且成功就**不再做**内存 root 替换', () => {
		const src = stripAllComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const body = bodyOf(src, 'private async _applyActiveWorkspaceRootsOnStartup(): Promise<void>');
		const tryAt = body.indexOf('_tryEnterActiveWorkspaceFileOnStartup(ws)');
		const replacerAt = body.indexOf('_getInMemoryFolderReplacer()');
		assert.ok(tryAt > 0, '启动流程必须调用 _tryEnterActiveWorkspaceFileOnStartup');
		assert.ok(
			tryAt < replacerAt,
			'进入文件态必须排在内存替换**之前** —— 文件态下 root 与 settings 都由文件决定，内存替换是多余的',
		);
		assert.ok(
			body.includes('if (await this._tryEnterActiveWorkspaceFileOnStartup(ws)) {'),
			'进入成功必须提前 return（否则又用内存替换覆盖一遍）',
		);
	});

	test('★★★ 四条闸门缺一不可（防把用户拽进别的工作区 / 防反复触发）', () => {
		const src = stripAllComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const body = bodyOf(src, 'private async _tryEnterActiveWorkspaceFileOnStartup(ws: Workspace): Promise<boolean>');

		// ① 记录必须带 `.code-workspace` 文件
		assert.ok(body.includes('hasWorkspaceFileExtension(filePath)'), '必须要求记录带工作区文件');
		// ② 窗口已经在该文件上 ⇒ 跳过（并返回 true：folder 由文件决定，无需再补）
		assert.ok(
			body.includes('identity.codeWorkspacePath && norm(identity.codeWorkspacePath) === norm(filePath)'),
			'窗口已在该文件上时必须跳过（避免 initialize 反复触发）',
		);
		// ③ 记录必须**就是**当前窗口 —— 与反向投影守卫、删除判定同源
		assert.ok(
			body.includes(`matchWorkspaceIdentity(ws, identity) === 'none'`),
			'记录不是当前窗口时绝不能进入（activeWorkspaceId 只是游标，启动兜底会选错）',
		);
		// ④ 每次会话只做一次
		assert.ok(
			body.includes('if (this._enteredWorkspaceFileOnStartup)'),
			'必须用一次性标志避免反复 initialize',
		);
		// ⑤ 时序闸门：必须等窗口恢复到启动状态
		assert.ok(
			body.includes('lifecycleService.when(LifecyclePhase.Restored)'),
			'必须等 LifecyclePhase.Restored —— initialize 是重操作，不能在启动期与初始化竞争',
		);
	});

	test('★★★ 绝不能走会**重写用户 `.code-workspace`** 的原生路径（用户资产安全）', () => {
		// 原生 `enterWorkspace()` 会先 `migrateWorkspaceSettings()` → `doCopyWorkspaceSettings()`
		// → `jsonEditingService.write(workspaceFile, [settings])` ⇒ **重写用户工作区文件的 settings 块**
		// （09-14 那类"改坏用户资产"）。本仓的 `_enterWorkspaceFile` 刻意**只做**
		// `configurationService.initialize()`，必须守住这条。
		const src = stripAllComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const body = bodyOf(src, 'private async _enterWorkspaceFile(fileUri: URI, entry: string, wsId: string): Promise<boolean>');
		assert.ok(body.includes('configurationService.initialize('), '必须走 configurationService.initialize');
		for (const forbidden of ['enterWorkspace(', 'migrateWorkspaceSettings', 'doCopyWorkspaceSettings', 'jsonEditingService']) {
			assert.ok(!body.includes(forbidden), `不得出现 ${forbidden} —— 它会重写用户的 .code-workspace`);
		}
	});

	test('★★ 进入成功后必须把「记住的上次工作区」写成**该文件**（下次启动原生就是文件态）', () => {
		const src = stripAllComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const body = bodyOf(src, 'private async _tryEnterActiveWorkspaceFileOnStartup(ws: Workspace): Promise<boolean>');
		assert.ok(
			body.includes('_writeRememberedUserWorkspace(URI.file(filePath))'),
			'进入成功后必须记住该文件 —— 否则每次启动都要再切一次（且启动早期仍是 FOLDER 态）',
		);
		assert.ok(
			body.includes('if (!entered)'),
			'进入失败必须回退（返回 false 让调用方走内存替换），不能装作成功',
		);
	});
});

suite('多根丢失事故（2026-09-15）—— 三个修复的不变量', () => {

	const SYNC = path.join(process.cwd(), SESSIONS, 'contrib/agentStudio/browser/workspaceFolderSync.ts');
	const AGENT_STUDIO = path.join(process.cwd(), SESSIONS, 'contrib/agentStudio/browser/agentStudioService.ts');
	const SIDEBAR = path.join(process.cwd(), SESSIONS, 'browser/parts/sidebarPart.ts');

	/**
	 * 剥掉行注释与块注释 —— 本套件有**负向**断言（「不得出现 X」），必须连块注释一起剥。
	 * 共用 `stripComments` 刻意只剥行注释（原因见 `guardrailWiring.test.ts`），此处不动它。
	 */
	function stripAllComments(src: string): string {
		return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
	}

	/** 取方法体：从**定义**处到下一个同级成员（避免命中调用点）。 */
	function bodyOf(src: string, definition: string): string {
		const idx = src.indexOf(definition);
		assert.ok(idx > 0, `应能找到定义：${definition}`);
		const after = idx + definition.length;
		const nextMember = src.slice(after).search(/\n\t(?:private |protected |public )?(?:static )?(?:readonly )?(?:async )?[A-Za-z_$][\w$]*\s*[(:<]/);
		return nextMember >= 0 ? src.slice(idx, after + nextMember) : src.slice(idx);
	}

	test('★★★ 反向投影**写盘前必须重读窗口状态**（入口快照 + await I/O = 用旧状态覆盖新状态）', () => {
		// 事故：构造期调用本方法，入口读到启动时的 1 根快照；await 期间「启动补根」
		// 把窗口扩成 3 根；醒来后用**过期快照**写盘 ⇒ 记录 relatedFolders 被抹成 []。
		// 日志铁证：`reverse (window→registry) | relatedFolders=0` 紧跟 `now folders=3`。
		const src = stripAllComments(fs.readFileSync(SYNC, 'utf8'));
		const body = bodyOf(src, 'private async _projectWindowFoldersToRegistry(): Promise<void>');

		// ① 必须存在可重读的入口，且**被调用两次**（入口一次 + 写盘前一次）。
		// ⚠ 只数 `readWindow()` 调用：定义行是 `const readWindow = () => {`，不含 `readWindow()`。
		assert.ok(body.includes('const readWindow = ()'), '必须把窗口状态读取抽成可重读的入口');
		assert.ok(
			(body.match(/readWindow\(\)/g) ?? []).length >= 2,
			'readWindow() 必须被调用 ≥2 次：入口一次 + 写盘前重读一次',
		);

		// ② 重读必须发生在 await 之后、写盘之前 —— 即「最后一次取窗口状态」晚于 upsert。
		// ⚠ 重算是通过**调用 helper** 完成的，所以判据是「第二次 readWindow() 调用」的位置，
		// 而不是 `projectFoldersToRegistry(` 出现两次（它只在 helper 体内出现一次）。
		const lastReadAt = body.lastIndexOf('readWindow()');
		const ensureAt = body.indexOf('ensureWorkspaceForWindow(');
		assert.ok(ensureAt > 0, '应能找到 ensureWorkspaceForWindow 调用');
		assert.ok(
			lastReadAt > ensureAt,
			'必须在 await（ensureWorkspaceForWindow）**之后**重新读窗口状态 —— 否则写盘用的是过期快照',
		);

		// ③ 写盘与幂等判断必须用 `fresh`，不得再用入口快照的裸 `projection`。
		const writeRegion = body.slice(body.indexOf('isProjectionUnchanged('));
		assert.ok(writeRegion.includes('fresh.projection'), '幂等判断与写盘必须用 fresh.projection');
		assert.ok(
			!writeRegion.includes(': projection.path') && !writeRegion.includes('${projection.path'),
			'写盘区不得再出现裸 projection（只允许 first./fresh. 前缀）',
		);
		assert.ok(
			body.includes('window changed during await'),
			'窗口在 await 期间变化时必须留日志 —— 这条日志本该在本次事故里出现',
		);
	});

	test('★★★ `ensureWorkspaceForWindow` 命中记录时必须**回填 codeWorkspacePath**', () => {
		// 记录缺该字段 ⇒ `_resolveWorkspaceRoots()` 只剩「path + relatedFolders」一条路
		// ⇒ relatedFolders 一旦被窄化写掉，多根**永久无法恢复**（本次事故的终局）。
		const src = stripAllComments(fs.readFileSync(AGENT_STUDIO, 'utf8'));
		const body = bodyOf(src, 'async ensureWorkspaceForWindow(');
		assert.ok(
			body.includes('if (identity.codeWorkspacePath && !found.record.codeWorkspacePath)'),
			'命中且记录缺身份时必须回填 —— 且只在「窗口有、记录无」时（幂等）',
		);
		assert.ok(
			body.includes('codeWorkspacePath: identity.codeWorkspacePath'),
			'回填必须真的写入 codeWorkspacePath',
		);
		assert.ok(
			body.indexOf('codeWorkspacePath: identity.codeWorkspacePath') > body.indexOf('findWorkspaceByIdentity('),
			'回填必须发生在身份查找**之后**（否则会覆盖已有记录的身份）',
		);
	});

	test('★★★ 损坏记录的自愈通道：三重判据缺一不可', () => {
		// 判据刻意收窄，避免「打开任意单根目录却被同目录下无关的 .code-workspace 扩成多根」。
		const src = stripAllComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const body = bodyOf(src, 'private async _recoverWorkspaceFileIdentity(): Promise<void>');

		// ① 只处理「完全没有任何 root 信息」的目录态记录。
		// 实现是一个前置 `continue` 守卫：`!ws.path || ws.codeWorkspacePath || relatedFolders.length > 0`。
		assert.ok(
			body.includes('ws.codeWorkspacePath ||'),
			'必须跳过**已有身份**的记录（有信息就不是损坏态）',
		);
		assert.ok(
			body.includes('(ws.relatedFolders ?? []).length > 0'),
			'必须跳过还有 relatedFolders 的记录（有信息就不是损坏态）',
		);
		assert.ok(body.includes('hasWorkspaceFileExtension(ws.path)'), '文件态记录由另一条修复通道负责');
		// ② 与目录同名的 `.code-workspace`。
		assert.ok(body.includes('${dirName}.code-workspace'), '必须要求「与目录同名」的 .code-workspace');
		// ③ 自证：文件声明的首个 root 就是这个目录。
		assert.ok(
			body.includes('norm(result.primaryPath) !== norm(ws.path)'),
			'必须校验文件自证（folders[0] == 本目录）—— 这是「它是本目录的声明」的唯一证据',
		);
		// 修复必须持久化身份 + 其余 root。
		assert.ok(body.includes('codeWorkspacePath: candidate.fsPath'), '必须写入文件身份');
		assert.ok(body.includes('addRelatedFolder('), '必须补齐其余 root 为 relatedFolders');
	});

	test('★★★ 修复通道必须**回写内存副本**（只写盘 ⇒ 本次启动补不出多根，慢一拍）', () => {
		// `this._workspaces` 是 `getWorkspaces()` 的**快照**，与 service 内部不是同一对象。
		// 不回写内存 ⇒ 紧接着的 `_applyActiveWorkspaceRootsOnStartup()` 读到的 relatedFolders 仍是旧值
		// ⇒ 算出的 roots 只有 1 个 ⇒ 在 `roots.length < 2` 处 return ⇒ 本次启动不补根（要等下次重启）。
		const src = stripAllComments(fs.readFileSync(SIDEBAR, 'utf8'));

		const recover = bodyOf(src, 'private async _recoverWorkspaceFileIdentity(): Promise<void>');
		assert.ok(
			recover.includes('ws.relatedFolders = current.relatedFolders'),
			'自愈通道必须把 addRelatedFolder 的结果回写到内存副本',
		);
		// 且必须接住返回值（不能 fire-and-forget，否则拿不到最新列表）。
		assert.ok(
			recover.includes('current = await this._wsAgentStudioService.addRelatedFolder('),
			'必须接住 addRelatedFolder 的返回值',
		);

		const fix = bodyOf(src, 'private async _fixWorkspaceFilePaths(): Promise<void>');
		assert.ok(
			fix.includes('ws.relatedFolders = (await this._wsAgentStudioService.addRelatedFolder('),
			'既有的 _fixWorkspaceFilePaths 也必须回写内存（同类缺陷，2026-09-15 一并修）',
		);
	});

	test('★★★ root 解析必须**以 codeWorkspacePath 为准**（不能只看 path 的形态）', () => {
		// 原先只在 `path` **本身**是 `.code-workspace` 时才解析文件，而记录里 `path` 存的是
		// **目录**（`.sarosworkspace` 要落在真实目录里）⇒ 文件被完全忽略 ⇒
		// `relatedFolders` 一旦被写少一个，root 集合**再也回不来**
		// （用户报「应该是 3 个目录，为什么只显示 2 个」正是此因）。
		const src = stripAllComments(fs.readFileSync(SIDEBAR, 'utf8'));
		const body = bodyOf(src, 'private async _resolveWorkspaceRoots(ws: Workspace): Promise<URI[] | undefined>');

		assert.ok(
			body.includes('ws.codeWorkspacePath && hasWorkspaceFileExtension(ws.codeWorkspacePath)'),
			'必须优先用显式身份字段 codeWorkspacePath 去解析文件',
		);
		assert.ok(
			body.indexOf('ws.codeWorkspacePath &&') < body.indexOf('hasWorkspaceFileExtension(primary)'),
			'显式字段必须排在「path 是文件」这条回落**之前**',
		);

		// 文件缺失/不可读时必须**继续兜底**，不能直接 return undefined ——
		// 否则一个被删掉的工作区文件会让整个工作区彻底没有 root。
		const catchAt = body.indexOf('falling back to path+relatedFolders');
		assert.ok(catchAt > 0, '文件解析失败必须记日志并兜底');
		const afterCatch = body.slice(catchAt);
		assert.ok(
			!afterCatch.includes('return undefined'),
			'解析失败后必须继续走 path+relatedFolders 兜底，不得直接返回 undefined',
		);
		assert.ok(body.includes('for (const related of ws.relatedFolders ?? [])'), '兜底路径必须仍在');
	});

	test('★★★ `_loadWorkspaces()` 必须并发去重（否则自愈的内存回写会被"中途快照"覆盖）', () => {
		// `updateWorkspace()` / `addRelatedFolder()` 都会 fire `onDidChangeWorkspace`
		// ⇒ 监听器在**写入过程中**再次触发加载 ⇒ `this._workspaces = await getWorkspaces()`
		// 用中途快照替换数组 ⇒ 正在被改的对象"脱钩" ⇒ 启动补根读到少一个的快照
		// （实测 `startup roots: expanding ... to=2`，而文件声明 3 个）。
		const src = stripAllComments(fs.readFileSync(SIDEBAR, 'utf8'));

		assert.ok(src.includes('private _loadingWorkspaces: Promise<void> | undefined'), '必须有进行中 promise 字段');
		const wrapper = bodyOf(src, 'private _loadWorkspaces(): Promise<void>');
		assert.ok(wrapper.includes('if (this._loadingWorkspaces)'), '并发调用必须复用进行中的 promise');
		assert.ok(wrapper.includes('_doLoadWorkspaces()'), '实际逻辑必须拆到 _doLoadWorkspaces');
		// ★ 只去重不补会**吞掉变更**（加载期间数据又变了 ⇒ 合并进旧快照 ⇒ 列表停在旧数据）
		// ⇒ 必须记 dirty 并在本次结束后补一次。
		assert.ok(wrapper.includes('this._loadingWorkspacesDirty = true'), '去重时必须记 dirty');
		assert.ok(
			wrapper.includes('this._loadingWorkspacesDirty = false'),
			'结束后必须消费 dirty 并补一次加载',
		);

		// ★ 数组替换只能有**一处**（在 `_doLoadWorkspaces` 内）—— 多一处就是多一个竞态入口。
		const assignments = src.match(/this\._workspaces = /g) ?? [];
		assert.strictEqual(assignments.length, 1, 'this._workspaces 的赋值必须只有一处');
		assert.ok(
			bodyOf(src, 'private async _doLoadWorkspaces(): Promise<void>').includes('this._workspaces = '),
			'唯一那处赋值必须在 _doLoadWorkspaces 内',
		);
	});

	test('★★ 自愈通道必须在**启动补根之前**执行（否则修了也不生效）', () => {
		const src = stripAllComments(fs.readFileSync(SIDEBAR, 'utf8'));
		// ⚠ 实际加载逻辑在 `_doLoadWorkspaces()`（`_loadWorkspaces()` 只是去重外壳，2026-09-15 拆出）。
		const loadBody = bodyOf(src, 'private async _doLoadWorkspaces(): Promise<void>');
		assert.ok(
			loadBody.includes('_recoverWorkspaceFileIdentity()'),
			'必须在加载流程里调用自愈通道',
		);
		assert.ok(
			loadBody.indexOf('_fixWorkspaceFilePaths()') < loadBody.indexOf('_recoverWorkspaceFileIdentity()'),
			'顺序：先修文件态记录，再修丢失身份的记录',
		);
		// `_loadWorkspaces().then(_applyActiveWorkspaceRootsOnStartup)` —— 补根在加载之后。
		const src2 = stripAllComments(fs.readFileSync(SIDEBAR, 'utf8'));
		assert.ok(
			src2.includes('_loadWorkspaces().then(() => this._applyActiveWorkspaceRootsOnStartup())'),
			'启动补根必须链在 _loadWorkspaces() 之后 —— 自愈的结果才能立刻应用到窗口',
		);
	});
});
