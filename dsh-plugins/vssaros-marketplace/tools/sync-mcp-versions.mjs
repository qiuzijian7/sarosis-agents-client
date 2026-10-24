#!/usr/bin/env node
/**
 * 把已入库的 MCP 商品的**版本号**对齐到各自 repo 的真实版本（★ 2026-10-24 用户需求）。
 *
 * ## 背景
 * 从 Cline 提交 Issue 同步时，Issue 里**没有版本信息** ⇒ 全部先记为 `1.0.0` 占位。
 * 真实版本只能去各自仓库读 `package.json`（Node 项目；其它语言没有该文件就跳过）。
 *
 * ## 做法
 * 1. 列出商城里所有 `kind=mcp` 的商品
 * 2. 从 `distribution_meta.name`（`owner/repo`）取仓库
 * 3. 依次试 `HEAD` / `main` / `master` 的 `raw.githubusercontent.com/.../package.json`
 * 4. 读到合法 `version` 且**与当前 latest_version 不同** ⇒ 用 `publishDistribution`
 *    发一个新版本（`latest_version` 随之上移；旧版本保留在历史里，不删）
 * 5. 顺手清掉 `_No response_`（GitHub Issue 表单的"未填写"占位符，被当成描述入库了）
 *
 * ## 用法
 * ```bash
 * node tools/sync-mcp-versions.mjs --dry --limit 10    # 先看会改什么
 * node tools/sync-mcp-versions.mjs                     # 全量（133 个，约 1-2 分钟）
 * node tools/sync-mcp-versions.mjs --only-missing      # 只处理仍是 1.0.0 占位的
 * node tools/sync-mcp-versions.mjs --no-releases       # 只读 package.json（不回退 Releases）
 * ```
 *
 * ⚠ `raw.githubusercontent.com` **不占** GitHub API 的 60/h 额度（它是静态 CDN），
 *   所以这里不需要 token；但每个仓库只取一次，失败不重试。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const LIB = path.resolve(HERE, '..', 'lib');
const ENDPOINT = (process.env.MARKET_ENDPOINT || 'http://21.6.92.5:3040').replace(/\/+$/, '');
const CONCURRENCY = 4;
/** 占位符描述（Issue 表单没填时的默认值） */
const PLACEHOLDERS = new Set(['_No response_', 'No response', '_No response_ ', 'N/A', '-']);

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const ONLY_MISSING = argv.includes('--only-missing');
// `--no-releases` 可关掉 Releases 回退（只想读 package.json 时）
const USE_RELEASES = !argv.includes('--no-releases');
const LIMIT = (() => {
	const i = argv.indexOf('--limit');
	if (i < 0) { return 0; }
	const n = Number(argv[i + 1]);
	return Number.isFinite(n) && n > 0 ? n : 0;
})();

// ── 凭据（嵌套 YAML：票据在 `refs:` 下，正则**不能加行首锚点**）──────────
const {
	createMarketClient, TOF_LOCAL_TICKET_REF, TOF_IDENTITY_REF,
} = await import(pathToFileURL(path.join(LIB, 'marketClient.js')).href);
// `deleteVersion` 用来删掉占位的 1.0.0（服务端 latest 按 semver 最大取值）
const { publishDistribution, deleteVersion } = await import(pathToFileURL(path.join(LIB, 'publisher.js')).href);

function loadTofCredentials() {
	const file = path.join(os.homedir(), '.vssaros-dev', 'dsh-home', '.credentials.yaml');
	const store = new Map();
	if (!fs.existsSync(file)) { return store; }
	const text = fs.readFileSync(file, 'utf8');
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
const market = createMarketClient({
	credentials: {
		resolve: async (ref) => (kv.has(ref) ? { value: kv.get(ref) } : undefined),
		set: async (ref, value) => { kv.set(ref, value); },
		unset: async (ref) => { kv.delete(ref); },
	},
	config: { marketEndpoint: ENDPOINT },
	log: () => {},
});

// ── 读仓库版本 ──────────────────────────────────────────────────
/** 从 `owner/repo` 读 `package.json` 的 version（依次试 HEAD/main/master）。 */
async function readPkgJsonVersion(repo) {
	const branches = ['HEAD', 'main', 'master'];
	for (const br of branches) {
		const url = `https://raw.githubusercontent.com/${repo}/${br}/package.json`;
		try {
			const r = await fetch(url, { headers: { 'user-agent': 'VsSarosMarket/1.0' }, signal: AbortSignal.timeout(15000) });
			if (!r.ok) { continue; }
			const j = await r.json().catch(() => null);
			const v = typeof j?.version === 'string' ? j.version.trim() : '';
			if (v) { return { version: v, via: `package.json@${br}` }; }
			return { error: 'package.json 里没有 version 字段' };
		} catch {
			/* 试下一个分支 */
		}
	}
	return { error: '没有 package.json（非 Node 项目或不在根目录）' };
}

/**
 * 从 **GitHub Releases 的最新 tag** 取版本（`--releases`）。
 *
 * 为什么用 302 的 `Location` 而不是 `api.github.com/repos/:o/:r/releases/latest`：
 * - 后者**占 API 额度**（未认证仅 60/h）⇒ 67 个非 Node 项目直接撞墙 ✗
 * - 前者是 `github.com` 的普通跳转，**不占额度**，`Location` 就是
 *   `/owner/repo/releases/tag/v1.2.3` ⇒ 直接解析出 tag ✓
 *
 * 实测可用：`github/github-mcp-server` → `v2.0.3`；`planetscale/cli` → `v0.348.0`
 */
async function readReleaseVersion(repo) {
	try {
		const r = await fetch(`https://github.com/${repo}/releases/latest`, {
			redirect: 'manual',
			headers: { 'user-agent': 'Mozilla/5.0 (compatible; VsSarosMarket/1.0)' },
			signal: AbortSignal.timeout(15000),
		});
		const loc = r.headers.get('location') ?? '';
		const tag = /\/releases\/tag\/([^/?#]+)/.exec(loc)?.[1] ?? '';
		if (!tag) {
			// 302/301 但跳到的是 `/releases` 列表页 ⇒ 该仓库**没有 latest Release**
			// （不是错误，只是没有发布记录）
			return { error: r.status === 404 ? '没有 Release' : '没有 latest Release（跳到了 releases 列表）' };
		}
		// 剥掉开头的 `v` / `release-` 之类前缀，但保留 `1.2.3-beta.1` 这类后缀
		const version = decodeURIComponent(tag).replace(/^(v|ver|release[-_]?)/i, '').trim();
		return { version, via: `releases/tag/${tag}` };
	} catch (e) {
		return { error: String(e?.message ?? e).slice(0, 80) };
	}
}

/**
 * 综合取版本：先 `package.json`（Node 项目最准），失败再退到 Releases。
 * @param {string} repo
 * @param {{ useReleases?: boolean }} [opts]
 */
async function readRepoVersion(repo, opts = {}) {
	const pkg = await readPkgJsonVersion(repo);
	if (pkg.version) { return pkg; }
	if (!opts.useReleases) { return pkg; }
	const rel = await readReleaseVersion(repo);
	if (rel.version) { return rel; }
	return { error: `${pkg.error}；${rel.error}` };
}

/** 版本号是否像版本（防 `0.0.0` / 占位）。 */
function isRealVersion(v) {
	const s = String(v ?? '').trim();
	if (!/^\d+\.\d+\.\d+/.test(s)) { return false; }
	if (/^0\.0\.0$/.test(s)) { return false; }
	return true;
}

// ── 主流程 ──────────────────────────────────────────────────────
async function listAllMcp() {
	const all = [];
	let page = 1;
	for (;;) {
		const res = await market.list({ kind: 'mcp', page, pageSize: 100 });
		const items = res.items ?? [];
		all.push(...items);
		if (items.length < 100) { break; }
		if (all.length >= (res.total ?? 0)) { break; }
		page += 1;
		if (page > 20) { break; }
	}
	return all;
}

async function main() {
	console.log(`目标商城: ${ENDPOINT}`);
	const items = await listAllMcp();
	console.log(`库里 MCP 共 ${items.length} 个`);

	let targets = items;
	if (ONLY_MISSING) {
		targets = items.filter(p => String(p.latest_version ?? '') === '1.0.0');
		console.log(`其中仍是 1.0.0 占位: ${targets.length}`);
	}
	if (LIMIT) { targets = targets.slice(0, LIMIT); }
	console.log(`本次处理 ${targets.length} 个${DRY ? '【dry-run】' : ''}\n`);

	let changed = 0;
	let same = 0;
	let descFixed = 0;
	let pruned = 0;
	const failures = [];

	let idx = 0;
	await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
		while (idx < targets.length) {
			const p = targets[idx];
			idx += 1;
			const repo = p.distribution_meta?.name;
			if (!repo) { failures.push(`${p.slug}: 没有 distribution_meta.name`); continue; }

			const got = await readRepoVersion(repo, { useReleases: USE_RELEASES });
			if (got.error) { failures.push(`${p.slug} (${repo}): ${got.error}`); continue; }

			const real = got.version;
			const cur = String(p.latest_version ?? '');
			if (!isRealVersion(real)) { failures.push(`${p.slug} (${repo}): 版本不像版本号（${real}）`); continue; }

			// 顺手清理占位描述
			const desc = String(p.description ?? '').trim();
			const needDescFix = PLACEHOLDERS.has(desc) || desc.length === 0;
			if (needDescFix && !DRY) {
				try {
					await market.updatePackage(p.slug, { description: '' });
					descFixed += 1;
				} catch { /* 修不了不影响版本 */ }
			}

			// ⚠ 服务端取 `latest_version` 是**按 semver 最大**，不是"最后发布的那条"。
			//   ⇒ 占位 `1.0.0` 会永远压过真实版本 `0.2.0`（真机踩到：历史是
			//   `0.2.0, 1.0.0` 但 latest 显示 1.0.0 ✗）
			//   ⇒ 发完真实版本后必须**删掉占位的 1.0.0**（仅当它不是真实版本时）。
			const needPrune = cur === '1.0.0' && real !== '1.0.0';

			if (real === cur) {
				same += 1;
				continue;
			}

			if (DRY) {
				console.log(`  [dry] ${p.slug.padEnd(38)} ${cur || '(无)'} → ${real}  (${got.via})${needPrune ? '  会删占位 1.0.0' : ''}`);
				changed += 1;
				continue;
			}

			try {
				await publishDistribution({
					market,
					kind: 'mcp',
					localId: p.slug,
					version: real,
					distribution: { type: 'github-source', name: repo },
					changelog: `版本对齐：读取 ${repo} 的 ${got.via}`,
					meta: {
						name: String(p.name ?? p.slug),
						...(needDescFix ? {} : { description: String(p.description ?? '') }),
						...(p.category ? { category: String(p.category) } : {}),
					},
				});
				changed += 1;
				console.log(`  ✔ ${p.slug.padEnd(38)} ${cur || '(无)'} → ${real}`);
			} catch (e) {
				const msg = String(e?.message ?? e).slice(0, 90);
				if (/已存在|409/.test(msg)) { same += 1; }
				else { failures.push(`${p.slug}: ${msg}`); continue; }
			}

			// 删占位版本（让 latest 落到真实版本上）
			if (needPrune) {
				try {
					await deleteVersion({ market, slug: p.slug, version: '1.0.0' });
					pruned += 1;
				} catch (e) {
					failures.push(`${p.slug}: 删占位 1.0.0 失败 ${String(e?.message ?? e).slice(0, 70)}`);
				}
			}
		}
	}));

	console.log('');
	if (DRY) { console.log(`【dry-run】会改版本 ${changed} 个`); return; }
	console.log(`版本更新 ${changed} · 已是最新 ${same} · 删占位 ${pruned} · 描述清理 ${descFixed} · 失败 ${failures.length}`);
	if (failures.length) {
		const notNode = failures.filter(f => /没有 package\.json/.test(f)).length;
		console.log(`（其中"没有 package.json" ${notNode} 个 —— 非 Node 项目，版本无从获取）`);
		console.log('失败明细（前 15 条）：');
		failures.slice(0, 15).forEach(f => console.log('  -', f));
	}
}

await main();
