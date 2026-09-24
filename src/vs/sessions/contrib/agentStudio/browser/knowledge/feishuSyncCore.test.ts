/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * feishuSyncCore 纯函数单测（不依赖 VS Code 运行时）。
 *
 * 覆盖：
 *   1. buildSyncArgs — CLI 参数拼装（与 kb-feishu-sync.mjs 契约一致）
 *   2. parseSrcDirs — 面板输入 → 参数列表
 *   3. parseCliVersion / parseLoggedIn — lark-cli 检测输出解析
 *   4. syncScriptCandidates — 内置脚本候选路径（含 appRoot 候选与去重）
 */

import * as assert from 'assert';
import {
	buildSyncArgs,
	buildUpgradeArgs,
	electronNodeLaunch,
	hasUpdate,
	parseCliVersion,
	parseLoggedIn,
	parseSrcDirs,
	parseUpdateCheck,
	syncScriptCandidates,
	deriveMappedSrcDirs,
	FEISHU_SYNC_SECTION,
	KB_FEISHU_SYNC_SCRIPT_REL,
	DEFAULT_LARK_CLI,
} from './feishuSyncCore.js';

suite('feishuSyncCore', () => {

	suite('buildSyncArgs', () => {
		const base = {
			vaultPath: 'C:\\vault',
			srcDirs: [] as string[],
			parent: 'my_library',
			onConflict: 'overwrite' as const,
			intervalMs: 800,
			mode: 'dry-run' as const,
		};

		test('基础参数顺序与 dry-run 默认（含类别/自动建库默认）', () => {
			const args = buildSyncArgs('/p/feishu-sync.mjs', base);
			assert.deepStrictEqual(args, [
				'/p/feishu-sync.mjs',
				'--vault', 'C:\\vault',
				'--parent', 'my_library',
				'--on-conflict', 'overwrite',
				'--interval', '800',
				'--category-depth', '1',
				'--auto-create-spaces',
				'--dry-run',
			]);
		});

		test('★ plan-file：本次报告文件（dry-run/apply 都写；位置在 mode 之前）', () => {
			const args = buildSyncArgs('s.mjs', { ...base, planFile: 'C:/vault/.feishu-sync-plan.txt' });
			assert.strictEqual(args[args.indexOf('--plan-file') + 1], 'C:/vault/.feishu-sync-plan.txt');
			assert.deepStrictEqual(args.slice(-3), ['--plan-file', 'C:/vault/.feishu-sync-plan.txt', '--dry-run'],
				'报告参数必须紧邻 mode（契约：# 参数顺序）');
		});

		test('未传 planFile ⇒ 不产生 --plan-file（向后兼容脚本老版本）', () => {
			assert.ok(!buildSyncArgs('s.mjs', base).includes('--plan-file'));
		});

		test('多类别参数：类别层级 / 关闭自动建库 / 删除清理', () => {
			const args = buildSyncArgs('s.mjs', { ...base, categoryDepth: 2, autoCreateSpaces: false, prune: true, mode: 'apply' });
			assert.strictEqual(args[args.indexOf('--category-depth') + 1], '2');
			assert.ok(args.includes('--no-auto-create-spaces'), '关闭时应传 --no-auto-create-spaces');
			assert.ok(!args.includes('--auto-create-spaces'));
			assert.ok(args.includes('--prune'));
			assert.ok(args.includes('--apply'));
		});

		test('类别层级 0（不分类别）与非法值回落', () => {
			assert.strictEqual(buildSyncArgs('s.mjs', { ...base, categoryDepth: 0 })[
				buildSyncArgs('s.mjs', { ...base, categoryDepth: 0 }).indexOf('--category-depth') + 1
			], '0');
			const bad = buildSyncArgs('s.mjs', { ...base, categoryDepth: Number.NaN });
			assert.strictEqual(bad[bad.indexOf('--category-depth') + 1], '1', '非法值应回落到 1');
		});

		test('多 src 目录按顺序展开；空项被跳过', () => {
			const args = buildSyncArgs('s.mjs', { ...base, srcDirs: ['库/A', '', '库/B'] });
			const srcIndexes = args.map((a, i) => (a === '--src' ? i : -1)).filter(i => i >= 0);
			assert.strictEqual(srcIndexes.length, 2, '空字符串不应产生 --src');
			assert.strictEqual(args[srcIndexes[0] + 1], '库/A');
			assert.strictEqual(args[srcIndexes[1] + 1], '库/B');
		});

		test('apply 模式与冲突策略透传', () => {
			const args = buildSyncArgs('s.mjs', { ...base, mode: 'apply', onConflict: 'skip' });
			assert.ok(args.includes('--apply'));
			assert.ok(!args.includes('--dry-run'));
			assert.strictEqual(args[args.indexOf('--on-conflict') + 1], 'skip');
		});

		test('interval 非法值回落到 800；parent 为空回落到 my_library', () => {
			const args = buildSyncArgs('s.mjs', { ...base, intervalMs: Number.NaN, parent: '' });
			assert.strictEqual(args[args.indexOf('--interval') + 1], '800');
			assert.strictEqual(args[args.indexOf('--parent') + 1], 'my_library');
		});
	});

	suite('parseSrcDirs', () => {
		test('逗号分隔 + 去空白 + 去空项', () => {
			assert.deepStrictEqual(parseSrcDirs(' 库/A , 库/B ,, '), ['库/A', '库/B']);
		});
		test('空值返回空数组', () => {
			assert.deepStrictEqual(parseSrcDirs(undefined), []);
			assert.deepStrictEqual(parseSrcDirs(null), []);
			assert.deepStrictEqual(parseSrcDirs('   '), []);
		});
	});

	suite('parseCliVersion', () => {
		test('从常见输出中取版本号', () => {
			assert.strictEqual(parseCliVersion('lark-cli 1.0.27'), '1.0.27');
			assert.strictEqual(parseCliVersion('\u001b[32mlark-cli\u001b[0m v2.3.4-beta.1\n'), '2.3.4-beta.1');
		});
		test('无版本号返回 undefined', () => {
			assert.strictEqual(parseCliVersion('command not found'), undefined);
			assert.strictEqual(parseCliVersion(''), undefined);
		});
	});

	suite('parseLoggedIn', () => {
		test('JSON 形态 tokenStatus 判定', () => {
			assert.strictEqual(parseLoggedIn('{"tokenStatus":"valid"}'), true);
			assert.strictEqual(parseLoggedIn('{"tokenStatus":"expired"}'), false);
		});
		test('文本形态判定', () => {
			assert.strictEqual(parseLoggedIn('You are logged in as user'), true);
			assert.strictEqual(parseLoggedIn('not logged in, please run auth login'), false);
		});
		test('无法判定时返回 undefined（不误判）', () => {
			assert.strictEqual(parseLoggedIn('lark-cli help output'), undefined);
			assert.strictEqual(parseLoggedIn(''), undefined);
		});
	});

	suite('syncScriptCandidates', () => {
		test('含 appRoot 与 dirname(appRoot) 候选，且全部指向内置脚本', () => {
			const candidates = syncScriptCandidates({ appRoot: '/app' } as never);
			assert.ok(candidates.length >= 2, '应给出多个候选（dev / 打包布局）');
			for (const c of candidates) {
				assert.ok(c.path.endsWith(KB_FEISHU_SYNC_SCRIPT_REL.replace('resources/', 'resources/')),
					`候选应指向内置脚本：${c.toString()}`);
			}
			const appRootHit = candidates.find(c => c.path.includes('/app/resources/.agents/kb/feishu-sync.mjs'));
			assert.ok(appRootHit, '应包含 appRoot 候选');
		});

		test('无 appRoot 时不抛错（仍可给出 FileAccess 候选或空数组）', () => {
			assert.doesNotThrow(() => syncScriptCandidates(undefined));
		});

		test('候选去重（同一 URI 不重复）', () => {
			const candidates = syncScriptCandidates({ appRoot: '/app' } as never);
			const keys = candidates.map(c => c.toString());
			assert.strictEqual(new Set(keys).size, keys.length);
		});
	});

	test('默认 CLI 名与脚本相对路径为对外契约', () => {
		assert.strictEqual(DEFAULT_LARK_CLI, 'lark-cli');
		assert.strictEqual(KB_FEISHU_SYNC_SCRIPT_REL, 'resources/.agents/kb/feishu-sync.mjs');
	});

	suite('parseUpdateCheck / hasUpdate（CLI 升级）', () => {
		test('JSON 形态：可升级（实测结构字段）', () => {
			const raw = '{\n  "action": "update_available",\n  "current_version": "1.0.27",\n'
				+ '  "latest_version": "1.0.96",\n  "message": "lark-cli 1.0.27 -> 1.0.96 available",\n'
				+ '  "url": "https://github.com/larksuite/cli/releases/tag/v1.0.96"\n}';
			const info = parseUpdateCheck(raw);
			assert.strictEqual(info?.action, 'update_available');
			assert.strictEqual(info?.currentVersion, '1.0.27');
			assert.strictEqual(info?.latestVersion, '1.0.96');
			assert.ok(info?.releaseUrl?.includes('v1.0.96'), '应解析出 Release 链接');
			assert.strictEqual(hasUpdate(info), true);
		});

		test('JSON 前置彩色码/日志行仍可提取', () => {
			const raw = '\u001b[31mchecking…\u001b[0m\n{"action":"up_to_date","current_version":"1.0.96","latest_version":"1.0.96"}';
			const info = parseUpdateCheck(raw);
			assert.strictEqual(info?.action, 'up_to_date');
			assert.strictEqual(hasUpdate(info), false, '已是最新不应判定为可升级');
		});

		test('文本回退形态可解析', () => {
			const info = parseUpdateCheck('Update available: 1.0.27 -> 1.0.96\n  Release: https://x');
			assert.strictEqual(info?.currentVersion, '1.0.27');
			assert.strictEqual(info?.latestVersion, '1.0.96');
			assert.strictEqual(hasUpdate(info), true);
			assert.strictEqual(hasUpdate(parseUpdateCheck('lark-cli is already up to date')), false);
		});

		test('无法解析 / 空输入返回 undefined（不误报可升级）', () => {
			assert.strictEqual(parseUpdateCheck(''), undefined);
			assert.strictEqual(parseUpdateCheck('some unrelated output'), undefined);
			assert.strictEqual(hasUpdate(undefined), false);
		});

		test('action 未知且版本相同 ⇒ 不判定可升级', () => {
			assert.strictEqual(hasUpdate({ action: 'unknown', currentVersion: '1.0.0', latestVersion: '1.0.0' }), false);
		});

		test('升级参数契约（终端执行 lark-cli update）', () => {
			assert.deepStrictEqual(buildUpgradeArgs(), ['update']);
		});
	});

	suite('electronNodeLaunch（Electron 自带 node 执行）', () => {
		test('env 必带 ELECTRON_RUN_AS_NODE=1（否则 .mjs 会被当作 app 入口立即退出）', () => {
			const launch = electronNodeLaunch();
			assert.strictEqual(launch.env['ELECTRON_RUN_AS_NODE'], '1');
		});

		test('保留完整进程环境（脚本内部仍需调用 lark-cli ⇒ PATH 不能丢）', () => {
			const launch = electronNodeLaunch();
			const path = process.env['PATH'] ?? process.env['Path'];
			if (path) {
				const kept = launch.env['PATH'] ?? launch.env['Path'];
				assert.strictEqual(kept, path, 'PATH 必须原样保留');
			}
		});

		test('executable 为可执行文件路径（取不到时由调用方回退系统 node）', () => {
			const launch = electronNodeLaunch();
			assert.ok(typeof launch.executable === 'string' && launch.executable.length > 0,
				'本测试环境应从 process.execPath 取到路径');
		});
	});

	/**
	 * 同步范围推导（★ 2026-09-24 用户定调：只同步「笔记」区里已配置映射的目录）。
	 *
	 * 这组用例锁住「同步范围 = 映射目录 ∩ 笔记区」的口径 —— 它是「同步到飞书」按钮与
	 * `kb_feishu_sync` 工具**共用的唯一真源**（见 deriveMappedSrcDirs 的注释）。
	 */
	suite('deriveMappedSrcDirs', () => {
		const m = (dir: string) => ({ dir, spaceId: 'space-1' });

		test('只保留「笔记」区内的映射目录', () => {
			assert.deepStrictEqual(
				deriveMappedSrcDirs([m('库/AI'), m('笔记/AI'), m('库/raw/素材')]),
				['笔记/AI'],
				'「库」是素材层，永不进入同步范围',
			);
		});

		test('父子归并：子目录被祖先涵盖时不重复作为 --src（否则文件被 plan 两次）', () => {
			assert.deepStrictEqual(
				deriveMappedSrcDirs([m('笔记/AI'), m('笔记/AI/01-基础'), m('笔记/AI/01-基础/deep')]),
				['笔记/AI'],
			);
		});

		test('同级多目录：全部保留且顺序稳定', () => {
			assert.deepStrictEqual(
				deriveMappedSrcDirs([m('笔记/B'), m('笔记/A'), m('笔记/B/sub')]),
				['笔记/A', '笔记/B'],
			);
		});

		test('可以直接映射整个「笔记」区（一个知识库装全部笔记）', () => {
			assert.deepStrictEqual(deriveMappedSrcDirs([m(FEISHU_SYNC_SECTION)]), [FEISHU_SYNC_SECTION]);
		});

		test('反斜杠 / 尾部斜杠归一（面板与手写文件的两种形态都要能识别）', () => {
			assert.deepStrictEqual(deriveMappedSrcDirs([m('笔记\\AI\\'), m('笔记/AI')]), ['笔记/AI']);
		});

		test('空映射 / 只有「库」区 ⇒ 空数组（调用方据此提示「先去配置映射」且不执行同步）', () => {
			assert.deepStrictEqual(deriveMappedSrcDirs([]), []);
			assert.deepStrictEqual(deriveMappedSrcDirs(undefined), []);
			assert.deepStrictEqual(deriveMappedSrcDirs([m('库/raw')]), []);
		});

		test('不把「笔记X」误判为「笔记」区（前缀必须落在分隔符上）', () => {
			assert.deepStrictEqual(deriveMappedSrcDirs([m('笔记归档/A')]), []);
		});
	});
});
