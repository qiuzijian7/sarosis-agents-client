/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 子代理声明族（A3 同款拆分策略，2026-09-20）：类型枚举 / 权限矩阵 / 类型标签 / 隔离档 / 结构化预览。
 * 全部为纯声明（无实例状态、无本地依赖），自 unifiedSubAgentDispatch.ts 原样搬出（零行为改动）。
 * ⚠ 原文件以 `export *` 转出 ⇒ 调用点零改动；`const enum` 改 `enum`（跨模块 const enum
 * 在 esbuild 转译下有内联歧义，普通 enum 行为等价）。
 */

// ─── SubAgent Types (inspired by OpenCode's agent types) ──────────────────

/**
 * SubAgent type determines the permission profile and tool access.
 * Aligned with OpenCode's explore/general/scout pattern.
 */
export enum SubAgentType {
	/** Read-only codebase explorer — can search_code/glob/read, cannot edit or execute */
	Explore = 'explore',
	/** General-purpose agent — can read and write, but cannot spawn sub-agents */
	General = 'general',
	/** External research agent — can clone repos and fetch web, read-only */
	Scout = 'scout',
}

/**
 * B：探索型子代理的「真正探索类工具」集合（ground-truth 判定依据）。
 * 覆盖 3 个只读 explore agent 的实际工作面：
 *   - code-explorer：代码图谱/文件/搜索工具
 *   - researcher：web 搜索/抓取
 *   - data：代码执行
 * 不含 index_repository / index_status 等索引管理工具，以及 memory/task 等元工具——
 * explore 子代理只调用了这些，视为"未真正探索"（_buildGateContext 据此降级）。
 */
export const _EXPLORE_REAL_TOOLS: ReadonlySet<string> = new Set([
	// code-explorer — 代码图谱结构化检索
	'search_graph', 'query_graph', 'get_code_snippet', 'trace_path',
	'get_architecture', 'get_graph_schema', 'check_index_coverage',
	// code-explorer — 文件/文本检索
	'search_files', 'file_read', 'search_code',
	// researcher — web 检索
	'web_search', 'web_extract',
	// data — 代码执行（terminal 是真实实现；execute_code 是 stub 占位）
	'terminal',
]);

/**
 * Tool permission profile for each SubAgent type.
 * Inspired by OpenCode's permission system.
 */
export const SUB_AGENT_PERMISSIONS: Record<SubAgentType, {
	readonly canRead: boolean;
	readonly canWrite: boolean;
	readonly canExecute: boolean;
	readonly canWebFetch: boolean;
	readonly canWebSearch: boolean;
	readonly canCloneRepo: boolean;
	readonly canSpawnSubAgent: boolean;
	readonly allowedToolPatterns: readonly string[];
	readonly deniedToolPatterns: readonly string[];
}> = {
	[SubAgentType.Explore]: {
		canRead: true,
		canWrite: false,
		canExecute: false,
		canWebFetch: true,
		canWebSearch: true,
		canCloneRepo: false,
		canSpawnSubAgent: false,
		allowedToolPatterns: ['search_code', 'glob', 'list', 'read', 'webfetch', 'websearch', 'repo_overview'],
		deniedToolPatterns: ['*'],
	},
	[SubAgentType.General]: {
		canRead: true,
		canWrite: true,
		canExecute: true,
		canWebFetch: true,
		canWebSearch: true,
		canCloneRepo: false,
		canSpawnSubAgent: false,  // P0: 禁止 subagent 嵌套调 subagent
		allowedToolPatterns: ['*'],
		deniedToolPatterns: ['todowrite'],
	},
	[SubAgentType.Scout]: {
		canRead: true,
		canWrite: false,
		canExecute: false,
		canWebFetch: true,
		canWebSearch: true,
		canCloneRepo: true,
		canSpawnSubAgent: false,
		allowedToolPatterns: ['search_code', 'glob', 'list', 'read', 'webfetch', 'websearch', 'repo_overview', 'repo_clone'],
		deniedToolPatterns: ['*'],
	},
};

// ─── SubAgent Type Labels（delegate_task schema 的单一来源 — P2c 动态枚举）──
// 之前 delegate_task 的 inputSchema.type.enum 与 resolveType 各自硬编码了
// ['General','Explore','Scout'] 字面量，新增子 agent 类型（如 Critic/Planner）
// 时极易漏改导致 schema 与运行时漂移。此处集中为唯一来源：
//   - delegate_task 的 enum / 描述由这里动态生成
//   - handler 的 label→SubAgentType 反查也由这里完成
// 新增类型只需在数组追加一项，schema 与路由自动同步。
export interface ISubAgentTypeLabel {
	readonly value: SubAgentType;
	/** 暴露给 LLM 的显示标签（首字母大写，与历史 schema 兼容） */
	readonly label: string;
	/** 该角色的权限/用途简述，拼进 schema description */
	readonly description: string;
}

export const SUB_AGENT_TYPE_LABELS: ReadonlyArray<ISubAgentTypeLabel> = [
	{ value: SubAgentType.General, label: 'General', description: 'General-purpose (default) — can read+write+execute for build/edit/review work.' },
	{ value: SubAgentType.Explore, label: 'Explore', description: 'Read-only investigation / code search — also the batch-mode default.' },
	{ value: SubAgentType.Scout, label: 'Scout', description: 'Read-only external research — clone repos and fetch web/docs.' },
];

/** label（大小写不敏感）→ SubAgentType；未知/缺省回退 General。P2c 动态枚举反查。 */
export function resolveSubAgentTypeLabel(label?: string): SubAgentType {
	const hit = SUB_AGENT_TYPE_LABELS.find(
		(t) => t.label.toLowerCase() === (label ?? '').trim().toLowerCase(),
	);
	return hit?.value ?? SubAgentType.General;
}

// ─── SubAgent Isolation Level (P2b 显式两档隔离模型) ─────────────────────
// 之前系统只有一种隐式的「层级委派」模型——delegate_task / swarm worker 都复用
// 同一 dispatch，父 turn 的 AbortSignal 无差别级联取消子代 (P3)。但在 multi-agent
// safety 语境下应显式区分两种隔离档位 (对应 MiMo/AG2 supervisor-subagent vs swarm peer):
//
//  - 'subagent' (默认): 层级受控。继承父 worktree、父可注入上下文、父 turn abort
//    级联取消 (P3)。单向数据流，父完全掌控子生命周期。
//  - 'peer': 对等独立。peer 之间互不信任，只通过显式注入的 context (blackboard /
//    SharedMemory) 通信，**不**继承父的敏感上下文/worktree；更重要的是，父自己的
//    turn 结束 (abort) **不**级联取消 peer —— 父只是派了个对等协作者出去，其生命周期
//    独立，只有显式的 interruptSubAgent / swarm.cancelSwarm 才能停它。
//
// 两档在类型系统与安全契约上显式区分；未来新增隔离档位 (如 'sandbox') 只需在此追加。
export type SubAgentIsolationLevel = 'subagent' | 'peer' | 'process';

/** label（大小写不敏感）→ SubAgentIsolationLevel；未知/缺省回退 'subagent'。P2b。 */
export function resolveIsolationLevel(label?: string): SubAgentIsolationLevel {
  const v = (label ?? '').trim().toLowerCase();
  if (v === 'peer') { return 'peer'; }
  // 'process'（2026-09-20，P1 进程档）：内核跑 utilityProcess，工具/模型经 RPC 回父进程
  // —— 仅对只读型（explore/scout）有意义；写型配了也生效但审批面不变（审批仍在父进程）。
  if (v === 'process') { return 'process'; }
  return 'subagent';
  }

// ─── 结构化预览（工具 args/result 的卡片展示）─────────────────────────────

/** 解包 [{"type":"text","text":"…"}] 内容包装 → 拼接内层文本；非包装原样返回。 */
function unwrapTextWrapper(text: string): string {
	const t = text.trim();
	if (!t.startsWith('[')) { return text; }
	try {
		const parsed = JSON.parse(t);
		if (Array.isArray(parsed) && parsed.length > 0
			&& parsed.every(e => e !== null && typeof e === 'object'
				&& (e as { type?: unknown }).type === 'text'
				&& typeof (e as { text?: unknown }).text === 'string')) {
			return parsed.map(e => (e as { text: string }).text).join('\n');
		}
	} catch { /* not JSON */ }
	return text;
}

/**
 * 结构化预览截断（模块级导出以便单测；trace 事件的 argsPreview/resultPreview 共用）。
 * 规则：
 * 1. 先解 [{"type":"text","text":…}] 内容包装——否则 >maxLen 的数组结果会走顶层
 *    key 预算，产出 {"0":"{\"type\":\"text\"…}"} 的索引键垃圾，UI 显示成 "0"
 *    （2026-07-26 子代理卡片"搜索内容显示 0"事故）。
 * 2. search_code 类信封（{results:[…]}/{files:[…]}）→ 语义摘要（"N 命中: a.cpp:10, …"）。
 *    2026-07-27 事故：results 数组超预算被折叠成字符串 "[object]"（`[${typeof val}]`
 *    对数组 typeof==='object'），且最终 JSON.stringify 可能超 maxLen 被硬切成无效 JSON，
 *    下游 parse 失败退化为原始乱码——卡片同时出现 4 种样式。
 * 3. 对象 → 顶层 key 保留，value 按预算截断；超预算值类型感知占位
 *    （数组 [N 项]、对象 {M keys}，绝不产出 "[object]"）。
 * 4. 非 text 包装数组 → 元素摘要（前 3 项 + 项数），不泄露索引键。
 * 5. 非 JSON → 纯文本截断。
 */
export function previewStructured(text: string, maxLen: number): string {
	if (!text) { return text; }
	const unwrapped = unwrapTextWrapper(text);
	// search_code 类信封优先（短负载也摘要——可读性优于原始 JSON）
	const semantic = _trySummarizeSearchEnvelope(unwrapped, maxLen);
	if (semantic !== undefined) { return semantic; }
	if (unwrapped.length <= maxLen) { return unwrapped.trim(); }
	try {
		const parsed: unknown = JSON.parse(unwrapped);
		if (Array.isArray(parsed)) {
			const parts = parsed.slice(0, 3).map(e => {
				const s = typeof e === 'string' ? e : JSON.stringify(e);
				return s.length > 60 ? s.slice(0, 60) + '…' : s;
			});
			let out = parts.join(', ');
			if (parsed.length > 3) { out += `, …(${parsed.length} 项)`; }
			return out.length > maxLen ? out.slice(0, maxLen) + '…' : out;
		}
		if (typeof parsed === 'object' && parsed !== null) {
			const keys = Object.keys(parsed);
			const preview: Record<string, unknown> = {};
			let budget = maxLen - 2;
			for (const key of keys) {
				const val = (parsed as Record<string, unknown>)[key];
				const valStr = typeof val === 'string' ? val : JSON.stringify(val);
				if (budget <= 0) { preview[key] = '…'; break; }
				if (valStr.length <= budget) {
					preview[key] = val;
					budget -= valStr.length;
				} else {
					// 类型感知占位（旧实现 `[${typeof val}]` 对数组产出 "[object]" 垃圾）
					if (Array.isArray(val)) { preview[key] = `[${val.length} 项]`; }
					else if (val !== null && typeof val === 'object') { preview[key] = `{${Object.keys(val as Record<string, unknown>).length} keys}`; }
					else if (typeof val === 'string') { preview[key] = valStr.slice(0, budget) + '…'; }
					else { preview[key] = val; }
					budget = 0;
				}
			}
			const result = JSON.stringify(preview);
			if (result.length > maxLen) {
				// 不输出硬切的无效 JSON（下游 parse 失败会退化为原始乱码）——降级紧凑 k=v 文本
				const flat = Object.entries(preview).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
				return flat.length > maxLen ? flat.slice(0, maxLen - 1) + '…' : flat;
			}
			return result;
		}
	} catch { /* not JSON, fall through */ }
	return unwrapped.trim().slice(0, maxLen) + '…';
}

/**
 * search_code 类结果信封 → 单行语义摘要；非信封返回 undefined。
 * 支持 {results:[{filePath,path,name,lineNo}], total/total_grep_matches} 与
 * {files:[...], total_files} 两种信封（compact/full/files 各 mode 输出）。
 */
function _trySummarizeSearchEnvelope(text: string, maxLen: number): string | undefined {
	const t = text.trim();
	if (!t.startsWith('{')) { return undefined; }
	let parsed: unknown;
	try { parsed = JSON.parse(t); } catch { return undefined; }
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { return undefined; }
	const obj = parsed as Record<string, unknown>;
	// 路径压缩：保留末两段（UE 路径极长，全路径单项即爆预算）
	const shortPath = (p: string): string => {
		const n = p.replace(/\\/g, '/');
		const parts = n.split('/');
		return parts.length > 2 ? parts.slice(-2).join('/') : n;
	};
	const clip = (out: string): string => out.length > maxLen ? out.slice(0, Math.max(0, maxLen - 1)) + '…' : out;
	if (Array.isArray(obj['results'])) {
		const arr = obj['results'] as unknown[];
		// total_grep_matches（底层命中总数）优先于 total（本次返回条数）——摘要信息量更高
		const total = typeof obj['total_grep_matches'] === 'number' ? obj['total_grep_matches'] as number
			: typeof obj['total'] === 'number' ? obj['total'] as number : arr.length;
		const head = arr.slice(0, 3).map(r => {
			if (r !== null && typeof r === 'object') {
				const rec = r as Record<string, unknown>;
				const fp = rec['filePath'] ?? rec['path'] ?? rec['name'];
				if (typeof fp === 'string') {
					return typeof rec['lineNo'] === 'number' ? `${shortPath(fp)}:${rec['lineNo']}` : shortPath(fp);
				}
			}
			return typeof r === 'string' ? r : '';
		}).filter(Boolean).join(', ');
		return clip(`${total} 命中${head ? `: ${head}` : ''}${arr.length > 3 || total > arr.length ? ', …' : ''}`);
	}
	if (Array.isArray(obj['files'])) {
		const arr = obj['files'] as unknown[];
		const total = typeof obj['total_files'] === 'number' ? obj['total_files'] as number : arr.length;
		const head = arr.slice(0, 3).map(f => typeof f === 'string' ? shortPath(f) : '').filter(Boolean).join(', ');
		return clip(`${total} 个文件${head ? `: ${head}` : ''}${arr.length > 3 || total > arr.length ? ', …' : ''}`);
	}
	return undefined;
}
