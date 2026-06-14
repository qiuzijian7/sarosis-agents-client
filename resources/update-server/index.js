/**
 * VsSarosis 更新代理服务
 *
 * 接收 VS Code 客户端的更新请求，查询工蜂最新 Release，
 * 返回 VS Code 更新 JSON 格式。
 *
 * 部署：DevCloud 实例 zijianqiu-any1.devcloud.woa.com:3030
 *
 * 客户端请求：
 *   GET /api/update/win32-x64/saros/{commit-hash}
 *
 * 响应格式：
 *   { version, productVersion, url, sha256hash, timestamp }
 */

const http = require('http');
const https = require('https');

// ===== 配置 =====
const PORT = 3030;
const GONGFENG_TOKEN = process.env.GONGFENG_TOKEN || ''; // 需设置环境变量
const PROJECT_ID = '1790708'; // vssaros_issue 项目 ID
const GONGFENG_API = 'https://git.woa.com/api/v3';
const QUALITY = 'saros';

// ===== 工具函数 =====

/** 简单日志 */
function log(msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${msg}`);
}

/** HTTP GET 请求 */
function fetch(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https') ? https : http;
        lib.get(url, { headers }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode, body: data });
                }
            });
        }).on('error', reject);
    });
}

/**
 * 从 Release 描述中提取 sha256hash
 * 匹配格式: SHA256: xxxxx/大小: xx MB
 */
function extractSha256FromDescription(description) {
    if (!description) return undefined;
    // 匹配 64 位 hex
    const match = description.match(/SHA256[：:]\s*([a-f0-9]{64})/i);
    return match ? match[1] : undefined;
}

/**
 * 查询工蜂最新 Release
 */
async function fetchLatestRelease() {
    log('查询工蜂最新 Release...');

    const headers = {};
    if (GONGFENG_TOKEN) {
        headers['PRIVATE-TOKEN'] = GONGFENG_TOKEN;
    }

    const result = await fetch(
        `${GONGFENG_API}/projects/${PROJECT_ID}/releases?per_page=1`,
        headers
    );

    if (result.status !== 200) {
        throw new Error(`工蜂 API 返回 ${result.status}: ${JSON.stringify(result.body)}`);
    }

    const releases = result.body;
    if (!Array.isArray(releases) || releases.length === 0) {
        throw new Error('未找到任何 Release');
    }

    const latest = releases[0];
    log(`最新 Release: tag=${latest.tag}, title=${latest.title}`);

    return latest;
}

/**
 * 生成 VS Code 更新 JSON
 */
function buildUpdateResponse(release, requestCommit) {
    const desc = release.description || '';
    const sha256hash = extractSha256FromDescription(desc);

    // 从 Release name 提取版本号，如 "VsSarosis v0.1.1" → "0.1.1"
    const productVersion = (release.title || release.tag || '').replace(/^VsSarosis\s*v?/i, '') || release.tag || '0.1.0';

    const response = {
        version: release.tag || requestCommit,
        productVersion: productVersion,
        timestamp: new Date(release.created_at).getTime(),
    };

    // 如果当前 commit 不等于 release tag，说明有更新
    if (requestCommit !== release.tag) {
        // 尝试从 description 中提取下载 URL（markdown 链接格式）
        let url;
        const urlMatch = desc.match(/\[VsSarosisUserSetup\.exe\]\(([^)]+)\)/);
        if (urlMatch) {
            url = urlMatch[1];
        }

        if (url) response.url = url;
        if (sha256hash) response.sha256hash = sha256hash;
    }

    return response;
}

// ===== HTTP 服务器 =====

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // 健康检查
    if (url.pathname === '/health' || url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'vssaros-update', quality: QUALITY }));
        return;
    }

    // API 路由: /api/update/{platform}/{quality}/{commit}
    const match = url.pathname.match(/^\/api\/update\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (!match) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
    }

    const [, platform, quality, commit] = match;
    log(`更新请求: platform=${platform}, quality=${quality}, commit=${commit}`);

    // 验证 quality（可选，防止非 saros 客户端误用）
    if (quality !== QUALITY) {
        log(`quality 不匹配: ${quality} !== ${QUALITY}，返回空（无更新）`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(null));
        return;
    }

    try {
        const latest = await fetchLatestRelease();

        // 如果客户端已是最新，返回无更新
        if (commit === latest.tag) {
            log(`客户端已是最新 (${commit})，无更新`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                version: commit,
                productVersion: latest.tag,
                timestamp: new Date().getTime()
            }));
            return;
        }

        // 有更新
        const update = buildUpdateResponse(latest, commit);
        update.url = update.url || `https://git.woa.com/zijianqiu/vssaros_issue/-/releases/${latest.tag}`;
        log(`返回更新: version=${update.version}, productVersion=${update.productVersion}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(update));

    } catch (err) {
        log(`错误: ${err.message}`);
        // 返回 null 表示无更新，不阻塞客户端
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(null));
    }
});

server.listen(PORT, '0.0.0.0', () => {
    log(`VsSarosis 更新服务启动成功`);
    log(`监听: http://0.0.0.0:${PORT}`);
    log(`质量: ${QUALITY}`);
    log(`工蜂项目: ${PROJECT_ID}`);
    if (GONGFENG_TOKEN) {
        log('工蜂 Token: 已配置 ✓');
    } else {
        log('⚠ 工蜂 Token 未设置！需要设置环境变量 GONGFENG_TOKEN');
        log('  如需认证访问，请在启动前 export GONGFENG_TOKEN=your-token');
    }
});
