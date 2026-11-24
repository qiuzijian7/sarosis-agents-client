/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 升级安装前必须清理 detached dsh Host：它加载的 `koffi.node` 等原生模块会让
 * Inno Setup 的 DeleteFile 报错误代码 5（拒绝访问）。
 *
 * 覆盖两道防线：
 * ① `code.iss` 的 `PrepareToInstall()` 在后台更新/手动安装中都执行清理脚本；
 * ② `restartreplace` 仍是最后兜底。
 *
 * 运行：node src/vs/sessions/contrib/dshHarness/test/common/run-all-common-tests.mjs dshInnoRuntimeLock
 */

import assert from 'assert';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ISS = 'build/win32/code.iss';
const SCRIPT = 'build/saros/stop-vssaros-runtime.ps1';

function read(rel: string): string {
	const abs = path.join(process.cwd(), rel);
	assert.ok(fs.existsSync(abs), 'source missing (cwd changed?): ' + abs);
	return fs.readFileSync(abs, 'utf8');
}

function filesSection(src: string): string {
	const at = src.indexOf('[Files]');
	assert.ok(at > 0, '找不到 [Files] 段');
	const end = src.indexOf('\n[', at + 1);
	return src.slice(at, end > at ? end : src.length);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

suite('升级安装不许被 detached dsh Host 锁住原生模块', () => {

	test('安装包嵌入清理脚本，并在 PrepareToInstall 中无条件调用', () => {
		const iss = read(ISS);
		const files = filesSection(iss);
		assert.match(files, /build\\saros\\stop-vssaros-runtime\.ps1.*Flags: dontcopy/, '清理脚本必须来自已入库目录，并作为 dontcopy 文件编译进安装包');
		assert.match(iss, /ExtractTemporaryFile\('stop-vssaros-runtime\.ps1'\)/);

		const prepare = iss.indexOf('function PrepareToInstall');
		assert.ok(prepare > 0, '找不到 PrepareToInstall');
		const call = iss.indexOf('StopVsSarosRuntimeProcesses();', prepare);
		const gate = iss.indexOf('if IsNotBackgroundUpdate()', prepare);
		assert.ok(call > prepare, 'PrepareToInstall 必须调用运行时进程清理');
		assert.ok(gate < 0 || call < gate, '后台自动更新也要清理，不能只在非后台分支执行');
		assert.match(files, /Source:\s*"\*".*restartreplace/, 'restartreplace 兜底不能丢');
	});

	test('后台更新只清理 dsh Host，保留主客户端以显示重启提示', () => {
		const iss = read(ISS);
		const fnStart = iss.indexOf('function StopVsSarosRuntimeProcesses');
		const fnEnd = iss.indexOf('function StopTunnelOtherProcesses', fnStart);
		assert.ok(fnStart > 0 && fnEnd > fnStart, '找不到清理函数边界');
		const fn = iss.slice(fnStart, fnEnd);
		assert.match(fn, /if IsBackgroundUpdate\(\) then[\s\S]{0,220}-BackgroundUpdate/, '后台更新必须传 -BackgroundUpdate');

		const script = read(SCRIPT);
		assert.match(script, /param\(\[switch\]\$BackgroundUpdate\)/, '清理脚本必须接收后台更新开关');
		assert.match(script, /\$script:BackgroundUpdateEnabled -and \$isApp/, '后台更新必须跳过主客户端进程');
		assert.match(script, /mode=background/, 'dry-run 要能识别后台模式');
	});

	test('清理脚本只针对生产运行时，且失败不影响安装', () => {
		const script = read(SCRIPT);
		assert.match(script, /taskkill \/PID .*\/T \/F/, 'node.exe 要连同子进程树一起结束');
		assert.match(script, /Stop-Process -Id .* -Force/, '主程序只杀自身，不能用 /T 连安装器一起杀');
		assert.match(script, /\.vssaros-dev/, '不能误杀 dev 实例');
		assert.match(script, /SarosWorkspace/, '不能误杀仓库开发实例');
		assert.match(script, /VS_SAROS_STOP_RUNTIME_DRYRUN/, 'dry-run 开关要保留，便于回归');
		assert.match(script, /exit 0/, '清理失败时仍由 restartreplace 兜底，不直接中断安装');
	});

	test('dry-run 能识别生产形状的 node 进程但绝不结束它', async () => {
		if (process.platform !== 'win32') { return; }
		// 用一个受控 node 子进程伪装成“引用生产 profile 的 dsh Host 子进程”。
		const marker = '\\.vssaros\\dsh-home\\profiles\\inno-lock-probe';
		const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', marker], {
			detached: true,
			stdio: 'ignore',
		});
		child.unref();
		const pid = child.pid;
		assert.ok(pid, '探针进程没起来');
		const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
		try {
			await new Promise(resolve => setTimeout(resolve, 700));
			assert.ok(isAlive(pid), '探针进程应在 dry-run 前存活');
			const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(process.cwd(), SCRIPT)], {
				encoding: 'utf8',
				timeout: 30_000,
				env: { ...process.env, VS_SAROS_STOP_RUNTIME_DRYRUN: '1' },
			});
			assert.strictEqual(result.status, 0, `清理脚本语法/执行失败：${result.stderr || result.stdout}`);
			assert.match(result.stdout, new RegExp(`pid=${pid}`), 'dry-run 应识别出生产形状的 node 进程');
			assert.ok(isAlive(pid), 'dry-run 不许结束进程');
		} finally {
			try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
		}
	});

	test('后台更新 dry-run 跳过 VsSaros.exe，手动 dry-run 仍列出它', async () => {
		if (process.platform !== 'win32') { return; }
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-bg-runtime-'));
		const fakeExe = path.join(tempDir, 'VsSaros.exe');
		fs.copyFileSync(process.execPath, fakeExe);
		const child = spawn(fakeExe, ['-e', 'setInterval(() => {}, 1000)'], {
			detached: true,
			stdio: 'ignore',
		});
		child.unref();
		const pid = child.pid;
		assert.ok(pid, '伪主程序进程没起来');
		const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
		const baseArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(process.cwd(), SCRIPT)];
		const env = { ...process.env, VS_SAROS_STOP_RUNTIME_DRYRUN: '1' };
		try {
			await new Promise(resolve => setTimeout(resolve, 700));
			assert.ok(isAlive(pid!), '伪主程序应在 dry-run 前存活');

			const bg = spawnSync(powershell, [...baseArgs, '-BackgroundUpdate'], { encoding: 'utf8', timeout: 30_000, env });
			assert.strictEqual(bg.status, 0, `后台 dry-run 失败：${bg.stderr || bg.stdout}`);
			assert.match(bg.stdout, /mode=background/, '后台 dry-run 必须进入 background 模式');
			assert.doesNotMatch(bg.stdout, new RegExp(`pid=${pid}\\b`), '后台更新不能列出主客户端');
			assert.ok(isAlive(pid!), '后台 dry-run 不许结束主客户端');

			const manual = spawnSync(powershell, baseArgs, { encoding: 'utf8', timeout: 30_000, env });
			assert.strictEqual(manual.status, 0, `手动 dry-run 失败：${manual.stderr || manual.stdout}`);
			assert.match(manual.stdout, new RegExp(`pid=${pid}\\b`), '手动安装仍应列出主程序以便清理残留');
			assert.ok(isAlive(pid!), 'dry-run 不许结束主客户端');
		} finally {
			try { process.kill(pid!, 'SIGKILL'); } catch { /* 已退出 */ }
			await new Promise(resolve => setTimeout(resolve, 300));
			try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* 临时文件清理失败不影响断言 */ }
		}
	});
});
