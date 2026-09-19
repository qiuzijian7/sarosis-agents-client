/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 「项目名按 root 唯一」—— 同名不同 root 的**设计级**修复判据（2026-09-16，用户裁决）。
 *
 * ## 问题（实测事故链）
 *
 * 项目名此前一律取 `basename(root)`（bootstrap 的 `projectOverride` 与 service 各处回落）。
 * 于是 `D:\GR_\S1Game` 与 `D:\PJDB\S1Game` **两个不同 root、同一个名字**：
 *
 *   · 内存 `GraphStore` 与主进程 SQLite 都以**项目名**为唯一键 ⇒ 两份图在同一个键下**合并**，
 *     之后再按 root 也拆不开（`[prune] same-name project(s) span multiple roots …` 只能告警）；
 *   · 用户视角是「检索结果串进了另一个同名工程的内容」。
 *
 * 现场日志（`vscode-app-1789535342777.log`）实证：
 * ```
 * [prune] same-name project(s) span multiple roots — data already merged under one project key,
 *         cannot split by root: S1Game(外: f:/pjdb_qiuzijian_main/s1game)
 * ```
 *
 * ## 判据
 *
 * 引入一份**持久化**的「basename 认领表」（`basename → 归一化 root`）：
 *
 *   · 某 basename **无人认领** ⇒ 当前 root 认领它，名字就是 `basename`（**绝大多数项目零迁移**）；
 *   · 认领者**就是自己** ⇒ 仍用 `basename`（跨会话稳定）；
 *   · 被**别的 root** 认领 ⇒ 用 `basename@<root 短哈希>`（**root 推导、跨会话稳定**）。
 *
 * 「认领」必须持久化（不能只看当前窗口的 root 集合）：污染发生在**不同工作区之间**
 * （GR_\S1Game ↔ PJDB\S1Game 不会同时在窗口里），只看当前窗口是发现不了的。
 *
 * ## 为什么用 `@<hash>` 而不是 `S1Game (GR_)`
 *
 * 项目名会被写进 SQLite 行、制品内的节点字段、以及若干 UI 列表 ——
 * `@` + 6 位 base36 无空格/无括号，天然安全；且**由 root 推导**（同一 root 永远同一名字）。
 * 若产品上更想要人类可读的 `S1Game (GR_)`，只需改 `resolveProjectName` 的拼接（语义不变）。
 *
 * 纯函数（无 DI、无 IO）⇒ 判据本身可单测；持久化与取用见 `codebaseGraphService`。
 */

/** 认领表文件格式版本（将来若要按 basename 记更多信息，据此迁移）。 */
export const PROJECT_NAME_CLAIMS_VERSION = 1;

/**
 * 一条认领记录。
 *
 * ★ 为什么同时存 `base`（**规范显示名**）而不只存 root：
 * 同一 root 可能以不同写法出现（`D:\GR_\S1Game` vs `d:/gr_/s1game`）—— 若显示名取自「本次路径的
 * basename」，同一个项目会在 SQLite 里被拆成 `S1Game` 与 `s1game` **两个键**。
 * 存下首次认领时的 basename ⇒ 之后无论以哪种写法出现，名字都**逐字节一致** ✓。
 */
export interface IProjectNameClaim {
	/** 归一化 root（判等用）。 */
	root: string;
	/** 规范显示名（首次认领时的 basename，原样保留大小写）。 */
	base: string;
}

/**
 * 认领表：`basename(小写) → 认领记录`。
 *
 * 键取小写：Windows 路径大小写不敏感，`S1Game` 与 `s1game` 必须视为同一条认领
 * （否则同一 root 的不同写法会各自认领、互相判为冲突）。显示名仍保留原始大小写（见 `base`）。
 */
export type ProjectNameClaims = Record<string, IProjectNameClaim>;

export interface IProjectNameClaimsFile {
	version: number;
	/** 认领表本体（键为 basename，值为归一化 root）。 */
	byBase: ProjectNameClaims;
}

/** 归一化 root（认领表的键值都用它比较）：去尾分隔符、`\`→`/`、小写。 */
export function normalizeRootForClaim(rootPath: string): string {
	return rootPath.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

/** 取路径末段（与 service 的 `_basename` 同语义；此模块保持无依赖）。 */
export function baseNameOf(rootPath: string): string {
	const norm = rootPath.replace(/[\\/]+$/, '').replace(/\\/g, '/');
	const idx = norm.lastIndexOf('/');
	return idx >= 0 ? norm.substring(idx + 1) : norm;
}

/**
 * root 的**短哈希**（FNV-1a → base36，6 位）。
 *
 * 用途：给「同名冲突」的 root 生成稳定后缀。要求：同一 root 永远同值（跨会话/跨窗口），
 * 不同 root 极低概率碰撞（6 位 base36 ≈ 2.2e9 空间；实际同名冲突的 root 通常只有 2~3 个）。
 */
export function shortRootHash(rootPath: string): string {
	const norm = normalizeRootForClaim(rootPath);
	let h = 0x811c9dc5;
	for (let i = 0; i < norm.length; i++) {
		h ^= norm.charCodeAt(i);
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
	}
	return h.toString(36).padStart(6, '0').slice(-6);
}

/**
 * 解析 root 的项目名（**纯函数**，判据本体）。
 *
 * @param rootPath 该项目所在的 root（folder 的 fsPath）
 * @param claims 已持久化的认领表（`basename → 归一化 root`）
 * @returns `name` = 该项目名；`claim` = 若本次需要**新认领**则给出待写入表项（否则 `undefined`）
 */
export function resolveProjectName(rootPath: string, claims: ProjectNameClaims): { name: string; claim?: IProjectNameClaim } {
	// 去首尾空白后再判空：纯空白路径（`"   "`）不是合法 root，不能占认领表
	const base = baseNameOf(rootPath).trim();
	if (!base) {
		// 路径异常（无法取名）⇒ 交调用方回落 `_default`，且不占用认领表
		return { name: '' };
	}
	const norm = normalizeRootForClaim(rootPath);
	const key = base.toLowerCase();
	const owner = claims[key];
	if (!owner) {
		return { name: base, claim: { root: norm, base } };
	}
	if (owner.root === norm) {
		// ★ 用**认领时记下的显示名**（不是本次路径的 basename）：同一 root 的写法差异
		// （大小写/分隔符）不得改变项目名 —— 否则 SQLite 里会出现 `S1Game` 与 `s1game` 两个键。
		return { name: owner.base || base };
	}
	return { name: `${owner.base || base}@${shortRootHash(norm)}` };
}

/**
 * 容错解析认领表文件（**纯函数**）。
 *
 * 任何异常形态（文件不存在内容、JSON 语法错、版本不符、字段类型不对）都回落空表 ——
 * 认领表是**便利数据**：丢了只会让某个 root 退回 `basename`（可能再次同名），绝不阻断启动。
 */
export function parseProjectNameClaims(raw: string | undefined | null): ProjectNameClaims {
	if (!raw) { return {}; }
	try {
		const parsed = JSON.parse(raw) as IProjectNameClaimsFile | null;
		if (!parsed || typeof parsed !== 'object') { return {}; }
		if (parsed.version !== PROJECT_NAME_CLAIMS_VERSION) { return {}; }
		const byBase = (parsed as IProjectNameClaimsFile).byBase;
		if (!byBase || typeof byBase !== 'object') { return {}; }
		const out: ProjectNameClaims = {};
		for (const [key, value] of Object.entries(byBase)) {
			if (!key) { continue; }
			const normKey = key.toLowerCase();
			// 兼容「值是 root 字符串」的形态（手改/旧文件）：显示名退回键本身
			if (typeof value === 'string') {
				if (value) { out[normKey] = { root: value, base: key }; }
				continue;
			}
			const claim = value as IProjectNameClaim | null;
			if (claim && typeof claim === 'object' && typeof claim.root === 'string' && claim.root) {
				out[normKey] = {
					root: claim.root,
					base: typeof claim.base === 'string' && claim.base ? claim.base : key,
				};
			}
		}
		return out;
	} catch {
		return {};
	}
}

/** 序列化认领表（**纯函数**；键排序保证文件内容稳定，便于 diff/排障）。 */
export function serializeProjectNameClaims(claims: ProjectNameClaims): string {
	const byBase: ProjectNameClaims = {};
	for (const key of Object.keys(claims).sort()) { byBase[key] = claims[key]; }
	const file: IProjectNameClaimsFile = { version: PROJECT_NAME_CLAIMS_VERSION, byBase };
	return JSON.stringify(file, null, '\t');
}
