/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 技能发现根的**单一真源**（P1，2026-10-13）：dsh 侧覆盖层（`dshHarnessService._skillDirs`）与
 * IDE 侧注册表（`skillRegistryService._doReload`）都读**这一份**清单与门控规则 ✓。
 *
 * 为什么要单一真源（方案稿 `doc/dsh-skill-roots-plan.md` §2 不变量 1）：两侧各自拼目录时，任何一边
 * 单独增删都会造成"IDE 看得见、聊天框看不见"这类**最难查**的不一致 ✗（`skillEcosystemDirs.ts` 头注释
 * 已经记过一次同类事故）。现在顺序、来源标记、trust 门控、开关都只有一处实现 ✓，两侧只负责把**基址**
 * （工作区根 / 数据根 / 官方 DSH_HOME / 内置目录）喂进来 —— 基址两侧算法确实不同（`FileAccess` vs
 * `asFileUri(appRoot)` 多候选），但那属于"怎么定位基址"，不属于"有哪些根、谁优先" ✓。
 *
 * 本模块**纯函数、不碰文件系统**（存在性过滤由两侧各做一次：dsh 侧在主进程 `existsSync`，
 * IDE 侧在 `_scanRootIfPresent` 前 stat ✓）⇒ 可以像纯函数一样单测（见 `test/common/skillRoots.test.ts`）。
 */

/**
 * 技能根的来源等级（与 IDE 侧 `SKILL_SOURCE_RANK`、dsh 侧根顺序同语义）。
 *
 * `'plugin'`（2026-10-13 P2）：**dsh 插件包自带的技能**（`<插件包>/skills`，见
 * `dshPluginSkillRoots.ts`）。在 dsh 里它们与内置同属 bundled 档（rank 600）⇒ 这里排在**最后**
 * （= IDE 里优先级最低，与 dsh 的 rank 表一致 ✓）；在 IDE 里是**只读**来源
 * （不能编辑/卸载/上架，见 `isSkillReadOnly`）—— 它的所有者是插件包，不是用户 ✗。
 */
export type SkillRootScope = 'project' | 'user' | 'builtin' | 'plugin';

/** 由哪个设置开关控制某族根（关掉 = 该族不纳入，且**不**产生"未信任"提示 —— 用户是主动关的 ✓）。 */
export type SkillRootGate = 'projectRoots' | 'officialUserRoot';

/**
 * 一条根规格。**顺序即优先级**：同 rank（dsh 侧都在 `customSkillDirs` 的 rank 300）内 first-wins
 * （依据见 `dshHarnessService._skillDirs` 的注释：`@deepseek-ai/dsh-skill` 的
 * "the nearest layer's entry wins a duplicate name outright"）✓。
 */
export interface ISkillRootSpec {
	/**
	 * 基址来源：`workspace` = **每个**工作区根、`dataRoot` = VsSaros 数据根、
	 * `officialUser` = 官方用户级候选（见 {@link officialUserSkillRootCandidates}）、
	 * `builtin` = 随包资源目录、`dshPluginSkills` = dsh 插件包里的 `skills/` 目录
	 * （见 `dshPluginSkillRoots.ts`；后三者基址本身就是目标目录 ⇒ `rel` 为空串 ✓）。
	 */
	readonly base: 'workspace' | 'dataRoot' | 'officialUser' | 'builtin' | 'dshPluginSkills';
	/** 相对基址的路径（用 `/` 写，拼接时按基址的分隔符归一 ✓）。 */
	readonly rel: string;
	readonly scope: SkillRootScope;
	/**
	 * 是否**只在工作区受信任时**纳入。
	 *
	 * 为什么项目级必须门控：`<工作区>/.dsh/skills` 会被 git clone 带进来 ⇒ 是**提示词注入面**
	 * （`skillEcosystemDirs.ts` 从 2026-10-12 起就把这条写在头上 ✓）。未信任时一律不注入 ✓，
	 * 且**必须给用户一行解释**（`skippedUntrusted` ⇒ 否则就是"静默少一半技能" ✗）。
	 */
	readonly requiresTrust: boolean;
	/** 该族根的总开关（不变量 4：可一键回滚）；省略 = 没有开关、始终纳入 ✓。 */
	readonly gatedBy?: SkillRootGate;
	/**
	 * **只在 IDE 侧**启用（需要 `options.includeIdeOnlyRoots` 才产出 ✓）。
	 *
	 * 为什么会有这种根：`dshPluginSkills`（插件自带的技能）在 dsh 侧是**插件自己注册**的（插件包里那一行
	 * `dsh-skill-filesystem`）⇒ 我们再注一遍就会让同一个技能名被两个 provider 各报一份 ✗。IDE 侧没有
	 * 那套插件机制 ⇒ 必须由这里补上（"以 dsh 插件为唯一来源"的前提 ✓）。不对称是**有意的**，别改成对称 ✗。
	 */
	readonly ideOnly?: boolean;
	/** 日志与提示里用的可读名。 */
	readonly label: string;
}

/**
 * 根清单（**顺序即优先级**；与官方 `dsh-skill-filesystem` 的 rank 表的对齐关系写在每条上）。
 *
 * ⚠ 已知语义差（两处，都照实记，别当 bug 改）：
 * 1. 官方项目级是 **100/200**，而我们只能经 `customSkillDirs` 注入 ⇒ 落 **rank 300**
 *    （`includeDefaultRoots: true` 那条路会让 dsh 自己按 cwd 扫项目目录 ⇒ **我们无法门控 trust** ✗✗，
 *    直接违反不变量 2 ⇒ 放弃）。实际效果：项目级**仍可发现且在我们这一行内优先级最高** ✓。
 * 2. 官方用户级 `~/.dsh/skills` 是 **400**、bundled 是 **600**；我们这一行整体在 300 ⇒ 两者的**相对**
 *    顺序（官方用户级在内置之前 ✓）仍按官方 rank 表摆，只是绝对 rank 被这一行拉到 300 ✓。
 * 3. **插件自带技能**（`dshPluginSkills`）在 dsh 里也是 bundled/600 ⇒ 这里排在**最后**（IDE 里最低优先级），
 *    且只给 IDE 侧（`ideOnly`）—— dsh 侧是插件自己注册的，重复注入 = 同名两份 ✗（见 `dshPluginSkillRoots.ts`）。
 */
export const SKILL_ROOT_SPECS: readonly ISkillRootSpec[] = [
	{ base: 'workspace', rel: '.dsh/skills', scope: 'project', requiresTrust: true, gatedBy: 'projectRoots', label: '项目级 .dsh/skills（官方 rank 100）' },
	{ base: 'workspace', rel: '.agents/skills', scope: 'project', requiresTrust: true, gatedBy: 'projectRoots', label: '项目级 .agents/skills（官方 rank 200）' },
	{ base: 'dataRoot', rel: 'skills', scope: 'user', requiresTrust: false, label: '用户级 <数据根>/skills' },
	{ base: 'officialUser', rel: '', scope: 'user', requiresTrust: false, gatedBy: 'officialUserRoot', label: '官方用户级 <DSH_HOME>/skills（官方 rank 400）' },
	{ base: 'builtin', rel: '', scope: 'builtin', requiresTrust: false, label: '内置 resources/.agents/skills' },
	// ★ 2026-10-13（P2）：**dsh 插件包自带的技能**，只给 IDE 侧（`ideOnly`——dsh 侧由插件自己注册 ✓）。
	//   排在最末 = IDE 里优先级最低，与"dsh 侧它们与内置同为 bundled/600"的语义一致 ✓；
	//   撞名时先到先得 ⇒ 我们自己的内置/用户技能压得住插件技能（不被插件静默改行为 ✓）。
	{ base: 'dshPluginSkills', rel: '', scope: 'plugin', requiresTrust: false, ideOnly: true, label: 'dsh 插件自带技能（<插件包>/skills）' },
];

/**
 * 项目级技能根的开关（方案稿 §2 不变量 4：**可一键回滚**）。
 *
 * 关掉 ⇒ 清单里两条项目级根整个不纳入，行为回到 2026-10-13 之前（只有用户级 + 内置）✓，
 * 且**不再产生"未信任"提示**（用户是主动关的，不是被门控挡的 ⇒ 提示只会是噪音 ✗）。
 */
export const SKILL_PROJECT_ROOTS_SETTING_ID = 'agentStudio.skills.projectRoots';

/**
 * 官方用户级技能根（`<DSH_HOME>/skills`）的开关（2026-10-13 用户拍板"支持"）。
 *
 * 关掉 ⇒ 回到"我们自己的用户库 + 内置"（生态/官方用户目录都不看）✓。
 * 注意它与项目级是**独立**开关：项目级是**注入面**（必须 trust ✓），官方用户级在**用户主目录**下
 * （信任级别与我们自己的 `~/.vssaros/skills` 相同 ✓）⇒ 不需要 trust 门控，只需要一个回滚开关 ✓。
 */
export const SKILL_OFFICIAL_USER_ROOT_SETTING_ID = 'agentStudio.skills.officialUserRoot';

/** 解析所需的基址（由两侧各自算好喂进来，见文件头）。 */
export interface ISkillRootBases {
	/** 工作区根（**全部** folder：多根工作区里每个根的项目技能都算"项目级" ✓，与 dsh 侧一致）。 */
	readonly workspaceFolders: readonly string[];
	/** VsSaros 数据根（`~/.vssaros` / dev 的 `~/.vssaros-dev`）；拿不到就不产出用户级根 ✓。 */
	readonly dataRoot?: string;
	/** 官方用户级候选目录（{@link officialUserSkillRootCandidates} 的产物，可能需要多个 ✓）。 */
	readonly officialUserDirs?: readonly string[];
	/**
	 * 随包资源目录 `resources/.agents/skills` 的**候选**（已在资源目录里 ⇒ 不再拼 `rel` ✓）。
	 *
	 * 为什么是复数：IDE 侧为兼容 dev / 打包 / 浏览器三种形态要试三个候选（`FileAccess` /
	 * `appRoot/resources` / `dirname(appRoot)/resources` ✓），三者都可能存在 ⇒ 交给它全列出 ✓；
	 * dsh 侧只有一个（`FileAccess`）✓。存在性由各侧过滤 ✓（本模块不碰文件系统 ✓）。
	 */
	readonly builtinDirs?: readonly string[];
	/**
	 * **dsh 插件自带技能**的候选目录（`<插件包>/skills`×N）—— 由 `dshPluginSkillRoots.ts` 算出来
	 * （IDE 侧算：读 profile 的 `package.json` + 判目录存在；Host 侧**不喂** ⇒ 那条 `ideOnly` 根不产出 ✓）。
	 */
	readonly dshPluginSkillDirs?: readonly string[];
	/** 生态用户级目录（`skillEcosystemDirs`；当前清单**刻意为空** ✓，接口保留以维持两处消费点同源）。 */
	readonly extraUserDirs?: readonly string[];
}

export interface ISkillRootOptions {
	/** 工作区是否受信任（`IWorkspaceTrustManagementService.isWorkspaceTrusted()`）。 */
	readonly trusted: boolean;
	/** {@link SKILL_PROJECT_ROOTS_SETTING_ID} 的取值。 */
	readonly projectRoots: boolean;
	/** {@link SKILL_OFFICIAL_USER_ROOT_SETTING_ID} 的取值。 */
	readonly officialUserRoot: boolean;
	/**
	 * 是否产出 {@link ISkillRootSpec.ideOnly} 那类根（**只有 IDE 侧传 true** ✓；省略 = 不产出 ⇒
	 * dsh 侧维持"插件自注册、我们不重复注入" ✓，理由见 `ideOnly` 的注释）。
	 */
	readonly includeIdeOnlyRoots?: boolean;
}

/** 一条解析结果：绝对路径 + 来源等级（IDE 侧按 scope 走 rank，dsh 侧只要路径 ✓）。 */
export interface IResolvedSkillRoot {
	readonly fsPath: string;
	readonly scope: SkillRootScope;
	readonly label: string;
}

export interface ISkillRootResolution {
	/** 最终根清单（保序、去重后）。 */
	readonly roots: readonly IResolvedSkillRoot[];
	/** 因**未信任**被跳过的项目级目录：调用方据此给用户一行解释（不要静默 ✗）。 */
	readonly skippedUntrusted: readonly string[];
}

/**
 * **官方用户级技能目录**（rank 400）的候选 —— 路径公式的单一真源（两侧都调它 ✓）。
 *
 * 为什么要三个候选（`<DSH_HOME>/skills` 在我们产品里是哪个目录，取决于运行形态 ✗）：
 * - `dshHome`：用户显式配了 `sessions.dshHarness.dshHome` ⇒ 官方语义下的用户级根就在那儿 ✓；
 * - `dataRoot + '/dsh-home'`：**两种形态的默认 DSH_HOME**（`dshHarnessChannel` 的
 *   `defaultDshHome: join(userDataPath, 'dsh-home')` ✓）。⚠ 2026-10-28 之前只有 dev 走这条
 *   （打包版是 `undefined` ⇒ 回落 `~/.dsh`），两套 profile 因此长期不同步 ⇒ 现在统一走这条，
 *   目标目录是 `~/.vssaros/dsh-home` ✓；
 * - `userHome + '/.dsh'`：**官方 dsh 的默认位置**（用户用独立 dsh 时技能在这里 ✓）。
 *   统一后本产品不再落在这里，但**保留候选**：老数据可能还在、用户也可能手动指过去。
 *
 * 三者可能指向同一目录（用户把 DshHome 指到 `~/.dsh` 时）⇒ 由 {@link resolveSkillRoots} 的去重兜住 ✓；
 * 不存在的候选由各侧的存在性过滤丢掉 ✓（多给一个候选的代价 = 一次 `stat` ✗ 可忽略）。
 */
export function officialUserSkillRootCandidates(homes: { readonly dshHome?: string; readonly dataRoot?: string; readonly userHome?: string }): string[] {
	const candidates: string[] = [];
	if (homes.dshHome?.trim()) {
		candidates.push(joinFsPath(homes.dshHome.trim(), 'skills'));
	}
	if (homes.dataRoot?.trim()) {
		candidates.push(joinFsPath(joinFsPath(homes.dataRoot.trim(), 'dsh-home'), 'skills'));
	}
	if (homes.userHome?.trim()) {
		candidates.push(joinFsPath(joinFsPath(homes.userHome.trim(), '.dsh'), 'skills'));
	}
	return dedupeByKey(candidates, dedupeKey);
}

/**
 * 按基址 + 门控解析出最终根清单（**保序、去重、纯函数**）。
 *
 * 三种"不产出"都**不算错误**（缺基址、开关关闭、未信任）—— 调用方不该据此报错 ✓，但未信任那一种
 * 要通过 {@link ISkillRootResolution.skippedUntrusted} 显式告知用户 ✓。
 */
export function resolveSkillRoots(bases: ISkillRootBases, options: ISkillRootOptions): ISkillRootResolution {
	const roots: IResolvedSkillRoot[] = [];
	const skippedUntrusted: string[] = [];
	for (const spec of SKILL_ROOT_SPECS) {
		// 开关关闭（用户主动）⇒ 整条不纳入，且**不**计入"未信任"提示（不变量 4）✓
		if (spec.gatedBy && !options[spec.gatedBy]) {
			continue;
		}
		// 只给 IDE 侧的根（插件自带技能）：dsh 侧由插件自己注册 ⇒ 不重复注入（理由见 `ideOnly` 注释）✓
		if (spec.ideOnly && !options.includeIdeOnlyRoots) {
			continue;
		}
		for (const base of basesOf(spec, bases)) {
			const fsPath = spec.rel ? joinFsPath(base, spec.rel) : base;
			if (!fsPath) {
				continue;
			}
			if (spec.requiresTrust && !options.trusted) {
				skippedUntrusted.push(fsPath);
				continue;
			}
			roots.push({ fsPath, scope: spec.scope, label: spec.label });
		}
	}
	// 生态用户级：追加在**最后**（与 2026-10-12 起的顺序一致 ✓；清单当前为空 ⇒ 通常一个都不加）
	for (const dir of bases.extraUserDirs ?? []) {
		if (dir) {
			roots.push({ fsPath: dir, scope: 'user', label: '生态用户级（~/.agents 等）' });
		}
	}
	return {
		roots: dedupeByKey(roots, r => dedupeKey(r.fsPath)),
		skippedUntrusted: dedupeByKey(skippedUntrusted, dedupeKey),
	};
}

function basesOf(spec: ISkillRootSpec, bases: ISkillRootBases): readonly string[] {
	switch (spec.base) {
		case 'workspace': return bases.workspaceFolders;
		case 'dataRoot': return bases.dataRoot ? [bases.dataRoot] : [];
		case 'officialUser': return bases.officialUserDirs ?? [];
		case 'builtin': return bases.builtinDirs ?? [];
		case 'dshPluginSkills': return bases.dshPluginSkillDirs ?? [];
	}
}

/**
 * 按**基址自己的分隔符**拼相对路径（渲染进程拿到的 fsPath 在 Windows 上是反斜杠 ✓）。
 * 不能无条件用 `/`：那会产出 `G:\ws/.dsh/skills` 这种混用路径 ⇒ 与主进程/IDE 侧的字面比较对不上 ✗。
 */
function joinFsPath(base: string, rel: string): string {
	const sep = base.includes('\\') ? '\\' : '/';
	const trimmed = base.replace(/[\\/]+$/, '');
	return `${trimmed}${sep}${rel.replace(/[\\/]+/g, sep)}`;
}

/**
 * 去重键：Windows 路径**大小写不敏感**（同一个目录可能一处写 `G:\WS`、一处写 `g:\ws` ⇒ 不过一化就
 * 会被当成两个根，同一技能扫两遍 ⇒ 触发无信息量的"同级内容相同"分支 ✗）。
 */
function dedupeKey(fsPath: string): string {
	const trimmed = fsPath.replace(/[\\/]+$/, '');
	return /^[a-zA-Z]:[\\/]/.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

function dedupeByKey<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of items) {
		const key = keyOf(item);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push(item);
	}
	return out;
}
