// Saros Pocket — Pocket App 静态资源服务（/pocket/）
//
// App 本体在仓库的 app/ 目录（无构建步骤的原生 HTML/CSS/JS），由本模块在代理里
// 直接吐出去。这样手机上不需要加载整个 VsSaros 工作台，只要一个轻量 App 就能
// 与 VsSaros 通信（聊天 / 看文件 / 看状态）。
//
// 与 dsh-pocket 的差异：dsh 的 client 由插件框架注入到 dsh web 页面里；VsSaros 没有
// 对等的注入点，所以这里改成「代理自己托管一个 App」——零侵入 VsSaros 源码。

import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

/** App 挂载前缀。 */
export const APP_PREFIX = '/pocket/';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/** 允许对外暴露的文件白名单（避免把整个扩展目录挂出去）。 */
const ALLOWED_FILES = new Set([
  'index.html',
  'app.js',
  'app.css',
  // 品牌资源（与 VsSaros 同款 logo）：favicon 用 SVG wordmark，
  // iOS「添加到主屏幕」不认 SVG，所以另备方形 mark PNG。
  'saros-logo.svg',
  'apple-touch-icon.png',
]);

/**
 * 创建 App 静态服务。
 * @param {object} opts
 * @param {string} opts.appDir app 目录绝对路径
 * @param {object} [opts.boot] 注入到页面的启动参数（window.__POCKET__）
 * @param {object} [opts.log] 日志
 */
export function createAppServer({ appDir, boot = {}, log = console } = {}) {
  const logLine = (msg) => {
    if (log?.appendLine) log.appendLine(msg);
    else (log?.info ?? log?.log ?? (() => { })).call(log, msg);
  };

  async function sendFile(res, file, cache) {
    let buf;
    try {
      buf = await readFile(join(appDir, file));
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('not found');
      return;
    }
    const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers = {
      'content-type': type,
      'content-length': String(buf.length),
      'cache-control': cache ? 'public, max-age=60' : 'no-store',
    };
    if (file === 'index.html') {
      // 启动参数内联进 HTML：App 不需要知道自己的部署路径，
      // 隧道域名 / 局域网 IP / 端口变化都不影响它。
      const bootScript = `<script>window.__POCKET__=${JSON.stringify(boot)};</script>`;
      buf = Buffer.from(buf.toString('utf8').replace('</head>', `${bootScript}</head>`), 'utf8');
      headers['content-length'] = String(buf.length);
    }
    res.writeHead(200, headers);
    res.end(buf);
  }

  return {
    prefix: APP_PREFIX,
    /**
     * @returns {Promise<boolean>} true = 已处理
     */
    async handle(req, res) {
      let pathname = String(req.url ?? '/');
      try {
        const u = new URL(pathname, 'http://x.invalid');
        pathname = u.pathname;
      } catch { /* 用原值 */ }
      if (!pathname.startsWith(APP_PREFIX)) return false;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('method not allowed');
        return true;
      }
      // 目录穿越防护：normalize 后仍以 / 开头或含 .. 一律拒
      // normalize('') 在 Windows 上会变成 '.'，所以空 / '.' / 'index.html' 都算首页
      const rel = normalize(pathname.slice(APP_PREFIX.length)).replace(/^([/\\]|\.\.[/\\])+/, '');
      const file = rel === '' || rel === '.' || rel === 'index.html' ? 'index.html' : rel;
      if (!ALLOWED_FILES.has(file)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('not found');
        return true;
      }
      logLine(`Saros Pocket: app ${file}`);
      await sendFile(res, file, file !== 'index.html');
      return true;
    },
  };
}
