/*---------------------------------------------------------------------------------------------
 *  sync-write-watchdog.cjs — Node/Electron 进程「同步写看门狗」（--require 预加载钩子）
 *
 *  背景（2026-10-13/14 复现取证）：VsSaros dev 实例反复"挂机后卡死"，cdb 抓栈定位到
 *  主进程 JS 线程卡在一次同步文件写里（NtWriteFile ← KERNELBASE!WriteFile ←
 *  VsSaros!uv_fs_write ← V8 JIT 帧 ← uv_run/定时器回调），且永不返回；而本机 iOA DLP
 *  把 NtQueryObject 挡了，`!handle` 拿不到被卡句柄的文件名 ⇒ 只能改走插桩：
 *  让下一次卡死自己报"是谁在写、写到哪"。
 *
 *  用法：NODE_OPTIONS=--require <此文件绝对路径>（scripts/code.bat 已接线，
 *  可用环境变量 SAROSIS_SYNC_WRITE_WATCHDOG=0 关闭）。
 *
 *  原理：包装 fs 的同步写族。每次进入先落一行 BEGIN（函数名+目标+字节数+时刻+调用栈），
 *  返回后再落一行 END（耗时）；耗时 >= SAROSIS_SYNCWATCH_SLOW_MS（默认 50）改打 SLOW。
 *  ⇒ 进程卡死在某次同步写里时，看门狗日志里"没有配对 END 的最后一行 BEGIN"就是元凶。
 *  日志：%TEMP%\saros-syncwatch-<pid>-<role>.log（role = browser/utility/node/…）。
 *
 *  设计约束（刻意的）：
 *    · 自身日志一律用"打补丁前保存的原始函数"写 —— 绝不经过被包装的路径，不递归；
 *    · 任何一步失败都必须静默吞掉：看门狗绝不能成为新的阻塞源（整体包 try/catch）；
 *    · 已知盲区：Node 内部走 internalBinding('fs') 的路径（如 stdout 是文件时的
 *      SyncWriteStream）不经过 fs 公共 API，本看门狗看不见 —— 若看门狗全程安静而进程
 *      仍然卡死，下一个嫌犯就是它（届时补 process.stdout/console 的插桩）。
 *--------------------------------------------------------------------------------------------*/

try { main(); } catch { /* 看门狗加载失败绝不拖垮宿主进程 */ }

function main() {
	const fs = require('fs');
	const os = require('os');
	const path = require('path');

	// 与 mainProcessSyncWrites.test.ts 的守卫家族对齐 + openSync（open 同样会被过滤驱动卡住）
	const WATCH = [
		'writeFileSync', 'appendFileSync', 'writeSync', 'writevSync',
		'fsyncSync', 'fdatasyncSync', 'copyFileSync', 'truncateSync', 'openSync',
	];

	const original = {};
	for (const name of WATCH) {
		if (typeof fs[name] === 'function') { original[name] = fs[name]; }
	}
	if (!original.openSync || !original.writeSync) { return; }

	const role = typeof process.type === 'string' && process.type ? process.type
		: (process.env.ELECTRON_RUN_AS_NODE ? 'node' : 'main');
	const logPath = path.join(os.tmpdir(), `saros-syncwatch-${process.pid}-${role}.log`);
	let logFd = -1;
	try { logFd = original.openSync(logPath, 'a'); } catch { return; }

	const slowMsRaw = Number(process.env.SAROSIS_SYNCWATCH_SLOW_MS);
	const slowMs = Number.isFinite(slowMsRaw) && slowMsRaw > 0 ? slowMsRaw : 50;

	const writeLog = (line) => {
		try { original.writeSync(logFd, `${new Date().toISOString()} ${line}\n`); } catch { /* 吞掉 */ }
	};

	writeLog(`BOOT pid=${process.pid} ppid=${process.ppid} role=${role} exec=${process.execPath}`);

	const describe = (name, args) => {
		try {
			const a0 = args[0];
			let target;
			if (name === 'writeSync' || name === 'writevSync' || name === 'fsyncSync' || name === 'fdatasyncSync') {
				target = `fd=${String(a0)}`;
			} else if (name === 'copyFileSync') {
				target = `src=${String(a0)} dest=${String(args[1])}`;
			} else {
				target = `path=${String(a0)}`;
			}
			const data = args[1];
			let bytes = '';
			if (data != null) {
				if (typeof data === 'string') { bytes = ` len=${data.length}`; }
				else if (typeof data === 'object' && typeof data.length === 'number') { bytes = ` len=${data.length}`; }
				else if (typeof data === 'object' && typeof data.byteLength === 'number') { bytes = ` len=${data.byteLength}`; }
			}
			return `${target}${bytes}`;
		} catch { return ''; }
	};

	for (const name of WATCH) {
		const fn = original[name];
		if (!fn) { continue; }
		fs[name] = function (...args) {
			let info = '';
			let stack = '';
			try {
				info = describe(name, args);
				stack = (new Error('syncwrite')).stack || '';
			} catch { /* ignore */ }
			writeLog(`BEGIN ${name} ${info}\nSTACK ${stack}`);
			const t0 = Date.now();
			try {
				const r = fn.apply(this, args);
				const dt = Date.now() - t0;
				writeLog(dt >= slowMs ? `SLOW ${name} ${info} took=${dt}ms` : `END ${name} took=${dt}ms`);
				return r;
			} catch (err) {
				writeLog(`THROW ${name} ${info} took=${Date.now() - t0}ms err=${err && err.message}`);
				throw err;
			}
		};
	}
}
