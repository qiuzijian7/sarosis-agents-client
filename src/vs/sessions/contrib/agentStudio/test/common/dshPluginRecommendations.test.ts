/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「添加插件」策展清单的**行为**守卫（2026-10-13 建立；2026-10-14 因 archify 改随包而改口径）。
 *
 * 为什么要有（背景）：第三方条目曾经是 archify 的**唯一来源**（`@tt-a1i/archify-dsh`）——
 * 清单拼错 spec 的代价是"用户点了也装不上"✗✗。两类条目的版本来源**不同**，这正是最容易写错的一处：
 *   · 官方包 `@deepseek-ai/*`：版本跟 profile 的 dsh 版本（否则被 dsh 的 peer 预检拦下）；
 *   · 第三方包：与 dsh 版本**无关** ⇒ 必须钉自己的 `pinVersion`（套 dsh 版本会拼出不存在的版本号 ✗）。
 *
 * ★ 2026-10-14 的变化：archify 按用户要求改成 **"默认随包自动装"** ⇒ 落地形态是 **vendored 进
 *   `dsh-plugins/vssaros-archify/`**（零网络、离线可用；由 `DshHostSupervisor` 当伴生插件在起 Host 前自动装）。
 *   因此第三方档**刻意为空**，而本文件多了一条**唯一性**断言：清单里没有它 **且** 随包副本在、版本一致、
 *   技能本体在位 —— 只做一半（删清单没 vendored / vendored 没删清单）都会在这里红 ✓。
 *
 * 与 `dshHarness/test/common/dshPluginsView.test.ts` 的分工：那边是**源码契约**（allowlist / 视图接线），
 * 这边是**真调函数**（拼出来的 spec 到底对不对）+ 随包副本的存在性核对 —— 只查源码形态会漏掉"分支写反了"这类错 ✗。
 *
 * 运行：node src/vs/sessions/contrib/agentStudio/test/common/run-all-common-tests.mjs
 */

import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import { dshPluginRecommendations } from '../../common/dshPluginRecommendations.js';

/** 官方包判定：清单里唯一的另一类就是第三方（同一口径在 `dshPluginsView.test.ts` 里用前缀断言 ✓）。 */
const isOfficial = (spec: string) => spec.startsWith('@deepseek-ai/');

/** 随包 vendored 的 archify（"默认随包自动装"的落地形态；provenance 见该目录的 `VENDOR.md`）。 */
const VENDORED_ARCHIFY_REL = 'dsh-plugins/vssaros-archify';
const ARCHIFY_PKG = '@tt-a1i/archify-dsh';
/** 记录版本：与 `dshPluginPackages.test.ts` 的 `VENDORED_THIRD_PARTY` 同一口径（换字节要一起改 ✓）。 */
const ARCHIFY_VERSION = '1.0.0';

suite('策展清单 · 两类条目的版本来源（官方跟 dsh / 第三方钉死）', () => {

	test('★ 拿到 profile 的 dsh 版本时：官方包全部套上它', () => {
		const items = dshPluginRecommendations('0.2.0-rc.2');
		const official = items.filter(i => isOfficial(i.spec));
		assert.ok(official.length >= 1, '官方可选组合包不该为空（清单里那四条）');
		for (const item of official) {
			assert.ok(item.spec.endsWith('@0.2.0-rc.2'),
				`官方包必须钉到 profile 的 dsh 版本（否则 dsh 的 peer 预检会拦下）：${item.spec}`);
		}
	});

	test('★ 拿不到 dsh 版本时：官方包不写版本（走 npm latest，由 dsh 的预检兜底）', () => {
		for (const item of dshPluginRecommendations(undefined).filter(i => isOfficial(i.spec))) {
			assert.ok(!/^@deepseek-ai\/[^@]+@/.test(item.spec),
				`没有 dsh 版本就不该给官方包编一个版本（走 latest，由 dsh 的预检兜底）：${item.spec}`);
		}
	});

	test('★ 第三方档**当前刻意为空**（archify 已改随包 vendored），且空着也适用 pinVersion 纪律', () => {
		// 断言"空"而不是"非空"：这是 2026-10-14 的决定（见文件头）✓。谁把它加回来，就得先回答
		// "为什么这个包不用随包"（并同步 `dshPluginsView.test.ts` 的 allowlist）—— 有意为之的摩擦 ✓。
		const third = dshPluginRecommendations('0.2.0-rc.2').filter(i => !isOfficial(i.spec));
		assert.deepStrictEqual(third.map(i => i.spec), [],
			'第三方档应为空：archify 已改为随包 vendored（`dsh-plugins/vssaros-archify/`），别再造出第二条安装路径 ✗');
		// 万一将来加回来：pinVersion 那套纪律仍照查（空数组时是 no-op ✓ —— 但为空的理由已由上面那句钉住 ✓）
		for (const item of third) {
			assert.match(item.spec, /^@[^@]+\/\S+@\d+\.\d+\.\d+/,
				`第三方 spec 必须带**钉死的 semver 版本**（dsh plugin add 靠它可复现）：${item.spec}`);
			assert.ok(!item.spec.endsWith('@0.2.0-rc.2'),
				`第三方包**不能**跟 dsh 版本走（它与 dsh 版本无关，套上去就是拼出不存在的版本号 ✗）：${item.spec}`);
			assert.ok(item.note.includes('第三方'),
				'第三方条的说明里必须写明"第三方"（装之前用户就该知道这是谁的东西，别让他以为是官方的 ✗）');
			assert.strictEqual(item.sourceType, 'npm', '当前只有 npm 来源那条链被验证过（git/tarball 没验）');
		}
	});

	test('★ "默认随包"的落地形态唯一：随包副本在、版本一致、技能本体与 patch 都在', () => {
		// 这条把"移出策展清单"与"vendored 进 dsh-plugins"**绑在一起**：
		//   · 只删清单忘了 vendored ⇒ 用户两头都拿不到（比改动前更糟 ✗）；
		//   · 只 vendored 忘了删清单 ⇒ 两条安装路径并存（一条还要联网、还要用户点）✗。
		// 两种都在这条红 ✓。
		const root = process.cwd();
		const pkgPath = path.join(root, VENDORED_ARCHIFY_REL, 'package.json');
		assert.ok(fs.existsSync(pkgPath), `archify 的随包副本不见了：${pkgPath}（"默认随包自动装"就靠它 ✓）`);
		const json = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string; version?: string };
		assert.strictEqual(json.name, ARCHIFY_PKG,
			'随包副本必须**保留上游包名**（改成 @vssaros/* 就会与 npm 上那份变成两个 provider 各报一个 archify 技能 ✗）');
		assert.strictEqual(json.version, ARCHIFY_VERSION,
			`随包副本版本应为 ${ARCHIFY_VERSION}（换字节要同步 dshPluginPackages.test.ts 的 VENDORED_THIRD_PARTY + VENDOR.md ✓）`);
		assert.ok(fs.existsSync(path.join(root, VENDORED_ARCHIFY_REL, 'cordis.patch.yml')),
			'随包副本必须带 cordis.patch.yml —— 没有它，插件装上了也**不挂载**技能（技能库/聊天里都看不到 ✗）');
		assert.ok(fs.existsSync(path.join(root, VENDORED_ARCHIFY_REL, 'skills', 'archify', 'SKILL.md')),
			'随包副本里必须有技能本体（skills/archify/SKILL.md）——缺了就是"装了插件但没技能" ✗');
	});

	test('每条都有非空的 label / note（卡片渲染不出来就是"看不见的可选项"✗）', () => {
		for (const item of dshPluginRecommendations('0.2.0-rc.2')) {
			assert.ok(item.label.trim().length > 0, `缺 label：${item.spec}`);
			assert.ok(item.note.trim().length > 0, `缺 note：${item.spec}`);
			assert.ok(item.spec.trim().length > 0, '缺 spec（会被当成空输入，装不了）');
		}
	});
});
