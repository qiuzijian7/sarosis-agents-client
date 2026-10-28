/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **第三方 dsh 插件**的识别与升级判据（2026-10-28，纯逻辑、无 I/O）。
 *
 * ## 为什么要这一层
 *
 * dsh 的插件就是 profile 的 pnpm 依赖（`dsh plugin --profile <p> <pnpm-args...>` 原样转发）。
 * 本仓对**随包插件**有完整闭环（启动时判定 + 批量安装 + 内容指纹 + 不降级），
 * 但**用户自己 `dsh plugin add` 装的第三方插件**完全没有入口：既不知道装了什么，也没有升级按钮，
 * 只能自己去敲 pnpm —— 而这恰恰是"从 GitHub / npm 装了个开源插件"最常见的场景。
 *
 * ## 关键约束：升级方式取决于依赖形态
 *
 * profile 里的依赖有三种形态，**不能用同一条命令升**：
 *   · `^1.2.3` / `1.2.3` / `latest` —— registry 包 ⇒ `plugin add <name>@latest` 安全 ✓；
 *   · `git+https://…` / `github:user/repo` —— git 源 ⇒ 重新 add **同一个 spec** 才会取新 commit；
 *     若贸然写成 `@latest`，pnpm 会把它**改成 registry 版本**（源都换了 ✗✗）；
 *   · `file:` / `link:` / `workspace:` —— 本地目录 ⇒ 升级 = 更新那个目录再重启 Host；
 *     对它执行任何 `add` 都可能把本地链接换成注册表版本 ✗。
 *
 * ⇒ 只有 registry 形态才提供"升级到最新"按钮；git / 本地只做**如实展示 + 说明怎么做**。
 *   这比"一律给个按钮"难写，但"点一下把用户 GitHub 装的插件换成 npm 上的另一个包"是不可接受的。
 */

/** profile 依赖的形态。 */
export type PluginSpecKind =
	/** registry 版本范围（可安全 `@latest` 升级）。 */
	| 'registry'
	/** git / GitHub 源（要重新 add 原 spec 才取新 commit）。 */
	| 'git'
	/** 本地目录（`file:` / `link:` / `workspace:`）——升级 = 更新目录后重启 Host。 */
	| 'local'
	/** 读不懂（`""` / `undefined` / 奇怪协议）。 */
	| 'unknown';

/** 一条第三方插件（profile 里用户自己装的）。 */
export interface IThirdPartyPlugin {
	readonly name: string;
	/** profile 里记录的依赖 spec（如 `^1.2.3` / `github:user/repo` / `file:…`）。 */
	readonly spec: string;
	readonly kind: PluginSpecKind;
	/** 已装版本（读 profile 的 `node_modules/<name>/package.json`；读不到为空）。 */
	readonly installedVersion?: string;
	/**
	 * 能否一键升级（只有 registry 形态为真；见文件头的三条约束）。
	 * 为假时不提供按钮 —— 但仍要展示 name/version，让用户知道"这个我装过、该怎么升"。
	 */
	readonly upgradable: boolean;
}

/** 本仓随包插件在 profile 里的暂存目录特征（我们自己的 `file:` 依赖都长这样）。 */
const STAGED_DIR_HINT = '/.vssaros/plugins/';

/**
 * 判定一条依赖 spec 的形态。
 *
 * ⚠ 顺序要紧：`file:` 可能指向 git 仓库的本地克隆，必须先判本地再判其它；
 *   而 `@scope/name` 里也有 `/`，所以 git 的"含斜杠"判据必须放在"scoped 包名"之后。
 */
export function classifyPluginSpec(spec: string | undefined): PluginSpecKind {
	const s = String(spec ?? '').trim();
	if (!s) {
		return 'unknown';
	}
	const lower = s.toLowerCase();
	if (lower.startsWith('file:') || lower.startsWith('link:') || lower.startsWith('workspace:') || lower.startsWith('portal:')) {
		return 'local';
	}
	if (lower.startsWith('git+') || lower.startsWith('git:') || lower.startsWith('git@')
		|| lower.startsWith('github:') || lower.startsWith('gitlab:') || lower.startsWith('bitbucket:')
		|| lower.startsWith('http://') || lower.startsWith('https://')) {
		return 'git';
	}
	// `user/repo`（pnpm 的 GitHub 简写，不带协议前缀）
	if (/^[^\s@][^\s/]*\/[^\s/]+$/.test(s)) {
		return 'git';
	}
	// registry：`1.2.3` / `^1.2.3` / `~1` / `>=1 <2` / `*` / `latest` / `next`
	// ⚠ 比较符允许**多个**（`>=` / `<=`）：只允许一个时 `>=1 <2` 会被判成 unknown ⇒ 用户装过的这种写法
	//   就永远不给升级按钮（实测被守卫抓到）。
	// ⚠ `*` / `x` 单独出现也是 registry 的"任意版本"写法（少了这条，这类依赖就不给升级按钮 ✗）。
	if (s === '*' || s === 'x' || /^[\^~<>=*]{0,2}\s*v?\d/.test(s) || /^(latest|next|beta|alpha|rc)$/i.test(s)) {
		return 'registry';
	}
	return 'unknown';
}

/**
 * 从 profile 依赖里挑出**用户自己装的第三方插件**。
 *
 * 排除两类（都不是"第三方"，也不归这个入口管）：
 *   ① 名字在 `ownPackageNames` 里 —— 随包插件（由启动时的安装流程负责）；
 *   ② spec 指向 `.vssaros/plugins/<包>-<版本>-<指纹>` —— 我们自己暂存目录里的包
 *      （随包与伴生插件都以这种 `file:` 形态落进 profile，见 `_stagePlugin`）。
 *
 * @param dependencies profile `package.json` 的 `dependencies`
 * @param ownPackageNames 随包插件包名集合（含伴生插件）
 * @param readInstalled 读已装版本（由调用方做 I/O；返回 undefined = 读不到）
 */
export function pickThirdPartyPlugins(
	dependencies: Readonly<Record<string, string>> | undefined,
	ownPackageNames: readonly string[],
	readInstalled: (name: string) => string | undefined,
): IThirdPartyPlugin[] {
	const own = new Set(ownPackageNames);
	const out: IThirdPartyPlugin[] = [];
	for (const [name, spec] of Object.entries(dependencies ?? {})) {
		if (own.has(name)) {
			continue;
		}
		const raw = String(spec ?? '');
		if (raw.includes(STAGED_DIR_HINT)) {
			continue;   // 我们自己暂存的随包/伴生插件（file: 指向 .vssaros/plugins）
		}
		const kind = classifyPluginSpec(raw);
		out.push({
			name,
			spec: raw,
			kind,
			installedVersion: readInstalled(name),
			upgradable: kind === 'registry',
		});
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}

/**
 * 一键升级时该传给 `dsh plugin add` 的 spec。
 *
 * 只有 registry 形态返回（`<name>@latest`）；其它返回 undefined ⇒ 调用方必须拒绝执行，
 * 并把"该怎么做"告诉用户（见 `describeManualUpgrade`）。
 */
export function upgradableSpecOf(plugin: Pick<IThirdPartyPlugin, 'name' | 'kind'>): string | undefined {
	return plugin.kind === 'registry' ? `${plugin.name}@latest` : undefined;
}

/** 非 registry 插件的"手动升级"说明（要能照着做，不许只说"请手动升级"）。 */
export function describeManualUpgrade(kind: PluginSpecKind, name: string): string {
	switch (kind) {
		case 'git':
			return `${name} 是从 git / GitHub 装的：拉最新代码后重新执行一次同样的 add（写 @latest 会把源换成 npm 上的同名包）`;
		case 'local':
			return `${name} 是本地目录：把那个目录更新到最新后重启 Host（启动时会按入口内容自动重装）`;
		case 'unknown':
			return `${name} 的依赖写法读不懂（详见 profile 的 package.json），请手动处理`;
		default:
			return `${name} 可以直接升级`;
	}
}
