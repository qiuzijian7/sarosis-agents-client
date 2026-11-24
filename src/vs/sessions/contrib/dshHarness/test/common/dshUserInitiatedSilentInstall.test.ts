/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 用户点击「更新」后必须走「后台静默安装 → 安装完成后提示重启」，但不是自动更新。
 *
 * 守卫目标：
 *   ① 检查到更新只进入 AvailableForDownload，仍要用户点击；
 *   ② 用户确认后强制 doApplyUpdate()，不再被 enableWindowsBackgroundUpdates 开关跳过；
 *   ③ 安装器使用 /verysilent 后台更新协议，兜底路径也不许退回 /silent；
 *   ④ Ready 状态仍弹重启提示，文案改成「已安装完成」；
 *   ⑤ update.mode 保持 manual，避免把本次需求误做成自动更新。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshUserInitiatedSilentInstall
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';

const WIN32_UPDATE = 'src/vs/platform/update/electron-main/updateService.win32.ts';
const UPDATE_UI = 'src/vs/workbench/contrib/update/browser/update.ts';
const UPDATE_CONFIG = 'src/vs/platform/update/common/update.config.contribution.ts';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), `source missing: ${abs}`);
	return fs.readFileSync(abs, 'utf8');
}

function stripComments(s: string): string {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
}

/** 切出一个类方法体，直到下一个 protected / private / override 方法。 */
function body(src: string, signature: string): string {
	const at = src.indexOf(signature);
	assert.ok(at > 0, `找不到 ${signature}`);
	const markers = ['\n\tprotected ', '\n\tprivate ', '\n\toverride '];
	const ends = markers
		.map(marker => src.indexOf(marker, at + signature.length))
		.filter(index => index > 0);
	return src.slice(at, ends.length ? Math.min(...ends) : src.length);
}

suite('用户点击更新后必须后台静默安装，完成后提示重启', () => {

	test('① 检测到更新仍停在 AvailableForDownload，不自动下载安装', () => {
		const src = stripComments(read(WIN32_UPDATE));
		const start = src.indexOf('protected doCheckForUpdates');
		const end = src.indexOf('protected override async doDownloadUpdate');
		assert.ok(start > 0 && end > start, '找不到 doCheckForUpdates / doDownloadUpdate 边界');
		const check = src.slice(start, end);
		assert.match(check, /this\.setState\(State\.AvailableForDownload\(update\)\);/, '必须等用户点击');
		assert.doesNotMatch(check, /startBackgroundDownload\(update/, '检查阶段不许自动下载');

		const download = src.slice(end, src.indexOf('private async startBackgroundDownload', end));
		assert.match(download, /await this\.startBackgroundDownload\(state\.update, true\)/, '用户确认后才进入后台下载安装');
	});

	test('② 用户确认后强制 doApplyUpdate，不再受 enableWindowsBackgroundUpdates 开关影响', () => {
		const src = stripComments(read(WIN32_UPDATE));
		const downloadBody = body(src, 'private async startBackgroundDownload');
		const specificBody = body(src, 'override async _applySpecificUpdate');

		for (const [name, target] of [['startBackgroundDownload', downloadBody], ['_applySpecificUpdate', specificBody]] as const) {
			assert.doesNotMatch(target, /fastUpdatesEnabled/, `${name} 不许再把用户确认的安装交给可关闭的设置`);
			assert.match(target, /if \(this\.productService\.target === 'user'\) \{[\s\S]{0,180}await this\.doApplyUpdate\(\);/, `${name} 对 user setup 必须静默安装`);
			assert.match(target, /else \{\s*this\.setState\(State\.Ready\(/, `${name} 的非 user setup 仍保留 Ready 兜底`);
		}
	});

	test('③ doApplyUpdate 使用隐藏后台安装参数，且 spawn 前释放文件锁', () => {
		const src = stripComments(read(WIN32_UPDATE));
		const apply = body(src, 'protected override async doApplyUpdate()');
		for (const flag of ['/verysilent', '/update=', '/progress=', '/sessionend=', '/cancel=', '/nocloseapplications']) {
			assert.ok(apply.includes(flag), `doApplyUpdate 缺少 ${flag}`);
		}
		const hookAt = apply.indexOf('runBeforeUpdateInstallHooks(');
		const spawnAt = apply.indexOf('spawn(');
		assert.ok(hookAt > 0 && spawnAt > hookAt, '释放文件锁必须早于 spawn 安装器');
		assert.match(apply, /detached: true/, '安装器必须 detached 后台运行');
		assert.match(apply, /stdio: \['ignore', 'ignore', 'ignore'\]/, '安装器输出必须被忽略');
	});

	test('④ 兜底路径也不许退回可见 /silent 安装器', () => {
		const src = stripComments(read(WIN32_UPDATE));
		const quit = body(src, 'protected override doQuitAndInstall()');
		assert.doesNotMatch(quit, /\[\s*'\/silent'/, '兜底路径不许使用 /silent');
		for (const flag of ['/verysilent', '/suppressmsgboxes', '/norestart', '/sp-']) {
			assert.ok(quit.includes(flag), `兜底路径缺少 ${flag}`);
		}
	});

	test('⑤ Ready 状态仍提示重启，文案明确是安装完成后', () => {
		const ui = stripComments(read(UPDATE_UI));
		const readyStart = ui.indexOf('case StateType.Ready:');
		assert.ok(readyStart > 0, '找不到 Ready 分支');
		const readyEnd = ui.indexOf('break;', readyStart);
		const ready = ui.slice(readyStart, readyEnd > readyStart ? readyEnd : ui.length);
		assert.match(ready, /this\.promptForRestart\(\)/, '安装完成后必须弹重启提示');
		assert.ok(ui.includes('更新包将在后台下载并静默安装'), '点击更新前要说明静默安装');
		assert.ok(ui.includes('更新已安装完成'), 'Ready 文案必须说明安装已完成');
		assert.doesNotMatch(ui, /Update downloaded\. Restart now/, '不能仍写成只下载完成');
		assert.doesNotMatch(ui, /applied on next restart/, '不能仍写成重启时才安装');
	});

	test('⑥ update.mode 保持 manual：不是自动更新', () => {
		const cfg = read(UPDATE_CONFIG);
		assert.match(cfg, /default: 'manual'/, '用户点击前不许自动检查/自动安装');
	});
});
