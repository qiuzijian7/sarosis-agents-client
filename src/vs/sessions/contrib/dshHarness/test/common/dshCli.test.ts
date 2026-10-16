/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { LineDecoder, isBridgeHello } from '../../common/dshBridgeProtocol.js';
import {
	bridgePipePath, buildHostArgs, buildPluginAddArgs, buildPluginAddArgsMany, buildProfileInitArgs, compareSemver, isSameOrigin,
	isSupportedNodeVersion, localPluginDir, parseAuthUrl, parseRuntimeState, renderBridgeOverlay, renderCodebaseOverlay, renderKanbanOverlay, renderSandboxOverlay, resolveSiblingPackage, selectRuntimeVersion, toFileSpec, withCurrent,
} from '../../common/dshCli.js';

suite('dshHarness / CLI contract', () => {

	test('launcher flags (--profile, --patch) precede app flags (--no-open, --port)', () => {
		const args = buildHostArgs('bin.js', 'vssaros', ['a.yml', 'b.yml']);
		assert.deepStrictEqual(args, ['bin.js', '--profile', 'vssaros', '--patch', 'a.yml', '--patch', 'b.yml', '--no-open', '--port', '0']);
		assert.ok(args.lastIndexOf('--patch') < args.indexOf('--no-open'), 'P0-1: --patch after app flags is rejected by the launcher');
	});

	/**
	 * 端口可显式指定（2026-10-14）。
	 *
	 * 为什么必须钉住：dsh 把 `http://127.0.0.1:<port>` 写进**每一条 system 提示**，
	 * 而 `--port 0` 每次都换端口 ⇒ 每次 Host 重启后 system 字节都变 ⇒ prompt 前缀缓存全失效
	 * （实测同一会话 6 次请求的 system 299/302 行逐字相同、唯一差异是端口，命中率 6.4%）。
	 * supervisor 复用上次端口即靠这个参数注入。
	 *
	 * ⚠ 反向突变验证：把 `String(port)` 改回字面量 `'0'`，本用例立刻变红。
	 */
	test('explicit port is forwarded verbatim (port stability ⇒ cache stability)', () => {
		const args = buildHostArgs('bin.js', 'vssaros', [], 1531);
		assert.deepStrictEqual(args, ['bin.js', '--profile', 'vssaros', '--no-open', '--port', '1531']);
		assert.strictEqual(args[args.length - 1], '1531', '端口必须是最后一个值参数（紧跟 --port）');
		// 缺省仍是 0（历史行为逐字不变 ⇒ 老调用点零改动）
		assert.strictEqual(buildHostArgs('bin.js', 'vssaros', [])[5], '0');
	});

	test('profile init and plugin add argv', () => {
		assert.deepStrictEqual(buildProfileInitArgs('b', 'p'), ['b', '--profile', 'p', '--from-default-profile', 'web', '--help']);
		assert.deepStrictEqual(buildPluginAddArgs('b', 'p', 'file:/x'), ['b', 'plugin', '--profile', 'p', 'add', 'file:/x']);
	});

	/**
	 * 首启提速（2026-10-13）：一条 `dsh plugin add spec1 spec2 …` 装完所有变更插件。
	 * 依据：dsh 只解析它**自有**的子命令，其余参数**原样转交 pnpm**（`@deepseek-ai/dsh/lib/plugin-BGnVfe_D.js`
	 * 注释原文：Parse only DSH-owned commands; all other arguments remain pnpm's responsibility），
	 * 而 pnpm 的 `add` 接受多包 ✓。串行的代价实测很硬：每个变更插件一个 pnpm 进程（2–5 s），
	 * 首启 6 个变更 = 17 s 全耗在装插件上（24 s 首启里占 17 s，起 Host 6 s、工作区 0.3 s）✗。
	 * 这里钉住 argv：**顺序与传入一致、不去重、不改形**（拼错一个字符就是"装不上"）。
	 */
	test('★ 批量装插件：一条 argv 带多个 spec（顺序不变、不去重）', () => {
		assert.deepStrictEqual(
			buildPluginAddArgsMany('b', 'p', ['file:/x', 'file:/y', 'file:/x']),
			['b', 'plugin', '--profile', 'p', 'add', 'file:/x', 'file:/y', 'file:/x']);
		// 单 spec 时与旧函数**逐字一致**：旧调用点（插件中心）继续走同一拼装 ⇒ 行为不可能漂移
		assert.deepStrictEqual(buildPluginAddArgsMany('b', 'p', ['file:/x']), buildPluginAddArgs('b', 'p', 'file:/x'));
	});

	/**
	 * 沙箱降级覆盖层（2026-10-13 首启探针的落地形态）：
	 * 行 id 必须逐字是 `sandbox-policy`（`@deepseek-ai/dsh-base/cordis.patch.yml:229` 定义的行）——
	 * 不一致就**打空且静默**（与 codebase 那条同一条教训 ✗）。
	 * 同时钉住"**只降沙箱、不动审批**"：审批策略由 `approval` 行 + `DSH_PERMISSION_MODE` 决定，
	 * 本覆盖层一碰它就会把审批闸也变成 `never` ✗✗。
	 */
	test('★ 沙箱降级覆盖层：同时打 sandbox-policy 与 permission 两行（缺一行会让插件抛错 ✗）', () => {
		const yml = renderSandboxOverlay('danger-full-access', 'G:\\ws');
		assert.match(yml, /^- id: sandbox-policy$/m, '行 id 必须逐字匹配 base 的 patch 行（打空 = 静默失效）');
		assert.match(yml, /^    mode: 'danger-full-access'$/m);
		assert.match(yml, /^    workspaceRoot: 'G:\\ws'$/m);
		// ★ 第二行是实测补的：preset 服务要求「沙箱 + 审批」组合命中某个 preset，
		//   而 base 里 danger-full-access 配的是 never ⇒ 我们改成 ask 才自洽（否则 permission 插件
		//   构造抛错、整条不激活 ⇒ 沙箱退回 workspace-write、报错照旧 ✗✗）。
		assert.match(yml, /^- id: permission$/m, '必须同时打 permission 行，否则 `composed sandbox and approval defaults match no preset` ✗');
		assert.match(yml, /^    defaultPreset: 'danger-full-access'$/m);
		assert.match(yml, /^      danger-full-access:[\s\S]{0,120}?approval: ask$/m, '降级后的组合必须是 (danger-full-access, ask)');
		assert.ok(!/approval: never/.test(yml), '审批闸绝不许被关掉（沙箱已降级 ⇒ 审批是唯一兜底）');
		assert.doesNotMatch(yml, /DSH_PERMISSION_MODE/, '不走那个环境变量（它会让 approval 一起变 never ✗）');
		// 三个 preset 必须写全：`permission` 行的 config 是**整体替换** ✗
		for (const name of ['read-only', 'workspace-write', 'danger-full-access']) {
			assert.match(yml, new RegExp(`^      ${name}:$`, 'm'), `preset ${name} 不能漏（整体替换）`);
		}
	});

	test('file: spec uses forward slashes (pnpm treats backslash form as profile-relative)', () => {
		assert.strictEqual(toFileSpec('G:\\Saros\\dsh-plugins\\vssaros-bridge'), 'file:G:/Saros/dsh-plugins/vssaros-bridge');
		assert.strictEqual(toFileSpec('/opt/vssaros/dsh-plugins/vssaros-bridge'), 'file:/opt/vssaros/dsh-plugins/vssaros-bridge');
	});

	/**
	 * 「添加插件」里粘的 spec 分两路：**本地绝对目录**走主进程（`dsh plugin add`，与随包一键安装同源），
	 * 其余（注册表 / git / tarball）留给商城那条。判错的代价是实打实的：本地路径被误判成"非本地"
	 * 就会去走 Host 内 pluginManager，而在**全新 profile** 上那条会把未被 lockfile 声明的包剪掉并
	 * 判 `operation-error`（首启用户点"安装"必失败，README 4.86）。
	 */
	test('★ 本地目录 spec 判定：认出绝对路径，其余一律交回商城那条', () => {
		assert.strictEqual(localPluginDir('G:\\Saros\\dsh-plugins\\vssaros-kanban'), 'G:\\Saros\\dsh-plugins\\vssaros-kanban');
		assert.strictEqual(localPluginDir('file:G:/Saros/dsh-plugins/vssaros-kanban'), 'G:/Saros/dsh-plugins/vssaros-kanban');
		assert.strictEqual(localPluginDir('file:///G:/Saros/dsh-plugins/vssaros-kanban'), 'G:/Saros/dsh-plugins/vssaros-kanban');
		assert.strictEqual(localPluginDir('file:/opt/vssaros/dsh-plugins/vssaros-kanban'), '/opt/vssaros/dsh-plugins/vssaros-kanban');
		assert.strictEqual(localPluginDir('/opt/vssaros/dsh-plugins/vssaros-kanban'), '/opt/vssaros/dsh-plugins/vssaros-kanban');
		assert.strictEqual(localPluginDir('\\\\srv\\share\\vssaros-kanban'), '\\\\srv\\share\\vssaros-kanban');
		assert.strictEqual(localPluginDir('  G:/a/b  '), 'G:/a/b', '两端空白该容忍（用户从别处粘来的）');
		assert.strictEqual(localPluginDir('G:/a/b/'), 'G:/a/b', '尾部分隔符该去掉');
		for (const spec of [
			'@vssaros/dsh-kanban', '@vssaros/dsh-kanban@1.0.0', 'vssaros-kanban',   // 注册表形态
			'https://example.com/x.tgz', 'git+https://example.com/x.git', 'github:o/r',  // 远程 / tarball
			'file:./rel', './rel/x', '../rel/x', '/', 'C:', '', '   ',              // 相对 / 只有盘符 / 空
		]) {
			assert.strictEqual(localPluginDir(spec), undefined, `应判为非本地路径：${JSON.stringify(spec)}`);
		}
	});

	test('bridge overlay pre-acknowledges the official preview notice when a version is known', () => {
		const withVersion = renderBridgeOverlay('\\\\.\\pipe\\p', 'tok', false, '2026-09-28.1');
		assert.ok(withVersion.includes('- id: ui-settings-general'));
		assert.ok(withVersion.includes("welcomeNoticeVersion: '2026-09-28.1'"));
		// 版本读不到时不写这一行（退回官方"弹一次"的行为），其余行不受影响。
		const without = renderBridgeOverlay('\\\\.\\pipe\\p', 'tok', false);
		assert.ok(!without.includes('ui-settings-general'));
		assert.ok(without.includes('- id: vssaros-bridge'));
	});

	test('bridge overlay carries idleTtlMs through (解法 A：Host 驻留更久 ⇒ 二次启动 ~0s)', () => {
		// 2026-10-15：桥插件默认 TTL 只有 30min ⇒ IDE 重启间隔稍长 ⇒ Host 已自杀 ⇒ 又是一次 ~27s 冷启 ✗。
		// 这行丢了 ⇒ 解法 A 静默失效（渲染照常成功、只是没这行 ✗）⇒ 用守卫钉死 ✓。
		const withTtl = renderBridgeOverlay('\\\\.\\pipe\\p', 'tok', false, undefined, 12 * 60 * 60_000);
		assert.ok(withTtl.includes('idleTtlMs: 43200000'), 'idleTtlMs 必须渲进桥补丁（丢了 ⇒ 回落 30min 默认 ✗）');
		// 不传时不写这行（回落桥插件默认，语义不变 ✓）。
		assert.ok(!renderBridgeOverlay('\\\\.\\pipe\\p', 'tok', false).includes('idleTtlMs'));
		// 0/负值视为"没传"（避免把 0 渲进去变成"永不自退"的意外 ✗ —— 那是另一个语义，不能顺路送 ✗）。
		assert.ok(!renderBridgeOverlay('\\\\.\\pipe\\p', 'tok', false, undefined, 0).includes('idleTtlMs'));
	});

	test('bridge overlay bakes personaSuffix without {{cwd}}（"This turn failed: unknown prompt variable" 的修法）', () => {
		// 2026-10-15：官方 web-app 默认把 personaSuffix 写成带 {{cwd}} 的文本 —— 子代理（deployment）
		// 作用域的变量表里没有 cwd ⇒ 子代理每一轮都被插值器抛错中止 ✗（dsh-system-prompt:169）。
		// 这行丢了 ⇒ 修法静默失效（补丁照常生成、只是官方那行还在 ✗）⇒ 用守卫钉死 ✓。
		const y = renderBridgeOverlay('\\\\.\\pipe\\p', 'tok', false, undefined, undefined, 'G:\\ws\\app');
		assert.ok(y.includes('- id: system-prompt'), '必须覆盖官方那行（不覆盖 ⇒ 子代理继续炸 ✗）');
		assert.ok(y.includes("personaSuffix: 'Your working directory is G:\\ws\\app.'"), '后缀要烘焙成字面量 ✓');
		assert.ok(!y.includes('{{cwd}}'), '整份补丁里不得再出现 {{cwd}}（留着 = 必炸 ✗）');
		// ⚠ patch 行**整份替换**目标行 config ⇒ personaPrefix 必须原文复述（含 {{model}} —— 有注册 ✓）。
		assert.ok(y.includes("personaPrefix: 'You are a coding agent powered by the {{model}} model.'"),
			'personaPrefix 必须复述（漏了 ⇒ patch 替换把官方 prefix 清空 ✗✓）');
		// 没工作区根时给空串，也绝不能留 {{cwd}} ✗。
		const bare = renderBridgeOverlay('\\\\.\\pipe\\p', 'tok', false);
		assert.ok(!bare.includes('{{cwd}}'), '没有工作区根时也不许留 {{cwd}} ✗');
		assert.ok(bare.includes("personaSuffix: ''"));
	});

	test('resolveSiblingPackage derives a sibling dir from the dsh bin path', () => {
		const voice = '@deepseek-ai/dsh-experimental-voice-input-bundle';
		assert.strictEqual(
			resolveSiblingPackage('G:\\Saros\\dsh-runtime\\0.2.0-rc.2\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js', voice),
			'G:\\Saros\\dsh-runtime\\0.2.0-rc.2\\node_modules\\@deepseek-ai\\dsh-experimental-voice-input-bundle');
		assert.strictEqual(
			resolveSiblingPackage('/opt/dsh-runtime/0.2.0-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js', voice),
			'/opt/dsh-runtime/0.2.0-rc.2/node_modules/@deepseek-ai/dsh-experimental-voice-input-bundle');
		// 意外形状 / 非本 scope 包名 → undefined（按未随包分发处理）
		assert.strictEqual(resolveSiblingPackage('G:\\x\\bin.js', voice), undefined);
		assert.strictEqual(resolveSiblingPackage('G:\\x\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js', '@other/pkg'), undefined);
		assert.strictEqual(resolveSiblingPackage('G:\\x\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js', 'dsh'), undefined);
	});

	test('parseAuthUrl only accepts loopback http with a port and a token', () => {
		assert.strictEqual(parseAuthUrl('see https://docs.example/?token=abc'), undefined);
		assert.strictEqual(parseAuthUrl('http://10.0.0.2:3080/?token=abc'), undefined);
		const r = parseAuthUrl('noise\ndsh web: http://127.0.0.1:3622/?token=AbC_-9 ready\n');
		assert.deepStrictEqual(r, { authUrl: 'http://127.0.0.1:3622/?token=AbC_-9', origin: 'http://127.0.0.1:3622' });
		assert.strictEqual(parseAuthUrl('http://localhost:5000/?token=t')?.origin, 'http://localhost:5000');
	});

	test('isSameOrigin fences navigation to the Host origin', () => {
		assert.ok(isSameOrigin('http://127.0.0.1:1/x?y', 'http://127.0.0.1:1'));
		assert.ok(!isSameOrigin('http://127.0.0.1:2/', 'http://127.0.0.1:1'));
		assert.ok(!isSameOrigin('https://example.com/', 'http://127.0.0.1:1'));
		assert.ok(!isSameOrigin('not a url', 'http://127.0.0.1:1'));
	});

	test('Node version gate: 22.19+ or 24+', () => {
		for (const ok of ['v22.19.0', 'v22.22.1', '24.0.0', 'v25.1.0']) {
			assert.ok(isSupportedNodeVersion(ok), ok);
		}
		for (const bad of ['v22.18.9', 'v23.5.0', 'v20.11.0', 'garbage']) {
			assert.ok(!isSupportedNodeVersion(bad), bad);
		}
	});

	test('semver ordering incl. prereleases', () => {
		const sorted = ['0.2.0', '0.2.0-rc.2', '0.1.7-rc.2', '0.2.1-alpha.1', '0.2.0-rc.10', '0.1.7'].sort(compareSemver);
		assert.deepStrictEqual(sorted, ['0.1.7-rc.2', '0.1.7', '0.2.0-rc.2', '0.2.0-rc.10', '0.2.0', '0.2.1-alpha.1']);
	});

	test('runtime state parsing is tolerant', () => {
		assert.deepStrictEqual(parseRuntimeState(undefined), { history: [] });
		assert.deepStrictEqual(parseRuntimeState('{oops'), { history: [] });
		assert.deepStrictEqual(parseRuntimeState('{"current":"../evil","history":["0.1.0",3]}'), { current: undefined, history: ['0.1.0'] });
		const s = withCurrent(withCurrent({ history: [] }, '0.1.7-rc.2'), '0.2.0-rc.2');
		assert.deepStrictEqual(s, { current: '0.2.0-rc.2', history: ['0.1.7-rc.2', '0.2.0-rc.2'] });
		assert.deepStrictEqual(withCurrent(s, '0.1.7-rc.2').history, ['0.2.0-rc.2', '0.1.7-rc.2']);
	});

	test('version selection honours the pointer and never silently prefers alpha', () => {
		const installed = ['0.1.7-rc.2', '0.2.0-rc.2', '0.2.1-alpha.1'];
		assert.strictEqual(selectRuntimeVersion({ current: '0.1.7-rc.2', history: [] }, installed), '0.1.7-rc.2');
		assert.strictEqual(selectRuntimeVersion({ current: '9.9.9', history: [] }, installed), '0.2.1-alpha.1', 'no stable installed → highest prerelease');
		assert.strictEqual(selectRuntimeVersion({ history: [] }, [...installed, '0.1.6']), '0.1.6', 'stable wins over prerelease when no pointer');
		assert.strictEqual(selectRuntimeVersion({ history: [] }, []), undefined);
	});

	test('bridge overlay quotes Windows pipe paths safely', () => {
		const yml = renderBridgeOverlay('\\\\.\\pipe\\vssaros-dsh-ab', 'to\'ken', false);
		assert.ok(yml.includes(`pipe: '\\\\.\\pipe\\vssaros-dsh-ab'`));
		assert.ok(yml.includes(`token: 'to''ken'`));
		assert.ok(yml.includes('- id: vssaros-bridge'));
		assert.strictEqual(bridgePipePath('win32', 'ab', 'C:\\run'), '\\\\.\\pipe\\vssaros-dsh-ab');
		assert.strictEqual(bridgePipePath('linux', 'ab', '/tmp/run/'), '/tmp/run/vssaros-dsh-ab.sock');
	});

	test('kanban overlay carries only the plugin row config (workspaceId) and quotes it', () => {
		const yml = renderKanbanOverlay('ws_123');
		assert.ok(yml.includes('- id: vssaros-kanban'), 'must target the kanban row, not the whole profile');
		assert.ok(yml.includes(`workspaceId: 'ws_123'`), 'config.workspaceId is what the plugin reads');
		assert.ok(!yml.includes('vssaros-bridge'), 'a separate overlay: must not touch the bridge row');
		assert.ok(renderKanbanOverlay('it\'s').includes(`workspaceId: 'it''s'`), 'YAML single-quote escaping in place');
	});

	test('codebase overlay carries only the plugin row config (workspaceRoot) and quotes it', () => {
		const yml = renderCodebaseOverlay('G:\\ws\\proj');
		// ★ 跨源码契约：行 id 必须与插件自带 `cordis.patch.yml` 插入的那一行**同名**——不一致会打空、
		// 并**静默**回到"未配置"（README 4.79 的教训；这条就是钉它的）。
		assert.ok(yml.includes('- id: vssaros-codebase'), 'must target the codebase row, not the whole profile');
		assert.ok(yml.includes(`workspaceRoot: 'G:\\ws\\proj'`), 'config.workspaceRoot is what the plugin reads');
		assert.ok(!yml.includes('vssaros-kanban') && !yml.includes('vssaros-bridge'), 'a separate overlay: must not touch other rows');
		assert.ok(renderCodebaseOverlay("it's").includes(`workspaceRoot: 'it''s'`), 'YAML single-quote escaping in place');
		// 图谱相关根（跨根只读）：列出来、主根不重复、空白项被丢、逐项单引号
		const multi = renderCodebaseOverlay('/ws/main', ['/ws/main', '/ws/other', '   ']);
		assert.ok(multi.includes('relatedRoots:') && multi.includes("      - '/ws/other'"), 'related roots are listed as a YAML array');
		assert.ok(!multi.includes("- '/ws/main'"), 'the main root is not repeated inside relatedRoots');
		assert.ok(!multi.includes("- ''"), 'blank entries are dropped (never render an empty string item)');
		assert.ok(!renderCodebaseOverlay('/ws/main').includes('relatedRoots'), 'no relatedRoots key at all when there are none');
	});
});

suite('dshHarness / bridge protocol', () => {

	test('LineDecoder reassembles frames across chunks and skips bad lines', () => {
		const d = new LineDecoder();
		assert.deepStrictEqual(d.push('{"id":1,"res'), []);
		const out = d.push('ult":2}\nnot json\n\n{"id":2,"error":{"code":-1,"message":"x"}}\n{"no":"id"}\n');
		assert.deepStrictEqual(out.map(m => m.id), [1, 2]);
		assert.strictEqual(d.malformed, 2);
	});

	test('isBridgeHello shape check', () => {
		assert.ok(isBridgeHello({ bridgeVersion: 1, pluginVersion: '0.1.0', node: 'v22', pid: 1, host: { port: 1, bind: '127.0.0.1', origin: 'http://127.0.0.1:1', authUrl: 'http://127.0.0.1:1/?token=t' } }));
		assert.ok(!isBridgeHello({ bridgeVersion: 1 }));
		assert.ok(!isBridgeHello(null));
	});
});
