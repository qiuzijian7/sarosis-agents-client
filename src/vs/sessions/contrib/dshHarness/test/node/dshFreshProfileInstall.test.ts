/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **全新 profile 上装模块插件**的两条路（对应真机 e2e 那条稳定红，见 `poc/dsh-p0/README.md` 4.86）。
 *
 * 这条用例是那次排查的**最小复现**（不用起 App，约 20 秒）：
 *
 * | 路径 | 全新 profile 上的结果 |
 * |---|---|
 * | **商城**：桥 → Host 内 `pluginManager`（`plugins.bundle.install`） | ❌ `operation-error` |
 * | **随包一键安装**：主进程暂存 + `dsh plugin add`（`DshHostSupervisor.installBundledPlugin`） | ✅ 装得上 |
 *
 * 商城那条的现场（已抓，证据存 `poc/dsh-p0/.out/evidence/kanban-install-pnpm.log`）：
 * - pnpm **本身没报错**（771 行、零 `ERR_`，结尾 `Done in 1.2s`），但它做了破坏性的一步：
 *   `Packages: -43` —— 把 43 个**没被 lockfile 声明**的包剪掉（全是 `@deepseek-ai/dsh-*`，
 *   正是 web-app bundle 那棵树里的 peer）；紧接着 pnpm 自己就报
 *   `Peer dependencies that should be installed: …`（删完才发现缺）；
 * - 而 **POC 老 profile 里这些包本来就不存在**（`node_modules` 顶层只有 3 条 vs 全新 profile 的 90 条）
 *   ⇒ 同一操作没有可剪的东西 ⇒ 成功。
 * - 排除了两个假设：spec 落在 profile 内（POC 上照样成功）、把 web-app/voice 写进 `dependencies`
 *   （本来就写着，照样 `-43`）。
 *
 * ⇒ 缺陷在 **dsh 的 pluginManager**（本仓库改不了），所以那条**跳过**并保留复现步骤：dsh 升级后
 * 把 `test.skip` 改回 `test` 即可验证是否已修。
 */

import assert from 'assert';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { get } from 'https';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { DshHostSupervisor } from '../../electron-main/dshHostSupervisor.js';
import { DshRuntimeManager } from '../../electron-main/dshRuntimeManager.js';

const REPO = process.env.DSH_TEST_REPO_ROOT ?? process.cwd();
const RUNTIME_ROOT = process.env.DSH_TEST_RUNTIME_ROOT ?? join(REPO, 'poc', 'dsh-p0', '.runtime');
const KANBAN_DIR = join(REPO, 'dsh-plugins', 'vssaros-kanban');
const KANBAN_NAME = '@vssaros/dsh-kanban';
/** 随包 **vendored** 的 archify 目录（`dsh-plugins/vssaros-archify/`；上游 `@tt-a1i/archify-dsh`，MIT）。 */
const ARCHIFY_VENDOR_DIR = join(REPO, 'dsh-plugins', 'vssaros-archify');
/** 注册表用例用的第三方插件（= archify 技能的唯一来源，见 `agentStudio/common/dshPluginRecommendations.ts`）。 */
const ARCHIFY_NAME = '@tt-a1i/archify-dsh';
/** 钉版本：结果要可复现（与策展清单里的 `pinVersion` 同一口径 ✓）。 */
const ARCHIFY_SPEC = `${ARCHIFY_NAME}@1.0.0`;

/** 注册表通不通（不通 ⇒ 注册表用例自跳过，不假装通过 —— 与 p3-52 "没装 Chrome 就 SKIP" 同口径 ✓）。 */
function registryReachable(timeoutMs = 8000): Promise<boolean> {
	return new Promise(resolve => {
		const req = get('https://registry.npmjs.org/@tt-a1i%2Farchify-dsh', res => {
			res.resume();
			resolve(!!res.statusCode && res.statusCode < 500);
		});
		req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
		req.on('error', () => resolve(false));
	});
}

suite('dshHarness / 全新 profile 上的模块插件安装', function () {
	this.timeout(300_000);

	/** 起一个**全新** profile（走 supervisor 的真实初始化：模板 init + 5 个伴生插件）。 */
	async function withFreshProfile(instanceId: string, fn: (ctx: {
		sup: DshHostSupervisor;
		profileDir: string;
		/**
		 * 监督器 + 运行时的日志（**失败时贴进断言消息** —— 下面那条偶发用例的注释说了为什么必须 ✓）。
		 * 只给"起得来"之后用：`start()` 之前失败连 `lines` 都没意义（那种失败有自己的消息 ✓）。
		 */
		logs: readonly string[];
		/** 把 kanban 拷进 profile 内（与 e2e 的做法一致），返回那个路径。 */
		stageKanban: () => string;
	}) => Promise<void>, opts: {
		/**
		 * 是否把**随包 vendored 的 archify** 也交给启动序列（默认 `false`）。
		 *
		 * ⚠ 默认关不是"忘了开"：下面那条**注册表规格**用例要求 `changed === true`（要从 npm 真装一次）；
		 * 若启动时已经装好同版本的随包副本，那次 `dsh plugin add` 就成了 no-op、`changed === false` ⇒ 该用例假红 ✗。
		 * 「默认随包自动装」那条另有自己的用例（显式开它 ✓）。
		 */
		archify?: boolean;
	} = {}): Promise<void> {
		const root = mkdtempSync(join(tmpdir(), 'vssaros-fresh-profile-'));
		const home = join(root, 'dsh-home');
		const lines: string[] = [];
		const sup = new DshHostSupervisor({
			runtime: new DshRuntimeManager(RUNTIME_ROOT, l => lines.push(l)),
			runDir: join(root, 'run'),
			bridgePluginDir: join(REPO, 'dsh-plugins', 'vssaros-bridge'),
			chatSurfacePluginDir: join(REPO, 'dsh-plugins', 'vssaros-chat-surface'),
			// 模块插件（2026-10-11 起随包）：这里只真机装 agents 一条 —— 全量 10 个模块太慢，
			// 而"发现逻辑对不对"由 `test/common/dshPluginPackages.test.ts` 的行为级断言覆盖 ✓。
			modulePluginDirs: [['@vssaros/dsh-agents', join(REPO, 'dsh-plugins', 'vssaros-agents')]],
			// 随包 vendored 的第三方技能包（archify）：显式开时才交给启动序列（理由见上面 opts 的注释 ✓）
			archifyPluginDir: opts.archify ? ARCHIFY_VENDOR_DIR : undefined,
			defaultDshHome: home,
			instanceId,
			log: l => lines.push(l),
		});
		try {
			const s = await sup.start();
			assert.strictEqual(s.state, 'running', `${s.error}\n${lines.slice(-12).join('\n')}`);
			const profileDir = join(home, 'profiles', 'vssaros');
			const stageKanban = () => {
				const version = (JSON.parse(readFileSync(join(KANBAN_DIR, 'package.json'), 'utf8')) as { version: string }).version;
				const staged = join(profileDir, '.vssaros', 'plugins', `vssaros-dsh-kanban-${version}`);
				rmSync(staged, { recursive: true, force: true });
				mkdirSync(staged, { recursive: true });
				cpSync(KANBAN_DIR, staged, { recursive: true, filter: p => !/[\\/]node_modules([\\/]|$)/.test(p.slice(KANBAN_DIR.length)) });
				return staged;
			};
			await fn({ sup, profileDir, logs: lines, stageKanban });
		} finally {
			await sup.stop();
			sup.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	}

	test('★ 随包一键安装（主进程暂存 + `dsh plugin add`）在全新 profile 上装得上', async () => {
		await withFreshProfile('fresh-bundled', async ({ sup, profileDir, logs }) => {
			const r = await sup.installBundledPlugin(KANBAN_NAME, KANBAN_DIR);
			// ⚠ 这条**偶发**（2026-10-14 实测：首跑 `ok:false` / 「装完仍是（未装上）」、复跑 53.7s 通过）。
			//   ⇒ 失败消息**必须**带监督器日志尾巴：真实现场（pnpm 输出 / 批量安装那几行）只存在于 `logs`，
			//   只贴 `JSON.stringify(r)` 的后果是下一个人只看到"没装上"三个字、无从定位 ✗✗（同 86 行那条 state 断言的做法 ✓）。
			assert.strictEqual(r.ok, true, `一键安装应成功：${JSON.stringify(r)}\n监督器日志（尾 25 行）：\n${logs.slice(-25).join('\n')}`);
			assert.strictEqual(r.version, r.bundledVersion, '装的必须是随包那个版本');
			assert.strictEqual(r.changed, true, '首次安装应有变化');
			const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
			assert.ok(String(pkg.dependencies?.[KANBAN_NAME] ?? '').startsWith('file:'), `profile 依赖里应有它：${pkg.dependencies?.[KANBAN_NAME]}`);
		});
	});

	/**
	 * ★ **默认随包自动装**（2026-10-14 用户要求）：vendored 的 `dsh-plugins/vssaros-archify/` 必须在**全新 profile**
	 * 上被**启动序列自己装上** —— 而不是等用户去插件中心点一下（那正是这次要改掉的体验）。理由与取舍见
	 * `dsh-plugins/vssaros-archify/VENDOR.md`。
	 *
	 * 判据取**技能本体落位**（`node_modules/@tt-a1i/archify-dsh/skills/archify/SKILL.md`）：profile 的 dependencies
	 * 里有一行只说明"依赖写了"；文件没落 ⇒ 技能库照样空 ✗（IDE 技能库那条来源 `common/dshPluginSkillRoots.ts`
	 * 读的正是这个位置 ⇒ 两半在这条断言上对齐 ✓）。
	 *
	 * 不需要网络（走本地暂存拷贝）⇒ 不必像注册表那条一样"没网就 SKIP" ✓。
	 */
	test('★ 默认随包自动装：archify（vendored）在全新 profile 上由启动序列装上，技能本体落位', async () => {
		await withFreshProfile('fresh-archify', async ({ profileDir, logs }) => {
			const skillMd = join(profileDir, 'node_modules', ...ARCHIFY_NAME.split('/'), 'skills', 'archify', 'SKILL.md');
			assert.ok(existsSync(skillMd),
				`启动后应已自动装上 archify、且技能本体在位：${skillMd}\n监督器日志（尾 25 行）：\n${logs.slice(-25).join('\n')}`);
		}, { archify: true });
	});

	/**
	 * ★ **注册表规格**在全新 profile 上装得上（2026-10-13：`installPluginSpec` = 主进程 `dsh plugin add`）。
	 *
	 * 为什么值得一条真机用例：界面把**注册表规格**从商城那条改到主进程这条，全部理由就是"全新 profile 上
	 * 商城那条会 `operation-error`"——而那条判据此前只有**一个用 local-dir spec 复现**的现场（下面那条
	 * `test.skip`）。这条用**真的 npm 包装一遍**，把"注册表规格 + 全新 profile + 主进程那条"这个组合钉住 ✓。
	 *
	 * ⚠ 需要网络（要拉 `@tt-a1i/archify-dsh`）：拉不到就 **SKIP 并说明**，绝不假装通过 —— 与
	 *   `poc/dsh-p0/scripts/p3-52-archify-skill.mjs`（没装 Chrome 就自跳过）同一口径：不能让"这台机器没网"
	 *   变成假红/假绿 ✗。装的是**已经发布在公共 npm 上**的第三方包（archify 技能的唯一来源）。
	 */
	test('★ 注册表规格（主进程 `dsh plugin add`）在全新 profile 上装得上，且包内 skills/ 落到位', async () => {
		if (!(await registryReachable())) {
			console.log('SKIP: 本机访问不到 registry.npmjs.org ⇒ 这条注册表安装用例跳过（不是通过，也不是失败）。');
			return;
		}
		await withFreshProfile('fresh-registry', async ({ sup, profileDir, logs }) => {
			const r = await sup.installPluginSpec(ARCHIFY_SPEC, ARCHIFY_NAME);
			assert.strictEqual(r.ok, true, `注册表规格应装得上：${JSON.stringify(r)}\n监督器日志（尾 25 行）：\n${logs.slice(-25).join('\n')}`);
			assert.strictEqual(r.changed, true, '首次安装应有变化');
			assert.strictEqual(r.version, r.bundledVersion, '这条路的 bundledVersion 就是实装版本（spec 安装没有随包源）');
			const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
			assert.ok(String(pkg.dependencies?.[ARCHIFY_NAME] ?? '').length > 0,
				`profile 依赖里应有它：${JSON.stringify(pkg.dependencies?.[ARCHIFY_NAME])}`);
			// 技能随插件包分发 ⇒ 包内 `skills/<name>/SKILL.md` 必须在。
			// 这条把两半work连起来：IDE 技能库的来源（`common/dshPluginSkillRoots.ts` 按同一个约定找）就靠它 ✓
			const skillMd = join(profileDir, 'node_modules', ...ARCHIFY_NAME.split('/'), 'skills', 'archify', 'SKILL.md');
			assert.ok(existsSync(skillMd), `插件包内应有技能：${skillMd}`);
		});
	});

	// 上游缺陷（dsh 的 pluginManager 在全新 profile 上会剪掉 43 个未声明包 ⇒ operation-error）：
	// 本仓库改不了它，所以**跳过**而不是留一条长期红；dsh 升级后改回 `test` 即验证。
	test.skip('商城路径（桥 → plugins.bundle.install）在全新 profile 上会 operation-error', async () => {
		await withFreshProfile('fresh-marketplace', async ({ sup, profileDir, stageKanban }) => {
			const staged = stageKanban();
			const r = await sup.bridge!.call<{ application?: string; changed?: boolean; error?: string; failureKind?: string; target?: string }>(
				'plugins.bundle.install', { spec: staged, requestId: `fresh-${Date.now().toString(36)}` }, 600_000);
			const logs = join(profileDir, '.plugin-manager', 'logs');
			const pruned = existsSync(logs)
				? readdirSync(logs).map(n => join(logs, n, 'pnpm.log')).filter(f => existsSync(f) && statSync(f).size > 0)
					.map(f => readFileSync(f, 'utf8').split('\n').filter(l => /^Packages:/.test(l)).join(' / ')).join(' ; ')
				: '(没有 operation 日志)';
			assert.notStrictEqual(r.application, 'failed', `商城路径失败：${r.error ?? '(无 error 字段)'}（Packages 行：${pruned}）`);
		});
	});
});
