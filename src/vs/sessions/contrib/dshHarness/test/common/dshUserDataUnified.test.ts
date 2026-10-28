/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「一套 userData / 一份 profile」的守卫（2026-10-28）。
 *
 * 用户要求：把 `~/.vssaros` 与 `~/.vssaros-dev` 统一成 `~/.vssaros`。
 *
 * 统一必须同时改**两处**才算真的统一，任一处漏掉就退回"两套 profile"：
 *   ① **userDataPath**：dev 的 `--user-data-dir`（`.vscode/launch.json` + 启动器脚本）
 *      —— 只改代码里的默认值没用，dev 是靠命令行覆盖的；
 *   ② **DSH_HOME**：`dshHarnessChannel` 里原来写 `isBuilt ? undefined : join(userDataPath,'dsh-home')`
 *      ⇒ 打包版不给 ⇒ dsh 回落 `~/.dsh`。于是同一个 profile 名（`vssaros`）在两处各一份、
 *      版本还不同（真机：`~/.dsh` 里 chat-surface 0.2.259 / dev 的 dsh-home 里 0.2.269）
 *      ⇒ 旧的一侧启动时尝试"降级重装"（8 个包、4 分钟超时 + 逐项回退再失败）✗✗。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshUserDataUnified
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const CHANNEL = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHarnessChannel.ts';
const LAUNCHER = 'scripts/start-dev-app.mjs';
const LAUNCH_JSON = '.vscode/launch.json';
const MIGRATE = 'scripts/migrate-userdata-dev-to-prod.mjs';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `源文件不存在（路径基准变了？）：${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

suite('一套 userData / 一份 profile', () => {

	test('① DSH_HOME 两种形态必须一致（不许 isBuilt 分叉）', () => {
		const src = stripComments(read(CHANNEL));
		const at = src.indexOf('defaultDshHome:');
		assert.ok(at > 0, '找不到 defaultDshHome ✗');
		const line = src.slice(at, src.indexOf('\n', at));
		assert.ok(!/isBuilt\s*\?/.test(line),
			'`defaultDshHome` 不许再按 isBuilt 分叉（打包版会回落 ~/.dsh ⇒ 又是两套 profile ✗）');
		assert.match(line, /join\(options\.userDataPath, 'dsh-home'\)/,
			'DSH_HOME 必须是 `<userDataPath>/dsh-home`（两种形态同一份）✗');
	});

	test('② dev 的 --user-data-dir 必须指向 ~/.vssaros（启动器 + launch.json）', () => {
		const launcher = stripComments(read(LAUNCHER));
		assert.match(launcher, /path\.join\(os\.homedir\(\), '\.vssaros'\)/,
			'启动器必须用 ~/.vssaros（改用 .vssaros-dev 就又是两套）✗');
		assert.ok(!/\.vssaros-dev/.test(launcher), '启动器里不许再出现 .vssaros-dev ✗');

		const launch = read(LAUNCH_JSON);
		assert.ok(!/\.vssaros-dev/.test(launch),
			'launch.json 里不许再出现 .vssaros-dev（它是 dev 的真实 userData 来源，漏一处就退回两套 ✗）');
		assert.match(launch, /"userDataDir":\s*"\$\{userHome\}\/\.vssaros"/,
			'launch.json 的 userDataDir 必须指向 ${userHome}/.vssaros ✗');
	});

	test('③ 迁移脚本必须在：合并（dev 优先）+ 先备份 + 不删源', () => {
		const src = read(MIGRATE);
		assert.match(src, /robocopy/, '迁移必须用 robocopy（十万级小文件用 fs 复制要很久）✗');
		// ⚠ 必须断言**真的调用了备份**：只查 `bak-` 字样会被注释/路径名骗过（实测假绿 ✗）。
		assert.match(src, /const backup = `\$\{DST\}\.bak-/, '必须真的算出备份路径（可回滚）✗');
		assert.match(src, /copy\(DST, backup\);/, '必须真的把目标复制到备份目录（只写注释不算 ✗）');
		// dev 优先：`copy(SRC, DST, …)` 这一步不能带"目标优先"的排除开关
		const devStep = /copy\(SRC, DST, \[[^\]]*\]\)/.exec(src);
		assert.ok(devStep, '找不到"dev → 目标"那一步 ✗');
		assert.ok(!/\/XO|\/XN|\/XC/.test(devStep[0]),
			'dev → 目标那一步不许带"目标优先"开关（否则 dev 的新 profile 覆盖不过去 ✗）');
		assert.match(src, /SKIP_FILES/, '必须排除运行期文件（SingletonLock / DevToolsActivePort 等）✗');
		assert.ok(!/rmSync\(SRC|fs\.rm\(SRC/.test(src), '不许删除源目录（要留给用户确认与回滚）✗');
	});
});
