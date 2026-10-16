/*---------------------------------------------------------------------------------------------
 *  Session History — 工作区分组与组内配额（纯逻辑：无 DOM、无服务、无 storage）
 *
 *  本模块是「会话工作台按工作区划分」的**唯一**判据来源，被
 *  `browser/sessionHistoryView.ts`（左栏 sideview / 独立聊天窗口左栏）消费，
 *  由 `common/sessionGrouping.test.ts` 钉住行为。
 *
 *  ── 为什么单独成文件 ────────────────────────────────────────────────────────
 *  该面板是 2100+ 行的 DOM 类，分组与配额若写在渲染循环里就只能靠肉眼回归 ✗。
 *  抽成纯函数后可以断言「哪几条会话可见、折叠掉几条」这类**行为**，
 *  而不必起 DOM 或整个 workbench ✓。
 *
 *  ── 口径来自哪 ──────────────────────────────────────────────────────────────
 *  对照 dsh desktop 的会话侧栏（`@deepseek-ai/dsh-client-ui-workspace`，
 *  本机 `.runtime/0.2.1-alpha.1/node_modules/@deepseek-ai/` 下有该包）：
 *    · 默认「按工作区」分组，工作区作为同级分组；
 *    · 分组内默认显示 **5 条空闲**会话，**正在运行的会话始终按原顺序显示且不占这 5 条配额**；
 *    · 每次「展开其余」再多显示 5 条；全部显示后给「收起」。
 *  我们的差异（有意）：**只输出有会话的工作区**（dsh 会把空工作区也列出来）。
 *  理由：VsSaros 的工作区数量可达十位数，空组会淹没列表 ✗。
 *--------------------------------------------------------------------------------------------*/

/** 每组默认显示的空闲会话条数（正在运行的会话不占此配额）。 */
export const SESSION_GROUP_IDLE_LIMIT = 5;

/** 「展开其余」每次追加的条数。 */
export const SESSION_GROUP_EXPAND_STEP = 5;

/**
 * 「未归属任何工作区」的分组 key。
 *
 * 用 `\u0000` 前缀是**刻意**的：它与任何真实 workspaceId 都不可能撞
 * （真实 id 由 `agentStudioService._generateId` 生成，见 `Workspace.id`），
 * 于是折叠状态持久化时不必再额外存一个「这是未分组」的布尔 ✓。
 */
export const UNGROUPED_GROUP_KEY = '\u0000ungrouped';

/** 分组所需的最小工作区信息（`Workspace` 的结构子集，避免把整个类型拖进来）。 */
export interface IWorkspaceRef {
	readonly id: string;
	readonly name?: string;
	readonly path?: string;
}

/** 一个工作区分组的投影（渲染层只读它，不再自己判断归属）。 */
export interface ISessionGroup<T> {
	/** `workspaceId`；未分组为 {@link UNGROUPED_GROUP_KEY}。 */
	readonly key: string;
	/** 显示名（工作区名 → 路径末段 → id；未分组用调用方给的文案）。 */
	readonly title: string;
	/** 工作区路径（未分组 / 已删除为空串）。 */
	readonly path: string;
	/** 全局会话注册表里查不到该 workspaceId ⇒ 工作区已删除。 */
	readonly missing: boolean;
	/** 未归属任何工作区。 */
	readonly ungrouped: boolean;
	/** 组内会话（**保持入参顺序** —— 调用方已按 pinned → 手动顺序 → updatedAt 排好）。 */
	readonly sessions: readonly T[];
}

export interface IBuildSessionGroupsOptions {
	/** 未分组组的显示文案（本模块不依赖 nls，交由调用方本地化）。 */
	readonly ungroupedTitle?: string;
}

/** 取路径末段（同时认 `/` 与 `\`；模块不 import node:path，避免平台差异）。 */
export function lastPathSegment(path: string | undefined): string {
	const normalized = (path ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
	if (!normalized) { return ''; }
	const at = normalized.lastIndexOf('/');
	return at >= 0 ? normalized.slice(at + 1) : normalized;
}

/**
 * 工作区显示名：`name` → 路径末段 → `id`。
 *
 * 三级回退的必要性：`Workspace.name` 允许为空（`createSession` 那条链只用 id），
 * 而分组头若显示空字符串，用户看到的就是一个没有标题的分组 ✗。
 */
export function workspaceTitleOf(workspace: IWorkspaceRef): string {
	const name = (workspace.name ?? '').trim();
	if (name) { return name; }
	const segment = lastPathSegment(workspace.path);
	if (segment) { return segment; }
	return workspace.id;
}

/**
 * 按工作区把会话分组。
 *
 * 输出顺序：① `workspaces` 的顺序（**只输出有会话的**）→ ② 已删除的工作区
 * （按首次出现顺序）→ ③ 未分组（恒定在最后）。
 *
 * 注意 `workspaceIdOf` 的返回值语义：空串与 `undefined` **都**算「未归属」
 * （`AgentStudioSession.workspaceId` 允许是空串，见 `createSession`），
 * 二者不能只认其中一个 —— 否则那批会话会整批从列表里消失 ✗。
 */
export function buildSessionGroups<T>(
	sessions: readonly T[],
	workspaces: readonly IWorkspaceRef[],
	workspaceIdOf: (session: T) => string | undefined,
	options: IBuildSessionGroupsOptions = {},
): ISessionGroup<T>[] {
	interface IBucket {
		readonly title: string;
		readonly path: string;
		readonly sessions: T[];
	}

	const known = new Map<string, IWorkspaceRef>();
	for (const workspace of workspaces) {
		if (workspace && workspace.id) { known.set(workspace.id, workspace); }
	}

	const buckets = new Map<string, IBucket>();
	/** 首次出现顺序（只用于「已删除的工作区」，真实工作区按 `workspaces` 顺序）。 */
	const firstSeen: string[] = [];

	const bucketOf = (key: string, seed: { title: string; path: string }): IBucket => {
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = { title: seed.title, path: seed.path, sessions: [] };
			buckets.set(key, bucket);
			firstSeen.push(key);
		}
		return bucket;
	};

	for (const session of sessions) {
		const workspaceId = (workspaceIdOf(session) ?? '').trim();
		if (!workspaceId) {
			bucketOf(UNGROUPED_GROUP_KEY, {
				title: options.ungroupedTitle ?? 'Ungrouped',
				path: '',
			}).sessions.push(session);
			continue;
		}
		const workspace = known.get(workspaceId);
		if (workspace) {
			bucketOf(workspaceId, {
				title: workspaceTitleOf(workspace),
				path: (workspace.path ?? '').trim(),
			}).sessions.push(session);
		} else {
			// 工作区已被删除：保留会话（用户仍要能打开/改名/删除它），但如实标注。
			bucketOf(workspaceId, { title: workspaceId, path: '' }).sessions.push(session);
		}
	}

	const groups: ISessionGroup<T>[] = [];
	for (const workspace of workspaces) {
		if (!workspace || !workspace.id) { continue; }
		const bucket = buckets.get(workspace.id);
		if (bucket && bucket.sessions.length > 0) {
			groups.push({
				key: workspace.id,
				title: bucket.title,
				path: bucket.path,
				missing: false,
				ungrouped: false,
				sessions: bucket.sessions,
			});
		}
	}
	for (const key of firstSeen) {
		if (key === UNGROUPED_GROUP_KEY || known.has(key)) { continue; }
		const bucket = buckets.get(key);
		if (bucket && bucket.sessions.length > 0) {
			groups.push({ key, title: bucket.title, path: bucket.path, missing: true, ungrouped: false, sessions: bucket.sessions });
		}
	}
	const ungrouped = buckets.get(UNGROUPED_GROUP_KEY);
	if (ungrouped && ungrouped.sessions.length > 0) {
		groups.push({
			key: UNGROUPED_GROUP_KEY,
			title: ungrouped.title,
			path: '',
			missing: false,
			ungrouped: true,
			sessions: ungrouped.sessions,
		});
	}
	return groups;
}

/** 一个分组当前「显示哪些、折叠掉几条」。 */
export interface IGroupWindow<T> {
	readonly visible: readonly T[];
	/** 被折叠掉的**空闲**会话条数（正在运行的从不被折叠）。 */
	readonly hiddenIdle: number;
	/** 应当显示「展开其余 N 条」。 */
	readonly canExpand: boolean;
	/** 应当显示「收起」（已全部展开且展开过）。 */
	readonly canCollapse: boolean;
}

export interface IGroupWindowOptions {
	/** 默认 {@link SESSION_GROUP_IDLE_LIMIT}。 */
	readonly limit?: number;
	/** 搜索 / 过滤命中时传 true ⇒ 不做截断（否则「搜到的行被折叠掉了」）。 */
	readonly unlimited?: boolean;
}

/**
 * 组内可见会话（对照 dsh desktop 的行投影）。
 *
 * 两条规则（缺一都会破坏用户预期）：
 *  ① `isActive` 为真（执行中 / 等待用户）的会话**始终可见**，且**不占**「5 条」配额
 *     —— 否则「我明明看到它在跑，刷新一下就没了」✗；
 *  ② 空闲会话按原顺序取前 `limit + extraShown` 条，其余只计数不渲染。
 */
export function computeGroupWindow<T>(
	sessions: readonly T[],
	extraShown: number,
	isActive: (session: T) => boolean,
	options: IGroupWindowOptions = {},
): IGroupWindow<T> {
	if (options.unlimited) {
		return { visible: sessions.slice(), hiddenIdle: 0, canExpand: false, canCollapse: false };
	}

	const limit = Math.max(1, Math.floor(options.limit ?? SESSION_GROUP_IDLE_LIMIT));
	const extra = normalizeExtra(extraShown, 0);
	const quota = limit + extra;

	const visible: T[] = [];
	let idleShown = 0;
	let hiddenIdle = 0;
	for (const session of sessions) {
		if (isActive(session)) {
			visible.push(session);
			continue;
		}
		if (idleShown < quota) {
			idleShown++;
			visible.push(session);
		} else {
			hiddenIdle++;
		}
	}
	return {
		visible,
		hiddenIdle,
		canExpand: hiddenIdle > 0,
		canCollapse: extra > 0 && hiddenIdle === 0,
	};
}

/** 「展开其余」后的额外条数。容错：非有限值 / 负数 / 非正 step 一律回落默认值。 */
export function nextExtraShown(extraShown: number, step: number = SESSION_GROUP_EXPAND_STEP): number {
	const safeStep = Number.isFinite(step) && step > 0 ? Math.floor(step) : SESSION_GROUP_EXPAND_STEP;
	return normalizeExtra(extraShown, 0) + safeStep;
}

function normalizeExtra(value: number, fallback: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

/**
 * 解析持久化的字符串数组（折叠状态 / pinned / 手动顺序共用同一口径）。
 *
 * 为什么不用裸 `JSON.parse`：storage 里的值可能被旧版本或手改弄坏，
 * 坏值必须**降级为空**而不是让面板整体抛错（那会让侧栏直接空白 ✗）。
 */
export function parseStringArray(raw: string | undefined): string[] {
	if (!raw) { return []; }
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) { return []; }
		return parsed.filter((value): value is string => typeof value === 'string' && value.length > 0);
	} catch {
		return [];
	}
}
