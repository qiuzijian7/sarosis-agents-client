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
const TOOLS_DIR = join(ROOT, 'resources', '.agents', 'tools');
const SNAPSHOT = join(ROOT, 'dsh-plugins', 'tools-snapshot.json');

/**
 * bunnyseek 的工具名 → dsh 的等价物。
 * `null` = 当前环境**没有**对应工具（技能若引用它，迁移时会在正文顶部挂一条缺件告示，
 * 或整份跳过 —— 由迁移器按 `--include-missing` 决定）。
 */
export const TOOL_MAP = {
	// 文件与检索
	read_file: 'file_read',
	write_file: 'file_write',
	edit_file: 'patch',
	multi_edit: 'patch',
	read_image: 'file_read',
	ls: 'search_files',
	grep: 'search_files',
	glob: 'search_files',
	// 执行
	bash: 'terminal',
	pwsh: 'terminal',
	python_repl: 'execute_code',
	bash_output: 'process',
	kill_shell: 'process',
	wait: 'process',
	// 网络
	web_fetch: 'web_extract',
	web_search: 'web_search',
	// 计划与协同
	todo_write: 'todo',
	complete_step: 'todo',
	enter_plan: null,
	ask: 'clarify',
	task: 'delegate_task',
	evidence: null,
	// 技能与记忆
	run_skill: 'skill_view',
	read_skill: 'skill_view',
	install_skill: 'skill_manage',
	remember: 'memory_remember',
	forget: 'memory_delete',
	memory: 'memory_search',
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

/** dsh 侧**真实存在**的工具名：内建（resources/.agents/tools/*.json）+ 插件（tools-snapshot.json）。 */
export function dshToolNames() {
	const names = new Set();
	if (existsSync(TOOLS_DIR)) {
		for (const file of readdirSync(TOOLS_DIR)) {
			// `_toolsets.json` 是清单不是工具
			if (file.endsWith('.json') && !file.startsWith('_')) {
				names.add(file.slice(0, -'.json'.length));
			}
		}
	}
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
