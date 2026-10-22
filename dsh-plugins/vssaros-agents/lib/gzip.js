// @vssaros/dsh-agents — 响应体 gzip（2026-10-19）。
//
// 为什么值得做：agents 三个页面把 CSS/JS 全内联（editor 20 个 agent 时 144KB），但其中 80%+ 是
// 高度重复的文本 —— 实测 gzip 后 27KB（**18%**）。页面结构一行不改，只改传输编码。
//
// 口径（宁可保守）：
//   · 只有客户端明确 `accept-encoding: gzip` 才压（Chromium 一定带）；
//   · 小于 `GZIP_MIN_BYTES` 不压（省下的字节还不如多一层编码的 CPU / 头开销）；
//   · 一定带 `vary: accept-encoding`（中间层缓存不会把压缩体发给不支持的客户端）；
//   · **不碰二进制**（zip 导出自己管 content-length/字节，压缩反而破坏语义）。
import { gzipSync } from 'node:zlib';

/** 小于这个字节数不压。 */
export const GZIP_MIN_BYTES = 4096;

export function acceptsGzip(req) {
	const header = String(req?.headers?.['accept-encoding'] ?? '');
	return /(^|,)\s*gzip\s*(;|,|$)/i.test(header);
}

/**
 * 按需压缩。
 * @param req 用来读 `accept-encoding`
 * @param body string | Buffer
 * @returns `{ body: Buffer, headers }`——headers 里含 content-length（+ 可选 content-encoding / vary）
 */
export function encodeBody(req, body) {
	const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
	if (buf.length < GZIP_MIN_BYTES || !acceptsGzip(req)) {
		return { body: buf, headers: { 'content-length': String(buf.length), vary: 'accept-encoding' } };
	}
	const zipped = gzipSync(buf, { level: 6 });
	return {
		body: zipped,
		headers: {
			'content-encoding': 'gzip',
			'content-length': String(zipped.length),
			vary: 'accept-encoding',
		},
	};
}
