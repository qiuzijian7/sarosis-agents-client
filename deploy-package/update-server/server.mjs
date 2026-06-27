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
 *       "url": "https://your-host/releases/VsSarosUserSetup-1.2.3.exe",
 *       "sha256hash": "abc123...",
 *       "timestamp": 1735776000000
 *     },
 *     "win32-x64": { ... }
 *   }
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Transform } from 'stream';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3030;
const GH_REPO = process.env.GH_REPO || '';            // 形如 "owner/repo"
const GH_TOKEN = process.env.GH_TOKEN || '';          // 私有仓库需要
const MANIFEST_PATH = process.env.MANIFEST_PATH || path.join(__dirname, 'manifest.json');
// 静态下载目录：默认 manifest.json 同级的 ../downloads，可用 DOWNLOADS_DIR 覆盖
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.resolve(__dirname, '..', 'downloads');
// 单文件下载大小上限（默认 512MB），防止误传大文件耗尽内存
const MAX_DOWNLOAD_SIZE = Number(process.env.MAX_DOWNLOAD_SIZE) || 512 * 1024 * 1024;
// 上传端点鉴权 token（流水线 POST /admin/upload 需在 X-Upload-Token 头携带）
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN || '';
// 对外公开基础 URL（用于拼接下载 url；留空则用请求 Host 头推导）
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';
// 上传文件大小上限（默认 512MB）
const MAX_UPLOAD_SIZE = Number(process.env.MAX_UPLOAD_SIZE) || 512 * 1024 * 1024;

// ---- manifest 内存缓存（按 mtime 失效，避免每请求读磁盘）----
/** @type {{ mtimeMs: number, manifest: Record<string, any> | null }} */
let _manifestCache = { mtimeMs: -1, manifest: null };

/** 把 GitHub Release 资产映射到各 platform 的安装包文件名约定 */
const ASSET_NAME_BY_PLATFORM = {
	'win32-x64-user': 'VsSarosUserSetup',
	'win32-arm64-user': 'VsSarosUserSetup',
	'win32-x64': 'VsSarosisSetup',
	'win32-arm64': 'VsSarosisSetup'
};

/**
 * 从本地 manifest.json 读取某 platform 的最新版本信息（带内存缓存，按 mtime 失效）
 * @param {string} platform
 */
function readFromManifest(platform) {
	if (!fs.existsSync(MANIFEST_PATH)) {
		_manifestCache = { mtimeMs: -1, manifest: null };
		return null;
	}
	try {
		const stat = fs.statSync(MANIFEST_PATH);
		if (_manifestCache.manifest && stat.mtimeMs === _manifestCache.mtimeMs) {
			return _manifestCache.manifest[platform] || null;
		}
		const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
		_manifestCache = { mtimeMs: stat.mtimeMs, manifest };
		return manifest[platform] || null;
	} catch (e) {
		console.error('[update] 读取 manifest 失败:', e);
		_manifestCache = { mtimeMs: -1, manifest: null };
		return null;
	}
}

/**
 * 处理 /downloads/* 静态文件下载（支持 Range 断点续传）
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {string} urlPath
 */
function serveDownload(req, res, urlPath) {
	// 安全：规范化路径，禁止 .. 穿越
	const rel = decodeURIComponent(urlPath.replace(/^\/downloads\//, ''));
	const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
	if (path.isAbsolute(safe) || safe.includes('..')) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'invalid path' }));
		return;
	}
	const filePath = path.join(DOWNLOADS_DIR, safe);
	fs.stat(filePath, (err, stat) => {
		if (err || !stat.isFile()) {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'file not found' }));
			return;
		}
		if (stat.size > MAX_DOWNLOAD_SIZE) {
			res.writeHead(413, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'file too large' }));
			return;
		}
		// 断点续传
		const range = req.headers.range;
		let start = 0, end = stat.size - 1;
		if (range) {
			const m = /bytes=(\d*)-(\d*)/.exec(range);
			if (m) {
				start = m[1] ? parseInt(m[1], 10) : 0;
				end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
				if (start > end || start >= stat.size) {
					res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
					res.end();
					return;
				}
				res.writeHead(206, {
					'Content-Range': `bytes ${start}-${end}/${stat.size}`,
					'Accept-Ranges': 'bytes',
					'Content-Length': end - start + 1,
					'Content-Type': 'application/octet-stream'
				});
			} else {
				res.writeHead(200, {
					'Content-Length': stat.size,
					'Content-Type': 'application/octet-stream',
					'Accept-Ranges': 'bytes'
				});
			}
		} else {
			res.writeHead(200, {
				'Content-Length': stat.size,
				'Content-Type': 'application/octet-stream',
				'Accept-Ranges': 'bytes'
			});
		}
		fs.createReadStream(filePath, { start, end }).pipe(res);
	});
}

/**
 * 更新 manifest.json 中某 platform 的版本条目，并刷新内存缓存。
 * @param {string} platform
 * @param {Record<string, any>} entry
 */
function updateManifestEntry(platform, entry) {
	/** @type {Record<string, any>} */
	let manifest = {};
	if (fs.existsSync(MANIFEST_PATH)) {
		try {
			manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
		} catch (e) {
			console.error('[upload] 读取 manifest 失败，将覆盖:', e);
		}
	}
	manifest[platform] = entry;
	fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
	// 刷新缓存，下次读 manifest 会重新加载
	_manifestCache = { mtimeMs: -1, manifest: null };
}

/**
 * 处理 POST /admin/upload —— 流水线打包后上传 exe，自动存盘 + 算 sha256 + 更新 manifest。
 *
 * 请求：
 *   POST /admin/upload?platform=win32-x64-user&commit=<40位sha>&productVersion=1.120.0
 *   Header: X-Upload-Token: <UPLOAD_TOKEN>
 *   Body: application/octet-stream（exe 二进制）
 *
 * 响应：
 *   200 + { ok, platform, version, url, sha256hash, size }
 *   400/401/413/500 + { error }
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {URL} url
 */
function handleUpload(req, res, url) {
	// 鉴权
	if (UPLOAD_TOKEN && req.headers['x-upload-token'] !== UPLOAD_TOKEN) {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'unauthorized: invalid or missing X-Upload-Token' }));
		return;
	}

	const platform = url.searchParams.get('platform');
	const commit = url.searchParams.get('commit');
	const productVersion = url.searchParams.get('productVersion') || '';
	if (!platform || !commit) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'missing required query: platform, commit' }));
		return;
	}

	const baseName = ASSET_NAME_BY_PLATFORM[platform];
	if (!baseName) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: `unknown platform: ${platform}` }));
		return;
	}

	const fileName = `${baseName}.exe`;
	fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
	const filePath = path.join(DOWNLOADS_DIR, fileName);

	console.log(`[upload] 开始接收 platform=${platform} commit=${commit.substring(0, 10)} → ${fileName}`);

	// 流式写文件 + 同步算 sha256（单一数据路径，避免 on('data') 与 pipe 冲突）
	const hash = crypto.createHash('sha256');
	const writeStream = fs.createWriteStream(filePath);
	let received = 0;
	let aborted = false;

	const hashTransform = new Transform({
		transform(chunk, encoding, callback) {
			hash.update(chunk);
			received += chunk.length;
			if (received > MAX_UPLOAD_SIZE) {
				aborted = true;
				req.destroy();
				writeStream.destroy();
				try { fs.unlinkSync(filePath); } catch { /* ignore */ }
				if (!res.headersSent) {
					res.writeHead(413, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: 'file too large' }));
				}
				return;
			}
			callback(null, chunk);
		}
	});

	req.pipe(hashTransform).pipe(writeStream);

	writeStream.on('finish', () => {
		if (aborted) { return; }
		const sha256hash = hash.digest('hex');
		const baseUrl = PUBLIC_BASE_URL || `http://${req.headers.host}`;
		const downloadUrl = `${baseUrl}/downloads/${fileName}`;
		const entry = {
			version: commit,
			productVersion,
			url: downloadUrl,
			sha256hash,
			timestamp: Date.now()
		};
		try {
			updateManifestEntry(platform, entry);
		} catch (e) {
			console.error('[upload] 更新 manifest 失败:', e);
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'failed to update manifest', detail: String(e) }));
			return;
		}

		console.log(`[upload] 完成 ${fileName} sha256=${sha256hash.substring(0, 12)}... size=${received}`);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ ok: true, platform, version: commit, productVersion, url: downloadUrl, sha256hash, size: received }));
	});

	writeStream.on('error', (e) => {
		if (aborted) { return; }
		console.error('[upload] 写文件失败:', e);
		try { fs.unlinkSync(filePath); } catch { /* ignore */ }
		if (!res.headersSent) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'write failed', detail: String(e) }));
		}
	});

	req.on('error', (e) => {
		if (aborted) { return; }
		console.error('[upload] 接收失败:', e);
		try { fs.unlinkSync(filePath); } catch { /* ignore */ }
		if (!res.headersSent) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'receive failed', detail: String(e) }));
		}
	});
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

	// 静态下载 /downloads/**
	if (url.pathname.startsWith('/downloads/')) {
		serveDownload(req, res, url.pathname);
		return;
	}

	// 上传端点 /admin/upload（供蓝盾流水线打包后推送 exe）
	if (url.pathname === '/admin/upload' && req.method === 'POST') {
		handleUpload(req, res, url);
		return;
	}

	// 直接更新 manifest 端点（不需要上传 exe，仅更新版本信息）
	// POST /admin/manifest?platform=win32-x64-user&commit=<sha>&productVersion=1.2.3
	if (url.pathname === '/admin/manifest' && req.method === 'POST') {
		if (UPLOAD_TOKEN && req.headers['x-upload-token'] !== UPLOAD_TOKEN) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'unauthorized: invalid or missing X-Upload-Token' }));
			return;
		}
		const platform = url.searchParams.get('platform');
		const commit = url.searchParams.get('commit');
		const productVersion = url.searchParams.get('productVersion') || '';
		if (!platform || !commit) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'missing required query: platform, commit' }));
			return;
		}
		// 读取现有 manifest 条目，仅更新 version 和 productVersion，保留 url 和 sha256hash
		let existing = null;
		try { existing = readFromManifest(platform); } catch { /* ignore */ }
		const entry = {
			version: commit,
			productVersion,
			url: existing?.url || `http://${req.headers.host}/downloads/${ASSET_NAME_BY_PLATFORM[platform] || 'unknown'}.exe`,
			sha256hash: existing?.sha256hash || '',
			timestamp: Date.now()
		};
		updateManifestEntry(platform, entry);
		console.log(`[manifest] updated platform=${platform} commit=${commit.substring(0, 10)} productVersion=${productVersion}`);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ ok: true, platform, ...entry }));
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
	console.log(`下载目录: ${DOWNLOADS_DIR}`);
	console.log(`上传端点: POST /admin/upload（鉴权: ${UPLOAD_TOKEN ? '已启用 X-Upload-Token' : '未启用（UPLOAD_TOKEN 未设置）'}）`);
	console.log(`测试: curl http://localhost:${PORT}/api/update/win32-x64-user/saros/0000000000000000000000000000000000000000`);
});

server.on('error', (err) => {
	if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EADDRINUSE') {
		console.error(`端口 ${PORT} 已被占用，请更换 PORT 或停止占用进程`);
	} else {
		console.error('服务器错误:', err);
	}
	process.exit(1);
});

// graceful shutdown
function shutdown(sig) {
	console.log(`收到 ${sig}，正在关闭服务器...`);
	server.close(() => {
		console.log('服务器已关闭');
		process.exit(0);
	});
	// 3 秒后强制退出
	setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
