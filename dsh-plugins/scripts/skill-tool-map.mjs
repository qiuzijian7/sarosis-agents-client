// 技能正文里的工具名 —— 唯一真源（守卫 `check-skill-tool-refs.mjs` 与迁移器
// `import-bunnyseek-skills.mjs` 共用这一份，避免两处判定分叉）。
//
// 为什么需要它：技能正文会写 `` `read_file` `` 这类工具名。工具名一旦不存在，模型会去调它、
// 拿到 "unknown tool"，然后开始瞎猜替代方案 —— bunnyseek 源码注释原话是「指向一个不存在的
// 工具比不给提示更糟」。所以「技能引用 ⇔ registry」必须有一道机器可查的闸。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
const RUNTIME_DIR = join(ROOT, 'dsh-runtime');
const SNAPSHOT = join(ROOT, 'dsh-plugins', 'tools-snapshot.json');

/**
 * bunnyseek 的工具名 → dsh 的等价物。
 * `null` = 当前环境**没有**对应工具（技能若引用它，迁移时会在正文顶部挂一条缺件告示，
 * 或整份跳过 —— 由迁移器按 `--include-missing` 决定）。
 */
export const TOOL_MAP = {
	// ★ P3（2026-11-07）：映射目标一律是 **dsh 官方真名**（`dsh-runtime` 注册名 +
	//   `tools-snapshot.json`），不再是 IDE 侧 `resources/.agents/tools/*.json` 的兼容别名。
	//   `check-skill-tool-refs.mjs` 会逐条校验「非 null 的目标真实存在」，防这张表再次腐烂。
	// 文件与检索
	read_file: 'read',
	write_file: 'write',
	edit_file: 'edit',
	multi_edit: 'edit',
	read_image: 'read_image',
	ls: 'glob',
	grep: 'grep',
	glob: 'glob',
	// 执行
	bash: 'bash',
	pwsh: 'pwsh',
	python_repl: null,
	bash_output: 'terminal_read',
	kill_shell: 'terminal_signal',
	wait: 'job_output',
	// 网络
	web_fetch: 'web_fetch',
	web_search: 'web_search',
	// 计划与协同
	todo_write: 'todo_write',
	complete_step: 'todo_write',
	enter_plan: null,
	ask: 'ask_user_question',
	task: null,
	evidence: null,
	// 技能与记忆
	run_skill: 'skill',
	read_skill: 'read_skill',
	install_skill: 'skill_manage',
	remember: 'memory',
	forget: 'memory',
	memory: 'memory',
	// 模板（dsh 无对应）
	save_template: null,
	read_template: null,
	delete_template: null,
	// UE：五个同名 + 一个改名，其余无对应
	unreal_exec: 'unreal_exec',
	unreal_wait: 'unreal_wait',
	unreal_help: 'unreal_help',
	unreal_dump: 'unreal_dump',
	unreal_find_asset: 'unreal_find_asset',
	unreal_cpp_build: 'unreal_build',
	unreal_screenshot: null,
	unreal_editor_manager: null,
	unreal_log: null,
	unreal_gm_find: null,
	// 内网业务系统（无对应，需 MCP 补）
	tapd_stories_search: null,
	tapd_story_view: null,
	tapd_bugs_search: null,
	tapd_bug_view: null,
	tapd_bug_history: null,
	tapd_log_digest: null,
	ds_log_download: null,
	p4_shelve_for_review: null,
	p4_precheck: null,
	p4_workspace_check: null,
	p4_sync_half_synced: null,
	trace_list: null,
	trace_query: null,
	trace_locate: null,
	perfdog_case: null,
	feishu_kb_search: null,
	feishu_kb_view: null,
};

/**
 * 官方 dsh 工具名：随包 runtime 里 `@deepseek-ai/dsh-tool-*` 的注册名。
 * 与 `check-agent-tools.mjs` 判据 1a 同源 ⇒ 这才是「工具都用 dsh 提供的工具」的真源。
 */
export function officialDshToolNames() {
	const names = new Set();
	if (!existsSync(RUNTIME_DIR)) { return names; }
	for (const ver of readdirSync(RUNTIME_DIR)) {
		const scope = join(RUNTIME_DIR, ver, 'node_modules', '@deepseek-ai');
		if (!existsSync(scope)) { continue; }
		for (const pkg of readdirSync(scope)) {
			if (!pkg.startsWith('dsh-tool-')) { continue; }
			const lib = join(scope, pkg, 'lib');
			if (!existsSync(lib)) { continue; }
			for (const file of readdirSync(lib)) {
				if (!file.endsWith('.js')) { continue; }
				const src = readFileSync(join(lib, file), 'utf8');
				for (const m of src.matchAll(/\bname:\s*["']([a-z][a-z0-9_]{1,40})["']/g)) {
					names.add(m[1]);
				}
			}
		}
	}
	return names;
}

/**
 * 当前环境**真实存在**的工具名。
 *
 * 真源 = 官方 runtime（dsh 真名） + `dsh-plugins/tools-snapshot.json`（插件工具）
 *      + 不进离线快照的内置工具（memory / dtodo / 原生 skill）。
 * ★ P3（2026-11-07）：IDE 侧 `resources/.agents/tools/*.json` 的 76 个兼容别名表
 *   已随该目录一起删除；`TOOL_MAP` 的目标也已全部换成 dsh 真名。
 *   这里不再有第二个真源 —— "工具都用 dsh 提供的工具" 在守卫层落地。
 */
export function dshToolNames() {
	const names = officialDshToolNames();
	for (const builtin of ['memory', 'dtodo', 'skill']) { names.add(builtin); }
	try {
		const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
		for (const list of Object.values(snapshot?.plugins ?? {})) {
			for (const tool of Array.isArray(list) ? list : []) {
				if (tool?.name) {
					names.add(tool.name);
				}
			}
		}
	} catch {
		// 快照缺失不算错：守卫会因此把插件工具当"不存在"，但那属于仓库不完整，
		// 由 check-plugin-files / check-tool-definitions 各自报，不在这里重复判。
	}
	return names;
}

/** 只出现在 bunnyseek 里的工具名（= 迁移未改名的判定依据）。 */
export const BUNNYSEEK_ONLY = new Set(Object.keys(TOOL_MAP));

/** 反引号里的 snake_case 标识符：技能正文引用工具的唯一稳定写法。 */
const IDENT_RE = /`([a-z][a-z0-9_]{2,})(?:\([^`]*\))?`/g;

/**
 * 扫一段技能正文，返回它引用的**已知工具名**与**悬空工具名**。
 *
 * 只把"在 dsh 或 bunnyseek 的工具清单里出现过"的标识符算作工具引用 ——
 * 否则 `main.py`、`git_commit` 这类普通标识符会大量假阳性（技能正文本身就是 Markdown）。
 */
export function scanToolRefs(text, dshTools) {
	const referenced = new Set();
	const dangling = new Set();
	for (const match of String(text ?? '').matchAll(IDENT_RE)) {
		const ident = match[1];
		if (!BUNNYSEEK_ONLY.has(ident) && !dshTools.has(ident)) {
			continue;
		}
		// 不带下划线的旧名单字与普通英文词**无法区分**（实测 `evidence` 是 JSON 字段名、
		// `memory`/`task`/`ask` 到处出现）⇒ 宁漏不误：只判 `read_file` 这种带下划线的。
		// dsh 自己的工具名不受此限（`patch`/`terminal`/`todo` 是唯一位）。
		if (BUNNYSEEK_ONLY.has(ident) && !dshTools.has(ident) && !ident.includes('_')) {
			continue;
		}
		referenced.add(ident);
		const mapped = TOOL_MAP[ident];
		const target = mapped === undefined ? ident : mapped;
		if (target === null || !dshTools.has(target)) {
			dangling.add(ident);
		}
	}
	return { referenced: [...referenced], dangling: [...dangling] };
}

/** 迁移用：把正文里反引号包裹的旧工具名换成本环境的名字（null 的保持原样，由调用方告示）。 */
export function replaceToolRefs(text) {
	return String(text ?? '').replace(IDENT_RE, (whole, ident) => {
		const target = TOOL_MAP[ident];
		return typeof target === 'string' ? whole.replace(ident, target) : whole;
	});
}

// ── IDE 侧已退役工具名：守卫与基线生成器共用的单一真源 ──────────────────
// 这些名字既不在 TOOL_MAP 也不在 dshToolNames()，scanToolRefs 会把它们静默
// continue 掉，所以必须单独扫。口径限定「反引号包裹」或「后跟 ( 的调用」，
// 避免把普通英文词（patch the file / terminal output）当成工具引用。
export const IDE_LEGACY_TOOL_NAMES = Object.freeze([
	'trace_path', 'detect_changes', 'get_architecture', 'get_code_snippet',
	'search_graph', 'query_graph', 'index_status', 'manage_adr',
	'file_read', 'file_write', 'file_list', 'search_files', 'search_code',
	'terminal', 'patch', 'clarify', 'web_extract', 'shell_exec', 'execute_code',
	'read_file', 'write_to_file', 'replace_in_file', 'grep_search', 'use_skill',
	'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
	'browser_scroll', 'browser_back', 'browser_press', 'browser_vision',
	'browser_console', 'browser_cdp', 'browser_dialog', 'browser_get_images',
	'browser_evaluate', 'browser_take_screenshot', 'take_screenshot',
	'delegate_task',
]);

const LEGACY_NAMES_RE = IDE_LEGACY_TOOL_NAMES.join('|');
const LEGACY_CALL_RE = new RegExp('(?:`(' + LEGACY_NAMES_RE + ')`|\\b(' + LEGACY_NAMES_RE + ')\\s*\\()', 'g');

/** 正文（跳过 YAML frontmatter）里出现的 IDE 退役名，去重排序。 */
export function scanLegacyIdeToolRefs(text) {
	const lines = String(text ?? '').split(/\r?\n/);
	let start = 0;
	if (lines[0]?.trim() === '---') {
		for (let i = 1; i < lines.length; i++) {
			if (lines[i].trim() === '---') { start = i + 1; break; }
		}
	}
	const found = new Set();
	for (const m of lines.slice(start).join('\n').matchAll(LEGACY_CALL_RE)) {
		found.add(m[1] ?? m[2]);
	}
	return [...found].sort();
}

/** frontmatter 的 recommended_tools 数组内容（不做校验，交给守卫）。 */
export function frontmatterRecommendedTools(text) {
	const lines = String(text ?? '').split(/\r?\n/);
	if (lines[0]?.trim() !== '---') { return []; }
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === '---') { break; }
		const m = /^\s*recommended_tools:\s*\[([^\]]*)\]/.exec(lines[i]);
		if (!m) { continue; }
		return [...m[1].matchAll(/[a-z][a-z0-9_*-]*/g)].map((x) => x[0]);
	}
	return [];
}
