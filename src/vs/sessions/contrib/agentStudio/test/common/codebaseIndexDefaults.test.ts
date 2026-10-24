/*---------------------------------------------------------------------------------------------
 *  Codebase 索引排除目录默认表 — 单测
 *
 *  覆盖：
 *  - mergeExcludeDirs 去重（大小写不敏感）与顺序稳定
 *  - extractExcludeDirNames 从 code-workspace 的 search.exclude/files.exclude 提取目录名
 *  - parseCbmIgnore 与 writeCbmIgnore 写入格式（"dir/" 每行）的往返兼容
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	mergeExcludeDirs,
	extractExcludeDirNames,
	parseCbmIgnore,
	planForeignProjectPrune,
	decideExternalArtifactReload,
	isDshProducedManifest,
	artifactProducerOf,
	DSH_ARTIFACT_PRODUCER,
	EXTERNAL_ARTIFACT_RELOAD_MIN_INTERVAL_MS,
	COMMON_EXCLUDE_DIRS,
	excludeDirsForProfile,
	matchesExcludeDir,
} from '../../common/codebaseIndexDefaults.js';

suite('Codebase — IndexDefaults', () => {

	suite('mergeExcludeDirs', () => {

		test('去重 + 保持首次出现顺序', () => {
			assert.deepStrictEqual(
				mergeExcludeDirs(['a', 'b'], ['b', 'c']),
				['a', 'b', 'c'],
			);
		});

		test('大小写不敏感去重（扫描器本身即大小写不敏感）', () => {
			assert.deepStrictEqual(mergeExcludeDirs(['Build'], ['build']), ['Build']);
		});

		test('忽略 undefined / 空串 / 纯空白', () => {
			assert.deepStrictEqual(mergeExcludeDirs(undefined, ['', '  ', 'a']), ['a']);
		});
	});

	suite('extractExcludeDirNames', () => {

		test('从 search.exclude 提取干净的目录段', () => {
			const map = {
				'**/node_modules': true,
				'**/Intermediate': true,
				'**/Binaries/**': true,
				'Saved/': true,
			};
			assert.deepStrictEqual(extractExcludeDirNames(map), ['node_modules', 'Intermediate', 'Binaries', 'Saved']);
		});

		test('跳过含通配符的文件级排除（不污染目录名匹配）', () => {
			const map = {
				'**/*.log': true,
				'*.code-workspace': true,
				'**/Content': true,
			};
			assert.deepStrictEqual(extractExcludeDirNames(map), ['Content']);
		});

		test('显式 false 不启用', () => {
			const map = {
				'**/DerivedDataCache': false,
				'**/Plugins': true,
			};
			assert.deepStrictEqual(extractExcludeDirNames(map), ['Plugins']);
		});

		test('带 when 子句的对象视为启用', () => {
			const map = {
				'**/ThirdParty': { when: 'my.extension' } as { when?: string },
				'**/Config': true,
			};
			assert.deepStrictEqual(extractExcludeDirNames(map), ['ThirdParty', 'Config']);
		});

		test('undefined / 空映射 → 空列表', () => {
			assert.deepStrictEqual(extractExcludeDirNames(undefined), []);
			assert.deepStrictEqual(extractExcludeDirNames({}), []);
		});

		test('与 mergeExcludeDirs 共享去重语义', () => {
			const map = { '**/build': true, '**/Build': true };
			assert.deepStrictEqual(extractExcludeDirNames(map), ['build']);
		});
	});

	suite('parseCbmIgnore', () => {

		test('解析 writeCbmIgnore 写入格式（每行 "dir/"）', () => {
			const written = ['node_modules/', '.git/', 'Intermediate/'].join('\n') + '\n';
			assert.deepStrictEqual(parseCbmIgnore(written), ['node_modules', '.git', 'Intermediate']);
		});

		test('忽略注释与空行', () => {
			assert.deepStrictEqual(parseCbmIgnore('# comment\n\n  \nout/\n'), ['out']);
		});

		test('忽略含通配符的行（扫描器按目录名精确匹配）', () => {
			assert.deepStrictEqual(parseCbmIgnore('*.log\nbuild/\n?tmp/\n'), ['build']);
		});

		test('多级路径取最后一段', () => {
			assert.deepStrictEqual(parseCbmIgnore('a/b/Intermediate/\n'), ['Intermediate']);
		});

		test('反斜杠路径归一化', () => {
			assert.deepStrictEqual(parseCbmIgnore('a\\b\\Saved\\'), ['Saved']);
		});

		test('空内容 → 空列表', () => {
			assert.deepStrictEqual(parseCbmIgnore(''), []);
		});
	});

	suite('planForeignProjectPrune（跨工作区污染，2026-09-15）', () => {

		test('丢弃不属于当前工作区的项目（实测 S1Game/UE5EA 场景）', () => {
			const store = ['S1Game', 'UE5EA', 'sarosis-agents-client'];
			assert.deepStrictEqual(
				planForeignProjectPrune(store, ['sarosis-agents-client']),
				['S1Game', 'UE5EA'],
			);
		});

		test('多 folder 工作区：本工作区的全部项目都保留', () => {
			const store = ['sarosis-agents-client', 'Saros-agents-pocket', 'saros-marketplace', 'S1Game'];
			assert.deepStrictEqual(
				planForeignProjectPrune(store, ['sarosis-agents-client', 'Saros-agents-pocket', 'saros-marketplace']),
				['S1Game'],
			);
		});

		test('★ 无工作区（空窗口/启动早期）⇒ 一个都不删', () => {
			assert.deepStrictEqual(planForeignProjectPrune(['S1Game', 'UE5EA'], []), []);
		});

		test('store 里没有多余项目 ⇒ 空列表（幂等）', () => {
			assert.deepStrictEqual(planForeignProjectPrune(['a'], ['a', 'b']), []);
			assert.deepStrictEqual(planForeignProjectPrune([], ['a']), []);
		});
	});

	suite('decideExternalArtifactReload（所有权交接：别人换了制品 ⇒ 重载，2026-10-13）', () => {

		// 通用上下文：本窗口空闲（不在写盘/索引），没有历史重载
		const idle = (now = 1_000_000) => ({ writeInFlight: false, now });

		test('★ 磁盘上的制品更新（且图不一样）⇒ 重载 —— 这就是"IDE 会注意到 dsh 重写了图"', () => {
			const got = decideExternalArtifactReload(
				{ savedAt: 2000, nodeCount: 250, edgeCount: 400 }, { savedAt: 1000, nodeCount: 100, edgeCount: 120 }, idle(),
			);
			assert.strictEqual(got.reload, true);
			if (got.reload) {
				assert.strictEqual(got.onDiskFreshness, 2000);
				assert.match(got.reason, /别人重写过/);
			}
		});

		test('★★ 自我写识别：盘上比基线新，但**节点/边数逐个一致** ⇒ 不重载，只更新基线', () => {
			// 场景：本窗口索引完 → 延迟落盘（SAVE_DEBOUNCE_MS）⇒ 盘上的 saved_at 比基线新，内容却是内存镜像 ✓
			const got = decideExternalArtifactReload(
				{ savedAt: 9000, nodeCount: 176620, edgeCount: 489145 }, { savedAt: 1000, nodeCount: 176620, edgeCount: 489145 }, idle(),
			);
			assert.strictEqual(got.reload, false);
			if (!got.reload) {
				assert.strictEqual(got.adoptAsBaseline, true);
				assert.match(got.reason, /自己刚落盘/);
			}
			// 反面对照：只有节点数一致、边数不同 ⇒ **仍应重载**（单看节点数会漏判 ✓）
			const notSelf = decideExternalArtifactReload(
				{ savedAt: 9000, nodeCount: 100, edgeCount: 999 }, { savedAt: 1000, nodeCount: 100, edgeCount: 120 }, idle(),
			);
			assert.strictEqual(notSelf.reload, true);
			// 计数拿不到（老制品）⇒ 不启用自我写识别（宁可多解析一次，也不许用落后数据 ✓）
			const noCounts = decideExternalArtifactReload({ savedAt: 9000 }, { savedAt: 1000 }, idle());
			assert.strictEqual(noCounts.reload, true);
		});

		test('★ 磁盘上的不比内存里的新（含**平手**）⇒ 不重载 —— 平手最常见的情形是"我们自己刚写完"', () => {
			const older = decideExternalArtifactReload({ savedAt: 900 }, { savedAt: 1000 }, idle());
			const tie = decideExternalArtifactReload({ savedAt: 1000 }, { savedAt: 1000 }, idle());
			assert.strictEqual(older.reload, false);
			assert.strictEqual(tie.reload, false);
		});

		test('★ 本窗口正在写盘/索引 ⇒ 不重载（重载会丢掉尚未落盘的内存状态 ✗）', () => {
			const got = decideExternalArtifactReload(
				{ savedAt: 9000 }, { savedAt: 1000 }, { writeInFlight: true, now: 1_000_000 },
			);
			assert.strictEqual(got.reload, false);
			if (!got.reload) { assert.match(got.reason, /正在写盘/); }
		});

		test('★ 两侧都读不出"多新" ⇒ 不猜（磁盘侧缺；内存侧还没加载过）', () => {
			const noDisk = decideExternalArtifactReload({}, { savedAt: 1000 }, idle());
			const neverLoaded = decideExternalArtifactReload({ savedAt: 2000 }, undefined, idle());
			assert.strictEqual(noDisk.reload, false);
			assert.strictEqual(neverLoaded.reload, false);
			if (!noDisk.reload) { assert.match(noDisk.reason, /不猜/); }
			if (!neverLoaded.reload) { assert.match(neverLoaded.reason, /还没加载过/); }
		});

		test('缺 `savedAt` 时退回 mtime（老制品/别人手写的）—— 但**两侧必须同一口径**', () => {
			const byMtime = decideExternalArtifactReload(
				{ mtimeMs: 5000 }, { mtimeMs: 4000 }, idle(),
			);
			assert.strictEqual(byMtime.reload, true);
			// 一侧有 savedAt、另一侧只有 mtime ⇒ 仍然可比（都经由 artifactFreshnessOf ✓）
			const mixed = decideExternalArtifactReload({ mtimeMs: 3000 }, { savedAt: 2000 }, idle());
			assert.strictEqual(mixed.reload, true);
		});

		test('★ 空制品守卫：磁盘 0 节点而内存里有节点 ⇒ 不拿空图换好图（99 字节事故的同一条教训）', () => {
			const got = decideExternalArtifactReload(
				{ savedAt: 9000, nodeCount: 0 }, { savedAt: 1000, nodeCount: 176620 }, idle(),
			);
			assert.strictEqual(got.reload, false);
			if (!got.reload) { assert.match(got.reason, /空/); }
		});

		test('★ 节流：距上次外部重载不足下限 ⇒ 不重载（重载是"删项目 + 重新解析"的重活）', () => {
			const now = 1_000_000;
			const throttled = decideExternalArtifactReload(
				{ savedAt: 9000 }, { savedAt: 1000 }, { writeInFlight: false, now, lastReloadAt: now - 1000 },
			);
			const allowed = decideExternalArtifactReload(
				{ savedAt: 9000 }, { savedAt: 1000 }, { writeInFlight: false, now, lastReloadAt: now - EXTERNAL_ARTIFACT_RELOAD_MIN_INTERVAL_MS - 1 },
			);
			assert.strictEqual(throttled.reload, false);
			assert.strictEqual(allowed.reload, true);
		});

		test('优先级：写盘进行中优先于"磁盘更新"报告（拿到的理由必须是真因 ✓）', () => {
			const got = decideExternalArtifactReload(
				{ savedAt: 9000 }, { savedAt: 1000 }, { writeInFlight: true, now: 1_000_000, lastReloadAt: 1_000_000 },
			);
			assert.strictEqual(got.reload, false);
			if (!got.reload) { assert.match(got.reason, /正在写盘/); }
		});
	});

	suite('isDshProducedManifest（权限在 dsh 侧：制品自称生产方，2026-10-13）', () => {

		test('★ dsh 产的清单 ⇒ true（IDE 侧据此不索引、不落盘 ✓）', () => {
			assert.strictEqual(isDshProducedManifest({ producer: DSH_ARTIFACT_PRODUCER }), true);
			assert.strictEqual(isDshProducedManifest({ node_count: 5, producer: ' vssaros-dsh ' }), true, '容忍两侧空白 ✓');
		});

		test('★★ 保守口径：缺 producer / 老制品 / 手写制品 / 非字符串 ⇒ **false**（= 行为与今天完全一致 ✓）', () => {
			assert.strictEqual(isDshProducedManifest({ node_count: 5, saved_at: 1 }), false);
			assert.strictEqual(isDshProducedManifest({ producer: 'vssaros-ide' }), false);
			assert.strictEqual(isDshProducedManifest({ producer: 42 }), false);
			assert.strictEqual(isDshProducedManifest(undefined), false);
			assert.strictEqual(isDshProducedManifest(null), false);
			assert.strictEqual(isDshProducedManifest('vssaros-dsh'), false, '不是对象 ⇒ 不算');
			assert.strictEqual(isDshProducedManifest({ producer: 'vssaros-dsh-extra' }), false, '不做前缀匹配 ✗');
		});

		test('★ 权限判断失败 ⇒ 必须落到"IDE 照旧负责"（否则没装 dsh 的环境会彻底失去索引 ✗✗）', () => {
			assert.strictEqual(artifactProducerOf({}), undefined);
			assert.strictEqual(isDshProducedManifest({}), false);
		});
	});
});

/**
 * ★ 排除 `dsh-runtime`（预装的 dsh 运行时）—— 2026-10-22 用户报"dev 整个 app 卡死"的根因之一。
 *
 * 现场（本机实测）：`dsh-runtime/` 有 **86,782 个文件**（其中 profile-seed 15,052 个），全部被索引
 * ⇒ 本项目图谱涨到 **40 万节点 / 125 万边**；而且它**每次重建**（`build/prepack-dsh-runtime.mjs`）
 * 都会被 watcher 看成"删了几千个文件" ⇒ 增量补丁 169s ⇒ DB 落后 19.4 万节点 ⇒ **强制全量追平**
 * （实测 551,936ms ≈ 9.2 分钟）⇒ 主进程在 1.2GB 的 WAL 上阻塞 ⇒ 整个 app 僵死 ✗✗✗。
 *
 * 不变量：两个档位（balanced / full）都必须排除它 —— 它是**第三方依赖的物化**，不是源码。
 */
suite('codebaseIndexDefaults / 预装的 dsh 运行时必须被排除（否则图谱量级失控 ⇒ app 僵死）', () => {

	test('★ balanced 与 full 两档都排除 dsh-runtime（它是运行时产物，不是源码）', () => {
		for (const profile of ['balanced', 'full'] as const) {
			const dirs = excludeDirsForProfile(profile);
			assert.ok(dirs.includes('dsh-runtime'),
				`${profile} 档必须排除 dsh-runtime（86,782 个文件；被索引 ⇒ 40 万节点 ⇒ 全量追平 9.2 分钟 ⇒ app 僵死 ✗）`);
		}
	});

	test('★ COMMON_EXCLUDE_DIRS 也排除它（手动 MCP 索引那条路同样会爆）', () => {
		assert.ok(COMMON_EXCLUDE_DIRS.includes('dsh-runtime'),
			'手动索引路径用 COMMON_EXCLUDE_DIRS ⇒ 同样必须排除 ✗');
	});

	test('★ 排除判据大小写不敏感（DSH-RUNTIME / Dsh-Runtime 都要命中）', () => {
		const dirs = new Set(excludeDirsForProfile('balanced'));
		assert.ok(matchesExcludeDir('DSH-RUNTIME', dirs), '大写形式也要命中（匹配是大小写不敏感的）✗');
		assert.ok(matchesExcludeDir('dsh-runtime', dirs), '小写形式命中 ✓');
	});
});
