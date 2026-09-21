/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 按文件串行的「写/编辑」互斥队列 —— 对齐 pi `withFileMutationQueue`（2026-09-21）。
 *
 * ## 为什么需要它（现在不做、将来必踩）
 *
 * 本仓主循环当前**一律串行**（`toolCallUtils.MAIN_LOOP_PARALLEL_TOOLS_ENABLED = false`，
 * 2026-07-22 产品决策：并行只保留在 ≥2 delegate_task 的 subagent 通道），因此
 * 「同一文件被两个读-改-写操作交错」暂时不会发生。但：
 *   · 并行执行机器**已经就位**（`agentOSService._executeToolCallsParallelStreaming`）；
 *   · 并行判定里的路径重叠检查（`shouldParallelizeToolBatch` 规则 3）用的是**字符串路径**
 *     —— 相对↔绝对、`/`↔`\`、Windows 大小写、符号链接等别名都能漏判；
 *   · 一旦恢复主循环并行，`patch`/`file_write` 的 read-modify-write 就会竞态 ⇒
 *     **丢更新（lost update）**：两个 patch 各自基于同一份原文计算，后写者覆盖先写者 ✗。
 * 此前唯一的防线是 `patch` 描述里那句「同批别对同一文件发多个 patch」—— 把正确性押在
 * **提示词**上（模型可违反、且占 token）。
 *
 * ## pi 的做法（本模块照搬其形状）
 *
 * pi 把正确性放在**运行时**：同 realpath 的 `write`/`edit` 共用一条队列串行执行，
 * **不同文件仍并行**（`withFileMutationQueue`，按 realpath 归一，abort 安全）。
 * 于是提示词里不需要任何「别同时改同一文件」的纪律。
 *
 * ## 本模块的边界与已知残留
 *
 *  - 队列键 = `realpath`（若注入）→ 绝对路径（若给了 root）→ 词法归一（分隔符/大小写）。
 *  - **不同键互不阻塞**：各持一条 Promise 链，锁粒度是"文件"而不是"全局"。
 *  - **不会因失败卡死**：任务抛错只影响它自己的返回，队尾仍会释放（见 `withFileMutationQueue`）。
 *  - `realpath` 注入而非直接依赖 `IFileService` ⇒ 本模块**可单测**（与 `symlinkGuard` 同一套路）。
 *  - 残留：目标文件**不存在**时拿不到 realpath，只能退化为词法键 —— 这对
 *    「同一个新文件被并发 file_write」仍有效（两条调用的词法键相同），但
 *    「经不同符号链接指向同一新文件」这种病态别名无法覆盖（与 pi 同样受限）。
 */

/**
 * 真实路径解析函数（与 `symlinkGuard.RealPathFn` 同形）。
 *
 * 注意本仓 `IFileService.realpath` 在「路径不存在 / 平台不支持」时**返回 undefined 而非抛错**，
 * 两种失败形态在本模块视为同一件事（拿不到真路径 → 退化为词法键）。
 */
export type MutationRealPathFn = (absolutePath: string) => Promise<string | undefined>;

/** 需要「同文件串行」的工具 → 其入参里承载路径的字段名。 */
export const FILE_MUTATING_TOOL_PATH_ARG: ReadonlyMap<string, string> = new Map([
	['patch', 'path'],
	['file_write', 'path'],
]);

/**
 * 词法归一：分隔符统一成 `/`、折叠重复分隔符与 `./`、Windows 下大小写不敏感。
 *
 * 纯函数、无 IO —— 这是队列键的**最后兜底**（拿不到 realpath 时只剩它）。
 */
export function normalizeMutationKey(pathLike: string): string {
	let p = pathLike.trim().replace(/\\/g, '/');
	// 折叠重复分隔符（`a//b` → `a/b`）与 `./` 段
	p = p.replace(/\/{2,}/g, '/').replace(/\/\.\//g, '/');
	if (p.length > 1 && p.endsWith('/')) { p = p.slice(0, -1); }
	// Windows 路径大小写不敏感 ⇒ 统一小写（`C:/Users/A.ts` 与 `c:/users/a.ts` 必须同键；
	// 但**盘符之外**的大小写差异在其它平台是不同文件，故只在 Windows 形状下折叠）。
	const isWinShaped = /^[a-zA-Z]:\//.test(p) || /^\/\/[^/]+\/[^/]+/.test(p);
	return isWinShaped ? p.toLowerCase() : p;
}

/**
 * 解析某次工具调用应使用的队列键。
 *
 * @returns 无需串行（非文件写工具 / 无路径入参）时返回 `undefined`。
 */
export async function resolveToolMutationKey(
	toolName: string,
	args: Readonly<Record<string, unknown>> | undefined,
	opts: {
		/** 工作区根（用于把相对路径补成绝对路径 —— 相对与绝对必须落到同一个键）。 */
		readonly rootPath?: string;
		/** 真实路径解析（best-effort；缺失或失败即退化）。 */
		readonly realpath?: MutationRealPathFn;
	},
): Promise<string | undefined> {
	const argKey = FILE_MUTATING_TOOL_PATH_ARG.get(toolName);
	if (!argKey) { return undefined; }
	const raw = args?.[argKey];
	if (typeof raw !== 'string' || raw.trim() === '') { return undefined; }

	// 绝对 / 相对：相对路径必须拼 root —— 否则同一文件的两种写法会落成两条键（等于没锁）。
	let abs = raw.trim();
	const isAbs = /^[a-zA-Z]:[\\/]/.test(abs) || abs.startsWith('\\\\') || abs.startsWith('/');
	if (!isAbs && opts.rootPath) {
		abs = `${opts.rootPath.replace(/[\\/]+$/, '')}/${abs}`;
	}
	if (opts.realpath) {
		try {
			const real = await opts.realpath(abs);
			if (real) { return normalizeMutationKey(real); }
		} catch { /* 拿不到真路径 ⇒ 退化（见模块头注释：两条失败形态语义相同） */ }
	}
	return normalizeMutationKey(abs);
}

/** 每个文件键一条 Promise 链（链尾是「已 settled」的安全值，故永不 reject）。 */
const _chains = new Map<string, Promise<unknown>>();

/**
 * 在同一文件键上串行执行任务；不同键互不阻塞。
 *
 * 关键约束（都由单测钉住）：
 *  1. **同键严格按调用顺序串行**（先进先出），后一个任务能看到前一个的副作用；
 *  2. **前一个任务失败不会阻塞后一个**（前序失败被吞掉，`task` 照常执行）——
 *     否则一次 patch 失败就会把该文件后续所有写入挂死 ✗；
 *  3. **返回值/异常原样透传给调用方**（工具层据此判失败，语义与未加锁时完全一致）；
 *  4. **队尾释放后删除条目**，避免 Map 无界增长（仅当自己仍是队尾时才删，
 *     防止把后来者的链一起删掉）。
 */
export function withFileMutationQueue<T>(filePath: string, task: () => Promise<T>): Promise<T> {
	const key = normalizeMutationKey(filePath);
	const prev = _chains.get(key) ?? Promise.resolve();
	// 前序无论成功/失败都执行 task（`then(task, task)`）：失败只属于前一个任务。
	const run = prev.then(task, task);
	const tail = run.then(() => undefined, () => undefined);
	_chains.set(key, tail);
	void tail.then(() => {
		if (_chains.get(key) === tail) { _chains.delete(key); }
	});
	return run;
}

/** 测试用：当前活跃的队列键数量（生产代码不需要）。 */
export function pendingFileMutationQueueCount(): number {
	return _chains.size;
}

/** 测试用：清空所有队列（避免用例间串扰）。 */
export function __resetFileMutationQueuesForTest(): void {
	_chains.clear();
}
