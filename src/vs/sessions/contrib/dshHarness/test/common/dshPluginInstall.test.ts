/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 插件商城安装面（方案 5.16 批次 4）的入参校验：`plugins.bundle.inspect` /
 * `plugins.bundle.install` / `plugins.bundle.install.cancel` / `plugins.bundle.remove`
 * 的负载都要跨进程边界（renderer → 主进程 → 控制桥 → Host），字符白名单必须收紧。
 *
 * 其中 `requestId` 是**安装取消的凭据**，形态必须受控（自己生成 `vssaros-<ts36>-<rand>`）：
 * 一旦让任意字符串过去，取消就可能命中别的安装或永远 not-running。
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { validateBundleInspectArgs, validateBundleInstallArgs, validateBundleRemoveArgs, validateInstallCancelArgs } from '../../common/dshBridgeProtocol.js';

suite('dshHarness / plugin install payloads', () => {

	test('inspect：接受包名/绝对路径/git/tarball，拒绝空与带空白/引号的 spec', () => {
		assert.ok(validateBundleInspectArgs({ spec: '@vssaros/dsh-kanban' }));
		assert.ok(validateBundleInspectArgs({ spec: '@vssaros/dsh-kanban@0.2.2' }));
		assert.ok(validateBundleInspectArgs({ spec: 'G:\\SarosWorkspace\\sarosis-agents-client\\dsh-plugins\\vssaros-kanban' }));
		assert.ok(validateBundleInspectArgs({ spec: 'git+https://github.com/example/plugin.git' }));
		assert.ok(validateBundleInspectArgs({ spec: 'https://example.com/pkg-1.0.0.tgz' }));
		assert.ok(!validateBundleInspectArgs({ spec: '' }));
		assert.ok(!validateBundleInspectArgs({ spec: '   ' }));
		assert.ok(!validateBundleInspectArgs({ spec: 'a b' }));
		assert.ok(!validateBundleInspectArgs({ spec: 'a"b' }));
		assert.ok(!validateBundleInspectArgs({ spec: 'a|b' }));
		assert.ok(!validateBundleInspectArgs({ spec: 'a;rm -rf /' }));
		assert.ok(!validateBundleInspectArgs({ spec: 'a\nb' }));
		assert.ok(!validateBundleInspectArgs({ spec: `a${'x'.repeat(1024)}` }));
		assert.ok(!validateBundleInspectArgs({}));
		assert.ok(!validateBundleInspectArgs(null));
	});

	test('install：spec 与 requestId 都必填；approvedBuilds 可选但形态受控', () => {
		assert.ok(validateBundleInstallArgs({ spec: '@vssaros/dsh-kanban', requestId: 'vssaros-abc123' }));
		assert.ok(validateBundleInstallArgs({ spec: '@vssaros/dsh-kanban', requestId: 'vssaros-1a-2b', approvedBuilds: ['esbuild', '@scope/pkg'] }));
		// requestId 形态：白名单字符 + 长度上限（取消凭据不能是任意串）
		assert.ok(!validateBundleInstallArgs({ spec: '@vssaros/dsh-kanban' }), 'requestId 必填');
		assert.ok(!validateBundleInstallArgs({ spec: '@vssaros/dsh-kanban', requestId: '' }));
		assert.ok(!validateBundleInstallArgs({ spec: '@vssaros/dsh-kanban', requestId: 'a b' }));
		assert.ok(!validateBundleInstallArgs({ spec: '@vssaros/dsh-kanban', requestId: 'a/b' }));
		assert.ok(!validateBundleInstallArgs({ spec: '@vssaros/dsh-kanban', requestId: 'x'.repeat(121) }));
		// spec 与 inspect 同一口径
		assert.ok(!validateBundleInstallArgs({ spec: '', requestId: 'vssaros-abc' }));
		assert.ok(!validateBundleInstallArgs({ spec: 'a b', requestId: 'vssaros-abc' }));
		// approvedBuilds：数组、有上限、每项是包名
		assert.ok(!validateBundleInstallArgs({ spec: '@vssaros/x', requestId: 'vssaros-abc', approvedBuilds: 'esbuild' }));
		assert.ok(!validateBundleInstallArgs({ spec: '@vssaros/x', requestId: 'vssaros-abc', approvedBuilds: ['a b'] }));
		assert.ok(!validateBundleInstallArgs({ spec: '@vssaros/x', requestId: 'vssaros-abc', approvedBuilds: Array.from({ length: 33 }, () => 'pkg') }));
	});

	test('remove：只收包名（路径/空白/换行一律拒）', () => {
		assert.ok(validateBundleRemoveArgs({ name: '@vssaros/dsh-kanban' }));
		assert.ok(validateBundleRemoveArgs({ name: '@deepseek-ai/dsh-mcp-client' }));
		assert.ok(!validateBundleRemoveArgs({ name: '' }));
		assert.ok(!validateBundleRemoveArgs({ name: '  ' }));
		assert.ok(!validateBundleRemoveArgs({ name: '@vssaros/x; rm -rf /' }));
		assert.ok(!validateBundleRemoveArgs({ name: 'G:\\path\\to\\pkg' }));
		assert.ok(!validateBundleRemoveArgs({ name: 'x'.repeat(513) }));
		assert.ok(!validateBundleRemoveArgs(undefined));
	});

	test('cancel：requestId 必填且形态受控', () => {
		assert.ok(validateInstallCancelArgs({ requestId: 'vssaros-abc123' }));
		assert.ok(!validateInstallCancelArgs({ requestId: '' }));
		assert.ok(!validateInstallCancelArgs({ requestId: 'vssaros abc' }));
		assert.ok(!validateInstallCancelArgs({ requestId: 'vssaros/abc' }));
		assert.ok(!validateInstallCancelArgs({ requestId: 'x'.repeat(121) }));
		assert.ok(!validateInstallCancelArgs({}));
		assert.ok(!validateInstallCancelArgs('vssaros-abc'));
	});
});

/** 监督器源码（模块级：下面两个 suite 共用一份；**先断言非空**，守卫不能空跑）。 */
const REL = 'src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts';
const src = (() => {
	const abs = path.join(process.cwd(), REL);
	assert.ok(fs.existsSync(abs), `读不到 ${REL}（cwd=${process.cwd()}）—— 守卫不能空跑`);
	const text = fs.readFileSync(abs, 'utf8');
	assert.ok(text.length > 0, `${REL} 是空文件（守卫不能空跑）`);
	return text;
})();

/**
 * 取一个类成员的正文：签名 → 下一个 `\n\tprivate `（找不到结尾就取 `fallbackLen`）。
 *
 * 用它而不是 `src.slice(at, at + 1600)`：后者在"方法被改长"时会**静默切掉尾巴**，守卫于是看着还在、
 * 实际已经查不到末尾那几行了（本仓踩过：守卫滞后于代码 ✗）。
 */
function fnBody(signature: string, fallbackLen = 2000): string {
	const at = src.indexOf(signature);
	assert.ok(at > 0, `找不到 \`${signature}\`（改名/挪走就要同步改这条守卫 ✗）`);
	const next = src.indexOf('\n\tprivate ', at + signature.length);
	return src.slice(at, next > at ? next : at + fallbackLen);
}

/**
 * 安装判据的第二关（2026-10-13，事故驱动）：**版本相同也要比对入口内容**。
 *
 * 现场：`@vssaros/dsh-memory` 的源码被修好（语法错）但**没有 bump 版本** ⇒ "版本相同就跳过安装"放过了一份
 * **语法坏**的已装副本 ⇒ Host 打 `vssaros-memory (@vssaros/dsh-memory): failed to import` ⇒ 该模块
 * **never started** ⇒ 会话 resume 报 `RemoteError: vssaros-memory: never started`，用户端看到的是
 * "command directory warmup failed" 弹窗 ✗✗ —— 而且**每次启动都复现**（版本始终相同 ⇒ 永远不修 ✓）。
 *
 * ⚠ 2026-10-14 续：这一关**只说了"要重装"**，没说"重装得真能换上" —— 同版本同路径下 pnpm 会把它当 no-op
 * （见下面那个 suite）。两关合起来才是闭环：**内容比对（要不要装）＋ 指纹命名（装得进去）**。
 */
suite('dshHarness / 已装副本的内容校验（版本相同也要复查）', () => {

	test('★ 计划阶段：`installed === bundled` 必须再过一次**入口内容**比对', () => {
		const body = fnBody('private _planPluginInstall(');
		const versionEqual = body.indexOf('if (installed === bundled) {');
		const contentCheck = body.indexOf('this._installedEntryMatches(dir!, installedDir)');
		assert.ok(versionEqual > 0, '找不到"版本相同"那一支');
		assert.ok(contentCheck > versionEqual,
			'版本相同**不足以**跳过安装：必须再比对入口内容（本次报障就是被这一条放过的 ✗✗）');
		assert.ok(/已装副本与随包不一致/.test(body), '强制重装必须留一行日志（否则"为什么又装了一遍"没人知道 ✓）');
	});

	test('★ 兜底阶段：`_ensurePlugin` 同样不能只看版本', () => {
		const body = fnBody('private async _ensurePlugin(');
		const versionEqual = body.indexOf('if (installed === bundled) {');
		const contentCheck = body.indexOf('this._installedEntryMatches(dir!,');
		assert.ok(versionEqual > 0 && contentCheck > versionEqual,
			'兜底单装路径也要做内容比对（批量装失败会回退到它 ⇒ 只看版本就还是修不了坏副本 ✗）');
	});

	// ★★ 2026-10-28（真机：打包版 exe 启动卡在"正在启动 VsSaros…"六分钟）：
	//   exe 随包 chat-surface@0.2.243，profile 里已装 0.2.259 ⇒ 只判"不相等"就安排安装 ⇒
	//   **每次启动降级重装 8 个包**（一条 `dsh plugin add` 装 8 个，跑满 4 分钟超时 + 逐项回退再失败）
	//   ⇒ 用户看到的就是长时间卡死。已装更新必须保留。
	test('★ 降级保护：已装比随包**新** ⇒ 不装（exe 比 profile 旧是正常状态）', () => {
		const body = fnBody('private _planPluginInstall(');
		const guard = body.indexOf('isVersionNewer(installed, bundled)');
		assert.ok(guard > 0, '`_planPluginInstall` 必须用 `isVersionNewer` 拦住"降级安装"（否则旧 exe 会把已装的新版本打回去 ✗）');
		assert.ok(body.includes('不降级'), '跳过降级必须留一行日志（否则"为什么没装"没人知道 ✓）');
		// 顺序：必须排在「skipUpgrade 那条跳过」之后（= 已走到"要装"之前就拦住）。
		// ⚠ 不拿函数末尾的 `return { … }` 当锚点：fnBody 切片长度有限，长函数尾会被截掉 ⇒ 假红（实测）。
		const skipAt = body.indexOf('skipUpgrade && installed');
		assert.ok(skipAt > 0 && guard > skipAt, '拦截必须排在 skipUpgrade 之后（顺序反了等于照装 ✗）');
		assert.ok(body.indexOf('return undefined;', guard) > guard, '拦到降级必须 return undefined（不许继续安排安装 ✗）');
	});

	test('★ 校验器保守方向：读不到 = 不一致（宁可白装一遍，也不能带着坏插件起 Host）', () => {
		// 2026-10-14 重构：入口读取抽成 `_readEntryFile`（同一份入口定义要同时服务"内容比对"与
		// "暂存目录指纹"）。断言跟着落点走，**不变量一字不改**。
		const readBody = fnBody('private _readEntryFile(');
		assert.ok(/pkg\?\.main/.test(readBody), '入口名要读 package.json 的 main');
		assert.ok(readBody.includes("join('lib', 'index.js')"),
			'入口名必须以 lib/index.js 兜底（写死入口名会在改入口时静默失效 ✗）');
		assert.ok(readBody.includes('return undefined'),
			'读不到入口（缺文件 / 权限 / 入口名不对）必须返回 undefined（= 不一致）⇒ 重装一次 ✓');
		const cmpBody = fnBody('private _installedEntryMatches(');
		assert.ok(cmpBody.includes('_readEntryFile'),
			'内容比对必须复用同一份入口读取（各写一份 ⇒ 与指纹的定义漂移，一侧说变了另一侧说没变 ✗）');
		assert.ok(cmpBody.includes('want !== undefined') && cmpBody.includes('want === have'),
			'任一侧读不到（undefined）都必须判"不一致"；少了 `want !== undefined` 就是"带着坏插件起 Host" ✗');
	});
});

/**
 * ★ 暂存目录的**内容指纹**（2026-10-14，事故驱动）：**同版本改了内容也必须真装上**。
 *
 * 现场（真机取证，缘由与证据见 `dshHostSupervisor.ts` 的 `_stagePlugin` / `_entryFingerprint` 注释）：
 * `@vssaros/dsh-bridge` 版本恒为 0.2.20、入口内容改过 ⇒ 暂存目录路径逐字未变 ⇒ pnpm 把这条 `file:`
 * 依赖当成"没变化"、**一个字节都不替换** ⇒ 判定阶段**每次启动**都判"已装副本与随包不一致 ⇒ 强制重装"、
 * 每次重装都无效（`node_modules` 里那份的 CreationTime 停在两天前，而同一批装的 kb 是本次）。三个后果：
 *   ① 每次启动白花一次 pnpm（真机实测 8.5 s）；
 *   ② `_pluginsStale` 被置上 ⇒ 放弃复用常驻复用路径（退回冷启动 ~12 s + 回收旧 Host 1.8 s）；
 *   ③ 跑的一直是旧代码，而日志每次都写 `4 ok, 0 to retry`（**用户端唯一的观感是"启动慢"**）。
 *
 * 下面三条守卫钉住闭环：指纹进目录名（换 spec）＋ 复核按内容（看得见"没换上"）＋ 换不上时**显式告警**。
 */
suite('dshHarness / 暂存目录的内容指纹（同版本改内容也要真装）', () => {

	test('★ `_stagePlugin`：目录名 = `<name>-<version>` **+ 入口指纹**（指纹变 ⇒ spec 变 ⇒ pnpm 才会替换）', () => {
		const body = fnBody('private async _stagePlugin(');
		assert.ok(body.includes('fingerprint'), '_stagePlugin 必须接受指纹参数（拿不到时允许退回旧命名 ✓）');
		const destLine = body.split('\n').find(l => l.includes('const dest =')) ?? '';
		assert.ok(destLine.includes('${name}-${version}'),
			'暂存目录仍要按 <name>-<version> 命名（旧版本留给 dsh 回滚 ✓）');
		assert.ok(/\$\{fingerprint \?/.test(destLine),
			'目录名必须再带上入口指纹：只按版本命名时"同版本改了内容"的 spec 逐字不变 ⇒ pnpm 静默 no-op ✗✗');
	});

	test('★ 启动时的批量安装：指纹要传下去，且复核按**内容**（不只是版本）', () => {
		assert.ok(src.includes('this._stagePlugin(w.name, w.dir, w.bundled, pluginProfileDir, w.fingerprint)'),
			'批量暂存必须把计划阶段算出的指纹传下去（漏了 ⇒ 退回同路径 no-op ✗）');
		assert.ok(/const wants: \{[^\n]*fingerprint\?: string \}\[\]/.test(src),
			'`wants` 的元素类型要带上 `fingerprint`（与 `_planPluginInstall` 的返回契约同一口径）');
		const missedLine = src.split('\n').find(l => l.includes('const missed = wants.filter')) ?? '';
		assert.ok(missedLine.includes('_installedEntryMatches'),
			'复核必须**按内容**：只看版本时"内容没换上"会被报成 `N ok`（真机就是这条把 8 秒白花埋掉的 ✗✗）');
	});

	test('★ 兜底单装路径（`_ensurePlugin`）同样带指纹', () => {
		const body = fnBody('private async _ensurePlugin(');
		// ⚠ 不能写 `[^)]*`：第 4 个实参是 `this._profileDir(profile, env)`，本身就带右括号 ⇒ 会永远匹配不上。
		assert.match(body, /this\._stagePlugin\(name, dir!, bundled,[\s\S]{0,200}?_entryFingerprint\(dir!\)/,
			'批量装失败会回退到它 ⇒ 这里漏指纹就还是修不了那份陈旧副本 ✗');
	});

	test('★ 装上却仍是旧内容 ⇒ 必须显式告警（"静默失效"的唯一出口）', () => {
		const staleLine = src.split('\n').find(l => l.includes('同版本重装后入口内容仍与随包不一致')) ?? '';
		assert.ok(staleLine.length > 0,
			'没有这条告警时，"每次启动都重装、每次都说 ok、内容永远不变"在日志里完全看不出来 ✗✗');
		assert.ok(staleLine.includes('⚠'), '要带警示符（日志里一眼看得见 ✓）');
		assert.ok(src.includes('但入口内容仍与随包不一致 ⇒ 跑的是陈旧副本'),
			'启动失败文案的原因列表也要能说出"版本对但副本陈旧"（否则真因被埋在别的报错里 ✗）');
	});

	test('★ 指纹与内容比对必须共用同一份入口定义', () => {
		const fp = fnBody('private _entryFingerprint(');
		assert.ok(fp.includes('_readEntryFile'), '指纹必须读同一个入口定义（各写一份 ⇒ 判定与命名漂移 ✗）');
		assert.ok(/createHash\('sha1'\)/.test(fp), '算法要稳定：换算法 = 全量白重装一次（要在注释里说明）');
	});
});

/**
 * ★ 半成品随包插件（缺入口文件）必须**跳过安装**，而不是每次启动重装（2026-10-15 "还是慢"现场）。
 *
 * 现场：开发中的 `@vssaros/dsh-web-content-import` 只有 `lock/store/routes.js`，`main` 指的
 * `lib/index.js` 还没写 ⇒ 入口读不到 ⇒ 内容比对永远判"不一致" ⇒ **每次启动**强制重装（单次
 * ~4-12s，那启动里被装了 3 次）；更糟的是 `_pluginsStale` 被它钉死在 true ⇒ 常驻 Host 复用
 * **永久关闭** ⇒ 每次启动都付全量冷启动（~16-37s）。装上也没用：Host 照样 `failed to import`。
 *
 * 不变量：两条装插件路径都把"随包缺入口 ⇒ 跳过（大声记日志）"放在任何安装动作之前；
 * `_ensurePlugin` 里跳过**必须先于** `_pluginsStale = true`（否则半成品插件照样关掉 Host 复用 ✗）。
 */
suite('dshHarness / 半成品随包插件（缺入口）⇒ 跳过安装且不拖累 Host 复用', () => {

	const SKIP_TEXT = '随包源码缺入口文件';

	test('★ 两条装插件路径都有"缺入口 ⇒ 跳过"，且带警示符', () => {
		for (const sig of ['private _planPluginInstall(', 'private async _ensurePlugin(']) {
			const body = fnBody(sig);
			assert.ok(body.includes(SKIP_TEXT), `${sig} 缺"缺入口 ⇒ 跳过"（缺了 ⇒ 半成品插件每次启动都白装一遍 ✗）`);
			assert.ok(body.includes('⚠'), `${sig} 的跳过必须带警示符（日志里一眼看得见 ✓）`);
			assert.ok(body.includes('_readEntryFile(dir!) === undefined'),
				`${sig} 的跳过必须以"读不到随包入口"为条件（守卫不能空跑：条件改了这里就是假绿 ✗）`);
		}
	});

	test('★ `_ensurePlugin`：跳过必须先于 `_pluginsStale = true`（否则半成品插件永久关掉 Host 复用）', () => {
		const body = fnBody('private async _ensurePlugin(');
		const skipAt = body.indexOf(SKIP_TEXT);
		const staleAt = body.indexOf('this._pluginsStale = true');
		assert.ok(skipAt > 0 && staleAt > 0, '两处都要存在（守卫不能空跑）');
		assert.ok(skipAt < staleAt, '缺入口跳过必须在置 stale 之前 —— 顺序反了 = 半成品插件把常驻复用永久关掉 ✗✗');
	});

	test('★ `_planPluginInstall` 不置 `_pluginsStale`（判定阶段本来就不该置标记）', () => {
		// 注意断言的是**赋值语句**而不是字符串 `_pluginsStale`：注释里会提到它（解释为什么不置）✓。
		assert.ok(!fnBody('private _planPluginInstall(').includes('this._pluginsStale = true'),
			'判定阶段置标记会让"仅仅检查了一下"也关掉复用 ✗');
	});
});
