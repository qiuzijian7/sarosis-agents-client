/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 集成测试：真实拉起 dsh Host（P1 骨架的主路径），不走 Electron。
 *
 * 需要一个已安装的 dsh 运行时：默认使用 P0 原型的托管目录 `poc/dsh-p0/.runtime`，
 * 可用环境变量 DSH_TEST_RUNTIME_ROOT 指定其他托管根。没有运行时则整组跳过（不算失败）。
 * 每次运行使用临时 DSH_HOME 与临时运行目录，结束后删除，不触碰用户的 ~/.dsh。
 */

import assert from 'assert';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { DshHostSupervisor, redactSecrets } from '../../electron-main/dshHostSupervisor.js';
import { DshRuntimeManager } from '../../electron-main/dshRuntimeManager.js';
import { DshIdeRequestGate } from '../../electron-main/dshIdeRequestGate.js';
import { DshBridgeMethod, IBridgeWorkspace } from '../../common/dshBridgeProtocol.js';
import { readCapabilityDeclarations } from '../../common/dshIdeAuthorization.js';

const REPO = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();
const RUNTIME_ROOT = process.env.DSH_TEST_RUNTIME_ROOT ?? join(REPO, 'poc', 'dsh-p0', '.runtime');
const BRIDGE_DIR = join(REPO, 'dsh-plugins', 'vssaros-bridge');
const hasRuntime = existsSync(RUNTIME_ROOT) && new DshRuntimeManager(RUNTIME_ROOT, () => { }).listInstalled().length > 0;

(hasRuntime ? suite : suite.skip)('dshHarness / Host supervisor (integration)', function () {
	this.timeout(240_000);

	let home: string;
	let runDir: string;
	let supervisor: DshHostSupervisor;
	const lines: string[] = [];

	setup(() => {
		// `realpathSync.native` 归一（与升级门套件同因，见那里的长注释）：`tmpdir()` 在 Windows 上返回
		// 8.3 短名，与 pnpm 虚拟存储的字符串比较混用会报 `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`（伴生包装不上）。
		// ★ 必须是 `.native`：普通 `realpathSync` **不展开**短名，等于没归一。
		home = realpathSync.native(mkdtempSync(join(tmpdir(), 'vssaros-dsh-home-')));
		runDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'vssaros-dsh-run-')));
		supervisor = new DshHostSupervisor({
			runtime: new DshRuntimeManager(RUNTIME_ROOT, l => lines.push(l)),
			runDir,
			foundationPluginDir: undefined,
			bridgePluginDir: BRIDGE_DIR,
			chatSurfacePluginDir: undefined,
			modulePluginDirs: [],
			defaultDshHome: home,
			instanceId: 'test',
			log: l => lines.push(l),
		});
	});

	teardown(async () => {
		await supervisor.stop();
		supervisor.dispose();
		rmSync(home, { recursive: true, force: true });
		rmSync(runDir, { recursive: true, force: true });
	});

	test('cold start: creates profile, installs companion plugin, handshakes, serves the page', async () => {
		const states: string[] = [];
		supervisor.onDidChangeStatus(s => states.push(s.state));
		const s = await supervisor.start();
		assert.strictEqual(s.state, 'running', `error: ${s.error}\n${lines.slice(-15).join('\n')}`);
		assert.strictEqual(s.bridge, 'connected', `bridge should handshake when the plugin is bundled\n${supervisor.getLog().slice(-25).join('\n')}`);
		assert.deepStrictEqual(states.slice(0, 2), ['starting', 'running']);

		const pkg = JSON.parse(readFileSync(join(home, 'profiles', 'vssaros', 'package.json'), 'utf8'));
		assert.ok(pkg.dsh.profile.bundles.includes('@vssaros/dsh-bridge'), 'plugin added to bundles by dsh plugin add');

		const conn = supervisor.connection!;
		const r = await fetch(conn.authUrl, { redirect: 'manual' });
		assert.strictEqual(r.status, 303);
		const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
		const html = await (await fetch(conn.origin + '/', { headers: { cookie } })).text();
		assert.ok(html.includes('__DSH_BOOT__'));
		assert.ok(html.includes('@vssaros/dsh-bridge'), 'companion client half is in the boot graph');

		// 反向通道（协议 v2）：**两个真实实现**之间的往返——Host 的 bridge 反向调 IDE 侧客户端，
		// 客户端的 `ide.echo` 是内建的（不依赖任何能力接线）⇒ 这条断言证明反向通道在真机组件间通。
		// （P3-12 探针证明的是 Host 那一半 + 假 IDE；这条补上"真客户端应答"。）
		const roundtrip = await supervisor.bridge!.call<{ ok?: boolean; instanceId?: string; echo?: { at?: number; token?: unknown }; error?: string }>(DshBridgeMethod.IdeRoundtrip, { timeoutMs: 8000 });
		assert.strictEqual(roundtrip.ok, true, `反向通道应打通：${JSON.stringify(roundtrip)}\n${supervisor.getLog().slice(-15).join('\n')}`);
		assert.strictEqual(roundtrip.instanceId, 'test', '回执应带上注册时声明的实例 id');
		assert.strictEqual(typeof roundtrip.echo?.at, 'number', 'IDE 侧应原样回显入参');
		assert.ok(roundtrip.echo?.token !== undefined, '反向请求应带令牌（IDE 侧据此核验）');

		// `ide.request` 那条链（Host 侧自检 `ide.probe` 走的正是它）。三段覆盖"挡在哪儿、以及能通"：
		// ① 能力名不在清单白名单 → **客户端**就挡下（-32601）。
		//    样本用 `teleport`：`mindmap` / `unreal` 自 v1.2.12 起已在白名单（13.3 缺口已关），
		//    拿它们当反例会走到"未声明能力"那条（曾因此让三条用例一起红）。
		const badCapability = await supervisor.bridge!.call<{ ok?: boolean; error?: string }>(DshBridgeMethod.IdeProbe, { capability: 'teleport', pluginId: '@vssaros/dsh-ide' }, 10_000);
		assert.strictEqual(badCapability.ok, false, JSON.stringify(badCapability));
		assert.match(String(badCapability.error), /未知的 IDE 能力：teleport/);
		// ② 合法能力名但 IDE 侧没处理器（本测试里没有 electron 主进程通道）→ **明确报错**，不静默挂起
		const noHandler = await supervisor.bridge!.call<{ ok?: boolean; error?: string }>(DshBridgeMethod.IdeProbe, { capability: 'getDiagnostics', pluginId: '@vssaros/dsh-ide', timeoutMs: 3000 }, 10_000);
		assert.strictEqual(noHandler.ok, false, JSON.stringify(noHandler));
		assert.match(String(noHandler.error), /未注册反向处理器/);
		// ③ 接上**真闸门**（真读 profile 清单 → 真授权 → 真分发）→ 整条 Host → IDE → Host 走通。
		//    为了让它"能放行"，先在 profile 里造一个**声明了能力**的插件（清单 + node_modules 实装）。
		//    这是 `@vssaros/dsh-ide` 落地前的等价替身：闸门读的东西与真实安装一模一样。
		const profileDir = supervisor.profileDirectory();
		const profilePkgPath = join(profileDir, 'package.json');
		const originalProfilePkg = readFileSync(profilePkgPath, 'utf8');
		const declaredCapability = 'getDiagnostics';
		let dispatchCount = 0;
		try {
			const pkg = JSON.parse(originalProfilePkg);
			pkg.dependencies = { ...pkg.dependencies, '@vssaros/dsh-test-ide': 'file:./test-ide', '@vssaros/dsh-test-nocap': 'file:./test-nocap' };
			writeFileSync(profilePkgPath, JSON.stringify(pkg, undefined, 2));
			const testIdeDir = join(profileDir, 'node_modules', '@vssaros', 'dsh-test-ide');
			mkdirSync(testIdeDir, { recursive: true });
			writeFileSync(join(testIdeDir, 'package.json'), JSON.stringify({
				name: '@vssaros/dsh-test-ide', version: '0.0.1',
				// 与真实模块同一份清单口径
				vssaros: { manifestVersion: 1, module: 'ide', ideCapabilities: [declaredCapability] },
			}));
			// 第二个替身：**有清单但不声明该能力**（用来验"装了 ≠ 能调"这条，且拒绝原因要列出它声明了什么）。
			// 注意不能拿伴生桥插件来验这条——它是经 bundles 装的，不在 `dependencies` 里（`listPlugins` 读不到）。
			const nocapDir = join(profileDir, 'node_modules', '@vssaros', 'dsh-test-nocap');
			mkdirSync(nocapDir, { recursive: true });
			writeFileSync(join(nocapDir, 'package.json'), JSON.stringify({
				name: '@vssaros/dsh-test-nocap', version: '0.0.1',
				vssaros: { manifestVersion: 1, module: 'ide', ideCapabilities: ['openFile'] },
			}));
			const gate = new DshIdeRequestGate({
				readDeclarations: () => readCapabilityDeclarations(new Map(supervisor.listPlugins().map(p => [
					p.name,
					JSON.parse(readFileSync(join(profileDir, 'node_modules', ...p.name.split('/'), 'package.json'), 'utf8')),
				]))),
				dispatch: request => {
					dispatchCount++;
					return Promise.resolve({ capability: request.capability, pluginId: request.pluginId, via: 'real-gate' });
				},
				log: () => undefined,
			});
			supervisor.bridge!.setReverseRequestHandler(request => gate.handle(request));

			// (a) 声明过该能力的插件 ⇒ 放行 + 分发（参数带上 pluginId，说明"谁在问"要一路带着）
			const allowed = await supervisor.bridge!.call<{ capability?: string; pluginId?: string; via?: string }>(DshBridgeMethod.IdeProbe, { capability: declaredCapability, pluginId: '@vssaros/dsh-test-ide', params: { path: 'a.ts' } }, 10_000);
			assert.strictEqual(allowed.via, 'real-gate', JSON.stringify(allowed));
			assert.strictEqual(allowed.capability, declaredCapability);
			assert.strictEqual(allowed.pluginId, '@vssaros/dsh-test-ide');
			assert.strictEqual(dispatchCount, 1);

			// (b) **装了但没声明该能力** ⇒ 拒，原因里列出它实际声明了什么，且**没进分发**
			const refused = await supervisor.bridge!.call<{ ok?: boolean; error?: string }>(DshBridgeMethod.IdeProbe, { capability: declaredCapability, pluginId: '@vssaros/dsh-test-nocap' }, 10_000);
			assert.strictEqual(refused.ok, false, JSON.stringify(refused));
			assert.match(String(refused.error), /未声明能力 getDiagnostics/, String(refused.error));
			assert.match(String(refused.error), /已声明：openFile/, '拒绝原因要能指出该插件实际声明了什么');
			assert.strictEqual(dispatchCount, 1, '被拒的请求不该进分发');

			// (c) 没装的插件 ⇒ 拒（"逐插件授权"必须能区分"没装"与"装了没声明"）
			const notInstalled = await supervisor.bridge!.call<{ ok?: boolean; error?: string }>(DshBridgeMethod.IdeProbe, { capability: 'getSelection', pluginId: '@vssaros/dsh-not-installed' }, 10_000);
			assert.strictEqual(notInstalled.ok, false, JSON.stringify(notInstalled));
			assert.match(String(notInstalled.error), /未安装或没有可读清单/);
		} finally {
			// 处理器留着会影响同一 Host 的后续断言；profile 清单也要还原（后面的"重启复用 profile"用例要用）
			supervisor.bridge!.setReverseRequestHandler(undefined);
			writeFileSync(profilePkgPath, originalProfilePkg);
			rmSync(join(profileDir, 'node_modules', '@vssaros', 'dsh-test-ide'), { recursive: true, force: true });
			rmSync(join(profileDir, 'node_modules', '@vssaros', 'dsh-test-nocap'), { recursive: true, force: true });
		}

		const ws = await supervisor.bridge!.call<IBridgeWorkspace[]>(DshBridgeMethod.WorkspaceEnsure, { paths: [home] });
		assert.ok(ws[0]?.id, JSON.stringify(ws));

		// Upgrade gate input: no sessions loaded → nothing running.
		const activity = await supervisor.getActivity();
		assert.deepStrictEqual(activity, { live: 0, sessions: [] });

		const health = await supervisor.healthCheck();
		assert.ok(health.ok, JSON.stringify(health.checks));
		assert.deepStrictEqual(health.checks.map(c => c.name), ['host running', 'bridge handshake', 'auth exchange', 'page boot graph', 'companion client in boot graph']);

		assert.ok(!supervisor.getLog().some(l => /token=(?!<redacted>)/.test(l)), 'tokens never reach the log');
	});

	test('stop terminates the Host and a second start reuses the profile', async () => {
		const first = await supervisor.start();
		assert.strictEqual(first.state, 'running', first.error);
		const pid = first.pid!;
		await supervisor.stop();
		assert.strictEqual(supervisor.status.state, 'stopped');
		assert.throws(() => process.kill(pid, 0), 'Host process is gone after stop');

		const mark = supervisor.getLog().length;
		const second = await supervisor.start();
		assert.strictEqual(second.state, 'running', second.error);
		const afterSecond = supervisor.getLog().slice(mark);
		assert.ok(!afterSecond.some(l => l.includes('creating profile')), 'profile is reused');
		assert.ok(!afterSecond.some(l => l.includes('installing @vssaros/dsh-bridge')), 'plugin is not reinstalled when versions match');
		assert.ok(second.startupMs! < first.startupMs!, `warm start (${second.startupMs} ms) faster than cold (${first.startupMs} ms)`);
	});

	test('concurrent start calls share one Host', async () => {
		const [a, b] = await Promise.all([supervisor.start(), supervisor.start()]);
		assert.strictEqual(a.pid, b.pid);
	});

	test('without the bundled plugin the Host still runs on the URL-line fallback', async () => {
		supervisor.dispose();
		supervisor = new DshHostSupervisor({
			runtime: new DshRuntimeManager(RUNTIME_ROOT, () => { }),
			runDir,
			foundationPluginDir: undefined,
			bridgePluginDir: undefined,
			chatSurfacePluginDir: undefined,
			modulePluginDirs: [],
			defaultDshHome: home,
			instanceId: 'test',
			log: l => lines.push(l),
		});
		const s = await supervisor.start();
		assert.strictEqual(s.state, 'running', s.error);
		assert.strictEqual(s.bridge, 'fallback');
		const r = await fetch(supervisor.connection!.authUrl, { redirect: 'manual' });
		assert.strictEqual(r.status, 303);
	});

	test('a broken runtime path surfaces as an error state, not an exception', async () => {
		const s = await supervisor.start({ runtimePath: join(runDir, 'nope') });
		assert.strictEqual(s.state, 'error');
		assert.match(s.error ?? '', /runtimePath/);
	});

	/**
	 * ★ 回归守卫（2026-10-11）：**未归一的 8.3 短名 `DSH_HOME`** 必须被 supervisor 归一到长名。
	 *
	 * 现场：`TEMP` / `userData` 在 Windows 上常给短名（`C:\Users\QIUZIJ~1\…`），而 pnpm 判断"虚拟店位置
	 * 是否一致"是**字符串比较**、它内部按**长名**算 ⇒ 记录的是短名就等于"位置不符" ⇒
	 * `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE` ⇒ 伴生包（含**必装**的 `@deepseek-ai/dsh-web-app`，它提供
	 * `webStartup`）装不上 ⇒ 需要这些服务的插件全部 pending ⇒ `StartupError: … required plugins did not
	 * activate` ⇒ **Host 退出 code 1**（升级门那 4 条红的真因，见 poc README 4.83）。
	 *
	 * 这条把"修好了"钉在**产物**上：状态里的 `dshHome` 与 profile 的 `.modules.yaml` 里都不该再有 `~1` 段。
	 */
	test('★ 8.3 短名的 DSH_HOME 被归一到长名（否则伴生包装不上 ⇒ Host code 1）', async () => {
		// 故意**不**归一：`mkdtempSync(join(tmpdir(), …))` 在本机拿到的就是短名——正是那个现场。
		const shortRoot = mkdtempSync(join(tmpdir(), 'vssaros-short-home-'));
		const rawHome = join(shortRoot, 'dsh-home');
		const sup = new DshHostSupervisor({
			runtime: new DshRuntimeManager(RUNTIME_ROOT, l => lines.push(l)),
			runDir: join(shortRoot, 'run'),
			foundationPluginDir: undefined,
			bridgePluginDir: BRIDGE_DIR,
			chatSurfacePluginDir: undefined,
			modulePluginDirs: [],
			defaultDshHome: rawHome,
			instanceId: 'short-name-test',
			log: l => lines.push(l),
		});
		try {
			const s = await sup.start();
			assert.strictEqual(s.state, 'running', `${s.error}\n${lines.slice(-15).join('\n')}`);
			assert.strictEqual(s.bridge, 'connected', `伴生插件应装上并握手：\n${sup.getLog().slice(-25).join('\n')}`);
			assert.ok(!/~\d/.test(s.dshHome ?? ''), `状态里的 dshHome 应是长名：${s.dshHome}`);
			const modules = join(rawHome, 'profiles', 'vssaros', 'node_modules', '.modules.yaml');
			assert.ok(existsSync(modules), 'pnpm 元数据应存在（装过插件）');
			const virt = /^virtualStoreDir:[ \t]*(.+)$/m.exec(readFileSync(modules, 'utf8'))?.[1]?.trim() ?? '';
			assert.ok(virt.length > 0, `.modules.yaml 里应有 virtualStoreDir：${virt}`);
			assert.ok(!/~\d/.test(virt), `virtualStoreDir 必须是长名（pnpm 按长名比较）：${virt}`);
			// 伴生包**真的**装上了（不是"报错然后继续"）。
			assert.ok(existsSync(join(rawHome, 'profiles', 'vssaros', 'node_modules', '@vssaros', 'dsh-bridge', 'package.json')), 'bridge 应已装进该 profile');
		} finally {
			await sup.stop();
			sup.dispose();
			rmSync(shortRoot, { recursive: true, force: true });
		}
	});

	/**
	 * ★ 随包模块插件一键安装（2026-10-11）：`installBundledPlugin` 必须把包**真的**装进 profile。
	 *
	 * 为什么要有这条：插件中心「随包模块」段的安装按钮走的就是它。它**不能**复用商城的 spec 安装
	 * （那条在 Host 内跑 `file:<路径>`，仓库与 profile 跨盘符时必失败），所以走主进程：暂存到 profile
	 * 再 `dsh plugin add`——与启动时装伴生插件同一条路。同时钉住**幂等**：同版本重装必须 `changed=false`。
	 */
	test('★ 随包模块插件：installBundledPlugin 真的装进 profile，且同版本重装是 no-op', async () => {
		const dir = join(REPO, 'dsh-plugins', 'vssaros-kanban');
		const bundled = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version: string };
		const first = await supervisor.installBundledPlugin(bundled.name, dir);
		assert.strictEqual(first.ok, true, `${first.error}\n${supervisor.getLog().slice(-20).join('\n')}`);
		assert.strictEqual(first.version, bundled.version);
		assert.strictEqual(first.changed, true, '首次安装应当有变化');
		// profile 里真的在（不是"报了个错然后继续"）
		const installed = join(home, 'profiles', 'vssaros', 'node_modules', ...bundled.name.split('/'), 'package.json');
		assert.ok(existsSync(installed), `应装进 profile：${installed}`);
		assert.strictEqual((JSON.parse(readFileSync(installed, 'utf8')) as { version: string }).version, bundled.version);

		const second = await supervisor.installBundledPlugin(bundled.name, dir);
		assert.strictEqual(second.ok, true, `${second.error}`);
		assert.strictEqual(second.changed, false, '同版本重装不该产生变化（幂等）');
	});

	/**
	 * ★★ **同版本、改了内容 ⇒ 必须真的换上新代码**（2026-10-14 用户报"首次启动很慢"查出来的根因）。
	 *
	 * 现场（真机取证）：`@vssaros/dsh-bridge` 版本恒为 0.2.20、入口内容改过 ⇒ 暂存目录按**版本号**命名
	 * ⇒ spec 路径逐字不变 ⇒ pnpm 把这条 `file:` 依赖当成"没变化"、**一个字节都不替换** ⇒ 判定阶段
	 * 每次启动都判"不一致 ⇒ 强制重装"、而每次重装都无效（`node_modules` 里那份的 CreationTime 停在
	 * 两天前，同一批装的 kb 是本次）⇒ ① 每次启动白花一次 pnpm（8.5 s）② `_pluginsStale` 被置上 ⇒
	 * 放弃复用常驻 Host（冷启动 ~12 s + 回收旧 Host 1.8 s）③ 跑的一直是旧代码，日志却写 `N ok`。
	 *
	 * 这条用例**不用起 App、不用网络**（真 profile + 真 pnpm + 真 Host，约 1 分钟），把三件事一起钉住：
	 *   1. 判定阶段**看见**了内容不一致（`已装副本与随包不一致`）；
	 *   2. 装完以后**产物真的换了**（已装入口内容 = 新内容；且暂存目录换了名字 ⇒ 同版本两个目录并存）；
	 *   3. 第三次启动**不再重装**（修复前是"每次启动都重装一次、每次都无效"的永久循环 ✗）。
	 *
	 * 反例形态（修复前的行为）：第 2 步的产物断言会红 —— 已装内容仍是 A，而 pnpm 报 `4 ok`。
	 */
	test('★ 同版本改了内容：强制重装必须真的换上（指纹进暂存目录名），且之后再启动不再重装', async function () {
		this.timeout(300_000);
		const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'vssaros-stage-fingerprint-')));
		const home = join(root, 'dsh-home');
		const runDir = join(root, 'run');
		/**
		 * **可写的随包插件副本**（版本号由它的 package.json 决定，全程不动）：改内容要真的改在"随包那侧"，
		 * 直接改仓库里的插件会把工作区弄脏 ✗。
		 */
		const src = join(root, 'vssaros-bridge');
		cpSync(BRIDGE_DIR, src, {
			recursive: true,
			filter: p => !/[\\/]node_modules([\\/]|$)/.test(p.slice(BRIDGE_DIR.length)),
		});
		const profileDir = join(home, 'profiles', 'vssaros');
		/** 已装副本的入口内容（按它自己的 package.json 的 main 找 —— 与监督器同一口径）。 */
		const installedEntry = (): string => {
			const dir = join(profileDir, 'node_modules', '@vssaros', 'dsh-bridge');
			const main = String((JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { main?: string }).main ?? 'lib/index.js').replace(/^\.\//, '');
			return readFileSync(join(dir, main), 'utf8');
		};
		const stagedDirsOfSameVersion = (): string[] => {
			const version = String((JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')) as { version: string }).version);
			const plugins = join(profileDir, '.vssaros', 'plugins');
			return existsSync(plugins) ? readdirSync(plugins).filter(n => n.startsWith(`vssaros-dsh-bridge-${version}`)) : [];
		};
		const startFresh = async (): Promise<{ sup: DshHostSupervisor; log: string }> => {
			const lines: string[] = [];
			const sup = new DshHostSupervisor({
				runtime: new DshRuntimeManager(RUNTIME_ROOT, l => lines.push(l)),
				runDir, foundationPluginDir: undefined,
			bridgePluginDir: src, chatSurfacePluginDir: undefined, modulePluginDirs: [],
				defaultDshHome: home, instanceId: 'stage-fingerprint', log: l => lines.push(l),
			});
			try {
				const s = await sup.start();
				assert.strictEqual(s.state, 'running', `${s.error}\n${lines.slice(-15).join('\n')}`);
				return { sup, log: lines.join('\n') };
			} catch (e) {
				await sup.stop();
				sup.dispose();
				throw e;
			}
		};
		let running: { sup: DshHostSupervisor; log: string } | undefined;
		try {
			running = await startFresh();
			const contentA = installedEntry();
			assert.ok(contentA.length > 0, '第一次启动后应装有 bridge');
			assert.strictEqual(stagedDirsOfSameVersion().length, 1,
				`暂存目录应恰好一份：${stagedDirsOfSameVersion().join(', ')}`);
			await running.sup.stop();
			running.sup.dispose();
			running = undefined;

			// 改**内容**、**不**改版本 —— 这正是 pnpm 会把它当成 no-op 的那一步。
			const entryFile = join(src, 'lib', 'index.js');
			appendFileSync(entryFile, '\n// vssaros-test: content B (same version, different bytes)\n');
			const contentB = readFileSync(entryFile, 'utf8');
			assert.notStrictEqual(contentB, contentA, '这次改动必须真的改变了入口内容（否则用例会假绿）');

			running = await startFresh();
			assert.ok(running.log.includes('已装副本与随包不一致'),
				`判定阶段必须看见"内容变了、版本没变"：\n${running.log.slice(-30)}`);
			assert.strictEqual(installedEntry(), contentB,
				'★ 强制重装必须换上**新内容**：pnpm 对同路径 file: 依赖会静默 no-op ⇒ 只有暂存目录换名字才真装得上');
			assert.ok(!running.log.includes('同版本重装后入口内容仍与随包不一致'),
				`不该再出现"装了却没换上"的告警（出现即说明指纹没起作用）：\n${running.log.slice(-30)}`);
			assert.strictEqual(stagedDirsOfSameVersion().length, 2,
				`同版本两份内容 ⇒ 暂存目录应有两条（旧的留给回滚）：${stagedDirsOfSameVersion().join(', ')}`);
			await running.sup.stop();
			running.sup.dispose();
			running = undefined;

			// 第三次：什么都没改 ⇒ **不该再重装**（修复前这里是"每次启动都重装一次、永远修不好"的循环）。
			running = await startFresh();
			assert.ok(!running.log.includes('已装副本与随包不一致'),
				`已装副本与随包一致时不该再判"强制重装"（循环终结）：\n${running.log.slice(-30)}`);
			assert.ok(!running.log.includes('installing @vssaros/dsh-bridge'),
				`不该再装一遍（这一步就是用户看到的"首次启动很慢"里白花的那 8 秒）：\n${running.log.slice(-30)}`);
		} finally {
			await running?.sup.stop();
			running?.sup.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

suite('dshHarness / redaction', () => {
	test('redactSecrets hides launch tokens', () => {
		assert.strictEqual(redactSecrets('dsh web: http://127.0.0.1:1/?token=abc-DEF_1 ok'), 'dsh web: http://127.0.0.1:1/?token=<redacted> ok');
		assert.strictEqual(redactSecrets('a?x=1&token=zz'), 'a?x=1&token=<redacted>');
	});
});
