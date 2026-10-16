// @vssaros/dsh-kanban — core（纯业务逻辑，零 I/O、零 dsh 依赖）。
//
// 契约真源：`src/vs/sessions/common/agentStudioTypes.ts` 的 TaskBoardRecord / TaskBoardStatus /
// TaskSource / DEFAULT_BOARD_ID，以及 IDE 侧 `agentTaskBoardService.ts` 的 createTask / updateTask /
// _generateId / _sanitizeDescription 语义。方案 6.9 方案 C：契约共享、实现各自一份；core 归插件，
// `src/vs` 不得 import 本包。
//
// 本文件可被单独单测（poc/dsh-p0/scripts/p3-02）：所有函数只吃字符串/对象，不碰 fs。

/** 与 `TaskBoardStatus` 逐项一致；数组顺序即看板列顺序（用于稳定排序）。 */
export const STATUSES = ['triage', 'todo', 'ready', 'running', 'blocked', 'done', 'cancelled', 'archived'];

/** 与 IDE updateTask 一致：进入这三个状态时写 completedAt，退回其它状态时清掉。 */
export const TERMINAL_STATUSES = ['done', 'cancelled', 'archived'];

/** 与 `TaskSource` 一致；本插件的工具创建一律为 `manual`（模型代用户手工建卡）。 */
export const SOURCES = ['manual', 'delegation', 'tapd', 'boardLink', 'web'];

export const PRIORITIES = ['low', 'medium', 'high'];

/** 与 `DEFAULT_BOARD_ID` 一致。 */
export const DEFAULT_BOARD_ID = 'default';

/**
 * 解析 `boards.json`（**看板元数据**，README 5.117 / 数据面 C 组）。
 *
 * 真源 = `src/vs/sessions/common/agentStudioTypes.ts` 的 `TaskBoard` ✓：
 * `{ id, name, workspaceId, order?, createdAt, updatedAt }` ✓；IDE 侧由 `agentTaskBoardService._readBoards`
 * 整表读、`_writeBoards` 整表写（**同一个取锁咽喉** `_atomicWriteFile` ✓）。
 *
 * ⚠ 为什么只要这三个字段 ✓：`{ id, name, workspaceId }` 是**有消费者**的那部分 ✓（模型要按 boardId 过滤
 * 任务 ✓，就得先知道**有哪些 boardId、叫什么** ✓）；`order` / `createdAt` / `updatedAt` 目前**没人读** ✗
 * ⇒ 不放进来 ✓（5.83 的教训：注册了没人用的字段等于没有 ✓，还要随会话日志走 ✗）。
 *
 * ⚠ **防御性**（同 `sessions.json` 那条 ✓）：只在类型对得上时才收 ✓；形态不认识 ⇒ 返回**空表 + 原因** ✓，
 * 绝不猜 ✗（调用方据此如实说明"只有 default 板" ✓）。
 *
 * @returns `{ boards, error? }` —— `error` 只在**有文件但读不懂**时给（文件不存在由 store 层区分 ✓）。
 */
export function parseBoards(text) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { boards: [], error: `boards.json 不是合法 JSON：${String(e?.message ?? e)}` };
	}
	if (!Array.isArray(raw)) {
		return { boards: [], error: `boards.json 顶层不是数组（收到 ${typeof raw}）` };
	}
	const boards = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') { continue; }
		if (typeof item.id !== 'string' || !item.id.trim()) { continue; }
		boards.push({
			id: item.id.trim(),
			name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.id.trim(),
			...(typeof item.workspaceId === 'string' && item.workspaceId ? { workspaceId: item.workspaceId } : {}),
		});
	}
	return { boards };
}

/** 与 IDE `_generateId()` 同形（`task_<ms>_<base36 7 位>`），便于两侧日志互查。 */
export function generateTaskId(nowMs = Date.now(), random = Math.random) {
	return `task_${nowMs}_${random().toString(36).substring(2, 9)}`;
}

/**
 * 与 IDE `_sanitizeDescription()` 一致：把内联 base64 data URI 换成占位符，
 * 避免 MB 级图片/附件把 taskboard.json 撑爆（IDE 在渲染与执行时都会跑正则，代价很高）。
 */
export function sanitizeDescription(desc) {
	if (typeof desc !== 'string' || !desc) {
		return desc;
	}
	if (desc.indexOf('data:') === -1) {
		return desc;
	}
	const dataUriRe = /(?:(!?\[([^\]]*)\]\())?data:([\w/+-]+);base64,([A-Za-z0-9+/=]+)\)?/gi;
	let img = 0;
	let file = 0;
	return desc.replace(dataUriRe, (_full, _prefix, _alt, mimeType) => {
		if (typeof mimeType === 'string' && mimeType.startsWith('image/')) {
			img++;
			return `[图片: ${img}]`;
		}
		file++;
		return `[文件: ${file}]`;
	});
}

/** 解析 taskboard.json：顶层必须是记录数组（形态变了就报错，不猜、不静默返回空）。 */
export function parseTaskboard(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		throw new Error(`看板数据不是合法 JSON：${e?.message ?? e}`);
	}
	if (!Array.isArray(parsed)) {
		throw new Error('看板数据结构不认识：顶层应为记录数组');
	}
	return parsed.filter(t => t && typeof t === 'object' && !Array.isArray(t));
}

/** 序列化：与 IDE `JSON.stringify(tasks, null, 2)` 完全一致（2 空格缩进）。 */
export function serializeTaskboard(tasks) {
	return JSON.stringify(tasks, null, 2);
}

function statusRank(status) {
	const i = STATUSES.indexOf(String(status ?? ''));
	return i < 0 ? STATUSES.length : i;
}

/** 过滤 + 稳定排序（未完成在前、同状态按更新时间倒序）+ 截断。 */
export function selectTasks(tasks, args = {}, limits = { default: 50, max: 200 }) {
	const rawLimit = args.limit;
	const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), limits.max) : limits.default;
	const boardId = typeof args.boardId === 'string' ? args.boardId.trim() : '';
	const status = typeof args.status === 'string' ? args.status.trim() : '';
	const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
	const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : '';
	const matched = tasks.filter(t => {
		if (status && String(t.status ?? '') !== status) {
			return false;
		}
		if (boardId && String(t.boardId ?? '') !== boardId) {
			return false;
		}
		if (workspaceId && String(t.workspaceId ?? '') !== workspaceId) {
			return false;
		}
		if (query && !String(t.title ?? '').toLowerCase().includes(query)) {
			return false;
		}
		return true;
	});
	matched.sort((a, b) => {
		const byStatus = statusRank(a.status) - statusRank(b.status);
		if (byStatus !== 0) {
			return byStatus;
		}
		return String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? ''));
	});
	return { total: matched.length, tasks: matched.slice(0, limit) };
}

/** 只保留跨进程有用的字段（字段名与 TaskBoardRecord 一致；缺省字段不出现）。 */
export function project(task) {
	const out = { id: String(task.id ?? ''), title: String(task.title ?? ''), status: String(task.status ?? '') };
	if (task.boardId) {
		out.boardId = String(task.boardId);
	}
	if (task.priority) {
		out.priority = String(task.priority);
	}
	if (task.assigneeName) {
		out.assigneeName = String(task.assigneeName);
	}
	if (task.url) {
		out.url = String(task.url);
	}
	if (task.workspaceId) {
		out.workspaceId = String(task.workspaceId);
	}
	const at = task.updatedAt ?? task.createdAt;
	if (at) {
		out.updatedAt = String(at);
	}
	return out;
}

/** `kanban_show` 的描述上限：描述里会累积注释/阻塞原因，回执不该被它撑爆（超了如实标记）。 */
export const DETAIL_DESCRIPTION_LIMIT = 4000;

/**
 * `kanban_show` 用的**详情投影**：比 {@link project} 多给描述与依赖。
 *
 * 为什么列表/写入回执不这么做：描述会随注释与阻塞原因不断变长（`[COMMENT …]` 一行行累积），
 * 每张卡都带上它会让列表回执变得又大又没用。只有"看单张卡"才需要全文。
 */
export function projectDetail(task) {
	const out = project(task);
	const description = optionalText(task.description);
	if (description) {
		out.description = description.length > DETAIL_DESCRIPTION_LIMIT ? description.slice(0, DETAIL_DESCRIPTION_LIMIT) : description;
		out.descriptionTruncated = description.length > DETAIL_DESCRIPTION_LIMIT;
	}
	if (Array.isArray(task.dependencies) && task.dependencies.length) {
		out.dependencies = task.dependencies.map(id => String(id));
	}
	if (task.createdAt) {
		out.createdAt = String(task.createdAt);
	}
	if (task.completedAt) {
		out.completedAt = String(task.completedAt);
	}
	return out;
}

function requireText(value, field) {
	const text = typeof value === 'string' ? value.trim() : '';
	if (!text) {
		throw new Error(`${field} 不能为空`);
	}
	return text;
}

function optionalText(value) {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeBoardId(value) {
	return optionalText(value) ?? DEFAULT_BOARD_ID;
}

/**
 * 新建记录。字段与 IDE createTask 对齐（含 `priority: 'medium'`、`boardId: 'default'`、
 * `dependencies: []`、`source: 'manual'`），并强制要求非空 `workspaceId`：
 * IDE 的 `getTasks(workspaceId)` 会按此过滤，写错/为空的话卡片在看板界面里根本看不到。
 */
export function createRecord(input = {}, options = {}) {
	const now = options.now ?? new Date().toISOString();
	const workspaceId = requireText(input.workspaceId, 'workspaceId');
	// 默认进 triage：与 IDE 的 legacy 工具 `kanban_create` 一致（"triage = 待分解/细化"），
	// 这样看板的阶段机（triage → specify/decompose → todo/ready → running → …）在两种引擎下同形。
	const status = STATUSES.includes(input.status) ? input.status : 'triage';
	const priority = PRIORITIES.includes(input.priority) ? input.priority : 'medium';
	const record = {
		id: options.id ?? generateTaskId(options.nowMs ?? Date.now(), options.random ?? Math.random),
		title: requireText(input.title, 'title'),
		status,
		source: 'manual',
		assigneeName: optionalText(input.assigneeName),
		workspaceId,
		boardId: normalizeBoardId(input.boardId),
		priority,
		dependencies: [],
		createdAt: now,
		updatedAt: now,
	};
	const description = sanitizeDescription(input.description);
	if (description) {
		record.description = description;
	}
	const url = optionalText(input.url);
	if (url) {
		record.url = url;
	}
	if (TERMINAL_STATUSES.includes(status)) {
		record.completedAt = now;
	}
	return record;
}

/**
 * 更新记录。语义与 IDE updateTask 一致：字段合并、强制保留 id、刷新 updatedAt；
 * `status` 变更时按终态写/清 `completedAt`。返回新记录与被改动的字段名列表。
 */
export function applyUpdate(task, patch = {}, now = new Date().toISOString()) {
	const next = { ...task };
	const changed = [];
	if (patch.title !== undefined) {
		next.title = requireText(patch.title, 'title');
		changed.push('title');
	}
	if (patch.description !== undefined) {
		const description = sanitizeDescription(patch.description);
		if (description) {
			next.description = description;
		} else {
			delete next.description;
		}
		changed.push('description');
	}
	if (patch.status !== undefined) {
		if (!STATUSES.includes(patch.status)) {
			throw new Error(`未知状态：${String(patch.status)}（可用：${STATUSES.join(' / ')}）`);
		}
		next.status = patch.status;
		// 与 IDE 一致：进终态写 completedAt，退回非终态清掉（= 设为 undefined，序列化时消失）
		next.completedAt = TERMINAL_STATUSES.includes(patch.status) ? now : undefined;
		changed.push('status');
	}
	if (patch.priority !== undefined) {
		if (!PRIORITIES.includes(patch.priority)) {
			throw new Error(`未知优先级：${String(patch.priority)}（可用：${PRIORITIES.join(' / ')}）`);
		}
		next.priority = patch.priority;
		changed.push('priority');
	}
	if (patch.boardId !== undefined) {
		next.boardId = normalizeBoardId(patch.boardId);
		changed.push('boardId');
	}
	if (patch.url !== undefined) {
		const url = optionalText(patch.url);
		if (url) {
			next.url = url;
		} else {
			delete next.url;
		}
		changed.push('url');
	}
	if (patch.assigneeName !== undefined) {
		const assigneeName = optionalText(patch.assigneeName);
		if (assigneeName) {
			next.assigneeName = assigneeName;
		} else {
			delete next.assigneeName;
		}
		changed.push('assigneeName');
	}
	if (patch.dependencies !== undefined) {
		// 依赖（`kanban_link` 写它）：去重但**保序**（IDE legacy 也走 Set 保序）。
		// 空数组 ⇒ 删字段（"没有依赖"在 IDE 的数据里就是没有这个键）。
		if (!Array.isArray(patch.dependencies)) {
			throw new Error(`dependencies 必须是数组：${String(patch.dependencies)}`);
		}
		const deps = [...new Set(patch.dependencies.map(value => optionalText(value)).filter(Boolean))];
		if (deps.length) {
			next.dependencies = deps;
		} else {
			delete next.dependencies;
		}
		changed.push('dependencies');
	}
	if (!changed.length) {
		throw new Error('没有要修改的字段（可改：title / description / status / priority / boardId / url / assigneeName / dependencies）');
	}
	next.id = task.id;
	next.updatedAt = now;
	return { task: next, changed };
}
