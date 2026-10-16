/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * **跨源码契约守卫**：钉住 4.52 / 4.53 那两条"Host 实时应用失败 ⇒ 退回文件级"所依赖的上游形态。
 *
 * 这些字符串分别定义在 dsh 自己的 `pluginManager`、`dsh-hmr`、`dsh-app-boot`，以及绿色桥
 * `vssaros-bridge` 里——**没有任何一处会被我们的编译器检查到**。上游改一个键名、改一个枚举、
 * 或桥侧少转一个字段，我们这边照旧编译通过、照旧回"成功"，只是**什么也没发生**（或者界面只剩
 * "操作失败"，查不出为什么——README 4.51 就是这么被卡住的）。所以在这里逐条钉住：
 * 一旦漂移，先在这里红，而不是在用户点"禁用"时白点。
 *
 * 找不到上游源码时**跳过**（测试进程的 cwd 不是仓库根、或依赖没装）——这是"契约提醒"，不是门禁，
 * 不该在别的环境里变成假红。
 */
const readIfExists = (relative: string): string | undefined => {
	const file = path.join(process.cwd(), relative);
	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
};

/** 跳过时的统一说明（把"为什么什么都没查"写进输出，避免把跳过误读成通过）。 */
const SKIP = '（跳过：仓库内找不到该源码——测试进程的 cwd 不是仓库根）';

const MANAGER = 'dsh-runtime/0.2.0-rc.2/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js';
const HMR = 'dsh-runtime/0.2.0-rc.2/node_modules/@deepseek-ai/dsh-hmr/lib/index.js';
const APP_BOOT = 'dsh-runtime/0.2.0-rc.2/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js';
const BRIDGE = 'dsh-plugins/vssaros-bridge/lib/index.js';
const STORE = 'src/vs/sessions/contrib/dshHarness/electron-main/dshPluginActivationStore.ts';

suite('dsh 插件管理的上游契约（4.52 / 4.53 的文件级兜底据它成立）', () => {

	test('上游写行级覆盖的形态：`disabled: !enabled` / 新条目只带 id+disabled / mode 384 / 取最后一条且排除 insert', () => {
		const src = readIfExists(MANAGER);
		if (!src) { assert.ok(true, SKIP); return; }
		// 这些字面量是 `setRowDisabledOverride` 的"真值来源"：任何一条变了，我们的写入都读不回来
		for (const fragment of [
			'document.setIn([items.indexOf(target), "disabled"], !enabled)',   // 键名是 disabled，值 = !enabled
			'document.add({',                                                 // 找不到就新建条目……
			'disabled: !enabled',                                             // ……且只带 id + disabled（我们追加的形态与它逐字一致）
			'writeFileAtomic(filename, String(document), { mode: 384 })',     // 落盘 0o600（我们的 store 也传 0o600）
			'item.has("insert")',                                             // `insert:` 里的行不是可覆盖条目
			'findLast(',                                                      // 同 id 取**最后**一条
			'=== !enabled) return false',                                     // 幂等：已是目标态就不写盘
		]) {
			assert.ok(src.includes(fragment), `dsh-plugin-manager 里找不到「${fragment}」⇒ 4.53 的写入器已与上游脱钩（会静默地写不生效）`);
		}
	});

	test('★ 上游传的是 `row.patchId` / `row.moduleName` 而不是 `entryId`（我们查补丁行不是多余的）', () => {
		const src = readIfExists(MANAGER);
		if (!src) { assert.ok(true, SKIP); return; }
		// 通道里那条兜底要先把 renderer 给的 `entryId` 换算成补丁行，换算规则就写在这一行里；
		// 它同时说明"目标文件是 profile 的 patch"（我们写同一个文件才对得上）。
		assert.ok(
			src.includes('writePluginEnabled(this.profile.patchPath, row.patchId, row.moduleName, enabled)'),
			'dsh 的 setPluginEnabled 不再按 (patchPath, patchId, moduleName) 写 patch ⇒ 我们的 entryId→patchId 换算与 moduleName 匹配已失效');
	});

	test('★ 失败与状态枚举：`application = "failed"` / `operation-error` + `diagnostic` / `applied|restart-required`', () => {
		const src = readIfExists(MANAGER);
		if (!src) { assert.ok(true, SKIP); return; }
		// ① 通道那条兜底的判据就是它；② 桥把 `error.code`→errorCode、`error.diagnostic`→diagnostic；
		// ③ 成功侧的标签判据（上游用**运行时** hmr 判定，我们读文件、方向更保守）。
		for (const fragment of [
			'result.application = "failed";',
			'"operation-error"',
			'diagnostic: messageOf(error)',
			'application: this.ownerContext.get("hmr") !== void 0 ? "applied" : "restart-required"',
		]) {
			assert.ok(src.includes(fragment), `dsh-plugin-manager 里找不到「${fragment}」⇒ 我们对 application / errorCode / diagnostic 的判读已与上游脱钩`);
		}
	});

	test('★ "root Include entry" 这条路径的哨兵（上游一改，我们就要复核兜底与标签）', () => {
		const src = readIfExists(APP_BOOT);
		if (!src) { assert.ok(true, SKIP); return; }
		// 这条诊断是**上游 WeakMap 未命中**的唯一信号（`bootstrapIncludes` 以 root context 为 key，
		// 查不到就 throw）。4.52–4.55 的文件级兜底就是为它而设：这句没了/改了，说明上游动过这条路径，
		// "兜底还要不要留、`via`/标签怎么报"都要重新看一遍——所以这里钉住原文与那个标识符。
		assert.ok(src.includes('profile reload requires the root Include entry'),
			'dsh-app-boot 不再抛这条 ⇒ 上游改过 "root Include entry" 路径：请复核 4.52–4.55 的兜底与标签口径');
		assert.ok(src.includes('bootstrapIncludes') && src.includes('bootstrapIncludes.get(ctx)'),
			'找不到 `bootstrapIncludes.get(ctx)` ⇒ 判定方式变了（不再是"模块私有 WeakMap 以 root ctx 为 key"）');
	});

	test('★ 必须"同一模块实例"的 dsh 包：清单在位 + 启动前真的收敛（4.58 的根因）', () => {
		// 4.58：profile 的 `node_modules` 里另有一份 `dsh-app-boot`（pnpm 装插件时当传递依赖带进来的）
		// ⇒ **两个模块实例** ⇒ 它那份**模块私有 WeakMap** 里没有 root Include entry ⇒ 实时重组必抛
		// `profile reload requires the root Include entry`。修法是把 profile 侧收敛成指向运行时的**联接**
		// （Node 按 realpath 缓存 ⇒ 同一实例）。这条守卫盯住"别再把这个动作丢掉/改成复制"。
		const cli = readIfExists('src/vs/sessions/contrib/dshHarness/common/dshCli.ts');
		const sup = readIfExists('src/vs/sessions/contrib/dshHarness/electron-main/dshHostSupervisor.ts');
		if (!cli || !sup) { assert.ok(true, SKIP); return; }
		assert.ok(/DSH_SHARED_INSTANCE_PACKAGES[\s\S]{0,240}@deepseek-ai\/dsh-app-boot/.test(cli),
			'`DSH_SHARED_INSTANCE_PACKAGES` 里必须有 `@deepseek-ai/dsh-app-boot`（少它就退回"实时启停必失败"）');
		assert.ok(/_dedupeSharedPackages\(/.test(sup) && /resolveSiblingPackage\(dsh\.bin, pkg\)/.test(sup),
			'启动路径必须调用收敛，且目标要从**运行时**那边解析（`resolveSiblingPackage(dsh.bin, …)`）');
		assert.ok(/symlink\([^)]*'junction'\)/.test(sup),
			'收敛必须用 junction：**复制会再造一个实例**（等于白干）');
	});

	test('★ profile patch 的文件名两侧同名（我们写的就是 dsh 读的那一个）', () => {
		const upstream = readIfExists(APP_BOOT);
		const ours = readIfExists(STORE);
		if (!upstream || !ours) { assert.ok(true, SKIP); return; }
		// 上游把这个文件名定义为常量（`dsh-app-boot`），dsh-hmr 也用同一个去 watch。
		// 我们 store 里是**字面量** ⇒ 上游一改名，我们就会写进一个"没人读"的文件，且完全静默。
		assert.ok(upstream.includes('"cordis.patch.yml"'), 'dsh-app-boot 里找不到 profile patch 的文件名常量 ⇒ 我们写死的那份可能已经不对了');
		assert.ok(ours.includes("'cordis.patch.yml'"), '我们的 store 不再写 `cordis.patch.yml` ⇒ 与 dsh 读的不是同一个文件（行级兜底会静默失效）');
	});

	test('dsh-hmr 把 patch 文件纳入重载输入并逐个 watch ⇒ 写 profile patch 有热重载的机会', () => {
		const src = readIfExists(HMR);
		if (!src) { assert.ok(true, SKIP); return; }
		// 这解释了"为什么改完文件可以让它自己生效"（也是 `applied` 这个标签的依据）：
		// 重载签名由 bundles + patch 文件内容组成，且 patch 文件是**逐个 watch** 的、
		// 走 `refresh(false)`（不因 bundles 未变而早退）。上游改成只盯 package.json 的话，
		// 我们的文件级兜底就只剩"下次启动生效"，标签口径得跟着改回 restart-required。
		assert.ok(src.includes('const patchFiles = [profile.patchPath, join(profile.home, PROFILE_PATCH_FILENAME)];'),
			'dsh-hmr 的重载输入不再包含 profile patch ⇒ 文件级兜底不再是"热重载"，标签要改');
		assert.ok(src.includes('for (const filename of patchFiles) await this.watchConfig(filename, () => refresh(false));'),
			'dsh-hmr 不再逐个 watch patch 文件（或改成 manifestOnly）⇒ 写 patch 不会触发重载');
	});

	test('★ 绿色桥必须继续转发 application / stage / diagnostic，并把启停交给 Host 的 pluginManager', () => {
		const src = readIfExists(BRIDGE);
		if (!src) { assert.ok(true, SKIP); return; }
		// 桥是"上游结果 → 我们看得懂的形状"的唯一转换点：少转一个字段，通道那头就是 `undefined`，
		// 界面只剩"操作失败"（4.51 的病根）。判据（第 7 行）也说明这里必须用 `error.diagnostic`——
		// 上游把诊断**嵌在 error 里**，不是在顶层。
		for (const fragment of [
			'application: res?.application ?? null',
			'stage: res?.stage ?? null',
			'res?.error?.diagnostic',
			'mgr.setPluginEnabled(id.trim(), enabled)',
		]) {
			assert.ok(src.includes(fragment), `vssaros-bridge 里找不到「${fragment}」⇒ 启停结果/诊断在过桥时被丢掉`);
		}
	});
});
