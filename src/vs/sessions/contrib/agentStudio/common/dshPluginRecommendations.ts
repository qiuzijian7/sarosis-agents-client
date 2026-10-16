/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「添加插件」入口的**策展清单**（方案 A，2026-10-12；2026-10-13 扩为两类）。
 *
 * **为什么需要它**（调研结论见 `doc/native-extensions-in-agents-window-plan.md` §4.4）：**dsh 侧没有官方插件商城**——
 * 安装入口只有 `dsh plugin add <spec>`（转发给 pnpm，见 `dsh/lib/bin.js:116`），来源四类：
 * npm 注册表 / git / tarball / 本地绝对路径；插件管理 UI 也没有"浏览/发现"页。⇒ **"发现"这一层只能我们自己提供**，
 * 这份清单就是最小的那一层：内容全部取自运行时里**真的声明了 `dsh.bundle.patch`** 的官方包（可核实、非臆造），
 * 以后换成从我们的商城服务拉（`IMarketplaceService`，见 doc §4.4.1 形态 B）。
 *
 * **为什么不列"随包模块"**：那些已经由 `listBundledPlugins()` 在「随包模块」段里列出（**零网络**可装）；
 * 这里是**没随发行装上的可选组合包**——必须走 npm 装一次。
 *
 * ★ **两类条目，版本来源不同（别混）**（2026-10-13）：
 *  1. `OFFICIAL_OPTIONAL_BUNDLES`：**官方**包（`@deepseek-ai/*`）。dsh 会在 pnpm 运行前检查 DSH peer，
 *     不匹配直接拦下 ⇒ 拿得到 profile 的 dsh 版本就**钉到那个版本**（`dshPluginRecommendations(dshVersion)`），
 *     拿不到就不写版本（走 npm `latest`，由 dsh 的预检兜底）。
 *  2. `CURATED_THIRD_PARTY_BUNDLES`：**第三方**包（不是 `@deepseek-ai/*`）。它们的版本与 dsh 版本**无关**
 *     ⇒ **必须显式钉 `pinVersion`**（拿 dsh 版本去套就是拼出一个不存在的版本号 ✗）。
 *
 * ⚠ **这一档现在（2026-10-14 起）刻意是空的** ✓ —— 别当成"漏了条目"：里头原来唯一的条目 `@tt-a1i/archify-dsh`
 *   被用户要求改成 **"默认随包自动装"**，落地形态是 **vendored 进 `dsh-plugins/vssaros-archify/`**
 *   （由 `DshHostSupervisor` 当**伴生插件**在起 Host 前自动装；零网络、离线可用 ✓，provenance 见该目录的
 *   `VENDOR.md`）⇒ 它**不再**需要用户点一次"推荐卡片"，也就不该继续留在这份"可选安装"清单里
 *   （两处并存会变成"两条安装路径 + 可能的两个 provider" ✗ —— 2026-10-13 刚消灭过这种重复交付 ✓）。
 *   机制**保留**（接口 + `pinVersion` 纪律 + 守卫），理由同 `skillRoots.ts` 的 `extraUserDirs`：给下一个
 *   第三方包留一条现成的、带纪律的通道 ✓。
 *
 *     ⚠ 加第三方包的三条纪律（守卫见 `dshHarness/test/common/dshPluginsView.test.ts` +
 *     `agentStudio/test/common/dshPluginRecommendations.test.ts`）：① 必须有 `pinVersion`；
 *     ② 必须在守卫的 allowlist 里登记（新加包要显式改测试 = 有意为之，不是漏看）；
 *     ③ `note` 里必须写明"第三方"与实际作用（用户在装之前就该知道这是谁的东西 ✗ 别让他以为是官方的）。
 *     ⚠ 另一条判据：**如果它也该"默认随包"**，那它进的是 `dsh-plugins/`（vendored），**不是**本清单 ✓。
 */

export interface IDshPluginRecommendation {
	/** 直接作为 `dsh plugin add` 的 spec，也是 `inspectBundle` / `installBundle` 的入参。 */
	readonly spec: string;
	readonly label: string;
	/** 一句话说明（渲染成卡片第二行）。 */
	readonly note: string;
	/** 来源类型：内置清单目前只有 `npm`（官方包发布在公共 npm 上，见 §4.4 证据 8）。 */
	readonly sourceType: 'npm' | 'git' | 'tarball' | 'local';
}

/** 官方可选组合包的条目形状（`pinVersion` 不在此类里用：版本由 `dshVersion` 决定 ✓）。 */
interface IOfficialOptionalBundle {
	readonly pkg: string;
	readonly label: string;
	readonly note: string;
}

/** 第三方包的条目形状：`pinVersion` **必填**（不随 dsh 版本走 ✗）。 */
interface ICuratedThirdPartyBundle {
	readonly pkg: string;
	/** 钉死的版本（第三方包与 dsh 版本无关；留空就是拼出不存在版本号的隐患 ✗）。 */
	readonly pinVersion: string;
	readonly label: string;
	readonly note: string;
}

/**
 * 官方可选组合包。
 *
 * 来源：运行时 `node_modules/@deepseek-ai/*` 里声明了 `dsh.bundle.patch` 的包（共 10 个；其中
 * `dsh-base` / `dsh-web-app` / `dsh-headless` / `dsh-sdk-app` / `dsh-sdk-minimal` / `dsh-acp-app`
 * 是**应用外壳**，不适合往已有 profile 里装）⇒ 剩下这四个才是"可选插件组合包"。
 */
const OFFICIAL_OPTIONAL_BUNDLES: readonly IOfficialOptionalBundle[] = [
	{
		pkg: '@deepseek-ai/dsh-experimental-voice-input-bundle',
		label: '语音输入',
		note: '把语音转成输入（SenseVoice 本地模型，首次安装需联网拉依赖）。',
	},
	{
		pkg: '@deepseek-ai/dsh-experimental-schedule-bundle',
		label: '定时任务',
		note: '按时间触发的任务/提醒（配合 schedule 工具使用）。',
	},
	{
		pkg: '@deepseek-ai/dsh-experimental-agent-team-profile',
		label: 'Agent 团队',
		note: '多 Agent 分工协作的组合（团队模式）。',
	},
	{
		pkg: '@deepseek-ai/dsh-experimental-auto-review',
		label: '自动评审',
		note: '回合结束后自动复盘/评审产出。',
	},
];

/**
 * **我们策展的第三方组合包**（`@deepseek-ai/` 之外）—— **当前刻意为空** ✓（理由见文件头）。
 *
 * 为什么空着还留着这个数组：这是第三方包的**唯一合法入口**（带 `pinVersion` + allowlist + "写明第三方"三条纪律），
 * 删掉它下次要加第三方包的人只会往官方档里塞（那档的版本规则完全不同 ⇒ 拼出不存在的版本号 ✗）。
 *
 * ⚠ `pinVersion` 是**必填**（理由见文件头 ★ 两类条目）：第三方包与 dsh 版本无关，写成 `${pkg}@${dshVersion}`
 * 会指向一个不存在的版本号。**加了就要**同步守卫测试里的 allowlist（✗ 别只改一处）。
 */
const CURATED_THIRD_PARTY_BUNDLES: readonly ICuratedThirdPartyBundle[] = [
	// 空。原来的唯一一条 `@tt-a1i/archify-dsh@1.0.0`（2026-10-13 登记）已于 2026-10-14 移出：
	// 用户要求"默认随包自动装" ⇒ 改为 vendored 进 `dsh-plugins/vssaros-archify/`（零网络、离线可用，
	// 由 DshHostSupervisor 随包自动安装）。**别把它加回来**：那会让同一件事有两条安装路径
	//（其中一条还要用户点、还要联网）✗。守卫 `test/common/dshPluginRecommendations.test.ts` 钉着
	// "这一档为空 + 随包副本在且版本一致"这条唯一性 ✓。
];

/**
 * 取策展清单；`dshVersion` 非空时把**官方**包钉到该版本（与 profile 的 dsh 版本对齐，避免被 peer 检查拦下）。
 *
 * 第三方包固定用各自的 `pinVersion`（**不**跟 `dshVersion` 走 ✓）。
 */
export function dshPluginRecommendations(dshVersion?: string): readonly IDshPluginRecommendation[] {
	const suffix = dshVersion ? `@${dshVersion}` : '';
	return [
		...OFFICIAL_OPTIONAL_BUNDLES.map(b => ({
			spec: `${b.pkg}${suffix}`,
			label: b.label,
			note: b.note,
			sourceType: 'npm' as const,
		})),
		...CURATED_THIRD_PARTY_BUNDLES.map(b => ({
			spec: `${b.pkg}@${b.pinVersion}`,
			label: b.label,
			note: b.note,
			sourceType: 'npm' as const,
		})),
	];
}
