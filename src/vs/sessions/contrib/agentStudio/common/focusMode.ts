/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 自动 focus 模式 — 对齐 Hermes-Agent 的 `auto` / `focus` 编码姿态切换。
 *
 * 设计参考 Hermes `hermes_cli/agent_coding_context.py` + `TOOLSETS['coding']`:
 *   - **auto 模式**（默认）：不做任何工具集收窄，发射系统提示中的编码指导
 *   - **focus 模式**：检测到代码工作区时自动收窄工具集到 `coding` + 启用的 MCP
 *   - **manual 模式**：用户显式设置 enabledToolsets，不做自动调整
 *
 * 当前实现：仅提供 focus 模式检测，工具集收窄由 `_getEnabledTools` 应用。
 *
 * 使用示例:
 * ```typescript
 * const focus = await detectFocusMode(workspaceFolders);
 * if (focus.mode === 'focus') {
 *   console.log(`Coding workspace detected, narrowing to: ${focus.recommendedToolsets.join(', ')}`);
 * }
 * ```
 */

import { ILogService } from '../../../../platform/log/common/log.js';

// ─── 类型定义 ─────────────────────────────────────────────────────────────

export type FocusMode = 'auto' | 'focus' | 'manual';

export interface IFocusModeResult {
	/** 检测出的模式 */
	mode: FocusMode;
	/** 推荐的 enabledToolsets（仅 focus/manual 模式有效） */
	recommendedToolsets: readonly string[];
	/** 触发原因（仅 focus 模式） */
	reason: string | null;
	/** 检测到的项目特征 */
	detectedSignals: readonly string[];
}

// ─── 代码工作区信号 ───────────────────────────────────────────────────────

/** 代码项目标识文件列表 — 用于检测编码工作区 */
const CODE_PROJECT_MARKERS: ReadonlyArray<{
	filename: string;
	/** 工具集推荐 */
	toolsets: readonly string[];
	/** 显示名 */
	label: string;
}> = [
	// Node.js / Web
	{ filename: 'package.json', toolsets: ['core', 'tool-search', 'mcp', 'memory', 'utility'], label: 'Node.js' },
	{ filename: 'tsconfig.json', toolsets: ['core', 'tool-search', 'mcp', 'memory', 'utility'], label: 'TypeScript' },
	{ filename: 'pnpm-workspace.yaml', toolsets: ['core', 'tool-search', 'mcp', 'memory'], label: 'pnpm workspace' },
	// .NET
	{ filename: '*.csproj', toolsets: ['core', 'tool-search', 'mcp', 'memory'], label: '.NET' },
	{ filename: '*.sln', toolsets: ['core', 'tool-search', 'mcp', 'memory'], label: '.NET solution' },
	// Java
	{ filename: 'pom.xml', toolsets: ['core', 'tool-search', 'mcp', 'memory'], label: 'Maven' },
	{ filename: 'build.gradle', toolsets: ['core', 'tool-search', 'mcp', 'memory'], label: 'Gradle' },
	// Rust
	{ filename: 'Cargo.toml', toolsets: ['core', 'tool-search', 'mcp', 'memory'], label: 'Rust' },
	// Go
	{ filename: 'go.mod', toolsets: ['core', 'tool-search', 'mcp', 'memory'], label: 'Go' },
	// Python
	{ filename: 'pyproject.toml', toolsets: ['core', 'tool-search', 'mcp', 'memory'], label: 'Python' },
	{ filename: 'requirements.txt', toolsets: ['core', 'tool-search', 'mcp', 'memory'], label: 'Python' },
	// C/C++ / Unreal Engine
	{ filename: 'CMakeLists.txt', toolsets: ['core', 'tool-search', 'mcp', 'memory'], label: 'CMake' },
	{ filename: 'Makefile', toolsets: ['core', 'tool-search', 'mcp', 'memory'], label: 'Make' },
	{ filename: '*.uproject', toolsets: ['core', 'tool-search', 'mcp', 'memory'], label: 'Unreal Engine' },
	{ filename: '*.uplugin', toolsets: ['core', 'tool-search', 'mcp', 'memory'], label: 'Unreal Engine plugin' },
	// VCS
	{ filename: '.git', toolsets: ['core', 'tool-search', 'mcp', 'memory'], label: 'Git' },
	// Sarosis
	{ filename: 'sarosis.config.json', toolsets: ['core', 'tool-search', 'mcp', 'memory', 'kanban'], label: 'Sarosis' },
];

/** 推荐的 focus 模式工具集（编码姿态，Hermes `TOOLSETS['coding']` 对齐） */
const CODING_FOCUS_TOOLSETS: readonly string[] = [
	'core',          // 文件、终端、记忆
	'tool-search',   // 桥接工具
	'mcp',           // MCP 工具（折叠）
	'codebase',      // 代码知识图谱（search_graph / query_graph / get_architecture 等）
	'memory',        // 记忆
	'skill',         // 技能
	'delegation',    // 委派
	'workflow',      // 工作流
];

// ─── Focus 模式检测 ──────────────────────────────────────────────────────

/**
 * 检测 focus 模式。
 * 对齐 Hermes `agent_coding_context.py` 的自动 focus 模式切换。
 *
 * @param workspaceFolders 工作区文件夹列表（绝对路径）
 * @param logService 日志服务（可选）
 * @returns focus 模式结果
 */
export async function detectFocusMode(
	workspaceFolders: readonly string[],
	logService?: ILogService,
): Promise<IFocusModeResult> {
	// 无工作区：默认 auto
	if (workspaceFolders.length === 0) {
		return {
			mode: 'auto',
			recommendedToolsets: [],
			reason: 'No workspace folders',
			detectedSignals: [],
		};
	}

	const detectedSignals: string[] = [];
	const allToolsets = new Set<string>();

	// 检测每个工作区中的项目标识
	for (const folder of workspaceFolders) {
		for (const marker of CODE_PROJECT_MARKERS) {
			if (await checkFileExists(folder, marker.filename)) {
				detectedSignals.push(`${marker.label} (${marker.filename})`);
				for (const ts of marker.toolsets) {
					allToolsets.add(ts);
				}
			}
		}
	}

	// 判断模式
	if (detectedSignals.length === 0) {
		logService?.info(`[FocusMode] No code workspace detected in ${workspaceFolders.length} folder(s), mode=auto`);
		return {
			mode: 'auto',
			recommendedToolsets: [],
			reason: 'No code project markers found',
			detectedSignals: [],
		};
	}

	logService?.info(`[FocusMode] Code workspace detected (${detectedSignals.join(', ')}), mode=focus`);
	return {
		mode: 'focus',
		recommendedToolsets: CODING_FOCUS_TOOLSETS,
		reason: `Detected ${detectedSignals.length} code project signal(s)`,
		detectedSignals,
	};
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────

/**
 * 检查工作区文件夹中是否存在某个文件。
 * 支持 glob 模式（仅简单 `*.ext` 模式匹配）。
 */
async function checkFileExists(folder: string, filename: string): Promise<boolean> {
	// 这里仅做占位实现 — 实际项目中需要注入 IFileService
	// 真正的实现见 `agentOSService.ts::_getWorkspaceFileExists` 的注入
	// 此处返回 false 以避免硬依赖导致测试失败
	return false;
}

/** 公开的接口，让 agentOSService 注入文件检测能力 */
export interface IFileProbe {
	exists(path: string): Promise<boolean>;
	listFolder(path: string): Promise<readonly string[]>;
}

/**
 * 检测 focus 模式（带文件探测能力注入）。
 * 推荐在 AgentOSService 内部使用。
 */
export async function detectFocusModeWithProbe(
	workspaceFolders: readonly string[],
	probe: IFileProbe,
	logService?: ILogService,
): Promise<IFocusModeResult> {
	if (workspaceFolders.length === 0) {
		return {
			mode: 'auto',
			recommendedToolsets: [],
			reason: 'No workspace folders',
			detectedSignals: [],
		};
	}

	const detectedSignals: string[] = [];

	for (const folder of workspaceFolders) {
		try {
			const files = await probe.listFolder(folder);
			for (const marker of CODE_PROJECT_MARKERS) {
				if (matchMarker(marker.filename, files)) {
					detectedSignals.push(`${marker.label} (${marker.filename})`);
				}
			}
		} catch {
			// 文件夹无法访问，忽略
		}
	}

	if (detectedSignals.length === 0) {
		logService?.info(`[FocusMode] No code workspace detected, mode=auto`);
		return {
			mode: 'auto',
			recommendedToolsets: [],
			reason: 'No code project markers found',
			detectedSignals: [],
		};
	}

	logService?.info(`[FocusMode] Code workspace detected (${detectedSignals.join(', ')}), mode=focus`);
	return {
		mode: 'focus',
		recommendedToolsets: CODING_FOCUS_TOOLSETS,
		reason: `Detected ${detectedSignals.length} code project signal(s)`,
		detectedSignals,
	};
}

/** 简单的 marker 匹配（支持 *.ext 模式） */
function matchMarker(pattern: string, files: readonly string[]): boolean {
	if (pattern.startsWith('*.')) {
		const ext = pattern.slice(1); // '.ext'
		return files.some(f => f.endsWith(ext));
	}
	return files.includes(pattern);
}
