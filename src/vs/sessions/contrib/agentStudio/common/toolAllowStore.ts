/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// 类别模型的真源在 `toolApprovalPolicy`（纯函数）—— 本模块只负责**存取**它。
// 方向：toolAllowStore → toolApprovalPolicy（单向，无环）。
import { normalizeAutoApprove, type ToolCategory, type ToolAutoApproveMode } from './toolApprovalPolicy.js';

/**
 * 工具授权表（「始终允许 / 在工作区允许」）的**纯逻辑**部分。
 *
 * ## 为什么是文件，而不是 VS Code 设置（2026-09-13，用户决策）
 *
 * 此前用 `IConfigurationService.updateValue` 持久化：
 *   · `workspace` 作用域 → `ConfigurationTarget.WORKSPACE` → **`<workspace>/.vscode/settings.json`**
 *   · `global` 作用域    → `ConfigurationTarget.USER` → `~/.vssaros/User/settings.json`
 *
 * 前者有两个问题：
 * 1. **违反本项目约定** —— 本项目的数据一律放 `.vssaros/`（见 `sarosPaths.ts` 模块注释），
 *    不写进 `.vscode/`（那是 VS Code 自己的配置目录）。
 * 2. **安全** —— `.vscode/settings.json` 在**工作区内**，模型（或被注入到文件/网页/issue
 *    里的指令）可以直接写它 ⇒ **「被约束者可以改写约束」**：给自己加 `terminal` /
 *    `file_write` 的授权，或关掉同一文件里的 `chat.agent.sensitiveReadGuard`。
 *
 * 现统一存到 `~/.vssaros/tool-allow.json`（`SarosPath.toolAllow`）：符合项目约定，
 * 且该目录已被 `writeDenyList` 硬拒 —— 模型写不进去。
 *
 * ## 文件形态
 * ```json
 * {
 *   "version": 1,
 *   "global": ["terminal::git status*"],
 *   "workspaces": { "<workspaceId>": ["file_write"] }
 * }
 * ```
 *
 * 本模块**全是纯函数**（不改入参、不做 IO）；读写由调用方用 `IFileService` 完成。
 * 旧版 VS Code 设置里的条目由 {@link migrateLegacyEntries} 迁移（见 `agentOSService`）。
 */

/** 授权表文件内容（v2：新增 `autoApprove` 类别档位）。 */
export interface IToolAllowFile {
	readonly version: number;
	/**
	 * 类别自动批准档位（v2 新增）。
	 *
	 * ⚠ **刻意保持可选**：缺省 ≠ 「显式选了默认值」。
	 *   · 缺省   ⇒ 跟随 `DEFAULT_AUTO_APPROVE` 常量（将来翻转默认值能惠及这些用户）；
	 *   · 显式写入 ⇒ 用户自己的选择，不再被默认值变更影响。
	 * 若在 `emptyToolAllowFile` 里把默认值**物化**进文件，第一次落盘就会把「没选过」
	 * 变成「选过兼容档」，Phase 2 翻转默认值时这批用户会被落下 —— 故这里保持缺省。
	 */
	readonly autoApprove?: Readonly<Record<string, string>>;
	/** 全局作用域条目（跨工作区生效）。 */
	readonly global: readonly string[];
	/** 按工作区 id 分组的条目。 */
	readonly workspaces: Readonly<Record<string, readonly string[]>>;
}

/** 当前文件版本（将来改形态时用于迁移）。v2 = 新增 `autoApprove`。 */
export const TOOL_ALLOW_FILE_VERSION = 2;

export function emptyToolAllowFile(): IToolAllowFile {
	// 不写 `autoApprove`：见接口注释（缺省 = 跟随默认常量）
	return { version: TOOL_ALLOW_FILE_VERSION, global: [], workspaces: {} };
}

/**
 * 宽容解析：文件缺失 / 被手改坏 / 形态不符时一律退化为**空表**，绝不抛。
 *
 * 刻意不做「猜修复」：授权表是**安全相关**状态，宁可退回「无任何授权」（重新弹窗）
 * 也不要把坏数据解释成授权。
 */
export function parseToolAllowFile(text: string | undefined): IToolAllowFile {
	if (!text) { return emptyToolAllowFile(); }
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return emptyToolAllowFile();
	}
	if (!raw || typeof raw !== 'object') { return emptyToolAllowFile(); }
	const o = raw as Record<string, unknown>;

	const global = Array.isArray(o['global'])
		? o['global'].filter((e): e is string => typeof e === 'string' && e.length > 0)
		: [];

	const workspaces: Record<string, string[]> = {};
	const ws = o['workspaces'];
	if (ws && typeof ws === 'object') {
		for (const [id, list] of Object.entries(ws as Record<string, unknown>)) {
			if (!Array.isArray(list)) { continue; }
			const entries = list.filter((e): e is string => typeof e === 'string' && e.length > 0);
			if (entries.length > 0) { workspaces[id] = entries; }
		}
	}

	// `autoApprove`：仅在文件里**确实存在**时保留（缺失 → 不写入，继续跟随默认常量）。
	// 值本身经 `normalizeAutoApprove` 宽容归一（坏档位退化为默认档）。
	const autoApproveRaw = o['autoApprove'];
	const autoApprove = (autoApproveRaw && typeof autoApproveRaw === 'object')
		? normalizeAutoApprove(autoApproveRaw)
		: undefined;

	return {
		version: TOOL_ALLOW_FILE_VERSION,
		...(autoApprove ? { autoApprove } : {}),
		global,
		workspaces,
	};
}

export function serializeToolAllowFile(f: IToolAllowFile): string {
	return JSON.stringify(f, null, 2);
}

/**
 * 类别档位（归一化后的**唯一读取入口**）。
 *
 * 缺省 → 默认常量；坏值 → 默认档。调用方**不要**自己 spread 默认值 ——
 * 「缺省 vs 显式」的语义若在多处实现必然漂移（今日教训：同一规则 N 处必然漂移）。
 */
export function autoApproveFor(f: IToolAllowFile): Record<ToolCategory, ToolAutoApproveMode> {
	return normalizeAutoApprove(f.autoApprove);
}

/** 某作用域下的条目（不含另一作用域）。 */
export function entriesFor(
	f: IToolAllowFile, scope: 'global' | 'workspace', workspaceId: string,
): readonly string[] {
	return scope === 'global' ? f.global : (f.workspaces[workspaceId] ?? []);
}

/** 匹配时用的**全部**条目：全局 + 当前工作区。 */
export function allEntriesFor(f: IToolAllowFile, workspaceId: string): string[] {
	return [...f.global, ...(f.workspaces[workspaceId] ?? [])];
}

/** 新增条目（幂等：已存在则原样返回，不产生重复）。 */
export function addEntry(
	f: IToolAllowFile, scope: 'global' | 'workspace', workspaceId: string, entry: string,
): IToolAllowFile {
	if (!entry) { return f; }
	if (scope === 'global') {
		if (f.global.includes(entry)) { return f; }
		return { ...f, global: [...f.global, entry] };
	}
	const cur = f.workspaces[workspaceId] ?? [];
	if (cur.includes(entry)) { return f; }
	return { ...f, workspaces: { ...f.workspaces, [workspaceId]: [...cur, entry] } };
}

/** 移除条目（**两个作用域都清** —— 「撤销」语义是「以后都重新问」）。 */
export function removeEntry(f: IToolAllowFile, entry: string): IToolAllowFile {
	const global = f.global.filter(e => e !== entry);
	const workspaces: Record<string, string[]> = {};
	for (const [id, list] of Object.entries(f.workspaces)) {
		const filtered = list.filter(e => e !== entry);
		if (filtered.length > 0) { workspaces[id] = filtered; }
	}
	return { ...f, global, workspaces };
}

/**
 * 把**旧版 VS Code 设置**里的条目并入文件（迁移用，幂等）。
 *
 * 旧的两个键是 `sessions.agentStudio.tools.allowedToolsUser`（全局）与
 * `...allowedToolsWorkspace`（工作区）。后者由 VS Code 按当前工作区解析，
 * 故迁移时归入**当前**工作区 id 下。
 */
export function migrateLegacyEntries(
	f: IToolAllowFile,
	legacyGlobal: readonly string[],
	legacyWorkspace: readonly string[],
	workspaceId: string,
): IToolAllowFile {
	let out = f;
	for (const e of legacyGlobal) { out = addEntry(out, 'global', workspaceId, e); }
	for (const e of legacyWorkspace) { out = addEntry(out, 'workspace', workspaceId, e); }
	return out;
}
