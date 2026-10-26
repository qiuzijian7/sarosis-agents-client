/**
 * 从 GitHub 链接**自动识别**可发布信息（★ 2026-10-27 用户需求）。
 *
 * 用户原话："商城工作台中，增加一个 ai 助手…当用户发要发布一个 github 链接时，
 * 自动填写相关信息并上传到数据库中"。
 *
 * ## 为什么"不占 GitHub API 额度"是硬要求
 * 未认证的 `api.github.com` 只有 **60 请求/小时**。发布流程里如果一次要打三四个
 * API 调用，用户试几次就撞墙了（本项目已经踩过：抓 Cline 插件目录时 403 限流）✗
 *
 * ⇒ 这里**全部走不需要额度的通道**：
 * | 要什么 | 从哪拿 | 占额度 |
 * |---|---|---|
 * | 名称 / 描述 | 仓库页的 `<meta property="og:title/description">` | ❌ 不占 |
 * | logo | `https://github.com/<owner>.png?size=200`（真实头像） | ❌ 不占 |
 * | 版本号 | `raw.githubusercontent.com/<repo>/HEAD/package.json` | ❌ 不占 |
 * | 版本号（兜底） | `<repo>/releases/latest` 的 **302 Location** | ❌ 不占 |
 * | 是不是技能 | `raw…/HEAD/SKILL.md` 是否存在 | ❌ 不占 |
 * | 是不是 dsh 插件 | `raw…/HEAD/package.json` 里的 `dsh` 字段 | ❌ 不占 |
 *
 * ## kind 的自动判定顺序
 * `SKILL.md` 存在 ⇒ **skill**（技能包优先，因为它的语义最明确）
 * 否则 `package.json` 有 `dsh` 字段 ⇒ **plugin**
 * 否则 ⇒ 交给用户选（返回 `null`，UI 用默认值）
 */

import { createHash } from 'node:crypto';
// ★ 2026-10-27（依据 doc/marketplace-workbench-github-flow.html §6/§7）：
//   monorepo 的根不是插件，真身是已发到 npm 的子包 ⇒ 必须能识别出「该用 npm 发布源」
import { findNpmPackagesForRepo, peerRangeOf } from './npmLookup.js';
// ★ 2026-10-26（文档 §10 最后一条）：peerDependencies 兼容性**提示**（不阻断）
import { checkPeerCompat } from './hostVersion.js';

/** 把各种 GitHub 写法归一成 `owner/repo`。 */
export function normalizeRepo(input) {
	const raw = String(input ?? '').trim();
	if (!raw) { return ''; }
	// 完整 URL（含 /tree/main/xxx 这类子路径 ⇒ 只取前两段）
	const m = /github\.com\/([^/\s]+)\/([^/\s?#]+)/i.exec(raw);
	if (m) {
		const repo = m[2].replace(/\.git$/i, '');
		return validRepo(m[1], repo) ? `${m[1]}/${repo}` : '';
	}
	// `owner/repo` 简写
	const m2 = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(raw);
	if (m2) {
		const repo = m2[2].replace(/\.git$/i, '');
		return validRepo(m2[1], repo) ? `${m2[1]}/${repo}` : '';
	}
	return '';
}

const validRepo = (owner, repo) => Boolean(
	owner && repo
	&& /^[A-Za-z0-9_.-]+$/.test(owner)
	&& /^[A-Za-z0-9_.-]+$/.test(repo)
	&& owner !== '.' && owner !== '..' && repo !== '.' && repo !== '..',
);

/** `owner/repo` → 商城 slug（小写、只留 `[a-z0-9_-]`、≤64）。 */
export function slugOfRepo(repo) {
	const slug = String(repo ?? '').toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	if (slug.length <= 64) { return slug; }
	// 超长 ⇒ 截断 + 4 位 hash 保唯一（服务端 slug 上限 64）
	const h = createHash('sha1').update(slug).digest('hex').slice(0, 4);
	return `${slug.slice(0, 59).replace(/-$/, '')}-${h}`;
}

const UA = 'VsSarosMarket/1.0 (+self-hosted marketplace)';
const TIMEOUT = 15000;

async function fetchText(url, extraHeaders = {}) {
	const r = await fetch(url, {
		headers: { 'user-agent': UA, accept: 'text/html,application/json,*/*', ...extraHeaders },
		redirect: 'follow',
		signal: AbortSignal.timeout(TIMEOUT),
	});
	if (!r.ok) { return { ok: false, status: r.status }; }
	return { ok: true, text: await r.text() };
}

/** 从仓库页的 og 标签里取名称与描述（不占 API 额度）。 */
async function readOg(repo) {
	const got = await fetchText(`https://github.com/${repo}`);
	if (!got.ok) { return {}; }
	const meta = (prop) => {
		const re = new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i');
		const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${prop}["']`, 'i');
		return (re.exec(got.text)?.[1] ?? re2.exec(got.text)?.[1] ?? '').trim();
	};
	const title = meta('og:title');          // 形如 `owner/repo: description`
	const desc = meta('og:description');
	let name = '';
	if (title) {
		// og:title 最常见是 `owner/repo: 描述`，取冒号前；没有冒号就用整串
		name = title.split(':')[0].trim();
		// 若形如 owner/repo，取 repo 部分作为名称
		const slash = name.lastIndexOf('/');
		if (slash >= 0) { name = name.slice(slash + 1); }
	}
	return { name: decodeEntities(name), description: decodeEntities(desc) };
}

function decodeEntities(s) {
	return String(s ?? '')
		.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
		.trim();
}

/** 读 `HEAD` 上的某个文件（不占 API 额度）。 */
async function readRaw(repo, file) {
	const got = await fetchText(`https://raw.githubusercontent.com/${repo}/HEAD/${file}`);
	return got.ok ? got.text : null;
}

/**
 * 检测**运行前的外部依赖**（★ 2026-10-26，文档 §10 最后一条）。
 *
 * ## 为什么需要
 * 商城只表达"装什么"，表达不了"装完之后还要装什么"。
 * 典型例子：`Tencent/BrowserSkill` 的 dsh 插件只提供 `bsk_*` 工具，
 * 真正跑浏览器动作还依赖 **`bsk` CLI + 浏览器扩展**（都不在 npm 包里）
 * ⇒ 用户装完插件以为能用了，一调工具就报"命令不存在"。
 *
 * ## 检测什么（只认**明确信号**，不猜）
 * ① 仓库根有 `install.sh` / `install.ps1` / `setup.sh` ⇒ 几乎一定需要跑安装脚本
 * ② README 里有 `curl … install.sh | sh` 这类**一行式安装命令** ⇒ 抄原文
 * ③ README 里有 `npm i -g X` / `pip install X` / `cargo install X` / `brew install X` ⇒ 抄原文
 *
 * ⚠ 全都拿不到 ⇒ 返回 `null`（**不编造**"可能需要 Node"这种废话）。
 * ⚠ 全部走 `raw.githubusercontent.com`，**不占 GitHub API 额度**。
 *
 * @param {string} repo `owner/repo`
 * @returns {Promise<null | { files: string[], installHint: string, note: string }>}
 */
export async function detectExternalDeps(repo) {
	const candidates = ['install.sh', 'install.ps1', 'setup.sh'];
	const files = [];
	for (const f of candidates) {
		// 只探到第一个就够（再多请求收益递减）
		const t = await readRaw(repo, f);
		if (t) { files.push(f); break; }
	}

	let installHint = '';
	for (const readme of ['README.md', 'README.zh-CN.md']) {
		const text = await readRaw(repo, readme);
		if (!text) { continue; }
		// ① 一行式安装（BrowserSkill 就是 `curl -fsSL …/install.sh | sh`）
		const oneLiner = /(?:curl|wget)[^\n\r]{0,220}install\.(?:sh|ps1)[^\n\r]{0,60}/i.exec(text);
		if (oneLiner) { installHint = oneLiner[0].trim().slice(0, 200); break; }
		// ② 包管理器安装
		const pkg = /(?:npm\s+i(?:nstall)?\s+(?:-g|--global)|pip3?\s+install|cargo\s+install|brew\s+install)\s+[^\s`'\n]{1,80}/i.exec(text);
		if (pkg) { installHint = pkg[0].trim().slice(0, 200); break; }
	}

	if (!files.length && !installHint) { return null; }

	const parts = [];
	if (files.length) { parts.push(`仓库提供安装脚本（${files.join('、')}）`); }
	if (installHint) { parts.push(`安装命令：${installHint}`); }

	// ⚠ **只有"仓库自带安装脚本"才写进商品介绍**（强信号）。
	//   只匹配到 `pip install x` / `npm i -g y` 时**不写** —— 那常是 README 里
	//   **某一个用法示例**，不代表整个仓库的前置依赖。
	//   实测：`modelcontextprotocol/servers` 的 README 里有 `pip install mcp-server-git`
	//   （只是它收录的其中一个 server 的装法）⇒ 写进介绍就是**误导** ✗
	//   ⇒ `installHint` 仍然返回（供 Agent 参考），但 `note` 留空 ⇒ 调用方不追加。
	const note = files.length ? parts.join('；') : '';
	return { files, installHint, note };
}

/** 从 Releases 的 302 Location 里取 tag（不占 API 额度）。 */
async function readReleaseTag(repo) {
	try {
		const r = await fetch(`https://github.com/${repo}/releases/latest`, {
			redirect: 'manual',
			headers: { 'user-agent': UA },
			signal: AbortSignal.timeout(TIMEOUT),
		});
		const loc = r.headers.get('location') ?? '';
		const tag = /\/releases\/tag\/([^/?#]+)/.exec(loc)?.[1] ?? '';
		// 剥前缀要**宽松**：真实 tag 有 `v1.2.3` / `cli-v0.3.3` / `release-1.0.0` / `@scope/pkg@1.2.3`
		// （只剥 `v` 会得到 `cli-v0.3.3`，那不是合法版本 ✗ —— 真机踩到）
		return tag ? decodeURIComponent(tag).replace(/^[A-Za-z@._/-]*(?=\d)/, '').trim() : '';
	} catch {
		return '';
	}
}

/**
 * 核心：识别一个 GitHub 仓库的可发布信息。
 *
 * @param {string} input 用户粘的链接或 `owner/repo`
 * @returns {Promise<{ ok: boolean, error?: string, repo?: string, slug?: string,
 *   name?: string, description?: string, version?: string, logo?: string,
 *   kind?: 'skill'|'plugin'|null, hasSkillMd?: boolean, hasPackageJson?: boolean,
 *   versionFrom?: string, notes?: string[] }>}
 */
export async function inspectGithubRepo(input) {
	const repo = normalizeRepo(input);
	if (!repo) {
		return { ok: false, error: '请给 GitHub 仓库地址（owner/repo 或 https://github.com/owner/repo）' };
	}
	const [owner] = repo.split('/');
	const notes = [];

	// ① og 标签（名称/描述）—— 一次 HTML 请求
	let og = {};
	try { og = await readOg(repo); } catch { notes.push('仓库页抓取失败（可能是私有库或网络）'); }

	// ② package.json / SKILL.md —— 判断形态 + 取版本
	const pkgJsonText = await readRaw(repo, 'package.json');
	let pkgVersion = '';
	let pkgPrivate = false;
	let rootHasDsh = false;
	let hasWorkspaces = false;
	if (pkgJsonText) {
		try {
			const j = JSON.parse(pkgJsonText);
			if (typeof j.version === 'string') { pkgVersion = j.version.trim(); }
			// ⚠ `private: true` 是 pnpm 拒绝安装的直接原因（文档 §7 ②）⇒ 必须记下来
			pkgPrivate = j.private === true;
			rootHasDsh = Boolean(j.dsh);
			hasWorkspaces = Array.isArray(j.workspaces) || Boolean(j.workspaces && j.workspaces.packages);
		} catch { notes.push('根目录 package.json 不是合法 JSON'); }
	}
	// monorepo 的第二种标志（raw 文件，不占 API 额度）
	if (!hasWorkspaces) {
		const ws = await readRaw(repo, 'pnpm-workspace.yaml');
		if (ws) { hasWorkspaces = true; }
	}
	const skillMd = await readRaw(repo, 'SKILL.md');
	const hasSkillMd = Boolean(skillMd);

	// ③ 版本兜底：SKILL.md 的 frontmatter → Releases tag
	let version = pkgVersion;
	let versionFrom = pkgVersion ? 'package.json' : '';
	if (!version && skillMd) {
		const fm = /^---\s*\n([\s\S]*?)\n---/.exec(skillMd)?.[1] ?? '';
		const m = /^\s*version\s*:\s*(.+)$/m.exec(fm);
		if (m) { version = m[1].trim().replace(/^['"]|['"]$/g, ''); versionFrom = 'SKILL.md frontmatter'; }
	}
	if (!version) {
		const tag = await readReleaseTag(repo);
		if (tag) { version = tag; versionFrom = 'Releases 最新 tag'; }
	}
	if (!version) { version = '1.0.0'; versionFrom = '默认值（没读到版本，可手改）'; notes.push('没读到版本号，先填了 1.0.0'); }

	// ④ logo：owner 头像（真实、不占额度）
	const logo = `https://github.com/${owner}.png?size=200`;

	// ⑤ 外部依赖（跑起来还要装什么）—— 只认明确信号，拿不到就 null
	let externalDeps = null;
	try { externalDeps = await detectExternalDeps(repo); } catch { notes.push('外部依赖检测失败（可忽略）'); }
	// note 为空表示"只匹配到弱信号"，不值得写进 notes（见 detectExternalDeps 的说明）
	if (externalDeps && externalDeps.note) { notes.push(`运行前依赖：${externalDeps.note}`); }

	// ⑥ npm 反查：找「repository 指向该仓库」且自己带 `dsh` 字段的包
	//   ⚠ 不占 GitHub API 额度（未认证 60/h 早就撞过）
	let npmCandidates = [];
	try { npmCandidates = await findNpmPackagesForRepo(repo); } catch { notes.push('npm 反查失败（可忽略）'); }
	const dshPkgs = npmCandidates.filter(c => c.hasDsh);
	// ★ 给每个 dsh 候选算一次「与当前宿主的 peer 兼容性」（只提示，不阻断发布）
	for (const c of dshPkgs) {
		try { c.peerCompat = checkPeerCompat(c.peerDependencies); } catch { /* 算不出来就不给 */ }
	}

	// ⑥ **该用哪种发布源**（文档 §7 的核心结论：monorepo 只能发 npm 子包）
	let recommendedDistribution = null;
	let recommendWhy = '';
	if (rootHasDsh && !pkgPrivate) {
		recommendedDistribution = { type: 'github-source', name: repo };
		recommendWhy = '仓库根就是 dsh 插件（有 dsh 字段、非 private）⇒ github-source 即可';
	} else if (dshPkgs.length) {
		const best = dshPkgs[0];
		const range = peerRangeOf(best.peerDependencies);
		recommendedDistribution = { type: 'npm', name: best.name, ...(range ? { peerRange: range } : {}) };
		recommendWhy = `根不可直接安装（monorepo 或 private）；子包已发 npm：${best.name}@${best.version}`;
		// ★ peer 兼容性（只提示）：不匹配就写进 notes，**不阻断**发布
		const pc = best.peerCompat;
		if (pc && Array.isArray(pc.warnings) && pc.warnings.length) {
			for (const w of pc.warnings) { notes.push(`peer 兼容性：${w}`); }
		}
	} else if (pkgPrivate) {
		recommendWhy = '根 package.json 是 private:true ⇒ pnpm 会拒绝；需先让作者发布到 npm';
	} else if (hasWorkspaces) {
		recommendWhy = '这是 monorepo，根目录不是插件，npm 上也没找到对应子包 ⇒ 当前无法安装';
	} else {
		recommendWhy = '根目录没有 dsh 字段、npm 也没找到子包 ⇒ 可能不是 dsh 插件';
	}
	if (pkgPrivate) { notes.push('根 package.json 是 private:true（pnpm 会拒绝直接装这个仓库）'); }
	if (hasWorkspaces) { notes.push('仓库是 monorepo ⇒ 只能发布其中的 npm 子包'); }

	// ⑦ kind：有 SKILL.md ⇒ skill；根或子包是 dsh 插件 ⇒ plugin；否则 null（让调用方选）
	let kind = null;
	if (hasSkillMd) { kind = 'skill'; }
	else if (rootHasDsh || dshPkgs.length) { kind = 'plugin'; }

	// ⑧ slug：优先跟**推荐发布源**走（文档 §6 的 A1 就是 npm 名派生的 slug）
	const slugFromRepo = slugOfRepo(repo);
	const slugFromNpm = recommendedDistribution && recommendedDistribution.type === 'npm'
		? slugOfRepo(String(recommendedDistribution.name).replace(/^@/, '').replace(/\//g, '-'))
		: slugFromRepo;

	const name = (og.name || repo.split('/')[1] || repo).slice(0, 128);
	const description = (og.description || '').slice(0, 1500);

	return {
		ok: true,
		repo,
		slug: slugFromNpm,
		// 两种 slug 都给（npm 派生与仓库派生不同，调用方可能要对照）
		slugFromRepo,
		// ★ 该用哪种发布源 + 为什么（不让调用方去猜）
		recommendedDistribution,
		recommendWhy,
		// npm 上「repository 指向本仓库」的包（含是否带 dsh 字段）
		npmCandidates,
		// 运行前还要装什么（null = 没检测到明确信号）
		externalDeps,
		rootHasDsh,
		rootPrivate: pkgPrivate,
		hasWorkspaces,
		name,
		description,
		version,
		versionFrom,
		logo,
		kind,
		hasSkillMd,
		hasPackageJson: Boolean(pkgJsonText),
		source: `https://github.com/${repo}`,
		notes,
	};
}
