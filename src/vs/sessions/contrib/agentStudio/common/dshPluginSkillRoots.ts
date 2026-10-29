/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **dsh 插件自带的技能**（`<插件包>/skills/<name>/SKILL.md`）的路径解析 —— IDE 侧技能库的补充来源。
 *
 * 为什么要它：单一真源 `skillRoots.ts` 已经覆盖了 dsh 能看到的**几乎全部**技能来源，只差一个 ——
 * 插件包自己带的技能。那条路是**插件自己**在 `cordis.patch.yml` 里插一行 `dsh-skill-filesystem`
 * （`bundledSkillDir` 指到包内 `skills/`）注册的，例如第三方插件 `@tt-a1i/archify-dsh` ✓。
 * 对 dsh 来说它是可见的；**对 IDE 技能库它此前完全不存在** ✗ ⇒ "以 dsh 插件为唯一来源"这类决定
 * 会让技能从 IDE 侧消失（2026-10-13 用户拍板：补上这一来源 ✓）。
 *
 * ★ **有意的不对称**（别当 bug 改成对称）：这批目录**只给 IDE 侧**当技能根（`skillRoots.ts` 的
 * `ideOnly` ✓），**不给 dsh 侧**。原因：插件已经自己注册过一遍了，我们再注一遍 ⇒ 同一个技能名
 * 由两个 provider 各报一份（rank 还同为 bundled/600）⇒ "模型拿到哪一份"取决于 dsh 的同名裁决顺序
 * ✗ —— 那正是这次要消灭的"同一技能两份、版本还可能不同"✗。⇒ IDE 侧补来源、dsh 侧维持"插件自注册" ✓。
 *
 * 取哪些插件：`dsh.profile.bundles` —— 与插件中心"启用/停用"**同一份真源**
 * （`dshPluginActivation.ts` 头注释：列在 `bundles` 里的包才会被组合 ✓）。
 *
 * ⚠ 已知缺口（照实记，别当 bug 修）：
 *  1. **行级停用**看不出来：插件的某一行被 `disabled: true` 时 `bundles` 不变 ⇒ 这里仍会列出它的技能
 *     （表现为 IDE 多显示一份 dsh 其实没加载的）。等真出现这种插件再补。
 *  2. 只认 `<包根>/skills` 这个**约定目录**。插件的 `bundledSkillDir` 是 `!!js` 表达式、在 host 才求值
 *     ⇒ 指到别处的（非约定）插件 IDE 看不见。加插件时按约定放 `skills/` 即可（`dsh-skill-filesystem`
 *     也只认"被扫根**顶层**的 `<name>/SKILL.md`"，`poc/dsh-p0/scripts/p3-52-archify-skill.mjs` 的 B2 有断言 ✓）。
 *
 * 纯函数、零 I/O（读 profile、判目录是否存在由调用方做）⇒ 可像纯函数一样单测 ✓。
 */

import { DSH_DEFAULT_PROFILE } from '../../dshHarness/common/dshHarness.js';
import { parseProfileBundles } from '../../dshHarness/common/dshPluginActivation.js';

/** 解析 profile 目录所需的基址（与 `officialUserSkillRootCandidates` 的**同一组** DSH_HOME 候选 ✓）。 */
export interface IDshHomeBases {
	/** 用户显式配的 `$DSH_HOME`（`sessions.dshHarness.dshHome`）。 */
	readonly dshHome?: string;
	/** VsSaros 数据根（`~/.vssaros` / dev 的 `~/.vssaros-dev`）；dev 的 DSH_HOME 在它下面。 */
	readonly dataRoot?: string;
	/** 用户主目录（打包版回落到 `~/.dsh`）。 */
	readonly userHome?: string;
}

/**
 * DSH_HOME 候选（**按优先级**）—— 与 `skillRoots.ts` 的 `officialUserSkillRootCandidates` 同一组基址
 * （那边再各自拼 `/skills`，这里拼 `/profiles/<profile>` ✓）。
 *
 * 顺序理由见 `officialUserSkillRootCandidates` 的注释（设置项 → dev 默认 → 打包版回落）✓；
 * 留空/空白设置项一律当没配（`getValue` 返回空串是常态 ✗）。
 */
export function dshHomeCandidates(homes: IDshHomeBases): string[] {
	const out: string[] = [];
	const dshHome = homes.dshHome?.trim();
	if (dshHome) {
		out.push(dshHome);
	}
	const dataRoot = homes.dataRoot?.trim();
	if (dataRoot) {
		// 2026-10-28：userData 按形态分开 ⇒ 两边结构一致，一条即可
		out.push(joinFsPath(dataRoot, 'dsh-home'));
	}
	const userHome = homes.userHome?.trim();
	if (userHome) {
		out.push(joinFsPath(userHome, '.dsh'));
	}
	return dedupePaths(out);
}

/**
 * dsh **profile 目录**候选（`<DSH_HOME>/profiles/<profile>`，保序去重）。
 *
 * `profile` 留空 ⇒ 用产品默认 profile（`DSH_DEFAULT_PROFILE`，与 Host 启动时同一个常量 ✓）。
 */
export function dshProfileDirCandidates(homes: IDshHomeBases & { readonly profile?: string }): string[] {
	const profile = homes.profile?.trim() || DSH_DEFAULT_PROFILE;
	return dshHomeCandidates(homes).map(home => joinFsPath(home, 'profiles', profile));
}

/**
 * 一个 profile 的 `package.json` → 该 profile 里**已启用插件**自带的技能根候选
 * （`<插件包>/skills`，按 `dsh.profile.bundles` 的顺序，保序去重）。
 *
 * 解析规则（与 pnpm 落盘形态对齐，实测 dev profile 两种都出现过 ✓）：
 *  - `dependencies[name]` 是 `file:` 前缀 ⇒ 取它后面的**路径**：绝对路径按原样，相对路径按
 *    `profileDir` 解析（dev 的随包插件就是 `file:.vssaros\plugins\vssaros-dsh-…-0.3.9` ✓）；
 *  - 其余（注册表版本号 `1.0.0`）⇒ `<profileDir>/node_modules/<name>`（`@tt-a1i/archify-dsh` 就是这种 ✓）；
 *  - `bundles` 里有但 `dependencies` 里没有的（`@deepseek-ai/dsh-base` 这类由 dsh 运行时提供的）**跳过**
 *    —— 它们的包不在 profile 里，硬拼路径只会得到一条永远不存在的根 ✗。
 *
 * ⚠ 不判存在（纯函数）：调用方按"根存在才产出"的既有口径过滤（各侧各做一次 ✓）。
 */
export function dshPluginSkillRootCandidates(profilePackageJson: unknown, profileDir: string): string[] {
	const bundles = parseProfileBundles(profilePackageJson);
	if (!bundles.length || !profileDir.trim()) {
		return [];
	}
	const deps = readDependencies(profilePackageJson);
	const out: string[] = [];
	for (const name of bundles) {
		const dir = resolveDependencyDir(name, deps[name], profileDir);
		if (dir) {
			out.push(joinFsPath(dir, 'skills'));
		}
	}
	return dedupePaths(out);
}

function readDependencies(profilePackageJson: unknown): Record<string, unknown> {
	const pkg = asObject(profilePackageJson);
	const deps = pkg ? asObject(pkg['dependencies']) : undefined;
	return deps ?? {};
}

/** 一个依赖名 + spec → 包目录（解析不出来就返回 undefined，绝不猜）。 */
function resolveDependencyDir(name: string, spec: unknown, profileDir: string): string | undefined {
	if (typeof spec !== 'string' || !spec.trim()) {
		return undefined;
	}
	const raw = spec.trim().replace(/^["']|["']$/g, '');
	if (!raw.startsWith('file:')) {
		// 注册表依赖（`1.0.0` / `^1.2.3`）：pnpm 把它装在 profile 的 node_modules 下。
		return joinFsPath(profileDir, 'node_modules', ...name.split('/'));
	}
	const target = raw.slice('file:'.length).trim();
	if (!target) {
		return undefined;
	}
	// 绝对路径（`C:/…` / `C:\…` / `\\server\share` / `/home/…`）按原样；相对路径挂到 profile 目录下。
	return isAbsoluteFsPath(target) ? target : joinFsPath(profileDir, target);
}

function isAbsoluteFsPath(p: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/');
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * 按**基址自己的分隔符**拼路径（Windows 基址上不能混进正斜杠 ⇒ 与 `skillRoots.ts` 同一口径 ✓）。
 *
 * ⚠ 分隔符用 `/[\\/]/` 字符类做**字面**替换，**不要**用 `new RegExp('\\' + sep + '+')` 那种拼法：
 * 在模板串里 `\\` 只剩一个反斜杠，拼出来的正则变成 `^\++`（匹配加号 ✗）—— 本仓已为同类坑吃过亏。
 */
function joinFsPath(base: string, ...segments: readonly string[]): string {
	const sep = base.includes('\\') ? '\\' : '/';
	const normalize = (s: string) => s.replace(/[\\/]+/g, sep);
	const trimSep = (s: string) => s.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
	const head = trimSep(normalize(base));
	const tail = segments
		.filter(s => !!s)
		.map(s => trimSep(normalize(s)))
		.filter(s => !!s)
		.join(sep);
	return tail ? `${head}${sep}${tail}` : head;
}

/**
 * 去重：Windows 路径**大小写与分隔符都不敏感**（同一个目录一处写 `C:\X\plug`、一处写 `c:/x/plug` ⇒
 * 不过一化就会被当成两个根、同一技能扫两遍 ⇒ 触发无信息量的"同级内容相同"分支 ✗）。
 *
 * ⚠ 与 `skillRoots.ts` 的 `dedupeKey` **不同**（那边只处理大小写）：那条根清单里的路径**都是我们自己
 * 拼的**（分隔符一定与基址一致 ✓）；而这里的路径来自 profile 的 `package.json` —— `file:` spec 由
 * pnpm 写盘，实测两种分隔符都出现过（`file:C:/…` 与 `file:.vssaros\plugins\…` ✗）⇒ 必须连分隔符一起归一。
 * 只在**盘符路径**上做归一：POSIX 下反斜杠是合法文件名字符，不该被折叠（多给一个候选的代价 = 多扫一次，
 * 把它们当同一个目录才是真错 ✗）。
 */
function dedupePaths(paths: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of paths) {
		const trimmed = raw.replace(/[\\/]+$/, '');
		if (!trimmed) {
			continue;
		}
		const key = /^[a-zA-Z]:[\\/]/.test(trimmed) ? trimmed.replace(/[\\/]+/g, '/').toLowerCase() : trimmed;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push(trimmed);
	}
	return out;
}
