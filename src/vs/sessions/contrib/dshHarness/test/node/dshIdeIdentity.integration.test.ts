/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 集成测试：**反向通道的身份盖章**在真 Host 上是否真的成立（README 4.47 记的那条"仍未验证"）。
 *
 * 为什么必须真 Host：盖章用的权威身份是 `fiber.entry.options.name`（加载器那一行的 specifier = 包名），
 * 而 `fiber.entry` **只有 loader 托管的纤维才有**——单独跑 cordis 探针（`scripts/cordis-caller-probe.mjs`）
 * 只能证明"方法里 `this.ctx` 是调用方 ctx"，证明不了这一格在真装载路径上非空。
 *
 * 本用例装**两个**会自己发起 `ide.request` 的假插件（经 `modulePluginDirs` 真装、真装载）：
 *  ① `@vssaros/dsh-test-honest`：自报**自己的包名** ⇒ 应当被盖章成同一身份、正常放行；
 *  ② `@vssaros/dsh-test-forger`：自报**①的包名**（①已安装且声明了该能力，所以 IDE 侧闸门本身会放行）
 *     ⇒ 若盖章没生效，这条会**冒充成功**并到达闸门；若生效，桥就地在 Host 侧拒绝它。
 *
 * 于是三条断言各自钉一件事：
 *  - 闸门收到的 `pluginId` 恒等于 ① 的包名（**盖章真的解析到了包名**，不是模块导出的短名）；
 *  - 只有**一次**分发（冒名那次根本没到，且没被重复执行）；
 *  - Host 日志里有桥的拒绝文案（"实际是 …"）⇒ 冒名是被**主动拒绝**，不是碰巧没发出去。
 *
 * 没有已安装运行时则整组跳过（不算失败）。
 */

import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { DshHostSupervisor } from '../../electron-main/dshHostSupervisor.js';
import { DshRuntimeManager } from '../../electron-main/dshRuntimeManager.js';
import { DshIdeRequestGate } from '../../electron-main/dshIdeRequestGate.js';
import { readCapabilityDeclarations } from '../../common/dshIdeAuthorization.js';

const REPO = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();
const RUNTIME_ROOT = process.env.DSH_TEST_RUNTIME_ROOT ?? join(REPO, 'poc', 'dsh-p0', '.runtime');
const BRIDGE_DIR = join(REPO, 'dsh-plugins', 'vssaros-bridge');
const hasRuntime = existsSync(RUNTIME_ROOT) && new DshRuntimeManager(RUNTIME_ROOT, () => { }).listInstalled().length > 0;

/** 两个假插件用同一个能力：`getDiagnostics`（只读，不涉及确认闸，测试无需用户在场）。 */
const CAPABILITY = 'getDiagnostics';
const HONEST = '@vssaros/dsh-test-honest';
const FORGER = '@vssaros/dsh-test-forger';

interface IFakePlugin { readonly name: string; readonly claimedPluginId: string; readonly dir: string }

/**
 * 写一个"会自己发起 `ide.request`"的假插件包。
 *
 * 触发方式：**反复重试**直到桥可用（IDE 客户端是在 Host 起来之后才注册的，apply 那一刻还没有客户端），
 * 成功即停。这样用例不必依赖任何额外触发面（HTTP 路由等）。
 */
function writeFakePlugin(root: string, name: string, claimedPluginId: string): string {
	const dir = join(root, name.replace(/[@/]/g, '_'));
	mkdirSync(join(dir, 'lib'), { recursive: true });
	writeFileSync(join(dir, 'package.json'), JSON.stringify({
		name,
		version: '0.0.1',
		private: true,
		type: 'module',
		main: 'lib/index.js',
		// 真装载路径：与我们的模块插件同一套（`dsh plugin add` 会应用这个 patch）
		dsh: { bundle: { patch: ['./cordis.patch.yml'] } },
		// 清单口径与真实模块一致（IDE 侧闸门就是读这个字段）
		vssaros: { manifestVersion: 1, module: 'ide', ideCapabilities: [CAPABILITY] },
	}, undefined, 2));
	writeFileSync(join(dir, 'cordis.patch.yml'), [
		'# 测试用假插件：插进组合（loader 会记下这一行的 name ⇒ 桥盖章用的就是它）',
		'- insert:',
		`    - id: ${name.replace(/[@/]/g, '-')}`,
		`      name: '${name}'`,
		'      config: {}',
		'',
	].join('\n'));
	writeFileSync(join(dir, 'lib/index.js'), [
		`export const name = ${JSON.stringify(name.replace(/^@[^/]+\//, ''))};`,
		`export const inject = ['vssarosBridge'];`,
		'',
		'// 反复尝试直到桥上有 IDE 客户端；成功后停。',
		'export function apply(ctx) {',
		`\tconst claimed = ${JSON.stringify(claimedPluginId)};`,
		'\tlet tries = 0;',
		'\tconst attempt = async () => {',
		'\t\ttry {',
		`\t\t\tconst reply = await ctx.vssarosBridge.callIDE('ide.request', { capability: ${JSON.stringify(CAPABILITY)}, pluginId: claimed }, { timeoutMs: 5000 });`,
		`\t\t\tconsole.error('[fake-plugin ${name}] 已放行：' + JSON.stringify(reply));`,
		'\t\t} catch (e) {',
		`\t\t\tconsole.error('[fake-plugin ${name}] 被拒：' + String((e && e.message) || e));`,
		'\t\t\treturn false;',
		'\t\t}',
		'\t\treturn true;',
		'\t};',
		'\tconst timer = setInterval(async () => {',
		'\t\ttries++;',
		'\t\tif (await attempt() || tries > 120) clearInterval(timer);',
		'\t}, 500);',
		'\tctx.effect(() => () => clearInterval(timer));',
		'}',
		'',
	].join('\n'));
	return dir;
}

(hasRuntime ? suite : suite.skip)('dshHarness / IDE capability identity (integration)', function () {
	this.timeout(300_000);

	let home: string;
	let runDir: string;
	let pluginRoot: string;
	let supervisor: DshHostSupervisor;
	const lines: string[] = [];
	const dispatched: { capability: string; pluginId: string }[] = [];
	let fakePlugins: IFakePlugin[] = [];

	setup(() => {
		// `realpathSync.native` 归一（Windows 8.3 短名会让 pnpm 虚拟存储字符串比较失败，见同目录另一用例）
		home = realpathSync.native(mkdtempSync(join(tmpdir(), 'vssaros-dsh-home-')));
		runDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'vssaros-dsh-run-')));
		pluginRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'vssaros-dsh-fake-')));
		dispatched.length = 0;
		fakePlugins = [
			{ name: HONEST, claimedPluginId: HONEST, dir: writeFakePlugin(pluginRoot, HONEST, HONEST) },
			{ name: FORGER, claimedPluginId: HONEST, dir: writeFakePlugin(pluginRoot, FORGER, HONEST) },
		];
		// 闸门：与生产同形（真读 profile 清单 → 真授权），但分发只记录、不碰 IDE。
		const gate = new DshIdeRequestGate({
			readDeclarations: () => {
				const profileDir = supervisor.profileDirectory();
				return readCapabilityDeclarations(new Map(supervisor.listPlugins().map(p => [
					p.name,
					JSON.parse(readFileSync(join(profileDir, 'node_modules', ...p.name.split('/'), 'package.json'), 'utf8')) as unknown,
				])));
			},
			dispatch: request => {
				dispatched.push({ capability: request.capability, pluginId: request.pluginId });
				return Promise.resolve({ capability: request.capability, pluginId: request.pluginId, via: 'test-gate' });
			},
			log: () => undefined,
			trace: () => undefined,
		});
		supervisor = new DshHostSupervisor({
			runtime: new DshRuntimeManager(RUNTIME_ROOT, l => lines.push(l)),
			runDir,
			foundationPluginDir: undefined,
			bridgePluginDir: BRIDGE_DIR,
			chatSurfacePluginDir: undefined,
			// 两个假插件都**真装**进 profile（起 Host 之前装好，Host 启动时真装载）
			modulePluginDirs: fakePlugins.map(plugin => [plugin.name, plugin.dir] as const),
			defaultDshHome: home,
			instanceId: 'test-identity',
			log: l => lines.push(l),
			// 生产路径：反向请求直接进闸门（等 bridge 建好再 set 会漏掉最早那几条）
			reverseRequestHandler: request => gate.handle(request),
		});
	});

	teardown(async () => {
		await supervisor.stop();
		supervisor.dispose();
		rmSync(home, { recursive: true, force: true });
		rmSync(runDir, { recursive: true, force: true });
		rmSync(pluginRoot, { recursive: true, force: true });
	});

	test('★ 盖章身份：真 Host 里拿到的是**包名**；冒名者被就地在 Host 侧拒绝', async () => {
		const status = await supervisor.start();
		assert.strictEqual(status.state, 'running', `Host 没起来：${status.error}\n${supervisor.getLog().slice(-25).join('\n')}`);
		assert.strictEqual(status.bridge, 'connected', `控制桥没连上：\n${supervisor.getLog().slice(-25).join('\n')}`);

		// 等第一个请求到达闸门（假插件在桥可用后 500ms 内就会发）
		const deadline = Date.now() + 120_000;
		while (dispatched.length === 0 && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 250));
		}
		const log = supervisor.getLog().join('\n');
		assert.ok(dispatched.length > 0, `120s 内没有任何 ide.request 到达闸门 ⇒ 假插件没被装载？\n${log.slice(-40)}`);

		// ① 盖章身份 = **包名**（loader 那一行的 name），不是模块导出的短名
		assert.strictEqual(dispatched[0].pluginId, HONEST,
			`闸门收到的 pluginId 应为包名 ${HONEST}（盖章生效）；实际 ${dispatched[0].pluginId}。日志：\n${log.slice(-40)}`);
		assert.strictEqual(dispatched[0].capability, CAPABILITY);

		// ② 冒名者**一次都没到**：再等一会儿，比分发次数（它若穿过来，插件名会是同一个，但次数会变成 2）
		await new Promise(resolve => setTimeout(resolve, 6000));
		assert.strictEqual(dispatched.length, 1,
			`应当只有诚实插件那一次分发；实际 ${dispatched.length} 次 ⇒ 冒名穿过了桥盖章：${JSON.stringify(dispatched)}`);

		// ③ 拒绝是**主动**发生的（桥抛出、插件把消息打到 stdout），不是"碰巧没发"。
		// 注意文案方向：冒名者**自报**的是诚实插件的名字，桥盖章算出的**实际身份**才是它自己 ——
		// 这一条同时证明"桥真的解析出了冒名者的真实身份"（而不是拒绝在别的检查上）。
		assert.match(log, new RegExp(`自报 pluginId=${HONEST.replace(/[@/]/g, '\\$&')}`),
			`Host 日志里应有桥的拒绝文案（冒名者自报的是 ${HONEST}）。日志：\n${log.slice(-40)}`);
		assert.match(log, new RegExp(`实际是 ${FORGER.replace(/[@/]/g, '\\$&')}`),
			`拒绝文案里应给出冒名者的**真实身份** ${FORGER}（= 盖章确实解析到了包名）。日志：\n${log.slice(-40)}`);
		assert.match(log, /被拒/, '假插件应把失败原因打出来（不然上面两条断言就是空的）');
	});
});
