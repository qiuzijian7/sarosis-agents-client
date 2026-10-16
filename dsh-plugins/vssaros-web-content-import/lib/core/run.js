// @vssaros/dsh-web-content-import — core：子进程执行封装（`spawn`，**数组传参不走 shell** ✓）。
//
// 为什么自己写：dsh 插件跑在 Host 进程（Node），没有 IDE 侧的 `execShortCommand` 通道；
// 这里给一个最小封装：超时 + stdout/stderr 收集 + 字节上限 + **启动失败与超时分开**（两者语义不同：
// 不存在 = 工具不可用（降级 ✓）；超时 = 这次没跑完（可能重试 ✓）—— 混成一句会让模型分不清）。

import { spawn } from 'node:child_process';

/**
 * 跑一个命令。返回 `{ ok, code, stdout, stderr, timedOut, spawnError }`。
 * - 启动失败（命令不存在 / 权限）⇒ `spawnError`（`ok:false`），**不抛**（调用方按"工具不可用"降级 ✓）；
 * - 超时 ⇒ `timedOut:true` 且杀进程；
 * - 输出超 `maxBytes` ⇒ 截断（不丢进程；yt-dlp 的 stderr 进度条很长 ✓）。
 */
export function runCommand(file, args, { timeoutMs = 60000, maxBytes = 2 * 1024 * 1024 } = {}) {
	return new Promise(resolve => {
		let child;
		try {
			child = spawn(file, args, { windowsHide: true });
		} catch (e) {
			resolve({ ok: false, code: -1, spawnError: String(e?.message ?? e), stdout: '', stderr: '', timedOut: false });
			return;
		}
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let settled = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
		}, timeoutMs);
		timer.unref?.();
		const cap = (buf, chunk) => (buf.length < maxBytes ? buf + chunk : buf);
		child.stdout?.on('data', d => { stdout = cap(stdout, d.toString()); });
		child.stderr?.on('data', d => { stderr = cap(stderr, d.toString()); });
		child.on('error', e => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			resolve({ ok: false, code: -1, spawnError: String(e?.message ?? e), stdout, stderr, timedOut });
		});
		child.on('close', code => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			resolve({ ok: code === 0 && !timedOut, code: code ?? -1, stdout, stderr, timedOut });
		});
	});
}
