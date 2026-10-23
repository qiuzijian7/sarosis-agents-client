// @vssaros/dsh-marketplace — GitHub 作为**发布源**（★ 2026-10-22 用户需求）
//
// 需求：「上传的技能/agent/mcp/工作台 本体是一个 GitHub 地址」⇒ 商品不打包，
// 只登记"从哪拿"，安装时按地址去取。
//
// 服务端早已有这套口径（`packages/parser.ts` 的 DistributionSchema）：
//   npm            → name = 包名
//   github-release → url  = Release 资产的**直链**（https）
//   github-source  → name = `owner/repo`（commit 可选）
// ⇒ dsh 侧要补的是两件事：
//   ① 发布：把用户随便粘的一个 GitHub 地址**归一化**成上面那种描述；
//   ② 安装：按描述算出一个能直接下载的 **tar.gz** 地址，解包后**找到真正的安装根**。
//
// ★ 为什么只要 tar.gz、不要 zip：
//   GitHub 的 `codeload.github.com/.../tar.gz/<ref>` 天然是 tar.gz ⇒ 复用 `lib/tar.js`
//   就够；zip 需要另外实现解压（`node:zlib` 只有 gzip）⇒ **不引入** ✓
//
// ★ 为什么需要"定位安装根"：
//   GitHub archive 的顶层是 `<repo>-<ref>/`，而技能仓库里 `SKILL.md` 常在
//   `skills/<name>/SKILL.md` ⇒ 不定位就会把整仓当技能装进去（装完技能列表里啥也没有 ✗）。

/** 允许下载的域（**收窄到 GitHub**，防 SSRF 打到内网/任意地址）✗ */
const ALLOWED_HOSTS = new Set([
	'github.com',
	'codeload.github.com',
	'objects.githubusercontent.com',
	'raw.githubusercontent.com',
]);

/** 单个包允许的最大字节数（GitHub 仓库 tar.gz 通常远小于此） */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

/** 各 kind 在包内的"入口文件"（定位安装根的依据）。 */
const ENTRY_OF = {
	skill: 'SKILL.md',
	workflow: 'workflow.json',
	agent: '.agent.md',
};

/**
 * 解析用户粘的 GitHub 地址 → 发布源描述。
 *
 * 支持这些形态（都归一化成 `github-source` 或 `github-release`）：
 *   · `owner/repo`
 *   · `https://github.com/owner/repo`
 *   · `https://github.com/owner/repo/tree/<ref>[/<subdir>]`
 *   · `https://github.com/owner/repo/blob/<ref>/<file>`（取仓库根，忽略文件）
 *   · `https://github.com/owner/repo/releases/download/<tag>/<asset>` ⇒ **github-release**
 *   · `https://codeload.github.com/owner/repo/tar.gz/<ref>` ⇒ github-source
 *
 * @param {unknown} input
 * @returns {{ type: 'github-source', name: string, commit?: string } | { type: 'github-release', url: string }}
 */
export function parseGitHubSource(input) {
	const raw = String(input ?? '').trim();
	if (!raw) { throw new Error('GitHub 地址不能为空'); }

	// ① 裸 `owner/repo`
	if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) {
		return { type: 'github-source', name: raw };
	}

	// ② URL 形态
	let url;
	try { url = new URL(raw); } catch { throw new Error(`看不懂这个地址：${raw}（支持 owner/repo 或 https://github.com/...）`); }
	if (url.protocol !== 'https:') {
		throw new Error(`只接受 https 的 GitHub 地址（收到 ${url.protocol}//）`);
	}
	if (!isAllowedHost(url.hostname)) {
		throw new Error(`只支持 GitHub 的地址（收到 ${url.hostname}）—— 其它域名不允许下载`);
	}

	const seg = url.pathname.split('/').filter(Boolean);
	// codeload: /<owner>/<repo>/tar.gz/<ref>
	if (url.hostname === 'codeload.github.com') {
		if (seg.length >= 4 && seg[2] === 'tar.gz') {
			return { type: 'github-source', name: `${seg[0]}/${stripGit(seg[1])}`, commit: decodeURIComponent(seg[3]) };
		}
		throw new Error(`不认识的 codeload 地址：${raw}`);
	}

	if (seg.length < 2) { throw new Error(`GitHub 地址里没看出仓库：${raw}`); }
	const owner = seg[0];
	const repo = stripGit(seg[1]);

	// releases/download/<tag>/<asset> ⇒ github-release（直链就是用户给的这个）
	if (seg[2] === 'releases' && seg[3] === 'download') {
		return { type: 'github-release', url: `https://github.com/${owner}/${repo}/releases/download/${seg.slice(4).join('/')}` };
	}
	// archive/refs/heads/<branch>.tar.gz 或 archive/<ref>.tar.gz ⇒ github-source
	if (seg[2] === 'archive') {
		// refs/heads/main → main；refs/tags/v1 → v1（**两种形态都要去掉 `.tar.gz`**）
		const idx = seg.indexOf('refs');
		const tail = idx >= 0 ? seg.slice(idx + 2) : seg.slice(3);
		const realRef = tail.join('/').replace(/\.tar\.gz$/, '');
		return { type: 'github-source', name: `${owner}/${repo}`, ...(realRef ? { commit: realRef } : {}) };
	}
	// tree/<ref>[ /subdir ] 或 blob/<ref>/<file>
	if ((seg[2] === 'tree' || seg[2] === 'blob') && seg[3]) {
		const rest = seg.slice(4);
		const ref = decodeURIComponent(seg[3]);
		// subdir 信息服务端没有字段可存 ⇒ 安装时靠"自动定位入口文件"解决 ✓（见 locateInstallRoot）
		void rest;
		return { type: 'github-source', name: `${owner}/${repo}`, commit: ref };
	}
	// 裸仓库地址
	return { type: 'github-source', name: `${owner}/${repo}` };
}

/** 去掉 `.git` 后缀。 */
function stripGit(name) {
	return name.endsWith('.git') ? name.slice(0, -4) : name;
}

/** 域是否允许（精确匹配；`gist.github.com` 之类不在白名单）。 */
export function isAllowedHost(host) {
	return ALLOWED_HOSTS.has(String(host).toLowerCase());
}

/**
 * 发布源描述 → **可下载的 tar.gz 地址**。
 *
 * · github-source ⇒ `codeload.github.com/<owner>/<repo>/tar.gz/<ref>`（ref 缺省 HEAD）
 * · github-release ⇒ 用户给的直链（必须是 https + GitHub 域）
 *
 * @param {{ type: string, name?: string, url?: string, commit?: string }} dist
 * @returns {string}
 */
export function resolveDownloadUrl(dist) {
	if (!dist || typeof dist !== 'object') { throw new Error('缺少发布源描述'); }
	if (dist.type === 'github-source') {
		const name = String(dist.name ?? '').trim();
		const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(name);
		if (!m) { throw new Error(`github-source 的 name 必须是 owner/repo（收到 ${name || '(空)'}）`); }
		const ref = String(dist.commit ?? '').trim() || 'HEAD';
		return `https://codeload.github.com/${m[1]}/${stripGit(m[2])}/tar.gz/${encodeURIComponent(ref)}`;
	}
	if (dist.type === 'github-release') {
		const raw = String(dist.url ?? '').trim();
		let url;
		try { url = new URL(raw); } catch { throw new Error(`github-release 的 url 不是合法地址：${raw}`); }
		if (url.protocol !== 'https:') { throw new Error('github-release 的 url 必须是 https'); }
		if (!isAllowedHost(url.hostname)) { throw new Error(`github-release 的 url 只允许 GitHub 域（收到 ${url.hostname}）`); }
		return url.toString();
	}
	if (dist.type === 'npm') {
		throw new Error('npm 分发需要 npm 客户端，dsh 侧暂不支持安装（可以改用 GitHub 地址）');
	}
	throw new Error(`不认识的分发类型：${String(dist.type)}`);
}

/**
 * 在解出来的条目里**定位真正的安装根**。
 *
 * 规则（宁可报错也不猜）：
 *   1. 若根目录就有入口文件（`SKILL.md` / `workflow.json` / `.agent.md`）⇒ 根就是安装根；
 *   2. 否则找**唯一**一个包含入口文件的目录 ⇒ 那个目录是根（GitHub archive 的
 *      `<repo>-<ref>/xxx/SKILL.md` 就走这条）；
 *   3. 找不到、或找到多个 ⇒ 如实报错（装错目录比装不上更糟 ✗）。
 *
 * @param {{ path: string, data: Buffer }[]} files
 * @param {string} kind
 * @returns {{ root: string, files: { path: string, data: Buffer }[] }} root 是相对路径（''=根）
 */
export function locateInstallRoot(files, kind) {
	const entry = ENTRY_OF[kind];
	if (!entry) { throw new Error(`这一类还没有"安装根"的判据：${kind}`); }
	if (files.some(f => f.path === entry)) {
		return { root: '', files };
	}
	const dirs = new Set();
	for (const f of files) {
		if (!f.path.endsWith(`/${entry}`)) { continue; }
		// 只取"入口文件所在目录"（更深层的同名文件同样算它的父目录）
		dirs.add(f.path.slice(0, -1 * (entry.length + 1)));
	}
	if (dirs.size === 0) {
		throw new Error(`包里找不到 ${entry}（这一类商品的根目录必须包含它）`);
	}
	if (dirs.size > 1) {
		throw new Error(`包里有多处 ${entry}（${[...dirs].sort().join('、')}）⇒ 不知道该装哪一个，请把地址指到具体子目录所在仓库`);
	}
	const root = [...dirs][0];
	const prefix = `${root}/`;
	return {
		root,
		files: files
			.filter(f => f.path.startsWith(prefix) && f.path !== prefix)
			.map(f => ({ ...f, path: f.path.slice(prefix.length) })),
	};
}

/**
 * 下载 GitHub 的 tar.gz（**不带商城 JWT** —— GitHub 不认它）。
 *
 * 安全边界（都是硬的）：
 *   · 只走 https + 白名单域；**跟随重定向后仍校验**（Release 资产会 302 到 objects.githubusercontent.com）
 *   · 体积上限（★ 2026-10-23：**流式边收边判**，不是下完再判 —— 以前用 `arrayBuffer()`
 *     一次性读满，64MB 上限只是"下完之后拒绝"，内存峰值仍是 64MB × 2（再 gunzip 还要一份）✗）
 *   · 超时
 *
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, maxBytes?: number, timeoutMs?: number, onProgress?: (received: number, total: number) => void }} [opts]
 * @returns {Promise<Buffer>}
 */
export async function downloadGitHubTarball(url, opts = {}) {
	const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
	const maxBytes = opts.maxBytes ?? MAX_DOWNLOAD_BYTES;
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : undefined;
	const target = new URL(url);
	if (target.protocol !== 'https:') { throw new Error('只允许 https 下载'); }
	if (!isAllowedHost(target.hostname)) { throw new Error(`不允许从这个域下载：${target.hostname}`); }

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
		if (!resp.ok) {
			throw new Error(`GitHub 下载失败：HTTP ${resp.status}（${url}）`);
		}
		// 响应头有长度就先挡（避免下完才后悔）
		const declared = Number(resp.headers?.get?.('content-length') ?? '');
		if (Number.isFinite(declared) && declared > maxBytes) {
			throw new Error(`包太大（Content-Length ${(declared / 1024 / 1024).toFixed(1)}MB > 上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB）`);
		}

		const chunks = [];
		let total = 0;
		const push = (chunk) => {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			total += buf.length;
			if (total > maxBytes) {
				throw new Error(`包太大（${(total / 1024 / 1024).toFixed(1)}MB > 上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB）`);
			}
			chunks.push(buf);
			if (onProgress) { onProgress(total, maxBytes); }
		};

		// ① 首选流式：`body.getReader()` ⇒ **边收边判上限**（内存只到上限，不会先吃满 64MB）
		const reader = resp.body && typeof resp.body.getReader === 'function' ? resp.body.getReader() : null;
		if (reader) {
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) { break; }
					push(value);
				}
			} catch (e) {
				// 超限时把连接断掉（别让服务端继续推），再把原始错误抛出去
				try { await reader.cancel(); } catch { /* 已经关了 */ }
				throw e;
			}
			return Buffer.concat(chunks, total);
		}

		// ② 回退：老 fetch 实现 / 测试 stub 只有 `arrayBuffer()` ⇒ 退化为一次性读，仍事后判上限
		if (typeof resp.arrayBuffer !== 'function') {
			throw new Error('这个 fetch 实现不支持二进制（body 流 / arrayBuffer）');
		}
		push(await resp.arrayBuffer());
		return Buffer.concat(chunks, total);
	} catch (e) {
		if (e && e.name === 'AbortError') {
			throw new Error(`GitHub 下载超时（${Math.round(timeoutMs / 1000)}s）：${url}`);
		}
		throw e;
	} finally {
		clearTimeout(timer);
	}
}
