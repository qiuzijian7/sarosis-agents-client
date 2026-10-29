/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「两套 userData、结构一致」的守卫（2026-10-28 最终形态）。
 *
 * 用户要求过两次，方向相反，结论是**两者不可兼得**：
 *   · 「dev 与稳定版共用一套目录」⇒ 一份 profile，但**不能同时开着**（Electron 单实例锁绑 userData）、
 *     dev 升上去的插件让稳定版的新包永远装不进来、脏数据互串；
 *   · 「两个形态同时开着」⇒ 必须有**两份 userData**（VS Code 自己就是 `code` / `code-insiders` /
 *     `code-oss-dev` 三份目录，每份结构完全相同）。
 *
 * 最终选后者，于是：
 *   `~/.vssaros`（稳定版） / `~/.vssaros-dev`（开发版），**两者内部结构一致** ⇒
 *   `dshHarnessChannel` 的 DSH_HOME 只需一条规则 `<userData>/dsh-home`，
 *   **不许**再出现 `isBuilt` 分叉或 `dsh-home-dev` 这类特例（那是"共用 userData"时期的产物）。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshUserDataUnified
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const CHANNEL = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts';
const LAUNCHER = 'scripts/start-dev-app.mjs';
const LAUNCH_JSON = '.vscode/launch.json';
const SEPARATE = 'scripts/separate-dev-userdata.mjs';
const SKILL_ROOTS = 'src/vs/sessions/contrib/agentStudio/common/skillRoots.ts';
const DSH_PLUGIN_SKILL_ROOTS = 'src/vs/sessions/contrib/agentStudio/common/dshPluginSkillRoots.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `源文件不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('两套 userData（稳定版 / 开发版），结构一致', () => {

	test('① DSH_HOME 一条规则 `<userData>/dsh-home`（不许再按形态分叉）', () => {
		const src = stripComments(read(CHANNEL));
		const at = src.indexOf('defaultDshHome:');
		assert.ok(at > 0, '找不到 defaultDshHome ✗');
		const line = src.slice(at, src.indexOf('\n', at));
		assert.match(line, /join\(options\.userDataPath, 'dsh-home'\)/,
			"DSH_HOME 必须是 `join(options.userDataPath, 'dsh-home')`（两边 userData 已分开 ⇒ 结构一致）✗");
		assert.ok(!/isBuilt\s*\?/.test(line),
			'不许再按 isBuilt 分叉：`isBuilt ? undefined` 会回落 `~/.dsh`（两套 profile），'
			+ '`isBuilt ? dsh-home : dsh-home-dev` 是"共用 userData"时期的产物（那时还抢锁）✗');
		assert.ok(!line.includes('dsh-home-dev'), '不许再出现 `dsh-home-dev`（结构必须两边一致）✗');
	});

	test('② dev 必须用独立 userData `~/.vssaros-dev`（否则抢单实例锁）', () => {
		const launcher = stripComments(read(LAUNCHER));
		assert.match(launcher, /path\.join\(os\.homedir\(\), '\.vssaros-dev'\)/,
			'启动器必须用 `~/.vssaros-dev`（与稳定版共用 `~/.vssaros` ⇒ 第二个实例直接退出 ✗）✗');
		assert.ok(!/path\.join\(os\.homedir\(\), '\.vssaros'\)/.test(launcher),
			'启动器不许再指向 `~/.vssaros`（那是稳定版的 userData）✗');

		const launch = read(LAUNCH_JSON);
		assert.match(launch, /"userDataDir":\s*"\$\{userHome\}\/\.vssaros-dev"/,
			'launch.json 的 userDataDir 必须是 `${userHome}/.vssaros-dev` ✗');
		// ⚠ 只查"出现过一次"会被"改掉其中一处、留着另外两处"骗过（实测假绿 ✗）⇒ 必须逐个都对上。
		const userDataDirs = (launch.match(/"userDataDir":/g) || []).length;
		const devHits = (launch.match(/"userDataDir":\s*"\$\{userHome\}\/\.vssaros-dev"/g) || []).length;
		assert.strictEqual(devHits, userDataDirs,
			`launch.json 里 ${userDataDirs} 处 userDataDir 必须**全部**指向 .vssaros-dev（当前只有 ${devHits} 处）✗`);
		assert.ok(!/"userDataDir":\s*"\$\{userHome\}\/\.vssaros"/.test(launch),
			'launch.json 里不许有指向 `~/.vssaros`（稳定版 userData）的配置 ✗');
	});

	test('③ 就位脚本：备份 + 增量同步 + 移动 DSH_HOME + 重写指针', () => {
		const src = read(SEPARATE);
		assert.match(src, /robocopy/, '必须用 robocopy（profile 是十万级小文件）✗');
		// 旧 dev 的 dsh-home 必须先改名备份（可回滚）
		assert.match(src, /renameSync\(DEV_DSH, backup\)/, '必须先把旧 dev 的 dsh-home 改名备份（可回滚）✗');
		// 同步要排除缓存/运行期文件，否则把锁和死端口一起搬过去
		assert.match(src, /'\*\.lock'|'\*\.lock',/, '必须排除 `*.lock`（迁移死锁是真实事故）✗');
		assert.match(src, /EXCLUDE_DIRS[\s\S]{0,400}'Cache'/, '必须排除浏览器缓存目录（体积大且会带来错乱状态）✗');
		// 中间方案的 dsh-home-dev 要**移动**成 dev 的 dsh-home（不是复制，避免两份并存）
		assert.match(src, /'\/MOVE'/, "把 `dsh-home-dev` 就位时必须 `/MOVE`（留着两份会互相干扰）✗");
		// 指针必须重写：只搬文件不改指针 ⇒ 删掉源目录就全坏
		assert.match(src, /rewritePointers\(DEV_DSH, '\.vssaros\/dsh-home-dev', '\.vssaros-dev\/dsh-home'\)/,
			'必须把 dev profile 里的 `file:` 绝对路径改到新位置 ✗');
	});

	test('④ 技能根候选只认一条 `<dataRoot>/dsh-home`（不许再给 dev 特例）', () => {
		const roots = stripComments(read(SKILL_ROOTS));
		assert.match(roots, /joinFsPath\(joinFsPath\(homes\.dataRoot\.trim\(\), 'dsh-home'\), 'skills'\)/,
			'技能根候选必须含 `<dataRoot>/dsh-home/skills` ✗');
		assert.ok(!roots.includes('dsh-home-dev'),
			'不许再出现 `dsh-home-dev`（两边结构一致，多给候选只会掩盖"目录配错了"✗）');

		const pluginRoots = stripComments(read(DSH_PLUGIN_SKILL_ROOTS));
		assert.match(pluginRoots, /joinFsPath\(dataRoot, 'dsh-home'\)/, '`dshHomeCandidates` 必须含 `<dataRoot>/dsh-home` ✗');
		assert.ok(!pluginRoots.includes('dsh-home-dev'), '`dshHomeCandidates` 不许再出现 `dsh-home-dev` ✗');
	});
});
