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
	let isDshPlugin = false;
	if (pkgJsonText) {
		try {
			const j = JSON.parse(pkgJsonText);
			if (typeof j.version === 'string') { pkgVersion = j.version.trim(); }
			isDshPlugin = Boolean(j.dsh) || /^@vssaros\//.test(String(j.name ?? ''));
		} catch { notes.push('根目录 package.json 不是合法 JSON'); }
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

	// ⑤ kind：有 SKILL.md ⇒ skill；是 dsh 插件 ⇒ plugin；否则 null（让用户选）
	let kind = null;
	if (hasSkillMd) { kind = 'skill'; }
	else if (isDshPlugin) { kind = 'plugin'; }

	const name = (og.name || repo.split('/')[1] || repo).slice(0, 128);
	const description = (og.description || '').slice(0, 1500);

	return {
		ok: true,
		repo,
		slug: slugOfRepo(repo),
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
