#!/usr/bin/env node
/*
 * create-release.cjs - Create git tag + GitLab (git.woa.com) release + GitHub release
 * for a packaged VsSaros build, with changelog and exe assets.
 *
 * No external npm deps. All HTTP goes through curl.exe subprocess (system cert
 * store via schannel - avoids Node CA issues with intranet git.woa.com).
 *
 * Usage:
 *   node build/saros/create-release.cjs [--version <X.Y.Z>] [--dry-run]
 *   --version  default: product.json "version" field; release tag = "v<version>"
 *   --dry-run  print planned actions only; no tag/push/upload/API writes
 *
 * Env:
 *   WOA_GITLAB_TOKEN  token for git.woa.com (fallback: `git credential fill`)
 *   GITHUB_TOKEN      GitHub PAT (repo scope). GitHub steps are SKIPPED (warn only)
 *                     when missing or api.github.com is unreachable (intranet runners).
 *
 * Failure policy:
 *   - GitLab (woa.git) failure -> exit 1 (primary internal release channel)
 *   - GitHub failure -> warn only (external mirror, intranet may block it)
 */
'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GITLAB_API = 'https://git.woa.com/api/v3';
const GITLAB_WEB = 'https://git.woa.com';
const GITLAB_PROJECT = '1790708'; // zijianqiu/vssarosis_issue（EXE 托管 + 完整 Release）
const GITLAB_PROJECT_PATH = 'zijianqiu/vssarosis_issue';
const GITLAB_MAIN_PROJECT = '1764429'; // zijianqiu/sarosis-agents-client（镜像 Release：changelog + EXE 下载直链，不重复托管 EXE）
const GITLAB_MAIN_PROJECT_PATH = 'zijianqiu/sarosis-agents-client';
const GITHUB_API = 'https://api.github.com';
const GITHUB_UPLOADS = 'https://uploads.github.com';
const GITHUB_REPO = 'qiuzijian7/sarosis-agents-client';

const EXE_FILES = [
	{ kind: '用户级安装', rel: '.build/win32-x64/user-setup/VsSarosUserSetup.exe' },
	{ kind: '系统级安装', rel: '.build/win32-x64/system-setup/VsSarosSetup.exe' },
];

function log(msg) { console.log(`[release] ${msg}`); }
function warn(msg) { console.warn(`[release][WARN] ${msg}`); }

function parseArgs(argv) {
	const args = { version: null, dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--version') { args.version = argv[++i]; }
		else if (argv[i] === '--dry-run') { args.dryRun = true; }
	}
	return args;
}

function git(gitArgs, opts = {}) {
	return execFileSync('git', ['-C', REPO_ROOT, ...gitArgs], {
		encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, ...opts,
	});
}

/**
 * HTTP via curl.exe. Returns { status, data }.
 * Exactly one of json / formFile / uploadFile may be set.
 */
function curl(method, url, { headers = {}, json, formFile, uploadFile, timeoutSec = 600, fallbackBearer = false } = {}) {
	/** 构造 curl 参数（★ 把"参数拼装"抽出来，重试时才能用**不同的头**重建一份）。 */
	const buildArgs = (hdrs) => {
		const a = ['-sS', '-X', method,
			'--connect-timeout', '30', '--max-time', String(timeoutSec),
			'-H', 'Expect:', '-w', '\n%{http_code}'];
		for (const [k, v] of Object.entries(hdrs)) { a.push('-H', `${k}: ${v}`); }
		if (json !== undefined) {
			// ★★ 2026-10-21 **关键修复**：请求体必须真的送到 API。
			//   旧写法 `--data-binary @C:\Users\...\file.json`（**反斜杠**）⇒ Windows 上的 curl.exe
			//   **读不到这个文件** ⇒ 发出去的是**空 body** ⇒ 工蜂按"没给内容"处理：
			//   · `PUT /releases/<tag>` 照样 200，但**建出残桩**（描述 = tag message、无资产）；
			//   · `POST /releases` 400「for ''tag'' not given」。
			//   而这两处失败都只 warn/被兜底 ⇒ **一个月里每次"发布"都是残桩，流水线还报 success**
			//   （2026-09-21 起连续验证：v2.2.26045 / v2.2.26062 的描述都只有一行、无任何下载链接）。
			//   修法：路径**统一转成前斜杠**（实测这样 body 就能送达 ⇒ desc_len 从 0 变 316 ✓）。
			const bodyPath = tmpFile.replace(/\\/g, '/');
			a.push('-H', 'Content-Type: application/json; charset=utf-8', '--data-binary', `@${bodyPath}`);
		} else if (formFile) {
			// ★ 2026-10-21：**同一个反斜杠坑**（EXE 上传走的就是这条）——`-F file=@C:\...`
			//   在 Windows 上 curl.exe 读不到文件 ⇒ 上传体是空的 ⇒ GitLab 收不到 EXE ⇒
			//   一个月里"发布"从头到尾**没有任何可下载的安装包**。同样转前斜杠 ✓。
			const formPath = String(formFile.path).replace(/\\/g, '/');
			a.push('-F', `file=@${formPath};type=application/octet-stream;filename=${formFile.name}`);
		} else if (uploadFile) {
			a.push('-H', 'Content-Type: application/octet-stream', '--upload-file', uploadFile);
		}
		a.push(url);
		return a;
	};

	let tmpFile = null;
	if (json !== undefined) {
		tmpFile = path.join(os.tmpdir(), `saros-release-${process.pid}-${Date.now()}.json`);
		fs.writeFileSync(tmpFile, JSON.stringify(json), 'utf8');
	}

	const run = (args) => {
		const out = execFileSync('curl.exe', args, {
			encoding: 'utf8', timeout: (timeoutSec + 60) * 1000, maxBuffer: 32 * 1024 * 1024,
		});
		const idx = out.lastIndexOf('\n');
		const status = Number(out.slice(idx + 1).trim()) || 0;
		const body = out.slice(0, idx);
		let data;
		try { data = JSON.parse(body); } catch { data = body; }
		return { status, data };
	};

	try {
		const first = run(buildArgs(headers));
		// ★ 2026-10-21：工蜂的令牌有两种形态 —— 私人令牌走 `PRIVATE-TOKEN`，OAuth/Bearer 令牌走
		//   `Authorization: Bearer`（同一个令牌用错头就是 401）。CI 的 WOA_GITLAB_TOKEN 是前者，
		//   而 `git credential fill` 拿到的可能是后者 ⇒ **401 时换头重试一次**（否则本地永远跑不通）。
		if (first.status === 401 && fallbackBearer) {
			const token = headers['PRIVATE-TOKEN'];
			if (token) {
				const retryHeaders = { ...headers };
				delete retryHeaders['PRIVATE-TOKEN'];
				retryHeaders['Authorization'] = `Bearer ${token}`;
				const second = run(buildArgs(retryHeaders));
				return second.status === 401 ? first : { ...second, retriedWithBearer: true };
			}
		}
		return first;
	} finally {
		if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } }
	}
}

/**
 * 发布/更新一个 release（★ 2026-10-21 重写）。
 *
 * 三个坑（都实测过）：
 *  ① **先看存不存在**（`GET /releases/<tag>` 按 tag 查是支持的）——
 *     盲 `PUT /releases/<tag>` 在工蜂上会**创建**一个残桩（描述 = tag message、无资产）且返回 200 ✗。
 *  ② 更新时**先按 tag PUT**（工蜂：按 id PUT 会 404「Release(x) not found」），
 *     404/405 时再**按 id PUT**（官方 GitLab 语义：`:release_id` 必须是数字 id）。
 *  ③ **新建**用 `POST` 且 body 里**同时带 `tag` 与 `tag_name`**
 *     （工蜂认 `tag`；只带官方的 `tag_name` ⇒ 400「for ''tag'' not given」）。
 * 最后必须**回读校验**（verifyRelease）——残桩发布过一个月没人发现，就是因为没人回读。
 */
function upsertGitlabRelease(projectId, tag, name, desc, headers) {
	const existing = releaseIdOf(projectId, tag, headers);
	if (existing) {
		let r = curl('PUT', `${GITLAB_API}/projects/${projectId}/releases/${encodeURIComponent(tag)}`,
			{ headers, fallbackBearer: true, json: { name, description: desc } });
		if (r.status === 404 || r.status === 405) {
			r = curl('PUT', `${GITLAB_API}/projects/${projectId}/releases/${existing}`,
				{ headers, fallbackBearer: true, json: { name, description: desc } });
		}
		return r;
	}
	return curl('POST', `${GITLAB_API}/projects/${projectId}/releases`,
		{ headers, fallbackBearer: true, json: { tag, tag_name: tag, name, description: desc } });
}

function brief(data) {
	return (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 200);
}

/**
 * 按 **tag** 查 release 的数字 id（★ 2026-10-21）。
 *
 * 为什么要它：GitLab 的 `PUT/POST .../releases/:release_id` 只认**数字 id**，
 * 而 `GET .../releases/:tag_name` **可以按 tag 查**（返回体带 `id`）⇒
 * 「先按 tag 拿 id、再按 id 改」是唯一能改到已有 release 的路。
 * 旧实现直接把 tag 当 id 用 ⇒ 永远 404 ⇒ 建出残桩且流水线照样绿。
 */
function releaseIdOf(projectId, tag, headers) {
	const r = curl('GET', `${GITLAB_API}/projects/${projectId}/releases/${encodeURIComponent(tag)}`, { headers, fallbackBearer: true });
	if (r.status === 200 && r.data && Number.isFinite(Number(r.data.id))) { return Number(r.data.id); }
	return null;
}

/**
 * 发布后**回读校验**（★ 2026-10-21）：残桩即失败。
 * 判据：描述长度达标（不是 tag message 那一行）+ 资产链接数达标。
 * 为什么要：残桩发布过去**一个多月没人发现**（流水线一直 success，用户拿不到包）——
 * 失败必须"响"，不能只在日志里 warn。
 */
function verifyRelease(projectId, tag, headers, { minDescLen = 200, minLinks = 0 } = {}) {
	const r = curl('GET', `${GITLAB_API}/projects/${projectId}/releases/${encodeURIComponent(tag)}`, { headers, fallbackBearer: true });
	if (r.status !== 200 || !r.data) {
		throw new Error(`release verification failed: GET release ${tag} -> ${r.status}: ${brief(r.data)}`);
	}
	const desc = String(r.data.description || '');
	const links = ((r.data.assets || {}).links) || [];
	if (desc.length < minDescLen) {
		throw new Error(`release verification failed: ${tag} 描述只有 ${desc.length} 字符（期望 ≥${minDescLen}）⇒ 残桩（多半是 tag message）`);
	}
	if (links.length < minLinks) {
		throw new Error(`release verification failed: ${tag} 资产链接 ${links.length} 条（期望 ≥${minLinks}）⇒ EXE 没挂上`);
	}
	log(`release verified: ${tag} desc=${desc.length} chars, links=${links.length}`);
}

// ---------- tokens ----------
function gitlabToken() {
	if (process.env.WOA_GITLAB_TOKEN && process.env.WOA_GITLAB_TOKEN.trim()) {
		return process.env.WOA_GITLAB_TOKEN.trim();
	}
	try {
		const out = execFileSync('git', ['credential', 'fill'], {
			input: `protocol=https\nhost=git.woa.com\npath=${GITLAB_PROJECT_PATH}.git\n`,
			encoding: 'utf8', timeout: 15000,
		});
		const m = /^password=(.+)$/m.exec(out);
		if (m) { return m[1].trim(); }
	} catch { /* fall through */ }
	return null;
}

// ---------- version / changelog ----------
function resolveVersion(args) {
	if (args.version) { return args.version.replace(/^v/, ''); }
	const product = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'product.json'), 'utf8'));
	if (!product.version) { throw new Error('product.json has no version'); }
	return product.version;
}

/** 上一个版本 tag（版本号降序里的**下一个**）；没有则 null。 */
function previousTagOf(tag) {
	try {
		const out = execFileSync('git', ['tag', '--sort=-v:refname'], { cwd: REPO_ROOT, encoding: 'utf8' })
			.trim().split('\n').map(s => s.trim()).filter(Boolean);
		const i = out.indexOf(tag);
		return (i >= 0 && i + 1 < out.length) ? out[i + 1] : null;
	} catch {
		return null;
	}
}

function buildChangelog(tag) {
	const outFile = path.join(REPO_ROOT, '.build', `release-notes-${tag}.md`);
	const base = [
		path.join(REPO_ROOT, 'build', 'saros', 'gen-changelog.cjs'),
		'--repo', REPO_ROOT, '--out', outFile,
	];
	// ★ 2026-10-21：changelog 的区间必须是「**上一个 tag → 这个 tag**」——
	//   新发布时 tag 还不存在 ⇒ 走默认（最新 tag..HEAD ✓，CI 的正常路径）；
	//   补发/重跑已有 tag 时 ⇒ 显式给 `--from 上一个tag --to 这个tag`，
	//   否则默认的 from=最新tag(=它自己) ⇒ 区间为空（0 条提交）✗。
	const prev = previousTagOf(tag);
	if (prev) {
		execFileSync(process.execPath, [...base, '--from', prev, '--to', tag], { stdio: 'inherit' });
	} else {
		execFileSync(process.execPath, base, { stdio: 'inherit' });
	}
	return fs.readFileSync(outFile, 'utf8');
}

function sha256Of(file) {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

// ---------- git tag on main repo (best effort) ----------
function ensureGitTag(tag, dryRun) {
	try { git(['fetch', '--tags', 'origin']); } catch { warn('git fetch --tags failed, continue'); }
	const remote = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]).trim();
	if (remote) { log(`tag ${tag} already on origin, skip push`); return; }
	if (!git(['tag', '-l', tag]).trim()) {
		if (dryRun) { log(`[dry-run] would create local tag ${tag}`); }
		else { git(['tag', '-a', tag, '-m', `VsSaros ${tag}`]); }
	}
	if (dryRun) { log(`[dry-run] would push tag ${tag} to origin`); return; }
	try {
		git(['push', 'origin', `refs/tags/${tag}`]);
		log(`pushed tag ${tag} to origin`);
	} catch (e) {
		// Non-blocking: GitLab tag is created via API, GitHub release auto-creates its tag.
		warn(`git push tag failed (non-blocking): ${String(e.message).split('\n')[0]}`);
	}
}

// ---------- GitLab (woa.git vssarosis_issue) ----------
async function gitlabCreateRelease(tag, changelog, dryRun) {
	const token = gitlabToken();
	if (!token) { throw new Error('no git.woa.com token (set WOA_GITLAB_TOKEN in BK-CI pipeline variables, or git credential)'); }
	// 工蜂私人令牌(PAT)必须用 PRIVATE-TOKEN 头；Authorization: Bearer 会 401
	const glHeaders = { 'PRIVATE-TOKEN': token };

	// 1. tag on vssarosis_issue via API (idempotent)
	if (dryRun) {
		log(`[dry-run] would ensure GitLab tag ${tag} on project ${GITLAB_PROJECT}`);
	} else {
		const r = curl('POST',
			`${GITLAB_API}/projects/${GITLAB_PROJECT}/repository/tags?tag_name=${encodeURIComponent(tag)}&ref=main&message=${encodeURIComponent(`VsSarosis ${tag}`)}`,
			{ headers: glHeaders, fallbackBearer: true });
		if (r.status === 201) { log(`GitLab tag ${tag} created`); }
		else if (r.status === 400 || r.status === 409) { log(`GitLab tag ${tag} already exists`); }
		else { warn(`GitLab create tag -> ${r.status}: ${brief(r.data)}`); }
	}

	// 2. upload exes to project uploads
	const downloads = [];
	for (const exe of EXE_FILES) {
		const abs = path.join(REPO_ROOT, exe.rel);
		if (!fs.existsSync(abs)) { warn(`exe missing, skipped: ${exe.rel}`); continue; }
		const sizeMB = (fs.statSync(abs).size / 1048576).toFixed(2);
		const name = path.basename(exe.rel);
		if (dryRun) { log(`[dry-run] would upload ${name} (${sizeMB} MiB) to GitLab uploads`); continue; }
		const r = curl('POST', `${GITLAB_API}/projects/${GITLAB_PROJECT}/uploads`,
			{ headers: glHeaders, fallbackBearer: true, formFile: { path: abs, name }, timeoutSec: 900 });
		if (r.status === 201 && r.data && r.data.url) {
			const full = String(r.data.url).startsWith('http') ? r.data.url : `${GITLAB_WEB}${r.data.url}`;
			downloads.push({ kind: exe.kind, name, url: full, sizeMB });
			log(`uploaded ${name} (${sizeMB} MiB)`);
		} else {
			warn(`upload ${name} -> ${r.status}: ${brief(r.data)}`);
		}
	}

	// 3. description
	const userExe = path.join(REPO_ROOT, EXE_FILES[0].rel);
	const sha = fs.existsSync(userExe) ? `SHA256 (${path.basename(userExe)}): ${sha256Of(userExe)}` : '';
	const dlRows = downloads.map((d) => `| Windows x64 | ${d.kind} | [${d.name}](${d.url}) (${d.sizeMB} MiB) |`).join('\n');
	const desc = [
		`## VsSarosis ${tag}`,
		'',
		`**发布日期**：${new Date().toISOString().slice(0, 10)}`,
		'',
		changelog.trim(),
		'',
		'### 下载',
		'| 平台 | 类型 | 下载 |',
		'|------|------|------|',
		dlRows || '| Windows x64 | - | 见下方 GitHub 镜像 |',
		'',
		`GitHub 镜像：[releases/tag/${tag}](https://github.com/${GITHUB_REPO}/releases/tag/${tag})`,
		'',
		'### 校验信息',
		'```',
		sha,
		'```',
	].join('\n');

	// 4. create or update release
	// ★ 2026-10-21 修（发布残桩的根因）：**`:release_id` 必须是数字 id，不是 tag** ——
	//   旧实现 `PUT /releases/<tag>` 永远 404 ⇒ 落到 POST 兜底 ⇒ 建出来的是**残桩**
	//   （description = tag message、无资产），而失败只 warn ⇒ **流水线照样报 success**。
	//   实测：2026-09-21 起的"发布"全是这种残桩（描述只有一行、没有任何下载链接 ⇒ 用户下载不到包）。
	//   修法：先用 `GET /releases/<tag>`（**按 tag 查是支持的**）拿到数字 id，再按 id PUT/挂链接；
	//   最后**回读校验**（描述非空 + 资产链接数达标）⇒ 残桩即抛错（流水线红，别再假装发布成功）。
	if (dryRun) { log(`[dry-run] would PUT/POST GitLab release ${tag} (desc ${desc.length} chars)`); return []; }
	const r = upsertGitlabRelease(GITLAB_PROJECT, tag, `VsSaros ${tag}`, desc, glHeaders);
	if (r.status >= 200 && r.status < 300) {
		log(`GitLab release: ${GITLAB_WEB}/${GITLAB_PROJECT_PATH}/-/releases/${tag}`);
	} else {
		throw new Error(`GitLab release failed -> ${r.status}: ${brief(r.data)}`);
	}
	// 回读校验：残桩（描述没落上 / 资产没挂上）必须失败，不能"发布成功但用户下载不到"
	verifyRelease(GITLAB_PROJECT, tag, glHeaders, { minDescLen: 200, minLinks: downloads.length });
	return downloads;
}

// ---------- GitLab main repo (sarosis-agents-client, mirror release) ----------
// 主仓库镜像 Release：changelog + EXE 下载直链（release asset links），不重复托管 EXE 本体
// （EXE 仍在 vssarosis_issue uploads，避免主仓库撞 100MB 限制与体积膨胀）。
async function gitlabCreateMainRepoRelease(tag, changelog, downloads, dryRun) {
	const token = gitlabToken();
	if (!token) { throw new Error('no git.woa.com token (set WOA_GITLAB_TOKEN in BK-CI pipeline variables, or git credential)'); }
	const glHeaders = { 'PRIVATE-TOKEN': token };

	// 1. ensure tag via API（git push 失败时的兜底；已存在则 400/409 忽略）
	if (dryRun) {
		log(`[dry-run] would ensure main-repo tag ${tag}`);
	} else {
		const r = curl('POST',
			`${GITLAB_API}/projects/${GITLAB_MAIN_PROJECT}/repository/tags?tag_name=${encodeURIComponent(tag)}&ref=main&message=${encodeURIComponent(`VsSaros ${tag}`)}`,
			{ headers: glHeaders, fallbackBearer: true });
		if (r.status === 201) { log(`main-repo tag ${tag} created via API`); }
		else if (r.status === 400 || r.status === 409) { log(`main-repo tag ${tag} already exists`); }
		else { warn(`main-repo create tag -> ${r.status}: ${brief(r.data)}`); }
	}

	// 2. description（changelog + 下载表；直链与下方 asset links 一致）
	const dlRows = downloads.map((d) => `| Windows x64 | ${d.kind} | [${d.name}](${d.url}) (${d.sizeMB} MiB) |`).join('\n');
	const issueRel = `${GITLAB_WEB}/${GITLAB_PROJECT_PATH}/-/releases/${tag}`;
	const desc = [
		`## VsSaros ${tag}`,
		'',
		`**发布日期**：${new Date().toISOString().slice(0, 10)}`,
		'',
		changelog.trim(),
		'',
		'### 下载',
		'| 平台 | 类型 | 下载 |',
		'|------|------|------|',
		dlRows || `| Windows x64 | - | 见 [发布仓库 Release](${issueRel}) |`,
		'',
		`> 安装包托管于 [vssarosis_issue Releases](${issueRel})（避免主仓库膨胀）；本 Release 资产区附同名直链。`,
	].join('\n');

	// 3. create or update release（★ 2026-10-21：按**数字 id** 改，见 releaseIdOf 的注释）
	if (dryRun) { log(`[dry-run] would PUT/POST main-repo release ${tag} (desc ${desc.length} chars, ${downloads.length} asset links)`); return; }
	const r = upsertGitlabRelease(GITLAB_MAIN_PROJECT, tag, `VsSaros ${tag}`, desc, glHeaders);
	if (!(r.status >= 200 && r.status < 300)) {
		throw new Error(`main-repo release failed -> ${r.status}: ${brief(r.data)}`);
	}
	log(`main-repo release: ${GITLAB_WEB}/${GITLAB_MAIN_PROJECT_PATH}/-/releases/${tag}`);

	// 4. attach EXE 直链 as release asset links（幂等：先查重）
	//    ★ 2026-10-21：asset links 的 `:release_id` 同样只认**数字 id**（旧代码用 tag ⇒ 永远 404
	//    ⇒ EXE 直链从来没挂上 ⇒ 用户点开 Release 找不到包）。
	const mainReleaseId = releaseIdOf(GITLAB_MAIN_PROJECT, tag, glHeaders);
	if (!mainReleaseId) { throw new Error(`main-repo release id not found for ${tag} (cannot attach asset links)`); }
	const existing = curl('GET', `${GITLAB_API}/projects/${GITLAB_MAIN_PROJECT}/releases/${mainReleaseId}/assets/links`,
		{ headers: glHeaders, fallbackBearer: true });
	const existingNames = new Set(
		existing.status === 200 && Array.isArray(existing.data) ? existing.data.map((l) => l.name) : []);
	for (const d of downloads) {
		if (existingNames.has(d.name)) { log(`asset link exists: ${d.name}`); continue; }
		// ★ 2026-10-21：工蜂的 assets/links 端点**按 tag 也能用**（按 id 在工蜂上 404）⇒
		//   先试 id，404/405 再试 tag（两边都试，缺哪边补哪边）。
		let lr = curl('POST', `${GITLAB_API}/projects/${GITLAB_MAIN_PROJECT}/releases/${mainReleaseId}/assets/links`,
			{ headers: glHeaders, fallbackBearer: true, json: { name: d.name, url: d.url, link_type: 'other' } });
		if (lr.status === 404 || lr.status === 405) {
			lr = curl('POST', `${GITLAB_API}/projects/${GITLAB_MAIN_PROJECT}/releases/${encodeURIComponent(tag)}/assets/links`,
				{ headers: glHeaders, fallbackBearer: true, json: { name: d.name, url: d.url, link_type: 'other' } });
		}
		if (lr.status === 201) { log(`asset link added: ${d.name}`); }
		else { warn(`asset link ${d.name} -> ${lr.status}: ${brief(lr.data)}`); }
	}
	// 回读校验（★ 2026-10-21）：描述与直链都必须真的落上，否则这次"发布"等于没发。
	verifyRelease(GITLAB_MAIN_PROJECT, tag, glHeaders, { minDescLen: 200, minLinks: downloads.length });
}

// ---------- GitHub (mirror) ----------
async function githubCreateRelease(tag, changelog, dryRun) {
	const token = (process.env.GITHUB_TOKEN || '').trim();
	if (!token) { warn('GITHUB_TOKEN not set, skip GitHub release'); return; }

	const ghHeaders = {
		'Accept': 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28',
		'Authorization': `Bearer ${token}`,
	};

	// connectivity probe (intranet runners may not reach github.com)
	const probe = curl('GET', `${GITHUB_API}/rate_limit`, { headers: ghHeaders, timeoutSec: 15 });
	if (probe.status !== 200) {
		warn(`api.github.com unreachable (HTTP ${probe.status}), skip GitHub release`);
		return;
	}

	// create or update release (tag auto-created from target commit when missing)
	let releaseId = null;
	if (dryRun) {
		log(`[dry-run] would create/update GitHub release ${tag} on ${GITHUB_REPO}`);
	} else {
		let r = curl('POST', `${GITHUB_API}/repos/${GITHUB_REPO}/releases`, {
			headers: ghHeaders,
			json: { tag_name: tag, target_commitish: 'main', name: `VsSaros ${tag}`, body: changelog },
		});
		if (r.status === 201) {
			releaseId = r.data.id;
		} else {
			const g = curl('GET', `${GITHUB_API}/repos/${GITHUB_REPO}/releases/tags/${encodeURIComponent(tag)}`,
				{ headers: ghHeaders });
			if (g.status === 200) {
				releaseId = g.data.id;
				curl('PATCH', `${GITHUB_API}/repos/${GITHUB_REPO}/releases/${releaseId}`,
					{ headers: ghHeaders,json: { name: `VsSaros ${tag}`, body: changelog } });
			} else {
				warn(`GitHub create release -> ${r.status}: ${brief(r.data)}`);
				return;
			}
		}
		log(`GitHub release id=${releaseId}`);
	}

	// upload assets (idempotent: delete same-name asset first)
	for (const exe of EXE_FILES) {
		const abs = path.join(REPO_ROOT, exe.rel);
		if (!fs.existsSync(abs)) { continue; }
		const name = path.basename(exe.rel);
		if (dryRun) { log(`[dry-run] would upload asset ${name} to GitHub release ${tag}`); continue; }
		const assets = curl('GET', `${GITHUB_API}/repos/${GITHUB_REPO}/releases/${releaseId}/assets`,
			{ headers: ghHeaders });
		if (assets.status === 200 && Array.isArray(assets.data)) {
			const dup = assets.data.find((a) => a.name === name);
			if (dup) {
				curl('DELETE', `${GITHUB_API}/repos/${GITHUB_REPO}/releases/assets/${dup.id}`,
					{ headers: ghHeaders });
			}
		}
		const up = curl('POST',
			`${GITHUB_UPLOADS}/repos/${GITHUB_REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
			{ headers: ghHeaders,uploadFile: abs, timeoutSec: 1800 });
		if (up.status === 201) { log(`GitHub asset uploaded: ${name}`); }
		else { warn(`GitHub asset ${name} -> ${up.status}: ${brief(up.data)}`); }
	}
	if (!dryRun && releaseId) {
		log(`GitHub release: https://github.com/${GITHUB_REPO}/releases/tag/${tag}`);
	}
}

// ---------- main ----------
(async () => {
	const args = parseArgs(process.argv.slice(2));
	const version = resolveVersion(args);
	const tag = `v${version}`;
	log(`version=${version} tag=${tag}${args.dryRun ? ' (dry-run)' : ''}`);

	// ★ 2026-10-21：changelog 的区间依赖**历史 tag** ⇒ 先把 tag 拉下来再生成
	//   （CI 的 checkout 常常是浅克隆 ⇒ 本地 tag 列表是空的 ⇒ 区间会退化成"最近 50 条"，
	//   或把这个 tag 之后的提交也算进去 ✗）。拉不到也继续（退化路径不致命）。
	try {
		git(['fetch', '--tags', 'origin']);
	} catch { warn('git fetch --tags failed, changelog range may be inaccurate'); }
	const changelog = buildChangelog(tag);
	ensureGitTag(tag, args.dryRun);

	try {
		const downloads = await gitlabCreateRelease(tag, changelog, args.dryRun);
		await gitlabCreateMainRepoRelease(tag, changelog, downloads || [], args.dryRun);
	} catch (e) {
		console.error(`[release][ERROR] GitLab: ${e.message}`);
		process.exitCode = 1;
	}
	try {
		await githubCreateRelease(tag, changelog, args.dryRun);
	} catch (e) {
		warn(`GitHub: ${e.message}`);
	}
	log('done');
})().catch((e) => { console.error(e); process.exit(1); });
