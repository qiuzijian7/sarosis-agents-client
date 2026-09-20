// Saros Pocket — Pocket App 的通信通道（HTTP RPC + SSE 事件流）
//
// 通道形态（与 dsh-pocket 的 /dsh-pocket 逻辑通道对齐，但直接挂在 Pocket 代理上，
// 因为 VsSaros 没有 cordis 那种插件级 RPC 框架）：
//   POST /saros-pocket/rpc/<endpoint>   ← 请求-响应（JSON 信封）
//   GET  /saros-pocket/events           ← SSE 事件流（服务端推送）
//   GET  /saros-pocket/screen.mjpeg     ← 桌面画面流（远程看 VsSaros.exe 的 UI）
//   GET  /saros-pocket/screen.jpg       ← 单帧快照（截图 / 轮询兜底）
//
// 安全：本模块**不做认证**——它只挂在代理的 routes 上，而代理在调用 routes 之前
// 已经完成了访问密码（PIN）校验与局域网开关判定（见 lib/proxy.mjs）。
// 换句话说：能打开 /pocket/ App 的人，才能调这里的 endpoint，不另开一条口子。

import { MJPEG_BOUNDARY } from './screen.mjs';

/** RPC 前缀（代理路由用）。 */
export const RPC_PREFIX = '/saros-pocket/';

/** RPC 方法路径：/saros-pocket/rpc/<endpoint> */
const RPC_ROUTE = `${RPC_PREFIX}rpc/`;

/** SSE 事件流路径。 */
const EVENTS_PATH = `${RPC_PREFIX}events`;

/** 请求体上限：1 MB（聊天消息 + 文件写入都远小于此，防止无界缓冲）。 */
const MAX_BODY_BYTES = 1024 * 1024;

/** endpoint 段字符白名单（与 dsh-pocket 的 ENDPOINT_SEGMENT_PATTERN 同形）。 */
const ENDPOINT_SEGMENT_RE = /^[A-Za-z0-9_$.-]+$/;

/** SSE 心跳间隔：25 秒（低于常见 30s 反代空闲超时）。 */
const SSE_HEARTBEAT_MS = 25_000;

/** 画面流路径：MJPEG（<img> 直接渲染）与单帧快照（轮询/截图）。 */
const MJPEG_PATH = `${RPC_PREFIX}screen.mjpeg`;
const SNAPSHOT_PATH = `${RPC_PREFIX}screen.jpg`;

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(buf.length),
    'cache-control': 'no-store',
  });
  res.end(buf);
}

function ok(value) {
  return { ok: true, value: value ?? null };
}

function fail(message, code = 'bad-request') {
  return { ok: false, error: { code, message: String(message ?? 'unknown error') } };
}

/** node:http 请求体读取（带大小上限；超限直接 413 并断开）。 */
async function readBody(req, limit = MAX_BODY_BYTES) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    return { tooLarge: true };
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > limit) return { tooLarge: true };
    chunks.push(chunk);
  }
  if (chunks.length === 0) return { text: '' };
  return { text: Buffer.concat(chunks).toString('utf8') };
}

/** 从 /saros-pocket/rpc/<endpoint> 里取出 endpoint；段非法返回 undefined。 */
export function endpointFromPath(pathname) {
  if (!pathname.startsWith(RPC_ROUTE)) return undefined;
  const endpoint = pathname.slice(RPC_ROUTE.length).replace(/\/+$/, '');
  if (!endpoint) return undefined;
  const segments = endpoint.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..' || !ENDPOINT_SEGMENT_RE.test(seg))) {
    return undefined;
  }
  return endpoint;
}

/**
 * 创建 RPC 通道。
 * @param {object} opts
 * @param {Record<string, (payload:any, ctx:object) => Promise<any>>} opts.endpoints endpoint 处理表
 * @param {ReturnType<import('./events.mjs').createEventBus>} [opts.events] 事件总线（提供 SSE）
 * @param {ReturnType<import('./screen.mjs').createScreenSource>} [opts.screen] 屏幕采集源（提供画面流）
 * @param {object} [opts.log] 日志（appendLine 或 console 形状）
 */
export function createPocketRpc({ endpoints = {}, events = null, screen = null, log = console } = {}) {
  const logLine = (msg) => {
    if (log?.appendLine) log.appendLine(msg);
    else (log?.info ?? log?.log ?? (() => { })).call(log, msg);
  };

  function handleEvents(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event, data) => {
      if (res.writableEnded) return;
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(data ?? null)}\n\n`);
    };
    res.write('retry: 3000\n\n');
    if (events) {
      // 先补发最近事件，避免刷新页面丢掉刚发生的流式增量
      for (const ev of events.recent()) send(ev, ev.data);
    }
    send({ id: 0, type: 'hello' }, { at: Date.now(), hasEvents: Boolean(events) });

    let unsubscribe = () => { };
    if (events) {
      unsubscribe = events.subscribe((ev) => send(ev, ev.data));
    }
    const heartbeat = setInterval(() => {
      if (res.writableEnded) return;
      res.write(`: ping ${Date.now()}\n\n`);
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  /**
   * MJPEG 画面流：multipart/x-mixed-replace，浏览器 <img> 直接吃。
   * 背压处理：res.write 返回 false 时丢帧（绝不堆积旧帧，否则延迟会越拉越大）。
   */
  function handleMjpeg(req, res) {
    res.writeHead(200, {
      'content-type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let paused = false;
    res.on('drain', () => { paused = false; });
    const unsubscribe = screen.subscribe((frame) => {
      if (paused || res.writableEnded) return;
      const head = Buffer.from(`--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`, 'utf8');
      paused = !res.write(Buffer.concat([head, frame, Buffer.from('\r\n', 'utf8')]));
    });
    const cleanup = () => { try { unsubscribe(); } catch { /* 忽略 */ } };
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  /** 单帧快照：截图按钮 / 不支持 MJPEG 的浏览器走轮询。 */
  async function handleSnapshot(req, res) {
    try {
      const frame = await screen.snapshot();
      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'content-length': String(frame.length),
        'cache-control': 'no-store',
      });
      res.end(frame);
    } catch (err) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(String(err?.message ?? err));
    }
  }

  async function handleRpc(req, res, endpoint) {
    const body = await readBody(req);
    if (body.tooLarge) {
      json(res, 413, fail('请求体过大 | request body too large', 'payload-too-large'));
      return;
    }
    const handler = endpoints[endpoint];
    if (typeof handler !== 'function') {
      json(res, 404, fail(`未知 endpoint：${endpoint} | unknown endpoint`, 'unknown-endpoint'));
      return;
    }
    let payload = {};
    if (body.text) {
      try {
        const parsed = JSON.parse(body.text);
        payload = parsed && typeof parsed === 'object' ? (parsed.payload ?? {}) : {};
      } catch {
        json(res, 400, fail('请求体不是合法 JSON | body is not JSON', 'invalid-json'));
        return;
      }
    }
    try {
      const value = await handler(payload, { endpoint, req });
      json(res, 200, ok(value));
    } catch (err) {
      logLine(`Saros Pocket: rpc ${endpoint} failed | ${err?.message ?? err}`);
      json(res, 200, fail(err?.message ?? String(err)));
    }
  }

  return {
    prefix: RPC_PREFIX,
    /**
     * 尝试处理一个请求。
     * @returns {Promise<boolean>} true = 已处理（调用方不要再转发给上游）
     */
    async handle(req, res) {
      let pathname = String(req.url ?? '/');
      try { pathname = new URL(pathname, 'http://x.invalid').pathname; } catch { /* 用原值 */ }
      if (!pathname.startsWith(RPC_PREFIX)) return false;

      if (pathname === EVENTS_PATH) {
        if (req.method !== 'GET') {
          json(res, 404, fail('not found'));
          return true;
        }
        handleEvents(req, res);
        return true;
      }

      if (pathname === MJPEG_PATH || pathname === SNAPSHOT_PATH) {
        if (req.method !== 'GET') {
          json(res, 404, fail('not found'));
          return true;
        }
        if (!screen) {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end('screen capture unavailable | 屏幕采集不可用');
          return true;
        }
        if (pathname === MJPEG_PATH) handleMjpeg(req, res);
        else await handleSnapshot(req, res);
        return true;
      }

      const endpoint = endpointFromPath(pathname);
      if (endpoint === undefined || req.method !== 'POST') {
        json(res, 404, fail('not found'));
        return true;
      }
      await handleRpc(req, res, endpoint);
      return true;
    },
  };
}

export { ok, fail };
