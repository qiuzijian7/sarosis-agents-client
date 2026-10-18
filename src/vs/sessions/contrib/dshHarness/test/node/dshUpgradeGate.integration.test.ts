/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 升级闸门 × 真实 Host：托管根是临时目录，版本目录用 junction 指向 P0 原型已安装的运行时
 * （不改原型目录的 state.json），另放一个"坏版本" 9.9.9（`--version` 正常、启动即退出）来触发自动回退。
 * 需要 `poc/dsh-p0/.runtime` 下至少有 0.2.0-rc.2 与 0.2.1-alpha.1，否则跳过。
 */

import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { DshHostSupervisor } from '../../electron-main/dshHostSupervisor.js';
import { DshRuntimeManager } from '../../electron-main/dshRuntimeManager.js';
import { DshUpgradeGate } from '../../electron-main/dshUpgradeGate.js';

const REPO = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();
const SRC_ROOT = process.env.DSH_TEST_RUNTIME_ROOT ?? join(REPO, 'poc', 'dsh-p0', '.runtime');
const BRIDGE_DIR = join(REPO, 'dsh-plugins', 'vssaros-bridge');
const A = '0.2.0-rc.2';
const B = '0.2.1-alpha.1';
/** 最老的受支持版本：伴生插件的依赖（含 `agents`）必须在这里也能激活。可选。 */
const OLD = '0.1.7-rc.2';
const BIN = ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'];
const available = [A, B].every(v => existsSync(join(SRC_ROOT, v, ...BIN)));
const hasOld = existsSync(join(SRC_ROOT, OLD, ...BIN));

(available ? suite : suite.skip)('dshHarness / upgrade gate (integration)', function () {
	this.timeout(300_000);

	let root: string;
	let home: string;
	let runtime: DshRuntimeManager;
	let supervisor: DshHostSupervisor;
	let gate: DshUpgradeGate;
	const log: string[] = [];

	suiteSetup(async () => {
		// ⚠ 必须用 **`realpathSync.native`** 归一（**在本套件里是硬前提**）：`tmpdir()` 在 Windows 上走
		// `GetTempPath`，返回 **8.3 短名**（`C:\Users\QIUZIJ~1\…`）。pnpm 的虚拟存储一致性是**字符串
		// 比较**，两种写法混用即 `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`。
		//
		// ★ 实测教训（2026-10-11）：**`fs.realpathSync` 不展开 8.3 短名**（它照原样返回短名），只有
		// `fs.realpathSync.native` 才返回长名 —— 本机验证：
		//     realpathSync(短名)        → C:\Users\QIUZIJ~1\…
		//     realpathSync.native(短名) → C:\Users\qiuzijian\…
		// 第一次只改成了 `realpathSync`，4 条红**一条没少**（日志里 `virtualStoreDir` 仍是短名）。
		//
		// 为什么本套件一踩就全红：切换运行时（A → B）时伴生包要跟着升级，其中 `@deepseek-ai/dsh-web-app`
		// 是**必装**的那个——它提供 `webStartup`，而新运行时的 `webserver` 是 required 插件。装不上的
		// 后果链：pnpm 报虚拟存储不一致 ⇒ 新版 web-app 没装上 ⇒ 旧版 `@deepseek-ai/dsh-web-app@0.2.0-rc.2`
		// 被 dsh 判为与 0.2.1-alpha.1 不兼容而**禁用**（日志：`disabling profile plugin row "web-startup": …
		// peerDependencies {"@deepseek-ai/dsh-shell-env":"0.2.0-rc.2"…}`）⇒ `webserver (required) missing:
		// webStartup` ⇒ `StartupError: 2 required plugins did not activate` ⇒ **Host 退出 code 1**。
		root = realpathSync.native(mkdtempSync(join(tmpdir(), 'vssaros-dsh-gate-')));
		home = join(root, 'dsh-home');
		const managed = join(root, 'runtime');
		mkdirSync(managed, { recursive: true });
		for (const v of hasOld ? [A, B, OLD] : [A, B]) {
			symlinkSync(join(SRC_ROOT, v), join(managed, v), 'junction');
		}
		// Broken runtime: reports its version, then refuses to start.
		const broken = join(managed, '9.9.9', ...BIN.slice(0, -1));
		mkdirSync(broken, { recursive: true });
		writeFileSync(join(broken, 'bin.js'), 'if (process.argv.includes("--version")) { console.log("9.9.9"); process.exit(0); } console.error("broken runtime"); process.exit(3);\n');

		runtime = new DshRuntimeManager(managed, l => log.push(l));
		await runtime.setCurrent(A);
		supervisor = new DshHostSupervisor({
			runtime, runDir: join(root, 'run'), foundationPluginDir: undefined,
			bridgePluginDir: BRIDGE_DIR, chatSurfacePluginDir: undefined, modulePluginDirs: [], defaultDshHome: home, instanceId: 'gate-test', log: l => log.push(l),
		});
		gate = new DshUpgradeGate(supervisor, runtime, join(root, 'snapshots'), l => log.push(l));
		const s = await supervisor.start();
		assert.strictEqual(s.state, 'running', s.error);
		assert.strictEqual(s.dshVersion, A);
	});

	suiteTeardown(async () => {
		await supervisor?.stop();
		supervisor?.dispose();
		// Remove the junctions first so rmSync never follows them into the P0 runtimes.
		for (const v of [A, B, OLD]) {
			try {
				rmSync(join(root, 'runtime', v), { force: true });
			} catch { /* best effort */ }
		}
		rmSync(root, { recursive: true, force: true });
	});

	test(`${A} → ${B}: idle Host switches and passes the health check`, async () => {
		const r = await gate.upgrade({ version: B }, {});
		assert.strictEqual(r.outcome, 'switched', `${r.error}\n${log.slice(-12).join('\n')}`);
		assert.strictEqual(supervisor.status.dshVersion, B);
		assert.strictEqual(runtime.readState().current, B);
		assert.ok(r.health?.checks.every(c => c.ok), JSON.stringify(r.health));
		assert.ok(existsSync(join(r.snapshot!, 'data', 'profiles', 'vssaros', 'package.json')), 'profile snapshotted');
	});

	test(`${B} → 9.9.9 (broken): fails health, rolls back to ${B}, Host running again`, async () => {
		const profilePkg = join(home, 'profiles', 'vssaros', 'package.json');
		const before = readFileSync(profilePkg, 'utf8');
		const r = await gate.upgrade({ version: '9.9.9' }, {});
		assert.strictEqual(r.outcome, 'rolled-back', `${r.outcome}: ${r.error}`);
		assert.match(r.error ?? '', /host running/);
		assert.strictEqual(runtime.readState().current, B, 'pointer back');
		assert.strictEqual(supervisor.status.state, 'running');
		assert.strictEqual(supervisor.status.dshVersion, B);
		assert.strictEqual(readFileSync(profilePkg, 'utf8'), before, 'profile restored byte-for-byte');
		assert.ok((await supervisor.healthCheck()).ok, 'healthy after rollback');
	});

	(hasOld ? test : test.skip)(`${B} → ${OLD}: oldest supported version is healthy with the current companion plugin`, async () => {
		const r = await gate.upgrade({ version: OLD }, {});
		assert.strictEqual(r.outcome, 'switched', `${r.error}\n${log.slice(-12).join('\n')}`);
		assert.strictEqual(supervisor.status.dshVersion, OLD);
		assert.deepStrictEqual(await supervisor.getActivity(), { live: 0, sessions: [] }, 'host.activity works on the oldest version too');
	});

	test(`back to ${A}: downgrade through the same gate`, async () => {
		const r = await gate.upgrade({ version: A }, {});
		assert.strictEqual(r.outcome, 'switched', r.error);
		assert.strictEqual(supervisor.status.dshVersion, A);
		const history = runtime.readState().history;
		assert.deepStrictEqual(history.slice(-2), [hasOld ? OLD : B, A], 'history ends with the last two healthy versions');
		assert.ok(!history.includes('9.9.9'), 'the rolled-back attempt left no trace in the pointer history');
	});
});
