/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 从 Git 安装技能 —— 纯逻辑（无 IO，便于单测）。
 *
 * 包含两部分：
 *   1. `parseGitSkillUrl`：解析用户输入的 git URL。
 *      支持：
 *        - 普通仓库地址 `https://github.com/owner/repo`（`.git` 后缀可选）
 *        - GitHub 子目录链接 `https://github.com/owner/repo/tree/<branch>/<subdir>`
 *        - GitLab 子目录链接 `https://gitlab.com/owner/repo/-/tree/<branch>/<subdir>`
 *      拒绝 ssh 形式（`git@host:...` / `ssh://...`）—— isomorphic-git 仅 http(s) 传输。
 *   2. `selectSkillRootFromPaths`：从克隆产物中列出的 SKILL.md 相对路径里
 *      选出技能根目录（根目录优先；唯一嵌套目录；多个则报歧义）。
 */

export interface IGitSkillUrl {
	/** 用于浅克隆的仓库根 URL */
	readonly cloneUrl: string;
	/** 仓库内技能子目录（POSIX 相对路径，无首尾斜杠）；undefined = 自动探测 */
	readonly subdir?: string;
}

export type GitSkillUrlParseResult =
	| { readonly ok: true; readonly value: IGitSkillUrl }
	| { readonly ok: false; readonly error: string };

/** 解析用户输入的 git URL 为克隆地址 + 可选子目录。 */
export function parseGitSkillUrl(raw: string): GitSkillUrlParseResult {
	const input = raw.trim();
	if (!input) {
		return { ok: false, error: '请输入 git 仓库地址' };
	}
	if (/^(git@|ssh:\/\/)/i.test(input)) {
		return { ok: false, error: '暂不支持 ssh 形式的 git 地址（git@host:...），请改用 https URL' };
	}

	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return { ok: false, error: `无法解析为 URL：${input}` };
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		return { ok: false, error: `仅支持 http(s) git URL，当前协议：${url.protocol}` };
	}

	// 提取子目录：GitHub `/tree/<branch>/<subdir>` 与 GitLab `/-/tree/<branch>/<subdir>`
	let pathname = url.pathname.replace(/\/+$/, '');
	let subdir: string | undefined;
	const treeMatch = /^(.*?)\/(?:-\/)?tree\/([^/]+)(?:\/(.+))?$/.exec(pathname);
	if (treeMatch) {
		pathname = treeMatch[1] || '/';
		const sub = treeMatch[3]?.replace(/\/+$/, '');
		if (sub) {
			subdir = sub;
		}
	}

	// 仓库路径必须至少有 owner/repo 两段
	const repoPath = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
	if (repoPath.split('/').filter(Boolean).length < 2) {
		return { ok: false, error: `URL 缺少仓库路径（应为 host/owner/repo）：${input}` };
	}

	// 重组克隆地址（保留端口与嵌入凭据，丢弃 query/hash）
	const cloneUrl = `${url.protocol}//${url.host}/${repoPath}.git`;
	return { ok: true, value: { cloneUrl, subdir } };
}

export type SkillRootSelection =
	| { readonly ok: true; readonly dir: string }
	| { readonly ok: false; readonly error: string };

/**
 * 从克隆产物中的 SKILL.md 相对路径列表选出技能根目录。
 *
 * @param skillMdRelPaths POSIX 相对路径（如 `SKILL.md`、`skills/a/SKILL.md`）
 * @param subdir 用户 URL 显式指定的子目录（指定后只认 `<subdir>/SKILL.md`）
 * @returns dir 为 `.`（仓库根）或子目录路径
 */
export function selectSkillRootFromPaths(skillMdRelPaths: readonly string[], subdir?: string): SkillRootSelection {
	const normalized = skillMdRelPaths.map(p => p.replace(/\\/g, '/').replace(/^\/+/, ''));

	if (subdir) {
		const target = `${subdir}/SKILL.md`;
		if (normalized.some(p => p.toLowerCase() === target.toLowerCase())) {
			return { ok: true, dir: subdir };
		}
		return { ok: false, error: `子目录 "${subdir}" 中没有 SKILL.md` };
	}

	// 根目录优先
	if (normalized.some(p => p.toLowerCase() === 'skill.md')) {
		return { ok: true, dir: '.' };
	}

	// 唯一嵌套目录 → 用之；多个 → 歧义报错
	const dirs = [...new Set(normalized.map(p => p.slice(0, p.lastIndexOf('/'))))].sort();
	if (dirs.length === 0) {
		return { ok: false, error: '仓库中没有找到 SKILL.md（不是技能仓库）' };
	}
	if (dirs.length === 1) {
		return { ok: true, dir: dirs[0] };
	}
	const preview = dirs.slice(0, 5).map(d => `"${d}"`).join(', ');
	const more = dirs.length > 5 ? ` 等 ${dirs.length} 个` : '';
	return { ok: false, error: `仓库包含多个技能（${preview}${more}），请改用指向具体子目录的链接（如 .../tree/main/${dirs[0]}）` };
}
