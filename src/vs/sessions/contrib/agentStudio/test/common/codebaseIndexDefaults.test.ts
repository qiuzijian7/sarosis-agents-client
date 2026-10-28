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
	shouldDeferGraphLoad,
	isFileStatChanged,
	FILE_MTIME_TOLERANCE_NS,
	EXTERNAL_RELOAD_MAX_AUTO_NODES,
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

/**
 * 规模闸（2026-10-27，性能止血）：外部重载 = 主线程合并整张图 ⇒ 图太大时**不许自动重载**。
 *
 * 背景（真机）：21.9 万节点 / 130 万边 / 129MB 制品 ⇒ 合并 **16.9s** + BM25 **5.6s**
 * ⇒ 主线程冻结 17s ⇒ ActivityBar 点击与编辑器输入全无响应（用户报「鼠标点击特别卡顿」）。
 * 而触发频率由 dsh 侧 watcher 决定（每写一次盘就改一次 `saved_at`）⇒ 原节流 5s + 轮询 10s
 * ⇒ 最坏情况**每 10 秒冻一次 17 秒** ✗✗。
 */
suite('decideExternalArtifactReload / 规模闸：大图不自动重载（2026-10-27）', () => {

	const idle = (now = 1_000_000) => ({ writeInFlight: false, now });

	test('★ 盘上节点数超上限 ⇒ 不重载，并打上 tooBig 标记（调用方据此提示用户）', () => {
		const got = decideExternalArtifactReload(
			{ savedAt: 9000, nodeCount: 219036, edgeCount: 1304798 }, { savedAt: 1000, nodeCount: 219000, edgeCount: 1300000 }, idle(),
		);
		assert.strictEqual(got.reload, false, '大图不许自动重载（会冻结主线程十几秒）✗');
		if (!got.reload) {
			assert.strictEqual(got.tooBig, true, '必须打上 tooBig 标记 ⇒ 调用方要告诉用户 ✗');
			assert.ok(!got.adoptAsBaseline, '不许把基线跟上去（跟了用户手动刷新后就不会重载了 ✗）');
			assert.match(got.reason, /节点/);
		}
	});

	test('★ 刚好在上限之内 ⇒ 照旧重载（闸不能误伤正常规模）', () => {
		const got = decideExternalArtifactReload(
			{ savedAt: 9000, nodeCount: EXTERNAL_RELOAD_MAX_AUTO_NODES, edgeCount: 999 },
			{ savedAt: 1000, nodeCount: 100, edgeCount: 120 }, idle(),
		);
		assert.strictEqual(got.reload, true, '上限之内必须照旧重载 ✓');
	});

	test('★ 规模闸排在"自我写识别"之后 ⇒ 自己刚落盘的那份仍按基线跟（不误报 tooBig）', () => {
		const got = decideExternalArtifactReload(
			{ savedAt: 9000, nodeCount: 219036, edgeCount: 1304798 },
			{ savedAt: 1000, nodeCount: 219036, edgeCount: 1304798 }, idle(),
		);
		assert.strictEqual(got.reload, false);
		if (!got.reload) {
			assert.strictEqual(got.adoptAsBaseline, true, '节点/边数逐个一致 ⇒ 判为自己刚落盘 ✓');
			assert.ok(!got.tooBig, '自己写的不该被当成"图太大"✗');
		}
	});

	test('★ 读不出节点数（老制品）⇒ 闸不生效（不许凭空拦下重载）', () => {
		const got = decideExternalArtifactReload({ savedAt: 9000 }, { savedAt: 1000 }, idle());
		assert.strictEqual(got.reload, true);
	});
});

/**
 * 内容指纹判据（2026-10-27）：dsh 侧的 watcher 会**周期性重写**制品（时间戳变了、内容没变）
 * ⇒ 时间戳判据每次都说"变了" ⇒ IDE 就去整张重解析+合并（实测 18s 主线程冻结）✗✗。
 * ⇒ 有指纹可比时：**指纹相同 ⇒ 图没变 ⇒ 不重载** ✓。
 */
suite('decideExternalArtifactReload / 内容指纹（2026-10-27）', () => {

	const idle = (now = 1_000_000) => ({ writeInFlight: false, now });

	test('★ 时间戳更新但**指纹一致** ⇒ 不重载（只把基线跟上）', () => {
		const got = decideExternalArtifactReload(
			{ savedAt: 9000, nodeCount: 219036, edgeCount: 1304798, fingerprint: 'abc123#r1' },
			{ savedAt: 1000, nodeCount: 219036, edgeCount: 1304798, fingerprint: 'abc123#r1' },
			idle(),
		);
		assert.strictEqual(got.reload, false, '内容没变就不该重载（18s 的重活）✓');
		if (!got.reload) {
			assert.strictEqual(got.adoptAsBaseline, true, '基线要跟上（否则每轮都重判）✓');
			assert.match(got.reason, /指纹/);
		}
	});

	test('★ 指纹不同 ⇒ 照旧重载（真的变了）', () => {
		// ⚠ 用**小图**样本：规模闸（>3 万节点不自动重载）会先一步拦下大图 ⇒ 这里测的是指纹判据本身
		const got = decideExternalArtifactReload(
			{ savedAt: 9000, nodeCount: 1000, edgeCount: 2000, fingerprint: 'abc123#r1' },
			{ savedAt: 1000, nodeCount: 1000, edgeCount: 2000, fingerprint: 'def456#r1' },
			idle(),
		);
		assert.strictEqual(got.reload, true, '指纹变了 ⇒ 真变了 ⇒ 重载 ✓');
	});

	test('★ 只有一侧有指纹 ⇒ 不可比 ⇒ 按原逻辑（保守）', () => {
		const onlyDisk = decideExternalArtifactReload(
			{ savedAt: 9000, fingerprint: 'abc#r1' }, { savedAt: 1000 }, idle());
		assert.strictEqual(onlyDisk.reload, true, '只有盘上有指纹 ⇒ 不可比 ⇒ 照旧 ✓');
		const onlyLoaded = decideExternalArtifactReload(
			{ savedAt: 9000 }, { savedAt: 1000, fingerprint: 'abc#r1' }, idle());
		assert.strictEqual(onlyLoaded.reload, true, '只有内存里有指纹 ⇒ 不可比 ⇒ 照旧 ✓');
	});

	test('★ 指纹相同 + 节点/边数也相同 ⇒ 仍按"内容没变"处理（指纹优先于计数 ✓）', () => {
		const got = decideExternalArtifactReload(
			{ savedAt: 9000, nodeCount: 10, edgeCount: 20, fingerprint: 'x#r1' },
			{ savedAt: 1000, nodeCount: 10, edgeCount: 20, fingerprint: 'x#r1' },
			idle(),
		);
		assert.strictEqual(got.reload, false);
	});

	test('★★ 数量相同但**指纹不同** ⇒ 不得判成"自己刚写"（数量相同 ≠ 内容相同）⇒ 重载', () => {
		const got = decideExternalArtifactReload(
			{ savedAt: 9000, nodeCount: 1000, edgeCount: 2000, fingerprint: 'new#r1' },
			{ savedAt: 1000, nodeCount: 1000, edgeCount: 2000, fingerprint: 'old#r1' },
			idle(),
		);
		assert.strictEqual(got.reload, true, '指纹不同 ⇒ 真变了 ⇒ 必须重载（否则 IDE 永远停在旧图 ✗）');
	});

	test('★ 规模闸**优先于**指纹（超大图即便指纹变了也不自动重载 —— 避免 18s 冻结）', () => {
		const got = decideExternalArtifactReload(
			{ savedAt: 9000, nodeCount: 219036, edgeCount: 1304798, fingerprint: 'new#r1' },
			{ savedAt: 1000, nodeCount: 219036, edgeCount: 1304798, fingerprint: 'old#r1' },
			idle(),
		);
		assert.strictEqual(got.reload, false, '大图不自动重载（规模闸）✓');
		if (!got.reload) {
			assert.strictEqual(got.tooBig, true, '标记为 tooBig（调用方要提示用户手动刷新）✓');
		}
	});
});

/**
 * 主 root 的按需加载（2026-10-27）：129MB / 42 万节点的图在打开工作区时同步合并要 **18.3s**
 * ⇒ 主线程冻结二十多秒 ⇒ ActivityBar 点击与编辑器输入全无响应。
 * ⇒ 主 root 也纳入延迟（阈值独立，默认 20MB）；真源在 dsh 侧（始终最新）⇒ 延后只影响 IDE 本地检索。
 */
suite('shouldDeferGraphLoad / 主 root 也按需加载（2026-10-27）', () => {

	const MB = 1024 * 1024;

	test('★ 主 root 的图超过阈值 ⇒ 延迟（不再在打开工作区时同步合并）', () => {
		assert.strictEqual(shouldDeferGraphLoad(0, 129 * MB, 5, false, 20), true,
			'129MB 的主根图必须延迟（同步合并 = 冻结界面 18s）✓');
	});

	test('★ 主 root 的图在阈值之内 ⇒ 照旧加载（不能把正常规模也延后）', () => {
		assert.strictEqual(shouldDeferGraphLoad(0, 3 * MB, 5, false, 20), false);
	});

	test('★ 主 root 阈值设为 0 ⇒ 不延迟（保留旧行为的退路）', () => {
		assert.strictEqual(shouldDeferGraphLoad(0, 129 * MB, 5, false, 0), false,
			'0 = 关闭主根延迟 ⇒ 用户可随时恢复旧行为 ✓');
	});

	test('★ 非主 root 的旧语义不变（阈值独立、互不影响）', () => {
		assert.strictEqual(shouldDeferGraphLoad(1, 8 * MB, 5, false, 20), true, '8MB > 5MB ⇒ 延迟 ✓');
		assert.strictEqual(shouldDeferGraphLoad(1, 3 * MB, 5, false, 20), false, '3MB < 5MB ⇒ 不延迟 ✓');
		// 主根阈值开着，也不该影响非主根的判定 ✓
		assert.strictEqual(shouldDeferGraphLoad(1, 3 * MB, 0, false, 20), false, '非主根延迟关了就不延迟 ✓');
	});

	test('★ 幂等：已在延迟集合里 ⇒ 保持延迟（不因这次 stat 结果改判）', () => {
		assert.strictEqual(shouldDeferGraphLoad(0, 1 * MB, 5, true, 20), true);
	});
});

/**
 * mtime 容差（2026-10-27）：watcher 的「改过没有」不能拿**别的生产者**写的 mtime 做逐字节比较。
 *
 * 现场：store 的图谱来自 dsh 制品（甲档交接）⇒ 其 mtime 与本机 stat 差 375µs、size 相同
 * ⇒ 每个文件都被判「改过」⇒ 一轮 6826 个文件被重解析（28s、堆 +304MB）✗。
 */
suite('isFileStatChanged / mtime 容差（2026-10-27）', () => {

	test('★ size 相同、mtime 只差亚毫秒（跨生产者的取整差异）⇒ 不算改过', () => {
		// 真机实测的一对：old(size=6378, mtime=…213625000) vs new(size=6378, mtime=…214000000)
		assert.strictEqual(isFileStatChanged(6378, 1788520092213625000, 6378, 1788520092214000000), false,
			'差 375µs 的取整差异不是改动 ✗（否则每轮全量重解析）');
	});

	test('★ size 变了 ⇒ 一定算改过（哪怕 mtime 没动）', () => {
		assert.strictEqual(isFileStatChanged(6378, 1788520092213625000, 6380, 1788520092213625000), true);
	});

	test('★ mtime 变化超过容差 ⇒ 算改过（真实编辑必须被抓到 ✓）', () => {
		const base = 1788520092213625000;
		assert.strictEqual(isFileStatChanged(6378, base, 6378, base + 50_000_000), true, '50ms ⇒ 改过 ✓');
		assert.strictEqual(isFileStatChanged(6378, base, 6378, base + 2_000_000), true, '2ms ⇒ 改过 ✓');
	});

	test('★ 容差可显式覆盖（判据可测、也可按机器调）', () => {
		const base = 1788520092213625000;
		assert.strictEqual(isFileStatChanged(6378, base, 6378, base + 100_000, 0), true, '容差 0 ⇒ 逐字节比较 ⇒ 算改过 ✓');
		assert.strictEqual(isFileStatChanged(6378, base, 6378, base + 100_000, 1_000_000), false, '容差 1ms ⇒ 不算 ✓');
	});
});
