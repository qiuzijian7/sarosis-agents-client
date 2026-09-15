/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * [Saros] 工作区 folder 同步的**方向策略**与**反向投影**纯函数（方案 B' Step 1）。
 *
 * ## 背景：为什么要「反转」
 *
 * 2026-09-14 之前的数据流是 **registry → 窗口**：
 * Agent Studio 的 `workspaces.json`（`path` + `relatedFolders` + `worktreePath`）是真源，
 * `WorkspaceFolderSync` 把它投影成 VS Code 的 folder 列表。后果：
 *
 *   · 用户手写 3 个 folder 的 `.code-workspace` 只显示 1 个 —— 因为 registry 只知道 1 个；
 *   · 必须靠 `replace` / `union` 双分支小心区分「兜底文件」与「用户文件」，
 *     一旦判错就会把**别的工作区**的 root 带进来（实测事故：UE5EA 87.6 万节点图谱
 *     被一起加载 + 起 watcher，renderer 堆到 2.6GB 后 UI 卡死）。
 *
 * 反转后是 **窗口 → registry**：`.code-workspace`（或打开的文件夹）是真源，
 * registry 记录「当前工作区由哪些 root 组成」。
 *
 * ⚠ **原先这里写「污染防护从此是结构性的」—— 2026-09-14 当天即被证伪，勿再这样断言。**
 * 反转只消除了「registry → 窗口」这一条路径，实际又从两个地方漏出来：
 *   ① **另一个模块仍在写窗口**：SCM 同步由 `onDidChangeActiveWorkspace` 驱动，用**追加式**
 *      合并把目标工作区的 root 注入当前窗口，切回来时从不移除 ⇒ folder 列表单向膨胀，
 *      而 `updateFolders` 会**落盘** ⇒ 用户手写的 `.code-workspace` 被改成 5 个 folder。
 *   ② **反向投影本身会身份错配**：`activeWorkspaceId` 与「窗口打开的工作区文件」是两套
 *      独立标识，投影时不校验就会把 A 窗口的 folder 写进 B 工作区的 `relatedFolders`。
 * 现行防线：SCM 注入加方向门控（仅旧方向执行）+ 切换工作区时不投影 +
 * {@link isSameWorkspaceIdentity} 身份守卫。
 * ★ 教训：判断「是否结构性安全」必须枚举**所有写入者 × 所有触发时机**，
 *   而不是只看自己改的那条路。
 *
 * ## 为什么单独一个文件
 *
 * 这里全是**纯函数**：不碰服务、不做 I/O，可直接单测。
 * 本仓的经验是「重构前先把可独立测试的语义抽成纯函数测住」（MEMORY 方法论 #2）。
 */

/**
 * folder 同步方向。
 *
 * - `window-drives-registry`（**新默认**）：`.code-workspace` / 打开的文件夹是真源，
 *   窗口 folder 变化后写回 Agent Studio registry。
 * - `registry-drives-window`（**旧行为**，仅作回滚用）：registry 是真源，投影成 folder 列表。
 * - `off`：不做任何同步（排障用）。
 */
export type WorkspaceFolderSyncDirection = 'window-drives-registry' | 'registry-drives-window' | 'off';

/** 设置键 —— 注册处见 `agentStudio.contribution.ts`（`ConfigurationScope.MACHINE`）。 */
export const WORKSPACE_FOLDER_SYNC_DIRECTION_SETTING = 'sessions.agentStudio.workspace.folderSync';

/** 方案 B' Step 1 的默认方向。 */
export const DEFAULT_WORKSPACE_FOLDER_SYNC_DIRECTION: WorkspaceFolderSyncDirection = 'window-drives-registry';

/**
 * 把设置值收敛成合法方向。
 *
 * **未知值一律回落默认**（不抛错）：同步器跑在窗口启动路径上，
 * 一个拼错的设置不该让窗口起不来。
 */
export function resolveSyncDirection(raw: unknown): WorkspaceFolderSyncDirection {
	if (raw === 'registry-drives-window' || raw === 'off' || raw === 'window-drives-registry') {
		return raw;
	}
	return DEFAULT_WORKSPACE_FOLDER_SYNC_DIRECTION;
}

/** 一个 folder 的最小描述（与 `IWorkspaceFolder` 结构兼容，但不依赖它）。 */
export interface IFolderSnapshot {
	readonly fsPath: string;
	readonly name: string;
}

/** 反向投影的结果 —— 要写回 registry 的字段。 */
export interface IRegistryProjection {
	/** 主 root（`workspace.path`）—— 取 `folders[0]`。 */
	readonly path: string | undefined;
	/** 其余 root（`workspace.relatedFolders`）—— `folders[1..]`。 */
	readonly relatedFolders: readonly { readonly path: string; readonly name: string }[];
}

/**
 * 由窗口当前的 folder 列表推导出 registry 应记录的内容。
 *
 * ★ 口径（刻意固定，不要"优化"）：
 * - `folders[0]` → `path`（主 root）。VS Code 的 folder **顺序**由 `.code-workspace`
 *   的 `folders[]` 决定，用户手写的顺序即优先级，不做重排。
 * - `folders[1..]` → `relatedFolders`。
 * - 空列表（EMPTY 态）→ `path: undefined` + 空数组，**不是**"保持原值" ——
 *   否则关闭工作区后 registry 仍指着旧 root，下次启动又把它带回来（这正是旧方向的病根）。
 *
 * ⚠ `worktreePath` **不在**投影范围内：它由 worktree 服务独立管理，
 * 且它对应的 folder 是同步器自己注入的，不是用户声明的 —— 混进来会造成自激循环。
 */
export function projectFoldersToRegistry(folders: readonly IFolderSnapshot[]): IRegistryProjection {
	if (folders.length === 0) {
		return { path: undefined, relatedFolders: [] };
	}
	return {
		path: folders[0].fsPath,
		relatedFolders: folders.slice(1).map(f => ({ path: f.fsPath, name: f.name })),
	};
}

/**
 * 大小写 / 尾斜杠 / 分隔符不敏感的路径比较键。
 *
 * ⚠ 三者都必须归一化（**单测实测**：第一版漏了分隔符，`G:/ws/Pocket/` 与
 * `g:\ws\pocket` 被判成不同 → 幂等闸门失效 → 每次 folder 事件都写一次 registry）。
 * registry 里的路径来自不同来源（用户手写的 `.code-workspace` 用 `/`、
 * `URI.fsPath` 在 Windows 上给 `\`），形态必然混用。
 *
 * 取舍：把 `\` 一律当分隔符处理。POSIX 下 `\` 是合法文件名字符，理论上可能误判两个
 * 不同文件为同一个 —— 但这里比较的是**工作区 root 目录**，且误判的后果仅是「跳过一次
 * 幂等写盘」，代价远低于「每次事件都写盘」。
 */
function pathKey(p: string): string {
	return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * 判断路径是否指向 `.code-workspace` **文件**（而非目录）。
 *
 * 与 `platform/workspace` 的 `hasWorkspaceFileExtension()` 同义 —— 此处内联是为让本模块
 * 保持**零依赖纯函数**（可直接单测）。
 */
function looksLikeWorkspaceFile(p: string | undefined): boolean {
	return !!p && p.toLowerCase().endsWith('.code-workspace');
}

// ─── 工作区身份（P0：把「记录」与「窗口」统一到同一个概念）──────────────────────
//
// ## 为什么需要这一层
//
// 长期病根：`activeWorkspaceId`（registry 游标 + `last-active-workspace.json`）与
// 「窗口打开的东西」（configPath / folders）是**两套独立标识**，二者之间没有任何
// 强制对应关系。于是反复出现同类症状：
//   · 启动时 `resolveDefaultActiveWorkspaceId()` 兜底选到**无关记录** ⇒
//     反向投影把 A 窗口的 folder 写进 B 工作区（09-14 跨工作区污染）；
//   · 记录 `path` 是**目录**、窗口是 `.code-workspace` **文件** ⇒ 身份比对失败 ⇒
//     守卫静默跳过 ⇒ 记录永远不同步、重启后多根丢失；
//   · 删除记录与窗口不联动（不知道该关哪个窗口）。
//
// 修法不是「再加一道守卫」，而是给「工作区身份」一个**显式、可计算**的定义，
// 让「这条记录是不是这个窗口」变成一次纯函数调用。

/**
 * 「窗口的工作区身份」—— 判定「registry 记录 ↔ 当前窗口是否同一个工作区」的唯一依据。
 *
 * 两个来源（按强度排序）：
 *   ① `codeWorkspacePath`：窗口打开的 `.code-workspace` **文件**。它是多根的**权威标识**
 *      （文件里声明了 folders 的顺序与内容），比任何 root 比对都可靠。
 *   ② `primaryFolderPath`：窗口主 root（`folders[0]`）。窗口无工作区文件时（单文件夹
 *      工作区），它本身就是身份。
 */
export interface IWorkspaceIdentity {
	/** 窗口打开的 `.code-workspace` 文件路径（若有）。 */
	readonly codeWorkspacePath?: string;
	/** 窗口主 root 目录（`folders[0]`）。 */
	readonly primaryFolderPath?: string;
	/** 窗口全部 root（顺序即 `.code-workspace` 声明的顺序）。 */
	readonly folderPaths: readonly string[];
}

/** 由窗口状态构造身份（`configPath` 来自 `IWorkspaceContextService.getWorkspace().configuration`）。 */
export function workspaceIdentityFromWindow(
	configPath: string | undefined,
	folderPaths: readonly string[],
): IWorkspaceIdentity {
	return {
		codeWorkspacePath: configPath,
		primaryFolderPath: folderPaths[0],
		folderPaths,
	};
}

/** registry 记录侧的身份字段视图（`Workspace` 结构天然满足它，无需转换）。 */
export interface IWorkspaceIdentityCarrier {
	/** 主 root 目录；**legacy 数据里也可能是 `.code-workspace` 文件路径**。 */
	readonly path?: string;
	/** 显式的工作区文件路径（新字段，见 `Workspace.codeWorkspacePath`）。 */
	readonly codeWorkspacePath?: string;
	readonly relatedFolders?: readonly { readonly path: string }[];
}

/**
 * 匹配强度 —— 带上「凭什么匹配上的」，便于日志排障。
 * 由强到弱：`code-workspace-file` > `primary-root` > `same-root-set` > `none`。
 */
export type WorkspaceIdentityMatch = 'code-workspace-file' | 'primary-root' | 'same-root-set' | 'none';

const MATCH_RANK: Record<WorkspaceIdentityMatch, number> = {
	'code-workspace-file': 3,
	'primary-root': 2,
	'same-root-set': 1,
	'none': 0,
};

/**
 * 记录侧的工作区文件路径。
 *
 * 优先显式字段 `codeWorkspacePath`；回落「`path` **本身就是** `.code-workspace` 文件」
 * —— 这条回落正是**legacy 数据无需迁移即可被正确匹配**的原因（历史记录把文件路径
 * 存在了 `path` 里）。
 */
export function recordCodeWorkspacePath(record: IWorkspaceIdentityCarrier): string | undefined {
	if (record.codeWorkspacePath) {
		return record.codeWorkspacePath;
	}
	return looksLikeWorkspaceFile(record.path) ? record.path : undefined;
}

/**
 * 判定一条 registry 记录是否就是「这个窗口」。
 *
 * 三级判据（短路，取到即返回）：
 *   ① **工作区文件相同** —— 最强。两边都有文件标识时**只认这一条**：文件不同就是
 *      不同工作区，不再往下比 root（否则「两个不同工作区恰好共享同一个 root」会误判）。
 *   ② **主 root == 记录的目录** —— 覆盖单文件夹窗口，以及「窗口是文件态、记录是目录态」
 *      这种跨形态对应（这正是此前身份比对失败的场景）。
 *   ③ **同一组 root（顺序不敏感）** —— 兜底：记录 `path` 是目录但窗口 `folders[0]`
 *      与之不同（例如用户调换了 `.code-workspace` 里 folders 的顺序）。
 *
 * 只有窗口**完全没有 root 且没有工作区文件**（EMPTY 态）时，三级都不成立 ⇒ `none`。
 */
export function matchWorkspaceIdentity(
	record: IWorkspaceIdentityCarrier,
	identity: IWorkspaceIdentity,
): WorkspaceIdentityMatch {
	// ① 工作区文件
	const windowFile = identity.codeWorkspacePath;
	const recordFile = recordCodeWorkspacePath(record);
	if (windowFile && recordFile) {
		return pathKey(windowFile) === pathKey(recordFile) ? 'code-workspace-file' : 'none';
	}

	// `path` 是文件时它**不是**目录，不能参与下面两级的目录比对。
	const recordDir = looksLikeWorkspaceFile(record.path) ? undefined : record.path;

	// ② 主 root
	if (identity.primaryFolderPath && recordDir
		&& pathKey(identity.primaryFolderPath) === pathKey(recordDir)) {
		return 'primary-root';
	}

	// ③ 同一组 root（顺序不敏感）
	if (identity.folderPaths.length > 0) {
		const recordRoots = [recordDir, ...(record.relatedFolders ?? []).map(f => f.path)]
			.filter((p): p is string => !!p);
		if (recordRoots.length === identity.folderPaths.length) {
			const a = recordRoots.map(pathKey).sort();
			const b = identity.folderPaths.map(pathKey).sort();
			if (a.every((p, i) => p === b[i])) {
				return 'same-root-set';
			}
		}
	}

	return 'none';
}

/**
 * 在记录集合里找出「就是这个窗口」的那条，并返回**匹配强度**。
 *
 * 多条命中时取**最强**的一条（例如既有「文件相同」又有「root 集合相同」的记录，
 * 取前者）。都不命中返回 `undefined` —— 调用方据此走「兜底」而不是「随便挑一条」。
 */
export function findWorkspaceByIdentity<T extends IWorkspaceIdentityCarrier>(
	records: readonly T[],
	identity: IWorkspaceIdentity,
): { readonly record: T; readonly match: WorkspaceIdentityMatch } | undefined {
	let best: { record: T; match: WorkspaceIdentityMatch } | undefined;
	for (const record of records) {
		const match = matchWorkspaceIdentity(record, identity);
		if (match === 'none') {
			continue;
		}
		if (!best || MATCH_RANK[match] > MATCH_RANK[best.match]) {
			best = { record, match };
		}
	}
	return best;
}

/**
 * 「当前窗口」与「registry 记录」是否指向**同一个工作区**。
 *
 * 判据：窗口的**主 root**（`folders[0]`）== registry 的 `path`（大小写/分隔符不敏感）。
 *
 * ★ 为什么需要它（2026-09-14 事故）：`activeWorkspaceId` 与「窗口打开的工作区文件」
 * 是**两套独立标识** —— 前者来自 registry + `last-active-workspace.json`，
 * 后者来自 configPath。启动时 `resolveDefaultActiveWorkspaceId()` 完全可能给出
 * 与当前窗口无关的记录；此时若无条件反向投影，就会把 A 窗口的 folder 写进
 * B 工作区的 `relatedFolders` ⇒ 跨工作区污染（实测把另一个工作区的 UE5EA
 * 写进了本工作区，UE5EA 有 87.6 万节点，历史上曾让 renderer 堆到 2.6GB 卡死）。
 *
 * 两边都为空视为**匹配**（EMPTY 态 + 尚未绑定路径的新记录）；
 * 一边有一边没有视为**不匹配**（宁可不写，也不要写错）。
 */
export function isSameWorkspaceIdentity(windowRootPath: string | undefined, registryPath: string | undefined): boolean {
	if (!windowRootPath && !registryPath) {
		return true;
	}
	if (!windowRootPath || !registryPath) {
		return false;
	}
	return pathKey(windowRootPath) === pathKey(registryPath);
}

/** 删除 registry 记录后，当前窗口该怎么处置。 */
export interface IDeleteWorkspaceWindowPlan {
	/** 是否把当前窗口转为**空工作区**（用户 2026-09-15 裁决：删当前工作区 = 窗口一并关闭）。 */
	readonly closeWindowWorkspace: boolean;
	/** 是否要清掉 `last-user-workspace.json`，否则下次启动会把已删的工作区**复活**。 */
	readonly clearRememberedWorkspace: boolean;
}

/**
 * 决定「删除某条 registry 记录」时是否要把当前窗口转成空工作区。
 *
 * 判定链（必须**同时**满足才关窗口）：
 *   ① 删的是**当前活动**记录（`workspaceId === activeWorkspaceId`）；
 *   ② 且这条记录确实就是**当前窗口打开的东西**（{@link matchWorkspaceIdentity}）。
 *
 * ★ 为什么 ② 不可省：`activeWorkspaceId` 只是 registry 里的一个游标，
 * 完全可能与当前窗口无关（`resolveDefaultActiveWorkspaceId()` 会兜底选第一条）。
 * 少了 ② 就会出现「删一条跟本窗口无关的记录，却把用户正在编辑的工作区关掉」——
 * 这是不可接受的破坏性误伤。
 *
 * ★ 2026-09-15（P0）签名变更：原先收「窗口主 root + 记录 path」两个**字符串**，
 * 于是**记录 `path` 是 `.code-workspace` 文件**时二者永不相等 ⇒ 删掉当前工作区
 * 却不关窗口 ⇒ 用户认为「删除没生效」。改为收**记录**与**窗口身份**，走完整匹配
 * （文件 > 主 root > root 集合），两种数据形态都能正确判定。
 *
 * `clearRememberedWorkspace` 与关窗口同步：既然要转空工作区，就必须同时清掉
 * 「记住上次打开的工作区」，否则下次启动 `_readRememberedWorkspaceFile()` 会把
 * 刚删掉的工作区**又打开一遍**，用户会认为「删除没生效」。
 *
 * 纯函数：只接收记录与身份，不碰服务，便于把上面两条判定钉成单测。
 */
export function planWindowOnDeleteWorkspace(
	deletedWorkspaceId: string,
	activeWorkspaceId: string | undefined,
	deletedRecord: IWorkspaceIdentityCarrier | undefined,
	windowIdentity: IWorkspaceIdentity,
): IDeleteWorkspaceWindowPlan {
	const isActive = !!activeWorkspaceId && deletedWorkspaceId === activeWorkspaceId;
	// 「窗口本来就是空的」没有可关的工作区 —— 空身份与任何记录都不该判定为同一个。
	const windowIsEmpty = !windowIdentity.codeWorkspacePath && windowIdentity.folderPaths.length === 0;
	const matchesWindow = !windowIsEmpty
		&& !!deletedRecord
		&& matchWorkspaceIdentity(deletedRecord, windowIdentity) !== 'none';
	const close = isActive && matchesWindow;
	return { closeWindowWorkspace: close, clearRememberedWorkspace: close };
}

/**
 * 判断投影结果与 registry 现值是否**已经一致** —— 一致则跳过写盘。
 *
 * 为什么必须有：反向同步由 `onDidChangeWorkspaceFolders` 触发，而写 registry 又可能
 * （经由其它监听者）引发 folder 事件。没有这个「幂等闸门」就会**写盘风暴 / 自激循环**。
 * 比较按路径键（忽略大小写与尾斜杠），`name` 不参与 —— 改个显示名不值得写盘。
 */
export function isProjectionUnchanged(
	projection: IRegistryProjection,
	current: { readonly path?: string; readonly relatedFolders?: readonly { readonly path: string }[] },
): boolean {
	const currentPath = current.path ? pathKey(current.path) : undefined;
	const nextPath = projection.path ? pathKey(projection.path) : undefined;
	if (currentPath !== nextPath) {
		return false;
	}

	const currentRelated = (current.relatedFolders ?? []).map(f => pathKey(f.path));
	const nextRelated = projection.relatedFolders.map(f => pathKey(f.path));
	if (currentRelated.length !== nextRelated.length) {
		return false;
	}
	return currentRelated.every((p, i) => p === nextRelated[i]);
}
