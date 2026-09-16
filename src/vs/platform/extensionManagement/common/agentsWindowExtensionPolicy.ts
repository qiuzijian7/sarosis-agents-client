/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agents（sessions）窗口的「原生扩展」执行策略。
 *
 * 背景：上游 VS Code 的 agents 窗口只允许**不具备可执行代码**的声明式扩展
 * （主题 / 语法 / 语言 / 键位 …）运行，判据分别是
 * `IExtensionManifestPropertiesService.canExecuteOnSessionsWindow()` 与
 * `ExtensionEnablementService._isDisabledBySessionsWindow()`。
 * 本项目要「兼容 VS Code 原生插件」，于是把这条硬编码规则换成
 * **默认保守、可显式放开**的策略，并把判据下沉为纯函数以便单测。
 *
 * 设计文档：`doc/native-extensions-in-agents-window-plan.md`（L0 = 本模块 + 设置；L2 = 策略生效）。
 *
 * 本模块**无 DI、无 IO、无副作用**（纯函数），可被 platform / workbench 任意层引用。
 */

/** 策略设置键：`declarative` | `allowlist` | `all`。 */
export const AGENTS_WINDOW_EXTENSION_MODE_SETTING = 'saros.extensions.agentsWindow.mode';

/** 白名单设置键（仅 `allowlist` 模式生效）。支持 `publisher.name` / `publisher.*` / `*`。 */
export const AGENTS_WINDOW_EXTENSION_ALLOWLIST_SETTING = 'saros.extensions.agentsWindow.allowlist';

/**
 * 是否放行「Agent 贡献型扩展」的设置键（默认 `true`）。
 *
 * 这类扩展**有代码**，但只贡献 `agentCapabilities` / `chatPlugins`（+ 声明式贡献点），
 * 即本产品专门设计的「用 VS Code 扩展给 Agent 提供能力/插件」通道：
 *   · `contributes.agentCapabilities` → `AgentCapabilitiesExtensionPointRegistry`
 *     （`sessions/contrib/agentStudio/browser/agentCapabilitiesExtensionPoint.ts`）
 *   · `contributes.chatPlugins`       → `ExtensionAgentPluginDiscovery`
 *     （`workbench/contrib/chat/common/plugins/agentPluginServiceImpl.ts`）
 *
 * 上游的 agents 窗口规则（有 `main`/`browser` 一律禁用）会让这两条通道**永远不触发**，
 * 所以默认放行（这正是「兼容原生插件」要达成的效果）。想严格维持上游行为就设为 `false`。
 */
export const AGENTS_WINDOW_EXTENSION_AGENT_CONTRIBUTIONS_SETTING = 'saros.extensions.agentsWindow.allowAgentContributions';

/** 上面的「Agent 能力 / 插件」贡献点集合（有代码也放行的判断依据之一）。 */
export const AGENT_PROVIDING_CONTRIBUTION_POINTS: readonly string[] = [
	'agentCapabilities',
	'chatPlugins',
];

export const enum AgentsWindowExtensionMode {
	/** 默认：沿用上游行为 —— 只放行声明式扩展（无代码）。 */
	Declarative = 'declarative',
	/** 声明式 + 白名单里的扩展（白名单扩展允许带代码）。 */
	Allowlist = 'allowlist',
	/** 除产品级黑名单外全部放行（逃生门；代价见设计文档 §4.2）。 */
	All = 'all',
}

export interface IAgentsWindowExtensionPolicy {
	readonly mode: AgentsWindowExtensionMode;
	readonly allowlist: readonly string[];
	/** 是否放行「Agent 贡献型扩展」（有代码但只贡献 agentCapabilities/chatPlugins）。 */
	readonly allowAgentContributions: boolean;
}

/**
 * 产品级黑名单：即使策略为 `all` 也不在 agents 窗口运行。
 * 这些扩展要求 GitHub 认证，而 VsSaros 用 TOF 认证（`sessions.agentStudio.tof`）。
 */
export const AGENTS_WINDOW_EXTENSION_BLOCKLIST: readonly string[] = [
	'GitHub.copilot',
	'GitHub.copilot-chat',
];

/**
 * 产品级必需扩展：必须在 agents 窗口运行（与策略无关）。
 * 不放行会导致 `Timed out waiting for authentication provider 'tof' to register`。
 */
export const AGENTS_WINDOW_EXTENSION_REQUIRED: readonly string[] = [
	'saros.tof-authentication',
];

export const DEFAULT_AGENTS_WINDOW_EXTENSION_POLICY: IAgentsWindowExtensionPolicy = {
	mode: AgentsWindowExtensionMode.Declarative,
	allowlist: [],
	allowAgentContributions: true,
};

/**
 * 宽容解析配置。**任何**未知/非法输入都回落到默认策略（绝不抛异常）——
 * 设置文件可能被手写、也可能来自旧版本。
 */
export function resolveAgentsWindowExtensionPolicy(
	raw: { readonly mode?: unknown; readonly allowlist?: unknown; readonly allowAgentContributions?: unknown } | undefined | null,
): IAgentsWindowExtensionPolicy {
	const mode = raw?.mode;
	const allowlist = raw?.allowlist;
	const allowAgentContributions = raw?.allowAgentContributions;

	return {
		mode: isAgentsWindowExtensionMode(mode) ? mode : AgentsWindowExtensionMode.Declarative,
		allowlist: Array.isArray(allowlist)
			? allowlist.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
			: [],
		// 只有显式 `false` 才关闭：未配置 / 类型不对都按"放行"（这是产品的 Agent 插件通道）。
		allowAgentContributions: allowAgentContributions === false ? false : true,
	};
}

export function isAgentsWindowExtensionMode(value: unknown): value is AgentsWindowExtensionMode {
	return value === AgentsWindowExtensionMode.Declarative
		|| value === AgentsWindowExtensionMode.Allowlist
		|| value === AgentsWindowExtensionMode.All;
}

/** 单个模式匹配：`*`（全部）、`publisher.*`（出版商前缀）、`publisher.name`（精确）。大小写不敏感。 */
export function matchesExtensionPattern(pattern: string, extensionId: string): boolean {
	const p = (pattern ?? '').trim().toLowerCase();
	const id = (extensionId ?? '').trim().toLowerCase();
	if (!p || !id) {
		return false;
	}
	if (p === '*') {
		return true;
	}
	if (p.endsWith('.*')) {
		return id.startsWith(p.slice(0, -1));
	}
	return p === id;
}

export function matchesAnyExtensionPattern(patterns: readonly string[], extensionId: string): boolean {
	return patterns.some(pattern => matchesExtensionPattern(pattern, extensionId));
}

/**
 * 该扩展的 `contributes` 是否属于**Agent 贡献型**：至少含一个 Agent 贡献点，
 * 且**其余**贡献点全都在（声明式允许集 ∪ Agent 贡献点）内 —— 即它带代码也只为了做 Agent 能力/插件提供者。
 *
 * @param contributionPoints `Object.keys(manifest.contributes ?? {})`
 * @param declarativeAllowedPoints 上游的声明式允许集（`SESSIONS_WINDOW_ALLOWED_CONTRIBUTION_POINTS`）
 */
export function isAgentContributingContributionSet(
	contributionPoints: readonly string[],
	declarativeAllowedPoints: ReadonlySet<string>,
): boolean {
	const agentPoints = contributionPoints.filter(point => AGENT_PROVIDING_CONTRIBUTION_POINTS.includes(point));
	if (agentPoints.length === 0) {
		return false;
	}
	return contributionPoints.every(point =>
		AGENT_PROVIDING_CONTRIBUTION_POINTS.includes(point) || declarativeAllowedPoints.has(point)
	);
}

/**
 * 最终判定：该扩展能否在 agents（sessions）窗口运行。
 *
 * @param policy 解析后的策略
 * @param extensionId 扩展 id（`publisher.name`）
 * @param isDeclarativeAllowed 上游判定（`canExecuteOnSessionsWindow(manifest)`）——即"纯声明式扩展"是否放行
 * @param isAgentContributing 是否属于「Agent 贡献型扩展」（见 `isAgentContributingContributionSet`）；
 *        这类扩展**有代码**，是本产品「用扩展给 Agent 提供能力/插件」的正式通道 ⇒
 *        默认放行（`policy.allowAgentContributions`），否则两条桥永远不触发。
 * @returns `true` = 允许运行（不被 agents 窗口禁用）
 *
 * 注意：**内置扩展**与「是否被用户在全局禁用」不在这里判定（由调用方在更早的步骤处理）。
 */
export function isAllowedToRunInAgentsWindow(
	policy: IAgentsWindowExtensionPolicy,
	extensionId: string,
	isDeclarativeAllowed: boolean,
	isAgentContributing = false,
): boolean {
	if (matchesAnyExtensionPattern(AGENTS_WINDOW_EXTENSION_BLOCKLIST, extensionId)) {
		return false;
	}
	if (matchesAnyExtensionPattern(AGENTS_WINDOW_EXTENSION_REQUIRED, extensionId)) {
		return true;
	}

	// 只有**显式 false** 才关闭（`policy` 可能是手写的字面量、也可能来自旧版本，
	// 缺字段时必须保持"默认放行"，与 `resolveAgentsWindowExtensionPolicy` 同口径）。
	const agentContributingAllowed = policy.allowAgentContributions !== false && isAgentContributing;

	switch (policy.mode) {
		case AgentsWindowExtensionMode.All:
			return true;
		case AgentsWindowExtensionMode.Allowlist:
			return matchesAnyExtensionPattern(policy.allowlist, extensionId) || isDeclarativeAllowed || agentContributingAllowed;
		case AgentsWindowExtensionMode.Declarative:
		default:
			return isDeclarativeAllowed || agentContributingAllowed;
	}
}
