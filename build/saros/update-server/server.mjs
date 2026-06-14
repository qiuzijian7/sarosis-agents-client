// @ts-check
/**
 * VsSarosis 最小 Update Feed 服务（零依赖，Node 原生 http）
 * ============================================================
 * 实现 VS Code 客户端期望的更新协议：
 *
 *   GET /api/update/{platform}/{quality}/{commit}
 *
 *   - platform 例：win32-x64-user / win32-x64 / win32-arm64-user ...
 *   - quality  例：saros（与 product.json 的 quality 一致）
 *   - commit   客户端当前的 commit（用于比较是否需要更新）
 *
 * 响应：
 *   - 有更新 → 200 + JSON { version, productVersion, url, sha256hash, timestamp }
 *               version       = 新版本的 commit（客户端用它与自身 commit 比较）
 *               productVersion= 新版本号（如 1.2.3），用于 UI 展示
 *               url           = 安装包 exe 的下载直链
 *               sha256hash    = 安装包 sha256（可选，但强烈建议，用于校验）
 *   - 无更新 → 204 No Content
 *
 * 版本清单来源（二选一，通过环境变量切换）：
 *   1. 本地清单文件 manifest.json（默认，适合自托管 / 内网）
 *   2. GitHub Releases API（设置 GH_REPO=owner/repo 即可）
 *
 * 运行：
 *   node build/saros/update-server/server.mjs
 *   PORT=8080 node build/saros/update-server/server.mjs
 *   GH_REPO=qiuzijian7/saros-agents-client node build/saros/update-server/server.mjs
 *
 * manifest.json 格式（本地模式）：
 *   {
 *     "win32-x64-user": {
 *       "version": "ef65ac1ba57f57f2a3961bfe94aa20481caca4c6",  // 新版本 commit
 *       "productVersion": "1.2.3",
 *       "url": "https://your-host/releases/VsSarosisUserSetup-1.2.3.exe",
 *       "sha256hash": "abc123...",
 *       "timestamp": 1735776000000
 *     },
 *     "win32-x64": { ... }
 *   }
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3030;
const GH_REPO = process.env.GH_REPO || '';            // 形如 "owner/repo"
const GH_TOKEN = process.env.GH_TOKEN || '';          // 私有仓库需要
const MANIFEST_PATH = process.env.MANIFEST_PATH || path.join(__dirname, 'manifest.json');

/** 把 GitHub Release 资产映射到各 platform 的安装包文件名约定 */
const ASSET_NAME_BY_PLATFORM = {
	'win32-x64-user': 'VsSarosisUserSetup',
	'win32-arm64-user': 'VsSarosisUserSetup',
	'win32-x64': 'VsSarosisSetup',
	'win32-arm64': 'VsSarosisSetup'
};

/**
 * 从本地 manifest.json 读取某 platform 的最新版本信息
 * @param {string} platform
 */
function readFromManifest(platform) {
	if (!fs.existsSync(MANIFEST_PATH)) {
		return null;
	}
	try {
		const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
		return manifest[platform] || null;
	} catch (e) {
		console.error('[update] 读取 manifest 失败:', e);
		return null;
	}
}

/**
 * 从 GitHub Releases 读取最新版本信息
 * @param {string} platform
 */
async function readFromGitHub(platform) {
	const wantName = ASSET_NAME_BY_PLATFORM[platform];
	if (!wantName) {
		return null;
	}
	const headers = {
		'Accept': 'application/vnd.github+json',
		'User-Agent': 'vssaros-update-server'
	};
	if (GH_TOKEN) {
		headers['Authorization'] = `Bearer ${GH_TOKEN}`;
	}
	const res = await fetch(`https://api.github.com/repos/${GH_REPO}/releases/latest`, { headers });
	if (!res.ok) {
		console.error('[update] GitHub API 错误:', res.status, await res.text());
		return null;
	}
	const release = await res.json();
	// release.body 约定写入一行 "commit: <full-commit-sha>"；productVersion 取 tag_name
	const commitMatch = /commit:\s*([0-9a-f]{40})/i.exec(release.body || '');
	const asset = (release.assets || []).find(a => a.name.includes(wantName) && a.name.endsWith('.exe'));
	if (!asset || !commitMatch) {
		return null;
	}
	return {
		version: commitMatch[1],
		productVersion: String(release.tag_name || '').replace(/^v/, ''),
		url: asset.browser_download_url,
		sha256hash: undefined,   // GitHub 不直接提供 sha256，建议在 release.body 里额外写并解析
		timestamp: Date.parse(release.published_at) || Date.now()
	};
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url || '/', `http://localhost:${PORT}`);

	// 健康检查
	if (url.pathname === '/' || url.pathname === '/health') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ ok: true, service: 'vssaros-update-server', mode: GH_REPO ? 'github' : 'manifest' }));
		return;
	}

	// /api/update/{platform}/{quality}/{commit}
	const m = /^\/api\/update\/([^/]+)\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
	if (!m) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'not found' }));
		return;
	}

	const [, platform, quality, currentCommit] = m;
	console.log(`[update] check platform=${platform} quality=${quality} commit=${currentCommit.substring(0, 10)}`);

	let latest = null;
	try {
		latest = GH_REPO ? await readFromGitHub(platform) : readFromManifest(platform);
	} catch (e) {
		console.error('[update] 查询最新版本失败:', e);
	}

	// 无清单 / 查询失败 / 已是最新 → 204（客户端理解为无更新）
	if (!latest || !latest.version || !latest.url || latest.version === currentCommit) {
		res.writeHead(204);
		res.end();
		return;
	}

	const payload = {
		version: latest.version,
		productVersion: latest.productVersion,
		url: latest.url,
		timestamp: latest.timestamp || Date.now()
	};
	if (latest.sha256hash) {
		payload.sha256hash = latest.sha256hash;
	}

	res.writeHead(200, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(payload));
});

server.listen(PORT, () => {
	console.log(`VsSarosis update server 已启动: http://localhost:${PORT}`);
	console.log(`模式: ${GH_REPO ? `GitHub Releases (${GH_REPO})` : `本地清单 (${MANIFEST_PATH})`}`);
	console.log(`测试: curl http://localhost:${PORT}/api/update/win32-x64-user/saros/0000000000000000000000000000000000000000`);
});
