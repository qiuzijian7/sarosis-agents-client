/**
 * **中立配置源**：把一个 dsh Host 需要的全部 `--patch` 覆盖层，收敛成一个**可序列化的输入对象**
 * （落盘名见 {@link DSH_HOST_CONFIG_FILENAME}）。
 *
 * 为什么要有它：这些覆盖层原本只由 VsSaros 主进程按 `IDshHostLaunchOptions` 渲染
 * （`dshHostSupervisor` 里那一串 `renderXxxOverlay(...)` + `overlays.push(...)`）。于是"同一个 Host"在
 * **没有 VsSaros** 的入口（独立启动器 / `scripts/dsh-standalone-smoke.mjs`）下只能各自重写一遍渲染 ——
 * 两份一旦漂移就是**静默错配**：dev 实例读生产数据、覆盖层打空不报错（与 README 4.79 同类的坑）。
 * 这里把"配置 → 覆盖层"做成**纯函数**，两个入口都调它 ⇒ 渲染只有一处真源。
 *
 * 两条硬约束（都与主进程逐条对齐，改动前先看 `dshHostSupervisor.startWithDsh`）：
 * 1. **顺序固定**：bridge → kanban → codebase → mcp → skills → agents → dataRoot → memory。
 *    覆盖层是"后者覆盖前者"（同一行被两份覆盖层打时 `config` 是整体替换）⇒ 顺序变了语义就变。
 * 2. **空值不渲染**：字段缺失或全空白 ⇒ **不产生那一条**（而不是渲染一条空覆盖层）。
 */

import {
	renderAgentsOverlay, renderBridgeOverlay, renderCodebaseOverlay, renderDataRootOverlay,
	renderKanbanOverlay, renderMemoryOverlay, renderSandboxOverlay,
	type IDshBrowserOverlayConfig,
} from './dshCli.js';
import { IDshMcpServerSpec, renderMcpOverlay } from './dshMcpConfig.js';
import { renderSkillsOverlay } from './dshSkillDirs.js';

/** 中立配置的落盘名（放在 `<DSH_HOME>/` 下；启动器按它找）。 */
export const DSH_HOST_CONFIG_FILENAME = 'vssaros.config.json';

/** 伴生插件（bridge）要的管道与一次性 token；缺任一项就不注入这条覆盖层。 */
export interface IDshBridgeConfig {
	readonly pipe: string;
	readonly token: string;
	/** 有官方 DeepSeek 凭据时**不**隐藏官方入口（与主进程 `!this._hasDeepseekCredential(...)` 同义）。 */
	readonly hideOfficialDeepseek: boolean;
	readonly welcomeNoticeVersion?: string;
	/**
	 * Host 空闲自退 TTL（毫秒）；不传回落桥插件默认 **30 分钟**（`IDLE_TTL_DEFAULT_MS`）。
	 * 解法 A（2026-10-15 首启慢调研）：30 分钟太短 ⇒ IDE 重启间隔稍长 Host 就自杀 ⇒ 下次又是一次 ~27s 冷启 ✗。
	 */
	readonly idleTtlMs?: number;
}

/**
 * Host 空闲自退 TTL（解法 A：Host 驻留更久 ⇒ 二次启动 ~0s）。
 *
 * 取值权衡：12h 覆盖一个工作日的多次重启（吃饭/开会/下班前重开都命中 ✓）；过夜回落一次冷启 ✓。
 * 安全性：orphan-reap 会在下次启动清掉漏网 Host ✓；插件版本变更 ⇒ `_pluginsStale` ⇒ 不接管旧 Host ✓
 * ⇒ 不存在"挂着旧版本常驻"的悬挂态 ✗。
 */
export const DSH_HOST_IDLE_TTL_MS = 12 * 60 * 60_000;

/**
 * {@link DSH_HOST_IDLE_TTL_MS} 的**人话说法**（给设置项的 `markdownDescription` 用）。
 *
 * 为什么做成函数而不是在文案里写死 ✗：这段文案**曾经**写的是"空闲 30 分钟自动退出"，而解法 A
 * （2026-10-15）把值改成 12 小时之后它就**变成假话**了（用户按设置看到的是 30 分钟，实际 12 小时）
 * ⇒ 由常量派生就**结构性**不会再漂移 ✓；`dshHostConfig.test.ts` 里另有一条把默认值钉住的断言
 * （改动常量会红 ⇒ 强制复审这条用户可见文案 ✓）。
 */
export function hostIdleTtlText(ms: number = DSH_HOST_IDLE_TTL_MS): string {
	// 整小时才用"小时"，否则用"分钟"（30 分钟那种既有的更短取值仍读得通 ✓）。
	if (ms > 0 && ms % 3_600_000 === 0) {
		return `${ms / 3_600_000} 小时`;
	}
	return `${Math.max(1, Math.round(ms / 60_000))} 分钟`;
}

/**
 * 一个 dsh Host 的**全部**可注入配置。字段名与主进程的 `IDshHostLaunchOptions` 同口径
 * （`dataRoot` / `workspaceId` / `workspaceRoot` / `relatedRoots` / `agentsRoot` / `skillDirs` /
 * `mcpConfigPath`），新增字段时**两侧一起改**并由 `dshHostConfigContract` 守卫兜住。
 */
export interface IDshHostConfig {
	readonly bridge?: IDshBridgeConfig;
	/** VsSaros 用户数据根（`~/.vssaros` / dev 的 `~/.vssaros-dev`）：kb / canvas / workflow / skills / 看板都用它。 */
	readonly dataRoot?: string;
	/** Agent Studio 工作区 id：看板按它过滤。 */
	readonly workspaceId?: string;
	/** 工作区根目录：代码图谱按 `<root>/.codebase-memory/` 定位。 */
	readonly workspaceRoot?: string;
	/** 关联根（多工作区）：一起交给代码图谱。 */
	readonly relatedRoots?: readonly string[];
	/** agent 目录（chat 框列出的 agent 来自这里）。 */
	readonly agentsRoot?: string;
	/**
	 * **内置** agent 目录（dsh 侧的 Agents 页/聊天框要能列出内置 agent ⇒ 必须有这条）。
	 *
	 * ⚠ 它**不是真源**：真源是 `common/builtinAgents.ts`（2026-10-19 收敛，`resources/.agents/agents/`
	 *   已整目录删除）。Host 进程读不到产品源码 ⇒ 只能在启动期把代码真源**生成**成一份 md 副本
	 *   （`buildAgentMd()`）放这里，道理与 `bundledSkillDir` 完全一致（产品资源目录 → 绝对路径注入）。
	 *   插件按"用户目录同 id 优先"与 `agentsRoot` 合并 ✓。
	 */
	readonly agentsBuiltinRoot?: string;
	/** 技能目录（须真实存在；调用方过滤，渲染器不查盘）。⚠ **不含内置** —— 内置走下面的 `bundledSkillDir`。 */
	readonly skillDirs?: readonly string[];
	/**
	 * **内置**技能目录（`resources/.agents/skills`，须真实存在）：渲染成同一行的 `bundledSkillDir`
	 * ⇒ 在 dsh 里落 **rank 600**（官方 `BUNDLED_SKILL_RANK`），不再与用户/项目根同档 300 ✓。
	 */
	readonly bundledSkillDir?: string;
	/** **已解析**的 MCP 服务器清单（纯：本模块不读盘）。 */
	readonly mcpServers?: readonly IDshMcpServerSpec[];
	/** MCP 配置**路径**（`renderDataRootOverlay` 会把它写进对应行的 `config.path`）。 */
	readonly mcpConfigPath?: string;
	/** 记忆网关地址（模块的口径是 `config.gatewayUrl`；拿不到就不渲染 —— 尊重它"不猜端口"的纪律）。 */
	readonly gatewayUrl?: string;
	/**
	 * **知识库存储根**（用户在 IDE 里改过 `agentStudio.knowledge.storage.path` 才有值 ✓）：
	 * 不注入时 kb 只认 `<数据根>/knowledge-base` ⇒ 用户改过存储根的话，dsh 侧**空着且不报错** ✗
	 * （2026-10-12 评估发现的缺口 ✓）。canvas 跟着它走（同根 ✓）。
	 */
	readonly kbRoot?: string;
	/**
	 * **库记录**（2026-10-15）：IDE storage 里 `agentStudio.kb.vaults` 的展示字段，**已序列化成 JSON 字符串**
	 * （渲染器只写 YAML scalar ✓）。给 kb 插件的**页面**用它显示"名字 / 图标"，而不是把 uid 目录名当库名 ✗
	 * —— 名字/图标只存在 IDE storage 里（盘上没有 ✗，真机核过 ✓）。
	 *
	 * ⚠ 与 `kbRoot` 同一份覆盖层（整体替换 ⇒ 拆开会互相擦掉 ✗）。
	 */
	readonly kbVaults?: string;
	/** 同上：**当前激活的库 id**（`agentStudio.kb.active` ✓）—— 页面据此只显示一个库 ✓。 */
	readonly kbActiveVaultId?: string;
	/**
	 * **Unreal bridge 基址**（用户在 IDE 里改过 `sessions.agentStudio.unreal.bridgeUrl` 才有值 ✓）：
	 * 此前 dsh 侧**没有等价配置键** ✗（只能靠环境变量 ✓）⇒ 设置改了、Host 仍连默认 8765 ✓。
	 */
	readonly unrealBridgeUrl?: string;
	/**
	 * **`browser` 插件的三个旋钮**（用户在 IDE 里改过对应设置才有值 ✓：`sessions.agentStudio.browserCdp.
	 * {port,launchDedicated,headless}`）。
	 *
	 * 为什么必须注入：Host 是独立进程、**读不到 IDE 设置** ⇒ 此前这三个键改了**不生效** ✗（插件只认自己的
	 * `config` 或 `VSSAROS_BROWSER_*`）⇒ 关掉「自动拉起调试实例」也照样拉起一个**空 profile** 的专属实例，
	 * 把"你自己那个 Chrome（带登录态）"那条路静默绕过（2026-10-14 用户报"抓已登录站点先撞登录墙"时定位到）。
	 */
	readonly browser?: IDshBrowserOverlayConfig;
	/**
	 * **沙箱模式覆盖**（只在启动期探针探不通时才有值，见 `common/dshSandboxCompat.ts`）：
	 * 本机禁止写完整性标签 ⇒ dsh 默认的 `workspace-write`（Windows 的 `windows-acl` 档）**每次
	 * 工具调用**都会在 grant 阶段失败 ✗ ⇒ 降成 `danger-full-access`（不再需要 grant ✓）。
	 * 不给值 ⇒ 保持 dsh 默认（不产生覆盖层 ✓）。
	 */
	readonly sandboxMode?: string;
	/**
	 * **沙箱降级专用的工作区根**（2026-10-13 补的缺口）：没有打开工作区文件夹时，`workspaceRoot` 为空
	 * ⇒ 而 `renderSandboxOverlay` 必须**同时**写 `mode` 与 `workspaceRoot`（那行的 `config` 是整体替换 ✗）
	 * ⇒ 旧条件 `sandboxMode && workspaceRoot` 会让降级**静默失效** ✗（现场＝每条 `pwsh` 都被问
	 * "escalate sandbox"，见 `dshSandboxCompat.ts` 的说明）。
	 *
	 * ⚠ 刻意与 `workspaceRoot` **分开**：那个字段同时喂给**代码图谱**那行 ⇒ 用它顶会让图谱去读
	 * `~/.codebase-memory`（空着且不报错 ✗✗）。这里只服务沙箱行 ✓，取值见 `SANDBOX_FALLBACK_ROOT` ✓。
	 */
	readonly sandboxWorkspaceRoot?: string;
}

/** 覆盖层种类（也是落盘文件名的前缀，见 {@link hostOverlayFileName}）。 */
export type DshHostOverlayKind = 'bridge' | 'kanban' | 'codebase' | 'mcp' | 'skills' | 'agents' | 'dataRoot' | 'memory' | 'sandbox';

/** 覆盖层文件名的前缀：与主进程 `bridge-<id>.yml` / `roots-<id>.yml` 等**逐字一致**。 */
export const DSH_HOST_OVERLAY_PREFIX: Readonly<Record<DshHostOverlayKind, string>> = {
	bridge: 'bridge', kanban: 'kanban', codebase: 'codebase', mcp: 'mcp',
	skills: 'skills', agents: 'agents', dataRoot: 'roots', memory: 'memory', sandbox: 'sandbox',
};

/** 覆盖层的文件名（主进程与独立启动器共用同一套命名，便于人工比对 run 目录）。 */
export function hostOverlayFileName(kind: DshHostOverlayKind, id: string): string {
	return `${DSH_HOST_OVERLAY_PREFIX[kind]}-${id}.yml`;
}

/** 一条待写盘的覆盖层。 */
export interface IDshHostOverlay {
	readonly kind: DshHostOverlayKind;
	readonly text: string;
}

const trimmed = (v: unknown): string | undefined => {
	if (typeof v !== 'string') { return undefined; }
	const t = v.trim();
	return t === '' ? undefined : t;
};
const strings = (v: unknown): readonly string[] => Array.isArray(v)
	? v.map(trimmed).filter((x): x is string => !!x)
	: [];

/**
 * 配置 → 覆盖层（**顺序与条件都与 `dshHostSupervisor` 一致**）。
 *
 * 纯函数：不读盘、不查目录存在性（`skillDirs` 的过滤由调用方做 —— 主进程用 `existsSync` 过滤）。
 */
export function renderHostOverlays(config: IDshHostConfig): readonly IDshHostOverlay[] {
	const out: IDshHostOverlay[] = [];
	const bridge = config.bridge;
	if (bridge && trimmed(bridge.pipe) && trimmed(bridge.token)) {
		out.push({
			kind: 'bridge',
			text: renderBridgeOverlay(
				bridge.pipe, bridge.token, !!bridge.hideOfficialDeepseek, trimmed(bridge.welcomeNoticeVersion),
				bridge.idleTtlMs,
				// ★ 2026-10-15（"unknown prompt variable {{cwd}}" 的修法 A）：工作区根传给渲染 ——
				//   官方默认 personaSuffix 带 {{cwd}}，子代理作用域里不可解析 ⇒ 子代理每轮必炸 ✗；
				//   烘焙成字面量后所有作用域都能渲 ✓（详见 dshCli.ts 里 system-prompt 行的注释）。
				config.workspaceRoot,
			),
		});
	}
	const dataRoot = trimmed(config.dataRoot);
	const workspaceId = trimmed(config.workspaceId);
	if (workspaceId) {
		// 数据根与工作区 id 写在**同一份**覆盖层里：看板文件在 `<数据根>/taskboard.json` ⇒ 不注入时 dev 实例
		// 会读**生产**看板（而且那是**写**路径 ✗）。同一行的 `config` 被两份覆盖层打时是**整体替换**，
		// 所以这两项必须一起写、不能拆成两份覆盖层。
		out.push({ kind: 'kanban', text: renderKanbanOverlay(workspaceId, dataRoot) });
	}
	const workspaceRoot = trimmed(config.workspaceRoot);
	if (workspaceRoot) {
		// 代码图谱按 `<root>/.codebase-memory/` 定位；Host 的 cwd 不是工作区 ⇒ 不注入只能报"未配置"。
		// ⚠ 行 id `vssaros-codebase` 必须与插件自带 `cordis.patch.yml` 插入的那行**同名**，否则补丁打空且
		// **静默**回到"没配"路径（README 4.79 的同类坑：现象是"功能像没生效"，查不出为什么）。
		out.push({ kind: 'codebase', text: renderCodebaseOverlay(workspaceRoot, config.relatedRoots ?? []) });
	}
	if (config.mcpServers && config.mcpServers.length > 0) {
		// `dsh-mcp-client` 是"一个服务器一个组合行"。注意：VsSaros 主进程**不**走这条分支（它自己有
		// "行已归 dsh 侧就让路"的判定，见 `dshHostSupervisor._writeMcpOverlay`）；这里服务的是独立入口。
		out.push({ kind: 'mcp', text: renderMcpOverlay(config.mcpServers) });
	}
	const skillDirs = strings(config.skillDirs);
	// 内置技能（rank 600）由 `bundledSkillDir` 单列 ⇒ 与 `skillDirs` 一起渲染，但**不在**同一个数组里 ✓
	const bundledSkillDir = trimmed(config.bundledSkillDir);
	if (skillDirs.length || bundledSkillDir) {
		// 一条独立 provider 行（见 `common/dshSkillDirs.ts`）；目录增删重启 Host 后生效。
		out.push({ kind: 'skills', text: renderSkillsOverlay(skillDirs, bundledSkillDir) });
	}
	const agentsRoot = trimmed(config.agentsRoot);
	const agentsBuiltinRoot = trimmed(config.agentsBuiltinRoot);
	if (agentsRoot || agentsBuiltinRoot) {
		// 模块自身的兜底数据根是 `~/.vssaros`，而 dev 实例是 `~/.vssaros-dev` ⇒ 不注入时 dev 会把**生产**的
		// agent 列进聊天框（2026-10-11 实测）。注入后 dev / 生产各读各的，与 IDE 的 `_getSarosAgentsDir()` 同源。
		// 内置那份（agentsBuiltinRoot）是启动期由代码真源生成的 md 副本 ⇒ Host 侧才能列出内置 agent ✓。
		out.push({ kind: 'agents', text: renderAgentsOverlay(agentsRoot, agentsBuiltinRoot) });
	}
	if (dataRoot) {
		// kb / canvas / workflow / skills 的兜底数据根都是 `~/.vssaros`，dev 是 `~/.vssaros-dev` ⇒ 不注入时
		// dev 读的是**生产**数据（2026-10-12 发现：它们此前**从来没有**被注入过——探针全都自己注入数据根 ⇒
		// 从没暴露 ✗；生产两者同路径，这类错配被完全掩盖）。
		out.push({
			kind: 'dataRoot',
			text: renderDataRootOverlay(dataRoot, trimmed(config.mcpConfigPath), {
				kbRoot: trimmed(config.kbRoot),
				// ★ 库记录（2026-10-15）：与 kbRoot 写**同一行**（`vssaros-kb` ✓ 整体替换 ⇒ 不能拆 ✗）
				kbVaults: trimmed(config.kbVaults),
				kbActiveVaultId: trimmed(config.kbActiveVaultId),
				unrealBridgeUrl: trimmed(config.unrealBridgeUrl),
				browser: config.browser,
			}),
		});
	}
	const gatewayUrl = trimmed(config.gatewayUrl);
	if (gatewayUrl) {
		// 记忆模块的口径是 `config.gatewayUrl` → 环境变量 `VSSAROS_MEMORY_GATEWAY_URL` → **明确报"未配置"**。
		// 地址的真源是主进程 `app.ts._initAgentMemoryEndpoint()`（端口规则的唯一真源）⇒ **拿不到就不渲染**，
		// 尊重模块"不猜端口"的纪律（猜错会读到另一个网关的库）。
		// ⚠ 行 id `vssaros-memory` 必须与插件自带 `cordis.patch.yml` 同名，否则补丁**打空且静默**（README 4.79）。
		// ⚠ 记忆模块自 2026-10-12 起读 `config.dataRoot`（审计账本）与 `config.workspaceId`
		// （按工作区隔离记忆分区）⇒ 三者必须**同写一份**：同一行被两份覆盖层打时 `config` 是整体替换 ✗
		//（与看板那条同一个坑、同一个解法 ✓）。不注入时分别退回生产数据根 / 旧分区 `default`。
		out.push({ kind: 'memory', text: renderMemoryOverlay(gatewayUrl, dataRoot, workspaceId) });
	}
	// 沙箱降级**放最后**：它打的是 `sandbox-policy` 这一行（`@deepseek-ai/dsh-base` 自带的行），
	// 与上面任何一条都不撞（所以不存在"同写一份"的替换风险 ✓）；顺序上放末尾只为让 run 目录里的
	// 文件与日志读起来是"先常规、后补救"✓。
	const sandboxMode = trimmed(config.sandboxMode);
	// ⚠ 根的取法（2026-10-13 修）：优先**沙箱专用根**（`sandboxWorkspaceRoot`，无工作区时由主进程按
	// `SANDBOX_FALLBACK_ROOT` 补上 ✓），其次才是 `workspaceRoot`。
	// 为什么不能只看 `workspaceRoot` ✗：没有工作区时它是空的 ⇒ 降级**静默失效** ✗（现场＝每条 `pwsh`
	// 都被问一次 "escalate sandbox"）；为什么不能用 `workspaceRoot` 去顶 ✗：那个字段也喂给代码图谱 ✓。
	// 仍然**不许**只写 `mode`（那行的 `config` 是整体替换 ⇒ 会把 `workspaceRoot` 擦掉 ✗）。
	const sandboxRoot = trimmed(config.sandboxWorkspaceRoot) ?? workspaceRoot;
	if (sandboxMode && sandboxRoot) {
		out.push({ kind: 'sandbox', text: renderSandboxOverlay(sandboxMode, sandboxRoot) });
	}
	return out;
}

/** 只保留认识的字段（顺带把空白串/坏元素规整掉），输入非法时返回 `undefined`。 */
export function parseDshHostConfig(text: unknown): IDshHostConfig | undefined {
	let raw: unknown = text;
	if (typeof text === 'string') {
		if (text.trim() === '') { return undefined; }
		try { raw = JSON.parse(text); } catch { return undefined; }
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return undefined; }
	const src = raw as Record<string, unknown>;

	const bridgeRaw = src.bridge;
	const pipe = bridgeRaw && typeof bridgeRaw === 'object' ? trimmed((bridgeRaw as Record<string, unknown>).pipe) : undefined;
	const token = bridgeRaw && typeof bridgeRaw === 'object' ? trimmed((bridgeRaw as Record<string, unknown>).token) : undefined;
	const hideRaw = bridgeRaw && typeof bridgeRaw === 'object' ? (bridgeRaw as Record<string, unknown>).hideOfficialDeepseek : undefined;
	const welcome = bridgeRaw && typeof bridgeRaw === 'object' ? trimmed((bridgeRaw as Record<string, unknown>).welcomeNoticeVersion) : undefined;
	const bridge: IDshBridgeConfig | undefined = (pipe && token)
		? { pipe, token, hideOfficialDeepseek: hideRaw === true, ...(welcome ? { welcomeNoticeVersion: welcome } : {}) }
		: undefined;

	const mcpServers = Array.isArray(src.mcpServers)
		? src.mcpServers.filter((s): s is IDshMcpServerSpec => {
			if (!s || typeof s !== 'object') { return false; }
			const o = s as Record<string, unknown>;
			return !!trimmed(o.serverName) && (o.transport === 'stdio' || o.transport === 'streamable-http');
		})
		: undefined;

	/**
	 * browser（2026-10-14）：三个键都**可能显式为 `false`** ⇒ 不能走 `trimmed()` 那套
	 *（它把 `false` 当"没给" ✗ —— 而 `launchDedicated: false` 正是本项存在的**唯一理由**）。
	 * 逐键只收认得的类型；一个都没收到 ⇒ `undefined`（不渲染那行 ✓）。
	 */
	const browserRaw = src.browser;
	const browser: IDshBrowserOverlayConfig | undefined = (() => {
		if (!browserRaw || typeof browserRaw !== 'object') { return undefined; }
		const o = browserRaw as Record<string, unknown>;
		const out: { port?: number; launchDedicated?: boolean; headless?: boolean } = {};
		if (typeof o.port === 'number' && Number.isInteger(o.port) && o.port > 0) { out.port = o.port; }
		if (typeof o.launchDedicated === 'boolean') { out.launchDedicated = o.launchDedicated; }
		if (typeof o.headless === 'boolean') { out.headless = o.headless; }
		return Object.keys(out).length > 0 ? out : undefined;
	})();

	const config: IDshHostConfig = {
		...(bridge ? { bridge } : {}),
		...(browser ? { browser } : {}),
		...optional('dataRoot', trimmed(src.dataRoot)),
		...optional('workspaceId', trimmed(src.workspaceId)),
		...optional('workspaceRoot', trimmed(src.workspaceRoot)),
		...optional('relatedRoots', strings(src.relatedRoots)),
		...optional('agentsRoot', trimmed(src.agentsRoot)),
	...optional('agentsBuiltinRoot', trimmed(src.agentsBuiltinRoot)),
		...optional('skillDirs', strings(src.skillDirs)),
		// 2026-10-13（P2）：内置单列（rank 600）—— 同样必须过中立配置，否则独立启动器读同名配置时
		// 会把它**静默丢掉** ✗（丢了的后果：内置技能掉回 300 与用户根同档 ⇒ 优先级静默变化）
		...optional('bundledSkillDir', trimmed(src.bundledSkillDir)),
		...(mcpServers && mcpServers.length ? { mcpServers } : {}),
		...optional('mcpConfigPath', trimmed(src.mcpConfigPath)),
		...optional('gatewayUrl', trimmed(src.gatewayUrl)),
		// 2026-10-12（A 组缺口）：这两个也放进中立配置 —— 否则**独立启动器**（没有 VsSaros 的入口）读
		// 同名的 `vssaros.config.json` 时会把它们**丢掉** ✗（`parse` 只认这里列出的字段 ✓）。
		...optional('kbRoot', trimmed(src.kbRoot)),
		...optional('unrealBridgeUrl', trimmed(src.unrealBridgeUrl)),
		// 沙箱降级（2026-10-13）：同样必须过中立配置 —— 独立启动器读同一份 `vssaros.config.json` 时
		// 不能把它丢掉（丢了就回到"本机每个工具都 grant 失败"✗）。
		...optional('sandboxMode', trimmed(src.sandboxMode)),
		...optional('sandboxWorkspaceRoot', trimmed(src.sandboxWorkspaceRoot)),
	};
	return config;
}

/** 只在有值时塞进对象（避免把 `undefined`/空数组写进配置，便于 JSON 往返逐字相等）。 */
function optional<K extends keyof IDshHostConfig>(key: K, value: IDshHostConfig[K] | undefined): Partial<IDshHostConfig> {
	if (value === undefined) { return {}; }
	if (Array.isArray(value) && value.length === 0) { return {}; }
	return { [key]: value } as Partial<IDshHostConfig>;
}

/**
 * 配置 → 文本（2 空格缩进 + 末尾换行，与仓库里其它 `serialize*` 同形；只写有值的字段）。
 *
 * 只序列化**认识的字段**：配置里多出来的键会被丢掉，读回时自然同形（往返逐字相等）。
 */
export function serializeDshHostConfig(config: IDshHostConfig): string {
	const ordered: Record<string, unknown> = {};
	if (config.bridge) { ordered.bridge = config.bridge; }
	for (const key of ['dataRoot', 'workspaceId', 'workspaceRoot', 'relatedRoots', 'agentsRoot', 'agentsBuiltinRoot', 'skillDirs', 'bundledSkillDir', 'mcpServers', 'mcpConfigPath', 'gatewayUrl', 'kbRoot', 'unrealBridgeUrl', 'browser', 'sandboxMode', 'sandboxWorkspaceRoot'] as const) {
		const value = config[key];
		if (value === undefined) { continue; }
		if (Array.isArray(value) && value.length === 0) { continue; }
		ordered[key] = value;
	}
	return `${JSON.stringify(ordered, null, 2)}\n`;
}
