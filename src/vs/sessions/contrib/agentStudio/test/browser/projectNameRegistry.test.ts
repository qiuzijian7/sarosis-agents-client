/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「项目名按 root 唯一」判据的单测（2026-09-16，用户裁决）。
 *
 * 事故：项目名一律取 `basename(root)` ⇒ `D:\GR_\S1Game` 与 `D:\PJDB\S1Game` 同名；
 * 而内存 `GraphStore` / 主进程 SQLite 都以**项目名**为唯一键 ⇒ 两份图合并、再也拆不开。
 * 现场日志实证：`[prune] same-name project(s) span multiple roots — data already merged under
 * one project key, cannot split by root: S1Game(外: f:/pjdb_qiuzijian_main/s1game)`。
 *
 * 修法：**持久化**的「basename 认领表」——首个 root 认领 `basename`（零迁移），
 * 同名者用 `basename@<root 短哈希>`（由 root 推导 ⇒ 跨会话稳定）。
 *
 * 运行：
 *     node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *         src/vs/sessions/contrib/agentStudio/test/browser/projectNameRegistry.test.ts
 */

import assert from 'assert';
import {
	PROJECT_NAME_CLAIMS_VERSION,
	ProjectNameClaims,
	baseNameOf,
	normalizeRootForClaim,
	parseProjectNameClaims,
	resolveProjectName,
	serializeProjectNameClaims,
	shortRootHash,
} from '../../common/projectNameRegistry.js';

/** 模拟「按需认领 + 持久化」：把 `claim` 写回表（与 service 的 `resolveProjectNameForRoot` 同形：键取小写）。 */
function resolveAndClaim(rootPath: string, claims: ProjectNameClaims): string {
	const { name, claim } = resolveProjectName(rootPath, claims);
	if (claim) { claims[claim.base.toLowerCase()] = claim; }
	return name;
}

suite('项目名按 root 唯一 — 判据（纯函数）', () => {

	const GR = 'D:\\GR_qiuzijian_main\\S1Game';
	const PJDB = 'D:\\PJDB_qiuzijian_main\\S1Game';

	test('★★★ 同名不同 root 必须得到**不同**项目名（GR_ 与 PJDB 不再合并）', () => {
		const claims: ProjectNameClaims = {};
		const first = resolveAndClaim(GR, claims);
		const second = resolveAndClaim(PJDB, claims);

		assert.strictEqual(first, 'S1Game', '首个 root 认领 basename ⇒ 零迁移');
		assert.notStrictEqual(second, first, '⚠ 同名不同 root 绝不能同名 —— 这正是事故根源');
		assert.strictEqual(second, `S1Game@${shortRootHash(PJDB)}`, '冲突方用 root 短哈希后缀');
	});

	test('★★★ 名字必须**跨会话稳定**（认领表持久化后重新解析结果不变）', () => {
		const claims: ProjectNameClaims = {};
		const gr1 = resolveAndClaim(GR, claims);
		const pjdb1 = resolveAndClaim(PJDB, claims);

		// 模拟「下次启动」：读回同一份认领表再解析（顺序也故意反过来）
		const reloaded = parseProjectNameClaims(serializeProjectNameClaims(claims));
		assert.strictEqual(resolveAndClaim(PJDB, reloaded), pjdb1, 'PJDB 的名字不得随会话变化');
		assert.strictEqual(resolveAndClaim(GR, reloaded), gr1, 'GR_ 的名字不得随会话变化');
		assert.strictEqual(Object.keys(reloaded).length, 1, '只应有一条认领（S1Game）');
	});

	test('★ 认领者自身重复解析 ⇒ 始终 basename，且**不再**产生新认领', () => {
		const claims: ProjectNameClaims = {};
		assert.strictEqual(resolveAndClaim(GR, claims), 'S1Game');
		const again = resolveProjectName(GR, claims);
		assert.strictEqual(again.name, 'S1Game');
		assert.strictEqual(again.claim, undefined, '不得反复认领');
	});

	test('★ 大小写 / 分隔符差异必须视为**同一个 root**（不误判成冲突）', () => {
		const claims: ProjectNameClaims = {};
		resolveAndClaim('D:\\GR_qiuzijian_main\\S1Game', claims);
		// Windows 上同一目录的不同写法：小写盘符 + 正斜杠 + 尾分隔符
		for (const variant of ['d:/gr_qiuzijian_main/s1game', 'd:/GR_qiuzijian_main/S1Game/', 'D:\\gr_qiuzijian_main\\s1game\\']) {
			assert.strictEqual(resolveAndClaim(variant, claims), 'S1Game',
				`同一 root 的不同写法不得被判为冲突：${variant}`);
		}
	});

	test('★ 未认领时给出待写入的认领项（服务据此持久化）', () => {
		const r = resolveProjectName(GR, {});
		assert.strictEqual(r.name, 'S1Game');
		assert.deepStrictEqual(r.claim, { base: 'S1Game', root: normalizeRootForClaim(GR) });
	});

	test('★ 路径异常（取不出名字）⇒ 返回空串且**不占**认领表', () => {
		for (const bad of ['', '/', '', '   ']) {
			const r = resolveProjectName(bad, {});
			assert.ok(r.name.trim() === '', `异常路径不得取到项目名：${JSON.stringify(bad)} ⇒ ${JSON.stringify(r.name)}`);
			assert.strictEqual(r.claim, undefined, `异常路径不得占用认领表：${JSON.stringify(bad)}`);
		}
		// 盘根（`C:\`）是合法 root，只是名字为 `C:` —— 不得崩、也不得占用**空**键
		for (const drive of ['C:\\', 'D:/']) {
			const r = resolveProjectName(drive, {});
			assert.ok(r.name.length > 0, `盘根应得到稳定名字：${drive} ⇒ ${JSON.stringify(r.name)}`);
			assert.ok(r.claim && r.claim.base.length > 0, '认领键不得为空');
		}
	});

	test('★ 短哈希：确定性 + 不同 root 不同值 + 6 位 base36', () => {
		assert.strictEqual(shortRootHash(GR), shortRootHash('d:/gr_qiuzijian_main/s1game'), '同一 root 必须同值');
		assert.notStrictEqual(shortRootHash(GR), shortRootHash(PJDB), '不同 root 不应碰撞');
		assert.match(shortRootHash(GR), /^[0-9a-z]{6}$/, '必须是 6 位 base36（拼进项目名要安全）');
	});

	test('★ basename 取值（与 service 的 _basename 同语义）', () => {
		assert.strictEqual(baseNameOf(GR), 'S1Game');
		assert.strictEqual(baseNameOf('d:/a/b/'), 'b');
		assert.strictEqual(baseNameOf('/root'), 'root');
		assert.strictEqual(baseNameOf('sarosis-agents-client'), 'sarosis-agents-client');
	});
});

suite('项目名按 root 唯一 — 认领表文件（容错 + 稳定）', () => {

	test('★★★ 任何损坏形态都回落空表（便利数据，绝不阻断启动）', () => {
		for (const bad of [undefined, null, '', 'not json', '[]', '{}', '{"version":99,"byBase":{"a":"b"}}',
			`{"version":${PROJECT_NAME_CLAIMS_VERSION},"byBase":null}`, `{"version":${PROJECT_NAME_CLAIMS_VERSION},"byBase":[]}`]) {
			assert.deepStrictEqual(parseProjectNameClaims(bad as unknown as string), {},
				`损坏形态必须回落空表：${JSON.stringify(bad)}`);
		}
	});

	test('★ 垃圾值必须被丢掉、键必须归一化为小写（否则会把垃圾写进项目名）', () => {
		const raw = JSON.stringify({
			version: PROJECT_NAME_CLAIMS_VERSION,
			byBase: {
				S1Game: { root: 'd:/a/s1game', base: 'S1Game' }, // 正常记录（键大小写会被归一化）
				legacy: 'd:/b/legacy',                            // 兼容：值是 root 字符串
				'': { root: 'd:/x', base: 'x' },                  // 空键 ⇒ 丢
				bad: 42,                                          // 非对象 ⇒ 丢
				noRoot: { base: 'noRoot' },                       // 缺 root ⇒ 丢
			},
		});
		assert.deepStrictEqual(parseProjectNameClaims(raw), {
			s1game: { root: 'd:/a/s1game', base: 'S1Game' },
			legacy: { root: 'd:/b/legacy', base: 'legacy' },
		});
	});

	test('★ 序列化必须键排序（文件内容稳定，便于排障与 diff）', () => {
		const claims: ProjectNameClaims = {
			b: { root: 'd:/b', base: 'B' },
			a: { root: 'd:/a', base: 'A' },
			c: { root: 'd:/c', base: 'C' },
		};
		const out = serializeProjectNameClaims(claims);
		assert.ok(out.indexOf('"a"') < out.indexOf('"b"') && out.indexOf('"b"') < out.indexOf('"c"'), out);
		assert.deepStrictEqual(parseProjectNameClaims(out), claims);
	});
});
