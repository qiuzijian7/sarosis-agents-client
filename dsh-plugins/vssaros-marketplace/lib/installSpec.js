// @vssaros/dsh-marketplace — 安装 spec 形状对齐（★ 2026-11-24）
//
// 对齐上游 `@deepseek-ai/dsh-plugin-manager/src/install-spec.ts:16-20` 的
// `ParsedInstallSpec` 四类：`registry` / `path` / `tarball` / `git`。
//
// ★ 刻意**零依赖、零 I/O**：只做分类与校验，不接管 spec 拼接、不下载、不落盘。
//   原因：上游 preflight（`operations.ts:361-380`）是拿 **spec 字符串**去 `parseInstallSpec`
//   决定要不要 `pnpm view` 的 —— 字符串逐字不变，安装链行为才不变。
//   本模块产出的是「结构化诊断/分类」，供商城侧展示与守卫使用。
//
// ★ 不 import 上游包：它在 `dsh-runtime/<version>/node_modules` 里，Host 插件运行时
//   不一定能解析（且版本号会漂移）；这里只做**形状对齐**，不复用代码。

const GIT_SHORTHAND = /^(?:github|gitlab|bitbucket|gist):/i;
const GIT_URL = /^git(?:\+[a-z]+)?:\/\/|^git@[^:]+:/i;
const HOSTED_REPOSITORY_URL = /^https?:\/\/[^/]+\/[^/]+\/[^/#]+(?:\.git)?(?:#.*)?$/i;
const TARBALL_SPEC = /\.(?:tgz|tar\.gz)(?:#.*)?$/i;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PACKAGE_NAME_MAX_LENGTH = 214;
const GIT_SHORTHAND_HOSTS = {
	github: 'github.com', gitlab: 'gitlab.com',
	bitbucket: 'bitbucket.org', gist: 'gist.github.com',
};

/** 绝对路径判据（win32 盘符 / POSIX 根；与上游 isAbsolute 的常用形态一致）。 */
function isAbsoluteLike(p) {
	return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]/.test(p);
}

function gitHost(spec) {
	const m = /^([a-z]+):/i.exec(spec);
	if (m && GIT_SHORTHAND_HOSTS[m[1].toLowerCase()]) { return GIT_SHORTHAND_HOSTS[m[1].toLowerCase()]; }
	const scp = /^git@([^:]+):/i.exec(spec);
	if (scp) { return scp[1].toLowerCase(); }
	try { return new URL(spec.replace(/^git\+/i, '')).host; } catch { return ''; }
}

/**
 * 把一个 pnpm spec 标注成上游四类结构（判定顺序与 `parseInstallSpec` 一致）。
 * 只返回数据，**不抛异常**：无法分类时返回 `{ error }`，由调用方决定怎么处理。
 *
 * @param {string} raw
 * @returns {{kind?:string,spec?:string,name?:string,range?:string,path?:string,host?:string,error?:string}}
 */
export function classifyInstallSpec(raw) {
	const spec = String(raw ?? '').trim();
	if (!spec) { return { error: 'the package spec must not be empty' }; }
	const stripped = spec.replace(/^(?:file|link):/, '');
	if (stripped !== spec || isAbsoluteLike(stripped)) {
		if (!isAbsoluteLike(stripped)) { return { error: 'a local path must be absolute' }; }
		return TARBALL_SPEC.test(stripped)
			? { kind: 'tarball', spec, path: stripped }
			: { kind: 'path', spec, path: stripped };
	}
	if (/^\.{1,2}(?:[\\/]|$)/.test(spec)) { return { error: 'a local path must be absolute' }; }
	const git = GIT_SHORTHAND.test(spec) || GIT_URL.test(spec) || HOSTED_REPOSITORY_URL.test(spec);
	if (git && !TARBALL_SPEC.test(spec)) { return { kind: 'git', spec, host: gitHost(spec) }; }
	if (/^https?:\/\//i.test(spec)) {
		if (!TARBALL_SPEC.test(spec)) { return { error: 'a URL must point at a git repository or a tarball' }; }
		try { return { kind: 'tarball', spec, host: new URL(spec).host }; }
		catch { return { error: 'invalid tarball URL' }; }
	}
	const at = spec.indexOf('@', 1);
	const name = at === -1 ? spec : spec.slice(0, at);
	const range = at === -1 ? undefined : spec.slice(at + 1);
	if (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name)) {
		return { error: 'not a package name the registry accepts' };
	}
	if (range === '') { return { error: 'a version after @ must not be empty' }; }
	return range === undefined
		? { kind: 'registry', spec, name }
		: { kind: 'registry', spec, name, range };
}

/**
 * 商城 `distribution` → 上游四类结构 + 前置校验（**纯函数，不拼 spec**）。
 *
 * 对应关系：
 *   npm            → registry（name + 版本作 range）
 *   github-source  → git（固定 github.com 简写）
 *   github-release → tarball（本地 file:.tgz；下载/校验由调用方做）
 *   bundle（缺省） → 不走 pnpm，不进这个函数
 *
 * 错误文案与 `index.js` 的 `specForDistribution` **逐字一致**（保持对外契约）。
 *
 * @param {unknown} dist
 * @param {string} slug
 * @param {string} version
 */
export function classifyDistribution(dist, slug, version) {
	if (!dist || typeof dist !== 'object') {
		return { error: '这个商品没有登记发布源（distribution）⇒ 不知道从哪儿装' };
	}
	if (dist.type === 'npm') {
		if (!dist.name) { return { error: 'npm 发布源缺少包名' }; }
		return { kind: 'registry', name: String(dist.name), range: String(version ?? '') };
	}
	if (dist.type === 'github-source') {
		if (!dist.name) { return { error: 'github-source 发布源缺少 owner/repo' }; }
		return {
			kind: 'git', host: 'github.com', repo: String(dist.name),
			commit: dist.commit ? String(dist.commit) : '',
		};
	}
	if (dist.type === 'github-release') {
		if (!dist.url) { return { error: 'github-release 发布源缺少 url' }; }
		if (!dist.sha256) { return { error: 'github-release 发布源缺少 sha256（不校验就不装）' }; }
		return {
			kind: 'tarball', url: String(dist.url), sha256: String(dist.sha256),
			name: String(dist.name || slug),
		};
	}
	return { error: 'dsh 侧不认识的发布源类型：' + String(dist.type) };
}
