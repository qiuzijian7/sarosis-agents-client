/**
 * VsSaros Update Feed — Cloudflare Worker 版（Serverless 部署）
 * ============================================================
 * 与 server.mjs 同协议，但跑在 Cloudflare Worker 上，免运维、全球边缘节点。
 * 数据源：GitHub Releases（最新 release 的 assets）。
 *
 * 部署：
 *   1. npm i -g wrangler
 *   2. 在本目录创建 wrangler.toml（见下方注释）
 *   3. wrangler deploy
 *   4. 把部署后得到的 URL（如 https://vssaros-update.xxx.workers.dev）
 *      写入 product.json 的 updateUrl
 *
 * wrangler.toml 示例：
 *   name = "vssaros-update"
 *   main = "worker.js"
 *   compatibility_date = "2024-01-01"
 *   [vars]
 *   GH_REPO = "qiuzijian7/saros-agents-client"
 *   # 私有仓库再加：wrangler secret put GH_TOKEN
 */

const ASSET_NAME_BY_PLATFORM = {
	'win32-x64-user': 'VsSarosUserSetup',
	'win32-arm64-user': 'VsSarosUserSetup',
	'win32-x64': 'VsSarosSetup',
	'win32-arm64': 'VsSarosSetup'
};

export default {
	/**
	 * @param {Request} request
	 * @param {{ GH_REPO: string, GH_TOKEN?: string }} env
	 */
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === '/' || url.pathname === '/health') {
			return Response.json({ ok: true, service: 'vssaros-update-worker', repo: env.GH_REPO });
		}

		const m = /^\/api\/update\/([^/]+)\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
		if (!m) {
			return new Response('not found', { status: 404 });
		}

		const [, platform, , currentCommit] = m;
		const wantName = ASSET_NAME_BY_PLATFORM[platform];
		if (!wantName || !env.GH_REPO) {
			return new Response(null, { status: 204 });
		}

		const headers = {
			'Accept': 'application/vnd.github+json',
			'User-Agent': 'vssaros-update-worker'
		};
		if (env.GH_TOKEN) {
			headers['Authorization'] = `Bearer ${env.GH_TOKEN}`;
		}

		const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}/releases/latest`, { headers });
		if (!res.ok) {
			return new Response(null, { status: 204 });
		}

		const release = await res.json();
		const commitMatch = /commit:\s*([0-9a-f]{40})/i.exec(release.body || '');
		const asset = (release.assets || []).find(a => a.name.includes(wantName) && a.name.endsWith('.exe'));

		if (!asset || !commitMatch) {
			return new Response(null, { status: 204 });
		}

		const version = commitMatch[1];
		if (version === currentCommit) {
			return new Response(null, { status: 204 }); // 已是最新
		}

		// 可选 sha256：在 release.body 写 "sha256-<platform>: <hash>" 即可被解析
		const shaMatch = new RegExp(`sha256-${platform}:\\s*([0-9a-f]{64})`, 'i').exec(release.body || '');

		const payload = {
			version,
			productVersion: String(release.tag_name || '').replace(/^v/, ''),
			url: asset.browser_download_url,
			timestamp: Date.parse(release.published_at) || Date.now()
		};
		if (shaMatch) {
			payload.sha256hash = shaMatch[1];
		}

		return Response.json(payload);
	}
};
