#!/usr/bin/env node
/**
 * 从 **Cline MCP Marketplace** 爬取数据到自营商城（★ 2026-10-24 用户需求）。
 *
 * ## 数据源（查证过，不是猜的）
 * Cline 的商城前端（`cline.bot/mcp-marketplace`）是 **Next.js SSR**，数据在服务端；
 * 开源仓库 `cline/cline` 里也只有调用代码。**唯一可公开爬取的结构化数据**是它的提交仓库：
 * `https://github.com/cline/mcp-marketplace` 的 **Issues**（用 Issue 表单提交，人工审核）。
 *
 * 实测规模：**3121 条**（2868 open / **253 closed**）。
 * 每条 issue 的 body：
 * ```
 * ### GitHub Repository URL
 * https://github.com/<owner>/<repo>
 * ### Logo Image
 * https://…/logo-400.png        或  <img width="400" height="400" src="https://github.com/user-attachments/assets/…" />
 * ### Installation Testing
 * - [x] …
 * ### Additional Information
 * <自由文本描述>
 * ```
 * ⚠ 字段标题有 `###`（主流）也有 `##`（早期提交）⇒ 正则兼容 2~4 级。
 *
 * ## 口径（重要）
 * 这个仓库是**提交池**，不等于 Cline 商城里已上架的全部商品。
 * ⇒ 默认只同步 **closed**（253 条，已处理过，最接近"已上架"）；
 *    要全量用 `--state all`（3121 条，会引入大量未审核提交，慎用）。
 *
 * ## 用法
 * ```bash
 * node tools/sync-cline-mcp.mjs --dry --limit 3      # 先看会做什么
 * node tools/sync-cline-mcp.mjs --covers             # 同步 closed + 抓 logo 自持
 * node tools/sync-cline-mcp.mjs --state all --limit 100 --covers
 * ```
 * 环境变量：
 * - `MARKET_ENDPOINT`（默认 http://21.6.92.5:3040）
 * - `GITHUB_TOKEN` —— **强烈建议**：未认证只有 60 请求/小时（每页 100 条 ⇒ 3121 条要 32 页）
 *
 * ## 幂等
 * 已存在的 slug ⇒ 跳过发版本，但会**顺带修正文案/封面**（与 `sync-market-workbenches` 同策略）。
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '..', 'lib');
const ENDPOINT = (process.env.MARKET_ENDPOINT || 'http://21.6.92.5:3040').replace(/\/+$/, '');
const CONCURRENCY = 3;

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const COVERS = argv.includes('--covers');
const FORCE = argv.includes('--force');
const LIMIT = (() => {
	const i = argv.indexOf('--limit');
	if (i < 0) { return 0; }
	const n = Number(argv[i + 1]);
	return Number.isFinite(n) && n > 0 ? n : 0;
})();
/** `closed`（默认，最接近已上架）/ `open` / `all` */
const STATE = (() => {
	const i = argv.indexOf('--state');
	const v = i >= 0 ? String(argv[i + 1] ?? '') : '';
	return ['open', 'closed', 'all'].includes(v) ? v : 'closed';
})();

// ── ① 取凭据（与其余运维脚本同一套：读 dsh 的 credentials）────────────
const {
	createMarketClient, MARKET_JWT_REF, TOF_LOCAL_TICKET_REF, TOF_IDENTITY_REF,
} = await import(pathToFileURL(path.join(LIB, 'marketClient.js')).href);

/**
 * 从 dsh 的凭据文件里读出票据 + 身份，并按 **客户端要求的 ref** 建 map。
 *
 * ⚠ 直接把 yaml 的 key 当 ref 用会失败：`login()` 解析的是
 *   `TOF_LOCAL_TICKET_REF` / `TOF_IDENTITY_REF` 这两个**固定 ref**
 *   （真机上对应 yaml 里的 `VSSAROS_TOF_TICKET_DSH` / `VSSAROS_TOF_IDENTITY_DSH`），
 *   不做映射就会报「没有 TOF 票据」✗
 */
function loadTofCredentials() {
	const file = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.vssaros-dev', 'dsh-home', '.credentials.yaml');
	const store = new Map();
	if (!fs.existsSync(file)) { return store; }
	const text = fs.readFileSync(file, 'utf8');
	// ⚠ **不能加行首锚点**：凭据是嵌套 YAML，票据在 `refs:` 之下、有 2 空格缩进
	//   ⇒ `^VSSAROS_TOF_TICKET_DSH:` 永远匹配不到（真机踩过，报「没有 TOF 票据」）✗
	const grab = (key) => {
		const m = new RegExp(key + '[ \\t]*:[ \\t]*(.+)$', 'm').exec(text);
		return m ? m[1].trim().replace(/^['"]/, '').replace(/['"]$/, '') : undefined;
	};
	const ticket = grab('VSSAROS_TOF_TICKET_DSH');
	const identity = grab('VSSAROS_TOF_IDENTITY_DSH');
	if (ticket) { store.set(TOF_LOCAL_TICKET_REF, ticket); }
	if (identity) { store.set(TOF_IDENTITY_REF, identity); }
	return store;
}

const kv = loadTofCredentials();
const credentials = {
	resolve: async (ref) => (kv.has(ref) ? { value: kv.get(ref) } : undefined),
	set: async (ref, value) => { kv.set(ref, value); },
	unset: async (ref) => { kv.delete(ref); },
};
const market = createMarketClient({ credentials, config: { marketEndpoint: ENDPOINT }, log: () => {} });

// ── ② GitHub Issues 抓取（分页）─────────────────────────────────
const GH = {
	'user-agent': 'VsSarosMarket/1.0',
	accept: 'application/vnd.github+json',
	...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};
const REPO = 'cline/mcp-marketplace';
const PER_PAGE = 100;

/** 拉一页；剩额度为 0 时明确报错（不静默少拉） */
async function fetchPage(state, page) {
	const url = `https://api.github.com/repos/${REPO}/issues?state=${state}&per_page=${PER_PAGE}&page=${page}&sort=created&direction=desc`;
	const r = await fetch(url, { headers: GH, signal: AbortSignal.timeout(30000) });
	const remaining = r.headers.get('x-ratelimit-remaining');
	if (!r.ok) {
		throw new Error(`GitHub API ${r.status}（remaining=${remaining}）—— ${(await r.text()).slice(0, 120)}`);
	}
	const arr = await r.json();
	return { items: Array.isArray(arr) ? arr : [], remaining: Number(remaining ?? -1) };
}

// ── ③ 解析 issue body ───────────────────────────────────────────
/**
 * 取某个小节的内容（`### 标题` 到下一个同级/更高级标题）。
 * ⚠ 兼容 `##` / `###` / `####`（早期提交通常用 `##`）。
 */
function sectionOf(body, title) {
	const re = new RegExp(`#{2,4}\\s*${title}\\s*\\n+([\\s\\S]*?)(?=\\n#{2,4}\\s|$)`, 'i');
	return (re.exec(body ?? '')?.[1] ?? '').trim();
}

/** 从 `<img src>` 或裸 URL 里取图片地址。 */
function pickLogo(raw) {
	const inImg = /<img[^>]*\bsrc=["']([^"']+)["']/i.exec(raw ?? '')?.[1];
	if (inImg) { return inImg.trim(); }
	return (/(https?:\/\/[^\s)>\]]+)/.exec(raw ?? '')?.[1] ?? '').trim();
}

/** `owner/repo` → 商城 slug（`owner-repo`，小写、只留 `[a-z0-9_-]`、≤64）。 */
function slugOf(repoUrl) {
	const m = /github\.com\/([^/\s]+)\/([^/\s?#]+)/i.exec(repoUrl ?? '');
	if (!m) { return ''; }
	const owner = m[1].toLowerCase().replace(/[^a-z0-9-]+/g, '-');
	const name = m[2].replace(/\.git$/i, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/[._]/g, '-');
	const slug = `${owner}-${name}`.replace(/-+/g, '-').replace(/^-|-$/g, '');
	return slug.length > 64 ? slug.slice(0, 64).replace(/-$/, '') : slug;
}

/** 标题去掉 `[Server Submission]:` 前缀与多余的换行/引用符。 */
function cleanTitle(title) {
	return String(title ?? '')
		.replace(/^\[(Server Submission|Submission|Server)\]:\s*/i, '')
		.replace(/\s*>\s*/g, ' ')          // 有些标题里带 markdown 引用符
		.replace(/\s+/g, ' ')
		.trim();
}

/** issue → 商城条目（解析不了返回 `{ skip: reason }`）。 */
function toEntry(issue) {
	const body = issue.body ?? '';
	const repo = (/(https?:\/\/github\.com\/[^\s)>\]]+)/i.exec(sectionOf(body, 'GitHub Repository URL'))?.[1] ?? '')
		.replace(/[.,;]+$/, '');
	if (!repo) { return { skip: '没有 GitHub Repository URL' }; }
	const slug = slugOf(repo);
	if (!slug) { return { skip: `repo 解析不出 slug：${repo.slice(0, 60)}` }; }

	const repoPath = /github\.com\/([^/\s]+\/[^/\s?#]+)/i.exec(repo)?.[1]?.replace(/\.git$/i, '') ?? '';
	const logo = pickLogo(sectionOf(body, 'Logo Image'));
	const desc = sectionOf(body, 'Additional Information').replace(/<!--[\s\S]*?-->/g, '').trim();
	return {
		slug,
		name: (cleanTitle(issue.title) || repoPath).slice(0, 128),
		repo,
		distribution: { type: 'github-source', name: repoPath },
		logo,
		description: desc.slice(0, 1500),   // 服务端上限 2048，留余量
		issue: issue.number,
		state: issue.state,
	};
}

// ── ④ 封面自持（下载 → 上传 `/api/v1/covers`）────────────────────
async function uploadCover({ slug, imageUrl, token }) {
	try {
		const img = await fetch(imageUrl, {
			signal: AbortSignal.timeout(25000),
			headers: { 'user-agent': 'Mozilla/5.0 (compatible; VsSarosMarket/1.0)', accept: 'image/*' },
		});
		if (!img.ok) { return { error: `下载失败 HTTP ${img.status}` }; }
		const buf = Buffer.from(await img.arrayBuffer());
		if (buf.length === 0) { return { error: '下载到 0 字节' }; }
		const ext = /\.(png|jpe?g|webp|gif)(?:$|\?)/i.exec(imageUrl)?.[1]?.toLowerCase().replace('jpeg', 'jpg') || 'png';
		const r = await fetch(`${ENDPOINT}/api/v1/covers?${new URLSearchParams({ slug, ext })}`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
			body: buf,
			signal: AbortSignal.timeout(30000),
		});
		const body = await r.json().catch(() => ({}));
		if (!r.ok) { return { error: `上传失败 HTTP ${r.status}：${String(body?.error ?? '').slice(0, 70)}` }; }
		return { url: `${ENDPOINT}${body.url}`, bytes: buf.length };
	} catch (e) {
		return { error: String(e?.message ?? e).slice(0, 90) };
	}
}

// ── ⑤ 主流程 ────────────────────────────────────────────────────
async function main() {
	console.log(`数据源: ${REPO} (state=${STATE})`);
	console.log(`目标商城: ${ENDPOINT}`);
	if (DRY) { console.log('【dry-run】只打印，不写库'); }

	let token = '';
	if (!DRY && COVERS) {
		token = await market.login();
		console.log('已登录（logo 会上传到本商城自持）');
	}

	// 拉取（按需分页）
	const entries = [];
	let page = 1;
	let remaining = -1;
	let total = null;
	while (true) {
		const { items, remaining: rem } = await fetchPage(STATE, page);
		remaining = rem;
		if (total === null) { total = items.length < PER_PAGE ? items.length : null; }
		for (const it of items) {
			if (it.pull_request) { continue; }      // 跳过 PR（issues 接口会混进来）
			const e = toEntry(it);
			if (e.skip) { continue; }
			entries.push(e);
			if (LIMIT && entries.length >= LIMIT) { break; }
		}
		process.stdout.write(`\r  已拉取 ${entries.length} 条（第 ${page} 页，剩余额度 ${remaining}）`);
		if (items.length < PER_PAGE) { break; }
		if (LIMIT && entries.length >= LIMIT) { break; }
		if (remaining === 0) {
			console.log('\n⚠ GitHub 额度用尽，后续页没拉到（设 GITHUB_TOKEN 可提到 5000/h）');
			break;
		}
		page += 1;
	}
	console.log('');
	console.log(`解析到 ${entries.length} 条（有 repo + 有 slug）`);
	const withLogo = entries.filter(e => e.logo).length;
	console.log(`其中带 logo: ${withLogo}`);

	if (entries.length === 0) { return; }

	let created = 0;
	let skipped = 0;
	let failed = 0;
	let covered = 0;
	const failures = [];

	const runOne = async (e) => {
		const meta = {
			name: e.name,
			...(e.description ? { description: e.description } : {}),
			category: 'MCP',
		};
		try {
			if (DRY) {
				console.log(`  [dry] ${e.slug.padEnd(40)} ${e.repo.slice(0, 46)}  logo=${e.logo ? 'y' : 'n'}`);
				return;
			}
			const { publishDistribution } = await import(pathToFileURL(path.join(LIB, 'publisher.js')).href);
			await publishDistribution({
				market, kind: 'mcp', localId: e.slug, version: '1.0.0',
				distribution: e.distribution, changelog: `来自 Cline MCP Marketplace #${e.issue}`, meta,
			});
			created += 1;
		} catch (err) {
			const msg = String(err?.message ?? err);
			if (/已存在|已被占用|HTTP 409|重复/.test(msg)) {
				skipped += 1;
				if (!DRY) {
					// 顺手修正文案（幂等修复）
					try {
						await market.updatePackage(e.slug, { name: meta.name, ...(meta.description ? { description: meta.description } : {}) });
					} catch { /* 修不了不影响结论 */ }
				}
			} else if (FORCE && /HTTP 409|已存在/.test(msg)) {
				skipped += 1;
			} else {
				failed += 1;
				failures.push(`${e.slug}: ${msg.slice(0, 90)}`);
				return;
			}
		}
		// 封面（自持）
		// ⚠ 这里**不许静默**：之前 `catch {}` 把 updatePackage 的失败吞了，
		//   表现成"封面自持 0 条但也没报错"（真机踩过）✗
		if (!DRY && COVERS && e.logo) {
			const up = await uploadCover({ slug: e.slug, imageUrl: e.logo, token });
			if (!up.url) {
				failures.push(`${e.slug}: 封面上传失败 ${up.error}`);
			} else {
				try {
					await market.updatePackage(e.slug, { cover: up.url });
					covered += 1;
				} catch (err) {
					failures.push(`${e.slug}: 写 cover 失败 ${String(err?.message ?? err).slice(0, 80)}（已上传 ${up.url.slice(-40)}）`);
				}
			}
		}
	};

	// 小并发（对 GitHub / 自己服务器都友好）
	let idx = 0;
	await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
		while (idx < entries.length) {
			const e = entries[idx];
			idx += 1;
			await runOne(e);
		}
	}));

	console.log('');
	if (DRY) {
		console.log(`【dry-run】会处理 ${entries.length} 条`);
		return;
	}
	console.log(`新增 ${created} · 已存在 ${skipped} · 失败 ${failed}${COVERS ? ` · 封面自持 ${covered}` : ''}`);
	if (failures.length) {
		console.log('失败明细（前 12 条）：');
		failures.slice(0, 12).forEach(f => console.log('  -', f));
	}
}

await main();
