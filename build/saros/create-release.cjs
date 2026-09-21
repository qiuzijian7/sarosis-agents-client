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
function curl(method, url, { headers = {}, json, formFile, uploadFile, timeoutSec = 600 } = {}) {
	const a = ['-sS', '-X', method,
		'--connect-timeout', '30', '--max-time', String(timeoutSec),
		'-H', 'Expect:', '-w', '\n%{http_code}'];
	for (const [k, v] of Object.entries(headers)) { a.push('-H', `${k}: ${v}`); }

	let tmpFile = null;
	if (json !== undefined) {
		tmpFile = path.join(os.tmpdir(), `saros-release-${process.pid}-${Date.now()}.json`);
		fs.writeFileSync(tmpFile, JSON.stringify(json), 'utf8');
		a.push('-H', 'Content-Type: application/json; charset=utf-8', '--data-binary', `@${tmpFile}`);
	} else if (formFile) {
		a.push('-F', `file=@${formFile.path};type=application/octet-stream;filename=${formFile.name}`);
	} else if (uploadFile) {
		a.push('-H', 'Content-Type: application/octet-stream', '--upload-file', uploadFile);
	}
	a.push(url);

	try {
		const out = execFileSync('curl.exe', a, {
			encoding: 'utf8', timeout: (timeoutSec + 60) * 1000, maxBuffer: 32 * 1024 * 1024,
		});
		const idx = out.lastIndexOf('\n');
		const status = Number(out.slice(idx + 1).trim()) || 0;
		const body = out.slice(0, idx);
		let data;
		try { data = JSON.parse(body); } catch { data = body; }
		return { status, data };
	} finally {
		if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch { /* ignore */ } }
	}
}

function brief(data) {
	return (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 200);
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

function buildChangelog(tag) {
	const outFile = path.join(REPO_ROOT, '.build', `release-notes-${tag}.md`);
	execFileSync(process.execPath, [
		path.join(REPO_ROOT, 'build', 'saros', 'gen-changelog.cjs'),
		'--repo', REPO_ROOT, '--out', outFile,
	], { stdio: 'inherit' });
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
			{ headers: glHeaders });
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
			{ headers: glHeaders, formFile: { path: abs, name }, timeoutSec: 900 });
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
	if (dryRun) { log(`[dry-run] would PUT/POST GitLab release ${tag} (desc ${desc.length} chars)`); return []; }
	let r = curl('PUT', `${GITLAB_API}/projects/${GITLAB_PROJECT}/releases/${encodeURIComponent(tag)}`,
		{ headers: glHeaders, json: { name: `VsSarosis ${tag}`, description: desc } });
	if (r.status === 404 || r.status === 405) {
		r = curl('POST', `${GITLAB_API}/projects/${GITLAB_PROJECT}/releases`,
			{ headers: glHeaders, json: { tag_name: tag, name: `VsSarosis ${tag}`, description: desc } });
	}
	if (r.status >= 200 && r.status < 300) {
		log(`GitLab release: ${GITLAB_WEB}/${GITLAB_PROJECT_PATH}/-/releases/${tag}`);
	} else {
		throw new Error(`GitLab release failed -> ${r.status}: ${brief(r.data)}`);
	}
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
			{ headers: glHeaders });
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

	// 3. create or update release
	if (dryRun) { log(`[dry-run] would PUT/POST main-repo release ${tag} (desc ${desc.length} chars, ${downloads.length} asset links)`); return; }
	let r = curl('PUT', `${GITLAB_API}/projects/${GITLAB_MAIN_PROJECT}/releases/${encodeURIComponent(tag)}`,
		{ headers: glHeaders, json: { name: `VsSaros ${tag}`, description: desc } });
	if (r.status === 404 || r.status === 405) {
		r = curl('POST', `${GITLAB_API}/projects/${GITLAB_MAIN_PROJECT}/releases`,
			{ headers: glHeaders, json: { tag_name: tag, name: `VsSaros ${tag}`, description: desc } });
	}
	if (!(r.status >= 200 && r.status < 300)) {
		throw new Error(`main-repo release failed -> ${r.status}: ${brief(r.data)}`);
	}
	log(`main-repo release: ${GITLAB_WEB}/${GITLAB_MAIN_PROJECT_PATH}/-/releases/${tag}`);

	// 4. attach EXE 直链 as release asset links（幂等：先查重）
	const existing = curl('GET', `${GITLAB_API}/projects/${GITLAB_MAIN_PROJECT}/releases/${encodeURIComponent(tag)}/assets/links`,
		{ headers: glHeaders });
	const existingNames = new Set(
		existing.status === 200 && Array.isArray(existing.data) ? existing.data.map((l) => l.name) : []);
	for (const d of downloads) {
		if (existingNames.has(d.name)) { log(`asset link exists: ${d.name}`); continue; }
		const lr = curl('POST', `${GITLAB_API}/projects/${GITLAB_MAIN_PROJECT}/releases/${encodeURIComponent(tag)}/assets/links`,
			{ headers: glHeaders, json: { name: d.name, url: d.url, link_type: 'other' } });
		if (lr.status === 201) { log(`asset link added: ${d.name}`); }
		else { warn(`asset link ${d.name} -> ${lr.status}: ${brief(lr.data)}`); }
	}
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
