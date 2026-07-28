/*---------------------------------------------------------------------------------------------
 *  Tool Display Registry — inspired by OpenClaw's ToolDisplayRegistry
 *
 *  Centralized, configuration-driven tool display resolution.
 *  Resolves tool name → display info (emoji, title, renderType, detailKeys).
 *
 *  Key design:
 *  - When a provider (e.g. Knot) supplies `renderType` via _meta, it takes priority.
 *  - When `renderType` is absent, the registry infers it from `tool.name`.
 *  - `detailKeys` enables extracting a concise summary from tool arguments.
 *  - `actions` enables sub-type resolution based on `args.action`.
 *
 *  @see OpenClaw `apps/shared/OpenClawKit/Sources/OpenClawKit/ToolDisplay.swift`
 *  @see OpenClaw `apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json`
 *--------------------------------------------------------------------------------------------*/

// ─── Types ──────────────────────────────────────────────────────────────────────

/** Action-level display spec (sub-type within a tool) */
export interface ToolDisplayActionSpec {
	label?: string;
	detailKeys?: string[];
}

/** Tool-level display spec */
export interface ToolDisplaySpec {
	emoji?: string;
	title?: string;
	/** Friendly label shown in collapsed card */
	label?: string;
	/** Keys to extract from args for the summary line */
	detailKeys?: string[];
	/** Inferred renderType when provider doesn't supply one */
	renderType?: string;
	/** Action-based sub-type resolution */
	actions?: Record<string, ToolDisplayActionSpec>;
}

/** Resolved display summary for a tool call */
export interface ToolDisplaySummary {
	name: string;
	emoji: string;
	title: string;
	label: string;
	verb?: string;
	detail?: string;
	/** Inferred renderType (may be undefined → use generic card) */
	renderType?: string;
}

/** Top-level config structure */
interface ToolDisplayConfig {
	version: number;
	fallback: ToolDisplaySpec;
	tools: Record<string, ToolDisplaySpec>;
}

// ─── Config ─────────────────────────────────────────────────────────────────────

const TOOL_DISPLAY_CONFIG: ToolDisplayConfig = {
	version: 1,
	fallback: {
		emoji: '🔧',
		detailKeys: [
			'command', 'path', 'url', 'targetUrl', 'targetId',
			'ref', 'element', 'node', 'nodeId', 'id', 'requestId',
			'to', 'channelId', 'guildId', 'userId', 'name',
			'query', 'pattern', 'messageId',
		],
	},
	tools: {
		// ── Terminal / Shell ──
		terminal: {
			emoji: '⌨️',
			title: '终端命令',
			label: '终端命令',
			renderType: 'RunTerminal',
			detailKeys: ['command', 'cmd'],
		},
		bash: {
			emoji: '🛠️',
			title: 'Bash',
			label: 'Bash',
			renderType: 'RunTerminal',
			detailKeys: ['command'],
		},
		exec: {
			emoji: '🛠️',
			title: 'Exec',
			label: 'Exec',
			renderType: 'RunTerminal',
			detailKeys: ['command'],
		},
		shell: {
			emoji: '⌨️',
			title: 'Shell',
			label: 'Shell',
			renderType: 'RunTerminal',
			detailKeys: ['command'],
		},
		run_command: {
			emoji: '⌨️',
			title: '运行命令',
			label: '运行命令',
			renderType: 'RunTerminal',
			detailKeys: ['command'],
		},

		// ── File operations ──
		read_file: {
			emoji: '📄',
			title: '读取文件',
			label: '读取文件',
			renderType: 'CodeApply',
			detailKeys: ['path', 'file_path', 'filePath'],
		},
		read: {
			emoji: '📖',
			title: 'Read',
			label: 'Read',
			renderType: 'CodeApply',
			detailKeys: ['path'],
		},
		write_file: {
			emoji: '✏️',
			title: '写入文件',
			label: '写入文件',
			renderType: 'CodeApply',
			detailKeys: ['path', 'file_path', 'filePath'],
		},
		write: {
			emoji: '✍️',
			title: 'Write',
			label: 'Write',
			renderType: 'CodeApply',
			detailKeys: ['path'],
		},
		edit_file: {
			emoji: '📝',
			title: '编辑文件',
			label: '编辑文件',
			renderType: 'CodeApply',
			detailKeys: ['path', 'file_path', 'filePath'],
		},
		edit: {
			emoji: '📝',
			title: 'Edit',
			label: 'Edit',
			renderType: 'CodeApply',
			detailKeys: ['path'],
		},
		apply_patch: {
			emoji: '🩹',
			title: 'Apply Patch',
			label: 'Apply Patch',
			renderType: 'CodeApply',
			detailKeys: [],
		},

		// ── Search / List ──
		search_files: {
			emoji: '🔍',
			title: '搜索文件',
			label: '搜索文件',
			renderType: 'ListItems',
			detailKeys: ['query', 'pattern', 'path'],
		},
		list_files: {
			emoji: '📂',
			title: '列出文件',
			label: '列出文件',
			renderType: 'ListItems',
			detailKeys: ['path'],
		},
		list_directory: {
			emoji: '📂',
			title: '列出目录',
			label: '列出目录',
			renderType: 'ListItems',
			detailKeys: ['path'],
		},
		file_list: {
			emoji: '📂',
			title: '列出文件',
			label: '列出文件',
			renderType: 'ListItems',
			detailKeys: ['path', 'pattern'],
		},
		search_code: {
			emoji: '🔍',
			title: 'Search Code',
			label: 'Search Code',
			renderType: 'ListItems',
			detailKeys: ['query', 'pattern', 'path'],
		},
		search: {
			emoji: '🔍',
			title: 'Search',
			label: 'Search',
			renderType: 'ListItems',
			detailKeys: ['query', 'pattern'],
		},

		// ── Web ──
		web_search: {
			emoji: '🌐',
			title: '网络搜索',
			label: '网络搜索',
			renderType: 'ListItems',
			detailKeys: ['query', 'count'],
		},
		web_fetch: {
			emoji: '📄',
			title: 'Web Fetch',
			label: 'Web Fetch',
			detailKeys: ['url', 'maxChars'],
		},

		// ── Browser ──
		browser: {
			emoji: '🖥️',
			title: '浏览器',
			label: '浏览器',
			actions: {
				navigate: { label: 'navigate', detailKeys: ['targetUrl'] },
				open: { label: 'open', detailKeys: ['targetUrl'] },
				snapshot: { label: 'snapshot', detailKeys: ['targetUrl', 'ref'] },
				screenshot: { label: 'screenshot', detailKeys: ['targetUrl', 'ref'] },
				click: { label: 'click', detailKeys: ['ref', 'element'] },
				type: { label: 'type', detailKeys: ['ref', 'element', 'text'] },
			},
		},

		// ── Memory / Knowledge ──
		memory: {
			emoji: '🧠',
			title: 'Memory',
			label: 'Memory',
			detailKeys: ['query', 'path'],
		},


		// ── Task / Planning ──
		update_plan: {
			emoji: '📋',
			title: 'Plan',
			label: 'Plan',
			detailKeys: ['plan', 'explanation'],
		},
		todo: {
			emoji: '📋',
			title: 'Todo',
			label: 'Todo',
			detailKeys: ['task', 'action'],
		},
		task: {
			emoji: '📋',
			title: 'Task',
			label: 'Task',
			detailKeys: ['action'],
		},

		// ── Sub-agent ──
		sessions_spawn: {
			emoji: '🧑‍🔧',
			title: 'Sub-agent',
			label: 'Sub-agent',
			detailKeys: ['label', 'task', 'agentId'],
		},
		subagents: {
			emoji: '🤖',
			title: 'Subagents',
			label: 'Subagents',
			actions: {
				list: { label: 'list', detailKeys: ['recentMinutes'] },
				kill: { label: 'kill', detailKeys: ['target'] },
			},
		},

		// ── Image / Media ──
		image: {
			emoji: '🖼️',
			title: 'Image',
			label: 'Image',
			detailKeys: ['path', 'url', 'prompt'],
		},
		image_generate: {
			emoji: '🎨',
			title: 'Image Generation',
			label: 'Image Generation',
			detailKeys: ['prompt', 'model'],
		},

		// ── Other common tools ──
		attach: {
			emoji: '📎',
			title: 'Attach',
			label: 'Attach',
			detailKeys: ['path', 'url', 'fileName'],
		},
		process: {
			emoji: '🧰',
			title: 'Process',
			label: 'Process',
			detailKeys: ['sessionId'],
		},
		apply: {
			emoji: '📝',
			title: 'Apply',
			label: 'Apply',
			renderType: 'CodeApply',
			detailKeys: ['path', 'file_path'],
		},
		code_execution: {
			emoji: '🧮',
			title: 'Code Execution',
			label: 'Code Execution',
			detailKeys: ['task'],
		},
		update_plan: {
			emoji: '🗺️',
			title: 'Update Plan',
			label: 'Update Plan',
			detailKeys: ['explanation'],
		},
	},
};

// ─── Utility: value extraction from args ────────────────────────────────────────

/**
 * Resolve a value from an object by dot-separated key path.
 * E.g. valueForKeyPath(args, "job.name") → args.job?.name
 */
function valueForKeyPath(args: Record<string, unknown> | null | undefined, path: string): unknown {
	if (!args) { return undefined; }
	const parts = path.split('.');
	let current: unknown = args;
	for (const part of parts) {
		if (current == null || typeof current !== 'object' || Array.isArray(current)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

/**
 * Render an extracted value as a short display string.
 */
function renderValue(value: unknown): string | undefined {
	if (value == null) { return undefined; }
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed) { return undefined; }
		const firstLine = trimmed.split('\n')[0]?.trim() ?? trimmed;
		return firstLine.length > 80 ? firstLine.substring(0, 77) + '...' : firstLine;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (Array.isArray(value)) {
		const items = value.map(v => renderValue(v)).filter((v): v is string => v != null);
		if (items.length === 0) { return undefined; }
		const preview = items.slice(0, 3).join(', ');
		return items.length > 3 ? `${preview}...` : preview;
	}
	if (typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		if (typeof obj.name === 'string') { return obj.name; }
		if (typeof obj.id === 'string') { return obj.id; }
	}
	return undefined;
}

/**
 * Extract detail from args based on known tool-specific logic.
 */
function extractSpecialDetail(name: string, args: Record<string, unknown> | null): string | undefined {
	const key = name.toLowerCase();
	if (key === 'read' || key === 'read_file') {
		const path = valueForKeyPath(args, 'path') as string ?? valueForKeyPath(args, 'file_path') as string;
		if (!path) { return undefined; }
		const offset = valueForKeyPath(args, 'offset') as number | undefined;
		const limit = valueForKeyPath(args, 'limit') as number | undefined;
		if (offset != null && limit != null) {
			return `${path}:${offset}-${offset + limit}`;
		}
		return path;
	}
	if (key === 'write' || key === 'write_file' || key === 'edit' || key === 'edit_file') {
		return valueForKeyPath(args, 'path') as string ?? valueForKeyPath(args, 'file_path') as string ?? undefined;
	}
	return undefined;
}

/**
 * Extract the first matching value from args by a list of keys.
 */
function firstValueFromKeys(args: Record<string, unknown> | null, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = valueForKeyPath(args, key);
		const rendered = renderValue(value);
		if (rendered) { return rendered; }
	}
	return undefined;
}

// ─── Title generation ───────────────────────────────────────────────────────────

/**
 * Generate a title from a tool name by splitting on underscores and capitalizing.
 * E.g. "web_search" → "Web Search", "bash" → "Bash"
 */
function titleFromName(name: string): string {
	const cleaned = name.replace(/_/g, ' ').trim();
	if (!cleaned) { return 'Tool'; }
	return cleaned
		.split(/\s+/)
		.map(part => {
			if (part.length <= 2 && part === part.toUpperCase()) { return part; }
			return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
		})
		.join(' ');
}

/**
 * Normalize a verb string.
 */
function normalizeVerb(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) { return undefined; }
	return trimmed.replace(/_/g, ' ');
}

// ─── Main Registry ──────────────────────────────────────────────────────────────

export const ToolDisplayRegistry = {
	/**
	 * Resolve display info for a tool call.
	 *
	 * @param name - Tool name (e.g. "terminal", "read_file")
	 * @param argsRaw - Tool arguments as JSON string or parsed object
	 * @param meta - Optional meta string (e.g. from Knot's _meta)
	 */
	resolve(
		name: string | undefined | null,
		argsRaw: string | Record<string, unknown> | null | undefined,
		meta?: string,
	): ToolDisplaySummary {
		const trimmedName = name?.trim() || 'tool';
		const key = trimmedName.toLowerCase();
		const spec = TOOL_DISPLAY_CONFIG.tools[key];
		const fallback = TOOL_DISPLAY_CONFIG.fallback;

		// Parse args if string
		let args: Record<string, unknown> | null = null;
		if (argsRaw) {
			if (typeof argsRaw === 'string') {
				try { args = JSON.parse(argsRaw); } catch { args = null; }
			} else {
				args = argsRaw;
			}
		}

		const emoji = spec?.emoji ?? fallback.emoji ?? '🔧';
		const title = spec?.title ?? titleFromName(trimmedName);
		const label = spec?.label ?? trimmedName;
		const renderType = spec?.renderType;

		// Resolve action-based sub-type
		const actionRaw = typeof args?.action === 'string' ? args.action.trim() : undefined;
		const actionSpec = actionRaw ? spec?.actions?.[actionRaw] : undefined;
		const verb = normalizeVerb(actionSpec?.label ?? actionRaw);

		// Extract detail
		let detail = extractSpecialDetail(key, args);

		const detailKeys = actionSpec?.detailKeys ?? spec?.detailKeys ?? fallback.detailKeys ?? [];
		if (detail == null && detailKeys.length > 0) {
			detail = firstValueFromKeys(args, detailKeys);
		}

		if (detail == null && meta) {
			detail = meta;
		}

		return {
			name: trimmedName,
			emoji,
			title,
			label,
			verb,
			detail,
			renderType,
		};
	},

	/**
	 * Get the inferred renderType for a tool name.
	 * Returns undefined if no specialized renderer is known.
	 */
	getRenderType(name: string | undefined | null): string | undefined {
		const key = (name?.trim() || 'tool').toLowerCase();
		return TOOL_DISPLAY_CONFIG.tools[key]?.renderType;
	},
};
