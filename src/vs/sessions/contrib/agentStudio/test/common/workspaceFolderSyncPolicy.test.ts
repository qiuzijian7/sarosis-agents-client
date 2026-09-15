/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `workspaceFolderSyncPolicy` 的单测（方案 B' Step 1）。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/common/workspaceFolderSyncPolicy.test.ts
 */

import assert from 'assert';
import {
	DEFAULT_WORKSPACE_FOLDER_SYNC_DIRECTION,
	findWorkspaceByIdentity,
	isProjectionUnchanged,
	isSameWorkspaceIdentity,
	matchWorkspaceIdentity,
	planWindowOnDeleteWorkspace,
	projectFoldersToRegistry,
	resolveSyncDirection,
	workspaceIdentityFromWindow,
} from '../../common/workspaceFolderSyncPolicy.js';

suite('workspaceFolderSyncPolicy — 工作区身份守卫（防跨工作区污染）', () => {

	test('主 root 与 registry.path 相同 → 匹配', () => {
		assert.ok(isSameWorkspaceIdentity('g:\\ws\\main', 'g:\\ws\\main'));
	});

	test('★ 大小写/分隔符/尾斜杠不敏感', () => {
		assert.ok(isSameWorkspaceIdentity('G:/WS/Main/', 'g:\\ws\\main'));
	});

	test('★★ 主 root 与 registry.path 不同 → 不匹配（这是 2026-09-14 污染的拦截点）', () => {
		// 实测事故：窗口打开 sarosis-agents-client，但 activeWorkspaceId 指向另一条记录，
		// 无守卫时把 S1Game / UE5EA 写进了本工作区的 relatedFolders。
		assert.ok(!isSameWorkspaceIdentity('g:\\SarosWorkspace\\sarosis-agents-client', 'f:\\GR_qiuzijian_main\\S1Game'));
	});

	test('两边都空 → 匹配（EMPTY 态 + 未绑定路径的新记录）', () => {
		assert.ok(isSameWorkspaceIdentity(undefined, undefined));
	});

	test('★ 一边有一边没有 → 不匹配（宁可不写，也不要写错）', () => {
		assert.ok(!isSameWorkspaceIdentity('g:\\ws\\main', undefined));
		assert.ok(!isSameWorkspaceIdentity(undefined, 'g:\\ws\\main'));
	});
});

suite('planWindowOnDeleteWorkspace — 删当前工作区则窗口一并关闭（用户 2026-09-15 裁决）', () => {

	const ACTIVE = 'ws-active';
	const OTHER = 'ws-other';

	/** 目录态记录 + 目录态窗口（最常见形态）。 */
	const dirRecord = { path: 'g:\\ws\\main' };
	const dirWindow = () => workspaceIdentityFromWindow(undefined, ['g:\\ws\\main']);

	test('删的是当前记录 + 就是本窗口打开的东西 → 关工作区', () => {
		const plan = planWindowOnDeleteWorkspace(ACTIVE, ACTIVE, dirRecord, dirWindow());
		assert.strictEqual(plan.closeWindowWorkspace, true);
	});

	test('关工作区时必须同时清 remembered（否则重启会把已删工作区复活）', () => {
		const plan = planWindowOnDeleteWorkspace(ACTIVE, ACTIVE, dirRecord, dirWindow());
		assert.strictEqual(plan.clearRememberedWorkspace, true);
	});

	test('★★★ 文件态记录 + 文件态窗口 → 必须关（旧实现恒不匹配 ⇒ 用户认为「删除没生效」）', () => {
		// 旧签名收的是「窗口主 root + 记录 path」两个字符串；记录 path 是 .code-workspace
		// 文件时二者永不相等 ⇒ 删掉当前工作区却不关窗口。
		const plan = planWindowOnDeleteWorkspace(
			ACTIVE, ACTIVE,
			{ path: 'g:\\ws\\main', codeWorkspacePath: 'g:\\ws\\main.code-workspace' },
			workspaceIdentityFromWindow('g:\\ws\\main.code-workspace', ['g:\\ws\\main']),
		);
		assert.strictEqual(plan.closeWindowWorkspace, true);
	});

	test('★★ 删的不是当前记录 → 绝不动窗口', () => {
		const plan = planWindowOnDeleteWorkspace(OTHER, ACTIVE, { path: 'f:\\other' }, dirWindow());
		assert.strictEqual(plan.closeWindowWorkspace, false);
		assert.strictEqual(plan.clearRememberedWorkspace, false);
	});

	test('★★ 是当前记录但与本窗口无关 → 不关窗口（防误伤正在编辑的工作区）', () => {
		// activeWorkspaceId 只是 registry 游标，resolveDefaultActiveWorkspaceId() 会兜底选第一条，
		// 完全可能与当前窗口无关。少了这条判定就会「删一条无关记录却关掉用户的工作区」。
		const plan = planWindowOnDeleteWorkspace(
			ACTIVE, ACTIVE,
			{ path: 'f:\\GR_qiuzijian_main\\S1Game' },
			dirWindow(),
		);
		assert.strictEqual(plan.closeWindowWorkspace, false);
	});

	test('★ 窗口本来就是空的（无文件、无 root）→ 没有可关的工作区', () => {
		const plan = planWindowOnDeleteWorkspace(
			ACTIVE, ACTIVE,
			{ path: 'g:\\ws\\main' },
			workspaceIdentityFromWindow(undefined, []),
		);
		assert.strictEqual(plan.closeWindowWorkspace, false);
	});

	test('没有活动工作区 → 不关窗口', () => {
		const plan = planWindowOnDeleteWorkspace(ACTIVE, undefined, dirRecord, dirWindow());
		assert.strictEqual(plan.closeWindowWorkspace, false);
	});

	test('路径大小写/分隔符不同但同一目录 → 仍判定为本窗口', () => {
		const plan = planWindowOnDeleteWorkspace(
			ACTIVE, ACTIVE,
			{ path: 'G:/WS/Main' },
			workspaceIdentityFromWindow(undefined, ['g:\\ws\\main']),
		);
		assert.strictEqual(plan.closeWindowWorkspace, true);
	});
});

suite('工作区身份匹配（P0：把「记录」与「窗口」统一到同一概念）', () => {

	const MAIN = 'g:\\SarosWorkspace\\sarosis-agents-client';
	const POCKET = 'g:\\SarosWorkspace\\Saros-agents-pocket';
	const MARKET = 'g:\\SarosWorkspace\\saros-marketplace';

	test('★★★ 记录 path 是目录 + 窗口是 .code-workspace 文件 → 必须匹配（本次真实故障形态）', () => {
		// 这正是用户报「多项目工作区只显示一个目录 / 重启丢多根」时的一半根因：
		// 旧实现只比 `w.path === folders[0]`，记录 path 是文件时永不匹配 ⇒ 兜底选到无关记录。
		const identity = workspaceIdentityFromWindow('g:\\ws\\main.code-workspace', [MAIN, POCKET, MARKET]);
		assert.strictEqual(
			matchWorkspaceIdentity({ path: MAIN, relatedFolders: [{ path: POCKET }, { path: MARKET }] }, identity),
			'primary-root',
		);
	});

	test('★ 两边都有工作区文件且相同 → 最强判据 code-workspace-file', () => {
		const identity = workspaceIdentityFromWindow('g:\\ws\\main.code-workspace', [MAIN, POCKET, MARKET]);
		assert.strictEqual(
			matchWorkspaceIdentity({ path: MAIN, codeWorkspacePath: 'g:\\ws\\main.code-workspace' }, identity),
			'code-workspace-file',
		);
	});

	test('★★ legacy 记录（path 就是工作区文件、无新字段）→ 无需迁移即可匹配', () => {
		// 历史记录把文件路径存在 `path` 里；`recordCodeWorkspacePath()` 负责回落。
		// 有这条回落，`workspaces.json` **不需要**任何数据迁移就能被正确识别。
		const identity = workspaceIdentityFromWindow('g:\\ws\\main.code-workspace', [MAIN]);
		assert.strictEqual(
			matchWorkspaceIdentity({ path: 'g:\\ws\\main.code-workspace' }, identity),
			'code-workspace-file',
		);
	});

	test('★★ 两边文件标识不同 → 直接 none（不得因 root 恰好相同而误判）', () => {
		// 「两个不同工作区恰好共享同一个 root」是真实存在的（例如都以某个父目录为根）。
		// 文件是更强的身份，文件不同就是不同工作区。
		const identity = workspaceIdentityFromWindow('g:\\ws\\a.code-workspace', [MAIN]);
		assert.strictEqual(
			matchWorkspaceIdentity({ path: MAIN, codeWorkspacePath: 'g:\\ws\\b.code-workspace' }, identity),
			'none',
		);
	});

	test('★ 同一组 root 但顺序不同 → same-root-set（兜底判据）', () => {
		// 用户在 .code-workspace 里调换 folders 顺序后，主 root 会与记录 path 不同。
		const identity = workspaceIdentityFromWindow(undefined, [POCKET, MAIN]);
		assert.strictEqual(
			matchWorkspaceIdentity({ path: MAIN, relatedFolders: [{ path: POCKET }] }, identity),
			'same-root-set',
		);
	});

	test('★★★ 无关记录 → none（跨工作区污染的拦截点）', () => {
		const identity = workspaceIdentityFromWindow('g:\\ws\\main.code-workspace', [MAIN, POCKET, MARKET]);
		assert.strictEqual(
			matchWorkspaceIdentity({ path: 'f:\\GR_qiuzijian_main\\S1Game', relatedFolders: [{ path: 'f:\\GR_qiuzijian_main\\UE5EA' }] }, identity),
			'none',
		);
	});

	test('★ 空窗口（无文件、无 root）→ none', () => {
		assert.strictEqual(matchWorkspaceIdentity({ path: MAIN }, workspaceIdentityFromWindow(undefined, [])), 'none');
	});

	test('★ findWorkspaceByIdentity：多命中取最强（文件 > 主 root）', () => {
		const identity = workspaceIdentityFromWindow('g:\\ws\\main.code-workspace', [MAIN]);
		const found = findWorkspaceByIdentity([
			{ id: 'roots-only', path: MAIN },
			{ id: 'file-match', path: MAIN, codeWorkspacePath: 'g:\\ws\\main.code-workspace' },
		], identity);
		assert.strictEqual(found?.record.id, 'file-match');
		assert.strictEqual(found?.match, 'code-workspace-file');
	});

	test('★ findWorkspaceByIdentity：都不命中返回 undefined（调用方据此走兜底，而不是随便挑一条）', () => {
		const identity = workspaceIdentityFromWindow(undefined, ['g:\\ws\\other']);
		assert.strictEqual(
			findWorkspaceByIdentity([{ id: 'a', path: MAIN }, { id: 'b', path: POCKET }], identity),
			undefined,
		);
	});

	test('★ 大小写 / 分隔符 / 尾斜杠不敏感', () => {
		const identity = workspaceIdentityFromWindow('G:/WS/Main.code-workspace', ['G:/WS/Main/']);
		assert.strictEqual(
			matchWorkspaceIdentity({ path: 'g:\\ws\\main', codeWorkspacePath: 'g:\\ws\\main.code-workspace' }, identity),
			'code-workspace-file',
		);
	});

	test('★ workspaceIdentityFromWindow：主 root 取 folders[0]，并保留全部 root', () => {
		const identity = workspaceIdentityFromWindow(undefined, [MAIN, POCKET]);
		assert.strictEqual(identity.primaryFolderPath, MAIN);
		assert.deepStrictEqual([...identity.folderPaths], [MAIN, POCKET]);
		assert.strictEqual(identity.codeWorkspacePath, undefined);
	});
});

suite('workspaceFolderSyncPolicy — 方向解析', () => {

	test('默认方向 = window-drives-registry（方案 B\' 的反转后行为）', () => {
		assert.strictEqual(DEFAULT_WORKSPACE_FOLDER_SYNC_DIRECTION, 'window-drives-registry');
	});

	test('三个合法值原样返回', () => {
		assert.strictEqual(resolveSyncDirection('window-drives-registry'), 'window-drives-registry');
		assert.strictEqual(resolveSyncDirection('registry-drives-window'), 'registry-drives-window');
		assert.strictEqual(resolveSyncDirection('off'), 'off');
	});

	test('★ 未知/缺失值一律回落默认，不抛错（同步器在窗口启动路径上）', () => {
		for (const bad of [undefined, null, '', 'nope', 42, {}, []]) {
			assert.strictEqual(
				resolveSyncDirection(bad),
				DEFAULT_WORKSPACE_FOLDER_SYNC_DIRECTION,
				`非法值 ${JSON.stringify(bad)} 应回落默认`,
			);
		}
	});
});

suite('workspaceFolderSyncPolicy — 反向投影', () => {

	test('folders[0] → path，folders[1..] → relatedFolders（保持用户声明顺序）', () => {
		const p = projectFoldersToRegistry([
			{ fsPath: 'g:\\ws\\main', name: 'main' },
			{ fsPath: 'g:\\ws\\pocket', name: 'pocket' },
			{ fsPath: 'g:\\ws\\market', name: 'market' },
		]);
		assert.strictEqual(p.path, 'g:\\ws\\main');
		assert.deepStrictEqual(p.relatedFolders, [
			{ path: 'g:\\ws\\pocket', name: 'pocket' },
			{ path: 'g:\\ws\\market', name: 'market' },
		]);
	});

	test('单根 → path 有值、relatedFolders 为空', () => {
		const p = projectFoldersToRegistry([{ fsPath: '/repo', name: 'repo' }]);
		assert.strictEqual(p.path, '/repo');
		assert.deepStrictEqual(p.relatedFolders, []);
	});

	test('★★ 空列表（EMPTY 态）→ path=undefined，不得"保持原值"', () => {
		// 旧方向的病根：关闭工作区后 registry 仍指着旧 root，下次启动又把它带回来。
		const p = projectFoldersToRegistry([]);
		assert.strictEqual(p.path, undefined);
		assert.deepStrictEqual(p.relatedFolders, []);
	});
});

suite('workspaceFolderSyncPolicy — 幂等闸门（防写盘风暴 / 自激循环）', () => {

	const projection = projectFoldersToRegistry([
		{ fsPath: 'g:\\ws\\main', name: 'main' },
		{ fsPath: 'g:\\ws\\pocket', name: 'pocket' },
	]);

	test('完全一致 → unchanged', () => {
		assert.ok(isProjectionUnchanged(projection, {
			path: 'g:\\ws\\main',
			relatedFolders: [{ path: 'g:\\ws\\pocket' }],
		}));
	});

	test('★ 大小写与尾斜杠不敏感（Windows 必需）', () => {
		assert.ok(isProjectionUnchanged(projection, {
			path: 'G:\\WS\\MAIN\\',
			relatedFolders: [{ path: 'G:/ws/Pocket/' }],
		}));
	});

	test('★ name 变化不算变化（改显示名不值得写盘）', () => {
		const renamed = projectFoldersToRegistry([
			{ fsPath: 'g:\\ws\\main', name: '主仓' },
			{ fsPath: 'g:\\ws\\pocket', name: '口袋' },
		]);
		assert.ok(isProjectionUnchanged(renamed, {
			path: 'g:\\ws\\main',
			relatedFolders: [{ path: 'g:\\ws\\pocket' }],
		}));
	});

	test('路径不同 / 数量不同 / 顺序不同 → changed', () => {
		assert.ok(!isProjectionUnchanged(projection, { path: 'g:\\other', relatedFolders: [{ path: 'g:\\ws\\pocket' }] }));
		assert.ok(!isProjectionUnchanged(projection, { path: 'g:\\ws\\main', relatedFolders: [] }));
		assert.ok(!isProjectionUnchanged(projection, {
			path: 'g:\\ws\\pocket',
			relatedFolders: [{ path: 'g:\\ws\\main' }],
		}));
	});

	test('registry 为空 vs 投影为空', () => {
		const empty = projectFoldersToRegistry([]);
		assert.ok(isProjectionUnchanged(empty, {}));
		assert.ok(isProjectionUnchanged(empty, { relatedFolders: [] }));
		assert.ok(!isProjectionUnchanged(empty, { path: 'g:\\ws\\main' }));
		assert.ok(!isProjectionUnchanged(projection, {}));
	});
});
